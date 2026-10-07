/**
 * brakePoints.ts — where each braking zone of a lap begins.
 * -----------------------------------------------------------------------------
 * A port of the detector the Review tab draws its braking ticks with
 * (`electron/control-panel/review-charts.js`, `brakePoints` /
 * `brakePointPairs`, 2026-09-14). That copy lives in the panel's renderer and
 * cannot be imported by the telemetry server, and Ghost HUD needs the same
 * answer server-side so it is computed once per selected lap rather than per
 * frame in a widget. The Review copy is deliberately left alone: it is pinned
 * by its own tests, and two surfaces that place the same braking point in
 * different places would be a bug reported against both. Change the thresholds
 * in both or neither.
 *
 * Pure and dependency-free, so it is tested headlessly with everything else
 * in `scripts/test-brakepoints.js`.
 */

/** Brake pressure at or above this is "on"; below the other, "off". */
export const BRAKE_ON = 0.12;
export const BRAKE_OFF = 0.05;

/**
 * How far the brake must have been off before a press counts as a NEW braking
 * zone. A stab mid-corner, a double-dab into a chicane — those are the same
 * zone, and a marker for each would litter the road.
 */
export const ZONE_GAP_M = 60;

/** How far apart two laps' braking points may be and still be the same corner. */
export const PAIR_WINDOW_M = 120;

/** The columns the detector reads. A stored trace and `/ghost.json` both fit. */
export interface BrakeTrace {
  d: readonly number[];
  brake?: readonly number[];
  x?: readonly number[];
  z?: readonly number[];
}

/** The start of one braking zone. */
export interface BrakePoint {
  /** Lap fraction 0..1, interpolated between the two straddling samples. */
  d: number;
  /** Index of the first sample at or above {@link BRAKE_ON}. */
  i: number;
  /** World position, metres, when the lap carries a driven line; else `null`. */
  x: number | null;
  z: number | null;
}

/** Two laps' braking points for (probably) the same corner. */
export interface BrakePointPair {
  mine: BrakePoint;
  /** `null` when the other lap did not brake within the window here. */
  theirs: BrakePoint | null;
  /** Metres; positive = `mine` braked LATER. `null` when unmatched. */
  laterM: number | null;
}

/**
 * Where each braking zone begins on a lap: lap distance (interpolated so it is
 * not quantised to the trace's spacing), the index it happened at, and the
 * position on the road when the lap carries one. Empty for a trace without a
 * brake channel.
 */
export function brakePoints(tr: BrakeTrace | null | undefined, lengthM: number): BrakePoint[] {
  const out: BrakePoint[] = [];
  if (!tr || !Array.isArray(tr.d) || !Array.isArray(tr.brake)) return out;
  const brake = tr.brake;
  const n = Math.min(tr.d.length, brake.length);
  if (n < 3) return out;
  const L = lengthM > 0 ? lengthM : 1;
  const xs = tr.x;
  const zs = tr.z;
  const n0 = tr.d.length;
  const placed = Array.isArray(xs) && Array.isArray(zs) && xs.length === n0 && zs.length === n0;
  let offSinceD = -Infinity; // lap distance at which the brake last went off
  let on = (brake[0] || 0) >= BRAKE_ON;
  if (!on) offSinceD = tr.d[0]!;
  for (let i = 1; i < n; i += 1) {
    const b = brake[i] || 0;
    if (!on && b >= BRAKE_ON) {
      on = true;
      if ((tr.d[i]! - offSinceD) * L >= ZONE_GAP_M) {
        // Interpolate the crossing between i-1 and i.
        const b0 = brake[i - 1] || 0;
        const f = b > b0 ? Math.min(1, Math.max(0, (BRAKE_ON - b0) / (b - b0))) : 1;
        const d0 = tr.d[i - 1]!;
        const pt: BrakePoint = { d: d0 + (tr.d[i]! - d0) * f, i, x: null, z: null };
        if (placed) {
          pt.x = xs![i - 1]! + (xs![i]! - xs![i - 1]!) * f;
          pt.z = zs![i - 1]! + (zs![i]! - zs![i - 1]!) * f;
        }
        out.push(pt);
      }
    } else if (on && b < BRAKE_OFF) {
      on = false;
      offSinceD = tr.d[i]!;
    }
  }
  return out;
}

/**
 * Pair the braking zones of two laps by road, and say who braked later.
 *
 * Each of `a`'s zones is matched to `b`'s nearest unused zone within
 * `windowM`; a zone with no partner (one driver lifted where the other braked)
 * is kept with `theirs` null, because "you braked here and they did not" is
 * itself worth seeing.
 */
export function brakePointPairs(
  a: BrakeTrace | null | undefined,
  b: BrakeTrace | null | undefined,
  lengthM: number,
  windowM = PAIR_WINDOW_M,
): BrakePointPair[] {
  const L = lengthM > 0 ? lengthM : 1;
  const mine = brakePoints(a, lengthM);
  const theirs = brakePoints(b, lengthM);
  const used = new Set<number>();
  return mine.map((m) => {
    let best = -1;
    let bestGap = Infinity;
    for (let k = 0; k < theirs.length; k += 1) {
      if (used.has(k)) continue;
      const gap = Math.abs(theirs[k]!.d - m.d) * L;
      if (gap < bestGap) {
        bestGap = gap;
        best = k;
      }
    }
    if (best >= 0 && bestGap <= windowM) {
      used.add(best);
      const t = theirs[best]!;
      return { mine: m, theirs: t, laterM: (m.d - t.d) * L };
    }
    return { mine: m, theirs: null, laterM: null };
  });
}
