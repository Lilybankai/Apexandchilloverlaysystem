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
/**
 * How long to keep showing the last good local-car physics after a read returns
 * nothing. The shared-memory reader occasionally misses a single poll (a torn
 * read it couldn't reconcile); without this hold the pedals and tyre temps blink
 * to their "unknown" state for one frame, which reads as flicker on the overlay.
 */
const LOCAL_HOLD_MS = 500;

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

export class LmuRestProvider implements TelemetryProvider {
  public readonly name = 'lmu';

  private readonly fallback = new SimulatorProvider();
  private readonly fuel = new FuelCalculator();
  /** Live predictive lap-delta for the focused car vs. its own best lap. */
  private readonly lapDelta = new LapDeltaTracker();
  /** Separate calculator fed real litres from shared memory (local car). */
  private readonly localFuel = new FuelCalculator();
  /** Reads the locally-driven car's inputs + fuel from shared memory. */
  private readonly localCar = new LmuLocalCarReader();
  /** Last good local physics + when, to bridge single missed reads (flicker). */
  private lastLocal: LocalCarPhysics | null = null;
  private lastLocalAt = 0;
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
    const weather = this.buildWeather(si);
    const fuel = this.buildFuel(focus, session, local);
    // Live delta to the focused car's own best lap (predictive; UNKNOWN until a
    // reference lap has been driven while the overlay is running).
    const trackLen = typeof si.lapDistance === 'number' && si.lapDistance > 1 ? si.lapDistance : 0;
    const deltaSec = this.lapDelta.update(focus, trackLen);
    const player = this.buildPlayer(focus, standings, local, deltaSec);

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
      // the cars ahead); leave unknown when the field is absent.
      virtualEnergy:
        typeof c.veFraction === 'number' && c.veFraction >= 0 ? clamp01(c.veFraction) : undefined,
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
    deltaSec: number,
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
        // Live elapsed time on the current lap, from the focused car's REST row.
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
class LapDeltaTracker {
  private slotId = -1;
  private laps = -1;
  private samples: DeltaSample[] = [];
  private ref: DeltaSample[] | null = null;
  private refBest = Infinity;

  public update(focus: RestStanding | undefined, trackLen: number): number {
    if (!focus || trackLen <= 0) return UNKNOWN_VALUE;
    const t = focus.timeIntoLap;
    const dist = focus.lapDistance;
    if (typeof t !== 'number' || typeof dist !== 'number' || t < 0) return UNKNOWN_VALUE;
    const d = clamp01(dist / trackLen);

    // Focus moved to a different car → the delta is about THIS car's own best.
    if (focus.slotID !== this.slotId) {
      this.slotId = focus.slotID;
      this.laps = focus.lapsCompleted | 0;
      this.samples = [];
      this.ref = null;
      this.refBest = Infinity;
    }

    // Lap boundary: adopt the just-completed lap as the reference when it's a new
    // personal best and we captured a near-complete trace of it.
    const laps = focus.lapsCompleted | 0;
    if (laps !== this.laps) {
      const lastLap = typeof focus.lastLapTime === 'number' ? focus.lastLapTime : -1;
      const last = this.samples[this.samples.length - 1];
      const complete = this.samples.length >= 8 && last !== undefined && last.d > 0.9;
      if (lastLap > 0 && lastLap < this.refBest && complete) {
        this.ref = this.samples.slice().sort((a, b) => a.d - b.d);
        this.refBest = lastLap;
      }
      this.samples = [];
      this.laps = laps;
    }

    // Record only forward progress (ignore pit resets / going backwards). Between
    // REST updates d is unchanged, so this naturally de-dupes to ~one point per
    // real update rather than per 30 Hz frame.
    const last = this.samples[this.samples.length - 1];
    if (last === undefined || (d > last.d && t >= last.t)) this.samples.push({ d, t });

    if (!this.ref || this.ref.length < 2) return UNKNOWN_VALUE;
    const refT = interpTime(this.ref, d);
    return refT < 0 ? UNKNOWN_VALUE : round2(t - refT);
  }
}

/** Linear-interpolate the reference lap's time at distance fraction `d`. */
function interpTime(ref: DeltaSample[], d: number): number {
  const n = ref.length;
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
