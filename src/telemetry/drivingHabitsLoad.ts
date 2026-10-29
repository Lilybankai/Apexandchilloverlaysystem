/**
 * drivingHabitsLoad.ts — the disk half of "Your driving" (drivingHabits.ts).
 * =============================================================================
 *
 * For the electron side (`practice:habits` IPC, electron/habits-ipc.js):
 *
 *   loadDrivingHabits(args: { trackKey: string; carClass: string },
 *                     deps: HabitsDeps): Promise<HabitsReportFull | null>
 *
 *     deps.reviewDir  the Practice Review snapshots (`<userData>/practice-reviews`),
 *                     for each practice session's accuracy. Optional: without
 *                     it a session is scored against its own best lap.
 *     deps.lapDir     the lap log (default `lapLog.lapDir()`).
 *     deps.traceDir   the trace store (default `lapTrace.traceDir()`).
 *     deps.cacheDir   the feature cache (default `~/.apex-overlay/coach`).
 *     deps.cornerDir  passed to `cornersForLap` as the catalogue folder.
 *
 *   Returns null only when the log holds no session at that track in that class.
 *
 * ## The feature cache
 * A habit is read off every lap ever driven at a track — on Carl's PC 1,364
 * traces, ~51 KB each, 69 MB in all. Parsing them on every visit to the tab
 * is not on, so what `drivingHabits.extract*` returns is kept per lap in
 * `~/.apex-overlay/coach/<trackKey>.json`:
 *
 *   { v: FEATURE_VERSION, trackKey,
 *     laps:     { <lapId>: { f: LapFeatures | null, ck?: string, c?: CornerFeatures[] } },
 *     sessions: { <sessionId>: { sig, accuracy } } }
 *
 *   - Beside the lap log and the traces, NOT in the app's install or userData
 *     folder: an app update leaves it alone, and the version inside is the
 *     FEATURE version, so only a change to the maths re-extracts everything.
 *   - A lap is extracted once. `f: null` remembers a lap whose trace is
 *     missing or torn — the record is written 40 s after its trace, so a lap
 *     with no trace by then never gets one.
 *   - Per-corner features also carry the corner key (`ck`) they were cut
 *     with; a new catalogue, or a new reference in the fallback, re-cuts only
 *     the laps that need corners.
 *   - A practice session's accuracy (the Practice Review score) is kept once
 *     the session has ended (`SESSION_GAP_MS` since its last lap), keyed by a
 *     signature of its laps.
 *
 * Asynchronous on purpose: this runs in Electron's main process, which also
 * drives the in-game overlay, and a cold cache is hundreds of trace files.
 * Files are read with `fs.promises` and the work yields to the event loop
 * every few milliseconds, so a first visit never freezes the overlay (see the
 * stall notes on synchronous work on main).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lapDir as defaultLapDir, conditionOf, type LapRecord } from './lapLog';
import { traceDir as defaultTraceDir, traceFilePath, type TraceFile } from './lapTrace';
import { groupSessions, readAllLaps, SESSION_GAP_MS, type ReviewLap, type ReviewSession } from './stintReview';
import { buildPracticeReview } from './practiceReview';
import { findSnapshot } from './practiceReviewLoad';
import { cornersForLap } from './cornerCatalog';
import { mapKeyForLap } from './lapDetail';
import { scoreLap as scorePace } from './referencePace';
import {
  FEATURE_VERSION,
  HABIT_MIN_LAPS,
  buildHabitsReport,
  cornerKey,
  extractCornerFeatures,
  extractLapFeatures,
  type CornerFeatures,
  type HabitCorner,
  type HabitsLapInput,
  type HabitsReportFull,
  type HabitsSessionInput,
  type LapFeatures,
} from './drivingHabits';

export interface HabitsArgs {
  trackKey: string;
  carClass: string;
}

export interface HabitsDeps {
  reviewDir?: string;
  lapDir?: string;
  traceDir?: string;
  cacheDir?: string;
  cornerDir?: string;
  /** Called once per load with what it cost — for the measurements and the log. */
  onStats?: (s: HabitsLoadStats) => void;
}

export interface HabitsLoadStats {
  ms: number;
  sessions: number;
  laps: number;
  tracesRead: number;
  extracted: number;
  cornerCut: number;
  accuracyBuilt: number;
  cacheWritten: boolean;
}

interface CacheLap {
  f: LapFeatures | null;
  ck?: string;
  c?: CornerFeatures[] | null;
}

interface CacheFile {
  v: number;
  trackKey: string;
  laps: Record<string, CacheLap>;
  sessions: Record<string, { sig: string; accuracy: number | null }>;
}

/** Default home of the cache: beside the lap log, so it outlives app updates. */
export function habitsCacheDir(): string {
  return path.join(os.homedir(), '.apex-overlay', 'coach');
}

/** The cache file for a track. Track keys are slugs already; this keeps them so. */
export function habitsCacheFile(trackKey: string, dir = habitsCacheDir()): string {
  return path.join(dir, `${String(trackKey).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function emptyCache(trackKey: string): CacheFile {
  return { v: FEATURE_VERSION, trackKey, laps: {}, sessions: {} };
}

async function readCache(file: string, trackKey: string): Promise<CacheFile> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as CacheFile;
    // A different FEATURE_VERSION is a different set of measurements: start over.
    if (raw && raw.v === FEATURE_VERSION && raw.laps && typeof raw.laps === 'object') {
      return { v: FEATURE_VERSION, trackKey, laps: raw.laps, sessions: raw.sessions || {} };
    }
  } catch {
    /* none yet, or torn: rebuilt below */
  }
  return emptyCache(trackKey);
}

/** Write via a temp file and rename, so a crash mid-write never leaves a torn cache. */
async function writeCache(file: string, cache: CacheFile): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(cache), 'utf8');
  await fs.promises.rename(tmp, file);
}

async function readTraceAsync(lapId: string, at: string, dir: string): Promise<TraceFile | null> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(traceFilePath(lapId, at, dir), 'utf8')) as TraceFile;
    if (raw && raw.lapId === lapId && raw.trace && Array.isArray(raw.trace.d)) return raw;
  } catch {
    /* never recorded, or torn */
  }
  return null;
}

/** Yield to the event loop when this slice has run long enough. */
function yielder(budgetMs = 8): () => Promise<void> {
  let since = Date.now();
  return async () => {
    if (Date.now() - since < budgetMs) return;
    await new Promise<void>((r) => setImmediate(r));
    since = Date.now();
  };
}

const PRACTICE = new Set(['practice', 'testday']);

const lapsOf = (s: ReviewSession): ReviewLap[] =>
  s.stints.flatMap((st) => st.laps).sort((a, b) => a.lapNo - b.lapNo);

const isValid = (l: ReviewLap): boolean => l.clean === true && l.timed === true && l.lapMs > 0;

/** A lap is "wet" for habits when it was damp or wet; pre-v7 laps fall back to the boolean. */
function wetOf(rec: LapRecord | undefined): boolean {
  if (!rec) return false;
  if (rec.condition) return rec.condition !== 'dry';
  if (typeof rec.wetness === 'number') return conditionOf(rec.wetness) !== 'dry';
  return rec.wet === true;
}

/** Same load in flight for the same track and class: share it. */
const inflight = new Map<string, Promise<HabitsReportFull | null>>();

export function loadDrivingHabits(args: HabitsArgs, deps: HabitsDeps = {}, now = Date.now()): Promise<HabitsReportFull | null> {
  const key = `${args.trackKey}|${String(args.carClass || '').toUpperCase()}|${deps.cacheDir || ''}|${deps.lapDir || ''}`;
  const hit = inflight.get(key);
  if (hit) return hit;
  const p = loadImpl(args, deps, now).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function loadImpl(args: HabitsArgs, deps: HabitsDeps, now: number): Promise<HabitsReportFull | null> {
  const t0 = Date.now();
  if (!args || !args.trackKey) return null;
  const lapDir = deps.lapDir || defaultLapDir();
  const tdir = deps.traceDir || defaultTraceDir();
  const cacheFile = habitsCacheFile(args.trackKey, deps.cacheDir || habitsCacheDir());
  const cls = String(args.carClass || '').toUpperCase();
  const tick = yielder();

  // Group the WHOLE log, then filter: grouping a filtered log could weld two
  // sittings at this track either side of a short one elsewhere.
  const records = readAllLaps(lapDir);
  const byId = new Map<string, LapRecord>();
  for (const r of records) if (r && r.id) byId.set(r.id, r);
  const sessions = groupSessions(records, '')
    .filter((s) => s.trackKey === args.trackKey && (!cls || String(s.carClass || '').toUpperCase() === cls))
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  if (!sessions.length) return null;
  await tick();

  const cache = await readCache(cacheFile, args.trackKey);
  let dirty = false;
  const stats: HabitsLoadStats = { ms: 0, sessions: sessions.length, laps: 0, tracesRead: 0, extracted: 0, cornerCut: 0, accuracyBuilt: 0, cacheWritten: false };
  const newest = sessions[sessions.length - 1]!;
  const L = newest.trackLengthM > 0 ? newest.trackLengthM : sessions.find((s) => s.trackLengthM > 0)?.trackLengthM || 0;

  /* -------- the corners: catalogue, or the newest traced session's best --- */

  let corners: HabitCorner[] = [];
  let source: 'catalog' | 'reference' | 'none' = 'none';
  let cornerSessionId: string | null = null;
  // In the fallback the corners only cover one session, so prefer the newest
  // one with enough laps to show a habit; else simply the newest with a trace.
  const enough = (s: ReviewSession): boolean =>
    lapsOf(s).filter((l) => isValid(l) && l.id && !(cache.laps[l.id] && cache.laps[l.id]!.f === null)).length > HABIT_MIN_LAPS;
  const preferred = sessions.filter(enough);
  const searchOrder = [...[...preferred].reverse(), ...[...sessions].reverse().filter((s) => !preferred.includes(s))];
  for (let si = 0; si < searchOrder.length && source === 'none'; si += 1) {
    const s = searchOrder[si]!;
    const cands = lapsOf(s).filter((l) => isValid(l) && l.id).sort((a, b) => a.lapMs - b.lapMs);
    for (const lap of cands) {
      if (cache.laps[lap.id!] && cache.laps[lap.id!]!.f === null) continue; // known traceless
      const file = await readTraceAsync(lap.id!, lap.at, tdir);
      stats.tracesRead += 1;
      if (!file) continue;
      const rec = byId.get(lap.id!);
      const mapKey = rec ? mapKeyForLap(rec) : null;
      const cut = cornersForLap({
        mapKey,
        trackLengthM: L,
        ref: file.trace,
        ...(deps.cornerDir ? { dir: deps.cornerDir } : {}),
      });
      if (cut.corners.length) {
        corners = cut.corners.map((c) => ({ id: c.id, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
        source = cut.source;
        cornerSessionId = s.id;
      }
      break;
    }
  }
  const ck = corners.length ? cornerKey(corners, source) : '';
  const needsCorners = (sessionId: string): boolean =>
    corners.length > 0 && (source === 'catalog' || sessionId === cornerSessionId);

  /* -------- features per lap, and accuracy per practice session ----------- */

  const inputs: HabitsSessionInput[] = [];
  for (const s of sessions) {
    const laps = lapsOf(s);
    stats.laps += laps.length;
    const wantCorners = needsCorners(s.id);
    const read = new Map<string, TraceFile | null>();

    for (const lap of laps) {
      if (!lap.id || !lap.timed) continue;
      const have = cache.laps[lap.id];
      const needF = !have;
      const needC = wantCorners && (!have || (have.f !== null && have.ck !== ck));
      if (!needF && !needC) continue;
      const file = await readTraceAsync(lap.id, lap.at, tdir);
      stats.tracesRead += 1;
      read.set(lap.id, file);
      const entry: CacheLap = have ? { ...have } : { f: null };
      if (needF) {
        entry.f = file && L > 0 ? extractLapFeatures(file.trace, L) : null;
        stats.extracted += 1;
      }
      if (needC && entry.f !== null && file) {
        entry.ck = ck;
        entry.c = extractCornerFeatures(file.trace, lap.lapMs / 1000, L, corners);
        stats.cornerCut += 1;
      }
      cache.laps[lap.id] = entry;
      dirty = true;
      await tick();
    }

    // Accuracy: the Practice Review's own score for practice sessions — built
    // from the traces just read plus any not read this time.
    let accuracy: number | null = null;
    if (PRACTICE.has(s.sessionType)) {
      const sig = `${laps.length}:${laps[laps.length - 1]?.id || ''}`;
      const kept = cache.sessions[s.id];
      if (kept && kept.sig === sig) {
        accuracy = kept.accuracy;
      } else {
        const traces = new Map<string, TraceFile | null>();
        for (const lap of laps) {
          if (!lap.id || !lap.timed) continue;
          if (cache.laps[lap.id] && cache.laps[lap.id]!.f === null) continue;
          let file = read.get(lap.id);
          if (file === undefined) {
            file = await readTraceAsync(lap.id, lap.at, tdir);
            stats.tracesRead += 1;
            await tick();
          }
          if (file) traces.set(lap.id, file);
        }
        const snap = deps.reviewDir ? findSnapshot(s.id, s, deps.reviewDir) : null;
        const review = buildPracticeReview({ session: s, traces, target: snap ? snap.target : null });
        accuracy = review.score.avg;
        stats.accuracyBuilt += 1;
        const ended = Date.parse(s.endedAt);
        if (Number.isFinite(ended) && now - ended > SESSION_GAP_MS) {
          cache.sessions[s.id] = { sig, accuracy };
          dirty = true;
        }
        await tick();
      }
    }

    // Reference pace: the session's best clean lap, never on a wet session
    // (the reference times are all dry laps — board-conditions rule).
    const sessionWet = laps.some((l) => l.id && wetOf(byId.get(l.id)));
    let refPct: number | null = null;
    if (s.stats.bestMs && !sessionWet) {
      try {
        const scored = scorePace({
          track: s.track,
          trackConfig: s.trackConfig,
          simTrackName: s.simTrackName,
          trackLengthM: s.trackLengthM,
          carClass: s.carClass,
          car: s.car,
          lapMs: s.stats.bestMs,
        });
        refPct = scored.ok && scored.score ? scored.score.percent : null;
      } catch {
        refPct = null;
      }
    }

    inputs.push({
      id: s.id,
      at: s.startedAt,
      type: s.sessionType,
      bestSec: s.stats.bestMs ? s.stats.bestMs / 1000 : null,
      avgSec: s.stats.averageMs ? s.stats.averageMs / 1000 : null,
      spreadSec: s.stats.spreadMs !== null ? s.stats.spreadMs / 1000 : null,
      accuracy,
      refPct,
      laps: laps.map((lap): HabitsLapInput => {
        const e = lap.id ? cache.laps[lap.id] : undefined;
        return {
          id: lap.id || null,
          at: lap.at,
          lapNo: lap.lapNo,
          lapSec: lap.lapMs > 0 ? lap.lapMs / 1000 : 0,
          valid: isValid(lap),
          timed: lap.timed,
          outLap: lap.isOutLap,
          inLap: lap.isInLap,
          dirty: lap.dirty,
          wet: !!lap.id && wetOf(byId.get(lap.id)),
          f: e ? e.f : null,
          c: e && wantCorners && e.ck === ck && e.c ? e.c : null,
        };
      }),
    });
  }

  if (dirty) {
    try {
      await writeCache(cacheFile, cache);
      stats.cacheWritten = true;
    } catch (err) {
      // A cache that cannot be written costs speed next time, not the answer.
      console.warn('[habits] could not write the feature cache:', (err as Error).message);
    }
  }

  const report = buildHabitsReport({
    trackKey: args.trackKey,
    carClass: args.carClass || newest.carClass,
    track: newest.track,
    car: newest.car,
    trackLengthM: L,
    sessions: inputs,
    corners,
    cornerSource: source,
    cornerSessionId,
  });
  stats.ms = Date.now() - t0;
  if (deps.onStats) deps.onStats(stats);
  return report;
}
