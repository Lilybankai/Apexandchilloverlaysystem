/**
 * @file src/telemetry/lapDetail.ts
 * @module telemetry/lapDetail
 *
 * One lap, assembled for study: its driving trace, the circuit it was driven
 * on, and the handful of things that have to be derived before either can be
 * drawn. Phase 2 of `docs/STINT-REVIEW-PLAN.md`.
 *
 * `lapTrace.ts` records the lap and `trackMap.ts` learns the circuit. Neither
 * knows about the other, and joining them turns out to need three pieces of
 * real work that are easy to get quietly wrong. All three are here, with the
 * evidence from live probes on 2026-09-07 that settled them.
 *
 * ## 1. A lap's track key is NOT a track map's track key
 * They are two different schemes, built by two functions, for two jobs:
 *
 * | | built by | Circuit of the Americas |
 * |---|---|---|
 * | lap log / trace | `paceDelta.trackKeyOf(name, m)` | `circuit-of-the-americas_5497` |
 * | track map       | `trackMap.trackKey(name, config, m)` | `circuit-of-the-americas-5500` |
 *
 * Underscore versus hyphen, and exact metres versus metres rounded to ten. So
 * a lap's `trackKey` cannot be handed to `loadTrackMap()` — it misses every
 * time, silently, and the map view would simply be empty forever.
 *
 * The fix is not to rewrite the string but to **rebuild the key from the fields
 * the lap already carries** — `track`, `trackConfig`, `trackLengthM` — through
 * the map's own key function, so the two can never drift again. Probed against
 * every lap on the build machine: **11 of 11 track identities resolved**, 944
 * laps, mixing bundled and locally-learned shapes.
 *
 * ## 2. Sector lines are found on the trace's own clock, not the sim's
 * The lap record's `s1Ms`/`s2Ms`/`s3Ms` are durations on the SIM's clock. The
 * trace's `t` is the delta engine's own measured lap clock, and the two differ
 * by a few milliseconds a lap. Rather than assume they agree, the split is
 * scaled onto the trace's clock by the ratio of the two lap times before it is
 * looked up, and the answer is a **distance** — where on the circuit the line
 * is — which is what both the charts and the map need.
 *
 * Probed on three separate Spa laps: S1 at 31.1%, 31.0%, 31.1% and S2 at
 * 70.7%, 70.7%, 70.7% of the lap. A fixed line on the road giving the same
 * answer to a tenth of a percent across laps is what a correct derivation
 * looks like.
 *
 * ## 3. A v1 trace has no driven line, and most laps are v1
 * `TraceFile.v` reached 2 (adding `x`/`z`) on 2026-09-07, and nothing migrates
 * — a lap that was never placed on the circuit cannot be placed afterwards. On
 * the build machine that day: **664 traces, every one of them v1**, because the
 * running build predated the recorder.
 *
 * So {@link LapDetail.hasLine} is reported honestly and the renderer degrades
 * rather than guesses: a v1 lap draws the circuit with the scrub cursor placed
 * on the CENTRELINE at the right distance — which is real information ("this
 * is the corner you are looking at") and is exactly how the pit wall's map has
 * always placed a car it has no position for — while a v2 lap draws the line
 * the driver actually took. What is never done is inventing a line from the
 * centreline and presenting it as theirs.
 */

import type { LapRecord } from './lapLog';
import { lapDir, readDay, dayStamp } from './lapLog';
import type { CompletedTrace, TraceFile } from './lapTrace';
import { readTrace, traceDir } from './lapTrace';
import type { TrackMapPath } from './trackMap';
import { loadTrackMap, trackKey } from './trackMap';

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                    */
/* -------------------------------------------------------------------------- */

/** Where the two sector lines fall, as lap-distance fractions 0..1. */
export interface SectorMarks {
  /** End of sector 1. `null` when the lap has no usable splits. */
  s1: number | null;
  /** End of sector 2. */
  s2: number | null;
}

/** One lap, ready to draw. */
export interface LapDetail {
  lapId: string;
  at: string;
  track: string;
  car: string;
  carClass: string;
  /** The sim's lap time, ms — what the timing sheet shows. */
  lapMs: number;
  /** The trace's own measured duration, seconds. */
  lapSec: number;
  /** Points in each channel column. */
  count: number;
  /** The recorder hit its sample cap and the tail of the lap is sparse. */
  truncated: boolean;
  /** `true` when the trace carries the driven line (v2). See the module note. */
  hasLine: boolean;
  /** Highest speed anywhere on the lap, km/h. The one figure only a trace has. */
  vMaxKph: number | null;
  /** Where the two sector lines fall on the lap, as distances. */
  sectors: SectorMarks;
  /** The columns themselves, index-aligned. */
  channels: CompletedTrace;
  /** The key {@link mapKeyForLap} resolved, whether or not a map was found. */
  mapKey: string;
}

/** What {@link loadLapDetail} answers with. */
export interface LapDetailResult {
  detail: LapDetail | null;
  /**
   * The circuit, or `null` when neither this machine nor the bundle has one.
   * Sent separately from the lap so a caller studying several laps at one
   * track can hold onto it rather than being handed the same 60 KB per lap;
   * see the `haveMapKey` argument.
   */
  map: TrackMapPath | null;
  /** Why there is nothing to show, when there is nothing to show. */
  reason?: 'no-lap' | 'no-trace';
}

/* -------------------------------------------------------------------------- */
/*  The three derivations                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The track-map key for a lap. See module note 1 — this rebuilds the key from
 * the lap's own fields rather than transforming its `trackKey`, because the two
 * schemes are not convertible.
 *
 * `trackConfig` is passed through as the map's key function expects it. LMU
 * never publishes one (its REST feed names only the venue), so in practice the
 * layout has to be carried by the name or by the length; the same limitation
 * `referencePace.ts` documents, and not one this function can fix.
 */
export function mapKeyForLap(
  lap: Pick<LapRecord, 'track' | 'trackConfig' | 'trackLengthM'>,
): string {
  return trackKey(lap.track || '', lap.trackConfig, Number(lap.trackLengthM) || 0);
}

/**
 * Locate the sector lines on the lap, as distances.
 *
 * `s1Ms`/`s2Ms` are the sim's DURATIONS; they are summed into a boundary time,
 * scaled onto the trace's clock, and then looked up in `t` to read off the `d`
 * the car was at. Returns `null` for a boundary that cannot be placed rather
 * than a plausible-looking guess: a sector line drawn in the wrong place is
 * worse than no sector line, because every judgement made against it is wrong
 * in a way the driver cannot see.
 */
export function sectorMarks(
  trace: CompletedTrace,
  lapMs: number,
  s1Ms?: number,
  s2Ms?: number,
): SectorMarks {
  const out: SectorMarks = { s1: null, s2: null };
  const t = trace.t;
  const d = trace.d;
  if (!Array.isArray(t) || !Array.isArray(d) || t.length < 2 || t.length !== d.length) return out;
  if (!(lapMs > 0) || !(trace.lapSec > 0)) return out;

  // The two clocks agree to a few milliseconds a lap in practice, but they are
  // measured differently and the ratio costs nothing to apply.
  const scale = (trace.lapSec * 1000) / lapMs;

  const at = (boundaryMs: number): number | null => {
    if (!(boundaryMs > 0) || boundaryMs >= lapMs) return null;
    const target = (boundaryMs * scale) / 1000;
    // Linear scan: a lap is a couple of thousand points and this runs twice.
    for (let i = 1; i < t.length; i++) {
      const prev = t[i - 1] as number;
      const here = t[i] as number;
      if (here < target) continue;
      // Interpolate between the two samples that straddle the line, so the
      // mark does not jump by a sample's worth of road (4–7 m) for free.
      const span = here - prev;
      const f = span > 0 ? (target - prev) / span : 0;
      const d0 = d[i - 1] as number;
      const d1 = d[i] as number;
      return Math.min(1, Math.max(0, d0 + (d1 - d0) * f));
    }
    return null;
  };

  if (typeof s1Ms === 'number') out.s1 = at(s1Ms);
  if (typeof s1Ms === 'number' && typeof s2Ms === 'number') out.s2 = at(s1Ms + s2Ms);
  return out;
}

/** Highest speed on the lap, or `null` when the column is unusable. */
export function vMaxOf(trace: CompletedTrace): number | null {
  const s = trace.speedKph;
  if (!Array.isArray(s) || !s.length) return null;
  let max = -Infinity;
  for (const v of s) if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v;
  return max > -Infinity ? max : null;
}

/**
 * Does this trace carry a driven line?
 *
 * Both columns, present, the same length as the rest, and non-empty. The
 * recorder writes them together or not at all (a half-placed lap carries no
 * line rather than half of one), so this is a check against a hand-edited or
 * future-build file rather than against the recorder.
 */
export function hasDrivenLine(trace: CompletedTrace): boolean {
  const x = (trace as CompletedTrace & { x?: number[] }).x;
  const z = (trace as CompletedTrace & { z?: number[] }).z;
  if (!Array.isArray(x) || !Array.isArray(z)) return false;
  return x.length > 1 && x.length === trace.d.length && z.length === x.length;
}

/* -------------------------------------------------------------------------- */
/*  Loading                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Find one lap record by id, reading only the day it landed on.
 *
 * The whole log is a few hundred kilobytes and reading it is cheap, but a lap's
 * `at` names its file exactly, so there is no reason to read anything else.
 */
export function findLap(lapId: string, atIso: string, dir = lapDir()): LapRecord | null {
  const ms = Date.parse(atIso);
  if (!Number.isFinite(ms)) return null;
  // A lap that finished either side of UTC midnight can be filed on the day
  // before its `at` rounds to; both are one small read.
  for (const day of [dayStamp(ms), dayStamp(ms - 86_400_000), dayStamp(ms + 86_400_000)]) {
    for (const rec of readDay(day, dir)) {
      if (rec.id === lapId) return rec;
    }
  }
  return null;
}

/**
 * Assemble one lap for the detail view.
 *
 * @param haveMapKey - the circuit the caller is already holding. When it
 *   matches, `map` comes back `null` and the caller keeps what it has — which
 *   is the normal case while someone clicks through the laps of one session,
 *   and saves shipping Le Mans's two thousand points over and over.
 */
export function loadLapDetail(
  lapId: string,
  atIso: string,
  haveMapKey = '',
  dirs: { laps?: string; traces?: string } = {},
): LapDetailResult {
  const lap = findLap(lapId, atIso, dirs.laps ?? lapDir());
  if (!lap) return { detail: null, map: null, reason: 'no-lap' };

  const file: TraceFile | null = readTrace(lapId, atIso, dirs.traces ?? traceDir());
  if (!file || !file.trace) return { detail: null, map: null, reason: 'no-trace' };

  const trace = file.trace;
  const mapKey = mapKeyForLap(lap);

  const detail: LapDetail = {
    lapId,
    at: lap.at,
    track: lap.track || file.track || '',
    car: lap.car || file.car || '',
    carClass: lap.carClass || file.carClass || '',
    // The record's time, not the file's: the file's `lapMs` is 0 on a lap the
    // sim never published a time for, and the sheet beside this view shows the
    // record's.
    lapMs: Number(lap.lapMs) || 0,
    lapSec: Number(trace.lapSec) || 0,
    count: Number(trace.count) || trace.d.length,
    truncated: trace.truncated === true,
    hasLine: hasDrivenLine(trace),
    vMaxKph: vMaxOf(trace),
    sectors: sectorMarks(trace, Number(lap.lapMs) || 0, lap.s1Ms, lap.s2Ms),
    channels: trace,
    mapKey,
  };

  const map = haveMapKey === mapKey ? null : loadTrackMap(mapKey);
  return { detail, map };
}

/* -------------------------------------------------------------------------- */
/*  Two laps                                                                  */
/*                                                                            */
/*  Phase 3. Everything below compares a lap against another of the driver's  */
/*  own laps, which is the only comparison the plan allows for now (decision  */
/*  2) and the only one that is fair: same car, same circuit, same hands.     */
/* -------------------------------------------------------------------------- */

/** The running time difference between two laps, on the studied lap's grid. */
export interface DeltaTrace {
  /** Lap distances, 0..1 — the same column as the studied lap's `d`. */
  d: number[];
  /**
   * Seconds the studied lap is BEHIND the comparison lap at that point.
   * Positive is losing, negative is gaining, and the last value is the
   * difference between the two lap times.
   */
  dt: number[];
  /** The widest the gap ever got, either way — the delta band's own scale. */
  reach: number;
}

/** One micro-sector, and what it cost or gained. */
export interface MicroSector {
  /** 1-based, so a chip can be labelled SQ1 without arithmetic. */
  no: number;
  /** Where it starts and ends on the lap, 0..1. */
  from: number;
  to: number;
  /** Seconds spent in this stretch on each lap, and the difference. */
  aSec: number | null;
  bSec: number | null;
  deltaSec: number | null;
}

/**
 * How many micro-sectors a circuit gets.
 *
 * Roughly one every 500 m, clamped to 8..20 (plan decision 3), so Silverstone
 * National gets eight and Le Mans gets twenty rather than both being cut into
 * Delta's fixed thirteen. A chip has to be a piece of road a driver can picture
 * — 500 m is a corner and its approach — and twenty chips is about as many as
 * one row can carry before they stop being readable.
 */
export function microSectorCount(lengthM: number): number {
  const n = Math.round((Number(lengthM) || 0) / 500);
  return Math.min(20, Math.max(8, Number.isFinite(n) ? n : 8));
}

/**
 * The lap clock at a given distance, in seconds from the line.
 *
 * Interpolated between the two straddling samples, and normalised so the lap
 * starts at zero — a trace's first `t` is wherever the recorder's clock
 * happened to be, and two laps compared without that subtraction differ by a
 * constant with no visible cause.
 */
export function timeAtDistance(trace: CompletedTrace, dd: number): number | null {
  const d = trace.d;
  const t = trace.t;
  if (!Array.isArray(d) || !Array.isArray(t) || d.length < 2 || d.length !== t.length) return null;
  const base = t[0] as number;
  const target = Math.min(1, Math.max(0, dd));
  if (target <= (d[0] as number)) return 0;
  if (target >= (d[d.length - 1] as number)) return (t[t.length - 1] as number) - base;

  let lo = 0;
  let hi = d.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((d[mid] as number) < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const d0 = d[i - 1] as number;
  const d1 = d[i] as number;
  const span = d1 - d0;
  const f = span > 0 ? (target - d0) / span : 0;
  const t0 = (t[i - 1] as number) - base;
  const t1 = (t[i] as number) - base;
  return t0 + (t1 - t0) * f;
}

/**
 * The delta trace: how far up or down the studied lap was, all the way round.
 *
 * Built on **distance**, not on time, and on the studied lap's own sample grid.
 * That is the only alignment that answers the question a driver is asking —
 * "at this point on the road, was I up or down?" — and it needs no resampling
 * of either lap: the comparison lap's clock is interpolated at each of the
 * studied lap's distances.
 */
export function deltaTrace(a: CompletedTrace, b: CompletedTrace): DeltaTrace | null {
  const d = a.d;
  const t = a.t;
  if (!Array.isArray(d) || !Array.isArray(t) || d.length < 2 || d.length !== t.length) return null;
  if (!Array.isArray(b.d) || b.d.length < 2) return null;
  const base = t[0] as number;
  const out: DeltaTrace = { d: [], dt: [], reach: 0 };
  for (let i = 0; i < d.length; i++) {
    const dd = d[i] as number;
    const other = timeAtDistance(b, dd);
    if (other === null) continue;
    const gap = ((t[i] as number) - base) - other;
    out.d.push(dd);
    out.dt.push(gap);
    const mag = Math.abs(gap);
    if (mag > out.reach) out.reach = mag;
  }
  return out.d.length > 1 ? out : null;
}

/**
 * Cut the lap into micro-sectors and time both laps through each one.
 *
 * Evenly spaced by distance rather than by corner: Apex does not know where the
 * corners are, and a chip that is "the same stretch of road on both laps" is
 * exactly as useful for finding where the time went. A stretch with no answer
 * on one lap — a truncated trace, a comparison that stopped short — reports
 * `null` rather than a difference computed against nothing.
 */
export function microSectors(
  a: CompletedTrace,
  b: CompletedTrace | null,
  lengthM: number,
): MicroSector[] {
  const n = microSectorCount(lengthM);
  const out: MicroSector[] = [];
  for (let i = 0; i < n; i++) {
    const from = i / n;
    const to = (i + 1) / n;
    const a0 = timeAtDistance(a, from);
    const a1 = timeAtDistance(a, to);
    const aSec = a0 !== null && a1 !== null ? a1 - a0 : null;
    let bSec: number | null = null;
    if (b) {
      const b0 = timeAtDistance(b, from);
      const b1 = timeAtDistance(b, to);
      bSec = b0 !== null && b1 !== null ? b1 - b0 : null;
    }
    out.push({
      no: i + 1,
      from,
      to,
      aSec,
      bSec,
      deltaSec: aSec !== null && bSec !== null ? aSec - bSec : null,
    });
  }
  return out;
}

/** A lap and its comparison, ready to draw over one another. */
export interface LapCompareResult extends LapDetailResult {
  /** The lap being compared against, or `null` when none was asked for. */
  vs: LapDetail | null;
  delta: DeltaTrace | null;
  micro: MicroSector[];
  /** Why there is no comparison, when one was asked for and could not be made. */
  vsReason?: 'no-lap' | 'no-trace';
}

/** The circuit's length as the lap itself recorded it, metres. */
function trackLengthOf(lapId: string, atIso: string, dir: string): number {
  const lap = findLap(lapId, atIso, dir);
  return lap ? Number(lap.trackLengthM) || 0 : 0;
}

/**
 * One lap, optionally with a second laid over it.
 *
 * The comparison lap comes back in full rather than as a delta alone: the
 * charts draw its speed and pedals under the studied lap's, and the map draws
 * the line it took. A delta trace on its own says *that* time was lost without
 * ever saying how.
 */
export function loadLapCompare(
  lapId: string,
  atIso: string,
  vs: { id: string; at: string } | null,
  haveMapKey = '',
  dirs: { laps?: string; traces?: string } = {},
): LapCompareResult {
  const base = loadLapDetail(lapId, atIso, haveMapKey, dirs);
  const out: LapCompareResult = { ...base, vs: null, delta: null, micro: [] };
  if (!base.detail) return out;

  const lengthM = trackLengthOf(lapId, atIso, dirs.laps ?? lapDir());
  if (!vs || !vs.id || !vs.at) {
    out.micro = microSectors(base.detail.channels, null, lengthM);
    return out;
  }

  // The circuit is never sent twice: both laps come out of one session, so the
  // comparison lap is on the same track by construction and the caller is
  // already holding it.
  const other = loadLapDetail(vs.id, vs.at, base.detail.mapKey, dirs);
  if (!other.detail) {
    out.vsReason = other.reason;
    out.micro = microSectors(base.detail.channels, null, lengthM);
    return out;
  }
  out.vs = other.detail;
  out.delta = deltaTrace(base.detail.channels, other.detail.channels);
  out.micro = microSectors(base.detail.channels, other.detail.channels, lengthM);
  return out;
}
