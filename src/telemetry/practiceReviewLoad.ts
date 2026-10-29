/**
 * practiceReviewLoad.ts — the disk half of the Practice Review.
 * =============================================================================
 *
 * For the electron side (`review:practice` IPC):
 *
 *   loadPracticeReview(sessionId: string, deps: PracticeReviewDeps): PracticeReview | null
 *
 *     deps.reviewDir  REQUIRED — `path.join(app.getPath('userData'), 'practice-reviews')`,
 *                     where the session-end detector writes the target snapshots.
 *     deps.lapDir     optional — the lap log (default `lapLog.lapDir()`).
 *     deps.traceDir   optional — the trace store (default `lapTrace.traceDir()`).
 *
 *   Returns `null` only when no session has that id. A session with no
 *   snapshot is measured against its own best lap (`target.kind ===
 *   'sessionBest'`), which the debrief says.
 *
 *   loadPracticeReview(sessionId, deps, { target })
 *     Measure the session against `target` instead of its snapshot — a
 *     leaderboard lap the driver picked afterwards (`review:practice` with
 *     `opts.targetLapId`, fair-ipc.js). Build `target` with
 *     {@link boardTargetSnapshot}. The snapshot is still read for `endedAt`.
 *
 *   boardTargetSnapshot(payload, meta): PracticeTargetSnapshot | null
 *     A board lap's trace (`get_lap_trace`'s answer, as trainingRefCache keeps
 *     it) shaped EXACTLY as the snapshot of a chased board lap would have been:
 *     through the server's own `makeGhostReference` → `ghostFromReference` →
 *     `ghostJson`. So a session measured against a board lap afterwards sees
 *     the same columns and corners as one that chased that lap on track.
 *
 *   sessionFileKey(sessionId: string): string
 *     The snapshot's file name (without `.json`) for a session id. Session ids
 *     carry an ISO time (`2026-10-08T10:20:43.000Z~michelin-raceway-…`), and
 *     `:` cannot be in a Windows file name — so the detector must name the
 *     file with THIS, not with the raw id.
 *
 * The snapshot file (docs/PRACTICE-REVIEW-PLAN.md):
 *   { v: 1, sessionKey, track, car, carClass, trackLengthM, startedAt, endedAt,
 *     target: { kind: 'chased', label, lapId, lapSec, columns: <ghost.json body> } | null }
 *
 * Found by name first. Failing that — the detector could not know the review
 * session's id when it wrote the file, because the id is the first lap's
 * completion time and is only derivable from the lap log — by content: a
 * snapshot for the same track and class whose `endedAt` falls inside the
 * session or within {@link SNAPSHOT_SLACK_MS} after its last lap.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { catalogForTrack } from './cornerCatalog';
import { lapDir as defaultLapDir } from './lapLog';
import { readTrace, traceDir as defaultTraceDir, type TraceFile } from './lapTrace';
import { loadSession } from './stintReview';
import { ghostJson } from './ghostLap';
import { ghostFromReference, makeGhostReference } from './ghostReference';
import {
  buildPracticeReview,
  type PracticeReview,
  type PracticeTargetSnapshot,
} from './practiceReview';

export interface PracticeReviewDeps {
  reviewDir: string;
  lapDir?: string;
  traceDir?: string;
}

/** A snapshot written this long after the session's last lap still belongs to it. */
export const SNAPSHOT_SLACK_MS = 15 * 60_000;

export interface PracticeSnapshotFile {
  v: 1;
  sessionKey?: string;
  track?: string;
  car?: string;
  carClass?: string;
  trackLengthM?: number;
  startedAt?: string;
  endedAt?: string;
  target: PracticeTargetSnapshot | null;
}

/** The snapshot's file name for a session id — see the header. */
export function sessionFileKey(sessionId: string): string {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
}

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function isSnapshot(v: unknown): v is PracticeSnapshotFile {
  return !!v && typeof v === 'object' && (v as { v?: unknown }).v === 1 && 'target' in (v as object);
}

/** The snapshot for a session: by name, else by track, class and time. */
export function findSnapshot(
  sessionId: string,
  session: { track: string; carClass: string; startedAt: string; endedAt: string },
  reviewDir: string,
): PracticeSnapshotFile | null {
  const named = readJson(path.join(reviewDir, `${sessionFileKey(sessionId)}.json`));
  if (isSnapshot(named)) return named;

  let names: string[] = [];
  try {
    names = fs.readdirSync(reviewDir).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  const from = Date.parse(session.startedAt);
  const to = Date.parse(session.endedAt) + SNAPSHOT_SLACK_MS;
  let best: PracticeSnapshotFile | null = null;
  let bestAt = -Infinity;
  for (const n of names) {
    const v = readJson(path.join(reviewDir, n));
    if (!isSnapshot(v)) continue;
    if (v.track && v.track !== session.track) continue;
    if (v.carClass && session.carClass && v.carClass !== session.carClass) continue;
    const at = Date.parse(v.endedAt || '');
    if (!Number.isFinite(at) || at < from || at > to) continue;
    // Two snapshots in the window (a session left and rejoined): the later one
    // saw the whole session.
    if (at > bestAt) {
      best = v;
      bestAt = at;
    }
  }
  return best;
}

/** Options for {@link loadPracticeReview}. */
export interface PracticeReviewOptions {
  /** Measure against this instead of the session's snapshot (a board lap picked afterwards). */
  target?: PracticeTargetSnapshot | null;
}

/** What {@link boardTargetSnapshot} needs besides the trace. */
export interface BoardTargetMeta {
  driverId: string;
  lapMs: number;
  /** Shown as the target, e.g. "J. Smith · 1:47.831". */
  label: string;
  /** The SESSION's circuit: the board row was looked up from its key, so its length is the lap's. */
  trackKey: string;
  trackLengthM: number;
  carClass: string;
  sim?: string;
}

/**
 * A board lap's trace as a {@link PracticeTargetSnapshot} — see the header.
 * `data` is `lap_traces.data` (the columns). `null` when the columns cannot
 * make a lap (too few points, no time, no track length).
 */
export function boardTargetSnapshot(data: unknown, meta: BoardTargetMeta): PracticeTargetSnapshot | null {
  if (!meta || !(meta.lapMs > 0) || !(meta.trackLengthM > 0) || !meta.driverId) return null;
  const refId = `board:${meta.driverId}:${Math.round(meta.lapMs)}`;
  const ref = makeGhostReference(data, {
    sim: meta.sim || 'lmu',
    trackKey: meta.trackKey,
    carClass: meta.carClass,
    // Board traces exist for the dry board only (lap_traces has no surface).
    condition: 'dry',
    refId,
    label: meta.label,
    lapMs: meta.lapMs,
  });
  const lap = ref ? ghostFromReference(ref, meta.trackLengthM) : null;
  const columns = ghostJson(lap);
  if (!columns) return null;
  return {
    kind: 'board',
    label: meta.label,
    lapId: refId,
    // The board's official time: the trace's own crossing-to-crossing clock
    // can differ by a few ms, and the board time is what the driver saw.
    lapSec: meta.lapMs / 1000,
    columns,
  };
}

/** The Practice Review for one session, or `null` when no session has that id. */
export function loadPracticeReview(
  sessionId: string,
  deps: PracticeReviewDeps,
  opts?: PracticeReviewOptions,
): PracticeReview | null {
  const session = loadSession(sessionId, deps.lapDir || defaultLapDir());
  if (!session) return null;

  const tdir = deps.traceDir || defaultTraceDir();
  const traces = new Map<string, TraceFile | null>();
  for (const stint of session.stints) {
    for (const lap of stint.laps) {
      if (!lap.id || !lap.hasTrace) continue;
      traces.set(lap.id, readTrace(lap.id, lap.at, tdir));
    }
  }

  const snap = findSnapshot(sessionId, session, deps.reviewDir);
  return buildPracticeReview({
    session,
    traces,
    target: opts && opts.target ? opts.target : snap ? snap.target : null,
    endedAt: snap && snap.endedAt ? snap.endedAt : undefined,
    catalog: catalogForTrack(session),
  });
}
