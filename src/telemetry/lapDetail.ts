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
