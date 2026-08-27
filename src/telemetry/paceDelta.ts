/**
 * paceDelta.ts — Pacelogic-style dual lap-delta engine for the DRIVEN car.
 * -----------------------------------------------------------------------------
 * Replicates the two delta readouts of SimHub's "Pacelogic Intro Dash" — its
 * `Delta T` and `Delta V` widgets — which are thin views over SimHub's
 * `PersistantTrackerPlugin` live-delta engine. Each is shown against three
 * reference laps (session best / all-time best / last lap):
 *
 *   • Delta T  ("time" delta)     = SimHub `…LiveDeltaSeconds`
 *       Time delta at the SAME TRACK POSITION:  t_now − t_ref(d_now).
 *       The classic predictive delta bar. Negative = ahead / faster.
 *
 *   • Delta V  ("progress" delta) = SimHub `…LiveDeltaProgressSeconds`
 *       Delta at the SAME ELAPSED TIME:  compare how far each car has
 *       progressed at time t_now and convert that distance gap to seconds via
 *       the reference lap's pace.  (d_ref(t_now) − d_now) × refLapTime.
 *       Reacts differently through corners than Delta T. Negative = ahead.
 *
 * Both are computed off the exact shared-memory lap clock the driven car
 * already exposes (`lapTimeSec = mElapsedTime − mLapStartET`).
 *
 * The all-time-best reference is persisted per track AND CAR under the user's
 * home dir so it survives restarts (SimHub's "all time best" is likewise
 * cross-session). See {@link refKeyOf} for why the car belongs in that key.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UNKNOWN_VALUE, type PaceDeltas } from './types';

export type { PaceDeltas };

/** One point on a lap's distance→time curve (distance as a 0..1 fraction). */
interface Sample {
  d: number;
  t: number;
}

/** All-unknown result (spectating, between laps, no reference yet). */
export const EMPTY_PACE_DELTAS: PaceDeltas = {
  tSession: UNKNOWN_VALUE,
  tAllTime: UNKNOWN_VALUE,
  tLast: UNKNOWN_VALUE,
  vSession: UNKNOWN_VALUE,
  vAllTime: UNKNOWN_VALUE,
  vLast: UNKNOWN_VALUE,
  predictedLapSec: UNKNOWN_VALUE,
  lapTimeSec: UNKNOWN_VALUE,
  refSessionSec: UNKNOWN_VALUE,
  refAllTimeSec: UNKNOWN_VALUE,
  lastLapSec: UNKNOWN_VALUE,
};

/** Beyond this |delta| (seconds) the reference is assumed bad → report unknown. */
const SANE_LIMIT_SEC = 30;

/**
 * Output conditioning. The two inputs arrive at very different rates: the time
 * axis (`mElapsedTime`, shared memory) is fresh every frame at ~30-60 Hz, while
 * the position axis (REST `lapDistance`) only refreshes every ~150 ms. A raw
 * `t − t_ref(d)` therefore ramps at 1.0 s/s while `d` is frozen and snaps back
 * when the next REST packet lands — a sawtooth of ±one refresh interval, which
 * reads on-screen as the delta "jumping around like crazy".
 *
 * The provider now dead-reckons `d` forward between refreshes so both axes
 * advance together, which removes the ramp at source. These two constants clean
 * up what's left (REST distance quantisation, poll jitter, packet latency):
 *
 *   • SLEW — a hard ceiling on how fast the readout may move, in seconds of
 *     delta per second of driving. A real delta changes slowly: even a big
 *     lock-up or an off only swings it ~1 s/s. Anything faster is measurement
 *     noise, so it's rate-limited into a ramp instead of a jump.
 *   • TAU — first-order low-pass time constant. Short enough to still feel live
 *     under braking, long enough to kill single-packet ripple.
 */
const SMOOTH_SLEW_SEC_PER_SEC = 1.5;
const SMOOTH_TAU_SEC = 0.25;

/**
 * Road-position observer constants — see {@link RoadPosition}.
 *
 *   • POS_TAU_SEC — how quickly the observer is pulled onto the REST-measured
 *     position. Long, because the fast motion already comes from integrating the
 *     car's own live speed: the measurement is only needed to stop slow drift,
 *     so trusting it slowly costs no tracking accuracy and rejects most of its
 *     noise.
 *   • POS_SNAP_M — beyond this disagreement the measurement is not noise but a
 *     different place: a teleport, a track reset, an ESC-to-garage. Adopt it
 *     outright rather than crawling there over several seconds.
 */
const POS_TAU_SEC = 1.0;
const POS_SNAP_M = 50;

/** A reference lap: its ordered trace and the lap time it was set at. */
export interface Reference {
  trace: Sample[];
  lapSec: number;
  /** Whether the trace covers the whole lap (captured flag-to-flag). */
  full: boolean;
  /**
   * Whether the lap was driven inside the white lines — see {@link LapValidity}.
   * `false` on a lap with a cut, a penalty or a pit stop in it, and on any lap
   * driven while the caller could not tell us either way.
   */
  clean: boolean;
}

/**
 * What the caller knows about track limits on the lap being driven, when it
 * knows anything at all.
 *
 * ## Why the delta needs this
 * A best-lap reference the driver did not drive is worse than none. Cut the
 * first chicane at Monza and the engine timed a genuine 1:19 — the fastest lap
 * of the session, by a route that is not the circuit — adopted it as the
 * session best, wrote it to the PB store as the all-time best, and every honest
 * lap afterwards read seconds down against a lap nobody can drive. The rest of
 * the app already refuses those laps (`lapLog.ts` marks them `limits`, and the
 * weekly card and the league board both skip them); the delta was the one place
 * that took the stopwatch at its word.
 *
 * ## Counters, not verdicts
 * These are the sim's own running totals for the SESSION, and this module
 * baselines them at its own lap boundaries. That keeps the rule identical to the
 * one the lap log applies — a total that rises during a lap voids that lap —
 * without the two having to agree on where a lap begins, which they measure
 * differently (line crossings here, `lapsCompleted` there).
 *
 * Every field is optional, and a caller that omits one is saying "no
 * information", not "nothing happened". A spectated car has no such channel at
 * all, so its references behave exactly as they did before this existed.
 *
 * The charge lands up to ~25 s after the cut that earned it (the sim flushes its
 * log a block at a time), so a cut in the last corner can be counted against the
 * lap that follows it. That is the same imprecision the lap log documents and
 * accepts, and it fails the safe way round for a reference: the worst case is a
 * clean lap declined, which the next clean lap replaces, rather than a cut lap
 * kept — which lasts until someone deletes a file.
 */
export interface LapValidity {
  /**
   * Cuts the sim has CHARGED for this session. Not our own geometry estimate —
   * the stewards' count, as `trackLimits.charged` publishes it.
   */
  cuts?: number;
  /** The sim's outstanding-penalty count for this car. */
  penalties?: number;
  /** `true` while the car is in the pit lane or its garage stall. */
  inPit?: boolean;
}

/**
 * Slew-limited low-pass filter for one delta channel, clocked on the lap time
 * axis (so it behaves identically regardless of frame rate). See
 * {@link SMOOTH_SLEW_SEC_PER_SEC} for why this exists.
 */
class Channel {
  private v = 0;
  private t = -1;

  /** Drop the filter state, so the next sample is taken verbatim. */
  public reset(): void {
    this.t = -1;
  }

  /** @param t - Seconds into the current lap; @param raw - unfiltered delta. */
  public step(t: number, raw: number): number {
    if (raw === UNKNOWN_VALUE) {
      this.reset();
      return UNKNOWN_VALUE;
    }
    const dt = t - this.t;
    // First sample of a lap/reference, or the clock rewound → adopt as-is.
    // Jumping straight to the true value here is correct: a new lap legitimately
    // resets the delta to ~0, and ramping into that would be the wrong lie.
    if (this.t < 0 || dt <= 0 || dt > 2) {
      this.v = raw;
      this.t = t;
      return raw;
    }
    const maxStep = SMOOTH_SLEW_SEC_PER_SEC * dt;
    const target = Math.min(this.v + maxStep, Math.max(this.v - maxStep, raw));
    this.v += (target - this.v) * (1 - Math.exp(-dt / SMOOTH_TAU_SEC));
    this.t = t;
    return round4(this.v);
  }
}

/**
 * Complementary filter for the car's position on the road — the delta engine's
 * distance axis.
 *
 * ## Why the raw REST position can't be the axis
 * `t − t_ref(d)` divides by nothing and subtracts everything: an error of `e`
 * metres in `d` lands in the readout as `e / speed` seconds, so at 60 m/s every
 * 6 m of position error is a tenth on screen. The REST feed supplies `d`, and it
 * carries three separate errors of exactly that size:
 *
 *   1. Its snapshots are published at the game's own rate and arrive over HTTP,
 *      so what lands is 5–85 ms stale by an amount that varies packet to packet.
 *      Extrapolating by the snapshot's *measured* age (arrival → now) can't
 *      remove the part that happened before arrival, so `d` jitters by metres.
 *   2. That leftover staleness is proportional to speed, so it is not a constant
 *      offset that cancels between the live lap and the reference lap — it is a
 *      bias that changes shape around the lap. Measured at −0.06 s mean on a lap
 *      driven identically to its own reference, drifting through the corners.
 *   3. Each arrival lands as a step, so the readout twitches at the poll rate.
 *
 * ## What this does instead
 * The classic complementary split. High-frequency motion is *integrated* from
 * the car's own speed — shared memory, same buffer and same instant as the delta
 * clock, no network in between — which is smooth and exactly coherent with the
 * time axis. The REST position is used only to correct slow drift, pulled in
 * over {@link POS_TAU_SEC}, which low-passes its noise away.
 *
 * Because the prediction step uses live speed, there is no steady-state lag to
 * pay for that long time constant: the observer tracks a constant speed
 * perfectly and only its (tiny) accumulated drift is corrected slowly. What lag
 * does remain under acceleration is identical on the live lap and on the
 * reference lap — both are recorded through this same filter — so it cancels in
 * the subtraction instead of showing up as sway.
 */
export class RoadPosition {
  /** Estimated metres into the current lap; `-1` before the first fix. */
  private dist = -1;
  /** Sim clock at the last step; `-1` before the first. */
  private t = -1;

  /** Drop the estimate, so the next measurement is adopted verbatim. */
  public reset(): void {
    this.dist = -1;
    this.t = -1;
  }

  /**
   * @param t         - Sim clock (`mElapsedTime`, seconds). Clocking on the sim
   *                    rather than on wall time means a paused game freezes the
   *                    observer instead of coasting it forward.
   * @param measuredM - REST lap distance, already extrapolated to `t` by the
   *                    caller (metres into the lap).
   * @param speedMps  - The car's live speed from shared memory (m/s).
   * @param trackLenM - Lap length in metres, for wrapping at the line.
   * @returns Metres into the lap, `0..trackLenM`.
   */
  public step(t: number, measuredM: number, speedMps: number, trackLenM: number): number {
    if (!(trackLenM > 1) || !Number.isFinite(measuredM)) return measuredM;
    const m = wrapDist(measuredM, trackLenM);
    const dt = t - this.t;
    const armed = this.dist >= 0 && this.t >= 0;
    // The clock stood still (a torn shared-memory read re-served the previous
    // sample). Nothing has been observed, so hold — re-seeding here would throw
    // the whole estimate away and adopt the raw measurement, which is exactly
    // the noise this filter exists to reject, on every torn frame.
    if (armed && dt === 0) return this.dist;
    // First fix, or a gap long enough that the integration would be guesswork
    // (feed dropout, session change, unpause) → take the measurement as truth.
    if (!armed || dt < 0 || dt > 1) {
      this.dist = m;
      this.t = t;
      return m;
    }
    this.t = t;
    const v = Number.isFinite(speedMps) ? Math.min(150, Math.max(0, speedMps)) : 0;
    let d = wrapDist(this.dist + v * dt, trackLenM);
    // Shortest way round from the prediction to the measurement, so a
    // disagreement across the start/finish line reads as centimetres, not a lap.
    const half = trackLenM / 2;
    let err = m - d;
    if (err > half) err -= trackLenM;
    else if (err < -half) err += trackLenM;
    d =
      Math.abs(err) > POS_SNAP_M
        ? m
        : wrapDist(d + err * (1 - Math.exp(-dt / POS_TAU_SEC)), trackLenM);
    this.dist = d;
    return d;
  }
}

/** Fold a lap distance into `0..len`. */
function wrapDist(d: number, len: number): number {
  const laps = d / len;
  return (laps - Math.floor(laps)) * len;
}

/**
 * Maintains the three reference laps for the driven car and computes both
 * delta flavours against each on every physics sample.
 */
export class LocalPaceDeltaTracker {
  /** Lap fraction seen last poll; `-1` before the first sample. */
  private prevD = -1;
  /** Sim clock at the poll that produced {@link prevD}; `-1` before the first. */
  private prevElapsed = -1;
  /** Sim clock (`mElapsedTime`) at the current lap's start; `-1` until known. */
  private lapStartElapsed = -1;
  /**
   * Whether the lap now being recorded began at an observed start/finish
   * crossing. False for the very first lap after start-up or a reset, which
   * begins wherever the car happened to be when the overlay attached.
   *
   * This gate is load-bearing. Without it, joining a session mid-lap and driving
   * to the line produced a "lap" whose duration was just the length of that
   * fragment — a half lap timed 48 s — which then beat the real 94 s best on
   * `lapSec <` and was adopted as session best AND persisted as the all-time
   * best, destroying the genuine PB on disk. Every delta afterwards read as
   * unknown, because a fragment's trace only covers part of the lap and its
   * times are measured from a start line it never crossed.
   */
  private fromLine = false;
  private samples: Sample[] = [];
  /** One output filter per delta channel, in {@link compute}'s order. */
  private readonly filters = {
    tSession: new Channel(),
    tAllTime: new Channel(),
    tLast: new Channel(),
    vSession: new Channel(),
    vAllTime: new Channel(),
    vLast: new Channel(),
  };

  /**
   * Faults collected since the current lap crossed the line, and the counter
   * readings it started from. `null` baselines mean the caller has not told us
   * anything yet — see {@link LapValidity}.
   */
  private lapDirty = false;
  private cutsAtStart: number | null = null;
  private penaltiesAtStart: number | null = null;

  private session: Reference | null = null;
  private allTime: Reference | null = null;
  private last: Reference | null = null;
  private lastLapSec: number = UNKNOWN_VALUE;
  /** The last answer given, re-served whenever the sim clock doesn't advance. */
  private lastOut: PaceDeltas = EMPTY_PACE_DELTAS;

  /** Track key the all-time best was loaded for (reloads on track change). */
  private trackKey = '';

  private reset(): void {
    this.prevD = -1;
    this.prevElapsed = -1;
    this.lapStartElapsed = -1;
    this.fromLine = false;
    this.samples = [];
    this.resetFilters();
    this.session = null;
    this.last = null;
    this.lastLapSec = UNKNOWN_VALUE;
    this.lastOut = EMPTY_PACE_DELTAS;
    this.startLapValidity();
    // allTime is NOT cleared on a session reset — it spans sessions.
  }

  /**
   * Begin a lap with a clean sheet, and no baseline until the caller next says
   * what the counters read.
   *
   * Re-baselining is deliberately NOT done from the last known values: a session
   * change zeroes the sim's counters, and a baseline carried across that would
   * read the zeroing as "the count went down" on one lap and then charge the
   * next lap for every cut of the previous session as the total climbed back.
   */
  private startLapValidity(): void {
    this.lapDirty = false;
    this.cutsAtStart = null;
    this.penaltiesAtStart = null;
  }

  /**
   * Fold one poll's validity reading into the lap being driven.
   *
   * A counter that has risen since this lap began is a fault ON this lap. The
   * first reading of a lap only sets the baseline — it cannot itself be a rise,
   * which is what stops every lap after a cut inheriting the blame for it.
   */
  private noteValidity(v: LapValidity | undefined): void {
    if (!v) return;
    if (v.inPit === true) this.lapDirty = true;
    const cuts = countOf(v.cuts);
    if (cuts !== null) {
      if (this.cutsAtStart === null) this.cutsAtStart = cuts;
      else if (cuts > this.cutsAtStart) this.lapDirty = true;
    }
    const pens = countOf(v.penalties);
    if (pens !== null) {
      if (this.penaltiesAtStart === null) this.penaltiesAtStart = pens;
      else if (pens > this.penaltiesAtStart) this.lapDirty = true;
    }
  }

  private resetFilters(): void {
    for (const f of Object.values(this.filters)) f.reset();
  }

  /**
   * Delta engine time axis = the sim's real-time session clock `mElapsedTime`
   * (shared memory), NOT REST `timeIntoLap`. `timeIntoLap` turned out to be a
   * position-derived estimate (identical for every lap at a given distance), so
   * comparing laps against it always yields ~0. `mElapsedTime` ticks 1:1 with
   * real time, so time-into-lap genuinely differs between fast and slow laps.
   * Lap boundaries are detected by the lap-distance fraction wrapping past the
   * start/finish line — `mLapStartET`/`lapsCompleted` are not needed.
   *
   * @param d          - Road position as a lap fraction `0..1`, from the caller's
   *                     {@link RoadPosition} observer. It must be that filtered
   *                     estimate and not a raw REST reading: the reference trace
   *                     is built from these same values, so live and reference
   *                     positions only cancel each other's lag if both come off
   *                     the same filter.
   * @param elapsedSec - Sim `mElapsedTime` (seconds), a monotonic real-time clock.
   * @param restBest   - REST `bestLapTime`, for out-lap plausibility guarding.
   * @param trackKey   - Stable per-track-and-car id for persistence; build it
   *                     with {@link refKeyOf}. A change of key reloads the
   *                     all-time best, so swapping cars mid-session adopts the
   *                     right reference without a restart.
   */
  public update(
    d: number,
    elapsedSec: number,
    restBest: number,
    trackKey: string,
    lap?: LapValidity,
  ): PaceDeltas {
    const at = this.advance(d, elapsedSec, restBest, trackKey, lap);
    if (at === null) return this.lastOut;
    this.lastOut = this.compute(at.t, at.d);
    return this.lastOut;
  }

  /**
   * Feed a sample and keep the reference laps up to date, without computing the
   * deltas. For cars that are being followed but not shown — a broadcast
   * director cuts between cars constantly, and a car whose laps were only
   * recorded while the camera was on it has no reference the moment it cuts
   * back. Tracking every car costs a lap-boundary check and an occasional trace
   * point; it is {@link compute} (six interpolations over the traces) that is
   * worth skipping for the cars nobody is looking at.
   */
  public observe(
    d: number,
    elapsedSec: number,
    restBest: number,
    trackKey: string,
    lap?: LapValidity,
  ): void {
    this.advance(d, elapsedSec, restBest, trackKey, lap);
  }

  /**
   * Advance the lap state by one sample.
   * @returns The `(t, d)` to compute deltas at, or `null` when this sample
   *          produced no usable point — in which case {@link lastOut} already
   *          holds the right answer (held over, or blanked).
   */
  private advance(
    d: number,
    elapsedSec: number,
    restBest: number,
    trackKey: string,
    lap?: LapValidity,
  ): { t: number; d: number } | null {
    if (d < 0 || d > 1 || typeof elapsedSec !== 'number' || elapsedSec <= 0) {
      this.lastOut = EMPTY_PACE_DELTAS;
      return null;
    }
    // Before the boundary check below, so a cut charged on the same poll as the
    // line crossing is counted against the lap that is ENDING. The sim's charge
    // is already late by the time we see it (see {@link LapValidity}), so the
    // lap just driven is the likelier owner of it — and of the two ways to be
    // wrong, declining a clean lap costs one lap and keeping a cut one costs
    // every delta until the file is deleted.
    this.noteValidity(lap);

    // Track change → (re)load the persisted all-time best for the new track.
    if (trackKey && trackKey !== this.trackKey) {
      this.trackKey = trackKey;
      this.allTime = loadAllTime(trackKey);
    }

    // Session restart / return-to-garage → the sim clock rewinds; start over.
    if (this.lapStartElapsed >= 0 && elapsedSec + 1 < this.lapStartElapsed) this.reset();

    // The clock did not advance since the last poll: shared memory was read
    // mid-write and the caller re-served its previous sample, or the sim is
    // paused. Running the delta anyway would compare a frozen `t` against a
    // position that is still moving, so the readout falls at a full second per
    // second and snaps back when the clock catches up. At a few percent of torn
    // reads that alone was ±0.09 s of twitch, frame to frame. Hold instead.
    if (this.prevElapsed >= 0 && elapsedSec <= this.prevElapsed) return null;

    // A long gap: the car was in the garage, or dropped out of the feed, or the
    // provider stopped feeding it. Whatever the in-progress lap was, it is not a
    // lap any more — its start is minutes behind and the car has been moved
    // since. Re-anchor here and let the next line crossing start a real one,
    // rather than carrying a stale `lapStartElapsed` that puts every delta past
    // the sanity limit until the car happens to cross the line again.
    if (this.prevElapsed >= 0 && elapsedSec - this.prevElapsed > 5) {
      this.samples = [];
      this.lapStartElapsed = elapsedSec;
      this.prevD = d;
      this.fromLine = false;
      this.resetFilters();
    }

    if (this.lapStartElapsed < 0) {
      this.lapStartElapsed = elapsedSec;
      this.prevD = d;
      this.prevElapsed = elapsedSec;
    }

    // Lap boundary: the distance fraction wrapped from near-1 back to near-0
    // (crossed the start/finish line). The crossing happened BETWEEN this poll
    // and the last one, so interpolate when: of the ground covered since the
    // previous sample, the share driven before the line is (1 − prevD). Taking
    // the crossing at poll time instead would shift every lap's whole time axis
    // by a random 0..1 poll interval — a constant per-lap offset of up to
    // ~150 ms that shows up as the delta being "wrong by a tenth or two" from
    // the moment a new lap starts.
    if (this.prevD > 0.5 && d < this.prevD - 0.5) {
      const before = 1 - this.prevD;
      const covered = before + d;
      const frac = covered > 0 ? before / covered : 0;
      const crossET = this.prevElapsed + (elapsedSec - this.prevElapsed) * frac;
      // Only a lap that BEGAN at a line crossing is a lap. The first "lap" after
      // the overlay starts (or after any reset) begins wherever the car happened
      // to be, so its duration is the length of a fragment, not a lap time — see
      // {@link fromLine}.
      if (this.fromLine) this.onLapComplete(crossET - this.lapStartElapsed, restBest, trackKey);
      this.samples = [];
      this.lapStartElapsed = crossET;
      this.fromLine = true;
      this.startLapValidity(); // the new lap starts on a clean sheet
      this.resetFilters(); // the delta legitimately snaps to ~0 on a new lap
    }
    this.prevD = d;
    this.prevElapsed = elapsedSec;

    const t = elapsedSec - this.lapStartElapsed; // real seconds into the lap
    if (t < 0) {
      this.lastOut = EMPTY_PACE_DELTAS;
      return null;
    }

    // Record forward progress, decimated to ~0.2% of a lap between samples.
    // Every frame is a candidate: `d` is now the observer's estimate rather than
    // a raw REST reading, so a frame that happens to coincide with a packet is
    // no better a sample than any other — and taking whichever frame first
    // crosses the decimation step gives a trace with even spacing, which is what
    // {@link interpTime} interpolates cleanly between.
    const prev = this.samples[this.samples.length - 1];
    if (prev === undefined || (d > prev.d + 0.002 && t >= prev.t)) {
      this.samples.push({ d, t });
    }

    return { t, d };
  }

  /**
   * Consider the just-completed lap for each reference role.
   * @param lapSec - The completed lap's real duration (sim-clock delta).
   */
  private onLapComplete(lapSec: number, restBest: number, trackKey: string): void {
    const first = this.samples[0];
    const lastPt = this.samples[this.samples.length - 1];
    // REST updates at ~5-7 Hz, so the first sample after the line may sit at
    // d≈0.01 and the last one before it at d≈0.9..0.99; accept that as covering
    // the lap end to end. A trace that does NOT start near the line cannot be a
    // reference: its times are measured from a start it never crossed.
    if (
      this.samples.length < 8 ||
      first === undefined ||
      lastPt === undefined ||
      first.d > 0.05 ||
      lastPt.d < 0.9
    ) {
      return;
    }

    // Reject anything that isn't a real flying lap. Both directions matter:
    // too SLOW is an out-lap, a crawl or a lap with a stop in it; too FAST means
    // the trace is a fragment (a mid-lap join, a teleport, a track reset) whose
    // duration is not a lap time at all. Only the slow side used to be checked,
    // which is how a 48 s half-lap beat a genuine 94 s best.
    const haveBest = restBest > 5 && restBest < 600;
    if (lapSec <= 5 || lapSec >= 3600) return;
    if (haveBest && (lapSec > restBest * 1.4 || lapSec < restBest * 0.7)) return;

    const trace = this.samples.slice().sort((a, b) => a.d - b.d);
    // A hole in the trace means the car left the road and was replaced on it
    // (or the feed dropped out); interpolating across it would invent a pace it
    // never ran, so the lap is not usable as a reference.
    for (let i = 1; i < trace.length; i++) {
      if (trace[i]!.d - trace[i - 1]!.d > 0.1) return;
    }

    const ref: Reference = { trace, lapSec, full: true, clean: !this.lapDirty };

    // Last lap: always the most recent usable lap, cut or not. LAST is a
    // description of what just happened rather than a claim about it — a driver
    // who ran wide still wants to know what the lap cost them, and blanking the
    // column would answer a different question than the one it asks.
    this.last = ref;
    this.lastLapSec = lapSec;

    // The two BESTS are claims, and a lap that left the circuit cannot support
    // one. Cutting the first chicane at Monza sets a time no clean lap can beat,
    // and adopting it here poisons the session best AND writes it to the PB
    // store as the all-time best — every honest lap afterwards reading seconds
    // down against a route that is not the track. See {@link LapValidity}.
    if (!ref.clean) return;
    if (!this.session || lapSec < this.session.lapSec) this.session = ref;
    if (!this.allTime || lapSec < this.allTime.lapSec) {
      this.allTime = ref;
      if (trackKey) saveAllTime(trackKey, ref);
    }
  }

  /**
   * Compute all six deltas at the current (t, d), each conditioned by its own
   * {@link Channel} so the readout moves at a physically believable rate.
   */
  private compute(t: number, d: number): PaceDeltas {
    const f = this.filters;
    const tSession = f.tSession.step(t, deltaT(this.session, t, d));
    const tAllTime = f.tAllTime.step(t, deltaT(this.allTime, t, d));
    const tLast = f.tLast.step(t, deltaT(this.last, t, d));
    const predictedLapSec =
      this.session && tSession !== UNKNOWN_VALUE ? round2(this.session.lapSec + tSession) : UNKNOWN_VALUE;
    return {
      tSession,
      tAllTime,
      tLast,
      vSession: f.vSession.step(t, deltaV(this.session, t, d)),
      vAllTime: f.vAllTime.step(t, deltaV(this.allTime, t, d)),
      vLast: f.vLast.step(t, deltaV(this.last, t, d)),
      predictedLapSec,
      // Only once a crossing has been seen. Before that the lap "started" where
      // the car happened to be when we attached, and publishing that as an
      // elapsed lap time would read seconds short — the very fault it exists to
      // fix.
      lapTimeSec: this.fromLine ? round2(t) : UNKNOWN_VALUE,
      refSessionSec: this.session ? round2(this.session.lapSec) : UNKNOWN_VALUE,
      refAllTimeSec: this.allTime ? round2(this.allTime.lapSec) : UNKNOWN_VALUE,
      lastLapSec: this.lastLapSec === UNKNOWN_VALUE ? UNKNOWN_VALUE : round2(this.lastLapSec),
    };
  }
}

/* ------------------------------- delta math ------------------------------- */

/** Delta T: time delta at the same track position (`t_now − t_ref(d_now)`). */
function deltaT(ref: Reference | null, t: number, d: number): number {
  if (!ref || ref.trace.length < 2) return UNKNOWN_VALUE;
  const refT = interpTime(ref.trace, d);
  if (refT < 0) return UNKNOWN_VALUE;
  const delta = t - refT;
  if (Math.abs(delta) > SANE_LIMIT_SEC) return UNKNOWN_VALUE;
  return round4(delta);
}

/**
 * Delta V: progress delta at the same elapsed time. At time `t_now`, find how
 * far along the reference lap was (`d_ref`) and compare to the current road
 * position; convert the lap-fraction gap to seconds via the reference pace.
 * Negative = further along than the reference at this instant (ahead).
 */
function deltaV(ref: Reference | null, t: number, d: number): number {
  if (!ref || ref.trace.length < 2) return UNKNOWN_VALUE;
  const dRef = interpDist(ref.trace, t);
  if (dRef < 0) return UNKNOWN_VALUE;
  const delta = (dRef - d) * ref.lapSec;
  if (Math.abs(delta) > SANE_LIMIT_SEC) return UNKNOWN_VALUE;
  return round4(delta);
}

/**
 * Linear-interpolate the reference lap's time at distance fraction `d`.
 * Returns `-1` when `d` is OUTSIDE the trace's covered span (so a partial
 * reference never compares against a span edge and produces nonsense).
 */
function interpTime(ref: Sample[], d: number): number {
  const n = ref.length;
  const EDGE = 0.005; // float noise tolerance at the span edges (~0.5% of a lap)
  if (d < ref[0]!.d - EDGE || d > ref[n - 1]!.d + EDGE) return -1;
  if (d <= ref[0]!.d) return ref[0]!.t;
  if (d >= ref[n - 1]!.d) return ref[n - 1]!.t;
  // Binary search for the first sample at or past `d`. The trace is sorted by
  // `d` and ~500 samples long, and this runs six times a frame — a scan from
  // the front was ~1,500 iterations a frame to find what nine compares find.
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ref[mid]!.d >= d) hi = mid;
    else lo = mid + 1;
  }
  const b = ref[lo]!;
  const a = ref[lo - 1]!;
  const span = b.d - a.d;
  return span <= 0 ? a.t : a.t + (b.t - a.t) * ((d - a.d) / span);
}

/**
 * Linear-interpolate the reference lap's distance fraction at time `t`. The
 * trace is sorted by `d`, and `t` rises monotonically with `d`, so it is also
 * sorted by `t`. Returns `-1` when `t` is outside the covered time span.
 */
function interpDist(ref: Sample[], t: number): number {
  const n = ref.length;
  const EDGE = 0.05; // seconds of tolerance at the span edges
  if (t < ref[0]!.t - EDGE || t > ref[n - 1]!.t + EDGE) return -1;
  if (t <= ref[0]!.t) return ref[0]!.d;
  if (t >= ref[n - 1]!.t) return ref[n - 1]!.d;
  // Binary search — same argument as interpTime: sorted by `t` too (the doc
  // note above), so the first-at-or-past sample is nine compares away.
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ref[mid]!.t >= t) hi = mid;
    else lo = mid + 1;
  }
  const b = ref[lo]!;
  const a = ref[lo - 1]!;
  const span = b.t - a.t;
  return span <= 0 ? a.d : a.d + (b.d - a.d) * ((t - a.t) / span);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * A session counter as a number, or `null` when the caller has no reading.
 *
 * The sentinel matters: these channels publish {@link UNKNOWN_VALUE} when there
 * is no source for them (plain rF2, an LMU install whose log directory could not
 * be found), and treating that as a count would make the step up to a real zero
 * look like a cut.
 */
function countOf(v: number | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return v;
}

/**
 * Round to 4 decimals. This is the wire precision, deliberately finer than the
 * widgets' 2-decimal display: the filters in {@link Channel} integrate over
 * successive frames, so rounding the transported value to display precision
 * would quantise their input and reintroduce visible stepping.
 */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/* ---------------------------- all-time persistence ------------------------ */

/** Directory holding persisted per-track all-time-best traces. */
export function pbDir(): string {
  return path.join(os.homedir(), '.apex-overlay', 'pb');
}

function pbFile(trackKey: string, dir: string): string {
  return path.join(dir, `${trackKey}.json`);
}

/**
 * Load a persisted all-time-best reference for a track, or `null`.
 *
 * The directory is injectable for the same reason the track-map cache's is: a
 * test that exercises the PB store must never read or write the driver's own.
 */
export function loadAllTime(trackKey: string, dir = pbDir()): Reference | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pbFile(trackKey, dir), 'utf8'));
    if (
      raw &&
      Array.isArray(raw.trace) &&
      raw.trace.length >= 2 &&
      typeof raw.lapSec === 'number' &&
      raw.lapSec > 5
    ) {
      const trace: Sample[] = raw.trace
        .filter((s: unknown): s is Sample => {
          const p = s as Sample;
          return p && typeof p.d === 'number' && typeof p.t === 'number';
        })
        .sort((a: Sample, b: Sample) => a.d - b.d);
      // Reject a stored fragment. Files written before the mid-lap-join bug was
      // fixed can hold a partial trace (e.g. a 48 s half lap saved as an
      // all-time best); loading one would make every delta read as unknown, and
      // it would never be replaced because nothing can beat an impossible time.
      const from = trace[0]!.d;
      const to = trace[trace.length - 1]!.d;
      // …and reject one that does not SAY it was driven inside the white lines.
      // Files written before track limits were considered here cannot say, and
      // the ones worth worrying about are exactly the fast ones: a lap that cut
      // is a lap nothing clean will ever beat, so it would sit in this file
      // forever, poisoning every delta, with no way for a driver to know that
      // the fix is a file they have never heard of. One clean flying lap writes
      // a marked one back, which is the same price the key change in
      // {@link refKeyOf} charged for the same kind of repair.
      if (raw.clean !== true) return null;
      if (trace.length >= 8 && from <= 0.05 && to >= 0.9) {
        return { trace, lapSec: raw.lapSec, full: true, clean: true };
      }
    }
  } catch {
    /* first run on this track, or unreadable — no persisted best */
  }
  return null;
}

/** Persist an all-time-best reference for a track (best-effort). */
export function saveAllTime(trackKey: string, ref: Reference, dir = pbDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pbFile(trackKey, dir), JSON.stringify(ref), 'utf8');
  } catch {
    /* non-fatal — persistence is a convenience, not required for live delta */
  }
}

/** Lower-case, strip to `[a-z0-9-]`, trim dashes, cap the length. */
function slug(value: string, maxLen: number): string {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

/** Build a filesystem-safe per-track key from its name and length. */
export function trackKeyOf(trackName: string, lapDistanceM: number): string {
  const name = slug(trackName || 'unknown', 48);
  const len = lapDistanceM > 1 ? Math.round(lapDistanceM) : 0;
  return `${name || 'unknown'}_${len}`;
}

/**
 * Build the key the all-time-best reference is stored under: the track AND the
 * car.
 *
 * ## Why the car has to be in the key
 * It was track-only, and that made the all-time delta actively misleading in
 * the one situation this league runs in constantly — a multiclass field. Drive
 * a Hypercar at Spa, come back in a GT3, and the GT3's "all-time best" delta
 * was measured against the Hypercar's lap: permanently ~10 s in the red, its
 * distance→time trace shaped by a car with completely different braking points.
 * A delta bar that is wrong in a fixed direction is worse than no delta bar,
 * because the driver stops reading it.
 *
 * Note this is deliberately keyed per **car model**, while the league
 * leaderboard is keyed per **class**. They are different jobs: a board wants
 * times that are comparable between drivers, a delta wants the closest possible
 * reference to the lap you are actually driving. Keying both the same way would
 * make one of them worse.
 *
 * @param carName - Car model from the Scoring buffer (`mVehicleName`). Falls
 *                  back to the car's class, then to `unknown`: spectating and
 *                  rF2-without-koffi have no model name, and one shared
 *                  `unknown` bucket per track is exactly the old behaviour —
 *                  no worse than before, and it self-corrects the moment shared
 *                  memory answers.
 *
 * Changing this key orphans the PB traces saved under the old track-only names.
 * That is intended: those files hold whichever car happened to set the time, so
 * there is nothing in them worth migrating. The first flying lap in each car
 * writes a correct one.
 */
export function refKeyOf(
  trackName: string,
  lapDistanceM: number,
  carName: string,
  carClass?: string,
): string {
  const car = slug(carName, 40) || slug(carClass || '', 40) || 'unknown';
  return `${trackKeyOf(trackName, lapDistanceM)}__${car}`;
}
