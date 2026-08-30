/**
 * scripts/test-stoplog.js — the strategy corpus: pit visits and lap consumption.
 * -----------------------------------------------------------------------------
 * Phase 0 of docs/RACE-STRATEGY-ENGINE.md. Nothing in this app used to write
 * down what a stop cost or what a lap burned, so every coefficient a strategy
 * engine needs would have been invented. These two logs are the training set,
 * and what matters about a training set is that it contains no fiction — so
 * most of what follows asserts a value is ABSENT when it cannot be measured,
 * not that it is present when it can.
 *
 * The pit sequences are driven the way LMU actually behaves, as probed live at
 * Daytona on 2026-08-30: the pit flags flutter mid-service, so a stop must not
 * split in two, and the level is only worth reading either side of the visit.
 *
 * Run: node scripts/test-stoplog.js
 */

'use strict';

const { StopRecorder } = require('../dist/telemetry/stopLog.js');
const { LapRecorder } = require('../dist/telemetry/lapLog.js');
const { UNKNOWN_VALUE } = require('../dist/telemetry/types.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? `   [${detail}]` : ''));
  ok ? pass++ : fail++;
};

/* -------------------------------------------------------------------------- */
/*  Stop records                                                              */
/* -------------------------------------------------------------------------- */

const BASE = {
  sim: 'lmu',
  track: 'Daytona',
  trackLengthM: 5730,
  car: 'Oreca 07',
  carClass: 'LMP2',
  sessionType: 'race',
  lapsCompleted: 40,
};
const NEW = [1, 1, 1, 1];
const WORN = [0.62, 0.64, 0.58, 0.6];

/** Drive a scripted visit. `t` advances 250 ms a sample, like the real poll. */
function driveStop(script) {
  const r = new StopRecorder();
  let t = 1_000_000;
  let out = null;
  for (const s of script) {
    const got = r.update({ ...BASE, ...s }, t);
    if (got) out = got;
    t += 250;
  }
  return out;
}
const rep = (n, s) => Array(n).fill(s);

console.log('\na complete stop');
const stop = driveStop([
  ...rep(8, { inPit: false, speedKph: 210, fuelL: 12.4, wear: WORN, compound: 'medium' }),
  ...rep(4, { inPit: true, speedKph: 55, fuelL: 12.2, wear: WORN, compound: 'medium', bookedSec: 31.5 }),
  ...rep(120, { inPit: true, speedKph: 0, fuelL: 40, wear: NEW, compound: 'medium', bookedSec: 31.5 }),
  ...rep(4, { inPit: true, speedKph: 40, fuelL: 61.8, wear: NEW, compound: 'medium' }),
  ...rep(8, { inPit: false, speedKph: 120, fuelL: 61.8, wear: NEW, compound: 'medium' }),
]);
check('a stop is recorded', !!stop);
check('lane time is entry to exit', stop && Math.abs(stop.laneSec - 32) < 1, stop && stop.laneSec);
check('stationary time is wheels-stopped only', stop && Math.abs(stop.stationarySec - 30) < 1, stop && stop.stationarySec);
check('fuel added is measured across the visit', stop && Math.abs(stop.fuelAddedL - 49.4) < 0.1, stop && stop.fuelAddedL);
check('…from the last ON-TRACK level, not the flagged one', stop && stop.fuelBeforeL === 12.4, stop && stop.fuelBeforeL);
check('a tyre change is detected', stop && stop.tyresChanged === true);
check('the sim\'s booked estimate is kept beside the measurement', stop && stop.bookedSec === 31.5);
check('the stop is numbered', stop && stop.stopNo === 1);
check('the lap it happened on is recorded', stop && stop.lap === 40);
check('the compound fitted is recorded', stop && stop.compoundFitted === 'medium');

console.log('\nthe flutter must not split one stop in two');
const flutter = driveStop([
  ...rep(8, { inPit: false, speedKph: 210, fuelL: 12, wear: WORN }),
  ...rep(30, { inPit: true, speedKph: 0, fuelL: 20, wear: WORN }),
  ...rep(3, { inPit: false, speedKph: 0, fuelL: 30, wear: WORN }), // a dropped flag
  ...rep(30, { inPit: true, speedKph: 0, fuelL: 45, wear: WORN }),
  ...rep(8, { inPit: false, speedKph: 120, fuelL: 45, wear: WORN }),
]);
check('one visit, one record', flutter && flutter.stopNo === 1, flutter && flutter.stopNo);
check('…spanning the whole service', flutter && flutter.laneSec > 15, flutter && flutter.laneSec);

console.log('\nfuel-only stops are the ones a refuel rate can be fitted from');
const fuelOnly = driveStop([
  ...rep(8, { inPit: false, speedKph: 210, fuelL: 10, wear: WORN }),
  ...rep(60, { inPit: true, speedKph: 0, fuelL: 30, wear: WORN }),
  ...rep(8, { inPit: false, speedKph: 120, fuelL: 48, wear: WORN }),
]);
check('no tyre change is reported when wear did not rise', fuelOnly && fuelOnly.tyresChanged === false);
check('and the fuel is still measured', fuelOnly && fuelOnly.fuelAddedL === 38, fuelOnly && fuelOnly.fuelAddedL);

console.log('\nwhat must NOT be recorded');
const brief = driveStop([
  ...rep(8, { inPit: false, speedKph: 210, fuelL: 30 }),
  ...rep(2, { inPit: true, speedKph: 60, fuelL: 30 }),
  ...rep(8, { inPit: false, speedKph: 200, fuelL: 30 }),
]);
check('a half-second brush of the lane is not a stop', brief === null);
const noSpeed = driveStop([
  ...rep(8, { inPit: false, fuelL: 10 }),
  ...rep(60, { inPit: true, fuelL: 30 }),
  ...rep(8, { inPit: false, fuelL: 48 }),
]);
check('no speed channel means no stationary READ, not zero seconds',
  noSpeed && noSpeed.stationarySec === UNKNOWN_VALUE, noSpeed && noSpeed.stationarySec);
check('…while the lane time is still measured', noSpeed && noSpeed.laneSec > 10);
const noFuel = driveStop([
  ...rep(8, { inPit: false, speedKph: 210 }),
  ...rep(60, { inPit: true, speedKph: 0 }),
  ...rep(8, { inPit: false, speedKph: 120 }),
]);
check('spectating records no fuel at all', noFuel && noFuel.fuelAddedL === undefined);

console.log('\nsecond stop, and a session change');
const r2 = new StopRecorder();
let t = 5_000_000;
const feed = (s) => { const g = r2.update({ ...BASE, ...s }, t); t += 250; return g; };
let second = null;
for (const s of [
  ...rep(8, { inPit: false, speedKph: 200, fuelL: 10 }),
  ...rep(60, { inPit: true, speedKph: 0, fuelL: 30 }),
  ...rep(8, { inPit: false, speedKph: 120, fuelL: 48 }),
  ...rep(20, { inPit: false, speedKph: 200, fuelL: 20 }),
  ...rep(60, { inPit: true, speedKph: 0, fuelL: 40 }),
  ...rep(8, { inPit: false, speedKph: 120, fuelL: 60 }),
]) { const g = feed(s); if (g) second = g; }
check('stops are numbered in order', second && second.stopNo === 2, second && second.stopNo);
const spanning = r2.update({ ...BASE, sessionType: 'practice', inPit: false, speedKph: 200 }, t);
check('a visit spanning a session change is dropped, not timed', spanning === null);

/* -------------------------------------------------------------------------- */
/*  Lap consumption (LapRecord v5)                                            */
/* -------------------------------------------------------------------------- */

const LAP = {
  sim: 'lmu',
  track: 'Daytona',
  trackLengthM: 5730,
  car: 'Oreca 07',
  carClass: 'LMP2',
  sessionType: 'race',
  lastLapSec: 100.3,
  inPit: false,
  limitWarnings: 0,
  penalties: 0,
  capacityL: 75,
};

/** Run a stint; return every emitted record. */
function driveLaps(script) {
  const r = new LapRecorder();
  const out = [];
  let t = 1_000_000;
  for (const s of script) {
    const got = r.update({ ...LAP, ...s }, t);
    if (got) out.push(got);
    t += 250;
  }
  // Flush whatever is held by ending the stint.
  const last = r.update({ ...LAP, sessionType: 'practice', lapsCompleted: 0 }, t + 60_000);
  if (last) out.push(last);
  return out;
}

console.log('\nlap consumption');
const laps = driveLaps([
  ...rep(4, { lapsCompleted: 10, fuelL: 60 }),
  ...rep(4, { lapsCompleted: 11, fuelL: 57 }),
  ...rep(4, { lapsCompleted: 12, fuelL: 54 }),
  ...rep(4, { lapsCompleted: 13, fuelL: 51 }),
]);
const measured = laps.filter((l) => typeof l.fuelUsedL === 'number');
check('a green lap records its burn', measured.length >= 1, `${measured.length} of ${laps.length}`);
check('…and the burn is the difference', measured[0] && Math.abs(measured[0].fuelUsedL - 3) < 0.01, measured[0] && measured[0].fuelUsedL);
check('both ends of the lap are recorded', measured[0] && measured[0].fuelStartL === 57 && measured[0].fuelEndL === 54);
check('capacity rides along', measured[0] && measured[0].capacityL === 75);
check('the record is v5', laps[0] && laps[0].v === 5, laps[0] && laps[0].v);

console.log('\nwhat is not a burn');
const pitted = driveLaps([
  ...rep(4, { lapsCompleted: 10, fuelL: 20 }),
  ...rep(4, { lapsCompleted: 11, fuelL: 17, inPit: true }),
  ...rep(4, { lapsCompleted: 12, fuelL: 65 }),
  ...rep(4, { lapsCompleted: 13, fuelL: 62 }),
]);
const pitLap = pitted.find((l) => l.dirty.includes('pit'));
check('a lap through the pits records no burn', pitLap && pitLap.fuelUsedL === undefined);
check('…but still records the levels either side', pitLap && typeof pitLap.fuelEndL === 'number');
const refuelled = driveLaps([
  ...rep(4, { lapsCompleted: 10, fuelL: 20 }),
  ...rep(2, { lapsCompleted: 11, fuelL: 18 }),
  ...rep(2, { lapsCompleted: 11, fuelL: 45 }),   // the rig, mid-lap
  ...rep(4, { lapsCompleted: 12, fuelL: 42 }),
]);
const after = refuelled.find((l) => l.fuelStartL === 18);
check('a lap the rig touched records no burn, even ending lower than it started',
  !after || after.fuelUsedL === undefined);

console.log('\nstint position — the tyre-degradation x-axis');
const stint = driveLaps([
  ...rep(4, { lapsCompleted: 10, fuelL: 20, inPit: true }),
  ...rep(4, { lapsCompleted: 11, fuelL: 60, inPit: true }),  // out-lap
  ...rep(4, { lapsCompleted: 12, fuelL: 57 }),
  ...rep(4, { lapsCompleted: 13, fuelL: 54 }),
  ...rep(4, { lapsCompleted: 14, fuelL: 51 }),
]);
const outLap = stint.find((l) => l.isOutLap);
check('the out-lap is flagged', !!outLap);
check('…and is lap 1 of the stint', outLap && outLap.stintLap === 1, outLap && outLap.stintLap);
const green = stint.filter((l) => !l.isOutLap && typeof l.stintLap === 'number');
check('the stint then counts up', green.map((l) => l.stintLap).join(' ') === '2 3', green.map((l) => l.stintLap).join(' '));

console.log('\njoining mid-stint');
const joined = driveLaps([
  ...rep(4, { lapsCompleted: 30, fuelL: 40 }),
  ...rep(4, { lapsCompleted: 31, fuelL: 37 }),
  ...rep(4, { lapsCompleted: 32, fuelL: 34 }),
]);
check('a stint we did not see the start of has no stint number',
  joined.every((l) => l.stintLap === undefined), joined.map((l) => l.stintLap).join(','));
check('…but the burn is still measurable', joined.some((l) => typeof l.fuelUsedL === 'number'));

console.log('\ntyres and energy');
const withTyres = driveLaps([
  ...rep(4, { lapsCompleted: 10, fuelL: 60, wear: [0.9, 0.91, 0.88, 0.89], compound: 'medium' }),
  ...rep(4, { lapsCompleted: 11, fuelL: 57, wear: [0.87, 0.88, 0.85, 0.86], compound: 'medium' }),
]);
check('wear at the line is recorded', withTyres[0] && Array.isArray(withTyres[0].wearAtLine));
check('…all four corners', withTyres[0] && withTyres[0].wearAtLine.length === 4);
check('compound is recorded', withTyres[0] && withTyres[0].compound === 'medium');
const partialWear = driveLaps([
  ...rep(4, { lapsCompleted: 10, fuelL: 60, wear: [0.9, 0.91, 0.88] }),
  ...rep(4, { lapsCompleted: 11, fuelL: 57, wear: [0.9, 0.91, 0.88] }),
]);
check('three corners is not a wear vector', partialWear.every((l) => l.wearAtLine === undefined));
const energy = driveLaps([
  ...rep(4, { lapsCompleted: 10, fuelL: 60, vePct: 80 }),
  ...rep(4, { lapsCompleted: 11, fuelL: 57, vePct: 76 }),
]);
check('virtual energy is recorded for classes that run it', energy[0] && energy[0].veEndPct === 76, energy[0] && energy[0].veEndPct);
const noEnergy = driveLaps([
  ...rep(4, { lapsCompleted: 10, fuelL: 60, vePct: 0 }),
  ...rep(4, { lapsCompleted: 11, fuelL: 57, vePct: 0 }),
]);
check('a flat 0 is LMP2 having no energy budget, not an empty one',
  noEnergy.every((l) => l.veEndPct === undefined));

console.log('\nspectating adds nothing to the corpus');
const spectated = driveLaps([
  ...rep(4, { lapsCompleted: 10 }),
  ...rep(4, { lapsCompleted: 11 }),
]);
check('no fuel', spectated.every((l) => l.fuelEndL === undefined));
check('no wear', spectated.every((l) => l.wearAtLine === undefined));
check('but the lap is still a lap', spectated.length >= 1 && spectated[0].lapMs === 100300);

console.log(`\ntest-stoplog: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
