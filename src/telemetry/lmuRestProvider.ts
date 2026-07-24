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
import { FuelCalculator } from './fuelCalculator';
import { LmuLocalCarReader, type LocalCarPhysics } from './lmuLocalCar';
import { buildRadar, type RadarCar } from './radar';
import {
  TELEMETRY_SCHEMA_VERSION,
  UNKNOWN_VALUE,
  type FlagState,
  type FuelState,
  type RadarBlip,
  type RelativeEntry,
  type SessionPhase,
  type SessionState,
  type SessionType,
  type PaceDeltas,
  type SkyState,
  type StandingEntry,
  type TelemetryFrame,
  type TyreState,
  type WeatherForecastSlot,
  type DamageState,
  type MfdState,
} from './types';
import { decodeDamage, type RawRepairPayload } from './damage';
import { buildMfdState, type RawGarageVal, type RawPitRow } from './mfdControl';
import { LocalPaceDeltaTracker, trackKeyOf } from './paceDelta';
import { assignClassPositions, isFasterClass, normalizeClass } from './carClass';
import { shouldWarnTraffic, shouldYield } from './yieldAlert';

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
 * How long to keep showing the last good local-car physics after a read returns
 * nothing. The shared-memory reader occasionally misses a single poll (a torn
 * read it couldn't reconcile); without this hold the pedals and tyre temps blink
 * to their "unknown" state for one frame, which reads as flicker on the overlay.
 */
const LOCAL_HOLD_MS = 500;
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
}

/** Fields we consume from `/rest/watch/sessionInfo`. */
interface RestSession {
  trackName?: string;
  lapDistance?: number;
  trackTemp?: number;
  ambientTemp?: number;
  raining?: number;
  maxPathWetness?: number;
  session?: string;
  gamePhase?: string;
  currentEventTime?: number;
  endEventTime?: number;
  /** Seconds left in the current game phase — the live countdown during green. */
  timeRemainingInGamePhase?: number;
  maximumLaps?: number;
  numberOfVehicles?: number;
  sectorFlag?: unknown;
  yellowFlagState?: unknown;
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
  /** `lastOkAt` of the newest REST snapshot already fed to {@link paceDelta}. */
  private paceDeltaSnapshotAt = 0;
  /** Separate calculator fed real litres from shared memory (local car). */
  private readonly localFuel = new FuelCalculator();
  /**
   * Virtual-energy strategy for the focused car, run in **percent** units
   * (0..100, capacity 100) so per-lap burns keep useful precision through the
   * calculator's rounding.
   */
  private readonly energyCalc = new FuelCalculator();
  /** Reads the locally-driven car's inputs + fuel from shared memory. */
  private readonly localCar = new LmuLocalCarReader();
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
  /** Last good radar blips + when, to bridge a single torn readField() (flicker). */
  private lastRadar: RadarBlip[] | null = null;
  private lastRadarAt = 0;
  private readonly port: number;
  private readonly verbose: boolean;

  private standings: RestStanding[] | null = null;
  private session: RestSession | null = null;
  private lastOkAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private live = false;
  /** Player-car tyre wear [FL, FR, RL, RR], `1` fresh → `0` gone. */
  private tyreWear: number[] | null = null;
  private lastGarageOkAt = 0;
  /** Last decoded damage block, and when it last decoded cleanly. */
  private damage: DamageState | null = null;
  private lastDamageOkAt = 0;
  /** Last raw pit menu + garage `VM_*` data, for the MFD-control block. */
  private pitMenuRaw: RawPitRow[] | null = null;
  private garageDataRaw: Record<string, RawGarageVal> | null = null;
  private lastMfdOkAt = 0;
  private garageTimer: NodeJS.Timeout | null = null;
  /** Raw per-session weather forecast from `/rest/sessions/weather`. */
  private weatherForecast: RestWeather | null = null;
  private weatherTimer: NodeJS.Timeout | null = null;

  public constructor(config: LmuRestConfig) {
    this.port = config.lmuApiPort ?? DEFAULT_API_PORT;
    this.verbose = config.verbose;
  }

  public async start(): Promise<void> {
    this.fallback.start();
    this.localCar.start(); // best-effort shared-memory reader for the driven car
    await this.refresh(); // prime the cache before the first poll
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref?.();
    void this.refreshGarage();
    void this.refreshMfd();
    this.garageTimer = setInterval(() => {
      void this.refreshGarage();
      void this.refreshMfd();
    }, GARAGE_REFRESH_INTERVAL_MS);
    this.garageTimer.unref?.();
    void this.refreshWeather();
    this.weatherTimer = setInterval(() => void this.refreshWeather(), WEATHER_REFRESH_INTERVAL_MS);
    this.weatherTimer.unref?.();
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
    if (this.weatherTimer) {
      clearInterval(this.weatherTimer);
      this.weatherTimer = null;
    }
    this.fallback.stop();
    this.localCar.stop();
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

  private async refresh(): Promise<void> {
    try {
      const [standings, session] = await Promise.all([
        this.getJson<RestStanding[]>('/rest/watch/standings'),
        this.getJson<RestSession>('/rest/watch/sessionInfo'),
      ]);
      if (Array.isArray(standings)) this.standings = standings;
      if (session && typeof session === 'object') this.session = session;
      if (Array.isArray(standings) && session) this.lastOkAt = Date.now();
    } catch (err) {
      // Leave the cache in place; the staleness check flips us to the simulator.
      if (this.verbose) console.error('[lmu] refresh failed:', (err as Error).message);
    }
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
   * Pulls the controllable MFD (pit menu + live driving aids). Kept SEPARATE
   * from {@link refreshGarage} on purpose: the repair, pit-menu and
   * garage-setup screens have independent availability (any one can 404 while
   * another answers — e.g. the pit menu exists on track but the repair screen
   * may not), so sharing a `try` would let one screen's absence silently drop
   * the others. The two reads here are also independent of each other.
   */
  private async refreshMfd(): Promise<void> {
    const [pit, garage] = await Promise.all([
      this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu').catch(() => null),
      this.getJson<Record<string, RawGarageVal>>('/rest/garage/getPlayerGarageData').catch(() => null),
    ]);
    if (Array.isArray(pit)) this.pitMenuRaw = pit;
    if (garage && typeof garage === 'object') this.garageDataRaw = garage;
    if (Array.isArray(pit) || (garage && typeof garage === 'object')) {
      this.lastMfdOkAt = Date.now();
    }
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

  private getJson<T>(path: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.port, path, timeout: HTTP_TIMEOUT_MS },
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

    const standings = this.buildStandings(cars, focusId);
    const relative = this.buildRelative(cars, focus, si);
    const session = this.buildSession(cars, si, focus);
    const weather = this.buildWeather(si, session.type);
    const fuel = this.buildFuel(focus, session, local, cars);
    // Live delta to the focused car's own best lap (predictive; UNKNOWN until a
    // reference lap has been driven while the overlay is running). When the
    // focused car is the one driven on this PC, the shared-memory lap clock
    // drives a high-rate exact tracker; spectated cars use the REST tracker.
    const trackLen = typeof si.lapDistance === 'number' && si.lapDistance > 1 ? si.lapDistance : 0;
    const localIsFocus =
      local !== null && playerCar !== undefined && focus !== undefined &&
      playerCar.slotID === focus.slotID;
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
      // frame (~30-60 Hz) but the REST position only every REFRESH_INTERVAL_MS.
      // Feeding a stale position against a live clock makes `t − t_ref(d)` climb
      // at 1.0 s/s between packets and snap back on arrival — a visible sawtooth
      // of up to ~0.2 s. So extrapolate the position forward by the snapshot's
      // age × the car's own velocity, exactly as buildRelative() does, and wrap
      // it at the start/finish line. Both axes then advance together and the
      // delta is smooth; `fresh` tells the tracker which samples are real
      // measurements it may store as reference-lap points.
      const snapshotAt = this.lastOkAt;
      const fresh = snapshotAt !== this.paceDeltaSnapshotAt;
      this.paceDeltaSnapshotAt = snapshotAt;
      const ageSec = Math.min(0.5, Math.max(0, (Date.now() - snapshotAt) / 1000));
      const vel = focus!.carVelocity?.velocity;
      const speedMps =
        typeof vel === 'number' && Number.isFinite(vel) ? Math.min(150, Math.max(0, vel)) : 0;
      const distM = focus!.lapDistance + speedMps * ageSec;
      const laps = distM / trackLen;
      const d = clamp01(laps - Math.floor(laps));
      paceDeltas = this.paceDelta.update(
        d,
        local!.elapsedSec,
        focus!.bestLapTime,
        trackKeyOf(si.trackName || '', trackLen),
        fresh,
      );
      // The single-value Delta widget mirrors the pace widget's session-best
      // Delta T so both agree; fall back to the REST tracker until it arms.
      deltaSec =
        paceDeltas.tSession !== UNKNOWN_VALUE
          ? paceDeltas.tSession
          : this.lapDelta.update(focus, trackLen);
    } else {
      deltaSec = this.lapDelta.update(focus, trackLen);
    }
    const player = this.buildPlayer(focus, standings, local, deltaSec, paceDeltas);
    const mfd = this.buildMfd();
    // Radar is centred on the DRIVEN car (a driver aid), not the broadcast focus:
    // it reads that car's world position + orientation from shared memory, which
    // exists only for the car driven on this PC. Omitted when spectating.
    const radar = this.buildRadarBlips(playerCar, cars);

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
  private buildMfd(): MfdState | undefined {
    if (Date.now() - this.lastMfdOkAt >= GARAGE_STALE_AFTER_MS) return undefined;
    if (!this.pitMenuRaw && !this.garageDataRaw) return undefined;
    return buildMfdState(this.pitMenuRaw, this.garageDataRaw);
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
  ): RadarBlip[] | undefined {
    if (!playerCar) return undefined;
    const field = this.localCar.readField(playerCar.slotID);
    if (!field) {
      // Bridge an occasional torn copy (the reader missed a single frame) so the
      // radar doesn't blink to "NO RADAR DATA"; a genuine drop outlasts the hold.
      if (this.lastRadar && Date.now() - this.lastRadarAt < LOCAL_HOLD_MS) return this.lastRadar;
      return undefined;
    }

    const byId = new Map<number, RestStanding>();
    for (const c of cars) byId.set(c.slotID, c);
    const playerClass = normalizeClass(playerCar.carClass);

    const radarCars: RadarCar[] = field.cars.map(({ slotId, pos }) => {
      const c = byId.get(slotId);
      const carClass = c ? normalizeClass(c.carClass) : undefined;
      const car: RadarCar = { slotId, pos };
      if (carClass) car.carClass = carClass;
      if (c && c.carNumber) car.carNumber = c.carNumber;
      if (isFasterClass(carClass, playerClass)) car.isFasterClass = true;
      return car;
    });

    const blips = buildRadar({ playerPos: field.playerPos, ori: field.ori, cars: radarCars });
    if (!blips) return undefined;
    this.lastRadar = blips;
    this.lastRadarAt = Date.now();
    return blips;
  }

  private buildStandings(cars: RestStanding[], focusId: number): StandingEntry[] {
    const rows = cars.map((c) => ({
      slotId: c.slotID,
      position: c.position,
      driverName: c.driverName || `#${c.carNumber ?? c.slotID}`,
      carNumber: c.carNumber || undefined,
      carClass: normalizeClass(c.carClass),
      gridPosition:
        typeof c.qualification === 'number' && c.qualification > 0 ? c.qualification : undefined,
      gapToLeaderSec: posOrUnknown(c.timeBehindLeader),
      gapToAheadSec: posOrUnknown(c.timeBehindNext),
      lapsBehind: Math.max(0, c.lapsBehindLeader | 0),
      bestLapSec: posOrUnknown(c.bestLapTime),
      lastLapSec: posOrUnknown(c.lastLapTime),
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
    }));
    rows.sort((a, b) => a.position - b.position);
    assignClassPositions(rows);
    return rows;
  }

  /**
   * Cars physically nearest the focused car on track, with a signed time gap
   * (positive = ahead of the focus car on the road, negative = behind).
   *
   * The gap is the wrapped on-track distance between the two cars, converted to
   * time at the focus car's own lap pace — the standard relative-display model.
   *
   * Two models were compared against a live multiclass session:
   * - `timeIntoLap` clock difference: rejected. A car's clock only resets at the
   *   line, so a different-pace car's "gap" freezes mid-lap and jumps by a whole
   *   lap time whenever it crosses the line (its clock wraps on a different
   *   period than the focus car's) — structurally wrong across classes.
   * - Distance × pace (this one): tracks the physical road gap continuously.
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
    const roadDist = (c: RestStanding): number => {
      const v =
        c.carVelocity &&
        typeof c.carVelocity.velocity === 'number' &&
        Number.isFinite(c.carVelocity.velocity)
          ? Math.min(150, Math.max(0, c.carVelocity.velocity)) // m/s, forward only
          : 0;
      return (c.lapDistance as number) + v * ageSec;
    };
    const focusDist = roadDist(focus);

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
      rows.push({ c, gap: (d / denom) * lapTime });
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
      const entry: RelativeEntry = {
        slotId: c.slotID,
        position: c.position,
        driverName: c.driverName || `#${c.carNumber ?? c.slotID}`,
        carNumber: c.carNumber || undefined,
        carClass,
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
    // Prefer the focused car's flag/phase strings (reliable); sessionInfo's
    // gamePhase can be numeric, so fall back to it only as a string.
    const phaseStr = focus?.gamePhase ?? si.gamePhase;
    return {
      type: mapSessionType(si.session),
      phase: mapPhase(phaseStr),
      flag: mapFlag(focus?.flag ?? phaseStr),
      track: si.trackName || 'Unknown',
      timeRemainingSec: timeRemaining,
      totalLaps: maxLaps,
      lapsRemaining,
      currentLap: leaderLaps + 1,
      numCars: typeof si.numberOfVehicles === 'number' ? si.numberOfVehicles : cars.length,
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
      forecast: this.buildForecast(sessionType, trackT, rain, sky),
    };
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
  ) {
    // Virtual-energy strategy rides along with whichever fuel path applies.
    const energy = this.buildEnergy(focus, session, cars);

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
      });
      return { ...s, ...energy };
    }

    const frac = focus && typeof focus.fuelFraction === 'number' ? clamp01(focus.fuelFraction) : -1;
    if (frac < 0) {
      return {
        levelLiters: UNKNOWN_VALUE,
        capacityLiters: UNKNOWN_VALUE,
        perLapAvgLiters: UNKNOWN_VALUE,
        lapsRemaining: UNKNOWN_VALUE,
        lapsToFinish: UNKNOWN_VALUE,
        fuelToFinishLiters: UNKNOWN_VALUE,
        fuelDeltaLiters: UNKNOWN_VALUE,
        refuelToFinishLiters: 0,
        ...energy,
      };
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
    });
    // Keep the unit-independent numbers; blank the litre-denominated ones since
    // we don't know the tank size for a spectated car.
    return {
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
    };
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
  ): Partial<
    Pick<
      FuelState,
      | 'virtualEnergyPct'
      | 'virtualEnergyPerLapPct'
      | 'virtualEnergyLapsRemaining'
      | 'virtualEnergyDeltaPct'
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
    });
    const out: Partial<
      Pick<
        FuelState,
        | 'virtualEnergyPct'
        | 'virtualEnergyPerLapPct'
        | 'virtualEnergyLapsRemaining'
        | 'virtualEnergyDeltaPct'
      >
    > = { virtualEnergyPct: round1(ve * 100) };
    if (s.perLapAvgLiters !== UNKNOWN_VALUE) out.virtualEnergyPerLapPct = s.perLapAvgLiters;
    if (s.lapsRemaining !== UNKNOWN_VALUE) out.virtualEnergyLapsRemaining = s.lapsRemaining;
    if (s.fuelDeltaLiters !== UNKNOWN_VALUE) out.virtualEnergyDeltaPct = s.fuelDeltaLiters;
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
  private buildPlayer(
    focus: RestStanding | undefined,
    standings: StandingEntry[],
    local: LocalCarPhysics | null,
    deltaSec: number,
    paceDeltas: PaceDeltas | undefined,
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
    const tyre = (i: number): TyreState => ({
      // Primary = inner-liner temp (matches the in-game HUD); surface on the sub-line.
      tempC: hudTemps ? (hudTemps[i] as number) : UNKNOWN_VALUE,
      surfaceTempC: surfaceTemps ? (surfaceTemps[i] as number) : UNKNOWN_VALUE,
      wear: wear ? round2(wear[i] as number) : UNKNOWN_VALUE,
    });
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
      speedKph: local ? local.speedKph : restSpeed,
      rpm: local ? local.rpm : UNKNOWN_VALUE,
      maxRpm: local ? local.maxRpm : UNKNOWN_VALUE,
      lap: {
        // Live elapsed time on the current lap, from the REST watch feed. (An
        // earlier build used the shared-memory lap clock mElapsedTime−mLapStartET,
        // but mLapStartET proved unreliable on current LMU builds — wrong,
        // irregular lap durations — so REST timeIntoLap is the trustworthy source.)
        current:
          focus && typeof focus.timeIntoLap === 'number' && focus.timeIntoLap > 0
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
    };
  }
}

/* --------------------------------- helpers -------------------------------- */

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
  switch (asUpper(phase)) {
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
  switch (asUpper(phase)) {
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

/** One point on a lap's distance→time curve (distance as a 0..1 fraction). */
interface DeltaSample {
  d: number;
  t: number;
}

/**
 * Computes a **predictive live lap delta** for the focused car against its own
 * fastest lap, the way a sim's on-screen delta bar does.
 *
 * It records the car's `(distanceFraction, timeIntoLap)` trace over each lap.
 * When the car completes a new personal-best lap (and we captured a reasonably
 * complete trace), that trace becomes the **reference**. Thereafter the delta at
 * any moment is `currentTimeIntoLap − referenceTimeAt(currentDistance)`:
 * negative means ahead of the best lap (faster), positive means behind.
 *
 * Returns {@link UNKNOWN_VALUE} until a reference lap exists (e.g. the opening
 * lap, or a best set before the overlay started — its trace was never seen), and
 * resets cleanly when broadcast focus moves to a different car.
 */
/** Per-car lap-delta state: the in-progress trace and the adopted reference. */
interface CarDeltaState {
  laps: number;
  samples: DeltaSample[];
  ref: DeltaSample[] | null;
  refBest: number;
  /** Whether the reference trace covers the whole lap (captured flag-to-flag). */
  refIsFull: boolean;
}

class LapDeltaTracker {
  /**
   * State per car (keyed by slotID) rather than for a single focused car. A
   * broadcast director constantly switches which car has focus; keeping the
   * reference lap per-car means a car's delta keeps working the instant focus
   * returns to it, instead of resetting to "—" and needing a fresh lap every
   * time the camera cuts away and back.
   */
  private readonly cars = new Map<number, CarDeltaState>();

  public update(focus: RestStanding | undefined, trackLen: number): number {
    if (!focus || trackLen <= 0) return UNKNOWN_VALUE;
    const t = focus.timeIntoLap;
    const dist = focus.lapDistance;
    if (typeof t !== 'number' || typeof dist !== 'number' || t < 0) return UNKNOWN_VALUE;
    const d = clamp01(dist / trackLen);

    let st = this.cars.get(focus.slotID);
    if (!st) {
      st = {
        laps: focus.lapsCompleted | 0,
        samples: [],
        ref: null,
        refBest: Infinity,
        refIsFull: false,
      };
      this.cars.set(focus.slotID, st);
    }

    // Lap boundary: consider adopting the just-completed lap's trace as the
    // reference. A PARTIAL trace (we started watching mid-lap) is still valid —
    // its (distance, timeIntoLap) pairs come from the sim, not from when we
    // began observing — but only *within the span it covers*; interpolation is
    // gated to that span below, so the first observed lap already arms the
    // delta for the covered part of the track instead of waiting another lap.
    const laps = focus.lapsCompleted | 0;
    if (laps !== st.laps) {
      const lastLap = typeof focus.lastLapTime === 'number' ? focus.lastLapTime : -1;
      const first = st.samples[0];
      const last = st.samples[st.samples.length - 1];
      // The trace must at least END at the line so its samples belong to the lap
      // whose time we just received.
      const usable = st.samples.length >= 8 && last !== undefined && last.d > 0.9;
      const isFull = usable && first !== undefined && first.d < 0.1;
      // Reject out-laps / crawls: a real flying lap is within ~40% of the car's
      // own best. Without a sane best yet (first ever lap), accept anything sane.
      const best = focus.bestLapTime;
      const plausible =
        lastLap > 5 &&
        lastLap < 600 &&
        (!(best > 5 && best < 600) || lastLap < best * 1.4);
      // Adopt when faster than the current reference, or to upgrade a partial
      // reference to full coverage (even at a slightly slower time).
      if (usable && plausible && (lastLap < st.refBest || (isFull && !st.refIsFull))) {
        st.ref = st.samples.slice().sort((a, b) => a.d - b.d);
        st.refBest = lastLap;
        st.refIsFull = isFull;
      }
      st.samples = [];
      st.laps = laps;
    }

    // Record only forward progress (ignore pit resets / going backwards). Between
    // REST updates d is unchanged, so this naturally de-dupes to ~one point per
    // real update rather than per 30 Hz frame.
    const last = st.samples[st.samples.length - 1];
    if (last === undefined || (d > last.d && t >= last.t)) st.samples.push({ d, t });

    if (!st.ref || st.ref.length < 2) return UNKNOWN_VALUE;
    const refT = interpTime(st.ref, d);
    if (refT < 0) return UNKNOWN_VALUE;
    const delta = t - refT;
    // Safety net: a lap delta is realistically only a few seconds; anything
    // wilder means the reference is unusable (bad/partial trace), so hide it
    // rather than show nonsense on the bar.
    if (Math.abs(delta) > DELTA_SANE_LIMIT_SEC) return UNKNOWN_VALUE;
    return round2(delta);
  }
}

/** Beyond this |delta| (seconds) we assume a bad reference and report unknown. */
const DELTA_SANE_LIMIT_SEC = 30;
/**
 * Linear-interpolate the reference lap's time at distance fraction `d`.
 * Returns `-1` (unknown) when `d` falls OUTSIDE the trace's covered span —
 * clamping there instead would compare against the span edge's time and produce
 * wildly wrong deltas whenever the reference is a partial lap.
 */
function interpTime(ref: DeltaSample[], d: number): number {
  const n = ref.length;
  // Tolerance for float noise right at the span edges (~0.5% of a lap).
  const EDGE = 0.005;
  if (d < ref[0]!.d - EDGE || d > ref[n - 1]!.d + EDGE) return -1;
  if (d <= ref[0]!.d) return ref[0]!.t;
  if (d >= ref[n - 1]!.d) return ref[n - 1]!.t;
  for (let i = 1; i < n; i++) {
    const b = ref[i]!;
    if (b.d >= d) {
      const a = ref[i - 1]!;
      const span = b.d - a.d;
      return span <= 0 ? a.t : a.t + (b.t - a.t) * ((d - a.d) / span);
    }
  }
  return ref[n - 1]!.t;
}
