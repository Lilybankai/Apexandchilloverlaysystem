/**
 * scripts/probe-lmu-brakebias.js — find the LIVE rear-brake-bias offset in LMU's
 * shared-memory telemetry, the one aid a driver adjusts continuously that the
 * REST API only reports at its frozen SETUP value.
 * -----------------------------------------------------------------------------
 * The ISI rF2VehicleTelemetry struct has `double mRearBrakeBias` (a 0..1 rear
 * fraction) between the verified `mFuelCapacity` (608) and `mWheels[0]` (848).
 * The standard layout puts it at 664, but LMU reworks struct layouts, so this
 * scans every 4-byte-aligned double in that gap and reports the ones in a
 * plausible bias range — then you nudge brake bias in-game and watch which
 * offset MOVES. That offset is mRearBrakeBias.
 *
 * Usage — in LMU, in the car (garage or on track):
 *   node scripts/probe-lmu-brakebias.js [--slot <id>]
 * Then shift your brake bias a few clicks toward the front, then the rear, and
 * watch the "MOVED" lines. The offset that tracks your changes is the one.
 */

'use strict';

const koffi = require('koffi');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16;
const STRIDE = 1888;

const OFF_RPM = 356;
const OFF_THROTTLE = 388;
/** Verified anchors bracketing the region of interest. */
const OFF_ENGINE_MAX_RPM = 532;
const OFF_FUEL_CAPACITY = 608;
/** mWheels[0] starts here (mWheelTempBase 976 − 128) — scan stops before it. */
const OFF_WHEELS = 848;
/** The standard-layout guess for mRearBrakeBias. */
const OFF_GUESS = 664;

const argSlot = process.argv.indexOf('--slot');
const wantId = argSlot >= 0 ? Number(process.argv[argSlot + 1]) : null;

const k32 = koffi.load('kernel32.dll');
const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
const MapViewOfFile = k32.func('void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)');

const handle = OpenFileMappingW(FILE_MAP_READ, false, MMF);
if (!handle) {
  console.error('Shared memory not found — is LMU running and are you in the car?');
  process.exit(1);
}
const view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
if (!view) {
  console.error('MapViewOfFile failed.');
  process.exit(1);
}

const readI32 = (off) => koffi.decode(view, off, 'int32');
const readF64 = (off) => koffi.decode(view, off, 'double');

function findRecord() {
  for (let i = 0; i < 128; i++) {
    const o = BASE + i * STRIDE;
    if (wantId !== null) {
      if (readI32(o) === wantId) return o;
      continue;
    }
    const thr = readF64(o + OFF_THROTTLE);
    const rpm = readF64(o + OFF_RPM);
    if (thr >= -0.05 && thr <= 1.05 && rpm >= 200 && rpm <= 20000) return o;
  }
  return -1;
}

// Candidate offsets: every 4-byte boundary in the gap (pack(4) allows doubles on
// 4-byte alignment). We only ever REPORT ones holding a plausible bias value.
const candidates = [];
for (let off = OFF_FUEL_CAPACITY + 8; off < OFF_WHEELS; off += 4) candidates.push(off);

const baseline = new Map();
let anchorsChecked = false;

console.log(`
Probing LMU rear-brake-bias offset. Guess (standard layout) = ${OFF_GUESS}.

WHAT TO DO
  1. Be in the car (garage or track). Baseline prints once below.
  2. Shift brake bias several clicks toward the FRONT, then toward the REAR.
  3. Watch "MOVED" lines — the offset that tracks your changes is mRearBrakeBias.
  4. Ctrl-C when found.
`);

function plausibleBias(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0.2 && v < 0.8;
}

function sample() {
  const rec = findRecord();
  if (rec < 0) {
    console.log('(no driven car found — get in the car, or pass --slot <id>)');
    return;
  }
  if (!anchorsChecked) {
    const maxRpm = readF64(rec + OFF_ENGINE_MAX_RPM);
    const cap = readF64(rec + OFF_FUEL_CAPACITY);
    const ok = maxRpm > 1000 && maxRpm < 25000 && cap > 10 && cap < 250;
    console.log(
      (ok ? '  anchors OK   ' : '  ANCHORS BAD  ') +
        `maxRPM=${maxRpm.toFixed(0)} fuelCap=${cap.toFixed(1)}L` +
        (ok ? '' : '  <-- record misaligned; reads below are meaningless'),
    );
    // First-pass baseline: list every candidate holding a plausible bias value.
    console.log('  candidate offsets holding a plausible bias value now:');
    for (const off of candidates) {
      const v = readF64(rec + off);
      if (plausibleBias(v)) {
        baseline.set(off, v);
        console.log(`    @${off}${off === OFF_GUESS ? ' (GUESS)' : ''} = ${v.toFixed(4)}`);
      }
    }
    console.log('  --- now move your brake bias ---');
    anchorsChecked = true;
    return;
  }
  for (const off of candidates) {
    const v = readF64(rec + off);
    const prev = baseline.get(off);
    if (prev === undefined) {
      if (plausibleBias(v)) baseline.set(off, v);
      continue;
    }
    if (Math.abs(v - prev) > 0.0005 && plausibleBias(v)) {
      console.log(`  MOVED  @${off}${off === OFF_GUESS ? ' (GUESS)' : ''}: ${prev.toFixed(4)} -> ${v.toFixed(4)}`);
      baseline.set(off, v);
    }
  }
}

setInterval(sample, 250);
