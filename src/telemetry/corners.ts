/**
 * corners.ts — cutting a lap into corners, and scoring a live lap corner by
 * corner against it.
 * -----------------------------------------------------------------------------
 * Nothing else in the app knows where the corners are. The track map learns a
 * centreline, the Review tab finds braking points, and the micro-sectors are
 * equal slices of distance — none of which can say "you lost a tenth through
 * Turn 7". This module answers it from a single stored trace, so it works on
 * any circuit a driver has lapped, with no per-track table to maintain.
 *
 * ## Two ways to find a corner, and why the line wins
 * The obvious signal is speed: a corner is where the car slows down. On real
 * traces that finds only the corners that cost speed — Road Atlanta in an LMP2
 * gives five or six, because the esses, Turn 4 and Turn 11 are taken without
 * losing 12 km/h, yet those are exactly the corners where a driver lifts or
 * runs wide. The driven LINE (trace v2, `x`/`z`) has the geometry itself: a
 * corner is a stretch where the heading turns. Cutting on curvature gives ten
 * at Road Atlanta in both GT3 and LMP2 — the same ten — which is the count a
 * driver would give.
 *
 * So, when the line is present, corners are curvature regions that turn at
 * least {@link MIN_TURN_DEG}; a speed dip on a straight (a lift for traffic, a
 * tow) is not one, which is the "confirm with heading" check the plan asked
 * for. A direction change always separates two corners — a chicane is two —
 * while two same-direction bends within {@link MERGE_GAP_M} are one (a double
 * apex). Laps recorded before the line shipped fall back to speed minima with
 * a minimum drop and spacing, which is coarser but honest.
 *
 * ## Where a corner starts and ends
 * - Apex: the speed minimum inside the corner, refined between samples by a
 *   parabola so it is not quantised to the trace's ~5 m (14 m at Le Mans)
 *   spacing. A corner taken flat has no interior minimum; its apex is the
 *   point by which half its turning is done instead.
 * - Entry: the braking point that opened it; else the speed peak before the
 *   apex when the car genuinely slowed (a lift); else, for a flat corner, the
 *   turn-in where curvature began.
 * - Exit: the throttle back above {@link FULL_THROTTLE}; else the next speed
 *   peak. Never past the next corner's entry, so corners never overlap and a
 *   time split across them adds up.
 *
 * Pure and dependency-free apart from the braking-point detector. Tested on
 * real traces in `scripts/test-corners.js`.
 */

import { brakePoints } from './brakePoints';

/** Minimum heading change, degrees, for a curvature region to be a corner. */
export const MIN_TURN_DEG = 25;
/** Curvature at or above which the road is "turning": radius under 300 m. */
export const MIN_CURVATURE = 1 / 300;
/** Same-direction curvature regions closer than this are one corner. */
export const MERGE_GAP_M = 30;
/** Half-span, metres, over which heading is measured. */
const HEADING_HALF_SPAN_M = 10;
/** Speed-only fallback: the drop from the previous peak that makes a corner. */
export const MIN_SPEED_DROP_KPH = 12;
/** Speed-only fallback: apexes closer than this are one corner. */
export const MIN_APEX_GAP_M = 80;
/** Throttle at or above this is "back on it" — the corner's exit. */
export const FULL_THROTTLE = 0.9;
/**
 * A braking point counts as a corner's entry if it falls after the speed peak
 * before the apex, less this much. Brake onset and the speed peak are the same
 * event seen through two channels that lag each other by a sample or so.
 */
const BRAKE_BEFORE_PEAK_M = 30;
/** How far either side of a curvature region the apex search may look. */
const APEX_SEARCH_M = 30;

/** The columns segmentation reads. A stored trace and `/ghost.json` both fit. */
export interface CornerTrace {
  d: readonly number[];
  speedKph: readonly number[];
  brake?: readonly number[];
  throttle?: readonly number[];
  x?: readonly number[];
  z?: readonly number[];
}

/** One corner of a reference lap. */
export interface Corner {
  /** Lap fractions 0..1, `entryD < apexD < exitD`. */
  entryD: number;
  apexD: number;
  exitD: number;
  /** World position of the apex, metres; `null` when the lap has no line. */
  apexX: number | null;
  apexZ: number | null;
  /** Speed at the apex, km/h. */
  minKph: number;
  /** The braking point that opened the corner, or `null` for a lift or flat corner. */
  brakeD: number | null;
  /** Heading change through the corner, degrees; `null` when found by speed alone. */
  turnDeg: number | null;
  /** Sample indices of entry, apex (nearest) and exit into the source trace. */
  entryI: number;
  apexI: number;
  exitI: number;
}

/**
 * The corners of one lap, in lap order. Empty when the trace has no speed
 * channel or is too short to say anything.
 *
 * @param lengthM - Track length; turns the lap-fraction axis into metres.
 */
export function findCorners(tr: CornerTrace | null | undefined, lengthM: number): Corner[] {
  if (!tr || !Array.isArray(tr.d) || !Array.isArray(tr.speedKph) || !(lengthM > 0)) return [];
  const n = Math.min(tr.d.length, tr.speedKph.length);
  if (n < 5) return [];
  const s = new Array<number>(n);
  for (let i = 0; i < n; i += 1) s[i] = tr.d[i]! * lengthM;

  const lined =
    Array.isArray(tr.x) && Array.isArray(tr.z) && tr.x.length >= n && tr.z.length >= n;
  const spans = lined
    ? curvatureSpans(tr.x!, tr.z!, s, n)
    : speedSpans(tr.speedKph, s, n);
  if (spans.length === 0) return [];

  // Apexes first: entries and exits are both bounded by the neighbouring
  // corners' apexes, so every apex has to be known before either is placed.
  const apexes = spans.map((sp, k) => {
    const lo = k > 0 ? spans[k - 1]!.b + 1 : 0;
    const hi = k + 1 < spans.length ? spans[k + 1]!.a - 1 : n - 1;
    return apexOf(tr.speedKph, sp, s, lo, hi);
  });
  const brakes = brakePoints(tr, lengthM);

  const corners: Corner[] = [];
  for (let k = 0; k < spans.length; k += 1) {
    const sp = spans[k]!;
    const ap = apexes[k]!;
    const prevApexI = k > 0 ? apexes[k - 1]!.i : 0;
    const entry = entryOf(tr, sp, ap.i, prevApexI, s, brakes);
    corners.push({
      entryD: entry.d,
      apexD: interpAt(tr.d, ap.f),
      exitD: 0, // placed below, once the next corner's entry is known
      apexX: lined ? round2(interpAt(tr.x!, ap.f)) : null,
      apexZ: lined ? round2(interpAt(tr.z!, ap.f)) : null,
      minKph: round1(ap.kph),
      brakeD: entry.brakeD,
      turnDeg: sp.turnDeg === null ? null : Math.round(sp.turnDeg),
      entryI: entry.i,
      apexI: ap.i,
      exitI: 0,
    });
  }
  for (let k = 0; k < corners.length; k += 1) {
    const c = corners[k]!;
    const capI = k + 1 < corners.length ? corners[k + 1]!.entryI : n - 1;
    const nextApexI = k + 1 < corners.length ? corners[k + 1]!.apexI : n - 1;
    c.exitI = exitOf(tr, spans[k]!, c.entryI, c.apexI, capI, nextApexI);
    c.exitD = tr.d[c.exitI]!;
  }
  // A corner squeezed to nothing by its neighbours says nothing a driver can
  // use; it is dropped rather than shown as a zero-length window.
  return corners.filter((c) => c.entryD < c.apexD && c.apexD < c.exitD);
}

/* ------------------------ live scoring against corners -------------------- */

/**
 * A lap as distance-indexed columns — the shape of a stored trace and of
 * `/ghost.json`, and the shape a live buffer should be kept in. `d` must be
 * strictly increasing (a live buffer should drop backward samples, as
 * `ghostLap.cleanTrace` does).
 */
export interface LapColumns {
  d: readonly number[];
  t: readonly number[];
  brake?: readonly number[];
  speedKph?: readonly number[];
}

/** How a live lap went through one reference corner. Every field may be `null`. */
export interface CornerResult {
  /**
   * Time lost through the corner, seconds: the gap to the reference at the
   * exit minus the gap at the entry. Positive = slower, the same sign as
   * `paceDelta`'s Delta T. `null` when either lap does not cover the corner.
   */
  deltaSec: number | null;
  /**
   * Braking point difference, metres. Positive = braked LATER than the
   * reference — the same sign as the Review tab's `laterM`. `null` when either
   * lap did not brake for this corner.
   */
  brakeDeltaM: number | null;
  /** Apex (minimum) speed difference, km/h. Positive = carried more speed. */
  apexKphDelta: number | null;
}

/** How far before a corner's entry to look for a braking point, metres. */
const BRAKE_SEARCH_M = 100;

/**
 * Score a live lap through one corner against the reference lap the corners
 * were cut from.
 *
 * Both laps are measured the same way over the same window — the reference's
 * apex speed is re-read from its samples rather than taken from
 * {@link Corner.minKph}, whose between-samples refinement the live side does
 * not have — so a lap compared with itself scores exactly zero.
 */
export function cornerResult(
  corner: Pick<Corner, 'entryD' | 'apexD' | 'exitD'>,
  ref: LapColumns,
  live: LapColumns,
  lengthM: number,
): CornerResult {
  const L = lengthM > 0 ? lengthM : 1;

  let deltaSec: number | null = null;
  const tRefIn = timeAt(ref, corner.entryD);
  const tRefOut = timeAt(ref, corner.exitD);
  const tLiveIn = timeAt(live, corner.entryD);
  const tLiveOut = timeAt(live, corner.exitD);
  if (tRefIn !== null && tRefOut !== null && tLiveIn !== null && tLiveOut !== null) {
    deltaSec = round4(tLiveOut - tLiveIn - (tRefOut - tRefIn));
  }

  let brakeDeltaM: number | null = null;
  const from = corner.entryD - BRAKE_SEARCH_M / L;
  const refBrake = firstBrakeIn(ref, from, corner.apexD, L);
  const liveBrake = firstBrakeIn(live, from, corner.apexD, L);
  if (refBrake !== null && liveBrake !== null) brakeDeltaM = round2((liveBrake - refBrake) * L);

  let apexKphDelta: number | null = null;
  const refMin = minSpeedIn(ref, corner.entryD, corner.exitD);
  const liveMin = minSpeedIn(live, corner.entryD, corner.exitD);
  if (refMin !== null && liveMin !== null) apexKphDelta = round1(liveMin - refMin);

  return { deltaSec, brakeDeltaM, apexKphDelta };
}

/** Index of the corner containing lap fraction `d` (entry to exit), or -1. */
export function cornerAt(corners: readonly Pick<Corner, 'entryD' | 'exitD'>[], d: number): number {
  for (let k = 0; k < corners.length; k += 1) {
    const c = corners[k]!;
    if (d >= c.entryD && d <= c.exitD) return k;
  }
  return -1;
}

/**
 * Corners whose exit was crossed moving from `fromD` to `toD` — the moment a
 * corner card can be scored. Handles the start/finish wrap (`toD < fromD`).
 */
export function cornersExited(
  corners: readonly Pick<Corner, 'exitD'>[],
  fromD: number,
  toD: number,
): number[] {
  const out: number[] = [];
  const wrapped = toD < fromD;
  for (let k = 0; k < corners.length; k += 1) {
    const x = corners[k]!.exitD;
    if (wrapped ? x > fromD || x <= toD : x > fromD && x <= toD) out.push(k);
  }
  return out;
}

/* -------------------------------- internals ------------------------------- */

/** A stretch of road that is one corner, as sample indices `a..b` inclusive. */
interface Span {
  a: number;
  b: number;
  /** Heading change, degrees; `null` for a span found by speed alone. */
  turnDeg: number | null;
  /**
   * Where a corner taken flat has its apex: by curvature, the sample by which
   * half the turning is done; by speed, the trough.
   */
  tightI: number;
}

/**
 * Curvature regions of the driven line that turn at least
 * {@link MIN_TURN_DEG}. Heading is measured across ±{@link HEADING_HALF_SPAN_M}
 * so the line's 10 cm quantisation and the odd carried-forward position do
 * not read as a kink.
 */
function curvatureSpans(
  x: readonly number[],
  z: readonly number[],
  s: number[],
  n: number,
): Span[] {
  const step = (s[n - 1]! - s[0]!) / (n - 1);
  const k = Math.max(1, Math.round(HEADING_HALF_SPAN_M / Math.max(step, 1e-6)));

  // Unwrapped heading per sample. A span shorter than a metre has no
  // direction (a dropped field read repeats the last position), so it keeps
  // the previous heading rather than snapping to atan2(0, 0).
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
  if (!Number.isFinite(th[0]!)) return [];

  const kap = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - k);
    const b = Math.min(n - 1, i + k);
    const ds = s[b]! - s[a]!;
    kap[i] = ds > 0 ? (th[b]! - th[a]!) / ds : 0;
  }

  // Runs of one sign above the threshold, then same-sign runs a short gap
  // apart joined — the curvature of a long bend dips between its two apexes.
  const runs: { sign: number; a: number; b: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    const sign = Math.abs(kap[i]!) >= MIN_CURVATURE ? Math.sign(kap[i]!) : 0;
    const last = runs[runs.length - 1];
    if (sign === 0) continue;
    if (last && last.sign === sign && (last.b === i - 1 || s[i]! - s[last.b]! < MERGE_GAP_M)) {
      last.b = i;
    } else {
      runs.push({ sign, a: i, b: i });
    }
  }

  const out: Span[] = [];
  for (const r of runs) {
    const turnDeg = (Math.abs(th[r.b]! - th[r.a]!) * 180) / Math.PI;
    if (turnDeg < MIN_TURN_DEG) continue;
    // Half the turning done, rather than the single tightest sample: on a
    // constant-radius bend every sample is "tightest" to within noise, and the
    // first one would put the apex at the turn-in.
    const half = Math.abs(th[r.b]! - th[r.a]!) / 2;
    let tightI = r.a;
    while (tightI < r.b && Math.abs(th[tightI]! - th[r.a]!) < half) tightI += 1;
    out.push({ a: r.a, b: r.b, turnDeg, tightI });
  }
  return out;
}

/**
 * The speed-only fallback: troughs that fall at least
 * {@link MIN_SPEED_DROP_KPH} below the peak before them and are climbed out of
 * by as much (a zig-zag filter, so noise smaller than that is ignored), with
 * apexes closer than {@link MIN_APEX_GAP_M} joined.
 */
function speedSpans(v: readonly number[], s: number[], n: number): Span[] {
  const troughs: { p: number; m: number }[] = [];
  let peak = 0;
  let min = -1;
  let falling = false;
  for (let i = 1; i < n; i += 1) {
    const vi = v[i]!;
    if (!falling) {
      if (vi >= v[peak]!) peak = i;
      else if (v[peak]! - vi >= MIN_SPEED_DROP_KPH) {
        falling = true;
        min = i;
      }
    } else if (vi <= v[min]!) {
      min = i;
    } else if (vi - v[min]! >= MIN_SPEED_DROP_KPH) {
      troughs.push({ p: peak, m: min });
      falling = false;
      peak = i;
    }
  }
  // A lap that ends still slowing (a corner on the line) keeps its last trough.
  if (falling && min > 0) troughs.push({ p: peak, m: min });

  const out: Span[] = [];
  for (const t of troughs) {
    const last = out[out.length - 1];
    if (last && s[t.m]! - s[last.tightI]! < MIN_APEX_GAP_M) {
      // One corner with two dips: keep the slower apex, widen to cover both.
      if (v[t.m]! < v[last.tightI]!) last.tightI = t.m;
      last.b = t.m;
      continue;
    }
    out.push({ a: t.p, b: t.m, turnDeg: null, tightI: t.m });
  }
  return out;
}

/**
 * The apex of a span: nearest index, fractional index, and speed there. The
 * search may widen past the span by {@link APEX_SEARCH_M} but never into the
 * neighbouring spans (`lo..hi`) — the slower half of a chicane would otherwise
 * claim the other half's apex.
 */
function apexOf(
  v: readonly number[],
  sp: Span,
  s: number[],
  lo: number,
  hi: number,
): { i: number; f: number; kph: number } {
  const n = v.length;
  let a = sp.a;
  let b = sp.b;
  if (sp.turnDeg !== null) {
    while (a > lo && s[sp.a]! - s[a - 1]! <= APEX_SEARCH_M) a -= 1;
    while (b < hi && s[b + 1]! - s[sp.b]! <= APEX_SEARCH_M) b += 1;
  }
  let m = a;
  for (let i = a; i <= b; i += 1) if (v[i]! < v[m]!) m = i;
  // A minimum on the window's edge is not a minimum of the corner — the car
  // was still accelerating, or still slowing, through all of it. That is a
  // corner taken flat (or nearly), and its apex is half way round the turn.
  if (sp.turnDeg !== null && (m === a || m === b)) {
    return { i: sp.tightI, f: sp.tightI, kph: v[sp.tightI]! };
  }
  if (sp.turnDeg === null) m = sp.tightI;
  // Parabola through the minimum and its neighbours, vertex clamped to within
  // half a sample: the true minimum lies between samples, and the trace is
  // spaced 5–14 m apart.
  if (m > 0 && m < n - 1) {
    const y0 = v[m - 1]!;
    const y1 = v[m]!;
    const y2 = v[m + 1]!;
    const den = y0 - 2 * y1 + y2;
    if (den > 0) {
      const off = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
      return { i: m, f: m + off, kph: y1 - 0.25 * (y0 - y2) * off };
    }
  }
  return { i: m, f: m, kph: v[m]! };
}

/** Where a corner begins — see the file header for the order of preference. */
function entryOf(
  tr: CornerTrace,
  sp: Span,
  apexI: number,
  prevApexI: number,
  s: number[],
  brakes: { d: number; i: number }[],
): { i: number; d: number; brakeD: number | null } {
  const v = tr.speedKph;
  let peak = prevApexI;
  for (let i = prevApexI; i <= apexI; i += 1) if (v[i]! >= v[peak]!) peak = i;

  const fromS = s[peak]! - BRAKE_BEFORE_PEAK_M;
  for (const bp of brakes) {
    // The onset's own index is the first sample at or past it, so the zone is
    // inside the window when that sample is no later than the apex.
    if (bp.i > prevApexI && bp.i <= apexI && s[bp.i]! >= fromS) {
      const i = Math.max(prevApexI + 1, bp.i - 1);
      return { i, d: bp.d, brakeD: bp.d };
    }
  }
  if (v[peak]! - v[apexI]! >= MIN_SPEED_DROP_KPH && peak > prevApexI) {
    return { i: peak, d: tr.d[peak]!, brakeD: null };
  }
  const i = Math.max(prevApexI + 1, Math.min(sp.a, apexI - 1));
  return { i, d: tr.d[i]!, brakeD: null };
}

/** Where a corner ends — see the file header for the order of preference. */
function exitOf(
  tr: CornerTrace,
  sp: Span,
  entryI: number,
  apexI: number,
  capI: number,
  nextApexI: number,
): number {
  const v = tr.speedKph;
  const thr = tr.throttle;
  const limit = Math.max(apexI + 1, capI);
  if (Array.isArray(thr) && thr.length > apexI) {
    // Never off the throttle from entry to apex: taken flat, so there is no
    // "back on it" moment, and the corner ends where the road stops turning.
    let flat = sp.turnDeg !== null;
    for (let i = entryI; flat && i <= apexI; i += 1) flat = (thr[i] ?? 0) >= FULL_THROTTLE;
    if (flat) return Math.min(limit, Math.max(apexI + 1, sp.b));
    for (let i = apexI + 1; i <= limit && i < thr.length; i += 1) {
      if ((thr[i] ?? 0) >= FULL_THROTTLE) return i;
    }
  }
  let peak = apexI + 1;
  const end = Math.min(nextApexI, v.length - 1);
  for (let i = apexI + 1; i <= end; i += 1) if (v[i]! > v[peak]!) peak = i;
  return Math.min(limit, peak);
}

/** Linear interpolation of a column at a fractional index. */
function interpAt(col: readonly number[], f: number): number {
  const i = Math.floor(f);
  const frac = f - i;
  if (frac <= 0 || i + 1 >= col.length) return col[Math.min(i, col.length - 1)]!;
  return col[i]! + (col[i + 1]! - col[i]!) * frac;
}

/** Seconds into the lap at fraction `d`, or `null` outside the covered span. */
function timeAt(lap: LapColumns, d: number): number | null {
  const n = Math.min(lap.d.length, lap.t.length);
  if (n < 2 || d < lap.d[0]! || d > lap.d[n - 1]!) return null;
  let lo = 1;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lap.d[mid]! >= d) hi = mid;
    else lo = mid + 1;
  }
  const d0 = lap.d[lo - 1]!;
  const d1 = lap.d[lo]!;
  const t0 = lap.t[lo - 1]!;
  return d1 > d0 ? t0 + (lap.t[lo]! - t0) * ((d - d0) / (d1 - d0)) : t0;
}

/** The first braking point within `[from, to]`, or `null`. */
function firstBrakeIn(lap: LapColumns, from: number, to: number, L: number): number | null {
  for (const bp of brakePoints(lap, L)) if (bp.d >= from && bp.d <= to) return bp.d;
  return null;
}

/** The lowest speed sampled within `[from, to]`, or `null`. */
function minSpeedIn(lap: LapColumns, from: number, to: number): number | null {
  const v = lap.speedKph;
  if (!Array.isArray(v)) return null;
  let min = Infinity;
  const n = Math.min(lap.d.length, v.length);
  for (let i = 0; i < n; i += 1) {
    const d = lap.d[i]!;
    if (d < from) continue;
    if (d > to) break;
    if (v[i]! < min) min = v[i]!;
  }
  return Number.isFinite(min) ? min : null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
