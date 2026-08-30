/**
 * @file src/telemetry/lapsToFlag.ts
 * @module telemetry/lapsToFlag
 *
 * How many more laps will THIS car run before the chequered flag?
 *
 * ## Why it is not a subtraction
 * In a lap-limited race the lap total belongs to the **overall leader**. A
 * 40-lap race is 40 laps for whoever is winning it; everyone else runs for the
 * same amount of TIME and completes however many laps their own pace gets them.
 * In a single-class field those are the same number, which is why
 * `totalLaps − leaderLapsCompleted` looked correct for years.
 *
 * In LMU's multiclass fields they are not close. Probed live at Sebring
 * (2026-08-26, 24 cars): a Hypercar best of 93.6 s against a GT3 best of
 * 106.2 s. Over the 29 laps a leading Hypercar still has to run, a GT3 will
 * complete about 26 — so the old subtraction told a GT3 driver they had 29 laps
 * left when they had 26. That number sits directly above the fuel figures, and
 * it errs long, which is the direction that costs a stop rather than a race.
 *
 * ## What it actually computes
 * One idea in both race types: **the time still to run, divided by this car's
 * lap time.**
 *
 *   - **Timed race.** The time still to run is the clock. Straightforward —
 *     and note that the clock is the same for every car in the race, so the
 *     only thing that varies the answer is whose pace is divided into it.
 *   - **Lap-limited race.** The time still to run is however long the leader
 *     needs for their remaining laps: `(totalLaps − leaderLaps) × leaderPace`.
 *
 * The result is rounded UP in both cases, because a car that is mid-lap when
 * the flag falls still has to bring that lap home — the same convention
 * "29 LAPS LEFT" already used, where the lap being driven is counted.
 *
 * ## What "this car's pace" should be
 * Whatever the caller passes, but see {@link PredictInput.paceSec}: it must NOT
 * be LMU's `estimatedLapTime`. That field reads as a per-car estimate and is
 * nothing of the sort — probed across a 24-car field it was one identical value
 * on every row, including cars that had never turned a lap. Using it would give
 * every class the same pace and quietly undo this entire module. A rolling
 * average of recent laps (telemetry/paceAverage) is the right input; a best lap
 * is the acceptable fallback before enough laps exist.
 */

import { UNKNOWN_VALUE } from './types';

/** What the prediction needs to know. All times in seconds. */
export interface PredictInput {
  /** The race's lap limit, or `0`/{@link UNKNOWN_VALUE} for a timed race. */
  totalLaps: number;
  /** Seconds left on the clock; {@link UNKNOWN_VALUE} or `0` for a lap race. */
  timeRemainingSec: number;
  /** Laps the OVERALL leader has completed — they decide when the flag falls. */
  leaderLapsCompleted: number;
  /**
   * The overall leader's representative lap time. Only used to convert their
   * remaining laps into remaining time, so it is irrelevant in a timed race.
   */
  leaderPaceSec: number;
  /**
   * The subject car's representative lap time — **its own**, which is what
   * makes this a prediction about this car rather than about somebody else.
   *
   * This used to be the leader of the player's class, which fixed the
   * multiclass error but stopped one car short of the answer: inside a class
   * the leader is by definition the quickest of it, so every other car was
   * told it would cover the leader's distance. Measured at Daytona
   * (2026-08-30) the LMP2 class leader lapped 101.4 s and the car being
   * fuelled 104.7 s, which over the 2 h 27 m remaining was 88 laps against a
   * real 85 — three laps of fuel carried for nothing, in the direction the
   * module note above calls the expensive one.
   *
   * A class leader's pace remains a reasonable FALLBACK for the frames before
   * the subject car has turned a lap of its own. Never LMU's
   * `estimatedLapTime`; see the module note.
   */
  paceSec: number;
}

/** The answer, and whether it is a guess the UI should hedge with a `~`. */
export interface PredictResult {
  /** Laps still to run, including the one being driven; or {@link UNKNOWN_VALUE}. */
  laps: number;
  /**
   * `true` when a pace ratio or a clock produced the number, so it is a
   * prediction and should be shown as approximate. `false` when it is the plain
   * lap subtraction, which for a car in the leading class is exact.
   */
  estimated: boolean;
}

const NONE: PredictResult = { laps: UNKNOWN_VALUE, estimated: false };

/** A usable lap time: present, positive, and not an absurd outlier. */
function usablePace(sec: number | undefined): boolean {
  return typeof sec === 'number' && sec > 5 && sec < 1200;
}

/**
 * Predict the laps this car still has to run before the flag.
 *
 * Fails to {@link UNKNOWN_VALUE} rather than guessing from one known quantity:
 * a laps-left figure that is wrong is worse than one that is absent, because
 * the driver cannot tell which they are looking at.
 *
 * @param input - See {@link PredictInput}.
 * @returns The prediction; `laps` is {@link UNKNOWN_VALUE} when nothing can be
 *   said, and `0` once the leader has completed the distance.
 */
export function predictLapsToFlag(input: PredictInput): PredictResult {
  const { totalLaps, timeRemainingSec, leaderLapsCompleted, leaderPaceSec, paceSec } = input;

  // --- timed race: the clock IS the time still to run ------------------------
  if (!(totalLaps > 0)) {
    if (!(timeRemainingSec > 0) || !usablePace(paceSec)) return NONE;
    return { laps: Math.max(1, Math.ceil(timeRemainingSec / paceSec)), estimated: true };
  }

  // --- lap-limited race ------------------------------------------------------
  const leaderLeft = totalLaps - Math.max(0, leaderLapsCompleted | 0);
  // Past the distance: the race is over, and "0" is a fact rather than a guess.
  if (leaderLeft <= 0) return { laps: 0, estimated: false };

  // Without both paces there is no ratio to apply, so answer the leader's own
  // remaining laps — the old behaviour, and exact for anyone in their class.
  if (!usablePace(leaderPaceSec) || !usablePace(paceSec)) {
    return { laps: leaderLeft, estimated: false };
  }

  // A car in the LEADING class is not slower than the leader in any way that
  // matters, and float noise between two similar laps must not manufacture a
  // prediction where the exact answer already holds. Guarding on `>` rather
  // than clamping also means this can never report MORE laps than the leader
  // themselves has left, which would be nonsense on its face.
  if (paceSec <= leaderPaceSec) return { laps: leaderLeft, estimated: false };

  const laps = Math.max(1, Math.ceil((leaderLeft * leaderPaceSec) / paceSec));
  return { laps, estimated: true };
}
