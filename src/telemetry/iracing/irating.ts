/**
 * @file src/telemetry/iracing/irating.ts
 * @module telemetry/iracing/irating
 *
 * Projected iRating change for an iRacing race, if it finished in the current
 * order.
 *
 * iRacing does not publish its formula. This is the community formula from the
 * "iRacing SOF iRating Calculator v1_1.xlsx" spreadsheet (SIMRacingApps issue
 * #209), as implemented by Turbo87/irating-rs; it reproduces irating-rs's
 * 28-driver snapshot to three decimals (`scripts/test-iracing.js`). Treat the
 * result as an estimate: small differences from the official number are
 * expected.
 *
 * iRacing rates each class as its own field, so {@link iRatingDeltasByClass}
 * runs the formula once per class.
 */

/** `1600 / ln 2`. */
const BR1 = 1600 / Math.LN2;

/** Probability that a driver rated `a` beats one rated `b`. */
export function chance(a: number, b: number): number {
  const ea = Math.exp(-a / BR1);
  const eb = Math.exp(-b / BR1);
  return ((1 - ea) * eb) / ((1 - eb) * ea + (1 - ea) * eb);
}

/** One driver of one class. */
export interface IRatingRow {
  /** iRating before the race. */
  ir: number;
  /** Finishing position within the class, 1-based. Ignored for non-starters. */
  rank: number;
  /** Whether the driver started the race. */
  started: boolean;
}

/**
 * Rating changes (unrounded) for one class, in input order.
 *
 * `N` = registered drivers, `S` = starters. Each starter gains
 * `(N − rank − expected − fudge) · 200 / S`, where `expected` is the expected
 * number of drivers beaten; the non-starters share the negated sum of the
 * starters' changes in proportion to their expected scores.
 */
export function iRatingDeltas(rows: readonly IRatingRow[]): number[] {
  const n = rows.length;
  if (n === 0) return [];
  const starters = rows.filter((r) => r.started).length;
  const nonStarters = n - starters;
  const expected = rows.map((r) => rows.reduce((s, o) => s + chance(r.ir, o.ir), 0) - 0.5);
  const fudge = rows.map((r) => (r.started ? ((n - nonStarters / 2) / 2 - r.rank) / 100 : 0));
  const deltas: Array<number | null> = rows.map((r, i) =>
    r.started && starters > 0
      ? ((n - r.rank - (expected[i] as number) - (fudge[i] as number)) * 200) / starters
      : null,
  );
  const sumStarters = deltas.reduce<number>((s, d) => s + (d ?? 0), 0);
  const sumExpNs = rows.reduce((s, r, i) => s + (r.started ? 0 : (expected[i] as number)), 0);
  return rows.map((_r, i) => {
    const d = deltas[i];
    if (d !== null && d !== undefined) return d;
    if (nonStarters === 0 || sumExpNs <= 0) return 0;
    return ((-sumStarters / nonStarters) * (expected[i] as number)) / (sumExpNs / nonStarters);
  });
}

/** One car for {@link iRatingDeltasByClass}. */
export interface IRatingEntry extends IRatingRow {
  /** Caller's key for the result (the provider uses the CarIdx). */
  key: number;
  /** Class identity (`CarClassID`). */
  classId: number;
}

/**
 * Rounded rating changes keyed by {@link IRatingEntry.key}, computed per class.
 * Drivers with no rating (`ir <= 0`: AI, hidden) are left out, and a class with
 * fewer than two rated drivers produces nothing.
 */
export function iRatingDeltasByClass(entries: readonly IRatingEntry[]): Map<number, number> {
  const out = new Map<number, number>();
  const byClass = new Map<number, IRatingEntry[]>();
  for (const e of entries) {
    if (!(e.ir > 0)) continue;
    const list = byClass.get(e.classId);
    if (list) list.push(e);
    else byClass.set(e.classId, [e]);
  }
  for (const list of byClass.values()) {
    if (list.length < 2) continue;
    const d = iRatingDeltas(list);
    list.forEach((e, i) => {
      const v = d[i];
      if (typeof v === 'number' && Number.isFinite(v)) out.set(e.key, Math.round(v));
    });
  }
  return out;
}
