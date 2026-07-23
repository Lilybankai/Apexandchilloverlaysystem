/**
 * @file src/telemetry/radar.ts
 * @module telemetry/radar
 *
 * Turns the sim's **world positions** for every car plus the player's
 * **orientation matrix** into the car-relative blips the radar widget draws.
 *
 * ## Why this is its own module
 * Exactly like {@link module:telemetry/motion}, every value here depends on
 * ISI's axis convention, and a flipped sign produces a radar that puts a car
 * passing on your left as a blip on your right — plausible-looking and
 * dangerously wrong. Both live providers (rF2 and LMU) read the same struct, so
 * the projection is applied ONCE, here, and is unit-testable without a sim
 * running (see `scripts/test-radar.js`).
 *
 * ## The projection
 * The sim gives each car an absolute world position (`mPos`) and the player an
 * orientation matrix (`mOri`, the ROWS of the local→world matrix — see
 * {@link module:telemetry/motion} for the same block feeding the attitude
 * readout). There is no "car N is X metres to my left" channel; the radar has to
 * compute it:
 *
 *   1. `delta = other.pos − player.pos`  (a vector in WORLD axes)
 *   2. project `delta` onto the player's own **right** and **forward** axes,
 *      expressed in world coords, to get lateral / longitudinal offsets.
 *
 * A local axis in world coords is a COLUMN of the orientation matrix (the matrix
 * holds rows). Local `−Z` is forward and local `+Y` is up (ISI's Z points
 * BACKWARD). The driver's **right** is `up × forward` — and the cross-product
 * order matters: ISI / gMotor world axes are **left-handed**, so `up × forward`
 * (not `forward × up`) is the rightward direction. This was verified against a
 * live LMU session: an earlier build used `column 0` directly, which is
 * `forward × up`, and the radar came out **mirrored** — a car passing on the
 * right showed on the left. So:
 *
 *   - forwardWorld = −column 2 = −(ori[0].z, ori[1].z, ori[2].z)
 *   - upWorld      =  column 1 =  (ori[0].y, ori[1].y, ori[2].y)
 *   - rightWorld   = upWorld × forwardWorld
 *   - lateral      = dot(delta, rightWorld)    // + = to the player's RIGHT
 *   - longitudinal = dot(delta, forwardWorld)  // + = AHEAD of the player
 *
 * The result is 2-D on the car's ground plane; the vertical component of the
 * delta is folded into the two axes by the dot products and is otherwise
 * ignored, which is what keeps a car on a bridge overhead from showing as a
 * phantom alongside.
 */

import { UNKNOWN_VALUE } from './types';
import type { RadarBlip } from './types';
import type { Vec3 } from './motion';

/**
 * Maximum planar distance (metres) at which a car is kept as a blip. Cars
 * further than this are irrelevant to a proximity radar, and dropping them here
 * keeps the broadcast payload small regardless of field size. The widget shows a
 * configurable range *within* this bound.
 */
export const RADAR_MAX_RANGE_M = 150;

/**
 * Longitudinal overlap (metres, each way) within which a car counts as
 * **alongside** — the side-by-side condition the widget escalates to a warning
 * bar. Roughly a car length plus a margin: close enough that steering into that
 * side would make contact.
 */
export const ALONGSIDE_LON_M = 6;

/** One car's world position plus the identity the widget needs to draw it. */
export interface RadarCar {
  /** Stable per-session slot/entry id. */
  slotId: number;
  /** World position (`mPos`), metres, in the sim's world axes. */
  pos: Vec3;
  /** Canonical class label, when known (drives the blip colour). */
  carClass?: string;
  /** Car number, when known. */
  carNumber?: string;
  /** `true` when this car is a genuinely faster category than the player's. */
  isFasterClass?: boolean;
}

/** Everything {@link buildRadar} needs for one frame. */
export interface RadarInputs {
  /** The player car's world position (`mPos`). */
  playerPos: Vec3;
  /** The player car's orientation matrix (`mOri[3]`, rows of local→world). */
  ori: [Vec3, Vec3, Vec3];
  /** Every OTHER car on track (the player must not be in this list). */
  cars: RadarCar[];
  /** Range cap in metres; defaults to {@link RADAR_MAX_RANGE_M}. */
  maxRangeM?: number;
}

/** Guard for a torn/garbage read: no track is 100 km across. */
const MAX_PLAUSIBLE_COORD = 1e5;

function finite(v: number): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function vecFinite(v: Vec3): boolean {
  return finite(v.x) && finite(v.y) && finite(v.z);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** a × b, the 3-D cross product. */
function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Builds the radar blips for one frame, or `null` when the block fails its
 * plausibility guards (spectating, torn read, or an orientation matrix that has
 * degenerated). `null` is reported as "no radar" rather than an empty scope, the
 * same distinction {@link module:telemetry/motion} draws — an empty array means
 * "you are genuinely alone within range", which is real information.
 *
 * Blips are returned sorted nearest-first, so a widget that caps how many it
 * draws keeps the ones that matter.
 */
export function buildRadar(input: RadarInputs): RadarBlip[] | null {
  const { playerPos, ori, cars } = input;
  const maxRange = input.maxRangeM ?? RADAR_MAX_RANGE_M;

  // Player position + orientation must be sane, or every blip derived from them
  // would be wrong. Reject the whole block rather than draw a lie.
  if (!vecFinite(playerPos)) return null;
  if (Math.abs(playerPos.x) > MAX_PLAUSIBLE_COORD || Math.abs(playerPos.z) > MAX_PLAUSIBLE_COORD) {
    return null;
  }
  if (ori.length !== 3 || !ori.every(vecFinite)) return null;

  // The car's axes in world coords (see the module note). Computed once per
  // frame — they are the same for every blip.
  const fwd: Vec3 = { x: -ori[0].z, y: -ori[1].z, z: -ori[2].z }; // local −Z
  const up: Vec3 = { x: ori[0].y, y: ori[1].y, z: ori[2].y }; //     local +Y
  const right = cross(up, fwd); // LEFT-handed world → right = up × forward

  // The forward and right axes must be roughly unit length; a torn read of the
  // matrix collapses them toward zero (or explodes them), and a near-zero axis
  // would project every car onto ~0 and pin the whole field to the centre.
  const fwdLen = Math.hypot(fwd.x, fwd.y, fwd.z);
  const rightLen = Math.hypot(right.x, right.y, right.z);
  if (rightLen < 0.5 || rightLen > 1.5 || fwdLen < 0.5 || fwdLen > 1.5) return null;

  const blips: RadarBlip[] = [];
  for (const car of cars) {
    if (!vecFinite(car.pos)) continue;
    const dx = car.pos.x - playerPos.x;
    const dy = car.pos.y - playerPos.y;
    const dz = car.pos.z - playerPos.z;
    const lateral = dx * right.x + dy * right.y + dz * right.z;
    const longitudinal = dx * fwd.x + dy * fwd.y + dz * fwd.z;
    const distanceM = Math.hypot(lateral, longitudinal);
    if (!finite(distanceM) || distanceM > maxRange) continue;

    const blip: RadarBlip = {
      slotId: car.slotId,
      lateralM: round2(lateral),
      longitudinalM: round2(longitudinal),
      distanceM: round2(distanceM),
      alongside: Math.abs(longitudinal) <= ALONGSIDE_LON_M,
    };
    if (car.carClass) blip.carClass = car.carClass;
    if (car.carNumber) blip.carNumber = car.carNumber;
    if (car.isFasterClass) blip.isFasterClass = true;
    blips.push(blip);
  }

  blips.sort((a, b) => a.distanceM - b.distanceM);
  return blips;
}

/**
 * Builds an orientation matrix (in the same `mOri` row convention the sims use)
 * from a forward direction on the ground plane. Used by the simulator so its
 * synthetic field goes through the exact same {@link buildRadar} projection the
 * live path does — the same discipline `simulatorProvider` uses for chassis and
 * damage: invent only the raw inputs, never the decode.
 *
 * @param forward - The car's forward direction in world XZ (need not be unit).
 * @returns `[ori0, ori1, ori2]`, or `null` if `forward` is degenerate.
 */
export function headingOri(forward: { x: number; z: number }): [Vec3, Vec3, Vec3] | null {
  const len = Math.hypot(forward.x, forward.z);
  if (!finite(len) || len < 1e-6) return null;
  const fx = forward.x / len;
  const fz = forward.z / len;
  // col0 is the local +X axis in world — any unit vector perpendicular to
  // forward and up will do, since {@link buildRadar} derives the driver's right
  // as up × forward, not from col0. (−fz, 0, fx) satisfies that. Columns of
  // local→world: col0, col1 = up (+Y), col2 = −forward; stored as rows, so
  // ori[i] = (col0[i], col1[i], col2[i]).
  return [
    { x: -fz, y: 0, z: -fx },
    { x: 0, y: 1, z: 0 },
    { x: fx, y: 0, z: -fz },
  ];
}

/** Re-exported so callers building {@link RadarInputs} need only this module. */
export type { Vec3 } from './motion';

/** The unknown sentinel, re-exported for symmetry with the other decoders. */
export const RADAR_UNKNOWN = UNKNOWN_VALUE;
