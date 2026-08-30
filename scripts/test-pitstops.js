/**
 * scripts/test-pitstops.js — counting stops the sim cannot count.
 * -----------------------------------------------------------------------------
 * LMU's `pitstops` resets. The whole reason this counter exists is a live probe
 * at Daytona (2026-08-30) where the leaders read 0 stops on lap 175 and our own
 * car went 9 -> 0 with the same driver still at the wheel.
 *
 * The case that decides whether the replacement is any good is the flutter in
 * the middle of a real stop, captured end to end on car #97 in that session:
 *
 *   ENTERING -> STOPPED -> NONE -> STOPPED -> ... -> EXITING
 *
 * `pitting` stays true across all of it, so one visit must produce exactly ONE
 * stop. A naive rising-edge count on `pitState` alone would say two.
 *
 * Run: node scripts/test-pitstops.js
 */

'use strict';

const { PitStopCounter, REARM_SAMPLES } = require('../dist/telemetry/pitStopCounter.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? `   [${detail}]` : ''));
  ok ? pass++ : fail++;
};

const SESSION = 'daytona|race';
/** Feed one car a run of on-pit-lane booleans; return its count at the end. */
function run(lane, { simStops, sessionKey = SESSION, counter } = {}) {
  const c = counter || new PitStopCounter();
  let last = 0;
  for (const onPitLane of lane) {
    last = c.update([{ slotId: 7, onPitLane, simStops }], sessionKey).get(7);
  }
  return last;
}
/** n samples of the same value — the poll runs many times a second. */
const hold = (v, n) => Array(n).fill(v);
const OUT = hold(false, REARM_SAMPLES + 3);

console.log('\nthe basics');
check('a car that never pits has no stops', run(hold(false, 40)) === 0);
check('one visit is one stop', run([...OUT, ...hold(true, 20), ...OUT]) === 1);
check('two visits are two stops', run([...OUT, ...hold(true, 20), ...OUT, ...hold(true, 20), ...OUT]) === 2);
check('a car still in the lane has its stop counted on arrival', run([...OUT, ...hold(true, 5)]) === 1);

console.log('\nthe real stop, flutter and all (#97, 2026-08-30)');
// pitting stays true throughout, so onPitLane never drops mid-visit.
const realStop = [...OUT, ...hold(true, 8), ...hold(true, 10), ...hold(true, 3), ...hold(true, 12), ...OUT];
check('STOPPED -> NONE -> STOPPED counts once', run(realStop) === 1, 'not two');

console.log('\na dropped sample must not invent a stop');
for (let gap = 1; gap < REARM_SAMPLES; gap++) {
  const flicker = [...OUT, ...hold(true, 10), ...hold(false, gap), ...hold(true, 10), ...OUT];
  check(`${gap} clear sample${gap > 1 ? 's' : ''} mid-visit is still one stop`, run(flicker) === 1);
}
check(
  `${REARM_SAMPLES} clear samples is a genuine out-lap and back in`,
  run([...OUT, ...hold(true, 10), ...hold(false, REARM_SAMPLES), ...hold(true, 10)]) === 2,
);

console.log('\njoining mid-race');
check('the sim\'s count seeds a car seen for the first time', run(hold(false, 5), { simStops: 3 }) === 3);
check('and our own edges add to it', run([...hold(false, 5), ...hold(true, 10), ...OUT], { simStops: 3 }) === 4);
check('a car first seen IN the lane is mid-visit, not arriving', run([...hold(true, 10), ...OUT], { simStops: 2 }) === 2);
check('a nonsense seed is ignored', run(hold(false, 5), { simStops: -1 }) === 0);
check('no seed means zero', run(hold(false, 5)) === 0);

console.log('\nthe count only ever goes up (the bug this replaces)');
const c = new PitStopCounter();
const seen = [];
// The sim's own field resets to 0 half way through; ours must not follow it.
for (const [onPitLane, simStops] of [
  [false, 9], [true, 9], [false, 9], [false, 0], [false, 0], [false, 0],
  [false, 0], [false, 0], [true, 0], [false, 0], [false, 0], [false, 0],
  [false, 0], [false, 0], [false, 0],
]) {
  seen.push(c.update([{ slotId: 7, onPitLane, simStops }], SESSION).get(7));
}
check('a resetting sim field does not reset ours', seen.every((v, i) => i === 0 || v >= seen[i - 1]), seen.join(' '));
check('and both entries were counted', seen[seen.length - 1] === 11, `9 seeded + 2 seen`);

console.log('\nhousekeeping');
const s = new PitStopCounter();
s.update([{ slotId: 1, onPitLane: true }], 'a');
check('a new session starts from nothing', s.update([{ slotId: 1, onPitLane: true }], 'b').get(1) === 0);
s.reset();
check('reset clears the session key too', s.update([{ slotId: 1, onPitLane: false }], 'b').get(1) === 0);
const many = new PitStopCounter();
for (let i = 0; i < 40; i++) many.update([{ slotId: i, onPitLane: false }], SESSION);
many.update([{ slotId: 99, onPitLane: false }], SESSION);
check('cars that leave are forgotten', many.update([{ slotId: 99, onPitLane: false }], SESSION).size === 1);

console.log(`\ntest-pitstops: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
