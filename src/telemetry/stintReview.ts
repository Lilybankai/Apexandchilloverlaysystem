/**
 * @file src/telemetry/stintReview.ts
 * @module telemetry/stintReview
 *
 * The **stint reviewer's** reading side: it turns the flat lap log into
 * sessions, stints and the judgements a driver actually wants after getting
 * out of the car. Phase 1 of `docs/STINT-REVIEW-PLAN.md`.
 *
 * Nothing here writes, nothing here talks to the network, and nothing here is
 * stored — every number below is derived from `LapRecord`s that are already on
 * disk. That is deliberate, and it is the plan's "derived, not stored" rule:
 * a better consistency formula next month improves every session a driver ever
 * drove, with no migration and no re-capture.
 *
 * ## There is no session id in the lap log, so we infer one
 * The log is a flat append-only stream of laps. It records the session TYPE
 * (`practice`, `race`, …) but not which *sitting* a lap belonged to, because
 * nothing downstream needed that until now — and it cannot be backfilled by
 * asking the sim, since the sessions in question are over.
 *
 * So a session here is a run of consecutive laps that agree on sim, track,
 * car, class and session type, with no idle gap longer than
 * {@link SESSION_GAP_MS} between them. That is an inference, not a fact from
 * the feed, and it is wrong in exactly one direction: a driver who parks in the
 * garage for over half an hour and then goes back out gets two sessions instead
 * of one. That is the safe way round — two adjacent cards a driver can read
 * together beats one card silently welding this morning's practice onto
 * tonight's, and the gap is generous enough that a normal pit stop, a red flag
 * or a long endurance stop never triggers it.
 *
 * ## Stints are a stronger signal than sessions
 * Stints do not need inferring nearly as hard: the lap log already records
 * {@link LapRecord.stintLap} (counted from pit visits), {@link
 * LapRecord.isOutLap} and {@link LapRecord.isInLap}. A stint breaks when the
 * lap counter resets, when the previous lap came into the pits, when this lap
 * left them, or — for pre-v5 laps that carry none of those — when there is an
 * idle gap of {@link STINT_GAP_MS}. Any one of those is enough; several at once
 * are still one break, not four.
 *
 * ## What "average" and "best" mean here
 * Clean laps only, per the league's own rule (see `lapLog.ts` on why `clean` is
 * our opinion rather than the stewards'). An out-lap, an in-lap and a lap with
 * a wheel over the white line are all still SHOWN — they are part of the story
 * of the stint — but they do not set the best, move the average or count
 * towards consistency. When a stint has no clean lap at all, the stats say
 * `null` rather than quietly falling back to a dirty one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DirtyReason, LapRecord } from './lapLog';
import { lapDir, readDay } from './lapLog';
import { traceFilePath } from './lapTrace';

/* -------------------------------------------------------------------------- */
/*  Grouping thresholds                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Idle time between two laps that ends a session, milliseconds.
 *
 * Thirty minutes. Long enough that nothing inside a real session reaches it —
 * the longest legitimate pause on track is a red flag or a driver-swap stop,
 * both of which are minutes — and short enough that two practice sittings on
 * the same evening stay apart. See the module note on which way this errs.
 */
export const SESSION_GAP_MS = 30 * 60_000;

/**
 * Idle time between two laps that ends a stint, milliseconds.
 *
 * Only ever consulted for laps too old to carry the pit flags (pre-v5). Four
 * minutes covers a leisurely stop with a driver change; anything longer than
 * that with no pit flag to explain it was the feed dropping, and a break is the
 * honest reading of a gap we cannot account for.
 */
export const STINT_GAP_MS = 4 * 60_000;

/**
 * The consistency scale, as a coefficient of variation (stdev ÷ mean) of the
 * clean lap times in a stint.
 *
 * `GOOD` scores 100, `BAD` scores 0, and the scale between them is
 * logarithmic, because lap-time spread is: the difference between 0.15% and
 * 0.3% is the difference between a professional and a quick amateur, while the
 * difference between 1.5% and 1.65% is no difference at all.
 *
 * The percentage is a *bar*, not a headline. Every screen that shows it leads
 * with {@link ReviewStats.spreadMs} — the real spread in seconds — because a
 * driver can act on "±0.31 s" and cannot act on "84%".
 */
export const CV_GOOD = 0.0015;
export const CV_BAD = 0.02;

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                    */
/* -------------------------------------------------------------------------- */

/** One lap as the reviewer shows it: the record, plus where it sits. */
export interface ReviewLap {
  /** The lap's UUID, when it has one (v3+). The join key to its trace. */
  id?: string;
  /** Wall-clock completion time, ISO 8601. */
  at: string;
  /** 1-based position in the session, counting every lap including out-laps. */
  lapNo: number;
  /** 1-based stint number within the session. */
  stintNo: number;
  /** 1-based position within the stint; the out-lap is 1, as in the log. */
  stintLap: number;
  lapMs: number;
  s1Ms?: number;
  s2Ms?: number;
  s3Ms?: number;
  clean: boolean;
  dirty: DirtyReason[];
  /**
   * The lap time is a real time — it is not the sim's nonsense reading for a
   * lap that spanned a session restart. A lap can be `timed` and dirty (a
   * genuine time with a wheel over the line); it is shown but never averaged.
   */
  timed: boolean;
  isOutLap: boolean;
  isInLap: boolean;
  fuelStartL?: number;
  fuelEndL?: number;
  fuelUsedL?: number;
  /** Virtual energy burned over the lap, percentage points. */
  veUsedPct?: number;
  wear?: [number, number, number, number];
  temp?: [number, number, number, number];
  compound?: string;
  trackTempC?: number;
  ambientTempC?: number;
  wet?: boolean;
  /**
   * A driving trace exists on this machine for this lap, so the detail view
   * (phase 2) has something to draw. Checked rather than assumed: traces are
   * written for flying laps only, and a lap driven before the trace recorder
   * shipped has none.
   */
  hasTrace: boolean;
}

/** The derived judgements, computed identically for a stint and a session. */
export interface ReviewStats {
  /** Every lap, including out-laps and dirty ones. */
  laps: number;
  /** The subset that passed the clean-lap rule AND carries a real time. */
  cleanLaps: number;
  /** Laps with a real time, clean or not. */
  timedLaps: number;
  /** Fastest clean lap, ms. `null` when there was not one. */
  bestMs: number | null;
  /** Mean of the clean laps, ms. */
  averageMs: number | null;
  /** Median of the clean laps, ms — what a spread is measured against. */
  medianMs: number | null;
  /** The best S1, S2 and S3 seen, each from whichever lap set it. */
  bestSectors: [number | null, number | null, number | null];
  /** Sum of {@link bestSectors}; `null` unless all three exist. */
  optimalMs: number | null;
  /** Best minus optimal — the time left on the table. `null` if either is. */
  untappedMs: number | null;
  /** Standard deviation of the clean laps, ms. `null` below two of them. */
  spreadMs: number | null;
  /** {@link spreadMs} on the 0–100 scale set by {@link CV_GOOD}/{@link CV_BAD}. */
  consistency: number | null;
  /** Clean laps as a fraction of timed laps, 0–1. `null` with nothing timed. */
  cleanPct: number | null;
  /** How many laps each dirty reason cost, so the UI can name them. */
  dirtyBy: Partial<Record<DirtyReason, number>>;
  /** Time actually on a lap, ms — the sum of the timed laps. */
  driveMs: number;
  /** Wall-clock span from the first lap starting to the last one finishing. */
  elapsedMs: number;
  /** Litres burned, over the laps that measured a burn. */
  fuelUsedL: number | null;
  /** …and per lap, over those same laps. */
  fuelPerLapL: number | null;
  /** Virtual energy burned, percentage points, over the laps that measured it. */
  veUsedPct: number | null;
  vePerLapPct: number | null;
  /** Mean tyre temperature per corner over the laps that carried one. */
  tempAvg: [number, number, number, number] | null;
  /** Tyre wear as the last lap that reported it left them, `1` = new. */
  wearEnd: [number, number, number, number] | null;
  /** Compounds seen, in the order they first appeared. */
  compounds: string[];
}

/** One stint: a run of laps between pit visits. */
export interface ReviewStint {
  /** 1-based within the session. */
  no: number;
  startedAt: string;
  endedAt: string;
  laps: ReviewLap[];
  stats: ReviewStats;
}

/** A day's high-water mark at this track and class — the 30-day trend line. */
export interface TrendPoint {
  /** UTC date stamp, `YYYY-MM-DD`. */
  day: string;
  bestMs: number;
}

/** One sitting in the car, with everything the reviewer draws from it. */
export interface ReviewSession {
  /**
   * Stable identity: the completion time of the session's first lap plus the
   * track key. Derived rather than stored, and stable because a session's first
   * lap never changes once it is on disk — later laps extend a session, they do
   * not re-date it.
   */
  id: string;
  sim: string;
  track: string;
  trackKey: string;
  trackConfig?: string;
  simTrackName?: string;
  trackLengthM: number;
  car: string;
  carClass: string;
  sessionType: string;
  startedAt: string;
  endedAt: string;
  stints: ReviewStint[];
  stats: ReviewStats;
  /**
   * The driver's best clean lap at this track in this class across the whole
   * log, so the report can say how close this session got to it. `null` when
   * the session itself holds it and there is nothing else to compare to.
   */
  pbMs: number | null;
  /** `true` when this session is where that personal best was set. */
  pbHere: boolean;
  /** Best clean lap per day at this track and class, over the 30 days ending
   *  with this session. Ordered oldest first; days without a lap are absent. */
  trend: TrendPoint[];
}

/** The session list's row — everything but the laps. */
export interface SessionSummary {
  id: string;
  sim: string;
  track: string;
  trackKey: string;
  car: string;
  carClass: string;
  sessionType: string;
  startedAt: string;
  endedAt: string;
  laps: number;
  cleanLaps: number;
  stints: number;
  bestMs: number | null;
  driveMs: number;
  wet: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Maths                                                                     */
/* -------------------------------------------------------------------------- */

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Sample standard deviation. Sample rather than population: a stint is a sample
 * of how the driver was going, not the entire population of laps they could
 * have driven, and with five laps the difference is visible.
 */
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varSum = xs.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(varSum / (xs.length - 1));
}

/** Coefficient of variation → the 0–100 bar. See {@link CV_GOOD}. */
export function consistencyScore(spreadMs: number | null, meanMs: number | null): number | null {
  if (spreadMs === null || meanMs === null || meanMs <= 0) return null;
  const cv = spreadMs / meanMs;
  if (!Number.isFinite(cv)) return null;
  if (cv <= CV_GOOD) return 100;
  if (cv >= CV_BAD) return 0;
  const span = Math.log(CV_BAD) - Math.log(CV_GOOD);
  return Math.round(((Math.log(CV_BAD) - Math.log(cv)) / span) * 1000) / 10;
}

/* -------------------------------------------------------------------------- */
/*  Building                                                                  */
/* -------------------------------------------------------------------------- */

const num = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) ? x : undefined;

function quad(x: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(x) || x.length !== 4) return undefined;
  if (!x.every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined;
  return [x[0], x[1], x[2], x[3]] as [number, number, number, number];
}

/** Instant the lap STARTED — its completion time less its own duration. */
function startedMs(rec: LapRecord): number {
  const end = Date.parse(rec.at);
  if (!Number.isFinite(end)) return NaN;
  const dur = num(rec.lapMs) ?? 0;
  return end - (dur > 0 ? dur : 0);
}

/** Do these two laps belong to the same sitting in the car? */
function sameSession(prev: LapRecord, next: LapRecord): boolean {
  if (prev.sim !== next.sim) return false;
  if (prev.trackKey !== next.trackKey) return false;
  if ((prev.trackConfig || '') !== (next.trackConfig || '')) return false;
  if (prev.car !== next.car) return false;
  if (prev.carClass !== next.carClass) return false;
  if (prev.sessionType !== next.sessionType) return false;
  const idle = startedMs(next) - Date.parse(prev.at);
  // A NaN here means one of the timestamps is unreadable. Treat that as a break
  // rather than welding two runs together on a date we could not parse.
  if (!Number.isFinite(idle)) return false;
  return idle <= SESSION_GAP_MS;
}

/** Does this lap begin a new stint, given the one before it? */
function breaksStint(prev: LapRecord, next: LapRecord): boolean {
  if (prev.isInLap) return true;
  if (next.isOutLap) return true;
  const a = num(prev.stintLap);
  const b = num(next.stintLap);
  // The counter resetting (or going backwards) is the pit visit that was
  // counted. Only trusted when BOTH laps carry it: one lap with the field and
  // one without is a v4/v5 boundary, not a stop.
  if (a !== undefined && b !== undefined && b <= a) return true;
  if (a === undefined && b === undefined) {
    const idle = startedMs(next) - Date.parse(prev.at);
    if (Number.isFinite(idle) && idle > STINT_GAP_MS) return true;
  }
  return false;
}

function toReviewLap(rec: LapRecord, lapNo: number, stintNo: number, stintLap: number,
                     traces: string): ReviewLap {
  const dirty = Array.isArray(rec.dirty) ? rec.dirty : [];
  const lapMs = num(rec.lapMs) ?? 0;
  const veStart = num(rec.veStartPct);
  const veEnd = num(rec.veEndPct);
  // Energy only counts as burned when it went DOWN: a rise is the rig topping
  // the car up in the pits, which is not a lap's consumption.
  const veUsed =
    veStart !== undefined && veEnd !== undefined && veStart > veEnd ? veStart - veEnd : undefined;
  let hasTrace = false;
  if (rec.id && traces) {
    try {
      hasTrace = fs.existsSync(traceFilePath(rec.id, rec.at, traces));
    } catch {
      /* an unreadable traces folder costs the affordance, not the screen */
    }
  }
  return {
    id: rec.id,
    at: rec.at,
    lapNo,
    stintNo,
    stintLap,
    lapMs,
    s1Ms: num(rec.s1Ms),
    s2Ms: num(rec.s2Ms),
    s3Ms: num(rec.s3Ms),
    clean: rec.clean === true,
    dirty,
    timed: lapMs > 0 && !dirty.includes('implausible'),
    isOutLap: rec.isOutLap === true,
    isInLap: rec.isInLap === true,
    fuelStartL: num(rec.fuelStartL),
    fuelEndL: num(rec.fuelEndL),
    fuelUsedL: num(rec.fuelUsedL),
    veUsedPct: veUsed,
    wear: quad(rec.wearAtLine),
    temp: quad(rec.tempAtLine),
    compound: rec.compound || undefined,
    trackTempC: num(rec.trackTempC),
    ambientTempC: num(rec.ambientTempC),
    wet: rec.wet === true,
    hasTrace,
  };
}

/**
 * The derived block, over any set of laps — one stint's, or a whole session's.
 *
 * Every aggregate here skips what it cannot measure rather than substituting a
 * zero. A stint where shared memory never answered has `fuelUsedL: null`, which
 * the UI renders as a dash; the same stint with a zero would claim the driver
 * completed twelve laps on no fuel at all.
 */
export function statsOf(laps: ReviewLap[]): ReviewStats {
  const timed = laps.filter((l) => l.timed);
  const clean = timed.filter((l) => l.clean);
  const times = clean.map((l) => l.lapMs);

  const bestMs = times.length ? Math.min(...times) : null;
  const avg = mean(times);
  const med = median(times);
  const spread = stdev(times);

  let bs1: number | null = null;
  let bs2: number | null = null;
  let bs3: number | null = null;
  for (const lap of clean) {
    if (lap.s1Ms !== undefined && lap.s1Ms > 0 && (bs1 === null || lap.s1Ms < bs1)) bs1 = lap.s1Ms;
    if (lap.s2Ms !== undefined && lap.s2Ms > 0 && (bs2 === null || lap.s2Ms < bs2)) bs2 = lap.s2Ms;
    if (lap.s3Ms !== undefined && lap.s3Ms > 0 && (bs3 === null || lap.s3Ms < bs3)) bs3 = lap.s3Ms;
  }
  const bestSectors: [number | null, number | null, number | null] = [bs1, bs2, bs3];
  const optimalMs = bs1 !== null && bs2 !== null && bs3 !== null ? bs1 + bs2 + bs3 : null;
  // A theoretical lap slower than one actually driven means the sectors and the
  // lap time came from different laps' feeds. Report the real lap as optimal
  // rather than an "untapped potential" of minus two tenths.
  const optimal = optimalMs !== null && bestMs !== null ? Math.min(optimalMs, bestMs) : optimalMs;
  const untappedMs = optimal !== null && bestMs !== null ? bestMs - optimal : null;

  const dirtyBy: Partial<Record<DirtyReason, number>> = {};
  for (const lap of laps) {
    for (const reason of lap.dirty) dirtyBy[reason] = (dirtyBy[reason] || 0) + 1;
  }

  const fuelLaps = laps.filter((l) => l.fuelUsedL !== undefined);
  const fuelUsedL = fuelLaps.length
    ? fuelLaps.reduce((a, l) => a + (l.fuelUsedL as number), 0)
    : null;
  const veLaps = laps.filter((l) => l.veUsedPct !== undefined);
  const veUsedPct = veLaps.length ? veLaps.reduce((a, l) => a + (l.veUsedPct as number), 0) : null;

  const tempLaps = laps.filter((l) => l.temp);
  const cornerMean = (i: 0 | 1 | 2 | 3): number =>
    tempLaps.reduce((a, l) => a + ((l.temp as [number, number, number, number])[i]), 0) /
    tempLaps.length;
  const tempAvg: [number, number, number, number] | null = tempLaps.length
    ? [cornerMean(0), cornerMean(1), cornerMean(2), cornerMean(3)]
    : null;

  let wearEnd: [number, number, number, number] | null = null;
  for (const lap of laps) if (lap.wear) wearEnd = lap.wear;

  const compounds: string[] = [];
  for (const lap of laps) {
    if (lap.compound && !compounds.includes(lap.compound)) compounds.push(lap.compound);
  }

  const first: ReviewLap | undefined = laps[0];
  const last: ReviewLap | undefined = laps[laps.length - 1];
  let elapsedMs = 0;
  if (first && last) {
    // From the first lap STARTING to the last one finishing, so a stint's
    // elapsed time covers the out-lap rather than beginning at the end of it.
    const a = Date.parse(first.at) - (first.lapMs > 0 ? first.lapMs : 0);
    const b = Date.parse(last.at);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) elapsedMs = b - a;
  }

  return {
    laps: laps.length,
    cleanLaps: clean.length,
    timedLaps: timed.length,
    bestMs,
    averageMs: avg,
    medianMs: med,
    bestSectors,
    optimalMs: optimal,
    untappedMs,
    spreadMs: spread,
    consistency: consistencyScore(spread, avg),
    cleanPct: timed.length ? clean.length / timed.length : null,
    dirtyBy,
    driveMs: timed.reduce((a, l) => a + l.lapMs, 0),
    elapsedMs,
    fuelUsedL,
    fuelPerLapL: fuelUsedL !== null ? fuelUsedL / fuelLaps.length : null,
    veUsedPct,
    vePerLapPct: veUsedPct !== null ? veUsedPct / veLaps.length : null,
    tempAvg,
    wearEnd,
    compounds,
  };
}

/** The id a session gets. See {@link ReviewSession.id}. */
export function sessionIdOf(first: LapRecord): string {
  return `${first.at}~${first.trackKey}`;
}

/**
 * Group a flat run of laps into sessions and stints.
 *
 * Pure: give it laps in any order and it sorts them itself, so a caller can
 * hand over several days' files concatenated without worrying about which came
 * back first. `traces` is the directory to look for driving traces in, passed
 * rather than looked up so the tests can point it somewhere empty.
 */
export function groupSessions(records: LapRecord[], traces = ''): ReviewSession[] {
  const laps = records
    .filter((r) => r && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const runs: LapRecord[][] = [];
  for (const rec of laps) {
    const run = runs[runs.length - 1];
    const tail = run ? run[run.length - 1] : undefined;
    if (run && tail && sameSession(tail, rec)) run.push(rec);
    else runs.push([rec]);
  }

  return runs.map((run) => {
    // A run is never empty — it is created with its first lap in it — but the
    // index signature does not know that, and asserting beats re-deriving.
    const first = run[0] as LapRecord;
    const final = run[run.length - 1] as LapRecord;
    const stints: ReviewStint[] = [];
    let stintNo = 0;
    let stintLap = 0;
    const all: ReviewLap[] = [];

    run.forEach((rec, i) => {
      const prev = i > 0 ? run[i - 1] : undefined;
      if (!prev || breaksStint(prev, rec)) {
        stintNo += 1;
        stintLap = 0;
        stints.push({ no: stintNo, startedAt: rec.at, endedAt: rec.at, laps: [], stats: statsOf([]) });
      }
      stintLap += 1;
      const lap = toReviewLap(rec, i + 1, stintNo, stintLap, traces);
      all.push(lap);
      const stint = stints[stints.length - 1] as ReviewStint;
      stint.laps.push(lap);
      stint.endedAt = rec.at;
    });

    for (const stint of stints) stint.stats = statsOf(stint.laps);

    return {
      id: sessionIdOf(first),
      sim: first.sim || '',
      track: first.track || '',
      trackKey: first.trackKey || '',
      trackConfig: first.trackConfig || undefined,
      simTrackName: first.simTrackName || undefined,
      trackLengthM: num(first.trackLengthM) ?? 0,
      car: first.car || '',
      carClass: first.carClass || '',
      sessionType: first.sessionType || '',
      startedAt: first.at,
      endedAt: final.at,
      stints,
      stats: statsOf(all),
      pbMs: null,
      pbHere: false,
      trend: [],
    };
  });
}

/** Strip a session down to its list row. */
export function summaryOf(s: ReviewSession): SessionSummary {
  return {
    id: s.id,
    sim: s.sim,
    track: s.track,
    trackKey: s.trackKey,
    car: s.car,
    carClass: s.carClass,
    sessionType: s.sessionType,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    laps: s.stats.laps,
    cleanLaps: s.stats.cleanLaps,
    stints: s.stints.length,
    bestMs: s.stats.bestMs,
    driveMs: s.stats.driveMs,
    wet: s.stints.some((st) => st.laps.some((l) => l.wet)),
  };
}

/* -------------------------------------------------------------------------- */
/*  Reading the log                                                           */
/* -------------------------------------------------------------------------- */

/** Days ending the trend line that precedes a session. */
const TREND_DAYS = 30;

/**
 * Every lap on disk, oldest first.
 *
 * The whole log, with no window: "keep everything" is the retention decision
 * (`docs/STINT-REVIEW-PLAN.md`, decision 1), and a reviewer that silently
 * stopped showing last spring would be the same bug the trace pruner was. The
 * cost is small and stays small — a lap is ~500 bytes of JSON, so a driver
 * three years into hard practice has a few megabytes here, read in one pass
 * well inside the IPC round trip that asked for it.
 */
export function readAllLaps(dir = lapDir()): LapRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const days = names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .map((n) => n.slice(0, 10))
    .sort();
  const out: LapRecord[] = [];
  for (const day of days) out.push(...readDay(day, dir));
  return out;
}

/** The traces folder, beside the laps. Kept in step with `lapTrace.traceDir()`. */
function tracesBeside(dir: string): string {
  return path.join(path.dirname(dir), 'traces');
}

/**
 * The sessions list, newest first.
 *
 * Summaries only: the list is a list, and shipping every lap of every session
 * through IPC to render a row of headline numbers would make opening the tab
 * cost more than opening a session does.
 */
export function listSessions(dir = lapDir(), limit = 400): SessionSummary[] {
  const sessions = groupSessions(readAllLaps(dir), tracesBeside(dir));
  return sessions
    .reverse()
    .slice(0, Math.max(1, limit))
    .map(summaryOf);
}

/**
 * One session in full, with its personal-best context and trend line.
 *
 * Both of those need laps from outside the session, so this re-reads the log
 * rather than working from the grouped session alone: a best lap you cannot
 * compare to your own record is half an answer.
 */
export function loadSession(id: string, dir = lapDir()): ReviewSession | null {
  const records = readAllLaps(dir);
  const sessions = groupSessions(records, tracesBeside(dir));
  const session = sessions.find((s) => s.id === id);
  if (!session) return null;

  const startMs = Date.parse(session.startedAt);
  const endMs = Date.parse(session.endedAt);

  // The personal best at this track and class, from every lap ever logged —
  // including sessions after this one, because "my record" is a fact about the
  // driver, not about the moment they were sitting in the car.
  let pbMs: number | null = null;
  let pbHere = false;
  const byDay = new Map<string, number>();
  for (const rec of records) {
    if (rec.trackKey !== session.trackKey) continue;
    if ((rec.carClass || '') !== session.carClass) continue;
    if (rec.clean !== true) continue;
    const ms = num(rec.lapMs);
    if (ms === undefined || ms <= 0) continue;
    if (pbMs === null || ms < pbMs) {
      pbMs = ms;
      const at = Date.parse(rec.at);
      pbHere = Number.isFinite(at) && at >= startMs && at <= endMs;
    }
    // The trend: the 30 days ending with this session, so the line reads as
    // "how I have been going into today" rather than including later evidence.
    const at = Date.parse(rec.at);
    if (!Number.isFinite(at) || at > endMs || at < endMs - TREND_DAYS * 86_400_000) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    const prev = byDay.get(day);
    if (prev === undefined || ms < prev) byDay.set(day, ms);
  }

  session.pbMs = pbMs;
  session.pbHere = pbHere;
  session.trend = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, bestMs]) => ({ day, bestMs }));
  return session;
}

/* -------------------------------------------------------------------------- */
/*  The driver, over everything                                               */
/* -------------------------------------------------------------------------- */

/** One line of a career tally, so the same shape can name a track or a car. */
export interface CareerTally {
  name: string;
  laps: number;
  /** Metres driven under this name. */
  distanceM: number;
  bestMs: number | null;
}

/**
 * Everything a driver has ever done with Apex running, in one row of numbers.
 *
 * Derived, like everything else here, from the lap log alone — so it needs no
 * counter to keep up to date, cannot drift out of step with the sessions below
 * it, and is retrospectively correct the moment a rule changes.
 */
export interface CareerStats {
  /** Every lap on disk, including out-laps, in-laps and laps with no time. */
  laps: number;
  cleanLaps: number;
  timedLaps: number;
  /** Metres, summed per lap from the circuit's length. */
  distanceM: number;
  /** Time actually on a lap, ms — the sum of the timed laps. */
  driveMs: number;
  sessions: number;
  /** Distinct circuits, by the lap log's own track key. */
  tracks: number;
  cars: number;
  classes: number;
  /** Days with at least one lap on them. */
  days: number;
  firstAt: string | null;
  lastAt: string | null;
  /** The circuits and cars with the most laps, most first. */
  topTracks: CareerTally[];
  topCars: CareerTally[];
}

const EMPTY_CAREER: CareerStats = {
  laps: 0,
  cleanLaps: 0,
  timedLaps: 0,
  distanceM: 0,
  driveMs: 0,
  sessions: 0,
  tracks: 0,
  cars: 0,
  classes: 0,
  days: 0,
  firstAt: null,
  lastAt: null,
  topTracks: [],
  topCars: [],
};

/** Fold a lap into a name's tally, creating the tally on first sight. */
function tallyInto(
  into: Map<string, CareerTally>,
  name: string,
  distanceM: number,
  lapMs: number | undefined,
  clean: boolean,
): void {
  if (!name) return;
  const row = into.get(name) || { name, laps: 0, distanceM: 0, bestMs: null };
  row.laps += 1;
  row.distanceM += distanceM;
  if (clean && lapMs !== undefined && lapMs > 0 && (row.bestMs === null || lapMs < row.bestMs)) {
    row.bestMs = lapMs;
  }
  into.set(name, row);
}

/**
 * The driver's whole history as a handful of totals.
 *
 * Distance is summed **per lap from the circuit's length**, which is what a lap
 * log can honestly answer: it counts an out-lap and an in-lap as a full lap
 * each, because the car did go round, and it has no way to know a lap was
 * abandoned halfway. Over thousands of laps the error is a fraction of a
 * percent and always in the same direction, which is the right trade for a
 * figure read as "how far have I driven" rather than used in a calculation.
 *
 * `sessions` is the same inference the list uses, so the number here and the
 * number of cards below it can never disagree.
 */
export function careerStats(records: LapRecord[], traces = ''): CareerStats {
  if (!records.length) return { ...EMPTY_CAREER };

  const tracks = new Map<string, CareerTally>();
  const cars = new Map<string, CareerTally>();
  const classes = new Set<string>();
  const days = new Set<string>();
  let distanceM = 0;
  let driveMs = 0;
  let cleanLaps = 0;
  let timedLaps = 0;

  for (const rec of records) {
    const metres = num(rec.distanceM) ?? num(rec.trackLengthM) ?? 0;
    const lapMs = num(rec.lapMs);
    const clean = rec.clean === true;
    distanceM += metres;
    if (lapMs !== undefined && lapMs > 0) {
      timedLaps += 1;
      driveMs += lapMs;
    }
    if (clean) cleanLaps += 1;
    if (rec.carClass) classes.add(rec.carClass);
    const day = String(rec.at || '').slice(0, 10);
    if (day) days.add(day);
    tallyInto(tracks, rec.track || rec.trackKey || '', metres, lapMs, clean);
    tallyInto(cars, rec.car || '', metres, lapMs, clean);
  }

  const byLaps = (a: CareerTally, b: CareerTally): number => b.laps - a.laps;
  const first = records[0] as LapRecord;
  const last = records[records.length - 1] as LapRecord;

  return {
    laps: records.length,
    cleanLaps,
    timedLaps,
    distanceM,
    driveMs,
    sessions: groupSessions(records, traces).length,
    tracks: tracks.size,
    cars: cars.size,
    classes: classes.size,
    days: days.size,
    firstAt: first.at || null,
    lastAt: last.at || null,
    topTracks: [...tracks.values()].sort(byLaps).slice(0, 5),
    topCars: [...cars.values()].sort(byLaps).slice(0, 5),
  };
}

/** The sessions list and the career totals from one read of the log. */
export function listSessionsWithCareer(
  dir = lapDir(),
  limit = 400,
): { sessions: SessionSummary[]; career: CareerStats } {
  const records = readAllLaps(dir);
  const traces = tracesBeside(dir);
  const sessions = groupSessions(records, traces)
    .reverse()
    .slice(0, Math.max(1, limit))
    .map(summaryOf);
  return { sessions, career: careerStats(records, traces) };
}

/** Where the driver's quickest studiable lap on a circuit lives. */
export interface BestTracedLap {
  sessionId: string;
  id: string;
  at: string;
  lapNo: number;
  lapMs: number;
}

/**
 * The driver's quickest clean, traced lap on a circuit in a class — the lap the
 * Leaderboard tab opens when a board row is compared against.
 *
 * `trackKeys` is plural because the league may know one circuit under several
 * of the log's keys (an admin merged two sightings); laps under any of them
 * are laps here. Clean and timed only, and the lap has to have a trace on this
 * machine: the comparison is drawn from two traces, and a personal best with
 * no trace is a number, not a lap that can be studied. The same three tests
 * the sheet applies, through the same grouping, so the lap this answers with
 * is one the sheet marks as openable.
 */
export function bestTracedLap(
  trackKeys: readonly string[],
  carClass: string,
  dir = lapDir(),
): BestTracedLap | null {
  const keys = new Set(trackKeys.map((k) => String(k || '').toLowerCase()).filter(Boolean));
  const cls = String(carClass || '').trim().toUpperCase();
  if (!keys.size || !cls) return null;
  const records = readAllLaps(dir).filter(
    (r) => keys.has(String(r.trackKey || '').toLowerCase())
      && String(r.carClass || '').trim().toUpperCase() === cls,
  );
  if (!records.length) return null;
  let best: BestTracedLap | null = null;
  for (const session of groupSessions(records, tracesBeside(dir))) {
    for (const stint of session.stints) {
      for (const lap of stint.laps) {
        if (!lap.id || !lap.hasTrace || !lap.clean || !lap.timed || !(lap.lapMs > 0)) continue;
        if (best && lap.lapMs >= best.lapMs) continue;
        best = { sessionId: session.id, id: lap.id, at: lap.at, lapNo: lap.lapNo, lapMs: lap.lapMs };
      }
    }
  }
  return best;
}
