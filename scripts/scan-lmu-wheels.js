/**
 * scripts/scan-lmu-wheels.js — find LMU's real tyre-temperature offsets.
 * -----------------------------------------------------------------------------
 * LMU restructured the per-wheel telemetry away from the documented rF2Wheel
 * struct, so the overlay deliberately leaves tyre temps blank instead of
 * showing wrong values. This scanner finds where the temps actually live on
 * the current game build:
 *
 *   1. Start LMU, get in the car and DRIVE A LAP OR TWO (tyres must heat up
 *      so the values move — that's what separates temps from constants).
 *   2. In another terminal:  node scripts/scan-lmu-wheels.js
 *   3. Watch the output while driving: real tyre temps are the rows whose
 *      values sit in the 40–120 °C (or ~310–390 K) range, CHANGE slowly as
 *      you drive, and appear as a *quadruplet* — four offsets with an equal
 *      stride (front-left/front-right/rear-left/rear-right records).
 *   4. Paste the output back so the offsets can be wired into the overlay.
 *
 * Read-only and safe to run while racing; it samples once per second.
 */

'use strict';

const koffi = require('koffi');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16; // records start after header(12) + mNumVehicles(4)
const STRIDE = 2880;
const HDR_NUM_VEHICLES = 12;

// Verified scalar offsets, used to pick the driven car's record.
const OFF_RPM = 356;
const OFF_THROTTLE = 388;

const k32 = koffi.load('kernel32.dll');
const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
const MapViewOfFile = k32.func('void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)');

function plausibleC(v) {
  return v > 25 && v < 140;
}
function plausibleK(v) {
  return v > 295 && v < 420;
}

function main() {
  const handle = OpenFileMappingW(FILE_MAP_READ, false, MMF);
  if (!handle) {
    console.error('Shared memory not found — is LMU running (and you in a session)?');
    process.exit(1);
  }
  const view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
  if (!view) {
    console.error('MapViewOfFile failed.');
    process.exit(1);
  }

  const argSlot = process.argv.indexOf('--slot');
  const wantId = argSlot >= 0 ? Number(process.argv[argSlot + 1]) : null;

  const readI32 = (off) => koffi.decode(view, off, 'int32');
  const readF64 = (off) => koffi.decode(view, off, 'double');

  function findRecord() {
    const n = Math.min(128, Math.max(0, readI32(HDR_NUM_VEHICLES)));
    for (let i = 0; i < n; i++) {
      const o = BASE + i * STRIDE;
      if (wantId !== null) {
        if (readI32(o) === wantId) return o; // mID match
        continue;
      }
      const thr = readF64(o + OFF_THROTTLE);
      const rpm = readF64(o + OFF_RPM);
      if (thr >= -0.05 && thr <= 1.05 && rpm >= 200 && rpm <= 20000) return o;
    }
    return -1;
  }

  const history = new Map(); // offset -> [values...]

  function sample() {
    const rec = findRecord();
    if (rec < 0) {
      console.log('(no driven car found — get in the car / pass --slot <id>)');
      return;
    }
    // Scan the whole record for plausible temperatures at 4-byte alignment.
    const hits = [];
    for (let off = 448; off <= STRIDE - 8; off += 4) {
      const v = readF64(rec + off);
      if (!Number.isFinite(v)) continue;
      if (plausibleC(v) || plausibleK(v)) {
        hits.push([off, v]);
        const h = history.get(off) || [];
        h.push(v);
        if (h.length > 12) h.shift();
        history.set(off, h);
      }
    }

    // A real temperature MOVES while driving. Keep offsets whose recent values
    // vary a little but not wildly.
    const moving = hits.filter(([off]) => {
      const h = history.get(off);
      if (!h || h.length < 5) return false;
      const span = Math.max(...h) - Math.min(...h);
      return span > 0.05 && span < 40;
    });

    console.log(`\n=== ${new Date().toLocaleTimeString()} — record @${rec}, ` +
      `${hits.length} plausible, ${moving.length} moving ===`);
    for (const [off, v] of moving) {
      console.log(`  offset ${String(off).padStart(4)}  = ${v.toFixed(2)}`);
    }

    // Quadruplet detection: 4 moving offsets with an equal stride = the four
    // wheels' copies of the same field. These are the prime candidates.
    const offs = moving.map(([o]) => o);
    const set = new Set(offs);
    const quads = [];
    for (const o of offs) {
      for (let s = 8; s <= 700; s += 4) {
        if (set.has(o + s) && set.has(o + 2 * s) && set.has(o + 3 * s)) {
          quads.push({ base: o, stride: s });
        }
      }
    }
    if (quads.length) {
      console.log('  >>> QUADRUPLETS (likely per-wheel fields):');
      for (const q of quads.slice(0, 12)) {
        const vals = [0, 1, 2, 3].map((i) => readF64(rec + q.base + i * q.stride).toFixed(1));
        console.log(`      base ${q.base}, stride ${q.stride}: [${vals.join(', ')}]`);
      }
    }
  }

  console.log('Scanning for tyre temps — drive the car so they heat up. Ctrl+C to stop.');
  sample();
  setInterval(sample, 1000);
}

main();
