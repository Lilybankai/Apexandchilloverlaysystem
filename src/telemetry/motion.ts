/**
 * @file src/telemetry/motion.ts
 * @module telemetry/motion
 *
 * Turns the sim's raw **motion block** (acceleration, rotation rate, velocity,
 * orientation matrix) into the G-force / rotation / attitude channels the
 * motion widget renders.
 *
 * ## Why this is its own module
 * Every value here depends on ISI's axis convention, and getting a sign wrong
 * produces a readout that looks plausible and is backwards — a G-meter that
 * throws the dot the wrong way in a corner is worse than no G-meter. Both
 * providers (LMU and rF2) read the same struct, so the convention is applied
 * ONCE, here, and is unit-testable without a sim running.
 *
 * ## The axis convention
 * ISI local vehicle coords are **X = right, Y = up, Z = BACKWARD**. The
 * backward Z is the trap: it is why {@link lmuLocalCar} reads speed as
 * `abs(mLocalVel.z)`, and it means forward acceleration arrives as a NEGATIVE
 * z. Everything below is normalised to a driver-facing convention instead:
 *
 *   - `latG`  positive = acceleration toward the car's RIGHT (a right-hander)
 *   - `lonG`  positive = BRAKING, negative = accelerating (a display convention
 *             chosen on track, not the physics sign — see the note at the
 *             assignment for why this one is mixed with `latG`)
 *   - `vertG` positive = up, and **zero-centred, not 1 g**. Verified live: LMU's
 *             mLocalAccel is net acceleration with gravity already cancelled by
 *             the normal force, so a car on flat ground reads ~0.00 at any
 *             speed (measured: ±0.06 at 200 kph on a straight). It is a
 *             deviation channel — positive over a compression, negative over a
 *             crest or airborne. An earlier version of this file claimed ~1 g
 *             at rest, which the first live probe disproved.
 *   - `yawRate` positive = nose swinging RIGHT
 *   - `pitch` positive = nose UP
 *   - `roll`  positive = right side UP
 *   - `slipAngle` positive = travelling to the RIGHT of where the nose points
 *
 * ## The consistency check that pins the signs
 * Lateral acceleration and yaw rate are not independent: in steady cornering
 * `latAccel ≈ forwardSpeed × yawRate` when both are measured toward the same
 * side. {@link motionConsistency} evaluates that residual, which is what lets
 * the sign convention be *verified* against real driving rather than asserted —
 * see `scripts/probe-lmu-motion.js` and `scripts/test-motion.js`.
 */

import { UNKNOWN_VALUE } from './types';
import type { MotionState } from './types';

/** Standard gravity, m/s². */
export const G = 9.80665;

/** A raw 3-vector as it sits in the sim's struct, in ISI local coords. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The raw motion block, straight out of shared memory (no sign handling). */
export interface RawMotion {
  /** `mLocalAccel`, m/s², local coords. */
  accel: Vec3;
  /** `mLocalRot`, rad/s, local coords. */
  rot: Vec3;
  /** `mLocalVel`, m/s, local coords. */
  vel: Vec3;
  /** `mOri[3]` — the ROWS of the local→world orientation matrix. */
  ori: [Vec3, Vec3, Vec3];
}

/**
 * Below this forward speed the direction-of-travel is dominated by noise, so
 * slip angle is meaningless (a stationary car has no direction of travel at
 * all, and atan2 on jitter swings wildly). 3 m/s ≈ 11 km/h — walking pace.
 */
const MIN_SLIP_SPEED_MS = 3;

/** Guard for a torn/garbage read: no road car pulls 20 g or spins at 20 rad/s. */
const MAX_PLAUSIBLE_G = 20;
const MAX_PLAUSIBLE_RAD_S = 20;

function finite(v: number): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function vecOk(v: Vec3, limit: number): boolean {
  return (
    finite(v.x) &&
    finite(v.y) &&
    finite(v.z) &&
    Math.abs(v.x) <= limit &&
    Math.abs(v.y) <= limit &&
    Math.abs(v.z) <= limit
  );
}

const RAD_TO_DEG = 180 / Math.PI;

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Normalises a raw motion block into {@link MotionState}, or returns `null`
 * when the block fails its plausibility guards (sim not running, torn read, or
 * an offset that has moved in a future build — all of which are better shown as
 * "no data" than as a confidently wrong number).
 */
export function decodeMotion(raw: RawMotion): MotionState | null {
  const { accel, rot, vel, ori } = raw;
  if (!vecOk(accel, MAX_PLAUSIBLE_G * G)) return null;
  if (!vecOk(rot, MAX_PLAUSIBLE_RAD_S)) return null;
  if (!vecOk(vel, 200)) return null;

  // --- G-forces -----------------------------------------------------------
  // x is already "toward the right", which puts the G dot on the same side as
  // the corner you are turning into.
  const latG = accel.x / G;
  // Longitudinal is passed through UNFLIPPED, so braking is POSITIVE.
  //
  // This is a display convention, not a physics one — the raw +Z is genuinely
  // backward, so a physicist's g-g diagram would put braking negative and the
  // dot below the origin. On track that read wrong: braking is the load you
  // feel thrown into, and every driver reading this expects the dot to move
  // FORWARD (up) under brakes. Confirmed against real laps.
  //
  // Note the pair is deliberately mixed: lateral follows the direction the
  // acceleration points, longitudinal follows the direction the driver is
  // thrown. Purity would mean flipping lateral too, which would put the dot
  // opposite the corner and was not what the eye wanted.
  const lonG = accel.z / G;
  const vertG = accel.y / G;

  // --- Rotation rates -----------------------------------------------------
  // Rotation about +Y (up) carries +Z toward +X by the right-hand rule. +Z is
  // BACKWARD, so a positive rate swings the tail right and therefore the NOSE
  // LEFT — which is why yaw is negated to mean "nose right".
  const yawRate = -rot.y;
  // Pitch about the right axis, roll about the forward axis. The forward axis
  // is -Z, so the roll rate is negated for the same reason as yaw.
  const pitchRate = rot.x;
  const rollRate = -rot.z;

  // --- Attitude, from the orientation matrix ------------------------------
  // mOri holds the ROWS of the local→world matrix, so a local axis in world
  // coords is a COLUMN of it. Local -Z is forward; local +X is right.
  const fwdY = -ori[1].z; // world-up component of the car's forward axis
  const rightY = ori[1].x; // world-up component of the car's right axis
  const fwdX = -ori[0].z;
  const fwdZ = -ori[2].z;
  const pitch = Math.asin(clampUnit(fwdY)) * RAD_TO_DEG;
  const roll = Math.asin(clampUnit(rightY)) * RAD_TO_DEG;
  const heading = Math.atan2(fwdX, fwdZ) * RAD_TO_DEG;

  // --- Slip angle ---------------------------------------------------------
  // The angle between where the nose points and where the car is actually
  // going. Derived from the velocity vector alone, so unlike an
  // understeer/oversteer estimate it needs no wheelbase, steering ratio or
  // per-car calibration — it is the same number in any car.
  const forwardMs = -vel.z;
  const speedMs = Math.hypot(vel.x, vel.z);
  const slipAngle =
    speedMs >= MIN_SLIP_SPEED_MS
      ? Math.atan2(vel.x, Math.abs(forwardMs)) * RAD_TO_DEG
      : UNKNOWN_VALUE;

  return {
    latG: round2(latG),
    lonG: round2(lonG),
    vertG: round2(vertG),
    yawRate: round2(yawRate),
    pitchRate: round2(pitchRate),
    rollRate: round2(rollRate),
    pitch: round2(pitch),
    roll: round2(roll),
    heading: round2(heading),
    slipAngle: slipAngle === UNKNOWN_VALUE ? UNKNOWN_VALUE : round2(slipAngle),
    speedMs: round2(speedMs),
  };
}

/**
 * Residual of the steady-state identity `latAccel = forwardSpeed × yawRate`,
 * in g. Near zero means the lateral-G and yaw-rate signs agree; a residual of
 * roughly *twice* the lateral G means one of them is inverted.
 *
 * This is the check that makes the sign convention verifiable instead of
 * asserted. It only holds in steady cornering — during a transient (turn-in,
 * a snap of oversteer) the two genuinely diverge, so callers must sample it
 * over a sustained corner, not a single frame.
 *
 * Returns {@link UNKNOWN_VALUE} below the slip-speed floor, where yaw rate is
 * noise and the identity says nothing.
 */
export function motionConsistency(m: MotionState): number {
  if (m.speedMs < MIN_SLIP_SPEED_MS) return UNKNOWN_VALUE;
  const expectedLatG = (m.speedMs * m.yawRate) / G;
  return round2(m.latG - expectedLatG);
}
