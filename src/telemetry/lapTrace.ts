/**
 * @file src/telemetry/lapTrace.ts
 * @module telemetry/lapTrace
 *
 * Per-lap **driving traces** — the raw material the training feature will be
 * built on. For every completed flying lap of the driven car this records a
 * distance-indexed curve of what the driver was actually doing: throttle,
 * brake, steering, gear, speed and the motion channels (lateral/longitudinal
 * G), sampled at frame rate and decimated by distance.
 *
 * ## Why this exists now, before any training UI does
 * The plan is that a driver can click a lap time on the league board and study
 * how it was driven — braking points, turn-in, throttle pickup, corner by
 * corner. A lap time alone cannot teach any of that, and it cannot be
 * reconstructed later: either the trace was recorded while the lap was being
 * driven or it is gone. So capture starts shipping ahead of the feature, the
 * same way the lap database shipped ahead of the leaderboard, and the board
 * accumulates teachable laps in the meantime.
 *
 * ## Relationship to `paceDelta.ts`
 * The delta engine already records a distance→time trace per lap, and this
 * module deliberately mirrors its lap-boundary logic (interpolated line
 * crossing, the `fromLine` gate, the gap/rewind resets) so the two agree about
 * what a lap is. It is a separate recorder rather than a widening of the delta's
 * `Sample`, for two reasons: the delta's trace is decimated for interpolation
 * (~500 points is plenty), while a brake trace needs to resolve individual
 * braking zones (~4× denser); and a reference lap is kept only when it is a
 * *best*, while a training trace is kept for every lap — the lap that went
 * wrong is exactly the one worth studying against the one that didn't.
 *
 * ## The join to the lap database
 * A trace file on its own is meaningless — it matters because it belongs to a
 * {@link LapRecord} with a time, a track, a class and a clean verdict. The
 * record now carries an `id` (v3), and the trace is written to
 * `~/.apex-overlay/traces/<day>/<id>.json` when the record is written. The two
 * halves are produced by different clocks (the recorder here sees the line at
 * frame rate; the lap log sees `lapsCompleted` move at REST rate, then holds
 * the record for the stewards' verdict), so the provider matches a completed
 * trace to its record by lap time — the sim's own time and the trace's measured
 * one agree to well under a second, and pending traces are discarded after a
 * few minutes rather than allowed to mis-attach to a later lap.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dayStamp } from './lapLog';

/* -------------------------------------------------------------------------- */
/*  Sampling                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The driver-input and motion channels captured per sample, as the provider
 * reads them from shared memory each frame. All optional-feeling channels are
 * still plain numbers: the provider substitutes `0` where a channel is genuinely
 * absent (TC/ABS on a car without them), which for these channels is also the
 * honest neutral value.
 */
export interface TraceChannels {
  /** Throttle 0..1. */
  throttle: number;
  /** Brake 0..1. */
  brake: number;
  /** Steering -1 (full left) .. 1 (full right). */
  steer: number;
  /** Gear: -1 reverse, 0 neutral, 1..n. */
  gear: number;
  /** Ground speed, km/h. */
  speedKph: number;
  /** Lateral G, positive toward the car's right. */
  latG: number;
  /** Longitudinal G, positive under braking (display convention, see motion.ts). */
  lonG: number;
  /** Traction-control intervention 0..1. */
  tc: number;
  /** ABS intervention 0..1. */
  abs: number;
}

/**
 * One recorded point: where on the lap, when on the lap, and what the driver
 * was doing there.
 */
interface TracePoint extends TraceChannels {
  /** Lap distance fraction 0..1. */
  d: number;
  /** Seconds into the lap on the delta engine's clock. */
  t: number;
}

/**
 * Distance decimation step, as a fraction of the lap.
 *
 * 0.001 is ~4–7 m at the circuits LMU runs, which at racing speed is a sample
 * every ~60–100 ms through a braking zone — enough to see where the pedal went
 * down, how hard, and where it bled off, which is the resolution training
 * needs. The delta engine's own 0.002 was tuned for interpolation smoothness,
 * not for reading a driver's inputs back.
 */
const MIN_D_STEP = 0.001;

/**
 * Time backstop between samples, seconds. Distance decimation alone starves in
 * the slowest corners (a hairpin at 60 km/h covers 0.001 of Le Mans in ~0.8 s),
 * and a spin or a stall would otherwise record nothing at all while the car is
 * stationary — which is precisely the part the driver will want to look at.
 */
const MAX_T_GAP = 0.5;

/**
 * Hard cap on points per lap. A normal lap lands at 1 000–2 000; the cap is the
 * safety net for a pathological one (a very long stop on track under the time
 * backstop). Beyond it the lap keeps timing but stops growing, and the trace is
 * marked truncated rather than silently thinned.
 */
const MAX_SAMPLES = 6000;

/** Plausibility bounds for a completed lap, matching `lapLog`'s. */
const MIN_LAP_SEC = 5;
const MAX_LAP_SEC = 3600;

/* -------------------------------------------------------------------------- */
/*  Completed trace                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A finished lap's trace, in **columnar** form: one array per channel, index-
 * aligned. Columnar because that is how it is stored and shipped — the field
 * names appear once instead of two thousand times, which roughly halves the
 * JSON and compresses far better — and building it once at completion is
 * cheaper than converting on every write.
 */
export interface CompletedTrace {
  /** The lap's measured duration, seconds (interpolated crossing to crossing). */
  lapSec: number;
  /** How many points the columns hold. */
  count: number;
  /** `true` when {@link MAX_SAMPLES} was hit and the tail of the lap is sparse. */
  truncated: boolean;
  /** Lap distance fraction 0..1 per point. */
  d: number[];
  /** Seconds into the lap per point. */
  t: number[];
  throttle: number[];
  brake: number[];
  steer: number[];
  gear: number[];
  speedKph: number[];
  latG: number[];
  lonG: number[];
  tc: number[];
  abs: number[];
}

/** Round helpers — wire precision per channel, chosen to keep files small
 *  without quantising anything a training overlay would show. */
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const r5 = (v: number): number => Math.round(v * 100000) / 100000;

/* -------------------------------------------------------------------------- */
/*  Recorder                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Watches the driven car at frame rate and emits one {@link CompletedTrace}
 * per flag-to-flag lap.
 *
 * Fed from the same place as the delta engine, with the same filtered road
 * position and the same sim clock, so its laps are the delta's laps. Pure and
 * synchronous like `LapRecorder` — no IO here; writing is the store's job
 * below, and the provider decides which completed traces are worth writing.
 */
export class LapTraceRecorder {
  private prevD = -1;
  private prevElapsed = -1;
  private lapStartElapsed = -1;
  /** Whether the lap being recorded began at an observed line crossing. */
  private fromLine = false;
  private points: TracePoint[] = [];
  private truncated = false;

  /** Drop everything — session change, feed loss, spectating. */
  public reset(): void {
    this.prevD = -1;
    this.prevElapsed = -1;
    this.lapStartElapsed = -1;
    this.fromLine = false;
    this.points = [];
    this.truncated = false;
  }

  /**
   * Feed one frame. Returns a completed trace when this frame crossed the
   * start/finish line at the end of a fully observed lap, else `null`.
   *
   * @param d          - Road position as a lap fraction 0..1 — the caller's
   *                     `RoadPosition` estimate, the same value the delta gets.
   * @param elapsedSec - Sim clock (`mElapsedTime`), seconds.
   * @param ch         - The driver-input/motion channels this frame.
   */
  public update(d: number, elapsedSec: number, ch: TraceChannels): CompletedTrace | null {
    if (d < 0 || d > 1 || typeof elapsedSec !== 'number' || elapsedSec <= 0) return null;

    // Session restart / return-to-garage: the sim clock rewinds. Start over.
    if (this.lapStartElapsed >= 0 && elapsedSec + 1 < this.lapStartElapsed) this.reset();

    // Torn shared-memory read or a paused sim — the clock did not advance, so
    // this frame observes nothing new.
    if (this.prevElapsed >= 0 && elapsedSec <= this.prevElapsed) return null;

    // A long gap: whatever lap was in progress is not a lap any more.
    if (this.prevElapsed >= 0 && elapsedSec - this.prevElapsed > 5) {
      this.points = [];
      this.truncated = false;
      this.lapStartElapsed = elapsedSec;
      this.prevD = d;
      this.fromLine = false;
    }

    if (this.lapStartElapsed < 0) {
      this.lapStartElapsed = elapsedSec;
      this.prevD = d;
      this.prevElapsed = elapsedSec;
    }

    let done: CompletedTrace | null = null;

    // Line crossing — the fraction wrapped from near-1 to near-0. Interpolate
    // the crossing instant exactly as the delta engine does, so both agree on
    // every lap time to the same few milliseconds.
    if (this.prevD > 0.5 && d < this.prevD - 0.5) {
      const before = 1 - this.prevD;
      const covered = before + d;
      const frac = covered > 0 ? before / covered : 0;
      const crossET = this.prevElapsed + (elapsedSec - this.prevElapsed) * frac;
      if (this.fromLine) done = this.complete(crossET - this.lapStartElapsed);
      this.points = [];
      this.truncated = false;
      this.lapStartElapsed = crossET;
      this.fromLine = true;
    }
    this.prevD = d;
    this.prevElapsed = elapsedSec;

    const t = elapsedSec - this.lapStartElapsed;
    if (t < 0) return done;

    // Record when the car has moved MIN_D_STEP along the lap, or when the time
    // backstop expires (slow corners, spins, stationary cars — see MAX_T_GAP).
    const prev = this.points[this.points.length - 1];
    const due =
      prev === undefined ||
      (d > prev.d + MIN_D_STEP && t >= prev.t) ||
      t >= prev.t + MAX_T_GAP;
    if (due) {
      if (this.points.length >= MAX_SAMPLES) {
        this.truncated = true;
      } else {
        this.points.push({
          d: r5(d),
          t: r3(t),
          throttle: r3(clamp01(ch.throttle)),
          brake: r3(clamp01(ch.brake)),
          steer: r4(clampAbs1(ch.steer)),
          gear: Math.round(numOr(ch.gear, 0)),
          speedKph: Math.round(numOr(ch.speedKph, 0) * 10) / 10,
          latG: r3(numOr(ch.latG, 0)),
          lonG: r3(numOr(ch.lonG, 0)),
          tc: r3(clamp01(ch.tc)),
          abs: r3(clamp01(ch.abs)),
        });
      }
    }

    return done;
  }

  /**
   * Turn the buffered points into a completed trace, or `null` when the buffer
   * does not describe a whole lap.
   *
   * Coverage gates mirror `paceDelta.onLapComplete`: the trace must start at
   * the line and reach the end of the lap. Unlike a delta reference, a hole in
   * the middle does NOT reject it — a lap with an off in it is still a lap the
   * driver may want to study — but a trace that misses the start or the end
   * belongs to a fragment, not a lap.
   */
  private complete(lapSec: number): CompletedTrace | null {
    const pts = this.points;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (pts.length < 8 || first === undefined || last === undefined) return null;
    if (first.d > 0.05 || last.d < 0.9) return null;
    if (lapSec <= MIN_LAP_SEC || lapSec >= MAX_LAP_SEC) return null;

    const out: CompletedTrace = {
      lapSec: Math.round(lapSec * 1000) / 1000,
      count: pts.length,
      truncated: this.truncated,
      d: [],
      t: [],
      throttle: [],
      brake: [],
      steer: [],
      gear: [],
      speedKph: [],
      latG: [],
      lonG: [],
      tc: [],
      abs: [],
    };
    for (const p of pts) {
      out.d.push(p.d);
      out.t.push(p.t);
      out.throttle.push(p.throttle);
      out.brake.push(p.brake);
      out.steer.push(p.steer);
      out.gear.push(p.gear);
      out.speedKph.push(p.speedKph);
      out.latG.push(p.latG);
      out.lonG.push(p.lonG);
      out.tc.push(p.tc);
      out.abs.push(p.abs);
    }
    return out;
  }
}

function clamp01(v: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function clampAbs1(v: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0;
}

function numOr(v: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/* -------------------------------------------------------------------------- */
/*  Storage                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a trace file holds: the trace plus enough identity to stand alone. The
 * authoritative copy of track/car/class/clean lives on the {@link LapRecord}
 * this file's `lapId` points at; it is duplicated here so a file found on its
 * own (or shipped to the cloud) still says what it is.
 */
export interface TraceFile {
  v: 1;
  /** The owning `LapRecord.id`. Also the file's basename. */
  lapId: string;
  /** Wall-clock completion time of the lap, ISO 8601 — the record's `at`. */
  at: string;
  sim: string;
  trackKey: string;
  track: string;
  trackLengthM: number;
  car: string;
  carClass: string;
  /** The sim's own lap time in ms — the record's `lapMs`, not the measured one. */
  lapMs: number;
  /** Cumulative-split sector times in ms, when the sim published them. */
  s1Ms?: number;
  s2Ms?: number;
  s3Ms?: number;
  trace: CompletedTrace;
}

/**
 * Directory holding the trace files, one per lap, in per-UTC-day folders.
 * Beside `laps/` and `pb/` for the same reason those live there: the server
 * writes these and the server runs with or without Electron.
 */
export function traceDir(): string {
  return path.join(os.homedir(), '.apex-overlay', 'traces');
}

/** Path a given lap's trace lives at, derived from the record's `at`. */
export function traceFilePath(lapId: string, atIso: string, dir = traceDir()): string {
  return path.join(dir, dayStamp(Date.parse(atIso)), `${lapId}.json`);
}

/** Write one lap's trace. Best-effort: never throws at the caller. */
export function writeTrace(file: TraceFile, dir = traceDir()): void {
  try {
    const p = traceFilePath(file.lapId, file.at, dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(file), 'utf8');
  } catch {
    /* a trace that cannot be written is not worth taking the overlay down for */
  }
}

/** Read one lap's trace back, or `null` when it does not exist / is torn. */
export function readTrace(lapId: string, atIso: string, dir = traceDir()): TraceFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(traceFilePath(lapId, atIso, dir), 'utf8')) as TraceFile;
    if (raw && raw.lapId === lapId && raw.trace && Array.isArray(raw.trace.d)) return raw;
  } catch {
    /* never recorded (spectating, feature not yet shipped), or pruned */
  }
  return null;
}

/**
 * How long trace files are kept locally, in days.
 *
 * Traces are ~40–80 KB where lap records are a few hundred bytes, so unlike the
 * lap files they do get pruned. Sixty days comfortably covers the rolling week
 * and a league season's retrospectives; the one trace that must outlive this —
 * the driver's board best — is uploaded, and the cloud copy is the durable one.
 */
export const TRACE_KEEP_DAYS = 60;

/** Delete whole day-folders older than the retention window. Best-effort. */
export function pruneTraces(nowMs: number, dir = traceDir()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // nothing recorded yet
  }
  const cutoff = dayStamp(nowMs - TRACE_KEEP_DAYS * 86_400_000);
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    if (name >= cutoff) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      /* locked file, races with a write — next start will retry */
    }
  }
}
