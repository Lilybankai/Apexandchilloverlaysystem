/**
 * scripts/send-key.js — fire a single named key into whatever window is focused,
 * after a countdown. Its purpose is BINDING the driving-aid keys in LMU: F13–F24
 * don't exist on a physical keyboard, so this injector is how you assign them to
 * LMU's aid controls.
 * -----------------------------------------------------------------------------
 * Uses the same Win32 SendInput path as the server's keySender (koffi → user32,
 * scancode with a virtual-key fallback), so if a key binds with this it will
 * fire identically from the widget / wheel trigger later.
 *
 * Bind flow, per aid direction:
 *   1. In LMU: Settings → Controls, click the aid's assign field so it's LISTENING.
 *   2. Run this with a delay long enough to switch back to LMU, e.g.:
 *        node scripts/send-key.js F14 --delay 6
 *   3. During the countdown, click back into LMU so its dialog is focused + waiting.
 *   4. The key fires; LMU captures "F14". Repeat for each aid up/down key.
 *
 * Usage:
 *   node scripts/send-key.js <KEY> [--delay <seconds>] [--repeat <n>] [--gap <ms>]
 *   node scripts/send-key.js F14                 # 5s default countdown
 *   node scripts/send-key.js F13 --delay 6
 *   node scripts/send-key.js F16 --repeat 3 --gap 250
 *
 * Key names: F1–F24, NUM0–NUM9, NUMADD/NUMSUB/NUMMUL/NUMDIV, A–Z, 0–9.
 */

'use strict';

const VK = {
  F13:0x7c,F14:0x7d,F15:0x7e,F16:0x7f,F17:0x80,F18:0x81,F19:0x82,F20:0x83,F21:0x84,F22:0x85,F23:0x86,F24:0x87,
  F1:0x70,F2:0x71,F3:0x72,F4:0x73,F5:0x74,F6:0x75,F7:0x76,F8:0x77,F9:0x78,F10:0x79,F11:0x7a,F12:0x7b,
  NUM0:0x60,NUM1:0x61,NUM2:0x62,NUM3:0x63,NUM4:0x64,NUM5:0x65,NUM6:0x66,NUM7:0x67,NUM8:0x68,NUM9:0x69,
  NUMADD:0x6b,NUMSUB:0x6d,NUMMUL:0x6a,NUMDIV:0x6f,
};
for (let c = 0x30; c <= 0x39; c++) VK[String.fromCharCode(c)] = c; // 0-9
for (let c = 0x41; c <= 0x5a; c++) VK[String.fromCharCode(c)] = c; // A-Z

const INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_SCANCODE = 0x0008, MAPVK_VK_TO_VSC = 0, INPUT_SIZE = 40;

const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const KEY = (process.argv[2] || '').toUpperCase();
const DELAY = Math.max(0, Number(argOf('--delay', 5)));
const REPEAT = Math.max(1, Number(argOf('--repeat', 1)));
const GAP = Math.max(0, Number(argOf('--gap', 200)));
const HOLD = 40;

if (!KEY || !(KEY in VK)) {
  console.error(`Unknown or missing key "${process.argv[2] || ''}".\nValid: ${Object.keys(VK).join(', ')}`);
  process.exit(1);
}
if (process.platform !== 'win32') { console.error('Windows only.'); process.exit(1); }

let koffi;
try { koffi = require('koffi'); } catch { console.error('koffi missing — run `npm install`.'); process.exit(1); }
const u32 = koffi.load('user32.dll');
const SendInput = u32.func('uint32 __stdcall SendInput(uint32, void*, int32)');
const GetForegroundWindow = u32.func('void* __stdcall GetForegroundWindow()');
const GetWindowTextW = u32.func('int32 __stdcall GetWindowTextW(void*, char16*, int32)');
const MapVirtualKeyW = u32.func('uint32 __stdcall MapVirtualKeyW(uint32, uint32)');

function foreground() {
  const h = GetForegroundWindow(); if (!h) return '(none)';
  const b = Buffer.alloc(512 * 2); const n = GetWindowTextW(h, b, 512);
  return n > 0 ? b.toString('utf16le', 0, n * 2) : '(untitled)';
}
function input(vk, scan, up) {
  const b = Buffer.alloc(INPUT_SIZE);
  const useScan = scan > 0;
  let flags = useScan ? KEYEVENTF_SCANCODE : 0; if (up) flags |= KEYEVENTF_KEYUP;
  b.writeUInt32LE(INPUT_KEYBOARD, 0);
  b.writeUInt16LE(useScan ? 0 : vk & 0xffff, 8);
  b.writeUInt16LE(useScan ? scan & 0xffff : 0, 10);
  b.writeUInt32LE(flags >>> 0, 12);
  return b;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const vk = VK[KEY];
  const scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
  console.log(`Will press ${KEY} (vk 0x${vk.toString(16)}, scan 0x${scan.toString(16)}${scan ? '' : ' → using virtual-key'}) ${REPEAT}×.`);
  for (let s = Math.ceil(DELAY); s > 0; s--) { console.log(`  ${s}…  (focus LMU's listening bind dialog)`); await sleep(1000); }
  console.log(`Firing into: "${foreground()}"`);
  for (let i = 0; i < REPEAT; i++) {
    SendInput(1, input(vk, scan, false), INPUT_SIZE);
    await sleep(HOLD);
    SendInput(1, input(vk, scan, true), INPUT_SIZE);
    if (i < REPEAT - 1) await sleep(GAP);
  }
  console.log('Done. If LMU captured the key, the bind worked.');
})();
