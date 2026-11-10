/**
 * @file src/telemetry/iracing/iracingProvider.ts
 * @module telemetry/iracing/iracingProvider
 *
 * Live telemetry provider for **iRacing**. Reads the iRacing SDK shared memory
 * (`irsdk.ts`) and the session-info YAML (`sessionInfo.ts`) and produces the same
 * {@link TelemetryFrame} the LMU overlays consume, so every overlay works
 * unchanged.
 *
 * Shaped like {@link RF2Provider}: synchronous reads inside `poll()`, a
 * {@link SimulatorProvider} demo frame whenever the sim is not connected, and
 * the shared engines (`assignClassPositions`, `FuelCalculator`,
 * `PaceAverageTracker`, `PitStopCounter`, `predictLapsToFlag`, the yield rules,
 * the lap log) reused rather than re-derived.
 *
 * ## What is iRacing-specific here
 * - **Enumeration.** Cars come from `DriverInfo.Drivers[]` and index the 64-long
 *   CarIdx arrays — never the other way round (ghost slots exist: CarIdxClass[63]
 *   was set in the capture with no driver). Spectators and the pace car are
 *   excluded everywhere.
 * - **Lap times lag the lap counter.** `CarIdxLastLapTime`/`LapLastLapTime`
 *   update ~1.5–2 s AFTER `CarIdxLapCompleted`/`LapCompleted` increments
 *   (measured in the capture). Anything that reads "the lap just finished" (the
 *   lap log, the five-lap average) goes through {@link LapGate}, which holds the
 *   new count back until the time has caught up.
 * - **Relative** gaps difference `CarIdxEstTime` (the class reference time to
 *   reach each car's track position), wrapped by the focus car's class lap time
 *   — not the leader-gap difference the LMU feed needs.
 * - **Classes** are iRacing's own `CarClassShortName` (`normalizeClassFor`), and
 *   faster/slower comes from the sim's `CarClassRelSpeed`.
 * - **Body-frame signs** for the motion block were derived from the capture:
 *   iRacing uses a right-handed body frame (X forward, Y left, Z up) — under
 *   braking `LongAccel` < 0 and `Pitch` > 0 (nose down), in a left turn
 *   `YawRate`, `LatAccel` and the steering angle are all > 0. The contract's
 *   axes are right-positive / nose-up / braking-positive, hence the negations.
 *
 * Omitted on purpose (no truthful iRacing source): `mfd`, `damage`, `chassis`,
 * `hybrid`, `trackLimits`, `paceScore`, `ghost`, `coach`, VE fuel fields,
 * `manufacturer`/badges/ranks, `sectorFlags`, `pit.entryDistM`, per-car
 * `speedMps`/`sector`/sector times. `trackMap` and `radar` are wired by the
 * integration (see the TODO in {@link IRacingProvider.buildFrame}).
 */

import type { TelemetryProvider } from '../provider';
import { SimulatorProvider } from '../simulatorProvider';
import { FuelCalculator } from '../fuelCalculator';
import { PaceAverageTracker } from '../paceAverage';
import { PitStopCounter } from '../pitStopCounter';
import { predictLapsToFlag } from '../lapsToFlag';
import { shouldWarnTraffic, shouldYield } from '../yieldAlert';
import { assignClassPositions, copyClassPositions, normalizeClassFor } from '../carClass';
import { LapRecorder, appendLap, type LapRecord } from '../lapLog';
import {
  TELEMETRY_SCHEMA_VERSION,
  UNKNOWN_VALUE,
  isPreGreen,
  type FlagState,
  type FuelState,
  type MotionState,
  type PitState,
  type RadarBlip,
  type TrackLimitsState,
  type TrackMapCar,
  type TrackMapState,
  type PitPhase,
  type RelativeEntry,
  type SessionPhase,
  type SessionType,
  type SkyState,
  type StandingEntry,
  type TelemetryFrame,
  type TyreSet,
  type TyreState,
  type WeatherForecastSlot,
} from '../types';
import type { ServerConfig } from '../../server/config';
import { LiveIrsdkSource, type IrsdkFrame, type IrsdkSource } from './irsdk';
import { SessionInfoCache, warmSessionInfoParser, type IrDriver, type IrResult, type IrSessionInfo } from './sessionInfo';
import { iRatingDeltasByClass, type IRatingEntry } from './irating';
import { IracingPositionIntegrator } from './positionIntegrator';
import { buildIracingRadar } from './radar';
import { irSessionId, irTeamStint } from './teamIdentity';
import { IrRaceResultsRecorder, irRaceResultsDir, raceTeleOf } from './raceResults';
import { IrRaceControlReader } from './irRaceControl';
import { TrackMapBuilder } from '../trackMap';
import { writeTrace, type TraceFile } from '../lapTrace';
import { refKeyOf } from '../paceDelta';
import { IracingLapCapture, sectorBoundaries, sectorOf } from './irLapTrace';
import { IrPitTracker, readDriverFlags } from './irPit';
import { IrFuelHistory } from './irFuelData';

/* -------------------------------------------------------------------------- */
/*  Constants and enums                                                       */
/* -------------------------------------------------------------------------- */

/** `IRSDK_UNLIMITED_TIME`. */
const UNLIMITED_TIME_SEC = 604800;
/** Standard gravity, for G channels. */
const G = 9.80665;
/** Window over which the relative closing rate is measured (as LMU's). */
const CLOSING_WINDOW_MS = 800;
/** How long a lap-time update may lag the lap counter before we give up on it. */
const LAP_TIME_SETTLE_MS = 3000;
/**
 * How far behind live (60 Hz frames) the replay system must be before it is a
 * REPLAY the driver is watching rather than iRacing's own out-of-car view.
 *
 * iRacing shows everything off the replay buffer once you leave the car —
 * the garage screen, spectating, the session after you exit — with
 * `IsReplayPlaying` true and `ReplayFrameNumEnd` parked at exactly 1201 (a
 * 20-second tail) at speed 1. That was in every out-of-car stretch of all five
 * 2026-11-10 captures. Reading it as "a replay is on screen" kept the in-game
 * layer up through auto-hide (replays deliberately show the overlays), so
 * auto show/hide never hid anything. 25 s clears the tail with margin; a real
 * replay review is scrubbed far further back, or not at speed 1.
 */
const REPLAY_BEHIND_FRAMES = 1500;
/** `ReplayFrameNumEnd` of iRacing's out-of-car live tail (20 s at 60 Hz). */
const LIVE_TAIL_FRAMES = 1201;

/** `irsdk_SessionState`. */
const SS = { Invalid: 0, GetInCar: 1, Warmup: 2, ParadeLaps: 3, Racing: 4, Checkered: 5, CoolDown: 6 } as const;

/** `irsdk_Flags` bits used here. */
const FLAG = {
  checkered: 0x1,
  white: 0x2,
  green: 0x4,
  yellow: 0x8,
  red: 0x10,
  blue: 0x20,
  yellowWaving: 0x100,
  caution: 0x4000,
  cautionWaving: 0x8000,
  startHidden: 0x10000000,
  startReady: 0x20000000,
  startSet: 0x40000000,
  startGo: 0x80000000,
  /** irsdk_black — a penalty (drive-through / stop-and-go) is waiting to be served. */
  black: 0x10000,
  /** irsdk_disqualify. */
  disqualify: 0x20000,
} as const;

/** How many recent incidents the Track Limits widget is given (newest first). */
const INCIDENT_HISTORY = 6;

/** `irsdk_TrkLoc`. */
const TRK = { NotInWorld: -1, OffTrack: 0, InPitStall: 1, ApproachingPits: 2, OnTrack: 3 } as const;

/** `EngineWarnings` pit-speed-limiter bit. */
const ENGINE_PIT_LIMITER = 0x10;

/* -------------------------------------------------------------------------- */
/*  Public snapshot for the track-map / radar integration                     */
/* -------------------------------------------------------------------------- */

/**
 * The per-tick values the track-map integrator and the radar need, captured
 * each poll. Arrays are indexed by CarIdx (64 entries).
 */
export interface IrTickSnapshot {
  /**
   * Connection epoch: bumped every time the sim (re)connects. A consumer that
   * accumulates state across ticks (the position integrator) must reset when
   * this changes — after an iRacing exit/relaunch the snapshot is `null` while
   * disconnected and comes back with a new epoch.
   */
  epoch: number;
  /** Session identity (`SubSessionID|SessionNum|SessionUniqueID`); reset on change. */
  sessionKey: string;
  /** `SessionTime`, seconds (the sim clock; pauses with the sim). */
  sessionTime: number;
  tick: number;
  trackId: number;
  trackName: string;
  trackConfig: string;
  /** `WeekendInfo.TrackLength` in metres (published in km). */
  trackLengthM: number;
  isOnTrack: boolean;
  playerCarIdx: number;
  focusCarIdx: number;
  /** Body-frame velocity, m/s: X forward, Y left. */
  velocityX: number;
  velocityY: number;
  /** Heading, rad, counter-clockwise positive (math angle). */
  yaw: number;
  /** Compass heading, rad, clockwise from north. */
  yawNorth: number;
  /** Player's `LapDistPct`, 0..1. */
  lapDistPct: number;
  playerTrackSurface: number;
  onPitRoad: boolean;
  /** `irsdk_CarLeftRight` (0 off … 6 two cars right). */
  carLeftRight: number;
  carIdxLapDistPct: number[];
  carIdxOnPitRoad: boolean[];
  carIdxTrackSurface: number[];
  /** CarIdxs that are real entrants (not spectators, not the pace car). */
  entrants: number[];
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** `"R 2.76"` → true. iRacing's Rookie licence class; its holders are not iRating-rated. */
export const isRookieLicence = (text: string | undefined): boolean => !!text && /^R/.test(text.trim());

const fin = (v: number): boolean => typeof v === 'number' && Number.isFinite(v);
const or = (v: number, fallback: number): number => (fin(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);
const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const posOrUnknown = (v: number): number => (fin(v) && v > 0 ? v : UNKNOWN_VALUE);
const DEG = 180 / Math.PI;

/**
 * Holds a car's completed-lap count back until its lap TIME has caught up.
 *
 * iRacing increments the lap counter at the line and publishes the lap time a
 * second or two later; reading both on the crossing frame pairs the new count
 * with the PREVIOUS lap's time. The gate publishes the new count only once the
 * time changes — or, after {@link LAP_TIME_SETTLE_MS}, with no time at all
 * (some laps, e.g. ones the sim did not time, never get one).
 */
export class LapGate {
  /** Laps completed, as published. -1 before the first sighting. */
  public laps = -1;
  /** The settled time of the most recent published lap, or UNKNOWN. */
  public last: number = UNKNOWN_VALUE;
  private pendingSince = -1;
  private lastAtCross = NaN;

  public update(rawLaps: number, rawLast: number, nowMs: number): void {
    if (!fin(rawLaps) || rawLaps < 0) return; // not in world: nothing to say
    const lastNow = fin(rawLast) && rawLast > 0 ? rawLast : UNKNOWN_VALUE;
    if (this.laps < 0 || rawLaps < this.laps) {
      this.laps = rawLaps;
      this.last = lastNow;
      this.pendingSince = -1;
      return;
    }
    if (rawLaps === this.laps) {
      if (this.pendingSince < 0) this.last = lastNow;
      return;
    }
    if (this.pendingSince < 0) {
      this.pendingSince = nowMs;
      this.lastAtCross = lastNow;
    }
    if (lastNow !== this.lastAtCross && lastNow !== UNKNOWN_VALUE) {
      this.laps = rawLaps;
      this.last = lastNow;
      this.pendingSince = -1;
    } else if (nowMs - this.pendingSince > LAP_TIME_SETTLE_MS) {
      this.laps = rawLaps;
      this.last = UNKNOWN_VALUE;
      this.pendingSince = -1;
    }
  }
}

/** iRacing `SessionType` string → {@link SessionType}. */
export function mapSessionType(raw: string): SessionType {
  const t = raw.toLowerCase();
  if (t.includes('race')) return 'race';
  if (t.includes('qualify')) return 'qualifying';
  if (t.includes('warmup')) return 'warmup';
  if (t.includes('practice')) return 'practice';
  if (t.includes('testing')) return 'testday';
  return 'unknown';
}

/** `SessionState` + `SessionFlags` → {@link SessionPhase}. */
export function mapPhase(state: number, flags: number): SessionPhase {
  switch (state) {
    case SS.GetInCar:
      return 'garage';
    case SS.Warmup:
      return 'gridwalk';
    case SS.ParadeLaps:
      return 'formation';
    case SS.Racing:
      if (flags & FLAG.red) return 'redFlag';
      if (flags & (FLAG.caution | FLAG.cautionWaving)) return 'fullCourseYellow';
      return 'green';
    case SS.Checkered:
      return 'checkered';
    case SS.CoolDown:
      return 'cooldown';
    default:
      return 'unknown';
  }
}

/** `SessionFlags` → the single {@link FlagState} shown. */
export function mapFlag(flags: number): FlagState {
  if (flags & FLAG.checkered) return 'checkered';
  if (flags & FLAG.red) return 'red';
  if (flags & (FLAG.yellow | FLAG.yellowWaving | FLAG.caution | FLAG.cautionWaving)) return 'yellow';
  if (flags & FLAG.white) return 'white';
  if (flags & FLAG.blue) return 'blue';
  if (flags & FLAG.green) return 'green';
  return 'none';
}

/**
 * `{ classColor: '#rrggbb' }` for a driver's class, or `{}`. iRacing reports
 * white (0xffffff) for every car in a single-class session, which is not a
 * class colour, so it is omitted and the overlay uses its own palette.
 */
function classColorOf(d: IrDriver): { classColor?: string } {
  const c = d.carClassColor;
  if (c === undefined || c === 0xffffff) return {};
  return { classColor: `#${c.toString(16).padStart(6, '0')}` };
}

/** `irsdk_TrackWetness` (0 unknown … 7 extremely wet) → 0..1. */
const WETNESS = [0, 0, 0.1, 0.2, 0.35, 0.5, 0.75, 1];
const WET_WORDS = ['DRY', 'DRY', 'DAMP', 'DAMP', 'WET', 'WET', 'VERY WET', 'SATURATED'];

/* -------------------------------------------------------------------------- */
/*  Provider                                                                  */
/* -------------------------------------------------------------------------- */

/** Options, mostly for tests and the replay harness. */
export interface IRacingProviderOptions {
  /** Data source; defaults to the live shared memory. */
  source?: IrsdkSource;
  /**
   * Where completed laps go. Defaults to {@link appendLap} (the local lap log);
   * `null` disables lap logging.
   */
  lapSink?: ((rec: LapRecord) => void) | null;
  /**
   * Where each lap's driving trace goes. Defaults to {@link writeTrace} (the
   * local trace store) when `lapSink` is defaulted too, else `null` — a test
   * that captures laps must not write traces into the driver's home.
   */
  traceSink?: ((file: TraceFile) => void) | null;
  /**
   * Persist the pace delta's all-time best under `~/.apex-overlay/pb`.
   * Defaults to on only when `lapSink` is defaulted, for the same reason.
   */
  persistReferences?: boolean;
  /**
   * Where the race-results copy goes (raceResults.ts, the iRacing race log).
   * Defaults to `~/.apex-overlay/racelog/iracing` for the live shared memory
   * and to `null` (nothing written) when a `source` is supplied (tests, replays).
   */
  raceResultsDir?: string | null;
}

/** One standings row plus the raw readings the later blocks need. */
interface CarRow {
  driver: IrDriver;
  idx: number;
  telemPos: number;
  lapsRaw: number;
  pct: number;
  surface: number;
  onPitRoad: boolean;
  best: number;
  last: number;
  f2: number;
  est: number;
  result?: IrResult;
}

export class IRacingProvider implements TelemetryProvider {
  public readonly name = 'iracing';

  private readonly source: IrsdkSource;
  private readonly fallback = new SimulatorProvider();
  private readonly sessionInfo = new SessionInfoCache();
  private readonly fuel = new FuelCalculator();
  private readonly paceAvg = new PaceAverageTracker();
  private readonly pitStops = new PitStopCounter();
  private readonly lapRecorder = new LapRecorder();
  /** Repairs, the pit service and its progress (irPit.ts). */
  private readonly irPit = new IrPitTracker();
  /** iRacing's own fuel history (fueldata.ini), read once per car/track. */
  private readonly fuelHistory = new IrFuelHistory();
  private readonly lapSink: ((rec: LapRecord) => void) | null;
  private readonly traceSink: ((file: TraceFile) => void) | null;
  private readonly persistRefs: boolean;
  /** Lap traces, the pace-delta lap clock and sector splits; see irLapTrace.ts. */
  private readonly capture = new IracingLapCapture();
  /** The race log's results copy (raceResults.ts). */
  public readonly raceResults: IrRaceResultsRecorder;
  private readonly verbose: boolean;
  private live = false;
  private wasConnected = false;
  /** Bumped on every (re)connect; see {@link IrTickSnapshot.epoch}. */
  private epoch = 0;
  private snap: IrTickSnapshot | null = null;
  /**
   * Track map: iRacing publishes no world position for ANY car, so the driven
   * car's position is dead-reckoned from body velocity + yaw, one clean lap is
   * recorded as the outline, and every car is placed on it by lap fraction.
   */
  private readonly integrator = new IracingPositionIntegrator();
  private readonly trackMap = new TrackMapBuilder();
  private integratorRev = -1;
  private integratorEpoch = -1;
  private prevSessionTime = NaN;
  private lastRadar: RadarBlip[] | null = null;
  /** Incident points this session, as the Track Limits block reports them. */
  private incCount = -1;
  private incCharges: number[] = [];
  private incLaps: number[] = [];
  private incEvents = 0;
  private incAt = 0;
  private incLapNow = -1;
  private incOnLap = false;
  private blackSince = 0;
  private blackServedAt = 0;
  private wasBlack = false;
  /** The race engineer's block (irRaceControl.ts). */
  private readonly raceControl = new IrRaceControlReader();
  /** Last tyre temp/wear signature and when it changed (see readingAgeSec). */
  private tyreSig = '';
  private tyreSigAt = 0;

  /* --- per-session state; cleared by resetSession() ------------------------ */
  private sessionKey = '';
  private fuelKey = '';
  private readonly gates = new Map<number, LapGate>();
  private playerGate = new LapGate();
  /** Cars seen in the world during this (race) session — "started". */
  private readonly seenInWorld = new Set<number>();
  /** Laps each car had completed when the chequered flag fell, once it has. */
  private lapsAtFlag: Map<number, number> | null = null;
  private readonly finishLatch = new Map<number, { pos: number; cls?: number }>();
  private readonly gapHistory = new Map<number, { gap: number; at: number; rate: number }>();
  private offTrackCount = 0;
  private wasOffTrack = false;
  private pitVisitStopped = false;
  private pitWorkStartMs = -1;
  private absUntilMs = 0;

  public constructor(config: Pick<ServerConfig, 'verbose'>, opts: IRacingProviderOptions = {}) {
    this.verbose = config.verbose;
    this.source = opts.source ?? new LiveIrsdkSource();
    this.lapSink = opts.lapSink === undefined ? appendLap : opts.lapSink;
    const live = opts.lapSink === undefined;
    this.traceSink = opts.traceSink === undefined ? (live ? writeTrace : null) : opts.traceSink;
    this.persistRefs = opts.persistReferences ?? live;
    this.raceResults = new IrRaceResultsRecorder(
      opts.raceResultsDir !== undefined ? opts.raceResultsDir : opts.source ? null : irRaceResultsDir(),
    );
  }

  public start(): void {
    this.fallback.start();
    warmSessionInfoParser();
    const open = this.source.open();
    console.log(
      open
        ? '[iracing] shared memory found.'
        : '[iracing] shared memory not found (iRacing not running) — using simulator until it is.',
    );
  }

  public stop(): void {
    void this.raceResults.flush();
    this.fallback.stop();
    this.source.close();
    this.live = false;
  }

  public isConnected(): boolean {
    return this.live;
  }

  /** The latest per-tick values for the track map / radar, or `null`. */
  public snapshot(): IrTickSnapshot | null {
    return this.snap;
  }

  /** Session-info parse statistics (for diagnostics and the test). */
  public sessionInfoStats(): { parses: number; lastMs: number; maxMs: number } {
    return {
      parses: this.sessionInfo.parses,
      lastMs: this.sessionInfo.lastParseMs,
      maxMs: this.sessionInfo.maxParseMs,
    };
  }

  public poll(nowMs: number, dtMs: number): TelemetryFrame {
    try {
      if (!this.source.isOpen()) this.source.open();
      const f = this.source.isOpen() ? this.source.read() : null;
      const connected = f !== null && this.source.connected();
      if (!connected) {
        if (this.wasConnected) {
          // iRacing exited / relaunched / left the session (the header can go to
          // all zeros with the mapping still open). A new run restarts the
          // revision counter and may move every offset, so everything derived
          // is dropped and rebuilt from scratch on reconnect.
          this.sessionInfo.reset();
          this.resetSession('');
          this.fuelKey = '';
          this.snap = null;
        }
        this.wasConnected = false;
        this.live = false;
        return this.fallback.poll(nowMs, dtMs);
      }
      if (!this.wasConnected) this.epoch++;
      this.wasConnected = true;
      const info = this.sessionInfo.update(this.source, nowMs);
      if (!info) {
        this.live = false;
        return this.fallback.poll(nowMs, dtMs);
      }
      const frame = this.buildFrame(f, info, nowMs);
      this.live = true;
      try {
        this.raceResults.update(info, raceTeleOf(f, info, frame), nowMs);
      } catch {
        /* the race log is a record, never the frame's problem */
      }
      return frame;
    } catch (err) {
      if (this.verbose) console.log(`[iracing] frame build failed: ${(err as Error).message}`);
      this.live = false;
      return this.fallback.poll(nowMs, dtMs);
    }
  }

  /* ------------------------------------------------------------------------ */

  /**
   * Feeds the dead-reckoning integrator and the shared {@link TrackMapBuilder}
   * from this tick's snapshot, and builds the radar from lap-distance gaps plus
   * iRacing's own CarLeftRight spotter signal. Both blocks are omitted (not
   * empty) when there is nothing truthful to send.
   */
  private buildMapAndRadar(
    s: IrTickSnapshot,
    replayPlaying: boolean,
    towTimeS: number,
    speedMs: number,
    standings: StandingEntry[],
  ): { trackMap?: TrackMapState; radar?: RadarBlip[] } {
    const L = s.trackLengthM;
    if (!(L > 0)) return {};
    if (s.epoch !== this.integratorEpoch) {
      this.integratorEpoch = s.epoch;
      this.integrator.reset();
      this.integratorRev = -1;
      this.prevSessionTime = NaN;
    }
    const dtS = Number.isFinite(this.prevSessionTime) ? s.sessionTime - this.prevSessionTime : 0;
    this.prevSessionTime = s.sessionTime;
    const driving = s.isOnTrack && !s.onPitRoad && !replayPlaying && towTimeS === 0;
    const pos =
      dtS > 0 && dtS < 0.5
        ? this.integrator.step({
            velX: s.velocityX,
            velY: s.velocityY,
            yaw: s.yaw,
            dtS,
            lapDistPct: s.lapDistPct,
            onTrack: driving,
            clean: s.playerTrackSurface !== TRK.OffTrack,
            trackLengthM: L,
          })
        : null;
    const base = {
      trackName: `iracing-${s.trackName}`,
      ...(s.trackConfig ? { trackConfig: s.trackConfig } : {}),
      lengthM: L,
    };
    // A freshly closed reference lap: hand the whole outline to the builder so
    // the map appears right after lap one rather than filling in over a lap.
    if (this.integrator.revision !== this.integratorRev) {
      this.integratorRev = this.integrator.revision;
      const outline = this.integrator.outline();
      if (outline) {
        for (const p of outline) {
          this.trackMap.update({ ...base, lapDistM: p.lapDistPct * L, pos: { x: p.x, y: p.y, z: p.z }, inPit: false });
        }
      }
    }
    const status = this.trackMap.update({
      ...base,
      lapDistM: s.lapDistPct >= 0 ? s.lapDistPct * L : -1,
      pos,
      inPit: s.onPitRoad,
    });

    const entrants = new Set(s.entrants);
    const mapCars: TrackMapCar[] = [];
    for (const idx of s.entrants) {
      const pct = s.carIdxLapDistPct[idx] ?? -1;
      if (!(pct >= 0 && pct <= 1)) continue;
      mapCars.push({
        slotId: idx,
        lapFraction: Math.round(pct * 10000) / 10000,
        inPit: s.carIdxOnPitRoad[idx] === true || s.carIdxTrackSurface[idx] === TRK.InPitStall,
        isPlayer: idx === s.playerCarIdx,
      });
    }
    let trackMap: TrackMapState | undefined;
    if (mapCars.length || status.ready) {
      const progress = status.ready ? 1 : Math.max(status.progress, this.integrator.recordingProgress);
      trackMap = {
        key: status.key,
        revision: status.revision,
        ready: status.ready,
        progress: Math.round(progress * 1000) / 1000,
        ...(status.relearning ? { relearning: true } : {}),
        cars: mapCars,
      };
    }

    // Radar: only for the car actually driven on this PC (CarLeftRight is the
    // player's spotter), and never while spectating another car.
    let radar: RadarBlip[] | undefined;
    if (s.focusCarIdx === s.playerCarIdx && s.isOnTrack && !replayPlaying) {
      const bySlot = new Map(standings.map((e) => [e.slotId, e]));
      const blips = buildIracingRadar({
        carLeftRight: s.carLeftRight,
        playerSlotId: s.playerCarIdx,
        playerPct: s.lapDistPct,
        trackLengthM: L,
        playerSpeedMs: speedMs,
        previous: this.lastRadar,
        cars: s.entrants
          .filter((i) => entrants.has(i) && (s.carIdxLapDistPct[i] ?? -1) >= 0)
          .map((i) => {
            const e = bySlot.get(i);
            return {
              slotId: i,
              pct: s.carIdxLapDistPct[i] ?? -1,
              onPitRoad: s.carIdxOnPitRoad[i] === true,
              ...(e?.carClass ? { carClass: e.carClass } : {}),
              ...(e?.carNumber ? { carNumber: e.carNumber } : {}),
            };
          }),
      });
      this.lastRadar = blips;
      if (blips) radar = blips;
    } else {
      this.lastRadar = null;
    }
    return { ...(trackMap ? { trackMap } : {}), ...(radar ? { radar } : {}) };
  }

  /**
   * iRacing's incident points, in the shape the Track Limits widget already
   * draws for LMU's stewarding points.
   *
   * `PlayerCarMyIncidentCount` moves the instant an incident is charged, by
   * iRacing's own amounts: 1x off-track, 2x loss of control, 4x contact (0x
   * light contact never moves it). Measured on 2026-11-10: every +1 landed with
   * the car on surface 0 (off track), and the 17x DQ in an official race came
   * exactly at `WeekendOptions.IncidentLimit` = 17. In a team race the limit is
   * the TEAM's, so the team count is the one that is judged.
   *
   * Only OUR count is published — official sessions zero everyone else's — so
   * this is a driver's own widget, never a field-wide column.
   */
  private buildIncidents(
    f: IrsdkFrame,
    info: IrSessionInfo,
    flags: number,
    nowMs: number,
  ): TrackLimitsState | undefined {
    const team = info.teamRacing ? f.num('PlayerCarTeamIncidentCount') : NaN;
    const mine = f.num('PlayerCarMyIncidentCount');
    const count = fin(team) && team >= 0 ? team : mine;
    if (!fin(count) || count < 0) return undefined;
    const lap = or(f.num('Lap'), -1);
    if (lap !== this.incLapNow) {
      this.incLapNow = lap;
      this.incOnLap = false;
    }
    if (this.incCount >= 0 && count > this.incCount) {
      this.incCharges.unshift(count - this.incCount);
      this.incLaps.unshift(lap);
      this.incCharges.length = Math.min(this.incCharges.length, INCIDENT_HISTORY);
      this.incLaps.length = Math.min(this.incLaps.length, INCIDENT_HISTORY);
      this.incEvents++;
      this.incAt = nowMs;
      this.incOnLap = true;
    } else if (count < this.incCount) {
      // The count went DOWN: a new session the session key did not catch.
      this.incCharges = [];
      this.incLaps = [];
      this.incEvents = 0;
      this.incAt = 0;
    }
    this.incCount = count;

    const black = (flags & FLAG.black) !== 0;
    if (black && !this.wasBlack) this.blackSince = nowMs;
    if (!black && this.wasBlack) this.blackServedAt = nowMs;
    this.wasBlack = black;

    const limit = info.incidentLimit;
    const block: TrackLimitsState = {
      points: count,
      pointsLimit: limit > 0 ? limit : 0,
      pointsLimitEnforced: limit > 0,
      charges: this.incCharges.slice(),
      charged: this.incEvents,
      chargedLaps: this.incLaps.slice(),
      msSinceCharge: this.incAt > 0 ? nowMs - this.incAt : UNKNOWN_VALUE,
      penalties: black ? 1 : 0,
      msSincePenalty: this.blackSince > 0 ? nowMs - this.blackSince : UNKNOWN_VALUE,
      msSinceServed: this.blackServedAt > 0 ? nowMs - this.blackServedAt : UNKNOWN_VALUE,
      ...((flags & FLAG.disqualify) !== 0 ? { disqualified: true } : {}),
      // A lap with an incident on it is not a clean lap — our rule, the same
      // one the lap log uses; iRacing publishes no per-lap validity live.
      lapValid: !this.incOnLap,
    };
    return block;
  }

  private resetSession(key: string): void {
    this.sessionKey = key;
    this.capture.resetSession();
    this.integrator.reset();
    this.integratorRev = -1;
    this.prevSessionTime = NaN;
    this.lastRadar = null;
    this.incCount = -1;
    this.incCharges = [];
    this.incLaps = [];
    this.incEvents = 0;
    this.incAt = 0;
    this.incLapNow = -1;
    this.incOnLap = false;
    this.blackSince = 0;
    this.blackServedAt = 0;
    this.wasBlack = false;
    this.raceControl.reset();
    this.gates.clear();
    this.playerGate = new LapGate();
    this.seenInWorld.clear();
    this.lapsAtFlag = null;
    this.finishLatch.clear();
    this.gapHistory.clear();
    this.offTrackCount = 0;
    this.wasOffTrack = false;
    this.pitVisitStopped = false;
    this.pitWorkStartMs = -1;
    this.irPit.reset();
  }

  /** Builds the frame. Public for the replay test; may throw (poll catches). */
  public buildFrame(f: IrsdkFrame, info: IrSessionInfo, nowMs: number): TelemetryFrame {
    const sessionNum = or(f.num('SessionNum'), info.currentSessionNum);
    const key = `${info.subSessionId}|${sessionNum}|${or(f.num('SessionUniqueID'), 0)}`;
    if (key !== this.sessionKey) this.resetSession(key);

    const session = info.sessions.find((s) => s.num === sessionNum);
    const sessionType = mapSessionType(session?.type ?? '');
    const isRace = sessionType === 'race';
    const state = or(f.num('SessionState'), 0);
    const flags = or(f.num('SessionFlags'), 0) >>> 0;
    const phase = mapPhase(state, flags);
    const results = new Map<number, IrResult>();
    for (const r of session?.results ?? []) results.set(r.carIdx, r);

    const ownIdx = fin(f.num('PlayerCarIdx')) ? f.num('PlayerCarIdx') : info.driverCarIdx;
    const entrants = info.drivers.filter(
      (d) =>
        d.carIdx >= 0 &&
        d.carIdx < 64 &&
        !d.isSpectator &&
        !d.isPaceCar &&
        d.carIdx !== info.paceCarIdx,
    );
    const byIdx = new Map<number, IrDriver>();
    for (const d of entrants) byIdx.set(d.carIdx, d);
    const camIdx = f.num('CamCarIdx');
    const focusIdx = fin(camIdx) && byIdx.has(camIdx) ? camIdx : ownIdx;
    const ownIsFocus = focusIdx === ownIdx;
    const isOnTrack = f.bool('IsOnTrack');
    // Ours and who drives it (team events: teamIdentity.ts, untested live).
    const stint = irTeamStint(info, ownIdx, isOnTrack);
    const trackLengthM = info.trackLengthM;

    /* --- raw per-car readings ------------------------------------------- */
    const rows: CarRow[] = entrants.map((d) => {
      const i = d.carIdx;
      const r = results.get(i);
      return {
        driver: d,
        idx: i,
        telemPos: or(f.num('CarIdxPosition', i), 0),
        lapsRaw: or(f.num('CarIdxLapCompleted', i), -1),
        pct: or(f.num('CarIdxLapDistPct', i), -1),
        surface: or(f.num('CarIdxTrackSurface', i), TRK.NotInWorld),
        onPitRoad: f.bool('CarIdxOnPitRoad', i),
        best: or(f.num('CarIdxBestLapTime', i), -1),
        last: or(f.num('CarIdxLastLapTime', i), -1),
        f2: or(f.num('CarIdxF2Time', i), 0),
        est: or(f.num('CarIdxEstTime', i), -1),
        ...(r ? { result: r } : {}),
      };
    });
    for (const r of rows) {
      let g = this.gates.get(r.idx);
      if (!g) this.gates.set(r.idx, (g = new LapGate()));
      g.update(r.lapsRaw, r.last, nowMs);
      if (isRace && r.surface !== TRK.NotInWorld) this.seenInWorld.add(r.idx);
    }
    const lapsOf = (r: CarRow): number =>
      r.lapsRaw >= 0 ? r.lapsRaw : Math.max(0, r.result?.lapsComplete ?? 0);
    // A car on track still short of the line it starts from reads LapCompleted
    // -1: count it as such, or the first car across the line (pct back to ~0)
    // sorts BEHIND the grid still waiting to cross (the race-start order
    // jumbled for ~6 s in the 2026-11-10 captures, before CarIdxPosition fills).
    const progress = (r: CarRow): number =>
      (r.lapsRaw === -1 && r.pct >= 0 && r.pct <= 1 ? -1 : lapsOf(r)) + (r.pct >= 0 && r.pct <= 1 ? r.pct : 0);

    // Live order from telemetry; cars it has not scored (0) fall back to the
    // session's YAML results, then to track progress.
    rows.sort((a, b) => {
      const pa = a.telemPos > 0 ? a.telemPos : Infinity;
      const pb = b.telemPos > 0 ? b.telemPos : Infinity;
      if (pa !== pb) return pa - pb;
      const ra = a.result && a.result.position > 0 ? a.result.position : Infinity;
      const rb = b.result && b.result.position > 0 ? b.result.position : Infinity;
      if (ra !== rb) return ra - rb;
      const d = progress(b) - progress(a);
      if (d !== 0) return d;
      return a.idx - b.idx;
    });

    /* --- standings ------------------------------------------------------ */
    const avg = this.paceAvg.update(
      rows.map((r) => {
        const g = this.gates.get(r.idx) as LapGate;
        return {
          slotId: r.idx,
          lapsCompleted: Math.max(0, g.laps),
          lastLapSec: g.last,
          inPit: r.onPitRoad || r.surface === TRK.InPitStall,
          driverName: r.driver.userName,
        };
      }),
      key,
    );
    const stops = this.pitStops.update(
      rows.map((r) => ({ slotId: r.idx, onPitLane: r.onPitRoad || r.surface === TRK.InPitStall })),
      key,
    );

    const leader = rows[0];
    const leaderBest = leader && leader.best > 0 ? leader.best : -1;
    const leaderF2 = leader ? Math.max(0, leader.f2) : 0;
    const standings: StandingEntry[] = rows.map((r, n) => {
      const d = r.driver;
      const lapsBehind =
        isRace && leader ? Math.max(0, Math.floor(progress(leader) - progress(r) + 1e-6)) : 0;
      let gapToLeader: number = UNKNOWN_VALUE;
      if (n === 0) gapToLeader = 0;
      else if (isRace) {
        if (lapsBehind === 0 && r.f2 > 0) gapToLeader = round3(Math.max(0, r.f2 - leaderF2));
      } else if (r.best > 0 && leaderBest > 0) {
        gapToLeader = round3(r.best - leaderBest);
      }
      const pa = avg.get(r.idx);
      const row: StandingEntry = {
        slotId: r.idx,
        position: n + 1,
        driverName: d.userName || d.teamName || `#${d.carNumber || r.idx}`,
        ...(d.carNumber ? { carNumber: d.carNumber } : {}),
        ...(normalizeClassFor('iracing', d.carClassShortName)
          ? { carClass: normalizeClassFor('iracing', d.carClassShortName) }
          : {}),
        gapToLeaderSec: gapToLeader,
        gapToAheadSec: UNKNOWN_VALUE,
        lapsBehind,
        bestLapSec: posOrUnknown(r.best),
        lastLapSec: posOrUnknown(r.last),
        ...(pa ? { avg5Sec: round3(pa.avgSec), avg5Laps: pa.laps } : {}),
        lapsCompleted: lapsOf(r),
        ...(r.pct >= 0 && r.pct <= 1 ? { lapFraction: Math.round(r.pct * 10000) / 10000 } : {}),
        inPit:
          r.onPitRoad || r.surface === TRK.InPitStall || r.surface === TRK.NotInWorld,
        ...(isRace && r.result && r.result.reasonOutId !== 0 ? { retired: true } : {}),
        pitStops: stops.get(r.idx) ?? 0,
        isPlayer: r.idx === focusIdx,
        ...(r.idx === ownIdx && stint.drivingHere ? { isOwn: true } : {}),
        ...(r.idx === ownIdx && stint.teammateDriving ? { teammateDriving: true } : {}),
        ...(d.iRating > 0 ? { iRating: d.iRating } : {}),
        ...(d.licString
          ? { license: { text: d.licString, ...(d.licColor ? { color: d.licColor } : {}) } }
          : {}),
        ...classColorOf(d),
      };
      return row;
    });
    for (let n = 1; n < standings.length; n++) {
      const a = standings[n - 1] as StandingEntry;
      const b = standings[n] as StandingEntry;
      if (a.gapToLeaderSec !== UNKNOWN_VALUE && b.gapToLeaderSec !== UNKNOWN_VALUE) {
        b.gapToAheadSec = round3(Math.max(0, b.gapToLeaderSec - a.gapToLeaderSec));
      }
    }
    if (standings[0]) standings[0].gapToAheadSec = 0;
    assignClassPositions(standings);

    // Projected iRating change: official races only (nothing else moves it),
    // per class. Before the green everyone present counts as a starter.
    if (isRace && info.official) {
      const greenSeen = state >= SS.Racing;
      const entries: IRatingEntry[] = standings.map((s) => {
        const r = rows.find((x) => x.idx === s.slotId) as CarRow;
        return {
          key: s.slotId,
          classId: r.driver.carClassId,
          ir: r.driver.iRating,
          rank: s.classPosition ?? s.position,
          started: !greenSeen || this.seenInWorld.has(s.slotId) || lapsOf(r) > 0,
        };
      });
      const deltas = iRatingDeltasByClass(entries);
      for (const s of standings) {
        // Rookie-licence drivers still count in everyone else's calculation
        // (the field's expected scores include them), but iRacing does not
        // change a Rookie's own iRating: their results row reads "----".
        // Checked against a real official race on 2026-11-10 — all three R
        // drivers unrated, the six D drivers within 0–3 of this projection.
        if (isRookieLicence(s.license?.text)) continue;
        const d = deltas.get(s.slotId);
        if (d !== undefined) s.iRatingDelta = d;
      }
    }

    /* --- finish latch ---------------------------------------------------- */
    if (state >= SS.Checkered && this.lapsAtFlag === null) {
      this.lapsAtFlag = new Map(rows.map((r) => [r.idx, lapsOf(r)]));
    }
    if (this.lapsAtFlag) {
      for (const s of standings) {
        const at = this.lapsAtFlag.get(s.slotId);
        if (!this.finishLatch.has(s.slotId) && at !== undefined && s.lapsCompleted > at) {
          this.finishLatch.set(s.slotId, {
            pos: s.position,
            ...(s.classPosition !== undefined ? { cls: s.classPosition } : {}),
          });
        }
      }
    }

    /* --- relative -------------------------------------------------------- */
    const focusRow = rows.find((r) => r.idx === focusIdx);
    const relative = this.buildRelative(rows, focusRow, standings, isRace, info, nowMs);
    copyClassPositions(standings, relative);

    /* --- session --------------------------------------------------------- */
    const focusStanding = standings.find((s) => s.isPlayer);
    const trem = f.num('SessionTimeRemain');
    const timeRemainingSec =
      fin(trem) && trem >= 0 && trem < UNLIMITED_TIME_SEC - 1 ? round1(trem) : UNKNOWN_VALUE;
    const totalLaps = session?.laps ?? 0;
    const classLeader = focusStanding?.carClass
      ? standings.find((s) => s.carClass === focusStanding.carClass)
      : undefined;
    const focusDriver = focusRow?.driver;
    const classEst = focusDriver && focusDriver.carClassEstLapTime > 0 ? focusDriver.carClassEstLapTime : -1;
    const toFlag = predictLapsToFlag({
      totalLaps,
      timeRemainingSec: isRace ? timeRemainingSec : UNKNOWN_VALUE,
      leaderLapsCompleted: standings[0]?.lapsCompleted ?? 0,
      leaderPaceSec: or(standings[0]?.bestLapSec ?? NaN, classEst),
      paceSec:
        focusStanding && focusStanding.bestLapSec > 0
          ? focusStanding.bestLapSec
          : classLeader && classLeader.bestLapSec > 0
            ? classLeader.bestLapSec
            : classEst,
    });
    const replayEnd = f.num('ReplayFrameNumEnd');
    const replaySpeed = f.num('ReplayPlaySpeed');
    const replay =
      f.bool('IsReplayPlaying') &&
      fin(replayEnd) &&
      (replayEnd > REPLAY_BEHIND_FRAMES ||
        // Paused, slow-motion or fast-forward is a person driving the replay,
        // even close to live — but never iRacing's own parked tail.
        (replayEnd > 60 && replayEnd !== LIVE_TAIL_FRAMES && fin(replaySpeed) && replaySpeed !== 1) ||
        f.bool('ReplayPlaySlowMotion'));
    const startLights =
      flags & (FLAG.startReady | FLAG.startSet | FLAG.startGo)
        ? { frame: flags & FLAG.startGo ? 2 : flags & FLAG.startSet ? 1 : 0, total: 1 }
        : undefined;
    const trackName = info.trackDisplayName || 'Unknown';

    /* --- weather --------------------------------------------------------- */
    const trackTemp = or(f.num('TrackTempCrew'), or(f.num('TrackTemp'), UNKNOWN_VALUE));
    const airTemp = or(f.num('AirTemp'), UNKNOWN_VALUE);
    const precip = clamp01(or(f.num('Precipitation'), 0));
    const wetEnum = clamp(Math.round(or(f.num('TrackWetness'), 0)), 0, 7);
    const wetness = WETNESS[wetEnum] ?? 0;
    const skies = or(f.num('Skies'), -1);
    const sky: SkyState =
      precip > 0.5 ? 'rain' : precip > 0.05 ? 'lightRain' : skies === 0 ? 'clear' : skies === 1 ? 'partlyCloudy' : skies >= 2 ? 'overcast' : 'partlyCloudy';
    const humidity = f.num('RelativeHumidity');
    const wind = f.num('WindVel');
    // iRacing publishes no forecast: the current conditions projected flat, as
    // the rF2 provider does.
    const forecast: WeatherForecastSlot[] = [0, 15, 30, 45, 60].map((minutesAhead) => ({
      minutesAhead,
      rainChance: precip > 0 ? 1 : 0,
      rainIntensity: round2(precip),
      trackTempC: round1(trackTemp),
      ...(minutesAhead === 0 && fin(airTemp) ? { airTempC: round1(airTemp) } : {}),
      ...(minutesAhead === 0 && fin(humidity) ? { humidityPct: Math.round(humidity * 100) } : {}),
      ...(minutesAhead === 0 && fin(wind) ? { windKph: round1(wind * 3.6) } : {}),
      sky,
    }));

    /* --- player ---------------------------------------------------------- */
    const ownDriver = byIdx.get(ownIdx);
    const capacity =
      info.driverCarFuelMaxLtr > 0 ? round2(info.driverCarFuelMaxLtr * (info.driverCarMaxFuelPct || 1)) : UNKNOWN_VALUE;
    const fuelLevel = f.num('FuelLevel');
    const onPitRoad = f.bool('OnPitRoad');
    const inStall = f.bool('PlayerCarInPitStall');
    const playerSurface = or(f.num('PlayerTrackSurface'), TRK.NotInWorld);
    const ownLapsRaw = f.num('LapCompleted');
    const ownPct = f.num('LapDistPct');
    const fuelKey = `${info.trackId}|${key}|${ownIdx}`;
    if (fuelKey !== this.fuelKey) {
      this.fuelKey = fuelKey;
      this.fuel.reset();
    }
    let fuel: FuelState;
    if (ownIsFocus && isOnTrack && fin(fuelLevel) && fuelLevel > 0) {
      // Per-lap burn comes from FuelLevel deltas at the line (the calculator's
      // own job): FuelUsePerHour is kg/h and read 0 while fuel was burning.
      fuel = this.fuel.update({
        currentFuelLiters: fuelLevel,
        capacityLiters: capacity,
        lapsCompleted: fin(ownLapsRaw) && ownLapsRaw >= 0 ? ownLapsRaw : 0,
        totalRaceLaps: totalLaps,
        timeRemainingSec,
        avgLapTimeSec:
          focusStanding && focusStanding.bestLapSec > 0 ? focusStanding.bestLapSec : classEst > 0 ? classEst : 90,
        isRace,
        inPit: onPitRoad || inStall,
        ...(fin(ownPct) && ownPct >= 0 && ownPct <= 1 ? { lapFraction: ownPct } : {}),
      });
    } else {
      fuel = unknownFuel(capacity);
    }

    // iRacing's own per-lap history for this car here: a prior before the first
    // timed lap, carried beside (never inside) the measured average.
    if (ownIsFocus && ownDriver?.carPath) {
      const hist = this.fuelHistory.lookup(ownDriver.carPath, info.trackInternalName, info.driverCarFuelKgPerLtr ?? 0);
      if (hist) {
        fuel.historyPerLapLiters = hist.perLapLiters;
        fuel.historyLaps = hist.laps;
      }
    }

    const tyres = ownIsFocus ? readTyres(f, info) : unknownTyres();
    if (ownIsFocus) {
      // iRacing refreshes tyre temps/wear only in the pit stall: track when the
      // figures last changed so the widget can label them a pit reading.
      const sig = [tyres.frontLeft, tyres.frontRight, tyres.rearLeft, tyres.rearRight]
        .map((t) => `${t.tempC}/${t.wear}`)
        .join('|');
      if (sig !== this.tyreSig) {
        this.tyreSig = sig;
        this.tyreSigAt = nowMs;
      }
      if (this.tyreSigAt > 0 && fin(tyres.frontLeft.tempC) && tyres.frontLeft.tempC !== UNKNOWN_VALUE) {
        tyres.readingAgeSec = Math.max(0, Math.round((nowMs - this.tyreSigAt) / 1000));
      }
    }
    const pedals = ownIsFocus ? this.readPedals(f, nowMs) : { throttle: 0, brake: 0, clutch: 0, steer: 0 };
    const motion = ownIsFocus && isOnTrack ? readMotion(f) : undefined;
    const pit = ownIsFocus && isOnTrack ? this.readPit(f, onPitRoad, inStall, nowMs) : undefined;
    // The pit wall (irPit.ts): repair flags, the booked service and its live
    // progress, and the flags shown to the car on screen, bit by bit.
    if (ownIsFocus && isOnTrack) this.irPit.noteAccel(f, nowMs);
    const repair = ownIsFocus && isOnTrack && !replay ? this.irPit.repair(f, flags, nowMs) : undefined;
    const pitService = ownIsFocus && isOnTrack && !replay ? this.irPit.service(f, onPitRoad || inStall, info.tires) : undefined;
    const driverFlags = ownIsFocus ? readDriverFlags(flags) : readDriverFlags(flags, or(f.num('CarIdxSessionFlags', focusIdx), 0));
    const speed = f.num('Speed');
    const best = f.num('LapBestLapTime');
    const lastLap = f.num('LapLastLapTime');
    const cur = f.num('LapCurrentLapTime');
    const delta = f.num('LapDeltaToBestLap');
    const finish = this.finishLatch.get(focusIdx);

    /* --- lap trace + pace deltas (the car driven on this PC) -------------- */
    const paceDeltas = this.capture.update({
      wallMs: nowMs,
      sessionTime: or(f.num('SessionTime'), NaN),
      pct: or(ownPct, -1),
      driving:
        ownIsFocus && isOnTrack && !replay && !f.bool('IsReplayPlaying') && playerSurface !== TRK.NotInWorld &&
        or(f.num('PlayerCarTowTime'), 0) === 0,
      trackLengthM,
      // Keyed by iRacing's TrackID (one per layout), never the display name, so
      // an iRacing PB can never share a file with an LMU one of the same car.
      refKey:
        this.persistRefs && ownDriver
          ? refKeyOf(`ir-${info.trackId}`, trackLengthM, ownDriver.carScreenName, ownDriver.carClassShortName)
          : '',
      bestLapSec: or(best, -1),
      inPit: onPitRoad || inStall || playerSurface === TRK.InPitStall,
      surface: playerSurface,
      incidents: f.num('PlayerCarMyIncidentCount'),
      speedMps: or(speed, 0),
      velX: f.num('VelocityX'),
      velY: f.num('VelocityY'),
      yaw: f.num('Yaw'),
      channels: {
        throttle: pedals.throttle,
        brake: pedals.brake,
        steer: pedals.steer,
        gear: or(f.num('Gear'), 0),
        speedKph: fin(speed) ? Math.abs(speed) * 3.6 : 0,
        latG: motion ? motion.latG : 0,
        lonG: motion ? motion.lonG : 0,
        tc: 0,
        abs: pedals.abs ?? 0,
        ...(pedals.steerRangeDeg ? { steerRangeDeg: pedals.steerRangeDeg } : {}),
      },
    });
    // Sector in progress — only where iRacing's sectors ARE the contract's
    // three; a fourth sector has no honest 1..3 number.
    const sectorNow =
      ownIsFocus && sectorBoundaries(info.sectorStartPcts).length === 2
        ? sectorOf(or(ownPct, -1), info.sectorStartPcts)
        : UNKNOWN_VALUE;

    /* --- lap log --------------------------------------------------------- */
    if (ownIsFocus && isOnTrack && !replay && ownDriver) {
      this.recordLap(f, info, ownDriver, sessionType, trackName, fuelLevel, capacity, tyres, wetness, precip, trackTemp, airTemp, onPitRoad, inStall, playerSurface, nowMs);
    }

    /* --- snapshot for the map / radar integration ------------------------ */
    this.snap = {
      epoch: this.epoch,
      sessionKey: key,
      sessionTime: or(f.num('SessionTime'), 0),
      tick: f.tick,
      trackId: info.trackId,
      trackName,
      trackConfig: info.trackConfig,
      trackLengthM,
      isOnTrack,
      playerCarIdx: ownIdx,
      focusCarIdx: focusIdx,
      velocityX: or(f.num('VelocityX'), 0),
      velocityY: or(f.num('VelocityY'), 0),
      yaw: or(f.num('Yaw'), 0),
      yawNorth: or(f.num('YawNorth'), 0),
      lapDistPct: or(ownPct, -1),
      playerTrackSurface: playerSurface,
      onPitRoad,
      carLeftRight: or(f.num('CarLeftRight'), 0),
      carIdxLapDistPct: Array.from({ length: 64 }, (_, i) => or(f.num('CarIdxLapDistPct', i), -1)),
      carIdxOnPitRoad: Array.from({ length: 64 }, (_, i) => f.bool('CarIdxOnPitRoad', i)),
      carIdxTrackSurface: Array.from({ length: 64 }, (_, i) => or(f.num('CarIdxTrackSurface', i), -1)),
      entrants: entrants.map((d) => d.carIdx),
    };

    /* --- incidents → the Track Limits block --------------------------------- */
    const trackLimits = ownIsFocus && !replay ? this.buildIncidents(f, info, flags, nowMs) : undefined;
    const iracing =
      ownIsFocus && !replay
        ? this.raceControl.read(f, flags, session?.laps ?? 0, info.incidentLimit, isRace, nowMs)
        : undefined;

    /* --- track map + radar ----------------------------------------------- */
    const { trackMap, radar } = this.buildMapAndRadar(
      this.snap,
      f.bool('IsReplayPlaying') || replay,
      or(f.num('PlayerCarTowTime'), 0),
      or(speed, 0),
      standings,
    );

    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      source: 'iracing',
      timestamp: nowMs,
      connected: true,
      session: {
        type: sessionType,
        phase,
        flag: mapFlag(flags),
        track: trackName,
        ...(info.trackConfig ? { trackConfig: info.trackConfig } : {}),
        timeRemainingSec,
        totalLaps,
        lapsRemaining: toFlag.estimated ? toFlag.laps : UNKNOWN_VALUE,
        currentLap: (standings[0]?.lapsCompleted ?? 0) + 1,
        classLeaderLap: classLeader ? classLeader.lapsCompleted + 1 : UNKNOWN_VALUE,
        numCars: standings.length,
        ...(irSessionId(info, sessionNum) ? { sessionId: irSessionId(info, sessionNum) } : {}),
        notStarted: isPreGreen(phase),
        scheduledLengthSec: session && session.timeSec > 0 ? Math.round(session.timeSec) : UNKNOWN_VALUE,
        ...(startLights ? { startLights } : {}),
        ...(trackLengthM > 0 ? { trackLengthM } : {}),
        // The last lap is under way for us once the WHITE flag shows (iRacing's
        // flags are per car), and stays so under the chequer until we cross.
        finalLap: (flags & (FLAG.white | FLAG.checkered)) !== 0,
        onTrack: isOnTrack,
        elapsedSec: round2(or(f.num('SessionTime'), 0)),
        ...(replay ? { replay: true as const } : {}),
      },
      player: {
        slotId: focusIdx,
        position: focusStanding?.position ?? UNKNOWN_VALUE,
        pedals,
        gear: ownIsFocus ? or(f.num('Gear'), 0) : or(f.num('CarIdxGear', focusIdx), 0),
        speedKph: ownIsFocus && fin(speed) ? Math.round(Math.abs(speed) * 3.6) : 0,
        rpm: Math.round(ownIsFocus ? or(f.num('RPM'), 0) : Math.max(0, or(f.num('CarIdxRPM', focusIdx), 0))),
        maxRpm: Math.round(info.driverCarRedLine > 0 ? info.driverCarRedLine : 8000),
        lap: ownIsFocus
          ? {
              current: fin(cur) && cur > 0 ? round3(cur) : UNKNOWN_VALUE,
              last: posOrUnknown(lastLap),
              best: posOrUnknown(best),
              // iRacing's own delta to best while it is valid; the pace engine's
              // session-best Delta T otherwise, so the bar is never blank on a
              // lap the engine can judge.
              delta:
                f.bool('LapDeltaToBestLap_OK') && fin(delta)
                  ? round3(delta)
                  : paceDeltas && paceDeltas.tSession !== UNKNOWN_VALUE
                    ? round3(paceDeltas.tSession)
                    : UNKNOWN_VALUE,
              sector: sectorNow,
            }
          : {
              current: UNKNOWN_VALUE,
              last: focusStanding?.lastLapSec ?? UNKNOWN_VALUE,
              best: focusStanding?.bestLapSec ?? UNKNOWN_VALUE,
              delta: UNKNOWN_VALUE,
              sector: UNKNOWN_VALUE,
            },
        tyres,
        ...(paceDeltas ? { paceDeltas } : {}),
        finished: finish !== undefined,
        ...(finish ? { finishPosition: finish.pos } : {}),
        ...(finish && finish.cls !== undefined ? { finishClassPosition: finish.cls } : {}),
        ...(motion ? { motion } : {}),
        ...(pit ? { pit } : {}),
        ...(repair ? { repair } : {}),
        ...(pitService ? { pitService } : {}),
        flags: driverFlags,
        ...(trackLimits ? { trackLimits } : {}),
      },
      standings,
      relative,
      ...(radar ? { radar } : {}),
      ...(trackMap ? { trackMap } : {}),
      ...(iracing ? { iracing } : {}),
      weather: {
        trackTempC: round1(trackTemp),
        ambientTempC: round1(airTemp),
        rainIntensity: round2(precip),
        trackWetness: wetness,
        ...(wetEnum > 0 ? { trackCondition: WET_WORDS[wetEnum] as string } : {}),
        forecast,
      },
      fuel,
    };
  }

  /* ------------------------------------------------------------------------ */

  /**
   * The relative panel: the nearest three cars each way on the road around the
   * focus car, ordered furthest-ahead → … → YOU → … → furthest-behind (the LMU
   * order; the widget renders in array order).
   *
   * Gap = `CarIdxEstTime` difference: EstTime is the class reference time to
   * reach a car's current track position, so the difference is "how long until
   * I am where that car is now" — what a relative means. Each car's EstTime is
   * on its own class's reference curve, so it is rescaled into the focus car's
   * time domain first, then wrapped by half the focus car's class lap.
   */
  private buildRelative(
    rows: CarRow[],
    focus: CarRow | undefined,
    standings: StandingEntry[],
    isRace: boolean,
    info: IrSessionInfo,
    nowMs: number,
  ): RelativeEntry[] {
    if (!focus || focus.pct < 0 || focus.surface === TRK.NotInWorld) return [];
    const bySlot = new Map<number, StandingEntry>();
    for (const s of standings) bySlot.set(s.slotId, s);
    const fd = focus.driver;
    const L =
      fd.carClassEstLapTime > 0
        ? fd.carClassEstLapTime
        : focus.best > 0
          ? focus.best
          : info.driverCarEstLapTime > 0
            ? info.driverCarEstLapTime
            : 90;
    const estF = focus.est;
    const focusProgress = Math.max(-1, focus.lapsRaw) + focus.pct;

    const cand: Array<{ r: CarRow; gap: number; laps: number }> = [];
    for (const r of rows) {
      if (r.idx === focus.idx || r.pct < 0 || r.pct > 1 || r.surface === TRK.NotInWorld) continue;
      let dPct = r.pct - focus.pct;
      if (dPct > 0.5) dPct -= 1;
      else if (dPct < -0.5) dPct += 1;
      const roadGap = dPct * L;
      let gap = roadGap;
      if (r.est >= 0 && estF >= 0 && (r.est > 0 || estF > 0)) {
        const Lc = r.driver.carClassEstLapTime;
        const est = Lc > 0 && Lc !== L ? (r.est * L) / Lc : r.est;
        let dt = est - estF;
        if (dt > L / 2) dt -= L;
        else if (dt < -L / 2) dt += L;
        // The road position cannot be stale; on a disagreement about which
        // side of us the car is, it wins.
        const disagrees = Math.abs(dt) > 0.5 && Math.abs(roadGap) > 0.5 && dt > 0 !== roadGap > 0;
        if (!disagrees) gap = dt;
      }
      const laps = isRace
        ? Math.round(Math.max(-1, r.lapsRaw) + r.pct - focusProgress - dPct)
        : 0;
      cand.push({ r, gap, laps });
    }
    cand.sort((a, b) => b.gap - a.gap);

    // Forget cars that have left, so the history cannot grow without bound.
    if (this.gapHistory.size > rows.length + 8) {
      const live = new Set(rows.map((r) => r.idx));
      for (const k of this.gapHistory.keys()) if (!live.has(k)) this.gapHistory.delete(k);
    }

    const relSpeed = fd.carClassRelSpeed;
    const toEntry = (r: CarRow, gap: number, laps: number, isPlayer: boolean): RelativeEntry => {
      const s = bySlot.get(r.idx);
      const inPit = r.onPitRoad || r.surface === TRK.InPitStall;
      const e: RelativeEntry = {
        slotId: r.idx,
        position: s?.position ?? UNKNOWN_VALUE,
        driverName: s?.driverName ?? r.driver.userName,
        ...(s?.carNumber ? { carNumber: s.carNumber } : {}),
        ...(s?.carClass ? { carClass: s.carClass } : {}),
        relativeGapSec: round2(gap),
        lapsDifference: isPlayer ? 0 : laps,
        inPit,
        isPlayer,
        ...(s?.iRating !== undefined ? { iRating: s.iRating } : {}),
        ...(s?.iRatingDelta !== undefined ? { iRatingDelta: s.iRatingDelta } : {}),
        ...(s?.license ? { license: s.license } : {}),
        ...(s?.classColor ? { classColor: s.classColor } : {}),
      };
      if (isPlayer) return e;
      // Faster/slower from the sim's own class speed, and only between
      // different classes.
      const other = r.driver.carClassRelSpeed;
      const differentClass = r.driver.carClassId !== fd.carClassId;
      const faster = differentClass && relSpeed > 0 && other > 0 && other > relSpeed;
      const slower = differentClass && relSpeed > 0 && other > 0 && other < relSpeed;
      const closing = this.closingRate(r.idx, gap, nowMs);
      e.isFasterClass = faster;
      e.closingRateSec = closing;
      const traffic = {
        gapSec: gap,
        lapsDifference: laps,
        fasterClass: faster,
        slowerClass: slower,
        closingRateSec: closing,
        inPit,
      };
      e.yieldTo = shouldYield(traffic);
      e.trafficAhead = shouldWarnTraffic(traffic);
      return e;
    };

    const ahead = cand.filter((c) => c.gap > 0).slice(-3);
    const behind = cand.filter((c) => c.gap <= 0).slice(0, 3);
    return [
      ...ahead.map((c) => toEntry(c.r, c.gap, c.laps, false)),
      toEntry(focus, 0, 0, true),
      ...behind.map((c) => toEntry(c.r, c.gap, c.laps, false)),
    ];
  }

  /** As LMU's: seconds of gap closed per second, over an 800 ms window. */
  private closingRate(slotId: number, gap: number, nowMs: number): number {
    const prev = this.gapHistory.get(slotId);
    if (!prev) {
      this.gapHistory.set(slotId, { gap, at: nowMs, rate: UNKNOWN_VALUE });
      return UNKNOWN_VALUE;
    }
    const dtMs = nowMs - prev.at;
    if (dtMs < CLOSING_WINDOW_MS) return prev.rate;
    const jumped = Math.abs(Math.abs(gap) - Math.abs(prev.gap)) > 10;
    const rate = jumped ? UNKNOWN_VALUE : round2(((Math.abs(prev.gap) - Math.abs(gap)) * 1000) / dtMs);
    this.gapHistory.set(slotId, { gap, at: nowMs, rate });
    return rate;
  }

  /** Driver inputs. Clutch is inverted in iRacing (1 = engaged). */
  private readPedals(f: IrsdkFrame, nowMs: number): TelemetryFrame['player']['pedals'] {
    const steerRad = f.num('SteeringWheelAngle');
    const maxRad = f.num('SteeringWheelAngleMax');
    const clutch = f.num('Clutch');
    const pedals: TelemetryFrame['player']['pedals'] = {
      throttle: round3(clamp01(or(f.num('Throttle'), 0))),
      brake: round3(clamp01(or(f.num('Brake'), 0))),
      clutch: fin(clutch) ? round3(clamp01(1 - clutch)) : 0,
      // iRacing's wheel angle is + = left (CCW); the contract's steer is + = right.
      steer: fin(steerRad) && fin(maxRad) && maxRad > 0 ? round3(clamp(-steerRad / maxRad, -1, 1)) : 0,
    };
    if (fin(maxRad) && maxRad > 0) pedals.steerRangeDeg = Math.round(2 * maxRad * DEG);
    // ABS: iRacing publishes only an on/off flag. Held for 150 ms so a flicker
    // is visible; there is no TC channel, so `tc` is omitted.
    if (f.has('BrakeABSactive')) {
      if (f.bool('BrakeABSactive')) this.absUntilMs = nowMs + 150;
      pedals.abs = nowMs < this.absUntilMs ? 1 : 0;
    }
    return pedals;
  }

  /** The player's pit stop, from the pit-road and stall flags. */
  private readPit(f: IrsdkFrame, onPitRoad: boolean, inStall: boolean, nowMs: number): PitState {
    const speed = or(f.num('Speed'), 0);
    let phase: PitPhase;
    if (!onPitRoad && !inStall) {
      phase = 'none';
      this.pitVisitStopped = false;
    } else if (inStall && Math.abs(speed) < 0.5) {
      phase = 'stopped';
      this.pitVisitStopped = true;
    } else {
      phase = this.pitVisitStopped ? 'exiting' : 'entering';
    }
    const working = phase === 'stopped' && f.bool('PitstopActive');
    if (working && this.pitWorkStartMs < 0) this.pitWorkStartMs = nowMs;
    if (!working) this.pitWorkStartMs = -1;
    const warnings = f.num('EngineWarnings');
    return {
      phase,
      working,
      elapsedSec: working ? round1((nowMs - this.pitWorkStartMs) / 1000) : UNKNOWN_VALUE,
      plannedSec: UNKNOWN_VALUE,
      slackSec: UNKNOWN_VALUE,
      ...(fin(warnings) ? { limiterOn: ((warnings >>> 0) & ENGINE_PIT_LIMITER) !== 0 } : {}),
    };
  }

  /**
   * Feed the local lap log with the DRIVEN car's laps.
   *
   * ## The iRacing clean-lap rule — ours, not iRacing's
   * iRacing publishes no per-lap validity flag. A lap is written dirty when,
   * during it:
   * - the driver's own incident count rose (`PlayerCarMyIncidentCount`) —
   *   recorded as `penalty`, since incident points are the sim's own sanction
   *   count;
   * - the car was on pit road, in its stall, or in the pit entry/exit lanes
   *   (`OnPitRoad`, `PlayerCarInPitStall`, track surface 1/2) — `pit`;
   * - the car was seen on an off-track surface (`PlayerTrackSurface == 0`) —
   *   `limits`, counted per excursion.
   * Plus the lap log's own `partial` / `implausible` rules. Because the lap
   * counter is held by {@link LapGate} until the lap time arrives (~2 s), an
   * event in the first seconds of a new lap can be charged to the lap before.
   */
  private recordLap(
    f: IrsdkFrame,
    info: IrSessionInfo,
    own: IrDriver,
    sessionType: SessionType,
    trackName: string,
    fuelLevel: number,
    capacity: number,
    tyres: TyreSet,
    wetness: number,
    precip: number,
    trackTemp: number,
    airTemp: number,
    onPitRoad: boolean,
    inStall: boolean,
    surface: number,
    nowMs: number,
  ): void {
    if (!this.lapSink) return;
    // `LapCompleted` is -1 from leaving the pit box (or the grid) until the car
    // first crosses the line, then 0, 1, … So the recorder is fed LINE
    // CROSSINGS (LapCompleted + 1): the stretch before the first crossing is the
    // "partial" lap the recorder discards, and the first full lap — often the
    // first timed qualifying lap — is seen from its start and can be clean.
    const rawLaps = f.num('LapCompleted');
    this.playerGate.update(fin(rawLaps) && rawLaps >= -1 ? rawLaps + 1 : NaN, f.num('LapLastLapTime'), nowMs);
    if (this.playerGate.laps < 0) return;
    const off = surface === TRK.OffTrack;
    if (off && !this.wasOffTrack) this.offTrackCount++;
    this.wasOffTrack = off;
    const incidents = f.num('PlayerCarMyIncidentCount');
    const corners = [tyres.frontLeft, tyres.frontRight, tyres.rearLeft, tyres.rearRight];
    const wear = corners.every((c) => c.wear >= 0) ? (corners.map((c) => c.wear) as [number, number, number, number]) : undefined;
    const temps = corners.every((c) => c.tempC > 0) ? (corners.map((c) => c.tempC) as [number, number, number, number]) : undefined;
    const compound = tyres.frontLeft.compound;
    const rec = this.lapRecorder.update(
      {
        sim: 'iracing',
        track: info.trackConfig ? `${trackName} - ${info.trackConfig}` : trackName,
        ...(info.trackConfig ? { trackConfig: info.trackConfig } : {}),
        ...(info.trackInternalName ? { simTrackName: info.trackInternalName } : {}),
        trackLengthM: info.trackLengthM,
        // Track identity across iRacing name variants is its numeric TrackID.
        trackKey: `ir-${info.trackId}`,
        car: own.carScreenName,
        carClass: normalizeClassFor('iracing', own.carClassShortName) ?? '',
        sessionType,
        lapsCompleted: this.playerGate.laps,
        lastLapSec: this.playerGate.last,
        // (No chargedLaps channel in iRacing, so the lap number is unused by
        // the recorder; it is the 1-based lap in progress.)
        inPit: onPitRoad || inStall || surface === TRK.InPitStall || surface === TRK.ApproachingPits,
        limitWarnings: this.offTrackCount,
        currentLapNo: this.playerGate.laps + 1,
        penalties: fin(incidents) ? incidents : UNKNOWN_VALUE,
        ...(fin(trackTemp) && trackTemp !== UNKNOWN_VALUE ? { trackTempC: round1(trackTemp) } : {}),
        ...(fin(airTemp) && airTemp !== UNKNOWN_VALUE ? { ambientTempC: round1(airTemp) } : {}),
        wet: precip > 0 || wetness > 0,
        wetness,
        ...(fin(fuelLevel) && fuelLevel > 0 ? { fuelL: fuelLevel } : {}),
        ...(capacity > 0 ? { capacityL: capacity } : {}),
        ...(wear ? { wear } : {}),
        ...(temps ? { tempC: temps } : {}),
        ...(compound ? { compound } : {}),
      },
      nowMs,
    );
    // A stretch we never saw whole AND the sim never timed (pit exit or grid to
    // the first line crossing) is not a lap in any sense worth a record.
    if (rec && !(rec.lapMs <= 0 && rec.dirty.includes('partial'))) {
      // Pair it with its trace first: the record gains its measured sector
      // splits, and the trace file is written under the record's id, with the
      // record's lap time — the exact `lap_ms` the board compares against.
      const { record, file } = this.capture.attach(rec, this.trackMap.path, info.sectorStartPcts);
      try {
        this.lapSink(record);
        if (file && this.traceSink) this.traceSink(file);
      } catch {
        /* a lap that cannot be written must not take the frame down */
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Block readers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The four tyres. iRacing's L/M/R are the left/middle/right of the tyre seen
 * from behind, so on the LEFT tyres L is the outer shoulder and on the RIGHT
 * tyres L is the inner one. Carcass temps and wear refresh only in the pit
 * stall in live telemetry — these are "last pit" readings.
 */
function readTyres(f: IrsdkFrame, info: IrSessionInfo): TyreSet {
  const compoundIdx = f.num('PlayerTireCompound');
  const compound =
    fin(compoundIdx) && compoundIdx >= 0 ? info.tires[compoundIdx] || undefined : undefined;
  const one = (p: string, right: boolean): TyreState => {
    const l = f.num(`${p}tempCL`);
    const m = f.num(`${p}tempCM`);
    const r = f.num(`${p}tempCR`);
    const wl = f.num(`${p}wearL`);
    const wm = f.num(`${p}wearM`);
    const wr = f.num(`${p}wearR`);
    const press = f.num(`${p}coldPressure`);
    const haveT = fin(l) && fin(m) && fin(r);
    const haveW = fin(wl) && fin(wm) && fin(wr);
    const inner = right ? l : r;
    const outer = right ? r : l;
    return {
      tempC: haveT ? round1((l + m + r) / 3) : UNKNOWN_VALUE,
      ...(haveT ? { innerC: round1(inner), middleC: round1(m), outerC: round1(outer) } : {}),
      ...(fin(press) && press > 0 ? { pressureKpa: round1(press) } : {}),
      wear: haveW ? round3(clamp01((wl + wm + wr) / 3)) : UNKNOWN_VALUE,
      ...(compound ? { compound } : {}),
    };
  };
  return {
    frontLeft: one('LF', false),
    frontRight: one('RF', true),
    rearLeft: one('LR', false),
    rearRight: one('RR', true),
  };
}

function unknownTyres(): TyreSet {
  const t = (): TyreState => ({ tempC: UNKNOWN_VALUE, wear: UNKNOWN_VALUE });
  return { frontLeft: t(), frontRight: t(), rearLeft: t(), rearRight: t() };
}

function unknownFuel(capacity: number): FuelState {
  return {
    levelLiters: UNKNOWN_VALUE,
    capacityLiters: capacity,
    perLapAvgLiters: UNKNOWN_VALUE,
    lapsRemaining: UNKNOWN_VALUE,
    lapsToFinish: UNKNOWN_VALUE,
    fuelToFinishLiters: UNKNOWN_VALUE,
    fuelDeltaLiters: UNKNOWN_VALUE,
    refuelToFinishLiters: UNKNOWN_VALUE,
  };
}

/**
 * The motion block, built directly (the shared `decodeMotion` is ISI axes).
 * iRacing's body frame is X forward, Y left, Z up, right-handed — so left,
 * counter-clockwise and nose-DOWN are positive; see the module note for the
 * capture evidence. The contract wants right / nose-right / nose-up / braking
 * positive and vertical G zero-centred.
 */
function readMotion(f: IrsdkFrame): MotionState | undefined {
  const lat = f.num('LatAccel');
  const lon = f.num('LongAccel');
  const vert = f.num('VertAccel');
  const vx = f.num('VelocityX');
  const vy = f.num('VelocityY');
  if (![lat, lon, vert, vx, vy].every(fin)) return undefined;
  const speedMs = Math.hypot(vx, vy);
  return {
    latG: round3(-lat / G),
    lonG: round3(-lon / G),
    vertG: round3((vert - G) / G),
    yawRate: round3(-or(f.num('YawRate'), 0)),
    pitchRate: round3(-or(f.num('PitchRate'), 0)),
    rollRate: round3(-or(f.num('RollRate'), 0)),
    pitch: round2(-or(f.num('Pitch'), 0) * DEG),
    roll: round2(-or(f.num('Roll'), 0) * DEG),
    heading: round1(or(f.num('YawNorth'), 0) * DEG),
    // + = travelling to the RIGHT of the nose; vy is + left.
    slipAngle: speedMs > 2 ? round2(-Math.atan2(vy, vx) * DEG) : 0,
    speedMs: round2(speedMs),
  };
}
