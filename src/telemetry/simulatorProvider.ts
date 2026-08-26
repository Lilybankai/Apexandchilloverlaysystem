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
  type MfdAid,
  type MotionState,
  type PaceDeltas,
  type PaceScoreState,
  type PedalInputs,
  type FlagState,
  type PitPhase,
  type PitState,
  type SessionPhase,
  type RadarBlip,
  type RelativeEntry,
  type StandingEntry,
  type TelemetryFrame,
  type TrackLimitsState,
  type TrackMapState,
  type TyreState,
  type WeatherForecastSlot,
} from './types';
import { assignClassPositions, copyClassPositions, isFasterClass } from './carClass';
import { predictLapsToFlag } from './lapsToFlag';
import { referenceCredit, scoreLap } from './referencePace';
import { buildRadar, headingOri, type RadarCar } from './radar';
import type { Vec3 } from './motion';
import { ChassisTracker } from './chassis';
import type { RawCorner, RawCornerSet } from './chassis';
import { decodeDamage } from './damage';
import { TrackLimitsTracker } from './trackLimits';
import { getPublishedTrackMap, setPublishedTrackMap, type TrackMapPath } from './trackMap';
import { shouldWarnTraffic, shouldYield } from './yieldAlert';

/* --------------------------------- config --------------------------------- */

/** Number of cars in the synthetic field. */
const FIELD_SIZE = 12;
/** Total race laps for the simulated session. */
const RACE_LAPS = 16;
/** Laps every car has already completed when the simulation starts. */
const START_LAPS = 3;
/**
 * Nominal lap time in seconds before per-car pace offset and noise.
 *
 * This is Hypercar race pace at the circuit the demo names below, taken from the
 * reference table. It used to be a round 118, which meant the demo claimed to be
 * at Silverstone while running 15% off Silverstone pace — invisible until the
 * pace score started comparing the two and put the whole synthetic field in the
 * Offline band. Only the absolute value moved; every relative behaviour in here
 * comes from the class offsets, which are unchanged in shape.
 */
const BASE_LAP_SEC = 102.9;
/**
 * The circuit the demo pretends to be at.
 *
 * Named constants rather than literals inline because the pace score resolves a
 * real reference row from these three values: change the track here without the
 * length, and the demo silently stops scoring while still looking perfect.
 */
const DEMO_TRACK = 'Silverstone (ELMS)';
const DEMO_TRACK_CONFIG = 'Grand Prix';
const DEMO_TRACK_LENGTH_M = 5890;

/**
 * The demo circuit the track map draws — a closed curve with corners and
 * elevation, scaled so its perimeter really is {@link DEMO_TRACK_LENGTH_M}.
 *
 * Built rather than copied from a real circuit, and not called Silverstone
 * anywhere on the shape: this is invented geometry, and a map that claimed to be
 * a real lap of Silverstone while being a lissajous would be the one piece of
 * demo data an operator could mistake for the real thing. The harmonics give it
 * a hairpin, two fast sweeps and a straight; the elevation gives the 2.5-D view
 * something to lift, which is the whole point of the widget and would be invisible
 * on a flat ring.
 */
const DEMO_MAP: TrackMapPath = buildDemoCircuit();

/**
 * Generates {@link DEMO_MAP}. The radius harmonics are what make it read as a
 * circuit; the two-pass scaling is what makes its perimeter come out at the lap
 * length the rest of the demo claims (a shape whose points are metres apart by a
 * factor of three would make the ribbon's width look absurd).
 */
function buildDemoCircuit(): TrackMapPath {
  const TAU_ = Math.PI * 2;
  const n = 720;
  const shape = (t: number): { x: number; z: number; y: number } => {
    const a = t * TAU_;
    // Phase-shifted so `t = 0` — the start/finish line — lands on a smooth
    // stretch. Without the shift the harmonics stack into a point exactly there,
    // and the demo map showed its start line on a spike no circuit has.
    const r = 1 + 0.26 * Math.sin(3 * a + 1.15) + 0.11 * Math.cos(5 * a + 0.5) - 0.05 * Math.sin(7 * a);
    return {
      x: r * Math.cos(a),
      z: r * Math.sin(a) * 0.72, // squashed, so it is a circuit and not a flower
      y: 0.035 * Math.sin(2 * a + 0.7) + 0.018 * Math.sin(5 * a),
    };
  };
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = shape(i / n);
    const b = shape((i + 1) / n);
    perimeter += Math.hypot(b.x - a.x, b.z - a.z);
  }
  const scale = DEMO_TRACK_LENGTH_M / perimeter;
  const points: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = shape(i / n);
    points.push([
      Math.round(p.x * scale * 10) / 10,
      Math.round(p.z * scale * 10) / 10,
      Math.round(p.y * scale * 10) / 10,
    ]);
  }
  return {
    key: 'demo-circuit',
    name: 'Demo Circuit',
    lengthM: DEMO_TRACK_LENGTH_M,
    halfWidthM: 6,
    binM: DEMO_TRACK_LENGTH_M / n,
    points,
    builtAt: new Date(0).toISOString(),
    revision: 1,
  };
}
/**
 * Class definitions for the synthetic field: how many cars, and how much slower
 * than {@link BASE_LAP_SEC} that class runs.
 *
 * The pace **spread between classes is the point**. It used to be a flat
 * `i * 0.35`, which put the whole 12-car field inside 4 seconds — so the classes
 * were cosmetic labels and no faster-class car ever actually caught a slower one.
 * Anything keyed on real multiclass behaviour (the blue-flag alert, class gaps,
 * lapping) therefore never triggered in demo mode and could not be seen without
 * the sim running.
 *
 * The offsets are no longer estimated: they are the real class-to-class gaps at
 * {@link DEMO_TRACK} out of the reference table, which is a slightly WIDER
 * spread than the hand-picked ~11 s it replaced (15.6 s Hypercar to GT3). Faster
 * classes therefore catch slower ones a little sooner in demo mode, which is the
 * direction that exercises the blue-flag path more, not less.
 */
const SIM_CLASSES: Array<{ name: string; count: number; lapOffsetSec: number }> = [
  { name: 'HYPERCAR', count: 3, lapOffsetSec: 0 },
  { name: 'LMP2', count: 3, lapOffsetSec: 3.8 },
  { name: 'LMP3', count: 3, lapOffsetSec: 8.4 },
  { name: 'GT3', count: 3, lapOffsetSec: 15.6 },
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

/**
 * The demo car's rev range. Named rather than inlined because the three numbers
 * only make sense together: the shift point has to sit inside the Speedo
 * widget's own shift band (98.5% of max) or the demo can never show a shift
 * light, and the post-shift figure has to drop clear of the red band or every
 * gear would spend its whole length flashing.
 */
const SIM_MAX_RPM = 8600;
/** Where the demo car upshifts — inside the shift band, deliberately. */
const SIM_RPM_SHIFT_AT = 8560;
/** Where the revs land after an upshift: mid-range, well clear of amber. */
const SIM_RPM_AFTER_SHIFT = 5600;

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
  /** Profile badge, as on {@link StandingEntry.driverBadge}; most cars none. */
  driverBadge?: string;
  /** DR rank badge, as on {@link StandingEntry.driverRank}. */
  driverRank?: { rank: string; tier: number };
  /** SR rank badge, as on {@link StandingEntry.safetyRank}. */
  safetyRank?: { rank: string; tier: number };
}

/**
 * Badges sprinkled over the demo grid so both tables exercise the badge slot —
 * sparse (most `undefined`) because that is the live shape: on a real server
 * the unbadged driver is the common case. Indexed by car slot, cycling.
 */
const SIM_BADGES: Array<string | undefined> = [
  undefined,
  'sr-clean',
  undefined,
  undefined,
  'sr-rookie',
  undefined,
  'sr-saint',
  undefined,
  undefined,
  'sr-warning',
  undefined,
  undefined,
];

/**
 * DR/SR rank badges for the demo grid — every car gets both, because on a real
 * server every human carries both (the live shape verified 2026-08-10: 21/21
 * drivers resolved). Spread across the whole Bronze→Platinum range so the
 * artwork set is exercised.
 */
const SIM_RANKS: Array<{ dr: [string, number]; sr: [string, number] }> = [
  { dr: ['Bronze', 3], sr: ['Gold', 1] },
  { dr: ['Silver', 1], sr: ['Platinum', 3] },
  { dr: ['Gold', 2], sr: ['Silver', 2] },
  { dr: ['Bronze', 1], sr: ['Bronze', 0] },
  { dr: ['Platinum', 1], sr: ['Platinum', 2] },
  { dr: ['Silver', 2], sr: ['Gold', 3] },
  { dr: ['Bronze', 3], sr: ['Silver', 1] },
  { dr: ['Gold', 1], sr: ['Gold', 2] },
  { dr: ['Silver', 3], sr: ['Platinum', 1] },
  { dr: ['Bronze', 2], sr: ['Gold', 1] },
  { dr: ['Platinum', 2], sr: ['Platinum', 3] },
  { dr: ['Silver', 1], sr: ['Silver', 3] },
];

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
  /** Demo hybrid state of charge, 0..1. Stepped by {@link stepHybrid}. */
  private battery = 0.55;
  /** Demo electric motor torque, Nm, signed (+ deploy / − harvest). */
  private motorTorqueNm = 0;
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
      const simRank = SIM_RANKS[i % SIM_RANKS.length]!;
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
        driverBadge: SIM_BADGES[i % SIM_BADGES.length],
        driverRank: { rank: simRank.dr[0], tier: simRank.dr[1] },
        safetyRank: { rank: simRank.sr[0], tier: simRank.sr[1] },
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
    // The relative panel quotes the standings' own class positions rather than
    // counting its own — see copyClassPositions.
    copyClassPositions(standings, relative);
    const radar = this.buildRadarBlips(player);
    const trackMap = this.buildTrackMap(player);
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
    const trackLimits = this.buildTrackLimits(dt);
    // Which pre-green phase the demo is in, or null once it has gone green.
    const preSession = this.advancePreSession(dt);
    const paceScore = this.buildPaceScore(player);

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
    // The demo field is multiclass on purpose (SIM_CLASSES), so it is the one
    // harness where a class-leader lap differs from the overall one — which is
    // exactly the case the standings strip has to get right.
    const classLeader = this.cars
      .filter((c) => c.carClass === player.carClass)
      .reduce((a, b) => (this.total(b) > this.total(a) ? b : a), player);
    // The demo classes are given real pace offsets (SIM_CLASSES), so this is the
    // one harness where the class prediction visibly differs from the leader's
    // lap total — which is exactly what makes it worth exercising here.
    const toFlag = predictLapsToFlag({
      totalLaps: RACE_LAPS,
      timeRemainingSec: UNKNOWN_VALUE,
      leaderLapsCompleted: leader.lapsCompleted,
      leaderPaceSec: leader.lapSec,
      paceSec: classLeader.lapSec,
    });

    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      source: 'simulator',
      timestamp: nowMs,
      connected: false,
      session: {
        type: 'race',
        phase: preSession ?? 'green',
        flag: preSession ? 'none' : 'green',
        track: DEMO_TRACK,
        trackConfig: DEMO_TRACK_CONFIG,
        timeRemainingSec: UNKNOWN_VALUE,
        totalLaps: RACE_LAPS,
        lapsRemaining: toFlag.estimated ? toFlag.laps : UNKNOWN_VALUE,
        currentLap: Math.min(RACE_LAPS, leader.lapsCompleted + 1),
        classLeaderLap: Math.min(RACE_LAPS, classLeader.lapsCompleted + 1),
        numCars: this.cars.length,
        serverName: 'Apex & Chill — Midweek Endurance',
        notStarted: preSession !== null,
        scheduledLengthSec: SimulatorProvider.DEMO_SESSION_LENGTH_SEC,
        // The demo driver never opens a menu — and auto show/hide must never
        // blank a layer someone is previewing in demo mode.
        onTrack: true,
        // The start gantry walks its five reds through the demo countdown —
        // one lamp a second, like a standing start — so the widget's lamp
        // strip can be laid out without booting the sim. LMU keeps the
        // channel published (frame 0) outside the sequence, so the demo does
        // too. Frame 6 (= lights out) shows for the first beat of green.
        startLights: this.buildStartLights(preSession, dt),
        sectorFlags: this.buildSectorFlags(dt),
      },
      player: {
        slotId: player.slotId,
        position: this.positionOf(player),
        pedals: { ...this.pedals },
        motion,
        gear: this.gearFor(this.pedals),
        speedKph: this.speedFor(this.pedals),
        rpm: this.rpmFor(this.pedals),
        maxRpm: SIM_MAX_RPM,
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
        // The demo car is a Hypercar, so it carries the channel and the real
        // gating shape is exercised: `hybrid` is a PRESENT block whose charge
        // swings all the way down, never an omitted one — which is what a GT3
        // would produce, and is the branch the widget hides its gauge on.
        hybrid: {
          chargeFraction: round2(this.battery),
          motorTorqueNm: Math.round(this.motorTorqueNm * 10) / 10,
        },
        ...(trackLimits ? { trackLimits } : {}),
        ...(paceScore ? { paceScore } : {}),
      },
      standings,
      relative,
      ...(radar ? { radar } : {}),
      trackMap,
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
      mfd: { pit: [], aids: this.buildAids(nowMs) },
    };
  }

  /**
   * The demo's pace score, against the same reference table the live path uses.
   *
   * Demo mode is how the overlay gets developed without the sim running (see the
   * dev harnesses), so this is not decoration: without it the Reference Pace
   * widget could only ever be seen in its empty state. The demo's identity —
   * Silverstone Grand Prix, and an LMP2 with no model name — deliberately lands
   * on the `assumed` branch, because the ELMS/WEC fallback is the one hedge the
   * widget has to render and would otherwise never be exercised.
   */
  private buildPaceScore(player: SimCar): PaceScoreState | undefined {
    const identity = {
      track: DEMO_TRACK,
      trackConfig: DEMO_TRACK_CONFIG,
      trackLengthM: DEMO_TRACK_LENGTH_M,
      carClass: player.carClass,
    };
    const credit = referenceCredit();
    const base: PaceScoreState = {
      ok: false,
      lapSec: Math.round(player.bestLapSec * 100) / 100,
      ...(credit
        ? { credit: { author: credit.author, title: credit.title, sheetUrl: credit.sheetUrl } }
        : {}),
    };
    const scored = scoreLap({ ...identity, lapMs: Math.round(player.bestLapSec * 1000) });
    if (!scored.ok || !scored.score) {
      return {
        ...base,
        ...(scored.reason ? { reason: scored.reason } : {}),
        ...(scored.detail ? { detail: scored.detail } : {}),
      };
    }
    const s = scored.score;
    return {
      ...base,
      ok: true,
      percent: s.percent,
      bandId: s.bandId,
      bandLabel: s.bandLabel,
      deltaSec: s.deltaSec,
      refSec: Math.round(s.refMs / 10) / 100,
      ...(s.hotlapMs ? { hotlapSec: Math.round(s.hotlapMs / 10) / 100 } : {}),
      layoutName: s.layoutName,
      circuitName: s.circuitName,
      sheetClass: s.sheetClass,
      via: s.via,
      assumed: s.assumed,
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

    this.stepHybrid(dt, smThrottle, smBrake);
  }

  private gearFor(pedals: PedalInputs): number {
    return SimulatorProvider.gearBand(this.speedFor(pedals)).gear;
  }

  private speedFor(pedals: PedalInputs): number {
    // Fast on throttle, slow under braking; smooth mid-range.
    const base = lerp(115, 255, clamp01(pedals.throttle * (1 - pedals.brake)));
    return Math.round(base - pedals.brake * 40);
  }

  /**
   * Which gear a speed is in, and the speed band that gear spans.
   *
   * One table, consulted by both {@link gearFor} and {@link rpmFor}, because the
   * whole point of the rev model below is that the revs and the gear agree — two
   * copies of these edges would eventually drift and produce a car that upshifts
   * somewhere other than where it hits the limiter.
   */
  private static gearBand(speedKph: number): { gear: number; lo: number; hi: number } {
    const EDGES = [0, 70, 110, 150, 190, 230, 265];
    for (let i = 0; i < EDGES.length - 1; i++) {
      if (speedKph < (EDGES[i + 1] as number) || i === EDGES.length - 2) {
        return { gear: i + 2, lo: EDGES[i] as number, hi: EDGES[i + 1] as number };
      }
    }
    return { gear: 7, lo: 230, hi: 265 };
  }

  /**
   * Engine speed, derived from where the car is **within its current gear**.
   *
   * It used to be a straight function of throttle position, which meant the demo
   * car's revs never sawtoothed and never came near the limiter: they sat at
   * 8400 of 8600 whenever it was flat, so the Speedo's shift band — the widget's
   * single most important state — was unreachable without a sim running. That is
   * the same defect as a battery pinned at one rail: the gauge looks alive while
   * the one thing it exists for can never happen.
   *
   * Now the revs climb through each gear's speed band and drop on the upshift,
   * which is what a rev counter does and what makes the shift light testable.
   */
  private rpmFor(pedals: PedalInputs): number {
    const speed = this.speedFor(pedals);
    const band = SimulatorProvider.gearBand(speed);
    const through = clamp01((speed - band.lo) / Math.max(1, band.hi - band.lo));
    return Math.round(lerp(SIM_RPM_AFTER_SHIFT, SIM_RPM_SHIFT_AT, through));
  }

  /**
   * The demo Hypercar's battery: spent on throttle, harvested on the brakes.
   *
   * Deliberately NOT a decorative sine wave. The point of the Speedo's battery
   * gauge is that deployment and harvesting read as a cycle tied to what the
   * driver is doing, so the demo has to produce that cycle — a gauge swinging on
   * its own timer would look identical while hiding the one bug that matters, a
   * deploy/harvest sign the wrong way round.
   */
  private stepHybrid(dt: number, throttle: number, brake: number): void {
    /**
     * Peak rates. The equilibrium these settle at is set by the TAPERS below,
     * not by these numbers being balanced against the demo lap — which matters,
     * because balancing them by hand was tried and got it wrong in both
     * directions: a harvest rate merely "bigger than" the deploy rate ran the
     * pack flat inside a minute, and correcting that pinned it at 100% for 43%
     * of a stint. Both look like a working gauge on a broken car.
     */
    const DEPLOY_PER_SEC = 0.09;
    const HARVEST_PER_SEC = 0.16;
    const PEAK_MOTOR_NM = 380;

    /**
     * Both flows taper toward their own rail: you cannot deploy charge that is
     * not there, and you cannot harvest into a pack that is full. That is what a
     * real ERS does, and it also makes the demo **self-limiting** — the charge
     * has a stable equilibrium strictly inside 0..1 wherever the duty cycle
     * happens to sit, so it keeps cycling without either end being tuned for. A
     * hard cut at each rail has no such equilibrium: it drifts until it hits a
     * rail and then sits there.
     */
    const deploy = throttle * DEPLOY_PER_SEC * this.battery;
    const harvest = brake * HARVEST_PER_SEC * (1 - this.battery);
    this.battery = clamp01(this.battery + (harvest - deploy) * dt);

    // Signed, matching the live channel: positive drives the car, negative
    // recharges. Normalised on the peak deploy rate and clamped, so it reads as
    // a torque rather than as whatever the rate constants happen to be.
    const nm = ((deploy - harvest) / DEPLOY_PER_SEC) * PEAK_MOTOR_NM;
    this.motorTorqueNm = clamp(nm, -PEAK_MOTOR_NM, PEAK_MOTOR_NM);
  }

  /**
   * The demo's live driving-aid settings.
   *
   * Aids only — the pit menu stays empty, because it is a read/write mirror of a
   * real menu and fabricating rows would give the MFD widget buttons that write
   * to a sim that is not there. The aids are pure readout, and without them the
   * Speedo's TC / TC-power / TC-slip chips and the MFD's aid section could only
   * ever be seen in their empty state — which is exactly the gap demo mode
   * exists to close.
   *
   * TC steps between two maps on a slow cycle. A driver really does change it
   * mid-stint, and it is the only way the change glow on a discrete setting is
   * reachable without a wheel plugged in; the cycle is long enough (45 s) that
   * it reads as someone adjusting rather than as a value that flickers.
   *
   * The list is deliberately NOT filtered by the demo player's class (an LMP2,
   * which the live path would veto slip, ABS and the prototype rows for — see
   * `telemetry/aidAvailability`). Demo mode's whole job here is to make every
   * row and chip visible without a sim; class fidelity is the live path's.
   */
  private buildAids(nowMs: number): MfdAid[] {
    const step = (key: string, label: string, value: number, maxValue: number): MfdAid => ({
      key,
      label,
      value,
      minValue: 0,
      maxValue,
      text: `${value}/${maxValue}`,
    });

    const tc = Math.floor(nowMs / 45000) % 2 === 0 ? 7 : 5;
    return [
      {
        key: 'BRAKE_BIAS',
        label: 'Brake Bias',
        value: 54,
        minValue: 0,
        maxValue: 100,
        text: '54.0:46.0',
      },
      step('tc', 'Traction Control', tc, 11),
      step('tcSlip', 'TC Slip', 4, 9),
      step('tcCut', 'TC Power Cut', 6, 9),
      step('abs', 'ABS', 9, 9),
      // The Hypercar aids. Rendered in the sim's OWN words rather than as an
      // index, because that is what the live path produces once the garage
      // endpoint names the step — a demo showing "6/15" where the real thing
      // shows "P6" would hide a formatting regression rather than expose it.
      { key: 'motorMap', label: 'Motor Map', value: 7, minValue: 0, maxValue: 10, text: '140kW' },
      {
        key: 'brakeMigration',
        label: 'Brake Migration',
        value: 2,
        minValue: 0,
        maxValue: 5,
        text: '1.5% F',
      },
      { key: 'frontARB', label: 'Front ARB', value: 6, minValue: 0, maxValue: 15, text: 'P6' },
      { key: 'rearARB', label: 'Rear ARB', value: 1, minValue: 0, maxValue: 15, text: 'P1' },
      // Regen has no shared-memory source on the live path either — it comes
      // from the garage endpoint, so the demo publishes it the same shape.
      { key: 'regen', label: 'Regen', value: 10, minValue: 0, maxValue: 10, text: '200kW' },
    ];
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

  /**
   * The demo's optimal tyre temperature, °C.
   *
   * On the live path this is read from the sim per compound and per event
   * (`optimalCompoundConditions`), never assumed. The simulator has no sim to
   * ask, so it states a plausible GT3-medium figure — the same 92 °C LMU
   * published for the car this was built against — purely so the widget's
   * in-window logic has something to render against in the demo.
   */
  private static readonly DEMO_OPTIMAL_C = 92;

  private buildTyres() {
    const r1 = (v: number): number => Math.round(v * 10) / 10;
    // Carcass and liner lag the surface and sit a little cooler; the inner
    // shoulder runs hottest, as it does on a car with negative camber. Enough
    // structure for the tyre map to look like a tyre map without pretending to
    // be a tyre model.
    const mk = (tempC: number, wear: number): TyreState => ({
      tempC: r1(tempC),
      surfaceTempC: r1(tempC + 4),
      coreC: r1(tempC - 1.5),
      innerC: r1(tempC + 3),
      middleC: r1(tempC),
      outerC: r1(tempC - 2),
      surfaceInnerC: r1(tempC + 8),
      surfaceMiddleC: r1(tempC + 4),
      surfaceOuterC: r1(tempC + 1),
      pressureKpa: r1(165 + (tempC - 82) * 0.4),
      // Discs track brake work an order of magnitude above the tyre: enough
      // for the pit-wall corner widget to show a live brake number in demo.
      brakeTempC: r1(240 + (tempC - 82) * 6 + this.pedals.brake * 220),
      wear: Math.round(wear * 1000) / 1000,
      compound: 'Medium',
      optimalTempC: SimulatorProvider.DEMO_OPTIMAL_C,
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

    // The race-control extras, on the same cycle: the pit entry approaches at
    // a demo-realistic 22 m/s for the last half-kilometre before `enterAt`,
    // goes negative past the commit point, and disappears in between — exactly
    // the envelope the marker widget has to handle. The limiter comes on just
    // before the entry and off just after the exit, so both prompt edges are
    // reachable in demo mode.
    const APPROACH_MPS = 22;
    const toEntrySec = enterAt - t;
    const entryDistM =
      toEntrySec < 25 && toEntrySec > -lane
        ? Math.round(toEntrySec * APPROACH_MPS)
        : undefined;
    const extras = {
      ...(entryDistM !== undefined ? { entryDistM } : {}),
      limiterOn: t > enterAt - 4 && t < releaseAt + lane * 0.6,
    };

    if (phase !== 'stopped') {
      return {
        phase,
        working: false,
        elapsedSec: UNKNOWN_VALUE,
        plannedSec: UNKNOWN_VALUE,
        slackSec: UNKNOWN_VALUE,
        ...extras,
      };
    }
    return {
      phase,
      working: true,
      elapsedSec: round1(t - stopAt),
      plannedSec: this.pitWork ? this.pitWork.plannedSec : UNKNOWN_VALUE,
      slackSec: this.pitWork ? this.pitWork.slackSec : UNKNOWN_VALUE,
      ...extras,
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

  /** Clock for the demo's periodic sector yellow; independent of the pit cycle. */
  private flagClockSec = 0;

  /**
   * The demo gantry: dark until the countdown phase, one red per second
   * through it (the standing-start cadence the live probe could not produce),
   * and lights-out — frame `total + 1` — for the first two seconds of green.
   */
  private buildStartLights(
    preSession: SessionPhase | null,
    dt: number,
  ): { frame: number; total: number } {
    const t = this.preSessionClockSec;
    const countdownFrom = 15; // PRE_SESSION: countdown runs 15..20 s
    if (preSession === 'countdown') {
      return { frame: Math.max(1, Math.min(5, 1 + Math.floor(t - countdownFrom))), total: 5 };
    }
    if (preSession === null) {
      // Its own clock: preSessionClockSec freezes at the changeover, so "just
      // went green" cannot be read off it.
      this.greenClockSec += dt;
      if (this.greenClockSec < 2) return { frame: 6, total: 5 };
    }
    return { frame: 0, total: 5 };
  }

  /** Seconds since the demo went green; drives the two-second lights-out frame. */
  private greenClockSec = 0;

  /**
   * A sector-2 yellow for twelve seconds out of every ninety, so the flag rail
   * has both states in demo without a car having to crash for it.
   */
  private buildSectorFlags(dt: number): [FlagState, FlagState, FlagState] {
    this.flagClockSec += dt;
    const m = this.flagClockSec % 90;
    const yellow = m >= 40 && m < 52;
    return ['none', yellow ? 'yellow' : 'none', 'none'];
  }

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
   * How often the demo driver picks up a charge, seconds. Frequent enough that
   * the widget's flash, its charge strip and the audio cue can all be seen
   * without waiting around; slow enough that the panel is mostly showing its
   * clean state, which is what it will be doing for most of a real stint.
   */
  private static readonly LIMITS_INTERVAL_SEC = 35;
  /**
   * The charges the demo cycles through, points.
   *
   * The sim's own vocabulary: quarter-point multiples, from a wheel over the line
   * to a cut worth a whole point. Cycling rather than random keeps the demo
   * reproducible, and covers both the amounts the flash has to render (`0.25`,
   * `1`) and the arithmetic that trips on floats (`0.25 + 0.5 + 0.25`).
   */
  private static readonly LIMITS_CHARGES = [0.25, 0.5, 0.25, 1, 0.5, 2];
  /** The allowance the demo counts down from — LMU's own observed default. */
  private static readonly LIMITS_ALLOWANCE = 5;

  /** Seconds since the last demo charge. */
  private limitsClockSec = 0;
  /** Which charge of the cycle comes next. */
  private limitsCycle = 0;
  /** The demo's running total, its charge history and its penalty count. */
  private demoPoints = 0;
  private demoCharges: number[] = [];
  private demoCharged = 0;
  private demoPenalties = 0;
  /** When the last demo charge landed, ms, or 0 before the first one. */
  private demoChargeAt = 0;
  /**
   * The real penalty tracker, fed the demo's penalty count — so the timestamps
   * the widget flashes on (`msSincePenalty`, `msSinceServed`) come out of the
   * same code the live path uses rather than being faked alongside it.
   */
  private readonly limits = new TrackLimitsTracker();

  /**
   * Fabricates what the trace reader would publish on LMU: a running total, the
   * charges behind it, and the drive-through the allowance eventually earns.
   *
   * Invented outright rather than run through a tracker, because there is no
   * longer anything to exercise — the stewards' figures are read, not derived,
   * and the demo's job here is to drive the *widget* through all of its states
   * (clean, a fresh charge, an allowance nearly spent, a penalty) without anyone
   * having to run wide in a real session on purpose.
   */
  private buildTrackLimits(dt: number): TrackLimitsState | undefined {
    const nowMs = Date.now();
    this.limitsClockSec += dt;
    if (this.limitsClockSec >= SimulatorProvider.LIMITS_INTERVAL_SEC) {
      this.limitsClockSec -= SimulatorProvider.LIMITS_INTERVAL_SEC;
      const charges = SimulatorProvider.LIMITS_CHARGES;
      const charge = charges[this.limitsCycle % charges.length]!;
      this.limitsCycle += 1;
      // Rounded on every step, like the reader: 0.25 + 0.5 is 0.7500000000000001
      // in floating point, and that would reach the overlay verbatim.
      this.demoPoints = Math.round((this.demoPoints + charge) * 100) / 100;
      this.demoCharges = [charge, ...this.demoCharges].slice(0, 5);
      this.demoCharged += 1;
      this.demoChargeAt = nowMs;

      // The allowance spent earns a drive-through, and the sim starts the
      // account again — the same discharge the trace reader mirrors.
      if (this.demoPoints >= SimulatorProvider.LIMITS_ALLOWANCE) {
        this.demoPenalties += 1;
        this.demoPoints = 0;
        this.demoCharges = [];
        this.demoCharged = 0;
      }
    }

    // The demo serves its penalty a lap or so later, so the "PENALTY SERVED"
    // path is reachable too.
    if (this.demoPenalties > 0 && this.limitsClockSec > 12) this.demoPenalties = 0;

    const state = this.limits.update({
      penalties: this.demoPenalties,
      sessionKey: 'demo',
      pointsLimit: SimulatorProvider.LIMITS_ALLOWANCE,
      nowMs,
    });
    if (!state) return undefined;
    return {
      ...state,
      points: this.demoPoints,
      charges: [...this.demoCharges],
      charged: this.demoCharged,
      msSinceCharge: this.demoChargeAt ? nowMs - this.demoChargeAt : UNKNOWN_VALUE,
      pointsLimitEnforced: true,
      // The live validity verdict rides the same cycle: each demo charge voids
      // the lap, then the stewards "restore" it — both edges of the real
      // countLapFlag behaviour, on a clock a fixture can catch. Held past the
      // widget's 4 s evaluation window so the demo walks BOTH chip stages:
      // EVALUATING first, the hardened LAP INVALID after.
      lapValid: this.demoChargeAt !== 0 && nowMs - this.demoChargeAt < 7000 ? false : true,
    };
  }

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
        driverBadge: car.driverBadge,
        driverRank: car.driverRank,
        safetyRank: car.safetyRank,
        virtualEnergy: round2(car.virtualEnergy),
        gapToLeaderSec: lapsBehind >= 1 ? UNKNOWN_VALUE : behindTotal * refLap,
        gapToAheadSec: Math.max(0, gapToAheadSec),
        lapsBehind,
        bestLapSec: car.bestLapSec,
        lastLapSec: car.lastLapSec,
        // Cumulative S1/S2 boundaries so demo mode exercises the engineer's
        // sector callout — 28 / 63 % of the lap, a believable GT3 split.
        lastSector1Sec: round2(car.lastLapSec * 0.28),
        lastSector2Sec: round2(car.lastLapSec * 0.63),
        // Close to the last lap with a small steady offset — enough for the
        // optional AVG column to render distinctly from LAST in demo mode.
        avg5Sec: round2(car.lastLapSec + 0.12),
        lapsCompleted: car.lapsCompleted,
        // Demo mode already runs on a continuous progress scale, so the class
        // maths gets the same exact laps-down count the sims give it.
        lapFraction: Math.round(clamp(car.progress, 0, 1) * 10000) / 10000,
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
        driverBadge: car.driverBadge,
        driverRank: car.driverRank,
        safetyRank: car.safetyRank,
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

  /* ------------------------------- track map ------------------------------ */

  /**
   * The demo circuit, and the field's progress round it.
   *
   * Unlike every other block here this one does NOT go through the live path's
   * machinery, and that is deliberate. {@link TrackMapBuilder} learns a circuit
   * from the driven car's world positions, and demo mode's positions live on the
   * small radar ellipse ({@link SIM_TRACK_A}) — a 630 m ring that exists to keep
   * synthetic cars inside radar range, not to be a track. Feeding it to the
   * learner would draw a fat donut and label it 5.9 km. So the demo publishes a
   * shape of its own, once, and places its cars on it by lap fraction — which
   * has the side benefit of being the exact path a spectated session takes (no
   * shared memory, no world positions), so demo mode exercises the fallback the
   * widget must never get wrong rather than the easy case.
   */
  private buildTrackMap(player: SimCar): TrackMapState {
    if (getPublishedTrackMap()?.key !== DEMO_MAP.key) setPublishedTrackMap(DEMO_MAP);
    return {
      key: DEMO_MAP.key,
      revision: DEMO_MAP.revision,
      ready: true,
      progress: 1,
      cars: this.cars.map((c) => ({
        slotId: c.slotId,
        lapFraction: Math.round(clamp(c.progress, 0, 1) * 10000) / 10000,
        inPit: c.inPit,
        isPlayer: c.slotId === player.slotId,
      })),
    };
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
      const trackTempC = Math.round((30 + Math.sin(phase) * 1.5 - intensity * 6) * 10) / 10;
      return {
        minutesAhead,
        rainChance: Math.round(chance * 100) / 100,
        rainIntensity: Math.round(intensity * 100) / 100,
        trackTempC,
        // The live path fills these from LMU's forecast nodes; the demo keeps
        // them plausible so the Team weather card renders its full shape.
        airTempC: Math.round((trackTempC - 6) * 10) / 10,
        humidityPct: Math.round(clamp01(0.45 + chance * 0.4) * 100),
        windKph: Math.round(12 + wave * 8),
        sky,
      };
    });
  }
}
