/**
 * fairTarget.ts — is a comparison lap a fair one to chase?
 *
 * STUB (2026-10-29): signatures only; claude/coach-fair fills them in.
 */

import type { FairnessFlag } from './coachContract';

/** What is known about a lap: the driver's own, or a leaderboard candidate. */
export interface TargetLapInfo {
  lapId: string;
  driver?: string;
  car: string;
  carClass: string;
  lapSec: number;
  sessionType?: string | null;
  trackTempC?: number | null;
  airTempC?: number | null;
  fuelStartL?: number | null;
  fuelCapacityL?: number | null;
  vePct?: number | null;
  compound?: string | null;
  condition?: string | null;
  hasLine?: boolean;
}

export interface TargetAssessment {
  flags: FairnessFlag[];
  /** Estimated seconds of the gap that fuel explains; null when it cannot be estimated. */
  fuelSec: number | null;
  /** Lower is fairer. */
  score: number;
}

export function assessTarget(me: TargetLapInfo, cand: TargetLapInfo): TargetAssessment {
  void me;
  void cand;
  return { flags: [], fuelSec: null, score: 0 };
}

export function pickFairTarget(
  me: TargetLapInfo,
  cands: readonly TargetLapInfo[],
): { pick: TargetLapInfo | null; ranked: { lap: TargetLapInfo; assessment: TargetAssessment }[] } {
  const ranked = cands.map((lap) => ({ lap, assessment: assessTarget(me, lap) }));
  return { pick: ranked[0] ? ranked[0].lap : null, ranked };
}
