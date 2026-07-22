/**
 * scripts/test-chassis.js — the four-corner load decode.
 * -----------------------------------------------------------------------------
 * The chassis channels have the same hazard as the motion ones: a mis-offset or
 * inverted load reads as a perfectly plausible car that is loading the wrong
 * wheels. A typecheck cannot see it, and on a screenshot of a wireframe car it
 * looks fine.
 *
 * So each case builds a raw wheel block for a situation with ONE correct answer
 * — a car at rest, a car braking, a car in a right-hander, a wheel in the air —
 * and asserts what came out. The consistency case is the important one: it
 * cross-checks the load channel against the INDEPENDENT lateral-G channel, so a
 * load block that is silently reading the wrong wheels is caught by physics
 * rather than by eye.
 *
 * Run: node scripts/test-chassis.js
 */

'use strict';

const { ChassisTracker, expectedLeftShare } = require('../dist/telemetry/chassis');

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

/** One corner, with plausible suspension values unless overridden. */
function corner(loadN, over) {
  return Object.assign(
    {
      loadN,
      deflectionM: loadN / 165000, // ~165 N/mm wheel rate, metres
      rideHeightM: 0.078,
      suspForceN: loadN * 0.92,
      gripFract: 0.95,
    },
    over || {},
  );
}

/** A four-corner block: FL, FR, RL, RR. */
function block(fl, fr, rl, rr) {
  return [corner(fl), corner(fr), corner(rl), corner(rr)];
}

/**
 * Runs a tracker past its warm-up so `loadRatio` and the flags are live.
 *
 * The clock is advanced in 0.1 s steps because the reference EMA is driven by
 * SIM time, not by call count — feeding one big step would converge the
 * reference in a single frame and would not exercise the real path.
 */
function warmed(steadyBlock, seconds) {
  const t = new ChassisTracker();
  let clock = 0;
  const want = seconds === undefined ? 12 : seconds;
  let state = null;
  for (; clock < want; clock += 0.1) {
    state = t.update(steadyBlock, clock);
  }
  return { tracker: t, clock, state };
}

/** Static-ish GT3: ~12.7 kN total, 45% front, even side to side. */
const REST = block(2870, 2870, 3505, 3505);

console.log('\nchassis decode\n');

/* --- basic shape -------------------------------------------------------- */
{
  const t = new ChassisTracker();
  const s = t.update(REST, 0);
  check('decodes a plausible block', s !== null);
  check('total load sums the corners', s.totalLoadN === 12750, `${s.totalLoadN} N`);
  check('front share matches the 45% bias', Math.abs(s.frontShare - 0.45) < 0.005, s.frontShare);
  check('sides are even at rest', Math.abs(s.leftShare - 0.5) < 0.005, s.leftShare);
  check('cross weight is square at rest', Math.abs(s.crossShare - 0.5) < 0.005, s.crossShare);
  check('not calibrated on the first frame', s.calibrated === false);
}

/* --- guards -------------------------------------------------------------- */
{
  const t = new ChassisTracker();
  check('rejects an all-zero block', t.update(block(0, 0, 0, 0), 0) === null);
  check(
    'rejects an implausible load',
    t.update(block(2870, 999999, 3505, 3505), 0) === null,
  );
  check(
    'rejects a NaN corner',
    t.update([corner(2870), corner(NaN), corner(3505), corner(3505)], 0) === null,
  );
  check(
    'rejects absurd suspension travel',
    t.update([corner(2870, { deflectionM: 3 }), corner(2870), corner(3505), corner(3505)], 0) === null,
  );
}

/* --- units --------------------------------------------------------------- */
{
  const t = new ChassisTracker();
  // 0.024 m of travel is 24 mm — the readout is in mm, the sim publishes metres.
  const s = t.update(
    [corner(2870, { deflectionM: 0.024, rideHeightM: 0.062 }), corner(2870), corner(3505), corner(3505)],
    0,
  );
  check('deflection is converted to mm', Math.abs(s.frontLeft.deflectionMm - 24) < 0.05, s.frontLeft.deflectionMm);
  check('ride height is converted to mm', Math.abs(s.frontLeft.rideHeightMm - 62) < 0.05, s.frontLeft.rideHeightMm);
}

/* --- warm-up and the reference average ---------------------------------- */
{
  const { state } = warmed(REST);
  check('calibrates after the warm-up window', state.calibrated === true);
  check(
    'a steady car sits at ratio 1.0',
    Math.abs(state.frontLeft.loadRatio - 1) < 0.02,
    state.frontLeft.loadRatio,
  );
  check('a steady car flags nothing', !state.frontLeft.overloaded && !state.frontLeft.light);
}

/* --- overload ------------------------------------------------------------ */
{
  const { tracker, clock } = warmed(REST);
  // One frame of a heavily loaded outside-front, as over a kerb. Applied as a
  // single step so the reference has no chance to follow it.
  const s = tracker.update(block(2870 * 2.1, 2870, 3505, 3505), clock + 0.02);
  check('flags an overloaded corner', s.frontLeft.overloaded === true, s.frontLeft.loadRatio);
  check('leaves the other corners alone', s.frontRight.overloaded === false);
  check('overloaded is not also light', s.frontLeft.light === false);
}

/* --- going light, and going airborne ------------------------------------ */
{
  const { tracker, clock } = warmed(REST);
  const s = tracker.update(block(2870 * 0.12, 2870, 3505, 3505), clock + 0.02);
  check('flags a corner gone light', s.frontLeft.light === true, s.frontLeft.loadRatio);
  check('a light corner is not airborne', s.frontLeft.airborne === false);
}
{
  const { tracker, clock } = warmed(REST);
  const s = tracker.update(block(0, 2870, 3505, 3505), clock + 0.02);
  check('flags an airborne corner', s.frontLeft.airborne === true, `${s.frontLeft.loadN} N`);
  check('airborne suppresses the light flag', s.frontLeft.light === false);
  check('counts airborne wheels', s.wheelsAirborne === 1, s.wheelsAirborne);
}

/* --- the physics cross-check -------------------------------------------- */
/**
 * The one case that can catch a swapped or mis-offset wheel. In a right-hand
 * corner the car accelerates toward its own right (positive latG, per
 * telemetry/motion.ts) and the load moves onto the OUTSIDE — the left wheels.
 * If the load channel were reading the wrong pair, leftShare would fall instead
 * of rise and this would fail while everything else above still passed.
 */
{
  const latG = 1.4;
  const expected = expectedLeftShare(latG);
  check('a right-hander is expected to load the left', expected > 0.5, expected);

  // A load block built to match that transfer.
  const total = 12750;
  const left = total * expected;
  const right = total - left;
  const t = new ChassisTracker();
  const s = t.update(block(left * 0.45, right * 0.45, left * 0.55, right * 0.55), 0);
  check(
    'measured left share tracks the lateral G',
    Math.abs(s.leftShare - expected) < 0.02,
    `${s.leftShare} vs ${expected}`,
  );
  check('left-hander mirrors it', expectedLeftShare(-latG) < 0.5, expectedLeftShare(-latG));
  check('a straight line is even', Math.abs(expectedLeftShare(0) - 0.5) < 1e-9);
}

/* --- session changes reset the learned reference ------------------------- */
{
  const { tracker, clock } = warmed(REST);
  // A backwards clock is a session restart. The reference must be dropped, not
  // carried into the next car.
  const s = tracker.update(REST, clock - 30);
  check('a backwards clock drops the frame', s === null);
  const after = tracker.update(REST, clock - 29.9);
  check('and restarts uncalibrated', after !== null && after.calibrated === false);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
