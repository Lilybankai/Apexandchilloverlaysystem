/**
 * accuracyScore.ts — how closely a lap copied its target, 0..100.
 * =============================================================================
 *
 * Phase 3 of docs/PRACTICE-REVIEW-PLAN.md; the reasoning, the formulas and the
 * calibration that chose every constant below are in docs/ACCURACY-SCORE.md.
 *
 * Each corner of the target is measured four ways, each an ERROR against the
 * target turned into points by one published curve, `100 · exp(−error)`, with
 * the error already divided by its scale:
 *
 *   braking   where the brake went on, and where it came off
 *   throttle  where full throttle was picked up again, and how much of the
 *             straight that follows was spent flat
 *   line      the mean distance from the target's driven line, entry → exit
 *   speed     minimum speed through the corner — ONE-SIDED: carrying more
 *             speed than the target is not an error
 *
 * A part that cannot be measured — no driven line on either lap, no braking
 * zone in a flat corner, no full-throttle point before the next corner — is
 * `null` and drops out of the weighting. It is never scored 0 or 100.
 *
 * A corner's total is the weighted mean of its non-null parts
 * ({@link SCORING.weights}); a lap's is the mean of its corners' totals
 * weighted by the time the TARGET spends in each, so a hairpin counts for
 * more than a kink. `pointsToGain` is how far the lap total would rise if that
 * one corner scored 100; over every scored corner they add up to 100 − total.
 *
 * Pure: columns in, numbers out. `scripts/calibrate-accuracy.js` drives
 * {@link cornerErrors} over this machine's laps; `scripts/test-accuracyscore.js`
 * pins the behaviour.
 */

import { cornerResult, BRAKE_SEARCH_M, FULL_THROTTLE, type LapColumns } from './corners';
import { brakePoints, BRAKE_OFF } from './brakePoints';
import type { PracticeColumns } from './practiceReview';

/* -------------------------------------------------------------------------- */
/*  The constants — chosen by scripts/calibrate-accuracy.js                   */
/* -------------------------------------------------------------------------- */

/**
 * Every scale and weight in the score. Scales are in the error's own unit:
 * an error of one scale costs a part 63% of its points (100 → 37).
 * See docs/ACCURACY-SCORE.md for how each was chosen.
 */
export const SCORING = {
  // Calibrated 2026-10-08 on 50 sessions / 654 laps (repeated holdout, five
  // 70/30 splits): mean held-out lap agreement 0.76, against 0.67 for the
  // hand-picked starting values. docs/ACCURACY-SCORE.md has the table.
  scales: {
    /**
     * Braking point, metres, counted from the end of {@link SCORING.brakeOnGraceM}.
     * Softened 2026-10-08 at Carl's request: at 10 m with no grace, braking
     * 20 m off a quicker driver's point read 13/100 — honest, but a number that
     * discourages. Now 20 m off reads about 55 and 50 m off about 17.
     */
    brakeOnM: 25,
    /** Brake release point, metres. Loose: release predicts little on its own. */
    brakeOffM: 90,
    /** Full-throttle pick-up point, metres (late counts fully, early half). */
    pickupM: 90,
    /** Share of the following straight NOT spent flat that the target was, percentage points. */
    flatPts: 35,
    /** Mean distance from the target's line, metres. */
    lineM: 4,
    /** Minimum speed BELOW the target's, km/h. */
    apexKph: 25,
  },
  /** Metres off the target's braking point that cost nothing: within a car length or so, nobody can tell. */
  brakeOnGraceM: 5,
  /** How much each part counts towards a corner's total. */
  weights: {
    braking: 0.5,
    throttle: 1,
    line: 0.5,
    speed: 3,
  },
};

export type ScoringConstants = typeof SCORING;

/** Metres of sustained full throttle that count as "picked up". */
const PICKUP_SUSTAIN_M = 20;
/** How far before the apex a pick-up may come (fast corners are flat before it), metres. */
const PICKUP_BEFORE_APEX_M = 40;
/** A following straight shorter than this is not judged for time spent flat, metres. */
const MIN_STRAIGHT_M = 50;
/** Early pick-up costs this share of what a late one does. */
const EARLY_PICKUP_SHARE = 0.5;
/** Metres of the reference line searched either side of the matching distance. */
const LINE_WINDOW_M = 40;
/** Spacing of the samples taken through a corner for the line, metres. */
const LINE_STEP_M = 2;

/* -------------------------------------------------------------------------- */
/*  The contract (docs/PRACTICE-REVIEW-PLAN.md)                               */
/* -------------------------------------------------------------------------- */

/** Integers 0..100. `total` is the weighted mean of the non-null parts. */
export interface AccuracyScore {
  total: number;
  braking: number | null;
  throttle: number | null;
  line: number | null;
  speed: number | null;
}

/** A corner's measured errors, in their own units, before any scale. */
export interface CornerErrors {
  /** |braking point − target's|, metres; null when neither braked here. */
  brakeOnM: number | null;
  /** |release point − target's|, metres; null when either has no release. */
  brakeOffM: number | null;
  /** Pick-up point − target's, metres; positive = LATER. */
  pickupM: number | null;
  /** Points of the following straight not spent flat that the target was; ≥ 0. */
  flatPts: number | null;
  /** Mean distance from the target's line, metres. */
  lineM: number | null;
  /** Minimum speed, you − target, km/h; positive = faster. */
  apexKph: number | null;
  /** Time the TARGET spends between entry and exit, seconds — the corner's weight in the lap. */
  refSec: number | null;
  /** Time through the corner, you − target; for calibration. */
  deltaSec: number | null;
}

export interface Corner3 {
  entryD: number;
  apexD: number;
  exitD: number;
}

/* -------------------------------------------------------------------------- */
/*  Column helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Index of the first sample at or past `d` (1..n-1). */
function upper(c: { d: readonly number[] }, d: number): number {
  let lo = 1;
  let hi = c.d.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c.d[mid]! >= d) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** A column read at lap fraction `d`, linearly; null outside the trace or without the column. */
export function colAt(c: PracticeColumns, col: readonly number[] | undefined, d: number): number | null {
  if (!col || c.d.length < 2) return null;
  const n = c.d.length;
  if (d < c.d[0]! || d > c.d[n - 1]!) return null;
  const i = upper(c, d);
  const d0 = c.d[i - 1]!;
  const d1 = c.d[i]!;
  const f = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
  return col[i - 1]! + (col[i]! - col[i - 1]!) * f;
}

/** Lowest speed between two fractions, including the interpolated ends. */
export function minSpeed(c: PracticeColumns, from: number, to: number): number | null {
  if (!c.speedKph) return null;
  let m = Infinity;
  for (const end of [from, to]) {
    const v = colAt(c, c.speedKph, end);
    if (v !== null) m = Math.min(m, v);
  }
  for (let i = 0; i < c.d.length; i += 1) {
    const d = c.d[i]!;
    if (d >= from && d <= to) m = Math.min(m, c.speedKph[i]!);
  }
  return Number.isFinite(m) ? m : null;
}

/** Distance from point p to segment ab, in the x/z plane. */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const len2 = vx * vx + vz * vz;
  let f = len2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
  if (f < 0) f = 0;
  else if (f > 1) f = 1;
  const dx = px - (ax + vx * f);
  const dz = pz - (az + vz * f);
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * How far the lap ran from the reference's line through a corner, on average.
 * Each sample point on the lap (every {@link LINE_STEP_M} from entry to exit)
 * is measured to the nearest segment of the reference line within
 * {@link LINE_WINDOW_M} of the same distance — never the whole lap, or a
 * point on one side of a hairpin could match the other side.
 */
export function lineOffset(
  lap: PracticeColumns,
  ref: PracticeColumns,
  entryD: number,
  exitD: number,
  lengthM: number,
): number | null {
  if (!lap.x || !lap.z || !ref.x || !ref.z || !(lengthM > 0) || !(exitD > entryD)) return null;
  const step = LINE_STEP_M / lengthM;
  const win = LINE_WINDOW_M / lengthM;
  let sum = 0;
  let n = 0;
  for (let d = entryD; d <= exitD + 1e-12; d += step) {
    const px = colAt(lap, lap.x, d);
    const pz = colAt(lap, lap.z, d);
    if (px === null || pz === null) continue;
    const a = Math.max(1, upper(ref, d - win));
    const b = Math.min(ref.d.length - 1, upper(ref, d + win));
    let best = Infinity;
    for (let i = a; i <= b; i += 1) {
      best = Math.min(best, segDist(px, pz, ref.x[i - 1]!, ref.z[i - 1]!, ref.x[i]!, ref.z[i]!));
    }
    if (Number.isFinite(best)) {
      sum += best;
      n += 1;
    }
  }
  return n > 0 ? Math.round((sum / n) * 100) / 100 : null;
}

/** The braking zone for a corner: onset and release (lap fractions), or null. */
function brakeZone(c: PracticeColumns, corner: Corner3, L: number): { on: number; off: number | null } | null {
  if (!c.brake) return null;
  const from = corner.entryD - BRAKE_SEARCH_M / L;
  const bp = brakePoints(c as LapColumns, L).find((p) => p.d >= from && p.d <= corner.apexD);
  if (!bp) return null;
  let off: number | null = null;
  for (let i = bp.i; i < c.d.length; i += 1) {
    if ((c.brake[i] || 0) < BRAKE_OFF) {
      // Interpolate the crossing between i-1 and i.
      const b0 = c.brake[i - 1] || 0;
      const b1 = c.brake[i] || 0;
      const f = b0 > b1 ? Math.min(1, Math.max(0, (b0 - BRAKE_OFF) / (b0 - b1))) : 1;
      off = c.d[i - 1]! + (c.d[i]! - c.d[i - 1]!) * f;
      break;
    }
  }
  return { on: bp.d, off };
}

/**
 * Where full throttle was picked up again after a corner: the first point at
 * or past `from` from which throttle stays ≥ {@link FULL_THROTTLE} for
 * {@link PICKUP_SUSTAIN_M}, before `to`. Null when it never is.
 */
function pickupPoint(c: PracticeColumns, from: number, to: number, L: number): number | null {
  if (!c.throttle) return null;
  const sustain = PICKUP_SUSTAIN_M / L;
  let start: number | null = null;
  for (let i = 0; i < c.d.length; i += 1) {
    const d = c.d[i]!;
    if (d < from) continue;
    if (d > to) break;
    if ((c.throttle[i] || 0) >= FULL_THROTTLE) {
      if (start === null) start = d;
      if (d - start >= sustain) return start;
    } else {
      start = null;
    }
  }
  return null;
}

/** Share of `[from, to]` spent at full throttle, 0..1, by distance. */
function flatShare(c: PracticeColumns, from: number, to: number): number | null {
  if (!c.throttle || !(to > from)) return null;
  let flat = 0;
  let all = 0;
  for (let i = 1; i < c.d.length; i += 1) {
    const a = Math.max(from, c.d[i - 1]!);
    const b = Math.min(to, c.d[i]!);
    if (b <= a) continue;
    const w = b - a;
    all += w;
    if ((c.throttle[i - 1] || 0) >= FULL_THROTTLE && (c.throttle[i] || 0) >= FULL_THROTTLE) flat += w;
  }
  return all > 0 ? flat / all : null;
}

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The raw errors for corner `i` of `corners` (the target's, in lap order), the
 * lap against the reference. `nextEntryD` bounds the throttle measurements:
 * the next corner's entry, or the line after the last corner.
 */
export function cornerErrors(
  lap: PracticeColumns,
  ref: PracticeColumns,
  corners: readonly Corner3[],
  i: number,
  lengthM: number,
): CornerErrors {
  const L = lengthM > 0 ? lengthM : 1;
  const c = corners[i]!;
  const next = i + 1 < corners.length ? corners[i + 1]!.entryD : 1;
  const r = cornerResult(c, ref as LapColumns, lap as LapColumns, L);

  // Braking: onset from the shared scorer, release measured here. A corner
  // the target braked for and the lap did not (or the other way round) is a
  // braking error of a full search window: one of the two is wrong.
  const zl = brakeZone(lap, c, L);
  const zr = brakeZone(ref, c, L);
  let brakeOnM: number | null = null;
  let brakeOffM: number | null = null;
  if (zl && zr) {
    brakeOnM = Math.abs(r.brakeDeltaM !== null ? r.brakeDeltaM : (zl.on - zr.on) * L);
    if (zl.off !== null && zr.off !== null) brakeOffM = Math.abs(zl.off - zr.off) * L;
  } else if (zl || zr) {
    if (lap.brake && ref.brake) brakeOnM = BRAKE_SEARCH_M;
  }

  // Throttle: pick-up after the corner, then time flat on the straight.
  const pickFrom = Math.max(c.entryD, c.apexD - PICKUP_BEFORE_APEX_M / L);
  const pl = pickupPoint(lap, pickFrom, next, L);
  const pr = pickupPoint(ref, pickFrom, next, L);
  let pickupM: number | null = null;
  if (pr !== null) pickupM = ((pl !== null ? pl : next) - pr) * L;
  let flatPts: number | null = null;
  if ((next - c.exitD) * L >= MIN_STRAIGHT_M) {
    const fl = flatShare(lap, c.exitD, next);
    const fr = flatShare(ref, c.exitD, next);
    if (fl !== null && fr !== null) flatPts = Math.max(0, fr - fl) * 100;
  }

  const lineM = lineOffset(lap, ref, c.entryD, c.exitD, L);

  const minL = minSpeed(lap, c.entryD, c.exitD);
  const minR = minSpeed(ref, c.entryD, c.exitD);
  const apexKph = minL !== null && minR !== null ? minL - minR : null;

  const tIn = colAt(ref, ref.t, c.entryD);
  const tOut = colAt(ref, ref.t, c.exitD);
  const refSec = tIn !== null && tOut !== null && tOut > tIn ? tOut - tIn : null;

  return { brakeOnM, brakeOffM, pickupM, flatPts, lineM, apexKph, refSec, deltaSec: r.deltaSec };
}

/* -------------------------------------------------------------------------- */
/*  Points                                                                    */
/* -------------------------------------------------------------------------- */

const pts = (e: number): number => 100 * Math.exp(-Math.max(0, e));

/** Mean of a part's normalised errors, or null when none were measured. */
function part(terms: (number | null)[]): number | null {
  const got = terms.filter((t): t is number => t !== null && Number.isFinite(t));
  if (!got.length) return null;
  return pts(got.reduce((a, b) => a + b, 0));
}

/**
 * A corner's errors as points. Unrounded, so the lap total is not built from
 * rounded pieces; {@link roundScore} rounds for the contract.
 */
export function scoreCorner(e: CornerErrors, k: ScoringConstants = SCORING): AccuracyScore | null {
  const s = k.scales;
  const braking = part([
    e.brakeOnM === null ? null : Math.max(0, e.brakeOnM - k.brakeOnGraceM) / s.brakeOnM,
    e.brakeOnM === null || e.brakeOffM === null ? null : e.brakeOffM / s.brakeOffM,
  ]);
  const pick =
    e.pickupM === null ? null : (e.pickupM > 0 ? e.pickupM : -e.pickupM * EARLY_PICKUP_SHARE) / s.pickupM;
  const throttle = part([pick, e.flatPts === null ? null : e.flatPts / s.flatPts]);
  const line = e.lineM === null ? null : pts(e.lineM / s.lineM);
  const speed = e.apexKph === null ? null : pts(Math.max(0, -e.apexKph) / s.apexKph);

  const w = k.weights;
  let sum = 0;
  let wt = 0;
  for (const [v, wi] of [
    [braking, w.braking],
    [throttle, w.throttle],
    [line, w.line],
    [speed, w.speed],
  ] as [number | null, number][]) {
    if (v === null || !(wi > 0)) continue;
    sum += v * wi;
    wt += wi;
  }
  if (wt <= 0) return null;
  return { total: sum / wt, braking, throttle, line, speed };
}

/** The contract's integers. */
export function roundScore(s: AccuracyScore | null): AccuracyScore | null {
  if (!s) return null;
  const r = (v: number | null): number | null => (v === null ? null : Math.round(v));
  return { total: Math.round(s.total), braking: r(s.braking), throttle: r(s.throttle), line: r(s.line), speed: r(s.speed) };
}

export interface LapScore {
  /** The lap's score (rounded), or null when no corner could be scored. */
  score: AccuracyScore | null;
  /** Per corner of the target, rounded; null where it could not be scored. */
  corners: (AccuracyScore | null)[];
  /** Per corner: how far the lap total would rise if this corner scored 100. */
  pointsToGain: number[];
}

/**
 * Score a whole lap: every corner, then the lap — corners weighted by the time
 * the target spends in them, each part averaged the same way over the corners
 * where it was measured.
 */
export function scoreLap(
  lap: PracticeColumns,
  ref: PracticeColumns,
  corners: readonly Corner3[],
  lengthM: number,
  k: ScoringConstants = SCORING,
): LapScore {
  const raw = corners.map((_c, i) => {
    const e = cornerErrors(lap, ref, corners, i, lengthM);
    return { e, s: scoreCorner(e, k) };
  });
  return lapFromCorners(raw, k);
}

/** The lap-level fold, split out so calibration can reuse precomputed errors. */
export function lapFromCorners(
  raw: { e: CornerErrors; s: AccuracyScore | null }[],
  _k: ScoringConstants = SCORING,
): LapScore {
  const weightOf = (e: CornerErrors): number => (e.refSec !== null && e.refSec > 0 ? e.refSec : 1);
  let wt = 0;
  let tot = 0;
  const parts: Record<'braking' | 'throttle' | 'line' | 'speed', { s: number; w: number }> = {
    braking: { s: 0, w: 0 },
    throttle: { s: 0, w: 0 },
    line: { s: 0, w: 0 },
    speed: { s: 0, w: 0 },
  };
  for (const { e, s } of raw) {
    if (!s) continue;
    const w = weightOf(e);
    wt += w;
    tot += s.total * w;
    for (const key of Object.keys(parts) as (keyof typeof parts)[]) {
      const v = s[key];
      if (v === null) continue;
      parts[key].s += v * w;
      parts[key].w += w;
    }
  }
  const pointsToGain = raw.map(({ e, s }) =>
    s && wt > 0 ? Math.round(((100 - s.total) * weightOf(e) / wt) * 10) / 10 : 0,
  );
  const score: AccuracyScore | null =
    wt > 0
      ? {
          total: tot / wt,
          braking: parts.braking.w > 0 ? parts.braking.s / parts.braking.w : null,
          throttle: parts.throttle.w > 0 ? parts.throttle.s / parts.throttle.w : null,
          line: parts.line.w > 0 ? parts.line.s / parts.line.w : null,
          speed: parts.speed.w > 0 ? parts.speed.s / parts.speed.w : null,
        }
      : null;
  return { score: roundScore(score), corners: raw.map(({ s }) => roundScore(s)), pointsToGain };
}
