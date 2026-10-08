/**
 * practiceReview.ts — a practice session, lap by lap and corner by corner,
 * against the lap the driver was chasing.
 * =============================================================================
 *
 * Phase 1 of `docs/PRACTICE-REVIEW-PLAN.md`: the debrief. Given the session
 * (`stintReview.ts`), the traces of its laps and the target that was chased on
 * track (the snapshot of the published ghost — see the plan's "The target is a
 * snapshot"), this works out:
 *
 *   - every lap's time against the target, and its corners scored with
 *     `corners.ts cornerResult()` — the same scorer the live Corner Analysis
 *     card is built on, so the review never disagrees with what was on screen;
 *   - the session's best, its theoretical best (the best of every segment of
 *     the lap, added up) and its consistency;
 *   - per corner, what it cost on average and how it was usually driven.
 *
 * Corners come from the REFERENCE, in its own order, named C1..Cn on screen.
 * When the target carries the `corners` list `/ghost.json` serves, that list
 * is used as it is — it is the list the live Corner Analysis numbered, so
 * "C5" here is the C5 the driver saw. Otherwise `findCorners()` cuts them from
 * the reference's columns, which is how that list was made in the first place.
 *
 * ## Signs, and why they are pinned
 * Positive is LOSING everywhere a time is involved (`deltaSec`, a corner's
 * loss) — the Review tab's convention, and `cornerResult()`'s. A braking delta
 * is positive when the driver braked LATER than the reference; an apex speed
 * delta is positive when they carried MORE speed. `scripts/test-practicereview.js`
 * holds all three in both directions.
 *
 * ## Which laps count
 * Every lap is listed. Only VALID laps — clean (`ReviewLap.clean`) and with a
 * real time (`timed`) — count towards the best, the theoretical best, the
 * consistency and the corner averages. A dirty lap is a lap the stewards would
 * not have counted; averaging it in would teach from a cut.
 *
 * Pure: no fs, no Electron, no clock. `practiceReviewLoad.ts` does the reading.
 */

import { cornerResult, findCorners, type CornerTrace, type LapColumns } from './corners';
import { scoreLap, type AccuracyScore } from './accuracyScore';
import type { ReviewLap, ReviewSession } from './stintReview';
import type { TraceFile } from './lapTrace';

/* -------------------------------------------------------------------------- */
/*  The contract (docs/PRACTICE-REVIEW-PLAN.md)                               */
/* -------------------------------------------------------------------------- */

export interface PracticeTargetInfo {
  kind: 'chased' | 'sessionBest';
  label: string;
  lapId: string;
  lapSec: number;
}

export interface PracticeLapCorner {
  index: number;
  deltaSec: number | null;
  brakeDeltaM: number | null;
  apexKphDelta: number | null;
  /** How closely this corner copied the target, 0..100 (accuracyScore.ts). */
  score: AccuracyScore | null;
}

export interface PracticeLap {
  at: string;
  lapNo: number;
  lapSec: number;
  valid: boolean;
  hasTrace: boolean;
  /** `lapSec − target.lapSec`; positive = slower. `null` without a target or a real time. */
  deltaSec: number | null;
  corners: PracticeLapCorner[];
  /** The lap's accuracy score; null without a trace. */
  score: AccuracyScore | null;
}

export interface CornerSummary {
  /** C(index+1) on screen; the reference's own order, never official names. */
  index: number;
  entryD: number;
  apexD: number;
  exitD: number;
  /** Valid laps that could be scored through this corner. */
  laps: number;
  avgLossSec: number | null;
  bestSec: number | null;
  worstSec: number | null;
  avgBrakeDeltaM: number | null;
  avgApexKphDelta: number | null;
  /** Mean corner score over the valid laps scored here. */
  avgScore: number | null;
}

/** The session's accuracy, over its valid laps (the target lap itself excluded). */
export interface PracticeSessionScore {
  avg: number | null;
  best: number | null;
  bestLapNo: number | null;
}

export interface PracticeReview {
  id: string;
  track: string;
  car: string;
  carClass: string;
  trackLengthM: number;
  startedAt: string;
  endedAt: string;
  target: PracticeTargetInfo | null;
  laps: PracticeLap[];
  bestLapSec: number | null;
  theoreticalBestSec: number | null;
  consistencySec: number | null;
  corners: CornerSummary[];
  score: PracticeSessionScore;
}

/**
 * The target as it was snapshotted: `/ghost.json`'s body under `columns`.
 * Only the columns this module reads are typed; the rest ride along.
 */
export interface PracticeTargetSnapshot {
  kind: 'chased' | 'sessionBest';
  label: string;
  lapId: string;
  lapSec: number;
  columns: {
    d: readonly number[];
    t: readonly number[];
    speedKph?: readonly number[];
    brake?: readonly number[];
    throttle?: readonly number[];
    x?: readonly number[];
    z?: readonly number[];
    trackLengthM?: number;
    corners?: readonly { entryD: number; apexD: number; exitD: number }[];
  };
}

export interface PracticeReviewInput {
  session: ReviewSession;
  /** Trace per lap id; `null` or absent = no trace on disk. */
  traces: Map<string, TraceFile | null>;
  /** The chased lap, or `null` to measure against the session's best traced lap. */
  target: PracticeTargetSnapshot | null;
  /** When the session ended (the detector's answer); falls back to the session's own end. */
  endedAt?: string;
}

/** Laps within this share of the best count towards the consistency figure. */
export const CONSISTENCY_WINDOW = 1.07;

/* -------------------------------------------------------------------------- */
/*  Columns                                                                   */
/* -------------------------------------------------------------------------- */

/** One lap's columns, cleaned so every interpolator can trust them. */
export interface PracticeColumns {
  d: number[];
  t: number[];
  speedKph?: number[];
  brake?: number[];
  throttle?: number[];
  x?: number[];
  z?: number[];
}

/**
 * Keep only samples that advance strictly in `d` and never go back in `t`,
 * filtering every other column by the SAME pass so nothing drifts out of step
 * (`ghostLap.cleanTraceIndexed`'s rule, restated here so this module does not
 * load the pace engine and its file store).
 */
export function cleanCols(src: {
  d: readonly number[];
  t: readonly number[];
  speedKph?: readonly number[];
  brake?: readonly number[];
  throttle?: readonly number[];
  x?: readonly number[];
  z?: readonly number[];
}): PracticeColumns | null {
  if (!src || !Array.isArray(src.d) || !Array.isArray(src.t)) return null;
  const n = Math.min(src.d.length, src.t.length);
  const keep: number[] = [];
  let pd = -Infinity;
  let pt = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const d = src.d[i]!;
    const t = src.t[i]!;
    if (!Number.isFinite(d) || !Number.isFinite(t) || d < 0 || d > 1 || t < 0) continue;
    if (d <= pd || t < pt) continue;
    keep.push(i);
    pd = d;
    pt = t;
  }
  if (keep.length < 2) return null;
  const pick = (col: readonly number[] | undefined): number[] | undefined =>
    Array.isArray(col) && col.length >= n ? keep.map((i) => col[i]!) : undefined;
  const out: PracticeColumns = { d: keep.map((i) => src.d[i]!), t: keep.map((i) => src.t[i]!) };
  const speedKph = pick(src.speedKph);
  const brake = pick(src.brake);
  const throttle = pick(src.throttle);
  const x = pick(src.x);
  const z = pick(src.z);
  if (speedKph) out.speedKph = speedKph;
  if (brake) out.brake = brake;
  if (throttle) out.throttle = throttle;
  if (x && z) {
    out.x = x;
    out.z = z;
  }
  return out;
}

/**
 * Time into the lap at fraction `d`, with the line pinned at both ends: the
 * lap starts at `t = 0` on the line and ends at `t = lapSec` on it. A stored
 * trace's first and last samples sit a few metres either side of the line, so
 * without the pins the first and last segments would lose those metres and
 * the segments would not add up to the lap.
 */
function timeAtLap(c: PracticeColumns, lapSec: number, d: number): number | null {
  if (d <= 0) return 0;
  if (d >= 1) return lapSec;
  const n = c.d.length;
  if (d < c.d[0]!) {
    const d1 = c.d[0]!;
    return d1 > 0 ? (c.t[0]! * d) / d1 : 0;
  }
  if (d > c.d[n - 1]!) {
    const d0 = c.d[n - 1]!;
    const t0 = c.t[n - 1]!;
    return d0 < 1 ? t0 + ((lapSec - t0) * (d - d0)) / (1 - d0) : lapSec;
  }
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c.d[mid]! >= d) hi = mid;
    else lo = mid + 1;
  }
  const d0 = c.d[lo - 1]!;
  const d1 = c.d[lo]!;
  const t0 = c.t[lo - 1]!;
  return d1 > d0 ? t0 + (c.t[lo]! - t0) * ((d - d0) / (d1 - d0)) : t0;
}

/** A trace that covers the lap from line to line (a few metres' slack either end). */
function coversLap(c: PracticeColumns): boolean {
  return c.d[0]! <= 0.02 && c.d[c.d.length - 1]! >= 0.98;
}

/** The reference's corners, or none when it has no speed channel to cut them from. */
function cornersOf(c: PracticeColumns, lengthM: number): { entryD: number; apexD: number; exitD: number }[] {
  if (!c.speedKph) return [];
  return findCorners({ ...c, speedKph: c.speedKph } as CornerTrace, lengthM);
}

/* -------------------------------------------------------------------------- */
/*  Small numerics                                                            */
/* -------------------------------------------------------------------------- */

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;
const round1 = (v: number): number => Math.round(v * 10) / 10;

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Sample standard deviation — `stintReview.ts`'s spread, for the same reason. */
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function fmtLap(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/* -------------------------------------------------------------------------- */
/*  The review                                                                */
/* -------------------------------------------------------------------------- */

const lapsOf = (s: ReviewSession): ReviewLap[] =>
  s.stints.flatMap((st) => st.laps).sort((a, b) => a.lapNo - b.lapNo);

const isValid = (l: ReviewLap): boolean => l.clean === true && l.timed === true && l.lapMs > 0;

/** What a session is measured against, with the corners that cut it up. */
export interface PracticeReference {
  target: PracticeTargetInfo;
  /** The reference's cleaned columns. */
  ref: PracticeColumns;
  corners: { entryD: number; apexD: number; exitD: number }[];
}

/**
 * The reference for a session: the chased lap when it was snapshotted, else
 * the session's best valid lap among those in `cols`. Shared by the debrief
 * and the lap deep dive (`practiceLap.ts`) so "C5" is the same corner in both
 * — and the C5 the driver saw on track when the snapshot carries the served
 * corner list.
 */
export function practiceReference(
  s: ReviewSession,
  cols: Map<string, PracticeColumns>,
  snapshot: PracticeTargetSnapshot | null,
): PracticeReference | null {
  const L = s.trackLengthM > 0 ? s.trackLengthM : 0;
  if (snapshot) {
    const ref = cleanCols(snapshot.columns);
    if (ref) {
      const served = snapshot.columns.corners;
      return {
        target: { kind: snapshot.kind, label: snapshot.label, lapId: snapshot.lapId, lapSec: snapshot.lapSec },
        ref,
        corners:
          Array.isArray(served) && served.length > 0
            ? served.map((c) => ({ entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }))
            : cornersOf(ref, L > 0 ? L : snapshot.columns.trackLengthM || 0),
      };
    }
  }
  let best: ReviewLap | null = null;
  for (const lap of lapsOf(s)) {
    if (!isValid(lap) || !lap.id || !cols.has(lap.id)) continue;
    if (!best || lap.lapMs < best.lapMs) best = lap;
  }
  if (!best || !best.id) return null;
  const ref = cols.get(best.id)!;
  const lapSec = best.lapMs / 1000;
  return {
    target: { kind: 'sessionBest', label: `Session best · ${fmtLap(lapSec)}`, lapId: best.id, lapSec },
    ref,
    corners: cornersOf(ref, L),
  };
}

/** The session's best valid lap (the `sessionBest` reference), or null. */
export function bestValidLap(s: ReviewSession): ReviewLap | null {
  let best: ReviewLap | null = null;
  for (const lap of lapsOf(s)) {
    if (!isValid(lap) || !lap.id || !lap.hasTrace) continue;
    if (!best || lap.lapMs < best.lapMs) best = lap;
  }
  return best;
}

/**
 * Build the debrief. Never throws on missing data: a session with no traced
 * lap and no target still lists its laps, with every comparison `null`.
 */
export function buildPracticeReview(input: PracticeReviewInput): PracticeReview {
  const s = input.session;
  const laps = lapsOf(s);
  const L = s.trackLengthM > 0 ? s.trackLengthM : 0;

  // Every lap's own columns, once.
  const cols = new Map<string, PracticeColumns>();
  for (const lap of laps) {
    if (!lap.id) continue;
    const file = input.traces.get(lap.id);
    if (!file || !file.trace) continue;
    const c = cleanCols(file.trace);
    if (c) cols.set(lap.id, c);
  }

  const reference = practiceReference(s, cols, input.target);
  const target: PracticeTargetInfo | null = reference ? reference.target : null;
  const refCorners = reference ? reference.corners : [];
  const refColumns: LapColumns | null = reference ? reference.ref : null;

  // Laps.
  const outLaps: PracticeLap[] = laps.map((lap) => {
    const valid = isValid(lap);
    const lapSec = lap.lapMs > 0 ? lap.lapMs / 1000 : 0;
    const c = lap.id ? cols.get(lap.id) : undefined;
    const corners: PracticeLapCorner[] = [];
    let score: AccuracyScore | null = null;
    if (c && reference && refColumns && L > 0) {
      const scored = scoreLap(c, reference.ref, refCorners, L);
      score = scored.score;
      refCorners.forEach((corner, index) => {
        const r = cornerResult(corner, refColumns, c, L);
        corners.push({
          index,
          deltaSec: r.deltaSec,
          brakeDeltaM: r.brakeDeltaM,
          apexKphDelta: r.apexKphDelta,
          score: scored.corners[index] ?? null,
        });
      });
    }
    return {
      at: lap.at,
      lapNo: lap.lapNo,
      lapSec: round3(lapSec),
      valid,
      hasTrace: !!c,
      deltaSec: target && lap.timed && lapSec > 0 ? round3(lapSec - target.lapSec) : null,
      corners,
      score,
    };
  });
  // The lap that IS the target scores 100 against itself; it says nothing
  // about accuracy, so it is left out of every average and of "best".
  const isTargetLap = (i: number): boolean =>
    !!target && target.kind === 'sessionBest' && laps[i]!.id === target.lapId;

  // Best and consistency over valid laps.
  const validTimes = laps.filter(isValid).map((l) => l.lapMs / 1000);
  const bestLapSec = validTimes.length ? Math.min(...validTimes) : null;
  const inWindow = bestLapSec === null ? [] : validTimes.filter((t) => t <= bestLapSec * CONSISTENCY_WINDOW);
  const sd = stdev(inWindow);
  const consistencySec = sd === null ? null : round3(sd);

  // Theoretical best: the reference's corners cut the lap into segments —
  // each corner, and each straight between one corner's exit and the next
  // one's entry (the last straight wraps over the line, split there). The
  // fastest valid traced lap through each, added up.
  let theoreticalBestSec: number | null = null;
  const traced = laps.filter((l) => isValid(l) && l.id && cols.has(l.id) && coversLap(cols.get(l.id)!));
  if (traced.length >= 2) {
    const cuts = new Set<number>([0, 1]);
    for (const c of refCorners) {
      if (c.entryD > 0 && c.entryD < 1) cuts.add(c.entryD);
      if (c.exitD > 0 && c.exitD < 1) cuts.add(c.exitD);
    }
    const edges = [...cuts].sort((a, b) => a - b);
    let total = 0;
    for (let k = 0; k + 1 < edges.length; k += 1) {
      let segBest = Infinity;
      for (const lap of traced) {
        const c = cols.get(lap.id!)!;
        const lapSec = lap.lapMs / 1000;
        const a = timeAtLap(c, lapSec, edges[k]!);
        const b = timeAtLap(c, lapSec, edges[k + 1]!);
        if (a !== null && b !== null && b >= a) segBest = Math.min(segBest, b - a);
      }
      if (!Number.isFinite(segBest)) {
        total = NaN;
        break;
      }
      total += segBest;
    }
    if (Number.isFinite(total)) theoreticalBestSec = round3(total);
  }

  // Per corner, over valid laps.
  const corners: CornerSummary[] = refCorners.map((c, index) => {
    const losses: number[] = [];
    const brakes: number[] = [];
    const apexes: number[] = [];
    const scores: number[] = [];
    outLaps.forEach((lap, li) => {
      if (!lap.valid) return;
      const r = lap.corners[index];
      if (!r) return;
      if (r.deltaSec !== null) losses.push(r.deltaSec);
      if (r.brakeDeltaM !== null) brakes.push(r.brakeDeltaM);
      if (r.apexKphDelta !== null) apexes.push(r.apexKphDelta);
      if (r.score && !isTargetLap(li)) scores.push(r.score.total);
    });
    const avgLoss = mean(losses);
    const avgBrake = mean(brakes);
    const avgApex = mean(apexes);
    const avgScore = mean(scores);
    return {
      index,
      entryD: c.entryD,
      apexD: c.apexD,
      exitD: c.exitD,
      laps: losses.length,
      avgLossSec: avgLoss === null ? null : round4(avgLoss),
      bestSec: losses.length ? round4(Math.min(...losses)) : null,
      worstSec: losses.length ? round4(Math.max(...losses)) : null,
      avgBrakeDeltaM: avgBrake === null ? null : round1(avgBrake),
      avgApexKphDelta: avgApex === null ? null : round1(avgApex),
      avgScore: avgScore === null ? null : Math.round(avgScore),
    };
  });

  // The session's accuracy: valid laps only, the target lap excluded.
  let best: number | null = null;
  let bestLapNo: number | null = null;
  const lapScores: number[] = [];
  outLaps.forEach((lap, i) => {
    if (!lap.valid || !lap.score || isTargetLap(i)) return;
    lapScores.push(lap.score.total);
    if (best === null || lap.score.total > best) {
      best = lap.score.total;
      bestLapNo = lap.lapNo;
    }
  });
  const avgLapScore = mean(lapScores);
  const score: PracticeSessionScore = {
    avg: avgLapScore === null ? null : Math.round(avgLapScore),
    best,
    bestLapNo,
  };

  return {
    id: s.id,
    track: s.track,
    car: s.car,
    carClass: s.carClass,
    trackLengthM: s.trackLengthM,
    startedAt: s.startedAt,
    endedAt: input.endedAt || s.endedAt,
    target,
    laps: outLaps,
    bestLapSec: bestLapSec === null ? null : round3(bestLapSec),
    theoreticalBestSec,
    consistencySec,
    corners,
    score,
  };
}
