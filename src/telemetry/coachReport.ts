/**
 * coachReport.ts — the driving coach's words, made from the numbers alone.
 * =============================================================================
 *
 * 2026-10-29 (the AI driving coach, `coachContract.ts`). Everything the coach
 * says starts here, as TEMPLATE sentences built from measured numbers; the
 * optional AI narrative (`supabase/functions/coach`) may only re-word and rank
 * what this module produced, citing the facts by id. So this is the layer that
 * must never be wrong: a sentence that blames the wrong corner, or tells a
 * driver who already brakes late to brake later, does not look broken — it
 * looks like advice.
 *
 *   buildSessionCoach(review, laps, opts) → CoachReport   (scope 'session')
 *     A practice session: which corners cost time lap after lap, the pattern
 *     behind them, where the potential sits, and a realistic next target.
 *
 *   buildLapCoach(input) → CoachReport                    (scope 'lap')
 *     One lap against its reference (the Practice deep dive, the Review tab).
 *
 *   applyAi(report, ai) → CoachReport                     (source 'ai')
 *     The AI's validated words laid over the template report: its headline
 *     and takeaways, the template's chips and tones, the template's numbers.
 *
 * ## Two sources of per-corner numbers
 * The engine (`timeLoss.lapLoss`, claude/coach-engine) splits each lap per
 * corner and per phase, exactly additive. Until it lands — and on any lap it
 * could not split — the per-corner numbers come from the Practice Review's own
 * `cornerResult()` rows (time through the corner, braking point, apex speed),
 * which have no phases. Both feed the same {@link CornerStat}, so the words
 * read the same either way; the phase-split ones are simply sharper.
 *
 * ## What is never the driver's fault
 * A breakdown corner's `straightSec` (with `straightFlag` 'tow' or 'car') is
 * time that grew along a straight at equal throttle with no worse exit: a tow
 * or a faster car. It is taken out of every loss this module ranks, explains
 * or aims at. It appears once, as a fact saying whose it is.
 *
 * ## Signs (pinned in coachContract.ts)
 * Positive seconds = LOSING. Positive brake delta = braked LATER. Positive
 * speed delta = FASTER. Positive pick-up delta = back on the throttle LATER.
 *
 * Pure: no fs, no clock, no Electron. `coachLoad.ts` does the reading; the
 * time stamp is the caller's (`generatedAt`), so the same input gives the
 * same report byte for byte.
 */

import {
  COACH_PHASES,
  type CoachCornerItem,
  type CoachFact,
  type CoachPhase,
  type CoachReport,
  type CoachTakeaway,
  type CoachAiResult,
  type CornerPhaseLoss,
  type CornerSequence,
  type FairnessFlag,
  type LapLossBreakdown,
} from './coachContract';
import type { PracticeReview } from './practiceReview';

/** Bump when the shape or the template wording changes: it keys every cache. */
export const COACH_REPORT_VERSION = 1;

/** A corner within this many seconds of the reference is "matched" (training-laps.js's band). */
export const LEVEL_SEC = 0.02;
/** "Where time is lost": this many corners at most. */
export const WORST_MAX = 3;
export const TAKEAWAYS_MAX = 3;
/** Share of the top items' loss a realistic next run wins back. */
export const AIM_SHARE = 0.7;
/** Priority bands, seconds per lap. */
export const HIGH_SEC = 0.15;
export const MEDIUM_SEC = 0.07;
/** Smallest differences worth a word (the Corner Analysis card's thresholds). */
const BRAKE_M = 3;
const APEX_KPH = 1;
const PICKUP_M = 5;
/** Corners carried into the facts (the AI's whole view); ranked by loss. */
const FACT_CORNERS_MAX = 8;

/* -------------------------------------------------------------------------- */
/*  Inputs                                                                    */
/* -------------------------------------------------------------------------- */

export interface CoachSessionOpts {
  sessionId: string;
  /** Sequences across the session's laps (`cornerSequences.sessionSequences`). */
  sequences: readonly CornerSequence[];
  /** Flags on the target (`fairTarget.assessTarget`); passed through untouched. */
  fairness: readonly FairnessFlag[];
  /** A leaderboard lap the session is measured against instead (fair builder). */
  targetLapId?: string | null;
  /**
   * Lap ids aligned with `review.laps` (null where a lap has none): which
   * breakdown belongs to which lap, and which lap IS the target. Optional —
   * without it the breakdowns are taken in the order given.
   */
  lapIds?: readonly (string | null)[];
  /** Sector times, seconds, aligned with `review.laps` (null = not known). */
  sectorTimes?: readonly ((readonly [number | null, number | null, number | null]) | null)[];
  /** Where the two sector lines fall, lap fractions (`lapDetail.sectorMarks`). */
  sectorD?: { s1: number | null; s2: number | null } | null;
  /** ISO time stamped on the report; defaults to the session's end. */
  generatedAt?: string;
}

/** One corner of a lap, when there is no phase split: the Practice Review's own row. */
export interface CoachFallbackRow {
  id: string;
  entryD?: number;
  exitD?: number;
  /** Time through the corner, you − reference. Positive = slower. */
  deltaSec: number | null;
  /** Positive = braked LATER. */
  brakeDeltaM: number | null;
  /** Positive = FASTER at the apex. */
  apexKphDelta: number | null;
  exitKphDelta?: number | null;
}

export interface CoachLapInput {
  sessionId: string;
  lapId: string;
  /** The engine's split of this lap; null or empty → `rows`. */
  breakdown: LapLossBreakdown | null;
  rows?: readonly CoachFallbackRow[];
  /** The studied lap's official time and the reference's. */
  lapSec: number | null;
  refSec: number | null;
  /** The reference's label ("Session best · 1:19.837", a board driver …). */
  refLabel?: string | null;
  /** The session's theoretical best: the floor of the aim. */
  theoreticalBestSec?: number | null;
  sequences?: readonly CornerSequence[];
  fairness?: readonly FairnessFlag[];
  trackLengthM: number;
  sectorD?: { s1: number | null; s2: number | null } | null;
  generatedAt?: string;
}

/* -------------------------------------------------------------------------- */
/*  Small numerics and words                                                  */
/* -------------------------------------------------------------------------- */

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const mean = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function stdev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/** 0.2234 → "0.22 s". Always two decimals: the panel's own style. */
export const fmtSec = (v: number): string => `${Math.abs(v).toFixed(2)} s`;

/** 220.195 → "3:40.195". */
export function fmtLap(sec: number): string {
  const ms = Math.round(sec * 1000);
  const m = Math.floor(ms / 60000);
  const s = (ms - m * 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** 217.84 → "3:37.8": an aim is a tenth, never a thousandth. */
export function fmtAim(sec: number): string {
  const tenths = Math.round(sec * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** ["C13", "C5", "C12"] → "C13, C5 and C12". */
export function listWords(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const PHASE_WHERE: Record<CoachPhase, string> = {
  braking: 'under braking',
  turnIn: 'on turn-in',
  midCorner: 'mid-corner',
  exit: 'on the exit',
  exitRun: 'on the run to the next corner',
};

const SECTOR_WORD = ['first', 'middle', 'final'] as const;

/* -------------------------------------------------------------------------- */
/*  One corner, however it was measured                                       */
/* -------------------------------------------------------------------------- */

/**
 * A corner as the words see it. Every loss here is DRIVER-ATTRIBUTABLE: a
 * flagged straight's time is already out.
 */
export interface CornerStat {
  id: string;
  entryD: number | null;
  exitD: number | null;
  /** Per lap, in lap order; null = not scored on that lap. */
  perLap: (number | null)[];
  /** Mean over the scored laps. */
  lossSec: number;
  /** Scored laps. */
  laps: number;
  /** Scored laps that lost more than {@link LEVEL_SEC} here. */
  losing: number;
  /** Mean per phase (breakdowns only), driver-attributable. */
  phases: Record<CoachPhase, number> | null;
  brakeDeltaM: number | null;
  minKphDelta: number | null;
  exitKphDelta: number | null;
  pickupDeltaM: number | null;
  /** Mean flagged straight time, and whose it was (the commoner flag). */
  straightSec: number;
  straightFlag: 'tow' | 'car' | null;
}

/** A breakdown corner's loss that is the driver's. */
export function driverLoss(c: Pick<CornerPhaseLoss, 'lossSec' | 'straightFlag' | 'straightSec'>): number {
  const straight = c.straightFlag && finite(c.straightSec) && c.straightSec > 0 ? c.straightSec : 0;
  return c.lossSec - straight;
}

interface CornerSample {
  loss: number;
  phases: Record<CoachPhase, number> | null;
  brakeDeltaM: number | null;
  minKphDelta: number | null;
  exitKphDelta: number | null;
  pickupDeltaM: number | null;
  straightSec: number;
  straightFlag: 'tow' | 'car' | null;
  entryD: number | null;
  exitD: number | null;
}

function sampleOfPhaseLoss(c: CornerPhaseLoss, L: number): CornerSample {
  const straight = c.straightFlag && finite(c.straightSec) && c.straightSec > 0 ? c.straightSec : 0;
  const phases = {} as Record<CoachPhase, number>;
  for (const p of COACH_PHASES) phases[p] = finite(c.phases?.[p]) ? c.phases[p] : 0;
  // The flagged time sits on the exit run: take it out there.
  phases.exitRun -= straight;
  const diff = (a: number | null | undefined, b: number | null | undefined): number | null =>
    finite(a) && finite(b) ? a - b : null;
  const m = c.mine || ({} as CornerPhaseLoss['mine']);
  const f = c.ref || ({} as CornerPhaseLoss['ref']);
  const brake = diff(m.brakeOnD, f.brakeOnD);
  const pickup = diff(m.pickupD, f.pickupD);
  return {
    loss: c.lossSec - straight,
    phases,
    brakeDeltaM: brake === null || !(L > 0) ? null : brake * L,
    minKphDelta: diff(m.minKph, f.minKph),
    exitKphDelta: diff(m.exitKph, f.exitKph),
    pickupDeltaM: pickup === null || !(L > 0) ? null : pickup * L,
    straightSec: straight,
    straightFlag: straight > 0 ? c.straightFlag : null,
    entryD: finite(c.entryD) ? c.entryD : null,
    exitD: finite(c.exitD) ? c.exitD : null,
  };
}

function sampleOfRow(r: CoachFallbackRow): CornerSample | null {
  if (!finite(r.deltaSec)) return null;
  return {
    loss: r.deltaSec,
    phases: null,
    brakeDeltaM: finite(r.brakeDeltaM) ? r.brakeDeltaM : null,
    minKphDelta: finite(r.apexKphDelta) ? r.apexKphDelta : null,
    exitKphDelta: finite(r.exitKphDelta) ? r.exitKphDelta : null,
    pickupDeltaM: null,
    straightSec: 0,
    straightFlag: null,
    entryD: finite(r.entryD) ? r.entryD : null,
    exitD: finite(r.exitD) ? r.exitD : null,
  };
}

/** Fold one corner's samples (a column of laps, null = not scored) into a stat. */
function statOf(id: string, samples: readonly (CornerSample | null)[]): CornerStat {
  const got = samples.filter((s): s is CornerSample => !!s);
  const avg = (pick: (s: CornerSample) => number | null): number | null => mean(got.map(pick).filter(finite));
  let phases: Record<CoachPhase, number> | null = null;
  const withPhases = got.filter((s) => s.phases);
  if (withPhases.length) {
    phases = {} as Record<CoachPhase, number>;
    for (const p of COACH_PHASES) phases[p] = mean(withPhases.map((s) => s.phases![p]))!;
  }
  const tows = got.filter((s) => s.straightFlag === 'tow').length;
  const cars = got.filter((s) => s.straightFlag === 'car').length;
  const first = got[0];
  return {
    id,
    entryD: first ? first.entryD : null,
    exitD: first ? first.exitD : null,
    perLap: samples.map((s) => (s ? r3(s.loss) : null)),
    lossSec: mean(got.map((s) => s.loss)) ?? 0,
    laps: got.length,
    losing: got.filter((s) => s.loss > LEVEL_SEC).length,
    phases,
    brakeDeltaM: avg((s) => s.brakeDeltaM),
    minKphDelta: avg((s) => s.minKphDelta),
    exitKphDelta: avg((s) => s.exitKphDelta),
    pickupDeltaM: avg((s) => s.pickupDeltaM),
    straightSec: mean(got.map((s) => s.straightSec)) ?? 0,
    straightFlag: tows + cars === 0 ? null : tows >= cars ? 'tow' : 'car',
  };
}

/** The phase most of a corner's loss sits in; without a split, read from the symptoms. */
export function mainPhase(s: CornerStat): CoachPhase {
  if (s.phases) {
    let best: CoachPhase = 'braking';
    for (const p of COACH_PHASES) if (s.phases[p] > s.phases[best]) best = p;
    return best;
  }
  if (finite(s.brakeDeltaM) && Math.abs(s.brakeDeltaM) >= BRAKE_M) return 'braking';
  if (finite(s.minKphDelta) && s.minKphDelta <= -APEX_KPH) return 'midCorner';
  return 'exit';
}

/**
 * 0..1: how much this corner's loss is a habit. The share of laps it lost
 * time here, shrunk for few laps (one lap is never a habit) and for a loss
 * that swings wildly lap to lap.
 */
export function confidenceOf(s: CornerStat): number {
  if (s.laps <= 0) return 0;
  const share = s.losing / s.laps;
  const shrink = s.laps / (s.laps + 1);
  const xs = s.perLap.filter(finite);
  const sd = stdev(xs);
  const cv = sd !== null && Math.abs(s.lossSec) > 1e-6 ? Math.min(1, sd / Math.abs(s.lossSec)) : 0;
  return r2(Math.max(0, Math.min(1, share * shrink * (1 - 0.3 * cv))));
}

export function priorityOf(lossSec: number): 'high' | 'medium' | 'low' {
  return lossSec >= HIGH_SEC ? 'high' : lossSec >= MEDIUM_SEC ? 'medium' : 'low';
}

/**
 * One line of advice for a losing corner, in the Practice panel's words
 * (practice-panel.js `tipWords`, practiceLap.ts `cornerTip`):
 * "Brake 5 m later and carry 4 km/h more to the apex."
 */
export function coachTip(s: CornerStat): string {
  const parts: string[] = [];
  const b = s.brakeDeltaM;
  const a = s.minKphDelta;
  if (finite(b) && b <= -BRAKE_M) parts.push(`brake ${Math.round(-b)} m later`);
  else if (finite(b) && b >= BRAKE_M && finite(a) && a <= -APEX_KPH) parts.push(`brake ${Math.round(b)} m earlier`);
  if (finite(a) && a <= -APEX_KPH) parts.push(`carry ${Math.round(-a)} km/h more to the apex`);
  const p = s.pickupDeltaM;
  if (finite(p) && p >= PICKUP_M) parts.push(`get back on the throttle ${Math.round(p)} m sooner`);
  else if (!parts.length && s.phases && (mainPhase(s) === 'exit' || mainPhase(s) === 'exitRun')) {
    parts.push('be more patient on entry and drive out harder');
  }
  if (!parts.length) {
    return s.phases && mainPhase(s) === 'turnIn'
      ? 'Turn in more smoothly — the time goes before the apex.'
      : 'Entry and apex match the reference — the time goes on the way out. Look at your throttle pick-up.';
  }
  const text = parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join(' and ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/* -------------------------------------------------------------------------- */
/*  Facts                                                                     */
/* -------------------------------------------------------------------------- */

class Facts {
  readonly list: CoachFact[] = [];
  private readonly ids = new Set<string>();
  add(f: CoachFact): string {
    if (!this.ids.has(f.id)) {
      this.ids.add(f.id);
      this.list.push({ ...f, value: r3(f.value) });
    }
    return f.id;
  }
  has(id: string): boolean {
    return this.ids.has(id);
  }
}

/** A corner's facts. `lapScope` changes the tense, never the numbers. */
function cornerFacts(F: Facts, s: CornerStat, lapScope: boolean): string[] {
  const ids: string[] = [];
  const id = s.id;
  ids.push(
    F.add({
      id: `${id}.loss`,
      cornerId: id,
      kind: 'cornerLoss',
      value: s.lossSec,
      unit: 's',
      text: lapScope
        ? s.lossSec >= 0
          ? `${id} cost ${fmtSec(s.lossSec)} on this lap.`
          : `${id} gained ${fmtSec(s.lossSec)} on this lap.`
        : s.lossSec >= 0
          ? `${id} costs ${fmtSec(s.lossSec)} a lap on average.`
          : `${id} gains ${fmtSec(s.lossSec)} a lap on average.`,
    }),
  );
  if (s.phases) {
    for (const p of COACH_PHASES) {
      const v = s.phases[p];
      if (!(Math.abs(v) >= 0.01)) continue;
      ids.push(
        F.add({
          id: `${id}.${p}.loss`,
          cornerId: id,
          phase: p,
          kind: 'phaseLoss',
          value: v,
          unit: 's',
          text: `${id}: ${fmtSec(v)} ${v > 0 ? 'lost' : 'gained'} ${PHASE_WHERE[p]}.`,
        }),
      );
    }
  }
  if (finite(s.brakeDeltaM)) {
    const m = Math.round(Math.abs(s.brakeDeltaM));
    ids.push(
      F.add({
        id: `${id}.brakeDeltaM`,
        cornerId: id,
        phase: 'braking',
        kind: 'brakeDeltaM',
        value: s.brakeDeltaM,
        unit: 'm',
        text:
          Math.abs(s.brakeDeltaM) < BRAKE_M
            ? `${id}: you brake at the same point as the target.`
            : `${id}: you brake ${m} m ${s.brakeDeltaM < 0 ? 'earlier' : 'later'} than the target.`,
      }),
    );
  }
  if (finite(s.minKphDelta)) {
    const k = Math.round(Math.abs(s.minKphDelta));
    ids.push(
      F.add({
        id: `${id}.minKphDelta`,
        cornerId: id,
        phase: 'midCorner',
        kind: 'minKphDelta',
        value: s.minKphDelta,
        unit: 'kph',
        text:
          Math.abs(s.minKphDelta) < APEX_KPH
            ? `${id}: the same minimum speed as the target.`
            : `${id}: ${k} km/h ${s.minKphDelta < 0 ? 'slower' : 'faster'} at the apex than the target.`,
      }),
    );
  }
  if (finite(s.exitKphDelta) && Math.abs(s.exitKphDelta) >= APEX_KPH) {
    ids.push(
      F.add({
        id: `${id}.exitKphDelta`,
        cornerId: id,
        phase: 'exit',
        kind: 'exitKphDelta',
        value: s.exitKphDelta,
        unit: 'kph',
        text: `${id}: ${Math.round(Math.abs(s.exitKphDelta))} km/h ${s.exitKphDelta < 0 ? 'slower' : 'faster'} on the exit.`,
      }),
    );
  }
  if (finite(s.pickupDeltaM) && Math.abs(s.pickupDeltaM) >= PICKUP_M) {
    ids.push(
      F.add({
        id: `${id}.pickupDeltaM`,
        cornerId: id,
        phase: 'exit',
        kind: 'pickupDeltaM',
        value: s.pickupDeltaM,
        unit: 'm',
        text: `${id}: back on the throttle ${Math.round(Math.abs(s.pickupDeltaM))} m ${s.pickupDeltaM > 0 ? 'later' : 'earlier'} than the target.`,
      }),
    );
  }
  if (!lapScope && s.laps >= 2) {
    ids.push(
      F.add({
        id: `${id}.consistency`,
        cornerId: id,
        kind: 'consistency',
        value: s.losing,
        unit: 'laps',
        text: `${id} lost time on ${s.losing} of ${s.laps} laps.`,
      }),
    );
  }
  if (s.straightFlag && s.straightSec >= 0.01) {
    ids.push(
      F.add({
        id: `${id}.straight`,
        cornerId: id,
        phase: 'exitRun',
        kind: 'straightTime',
        value: s.straightSec,
        unit: 's',
        text:
          s.straightFlag === 'tow'
            ? `${id}: ${fmtSec(s.straightSec)} on the straight after it came from a tow, not your driving.`
            : `${id}: ${fmtSec(s.straightSec)} on the straight after it is straight-line speed, not your driving.`,
      }),
    );
  }
  return ids;
}

function sequenceFacts(F: Facts, seqs: readonly CornerSequence[]): string[] {
  const ids: string[] = [];
  for (const q of seqs) {
    if (!q || !Array.isArray(q.cornerIds) || q.cornerIds.length < 2 || !finite(q.lossSec)) continue;
    const name = `${q.cornerIds[0]}-${q.cornerIds[q.cornerIds.length - 1]}`;
    const words = listWords(q.cornerIds);
    const v = q.lossSec;
    const sign = v >= 0 ? `${fmtSec(v)} lost` : `${fmtSec(v)} gained`;
    const text =
      q.kind === 'trade'
        ? `${words} trade time between them: drive them as one, ${sign} over the whole sequence.`
        : q.kind === 'carry'
          ? `A loss early in ${words} carries through the sequence: ${sign} over it.`
          : `${words} are one piece of road: ${sign} over them.`;
    ids.push(F.add({ id: `seq.${name}.loss`, cornerId: q.cornerIds[0], kind: 'sequenceLoss', value: v, unit: 's', text }));
  }
  return ids;
}

function fairnessFacts(F: Facts, flags: readonly FairnessFlag[]): void {
  for (const f of flags) {
    if (!f || !f.text) continue;
    F.add({
      id: `fair.${f.kind}`,
      kind: 'fairness',
      value: finite(f.estSec) ? f.estSec : 0,
      unit: 's',
      text: String(f.text),
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Patterns, sectors, the aim                                                */
/* -------------------------------------------------------------------------- */

type PatternKind = 'brakeEarly' | 'overdrive' | 'apexSlow' | 'exit';

interface Pattern {
  kind: PatternKind;
  corners: CornerStat[];
  sec: number;
}

/** Which fault a losing corner shows. Braking first: it decides everything after it. */
function patternOf(s: CornerStat): PatternKind {
  const b = s.brakeDeltaM;
  const a = s.minKphDelta;
  if (finite(b) && b <= -BRAKE_M) return 'brakeEarly';
  if (finite(b) && b >= BRAKE_M && finite(a) && a <= -APEX_KPH) return 'overdrive';
  if (finite(a) && a <= -APEX_KPH) return 'apexSlow';
  return 'exit';
}

function findPattern(stats: readonly CornerStat[]): Pattern | null {
  const groups = new Map<PatternKind, CornerStat[]>();
  for (const s of stats) {
    if (!(s.lossSec > LEVEL_SEC)) continue;
    const k = patternOf(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  let best: Pattern | null = null;
  for (const [kind, corners] of groups) {
    const sec = corners.reduce((a, c) => a + c.lossSec, 0);
    // Two corners make a pattern; one corner is a corner. Prefer patterns.
    const weight = sec * (corners.length >= 2 ? 1.25 : 1);
    if (!best || weight > best.sec * (best.corners.length >= 2 ? 1.25 : 1)) best = { kind, corners, sec };
  }
  if (best) best.corners = [...best.corners].sort((a, b) => b.lossSec - a.lossSec || a.id.localeCompare(b.id));
  return best;
}

const PATTERN_WORDS: Record<PatternKind, { many: string; one: (id: string) => string; doing: string }> = {
  brakeEarly: { many: 'Braking too early in key corners', one: (id) => `Braking too early into ${id}`, doing: 'braking early' },
  overdrive: { many: 'Over-driving the entries', one: (id) => `Over-driving the entry to ${id}`, doing: 'braking too late and killing the apex speed' },
  apexSlow: { many: 'Too slow through the middle', one: (id) => `Too slow through ${id}`, doing: 'carrying too little speed to the apex' },
  exit: { many: 'Losing it on the way out', one: (id) => `Losing the exit of ${id}`, doing: 'a late or hesitant exit' },
};

function patternTakeaway(F: Facts, p: Pattern, lapScope: boolean): CoachTakeaway {
  const ids = p.corners.map((c) => c.id);
  const words = PATTERN_WORDS[p.kind];
  const sec = p.sec;
  const factId = F.add({
    id: `pattern.${p.kind}`,
    kind: 'pattern',
    value: sec,
    unit: 's',
    text: `${words.doing.charAt(0).toUpperCase()}${words.doing.slice(1)} costs ${fmtSec(sec)} ${lapScope ? 'on this lap' : 'a lap'} across ${listWords(ids)}.`,
  });
  const named = ids.slice(0, 2);
  const body =
    ids.length >= 2
      ? `You're losing time by ${words.doing} in ${ids.length} corners, particularly ${listWords(named)}.`
      : `You're losing time by ${words.doing} in ${ids[0]}.`;
  return {
    title: ids.length >= 2 ? words.many : words.one(ids[0]!),
    body,
    chip: `≈${fmtSec(sec)} total`,
    tone: 'loss',
    cornerIds: ids,
    factIds: [factId, ...ids.map((id) => `${id}.loss`).filter((id) => F.has(id))],
  };
}

/** The sector (0..2) a lap fraction falls in, or null without both lines. */
function sectorOf(d: number | null, lines: { s1: number | null; s2: number | null } | null | undefined): number | null {
  if (!lines || !finite(d) || !finite(lines.s1) || !finite(lines.s2)) return null;
  return d < lines.s1 ? 0 : d < lines.s2 ? 1 : 2;
}

interface SectorPotential {
  sector: number;
  sec: number;
  /** 'times': best lap's sector vs the best of that sector; 'corners': summed corner losses. */
  basis: 'times' | 'corners';
  corners: string[];
}

function sectorTakeaway(F: Facts, sp: SectorPotential): CoachTakeaway {
  const n = sp.sector + 1;
  const factId = F.add({
    id: `S${n}.loss`,
    kind: 'sectorLoss',
    value: sp.sec,
    unit: 's',
    text:
      sp.basis === 'times'
        ? `Sector ${n} is ${fmtSec(sp.sec)} off your theoretical.`
        : `Sector ${n} holds ${fmtSec(sp.sec)} of the gap.`,
  });
  const named = sp.corners.slice(0, 2);
  const body =
    (sp.basis === 'times'
      ? `Sector ${n} is ${fmtSec(sp.sec)} off your theoretical.`
      : `Sector ${n} holds ${fmtSec(sp.sec)} of the gap.`) +
    (named.length ? ` ${listWords(named)} ${named.length > 1 ? 'are' : 'is'} the main ${named.length > 1 ? 'opportunities' : 'opportunity'}.` : '');
  return {
    title: `Biggest gains in ${SECTOR_WORD[sp.sector]} sector`,
    body,
    chip: `${fmtSec(sp.sec)} potential`,
    tone: 'potential',
    cornerIds: named,
    factIds: [factId, ...named.map((id) => `${id}.loss`).filter((id) => F.has(id))],
  };
}

/** Words for what to work on, from the phases the top corners lose in. */
function focusWords(top: readonly CornerStat[]): string {
  const want: string[] = [];
  const push = (w: string): void => {
    if (!want.includes(w)) want.push(w);
  };
  for (const s of top) {
    const k = patternOf(s);
    if (k === 'brakeEarly') push('later braking');
    else if (k === 'overdrive') push('a calmer entry');
    else if (k === 'apexSlow') push('apex speed');
    else push('corner exit');
    if (want.length >= 2) break;
  }
  return want.length ? listWords(want) : 'a cleaner lap';
}

/**
 * A realistic next target: `best − AIM_SHARE × (what the top items cost)`,
 * never quicker than the theoretical best and never slower than the best.
 * Null without a best or when there is nothing to win back.
 */
export function aimFor(bestSec: number | null, topLossSec: number, theoreticalSec: number | null | undefined): number | null {
  if (!finite(bestSec) || bestSec <= 0) return null;
  const gain = Math.max(0, topLossSec) * AIM_SHARE;
  if (!(gain >= 0.05)) return null;
  let aim = bestSec - gain;
  if (finite(theoreticalSec) && theoreticalSec > 0) aim = Math.max(aim, theoreticalSec);
  if (!(aim < bestSec - 0.0005)) return null;
  return r3(aim);
}

function targetTakeaway(F: Facts, top: readonly CornerStat[], aim: number, lapScope: boolean): CoachTakeaway {
  const ids = top.map((s) => s.id);
  const factId = F.add({ id: 'session.aimFor', kind: 'aimFor', value: aim, unit: 's', text: `Aim for ${fmtAim(aim)}.` });
  const focus = focusWords(top);
  return {
    title: `Focus on ${focus}`,
    body: `Put ${listWords(ids)} right and ${fmtAim(aim)} is within reach${lapScope ? ' on your next lap' : ' on your next run'}.`,
    chip: `Aim for ${fmtAim(aim)}`,
    tone: 'target',
    cornerIds: ids,
    factIds: [factId, ...ids.map((id) => `${id}.loss`).filter((id) => F.has(id))],
  };
}

/** Sector potential from summed corner losses (a lap, or a session without sector times). */
function sectorFromCorners(stats: readonly CornerStat[], lines: CoachSessionOpts['sectorD']): SectorPotential | null {
  const sums = [0, 0, 0];
  const names: CornerStat[][] = [[], [], []];
  for (const s of stats) {
    const k = sectorOf(s.entryD, lines);
    if (k === null || !(s.lossSec > LEVEL_SEC)) continue;
    sums[k]! += s.lossSec;
    names[k]!.push(s);
  }
  let k = 0;
  for (let i = 1; i < 3; i += 1) if (sums[i]! > sums[k]!) k = i;
  if (!(sums[k]! >= 0.05)) return null;
  return {
    sector: k,
    sec: sums[k]!,
    basis: 'corners',
    corners: names[k]!.sort((a, b) => b.lossSec - a.lossSec).map((s) => s.id),
  };
}

/* -------------------------------------------------------------------------- */
/*  Assembly shared by both scopes                                            */
/* -------------------------------------------------------------------------- */

function worstItems(F: Facts, stats: readonly CornerStat[]): CoachCornerItem[] {
  return stats
    .filter((s) => s.laps > 0 && s.lossSec > LEVEL_SEC)
    .sort((a, b) => b.lossSec - a.lossSec || a.id.localeCompare(b.id))
    .slice(0, WORST_MAX)
    .map((s) => ({
      id: s.id,
      lossSec: r3(s.lossSec),
      priority: priorityOf(s.lossSec),
      phase: mainPhase(s),
      tip: coachTip(s),
      confidence: confidenceOf(s),
      perLapSec: s.perLap,
      factIds: [`${s.id}.loss`, `${s.id}.brakeDeltaM`, `${s.id}.minKphDelta`, `${s.id}.${mainPhase(s)}.loss`, `${s.id}.consistency`].filter((id) =>
        F.has(id),
      ),
    }));
}

function headlineOf(worst: readonly CoachCornerItem[], lapScope: boolean): string {
  if (!worst.length) return lapScope ? 'A clean match for the reference — nothing stands out.' : 'Session analysed — no corner stands out against the target.';
  const ids = worst.map((w) => w.id);
  const sec = worst.reduce((a, w) => a + w.lossSec, 0);
  return ids.length === 1
    ? `Most time goes in ${ids[0]} — ${fmtSec(sec)} ${lapScope ? 'on this lap' : 'a lap'}.`
    : `Most time goes in ${listWords(ids)} — ${fmtSec(sec)} ${lapScope ? 'on this lap' : 'a lap'} between them.`;
}

function assemble(args: {
  F: Facts;
  stats: CornerStat[];
  lapScope: boolean;
  sequences: readonly CornerSequence[];
  fairness: readonly FairnessFlag[];
  sector: SectorPotential | null;
  bestSec: number | null;
  theoreticalSec: number | null;
  potentialFallback: CoachTakeaway | null;
}): { worst: CoachCornerItem[]; takeaways: CoachTakeaway[]; aimForSec: number | null; headline: string } {
  const { F, lapScope } = args;
  const ranked = [...args.stats].sort((a, b) => b.lossSec - a.lossSec || a.id.localeCompare(b.id));
  // Facts first for the corners worth talking about, so every id cited below exists.
  for (const s of ranked.slice(0, FACT_CORNERS_MAX)) if (s.laps > 0) cornerFacts(F, s, lapScope);
  sequenceFacts(F, args.sequences);
  fairnessFacts(F, args.fairness);

  const worst = worstItems(F, args.stats);
  const top = ranked.filter((s) => s.laps > 0 && s.lossSec > LEVEL_SEC).slice(0, WORST_MAX);
  const aim = aimFor(args.bestSec, top.reduce((a, s) => a + s.lossSec, 0), args.theoreticalSec);

  const takeaways: CoachTakeaway[] = [];
  const pattern = findPattern(args.stats);
  if (pattern) takeaways.push(patternTakeaway(F, pattern, lapScope));
  if (args.sector) takeaways.push(sectorTakeaway(F, args.sector));
  else if (args.potentialFallback) takeaways.push(args.potentialFallback);
  if (aim !== null && top.length) takeaways.push(targetTakeaway(F, top, aim, lapScope));

  return { worst, takeaways: takeaways.slice(0, TAKEAWAYS_MAX), aimForSec: aim, headline: headlineOf(worst, lapScope) };
}

/* -------------------------------------------------------------------------- */
/*  Session scope                                                             */
/* -------------------------------------------------------------------------- */

const cornerIdOf = (c: { index: number; id?: unknown }): string =>
  typeof c.id === 'string' && c.id ? c.id : `C${c.index + 1}`;

/** Lap indices (into review.laps) that count: valid, and not the target itself. */
function countedLaps(review: PracticeReview, lapIds?: readonly (string | null)[]): boolean[] {
  const t = review.target;
  return review.laps.map((lap, i) => {
    if (!lap.valid) return false;
    if (t && t.kind === 'sessionBest') {
      // The lap the session is measured against scores zero against itself.
      if (lapIds && lapIds[i]) return lapIds[i] !== t.lapId;
      if (Math.abs(lap.lapSec - t.lapSec) < 0.0005) return false;
    }
    return true;
  });
}

/** Per-corner stats from engine breakdowns, or null when there are none to use. */
function statsFromBreakdowns(
  review: PracticeReview,
  laps: readonly LapLossBreakdown[],
  lapIds: readonly (string | null)[] | undefined,
  counted: boolean[],
): CornerStat[] | null {
  const usable = laps.filter((b) => b && Array.isArray(b.corners) && b.corners.length > 0);
  if (!usable.length) return null;
  const L = review.trackLengthM;
  // Columns: one per lap of the session when we know the ids, else one per breakdown.
  let columns: (LapLossBreakdown | null)[];
  if (lapIds && lapIds.length === review.laps.length) {
    const byId = new Map(usable.map((b) => [b.lapId, b]));
    columns = review.laps.map((_, i) => (counted[i] && lapIds[i] ? byId.get(lapIds[i]!) ?? null : null));
  } else {
    const t = review.target;
    columns = usable.map((b) => (t && t.kind === 'sessionBest' && b.lapId === t.lapId ? null : b));
  }
  // Corner ids in road order, as the breakdowns name them.
  const order: string[] = [];
  for (const b of usable) for (const c of b.corners) if (!order.includes(c.id)) order.push(c.id);
  const indexOf = new Map<string, number>();
  for (const b of usable) for (const c of b.corners) if (!indexOf.has(c.id)) indexOf.set(c.id, c.index);
  order.sort((a, b) => (indexOf.get(a)! - indexOf.get(b)!) || a.localeCompare(b));
  return order.map((id) =>
    statOf(
      id,
      columns.map((b) => {
        const c = b ? b.corners.find((x) => x.id === id) : undefined;
        return c && finite(c.lossSec) ? sampleOfPhaseLoss(c, L) : null;
      }),
    ),
  );
}

/** Per-corner stats from the debrief's own rows (no phases). */
function statsFromReview(review: PracticeReview, counted: boolean[]): CornerStat[] {
  return review.corners.map((c) =>
    statOf(
      cornerIdOf(c),
      review.laps.map((lap, i) => {
        if (!counted[i]) return null;
        const r = lap.corners[c.index];
        if (!r) return null;
        const s = sampleOfRow({ id: cornerIdOf(c), deltaSec: r.deltaSec, brakeDeltaM: r.brakeDeltaM, apexKphDelta: r.apexKphDelta });
        if (s) {
          s.entryD = c.entryD;
          s.exitD = c.exitD;
        }
        return s;
      }),
    ),
  );
}

/**
 * When the laps carry no per-lap corner rows (an old cached review) the
 * debrief's averages still say where time goes. One-sample stats, so their
 * confidence stays low.
 */
function statsFromSummaries(review: PracticeReview): CornerStat[] {
  return review.corners
    .filter((c) => finite(c.avgLossSec))
    .map((c) => {
      const s = statOf(cornerIdOf(c), [
        sampleOfRow({
          id: cornerIdOf(c),
          entryD: c.entryD,
          exitD: c.exitD,
          deltaSec: c.avgLossSec,
          brakeDeltaM: c.avgBrakeDeltaM,
          apexKphDelta: c.avgApexKphDelta,
        }),
      ]);
      s.perLap = review.laps.map(() => null);
      return s;
    });
}

/** The best valid lap's sector deficit against the best of each sector. */
function sectorFromTimes(review: PracticeReview, opts: CoachSessionOpts, stats: readonly CornerStat[]): SectorPotential | null {
  const times = opts.sectorTimes;
  if (!times || times.length !== review.laps.length) return null;
  let bestI = -1;
  review.laps.forEach((lap, i) => {
    if (lap.valid && times[i] && (bestI < 0 || lap.lapSec < review.laps[bestI]!.lapSec)) bestI = i;
  });
  if (bestI < 0) return null;
  const bestLap = times[bestI]!;
  let pick: SectorPotential | null = null;
  for (let k = 0; k < 3; k += 1) {
    const mine = bestLap[k];
    if (!finite(mine)) continue;
    let fastest = Infinity;
    review.laps.forEach((lap, i) => {
      const v = times[i]?.[k];
      if (lap.valid && finite(v) && v > 0) fastest = Math.min(fastest, v);
    });
    if (!Number.isFinite(fastest)) continue;
    const sec = mine - fastest;
    if (sec >= 0.05 && (!pick || sec > pick.sec)) pick = { sector: k, sec, basis: 'times', corners: [] };
  }
  if (!pick) return null;
  pick.corners = stats
    .filter((s) => sectorOf(s.entryD, opts.sectorD) === pick!.sector && s.lossSec > LEVEL_SEC)
    .sort((a, b) => b.lossSec - a.lossSec)
    .map((s) => s.id);
  return pick;
}

function sessionFacts(F: Facts, review: PracticeReview): CoachTakeaway | null {
  const best = review.bestLapSec;
  const theo = review.theoreticalBestSec;
  if (finite(best)) F.add({ id: 'session.best', kind: 'lapTime', value: best, unit: 's', text: `Best lap ${fmtLap(best)}.` });
  if (finite(theo)) F.add({ id: 'session.theoretical', kind: 'lapTime', value: theo, unit: 's', text: `Theoretical best ${fmtLap(theo)}.` });
  if (finite(review.consistencySec)) {
    F.add({ id: 'session.consistency', kind: 'consistency', value: review.consistencySec, unit: 's', text: `Lap times vary by ±${review.consistencySec.toFixed(2)} s.` });
  }
  const t = review.target;
  if (t && finite(best) && finite(t.lapSec) && t.kind !== 'sessionBest') {
    const gap = best - t.lapSec;
    F.add({
      id: 'session.targetGap',
      kind: 'targetGap',
      value: gap,
      unit: 's',
      text: `Best lap is ${fmtSec(gap)} ${gap >= 0 ? 'off' : 'under'} the target (${t.label}).`,
    });
  }
  if (finite(best) && finite(theo) && best - theo >= 0.05) {
    const pot = best - theo;
    const id = F.add({
      id: 'session.potential',
      kind: 'potential',
      value: pot,
      unit: 's',
      text: `Your best segments add up to ${fmtSec(pot)} quicker than your best lap.`,
    });
    return {
      title: 'The time is already in your laps',
      body: `Your best segments add up to ${fmtSec(pot)} quicker than your best lap — it's about putting them together.`,
      chip: `${fmtSec(pot)} potential`,
      tone: 'potential',
      cornerIds: [],
      factIds: [id, 'session.theoretical'].filter((x) => F.has(x)),
    };
  }
  return null;
}

/**
 * The session's coaching. `laps` are the engine's breakdowns of the valid
 * traced laps against the session's target; empty (the engine not landed, or
 * no traces) → the debrief's own corner rows, so the panel is never blank.
 */
export function buildSessionCoach(
  review: PracticeReview,
  laps: readonly LapLossBreakdown[],
  opts: CoachSessionOpts,
): CoachReport {
  const counted = countedLaps(review, opts.lapIds);
  let stats = statsFromBreakdowns(review, laps || [], opts.lapIds, counted);
  if (!stats) {
    const rows = statsFromReview(review, counted);
    stats = rows.some((s) => s.laps > 0) ? rows : statsFromSummaries(review);
  }
  const F = new Facts();
  const potential = sessionFacts(F, review);
  const sector = sectorFromTimes(review, opts, stats) || sectorFromCorners(stats, opts.sectorD);
  const out = assemble({
    F,
    stats,
    lapScope: false,
    sequences: opts.sequences || [],
    fairness: opts.fairness || [],
    sector,
    bestSec: review.bestLapSec,
    theoreticalSec: review.theoreticalBestSec,
    potentialFallback: potential,
  });
  return {
    version: COACH_REPORT_VERSION,
    scope: 'session',
    sessionId: opts.sessionId || review.id,
    lapId: null,
    source: 'template',
    headline: out.headline,
    takeaways: out.takeaways,
    worst: out.worst,
    sequences: [...(opts.sequences || [])],
    aimForSec: out.aimForSec,
    fairness: [...(opts.fairness || [])],
    facts: F.list,
    generatedAt: opts.generatedAt || review.endedAt || '',
  };
}

/* -------------------------------------------------------------------------- */
/*  Lap scope                                                                 */
/* -------------------------------------------------------------------------- */

/** One lap's coaching: its breakdown when the engine split it, else its corner rows. */
export function buildLapCoach(input: CoachLapInput): CoachReport {
  const L = input.trackLengthM;
  const b = input.breakdown;
  let stats: CornerStat[];
  if (b && Array.isArray(b.corners) && b.corners.length) {
    stats = b.corners.filter((c) => finite(c.lossSec)).map((c) => statOf(c.id, [sampleOfPhaseLoss(c, L)]));
  } else {
    stats = (input.rows || []).map((r) => statOf(r.id, [sampleOfRow(r)]));
  }
  const F = new Facts();
  if (finite(input.lapSec)) F.add({ id: 'lap.time', kind: 'lapTime', value: input.lapSec, unit: 's', text: `This lap ${fmtLap(input.lapSec)}.` });
  if (finite(input.lapSec) && finite(input.refSec)) {
    const gap = input.lapSec - input.refSec;
    F.add({
      id: 'lap.gap',
      kind: 'targetGap',
      value: gap,
      unit: 's',
      text: `${fmtSec(gap)} ${gap >= 0 ? 'off' : 'under'} the reference${input.refLabel ? ` (${input.refLabel})` : ''}.`,
    });
  }
  if (b && finite(b.residualSec) && Math.abs(b.residualSec) >= 0.05) {
    F.add({
      id: 'lap.residual',
      kind: 'residual',
      value: b.residualSec,
      unit: 's',
      text: `${fmtSec(b.residualSec)} of the gap is between the trace clock and the timing, not any corner.`,
    });
  }
  const out = assemble({
    F,
    stats,
    lapScope: true,
    sequences: input.sequences || (b ? b.sequences || [] : []),
    fairness: input.fairness || [],
    sector: sectorFromCorners(stats, input.sectorD),
    bestSec: input.lapSec,
    theoreticalSec: input.theoreticalBestSec ?? null,
    potentialFallback: null,
  });
  return {
    version: COACH_REPORT_VERSION,
    scope: 'lap',
    sessionId: input.sessionId,
    lapId: input.lapId,
    source: 'template',
    headline: out.headline,
    takeaways: out.takeaways,
    worst: out.worst,
    sequences: [...(input.sequences || (b ? b.sequences || [] : []))],
    aimForSec: out.aimForSec,
    fairness: [...(input.fairness || [])],
    facts: F.list,
    generatedAt: input.generatedAt || '',
  };
}

/* -------------------------------------------------------------------------- */
/*  The AI's words over the template                                          */
/* -------------------------------------------------------------------------- */

/** A chip for an AI takeaway with no template twin: from its first cited fact. */
function chipFromFacts(facts: readonly CoachFact[]): { chip: string; tone: CoachTakeaway['tone'] } {
  const f = facts[0];
  if (!f) return { chip: '', tone: 'loss' };
  if (f.kind === 'aimFor') return { chip: `Aim for ${fmtAim(f.value)}`, tone: 'target' };
  if (f.kind === 'sectorLoss' || f.kind === 'potential') return { chip: `${fmtSec(f.value)} potential`, tone: 'potential' };
  if (f.unit === 's') return { chip: `≈${fmtSec(f.value)}`, tone: f.value < 0 ? 'potential' : 'loss' };
  return { chip: '', tone: 'loss' };
}

/**
 * The AI's (already validated) words laid over a template report. Numbers,
 * corners, the aim and the facts stay the template's; the AI supplies the
 * headline and the takeaways' wording, each keeping the chip and tone of the
 * template takeaway it shares most facts with. Anything citing an id the
 * report does not hold is dropped; with nothing left, the template stands.
 */
export function applyAi(report: CoachReport, ai: CoachAiResult | null | undefined): CoachReport {
  if (!ai || !Array.isArray(ai.takeaways)) return report;
  const byId = new Map(report.facts.map((f) => [f.id, f]));
  const corners = new Set<string>();
  for (const f of report.facts) if (f.cornerId) corners.add(f.cornerId);
  const used = new Set<number>();
  const takeaways: CoachTakeaway[] = [];
  for (const t of ai.takeaways.slice(0, TAKEAWAYS_MAX)) {
    if (!t || typeof t.title !== 'string' || typeof t.body !== 'string') continue;
    const factIds = Array.isArray(t.factIds) ? t.factIds.filter((id) => typeof id === 'string') : [];
    const cornerIds = Array.isArray(t.cornerIds) ? t.cornerIds.filter((id) => typeof id === 'string') : [];
    if (!factIds.length || factIds.some((id) => !byId.has(id)) || cornerIds.some((id) => !corners.has(id))) continue;
    let twin = -1;
    let overlap = 0;
    report.takeaways.forEach((tt, i) => {
      if (used.has(i)) return;
      const n = tt.factIds.filter((id) => factIds.includes(id)).length;
      if (n > overlap) {
        overlap = n;
        twin = i;
      }
    });
    let chip: string;
    let tone: CoachTakeaway['tone'];
    if (twin >= 0) {
      used.add(twin);
      chip = report.takeaways[twin]!.chip;
      tone = report.takeaways[twin]!.tone;
    } else {
      ({ chip, tone } = chipFromFacts(factIds.map((id) => byId.get(id)!)));
    }
    takeaways.push({ title: t.title.trim(), body: t.body.trim(), chip, tone, cornerIds, factIds });
  }
  if (!takeaways.length) return report;
  const headline = typeof ai.headline === 'string' && ai.headline.trim() ? ai.headline.trim() : report.headline;
  return { ...report, source: 'ai', headline, takeaways };
}
