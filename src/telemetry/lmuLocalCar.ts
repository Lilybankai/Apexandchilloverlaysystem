/**
 * @file src/telemetry/lmuLocalCar.ts
 * @module telemetry/lmuLocalCar
 *
 * Reads **just the locally-driven car's physics** (pedal inputs, gear, RPM,
 * speed and fuel) from the rF2/LMU shared-memory Telemetry buffer.
 *
 * The {@link LmuRestProvider} gets the whole field (standings, gaps, weather)
 * from Le Mans Ultimate's REST API, but the REST API does not expose driver
 * inputs or fuel *in litres*. Those physics channels ARE published in shared
 * memory — but reliably only for the car being driven on this PC (a spectated
 * remote car's record is not populated). So this reader is the "your own car"
 * half of the hybrid: it finds the driven car and returns its inputs + fuel,
 * which the provider merges into the frame's player + fuel state.
 *
 * ## What it deliberately does NOT read
 * Tyre temperatures. LMU has restructured its per-wheel layout away from the
 * documented rF2 `rF2Wheel` struct (the stock double-precision `mTemperature`
 * offsets read as zero / absolute-zero on current builds), so there is no
 * reliable offset to read them from without LMU's private struct definition.
 * Tyre temps are left to the (unavailable) REST path rather than shown wrong.
 *
 * All offsets below are the rF2 `rF2VehicleTelemetry` offsets that were verified
 * live against Le Mans Ultimate (throttle, brake, gear, RPM, fuel and capacity
 * all read correct values). Everything degrades to `null` when koffi/Win32 is
 * unavailable, the platform is not Windows, or the sim/plugin is not running.
 *
 * ## Tyre temperatures — found after all
 * The earlier "LMU publishes no tyre temps" conclusion was wrong on two counts:
 * the record stride was mis-set (see {@link VT.stride}), and any check made in
 * the garage reads absolute zero because LMU reports 0 K for a car not running
 * on track. With the correct 1888 stride, the per-wheel `mTemperature[3]`
 * (inner/centre/outer, in KELVIN) is right where the rF2 struct says it is. The
 * offset below was pinned live against a SimHub reference: all twelve bands
 * matched to 0.01 °C while driving, and both read 0 K in the pits. SimHub is
 * only the calibration oracle — nothing here depends on it at runtime.
 */

import { UNKNOWN_VALUE } from './types';
import type { MotionState } from './types';
import { decodeMotion } from './motion';
import type { Vec3 } from './motion';

/* Verified rF2VehicleTelemetry field offsets (bytes), x64, #pragma pack(4). */
const VT = {
  base: 16, // records start after header(12) + mNumVehicles(4)
  // Per-vehicle record size. LMU's rF2VehicleTelemetry is 1888 bytes, NOT the
  // 2880 an old rF2 header would suggest. This was the root cause of the
  // "reads another car's inputs" saga: at stride 2880 only record 0 landed on a
  // real record boundary and every other car decoded as garbage, so the mID
  // match below could never find the player unless they happened to sit at
  // index 0. Derived + verified live: vehicle-name strings recur exactly every
  // 1888 bytes across all 30 records, and each record's `mID` then matches its
  // REST `slotID` (e.g. player slot 31 == record mID 31).
  stride: 1888,
  mID: 0,
  // double mElapsedTime — the sim's running clock (seconds). Layout is pinned by
  // the verified neighbours: mID(0..4) + mDeltaTime(4..12) + mElapsedTime(12..20)
  // + mLapNumber(20..24) + mLapStartET(24..32) + mVehicleName(32..96).
  mElapsedTime: 12,
  mLapNumber: 20, // long: mID(0)+mDeltaTime(4..12)+mElapsedTime(12..20)
  // double mLapStartET — mElapsedTime at the moment this lap started. So
  // (mElapsedTime − mLapStartET) is the EXACT time into the current lap, at
  // physics rate, and lapStartET(new) − lapStartET(old) is the exact completed
  // lap time. This is the real lap clock the REST `timeIntoLap` only
  // approximates (that one pauses while the car is stationary).
  mLapStartET: 24,
  // char mVehicleName[64]: livery + racing number, e.g. "Iron Lynx 2026 #79:W"
  // (kept for logging/diagnostics; the player is matched by mID, since car
  // numbers can repeat across classes — e.g. two #21s in one field).
  mVehicleName: 32,
  mLocalVelZ: 200, // rF2Vec3 mLocalVel.z (forward component)
  // The motion block. These are NOT scanned-for offsets — they are bracketed on
  // both sides by offsets already verified live, which is stronger evidence
  // than a scan could give. mLocalVel.z=200 fixes mLocalVel at 184, and the ISI
  // struct order from there is fixed:
  //   mLocalVel(184) mLocalAccel(208) mOri[3](232) mLocalRot(304)
  //   mLocalRotAccel(328) -> mGear(352)
  // and mGear=352 is verified. The block lands exactly in the gap, with no
  // slack: three rF2Vec3 (24 B each) plus the 3x24 B matrix fill 184..352
  // precisely. A wrong offset here would have to be wrong by a whole multiple
  // of 24 AND still leave mGear where it demonstrably is.
  mLocalVel: 184, // rF2Vec3, m/s
  mLocalAccel: 208, // rF2Vec3, m/s^2
  mOri: 232, // rF2Vec3[3] — rows of the local->world matrix
  mLocalRot: 304, // rF2Vec3, rad/s
  mGear: 352,
  mEngineRPM: 356,
  mUnfilteredThrottle: 388,
  mUnfilteredBrake: 396,
  mUnfilteredSteering: 404,
  mUnfilteredClutch: 412,
  // Filtered inputs = what actually reaches the car AFTER driver aids. The
  // gap between unfiltered and filtered is live TC (throttle) / ABS (brake)
  // intervention. They sit directly after the unfiltered block in the struct.
  mFilteredThrottle: 420,
  mFilteredBrake: 428,
  mFuel: 524,
  mEngineMaxRPM: 532,
  mFuelCapacity: 608,
  // mWheels[4] (FL, FR, RL, RR). Each LMU rF2Wheel record is 260 bytes; its
  // mTemperature[3] band array (inner/centre/outer, in KELVIN) sits at the
  // wheel base +0/+8/+16. Verified live vs SimHub — all 12 bands matched to
  // 0.01 °C driving; both read 0 K in the garage (→ reported as unknown).
  mWheelTempBase: 976,
  mWheelStride: 260,
  // mTireInnerLayerTemperature[3] — the tyre *inner-liner* temps, three doubles
  // per wheel at +84/+92/+100 from the surface base (wheel-start +212 in the
  // rF2Wheel struct; the brake-disc temp at wheel-start +24, i.e. −104 here,
  // pins the struct start). Their mean is the channel LMU's in-game tyre HUD
  // shows — verified against the game's own MFD, matching within a few tenths
  // across all four corners (the carcass core at +76 reads ~0.8 °C higher).
  mWheelInnerRel: 84,
} as const;

/** Kelvin → Celsius. LMU stores tyre temps in Kelvin. */
const KELVIN = 273.15;
/**
 * Plausible tyre-surface range in °C. Anything outside is not a tyre reading:
 * ≈ −273 is a car not on track (0 K), and hundreds of °C is a brake disc the
 * read may have slid onto. Bands outside this window are discarded per corner.
 */
const TYRE_MIN_C = -20;
const TYRE_MAX_C = 200;

// NB: the header's mNumVehicles (offset 12) undercounts LMU's telemetry buffer,
// so the record scan is bounded by how many records fit the region, not by it.
const MMF_TELEMETRY = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const TORN_READ_RETRIES = 4;
/** Worst-case bytes we might need (clamped to the real region on open). */
const MAX_BYTES = VT.base + 128 * VT.stride;

/** Physics for the locally-driven car. All values already normalized. */
export interface LocalCarPhysics {
  throttle: number; // 0..1
  brake: number; // 0..1
  clutch: number; // 0..1
  steer: number; // -1..1
  /** Live traction-control intervention (unfiltered − filtered throttle), 0..1. */
  tc: number;
  /** Live ABS intervention (unfiltered − filtered brake), 0..1. */
  abs: number;
  gear: number; // -1 reverse, 0 neutral, 1..n
  rpm: number;
  maxRpm: number;
  speedKph: number;
  fuelLiters: number;
  capacityLiters: number;
  /**
   * Per-corner tyre **surface** temperature in °C `[FL, FR, RL, RR]`, each the
   * mean of the inner/centre/outer bands. `UNKNOWN_VALUE` (-1) when the car
   * isn't running on track (LMU reports 0 K in the garage) or a band reads
   * implausibly.
   */
  tyreTempsC: [number, number, number, number];
  /**
   * Per-corner tyre **inner-liner** temperature in °C `[FL, FR, RL, RR]` — the
   * mean of the three inner-layer bands, which is the channel LMU's in-game HUD
   * shows. `UNKNOWN_VALUE` when unavailable.
   */
  tyreHudTempsC: [number, number, number, number];
  /** Current lap number for this car (for fuel lap-boundary detection). */
  lapNumber: number;
  /**
   * Exact seconds into the current lap (`mElapsedTime − mLapStartET`), at
   * physics rate. `UNKNOWN_VALUE` when the clock reads implausibly (no lap
   * running yet / between sessions).
   */
  lapTimeSec: number;
  /**
   * The sim clock (`mElapsedTime`, seconds) at which the current lap started.
   * Two successive values differ by the exact completed-lap time. May be `0`
   * before the first lap.
   */
  lapStartET: number;
  /**
   * Raw sim session clock `mElapsedTime` (seconds) — a monotonic real-time clock
   * (ticks 1:1 with wall time, pauses when the game pauses). Reliable even though
   * `mLapStartET` is not, so it's used as the delta engine's time axis (REST
   * `timeIntoLap` is a position-derived estimate, useless for a live delta).
   * `UNKNOWN_VALUE` when it reads implausibly.
   */
  elapsedSec: number;
  /** Racing number parsed from the record's vehicle name (e.g. "79"), or "". */
  carNumber: string;
  /**
   * G-force / rotation / attitude, normalised out of ISI's axis convention.
   * `null` when the motion block fails its plausibility guards.
   */
  motion: MotionState | null;
}

/** Minimal koffi-bound Win32 surface (see {@link loadWin32}). */
interface Win32 {
  OpenFileMappingW: (access: number, inherit: boolean, name: string) => unknown;
  MapViewOfFile: (h: unknown, a: number, hi: number, lo: number, bytes: number) => unknown;
  UnmapViewOfFile: (addr: unknown) => boolean;
  CloseHandle: (h: unknown) => boolean;
  /** Decode `len` bytes at `addr + offset` into a Buffer (no full-region copy). */
  readBytes: (addr: unknown, offset: number, len: number) => Buffer;
  /** Decode a single little-endian uint32 at `addr + offset`. */
  readU32: (addr: unknown, offset: number) => number;
  /** Decode a single little-endian int32 at `addr + offset`. */
  readI32: (addr: unknown, offset: number) => number;
  /** Decode a single double at `addr + offset`. */
  readF64: (addr: unknown, offset: number) => number;
  regionSize: (addr: unknown) => number;
}

function loadWin32(): Win32 | null {
  if (process.platform !== 'win32') return null;
  let koffi: any;
  try {
    koffi = require('koffi'); // optional dependency
  } catch {
    return null;
  }
  try {
    const k32 = koffi.load('kernel32.dll');
    const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
    const MapViewOfFile = k32.func(
      'void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)',
    );
    const UnmapViewOfFile = k32.func('bool __stdcall UnmapViewOfFile(void*)');
    const CloseHandle = k32.func('bool __stdcall CloseHandle(void*)');
    const VirtualQuery = k32.func('size_t __stdcall VirtualQuery(void*, void*, size_t)');
    // Offset decodes read just the bytes asked for — the previous whole-region
    // copy (~368 KB through a JS number[] up to 8×/poll at 30 Hz) blocked the
    // event loop long enough to lag the pedal feed by whole seconds.
    const readBytes = (addr: unknown, offset: number, len: number): Buffer =>
      Buffer.from(koffi.decode(addr, offset, koffi.array('uint8', len)) as number[]);
    const readU32 = (addr: unknown, offset: number): number =>
      koffi.decode(addr, offset, 'uint32') as number;
    const readI32 = (addr: unknown, offset: number): number =>
      koffi.decode(addr, offset, 'int32') as number;
    const readF64 = (addr: unknown, offset: number): number =>
      koffi.decode(addr, offset, 'double') as number;
    const regionSize = (addr: unknown): number => {
      try {
        const mbi = Buffer.alloc(48);
        if (VirtualQuery(addr, mbi, 48) === 0) return 0;
        return Number(mbi.readBigUInt64LE(24)); // RegionSize @ offset 24 (x64)
      } catch {
        return 0;
      }
    };
    return {
      OpenFileMappingW,
      MapViewOfFile,
      UnmapViewOfFile,
      CloseHandle,
      readBytes,
      readU32,
      readI32,
      readF64,
      regionSize,
    };
  } catch {
    return null;
  }
}

/**
 * Opens the shared-memory Telemetry buffer and reads the driven car's physics.
 * Safe to construct and use on any platform: when shared memory is unavailable,
 * {@link read} simply returns `null`.
 */
export class LmuLocalCarReader {
  private readonly win32: Win32 | null;
  private handle: unknown = null;
  private view: unknown = null;
  private size = 0;
  /** Record index of the driven car found last poll — probed first next poll. */
  private cachedIdx = -1;

  public constructor() {
    this.win32 = loadWin32();
  }

  /** Whether a shared-memory reader is even possible on this host. */
  public get available(): boolean {
    return this.win32 !== null;
  }

  public start(): void {
    this.open();
  }

  public stop(): void {
    const w = this.win32;
    if (w && this.view) {
      try {
        w.UnmapViewOfFile(this.view);
        if (this.handle) w.CloseHandle(this.handle);
      } catch {
        /* best-effort */
      }
    }
    this.view = null;
    this.handle = null;
    this.size = 0;
    this.cachedIdx = -1;
  }

  private open(): void {
    const w = this.win32;
    if (w === null || this.view) return;
    try {
      const handle = w.OpenFileMappingW(FILE_MAP_READ, false, MMF_TELEMETRY);
      if (!handle) return;
      const view = w.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0); // whole region
      if (!view) {
        w.CloseHandle(handle);
        return;
      }
      const region = w.regionSize(view);
      this.handle = handle;
      this.view = view;
      this.size = region > 0 ? Math.min(region, MAX_BYTES) : MAX_BYTES;
    } catch {
      this.view = null;
      this.handle = null;
    }
  }

  /**
   * Returns the driven car's physics, or `null` when unavailable (no koffi, sim
   * closed, the player's car isn't in the buffer, or a torn read). Never throws.
   *
   * `expectedSlotId` — the player's slot id from the REST standings, which
   * equals the telemetry record's `mID` (verified live: REST slot 31 == record
   * mID 31). LMU publishes a record for EVERY car in the field, so matching the
   * id is the reliable way to pick the driver's own car — and it's necessary,
   * because a car NUMBER can repeat across classes (two #21s in one field). When
   * no id is given (rf2 path / diagnostics) we fall back to the first record
   * with a live, running engine.
   *
   * Cost per call is a handful of scalar decodes plus one record copy — never a
   * copy of the whole region. Consistency comes from checking the writer's
   * version counters before and after the record copy and retrying on mismatch.
   */
  public read(expectedSlotId?: number): LocalCarPhysics | null {
    const w = this.win32;
    if (w === null) return null;
    if (!this.view) {
      this.open();
      if (!this.view) return null;
    }
    try {
      for (let attempt = 0; attempt < TORN_READ_RETRIES; attempt++) {
        const v1 = w.readU32(this.view, 0);
        if (v1 !== w.readU32(this.view, 4)) continue; // writer mid-update

        const idx = this.findDrivenCar(w, expectedSlotId);
        if (idx < 0) return null; // player's car not in the buffer this frame

        const offset = VT.base + idx * VT.stride;
        if (offset + VT.stride > this.size) return null;
        const rec = w.readBytes(this.view, offset, VT.stride);

        // Reject the copy if the writer touched the buffer while we read it.
        if (w.readU32(this.view, 0) !== v1 || w.readU32(this.view, 4) !== v1) continue;

        const car = parseRecord(rec);
        if (car === null) {
          this.cachedIdx = -1; // record went stale (parked / engine off)
          continue;
        }
        // Identity guard on the COPIED bytes: with a slot id known, the record's
        // mID must match it. Guards against a torn read that slid us onto an
        // adjacent car's record between the probe and the copy.
        const wantId = typeof expectedSlotId === 'number' && expectedSlotId >= 0;
        if (wantId && rec.readInt32LE(VT.mID) !== expectedSlotId) {
          this.cachedIdx = -1;
          continue;
        }
        this.cachedIdx = idx;
        return car;
      }
      return null;
    } catch {
      // Mapping may have gone away (sim closed); drop it so we re-open later.
      this.stop();
      return null;
    }
  }

  /**
   * Finds the record index of the player's car by matching its `mID` to the
   * REST slot id. LMU publishes a record for every car in the field (all 30 at
   * once, each with live physics), so an exact id match uniquely picks the
   * driver's own car. Returns `-1` when the id isn't present (player's car not
   * in the buffer → caller shows nothing rather than another car's inputs).
   *
   * With no id (rf2 path / diagnostics) it falls back to the first record with a
   * running engine. The last matched index is checked first so steady-state
   * polls cost a couple of scalar decodes, not a full scan.
   */
  private findDrivenCar(w: Win32, expectedSlotId?: number): number {
    const wantId = typeof expectedSlotId === 'number' && expectedSlotId >= 0;
    // The header's mNumVehicles undercounts LMU's telemetry buffer (it lists ~24
    // while 30 records are populated), so bound the scan by how many records
    // physically fit rather than trusting it.
    const maxFit = Math.floor((this.size - VT.base) / VT.stride);
    const n = clampInt(maxFit, 0, 128);

    // Fast path: re-check the record we used last poll.
    if (this.cachedIdx >= 0 && this.cachedIdx < n) {
      if (
        wantId
          ? this.slotIdAt(w, this.cachedIdx) === expectedSlotId
          : this.probe(w, this.cachedIdx)
      ) {
        return this.cachedIdx;
      }
    }

    let plausible = -1;
    for (let i = 0; i < n; i++) {
      if (wantId) {
        if (this.slotIdAt(w, i) === expectedSlotId) return i;
      } else if (plausible < 0 && this.probe(w, i)) {
        plausible = i;
      }
    }
    return wantId ? -1 : plausible;
  }

  /** The `mID` (slot id) of record `i`. */
  private slotIdAt(w: Win32, i: number): number {
    return w.readI32(this.view, VT.base + i * VT.stride + VT.mID);
  }

  /** Whether record `i` looks like a locally-driven car (live pedal + engine). */
  private probe(w: Win32, i: number): boolean {
    const o = VT.base + i * VT.stride;
    const throttle = w.readF64(this.view, o + VT.mUnfilteredThrottle);
    if (throttle < -0.05 || throttle > 1.05) return false;
    const rpm = w.readF64(this.view, o + VT.mEngineRPM);
    return rpm >= 200 && rpm <= 20000;
  }
}

/** Maps one raw `rF2VehicleTelemetry` record to {@link LocalCarPhysics}. */
function parseRecord(rec: Buffer): LocalCarPhysics | null {
  const throttle = rec.readDoubleLE(VT.mUnfilteredThrottle);
  const rpm = rec.readDoubleLE(VT.mEngineRPM);
  // Re-validate on the copied bytes: the probe read the live buffer, which may
  // have changed between the probe and the copy.
  if (throttle < -0.05 || throttle > 1.05 || rpm < 200 || rpm > 20000) return null;

  const fwdVel = rec.readDoubleLE(VT.mLocalVelZ);
  const brake = clamp01(rec.readDoubleLE(VT.mUnfilteredBrake));

  // TC/ABS intervention = driver input minus what the aids let through. A
  // filtered channel stuck at exactly 0 while the pedal is pressed means the
  // sim isn't populating it — report no intervention rather than a full cut.
  const fltThrottle = rec.readDoubleLE(VT.mFilteredThrottle);
  const fltBrake = rec.readDoubleLE(VT.mFilteredBrake);
  const tc =
    fltThrottle > 0 && fltThrottle <= 1.05 ? clamp01(clamp01(throttle) - fltThrottle) : 0;
  const abs = fltBrake > 0 && fltBrake <= 1.05 ? clamp01(brake - fltBrake) : 0;

  // Per-corner tyre temp = mean of the three (Kelvin) bands, converted to °C —
  // but only over bands that fall in a plausible *tyre* range. This rejects:
  //   • a car not running on track (LMU reports 0 K ≈ −273 °C for every band);
  //   • a torn/misaligned read that slid onto a brake-disc channel (300-800 °C
  //     while driving — the record packs those just 104 bytes before each tyre
  //     block) or other garbage.
  // Averaging only the surviving bands means one bad band can't drag the corner
  // to a wrong number; fewer than two good bands → unknown (widget shows tread).
  // A single Kelvin double → °C, or NaN if outside the plausible tyre range.
  const tyreC = (absOffset: number): number => {
    const c = rec.readDoubleLE(absOffset) - KELVIN;
    return c >= TYRE_MIN_C && c <= TYRE_MAX_C ? c : NaN;
  };
  // Mean of a wheel's three temperature bands at a given relative offset, over
  // only the bands that pass the tyre-range guard. Used for both the surface
  // (rel 0) and inner-liner (rel +84) triplets.
  const bandMeanC = (wheel: number, rel: number): number => {
    const b = VT.mWheelTempBase + wheel * VT.mWheelStride + rel;
    const bands = [tyreC(b), tyreC(b + 8), tyreC(b + 16)].filter((c) => !Number.isNaN(c));
    if (bands.length < 2) return UNKNOWN_VALUE;
    return round1(bands.reduce((s, c) => s + c, 0) / bands.length);
  };
  const tyreTempsC: [number, number, number, number] = [
    bandMeanC(0, 0),
    bandMeanC(1, 0),
    bandMeanC(2, 0),
    bandMeanC(3, 0),
  ];
  const tyreHudTempsC: [number, number, number, number] = [
    bandMeanC(0, VT.mWheelInnerRel),
    bandMeanC(1, VT.mWheelInnerRel),
    bandMeanC(2, VT.mWheelInnerRel),
    bandMeanC(3, VT.mWheelInnerRel),
  ];

  // Exact lap clock: elapsed − lapStart. Guard against pre-session junk (both
  // zero, negative spans, absurd values) — report unknown rather than wrong.
  const elapsed = rec.readDoubleLE(VT.mElapsedTime);
  const lapStart = rec.readDoubleLE(VT.mLapStartET);
  const lapTime = elapsed - lapStart;
  const lapTimeSec =
    Number.isFinite(lapTime) && lapTime >= 0 && lapTime < 7200 && elapsed > 0
      ? lapTime
      : UNKNOWN_VALUE;

  // Motion block. Read as raw vectors and handed to decodeMotion(), which owns
  // every sign decision — nothing here should reason about ISI's axes.
  const vec = (off: number): Vec3 => ({
    x: rec.readDoubleLE(off),
    y: rec.readDoubleLE(off + 8),
    z: rec.readDoubleLE(off + 16),
  });
  const motion = decodeMotion({
    accel: vec(VT.mLocalAccel),
    rot: vec(VT.mLocalRot),
    vel: vec(VT.mLocalVel),
    ori: [vec(VT.mOri), vec(VT.mOri + 24), vec(VT.mOri + 48)],
  });

  return {
    throttle: clamp01(throttle),
    brake,
    clutch: clamp01(rec.readDoubleLE(VT.mUnfilteredClutch)),
    steer: clamp(rec.readDoubleLE(VT.mUnfilteredSteering), -1, 1),
    tc,
    abs,
    gear: rec.readInt32LE(VT.mGear),
    rpm: Math.round(rpm),
    maxRpm: Math.round(rec.readDoubleLE(VT.mEngineMaxRPM)) || 8000,
    speedKph: Math.round(Math.abs(fwdVel) * 3.6),
    fuelLiters: round1(rec.readDoubleLE(VT.mFuel)),
    capacityLiters: round1(rec.readDoubleLE(VT.mFuelCapacity)),
    tyreTempsC,
    tyreHudTempsC,
    lapNumber: Math.max(0, rec.readInt32LE(VT.mLapNumber)),
    lapTimeSec,
    lapStartET: Number.isFinite(lapStart) && lapStart >= 0 ? lapStart : 0,
    elapsedSec: Number.isFinite(elapsed) && elapsed > 0 ? elapsed : UNKNOWN_VALUE,
    carNumber: carNumberFromName(bufToAscii(rec.subarray(VT.mVehicleName, VT.mVehicleName + 48))),
    motion,
  };
}

/** Decodes a NUL-terminated ASCII run from a byte buffer. */
function bufToAscii(buf: Buffer): string {
  let s = '';
  for (const c of buf) {
    if (c === 0) break;
    if (c >= 32 && c < 127) s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Extracts the racing number from a vehicle name like `"Iron Lynx 2026 #79:W"`
 * → `"79"`. Returns "" when there's no `#NN` token. Uses the last `#` so team
 * names containing a `#` don't confuse it.
 */
function carNumberFromName(name: string): string {
  const hash = name.lastIndexOf('#');
  if (hash < 0) return '';
  let s = '';
  for (let i = hash + 1; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    if (ch >= 48 && ch <= 57) s += name[i];
    else break;
  }
  return stripLeadingZeros(s);
}

/** "091" → "91"; keeps a lone "0"; "" → "". */
function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '');
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
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
