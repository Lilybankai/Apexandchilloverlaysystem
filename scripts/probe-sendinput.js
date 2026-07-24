/**
 * scripts/probe-sendinput.js — confirm we can inject GAME-READABLE keystrokes
 * from Node, with no new native module, for the live-driving-aid half of the MFD
 * widget (brake bias, TC/ABS, engine map, headlights — the channels LMU does not
 * expose over REST).
 * -----------------------------------------------------------------------------
 * Why this probe exists. Browsers can't send keys to another window, so the Node
 * side has to do it. The naive routes (PowerShell SendKeys, WM_CHAR posts) send
 * *characters*, which games ignore — LMU reads the keyboard as raw SCANCODES via
 * DirectInput/RawInput. The reliable route is Win32 `SendInput` with
 * `KEYEVENTF_SCANCODE`, injected at a low enough level that a game accepts it.
 *
 * And we can call `SendInput` with ZERO new dependencies: the project already
 * bundles `koffi` (used for the shared-memory reader), so we bind `user32.dll`
 * the same way `lmuLocalCar.ts` binds `kernel32.dll`. If this probe moves a
 * value in LMU, the aid-control half is unblocked and needs no native build.
 *
 * What it does:
 *   1. Prints the current FOREGROUND window title — SendInput goes to whatever
 *      is focused, so this is the guardrail the real feature will enforce (only
 *      fire when LMU is frontmost).
 *   2. Counts down, then presses the scancode you pass (down, hold, up), once or
 *      repeated, so you can watch LMU react (e.g. tap your "brake bias +" key's
 *      scancode and see the bias move on the in-game MFD).
 *
 * Usage — start LMU, make it the focused window, then from another terminal but
 * with LMU foreground when the countdown ends:
 *
 *   node scripts/probe-sendinput.js --scan 0x21          # press scancode 0x21 (D key) once
 *   node scripts/probe-sendinput.js --scan 0x21 --count 3 --gap 200
 *   node scripts/probe-sendinput.js --vk 0x44            # give a virtual-key, auto-map to scancode
 *   node scripts/probe-sendinput.js --scan 0x48 --ext    # extended key (arrows/nav): set KEYEVENTF_EXTENDEDKEY
 *   node scripts/probe-sendinput.js --foreground-only    # just report the focused window and exit
 *
 * Scancodes are the SET-1 "make" codes. A few common ones: Q=0x10 W=0x11 E=0x12
 * R=0x13 A=0x1E S=0x1F D=0x20 F=0x21 1=0x02 2=0x03. Arrows/Ins/Del/Home are
 * "extended" — pass --ext for those. Bind your aid to a plain key in LMU and use
 * that key's scancode here.
 *
 * NOTE: this presses a real key into whatever is focused. Point it at LMU (or a
 * throwaway text editor to sanity-check it types), never at something you could
 * damage with a stray keypress.
 */

'use strict';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const num = (v) => (typeof v === 'string' && v.startsWith('0x') ? parseInt(v, 16) : Number(v));

const SCAN = argOf('--scan', null);
const VK = argOf('--vk', null);
const COUNT = Number(argOf('--count', 1));
const GAP_MS = Number(argOf('--gap', 150));
const HOLD_MS = Number(argOf('--hold', 40));
const EXTENDED = process.argv.includes('--ext');
const FOREGROUND_ONLY = process.argv.includes('--foreground-only');
const DELAY_MS = Number(argOf('--delay', 3000));

/* Win32 constants. */
const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const MAPVK_VK_TO_VSC = 0;

/* x64 INPUT is 40 bytes: DWORD type + 4 pad, then the union (KEYBDINPUT lives at
 * +8). KEYBDINPUT: wVk@8(u16) wScan@10(u16) dwFlags@12(u32) time@16(u32)
 * dwExtraInfo@24(u64). The union pads out to 32, so the record is 8 + 32 = 40. */
const INPUT_SIZE = 40;

function loadUser32() {
  let koffi;
  try {
    koffi = require('koffi');
  } catch {
    console.error('koffi not available — run `npm install` first (it is already a dependency).');
    process.exit(1);
  }
  if (process.platform !== 'win32') {
    console.error('SendInput is Windows-only; this probe only makes sense on the sim PC.');
    process.exit(1);
  }
  const u32 = koffi.load('user32.dll');
  return {
    SendInput: u32.func('uint32 __stdcall SendInput(uint32, void*, int32)'),
    GetForegroundWindow: u32.func('void* __stdcall GetForegroundWindow()'),
    GetWindowTextW: u32.func('int32 __stdcall GetWindowTextW(void*, char16*, int32)'),
    MapVirtualKeyW: u32.func('uint32 __stdcall MapVirtualKeyW(uint32, uint32)'),
  };
}

function foregroundTitle(w) {
  const hwnd = w.GetForegroundWindow();
  if (!hwnd) return '(none)';
  const buf = Buffer.alloc(512 * 2); // 512 UTF-16 code units
  const n = w.GetWindowTextW(hwnd, buf, 512);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '(untitled)';
}

/** Builds one INPUT record (40 bytes) for a scancode make/break event. */
function keyInput(scan, keyUp) {
  const buf = Buffer.alloc(INPUT_SIZE);
  let flags = KEYEVENTF_SCANCODE;
  if (EXTENDED) flags |= KEYEVENTF_EXTENDEDKEY;
  if (keyUp) flags |= KEYEVENTF_KEYUP;
  buf.writeUInt32LE(INPUT_KEYBOARD, 0); // type
  buf.writeUInt16LE(0, 8); // wVk = 0 (we drive by scancode)
  buf.writeUInt16LE(scan & 0xffff, 10); // wScan
  buf.writeUInt32LE(flags >>> 0, 12); // dwFlags
  buf.writeUInt32LE(0, 16); // time (0 = let the system stamp it)
  return buf;
}

async function main() {
  const w = loadUser32();

  console.log(`Foreground window: "${foregroundTitle(w)}"`);
  if (FOREGROUND_ONLY) return;

  // Resolve the scancode: explicit --scan, or map a --vk to one.
  let scan;
  if (SCAN != null) {
    scan = num(SCAN);
  } else if (VK != null) {
    scan = w.MapVirtualKeyW(num(VK) >>> 0, MAPVK_VK_TO_VSC);
    console.log(`Mapped VK ${VK} → scancode 0x${scan.toString(16)}`);
  } else {
    console.error('Pass --scan <code> or --vk <code>. See the header for common scancodes.');
    process.exit(1);
  }
  if (!scan) {
    console.error('Resolved scancode is 0 — nothing to send.');
    process.exit(1);
  }

  console.log(
    `\nWill press scancode 0x${scan.toString(16)}${EXTENDED ? ' (extended)' : ''} ` +
      `${COUNT}×, ${HOLD_MS}ms hold, ${GAP_MS}ms apart.`,
  );
  console.log(`Focus the window you want to receive it. Sending in ${DELAY_MS / 1000}s…`);
  await sleep(DELAY_MS);

  console.log(`Sending into: "${foregroundTitle(w)}"`);
  for (let i = 0; i < COUNT; i++) {
    send(w, keyInput(scan, false)); // key down
    await sleep(HOLD_MS);
    send(w, keyInput(scan, true)); // key up
    if (i < COUNT - 1) await sleep(GAP_MS);
  }
  console.log(
    'Done. If LMU reacted, SendInput scancodes work and the aid-control half needs no native module.',
  );
}

function send(w, inputBuf) {
  const sent = w.SendInput(1, inputBuf, INPUT_SIZE);
  if (sent !== 1) {
    // GetLastError would need another binding; the count alone tells us if the
    // OS accepted the event (1) or rejected it (0, e.g. UIPI blocked by a
    // higher-integrity foreground app).
    console.warn(`  SendInput returned ${sent} (expected 1) — event not injected.`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
