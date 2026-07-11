/**
 * @file src/telemetry/rf2Provider.ts
 * @module telemetry/rf2Provider
 *
 * Live telemetry provider for **rFactor 2** and **Le Mans Ultimate** (LMU is
 * built on the same S397/rF2 engine and exposes the same shared memory).
 *
 * ## How it works
 * Both sims publish telemetry through the community **rF2 Shared Memory Map
 * Plugin** (`rFactor2SharedMemoryMapPlugin64.dll` by TheIronWolf). The plugin
 * writes several pagefile-backed, named memory-mapped files:
 *
 * - `$rFactor2SMMP_Telemetry$` — per-vehicle physics (pedals, gear, RPM, fuel,
 *   tyres) as an array of `rF2VehicleTelemetry`.
 * - `$rFactor2SMMP_Scoring$` — session info + per-vehicle standings as
 *   `rF2ScoringInfo` followed by an array of `rF2VehicleScoring`.
 *
 * This provider opens those mappings read-only via the Win32 API (through the
 * {@link https://koffi.dev | koffi} FFI), copies the bytes it needs each poll,
 * and maps the fields into a normalized {@link TelemetryFrame}.
 *
 * ## Plugin requirement
 * The sim will not expose any data unless the plugin is installed. Drop
 * `rFactor2SharedMemoryMapPlugin64.dll` into the sim's `Bin64/Plugins/` folder
 * and enable it (`Plugins` section of the player config / LMU's plugin list).
 * See `docs/ARCHITECTURE.md`. Without the plugin (or with the game closed), the
 * mappings are absent and this provider transparently falls back to the
 * {@link SimulatorProvider} — the server never crashes and the overlays keep
 * running on demo data.
 *
 * ## ABI safety
 * The struct byte-offsets below are derived from the authoritative header
 * (`rF2State.h`, `#pragma pack(4)`) but are **version-sensitive**: a plugin
 * update can shift them. Rather than risk feeding garbage to a live stream,
 * every parse is bounds-checked and run through {@link isFrameSane}; if anything
 * is implausible (or koffi/the mapping is unavailable, or the platform is not
 * Windows) the provider reports `connected = false` and returns a simulator
 * frame. Validate the offsets against your target build before trusting live
 * numbers; until then the sanity gate keeps the overlay safe.
 */

import type { TelemetryProvider } from './provider';
import { SimulatorProvider } from './simulatorProvider';
import { FuelCalculator } from './fuelCalculator';
import {
  TELEMETRY_SCHEMA_VERSION,
  UNKNOWN_VALUE,
  type RelativeEntry,
  type StandingEntry,
  type TelemetryFrame,
  type TyreState,
} from './types';
import type { ServerConfig } from '../server/config';

/* ------------------------- Win32 / shared-memory ------------------------- */

/** `FILE_MAP_READ` access right for `OpenFileMappingW`. */
const FILE_MAP_READ = 0x0004;
/** Named mappings published by the rF2 Shared Memory Map Plugin. */
const MMF_TELEMETRY = '$rFactor2SMMP_Telemetry$';
const MMF_SCORING = '$rFactor2SMMP_Scoring$';
/** Max attempts to get a torn-free (consistent) read of a buffer. */
const TORN_READ_RETRIES = 6;
/** Bytes of each buffer we copy per poll (enough to cover the fields we read). */
const TELEMETRY_COPY_BYTES = 16 + 128 * 2880; // header + full vehicle array
const SCORING_COPY_BYTES = 12 + 560 + 128 * 616; // header + scoringInfo + vehicles

/* ---------------------------------------------------------------------------
 * PROVISIONAL struct offsets (bytes), rF2State.h with #pragma pack(4), x64.
 * Centralized here so a single edit re-targets a new plugin ABI. Validate
 * against a live build; the sanity gate falls back to the simulator if wrong.
 * ------------------------------------------------------------------------- */

/** Version block + size header shared by every mapped buffer. */
const HDR = {
  versionBegin: 0, // unsigned long
  versionEnd: 4, // unsigned long
  // bytesUpdatedHint at 8; buffer body begins at 12.
  body: 12,
} as const;

/** Offsets inside `rF2ScoringInfo` (relative to the start of scoring body). */
const SI = {
  base: HDR.body, // rF2Scoring.mScoringInfo starts right after the header
  mSession: 64,
  mCurrentET: 68,
  mEndET: 76,
  mMaxLaps: 84,
  mLapDist: 88, // double — length of the track lap in metres
  mNumVehicles: 104,
  mGamePhase: 108,
  mRaining: 220,
  mAmbientTemp: 228,
  mTrackTemp: 236,
  mMaxPathWetness: 276,
  mTrackName: 0,
  sizeof: 548, // rF2ScoringInfo size (x64) -> vehicles array follows
} as const;

/** Offsets inside each `rF2VehicleScoring` element (stride 616). */
const VS = {
  stride: 616,
  mID: 0,
  mDriverName: 4, // char[32]
  mTotalLaps: 100, // short
  mLapDist: 104, // double
  mBestLapTime: 144, // double
  mLastLapTime: 168, // double
  mIsPlayer: 196, // bool
  mInPits: 198, // bool
  mPlace: 199, // unsigned char
  mVehicleClass: 200, // char[32]
  mTimeBehindNext: 232, // double
  mLapsBehindNext: 240, // long
  mTimeBehindLeader: 244, // double
  mLapsBehindLeader: 252, // long
  mPitState: 457, // unsigned char
} as const;

/** Offsets inside each `rF2VehicleTelemetry` element (stride 2880). */
const VT = {
  base: 16, // rF2Telemetry.mVehicles starts after header(12)+mNumVehicles(4)
  stride: 2880,
  mID: 0,
  mLocalVelZ: 184 + 16, // rF2Vec3 mLocalVel.z (forward), offset+2*double
  mGear: 352,
  mEngineRPM: 356,
  mUnfilteredThrottle: 388,
  mUnfilteredBrake: 396,
  mUnfilteredSteering: 404,
  mUnfilteredClutch: 412,
  mFuel: 524,
  mEngineMaxRPM: 532,
  mFuelCapacity: 608,
  mWheels: 848, // rF2Wheel mWheels[4]
} as const;

/** Offsets inside each `rF2Wheel` element (stride 344). Temps are KELVIN. */
const WH = {
  stride: 344,
  mBrakeTemp: 24,
  mPressure: 120,
  mTemperature: 128, // double[3] inner/centre/outer, KELVIN
  mWear: 152,
} as const;

/** Kelvin → Celsius. */
const KELVIN = 273.15;

/* --------------------------------- helpers -------------------------------- */

/** Minimal handle to the koffi-bound Win32 functions we use. */
interface Win32 {
  OpenFileMappingW: (access: number, inherit: boolean, name: string) => unknown;
  MapViewOfFile: (
    handle: unknown,
    access: number,
    offHigh: number,
    offLow: number,
    bytes: number,
  ) => unknown;
  UnmapViewOfFile: (addr: unknown) => boolean;
  CloseHandle: (handle: unknown) => boolean;
  /** Copies `len` bytes from a native address into a Node Buffer. */
  read: (addr: unknown, len: number) => Buffer;
}

/**
 * Loads koffi and binds the Win32 memory-mapping functions. Returns `null` on
 * any platform other than Windows or if koffi is not installed — both of which
 * simply mean "no live provider, use the simulator".
 */
function loadWin32(): Win32 | null {
  if (process.platform !== 'win32') return null;
  // Typed as `any`: koffi is an optional dependency, so we must not depend on
  // its type declarations being present at build time.
  let koffi: any;
  try {
    // Optional dependency: absence must never break the app.
    koffi = require('koffi');
  } catch {
    return null;
  }
  try {
    const k32 = koffi.load('kernel32.dll');
    const OpenFileMappingW = k32.func(
      'void* __stdcall OpenFileMappingW(uint32, bool, str16)',
    ) as Win32['OpenFileMappingW'];
    const MapViewOfFile = k32.func(
      'void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)',
    ) as Win32['MapViewOfFile'];
    const UnmapViewOfFile = k32.func(
      'bool __stdcall UnmapViewOfFile(void*)',
    ) as Win32['UnmapViewOfFile'];
    const CloseHandle = k32.func('bool __stdcall CloseHandle(void*)') as Win32['CloseHandle'];
    const read = (addr: unknown, len: number): Buffer => {
      // koffi.decode of a uint8 array yields a plain JS array; copy to Buffer.
      const bytes = koffi.decode(addr, koffi.array('uint8', len)) as number[];
      return Buffer.from(bytes);
    };
    return { OpenFileMappingW, MapViewOfFile, UnmapViewOfFile, CloseHandle, read };
  } catch {
    return null;
  }
}

/** A mapped, readable shared-memory buffer. */
interface MappedBuffer {
  handle: unknown;
  view: unknown;
}

/* ------------------------------ the provider ------------------------------ */

/**
 * Reads live rF2/LMU shared memory, falling back to a {@link SimulatorProvider}
 * whenever real data is unavailable or fails validation.
 * @see TelemetryProvider
 */
export class RF2Provider implements TelemetryProvider {
  public readonly name = 'rf2';

  private readonly fallback = new SimulatorProvider();
  private readonly fuel = new FuelCalculator();
  private readonly win32: Win32 | null;
  private telemetry: MappedBuffer | null = null;
  private scoring: MappedBuffer | null = null;
  private live = false;
  private readonly verbose: boolean;

  public constructor(config: Pick<ServerConfig, 'verbose'>) {
    this.verbose = config.verbose;
    this.win32 = loadWin32();
  }

  public start(): void {
    // The simulator is always ready as a fallback.
    this.fallback.start();
    this.tryOpen();
    // One-time startup status (always shown — useful operator feedback).
    if (this.win32 === null) {
      console.log('[rf2] koffi/Win32 unavailable (non-Windows or not installed) — using simulator.');
    } else if (this.telemetry === null || this.scoring === null) {
      console.log('[rf2] shared memory not found (sim closed or plugin missing) — using simulator.');
    } else {
      console.log('[rf2] connected to rF2/LMU shared memory.');
    }
  }

  public isConnected(): boolean {
    return this.live;
  }

  public stop(): void {
    this.fallback.stop();
    this.closeBuffer(this.telemetry);
    this.closeBuffer(this.scoring);
    this.telemetry = null;
    this.scoring = null;
    this.live = false;
  }

  public poll(nowMs: number, dtMs: number): TelemetryFrame {
    // Attempt a live read; on any problem, degrade to the simulator so the
    // broadcast loop always gets a valid frame.
    const real = this.win32 && this.telemetry && this.scoring ? this.tryReadReal(nowMs) : null;
    if (real !== null && isFrameSane(real)) {
      this.live = true;
      return real;
    }
    // Re-attempt to open the mappings occasionally (e.g. the sim just launched).
    if (this.telemetry === null || this.scoring === null) this.tryOpen();
    this.live = false;
    return this.fallback.poll(nowMs, dtMs);
  }

  /* ----------------------------- mapping I/O ----------------------------- */

  private tryOpen(): void {
    if (this.win32 === null) return;
    if (this.telemetry === null) this.telemetry = this.open(MMF_TELEMETRY, TELEMETRY_COPY_BYTES);
    if (this.scoring === null) this.scoring = this.open(MMF_SCORING, SCORING_COPY_BYTES);
  }

  private open(name: string, bytes: number): MappedBuffer | null {
    const w = this.win32;
    if (w === null) return null;
    try {
      const handle = w.OpenFileMappingW(FILE_MAP_READ, false, name);
      if (!handle) return null;
      const view = w.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, bytes);
      if (!view) {
        w.CloseHandle(handle);
        return null;
      }
      return { handle, view };
    } catch (err) {
      this.log(`open(${name}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  private closeBuffer(buf: MappedBuffer | null): void {
    if (buf === null || this.win32 === null) return;
    try {
      this.win32.UnmapViewOfFile(buf.view);
      this.win32.CloseHandle(buf.handle);
    } catch {
      /* best-effort cleanup */
    }
  }

  /**
   * Reads a buffer with a torn-read guard: it re-copies until the version
   * counters at the top of the buffer match (writer not mid-update) or the
   * retry budget is exhausted.
   * @returns A consistent snapshot Buffer, or `null` if it could not get one.
   */
  private readConsistent(buf: MappedBuffer, bytes: number): Buffer | null {
    const w = this.win32;
    if (w === null) return null;
    try {
      for (let attempt = 0; attempt < TORN_READ_RETRIES; attempt++) {
        const snapshot = w.read(buf.view, bytes);
        const begin = snapshot.readUInt32LE(HDR.versionBegin);
        const end = snapshot.readUInt32LE(HDR.versionEnd);
        if (begin === end) return snapshot;
      }
      return null; // writer kept the buffer busy — skip this frame
    } catch {
      return null;
    }
  }

  /* ------------------------------- parsing ------------------------------- */

  /**
   * Builds a {@link TelemetryFrame} from live shared memory. Returns `null` on
   * any read/parse failure (torn read, bounds error, mapping vanished).
   */
  private tryReadReal(nowMs: number): TelemetryFrame | null {
    if (this.telemetry === null || this.scoring === null) return null;
    const scoring = this.readConsistent(this.scoring, SCORING_COPY_BYTES);
    const telem = this.readConsistent(this.telemetry, TELEMETRY_COPY_BYTES);
    if (scoring === null || telem === null) return null;

    try {
      return this.parseFrame(nowMs, scoring, telem);
    } catch (err) {
      this.log(`parse failed: ${(err as Error).message}`);
      return null;
    }
  }

  private parseFrame(nowMs: number, scoring: Buffer, telem: Buffer): TelemetryFrame {
    const numVehicles = clampInt(scoring.readInt32LE(SI.base + SI.mNumVehicles), 0, 128);
    const scoringVehiclesBase = SI.base + SI.sizeof;

    // --- standings + locate the player ----------------------------------
    const standings: StandingEntry[] = [];
    let playerId: number = UNKNOWN_VALUE;
    let playerScoringOff = -1;
    for (let i = 0; i < numVehicles; i++) {
      const off = scoringVehiclesBase + i * VS.stride;
      const isPlayer = scoring.readUInt8(off + VS.mIsPlayer) !== 0;
      const place = scoring.readUInt8(off + VS.mPlace);
      const entry: StandingEntry = {
        slotId: scoring.readInt32LE(off + VS.mID),
        position: place,
        driverName: readCString(scoring, off + VS.mDriverName, 32),
        carClass: readCString(scoring, off + VS.mVehicleClass, 32) || undefined,
        gapToLeaderSec: nonNeg(scoring.readDoubleLE(off + VS.mTimeBehindLeader)),
        gapToAheadSec: nonNeg(scoring.readDoubleLE(off + VS.mTimeBehindNext)),
        lapsBehind: Math.max(0, scoring.readInt32LE(off + VS.mLapsBehindLeader)),
        bestLapSec: posOrUnknown(scoring.readDoubleLE(off + VS.mBestLapTime)),
        lastLapSec: posOrUnknown(scoring.readDoubleLE(off + VS.mLastLapTime)),
        lapsCompleted: Math.max(0, scoring.readInt16LE(off + VS.mTotalLaps)),
        inPit: scoring.readUInt8(off + VS.mInPits) !== 0,
        isPlayer,
      };
      standings.push(entry);
      if (isPlayer) {
        playerId = entry.slotId;
        playerScoringOff = off;
      }
    }
    standings.sort((a, b) => a.position - b.position);

    // --- player telemetry (match by mID within the telemetry array) ------
    const telemVehicles = clampInt(telem.readInt32LE(HDR.body + 0), 0, 128);
    let playerTelemOff = -1;
    for (let i = 0; i < telemVehicles; i++) {
      const off = VT.base + i * VT.stride;
      if (telem.readInt32LE(off + VT.mID) === playerId) {
        playerTelemOff = off;
        break;
      }
    }
    if (playerTelemOff < 0) throw new Error('player telemetry not found');

    const t = playerTelemOff;
    const throttle = telem.readDoubleLE(t + VT.mUnfilteredThrottle);
    const brake = telem.readDoubleLE(t + VT.mUnfilteredBrake);
    const steer = telem.readDoubleLE(t + VT.mUnfilteredSteering);
    const clutch = telem.readDoubleLE(t + VT.mUnfilteredClutch);
    const fuelLevel = telem.readDoubleLE(t + VT.mFuel);
    const fuelCapacity = telem.readDoubleLE(t + VT.mFuelCapacity);
    const rpm = telem.readDoubleLE(t + VT.mEngineRPM);
    const maxRpm = telem.readDoubleLE(t + VT.mEngineMaxRPM);
    const fwdVel = telem.readDoubleLE(t + VT.mLocalVelZ);
    const speedKph = Math.round(Math.abs(fwdVel) * 3.6);

    const tyres = {
      frontLeft: this.readTyre(telem, t + VT.mWheels + 0 * WH.stride),
      frontRight: this.readTyre(telem, t + VT.mWheels + 1 * WH.stride),
      rearLeft: this.readTyre(telem, t + VT.mWheels + 2 * WH.stride),
      rearRight: this.readTyre(telem, t + VT.mWheels + 3 * WH.stride),
    };

    // --- session --------------------------------------------------------
    const maxLaps = scoring.readInt32LE(SI.base + SI.mMaxLaps);
    const endET = scoring.readDoubleLE(SI.base + SI.mEndET);
    const currentET = scoring.readDoubleLE(SI.base + SI.mCurrentET);
    const timeRemaining = endET > 0 ? Math.max(0, endET - currentET) : UNKNOWN_VALUE;
    const playerStanding =
      playerScoringOff >= 0 ? standings.find((s) => s.slotId === playerId) : undefined;
    const playerLaps = playerStanding?.lapsCompleted ?? 0;
    const playerBest = playerStanding?.bestLapSec ?? UNKNOWN_VALUE;
    const playerLast = playerStanding?.lastLapSec ?? UNKNOWN_VALUE;
    const leaderLaps = standings[0]?.lapsCompleted ?? 0;

    // --- weather (current from scoring; a short flat forecast) -----------
    const trackTempC = scoring.readDoubleLE(SI.base + SI.mTrackTemp);
    const ambientC = scoring.readDoubleLE(SI.base + SI.mAmbientTemp);
    const raining = clamp01(scoring.readDoubleLE(SI.base + SI.mRaining));
    const wetness = clamp01(scoring.readDoubleLE(SI.base + SI.mMaxPathWetness));

    // --- fuel strategy via the shared calculator ------------------------
    const fuelState = this.fuel.update({
      currentFuelLiters: fuelLevel,
      capacityLiters: fuelCapacity,
      lapsCompleted: playerLaps,
      totalRaceLaps: maxLaps > 0 ? maxLaps : 0,
      timeRemainingSec: timeRemaining,
      avgLapTimeSec: playerBest > 0 ? playerBest : 90,
    });

    const relative = this.buildRelative(standings, playerId, playerScoringOff, scoring);

    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      source: 'rf2',
      timestamp: nowMs,
      connected: true,
      session: {
        type: 'race',
        phase: 'green',
        flag: 'green',
        track: readCString(scoring, SI.base + SI.mTrackName, 64) || 'Unknown',
        timeRemainingSec: timeRemaining,
        totalLaps: maxLaps > 0 ? maxLaps : 0,
        currentLap: leaderLaps + 1,
        numCars: numVehicles,
      },
      player: {
        slotId: playerId,
        position: playerStanding?.position ?? UNKNOWN_VALUE,
        pedals: {
          throttle: clamp01(throttle),
          brake: clamp01(brake),
          clutch: clamp01(clutch),
          steer: clamp(steer, -1, 1),
        },
        gear: telem.readInt32LE(t + VT.mGear),
        speedKph,
        rpm: Math.round(rpm),
        maxRpm: Math.round(maxRpm) || 8000,
        lap: {
          // Live current-lap time / delta / sector require additional scoring
          // fields not parsed here; left unknown until validated against a build.
          current: UNKNOWN_VALUE,
          last: playerLast,
          best: playerBest,
          delta: UNKNOWN_VALUE,
          sector: UNKNOWN_VALUE,
        },
        tyres,
      },
      standings,
      relative,
      weather: {
        trackTempC: round1(trackTempC),
        ambientTempC: round1(ambientC),
        rainIntensity: round2(raining),
        trackWetness: round2(wetness),
        forecast: [
          {
            minutesAhead: 0,
            rainChance: raining > 0 ? 1 : 0,
            rainIntensity: round2(raining),
            trackTempC: round1(trackTempC),
            sky: raining > 0.5 ? 'rain' : raining > 0.05 ? 'lightRain' : 'partlyCloudy',
          },
        ],
      },
      fuel: fuelState,
    };
  }

  private readTyre(buf: Buffer, base: number): TyreState {
    const inner = buf.readDoubleLE(base + WH.mTemperature + 0) - KELVIN;
    const centre = buf.readDoubleLE(base + WH.mTemperature + 8) - KELVIN;
    const outer = buf.readDoubleLE(base + WH.mTemperature + 16) - KELVIN;
    return {
      tempC: round1(centre),
      innerC: round1(inner),
      middleC: round1(centre),
      outerC: round1(outer),
      pressureKpa: round1(buf.readDoubleLE(base + WH.mPressure)),
      wear: clamp01(buf.readDoubleLE(base + WH.mWear)),
    };
  }

  /**
   * Builds the relative widget from the player's on-track position: the cars
   * immediately ahead/behind by lap distance, with a signed time gap.
   */
  private buildRelative(
    standings: StandingEntry[],
    playerId: number,
    playerScoringOff: number,
    scoring: Buffer,
  ): RelativeEntry[] {
    if (playerScoringOff < 0) return [];
    // Read every car's lap distance and estimated lap time for gap math.
    const numVehicles = clampInt(scoring.readInt32LE(SI.base + SI.mNumVehicles), 0, 128);
    const base = SI.base + SI.sizeof;
    const playerDist = scoring.readDoubleLE(playerScoringOff + VS.mLapDist);
    const playerBest = scoring.readDoubleLE(playerScoringOff + VS.mBestLapTime);
    const lapTime = playerBest > 0 ? playerBest : 90;
    // On-track gaps are a fraction of a *full lap*, so normalize the distance
    // delta by the TRACK LENGTH — not by any one car's lap distance (which would
    // distort gaps and mis-order cars near the start/finish line).
    const trackLenRaw = scoring.readDoubleLE(SI.base + SI.mLapDist);
    const trackLength = trackLenRaw > 1 ? trackLenRaw : 0;
    const player = standings.find((s) => s.slotId === playerId);
    const playerLaps = player?.lapsCompleted ?? 0;

    const rows = [] as Array<{ entry: StandingEntry; gap: number }>;
    for (let i = 0; i < numVehicles; i++) {
      const off = base + i * VS.stride;
      const id = scoring.readInt32LE(off + VS.mID);
      const std = standings.find((s) => s.slotId === id);
      if (std === undefined || id === playerId) continue;
      const dist = scoring.readDoubleLE(off + VS.mLapDist);
      // Signed on-track distance delta, wrapped into ±half a lap so cars on
      // either side of the start/finish line order correctly.
      let distDelta = dist - playerDist;
      if (trackLength > 0) {
        const half = trackLength / 2;
        if (distDelta > half) distDelta -= trackLength;
        else if (distDelta < -half) distDelta += trackLength;
      }
      // Distance gap → time gap: (fraction of a lap) × lap time.
      const denom = trackLength > 0 ? trackLength : Math.max(1, Math.abs(dist) || 1);
      rows.push({ entry: std, gap: (distDelta / denom) * lapTime });
    }
    rows.sort((a, b) => a.gap - b.gap);

    const toEntry = (std: StandingEntry, gap: number, isPlayer: boolean): RelativeEntry => ({
      slotId: std.slotId,
      position: std.position,
      driverName: std.driverName,
      carClass: std.carClass,
      relativeGapSec: round2(gap),
      // Whole-lap difference vs the player (negative = lapped by the player).
      lapsDifference: isPlayer ? 0 : std.lapsCompleted - playerLaps,
      inPit: std.inPit,
      isPlayer,
    });

    const ahead = rows.filter((r) => r.gap > 0).slice(0, 3);
    const behind = rows.filter((r) => r.gap <= 0).slice(-3);
    const result: RelativeEntry[] = [
      ...ahead.map((r) => toEntry(r.entry, r.gap, false)),
      ...(player ? [toEntry(player, 0, true)] : []),
      ...behind.map((r) => toEntry(r.entry, r.gap, false)),
    ];
    return result;
  }

  /** Verbose-only diagnostic (per-poll failures would otherwise spam at 30 Hz). */
  private log(msg: string): void {
    if (this.verbose) console.log(`[rf2] ${msg}`);
  }
}

/* ------------------------------ validation -------------------------------- */

/**
 * Rejects implausible frames so mis-aligned struct offsets or a bad read can
 * never reach the overlay. Conservative ranges: if any core value is out of
 * bounds we treat the whole frame as untrustworthy and fall back.
 */
export function isFrameSane(f: TelemetryFrame): boolean {
  if (f.session.numCars < 1 || f.session.numCars > 128) return false;
  if (f.standings.length < 1) return false;
  const p = f.player;
  if (!inRange(p.pedals.throttle, -0.05, 1.05)) return false;
  if (!inRange(p.pedals.brake, -0.05, 1.05)) return false;
  if (!inRange(p.rpm, 0, 25000)) return false;
  if (!inRange(p.speedKph, 0, 500)) return false;
  // Tyre temps (°C) should be in a physically plausible band once converted.
  const flt = p.tyres.frontLeft.tempC;
  if (!inRange(flt, -20, 400)) return false;
  // At least the leader should have a printable name.
  const leader = f.standings[0];
  if (leader === undefined || leader.driverName.length === 0) return false;
  return true;
}

/* --------------------------------- utils ---------------------------------- */

function readCString(buf: Buffer, offset: number, maxLen: number): string {
  const end = Math.min(offset + maxLen, buf.length);
  let str = '';
  for (let i = offset; i < end; i++) {
    const c = buf[i];
    if (c === undefined || c === 0) break;
    str += String.fromCharCode(c);
  }
  return str.trim();
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function clampInt(v: number, min: number, max: number): number {
  return Math.round(clamp(v, min, max));
}
function inRange(v: number, min: number, max: number): boolean {
  return Number.isFinite(v) && v >= min && v <= max;
}
function nonNeg(v: number): number {
  return v > 0 ? v : v === 0 ? 0 : UNKNOWN_VALUE;
}
function posOrUnknown(v: number): number {
  return v > 0 ? v : UNKNOWN_VALUE;
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
