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
 * EnumDevices pass with no device opens — cheap enough to run forever.
 *
 * ## Cost
 * Polling only runs while something is actually bound to a wheel button
 * ({@link GamepadReader.setActive}); with no wheel bindings this module opens no
 * devices and starts no timer.
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
 * Reads controller buttons and reports edges.
 *
 * Events are delivered through the `onButton` callback as
 * `(deviceId, buttonNumber, isDown)`, where `buttonNumber` is 1-based to match
 * how LMU and every wheel vendor number them.
 */
class GamepadReader {
  constructor(options = {}) {
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

    this._vcall(this.di, 4, this.P.EnumDevices, DI8DEVCLASS_GAMECTRL, this.enumFn, null,
      DIEDFL_ATTACHEDONLY);

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
    if (++this.pollsSincePresence >= PRESENCE_POLLS) {
      this.pollsSincePresence = 0;
      try {
        const attached = this._attachedGuids().sort().join(',');
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

module.exports = { GamepadReader, describeButton };
