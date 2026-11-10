/**
 * @file src/telemetry/iracing/irLapTrace.ts
 * @module telemetry/iracing/irLapTrace
 *
 * Lap traces, the pace-delta lap clock and sector splits for **iRacing** — the
 * one producer that lights up Review lap detail, Compare, board traces, the
 * pacedelta widget, the delta widget's predicted lap and the speedo's
 * projected lap on the second sim.
 *
 * ## What it reuses, unchanged
 * - {@link LapTraceRecorder} (lapTrace.ts) records the distance-indexed trace,
 *   exactly as for LMU, so the file on disk is the same `TraceFile` and every
 *   reader (lapDetail, stintReview, the uploader) works without knowing which
 *   sim made it.
 * - {@link LocalPaceDeltaTracker} (paceDelta.ts) runs the three references and
 *   both delta flavours.
 *
 * ## Why iRacing needs no RoadPosition observer
 * LMU's distance arrives over REST at ~7 Hz while its clock ticks in shared
 * memory, so its `d` has to be dead-reckoned onto the clock. iRacing publishes
 * `LapDistPct` and `SessionTime` in the SAME 60 Hz buffer — the two axes are
 * already coherent, so `d` is fed as the sim gives it.
 *
 * ## The driven line
 * iRacing publishes no world position for any car (see positionIntegrator.ts).
 * `IracingPositionIntegrator.step` answers with the point ON the reference
 * outline at the car's lap fraction — the same spot every lap — so it cannot be
 * a lap's LINE: drawing it would be the "line guessed from the centreline" that
 * `TraceFile.v` forbids. Instead this module dead-reckons each lap afresh from
 * body velocity + yaw, then, when the lap's record lands:
 *   1. removes the loop-closure error linearly over the lap (as the integrator
 *      does for its outline), and
 *   2. rigidly fits the lap (rotation + translation, no scale) onto the track
 *      map the Review tab will draw it on, matching points by lap fraction.
 * The fit's residual is the line's quality check. A lap that was not integrated
 * end to end, or that does not sit on the map within {@link LINE_MAX_RMS_M}, is
 * written without a line (v1) rather than with a wrong one.
 *
 * ## Sectors
 * iRacing names its own sector boundaries per circuit (`SplitTimeInfo`, as lap
 * fractions) and publishes no live split times, so splits are measured off the
 * lap's own trace and scaled to the sim's lap time so they sum to it exactly.
 * Three sectors fill `s1Ms..s3Ms` (the board's columns); any other count goes
 * in `sectorsMs` only — four sectors under three names would be a lie.
 *
 * Pure apart from the optional PB persistence inside the delta engine (off when
 * the provider passes an empty reference key).
 */

import { LapTraceRecorder, type CompletedTrace, type TraceChannels, type TraceFile } from '../lapTrace';
import { LocalPaceDeltaTracker } from '../paceDelta';
import type { LapRecord } from '../lapLog';
import type { TrackMapPath } from '../trackMap';
import { UNKNOWN_VALUE, type PaceDeltas } from '../types';

/** Longest tick gap the line integration spans (as the outline integrator). */
const MAX_INTEGRATE_DT_S = 0.25;
/** A record and its trace pair only within this many wall-clock ms. */
const PAIR_WINDOW_MS = 5000;
/** …and only when the sim's lap time and the trace's measured one agree this well. */
const PAIR_LAP_TOLERANCE_MS = 2000;
/**
 * Sector splits are measured on the trace's clock and scaled onto the sim's
 * lap time; past this disagreement the two do not describe the same stretch
 * (iRacing times a race's first lap from the start, not from the line), and
 * scaling would smear the difference over every sector.
 */
const SECTOR_LAP_TOLERANCE_MS = 250;
/** Pending traces older than this are never paired. */
const PENDING_MAX_AGE_MS = 120_000;
/** A driven line whose fit onto the map leaves more RMS residual than this is dropped. */
export const LINE_MAX_RMS_M = 4;
/**
 * …or whose worst point is further than this from the map's line at that
 * fraction. Generous on purpose: a lap with an off in it really was 20 m wide
 * of the line for a moment (measured at Winton, RMS still 2.7 m), and that lap
 * is the one worth studying. Integration faults show up in the RMS, not here.
 */
export const LINE_MAX_POINT_M = 35;
/** A fit needing more rotation than this is not the same circuit frame. */
const LINE_MAX_ROTATION_RAD = (15 * Math.PI) / 180;

/** `irsdk_TrkLoc` off-track surface. */
const SURFACE_OFF_TRACK = 0;

const fin = (v: number): boolean => typeof v === 'number' && Number.isFinite(v);
const r1 = (v: number): number => Math.round(v * 10) / 10;

/* -------------------------------------------------------------------------- */
/*  Sector splits                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The sector boundaries strictly inside the lap, sorted — `SectorStartPct`
 * minus the 0 that starts sector 1. `[]` when the circuit publishes none.
 */
export function sectorBoundaries(startPcts: readonly number[]): number[] {
  return [...new Set(startPcts.filter((p) => fin(p) && p > 0.0005 && p < 0.9995))].sort((a, b) => a - b);
}

/** Seconds into the lap at which the trace reached `d`, or `null` when it has no point near it. */
function timeAt(trace: CompletedTrace, d: number): number | null {
  const ds = trace.d;
  const ts = trace.t;
  for (let i = 1; i < ds.length; i++) {
    const d1 = ds[i] as number;
    if (d1 < d) continue;
    const d0 = ds[i - 1] as number;
    // A hole across the boundary (a dropout, a tow) means the crossing was
    // never observed; interpolating across it would invent the split.
    if (d1 - d0 > 0.02) return null;
    const t0 = ts[i - 1] as number;
    const t1 = ts[i] as number;
    const span = d1 - d0;
    return span > 0 ? t0 + (t1 - t0) * ((d - d0) / span) : t0;
  }
  return null;
}

/**
 * Every sector split of a lap in whole ms, or `null` when any boundary cannot
 * be placed. Measured on the trace's own clock, then scaled onto the sim's lap
 * time so the splits sum to `lapMs` exactly (the two clocks agree to a few
 * hundredths; the scale moves no split by more than that).
 */
export function sectorSplitsFromTrace(
  trace: CompletedTrace,
  startPcts: readonly number[],
  lapMs: number,
): number[] | null {
  const bounds = sectorBoundaries(startPcts);
  if (!bounds.length || !(lapMs > 0) || !(trace.lapSec > 0)) return null;
  const scale = lapMs / (trace.lapSec * 1000);
  const cum: number[] = [];
  for (const b of bounds) {
    const t = timeAt(trace, b);
    if (t === null) return null;
    cum.push(Math.round(t * 1000 * scale));
  }
  const splits: number[] = [];
  let prev = 0;
  for (const c of cum) {
    splits.push(c - prev);
    prev = c;
  }
  splits.push(lapMs - prev);
  return splits.every((s) => s > 0) ? splits : null;
}

/** The sector (1-based) a lap fraction lies in, or UNKNOWN. */
export function sectorOf(pct: number, startPcts: readonly number[]): number {
  if (!fin(pct) || pct < 0 || pct > 1) return UNKNOWN_VALUE;
  const bounds = sectorBoundaries(startPcts);
  if (!bounds.length) return UNKNOWN_VALUE;
  let n = 1;
  for (const b of bounds) if (pct >= b) n++;
  return n;
}

/* -------------------------------------------------------------------------- */
/*  Driven line                                                               */
/* -------------------------------------------------------------------------- */

/** The map's line at lap fraction `d` (points are `[x, z, y]`, index 0 on the line). */
function mapAt(points: number[][], d: number): { x: number; z: number } {
  const n = points.length;
  const f = (((d % 1) + 1) % 1) * n;
  const i0 = Math.floor(f) % n;
  const i1 = (i0 + 1) % n;
  const k = f - Math.floor(f);
  const a = points[i0] as number[];
  const b = points[i1] as number[];
  return { x: (a[0] as number) + ((b[0] as number) - (a[0] as number)) * k, z: (a[1] as number) + ((b[1] as number) - (a[1] as number)) * k };
}

/** Least-squares rotation + translation taking `p` onto `q` (2-D Kabsch). */
function rigidFit(
  px: number[],
  pz: number[],
  qx: number[],
  qz: number[],
): { c: number; s: number; tx: number; tz: number; theta: number } {
  const n = px.length;
  let pcx = 0, pcz = 0, qcx = 0, qcz = 0;
  for (let i = 0; i < n; i++) {
    pcx += px[i] as number;
    pcz += pz[i] as number;
    qcx += qx[i] as number;
    qcz += qz[i] as number;
  }
  pcx /= n; pcz /= n; qcx /= n; qcz /= n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const ax = (px[i] as number) - pcx;
    const az = (pz[i] as number) - pcz;
    const bx = (qx[i] as number) - qcx;
    const bz = (qz[i] as number) - qcz;
    sxx += ax * bx + az * bz;
    sxy += ax * bz - az * bx;
  }
  const theta = Math.atan2(sxy, sxx);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { c, s, theta, tx: qcx - (c * pcx - s * pcz), tz: qcz - (s * pcx + c * pcz) };
}

/** Result of placing one lap's dead-reckoned path on a track map. */
export interface DrivenLineFit {
  x: number[];
  z: number[];
  /** RMS distance from the map's line at the same lap fraction, metres. */
  rmsM: number;
  /** Worst such distance, metres. */
  maxM: number;
  /** Rotation the fit needed, radians. */
  rotationRad: number;
  /** Whether the line passes {@link LINE_MAX_RMS_M} / {@link LINE_MAX_POINT_M}. */
  ok: boolean;
}

/**
 * Close a lap's dead-reckoned path and fit it onto the map. `d` is each
 * point's lap fraction, `rawX`/`rawZ` the integrated positions (any frame).
 * `null` when there is nothing to fit against.
 */
export function fitDrivenLine(
  d: readonly number[],
  rawX: readonly number[],
  rawZ: readonly number[],
  map: Pick<TrackMapPath, 'points'> | null,
): DrivenLineFit | null {
  const n = d.length;
  if (!map || !Array.isArray(map.points) || map.points.length < 50) return null;
  if (n < 8 || rawX.length !== n || rawZ.length !== n) return null;
  const qx: number[] = new Array(n);
  const qz: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const q = mapAt(map.points, d[i] as number);
    qx[i] = q.x;
    qz[i] = q.z;
  }
  const d0 = d[0] as number;
  const dN = d[n - 1] as number;
  const span = dN - d0;
  if (!(span > 0.5)) return null;
  const px = rawX.slice();
  const pz = rawZ.slice();
  // Two passes: the closure error is a displacement in the RAW frame, and
  // reading "how far apart the map says the two ends are" needs the rotation.
  for (let pass = 0; pass < 2; pass++) {
    const f = rigidFit(px, pz, qx, qz);
    // Map displacement first→last point, rotated back into the raw frame.
    const mdx = (qx[n - 1] as number) - (qx[0] as number);
    const mdz = (qz[n - 1] as number) - (qz[0] as number);
    const rdx = f.c * mdx + f.s * mdz;
    const rdz = -f.s * mdx + f.c * mdz;
    const ex = (px[n - 1] as number) - (px[0] as number) - rdx;
    const ez = (pz[n - 1] as number) - (pz[0] as number) - rdz;
    for (let i = 0; i < n; i++) {
      const k = ((d[i] as number) - d0) / span;
      px[i] = (px[i] as number) - ex * k;
      pz[i] = (pz[i] as number) - ez * k;
    }
  }
  const f = rigidFit(px, pz, qx, qz);
  const x: number[] = new Array(n);
  const z: number[] = new Array(n);
  let sq = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const ax = f.c * (px[i] as number) - f.s * (pz[i] as number) + f.tx;
    const az = f.s * (px[i] as number) + f.c * (pz[i] as number) + f.tz;
    x[i] = r1(ax);
    z[i] = r1(az);
    const e = Math.hypot(ax - (qx[i] as number), az - (qz[i] as number));
    sq += e * e;
    if (e > max) max = e;
  }
  const rmsM = Math.sqrt(sq / n);
  return {
    x,
    z,
    rmsM: Math.round(rmsM * 100) / 100,
    maxM: Math.round(max * 100) / 100,
    rotationRad: f.theta,
    ok: rmsM <= LINE_MAX_RMS_M && max <= LINE_MAX_POINT_M && Math.abs(f.theta) <= LINE_MAX_ROTATION_RAD,
  };
}

/* -------------------------------------------------------------------------- */
/*  The capture                                                               */
/* -------------------------------------------------------------------------- */

/** One provider tick, as this module needs it. */
export interface IrCaptureTick {
  /** Wall clock, ms — only for pairing a trace to its lap record. */
  wallMs: number;
  /** `SessionTime`, s — the lap clock. */
  sessionTime: number;
  /** `LapDistPct`, 0..1. */
  pct: number;
  /**
   * The car on this PC is being driven and observed: own car in focus,
   * `IsOnTrack`, in the world, not a replay, not being towed. Pit road counts —
   * an in- or out-lap is still a lap a driver may study.
   */
  driving: boolean;
  trackLengthM: number;
  /** All-time-best store key (`refKeyOf`); `''` = do not persist. */
  refKey: string;
  /** `LapBestLapTime`, s, or ≤0 — the delta's out-lap plausibility guard. */
  bestLapSec: number;
  /** On pit road / in the stall. */
  inPit: boolean;
  /** `PlayerTrackSurface`. */
  surface: number;
  /** `PlayerCarMyIncidentCount`, or NaN. */
  incidents: number;
  /** `Speed`, m/s. */
  speedMps: number;
  /** Body-frame velocity (X forward, Y left) and `Yaw` — the line integration. */
  velX: number;
  velY: number;
  yaw: number;
  /** Driver inputs and motion this tick (no position — that is added here). */
  channels: Omit<TraceChannels, 'x' | 'z'>;
}

/** A completed trace waiting for its lap record. */
interface PendingTrace {
  trace: CompletedTrace;
  wallMs: number;
  /** The lap was integrated end to end, so its raw x/z describe a path. */
  lineOk: boolean;
}

/** What {@link IracingLapCapture.attach} hands back. */
export interface AttachedLap {
  /** The record, with measured sector splits stamped on when they could be. */
  record: LapRecord;
  /** The trace file to write, or `null` when no trace pairs with the record. */
  file: TraceFile | null;
  /** How the driven line fared (absent when none was attempted). */
  line?: Pick<DrivenLineFit, 'rmsM' | 'maxM' | 'ok'>;
}

/**
 * Per-provider state for traces + pace deltas of the car driven on this PC.
 * Fed every tick by `IRacingProvider.buildFrame`; {@link attach} is called with
 * each lap record the lap log is about to write.
 */
export class IracingLapCapture {
  private trace = new LapTraceRecorder();
  private pace = new LocalPaceDeltaTracker();
  private pending: PendingTrace[] = [];

  private wasDriving = false;
  private prevSt = NaN;
  private prevPct = -1;
  private prevVx = 0;
  private prevVy = 0;
  private prevYaw = 0;
  /** Dead-reckoned position, arbitrary frame (maths plane: X right, Y up). */
  private x = 0;
  private y = 0;
  /** The lap in progress has been integrated without a break since its line. */
  private lineOk = false;
  private offTrackCount = 0;
  private wasOff = false;

  /**
   * A new session: the session-best and last references go too. Pending traces
   * do NOT: the lap log holds a record ~40 s for its verdict and flushes it on
   * the stint change, i.e. AFTER the session has moved on — the last lap of a
   * qualifying session lands in the race session. Pairing is by wall clock and
   * lap time, so a trace kept across the boundary cannot pair with the wrong lap.
   */
  public resetSession(): void {
    this.trace.reset();
    this.pace = new LocalPaceDeltaTracker();
    this.wasDriving = false;
    this.prevSt = NaN;
    this.prevPct = -1;
    this.lineOk = false;
    this.offTrackCount = 0;
    this.wasOff = false;
  }

  /** Drop the lap in progress (not the references, not the pending traces). */
  private abandon(): void {
    this.trace.reset();
    this.pace.abandonLap();
    this.lineOk = false;
    this.prevSt = NaN;
    this.prevPct = -1;
  }

  /**
   * Fold one tick in. Returns the pace deltas to publish, or `undefined` while
   * the car is not being driven (the widget then says "no car", as LMU's does
   * when spectating).
   */
  public update(s: IrCaptureTick): PaceDeltas | undefined {
    const pctOk = fin(s.pct) && s.pct >= 0 && s.pct <= 1;
    const st = s.sessionTime;
    if (!s.driving || !pctOk || !fin(st) || st <= 0) {
      if (this.wasDriving) this.abandon();
      this.wasDriving = false;
      return undefined;
    }
    const L = s.trackLengthM > 0 ? s.trackLengthM : 0;

    if (this.wasDriving && fin(this.prevSt)) {
      const dt = st - this.prevSt;
      if (dt < 0) {
        // The clock went back: a new session the key did not catch, or a
        // restart. The delta engine resets itself on a rewind; follow it.
        this.abandon();
      } else if (dt > 0) {
        // Teleport: a tow, a reset to the pits, a "get in car" — the lap
        // fraction moved further than the car could have driven. Seen as a
        // line crossing it would close a short lap, so end the lap here.
        let dPct = s.pct - this.prevPct;
        if (dPct > 0.5) dPct -= 1;
        else if (dPct < -0.5) dPct += 1;
        const movedM = Math.abs(dPct) * (L || 5000);
        const couldM = Math.abs(fin(s.speedMps) ? s.speedMps : 0) * dt * 2 + 30;
        if (movedM > couldM) this.abandon();
      }
    }

    // Off-track excursions, counted like the lap log counts them, so the
    // delta's bests obey the same clean-lap rule as the lap database.
    const off = s.surface === SURFACE_OFF_TRACK;
    if (off && !this.wasOff) this.offTrackCount++;
    this.wasOff = off;

    // Line integration (midpoint, as positionIntegrator.ts).
    const dt = fin(this.prevSt) ? st - this.prevSt : NaN;
    const integrable = fin(s.velX) && fin(s.velY) && fin(s.yaw);
    if (fin(dt) && dt > 0 && dt <= MAX_INTEGRATE_DT_S && integrable) {
      let dy = s.yaw - this.prevYaw;
      if (dy > Math.PI) dy -= 2 * Math.PI;
      else if (dy < -Math.PI) dy += 2 * Math.PI;
      const psi = this.prevYaw + dy / 2;
      const vx = (this.prevVx + s.velX) / 2;
      const vy = (this.prevVy + s.velY) / 2;
      this.x += (vx * Math.cos(psi) - vy * Math.sin(psi)) * dt;
      this.y += (vx * Math.sin(psi) + vy * Math.cos(psi)) * dt;
    } else if (!(fin(dt) && dt === 0)) {
      // First tick, a gap no straight line spans, or no motion channels.
      this.lineOk = false;
    }

    // A line crossing — the recorders' own rule. The lap ENDING now keeps the
    // flag it had; the one starting is integrable from here.
    const crossing = this.prevPct > 0.5 && s.pct < this.prevPct - 0.5;
    const endedLineOk = this.lineOk;
    if (crossing) this.lineOk = integrable;

    const done = this.trace.update(s.pct, st, {
      ...s.channels,
      ...(integrable ? { x: this.x, z: this.y } : {}),
    });
    if (done) {
      this.pending.push({ trace: done, wallMs: s.wallMs, lineOk: endedLineOk && !!done.x });
      this.pending = this.pending.filter((p) => s.wallMs - p.wallMs < PENDING_MAX_AGE_MS).slice(-4);
    }

    const deltas = this.pace.update(s.pct, st, s.bestLapSec > 0 ? s.bestLapSec : -1, s.refKey, {
      cuts: this.offTrackCount,
      ...(fin(s.incidents) && s.incidents >= 0 ? { penalties: s.incidents } : {}),
      inPit: s.inPit,
    });

    this.wasDriving = true;
    this.prevSt = st;
    this.prevPct = s.pct;
    if (integrable) {
      this.prevVx = s.velX;
      this.prevVy = s.velY;
      this.prevYaw = s.yaw;
    }
    return deltas;
  }

  /** Where the delta engine's clock stands (for a future ghost); see `paceDelta.lapClock`. */
  public lapClock(): { t: number; d: number } | null {
    return this.pace.lapClock();
  }

  /** Traces still waiting for a record — for tests and diagnostics. */
  public pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Pair a lap record that is about to be written with the trace recorded for
   * it, stamp the measured sector splits onto the record, and build the trace
   * file. The pairing is LMU's (`attachTrace`): the wall clock both sides
   * stamped at the crossing (the record ~2 s later — iRacing publishes the lap
   * time after the counter, see `LapGate`), plus the lap times agreeing.
   *
   * The file's `lapMs` IS the record's — the board refuses a trace whose
   * `lap_ms` is not exactly the board lap's, so it is never re-derived.
   */
  public attach(rec: LapRecord, map: TrackMapPath | null, sectorStartPcts: readonly number[]): AttachedLap {
    const atMs = Date.parse(rec.at);
    if (!rec.id || !Number.isFinite(atMs)) return { record: rec, file: null };
    let bestIdx = -1;
    let bestGap = PAIR_WINDOW_MS;
    for (let i = 0; i < this.pending.length; i++) {
      const gap = Math.abs(atMs - (this.pending[i] as PendingTrace).wallMs);
      if (gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return { record: rec, file: null };
    const p = this.pending[bestIdx] as PendingTrace;
    this.pending.splice(bestIdx, 1);
    if (rec.lapMs > 0 && Math.abs(p.trace.lapSec * 1000 - rec.lapMs) > PAIR_LAP_TOLERANCE_MS) {
      return { record: rec, file: null };
    }

    // Sectors: three fill the named fields; any other count only `sectorsMs`.
    let record = rec;
    const splits =
      rec.lapMs > 0 && Math.abs(p.trace.lapSec * 1000 - rec.lapMs) <= SECTOR_LAP_TOLERANCE_MS
        ? sectorSplitsFromTrace(p.trace, sectorStartPcts, rec.lapMs)
        : null;
    if (splits && rec.s1Ms === undefined) {
      record =
        splits.length === 3
          ? { ...rec, s1Ms: splits[0] as number, s2Ms: splits[1] as number, s3Ms: splits[2] as number }
          : { ...rec, sectorsMs: splits };
    }

    // The driven line: fitted onto the map, or dropped.
    const { x: rawX, z: rawZ, ...rest } = p.trace;
    let trace: CompletedTrace = rest;
    let line: AttachedLap['line'];
    if (p.lineOk && rawX && rawZ) {
      const fit = fitDrivenLine(p.trace.d, rawX, rawZ, map);
      if (fit) {
        line = { rmsM: fit.rmsM, maxM: fit.maxM, ok: fit.ok };
        if (fit.ok) trace = { ...rest, x: fit.x, z: fit.z };
      }
    }

    const file: TraceFile = {
      v: trace.x ? 2 : 1,
      lapId: rec.id,
      at: rec.at,
      sim: rec.sim,
      trackKey: rec.trackKey,
      track: rec.track,
      trackLengthM: rec.trackLengthM,
      car: rec.car,
      carClass: rec.carClass,
      lapMs: rec.lapMs,
      ...(record.s1Ms ? { s1Ms: record.s1Ms } : {}),
      ...(record.s2Ms ? { s2Ms: record.s2Ms } : {}),
      ...(record.s3Ms ? { s3Ms: record.s3Ms } : {}),
      ...(record.sectorsMs ? { sectorsMs: record.sectorsMs } : {}),
      trace,
    };
    return { record, file, ...(line ? { line } : {}) };
  }
}
