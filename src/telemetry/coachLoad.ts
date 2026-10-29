/**
 * coachLoad.ts — the disk half of the driving coach.
 * =============================================================================
 *
 * For the electron side (`electron/coach-ipc.js`), as `practiceReviewLoad.ts`
 * and `practiceLap.ts` are for the Practice tab:
 *
 *   loadSessionCoach({ sessionId, targetLapId? }, deps) → { report, review } | null
 *     The session's debrief (`loadPracticeReview`), every valid traced lap
 *     split per corner and phase against the session's target
 *     (`timeLoss.lapLoss`), the sequences across them, the target's fairness,
 *     and the words (`coachReport.buildSessionCoach`).
 *
 *   loadLapCoach({ sessionId, lapId, at, targetLapId? }, deps)
 *     → { report, breakdown, show } | null
 *     One practice lap against the same target, with the "Show me" steps.
 *
 *   loadReviewCoach(args, deps) → { report, breakdown, show } | null
 *     The Review tab's comparison: `args` is the very object the tab sends
 *     `review:lap` — `{ id, at, haveMapKey?, vs }` — with `vs` one of the
 *     driver's own laps `{ id, at }` or a board lap. A board lap's trace is
 *     fetched by the IPC (it needs the network and the session) and handed in
 *     as `deps.boardPayload`, exactly as `review:lap` hands it to
 *     `lapDetail.detailFromCloudTrace`.
 *
 *   deps: PracticeReviewDeps (reviewDir, lapDir?, traceDir?) plus
 *     cornerDir?      the corner catalogue folder (cornerCatalog default otherwise)
 *     targetColumns?  (lapId) → columns of a leaderboard target the session is
 *                     measured against, once the fair builder resolves one
 *
 * ## The target
 * The reference is resolved the way the debrief resolved it, so "C5" is the
 * same corner on every screen: the review's own `target.lapId` — a lap of this
 * session (its trace), the snapshotted chased lap (the snapshot's columns), or
 * a leaderboard lap (`targetLapId`, through `deps.targetColumns`). When none of
 * those yields columns the laps are not split, and the words fall back to the
 * debrief's corner rows: thinner, never blank.
 *
 * `targetLapId` itself belongs to the fair builder's `loadPracticeReview`
 * (an optional third argument). It is passed through untouched; a loader that
 * does not know it ignores it.
 */

import { cornersForLap } from './cornerCatalog';
import type { CoachReport, CornerCatalog, LapLossBreakdown, ShowStep } from './coachContract';
import { buildLapCoach, buildSessionCoach, type CoachFallbackRow } from './coachReport';
import { sessionSequences } from './cornerSequences';
import { cornerResult, findCorners, type CornerTrace } from './corners';
import { assessTarget, type TargetLapInfo } from './fairTarget';
import { detailFromCloudTrace, findLap, mapKeyForLap, sectorMarks, type CloudTracePayload } from './lapDetail';
import { lapDir as defaultLapDir } from './lapLog';
import { readTrace, traceDir as defaultTraceDir, type CompletedTrace, type TraceFile } from './lapTrace';
import type { PracticeReview } from './practiceReview';
import { findSnapshot, loadPracticeReview, type PracticeReviewDeps } from './practiceReviewLoad';
import { showSteps } from './showSteps';
import { loadSession, type ReviewLap, type ReviewSession } from './stintReview';
import { lapLoss, type LossCorner, type LossLapInput } from './timeLoss';

export interface CoachLoadDeps extends PracticeReviewDeps {
  cornerDir?: string;
  targetColumns?: (lapId: string) => Record<string, unknown> | null;
}

export interface CoachSessionArgs {
  sessionId: string;
  targetLapId?: string | null;
}

export interface CoachLapArgs extends CoachSessionArgs {
  lapId: string;
  at?: string;
}

export interface CoachLapResult {
  report: CoachReport;
  breakdown: LapLossBreakdown | null;
  show: ShowStep[];
}

/* -------------------------------------------------------------------------- */
/*  Columns                                                                   */
/* -------------------------------------------------------------------------- */

const COLS = ['speedKph', 'brake', 'throttle', 'steer', 'latG', 'x', 'z'] as const;

/**
 * A trace's columns as `lapLoss` takes them: strictly advancing `d`, never
 * backward `t`, every other column filtered by the same pass (practiceReview
 * `cleanCols`'s rule, keeping steer and latG, which the engine reads).
 */
export function lossInput(lapId: string, lapSec: number | null, src: Record<string, unknown> | null | undefined): LossLapInput | null {
  if (!src) return null;
  const d = src.d;
  const t = src.t;
  if (!Array.isArray(d) || !Array.isArray(t)) return null;
  const n = Math.min(d.length, t.length);
  const keep: number[] = [];
  let pd = -Infinity;
  let pt = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const di = Number(d[i]);
    const ti = Number(t[i]);
    if (!Number.isFinite(di) || !Number.isFinite(ti) || di < 0 || di > 1 || ti < 0) continue;
    if (di <= pd || ti < pt) continue;
    keep.push(i);
    pd = di;
    pt = ti;
  }
  if (keep.length < 2) return null;
  const pick = (col: unknown): number[] | undefined =>
    Array.isArray(col) && col.length >= n ? keep.map((i) => Number(col[i])) : undefined;
  const speedKph = pick(src.speedKph);
  if (!speedKph) return null;
  const cols: LossLapInput['cols'] = { d: keep.map((i) => Number(d[i])), t: keep.map((i) => Number(t[i])), speedKph };
  const out = cols as { [k: string]: readonly number[] | undefined };
  for (const k of COLS) {
    if (k === 'speedKph') continue;
    const v = pick(src[k]);
    if (v) out[k] = v;
  }
  if (!cols.x || !cols.z) {
    delete out.x;
    delete out.z;
  }
  return { lapId, lapSec: lapSec !== null && lapSec > 0 ? lapSec : null, cols };
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

const lapsOf = (s: ReviewSession): ReviewLap[] => s.stints.flatMap((st) => st.laps).sort((a, b) => a.lapNo - b.lapNo);
const isValid = (l: ReviewLap): boolean => l.clean === true && l.timed === true && l.lapMs > 0;

function readTraces(laps: readonly ReviewLap[], tdir: string): Map<string, TraceFile> {
  const out = new Map<string, TraceFile>();
  for (const lap of laps) {
    if (!lap.id || !lap.hasTrace) continue;
    const f = readTrace(lap.id, lap.at, tdir);
    if (f && f.trace) out.set(lap.id, f);
  }
  return out;
}

/** The review, with `targetLapId` handed to a loader that takes it (fair), ignored otherwise. */
function reviewFor(sessionId: string, deps: CoachLoadDeps, targetLapId?: string | null): PracticeReview | null {
  const load = loadPracticeReview as unknown as (id: string, d: PracticeReviewDeps, o?: { targetLapId?: string }) => PracticeReview | null;
  return targetLapId ? load(sessionId, deps, { targetLapId }) : load(sessionId, deps);
}

function mapKeyOf(session: ReviewSession, lapDir: string): string | null {
  for (const lap of lapsOf(session)) {
    if (!lap.id) continue;
    const rec = findLap(lap.id, lap.at, lapDir);
    if (rec) return mapKeyForLap(rec);
  }
  return null;
}

/** The target's columns as a loss input, resolved as the header says. */
function targetInput(
  review: PracticeReview,
  session: ReviewSession,
  traces: Map<string, TraceFile>,
  deps: CoachLoadDeps,
): LossLapInput | null {
  const t = review.target;
  if (!t) return null;
  const own = traces.get(t.lapId);
  if (own) return lossInput(t.lapId, t.lapSec, own.trace as unknown as Record<string, unknown>);
  const snap = findSnapshot(review.id, session, deps.reviewDir);
  if (snap && snap.target && snap.target.lapId === t.lapId) {
    return lossInput(t.lapId, t.lapSec, snap.target.columns as unknown as Record<string, unknown>);
  }
  if (deps.targetColumns) {
    try {
      return lossInput(t.lapId, t.lapSec, deps.targetColumns(t.lapId));
    } catch {
      return null;
    }
  }
  return null;
}

/** The corners every lap of a session is measured by (catalogue first). */
function cornersOf(
  ref: LossLapInput,
  mapKey: string | null,
  L: number,
  deps: CoachLoadDeps,
): { corners: LossCorner[]; catalog: CornerCatalog | null } {
  try {
    const got = cornersForLap({ mapKey, trackLengthM: L, ref: ref.cols as unknown as CornerTrace, dir: deps.cornerDir });
    return { corners: got.corners, catalog: got.catalog };
  } catch {
    return {
      corners: findCorners(ref.cols as unknown as CornerTrace, L).map((c, i) => ({ id: `C${i + 1}`, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD })),
      catalog: null,
    };
  }
}

function safeLoss(mine: LossLapInput, ref: LossLapInput, corners: LossCorner[], L: number): LapLossBreakdown | null {
  try {
    return lapLoss(mine, ref, corners, L);
  } catch (err) {
    console.error('[coach] lapLoss failed for', mine.lapId, (err as Error).message);
    return null;
  }
}

function lapInfo(lap: ReviewLap, s: ReviewSession, hasLine?: boolean): TargetLapInfo {
  return {
    lapId: lap.id || '',
    car: s.car,
    carClass: s.carClass,
    lapSec: lap.lapMs / 1000,
    sessionType: s.sessionType,
    trackTempC: lap.trackTempC ?? null,
    airTempC: lap.ambientTempC ?? null,
    fuelStartL: lap.fuelStartL ?? null,
    compound: lap.compound ?? null,
    condition: lap.wet === true ? 'wet' : lap.wet === false ? 'dry' : null,
    hasLine,
  };
}

/** Fairness of the target against the driver's best lap; nothing when the target IS their lap. */
function fairnessOf(review: PracticeReview, session: ReviewSession, laps: readonly ReviewLap[]) {
  const t = review.target;
  if (!t || t.kind === 'sessionBest') return [];
  let best: ReviewLap | null = null;
  for (const l of laps) if (isValid(l) && (!best || l.lapMs < best.lapMs)) best = l;
  if (!best || best.id === t.lapId) return [];
  const own = laps.find((l) => l.id === t.lapId);
  const cand: TargetLapInfo = own
    ? lapInfo(own, session)
    : { lapId: t.lapId, driver: t.label, car: session.car, carClass: session.carClass, lapSec: t.lapSec };
  try {
    return assessTarget(lapInfo(best, session), cand).flags || [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  A session                                                                 */
/* -------------------------------------------------------------------------- */

interface SessionWork {
  session: ReviewSession;
  review: PracticeReview;
  laps: ReviewLap[];
  traces: Map<string, TraceFile>;
  ref: LossLapInput | null;
  corners: LossCorner[];
  catalog: CornerCatalog | null;
  L: number;
  sectorD: { s1: number | null; s2: number | null } | null;
}

function prepare(args: CoachSessionArgs, deps: CoachLoadDeps): SessionWork | null {
  const lapDir = deps.lapDir || defaultLapDir();
  const tdir = deps.traceDir || defaultTraceDir();
  const session = loadSession(args.sessionId, lapDir);
  if (!session) return null;
  const review = reviewFor(args.sessionId, deps, args.targetLapId);
  if (!review) return null;
  const laps = lapsOf(session);
  const traces = readTraces(laps, tdir);
  const L = review.trackLengthM > 0 ? review.trackLengthM : session.trackLengthM;
  const ref = targetInput(review, session, traces, deps);
  const found = ref && L > 0 ? cornersOf(ref, mapKeyOf(session, lapDir), L, deps) : { corners: [], catalog: null };
  const catalog = found.catalog;
  // Measure by the debrief's own corners when it has them. A chased target
  // keeps the corners the live card numbered (practiceReview.ts), which can
  // predate the catalogue; cutting again here would let the coach call a
  // corner C12 that the grid beside it calls C13.
  const own = review.corners.filter((c) => [c.entryD, c.apexD, c.exitD].every((v) => Number.isFinite(v)));
  const corners: LossCorner[] = own.length
    ? own.map((c) => ({ id: c.id || `C${c.index + 1}`, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }))
    : found.corners;

  // Sector lines off the best valid traced lap that has splits.
  let sectorD: SessionWork['sectorD'] = null;
  let best: ReviewLap | null = null;
  for (const l of laps) {
    if (isValid(l) && l.id && traces.has(l.id) && l.s1Ms && l.s2Ms && (!best || l.lapMs < best.lapMs)) best = l;
  }
  if (best && best.id) {
    const m = sectorMarks(traces.get(best.id)!.trace, best.lapMs, best.s1Ms, best.s2Ms);
    if (m.s1 !== null && m.s2 !== null) sectorD = m;
  }
  return { session, review, laps, traces, ref, corners, catalog, L, sectorD };
}

/** The session's coaching. `null` only when there is no such session. */
export function loadSessionCoach(args: CoachSessionArgs, deps: CoachLoadDeps): { report: CoachReport; review: PracticeReview } | null {
  const w = prepare(args, deps);
  if (!w) return null;
  const { review, laps, traces, ref, corners, L } = w;

  // review.laps is lap order (lapNo), the same order as `laps`.
  const byNo = new Map(laps.map((l) => [l.lapNo, l]));
  const aligned = review.laps.map((pl) => byNo.get(pl.lapNo) || null);

  const breakdowns: LapLossBreakdown[] = [];
  if (ref && corners.length && L > 0) {
    for (const lap of aligned) {
      if (!lap || !lap.id || !isValid(lap) || lap.id === ref.lapId) continue;
      const f = traces.get(lap.id);
      const mine = f ? lossInput(lap.id, lap.lapMs / 1000, f.trace as unknown as Record<string, unknown>) : null;
      const b = mine ? safeLoss(mine, ref, corners, L) : null;
      if (b) breakdowns.push(b);
    }
  }
  let sequences: ReturnType<typeof sessionSequences> = [];
  try {
    sequences = sessionSequences(breakdowns, w.catalog);
  } catch {
    sequences = [];
  }
  const report = buildSessionCoach(review, breakdowns, {
    sessionId: args.sessionId,
    sequences,
    fairness: fairnessOf(review, w.session, laps),
    targetLapId: args.targetLapId ?? null,
    lapIds: aligned.map((l) => (l && l.id) || null),
    sectorTimes: aligned.map((l) =>
      l && (l.s1Ms || l.s2Ms || l.s3Ms)
        ? ([l.s1Ms ? l.s1Ms / 1000 : null, l.s2Ms ? l.s2Ms / 1000 : null, l.s3Ms ? l.s3Ms / 1000 : null] as const)
        : null,
    ),
    sectorD: w.sectorD,
    generatedAt: review.endedAt,
  });
  return { report, review };
}

/* -------------------------------------------------------------------------- */
/*  One practice lap                                                          */
/* -------------------------------------------------------------------------- */

function safeShow(b: LapLossBreakdown | null, mine: LossLapInput | null, ref: LossLapInput | null): ShowStep[] {
  if (!b || !mine || !ref) return [];
  try {
    return showSteps(b, mine, ref, 3);
  } catch {
    return [];
  }
}

/** One practice lap's coaching. `null` when the session or the lap is not found. */
export function loadLapCoach(args: CoachLapArgs, deps: CoachLoadDeps): CoachLapResult | null {
  const w = prepare(args, deps);
  if (!w) return null;
  const lap = w.laps.find((l) => l.id === args.lapId && (!args.at || l.at === args.at));
  if (!lap) return null;
  const { review, traces, ref, corners, L } = w;
  const f = lap.id ? traces.get(lap.id) : undefined;
  const mine = f ? lossInput(lap.id!, lap.lapMs / 1000, f.trace as unknown as Record<string, unknown>) : null;
  const breakdown = mine && ref && corners.length && L > 0 ? safeLoss(mine, ref, corners, L) : null;

  // The debrief's rows for this lap: the words' fallback.
  const pl = review.laps.find((x) => x.lapNo === lap.lapNo);
  const rows: CoachFallbackRow[] = pl
    ? pl.corners.map((c) => {
        const summary = review.corners[c.index];
        return {
          id: summary && typeof (summary as { id?: unknown }).id === 'string' ? String((summary as { id?: unknown }).id) : `C${c.index + 1}`,
          entryD: summary ? summary.entryD : undefined,
          exitD: summary ? summary.exitD : undefined,
          deltaSec: c.deltaSec,
          brakeDeltaM: c.brakeDeltaM,
          apexKphDelta: c.apexKphDelta,
        };
      })
    : [];
  let sequences: LapLossBreakdown['sequences'] = [];
  if (breakdown) sequences = breakdown.sequences || [];
  const report = buildLapCoach({
    sessionId: args.sessionId,
    lapId: args.lapId,
    breakdown,
    rows,
    lapSec: lap.lapMs > 0 ? lap.lapMs / 1000 : null,
    refSec: review.target ? review.target.lapSec : null,
    refLabel: review.target ? review.target.label : null,
    theoreticalBestSec: review.theoreticalBestSec,
    sequences,
    fairness: fairnessOf(review, w.session, w.laps),
    trackLengthM: L,
    sectorD: w.sectorD,
    generatedAt: lap.at,
  });
  return { report, breakdown, show: safeShow(breakdown, mine, ref) };
}

/* -------------------------------------------------------------------------- */
/*  The Review tab's comparison                                               */
/* -------------------------------------------------------------------------- */

/** What the Review tab sends `review:lap`. */
export interface ReviewCoachArgs {
  id: string;
  at: string;
  haveMapKey?: string;
  vs?: { id?: string; at?: string; board?: { driverId?: string; trackId?: string; carClass?: string } } | null;
}

export interface ReviewCoachDeps {
  lapDir?: string;
  traceDir?: string;
  cornerDir?: string;
  /** A board lap's `get_lap_trace` answer, fetched by the IPC. */
  boardPayload?: CloudTracePayload | null;
}

/**
 * A lap against the comparison lap the Review tab laid under it. `null` when
 * the studied lap or the comparison has no trace — the tab shows the plain
 * comparison then, and no coach.
 */
export function loadReviewCoach(args: ReviewCoachArgs, deps: ReviewCoachDeps = {}): CoachLapResult | null {
  const lapDir = deps.lapDir || defaultLapDir();
  const tdir = deps.traceDir || defaultTraceDir();
  if (!args || !args.id || !args.at) return null;
  const rec = findLap(args.id, args.at, lapDir);
  if (!rec) return null;
  const file = readTrace(args.id, args.at, tdir);
  if (!file || !file.trace) return null;
  const L = Number(rec.trackLengthM) || Number(file.trackLengthM) || 0;
  if (!(L > 0)) return null;
  const lapSec = Number(rec.lapMs) > 0 ? Number(rec.lapMs) / 1000 : null;
  const mine = lossInput(args.id, lapSec, file.trace as unknown as Record<string, unknown>);
  if (!mine) return null;

  let refCols: CompletedTrace | null = null;
  let refId = '';
  let refSec: number | null = null;
  let refLabel: string | null = null;
  const vs = args.vs || null;
  if (vs && vs.board) {
    const mapKey = mapKeyForLap(rec);
    const other = detailFromCloudTrace(deps.boardPayload || null, { track: rec.track || '', mapKey });
    if (!other) return null;
    refCols = other.channels;
    refId = other.lapId;
    refSec = other.lapMs > 0 ? other.lapMs / 1000 : null;
    refLabel = 'Leaderboard lap';
  } else if (vs && vs.id && vs.at) {
    const vrec = findLap(vs.id, vs.at, lapDir);
    const vf = readTrace(vs.id, vs.at, tdir);
    if (!vrec || !vf || !vf.trace) return null;
    refCols = vf.trace;
    refId = vs.id;
    refSec = Number(vrec.lapMs) > 0 ? Number(vrec.lapMs) / 1000 : null;
    refLabel = 'Your lap';
  } else {
    return null;
  }
  const ref = lossInput(refId, refSec, refCols as unknown as Record<string, unknown>);
  if (!ref) return null;

  const { corners } = cornersOf(ref, mapKeyForLap(rec), L, { reviewDir: '', cornerDir: deps.cornerDir });
  const breakdown = corners.length ? safeLoss(mine, ref, corners, L) : null;
  // Without the engine's split: the debrief's own scorer, corner by corner.
  const rows: CoachFallbackRow[] = corners.map((c) => {
    const r = cornerResult(c, ref.cols, mine.cols, L);
    return { id: c.id, entryD: c.entryD, exitD: c.exitD, deltaSec: r.deltaSec, brakeDeltaM: r.brakeDeltaM, apexKphDelta: r.apexKphDelta };
  });
  const sectors = sectorMarks(file.trace, Number(rec.lapMs) || 0, rec.s1Ms, rec.s2Ms);
  const report = buildLapCoach({
    sessionId: '',
    lapId: args.id,
    breakdown,
    rows,
    lapSec,
    refSec,
    refLabel,
    sequences: breakdown ? breakdown.sequences || [] : [],
    fairness: [],
    trackLengthM: L,
    sectorD: sectors.s1 !== null && sectors.s2 !== null ? sectors : null,
    generatedAt: args.at,
  });
  return { report, breakdown, show: safeShow(breakdown, mine, ref) };
}
