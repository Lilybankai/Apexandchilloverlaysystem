/**
 * @file src/telemetry/trackLimits.ts
 * @module telemetry/trackLimits
 *
 * Tracks the **consequence** of track limits for the driven car: how many
 * penalties the sim has outstanding, and when that number last moved in either
 * direction.
 *
 * ## What this used to be, and why it is not that any more
 * This module once reconstructed LMU's track-limits *points* from geometry. The
 * sim publishes, per car, `mPathLateral` (how far the car's centre is from the
 * track path) and `mTrackEdge` (how far the road extends in that direction), and
 * with a margin, some hysteresis and a depth-based score you can build a
 * plausible-looking points total out of them — which is what we did, because
 * nothing published the real one.
 *
 * Something does now. `telemetry/lmuTraceLimits.ts` reads the stewards' own
 * charges out of the game's trace log, and they were validated against the
 * session-end results XML: thirteen charges, in order, summing to exactly the
 * 5.00 that earned the drive-through. Once the real number was available the
 * reconstruction stopped being a useful approximation and became a second,
 * differently-wrong number sitting next to a correct one — so it, the tunable
 * off-track margin, the at-risk window and the lift-to-negate rule have all been
 * retired. The one thing that model was never able to see is the thing the sim
 * actually charges on: **time gained**, not distance off the road.
 *
 * What is left is the part that never depended on geometry at all: `mNumPenalties`
 * is the stewards' verdict, published directly, and all this does is notice when
 * it changes.
 *
 * ## Why a class rather than a function
 * Both interesting facts here are EDGES, not levels — a penalty appearing, and a
 * penalty being discharged — so noticing them needs the previous poll's value and
 * therefore memory. Everything stateful lives here so all three providers share
 * one implementation and it can be tested headless
 * (`scripts/test-tracklimits.js`).
 */

import { UNKNOWN_VALUE } from './types';
import type { TrackLimitsState } from './types';

/**
 * How many **points** it takes to earn the penalty, by default.
 *
 * LMU's track limits are a points system, not a strike count: every infringement
 * scores points, and a drive-through is issued once the running total passes a
 * threshold the *session* configures — leagues publish theirs on the event's
 * registration page. There is therefore no universally correct number to hard-code
 * here, which is why this is only the default (see
 * {@link TrackLimitsInput.pointsLimit}).
 *
 * **The sim publishes the real one.** `/rest/sessions` carries
 * `SESSSET_cuts_allowed` — the allowance this session was actually configured
 * with — and `LmuRestProvider.refreshRules` passes it in, so on LMU this default
 * applies only before the first read or outside a session. It stays a middling
 * league figure rather than becoming, say, 5, because it is what a driver sees
 * when nothing authoritative is available, and under-promising the allowance is
 * the safe direction to be wrong in.
 */
export const DEFAULT_POINTS_LIMIT = 10;

/** One poll's worth of input — everything the decision needs. */
export interface TrackLimitsInput {
  /**
   * The sim's own outstanding-penalty count for this car (`mNumPenalties`).
   * {@link UNKNOWN_VALUE} when the channel is unavailable.
   */
  penalties: number;
  /**
   * An identity for the current session — anything that changes when the
   * session does (track + session type is what the providers pass). A change
   * resets the tracker, because a penalty served in qualifying is not news in
   * the race any more than it is news the following evening.
   */
  sessionKey: string;
  /** Wall-clock now, milliseconds. Passed in so the tracker is testable. */
  nowMs: number;
  /**
   * Points that earn the penalty in THIS session, overriding
   * {@link DEFAULT_POINTS_LIMIT}. Leagues publish their own number; a value at
   * or below zero is ignored rather than making every cut instantly fatal.
   */
  pointsLimit?: number;
}

/**
 * Watches the sim's penalty count for one car across a session.
 *
 * Feed it every poll; it returns the skeleton of the state to put on the frame —
 * the points themselves are merged in by the provider that can read them (see
 * `LmuRestProvider.buildTrackLimits`). Cheap by construction: two comparisons and
 * one object, because it runs at the full broadcast rate.
 */
export class TrackLimitsTracker {
  /** Session this tracker belongs to; a change wipes it. */
  private sessionKey = '';
  /** `nowMs` at which {@link penalties} last increased. */
  private lastPenaltyAt = 0;
  /** `nowMs` at which {@link penalties} last DECREASED — one was discharged. */
  private lastServedAt = 0;
  /** Last penalty count seen, to detect the change. */
  private penalties: number = UNKNOWN_VALUE;

  /** Forget everything — a new session, or the car leaving the feed. */
  public reset(): void {
    this.lastPenaltyAt = 0;
    this.lastServedAt = 0;
    this.penalties = UNKNOWN_VALUE;
  }

  /**
   * When the driven car's own penalty count last INCREASED (`nowMs` clock),
   * `0` when it hasn't this session. This is the attribution anchor for the
   * trace reader: the count is per-car and instant, while the trace's penalty
   * lines are anonymous and up to ~25 s late — so "our count rose moments ago"
   * is the one live test of whether an unnamed penalty line is ours.
   */
  public lastPenaltyRoseAtMs(): number {
    return this.lastPenaltyAt;
  }

  /**
   * Advance by one poll and return the current state.
   *
   * Returns `null` when the penalty channel is unavailable, so the provider omits
   * the block entirely rather than publishing a confident zero — the same rule the
   * motion and chassis blocks follow.
   *
   * The points fields come back empty here ({@link UNKNOWN_VALUE} and an empty
   * history): this tracker has no source for them, and a provider that does
   * overwrites them.
   */
  public update(input: TrackLimitsInput): TrackLimitsState | null {
    if (input.sessionKey !== this.sessionKey) {
      this.sessionKey = input.sessionKey;
      this.reset();
    }

    const penalties = input.penalties;
    if (penalties !== UNKNOWN_VALUE) {
      if (this.penalties !== UNKNOWN_VALUE && penalties > this.penalties) {
        this.lastPenaltyAt = input.nowMs;
      }
      // The count going DOWN is the sim confirming one has been discharged, and
      // it is the only confirmation there is: nothing in the feed says "that
      // drive-through counted". Drivers otherwise finish the lane not knowing
      // whether they served it correctly or are about to be told to do it again
      // — which is exactly when they go back round and lose another 20 seconds
      // to be safe.
      if (this.penalties !== UNKNOWN_VALUE && penalties < this.penalties) {
        this.lastServedAt = input.nowMs;
      }
      this.penalties = penalties;
    }

    if (this.penalties === UNKNOWN_VALUE) return null;

    const pointsLimit =
      typeof input.pointsLimit === 'number' && input.pointsLimit > 0
        ? Math.round(input.pointsLimit)
        : DEFAULT_POINTS_LIMIT;

    return {
      points: UNKNOWN_VALUE,
      pointsLimit,
      charges: [],
      charged: 0,
      msSinceCharge: UNKNOWN_VALUE,
      penalties: this.penalties,
      msSincePenalty: this.lastPenaltyAt ? input.nowMs - this.lastPenaltyAt : UNKNOWN_VALUE,
      msSinceServed: this.lastServedAt ? input.nowMs - this.lastServedAt : UNKNOWN_VALUE,
    };
  }
}
