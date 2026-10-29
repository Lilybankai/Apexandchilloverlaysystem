/**
 * drivingHabits.ts — "Your driving": how a driver habitually drives one track
 * in one class, across every lap and session the log holds.
 * =============================================================================
 *
 * The AI driving coach (2026-10-29, Carl, after Delta's Auto Insights 2.0)
 * says where ONE lap or ONE session loses time. This module says what keeps
 * happening: the braking point into C5 that wanders ±18 m, the corner taken
 * 4 km/h slower than on the driver's quickest passes on seven laps out of ten,
 * the 3% of every lap spent coasting, the five laps it takes to get within 1%
 * of the session's best. Shown in the Practice tab (practice-habits.js).
 *
 * Two halves, both pure (no fs, no Electron, no clock):
 *
 *   1. EXTRACTION, per lap — {@link extractLapFeatures} and
 *      {@link extractCornerFeatures} turn one stored trace into a few dozen
 *      numbers. That is the expensive half (the trace must be parsed: ~51 KB a
 *      lap, ~69 MB on Carl's PC), so `drivingHabitsLoad.ts` caches what they
 *      return per lap id under {@link FEATURE_VERSION} and only ever extracts
 *      a lap once. A lap's features depend on the lap alone — EXCEPT the
 *      per-corner ones, which depend on where the corners are; those carry the
 *      {@link cornerKey} they were cut with and are re-extracted when it moves.
 *
 *   2. THE REPORT — {@link buildHabitsReport} folds the cached features of
 *      every lap into a {@link HabitsReport}: the session-by-session trend,
 *      per-corner consistency, the whole-lap habits and one {@link CoachFact}
 *      per number shown, with a template sentence each. Cheap; rebuilt on
 *      every ask.
 *
 * ## Which laps teach a habit
 * Only laps that are VALID (clean, with a real time — the Practice Review's
 * rule), DRY (a wet lap brakes earlier for a reason that is not a habit), and
 * within {@link HABIT_WINDOW} of their own session's best valid lap (a cool-
 * down lap, a lap behind a slower car, a lap saving fuel for a stint target
 * all drive differently on purpose). The trend still lists every session;
 * the learning curve and the dirty-lap share read every flying lap, because
 * the dirty ones are what they are about.
 *
 * ## Corners must mean the same road in every session
 * Per-corner habits compare C5 on one lap with C5 on another, so the corners
 * must be stable: `cornerCatalog.cornersForLap()` with `source: 'catalog'`.
 * Until a layout has a catalogue that call falls back to the corners of one
 * reference lap, and `corners.ts` cuts a different number of corners on
 * different laps (Road Atlanta 8–13, Le Mans 20–25) — so a fallback cut from
 * this session's best and applied to last month's laps would be fine, but the
 * one cut NEXT session would renumber everything. The loader therefore limits
 * per-corner habits to the reference's own session in that case, and the
 * report says so ({@link HabitsReportExtras.cornerSource} / `cornerNote`).
 *
 * ## Units and signs
 * The contract's (coachContract.ts): distances along the lap are fractions
 * 0..1 inside, metres only in fields that say `M`; positive seconds = losing.
 * A braking delta is positive when the lap braked LATER.
 */

import type { CoachFact, HabitsReport } from './coachContract';
import type { CompletedTrace } from './lapTrace';

/* -------------------------------------------------------------------------- */
/*  Versions and thresholds                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Bump when {@link extractLapFeatures} / {@link extractCornerFeatures} change
 * what they measure: every cached lap is then extracted again (the cache file
 * is keyed by this, not by the app version, so an app update that leaves the
 * maths alone costs nothing).
 */
export const FEATURE_VERSION = 1;

/** Bump when the report's shape or its template wording changes (AI cache key). */
export const HABITS_VERSION = 1;

/** Brake pressure at or above this is "on"; below the other, "off" — `brakePoints.ts`'s. */
export const BRAKE_ON = 0.12;
export const BRAKE_OFF = 0.05;
/** Throttle below this is "off the throttle" (coasting / overlap). */
export const THROTTLE_OFF = 0.05;
/** Throttle at or above this counts towards brake/throttle overlap. */
export const THROTTLE_ON = 0.1;
/** Coasting only counts at speed: rolling down the pit exit is not a habit. */
export const COAST_MIN_KPH = 50;
/** A gap in the trace longer than this is not time spent doing anything. */
const MAX_DT = 1.0;
/**
 * Turn-in, as a share of the corner's peak lateral load: walking back from
 * the peak, the car turned in where |latG| last sat at or below this share
 * (and never above {@link TURN_IN_FLOOR_G}). A fixed g threshold read every
 * braking zone that starts in a bend (Road Atlanta's esses) as "turned in
 * at the first touch of the pedal".
 */
export const TURN_IN_SHARE = 0.35;
export const TURN_IN_FLOOR_G = 0.3;
/**
 * Pedal states shorter than this are the feet crossing over, not a habit:
 * the 60 ms where the throttle is still lifting as the brake goes on is in
 * every braking zone, and counted it reads as ~1 s of "overlap" a lap.
 */
export const MIN_RUN_SEC = 0.25;
/** Brake still on this far past turn-in counts as trail braking, metres. */
export const TRAIL_MIN_M = 10;
/** A braking zone needs at least this much pedal at its peak to count. */
const ZONE_MIN_PEAK = 0.25;
/** How far before a corner's entry its braking point may be, metres (`corners.ts` BRAKE_SEARCH_M). */
export const BRAKE_SEARCH_M = 100;
/** TC / ABS channel level that counts as intervening (the envelope tail sits below it). */
export const AID_ON = 0.05;
/** Two interventions closer than this are one event, seconds. */
export const AID_MERGE_SEC = 0.5;

/** Laps slower than the session's best valid lap × this teach no habit (see the header). */
export const HABIT_WINDOW = 1.07;
/** The learning curve: laps to get within this share of the session's best. */
export const LEARN_WITHIN = 1.01;
/** A corner habit needs this many scored laps… */
export const HABIT_MIN_LAPS = 5;
/** …and has to show on this share of them to be "a clear pattern". */
export const HABIT_SHARE = 0.6;
/** Braking this much earlier / later than the quickest passes counts, metres. */
export const HABIT_BRAKE_M = 8;
/** Carrying this much less minimum speed than the quickest passes counts, km/h. */
export const HABIT_MIN_KPH = 3;
/** A braking point that wanders more than this (robust σ) is worth a sentence, metres. */
export const WANDER_M = 12;

/* -------------------------------------------------------------------------- */
/*  Per-lap features (the cached half)                                        */
/* -------------------------------------------------------------------------- */

/** Whole-lap features of one trace. Independent of where the corners are. */
export interface LapFeatures {
  /** Seconds the lap spent with neither pedal down, at speed. */
  coastSec: number;
  /** …as a share of the trace's time, percent. */
  coastPct: number;
  /** Seconds with brake and throttle both pressed. */
  overlapSec: number;
  /** Braking zones found (peak pedal ≥ {@link ZONE_MIN_PEAK}). */
  zones: number;
  /** Zones where a turn-in was found inside the braking. */
  turnZones: number;
  /** Zones with the brake held ≥ {@link TRAIL_MIN_M} past turn-in. */
  trailZones: number;
  /** Median metres of brake past turn-in over `turnZones`; null when none. */
  trailM: number | null;
  /** The trace carries the current TC/ABS method (`aids: 2`); otherwise tc/abs are null. */
  aids: boolean;
  tcSec: number | null;
  tcEvents: number | null;
  absSec: number | null;
  absEvents: number | null;
}

/** One corner of one lap. Lap fractions; null = not found on this lap. */
export interface CornerFeatures {
  /** Seconds from this corner's entry to the next corner's entry (the last: to the line). */
  segSec: number | null;
  /** Where the brake went on for this corner. */
  brakeD: number | null;
  /** Minimum speed between entry and exit, km/h. */
  minKph: number | null;
  /** Metres of brake past turn-in (0 = released before turning). */
  trailM: number | null;
}

/** The corners a lap is cut by: `cornerCatalog.CornerSpan`'s shape. */
export interface HabitCorner {
  id: string;
  entryD: number;
  apexD: number;
  exitD: number;
}

/** A trace's columns, cleaned so `d` strictly rises and `t` never falls. */
interface Cols {
  n: number;
  d: number[];
  t: number[];
  throttle: number[];
  brake: number[];
  speed: number[];
  latG: number[];
  tc: number[];
  abs: number[];
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function columnsOf(tr: CompletedTrace | null | undefined): Cols | null {
  if (!tr || !Array.isArray(tr.d) || !Array.isArray(tr.t)) return null;
  const n0 = Math.min(tr.d.length, tr.t.length);
  const col = (c: readonly number[] | undefined): readonly number[] | null =>
    Array.isArray(c) && c.length >= n0 ? c : null;
  const thr = col(tr.throttle);
  const brk = col(tr.brake);
  const spd = col(tr.speedKph);
  if (!thr || !brk || !spd) return null;
  const lat = col(tr.latG);
  const tc = col(tr.tc);
  const abs = col(tr.abs);
  const out: Cols = { n: 0, d: [], t: [], throttle: [], brake: [], speed: [], latG: [], tc: [], abs: [] };
  let pd = -Infinity;
  let pt = -Infinity;
  for (let i = 0; i < n0; i += 1) {
    const d = tr.d[i]!;
    const t = tr.t[i]!;
    if (!fin(d) || !fin(t) || d < 0 || d > 1 || t < 0 || d <= pd || t < pt) continue;
    pd = d;
    pt = t;
    out.d.push(d);
    out.t.push(t);
    out.throttle.push(fin(thr[i]) ? thr[i]! : 0);
    out.brake.push(fin(brk[i]) ? brk[i]! : 0);
    out.speed.push(fin(spd[i]) ? spd[i]! : 0);
    out.latG.push(lat && fin(lat[i]) ? lat[i]! : 0);
    out.tc.push(tc && fin(tc[i]) ? tc[i]! : 0);
    out.abs.push(abs && fin(abs[i]) ? abs[i]! : 0);
  }
  out.n = out.d.length;
  return out.n >= 10 ? out : null;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r5 = (v: number): number => Math.round(v * 100000) / 100000;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/**
 * Spread that one odd lap cannot inflate: 1.4826 × the median absolute
 * deviation, which equals σ on normally-scattered laps. A habit is what the
 * driver usually does, and the lap they braked 80 m early behind a slower car
 * is not that. Falls back to σ when more than half the values coincide.
 */
export function robustSpread(xs: number[]): number | null {
  if (xs.length < 3) return xs.length === 2 ? stdev(xs) : null;
  const m = median(xs)!;
  const mad = median(xs.map((x) => Math.abs(x - m)))!;
  return mad > 0 ? 1.4826 * mad : stdev(xs);
}

/**
 * Lap-to-lap spread over several sessions: each session's {@link robustSpread}
 * (sessions with three values or more), weighted by its count. Falls back to
 * the spread of `all` when no session has three.
 */
export function pooledSpread(groups: number[][], all: number[]): number | null {
  let w = 0;
  let sum = 0;
  for (const g of groups) {
    if (g.length < 3) continue;
    const s = robustSpread(g);
    if (s === null) continue;
    sum += s * g.length;
    w += g.length;
  }
  return w > 0 ? sum / w : robustSpread(all);
}

/** First index with `d[i] >= x` (n when none). */
function lowerBound(d: number[], x: number): number {
  let lo = 0;
  let hi = d.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Time into the lap at fraction `d`, pinned to 0 and `lapSec` on the line (`practiceReview`'s rule). */
function timeAt(c: Cols, lapSec: number, d: number): number | null {
  if (d <= 0) return 0;
  if (d >= 1) return lapSec > 0 ? lapSec : null;
  const n = c.n;
  if (d < c.d[0]!) return c.d[0]! > 0 ? (c.t[0]! * d) / c.d[0]! : 0;
  if (d > c.d[n - 1]!) {
    const d0 = c.d[n - 1]!;
    const t0 = c.t[n - 1]!;
    if (!(lapSec > t0)) return null;
    return t0 + ((lapSec - t0) * (d - d0)) / (1 - d0);
  }
  const i = Math.max(1, lowerBound(c.d, d));
  const d0 = c.d[i - 1]!;
  const d1 = c.d[i]!;
  const t0 = c.t[i - 1]!;
  return d1 > d0 ? t0 + (c.t[i]! - t0) * ((d - d0) / (d1 - d0)) : t0;
}

/** A trace that covers the lap line to line (a few metres' slack either end). */
function coversLap(c: Cols): boolean {
  return c.d[0]! <= 0.02 && c.d[c.n - 1]! >= 0.98;
}

/** Interpolated crossing of `BRAKE_ON` between samples i-1 and i. */
function onsetD(c: Cols, i: number): number {
  const b0 = c.brake[i - 1]!;
  const b1 = c.brake[i]!;
  const f = b1 > b0 ? Math.min(1, Math.max(0, (BRAKE_ON - b0) / (b1 - b0))) : 1;
  return c.d[i - 1]! + (c.d[i]! - c.d[i - 1]!) * f;
}

/** Seconds and event count where `col >= AID_ON`. */
function aidUse(c: Cols, col: number[]): { sec: number; events: number } {
  let sec = 0;
  let events = 0;
  let lastOnT = -Infinity;
  let on = false;
  for (let i = 0; i < c.n; i += 1) {
    const active = col[i]! >= AID_ON;
    if (active) {
      if (!on && c.t[i]! - lastOnT > AID_MERGE_SEC) events += 1;
      lastOnT = c.t[i]!;
      if (i + 1 < c.n) {
        const dt = c.t[i + 1]! - c.t[i]!;
        if (dt > 0 && dt <= MAX_DT) sec += dt;
      }
    }
    on = active;
  }
  return { sec, events };
}

/**
 * The braking zone that starts at sample `i` (a rising edge through
 * BRAKE_ON): where the brake comes off, where the car turned in, how hard the
 * pedal went. `limitD` bounds the turn-in search (the corner's apex, or the
 * zone's own release + a margin on a whole-lap scan).
 */
function zoneFrom(c: Cols, i: number, L: number, limitD: number | null) {
  const startD = onsetD(c, i);
  let peak = 0;
  let j = i;
  for (; j < c.n && c.brake[j]! >= BRAKE_OFF; j += 1) peak = Math.max(peak, c.brake[j]!);
  const releaseD = j < c.n ? c.d[j]! : c.d[c.n - 1]!;
  // The corner's peak lateral load, from the onset to the apex (or a margin
  // past the release on a whole-lap scan); then walk back to where it began.
  const turnLimit = Math.max(limitD ?? 0, releaseD + 100 / L);
  let peakI = -1;
  for (let k = i; k < c.n && c.d[k]! <= turnLimit; k += 1) {
    if (peakI < 0 || Math.abs(c.latG[k]!) > Math.abs(c.latG[peakI]!)) peakI = k;
  }
  let turnD: number | null = null;
  if (peakI >= 0 && Math.abs(c.latG[peakI]!) >= 2 * TURN_IN_FLOOR_G) {
    const lim = Math.max(TURN_IN_FLOOR_G, TURN_IN_SHARE * Math.abs(c.latG[peakI]!));
    let k = peakI;
    while (k > i && Math.abs(c.latG[k - 1]!) > lim) k -= 1;
    turnD = c.d[k]!;
  }
  const trailM = turnD === null ? null : Math.max(0, (releaseD - turnD) * L);
  return { startD, releaseD, peak, end: j, turnD, trailM };
}

/**
 * Whole-lap features of one trace, or null when it lacks the channels. `L` is
 * the track length in metres (turns fractions into metres).
 */
export function extractLapFeatures(tr: CompletedTrace | null | undefined, L: number): LapFeatures | null {
  const c = columnsOf(tr);
  if (!c || !(L > 0)) return null;

  // Coasting and overlap in RUNS: a run shorter than MIN_RUN_SEC is the feet
  // crossing over and is not counted (see MIN_RUN_SEC).
  let total = 0;
  let coastSec = 0;
  let overlapSec = 0;
  let coastRun = 0;
  let overlapRun = 0;
  const flush = (): void => {
    if (coastRun >= MIN_RUN_SEC) coastSec += coastRun;
    if (overlapRun >= MIN_RUN_SEC) overlapSec += overlapRun;
  };
  for (let i = 0; i + 1 < c.n; i += 1) {
    const dt = c.t[i + 1]! - c.t[i]!;
    if (!(dt > 0) || dt > MAX_DT) {
      flush();
      coastRun = 0;
      overlapRun = 0;
      continue;
    }
    total += dt;
    const thr = c.throttle[i]!;
    const brk = c.brake[i]!;
    if (thr < THROTTLE_OFF && brk < BRAKE_OFF && c.speed[i]! >= COAST_MIN_KPH) coastRun += dt;
    else {
      if (coastRun >= MIN_RUN_SEC) coastSec += coastRun;
      coastRun = 0;
    }
    if (thr >= THROTTLE_ON && brk >= BRAKE_ON) overlapRun += dt;
    else {
      if (overlapRun >= MIN_RUN_SEC) overlapSec += overlapRun;
      overlapRun = 0;
    }
  }
  flush();

  // Braking zones: rising edges through BRAKE_ON, each followed to its release.
  let zones = 0;
  let turnZones = 0;
  let trailZones = 0;
  const trails: number[] = [];
  for (let i = 1; i < c.n; i += 1) {
    if (!(c.brake[i]! >= BRAKE_ON && c.brake[i - 1]! < BRAKE_ON)) continue;
    const z = zoneFrom(c, i, L, null);
    i = Math.max(i, z.end);
    if (z.peak < ZONE_MIN_PEAK) continue;
    zones += 1;
    if (z.trailM === null) continue;
    turnZones += 1;
    trails.push(z.trailM);
    if (z.trailM >= TRAIL_MIN_M) trailZones += 1;
  }
  const trailMed = median(trails);

  const aids = tr!.aids === 2;
  const tc = aids ? aidUse(c, c.tc) : null;
  const abs = aids ? aidUse(c, c.abs) : null;

  return {
    coastSec: r2(coastSec),
    coastPct: total > 0 ? r2((coastSec / total) * 100) : 0,
    overlapSec: r2(overlapSec),
    zones,
    turnZones,
    trailZones,
    trailM: trailMed === null ? null : r1(trailMed),
    aids,
    tcSec: tc ? r2(tc.sec) : null,
    tcEvents: tc ? tc.events : null,
    absSec: abs ? r2(abs.sec) : null,
    absEvents: abs ? abs.events : null,
  };
}

/**
 * One trace through each of `corners` (lap order). `lapSec` is the lap's
 * official time (pins the line, so the segments add up to the lap).
 */
export function extractCornerFeatures(
  tr: CompletedTrace | null | undefined,
  lapSec: number,
  L: number,
  corners: readonly HabitCorner[],
): CornerFeatures[] | null {
  const c = columnsOf(tr);
  if (!c || !(L > 0)) return null;
  const whole = coversLap(c);
  return corners.map((k, idx) => {
    const next = corners[idx + 1];
    const prev = corners[idx - 1];
    const endD = next ? next.entryD : 1;
    let segSec: number | null = null;
    if (whole && endD > k.entryD) {
      const a = timeAt(c, lapSec, k.entryD);
      const b = timeAt(c, lapSec, endD);
      if (a !== null && b !== null && b > a) segSec = r3(b - a);
    }

    // The braking point: the first rising edge after the search start; when
    // the brake is already on there, walk back to where that press began —
    // the lap that braked 120 m early is exactly the one to catch. Never back
    // past the previous corner's apex (that press was for that corner).
    const floorD = prev ? prev.apexD : 0;
    const fromD = Math.max(floorD, k.entryD - BRAKE_SEARCH_M / L);
    let brakeD: number | null = null;
    let trailM: number | null = null;
    let i = Math.max(1, lowerBound(c.d, fromD));
    if (i < c.n && c.brake[i - 1]! >= BRAKE_ON) {
      while (i > 1 && c.brake[i - 1]! >= BRAKE_ON && c.d[i - 1]! > floorD) i -= 1;
      if (c.brake[i - 1]! >= BRAKE_ON) i = -1; // on since before the floor: not this corner's press
    }
    if (i > 0) {
      for (; i < c.n && c.d[i]! <= k.apexD; i += 1) {
        if (c.brake[i]! >= BRAKE_ON && c.brake[i - 1]! < BRAKE_ON) {
          const z = zoneFrom(c, i, L, k.apexD);
          brakeD = r5(z.startD);
          trailM = z.trailM === null ? null : r1(z.trailM);
          break;
        }
      }
    }

    let minKph: number | null = null;
    for (let j = lowerBound(c.d, k.entryD); j < c.n && c.d[j]! <= k.exitD; j += 1) {
      if (minKph === null || c.speed[j]! < minKph) minKph = c.speed[j]!;
    }
    return { segSec, brakeD, minKph: minKph === null ? null : r1(minKph), trailM };
  });
}

/**
 * Identity of a corner set: cached per-corner features are valid only for
 * the corners they were cut with. Rounded so float noise in a re-built
 * catalogue does not throw the cache away.
 */
export function cornerKey(corners: readonly HabitCorner[], source: string): string {
  const body = corners.map((k) => `${k.id}:${k.entryD.toFixed(4)}:${k.apexD.toFixed(4)}:${k.exitD.toFixed(4)}`).join('|');
  return `${source}#${hash32(body)}`;
}

/** FNV-1a, 32-bit, hex: a stable short hash with no crypto dependency (pure module). */
export function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* -------------------------------------------------------------------------- */
/*  The report                                                                */
/* -------------------------------------------------------------------------- */

/** One lap as the report reads it. */
export interface HabitsLapInput {
  id: string | null;
  at: string;
  lapNo: number;
  lapSec: number;
  /** Clean and timed (the Practice Review's "valid"). */
  valid: boolean;
  /** Has a real time (clean or not). */
  timed: boolean;
  outLap: boolean;
  inLap: boolean;
  dirty: string[];
  /** Damp or wet surface. */
  wet: boolean;
  f: LapFeatures | null;
  /** Aligned with {@link HabitsInput.corners}; null when not cut (or out of the corner scope). */
  c: CornerFeatures[] | null;
}

export interface HabitsSessionInput {
  id: string;
  at: string;
  type: string;
  laps: HabitsLapInput[];
  /** From `stintReview` stats: best clean lap, mean of clean laps, their σ — seconds. */
  bestSec: number | null;
  avgSec: number | null;
  spreadSec: number | null;
  /** The Practice Review's session accuracy (0..100), when it is a practice session. */
  accuracy: number | null;
  /** Best lap as % of the reference pace (Ohne Speed), when the layout and class resolve. */
  refPct: number | null;
}

export interface HabitsInput {
  trackKey: string;
  carClass: string;
  track?: string;
  car?: string;
  trackLengthM: number;
  /** Oldest first. */
  sessions: HabitsSessionInput[];
  corners: HabitCorner[];
  cornerSource: 'catalog' | 'reference' | 'none';
  /** In reference mode: the one session per-corner habits cover. */
  cornerSessionId: string | null;
}

/** A whole-lap habit, as `HabitsReport.lap` holds it plus what the cards draw. */
export interface HabitLapItem {
  kind: string;
  value: number;
  unit: string;
  text: string;
  /** Short card title. */
  title: string;
  /** 'watch' = worth working on; 'good' = a strength; 'info' = neither. */
  level: 'watch' | 'info' | 'good';
  /** Per session, oldest first, aligned with `trend` (null = not measured there). */
  perSession: (number | null)[];
  factId: string;
}

/** Per corner, plus the evidence behind its habit sentence. */
export interface HabitCornerItem {
  id: string;
  laps: number;
  brakeSpreadM: number | null;
  minKphSpread: number | null;
  avgLossSec: number | null;
  habit: string | null;
  /** Which pattern the habit sentence names. */
  habitKind: 'brakeEarly' | 'lateNoSpeed' | 'slowMin' | 'brakeWanders' | null;
  factIds: string[];
}

/** What this module adds to the contract's HabitsReport (all optional for other readers). */
export interface HabitsReportExtras {
  version: number;
  track?: string;
  car?: string;
  trackLengthM?: number;
  cornerSource: 'catalog' | 'reference' | 'none';
  /** A sentence for the UI when per-corner habits are limited (reference fallback). */
  cornerNote: string | null;
  cornerSessionId: string | null;
  /** Laps that taught the habits (valid, dry, within the window, with a trace). */
  habitLaps: number;
  /** Cache key for the AI narrative: same numbers → same stored answer. */
  inputHash: string;
  /** Ready-made `CoachAiRequest.context`. */
  context: { track: string; car: string; carClass: string; targetLabel: string; lapSec: number | null; refSec: number | null };
}

export type HabitsReportFull = HabitsReport &
  HabitsReportExtras & {
    trend: (HabitsReport['trend'][number] & { type: string; laps: number; validLaps: number })[];
    corners: HabitCornerItem[];
    lap: HabitLapItem[];
  };

function fmtLap(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
}

const pct = (v: number): string => `${Math.round(v)}%`;

/**
 * Fold every session's laps into the habits report. Never throws on missing
 * data: no traces gives a trend with no habits, no corners gives no strip.
 */
export function buildHabitsReport(input: HabitsInput): HabitsReportFull {
  const L = input.trackLengthM > 0 ? input.trackLengthM : 0;
  const sessions = [...input.sessions].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const facts: CoachFact[] = [];
  const fact = (f: CoachFact): string => {
    facts.push(f);
    return f.id;
  };

  // The laps that teach habits, per session.
  const scoped = new Map<string, HabitsLapInput[]>();
  let lapsTotal = 0;
  for (const s of sessions) {
    lapsTotal += s.laps.length;
    const valid = s.laps.filter((l) => l.valid && !l.wet && l.lapSec > 0);
    const best = valid.length ? Math.min(...valid.map((l) => l.lapSec)) : 0;
    scoped.set(s.id, valid.filter((l) => l.lapSec <= best * HABIT_WINDOW));
  }
  const allScoped = sessions.flatMap((s) => scoped.get(s.id)!);

  /* ------------------------------ trend ----------------------------------- */

  const trend = sessions.map((s) => ({
    sessionId: s.id,
    at: s.at,
    type: s.type,
    laps: s.laps.length,
    validLaps: s.laps.filter((l) => l.valid).length,
    bestSec: s.bestSec === null ? null : r3(s.bestSec),
    avgSec: s.avgSec === null ? null : r3(s.avgSec),
    spreadSec: s.spreadSec === null ? null : r3(s.spreadSec),
    accuracy: s.accuracy === null ? null : Math.round(s.accuracy),
    refPct: s.refPct === null ? null : r1(s.refPct),
  }));

  const timedTrend = trend.filter((t) => t.bestSec !== null);
  const last = timedTrend[timedTrend.length - 1];
  const first = timedTrend[0];
  if (last && last.bestSec !== null) {
    fact({ id: 'trend.best', kind: 'bestLap', value: last.bestSec, unit: 's', text: `Best lap last session: ${fmtLap(last.bestSec)}.` });
    if (last.avgSec !== null) {
      fact({ id: 'trend.avg', kind: 'avgLap', value: last.avgSec, unit: 's', text: `Average clean lap last session: ${fmtLap(last.avgSec)}.` });
    }
    if (last.spreadSec !== null) {
      fact({ id: 'trend.spread', kind: 'consistency', value: last.spreadSec, unit: 's', text: `Lap times last session spread ±${last.spreadSec.toFixed(2)} s.` });
    }
    if (last.accuracy !== null) {
      fact({ id: 'trend.accuracy', kind: 'accuracy', value: last.accuracy, unit: 'pts', text: `Accuracy last session: ${last.accuracy} / 100.` });
    }
    if (last.refPct !== null) {
      fact({ id: 'trend.refPct', kind: 'refPct', value: last.refPct, unit: '%', text: `Best lap last session was ${last.refPct.toFixed(1)}% of the reference pace.` });
    }
    const bests = timedTrend.map((t) => t.bestSec!).filter(fin);
    const pb = Math.min(...bests);
    fact({ id: 'trend.pb', kind: 'personalBest', value: r3(pb), unit: 's', text: `Your best here in this class: ${fmtLap(pb)}.` });
    if (first && first !== last && first.bestSec !== null) {
      const moved = r3(last.bestSec - first.bestSec);
      fact({
        id: 'trend.bestMoved',
        kind: 'bestLapChange',
        value: moved,
        unit: 's',
        text: moved <= 0
          ? `Your session best is ${Math.abs(moved).toFixed(2)} s quicker than in your first session here.`
          : `Your last session's best was ${moved.toFixed(2)} s slower than your first session here.`,
      });
    }
    const acc = timedTrend.filter((t) => t.accuracy !== null);
    if (acc.length >= 2) {
      const d = acc[acc.length - 1]!.accuracy! - acc[0]!.accuracy!;
      fact({
        id: 'trend.accuracyMoved',
        kind: 'accuracyChange',
        value: d,
        unit: 'pts',
        text: `Accuracy is ${d >= 0 ? 'up' : 'down'} ${Math.abs(d)} points since your first scored session here.`,
      });
    }
  }

  /* ------------------------------ corners --------------------------------- */

  const cornerItems: HabitCornerItem[] = [];
  const cornerScope = input.cornerSource === 'catalog'
    ? allScoped
    : input.cornerSource === 'reference' && input.cornerSessionId
      ? scoped.get(input.cornerSessionId) || []
      : [];
  const cornerSessions = input.cornerSource === 'catalog'
    ? sessions
    : sessions.filter((s) => input.cornerSource === 'reference' && s.id === input.cornerSessionId);
  if (L > 0 && input.corners.length) {
    input.corners.forEach((k, idx) => {
      const rows = cornerScope
        .map((l) => (l.c && l.c.length === input.corners.length ? l.c[idx]! : null))
        .filter((r): r is CornerFeatures => !!r);
      const segs = rows.map((r) => r.segSec).filter(fin);
      const brakesM = rows.map((r) => r.brakeD).filter(fin).map((d) => d * L);
      const mins = rows.map((r) => r.minKph).filter(fin);
      const best = segs.length ? Math.min(...segs) : null;
      const avgLoss = best === null || segs.length < 2 ? null : mean(segs.map((s) => s - best));
      // Spread is LAP TO LAP: measured inside each session and pooled, so a
      // braking point the driver moved between sessions (learning) is not
      // read as one that wanders.
      const bySession = (pick: (r: CornerFeatures) => number | null, scale: number): number[][] =>
        cornerSessions.map((s) => (scoped.get(s.id) || [])
          .map((l) => (l.c && l.c.length === input.corners.length ? pick(l.c[idx]!) : null))
          .filter(fin)
          .map((v) => v * scale));
      const brakeSpread = brakesM.length >= 3 ? pooledSpread(bySession((r) => r.brakeD, L), brakesM) : null;
      const minSpread = mins.length >= 3 ? pooledSpread(bySession((r) => r.minKph, 1), mins) : null;
      const ids: string[] = [];
      const pre = `corner.${k.id}`;
      if (brakeSpread !== null) {
        ids.push(fact({ id: `${pre}.brakeSpread`, cornerId: k.id, kind: 'brakeSpreadM', value: r1(brakeSpread), unit: 'm', text: `Your braking point into ${k.id} varies by ±${Math.round(brakeSpread)} m lap to lap.` }));
      }
      if (minSpread !== null) {
        ids.push(fact({ id: `${pre}.minSpread`, cornerId: k.id, kind: 'minKphSpread', value: r1(minSpread), unit: 'kph', text: `Your minimum speed through ${k.id} varies by ±${minSpread.toFixed(1)} km/h.` }));
      }
      if (avgLoss !== null) {
        ids.push(fact({ id: `${pre}.loss`, cornerId: k.id, kind: 'cornerLoss', value: r3(avgLoss), unit: 's', text: `${k.id} costs you ${avgLoss.toFixed(2)} s a lap on average against your best pass through it.` }));
      }

      // The habit: compare every pass with the driver's QUICKEST passes
      // through this corner (the fastest quarter, at least two), not with a
      // single best pass that may have been the outlier.
      let habit: string | null = null;
      let habitKind: HabitCornerItem['habitKind'] = null;
      const timed = rows.filter((r) => fin(r.segSec));
      if (timed.length >= HABIT_MIN_LAPS) {
        const sorted = [...timed].sort((a, b) => a.segSec! - b.segSec!);
        const fast = sorted.slice(0, Math.max(2, Math.ceil(sorted.length / 4)));
        const rest = sorted.slice(fast.length);
        const fastBrake = median(fast.map((r) => r.brakeD).filter(fin));
        const fastMin = median(fast.map((r) => r.minKph).filter(fin));
        const n = rest.length;
        const cands: { kind: NonNullable<HabitCornerItem['habitKind']>; share: number; k: number; by: number; unit: 'm' | 'kph' }[] = [];
        if (n >= HABIT_MIN_LAPS - 1 && fastBrake !== null) {
          const early = rest.filter((r) => fin(r.brakeD) && (fastBrake - r.brakeD!) * L >= HABIT_BRAKE_M);
          if (early.length) cands.push({ kind: 'brakeEarly', share: early.length / n, k: early.length, by: mean(early.map((r) => (fastBrake - r.brakeD!) * L))!, unit: 'm' });
          if (fastMin !== null) {
            const over = rest.filter((r) => fin(r.brakeD) && fin(r.minKph) && (r.brakeD! - fastBrake) * L >= HABIT_BRAKE_M && fastMin - r.minKph! >= HABIT_MIN_KPH);
            if (over.length) cands.push({ kind: 'lateNoSpeed', share: over.length / n, k: over.length, by: mean(over.map((r) => (r.brakeD! - fastBrake) * L))!, unit: 'm' });
          }
        }
        if (n >= HABIT_MIN_LAPS - 1 && fastMin !== null) {
          const slow = rest.filter((r) => fin(r.minKph) && fastMin - r.minKph! >= HABIT_MIN_KPH);
          if (slow.length) cands.push({ kind: 'slowMin', share: slow.length / n, k: slow.length, by: mean(slow.map((r) => fastMin - r.minKph!))!, unit: 'kph' });
        }
        // A pattern that names the cause (braking early; braking late and
        // paying for it) outranks plain "slower through the corner" — the
        // quickest passes are quicker partly BY being faster at the apex, so
        // that one is the least telling. Then the clearest (highest share).
        const order = { lateNoSpeed: 0, brakeEarly: 1, slowMin: 2, brakeWanders: 3 } as const;
        const pick = cands
          .filter((c) => c.share >= HABIT_SHARE)
          .sort((a, b) => order[a.kind] - order[b.kind] || b.share - a.share)[0];
        if (pick) {
          habitKind = pick.kind;
          const of = `on ${pick.k} of ${n} laps`;
          habit = pick.kind === 'brakeEarly'
            ? `Brakes early into ${k.id} ${of} — about ${Math.round(pick.by)} m before your quickest passes.`
            : pick.kind === 'lateNoSpeed'
              ? `Brakes later into ${k.id} than your quickest passes but carries less speed through it ${of} — the late braking isn't paying.`
              : `Carries about ${Math.round(pick.by)} km/h less through ${k.id} than your quickest passes ${of}.`;
          ids.push(fact({ id: `${pre}.habit`, cornerId: k.id, kind: `habit.${pick.kind}`, value: r1(pick.by), unit: pick.unit, text: habit }));
        } else if (brakeSpread !== null && brakeSpread >= WANDER_M) {
          habitKind = 'brakeWanders';
          habit = `Your braking point into ${k.id} wanders ±${Math.round(brakeSpread)} m lap to lap — pick a marker and brake on it.`;
          ids.push(fact({ id: `${pre}.habit`, cornerId: k.id, kind: 'habit.brakeWanders', value: r1(brakeSpread), unit: 'm', text: habit }));
        }
      }

      cornerItems.push({
        id: k.id,
        laps: rows.length,
        brakeSpreadM: brakeSpread === null ? null : r1(brakeSpread),
        minKphSpread: minSpread === null ? null : r1(minSpread),
        avgLossSec: avgLoss === null ? null : r3(avgLoss),
        habit,
        habitKind,
        factIds: ids,
      });
    });
  }

  /* ------------------------------ lap habits ------------------------------ */

  const lap: HabitLapItem[] = [];
  const perSession = (pick: (l: HabitsLapInput) => number | null): (number | null)[] =>
    sessions.map((s) => {
      const v = (scoped.get(s.id) || []).map(pick).filter(fin);
      const m = mean(v);
      return m === null ? null : r2(m);
    });
  const withF = allScoped.filter((l) => l.f);
  const avgOf = (pick: (f: LapFeatures) => number | null): number | null =>
    mean(withF.map((l) => pick(l.f!)).filter(fin));

  if (withF.length) {
    const coast = avgOf((f) => f.coastPct)!;
    const coastSec = avgOf((f) => f.coastSec)!;
    const level = coast >= 4 ? 'watch' : coast <= 1.5 ? 'good' : 'info';
    const text = `You coast — neither pedal down at speed — for ${coast.toFixed(1)}% of a lap (${coastSec.toFixed(1)} s).` +
      (level === 'watch' ? ' Most of that is usually the lift before a corner: brake later or stay on the throttle longer.' : '');
    lap.push({
      kind: 'coastPct', value: r1(coast), unit: '%', title: 'Coasting', level, text,
      perSession: perSession((l) => (l.f ? l.f.coastPct : null)),
      factId: fact({ id: 'lap.coast', kind: 'coastPct', value: r1(coast), unit: '%', text }),
    });

    const overlap = avgOf((f) => f.overlapSec)!;
    const olevel = overlap >= 0.5 ? 'watch' : overlap <= 0.1 ? 'good' : 'info';
    const otext = `Brake and throttle overlap for ${overlap.toFixed(2)} s a lap.` +
      (olevel === 'watch' ? ' Unless you left-foot brake on purpose, that is the brakes fighting the engine.' : '');
    lap.push({
      kind: 'overlapSec', value: r2(overlap), unit: 's', title: 'Pedal overlap', level: olevel, text: otext,
      perSession: perSession((l) => (l.f ? l.f.overlapSec : null)),
      factId: fact({ id: 'lap.overlap', kind: 'overlapSec', value: r2(overlap), unit: 's', text: otext }),
    });

    const turnZones = withF.reduce((a, l) => a + l.f!.turnZones, 0);
    const trailZones = withF.reduce((a, l) => a + l.f!.trailZones, 0);
    if (turnZones >= 5) {
      const share = (trailZones / turnZones) * 100;
      const depth = median(withF.map((l) => l.f!.trailM).filter(fin));
      const tlevel = share < 35 ? 'watch' : share >= 60 ? 'good' : 'info';
      const ttext = `You keep the brake on past turn-in in ${pct(share)} of braking zones` +
        (depth !== null ? `, typically ${Math.round(depth)} m into the turn.` : '.') +
        (tlevel === 'watch' ? ' Mostly you are off the brake before turning — trailing it further helps the car rotate.' : '');
      lap.push({
        kind: 'trailShare', value: Math.round(share), unit: '%', title: 'Trail braking', level: tlevel, text: ttext,
        perSession: perSession((l) => (l.f && l.f.turnZones ? (l.f.trailZones / l.f.turnZones) * 100 : null)),
        factId: fact({ id: 'lap.trail', kind: 'trailShare', value: Math.round(share), unit: '%', text: ttext }),
      });
      if (depth !== null) fact({ id: 'lap.trailDepth', kind: 'trailDepthM', value: r1(depth), unit: 'm', text: `When you trail the brake, it stays on about ${Math.round(depth)} m past turn-in.` });
    }

    const aided = withF.filter((l) => l.f!.aids);
    if (aided.length >= 3) {
      const tcSec = mean(aided.map((l) => l.f!.tcSec).filter(fin));
      const tcEv = mean(aided.map((l) => l.f!.tcEvents).filter(fin));
      const lapAvg = mean(aided.map((l) => l.lapSec).filter((v) => v > 0)) || 0;
      // A car without TC (or with it off) reads zero: no card rather than "0 times a lap".
      if (tcSec !== null && tcEv !== null && tcEv >= 0.5) {
        const share = lapAvg > 0 ? (tcSec / lapAvg) * 100 : 0;
        const lv = share >= 5 ? 'watch' : share <= 1 ? 'good' : 'info';
        const t = `Traction control steps in about ${Math.round(tcEv)} times a lap, ${tcSec.toFixed(1)} s in all.` +
          (lv === 'watch' ? ' That is throttle the car cannot use — squeeze it on rather than stamping.' : '');
        lap.push({
          kind: 'tcSec', value: r1(tcSec), unit: 's', title: 'Traction control', level: lv, text: t,
          perSession: perSession((l) => (l.f && l.f.aids ? l.f.tcSec : null)),
          factId: fact({ id: 'lap.tc', kind: 'tcSec', value: r1(tcSec), unit: 's', text: t }),
        });
      }
      const absSec = mean(aided.map((l) => l.f!.absSec).filter(fin));
      const absEv = mean(aided.map((l) => l.f!.absEvents).filter(fin));
      if (absSec !== null && absEv !== null && absEv >= 0.5) {
        const share = lapAvg > 0 ? (absSec / lapAvg) * 100 : 0;
        // GT3 drivers brake INTO the ABS on purpose: this PC's GT3 laps sit
        // near 4% of the lap on it and are quick. Only far beyond that is it
        // a stab that locks the fronts rather than a driver using the system.
        const lv = share >= 8 ? 'watch' : 'info';
        const t = `ABS works about ${Math.round(absEv)} times a lap, ${absSec.toFixed(1)} s in all.` +
          (lv === 'watch' ? ' Ease the initial stab so the tyres keep turning.' : '');
        lap.push({
          kind: 'absSec', value: r1(absSec), unit: 's', title: 'ABS', level: lv, text: t,
          perSession: perSession((l) => (l.f && l.f.aids ? l.f.absSec : null)),
          factId: fact({ id: 'lap.abs', kind: 'absSec', value: r1(absSec), unit: 's', text: t }),
        });
      }
    }
  }

  // The learning curve: per session, flying laps until the first valid lap
  // within LEARN_WITHIN of that session's best. Needs three valid laps.
  const learnPer: (number | null)[] = sessions.map((s) => {
    const flying = s.laps.filter((l) => l.timed && !l.outLap && !l.inLap && l.lapSec > 0).sort((a, b) => a.lapNo - b.lapNo);
    const valid = flying.filter((l) => l.valid);
    if (valid.length < 3) return null;
    const best = Math.min(...valid.map((l) => l.lapSec));
    const idx = flying.findIndex((l) => l.valid && l.lapSec <= best * LEARN_WITHIN);
    return idx < 0 ? null : idx + 1;
  });
  const learnVals = learnPer.filter(fin);
  if (learnVals.length) {
    const med = median(learnVals)!;
    const lv = med >= 6 ? 'watch' : med <= 3 ? 'good' : 'info';
    const t = `It takes you ${Math.round(med)} lap${Math.round(med) === 1 ? '' : 's'} to get within 1% of your session best` +
      (learnVals.length > 1 ? ` (the middle of ${learnVals.length} sessions).` : '.') +
      (lv === 'watch' ? ' A set out-lap routine — brake markers first, then pace — gets you there sooner.' : '');
    lap.push({
      kind: 'learnLaps', value: Math.round(med), unit: 'laps', title: 'Getting up to speed', level: lv, text: t, perSession: learnPer,
      factId: fact({ id: 'lap.learn', kind: 'learnLaps', value: Math.round(med), unit: 'laps', text: t }),
    });
  }

  // Dirty laps: every flying lap, the dirty ones included — they are the point.
  const flyingAll = sessions.flatMap((s) => s.laps.filter((l) => l.timed && !l.outLap && !l.inLap));
  if (flyingAll.length >= 5) {
    const dirty = flyingAll.filter((l) => !l.valid);
    const limits = dirty.filter((l) => l.dirty.includes('limits')).length;
    const share = (dirty.length / flyingAll.length) * 100;
    const limShare = (limits / flyingAll.length) * 100;
    const lv = share >= 20 ? 'watch' : share <= 5 ? 'good' : 'info';
    const t = `${pct(share)} of your flying laps here were dirty` +
      (limits ? ` — ${pct(limShare)} for track limits.` : '.') +
      (lv === 'watch' ? ' A lap that does not count teaches nothing; give the kerbs back a metre.' : '');
    lap.push({
      kind: 'dirtyPct', value: Math.round(share), unit: '%', title: 'Dirty laps', level: lv, text: t,
      perSession: sessions.map((s) => {
        const f = s.laps.filter((l) => l.timed && !l.outLap && !l.inLap);
        return f.length ? Math.round((f.filter((l) => !l.valid).length / f.length) * 100) : null;
      }),
      factId: fact({ id: 'lap.dirty', kind: 'dirtyPct', value: Math.round(share), unit: '%', text: t }),
    });
    if (limits) fact({ id: 'lap.limits', kind: 'limitsPct', value: Math.round(limShare), unit: '%', text: `${pct(limShare)} of your flying laps here broke track limits.` });
  }

  // Worth working on first, then neutral, then strengths.
  const rank = { watch: 0, info: 1, good: 2 } as const;
  lap.sort((a, b) => rank[a.level] - rank[b.level]);

  const cornerNote = input.cornerSource === 'catalog'
    ? null
    : input.cornerSource === 'reference'
      ? 'This track has no corner catalogue yet, so corners are cut from your latest session’s best lap and the corner habits cover that session only.'
      : 'No traced lap here yet to cut corners from.';

  const lastBest = last && last.bestSec !== null ? last.bestSec : null;
  const context = {
    track: input.track || input.trackKey,
    car: input.car || '',
    carClass: input.carClass,
    targetLabel: 'your own laps across sessions',
    lapSec: lastBest,
    refSec: null,
  };
  const inputHash = hash32(JSON.stringify({ v: HABITS_VERSION, k: input.trackKey, c: input.carClass, f: facts.map((f) => [f.id, f.value]) }));

  return {
    version: HABITS_VERSION,
    trackKey: input.trackKey,
    carClass: input.carClass,
    track: input.track,
    car: input.car,
    trackLengthM: input.trackLengthM,
    sessions: sessions.length,
    laps: lapsTotal,
    habitLaps: withF.length,
    trend,
    corners: cornerItems,
    lap,
    facts,
    cornerSource: input.cornerSource,
    cornerNote,
    cornerSessionId: input.cornerSource === 'reference' ? input.cornerSessionId : null,
    inputHash,
    context,
  };
}
