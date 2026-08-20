/**
 * scripts/test-paceavg.js — the rolling last-5 pace average behind the
 * standings tower's optional AVG column.
 * -----------------------------------------------------------------------------
 * The number claims to be the pace a car is ACTUALLY running, so the failure
 * modes worth pinning are the ones that would make it lie: a pit lap dragging
 * the window 40 seconds slow, a session change carrying qualifying pace into
 * the race, a car's first sighting counting laps we never saw, and a slot id
 * reused by a joiner inheriting the leaver's laps.
 *
 * Run: node scripts/test-paceavg.js
 */

'use strict';

const { PaceAverageTracker, PACE_AVG_WINDOW } = require('../dist/telemetry/paceAverage');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

function car(slotId, laps, last, inPit) {
  return { slotId, lapsCompleted: laps, lastLapSec: last, inPit: !!inPit };
}

const KEY = 'daytona|race';

console.log('\ncollecting laps');

let t = new PaceAverageTracker();
let out = t.update([car(1, 5, 100)], KEY);
check('first sight of a car yields no average', !out.has(1));

out = t.update([car(1, 6, 101)], KEY);
check('a completed lap starts the average', out.get(1) === 101, out.get(1));
out = t.update([car(1, 7, 103)], KEY);
check('two laps average', out.get(1) === 102, out.get(1));
out = t.update([car(1, 7, 103)], KEY);
check('no new lap, same answer', out.get(1) === 102, out.get(1));

// The window slides: five kept laps, the oldest dropped.
t = new PaceAverageTracker();
t.update([car(1, 0, -1)], KEY);
for (let i = 1; i <= 7; i++) t.update([car(1, i, 100 + i)], KEY);
out = t.update([car(1, 7, 107)], KEY);
// laps 3..7 → times 103..107 → mean 105
check(`only the last ${PACE_AVG_WINDOW} laps count`, out.get(1) === 105, out.get(1));

console.log('\nwhat must not count');

// A lap the car pitted on is not pace.
t = new PaceAverageTracker();
t.update([car(1, 3, 100)], KEY);
t.update([car(1, 4, 100)], KEY); // clean lap: kept
t.update([car(1, 4, 100, true)], KEY); // seen in the lane mid-lap
out = t.update([car(1, 5, 142)], KEY); // the in-lap completes, 42s slow
check('a pit lap is left out', out.get(1) === 100, out.get(1));
out = t.update([car(1, 6, 104)], KEY);
check('the out-lap after the stop counts', out.get(1) === 102, out.get(1));

// A withheld time (the sim writes -1 for a lap it invalidated) is skipped.
t = new PaceAverageTracker();
t.update([car(1, 3, 100)], KEY);
t.update([car(1, 4, 100)], KEY);
out = t.update([car(1, 5, -1)], KEY);
check('a withheld lap time is skipped', out.get(1) === 100, out.get(1));

console.log('\nsessions and slots');

t = new PaceAverageTracker();
t.update([car(1, 3, 90)], KEY);
t.update([car(1, 4, 90)], KEY);
out = t.update([car(1, 5, 91)], 'daytona|qual');
check('a session change wipes the window', !out.has(1));

// A slot vacated and reused by a joiner must not inherit the leaver's laps.
t = new PaceAverageTracker();
t.update([car(1, 3, 100), car(2, 3, 100)], KEY);
t.update([car(1, 4, 100), car(2, 4, 100)], KEY);
t.update([car(1, 5, 100)], KEY); // car 2 left the field
out = t.update([car(1, 6, 100), car(2, 6, 130)], KEY);
check('a reused slot starts from nothing', !out.has(2));
check('…while the car that stayed keeps its average', out.get(1) === 100, out.get(1));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
