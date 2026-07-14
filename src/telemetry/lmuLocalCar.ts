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
 */

/* Verified rF2VehicleTelemetry field offsets (bytes), x64, #pragma pack(4). */
const VT = {
  base: 16, // records start after header(12) + mNumVehicles(4)
  stride: 2880,
  mID: 0,
  mLapNumber: 20, // long: mID(0)+mDeltaTime(4..12)+mElapsedTime(12..20)
  mLocalVelZ: 200, // rF2Vec3 mLocalVel.z (forward component)
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
} as const;

const HDR_NUM_VEHICLES = 12; // mNumVehicles lives here; records start at VT.base
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
  /** Current lap number for this car (for fuel lap-boundary detection). */
  lapNumber: number;
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
   * closed, nobody driving locally, or a torn read). Never throws.
   *
   * `expectedSlotId` — the player's slot id from the REST standings (`mID` in
   * the telemetry record). Records exist for EVERY locally-simulated car (all
   * AI in single player), so matching the id is the only reliable way to pick
   * the driver's own car rather than whoever happens to occupy record 0 (which
   * used to show P1's inputs instead of the player's). The plausibility scan
   * remains as a fallback when no slot id is known.
   *
   * Cost per call is a handful of scalar decodes plus one 2 880-byte record
   * copy — never a copy of the whole (~368 KB) region. Consistency comes from
   * checking the writer's version counters before and after the record copy and
   * retrying on mismatch instead of snapshotting everything.
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
        if (idx < 0) return null; // nobody driving locally

        const offset = VT.base + idx * VT.stride;
        if (offset + VT.stride > this.size) return null;
        const rec = w.readBytes(this.view, offset, VT.stride);

        // Reject the copy if the writer touched the buffer while we read it.
        if (w.readU32(this.view, 0) !== v1 || w.readU32(this.view, 4) !== v1) continue;

        const car = parseRecord(rec);
        if (car === null) {
          this.cachedIdx = -1; // slot went stale (driver left the car)
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
   * Finds the record index of the player's car.
   *
   * LMU publishes telemetry for exactly ONE car — whichever car the game
   * camera is following (verified live at Interlagos: record 0 carries that
   * car's name/track/physics, every other record is uninitialised noise).
   *
   * Crucially, LMU's telemetry `mID` is a DIFFERENT id namespace from the REST
   * `slotID` (verified live: the driven car's record reads `mID=4` while its
   * REST slot id is `54`). So a strict `mID === slotID` match can never succeed
   * and returning `-1` on a miss kills the pedal trace and litre-fuel entirely
   * (the v0.5.2 regression). We therefore prefer an exact id match when the
   * namespaces happen to line up (a future LMU build / the rf2 path) but ALWAYS
   * fall back to the first record that looks like a live, running car.
   *
   * The "am I driving or spectating?" decision is made by the caller from the
   * REST focus/player flags (see LmuRestProvider) — the reader is only asked to
   * read when the player IS the camera focus, so the plausible record is the
   * player's own car.
   */
  private findDrivenCar(w: Win32, expectedSlotId?: number): number {
    const n = clampInt(w.readI32(this.view, HDR_NUM_VEHICLES), 0, 128);
    const wantId = typeof expectedSlotId === 'number' && expectedSlotId >= 0;

    // Fast path: re-check the record we used last poll (two scalar decodes).
    if (
      this.cachedIdx >= 0 &&
      this.cachedIdx < n &&
      VT.base + (this.cachedIdx + 1) * VT.stride <= this.size
    ) {
      if (
        (wantId && this.slotIdAt(w, this.cachedIdx) === expectedSlotId) ||
        this.probe(w, this.cachedIdx)
      ) {
        return this.cachedIdx;
      }
    }

    let plausible = -1;
    for (let i = 0; i < n; i++) {
      if (VT.base + (i + 1) * VT.stride > this.size) break;
      if (wantId && this.slotIdAt(w, i) === expectedSlotId) return i;
      if (plausible < 0 && this.probe(w, i)) plausible = i;
    }
    // No id match (LMU's namespaces differ): the first live-looking record is
    // the driven/focus car. `-1` only when nothing is running (parked, engine
    // off, in menus) → caller falls back to REST speed.
    return plausible;
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
    lapNumber: Math.max(0, rec.readInt32LE(VT.mLapNumber)),
  };
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
