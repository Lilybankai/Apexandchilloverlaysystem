/**
 * @file src/telemetry/types.ts
 * @module telemetry/types
 *
 * The **telemetry contract** for the Apex & Chill overlay system.
 *
 * This module is the single shared schema between the telemetry producers
 * (simulator provider, rFactor2 / Le Mans Ultimate shared-memory provider) and
 * every consumer (WebSocket broadcast + browser overlay widgets). A
 * {@link TelemetryFrame} is a fully **normalized**, source-agnostic snapshot of
 * the current on-track state; providers are responsible for mapping their raw
 * data (shared-memory structs, simulated values, …) into this shape so the
 * overlays never need to know which sim is running.
 *
 * ### Conventions
 * - All angles are in **degrees**, temperatures in **degrees Celsius**,
 *   distances/gaps in **seconds** unless the field name says otherwise
 *   (e.g. `*Kph`, `*Kpa`, `*Liters`).
 * - Normalized inputs (throttle, brake, wear, rain, …) are in the range
 *   **0..1** unless noted (steering is **-1..1**).
 * - Unknown / not-yet-available numeric values use **-1** (never `NaN` or
 *   `null`) so the wire format stays plain JSON and widgets can branch on a
 *   single sentinel.
 * - The schema is additive: new optional fields may be appended, but existing
 *   fields must not change meaning without bumping {@link TELEMETRY_SCHEMA_VERSION}.
 */

/**
 * Schema version of the {@link TelemetryFrame} wire format. Bump on any
 * breaking change so consumers can detect an incompatible producer.
 */
export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/** Sentinel used for unknown / not-yet-available numeric values. */
export const UNKNOWN_VALUE = -1 as const;

/* -------------------------------------------------------------------------- */
/*  Enumerations (string unions — cheap to serialize, self-describing)         */
/* -------------------------------------------------------------------------- */

/** Which producer generated a frame. */
export type TelemetrySource = 'simulator' | 'rf2' | 'lmu';

/** High-level session category. */
export type SessionType =
  | 'unknown'
  | 'testday'
  | 'practice'
  | 'qualifying'
  | 'warmup'
  | 'race';

/** Where the session currently is in its lifecycle. */
export type SessionPhase =
  | 'unknown'
  | 'garage'
  | 'gridwalk'
  | 'formation'
  | 'countdown'
  | 'green'
  | 'fullCourseYellow'
  | 'redFlag'
  | 'checkered'
  | 'cooldown';

/** Global flag state shown to the field. */
export type FlagState =
  | 'none'
  | 'green'
  | 'yellow'
  | 'doubleYellow'
  | 'blue'
  | 'white'
  | 'red'
  | 'checkered';

/** Coarse sky/precipitation descriptor for a weather slot. */
export type SkyState = 'clear' | 'partlyCloudy' | 'overcast' | 'lightRain' | 'rain' | 'storm';

/* -------------------------------------------------------------------------- */
/*  Session                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Session-wide state — the same for every car on track.
 */
export interface SessionState {
  /** Session category (practice / qualifying / race / …). */
  type: SessionType;
  /** Lifecycle phase (countdown / green / checkered / …). */
  phase: SessionPhase;
  /** Global flag currently displayed. */
  flag: FlagState;
  /** Human-readable track name, e.g. `"Silverstone (ELMS)"`. */
  track: string;
  /** Optional layout/config name when the track exposes one. */
  trackConfig?: string;
  /** Seconds remaining in a timed session; {@link UNKNOWN_VALUE} if lap-based. */
  timeRemainingSec: number;
  /** Total laps for a lap-based session; `0` when the session is timed. */
  totalLaps: number;
  /** Race leader's current lap number (1-based); {@link UNKNOWN_VALUE} if unknown. */
  currentLap: number;
  /** Number of cars/entries in the session. */
  numCars: number;
  /** Optional server / lobby name. */
  serverName?: string;
}

/* -------------------------------------------------------------------------- */
/*  Player car                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Raw driver input channels for the player's car.
 * These drive the pedal-input / trail-braking trace widget.
 */
export interface PedalInputs {
  /** Throttle application, `0` (lifted) .. `1` (flat). */
  throttle: number;
  /** Brake application, `0` (off) .. `1` (max). */
  brake: number;
  /** Clutch application, `0` (engaged) .. `1` (fully depressed). */
  clutch: number;
  /** Steering, `-1` (full left) .. `0` (centre) .. `1` (full right). */
  steer: number;
  /**
   * Traction-control intervention strength, `0` (none) .. `1` (fully cut):
   * how much throttle TC is currently taking away from the driver's input
   * (unfiltered − filtered). Omitted/`0` when the sim doesn't expose it.
   */
  tc?: number;
  /**
   * ABS intervention strength, `0` (none) .. `1` (fully released): how much
   * brake ABS is currently bleeding off the driver's input. Omitted/`0` when
   * the sim doesn't expose it.
   */
  abs?: number;
}

/** Player lap-timing readouts, all times in seconds. */
export interface LapTiming {
  /** Elapsed time on the current lap; {@link UNKNOWN_VALUE} if unknown. */
  current: number;
  /** Last completed lap time; {@link UNKNOWN_VALUE} if none yet. */
  last: number;
  /** Personal best lap this session; {@link UNKNOWN_VALUE} if none yet. */
  best: number;
  /**
   * Live delta to the reference lap (personal best), in seconds.
   * Negative = ahead / faster, positive = behind / slower.
   * {@link UNKNOWN_VALUE} when no reference exists.
   */
  delta: number;
  /** Current sector, `1`..`3`; {@link UNKNOWN_VALUE} if unknown. */
  sector: number;
}

/** State of a single tyre/corner. */
export interface TyreState {
  /** Representative (surface/core avg) temperature in °C. */
  tempC: number;
  /** Inner-shoulder temperature in °C, when available. */
  innerC?: number;
  /** Centre temperature in °C, when available. */
  middleC?: number;
  /** Outer-shoulder temperature in °C, when available. */
  outerC?: number;
  /** Cold/hot pressure in kPa, when available. */
  pressureKpa?: number;
  /** Remaining tread, `0` (worn out) .. `1` (fresh). */
  wear: number;
  /** Fitted compound label (e.g. `"Soft"`, `"Wet"`), when known. */
  compound?: string;
}

/** The four corners of the player's car. */
export interface TyreSet {
  frontLeft: TyreState;
  frontRight: TyreState;
  rearLeft: TyreState;
  rearRight: TyreState;
}

/**
 * State specific to the **player's** car (the spectated/driven entry).
 * Standings for the whole field live in {@link TelemetryFrame.standings}.
 */
export interface PlayerState {
  /** Stable per-session slot/entry id linking to a {@link StandingEntry}. */
  slotId: number;
  /** Current race position (1-based). */
  position: number;
  /** Driver input channels. */
  pedals: PedalInputs;
  /** Current gear: `-1` reverse, `0` neutral, `1..n` forward. */
  gear: number;
  /** Ground speed in km/h. */
  speedKph: number;
  /** Engine speed in RPM. */
  rpm: number;
  /** Rev-limiter / max usable RPM (for a shift-light bar). */
  maxRpm: number;
  /** Lap timing readouts. */
  lap: LapTiming;
  /** Four-corner tyre state. */
  tyres: TyreSet;
}

/* -------------------------------------------------------------------------- */
/*  Standings & relative                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One row in the **full-field standings** table (top-left widget).
 * Gaps are cumulative to the leader; for lapped cars use {@link lapsBehind}.
 */
export interface StandingEntry {
  /** Stable per-session slot/entry id. */
  slotId: number;
  /** Race position, 1-based. */
  position: number;
  /** Driver display name. */
  driverName: string;
  /** Car number as shown on the car, when available. */
  carNumber?: string;
  /** Car class label (e.g. `"LMGT3"`, `"Hypercar"`), when available. */
  carClass?: string;
  /** Gap to the leader in seconds; {@link UNKNOWN_VALUE} if lapped/unknown. */
  gapToLeaderSec: number;
  /** Gap to the car directly ahead in seconds; {@link UNKNOWN_VALUE} if unknown. */
  gapToAheadSec: number;
  /** Whole laps behind the leader (`0` on lead lap). */
  lapsBehind: number;
  /** Best lap this session in seconds; {@link UNKNOWN_VALUE} if none. */
  bestLapSec: number;
  /** Last lap in seconds; {@link UNKNOWN_VALUE} if none. */
  lastLapSec: number;
  /** Laps completed. */
  lapsCompleted: number;
  /** Whether the car is currently in the pit lane / stall. */
  inPit: boolean;
  /** Completed pit stops, when tracked. */
  pitStops?: number;
  /** Fitted tyre compound, when known. */
  tyreCompound?: string;
  /** `true` for the player's own row (for highlight). */
  isPlayer: boolean;
}

/**
 * One row in the **relative** widget (top-right): the cars physically nearest
 * to the player on track, ordered by on-track proximity, with a signed time
 * gap. This is distinct from {@link StandingEntry} which is ordered by race
 * position.
 */
export interface RelativeEntry {
  /** Stable per-session slot/entry id. */
  slotId: number;
  /** Race position, 1-based. */
  position: number;
  /** Driver display name. */
  driverName: string;
  /** Car number, when available. */
  carNumber?: string;
  /** Car class label, when available. */
  carClass?: string;
  /**
   * Signed on-track time gap to the player in seconds.
   * Positive = ahead of the player, negative = behind. `0` for the player row.
   */
  relativeGapSec: number;
  /** Whole laps difference vs the player (negative = lapped by player). */
  lapsDifference: number;
  /** Whether the car is in the pit lane. */
  inPit: boolean;
  /** `true` for the player's own row. */
  isPlayer: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Weather                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A single point in the weather **forecast** timeline shown by the weather
 * widget. Slot `minutesAhead === 0` represents current conditions.
 */
export interface WeatherForecastSlot {
  /** Minutes from now this slot describes (`0` = now). */
  minutesAhead: number;
  /** Probability of rain, `0`..`1`. */
  rainChance: number;
  /** Expected precipitation intensity, `0` (dry) .. `1` (heavy). */
  rainIntensity: number;
  /** Expected track temperature in °C. */
  trackTempC: number;
  /** Coarse sky descriptor. */
  sky: SkyState;
}

/**
 * Current weather plus a short forecast. Feeds the weather-forecast widget.
 */
export interface WeatherState {
  /** Current track surface temperature in °C. */
  trackTempC: number;
  /** Current ambient/air temperature in °C. */
  ambientTempC: number;
  /** Current precipitation intensity, `0` (dry) .. `1` (heavy). */
  rainIntensity: number;
  /** Current track wetness, `0` (dry) .. `1` (flooded). */
  trackWetness: number;
  /**
   * Forecast timeline (typically 5–6 slots, e.g. now/+5/+15/+30/+60 min).
   * Always includes a `minutesAhead === 0` "now" slot as the first element.
   */
  forecast: WeatherForecastSlot[];
}

/* -------------------------------------------------------------------------- */
/*  Fuel                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fuel state and strategy computed by the fuel calculator. Feeds the
 * fuel-calculator widget. All quantities are in **litres** unless the field
 * name says otherwise.
 */
export interface FuelState {
  /** Current fuel in the tank, litres. */
  levelLiters: number;
  /** Tank capacity, litres; {@link UNKNOWN_VALUE} if unknown. */
  capacityLiters: number;
  /** Rolling-average consumption per lap, litres; {@link UNKNOWN_VALUE} until enough laps. */
  perLapAvgLiters: number;
  /** Estimated laps remaining on current fuel; {@link UNKNOWN_VALUE} if unknown. */
  lapsRemaining: number;
  /** Laps still required to reach the finish; {@link UNKNOWN_VALUE} if unknown. */
  lapsToFinish: number;
  /** Litres needed to reach the finish; {@link UNKNOWN_VALUE} if unknown. */
  fuelToFinishLiters: number;
  /**
   * Fuel margin at the finish, litres: positive = surplus, negative = short.
   * {@link UNKNOWN_VALUE} if it cannot be estimated yet.
   */
  fuelDeltaLiters: number;
  /** Litres to add at the next stop to reach the finish (`0` if none needed). */
  refuelToFinishLiters: number;
  /** Earliest lap the pit window opens (enough fuel to finish); optional. */
  pitWindowOpenLap?: number;
}

/* -------------------------------------------------------------------------- */
/*  Top-level frame                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A complete, normalized telemetry snapshot broadcast to the overlays.
 * This is the object serialized as JSON over the WebSocket at the configured
 * update rate.
 */
export interface TelemetryFrame {
  /** Wire-format version; see {@link TELEMETRY_SCHEMA_VERSION}. */
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  /** Producer identity for this frame. */
  source: TelemetrySource;
  /** Producer wall-clock time (epoch ms) when the frame was generated. */
  timestamp: number;
  /**
   * `true` when a real sim is connected and feeding data; `false` when the
   * frame is simulated placeholder data. Lets overlays show a "DEMO" badge.
   */
  connected: boolean;
  /** Session-wide state. */
  session: SessionState;
  /** The player's car state. */
  player: PlayerState;
  /** Full field, ordered by race position. */
  standings: StandingEntry[];
  /** Cars nearest the player on track, ordered by proximity. */
  relative: RelativeEntry[];
  /** Current weather plus forecast. */
  weather: WeatherState;
  /** Fuel state and strategy for the player's car. */
  fuel: FuelState;
}

/**
 * Convenience type alias for a frame with any schema version, used at the
 * WebSocket boundary where a consumer may need to inspect the version before
 * trusting the rest of the shape.
 */
export type AnyTelemetryFrame = Omit<TelemetryFrame, 'schemaVersion'> & {
  schemaVersion: number;
};
