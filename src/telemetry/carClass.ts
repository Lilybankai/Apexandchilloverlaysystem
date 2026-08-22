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
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return ALIASES[key(trimmed)] ?? trimmed.toUpperCase();
}

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
 * @param rows - Standings rows, pre-sorted by overall position. Mutated in place.
 */
export function assignClassPositions(rows: StandingEntry[]): void {
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

    row.classLapsBehind = Math.max(0, row.lapsBehind - leader.lapsBehind);

    const own = row.gapToLeaderSec;
    const lead = leader.gapToLeaderSec;
    row.gapToClassLeaderSec =
      row === leader
        ? 0
        : row.classLapsBehind === 0 && own !== UNKNOWN_VALUE && lead !== UNKNOWN_VALUE
          ? Math.round((own - lead) * 100) / 100
          : UNKNOWN_VALUE;
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
