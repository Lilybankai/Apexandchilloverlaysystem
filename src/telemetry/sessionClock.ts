/**
 * @file src/telemetry/sessionClock.ts
 * @module telemetry/sessionClock
 *
 * How long is left on a timed session's clock — answered from the sim's
 * SERVER-SIDE end-of-session time, not from LMU's per-client phase timer.
 *
 * ## The bug this exists for (THE-33)
 * Mid-race, leave the session or restart the overlays and come back: everything
 * reads right except the clock and the laps left, which jump back to the whole
 * race. The lap counter, the gaps and the standings are right because they come
 * from the server's scoring; the clock was not.
 *
 * It came from REST `timeRemainingInGamePhase`, which is computed on THIS
 * client as `maxTime − (currentEventTime − startEventTime)`. Every capture we
 * hold agrees on that (Silverstone 6 h MP race 2026-08-22: 21600 −
 * (21567.9 − 172.02) = 204.1 against a published 204.09; Daytona practice
 * 2026-09-30: 8640 − (2302.2 − 30.0) = 6367.8 against 6368.79, a sample
 * apart). And
 * `startEventTime` is a CLIENT-SIDE latch on the green, not a server fact: in
 * the Daytona AI captures (2026-08-04) it reads FLT_MIN (1.1755e-38, the
 * uninitialised float) through formation, takes the event time at the moment
 * the client SEES the phase go green (122.68 s), and on a restart drops to 5,
 * back to FLT_MIN, then re-latches at the next green (121.10 s). A client that
 * loads back into a race in progress sees GPHASE_BEFORE for a few seconds and
 * then GREEN (session-ontrack-signal probe) — so it latches the green at the
 * moment it rejoined, and `timeRemainingInGamePhase` restarts from the full
 * `maxTime`. Nothing on the app side survives a restart to correct that: the
 * provider read the field live every 150 ms and published what it said.
 *
 * ## Where the clock comes from now, strongest first
 *   1. **Shared memory `mEndET − mCurrentET`** (Scoring header, absolute bytes
 *      88 / 80). `mEndET` is the session's ABSOLUTE end on the event clock —
 *      21772 in the Silverstone race, i.e. green 172.02 + 21600 — and the pair
 *      is the one rF2's own path ({@link module:telemetry/rf2Provider}) has
 *      always read, as rF2 telemetry tools conventionally do. Taken only while
 *      the session is running, and only when its `mCurrentET` agrees with
 *      REST's `currentEventTime` — a mapping left over from a previous session
 *      (the buffer keeps its last contents after the sim leaves one) fails that.
 *   2. **REST `timeRemainingInGamePhase`**, as before — right whenever this
 *      client saw the real green, which is every session it was in from the
 *      start.
 *   3. **REST `startEventTime + maxTime − currentEventTime`**, the same
 *      arithmetic as (2) done by hand, for a build that omits the phase field.
 *   4. **REST `endEventTime − currentEventTime`** — the pre-green fallback this
 *      provider has always used. NOTE `endEventTime` is a LENGTH over REST, not
 *      an event time (21600 in the 6 h race, against the shared-memory 21772),
 *      so as a running clock it read short by the whole formation; it is only
 *      kept for the garage/grid, where the countdown is not shown anyway and
 *      the fuel planner wants "about the whole race".
 *
 * ## What a rig without shared memory still gets wrong
 * REST alone publishes no server-side end time: `endEventTime` and `maxTime`
 * are lengths and `startEventTime` is the client's own latch, so after a
 * rejoin there is nothing over REST to correct (2) from. A plausibility cap
 * from the field's laps (N laps cannot take less than N × best) was weighed and
 * left out: it can only bound the figure, not recover it, and if LMU carries
 * `lapsCompleted` over from qualifying the way it carries `finishStatus`
 * (race-finish-signals), it would blank a correct clock at the start of every
 * race. Such a rig keeps the old behaviour; the plugin fixes it.
 *
 * Pure, so the whole policy is testable without a sim — see
 * scripts/test-session-clock.js.
 */

import { UNKNOWN_VALUE } from './types';

/** Above this the figure is a sentinel or garbage, not a session clock (s). */
const MAX_SANE_SEC = 100_000;

/**
 * How far the shared-memory event clock may sit from REST's before the two are
 * taken to be different sessions (s). Shared memory updates at the scoring rate
 * and REST is polled every 150 ms, so honest readings sit well under a second
 * apart (Silverstone: 21567.6 vs 21567.8).
 */
const CLOCK_AGREEMENT_SEC = 5;

/** Event times under this are LMU's "not latched" (FLT_MIN, 0, or a stray 5). */
const MIN_LATCHED_ET = 1;

/** The shared-memory Scoring header's event-clock pair. */
export interface SharedMemoryClock {
  /** `mCurrentET` — seconds on the event clock. */
  currentET: number;
  /** `mEndET` — the absolute event time the session ends at. */
  endET: number;
}

/** Everything {@link resolveTimeRemaining} weighs. Times in seconds. */
export interface SessionClockInput {
  /**
   * Whether the session is past the green. Before it, the countdown is the
   * time to the start rather than the race, and the legacy REST fallback is
   * kept so nothing pre-green changes.
   */
  running: boolean;
  /** Fields from `/rest/watch/sessionInfo`; anything absent is `undefined`. */
  rest: {
    currentEventTime?: number;
    endEventTime?: number;
    startEventTime?: number;
    maxTime?: number;
    timeRemainingInGamePhase?: number;
  };
  /** The shared-memory pair, or `null` when the mapping is unreadable. */
  sharedMemory: SharedMemoryClock | null;
}

/** Which source answered — for tests and for anyone debugging a live read. */
export type SessionClockSource =
  | 'sharedMemory'
  | 'restPhase'
  | 'restStart'
  | 'restEnd'
  | 'none';

export interface SessionClockResult {
  /** Seconds left, rounded; {@link UNKNOWN_VALUE} when no source can say. */
  sec: number;
  source: SessionClockSource;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Seconds left in the session — see the module note for the order of trust
 * and the evidence behind it.
 */
export function resolveTimeRemaining(input: SessionClockInput): SessionClockResult {
  const restCur = num(input.rest.currentEventTime);

  // 1. The server's end time, from shared memory.
  const sm = input.sharedMemory;
  if (input.running && sm) {
    const cur = num(sm.currentET);
    const end = num(sm.endET);
    // REST silent on the clock (or not yet ticking) is no reason to doubt
    // shared memory; REST ticking somewhere else is.
    const sameSession =
      restCur === undefined || restCur <= 0 || cur === undefined
        ? true
        : Math.abs(cur - restCur) <= CLOCK_AGREEMENT_SEC;
    if (
      cur !== undefined &&
      end !== undefined &&
      cur >= 0 &&
      end > 0 &&
      end < MAX_SANE_SEC * 10 &&
      sameSession
    ) {
      const left = Math.max(0, end - cur);
      if (left < MAX_SANE_SEC) return { sec: Math.round(left), source: 'sharedMemory' };
    }
  }

  // 2. LMU's phase timer.
  const phase = num(input.rest.timeRemainingInGamePhase);
  if (phase !== undefined && phase > 0 && phase < MAX_SANE_SEC) {
    return { sec: Math.round(phase), source: 'restPhase' };
  }

  // 3. The same arithmetic by hand.
  const length = num(input.rest.maxTime) ?? 0;
  const start = num(input.rest.startEventTime);
  if (
    input.running &&
    length > 0 &&
    restCur !== undefined &&
    start !== undefined &&
    start >= MIN_LATCHED_ET &&
    start <= restCur
  ) {
    const left = Math.max(0, length - (restCur - start));
    return { sec: Math.round(left), source: 'restStart' };
  }

  // 4. The pre-green fallback, unchanged.
  const end = num(input.rest.endEventTime) ?? 0;
  if (end > 0) {
    return { sec: Math.max(0, end - (restCur ?? 0)), source: 'restEnd' };
  }
  return { sec: UNKNOWN_VALUE, source: 'none' };
}
