/**
 * @file src/telemetry/yieldAlert.ts
 * @module telemetry/yieldAlert
 *
 * The two **traffic** decisions for the relative widget. They are mirror images
 * of each other and it matters which is which:
 *
 * - {@link shouldYield} — a faster car is **behind you on the road** and you owe
 *   it the place. The blue flag. *They* are the problem for *you*.
 * - {@link shouldWarnTraffic} — a slower car is **ahead of you on the road** and
 *   you are arriving on it. The backmarker you have to get past. *You* are the
 *   problem for *them*.
 *
 * Every provider derives its relative gaps differently (the LMU provider from
 * dead-reckoned road distance, the simulator from exact lap fractions), but the
 * questions they ask of the result are identical. Keeping the thresholds in one
 * place stops them drifting apart, and makes both rules testable without a sim.
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

/**
 * How close a slower car ahead must be before it is called out as traffic.
 * Tighter than {@link YIELD_ALERT_GAP_SEC}: a car you are catching is a problem
 * you are actively driving into, and warning three seconds out would leave the
 * icon up through most of a lap while you reel it in.
 */
export const TRAFFIC_ALERT_GAP_SEC = 2.5;

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
   * Whether this car is in a genuinely **slower** category. Not simply
   * `!fasterClass`: when either class is unrecognised both are `false`, which is
   * what stops a mod entry being treated as traffic or as a blue flag.
   */
  slowerClass: boolean;
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

/**
 * Whether the player is arriving on a **backmarker ahead** — a slower car they
 * are about to have to get past.
 *
 * The mirror of {@link shouldYield}: the car must be **ahead on the road but
 * behind on the race**, and the player must be closing on it. Two ways to be
 * behind on the race:
 *
 * - **a lap or more down** — the classic backmarker;
 * - **a slower class** — a GT3 in front of a Hypercar is traffic on the same
 *   lap, which is most of what an endurance race actually consists of.
 *
 * Closing is required in **both** cases, unlike the blue flag. A car a lap down
 * that is holding station ahead of you is not a problem you are about to have —
 * you only care once you are catching it. Without this the icon would sit lit
 * for most of a stint on anything you never actually reach.
 *
 * A car in the pit lane is excluded: it is off the racing line and will not be
 * in your way.
 */
export function shouldWarnTraffic(input: YieldInput): boolean {
  if (input.inPit) return false;
  // Ahead on the road, close enough that you are arriving on it.
  if (!(input.gapSec > 0 && input.gapSec <= TRAFFIC_ALERT_GAP_SEC)) return false;
  const behindOnRace = input.lapsDifference < 0 || input.slowerClass;
  if (!behindOnRace) return false;
  return (
    input.closingRateSec !== UNKNOWN_VALUE && input.closingRateSec >= YIELD_MIN_CLOSING_RATE
  );
}
