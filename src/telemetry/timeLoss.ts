/**
 * timeLoss.ts — a lap against a reference, per corner and per phase.
 * =============================================================================
 *
 * 2026-10-29, the driving coach. "Where does this lap lose time?" answered as
 * C1..Cn, each split into braking / turn-in / mid-corner / exit / exit run,
 * in seconds that ADD UP: the phases of a corner sum to the corner, and the
 * lead-in plus every corner sum to the whole lap's difference on the trace
 * clock. A coach that says "0.3 s in C5's braking" and "0.2 s in C5" in the
 * same breath is not believed again.
 *
 * ## Why it adds up
 * Every boundary is a distance on the REFERENCE lap (its phase points, from
 * `cornerPhases.ts`), and the loss between two boundaries is
 *
 *     (studied lap's time from a to b) − (reference's time from a to b)
 *
 * read off both laps' clocks at the same two distances. Adjacent segments
 * share a boundary, so the sum telescopes to the lap delta exactly — whatever
 * the studied lap did, wherever it braked. The boundaries per corner are:
 *
 *     entry (ref brake onset, else the span's entry)
 *       │ braking      → turn-in, or brake release if that came first
 *       │ turnIn       → apex, or the throttle pick-up if that came first
 *       │ midCorner    → the later of the two
 *       │ exit         → full throttle
 *       │ exitRun      → the next corner's entry (the last corner's: d = 1)
 *
 * Mid-corner is the stretch between the apex and the throttle pick-up in
 * whichever order they came: on real laps the throttle is usually cracked a
 * few metres BEFORE the speed minimum (the car is still scrubbing speed), and
 * "apex → pick-up" alone left the phase empty in almost every corner.
 *
 * `leadInSec` is the line to the first corner's entry. `exitRun` is where
 * a slow exit costs most of its time: without it, about 35% of the loss at
 * Road Atlanta belonged to no corner. A point the reference does not have (no
 * braking in a flat kink, no throttle channel) collapses its phase to zero
 * length — braking 0 s, brake onset null — and the split still adds up.
 * Boundaries are forced into road order, so a reference that never got flat
 * between two corners simply has a zero-length exit run.
 *
 * `residualSec` is the official lap delta minus `totalSec`: the trace clock
 * against timing (about a hundredth). It is reported, never spread over the
 * corners.
 *
 * ## The exit run that is not the driver's
 * On the straight after a corner, a speed gap that was already there when
 * both cars were flat is the exit's — the driver's. A gap that keeps GROWING
 * at equal (full) throttle is not something the driver did: the reference had
 * a tow, or a car / setup with more straight-line speed (or the other way
 * round: the studied lap had one, and `straightSec` is negative). That part
 * is measured as `straightSec` — the time the studied lap would have saved
 * had the gap held at its value when both were flat — and flagged `'tow'`
 * (the extra gap has collapsed again by the braking point) or `'car'` (it is
 * still there: steady growth, a higher top speed). It stays INSIDE `lossSec`
 * and the exit-run phase, so the split still adds up; the coach subtracts it
 * before blaming anyone. A gap that shrinks along the straight is a slow exit
 * decaying, and is never flagged.
 *
 * Pure. Tested in `scripts/test-timeloss.js` on real laps.
 */

import type { CoachPhase, CornerCatalog, CornerPhaseLoss, LapLossBreakdown, PhasePoints } from './coachContract';
import { FULL_THROTTLE } from './corners';
import { colAtD, lapTimeAt, phasePointsOf, prepareLap, type PreparedLap } from './cornerPhases';
import { findSequences } from './cornerSequences';

/** One lap's columns, as a trace stores them (lap fractions in `d`, seconds in `t`). */
export interface LossLapInput {
  lapId: string;
  /** The official lap time; null when the lap has none. */
  lapSec: number | null;
  cols: {
    d: readonly number[];
    t: readonly number[];
    speedKph: readonly number[];
    brake?: readonly number[];
    throttle?: readonly number[];
    steer?: readonly number[];
    latG?: readonly number[];
    x?: readonly number[];
    z?: readonly number[];
  };
}

/** A corner span on the reference lap, with its stable id. */
export interface LossCorner {
  id: string;
  entryD: number;
  apexD: number;
  exitD: number;
}

/** Optional inputs to {@link lapLoss}. */
export interface LapLossOptions {
  /** The layout's catalogue, so the sequences it lists are coached as one. */
  catalog?: CornerCatalog | null;
}

/**
 * What {@link lapLoss} returns: the contract's breakdown plus the track length
 * it was measured with (sequences and "Show me" turn fractions into metres).
 * Assignable to `LapLossBreakdown`.
 */
export type LapLossResult = LapLossBreakdown & { trackLengthM: number };

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Spacing of the samples taken along an exit run, metres. */
const RUN_STEP_M = 5;
/** Growth of the speed gap, beyond its value when both were flat, that counts, km/h. */
export const STRAIGHT_GROW_KPH = 3;
/** Smallest straight-line share worth flagging, seconds. */
export const STRAIGHT_MIN_SEC = 0.02;
/** Shortest stretch of equal full throttle that is judged, metres. */
const STRAIGHT_MIN_M = 100;
/** 'tow' when the extra gap at the end of the stretch is under this share of its peak. */
const TOW_COLLAPSE = 0.5;

/* -------------------------------------------------------------------------- */
/*  Boundaries                                                                */
/* -------------------------------------------------------------------------- */

/** One corner's phase boundaries on the reference, lap fractions, in road order. */
export interface PhaseBounds {
  /** Entry: start of braking. */
  s: number;
  /** End of braking: turn-in, or brake release if earlier. */
  e: number;
  /** Apex. */
  a: number;
  /** Throttle pick-up (may come before the apex). */
  p: number;
  /** The mid-corner phase: from the earlier of apex and pick-up to the later. */
  lo: number;
  hi: number;
  /** Full throttle. */
  f: number;
  /** End of the exit run: the next corner's entry, or 1. */
  r: number;
}

/**
 * The reference's phase boundaries for every corner, forced into road order
 * (see the file header for the fall-backs). `corners` and `refPts` are
 * index-aligned and in lap order.
 */
export function phaseBoundaries(corners: readonly LossCorner[], refPts: readonly PhasePoints[]): PhaseBounds[] {
  const n = corners.length;
  const A: number[] = [];
  for (let k = 0; k < n; k += 1) {
    const raw = refPts[k]?.apexD ?? corners[k]!.apexD;
    A.push(clamp(raw, k > 0 ? A[k - 1]! : 0, 1));
  }
  const S: number[] = [];
  for (let k = 0; k < n; k += 1) {
    const raw = refPts[k]?.brakeOnD ?? corners[k]!.entryD;
    S.push(clamp(raw, k > 0 ? A[k - 1]! : 0, A[k]!));
  }
  const out: PhaseBounds[] = [];
  for (let k = 0; k < n; k += 1) {
    const c = corners[k]!;
    const pt = refPts[k];
    const s = S[k]!;
    const a = A[k]!;
    const r = k + 1 < n ? S[k + 1]! : 1;
    let e = s;
    if (pt && pt.brakeOnD !== null) {
      // Braking ends at turn-in or release, whichever first — unless the car
      // was already turning when the brake went on (a braking zone inside a
      // long bend), when it ends at release.
      const turn = pt.turnInD !== null && pt.turnInD > pt.brakeOnD ? pt.turnInD : a;
      e = Math.min(turn, pt.brakeOffD ?? a);
    }
    e = clamp(e, s, a);
    const pRaw = pt?.pickupD ?? c.exitD;
    const fRaw = pt?.fullThrottleD ?? (pt && pt.pickupD !== null ? r : c.exitD);
    const p = clamp(pRaw, e, r);
    const lo = Math.min(a, p);
    const hi = Math.max(a, p);
    const f = clamp(fRaw, hi, r);
    out.push({ s, e, a, p, lo, hi, f, r });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  The breakdown                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `mine` against `ref`, per corner and per phase. `corners` are the spans to
 * measure by (the catalogue's, else the reference's own), in any order; ids
 * are kept and the result is in lap order. All zeros when either lap has no
 * usable columns; with no corners, the whole lap is lead-in.
 *
 * `opts` is an addition to the stub's signature (optional).
 */
export function lapLoss(
  mine: LossLapInput,
  ref: LossLapInput,
  corners: readonly LossCorner[],
  trackLengthM: number,
  opts: LapLossOptions = {},
): LapLossResult {
  const L = trackLengthM > 0 ? trackLengthM : 0;
  const empty: LapLossResult = {
    lapId: mine.lapId,
    refLapId: ref.lapId,
    corners: [],
    sequences: [],
    leadInSec: 0,
    totalSec: 0,
    residualSec: 0,
    trackLengthM: L,
  };
  const pm = L > 0 ? prepareLap(mine.cols, L) : null;
  const pr = L > 0 ? prepareLap(ref.cols, L) : null;
  if (!pm || !pr) return empty;

  const cs = (corners || [])
    .filter((c) => c && Number.isFinite(c.entryD) && Number.isFinite(c.apexD) && Number.isFinite(c.exitD))
    .slice()
    .sort((a, b) => a.apexD - b.apexD);

  const segLoss = (a: number, b: number): number =>
    lapTimeAt(pm, b) - lapTimeAt(pm, a) - (lapTimeAt(pr, b) - lapTimeAt(pr, a));

  if (cs.length === 0) {
    const total = segLoss(0, 1);
    return { ...empty, leadInSec: total, totalSec: total, residualSec: residual(mine, ref, total) };
  }

  const refPts = phasePointsOf(pr, cs);
  const minePts = phasePointsOf(pm, cs);
  const bounds = phaseBoundaries(cs, refPts);

  const leadInSec = segLoss(0, bounds[0]!.s);
  let totalSec = leadInSec;
  const out: CornerPhaseLoss[] = cs.map((c, k) => {
    const b = bounds[k]!;
    const phases: Record<CoachPhase, number> = {
      braking: segLoss(b.s, b.e),
      turnIn: segLoss(b.e, b.lo),
      midCorner: segLoss(b.lo, b.hi),
      exit: segLoss(b.hi, b.f),
      exitRun: segLoss(b.f, b.r),
    };
    const lossSec = phases.braking + phases.turnIn + phases.midCorner + phases.exit + phases.exitRun;
    totalSec += lossSec;
    const st = straightShare(pm, pr, b.f, b.r, phases.exitRun);
    return {
      id: c.id,
      index: k,
      entryD: b.s,
      apexD: b.a,
      exitD: b.f,
      runEndD: b.r,
      lossSec,
      phases,
      mine: minePts[k]!,
      ref: refPts[k]!,
      straightFlag: st.flag,
      straightSec: st.sec,
    };
  });

  const result: LapLossResult = {
    lapId: mine.lapId,
    refLapId: ref.lapId,
    corners: out,
    sequences: [],
    leadInSec,
    totalSec,
    residualSec: residual(mine, ref, totalSec),
    trackLengthM: L,
  };
  result.sequences = findSequences(result, opts.catalog ?? null, L);
  return result;
}

/** Official delta minus the trace's; 0 when either lap has no official time. */
function residual(mine: LossLapInput, ref: LossLapInput, totalSec: number): number {
  const a = mine.lapSec;
  const b = ref.lapSec;
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || !(a > 0) || !(b > 0)) return 0;
  return a - b - totalSec;
}

/**
 * The share of an exit run's loss that is straight-line speed, not driving —
 * see the file header. `[from, to]` is the run on the reference's distances;
 * `runLoss` is that phase's loss, which bounds the answer.
 */
function straightShare(
  pm: PreparedLap,
  pr: PreparedLap,
  from: number,
  to: number,
  runLoss: number,
): { flag: null | 'tow' | 'car'; sec: number } {
  const none = { flag: null, sec: 0 };
  if (!pm.throttle || !pr.throttle || !(to > from)) return none;
  const L = pr.lengthM;
  const step = RUN_STEP_M / L;

  // Walk the run until both cars are flat; from there, until either lifts.
  const ds: number[] = [];
  const vm: number[] = [];
  const g: number[] = [];
  let started = false;
  for (let d = from; d <= to + 1e-12; d += step) {
    const tm = colAtD(pm, pm.throttle, d);
    const tr = colAtD(pr, pr.throttle, d);
    const a = colAtD(pm, pm.v, d);
    const b = colAtD(pr, pr.v, d);
    const flat = tm !== null && tr !== null && a !== null && b !== null && tm >= FULL_THROTTLE && tr >= FULL_THROTTLE;
    if (!flat) {
      if (started) break;
      continue;
    }
    started = true;
    ds.push(d);
    vm.push(a!);
    g.push(b! - a!);
  }
  if (ds.length < 2 || (ds[ds.length - 1]! - ds[0]!) * L < STRAIGHT_MIN_M) return none;

  // Growth beyond the gap at the start of the stretch, away from zero: a slow
  // exit's gap shrinking back is never counted.
  const g0 = g[0]!;
  const pos = g.map((x) => Math.max(0, x - Math.max(g0, 0)));
  const neg = g.map((x) => Math.min(0, x - Math.min(g0, 0)));
  let peakPos = 0;
  let peakNeg = 0;
  for (let j = 0; j < g.length; j += 1) {
    if (pos[j]! > peakPos) peakPos = pos[j]!;
    if (neg[j]! < peakNeg) peakNeg = neg[j]!;
  }
  const useNeg = -peakNeg > peakPos;
  const e = useNeg ? neg : pos;
  const peak = useNeg ? -peakNeg : peakPos;
  if (peak < STRAIGHT_GROW_KPH) return none;

  // Time the studied lap would have saved had the gap held at its start value.
  const inv = (k: number): number => {
    const v = Math.max(1, vm[k]! / 3.6);
    const vh = Math.max(1, (vm[k]! + e[k]!) / 3.6);
    return 1 / v - 1 / vh;
  };
  let sec = 0;
  for (let j = 1; j < ds.length; j += 1) sec += 0.5 * (inv(j - 1) + inv(j)) * (ds[j]! - ds[j - 1]!) * L;
  if (Math.abs(sec) < STRAIGHT_MIN_SEC) return none;
  if (Math.sign(sec) !== Math.sign(runLoss)) return none;
  if (Math.abs(sec) > Math.abs(runLoss)) sec = runLoss;

  const flag: 'tow' | 'car' = Math.abs(e[e.length - 1]!) < TOW_COLLAPSE * peak ? 'tow' : 'car';
  return { flag, sec: Math.round(sec * 10000) / 10000 };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}
