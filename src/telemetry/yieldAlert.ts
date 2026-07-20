/**
 * @file src/telemetry/yieldAlert.ts
 * @module telemetry/yieldAlert
 *
 * The **blue-flag / backmarker** decision: should the player move over for this
 * car?
 *
 * Every provider derives its relative gaps differently (the LMU provider from
 * dead-reckoned road distance, the simulator from exact lap fractions), but the
 * question they ask of the result is identical. Keeping the thresholds in one
 * place stops them drifting apart, and makes the rule testable without a sim.
 */

import { UNKNOWN_VALUE } from './types';

/**
 * How close a car must be, in seconds, before the alert fires. Roughly the
 * point at which a faster car is committed to the pass and the driver in front
 * should be picking a side.
 */
export const YIELD_ALERT_GAP_SEC = 3;

/**
 * Minimum closing rate (seconds of gap per second) for a **same-lap**
 * faster-class alert. Without it the banner latches on to a faster-class car
 * that is merely circulating at a similar pace and never actually arrives.
 */
export const YIELD_MIN_CLOSING_RATE = 0.02;

/** Everything the decision needs about one car, from the player's viewpoint. */
export interface YieldInput {
  /**
   * Signed on-track gap in seconds: **positive = ahead** of the player on the
   * road, negative = behind. Matches `RelativeEntry.relativeGapSec`.
   */
  gapSec: number;
  /** Whole laps this car is ahead of the player (negative = player is ahead). */
  lapsDifference: number;
  /** Whether this car is in a genuinely faster category (see `carClass`). */
  fasterClass: boolean;
  /**
   * Rate the absolute gap is shrinking, in seconds per second (positive =
   * closing). {@link UNKNOWN_VALUE} when not yet measurable.
   */
  closingRateSec: number;
  /** Whether this car is in the pit lane. */
  inPit: boolean;
}

/**
 * Whether the player owes this car a move.
 *
 * The car must be **behind on the road but ahead on the race**, and near enough
 * to matter. There are two ways to be ahead on the race:
 *
 * - **a lap or more up** — an unambiguous blue flag, alerted regardless of
 *   closing rate (a car a lap up that isn't currently closing is still entitled
 *   to the place, and will be closing again shortly);
 * - **same lap, faster class, and actually closing** — a Hypercar reeling in a
 *   GT3.
 *
 * A car in the pit lane never triggers the alert: its road position is
 * meaningless while it is off the racing line.
 */
export function shouldYield(input: YieldInput): boolean {
  if (input.inPit) return false;
  // Behind on the road, and close enough to be about to arrive.
  if (!(input.gapSec < 0 && -input.gapSec <= YIELD_ALERT_GAP_SEC)) return false;
  if (input.lapsDifference > 0) return true;
  if (!input.fasterClass) return false;
  return (
    input.closingRateSec !== UNKNOWN_VALUE && input.closingRateSec >= YIELD_MIN_CLOSING_RATE
  );
}
