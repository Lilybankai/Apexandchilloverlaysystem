/**
 * @file src/telemetry/paceAverage.ts
 * @module telemetry/paceAverage
 *
 * Rolling **last-5-lap average** per car, for the standings tower's optional
 * AVG column.
 *
 * ## Where the laps come from
 * The live standings feed, not the lap database: the database stores the
 * player's own laps and this column is about the whole field. Every car's
 * `lastLapSec` is already on the wire each poll; a lap is *collected* on the
 * frame its `lapsCompleted` ticks up, which is the one moment `lastLapSec` is
 * guaranteed to be describing the lap that just ended.
 *
 * ## Pit laps are left out
 * A lap that passed through the pit lane is 30-60 s of stationary car, and one
 * of them in a five-lap window drags the "pace" reading into fiction — the
 * question this column answers is "how fast is this car actually lapping",
 * and an in-lap is not an answer to it. A car seen in the pit lane at any
 * point since its last lap edge has that lap skipped (the poll runs several
 * times a second, so a drive-through cannot slip between samples). The lap
 * AFTER a stop — the out-lap — is genuinely driven from the exit and is kept:
 * it is slow for real reasons (cold tyres, full tank) that a pace average is
 * entitled to report.
 *
 * ## The average is over what exists, up to five
 * Two laps into a run the average is of two laps. Requiring a full window
 * would blank the column for the first quarter of a short race, which helps
 * nobody; the headline says AVG and the number converges as the window fills.
 */

import { UNKNOWN_VALUE } from './types';

/** How many recent laps the average is taken over. */
export const PACE_AVG_WINDOW = 5;

/** One car's rolling state. */
interface CarPace {
  /** `lapsCompleted` when we last collected (or skipped) a lap. */
  laps: number;
  /** Whether the car has been seen in the pit lane since that lap edge. */
  pitted: boolean;
  /** The kept lap times, newest first, capped at {@link PACE_AVG_WINDOW}. */
  times: number[];
}

/** The slice of a standings row this tracker reads. Matches StandingEntry. */
export interface PaceAvgInput {
  slotId: number;
  lapsCompleted: number;
  /** Last lap in seconds; {@link UNKNOWN_VALUE} / non-positive when none. */
  lastLapSec: number;
  inPit: boolean;
}

/**
 * Accumulates lap edges for the whole field and answers with a per-slot
 * average. One instance per provider; feed it every frame.
 */
export class PaceAverageTracker {
  private sessionKey = '';
  private readonly cars = new Map<number, CarPace>();

  /** Forget everything — a new session's laps belong to nobody's average. */
  public reset(): void {
    this.cars.clear();
  }

  /**
   * Advance by one poll and return `slotId → average seconds` for every car
   * that has at least one kept lap.
   *
   * `sessionKey` is the same track+type identity the other trackers key on: a
   * change wipes the windows, because carrying qualifying laps into the race
   * would have the column claiming a pace nobody is running.
   */
  public update(cars: ReadonlyArray<PaceAvgInput>, sessionKey: string): Map<number, number> {
    if (sessionKey !== this.sessionKey) {
      this.sessionKey = sessionKey;
      this.reset();
    }

    const seen = new Set<number>();
    const out = new Map<number, number>();
    for (const c of cars) {
      seen.add(c.slotId);
      let s = this.cars.get(c.slotId);
      if (!s) {
        // First sight of the car: note where its lap count stands and start
        // watching. The laps already driven are not collected — their times
        // are gone; only `lastLapSec` for the most recent one survives, and a
        // one-lap "average" pretending to be five would be the column lying
        // on its first frame.
        s = { laps: c.lapsCompleted, pitted: c.inPit, times: [] };
        this.cars.set(c.slotId, s);
      }

      if (c.lapsCompleted > s.laps) {
        // A lap (or, after a hiccup, several — only the newest has a time)
        // just completed. Keep it unless the car passed through the pit lane
        // on it, or the sim withheld the time (an invalidated lap reads -1).
        const t = c.lastLapSec;
        if (!s.pitted && typeof t === 'number' && t > 0 && t !== UNKNOWN_VALUE) {
          s.times = [t, ...s.times].slice(0, PACE_AVG_WINDOW);
        }
        s.laps = c.lapsCompleted;
        s.pitted = c.inPit; // the new lap starts with whatever is true now
      } else if (c.inPit) {
        s.pitted = true;
      }

      if (s.times.length > 0) {
        const sum = s.times.reduce((a, b) => a + b, 0);
        out.set(c.slotId, sum / s.times.length);
      }
    }

    // Cars that left the field take their window with them, so a slot id
    // reused by a later joiner cannot inherit someone else's laps.
    for (const id of this.cars.keys()) {
      if (!seen.has(id)) this.cars.delete(id);
    }
    return out;
  }
}
