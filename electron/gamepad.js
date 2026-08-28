/**
 * electron/gamepad.js — reads wheel/controller buttons in the background.
 * -----------------------------------------------------------------------------
 * Lets a wheel button trigger any action in the registry while the SIM has
 * focus — the one trigger route that never steals focus from the game, which
 * matters because keystroke injection only reaches the foreground window.
 *
 * ## Why DirectInput 8, not the easy options
 *   - **winmm `joyGetPosEx`** caps at **32 buttons**. A MOZA R9 reports 128 and
 *     a typical LMU bind set sits at ids 36-104, so the legacy API is blind to
 *     exactly the buttons that matter. Measured, not assumed.
 *   - **The browser Gamepad API** only delivers input to a *focused* document,
 *     so it reports nothing while the driver is in the game.
 *   - **Raw Input** would need a window procedure, i.e. a compiled native addon.
 *
 * DirectInput 8 is reachable from the `koffi` this project already ships: its
 * COM interfaces are called by reading the vtable pointer and dispatching
 * through `koffi.call`. `SetCooperativeLevel(BACKGROUND | NONEXCLUSIVE)` is what
 * makes it work while the game is frontmost, and it does not disturb the game's
 * own use of the same device.
 *
 * ## The hand-built data format
 * `c_dfDIJoystick2` lives in dinput8.lib, not the DLL, so it cannot be looked up
 * at runtime. We therefore build a `DIDATAFORMAT` covering 8 axes, 4 POV hats
 * and 128 buttons — verified accepted by DirectInput on a real device.
 *
 * ## Why POV hats are read, not just buttons
 * This used to describe buttons alone, which is why the bindings UI worked on a
 * MOZA rim but not a **Simagic** one. MOZA reports its directional switch as
 * four ordinary buttons; Simagic reports the GT Neo's two 7-way "funky"
 * switches as **POV hats**, and a button-only data format cannot see a hat at
 * all — the presses simply never arrived. Hat directions are surfaced to the
 * rest of the app as synthetic button numbers ({@link POV_BUTTON_BASE}), so a
 * binding stays a plain `{ device, button }` pair whatever the vendor did.
 *
 * Axes are described too, but deliberately raise no binding events: the same
 * list holds the steering, throttle and brake, which move constantly and would
 * hijack every capture. They are read only to report what a device exposes.
 * A Simagic knob left in "absolute value mode" is an axis for this reason —
 * switch it back to incremental in SimPro Manager to bind it.
 *
 * ## The device list repairs itself
 * Enumeration happens on open, which is not once and for all: a rig that boots
 * the app before the wheel's driver, or power-cycles the base mid-session, ends
 * up polling a list that describes nothing. That is invisible from the outside —
 * every wheel binding just stops working, with no error — so the poll loop
 * re-enumerates on its own when the list is empty or a device has gone
 * persistently unreadable ({@link RESCAN_MIN_POLLS}). The Scan button on the
 * bindings page is the same call made by hand, not the only way back.
 *
 * The miss counter alone is not enough, though. Several vendors' software
 * stacks (the ones that publish a *virtual* game controller and feed it from
 * their own service) tear the device down and recreate it on a USB power event
 * or a base hiccup — and the stale handle we still hold keeps answering
 * GetDeviceState with **S_OK and a frozen state**. No read ever fails, so no
 * miss accumulates, and every binding is silently dead mid-race. The only
 * signal that survives is that the *instance GUID set* DirectInput enumerates
 * no longer matches the devices we hold, so the poll loop re-checks that set
 * every {@link PRESENCE_POLLS} and rescans on any difference. That check is an
 * EnumDevices pass with no device opens — usually a few milliseconds.
 *
 * ## Why all of this runs on a worker thread
 * "Usually" is the operative word. `EnumDevices` asks every HID device on the
 * machine for its product and serial strings — every HID device, not just game
 * controllers, attached-only or not — and a USB device whose firmware has
 * stopped answering those requests costs a 5 s control-transfer timeout per
 * string. Measured on a wedged USB microphone on 2026-08-28: **10.1 s per
 * enumeration**, every ~10 s, on the Electron main thread — which hosts the
 * overlay server, so the overlays froze 10 s on / 10 s off until the mic was
 * replugged. Nothing about that device was a controller, and nothing in the
 * app had changed since it last worked.
 *
 * So DirectInput now lives on a `worker_threads` Worker ({@link GamepadReader}
 * is the main-thread proxy, {@link DirectInputReader} the thing itself, hosted
 * by gamepadWorker.js). Button edges cross back as messages — sub-millisecond,
 * against an 8 ms poll. If the worker cannot start at all the reader falls
 * back to running in-thread, exactly as before, rather than losing wheel
 * bindings altogether.
 *
 * A slow enumeration is also *diagnosed*: past {@link SLOW_ENUM_MS} the worker
 * opens each HID interface itself and times the two string requests, so the
 * bindings page can name the device that is not answering (by USB VID:PID,
 * resolved to its Windows description) and tell the driver to replug it —
 * instead of "the overlays freeze sometimes". While a device is slow the
 * presence check backs off to {@link SLOW_PRESENCE_MULT}× its usual interval.
 *
 * ## Cost
 * Polling only runs while something is actually bound to a wheel button
 * ({@link GamepadReader.setActive}); with no wheel bindings this module opens no
 * devices, starts no timer and spawns no worker.
 *
 * Degrades to a no-op on non-Windows, without koffi, or with no controllers.
 */

'use strict';

/* --- DirectInput constants --- */
const DI8DEVCLASS_GAMECTRL = 4;
const DIEDFL_ATTACHEDONLY = 1;
const DISCL_NONEXCLUSIVE = 0x00000002;
const DISCL_BACKGROUND = 0x00000008;
/* 0x01 is DIDFT_RELAXIS; declaring one of those inside a DIDF_ABSAXIS format is
 * a contradiction DirectInput rejects with E_INVALIDARG, taking the whole
 * device with it. */
const DIDFT_ABSAXIS = 0x00000002;
const DIDFT_POV = 0x00000010;
const DIDFT_PSHBUTTON = 0x00000004;
const DIDFT_TGLBUTTON = 0x00000008;
const DIDFT_ANYINSTANCE = 0x00ffff00;
/**
 * Marks a data-format object the device is allowed not to have.
 *
 * Without it `SetDataFormat` rejects the **whole format** with E_INVALIDARG the
 * moment it describes one more object of a type than the device really has —
 * measured on a MOZA R5: 128 buttons is accepted, 129 is not. That is the real
 * reason button mapping "only worked on MOZA": the R5 reports exactly 128
 * buttons, so the old fixed 128-button format happened to fit it and nothing
 * else. Any wheel reporting fewer failed here and was dropped silently.
 */
const DIDFT_OPTIONAL = 0x80000000;
const DIDF_ABSAXIS = 0x00000001;

/** Buttons we describe in the data format. 128 is DirectInput's ceiling. */
const NUM_BUTTONS = 128;
/** Axes described. Read for reporting only — see the header note on capture. */
const NUM_AXES = 8;
/** POV hats described. DirectInput's own ceiling, and no rim comes close. */
const NUM_POVS = 4;

/* State buffer layout. Axes first so the whole thing stays 4-byte aligned,
 * which `dwDataSize` requires. */
const AXES_OFS = 0;
const POVS_OFS = AXES_OFS + NUM_AXES * 4;
const BUTTONS_OFS = POVS_OFS + NUM_POVS * 4;
const STATE_SIZE = BUTTONS_OFS + NUM_BUTTONS;

/**
 * Hat directions are reported as button numbers starting here, past anything a
 * physical button can occupy (DirectInput stops at 128). Hat `h` direction `d`
 * is `POV_BUTTON_BASE + h * 8 + d + 1`, i.e. 201-232.
 */
const POV_BUTTON_BASE = 200;
const POV_DIRS = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left'];

/** Size of DIOBJECTDATAFORMAT / DIDATAFORMAT / DIDEVICEINSTANCEW / DIDEVCAPS. */
const OBJ_SIZE = 24;
const FORMAT_SIZE = 32;
const DEVINST_SIZE = 1100;
const DEVCAPS_SIZE = 44;
/** Poll period. ~125 Hz: fast enough that an encoder detent is never missed. */
const POLL_MS = 8;

/**
 * Automatic re-enumeration while the device list is wrong, in polls.
 *
 * Enumeration happens once per open, so a reader that came up with no devices —
 * the app launched before the wheel's driver, or the base was power-cycled since
 * — polled an empty list forever and every wheel binding silently did nothing.
 * The only way back was the Scan button on the bindings page, which is not
 * something a driver can be expected to know. These retry from ~2 s, backing off
 * to ~30 s so a rig that genuinely has no wheel attached is not re-enumerating
 * every few seconds for the rest of the session.
 */
const RESCAN_MIN_POLLS = 250;
const RESCAN_MAX_POLLS = 3750;
/**
 * How often the attached-GUID set is compared against the devices held, in
 * polls (~5 s). This is the watchdog for the failure the miss counter cannot
 * see: a driver that recreated its device while the old handle still reads
 * "successfully". See the header note on the self-repairing device list.
 */
const PRESENCE_POLLS = 625;
/**
 * Consecutive failed reads before a device counts as lost, ~1 s. Well past the
 * brief unacquired spell a focus change or a screen lock causes, so those still
 * recover through the cheap re-Acquire in {@link GamepadReader._poll} alone.
 */
const LOST_POLLS = 125;
/**
 * An enumeration slower than this is a device not answering, not a busy
 * machine: a healthy pass over a dozen HID interfaces measures well under
 * 300 ms even on a loaded rig. Past it the worker runs the per-device probe
 * and the presence check backs off.
 */
const SLOW_ENUM_MS = 1000;
/** Presence-check interval multiplier while an enumeration is slow (~2 min). */
const SLOW_PRESENCE_MULT = 12;
/** One HID string request slower than this names its device as the culprit. */
const SLOW_HID_MS = 1000;
/** How long the main thread waits for a worker rescan before answering anyway. */
const RESCAN_TIMEOUT_MS = 30000;

/**
 * Human-readable name for a button number, including the synthetic hat ones.
 * Used for binding labels so a chip reads "hat 1 up" and not "btn 201".
 */
function describeButton(button) {
  const n = Number(button);
  if (n > POV_BUTTON_BASE && n <= POV_BUTTON_BASE + NUM_POVS * 8) {
    const i = n - POV_BUTTON_BASE - 1;
    return `hat ${Math.floor(i / 8) + 1} ${POV_DIRS[i % 8]}`;
  }
  return `btn ${n}`;
}

/**
 * Reads controller buttons and reports edges — the DirectInput half, which
 * blocks its thread for as long as DirectInput likes. Hosted on a worker by
 * {@link GamepadReader}; usable directly only where blocking is acceptable
 * (the worker itself, scripts, the in-thread fallback).
 *
 * Events are delivered through the `onButton` callback as
 * `(deviceId, buttonNumber, isDown)`, where `buttonNumber` is 1-based to match
 * how LMU and every wheel vendor number them.
 */
class DirectInputReader {
  constructor(options = {}) {
    /**
     * Whether a slow enumeration triggers the per-device HID probe. The probe
     * can itself take 5 s per wedged device, so the in-thread fallback turns
     * it off — there it would be the very stall this module exists to avoid.
     */
    this.diagnoseSlow = options.diagnoseSlow !== false;
    /** Last enumeration's duration, and the culprits when it was slow. */
    this.lastEnumMs = 0;
    this.slow = null; // { ms, devices: [{ vid, pid, path, productMs, serialMs }] }
    this.presenceEvery = PRESENCE_POLLS;
    this.onButton = options.onButton || (() => {});
    /**
     * Called (with no arguments) whenever an enumeration ends with a different
     * device list than the last one — a wheel appeared, vanished, or was
     * recreated by its driver. Lets the UI track unplug/replug live instead of
     * only learning about it when the Scan button is pressed.
     */
    this.onDevicesChanged = options.onDevicesChanged || null;
    this.verbose = options.verbose || false;
    this.koffi = null;
    this.di = null;
    this.devices = []; // { id, product, caps, dev, state, prev }
    /** Devices DirectInput listed but we could not open, with the reason. */
    this.problems = [];
    this.timer = null;
    this.enumFn = null;
    // Held on the instance so the GC cannot collect a buffer DirectInput still
    // has a pointer to — rgodf in particular is referenced by the live format.
    this.buffers = [];
    this.iidBuffer = null;
    this.failed = null;
    /** Polls since the last enumeration, and the gap before the next retry. */
    this.pollsSinceScan = 0;
    this.rescanAfter = RESCAN_MIN_POLLS;
    /** Polls since the attached-GUID set was last verified. */
    this.pollsSincePresence = 0;
    /** Fingerprint of the last enumeration result, for onDevicesChanged. */
    this.lastListKey = '';
  }

  /** Whether the reader could be used at all on this host. */
  get available() {
    return this.failed === null;
  }

  /**
   * Attached controllers, for the bindings UI. `caps` is what the device really
   * exposes — the fastest way to tell a tester whose rim "does nothing" whether
   * their controls are buttons, hats or axes.
   */
  list() {
    return this.devices.map((d) => ({ id: d.id, product: d.product, caps: d.caps }));
  }

  /** Open DirectInput and enumerate, without starting the poll timer. */
  open() {
    if (this.di) return true;
    return this._open();
  }

  /**
   * Everything the main thread needs, as plain data that survives a
   * postMessage: the list, the open failures, and the slow-device diagnosis.
   */
  snapshot() {
    return {
      available: this.available,
      failed: this.failed,
      devices: this.list(),
      problems: this.problems.slice(),
      slow: this.slow ? { ms: this.slow.ms, devices: this.slow.devices.slice() } : null,
      lastEnumMs: this.lastEnumMs,
    };
  }

  /**
   * Start or stop polling. Called with `false` whenever no action is bound to a
   * wheel button, so an operator who only uses the keyboard pays nothing.
   */
  setActive(active) {
    if (active) {
      if (!this.di && !this._open()) return false;
      if (!this.timer) {
        this.timer = setInterval(() => this._poll(), POLL_MS);
        this.timer.unref?.();
      }
      return true;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return true;
  }

  /**
   * Re-enumerate attached controllers, releasing the ones held now.
   *
   * Enumeration used to happen once, on first open, so a wheel plugged in after
   * the app had started could never be bound however many times the bindings
   * page was opened — the device list simply kept answering with what was
   * attached at boot.
   *
   * Called by the Scan button and, since the list going wrong is invisible from
   * the outside, automatically from {@link GamepadReader._poll}.
   */
  rescan() {
    this.rescanAfter = RESCAN_MIN_POLLS;
    if (!this.di) return this._open();
    const wasPolling = this.timer !== null;
    if (wasPolling) this.setActive(false);
    for (const d of this.devices) {
      try {
        this._vcall(d.dev, 2, this.P.Release);
      } catch {
        /* already gone */
      }
    }
    this.devices = [];
    // The old rgodf/state buffers belonged to the devices just released, so
    // dropping them here is what stops a rescan leaking one set per call.
    this.buffers = this.iidBuffer ? [this.iidBuffer] : [];
    try {
      this.koffi.unregister(this.enumFn);
    } catch {
      /* ignore */
    }
    this.enumFn = null;
    this._enumerate();
    if (wasPolling) this.setActive(true);
    return true;
  }

  /** Releases every COM object; safe to call twice. */
  close() {
    this.setActive(false);
    const koffi = this.koffi;
    if (!koffi) return;
    for (const d of this.devices) {
      try {
        this._vcall(d.dev, 2, this.P.Release);
      } catch {
        /* already gone */
      }
    }
    this.devices = [];
    if (this.di) {
      try {
        this._vcall(this.di, 2, this.P.Release);
      } catch {
        /* ignore */
      }
      this.di = null;
    }
    if (this.enumFn) {
      try {
        koffi.unregister(this.enumFn);
      } catch {
        /* ignore */
      }
      this.enumFn = null;
    }
    this.buffers = [];
    this.iidBuffer = null;
  }

  /* ------------------------------ internals ----------------------------- */

  /** Dispatch COM vtable slot `n` on an interface pointer. */
  _vcall(iface, n, proto, ...args) {
    const vtbl = this.koffi.decode(iface, 'void*');
    const slot = this.koffi.decode(vtbl, n * 8, 'void*');
    return this.koffi.call(slot, proto, iface, ...args);
  }

  _open() {
    if (process.platform !== 'win32') {
      this.failed = 'not Windows';
      return false;
    }
    // Cleared so a retry that succeeds does not leave a stale reason behind,
    // which `available` would keep reporting as a permanent failure.
    this.failed = null;
    try {
      // eslint-disable-next-line global-require
      const koffi = require('koffi'); // optional dep, as elsewhere in the app
      this.koffi = koffi;

      this.P = {
        Release: koffi.proto('uint32 __stdcall P_Release(void*)'),
        GetCapabilities: koffi.proto('int32 __stdcall P_GetCapabilities(void*, void*)'),
        CreateDevice: koffi.proto('int32 __stdcall P_CreateDevice(void*, void*, _Out_ void**, void*)'),
        EnumDevices: koffi.proto('int32 __stdcall P_EnumDevices(void*, uint32, void*, void*, uint32)'),
        SetDataFormat: koffi.proto('int32 __stdcall P_SetDataFormat(void*, void*)'),
        SetCoopLevel: koffi.proto('int32 __stdcall P_SetCoopLevel(void*, void*, uint32)'),
        Acquire: koffi.proto('int32 __stdcall P_Acquire(void*)'),
        GetDeviceState: koffi.proto('int32 __stdcall P_GetDeviceState(void*, uint32, void*)'),
        EnumCallback: koffi.proto('int32 __stdcall P_EnumCallback(void*, void*)'),
      };

      const k32 = koffi.load('kernel32.dll');
      const GetModuleHandleW = k32.func('void* __stdcall GetModuleHandleW(str16)');
      const LoadLibraryW = k32.func('void* __stdcall LoadLibraryW(str16)');
      const GetProcAddress = k32.func('void* __stdcall GetProcAddress(void*, str)');

      const hDI = LoadLibraryW('dinput8.dll');
      if (!hDI) {
        this.failed = 'dinput8.dll not present';
        return false;
      }
      const pCreate = GetProcAddress(hDI, 'DirectInput8Create');
      const DI8Create = koffi.proto('int32 __stdcall DI8C(void*, uint32, void*, _Out_ void**, void*)');

      // IID_IDirectInput8W {BF798031-483A-4DA2-AA99-5D64ED369700}
      const iid = Buffer.alloc(16);
      iid.writeUInt32LE(0xbf798031, 0);
      iid.writeUInt16LE(0x483a, 4);
      iid.writeUInt16LE(0x4da2, 6);
      Buffer.from([0xaa, 0x99, 0x5d, 0x64, 0xed, 0x36, 0x97, 0x00]).copy(iid, 8);
      // Kept by name as well as in `buffers`: a rescan clears `buffers` and
      // this one must survive it.
      this.iidBuffer = iid;
      this.buffers.push(iid);

      const out = [null];
      const hr = koffi.call(pCreate, DI8Create, GetModuleHandleW(null), 0x0800, iid, out, null);
      if (hr !== 0 || !out[0]) {
        this.failed = `DirectInput8Create failed 0x${(hr >>> 0).toString(16)}`;
        return false;
      }
      this.di = out[0];

      this._enumerate();
      if (this.devices.length === 0) {
        // Not an error: no wheel plugged in yet. `available` stays true, and
        // the poll loop keeps re-enumerating until one turns up.
        if (this.verbose) console.log('[gamepad] no controllers attached');
      }
      return true;
    } catch (err) {
      this.failed = err && err.message ? err.message : String(err);
      if (this.verbose) console.error('[gamepad] unavailable:', this.failed);
      return false;
    }
  }

  _enumerate() {
    const koffi = this.koffi;
    const found = [];
    this.problems = [];
    this.pollsSinceScan = 0;
    this.pollsSincePresence = 0;
    this.enumFn = koffi.register((lpddi) => {
      try {
        const buf = Buffer.from(koffi.decode(lpddi, 0, koffi.array('uint8', DEVINST_SIZE)));
        found.push({
          guid: Buffer.from(buf.subarray(4, 20)),
          product: buf.toString('ucs2', 560, 1080).replace(/\0.*$/, ''),
        });
      } catch {
        /* skip a device we cannot read */
      }
      return 1; // DIENUM_CONTINUE
    }, koffi.pointer(this.P.EnumCallback));

    const enumStarted = Date.now();
    this._vcall(this.di, 4, this.P.EnumDevices, DI8DEVCLASS_GAMECTRL, this.enumFn, null,
      DIEDFL_ATTACHEDONLY);
    this._noteEnum(Date.now() - enumStarted);

    // A base and a rim plugged in on its own USB port can report the same
    // product string; bindings key on it, so make the duplicates distinct.
    const seen = new Map();
    for (const f of found) {
      const n = (seen.get(f.product) || 0) + 1;
      seen.set(f.product, n);
      f.id = n === 1 ? f.product : `${f.product} #${n}`;
    }

    for (const f of found) {
      const dev = this._openDevice(f);
      if (dev) this.devices.push(dev);
    }

    // Tell the UI when the outcome actually differs from last time, so the
    // bindings page tracks unplug/replug without anyone pressing Scan. Keyed
    // on GUIDs as well as ids: a driver that recreated the "same" wheel is a
    // change worth reporting even though the product string is identical.
    const key = this.devices.map((d) => `${d.guidHex}|${d.id}`).sort().join(',');
    if (key !== this.lastListKey) {
      this.lastListKey = key;
      if (this.onDevicesChanged) {
        try {
          this.onDevicesChanged();
        } catch (err) {
          console.error('[gamepad] devices-changed handler failed:', err.message);
        }
      }
    }
  }

  /**
   * The instance GUIDs DirectInput enumerates right now, opening nothing.
   * Cheap by design: this runs unattended every {@link PRESENCE_POLLS}.
   */
  _attachedGuids() {
    const koffi = this.koffi;
    const guids = [];
    const cb = koffi.register((lpddi) => {
      try {
        // Only dwSize + guidInstance are needed — the first 20 bytes.
        const buf = Buffer.from(koffi.decode(lpddi, 0, koffi.array('uint8', 20)));
        guids.push(buf.subarray(4, 20).toString('hex'));
      } catch {
        /* skip a device we cannot read */
      }
      return 1; // DIENUM_CONTINUE
    }, koffi.pointer(this.P.EnumCallback));
    try {
      this._vcall(this.di, 4, this.P.EnumDevices, DI8DEVCLASS_GAMECTRL, cb, null,
        DIEDFL_ATTACHEDONLY);
    } finally {
      try {
        koffi.unregister(cb);
      } catch {
        /* ignore */
      }
    }
    return guids;
  }

  /**
   * Builds the data format and opens one device.
   *
   * On failure this records *why* in {@link problems} rather than returning a
   * bare null: a device that vanishes from the list with no reason is the
   * hardest kind of report to act on when a tester's wheel "isn't detected".
   */
  _openDevice(found) {
    const koffi = this.koffi;
    const fail = (why) => {
      this.problems.push({ product: found.product, error: why });
      if (this.verbose) console.warn(`[gamepad] ${found.product}: ${why}`);
      return null;
    };

    const out = [null];
    const rc = this._vcall(this.di, 3, this.P.CreateDevice, found.guid, out, null);
    if (rc !== 0 || !out[0]) return fail(`CreateDevice failed 0x${(rc >>> 0).toString(16)}`);
    const dev = out[0];

    // Axes, then hats, then buttons — matching the state buffer layout. pguid
    // NULL + ANYINSTANCE lets DirectInput assign the device's own objects to
    // these slots in order, so nothing here is vendor-specific.
    const numObjs = NUM_AXES + NUM_POVS + NUM_BUTTONS;
    const rgodf = Buffer.alloc(OBJ_SIZE * numObjs);
    const put = (i, ofs, type) => {
      const o = i * OBJ_SIZE;
      rgodf.writeBigUInt64LE(0n, o); // pguid: NULL, i.e. match any object
      rgodf.writeUInt32LE(ofs, o + 8);
      // OPTIONAL on every object: this format is a superset of any wheel, and
      // without it the surplus slots would fail the device outright.
      rgodf.writeUInt32LE((type | DIDFT_ANYINSTANCE | DIDFT_OPTIONAL) >>> 0, o + 12);
      rgodf.writeUInt32LE(0, o + 16);
    };
    let idx = 0;
    for (let i = 0; i < NUM_AXES; i++) put(idx++, AXES_OFS + i * 4, DIDFT_ABSAXIS);
    for (let i = 0; i < NUM_POVS; i++) put(idx++, POVS_OFS + i * 4, DIDFT_POV);
    for (let i = 0; i < NUM_BUTTONS; i++) {
      put(idx++, BUTTONS_OFS + i, DIDFT_PSHBUTTON | DIDFT_TGLBUTTON);
    }

    const df = Buffer.alloc(FORMAT_SIZE);
    df.writeUInt32LE(FORMAT_SIZE, 0);
    df.writeUInt32LE(OBJ_SIZE, 4);
    df.writeUInt32LE(DIDF_ABSAXIS, 8);
    df.writeUInt32LE(STATE_SIZE, 12);
    df.writeUInt32LE(numObjs, 16);
    df.writeBigUInt64LE(BigInt(koffi.address(rgodf)), 24);
    // DirectInput keeps a pointer to rgodf for the device's lifetime.
    this.buffers.push(rgodf, df);

    const fmtRc = this._vcall(dev, 11, this.P.SetDataFormat, df);
    if (fmtRc !== 0) return fail(`SetDataFormat failed 0x${(fmtRc >>> 0).toString(16)}`);
    // BACKGROUND is the whole point: read while the sim owns the foreground.
    // NONEXCLUSIVE so the game keeps using the same device normally.
    const coopRc = this._vcall(dev, 13, this.P.SetCoopLevel, null,
      DISCL_BACKGROUND | DISCL_NONEXCLUSIVE);
    if (coopRc !== 0) return fail(`SetCooperativeLevel failed 0x${(coopRc >>> 0).toString(16)}`);
    this._vcall(dev, 7, this.P.Acquire);

    // What the device actually has. Hats and buttons past these counts are
    // slots DirectInput never fills, and an unfilled hat reads as 0 — which is
    // "up" — so the count is what stops a phantom press every single poll.
    const caps = { axes: 0, povs: 0, buttons: 0 };
    const capsBuf = Buffer.alloc(DEVCAPS_SIZE);
    capsBuf.writeUInt32LE(DEVCAPS_SIZE, 0);
    if (this._vcall(dev, 3, this.P.GetCapabilities, capsBuf) === 0) {
      caps.axes = Math.min(capsBuf.readUInt32LE(12), NUM_AXES);
      caps.buttons = Math.min(capsBuf.readUInt32LE(16), NUM_BUTTONS);
      caps.povs = Math.min(capsBuf.readUInt32LE(20), NUM_POVS);
    } else {
      // Never seen in practice, but a device that will not describe itself is
      // better read conservatively than not read at all.
      caps.buttons = NUM_BUTTONS;
    }
    this.buffers.push(capsBuf);

    const state = Buffer.alloc(STATE_SIZE);
    this.buffers.push(state);
    return {
      id: found.id || found.product,
      product: found.product,
      // The instance GUID this handle was opened from; the presence watchdog
      // compares these against what EnumDevices reports now.
      guidHex: found.guid.toString('hex'),
      caps,
      dev,
      state,
      // Hats start centred, which is the resting value POV_CENTERED matches.
      prev: Buffer.alloc(STATE_SIZE),
      pov: new Array(NUM_POVS).fill(-1),
      /** Consecutive unreadable polls — see LOST_POLLS. */
      misses: 0,
      /**
       * The first successful read only primes `prev`/`pov`, emitting nothing.
       * A freshly (re)opened device starts against an all-zero previous state,
       * so a button physically held through a rescan would otherwise read as a
       * brand-new press — and if that button is bound to the rescan action
       * itself, it would re-trigger on every poll until released.
       */
      fresh: true,
    };
  }

  /** Deliver one edge, never letting a bad handler stop the polling loop. */
  _emit(device, button, down) {
    try {
      this.onButton(device, button, down);
    } catch (err) {
      console.error('[gamepad] button handler failed:', err.message);
    }
  }

  _poll() {
    this.pollsSinceScan++;
    // An empty list is itself the fault worth retrying: it is what a reader that
    // opened before the wheel's driver was ready looks like, and it reports no
    // buttons at all rather than failing visibly.
    let stale = this.devices.length === 0;

    for (const d of this.devices) {
      const rc = this._vcall(d.dev, 9, this.P.GetDeviceState, STATE_SIZE, d.state);
      if (rc !== 0) {
        // Focus changes and device sleep drop the acquisition; re-take it and
        // pick up on the next tick rather than treating it as an error. A device
        // that stays unreadable is a different thing — a base that was
        // power-cycled leaves a handle no Acquire will ever recover — so past
        // LOST_POLLS stop trying to reacquire this pointer and re-enumerate.
        this._vcall(d.dev, 7, this.P.Acquire);
        if (++d.misses >= LOST_POLLS) stale = true;
        continue;
      }
      d.misses = 0;

      // Prime and move on — see `fresh` in _openDevice.
      if (d.fresh) {
        d.fresh = false;
        d.state.copy(d.prev);
        for (let h = 0; h < d.caps.povs; h++) {
          d.pov[h] = this._povDirection(d.state.readUInt32LE(POVS_OFS + h * 4));
        }
        continue;
      }

      for (let i = 0; i < d.caps.buttons; i++) {
        const o = BUTTONS_OFS + i;
        const down = (d.state[o] & 0x80) !== 0;
        const was = (d.prev[o] & 0x80) !== 0;
        if (down !== was) this._emit(d.id, i + 1, down);
      }

      // Hats. A hat is one object holding a direction, so an edge means the
      // previous direction released and the new one pressed — that is what
      // turns a Simagic funky switch into bindable presses.
      for (let h = 0; h < d.caps.povs; h++) {
        const dir = this._povDirection(d.state.readUInt32LE(POVS_OFS + h * 4));
        if (dir === d.pov[h]) continue;
        if (d.pov[h] >= 0) this._emit(d.id, POV_BUTTON_BASE + h * 8 + d.pov[h] + 1, false);
        if (dir >= 0) this._emit(d.id, POV_BUTTON_BASE + h * 8 + dir + 1, true);
        d.pov[h] = dir;
      }

      d.state.copy(d.prev);
    }

    // The watchdog for handles that lie: compare what DirectInput would
    // enumerate now against what we hold. A driver that recreated its device
    // keeps our stale handle reading "successfully", so this set drifting is
    // the only failure signal there is. Any difference — device gone, device
    // added, or the same wheel back under a new instance GUID — forces a
    // rescan immediately, skipping the empty-list backoff.
    if (++this.pollsSincePresence >= this.presenceEvery) {
      this.pollsSincePresence = 0;
      try {
        const started = Date.now();
        const guids = this._attachedGuids();
        this._noteEnum(Date.now() - started);
        const attached = guids.sort().join(',');
        const held = this.devices.map((d) => d.guidHex).sort().join(',');
        if (attached !== held) {
          stale = true;
          this.pollsSinceScan = this.rescanAfter; // rescan on this very poll
        }
      } catch {
        /* an enumeration hiccup is not worth killing the poll loop over */
      }
    }

    // After the loop, so the re-enumeration is never replacing `devices` while
    // it is being iterated.
    if (stale && this.pollsSinceScan >= this.rescanAfter) {
      const backedOff = Math.min(this.rescanAfter * 2, RESCAN_MAX_POLLS);
      this.rescan();
      // Only keep backing off while it is still coming up empty; a rig that has
      // its wheel back should retry promptly the next time one goes away.
      this.rescanAfter = this.devices.length > 0 ? RESCAN_MIN_POLLS : backedOff;
    }
  }

  /**
   * Record how long an enumeration took. Past {@link SLOW_ENUM_MS} a device
   * on this machine is not answering DirectInput: find out which (once per
   * slow pass, on this thread — the worker's, normally) and stretch the
   * presence check so the wedged device is asked ~every 2 min, not ~10 s.
   */
  _noteEnum(ms) {
    this.lastEnumMs = ms;
    if (ms < SLOW_ENUM_MS) {
      if (this.slow) {
        this.slow = null;
        this.presenceEvery = PRESENCE_POLLS;
        this._notifyChanged();
      }
      return;
    }
    const devices = this.diagnoseSlow ? this._probeSlowHid() : [];
    const before = JSON.stringify(this.slow && this.slow.devices);
    this.slow = { ms, devices };
    this.presenceEvery = PRESENCE_POLLS * SLOW_PRESENCE_MULT;
    if (this.verbose) console.warn(`[gamepad] EnumDevices took ${ms} ms`, devices);
    if (JSON.stringify(devices) !== before) this._notifyChanged();
  }

  _notifyChanged() {
    if (!this.onDevicesChanged) return;
    try {
      this.onDevicesChanged();
    } catch (err) {
      console.error('[gamepad] devices-changed handler failed:', err.message);
    }
  }

  /**
   * Which HID interface is not answering. Repeats what DirectInput does per
   * device — open the interface, ask for the product and serial strings — and
   * times each. On a wedged device both fail after the USB stack's 5 s
   * control-transfer timeout; everything healthy answers in milliseconds.
   * Returns `[{ vid, pid, path, productMs, serialMs }]`, or `[]` when nothing
   * here can be blamed (or the probe itself is unavailable).
   */
  _probeSlowHid() {
    const koffi = this.koffi;
    if (!koffi || process.platform !== 'win32') return [];
    try {
      const cfg = koffi.load('cfgmgr32.dll');
      const k32 = koffi.load('kernel32.dll');
      const hid = koffi.load('hid.dll');
      const ListSize = cfg.func('uint32 __stdcall CM_Get_Device_Interface_List_SizeW(_Out_ uint32*, void*, void*, uint32)');
      const List = cfg.func('uint32 __stdcall CM_Get_Device_Interface_ListW(void*, void*, _Out_ uint8*, uint32, uint32)');
      const CreateFileW = k32.func('void* __stdcall CreateFileW(str16, uint32, uint32, void*, uint32, uint32, void*)');
      const CloseHandle = k32.func('int __stdcall CloseHandle(void*)');
      const GetProduct = hid.func('int __stdcall HidD_GetProductString(void*, _Out_ uint8*, uint32)');
      const GetSerial = hid.func('int __stdcall HidD_GetSerialNumberString(void*, _Out_ uint8*, uint32)');

      // GUID_DEVINTERFACE_HID {4D1E55B2-F16F-11CF-88CB-001111000030}
      const guid = Buffer.alloc(16);
      guid.writeUInt32LE(0x4d1e55b2, 0);
      guid.writeUInt16LE(0xf16f, 4);
      guid.writeUInt16LE(0x11cf, 6);
      Buffer.from([0x88, 0xcb, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30]).copy(guid, 8);

      const CM_GET_DEVICE_INTERFACE_LIST_PRESENT = 0;
      const size = [0];
      if (ListSize(size, guid, null, CM_GET_DEVICE_INTERFACE_LIST_PRESENT) !== 0 || !size[0]) return [];
      const buf = Buffer.alloc(size[0] * 2);
      if (List(guid, null, buf, size[0], CM_GET_DEVICE_INTERFACE_LIST_PRESENT) !== 0) return [];
      const paths = buf.toString('utf16le').split('\0').filter(Boolean);

      const INVALID = 0xffffffffffffffffn;
      const out = [];
      for (const p of paths) {
        // Zero access: a query-only open, which is what DirectInput's
        // enumeration does and what a device holding the interface allows.
        const h = CreateFileW(p, 0, 3, null, 3, 0x40000000, null);
        if (!h || koffi.address(h) === INVALID) continue;
        const str = Buffer.alloc(256);
        let t = Date.now();
        GetProduct(h, str, 256);
        const productMs = Date.now() - t;
        t = Date.now();
        GetSerial(h, str, 256);
        const serialMs = Date.now() - t;
        CloseHandle(h);
        if (productMs < SLOW_HID_MS && serialMs < SLOW_HID_MS) continue;
        const m = /vid_([0-9a-f]{4}).*?pid_([0-9a-f]{4})/i.exec(p);
        out.push({
          vid: m ? m[1].toUpperCase() : null,
          pid: m ? m[2].toUpperCase() : null,
          path: p,
          productMs,
          serialMs,
        });
      }
      return out;
    } catch (err) {
      if (this.verbose) console.warn('[gamepad] slow-device probe failed:', err.message);
      return [];
    }
  }

  /**
   * POV value (hundredths of a degree clockwise from up) to one of 8 compass
   * directions, or -1 for centred. Centred is documented as 0xFFFF in the low
   * word, but drivers also use -1 and 0xFFFFFFFF, and anything past a full
   * circle is not a real bearing — so treat all of them as centred rather than
   * quantising a sentinel into a phantom "up".
   */
  _povDirection(raw) {
    if ((raw & 0xffff) === 0xffff || raw > 36000) return -1;
    return Math.round(raw / 4500) % 8;
  }
}

/* -------------------------------------------------------------------------- */
/*  The main-thread proxy                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The reader the app talks to. Same surface as before (`available`, `failed`,
 * `problems`, `list()`, `setActive()`, `rescan()`, `close()`, `onButton`,
 * `onDevicesChanged`) but DirectInput runs on a worker, so nothing here can
 * block the main thread however long a USB device takes to answer.
 *
 * `rescan()` returns a promise now — it always was a round trip to hardware,
 * it just used to make the caller wait in place.
 *
 * Falls back to an in-thread {@link DirectInputReader} if the worker cannot
 * start (with the slow-device probe off — see `diagnoseSlow`).
 */
class GamepadReader {
  constructor(options = {}) {
    this.onButton = options.onButton || (() => {});
    this.onDevicesChanged = options.onDevicesChanged || null;
    this.verbose = options.verbose || false;
    /** The last snapshot the reader reported; see DirectInputReader.snapshot. */
    this.snap = { available: true, failed: null, devices: [], problems: [], slow: null, lastEnumMs: 0 };
    this.worker = null;
    this.workerReady = false;
    this.inline = null;
    this.closing = false;
    this.active = false;
    this.pending = new Map(); // rescan id -> resolve
    this.seq = 0;
    /** USB VID:PID -> Windows description, resolved once per device. */
    this.usbNames = new Map();
    this.lastKey = '';
  }

  get available() {
    return this.snap.failed === null;
  }

  get failed() {
    return this.snap.failed;
  }

  /** Open failures plus, when enumeration is slow, the device to blame. */
  get problems() {
    return this.snap.problems.concat(this._slowProblems());
  }

  list() {
    return this.snap.devices.slice();
  }

  setActive(active) {
    this.active = !!active;
    if (!this._ensure()) return false;
    if (this.inline) return this.inline.setActive(this.active);
    this._post({ cmd: 'setActive', active: this.active });
    return true;
  }

  /** Re-enumerate; resolves with the device list once the hardware answered. */
  rescan() {
    if (!this._ensure()) return Promise.resolve(this.list());
    if (this.inline) {
      this.inline.rescan();
      this._absorb(this.inline.snapshot());
      return Promise.resolve(this.list());
    }
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve(this.list());
      }, RESCAN_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, () => {
        clearTimeout(timer);
        resolve(this.list());
      });
      this._post({ cmd: 'rescan', id });
    });
  }

  close() {
    this.closing = true;
    if (this.inline) {
      this.inline.close();
      this.inline = null;
    }
    if (this.worker) {
      try {
        this.worker.postMessage({ cmd: 'close' });
        this.worker.terminate();
      } catch {
        /* already gone */
      }
      this.worker = null;
    }
    for (const resolve of this.pending.values()) resolve();
    this.pending.clear();
  }

  /* ------------------------------ internals ----------------------------- */

  /** Start the worker (or the fallback) on first use. False only when neither can run. */
  _ensure() {
    if (this.worker || this.inline) return true;
    if (this.closing) return false;
    try {
      // eslint-disable-next-line global-require
      const { Worker } = require('node:worker_threads');
      const worker = new Worker(require('node:path').join(__dirname, 'gamepadWorker.js'));
      worker.unref();
      worker.on('message', (m) => this._onMessage(worker, m));
      worker.on('error', (err) => {
        if (this.verbose) console.warn('[gamepad] worker error:', err && err.message);
        this._workerGone(worker, err);
      });
      worker.on('exit', () => this._workerGone(worker, null));
      this.worker = worker;
      this._post({ cmd: 'open', verbose: this.verbose });
      return true;
    } catch (err) {
      if (this.verbose) console.warn('[gamepad] no worker, reading in-thread:', err && err.message);
      return this._fallback();
    }
  }

  _fallback() {
    if (this.inline) return true;
    this.inline = new DirectInputReader({
      verbose: this.verbose,
      diagnoseSlow: false,
      onButton: (device, button, down) => this._emit(device, button, down),
      onDevicesChanged: () => this._absorb(this.inline.snapshot()),
    });
    this.inline.open();
    this._absorb(this.inline.snapshot());
    if (this.active) this.inline.setActive(true);
    return true;
  }

  _workerGone(worker, err) {
    if (this.worker !== worker) return; // an older one
    this.worker = null;
    const wasReady = this.workerReady;
    this.workerReady = false;
    for (const resolve of this.pending.values()) resolve();
    this.pending.clear();
    if (this.closing) return;
    if (!wasReady) {
      // Never came up: run in-thread rather than lose wheel bindings.
      this._fallback();
      return;
    }
    // Died mid-session (a DirectInput fault inside the worker). Say so; the
    // next setActive/rescan starts a fresh one.
    this._absorb({ ...this.snap, failed: `controller reader stopped${err ? ` (${err.message})` : ''}` });
  }

  _post(msg) {
    if (!this.worker) return;
    try {
      this.worker.postMessage(msg);
    } catch {
      /* terminated */
    }
  }

  _onMessage(worker, m) {
    if (this.worker !== worker || !m) return;
    switch (m.ev) {
      case 'ready':
        if (m.snapshot && m.snapshot.failed !== null) {
          // The worker came up but DirectInput did not (koffi unreachable
          // from the worker in some packaging, say). In-thread is how this
          // always used to run; a genuine failure fails the same way there,
          // and its message is the one worth showing.
          this.worker = null;
          try {
            worker.terminate();
          } catch {
            /* ignore */
          }
          this._fallback();
          break;
        }
        this.workerReady = true;
        this._absorb(m.snapshot);
        if (this.active) this._post({ cmd: 'setActive', active: true });
        break;
      case 'state':
        this._absorb(m.snapshot);
        break;
      case 'rescanned': {
        this._absorb(m.snapshot);
        const resolve = this.pending.get(m.id);
        if (resolve) {
          this.pending.delete(m.id);
          resolve();
        }
        break;
      }
      case 'button':
        this._emit(m.device, m.button, m.down);
        break;
      default:
        break;
    }
  }

  _emit(device, button, down) {
    try {
      this.onButton(device, button, down);
    } catch (err) {
      console.error('[gamepad] button handler failed:', err.message);
    }
  }

  /** Take a snapshot from the reader; tell the app only when it differs. */
  _absorb(snap) {
    if (!snap) return;
    this.snap = snap;
    if (snap.slow) {
      for (const d of snap.slow.devices) {
        if (d.vid && d.pid) this._resolveUsbName(d.vid, d.pid);
      }
    }
    const key = JSON.stringify([
      snap.failed,
      snap.devices.map((d) => d.id),
      this.problems,
    ]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (this.onDevicesChanged) {
      try {
        this.onDevicesChanged();
      } catch (err) {
        console.error('[gamepad] devices-changed handler failed:', err.message);
      }
    }
  }

  _slowProblems() {
    const slow = this.snap.slow;
    if (!slow) return [];
    const secs = (slow.ms / 1000).toFixed(1);
    if (slow.devices.length === 0) {
      return [{
        kind: 'slow',
        product: 'A USB device',
        error:
          `is not answering Windows — every controller scan takes ${secs} s. ` +
          'Unplug and replug USB devices until it stops.',
      }];
    }
    return slow.devices.map((d) => {
      const id = d.vid && d.pid ? `${d.vid}:${d.pid}` : 'unknown';
      const name = this.usbNames.get(id) || `USB device ${id}`;
      return {
        kind: 'slow',
        product: name,
        error:
          `is not answering Windows — every controller scan waits ${secs} s on it. ` +
          'Unplug it and plug it back in.',
      };
    });
  }

  /**
   * "USB device 0D8C:0134" is a clue; "TONOR TC310 USB MIC" is an
   * instruction. One PowerShell PnP lookup per VID:PID, off the main thread,
   * result folded into the next `problems` read.
   */
  _resolveUsbName(vid, pid) {
    const id = `${vid}:${pid}`;
    if (this.usbNames.has(id) || process.platform !== 'win32') return;
    this.usbNames.set(id, null); // in flight
    const script =
      `$d = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\VID_${vid}&PID_${pid}\\*' } | Select-Object -First 1; ` +
      "if ($d) { (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName DEVPKEY_Device_BusReportedDeviceDesc).Data }";
    // eslint-disable-next-line global-require
    require('node:child_process').execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000, encoding: 'utf8' },
      (err, stdout) => {
        const name = !err && stdout ? stdout.trim() : '';
        if (!name) {
          this.usbNames.delete(id);
          return;
        }
        this.usbNames.set(id, name);
        this.lastKey = '';
        this._absorb(this.snap);
      },
    );
  }
}

module.exports = { GamepadReader, DirectInputReader, describeButton };
