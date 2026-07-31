/**
 * @file src/telemetry/referencePace.ts
 * @module telemetry/referencePace
 *
 * **Pace scoring**: how a lap compares to the pace a top driver runs in the same
 * car class at the same track layout.
 *
 * Everything numeric here comes from **Ohne Speed's LMU laptimes spreadsheet**
 * (times contributed by beAlien, Go and Hymo), baked into
 * `overlay/js/data/reference-times.json` by `scripts/fetch-reference-times.js`.
 * The Alien → Offline band labels are theirs too. This module only reads their
 * table; the attribution travels with the data and is surfaced in the UI, and
 * {@link referenceCredit} exists so no screen can show a score without being
 * able to say where it came from.
 *
 * ## What the number means
 * `percent = lapMs / referenceMs × 100`. The reference is the sheet's `~100%`
 * column, which is *race pace* for an alien in that class — not a qualifying
 * lap. 100% means you are running the pace the front of the field runs; 107% is
 * the classic cutoff, which is why the sheet's ladder stops there.
 *
 * The sheet also publishes a hotlap/qualifying benchmark per row. It is carried
 * through as {@link PaceScore.hotlapMs} for display but it is deliberately NOT
 * the denominator: it is a single number with no ladder over it, and the bands —
 * the part that turns a percentage into something a driver can act on — are
 * defined on the race-pace column alone.
 *
 * ## Why a lap can come back unscored, and why that is the point
 * LMU's REST feed names the VENUE ("Autodromo Nazionale Monza") and never the
 * layout. Monza's two layouts are ~10 s apart in GT3 and Le Mans's are ~16 s
 * apart, so picking one at random does not produce a slightly-worse score, it
 * produces a wrong one — and a driver who is told they are 9% off the pace when
 * they are on it will stop reading the number entirely.
 *
 * So resolution is tried three ways ({@link resolveLayout}) and, when none of
 * them settles it, {@link scoreLap} returns `ok: false` with a reason the UI can
 * explain. Same habit as the clean-lap rule and the damage widget: say what the
 * sim actually published, and say nothing where it did not.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/* -------------------------------------------------------------------------- */
/*  The shipped table                                                         */
/* -------------------------------------------------------------------------- */

/** Who made the reference data. Shown wherever a score is shown. */
export interface ReferenceCredit {
  title: string;
  author: string;
  contributors: string[];
  sheetUrl: string;
  discordUrl: string;
  youtubeUrl: string;
  note: string;
}

/** One rung of the sheet's ladder. `maxPercent` is inclusive; `null` = and above. */
export interface PaceBand {
  id: string;
  label: string;
  maxPercent: number | null;
}

/** One track layout, and how to recognise it coming out of a sim. */
interface RefLayout {
  id: string;
  name: string;
  sheet: string;
  lengthM: number;
  primary?: boolean;
  /** Substrings tested against `session.trackConfig`. */
  config?: string[];
  /** Substrings tested against the sim's internal (scene) track name. */
  sim?: string[];
}

interface RefCircuit {
  id: string;
  name: string;
  /** Substrings tested against the sim's display track name, lower-cased. */
  match: string[];
  layouts: RefLayout[];
}

/** How a canonical class maps onto the sheet's class rows. */
interface RefClass {
  sheet: string[];
  /** Car-model substrings that pick one specific sheet row. */
  pick?: { match: string[]; use: string }[];
  /** Row used when nothing picks. */
  default?: string;
  /** Whether falling back to `default` should be reported as an assumption. */
  defaultAssumed?: boolean;
}

/** One reference entry: a layout in a class. */
export interface RefEntry {
  /** The sheet's `~100%` race-pace baseline, milliseconds. */
  raceMs: number;
  /** The sheet's hotlap/qualifying benchmark, milliseconds. */
  hotlapMs?: number;
  /** Fastest single car in the class here, milliseconds. */
  fastestMs?: number;
  /** Which car that was, with the patch it was set on. */
  fastestCar?: string;
  /** Game patch the row is current for, e.g. `"1.3 +"`. */
  patch?: string;
}

interface RefTable {
  doc: { credit: ReferenceCredit; sheetUpdated: string; generatedAt: string };
  bands: PaceBand[];
  classes: Record<string, RefClass>;
  circuits: RefCircuit[];
  times: Record<string, Record<string, RefEntry>>;
}

/**
 * Where the generated table might be, in order.
 *
 * Two candidates rather than one because this module is loaded from three very
 * different places: `node dist/server/index.js` from the repo root, the Electron
 * main process (which requires it out of `dist/` from inside `app.asar`), and
 * the test scripts. The `__dirname`-relative path covers the packaged app, where
 * `overlay/**` and `dist/**` sit side by side inside the archive; the cwd path
 * covers a bare `tsc` output run from somewhere else.
 */
const CANDIDATES = [
  path.join(__dirname, '..', '..', 'overlay', 'js', 'data', 'reference-times.json'),
  path.join(process.cwd(), 'overlay', 'js', 'data', 'reference-times.json'),
];

let table: RefTable | null = null;
let loadTried = false;

/**
 * Load the table once, or give up quietly.
 *
 * A missing or corrupt file must degrade to "no scores" rather than throwing:
 * this is read on the hot path of every telemetry frame, and a data file is not
 * worth taking the overlay down for.
 */
function load(): RefTable | null {
  if (loadTried) return table;
  loadTried = true;
  for (const file of CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RefTable;
      if (parsed && parsed.times && parsed.circuits && parsed.bands) {
        table = parsed;
        return table;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Force a reload — for the tests, which point at a fixture. */
export function resetReferenceTable(): void {
  table = null;
  loadTried = false;
}

/** The attribution block, or `null` when the table is missing. */
export function referenceCredit(): ReferenceCredit | null {
  return load()?.doc?.credit ?? null;
}

/** When the source sheet was last updated, as the sheet itself states it. */
export function referenceUpdated(): string {
  return load()?.doc?.sheetUpdated ?? '';
}

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How far apart two layouts' nominal lengths must be before length alone is
 * allowed to choose between them.
 *
 * The sim's measured spline runs short of the published figure by a variable
 * amount — 12 m at Monza, 16 m at COTA, 27 m at Fuji — so a strict nearest-match
 * is not safe at small separations. 150 m clears every genuine pair in the table
 * (Bahrain's closest neighbours are 162 m apart) while refusing Fuji's 37 m and
 * Paul Ricard's 90 m, which is exactly the intent.
 */
const LAYOUT_SEPARATION_M = 150;

/**
 * How close two layouts' reference times must be before the primary one may be
 * assumed after resolution failed.
 *
 * In today's table nothing qualifies — every ambiguous group is at least 3.8%
 * apart — so this never fires. It exists so that a future layout pair that is
 * genuinely equivalent does not have to be special-cased.
 */
const ASSUME_PRIMARY_WITHIN = 0.01;

/** Lower-case, strip everything but letters and digits. */
function squash(value: string): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Length of the longest of `needles` found in the squashed `haystack`, or `0`.
 *
 * The LENGTH is what callers compare, not a boolean, because these patterns nest
 * by design: Paul Ricard's `1a` is a substring of its `1av2`, so a scene called
 * `PaulRicard_1AV2` matches both. Taking the longer match is the difference
 * between naming the layout the sim actually loaded and declaring a tie.
 */
function matchLen(haystack: string, needles: string[] | undefined): number {
  if (!needles || !needles.length) return 0;
  const hay = squash(haystack);
  if (!hay) return 0;
  let best = 0;
  for (const needle of needles) {
    const n = squash(needle);
    if (n && hay.includes(n) && n.length > best) best = n.length;
  }
  return best;
}

/** Whether any of `needles` appears in the squashed `haystack`. */
function hasAny(haystack: string, needles: string[] | undefined): boolean {
  return matchLen(haystack, needles) > 0;
}

/** Find the circuit whose `match` list appears in the sim's track name. */
function resolveCircuit(t: RefTable, trackName: string): RefCircuit | null {
  const name = (trackName || '').toLowerCase();
  if (!name) return null;
  let best: RefCircuit | null = null;
  let bestLen = 0;
  for (const circuit of t.circuits) {
    for (const needle of circuit.match) {
      // Longest match wins, so a venue whose alias contains another's ("le mans"
      // vs "mans") cannot be stolen by the shorter one.
      if (name.includes(needle) && needle.length > bestLen) {
        best = circuit;
        bestLen = needle.length;
      }
    }
  }
  return best;
}

/** What identified a layout — carried through so the UI can hedge honestly. */
export type LayoutVia = 'only' | 'sim-name' | 'config' | 'length' | 'assumed-primary';

export interface LayoutMatch {
  circuit: RefCircuit;
  layout: RefLayout;
  via: LayoutVia;
}

/**
 * Pick the layout inside a circuit.
 *
 * Order matters and is not arbitrary: the scene name is the only channel that
 * *states* the layout, `trackConfig` is the only one a provider declares
 * deliberately, and length is a measurement that has to be interpreted. Each
 * hint is used only when exactly one layout matches it — two matches mean the
 * hint failed to discriminate, which is different from it saying nothing.
 */
export function resolveLayout(
  circuit: RefCircuit,
  opts: { simTrackName?: string; trackConfig?: string; trackLengthM?: number },
  times: Record<string, Record<string, RefEntry>>,
): LayoutMatch | null {
  const layouts = circuit.layouts;
  const first = layouts[0];
  if (!first) return null;
  if (layouts.length === 1) return { circuit, layout: first, via: 'only' };

  /**
   * The one layout this hint names, or `null`.
   *
   * "One" means one *best* match, not one match at all: the patterns nest (Paul
   * Ricard's `1a` inside its `1av2`), so a hint that hits two layouts has still
   * discriminated if one hit is longer. A genuine tie — two layouts matched
   * equally well — means the hint failed, which is not the same as it being
   * absent, and it falls through to the next hint rather than picking a side.
   */
  const uniqueHit = (get: (l: RefLayout) => string[] | undefined, value: string | undefined) => {
    if (!value) return null;
    const scored = layouts.map((l) => ({ l, n: matchLen(value, get(l)) })).filter((h) => h.n > 0);
    if (!scored.length) return null;
    const best = Math.max(...scored.map((h) => h.n));
    const winners = scored.filter((h) => h.n === best);
    return winners.length === 1 ? winners[0]!.l : null;
  };

  const bySim = uniqueHit((l) => l.sim, opts.simTrackName);
  if (bySim) return { circuit, layout: bySim, via: 'sim-name' };

  const byConfig = uniqueHit((l) => l.config, opts.trackConfig);
  if (byConfig) return { circuit, layout: byConfig, via: 'config' };

  const measured = opts.trackLengthM || 0;
  if (measured > 1) {
    const ranked = layouts
      .map((l) => ({ l, d: Math.abs(l.lengthM - measured) }))
      .sort((a, b) => a.d - b.d);
    const winner = ranked[0]!;
    const runnerUp = ranked[1];
    if (!runnerUp || runnerUp.d - winner.d >= LAYOUT_SEPARATION_M) {
      return { circuit, layout: winner.l, via: 'length' };
    }
  }

  // Nothing settled it. Assuming the primary layout is only acceptable when the
  // layouts are near-identical in pace, so that being wrong costs almost nothing.
  const primary = layouts.find((l) => l.primary);
  if (primary) {
    const spread = paceSpread(layouts, times);
    if (spread !== null && spread <= ASSUME_PRIMARY_WITHIN) {
      return { circuit, layout: primary, via: 'assumed-primary' };
    }
  }
  return null;
}

/**
 * Widest relative gap between any two of these layouts' reference times, across
 * the classes they share. `null` when there is nothing to compare.
 */
function paceSpread(
  layouts: RefLayout[],
  times: Record<string, Record<string, RefEntry>>,
): number | null {
  let worst: number | null = null;
  const classes = new Set<string>();
  for (const l of layouts) for (const c of Object.keys(times[l.id] || {})) classes.add(c);
  for (const cls of classes) {
    const values: number[] = [];
    for (const l of layouts) {
      const entry = times[l.id]?.[cls];
      if (entry && entry.raceMs > 0) values.push(entry.raceMs);
    }
    if (values.length < 2) continue;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const rel = (hi - lo) / lo;
    if (worst === null || rel > worst) worst = rel;
  }
  return worst;
}

/**
 * Pick the sheet's class row for a canonical class and a car model.
 *
 * Only LMP2 needs the car: the sheet splits it into ELMS and WEC regulations,
 * which are a different power level rather than a different driver.
 */
function resolveClass(
  t: RefTable,
  carClass: string,
  car: string,
): { sheetClass: string; assumed: boolean } | null {
  const spec = t.classes[(carClass || '').toUpperCase()];
  if (!spec) return null;
  if (spec.sheet.length === 1) return { sheetClass: spec.sheet[0]!, assumed: false };
  for (const rule of spec.pick || []) {
    if (hasAny(car, rule.match)) return { sheetClass: rule.use, assumed: false };
  }
  if (spec.default) return { sheetClass: spec.default, assumed: spec.defaultAssumed !== false };
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                   */
/* -------------------------------------------------------------------------- */

/** Same plausibility window the lap database uses; a fragment is not a time. */
const MIN_LAP_MS = 5_000;
const MAX_LAP_MS = 3_600_000;

/** Why a lap could not be scored. Each maps to a sentence the UI can show. */
export type PaceUnknownReason =
  | 'no-table'
  | 'implausible-lap'
  | 'unknown-track'
  | 'ambiguous-layout'
  | 'unrated-class'
  | 'no-reference';

/** Everything needed to identify and score one lap. */
export interface PaceInput {
  /** Track name as the sim displays it. */
  track: string;
  /** Layout name when the provider publishes one. */
  trackConfig?: string;
  /** The sim's INTERNAL track name (scene), when shared memory gave us one. */
  simTrackName?: string;
  /** Measured lap length, metres. */
  trackLengthM?: number;
  /** Canonical class label (`"GT3"`, `"HYPERCAR"`, …). */
  carClass: string;
  /** Car model, used only to split LMP2 into its two rulesets. */
  car?: string;
  /** The lap to score, milliseconds. */
  lapMs: number;
}

/** A scored lap. */
export interface PaceScore {
  /** `lapMs / raceMs × 100`, one decimal. Below 100 is faster than the reference. */
  percent: number;
  /** Band id from the sheet's ladder, e.g. `"competitive"`. */
  bandId: string;
  /** Band label as Ohne Speed writes it, e.g. `"Competitive"`. */
  bandLabel: string;
  /** Seconds off the reference; negative when faster. */
  deltaSec: number;
  /** The race-pace baseline used, milliseconds. */
  refMs: number;
  /** The sheet's hotlap benchmark for the same row, when it has one. */
  hotlapMs?: number;
  /** Fastest car in class here, as context for a BoP outlier. */
  fastestCar?: string;
  /** Resolved layout. */
  layoutId: string;
  layoutName: string;
  circuitName: string;
  /** Which sheet class row was used (`"LMGT3"`, `"LMP2wec"`, …). */
  sheetClass: string;
  /** How the layout was identified. */
  via: LayoutVia;
  /**
   * `true` when some part of the match was assumed rather than established —
   * today only the LMP2 ruleset default. The UI must hedge when this is set.
   */
  assumed: boolean;
  /** Game patch the reference row is current for. */
  patch?: string;
}

export interface PaceResult {
  ok: boolean;
  score?: PaceScore;
  reason?: PaceUnknownReason;
  /** A short, specific sentence for the UI. Always present when `ok` is false. */
  detail?: string;
}

function bandFor(t: RefTable, percent: number): PaceBand {
  for (const band of t.bands) {
    if (band.maxPercent === null || percent <= band.maxPercent) return band;
  }
  return t.bands[t.bands.length - 1]!;
}

/**
 * Resolve a track + class to its reference row, without needing a lap time.
 *
 * Split out from {@link scoreLap} because the overlay wants to show what it is
 * comparing against — "Alien 1:59.09, GT3" — from the moment the session loads,
 * which is long before the first lap is complete.
 */
export function referenceFor(
  input: Omit<PaceInput, 'lapMs'>,
): PaceResult & { entry?: RefEntry } {
  const t = load();
  if (!t) {
    return { ok: false, reason: 'no-table', detail: 'Reference times are not installed.' };
  }

  const circuit = resolveCircuit(t, input.track);
  if (!circuit) {
    return {
      ok: false,
      reason: 'unknown-track',
      detail: `No reference times for ${input.track || 'this track'}.`,
    };
  }

  const match = resolveLayout(
    circuit,
    {
      simTrackName: input.simTrackName,
      trackConfig: input.trackConfig,
      trackLengthM: input.trackLengthM,
    },
    t.times,
  );
  if (!match) {
    return {
      ok: false,
      reason: 'ambiguous-layout',
      detail:
        `${circuit.name} has ${circuit.layouts.length} layouts with reference times and ` +
        `the sim did not say which one this is.`,
    };
  }

  const cls = resolveClass(t, input.carClass, input.car || '');
  if (!cls) {
    return {
      ok: false,
      reason: 'unrated-class',
      detail: input.carClass
        ? `No reference times for ${input.carClass}.`
        : 'Car class unknown.',
    };
  }

  const entry = t.times[match.layout.id]?.[cls.sheetClass];
  if (!entry || !(entry.raceMs > 0)) {
    return {
      ok: false,
      reason: 'no-reference',
      detail: `No ${cls.sheetClass} reference for ${match.layout.name}.`,
    };
  }

  return {
    ok: true,
    entry,
    score: {
      percent: 0,
      bandId: '',
      bandLabel: '',
      deltaSec: 0,
      refMs: entry.raceMs,
      ...(entry.hotlapMs ? { hotlapMs: entry.hotlapMs } : {}),
      ...(entry.fastestCar ? { fastestCar: entry.fastestCar } : {}),
      layoutId: match.layout.id,
      layoutName: match.layout.name,
      circuitName: circuit.name,
      sheetClass: cls.sheetClass,
      via: match.via,
      assumed: cls.assumed || match.via === 'assumed-primary',
      ...(entry.patch ? { patch: entry.patch } : {}),
    },
  };
}

/**
 * Score one lap against the reference for its track layout and class.
 *
 * Returns `ok: false` with a reason rather than a fallback number whenever the
 * combination cannot be pinned down — see the module note on why a wrong score
 * is worse than no score.
 */
export function scoreLap(input: PaceInput): PaceResult {
  if (!(input.lapMs >= MIN_LAP_MS && input.lapMs <= MAX_LAP_MS)) {
    return { ok: false, reason: 'implausible-lap', detail: 'That is not a lap time.' };
  }
  const ref = referenceFor(input);
  if (!ref.ok || !ref.score || !ref.entry) return ref;

  const t = load()!;
  const percent = Math.round((input.lapMs / ref.entry.raceMs) * 1000) / 10;
  const band = bandFor(t, percent);
  return {
    ok: true,
    score: {
      ...ref.score,
      percent,
      bandId: band.id,
      bandLabel: band.label,
      deltaSec: Math.round(input.lapMs - ref.entry.raceMs) / 1000,
    },
  };
}

/** The full ladder, for a UI that wants to draw it. */
export function paceBands(): PaceBand[] {
  return load()?.bands ?? [];
}
