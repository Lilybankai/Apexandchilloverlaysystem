/**
 * scripts/test-motion.js — the motion decode's sign conventions.
 * -----------------------------------------------------------------------------
 * Every value in the motion block depends on ISI's axis convention (X = right,
 * Y = up, Z = BACKWARD), and a flipped sign produces a readout that looks
 * entirely plausible and is backwards: a G-meter that throws the dot the wrong
 * way, an attitude horizon that dives when the car squats. None of that is
 * caught by a typecheck and none of it is obvious on a screenshot.
 *
 * So each case here builds a raw block for a physical situation that has ONE
 * correct answer — braking, a right-hand corner, a nose-up car — and asserts
 * the decoded sign. Run: node scripts/test-motion.js
 */

'use strict';

const { decodeMotion, motionConsistency, G } = require('../dist/telemetry/motion');

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

const v = (x, y, z) => ({ x, y, z });
/** Identity orientation: car level, nose along world -Z. */
const LEVEL = [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)];

/**
 * A raw block with everything neutral unless overridden.
 *
 * Vertical acceleration is ZERO at rest, not 1 g: verified live, LMU cancels
 * gravity against the normal force, so a car on flat ground reads ~0.00 at any
 * speed. This fixture encodes the sim's real behaviour, not the accelerometer
 * convention it is easy to assume.
 */
function raw(over) {
  return Object.assign(
    {
      accel: v(0, 0, 0), // level, flat ground, gravity already cancelled
      rot: v(0, 0, 0),
      vel: v(0, 0, 0),
      ori: LEVEL,
    },
    over,
  );
}

console.log('\n1) G-forces — the axis flip that catches everyone');

{
  // Forward is -Z, so accelerating forward is a NEGATIVE z acceleration — and
  // longitudinal is passed through unflipped, so acceleration stays negative.
  const m = decodeMotion(raw({ accel: v(0, 0, -0.8 * G) }));
  check('accelerating reads NEGATIVE longitudinal', m.lonG < 0, m.lonG);
}
{
  // Live-captured: braking at 0.56 pedal gave raw az = +1.28 g while the car
  // demonstrably slowed (207 -> 198 kph). Braking is reported POSITIVE by
  // deliberate display convention, so this passes through unchanged.
  const m = decodeMotion(raw({ accel: v(0, 0, 1.28 * G) }));
  check('braking reads POSITIVE longitudinal', m.lonG > 0, m.lonG);
  check('live braking sample decodes to +1.28 g', Math.abs(m.lonG - 1.28) < 0.01, m.lonG);
}
{
  // The convention is mixed on purpose and easy to "tidy" into being wrong, so
  // pin it: in a right-hander under brakes, BOTH must read positive.
  const m = decodeMotion(raw({ accel: v(2 * G, 0, 1.2 * G) }));
  check('braking into a right-hander: both channels positive',
    m.latG > 0 && m.lonG > 0, `lat ${m.latG} lon ${m.lonG}`);
}
{
  // A right-hand corner accelerates the car toward its right = +X.
  const m = decodeMotion(raw({ accel: v(2 * G, 0, 0) }));
  check('right-hand corner reads POSITIVE lateral', m.latG > 0, m.latG);
}
{
  const m = decodeMotion(raw({ accel: v(-2 * G, 0, 0) }));
  check('left-hand corner reads NEGATIVE lateral', m.latG < 0, m.latG);
}
{
  // Gravity is cancelled by the normal force in what LMU publishes, so this is
  // the REAL resting value — confirmed on track at 200 kph (vert = 0.00 +/- 0.06).
  const m = decodeMotion(raw({}));
  check('flat ground reads ~0 g vertical, not 1 g', Math.abs(m.vertG) < 0.01, m.vertG);
}
{
  const m = decodeMotion(raw({ accel: v(0, 1.4 * G, 0) }));
  check('a compression reads POSITIVE vertical', m.vertG > 0, m.vertG);
}
{
  const m = decodeMotion(raw({ accel: v(0, -1.4 * G, 0) }));
  check('a crest reads NEGATIVE vertical', m.vertG < 0, m.vertG);
}

console.log('\n2) Rotation rates');

{
  // Rotation about +Y carries +Z (backward) toward +X (right) — so a positive
  // raw rate swings the TAIL right and the nose LEFT.
  const m = decodeMotion(raw({ rot: v(0, 0.5, 0) }));
  check('raw +Y yaw reads as nose LEFT', m.yawRate < 0, m.yawRate);
}
{
  const m = decodeMotion(raw({ rot: v(0, -0.5, 0) }));
  check('raw -Y yaw reads as nose RIGHT', m.yawRate > 0, m.yawRate);
}

console.log('\n3) Attitude, from the orientation matrix');

{
  // Nose pitched up: the car's forward axis (local -Z) gains world +Y.
  // Column 2 of the matrix is the local Z axis in world coords, so a forward
  // axis tilted up means ori[1].z is negative.
  const noseUp = [v(1, 0, 0), v(0, 0.966, -0.259), v(0, 0.259, 0.966)];
  const m = decodeMotion(raw({ ori: noseUp }));
  check('nose up reads POSITIVE pitch', m.pitch > 0, m.pitch.toFixed(1) + '°');
  check('nose up is ~15 degrees', Math.abs(m.pitch - 15) < 0.5, m.pitch.toFixed(1) + '°');
}
{
  const noseDown = [v(1, 0, 0), v(0, 0.966, 0.259), v(0, -0.259, 0.966)];
  const m = decodeMotion(raw({ ori: noseDown }));
  check('nose down reads NEGATIVE pitch', m.pitch < 0, m.pitch.toFixed(1) + '°');
}
{
  // Right side up: the car's right axis (local +X) gains world +Y. Column 0 is
  // the local X axis in world coords, so ori[1].x is positive.
  const rightUp = [v(0.966, 0, 0), v(0.259, 0.966, 0), v(0, 0, 1)];
  const m = decodeMotion(raw({ ori: rightUp }));
  check('right side up reads POSITIVE roll', m.roll > 0, m.roll.toFixed(1) + '°');
}
{
  const rightDown = [v(0.966, 0, 0), v(-0.259, 0.966, 0), v(0, 0, 1)];
  const m = decodeMotion(raw({ ori: rightDown }));
  check('right side down reads NEGATIVE roll', m.roll < 0, m.roll.toFixed(1) + '°');
}
{
  const m = decodeMotion(raw({}));
  check('a level car reads zero pitch and roll', m.pitch === 0 && m.roll === 0);
}

console.log('\n4) Slip angle');

{
  // Travelling straight ahead at 40 m/s: forward is -Z.
  const m = decodeMotion(raw({ vel: v(0, 0, -40) }));
  check('straight-line travel reads zero slip', Math.abs(m.slipAngle) < 0.01, m.slipAngle);
}
{
  // Same forward speed, plus velocity to the car's right = sliding right.
  const m = decodeMotion(raw({ vel: v(4, 0, -40) }));
  check('velocity to the right reads POSITIVE slip', m.slipAngle > 0, m.slipAngle);
  check('4 over 40 is ~5.7 degrees', Math.abs(m.slipAngle - 5.71) < 0.1, m.slipAngle);
}
{
  const m = decodeMotion(raw({ vel: v(-4, 0, -40) }));
  check('velocity to the left reads NEGATIVE slip', m.slipAngle < 0, m.slipAngle);
}
{
  // Below walking pace the direction of travel is noise, not a slip angle.
  const m = decodeMotion(raw({ vel: v(0.4, 0, -0.3) }));
  check('a near-stationary car reports UNKNOWN slip, not a number', m.slipAngle === -1, m.slipAngle);
}
{
  // Reversing must not read as a 180-degree slide: the magnitude is what
  // matters, so the forward component is taken as a magnitude.
  const m = decodeMotion(raw({ vel: v(0, 0, 12) }));
  check('reversing does not read as a huge slip', Math.abs(m.slipAngle) < 1, m.slipAngle);
}

console.log('\n5) The lat-G / yaw-rate identity — what pins the signs');

{
  // Steady right-hander at 40 m/s, yawing right at 0.5 rad/s. The physics says
  // latAccel = v * yawRate = 20 m/s^2 = 2.04 g, toward the right (positive).
  // Raw: nose-right yaw is -Y, and rightward acceleration is +X.
  const m = decodeMotion(
    raw({ accel: v(20, G, 0), rot: v(0, -0.5, 0), vel: v(0, 0, -40) }),
  );
  check('steady corner: lateral and yaw agree', Math.abs(motionConsistency(m)) < 0.05,
    motionConsistency(m));
}
{
  // The same corner with the lateral sign inverted — what a wrong offset or a
  // flipped axis would produce. The residual must blow up, otherwise this check
  // could never catch a real inversion.
  const m = decodeMotion(
    raw({ accel: v(-20, G, 0), rot: v(0, -0.5, 0), vel: v(0, 0, -40) }),
  );
  check('an inverted lateral is caught', Math.abs(motionConsistency(m)) > 3.5,
    motionConsistency(m));
}
{
  const m = decodeMotion(raw({ vel: v(0, 0, -1) }));
  check('below the speed floor the identity reports UNKNOWN', motionConsistency(m) === -1);
}

console.log('\n6) Plausibility guards — a torn read must not render');

{
  check('NaN anywhere rejects the block', decodeMotion(raw({ accel: v(NaN, 0, 0) })) === null);
}
{
  check('an absurd G rejects the block', decodeMotion(raw({ accel: v(9e9, 0, 0) })) === null);
}
{
  check('an absurd rotation rejects the block', decodeMotion(raw({ rot: v(0, 500, 0) })) === null);
}
{
  check('a sane block is accepted', decodeMotion(raw({})) !== null);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
