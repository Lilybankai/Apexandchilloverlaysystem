/**
 * cornerTracker.ts — the live lap scored corner by corner against the ghost,
 * as it is driven.
 * -----------------------------------------------------------------------------
 * `corners.ts` can already score a lap through a corner (`cornerResult`), but
 * it wants both laps as whole columns. Keeping the live lap as columns would
 * mean storing every sample of it and re-reading them at every corner exit —
 * a growing buffer in the frame loop for an answer that only needs a handful
 * of numbers. So this keeps exactly those numbers, updated in O(1) a tick:
 *
 *   - the gap to the ghost as the car crosses each corner's ENTRY and EXIT,
 *     interpolated between the two ticks either side of the line;
 *   - where each braking zone began, by the same on/off hysteresis and zone
 *     gap as `brakePoints.ts`, assigned to the corners whose search window
 *     ({@link BRAKE_SEARCH_M} before entry, up to the apex) contains it;
 *   - the lowest speed seen between entry and exit.
 *
 * ## Why gap differences ARE `cornerResult`'s arithmetic
 * `cornerResult` takes (live exit − live entry) − (ref exit − ref entry). The
 * ghost's gap at any distance is `t_live − t_ref(d)`, so the gap at exit minus
 * the gap at entry is the same sum regrouped. Scoring on the gap the frame
 * already carries means no second interpolation into the reference, and the
 * card and Ghost HUD's readout can never disagree about a corner.
 *
 * The reference side — its braking point and minimum speed per corner — is
 * worked out once per ghost lap, by the same rules `cornerResult` applies, so
 * a lap compared with itself scores zero here too. `scripts/test-cornertracker.js`
 * replays recorded laps through this and checks it against `cornerResult`.
 *
 * ## What the frame gets
 * A few dozen numbers: which corner is next, how far to it and to the
 * reference's braking point, the last verdict, and one delta per corner for
 * this lap and the previous one. The per-lap arrays are REPLACED when a corner
 * is scored, never mutated, so a frame already handed on keeps saying what it
 * said.
 *
 * Only ever driven while a ghost is selected — the provider calls
 * {@link CornerTracker.reset} the moment there is none, and the selector only
 * selects while something is showing it.
 */

import { BRAKE_OFF, BRAKE_ON, ZONE_GAP_M } from './brakePoints';
import { BRAKE_SEARCH_M } from './corners';
import type { GhostLap } from './ghostLap';
import type { GhostCornerState, GhostCornerVerdict } from './types';

/**
 * A forward step longer than this in one tick is not driving — a tow to the
 * pits, a reset to the track, a restart. Anything spanning it is left
 * unscored rather than interpolated across, which would invent a corner time
 * from two points a kilometre apart.
 */
export const MAX_STEP_M = 120;

/**
 * A drop in lap fraction bigger than this is the start/finish line, not the
 * filtered position wobbling backwards by a few centimetres.
 */
const WRAP_DROP = 0.5;

/** Corner states within a lap. */
const PENDING = 0;
const ENTERED = 1;
const DONE = 2;

/** The reference's per-corner numbers, built once per ghost lap. */
interface RefCorners {
  lap: GhostLap;
  n: number;
  L: number;
  entry: Float64Array;
  apex: Float64Array;
  exit: Float64Array;
  /** Lap fraction of the reference's braking point for each corner; NaN = none. */
  brakeD: Float64Array;
  /** The reference's minimum speed through each corner, km/h; NaN = no channel. */
  minKph: Float64Array;
}

export class CornerTracker {
  private ref: RefCorners | null = null;

  /* ------------------------- this lap, per corner ------------------------- */
  private state = new Uint8Array(0);
  private entryGap = new Float64Array(0);
  private brakeD = new Float64Array(0);
  private minKph = new Float64Array(0);
  /** First corner whose exit has not been crossed this lap. */
  private next = 0;

  /* ------------------------------- the trail ------------------------------- */
  /** Previous tick's lap fraction and gap (NaN gap = ghost inactive). */
  private prevD = NaN;
  private prevGap = NaN;
  private prevBrake = 0;
  /** Laps completed under this tracker, so brake zones are measured across the line. */
  private lapBase = 0;
  private brakeOn = false;
  /** Lap-continuous metres where the brake last went off. */
  private offSinceM = -Infinity;

  /* -------------------------------- results -------------------------------- */
  private lapCorners: (number | null)[] = [];
  private prevLapCorners: (number | null)[] = [];
  private last: GhostCornerVerdict | undefined;
  private seq = 0;

  /** Forget everything — no ghost, a spectated car, a new session. */
  public reset(): void {
    if (!this.ref && !Number.isFinite(this.prevD)) return;
    this.ref = null;
    this.prevD = NaN;
    this.prevGap = NaN;
    this.last = undefined;
  }

  /**
   * One tick.
   *
   * @param lap    - The ghost being chased.
   * @param d      - Road position, lap fraction — the filtered axis the gap is on.
   * @param gapSec - `GhostState.gapSec` when the ghost is ACTIVE, else NaN.
   * @param brake  - Brake pedal 0..1, as the trace records it.
   * @param speedKph - Road speed.
   * @returns The state for the frame, or `undefined` when the lap has no corners.
   */
  public update(
    lap: GhostLap,
    d: number,
    gapSec: number,
    brake: number,
    speedKph: number,
  ): GhostCornerState | undefined {
    if (!lap.corners || lap.corners.length === 0 || !(lap.trackLengthM > 0)) {
      this.reset();
      return undefined;
    }
    if (!this.ref || this.ref.lap !== lap) this.setRef(lap);
    const ref = this.ref!;
    if (!Number.isFinite(d)) return this.snapshot(this.prevD);
    const gap = Number.isFinite(gapSec) ? gapSec : NaN;
    const b = Number.isFinite(brake) ? brake : 0;

    let a = this.prevD;
    let ga = this.prevGap;
    if (Number.isFinite(a)) {
      if (d < a - WRAP_DROP) {
        // Over the line. Finish the old lap on its own last gap — the gap
        // restarts from zero with the new lap clock, so interpolating across
        // the line would blend two different laps' gaps.
        this.advance(a, ga, 1, ga);
        this.rollLap();
        a = 0;
        ga = gap;
      } else if (d < a) {
        // The filtered position settling back a few centimetres: no events.
        a = d;
      } else if ((d - a) * ref.L > MAX_STEP_M) {
        this.skipTo(d);
        a = d;
      }
    } else {
      // First tick: anything already under way cannot be scored for time.
      this.skipTo(d);
      a = d;
    }

    this.advance(a, ga, d, gap);
    this.noteBrake(d, b);
    if (this.next < ref.n && this.state[this.next] === ENTERED && Number.isFinite(speedKph)) {
      if (speedKph < this.minKph[this.next]!) this.minKph[this.next] = speedKph;
    }
    this.prevD = d;
    this.prevGap = gap;
    this.prevBrake = b;
    return this.snapshot(d);
  }

  /* -------------------------------- internals ------------------------------ */

  private setRef(lap: GhostLap): void {
    const cs = lap.corners!;
    const n = cs.length;
    const L = lap.trackLengthM;
    const entry = new Float64Array(n);
    const apex = new Float64Array(n);
    const exit = new Float64Array(n);
    const brakeD = new Float64Array(n).fill(NaN);
    const minKph = new Float64Array(n).fill(NaN);
    const brakes = lap.brakes ?? [];
    const speed = lap.speedKph;
    for (let k = 0; k < n; k += 1) {
      const c = cs[k]!;
      entry[k] = c.entryD;
      apex[k] = c.apexD;
      exit[k] = c.exitD;
      // `cornerResult`'s rules, applied to the reference once: the first
      // braking point within the search window, and the lowest SAMPLED speed
      // in the corner (not `Corner.minKph`, whose between-samples refinement
      // the live side does not have).
      const from = c.entryD - BRAKE_SEARCH_M / L;
      for (const bp of brakes) {
        if (bp.d >= from && bp.d <= c.apexD) {
          brakeD[k] = bp.d;
          break;
        }
      }
      if (speed) {
        let min = Infinity;
        for (let i = 0; i < lap.trace.length && i < speed.length; i += 1) {
          const sd = lap.trace[i]!.d;
          if (sd < c.entryD) continue;
          if (sd > c.exitD) break;
          if (speed[i]! < min) min = speed[i]!;
        }
        if (Number.isFinite(min)) minKph[k] = min;
      }
    }
    this.ref = { lap, n, L, entry, apex, exit, brakeD, minKph };
    this.state = new Uint8Array(n);
    this.entryGap = new Float64Array(n).fill(NaN);
    this.brakeD = new Float64Array(n).fill(NaN);
    this.minKph = new Float64Array(n).fill(Infinity);
    this.next = 0;
    this.lapCorners = new Array<number | null>(n).fill(null);
    this.prevLapCorners = new Array<number | null>(n).fill(null);
    this.last = undefined;
    this.prevD = NaN;
    this.prevGap = NaN;
    this.prevBrake = 0;
    this.brakeOn = false;
    this.offSinceM = -Infinity;
    this.lapBase = 0;
  }

  /**
   * Cross every entry and exit in `(a, b]`. Normally none, sometimes one;
   * a slow feed through a chicane can cross several in one tick.
   */
  private advance(a: number, ga: number, b: number, gb: number): void {
    const ref = this.ref!;
    while (this.next < ref.n) {
      const k = this.next;
      if (this.state[k] === PENDING) {
        const e = ref.entry[k]!;
        if (e > b) return;
        this.state[k] = ENTERED;
        this.entryGap[k] = e > a ? lerpGap(a, ga, b, gb, e) : NaN;
      }
      const x = ref.exit[k]!;
      if (x > b) return;
      this.score(k, x > a ? lerpGap(a, ga, b, gb, x) : NaN);
      this.next = k + 1;
    }
  }

  /** Jump to `d` without scoring anything passed on the way. */
  private skipTo(d: number): void {
    const ref = this.ref!;
    while (this.next < ref.n && ref.entry[this.next]! < d) {
      const k = this.next;
      if (ref.exit[k]! < d) {
        this.state[k] = DONE;
        this.next = k + 1;
      } else {
        // Mid-corner: entered, but with no gap at its entry.
        this.state[k] = ENTERED;
        this.entryGap[k] = NaN;
        break;
      }
    }
  }

  /** Brake-zone onsets, by `brakePoints.ts`'s rules, given to their corners. */
  private noteBrake(d: number, b: number): void {
    const ref = this.ref!;
    const m = (this.lapBase + d) * ref.L;
    if (!this.brakeOn && b >= BRAKE_ON) {
      this.brakeOn = true;
      if (m - this.offSinceM >= ZONE_GAP_M) {
        // Interpolate the crossing between the previous tick and this one,
        // as the detector does between samples.
        const a = this.prevD;
        const b0 = this.prevBrake;
        const f = b > b0 ? Math.min(1, Math.max(0, (BRAKE_ON - b0) / (b - b0))) : 1;
        const onset = Number.isFinite(a) && a <= d ? a + (d - a) * f : d;
        // Corners' windows overlap only where one corner's apex runs into the
        // next one's approach, so the next two are the only candidates.
        for (let k = this.next; k < ref.n && k <= this.next + 1; k += 1) {
          const from = ref.entry[k]! - BRAKE_SEARCH_M / ref.L;
          if (onset >= from && onset <= ref.apex[k]! && !Number.isFinite(this.brakeD[k]!)) {
            this.brakeD[k] = onset;
          }
        }
      }
    } else if (this.brakeOn && b < BRAKE_OFF) {
      this.brakeOn = false;
      this.offSinceM = m;
    }
  }

  private score(k: number, exitGap: number): void {
    const ref = this.ref!;
    const entryGap = this.entryGap[k]!;
    const deltaSec =
      Number.isFinite(entryGap) && Number.isFinite(exitGap) ? round3(exitGap - entryGap) : null;
    const liveBrake = this.brakeD[k]!;
    const refBrake = ref.brakeD[k]!;
    const brakeDeltaM =
      Number.isFinite(liveBrake) && Number.isFinite(refBrake)
        ? round1((liveBrake - refBrake) * ref.L)
        : null;
    const liveMin = this.minKph[k]!;
    const refMin = ref.minKph[k]!;
    const apexKphDelta =
      Number.isFinite(liveMin) && Number.isFinite(refMin) ? round1(liveMin - refMin) : null;
    this.state[k] = DONE;
    this.seq += 1;
    this.last = { index: k, seq: this.seq, deltaSec, brakeDeltaM, apexKphDelta };
    // A fresh array: a frame already sent holds the old one, and must keep
    // saying what it said.
    const lapCorners = this.lapCorners.slice();
    lapCorners[k] = deltaSec;
    this.lapCorners = lapCorners;
  }

  private rollLap(): void {
    const n = this.ref!.n;
    this.prevLapCorners = this.lapCorners;
    this.lapCorners = new Array<number | null>(n).fill(null);
    this.state.fill(PENDING);
    this.entryGap.fill(NaN);
    this.brakeD.fill(NaN);
    this.minKph.fill(Infinity);
    this.next = 0;
    this.lapBase += 1;
  }

  private snapshot(d: number): GhostCornerState | undefined {
    const ref = this.ref;
    if (!ref || !Number.isFinite(d)) return undefined;
    // After the last corner, the next one is the first corner of the next lap.
    const wrapped = this.next >= ref.n;
    const k = wrapped ? 0 : this.next;
    const inside = !wrapped && this.state[k] === ENTERED && d >= ref.entry[k]!;
    // Lap fraction from here to the start of that corner's lap.
    const base = wrapped ? 1 - d : -d;
    const out: GhostCornerState = {
      index: k,
      inside,
      toEntryM: inside ? 0 : Math.max(0, Math.round((base + ref.entry[k]!) * ref.L)),
      lapCorners: this.lapCorners,
      prevLapCorners: this.prevLapCorners,
    };
    const bd = ref.brakeD[k]!;
    if (!inside && Number.isFinite(bd)) {
      const m = (base + bd) * ref.L;
      if (m > 0) out.toBrakeM = Math.round(m);
    }
    if (this.last) out.last = this.last;
    return out;
  }
}

/** The gap at fraction `x` between two ticks; NaN when either end has none. */
function lerpGap(a: number, ga: number, b: number, gb: number, x: number): number {
  if (!Number.isFinite(ga) || !Number.isFinite(gb)) return NaN;
  if (!(b > a)) return gb;
  return ga + (gb - ga) * ((x - a) / (b - a));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
