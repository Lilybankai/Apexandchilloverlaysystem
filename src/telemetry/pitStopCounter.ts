/**
 * @file src/telemetry/pitStopCounter.ts
 * @module telemetry/pitStopCounter
 *
 * How many stops each car has actually made — counted here, because the sim's
 * own answer is not one.
 *
 * ## Why not just read `pitstops`
 * LMU publishes a `pitstops` field per car and it resets. Probed live at
 * Daytona (2026-08-30, a 175-lap team race):
 *
 * ```
 *   the leaders          lap 175   pitstops 0
 *   a car mid-stop       lap 156   pitstops 1   (watched it tick 0 -> 1)
 *   our own car #12      lap ~150  pitstops 9  ->  0, same driver at the wheel
 * ```
 *
 * Nobody runs 175 laps of Daytona without stopping. Driver swaps are the
 * obvious trigger in a team race, which makes the field worthless in precisely
 * the sessions a pit-wall cares about most — and worse than worthless on the
 * timing sheet, because a resetting number looks like a real one.
 *
 * ## What is counted instead
 * The rising edge of "this car is in the pit lane". That signal is solid: the
 * sim keeps `pitting` true for the whole visit, which absorbs the
 * `STOPPED -> NONE -> STOPPED` flutter observed in the middle of a real stop.
 * One visit is therefore one edge.
 *
 * `REARM_SAMPLES` clear samples are required before a car can be counted in
 * again, so a single dropped or flickering sample cannot invent a second stop.
 * At the provider's ~150 ms poll that is under a second — far shorter than any
 * out-lap, far longer than any flicker.
 *
 * ## The honest limitation
 * Counting starts when this process first sees the car. Joining a race already
 * in progress therefore undercounts, so a car's first sighting adopts the sim's
 * current `pitstops` as a floor rather than claiming zero. That is a guess, but
 * it is a guess in the right direction and it is never worse than the resetting
 * field it replaces.
 */

/** Consecutive clear samples before a car can be counted into the pits again. */
export const REARM_SAMPLES = 5;

/** The minimum this needs to know about a car, so callers keep their own shape. */
export interface PitStopSample {
  slotId: number;
  /** Physically in the pit lane or box right now. */
  onPitLane: boolean;
  /** The sim's own count, used only to seed a car seen for the first time. */
  simStops?: number;
}

interface CarStops {
  stops: number;
  inLane: boolean;
  /** Consecutive samples seen clear of the lane, capped at REARM_SAMPLES. */
  offFor: number;
}

export class PitStopCounter {
  private readonly cars = new Map<number, CarStops>();
  private sessionKey = '';

  /**
   * Advance every car for one poll and return the counts by slot.
   *
   * Call once per new snapshot — counting the same snapshot twice is harmless
   * (the edge has already been consumed) but wastes the re-arm budget.
   */
  update(samples: PitStopSample[], sessionKey: string): Map<number, number> {
    if (sessionKey !== this.sessionKey) {
      this.sessionKey = sessionKey;
      this.cars.clear();
    }
    const out = new Map<number, number>();
    const live = new Set<number>();
    for (const s of samples) {
      live.add(s.slotId);
      let car = this.cars.get(s.slotId);
      if (!car) {
        // First sight. Seed from the sim, and treat a car already in the lane
        // as mid-visit so its exit is not counted as an arrival.
        car = {
          stops: typeof s.simStops === 'number' && s.simStops > 0 ? Math.round(s.simStops) : 0,
          inLane: s.onPitLane,
          offFor: s.onPitLane ? 0 : REARM_SAMPLES,
        };
        this.cars.set(s.slotId, car);
      } else if (s.onPitLane) {
        if (!car.inLane && car.offFor >= REARM_SAMPLES) car.stops++;
        car.inLane = true;
        car.offFor = 0;
      } else {
        car.inLane = false;
        if (car.offFor < REARM_SAMPLES) car.offFor++;
      }
      out.set(s.slotId, car.stops);
    }
    // Forget cars that have left, so a long stream with a rolling grid cannot
    // grow this without bound.
    if (this.cars.size > samples.length + 8) {
      for (const slot of Array.from(this.cars.keys())) {
        if (!live.has(slot)) this.cars.delete(slot);
      }
    }
    return out;
  }

  /** Drop everything — a new session, or a provider reconnect. */
  reset(): void {
    this.cars.clear();
    this.sessionKey = '';
  }
}
