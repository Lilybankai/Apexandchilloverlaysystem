/**
 * @file src/telemetry/aidIntervention.ts
 * @module telemetry/aidIntervention
 *
 * How hard traction control and ABS are working **right now**, as two 0..1
 * channels the input overlays can draw as lines.
 *
 * ## Why the obvious measure was wrong
 * The first version read intervention as "unfiltered − filtered pedal". A
 * 90-second probe of LMU on 2026-10-06 (`scripts/probe-lmu-intervention.js`, GT3,
 * TC 7 / ABS 9) showed that measure fails both ways:
 *
 *   - **TC read gear shifts.** Every upshift drops filtered throttle to 0 for
 *     ~3 physics frames, and the pit limiter holds it near 0 — 930 frames of
 *     "TC" with the game's own TC flag DOWN. Those were the scattered yellow
 *     dots on the trace. Real TC (flag up) cut a steady ~30% of the pedal, in
 *     pulses with frame-long gaps between them.
 *   - **ABS read nothing.** Filtered brake equalled the pedal on every one of
 *     5855 frames, ABS working or not. LMU's ABS does not touch the pedal
 *     channel; it modulates the per-wheel **brake pressure**. Under ABS the
 *     front-left fell to 0.04 while its partner held 0.38 at a steady 0.72
 *     pedal.
 *
 * ## What it does instead
 *   - **TC** = unfiltered − filtered throttle, counted ONLY while the sim's
 *     `mTCActive` flag is up and the filtered value is not a shift cut (0).
 *   - **ABS** = how much brake the worst wheel is missing against what the
 *     pedal asked of it, counted only while `mABSActive` was up recently (the
 *     flag flickers every other frame mid-stop, and the pressure dips land on
 *     both kinds of frame). "What the pedal asked" is a per-wheel pressure /
 *     pedal ratio learned on clean braking, so it absorbs brake bias and
 *     migration with no per-car data. Until it is learned, the axle partner
 *     stands in — ABS rarely releases both wheels of an axle in the same frame.
 *
 * Both pass through a fast-attack / slow-release envelope. TC and ABS are
 * pulsed systems; drawn raw they read as a comb of spikes, not as "how hard".
 * The envelope rises instantly and falls with an ~80 ms time constant, so a
 * burst of intervention reads as one sustained line whose height is its
 * strength.
 *
 * Units stay absolute pedal travel (0..1 of full pedal), the contract
 * {@link PedalInputs.tc} has always had, so recorded lap traces keep their
 * meaning.
 */

/** One frame of the raw channels this module needs. */
export interface AidRawInputs {
  /** Sim clock in seconds (`mElapsedTime`); `<= 0` when unknown. */
  t: number;
  /** Driver's throttle, unfiltered, 0..1. */
  throttle: number;
  /** Throttle after the aids, 0..1. */
  filteredThrottle: number;
  /** Driver's brake, unfiltered, 0..1. */
  brake: number;
  /** Per-wheel `mBrakePressure` (FL, FR, RL, RR), 0..1; `null` if unreadable. */
  wheelBrake: readonly [number, number, number, number] | null;
  /** The sim's own "TC is intervening" flag. */
  tcActive: boolean;
  /** The sim's own "ABS is intervening" flag. */
  absActive: boolean;
}

export interface AidIntervention {
  /** Throttle TC is removing, 0..1 of full pedal. */
  tc: number;
  /** Brake ABS is releasing at the worst wheel, 0..1 of full pedal. */
  abs: number;
}

/** Release time constant of the display envelope, seconds. */
export const ENVELOPE_TAU_S = 0.08;
/** How long after the last ABS flag the pressure dips still count, seconds. */
export const ABS_WINDOW_S = 0.25;
/** Below this pedal, no ratio is learned and no ABS is reported. */
const MIN_BRAKE = 0.1;
/** Filtered throttle at or below this while TC is flagged is a shift cut. */
const SHIFT_CUT = 0.02;
/** EMA weight for the per-wheel pressure/pedal ratio. */
const RATIO_ALPHA = 0.1;
/** A frame gap this long resets the envelopes (pause, session change). */
const RESET_GAP_S = 1;

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
/** Axle partner of each wheel: FL<->FR, RL<->RR. */
const PARTNER = [1, 0, 3, 2] as const;

export class AidInterventionTracker {
  private lastT = 0;
  private tcEnv = 0;
  private absEnv = 0;
  private lastAbsFlagT = -Infinity;
  /** Learned pressure/pedal ratio per wheel; 0 = not learned yet. */
  private readonly ratio = [0, 0, 0, 0];

  public reset(): void {
    this.lastT = 0;
    this.tcEnv = 0;
    this.absEnv = 0;
    this.lastAbsFlagT = -Infinity;
    this.ratio.fill(0);
  }

  public update(raw: AidRawInputs): AidIntervention {
    const t = raw.t;
    if (!(t > 0)) return { tc: 0, abs: 0 };
    let dt = t - this.lastT;
    if (this.lastT === 0 || dt < 0 || dt > RESET_GAP_S) {
      this.tcEnv = 0;
      this.absEnv = 0;
      this.lastAbsFlagT = -Infinity;
      dt = 0;
    }
    this.lastT = t;
    const decay = dt > 0 ? Math.exp(-dt / ENVELOPE_TAU_S) : 1;

    const tcRaw = this.tcSample(raw);
    const absRaw = this.absSample(raw, t);
    this.tcEnv = Math.max(tcRaw, this.tcEnv * decay);
    this.absEnv = Math.max(absRaw, this.absEnv * decay);
    // Below a hair the envelope is invisible; snap so "off" is exactly 0.
    if (this.tcEnv < 0.005) this.tcEnv = 0;
    if (this.absEnv < 0.005) this.absEnv = 0;
    return { tc: this.tcEnv, abs: this.absEnv };
  }

  private tcSample(raw: AidRawInputs): number {
    if (!raw.tcActive) return 0;
    const f = raw.filteredThrottle;
    if (!(f > SHIFT_CUT) || f > 1.05) return 0;
    return clamp01(clamp01(raw.throttle) - f);
  }

  private absSample(raw: AidRawInputs, t: number): number {
    if (raw.absActive) this.lastAbsFlagT = t;
    const bp = raw.wheelBrake;
    const brake = clamp01(raw.brake);
    if (!bp || brake < MIN_BRAKE) return 0;
    for (let i = 0; i < 4; i++) if (!(bp[i]! >= 0 && bp[i]! <= 1.05)) return 0;

    const absRecent = t - this.lastAbsFlagT <= ABS_WINDOW_S;
    if (!absRecent) {
      // Clean braking: learn what each wheel normally gets for this pedal.
      for (let i = 0; i < 4; i++) {
        const r = bp[i]! / brake;
        if (r > 0.05) this.ratio[i] = this.ratio[i] === 0 ? r : this.ratio[i]! + RATIO_ALPHA * (r - this.ratio[i]!);
      }
      return 0;
    }

    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const learned = this.ratio[i]! * brake;
      const expected = learned > 0 ? learned : Math.max(bp[i]!, bp[PARTNER[i]!]!);
      if (expected <= 0.01) continue;
      const release = clamp01(1 - bp[i]! / expected);
      if (release > worst) worst = release;
    }
    return clamp01(worst * brake);
  }
}
