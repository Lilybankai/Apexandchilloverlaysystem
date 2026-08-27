/**
 * scripts/test-finishlatch.js — the finish latch across a session boundary.
 *
 * The regression this pins down (live tester report, 2026-08-28): LMU carries
 * the standings rows' FSTAT_FINISHED across the qualifying → race transition
 * and only resets it around the start. The latch used to re-file the quali
 * result under the RACE's session key during the grid phases, and when the
 * real reset came, the one-bad-poll bridge — keyed to that same race key, and
 * unbounded — held "CHEQUERED FLAG" over the entire race.
 *
 * Run: node scripts/test-finishlatch.js   (needs a built dist/)
 */

'use strict';

const path = require('node:path');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? `   [${detail}]` : ''));
  ok ? pass++ : fail++;
};

const { LmuRestProvider } = require(path.join(__dirname, '..', 'dist', 'telemetry', 'lmuRestProvider.js'));

// The provider is only constructed, never start()ed — trackFinish touches no
// timer, socket or shared memory, so the instance is just a home for the latch.
const p = new LmuRestProvider({ verbose: false });

/** Drive one poll's worth of the latch. `finished` is what the frame would carry. */
function step(finishStatus, sessionKey, preGreen, slotID = 7, position = 4) {
  const focus = { slotID, position, finishStatus };
  const rows = [{ slotId: slotID, position, classPosition: 2 }];
  return p.trackFinish(focus, rows, sessionKey, preGreen);
}

// Freeze and steer the clock so the 5 s bridge is testable without waiting.
const realNow = Date.now;
let clock = 1_000_000;
Date.now = () => clock;

try {
  console.log('\nqualifying — a real finish latches and holds');
  let r = step('FSTAT_NONE', 'monza|QUALIFY', false);
  check('running: not finished', r.finished === false);
  r = step('FSTAT_FINISHED', 'monza|QUALIFY', false);
  check('flag taken: finished', r.finished === true);
  check('position latched', r.position === 4, r.position);
  check('class position latched', r.classPosition === 2, r.classPosition);
  // The result must survive the cool-down lap: the sim keeps repeating
  // FINISHED, and live position churn must not move the latched numbers.
  clock += 60_000;
  r = step('FSTAT_FINISHED', 'monza|QUALIFY', false, 7, 9);
  check('cool-down: still finished', r.finished === true);
  check('latched position does not follow the live one', r.position === 4, r.position);

  console.log('\nthe transition — stale FINISHED on the race grid must not latch');
  // Race session loads; grid/formation phases; the feed still says FINISHED.
  clock += 30_000;
  r = step('FSTAT_FINISHED', 'monza|RACE1', true);
  check('pre-green stale verdict: not finished', r.finished === false);
  // The sim resets the status around the green. Nothing may be held.
  r = step('FSTAT_NONE', 'monza|RACE1', false);
  check('green, status reset: not finished', r.finished === false);
  // …and it must STAY not-finished for the whole race (the original bug).
  clock += 3_600_000;
  r = step('FSTAT_NONE', 'monza|RACE1', false);
  check('an hour in: still not finished', r.finished === false);

  console.log('\nthe race finish itself still works after all that');
  r = step('FSTAT_FINISHED', 'monza|RACE1', false, 7, 3);
  check('race flag taken: finished', r.finished === true);
  check('race position latched', r.position === 3, r.position);

  console.log('\nthe dropout bridge — held for moments, not forever');
  // One bad poll drops the verdict: the latch bridges it…
  clock += 1_000;
  r = step('FSTAT_NONE', 'monza|RACE1', false);
  check('1 s dropout: bridged', r.finished === true);
  // …corroboration re-arms the bridge…
  clock += 1_000;
  r = step('FSTAT_FINISHED', 'monza|RACE1', false);
  check('verdict back: finished', r.finished === true);
  // …but a verdict withdrawn for whole seconds is a restart, not a dropout.
  clock += 6_000;
  r = step('FSTAT_NONE', 'monza|RACE1', false);
  check('6 s withdrawn: latch dropped', r.finished === false);

  console.log('\na session restart mid-hold clears the latch by key');
  r = step('FSTAT_FINISHED', 'monza|RACE1', false);
  check('finished again', r.finished === true);
  r = step('FSTAT_NONE', 'monza|RACE2', false);
  check('new session key: not finished', r.finished === false);
} finally {
  Date.now = realNow;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
