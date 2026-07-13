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
import {
  TELEMETRY_SCHEMA_VERSION,
  UNKNOWN_VALUE,
  type FlagState,
  type RelativeEntry,
  type SessionPhase,
  type SessionState,
  type SessionType,
  type SkyState,
  type StandingEntry,
  type TelemetryFrame,
  type TyreState,
  type WeatherForecastSlot,
} from './types';

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

/** A car entry from `/rest/watch/standings` (only the fields we consume). */
interface RestStanding {
  slotID: number;
  position: number;
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
  maximumLaps?: number;
  numberOfVehicles?: number;
  sectorFlag?: unknown;
  yellowFlagState?: unknown;
}

export class LmuRestProvider implements TelemetryProvider {
  public readonly name = 'lmu';

  private readonly fallback = new SimulatorProvider();
  private readonly fuel = new FuelCalculator();
  /** Separate calculator fed real litres from shared memory (local car). */
  private readonly localFuel = new FuelCalculator();
  /** Reads the locally-driven car's inputs + fuel from shared memory. */
  private readonly localCar = new LmuLocalCarReader();
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
  private garageTimer: NodeJS.Timeout | null = null;

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
    this.garageTimer = setInterval(() => void this.refreshGarage(), GARAGE_REFRESH_INTERVAL_MS);
    this.garageTimer.unref?.();
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
    return this.fallback.poll(nowMs, dtMs);
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

  /** Pulls the player car's tyre wear from the pit-menu screen. */
  private async refreshGarage(): Promise<void> {
    try {
      const data = await this.getJson<{ wearables?: { tires?: unknown } }>(
        '/rest/garage/UIScreen/RepairAndRefuel',
      );
      const tires = data && data.wearables ? data.wearables.tires : null;
      if (
        Array.isArray(tires) &&
        tires.length >= 4 &&
        tires.every((v) => typeof v === 'number' && v >= 0 && v <= 1)
      ) {
        this.tyreWear = tires.slice(0, 4) as number[];
        this.lastGarageOkAt = Date.now();
      }
    } catch (err) {
      // Endpoint is only alive inside a session; keep the last data until stale.
      if (this.verbose) console.error('[lmu] garage refresh failed:', (err as Error).message);
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

    // The locally-driven car's physics (inputs + fuel in litres) from shared
    // memory, if someone is driving on this PC. null otherwise. The PLAYER
    // entry's slot id (not the broadcast-focus car's) picks the right record:
    // every locally-simulated car (all AI in single player) has a populated
    // record, so without the id the reader used to grab P1's inputs.
    const playerCar = cars.find((c) => c.player);
    const local = this.localCar.read(playerCar ? playerCar.slotID : undefined);

    const standings = this.buildStandings(cars, focusId);
    const relative = this.buildRelative(cars, focus, si);
    const session = this.buildSession(cars, si, focus);
    const weather = this.buildWeather(si);
    const fuel = this.buildFuel(focus, session, local);
    const player = this.buildPlayer(focus, standings, local);

    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      source: 'lmu',
      timestamp: nowMs,
      connected: true,
      session,
      player,
      standings,
      relative,
      weather,
      fuel,
    };
  }

  private buildStandings(cars: RestStanding[], focusId: number): StandingEntry[] {
    const rows = cars.map((c) => ({
      slotId: c.slotID,
      position: c.position,
      driverName: c.driverName || `#${c.carNumber ?? c.slotID}`,
      carNumber: c.carNumber || undefined,
      carClass: c.carClass || undefined,
      gapToLeaderSec: posOrUnknown(c.timeBehindLeader),
      gapToAheadSec: posOrUnknown(c.timeBehindNext),
      lapsBehind: Math.max(0, c.lapsBehindLeader | 0),
      bestLapSec: posOrUnknown(c.bestLapTime),
      lastLapSec: posOrUnknown(c.lastLapTime),
      lapsCompleted: Math.max(0, c.lapsCompleted | 0),
      inPit: isInPit(c),
      pitStops: typeof c.pitstops === 'number' ? c.pitstops : undefined,
      // Highlight the car currently in broadcast focus.
      isPlayer: c.slotID === focusId,
    }));
    rows.sort((a, b) => a.position - b.position);
    return rows;
  }

  /**
   * Cars physically nearest the focused car on track, with a signed time gap.
   * Uses each car's on-track lap distance normalised by the track length, times
   * the focused car's estimated lap time — the same model as the sim reader.
   */
  private buildRelative(
    cars: RestStanding[],
    focus: RestStanding | undefined,
    si: RestSession,
  ): RelativeEntry[] {
    if (!focus || typeof focus.lapDistance !== 'number') return [];
    const trackLength = typeof si.lapDistance === 'number' && si.lapDistance > 1 ? si.lapDistance : 0;
    const lapTime =
      (focus.estimatedLapTime && focus.estimatedLapTime > 0 ? focus.estimatedLapTime : 0) ||
      (focus.bestLapTime > 0 ? focus.bestLapTime : 90);
    const focusDist = focus.lapDistance;
    const focusLaps = focus.lapsCompleted | 0;

    const rows: Array<{ c: RestStanding; gap: number }> = [];
    for (const c of cars) {
      if (c.slotID === focus.slotID || typeof c.lapDistance !== 'number') continue;
      let d = c.lapDistance - focusDist;
      if (trackLength > 0) {
        const half = trackLength / 2;
        if (d > half) d -= trackLength;
        else if (d < -half) d += trackLength;
      }
      const denom = trackLength > 0 ? trackLength : Math.max(1, Math.abs(c.lapDistance) || 1);
      rows.push({ c, gap: (d / denom) * lapTime });
    }
    rows.sort((a, b) => a.gap - b.gap);

    const toEntry = (c: RestStanding, gap: number, isPlayer: boolean): RelativeEntry => ({
      slotId: c.slotID,
      position: c.position,
      driverName: c.driverName || `#${c.carNumber ?? c.slotID}`,
      carNumber: c.carNumber || undefined,
      carClass: c.carClass || undefined,
      relativeGapSec: round2(gap),
      lapsDifference: isPlayer ? 0 : (c.lapsCompleted | 0) - focusLaps,
      inPit: isInPit(c),
      isPlayer,
    });

    const ahead = rows.filter((r) => r.gap > 0).slice(0, 3);
    const behind = rows.filter((r) => r.gap <= 0).slice(-3);
    return [
      ...ahead.map((r) => toEntry(r.c, r.gap, false)),
      toEntry(focus, 0, true),
      ...behind.map((r) => toEntry(r.c, r.gap, false)),
    ];
  }

  private buildSession(
    cars: RestStanding[],
    si: RestSession,
    focus: RestStanding | undefined,
  ): SessionState {
    const leaderLaps = cars.reduce((m, c) => Math.max(m, c.lapsCompleted | 0), 0);
    const endET = typeof si.endEventTime === 'number' ? si.endEventTime : 0;
    const curET = typeof si.currentEventTime === 'number' ? si.currentEventTime : 0;
    const timeRemaining = endET > 0 ? Math.max(0, endET - curET) : UNKNOWN_VALUE;
    // maximumLaps is a large sentinel (uint max) for timed races.
    const maxLaps =
      typeof si.maximumLaps === 'number' && si.maximumLaps > 0 && si.maximumLaps < 100000
        ? si.maximumLaps
        : 0;
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
      currentLap: leaderLaps + 1,
      numCars: typeof si.numberOfVehicles === 'number' ? si.numberOfVehicles : cars.length,
    };
  }

  private buildWeather(si: RestSession): {
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
    // The sessionInfo endpoint exposes current conditions only; project them
    // forward as a steady timeline so the widget shows its multi-slot strip.
    const forecast: WeatherForecastSlot[] = [0, 15, 30, 45, 60].map((minutesAhead) => ({
      minutesAhead,
      rainChance: rain > 0 ? 1 : 0,
      rainIntensity: round2(rain),
      trackTempC: trackT,
      sky,
    }));
    return {
      trackTempC: trackT,
      ambientTempC: round1(num(si.ambientTemp)),
      rainIntensity: round2(rain),
      trackWetness: round2(wet),
      forecast,
    };
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
  ) {
    // Prefer the locally-driven car's real litres from shared memory: gives the
    // full fuel widget (per-lap, to-finish, margin) instead of laps-only.
    if (local && local.capacityLiters > 0) {
      return this.localFuel.update({
        currentFuelLiters: local.fuelLiters,
        capacityLiters: local.capacityLiters,
        lapsCompleted: local.lapNumber,
        totalRaceLaps: session.totalLaps,
        timeRemainingSec: session.timeRemainingSec,
        avgLapTimeSec: focus && focus.bestLapTime > 0 ? focus.bestLapTime : 90,
      });
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
    };
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
  ) {
    const row = focus ? standings.find((s) => s.slotId === focus.slotID) : undefined;
    // Inputs, gear, RPM and speed come from the locally-driven car's shared
    // memory when available (real pedal trace); otherwise REST gives speed only.
    const restSpeed =
      focus && focus.carVelocity && typeof focus.carVelocity.velocity === 'number'
        ? Math.round(Math.abs(focus.carVelocity.velocity) * 3.6)
        : UNKNOWN_VALUE;
    // Tyre wear for the player's own car from the pit-menu screen. Temps stay
    // unknown — LMU publishes them nowhere (shared memory reads zero, no REST
    // endpoint carries them).
    const wear =
      this.tyreWear !== null && Date.now() - this.lastGarageOkAt < GARAGE_STALE_AFTER_MS
        ? this.tyreWear
        : null;
    const tyre = (i: number): TyreState => ({
      tempC: UNKNOWN_VALUE,
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
        current: UNKNOWN_VALUE,
        last: row ? row.lastLapSec : UNKNOWN_VALUE,
        best: row ? row.bestLapSec : UNKNOWN_VALUE,
        delta: UNKNOWN_VALUE,
        sector: UNKNOWN_VALUE,
      },
      tyres: {
        frontLeft: tyre(0),
        frontRight: tyre(1),
        rearLeft: tyre(2),
        rearRight: tyre(3),
      },
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
