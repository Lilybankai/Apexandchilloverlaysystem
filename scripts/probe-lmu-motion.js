/**
 * scripts/probe-lmu-motion.js — verify LMU's G-force / rotation offsets.
 * -----------------------------------------------------------------------------
 * The rF2VehicleTelemetry motion block is DERIVED, not yet pinned live, so this
 * probe exists to confirm it before anything is built on top.
 *
 * The derivation, from the two offsets already verified in lmuLocalCar.ts:
 *   mLocalVel.z = 200  →  rF2Vec3 mLocalVel starts at 184
 * and the ISI struct order is
 *   mPos(160) mLocalVel(184) mLocalAccel(208) mOri[3](232) mLocalRot(304)
 *   mLocalRotAccel(328) → mGear(352)
 * That last step is the confirmation: mGear = 352 is already verified live, and
 * it lands EXACTLY where mLocalRotAccel ends. The block is bracketed on both
 * sides by known-good offsets, which is much stronger evidence than a scan.
 *
 * What still needs a live check is not the location but the SIGNS and SCALE:
 * ISI's local axes are X = right, Y = up, Z = BACKWARD (which is why speed is
 * read as abs(mLocalVel.z)), so which way a positive number points has to be
 * confirmed against real driving rather than reasoned about.
 *
 * Usage — start LMU, get on track, then in another terminal:
 *   node scripts/probe-lmu-motion.js [--slot <id>]
 *
 * Then drive the four cases it prints a checklist for. Read-only, safe to run
 * while racing; samples 5x/second.
 */

'use strict';

const koffi = require('koffi');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16;
const STRIDE = 1888;

// Verified scalar offsets, used to pick the driven car's record.
const OFF_RPM = 356;
const OFF_THROTTLE = 388;
const OFF_BRAKE = 396;
const OFF_STEER = 404;
const OFF_VEL = 184; // rF2Vec3 mLocalVel  {x,y,z} — z verified at 200

// The block under test.
const OFF_ACCEL = 208; // rF2Vec3 mLocalAccel, m/s^2
const OFF_ORI = 232; // rF2Vec3 mOri[3], orientation matrix rows
const OFF_ROT = 304; // rF2Vec3 mLocalRot, rad/s

const G = 9.80665;

const k32 = koffi.load('kernel32.dll');
const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
const MapViewOfFile = k32.func('void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)');

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
  const vec3 = (off) => [readF64(off), readF64(off + 8), readF64(off + 16)];

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

  // Peak trackers, so a corner or a braking zone leaves evidence you can read
  // after the fact rather than having to catch the console mid-slide.
  const peak = { latL: 0, latR: 0, accel: 0, brake: 0, yawL: 0, yawR: 0, vert: 0 };
  const f = (v, d = 2) => (v >= 0 ? ' ' : '') + v.toFixed(d);

  console.log(`
Probing LMU motion channels. Drive these four cases and watch the numbers:

  1. HARD BRAKING in a straight line  -> LONG should peak strongly one way
  2. FULL THROTTLE out of a slow corner -> LONG should peak the OTHER way
  3. A long LEFT corner                -> LAT and YAW should agree in sign
  4. A long RIGHT corner                -> both should flip

VERT is ZERO-centred, not 1 g: LMU cancels gravity against the normal force, so
flat ground reads ~0.00 at any speed (measured: +/-0.06 at 200 kph). It moves
only over kerbs, crests and compressions.

Confirmed on this build: LON tracks brake pressure exactly (brk 0.56 -> 1.28 g
raw, brk 1.00 -> 1.53 g) while speed falls, which is what pins mLocalAccel.
Raw LON is printed unmodified here, and the widget now reports it unmodified
too: braking is POSITIVE by display convention, so these numbers match.
`);

  function sample() {
    const rec = findRecord();
    if (rec < 0) {
      console.log('(no driven car found — get in the car / pass --slot <id>)');
      return;
    }
    const [ax, ay, az] = vec3(rec + OFF_ACCEL);
    const [rx, ry, rz] = vec3(rec + OFF_ROT);
    const [, , vz] = vec3(rec + OFF_VEL);
    const thr = readF64(rec + OFF_THROTTLE);
    const brk = readF64(rec + OFF_BRAKE);
    const str = readF64(rec + OFF_STEER);

    // Raw, unsigned-corrected: the point of the probe is to SEE the raw signs.
    const lat = ax / G;
    const vert = ay / G;
    const lon = az / G;
    const kph = Math.abs(vz) * 3.6;

    if (lat > peak.latR) peak.latR = lat;
    if (lat < -peak.latL) peak.latL = -lat;
    if (lon > peak.accel) peak.accel = lon;
    if (lon < -peak.brake) peak.brake = -lon;
    if (ry > peak.yawR) peak.yawR = ry;
    if (ry < -peak.yawL) peak.yawL = -ry;
    if (Math.abs(vert) > peak.vert) peak.vert = Math.abs(vert);

    console.log(
      `${String(Math.round(kph)).padStart(3)}kph ` +
        `thr ${thr.toFixed(2)} brk ${brk.toFixed(2)} str ${f(str)} | ` +
        `G lat ${f(lat)} vert ${f(vert)} lon ${f(lon)} | ` +
        `rot pitch ${f(rx)} yaw ${f(ry)} roll ${f(rz)} rad/s`,
    );
  }

  setInterval(sample, 200);

  // Peaks on exit are the actual deliverable — they say what full-scale is.
  process.on('SIGINT', () => {
    console.log(`
=== PEAKS ===
  lateral   : ${peak.latL.toFixed(2)} g one way / ${peak.latR.toFixed(2)} g the other
  long +    : ${peak.accel.toFixed(2)} g      long - : ${peak.brake.toFixed(2)} g
  yaw       : ${peak.yawL.toFixed(2)} / ${peak.yawR.toFixed(2)} rad/s
  vertical  : ${peak.vert.toFixed(2)} g (peak absolute)

Sanity: a GT3/Hypercar should show roughly 1.5-3.0 g lateral, 1.0-2.0 g braking,
0.5-1.5 g acceleration. Numbers ~10x too big or small mean a wrong offset.
`);
    process.exit(0);
  });
}

main();
