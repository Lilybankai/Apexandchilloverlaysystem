/**
 * scripts/probe-lmu-intervention.js — what does LMU publish while TC / ABS work?
 * -----------------------------------------------------------------------------
 * The input overlay used to measure aid intervention as unfiltered − filtered
 * pedal. On track that showed TC as scattered dots and ABS as nothing, so this
 * records every candidate channel side by side while the driver provokes both
 * aids, and lets the data say which one actually carries the intervention:
 *
 *   - unfiltered / filtered throttle, brake and steering;
 *   - the mTCActive / mABSActive flag bytes (746 / 747);
 *   - per-wheel mBrakePressure (wheel +32, 0..1 in rF2) — ABS modulates THIS,
 *     not the pedal, if it is populated;
 *   - per-wheel rotation and longitudinal patch / ground velocity (slip);
 *   - mEngineTorque (592) — TC cuts torque, which may never touch the pedal;
 *   - mVisualSteeringWheelRange (660) and mPhysicalSteeringWheelRange (692),
 *     both float degrees in the ISI struct, for drawing a wheel at true angle.
 *
 * Usage — in your own car, on track:
 *   node scripts/probe-lmu-intervention.js [--seconds 120] [--out file.ndjson]
 *
 * Then: brake hard enough to trigger ABS, and get on the throttle early out of
 * slow corners to trigger TC. Prints a live line per second plus a summary.
 */

'use strict';

const fs = require('node:fs');
const koffi = require('koffi');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16;
const STRIDE = 1888;
const WHEEL0 = 848;
const WSTRIDE = 260;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const seconds = Number(arg('--seconds', 120));
const outPath = arg('--out', null);

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

const u8 = (o) => koffi.decode(view, o, 'uint8');
const f32 = (o) => koffi.decode(view, o, 'float');
const f64 = (o) => koffi.decode(view, o, 'double');

function findRecord() {
  for (let i = 0; i < 128; i++) {
    const o = BASE + i * STRIDE;
    const thr = f64(o + 388);
    const rpm = f64(o + 356);
    // The player's own record is the one with a populated aid block.
    const hasAids = u8(o + 751) > 0 || u8(o + 755) > 0 || u8(o + 757) > 0;
    if (thr >= -0.05 && thr <= 1.05 && rpm >= 200 && rpm <= 20000 && hasAids) return o;
  }
  return -1;
}

const rec = findRecord();
if (rec < 0) {
  console.error('No driven car with a populated aid block found. Get in your own car.');
  process.exit(1);
}

const r3 = (v) => Math.round(v * 1000) / 1000;

function sample() {
  const wheels = [];
  for (let w = 0; w < 4; w++) {
    const b = rec + WHEEL0 + w * WSTRIDE;
    wheels.push({
      bp: r3(f64(b + 32)),
      rot: r3(f64(b + 40)),
      lpv: r3(f64(b + 56)),
      lgv: r3(f64(b + 72)),
    });
  }
  return {
    t: Date.now(),
    uThr: r3(f64(rec + 388)),
    fThr: r3(f64(rec + 420)),
    uBrk: r3(f64(rec + 396)),
    fBrk: r3(f64(rec + 428)),
    uStr: r3(f64(rec + 404)),
    fStr: r3(f64(rec + 436)),
    absOn: u8(rec + 746),
    tcOn: u8(rec + 747),
    tq: r3(f64(rec + 592)),
    rpm: Math.round(f64(rec + 356)),
    spd: r3(Math.abs(f64(rec + 200)) * 3.6),
    visRange: r3(f32(rec + 660)),
    physRange: r3(f32(rec + 692)),
    tcSet: u8(rec + 750),
    absSet: u8(rec + 756),
    wheels,
  };
}

const out = outPath ? fs.createWriteStream(outPath) : null;
const s0 = sample();
console.log(
  `Record at byte ${rec}. TC setting ${s0.tcSet}, ABS setting ${s0.absSet}. ` +
    `Steering range visual ${s0.visRange}°, physical ${s0.physRange}°.\n` +
    `Recording ${seconds}s at ~100 Hz. Trigger ABS and TC now.\n`,
);

const stats = {
  n: 0,
  tcFlag: 0,
  absFlag: 0,
  thrGap: 0,
  brkGap: 0,
  // ABS: frames with the flag up where per-wheel pressure departs from pedal.
  absFlagWheelDip: 0,
  absFlagPedalGap: 0,
  tcFlagPedalGap: 0,
  brkPressurePopulated: 0,
  maxThrGap: 0,
  maxBrkGap: 0,
};
let last = 0;
const end = Date.now() + seconds * 1000;

const timer = setInterval(() => {
  const s = sample();
  if (out) out.write(JSON.stringify(s) + '\n');
  stats.n++;
  const thrGap = s.uThr - s.fThr;
  const brkGap = s.uBrk - s.fBrk;
  if (s.tcOn) stats.tcFlag++;
  if (s.absOn) stats.absFlag++;
  if (thrGap > 0.02) stats.thrGap++;
  if (brkGap > 0.02) stats.brkGap++;
  if (thrGap > stats.maxThrGap) stats.maxThrGap = r3(thrGap);
  if (brkGap > stats.maxBrkGap) stats.maxBrkGap = r3(brkGap);
  if (s.wheels.some((w) => w.bp > 0.01)) stats.brkPressurePopulated++;
  if (s.absOn) {
    if (brkGap > 0.02) stats.absFlagPedalGap++;
    const minBp = Math.min(...s.wheels.map((w) => w.bp));
    if (s.fBrk > 0.05 && minBp < s.fBrk - 0.05) stats.absFlagWheelDip++;
  }
  if (s.tcOn && thrGap > 0.02) stats.tcFlagPedalGap++;

  if (s.t - last >= 1000) {
    last = s.t;
    console.log(
      `thr ${s.uThr.toFixed(2)}→${s.fThr.toFixed(2)}  brk ${s.uBrk.toFixed(2)}→${s.fBrk.toFixed(2)}  ` +
        `TC${s.tcOn} ABS${s.absOn}  bp ${s.wheels.map((w) => w.bp.toFixed(2)).join('/')}  ` +
        `tq ${s.tq.toFixed(0)}  str ${s.uStr.toFixed(2)}  ${s.spd.toFixed(0)}kph`,
    );
  }
  if (Date.now() >= end) {
    clearInterval(timer);
    if (out) out.end();
    console.log('\nSummary:', JSON.stringify(stats, null, 2));
  }
}, 10);
