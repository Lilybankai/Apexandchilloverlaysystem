/**
 * liveCoachVoice.ts — the live practice coach, spoken: the driver's questions
 * and the every-few-laps AI summary.
 * =============================================================================
 *
 * 2026-11-03 (the live coach, `liveCoachContract.ts`). The engine
 * (`liveCoach.ts`) decides what the engineer volunteers after each lap; this
 * module answers what the driver ASKS between laps, and turns the coach edge
 * function's summary into something the radio can say. It implements
 * {@link LiveCoachVoice} and reads only a {@link LiveCoachSnapshot}.
 *
 *   coachQuestionOf(text)          the push-to-talk words → which coach
 *                                  question, or null (not a coach question)
 *   answerCoachQuestion(text, snap) → one spoken answer, or null
 *   summaryRequest(snap, context)  → a CoachAiRequest the DEPLOYED `coach`
 *                                  function accepts (kind 'session')
 *   summaryFacts(snap)             the contract's thinner view of the same
 *   speakableSummary(reply, snap, request?) → at most two sentences, or null
 *
 * Coach v2 (2026-11-04: a work list of up to three corners, approach cues, a
 * run debrief):
 *
 *   debriefRequest(debrief, snap, ctx) → the run debrief's CoachAiRequest, in
 *                                  summaryRequest's shape (kind 'session')
 *   speakableDebrief(reply, debrief, snap, request?) → at most three
 *                                  sentences, or null (say the template)
 *   debriefGuard(text, debrief, facts) → why a spoken debrief may not be said
 *   debriefOf(snap)                the run debrief behind "how am I doing"
 *
 * and the questions use the work list when the engine keeps one: "what should
 * I work on" / "what are my corners" → every corner on it with what to change
 * and its worth; "how am I doing" / "debrief me" / "how's my run" → the run
 * debrief (the snapshot's `debrief`, else the engine's `runDebrief`, else
 * worded here from the state); "what about corner seven" on a work-list
 * corner → the cue AND cue2 with their numbers, its rank and how it went last
 * lap. With no work list (a v1 state) every answer is v1's. Off a coached
 * session (null snapshot) every one of them is null, as in v1: the engineer
 * takes the words exactly as before.
 *
 * ## The questions, and who owns them
 * engineerCommands.ts already answers "last lap" / "lap time" (the time and
 * the sectors), and the phrase table in electron/engineer.js routes dozens
 * more. The rule that keeps the two from fighting:
 *
 *   - "HOW was that lap" (how + that/the/my/this + lap) is the COACH's when a
 *     snapshot exists — the time, the gap to the reference and the corner
 *     that cost most. With no snapshot (a race, the coach off) it is NOT a
 *     coach question: null, and the engineer answers it as `lastLap`.
 *   - "last lap", "lap time", "what was my last lap" never come here: no
 *     "how", so the time readout keeps them in every session.
 *   - "where am I losing time", "what should I work on", "corner seven", "am
 *     I consistent" are the coach's while it is live. With no snapshot (a
 *     race, qualifying, the coach off) they are not: null, and the engineer
 *     takes them exactly as before the coach existed — "where am I losing
 *     time" in a race is a fair question for the race engineer (Carl's
 *     integrator, 2026-11-03).
 *   - "turn seven" is never read as a corner: the coach's corners are the
 *     Practice tab's C1..Cn, not the official turns, so "what gear for turn
 *     five" stays a cloud question.
 *
 * The parser is deliberately narrow: a coach answer to a question that was
 * really about fuel or the car ahead is the confident wrong answer the
 * engineer refuses to give. `scripts/test-livecoachvoice.js` runs every
 * phrase in the engineer's table through it and fails on any steal.
 *
 * ## The summary
 * The AI (the `coach` function, Haiku 5.5) only words and ranks CoachFacts
 * the app computed and may cite them only by id; validate.ts rejects any
 * number it types. The request is built from the same fact ids and template
 * wording coachReport.ts uses (`C4.loss`, `C4.brakeDeltaM`, `session.consistency`,
 * `lap.gap` …) — kind 'session', no new kind, no redeploy. The spoken summary
 * takes the AI's words for WHAT to do and the cited facts for HOW MUCH: the
 * numbers on the radio are never the model's.
 *
 * ## Signs (liveCoachContract.ts)
 * Positive seconds = losing. A cue's `brakeShiftM` + = brake LATER than now,
 * so the driver now brakes EARLIER and the fact's `brakeDeltaM` (mine − ref,
 * + = later) is its negative. `minKphGain` + = carry more (the driver is
 * slower: `minKphDelta` −). `throttleShiftM` − = pick up earlier (the driver
 * is late: `pickupDeltaM` +). `exitKphGain` + = more exit speed.
 *
 * Pure: no fs, no clock, no Electron, no network.
 */

import { COACH_PHASES } from './coachContract';
import type { CoachAiRequest, CoachFact, CoachPhase, CornerPhaseLoss, LapLossBreakdown } from './coachContract';
import type {
  LiveCoachEngine,
  LiveCoachLap,
  LiveCoachSnapshot,
  LiveCoachVoice,
  LiveFocus,
  LiveFocusCue,
  LiveRunDebrief,
} from './liveCoachContract';
// The engine, for its run debrief when the snapshot does not carry one. A
// namespace import read at call time: `runDebrief` is optional (a v1 engine
// has none), and liveCoach.ts may import this module back without a cycle
// biting — nothing here is read while the modules load.
import * as liveCoachEngineModule from './liveCoach';
import { driverLoss, fmtLap, fmtSec, LEVEL_SEC } from './coachReport';
import { speakableLapTime } from './engineerCommands';
import { MAX_SPOKEN_WORDS } from './engineerPhrases';
import { speakableTenths } from './sessionPhrases';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** What the driver hears when the coach is not live (a race, the setting off). */

/** Smallest differences worth a word: the coach's own (coachReport.ts). */
const BRAKE_M = 3;
const APEX_KPH = 1;
const PICKUP_M = 5;
/** A corner loss below this is not worth naming on the radio. */
const SAY_LOSS_SEC = 0.05;
/** Lap-time spread bands for "am I consistent". */
const SPREAD_TIGHT_SEC = 0.3;
const SPREAD_OK_SEC = 0.8;
/**
 * An AI sentence longer than the radio's line length (engineerPhrases.ts
 * MAX_SPOKEN_WORDS) falls back to the takeaway's title; the "worth about …"
 * tail rides on top. Two sentences together stay under this.
 */
const SUMMARY_SENTENCE_WORDS = MAX_SPOKEN_WORDS;
const SUMMARY_TOTAL_WORDS = 36;

/* -------------------------------------------------------------------------- */
/*  Numbers in words                                                          */
/* -------------------------------------------------------------------------- */

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * 0..99 as words ("twenty one"), digits above. Corner numbers and metres
 * only — every TIME goes through engineerCommands' / sessionPhrases' helpers
 * ({@link speakableLapTime}, {@link speakableTenths}).
 */
export function numberWords(n: number): string {
  const v = Math.round(Math.abs(n));
  if (!Number.isFinite(v)) return '';
  if (v < 20) return ONES[v]!;
  if (v < 100) {
    const t = TENS[Math.floor(v / 10)]!;
    const o = v % 10;
    return o ? `${t} ${ONES[o]}` : t;
  }
  return String(v);
}

/** 'C4' → "corner four"; an id that is not C<n> is said as it is. */
export function spokenCorner(id: string | number): string {
  const n = typeof id === 'number' ? id : cornerNoOf(id);
  return n !== null ? `corner ${numberWords(n)}` : String(id);
}

function cornerNoOf(id: string): number | null {
  const m = /^C(\d{1,3})$/i.exec(String(id || '').trim());
  return m ? Number(m[1]) : null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/* -------------------------------------------------------------------------- */
/*  Reading the question                                                      */
/* -------------------------------------------------------------------------- */

export type CoachQuestionIntent = 'coachLap' | 'coachLoss' | 'coachWorkOn' | 'coachCorner' | 'coachSpread' | 'coachDebrief';

export const COACH_QUESTION_INTENTS: readonly CoachQuestionIntent[] = [
  'coachLap',
  'coachLoss',
  'coachWorkOn',
  'coachCorner',
  'coachSpread',
  'coachDebrief',
];

export interface CoachQuestion {
  intent: CoachQuestionIntent;
  /** 7 for "corner seven" (coachCorner only). */
  cornerNo?: number;
}

/** The words as every matcher in engineer.js sees them: lower case, no apostrophes, single spaces. */
function norm(text: unknown): string {
  return ` ${String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/** Whisper's sound-alikes for a number said straight after "corner". */
const SOUNDALIKE: Record<string, number> = { won: 1, to: 2, too: 2, for: 4, fore: 4, ate: 8 };

/**
 * The number at `words[i]`: "7", "7th", "seven", "twenty one", "twenty-one"
 * (already split by {@link norm}), and the sound-alikes whisper base.en writes
 * for a lone number at the end of a sentence ("corner for"). Null when there
 * is none.
 */
export function numberAt(words: readonly string[], i: number): number | null {
  const w = words[i];
  if (!w) return null;
  const d = /^(\d{1,3})(?:st|nd|rd|th)?$/.exec(w);
  if (d) return Number(d[1]);
  const o = ONES.indexOf(w);
  if (o >= 1) return o;
  const t = TENS.indexOf(w);
  if (t >= 2) {
    const next = ONES.indexOf(words[i + 1] || '');
    return t * 10 + (next >= 1 && next <= 9 ? next : 0);
  }
  // A sound-alike only as the sentence's last word: "what about corner for"
  // is a number, "corner for me" is not.
  if (w in SOUNDALIKE && i === words.length - 1) return SOUNDALIKE[w]!;
  return null;
}

/** The corner a sentence names: "corner seven", "corner number 12", "C7". */
export function cornerNumberIn(text: string): number | null {
  const words = norm(text).trim().split(' ');
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    const c = /^c(\d{1,2})$/.exec(w || '');
    if (c) return Number(c[1]);
    if (w !== 'corner' && w !== 'corners') continue;
    let j = i + 1;
    if (words[j] === 'number' || words[j] === 'no') j += 1;
    const n = numberAt(words, j);
    if (n !== null && n >= 1 && n <= 99) return n;
  }
  return null;
}

/** Words that make a corner sentence about something other than the driving there. */
const CORNER_NOT_COACH = /\b(gear|gears|yellow|yellows|flag|flags|crash|crashed|accident|incident|wreck|debris|traffic|car|cars|he|him|they|limits)\b/;
/** Words that make a "where am I losing" sentence about something else. */
const LOSS_NOT_COACH = /\b(fuel|energy|battery|tyre|tyres|tire|tires|position|positions|places|place|grip)\b/;
/** Setup, aids, strategy: "what should I change" about these is not a driving question. */
const WORKON_NOT_COACH = /\b(setup|set up|bias|pressure|pressures|wing|traction|tc|abs|fuel|energy|tyre|tyres|strategy|map|engine)\b/;
/** "Is he consistent" is about someone else. */
const SPREAD_NOT_COACH = /\b(he|him|his|they|their|car|ahead|behind|leader|p\d+)\b/;
/**
 * "How am I doing on fuel", "how are we doing for time", "how am I doing
 * against P5" are the race engineer's, not a run debrief — they go on to the
 * phrase list, the position parser or the cloud exactly as before.
 */
const DEBRIEF_NOT_COACH =
  /\b(fuel|energy|battery|tyre|tyres|tire|tires|time|times|position|positions|place|places|gap|gaps|p\d+|ahead|behind|leader|car|cars|he|him|his|they|their|stop|pit|pits|brakes|temps|temperature|temperatures|weather|rain|damage|pace|race|points|championship|standings)\b/;

/**
 * Which coach question the words ask, or null when they are not one. See the
 * file header for what each one owns and what it leaves to engineerCommands.
 */
export function coachQuestionOf(text: string): CoachQuestion | null {
  const t = norm(text);
  if (!t.trim()) return null;

  // -- a named corner --------------------------------------------------------
  const n = cornerNumberIn(t);
  if (n !== null && !CORNER_NOT_COACH.test(t)) return { intent: 'coachCorner', cornerNo: n };

  // -- the lap just driven -------------------------------------------------------
  if (
    /\bhow(?:s| was| is| did| about| d) (?:that|the|my|this|our)(?: last| previous| latest)? lap\b/.test(t) ||
    /\bhow did (?:i|we) do\b/.test(t) ||
    /\b(?:was )?that lap any good\b/.test(t)
  ) {
    return { intent: 'coachLap' };
  }

  // -- the run so far (v2): "how am I doing", "debrief me", "how's my run" ----
  if (
    !DEBRIEF_NOT_COACH.test(t) &&
    (/\bhow (?:am i|are we|im) (?:doing|getting on|going)\b/.test(t) ||
      /\bdebrief\b/.test(t) ||
      /\bhow(?:s| is| was| did| does) (?:my|the|this|our) (?:run|stint)\b/.test(t))
  ) {
    return { intent: 'coachDebrief' };
  }

  // -- where the time goes -------------------------------------------------------
  if (
    !LOSS_NOT_COACH.test(t) &&
    (/\bwheres?\b(?: [a-z]+){0,4}? (?:losing|lose|lost|loosing|loose|bleeding|dropping)\b/.test(t) ||
      /\bwhere(?:s| is| does| did| has) (?:the|my|all the|all my) time\b(?! left| remaining| to go)/.test(t) ||
      /\bwhere (?:can|could|do|should|would) (?:i|we) (?:find|gain|make|pick up|get|go) (?:some |more |the )?(?:time|faster|quicker)\b/.test(t) ||
      /\bwhere am i (?:slow|slower|slowest)\b/.test(t) ||
      /\bwhat(?:s| is)? costing (?:me|us)\b/.test(t) ||
      /\bbiggest (?:loss|losses|time loss)\b/.test(t))
  ) {
    return { intent: 'coachLoss' };
  }

  // -- what to work on -------------------------------------------------------
  if (
    /\bwhat (?:should|shall|do|can|must|would) (?:i|we) (?:need to |have to )?(?:be )?(?:work|working|focus|focusing|concentrate|concentrating) on\b/.test(t) ||
    /\bwhat (?:am i|are we) (?:working|focusing) on\b/.test(t) ||
    /\bwhat to (?:work|focus) on\b/.test(t) ||
    /\bwhat(?:s| is) (?:the|my|our) (?:focus|priority|main thing)\b/.test(t) ||
    /\bfocus corner\b/.test(t) ||
    (/\bwhat (?:should|can|do|could) (?:i|we) (?:need to )?(?:improve|change|fix|do better)\b/.test(t) && !WORKON_NOT_COACH.test(t)) ||
    // v2, the work list: "what are my corners", "which corners", "what's on the list".
    ((/\b(?:what|which) (?:are )?(?:my |the |our )?corners\b/.test(t) ||
      /\bwork(?:ing)? list\b/.test(t) ||
      /\bwhats on (?:the|my|our) list\b/.test(t)) &&
      !WORKON_NOT_COACH.test(t) &&
      !CORNER_NOT_COACH.test(t))
  ) {
    return { intent: 'coachWorkOn' };
  }

  // -- consistency ----------------------------------------------------------
  if (/\bconsist[ae]n(?:t|cy|ce)\b/.test(t) && !SPREAD_NOT_COACH.test(t)) return { intent: 'coachSpread' };

  return null;
}

/* -------------------------------------------------------------------------- */
/*  Reading the snapshot                                                      */
/* -------------------------------------------------------------------------- */

const PHASE_SPOKEN: Record<CoachPhase, string> = {
  braking: 'under braking',
  turnIn: 'on the turn-in',
  midCorner: 'in the middle of the corner',
  exit: 'on the exit',
  exitRun: 'on the run out of it',
};

/** coachReport.ts's own phrases, for the facts the AI sees. */
const PHASE_WHERE: Record<CoachPhase, string> = {
  braking: 'under braking',
  turnIn: 'on turn-in',
  midCorner: 'mid-corner',
  exit: 'on the exit',
  exitRun: 'on the run to the next corner',
};

function refWords(kind: LiveCoachLap['refKind'] | undefined): string {
  return kind === 'board' ? 'the leaderboard lap' : kind === 'chased' ? "the lap you're chasing" : 'your best';
}

/** The official lap delta to the reference: the breakdown's segments plus its residual. */
function lapDelta(lap: LiveCoachLap | null): number | null {
  const b = lap && lap.breakdown;
  if (!b || !finite(b.totalSec)) return null;
  return b.totalSec + (finite(b.residualSec) ? b.residualSec : 0);
}

/** A corner's phases with the flagged straight time (never the driver's) taken off the exit run. */
function driverPhases(c: CornerPhaseLoss): Record<CoachPhase, number> {
  const out = {} as Record<CoachPhase, number>;
  for (const p of COACH_PHASES) out[p] = finite(c.phases?.[p]) ? c.phases[p] : 0;
  if (c.straightFlag && finite(c.straightSec) && c.straightSec > 0) out.exitRun -= c.straightSec;
  return out;
}

function dominantPhase(c: CornerPhaseLoss): CoachPhase {
  const ph = driverPhases(c);
  let best: CoachPhase = 'braking';
  for (const p of COACH_PHASES) if (ph[p] > ph[best]) best = p;
  return best;
}

function cornerIn(b: LapLossBreakdown | null | undefined, id: string): CornerPhaseLoss | null {
  if (!b || !Array.isArray(b.corners)) return null;
  return b.corners.find((c) => c && c.id === id) || null;
}

/** The corner that cost the most on one lap (driver's part only). */
function biggestOn(b: LapLossBreakdown | null | undefined): { id: string; loss: number; phase: CoachPhase } | null {
  if (!b || !Array.isArray(b.corners)) return null;
  let best: { id: string; loss: number; phase: CoachPhase } | null = null;
  for (const c of b.corners) {
    if (!c || !finite(c.lossSec)) continue;
    const loss = driverLoss(c);
    if (!best || loss > best.loss) best = { id: c.id, loss, phase: dominantPhase(c) };
  }
  return best;
}

interface WindowStat {
  id: string;
  mean: number;
  laps: number;
  losing: number;
  values: number[];
}

/** Per-corner driver loss over the engine's window (`state.recent`), lap order kept. */
function windowStats(snap: LiveCoachSnapshot): Map<string, WindowStat> {
  const out = new Map<string, WindowStat>();
  const recent = snap.state && Array.isArray(snap.state.recent) ? snap.state.recent : [];
  for (const r of recent) {
    if (!r || !r.byCorner) continue;
    for (const [id, v] of Object.entries(r.byCorner)) {
      if (!finite(v)) continue;
      let s = out.get(id);
      if (!s) out.set(id, (s = { id, mean: 0, laps: 0, losing: 0, values: [] }));
      s.values.push(v);
      s.laps += 1;
      if (v > LEVEL_SEC) s.losing += 1;
    }
  }
  for (const s of out.values()) s.mean = s.values.reduce((a, b) => a + b, 0) / s.values.length;
  return out;
}

/** Window corners by mean loss, worst first. */
function ranked(stats: Map<string, WindowStat>, except: readonly string[] = []): WindowStat[] {
  return [...stats.values()]
    .filter((s) => !except.includes(s.id))
    .sort((a, b) => b.mean - a.mean || a.id.localeCompare(b.id));
}

/** The window's lap times (s), oldest first. */
function windowLapTimes(snap: LiveCoachSnapshot): number[] {
  const recent = snap.state && Array.isArray(snap.state.recent) ? snap.state.recent : [];
  return recent.map((r) => r && r.lapSec).filter((v): v is number => finite(v) && v > 0);
}

/* -------------------------------------------------------------------------- */
/*  The cue, in words                                                         */
/* -------------------------------------------------------------------------- */

const metres = (v: number): string => `${numberWords(v)} metres`;
const kph = (v: number): string => `${numberWords(v)} kilometres an hour`;

const PHASE_ADVICE: Record<CoachPhase, string> = {
  braking: 'look at your braking point',
  turnIn: 'turn in more smoothly',
  midCorner: 'carry more speed through the middle',
  exit: 'a cleaner exit, throttle sooner',
  exitRun: 'drive out of it harder',
};

/**
 * A cue as the radio says it: "brake ten metres later and carry four
 * kilometres an hour more to the apex". Signs as the contract pins them. At
 * most two measurable parts; with none, the phase's general advice.
 */
export function cueWords(cue: LiveFocusCue | null | undefined): string {
  if (!cue) return '';
  const parts = cueParts(cue);
  if (!parts.length) return PHASE_ADVICE[cue.phase] || '';
  return parts.slice(0, 2).join(' and ');
}

/** "a, b and c". */
function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * v2: a corner's change in full detail — the cue's measurable parts, then
 * `cue2`'s (the second change the window agrees on), each said once, at most
 * three: "brake ten metres later, carry four kilometres an hour more to the
 * apex and back on the throttle twelve metres sooner". The phase's advice
 * when neither carries a number.
 */
export function cueDetailWords(cue: LiveFocusCue | null | undefined, cue2?: LiveFocusCue | null): string {
  // One part per measure (brake, apex, throttle, exit): cue2 never repeats
  // what the cue already says.
  const measure = (p: string): string => (p.startsWith('brake') ? 'brake' : p.startsWith('carry') ? 'apex' : p.includes('throttle') ? 'throttle' : 'exit');
  const parts: string[] = [];
  for (const p of [...(cue ? cueParts(cue) : []), ...(cue2 ? cueParts(cue2) : [])]) {
    if (!parts.some((q) => measure(q) === measure(p))) parts.push(p);
  }
  if (!parts.length) return cue ? PHASE_ADVICE[cue.phase] || '' : cue2 ? PHASE_ADVICE[cue2.phase] || '' : '';
  return listWords(parts.slice(0, 3));
}

/** A cue's measurable parts in words, in the order the radio says them. */
function cueParts(cue: LiveFocusCue): string[] {
  const parts: string[] = [];
  const b = cue.brakeShiftM;
  if (finite(b) && Math.abs(b) >= BRAKE_M) parts.push(`brake ${metres(b)} ${b > 0 ? 'later' : 'earlier'}`);
  const a = cue.minKphGain;
  if (finite(a) && Math.abs(a) >= APEX_KPH) parts.push(a > 0 ? `carry ${kph(a)} more to the apex` : `carry ${kph(a)} less into the apex`);
  const th = cue.throttleShiftM;
  if (finite(th) && Math.abs(th) >= PICKUP_M) {
    parts.push(th < 0 ? `back on the throttle ${metres(th)} sooner` : `wait ${metres(th)} longer for the throttle`);
  }
  const e = cue.exitKphGain;
  if (finite(e) && e >= APEX_KPH) parts.push(`${kph(e)} more out of the exit`);
  return parts;
}

/**
 * A cue read off one lap's corner, the coach's way (coachTip): brake later
 * when braking early; brake earlier only when braking late AND slow at the
 * apex (over-driving); more apex speed when slower there; throttle sooner
 * when picking up late.
 */
export function cueFromCorner(c: CornerPhaseLoss, trackLengthM: number): LiveFocusCue {
  const diff = (x: number | null | undefined, y: number | null | undefined): number | null =>
    finite(x) && finite(y) ? x - y : null;
  const L = finite(trackLengthM) && trackLengthM > 0 ? trackLengthM : 0;
  const m = c.mine || ({} as CornerPhaseLoss['mine']);
  const f = c.ref || ({} as CornerPhaseLoss['ref']);
  const brakeD = diff(m.brakeOnD, f.brakeOnD);
  const brake = brakeD === null || !L ? null : brakeD * L;
  const apex = diff(m.minKph, f.minKph);
  const pickD = diff(m.pickupD, f.pickupD);
  const pickup = pickD === null || !L ? null : pickD * L;
  const exit = diff(m.exitKph, f.exitKph);
  const cue: LiveFocusCue = { phase: dominantPhase(c) };
  if (finite(brake) && brake <= -BRAKE_M) cue.brakeShiftM = r3(-brake);
  else if (finite(brake) && brake >= BRAKE_M && finite(apex) && apex <= -APEX_KPH) cue.brakeShiftM = r3(-brake);
  if (finite(apex) && apex <= -APEX_KPH) cue.minKphGain = r3(-apex);
  if (finite(pickup) && pickup >= PICKUP_M) cue.throttleShiftM = r3(-pickup);
  if (finite(exit) && exit <= -APEX_KPH) cue.exitKphGain = r3(-exit);
  return cue;
}

/* -------------------------------------------------------------------------- */
/*  The answers                                                               */
/* -------------------------------------------------------------------------- */

const LEARNING_LINE = 'Still learning your laps. Give me another clean lap or two.';

function answerLap(snap: LiveCoachSnapshot): string {
  const last = snap.last;
  if (!last || !finite(last.lapSec) || last.lapSec <= 0) return 'No timed lap yet.';
  const time = speakableLapTime(last.lapSec);
  if (!last.valid) return `${time}, but that one doesn't count, so no coaching on it.`;
  const ref = refWords(last.refKind);
  if (last.refLapId && last.lapId === last.refLapId) return `${time}. That's your best, it's the new reference.`;
  const b = last.breakdown;
  const d = lapDelta(last);
  if (!b || d === null) return `${time}. No trace on that one, so no corner read.`;
  let head: string;
  if (Math.abs(d) < 0.05) head = `${time}, right on ${ref}.`;
  else if (d > 0) head = `${time}, ${speakableTenths(d)} off ${ref}.`;
  else head = `${time}, ${speakableTenths(d)} quicker than ${ref}.`;
  const big = biggestOn(b);
  if (!big || big.loss < SAY_LOSS_SEC) return `${head} Nothing big anywhere.`;
  return `${head} Biggest loss: ${spokenCorner(big.id)}, ${speakableTenths(big.loss)} ${PHASE_SPOKEN[big.phase]}.`;
}

function answerLoss(snap: LiveCoachSnapshot): string {
  const st = snap.state;
  const stats = windowStats(snap);
  const focus = st && st.focus;
  if (!focus && !stats.size) return LEARNING_LINE;
  const fixed = st && Array.isArray(st.fixed) ? st.fixed : [];
  let first: { id: string; loss: number; phase: CoachPhase | null };
  if (focus) {
    first = { id: focus.cornerId, loss: focus.lossSec, phase: focus.cue ? focus.cue.phase : null };
  } else {
    const top = ranked(stats)[0]!;
    if (top.mean < SAY_LOSS_SEC) return "Nothing consistent. You're close to the reference everywhere.";
    const c = cornerIn(snap.lastValid && snap.lastValid.breakdown, top.id);
    first = { id: top.id, loss: top.mean, phase: c ? dominantPhase(c) : null };
  }
  const next = ranked(stats, [first.id, ...fixed]).find((s) => s.mean >= SAY_LOSS_SEC) || null;
  let line = `${cap(spokenCorner(first.id))}, about ${speakableTenths(first.loss)} a lap`;
  line += first.phase ? `, mostly ${PHASE_SPOKEN[first.phase]}.` : '.';
  if (next) line += ` Then ${spokenCorner(next.id)}, ${speakableTenths(next.mean)}.`;
  return line;
}

/* ---- v2: the work list ----------------------------------------------------- */

/**
 * The corners being worked on, costliest first: `state.work` (v2), else the
 * v1 focus alone. A corner already fixed is not on it.
 */
function workOf(snap: LiveCoachSnapshot | null): LiveFocus[] {
  const st = snap && snap.state;
  if (!st) return [];
  const list = Array.isArray(st.work) ? st.work : st.focus ? [st.focus] : [];
  return list.filter((f): f is LiveFocus => !!f && typeof f.cornerId === 'string' && f.status !== 'fixed');
}

/** True when the engine keeps a real work list (v2) with more than one corner on it. */
const hasWorkList = (snap: LiveCoachSnapshot): boolean => Array.isArray(snap.state.work) && workOf(snap).length > 1;

const focusNo = (f: LiveFocus): number | string => (finite(f.cornerNo) && f.cornerNo > 0 ? f.cornerNo : f.cornerId);
const stripEnd = (s: unknown): string => String(s || '').replace(/[.!?]+$/, '').trim();

/** "corner four" / "corners three, seven and nine". */
export function spokenCorners(ids: readonly (string | number)[]): string {
  const nums = ids.map((id) => (typeof id === 'number' ? id : cornerNoOf(id)));
  if (ids.length === 1) return spokenCorner(ids[0]!);
  if (nums.every((n) => n !== null)) return `corners ${listWords(nums.map((n) => numberWords(n!)))}`;
  return listWords(ids.map((id) => spokenCorner(id)));
}

/**
 * "What should I work on" with a work list: every corner on it, costliest
 * first, with what to change there and what it is worth. "Three to work on.
 * Corner five: brake ten metres later, worth two tenths. Corner nine: …"
 */
function answerWorkList(snap: LiveCoachSnapshot): string {
  const work = workOf(snap);
  const lines = work.map((f) => {
    const where = cap(spokenCorner(focusNo(f)));
    const cue = cueWords(f.cue) || stripEnd(f.spoken);
    const worth = finite(f.lossSec) && f.lossSec >= SAY_LOSS_SEC ? `, worth ${speakableTenths(f.lossSec)}` : '';
    const coming = f.status === 'improving' ? ", and it's coming" : '';
    return cue ? `${where}: ${cue}${worth}${coming}.` : `${where}${worth}${coming}.`;
  });
  return `${cap(numberWords(work.length))} to work on. ${lines.join(' ')}`;
}

function answerWorkOn(snap: LiveCoachSnapshot): string {
  if (hasWorkList(snap)) return answerWorkList(snap);
  const st = snap.state;
  const focus = st && st.focus;
  if (!focus) {
    return windowStats(snap).size ? 'Nothing stands out. Keep putting the laps in.' : LEARNING_LINE;
  }
  const where = cap(spokenCorner(focus.cornerNo || focus.cornerId));
  if (focus.status === 'fixed') return `${where}'s sorted. I'll find you the next one.`;
  const cue = cueWords(focus.cue) || String(focus.spoken || '').replace(/[.!?]+$/, '');
  const head = cue ? `${where}: ${cue}.` : `${where}.`;
  if (focus.status === 'improving') return `${head} It's coming, keep at it.`;
  return finite(focus.lossSec) && focus.lossSec >= SAY_LOSS_SEC
    ? `${head} Worth about ${speakableTenths(focus.lossSec)} a lap.`
    : head;
}

/**
 * v2: a work-list corner in full: its window loss and phase, the cue and
 * `cue2` with their numbers, and how it is going against the baseline it
 * joined the list with. "Corner nine: a tenth a lap over your last three
 * laps, mostly in the middle of the corner. Brake six metres later and carry
 * four kilometres an hour more to the apex. Number two on the list; last lap
 * it cost a tenth."
 */
function answerWorkCorner(snap: LiveCoachSnapshot, f: LiveFocus, stat: WindowStat | undefined): string {
  const Name = cap(spokenCorner(focusNo(f)));
  const loss = finite(f.lossSec) ? f.lossSec : stat ? stat.mean : 0;
  const span = stat && stat.laps >= 2 ? `over your last ${numberWords(stat.laps)} laps` : 'on your last lap';
  const phase = f.cue ? f.cue.phase : null;
  let line = `${Name}: ${speakableTenths(loss)} a lap ${span}`;
  line += phase ? `, mostly ${PHASE_SPOKEN[phase]}.` : '.';
  const cue = cueDetailWords(f.cue, f.cue2) || stripEnd(f.spoken);
  if (cue) line += ` ${cap(cue)}.`;
  const rank = finite(f.rank) && f.rank > 0 ? f.rank : workOf(snap).indexOf(f) + 1;
  const where = rank === 1 ? 'Top of the list' : `Number ${numberWords(rank)} on the list`;
  if (finite(f.gainSec) && f.gainSec >= SAY_LOSS_SEC) {
    line += ` ${where}, and you've won back ${speakableTenths(f.gainSec)} on it already.`;
  } else if (finite(f.lastLossSec) && f.lastLossSec <= LEVEL_SEC) {
    line += ` ${where}, but it was fine last lap. Do that again.`;
  } else if (finite(f.lastLossSec) && f.lastLossSec >= SAY_LOSS_SEC) {
    line += ` ${where}; last lap it cost ${speakableTenths(f.lastLossSec)}.`;
  } else {
    line += ` ${where}.`;
  }
  return line;
}

function answerCorner(snap: LiveCoachSnapshot, n: number): string {
  const id = `C${n}`;
  const name = spokenCorner(n);
  const stats = windowStats(snap);
  const lastB = snap.lastValid && snap.lastValid.breakdown;
  const focus = snap.state && snap.state.focus;
  // v2: a corner on the work list gets everything the coach knows about it;
  // one put right this run says what it won back.
  if (Array.isArray(snap.state.work)) {
    const w = workOf(snap).find((f) => f.cornerId === id);
    if (w) return answerWorkCorner(snap, w, stats.get(id));
    const better = (Array.isArray(snap.state.runImproved) ? snap.state.runImproved : []).find((x) => x && x.cornerId === id);
    if (better && finite(better.gainSec) && better.gainSec >= SAY_LOSS_SEC) {
      const s = stats.get(id);
      const now =
        s && Math.abs(s.mean) > LEVEL_SEC && s.mean > 0
          ? ` Still ${speakableTenths(s.mean)} a lap in it.`
          : ' Keep doing what you did there.';
      return `${cap(name)}'s better: ${speakableTenths(better.gainSec)} back this run.${now}`;
    }
  }
  const known = new Set<string>([...stats.keys()]);
  if (lastB && Array.isArray(lastB.corners)) for (const c of lastB.corners) if (c) known.add(c.id);
  if (focus) known.add(focus.cornerId);
  if (!known.has(id)) {
    const nums = [...known].map(cornerNoOf).filter((x): x is number => x !== null);
    const max = nums.length ? Math.max(...nums) : 0;
    if (max && n > max) return `There's no ${name}. The last one's ${spokenCorner(max)}.`;
    return `Nothing on ${name} yet.`;
  }
  const isFocus = !!focus && focus.cornerId === id;
  const corner = cornerIn(lastB, id);
  const stat = stats.get(id);
  const ref = refWords(snap.lastValid ? snap.lastValid.refKind : snap.last ? snap.last.refKind : undefined);
  let loss: number;
  let span: string;
  if (stat) {
    loss = isFocus && finite(focus!.lossSec) ? focus!.lossSec : stat.mean;
    span = stat.laps >= 2 ? `over your last ${numberWords(stat.laps)} laps` : 'on your last lap';
  } else if (corner) {
    loss = driverLoss(corner);
    span = 'on your last lap';
  } else {
    return `Nothing on ${name} yet.`;
  }
  const Name = cap(name);
  if (Math.abs(loss) <= LEVEL_SEC) return `${Name}'s fine, level with ${ref} ${span}.`;
  if (loss < 0) return `${Name}'s good, ${speakableTenths(loss)} quicker than ${ref} ${span}.`;
  const phase = isFocus && focus!.cue ? focus!.cue.phase : corner ? dominantPhase(corner) : null;
  const cue = isFocus ? cueWords(focus!.cue) : corner ? cueWords(cueFromCorner(corner, snap.trackLengthM)) : '';
  let line = `${Name}: ${speakableTenths(loss)} a lap ${span}`;
  line += phase ? `, mostly ${PHASE_SPOKEN[phase]}.` : '.';
  if (cue) line += ` ${cap(cue)}.`;
  return line;
}

function answerSpread(snap: LiveCoachSnapshot): string {
  const times = windowLapTimes(snap);
  if (times.length < 2) return 'I need a couple more clean laps to tell.';
  const spread = Math.max(...times) - Math.min(...times);
  const n = numberWords(times.length);
  let line: string;
  if (spread < 0.05) line = `Your last ${n} clean laps are all within a tenth. Very consistent.`;
  else if (spread <= SPREAD_TIGHT_SEC) line = `Your last ${n} clean laps are within ${speakableTenths(spread)}. Nicely consistent.`;
  else if (spread <= SPREAD_OK_SEC) line = `Your last ${n} clean laps are within ${speakableTenths(spread)}. Fairly consistent.`;
  else line = `${cap(speakableTenths(spread))} between your best and worst of the last ${n}. Find a rhythm before you push.`;
  // Where the laps differ most: the corner whose loss swings widest across the window.
  let swing: { id: string; range: number } | null = null;
  for (const s of windowStats(snap).values()) {
    if (s.values.length < 2) continue;
    const range = Math.max(...s.values) - Math.min(...s.values);
    if (!swing || range > swing.range) swing = { id: s.id, range };
  }
  if (swing && swing.range >= 0.1 && spread >= 0.05) line += ` Most of the difference is in ${spokenCorner(swing.id)}.`;
  return line;
}

/* ---- v2: the run debrief, asked for ----------------------------------------- */

const RUN_LEARNING_LINE = 'Not enough clean laps on this run yet. Give me a couple more.';

/**
 * The run debrief behind "how am I doing": the snapshot's own when the
 * service put one there (null = not enough laps yet), else the engine's
 * `runDebrief` when it has one, else undefined (a v1 engine: the voice words
 * one from the state itself, {@link templateDebrief}).
 */
export function debriefOf(snap: LiveCoachSnapshot | null): LiveRunDebrief | null | undefined {
  if (!snap || !snap.state) return undefined;
  if (Object.prototype.hasOwnProperty.call(snap, 'debrief') && snap.debrief !== undefined) return snap.debrief || null;
  const fn = (liveCoachEngineModule as unknown as Partial<LiveCoachEngine>).runDebrief;
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(snap.state) || null;
  } catch {
    return undefined;
  }
}

/**
 * A debrief worded from the state alone, for an engine with no `runDebrief`
 * (and the v1 state: no work list, no run): what got better this run, then
 * the corners still to work on with what to change. "You've improved corner
 * three, about two tenths. Still to work on: corner five, brake ten metres
 * later, worth two tenths."
 */
function templateDebrief(snap: LiveCoachSnapshot): string {
  const st = snap.state;
  const improved = (Array.isArray(st.runImproved) ? st.runImproved : []).filter(
    (x) => x && typeof x.cornerId === 'string' && finite(x.gainSec) && x.gainSec >= SAY_LOSS_SEC,
  );
  const still = workOf(snap).slice(0, 2);
  const out: string[] = [];
  if (improved.length) {
    const sum = improved.reduce((a, x) => a + x.gainSec, 0);
    out.push(`You've improved ${spokenCorners(improved.map((x) => x.cornerId))}, about ${speakableTenths(sum)}${improved.length > 1 ? ' in all' : ''}.`);
  }
  if (still.length) {
    const parts = still.map((f) => {
      const cue = cueWords(f.cue) || stripEnd(f.spoken);
      const worth = finite(f.lossSec) && f.lossSec >= SAY_LOSS_SEC ? `, worth ${speakableTenths(f.lossSec)}` : '';
      return `${spokenCorner(focusNo(f))}${cue ? `, ${cue}` : ''}${worth}`;
    });
    out.push(`Still to work on: ${parts.join(', and ')}.`);
  }
  if (out.length) return out.join(' ');
  return windowStats(snap).size ? 'Nothing stands out. Keep putting the laps in.' : LEARNING_LINE;
}

function answerDebrief(snap: LiveCoachSnapshot): string {
  const d = debriefOf(snap);
  if (d && typeof d.text === 'string' && d.text.trim()) return d.text.trim();
  if (d === null) return snap.state.validLaps > 0 ? RUN_LEARNING_LINE : LEARNING_LINE;
  return templateDebrief(snap);
}

/**
 * The driver's words → one spoken answer, or null when they are not a coach
 * question. Null snapshot = the coach is not live: the plain line for the
 * coach-only questions, null for "how was that lap" so the engineer's own
 * last-lap answer takes it.
 */
export function answerCoachQuestion(text: string, snap: LiveCoachSnapshot | null): string | null {
  const q = coachQuestionOf(text);
  if (!q) return null;
  if (!snap || !snap.state) return null;
  switch (q.intent) {
    case 'coachLap':
      return answerLap(snap);
    case 'coachLoss':
      return answerLoss(snap);
    case 'coachWorkOn':
      return answerWorkOn(snap);
    case 'coachCorner':
      return answerCorner(snap, q.cornerNo!);
    case 'coachSpread':
      return answerSpread(snap);
    case 'coachDebrief':
      return answerDebrief(snap);
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  The AI summary: the request                                               */
/* -------------------------------------------------------------------------- */

/** What the request's context carries besides the numbers (the service knows these; the snapshot does not). */
export interface LiveCoachSummaryContext {
  track?: string;
  car?: string;
  carClass?: string;
  /** "Session best · 1:43.210", a board driver … — else the reference's kind, in words. */
  targetLabel?: string;
}

/**
 * A 32-hex-digit hash (two FNV-1a lanes) of everything the model sees — the
 * function's `inputHash` must be 16..128 hex. coach-ipc.js `requestFromRaw`
 * replaces it with its own sha256, which is what its caches key on.
 */
function hashHex(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (i & 0xff), 0x01000193) >>> 0;
  }
  let c2 = Math.imul(a ^ b, 0x85ebca6b) >>> 0;
  let d2 = Math.imul(b ^ (a >>> 7), 0xc2b2ae35) >>> 0;
  c2 ^= c2 >>> 13;
  d2 ^= d2 >>> 16;
  const hex = (x: number): string => (x >>> 0).toString(16).padStart(8, '0');
  return hex(a) + hex(b) + hex(c2) + hex(d2);
}

class FactList {
  readonly list: CoachFact[] = [];
  private readonly ids = new Set<string>();
  add(f: CoachFact): void {
    if (!finite(f.value) || this.ids.has(f.id)) return;
    this.ids.add(f.id);
    this.list.push({ ...f, value: r3(f.value) });
  }
}

const lostOrGained = (v: number): string => `${fmtSec(v)} ${v >= 0 ? 'lost' : 'gained'}`;

/**
 * One corner's measurable facts, in coachReport.ts's ids and wording. `cue`
 * (the engine's, over the window) wins over the last lap's own deltas.
 */
function cornerDetailFacts(F: FactList, id: string, corner: CornerPhaseLoss | null, cue: LiveFocusCue | null, L: number): void {
  const c = cue || (corner ? cueFromCorner(corner, L) : null);
  const scope = cue ? '' : ' on your last lap';
  if (c) {
    if (finite(c.brakeShiftM) && Math.abs(c.brakeShiftM) >= BRAKE_M) {
      const v = -c.brakeShiftM; // mine − ref: + = later
      F.add({
        id: `${id}.brakeDeltaM`, cornerId: id, phase: 'braking', kind: 'brakeDeltaM', value: v, unit: 'm',
        text: `${id}: you brake ${Math.round(Math.abs(v))} m ${v < 0 ? 'earlier' : 'later'} than the target${scope}.`,
      });
    }
    if (finite(c.minKphGain) && Math.abs(c.minKphGain) >= APEX_KPH) {
      const v = -c.minKphGain; // + = faster
      F.add({
        id: `${id}.minKphDelta`, cornerId: id, phase: 'midCorner', kind: 'minKphDelta', value: v, unit: 'kph',
        text: `${id}: ${Math.round(Math.abs(v))} km/h ${v < 0 ? 'slower' : 'faster'} at the apex than the target${scope}.`,
      });
    }
    if (finite(c.throttleShiftM) && Math.abs(c.throttleShiftM) >= PICKUP_M) {
      const v = -c.throttleShiftM; // + = back on the throttle later
      F.add({
        id: `${id}.pickupDeltaM`, cornerId: id, phase: 'exit', kind: 'pickupDeltaM', value: v, unit: 'm',
        text: `${id}: back on the throttle ${Math.round(Math.abs(v))} m ${v > 0 ? 'later' : 'earlier'} than the target${scope}.`,
      });
    }
    if (finite(c.exitKphGain) && Math.abs(c.exitKphGain) >= APEX_KPH) {
      const v = -c.exitKphGain;
      F.add({
        id: `${id}.exitKphDelta`, cornerId: id, phase: 'exit', kind: 'exitKphDelta', value: v, unit: 'kph',
        text: `${id}: ${Math.round(Math.abs(v))} km/h ${v < 0 ? 'slower' : 'faster'} on the exit${scope}.`,
      });
    }
  }
  if (corner) {
    const p = c ? c.phase : dominantPhase(corner);
    const v = driverPhases(corner)[p];
    if (Math.abs(v) >= 0.01) {
      F.add({
        id: `${id}.${p}.loss`, cornerId: id, phase: p, kind: 'phaseLoss', value: v, unit: 's',
        text: `${id}: ${lostOrGained(v)} ${PHASE_WHERE[p]} on your last lap.`,
      });
    }
    if (corner.straightFlag && finite(corner.straightSec) && corner.straightSec >= 0.01) {
      F.add({
        id: `${id}.straight`, cornerId: id, phase: 'exitRun', kind: 'straightTime', value: corner.straightSec, unit: 's',
        text:
          corner.straightFlag === 'tow'
            ? `${id}: ${fmtSec(corner.straightSec)} on the straight after it came from a tow, not your driving.`
            : `${id}: ${fmtSec(corner.straightSec)} on the straight after it is straight-line speed, not your driving.`,
      });
    }
  }
}

function lossFact(F: FactList, id: string, loss: number, laps: number): void {
  const span = laps >= 2 ? `over your last ${laps} laps` : 'on your last lap';
  F.add({
    id: `${id}.loss`, cornerId: id, kind: 'cornerLoss', value: loss, unit: 's',
    text: loss >= 0 ? `${id} costs ${fmtSec(loss)} a lap ${span}.` : `${id} gains ${fmtSec(loss)} a lap ${span}.`,
  });
}

function consistencyFact(F: FactList, s: WindowStat | undefined): void {
  if (!s || s.laps < 2) return;
  F.add({
    id: `${s.id}.consistency`, cornerId: s.id, kind: 'consistency', value: s.losing, unit: 'laps',
    text: `${s.id} lost time on ${s.losing} of ${s.laps} laps.`,
  });
}

/**
 * The every-few-laps summary as a CoachAiRequest the deployed `coach`
 * function accepts: kind 'session' (an existing kind), facts in coachReport's
 * ids and shapes, every value finite, text under the function's 240 chars.
 * The session so far (valid laps, the last clean lap against the reference,
 * the window's spread), the focus (its loss, its cue as facts, how it is
 * trending), the next two corners, and corners already put right. Null when
 * there is no corner to talk about yet.
 */
export function summaryRequest(snap: LiveCoachSnapshot | null, context: LiveCoachSummaryContext = {}): CoachAiRequest | null {
  if (!snap || !snap.state) return null;
  const st = snap.state;
  const L = snap.trackLengthM;
  const F = new FactList();
  const stats = windowStats(snap);
  const lastValid = snap.lastValid;
  const lastB = lastValid && lastValid.breakdown;
  const refLabel = String(context.targetLabel || refWords(lastValid ? lastValid.refKind : undefined));

  // -- the corners ---------------------------------------------------------------
  const focus = st.focus;
  const fixed = Array.isArray(st.fixed) ? st.fixed : [];
  if (focus) {
    const s = stats.get(focus.cornerId);
    lossFact(F, focus.cornerId, focus.lossSec, s ? s.laps : 1);
    cornerDetailFacts(F, focus.cornerId, cornerIn(lastB, focus.cornerId), focus.cue || null, L);
    consistencyFact(F, s);
    if (s && s.values.length >= 2) {
      const a = s.values[0]!;
      const z = s.values[s.values.length - 1]!;
      F.add({
        id: `${focus.cornerId}.trend`, cornerId: focus.cornerId, kind: 'trend', value: z - a, unit: 's',
        text: `${focus.cornerId}: ${lostOrGained(a)} on the first of your last ${s.values.length} laps, ${lostOrGained(z)} on the latest.`,
      });
    }
  }
  const others = ranked(stats, [focus ? focus.cornerId : '', ...fixed])
    .filter((s) => s.mean > LEVEL_SEC)
    .slice(0, focus ? 2 : 3);
  for (const s of others) {
    lossFact(F, s.id, s.mean, s.laps);
    cornerDetailFacts(F, s.id, cornerIn(lastB, s.id), null, L);
    consistencyFact(F, s);
  }
  for (const id of fixed.slice(-2)) {
    const s = stats.get(id);
    F.add({
      id: `${id}.fixed`, cornerId: id, kind: 'fixed', value: s ? s.mean : 0, unit: 's',
      text: s ? `${id} is sorted: ${fmtSec(s.mean)} a lap ${s.mean >= 0 ? 'off' : 'up'} now.` : `${id} is sorted.`,
    });
  }
  if (!F.list.length) return null;

  // -- the session so far --------------------------------------------------------
  F.add({ id: 'session.laps', kind: 'laps', value: st.validLaps, unit: 'laps', text: `${st.validLaps} clean laps so far this session.` });
  let lapSec: number | null = null;
  let refSec: number | null = null;
  if (lastValid && finite(lastValid.lapSec) && lastValid.lapSec > 0) {
    lapSec = lastValid.lapSec;
    F.add({ id: 'lap.time', kind: 'lapTime', value: lapSec, unit: 's', text: `Last clean lap ${fmtLap(lapSec)}.` });
    const gap = lapDelta(lastValid);
    if (gap !== null) {
      refSec = r3(lapSec - gap);
      F.add({
        id: 'lap.gap', kind: 'targetGap', value: gap, unit: 's',
        text: `${fmtSec(gap)} ${gap >= 0 ? 'off' : 'under'} the reference (${refLabel.slice(0, 80)}).`,
      });
    }
  }
  const times = windowLapTimes(snap);
  if (times.length >= 2) {
    const spread = Math.max(...times) - Math.min(...times);
    F.add({
      id: 'session.consistency', kind: 'consistency', value: spread, unit: 's',
      text: `Your last ${times.length} clean laps are within ${fmtSec(spread)} of each other.`,
    });
  }

  const ctx = {
    track: String(context.track || ''),
    car: String(context.car || ''),
    carClass: String(context.carClass || ''),
    targetLabel: refLabel,
    lapSec,
    refSec,
  };
  const facts = F.list;
  const inputHash = hashHex(
    JSON.stringify(['live', ctx.track, ctx.car, ctx.carClass, ctx.targetLabel, lapSec, refSec, facts.map((f) => [f.id, f.value, f.unit, f.text])]),
  );
  return { kind: 'session', inputHash, context: ctx, facts };
}

/**
 * The contract's view of the summary request: the facts (full CoachFacts —
 * they carry `id` and `text` and everything the function also needs) and the
 * fact block the model is shown. The function writes its own system prompt;
 * nothing here is sent as one. Use {@link summaryRequest} to call the AI.
 */
export function summaryFacts(snap: LiveCoachSnapshot): { facts: CoachFact[]; prompt: string } {
  const req = summaryRequest(snap);
  if (!req) return { facts: [], prompt: '' };
  return { facts: req.facts, prompt: ['KIND: session', 'FACTS:', ...req.facts.map((f) => `${f.id} | ${f.text}`)].join('\n') };
}

/* -------------------------------------------------------------------------- */
/*  The AI summary: the answer                                                */
/* -------------------------------------------------------------------------- */

/** Which cited fact says HOW MUCH a takeaway is worth, best first. */
const WORTH_KINDS = ['cornerLoss', 'pattern', 'sequenceLoss', 'sectorLoss', 'phaseLoss'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The first sentence of a text, end punctuation removed. */
function firstSentence(s: string): string {
  const one = String(s).trim().split(/(?<=[.!?])\s+/)[0] || '';
  return one.replace(/[.!?…]+$/, '').trim();
}

/** The AI's words made Piper-safe: corner ids said, symbols out. Null when a number of its own is left. */
function speakify(s: string): string | null {
  let out = String(s)
    .replace(/\bC(\d{1,3})\b/g, (_m, n: string) => spokenCorner(Number(n)))
    .replace(/[“”"()[\]{}*_#]/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s*;\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\d/.test(out)) return null; // the model's own number: never spoken
  out = out.replace(/,\s*,/g, ',').replace(/,\s*$/, '');
  return out || null;
}

/**
 * The validated AI result → at most two short spoken sentences, or null.
 * `reply` is the CoachAiResult (`ai`) or the whole `{ ok, ai }` answer. The
 * words for WHAT come from the AI's takeaways; HOW MUCH comes from the cited
 * fact ("worth about two tenths a lap"), never from the AI. A takeaway citing
 * a fact the request did not hold, or carrying a number of its own, is
 * dropped. `request` is the one that was sent (its facts are what the AI
 * cited); without it the facts are rebuilt from `snap`, which is the same
 * unless a lap landed while the AI was thinking.
 */
export function speakableSummary(reply: unknown, snap: LiveCoachSnapshot | null, request?: CoachAiRequest | null): string | null {
  let ai: unknown = reply;
  if (isObj(ai) && 'ai' in ai) {
    if (ai.ok === false) return null;
    ai = ai.ai;
  }
  if (!isObj(ai) || !Array.isArray(ai.takeaways)) return null;
  const facts = request && Array.isArray(request.facts) ? request.facts : summaryRequest(snap)?.facts || [];
  if (!facts.length) return null;
  const byId = new Map(facts.map((f) => [f.id, f]));
  const corners = new Set<string>();
  for (const f of facts) if (f.cornerId) corners.add(String(f.cornerId).toUpperCase());

  const sentences: string[] = [];
  for (const t of ai.takeaways) {
    if (sentences.length >= 2) break;
    if (!isObj(t) || typeof t.title !== 'string' || typeof t.body !== 'string') continue;
    const ids = Array.isArray(t.factIds) ? t.factIds.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length || ids.some((id) => !byId.has(id))) continue;
    const named = `${t.title} ${t.body}`.match(/\bC\d{1,3}\b/g) || [];
    if (named.some((c) => !corners.has(c.toUpperCase()))) continue;
    let words = firstSentence(t.body);
    if (!words || wordCount(words) > SUMMARY_SENTENCE_WORDS) words = firstSentence(t.title);
    const said = speakify(words);
    if (!said) continue;
    const cited = ids.map((id) => byId.get(id)!);
    let worth: CoachFact | undefined;
    for (const k of WORTH_KINDS) {
      worth = cited.find((f) => f.kind === k && f.unit === 's' && finite(f.value) && f.value >= SAY_LOSS_SEC);
      if (worth) break;
    }
    const tail = worth ? `, worth about ${speakableTenths(worth.value)} ${worth.kind === 'phaseLoss' ? 'on that lap' : 'a lap'}` : '';
    const sentence = `${cap(said)}${tail}.`;
    if (sentences.length && wordCount(sentences.join(' ')) + wordCount(sentence) > SUMMARY_TOTAL_WORDS) break;
    sentences.push(sentence);
  }
  if (!sentences.length) {
    const head = typeof ai.headline === 'string' ? speakify(firstSentence(ai.headline)) : null;
    return head && wordCount(head) <= SUMMARY_SENTENCE_WORDS ? `${cap(head)}.` : null;
  }
  return sentences.join(' ');
}

/* -------------------------------------------------------------------------- */
/*  v2: the run debrief through the AI                                        */
/* -------------------------------------------------------------------------- */

/**
 * What the model is asked for. The deployed function writes its own system
 * prompt and shows the model only the context line and the facts, so the
 * shape of a debrief rides in as the first fact (no figure in its text, value
 * 0 in 'pts', which no spoken figure is checked against: cited or not, it
 * changes nothing the validator or {@link debriefGuard} checks).
 */
const DEBRIEF_BRIEF =
  'Radio debrief of this run, at most three short sentences: first what improved, naming every improved corner; ' +
  'then each corner still to work on and what to change there. Say what to do.';

/** Words a debrief sentence of the model's may take before its title stands in. */
const DEBRIEF_SENTENCE_WORDS = MAX_SPOKEN_WORDS;
/** The whole spoken debrief, the figures we add included. */
const DEBRIEF_TOTAL_WORDS = 50;
const DEBRIEF_SENTENCES = 3;

/**
 * The run debrief as a CoachAiRequest the deployed `coach` function accepts,
 * in exactly {@link summaryRequest}'s shape (kind 'session', facts cited by
 * id, every value finite) and sent the same way (coach-ipc `askAi`):
 *
 *   run.brief            the shape asked for (see DEBRIEF_BRIEF)
 *   C3.gain …            each improved corner: the time won back this run
 *   run.gain             the improved corners together (two or more)
 *   C5.loss              each corner still to work on: what it costs a lap
 *   C5.brakeDeltaM …     its cue and cue2 as coachReport's measured facts
 *                        (signs as the validator checks them), else the last
 *                        clean lap's own deltas
 *   C5.what              the engine's words for what to change there
 *   run.laps, lap.time   the run's clean laps, the last clean lap
 *
 * `ctx` is the summary's (track, car, class, the reference's label). Null
 * when the debrief names no corner.
 */
export function debriefRequest(
  debrief: LiveRunDebrief | null,
  snap: LiveCoachSnapshot | null,
  ctx: LiveCoachSummaryContext & { lapSec?: number | null; refSec?: number | null } = {},
): CoachAiRequest | null {
  if (!debrief) return null;
  const improved = (Array.isArray(debrief.improved) ? debrief.improved : []).filter(
    (x) => x && typeof x.cornerId === 'string' && finite(x.gainSec),
  );
  const still = (Array.isArray(debrief.still) ? debrief.still : []).filter((x) => x && typeof x.cornerId === 'string' && finite(x.lossSec));
  if (!improved.length && !still.length) return null;
  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const L = snap && finite(snap.trackLengthM) ? snap.trackLengthM : 0;
  const lastValid = snap ? snap.lastValid : null;
  const lastB = lastValid && lastValid.breakdown;
  const work = workOf(snap);
  const F = new FactList();

  F.add({ id: 'run.brief', kind: 'brief', value: 0, unit: 'pts', text: DEBRIEF_BRIEF });
  for (const x of improved) {
    F.add({
      id: `${x.cornerId}.gain`, cornerId: x.cornerId, kind: 'gain', value: x.gainSec, unit: 's',
      text: `${x.cornerId}: ${fmtSec(x.gainSec)} a lap ${x.gainSec >= 0 ? 'won back' : 'given away'} this run.`,
    });
  }
  if (improved.length >= 2) {
    const sum = improved.reduce((a, x) => a + x.gainSec, 0);
    F.add({
      id: 'run.gain', kind: 'gain', value: sum, unit: 's',
      text: `${fmtSec(sum)} a lap won back this run in ${listWords(improved.map((x) => x.cornerId))}.`,
    });
  }
  for (const x of still) {
    const id = x.cornerId;
    F.add({ id: `${id}.loss`, cornerId: id, kind: 'cornerLoss', value: x.lossSec, unit: 's', text: `${id} still costs ${fmtSec(x.lossSec)} a lap.` });
    const w = work.find((f) => f.cornerId === id) || null;
    cornerDetailFacts(F, id, cornerIn(lastB, id), w && w.cue ? w.cue : null, L);
    if (w && w.cue2) cornerDetailFacts(F, id, null, w.cue2, L);
    const what = stripEnd(x.what).slice(0, 200);
    if (what) F.add({ id: `${id}.what`, cornerId: id, kind: 'advice', value: 0, unit: 'pts', text: `${id}, what to change: ${what}.` });
  }
  if (finite(debrief.laps) && debrief.laps > 0) {
    F.add({ id: 'run.laps', kind: 'laps', value: debrief.laps, unit: 'laps', text: `${debrief.laps} clean laps in this run.` });
  }
  let lapSec: number | null = finite(context.lapSec) ? context.lapSec : null;
  let refSec: number | null = finite(context.refSec) ? context.refSec : null;
  if (lastValid && finite(lastValid.lapSec) && lastValid.lapSec > 0) {
    lapSec = lastValid.lapSec;
    F.add({ id: 'lap.time', kind: 'lapTime', value: lapSec, unit: 's', text: `Last clean lap ${fmtLap(lapSec)}.` });
    const gap = lapDelta(lastValid);
    if (gap !== null) refSec = r3(lapSec - gap);
  }

  const c = {
    track: String(context.track || ''),
    car: String(context.car || ''),
    carClass: String(context.carClass || ''),
    targetLabel: String(context.targetLabel || refWords(lastValid ? lastValid.refKind : undefined)),
    lapSec,
    refSec,
  };
  const facts = F.list;
  const inputHash = hashHex(
    JSON.stringify(['live-debrief', c.track, c.car, c.carClass, c.targetLabel, lapSec, refSec, facts.map((f) => [f.id, f.value, f.unit, f.text])]),
  );
  return { kind: 'session', inputHash, context: c, facts };
}

/* ---- the guard ------------------------------------------------------------ */

const TENS_OF: Record<string, number> = Object.fromEntries(
  TENS.map((w, i): [string, number] => [w, i * 10]).filter(([w]) => !!w),
);

/** The number at `tok[i]` (digits, "seven", "twenty one"), and how many tokens it took. */
function quantityAt(tok: readonly string[], i: number): { n: number; len: number } | null {
  const w = tok[i];
  if (!w) return null;
  if (/^\d+(?:\.\d+)?$/.test(w)) return { n: Number(w), len: 1 };
  const o = ONES.indexOf(w);
  if (o >= 0) return { n: o, len: 1 };
  if (w in TENS_OF) {
    const next = ONES.indexOf(tok[i + 1] || '');
    return next >= 1 && next <= 9 ? { n: TENS_OF[w]! + next, len: 2 } : { n: TENS_OF[w]!, len: 1 };
  }
  return null;
}

type SaidUnit = 's' | 'm' | 'kph' | 'laps';

/** The unit after a number: "tenths", "metres", "kilometres an hour", "k" … (and how many tokens it took). */
function unitAt(tok: readonly string[], i: number): { unit: SaidUnit; scale: number; len: number } | null {
  // "six clean laps": one word of the coach's own between the number and its unit.
  if (/^(?:clean|valid|timed|good|more)$/.test(tok[i] || '') && tok[i + 1]) {
    const u = unitAt(tok, i + 1);
    return u ? { ...u, len: u.len + 1 } : null;
  }
  const w = tok[i] || '';
  if (w === 'tenth' || w === 'tenths') return { unit: 's', scale: 0.1, len: 1 };
  if (w === 'hundredth' || w === 'hundredths') return { unit: 's', scale: 0.01, len: 1 };
  if (w === 'second' || w === 'seconds' || w === 's' || w === 'sec' || w === 'secs') return { unit: 's', scale: 1, len: 1 };
  if (w === 'metre' || w === 'metres' || w === 'meter' || w === 'meters' || w === 'm') return { unit: 'm', scale: 1, len: 1 };
  if (w === 'kilometres' || w === 'kilometers' || w === 'kilometre' || w === 'kilometer') {
    return { unit: 'kph', scale: 1, len: tok[i + 1] === 'an' && tok[i + 2] === 'hour' ? 3 : tok[i + 1] === 'per' && tok[i + 2] === 'hour' ? 3 : 1 };
  }
  if (w === 'k' || w === 'kph' || w === 'kmh' || w === 'km') return { unit: 'kph', scale: 1, len: tok[i + 1] === 'h' ? 2 : 1 };
  if (w === 'lap' || w === 'laps') return { unit: 'laps', scale: 1, len: 1 };
  return null;
}

/** How far a said figure may sit from the measured one and still be the same number, as the radio rounds it. */
const SAID_TOLERANCE: Record<SaidUnit, number> = { s: 0.05 + 1e-6, m: 0.5 + 1e-6, kph: 0.5 + 1e-6, laps: 1e-6 };

/**
 * v2: the strict check on a spoken run debrief. Empty = it may be said; else
 * every reason it may not:
 *
 *   - more than three sentences, or none;
 *   - a raw corner id ("C5"), "turn five", or a symbol Piper reads badly
 *     (km/h, %, Δ, /);
 *   - a corner (also in a list: "corners three, seven and nine") that the
 *     debrief does not name;
 *   - a figure ("two tenths", "ten metres", "4 kilometres an hour") that no
 *     fact holds within the radio's rounding (a tenth for time, a metre or a
 *     km/h for the rest), or a bare number that is neither.
 *
 * `facts` are the request's (the numbers the reply may use); the debrief's
 * own gains and losses count as facts too.
 */
export function debriefGuard(text: string, debrief: LiveRunDebrief | null, facts: readonly CoachFact[] = []): string[] {
  const reasons: string[] = [];
  const s = String(text || '').trim();
  if (!s || !debrief) return ['empty'];
  const sentences = s.split(/(?<=[.!?])\s+/).filter((x) => /[a-z0-9]/i.test(x));
  if (!sentences.length || sentences.length > DEBRIEF_SENTENCES) reasons.push(`${sentences.length} sentences`);
  if (/\b[ct]\d{1,3}\b/i.test(s)) reasons.push('a raw corner id');
  if (/km\/h|[%Δ/\\]/.test(s)) reasons.push('a symbol');

  const allowed = new Set<number>();
  for (const x of [...(debrief.improved || []), ...(debrief.still || [])]) {
    const n = x && cornerNoOf(x.cornerId);
    if (n !== null && n !== undefined) allowed.add(n);
  }
  const pool: Record<SaidUnit, number[]> = { s: [], m: [], kph: [], laps: [] };
  const put = (unit: string | undefined, v: number): void => {
    if (!finite(v)) return;
    const u: SaidUnit | null = unit === 's' ? 's' : unit === 'm' ? 'm' : unit === 'kph' ? 'kph' : unit === 'laps' ? 'laps' : null;
    if (u) pool[u].push(Math.abs(v));
  };
  for (const f of facts) if (f) put(f.unit, f.value);
  for (const x of debrief.improved || []) if (x) put('s', x.gainSec);
  for (const x of debrief.still || []) if (x) put('s', x.lossSec);
  if ((debrief.improved || []).length >= 2) put('s', debrief.improved.reduce((a, x) => a + (finite(x.gainSec) ? x.gainSec : 0), 0));
  if (finite(debrief.laps)) put('laps', debrief.laps);
  const holds = (unit: SaidUnit, v: number): boolean => pool[unit].some((x) => Math.abs(x - v) <= SAID_TOLERANCE[unit]);

  const tok = s.toLowerCase().replace(/['’]/g, '').match(/\d+(?:\.\d+)?|[a-z]+|,/g) || [];
  for (let i = 0; i < tok.length; ) {
    const w = tok[i]!;
    // -- corners, also listed: "corners three, seven and nine" -----------------
    if (w === 'corner' || w === 'corners' || w === 'turn' || w === 'turns') {
      let j = i + 1;
      if (tok[j] === 'number') j += 1;
      // Only "corners" lists: "corner five, two times" is one corner and a figure.
      const plural = w === 'corners' || w === 'turns';
      let first = true;
      for (;;) {
        let k = j;
        if (!first && plural && (tok[k] === ',' || tok[k] === 'and')) {
          k += 1;
          if (tok[k] === 'and') k += 1;
        } else if (!first) break;
        const q = quantityAt(tok, k);
        // A number with a unit after it is a figure ("corner five, ten metres"), not a corner.
        if (!q || unitAt(tok, k + q.len)) break;
        if (w === 'turn' || w === 'turns') reasons.push(`says "turn ${q.n}"`);
        else if (!allowed.has(q.n)) reasons.push(`names corner ${q.n}, which the debrief does not`);
        j = k + q.len;
        first = false;
      }
      i = Math.max(j, i + 1);
      continue;
    }
    // -- "a tenth", "half a second", "less than a tenth" -----------------------
    if (w === 'less' && tok[i + 1] === 'than' && tok[i + 2] === 'a' && tok[i + 3] === 'tenth') {
      if (!pool.s.some((x) => x < 0.05 + 1e-6)) reasons.push('says "less than a tenth", which no fact is');
      i += 4;
      continue;
    }
    if (w === 'a' && (tok[i + 1] === 'tenth' || tok[i + 1] === 'hundredth')) {
      let v = tok[i + 1] === 'tenth' ? 0.1 : 0.01;
      let len = 2;
      if (tok[i + 2] === 'and' && tok[i + 3] === 'a' && tok[i + 4] === 'half') {
        v *= 1.5;
        len = 5;
      }
      if (!holds('s', v)) reasons.push(`says ${v} s, which no fact holds`);
      i += len;
      continue;
    }
    if (w === 'half' && tok[i + 1] === 'a' && tok[i + 2] === 'second') {
      if (!holds('s', 0.5)) reasons.push('says half a second, which no fact holds');
      i += 3;
      continue;
    }
    // -- a figure -------------------------------------------------------------
    const q = quantityAt(tok, i);
    if (q) {
      const u = unitAt(tok, i + q.len);
      if (u) {
        let v = q.n * u.scale;
        let len = q.len + u.len;
        if (u.unit === 's' && u.scale === 0.1 && tok[i + len] === 'and' && tok[i + len + 1] === 'a' && tok[i + len + 2] === 'half') {
          v += 0.05;
          len += 3;
        }
        if (!holds(u.unit, v)) reasons.push(`says ${Math.round(v * 100) / 100} ${u.unit}, which no fact holds`);
        i += len;
        continue;
      }
      // "the one that matters" is a pronoun, as the function's own check has it.
      if (!(q.n === 1 && /^[a-z]/.test(w))) reasons.push(`a bare number (${w})`);
      i += q.len;
      continue;
    }
    i += 1;
  }
  return [...new Set(reasons)];
}

/* ---- the reply → words ------------------------------------------------------ */

/**
 * The model's words made speakable for the debrief: corner lists said
 * ("C3, C7 and C9" → "corners three, seven and nine"), figures in words
 * ("10 m" → "ten metres", "0.2 s" → "two tenths"), symbols out. Null when a
 * digit is left that is no figure we can say. Whether a figure is TRUE is
 * {@link debriefGuard}'s to judge, on the whole text.
 */
function speakDebriefWords(s: string): string | null {
  let out = String(s)
    .replace(/\bC(\d{1,3})((?:\s*,\s*C\d{1,3})*)(?:,?\s+and\s+C(\d{1,3}))?\b/g, (_m, a: string, mid: string, z: string | undefined) => {
      const nums = [a, ...((mid || '').match(/\d+/g) || []), ...(z ? [z] : [])].map(Number);
      return spokenCorners(nums);
    })
    .replace(/(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/g, (_m, v: string) => speakableTenths(Number(v)))
    .replace(/(\d+)\s*(?:km\/h|kph)/g, (_m, v: string) => kph(Number(v)))
    .replace(/(\d+)\s*(?:m|metres?|meters?)\b/g, (_m, v: string) => metres(Number(v)))
    .replace(/[“”"()[\]{}*_#]/g, '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s*;\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\d/.test(out)) return null;
  out = out.replace(/,\s*,/g, ',').replace(/,\s*$/, '');
  return out || null;
}

/**
 * The AI's debrief → at most three speakable sentences, or null (the service
 * then says the engine's template). `reply` is the CoachAiResult or the whole
 * `{ ok, ai }` answer; `request` the one sent (rebuilt from the debrief and
 * snapshot when absent — the same facts).
 *
 * Strict, where the summary is lenient: one takeaway that cites a fact the
 * request did not hold, or names a corner the debrief does not, and the whole
 * reply is refused rather than trimmed — a debrief that leaves out the corner
 * it got wrong reads as a complete one. What improved is said first, then
 * what is still to work on. The words for WHAT are the model's; the figures
 * are the facts' ("about four tenths in all", "worth about two tenths a
 * lap"); then the finished text must pass {@link debriefGuard}.
 */
export function speakableDebrief(
  reply: unknown,
  debrief: LiveRunDebrief | null,
  snap: LiveCoachSnapshot | null,
  request?: CoachAiRequest | null,
): string | null {
  if (!debrief) return null;
  let ai: unknown = reply;
  if (isObj(ai) && 'ai' in ai) {
    if (ai.ok === false) return null;
    ai = ai.ai;
  }
  if (!isObj(ai) || !Array.isArray(ai.takeaways) || !ai.takeaways.length) return null;
  const req = request && Array.isArray(request.facts) ? request : debriefRequest(debrief, snap);
  const facts = req ? req.facts : [];
  if (!facts.length) return null;
  const byId = new Map(facts.map((f) => [f.id, f]));
  const improvedIds = new Set((debrief.improved || []).map((x) => String(x.cornerId).toUpperCase()));
  const stillIds = new Set((debrief.still || []).map((x) => String(x.cornerId).toUpperCase()));
  const factOf = (id: string): CoachFact | undefined => byId.get(id);

  const improvedLines: string[] = [];
  const stillLines: string[] = [];
  for (const t of ai.takeaways) {
    if (!isObj(t) || typeof t.title !== 'string' || typeof t.body !== 'string') return null;
    const ids = Array.isArray(t.factIds) ? t.factIds.filter((x): x is string => typeof x === 'string') : [];
    if (!ids.length || ids.some((id) => !byId.has(id))) return null;
    const cited = ids.map((id) => byId.get(id)!);
    const named = new Set<string>([
      ...(`${t.title} ${t.body}`.match(/\bC\d{1,3}\b/gi) || []).map((c) => c.toUpperCase()),
      ...(Array.isArray(t.cornerIds) ? t.cornerIds.filter((x): x is string => typeof x === 'string').map((c) => c.trim().toUpperCase()) : []),
      ...cited.map((f) => String(f.cornerId || '').toUpperCase()).filter(Boolean),
    ]);
    if ([...named].some((c) => !improvedIds.has(c) && !stillIds.has(c))) return null;
    const corners = [...named];
    const isImproved = cited.some((f) => f.kind === 'gain') || (corners.length > 0 && corners.every((c) => improvedIds.has(c)));

    let words = firstSentence(t.body);
    if (!words || wordCount(words) > DEBRIEF_SENTENCE_WORDS) words = firstSentence(t.title);
    const said = speakDebriefWords(words);
    if (!said) return null;
    // The figure, from the facts — unless the words already carry one (then the guard checks it).
    let tail = '';
    const hasFigure = /\b(tenths?|seconds?|metres?|kilometres)\b/i.test(said);
    if (!hasFigure && isImproved) {
      const mine = corners.filter((c) => improvedIds.has(c));
      // run.gain only for all of them (or when cited); else the named corners' own.
      const all = mine.length === improvedIds.size;
      const total = factOf('run.gain') && (ids.includes('run.gain') || (all && mine.length >= 2))
        ? factOf('run.gain')!.value
        : mine.reduce((a, c) => a + (factOf(`${c}.gain`)?.value || 0), 0);
      if (total >= SAY_LOSS_SEC) tail = `, about ${speakableTenths(total)}${mine.length >= 2 || ids.includes('run.gain') ? ' in all' : ' back'}`;
    } else if (!hasFigure) {
      const mine = corners.filter((c) => stillIds.has(c));
      const total = mine.reduce((a, c) => a + (factOf(`${c}.loss`)?.value || 0), 0);
      if (total >= SAY_LOSS_SEC) tail = `, worth about ${speakableTenths(total)} a lap${mine.length >= 2 ? ' between them' : ''}`;
    }
    (isImproved ? improvedLines : stillLines).push(`${cap(said)}${tail}.`);
  }
  // The function allows three takeaways at most, so this is three sentences
  // at most; the guard holds the line whatever produced the reply.
  const text = [...improvedLines, ...stillLines].join(' ');
  if (!text || wordCount(text) > DEBRIEF_TOTAL_WORDS) return null;
  return debriefGuard(text, debrief, facts).length ? null : text;
}

/** The contract's object, for callers that take a {@link LiveCoachVoice}. */
export const liveCoachVoice: LiveCoachVoice = {
  answerCoachQuestion,
  summaryFacts,
  speakableSummary: (reply, snap) => speakableSummary(reply, snap),
  debriefRequest: (debrief, snap, ctx) => debriefRequest(debrief, snap, (ctx || {}) as LiveCoachSummaryContext),
  speakableDebrief: (reply, debrief, snap) => speakableDebrief(reply, debrief, snap),
};
