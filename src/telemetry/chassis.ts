/**
 * @file src/telemetry/chassis.ts
 * @module telemetry/chassis
 *
 * Turns the sim's raw **per-wheel block** (tyre load, suspension deflection,
 * ride height, pushrod force, grip fraction) into the four-corner chassis
 * channels the chassis widget renders.
 *
 * ## Why this is its own module
 * Same reason as {@link module:telemetry/motion}: both providers read the same
 * ISI wheel struct, so the unit conversions and — more importantly — the
 * *thresholds* that decide "this corner is overloaded" or "this wheel has gone
 * light" are applied ONCE, here, and are unit-testable without a sim running.
 * A widget that calls a wheel airborne when it is merely unweighted is worse
 * than one that says nothing.
 *
 * ## The calibration problem, and how this module avoids inventing numbers
 * A corner load of 3200 N means nothing on its own. Whether that is "loaded"
 * depends on the car's mass, its weight distribution and its aero — none of
 * which LMU or rF2 publish. Two ways out, and this module takes both:
 *
 *   1. **Share of total** (`shareOfTotal`) — instantaneous, needs no
 *      calibration at all, and is exact: this corner's load over the sum of all
 *      four. Front/rear and left/right splits come straight from it. This is
 *      the honest primary channel.
 *   2. **Self-calibrating reference** (`loadRatio`) — each corner's load
 *      divided by a slow exponential average of *its own* load. 1.0 means
 *      "normal for this corner, this car, this setup"; 1.6 means half again the
 *      load it usually carries. Because the reference is per-corner and learned
 *      live, it needs no per-car data and works identically in a GT3, a
 *      Hypercar or an LMP2.
 *
 * The alternative — hard-coding a GT3 mass and a 45/55 distribution — would
 * produce a number that looks calibrated and is wrong in every car that is not
 * the one it was tuned against. Same principle as the slip-angle note in
 * {@link module:telemetry/motion}: two honest channels beat one fabricated one.
 *
 * ## Sign and unit conventions
 *   - `loadN`          vertical tyre load, **Newtons**, always >= 0. 0 = airborne.
 *   - `deflectionMm`   suspension travel, **mm**, positive = COMPRESSED.
 *   - `rideHeightMm`   chassis height above the road at that corner, **mm**.
 *   - `suspForceN`     pushrod/spring force, **Newtons**.
 *   - `gripFract`      fraction of the contact patch still gripping, 0..1.
 *
 * The sim reports deflection and ride height in metres; both are converted here
 * so nothing downstream has to remember which unit it received.
 */

import { UNKNOWN_VALUE } from './types';
import type { ChassisState, CornerState } from './types';

/**
 * One wheel straight out of shared memory, in the sim's own units (metres,
 * Newtons). No sign handling has been applied.
 */
export interface RawCorner {
  /** `mTireLoad` — vertical load through the contact patch, N. */
  loadN: number;
  /** `mSuspensionDeflection` — suspension travel, m, positive = compressed. */
  deflectionM: number;
  /** `mRideHeight` — chassis height above the road at this corner, m. */
  rideHeightM: number;
  /** `mSuspForce` — pushrod load, N. */
  suspForceN: number;
  /** `mGripFract` — fraction of the patch gripping rather than sliding, 0..1. */
  gripFract: number;
}

/** The four raw corners, in the sim's wheel order: FL, FR, RL, RR. */
export type RawCornerSet = [RawCorner, RawCorner, RawCorner, RawCorner];

/**
 * Guards for a torn or unpopulated read. A GT3 corner carries roughly 2–6 kN
 * static and peaks around 15 kN over a kerb; 60 kN is not a tyre load, it is a
 * bad offset. Ride height and deflection are similarly bounded — no racing car
 * has half a metre of suspension travel.
 */
const MAX_PLAUSIBLE_LOAD_N = 60000;
const MAX_PLAUSIBLE_TRAVEL_M = 0.5;

/**
 * Total load below this means the whole car is reading as weightless, which no
 * car on track ever is — it is the signature of a struct field the sim does not
 * populate (all four corners sitting at exactly 0). Treated as "no data" rather
 * than "the car is flying", because reporting four airborne wheels every frame
 * would be a confidently wrong readout of the kind this codebase avoids.
 */
const MIN_TOTAL_LOAD_N = 200;

/**
 * Load ratio above which a corner is called **overloaded** — carrying half
 * again its own normal load. Chosen to fire on the things worth seeing on a
 * stream (kerb strikes, heavy braking into a compression, the loaded outside
 * front mid-corner) without lighting up through every gentle direction change.
 */
const OVERLOAD_RATIO = 1.55;

/**
 * Load ratio below which a corner is called **light**. At under a quarter of
 * its usual load the tyre still touches the road but has very little left to
 * give — this is the inside-front lifting through a chicane.
 */
const LIGHT_RATIO = 0.25;

/**
 * Absolute load below which a corner is called **airborne**. Absolute rather
 * than a ratio because "no load at all" is a physical fact, not a relative one:
 * 150 N is well under the weight of the unsprung corner itself, so the tyre is
 * hanging on the droop stops rather than resting on the road.
 */
const AIRBORNE_LOAD_N = 150;

/**
 * Time constant of the per-corner reference average, in seconds. Long enough
 * that a single corner cannot drag the reference toward itself (a 90-second
 * lap contains both left and right loadings, so the average converges on the
 * corner's typical load rather than any one phase), short enough to follow a
 * genuine change — a fuel burn-down, a tyre change, a wing adjustment.
 */
const REFERENCE_TAU_SEC = 25;

/**
 * Seconds of running before `loadRatio` is trusted. Until then the reference is
 * still converging and every ratio sits suspiciously near 1.0, so the state is
 * flagged uncalibrated and the widget shows shares instead of ratios.
 */
const WARMUP_SEC = 8;

function finite(v: number): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** The learned reference load at each corner, N. See {@link ChassisTracker}. */
interface CornerRefs {
  fl: number;
  fr: number;
  rl: number;
  rr: number;
}

function cornerOk(c: RawCorner): boolean {
  return (
    finite(c.loadN) &&
    finite(c.deflectionM) &&
    finite(c.rideHeightM) &&
    c.loadN >= -1 && // a tiny negative is float noise around zero; below that is garbage
    c.loadN <= MAX_PLAUSIBLE_LOAD_N &&
    Math.abs(c.deflectionM) <= MAX_PLAUSIBLE_TRAVEL_M &&
    Math.abs(c.rideHeightM) <= MAX_PLAUSIBLE_TRAVEL_M
  );
}

/**
 * Stateful decoder for the four-corner chassis block.
 *
 * Stateful because `loadRatio` needs the per-corner reference average, which
 * only exists across frames. One instance per provider; {@link reset} on a
 * session change so a reference learned at Le Mans does not carry into a
 * different car at Monza.
 */
export class ChassisTracker {
  /**
   * Per-corner reference load (EMA), N. `0` until the first valid frame.
   *
   * Named fields rather than an array so every read types as a definite
   * `number` under `noUncheckedIndexedAccess` — the four corners are a fixed
   * set, and naming them beats sprinkling non-null assertions over a loop.
   */
  private reference: CornerRefs = { fl: 0, fr: 0, rl: 0, rr: 0 };

  /** Seconds of valid data accumulated, for the warm-up gate. */
  private elapsedSec = 0;

  /** Sim clock of the previous update, for the EMA's dt. `-1` = no previous. */
  private lastClockSec = -1;

  /** Forget the learned reference (car change, session change, teleport). */
  reset(): void {
    this.reference = { fl: 0, fr: 0, rl: 0, rr: 0 };
    this.elapsedSec = 0;
    this.lastClockSec = -1;
  }

  /**
   * Normalises a raw four-corner block into {@link ChassisState}, or returns
   * `null` when the block fails its plausibility guards — sim not running, a
   * torn read, or a field this sim build does not populate. All three are
   * better shown as "no data" than as four wheels reading zero load.
   *
   * @param raw     the four wheels in sim order: FL, FR, RL, RR.
   * @param clockSec the sim's elapsed-time clock, seconds. Used for the EMA's
   *   dt so the reference converges in *sim* time and is unaffected by frame
   *   rate or by the game being paused. Pass {@link UNKNOWN_VALUE} if unknown,
   *   and a nominal 30 Hz step is assumed instead.
   */
  update(raw: RawCornerSet, clockSec: number): ChassisState | null {
    if (!raw.every(cornerOk)) return null;

    // Destructured rather than indexed throughout: the four corners are a fixed
    // set, and naming them keeps every access typed as a definite value.
    const [rawFL, rawFR, rawRL, rawRR] = raw;
    const loadFL = Math.max(0, rawFL.loadN);
    const loadFR = Math.max(0, rawFR.loadN);
    const loadRL = Math.max(0, rawRL.loadN);
    const loadRR = Math.max(0, rawRR.loadN);
    const totalLoadN = loadFL + loadFR + loadRL + loadRR;
    if (totalLoadN < MIN_TOTAL_LOAD_N) return null;

    // --- advance the per-corner reference average ---------------------------
    // dt from the sim clock, so a paused game does not age the reference and a
    // 120 Hz physics loop converges at the same rate as a 30 Hz one.
    let dt = 1 / 30;
    if (finite(clockSec) && clockSec !== UNKNOWN_VALUE) {
      if (this.lastClockSec >= 0) {
        const step = clockSec - this.lastClockSec;
        // A backwards or absurd step means the session restarted or the clock
        // was re-based; drop the learned reference rather than smearing the old
        // car's loads into the new one.
        if (step < 0 || step > 5) {
          this.reset();
          this.lastClockSec = clockSec;
          return null;
        }
        dt = step;
      }
      this.lastClockSec = clockSec;
    }

    const alpha = 1 - Math.exp(-dt / REFERENCE_TAU_SEC);
    // Seed on the first frame rather than easing up from zero, which would
    // otherwise make every corner read as massively overloaded for the first
    // few seconds.
    const ease = (prev: number, load: number): number =>
      prev === 0 ? load : prev + alpha * (load - prev);
    this.reference = {
      fl: ease(this.reference.fl, loadFL),
      fr: ease(this.reference.fr, loadFR),
      rl: ease(this.reference.rl, loadRL),
      rr: ease(this.reference.rr, loadRR),
    };
    this.elapsedSec += dt;
    const calibrated = this.elapsedSec >= WARMUP_SEC;

    // --- per-corner state ---------------------------------------------------
    const corner = (src: RawCorner, loadN: number, ref: number): CornerState => {
      // A reference at or near zero would divide to Infinity. It only happens
      // for a corner that has read zero since the tracker started, which is
      // exactly the case where a ratio would be meaningless anyway.
      const loadRatio = ref > 1 ? round3(loadN / ref) : UNKNOWN_VALUE;
      const airborne = loadN < AIRBORNE_LOAD_N;
      const ratioKnown = loadRatio !== UNKNOWN_VALUE;
      return {
        loadN: Math.round(loadN),
        shareOfTotal: round3(loadN / totalLoadN),
        loadRatio,
        referenceLoadN: Math.round(ref),
        // Deflection and ride height are the sim's metres; mm is what a race
        // engineer reads and what fits a two-digit readout on a stream.
        deflectionMm: round1(src.deflectionM * 1000),
        rideHeightMm: round1(src.rideHeightM * 1000),
        suspForceN: finite(src.suspForceN) ? Math.round(src.suspForceN) : UNKNOWN_VALUE,
        gripFract:
          finite(src.gripFract) && src.gripFract >= 0 && src.gripFract <= 1
            ? round3(src.gripFract)
            : UNKNOWN_VALUE,
        airborne,
        // "Light" and "airborne" are deliberately exclusive: a wheel in the air
        // is reported as airborne only, so the widget never has to decide which
        // of two simultaneous flags outranks the other.
        light: !airborne && calibrated && ratioKnown && loadRatio < LIGHT_RATIO,
        overloaded: calibrated && ratioKnown && loadRatio > OVERLOAD_RATIO,
      };
    };

    const fl = corner(rawFL, loadFL, this.reference.fl);
    const fr = corner(rawFR, loadFR, this.reference.fr);
    const rl = corner(rawRL, loadRL, this.reference.rl);
    const rr = corner(rawRR, loadRR, this.reference.rr);

    // --- whole-car distribution --------------------------------------------
    // All four are instantaneous and exact — no calibration, no learned state.
    const frontShare = round3((loadFL + loadFR) / totalLoadN);
    const leftShare = round3((loadFL + loadRL) / totalLoadN);
    // Cross-weight: the FL+RR diagonal as a share of the whole. 0.5 is a
    // perfectly square car; away from 0.5 one diagonal is carrying the car,
    // which is what a driver feels as the car "sitting on a corner".
    const crossShare = round3((loadFL + loadRR) / totalLoadN);

    return {
      frontLeft: fl,
      frontRight: fr,
      rearLeft: rl,
      rearRight: rr,
      totalLoadN: Math.round(totalLoadN),
      frontShare,
      rearShare: round3(1 - frontShare),
      leftShare,
      rightShare: round3(1 - leftShare),
      crossShare,
      wheelsAirborne: [fl, fr, rl, rr].filter((c) => c.airborne).length,
      calibrated,
    };
  }
}

/**
 * Expected steady-state lateral load transfer implied by a lateral G reading,
 * as a left-side share of total load.
 *
 * This is the chassis equivalent of {@link module:telemetry/motion.motionConsistency}:
 * a cheap identity that lets the tyre-load channel be *verified* against an
 * independent one rather than trusted blindly. In steady cornering the load
 * moves off the inside and onto the outside in proportion to lateral
 * acceleration, so `leftShare` and `latG` must disagree in a specific,
 * predictable way — if they do not, one of the two is being read wrong.
 *
 * Deliberately approximate: the true transfer needs track width and CG height,
 * which no sim publishes. `TRANSFER_PER_G` is a nominal GT3 figure, so this is
 * a **sanity check, not a calibration** — it is used by the test script to
 * catch an inverted or mis-offset load channel, never to produce a displayed
 * number.
 *
 * @returns the expected left-side share (0..1), where 0.5 is a car at rest.
 */
export function expectedLeftShare(latG: number): number {
  /** Share of total load moved per g of lateral acceleration, nominal GT3. */
  const TRANSFER_PER_G = 0.19;
  // latG positive = acceleration toward the car's RIGHT = a right-hand corner,
  // which loads the LEFT (outside) wheels. Hence the sign: positive latG raises
  // the left share.
  const share = 0.5 + latG * TRANSFER_PER_G;
  return Math.min(1, Math.max(0, round3(share)));
}
