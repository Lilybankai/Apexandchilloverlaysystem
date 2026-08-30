/**
 * @file src/telemetry/carClass.ts
 * @module telemetry/carClass
 *
 * Car-class normalisation and speed ranking.
 *
 * LMU reports a car's class as a free-text string, and the exact spelling varies
 * with the entry list: the same category turns up as `"Hypercar"`, `"HYPER"`,
 * `"LMH"`, `"LMDh"` or `"GTP"` depending on the car and the mod. Passing that
 * through verbatim (as the provider used to) meant the standings tower grouped
 * one category into several groups, and nothing downstream could reason about
 * which class is faster.
 *
 * This module collapses those spellings onto a small canonical set and gives
 * each a **speed rank** (lower = faster class). The rank is what lets the
 * relative widget say "a faster car is coming" without hardcoding class names in
 * the overlay.
 */

import { UNKNOWN_VALUE, type RelativeEntry, type StandingEntry } from './types';

/**
 * Canonical class labels, fastest category first.
 *
 * LMP2 and LMP2_ELMS are two entries on purpose. LMU races them as separate
 * categories — its entry lists say `LMP2` and `LMP2_ELMS`, and the ELMS car is a
 * different power level, ~3.5 s a lap at Bahrain. Collapsing them would put one
 * group in the tower that is really two, and score both against one reference.
 * They sit adjacent because they are adjacent in pace: the ELMS car is the
 * slower of the two, so it ranks just behind.
 */
export const CLASS_ORDER = [
  'HYPERCAR',
  'LMP2',
  'LMP2_ELMS',
  'LMP3',
  'GTE',
  'GT3',
  'GT4',
] as const;

/** A canonical class label, or `undefined` when the class is unrecognised. */
export type CanonicalClass = (typeof CLASS_ORDER)[number];

/**
 * Known spellings → canonical label. Keys are compared after upper-casing and
 * stripping every non-alphanumeric character, so `"LMGT3"`, `"LM GT3"` and
 * `"lm-gt3"` all hit the same entry.
 */
const ALIASES: Record<string, CanonicalClass> = {
  HYPERCAR: 'HYPERCAR',
  HYPER: 'HYPERCAR',
  LMH: 'HYPERCAR',
  LMDH: 'HYPERCAR',
  GTP: 'HYPERCAR',
  P1: 'HYPERCAR',
  LMP1: 'HYPERCAR',
  LMP2: 'LMP2',
  P2: 'LMP2',
  // LMU spells it `LMP2_ELMS`; the key strips the underscore.
  LMP2ELMS: 'LMP2_ELMS',
  P2ELMS: 'LMP2_ELMS',
  LMP3: 'LMP3',
  P3: 'LMP3',
  GTE: 'GTE',
  LMGTE: 'GTE',
  GTEPRO: 'GTE',
  GTEAM: 'GTE',
  GT3: 'GT3',
  LMGT3: 'GT3',
  GT3PRO: 'GT3',
  GT4: 'GT4',
  LMGT4: 'GT4',
};

/** Upper-case and strip everything that isn't a letter or digit. */
function key(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Collapse a raw class string onto its canonical label.
 *
 * Unrecognised classes are **not** discarded — they are returned upper-cased and
 * trimmed, so a mod's custom category still groups consistently with itself even
 * though we know nothing about its pace. Empty/absent input returns `undefined`,
 * which is what {@link StandingEntry.carClass} uses for "unknown".
 */
export function normalizeClass(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const hit = normalizeCache.get(raw);
  if (hit !== undefined) return hit;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const out = ALIASES[key(trimmed)] ?? trimmed.toUpperCase();
  // A field carries a handful of distinct spellings, but this runs per car per
  // frame across half a dozen builders — ~130 regex+case-fold passes a frame
  // for answers that never change. The cap only matters if something feeds
  // unbounded garbage in; real inputs never come close.
  if (normalizeCache.size > 512) normalizeCache.clear();
  normalizeCache.set(raw, out);
  return out;
}

/** raw spelling → canonical label; see the note inside {@link normalizeClass}. */
const normalizeCache = new Map<string, string>();

/**
 * Speed rank of a class: `0` is the fastest known category, higher is slower.
 *
 * Unknown classes rank **after** every known one rather than being treated as
 * slow-and-equal, so a mod class never falsely triggers a "faster car closing"
 * alert against a known category.
 */
export function classRank(cls: string | undefined): number {
  if (!cls) return CLASS_ORDER.length;
  const idx = (CLASS_ORDER as readonly string[]).indexOf(cls);
  return idx >= 0 ? idx : CLASS_ORDER.length;
}

/**
 * Whether `a` is a genuinely faster category than `b`. Returns `false` when
 * either class is unknown, so callers never act on a guess.
 */
export function isFasterClass(a: string | undefined, b: string | undefined): boolean {
  const ra = classRank(a);
  const rb = classRank(b);
  if (ra >= CLASS_ORDER.length || rb >= CLASS_ORDER.length) return false;
  return ra < rb;
}

/**
 * The {@link StandingEntry.lapFraction} field for a standings row, ready to
 * spread — `{}` when the sim has not placed the car, so the field is left off
 * rather than guessed at. Shared by the providers so the "is this car actually
 * on the track" guard is written once: a distance outside the lap, or a track
 * with no published length, is a reading to discard, not to clamp.
 *
 * @param distM - Distance round the current lap, metres.
 * @param trackLenM - Lap length, metres; `0` when the sim has not published one.
 */
export function lapFractionOf(distM: number, trackLenM: number): { lapFraction?: number } {
  if (!(trackLenM > 0)) return {};
  if (typeof distM !== 'number' || !Number.isFinite(distM)) return {};
  if (distM < 0 || distM > trackLenM) return {};
  return { lapFraction: Math.round((distM / trackLenM) * 10000) / 10000 };
}

/**
 * A sim's OWN answer for one car's gap to its class leader, used only where
 * {@link assignClassPositions} cannot derive one. Both members are optional
 * because a sim may publish one and not the other; a value that is absent,
 * negative or {@link UNKNOWN_VALUE} is ignored.
 */
export interface ClassGapHint {
  /** Seconds behind the class leader, as the sim reports it. */
  gapSec?: number;
  /** Whole laps behind the class leader, as the sim reports it. */
  lapsBehind?: number;
}

/**
 * Fill in `classPosition`, `classLapsBehind` and `gapToClassLeaderSec` on rows
 * that are already sorted by overall position.
 *
 * In a multiclass field the overall position is close to meaningless to a GT3
 * driver — the number they race for is their position in class, and the gap they
 * care about is to the car leading *their* category. No sim publishes those
 * directly, so both are derived here and shared by every provider.
 *
 * The class gap is `gapToLeaderSec(car) − gapToLeaderSec(classLeader)`: both are
 * measured against the same overall leader, so the difference is the class gap.
 * It is only meaningful while both cars are on the class leader's lap — once
 * either is lapped, a seconds-behind figure stops being comparable, so the gap
 * reports {@link UNKNOWN_VALUE} and `classLapsBehind` carries the information.
 *
 * ## Laps down is COUNTED, not differenced
 *
 * `lapsBehind` is laps down to the **overall** leader, and the sim steps it the
 * moment that leader passes a car — one car at a time, in the order they are
 * caught. So two cars in the same class, on the same lap, fifteen seconds apart,
 * hold different values for as long as the leader is between them on the road,
 * and `lapsBehind(car) − lapsBehind(classLeader)` invents a lap that is not
 * there. In a multiclass race that is not an edge case: it is what happens every
 * time the Hypercar leader drives through the GT3 train, which is most of a
 * stint. Reported from a beta tester's tower showing `+1L` for a 15-second gap.
 *
 * When the sim gives a track position ({@link StandingEntry.lapFraction}) the
 * count is exact instead: `lapsCompleted + lapFraction` puts both cars on one
 * continuous scale, and the whole part of the difference is how many times the
 * class leader has actually been round more than this car. Without a track
 * position there is nothing better than the old difference, so that stays as the
 * fallback — a sim that publishes no positions renders exactly what it did.
 *
 * ## What the sim already knows
 *
 * Some sims publish their own class figures, and where ours cannot answer,
 * theirs is better than a dash. LMU is the case that forced this: it zeroes
 * `timeBehindLeader` for every LAPPED car, so in a long race almost the whole
 * field arrives here with an unknown gap to the overall leader and there is
 * nothing left to difference — measured live at Daytona (2026-08-30, 8 h,
 * 39 cars: exactly ONE car still carried a non-zero figure). Its
 * `timeBehindClassLeader` survives that, so the provider passes it through as
 * a {@link ClassGapHint} and the seconds column stays alive.
 *
 * The hint is a FALLBACK, never an override: the counted answer above is
 * derived from track position and is the one that does not invent a lap, so it
 * wins wherever it exists. A hint is consulted only where this function would
 * otherwise write {@link UNKNOWN_VALUE}.
 *
 * @param rows - Standings rows, pre-sorted by overall position. Mutated in place.
 * @param hints - Optional `slotId → `{@link ClassGapHint}, from a sim that
 *   publishes class gaps of its own. Omit on providers that do not.
 */
export function assignClassPositions(
  rows: StandingEntry[],
  hints?: ReadonlyMap<number, ClassGapHint>,
): void {
  /**
   * A car's progress in laps, as one continuous number, or `null` when the sim
   * has not placed it. Rejects a fraction outside `0..1` rather than clamping:
   * an out-of-range value means the field is not what we think it is, and the
   * difference-based fallback is better than a confident wrong answer.
   */
  const progress = (row: StandingEntry): number | null => {
    const f = row.lapFraction;
    if (typeof f !== 'number' || !Number.isFinite(f) || f < 0 || f > 1) return null;
    return row.lapsCompleted + f;
  };

  /** carClass → the class leader's row (first seen, i.e. best overall position). */
  const leaders = new Map<string, StandingEntry>();
  /** carClass → cars counted so far, which is the next class position. */
  const counts = new Map<string, number>();

  for (const row of rows) {
    const cls = row.carClass;
    if (!cls) continue;

    const n = (counts.get(cls) ?? 0) + 1;
    counts.set(cls, n);
    row.classPosition = n;

    let leader = leaders.get(cls);
    if (!leader) {
      leaders.set(cls, row);
      leader = row;
    }

    const hint = hints?.get(row.slotId);
    /** A hint member worth using: a real, non-negative number. */
    const usable = (v: number | undefined): v is number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 && v !== UNKNOWN_VALUE;

    const ownLaps = progress(row);
    const leaderLaps = progress(leader);
    row.classLapsBehind =
      ownLaps !== null && leaderLaps !== null
        ? // The epsilon is against float noise at the line, not a tolerance:
          // two cars a millimetre apart must not read as a lap.
          Math.max(0, Math.floor(leaderLaps - ownLaps + 1e-6))
        : // No track position for one of the pair, so the difference is all
          // there is — unless the sim counted it for us, which it does without
          // the phantom-lap problem because it is counting, not differencing.
          usable(hint?.lapsBehind)
          ? hint.lapsBehind
          : Math.max(0, row.lapsBehind - leader.lapsBehind);

    /**
     * Laps down as one continuous number, for the gap below. A car a third of a
     * lap down is not "on the leader's lap" in any sense a seconds figure can
     * express, but `classLapsBehind` floors it to 0 and would let the (wrapped,
     * meaningless) seconds through. Falls back to the whole count.
     */
    const lapsDownExact =
      ownLaps !== null && leaderLaps !== null
        ? leaderLaps - ownLaps
        : (row.classLapsBehind ?? 0);

    const own = row.gapToLeaderSec;
    const lead = leader.gapToLeaderSec;
    const derived =
      row === leader
        ? 0
        : lapsDownExact < 1 && own !== UNKNOWN_VALUE && lead !== UNKNOWN_VALUE
          ? Math.round((own - lead) * 100) / 100
          : UNKNOWN_VALUE;
    // The sim's own figure stands in only where ours came out unknown, and only
    // while the car is on the class leader's lap — a seconds gap across a lap
    // boundary has wrapped and says nothing, whoever published it.
    row.gapToClassLeaderSec =
      derived !== UNKNOWN_VALUE
        ? derived
        : lapsDownExact < 1 && usable(hint?.gapSec)
          ? Math.round(hint.gapSec * 100) / 100
          : UNKNOWN_VALUE;

    /**
     * The fractional lap deficit, published so a timing sheet can print a gap
     * that survives being compared with the row above it. `classLapsBehind` is
     * floored per row, and the difference of two floors is not the distance
     * between two cars: at Daytona (2026-08-30) an LMP2 3.57 laps down read +3L
     * and one 5.04 laps down read +5L, so the sheet implied two laps between
     * cars that were 1.47 apart. Omitted when there is no track position to
     * count from, which is the only case where nothing better than the floor
     * exists.
     */
    row.classLapsBehindExact =
      ownLaps !== null && leaderLaps !== null
        ? Math.round(Math.max(0, leaderLaps - ownLaps) * 1000) / 1000
        : undefined;
  }
}

/**
 * Copy each car's `classPosition` from the standings onto its relative row.
 *
 * The relative panel shows the cars physically nearest on track, which in a
 * multiclass field is mostly cars from other categories — so the overall
 * position it used to print was the one number nobody in the picture is racing
 * for. What the driver needs is each car's place in ITS OWN class: that is what
 * says whether the GT3 arriving is the one they are fighting for the podium or
 * a car two laps down.
 *
 * Copied rather than recomputed on purpose. {@link assignClassPositions} counts
 * down the WHOLE field in order; the relative list is a handful of cars picked
 * by proximity, so counting within it would number a car by how many of its
 * class happen to be nearby — a plausible-looking number that is simply wrong.
 * Joining by slot id means the two panels are quoting one figure.
 *
 * Rows whose car has no class position (an unknown mod class, a car that has
 * not appeared in the standings yet) are left alone; the widget falls back to
 * the overall number for the whole table rather than mixing two meanings in one
 * column.
 *
 * @param standings - Rows {@link assignClassPositions} has already run over.
 * @param relative  - Relative rows. Mutated in place.
 */
export function copyClassPositions(
  standings: readonly StandingEntry[],
  relative: RelativeEntry[],
): void {
  if (relative.length === 0 || standings.length === 0) return;
  const bySlot = new Map<number, number>();
  for (const row of standings) {
    if (row.classPosition !== undefined) bySlot.set(row.slotId, row.classPosition);
  }
  if (bySlot.size === 0) return;
  for (const row of relative) {
    const n = bySlot.get(row.slotId);
    if (n !== undefined) row.classPosition = n;
  }
}
