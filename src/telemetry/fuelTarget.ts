/**
 * @file src/telemetry/fuelTarget.ts
 * @module telemetry/fuelTarget
 *
 * **"I want to save one lap of fuel."** The driver names how much to save; the
 * engineer answers with the per-lap number that achieves it, then reads back
 * every completed lap's burn against that number until the stint ends.
 *
 * Carl's brief (2026-10-02): "If someone says 'I want to save one lap of fuel',
 * it should say: this is the target. And then each lap it says what you
 * consumed that lap and how far off your target you are."
 *
 * Headless like its siblings (`engineerCommands.ts`, `triggers.ts`): no audio,
 * no clock, no network. `EngineerCommands` owns one {@link FuelTargetTracker},
 * feeds it every frame, routes the three push-to-talk intents to it, and hands
 * the per-lap line to `electron/engineer.js`, which speaks it through the same
 * preset / busy-driving / hold gate as every proactive readout.
 *
 * ## The math — "save N laps" means "make this stint N laps longer"
 * That is what a driver means by it: the car comes in N laps later than it
 * would at today's burn (skip a stop, or reach the flag). For each budget the
 * car carries — the tank (litres) and LMU's virtual-energy allowance (percent
 * points) — with `B` left now and a rolling average burn `a` (the same average
 * the fuel widget shows, `frame.fuel.perLapAvgLiters` / `virtualEnergyPerLapPct`):
 *
 *     laps it covers      L_b = B_b / a_b
 *     the stint           L   = min over budgets of L_b      (whichever runs out first)
 *     the goal            G   = L + N
 *     target per lap      t_b = B_b / G    — for every budget with L_b < G
 *
 * A budget that already covers G laps needs no saving and gets no target, so
 * the usual LMU case (energy binds, the tank has slack) yields one energy
 * target, and a car whose two budgets are close yields both — the same
 * "tighter of tank vs energy" rule as the `fuel` intent, made exact.
 *
 * Worked example: 62.0 % energy at 3.40 %/lap covers 18.24 laps; 70.0 L at
 * 3.50 L/lap covers 20.00. Stint = 18.24. "Save one lap" → G = 19.24. Energy
 * target 62.0 / 19.24 = 3.22 %/lap; the tank already covers 19.24, so no fuel
 * target: "Energy's the limit. To save a lap, target 3.22 percent a lap —
 * you're averaging 3.40. That stretches the stint from 18.2 laps to 19.2."
 *
 * The target is FIXED for the stint: hit it every lap and the stint is exactly
 * G laps long. A moving target is harder to drive to than a wrong one.
 *
 * ## "Saved so far" is exact, not a feel
 * Over G laps at the target the car uses `G·t = B`; at the old average it would
 * have used `G·a = B + N·a`. So saving N laps is saving `N·a` of the budget, and
 * a running saving `S = Σ(a − burn)` over the reported laps is worth `S / a`
 * laps: going back to the old average now, the stint would be `L + S/a` laps
 * long. When that reaches `L + N` the laps are banked and the target retires.
 *
 * ## What is never reported
 * Only whole laps watched from line to line count. A lap that touched the pit
 * lane, ran under a full-course yellow or red flag, saw the level RISE (a
 * refuel), or skipped a lap count is not a measurement of how the driver is
 * saving and is passed over in silence. A refuel or a counted pit stop ends the
 * stint, so the target is cleared and the driver told. A session change, a
 * driver swap or the chequered flag clears it silently.
 *
 * ## Targets, never technique
 * `raceStrategy.ts` notes that lift-and-coast (`kLift`) cannot be fitted from
 * our data. So this module says WHAT number to hit, never HOW to hit it.
 */

import { UNKNOWN_VALUE } from './types';
import type { TelemetryFrame } from './types';
import { sessionKeyOf } from './triggers';

/* -------------------------------------------------------------------------- */
/*  Parsing what the driver said                                              */
/* -------------------------------------------------------------------------- */

/** The two budgets an LMU car runs on. */
export type FuelBudget = 'fuel' | 'energy';

/** One parsed fuel-target request. */
export type FuelTargetAsk =
  | { kind: 'set'; laps: number; budget?: FuelBudget }
  | { kind: 'read' }
  | { kind: 'cancel' };

/** The most laps a target will plan for — beyond this it is a stop, not a save. */
export const MAX_SAVE_LAPS = 5;

const COUNT_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, another: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Spoken small numbers, for the radio ("eight hundredths", "two laps"). */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * Lower-case, apostrophes gone, punctuation → space, but a decimal point
 * between digits survives ("1.5 laps"). Whisper writes digits; SAPI writes the
 * phrase as listed — both arrive here.
 */
function normalise(text: string): string {
  return ` ${String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/(\d)\.(\d)/g, '$1qdq$2') // a marker the punctuation pass keeps
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/(\d)qdq(\d)/g, '$1.$2')
    .trim()} `;
}

/** The quantity words a "save N laps" phrase may use, as one regex group. */
const QTY = '(\\d+(?:\\.\\d+)?|half an?|half|an?|one|two|three|four|five|six|seven|eight|nine|ten|another)';

/** Turn a matched quantity (+ optional "and a half") into laps. */
function qtyValue(q: string, andAHalf: boolean): number {
  let n: number;
  if (q.startsWith('half')) n = 0.5;
  else if (/^\d/.test(q)) n = Number(q);
  else n = COUNT_WORDS[q] ?? NaN;
  return andAHalf ? n + 0.5 : n;
}

/**
 * Is this a fuel-target request, and which? Strict on purpose: it runs BEFORE
 * the phrase list in `ask()`, so anything it claims never reaches the `fuel`,
 * `energy` or `fuelRatio` answers. A set needs a save/stretch verb AND a lap
 * quantity ("save one lap", "save 2 laps", "save half a lap", "stretch the
 * stint by a lap"); bare "fuel" or "should I save fuel" is not one.
 */
export function parseFuelTargetAsk(text: string): FuelTargetAsk | null {
  const t = normalise(text);
  if (!t.trim()) return null;

  // -- cancel --------------------------------------------------------------
  // A cancel verb within three words before "target"/"saving", or "… off".
  if (
    /\b(?:cancel|clear|stop|drop|kill|remove|forget|scrap|reset)\b(?: \w+){0,3}? (?:target|saving)\b/.test(t) ||
    /\b(?:target|saving) off\b/.test(t) ||
    /\bturn off(?: \w+){0,2}? target\b/.test(t) ||
    /\bno more (?:fuel |energy )?saving\b/.test(t)
  ) {
    return { kind: 'cancel' };
  }

  // -- set -----------------------------------------------------------------
  const budget: FuelBudget | undefined = /\b(?:energy|ve)\b/.test(t) ? 'energy' : undefined;
  const set =
    new RegExp(
      `\\b(?:save|saving|safe)(?: us| me)?(?: an? extra| extra)? ${QTY}( and a half)? laps?\\b( and a half)?`,
    ).exec(t) ||
    new RegExp(
      `\\b(?:stretch|extend)\\b(?: \\w+){0,3}? by ${QTY}( and a half)? (?:more |extra )?laps?\\b( and a half)?`,
    ).exec(t);
  if (set) {
    const laps = qtyValue(set[1]!, !!(set[2] || set[3]));
    if (Number.isFinite(laps) && laps > 0) {
      return budget ? { kind: 'set', laps, budget } : { kind: 'set', laps };
    }
  }

  // -- read back -----------------------------------------------------------
  // "fuel target", "what's my target", "am I on target", "how's the saving".
  // Pace-target words belong to the reference-pace intents, not here.
  // "target lap time" / "target time" are pace questions too, unless the
  // driver says fuel or energy in the same breath.
  if (/\b(?:pace|alien|competitive|midpack|mid pack|sector|gap|position)\b/.test(t)) return null;
  if (/\b(?:lap ?time|time|qualifying|quali)\b/.test(t) && !/\b(?:fuel|energy|saving)\b/.test(t)) return null;
  if (/\btarget\b/.test(t)) return { kind: 'read' };
  if (/\b(?:hows|how is|how am i doing|how are we doing)\b(?: \w+){0,3}? (?:saving|save)\b/.test(t)) {
    return { kind: 'read' };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Speech helpers                                                            */
/* -------------------------------------------------------------------------- */

const UNIT: Record<FuelBudget, string> = { fuel: 'litres', energy: 'percent' };
const LABEL: Record<FuelBudget, string> = { fuel: 'Fuel', energy: 'Energy' };

/** Two decimals: the per-lap numbers differ in hundredths, and that is the point. */
function two(n: number): string {
  return n.toFixed(2);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** "half a lap", "a lap", "a lap and a half", "two laps", "2.3 laps". */
export function speakableSaveLaps(n: number): string {
  if (Math.abs(n - 0.5) < 1e-9) return 'half a lap';
  if (Math.abs(n - 1) < 1e-9) return 'a lap';
  if (Math.abs(n - 1.5) < 1e-9) return 'a lap and a half';
  const whole = Math.floor(n);
  const frac = n - whole;
  if (frac < 1e-9 && whole < NUMBER_WORDS.length) return `${NUMBER_WORDS[whole]} laps`;
  if (Math.abs(frac - 0.5) < 1e-9 && whole < NUMBER_WORDS.length) {
    return `${NUMBER_WORDS[whole]} and a half laps`;
  }
  return `${n.toFixed(1)} laps`;
}

/** "0.4 of a lap", "1.2 laps" — a running saving, one decimal. */
function speakableLapsSaved(x: number): string {
  const r = Math.round(x * 10) / 10;
  if (r >= 1) return `${r.toFixed(1)} ${r === 1 ? 'lap' : 'laps'}`;
  return `${r.toFixed(1)} of a lap`;
}

/**
 * How far a burn sits from its target, for speech: "eight hundredths over",
 * "0.15 litres under", or null when the two round to the same number. Works on
 * the ROUNDED values the driver hears, so "3.70, target 3.62" is always eight
 * hundredths, never seven.
 */
export function speakableOffTarget(burn: number, target: number, budget: FuelBudget): {
  amount: string;
  over: boolean;
} | null {
  const d = round2(round2(burn) - round2(target));
  const h = Math.round(Math.abs(d) * 100);
  if (h === 0) return null;
  const amount =
    h < 10 ? `${NUMBER_WORDS[h]} ${h === 1 ? 'hundredth' : 'hundredths'}` : `${Math.abs(d).toFixed(2)} ${UNIT[budget]}`;
  return { amount, over: d > 0 };
}

/**
 * The per-lap line. One budget: "3.70 litres that lap, target 3.62 — eight
 * hundredths over." / "3.58 litres that lap, four hundredths under target —
 * keep that." Two budgets: one short clause each, labelled.
 */
export function lapReportLine(rows: { budget: FuelBudget; burn: number; target: number }[]): string {
  if (rows.length === 1) {
    const { budget, burn, target } = rows[0]!;
    const off = speakableOffTarget(burn, target, budget);
    const head = `${two(burn)} ${UNIT[budget]} that lap`;
    if (!off) return `${head} — right on target.`;
    if (off.over) return `${head}, target ${two(target)} — ${off.amount} over.`;
    return `${head}, ${off.amount} under target — keep that.`;
  }
  return rows
    .map(({ budget, burn, target }) => {
      const off = speakableOffTarget(burn, target, budget);
      const head = `${LABEL[budget]} ${two(burn)} ${UNIT[budget]}`;
      if (!off) return `${head}, on target.`;
      if (off.over) return `${head}, ${off.amount} over the ${two(target)} target.`;
      return `${head}, ${off.amount} under target.`;
    })
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/*  The tracker                                                               */
/* -------------------------------------------------------------------------- */

/** Clean laps of burn the tracker must have watched before it will set a target. */
export const MIN_CLEAN_LAPS = 2;

/** The lap in progress counts toward the target only if it was set this close to the line. */
export const SET_LAP_FRACTION_MAX = 0.1;

/** A running "saved so far" every this many reported laps. */
export const SUMMARY_EVERY_LAPS = 3;

/** A level rise bigger than this between frames is a refuel: litres / percent. */
const REFUEL_RISE: Record<FuelBudget, number> = { fuel: 0.3, energy: 0.5 };

/** A lap that burns more than this is not a lap of driving: litres / percent. */
const MAX_LAP_BURN: Record<FuelBudget, number> = { fuel: 30, energy: 25 };

/** The answer shape the commands layer wraps into a CommandAnswer. */
export interface FuelTargetReply {
  text: string;
  ok: boolean;
}

type Levels = Partial<Record<FuelBudget, number>>;

interface BudgetPlan {
  /** Per-lap target, or undefined for a budget that needs no saving. */
  target?: number;
  /** Rolling average at the moment the target was set. */
  avg: number;
  /** Laps this budget covered at that moment. */
  laps: number;
  /** Running saving, budget units: Σ(avg − burn) over reported laps. */
  saved: number;
}

interface ActiveTarget {
  /** N — how many laps the driver asked to save. */
  laps: number;
  /** L — the stint at the moment of asking. */
  stintLaps: number;
  /** G = L + N. */
  goalLaps: number;
  plans: Partial<Record<FuelBudget, BudgetPlan>>;
  /** First completed-lap number (1-based, = lapsCompleted after it) that is reported. */
  firstLap: number;
  /** Laps reported so far. */
  counted: number;
  /** The last reported lap's burns. */
  lastBurn: Levels;
}

const BUDGETS: readonly FuelBudget[] = ['fuel', 'energy'];

function known(n: number | undefined): n is number {
  return typeof n === 'number' && n !== UNKNOWN_VALUE && Number.isFinite(n);
}

/** The budget's level and average right now, or null when either is unpublished. */
function readBudget(frame: TelemetryFrame, b: FuelBudget): { level: number; avg: number } | null {
  const f = frame.fuel;
  if (!f) return null;
  const level = levelsOf(frame)[b];
  const avg = b === 'fuel' ? f.perLapAvgLiters : f.virtualEnergyPerLapPct;
  if (level === undefined || !known(avg) || avg <= 0) return null;
  return { level, avg };
}

/**
 * Both budgets' levels at their finest published resolution. The frame's
 * `levelLiters` and `virtualEnergyPct` are rounded to one decimal for the
 * widgets, and the difference of two such readings is off by up to ±0.1 —
 * as big as the saving being measured. So the tank comes from the
 * calculator's `levelLitersExact`, and energy from the player row's raw
 * `virtualEnergy` fraction, falling back to the rounded fields only when a
 * provider publishes nothing finer.
 */
function levelsOf(frame: TelemetryFrame): Levels {
  const f = frame.fuel;
  const out: Levels = {};
  if (f) {
    const exact = f.levelLitersExact;
    if (known(exact) && exact >= 0) out.fuel = exact;
    else if (known(f.levelLiters) && f.levelLiters >= 0) out.fuel = f.levelLiters;
  }
  if (!f || !known(f.virtualEnergyPct) || f.virtualEnergyPct < 0) return out;
  const ve = frame.standings.find((e) => e.isPlayer)?.virtualEnergy;
  out.energy = known(ve) && ve > 0 ? ve * 100 : f.virtualEnergyPct;
  return out;
}

/**
 * Watches the player's lap edges all session (so it always has a clean lap
 * anchor and a count of clean laps), holds at most one active target, and
 * leaves one spoken line in {@link takeReport} per reported lap.
 */
export class FuelTargetTracker {
  private sessionKey = '';
  private frame: TelemetryFrame | null = null;
  private lapsDone = -1;
  private anchor: Levels = {};
  private anchorValid = false;
  private lapDirty = false;
  private lastLevels: Levels = {};
  private pitStops = -1;
  private driver = '';
  private cleanLaps = 0;
  private active: ActiveTarget | null = null;
  private pending: string | null = null;

  /** Forget everything — new session, or a caller that knows better. */
  reset(): void {
    this.sessionKey = '';
    this.frame = null;
    this.restartWatch();
    this.cleanLaps = 0;
    this.active = null;
    this.pending = null;
  }

  private restartWatch(): void {
    this.lapsDone = -1;
    this.anchor = {};
    this.anchorValid = false;
    this.lapDirty = false;
    this.lastLevels = {};
    this.pitStops = -1;
    this.driver = '';
  }

  /** Is a target live? (For tests and the read-back.) */
  get isActive(): boolean {
    return this.active !== null;
  }

  /** The line waiting to be spoken, once — then it is gone. */
  takeReport(): string | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  /** Feed one frame. Cheap on the nothing-happened path: a few scalar compares. */
  update(frame: TelemetryFrame): void {
    const key = sessionKeyOf(frame);
    if (key !== this.sessionKey) {
      this.reset();
      this.sessionKey = key;
    }
    this.frame = frame;
    const me = frame.standings.find((e) => e.isPlayer);
    if (!me) return;

    // The race is over: nothing left to save for.
    const phase = frame.session?.phase;
    if ((phase === 'checkered' || phase === 'cooldown') && this.active) this.active = null;

    // A driver swap: the incoming driver didn't ask.
    const driver = me.driverName || '';
    if (this.driver && driver !== this.driver) {
      this.active = null;
      this.restartWatch();
    }
    this.driver = driver;

    const levels = levelsOf(frame);
    const stops = known(me.pitStops) ? me.pitStops! : 0;

    // -- a stop or a refuel ends the stint --------------------------------
    let stintOver = false;
    for (const b of BUDGETS) {
      const prev = this.lastLevels[b];
      const now = levels[b];
      if (prev !== undefined && now !== undefined && now - prev > REFUEL_RISE[b]) stintOver = true;
    }
    if (this.pitStops >= 0 && stops > this.pitStops) stintOver = true;
    this.pitStops = stops;
    this.lastLevels = levels;
    if (stintOver) {
      this.lapDirty = true;
      if (this.active) {
        this.active = null;
        this.pending = 'Saving target cleared — new stint. Ask again when you want one.';
      }
    }
    if (me.inPit) this.lapDirty = true;
    if (phase === 'fullCourseYellow' || phase === 'redFlag') this.lapDirty = true;

    // -- the lap edge ------------------------------------------------------
    const laps = known(me.lapsCompleted) && me.lapsCompleted >= 0 ? me.lapsCompleted : -1;
    if (laps < 0) return;
    if (this.lapsDone < 0) {
      // First look: the lap in progress is only a measurement if we joined at the line.
      this.lapsDone = laps;
      this.anchor = levels;
      this.anchorValid = known(me.lapFraction) && me.lapFraction! <= 0.02 && !me.inPit;
      this.lapDirty = !!me.inPit;
      return;
    }
    if (laps < this.lapsDone) {
      // Laps went backwards: a restart. Re-anchor, and the plan is void.
      this.active = null;
      this.lapsDone = laps;
      this.anchor = levels;
      this.anchorValid = false;
      this.lapDirty = !!me.inPit;
      return;
    }
    if (laps === this.lapsDone) return;

    const singleLap = laps === this.lapsDone + 1;
    if (singleLap && this.anchorValid && !this.lapDirty) this.onCleanLap(laps, levels);
    this.lapsDone = laps;
    this.anchor = levels;
    this.anchorValid = true;
    // The next lap starts where the car is now: in the lane means an out-lap.
    this.lapDirty = !!me.inPit || phase === 'fullCourseYellow' || phase === 'redFlag';
  }

  /** A whole green lap, line to line, watched: count it, and report it if a target is live. */
  private onCleanLap(lap: number, levels: Levels): void {
    const burns: Levels = {};
    for (const b of BUDGETS) {
      const a = this.anchor[b];
      const z = levels[b];
      if (a === undefined || z === undefined) continue;
      const burn = a - z;
      if (burn > MAX_LAP_BURN[b]) return; // not a lap of driving
      if (!(burn > 0)) continue; // this budget didn't move — a car that doesn't run it
      burns[b] = burn;
    }
    if (burns.fuel === undefined && burns.energy === undefined) return;
    this.cleanLaps++;

    const t = this.active;
    if (!t || lap < t.firstLap) return;
    // Every budget planned at set time must have a burn, or the lap can't be judged.
    for (const b of BUDGETS) if (t.plans[b] && burns[b] === undefined) return;

    t.counted++;
    t.lastBurn = burns;
    const rows: { budget: FuelBudget; burn: number; target: number }[] = [];
    for (const b of BUDGETS) {
      const p = t.plans[b];
      if (!p) continue;
      p.saved += p.avg - burns[b]!;
      if (p.target !== undefined) rows.push({ budget: b, burn: burns[b]!, target: p.target });
    }
    let line = lapReportLine(rows);
    const saved = this.savedLaps(t);
    if (saved >= t.laps - 0.005) {
      line += ` That's ${speakableSaveLaps(t.laps)} saved — target off.`;
      this.active = null;
    } else if (t.counted % SUMMARY_EVERY_LAPS === 0) {
      line += ' ' + savedNote(saved);
    }
    this.pending = line;
  }

  /**
   * Laps banked so far: going back to the old average now, the stint would be
   * `min over budgets of (L_b + S_b / a_b)` laps — minus the stint at asking.
   */
  private savedLaps(t: ActiveTarget): number {
    let stint = Infinity;
    for (const b of BUDGETS) {
      const p = t.plans[b];
      if (p) stint = Math.min(stint, p.laps + p.saved / p.avg);
    }
    return Number.isFinite(stint) ? stint - t.stintLaps : 0;
  }

  /* ---- the three asks ---------------------------------------------------- */

  /** Answer a parsed request. */
  ask(q: FuelTargetAsk): FuelTargetReply {
    if (q.kind === 'set') return this.set(q.laps, q.budget);
    if (q.kind === 'cancel') return this.cancel();
    return this.readBack();
  }

  /** "Save N laps": compute and arm the target, or refuse honestly. */
  set(laps: number, budget?: FuelBudget): FuelTargetReply {
    const no = (text: string): FuelTargetReply => ({ text, ok: false });
    const frame = this.frame;
    if (!frame) return no('No telemetry yet.');
    if (!(laps > 0)) return no('Say how many laps to save — save one lap, or half a lap.');
    if (laps > MAX_SAVE_LAPS) return no(`${MAX_SAVE_LAPS} laps is the most I'll plan to save — that's a stop, not a save.`);
    const me = frame.standings.find((e) => e.isPlayer);
    if (!me) return no('No standings yet.');
    if (me.inPit) return no("Ask me once you're back out on track.");

    const reads: Partial<Record<FuelBudget, { level: number; avg: number }>> = {};
    for (const b of BUDGETS) {
      const r = readBudget(frame, b);
      if (r) reads[b] = r;
    }
    if (budget === 'energy' && !known(frame.fuel?.virtualEnergyPct)) {
      return no('No virtual energy on this car.');
    }
    if (!reads.fuel && !reads.energy) {
      if (!frame.fuel || (!known(frame.fuel.levelLiters) && !known(frame.fuel.virtualEnergyPct))) {
        return no('No fuel read yet.');
      }
      return no('Need a couple of laps of burn first.');
    }
    if (this.cleanLaps < MIN_CLEAN_LAPS) return no('Need a couple of laps of burn first.');

    let stint = Infinity;
    for (const b of BUDGETS) {
      const r = reads[b];
      if (r) stint = Math.min(stint, r.level / r.avg);
    }
    if (stint < 1) return no('Under a lap left in this stint — nothing to stretch.');
    const goal = stint + laps;

    const plans: Partial<Record<FuelBudget, BudgetPlan>> = {};
    const targeted: FuelBudget[] = [];
    for (const b of BUDGETS) {
      const r = reads[b];
      if (!r) continue;
      const covers = r.level / r.avg;
      const plan: BudgetPlan = { avg: r.avg, laps: covers, saved: 0 };
      if (covers < goal - 1e-9) {
        plan.target = r.level / goal;
        targeted.push(b);
      }
      plans[b] = plan;
    }

    // The lap in progress counts only if the target was set just past the line.
    const frac = me.lapFraction;
    const thisLapCounts =
      this.anchorValid && !this.lapDirty && known(frac) && frac! <= SET_LAP_FRACTION_MAX;
    const done = Math.max(0, this.lapsDone);
    this.active = {
      laps,
      stintLaps: stint,
      goalLaps: goal,
      plans,
      firstLap: done + (thisLapCounts ? 1 : 2),
      counted: 0,
      lastBurn: {},
    };

    // -- the sentence --------------------------------------------------------
    const parts: string[] = [];
    const bothKnown = !!(reads.fuel && reads.energy);
    if (targeted.length === 2) parts.push('Fuel and energy both need it.');
    else if (targeted[0] === 'energy') parts.push("Energy's the limit.");
    else if (bothKnown) parts.push("Fuel's the limit.");

    const what = speakableSaveLaps(laps);
    if (targeted.length === 2) {
      parts.push(
        `To save ${what}, target ${two(plans.fuel!.target!)} litres and ${two(plans.energy!.target!)} percent a lap — ` +
          `you're averaging ${two(plans.fuel!.avg)} and ${two(plans.energy!.avg)}.`,
      );
    } else {
      const b = targeted[0]!;
      parts.push(
        `To save ${what}, target ${two(plans[b]!.target!)} ${UNIT[b]} a lap — you're averaging ${two(plans[b]!.avg)}.`,
      );
    }
    parts.push(`That stretches the stint from ${stint.toFixed(1)} laps to ${goal.toFixed(1)}.`);

    const ltf = frame.fuel?.lapsToFinish;
    if (known(ltf) && ltf > 0) {
      if (stint >= ltf) parts.push('You already make the finish.');
      else if (goal >= ltf) parts.push('Hit it and you make the finish.');
    }
    let cut = 0;
    for (const b of targeted) cut = Math.max(cut, 1 - plans[b]!.target! / plans[b]!.avg);
    if (cut > 0.1) parts.push(`That's a ${Math.round(cut * 100)} percent cut — a big ask.`);
    if (!thisLapCounts) parts.push('First reading at the end of the next full lap.');
    return { text: parts.join(' '), ok: true };
  }

  /** "Cancel fuel target" / "stop saving". */
  cancel(): FuelTargetReply {
    if (!this.frame) return { text: 'No telemetry yet.', ok: false };
    const t = this.active;
    if (!t) return { text: 'No fuel target to cancel.', ok: true };
    this.active = null;
    const saved = this.savedLaps(t);
    const tail = t.counted > 0 && saved >= 0.05 ? ` ${savedNote(saved)}` : '';
    return { text: `Fuel target off.${tail}`, ok: true };
  }

  /** "What's my target": the number, the last lap against it, and the running saving. */
  readBack(): FuelTargetReply {
    if (!this.frame) return { text: 'No telemetry yet.', ok: false };
    const t = this.active;
    if (!t) return { text: 'No fuel target set. Say save one lap to set one.', ok: false };
    const targeted = BUDGETS.filter((b) => t.plans[b]?.target !== undefined);
    const parts: string[] = [];
    if (targeted.length === 2) {
      parts.push(
        `Saving ${speakableSaveLaps(t.laps)}: target ${two(t.plans.fuel!.target!)} litres and ` +
          `${two(t.plans.energy!.target!)} percent a lap.`,
      );
    } else {
      const b = targeted[0]!;
      parts.push(`Saving ${speakableSaveLaps(t.laps)}: target ${two(t.plans[b]!.target!)} ${UNIT[b]} a lap.`);
    }
    if (t.counted === 0) {
      parts.push('No full lap on it yet.');
    } else {
      const rows = targeted
        .filter((b) => t.lastBurn[b] !== undefined)
        .map((b) => `${two(t.lastBurn[b]!)} ${UNIT[b]}`);
      if (rows.length) parts.push(`Last lap ${rows.join(', ')}.`);
      parts.push(savedNote(this.savedLaps(t)));
    }
    return { text: parts.join(' '), ok: true };
  }
}

/** "That's 0.4 of a lap saved so far." / "Nothing saved yet." */
function savedNote(saved: number): string {
  return saved >= 0.05 ? `That's ${speakableLapsSaved(saved)} saved so far.` : 'Nothing saved yet.';
}
