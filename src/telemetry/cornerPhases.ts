/**
 * cornerPhases.ts — where things happened through each corner of one lap.
 * =============================================================================
 *
 * 2026-10-29, the driving coach (`coachContract.ts`). To say "you lose it in
 * the braking of C5" the coach needs, for every corner, the points that split
 * it into phases: where the brake went on and came off, where the car turned
 * in, the apex, where the throttle was picked up and where it was flat again.
 * This module finds those points on ONE lap, against the corner spans it is
 * given (the catalogue's, or the reference's own `findCorners`). `timeLoss.ts`
 * then reads the reference lap's points as the phase boundaries and times both
 * laps between them.
 *
 * ## The points, and what each one is measured from
 * - `brakeOnD`: the first braking zone (`brakePoints`, the Review tab's own
 *   detector, so the coach and the charts never disagree) that starts within
 *   {@link BRAKE_SEARCH_M} before the corner's entry and no later than its
 *   apex — the same window `cornerResult` scores braking points in. `null` for
 *   a kink taken without braking.
 * - `brakeOffD`: where that zone's pressure falls below `BRAKE_OFF` again,
 *   interpolated between samples.
 * - `turnInD`: the start of the curvature span (|κ| ≥ `MIN_CURVATURE`, a
 *   radius under 300 m) that the apex sits in, walking back from the apex
 *   across same-direction gaps shorter than `MERGE_GAP_M` (the dip between the
 *   two apexes of a long bend) — placed where, inside that span, curvature
 *   first reaches {@link TURN_IN_PEAK_SHARE} of the corner's peak, because the
 *   ±10 m smoothing starts the span 10–20 m before the wheel turns. Curvature comes from the driven line when the
 *   lap has one, else from the lateral acceleration ({@link headingFromLatG}).
 * - `apexD`: the speed minimum inside the corner, refined between samples by a
 *   parabola; for a corner taken flat (the minimum sits on the window's edge)
 *   the span's own apex.
 * - `fullThrottleD`: the first point from {@link PICKUP_BEFORE_APEX_M} before
 *   the apex where throttle stays ≥ `FULL_THROTTLE` for
 *   {@link PICKUP_SUSTAIN_M} — `accuracyScore`'s pick-up, unchanged.
 * - `pickupD`: where the throttle came back for good — the start of the
 *   continuous run above {@link THROTTLE_ON} that ends in full throttle. Between
 *   the two is the driver feeding the throttle in: the "exit" phase.
 * - Speeds: `entryKph` where braking began (or at the entry), `minKph` the
 *   corner's lowest, `exitKph` at the span's exit (the same distance on both
 *   laps, so they compare), `topKph` the highest on the run to the next
 *   corner's braking point.
 *
 * Every crossing is interpolated, so Le Mans's 13.6 m sample spacing does not
 * quantise a braking point to a sample.
 *
 * ## Curvature without a driven line
 * Laps recorded before trace v2 carry no `x`/`z`. Their heading can be dead
 * reckoned from the lateral acceleration: a car cornering at speed v with
 * lateral acceleration a turns at κ = a / v² radians per metre, so heading is
 * the running sum of `latG · g / v²` over distance. On the scoping pass this
 * found 96–100% of the line-based apexes at Road Atlanta, Le Mans, Fuji and
 * Monza (84% at Daytona, whose banking loads the car without turning it).
 * Below {@link LATG_MIN_SPEED_MS} speed is floored, or a pit-lane crawl reads as
 * a hairpin. The sign is LMU's: positive latG turns the same way as positive
 * `atan2(dz, dx)` on the line (checked on Road Atlanta, r = 0.99).
 *
 * Pure: columns in, numbers out. Tested in `scripts/test-cornerphases.js`.
 */

import { BRAKE_OFF, brakePoints, type BrakePoint } from './brakePoints';
import { BRAKE_SEARCH_M, FULL_THROTTLE, MERGE_GAP_M, MIN_CURVATURE } from './corners';
import type { PhasePoints } from './coachContract';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Throttle at or above this is "on" — the start of the pick-up. */
export const THROTTLE_ON = 0.1;
/** Metres of sustained full throttle that count as flat again (`accuracyScore`). */
export const PICKUP_SUSTAIN_M = 20;
/** How far before the apex full throttle may come (fast corners are flat before it), metres. */
export const PICKUP_BEFORE_APEX_M = 40;
/** Turn-in: where curvature reaches this share of the corner's peak (see `turnIn`). */
export const TURN_IN_PEAK_SHARE = 0.4;
/** How far either side of the apex the curvature at the apex is looked for, metres. */
const APEX_CURVE_SEARCH_M = 30;
/** Half-span over which heading and curvature are measured, metres (as `corners.ts`). */
const HEADING_HALF_SPAN_M = 10;
/** Speed floor for the latG heading, m/s: below it, a = v²κ divides by almost nothing. */
export const LATG_MIN_SPEED_MS = 8;
/** Standard gravity, m/s² per g. */
const G = 9.80665;

/* -------------------------------------------------------------------------- */
/*  Input                                                                     */
/* -------------------------------------------------------------------------- */

/** The columns this module reads. `LossLapInput.cols` and a stored trace both fit. */
export interface PhaseCols {
  d: readonly number[];
  t: readonly number[];
  speedKph: readonly number[];
  brake?: readonly number[];
  throttle?: readonly number[];
  latG?: readonly number[];
  x?: readonly number[];
  z?: readonly number[];
}

/** A corner span, lap fractions, `entryD < apexD < exitD`. */
export interface PhaseCorner {
  entryD: number;
  apexD: number;
  exitD: number;
}

/**
 * A lap made ready to measure: strictly increasing `d`, the lap clock anchored
 * at the line, curvature and braking zones found once. Built by
 * {@link prepareLap} and cached per columns object, so scoring forty laps
 * against one reference prepares the reference once.
 */
export interface PreparedLap {
  n: number;
  lengthM: number;
  d: number[];
  /** Seconds from the line: `t` re-based so the lap's clock reads 0 at d = 0. */
  t: number[];
  v: number[];
  brake: number[] | null;
  throttle: number[] | null;
  x: number[] | null;
  z: number[] | null;
  /** Signed curvature per sample, 1/m; null when the lap has neither a line nor latG. */
  kappa: number[] | null;
  curvatureFrom: 'line' | 'latG' | null;
  brakes: BrakePoint[];
  /** Lap clock at d = 1, extrapolated from the last sample at its own speed. */
  tEnd: number;
}

const cache = new WeakMap<object, PreparedLap>();

/**
 * Clean and index one lap. Samples whose `d` does not move forward, or whose
 * clock runs backwards, are dropped (as `cleanCols` does); a lap with fewer
 * than two left is null.
 *
 * The clock is extrapolated to both ends of the lap at the speed of the first
 * and last samples, so time at d = 0 is 0 and time at d = 1 is the trace's own
 * measure of the lap. Nothing here reads the official lap time: the trace
 * clock against timing is `LapLossBreakdown.residualSec`, shown, not hidden.
 */
export function prepareLap(cols: PhaseCols, lengthM: number): PreparedLap | null {
  if (!cols || !Array.isArray(cols.d) || !Array.isArray(cols.t) || !Array.isArray(cols.speedKph)) return null;
  const L = lengthM > 0 ? lengthM : 0;
  if (!(L > 0)) return null;
  const hit = cache.get(cols);
  if (hit && hit.lengthM === L) return hit;

  const n0 = Math.min(cols.d.length, cols.t.length, cols.speedKph.length);
  const keep: number[] = [];
  let pd = -Infinity;
  let pt = -Infinity;
  for (let i = 0; i < n0; i += 1) {
    const d = cols.d[i]!;
    const t = cols.t[i]!;
    if (!Number.isFinite(d) || !Number.isFinite(t) || d < 0 || d > 1) continue;
    if (d <= pd || t < pt) continue;
    keep.push(i);
    pd = d;
    pt = t;
  }
  const n = keep.length;
  if (n < 2) return null;
  const pick = (col: readonly number[] | undefined): number[] | null =>
    Array.isArray(col) && col.length >= n0 ? keep.map((i) => Number(col[i]) || 0) : null;

  const d = keep.map((i) => cols.d[i]!);
  const v = keep.map((i) => Math.max(0, Number(cols.speedKph[i]) || 0));
  const brake = pick(cols.brake);
  const throttle = pick(cols.throttle);
  const latG = pick(cols.latG);
  let x = pick(cols.x);
  let z = pick(cols.z);
  if (!x || !z) {
    x = null;
    z = null;
  }

  // Lap clock from the line: extrapolate to d = 0 at the first sample's speed.
  const ms = (kph: number): number => Math.max(1, kph / 3.6);
  const tStart = cols.t[keep[0]!]! - (d[0]! * L) / ms(v[0]!);
  const t = keep.map((i) => cols.t[i]! - tStart);
  const tEnd = t[n - 1]! + ((1 - d[n - 1]!) * L) / ms(v[n - 1]!);

  let kappa: number[] | null = null;
  let curvatureFrom: PreparedLap['curvatureFrom'] = null;
  if (x && z) {
    kappa = curvatureFromHeading(headingOfLine(x, z, d, L), d, L);
    curvatureFrom = 'line';
  } else if (latG) {
    kappa = curvatureFromHeading(headingOfLatG(latG, v, d, L), d, L);
    curvatureFrom = 'latG';
  }

  const brakes = brake ? brakePoints({ d, brake, x: x ?? undefined, z: z ?? undefined }, L) : [];
  const out: PreparedLap = { n, lengthM: L, d, t, v, brake, throttle, x, z, kappa, curvatureFrom, brakes, tEnd };
  cache.set(cols, out);
  return out;
}

/**
 * Seconds from the line to lap fraction `d` (clamped to 0..1), linearly
 * between samples. Past the first or last sample it runs to the extrapolated
 * ends of the lap, so `lapTimeAt(p, 1) − lapTimeAt(p, 0)` is the whole lap.
 */
export function lapTimeAt(p: PreparedLap, dd: number): number {
  const target = dd <= 0 ? 0 : dd >= 1 ? 1 : dd;
  const d = p.d;
  const n = p.n;
  if (target <= d[0]!) return d[0]! > 0 ? (p.t[0]! * target) / d[0]! : p.t[0]!;
  if (target >= d[n - 1]!) {
    const span = 1 - d[n - 1]!;
    return span > 0 ? p.t[n - 1]! + (p.tEnd - p.t[n - 1]!) * ((target - d[n - 1]!) / span) : p.tEnd;
  }
  const i = upper(d, target);
  const d0 = d[i - 1]!;
  const d1 = d[i]!;
  const f = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
  return p.t[i - 1]! + (p.t[i]! - p.t[i - 1]!) * f;
}

/** A column of a prepared lap read at lap fraction `d`, linearly; null outside the lap. */
export function colAtD(p: PreparedLap, col: readonly number[] | null, dd: number): number | null {
  if (!col) return null;
  const d = p.d;
  if (dd < d[0]! || dd > d[p.n - 1]!) {
    // A point a metre or two past the end samples reads the end sample.
    const slack = 5 / p.lengthM;
    if (dd >= d[0]! - slack && dd < d[0]!) return col[0]!;
    if (dd <= d[p.n - 1]! + slack && dd > d[p.n - 1]!) return col[p.n - 1]!;
    return null;
  }
  const i = upper(d, dd);
  const d0 = d[i - 1]!;
  const d1 = d[i]!;
  const f = d1 > d0 ? (dd - d0) / (d1 - d0) : 0;
  return col[i - 1]! + (col[i]! - col[i - 1]!) * f;
}

/* -------------------------------------------------------------------------- */
/*  Heading and curvature                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Heading per sample, radians (unwrapped), dead reckoned from lateral
 * acceleration — for laps without a driven line. See the file header.
 * The catalogue builder uses this too: it is the one implementation.
 *
 * @param cols - `d` (lap fractions), `speedKph` and `latG` (in g).
 * @returns One heading per input sample; empty when a column is missing.
 */
export function headingFromLatG(
  cols: { d: readonly number[]; speedKph: readonly number[]; latG?: readonly number[] },
  lengthM: number,
): number[] {
  if (!cols || !Array.isArray(cols.d) || !Array.isArray(cols.speedKph) || !Array.isArray(cols.latG)) return [];
  if (!(lengthM > 0)) return [];
  const n = Math.min(cols.d.length, cols.speedKph.length, cols.latG.length);
  return headingOfLatG(cols.latG.slice(0, n), cols.speedKph.slice(0, n), cols.d.slice(0, n), lengthM);
}

function headingOfLatG(latG: readonly number[], kph: readonly number[], d: readonly number[], L: number): number[] {
  const n = Math.min(latG.length, kph.length, d.length);
  const th = new Array<number>(n);
  if (n === 0) return th;
  th[0] = 0;
  const k = (i: number): number => {
    const v = Math.max(LATG_MIN_SPEED_MS, (Number(kph[i]) || 0) / 3.6);
    return ((Number(latG[i]) || 0) * G) / (v * v);
  };
  for (let i = 1; i < n; i += 1) {
    const ds = Math.max(0, (d[i]! - d[i - 1]!) * L);
    th[i] = th[i - 1]! + 0.5 * (k(i - 1) + k(i)) * ds; // trapezium
  }
  return th;
}

/**
 * Heading of the driven line per sample, measured across
 * ±{@link HEADING_HALF_SPAN_M} as `corners.ts` does, so the line's 10 cm
 * quantisation and a carried-forward position do not read as a kink.
 */
function headingOfLine(x: readonly number[], z: readonly number[], d: readonly number[], L: number): number[] {
  const n = d.length;
  const k = halfSpan(d, L);
  const th = new Array<number>(n);
  let prev = NaN;
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - k);
    const b = Math.min(n - 1, i + k);
    const dx = x[b]! - x[a]!;
    const dz = z[b]! - z[a]!;
    if (Math.hypot(dx, dz) < 1 && Number.isFinite(prev)) {
      th[i] = prev;
      continue;
    }
    let h = Math.atan2(dz, dx);
    if (Number.isFinite(prev)) {
      while (h - prev > Math.PI) h -= 2 * Math.PI;
      while (h - prev < -Math.PI) h += 2 * Math.PI;
    }
    th[i] = h;
    prev = h;
  }
  // Leading samples before the first usable span take its heading.
  const first = th.findIndex((h) => Number.isFinite(h));
  for (let i = 0; i < first; i += 1) th[i] = th[first]!;
  if (first < 0) th.fill(0);
  return th;
}

/** Signed curvature per sample from a heading, 1/m, over ±{@link HEADING_HALF_SPAN_M}. */
function curvatureFromHeading(th: readonly number[], d: readonly number[], L: number): number[] {
  const n = d.length;
  const k = halfSpan(d, L);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - k);
    const b = Math.min(n - 1, i + k);
    const ds = (d[b]! - d[a]!) * L;
    out[i] = ds > 0 ? (th[b]! - th[a]!) / ds : 0;
  }
  return out;
}

function halfSpan(d: readonly number[], L: number): number {
  const n = d.length;
  const step = n > 1 ? ((d[n - 1]! - d[0]!) * L) / (n - 1) : 1;
  return Math.max(1, Math.round(HEADING_HALF_SPAN_M / Math.max(step, 1e-6)));
}

/**
 * Signed curvature of a lap per sample (1/m), from its line when it has one,
 * else from latG; null with neither. Positive turns the way `atan2(dz, dx)`
 * increases.
 */
export function curvatureOf(cols: PhaseCols, lengthM: number): { kappa: number[]; d: number[]; source: 'line' | 'latG' } | null {
  const p = prepareLap(cols, lengthM);
  if (!p || !p.kappa || !p.curvatureFrom) return null;
  return { kappa: p.kappa, d: p.d, source: p.curvatureFrom };
}

/* -------------------------------------------------------------------------- */
/*  Phase points                                                              */
/* -------------------------------------------------------------------------- */

/** All-null points, for a corner a lap does not cover. */
export function emptyPhasePoints(): PhasePoints {
  return {
    brakeOnD: null,
    brakeOffD: null,
    turnInD: null,
    apexD: null,
    pickupD: null,
    fullThrottleD: null,
    entryKph: null,
    minKph: null,
    exitKph: null,
    topKph: null,
  };
}

/**
 * The phase points of every corner on one lap. `corners` must be in lap order
 * and not overlap (`findCorners` and the catalogue both give that; `lapLoss`
 * sorts by apex first); the result is index-aligned with it.
 * Each corner's searches stay between its neighbours' apexes, so a chicane's
 * two halves never claim each other's braking or throttle.
 */
export function phasePoints(cols: PhaseCols, corners: readonly PhaseCorner[], lengthM: number): PhasePoints[] {
  const p = prepareLap(cols, lengthM);
  if (!p) return corners.map(() => emptyPhasePoints());
  return phasePointsOf(p, corners);
}

/** {@link phasePoints} on a lap already prepared. */
export function phasePointsOf(p: PreparedLap, corners: readonly PhaseCorner[]): PhasePoints[] {
  const L = p.lengthM;
  const out: PhasePoints[] = corners.map(() => emptyPhasePoints());
  // First the points that bound each other: brake onset per corner, so a
  // corner's straight can end where the next one's braking begins.
  const brakeOn = corners.map((c, k) => {
    const lo = Math.max(k > 0 ? corners[k - 1]!.apexD : 0, c.entryD - BRAKE_SEARCH_M / L);
    const bp = p.brakes.find((b) => b.d >= lo && b.d <= c.apexD);
    return bp ?? null;
  });

  for (let k = 0; k < corners.length; k += 1) {
    const c = corners[k]!;
    const next = k + 1 < corners.length ? corners[k + 1]! : null;
    const prevApex = k > 0 ? corners[k - 1]!.apexD : 0;
    const pt = out[k]!;
    if (c.exitD < p.d[0]! || c.entryD > p.d[p.n - 1]!) continue; // not covered

    // Braking.
    const bp = brakeOn[k];
    if (bp) {
      pt.brakeOnD = bp.d;
      pt.brakeOffD = brakeRelease(p, bp.i, next ? next.apexD : 1);
    }

    // Apex: the speed minimum inside the span, or the span's own for a flat one.
    const ap = speedMin(p, c.entryD, c.exitD);
    pt.apexD = ap && !ap.onEdge ? ap.d : c.apexD;
    pt.minKph = ap ? round1(ap.kph) : null;

    // Turn-in, from curvature.
    if (p.kappa) {
      const lo = Math.max(prevApex, c.entryD - BRAKE_SEARCH_M / L);
      pt.turnInD = turnIn(p, pt.apexD, lo);
    }

    // Throttle: flat again, then where the pick-up that led to it began.
    if (p.throttle) {
      const from = Math.max(c.entryD, c.apexD - PICKUP_BEFORE_APEX_M / L);
      let to = next ? next.entryD : 1;
      if (next && !(to > from)) to = next.apexD;
      const full = fullThrottle(p, from, to);
      const floor = Math.max(prevApex, pt.brakeOffD ?? pt.brakeOnD ?? c.entryD);
      if (full) {
        pt.fullThrottleD = full.d;
        pt.pickupD = pickupBefore(p, full.i, full.d, floor);
      } else {
        pt.pickupD = firstThrottleOn(p, Math.max(floor, from), to);
      }
    }

    // Speeds.
    const entryKph = colAtD(p, p.v, pt.brakeOnD ?? c.entryD);
    pt.entryKph = entryKph === null ? null : round1(entryKph);
    const exitKph = colAtD(p, p.v, c.exitD);
    pt.exitKph = exitKph === null ? null : round1(exitKph);
    const runTo = next ? (brakeOn[k + 1]?.d ?? next.entryD) : 1;
    const top = maxSpeed(p, c.exitD, Math.max(c.exitD, runTo));
    pt.topKph = top === null ? null : round1(top);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Point finders                                                             */
/* -------------------------------------------------------------------------- */

/** Where the zone that began at sample `i` falls below BRAKE_OFF, interpolated; null if not before `limitD`. */
function brakeRelease(p: PreparedLap, i: number, limitD: number): number | null {
  const b = p.brake!;
  for (let j = Math.max(1, i); j < p.n; j += 1) {
    if (p.d[j]! > limitD) return null;
    if ((b[j] || 0) < BRAKE_OFF) {
      const b0 = b[j - 1] || 0;
      const b1 = b[j] || 0;
      const f = b0 > b1 ? clamp01((b0 - BRAKE_OFF) / (b0 - b1)) : 1;
      return p.d[j - 1]! + (p.d[j]! - p.d[j - 1]!) * f;
    }
  }
  return null;
}

/**
 * The lowest speed within `[from, to]`, parabola-refined; `onEdge` when the
 * lowest sample is the first or last inside the window (the car was still
 * slowing, or already accelerating, all the way through: no apex by speed).
 */
function speedMin(p: PreparedLap, from: number, to: number): { d: number; kph: number; onEdge: boolean } | null {
  const a = Math.max(0, upper(p.d, from) - 1);
  let m = -1;
  let first = -1;
  let last = -1;
  for (let i = a; i < p.n; i += 1) {
    const d = p.d[i]!;
    if (d < from) continue;
    if (d > to) break;
    if (first < 0) first = i;
    last = i;
    if (m < 0 || p.v[i]! < p.v[m]!) m = i;
  }
  if (m < 0) return null;
  const onEdge = m === first || m === last;
  if (m > 0 && m < p.n - 1) {
    const y0 = p.v[m - 1]!;
    const y1 = p.v[m]!;
    const y2 = p.v[m + 1]!;
    const den = y0 - 2 * y1 + y2;
    if (den > 0) {
      const off = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
      const dd = off >= 0 ? p.d[m]! + (p.d[m + 1]! - p.d[m]!) * off : p.d[m]! + (p.d[m]! - p.d[m - 1]!) * off;
      return { d: dd, kph: y1 - 0.25 * (y0 - y2) * off, onEdge };
    }
  }
  return { d: p.d[m]!, kph: p.v[m]!, onEdge };
}

/**
 * The start of the turning that contains the apex. The direction is the sign
 * of the summed curvature within {@link APEX_CURVE_SEARCH_M} of the apex; the
 * walk starts at the turning sample nearest the apex (preferring one at or
 * before it) and goes back across same-direction gaps shorter than
 * `MERGE_GAP_M`, never below `loD`. The threshold crossing is interpolated.
 */
function turnIn(p: PreparedLap, apexD: number, loD: number): number | null {
  const kap = p.kappa!;
  const L = p.lengthM;
  const win = APEX_CURVE_SEARCH_M / L;
  let sum = 0;
  for (let i = Math.max(0, upper(p.d, apexD - win) - 1); i < p.n; i += 1) {
    const d = p.d[i]!;
    if (d < apexD - win) continue;
    if (d > apexD + win) break;
    sum += kap[i]!;
  }
  const sign = Math.sign(sum);
  if (sign === 0) return null;
  const turning = (i: number): boolean => kap[i]! * sign >= MIN_CURVATURE;

  // The turning sample nearest the apex, at or before it first.
  const ai = Math.min(p.n - 1, Math.max(0, upper(p.d, apexD) - 1));
  let start = -1;
  for (let i = ai; i >= 0 && p.d[i]! >= apexD - win; i -= 1) {
    if (turning(i)) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    for (let i = ai + 1; i < p.n && p.d[i]! <= apexD + win; i += 1) {
      if (turning(i)) {
        start = i;
        break;
      }
    }
  }
  if (start < 0) return null;

  // Walk back through the turning, bridging short same-direction gaps.
  let first = start;
  for (let i = start - 1; i >= 0; i -= 1) {
    if (p.d[i]! < loD) break;
    if (turning(i)) {
      first = i;
      continue;
    }
    if (kap[i]! * sign < 0 && Math.abs(kap[i]!) >= MIN_CURVATURE) break; // turning the other way
    if ((p.d[first]! - p.d[i]!) * L >= MERGE_GAP_M) break;
  }
  // Within the span, the turn-in is where the curvature reaches a share of
  // its peak: measured over ±10 m, curvature starts rising 10–20 m before the
  // wheel turns, and the bare 1/300 threshold put a hairpin's turn-in 14 m
  // early. At {@link TURN_IN_PEAK_SHARE} of the peak an abrupt arc reads
  // within 2–3 m of where it starts.
  let peak = 0;
  for (let i = first; i < p.n && p.d[i]! <= apexD + win; i += 1) peak = Math.max(peak, kap[i]! * sign);
  const thr = Math.max(MIN_CURVATURE, TURN_IN_PEAK_SHARE * peak);
  let at = first;
  while (at < p.n - 1 && kap[at]! * sign < thr && p.d[at]! < apexD) at += 1;
  if (at === 0) return p.d[0]!;
  const k0 = kap[at - 1]! * sign;
  const k1 = kap[at]! * sign;
  const f = k1 > k0 ? clamp01((thr - k0) / (k1 - k0)) : 1;
  const d = p.d[at - 1]! + (p.d[at]! - p.d[at - 1]!) * f;
  return Math.min(apexD, Math.max(d, Math.min(loD, p.d[at]!)));
}

/**
 * The first point at or past `from` from which throttle stays ≥ FULL_THROTTLE
 * for {@link PICKUP_SUSTAIN_M}, before `to`. If the car is already flat when
 * the window opens, that is `from` itself. The rising crossing is
 * interpolated. Null when the throttle never holds flat in the window.
 */
function fullThrottle(p: PreparedLap, from: number, to: number): { d: number; i: number } | null {
  const thr = p.throttle!;
  const sustain = PICKUP_SUSTAIN_M / p.lengthM;
  let startD: number | null = null;
  let startI = -1;
  for (let i = upper(p.d, from) - 1; i < p.n; i += 1) {
    if (i < 0) continue;
    const d = p.d[i]!;
    if (d < from) continue;
    if (d > to) break;
    if ((thr[i] || 0) >= FULL_THROTTLE) {
      if (startD === null) {
        startI = i;
        const t0 = i > 0 ? thr[i - 1] || 0 : 0;
        if (i > 0 && t0 >= FULL_THROTTLE) startD = from;
        else if (i > 0) {
          const f = clamp01((FULL_THROTTLE - t0) / ((thr[i] || 0) - t0));
          startD = Math.max(from, p.d[i - 1]! + (d - p.d[i - 1]!) * f);
        } else startD = d;
      }
      if (d - startD >= sustain) return { d: startD, i: startI };
    } else {
      startD = null;
    }
  }
  return null;
}

/**
 * Walking back from the first full-throttle sample, the start of the
 * continuous run at or above {@link THROTTLE_ON} that led to it, never below
 * `floorD`. Interpolated at the crossing.
 */
function pickupBefore(p: PreparedLap, fullI: number, fullD: number, floorD: number): number {
  const thr = p.throttle!;
  let i = fullI;
  while (i > 0 && (thr[i - 1] || 0) >= THROTTLE_ON && p.d[i - 1]! >= floorD) i -= 1;
  let d: number;
  if (i > 0 && (thr[i - 1] || 0) < THROTTLE_ON) {
    const t0 = thr[i - 1] || 0;
    const t1 = thr[i] || 0;
    const f = t1 > t0 ? clamp01((THROTTLE_ON - t0) / (t1 - t0)) : 1;
    d = p.d[i - 1]! + (p.d[i]! - p.d[i - 1]!) * f;
  } else {
    d = p.d[i]!;
  }
  return Math.min(fullD, Math.max(floorD, d));
}

/** The first rising crossing of {@link THROTTLE_ON} within `[from, to]`, or null. */
function firstThrottleOn(p: PreparedLap, from: number, to: number): number | null {
  const thr = p.throttle!;
  for (let i = Math.max(1, upper(p.d, from)); i < p.n; i += 1) {
    if (p.d[i]! > to) break;
    if ((thr[i] || 0) >= THROTTLE_ON) {
      const t0 = thr[i - 1] || 0;
      if (t0 >= THROTTLE_ON) return Math.max(from, p.d[i - 1]!);
      const f = clamp01((THROTTLE_ON - t0) / ((thr[i] || 0) - t0));
      return Math.max(from, p.d[i - 1]! + (p.d[i]! - p.d[i - 1]!) * f);
    }
  }
  return null;
}

/** Highest speed within `[from, to]`, including the interpolated ends; null when not covered. */
function maxSpeed(p: PreparedLap, from: number, to: number): number | null {
  let m = -Infinity;
  for (const end of [from, to]) {
    const v = colAtD(p, p.v, end);
    if (v !== null) m = Math.max(m, v);
  }
  for (let i = Math.max(0, upper(p.d, from) - 1); i < p.n; i += 1) {
    const d = p.d[i]!;
    if (d < from) continue;
    if (d > to) break;
    if (p.v[i]! > m) m = p.v[i]!;
  }
  return Number.isFinite(m) ? m : null;
}

/* -------------------------------------------------------------------------- */
/*  Small numerics                                                            */
/* -------------------------------------------------------------------------- */

/** Index of the first sample at or past `d`, 1..n-1 (the right end of the straddling pair). */
function upper(col: readonly number[], d: number): number {
  let lo = 1;
  let hi = col.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (col[mid]! >= d) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 1;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
