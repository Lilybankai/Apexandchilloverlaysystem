/**
 * @file src/telemetry/iracing/captureSource.ts
 * @module telemetry/iracing/captureSource
 *
 * Replays a recorded iRacing session through the {@link IrsdkSource} interface,
 * so the provider can be tested (and demoed) with no sim running.
 *
 * ## Capture format (what `irsdk-probe.js` writes)
 * - `frames.ndjson` (or `frames.ndjson.gz`): one JSON object per sampled tick,
 *   every var by name (arrays as arrays), plus `_t` (wall ms), `_tick` and
 *   `_status`.
 * - `session-<n>.yaml` (or `.yaml.gz`): each session-info revision, in order.
 *   The probe decoded the bytes as latin1 and wrote them as UTF-8, so they are
 *   read back as UTF-8 and re-encoded to latin1 to recover the sim's bytes.
 * - Optional `index.json`: `{ "sessions": [{ "file": "session-3.yaml.gz", "t": <wall ms> }] }`.
 *   Without it, each revision's file mtime stands in for when it was written
 *   (the probe writes the YAML immediately before the frame of the same tick).
 *
 * Each {@link read} advances one recorded frame; {@link done} says when the
 * recording is exhausted.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { IrsdkFrame, IrsdkSource } from './irsdk';

type Row = Record<string, unknown>;

/** An {@link IrsdkFrame} over one parsed capture line. */
class JsonFrame implements IrsdkFrame {
  public constructor(private readonly o: Row) {}

  public get tick(): number {
    return typeof this.o._tick === 'number' ? this.o._tick : -1;
  }

  public has(name: string): boolean {
    return this.o[name] !== undefined;
  }

  public count(name: string): number {
    const v = this.o[name];
    if (v === undefined) return 0;
    return Array.isArray(v) ? v.length : 1;
  }

  public num(name: string, index = 0): number {
    let v = this.o[name];
    if (Array.isArray(v)) v = v[index];
    else if (index !== 0) return NaN;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return NaN;
  }

  public bool(name: string, index = 0): boolean {
    const n = this.num(name, index);
    return Number.isFinite(n) && n !== 0;
  }
}

/** Synchronous line reader over a plain file, in 1 MB chunks. */
class LineReader {
  private fd: number;
  private buf = '';
  private eof = false;
  private readonly chunk = Buffer.alloc(1 << 20);

  public constructor(file: string) {
    this.fd = fs.openSync(file, 'r');
  }

  public next(): string | null {
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        return line;
      }
      if (this.eof) {
        if (this.buf.length) {
          const line = this.buf;
          this.buf = '';
          return line;
        }
        return null;
      }
      const n = fs.readSync(this.fd, this.chunk, 0, this.chunk.length, null);
      if (n <= 0) this.eof = true;
      else this.buf += this.chunk.toString('utf8', 0, n);
    }
  }

  public close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
  }
}

interface Revision {
  file: string;
  t: number;
  bytes?: Buffer;
}

/** Replays a capture directory. */
export class CaptureSource implements IrsdkSource {
  private lines: string[] | null = null;
  private reader: LineReader | null = null;
  private lineIdx = 0;
  private revs: Revision[] = [];
  private current: Row | null = null;
  private frame: JsonFrame | null = null;
  private finished = false;
  private opened = false;

  public constructor(private readonly dir: string) {}

  public open(): boolean {
    if (this.opened) return true;
    try {
      const gz = path.join(this.dir, 'frames.ndjson.gz');
      if (fs.existsSync(gz)) {
        this.lines = zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8').split('\n');
      } else {
        this.reader = new LineReader(path.join(this.dir, 'frames.ndjson'));
      }
      this.revs = this.loadRevisions();
      this.opened = true;
      return true;
    } catch {
      return false;
    }
  }

  private loadRevisions(): Revision[] {
    const idx = path.join(this.dir, 'index.json');
    if (fs.existsSync(idx)) {
      const j = JSON.parse(fs.readFileSync(idx, 'utf8')) as { sessions?: Revision[] };
      return (j.sessions ?? [])
        .map((r) => ({ file: path.join(this.dir, r.file), t: r.t }))
        .sort((a, b) => a.t - b.t);
    }
    return fs
      .readdirSync(this.dir)
      .map((f) => ({ f, m: /^session-(\d+)\.yaml(\.gz)?$/.exec(f) }))
      .filter((x) => x.m)
      .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
      .map((x) => {
        const file = path.join(this.dir, x.f);
        return { file, t: fs.statSync(file).mtimeMs };
      });
  }

  public close(): void {
    this.reader?.close();
    this.reader = null;
    this.lines = null;
    this.peeked = null;
    this.opened = false;
  }

  public isOpen(): boolean {
    return this.opened;
  }

  /** Whether every recorded frame has been read. */
  public done(): boolean {
    return this.finished;
  }

  /** The current recorded frame's raw object (for tests). */
  public raw(): Row | null {
    return this.current;
  }

  public connected(): boolean {
    const s = this.current?._status;
    return typeof s === 'number' && (s & 1) !== 0;
  }

  /** A line read ahead by {@link peekTime}, consumed by the next {@link read}. */
  private peeked: string | null = null;

  private nextLine(): string | null {
    if (this.peeked !== null) {
      const l = this.peeked;
      this.peeked = null;
      return l;
    }
    if (this.lines) return this.lineIdx < this.lines.length ? (this.lines[this.lineIdx++] as string) : null;
    return this.reader ? this.reader.next() : null;
  }

  /**
   * The wall-clock time (`_t`, epoch ms) of the frame the next {@link read}
   * will return, or `NaN` at the end — so a test can drive the provider on the
   * capture's own clock.
   */
  public peekTime(): number {
    if (!this.opened || this.finished) return NaN;
    for (;;) {
      const l = this.nextLine();
      if (l === null) return NaN;
      if (!l.trim()) continue;
      this.peeked = l;
      const m = /"_t":(\d+(?:\.\d+)?)/.exec(l);
      return m ? Number(m[1]) : NaN;
    }
  }

  /** Advances to the next recorded frame. */
  public read(): IrsdkFrame | null {
    if (!this.opened || this.finished) return null;
    for (;;) {
      const line = this.nextLine();
      if (line === null) {
        this.finished = true;
        return null;
      }
      if (!line.trim()) continue;
      try {
        this.current = JSON.parse(line) as Row;
      } catch {
        continue;
      }
      this.frame = new JsonFrame(this.current);
      return this.connected() ? this.frame : null;
    }
  }

  /** Index into {@link revs} of the revision current at this frame, or -1. */
  private revIndex(): number {
    const t = typeof this.current?._t === 'number' ? (this.current._t as number) : -Infinity;
    let k = -1;
    for (let i = 0; i < this.revs.length; i++) {
      if ((this.revs[i] as Revision).t <= t + 50) k = i;
      else break;
    }
    return k;
  }

  public sessionInfoUpdate(): number {
    const k = this.revIndex();
    return k < 0 ? -1 : k + 1;
  }

  public readSessionInfo(): Buffer | null {
    const k = this.revIndex();
    const rev = k < 0 ? undefined : this.revs[k];
    if (!rev) return null;
    if (!rev.bytes) {
      try {
        let raw = fs.readFileSync(rev.file);
        if (rev.file.endsWith('.gz')) raw = zlib.gunzipSync(raw);
        rev.bytes = Buffer.from(raw.toString('utf8'), 'latin1');
      } catch {
        return null;
      }
    }
    return rev.bytes;
  }
}
