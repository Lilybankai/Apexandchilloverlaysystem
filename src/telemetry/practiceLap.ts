/**
 * practiceLap.ts — one practice lap, studied against the session's target.
 * =============================================================================
 *
 * Phase 2 of docs/PRACTICE-REVIEW-PLAN.md: the lap the driver clicked in the
 * debrief, laid over what the session was measured against — the chased lap
 * the detector snapshotted, else the session's best lap — with a row per
 * corner. For the electron side (`practice:lap` IPC):
 *
 *   loadPracticeLap(args: PracticeLapArgs, deps: PracticeReviewDeps): PracticeLapResult | null
 *
 *     args.sessionId   the stintReview session id (the debrief's `id`)
 *     args.lapId/at    the lap (a debrief `PracticeLap`'s session lap)
 *     args.haveMapKey  the circuit the panel already holds; not resent
 *     deps             as `loadPracticeReview` (reviewDir required)
 *
 *   `null` when the session or the lap is not found; a lap with no trace
 *   comes back as `loadLapAlone` answers it (`detail: null`, `reason`).
 *
 * The comparison arithmetic is `lapDetail.compareWith` — the same delta and
 * micro-sectors the Review tab draws — and the corners are the debrief's own
 * (`practiceReference`), so "C5" here is "C5" in the debrief and on track.
 */

import { cornerResult, type LapColumns } from './corners';
import { colAt, lineOffset, minSpeed, scoreLap, type AccuracyScore } from './accuracyScore';
import { lapDir as defaultLapDir } from './lapLog';
import {
  compareWith,
  hasDrivenLine,
  loadLapAlone,
  loadLapDetail,
  sectorMarks,
  vMaxOf,
  type LapCompareResult,
  type LapDetail,
} from './lapDetail';
import { readTrace, traceDir as defaultTraceDir, type CompletedTrace, type TraceFile } from './lapTrace';
import {
  bestValidLap,
  cleanCols,
  practiceReference,
  type PracticeColumns,
  type PracticeTargetInfo,
} from './practiceReview';
import { findSnapshot, type PracticeReviewDeps } from './practiceReviewLoad';
import { loadSession } from './stintReview';

export interface PracticeLapArgs {
  sessionId: string;
  lapId: string;
  at: string;
  haveMapKey?: string;
}

/** One corner of the studied lap against the target. Signs as everywhere: positive seconds = slower. */
export interface PracticeCornerRow {
  index: number;
  entryD: number;
  apexD: number;
  exitD: number;
  /** Time through the corner, you − target. Positive = slower. */
  deltaSec: number | null;
  /** Positive = braked LATER than the target. */
  brakeDeltaM: number | null;
  /** Minimum-speed difference. Positive = faster. */
  apexKphDelta: number | null;
  /** Speed at the corner's exit, you − target. */
  exitKphDelta: number | null;
  minKph: number | null;
  refMinKph: number | null;
  /** Mean lateral distance from the target's line, entry → exit; null unless both laps carry x/z. */
  lineOffsetM: number | null;
  /** The Corner Analysis card's words. */
  tip: string;
  /** How closely this corner copied the target, 0..100 (accuracyScore.ts). */
  score: AccuracyScore | null;
  /** How far the lap's score would rise if this corner scored 100. */
  pointsToGain: number;
}

export interface PracticeLapResult extends LapCompareResult {
  target: PracticeTargetInfo;
  corners: PracticeCornerRow[];
  /** The lap's accuracy score; null without a trace. */
  score: AccuracyScore | null;
}

/* -------------------------------------------------------------------------- */
/*  Small numerics                                                            */
/* -------------------------------------------------------------------------- */

const round1 = (v: number): number => Math.round(v * 10) / 10;

// colAt, minSpeed and lineOffset live in accuracyScore.ts, which scores with them.
export { lineOffset };

/* -------------------------------------------------------------------------- */
/*  Words                                                                     */
/* -------------------------------------------------------------------------- */

/** `training-laps.js`'s level band, seconds. */
const LEVEL_SEC = 0.02;

/**
 * One line of advice, in the overlay Corner Analysis card's words
 * (`overlay/js/widgets/trainingcorner.js` `tipOf`). km/h: the panel converts
 * a displayed unit itself if it ever needs to.
 */
export function cornerTip(r: { deltaSec: number | null; brakeDeltaM: number | null; apexKphDelta: number | null }): string {
  const bm = r.brakeDeltaM;
  const ak = r.apexKphDelta;
  const hasB = bm !== null && Number.isFinite(bm) && Math.abs(bm) >= 3;
  const hasA = ak !== null && Number.isFinite(ak) && Math.abs(ak) >= 1;
  const kph = (v: number): string => `${Math.round(Math.abs(v))} km/h`;
  if (r.deltaSec === null || !Number.isFinite(r.deltaSec)) return 'No timing for this corner';
  if (Math.abs(r.deltaSec) <= LEVEL_SEC) return 'Matched the reference here';
  if (r.deltaSec < 0) {
    if (hasA && ak! > 0) return `Carried ${kph(ak!)} more — keep it`;
    if (hasB && bm! > 0) return `Braked ${Math.round(bm!)} m later — keep it`;
    return 'Quicker through here — keep it';
  }
  const brake = hasB ? (bm! < 0 ? `Brake ${Math.round(-bm!)} m later` : `Brake ${Math.round(bm!)} m earlier`) : '';
  const apex = hasA && ak! < 0 ? `+${kph(ak!)} at the apex` : '';
  if (brake && apex) return `${brake}: ${apex}`;
  if (brake) return brake;
  if (apex) return `Carry ${kph(ak!)} more to the apex`;
  return 'Lost it on the exit — throttle sooner';
}

/* -------------------------------------------------------------------------- */
/*  The corner table                                                          */
/* -------------------------------------------------------------------------- */

/** A row per reference corner. Pure — the tests drive it with columns. */
export function cornerRows(
  lap: PracticeColumns,
  ref: PracticeColumns,
  corners: { entryD: number; apexD: number; exitD: number }[],
  lengthM: number,
): PracticeCornerRow[] {
  const scored = scoreLap(lap, ref, corners, lengthM);
  return corners.map((c, index) => {
    const r = cornerResult(c, ref as LapColumns, lap as LapColumns, lengthM);
    const exitYou = colAt(lap, lap.speedKph, c.exitD);
    const exitRef = colAt(ref, ref.speedKph, c.exitD);
    const minKph = minSpeed(lap, c.entryD, c.exitD);
    const refMinKph = minSpeed(ref, c.entryD, c.exitD);
    return {
      index,
      entryD: c.entryD,
      apexD: c.apexD,
      exitD: c.exitD,
      deltaSec: r.deltaSec,
      brakeDeltaM: r.brakeDeltaM,
      apexKphDelta: r.apexKphDelta,
      exitKphDelta: exitYou !== null && exitRef !== null ? round1(exitYou - exitRef) : null,
      minKph: minKph === null ? null : round1(minKph),
      refMinKph: refMinKph === null ? null : round1(refMinKph),
      lineOffsetM: lineOffset(lap, ref, c.entryD, c.exitD, lengthM),
      tip: cornerTip(r),
      score: scored.corners[index] ?? null,
      pointsToGain: scored.pointsToGain[index] ?? 0,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  Loading                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The snapshotted target as a LapDetail, so `compareWith` and the panel's
 * painters take it exactly as they take a local or a board lap. Shaped the way
 * `detailFromCloudTrace` shapes a league trace.
 */
function detailFromTarget(
  columns: Record<string, unknown>,
  target: PracticeTargetInfo,
  studied: LapDetail,
): LapDetail | null {
  const d = columns.d;
  const t = columns.t;
  if (!Array.isArray(d) || !Array.isArray(t) || d.length < 2 || d.length !== t.length) return null;
  const trace = columns as unknown as CompletedTrace;
  const lapMs = Math.round(target.lapSec * 1000);
  return {
    lapId: target.lapId,
    at: '',
    track: studied.track,
    car: '',
    carClass: studied.carClass,
    lapMs,
    lapSec: Number(columns.lapSec) || target.lapSec,
    count: d.length,
    truncated: false,
    hasLine: hasDrivenLine(trace),
    vMaxKph: vMaxOf(trace),
    sectors: sectorMarks(trace, lapMs),
    channels: trace,
    mapKey: studied.mapKey,
  };
}

/** One practice lap against the session's target — see the header. */
export function loadPracticeLap(args: PracticeLapArgs, deps: PracticeReviewDeps): PracticeLapResult | null {
  const lapDir = deps.lapDir || defaultLapDir();
  const tdir = deps.traceDir || defaultTraceDir();
  const session = loadSession(args.sessionId, lapDir);
  if (!session) return null;
  const lap = session.stints.flatMap((s) => s.laps).find((l) => l.id === args.lapId && (!args.at || l.at === args.at));
  if (!lap) return null;

  const base = loadLapAlone(args.lapId, args.at || lap.at, args.haveMapKey || '', { laps: lapDir, traces: tdir });

  // The reference, resolved exactly as the debrief resolves it. Without a
  // snapshot that is the session's best lap, whose trace is the only one read.
  const snap = findSnapshot(args.sessionId, session, deps.reviewDir);
  const cols = new Map<string, PracticeColumns>();
  let bestFile: TraceFile | null = null;
  const best = snap && snap.target ? null : bestValidLap(session);
  if (best && best.id) {
    bestFile = readTrace(best.id, best.at, tdir);
    const c = bestFile && bestFile.trace ? cleanCols(bestFile.trace) : null;
    if (c) cols.set(best.id, c);
  }
  const reference = practiceReference(session, cols, snap ? snap.target : null);
  if (!reference) return null;

  const out: PracticeLapResult = { ...base, target: reference.target, corners: [], score: null };
  if (!base.detail) return out;

  let other: LapDetail | null = null;
  if (snap && snap.target && reference.target.kind === snap.target.kind && reference.target.lapId === snap.target.lapId) {
    other = detailFromTarget(snap.target.columns as unknown as Record<string, unknown>, reference.target, base.detail);
  } else if (best && best.id) {
    other = loadLapDetail(best.id, best.at, base.detail.mapKey, { laps: lapDir, traces: tdir }).detail;
  }
  const compared: LapCompareResult = other ? compareWith(base, other) : base;

  const L = base.lengthM > 0 ? base.lengthM : session.trackLengthM;
  const mine = cleanCols(base.detail.channels);
  const corners = mine && L > 0 ? cornerRows(mine, reference.ref, reference.corners, L) : [];
  const score = mine && L > 0 ? scoreLap(mine, reference.ref, reference.corners, L).score : null;
  return { ...compared, target: reference.target, corners, score };
}
