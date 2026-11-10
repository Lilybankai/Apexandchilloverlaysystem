/**
 * @file src/telemetry/iracing/liveOrder.ts
 * @module telemetry/iracing/liveOrder
 *
 * Live race order and gaps for iRacing — the standings move the moment a car
 * is passed, not when it next crosses the line.
 *
 * ## Why the sim's own order is not enough
 * `CarIdxPosition` and `CarIdxF2Time` are iRacing's OFFICIAL figures, and the
 * sim only rescores them as each car crosses the start/finish line. Measured on
 * the owner's two recorded races (2026-11-10, ~10 Hz captures): the official
 * order disagreed with the order on the road for 56 % and 73 % of race time; a
 * mid-lap pass typically sat unshown for up to a lap; `F2Time` changed 5–7
 * times per car over a whole race. Every third-party overlay that "updates in
 * real time" re-derives the order instead, and so does this.
 *
 * ## The calculation
 * - **Order** = distance covered: `CarIdxLapCompleted + CarIdxLapDistPct`,
 *   largest first. A car still behind the line it starts from reads
 *   LapCompleted −1, so the sum stays continuous across the first crossing (in
 *   the captures, lap count, lap fraction and EstTime all wrapped in the SAME
 *   frame at every one of 122 crossings — no unwrap guard is needed).
 * - **Gap** = time, not distance: `CarIdxEstTime` is the class reference time
 *   to reach a car's current spot, so car B's gap to car A is
 *   `(lapsA − lapsB)·L_B + estA·L_B/L_A − estB` — "how long until B is where A
 *   is now", on B's own class reference lap (A's EstTime rescaled when the two
 *   are different classes). It is continuous across laps, so class gaps work
 *   even for a GT3 car the overall GTP leader has lapped.
 *
 * ## Where the official figures still win
 * - **Before the green** (grid, parade, pace laps) and **under a full-course
 *   caution** — iRacing freezes the order at the caution; passes behind the
 *   pace car do not count.
 * - **Finished cars.** Once the chequered flag is out, a car that has crossed
 *   the line is placed by its finishing lap count and the sim's official
 *   position, and keeps it after it leaves the world (cars drop to
 *   LapCompleted −1 when they exit — seen in the captures).
 * - **Practice / qualifying** are ordered by best lap; nothing here applies.
 *
 * ## Lightweight on purpose
 * The order and gaps are recomputed at most {@link LIVE_ORDER_HZ} times a
 * second (the owner's ask: 10–15 Hz, not the 60 Hz some overlays poll at);
 * frames in between reuse the last result. Two cars side by side do not flicker
 * either: a swap needs the chasing car to be {@link SWAP_MARGIN_M} ahead on the
 * road, not a millimetre.
 *
 * Pure apart from its own caches — no shared-memory access — so it is tested
 * against the recorded races directly.
 */

/** How often the live order is recomputed. */
export const LIVE_ORDER_HZ = 15;
const REFRESH_MS = 1000 / LIVE_ORDER_HZ;
/** A pass has to be this far ahead on the road before the order swaps. */
export const SWAP_MARGIN_M = 2;
/** Lap-fraction margin when the track length is unknown (≈2 m on a 4 km lap). */
const SWAP_MARGIN_FALLBACK = 0.0005;
/** A line crossing is a step from within this of 1 to within this of 0. */
const WRAP_BAND = 0.1;

/** One car, as the provider reads it this frame. */
export interface LiveOrderCar {
  /** CarIdx. */
  idx: number;
  /** `CarIdxLapCompleted` (−1 = short of its first line). */
  lapsRaw: number;
  /** `CarIdxLapDistPct`, 0..1; negative = not in the world. */
  pct: number;
  /** `CarIdxEstTime`, seconds; negative = unknown. */
  est: number;
  /** The car's class reference lap (`CarClassEstLapTime`), seconds; ≤0 = unknown. */
  classLapSec: number;
  /** `CarIdxPosition` (0 = not scored yet). */
  officialPos: number;
  /** False when the car is not in the world (towing, disconnected, exited). */
  inWorld: boolean;
}

export interface LiveOrderContext {
  nowMs: number;
  /** True while the live order should apply (race, green, no caution). */
  active: boolean;
  /** Laps each car had completed when the chequered fell, once it has. */
  lapsAtFlag: ReadonlyMap<number, number> | null;
  /** Track length in metres (for the swap margin); ≤0 = unknown. */
  trackLengthM: number;
}

export interface LiveOrderResult {
  /** CarIdx, leader first. Every car passed in appears exactly once. */
  order: number[];
  /**
   * Live gap to the overall leader, seconds, on each car's own class lap.
   * Absent for a car with no truthful live figure (finished, out of the world,
   * no EstTime) — the caller keeps the official figure for those.
   */
  gapToLeaderSec: Map<number, number>;
}

export class LiveRaceOrder {
  private order: number[] = [];
  private gaps = new Map<number, number>();
  private computedAt = -Infinity;
  private wasActive = false;
  /** Last on-road progress per car, for a car that has left the world. */
  private readonly lastProgress = new Map<number, number>();
  /**
   * Per car: the last reading, and a lap correction for lap-counter steps the
   * road does not back up. iRacing credits a car joining from its pit stall
   * with a lap while it is PARKED (LapCompleted −1 → 0 at pct 0.984, then 1 at
   * the pit-lane line, then back to 0 nine seconds later — car 3 in the
   * 2026-11-10 race, which read P1 for five seconds). A lap counter that moves
   * without the lap fraction wrapping is not a lap; it is cancelled here.
   */
  private readonly track = new Map<number, { laps: number; pct: number; adj: number }>();
  /** Laps at the finish, per car that has taken the chequered flag. */
  private readonly finished = new Map<number, number>();

  /** Forget everything (new session / reconnect). */
  public reset(): void {
    this.order = [];
    this.gaps = new Map();
    this.computedAt = -Infinity;
    this.wasActive = false;
    this.lastProgress.clear();
    this.finished.clear();
    this.track.clear();
  }

  /**
   * Whole laps for a car on the continuous scale (−1 short of its first
   * line), with lap-counter steps that came without a line crossing cancelled.
   * Called once per car per update, in or out of the live window, so a wrap is
   * never missed. A car out of the world loses its history: on re-entry the
   * sim's count is trusted again.
   */
  private lapsOf(c: LiveOrderCar): number {
    const laps = c.lapsRaw >= 0 ? c.lapsRaw : -1;
    if (!c.inWorld || c.pct < 0 || c.pct > 1) {
      this.track.delete(c.idx);
      return laps;
    }
    const t = this.track.get(c.idx);
    if (!t) {
      this.track.set(c.idx, { laps, pct: c.pct, adj: 0 });
      return laps;
    }
    // A crossing is a short step over the line. Any other big jump is a
    // teleport — a tow or reset to the pit stall (car 9 in the 2026-11-10
    // capture went from 0.22 to its stall at 0.98) — and after one the sim's
    // own lap count stands.
    const fwd = t.pct >= 1 - WRAP_BAND && c.pct <= WRAP_BAND;
    const back = t.pct <= WRAP_BAND && c.pct >= 1 - WRAP_BAND;
    if (!fwd && !back && Math.abs(c.pct - t.pct) > WRAP_BAND) t.adj = 0;
    else {
      const crossed = fwd ? 1 : back ? -1 : 0;
      // Bounded: one phantom lap is what the sim does; more would be our bug.
      t.adj = Math.max(-1, Math.min(1, t.adj + crossed - (laps - t.laps)));
    }
    t.laps = laps;
    t.pct = c.pct;
    return laps + t.adj;
  }

  /**
   * The live order, or `null` when it does not apply (the caller then uses the
   * official order). Recomputed at most {@link LIVE_ORDER_HZ}; in between, the
   * previous answer is returned unless the field itself changed.
   */
  public update(cars: readonly LiveOrderCar[], ctx: LiveOrderContext): LiveOrderResult | null {
    // Progress is tracked even while inactive, so a car that leaves the world
    // under a caution still has somewhere to be when the green comes back.
    if (!ctx.active) {
      for (const c of cars) {
        const laps = this.lapsOf(c);
        if (c.inWorld && c.pct >= 0 && c.pct <= 1) this.lastProgress.set(c.idx, laps + c.pct);
      }
      this.wasActive = false;
      return null;
    }
    const due =
      !this.wasActive ||
      ctx.nowMs - this.computedAt >= REFRESH_MS ||
      ctx.nowMs < this.computedAt ||
      cars.length !== this.order.length ||
      cars.some((c) => !this.order.includes(c.idx));
    if (!due) return { order: this.order.slice(), gapToLeaderSec: new Map(this.gaps) };

    this.wasActive = true;
    this.computedAt = ctx.nowMs;

    /* --- finishers -------------------------------------------------------- */
    if (ctx.lapsAtFlag) {
      for (const c of cars) {
        const at = ctx.lapsAtFlag.get(c.idx);
        if (at !== undefined && !this.finished.has(c.idx) && c.lapsRaw > at) this.finished.set(c.idx, c.lapsRaw);
      }
    }

    /* --- progress --------------------------------------------------------- */
    const key = new Map<number, number>();
    const laps = new Map<number, number>();
    const byIdx = new Map<number, LiveOrderCar>();
    for (const c of cars) {
      byIdx.set(c.idx, c);
      laps.set(c.idx, this.lapsOf(c));
      const fin = this.finished.get(c.idx);
      let p: number;
      if (fin !== undefined) p = fin;
      else if (c.inWorld && c.pct >= 0 && c.pct <= 1) {
        p = (laps.get(c.idx) as number) + c.pct;
        this.lastProgress.set(c.idx, p);
      } else p = this.lastProgress.get(c.idx) ?? (c.lapsRaw >= 0 ? c.lapsRaw : -1);
      key.set(c.idx, p);
    }

    /* --- order: from the last one, swapping only on a real pass ------------ */
    const margin = ctx.trackLengthM > 0 ? SWAP_MARGIN_M / ctx.trackLengthM : SWAP_MARGIN_FALLBACK;
    const present = new Set(cars.map((c) => c.idx));
    const list = this.order.filter((i) => present.has(i));
    const fresh = cars
      .filter((c) => !list.includes(c.idx))
      .sort((a, b) => (key.get(b.idx) as number) - (key.get(a.idx) as number) || offPos(a) - offPos(b) || a.idx - b.idx)
      .map((c) => c.idx);
    // A newcomer is placed by its progress (one insertion pass below does it).
    list.push(...fresh);
    /** True when `b` (behind `a` in the list) should be ahead of it. */
    const ahead = (a: number, b: number): boolean => {
      const ka = key.get(a) as number;
      const kb = key.get(b) as number;
      const fa = this.finished.has(a);
      const fb = this.finished.has(b);
      if (fa && fb) {
        if (ka !== kb) return kb > ka;
        // Same lap at the flag: the sim's official finishing order decides.
        return offPos(byIdx.get(b) as LiveOrderCar) < offPos(byIdx.get(a) as LiveOrderCar);
      }
      // A finisher on N laps against a car still running on lap N: the
      // finisher is ahead (key N > N−1+pct). Otherwise distance decides.
      if (fa !== fb) return kb > ka;
      return kb > ka + margin;
    };
    for (let i = 1; i < list.length; i++) {
      for (let j = i; j > 0 && ahead(list[j - 1] as number, list[j] as number); j--) {
        const t = list[j - 1] as number;
        list[j - 1] = list[j] as number;
        list[j] = t;
      }
    }
    this.order = list;

    /* --- gaps --------------------------------------------------------------- */
    const gaps = new Map<number, number>();
    const lead = byIdx.get(list[0] as number);
    const usable = (c: LiveOrderCar | undefined): c is LiveOrderCar =>
      !!c && c.inWorld && c.pct >= 0 && c.pct <= 1 && c.est >= 0 && c.classLapSec > 0 && !this.finished.has(c.idx);
    if (usable(lead)) {
      gaps.set(lead.idx, 0);
      for (const idx of list.slice(1)) {
        const c = byIdx.get(idx);
        if (!usable(c)) continue;
        const L = c.classLapSec;
        const leadEst = lead.classLapSec !== L ? (lead.est * L) / lead.classLapSec : lead.est;
        const g = ((laps.get(lead.idx) as number) - (laps.get(idx) as number)) * L + leadEst - c.est;
        gaps.set(idx, Math.round(Math.max(0, g) * 1000) / 1000);
      }
    }
    this.gaps = gaps;
    return { order: list.slice(), gapToLeaderSec: new Map(gaps) };
  }
}

function offPos(c: LiveOrderCar): number {
  return c.officialPos > 0 ? c.officialPos : 1e6;
}
