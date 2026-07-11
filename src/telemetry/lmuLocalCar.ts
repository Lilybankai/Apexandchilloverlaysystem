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
  mFuel: 524,
  mEngineMaxRPM: 532,
  mFuelCapacity: 608,
} as const;

const HDR_BODY = 12; // mNumVehicles lives here; records start at VT.base
const MMF_TELEMETRY = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const TORN_READ_RETRIES = 8;
/** Worst-case bytes we might need (clamped to the real region on open). */
const MAX_BYTES = VT.base + 128 * VT.stride;

/** Physics for the locally-driven car. All values already normalized. */
export interface LocalCarPhysics {
  throttle: number; // 0..1
  brake: number; // 0..1
  clutch: number; // 0..1
  steer: number; // -1..1
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
  read: (addr: unknown, len: number) => Buffer;
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
    const read = (addr: unknown, len: number): Buffer =>
      Buffer.from(koffi.decode(addr, koffi.array('uint8', len)) as number[]);
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
      read,
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
   */
  public read(): LocalCarPhysics | null {
    const w = this.win32;
    if (w === null) return null;
    if (!this.view) {
      this.open();
      if (!this.view) return null;
    }
    const buf = this.readConsistent();
    if (buf === null) {
      // Mapping may have gone away (sim closed); drop it so we re-open later.
      this.stop();
      return null;
    }
    try {
      return this.parseDrivenCar(buf);
    } catch {
      return null;
    }
  }

  /** Re-copies the buffer until the version counters agree (writer idle). */
  private readConsistent(): Buffer | null {
    const w = this.win32;
    if (w === null || !this.view) return null;
    try {
      for (let attempt = 0; attempt < TORN_READ_RETRIES; attempt++) {
        const snapshot = w.read(this.view, this.size);
        if (snapshot.readUInt32LE(0) === snapshot.readUInt32LE(4)) return snapshot;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Finds the locally-driven car — the only telemetry record populated with
   * plausible physics (valid throttle 0..1 and a running engine); remote cars'
   * records are zeroed/garbage — and maps its fields.
   */
  private parseDrivenCar(buf: Buffer): LocalCarPhysics | null {
    const n = clampInt(buf.readInt32LE(HDR_BODY), 0, 128);
    for (let i = 0; i < n; i++) {
      const o = VT.base + i * VT.stride;
      if (o + VT.stride > buf.length) break;
      const throttle = buf.readDoubleLE(o + VT.mUnfilteredThrottle);
      const rpm = buf.readDoubleLE(o + VT.mEngineRPM);
      // The driven car is the one actually running: valid pedal + live engine.
      if (throttle < -0.05 || throttle > 1.05 || rpm < 200 || rpm > 20000) continue;

      const fwdVel = buf.readDoubleLE(o + VT.mLocalVelZ);
      return {
        throttle: clamp01(throttle),
        brake: clamp01(buf.readDoubleLE(o + VT.mUnfilteredBrake)),
        clutch: clamp01(buf.readDoubleLE(o + VT.mUnfilteredClutch)),
        steer: clamp(buf.readDoubleLE(o + VT.mUnfilteredSteering), -1, 1),
        gear: buf.readInt32LE(o + VT.mGear),
        rpm: Math.round(rpm),
        maxRpm: Math.round(buf.readDoubleLE(o + VT.mEngineMaxRPM)) || 8000,
        speedKph: Math.round(Math.abs(fwdVel) * 3.6),
        fuelLiters: round1(buf.readDoubleLE(o + VT.mFuel)),
        capacityLiters: round1(buf.readDoubleLE(o + VT.mFuelCapacity)),
        lapNumber: Math.max(0, buf.readInt32LE(o + VT.mLapNumber)),
      };
    }
    return null; // nobody driving locally
  }
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
