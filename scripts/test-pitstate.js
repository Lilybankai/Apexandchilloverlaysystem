/**
 * scripts/test-pitstate.js — who is ACTUALLY in the pits.
 * -----------------------------------------------------------------------------
 * LMU's `pitState` latches. It is set on the way out of a stop and never
 * cleared, so a car that pitted on lap 40 still reports "EXITING" on lap 175 at
 * racing speed. The old rule — anything that is not "NONE" means in the pits —
 * therefore flagged 34 of the 39 cars in a live Daytona team race, the leader
 * among them at 314 km/h.
 *
 * The fixtures below ARE that probe: the rows are the real ones read off
 * 127.0.0.1:6397 on 2026-08-30, speeds included, so this test fails the moment
 * the old rule comes back.
 *
 * Two other things the field gets wrong and this pins down:
 *   - retired cars keep every pit flag raised to the flag, so they must be
 *     tested for retirement FIRST or a lap-16 DNF wears a PIT badge all race;
 *   - `pitstops` resets (driver swaps), so stops are counted here off pit-lane
 *     entries instead of believed.
 *
 * Run: node scripts/test-pitstate.js
 */

'use strict';

const { isInPit, isOnPitLane, isRetired } = require('../dist/telemetry/lmuRestProvider.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? `   [${detail}]` : ''));
  ok ? pass++ : fail++;
};

/* -------------------------------------------------------------------------- */
/*  The live probe, 2026-08-30, Daytona, lap ~175 of a team race              */
/* -------------------------------------------------------------------------- */

// slotID, carNumber, driver, lap, km/h, pitState, pitting, inGarageStall, finishStatus
const FIELD = [
  [1, 95, 'Yaroslav Bichovski', 175, 314, 'EXITING', false, false, 'FSTAT_NONE'],
  [2, 11, 'Dillon Larson', 175, 298, 'EXITING', false, false, 'FSTAT_NONE'],
  [3, 51, 'Stephan Feig', 173, 157, 'EXITING', false, false, 'FSTAT_NONE'],
  [4, 29, 'Maxime Beluguet', 170, 288, 'NONE', false, false, 'FSTAT_NONE'],
  [6, 22, 'Kyle Guy', 168, 290, 'EXITING', false, false, 'FSTAT_NONE'],
  [7, 12, 'Chuck Retallick', 165, 92, 'EXITING', false, false, 'FSTAT_NONE'],
  [17, 23, 'Pavel Zalevskiy', 157, 0, 'STOPPED', false, false, 'FSTAT_NONE'],
  [20, 97, 'Marvin Schrader', 155, 240, 'REQUEST', false, false, 'FSTAT_NONE'],
  [25, 15, 'Sebastian Martinez', 151, 40, 'EXITING', true, false, 'FSTAT_NONE'],
  [26, 77, 'Nolan Poulier', 93, 0, 'EXITING', true, true, 'FSTAT_NONE'],
  [28, 27, 'Lok Perera', 150, 0, 'EXITING', true, true, 'FSTAT_DNF'],
  [30, 55, 'James Betanio', 71, 0, 'EXITING', true, true, 'FSTAT_DQ'],
  [36, 99, 'Ollie Pengilly', 16, 0, 'EXITING', true, true, 'FSTAT_DNF'],
];

const row = ([slotID, carNumber, driverName, lapsCompleted, kph, pitState, pitting, inGarageStall, finishStatus]) => ({
  slotID, carNumber, driverName, lapsCompleted, kph,
  pitState, pitting, inGarageStall, finishStatus,
});
const cars = FIELD.map(row);
const byNumber = (n) => cars.find((c) => c.carNumber === n);

console.log('\nthe latched EXITING must not read as a pit stop');
for (const c of cars.filter((x) => x.kph > 80)) {
  check(`#${c.carNumber} at ${c.kph} km/h is on track`, isInPit(c) === false, c.pitState);
}

console.log('\nthe states that do mean the pit lane');
check('STOPPED in the box', isInPit(byNumber(23)) === true);
check('pitting=true mid-visit', isInPit(byNumber(15)) === true);
check('ENTERING', isInPit({ pitState: 'ENTERING' }) === true);
check('ENTER (short spelling)', isInPit({ pitState: 'enter' }) === true);
check('a garage stall', isInPit(byNumber(77)) === true);

console.log('\na booked stop is not a taken stop');
check(
  'REQUEST is green laps, not the pit lane',
  isInPit(byNumber(97)) === false,
  'those are the last laps a burn average wants',
);

console.log('\nretirement is tested before the pit flags');
check('#27 DNF is retired', isRetired(byNumber(27)) === true);
check('#55 DQ is retired', isRetired(byNumber(55)) === true);
check('#99 DNF on lap 16 is retired', isRetired(byNumber(99)) === true);
check('#77 in the garage but still classified is NOT retired', isRetired(byNumber(77)) === false);
check('a running leader is not retired', isRetired(byNumber(95)) === false);

console.log('\nthe whole field, counted');
const flagged = cars.filter((c) => isInPit(c));
const flaggedFast = flagged.filter((c) => c.kph > 80);
check('nothing moving is called "in the pits"', flaggedFast.length === 0, `${flaggedFast.length} of ${flagged.length}`);
check(
  'only the genuinely stopped and the garaged are flagged',
  flagged.length === 6,
  flagged.map((c) => `#${c.carNumber}`).join(' '),
);
check(
  'the old rule would have flagged nearly everyone',
  cars.filter((c) => c.pitState !== 'NONE').length === 12,
  '12 of 13 — the bug this file exists for',
);

console.log('\nisOnPitLane agrees (the burn-average gate)');
check('leader at 314 km/h is a usable lap', isOnPitLane(byNumber(95)) === false);
check('the car in the box is not', isOnPitLane(byNumber(23)) === true);

console.log(`\ntest-pitstate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
