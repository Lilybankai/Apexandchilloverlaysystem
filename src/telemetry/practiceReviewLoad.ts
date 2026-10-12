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
import { lapDir as defaultLapDir } from './lapLog';
import { readTrace, traceDir as defaultTraceDir, type TraceFile } from './lapTrace';
import { loadSession } from './stintReview';
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

/** The Practice Review for one session, or `null` when no session has that id. */
export function loadPracticeReview(sessionId: string, deps: PracticeReviewDeps): PracticeReview | null {
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
    target: snap ? snap.target : null,
    endedAt: snap && snap.endedAt ? snap.endedAt : undefined,
  });
}
