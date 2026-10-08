/**
 * practiceTrend.ts — the accuracy score across practice sessions, one track
 * and one class, oldest first.
 * =============================================================================
 *
 * For the electron side (`practice:trend` IPC):
 *
 *   loadPracticeTrend(args: { trackKey: string; carClass: string },
 *                     deps: PracticeReviewDeps): PracticeTrendPoint[]
 *
 * Each point is one practice or test-day session's `PracticeReview.score`
 * plus its lap count and best lap. Building a review reads every trace in the
 * session, so a session is built once and remembered by id: a session that
 * has ended never changes. The one still being driven (its last lap within
 * `SESSION_GAP_MS`, so another lap could still join it) is rebuilt each time
 * and never remembered.
 *
 * Measured against each session's OWN target (the chased lap, or its best) —
 * the trend says how closely each session copied what it was chasing, which
 * is the habit being built; it is not one fixed yardstick across sessions.
 */

import { lapDir as defaultLapDir } from './lapLog';
import { listSessions, SESSION_GAP_MS } from './stintReview';
import { loadPracticeReview, type PracticeReviewDeps } from './practiceReviewLoad';

export interface PracticeTrendArgs {
  trackKey: string;
  carClass: string;
}

export interface PracticeTrendPoint {
  sessionId: string;
  at: string;
  laps: number;
  avgScore: number | null;
  bestScore: number | null;
  bestLapSec: number | null;
}

/** Sessions whose answer cannot change any more, by id. */
const cache = new Map<string, PracticeTrendPoint>();

/** For the tests: forget every remembered session. */
export function clearPracticeTrendCache(): void {
  cache.clear();
}

const PRACTICE = new Set(['practice', 'testday']);

export function loadPracticeTrend(
  args: PracticeTrendArgs,
  deps: PracticeReviewDeps,
  now: number = Date.now(),
): PracticeTrendPoint[] {
  if (!args || !args.trackKey) return [];
  const lapDir = deps.lapDir || defaultLapDir();
  const cls = String(args.carClass || '').toUpperCase();
  const out: PracticeTrendPoint[] = [];
  for (const s of listSessions(lapDir)) {
    if (!PRACTICE.has(s.sessionType) || s.trackKey !== args.trackKey) continue;
    if (cls && String(s.carClass || '').toUpperCase() !== cls) continue;
    const hit = cache.get(s.id);
    if (hit) {
      out.push(hit);
      continue;
    }
    const review = loadPracticeReview(s.id, deps);
    if (!review) continue;
    const point: PracticeTrendPoint = {
      sessionId: s.id,
      at: s.startedAt,
      laps: review.laps.filter((l) => l.lapSec > 0).length,
      avgScore: review.score.avg,
      bestScore: review.score.best,
      bestLapSec: review.bestLapSec,
    };
    const ended = Date.parse(s.endedAt);
    if (Number.isFinite(ended) && now - ended > SESSION_GAP_MS) cache.set(s.id, point);
    out.push(point);
  }
  // A session with no timed lap (sat in the garage, an out-lap and back in)
  // has nothing to plot.
  return out
    .filter((p) => p.laps > 0)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
