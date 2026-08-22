/**
 * @file src/telemetry/lmuRestProvider.ts
 * @module telemetry/lmuRestProvider
 *
 * Live telemetry provider for **Le Mans Ultimate** using its built-in **REST
 * API** (the same one behind the local Swagger UI at `http://localhost:6397`).
 *
 * ## Why the REST API instead of shared memory
 * LMU changes its shared-memory struct layout between updates, so the fixed
 * byte-offsets a shared-memory reader needs are fragile and version-sensitive.
 * The REST API, by contrast, returns clean, self-describing JSON that is stable
 * across updates and — crucially for a **broadcast/directing** setup — exposes
 * the *whole field* (every car's timing, gaps, fuel, flags), not just the car
 * being driven on this PC.
 *
 * ## What it reads
 * - `GET /rest/watch/standings`  — array of every car: driver, team, number,
 *   class, position, best/last lap + sectors, gaps, laps, pit state, flags,
 *   fuel fraction, on-track lap distance, and which car currently has broadcast
 *   focus.
 * - `GET /rest/watch/sessionInfo` — session type/phase, track name + length,
 *   temps, rain/wetness, event time + laps, flags.
 *
 * These fully drive the **standings, relative/timing, weather and fuel** widgets
 * (the broadcast-critical ones). Pedal inputs and tyre temperatures are physics
 * channels the REST API does not expose for a spectated car, so those fields are
 * left unknown here (see the notes on {@link buildPlayer}).
 *
 * ## Robustness
 * The HTTP polling runs on its own interval and caches the latest good payload;
 * {@link poll} is synchronous and simply projects the cached data into a
 * {@link TelemetryFrame}. If the API is unreachable or the data goes stale, the
 * provider transparently falls back to the {@link SimulatorProvider} so the
 * overlays keep running (flagged as demo) instead of freezing.
 */

import http from 'node:http';
import type { TelemetryProvider } from './provider';
import { SimulatorProvider } from './simulatorProvider';
import { FuelCalculator, resolvePitCall } from './fuelCalculator';
import {
  LmuLocalCarReader,
  type AidSettings,
  type LocalCarPhysics,
  type RadarField,
} from './lmuLocalCar';
import { LmuScoringReader, type ScoringCar } from './lmuScoring';
import { TrackLimitsTracker } from './trackLimits';
import { LmuTraceLimitsReader } from './lmuTraceLimits';
import { PaceAverageTracker } from './paceAverage';
import { buildRadar, type RadarCar } from './radar';
import { TrackMapBuilder } from './trackMap';
import {
  TELEMETRY_SCHEMA_VERSION,
  UNKNOWN_VALUE,
  isPreGreen,
  type FlagState,
  type FuelState,
  type RadarBlip,
  type RelativeEntry,
  type SessionPhase,
  type SessionState,
  type SessionType,
  type PaceDeltas,
  type PaceScoreState,
  type SkyState,
  type StandingEntry,
  type TelemetryFrame,
  type TyreState,
  type WeatherForecastSlot,
  type WeatherState,
  type DamageState,
  type PitPhase,
  type PitState,
  type MfdState,
  type TrackLimitsState,
  type TrackMapCar,
  type TrackMapState,
} from './types';
import { decodeDamage, type RawRepairPayload } from './damage';
import { buildMfdState, type RawGarageVal, type RawPitRow } from './mfdControl';
import {
  EMPTY_PACE_DELTAS,
  LocalPaceDeltaTracker,
  RoadPosition,
  refKeyOf,
  type LapValidity,
} from './paceDelta';
import { referenceCredit, referenceFor, scoreLap } from './referencePace';
import { LapRecorder, appendLap, type LapRecord } from './lapLog';
import { fingerprintGarageData } from './setupFingerprint';
import {
  LapTraceRecorder,
  pruneTraces,
  writeTrace,
  type CompletedTrace,
  type TraceChannels,
} from './lapTrace';
import { assignClassPositions, isFasterClass, lapFractionOf, normalizeClass } from './carClass';
import { shouldWarnTraffic, shouldYield } from './yieldAlert';
import { RaceosRanksClient, type DriverRanks } from './raceosRanks';

/** Config subset this provider needs. */
export interface LmuRestConfig {
  /** Localhost port the LMU REST API listens on (default 6397). */
  lmuApiPort?: number;
  verbose: boolean;
}

/** Default LMU REST API port (the game's built-in web server). */
const DEFAULT_API_PORT = 6397;
/** How often to pull the REST endpoints (ms). ~6–7 Hz is plenty for timing. */
const REFRESH_INTERVAL_MS = 150;
/** Treat cached data older than this as stale → fall back to the simulator. */
const STALE_AFTER_MS = 2000;
/** Per-request HTTP timeout (ms). */
const HTTP_TIMEOUT_MS = 1500;
/**
 * How often to pull the pit-menu screen (ms). It carries the player car's
 * tyre/brake wear — the only live per-corner data LMU exposes (temps are
 * published nowhere: the shared-memory wheel fields read zero and no REST
 * endpoint carries them). Wear moves slowly, so a gentle poll is plenty.
 */
const GARAGE_REFRESH_INTERVAL_MS = 3000;
/**
 * How often to pull the PIT MENU itself (ms).
 *
 * Much faster than the garage poll it used to share, because this one is not
 * wear data — it is the pit strategy, and the MFD widget is now a control
 * surface for it. Every change the driver makes (from the widget, from a bound
 * wheel button, or in the game's own MFD) is confirmed by this value moving, so
 * a 3 s poll meant up to three seconds of "did that land?". One small localhost
 * request; the heavy `getPlayerGarageData` read stays on the slow timer.
 */
const PIT_MENU_REFRESH_INTERVAL_MS = 500;
/** Treat wear data older than this as gone (left session / in menus). */
const GARAGE_STALE_AFTER_MS = 10_000;
/**
 * How often to pull the weather forecast (ms). LMU publishes a per-session
 * forecast (START → 25/50/75% → FINISH) that evolves slowly, so a lazy poll is
 * plenty. Kept separate from the fast standings poll to avoid the extra request
 * every 150 ms.
 */
const WEATHER_REFRESH_INTERVAL_MS = 15_000;
/**
 * How often to re-read the tyre spec — the sim's own optimal temperature per
 * compound, plus which compound is fitted to each corner (ms).
 *
 * Deliberately lazy, for the same reason `getPlayerGarageData` is: the optimal
 * temperatures are a property of the car and event, so within a session they do
 * not move at all. The only thing here that CAN change is the fitted compound,
 * and that changes at a pit stop — an event this poll will catch inside half a
 * minute, on a stint measured in tens of minutes.
 *
 * It also earns the slow timer: the screen this comes from carries the entire
 * pit menu as well (~145 kB, most of it the virtual-energy settings list), so it
 * is by some way the heaviest response the provider reads.
 */
const TYRE_SPEC_REFRESH_INTERVAL_MS = 30_000;
/**
 * How often to re-read the session's own rule settings (ms).
 *
 * Slower than the weather: these change when a session changes, not while it is
 * running. It is polled at all rather than read once because the provider outlives
 * the session — practice, qualifying and the race are three sessions on one
 * connection, and a league server can roll to an event with a different allowance
 * without the overlay restarting.
 */
const RULES_REFRESH_INTERVAL_MS = 30_000;
/**
 * How long to keep showing the last good local-car physics after a read returns
 * nothing. The shared-memory reader occasionally misses a single poll (a torn
 * read it couldn't reconcile); without this hold the pedals and tyre temps blink
 * to their "unknown" state for one frame, which reads as flicker on the overlay.
 */
const LOCAL_HOLD_MS = 500;
/**
 * How long to wait before re-probing the sim's internal scene name after a miss.
 *
 * The value changes once per session load, and shared memory only answers once
 * the sim is actually in a session — so between joining the menus and getting on
 * track this would otherwise be a failing read on every poll for minutes. Five
 * seconds is well inside the time it takes to load a track and get to the box.
 */
const SCENE_NAME_RETRY_MS = 5_000;
/**
 * Window over which the relative closing rate is measured (ms).
 *
 * Differencing the gap frame-to-frame at 30 Hz measures nothing but noise: the
 * gap is dead-reckoned between 150 ms REST refreshes, so consecutive frames
 * differ by extrapolation error, not by real closing speed. Over ~0.8 s a real
 * closing rate dominates that error. The last computed rate is held between
 * windows so the readout doesn't flicker.
 */
const CLOSING_WINDOW_MS = 800;

/** A car entry from `/rest/watch/standings` (only the fields we consume). */
interface RestStanding {
  slotID: number;
  position: number;
  /** Stable car hash — the same id `/rest/race/car` keys its entries by. */
  carId?: string;
  /** Grid / qualifying position (1-based) — drives positions gained/lost. */
  qualification?: number;
  /** Virtual-energy fraction remaining, 0..1 (LMU energy budget). */
  veFraction?: number;
  driverName: string;
  fullTeamName?: string;
  carNumber?: string;
  carClass?: string;
  bestLapTime: number;
  lastLapTime: number;
  /**
   * The completed lap's sector boundary times, seconds, **cumulative** from its
   * start — `lastSectorTime1` is the clock at the S1 line, `lastSectorTime2` at
   * the S2 line. Adopted from `currentSectorTime1/2` at the crossing. `-1` (or
   * `0` before the first lap) when the sim withheld one, which it does for a
   * lap it invalidated — probed live 2026-08-06 on a race server.
   */
  lastSectorTime1?: number;
  lastSectorTime2?: number;
  timeBehindLeader: number;
  timeBehindNext: number;
  lapsBehindLeader: number;
  lapsCompleted: number;
  estimatedLapTime?: number;
  fuelFraction?: number;
  lapDistance?: number;
  /** Seconds elapsed since this car crossed the line on its current lap. */
  timeIntoLap?: number;
  pitState?: string;
  pitting?: boolean;
  pitstops?: number;
  inGarageStall?: boolean;
  player?: boolean;
  focus?: boolean;
  hasFocus?: boolean;
  carVelocity?: { velocity?: number };
  finishStatus?: string;
  /** Per-car flag/phase strings (e.g. "GREEN") — more reliable than sessionInfo. */
  gamePhase?: string;
  flag?: string;
  underYellow?: boolean;
  /**
   * The sim's live lap-validity verdict: `COUNT_LAP_AND_TIME` while the lap
   * stands, `COUNT_LAP_ONLY` the instant a cut voids its time (and back, if
   * forgiven), `COUNT_NEITHER` on out-laps. Probed live 2026-08-04.
   */
  countLapFlag?: string;
}

/**
 * Fields we consume from `/rest/sessions/GetGameState` — the channel that
 * carries the phase as a STRING (`GPHASE_FORMATION`, `GPHASE_GREEN`, …) plus
 * the live pit-entry distance. Probed live 2026-08-04; see
 * docs/race-control-signals.md.
 */
interface RestGameState {
  gamePhase?: string;
  /** Signed along-track metres to the pit-entry commit point; negative = past it. */
  PitEntryDist?: number;
  PitState?: string;
}

/**
 * One entry from `/rest/race/car` — LMU's full installed-car list. Only the id
 * (which matches a standing's `carId`) and the manufacturer are consumed; the
 * payload also carries image/thumbnail routes, but they 404 on current builds
 * (probed live 2026-08-06), so the badge artwork is served from the game's
 * static UI assets instead (see the server's `/carbadges/` route).
 */
interface RestRaceCar {
  id?: string;
  manufacturer?: string;
}

/**
 * Minimum time between `/rest/race/car` fetches (ms). The list is ~450 KB for
 * 500+ cars and only changes when content is installed, so it is fetched once
 * and then only re-fetched when a standings row shows a carId we cannot name —
 * a new session with cars we have not seen — and never more often than this.
 */
const CAR_LIST_RETRY_MS = 60_000;
/** Ceiling for the failure backoff on that fetch (ms). */
const CAR_LIST_RETRY_MAX_MS = 600_000;
/**
 * Per-request timeout for `/rest/race/car` alone (ms).
 *
 * The game serializes this ~450 KB response INSIDE its render loop — the sim
 * visibly hangs for however long it takes. Measured live at 1.66 s on a machine
 * where the shared {@link HTTP_TIMEOUT_MS} of 1.5 s therefore aborted it every
 * time: the list never arrived, the unresolved carId stayed unresolved, and the
 * retry re-triggered the same in-game stall every {@link CAR_LIST_RETRY_MS} for
 * the whole session. A patient timeout lets the one big fetch actually land and
 * be cached, which is what ends the loop.
 */
const CAR_LIST_TIMEOUT_MS = 15_000;

/**
 * One connected player from `/rest/multiplayer/teams` — the `drivers` map is
 * keyed by player name. Only the badge is consumed. This endpoint is the ONLY
 * place the game locally publishes anything of a driver's online reputation:
 * the DR/SR numbers behind it live on its authenticated cloud service and are
 * deliberately not chased (probed live 2026-08-10 — full swagger enumerated,
 * nothing else rating-shaped answers on localhost).
 */
interface RestTeamsDriver {
  /**
   * The profile badge LMU's own session UI shows beside the name — a safety
   * tier (`sr-rookie` … `sr-saint`) or a special grant (`s397`, `irl-driver`,
   * …); `"none"` for the (common) unbadged driver.
   */
  badge?: string;
}

/** `/rest/multiplayer/teams` payload (only the fields we consume). */
interface RestMultiplayerTeams {
  drivers?: Record<string, RestTeamsDriver>;
}

/**
 * How often to pull `/rest/multiplayer/teams` for driver badges (ms).
 *
 * Lazy on purpose: a badge is a property of a driver's PROFILE, not of the
 * race — the set only changes when someone joins the server. The one cost of
 * missing that for a few seconds is a badge appearing late beside a name that
 * just appeared itself.
 */
const TEAMS_REFRESH_INTERVAL_MS = 10_000;

/** Fields we consume from `/rest/watch/sessionInfo`. */
interface RestSession {
  trackName?: string;
  lapDistance?: number;
  trackTemp?: number;
  ambientTemp?: number;
  raining?: number;
  maxPathWetness?: number;
  minPathWetness?: number;
  averagePathWetness?: number;
  session?: string;
  gamePhase?: string;
  currentEventTime?: number;
  endEventTime?: number;
  /** Seconds left in the current game phase — the live countdown during green. */
  timeRemainingInGamePhase?: number;
  maximumLaps?: number;
  numberOfVehicles?: number;
  /** Per-sector flag strings, e.g. `["UNKNOWN","YELLOW","UNKNOWN"]`. */
  sectorFlag?: unknown;
  /** Full-course-yellow / safety-car channel; `"NONE"` when clear. */
  yellowFlagState?: unknown;
  /** Lit lamps on the start gantry; > numRedLights means lights-out/green. */
  startLightFrame?: number;
  /** How many red lamps the gantry has (5 at every track probed). */
  numRedLights?: number;
}

/** One forecast metric node, e.g. `{ currentValue: 51, stringValue: "51%" }`. */
interface WeatherValue {
  currentValue?: number;
  stringValue?: string;
}

/** A single forecast point (one session phase) from `/rest/sessions/weather`. */
interface WeatherNode {
  WNV_RAIN_CHANCE?: WeatherValue;
  WNV_TEMPERATURE?: WeatherValue;
  WNV_SKY?: WeatherValue;
  WNV_HUMIDITY?: WeatherValue;
  WNV_WINDSPEED?: WeatherValue;
}

/**
 * `/rest/sessions/weather` payload: forecast per session (`PRACTICE`/`QUALIFY`/
 * `RACE`), each a map of phase → {@link WeatherNode}. Phases are `START`,
 * `NODE_25`, `NODE_50`, `NODE_75`, `FINISH`.
 */
type RestWeather = Record<string, Record<string, WeatherNode>>;

/**
 * The slice of `/rest/garage/UIScreen/TireManagement` we consume.
 *
 * The screen also carries the whole pit menu, the tyre inventory, weather and
 * standings — all of which the provider already has from cheaper endpoints, so
 * only the two blocks that exist nowhere else are typed here.
 */
interface RestTireManagement {
  /**
   * The sim's own optimal operating temperature per compound. This is the
   * reason the endpoint is read at all: it is the only published source for
   * what "up to temperature" means, and it is per car and event rather than a
   * constant, so nothing else can stand in for it.
   */
  optimalCompoundConditions?: {
    compounds?: Array<{ type?: string; optimalTemperature?: number }>;
  };
  /**
   * Live per-corner state `[FL, FR, RL, RR]`. Only `compound` is taken — an
   * index into `optimalCompoundConditions.compounds` naming what is fitted.
   * The temperatures here are a single value per corner and duplicate what
   * shared memory gives band-by-band, so they are left alone.
   */
  wheelInfo?: { wheelLocs?: Array<{ compound?: number }> };
}

/** Optimal temperature and compound name for one corner, as the sim gives it. */
interface TyreSpec {
  compound?: string;
  optimalTempC?: number;
}

/** Forecast phases in chronological order, with the label the widget shows. */
const WEATHER_PHASES: Array<{ key: string; label: string }> = [
  { key: 'START', label: 'START' },
  { key: 'NODE_25', label: '25%' },
  { key: 'NODE_50', label: '50%' },
  { key: 'NODE_75', label: '75%' },
  { key: 'FINISH', label: 'END' },
];

export class LmuRestProvider implements TelemetryProvider {
  public readonly name = 'lmu';

  private readonly fallback = new SimulatorProvider();
  private readonly fuel = new FuelCalculator();
  /** Live predictive lap-delta for the focused car vs. its own best lap. */
  private readonly lapDelta = new LapDeltaTracker();
  /**
   * High-rate delta for the DRIVEN car, built on the shared-memory lap clock
   * (`mElapsedTime − mLapStartET`) — exact, physics-rate, and immune to the
   * REST `timeIntoLap` quirks (that clock pauses while the car is stationary).
   * Used whenever the focused car is the locally-driven one; the REST-based
   * tracker above remains the fallback for spectated cars.
   */
  /**
   * Pacelogic-style dual delta engine (Delta T + Delta V vs session-best,
   * all-time-best and last laps) for the driven car — feeds the pace-delta
   * widget and the single-value Delta widget. Built on the REST watch feed.
   */
  private readonly paceDelta = new LocalPaceDeltaTracker();
  /** The delta engine's distance axis — see {@link RoadPosition}. */
  private readonly roadPos = new RoadPosition();
  /** Accumulated seconds on the spectated delta clock — see {@link stepDeltaClock}. */
  private deltaClockSec = 0;
  /** Sim clock at the last {@link stepDeltaClock}; `-1` when it wasn't readable. */
  private deltaClockSimSec = -1;
  /** Wall clock (ms) at the last {@link stepDeltaClock}. */
  private deltaClockWallMs = 0;
  /** Separate calculator fed real litres from shared memory (local car). */
  private readonly localFuel = new FuelCalculator();
  /**
   * Virtual-energy strategy for the focused car, run in **percent** units
   * (0..100, capacity 100) so per-lap burns keep useful precision through the
   * calculator's rounding.
   */
  private readonly energyCalc = new FuelCalculator();
  /**
   * Circuit + session the burn history above was measured in. A new session
   * reloads every car's tank from its setup, which lands as a level change with
   * no lap between it and the last lap of the old session — so the first lap of
   * the race would otherwise be "measured" as the difference between the fuel
   * you finished practice on and the fuel you started the race with. That number
   * can be ten times a real lap's burn, and since laps-of-range is level over
   * burn, it is what puts a full-tank car one lap from a pit alarm.
   *
   * The calculator now refuses samples that large on its own; this is the other
   * half of the same fix, and the better-placed one: history from a different
   * session is not evidence about this one, whatever its size.
   */
  private fuelSessionKey = '';
  /**
   * Slot the focus-following fuel and energy calculators are tracking. Those two
   * follow the broadcast focus, so when it moves to another car their history
   * belongs to somebody else's tank — and a burn rate carried across from one
   * car to another is a laps-remaining figure invented out of two cars.
   * {@link localFuel} is exempt: it reads the tank of the car driven on this PC,
   * which the focus cannot change.
   */
  private fuelFocusSlot: number | null = null;
  /** Reads the locally-driven car's inputs + fuel from shared memory. */
  private readonly localCar = new LmuLocalCarReader();
  /**
   * Reads the lateral-position and penalty channels the REST feed omits, from
   * the Scoring buffer. Separate from {@link localCar} because it is a different
   * shared-memory region with its own record layout — see `lmuScoring.ts`.
   */
  private readonly scoring = new LmuScoringReader();
  /**
   * The locally-driven car's driver name, latched from the standings each
   * frame. Feeds the trace reader's penalty attribution (see start()), which
   * runs from a poll timer and cannot ask the frame builder.
   */
  private playerDriverName = '';
  /** Rolling last-5-lap pace per car, for the standings AVG column. */
  private readonly paceAvg = new PaceAverageTracker();
  /**
   * The driven car's model, latched from the Scoring buffer.
   *
   * Sticky on purpose. The name cannot change without a trip through the garage,
   * but a single torn or missed read would blank it — and it keys both the PB
   * reference and the lap log, so a momentary blank would silently start a
   * second set of records for the same car. Keeping the last good value is the
   * behaviour that matches reality; only a genuine car change replaces it, and
   * that always comes with a non-empty name.
   */
  private playerVehicleName = '';
  /**
   * The sim's own name for the loaded scene, from shared memory.
   *
   * REST names the venue and never the layout, and `referencePace` will not
   * score a lap at Monza, Le Mans, Fuji or Paul Ricard without knowing which
   * layout it was — see {@link LmuScoringReader.readTrackName}. Cached because
   * it changes once per session load, not once per poll.
   */
  private simTrackName = '';
  /** Display track name the cached scene name belongs to; a change clears it. */
  private simTrackNameFor = '';
  /** When the scene name was last probed, so a dead buffer is not hit at 30 Hz. */
  private simTrackNameAt = 0;
  /**
   * Memoised pace score. Its inputs move once a lap while this runs at the
   * update rate, and resolving a layout is string work over the whole table.
   */
  private paceScoreCache: { key: string; value: PaceScoreState } | null = null;
  /** Counts track-limit excursions for the driven car; see `trackLimits.ts`. */
  private readonly trackLimits = new TrackLimitsTracker();
  /** Turns the driven car's lap boundaries into the lap database; see `lapLog.ts`. */
  private readonly lapRecorder = new LapRecorder();
  /**
   * Per-lap driving-trace recorder for the driven car — the training feature's
   * capture side. Fed at frame rate beside the delta engine with the same
   * filtered position and clock, so its laps are the delta's laps.
   */
  private readonly lapTrace = new LapTraceRecorder();
  /**
   * Traces whose lap record has not been written yet. The lap log holds every
   * record ~40 s for the stewards' verdict (see `VERDICT_HOLD_MS`), so a
   * completed trace waits here until its record lands, matched by the wall
   * clock both sides stamped at the crossing. A handful deep at most.
   */
  private pendingTraces: { trace: CompletedTrace; wallMs: number }[] = [];
  /** Learns the circuit's shape from the driven car; see `trackMap.ts`. */
  private readonly trackMap = new TrackMapBuilder();
  /**
   * Per-car relative-gap history, for the closing-rate derivation that drives
   * the backmarker / blue-flag alert. Keyed by slot id. See
   * {@link CLOSING_WINDOW_MS} for why this is sampled rather than differenced
   * every frame.
   */
  private readonly gapHistory = new Map<number, { gap: number; at: number; rate: number }>();
  /** Last good local physics + when, to bridge single missed reads (flicker). */
  private lastLocal: LocalCarPhysics | null = null;
  private lastLocalAt = 0;
  /**
   * Same single-read bridge for the SPECTATED car ({@link readSpectatedCar}),
   * keyed to the slot it was read from so a broadcast-focus switch is never
   * papered over with the previous car's pedals.
   */
  private lastSpectated: LocalCarPhysics | null = null;
  private lastSpectatedAt = 0;
  private lastSpectatedSlot = -1;
  /**
   * Whether the car currently being driven has a hybrid system at all — latched
   * `true` the first time it publishes a non-zero state of charge, and re-armed
   * by {@link hybridLatchCar} whenever the car changes.
   *
   * A latch rather than a live test, because the two things that must not be
   * confused look identical in any single frame: a GT3 reads a constant `0`
   * because it has no battery, and a Hypercar reads `0` at the end of a long
   * straight because it has just spent one. Gating on the instantaneous value
   * would make the Hypercar's gauge vanish at exactly the moment its driver most
   * wants to see it, so the question is asked once per car instead of per frame.
   */
  private hasHybrid = false;
  /** Vehicle the {@link hasHybrid} latch was decided for; a change re-arms it. */
  private hybridLatchCar = '';
  /** Last good radar blips + when, to bridge a single torn readField() (flicker). */
  private lastRadar: RadarBlip[] | null = null;
  private lastRadarAt = 0;
  private readonly port: number;
  private readonly verbose: boolean;

  private standings: RestStanding[] | null = null;
  private session: RestSession | null = null;
  private gameState: RestGameState | null = null;
  private lastOkAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private live = false;
  /** Player-car tyre wear [FL, FR, RL, RR], `1` fresh → `0` gone. */
  private tyreWear: number[] | null = null;
  private lastGarageOkAt = 0;
  /** Last decoded damage block, and when it last decoded cleanly. */
  private damage: DamageState | null = null;
  private lastDamageOkAt = 0;
  /**
   * The player's live pit work, or `null` when the crew is not on the car.
   *
   * `plannedSec` / `slackSec` are snapshotted the instant the car comes to rest
   * in the box and then held for the whole stop — see {@link PitState} for why
   * re-reading the repair screen mid-stop would make the countdown's target move
   * while it was counting down to it.
   */
  private pitWork: { startedAt: number; plannedSec: number; slackSec: number } | null = null;
  /** Last raw pit menu + garage `VM_*` data, for the MFD-control block. */
  /** Recent average-wetness samples, for the drying/wetting trend. */
  private readonly wetHistory: Array<{ at: number; wet: number }> = [];
  private pitMenuRaw: RawPitRow[] | null = null;
  private garageDataRaw: Record<string, RawGarageVal> | null = null;
  private lastMfdOkAt = 0;
  /** Fingerprint of {@link garageDataRaw}, memoized on the payload's identity —
   *  the 3 s garage poll replaces the object wholesale on every success. */
  private setupFpCache = '';
  private setupFpFor: Record<string, RawGarageVal> | null = null;
  private garageTimer: NodeJS.Timeout | null = null;
  /** The pit menu's own faster timer — see PIT_MENU_REFRESH_INTERVAL_MS. */
  private pitMenuTimer: NodeJS.Timeout | null = null;
  /** Raw per-session weather forecast from `/rest/sessions/weather`. */
  private weatherForecast: RestWeather | null = null;
  private weatherTimer: NodeJS.Timeout | null = null;
  /**
   * Per-corner compound + optimal temperature `[FL, FR, RL, RR]`, from
   * {@link refreshTyreSpec}. `null` until the screen has been read once; a
   * corner is `{}` when the sim named a compound it published no optimum for.
   */
  private tyreSpec: [TyreSpec, TyreSpec, TyreSpec, TyreSpec] | null = null;
  private lastTyreSpecOkAt = 0;
  private tyreSpecTimer: NodeJS.Timeout | null = null;
  /**
   * The session's own track-limits allowance, from `SESSSET_cuts_allowed`, or
   * `null` when the sim has not published one.
   *
   * `null` matters: it is the difference between "this session allows 5" and "we
   * do not know", and only the first may be shown as a threshold. See
   * {@link refreshRules}.
   */
  private cutsAllowed: number | null = null;
  private rulesTimer: NodeJS.Timeout | null = null;
  /**
   * carId → manufacturer, from `/rest/race/car`. Filled lazily: the first
   * standings payload with an id this map cannot name triggers a (rate-limited)
   * fetch of the car list. See {@link maybeRefreshCarList}.
   */
  private readonly manufacturerById = new Map<string, string>();
  /** When `/rest/race/car` was last fetched (attempted), for the rate limit. */
  private lastCarListAt = 0;
  /** Guards against overlapping car-list fetches while one is in flight. */
  private carListInFlight = false;
  /** Current retry gap for the car list — doubles on failure, resets on success. */
  private carListRetryMs = CAR_LIST_RETRY_MS;
  /**
   * carIds a SUCCESSFUL car-list load still could not name — custom cars absent
   * from the game's own list. Without remembering them, one such car in the
   * field re-triggers the ~450 KB fetch (and the in-game stall it causes) every
   * retry window for the entire session.
   */
  private readonly unresolvableCarIds = new Set<string>();
  /**
   * Normalized player name → profile badge, from `/rest/multiplayer/teams`.
   * Only drivers with a real badge are kept (`"none"` is the common case and
   * would make every lookup a hit that says nothing). Empty outside multiplayer
   * — the endpoint doesn't answer there, and {@link refreshTeams} clears the
   * map so a badge can never outlive the server that granted it.
   */
  private readonly badgeByName = new Map<string, string>();
  private teamsTimer: NodeJS.Timeout | null = null;
  /**
   * DR/SR rank badges from the game's online service, keyed by player name.
   * Fed exclusively with the CONNECTED-PLAYER names from `/rest/multiplayer/
   * teams` — never standings names, whose AI roster entries could collide with
   * a real account. See `telemetry/raceosRanks` for the whole story.
   */
  private ranks: RaceosRanksClient | null = null;
  /**
   * Reads the sim's own track-limit charges from its trace log — the only live
   * source for them. See `telemetry/lmuTraceLimits.ts` for why a log file, and for
   * what was ruled out first.
   */
  private readonly traceLimits: LmuTraceLimitsReader;
  /** The session the trace reader was last reset for, so a restart clears its total. */
  private traceSessionKey = '';
  /**
   * The trace reader's charge counter as of the last poll, and the wall clock at
   * which it last went up.
   *
   * The reader deals in game-clock seconds from the log; the widget needs "how
   * long ago was that, in real time" to flash on it. Stamping it here — the moment
   * the charge reaches us — is the only honest answer available: the sim's own
   * timestamp for the incident can be up to ~25 s older than its arrival, and
   * flashing for an event whose age we cannot observe would be worse than not
   * flashing at all.
   */
  private lastChargeSeq = 0;
  private lastChargeAt = 0;

  public constructor(config: LmuRestConfig) {
    this.port = config.lmuApiPort ?? DEFAULT_API_PORT;
    this.verbose = config.verbose;
    this.traceLimits = new LmuTraceLimitsReader(config.verbose);
  }

  public async start(): Promise<void> {
    this.fallback.start();
    this.localCar.start(); // best-effort shared-memory reader for the driven car
    this.scoring.start(); // …and the scoring buffer, for track limits + penalties
    // Whose penalty is a trace line about? The lines are anonymous, and in
    // multiplayer they fire for OTHER cars too (a rival's pit-exit stop/go
    // wrote a `Local penalty` line to this PC's trace, live, 2026-08-20) — so
    // before one is allowed to name a penalty or zero the accumulated points:
    //
    //   - a line the steward's message NAMED is the named driver's, full stop;
    //   - an unnamed line is ours only if OUR OWN penalty count (per-car, from
    //     scoring, instant) rose within the trace's flush latency — the count
    //     moves the moment the sim decides, the trace up to ~25 s later;
    //   - during a backfill replay there is no live counter to ask, so unnamed
    //     lines are trusted the way the recovery pass always trusted them.
    this.traceLimits.setPenaltyAttribution((pen, replay) => {
      if (pen.driver) {
        const own = this.playerDriverName.trim().toLowerCase();
        return own !== '' && pen.driver.trim().toLowerCase() === own;
      }
      if (replay) return true;
      const rose = this.trackLimits.lastPenaltyRoseAtMs();
      return rose > 0 && Date.now() - rose < OWN_PENALTY_ATTRIBUTION_MS;
    });
    this.traceLimits.start(); // …and the trace log, for the sim's own points
    // Age out old driving traces once per app run — they are the one thing the
    // lap store keeps that is big enough to be worth pruning. See lapTrace.ts.
    pruneTraces(Date.now());
    await this.refresh(); // prime the cache before the first poll
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref?.();
    void this.refreshGarage();
    void this.refreshGarageAids();
    this.garageTimer = setInterval(() => {
      void this.refreshGarage();
      void this.refreshGarageAids();
    }, GARAGE_REFRESH_INTERVAL_MS);
    this.garageTimer.unref?.();
    void this.refreshPitMenu();
    this.pitMenuTimer = setInterval(() => void this.refreshPitMenu(), PIT_MENU_REFRESH_INTERVAL_MS);
    this.pitMenuTimer.unref?.();
    void this.refreshWeather();
    this.weatherTimer = setInterval(() => void this.refreshWeather(), WEATHER_REFRESH_INTERVAL_MS);
    this.weatherTimer.unref?.();
    void this.refreshTyreSpec();
    this.tyreSpecTimer = setInterval(
      () => void this.refreshTyreSpec(),
      TYRE_SPEC_REFRESH_INTERVAL_MS,
    );
    this.tyreSpecTimer.unref?.();
    void this.refreshRules();
    this.rulesTimer = setInterval(() => void this.refreshRules(), RULES_REFRESH_INTERVAL_MS);
    this.rulesTimer.unref?.();
    this.ranks = new RaceosRanksClient(this.port, this.verbose);
    this.ranks.start();
    void this.refreshTeams();
    this.teamsTimer = setInterval(() => void this.refreshTeams(), TEAMS_REFRESH_INTERVAL_MS);
    this.teamsTimer.unref?.();
    if (this.lastOkAt > 0) {
      console.log(`[lmu] connected to LMU REST API on :${this.port}`);
    } else {
      console.log(`[lmu] LMU REST API not answering on :${this.port} — using simulator.`);
    }
    if (this.localCar.available) {
      console.log('[lmu] shared-memory reader active for local-car inputs + fuel.');
    }
  }

  public isConnected(): boolean {
    return this.live;
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.garageTimer) {
      clearInterval(this.garageTimer);
      this.garageTimer = null;
    }
    if (this.pitMenuTimer) {
      clearInterval(this.pitMenuTimer);
      this.pitMenuTimer = null;
    }
    if (this.weatherTimer) {
      clearInterval(this.weatherTimer);
      this.weatherTimer = null;
    }
    if (this.rulesTimer) {
      clearInterval(this.rulesTimer);
      this.rulesTimer = null;
    }
    if (this.teamsTimer) {
      clearInterval(this.teamsTimer);
      this.teamsTimer = null;
    }
    if (this.ranks) {
      this.ranks.stop();
      this.ranks = null;
    }
    if (this.tyreSpecTimer) {
      clearInterval(this.tyreSpecTimer);
      this.tyreSpecTimer = null;
    }
    this.fallback.stop();
    this.localCar.stop();
    this.scoring.stop();
    this.traceLimits.stop();
    this.live = false;
  }

  public poll(nowMs: number, dtMs: number): TelemetryFrame {
    const fresh =
      this.standings !== null &&
      this.session !== null &&
      Date.now() - this.lastOkAt < STALE_AFTER_MS;
    if (fresh) {
      try {
        const frame = this.buildFrame(nowMs);
        this.live = true;
        return frame;
      } catch (err) {
        if (this.verbose) console.error('[lmu] frame build failed:', (err as Error).message);
      }
    }
    this.live = false;
    const frame = this.fallback.poll(nowMs, dtMs);
    // The MFD (pit menu + aids) comes from the garage endpoints, which are alive
    // in the garage BEFORE a session's watch/standings feed is — precisely when
    // strategy is set. So overlay the real MFD block onto the demo frame rather
    // than dropping it: the control widget must work at the setup screen, not
    // only once green-flag standings exist.
    const mfd = this.buildMfd();
    if (mfd) frame.mfd = mfd;
    return frame;
  }

  /* ----------------------------- HTTP polling ---------------------------- */

  /**
   * Single-flight guard for {@link refresh}. The 150 ms interval fires whether
   * or not the last tick finished; when the game stalls its session endpoints
   * (session loads do this for seconds at a time), unguarded ticks pile tens of
   * concurrent requests onto the game's webserver — a convoy that extends the
   * very stall it is stuck behind. One outstanding tick is the whole point of
   * a poll; a skipped tick costs 150 ms of freshness, nothing more.
   */
  private refreshInFlight = false;

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      const [standings, session, gameState] = await Promise.all([
        this.getJson<RestStanding[]>('/rest/watch/standings'),
        this.getJson<RestSession>('/rest/watch/sessionInfo'),
        // The phase as a string plus the live pit-entry distance. Fetched on
        // the fast timer with the other two: the green flag and the pit-entry
        // countdown are exactly the events a 150 ms cadence exists for. Its
        // absence (older build, endpoint 404) must not take standings down
        // with it, hence the catch to null rather than a shared failure.
        this.getJson<RestGameState>('/rest/sessions/GetGameState').catch(() => null),
      ]);
      if (Array.isArray(standings)) {
        this.standings = standings;
        this.maybeRefreshCarList(standings);
      }
      if (session && typeof session === 'object') this.session = session;
      if (gameState && typeof gameState === 'object') this.gameState = gameState;
      if (Array.isArray(standings) && session) this.lastOkAt = Date.now();
    } catch (err) {
      // Leave the cache in place; the staleness check flips us to the simulator.
      if (this.verbose) console.error('[lmu] refresh failed:', (err as Error).message);
    } finally {
      this.refreshInFlight = false;
    }
  }

  /**
   * Fetches `/rest/race/car` when the current field contains a car we cannot
   * name a manufacturer for — which is what puts the brand badge on a standings
   * row.
   *
   * Lazy rather than on a timer: the list is the largest payload the game
   * serves (~450 KB) and changes only when content is installed, so polling it
   * would be all cost and no information. Once every id in the field resolves,
   * this is a Map lookup per refresh and no HTTP at all. The rate limit covers
   * the one genuinely unresolvable case — a custom car absent from the list —
   * which would otherwise re-fetch 450 KB every 150 ms for the whole session.
   */
  private maybeRefreshCarList(standings: RestStanding[]): void {
    const unresolved = standings.filter(
      (c) => c.carId && !this.manufacturerById.has(c.carId) && !this.unresolvableCarIds.has(c.carId),
    );
    if (unresolved.length === 0 || this.carListInFlight) return;
    const now = Date.now();
    if (now - this.lastCarListAt < this.carListRetryMs) return;
    this.lastCarListAt = now;
    this.carListInFlight = true;
    this.getJson<RestRaceCar[]>('/rest/race/car', CAR_LIST_TIMEOUT_MS)
      .then((cars) => {
        if (!Array.isArray(cars)) return;
        for (const car of cars) {
          if (car && typeof car.id === 'string' && car.id && typeof car.manufacturer === 'string' && car.manufacturer) {
            this.manufacturerById.set(car.id, car.manufacturer);
          }
        }
        // Ids the fresh list still cannot name are custom cars the game does
        // not list at all. Remember them so they stop counting as "unresolved"
        // — they are what would otherwise re-arm this fetch forever.
        for (const c of unresolved) {
          if (c.carId && !this.manufacturerById.has(c.carId)) this.unresolvableCarIds.add(c.carId);
        }
        this.carListRetryMs = CAR_LIST_RETRY_MS;
        if (this.verbose) {
          console.log(`[lmu] car list loaded — ${this.manufacturerById.size} manufacturers mapped`);
        }
      })
      .catch((err) => {
        this.carListRetryMs = Math.min(this.carListRetryMs * 2, CAR_LIST_RETRY_MAX_MS);
        if (this.verbose) console.error('[lmu] car list fetch failed:', (err as Error).message);
      })
      .finally(() => {
        this.carListInFlight = false;
      });
  }

  /**
   * Pulls the player car's tyre wear **and damage** from the pit-menu screen.
   *
   * One fetch serves both: this endpoint is the repair screen, so the same
   * payload that carries `wearables.tires` also carries per-component damage
   * severities and the sim's own repair-time estimate. See
   * {@link module:telemetry/damage} for why damage comes from here rather than
   * from the (present but unpopulated) shared-memory damage block.
   */
  private async refreshGarage(): Promise<void> {
    try {
      const data = await this.getJson<RawRepairPayload>('/rest/garage/UIScreen/RepairAndRefuel');
      const tires = data && data.wearables ? data.wearables.tires : null;
      if (
        Array.isArray(tires) &&
        tires.length >= 4 &&
        tires.every((v) => typeof v === 'number' && v >= 0 && v <= 1)
      ) {
        this.tyreWear = tires.slice(0, 4) as number[];
        this.lastGarageOkAt = Date.now();
      }
      // Decoded on arrival rather than at frame time so a malformed payload is
      // rejected once, here, instead of every frame for the next ten seconds.
      this.damage = decodeDamage(data);
      if (this.damage) this.lastDamageOkAt = Date.now();
    } catch (err) {
      // Endpoint is only alive inside a session; keep the last data until stale.
      if (this.verbose) console.error('[lmu] garage refresh failed:', (err as Error).message);
    }
  }

  /**
   * Pulls `/rest/multiplayer/teams` and rebuilds the name → badge map.
   *
   * The map is rebuilt (not merged) on every answer, and CLEARED when the
   * endpoint stops answering: it only answers on a multiplayer server, so a
   * failure here is the normal single-player state, and holding the old map
   * would carry one server's badges into the next session under whatever names
   * happen to repeat.
   */
  private async refreshTeams(): Promise<void> {
    try {
      const teams = await this.getJson<RestMultiplayerTeams>('/rest/multiplayer/teams');
      this.badgeByName.clear();
      if (!teams || typeof teams.drivers !== 'object' || teams.drivers === null) return;
      for (const [name, info] of Object.entries(teams.drivers)) {
        const badge = info && typeof info.badge === 'string' ? info.badge.trim() : '';
        if (!badge || badge.toLowerCase() === 'none') continue;
        this.badgeByName.set(normalizeDriverName(name), badge);
      }
      // These keys are the connected HUMANS — exactly the set whose DR/SR rank
      // badges exist to be fetched, and the only names safe to send (see the
      // field note on `ranks`).
      this.ranks?.noteNames(Object.keys(teams.drivers));
    } catch {
      this.badgeByName.clear();
    }
  }

  /** The DR/SR rank badges for a standings row's driver, if resolved. */
  private driverRanksFor(driverName: string | undefined): DriverRanks | undefined {
    if (!driverName || !this.ranks) return undefined;
    return this.ranks.get(driverName);
  }

  /**
   * The profile badge for a standings row's driver, or `undefined`.
   *
   * Joined by NAME because that is the only key the two feeds share: the teams
   * map is keyed by the player's profile name, while a standings row carries
   * whatever name is in the car — which LMU can suffix with a `#1234`
   * discriminator. {@link normalizeDriverName} strips that on both sides, so
   * the join tolerates the one decoration the game is known to add.
   */
  private driverBadgeFor(driverName: string | undefined): string | undefined {
    if (!driverName || this.badgeByName.size === 0) return undefined;
    return this.badgeByName.get(normalizeDriverName(driverName));
  }

  /**
   * Pulls the pit menu — the pit strategy the MFD widget both shows AND drives.
   *
   * On its own fast timer, and kept SEPARATE from {@link refreshGarage} and
   * {@link refreshGarageAids}: the repair, pit-menu and garage-setup screens have
   * independent availability (any one can 404 while another answers — the pit
   * menu exists on track when the repair screen may not), so sharing a `try`
   * would let one screen's absence silently drop the others.
   */
  /** Single-flight guard — same convoy reasoning as {@link refreshInFlight}. */
  private pitMenuInFlight = false;

  private async refreshPitMenu(): Promise<void> {
    if (this.pitMenuInFlight) return;
    this.pitMenuInFlight = true;
    try {
      const pit = await this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu').catch(
        () => null,
      );
      if (Array.isArray(pit)) {
        this.pitMenuRaw = pit;
        this.lastMfdOkAt = Date.now();
      }
    } finally {
      this.pitMenuInFlight = false;
    }
  }

  /**
   * Pulls the `VM_*` garage values — the frozen SETUP numbers behind the aids.
   *
   * Deliberately slow: these do not move in a session at all, and it is a 100+
   * key payload. Polling it at the pit menu's rate would be the one genuinely
   * wasteful request in the provider. Only brake bias is still read from here,
   * and only as the fallback for when there is no live car — every aid now
   * comes off the telemetry record instead (see `projectAids`).
   */
  private async refreshGarageAids(): Promise<void> {
    const garage = await this.getJson<Record<string, RawGarageVal>>(
      '/rest/garage/getPlayerGarageData',
    ).catch(() => null);
    if (garage && typeof garage === 'object') {
      this.garageDataRaw = garage;
      this.lastMfdOkAt = Date.now();
    }
  }

  /**
   * Reads the sim's own tyre spec: the optimal temperature for each compound,
   * and which compound each corner is running.
   *
   * This is the whole basis for the overlay ever saying a tyre is in or out of
   * its window. LMU publishes the number per compound per car/event, so it is
   * read rather than assumed — a GT3 medium and a wet are 92 °C and 50 °C in
   * this session, and a different car or event may well disagree. When the read
   * fails or the sim publishes no optimum, {@link TyreState.optimalTempC} is
   * left absent and the widget shows temperatures without a verdict, which is
   * the honest failure: a guessed window would colour every corner confidently
   * and wrongly.
   */
  private async refreshTyreSpec(): Promise<void> {
    const data = await this.getJson<RestTireManagement>(
      '/rest/garage/UIScreen/TireManagement',
    ).catch(() => null);
    const compounds = data?.optimalCompoundConditions?.compounds;
    if (!data || !Array.isArray(compounds)) return;
    const locs = data.wheelInfo?.wheelLocs;
    const corner = (i: number): TyreSpec => {
      // Which compound is on this corner. An index the table does not cover is
      // not a compound we know anything about, so it yields no optimum rather
      // than falling back to compound 0 — the corners can differ, and naming
      // the wrong one would put the LED on the wrong window.
      const idx = Array.isArray(locs) && locs[i] ? locs[i].compound : undefined;
      if (typeof idx !== 'number' || idx < 0 || idx >= compounds.length) return {};
      const spec = compounds[idx];
      if (!spec) return {};
      const out: TyreSpec = {};
      if (typeof spec.type === 'string' && spec.type) out.compound = spec.type;
      // 0 °C is not an optimum any tyre has; treat it as "not published".
      if (typeof spec.optimalTemperature === 'number' && spec.optimalTemperature > 0) {
        out.optimalTempC = round1(spec.optimalTemperature);
      }
      return out;
    };
    this.tyreSpec = [corner(0), corner(1), corner(2), corner(3)];
    this.lastTyreSpecOkAt = Date.now();
  }

  /** Pulls the per-session weather forecast (START → 25/50/75% → FINISH). */
  private async refreshWeather(): Promise<void> {
    try {
      const data = await this.getJson<RestWeather>('/rest/sessions/weather');
      if (data && typeof data === 'object') this.weatherForecast = data;
    } catch (err) {
      // Endpoint is only alive inside a session; keep the last forecast.
      if (this.verbose) console.error('[lmu] weather refresh failed:', (err as Error).message);
    }
  }

  /**
   * Read the session's track-limits allowance from `/rest/sessions`.
   *
   * ## Why this exists
   * The points limit shown on the Track Limits widget was a hard-coded default
   * (`DEFAULT_POINTS_LIMIT`) — a middling league figure, and a guess. It turns out
   * the sim publishes the real one: `/rest/sessions` carries the whole session
   * setup, including
   *
   * ```
   * SESSSET_cuts_allowed = { currentValue: 5,  numStepsTotal: 63 }
   * SESSSET_cut_rules    = { currentValue: 1,  stringValue: "Default" }
   * ```
   *
   * `cuts_allowed` is the allowance this session was configured with, so a driver
   * counting up to it is counting to the number that will actually be enforced
   * instead of to ours.
   *
   * ## What is deliberately NOT done with it
   * `cut_rules` is left alone. It has three states and only the middle one has
   * been observed (`1` → `"Default"`), so what `0` and `2` mean — and in
   * particular whether either is a "show but never penalise" mode that should
   * suppress the countdown entirely — is unknown. Acting on an unobserved value
   * would mean either hiding a real threshold or promising immunity that is not
   * there; the raw setting is logged by `scripts/probe-lmu-penalty.js` so it can be
   * pinned by changing it in a session rather than guessed at here.
   *
   * A missing or nonsensical value leaves {@link cutsAllowed} as `null` and the
   * widget falls back to its default, which is the pre-existing behaviour.
   */
  private async refreshRules(): Promise<void> {
    try {
      const data = await this.getJson<Record<string, { currentValue?: unknown }>>('/rest/sessions');
      const raw = data?.SESSSET_cuts_allowed?.currentValue;
      this.cutsAllowed = typeof raw === 'number' && raw > 0 ? raw : null;
    } catch (err) {
      // Only alive inside a session; keep whatever the last session published.
      if (this.verbose) console.error('[lmu] cut rules refresh failed:', (err as Error).message);
    }
  }

  private getJson<T>(path: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.port, path, timeout: timeoutMs },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} for ${path}`));
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body) as T);
            } catch (e) {
              reject(e as Error);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
    });
  }

  /* ------------------------------- mapping ------------------------------- */

  /**
   * Advance the time axis the spectated delta engine runs on, and return it.
   *
   * A lap delta is a difference of two clocks, so the clock has to be real —
   * REST `timeIntoLap` is derived from position and reports the same value at a
   * given distance whatever the lap time, which is why the spectated delta used
   * to sit at 0.00. Two real clocks are available, and which one we get depends
   * on how the overlay is being run:
   *
   *   • the sim's own `mElapsedTime`, when this PC has a car in the session —
   *     the same clock the driven car's delta uses. It stops when the sim is
   *     paused, which is what makes it the better of the two;
   *   • wall time, for a spectator or broadcast PC with no car of its own. It
   *     ticks 1:1 with a live session and only misleads if the sim is paused or
   *     running dilated, neither of which happens on a live server.
   *
   * Rather than hand those out directly — swapping between them mid-session
   * would look like a jump of decades — this accumulates a single monotonic
   * count of seconds from whichever source is currently available. Each step is
   * clamped to a sane interval, so a resumed session, a slow frame or a
   * shared-memory dropout contributes at most one step's worth instead of a
   * discontinuity every car's lap timing would have to recover from.
   *
   * @param simSec - The sim clock this frame, or {@link UNKNOWN_VALUE}.
   * @param nowMs  - Wall clock (ms) for this frame.
   */
  private stepDeltaClock(simSec: number, nowMs: number): number {
    const haveSim = typeof simSec === 'number' && simSec > 0;
    let step: number;
    if (haveSim && this.deltaClockSimSec > 0) {
      step = simSec - this.deltaClockSimSec;
    } else if (this.deltaClockWallMs > 0) {
      step = (nowMs - this.deltaClockWallMs) / 1000;
    } else {
      step = 0;
    }
    this.deltaClockSimSec = haveSim ? simSec : -1;
    this.deltaClockWallMs = nowMs;
    // A negative step is the sim clock rewinding (session restart); a large one
    // is a stall or an unpause. Neither is time the cars actually spent driving.
    this.deltaClockSec += step > 0 && step < 1 ? step : 0;
    // Never zero: the tracker treats a non-positive clock as "no data".
    return this.deltaClockSec + 1;
  }

  private buildFrame(nowMs: number): TelemetryFrame {
    const cars = this.standings ?? [];
    const si = this.session ?? {};

    // The car with broadcast focus is the "player" for overlay purposes; fall
    // back to the local player entry, then to the leader.
    const focus =
      cars.find((c) => c.hasFocus || c.focus) ?? cars.find((c) => c.player) ?? cars[0];
    const focusId = focus ? focus.slotID : UNKNOWN_VALUE;

    // The locally-driven car's physics (inputs + fuel in litres) come from
    // shared memory. LMU publishes a telemetry record for every car in the
    // field, keyed by `mID`, which equals the REST `slotID`. Passing the
    // player's slot id makes the reader return this car's own inputs (and never
    // another car's — car numbers can repeat across classes, ids can't).
    const playerCar = cars.find((c) => c.player);
    if (playerCar?.driverName) this.playerDriverName = playerCar.driverName;
    const rawLocal = playerCar ? this.localCar.read(playerCar.slotID) : null;
    // Bridge an occasional single missed read so pedals/temps don't flicker to
    // "unknown" for one frame; a genuine drop (spectating) outlasts the hold.
    let local = rawLocal;
    if (rawLocal) {
      this.lastLocal = rawLocal;
      this.lastLocalAt = Date.now();
    } else if (this.lastLocal && Date.now() - this.lastLocalAt < LOCAL_HOLD_MS) {
      local = this.lastLocal;
    }

    // Spectator fallback: no car is being driven on this PC, but the broadcast-
    // focused car's telemetry record is still in shared memory with live gear,
    // revs and pedals (proven against a remote car in a live team race — see
    // {@link readSpectatedCar}). It feeds ONLY the player-block build below;
    // fuel, radar, delta, MFD and track limits keep their driven-car sources,
    // so the driving path is untouched by construction.
    const displayLocal =
      local ?? (playerCar === undefined && focus ? this.readSpectatedCar(focus.slotID) : null);

    // One scoring read per poll, shared by everything that needs it. It used to
    // live inside buildTrackLimits, but the PB reference key (below) needs the
    // car model from the same record and is computed earlier in the frame, and
    // reading the buffer twice per poll to serve two callers would be pure waste.
    const scoringCar = playerCar ? this.scoring.read(playerCar.slotID) : null;
    if (scoringCar && scoringCar.vehicleName) this.playerVehicleName = scoringCar.vehicleName;

    // Hybrid latch — keyed on the CAR, because whether there is a battery is a
    // property of the machinery, not of the session. Swapping cars between
    // sessions must re-ask the question; a red flag must not.
    if (this.playerVehicleName !== this.hybridLatchCar) {
      this.hybridLatchCar = this.playerVehicleName;
      this.hasHybrid = false;
    }
    if (rawLocal && rawLocal.batteryCharge > 0) this.hasHybrid = true;

    // Lap length is needed by the standings and the fuel call as well as the
    // delta, so it is resolved once here rather than where each happens to use
    // it. Ahead of buildStandings because that is now the first to want it.
    const trackLen = typeof si.lapDistance === 'number' && si.lapDistance > 1 ? si.lapDistance : 0;
    // Same track+type identity every other per-session tracker keys on, from
    // the raw feed because `session` is built a few lines further down.
    const standings = this.buildStandings(
      cars,
      focusId,
      `${si.trackName ?? ''}|${si.session ?? ''}`,
      trackLen,
    );
    const relative = this.buildRelative(cars, focus, si);
    const session = this.buildSession(cars, si, focus, this.gameState);
    const weather = this.buildWeather(si, session.type);
    const fuel = this.buildFuel(focus, session, local, cars, trackLen, playerCar);
    // Track limits ride on the DRIVEN car (like the radar) rather than the
    // broadcast focus, which may be a rival being spectated while the player
    // sits in their garage.
    //
    // Read BEFORE the delta rather than after it, which is where this used to
    // sit: the delta engine needs the stewards' cut count to know whether the
    // lap being driven can stand as a reference (see `LapValidity`), and a
    // frame-old count would attach a cut taken on the line to the wrong lap.
    const limitsBase = this.buildTrackLimits(playerCar, scoringCar, session);
    // A disqualification outranks everything else the block could say: there is
    // nothing left to serve, and the count often stays up after the verdict —
    // "1 PENALTY" over a car the stewards have excluded is the widget losing
    // the plot at the worst moment. From the standings row's own finishStatus
    // (`FSTAT_DSQ`), which is per-car and therefore already attributed.
    const dsq = playerCar ? /DSQ|DISQ/i.test(String(playerCar.finishStatus ?? '')) : false;
    // The penalty's KIND rides on the track-limits block because that is where
    // its count already lives, and the two are read together or not at all.
    const withType = !limitsBase
      ? limitsBase
      : dsq
        ? { ...limitsBase, penaltyType: 'DISQUALIFIED', disqualified: true as const }
        : limitsBase.penalties > 0
          ? { ...limitsBase, ...this.buildPenaltyType() }
          : limitsBase;
    // The sim's LIVE lap-validity verdict (countLapFlag). Only a definite
    // yes/no is forwarded: COUNT_NEITHER (out-lap, garage) and an absent
    // channel both leave the field off, so the widget shows nothing rather
    // than a stale INVALID over a car in its box.
    const clf = playerCar ? asUpper(playerCar.countLapFlag) : '';
    const lapValid =
      clf === 'COUNT_LAP_AND_TIME' ? true : clf === 'COUNT_LAP_ONLY' ? false : undefined;
    const trackLimits =
      withType && lapValid !== undefined ? { ...withType, lapValid } : withType;

    // Live delta to the focused car's own best lap (predictive; UNKNOWN until a
    // reference lap has been driven while the overlay is running). When the
    // focused car is the one driven on this PC it gets the shared-memory lap
    // clock and that car's own live speed; every other car runs the same engine
    // off the REST feed — see {@link LapDeltaTracker}.
    const restAgeSec = Math.min(0.5, Math.max(0, (nowMs - this.lastOkAt) / 1000));
    const deltaClock = this.stepDeltaClock(local ? local.elapsedSec : UNKNOWN_VALUE, nowMs);
    const localIsFocus =
      local !== null && playerCar !== undefined && focus !== undefined &&
      playerCar.slotID === focus.slotID;
    // Runs for the whole field on every frame, including while the driven car
    // has focus: stop feeding it and the first cut to a rival has no reference
    // lap to compare against.
    const playerLapValidity: LapValidity = {
      ...(trackLimits ? { cuts: trackLimits.charged, penalties: trackLimits.penalties } : {}),
      inPit: playerCar ? isInPit(playerCar) : false,
    };
    const restDeltas = this.lapDelta.update(
      cars,
      focus,
      trackLen,
      deltaClock,
      restAgeSec,
      playerCar ? { slotId: playerCar.slotID, lap: playerLapValidity } : undefined,
    );
    let deltaSec: number;
    let paceDeltas: PaceDeltas | undefined;
    if (
      localIsFocus &&
      trackLen > 0 &&
      typeof focus!.lapDistance === 'number' &&
      local!.elapsedSec > 0
    ) {
      // Position (d) from REST lap distance; time axis from the sim's real-time
      // clock (mElapsedTime, shared memory). REST timeIntoLap is a position-
      // derived estimate — identical every lap — so it can't produce a delta;
      // the sim clock genuinely differs between fast and slow laps.
      //
      // The two axes tick at very different rates: the clock is fresh every
      // frame (~30-60 Hz) but the REST position only every REFRESH_INTERVAL_MS,
      // and each snapshot is already stale by a varying few tens of ms when it
      // lands. Extrapolating it forward by (arrival age × the snapshot's own
      // velocity) gets the bulk of that back, but not the part that elapsed
      // before arrival — and at racing speed the leftover is metres, which the
      // delta divides into tenths of a second. So this is a *measurement*, not
      // the axis: RoadPosition folds it into a position integrated from the
      // car's own live speed, which is smooth and shares the delta clock's
      // buffer and instant. See {@link RoadPosition} for the full reasoning.
      const vel = focus!.carVelocity?.velocity;
      const restMps =
        typeof vel === 'number' && Number.isFinite(vel) ? Math.min(150, Math.max(0, vel)) : 0;
      const measuredM = focus!.lapDistance + restMps * restAgeSec;
      const distM = this.roadPos.step(local!.elapsedSec, measuredM, local!.speedMps, trackLen);
      const d = clamp01(distM / trackLen);
      paceDeltas = this.paceDelta.update(
        d,
        local!.elapsedSec,
        focus!.bestLapTime,
        refKeyOf(si.trackName || '', trackLen, this.playerVehicleName, playerCar?.carClass),
        // What the stewards have charged this car, so a lap that left the
        // circuit cannot become the lap every other one is measured against.
        // The same three faults the lap log voids a lap for, from the same
        // channels — see `lapLog.ts` and `LapValidity`.
        playerLapValidity,
      );
      // The training trace rides the same (d, clock) the delta just consumed,
      // plus the input/motion channels of this frame. A lap completed here
      // waits in `pendingTraces` for its lap record — see `recordLap`.
      const m = local!.motion;
      const doneTrace = this.lapTrace.update(d, local!.elapsedSec, {
        throttle: local!.throttle,
        brake: local!.brake,
        steer: local!.steer,
        gear: local!.gear,
        speedKph: local!.speedKph,
        latG: m ? m.latG : 0,
        lonG: m ? m.lonG : 0,
        tc: local!.tc,
        abs: local!.abs,
      } satisfies TraceChannels);
      if (doneTrace) {
        this.pendingTraces.push({ trace: doneTrace, wallMs: nowMs });
        // A trace whose record never arrived is not worth keeping past the
        // hold window: matching it to some later lap would be worse than
        // losing it.
        this.pendingTraces = this.pendingTraces.filter((p) => nowMs - p.wallMs < 120_000).slice(-4);
      }
      // The single-value Delta widget mirrors the pace widget's session-best
      // Delta T so both agree; fall back to the REST tracker until it arms.
      deltaSec =
        paceDeltas.tSession !== UNKNOWN_VALUE ? paceDeltas.tSession : restDeltas.tSession;
    } else {
      // Spectating: the REST engine's answer IS the pace-delta block, so the
      // predicted lap time and the session/last columns work for the focused
      // car too. Its all-time column stays unknown by design — a rival's PB
      // across sessions isn't ours to keep.
      paceDeltas = restDeltas;
      deltaSec = restDeltas.tSession;
    }
    // Which LAYOUT is loaded — read before the pace score, which cannot resolve
    // Monza, Le Mans, Fuji or Paul Ricard without it.
    this.refreshSimTrackName(session.track, nowMs);
    const paceScore = this.buildPaceScore(playerCar, session, trackLen);
    const player = this.buildPlayer(
      focus,
      standings,
      displayLocal,
      deltaSec,
      paceDeltas,
      trackLimits,
      paceScore,
      session.onTrack !== false,
    );
    // The driving aids as the car holds them, from shared memory (the driven car
    // only — every other record publishes zeros there).
    const mfd = this.buildMfd(local ? local.rearBrakeBias : undefined, local?.aidSettings);
    // One whole-field shared-memory sweep per poll, shared by the radar and the
    // track map. Both want every car's world position; reading the buffer twice
    // would double the cost of the most expensive read in the frame.
    const field = playerCar ? this.localCar.readField(playerCar.slotID) : null;
    // Radar is centred on the DRIVEN car (a driver aid), not the broadcast focus:
    // it needs that car's world position + orientation, which shared memory only
    // publishes for the car driven on this PC. Omitted when spectating.
    const radar = this.buildRadarBlips(playerCar, cars, field);
    // The circuit's shape, learned from the driven car, and where the field is
    // on it. Fed the SCENE name as the layout — Monza's two layouts share a
    // venue name, and a map keyed on the venue alone would draw one over the
    // other (the same trap `refreshSimTrackName` exists to close for pace).
    const trackMap = this.buildTrackMap(session, trackLen, playerCar, scoringCar, field, cars);
    // The lap database. Last, because it reads the results of everything above
    // (the excursion count, the pit flags) to decide whether the lap was clean.
    this.recordLap(playerCar, scoringCar, session, trackLimits, si, trackLen, nowMs);

    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      source: 'lmu',
      timestamp: nowMs,
      connected: true,
      session,
      player,
      standings,
      relative,
      ...(radar ? { radar } : {}),
      ...(trackMap ? { trackMap } : {}),
      weather,
      fuel,
      ...(mfd ? { mfd } : {}),
    };
  }

  /**
   * The controllable MFD block (pit menu + curated aids), or `undefined` when
   * the garage/pit endpoints haven't answered recently. Gated on the same
   * staleness window as tyre wear / damage so the widget never drives the MFD
   * from a menu snapshot left over from a previous session.
   */
  private buildMfd(liveRearBias?: number, liveAids?: AidSettings | null): MfdState | undefined {
    if (Date.now() - this.lastMfdOkAt >= GARAGE_STALE_AFTER_MS) return undefined;
    if (!this.pitMenuRaw && !this.garageDataRaw) return undefined;
    return buildMfdState(this.pitMenuRaw, this.garageDataRaw, liveRearBias, liveAids);
  }

  /**
   * Car-relative radar blips for the driven car. Reads every car's world
   * position + the driven car's orientation from shared memory (the only source
   * of 2-D position — the REST feed's `lapDistance` is 1-D), then hands them to
   * the shared {@link buildRadar} geometry. Class + number + faster-class come
   * from the REST standings, joined by slot id.
   *
   * Returns `undefined` — omitted, not empty — when spectating or shared memory
   * is unavailable, exactly like the motion/chassis blocks.
   */
  private buildRadarBlips(
    playerCar: RestStanding | undefined,
    cars: RestStanding[],
    field: RadarField | null,
  ): RadarBlip[] | undefined {
    if (!playerCar) return undefined;
    if (!field) {
      // Bridge an occasional torn copy (the reader missed a single frame) so the
      // radar doesn't blink to "NO RADAR DATA"; a genuine drop outlasts the hold.
      if (this.lastRadar && Date.now() - this.lastRadarAt < LOCAL_HOLD_MS) return this.lastRadar;
      return undefined;
    }

    const byId = new Map<number, RestStanding>();
    for (const c of cars) byId.set(c.slotID, c);
    const playerClass = normalizeClass(playerCar.carClass);
    const playerLaps = playerCar.lapsCompleted | 0;

    const radarCars: RadarCar[] = field.cars.map(({ slotId, pos }) => {
      const c = byId.get(slotId);
      const carClass = c ? normalizeClass(c.carClass) : undefined;
      const car: RadarCar = { slotId, pos };
      if (carClass) car.carClass = carClass;
      if (c && c.carNumber) car.carNumber = c.carNumber;
      if (isFasterClass(carClass, playerClass)) car.isFasterClass = true;
      else if (isFasterClass(playerClass, carClass)) car.slowerClass = true;
      // Laps the player has put on this car — a car a lap down is lappable
      // traffic whatever its class, so the widget ghosts it too.
      if (c) {
        const down = playerLaps - (c.lapsCompleted | 0);
        if (down >= 1) car.lapsDown = down;
      }
      return car;
    });

    const blips = buildRadar({ playerPos: field.playerPos, ori: field.ori, cars: radarCars });
    if (!blips) return undefined;
    this.lastRadar = blips;
    this.lastRadarAt = Date.now();
    return blips;
  }

  /**
   * The track-map block: teaches {@link TrackMapBuilder} where the road goes
   * from the driven car, and places every car on it.
   *
   * ## Two placements per car, because they fail differently
   * World X/Z comes from the shared-memory sweep and is the truth — a car in the
   * pit lane is drawn in the pit lane, a car running wide is drawn running wide.
   * It is also absent whenever the sim publishes no physics (spectating a
   * broadcast, the sim in menus). Lap fraction comes from the REST feed, is 1-D
   * and can only pin a car TO the path, but it survives all of that. Both are
   * sent and the widget prefers the first — the same "send what each source
   * actually knows and let the consumer choose" split the frame draws between
   * `motion` (driven car only) and `standings` (everyone).
   *
   * Returns `undefined` — omitted, not empty — when no track is loaded or no car
   * can be placed at all, so the widget can tell "between sessions" from "the
   * field is on the grid".
   */
  private buildTrackMap(
    session: SessionState,
    trackLen: number,
    playerCar: RestStanding | undefined,
    scoringCar: ScoringCar | null,
    field: RadarField | null,
    cars: RestStanding[],
  ): TrackMapState | undefined {
    if (trackLen <= 0) return undefined;

    const status = this.trackMap.update({
      trackName: session.track,
      // The SCENE name, not the venue — see the call site.
      ...(this.simTrackName ? { trackConfig: this.simTrackName } : {}),
      lengthM: trackLen,
      lapDistM:
        playerCar && typeof playerCar.lapDistance === 'number' ? playerCar.lapDistance : -1,
      pos: field ? field.playerPos : null,
      inPit: playerCar ? isInPit(playerCar) : true,
      edgeM: scoringCar ? scoringCar.trackEdgeM : null,
    });

    const posById = new Map<number, { x: number; y: number; z: number }>();
    if (field) {
      for (const c of field.cars) posById.set(c.slotId, c.pos);
      if (playerCar) posById.set(playerCar.slotID, field.playerPos);
    }

    const mapCars: TrackMapCar[] = [];
    for (const c of cars) {
      const car: TrackMapCar = {
        slotId: c.slotID,
        inPit: isInPit(c),
        isPlayer: playerCar !== undefined && c.slotID === playerCar.slotID,
      };
      const p = posById.get(c.slotID);
      if (p) {
        car.x = round2(p.x);
        car.y = round2(p.y);
        car.z = round2(p.z);
      }
      if (typeof c.lapDistance === 'number' && c.lapDistance >= 0 && c.lapDistance <= trackLen) {
        car.lapFraction = Math.round((c.lapDistance / trackLen) * 10000) / 10000;
      }
      // A car with neither placement is a scoring record we cannot draw; sending
      // it would put a dot on the start line for every car sitting in a garage.
      if (car.x !== undefined || car.lapFraction !== undefined) mapCars.push(car);
    }
    if (!mapCars.length && !status.ready) return undefined;

    return {
      key: status.key,
      revision: status.revision,
      ready: status.ready,
      progress: Math.round(status.progress * 1000) / 1000,
      ...(status.relearning ? { relearning: true } : {}),
      cars: mapCars,
    };
  }

  private buildStandings(
    cars: RestStanding[],
    focusId: number,
    sessionKey: string,
    trackLen: number,
  ): StandingEntry[] {
    // Rolling last-5 pace for the whole field, fed from this same poll — see
    // telemetry/paceAverage for what counts as a keepable lap.
    const avgBySlot = this.paceAvg.update(
      cars.map((c) => ({
        slotId: c.slotID,
        lapsCompleted: Math.max(0, c.lapsCompleted | 0),
        lastLapSec: posOrUnknown(c.lastLapTime),
        inPit: isInPit(c),
      })),
      sessionKey,
    );
    const rows = cars.map((c) => {
      const ranks = this.driverRanksFor(c.driverName);
      const lastS1 = posOrUnknown(c.lastSectorTime1);
      const lastS2 = posOrUnknown(c.lastSectorTime2);
      return {
      slotId: c.slotID,
      position: c.position,
      driverName: c.driverName || `#${c.carNumber ?? c.slotID}`,
      carNumber: c.carNumber || undefined,
      carClass: normalizeClass(c.carClass),
      manufacturer: c.carId ? this.manufacturerById.get(c.carId) : undefined,
      driverBadge: this.driverBadgeFor(c.driverName),
      driverRank: ranks?.driver,
      safetyRank: ranks?.safety,
      gridPosition:
        typeof c.qualification === 'number' && c.qualification > 0 ? c.qualification : undefined,
      gapToLeaderSec: posOrUnknown(c.timeBehindLeader),
      gapToAheadSec: posOrUnknown(c.timeBehindNext),
      lapsBehind: Math.max(0, c.lapsBehindLeader | 0),
      // Track position, so `assignClassPositions` can COUNT laps down within the
      // class instead of differencing two cars' laps down to the overall leader
      // — see the note there.
      ...lapFractionOf(c.lapDistance as number, trackLen),
      bestLapSec: posOrUnknown(c.bestLapTime),
      lastLapSec: posOrUnknown(c.lastLapTime),
      ...(lastS1 !== UNKNOWN_VALUE ? { lastSector1Sec: lastS1 } : {}),
      ...(lastS2 !== UNKNOWN_VALUE ? { lastSector2Sec: lastS2 } : {}),
      avg5Sec: avgBySlot.get(c.slotID),
      lapsCompleted: Math.max(0, c.lapsCompleted | 0),
      inPit: isInPit(c),
      pitStops: typeof c.pitstops === 'number' ? c.pitstops : undefined,
      // LMU publishes a 0..1 energy fraction per car (its overlay shows this to
      // the cars ahead), but a car/class that isn't running a virtual-energy
      // budget reports a flat 0 all race (seen on LMP2). That must read as "not
      // applicable" (—), NOT a red "0%" that looks like a car out of energy. So
      // treat a positive fraction as a real reading and anything <= 0 (or the
      // field being absent) as unknown.
      virtualEnergy:
        typeof c.veFraction === 'number' && c.veFraction > 0 ? clamp01(c.veFraction) : undefined,
      // Highlight the car currently in broadcast focus.
      isPlayer: c.slotID === focusId,
      };
    });
    rows.sort((a, b) => a.position - b.position);
    assignClassPositions(rows);
    return rows;
  }

  /**
   * Cars physically nearest the focused car on track, with a signed time gap
   * (positive = ahead of the focus car on the road, negative = behind).
   *
   * The gap is the difference between the two cars' `timeBehindLeader`. Both are
   * measured by the sim against the same reference — the overall leader — at the
   * same instant, so the leader term cancels and what is left is the time gap
   * between those two cars. It is exactly the quantity the standings tower shows
   * as an interval (`assignClassPositions` differences the same field), which is
   * the point: two panels claiming to show the gap to the car behind you must
   * not be able to disagree, and deriving them from one number is the only way
   * to guarantee they can't.
   *
   * Three models have been tried:
   * - `timeIntoLap` clock difference: rejected. A car's clock only resets at the
   *   line, so a different-pace car's "gap" freezes mid-lap and jumps by a whole
   *   lap time whenever it crosses the line (its clock wraps on a different
   *   period than the focus car's) — structurally wrong across classes.
   * - Distance × pace: the previous model, and the cause of the mismatch above.
   *   Converting a road gap at the car's LAP-AVERAGE pace silently assumes the
   *   stretch of track between the two cars is covered at the average speed. It
   *   never is: the same 500 m is ~6 s of hairpin or ~2.5 s of straight. Against
   *   a captured field it over-read by 60% on cars sitting on a straight and
   *   under-read by 30% on cars in a slow section — a tester reading the gap to
   *   the car behind saw it disagree with the standings, and the standings were
   *   the ones telling the truth.
   * - The sim's own timing (this one): correct by construction, at any point on
   *   the lap, across classes, because the sim is timing the cars rather than
   *   inferring them.
   *
   * The distance model stays as the fallback for cars the sim publishes no gap
   * for (in the garage, or not yet timed) and to order the rows, and to sanity
   * check the sign — see the loop below.
   *
   * NOTE `estimatedLapTime` is a session-wide pace figure (observed identical
   * across classes), NOT this car's own pace — using it scaled every gap by the
   * fastest class's pace (~20% short for a GT3). The focus car's own sane
   * bestLapTime is required first.
   *
   * Cars parked in their garage stall are excluded: they aren't on the road, and
   * would otherwise pin phantom entries near the pit straight.
   */
  private buildRelative(
    cars: RestStanding[],
    focus: RestStanding | undefined,
    si: RestSession,
  ): RelativeEntry[] {
    if (!focus || typeof focus.lapDistance !== 'number') return [];
    const trackLength = typeof si.lapDistance === 'number' && si.lapDistance > 1 ? si.lapDistance : 0;
    // The focus car's own lap time, for converting road distance → seconds.
    // Guard bestLapTime against junk (LMU can report hundreds of seconds before
    // a clean lap), fall back to the session estimate, then a safe constant.
    const lapTime =
      focus.bestLapTime > 5 && focus.bestLapTime < 600
        ? focus.bestLapTime
        : focus.estimatedLapTime && focus.estimatedLapTime > 0
          ? focus.estimatedLapTime
          : 90;
    const focusLaps = focus.lapsCompleted | 0;

    // Dead-reckoning: the REST snapshot is up to one refresh old (~150 ms), and
    // rendering it as-is makes the widget visibly lag the in-game relative. Each
    // car's road position is extrapolated forward by its own velocity times the
    // snapshot's age, so the 30 Hz frames move smoothly between REST refreshes.
    // Pure per-car arithmetic — no extra polling or I/O.
    const ageSec = Math.min(0.5, Math.max(0, (Date.now() - this.lastOkAt) / 1000));
    const speedOf = (c: RestStanding): number =>
      c.carVelocity &&
      typeof c.carVelocity.velocity === 'number' &&
      Number.isFinite(c.carVelocity.velocity)
        ? Math.min(150, Math.max(0, c.carVelocity.velocity)) // m/s, forward only
        : 0;
    const roadDist = (c: RestStanding): number => (c.lapDistance as number) + speedOf(c) * ageSec;
    const focusDist = roadDist(focus);
    const focusVel = speedOf(focus);

    /**
     * This car's gap to the overall leader, or `null` when the sim has not timed
     * it. The leader's own `0` is a real reading; anyone else's is the field
     * being unset (a car in the garage, or one the sim has not placed yet), and
     * treating that as "level with the leader" would put a phantom car on top of
     * whoever is out front.
     */
    const leaderTime = (c: RestStanding): number | null =>
      typeof c.timeBehindLeader === 'number' &&
      Number.isFinite(c.timeBehindLeader) &&
      (c.timeBehindLeader > 0 || c.position === 1)
        ? c.timeBehindLeader
        : null;
    const focusTime = leaderTime(focus);
    const halfLap = lapTime / 2;

    const rows: Array<{ c: RestStanding; gap: number }> = [];
    for (const c of cars) {
      if (c.slotID === focus.slotID || typeof c.lapDistance !== 'number') continue;
      if (c.inGarageStall === true) continue; // parked in the garage, not on the road
      // Wrapped road distance to the nearest way round, so a car just across the
      // line reads as a small gap, not a whole lap.
      let d = roadDist(c) - focusDist;
      if (trackLength > 0) {
        const half = trackLength / 2;
        if (d > half) d -= trackLength;
        else if (d < -half) d += trackLength;
      }
      const denom = trackLength > 0 ? trackLength : Math.max(1, Math.abs(c.lapDistance) || 1);
      const roadGap = (d / denom) * lapTime;

      const carTime = leaderTime(c);
      let gap = roadGap;
      if (focusTime !== null && carTime !== null) {
        // Ahead = closer to the leader = a SMALLER gap to it, so the subtraction
        // is this way round to land on "positive = ahead".
        let sim = focusTime - carTime;
        // The same half-lap wrap the distance gets, for the same reason: two
        // cars either side of the line hold leader-gaps at opposite ends of a
        // lap, and the short way round is the one on the road between them.
        if (sim > halfLap) sim -= lapTime;
        else if (sim < -halfLap) sim += lapTime;
        // The snapshot is up to one refresh old (~150 ms) and the widget renders
        // at 30 Hz, so without this the number visibly steps. Extrapolate the
        // closing distance over the snapshot's age and convert it at the speed
        // the cars are ACTUALLY doing — the mistake this whole function just
        // stopped making was converting at the lap average.
        const vRef = Math.max(5, (speedOf(c) + focusVel) / 2);
        sim += ((speedOf(c) - focusVel) * ageSec) / vRef;
        // Both sources agree on which side of us a car is, or one of them is
        // wrong. Past the noise floor a disagreement means the sim's figure is
        // stale (or belongs to a car mid-wrap), and road distance is the reading
        // that cannot be stale — so it takes the row back.
        const disagrees =
          Math.abs(sim) > 0.5 && Math.abs(roadGap) > 0.5 && sim > 0 !== roadGap > 0;
        if (!disagrees) gap = sim;
      }
      rows.push({ c, gap });
    }
    // Descending: physically furthest ahead first, furthest behind last — the
    // top-to-bottom order a relative display reads in.
    rows.sort((a, b) => b.gap - a.gap);

    const focusClass = normalizeClass(focus.carClass);
    const now = Date.now();

    const toEntry = (c: RestStanding, gap: number, isPlayer: boolean): RelativeEntry => {
      const carClass = normalizeClass(c.carClass);
      const lapsDifference = isPlayer ? 0 : (c.lapsCompleted | 0) - focusLaps;
      const inPit = isInPit(c);
      const ranks = this.driverRanksFor(c.driverName);
      const entry: RelativeEntry = {
        slotId: c.slotID,
        position: c.position,
        driverName: c.driverName || `#${c.carNumber ?? c.slotID}`,
        carNumber: c.carNumber || undefined,
        carClass,
        manufacturer: c.carId ? this.manufacturerById.get(c.carId) : undefined,
        driverBadge: this.driverBadgeFor(c.driverName),
        driverRank: ranks?.driver,
        safetyRank: ranks?.safety,
        relativeGapSec: round2(gap),
        lapsDifference,
        inPit,
        isPlayer,
      };
      if (isPlayer) return entry;

      const faster = isFasterClass(carClass, focusClass);
      const closing = this.closingRate(c.slotID, gap, now);
      entry.isFasterClass = faster;
      entry.closingRateSec = closing;
      const traffic = {
        gapSec: gap,
        lapsDifference,
        fasterClass: faster,
        slowerClass: isFasterClass(focusClass, carClass),
        closingRateSec: closing,
        inPit,
      };
      entry.yieldTo = shouldYield(traffic);
      entry.trafficAhead = shouldWarnTraffic(traffic);
      return entry;
    };

    // Forget cars that have left the session, so the history can't grow without
    // bound across a long stream with rolling grids.
    if (this.gapHistory.size > cars.length + 8) {
      const live = new Set(cars.map((c) => c.slotID));
      for (const slot of this.gapHistory.keys()) {
        if (!live.has(slot)) this.gapHistory.delete(slot);
      }
    }

    // Nearest 3 each way, keeping road order: the rows read furthest-ahead →
    // nearest-ahead → YOU → nearest-behind → furthest-behind.
    const ahead = rows.filter((r) => r.gap > 0).slice(-3);
    const behind = rows.filter((r) => r.gap <= 0).slice(0, 3);
    return [
      ...ahead.map((r) => toEntry(r.c, r.gap, false)),
      toEntry(focus, 0, true),
      ...behind.map((r) => toEntry(r.c, r.gap, false)),
    ];
  }

  /**
   * How fast a car is closing on the player, in seconds of gap per second.
   * Positive = the gap is shrinking (closing), negative = opening.
   *
   * Measured on the **absolute** gap so it means the same thing for a car ahead
   * as for one behind. Sampled over {@link CLOSING_WINDOW_MS} rather than
   * differenced per frame — see that constant for why — and the previous result
   * is held between windows so the value is stable to display.
   *
   * @returns The rate, or {@link UNKNOWN_VALUE} until a full window has elapsed.
   */
  private closingRate(slotId: number, gap: number, nowMs: number): number {
    const prev = this.gapHistory.get(slotId);
    if (!prev) {
      this.gapHistory.set(slotId, { gap, at: nowMs, rate: UNKNOWN_VALUE });
      return UNKNOWN_VALUE;
    }
    const dtMs = nowMs - prev.at;
    if (dtMs < CLOSING_WINDOW_MS) return prev.rate;

    // A car that laps the player (or is lapped) wraps its gap through a whole
    // lap; that step is not closing speed, so the window is discarded.
    const jumped = Math.abs(Math.abs(gap) - Math.abs(prev.gap)) > 10;
    const rate = jumped ? UNKNOWN_VALUE : round2(((Math.abs(prev.gap) - Math.abs(gap)) * 1000) / dtMs);
    this.gapHistory.set(slotId, { gap, at: nowMs, rate });
    return rate;
  }

  private buildSession(
    cars: RestStanding[],
    si: RestSession,
    focus: RestStanding | undefined,
    gs: RestGameState | null,
  ): SessionState {
    const leaderLaps = cars.reduce((m, c) => Math.max(m, c.lapsCompleted | 0), 0);
    const endET = typeof si.endEventTime === 'number' ? si.endEventTime : 0;
    const curET = typeof si.currentEventTime === 'number' ? si.currentEventTime : 0;
    // Prefer LMU's own "time left in the current phase" — during a green timed
    // race this is the authoritative countdown to the checker, and it stays
    // sane when the event-time clock has drifted past endEventTime. Fall back to
    // end − current when the phase field is missing.
    const phaseRemain =
      typeof si.timeRemainingInGamePhase === 'number' ? si.timeRemainingInGamePhase : -1;
    const timeRemaining =
      phaseRemain > 0 && phaseRemain < 100000
        ? Math.round(phaseRemain)
        : endET > 0
          ? Math.max(0, endET - curET)
          : UNKNOWN_VALUE;
    // maximumLaps is a large sentinel (uint max) for timed races.
    const maxLaps =
      typeof si.maximumLaps === 'number' && si.maximumLaps > 0 && si.maximumLaps < 100000
        ? si.maximumLaps
        : 0;
    // For a timed race LMU only gives a clock, not laps-to-go. Estimate it from
    // the time left and the leader's lap pace (their estimated/best lap), so the
    // standings can show "~N laps left" alongside the countdown. The race ends
    // when the leader next crosses the line after the clock hits zero, so round
    // up and keep at least one lap while the clock is running.
    const leader = cars.find((c) => c.position === 1);
    const leaderPace =
      leader && typeof leader.estimatedLapTime === 'number' && leader.estimatedLapTime > 0
        ? leader.estimatedLapTime
        : leader && leader.bestLapTime > 0
          ? leader.bestLapTime
          : focus && focus.bestLapTime > 0
            ? focus.bestLapTime
            : 0;
    const lapsRemaining =
      maxLaps === 0 && timeRemaining > 0 && leaderPace > 0
        ? Math.max(1, Math.ceil(timeRemaining / leaderPace))
        : UNKNOWN_VALUE;
    // Prefer the focused car's flag/phase strings (reliable); then
    // GetGameState's GPHASE_* string, which exists even before any car does
    // (GPHASE_BEFORE while the session loads); sessionInfo's gamePhase is
    // numeric and only stands in when it happens to arrive as a string.
    const phaseStr = focus?.gamePhase ?? gs?.gamePhase ?? si.gamePhase;
    const phase = mapPhase(phaseStr);
    // The full booked length, which is `endEventTime` — LMU publishes that as
    // soon as the session is loaded, well before the clock starts running, which
    // is exactly the window the pre-session header exists for. `timeRemaining`
    // above cannot stand in for it: during the garage phase it is either the
    // whole length (indistinguishable, but only by luck) or the countdown to the
    // green flag (badly wrong — a "5 MIN" practice session that is actually 30).
    const scheduledLengthSec =
      endET > 0 && endET < 100000 ? Math.round(endET) : UNKNOWN_VALUE;
    // The start gantry, passed through whenever the channel is present — the
    // widget needs the resting frame 0 too, so it can tell "gantry dark" from
    // "no gantry channel at all".
    const startLights =
      typeof si.startLightFrame === 'number' &&
      typeof si.numRedLights === 'number' &&
      si.numRedLights > 0 &&
      si.numRedLights <= 10 &&
      si.startLightFrame >= 0
        ? { frame: si.startLightFrame, total: si.numRedLights }
        : undefined;
    // Per-sector marshalling. LMU writes "UNKNOWN" for a clear sector and
    // "YELLOW" for one with a hazard; anything unrecognised reads as clear
    // rather than inventing a flag the sim is not showing.
    const rawSectors = Array.isArray(si.sectorFlag) ? si.sectorFlag : null;
    const sectorFlags =
      rawSectors && rawSectors.length >= 3
        ? (rawSectors.slice(0, 3).map((s) => (asUpper(s) === 'YELLOW' ? 'yellow' : 'none')) as [
            FlagState,
            FlagState,
            FlagState,
          ])
        : undefined;
    // The FCY/safety-car channel outranks the per-car strings for the global
    // flag: it is the one place a full-course yellow is published (per-car
    // flags stayed GREEN through every probe).
    const fcy = asUpper(si.yellowFlagState);
    const flag: FlagState =
      fcy && fcy !== 'NONE' ? 'yellow' : mapFlag(focus?.flag ?? phaseStr);
    // Two independent reads of "is the driver actually at the wheel", because
    // LMU splits the truth between them (both probed live, 2026-08-06/07,
    // Daytona):
    //
    //   - sessionInfo's NUMERIC gamePhase flips to 9 for the ESC/monitor
    //     screen — but stays at the running phase (5) for the garage pages:
    //     pit strategy, car setup. ~10 round-trips, no false reads.
    //   - shared memory's mInRealtime is 0 on exactly those garage pages and
    //     1 in the car — but does NOT flip for the ESC screen (the driver is
    //     still in the world, the sim is just paused over it).
    //
    // So each covers the other's blind spot and hiding needs either to say
    // "in menus". Both fail safe: a missing/string-typed phase and a dead
    // shared-memory mapping (null) each count as at-the-wheel, so on a rig
    // where a channel is broken the overlays can never be wrongly hidden —
    // that rig just keeps a smaller set of screens that auto-hide.
    const uiPhase = Number(si.gamePhase);
    const inEscMenu = Number.isFinite(uiPhase) && uiPhase === 9;
    const inGaragePages = this.localCar.inRealtime() === false;
    return {
      type: mapSessionType(si.session),
      phase,
      flag,
      track: si.trackName || 'Unknown',
      timeRemainingSec: timeRemaining,
      totalLaps: maxLaps,
      lapsRemaining,
      currentLap: leaderLaps + 1,
      numCars: typeof si.numberOfVehicles === 'number' ? si.numberOfVehicles : cars.length,
      notStarted: isPreGreen(phase),
      scheduledLengthSec,
      onTrack: !inEscMenu && !inGaragePages,
      ...(startLights ? { startLights } : {}),
      ...(sectorFlags ? { sectorFlags } : {}),
    };
  }

  private buildWeather(
    si: RestSession,
    sessionType: SessionType,
  ): {
    trackTempC: number;
    ambientTempC: number;
    rainIntensity: number;
    trackWetness: number;
    forecast: WeatherForecastSlot[];
  } {
    const trackT = round1(num(si.trackTemp));
    const rain = clamp01(num(si.raining));
    const wet = clamp01(num(si.maxPathWetness));
    const sky: SkyState = rain > 0.5 ? 'rain' : rain > 0.05 ? 'lightRain' : 'partlyCloudy';
    return {
      trackTempC: trackT,
      ambientTempC: round1(num(si.ambientTemp)),
      rainIntensity: round2(rain),
      trackWetness: round2(wet),
      ...this.buildTrackCondition(si),
      forecast: this.buildForecast(sessionType, trackT, rain, sky),
    };
  }

  /**
   * The racing surface in words, plus which way it is going.
   *
   * ## What this is, and what it is not
   * LMU's own MFD carries a track readout, and this is the part of it that can
   * be sourced honestly. The feed publishes the **wetness** of the circuit at
   * three points — driest, wettest and average (`min`/`max`/`averagePathWetness`)
   * — and that is what the DRY…SATURATED scale below is built from. It does NOT
   * publish the *rubbering-in* level, so nothing here claims to know it: no REST
   * endpoint carries it, and the shared-memory buffers that might
   * (`Extended`, `PitInfo`) read empty. `scripts/probe-lmu-penalty.js` watches
   * both if it ever starts appearing.
   *
   * ## Why a band and not a percentage
   * "41%" answers how wet and not what to do about it. The decision a driver is
   * actually making — which tyre, how much lift — changes at the boundaries, so
   * the boundaries are what gets named. The percentage stays alongside for
   * anyone who wants it.
   *
   * ## Why the trend needs a history and not two samples
   * Wetness moves slowly and the feed jitters, so consecutive polls disagree in
   * both directions all the time; differencing them would report a track
   * flickering between drying and wetting. The comparison is against a reading
   * from minutes ago, which is the timescale the surface actually changes on.
   */
  private buildTrackCondition(
    si: RestSession,
  ): Partial<Pick<WeatherState, 'trackCondition' | 'trackTrend' | 'trackSpread'>> {
    const max = typeof si.maxPathWetness === 'number' ? clamp01(si.maxPathWetness) : -1;
    if (max < 0) return {};
    const min = typeof si.minPathWetness === 'number' ? clamp01(si.minPathWetness) : -1;
    const avg = typeof si.averagePathWetness === 'number' ? clamp01(si.averagePathWetness) : max;

    const now = Date.now();
    this.wetHistory.push({ at: now, wet: avg });
    while (this.wetHistory.length > 1 && now - this.wetHistory[0]!.at > WET_TREND_WINDOW_MS) {
      this.wetHistory.shift();
    }
    const oldest = this.wetHistory[0]!;
    const spanMs = now - oldest.at;
    let trend: 'drying' | 'wetting' | 'steady' = 'steady';
    if (spanMs > WET_TREND_WINDOW_MS / 2) {
      const change = avg - oldest.wet;
      if (change > WET_TREND_MIN) trend = 'wetting';
      else if (change < -WET_TREND_MIN) trend = 'drying';
    }

    const out: Partial<Pick<WeatherState, 'trackCondition' | 'trackTrend' | 'trackSpread'>> = {
      trackCondition: wetnessBand(max),
      trackTrend: trend,
    };
    if (min >= 0) out.trackSpread = round2(Math.max(0, max - min));
    return out;
  }

  /**
   * Real forecast timeline from `/rest/sessions/weather` for the running session
   * (`START → 25/50/75% → FINISH`), each slot carrying rain chance, temperature,
   * humidity, wind and sky. Falls back to a flat projection of the current
   * conditions when the forecast endpoint hasn't answered yet (e.g. in menus).
   */
  private buildForecast(
    sessionType: SessionType,
    nowTempC: number,
    nowRain: number,
    nowSky: SkyState,
  ): WeatherForecastSlot[] {
    const block = this.weatherForecast ? pickWeatherBlock(this.weatherForecast, sessionType) : null;
    if (block) {
      const slots: WeatherForecastSlot[] = [];
      for (const { key, label } of WEATHER_PHASES) {
        const node = block[key];
        if (!node) continue;
        const chance = clamp01(num(node.WNV_RAIN_CHANCE?.currentValue) / 100);
        const temp = round1(num(node.WNV_TEMPERATURE?.currentValue));
        const skyState = mapSky(node.WNV_SKY);
        slots.push({
          minutesAhead: UNKNOWN_VALUE,
          label,
          rainChance: round2(chance),
          rainIntensity: skyRainIntensity(skyState, chance),
          trackTempC: temp,
          airTempC: temp,
          humidityPct: Math.round(num(node.WNV_HUMIDITY?.currentValue)),
          windKph: Math.round(num(node.WNV_WINDSPEED?.currentValue)),
          sky: skyState,
        });
      }
      if (slots.length > 0) return slots;
    }
    // Fallback: project current conditions forward so the strip still renders.
    return [0, 15, 30, 45, 60].map((minutesAhead) => ({
      minutesAhead,
      rainChance: nowRain > 0 ? round2(nowRain) : 0,
      rainIntensity: round2(nowRain),
      trackTempC: nowTempC,
      airTempC: nowTempC,
      sky: nowSky,
    }));
  }

  /**
   * Fuel strategy for the focused car. The REST API gives fuel as a *fraction*
   * of the tank (0..1), not litres, and no tank capacity for a spectated car, so
   * we run the calculator in fraction units to derive the unit-independent
   * numbers that matter to a director — laps of fuel left and the pit window —
   * and leave the litre readouts unknown.
   */
  private buildFuel(
    focus: RestStanding | undefined,
    session: SessionState,
    local: LocalCarPhysics | null,
    cars: RestStanding[],
    trackLen: number,
    playerCar: RestStanding | undefined,
  ) {
    // How far round the lap a car is. The "pit this lap" alarm asks about the
    // road ahead, not the tank alone, so it needs this; REST's own lap distance
    // is plenty here, where a metre is worth microlitres.
    //
    // Taken from whichever car the fuel figure belongs to, which is not always
    // the focused one: the litres come from the DRIVEN car's shared memory, and
    // while spectating a rival that car is somewhere else entirely on the
    // circuit. Reading one car's tank against another car's position would put
    // the alarm's "can I even reach the line" net at the wrong point on track.
    const fracOf = (c: RestStanding | undefined): number =>
      c && typeof c.lapDistance === 'number' && trackLen > 0
        ? clamp01(c.lapDistance / trackLen)
        : UNKNOWN_VALUE;

    // Burn history is only evidence about the car and session it was measured
    // in — see {@link fuelSessionKey} / {@link fuelFocusSlot}. Dropped before
    // anything is fed in, so no sample can straddle the change.
    const sessionKey = `${session.track}|${session.type}`;
    if (sessionKey !== this.fuelSessionKey) {
      this.fuelSessionKey = sessionKey;
      this.localFuel.reset();
      this.fuel.reset();
      this.energyCalc.reset();
      this.fuelFocusSlot = focus ? focus.slotID : null;
    }
    const focusSlot = focus ? focus.slotID : null;
    if (focusSlot !== this.fuelFocusSlot) {
      this.fuelFocusSlot = focusSlot;
      this.fuel.reset();
      this.energyCalc.reset();
    }
    // Only a race has a finish to run to; see {@link FuelUpdate.isRace}.
    const isRace = session.type === 'race';

    // Virtual energy is a property of the focused car (it comes from that car's
    // own REST record), so it keeps the focused car's position.
    const energy = this.buildEnergy(focus, session, cars, fracOf(focus), isRace);

    // Prefer the locally-driven car's real litres from shared memory: gives the
    // full fuel widget (per-lap, to-finish, margin) instead of laps-only.
    if (local && local.capacityLiters > 0) {
      const s = this.localFuel.update({
        currentFuelLiters: local.fuelLiters,
        capacityLiters: local.capacityLiters,
        lapsCompleted: local.lapNumber,
        totalRaceLaps: session.totalLaps,
        timeRemainingSec: session.timeRemainingSec,
        avgLapTimeSec: focus && focus.bestLapTime > 0 ? focus.bestLapTime : 90,
        lapFraction: fracOf(playerCar),
        isRace,
        // The litres come from the DRIVEN car, so it is that car's pit state
        // that says whether this lap is a measurement — the focused car may be
        // someone else's, sitting in their own box.
        inPit: playerCar !== undefined && isOnPitLane(playerCar),
      });
      return this.withPitCall(
        { ...s, ...energy },
        s.pitThisLap === true,
        energy.pitThisLap === true,
        playerCar ?? focus,
      );
    }

    const frac = focus && typeof focus.fuelFraction === 'number' ? clamp01(focus.fuelFraction) : -1;
    if (frac < 0) {
      return this.withPitCall(
        {
          levelLiters: UNKNOWN_VALUE,
          capacityLiters: UNKNOWN_VALUE,
          perLapAvgLiters: UNKNOWN_VALUE,
          lapsRemaining: UNKNOWN_VALUE,
          lapsToFinish: UNKNOWN_VALUE,
          fuelToFinishLiters: UNKNOWN_VALUE,
          fuelDeltaLiters: UNKNOWN_VALUE,
          refuelToFinishLiters: 0,
          ...energy,
        },
        false,
        energy.pitThisLap === true,
        focus,
      );
    }
    const laps = focus ? focus.lapsCompleted | 0 : 0;
    const avgLap = focus && focus.bestLapTime > 0 ? focus.bestLapTime : 90;
    const s = this.fuel.update({
      currentFuelLiters: frac, // fraction treated as the unit
      capacityLiters: 1, // full tank == 1.0
      lapsCompleted: laps,
      totalRaceLaps: session.totalLaps,
      timeRemainingSec: session.timeRemainingSec,
      avgLapTimeSec: avgLap,
      lapFraction: fracOf(focus),
      isRace,
      inPit: focus !== undefined && isOnPitLane(focus),
    });
    // Keep the unit-independent numbers; blank the litre-denominated ones since
    // we don't know the tank size for a spectated car.
    return this.withPitCall(
      {
        levelLiters: UNKNOWN_VALUE,
        capacityLiters: UNKNOWN_VALUE,
        perLapAvgLiters: UNKNOWN_VALUE,
        lapsRemaining: s.lapsRemaining,
        lapsToFinish: s.lapsToFinish,
        fuelToFinishLiters: UNKNOWN_VALUE,
        fuelDeltaLiters: UNKNOWN_VALUE,
        refuelToFinishLiters: 0,
        pitWindowOpenLap: s.pitWindowOpenLap,
        ...energy,
      },
      s.pitThisLap === true,
      energy.pitThisLap === true,
      focus,
    );
  }

  /**
   * Apply {@link resolvePitCall} to a finished fuel block. The decision itself
   * is pure and lives with the calculator; this only supplies the sim-shaped
   * half of it — whether the car is actually in the pits.
   */
  private withPitCall(
    base: FuelState,
    fuelArmed: boolean,
    energyArmed: boolean,
    focus: RestStanding | undefined,
  ): FuelState {
    const inPit = focus !== undefined && (focus.pitting === true || focus.inGarageStall === true);
    return resolvePitCall(base, fuelArmed, energyArmed, inPit);
  }

  /**
   * Virtual-energy strategy for the focused car (LMU's per-car energy budget,
   * the resource that actually limits an LMU stint). Runs a fuel calculator in
   * percent units over `veFraction`: remaining %, average % per lap, laps left
   * on energy and the margin at the flag. Empty when the car/class doesn't run
   * a VE budget (the field reads a flat 0 — see {@link buildStandings}).
   */
  private buildEnergy(
    focus: RestStanding | undefined,
    session: SessionState,
    cars: RestStanding[],
    lapFraction: number,
    isRace: boolean,
  ): Partial<
    Pick<
      FuelState,
      | 'virtualEnergyPct'
      | 'virtualEnergyPerLapPct'
      | 'virtualEnergyLapsRemaining'
      | 'virtualEnergyDeltaPct'
      | 'pitThisLap'
    >
  > {
    const ve =
      focus && typeof focus.veFraction === 'number' && focus.veFraction > 0
        ? clamp01(focus.veFraction)
        : -1;
    if (ve < 0 || !focus) return {};
    const avgLap = focus.bestLapTime > 5 && focus.bestLapTime < 600 ? focus.bestLapTime : 90;
    const s = this.energyCalc.update({
      currentFuelLiters: ve * 100, // percent units
      capacityLiters: 100,
      lapsCompleted: focus.lapsCompleted | 0,
      totalRaceLaps: session.totalLaps,
      timeRemainingSec: session.timeRemainingSec,
      avgLapTimeSec: avgLap,
      lapFraction,
      isRace,
      inPit: isOnPitLane(focus),
    });
    const out: Partial<
      Pick<
        FuelState,
        | 'virtualEnergyPct'
        | 'virtualEnergyPerLapPct'
        | 'virtualEnergyLapsRemaining'
        | 'virtualEnergyDeltaPct'
        | 'pitThisLap'
      >
    > = { virtualEnergyPct: round1(ve * 100) };
    if (s.perLapAvgLiters !== UNKNOWN_VALUE) out.virtualEnergyPerLapPct = s.perLapAvgLiters;
    if (s.lapsRemaining !== UNKNOWN_VALUE) out.virtualEnergyLapsRemaining = s.lapsRemaining;
    if (s.fuelDeltaLiters !== UNKNOWN_VALUE) out.virtualEnergyDeltaPct = s.fuelDeltaLiters;
    if (s.pitThisLap) out.pitThisLap = true;
    Object.assign(out, this.buildEnergyOverlap(focus, cars, s.perLapAvgLiters, s.lapsRemaining));
    return out;
  }

  /**
   * "How many cars ahead of me have to pit before I do?" — the energy-overlap
   * readout. Each such car is a position that comes back on strategy alone,
   * without having to pass anyone on track.
   *
   * ### Why this is restricted to the player's own class
   * LMU publishes every car's remaining energy **fraction**, but not its burn
   * rate, so a car's remaining *laps* has to be estimated from someone else's
   * burn. That estimate only holds for cars running the same energy allocation
   * at a similar pace — i.e. the same class. Applying the player's GT3 burn to a
   * Hypercar's fraction would invent a number, so cross-class cars are excluded
   * from the count rather than guessed at, and {@link FuelState.veCarsAheadCompared}
   * reports how many cars the answer was actually drawn from.
   *
   * @param perLapPct - The player's average energy burn, percentage points per
   *                   lap. The whole readout is unavailable until this is known,
   *                   which takes a couple of green laps.
   * @param playerLapsLeft - The player's own laps-remaining-on-energy.
   */
  private buildEnergyOverlap(
    focus: RestStanding,
    cars: RestStanding[],
    perLapPct: number,
    playerLapsLeft: number,
  ): Partial<Pick<FuelState, 'veCarsAheadPittingFirst' | 'veCarsAheadCompared' | 'veLapsInHandVsNext'>> {
    if (perLapPct === UNKNOWN_VALUE || perLapPct <= 0 || playerLapsLeft === UNKNOWN_VALUE) return {};
    const playerClass = normalizeClass(focus.carClass);
    if (!playerClass) return {};

    let compared = 0;
    let pittingFirst = 0;
    // Laps in hand over the car that is forced in soonest — that is the one
    // whose stop the player can respond to first.
    let bestMargin = -1;

    for (const c of cars) {
      if (c.slotID === focus.slotID) continue;
      if (c.position >= focus.position) continue; // only cars AHEAD
      if (normalizeClass(c.carClass) !== playerClass) continue;
      if (typeof c.veFraction !== 'number' || c.veFraction <= 0) continue;

      compared++;
      const lapsLeft = (clamp01(c.veFraction) * 100) / perLapPct;
      const margin = playerLapsLeft - lapsLeft;
      if (margin > 0) {
        pittingFirst++;
        if (margin > bestMargin) bestMargin = margin;
      }
    }

    if (compared === 0) return {};
    const out: Partial<
      Pick<FuelState, 'veCarsAheadPittingFirst' | 'veCarsAheadCompared' | 'veLapsInHandVsNext'>
    > = { veCarsAheadPittingFirst: pittingFirst, veCarsAheadCompared: compared };
    if (bestMargin > 0) out.veLapsInHandVsNext = round1(bestMargin);
    return out;
  }

  /**
   * Player (focused-car) state. Position and lap timing come from the REST
   * standings; **pedal inputs and tyre temps are left unknown** because LMU does
   * not publish physics channels for a car that is only being spectated (they
   * exist in shared memory only for a car driven on this PC).
   */
  /**
   * Physics for the broadcast-focused car when NOBODY is driving on this PC —
   * the spectator path. LMU publishes a telemetry record for every car in the
   * field, and a live probe against a remote car (`scripts/
   * probe-lmu-spectator.js`, Spa team race 2026-08-15) settled which channels
   * the sim actually fills for cars it does not simulate locally:
   *
   *   LIVE  gear, rpm, maxRpm, speed, unfiltered throttle/brake/steering,
   *         filtered throttle/brake (so the TC/ABS intervention pair works).
   *   DEAD  water/oil temps, clutch, the whole wheel/tyre block (2 of 65
   *         floats per wheel moving), fuel (frozen litres), limiter, hybrid,
   *         aid settings, impact events.
   *
   * So the record is returned with every dead channel forced to its explicit
   * "unknown" shape rather than left as frozen garbage: a spectator seeing no
   * fuel gauge is being told the truth; one seeing 37.5 L forever is not. The
   * driven-car path never comes through here and keeps its richer channels.
   */
  private readSpectatedCar(slotId: number): LocalCarPhysics | null {
    const raw = this.localCar.read(slotId);
    if (!raw) {
      // Bridge a single torn read, but never across a focus switch.
      return this.lastSpectated !== null &&
        this.lastSpectatedSlot === slotId &&
        Date.now() - this.lastSpectatedAt < LOCAL_HOLD_MS
        ? this.lastSpectated
        : null;
    }
    const unknown4 = (): [number, number, number, number] => [
      UNKNOWN_VALUE,
      UNKNOWN_VALUE,
      UNKNOWN_VALUE,
      UNKNOWN_VALUE,
    ];
    const car: LocalCarPhysics = {
      ...raw,
      clutch: 0,
      rearBrakeBias: UNKNOWN_VALUE,
      fuelLiters: UNKNOWN_VALUE,
      capacityLiters: UNKNOWN_VALUE,
      limiterOn: null,
      batteryCharge: UNKNOWN_VALUE,
      motorTorqueNm: UNKNOWN_VALUE,
      tyreTempsC: unknown4(),
      tyreHudTempsC: unknown4(),
      tyreCoreC: unknown4(),
      tyreSurfaceBandsC: [null, null, null, null],
      tyreLinerBandsC: [null, null, null, null],
      motion: null,
      rawCorners: null,
      chassis: null,
      aidSettings: null,
    };
    this.lastSpectated = car;
    this.lastSpectatedAt = Date.now();
    this.lastSpectatedSlot = slotId;
    return car;
  }

  private buildPlayer(
    focus: RestStanding | undefined,
    standings: StandingEntry[],
    local: LocalCarPhysics | null,
    deltaSec: number,
    paceDeltas: PaceDeltas | undefined,
    trackLimits: TrackLimitsState | undefined,
    paceScore: PaceScoreState | undefined,
    atWheel: boolean,
  ) {
    const row = focus ? standings.find((s) => s.slotId === focus.slotID) : undefined;
    // Inputs, gear, RPM and speed come from the locally-driven car's shared
    // memory when available (real pedal trace); otherwise REST gives speed only.
    const restSpeed =
      focus && focus.carVelocity && typeof focus.carVelocity.velocity === 'number'
        ? Math.round(Math.abs(focus.carVelocity.velocity) * 3.6)
        : UNKNOWN_VALUE;
    // Tyre wear for the player's own car from the pit-menu screen (REST), and
    // live tyre temperatures from the driven car's shared memory. Both are the
    // player's own car; temps are °C per corner [FL, FR, RL, RR] or unknown
    // (spectating, or the car isn't running on track — LMU reports 0 K there).
    const wear =
      this.tyreWear !== null && Date.now() - this.lastGarageOkAt < GARAGE_STALE_AFTER_MS
        ? this.tyreWear
        : null;
    const surfaceTemps = local ? local.tyreTempsC : null;
    const hudTemps = local ? local.tyreHudTempsC : null;
    const speedKph = local ? local.speedKph : restSpeed;
    const pit = this.buildPit(focus, speedKph, local, this.gameState, atWheel);
    // Compound + optimal temperature, while the reading is fresh. Held to the
    // same staleness rule as wear: in the menus or after leaving the session
    // these describe a car that is no longer there.
    const spec =
      this.tyreSpec && Date.now() - this.lastTyreSpecOkAt < GARAGE_STALE_AFTER_MS * 4
        ? this.tyreSpec
        : null;
    const tyre = (i: number): TyreState => {
      // Bands are already oriented inner→centre→outer for the car by the reader
      // (see TyreBands) — nothing here re-derives which shoulder is which.
      const surf = local ? local.tyreSurfaceBandsC[i] : null;
      const liner = local ? local.tyreLinerBandsC[i] : null;
      const core = local ? local.tyreCoreC[i] : UNKNOWN_VALUE;
      const s = spec ? spec[i] : undefined;
      return {
        // Primary = inner-liner temp (matches the in-game HUD); surface on the sub-line.
        tempC: hudTemps ? (hudTemps[i] as number) : UNKNOWN_VALUE,
        surfaceTempC: surfaceTemps ? (surfaceTemps[i] as number) : UNKNOWN_VALUE,
        wear: wear ? round2(wear[i] as number) : UNKNOWN_VALUE,
        ...(core !== UNKNOWN_VALUE ? { coreC: core } : {}),
        ...(liner ? { innerC: liner[0], middleC: liner[1], outerC: liner[2] } : {}),
        ...(surf
          ? { surfaceInnerC: surf[0], surfaceMiddleC: surf[1], surfaceOuterC: surf[2] }
          : {}),
        ...(s?.compound ? { compound: s.compound } : {}),
        ...(s?.optimalTempC !== undefined ? { optimalTempC: s.optimalTempC } : {}),
      };
    };
    return {
      slotId: focus ? focus.slotID : UNKNOWN_VALUE,
      position: row ? row.position : UNKNOWN_VALUE,
      pedals: local
        ? {
            throttle: local.throttle,
            brake: local.brake,
            clutch: local.clutch,
            steer: local.steer,
            tc: local.tc,
            abs: local.abs,
          }
        : { throttle: 0, brake: 0, clutch: 0, steer: 0 },
      gear: local ? local.gear : UNKNOWN_VALUE,
      speedKph,
      rpm: local ? local.rpm : UNKNOWN_VALUE,
      maxRpm: local ? local.maxRpm : UNKNOWN_VALUE,
      lap: {
        // Live elapsed time on the current lap, from the delta engine's own
        // clock — a real elapsed time measured from the interpolated line
        // crossing, and the same clock the delta beside it runs on.
        //
        // NOT REST `timeIntoLap`, which is what this used to be. That field is a
        // position-derived ESTIMATE: it reports the same value at a given
        // distance whatever the lap is actually taking, so any lap slower than
        // the pace it assumes reads seconds short — which is exactly how it
        // looked. (It is still the fallback, because before the engine has seen
        // a line crossing an estimate beats nothing. The shared-memory clock
        // mElapsedTime−mLapStartET is not an option: mLapStartET reports wrong,
        // irregular lap durations on current LMU builds, which is why the engine
        // detects the crossing itself.)
        current:
          paceDeltas && paceDeltas.lapTimeSec !== UNKNOWN_VALUE
            ? paceDeltas.lapTimeSec
            : focus && typeof focus.timeIntoLap === 'number' && focus.timeIntoLap > 0
              ? round2(focus.timeIntoLap)
              : UNKNOWN_VALUE,
        last: row ? row.lastLapSec : UNKNOWN_VALUE,
        best: row ? row.bestLapSec : UNKNOWN_VALUE,
        delta: deltaSec,
        sector: UNKNOWN_VALUE,
      },
      tyres: {
        frontLeft: tyre(0),
        frontRight: tyre(1),
        rearLeft: tyre(2),
        rearRight: tyre(3),
      },
      ...(paceDeltas ? { paceDeltas } : {}),
      // Unlike the blocks below, this one is sent even when it has nothing to
      // report: `ok: false` carries the REASON there is no score, and "Monza has
      // two layouts and the sim didn't say which" is the single most useful
      // thing this feature can tell someone. Omitting it would leave the widget
      // showing "Awaiting telemetry…" forever with no way to find out why.
      ...(paceScore ? { paceScore } : {}),
      // Only present with live shared memory: the motion block is populated for
      // the driven car alone, so spectating omits it entirely rather than
      // sending a frozen or zeroed one.
      ...(local && local.motion ? { motion: local.motion } : {}),
      // Same rule for the four-corner load block — absent when spectating, and
      // absent (not zeroed) when the wheel struct fails its guards, so the
      // widget can distinguish "no data" from "a car sitting perfectly flat".
      ...(local && local.chassis ? { chassis: local.chassis } : {}),
      // Damage comes from REST, not shared memory, so unlike the blocks above
      // it does not need a locally-driven car — but it does need a live repair
      // screen. Gated on the same staleness window as tyre wear: when the
      // endpoint stops answering (menus, session end) the block is dropped
      // rather than frozen, since a stale "no damage" is a lie the driver would
      // act on.
      ...(this.damage && Date.now() - this.lastDamageOkAt < GARAGE_STALE_AFTER_MS
        ? { damage: this.damage }
        : {}),
      ...(pit ? { pit } : {}),
      // Hybrid: gated on the per-car latch, not on the current reading, because a
      // Hypercar that has just emptied its battery down the Mulsanne reads
      // exactly like a GT3 that never had one. See `hasHybrid`.
      ...(local && this.hasHybrid && local.batteryCharge !== UNKNOWN_VALUE
        ? {
            hybrid: {
              chargeFraction: local.batteryCharge,
              motorTorqueNm: local.motorTorqueNm,
            },
          }
        : {}),
      // Like motion and chassis, this exists only for the car driven on this PC
      // — it is read from that car's own scoring record — so spectating omits it
      // rather than reporting a clean sheet nobody earned.
      ...(trackLimits ? { trackLimits } : {}),
    };
  }

  /**
   * The stewards' track-limit points and penalties for the **driven** car.
   *
   * Centred on the driven car rather than the broadcast focus, for the same
   * reason the radar is: it is a driver aid, and the channels behind it exist
   * only for the car whose scoring record this PC owns. Returns `undefined`
   * when the scoring buffer is unreadable, which drops the block from the frame.
   *
   * Two sources meet here, and neither is ours: the scoring record publishes the
   * penalty count, and the trace log publishes the points and what each cut was
   * charged (`telemetry/lmuTraceLimits.ts`).
   */
  private buildTrackLimits(
    playerCar: RestStanding | undefined,
    car: ScoringCar | null,
    session: SessionState,
  ): TrackLimitsState | undefined {
    if (!playerCar) {
      this.trackLimits.reset();
      return undefined;
    }
    if (!car) return undefined;

    // The trace reader resets itself on the sim's own `SessionName` line, which is
    // the authoritative signal; this covers the case where the overlay starts
    // mid-session and then the session changes under it.
    const sessionKey = `${session.track}|${session.type}`;
    if (sessionKey !== this.traceSessionKey) {
      this.traceSessionKey = sessionKey;
      this.traceLimits.reset();
      this.lastChargeSeq = 0;
      this.lastChargeAt = 0;
    }
    const nowMs = Date.now();
    // The count tracker runs BEFORE the trace poll on purpose: the count edge
    // it records is what the trace reader's attribution predicate consults, and
    // a penalty line must never be judged against a counter one frame stale.
    const state =
      this.trackLimits.update({
        penalties: car.penalties,
        // Track + session type: a new session zeroes the count, and so does
        // driving the same session at a different circuit (a rolling server).
        sessionKey,
        // The session's own allowance when it published one, so the countdown
        // runs to the number that will be enforced rather than to our default.
        ...(this.cutsAllowed !== null ? { pointsLimit: this.cutsAllowed } : {}),
        nowMs,
      }) ?? undefined;

    this.traceLimits.poll();
    const trace = this.traceLimits.state();

    if (!state) return undefined;

    // Only a race spends the allowance on a drive-through; practice and qualifying
    // invalidate the lap and let the total run past it. See `pointsLimitEnforced`.
    const enforced = session.type === 'race';

    // No trace — no LMU log directory, or a copy being replayed that has ended.
    // The points stay UNKNOWN_VALUE rather than becoming a comfortable zero: the
    // widget must be able to say "we cannot see the stewards".
    if (!trace) return { ...state, pointsLimitEnforced: enforced };

    // A charge lands the moment the reader's counter moves. It only ever goes
    // DOWN on a session reset, which is not an event to flash about.
    if (trace.chargeSeq > this.lastChargeSeq) this.lastChargeAt = nowMs;
    this.lastChargeSeq = trace.chargeSeq;

    return {
      ...state,
      points: trace.points,
      charges: trace.charges,
      charged: trace.charged,
      chargedLaps: trace.chargedLaps,
      msSinceCharge: this.lastChargeAt ? nowMs - this.lastChargeAt : UNKNOWN_VALUE,
      pointsLimitEnforced: enforced,
    };
  }

  /**
   * Name the outstanding penalty from the sim's own pit menu.
   *
   * LMU publishes the *count* of penalties in three places and the *kind* in
   * none of them — which is how a driver ends up staring at "1 PENALTY" with the
   * in-game HUD off, unable to tell a drive-through from a stop/go.
   *
   * ## Where the kind actually is, and how that was established
   * The sim inserts a row into the **pit menu** for the penalty it wants served,
   * named after it. Verified live, in both directions, on one car in one
   * session:
   *
   *   penalties = 1  → the menu carried `PMC 1 "STOP/GO:"` = `"Yes(0Laps)"`
   *   penalties = 0  → that row was **absent from the menu entirely**
   *
   * The second half is what makes this trustworthy. A row that is merely present
   * while a penalty happens to be outstanding proves nothing; a row that appears
   * and disappears with the count is the sim telling us what it wants served.
   * And the menu is already on the wire every 500 ms for the MFD widget, so this
   * costs nothing but the lookup.
   *
   * ## Why presence, and not the row's value, is the test
   * The row defaults to `Yes` but the driver can set it to `No` — that is a
   * choice about *this* pit stop, not a statement that the penalty has gone. Its
   * existence is the signal; its value is passed through as detail only.
   *
   * ## Why an unrecognised row yields nothing at all
   * A penalty type is not a display detail: told "STOP/GO" a driver stops in
   * their box, and doing that to discharge a drive-through does not serve it —
   * it turns twenty seconds into a lap. {@link PENALTY_ROW} carries the
   * observed and plausible spellings; anything outside them falls through to
   * the second source below rather than to a guess. Being unhelpful is
   * recoverable; being confidently wrong here is not.
   *
   * ## The second source: the sim's own trace log
   * The trace names the penalty the moment it is issued — reason AND kind
   * (`Track Limits Drive Through Penalty`; `Local penalty et=… 0 10 0 0` = a
   * 10-second stop/go), read by `lmuTraceLimits` and attributed to this car
   * before it is trusted (see the predicate in start()). Live, 2026-08-20, it
   * named a drive-through the pit menu never did. The pit-menu row still wins
   * when it matches, because it carries the serve DEADLINE — the trace only
   * says what was issued; the menu says how long you have left to do it.
   */
  private buildPenaltyType(): { penaltyType?: string; penaltyDetail?: string } {
    const rows = this.pitMenuRaw;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const raw = String(row?.name ?? '');
        const name = raw.replace(/:\s*$/, '').trim();
        if (!PENALTY_ROW.test(name)) continue;
        const opts = Array.isArray(row.settings) ? row.settings : [];
        const idx = typeof row.currentSetting === 'number' ? row.currentSetting : -1;
        const text = String(opts[idx]?.text ?? '').trim();
        return {
          penaltyType: name.toUpperCase(),
          ...(text ? { penaltyDetail: deadlineDetail(text) } : {}),
        };
      }
    }

    // No recognisable pit-menu row — name it from the trace instead. Only a
    // penalty whose KIND the trace stated is worth reporting: the reason alone
    // ("TRACK LIMITS") does not tell a driver what to do in the pit lane.
    const pen = this.traceLimits.state()?.lastPenalty;
    if (pen?.kind) {
      const type =
        pen.kind === 'drive-through'
          ? 'DRIVE THROUGH'
          : pen.seconds && pen.seconds > 0
            ? `STOP/GO ${pen.seconds}S`
            : 'STOP/GO';
      // The reason rides as detail — "DRIVE THROUGH — TRACK LIMITS" answers
      // both of the questions the driver is asking, in the order they ask them.
      const reason = pen.name.trim().toUpperCase();
      return { penaltyType: type, ...(reason ? { penaltyDetail: reason } : {}) };
    }
    return {};
  }

  /**
   * Keep {@link simTrackName} current — the sim's internal scene name, which is
   * the only channel that says which track LAYOUT is loaded.
   *
   * Probed on a slow retry rather than every poll: shared memory is only there
   * once the sim is in a session, and the answer does not change until the next
   * session load. The display track name is the invalidation key, so driving a
   * rolling server round to the next circuit re-reads it.
   */
  private refreshSimTrackName(track: string, nowMs: number): void {
    if (track !== this.simTrackNameFor) {
      this.simTrackNameFor = track;
      this.simTrackName = '';
      this.simTrackNameAt = 0;
    }
    if (this.simTrackName || nowMs - this.simTrackNameAt < SCENE_NAME_RETRY_MS) return;
    this.simTrackNameAt = nowMs;
    this.simTrackName = this.scoring.readTrackName();
  }

  /**
   * Where the driven car's best lap sits against the reference pace for its
   * class — the block the Reference Pace widget and the Dashboard tile render.
   *
   * Scores the **session best** rather than the last lap on purpose: a driver's
   * pace is the best they have shown, and scoring every lap would put the number
   * in the Offline band every time someone lifted for traffic or came out of the
   * pits. The delta bar is the widget for what the current lap is doing.
   *
   * Note this is the SIM's best lap, not the lap database's best CLEAN lap. The
   * two differ when a quick lap ran wide, and the honest split is: the overlay
   * shows what you actually drove, while the Dashboard tile — which is closer to
   * a claim about you — scores the clean one. See `electron/main.js`.
   *
   * Always returns a block once there is a driven car, even when nothing can be
   * scored: {@link PaceScoreState.detail} is the only place a driver can find
   * out why Monza never shows a number.
   */
  private buildPaceScore(
    playerCar: RestStanding | undefined,
    session: SessionState,
    trackLenM: number,
  ): PaceScoreState | undefined {
    if (!playerCar) return undefined;

    const carClass = normalizeClass(playerCar.carClass) || '';
    const bestSec =
      typeof playerCar.bestLapTime === 'number' && playerCar.bestLapTime > 0
        ? playerCar.bestLapTime
        : 0;
    const lapMs = Math.round(bestSec * 1000);

    const key = [
      session.track,
      session.trackConfig || '',
      this.simTrackName,
      Math.round(trackLenM),
      carClass,
      this.playerVehicleName,
      lapMs,
    ].join('|');
    if (this.paceScoreCache && this.paceScoreCache.key === key) return this.paceScoreCache.value;

    const identity = {
      track: session.track,
      trackConfig: session.trackConfig,
      simTrackName: this.simTrackName,
      trackLengthM: trackLenM,
      carClass,
      car: this.playerVehicleName,
    };
    const credit = referenceCredit();
    const base: PaceScoreState = {
      ok: false,
      lapSec: bestSec > 0 ? round2(bestSec) : UNKNOWN_VALUE,
      ...(credit
        ? { credit: { author: credit.author, title: credit.title, sheetUrl: credit.sheetUrl } }
        : {}),
    };

    let value: PaceScoreState;
    // Resolve the reference first, without the lap. The widget can then show
    // what it is going to compare against from the moment the session loads,
    // rather than staying blank until the first lap is in.
    const ref = referenceFor(identity);
    if (!ref.ok || !ref.score) {
      value = {
        ...base,
        ...(ref.reason ? { reason: ref.reason } : {}),
        ...(ref.detail ? { detail: ref.detail } : {}),
      };
    } else {
      const known = {
        refSec: round2(ref.score.refMs / 1000),
        ...(ref.score.hotlapMs ? { hotlapSec: round2(ref.score.hotlapMs / 1000) } : {}),
        layoutName: ref.score.layoutName,
        circuitName: ref.score.circuitName,
        sheetClass: ref.score.sheetClass,
        via: ref.score.via,
        assumed: ref.score.assumed,
      };
      const scored = lapMs > 0 ? scoreLap({ ...identity, lapMs }) : null;
      value =
        scored && scored.ok && scored.score
          ? {
              ...base,
              ...known,
              ok: true,
              percent: scored.score.percent,
              bandId: scored.score.bandId,
              bandLabel: scored.score.bandLabel,
              deltaSec: scored.score.deltaSec,
            }
          : {
              ...base,
              ...known,
              reason: 'no-lap',
              detail: 'Set a lap to see where you land.',
            };
    }

    this.paceScoreCache = { key, value };
    return value;
  }

  /**
   * Feed the lap recorder, and write out any lap that just completed.
   *
   * Centred on the DRIVEN car, like track limits and the radar — a lap database
   * records what you drove, so spectating another car must add nothing to it.
   *
   * The file write happens here rather than being handed up to the caller
   * because it is an append of a few hundred bytes once every lap or two: at
   * that rate the simplicity of doing it inline is worth more than the machinery
   * of queueing it, and {@link appendLap} swallows its own errors so a full disk
   * cannot take the overlay down mid-race.
   */
  private recordLap(
    playerCar: RestStanding | undefined,
    scoringCar: ScoringCar | null,
    session: SessionState,
    trackLimits: TrackLimitsState | undefined,
    si: RestSession,
    trackLenM: number,
    nowMs: number,
  ): void {
    if (!playerCar) return;
    const lap = this.lapRecorder.update(
      {
        sim: 'lmu',
        track: session.track,
        // Both layout hints travel with the lap so it can be pace-scored months
        // later, when the session that set it is long gone. See `LapRecord`.
        ...(session.trackConfig ? { trackConfig: session.trackConfig } : {}),
        ...(this.simTrackName ? { simTrackName: this.simTrackName } : {}),
        trackLengthM: trackLenM,
        car: this.playerVehicleName,
        carClass: normalizeClass(playerCar.carClass) || '',
        sessionType: session.type,
        lapsCompleted: playerCar.lapsCompleted,
        lastLapSec: playerCar.lastLapTime,
        // Both pit sources, because either alone misses a case: the scoring
        // record sees the garage stall, the standings row sees the lane.
        inPit: (scoringCar ? scoringCar.inPit : false) || isInPit(playerCar),
        // The sim's own count of cuts it charged for — the fallback signal now
        // that the laps below name the guilty lap outright.
        limitWarnings: trackLimits ? trackLimits.charged : UNKNOWN_VALUE,
        ...(trackLimits?.chargedLaps ? { chargedLaps: trackLimits.chargedLaps } : {}),
        // LMU's trace numbers the lap IN PROGRESS, one-based, so the lap being
        // driven is one past the completed count: a driver on their first lap
        // has completed none and the trace writes `Lap: 1`. This single
        // expression is the whole mapping between the sim's numbering and ours
        // — if a session type ever proves to number differently (a formation
        // lap counted, say), this is the one line that changes.
        ...(typeof playerCar.lapsCompleted === 'number' &&
        Number.isFinite(playerCar.lapsCompleted)
          ? { currentLapNo: playerCar.lapsCompleted + 1 }
          : {}),
        penalties: scoringCar ? scoringCar.penalties : UNKNOWN_VALUE,
        ...(typeof si.trackTemp === 'number' ? { trackTempC: si.trackTemp } : {}),
        ...(typeof si.ambientTemp === 'number' ? { ambientTempC: si.ambientTemp } : {}),
        wet: (si.raining ?? 0) > 0 || (si.maxPathWetness ?? 0) > 0,
        // The completed lap's cumulative sector boundaries, read on the same
        // poll `lapsCompleted` moved on. LMU withholds them (`-1`) for a lap it
        // invalidated; `lapLog.sectorSplits` filters those out.
        ...(typeof playerCar.lastSectorTime1 === 'number'
          ? { sector1Sec: playerCar.lastSectorTime1 }
          : {}),
        ...(typeof playerCar.lastSectorTime2 === 'number'
          ? { sector2Sec: playerCar.lastSectorTime2 }
          : {}),
        // Which setup the lap was driven on. The garage endpoint reports the
        // SETUP, frozen — cockpit clicks never appear (probed live 2026-08-11)
        // — so the cached 3 s read is exact, not approximate.
        ...(this.currentSetupFp() ? { setupFp: this.currentSetupFp() } : {}),
      },
      nowMs,
    );
    if (lap) {
      appendLap(lap);
      this.attachTrace(lap);
    }
  }

  /** Fingerprint of the current garage setup, memoized per garage read. */
  private currentSetupFp(): string {
    if (this.garageDataRaw !== this.setupFpFor) {
      this.setupFpFor = this.garageDataRaw;
      this.setupFpCache = fingerprintGarageData(this.garageDataRaw);
    }
    return this.setupFpCache;
  }

  /**
   * Pair a just-written lap record with the driving trace recorded for it, and
   * write the trace file the record's `id` names.
   *
   * The two sides observe the same crossing through different channels — the
   * trace recorder sees the road position wrap at frame rate, the lap recorder
   * sees `lapsCompleted` move on a REST poll — so they are matched on the wall
   * clock each stamped at that crossing: the record's `at` is the poll that
   * completed the lap, the trace's `wallMs` the frame, and the two land within
   * a poll interval of each other. The record then spends ~40 s in the verdict
   * hold before arriving here, which is why the pending list exists at all.
   *
   * When the sim published a lap time, it must also agree with the trace's
   * measured one — a mismatch means the wall-clock pairing lied (a trace from
   * a fragment beside a record from a real lap), and no trace beats a wrong one.
   */
  private attachTrace(lap: LapRecord): void {
    if (!lap.id) return;
    const atMs = Date.parse(lap.at);
    if (!Number.isFinite(atMs)) return;
    let bestIdx = -1;
    let bestGap = 5000; // ms — a real pair lands within one REST poll
    for (let i = 0; i < this.pendingTraces.length; i++) {
      const gap = Math.abs(atMs - this.pendingTraces[i]!.wallMs);
      if (gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return;
    const { trace } = this.pendingTraces[bestIdx]!;
    this.pendingTraces.splice(bestIdx, 1);
    if (lap.lapMs > 0 && Math.abs(trace.lapSec * 1000 - lap.lapMs) > 2000) return;
    writeTrace({
      v: 1,
      lapId: lap.id,
      at: lap.at,
      sim: lap.sim,
      trackKey: lap.trackKey,
      track: lap.track,
      trackLengthM: lap.trackLengthM,
      car: lap.car,
      carClass: lap.carClass,
      lapMs: lap.lapMs,
      ...(lap.s1Ms ? { s1Ms: lap.s1Ms } : {}),
      ...(lap.s2Ms ? { s2Ms: lap.s2Ms } : {}),
      ...(lap.s3Ms ? { s3Ms: lap.s3Ms } : {}),
      trace,
    });
  }

  /**
   * The player's pit stage, and the crew's clock while they are on the car.
   *
   * The clock is started here rather than in the widget because it has to
   * survive things the widget cannot see: a browser source reloading mid-stop, a
   * second overlay opening, the widget being throttled. It is also the only
   * place with the repair screen to hand at the instant work begins, which is
   * when the booked stop length has to be captured — see {@link PitState}.
   */
  private buildPit(
    focus: RestStanding | undefined,
    speedKph: number,
    local: LocalCarPhysics | null,
    gs: RestGameState | null,
    atWheel: boolean,
  ): PitState | undefined {
    if (!focus) {
      this.pitWork = null;
      return undefined;
    }
    // The two live extras ride on every pit block, whatever the phase: the
    // entry-distance marker exists precisely while the phase is still `none`,
    // and the limiter prompt around the race start likewise. Both are omitted
    // rather than guessed when their channel is absent — the limiter is the
    // DRIVEN car's shared memory, so it disappears while spectating.
    //
    // The limiter is ALSO omitted while the driver is in the sim's menus
    // (`atWheel` = the session's onTrack signal): the ESC and garage screens
    // freeze the telemetry MMF at its last values, so the byte still READS —
    // it just describes the moment the driver left the car. A limiter that was
    // on when they stepped out would otherwise sit lit on the cluster until
    // they drove again, which testers read as the widget being stuck.
    const extras = {
      ...(gs && typeof gs.PitEntryDist === 'number' && Math.abs(gs.PitEntryDist) < 100000
        ? { entryDistM: Math.round(gs.PitEntryDist) }
        : {}),
      ...(local && local.limiterOn !== null && atWheel ? { limiterOn: local.limiterOn } : {}),
    };
    const phase = pitPhase(focus, speedKph);
    if (phase !== 'stopped') {
      // Anything other than stationary-in-the-box ends the stop, including the
      // car simply vanishing from the feed. The next stop starts a fresh clock.
      this.pitWork = null;
      return { phase, working: false, elapsedSec: UNKNOWN_VALUE, plannedSec: UNKNOWN_VALUE, slackSec: UNKNOWN_VALUE, ...extras };
    }
    const now = Date.now();
    if (!this.pitWork) {
      // Work has just begun. Snapshot what the stop was booked for; a stale or
      // missing repair screen leaves the target unknown rather than guessed, and
      // the widget counts up instead of down.
      const fresh = this.damage && now - this.lastDamageOkAt < GARAGE_STALE_AFTER_MS ? this.damage : null;
      this.pitWork = {
        startedAt: now,
        plannedSec: fresh ? fresh.stopLengthSeconds : UNKNOWN_VALUE,
        slackSec: fresh ? fresh.randomDelayMaxSeconds : UNKNOWN_VALUE,
      };
    }
    return {
      phase,
      working: true,
      elapsedSec: round1((now - this.pitWork.startedAt) / 1000),
      plannedSec: this.pitWork.plannedSec,
      slackSec: this.pitWork.slackSec,
      ...extras,
    };
  }
}

/* --------------------------------- helpers -------------------------------- */

/**
 * Speed (km/h) at or below which the car counts as stationary in its box.
 *
 * Not zero: the REST velocity channel and the shared-memory speed both dither
 * around a fraction of a km/h on a parked car, and a stop that flickered in and
 * out of "working" would restart the crew's clock every few frames. A car being
 * pushed or rolling in the stall is well above this.
 */
const PIT_STATIONARY_KPH = 3;

/** `pitState` strings LMU publishes, in ISI's own `mPitState` vocabulary. */
const PIT_PHASES: Record<string, PitPhase> = {
  NONE: 'none',
  REQUEST: 'request',
  REQUESTED: 'request',
  ENTERING: 'entering',
  ENTER: 'entering',
  STOPPED: 'stopped',
  EXITING: 'exiting',
  EXIT: 'exiting',
};

/**
 * Which stage of a stop a car is at.
 *
 * `pitState` is the authoritative channel, but it is a string the sim can
 * rename, so an unrecognised value falls back to the two booleans beside it
 * (`pitting` / `inGarageStall`) plus the car's own speed. That fallback cannot
 * tell `entering` from `exiting` — both are "in the lane, moving" — and reports
 * `entering` for either, which is the safe way round: it never claims the crew
 * has finished.
 */
function pitPhase(c: RestStanding, speedKph: number): PitPhase {
  const raw = typeof c.pitState === 'string' ? c.pitState.trim().toUpperCase() : '';
  const known = PIT_PHASES[raw];
  const stationary = speedKph === UNKNOWN_VALUE || speedKph <= PIT_STATIONARY_KPH;
  if (known) {
    // A `STOPPED` reading on a car that is plainly still moving is not a stop
    // in progress — hold at `entering` until it has actually come to rest, so
    // the crew's clock starts when the work does.
    if (known === 'stopped' && !stationary) return 'entering';
    return known;
  }
  if (c.pitting === true || c.inGarageStall === true) return stationary ? 'stopped' : 'entering';
  return 'none';
}

/**
 * Whether the car is physically on the pit lane (or in its box) right now —
 * which is what makes the lap it is on unusable as a measurement of burn.
 *
 * Deliberately NOT {@link isInPit}: that one counts a *requested* stop as being
 * in the pits, which is right for "is this car about to stop" but wrong here. A
 * driver requests the stop laps before they take it, and those are green laps —
 * the last green laps before the stop, the ones the burn average most needs.
 */
function isOnPitLane(c: RestStanding): boolean {
  const raw = typeof c.pitState === 'string' ? c.pitState.trim().toUpperCase() : '';
  return (
    c.pitting === true ||
    c.inGarageStall === true ||
    raw === 'ENTERING' ||
    raw === 'ENTER' ||
    raw === 'STOPPED' ||
    raw === 'EXITING' ||
    raw === 'EXIT'
  );
}

function isInPit(c: RestStanding): boolean {
  return (
    c.pitting === true ||
    c.inGarageStall === true ||
    (typeof c.pitState === 'string' && c.pitState !== 'NONE' && c.pitState !== '')
  );
}

function mapSessionType(session: string | undefined): SessionType {
  const s = (session || '').toUpperCase();
  if (s.startsWith('RACE')) return 'race';
  if (s.startsWith('QUAL') || s.startsWith('Q')) return 'qualifying';
  if (s.startsWith('PRAC') || s.startsWith('P')) return 'practice';
  if (s.startsWith('WARM') || s.startsWith('W')) return 'warmup';
  if (s.startsWith('TEST')) return 'testday';
  return 'unknown';
}

function mapPhase(phase: unknown): SessionPhase {
  // GetGameState speaks with a GPHASE_ prefix ("GPHASE_FORMATION"); the
  // per-car strings do not ("FORMATION"). One vocabulary after stripping it.
  switch (asUpper(phase).replace(/^GPHASE_/, '')) {
    case 'BEFORE':
      // GPHASE_BEFORE — the session exists but nothing is running yet.
      return 'garage';
    case 'GARAGE':
      return 'garage';
    case 'GRIDWALK':
      return 'gridwalk';
    case 'FORMATION':
    case 'FORMATIONLAP':
      return 'formation';
    case 'COUNTDOWN':
      return 'countdown';
    case 'GREEN':
    case 'GREENFLAG':
      return 'green';
    case 'FULLCOURSEYELLOW':
    case 'FULL_COURSE_YELLOW':
      return 'fullCourseYellow';
    case 'RED':
    case 'SESSIONSTOPPED':
      return 'redFlag';
    case 'CHECKERED':
    case 'SESSIONOVER':
      return 'checkered';
    default:
      return 'unknown';
  }
}

function mapFlag(phase: unknown): FlagState {
  switch (asUpper(phase).replace(/^GPHASE_/, '')) {
    case 'GREEN':
    case 'GREENFLAG':
      return 'green';
    case 'FULLCOURSEYELLOW':
    case 'FULL_COURSE_YELLOW':
      return 'yellow';
    case 'RED':
    case 'SESSIONSTOPPED':
      return 'red';
    case 'CHECKERED':
    case 'SESSIONOVER':
      return 'checkered';
    default:
      return 'none';
  }
}

/**
 * Selects the forecast block for the running session from the weather payload.
 * Keys are `PRACTICE` / `QUALIFY` / `RACE`; warmup shares the race forecast.
 * Falls back to the first available block so something always renders.
 */
function pickWeatherBlock(
  raw: RestWeather,
  type: SessionType,
): Record<string, WeatherNode> | null {
  const want =
    type === 'race' || type === 'warmup'
      ? 'RACE'
      : type === 'qualifying'
        ? 'QUALIFY'
        : type === 'practice' || type === 'testday'
          ? 'PRACTICE'
          : '';
  if (want && raw[want]) return raw[want]!;
  const keys = Object.keys(raw);
  return keys.length ? raw[keys[0]!]! : null;
}

/** Maps LMU's WNV_SKY node (0..N index + label) to our coarse {@link SkyState}. */
function mapSky(v: WeatherValue | undefined): SkyState {
  const s = (v?.stringValue ?? '').toLowerCase();
  if (/storm|thunder/.test(s)) return 'storm';
  if (/heavy rain|rain/.test(s)) return 'rain';
  if (/drizzle|light rain|shower/.test(s)) return 'lightRain';
  if (/overcast|mostly cloud/.test(s)) return 'overcast';
  if (/cloud/.test(s)) return 'partlyCloudy';
  if (/clear|sun|fair/.test(s)) return 'clear';
  return 'partlyCloudy';
}

/** A representative precipitation intensity for a forecast slot's sky/chance. */
function skyRainIntensity(sky: SkyState, chance: number): number {
  if (sky === 'storm') return 1;
  if (sky === 'rain') return 0.7;
  if (sky === 'lightRain') return 0.3;
  // Dry sky but a non-trivial chance → hint of possible light rain.
  return chance >= 0.5 ? 0.1 : 0;
}

/** Coerces any value to an upper-cased string (numbers, undefined → safe). */
function asUpper(v: unknown): string {
  return typeof v === 'string' ? v.toUpperCase() : v == null ? '' : String(v).toUpperCase();
}

/**
 * One spelling of a driver name for the badge join: trimmed, case-folded, and
 * with LMU's `#1234` uniqueness discriminator stripped — `/rest/watch/standings`
 * carries it on the in-car name, `/rest/multiplayer/teams` keys by the bare
 * profile name.
 */
function normalizeDriverName(name: string): string {
  return name.replace(/#\d+\s*$/, '').trim().toLowerCase();
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function posOrUnknown(v: unknown): number {
  return typeof v === 'number' && v > 0 ? v : UNKNOWN_VALUE;
}
function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : 0;
  return Math.min(1, Math.max(0, n));
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/* ----------------------------- lap-delta tracker -------------------------- */

/**
 * Pit-menu rows that name a penalty rather than a service.
 *
 * `STOP/GO` is confirmed — the row appears in the menu exactly while a stop/go
 * is outstanding and vanishes when it is served. The drive-through spellings are
 * plausible rather than observed, which is why a row outside this list produces
 * no claim at all rather than a fallback guess. Widen it from the output of
 * `scripts/probe-lmu-penalty.js`, not from intuition.
 * See {@link LmuRestProvider.buildPenaltyType}.
 */
const PENALTY_ROW = /^(STOP\s*[/-]?\s*GO|DRIVE\s*[-]?\s*(THRU|THROUGH)|PENALTY)$/i;

/**
 * How long an anonymous trace penalty line stays attributable to a rise in our
 * own count. Generous against the trace's worst observed flush latency (~25 s),
 * tight enough that a rival's penalty minutes later cannot ride the same edge.
 */
const OWN_PENALTY_ATTRIBUTION_MS = 45_000;

/**
 * The penalty row's value, turned into the instruction it encodes.
 *
 * The row reads `Yes(3Laps)` / `No(3Laps)` — Yes/No is the driver's choice
 * about THIS stop, and the parenthesis is the serve deadline (probed live: it
 * counts down as laps pass). The deadline is the half a driver acts on, so it
 * is the half that gets said; a value that doesn't parse is passed through
 * verbatim rather than dropped, because the sim's own words are never worse
 * than nothing.
 */
function deadlineDetail(rowValue: string): string {
  const m = /\((\d+)\s*Laps?\)/i.exec(rowValue);
  if (!m?.[1]) return rowValue;
  const laps = Number.parseInt(m[1], 10);
  if (!Number.isFinite(laps)) return rowValue;
  if (laps <= 0) return 'SERVE NOW';
  return `SERVE IN ${laps} ${laps === 1 ? 'LAP' : 'LAPS'}`;
}

/**
 * How far back the wetness trend looks. Long, because a circuit takes minutes to
 * dry and the feed's own jitter is larger than a poll-to-poll change — compare
 * two adjacent samples and the readout flickers between drying and wetting all
 * session.
 */
const WET_TREND_WINDOW_MS = 180_000;
/** Wetness change over that window below which the track is called steady. */
const WET_TREND_MIN = 0.02;

/**
 * Name a wetness fraction. The bands are placed where the *decision* changes
 * rather than at round numbers: DAMP is "a dry line exists but the rest is not",
 * WET is "wets, and the dry line has gone", and SATURATED is standing water —
 * aquaplaning territory, where the answer is pace rather than tyres.
 */
function wetnessBand(wet: number): string {
  if (wet < 0.02) return 'DRY';
  if (wet < 0.2) return 'DAMP';
  if (wet < 0.5) return 'WET';
  if (wet < 0.8) return 'VERY WET';
  return 'SATURATED';
}

/** Per-car state for {@link LapDeltaTracker}. */
interface CarDeltaState {
  /** The car's distance axis — see {@link RoadPosition}. */
  pos: RoadPosition;
  /** The same engine the driven car uses, minus the persisted all-time best. */
  engine: LocalPaceDeltaTracker;
}

/**
 * Live lap delta for cars we can only see through the REST feed — anyone but
 * the car being driven on this PC.
 *
 * ## Why this is not just the old REST tracker with a filter on it
 * It used to read the delta as `timeIntoLap − refTimeAt(d)`, taking REST
 * `timeIntoLap` as the lap clock. That field is a **position-derived estimate**:
 * at a given distance it reports the same value on a fast lap and a slow one.
 * So the subtraction cancelled by construction and the readout sat at 0.00
 * whatever the car did — a bar that was perfectly steady and completely silent.
 * (This was already recorded as a known dead end when the driven car's delta was
 * rebuilt in 0.6.5; it is only now being paid off for everyone else.)
 *
 * So the time axis here is a real clock — the sim's own `mElapsedTime` where
 * shared memory can be read, otherwise wall time (see the provider's
 * `deltaClockSec`) — with lap boundaries taken from the distance fraction
 * wrapping past the line, exactly as the driven car's engine does it. That makes
 * this the same engine, per car: {@link LocalPaceDeltaTracker} with an empty
 * track key, which is what disables the on-disk all-time best (a spectated car's
 * best belongs to the session being watched, not to this PC's PB store).
 *
 * Every car in the feed is tracked every frame, not just the focused one. A
 * director cuts between cars constantly, and a car whose laps were only recorded
 * while the camera was on it has nothing to compare against the moment it cuts
 * back. Only the focused car's deltas are actually computed.
 */
class LapDeltaTracker {
  private readonly cars = new Map<number, CarDeltaState>();

  /**
   * @param cars     - Every car in the current REST standings snapshot.
   * @param focus    - The car whose delta is wanted (the broadcast focus).
   * @param trackLen - Lap length in metres.
   * @param clockSec - A real-time clock in seconds, monotonic and continuous
   *                   across the session (the provider's `deltaClockSec`).
   * @param ageSec   - Age of the REST snapshot, for dead-reckoning positions.
   * @returns The focused car's deltas, or {@link EMPTY_PACE_DELTAS}.
   */
  /**
   * @param player - The DRIVEN car's slot and what the stewards have charged it,
   *                 when there is one on this PC. Only that car has a
   *                 track-limits channel — a rival's cuts are not in any feed we
   *                 read — so only that car's references can refuse a lap for
   *                 leaving the circuit. This path serves the driven car's own
   *                 delta whenever shared memory is unavailable, which is
   *                 exactly when it would otherwise still adopt a cut lap.
   */
  public update(
    cars: RestStanding[],
    focus: RestStanding | undefined,
    trackLen: number,
    clockSec: number,
    ageSec: number,
    player?: { slotId: number; lap: LapValidity },
  ): PaceDeltas {
    if (trackLen <= 0 || !(clockSec > 0)) return EMPTY_PACE_DELTAS;
    let out: PaceDeltas = EMPTY_PACE_DELTAS;
    const seen = new Set<number>();

    for (const c of cars) {
      if (typeof c.lapDistance !== 'number' || !Number.isFinite(c.lapDistance)) continue;
      seen.add(c.slotID);
      let st = this.cars.get(c.slotID);
      if (!st) {
        st = { pos: new RoadPosition(), engine: new LocalPaceDeltaTracker() };
        this.cars.set(c.slotID, st);
      }
      // A car in its garage stall is not on the road; feeding its position would
      // record a "lap" through the pit building. Skipping it leaves a gap the
      // engine re-anchors on when the car reappears.
      if (c.inGarageStall === true) continue;

      const vel = c.carVelocity?.velocity;
      const v =
        typeof vel === 'number' && Number.isFinite(vel) ? Math.min(150, Math.max(0, vel)) : 0;
      // Same two-step as the driven car: dead-reckon the snapshot to now, then
      // let the observer fold that measurement into a smooth position. Here both
      // steps use the REST velocity — there is no shared-memory speed for a car
      // this PC isn't driving — but the win is the same, because the arrival
      // jitter lands in the position, not in the velocity.
      const distM = st.pos.step(clockSec, c.lapDistance + v * ageSec, v, trackLen);
      const d = clamp01(distM / trackLen);
      const lap = player && player.slotId === c.slotID ? player.lap : undefined;
      if (focus && c.slotID === focus.slotID) {
        out = st.engine.update(d, clockSec, c.bestLapTime, '', lap);
      } else {
        st.engine.observe(d, clockSec, c.bestLapTime, '', lap);
      }
    }

    // Drop cars that have left the session, so a long server run doesn't
    // accumulate a trace per driver who ever connected.
    for (const id of this.cars.keys()) if (!seen.has(id)) this.cars.delete(id);
    return out;
  }
}
