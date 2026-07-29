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
  type ChassisState,
  type DamageState,
  type FuelState,
  type MotionState,
  type PaceDeltas,
  type PedalInputs,
  type PitPhase,
  type PitState,
  type SessionPhase,
  type RadarBlip,
  type RelativeEntry,
  type StandingEntry,
  type TelemetryFrame,
  type TrackLimitsState,
  type TyreState,
  type WeatherForecastSlot,
} from './types';
import { assignClassPositions, isFasterClass } from './carClass';
import { buildRadar, headingOri, type RadarCar } from './radar';
import type { Vec3 } from './motion';
import { ChassisTracker } from './chassis';
import type { RawCorner, RawCornerSet } from './chassis';
import { decodeDamage } from './damage';
import {
  DEFAULT_OFF_TRACK_MARGIN_M,
  INSTANT_PENALTY_POINTS,
  TrackLimitsTracker,
} from './trackLimits';
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
  { name: 'HYPERCAR', count: 3, lapOffsetSec: 0 },
  { name: 'LMP2', count: 3, lapOffsetSec: 5.5 },
  { name: 'LMP3', count: 3, lapOffsetSec: 8 },
  { name: 'GT3', count: 3, lapOffsetSec: 11 },
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
 * Half-axes (metres) of the ellipse the synthetic field is placed on to give the
 * radar real 2-D world positions. Demo mode has no track geometry of its own, so
 * a car's lap `progress` (0..1) is mapped to a point on this ellipse and its
 * heading to the tangent. The size is deliberately small — perimeter ≈ 630 m —
 * so the evenly-spread field lands a couple of cars inside radar range and the
 * widget shows blips instead of an empty scope. Only the *raw* positions are
 * invented; the projection is the real {@link buildRadar}.
 */
const SIM_TRACK_A = 120;
const SIM_TRACK_B = 75;
/** Two full turns of π. */
const TAU = Math.PI * 2;

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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Name a wetness fraction — mirrors wetnessBand() in the LMU provider. */
function simWetnessBand(wet: number): string {
  if (wet < 0.02) return 'DRY';
  if (wet < 0.2) return 'DAMP';
  if (wet < 0.5) return 'WET';
  if (wet < 0.8) return 'VERY WET';
  return 'SATURATED';
}

/** Small symmetric jitter in [-amp, amp]. */
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
  /** Which way the demo track is going, for the weather widget's trend arrow. */
  private wetTrend: 'drying' | 'wetting' | 'steady' = 'steady';
  private weatherPhase = 0;
  /**
   * Seconds of simulated session time. Demo mode has no sim clock of its own,
   * but {@link ChassisTracker} advances its reference average on one, so the
   * tick loop keeps a monotonic count here.
   */
  private clockSec = 0;
  /** The real four-corner decoder, fed synthetic input. See buildChassis(). */
  private readonly chassisTracker = new ChassisTracker();
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

    this.clockSec += dt;
    this.advanceField(dt);
    this.advanceWeather(dt);

    const player = this.player();
    this.advanceDriverInputs(player, dt);
    this.advanceTyres(dt);

    const standings = this.buildStandings();
    const relative = this.buildRelative();
    const radar = this.buildRadarBlips(player);
    const fuel = this.buildFuel(player);
    // Built once and shared: the chassis model is derived from the same motion
    // state the frame reports, so calling motionFor() twice would risk the two
    // drifting apart if it ever gains any per-call state.
    const motion = this.motionFor(this.pedals);
    const chassis = this.buildChassis(motion);
    const damage = this.buildDamage();
    // After the damage block, which is where the booked stop length comes from
    // when a stop starts.
    const pit = this.advancePit(dt, damage);
    // After the pit cycle: excursions are not judged in the pit lane, so the
    // tracker needs this poll's phase, not last poll's.
    const trackLimits = this.buildTrackLimits(dt, this.speedFor(this.pedals));
    // Which pre-green phase the demo is in, or null once it has gone green.
    const preSession = this.advancePreSession(dt);

    // The demo's live delta, and the pace block derived from it. Demo mode is
    // how the overlay is set up and how it looks when LMU is unreachable, so
    // the delta widget's projected lap has to have something to show here or it
    // reads as broken rather than as waiting.
    const simDelta =
      Math.round(
        (Math.sin(player.progress * Math.PI * 3) * 0.35 +
          (player.lapSec - player.bestLapSec) * (player.progress - 0.5)) *
          100,
      ) / 100;
    const paceDeltas: PaceDeltas = {
      tSession: simDelta,
      tAllTime: round2(simDelta + 0.21),
      tLast: round2(simDelta - 0.13),
      vSession: round2(simDelta * 0.9),
      vAllTime: round2(simDelta * 0.9 + 0.21),
      vLast: round2(simDelta * 0.9 - 0.13),
      predictedLapSec: round2(player.bestLapSec + simDelta),
      lapTimeSec: round2(player.progress * player.lapSec),
      refSessionSec: round2(player.bestLapSec),
      refAllTimeSec: round2(player.bestLapSec - 0.21),
      lastLapSec: round2(player.lastLapSec),
    };

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
        phase: preSession ?? 'green',
        flag: preSession ? 'none' : 'green',
        track: 'Silverstone (ELMS)',
        trackConfig: 'Grand Prix',
        timeRemainingSec: UNKNOWN_VALUE,
        totalLaps: RACE_LAPS,
        lapsRemaining: UNKNOWN_VALUE,
        currentLap: Math.min(RACE_LAPS, leader.lapsCompleted + 1),
        numCars: this.cars.length,
        serverName: 'Apex & Chill — Midweek Endurance',
        notStarted: preSession !== null,
        scheduledLengthSec: SimulatorProvider.DEMO_SESSION_LENGTH_SEC,
      },
      player: {
        slotId: player.slotId,
        position: this.positionOf(player),
        pedals: { ...this.pedals },
        motion,
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
          delta: simDelta,
          sector: Math.min(3, Math.floor(player.progress * 3) + 1),
        },
        tyres: this.buildTyres(),
        paceDeltas,
        // Absent for the first few seconds while the tracker's reference
        // converges — the same shape the live path produces, so demo mode
        // exercises the widget's "waiting for data" branch too.
        ...(chassis ? { chassis } : {}),
        ...(damage ? { damage } : {}),
        pit,
        ...(trackLimits ? { trackLimits } : {}),
      },
      standings,
      relative,
      ...(radar ? { radar } : {}),
      weather: {
        trackTempC: 30 + Math.sin(this.weatherPhase) * 1.5 - this.rainIntensity * 6,
        ambientTempC: 22 + Math.sin(this.weatherPhase * 0.7) * 0.8 - this.rainIntensity * 3,
        rainIntensity: this.rainIntensity,
        trackWetness: clamp01(this.rainIntensity * 1.2),
        // Named condition and trend, so demo mode exercises the wet-weather
        // readout instead of leaving it permanently on the dry branch. The
        // simulator's rain builds and clears over the stint, so this walks the
        // whole band scale on its own.
        trackCondition: simWetnessBand(clamp01(this.rainIntensity * 1.2)),
        trackTrend: this.wetTrend,
        trackSpread: round2(clamp01(this.rainIntensity * 0.35)),
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

  /* -------------------------------- pit stop ------------------------------- */

  /**
   * How long the demo spends out on track between stops, seconds. Long enough
   * that the overlay is not permanently in the pits, short enough that anyone
   * checking the countdown does not have to wait around for it.
   */
  private static readonly PIT_INTERVAL_SEC = 100;
  /** Seconds spent trundling down the lane, each way. */
  private static readonly PIT_LANE_SEC = 5;
  /**
   * Seconds the demo stop overruns its booked length by.
   *
   * Fixed rather than random: the whole point of the overrun is to exercise the
   * widget's past-zero state, and a random one would make the demo behave
   * differently on every run for no gain. 3.2 s is the residual actually
   * measured on a real stop (published 184.5, finished 187.7) — see
   * `telemetry/damage.ts`.
   */
  private static readonly PIT_OVERRUN_SEC = 3.2;

  /** Seconds into the current lap of the pit cycle. */
  private pitClockSec = 0;
  /**
   * The booked stop length and slack, captured when the crew starts work and
   * held until the cycle comes round again — NOT cleared at the release.
   *
   * The stop's length is what puts the release and the end of the cycle on the
   * clock, so dropping it the instant the car is let go would move both
   * boundaries backwards and skip the exiting stage entirely on the next frame.
   */
  private pitWork: { plannedSec: number; slackSec: number } | null = null;

  /**
   * Runs the demo through a full stop on a loop — approaching, stationary with
   * the crew working, then released — so the damage widget's countdown can be
   * seen and tuned without a race running.
   *
   * The stop's length is the sim's own published total for whatever the demo
   * damage block currently has booked, exactly as the live path takes it from
   * the repair screen, so the countdown is exercised against real figures rather
   * than a made-up duration.
   */
  private advancePit(dt: number, damage: DamageState | null): PitState {
    this.pitClockSec += dt;
    const lane = SimulatorProvider.PIT_LANE_SEC;
    const enterAt = SimulatorProvider.PIT_INTERVAL_SEC;
    const stopAt = enterAt + lane;

    // The crew's work begins the moment the car reaches the box, so the booked
    // length is captured there — before it is needed to place the release.
    if (this.pitClockSec >= stopAt && !this.pitWork) {
      this.pitWork = {
        plannedSec: damage ? damage.stopLengthSeconds : UNKNOWN_VALUE,
        slackSec: damage ? damage.randomDelayMaxSeconds : UNKNOWN_VALUE,
      };
    }
    const booked =
      this.pitWork && this.pitWork.plannedSec !== UNKNOWN_VALUE ? this.pitWork.plannedSec : 30;
    const releaseAt = stopAt + booked + SimulatorProvider.PIT_OVERRUN_SEC;
    const doneAt = releaseAt + lane;

    if (this.pitClockSec >= doneAt) {
      this.pitClockSec -= doneAt; // keep the overshoot, so the cycle does not drift
      this.pitWork = null;
    }
    const t = this.pitClockSec;

    let phase: PitPhase = 'none';
    if (t >= releaseAt) phase = 'exiting';
    else if (t >= stopAt) phase = 'stopped';
    else if (t >= enterAt) phase = 'entering';

    // The player's own standings row should agree with the phase, or the tower
    // would show a car on track while the widget counts its stop down.
    this.player().inPit = phase !== 'none';

    if (phase !== 'stopped') {
      return {
        phase,
        working: false,
        elapsedSec: UNKNOWN_VALUE,
        plannedSec: UNKNOWN_VALUE,
        slackSec: UNKNOWN_VALUE,
      };
    }
    return {
      phase,
      working: true,
      elapsedSec: round1(t - stopAt),
      plannedSec: this.pitWork ? this.pitWork.plannedSec : UNKNOWN_VALUE,
      slackSec: this.pitWork ? this.pitWork.slackSec : UNKNOWN_VALUE,
    };
  }

  /* ------------------------------ pre-session ------------------------------ */

  /**
   * The demo's booked session length, seconds — a 40-minute race, so the
   * pre-session header has a realistic figure to show rather than a round
   * number that could be mistaken for a placeholder.
   */
  private static readonly DEMO_SESSION_LENGTH_SEC = 2400;

  /**
   * Seconds of run-up the demo spends before going green, and the phases it
   * walks through on the way.
   *
   * The demo goes green ONCE, at boot, and then stays there — it does not cycle
   * back like the pit and damage states do. Those cycle because both of their
   * states are things the widgets spend real time in; "not started" is not. A
   * demo that dropped back to a garage header every couple of minutes would be
   * actively unhelpful for the job the demo mostly does, which is positioning
   * widgets against a running race. Restart the server to see it again.
   */
  private static readonly PRE_SESSION: ReadonlyArray<{ until: number; phase: SessionPhase }> = [
    { until: 8, phase: 'garage' },
    { until: 15, phase: 'gridwalk' },
    { until: 20, phase: 'countdown' },
  ];

  /** Seconds since the demo booted, capped once the session has gone green. */
  private preSessionClockSec = 0;

  /**
   * Advances the run-up and returns the phase, or `null` once green. Freezes
   * its own clock at the changeover so it costs nothing for the rest of the run.
   */
  private advancePreSession(dt: number): SessionPhase | null {
    const table = SimulatorProvider.PRE_SESSION;
    const total = table[table.length - 1]!.until;
    if (this.preSessionClockSec >= total) return null;
    this.preSessionClockSec += dt;
    for (const step of table) {
      if (this.preSessionClockSec < step.until) return step.phase;
    }
    return null;
  }

  /* ------------------------------ track limits ----------------------------- */

  /**
   * How often the demo driver runs wide, seconds. Frequent enough that the
   * widget's warning flash, its pips and the audio cue can all be seen without
   * waiting around; slow enough that the strip is mostly showing its clean
   * state, which is what it will be doing for most of a real stint.
   */
  private static readonly LIMITS_INTERVAL_SEC = 35;
  /**
   * How long each demo excursion lasts, seconds.
   *
   * Must comfortably outlast `AT_RISK_WINDOW_MS`, or the excursion ends before
   * the verdict is reached and nothing ever scores. It was exactly 1.2 s — the
   * same figure as the window — which made resolution a coin toss on poll
   * timing.
   */
  private static readonly LIMITS_EXCURSION_SEC = 2.0;
  /** Half the demo track's width, metres — the `mTrackEdge` the sim would give. */
  private static readonly LIMITS_TRACK_EDGE_M = 7;

  /** Seconds into the current run-wide cycle. */
  private limitsClockSec = 0;
  /** The real tracker — the demo invents the geometry, not the counting. */
  private readonly limits = new TrackLimitsTracker();

  /**
   * Synthesises the two lateral-position channels a real car would publish and
   * runs them through the **live** {@link TrackLimitsTracker}, exactly as
   * {@link buildChassis} does with the chassis tracker.
   *
   * So demo mode exercises the actual hysteresis, the minimum-duration guard and
   * the counting — a regression in any of them shows up here rather than on
   * track. Only the car's lateral position is invented.
   *
   * The penalty count follows the warnings the way a race director would: one
   * penalty per full set of three, which is what makes the widget's two
   * differently-sourced numbers both reachable in a demo.
   */
  private buildTrackLimits(dt: number, speedKph: number): TrackLimitsState | undefined {
    this.limitsClockSec += dt;
    const period = SimulatorProvider.LIMITS_INTERVAL_SEC;
    if (this.limitsClockSec >= period) {
      this.limitsClockSec -= period;
      this.limitsCycle += 1;
    }

    const edge = SimulatorProvider.LIMITS_TRACK_EDGE_M;
    const off = this.limitsClockSec < SimulatorProvider.LIMITS_EXCURSION_SEC;
    // Drifting around mid-track normally; clearly past the threshold while
    // running wide.
    //
    // Derived from the tracker's own default rather than hard-coded: it was a
    // flat 2.2 m, which silently stopped counting anything the moment the
    // default margin moved from 1.0 to 2.4 — the demo went quietly clean and
    // took the widget's whole warning path out of reach with it. A metre past
    // whatever the threshold currently is cannot drift the same way.
    const lateral = off
      ? edge + DEFAULT_OFF_TRACK_MARGIN_M + 1.0
      : Math.sin(this.limitsClockSec * 0.9) * (edge * 0.4);

    // Every third demo excursion, the driver lifts — so the lift-to-negate path
    // and its "saved" feedback are reachable in demo mode too, not just the
    // path where the points land. Without this half the widget's states could
    // only be seen by running wide in a real session on purpose.
    const givesItBack = this.limitsCycle % 3 === 2;
    const throttle = off && givesItBack ? 0 : 0.9;

    const state = this.limits.update({
      pathLateralM: lateral,
      trackEdgeM: edge,
      speedKph,
      throttle,
      inPit: this.player().inPit,
      // The stewards' own count — one per full points limit, fed from last
      // poll's tally so the penalty lands the poll AFTER the infringement that
      // earned it, which is also how a real race director behaves.
      penalties: Math.floor(this.demoPoints / INSTANT_PENALTY_POINTS),
      sessionKey: 'demo',
      nowMs: Date.now(),
    });
    if (state) this.demoPoints = state.points;
    return state ?? undefined;
  }

  /** Points scored so far, mirrored so the demo's penalties can follow. */
  private demoPoints = 0;
  /** Which excursion of the cycle this is, so every third one is given back. */
  private limitsCycle = 0;

  /* -------------------------------- damage -------------------------------- */

  /**
   * Synthesises a repair-screen payload and runs it through the **real**
   * {@link decodeDamage}, exactly as {@link buildChassis} does with the chassis
   * tracker. Only the raw JSON is invented; every threshold, guard and unit
   * conversion the widget depends on is the live one.
   *
   * The demo cycles clean → damaged → clean on a slow phase so both states —
   * and the transition the widget has to survive — are reachable without
   * crashing a car into a wall. The damaged values are the ones actually
   * measured from a real impact (9.5% aero, 19.5% FR, 12.2% RR), so the demo
   * looks like the thing rather than like a designer's guess at it.
   */
  private buildDamage(): DamageState | null {
    // ~40 s clean, ~40 s damaged. `weatherPhase` advances at 0.02/s (see
    // advanceWeather), so the multiplier here is what sets the period:
    // 2π / (3.9 × 0.02) ≈ 80 s. Slow enough to read, fast enough that nobody
    // checking the widget has to wait minutes to see the other state.
    const damaged = Math.sin(this.weatherPhase * 3.9) > 0;
    if (!damaged) {
      return decodeDamage({
        wearables: {
          body: { aero: 0, detachableParts: [true, true, true, true] },
          suspension: [0, 0, 0, 0],
          brakes: [0.0356, 0.0356, 0.032, 0.032],
        },
        // On a clean car the sim really does offer a lone "N/A" here.
        pitMenu: { pitMenu: [{ name: 'DAMAGE:', currentSetting: 0, settings: [{ text: 'N/A' }] }] },
        pitStopTimes: { times: { FixAllDamage: 30, FixAeroDamage: 30 } },
        // Nothing selected, so the sim's bare stop length — measured at ~2 s.
        pitStopLength: { timeInSeconds: 2 },
      });
    }
    // Ramp the severity in over the damaged half so the bars move rather than
    // snapping, and the repair seconds track them the way the sim's do.
    //
    // Rounded to 4dp, NOT with round2: severity is a 0..1 fraction, so two
    // decimals is 1% granularity and the widget — which prints a tenth of a
    // percent — would show the ramp stepping in whole percent jumps and the
    // measured 9.5% arriving as 10.0%.
    const ramp = Math.min(1, Math.sin(this.weatherPhase * 3.9) * 2.2);
    const sev = (v: number): number => Math.round(v * ramp * 10000) / 10000;
    return decodeDamage({
      wearables: {
        body: { aero: sev(0.095), detachableParts: [true, false, true, true] },
        suspension: [0, sev(0.195), 0, sev(0.1215)],
        brakes: [0.0356, 0.0356, 0.032, 0.032],
      },
      pitMenu: {
        pitMenu: [
          {
            name: 'DAMAGE:',
            currentSetting: 2,
            settings: [{ text: 'Do Not Repair' }, { text: 'Repair Body' }, { text: 'Repair All' }],
          },
          // Two corners selected, so the tyre line is exercised too — and at a
          // count that resolves to TwoTireChange rather than the four-tyre one.
          { name: 'FL TIRE:', currentSetting: 1, settings: [{ text: 'No Change' }, { text: 'New Medium' }] },
          { name: 'FR TIRE:', currentSetting: 1, settings: [{ text: 'No Change' }, { text: 'New Medium' }] },
          { name: 'RL TIRE:', currentSetting: 0, settings: [{ text: 'No Change' }, { text: 'New Medium' }] },
          { name: 'RR TIRE:', currentSetting: 0, settings: [{ text: 'No Change' }, { text: 'New Medium' }] },
        ],
      },
      pitStopTimes: {
        times: {
          FixAllDamage: round2(30 + 5.1 * ramp),
          FixAeroDamage: 30,
          TwoTireChange: 4.5,
          FourTireChange: 12,
          // The caps on the delays the sim draws at stop time. Published here
          // so demo mode exercises the range line, which is the only part of
          // the widget describing something the sim will NOT tell us up front.
          FixRandomDelay: 5,
          RandomTireDelay: 1,
        },
      },
      // The sim publishes the total already summed — verified equal to
      // FixAllDamage + TwoTireChange on a live stop — so the demo sums it here
      // rather than leaving the field out, or the widget's headline would be
      // exercised against a payload shape the game never sends.
      pitStopLength: { timeInSeconds: round2(30 + 5.1 * ramp + 4.5) },
    });
  }

  /* ------------------------------- chassis -------------------------------- */

  /**
   * Synthesises a plausible four-corner load block from the same pedal/steer
   * state that drives {@link motionFor}, then puts it through the real
   * {@link ChassisTracker} rather than hand-rolling the ratios.
   *
   * Running the genuine decoder on synthetic input is the point: demo mode then
   * exercises the same thresholds, warm-up gate and reference average that the
   * live path uses, so a regression in any of them shows up here instead of
   * hiding until someone is on track. Only the *raw* numbers are invented.
   *
   * The model is deliberately simple — static weight, speed-squared downforce,
   * and load transfer proportional to G. It is not a vehicle dynamics model and
   * makes no claim to be; it exists so the widget has something honest-shaped
   * to render.
   */
  private buildChassis(motion: MotionState): ChassisState | null {
    /** Static wheel loads, N — a ~1300 kg GT3 plus driver, 45% on the front. */
    const STATIC_TOTAL_N = 12750;
    const FRONT_BIAS = 0.45;
    /** Downforce at 200 km/h, N. Scaled by v² from there. */
    const DOWNFORCE_AT_200_N = 4200;
    /** Share of total load moved per g. Nominal, matching expectedLeftShare(). */
    const LAT_TRANSFER_PER_G = 0.19;
    const LON_TRANSFER_PER_G = 0.14;
    /** Nominal wheel-rate, N/mm — turns a corner load into suspension travel. */
    const WHEEL_RATE_N_PER_MM = 165;
    /** Static ride height at rest, mm, before any deflection. */
    const STATIC_RIDE_MM = 78;

    const speedKph = motion.speedMs * 3.6;
    const downforceN = DOWNFORCE_AT_200_N * Math.pow(speedKph / 200, 2);
    const totalN = STATIC_TOTAL_N + downforceN;

    // Longitudinal: braking is POSITIVE lonG here (see decodeMotion), and
    // braking moves load onto the FRONT axle.
    const frontShare = clamp(FRONT_BIAS + motion.lonG * LON_TRANSFER_PER_G, 0.05, 0.95);
    // Lateral: positive latG is acceleration toward the car's RIGHT, i.e. a
    // right-hand corner, which loads the LEFT (outside) wheels.
    const leftShare = clamp(0.5 + motion.latG * LAT_TRANSFER_PER_G, 0.02, 0.98);

    // A kerb strike every so often, so the airborne/light paths are reachable
    // in demo mode instead of being dead code nobody ever sees run.
    const kerb = Math.sin(this.weatherPhase * 3.1) > 0.985 ? 0.12 : 1;

    const cornerN = (front: boolean, left: boolean): number => {
      const axle = front ? frontShare : 1 - frontShare;
      const side = left ? leftShare : 1 - leftShare;
      // Axle share times side share is a separable approximation of the real
      // 2-D distribution — exact only when the two transfers are independent,
      // which is close enough for a demo and keeps the four corners summing to
      // the total by construction.
      const n = totalN * axle * side * 4 * 0.25;
      return Math.max(0, n * (front && left ? kerb : 1));
    };

    const mk = (front: boolean, left: boolean): RawCorner => {
      const loadN = cornerN(front, left);
      const deflectionMm = loadN / WHEEL_RATE_N_PER_MM;
      return {
        loadN,
        deflectionM: deflectionMm / 1000,
        rideHeightM: Math.max(0, STATIC_RIDE_MM - deflectionMm * 0.55) / 1000,
        suspForceN: loadN * 0.92,
        // Grip falls away as the tyre is asked for more lateral force.
        gripFract: clamp01(1 - Math.abs(motion.latG) * 0.09 - Math.abs(motion.lonG) * 0.05),
      };
    };

    const raw: RawCornerSet = [mk(true, true), mk(true, false), mk(false, true), mk(false, false)];
    return this.chassisTracker.update(raw, this.clockSec);
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

  /* -------------------------------- radar -------------------------------- */

  /**
   * The car's forward (tangent) direction on the demo ellipse at its current lap
   * progress. Increasing progress runs anticlockwise, so this is the direction
   * of travel — what the player's radar treats as "ahead".
   */
  private forwardOf(progress: number): { x: number; z: number } {
    const theta = progress * TAU;
    // d/dtheta of (A·cosθ, B·sinθ) = (−A·sinθ, B·cosθ).
    return { x: -SIM_TRACK_A * Math.sin(theta), z: SIM_TRACK_B * Math.cos(theta) };
  }

  /**
   * A car's WORLD position on the demo ellipse. Each car is nudged off the
   * centre-line by a small, stable per-car lateral offset so the blips spread
   * left and right of the racing line instead of stacking on one axis — which is
   * what exercises the lateral half of the {@link buildRadar} projection.
   */
  private worldPosOf(car: SimCar): Vec3 {
    const theta = car.progress * TAU;
    const cx = SIM_TRACK_A * Math.cos(theta);
    const cz = SIM_TRACK_B * Math.sin(theta);
    const f = this.forwardOf(car.progress);
    const flen = Math.hypot(f.x, f.z) || 1;
    // Right = up × forward projected onto the ground = (fz, −fx)/|f|, matching
    // the LEFT-handed convention buildRadar() uses, so a positive offset shows up
    // as a blip to the car's right rather than mirrored.
    const rx = f.z / flen;
    const rz = -f.x / flen;
    // Stable ±~2.7 m offset from the slot id (0 for the player, on the line).
    const off = car.slotId === this.player().slotId ? 0 : (((car.slotId * 37) % 7) - 3) * 0.9;
    return { x: cx + rx * off, y: 0, z: cz + rz * off };
  }

  /**
   * Car-relative radar blips for the player, built by running the synthetic
   * field's world positions through the **real** {@link buildRadar} geometry —
   * the same discipline {@link buildChassis} and {@link buildDamage} use, so a
   * sign regression in the projection shows up in demo mode instead of hiding
   * until someone is on track. Only the positions are invented.
   */
  private buildRadarBlips(player: SimCar): RadarBlip[] | undefined {
    const ori = headingOri(this.forwardOf(player.progress));
    if (!ori) return undefined;
    const playerPos = this.worldPosOf(player);
    const cars: RadarCar[] = this.cars
      .filter((c) => c.slotId !== player.slotId)
      .map((c) => {
        const faster = isFasterClass(c.carClass, player.carClass);
        const car: RadarCar = { slotId: c.slotId, pos: this.worldPosOf(c), carClass: c.carClass };
        if (c.carNumber) car.carNumber = c.carNumber;
        if (faster) car.isFasterClass = true;
        else if (isFasterClass(player.carClass, c.carClass)) car.slowerClass = true;
        const down = player.lapsCompleted - c.lapsCompleted;
        if (down >= 1) car.lapsDown = down;
        return car;
      });
    return buildRadar({ playerPos, ori, cars }) ?? undefined;
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
      // Same call the live calculator makes: not enough to finish this lap and
      // get round again even saving hard, and a lap still to come afterwards.
      // Demo mode has to be able to show this — it is the loudest thing the
      // overlay ever does, and nobody should first meet it in a race.
      ...(lapsRemaining !== UNKNOWN_VALUE &&
      lapsRemaining >= 0 &&
      lapsToFinish > 1 &&
      lapsRemaining < 2 * 0.9 + 0.05
        ? { pitThisLap: true, pitThisLapReason: 'fuel' as const }
        : {}),
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
    const next = clamp01(Math.max(0, wave - 0.5) * 0.8);
    // Which way the surface is going, for the widget's trend arrow. The live
    // provider works this out over three minutes of history because the real
    // feed jitters; here the curve is smooth, so the sign of one step is enough.
    this.wetTrend =
      next > this.rainIntensity ? 'wetting' : next < this.rainIntensity ? 'drying' : 'steady';
    this.rainIntensity = next;
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
