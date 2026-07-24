/**
 * @file src/server/keySender.ts
 * @module server/keySender
 *
 * Injects real keyboard keystrokes into whatever window is focused, for the MFD
 * widget's **live driving-aid** controls — the aids LMU adjusts in real time
 * (brake bias, TC/ABS map, engine map, regen) and does NOT expose over its REST
 * API. Those live only on the in-car MFD, reachable only by a key press.
 *
 * ## Why SendInput + scancodes
 * A browser cannot key another app, so the server does it. Games read the
 * keyboard as raw scancodes via DirectInput/RawInput and ignore character-level
 * routes (WM_CHAR, PowerShell SendKeys), so we call Win32 `SendInput` with
 * `KEYEVENTF_SCANCODE`. And it needs no new dependency: the project already
 * bundles `koffi` (the shared-memory reader uses it), so `user32.dll` is bound
 * the same way `telemetry/lmuLocalCar.ts` binds `kernel32.dll`.
 *
 * ## The focus rule (important)
 * `SendInput` delivers to the FOREGROUND window. A key therefore reaches LMU
 * only when LMU is frontmost — true while driving, false the instant a browser
 * on the same PC is clicked. {@link KeySender.isSimForeground} exposes that fact
 * so callers can refuse to fire a key that would land in the wrong window; the
 * real live trigger is a wheel button / physical key (a future input path),
 * which never steals LMU's focus.
 *
 * Everything degrades to a safe no-op when koffi/Win32 is unavailable or the
 * platform is not Windows, exactly like the shared-memory reader.
 */

/** Virtual-key codes for the keys we can name. Resolved to scancodes at send. */
const VK: Readonly<Record<string, number>> = {
  // Extended function keys — the default aid binds. No physical keyboard has
  // these, so nothing binds them by default: the safest "won't clash" choice.
  F13: 0x7c, F14: 0x7d, F15: 0x7e, F16: 0x7f, F17: 0x80, F18: 0x81,
  F19: 0x82, F20: 0x83, F21: 0x84, F22: 0x85, F23: 0x86, F24: 0x87,
  // Standard function keys, offered for remaps.
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
  // Numpad, another low-clash pool.
  NUM0: 0x60, NUM1: 0x61, NUM2: 0x62, NUM3: 0x63, NUM4: 0x64,
  NUM5: 0x65, NUM6: 0x66, NUM7: 0x67, NUM8: 0x68, NUM9: 0x69,
  NUMADD: 0x6b, NUMSUB: 0x6d, NUMMUL: 0x6a, NUMDIV: 0x6f,
  // Letters and digits, for anyone who wants them.
  A: 0x41, B: 0x42, C: 0x43, D: 0x44, E: 0x45, F: 0x46, G: 0x47, H: 0x48,
  I: 0x49, J: 0x4a, K: 0x4b, L: 0x4c, M: 0x4d, N: 0x4e, O: 0x4f, P: 0x50,
  Q: 0x51, R: 0x52, S: 0x53, T: 0x54, U: 0x55, V: 0x56, W: 0x57, X: 0x58,
  Y: 0x59, Z: 0x5a,
};

/** Win32 constants. */
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const MAPVK_VK_TO_VSC = 0;
/** x64 INPUT is 40 bytes; KEYBDINPUT sits at +8. See probe-sendinput.js. */
const INPUT_SIZE = 40;

/** Minimal koffi-bound user32 surface. */
interface Win32 {
  SendInput: (n: number, buf: Buffer, size: number) => number;
  GetForegroundWindow: () => unknown;
  GetWindowTextW: (hwnd: unknown, buf: Buffer, max: number) => number;
  MapVirtualKeyW: (code: number, mapType: number) => number;
}

/** Result of a key press attempt. */
export interface KeyPressResult {
  ok: boolean;
  /** The foreground window title at the moment of the press (for diagnostics). */
  foreground: string;
  error?: string;
}

export interface KeySenderConfig {
  /**
   * Case-insensitive substring identifying the sim's window title. A key is only
   * injected when the foreground window matches, so a stray press can never land
   * in the browser or another app. Default matches Le Mans Ultimate.
   */
  simWindowMatch?: string;
  verbose?: boolean;
}

export class KeySender {
  private readonly win32: Win32 | null;
  private readonly match: string;
  private readonly verbose: boolean;

  public constructor(config: KeySenderConfig = {}) {
    this.match = (config.simWindowMatch ?? 'le mans ultimate').toLowerCase();
    this.verbose = config.verbose ?? false;
    this.win32 = loadWin32(this.verbose);
  }

  /** Whether keystroke injection is usable on this host at all. */
  public get available(): boolean {
    return this.win32 !== null;
  }

  /** A key name is sendable if it's in the table. */
  public static knows(keyName: string): boolean {
    return Object.prototype.hasOwnProperty.call(VK, keyName.toUpperCase());
  }

  /** The current foreground window title (empty when unavailable). */
  public foregroundTitle(): string {
    if (!this.win32) return '';
    const hwnd = this.win32.GetForegroundWindow();
    if (!hwnd) return '';
    const buf = Buffer.alloc(512 * 2);
    const n = this.win32.GetWindowTextW(hwnd, buf, 512);
    return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
  }

  /** True when the sim (by {@link KeySenderConfig.simWindowMatch}) is frontmost. */
  public isSimForeground(): boolean {
    return this.foregroundTitle().toLowerCase().includes(this.match);
  }

  /**
   * Presses (down + up) a named key. When `requireSim` is set (the default),
   * the press is refused unless the sim is the foreground window — so a click
   * that stole focus can never fire a key into the wrong app. Pass
   * `requireSim: false` only for a deliberate bind-time injection where the
   * caller has arranged for LMU's control dialog to be focused.
   */
  public press(keyName: string, opts: { requireSim?: boolean } = {}): KeyPressResult {
    const foreground = this.foregroundTitle();
    if (!this.win32) {
      return { ok: false, foreground, error: 'keystroke injection unavailable on this host' };
    }
    const vk = VK[keyName.toUpperCase()];
    if (vk === undefined) {
      return { ok: false, foreground, error: `unknown key: ${keyName}` };
    }
    const requireSim = opts.requireSim ?? true;
    if (requireSim && !foreground.toLowerCase().includes(this.match)) {
      return {
        ok: false,
        foreground,
        error: `sim not focused (foreground: "${foreground || 'unknown'}") — key not sent`,
      };
    }

    // Prefer the scancode (what games read); fall back to the virtual key if the
    // layout has no scancode for it (some F13–F24 map to 0).
    const scan = this.win32.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
    this.sendOne(vk, scan, false);
    this.sendOne(vk, scan, true);
    if (this.verbose) console.log(`[keys] sent ${keyName} (vk 0x${vk.toString(16)}, scan 0x${scan.toString(16)})`);
    return { ok: true, foreground };
  }

  private sendOne(vk: number, scan: number, keyUp: boolean): void {
    if (!this.win32) return;
    const buf = Buffer.alloc(INPUT_SIZE);
    const useScan = scan > 0;
    let flags = useScan ? KEYEVENTF_SCANCODE : 0;
    if (keyUp) flags |= KEYEVENTF_KEYUP;
    buf.writeUInt32LE(INPUT_KEYBOARD, 0); // type
    buf.writeUInt16LE(useScan ? 0 : vk & 0xffff, 8); // wVk (0 when using scancode)
    buf.writeUInt16LE(useScan ? scan & 0xffff : 0, 10); // wScan
    buf.writeUInt32LE(flags >>> 0, 12); // dwFlags
    buf.writeUInt32LE(0, 16); // time
    this.win32.SendInput(1, buf, INPUT_SIZE);
  }
}

function loadWin32(verbose: boolean): Win32 | null {
  if (process.platform !== 'win32') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi'); // optional dependency, already used by lmuLocalCar
    const u32 = koffi.load('user32.dll');
    return {
      SendInput: u32.func('uint32 __stdcall SendInput(uint32, void*, int32)'),
      GetForegroundWindow: u32.func('void* __stdcall GetForegroundWindow()'),
      GetWindowTextW: u32.func('int32 __stdcall GetWindowTextW(void*, char16*, int32)'),
      MapVirtualKeyW: u32.func('uint32 __stdcall MapVirtualKeyW(uint32, uint32)'),
    };
  } catch (err) {
    if (verbose) console.error('[keys] user32 unavailable:', (err as Error).message);
    return null;
  }
}
