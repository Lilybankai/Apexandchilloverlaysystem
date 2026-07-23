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
  type FlagState,
  type RadarBlip,
  type RelativeEntry,
  type SessionPhase,
  type SessionType,
  type SkyState,
  type StandingEntry,
  type TelemetryFrame,
  type TyreState,
  type WeatherForecastSlot,
} from './types';
import type { ServerConfig } from '../server/config';
import { assignClassPositions, isFasterClass, normalizeClass } from './carClass';
import { decodeMotion } from './motion';
import { buildRadar, type RadarCar } from './radar';
import type { Vec3 } from './motion';
import { ChassisTracker } from './chassis';
import type { RawCorner, RawCornerSet } from './chassis';

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
// header(12) + rF2ScoringInfo(548) + 128 * rF2VehicleScoring(616). Matches the
// SI/VS offset constants below; the earlier 560 double-counted the 12B header.
const SCORING_COPY_BYTES = 12 + 548 + 128 * 616;

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
  // rF2Vec3 mPos — WORLD position (metres). mVehicleName[32..96] +
  // mTrackName[96..160] put it at 160, three doubles before the verified
  // mLocalVel at 184. The radar's only source of 2-D position.
  mPos: 160,
  mLocalVelZ: 184 + 16, // rF2Vec3 mLocalVel.z (forward), offset+2*double
  // Motion block — identical field layout to LMU (only the record STRIDE
  // differs between the two sims), so these are the same offsets documented in
  // lmuLocalCar.ts: mLocalVel(184) mLocalAccel(208) mOri[3](232) mLocalRot(304)
  // mLocalRotAccel(328) -> mGear(352).
  mLocalVel: 184,
  mLocalAccel: 208,
  mOri: 232,
  mLocalRot: 304,
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

/**
 * Offsets inside each `rF2Wheel` element (stride 344). Temps are KELVIN.
 *
 * The load/suspension group at the head of the struct is the standard ISI
 * `TelemWheelV01` prefix; the four temperature/pressure/wear offsets below it
 * were verified live and are what fix the field order, so the head offsets
 * follow from the same layout rather than needing separate probing.
 */
const WH = {
  stride: 344,
  mSuspensionDeflection: 0, // double, metres, positive = compressed
  mRideHeight: 8, // double, metres
  mSuspForce: 16, // double, Newtons (pushrod load)
  mBrakeTemp: 24,
  mTireLoad: 104, // double, Newtons — vertical load through the contact patch
  mGripFract: 112, // double, 0..1 fraction of the patch still gripping
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
  /**
   * Returns the size in bytes of the committed memory region at `addr` (via
   * `VirtualQuery`), or 0 if it cannot be determined. Used to clamp reads to the
   * plugin's actual buffer size, which is smaller than our worst-case struct.
   */
  regionSize: (addr: unknown) => number;
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
    const VirtualQuery = k32.func(
      'size_t __stdcall VirtualQuery(void*, void*, size_t)',
    ) as (addr: unknown, mbi: Buffer, len: number) => number;
    const read = (addr: unknown, len: number): Buffer => {
      // koffi.decode of a uint8 array yields a plain JS array; copy to Buffer.
      const bytes = koffi.decode(addr, koffi.array('uint8', len)) as number[];
      return Buffer.from(bytes);
    };
    // MEMORY_BASIC_INFORMATION is 48 bytes on x64; RegionSize (SIZE_T) is at
    // byte offset 24. VirtualQuery writes it into the caller's buffer.
    const MBI_BYTES = 48;
    const REGION_SIZE_OFFSET = 24;
    const regionSize = (addr: unknown): number => {
      try {
        const mbi = Buffer.alloc(MBI_BYTES);
        if (VirtualQuery(addr, mbi, MBI_BYTES) === 0) return 0;
        return Number(mbi.readBigUInt64LE(REGION_SIZE_OFFSET));
      } catch {
        return 0;
      }
    };
    return { OpenFileMappingW, MapViewOfFile, UnmapViewOfFile, CloseHandle, read, regionSize };
  } catch {
    return null;
  }
}

/** A mapped, readable shared-memory buffer. */
interface MappedBuffer {
  handle: unknown;
  view: unknown;
  /** Number of bytes safe to read from `view` (the plugin's actual region). */
  size: number;
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
  /**
   * Cross-frame state for the four-corner load channels — it learns a
   * per-corner reference over ~25 s, so it must survive between polls.
   */
  private readonly chassisTracker = new ChassisTracker();
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

  private open(name: string, maxBytes: number): MappedBuffer | null {
    const w = this.win32;
    if (w === null) return null;
    try {
      const handle = w.OpenFileMappingW(FILE_MAP_READ, false, name);
      if (!handle) return null;
      // Map the WHOLE region (length 0). The plugin sizes its buffer to the
      // real max grid, which is often SMALLER than our worst-case struct size;
      // requesting more bytes than exist makes MapViewOfFile fail outright and
      // looks (wrongly) like "no sim running".
      const view = w.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
      if (!view) {
        w.CloseHandle(handle);
        return null;
      }
      // Clamp all future reads to the actual mapped bytes so a fixed-size read
      // can never run past the end of the region.
      const region = w.regionSize(view);
      const size = region > 0 ? Math.min(region, maxBytes) : maxBytes;
      return { handle, view, size };
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
  private readConsistent(buf: MappedBuffer): Buffer | null {
    const w = this.win32;
    if (w === null) return null;
    try {
      for (let attempt = 0; attempt < TORN_READ_RETRIES; attempt++) {
        const snapshot = w.read(buf.view, buf.size);
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
    const scoring = this.readConsistent(this.scoring);
    const telem = this.readConsistent(this.telemetry);
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
        carClass: normalizeClass(readCString(scoring, off + VS.mVehicleClass, 32)),
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
    assignClassPositions(standings);

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

    // Motion block, via the shared decoder that owns the axis convention.
    const vec = (off: number): Vec3 => ({
      x: telem.readDoubleLE(off),
      y: telem.readDoubleLE(off + 8),
      z: telem.readDoubleLE(off + 16),
    });
    const motion = decodeMotion({
      accel: vec(t + VT.mLocalAccel),
      rot: vec(t + VT.mLocalRot),
      vel: vec(t + VT.mLocalVel),
      ori: [vec(t + VT.mOri), vec(t + VT.mOri + 24), vec(t + VT.mOri + 48)],
    });

    const tyres = {
      frontLeft: this.readTyre(telem, t + VT.mWheels + 0 * WH.stride),
      frontRight: this.readTyre(telem, t + VT.mWheels + 1 * WH.stride),
      rearLeft: this.readTyre(telem, t + VT.mWheels + 2 * WH.stride),
      rearRight: this.readTyre(telem, t + VT.mWheels + 3 * WH.stride),
    };

    // Wheel load/suspension block, read raw in the sim's own units. Every
    // threshold and conversion belongs to telemetry/chassis.ts — the same
    // division of labour the motion block uses with decodeMotion().
    const readCorner = (wheel: number): RawCorner => {
      const b = t + VT.mWheels + wheel * WH.stride;
      return {
        loadN: telem.readDoubleLE(b + WH.mTireLoad),
        deflectionM: telem.readDoubleLE(b + WH.mSuspensionDeflection),
        rideHeightM: telem.readDoubleLE(b + WH.mRideHeight),
        suspForceN: telem.readDoubleLE(b + WH.mSuspForce),
        gripFract: telem.readDoubleLE(b + WH.mGripFract),
      };
    };
    const rawCorners: RawCornerSet = [readCorner(0), readCorner(1), readCorner(2), readCorner(3)];

    // --- session --------------------------------------------------------
    const maxLaps = scoring.readInt32LE(SI.base + SI.mMaxLaps);
    const sessionCode = scoring.readInt32LE(SI.base + SI.mSession);
    const gamePhase = scoring.readUInt8(SI.base + SI.mGamePhase);
    const endET = scoring.readDoubleLE(SI.base + SI.mEndET);
    const currentET = scoring.readDoubleLE(SI.base + SI.mCurrentET);
    const timeRemaining = endET > 0 ? Math.max(0, endET - currentET) : UNKNOWN_VALUE;
    // Decoded here rather than beside the raw read because the tracker's
    // reference average is advanced on the SIM clock, which only becomes
    // available at this point in the parse.
    const chassis = this.chassisTracker.update(rawCorners, currentET);
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
    const radar = this.buildRadarBlips(telem, telemVehicles, playerTelemOff, playerId, standings);

    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      source: 'rf2',
      timestamp: nowMs,
      connected: true,
      session: {
        type: mapSessionType(sessionCode),
        phase: mapSessionPhase(gamePhase),
        flag: mapFlag(gamePhase),
        track: readCString(scoring, SI.base + SI.mTrackName, 64) || 'Unknown',
        timeRemainingSec: timeRemaining,
        totalLaps: maxLaps > 0 ? maxLaps : 0,
        lapsRemaining: UNKNOWN_VALUE,
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
        ...(motion ? { motion } : {}),
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
        // Absent rather than zeroed when the wheel block fails its guards, so
        // the widget can tell "no data" from "a car sitting perfectly flat".
        ...(chassis ? { chassis } : {}),
      },
      standings,
      relative,
      ...(radar ? { radar } : {}),
      weather: {
        trackTempC: round1(trackTempC),
        ambientTempC: round1(ambientC),
        rainIntensity: round2(raining),
        trackWetness: round2(wetness),
        forecast: this.buildLiveForecast(raining, trackTempC),
      },
      fuel: fuelState,
    };
  }

  /**
   * Builds the weather forecast timeline for the live path.
   *
   * The rF2/LMU **Scoring** buffer only exposes *current* conditions, so until
   * the true multi-slot forecast in the Weather/Extended buffer is parsed and
   * validated on hardware, we project current conditions forward as a steady
   * ("no change expected") timeline at the same 0/15/30/45/60-minute cadence the
   * widget and simulator use. This gives the widget a proper multi-slot strip
   * instead of a single now-slot; wire real lookahead in here once the Weather
   * buffer offsets are validated on a live build.
   */
  private buildLiveForecast(raining: number, trackTempC: number): WeatherForecastSlot[] {
    const sky: SkyState = raining > 0.5 ? 'rain' : raining > 0.05 ? 'lightRain' : 'partlyCloudy';
    return [0, 15, 30, 45, 60].map((minutesAhead) => ({
      minutesAhead,
      rainChance: raining > 0 ? 1 : 0,
      rainIntensity: round2(raining),
      trackTempC: round1(trackTempC),
      sky,
    }));
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

  /**
   * Car-relative radar blips from the telemetry buffer already in hand: every
   * car's world `mPos` and the player's `mOri`, projected by the shared
   * {@link buildRadar} geometry. Class + number + faster-class are joined from
   * the standings by slot id.
   *
   * Returns `undefined` — omitted, not empty — when the player's telemetry
   * record or orientation is unavailable, matching the motion/chassis contract.
   */
  private buildRadarBlips(
    telem: Buffer,
    telemVehicles: number,
    playerTelemOff: number,
    playerId: number,
    standings: StandingEntry[],
  ): RadarBlip[] | undefined {
    if (playerTelemOff < 0) return undefined;
    const vec = (off: number): Vec3 => ({
      x: telem.readDoubleLE(off),
      y: telem.readDoubleLE(off + 8),
      z: telem.readDoubleLE(off + 16),
    });
    const playerPos = vec(playerTelemOff + VT.mPos);
    const ori: [Vec3, Vec3, Vec3] = [
      vec(playerTelemOff + VT.mOri),
      vec(playerTelemOff + VT.mOri + 24),
      vec(playerTelemOff + VT.mOri + 48),
    ];

    const byId = new Map<number, StandingEntry>();
    for (const s of standings) byId.set(s.slotId, s);
    const playerClass = byId.get(playerId)?.carClass;

    const cars: RadarCar[] = [];
    for (let i = 0; i < telemVehicles; i++) {
      const off = VT.base + i * VT.stride;
      const id = telem.readInt32LE(off + VT.mID);
      if (id === playerId || id < 0) continue;
      const pos = vec(off + VT.mPos);
      // Skip records still at the world origin (uninitialised / not spawned).
      if (pos.x === 0 && pos.y === 0 && pos.z === 0) continue;
      const std = byId.get(id);
      const car: RadarCar = { slotId: id, pos };
      if (std?.carClass) car.carClass = std.carClass;
      if (std?.carNumber) car.carNumber = std.carNumber;
      if (isFasterClass(std?.carClass, playerClass)) car.isFasterClass = true;
      cars.push(car);
    }

    const blips = buildRadar({ playerPos, ori, cars });
    return blips ?? undefined;
  }

  /** Verbose-only diagnostic (per-poll failures would otherwise spam at 30 Hz). */
  private log(msg: string): void {
    if (this.verbose) console.log(`[rf2] ${msg}`);
  }
}

/* --------------------------- session-code maps ---------------------------- */

/**
 * Maps rF2/LMU `rF2ScoringInfo.mSession` to a {@link SessionType}. rF2 groups
 * sessions into bands: `0` test day, `1..4` practice, `5..8` qualifying, `9`
 * warm-up, `10..13` race.
 */
function mapSessionType(code: number): SessionType {
  if (code <= 0) return 'testday';
  if (code <= 4) return 'practice';
  if (code <= 8) return 'qualifying';
  if (code === 9) return 'warmup';
  if (code <= 13) return 'race';
  return 'unknown';
}

/**
 * Maps rF2/LMU `rF2ScoringInfo.mGamePhase` to a {@link SessionPhase}.
 * (0 garage, 1 warm-up, 2 grid walk, 3 formation, 4 countdown, 5 green,
 * 6 full-course yellow, 7 session stopped, 8 session over.)
 */
function mapSessionPhase(phase: number): SessionPhase {
  switch (phase) {
    case 0:
      return 'garage';
    case 1:
      return 'green'; // warm-up — cars are circulating
    case 2:
      return 'gridwalk';
    case 3:
      return 'formation';
    case 4:
      return 'countdown';
    case 5:
      return 'green';
    case 6:
      return 'fullCourseYellow';
    case 7:
      return 'redFlag';
    case 8:
      return 'checkered';
    default:
      return 'unknown';
  }
}

/** Derives the global {@link FlagState} shown to the field from the game phase. */
function mapFlag(phase: number): FlagState {
  switch (phase) {
    case 5:
      return 'green';
    case 6:
      return 'yellow';
    case 7:
      return 'red';
    case 8:
      return 'checkered';
    default:
      return 'none';
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
