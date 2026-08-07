/**
 * scripts/probe-lmu-hybrid.js — verify the pit limiter and hybrid battery
 * offsets against a running car.
 * -----------------------------------------------------------------------------
 * This script exists because counting the ISI struct forward from a verified
 * neighbour is NOT the same as watching a field move, and on this block the
 * difference mattered: the battery was first placed at 696 by exactly that kind
 * of reasoning, and it was wrong by one double. LMU carries eight bytes there
 * that the stock layout does not. 696 reads a hard 0.000 on a Hypercar at any
 * speed, which looks precisely like a car with no hybrid.
 *
 * The offsets below are the corrected ones, each confirmed against a moving
 * GR010 (see `lmuLocalCar.ts` for the full evidence):
 *
 *   604  unsigned char mSpeedLimiter        flips with the limiter button
 *   704  double mBatteryChargeFraction      rises under braking, always in [0,1]
 *   712  double mElectricBoostMotorTorque   −177 Nm on the brakes, ~0 coasting
 *   720  double mElectricBoostMotorRPM      tracks road speed
 *
 * Re-run it after any LMU update: every offset in that file is version-sensitive,
 * and this block has already moved once.
 *
 * It also prints the NEIGHBOURS of each field, because the failure mode of a
 * shifted struct is not garbage — it is a plausible number from the wrong field.
 * A charge that reads 0.49 and never moves is a brake bias; one that reads 0.000
 * and never moves is the mistake described above.
 *
 * Usage — in LMU, in your own car:
 *   node scripts/probe-lmu-hybrid.js [--slot <id>]
 *
 * Then, watching the live lines:
 *   1. Press the pit limiter button. `LIMITER` must flip to ON, and back to OFF.
 *      (If it never moves, 604 is not the limiter on this build.)
 *   2. In a HYPERCAR, drive a lap. `CHARGE` must fall on the straights and rise
 *      under braking, and `MOTOR` must be positive while deploying and negative
 *      while harvesting. A charge pinned at exactly 0.000 in a Hypercar that is
 *      moving means the offset is wrong — that is the reading a GT3 gives.
 *   3. In a GT3, the same run must leave `CHARGE` at 0.000 throughout. If it
 *      shows a live-looking number in a car with no hybrid, the offset has
 *      landed on something else and the widget's latch would wrongly arm.
 */

'use strict';

const koffi = require('koffi');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16;
const STRIDE = 1888;

/* Verified anchors, for the sanity line. */
const OFF_RPM = 356;
const OFF_THROTTLE = 388;
const OFF_BRAKE = 396;
const OFF_FUEL = 524;
const OFF_FUEL_CAPACITY = 608;
const OFF_REAR_BRAKE_BIAS = 664;

/* Under test. */
const OFF_SPEED_LIMITER = 604;
const OFF_BATTERY = 704;
const OFF_MOTOR_TORQUE = 712;

/* Neighbours, printed so a shifted struct is visible rather than plausible. */
const OFF_MAX_GEARS = 605;
const OFF_TURBO = 672;
const OFF_MOTOR_RPM = 720;

const argSlot = process.argv.indexOf('--slot');
const wantId = argSlot >= 0 ? Number(process.argv[argSlot + 1]) : null;

const k32 = koffi.load('kernel32.dll');
const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
const MapViewOfFile = k32.func(
  'void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)',
);

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
const readU8 = (off) => koffi.decode(view, off, 'uint8');
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

const rec = findRecord();
if (rec < 0) {
  console.error(
    'No driven car found in the telemetry buffer. Get in the car (engine running), ' +
      'or pass --slot <id> with your REST slotID.',
  );
  process.exit(1);
}

console.log(`Record at byte ${rec} (mID ${readI32(rec)}).`);
console.log(
  'Anchors — these must look right before anything below is worth believing:\n' +
    `  fuel ${readF64(rec + OFF_FUEL).toFixed(1)} L of ` +
    `${readF64(rec + OFF_FUEL_CAPACITY).toFixed(1)} L, ` +
    `rear brake bias ${readF64(rec + OFF_REAR_BRAKE_BIAS).toFixed(3)}\n`,
);
console.log(
  'Press the pit limiter; then drive a lap. Ctrl-C to stop.\n' +
    '  LIMITER  should flip with the button        (byte 604)\n' +
    '  CHARGE   should fall on power, rise on the brakes, in a Hypercar only\n' +
    '  MOTOR    should be + deploying, − harvesting\n',
);

let lastLimiter = null;
let seenCharge = 0;
let seenLimiterOn = false;

setInterval(() => {
  const limiter = readU8(rec + OFF_SPEED_LIMITER);
  const maxGears = readU8(rec + OFF_MAX_GEARS);
  const charge = readF64(rec + OFF_BATTERY);
  const motor = readF64(rec + OFF_MOTOR_TORQUE);
  const motorRpm = readF64(rec + OFF_MOTOR_RPM);
  const turbo = readF64(rec + OFF_TURBO);
  const thr = readF64(rec + OFF_THROTTLE);
  const brk = readF64(rec + OFF_BRAKE);

  if (limiter !== 0) seenLimiterOn = true;
  if (Number.isFinite(charge) && charge > seenCharge) seenCharge = charge;

  const flip = lastLimiter !== null && limiter !== lastLimiter ? '  <-- LIMITER CHANGED' : '';
  lastLimiter = limiter;

  // maxGears is the byte immediately after the limiter and should read a small
  // sane number (6-8). If it doesn't, the struct is shifted and 604 is not the
  // limiter either.
  const gearsOk = maxGears >= 3 && maxGears <= 10 ? 'ok' : `?? ${maxGears}`;

  console.log(
    `thr ${thr.toFixed(2)} brk ${brk.toFixed(2)} | ` +
      `LIMITER ${limiter ? 'ON ' : 'off'} (maxGears ${gearsOk}) | ` +
      `CHARGE ${Number.isFinite(charge) ? charge.toFixed(3) : 'NaN'} | ` +
      `MOTOR ${Number.isFinite(motor) ? motor.toFixed(1).padStart(7) : 'NaN'} Nm ` +
      `@ ${Number.isFinite(motorRpm) ? Math.round(motorRpm) : 'NaN'} | ` +
      `turbo ${Number.isFinite(turbo) ? turbo.toFixed(0) : 'NaN'}${flip}`,
  );
}, 250);

process.on('SIGINT', () => {
  console.log('\n--- verdict ---');
  console.log(
    seenLimiterOn
      ? '  LIMITER: saw it ON at least once — offset 604 is live.'
      : '  LIMITER: never read non-zero. Either you did not press it, or 604 is wrong.',
  );
  console.log(
    seenCharge > 0
      ? `  BATTERY: peaked at ${seenCharge.toFixed(3)} — offset 696 carries a real charge.`
      : '  BATTERY: stayed at 0. Correct for a car with no hybrid; WRONG for a Hypercar.',
  );
  process.exit(0);
});
