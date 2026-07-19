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

/** A reference lap: its ordered trace and the lap time it was set at. */
interface Reference {
  trace: Sample[];
  lapSec: number;
  /** Whether the trace covers the whole lap (captured flag-to-flag). */
  full: boolean;
}

/**
 * Maintains the three reference laps for the driven car and computes both
 * delta flavours against each on every physics sample.
 */
export class LocalPaceDeltaTracker {
  /** Lap fraction seen last poll; `-1` before the first sample. */
  private prevD = -1;
  /** Sim clock (`mElapsedTime`) at the current lap's start; `-1` until known. */
  private lapStartElapsed = -1;
  private samples: Sample[] = [];

  private session: Reference | null = null;
  private allTime: Reference | null = null;
  private last: Reference | null = null;
  private lastLapSec: number = UNKNOWN_VALUE;

  /** Track key the all-time best was loaded for (reloads on track change). */
  private trackKey = '';

  private reset(): void {
    this.prevD = -1;
    this.lapStartElapsed = -1;
    this.samples = [];
    this.session = null;
    this.last = null;
    this.lastLapSec = UNKNOWN_VALUE;
    // allTime is NOT cleared on a session reset — it spans sessions.
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
   * @param d          - Road position as a lap fraction `0..1`
   *                     (REST `lapDistance / trackLength`).
   * @param elapsedSec - Sim `mElapsedTime` (seconds), a monotonic real-time clock.
   * @param restBest   - REST `bestLapTime`, for out-lap plausibility guarding.
   * @param trackKey   - Stable per-track id (name + length) for persistence.
   */
  public update(d: number, elapsedSec: number, restBest: number, trackKey: string): PaceDeltas {
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
    }

    // Lap boundary: the distance fraction wrapped from near-1 back to near-0
    // (crossed the start/finish line). The completed lap's real duration is the
    // elapsed-clock delta since this lap started.
    if (this.prevD > 0.5 && d < this.prevD - 0.5) {
      this.onLapComplete(elapsedSec - this.lapStartElapsed, restBest, trackKey);
      this.samples = [];
      this.lapStartElapsed = elapsedSec;
    }
    this.prevD = d;

    const t = elapsedSec - this.lapStartElapsed; // real seconds into the lap
    if (t < 0) return EMPTY_PACE_DELTAS;

    // Record forward progress, decimated to ~0.2% of a lap between samples.
    const prev = this.samples[this.samples.length - 1];
    if (prev === undefined || (d > prev.d + 0.002 && t >= prev.t)) this.samples.push({ d, t });

    return this.compute(t, d);
  }

  /**
   * Consider the just-completed lap for each reference role.
   * @param lapSec - The completed lap's real duration (sim-clock delta).
   */
  private onLapComplete(lapSec: number, restBest: number, trackKey: string): void {
    const first = this.samples[0];
    const lastPt = this.samples[this.samples.length - 1];
    // REST updates at ~7 Hz, so the last sample before the line may sit at
    // d≈0.9..0.99; accept that as "reached the line".
    const usable = this.samples.length >= 8 && lastPt !== undefined && lastPt.d > 0.9;
    if (!usable) return;
    const full = first !== undefined && first.d < 0.1;

    // Reject out-laps / crawls: a flying lap is within ~40% of a sane best.
    const plausible = lapSec > 5 && lapSec < 3600 && (!(restBest > 5 && restBest < 600) || lapSec < restBest * 1.4);
    if (!plausible) return;

    const trace = this.samples.slice().sort((a, b) => a.d - b.d);
    const ref: Reference = { trace, lapSec, full };

    // Last lap: always the most recent usable lap.
    this.last = ref;
    this.lastLapSec = lapSec;

    // Session best: adopt when faster, or to upgrade a partial ref to full.
    if (!this.session || lapSec < this.session.lapSec || (full && !this.session.full)) {
      this.session = ref;
    }

    // All-time best: adopt + persist when it beats the stored one.
    if (!this.allTime || lapSec < this.allTime.lapSec || (full && !this.allTime.full)) {
      this.allTime = ref;
      if (trackKey) saveAllTime(trackKey, ref);
    }
  }

  /** Compute all six deltas at the current (t, d). */
  private compute(t: number, d: number): PaceDeltas {
    const tSession = deltaT(this.session, t, d);
    const tAllTime = deltaT(this.allTime, t, d);
    const tLast = deltaT(this.last, t, d);
    const predictedLapSec =
      this.session && tSession !== UNKNOWN_VALUE ? round2(this.session.lapSec + tSession) : UNKNOWN_VALUE;
    return {
      tSession,
      tAllTime,
      tLast,
      vSession: deltaV(this.session, t, d),
      vAllTime: deltaV(this.allTime, t, d),
      vLast: deltaV(this.last, t, d),
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

/** Round to 4 decimals — the delta readout precision, matching LMU's `0.0000`. */
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
      if (trace.length >= 2) return { trace, lapSec: raw.lapSec, full: !!raw.full };
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
