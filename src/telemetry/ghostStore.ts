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
 * ## What a combo is
 * The same key the lap database already ranks bests by — `lapLog.bestKey`'s
 * `sim | trackKey | carClass`, plus the surface condition. Note it is car
 * CLASS, not car: `LapRecord.car` is the raw livery string from the sim
 * (`"DKR Engineering 2026 #3:LM"`), so filtering on it exactly would make a
 * driver's own reference lap vanish the day they change team colours. The car
 * string rides along on each candidate so a picker can still show it.
 *
 * Within a combo, candidates are grouped by {@link LapRecord.setupFp} — the
 * setup the lap was actually driven on. That is what the fixed-versus-open
 * question really wants: whether the session MANDATED a setup is recorded
 * nowhere on a lap (only on the event schedule feed), but what the car was
 * running is, on every lap since record v4.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ghostFromTrace, type GhostLap } from './ghostLap';
import { lapDir, type LapRecord, type TrackCondition } from './lapLog';
import { readTrace, traceDir, traceFilePath } from './lapTrace';
import { formatLapTime } from './raceLog';
import { readAllLaps } from './stintReview';

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
  /** Ready-made overlay label, e.g. `"your best · 1:13.730 · dry"`. */
  label: string;
}

/** Which laps to consider. */
export interface GhostQuery {
  sim: string;
  trackKey: string;
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

/**
 * Every lap in the store that could be chased for this combo, fastest first.
 *
 * Reads only the lap database (one small JSONL per day) and checks that each
 * candidate's trace file exists. It deliberately does not parse the traces:
 * there are hundreds of them totalling tens of megabytes, and a picker needs
 * a list of times, not the driving data behind each one.
 */
export function ghostCandidates(q: GhostQuery, dirs: GhostDirs = {}): GhostCandidate[] {
  const laps = dirs.laps ?? lapDir();
  const traces = dirs.traces ?? traceDir();
  const cleanOnly = q.cleanOnly !== false;

  let all: LapRecord[];
  try {
    all = readAllLaps(laps);
  } catch {
    return [];
  }

  const out: GhostCandidate[] = [];
  for (const rec of all) {
    if (!rec || !rec.id) continue; // pre-v3: no id, so no trace to point at
    if (rec.sim !== q.sim) continue;
    if (rec.trackKey !== q.trackKey) continue;
    if (rec.carClass !== q.carClass) continue;
    if (cleanOnly && !rec.clean) continue;
    // Pre-v7 laps carry no condition and read as dry — the same judgement the
    // league boards make, for the same reason: it is right for almost every
    // lap ever recorded.
    const condition: TrackCondition = rec.condition || 'dry';
    if (q.condition && condition !== q.condition) continue;
    if (q.setupFp && rec.setupFp !== q.setupFp) continue;
    if (!hasTraceFile(rec.id, rec.at, traces)) continue;

    out.push({
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

  // Fastest first. A lap the sim gave no time for cannot be ranked against one
  // it did, so those go last rather than sorting as if they were instant.
  out.sort((a, b) => rankOf(a) - rankOf(b));
  return out;
}

/**
 * The fastest chaseable lap for a combo, or `null` when there is none.
 *
 * This is the "auto-record, keep fastest" behaviour, and it needs no recording
 * and no pruning: every lap is already on disk, so the fastest one is a sort.
 */
export function bestGhostCandidate(q: GhostQuery, dirs: GhostDirs = {}): GhostCandidate | null {
  const list = ghostCandidates(q, dirs);
  for (const c of list) if (c.lapMs > 0) return c;
  return list[0] ?? null;
}

/**
 * Read one candidate's trace and build the ghost. `null` when the file has
 * gone, will not parse, or cannot support a reference — see
 * {@link ghostFromTrace}.
 */
export function loadGhost(candidate: GhostCandidate, dirs: GhostDirs = {}): GhostLap | null {
  const traces = dirs.traces ?? traceDir();
  let file;
  try {
    file = readTrace(candidate.lapId, candidate.at, traces);
  } catch {
    return null;
  }
  if (!file) return null;
  return ghostFromTrace(file, candidate.label);
}

/** The fastest chaseable lap for a combo, loaded and ready. */
export function loadBestGhost(q: GhostQuery, dirs: GhostDirs = {}): GhostLap | null {
  const best = bestGhostCandidate(q, dirs);
  return best ? loadGhost(best, dirs) : null;
}

/* ------------------------------- internals -------------------------------- */

/** Sort weight: lap time in ms, with untimed laps pushed to the end. */
function rankOf(c: GhostCandidate): number {
  return c.lapMs > 0 ? c.lapMs : Number.MAX_SAFE_INTEGER;
}

function hasTraceFile(lapId: string, at: string, dir: string): boolean {
  let p: string;
  try {
    p = traceFilePath(lapId, at, dir);
  } catch {
    return false;
  }
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * `"1:13.730 · dry"`, with the surface only when it is not dry — almost every
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
