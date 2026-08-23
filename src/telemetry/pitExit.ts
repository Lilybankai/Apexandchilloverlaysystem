/**
 * @file src/telemetry/pitExit.ts
 * @module telemetry/pitExit
 *
 * **"If I box now, where do I come out?"** The pit-loss model behind the
 * engineer's pit-exit projection — the strategy call a real pit wall earns its
 * seat with, computed from numbers the sim already publishes.
 *
 * ## Why the loss is measured, not configured
 * The total cost of a stop is lane transit plus stationary time, and the lane
 * transit is track-specific — LMU publishes no "pit lane delta" anywhere. So
 * the model does what a timing screen does: it watches real stops happen. When
 * a car in the player's class enters the lane, its `gapToLeaderSec` is noted;
 * one full lap after it rejoins (so the gap has re-normalized at the line),
 * the new gap is compared and the difference is one observed pit loss. The
 * estimate is the median of recent observations — robust to the one car that
 * also changed a nose.
 *
 * A sample is discarded when the car lost a whole lap across its stop
 * (`lapsBehind` changed): its seconds-behind figure wrapped and the
 * subtraction would be fiction. Same honest-refusal stance as everything else
 * in the engineer: until a real stop has been seen, the answer is "no read",
 * never a guess.
 *
 * ## The projection
 * Player's class-leader gap plus the estimated loss, slotted back into the
 * class order. Cars on a different lap need no arithmetic — a lap up stays
 * ahead, a lap down stays behind — so only same-lap rivals are compared by
 * gap. The result deliberately says "around P7": the rivals keep lapping
 * while the driver is in the lane, and pretending to half-second precision
 * would be the confident wrong answer this module exists to avoid.
 *
 * Pure and headless like its siblings: fed frames via {@link PitLossModel.update},
 * no clock, no network, unit-tested from synthetic frames.
 */

import { UNKNOWN_VALUE } from './types';
import type { StandingEntry, TelemetryFrame } from './types';
import { sessionKeyOf } from './triggers';

/** Observed losses outside this range are discarded as torn reads. */
const MIN_LOSS_SEC = 8;
const MAX_LOSS_SEC = 180;

/** How many recent observations the median is taken over. */
const MAX_SAMPLES = 8;

function known(n: number | undefined): n is number {
  return typeof n === 'number' && n !== UNKNOWN_VALUE && Number.isFinite(n);
}

/** Surname-ish display name, mirroring engineerCommands' radio habit. */
function radioName(entry: StandingEntry): string {
  const name = (entry.driverName || '').trim();
  if (!name) return entry.carNumber ? `car ${entry.carNumber}` : 'the car';
  const parts = name.split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

export interface PitLossEstimate {
  /** Median observed total pit loss, seconds (lane + stop). */
  lossSec: number;
  /** How many stops that median is taken over. */
  samples: number;
}

export interface PitExitProjection {
  /** Projected position after the stop — class position when the class is known. */
  position: number;
  /** True when {@link position} is a class position, false when overall. */
  classBased: boolean;
  /** The car you would come out behind, and how far behind. */
  aheadName?: string;
  aheadGapSec?: number;
  /** The car you would come out ahead of, and by how much. */
  behindName?: string;
  behindGapSec?: number;
  /** The loss the projection used. */
  lossSec: number;
  samples: number;
  /**
   * Of the cars still projected ahead, how many have not made a stop yet —
   * positions that come back when they do. Omitted when nobody's stops are
   * tracked.
   */
  aheadStillToStop?: number;
}

/** Per-car stop-watching state. */
interface Watch {
  inPit: boolean;
  /** Latest known pre-pit gap/laps while running. */
  gapSec?: number;
  lapsBehind?: number;
  lapsCompleted?: number;
  /** Snapshot at pit entry. */
  entryGapSec?: number;
  entryLapsBehind?: number;
  /** Laps completed when the car left the lane; the sample is taken one full lap later. */
  exitLapsCompleted?: number;
  awaitingLap: boolean;
}

export class PitLossModel {
  private sessionKey = '';
  private watch = new Map<number, Watch>();
  private samples: number[] = [];

  reset(): void {
    this.sessionKey = '';
    this.watch.clear();
    this.samples = [];
  }

  /**
   * Feed the latest frame. Cheap: a handful of compares per standings row,
   * allocation only on a pit-lane edge.
   */
  update(frame: TelemetryFrame): void {
    const key = sessionKeyOf(frame);
    if (key !== this.sessionKey) {
      this.watch.clear();
      this.samples = [];
      this.sessionKey = key;
    }
    const me = frame.standings.find((e) => e.isPlayer);
    const myClass = me?.carClass;
    for (const e of frame.standings) {
      // Only the player's class: stop lengths differ across classes (energy
      // fills vs fuel), and the projection is about the player's own stop.
      if (myClass && e.carClass !== myClass) continue;
      let w = this.watch.get(e.slotId);
      if (!w) {
        w = { inPit: !!e.inPit, awaitingLap: false };
        this.watch.set(e.slotId, w);
      }
      const gap = known(e.gapToLeaderSec) ? e.gapToLeaderSec : undefined;
      if (!w.inPit && e.inPit) {
        // Entering the lane: freeze the last running read.
        w.entryGapSec = w.gapSec;
        w.entryLapsBehind = w.lapsBehind;
        w.awaitingLap = false;
      } else if (w.inPit && !e.inPit) {
        // Rejoined: sample one full lap later, when the gap is real again.
        w.exitLapsCompleted = known(e.lapsCompleted) ? e.lapsCompleted : undefined;
        w.awaitingLap = w.entryGapSec !== undefined && w.exitLapsCompleted !== undefined;
      } else if (
        w.awaitingLap &&
        !e.inPit &&
        known(e.lapsCompleted) &&
        w.exitLapsCompleted !== undefined &&
        e.lapsCompleted >= w.exitLapsCompleted + 1
      ) {
        w.awaitingLap = false;
        if (
          gap !== undefined &&
          w.entryGapSec !== undefined &&
          w.entryLapsBehind !== undefined &&
          e.lapsBehind === w.entryLapsBehind // lost a lap → the seconds wrapped
        ) {
          const loss = gap - w.entryGapSec;
          if (loss >= MIN_LOSS_SEC && loss <= MAX_LOSS_SEC) {
            this.samples.push(loss);
            if (this.samples.length > MAX_SAMPLES) this.samples.shift();
          }
        }
      }
      w.inPit = !!e.inPit;
      if (!e.inPit) {
        if (gap !== undefined) w.gapSec = gap;
        w.lapsBehind = e.lapsBehind;
        w.lapsCompleted = known(e.lapsCompleted) ? e.lapsCompleted : w.lapsCompleted;
      }
    }
  }

  /** Median observed loss, or null until a full stop has been seen. */
  estimate(): PitLossEstimate | null {
    if (!this.samples.length) return null;
    const sorted = this.samples.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    return { lossSec: Math.round(median * 10) / 10, samples: this.samples.length };
  }

  /**
   * Where the player comes out after a stop taken now. Null without an
   * estimate or a usable gap chain — refuse, never guess.
   */
  project(frame: TelemetryFrame): PitExitProjection | null {
    const est = this.estimate();
    if (!est) return null;
    const me = frame.standings.find((e) => e.isPlayer);
    if (!me) return null;

    const classBased = !!(me.carClass && known(me.gapToClassLeaderSec));
    const myGap = classBased ? me.gapToClassLeaderSec! : me.gapToLeaderSec;
    const myLaps = classBased
      ? (known(me.classLapsBehind) ? me.classLapsBehind! : 0)
      : me.lapsBehind;
    if (!known(myGap)) return null;

    const rivals = frame.standings.filter(
      (e) =>
        !e.isPlayer &&
        (classBased ? e.carClass === me.carClass : true) &&
        known(classBased ? e.gapToClassLeaderSec : e.gapToLeaderSec),
    );
    if (!rivals.length) return null;

    const exitGap = myGap + est.lossSec;
    let aheadCount = 0;
    let stopsTracked = false;
    let aheadNoStop = 0;
    let nearestAhead: { name: string; gap: number } | null = null;
    let nearestBehind: { name: string; gap: number } | null = null;
    for (const e of rivals) {
      const gap = classBased ? e.gapToClassLeaderSec! : e.gapToLeaderSec;
      const laps = classBased
        ? (known(e.classLapsBehind) ? e.classLapsBehind! : 0)
        : e.lapsBehind;
      // A car on a different lap needs no arithmetic: fewer laps behind stays
      // ahead of a stopping player, more laps behind stays behind.
      const ahead = laps < myLaps || (laps === myLaps && gap < exitGap);
      if (ahead) {
        aheadCount++;
        if (known(e.pitStops)) {
          stopsTracked = true;
          if (e.pitStops === 0) aheadNoStop++;
        }
        if (laps === myLaps && (!nearestAhead || gap > nearestAhead.gap)) {
          nearestAhead = { name: radioName(e), gap };
        }
      } else if (laps === myLaps && (!nearestBehind || gap < nearestBehind.gap)) {
        nearestBehind = { name: radioName(e), gap };
      }
    }

    const out: PitExitProjection = {
      position: aheadCount + 1,
      classBased,
      lossSec: est.lossSec,
      samples: est.samples,
    };
    if (nearestAhead) {
      out.aheadName = nearestAhead.name;
      out.aheadGapSec = Math.round((exitGap - nearestAhead.gap) * 10) / 10;
    }
    if (nearestBehind) {
      out.behindName = nearestBehind.name;
      out.behindGapSec = Math.round((nearestBehind.gap - exitGap) * 10) / 10;
    }
    if (stopsTracked) out.aheadStillToStop = aheadNoStop;
    return out;
  }
}
