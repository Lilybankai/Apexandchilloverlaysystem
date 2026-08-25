/**
 * @file src/telemetry/paceTargets.ts
 * @module telemetry/paceTargets
 *
 * Converts one resolved Ohne Speed race-pace reference into the named targets
 * the engineer can speak. Keeping this arithmetic here means Tier 1 answers,
 * Tier 2 summaries and proactive practice calls cannot drift apart.
 */

import { paceBands } from './referencePace';
import type { PaceScoreState } from './types';

export type ReferencePaceTargetId = 'alien' | 'competitive' | 'midpack';

export interface ReferencePaceTarget {
  id: ReferencePaceTargetId;
  label: string;
  /** Inclusive ceiling from the source table, e.g. 101 for Competitive. */
  maxPercent: number;
  /** Slowest lap that still belongs to this band, in seconds. */
  lapSec: number;
}

const TARGET_IDS: readonly ReferencePaceTargetId[] = [
  'alien',
  'competitive',
  'midpack',
];

function known(n: number | undefined | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Resolve a named pace target from the same band table that scored the lap.
 * Returns null rather than embedding fallback percentages when the source table
 * is unavailable or does not define that band.
 */
export function referencePaceTarget(
  score: PaceScoreState | null | undefined,
  id: ReferencePaceTargetId,
): ReferencePaceTarget | null {
  // A resolved reference arrives before the first completed lap with `ok:
  // false`, `reason: no-lap`. The target is still valid and useful when the
  // driver asks what time to aim for, so refSec — not score.ok — is the gate.
  if (!score || !known(score.refSec)) return null;
  const band = paceBands().find(
    (candidate) => candidate.id === id && typeof candidate.maxPercent === 'number',
  );
  if (!band || band.maxPercent === null) return null;
  return {
    id,
    label: band.label,
    maxPercent: band.maxPercent,
    lapSec: round1(score.refSec * band.maxPercent / 100),
  };
}

/** All engineer-facing targets keyed by their stable source-table ids. */
export function referencePaceTargets(
  score: PaceScoreState | null | undefined,
): Partial<Record<ReferencePaceTargetId, ReferencePaceTarget>> {
  const targets: Partial<Record<ReferencePaceTargetId, ReferencePaceTarget>> = {};
  for (const id of TARGET_IDS) {
    const target = referencePaceTarget(score, id);
    if (target) targets[id] = target;
  }
  return targets;
}

/** Positive means the driver's best lap still has this many seconds to find. */
export function deltaToReferencePaceTarget(
  score: PaceScoreState | null | undefined,
  target: ReferencePaceTarget | null | undefined,
): number | null {
  if (!score || !target || !known(score.lapSec)) return null;
  return round1(score.lapSec - target.lapSec);
}
