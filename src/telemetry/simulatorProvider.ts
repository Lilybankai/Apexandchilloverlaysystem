/**
 * @file src/telemetry/simulatorProvider.ts
 * @module telemetry/simulatorProvider
 *
 * A synthetic {@link TelemetryProvider} that produces realistic, continuously
 * evolving {@link TelemetryFrame}s without any sim running. It exists so the
 * overlays can be developed, demoed, and stream-tested end-to-end, and so the
 * rF2/LMU provider (Task E) has a graceful fallback when the game is closed.
 *
 * The model is intentionally lightweight (a handful of cars, closed-form driver
 * inputs, incremental integration) — no heavy physics — so it costs almost
 * nothing to run at 30 Hz. All state advances by the `dtMs` the server passes
 * to {@link SimulatorProvider.poll}, so the motion is smooth and frame-rate
 * independent.
 */

import type { TelemetryProvider } from './provider';
import {
  TELEMETRY_SCHEMA_VERSION,
  UNKNOWN_VALUE,
  type FuelState,
  type MotionState,
  type PedalInputs,
  type RelativeEntry,
  type StandingEntry,
  type TelemetryFrame,
  type TyreState,
  type WeatherForecastSlot,
} from './types';
import { assignClassPositions, isFasterClass } from './carClass';
import { shouldWarnTraffic, shouldYield } from './yieldAlert';

/* --------------------------------- config --------------------------------- */

/** Number of cars in the synthetic field. */
const FIELD_SIZE = 12;
/** Total race laps for the simulated session. */
const RACE_LAPS = 16;
/** Laps every car has already completed when the simulation starts. */
const START_LAPS = 3;
/** Nominal lap time in seconds before per-car pace offset and noise. */
const BASE_LAP_SEC = 118;
/**
 * Class definitions for the synthetic field: how many cars, and how much slower
 * than {@link BASE_LAP_SEC} that class runs.
 *
 * The pace **spread between classes is the point**. It used to be a flat
 * `i * 0.35`, which put the whole 12-car field inside 4 seconds — so the classes
 * were cosmetic labels and no faster-class car ever actually caught a slower one.
 * Anything keyed on real multiclass behaviour (the blue-flag alert, class gaps,
 * lapping) therefore never triggered in demo mode and could not be seen without
 * the sim running. These offsets are roughly WEC-shaped: ~11 s from Hypercar to
 * GT3 on a ~2-minute lap.
 */
const SIM_CLASSES: Array<{ name: string; count: number; lapOffsetSec: number }> = [
  { name: 'HYPERCAR', count: 4, lapOffsetSec: 0 },
  { name: 'LMP2', count: 4, lapOffsetSec: 5.5 },
  { name: 'GT3', count: 4, lapOffsetSec: 11 },
];
/**
 * Within-class pace spread, indexed by the car's position inside its class.
 * Deliberately **not** ascending: the player is always the first car of its
 * class (`PLAYER_INDEX`), so an ascending spread made the player the fastest car
 * in its class by construction — permanently class leader, with nobody of the
 * same class ahead. Anything that compares the player against the cars ahead
 * *in their own class* (the virtual-energy overlap readout) then had nothing to
 * compare and stayed blank in demo mode.
 */
const WITHIN_CLASS_SPREAD = [0.7, 0, 1.05, 0.35];
/**
 * Starting on-track order, front to back, as car indices. Classes are
 * interleaved — a real endurance grid is mixed on track, not sorted by class —
 * and the player (index 4) starts sixth with two same-class cars ahead, so the
 * multiclass readouts have something real to show from the first frame.
 */
const START_ORDER = [0, 5, 1, 7, 8, 4, 2, 9, 6, 3, 10, 11];
/** Index (0-based) of the player within the field. */
const PLAYER_INDEX = 4;
/** Tank capacity in litres. */
const FUEL_CAPACITY_L = 80;
/** Rows to show in the relative widget (cars ahead + player + cars behind). */
const RELATIVE_AHEAD = 3;
const RELATIVE_BEHIND = 3;

/**
 * Synthetic corner layout as a fraction of the lap (0..1) plus braking effort.
 * Drives the pedal-input / trail-braking trace so the overlay shows a realistic
 * throttle/brake dance rather than random noise.
 */
const CORNERS: ReadonlyArray<{ pos: number; brake: number }> = [
  { pos: 0.08, brake: 0.92 },
  { pos: 0.21, brake: 0.55 },
  { pos: 0.36, brake: 1.0 },
  { pos: 0.5, brake: 0.5 },
  { pos: 0.66, brake: 0.85 },
  { pos: 0.82, brake: 0.7 },
  { pos: 0.93, brake: 0.4 },
];

/** Driver name pool for the synthetic field. */
const DRIVER_NAMES: readonly string[] = [
  'J. Honzik',
  'G. Boothby',
  'S. Louis-Alexand',
  'T. Aktral',
  'A. Chill', // the player
  'B. Bauer',
  'M. Rossi',
  'K. Andersson',
  'P. Novak',
  'D. Ferreira',
  'L. Nakamura',
  'R. Vasquez',
];

/* --------------------------------- helpers -------------------------------- */

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wraps a lap-fraction delta into the range [-0.5, 0.5] (shortest way round). */
function wrapHalf(d: number): number {
  let x = d % 1;
  if (x > 0.5) x -= 1;
  else if (x < -0.5) x += 1;
  return x;
}

/** Small symmetric jitter in [-amp, amp]. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function jitter(amp: number): number {
  return (Math.random() * 2 - 1) * amp;
}

/* ------------------------------ internal state ---------------------------- */

/** Mutable per-car simulation state. */
interface SimCar {
  slotId: number;
  name: string;
  carNumber: string;
  /** Class label — the field is a two-class grid (Hypercar + GT3). */
  carClass: string;
  /** Grid / start position (1-based) so positions gained/lost has a reference. */
  gridPosition: number;
  /** Remaining virtual-energy fraction, 0..1. */
  virtualEnergy: number;
  /** Lap-time this car is currently running to (seconds). */
  lapSec: number;
  /** Position around the current lap, 0..1. */
  progress: number;
  lapsCompleted: number;
  lastLapSec: number;
  bestLapSec: number;
  inPit: boolean;
  pitStops: number;
}

/* ------------------------------ the provider ------------------------------ */

/**
 * Generates a coherent, evolving race for demo/fallback use.
 * @see TelemetryProvider
 */
export class SimulatorProvider implements TelemetryProvider {
  public readonly name = 'simulator';

  private cars: SimCar[] = [];
  private fuelLevel = 62;
  private readonly recentBurns: number[] = [];
  /** Count of player laps for which fuel has been burned (independent of the
   * 5-entry rolling `recentBurns` window). */
  private lapsBurned = 0;
  /** Player's driver-input state, smoothed frame-to-frame. */
  private pedals: PedalInputs = { throttle: 1, brake: 0, clutch: 0, steer: 0 };
  private tyreTemps = { fl: 78, fr: 80, rl: 82, rr: 84 };
  private tyreWear = { fl: 1, fr: 1, rl: 1, rr: 1 };
  private rainIntensity = 0;
  private weatherPhase = 0;
  private started = false;

  public start(): void {
    // Reset fuel state and seed a short burn history so the fuel widget shows
    // meaningful numbers from the very first frame (the 62 L level already
    // reflects these historical laps).
    this.fuelLevel = 62;
    this.recentBurns.length = 0;
    for (let i = 0; i < 3; i++) this.recentBurns.push(2.6 + jitter(0.1));
    this.lapsBurned = 0;

    this.cars = [];
    // Expand SIM_CLASSES into a per-car class lookup: [HC,HC,HC,HC,LMP2,…].
    const classOf: Array<{ name: string; lapOffsetSec: number }> = [];
    for (const c of SIM_CLASSES) {
      for (let n = 0; n < c.count; n++) {
        classOf.push({ name: c.name, lapOffsetSec: c.lapOffsetSec });
      }
    }

    for (let i = 0; i < FIELD_SIZE; i++) {
      // Pace = the car's class offset, plus a small within-class spread so the
      // order inside a class still moves around, plus per-car noise.
      const cls = classOf[i] ?? { name: 'GT3', lapOffsetSec: 11 };
      const paceOffset = cls.lapOffsetSec + (WITHIN_CLASS_SPREAD[i % 4] ?? 0) + jitter(0.15);
      // Spread the field around the lap in START_ORDER, so the on-track order is
      // a mixed-class grid rather than every class in a block.
      const rank = START_ORDER.indexOf(i);
      const progress = 1 - (rank < 0 ? i : rank) / FIELD_SIZE + jitter(0.01);
      this.cars.push({
        slotId: i + 1,
        name: DRIVER_NAMES[i] ?? `Driver ${i + 1}`,
        carNumber: String(3 + i * 4),
        carClass: cls.name,
        // Scrambled grid vs current pace order → non-zero positions gained/lost.
        gridPosition: ((i + 3) % FIELD_SIZE) + 1,
        // Seed energy high with a per-car spread; it ticks down as laps run.
        virtualEnergy: clamp01(0.92 - i * 0.015 + jitter(0.03)),
        lapSec: BASE_LAP_SEC + paceOffset,
        progress: ((progress % 1) + 1) % 1,
        lapsCompleted: START_LAPS,
        lastLapSec: BASE_LAP_SEC + paceOffset + jitter(0.4),
        bestLapSec: BASE_LAP_SEC + paceOffset - 0.3,
        inPit: false,
        pitStops: 0,
      });
    }
    this.started = true;
  }

  public isConnected(): boolean {
    // The simulator is never a "live" sim source.
    return false;
  }

  public stop(): void {
    this.cars = [];
    this.started = false;
  }

  public poll(nowMs: number, dtMs: number): TelemetryFrame {
    if (!this.started) this.start();
    const dt = clamp(dtMs, 0, 250) / 1000; // seconds, guarded against long stalls

    this.advanceField(dt);
    this.advanceWeather(dt);

    const player = this.player();
    this.advanceDriverInputs(player, dt);
    this.advanceTyres(dt);

    const standings = this.buildStandings();
    const relative = this.buildRelative();
    const fuel = this.buildFuel(player);

    const leader = this.cars.reduce((a, b) =>
      this.total(b) > this.total(a) ? b : a,
    );

    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      source: 'simulator',
      timestamp: nowMs,
      connected: false,
      session: {
        type: 'race',
        phase: 'green',
        flag: 'green',
        track: 'Silverstone (ELMS)',
        trackConfig: 'Grand Prix',
        timeRemainingSec: UNKNOWN_VALUE,
        totalLaps: RACE_LAPS,
        lapsRemaining: UNKNOWN_VALUE,
        currentLap: Math.min(RACE_LAPS, leader.lapsCompleted + 1),
        numCars: this.cars.length,
        serverName: 'Apex & Chill — Midweek Endurance',
      },
      player: {
        slotId: player.slotId,
        position: this.positionOf(player),
        pedals: { ...this.pedals },
        motion: this.motionFor(this.pedals),
        gear: this.gearFor(this.pedals),
        speedKph: this.speedFor(this.pedals),
        rpm: this.rpmFor(this.pedals),
        maxRpm: 8600,
        lap: {
          current: player.progress * player.lapSec,
          last: player.lastLapSec,
          best: player.bestLapSec,
          // Wandering live delta vs. best: swings a few tenths either side of zero
          // through the lap (green when up, red when down) so the delta bar reads
          // like a real predictive delta rather than a one-way drift.
          delta:
            Math.round(
              (Math.sin(player.progress * Math.PI * 3) * 0.35 +
                (player.lapSec - player.bestLapSec) * (player.progress - 0.5)) *
                100,
            ) / 100,
          sector: Math.min(3, Math.floor(player.progress * 3) + 1),
        },
        tyres: this.buildTyres(),
      },
      standings,
      relative,
      weather: {
        trackTempC: 30 + Math.sin(this.weatherPhase) * 1.5 - this.rainIntensity * 6,
        ambientTempC: 22 + Math.sin(this.weatherPhase * 0.7) * 0.8 - this.rainIntensity * 3,
        rainIntensity: this.rainIntensity,
        trackWetness: clamp01(this.rainIntensity * 1.2),
        forecast: this.buildForecast(),
      },
      fuel,
    };
  }

  /* ----------------------------- field motion ---------------------------- */

  /** Advances every car around the lap and records completed laps. */
  private advanceField(dt: number): void {
    for (const car of this.cars) {
      const speedFactor = car.inPit ? 0.35 : 1;
      const prev = car.progress;
      car.progress += (dt / car.lapSec) * speedFactor;
      if (car.progress >= 1) {
        car.progress -= 1;
        car.lapsCompleted += 1;
        // Fresh lap time with a little variance, around THIS car's own pace.
        // (It used to re-derive the pace from the slot id, which threw away the
        // class offset the car was actually running — so every completed lap
        // reset a GT3's time to Hypercar pace and the tower disagreed with the
        // gaps.)
        const lap = car.lapSec + jitter(0.6);
        car.lastLapSec = lap;
        if (lap < car.bestLapSec) car.bestLapSec = lap;
        // Burn a lap's worth of virtual energy — faster in the quicker classes,
        // which is what makes the energy-overlap readout meaningful.
        const drain = car.carClass === 'HYPERCAR' ? 0.055 : car.carClass === 'LMP2' ? 0.048 : 0.04;
        car.virtualEnergy = clamp01(car.virtualEnergy - drain + jitter(0.005));
        // Occasional pit stop for cars other than the player.
        if (car.slotId !== this.player().slotId && Math.random() < 0.02) {
          car.inPit = true;
          car.pitStops += 1;
        }
      }
      // Leave the pit lane shortly after entering.
      if (car.inPit && prev < 0.1 && car.progress >= 0.1) car.inPit = false;
    }
  }

  /** Total race progress used for ordering: laps completed + lap fraction. */
  private total(car: SimCar): number {
    return car.lapsCompleted + car.progress;
  }

  private player(): SimCar {
    return this.cars[PLAYER_INDEX] ?? this.cars[0]!;
  }

  private orderedByPosition(): SimCar[] {
    return [...this.cars].sort((a, b) => this.total(b) - this.total(a));
  }

  private positionOf(car: SimCar): number {
    return this.orderedByPosition().indexOf(car) + 1;
  }

  /* ---------------------------- driver inputs ---------------------------- */

  /**
   * Computes target throttle/brake/steer from the player's lap position using
   * the synthetic corner layout, including a trail-braking overlap (brake
   * bleeding off while throttle builds through the apex), then smooths toward
   * the target so the trace looks like real inputs.
   */
  private advanceDriverInputs(player: SimCar, dt: number): void {
    const p = player.progress;
    let throttle = 1;
    let brake = 0;
    let steer = 0;

    CORNERS.forEach((c, i) => {
      const sign = i % 2 === 0 ? 1 : -1;
      const d = wrapHalf(c.pos - p); // >0 => corner is ahead of the player
      const approach = 0.06;
      const exit = 0.05;
      if (d >= 0 && d <= approach) {
        // Braking zone before the apex: brake builds, throttle lifts.
        const k = 1 - d / approach; // 0 far → 1 at apex
        brake = Math.max(brake, c.brake * k);
        throttle = Math.min(throttle, 1 - 0.9 * k);
        steer = sign * 0.6 * k;
      } else if (d < 0 && d >= -exit) {
        // Exit: trail-brake bleeds off while throttle progressively returns.
        const k = 1 + d / exit; // 1 at apex → 0 at exit end
        brake = Math.max(brake, c.brake * 0.8 * k);
        throttle = Math.min(throttle, 1 - 0.55 * k);
        steer = sign * 0.6 * k;
      }
    });

    // Smooth toward the target inputs (first-order response) + tiny jitter.
    const resp = clamp(dt * 12, 0, 1);
    const smThrottle = clamp01(lerp(this.pedals.throttle, throttle, resp) + jitter(0.01));
    const smBrake = clamp01(lerp(this.pedals.brake, brake, resp) + jitter(0.01));
    const smSteer = clamp(lerp(this.pedals.steer, steer, resp), -1, 1);

    // Synthetic driver aids so the TC/ABS indicators can be seen in demo mode:
    // ABS pulses under heavy braking; TC trims the throttle when power goes
    // down mid-corner. Pulsing mimics the modulation a real system shows.
    const pulse = 0.55 + 0.45 * Math.sin(Date.now() / 45);
    const abs = smBrake > 0.72 ? clamp01((smBrake - 0.72) * 2.4) * pulse : 0;
    const tc =
      smThrottle > 0.35 && smThrottle < 0.95 && Math.abs(smSteer) > 0.18
        ? clamp01(Math.abs(smSteer) * 1.4) * clamp01((smThrottle - 0.35) * 2) * pulse * 0.6
        : 0;

    this.pedals = {
      throttle: smThrottle,
      brake: smBrake,
      clutch: 0,
      steer: smSteer,
      tc: round2(tc),
      abs: round2(abs),
    };
  }

  private gearFor(pedals: PedalInputs): number {
    const speed = this.speedFor(pedals);
    if (speed < 70) return 2;
    if (speed < 110) return 3;
    if (speed < 150) return 4;
    if (speed < 190) return 5;
    if (speed < 230) return 6;
    return 7;
  }

  private speedFor(pedals: PedalInputs): number {
    // Fast on throttle, slow under braking; smooth mid-range.
    const base = lerp(115, 255, clamp01(pedals.throttle * (1 - pedals.brake)));
    return Math.round(base - pedals.brake * 40);
  }

  private rpmFor(pedals: PedalInputs): number {
    return Math.round(lerp(4200, 8400, clamp01(pedals.throttle)) - pedals.brake * 800);
  }

  /* -------------------------------- motion ------------------------------- */

  /**
   * Synthesises G-force / rotation / attitude from the inputs already being
   * simulated, so the motion widget can be previewed without a sim.
   *
   * It is derived from the same physics identity the real signs are checked
   * against — `latAccel = speed × yawRate` — rather than made up independently.
   * That means demo mode cannot accidentally look self-consistent while the
   * live decode is inverted: both obey the same relation, so a sign error shows
   * up as the two disagreeing.
   */
  private motionFor(pedals: PedalInputs): MotionState {
    const speedMs = this.speedFor(pedals) / 3.6;
    // Steering to yaw rate via a plausible constant lock-to-rate gain. Real
    // cars vary with speed and load; a demo does not need to.
    const yawRate = round2(pedals.steer * 0.42);
    const latG = round2((speedMs * yawRate) / 9.80665);
    // Braking dominates longitudinal G, as it does in a real car — and is
    // POSITIVE here, matching the display convention decodeMotion() applies.
    const lonG = round2(pedals.brake * 1.65 - pedals.throttle * 0.55);
    // Vertical is ZERO-centred, matching what LMU actually publishes (gravity
    // is cancelled by the normal force, so flat ground reads ~0 — verified live
    // at 200 kph). An earlier version sat this at 1 g, which made demo mode
    // disagree with the sim and would have hidden a real regression.
    const vertG = round2(Math.sin(this.weatherPhase * 7) * 0.18);
    // Attitude follows load transfer: nose dives under brakes, body rolls away
    // from the corner. Both lag the input slightly in reality; not modelled.
    const pitch = round2(pedals.throttle * 0.4 - pedals.brake * 1.9);
    const roll = round2(-pedals.steer * 2.2);
    // A little more slip than the yaw implies, so the readout is not pinned to
    // zero — a demo showing 0.0° forever looks broken rather than neutral.
    const slipAngle = round2(pedals.steer * 2.6 + jitter(0.15));
    return {
      latG,
      lonG,
      vertG,
      yawRate,
      pitchRate: round2(-pedals.brake * 0.05),
      rollRate: round2(-pedals.steer * 0.06),
      pitch,
      roll,
      heading: round2(((this.weatherPhase * 40) % 360) - 180),
      slipAngle,
      speedMs: round2(speedMs),
    };
  }

  /* -------------------------------- tyres -------------------------------- */

  /** Tyre temperatures respond to load; wear ticks down slowly. */
  private advanceTyres(dt: number): void {
    const load = this.pedals.throttle * 0.5 + this.pedals.brake * 0.9;
    const steerLoad = Math.abs(this.pedals.steer);
    const target = 82 + load * 18 - this.rainIntensity * 10;
    const resp = clamp(dt * 0.6, 0, 1);
    // Fronts run hotter under braking; loaded (outer) side hotter in corners.
    this.tyreTemps.fl = lerp(this.tyreTemps.fl, target + this.pedals.brake * 6 + steerLoad * 4, resp);
    this.tyreTemps.fr = lerp(this.tyreTemps.fr, target + this.pedals.brake * 6 - steerLoad * 2, resp);
    this.tyreTemps.rl = lerp(this.tyreTemps.rl, target + this.pedals.throttle * 4 + steerLoad * 3, resp);
    this.tyreTemps.rr = lerp(this.tyreTemps.rr, target + this.pedals.throttle * 4 - steerLoad * 1, resp);

    const wearRate = dt / (BASE_LAP_SEC * 40); // ~40 laps of life
    this.tyreWear.fl = clamp01(this.tyreWear.fl - wearRate * (1 + steerLoad));
    this.tyreWear.fr = clamp01(this.tyreWear.fr - wearRate * (1 + steerLoad * 0.6));
    this.tyreWear.rl = clamp01(this.tyreWear.rl - wearRate * (1 + this.pedals.throttle * 0.5));
    this.tyreWear.rr = clamp01(this.tyreWear.rr - wearRate * (1 + this.pedals.throttle * 0.5));
  }

  private buildTyres() {
    const mk = (tempC: number, wear: number): TyreState => ({
      tempC: Math.round(tempC * 10) / 10,
      innerC: Math.round((tempC + 3) * 10) / 10,
      middleC: Math.round(tempC * 10) / 10,
      outerC: Math.round((tempC - 2) * 10) / 10,
      pressureKpa: Math.round((165 + (tempC - 82) * 0.4) * 10) / 10,
      wear: Math.round(wear * 1000) / 1000,
      compound: 'Medium',
    });
    return {
      frontLeft: mk(this.tyreTemps.fl, this.tyreWear.fl),
      frontRight: mk(this.tyreTemps.fr, this.tyreWear.fr),
      rearLeft: mk(this.tyreTemps.rl, this.tyreWear.rl),
      rearRight: mk(this.tyreTemps.rr, this.tyreWear.rr),
    };
  }

  /* ------------------------------ standings ------------------------------ */

  private buildStandings(): StandingEntry[] {
    const ordered = this.orderedByPosition();
    const leader = ordered[0]!;
    const leaderTotal = this.total(leader);
    const playerId = this.player().slotId;
    const refLap = BASE_LAP_SEC;

    const rows: StandingEntry[] = ordered.map((car, idx) => {
      const behindTotal = leaderTotal - this.total(car);
      const lapsBehind = Math.floor(behindTotal + 1e-6);
      const ahead = ordered[idx - 1];
      const gapToAheadSec =
        ahead === undefined ? 0 : (this.total(ahead) - this.total(car)) * refLap;
      return {
        slotId: car.slotId,
        position: idx + 1,
        gridPosition: car.gridPosition,
        driverName: car.name,
        carNumber: car.carNumber,
        carClass: car.carClass,
        virtualEnergy: round2(car.virtualEnergy),
        gapToLeaderSec: lapsBehind >= 1 ? UNKNOWN_VALUE : behindTotal * refLap,
        gapToAheadSec: Math.max(0, gapToAheadSec),
        lapsBehind,
        bestLapSec: car.bestLapSec,
        lastLapSec: car.lastLapSec,
        lapsCompleted: car.lapsCompleted,
        inPit: car.inPit,
        pitStops: car.pitStops,
        tyreCompound: 'Medium',
        isPlayer: car.slotId === playerId,
      };
    });
    // Same derivation the live providers use, so demo mode exercises the
    // position-in-class / class-gap columns instead of leaving them blank.
    assignClassPositions(rows);
    return rows;
  }

  /* ------------------------------- relative ------------------------------ */

  private buildRelative(): RelativeEntry[] {
    const player = this.player();
    const refLap = BASE_LAP_SEC;
    // Signed on-track gap (seconds) to the player for every other car.
    const withGap = this.cars
      .filter((c) => c.slotId !== player.slotId)
      .map((c) => {
        const d = wrapHalf(c.progress - player.progress); // + => ahead on track
        return { car: c, gapSec: d * refLap, frac: d };
      });

    const ahead = withGap
      .filter((x) => x.frac > 0)
      .sort((a, b) => a.frac - b.frac)
      .slice(0, RELATIVE_AHEAD)
      .reverse(); // furthest-ahead first, nearest last
    const behind = withGap
      .filter((x) => x.frac <= 0)
      .sort((a, b) => b.frac - a.frac)
      .slice(0, RELATIVE_BEHIND);

    const toEntry = (car: SimCar, gapSec: number, isPlayer: boolean): RelativeEntry => {
      const lapsDifference = car.lapsCompleted - player.lapsCompleted;
      const entry: RelativeEntry = {
        slotId: car.slotId,
        position: this.positionOf(car),
        driverName: car.name,
        carNumber: car.carNumber,
        carClass: car.carClass,
        relativeGapSec: Math.round(gapSec * 100) / 100,
        lapsDifference,
        inPit: car.inPit,
        isPlayer,
      };
      if (isPlayer) return entry;

      // The live provider samples the closing rate over a window because its gap
      // is noisy; here the pace difference is exact, so it is computed directly.
      // Rate the raw gap changes: (car's lap fraction per second − the player's)
      // scaled back into seconds of gap.
      const gapRate = refLap * (1 / car.lapSec - 1 / player.lapSec);
      // Closing = the ABSOLUTE gap shrinking, which flips sign either side of us.
      const closing = gapSec >= 0 ? -gapRate : gapRate;
      const faster = isFasterClass(car.carClass, player.carClass);
      entry.isFasterClass = faster;
      entry.closingRateSec = Math.round(closing * 100) / 100;
      const traffic = {
        gapSec,
        lapsDifference,
        fasterClass: faster,
        slowerClass: isFasterClass(player.carClass, car.carClass),
        closingRateSec: closing,
        inPit: car.inPit,
      };
      entry.yieldTo = shouldYield(traffic);
      entry.trafficAhead = shouldWarnTraffic(traffic);
      return entry;
    };

    return [
      ...ahead.map((x) => toEntry(x.car, x.gapSec, false)),
      toEntry(player, 0, true),
      ...behind.map((x) => toEntry(x.car, x.gapSec, false)),
    ];
  }

  /* --------------------------------- fuel -------------------------------- */

  /**
   * Burns fuel on lap completion and derives a basic strategy view. (Task E's
   * fuelCalculator provides the authoritative computation for the real
   * provider; the simulator keeps a self-contained copy so Task C has no
   * dependency on Task E.)
   */
  private buildFuel(player: SimCar): FuelState {
    // Virtual energy, so demo mode exercises the fuel widget's ENERGY view and
    // the energy-overlap readout rather than leaving both permanently blank.
    // The per-lap burn mirrors the drain applied in `advance()`.
    const vePerLapPct = player.carClass === 'HYPERCAR' ? 5.5 : player.carClass === 'LMP2' ? 4.8 : 4;
    const vePct = player.virtualEnergy * 100;
    const veLapsLeft = Math.round((vePct / vePerLapPct) * 10) / 10;
    const lapsToGo = Math.max(0, RACE_LAPS - player.lapsCompleted);
    // Same rule as the live provider: only cars AHEAD, in the player's own
    // class, running an energy budget. See `buildEnergyOverlap` for why the
    // comparison cannot cross classes.
    let compared = 0;
    let pittingFirst = 0;
    let bestMargin = -1;
    for (const c of this.cars) {
      if (c.slotId === player.slotId) continue;
      if (this.positionOf(c) >= this.positionOf(player)) continue;
      if (c.carClass !== player.carClass) continue;
      compared++;
      const margin = veLapsLeft - (c.virtualEnergy * 100) / vePerLapPct;
      if (margin > 0) {
        pittingFirst++;
        if (margin > bestMargin) bestMargin = margin;
      }
    }

    // Burn fuel once per completed player lap. `lapsBurned` (not the capped
    // 5-entry `recentBurns` window) is the authoritative counter, so this stays
    // correct past the 5th lap instead of burning every frame.
    const lapsSinceStart = Math.max(0, player.lapsCompleted - START_LAPS);
    while (this.lapsBurned < lapsSinceStart) {
      const burn = 2.6 + jitter(0.15);
      this.fuelLevel = Math.max(0, this.fuelLevel - burn);
      this.recentBurns.push(burn);
      if (this.recentBurns.length > 5) this.recentBurns.shift();
      this.lapsBurned += 1;
    }

    const perLapAvg =
      this.recentBurns.length > 0
        ? this.recentBurns.reduce((a, b) => a + b, 0) / this.recentBurns.length
        : UNKNOWN_VALUE;

    const lapsRemaining = perLapAvg > 0 ? this.fuelLevel / perLapAvg : UNKNOWN_VALUE;
    const lapsToFinish = Math.max(0, RACE_LAPS - player.lapsCompleted);
    const fuelToFinish = perLapAvg > 0 ? lapsToFinish * perLapAvg : UNKNOWN_VALUE;
    const fuelDelta = fuelToFinish >= 0 ? this.fuelLevel - fuelToFinish : UNKNOWN_VALUE;

    return {
      levelLiters: Math.round(this.fuelLevel * 10) / 10,
      capacityLiters: FUEL_CAPACITY_L,
      perLapAvgLiters: perLapAvg > 0 ? Math.round(perLapAvg * 100) / 100 : UNKNOWN_VALUE,
      lapsRemaining: lapsRemaining >= 0 ? Math.round(lapsRemaining * 10) / 10 : UNKNOWN_VALUE,
      lapsToFinish,
      fuelToFinishLiters: fuelToFinish >= 0 ? Math.round(fuelToFinish * 10) / 10 : UNKNOWN_VALUE,
      fuelDeltaLiters: fuelDelta === UNKNOWN_VALUE ? UNKNOWN_VALUE : Math.round(fuelDelta * 10) / 10,
      refuelToFinishLiters:
        fuelDelta === UNKNOWN_VALUE ? 0 : Math.round(Math.max(0, -fuelDelta) * 10) / 10,
      pitWindowOpenLap:
        lapsRemaining > 0 ? player.lapsCompleted + Math.floor(lapsRemaining) : undefined,
      virtualEnergyPct: Math.round(vePct * 10) / 10,
      virtualEnergyPerLapPct: vePerLapPct,
      virtualEnergyLapsRemaining: veLapsLeft,
      virtualEnergyDeltaPct: Math.round((vePct - lapsToGo * vePerLapPct) * 10) / 10,
      ...(compared > 0
        ? {
            veCarsAheadPittingFirst: pittingFirst,
            veCarsAheadCompared: compared,
            ...(bestMargin > 0 ? { veLapsInHandVsNext: Math.round(bestMargin * 10) / 10 } : {}),
          }
        : {}),
    };
  }

  /* ------------------------------- weather ------------------------------- */

  private advanceWeather(dt: number): void {
    this.weatherPhase += dt * 0.02;
    // Slowly build then clear light rain over the stint to exercise the widget.
    const wave = Math.sin(this.weatherPhase * 0.5);
    this.rainIntensity = clamp01(Math.max(0, wave - 0.5) * 0.8);
  }

  private buildForecast(): WeatherForecastSlot[] {
    const slots = [0, 15, 30, 45, 60];
    return slots.map((minutesAhead) => {
      const phase = this.weatherPhase + minutesAhead * 0.02;
      const wave = Math.sin(phase * 0.5);
      const intensity = clamp01(Math.max(0, wave - 0.5) * 0.8);
      const chance = clamp01(0.15 + Math.max(0, wave) * 0.6);
      let sky: WeatherForecastSlot['sky'] = 'partlyCloudy';
      if (intensity > 0.5) sky = 'rain';
      else if (intensity > 0.1) sky = 'lightRain';
      else if (wave > 0.4) sky = 'overcast';
      else if (wave < -0.4) sky = 'clear';
      return {
        minutesAhead,
        rainChance: Math.round(chance * 100) / 100,
        rainIntensity: Math.round(intensity * 100) / 100,
        trackTempC: Math.round((30 + Math.sin(phase) * 1.5 - intensity * 6) * 10) / 10,
        sky,
      };
    });
  }
}
