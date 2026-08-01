/**
 * scripts/test-tracklimits.js — the penalty tracker's edges.
 * -----------------------------------------------------------------------------
 * This file used to test a geometric excursion detector — hysteresis on the
 * threshold, a minimum duration, the pit lane's own geometry, a depth-based
 * score. All of it was scaffolding for a points total we could not read, and it
 * went when the real one arrived: `scripts/test-tracelimits.js` now covers the
 * sim's own charges, read from its trace log.
 *
 * What is left here is the part that never involved geometry. `mNumPenalties` is
 * a LEVEL, and both facts the widget needs from it are EDGES: a penalty appearing
 * ("you have one"), and the count coming back down ("you served it"). Those need
 * the previous poll to see, which is the whole reason this is a stateful class
 * and not a function — and stateful edge detection is exactly where the bugs are.
 *
 * Run: node scripts/test-tracklimits.js
 */

'use strict';

const {
  TrackLimitsTracker,
  DEFAULT_POINTS_LIMIT,
} = require('../dist/telemetry/trackLimits');

/** Sentinel for unknown numerics — mirrors UNKNOWN_VALUE in types.ts. */
const UNKNOWN = -1;

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

/**
 * A little harness that walks a tracker forward in 50 ms steps, which is about
 * the rate a 30 Hz feed delivers.
 */
function rig(over) {
  const t = new TrackLimitsTracker();
  let now = 1000;
  let last = null;
  const step = (penalties, opts) => {
    now += (opts && opts.dtMs) || 50;
    last = t.update({
      penalties,
      sessionKey: 'test',
      nowMs: now,
      ...over,
      ...opts,
    });
    return last;
  };
  /** Hold a penalty count for `ms` milliseconds. */
  const hold = (penalties, ms, opts) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) step(penalties, opts);
    return last;
  };
  return { step, hold, get state() { return last; }, get nowMs() { return now; } };
}

console.log('\n1) The sim\'s penalty count, straight through');

{
  const r = rig();
  r.hold(0, 500);
  check('a clean sheet reports zero', r.state.penalties === 0, r.state.penalties);
  check('…and no penalty has landed', r.state.msSincePenalty === UNKNOWN, r.state.msSincePenalty);
  check('…nor been served', r.state.msSinceServed === UNKNOWN, r.state.msSinceServed);

  r.step(1);
  check('a penalty appearing is reported', r.state.penalties === 1, r.state.penalties);
  check('…and stamped as fresh', r.state.msSincePenalty === 0, r.state.msSincePenalty);

  r.hold(1, 1000);
  check('…and the stamp ages', r.state.msSincePenalty >= 1000, r.state.msSincePenalty);
  check('…while the count stands', r.state.penalties === 1, r.state.penalties);
}

{
  // The one thing that confirms a drive-through was served correctly. Without
  // it a driver leaves the lane not knowing whether it took.
  const r = rig();
  r.hold(1, 500);
  r.step(0);
  check('the count coming down is a discharge', r.state.msSinceServed === 0, r.state.msSinceServed);
  check('…and the count follows the sim', r.state.penalties === 0, r.state.penalties);
  check(
    '…and is not also read as a new penalty',
    r.state.msSincePenalty === UNKNOWN,
    r.state.msSincePenalty,
  );
}

{
  // Two at once — the sim can hand out a second before the first is served.
  // The stamp must move to the NEWER one, or the widget announces the second
  // penalty for whatever is left of the first one's four seconds and then goes
  // quiet, which reads as the second never having happened.
  const r = rig();
  r.hold(0, 100);
  r.step(1);
  r.hold(1, 800);
  const first = r.state.msSincePenalty;
  r.step(2);
  check('a second penalty re-stamps', r.state.msSincePenalty === 0, r.state.msSincePenalty);
  check('…rather than keeping the first stamp', first >= 800, first);
  check('…and reports both', r.state.penalties === 2, r.state.penalties);
}

console.log('\n2) Unknown is not zero');

{
  // No penalty channel at all (spectating, no shared memory). A confident zero
  // here would tell a driver they are clean when nothing has been checked.
  const r = rig();
  r.hold(UNKNOWN, 300);
  check('an unreadable count returns no block at all', r.state === null);

  // …and once it becomes readable, the first value seen is a BASELINE, not an
  // event: an overlay started with a penalty already outstanding must not
  // announce it as if it just landed.
  r.step(2);
  check('the first readable count is reported', r.state && r.state.penalties === 2);
  check(
    '…but not announced as fresh',
    r.state && r.state.msSincePenalty === UNKNOWN,
    r.state && r.state.msSincePenalty,
  );
}

console.log('\n3) Sessions');

{
  const r = rig();
  r.hold(1, 500);
  check('a penalty is on the board', r.state.penalties === 1);

  // Qualifying's penalties are not the race's.
  r.step(0, { sessionKey: 'next' });
  check('a new session resets the stamps', r.state.msSincePenalty === UNKNOWN);
  check('…and the served stamp with it', r.state.msSinceServed === UNKNOWN);
  check('…and the drop is not read as a discharge', r.state.penalties === 0);
}

console.log('\n4) The allowance');

{
  const r = rig();
  r.hold(0, 200);
  check(
    'with no session figure, the default allowance stands',
    r.state.pointsLimit === DEFAULT_POINTS_LIMIT,
    r.state.pointsLimit,
  );

  r.step(0, { pointsLimit: 5 });
  check('the session\'s own allowance wins', r.state.pointsLimit === 5, r.state.pointsLimit);

  r.step(0, { pointsLimit: 0 });
  check(
    'a nonsense allowance is ignored, not obeyed',
    r.state.pointsLimit === DEFAULT_POINTS_LIMIT,
    r.state.pointsLimit,
  );
}

{
  // The points themselves are not this tracker's to know — they are merged in by
  // the provider that reads the sim's trace log. Publishing a zero here would
  // put "full allowance" on the widget for a driver who has spent theirs.
  const r = rig();
  r.hold(0, 200);
  check('points come back unknown', r.state.points === UNKNOWN, r.state.points);
  check('…with no charges', Array.isArray(r.state.charges) && r.state.charges.length === 0);
  check('…and no charge stamp', r.state.msSinceCharge === UNKNOWN, r.state.msSinceCharge);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
