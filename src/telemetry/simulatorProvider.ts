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
  type PedalInputs,
  type RelativeEntry,
  type StandingEntry,
  type TelemetryFrame,
  type TyreState,
  type WeatherForecastSlot,
} from './types';

/* --------------------------------- config --------------------------------- */

/** Number of cars in the synthetic field. */
const FIELD_SIZE = 12;
/** Total race laps for the simulated session. */
const RACE_LAPS = 16;
/** Laps every car has already completed when the simulation starts. */
const START_LAPS = 3;
/** Nominal lap time in seconds before per-car pace offset and noise. */
const BASE_LAP_SEC = 118;
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
    for (let i = 0; i < FIELD_SIZE; i++) {
      // Cars ahead in the grid have a small pace advantage; add per-car noise.
      const paceOffset = i * 0.35 + jitter(0.15);
      // Stagger starting positions so the field is spread around the lap.
      const progress = 1 - i / FIELD_SIZE + jitter(0.01);
      this.cars.push({
        slotId: i + 1,
        name: DRIVER_NAMES[i] ?? `Driver ${i + 1}`,
        carNumber: String(3 + i * 4),
        // Two-class field: front runners are Hypercars, the rest GT3 — so the
        // grouped standings + class colours are exercised in demo mode.
        carClass: i < 4 ? 'Hypercar' : 'GT3',
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
        // Fresh lap time with a little variance; keep the best.
        const lap = BASE_LAP_SEC + (car.slotId - 1) * 0.35 + jitter(0.6);
        car.lastLapSec = lap;
        if (lap < car.bestLapSec) car.bestLapSec = lap;
        // Burn a lap's worth of virtual energy (a touch faster for Hypercars).
        const drain = car.carClass === 'Hypercar' ? 0.055 : 0.04;
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

    return ordered.map((car, idx) => {
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

    const toEntry = (car: SimCar, gapSec: number, isPlayer: boolean): RelativeEntry => ({
      slotId: car.slotId,
      position: this.positionOf(car),
      driverName: car.name,
      carNumber: car.carNumber,
      carClass: car.carClass,
      relativeGapSec: Math.round(gapSec * 100) / 100,
      lapsDifference: car.lapsCompleted - player.lapsCompleted,
      inPit: car.inPit,
      isPlayer,
    });

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
