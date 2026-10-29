/**
 * timeLoss.ts — a lap against a reference, per corner and per phase.
 *
 * STUB (2026-10-29): the signature the coach pieces are built against. The
 * engine branch (claude/coach-engine) replaces the body; nothing else may
 * change the signature without saying so.
 */

import type { LapLossBreakdown } from './coachContract';

/** One lap's columns, as a trace stores them (lap fractions in `d`, seconds in `t`). */
export interface LossLapInput {
  lapId: string;
  /** The official lap time; null when the lap has none. */
  lapSec: number | null;
  cols: {
    d: readonly number[];
    t: readonly number[];
    speedKph: readonly number[];
    brake?: readonly number[];
    throttle?: readonly number[];
    steer?: readonly number[];
    latG?: readonly number[];
    x?: readonly number[];
    z?: readonly number[];
  };
}

/** A corner span on the reference lap, with its stable id. */
export interface LossCorner {
  id: string;
  entryD: number;
  apexD: number;
  exitD: number;
}

export function lapLoss(
  mine: LossLapInput,
  ref: LossLapInput,
  corners: readonly LossCorner[],
  trackLengthM: number,
): LapLossBreakdown {
  void corners;
  void trackLengthM;
  return { lapId: mine.lapId, refLapId: ref.lapId, corners: [], sequences: [], leadInSec: 0, totalSec: 0, residualSec: 0 };
}
