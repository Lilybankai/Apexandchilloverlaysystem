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
 * already exposes (`lapTimeSec = mElapsedTime − mLapStartET`), the same basis
 * as {@link LocalLapDeltaTracker}.
 *
 * The all-time-best reference is persisted per track under the user's home dir
 * so it survives restarts (SimHub's "all time best" is likewise cross-session).
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

/** A reference lap: its ordered trace and the lap time it was set at. */
interface Reference {
  trace: Sample[];
  lapSec: number;
  /** Whether the trace covers the whole lap (captured flag-to-flag). */
  full: boolean;
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

  private session: Reference | null = null;
  private allTime: Reference | null = null;
  private last: Reference | null = null;
  private lastLapSec: number = UNKNOWN_VALUE;

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
    // allTime is NOT cleared on a session reset — it spans sessions.
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
   * @param d          - Road position as a lap fraction `0..1`, already
   *                     dead-reckoned forward to `elapsedSec` by the caller (see
   *                     {@link SMOOTH_SLEW_SEC_PER_SEC}). Without that, `d` is a
   *                     ~150 ms-stale REST value against a live clock and the
   *                     delta sawtooths.
   * @param elapsedSec - Sim `mElapsedTime` (seconds), a monotonic real-time clock.
   * @param restBest   - REST `bestLapTime`, for out-lap plausibility guarding.
   * @param trackKey   - Stable per-track id (name + length) for persistence.
   * @param fresh      - Whether `d` came from a REST snapshot not seen before.
   *                     Only fresh positions are written into the reference
   *                     trace: extrapolated ones would bake this poll's velocity
   *                     assumption into the lap we later compare against.
   */
  public update(
    d: number,
    elapsedSec: number,
    restBest: number,
    trackKey: string,
    fresh = true,
  ): PaceDeltas {
    if (d < 0 || d > 1 || typeof elapsedSec !== 'number' || elapsedSec <= 0) {
      return EMPTY_PACE_DELTAS;
    }

    // Track change → (re)load the persisted all-time best for the new track.
    if (trackKey && trackKey !== this.trackKey) {
      this.trackKey = trackKey;
      this.allTime = loadAllTime(trackKey);
    }

    // Session restart / return-to-garage → the sim clock rewinds; start over.
    if (this.lapStartElapsed >= 0 && elapsedSec + 1 < this.lapStartElapsed) this.reset();
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
      this.resetFilters(); // the delta legitimately snaps to ~0 on a new lap
    }
    this.prevD = d;
    this.prevElapsed = elapsedSec;

    const t = elapsedSec - this.lapStartElapsed; // real seconds into the lap
    if (t < 0) return EMPTY_PACE_DELTAS;

    // Record forward progress, decimated to ~0.2% of a lap between samples.
    // Extrapolated positions are skipped — see the `fresh` parameter.
    const prev = this.samples[this.samples.length - 1];
    if (fresh && (prev === undefined || (d > prev.d + 0.002 && t >= prev.t))) {
      this.samples.push({ d, t });
    }

    return this.compute(t, d);
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

    const ref: Reference = { trace, lapSec, full: true };

    // Last lap: always the most recent usable lap.
    this.last = ref;
    this.lastLapSec = lapSec;

    // Session best / all-time best: adopt when genuinely faster.
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
  for (let i = 1; i < n; i++) {
    const b = ref[i]!;
    if (b.d >= d) {
      const a = ref[i - 1]!;
      const span = b.d - a.d;
      return span <= 0 ? a.t : a.t + (b.t - a.t) * ((d - a.d) / span);
    }
  }
  return ref[n - 1]!.t;
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
  for (let i = 1; i < n; i++) {
    const b = ref[i]!;
    if (b.t >= t) {
      const a = ref[i - 1]!;
      const span = b.t - a.t;
      return span <= 0 ? a.d : a.d + (b.d - a.d) * ((t - a.t) / span);
    }
  }
  return ref[n - 1]!.d;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
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
function pbDir(): string {
  return path.join(os.homedir(), '.apex-overlay', 'pb');
}

function pbFile(trackKey: string): string {
  return path.join(pbDir(), `${trackKey}.json`);
}

/** Load a persisted all-time-best reference for a track, or null. */
function loadAllTime(trackKey: string): Reference | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pbFile(trackKey), 'utf8'));
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
      if (trace.length >= 8 && from <= 0.05 && to >= 0.9) {
        return { trace, lapSec: raw.lapSec, full: true };
      }
    }
  } catch {
    /* first run on this track, or unreadable — no persisted best */
  }
  return null;
}

/** Persist an all-time-best reference for a track (best-effort). */
function saveAllTime(trackKey: string, ref: Reference): void {
  try {
    fs.mkdirSync(pbDir(), { recursive: true });
    fs.writeFileSync(pbFile(trackKey), JSON.stringify(ref), 'utf8');
  } catch {
    /* non-fatal — persistence is a convenience, not required for live delta */
  }
}

/** Build a filesystem-safe per-track key from its name and length. */
export function trackKeyOf(trackName: string, lapDistanceM: number): string {
  const name = (trackName || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const len = lapDistanceM > 1 ? Math.round(lapDistanceM) : 0;
  return `${name || 'unknown'}_${len}`;
}
