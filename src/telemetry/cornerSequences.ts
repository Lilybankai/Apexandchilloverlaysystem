/**
 * cornerSequences.ts — linked corners (chicanes, esses, the Porsche Curves).
 *
 * STUB (2026-10-29): signatures only; claude/coach-engine fills them in.
 */

import type { CornerCatalog, CornerSequence, LapLossBreakdown } from './coachContract';

/** Sequences on one lap pair: trades and carried losses. */
export function findSequences(b: LapLossBreakdown, catalog?: CornerCatalog | null): CornerSequence[] {
  void b;
  void catalog;
  return [];
}

/** Sequences across a driver's laps (losses that move together or trade off). */
export function sessionSequences(laps: readonly LapLossBreakdown[], catalog?: CornerCatalog | null): CornerSequence[] {
  void laps;
  void catalog;
  return [];
}
