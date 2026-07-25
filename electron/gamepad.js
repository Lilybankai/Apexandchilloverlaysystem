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
 * at runtime. We therefore build a `DIDATAFORMAT` describing 128 buttons mapped
 * to one byte each — verified accepted by DirectInput on a real device.
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
const DIDFT_PSHBUTTON = 0x00000004;
const DIDFT_TGLBUTTON = 0x00000008;
const DIDFT_ANYINSTANCE = 0x00ffff00;
const DIDF_ABSAXIS = 0x00000001;

/** Buttons we describe in the data format. 128 is DirectInput's ceiling. */
const NUM_BUTTONS = 128;
/** Size of DIOBJECTDATAFORMAT / DIDATAFORMAT / DIDEVICEINSTANCEW on x64. */
const OBJ_SIZE = 24;
const FORMAT_SIZE = 32;
const DEVINST_SIZE = 1100;
/** Poll period. ~125 Hz: fast enough that an encoder detent is never missed. */
const POLL_MS = 8;

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
    this.verbose = options.verbose || false;
    this.koffi = null;
    this.di = null;
    this.devices = []; // { id, product, dev, state, prev }
    this.timer = null;
    this.enumFn = null;
    // Held on the instance so the GC cannot collect a buffer DirectInput still
    // has a pointer to — rgodf in particular is referenced by the live format.
    this.buffers = [];
    this.failed = null;
  }

  /** Whether the reader could be used at all on this host. */
  get available() {
    return this.failed === null;
  }

  /** Attached controllers, for the bindings UI. */
  list() {
    return this.devices.map((d) => ({ id: d.id, product: d.product }));
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
    try {
      // eslint-disable-next-line global-require
      const koffi = require('koffi'); // optional dep, as elsewhere in the app
      this.koffi = koffi;

      this.P = {
        Release: koffi.proto('uint32 __stdcall P_Release(void*)'),
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
        // Not an error: no wheel plugged in yet. Leave `available` true so a
        // later setActive() re-enumerates.
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

    for (const f of found) {
      const dev = this._openDevice(f);
      if (dev) this.devices.push(dev);
    }
  }

  _openDevice(found) {
    const koffi = this.koffi;
    const out = [null];
    if (this._vcall(this.di, 3, this.P.CreateDevice, found.guid, out, null) !== 0 || !out[0]) {
      return null;
    }
    const dev = out[0];

    // 128 buttons, one byte of our state each. pguid NULL + ANYINSTANCE lets
    // DirectInput assign the device's buttons in order.
    const rgodf = Buffer.alloc(OBJ_SIZE * NUM_BUTTONS);
    for (let i = 0; i < NUM_BUTTONS; i++) {
      const o = i * OBJ_SIZE;
      rgodf.writeBigUInt64LE(0n, o);
      rgodf.writeUInt32LE(i, o + 8);
      rgodf.writeUInt32LE(DIDFT_PSHBUTTON | DIDFT_TGLBUTTON | DIDFT_ANYINSTANCE, o + 12);
      rgodf.writeUInt32LE(0, o + 16);
    }
    const df = Buffer.alloc(FORMAT_SIZE);
    df.writeUInt32LE(FORMAT_SIZE, 0);
    df.writeUInt32LE(OBJ_SIZE, 4);
    df.writeUInt32LE(DIDF_ABSAXIS, 8);
    df.writeUInt32LE(NUM_BUTTONS, 12);
    df.writeUInt32LE(NUM_BUTTONS, 16);
    df.writeBigUInt64LE(BigInt(koffi.address(rgodf)), 24);
    // DirectInput keeps a pointer to rgodf for the device's lifetime.
    this.buffers.push(rgodf, df);

    if (this._vcall(dev, 11, this.P.SetDataFormat, df) !== 0) return null;
    // BACKGROUND is the whole point: read while the sim owns the foreground.
    // NONEXCLUSIVE so the game keeps using the same device normally.
    if (this._vcall(dev, 13, this.P.SetCoopLevel, null, DISCL_BACKGROUND | DISCL_NONEXCLUSIVE) !== 0) {
      return null;
    }
    this._vcall(dev, 7, this.P.Acquire);

    const state = Buffer.alloc(NUM_BUTTONS);
    this.buffers.push(state);
    return {
      id: found.product,
      product: found.product,
      dev,
      state,
      prev: Buffer.alloc(NUM_BUTTONS),
    };
  }

  _poll() {
    for (const d of this.devices) {
      const rc = this._vcall(d.dev, 9, this.P.GetDeviceState, NUM_BUTTONS, d.state);
      if (rc !== 0) {
        // Focus changes and device sleep drop the acquisition; re-take it and
        // pick up on the next tick rather than treating it as an error.
        this._vcall(d.dev, 7, this.P.Acquire);
        continue;
      }
      for (let i = 0; i < NUM_BUTTONS; i++) {
        const down = (d.state[i] & 0x80) !== 0;
        const was = (d.prev[i] & 0x80) !== 0;
        if (down !== was) {
          try {
            this.onButton(d.id, i + 1, down);
          } catch (err) {
            // One bad handler must not stop the polling loop.
            console.error('[gamepad] button handler failed:', err.message);
          }
        }
      }
      d.state.copy(d.prev);
    }
  }
}

module.exports = { GamepadReader };
