/**
 * cornerSequences.ts — linked corners (chicanes, esses, the Porsche Curves).
 * =============================================================================
 *
 * 2026-10-29, the driving coach. Some corners cannot be coached one at a
 * time. In a chicane the line through the first half is chosen for the
 * second: a driver who gives a tenth in the entry to win it back on the exit
 * has driven it well, and telling them "you lose 0.1 s in C7" is wrong. In
 * the Porsche Curves a mistake in the first bend is carried through all of
 * them. So corners that are one piece of road are grouped and coached on
 * their total.
 *
 * ## One lap ({@link findSequences})
 * Two consecutive corners are linked when the reference's exit run between
 * them (full throttle → next braking) is shorter than {@link LINK_GAP_M}, when
 * the reference never got flat between them at all, or when the catalogue
 * lists them in one sequence. Chains of links are sequences, and each is
 * labelled by how its corners' losses relate:
 *
 *   - 'trade'  — losses of both signs that mostly cancel (|total| under half
 *                the largest single corner): time given in one half and won
 *                back in the other;
 *   - 'carry'  — the first corner loses (or gains) and every later one goes
 *                the same way: the mistake was carried through;
 *   - 'linked' — neither; still one piece of road.
 *
 * ## A session ({@link sessionSequences})
 * One lap cannot tell a trade from noise. Across eight or more laps, a pair
 * of linked corners whose losses are correlated is a habit: on this
 * machine's laps chicanes come out negative (Dunlop r −0.44, the Road Atlanta
 * esses −0.30 — the driver trades) and the Porsche Curves positive
 * (r 0.67–0.76 — losses carry). Pairs with |r| ≥ {@link SESSION_MIN_R} are
 * returned, adjacent pairs of the same kind joined into one, with the mean
 * total loss over the laps that drove them all.
 *
 * Only LINKED pairs are correlated. Corners a straight apart correlate too —
 * fuel, tyres and traffic move every corner of a lap the same way — and
 * calling that a "carried loss" would be wrong.
 *
 * Pure. Tested in `scripts/test-sequences.js`.
 */

import type { CornerCatalog, CornerPhaseLoss, CornerSequence, LapLossBreakdown } from './coachContract';

/**
 * A reference exit run shorter than this links two corners, metres. 100 m
 * split the Porsche Curves (122 m and 129 m of flat between bends whose
 * losses correlate at r 0.9); 150 m keeps them whole and still leaves Le
 * Mans's 165 m and Road Atlanta's 179 m straights unlinked.
 */
export const LINK_GAP_M = 150;
/** A corner's loss smaller than this has no sign worth reading, seconds. */
export const SIGN_EPS_SEC = 0.02;
/** Laps a session needs before its correlations mean anything. */
export const SESSION_MIN_LAPS = 8;
/** |r| at or above which a session pair is reported. */
export const SESSION_MIN_R = 0.3;

/**
 * Whether each corner is linked to the next one, index-aligned with
 * `b.corners` (the last entry is always false). See the file header.
 *
 * @param trackLengthM - Turns the exit run into metres. Defaults to the
 *   `trackLengthM` that `lapLoss` puts on its result; without one, only the
 *   "never flat" and catalogue rules apply.
 */
export function linkedToNext(
  b: LapLossBreakdown,
  catalog?: CornerCatalog | null,
  trackLengthM?: number,
): boolean[] {
  const cs = b.corners || [];
  const L = lengthOf(b, trackLengthM);
  const out = cs.map(() => false);
  const catPairs = catalogPairs(catalog);
  for (let k = 0; k + 1 < cs.length; k += 1) {
    const c = cs[k]!;
    const next = cs[k + 1]!;
    const runM = (c.runEndD - c.exitD) * L;
    // "Never flat" needs a throttle channel: a reference without one has no
    // pick-up either, and every corner would read as linked.
    const hasThrottle = c.ref.pickupD !== null || c.ref.fullThrottleD !== null;
    const neverFlat = hasThrottle && (c.ref.fullThrottleD === null || c.exitD >= c.runEndD - 1e-9);
    out[k] = (L > 0 && runM < LINK_GAP_M) || neverFlat || catPairs.has(`${c.id}\u0000${next.id}`);
  }
  return out;
}

/** Sequences on one lap pair: trades and carried losses. */
export function findSequences(
  b: LapLossBreakdown,
  catalog?: CornerCatalog | null,
  trackLengthM?: number,
): CornerSequence[] {
  const cs = b.corners || [];
  const links = linkedToNext(b, catalog, trackLengthM);
  const out: CornerSequence[] = [];
  let k = 0;
  while (k < cs.length) {
    let j = k;
    while (j + 1 < cs.length && links[j]) j += 1;
    if (j > k) {
      const group = cs.slice(k, j + 1);
      out.push({ cornerIds: group.map((c) => c.id), lossSec: sum(group.map((c) => c.lossSec)), kind: kindOf(group) });
    }
    k = j + 1;
  }
  return out;
}

/** 'trade' / 'carry' / 'linked' from one lap's per-corner losses — see the file header. */
export function kindOf(group: readonly Pick<CornerPhaseLoss, 'lossSec'>[]): CornerSequence['kind'] {
  const l = group.map((c) => c.lossSec);
  const total = sum(l);
  let maxAbs = 0;
  for (const v of l) maxAbs = Math.max(maxAbs, Math.abs(v));
  const hasPos = l.some((v) => v > SIGN_EPS_SEC);
  const hasNeg = l.some((v) => v < -SIGN_EPS_SEC);
  if (hasPos && hasNeg && Math.abs(total) < maxAbs / 2) return 'trade';
  const s0 = Math.sign(l[0]!);
  if (Math.abs(l[0]!) >= SIGN_EPS_SEC && l.every((v) => Math.sign(v) === s0)) return 'carry';
  return 'linked';
}

/**
 * Sequences across a driver's laps: linked corners whose losses move together
 * ('carry', r > 0) or trade off ('trade', r < 0). Needs
 * {@link SESSION_MIN_LAPS} laps that drove both corners; fewer gives []. The
 * catalogue's own sequences are always returned, as 'linked' when the session
 * shows no pattern in them.
 */
export function sessionSequences(laps: readonly LapLossBreakdown[], catalog?: CornerCatalog | null): CornerSequence[] {
  const usable = (laps || []).filter((b) => b && Array.isArray(b.corners) && b.corners.length > 1);
  if (usable.length < SESSION_MIN_LAPS) return [];

  // The corner order: the lap with the most corners (they share ids when cut
  // by the catalogue; laps cut by different references simply join less).
  let order: string[] = [];
  for (const b of usable) if (b.corners.length > order.length) order = b.corners.map((c) => c.id);
  const pos = new Map(order.map((id, i) => [id, i]));

  // Per lap: loss per id, and which ids are linked to the next one.
  const lossBy: Map<string, number>[] = [];
  const linkVotes = new Array<number>(order.length).fill(0);
  const linkSeen = new Array<number>(order.length).fill(0);
  for (const b of usable) {
    const m = new Map<string, number>();
    for (const c of b.corners) if (Number.isFinite(c.lossSec)) m.set(c.id, c.lossSec);
    lossBy.push(m);
    const links = linkedToNext(b, catalog);
    b.corners.forEach((c, k) => {
      const i = pos.get(c.id);
      const next = b.corners[k + 1];
      if (i === undefined || !next || pos.get(next.id) !== i + 1) return;
      linkSeen[i] = (linkSeen[i] ?? 0) + 1;
      if (links[k]) linkVotes[i] = (linkVotes[i] ?? 0) + 1;
    });
  }
  const catPairs = catalogPairs(catalog);

  // r for every linked adjacent pair.
  const pairKind: (CornerSequence['kind'] | null)[] = order.map(() => null);
  const pairLinked: boolean[] = order.map(() => false);
  for (let i = 0; i + 1 < order.length; i += 1) {
    const a = order[i]!;
    const b = order[i + 1]!;
    const linked = catPairs.has(`${a}\u0000${b}`) || (linkSeen[i]! > 0 && linkVotes[i]! * 2 >= linkSeen[i]!);
    pairLinked[i] = linked;
    if (!linked) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const m of lossBy) {
      const x = m.get(a);
      const y = m.get(b);
      if (x === undefined || y === undefined) continue;
      xs.push(x);
      ys.push(y);
    }
    if (xs.length < SESSION_MIN_LAPS) continue;
    const r = pearson(xs, ys);
    if (r === null || Math.abs(r) < SESSION_MIN_R) continue;
    pairKind[i] = r < 0 ? 'trade' : 'carry';
  }

  // Join adjacent pairs of one kind; then add catalogue sequences not covered.
  const groups: { ids: string[]; kind: CornerSequence['kind'] }[] = [];
  for (let i = 0; i + 1 < order.length; i += 1) {
    const kind = pairKind[i];
    if (!kind) continue;
    const last = groups[groups.length - 1];
    if (last && last.kind === kind && last.ids[last.ids.length - 1] === order[i]) last.ids.push(order[i + 1]!);
    else groups.push({ ids: [order[i]!, order[i + 1]!], kind });
  }
  const covered = new Set(groups.flatMap((g) => g.ids));
  for (const seq of catalog?.sequences || []) {
    const ids = seq.cornerIds.filter((id) => pos.has(id));
    if (ids.length < 2 || ids.every((id) => covered.has(id))) continue;
    groups.push({ ids, kind: 'linked' });
  }
  groups.sort((g, h) => pos.get(g.ids[0]!)! - pos.get(h.ids[0]!)!);

  const out: CornerSequence[] = [];
  for (const g of groups) {
    const totals: number[] = [];
    for (const m of lossBy) {
      let t = 0;
      let ok = true;
      for (const id of g.ids) {
        const v = m.get(id);
        if (v === undefined) {
          ok = false;
          break;
        }
        t += v;
      }
      if (ok) totals.push(t);
    }
    if (totals.length === 0) continue;
    out.push({ cornerIds: g.ids, lossSec: sum(totals) / totals.length, kind: g.kind });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Pearson's r; null when either series is flat. */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += 1) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Consecutive id pairs the catalogue puts in one sequence. */
function catalogPairs(catalog?: CornerCatalog | null): Set<string> {
  const out = new Set<string>();
  for (const seq of catalog?.sequences || []) {
    for (let i = 0; i + 1 < seq.cornerIds.length; i += 1) out.add(`${seq.cornerIds[i]}\u0000${seq.cornerIds[i + 1]}`);
  }
  return out;
}

function lengthOf(b: LapLossBreakdown, trackLengthM?: number): number {
  if (trackLengthM !== undefined && trackLengthM > 0) return trackLengthM;
  const own = (b as LapLossBreakdown & { trackLengthM?: number }).trackLengthM;
  return typeof own === 'number' && own > 0 ? own : 0;
}

function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
