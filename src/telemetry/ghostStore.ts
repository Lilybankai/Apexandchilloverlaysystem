/**
 * ghostStore.ts — finding a lap to chase, in the laps already on this disk.
 * -----------------------------------------------------------------------------
 * Ghost HUD does not record anything of its own. Every lap driven since August
 * 2026 already has a trace at `traces/<day>/<lapId>.json` and a summary row in
 * the lap database, and `pruneTraces()` was deliberately removed so none of it
 * is ever deleted (`docs/STINT-REVIEW-PLAN.md`, Carl 2026-09-07). Selecting a
 * ghost is therefore a query, not a capture.
 *
 * Split from `ghostLap.ts` on purpose: that module is the maths and imports
 * nothing, so it can be tested headlessly in milliseconds. This one is the
 * half that touches the disk.
 *
 * ## Every read here is asynchronous, and that is the point
 * The telemetry server runs inside Electron's main process, on the thread that
 * composites every overlay, and a synchronous read there is how this app has
 * frozen before (`stall-130s-beat`: one sync spawn under the MFD froze every
 * overlay for up to two seconds). The first Ghost HUD read the whole lap
 * database and up to five traces synchronously inside the frame loop on every
 * combo change — including mid-race, when the surface turned damp — and with
 * retention set to "keep everything" that cost only grows. So nothing here
 * uses a sync `fs` call, and `scripts/test-ghostlap.js` pins that by making
 * them throw.
 *
 * ## The index, and why it is incremental
 * The lap database is append-only JSONL, one file per UTC day. {@link GhostIndex}
 * remembers how many bytes of each day it has already parsed, so a refresh
 * stats the folder and reads only what has been appended since — normally
 * nothing, or the one lap just driven. The full read happens once per process,
 * the first time a ghost is wanted, and off the frame loop.
 *
 * ## What a combo is
 * The same key the lap database already ranks bests by — `lapLog.bestKey`'s
 * `sim | trackKey | carClass`, plus the surface condition. `carClass` is the
 * NORMALISED class (`carClass.normalizeClass`, "HYPERCAR" not LMU's "Hyper"),
 * because that is what every lap record stores; a raw class here finds nothing.
 * Note it is car CLASS, not car: `LapRecord.car` is the raw livery string from
 * the sim (`"DKR Engineering 2026 #3:LM"`), so filtering on it exactly would
 * make a driver's own reference lap vanish the day they change team colours.
 * The car string rides along on each candidate so a picker can still show it.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { ghostFromTrace, ghostHasLine, type GhostLap } from './ghostLap';
import { lapDir, type LapRecord, type TrackCondition } from './lapLog';
import { traceDir, traceFilePath, type TraceFile } from './lapTrace';
import { formatLapTime } from './raceLog';

/** One lap that could be chased. Summary only — the trace is not read yet. */
export interface GhostCandidate {
  /** `LapRecord.id`; also the trace file's basename. */
  lapId: string;
  /** Wall-clock completion, ISO 8601. Needed to find the trace's day folder. */
  at: string;
  /**
   * The sim's lap time in ms, or `0` when it published none.
   *
   * A large minority of stored laps carry `0` here. Those cannot be ranked, so
   * they sort last and are shown without a time; the trace's own measured
   * duration is still perfectly good once the lap is actually loaded, which is
   * what {@link ghostFromTrace} falls back to.
   */
  lapMs: number;
  /** Livery string as the sim gave it — for display, not for keying. */
  car: string;
  carClass: string;
  condition: TrackCondition;
  /** Setup fingerprint, absent on laps written before record v4. */
  setupFp?: string;
  /** Whether the lap was driven inside the white lines. */
  clean: boolean;
  /** Ready-made overlay label, e.g. `"1:13.730 · damp"`. */
  label: string;
}

/** Which laps to consider. */
export interface GhostQuery {
  sim: string;
  trackKey: string;
  /** Normalised class — see the file header. */
  carClass: string;
  /** Only laps set on this surface. Omit to accept any. */
  condition?: TrackCondition;
  /** Only laps driven on this setup. Omit to accept any. */
  setupFp?: string;
  /**
   * Whether to drop laps that left the circuit. Defaults to `true`, and the
   * default is the important part: a cut lap sets a time no honest lap can
   * match, and offering one as a training target is the same mistake
   * `paceDelta`'s `LapValidity` gate exists to prevent. A picker can pass
   * `false` to show them anyway, so long as it says what they are.
   */
  cleanOnly?: boolean;
}

/** Where to read from. Both default to the real locations beside each other. */
export interface GhostDirs {
  laps?: string;
  traces?: string;
}

/** The lap database's file names: one JSONL per UTC day. */
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * Every chaseable lap on disk, grouped by combo, kept current by reading only
 * what has been appended since the last look.
 *
 * Laps whose trace file turns out not to exist are remembered and skipped from
 * then on ({@link markMissing}): the trace is written in the same synchronous
 * breath as its record (`lmuRestProvider.recordLap`), so a record whose trace
 * is absent when the record is visible will never get one, and re-probing it
 * on every retry would be I/O spent on a known answer.
 */
export class GhostIndex {
  private readonly lapsDir: string;
  /** Bytes of each day file already parsed, always up to a line boundary. */
  private readonly parsed = new Map<string, number>();
  /** Candidates by `sim|trackKey|carClass`, in file order. */
  private readonly byCombo = new Map<string, GhostCandidate[]>();
  private readonly seen = new Set<string>();
  private readonly missing = new Set<string>();
  /** The scan queued behind the running one, shared by everyone who asks. */
  private queued: Promise<void> | null = null;
  private tail: Promise<void> = Promise.resolve();

  public constructor(lapsDir: string = lapDir()) {
    this.lapsDir = lapsDir;
  }

  /**
   * Bring the index up to date with the disk. Never rejects.
   *
   * Calls made while a scan is running share ONE follow-up scan rather than
   * joining the running one: that scan may already have read the day file
   * before a lap was appended to it, and the caller asking is usually the one
   * that knows a lap was just written.
   */
  public refresh(): Promise<void> {
    if (this.queued) return this.queued;
    const run = this.tail.then(() => {
      this.queued = null;
      return this.scan();
    });
    this.queued = run;
    this.tail = run;
    return run;
  }

  /** Chaseable laps for a query, fastest first. Memory only — no I/O. */
  public candidates(q: GhostQuery): GhostCandidate[] {
    const all = this.byCombo.get(comboKey(q.sim, q.trackKey, q.carClass)) ?? [];
    const cleanOnly = q.cleanOnly !== false;
    const out = all.filter(
      (c) =>
        !this.missing.has(c.lapId) &&
        (!cleanOnly || c.clean) &&
        (!q.condition || c.condition === q.condition) &&
        (!q.setupFp || c.setupFp === q.setupFp),
    );
    // Fastest first. A lap the sim gave no time for cannot be ranked against
    // one it did, so those go last rather than sorting as if they were instant.
    return out.sort((a, b) => rankOf(a) - rankOf(b));
  }

  /** Forget a candidate whose trace file does not exist. */
  public markMissing(lapId: string): void {
    this.missing.add(lapId);
  }

  private async scan(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.lapsDir);
    } catch {
      return; // nothing has been driven yet
    }
    for (const name of names.filter((n) => DAY_FILE.test(n)).sort()) {
      try {
        await this.scanDay(name);
      } catch {
        /* one unreadable day must not cost the rest; it is retried next scan */
      }
    }
  }

  private async scanDay(name: string): Promise<void> {
    const file = path.join(this.lapsDir, name);
    const { size } = await fsp.stat(file);
    let from = this.parsed.get(name) ?? 0;
    // Nothing in the app rewrites a day file, but a file that shrank was
    // replaced by something, and reading on from the old offset would start
    // mid-line. Start again; ids already seen are skipped.
    if (size < from) from = 0;
    if (size === from) return;

    const buf = Buffer.alloc(size - from);
    const fh = await fsp.open(file, 'r');
    let bytesRead: number;
    try {
      ({ bytesRead } = await fh.read(buf, 0, buf.length, from));
    } finally {
      await fh.close();
    }
    // Only whole lines. The last one can be half-written when this races a lap
    // crossing the line; it is read again, complete, next time.
    const end = bytesRead > 0 ? buf.lastIndexOf(0x0a, bytesRead - 1) : -1;
    if (end < 0) return;
    this.parsed.set(name, from + end + 1);
    for (const line of buf.toString('utf8', 0, end).split('\n')) {
      if (!line.trim()) continue;
      let rec: LapRecord;
      try {
        rec = JSON.parse(line) as LapRecord;
      } catch {
        continue; // hand-edited, or torn by a crash mid-append
      }
      this.add(rec);
    }
  }

  private add(rec: LapRecord): void {
    // Pre-v3 laps have no id, so no trace to point at.
    if (!rec || !rec.id || typeof rec.lapMs !== 'number' || this.seen.has(rec.id)) return;
    this.seen.add(rec.id);
    // Pre-v7 laps carry no condition and read as dry — the same judgement the
    // league boards make, for the same reason: it is right for almost every
    // lap ever recorded.
    const condition: TrackCondition = rec.condition || 'dry';
    const key = comboKey(rec.sim, rec.trackKey, rec.carClass);
    let list = this.byCombo.get(key);
    if (!list) this.byCombo.set(key, (list = []));
    list.push({
      lapId: rec.id,
      at: rec.at,
      lapMs: Number.isFinite(rec.lapMs) && rec.lapMs > 0 ? rec.lapMs : 0,
      car: rec.car || '',
      carClass: rec.carClass || '',
      condition,
      ...(rec.setupFp ? { setupFp: rec.setupFp } : {}),
      clean: !!rec.clean,
      label: candidateLabel(rec, condition),
    });
  }
}

/**
 * Read one candidate's trace and build the ghost. `null` when the file has
 * gone, will not parse, or cannot support a reference — see
 * {@link ghostFromTrace}. A file that does not exist at all is reported to
 * `index` so it is not probed again.
 */
export async function loadGhost(
  candidate: GhostCandidate,
  dirs: GhostDirs = {},
  index?: GhostIndex,
): Promise<GhostLap | null> {
  let file: TraceFile;
  try {
    const p = traceFilePath(candidate.lapId, candidate.at, dirs.traces ?? traceDir());
    file = JSON.parse(await fsp.readFile(p, 'utf8')) as TraceFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') index?.markMissing(candidate.lapId);
    return null;
  }
  if (!file || file.lapId !== candidate.lapId || !file.trace || !Array.isArray(file.trace.d)) {
    return null;
  }
  return ghostFromTrace(file, candidate.label);
}

/**
 * How many traces to open looking for one with a driven line.
 *
 * Reading a trace is a file read and a JSON parse of ~50 KB, so this is not
 * free, but in practice the first candidate has a line: every lap recorded
 * since the line shipped carries one, and the fastest lap is usually recent.
 */
const MAX_LINE_PROBE = 5;

/**
 * The fastest chaseable lap for a combo, loaded and ready, or `null`.
 *
 * Prefers a lap that carries a driven LINE, because that is what Ghost HUD
 * draws on the road; a lap without one can still be counted against, but it
 * can only produce the numbers. Laps recorded while shared memory was silent
 * have no position at all (see `TraceChannels.x`), and so do laps from before
 * the line shipped.
 *
 * It falls back to the fastest loadable lap rather than refusing: a driver
 * whose only quick lap predates the line should still get a delta, and the
 * widget is told which it got via {@link ghostHasLine} rather than discovering
 * it half way through a draw.
 *
 * @param current - The ghost already loaded, if any. When it comes up as a
 *   candidate it is reused rather than read and parsed again, so re-checking
 *   after every new lap costs a trace read only when the lap might win.
 */
export async function loadBestGhost(
  index: GhostIndex,
  q: GhostQuery,
  dirs: GhostDirs = {},
  current: GhostLap | null = null,
): Promise<GhostLap | null> {
  await index.refresh();
  const list = index.candidates(q);
  let fallback: GhostLap | null = null;
  let opened = 0;
  // Candidates with no trace file do not count against the probe: the old
  // synchronous picker filtered those out before counting, and a run of
  // untraced laps at the top (spectated, or written before traces shipped)
  // must not hide a perfectly good lap sixth in line.
  for (const c of list) {
    if (opened >= MAX_LINE_PROBE) break;
    const lap = current && c.lapId === current.lapId ? current : await loadGhost(c, dirs, index);
    if (!lap) continue;
    opened += 1;
    if (ghostHasLine(lap)) return lap;
    if (!fallback) fallback = lap;
  }
  return fallback;
}

/* ------------------------------- internals -------------------------------- */

function comboKey(sim: string, trackKey: string, carClass: string): string {
  return `${sim}|${trackKey}|${carClass}`;
}

/** Sort weight: lap time in ms, with untimed laps pushed to the end. */
function rankOf(c: GhostCandidate): number {
  return c.lapMs > 0 ? c.lapMs : Number.MAX_SAFE_INTEGER;
}

/**
 * `"1:13.730 · damp"`, with the surface only when it is not dry — almost every
 * lap is dry, so saying so on all of them is noise. The lap time comes from
 * `raceLog.formatLapTime` rather than a local copy: two surfaces that format
 * the same lap differently is a bug waiting to be reported.
 */
function candidateLabel(rec: LapRecord, condition: TrackCondition): string {
  const time = Number.isFinite(rec.lapMs) && rec.lapMs > 0 ? formatLapTime(rec.lapMs / 1000) : '—';
  const parts = [time];
  if (condition !== 'dry') parts.push(condition);
  if (!rec.clean) parts.push('cut');
  return parts.join(' · ');
}

/** Exported for the test, which needs to know where a trace would be written. */
export function ghostTracePath(lapId: string, at: string, dir = traceDir()): string {
  return path.resolve(traceFilePath(lapId, at, dir));
}
