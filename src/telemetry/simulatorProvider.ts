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
/**
 * Total race laps for the simulated session.
 *
 * Thirty, not sixteen: at Hypercar pace that is a fifty-minute race, which is
 * long enough for the demo to need a real fuel stop in the middle of it (see
 * {@link START_FUEL_L}) and long enough that a launch video or a widget
 * layout session runs its whole length without the race ending underneath it.
 * When the leader does take the flag the demo starts a fresh race.
 */
const RACE_LAPS = 30;
/** Laps every car has already completed when the simulation starts. */
const START_LAPS = 3;
/**
 * Fuel in the tank at the start, litres. Sized so the demo driver has to stop
 * roughly ten minutes in: the fuel widget then counts a real window down, calls
 * the stop, and the stop that follows is the one the pit-lane phases are built
 * from — rather than a stop on a timer with a tank that never needed one.
 */
const START_FUEL_L = 22;
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
 * The demo circuit's corners: where each apex sits as a fraction of the lap,
 * how fast the car can carry through it (km/h), which way it turns, and how
 * long the arc is (metres of track spent at the apex speed).
 *
 * This table is the whole driver. The speed profile in {@link buildSpeedProfile}
 * is derived from it — flat out between corners, braking as late as the car
 * can for each apex — and everything the player's widgets show (speed, gear,
 * revs, throttle, brake, steering, G, delta) is read off that profile at the
 * car's lap position. Nothing here runs on a timer: a gear change happens
 * because the car reached the revs for it, a braking trace happens because a
 * corner is coming, and the same corner produces the same trace every lap.
 *
 * Speeds are Hypercar-shaped for a 5.9 km lap: two fast sweeps, a hairpin, a
 * couple of medium corners. Not a real circuit; see {@link buildDemoCircuit}.
 */
const CORNERS: ReadonlyArray<{ pos: number; apexKph: number; dir: 1 | -1; arcM: number }> = [
  { pos: 0.08, apexKph: 142, dir: 1, arcM: 90 },
  { pos: 0.21, apexKph: 200, dir: -1, arcM: 130 },
  { pos: 0.36, apexKph: 72, dir: 1, arcM: 55 },
  { pos: 0.5, apexKph: 210, dir: -1, arcM: 150 },
  { pos: 0.66, apexKph: 114, dir: 1, arcM: 80 },
  { pos: 0.82, apexKph: 130, dir: -1, arcM: 90 },
  { pos: 0.93, apexKph: 170, dir: 1, arcM: 100 },
];

/**
 * Corner exits where the demo driver runs wide now and then — the track-limits
 * charges come from here, at the exit of the corner, not from a clock. The
 * medium corner after the hairpin is the usual one (a wheel over the exit
 * kerb); the last corner rarely.
 */
const LIMITS_CORNERS: ReadonlyArray<{ corner: number; perLap: number; charge: number }> = [
  { corner: 4, perLap: 0.12, charge: 0.25 },
  { corner: 6, perLap: 0.03, charge: 0.5 },
];

/** Where the pit lane leaves and rejoins the lap, as fractions of it. */
const PIT_ENTRY_AT = 0.972;
const PIT_BOX_AT = 0.994;
const PIT_EXIT_AT = 0.028;
/** Pit-lane speed limit, km/h. */
const PIT_LANE_KPH = 60;
/** Refuelling rate, litres per second — the figure the strategy doc measured. */
const REFUEL_L_PER_SEC = 2.6;
/** A four-tyre change, seconds, the sim's own published figure. */
const FOUR_TYRES_SEC = 12;

/**
 * Road speed at the shift point in each gear, km/h, gears 1..7. The demo's
 * whole gearbox: revs are `speed / vmax[gear]` of the shift point, so the car
 * upshifts when it reaches these speeds and lands mid-range in the next gear,
 * and a downshift under braking brings the revs back up — a rev counter that
 * saws through the gears the way a real one does.
 */
const GEAR_MAX_KPH: readonly number[] = [0, 62, 122, 160, 196, 232, 266, 300];
/** Engine idle, rpm — what the counter shows in the box with the car in neutral. */
const SIM_IDLE_RPM = 2200;
/** Revs below which a braking car takes the next gear down. */
const SIM_RPM_DOWNSHIFT_AT = 4300;

/* ----------------------------- speed profile ----------------------------- */

/** Bins the lap is divided into for the speed profile. */
const PROFILE_BINS = 720;
/** Straight-line top speed, m/s (≈ 306 km/h). */
const V_MAX_MS = 76.5;
/** Full-throttle acceleration from rest, m/s², before drag. */
const ACCEL_A0 = 7.2;
/** Drag term, m/s² per (m/s)²: chosen so acceleration fades to ~0.5 m/s² at top speed. */
const ACCEL_K = (ACCEL_A0 - 0.5) / (V_MAX_MS * V_MAX_MS);
/** Peak braking deceleration, m/s² (≈ 1.7 g with the aero on). */
const BRAKE_A = 15;

/** Acceleration available at full throttle at speed `v` (m/s), m/s². */
function accelAt(v: number): number {
  return Math.max(0.3, ACCEL_A0 - ACCEL_K * v * v);
}

/**
 * The lap's speed profile: `v[i]` is the speed (m/s) in bin `i`, `tAt[i]` the
 * time from the line to the start of bin `i`, `lapSec` the whole lap.
 *
 * Built the way a race engineer's simulation does it: a speed ceiling from the
 * corner table (apex speed through each arc, top speed elsewhere), then a
 * forward pass that lets the car accelerate no faster than the engine allows,
 * then a backward pass that pulls speed down ahead of each corner no faster
 * than the brakes allow. Two rounds of both so the wrap at the line settles.
 */
interface SpeedProfile {
  v: Float64Array;
  tAt: Float64Array;
  lapSec: number;
  binM: number;
}

function buildSpeedProfile(): SpeedProfile {
  const n = PROFILE_BINS;
  const binM = DEMO_TRACK_LENGTH_M / n;
  const ceiling = new Float64Array(n).fill(V_MAX_MS);
  for (const c of CORNERS) {
    const half = c.arcM / 2 / DEMO_TRACK_LENGTH_M;
    const apex = c.apexKph / 3.6;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(wrapHalf(i / n - c.pos));
      if (d <= half) ceiling[i] = Math.min(ceiling[i] as number, apex);
    }
  }
  const v = Float64Array.from(ceiling);
  for (let round = 0; round < 2; round++) {
    // Forward: accelerate out of each corner.
    for (let k = 0; k < n; k++) {
      const i = k % n;
      const j = (i + 1) % n;
      const vi = v[i] as number;
      const reach = Math.sqrt(vi * vi + 2 * accelAt(vi) * binM);
      v[j] = Math.min(v[j] as number, reach, ceiling[j] as number);
    }
    // Backward: brake for each corner.
    for (let k = n - 1; k >= 0; k--) {
      const i = k % n;
      const h = (i - 1 + n) % n;
      const vi = v[i] as number;
      const reach = Math.sqrt(vi * vi + 2 * BRAKE_A * binM);
      v[h] = Math.min(v[h] as number, reach);
    }
  }
  const tAt = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) tAt[i + 1] = (tAt[i] as number) + binM / (v[i] as number);
  return { v, tAt, lapSec: tAt[n] as number, binM };
}

const PROFILE: SpeedProfile = buildSpeedProfile();
/** The profile's own lap time, seconds — exported so a test can pin it near the demo's pace. */
export const DEMO_PROFILE_LAP_SEC = PROFILE.lapSec;

/** Speed (m/s) at a lap fraction, linearly interpolated between bins. */
function profileSpeedAt(p: number): number {
  const x = (((p % 1) + 1) % 1) * PROFILE_BINS;
  const i = Math.floor(x) % PROFILE_BINS;
  const j = (i + 1) % PROFILE_BINS;
  return lerp(PROFILE.v[i] as number, PROFILE.v[j] as number, x - Math.floor(x));
}

/** Time from the line to a lap fraction on the profile lap, seconds. */
function profileTimeAt(p: number): number {
  const x = (((p % 1) + 1) % 1) * PROFILE_BINS;
  const i = Math.floor(x) % PROFILE_BINS;
  const frac = x - Math.floor(x);
  return (PROFILE.tAt[i] as number) + (frac * PROFILE.binM) / (PROFILE.v[i] as number);
}

/** Longitudinal acceleration the profile calls for at a lap fraction, m/s². */
function profileAccelAt(p: number): number {
  const step = 1 / PROFILE_BINS;
  const v0 = profileSpeedAt(p - step);
  const v1 = profileSpeedAt(p + step);
  // a = v · dv/ds
  return (profileSpeedAt(p) * (v1 - v0)) / (2 * step * DEMO_TRACK_LENGTH_M);
}

/**
 * Steering demand at a lap fraction, −1..1: each corner contributes a smooth
 * bell of lock around its apex, turned in a little before it and unwound after,
 * scaled by how tight the corner is.
 */
function steerAt(p: number): number {
  let steer = 0;
  for (const c of CORNERS) {
    const halfArc = c.arcM / 2 / DEMO_TRACK_LENGTH_M;
    // The lock is held for the arc and blended in/out over ~40 m each side.
    const blend = 40 / DEMO_TRACK_LENGTH_M;
    const d = Math.abs(wrapHalf(p - (c.pos - blend * 0.3)));
    let k = 0;
    if (d <= halfArc) k = 1;
    else if (d <= halfArc + blend) k = 1 - (d - halfArc) / blend;
    if (k <= 0) continue;
    const amp = clamp(1.05 - c.apexKph / 240, 0.18, 0.92);
    // Smooth the shoulders so the trace has no corners of its own.
    const s = k * k * (3 - 2 * k);
    steer += c.dir * amp * s;
  }
  return clamp(steer, -1, 1);
}

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

/**
 * The demo's own random source — a seeded generator, so two runs of demo mode
 * are the same race. That is what makes a layout session or a screen recording
 * repeatable, and what lets a test assert that a rare event (a track-limits
 * charge, a contact) happens where it did last time.
 */
let rngState = 0x9e3779b9;
function rnd(): number {
  // xorshift32 — plenty for picking lap noise and the odd incident.
  let x = rngState;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  rngState = x >>> 0;
  return rngState / 4294967296;
}
function resetRng(): void {
  rngState = 0x9e3779b9;
}

/** Small symmetric jitter in [-amp, amp]. */
function jitter(amp: number): number {
  return (rnd() * 2 - 1) * amp;
}

/**
 * Slow, band-limited noise: a value that wanders rather than flickers. Used for
 * the human in the driver — the throttle that is not quite steady on a straight,
 * the steering that corrects a little mid-corner — where per-frame jitter would
 * read as a fault in the feed rather than a hand on the wheel.
 */
class Wander {
  private value = 0;
  constructor(
    private readonly amp: number,
    private readonly tauSec: number,
  ) {}
  step(dt: number): number {
    // Ornstein–Uhlenbeck: pulled back to zero, kicked by noise scaled to dt.
    const pull = clamp(dt / this.tauSec, 0, 1);
    this.value += -this.value * pull + jitter(this.amp) * Math.sqrt(pull);
    return clamp(this.value, -this.amp, this.amp);
  }
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
  /**
   * The lap this car will stop at the end of (its pit entry comes on that
   * lap's last stretch), or −1 once it has stopped or if it never will.
   */
  pitLap: number;
  /** Seconds the car will stand in its box on its next stop. */
  stopSec: number;
  /** Seconds it has stood so far in the current stop, while stationary. */
  stoodSec: number;
  /** Where the car is in its pit visit. */
  pitPhase: PitPhase;
  /**
   * Traffic: how long this car has been held behind a slower car, and how
   * long it needs before it gets by. A pass takes laps of pressure, not one
   * frame of overlapping progress.
   */
  attackSec: number;
  attackNeedSec: number;
  /** The share of natural pace this frame after traffic and the pit lane, 0..1. */
  rateScale: number;
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
  private fuelLevel = START_FUEL_L;
  private readonly recentBurns: number[] = [];
  /** Count of player laps for which fuel has been burned (independent of the
   * 5-entry rolling `recentBurns` window). */
  private lapsBurned = 0;
  /** Player's driver-input state, smoothed frame-to-frame. */
  private pedals: PedalInputs = { throttle: 1, brake: 0, clutch: 0, steer: 0 };

  /* --- the driven car -------------------------------------------------------
   * The player's car is integrated, not sampled: speed follows the profile at
   * its lap position, the gear is a state that changes when the revs say so,
   * and the lap clock is the time actually spent. Everything the speedo, the
   * trace and the delta show comes from these few numbers.
   */
  /** Road speed, m/s. */
  private speedMs = 0;
  private gear = 1;
  /** Seconds since the last gear change — spaces a downshift sequence out. */
  private sinceShiftSec = 1;
  /** Time into the current lap, seconds. */
  private lapElapsedSec = 0;
  /** Time the current lap is being driven to, seconds — set at the line. */
  private lapTargetSec = BASE_LAP_SEC;
  /** Time the lap's braking zones were reached on the best lap, for the delta. */
  private bestLapScale = 1;
  /** The human: slow wander on throttle, brake and wheel. */
  private readonly throttleWander = new Wander(0.05, 0.6);
  private readonly steerWander = new Wander(0.03, 0.35);
  /** The player's next stop: litres to add and the crew's other jobs, or null. */
  private pitPlan: { fuelL: number; tyres: boolean; repair: boolean } | null = null;
  private tyreTemps = { fl: 78, fr: 80, rl: 82, rr: 84 };
  private tyreWear = { fl: 1, fr: 1, rl: 1, rr: 1 };
  /** Demo hybrid state of charge, 0..1. Stepped by {@link stepHybrid}. */
  private battery = 0.55;
  /** Demo electric motor torque, Nm, signed (+ deploy / − harvest). */
  private motorTorqueNm = 0;
  private rainIntensity = 0;
  /** Which way the demo track is going, for the weather widget's trend arrow. */
  private wetTrend: 'drying' | 'wetting' | 'steady' = 'steady';
  /** Starts on the dry side of the cycle: the first shower is half an hour off. */
  private weatherPhase = Math.PI / 0.12;
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
    resetRng();
    // Reset fuel state and seed a short burn history so the fuel widget shows
    // meaningful numbers from the very first frame (the level already reflects
    // these historical laps).
    this.fuelLevel = START_FUEL_L;
    this.recentBurns.length = 0;
    for (let i = 0; i < 3; i++) this.recentBurns.push(2.6 + jitter(0.1));
    this.lapsBurned = 0;
    this.pitPlan = null;
    this.speedMs = profileSpeedAt(0);
    this.gear = 7;
    this.sinceShiftSec = 1;
    this.lapElapsedSec = 0;
    this.lapTargetSec = BASE_LAP_SEC + jitter(0.3);
    this.bestLapScale = (BASE_LAP_SEC - 0.3) / PROFILE.lapSec;
    this.limitsFirstDone = false;
    this.weatherPhase = Math.PI / 0.12;
    this.rainIntensity = 0;
    this.demoContact = 0;
    this.yellowUntilSec = 0;
    this.yellowSector = 1;
    this.nextIncidentAtSec = 58;
    this.kerbNow = false;

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
        // Everyone stops once, spread over five laps around the player's own
        // window (which the fuel model sets — see advanceFieldCar). The player's
        // is decided by fuel, so it starts undecided.
        pitLap: i === PLAYER_INDEX ? -1 : START_LAPS + 5 + Math.floor(rnd() * 5),
        stopSec: 26 + rnd() * 8,
        stoodSec: 0,
        pitPhase: 'none',
        attackSec: 0,
        attackNeedSec: 0,
        rateScale: 1,
        driverBadge: SIM_BADGES[i % SIM_BADGES.length],
        driverRank: { rank: simRank.dr[0], tier: simRank.dr[1] },
        safetyRank: { rank: simRank.sr[0], tier: simRank.sr[1] },
      });
    }
    // The lap clock starts where the car starts, not at zero: the first lap
    // time is then a real lap, not the fraction left to the line.
    this.lapTargetSec = this.player().lapSec + jitter(0.3);
    this.lapElapsedSec = profileTimeAt(this.player().progress) * (this.lapTargetSec / PROFILE.lapSec);
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

    // The flag: once the leader has done the distance the demo starts the
    // same race again from the top (seeded, so it IS the same race), rather
    // than running on past the end with nothing left to count down.
    if (this.cars.some((c) => c.lapsCompleted >= RACE_LAPS)) this.start();

    this.clockSec += dt;
    this.sinceShiftSec += dt;
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
    const motion = this.motionFor();
    const chassis = this.buildChassis(motion);
    const damage = this.buildDamage();
    const pit = this.advancePit(damage);
    const trackLimits = this.buildTrackLimits();
    // Which pre-green phase the demo is in, or null once it has gone green.
    const preSession = this.advancePreSession(dt);
    const paceScore = this.buildPaceScore(player);

    // The live delta: time spent so far this lap against the time the best lap
    // had spent reaching the same point. It ramps as the lap is driven, wobbles
    // where traffic or the driver's hand cost a tenth, and blows up on a pit
    // lap — which is what a predictive delta does.
    const simDelta =
      Math.round((this.lapElapsedSec - profileTimeAt(player.progress) * this.bestLapScale) * 100) /
      100;
    const lastScale = player.lastLapSec / PROFILE.lapSec;
    const deltaToLast =
      Math.round((this.lapElapsedSec - profileTimeAt(player.progress) * lastScale) * 100) / 100;
    const paceDeltas: PaceDeltas = {
      tSession: simDelta,
      tAllTime: round2(simDelta + 0.21),
      tLast: deltaToLast,
      vSession: round2(simDelta * 0.9),
      vAllTime: round2(simDelta * 0.9 + 0.21),
      vLast: round2(deltaToLast * 0.9),
      predictedLapSec: round2(player.bestLapSec + simDelta),
      lapTimeSec: round2(this.lapElapsedSec),
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
        gear: this.gear,
        speedKph: Math.round(this.speedMs * 3.6),
        rpm: this.rpmNow(),
        maxRpm: SIM_MAX_RPM,
        lap: {
          current: this.lapElapsedSec,
          last: player.lastLapSec,
          best: player.bestLapSec,
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

  /** The player's lap position at the start of this frame, for edge detection. */
  private prevPlayerProgress = 0;
  /** Set while the player's inside wheels are over an exit kerb. */
  private kerbNow = false;

  /**
   * Advances every car around the lap and records completed laps.
   *
   * Three things make the field move like a race rather than like beads on a
   * string: a car does not drive through the one ahead of it (traffic holds it
   * up until it has earned the pass — see {@link trafficScale}), a pit visit is
   * a place on the lap the car slows into and stands still at, and the player
   * moves at the speed the driver model is actually doing.
   */
  private advanceField(dt: number): void {
    const player = this.player();
    this.prevPlayerProgress = player.progress;
    // Eased, so being caught behind someone is a lift, not a stamp on the brakes.
    for (const car of this.cars) {
      car.rateScale = lerp(car.rateScale, this.trafficScale(car, dt), clamp(dt / 0.8, 0, 1));
    }

    for (const car of this.cars) {
      const isPlayer = car === player;
      this.advancePitState(car, dt);
      if (car.pitPhase === 'stopped') {
        // Standing in the box.
      } else if (isPlayer) {
        car.progress += (this.speedMs * dt) / DEMO_TRACK_LENGTH_M;
      } else {
        // Every car drives the same profile — slow in the same corners, fast
        // on the same straights — at its own pace. A field of cars moving at
        // uniform rates against a player who brakes for corners would see the
        // gaps swing by seconds every lap and positions flip back and forth
        // with nobody having passed anyone.
        const lane = car.pitPhase !== 'none';
        const speedMs = lane
          ? PIT_LANE_KPH / 3.6
          : profileSpeedAt(car.progress) * (PROFILE.lapSec / car.lapSec) * car.rateScale;
        car.progress += (speedMs * dt) / DEMO_TRACK_LENGTH_M;
      }
      if (car.progress >= 1) {
        car.progress -= 1;
        car.lapsCompleted += 1;
        if (isPlayer) this.playerCrossedLine(car);
        else {
          // Fresh lap time with a little variance, around THIS car's own pace.
          const lap = car.lapSec + jitter(0.35) + (car.pitPhase !== 'none' ? 20 : 0);
          car.lastLapSec = lap;
          if (lap < car.bestLapSec) car.bestLapSec = lap;
        }
        // Burn a lap's worth of virtual energy — faster in the quicker classes,
        // which is what makes the energy-overlap readout meaningful.
        const drain = car.carClass === 'HYPERCAR' ? 0.055 : car.carClass === 'LMP2' ? 0.048 : 0.04;
        car.virtualEnergy = clamp01(car.virtualEnergy - drain + jitter(0.005));
      }
    }
  }

  /**
   * The player's line crossing: the lap time is the time actually spent, the
   * next lap gets its own target, fuel is burned, and the fuel model decides
   * whether this is the lap to stop on — the same rule the fuel widget lights
   * PIT THIS LAP on, so the call and the stop agree.
   */
  private playerCrossedLine(car: SimCar): void {
    // The overshoot past the line belongs to the new lap.
    const overshootSec = car.progress > 0 && this.speedMs > 1 ? (car.progress * DEMO_TRACK_LENGTH_M) / this.speedMs : 0;
    const lap = Math.max(1, this.lapElapsedSec - overshootSec);
    this.lapElapsedSec = overshootSec;
    car.lastLapSec = round2(lap);
    if (lap < car.bestLapSec && lap > BASE_LAP_SEC * 0.9 && car.pitPhase === 'none' && car.pitLap !== car.lapsCompleted - 1) {
      car.bestLapSec = round2(lap);
      this.bestLapScale = car.bestLapSec / PROFILE.lapSec;
    }
    // Next lap's pace: the car's own, a few tenths either way, and now and
    // then a lap with a mistake in it.
    this.lapTargetSec = car.lapSec + jitter(0.45) + (rnd() < 0.12 ? 0.9 + rnd() * 1.2 : 0);

    // Burn this lap's fuel here, before the stop decision reads the level.
    const burn = 2.6 + jitter(0.15);
    this.fuelLevel = Math.max(0, this.fuelLevel - burn);
    this.recentBurns.push(burn);
    if (this.recentBurns.length > 5) this.recentBurns.shift();
    this.lapsBurned += 1;

    // A brush with someone, now and then. Repaired at the stop.
    if (this.demoContact === 0 && car.lapsCompleted > START_LAPS + 1 && rnd() < 0.05) {
      this.demoContact = 0.4 + rnd() * 0.6;
    }

    // The stop call — the fuel widget's own rule (buildFuel), applied at the line.
    const perLap = this.recentBurns.reduce((a, b) => a + b, 0) / this.recentBurns.length;
    const fuelLaps = this.fuelLevel / perLap;
    const toFinish = RACE_LAPS - car.lapsCompleted;
    if (car.pitLap < 0 && car.pitStops === 0 && toFinish > 1 && fuelLaps < 2 * 0.9 + 0.05) {
      car.pitLap = car.lapsCompleted;
      const need = toFinish * perLap + 2 - this.fuelLevel;
      this.pitPlan = {
        fuelL: round1(clamp(need, 5, FUEL_CAPACITY_L - this.fuelLevel)),
        tyres: true,
        repair: this.demoContact > 0,
      };
    }
  }

  /**
   * How much of its natural pace a car runs this frame, given who is ahead.
   *
   * A faster car closing on a slower one is held at the slower car's pace once
   * it is within a second, and stays there for a spell — seconds for a faster
   * class lapping traffic, most of a lap or more for a same-class fight —
   * before it gets a run and goes by. Positions therefore change the way they
   * do on a timing screen: a gap that closes over laps, holds, then flips.
   */
  private trafficScale(car: SimCar, dt: number): number {
    if (car.pitPhase !== 'none') return 1;
    let ahead: SimCar | null = null;
    let gap = 1;
    for (const o of this.cars) {
      if (o === car || o.pitPhase !== 'none') continue;
      const d = wrapHalf(o.progress - car.progress);
      if (d > 0 && d < gap) {
        gap = d;
        ahead = o;
      }
    }
    if (!ahead) {
      car.attackSec = 0;
      return 1;
    }
    const gapSec = gap * BASE_LAP_SEC;
    // The pace each is ACTUALLY doing: the player's is the lap it is driving
    // to, which wanders a few tenths either side of its nominal.
    const paceOf = (c: SimCar): number => (c === this.player() ? this.lapTargetSec : c.lapSec);
    const myRate = 1 / paceOf(car);
    const theirRate = 1 / paceOf(ahead);
    if (myRate <= theirRate * 1.0005 || gapSec > 1.2) {
      car.attackSec = 0;
      car.attackNeedSec = 0;
      return 1;
    }
    if (car.attackNeedSec === 0) {
      car.attackNeedSec = isFasterClass(car.carClass, ahead.carClass) ? 3 + rnd() * 5 : 15 + rnd() * 45;
    }
    car.attackSec += dt;
    if (car.attackSec < car.attackNeedSec) {
      // Held: sit at the car ahead's pace, a touch slower if right on its tail.
      if (gapSec < 0.55) return (theirRate / myRate) * (gapSec < 0.35 ? 0.995 : 1);
      return 1;
    }
    // The move: a run at it until it is past.
    return 1.03;
  }

  /**
   * One car's pit visit, as places on the lap: into the lane on its pit lap,
   * to a standstill in the box for as long as the stop takes, then out along
   * the exit road and back to racing on the far side of the line.
   */
  private advancePitState(car: SimCar, dt: number): void {
    const isPlayer = car === this.player();
    switch (car.pitPhase) {
      case 'none':
        if (car.pitLap === car.lapsCompleted && car.progress >= PIT_ENTRY_AT) {
          car.pitPhase = 'entering';
          car.inPit = true;
        }
        break;
      case 'entering':
        if (car.progress >= PIT_BOX_AT) {
          car.pitPhase = 'stopped';
          car.stoodSec = 0;
          if (isPlayer) {
            const booked = this.plannedStop();
            // The crew's own delay, drawn at the stop like the sim's.
            car.stopSec = round1(booked.total + rnd() * booked.slack);
          }
        }
        break;
      case 'stopped':
        car.stoodSec += dt;
        if (car.stoodSec >= car.stopSec) {
          car.pitPhase = 'exiting';
          car.pitStops += 1;
          car.pitLap = -1;
          if (isPlayer) this.serviceDone();
        }
        break;
      case 'exiting':
        if (car.progress >= PIT_EXIT_AT && car.progress < 0.5) {
          car.pitPhase = 'none';
          car.inPit = false;
        }
        break;
      default:
        break;
    }
  }

  /** What the player's crew did: fuel in, fresh tyres, damage fixed. */
  private serviceDone(): void {
    if (this.pitPlan) {
      this.fuelLevel = Math.min(FUEL_CAPACITY_L, this.fuelLevel + this.pitPlan.fuelL);
      if (this.pitPlan.tyres) {
        this.tyreWear = { fl: 1, fr: 1, rl: 1, rr: 1 };
        this.tyreTemps = { fl: 68, fr: 68, rl: 66, rr: 66 };
      }
      if (this.pitPlan.repair) this.demoContact = 0;
    }
    this.pitPlan = null;
  }

  /**
   * The stop as booked: the sim's own arithmetic on the jobs — the longest of
   * refuelling and tyres, since the crew works in parallel, plus any repair,
   * which does not start until the car is serviced.
   */
  private plannedStop(): { total: number; refuel: number; tyres: number; fixAll: number; slack: number } {
    const plan = this.pitPlan;
    const perLap = this.recentBurns.length
      ? this.recentBurns.reduce((a, b) => a + b, 0) / this.recentBurns.length
      : 2.6;
    const toFinish = Math.max(0, RACE_LAPS - this.player().lapsCompleted);
    const fuelL = plan ? plan.fuelL : clamp(toFinish * perLap + 2 - this.fuelLevel, 0, FUEL_CAPACITY_L - this.fuelLevel);
    const refuel = round2(fuelL / REFUEL_L_PER_SEC);
    const tyres = plan ? (plan.tyres ? FOUR_TYRES_SEC : 0) : FOUR_TYRES_SEC;
    const fixAll = this.demoContact > 0 ? round2(30 + 5.1 * this.demoContact) : 0;
    return { total: round2(Math.max(refuel, tyres) + fixAll), refuel, tyres, fixAll, slack: 5 };
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
   * Drives the player's car for one frame.
   *
   * The speed the profile wants at this point of the lap (scaled for the lap
   * being driven and for any car it is stuck behind) is the target; the car
   * gets there with the acceleration the profile calls for plus a correction,
   * never faster than the engine can pull or the brakes can stop. Throttle and
   * brake are then whatever produces that acceleration, steering is the
   * corner's lock, and the gear changes when the revs reach the shift point
   * (up) or fall through the downshift point under braking (down). In the pit
   * lane the car sits on the limiter; in the box it is in neutral, idling.
   */
  private advanceDriverInputs(player: SimCar, dt: number): void {
    const p = player.progress;
    const phase = player.pitPhase;
    this.lapElapsedSec += dt;

    let throttle: number;
    let brake: number;
    let steer: number;
    let accel: number;

    if (phase === 'stopped') {
      this.speedMs = 0;
      this.gear = 0;
      accel = 0;
      throttle = 0;
      brake = 0;
      steer = 0;
    } else if (phase !== 'none') {
      // On the limiter down the lane.
      const target = PIT_LANE_KPH / 3.6;
      accel = clamp((target - this.speedMs) * 1.5, -8, 4);
      this.speedMs = Math.max(0, this.speedMs + accel * dt);
      throttle = this.speedMs < target - 0.5 ? 0.35 : 0.22;
      brake = accel < -1 ? clamp01(-accel / BRAKE_A) : 0;
      steer = 0;
      if (this.gear === 0) this.gear = 1;
      this.shiftFor(accel);
    } else {
      const scale = (PROFILE.lapSec / this.lapTargetSec) * player.rateScale;
      let target = profileSpeedAt(p) * scale;
      // On the pit lap, brake for the entry so the car meets the limiter at
      // the line rather than sailing in at racing speed.
      if (player.pitLap === player.lapsCompleted) {
        const distM = wrapHalf(PIT_ENTRY_AT - p) * DEMO_TRACK_LENGTH_M;
        if (distM > 0) {
          const laneV = PIT_LANE_KPH / 3.6;
          // Down to the limit a car-length before the line, not on it.
          target = Math.min(target, Math.sqrt(laneV * laneV + 2 * BRAKE_A * 0.8 * Math.max(0, distM - 20)));
        }
      }
      const wanted = profileAccelAt(p) * scale * scale + (target - this.speedMs) * 6;
      accel = clamp(wanted, -BRAKE_A, accelAt(this.speedMs));
      this.speedMs = Math.max(5, this.speedMs + accel * dt);

      const v = this.speedMs;
      if (accel >= 0) {
        // Enough throttle to make the acceleration against the drag at this
        // speed — measured against the lap being driven, so a driver a few
        // tenths off the profile is still flat where the profile is flat.
        throttle = clamp01((accel + ACCEL_K * v * v) / (ACCEL_A0 * scale * scale));
        // Flat is flat: a foot on the stop, not 97% of the way there.
        if (throttle > 0.97) throttle = 1;
        brake = 0;
      } else {
        throttle = 0;
        brake = clamp01(-accel / BRAKE_A);
      }
      steer = steerAt(p);
      // A driver holds a little throttle through an apex rather than coasting.
      if (brake === 0 && Math.abs(steer) > 0.3) throttle = Math.max(throttle, 0.16);
      // The human: a hand that is not quite steady when it is not pinned.
      if (throttle > 0.08 && throttle < 0.96) throttle = clamp01(throttle + this.throttleWander.step(dt));
      steer = clamp(steer + this.steerWander.step(dt) * (1 - Math.abs(steer) * 0.5), -1, 1);
      if (this.gear === 0) this.gear = 1;
      this.shiftFor(accel);

      // Exit kerbs at the two corners the driver uses them on.
      this.kerbNow = false;
      for (const idx of [0, 4]) {
        const c = CORNERS[idx]!;
        const exitAt = c.pos + c.arcM / 2 / DEMO_TRACK_LENGTH_M;
        const d = wrapHalf(p - exitAt) * DEMO_TRACK_LENGTH_M;
        if (d >= 0 && d < 22) this.kerbNow = true;
      }
    }

    // Smooth toward the target inputs — a foot and a hand, not a step function.
    const resp = clamp(dt * 14, 0, 1);
    const smThrottle = clamp01(lerp(this.pedals.throttle, throttle, resp));
    const smBrake = clamp01(lerp(this.pedals.brake, brake, resp));
    const smSteer = clamp(lerp(this.pedals.steer, steer, clamp(dt * 10, 0, 1)), -1, 1);

    // Driver aids: ABS chatters at the top of a hard stop from high speed; TC
    // trims the throttle when the power goes down with lock still on.
    const pulse = 0.55 + 0.45 * Math.sin(this.clockSec * 75);
    const abs =
      smBrake > 0.88 && this.speedMs > 35 ? clamp01((smBrake - 0.88) * 8) * pulse : 0;
    const tc =
      accel > 1.5 && smThrottle > 0.5 && Math.abs(smSteer) > 0.25
        ? clamp01((smThrottle - 0.5) * 2) * clamp01(Math.abs(smSteer) * 1.6) * pulse * 0.7
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

  /**
   * The gearbox: up a gear at the shift point when accelerating, down a gear
   * when the revs fall through the downshift point under braking — one at a
   * time, spaced like a paddle sequence, and never into a gear that would put
   * the engine over its limit.
   */
  private shiftFor(accel: number): void {
    const kph = this.speedMs * 3.6;
    const rpm = this.rpmNow();
    if (this.gear < 1) return;
    if (accel > 0.4 && rpm >= SIM_RPM_SHIFT_AT && this.gear < 7 && this.sinceShiftSec > 0.15) {
      this.gear += 1;
      this.sinceShiftSec = 0;
      return;
    }
    const wantsDown = (accel < -1 && rpm < SIM_RPM_DOWNSHIFT_AT) || rpm < 3200;
    if (wantsDown && this.gear > 1 && this.sinceShiftSec > 0.26) {
      const rpmBelow = (SIM_RPM_SHIFT_AT * kph) / (GEAR_MAX_KPH[this.gear - 1] as number);
      if (rpmBelow <= SIM_MAX_RPM) {
        this.gear -= 1;
        this.sinceShiftSec = 0;
      }
    }
  }

  /** Engine speed from road speed and gear; idle in neutral or at rest. */
  private rpmNow(): number {
    if (this.gear < 1 || this.speedMs < 0.5) return SIM_IDLE_RPM;
    const kph = this.speedMs * 3.6;
    const rpm = (SIM_RPM_SHIFT_AT * kph) / (GEAR_MAX_KPH[this.gear] as number);
    return Math.round(clamp(rpm, SIM_IDLE_RPM, SIM_MAX_RPM));
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

    // A driver adjusts the map now and then — a step every few minutes, not a
    // setting that flickers. `nowMs` is kept in the signature for the live
    // shape; the demo's own clock is what the cadence is read from.
    void nowMs;
    const tc = Math.floor(this.clockSec / 420) % 2 === 0 ? 7 : 5;
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
  private motionFor(): MotionState {
    const pedals = this.pedals;
    const speedMs = this.speedMs;
    // Steering to yaw rate via a plausible constant lock-to-rate gain. Real
    // cars vary with speed and load; a demo does not need to.
    const yawRate = round2(pedals.steer * 1.0);
    const latG = round2((speedMs * yawRate) / 9.80665);
    // Braking dominates longitudinal G, as it does in a real car — and is
    // POSITIVE here, matching the display convention decodeMotion() applies.
    const lonG = round2(pedals.brake * 1.65 - pedals.throttle * 0.55);
    // Vertical is ZERO-centred, matching what LMU actually publishes (gravity
    // is cancelled by the normal force, so flat ground reads ~0 — verified live
    // at 200 kph). A kerb is the one thing that moves it.
    const vertG = round2(this.kerbNow ? -0.32 : 0);
    // Attitude follows load transfer: nose dives under brakes, body rolls away
    // from the corner. Both lag the input slightly in reality; not modelled.
    const pitch = round2(pedals.throttle * 0.4 - pedals.brake * 1.9);
    const roll = round2(-pedals.steer * 2.2);
    // A little more slip than the yaw implies, so the readout is not pinned to
    // zero — a demo showing 0.0° forever looks broken rather than neutral.
    const slipAngle = round2(pedals.steer * 2.6);
    // Heading from the direction the demo circuit runs at this point of the
    // lap, so the compass turns with the corners rather than on its own.
    const n = DEMO_MAP.points.length;
    const i = Math.floor((((this.player().progress % 1) + 1) % 1) * n) % n;
    const a = DEMO_MAP.points[i]!;
    const b = DEMO_MAP.points[(i + 1) % n]!;
    const heading = round2((Math.atan2((b[0] as number) - (a[0] as number), (b[1] as number) - (a[1] as number)) * 180) / Math.PI);
    return {
      latG,
      lonG,
      vertG,
      yawRate,
      pitchRate: round2(-pedals.brake * 0.05),
      rollRate: round2(-pedals.steer * 0.06),
      pitch,
      roll,
      heading,
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
   * The player's pit block, read off the pit-lane state machine that
   * {@link advancePitState} runs on lap position: the entry marker counts down
   * over the last 900 m of the pit lap, goes negative past the commit point,
   * the limiter is on from just before the entry to just after the exit, and
   * the stop's countdown is the crew's booked time against time stood.
   */
  private advancePit(damage: DamageState | null): PitState {
    const player = this.player();
    const phase = player.pitPhase;
    const toEntryM = wrapHalf(PIT_ENTRY_AT - player.progress) * DEMO_TRACK_LENGTH_M;
    const onPitLap = player.pitLap === player.lapsCompleted;

    let entryDistM: number | undefined;
    if (phase === 'none' && onPitLap && toEntryM > 0 && toEntryM <= 900) entryDistM = Math.round(toEntryM);
    else if (phase === 'entering') entryDistM = Math.round(toEntryM);

    // On from the last car-lengths of the approach to the exit line.
    const limiterOn = phase !== 'none' || (onPitLap && toEntryM > 0 && toEntryM < 90);

    const extras = {
      ...(entryDistM !== undefined ? { entryDistM } : {}),
      limiterOn,
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
      elapsedSec: round1(player.stoodSec),
      plannedSec: damage ? damage.stopLengthSeconds : this.plannedStop().total,
      slackSec: damage ? damage.randomDelayMaxSeconds : UNKNOWN_VALUE,
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

  /** When the current sector yellow clears (demo clock), or 0 when green. */
  private yellowUntilSec = 0;
  /** Which sector the current yellow is in, 1..3. */
  private yellowSector = 1;
  /** Demo clock at which the next incident happens. */
  private nextIncidentAtSec = 58;

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
   * Incidents. Someone goes off on the opening lap — a sector-2 yellow forty
   * seconds after the green, which is when first-lap contact usually clears
   * itself — and after that a yellow somewhere every five to fifteen minutes,
   * held for twenty to forty seconds. The rail is green the rest of the time,
   * which is what it looks like for most of a real race.
   */
  private buildSectorFlags(dt: number): [FlagState, FlagState, FlagState] {
    void dt;
    const t = this.clockSec;
    if (this.yellowUntilSec > 0 && t >= this.yellowUntilSec) {
      this.yellowUntilSec = 0;
      this.nextIncidentAtSec = t + 300 + rnd() * 600;
    }
    if (this.yellowUntilSec === 0 && t >= this.nextIncidentAtSec) {
      this.yellowSector = this.nextIncidentAtSec === 58 ? 2 : 1 + Math.floor(rnd() * 3);
      this.yellowUntilSec = t + (this.nextIncidentAtSec === 58 ? 25 : 20 + rnd() * 20);
    }
    const flags: [FlagState, FlagState, FlagState] = ['none', 'none', 'none'];
    if (this.yellowUntilSec > 0) flags[this.yellowSector - 1] = 'yellow';
    return flags;
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

  /** The allowance the demo counts down from — LMU's own observed default. */
  private static readonly LIMITS_ALLOWANCE = 5;

  /** Whether the opening-lap wide moment has happened yet. */
  private limitsFirstDone = false;
  /** The demo's running total, its charge history and its penalty count. */
  private demoPoints = 0;
  private demoCharges: number[] = [];
  private demoCharged = 0;
  private demoPenalties = 0;
  /** When the last demo charge landed, ms, or 0 before the first one. */
  private demoChargeAt = 0;
  /** Demo clock when the outstanding penalty was earned, to serve it a lap on. */
  private demoPenaltyAtSec = 0;
  /** Severity of the damage the car is carrying, 0 clean .. 1 the measured hit. */
  private demoContact = 0;
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
   * A charge happens where one would: at the exit of a corner the driver uses
   * all of, on the laps they use a little more than all of it
   * ({@link LIMITS_CORNERS}). The first pass after the green is always one —
   * cold tyres — so the widget's flash is seen early; after that it is a
   * wheel over the line every few laps, and the allowance is a real
   * accounting that would take most of a race to spend.
   */
  private buildTrackLimits(): TrackLimitsState | undefined {
    const nowMs = Date.now();
    const player = this.player();
    if (player.pitPhase === 'none') {
      for (const rule of LIMITS_CORNERS) {
        const c = CORNERS[rule.corner]!;
        const exitAt = ((c.pos + (c.arcM / 2 + 15) / DEMO_TRACK_LENGTH_M) % 1 + 1) % 1;
        const crossed =
          (this.prevPlayerProgress < exitAt && player.progress >= exitAt) ||
          (this.prevPlayerProgress > player.progress && exitAt <= player.progress);
        if (!crossed) continue;
        const forced = !this.limitsFirstDone && rule.corner === 4 && this.clockSec > 20;
        if (!forced && rnd() >= rule.perLap) continue;
        this.limitsFirstDone = true;
        const charge = rule.charge;
        // Rounded on every step, like the reader: 0.25 + 0.5 is
        // 0.7500000000000001 in floating point, and that would reach the
        // overlay verbatim.
        this.demoPoints = Math.round((this.demoPoints + charge) * 100) / 100;
        this.demoCharges = [charge, ...this.demoCharges].slice(0, 5);
        this.demoCharged += 1;
        this.demoChargeAt = nowMs;

        // The allowance spent earns a drive-through, and the sim starts the
        // account again — the same discharge the trace reader mirrors.
        if (this.demoPoints >= SimulatorProvider.LIMITS_ALLOWANCE) {
          this.demoPenalties += 1;
          this.demoPenaltyAtSec = this.clockSec;
          this.demoPoints = 0;
          this.demoCharges = [];
          this.demoCharged = 0;
        }
      }
    }

    // The penalty is served on the following lap.
    if (this.demoPenalties > 0 && this.clockSec - this.demoPenaltyAtSec > BASE_LAP_SEC) {
      this.demoPenalties = 0;
    }

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
    const booked = this.plannedStop();
    // The pit menu as the driver has it set: tyres booked for the stop, the
    // repair only when there is something to repair.
    const tyre = (on: boolean) => ({
      currentSetting: on ? 1 : 0,
      settings: [{ text: 'No Change' }, { text: 'New Medium' }],
    });
    const tyresOn = this.pitPlan ? this.pitPlan.tyres : true;
    const times = {
      FixAllDamage: booked.fixAll || 30,
      FixAeroDamage: 30,
      TwoTireChange: 4.5,
      FourTireChange: FOUR_TYRES_SEC,
      // The caps on the delays the sim draws at stop time. Published so the
      // widget's range line — the only part describing something the sim will
      // NOT say up front — has something to show.
      FixRandomDelay: booked.slack,
      RandomTireDelay: 1,
    };
    if (this.demoContact === 0) {
      return decodeDamage({
        wearables: {
          body: { aero: 0, detachableParts: [true, true, true, true] },
          suspension: [0, 0, 0, 0],
          brakes: [0.0356, 0.0356, 0.032, 0.032],
        },
        pitMenu: {
          pitMenu: [
            // On a clean car the sim really does offer a lone "N/A" here.
            { name: 'DAMAGE:', currentSetting: 0, settings: [{ text: 'N/A' }] },
            { name: 'FL TIRE:', ...tyre(tyresOn) },
            { name: 'FR TIRE:', ...tyre(tyresOn) },
            { name: 'RL TIRE:', ...tyre(tyresOn) },
            { name: 'RR TIRE:', ...tyre(tyresOn) },
          ],
        },
        pitStopTimes: { times },
        pitStopLength: { timeInSeconds: Math.max(2, booked.total) },
      });
    }
    // Carrying damage from a brush with someone. The figures are the measured
    // ones from a real impact (9.5% aero, 19.5% FR, 12.2% RR), scaled by how
    // hard this one was. Rounded to 4dp: severity is a 0..1 fraction and the
    // widget prints a tenth of a percent.
    const sev = (v: number): number => Math.round(v * this.demoContact * 10000) / 10000;
    return decodeDamage({
      wearables: {
        body: { aero: sev(0.095), detachableParts: [true, this.demoContact < 0.7, true, true] },
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
          { name: 'FL TIRE:', ...tyre(tyresOn) },
          { name: 'FR TIRE:', ...tyre(tyresOn) },
          { name: 'RL TIRE:', ...tyre(tyresOn) },
          { name: 'RR TIRE:', ...tyre(tyresOn) },
        ],
      },
      pitStopTimes: { times },
      pitStopLength: { timeInSeconds: booked.total },
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

    // Over the exit kerb: the inside front goes light for the length of it.
    const kerb = this.kerbNow ? 0.12 : 1;

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

  /**
   * Rain at a point on the weather cycle. Mostly dry: a light shower for a
   * few minutes out of every three-quarters of an hour, which is enough for
   * the widget's wet branch to be seen in a long session without the demo
   * spending half its life in the rain.
   */
  private static rainAt(phase: number): { wave: number; intensity: number } {
    const wave = Math.sin(phase * 0.12);
    return { wave, intensity: clamp01(Math.max(0, wave - 0.8) * 1.4) };
  }

  private advanceWeather(dt: number): void {
    this.weatherPhase += dt * 0.02;
    const next = SimulatorProvider.rainAt(this.weatherPhase).intensity;
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
      const phase = this.weatherPhase + minutesAhead * 60 * 0.02;
      const { wave, intensity } = SimulatorProvider.rainAt(phase);
      const chance = clamp01(0.1 + Math.max(0, wave) * 0.5);
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
