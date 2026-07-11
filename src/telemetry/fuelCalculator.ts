/**
 * @file src/telemetry/fuelCalculator.ts
 * @module telemetry/fuelCalculator
 *
 * Pure fuel-strategy math for the fuel-calculator widget. Given a stream of
 * per-frame fuel readings it tracks per-lap consumption and derives the numbers
 * a driver actually wants mid-race: average burn, laps of fuel left, laps still
 * to run, fuel needed to finish, the surplus/deficit, and when the pit window
 * opens.
 *
 * The class is deliberately free of any sim/shared-memory concerns so it is
 * deterministic and unit-testable: feed it {@link FuelUpdate}s and read back a
 * {@link FuelState}. Both the rF2 provider and (optionally) the simulator can
 * reuse it.
 */

import { UNKNOWN_VALUE, type FuelState } from './types';

/** Per-frame inputs the calculator needs to update its estimate. */
export interface FuelUpdate {
  /** Current fuel in the tank, litres. */
  currentFuelLiters: number;
  /** Tank capacity, litres (`<= 0` / unknown allowed). */
  capacityLiters: number;
  /** Player laps completed so far (monotonic; used to detect lap boundaries). */
  lapsCompleted: number;
  /**
   * Total race laps, or `0`/{@link UNKNOWN_VALUE} for a timed race (in which
   * case {@link timeRemainingSec} + {@link avgLapTimeSec} estimate the laps
   * left).
   */
  totalRaceLaps: number;
  /** Seconds left in a timed race, or {@link UNKNOWN_VALUE} if lap-based. */
  timeRemainingSec: number;
  /** Reference lap time in seconds, used to convert remaining time → laps. */
  avgLapTimeSec: number;
}

/** Default number of recent laps averaged for the burn estimate. */
const DEFAULT_SAMPLE_WINDOW = 5;

/**
 * Absolute upper bound (litres) on a single lap's recorded burn when tank
 * capacity is unknown. A lap can never consume more than the tank holds, so
 * when capacity is known that is used instead; this guards the unknown case
 * against an implausible reading that slips the provider's frame gate on a lap
 * boundary and would otherwise skew the average for a full window of laps.
 */
const MAX_PLAUSIBLE_LAP_BURN_L = 100;

/**
 * Stateful fuel-usage tracker. One instance per player car / session; call
 * {@link reset} when the session or car changes.
 */
export class FuelCalculator {
  private readonly window: number;
  /** Rolling per-lap consumption samples (litres). */
  private readonly burns: number[] = [];
  /** Last observed completed-lap count, to detect a new lap. */
  private lastLapsCompleted: number = UNKNOWN_VALUE;
  /** Fuel level captured at the start of the current lap. */
  private fuelAtLapStart: number = UNKNOWN_VALUE;

  /**
   * @param sampleWindow - How many recent laps to average (default 5). Smaller
   *   reacts faster to pace/tyre changes; larger is steadier.
   */
  public constructor(sampleWindow: number = DEFAULT_SAMPLE_WINDOW) {
    this.window = Math.max(1, Math.floor(sampleWindow));
  }

  /** Clears all history. Call on session change or car swap. */
  public reset(): void {
    this.burns.length = 0;
    this.lastLapsCompleted = UNKNOWN_VALUE;
    this.fuelAtLapStart = UNKNOWN_VALUE;
  }

  /**
   * Seeds the rolling average with a known per-lap figure (e.g. from a prior
   * stint), so the widget shows a sensible estimate before a full lap has been
   * observed. Ignored for non-positive values.
   */
  public seedPerLap(litersPerLap: number): void {
    if (litersPerLap > 0) this.burns.push(litersPerLap);
  }

  /** Current rolling-average burn, litres/lap, or {@link UNKNOWN_VALUE}. */
  public get perLapAverage(): number {
    if (this.burns.length === 0) return UNKNOWN_VALUE;
    const sum = this.burns.reduce((a, b) => a + b, 0);
    return sum / this.burns.length;
  }

  /**
   * Feeds one frame of data and returns the current fuel strategy.
   *
   * Consumption is measured across completed laps only: when
   * {@link FuelUpdate.lapsCompleted} increments, the fuel used since the last
   * lap boundary is recorded (positive deltas only, so a refuel/pit stop does
   * not corrupt the average).
   *
   * @param u - Current frame inputs.
   * @returns A fully-populated {@link FuelState}. Unknown quantities use
   *   {@link UNKNOWN_VALUE}.
   */
  public update(u: FuelUpdate): FuelState {
    const fuel = Math.max(0, u.currentFuelLiters);

    // --- lap-boundary detection -> record per-lap burn ------------------
    if (this.lastLapsCompleted === UNKNOWN_VALUE) {
      // First observation: anchor the lap-start fuel, no burn yet.
      this.lastLapsCompleted = u.lapsCompleted;
      this.fuelAtLapStart = fuel;
    } else if (u.lapsCompleted < this.lastLapsCompleted) {
      // Laps went backwards (session restart / new car): re-anchor.
      this.reset();
      this.lastLapsCompleted = u.lapsCompleted;
      this.fuelAtLapStart = fuel;
    } else if (u.lapsCompleted > this.lastLapsCompleted) {
      const burn = this.fuelAtLapStart - fuel;
      // A lap cannot burn more than the tank holds; fall back to an absolute
      // ceiling when capacity is unknown.
      const maxBurn = u.capacityLiters > 0 ? u.capacityLiters : MAX_PLAUSIBLE_LAP_BURN_L;
      // Only count plausible consumption (ignore refuel/telemetry noise and any
      // implausibly large spike that would poison the rolling average).
      if (burn > 0 && burn <= maxBurn && Number.isFinite(burn)) {
        this.burns.push(burn);
        while (this.burns.length > this.window) this.burns.shift();
      }
      this.lastLapsCompleted = u.lapsCompleted;
      this.fuelAtLapStart = fuel;
    }

    // --- derive strategy -------------------------------------------------
    const perLap = this.perLapAverage;
    const capacity = u.capacityLiters > 0 ? u.capacityLiters : UNKNOWN_VALUE;

    const lapsRemaining = perLap > 0 ? fuel / perLap : UNKNOWN_VALUE;
    const lapsToFinish = this.lapsToFinish(u);
    const fuelToFinish =
      perLap > 0 && lapsToFinish !== UNKNOWN_VALUE ? lapsToFinish * perLap : UNKNOWN_VALUE;
    const fuelDelta = fuelToFinish !== UNKNOWN_VALUE ? fuel - fuelToFinish : UNKNOWN_VALUE;
    const refuel = fuelDelta !== UNKNOWN_VALUE ? Math.max(0, -fuelDelta) : 0;

    const state: FuelState = {
      levelLiters: round1(fuel),
      capacityLiters: capacity === UNKNOWN_VALUE ? UNKNOWN_VALUE : round1(capacity),
      perLapAvgLiters: perLap > 0 ? round2(perLap) : UNKNOWN_VALUE,
      lapsRemaining: lapsRemaining !== UNKNOWN_VALUE ? round1(lapsRemaining) : UNKNOWN_VALUE,
      lapsToFinish,
      fuelToFinishLiters: fuelToFinish !== UNKNOWN_VALUE ? round1(fuelToFinish) : UNKNOWN_VALUE,
      fuelDeltaLiters: fuelDelta !== UNKNOWN_VALUE ? round1(fuelDelta) : UNKNOWN_VALUE,
      refuelToFinishLiters: round1(refuel),
    };

    // Pit window: earliest lap by which the tank runs dry — i.e. the last lap
    // you can complete before needing fuel. Only meaningful when we know burn.
    if (lapsRemaining !== UNKNOWN_VALUE && lapsRemaining >= 0) {
      state.pitWindowOpenLap = u.lapsCompleted + Math.floor(lapsRemaining);
    }

    return state;
  }

  /**
   * Laps still required to reach the finish. Uses the lap count directly for a
   * lap race, or estimates from remaining time and lap pace for a timed race.
   */
  private lapsToFinish(u: FuelUpdate): number {
    if (u.totalRaceLaps > 0) {
      return Math.max(0, u.totalRaceLaps - u.lapsCompleted);
    }
    if (u.timeRemainingSec > 0 && u.avgLapTimeSec > 0) {
      // Round up: you must complete the lap you are on when time expires.
      return Math.max(0, Math.ceil(u.timeRemainingSec / u.avgLapTimeSec));
    }
    return UNKNOWN_VALUE;
  }
}

/** Rounds to one decimal place. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Rounds to two decimal places. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
