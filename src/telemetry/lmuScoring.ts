/**
 * @file src/telemetry/lmuScoring.ts
 * @module telemetry/lmuScoring
 *
 * Reads the **four scoring channels the REST API does not publish** for the
 * locally-driven car, straight from the rF2/LMU shared-memory Scoring buffer:
 *
 *   `mPathLateral`   the car's lateral offset from the track's centre path, m
 *   `mTrackEdge`     how far the track surface extends in that direction, m
 *   `mNumPenalties`  the sim's own outstanding-penalty count
 *   `mVehicleName`   the car MODEL, e.g. "Ferrari 296 GT3"
 *
 * The first two are the only spatial statement anywhere in the feed about
 * *where the road ends*, which is what a track-limits readout needs (see
 * `telemetry/trackLimits.ts`); the third is the sim's own verdict when it has
 * one. The fourth is the only place the driven car's model is named at all:
 * `/rest/watch/standings` publishes the class, the number and the team, but
 * never which car it is — so a per-car lap database has nowhere else to look.
 * LMU's REST API carries none of them, and there is no endpoint that does —
 * hence a second small shared-memory reader beside
 * {@link module:telemetry/lmuLocalCar}, which owns the *Telemetry* buffer.
 *
 * ## The layout was verified live, not assumed
 * LMU's telemetry records are a different size from stock rF2's (1888 vs 2880 —
 * see `lmuLocalCar.ts` for the saga that caused), so nothing here is taken on
 * faith from an rF2 header. Probed against a running 37-car Fuji session
 * (`scripts/probe-lmu-scoring.js` reproduces it):
 *
 *   - Driver-name strings recur every **584 bytes**, which fixes the vehicle
 *     record stride. That is exactly `sizeof(rF2VehicleScoring)` with ISI's
 *     `#pragma pack(4)` and the standard 48-byte `mExpansion`, so LMU keeps the
 *     stock scoring record even though it shortened the telemetry one.
 *   - The first record therefore starts at `12 + 548` = **560**: the plugin's
 *     8-byte version pair plus a 4-byte update hint, then a 548-byte
 *     `rF2ScoringInfo`.
 *   - Every field below then decoded correctly on all 37 cars at once — names,
 *     classes, lap counts, places and pit states all matched the REST standings
 *     for the same session, which is a far stronger check than any single field
 *     reading plausibly.
 *
 * Like every offset in this codebase these are version-sensitive and may shift
 * on an LMU update; everything degrades to `null` rather than to a wrong number.
 */

import { UNKNOWN_VALUE } from './types';

/* Verified rF2ScoringInfo offsets (bytes from the start of the scoring body). */
const SI = {
  /** `rF2Scoring.mScoringInfo` starts after version(8) + bytesUpdatedHint(4). */
  base: 12,
  mTrackName: 0, // char[64]
  mSession: 64, // long
  mLapDist: 88, // double — lap length, metres
  mNumVehicles: 104, // long
  /**
   * The name of the driver sitting at THIS PC — `char[32]`, verified live.
   *
   * The one identity in the whole feed that does not depend on anybody being in
   * a car. In a team event during a teammate's stint no standings row carries
   * `player: true` at all (probed live, 2026-08-22, mid-race), so every "which
   * car is ours" answer built on the driven car evaporates exactly when a
   * driver-swap entry needs one. This does not: the sim knows who is logged in
   * whether they are driving, spectating or sat in the monitor.
   *
   * Found by dumping the printable strings in the header rather than trusted
   * from a struct definition, and it is corroborated by its NEIGHBOUR: the
   * track name decodes at +0, this at +116, and a second string at +148 —
   * exactly rF2's `mPlayerName[32]` followed by `mPlrFileName[64]`. A lone
   * plausible string proves nothing; a pair in the right places is the layout.
   */
  mPlayerName: 116, // char[32]
  /** `sizeof(rF2ScoringInfo)` — the vehicles array follows it. */
  sizeof: 548,
} as const;

/** Verified `rF2VehicleScoring` offsets, relative to each record's start. */
const VS = {
  /**
   * LMU's record size — see the module note. NOT rF2's 616: at 616 the buffer's
   * own region size (77 824 B) could not hold the plugin's 128 slots, and the
   * driver-name strings demonstrably recur every 584.
   */
  stride: 584,
  mID: 0, // long — equals the REST `slotID`
  mDriverName: 4, // char[32]
  /**
   * The car model as the sim names it, e.g. `"Ferrari 296 GT3"`.
   *
   * Not probed separately, and not taken on faith from an rF2 header either:
   * it is *bracketed* by two offsets this module already verified live. The
   * driver name occupies 4..35 (char[32]), so the next field starts at 36, and
   * `mTotalLaps` was confirmed at 100 — exactly 36 + 64. A char[64] is the only
   * thing that fits the hole, and it is what the stock record puts there.
   */
  mVehicleName: 36, // char[64]
  mTotalLaps: 100, // short
  mLapDist: 104, // double
  /**
   * Lateral offset of the car's centre from the track path, metres, signed.
   * Paired with {@link mTrackEdge}, which carries the SAME sign — verified on a
   * full field: every one of 37 cars had matching signs on the two channels.
   */
  mPathLateral: 112, // double
  /** How far the track extends in the car's own lateral direction, metres. */
  mTrackEdge: 120, // double
  mNumPitstops: 192, // short
  /** Outstanding penalties the sim has issued this car. */
  mNumPenalties: 194, // short
  mIsPlayer: 196, // bool
  mInPits: 198, // bool
  mPlace: 199, // unsigned char
  mVehicleClass: 200, // char[32]
  mPitState: 457, // unsigned char
  mFlag: 504, // unsigned char
  mUnderYellow: 505, // bool
  mInGarageStall: 507, // bool
} as const;

const MMF_SCORING = '$rFactor2SMMP_Scoring$';
const FILE_MAP_READ = 0x0004;
const TORN_READ_RETRIES = 4;
/** The plugin maps 128 vehicle slots; bound every scan by this, not by trust. */
const MAX_VEHICLES = 128;
/** Worst-case bytes we might need (clamped to the real region on open). */
const MAX_BYTES = SI.base + SI.sizeof + MAX_VEHICLES * VS.stride;

/** The scoring channels for one car that nothing else in the feed carries. */
export interface ScoringCar {
  /** Slot id (`mID`) — equals the REST `slotID`. */
  slotId: number;
  /**
   * Lateral offset of the car's centre from the track path, metres, signed.
   * `null` when it reads implausibly — not the frame's usual
   * {@link UNKNOWN_VALUE}, because this value is legitimately negative and a
   * car one metre left of the path would otherwise read as missing data.
   */
  pathLateralM: number | null;
  /**
   * How far the track surface extends in the same direction, metres, same sign
   * as {@link pathLateralM}. `null` when implausible.
   */
  trackEdgeM: number | null;
  /** The sim's outstanding-penalty count, or {@link UNKNOWN_VALUE}. */
  penalties: number;
  /** `true` when the sim has this car in the pit lane or its garage stall. */
  inPit: boolean;
  /**
   * The car model, e.g. `"Ferrari 296 GT3"`. Empty string when the field is
   * blank or unreadable — an empty name is a *missing* name, and callers key
   * lap records off it, so it must never be confused with a real car called
   * something odd.
   */
  vehicleName: string;
}

/**
 * The widest lateral offset (metres) treated as a real reading. A car genuinely
 * off in the scenery reads tens of metres; hundreds means the record is
 * uninitialised or the read slid off a boundary, and the channel is dropped
 * rather than turned into an excursion that never happened.
 */
const MAX_PLAUSIBLE_LATERAL_M = 200;

/** Minimal koffi-bound Win32 surface — mirrors `lmuLocalCar.ts`. */
interface Win32 {
  OpenFileMappingW: (access: number, inherit: boolean, name: string) => unknown;
  MapViewOfFile: (h: unknown, a: number, hi: number, lo: number, bytes: number) => unknown;
  UnmapViewOfFile: (addr: unknown) => boolean;
  CloseHandle: (h: unknown) => boolean;
  readBytes: (addr: unknown, offset: number, len: number) => Buffer;
  readU32: (addr: unknown, offset: number) => number;
  readI32: (addr: unknown, offset: number) => number;
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
    const readBytes = (addr: unknown, offset: number, len: number): Buffer =>
      Buffer.from(koffi.decode(addr, offset, koffi.array('uint8', len)) as number[]);
    const readU32 = (addr: unknown, offset: number): number =>
      koffi.decode(addr, offset, 'uint32') as number;
    const readI32 = (addr: unknown, offset: number): number =>
      koffi.decode(addr, offset, 'int32') as number;
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
      regionSize,
    };
  } catch {
    return null;
  }
}

/**
 * Opens the shared-memory Scoring buffer and reads one car's lateral-position
 * and penalty channels. Safe to construct and use on any platform: with shared
 * memory unavailable, {@link read} simply returns `null`.
 */
export class LmuScoringReader {
  private readonly win32: Win32 | null;
  private handle: unknown = null;
  private view: unknown = null;
  private size = 0;
  /** Record index of the wanted car last poll — probed first next poll. */
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
      const handle = w.OpenFileMappingW(FILE_MAP_READ, false, MMF_SCORING);
      if (!handle) return;
      const view = w.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0); // whole region
      if (!view) {
        w.CloseHandle(handle);
        return;
      }
      const region = w.regionSize(view);
      this.handle = handle;
      this.view = view;
      // `regionSize` is a best-effort VirtualQuery: it returns 0 when the call
      // fails, which is NOT the same as the mapping being empty. Treating that
      // as fatal used to tear the reader down on machines where the query
      // misreports, and since every later read re-opens and re-fails, the
      // scoring buffer stayed dark for the whole session — no car name on a
      // driver's uploaded laps, no track limits, no penalty count — while the
      // telemetry buffer (a separate mapping, and the one that feeds pedals)
      // carried on working and made the app look healthy. Fall back to the
      // worst case we could need instead, exactly as lmuLocalCar does; every
      // scan is bounded by MAX_VEHICLES either way, so nothing reads further
      // than it did before.
      this.size = region > 0 ? Math.min(region, MAX_BYTES) : MAX_BYTES;
    } catch {
      this.view = null;
      this.handle = null;
    }
  }

  /**
   * Returns the scoring channels for the car with slot id `slotId`, or `null`
   * when unavailable (no koffi, sim closed, that car not in the buffer, or a
   * torn read). Never throws.
   *
   * Consistency uses the same version-pair gate as the telemetry reader: the
   * writer's counters are checked either side of the record copy, and a mismatch
   * retries rather than publishing half of one car and half of the next. That
   * gate is affordable here — unlike the radar's whole-field sweep — because
   * this reads ONE record, and the scoring buffer is written at scoring rate
   * (a few Hz), not at physics rate.
   */
  public read(slotId: number): ScoringCar | null {
    const w = this.win32;
    if (w === null || slotId < 0) return null;
    if (!this.view) {
      this.open();
      if (!this.view) return null;
    }
    try {
      for (let attempt = 0; attempt < TORN_READ_RETRIES; attempt++) {
        const v1 = w.readU32(this.view, 0);
        if (v1 !== w.readU32(this.view, 4)) continue; // writer mid-update

        const idx = this.findCar(w, slotId);
        if (idx < 0) return null; // that car is not in the buffer this frame

        const offset = SI.base + SI.sizeof + idx * VS.stride;
        if (offset + VS.stride > this.size) return null;
        const rec = w.readBytes(this.view, offset, VS.stride);

        // Reject the copy if the writer touched the buffer while we read it.
        if (w.readU32(this.view, 0) !== v1 || w.readU32(this.view, 4) !== v1) continue;

        // Identity guard on the COPIED bytes — a torn read could have slid the
        // probe onto a neighbouring car between finding it and copying it.
        if (rec.readInt32LE(VS.mID) !== slotId) {
          this.cachedIdx = -1;
          continue;
        }

        this.cachedIdx = idx;
        return parseRecord(rec, slotId);
      }
      return null;
    } catch {
      // Mapping may have gone away (sim closed); drop it so we re-open later.
      this.stop();
      return null;
    }
  }

  /**
   * The sim's own name for the loaded track — `rF2ScoringInfo.mTrackName`.
   *
   * ## Why this is worth a shared-memory read of its own
   * LMU's REST `sessionInfo.trackName` is the VENUE ("Autodromo Nazionale
   * Monza") and never says which layout is loaded. Monza's two layouts share a
   * centreline and are ~10 s apart in GT3; Le Mans's are ~16 s apart. This
   * string names the scene, so it is the only channel in the whole feed that can
   * tell them apart — which `referencePace` needs before it will score a lap at
   * either of them.
   *
   * The offset is not a new guess: `mTrackName` is a `char[64]` at 0 and the
   * neighbouring `mSession` at 64 was verified live, which brackets it exactly
   * the way `mVehicleName` is bracketed in the vehicle record.
   *
   * Returns `""` — never a partial or mangled name — when shared memory is
   * unavailable, the mapping has gone, or the read tore. Callers treat an empty
   * name as "the sim did not say", which is a state they already handle.
   */
  public readTrackName(): string {
    const w = this.win32;
    if (w === null) return '';
    if (!this.view) {
      this.open();
      if (!this.view) return '';
    }
    try {
      for (let attempt = 0; attempt < TORN_READ_RETRIES; attempt++) {
        const v1 = w.readU32(this.view, 0);
        if (v1 !== w.readU32(this.view, 4)) continue; // writer mid-update
        if (SI.base + 64 > this.size) return '';
        const buf = w.readBytes(this.view, SI.base + SI.mTrackName, 64);
        if (w.readU32(this.view, 0) !== v1 || w.readU32(this.view, 4) !== v1) continue;
        return readCString(buf, 0, 64);
      }
      return '';
    } catch {
      this.stop();
      return '';
    }
  }

  /**
   * The name of the driver logged in at this PC, or `""` when it cannot be read.
   *
   * Exists to answer one question the rest of the feed cannot: **which car is
   * ours while somebody else is driving it.** In a team event a teammate's stint
   * leaves no standings row flagged `player`, so the car has to be identified by
   * something other than who is at the wheel — this name, joined against the
   * team rosters `/rest/multiplayer/teams` publishes, does it without needing us
   * to have driven first. That last part is the whole point: a latch taken while
   * driving cannot help an app STARTED mid-stint, which is the case a driver
   * doing the second stint of an endurance race is actually in.
   *
   * Read through the same torn-read guard as everything else here, and an empty
   * string on any doubt — callers treat that as "the sim did not say" and fall
   * back to the driven car.
   */
  public readPlayerName(): string {
    const w = this.win32;
    if (w === null) return '';
    if (!this.view) {
      this.open();
      if (!this.view) return '';
    }
    try {
      for (let attempt = 0; attempt < TORN_READ_RETRIES; attempt++) {
        const v1 = w.readU32(this.view, 0);
        if (v1 !== w.readU32(this.view, 4)) continue; // writer mid-update
        if (SI.base + SI.mPlayerName + 32 > this.size) return '';
        const buf = w.readBytes(this.view, SI.base + SI.mPlayerName, 32);
        if (w.readU32(this.view, 0) !== v1 || w.readU32(this.view, 4) !== v1) continue;
        return readCString(buf, 0, 32);
      }
      return '';
    } catch {
      this.stop();
      return '';
    }
  }

  /**
   * Record index of the car with this slot id, or -1.
   *
   * A car's record INDEX is not its slot id (the player sat at index 36 with
   * `mID` 0 in the probe session), so the id has to be matched rather than used
   * as a subscript. Last frame's index is tried first — it is almost always
   * still right — before falling back to a scan bounded by what actually fits
   * the mapped region, never by `mNumVehicles`, which describes the field, not
   * the array's occupancy.
   */
  private findCar(w: Win32, slotId: number): number {
    const base = SI.base + SI.sizeof;
    const idAt = (i: number): number => w.readI32(this.view, base + i * VS.stride + VS.mID);
    if (this.cachedIdx >= 0) {
      const off = base + this.cachedIdx * VS.stride;
      if (off + VS.stride <= this.size && idAt(this.cachedIdx) === slotId) return this.cachedIdx;
    }
    const maxFit = Math.floor((this.size - base) / VS.stride);
    const n = Math.max(0, Math.min(MAX_VEHICLES, maxFit));
    for (let i = 0; i < n; i++) {
      if (idAt(i) === slotId) return i;
    }
    return -1;
  }
}

/**
 * Read a fixed-width NUL-terminated field as a string.
 *
 * The sim pads these with NULs, but a torn or uninitialised record can leave
 * arbitrary bytes there, so anything non-printable ends the string too rather
 * than becoming mojibake in a lap record that outlives the session.
 */
function readCString(rec: Buffer, offset: number, maxLen: number): string {
  let end = offset;
  const limit = Math.min(offset + maxLen, rec.length);
  while (end < limit) {
    const b = rec[end]!;
    if (b < 0x20 || b > 0x7e) break;
    end++;
  }
  return rec.toString('latin1', offset, end).trim();
}

/** Decode one copied `rF2VehicleScoring` record. */
function parseRecord(rec: Buffer, slotId: number): ScoringCar {
  const lateral = rec.readDoubleLE(VS.mPathLateral);
  const edge = rec.readDoubleLE(VS.mTrackEdge);
  const plausible = (v: number): boolean =>
    Number.isFinite(v) && Math.abs(v) <= MAX_PLAUSIBLE_LATERAL_M;
  const penalties = rec.readInt16LE(VS.mNumPenalties);
  return {
    slotId,
    pathLateralM: plausible(lateral) ? lateral : null,
    trackEdgeM: plausible(edge) ? edge : null,
    // A negative count is a record that isn't populated, not a credit.
    penalties: penalties >= 0 ? penalties : UNKNOWN_VALUE,
    inPit: rec.readUInt8(VS.mInPits) !== 0 || rec.readUInt8(VS.mInGarageStall) !== 0,
    vehicleName: readCString(rec, VS.mVehicleName, 64),
  };
}
