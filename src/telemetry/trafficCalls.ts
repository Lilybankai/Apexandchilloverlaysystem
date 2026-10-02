/**
 * @file src/telemetry/trafficCalls.ts
 * @module telemetry/trafficCalls
 *
 * **Timed traffic calls** — the race engineer telling a multiclass driver *when*
 * traffic arrives, not just that it exists:
 *
 * - `trafficBehind` — a FASTER class is coming through: "Hypercar behind, with
 *   you in about 7 seconds."
 * - `trafficAhead` — SLOWER-class backmarkers you are catching: "Two GT3s
 *   ahead, you'll be on them in about 6 seconds."
 *
 * The owner's brief was blunt: *a wrong traffic call is worse than none*. So
 * this module is mostly a list of reasons to stay quiet, and every number it
 * speaks is a time-to-contact that has been **measured, cross-checked and held
 * steady** before it is allowed out.
 *
 * ## Why time-to-contact, and never the gap
 * The relative gap LMU gives us comes from two different sources (see
 * `lmuRestProvider.buildRelative`): the sim's own timing when both cars are on
 * the overall leader's lap, and a road-distance model when either is lapped —
 * which in a multiclass race is every GT3 after a few minutes. The second is
 * right about *where* a car is but its seconds are scaled by the player's lap
 * time, up to ±50% off as a gap. A gap read out loud would be wrong exactly
 * when traffic matters most. Time-to-contact (gap ÷ closing rate) carries the
 * same scale top and bottom, so it cancels — as long as the source does not
 * change mid-approach, which restarts the history.
 *
 * ## Where the gap comes from: the player's own lap clock first
 * Distance gaps "breathe" with the corners (100 m is 1 s on a straight and 3 s
 * in a hairpin), so a lapped car's gap swings by seconds as one car brakes and
 * the other does not — nothing steady can be fitted to it, and the gates below
 * refuse it. So once the player has driven one clean lap, every car's gap is
 * re-measured on {@link LapClock}: "how long until I am where it is now", in the
 * player's own lap time, from the standings' lap fractions — smooth, correct
 * whichever car is lapped, and covering the whole field rather than the
 * relative's three each way. The relative feed's gap is only the fallback.
 *
 * ## Why the closing rate is measured here, not read off the feed
 * `RelativeEntry.closingRateSec` is differenced over 800 ms. Measured on the
 * 2026-08-19 recording, even the sim-timed gap wobbles ~0.07–0.11 s RMS around
 * its trend, correlated over ~2 s on a ~10–15 s corner rhythm — so an 800 ms
 * rate swings ±0.2 s/s on cars truly closing at ~0.1 s/s. Here the rate is a
 * least-squares slope over {@link RATE_WINDOW_SEC}, blended with the rate the
 * two cars' lap times imply, and the gap it divides is the fitted value.
 *
 * ## The gates, in the order they bite
 * 1. **Who**: a different, *recognised* class (same class = a rival, not
 *    traffic; unknown = we can't say "faster"), not in the pit lane, garage or
 *    retired, on the right side (faster car BEHIND, slower car AHEAD), within
 *    {@link TRACK_MAX_GAP_SEC}; green flag, player out of the pits.
 * 2. **Clean history**: any feed gap, sample jump (start/finish wrap, the
 *    provider switching gap source), sign flip (a pass) or source change
 *    restarts the history — nothing is extrapolated across a discontinuity.
 * 3. **A real trend**: ≥ {@link RATE_MIN_SPAN_SEC} of samples, closing at ≥
 *    {@link MIN_CLOSING_RATE}, fit residual ≤ {@link MAX_FIT_RMS_SEC}, the
 *    latest raw reading agreeing with the fit.
 * 4. **Pace agrees**: both cars need a lap time, and the measured rate must be
 *    the size those lap times say ({@link PACE_AGREE_LOW}–{@link PACE_AGREE_HIGH}×).
 * 5. **Fast enough to time**: ≥ {@link MIN_CALL_RATE}. TTC error grows as
 *    1/rate; an LMP2 on a Hypercar (~4%) is never timed out loud.
 * 6. **A steady prediction**: the predicted *moment* of contact (wall clock, not
 *    a countdown) has held within ±max({@link STEADY_ABS_SEC}, {@link STEADY_REL}
 *    × TTC) for {@link STEADY_SEC}. A countdown that jumps is not a prediction.
 * 7. **In the window**: TTC inside [{@link CALL_MIN_TTC_SEC},
 *    {@link CALL_MAX_TTC_SEC}], with no un-timed traffic nearer than the car
 *    being called (or "first with you" would be a lie).
 * 8. **Not already there**: no radar blip for the car alongside or within
 *    {@link RADAR_NEAR_M} — never say what is in the mirror (checked again when
 *    the line is phrased).
 * 9. **Once per car per approach**: a car stays "called" — by this module or by
 *    the blue flag (`yieldTo`), which asks {@link TrafficCallTracker.claims} —
 *    until it has been out of the picture for {@link REARM_SEC}.
 *
 * ## The blue flag stays the first word on a faster car
 * `yieldTo` fires when a faster car is 3 s back — earlier than any countdown
 * here, and on a measured gap rather than a prediction — so for the usual lone
 * Hypercar it remains THE call, gaining "With you into sector N." only when
 * {@link contactSector} can place it. `trafficBehind` times the cars the blue
 * flag did not name: the second and third of a Hypercar train, or a car that
 * arrives inside the blue flag's 60 s cooldown.
 *
 * ## What the driver hears
 * A whole-second "about N" that is right when it is HEARD: the countdown is
 * recomputed at the cue's emit time and {@link SPEECH_LEAD_SEC} comes off it.
 * Validation (scripts/test-traffic.js --replay / --inject): with real LMU gap
 * noise over a steady 0.1–0.15 s/s approach, ~75–87% of calls land within 2 s;
 * if the true closing rate swings ±15% around the lap, ~70–77%; ±30%, ~25–50%
 * — variation no estimator can see coming. Only a live multiclass recording can
 * say which world LMU is.
 *
 * Pure and headless like its siblings: no audio, no I/O, no clock of its own.
 */

import { UNKNOWN_VALUE } from './types';
import type { RadarBlip, StandingEntry, TelemetryFrame } from './types';
import { isFasterClass, normalizeClass } from './carClass';

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** Ignore cars further than this, seconds of relative gap. */
export const TRACK_MAX_GAP_SEC = 6;
/** The gap at which a car counts as "with you" / "on them", seconds. */
export const CONTACT_GAP_SEC = 0.5;
/** Least-squares window for the closing rate, seconds. */
export const RATE_WINDOW_SEC = 10;
/** The window must actually span this much before a rate is believed, seconds. */
export const RATE_MIN_SPAN_SEC = 8;
/** …and hold at least this many samples. */
export const RATE_MIN_SAMPLES = 10;
/** Samples are kept no denser than this, seconds (live frames arrive at 30 Hz). */
export const SAMPLE_EVERY_SEC = 0.1;
/** Slowest closing worth predicting, seconds of gap per second. */
export const MIN_CLOSING_RATE = 0.04;
/**
 * Slowest closing that is ever CALLED. Time-to-contact error grows as 1/rate
 * (the gap's own wobble divided by the rate), so slow approaches — an LMP2
 * reeling in an LMP2-ELMS, a Hypercar on an LMP2 (~3–4%) — are tracked but
 * never timed out loud.
 */
export const MIN_CALL_RATE = 0.08;
/** The raw gap may stray this far from the fitted trend (or 2×RMS), seconds. */
export const RAW_FIT_TOL_SEC = 0.15;
/** The raw gap must still be this much beyond contact, seconds. */
export const RAW_MARGIN_SEC = 0.2;
/** "Closing fast" in the line — well beyond a normal class differential. */
export const FAST_CLOSING_RATE = 0.2;
/** Worst RMS residual of the gap around its fitted trend, seconds. */
export const MAX_FIT_RMS_SEC = 0.12;
/** How long the predicted contact moment must have held steady, seconds. */
export const STEADY_SEC = 2;
/** Allowed wander of the predicted contact moment: absolute floor, seconds… */
export const STEADY_ABS_SEC = 1;
/** …or this fraction of the time-to-contact, whichever is larger. */
export const STEADY_REL = 0.2;
/** Sample-to-sample gap step that means a discontinuity, not motion, seconds. */
export const JUMP_SEC = 0.5;
/** A feed silence longer than this restarts a car's history, seconds. */
export const MAX_SAMPLE_GAP_SEC = 1;
/**
 * Earliest and latest time-to-contact OFFERED, seconds. The trigger layer's
 * coalesce (1.5 s) and the speech lead ({@link SPEECH_LEAD_SEC}) come off
 * before the number is heard, so this window is heard as roughly "about 3"
 * to "about 7".
 */
export const CALL_MIN_TTC_SEC = 6;
export const CALL_MAX_TTC_SEC = 10;
/**
 * Seconds from a cue's emit to the driver HEARING the number: Piper's
 * synthesis plus the ~6 words spoken before it ("Hypercar behind, with you in
 * about…"). Taken off the countdown so the number is right when it lands.
 * An estimate — Piper latency has not been measured on a race PC.
 */
export const SPEECH_LEAD_SEC = 2;
/** Below this (after the lead) the countdown is stale and nothing is said, seconds. */
export const MIN_SPOKEN_TTC_SEC = 2.5;
/** Cars this close in gap to the called one are named in the same line, seconds. */
export const GROUP_GAP_SEC = 1;
/** A radar blip of the car this close (or alongside) means it is already there, metres. */
export const RADAR_NEAR_M = 20;
/** A car must be out of the picture this long before it can be called again, seconds. */
export const REARM_SEC = 30;
/** Pace cross-check: measured rate must be within these multiples of the pace rate. */
export const PACE_AGREE_LOW = 0.5;
export const PACE_AGREE_HIGH = 1.6;
/** …with this absolute slack, seconds per second. */
export const PACE_AGREE_SLACK = 0.02;
/** Weight of the lap-time closing rate in the TTC, once it agrees (see {@link TrafficTune}). */
export const PACE_BLEND = 0.5;
/** Location: widen the TTC by this fraction each side before naming a sector… */
export const LOCATION_REL = 0.35;
/** …plus this many seconds of the player's own pace wobble. */
export const LOCATION_ABS_SEC = 2;

/* -------------------------------------------------------------------------- */
/*  Types                                                                       */
/* -------------------------------------------------------------------------- */

export type TrafficCallKind = 'trafficBehind' | 'trafficAhead';

/** One call the tracker wants made — the trigger layer gates and words it. */
export interface TrafficCall {
  kind: TrafficCallKind;
  /** Every car named by the line, nearest first. */
  slots: number[];
  /** Tuning-log rendering — never the engineer's words. */
  detail: string;
  /** Small, pre-bucketed facts for the phrase layer. */
  facts: Record<string, string | number | boolean>;
}

/** Tracker options. `classAgnostic` exists for the replay validator only. */
export interface TrafficCallOptions {
  /**
   * Treat every car as traffic regardless of class (same class included) —
   * ONLY so `scripts/test-traffic.js --replay` can measure prediction accuracy
   * on a single-class recording. Never set in the app.
   */
  classAgnostic?: boolean;
  /** Override the call window (validator sweeps). */
  callMinTtcSec?: number;
  callMaxTtcSec?: number;
  /** Override the estimator's tunables (validator sweeps only). */
  tune?: Partial<TrafficTune>;
}

/** The estimator's tunables, as one overridable bundle. */
export interface TrafficTune {
  rateWindowSec: number;
  rateMinSpanSec: number;
  maxFitRmsSec: number;
  steadySec: number;
  steadyAbsSec: number;
  steadyRel: number;
  /**
   * Weight of the lap-time rate in the rate that is divided into the gap,
   * `0`..`1` (0 = measured only). Only used when both lap times exist AND the
   * two rates already agree (gate 5).
   */
  paceBlend: number;
  /** Pace cross-check band: measured rate ∈ [low·pace − slack, high·pace + slack]. */
  paceAgreeLow: number;
  paceAgreeHigh: number;
  paceAgreeSlack: number;
}

/** One other car this frame: its signed gap (s, + = ahead) and identity. */
interface Candidate {
  slotId: number;
  gap: number;
  carClass: string | undefined;
  /** In the pit lane, garage or retired — never traffic. */
  inPit: boolean;
  row: StandingEntry | undefined;
  /** Which gap source (see {@link TrafficCallTracker.candidates}). */
  sig: string;
}

/** One car's road history and its call state. */
interface CarTrack {
  /** Signed relative gap samples, t in seconds. */
  t: number[];
  g: number[];
  /** Predicted contact moments (seconds), with the time each was made. */
  estT: number[];
  estC: number[];
  /** Which gap source the provider was on (see module note). */
  sig: string;
  /** Last time this car was seen eligible, seconds. */
  seenAt: number;
  /** Set once the car has been named (by us, or by the blue-flag call). */
  called: boolean;
}

/** The current estimate for one car, when it has one. */
export interface TrafficEstimate {
  slotId: number;
  side: 'behind' | 'ahead';
  /** Fitted |gap| now, seconds. */
  gapSec: number;
  /** Closing rate, seconds per second (positive = closing). */
  rate: number;
  /** Time to contact, seconds. */
  ttcSec: number;
  /** Predicted contact moment, ms (same clock as the frames). */
  contactAtMs: number;
  /** Every gate passed (trend, steadiness, pace) — safe to speak. */
  steady: boolean;
  /** Canonical class label of the car. */
  carClass: string;
  /** Sector of contact, when it can be named (behind only — see {@link contactSector}). */
  sector?: 1 | 2 | 3;
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function known(n: number | undefined | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n !== UNKNOWN_VALUE;
}

/**
 * A believable lap time for the pace cross-check, or undefined. The recent
 * average when it is within 10% of the car's best (it tracks fuel, tyres and a
 * drying track); otherwise the best — an average polluted by an in-lap, a spin
 * or a driver swap would flip which car is "faster".
 */
function paceOf(row: StandingEntry | undefined): number | undefined {
  if (!row) return undefined;
  const best = known(row.bestLapSec) && row.bestLapSec > 20 && row.bestLapSec < 900 ? row.bestLapSec : undefined;
  const avg = row.avg5Sec;
  if (known(avg) && avg > 20 && avg < 900 && (best === undefined || avg <= best * 1.1)) return avg;
  return best;
}

/** Least-squares fit of `y` on `x`: slope, value at the last x, RMS residual. */
function fit(x: number[], y: number[], from: number): { slope: number; last: number; rms: number } {
  const n = x.length - from;
  let sx = 0;
  let sy = 0;
  for (let i = from; i < x.length; i++) {
    sx += x[i]!;
    sy += y[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = from; i < x.length; i++) {
    const dx = x[i]! - mx;
    num += dx * (y[i]! - my);
    den += dx * dx;
  }
  const slope = den > 0 ? num / den : 0;
  let res = 0;
  for (let i = from; i < x.length; i++) {
    const e = y[i]! - (my + slope * (x[i]! - mx));
    res += e * e;
  }
  return { slope, last: my + slope * (x[x.length - 1]! - mx), rms: Math.sqrt(res / n) };
}

/** How the radio says a class: "Hypercar", "LMP2", "GT3". */
export function spokenClass(cls: string, plural = false): string {
  const base =
    cls === 'HYPERCAR'
      ? 'Hypercar'
      : cls === 'LMP2_ELMS'
        ? 'LMP2'
        : cls;
  return plural ? `${base}s` : base;
}

const COUNT_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];

/* -------------------------------------------------------------------------- */
/*  The tracker                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Feed it every frame; it returns the (rare) calls worth offering to the
 * trigger layer. Stateful per car; {@link reset} on a session change.
 */
export class TrafficCallTracker {
  private readonly cars = new Map<number, CarTrack>();
  private readonly classAgnostic: boolean;
  private readonly minTtc: number;
  private readonly maxTtc: number;
  private readonly tune: TrafficTune;
  /** Last frame's estimates, for {@link claims} and the validator. */
  private readonly estimates = new Map<number, TrafficEstimate>();
  /** The player's own lap as time-at-position — see {@link LapClock}. */
  private readonly clock = new LapClock();

  public constructor(opts: TrafficCallOptions = {}) {
    this.classAgnostic = opts.classAgnostic === true;
    this.minTtc = opts.callMinTtcSec ?? CALL_MIN_TTC_SEC;
    this.maxTtc = opts.callMaxTtcSec ?? CALL_MAX_TTC_SEC;
    this.tune = {
      rateWindowSec: RATE_WINDOW_SEC,
      rateMinSpanSec: RATE_MIN_SPAN_SEC,
      maxFitRmsSec: MAX_FIT_RMS_SEC,
      steadySec: STEADY_SEC,
      steadyAbsSec: STEADY_ABS_SEC,
      steadyRel: STEADY_REL,
      paceBlend: PACE_BLEND,
      paceAgreeLow: PACE_AGREE_LOW,
      paceAgreeHigh: PACE_AGREE_HIGH,
      paceAgreeSlack: PACE_AGREE_SLACK,
      ...opts.tune,
    };
  }

  public reset(): void {
    this.cars.clear();
    this.estimates.clear();
    this.clock.reset();
  }

  /** The latest estimate per car (validator + tests). */
  public currentEstimates(): ReadonlyMap<number, TrafficEstimate> {
    return this.estimates;
  }

  /**
   * Whether this car has already been named on the radio this approach — by a
   * timed call or by the blue flag. The blue-flag (`yieldTo`) call asks this
   * so one car is never announced twice.
   */
  public claims(slotId: number | undefined): boolean {
    return slotId !== undefined && this.cars.get(slotId)?.called === true;
  }

  /**
   * What the timing can add to a blue-flag call about this car: its class and,
   * only when the whole uncertainty band lands in one sector, where it will be
   * with the player. Empty when there is no steady estimate — the blue flag
   * then goes out exactly as it always did.
   */
  public yieldFacts(slotId: number | undefined): Record<string, string | number | boolean> {
    const est = slotId === undefined ? undefined : this.estimates.get(slotId);
    if (!est || est.side !== 'behind' || !est.steady) return {};
    const out: Record<string, string | number | boolean> = { trafficClass: est.carClass };
    if (est.sector !== undefined) out.contactSector = est.sector;
    return out;
  }

  /** Record that a car has been named on the radio (by any call). */
  public markCalled(slotId: number | undefined, nowMs: number): void {
    if (slotId === undefined) return;
    const t = nowMs / 1000;
    let car = this.cars.get(slotId);
    if (!car) {
      car = { t: [], g: [], estT: [], estC: [], sig: '', seenAt: t, called: true };
      this.cars.set(slotId, car);
    }
    car.called = true;
    car.seenAt = t;
  }

  /**
   * Advance one frame. Returns the calls to offer (usually none). Calls are
   * NOT marked as made here — the trigger layer does that via
   * {@link markCalled} once the offer is accepted, so a gated offer is not
   * mistaken for a spoken one.
   */
  public update(frame: TelemetryFrame, nowMs: number): TrafficCall[] {
    const t = nowMs / 1000;
    this.estimates.clear();
    this.expire(t);

    const s = frame.session;
    const standings = frame.standings ?? [];
    const meRow = standings.find((e) => e.isPlayer);
    // The lap clock learns from every frame, pit laps and yellows included —
    // it decides for itself which laps are clean enough to keep.
    this.clock.observe(
      meRow?.lapFraction,
      frame.player?.lap?.current,
      meRow?.inPit === true || (frame.player?.pit?.phase ?? 'none') !== 'none' || s.phase !== 'green',
    );
    // Green running only: under FCY/red nobody may pass, at the start the field
    // is a concertina, and in the pits the player is not on the racing line.
    if (s.phase !== 'green' || s.notStarted === true) return NO_CALLS;
    const meRel = frame.relative.find((r) => r.isPlayer);
    if (meRel?.inPit || meRow?.inPit) return NO_CALLS;
    const pitPhase = frame.player?.pit?.phase;
    if (pitPhase && pitPhase !== 'none') return NO_CALLS;
    const myClass = normalizeClass(meRel?.carClass ?? meRow?.carClass);
    if (!myClass && !this.classAgnostic) return NO_CALLS;

    const myPace = paceOf(meRow);
    const cands = this.candidates(frame, meRow);
    for (const c of cands) {
      const side = this.sideOf(c.gap, c.carClass, myClass);
      if (side === null || c.inPit || Math.abs(c.gap) > TRACK_MAX_GAP_SEC) continue;
      const car = this.sample(c.slotId, t, c.gap, c.sig);
      const est = this.estimate(c, car, t, side, myPace, paceOf(c.row));
      if (!est) continue;
      if (est.side === 'behind' && est.steady) {
        const sector = contactSector(frame, meRow, est.ttcSec);
        if (sector !== null) est.sector = sector;
      }
      this.estimates.set(c.slotId, est);
    }

    return this.calls(frame, nowMs, myClass, cands);
  }

  /**
   * Every other car with its signed gap in seconds, from the best source this
   * frame has:
   *
   * - **the player's own lap clock** ({@link LapClock}) when it has a clean
   *   lap and the standings carry lap fractions — "how long until I am where
   *   they are now", correct whichever car is lapped, and covering the whole
   *   field rather than the relative's three each way;
   * - otherwise **the relative feed's gap**, tagged with which of the
   *   provider's two sources it came from so a switch restarts the history.
   */
  private candidates(frame: TelemetryFrame, meRow: StandingEntry | undefined): Candidate[] {
    const standings = frame.standings ?? [];
    const out: Candidate[] = [];
    const myFrac = meRow?.lapFraction;
    if (this.clock.ready() && known(myFrac)) {
      for (const e of standings) {
        if (e.isPlayer || !known(e.lapFraction)) continue;
        const gap = this.clock.gap(e.lapFraction, myFrac);
        if (gap === null) continue;
        out.push({
          slotId: e.slotId,
          gap,
          carClass: normalizeClass(e.carClass),
          inPit: e.inPit || e.retired === true,
          row: e,
          sig: 'P',
        });
      }
      return out;
    }
    const rowBySlot = new Map<number, StandingEntry>();
    for (const e of standings) rowBySlot.set(e.slotId, e);
    const mySig = meRow ? (known(meRow.gapToLeaderSec) ? 'T' : 'R') : '?';
    for (const r of frame.relative) {
      if (r.isPlayer || !known(r.relativeGapSec)) continue;
      const row = rowBySlot.get(r.slotId);
      out.push({
        slotId: r.slotId,
        gap: r.relativeGapSec,
        carClass: normalizeClass(r.carClass),
        inPit: r.inPit || row?.inPit === true || row?.retired === true,
        row,
        sig: `${mySig}${row ? (known(row.gapToLeaderSec) ? 'T' : 'R') : '?'}`,
      });
    }
    return out;
  }

  /* ---- per-car history -------------------------------------------------- */

  /** Which side a car is traffic on, or null when it is not traffic at all. */
  private sideOf(gap: number, cls: string | undefined, myClass: string | undefined): 'behind' | 'ahead' | null {
    if (this.classAgnostic) return gap < 0 ? 'behind' : gap > 0 ? 'ahead' : null;
    if (!cls || !myClass || cls === myClass) return null;
    if (gap < 0 && isFasterClass(cls, myClass)) return 'behind';
    if (gap > 0 && isFasterClass(myClass, cls)) return 'ahead';
    return null;
  }

  /** Append a sample, restarting the history across any discontinuity. */
  private sample(slotId: number, t: number, gap: number, sig: string): CarTrack {
    let car = this.cars.get(slotId);
    if (!car) {
      car = { t: [], g: [], estT: [], estC: [], sig, seenAt: t, called: false };
      this.cars.set(slotId, car);
    }
    car.seenAt = t;
    const n = car.t.length;
    if (n > 0) {
      const lastT = car.t[n - 1]!;
      const lastG = car.g[n - 1]!;
      if (t < lastT) {
        clearHistory(car); // clock went backwards — a replay loop
      } else if (
        t - lastT > MAX_SAMPLE_GAP_SEC ||
        Math.abs(gap - lastG) > JUMP_SEC ||
        Math.sign(gap) !== Math.sign(lastG) ||
        car.sig !== sig
      ) {
        clearHistory(car);
      } else if (t - lastT < SAMPLE_EVERY_SEC) {
        return car; // dense live frames: keep the history light
      }
    }
    car.sig = sig;
    car.t.push(t);
    car.g.push(gap);
    // Keep only what the rate window needs.
    let drop = 0;
    while (drop < car.t.length && t - car.t[drop]! > this.tune.rateWindowSec) drop++;
    if (drop > 0) {
      car.t.splice(0, drop);
      car.g.splice(0, drop);
    }
    return car;
  }

  /** The current estimate for a car, or null when there is no trend at all. */
  private estimate(
    r: Candidate,
    car: CarTrack,
    t: number,
    side: 'behind' | 'ahead',
    myPace: number | undefined,
    carPace: number | undefined,
  ): TrafficEstimate | null {
    const n = car.t.length;
    if (n < RATE_MIN_SAMPLES || car.t[n - 1]! - car.t[0]! < this.tune.rateMinSpanSec) {
      car.estT.length = 0;
      car.estC.length = 0;
      return null;
    }
    const abs = car.g.map(Math.abs);
    const { slope, last, rms } = fit(car.t, abs, 0);
    const measured = -slope;
    if (measured < MIN_CLOSING_RATE || rms > this.tune.maxFitRmsSec || last <= CONTACT_GAP_SEC) {
      car.estT.length = 0;
      car.estC.length = 0;
      return null;
    }

    // Pace cross-check: the two cars' lap times say how fast this pair SHOULD
    // close. A measured rate far from that is a corner-phase artefact (or a
    // car on an in/out lap), not an approach.
    // No lap time for either car (lap one, a fresh join) means no second
    // opinion — and no call. Only the class-agnostic validator skips this.
    let paceOk = this.classAgnostic || (myPace !== undefined && carPace !== undefined);
    let rate = measured;
    if (!this.classAgnostic && myPace !== undefined && carPace !== undefined) {
      const slow = Math.max(myPace, carPace);
      const fast = Math.min(myPace, carPace);
      const pr = (slow - fast) / slow;
      // Which car should be the faster one depends on the side.
      const carIsFaster = carPace < myPace;
      if (carIsFaster !== (side === 'behind')) paceOk = false;
      else if (
        measured < this.tune.paceAgreeLow * pr - this.tune.paceAgreeSlack ||
        measured > this.tune.paceAgreeHigh * pr + this.tune.paceAgreeSlack
      ) {
        paceOk = false;
      } else if (this.tune.paceBlend > 0 && pr >= MIN_CLOSING_RATE) {
        rate = (1 - this.tune.paceBlend) * measured + this.tune.paceBlend * pr;
      }
    }

    const ttc = (last - CONTACT_GAP_SEC) / rate;
    const contactAt = t + ttc;
    // The latest raw reading must agree with the trend: a car that has just
    // braked, spun or been baulked is not where the fit says it is.
    const rawNow = abs[abs.length - 1]!;
    const rawAgrees = Math.abs(rawNow - last) <= Math.max(RAW_FIT_TOL_SEC, 2 * rms);

    // Steadiness: the predicted MOMENT of contact over the last steadySec.
    car.estT.push(t);
    car.estC.push(contactAt);
    let drop = 0;
    while (drop < car.estT.length && t - car.estT[drop]! > this.tune.steadySec + 0.5) drop++;
    if (drop > 0) {
      car.estT.splice(0, drop);
      car.estC.splice(0, drop);
    }
    let steady =
      paceOk &&
      rawAgrees &&
      rate >= MIN_CALL_RATE &&
      rawNow > CONTACT_GAP_SEC + RAW_MARGIN_SEC &&
      car.estT.length >= 3 && t - car.estT[0]! >= this.tune.steadySec;
    if (steady) {
      const tol = Math.max(this.tune.steadyAbsSec, this.tune.steadyRel * ttc);
      for (const c of car.estC) {
        if (Math.abs(c - contactAt) > tol) {
          steady = false;
          break;
        }
      }
    }

    return {
      slotId: r.slotId,
      side,
      gapSec: last,
      rate,
      ttcSec: ttc,
      contactAtMs: Math.round(contactAt * 1000),
      steady,
      carClass: r.carClass ?? '',
    };
  }

  /** Drop cars not seen for a while — that is also what re-arms a call. */
  private expire(t: number): void {
    for (const [slot, car] of this.cars) {
      if (t - car.seenAt > REARM_SEC || t < car.seenAt - 1) this.cars.delete(slot);
    }
  }

  /* ---- the calls -------------------------------------------------------- */

  private calls(
    frame: TelemetryFrame,
    nowMs: number,
    myClass: string | undefined,
    cands: Candidate[],
  ): TrafficCall[] {
    let out: TrafficCall[] | null = null;
    for (const side of ['behind', 'ahead'] as const) {
      // The earliest-arriving, steady, uncalled car in the window leads.
      let lead: TrafficEstimate | null = null;
      for (const est of this.estimates.values()) {
        if (est.side !== side || !est.steady) continue;
        if (this.cars.get(est.slotId)?.called) continue;
        if (est.ttcSec < this.minTtc || est.ttcSec > this.maxTtc) continue;
        if (!lead || est.ttcSec < lead.ttcSec) lead = est;
      }
      if (!lead) continue;
      if (nearOnRadar(frame.radar, lead.slotId)) {
        // Already in the mirror / alongside — the driver can see it. Absorb.
        this.markCalled(lead.slotId, nowMs);
        continue;
      }

      // Group: same-side traffic just BEYOND the lead car (nose to tail), so
      // "first with you in N" stays true. Traffic NEARER than the lead that
      // has not been called makes "first" a lie — say nothing this frame.
      const group: TrafficEstimate[] = [lead];
      let blocked = false;
      for (const r of cands) {
        if (r.slotId === lead.slotId) continue;
        if (this.cars.get(r.slotId)?.called) continue;
        if (this.sideOf(r.gap, r.carClass, myClass) !== side || r.inPit) continue;
        const absGap = Math.abs(r.gap);
        if (absGap < lead.gapSec) {
          blocked = true;
          break;
        }
        if (absGap - lead.gapSec > GROUP_GAP_SEC) continue;
        const est = this.estimates.get(r.slotId);
        group.push(
          est ?? {
            slotId: r.slotId,
            side,
            gapSec: absGap,
            rate: lead.rate,
            ttcSec: lead.ttcSec,
            contactAtMs: lead.contactAtMs,
            steady: false,
            carClass: r.carClass ?? '',
          },
        );
      }
      if (blocked) continue;
      group.sort((a, b) => a.gapSec - b.gapSec);

      const classes = new Set(group.map((g) => g.carClass));
      const facts: Record<string, string | number | boolean> = {
        count: group.length,
        carClass: classes.size === 1 ? lead.carClass : 'mixed',
        ttcSec: Math.round(lead.ttcSec * 10) / 10,
        contactAtMs: lead.contactAtMs,
        rate: Math.round(lead.rate * 100) / 100,
        fast: lead.rate >= FAST_CLOSING_RATE,
        slots: group.map((g) => g.slotId).join(','),
      };
      if (lead.sector !== undefined) facts.sector = lead.sector;
      const kind: TrafficCallKind = side === 'behind' ? 'trafficBehind' : 'trafficAhead';
      const what = group.length > 1 ? `${group.length}× ${String(facts.carClass)}` : lead.carClass;
      (out ??= []).push({
        kind,
        slots: group.map((g) => g.slotId),
        detail: `${side === 'behind' ? 'faster class behind' : 'traffic ahead'} — ${what}, contact ~${lead.ttcSec.toFixed(1)} s`,
        facts,
      });
    }
    return out ?? NO_CALLS;
  }
}

const NO_CALLS: TrafficCall[] = [];

function clearHistory(car: CarTrack): void {
  car.t.length = 0;
  car.g.length = 0;
  car.estT.length = 0;
  car.estC.length = 0;
}

/** Whether the radar already shows this car alongside or right on us. */
function nearOnRadar(radar: RadarBlip[] | undefined, slotId: number): boolean {
  if (!Array.isArray(radar)) return false;
  for (const b of radar) {
    if (b.slotId !== slotId) continue;
    if (b.alongside || Math.abs(b.longitudinalM) < RADAR_NEAR_M) return true;
  }
  return false;
}

/**
 * The sector the player will be in when contact happens — ONLY when the whole
 * uncertainty band lands in one sector that is not the one they are in now.
 *
 * Time-based, not distance-based: the player's elapsed time on this lap plus the
 * time-to-contact, compared against where the sector lines fell in their LAST
 * lap (`lastSector1Sec`/`lastSector2Sec`, cumulative). That sidesteps the speed
 * profile entirely — the stopwatch already integrates it.
 */
export function contactSector(
  frame: TelemetryFrame,
  meRow: StandingEntry | undefined,
  ttcSec: number,
): 1 | 2 | 3 | null {
  const cur = frame.player?.lap?.current;
  const s1 = meRow?.lastSector1Sec;
  const s2 = meRow?.lastSector2Sec;
  const lap = meRow?.lastLapSec;
  if (!known(cur) || !known(s1) || !known(s2) || !known(lap)) return null;
  if (!(s1 > 0 && s2 > s1 && lap > s2) || cur < 0 || cur > lap * 1.5) return null;
  const lo = cur + ttcSec * (1 - LOCATION_REL) - LOCATION_ABS_SEC;
  const hi = cur + ttcSec * (1 + LOCATION_REL) + LOCATION_ABS_SEC;
  const sectorAt = (tau: number): 1 | 2 | 3 => {
    const x = ((tau % lap) + lap) % lap;
    return x < s1 ? 1 : x < s2 ? 2 : 3;
  };
  // No sector line (or the start/finish line) inside the band.
  for (let k = Math.floor(lo / lap); k <= Math.floor(hi / lap); k++) {
    for (const b of [k * lap, k * lap + s1, k * lap + s2]) {
      if (b > lo && b < hi) return null;
    }
  }
  const at = sectorAt(lo);
  return at === sectorAt(cur) ? null : at;
}

/* -------------------------------------------------------------------------- */
/*  Words                                                                       */
/* -------------------------------------------------------------------------- */

const SECTOR_WORDS: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three' };

/** Pick from a bank; index 0 is canonical. */
function pick(variant: number, bank: readonly string[]): string {
  return bank[Math.abs(variant) % bank.length]!;
}

/**
 * The spoken line for a traffic cue, or null when it has gone stale.
 *
 * The countdown is recomputed from the predicted contact MOMENT against the
 * cue's own emit time, so the coalesce and global-gate delays upstream are
 * already taken off the number, as is the {@link SPEECH_LEAD_SEC} it takes to
 * reach the driver's ear — and a cue held so long that fewer than
 * {@link MIN_SPOKEN_TTC_SEC} remain says nothing at all.
 *
 * Every line is short (≤ ~10 words) and speaks a time-to-contact, never a gap.
 */
export function trafficSentence(
  kind: TrafficCallKind,
  facts: Readonly<Record<string, string | number | boolean>>,
  cueAtMs: number,
  variant: number,
  radar?: RadarBlip[],
): string | null {
  const contactAt = facts.contactAtMs;
  if (typeof contactAt !== 'number') return null;
  const remain = (contactAt - cueAtMs) / 1000 - SPEECH_LEAD_SEC;
  if (!Number.isFinite(remain) || remain < MIN_SPOKEN_TTC_SEC) return null;
  // Last look before speaking: a named car already alongside is on screen.
  if (radar && typeof facts.slots === 'string') {
    for (const id of facts.slots.split(',')) {
      if (nearOnRadar(radar, Number(id))) return null;
    }
  }
  const secs = Math.round(remain);
  const count = typeof facts.count === 'number' ? facts.count : 1;
  const cls = typeof facts.carClass === 'string' ? facts.carClass : '';
  const mixed = cls === 'mixed' || cls === '';

  if (kind === 'trafficBehind') {
    const who =
      count > 1
        ? `${COUNT_WORDS[count] ?? count} ${mixed ? 'faster cars' : spokenClass(cls, true)}`
        : mixed
          ? 'Faster car'
          : spokenClass(cls);
    const sector = typeof facts.sector === 'number' ? SECTOR_WORDS[facts.sector] : undefined;
    if (count > 1) {
      return pick(variant, [
        `${who} behind, first with you in about ${secs} seconds.`,
        `${who} coming, first one with you in about ${secs}.`,
      ]);
    }
    if (sector) {
      return pick(variant, [
        `${who} with you in about ${secs} seconds — into sector ${sector}.`,
        `${who} behind, with you into sector ${sector}, about ${secs} seconds.`,
      ]);
    }
    if (facts.fast === true) {
      return pick(variant, [
        `${who} closing fast, with you in about ${secs} seconds.`,
        `${who} behind and closing fast — with you in about ${secs}.`,
      ]);
    }
    return pick(variant, [
      `${who} behind, with you in about ${secs} seconds.`,
      `${who} closing, with you in about ${secs} seconds.`,
      `Heads up, ${who} with you in about ${secs} seconds.`,
    ]);
  }

  const what =
    count > 1
      ? `${COUNT_WORDS[count] ?? count} ${mixed ? 'backmarkers' : spokenClass(cls, true)}`
      : mixed
        ? 'Backmarker'
        : spokenClass(cls);
  if (count > 1) {
    return pick(variant, [
      `${what} ahead, you'll be on them in about ${secs} seconds.`,
      `${what} ahead — you'll catch them in about ${secs} seconds.`,
    ]);
  }
  return pick(variant, [
    `${what} ahead, you'll be on it in about ${secs} seconds.`,
    `${what} ahead — you'll catch it in about ${secs} seconds.`,
  ]);
}

/**
 * The few words a blue-flag call gains when the tracker can place the car —
 * `" With you into sector three."` — or `""`. Appended by the phrase layer,
 * so the blue flag's own wording is untouched.
 */
export function yieldWhereSuffix(facts: Readonly<Record<string, string | number | boolean>>): string {
  const w = typeof facts.contactSector === 'number' ? SECTOR_WORDS[facts.contactSector] : undefined;
  return w ? ` With you into sector ${w}.` : '';
}

/* -------------------------------------------------------------------------- */
/*  The player's lap clock                                                      */
/* -------------------------------------------------------------------------- */

/** A step in lap fraction bigger than this inside one lap means a gap in the feed. */
export const CLOCK_MAX_FRAC_STEP = 0.05;

/**
 * The player's own last CLEAN lap as time against lap fraction — so a car's
 * position can be turned into "how long until I am where it is now".
 *
 * Why this exists: once a car is lapped by the overall leader (every GT3 in a
 * multiclass race within minutes) LMU zeroes its leader-gap and the relative
 * feed falls back to road distance × average pace. Distance breathes with the
 * corners — 100 m is 1 s on a straight and 3 s in a hairpin — so that gap
 * swings by seconds as one car brakes and the other does not, and nothing
 * steady can be fitted to it. Measured in the player's own lap time, the same
 * two positions give a gap that only moves with the real pace difference.
 *
 * Learned live: one lap of (fraction, elapsed) samples, kept only if it was
 * driven green, out of the pits, with no feed gaps and a clock that ran
 * forward from the line to the line. The previous clean lap stays in use until
 * a new one qualifies.
 */
export class LapClock {
  private curF: number[] = [];
  private curT: number[] = [];
  private curDirty = false;
  private refF: number[] | null = null;
  private refT: number[] | null = null;
  private refLap = 0;

  public reset(): void {
    this.curF = [];
    this.curT = [];
    this.curDirty = false;
    this.refF = null;
    this.refT = null;
    this.refLap = 0;
  }

  /** Whether a clean lap has been learned. */
  public ready(): boolean {
    return this.refF !== null;
  }

  /** The learned lap time, seconds (0 until ready). */
  public lapSec(): number {
    return this.refLap;
  }

  /**
   * Feed one frame's lap fraction and elapsed lap time. `dirty` marks the lap
   * as unfit to learn from (pit lane, yellow, not green).
   */
  public observe(frac: number | undefined, lapTime: number | undefined, dirty: boolean): void {
    if (!known(frac) || frac < 0 || frac > 1 || !known(lapTime) || lapTime < 0) {
      if (this.curF.length) this.curDirty = true;
      return;
    }
    const n = this.curF.length;
    if (n > 0) {
      const lastF = this.curF[n - 1]!;
      const lastT = this.curT[n - 1]!;
      if (frac < lastF - 0.5) {
        // The fraction crossed the line.
        this.commit(lastF, lastT);
        this.restart();
      } else if (lapTime < lastT) {
        if (lastF > 0.9) {
          // The clock reset at the line before the (slower) fraction wrapped.
          this.commit(lastF, lastT);
          this.restart();
          return;
        }
        if (frac < 0.05 && n < 10) {
          // The fraction wrapped before the clock reset: drop the stale start.
          this.restart();
        } else {
          this.curDirty = true;
        }
      } else if (frac === lastF) {
        return; // the position feed has not ticked yet
      } else if (frac < lastF || frac - lastF > CLOCK_MAX_FRAC_STEP) {
        this.curDirty = true;
      }
    }
    if (dirty) this.curDirty = true;
    this.curF.push(frac);
    this.curT.push(lapTime);
  }

  private restart(): void {
    this.curF = [];
    this.curT = [];
    this.curDirty = false;
  }

  private commit(lastF: number, lastT: number): void {
    const f = this.curF;
    const t = this.curT;
    const n = f.length;
    if (this.curDirty || n < 20 || f[0]! > 0.03 || lastF < 0.97) return;
    // Extrapolate the last samples to the line for the lap time.
    const df = f[n - 1]! - f[n - 2]!;
    const dt = t[n - 1]! - t[n - 2]!;
    const lap = df > 0 ? lastT + ((1 - lastF) * dt) / df : lastT;
    if (!(lap > 20 && lap < 900) || t[0]! > 0.05 * lap + 1) return;
    this.refF = f.slice();
    this.refT = t.slice();
    this.refLap = lap;
  }

  /** Reference elapsed time at fraction `x`, interpolated. */
  private timeAt(x: number): number {
    const F = this.refF!;
    const Tm = this.refT!;
    const n = F.length;
    if (x <= F[0]!) return F[0]! > 0 ? (Tm[0]! * x) / F[0]! : Tm[0]!;
    if (x >= F[n - 1]!) {
      const span = 1 - F[n - 1]!;
      return span > 0 ? Tm[n - 1]! + ((this.refLap - Tm[n - 1]!) * (x - F[n - 1]!)) / span : this.refLap;
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (F[mid]! <= x) lo = mid;
      else hi = mid;
    }
    const f0 = F[lo]!;
    const f1 = F[hi]!;
    return Tm[lo]! + ((Tm[hi]! - Tm[lo]!) * (x - f0)) / (f1 - f0);
  }

  /**
   * Signed seconds between the player and a car, the short way round:
   * positive = the car is AHEAD and this is how long until the player is where
   * it is now; negative = BEHIND, and this is how long the player took to get
   * from where it is to here. `null` until a clean lap exists.
   */
  public gap(fCar: number, fMe: number): number | null {
    if (!this.ready()) return null;
    let d = fCar - fMe;
    if (d > 0.5) d -= 1;
    else if (d <= -0.5) d += 1;
    const tc = this.timeAt(fCar);
    const tm = this.timeAt(fMe);
    if (d >= 0) {
      const g = tc - tm;
      return g < 0 ? g + this.refLap : g;
    }
    const g = tm - tc;
    return -(g < 0 ? g + this.refLap : g);
  }
}
