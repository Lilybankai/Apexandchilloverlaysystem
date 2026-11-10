/**
 * @file src/telemetry/iracing/irsdk.ts
 * @module telemetry/iracing/irsdk
 *
 * Reader for iRacing's SDK shared memory (`Local\IRSDKMemMapFileName`).
 *
 * ## Layout (verified against a live capture, 2026-11-10)
 * - `irsdk_header` — 112 bytes of int32 at offset 0: `ver`, `status` (bit 1 =
 *   connected), `tickRate`, `sessionInfoUpdate`, `sessionInfoLen`,
 *   `sessionInfoOffset`, `numVars`, `varHeaderOffset`, `numBuf`, `bufLen`, two
 *   pad ints, then `varBuf[4]` of `{tickCount, bufOffset, pad[2]}` at 48 + 16·i.
 * - `irsdk_varHeader` × numVars at `varHeaderOffset`, 144 bytes each: type,
 *   offset, count, countAsTime (1 byte + pad), name[32], desc[64], unit[32].
 * - Up to four telemetry rows (`numBuf`, 3 in practice) of `bufLen` bytes,
 *   written round-robin at 60 Hz. The row with the highest `tickCount` is the
 *   newest complete one.
 * - The session-info YAML at `sessionInfoOffset`, `sessionInfoLen` being the
 *   size of the AREA (trim at the first NUL). It is rewritten whenever
 *   `sessionInfoUpdate` increments.
 *
 * ## Reading without stalling the main process
 * The server runs inside Electron's main process, which has a history of
 * main-thread stalls. So this reader never blocks: there is no wait on the
 * data-valid event, just a poll that compares tick counts. The whole mapping is
 * copied with `RtlMoveMemory` straight into a Node Buffer, so a poll costs one
 * ~8.6 KB `memcpy` plus a handful of int reads — not a `koffi.decode` into a JS
 * number array, which is what once lagged the LMU pedal feed by seconds (see
 * `lmuLocalCar.ts`).
 *
 * **Never `koffi.view` here.** It wraps foreign memory in an external
 * ArrayBuffer, which plain Node allows but Electron's V8 memory cage does not:
 * in the app's main process it is a FATAL napi error that no try/catch can
 * stop, and the whole app exits silently the moment iRacing is chosen
 * (1.3.16-beta.3, 2026-11-10). Every test passed under plain Node, so
 * `scripts/test-irsdk-electron.js` runs this reader inside Electron itself.
 *
 * ## Torn reads
 * The sim may be overwriting the oldest buffer while we copy. The C++ SDK's
 * pattern is used: pick the newest buffer, copy it, then re-read its tick
 * count; if it moved, the copy is torn and is retried once, else the poll
 * returns the previous good row.
 *
 * ## Unaligned offsets
 * Var offsets are packed (a float at offset 61 was observed), so every read
 * goes through `Buffer.readXxxLE`, never a typed-array view.
 *
 * Everything sits behind {@link IrsdkSource} so `captureSource.ts` can replay a
 * recorded session through the exact same provider code.
 */

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

/** `irsdk_VarType`. */
export const enum IrVarType {
  Char = 0,
  Bool = 1,
  Int = 2,
  BitField = 3,
  Float = 4,
  Double = 5,
}

/** Byte size per element of each {@link IrVarType}. */
const VAR_SIZE = [1, 1, 4, 4, 4, 8] as const;

/** One parsed `irsdk_varHeader`. */
export interface IrVarHeader {
  name: string;
  type: IrVarType;
  /** Byte offset inside a telemetry row. */
  offset: number;
  /** Array length; `1` for a scalar, `64` for the CarIdx arrays. */
  count: number;
  unit: string;
}

/**
 * One telemetry row, read through named variables.
 *
 * Every getter is total: a variable the current car does not publish (they
 * vary by car — `dcABS`, the hybrid channels…) or an index past its count reads
 * as `NaN` / `false` rather than throwing, so the provider treats every var as
 * optional.
 */
export interface IrsdkFrame {
  /** The row's tick count (60 Hz). */
  readonly tick: number;
  /** Whether the sim publishes this variable at all. */
  has(name: string): boolean;
  /** Element count of a variable, `0` when absent. */
  count(name: string): number;
  /** Numeric value (bool → 0/1, bitfield → uint32); `NaN` when absent. */
  num(name: string, index?: number): number;
  /** Boolean value; `false` when absent. */
  bool(name: string, index?: number): boolean;
}

/**
 * A source of iRacing SDK data: the live shared memory, or a recorded capture.
 *
 * Contract: every method is synchronous, cheap, and never throws.
 */
export interface IrsdkSource {
  /** Try to (re)open the source. Returns whether it is open now. */
  open(): boolean;
  /** Release the source. Safe to call when not open. */
  close(): void;
  /** Whether the source is open (the mapping exists / the file is loaded). */
  isOpen(): boolean;
  /** `status & irsdk_stConnected` — the sim is running a session. */
  connected(): boolean;
  /**
   * The newest telemetry row, or `null` when not connected or no consistent
   * row could be read. Returns the same (still valid) row when the sim has not
   * ticked since the last call. The returned object may be reused by the next
   * call: read what you need before calling again.
   */
  read(): IrsdkFrame | null;
  /** The session-info revision counter; `-1` when unavailable. */
  sessionInfoUpdate(): number;
  /** The raw session-info YAML bytes (trimmed at the first NUL), or `null`. */
  readSessionInfo(): Buffer | null;
}

/** `irsdk_stConnected`. */
export const IRSDK_ST_CONNECTED = 1;
/** Name of the memory-mapped file. */
export const IRSDK_MEMMAP_NAME = 'Local\\IRSDKMemMapFileName';

/* -------------------------------------------------------------------------- */
/*  Row decoding (shared by every Buffer-backed source)                       */
/* -------------------------------------------------------------------------- */

/** Parse `numVars` var headers out of a buffer that starts at the first one. */
export function parseVarHeaders(buf: Buffer, numVars: number): Map<string, IrVarHeader> {
  const out = new Map<string, IrVarHeader>();
  for (let i = 0; i < numVars; i++) {
    const o = i * 144;
    if (o + 144 > buf.length) break;
    const type = buf.readInt32LE(o) as IrVarType;
    const name = cstr(buf, o + 16, 32);
    if (!name || type < 0 || type > 5) continue;
    out.set(name, {
      name,
      type,
      offset: buf.readInt32LE(o + 4),
      count: Math.max(1, buf.readInt32LE(o + 8)),
      unit: cstr(buf, o + 112, 32),
    });
  }
  return out;
}

/** An {@link IrsdkFrame} over a copied row Buffer and the var table. */
export class BufferFrame implements IrsdkFrame {
  public tick = -1;
  public row: Buffer = Buffer.alloc(0);
  public vars: Map<string, IrVarHeader> = new Map();

  public has(name: string): boolean {
    return this.vars.has(name);
  }

  public count(name: string): number {
    return this.vars.get(name)?.count ?? 0;
  }

  public num(name: string, index = 0): number {
    const v = this.vars.get(name);
    if (!v || index < 0 || index >= v.count) return NaN;
    const o = v.offset + index * VAR_SIZE[v.type];
    const row = this.row;
    if (o < 0 || o + VAR_SIZE[v.type] > row.length) return NaN;
    switch (v.type) {
      case IrVarType.Char:
        return row[o] as number;
      case IrVarType.Bool:
        return row[o] !== 0 ? 1 : 0;
      case IrVarType.Int:
        return row.readInt32LE(o);
      case IrVarType.BitField:
        return row.readUInt32LE(o);
      case IrVarType.Float:
        return row.readFloatLE(o);
      case IrVarType.Double:
        return row.readDoubleLE(o);
      default:
        return NaN;
    }
  }

  public bool(name: string, index = 0): boolean {
    const n = this.num(name, index);
    return Number.isFinite(n) && n !== 0;
  }
}

/* -------------------------------------------------------------------------- */
/*  Live shared-memory source                                                 */
/* -------------------------------------------------------------------------- */

/** `FILE_MAP_READ` for `OpenFileMappingW` / `MapViewOfFile`. */
const FILE_MAP_READ = 0x0004;
/** Header size in bytes. */
const HEADER_BYTES = 112;
/** Re-open attempts are throttled to one per this many ms while closed. */
const REOPEN_EVERY_MS = 2000;
/**
 * The mapping is closed (and re-opened later) after the sim has reported
 * itself disconnected for this long, so a restarted iRacing's fresh mapping is
 * picked up rather than a dead one held open by our own handle.
 */
const DISCONNECTED_CLOSE_MS = 5000;

/** Minimal koffi-bound Win32 surface. */
interface Win32 {
  OpenFileMappingW: (access: number, inherit: boolean, name: string) => unknown;
  MapViewOfFile: (h: unknown, a: number, hi: number, lo: number, bytes: number) => unknown;
  UnmapViewOfFile: (addr: unknown) => boolean;
  CloseHandle: (h: unknown) => boolean;
  /** Committed size of the region at `addr` (VirtualQuery), 0 when unknown. */
  regionSize: (addr: unknown) => number;
  /** A private copy of `len` bytes at `addr + offset` (memcpy, else decode). */
  readBytes: (addr: unknown, offset: number, len: number) => Buffer;
}

function loadWin32(): Win32 | null {
  if (process.platform !== 'win32') return null;
  // Typed as `any`: koffi is an optional dependency.
  let koffi: any;
  try {
    koffi = require('koffi');
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
    const regionSize = (addr: unknown): number => {
      try {
        const mbi = Buffer.alloc(48);
        if (VirtualQuery(addr, mbi, 48) === 0) return 0;
        return Number(mbi.readBigUInt64LE(24)); // RegionSize @ 24 (x64)
      } catch {
        return 0;
      }
    };
    // memcpy into a Node-owned Buffer: the destination is ordinary JS memory,
    // so nothing foreign is ever wrapped (see the file header on koffi.view).
    let move: ((dst: Buffer, src: bigint, len: number) => void) | null = null;
    try {
      move = k32.func('void __stdcall RtlMoveMemory(void *dst, uintptr_t src, size_t len)');
    } catch {
      move = null;
    }
    const readBytes = (addr: unknown, offset: number, len: number): Buffer => {
      if (move && typeof koffi.address === 'function') {
        const out = Buffer.allocUnsafe(len);
        if (len > 0) move(out, (koffi.address(addr) as bigint) + BigInt(offset), len);
        return out;
      }
      return Buffer.from(koffi.decode(addr, offset, koffi.array('uint8', len)) as number[]);
    };
    return { OpenFileMappingW, MapViewOfFile, UnmapViewOfFile, CloseHandle, regionSize, readBytes };
  } catch {
    return null;
  }
}

/**
 * The live iRacing shared memory. Construct freely on any platform: without
 * Windows, koffi, or a running sim it simply stays closed.
 */
export class LiveIrsdkSource implements IrsdkSource {
  private readonly win32: Win32 | null;
  private handle: unknown = null;
  private addr: unknown = null;
  private size = 0;
  private lastOpenAttempt = -Infinity;
  /** When the sim was first seen disconnected in the current run, or -1. */
  private disconnectedSince = -1;

  private readonly frame = new BufferFrame();
  /** Layout the var table was parsed for; a change forces a re-parse. */
  private layoutKey = '';
  /** Whether {@link frame} holds a good row. */
  private haveRow = false;

  /**
   * @param mappingName the shared-memory name; only tests pass anything else,
   * so they can exercise this reader without touching a running iRacing.
   */
  public constructor(private readonly mappingName: string = IRSDK_MEMMAP_NAME) {
    this.win32 = loadWin32();
  }

  /** Whether the platform can read shared memory at all. */
  public get available(): boolean {
    return this.win32 !== null;
  }

  public isOpen(): boolean {
    return this.addr !== null;
  }

  public open(): boolean {
    if (this.addr !== null) return true;
    const w = this.win32;
    if (w === null) return false;
    const now = Date.now();
    if (now - this.lastOpenAttempt < REOPEN_EVERY_MS) return false;
    this.lastOpenAttempt = now;
    try {
      const h = w.OpenFileMappingW(FILE_MAP_READ, false, this.mappingName);
      if (!h) return false;
      // Length 0 maps the whole file; asking for more than exists fails outright.
      const addr = w.MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0);
      if (!addr) {
        w.CloseHandle(h);
        return false;
      }
      const size = w.regionSize(addr);
      this.handle = h;
      this.addr = addr;
      this.size = size > HEADER_BYTES ? size : 0;
      this.layoutKey = '';
      this.haveRow = false;
      this.disconnectedSince = -1;
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  public close(): void {
    const w = this.win32;
    this.haveRow = false;
    this.layoutKey = '';
    if (w !== null) {
      try {
        if (this.addr) w.UnmapViewOfFile(this.addr);
      } catch {
        /* best effort */
      }
      try {
        if (this.handle) w.CloseHandle(this.handle);
      } catch {
        /* best effort */
      }
    }
    this.addr = null;
    this.handle = null;
    this.size = 0;
  }

  /** A private copy of the bytes at `offset` (never a view over the mapping). */
  private bytes(offset: number, len: number): Buffer | null {
    if (this.addr === null) return null;
    if (offset < 0 || len < 0) return null;
    if (this.size > 0 && offset + len > this.size) return null;
    try {
      return this.win32 ? this.win32.readBytes(this.addr, offset, len) : null;
    } catch {
      return null;
    }
  }

  private header(): Buffer | null {
    return this.bytes(0, HEADER_BYTES);
  }

  /**
   * Connected = version 2, status bit set, AND a real layout. Observed live:
   * when iRacing exits or relaunches mid-session the mapping stays open but the
   * header goes to all zeros (status 0, numVars 0, bufLen 0) — every one of
   * those reads as disconnected, never as a zero-length row.
   */
  public connected(): boolean {
    const h = this.header();
    if (!h) return false;
    try {
      return (
        h.readInt32LE(0) === 2 &&
        (h.readInt32LE(4) & IRSDK_ST_CONNECTED) !== 0 &&
        h.readInt32LE(24) > 0 &&
        h.readInt32LE(36) > 0
      );
    } catch {
      return false;
    }
  }

  public sessionInfoUpdate(): number {
    const h = this.header();
    if (!h) return -1;
    try {
      return h.readInt32LE(12);
    } catch {
      return -1;
    }
  }

  public readSessionInfo(): Buffer | null {
    const h = this.header();
    if (!h) return null;
    try {
      const len = h.readInt32LE(16);
      const off = h.readInt32LE(20);
      if (!(len > 0) || len > 16 * 1024 * 1024) return null;
      const area = this.bytes(off, len);
      if (!area) return null;
      const end = area.indexOf(0);
      // Always a private copy: the caller decodes it later, and the sim may be
      // rewriting the area under a zero-copy view.
      return Buffer.from(area.subarray(0, end < 0 ? area.length : end));
    } catch {
      return null;
    }
  }

  public read(): IrsdkFrame | null {
    if (this.addr === null) return null;
    try {
      return this.readRow();
    } catch {
      return null;
    }
  }

  private readRow(): IrsdkFrame | null {
    const h = this.header();
    if (!h) return null;
    const ver = h.readInt32LE(0);
    const status = h.readInt32LE(4);
    const numVars = h.readInt32LE(24);
    const varHeaderOffset = h.readInt32LE(28);
    const numBuf = Math.min(4, Math.max(0, h.readInt32LE(32)));
    const bufLen = h.readInt32LE(36);
    const now = Date.now();
    if (
      ver !== 2 ||
      (status & IRSDK_ST_CONNECTED) === 0 ||
      numVars <= 0 ||
      numBuf <= 0 ||
      bufLen <= 0 ||
      bufLen > 1024 * 1024
    ) {
      // Disconnected — including the all-zero header iRacing leaves behind when
      // it exits or relaunches with our handle still open. Forget the layout
      // so a reconnect re-reads the var headers from scratch (offsets can
      // change with the car), and close after a while so a fresh mapping is
      // picked up.
      this.haveRow = false;
      this.layoutKey = '';
      if (this.disconnectedSince < 0) this.disconnectedSince = now;
      else if (now - this.disconnectedSince > DISCONNECTED_CLOSE_MS) this.close();
      return null;
    }
    this.disconnectedSince = -1;

    // Var table: once per layout. The list depends on the car, so a new
    // session with a different car re-parses it.
    const key = `${numVars}|${varHeaderOffset}|${bufLen}`;
    if (key !== this.layoutKey) {
      const vb = this.bytes(varHeaderOffset, numVars * 144);
      if (!vb) return null;
      this.frame.vars = parseVarHeaders(Buffer.from(vb), numVars);
      this.layoutKey = key;
      this.haveRow = false;
    }
    if (this.frame.row.length !== bufLen) {
      this.frame.row = Buffer.alloc(bufLen);
      this.haveRow = false;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      let best = -1;
      let bestTick = -Infinity;
      for (let i = 0; i < numBuf; i++) {
        const t = h.readInt32LE(48 + i * 16);
        if (t > bestTick) {
          bestTick = t;
          best = i;
        }
      }
      if (best < 0) return null;
      if (this.haveRow && bestTick === this.frame.tick) return this.frame; // nothing new
      const off = h.readInt32LE(52 + best * 16);
      const src = this.bytes(off, bufLen);
      if (!src) return null;
      src.copy(this.frame.row, 0, 0, bufLen);
      // Re-check: if the sim moved this buffer on mid-copy, the copy is torn.
      if (h.readInt32LE(48 + best * 16) === bestTick) {
        this.frame.tick = bestTick;
        this.haveRow = true;
        return this.frame;
      }
    }
    // Two torn copies in a row: keep the last good row rather than a torn one.
    return this.haveRow ? this.frame : null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function cstr(buf: Buffer, offset: number, maxLen: number): string {
  const end = Math.min(offset + maxLen, buf.length);
  let z = offset;
  while (z < end && buf[z] !== 0) z++;
  return buf.toString('latin1', offset, z);
}
