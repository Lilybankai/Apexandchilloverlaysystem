/**
 * liveCoach.ts — the live practice coach's engine: one lap in, one line out.
 * =============================================================================
 *
 * 2026-11-03, Carl: the Practice tab's coach while the driver is still
 * driving. After every timed lap of a practice (or test-day) session the
 * engineer may say ONE short line about the corner that costs the most,
 * consistently, and the in-game Focus card shows that corner and what to
 * change. The shapes are pinned in `liveCoachContract.ts`; this module is the
 * {@link LiveCoachEngine} half of it:
 *
 *   initLiveCoach(sessionKey) → LiveCoachState
 *   stepLiveCoach(state, lap, opts?) → { state, calls, focus, wantSummary }
 *
 * Pure and deterministic like its neighbours: no fs, no clock, no Electron.
 * The state is plain JSON and is never mutated — the step returns a new one —
 * so the service may keep it across a loading screen and a test can replay a
 * session lap by lap to the same transcript.
 *
 * ## Which laps count
 * A lap is COUNTED (it moves the window, the counters and may produce calls)
 * only when it is `valid` (no out-lap, in-lap, off, track-limits flag, and it
 * has a trace), it has a `breakdown`, and its time is not an outlier against
 * the session's recent valid laps ({@link lapOutlier}: coachReport.ts
 * `inliers`' median + MADs rule, with a floor sized for a whole lap). A lap
 * that is skipped says nothing and changes nothing but the outlier history.
 *
 * ## The driver's loss
 * Per corner, `lossSec` minus the flagged straight time (`straightFlag` tow /
 * car), exactly coachReport.ts `driverLoss`; the flagged time comes off the
 * exit-run phase too. Time lost to a tow or a faster car is never coached.
 *
 * ## The focus — ONE thing at a time
 * Over the last `windowLaps` counted laps: the corner with the highest mean
 * driver loss that lost (> {@link LOST_SEC}) on at least two of them, averages
 * at least `minFocusLossSec`, is not already fixed this session, and is not
 * ALREADY under threshold on the last two laps (a corner the driver has just
 * sorted out is not news). Nothing is picked before `minLaps` counted laps —
 * one lap when the reference is a leaderboard or chased lap, because then
 * there is something to coach against from the start (the two-laps rule
 * still applies once there are two).
 *
 * Once picked, a focus is kept until it is fixed — never swapped because
 * another corner had one bad lap:
 *
 *   - `new`        the lap it was picked on;
 *   - `improving`  the latest lap lost ≥ 40 % or ≥ 0.05 s less there than the
 *                  focus's starting mean;
 *   - `holding`    otherwise;
 *   - `fixed`      the two counted laps since the pick are both under
 *                  `minFocusLossSec`. It goes into `state.fixed`; the card
 *                  shows it ticked for one lap; the NEXT counted lap picks the
 *                  next focus ("Next one's corner nine").
 *
 * A focus held {@link NAG_LAPS} counted laps without a step forward (a new
 * best gain there: sitting on the same "better" lap after lap is a plateau,
 * and a focus picked off two slow first laps would otherwise be "improving"
 * all session) is parked (not picked again for that many laps) and swapped
 * for the next corner, so the driver is not nagged about one corner forever:
 * "Let's leave corner four for now." If there is no other corner worth it,
 * the focus stays.
 *
 * ## The cue — ONE measurable thing to change
 * The focus's dominant phase (largest mean driver loss) decides it, measured
 * mine vs ref from the breakdown's PhasePoints, lap fractions ×
 * `trackLengthM`, as the MEDIAN over the window, and only when at least two
 * laps agree on the direction ({@link agreed}: a noisy braking point says the
 * phase, not a number):
 *
 *   braking    brakeShiftM = (ref.brakeOnD − mine.brakeOnD) × L; + = brake
 *              LATER. Rounded to 5 m, never more than {@link MAX_BRAKE_M}.
 *   midCorner  minKphGain = ref.minKph − mine.minKph, whole km/h.
 *   exit/run   an earlier pick-up, throttleShiftM = (ref.pickupD −
 *              mine.pickupD) × L (− = pick up earlier), else exitKphGain.
 *   turnIn     only when nothing else fits: the next phase with a number.
 *
 * The phase and the KIND of number are fixed at the pick, so the card never
 * flips from "Throttle 10 m sooner" to "+4 km/h on exit"; the number itself
 * is re-measured every lap over the window (so "Brake 10 m later" becomes
 * "Brake 5 m later" as the driver closes in). A number too small, missing or
 * disputed falls back to the phase alone ("you're losing it on the exit").
 *
 * ## Calls
 * At most one focus line per lap (`coachFocus` for a new focus,
 * `coachProgress` for improving / fixed, a short `coachFocus` reminder every
 * second lap while it holds), plus `coachConsistency` every
 * `consistencyEvery` counted laps, and `wantSummary` every `summaryEvery`.
 * Every line is held to engineerPhrases.ts `MAX_SPOKEN_WORDS` (14 words —
 * five seconds of radio; a variant that would overrun gives way to the next,
 * {@link fit}) and is speakable for Piper: "corner four", never
 * "C4"; "a tenth and a half", never "0.15". Phrasings vary, picked by lap
 * number so a replay is stable.
 *
 * ## A new reference
 * A new session best becoming the reference (`refLapId` changes, `refKind`
 * stays) keeps the window and the focus: the losses before it were measured
 * against a slightly slower lap, which only understates them for a lap or
 * two, and the focus is re-judged every lap anyway. A change of KIND (the
 * driver picked a leaderboard lap, or stopped chasing one) makes every loss
 * in the window incomparable: the window, the focus and the fixed list are
 * cleared quietly and the coach starts over against the new lap. Neither is
 * announced — the driver chose it, or the lap-time call already said "new
 * best".
 */

import { COACH_PHASES, type CoachPhase, type CornerPhaseLoss } from './coachContract';
import { driverLoss } from './coachReport';
import { speakableGap } from './engineerCommands';
import { MAX_SPOKEN_WORDS, spokenWordCount } from './engineerPhrases';
import type {
  LiveCoachCall,
  LiveCoachEngine,
  LiveCoachKind,
  LiveCoachLap,
  LiveCoachOptions,
  LiveCoachState,
  LiveCoachStep,
  LiveFocus,
  LiveFocusCue,
  LiveFocusStatus,
} from './liveCoachContract';

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                  */
/* -------------------------------------------------------------------------- */

export const LIVE_COACH_DEFAULTS: Readonly<Required<LiveCoachOptions>> = {
  windowLaps: 3,
  minLaps: 2,
  minFocusLossSec: 0.08,
  consistencyEvery: 5,
  summaryEvery: 5,
  maxWork: 3,
  approachCues: true,
  lapDebrief: true,
};

/** A corner "lost" on a lap when it cost more than this (coachReport.ts LEVEL_SEC). */
export const LOST_SEC = 0.02;
/** Improving: the latest lap lost this share less than the focus's starting mean… */
export const IMPROVE_SHARE = 0.4;
/** …or this many seconds less. */
export const IMPROVE_SEC = 0.05;
/** Counted laps a focus may hold without improving before it is parked and swapped. */
export const NAG_LAPS = 6;
/** Never advise moving a braking point more than this in one go (m). */
export const MAX_BRAKE_M = 25;
/** Below these the number is not worth saying: the phase alone is. */
export const MIN_SHIFT_M = 5;
export const MIN_KPH = 1;
/** "Last five within …" is said as tidy at or under this spread (s). */
export const TIDY_SPREAD_SEC = 0.5;
/** A corner is named as the one that varies when its loss's stdev is at least this (s). */
export const VARIES_SEC = 0.05;
/** The `card` string's limit (the Focus card). */
export const SHORT_MAX = 28;

/**
 * A whole lap's outlier rule. coachReport.ts `inliers` judges one corner's
 * samples with a 0.5 s floor; a lap is a dozen corners, and a lap half a
 * second off the median is an ordinary practice lap worth coaching. So the
 * same median + {@link LAP_OUTLIER_MADS} MADs cap, over the last
 * {@link LAP_HISTORY} valid laps, with a floor of 1.5 s or 2 % of the lap.
 * Below four laps there is no median worth the name, and only a gross lap
 * (more than 5 s or 5 % slower than the best so far: a spin, a trip through
 * the gravel the sim did not flag) is left out.
 */
const LAP_OUTLIER_MADS = 5;
const LAP_OUTLIER_FLOOR_SEC = 1.5;
const LAP_OUTLIER_FLOOR_SHARE = 0.02;
const LAP_GROSS_SEC = 5;
const LAP_GROSS_SHARE = 0.05;
const LAP_HISTORY = 12;

/** Radio priorities: below practiceLap (19), progress above the focus line. */
const PRIORITY: Record<LiveCoachKind, number> = {
  coachProgress: 18,
  coachFocus: 17,
  coachConsistency: 16,
  coachSummary: 15,
  // v2 placeholders (coach2-base): the engine builder sets the real order.
  coachApproach: 19,
  coachLapDebrief: 16,
  coachRunDebrief: 18,
};

/* -------------------------------------------------------------------------- */
/*  State extras (optional fields beyond the contract; plain JSON)            */
/* -------------------------------------------------------------------------- */

/** One counted lap's corner, as much as the cue needs. */
interface CornerDetail {
  /** Driver-attributable loss per phase (flagged straight time out of exitRun). */
  ph: Record<CoachPhase, number>;
  /** (ref − mine) brake onset, metres: + = brake later. */
  brakeM: number | null;
  /** ref − mine minimum speed, km/h: + = carry more. */
  minKph: number | null;
  /** ref − mine exit speed, km/h: + = more exit speed. */
  exitKph: number | null;
  /** (ref − mine) pick-up, metres: − = pick up earlier. */
  pickupM: number | null;
  entryD: number;
  apexD: number;
  exitD: number;
}

interface RecentLap {
  lapNo: number;
  lapSec: number;
  byCorner: Record<string, number>;
  detail?: Record<string, CornerDetail>;
}

/** What the engine remembers about the current focus. */
interface FocusMeta {
  /** Counted-lap number (`validLaps`) it was picked on. */
  pickedAt: number;
  /** Its window mean then (s). */
  startSec: number;
  /** Counted-lap number of the last improving lap (else pickedAt). */
  improvedAt: number;
  /** Counted-lap number of the last focus line said about it. */
  saidAt: number;
  /** The biggest gain already announced (s), so "better" is said once per step forward. */
  saidGain: number;
  /** The cue as first picked: its phase and its kind of number stay for the life of the focus. */
  cue?: LiveFocusCue;
}

interface EngineState extends LiveCoachState {
  /** Up to max(windowLaps, consistencyEvery) counted laps, newest last (the consistency call's laps). */
  history?: RecentLap[];
  /** Recent valid lap times, counted or not, for the outlier rule. */
  lapSecs?: number[];
  focusMeta?: FocusMeta | null;
  /** Corners swapped out for nagging, and the counted lap they may come back on. */
  parked?: { id: string; until: number }[];
  refKind?: LiveCoachLap['refKind'] | null;
  /** The last few lap ids stepped, so a repeated lap is ignored. */
  seen?: string[];
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mean = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function stdev(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

function pick(variant: number, bank: readonly string[]): string {
  return bank[Math.abs(Math.trunc(variant)) % bank.length]!;
}

function opt(o: LiveCoachOptions | undefined): Required<LiveCoachOptions> {
  const d = LIVE_COACH_DEFAULTS;
  const n = (v: unknown, fb: number, min: number): number => (finite(v) && v >= min ? v : fb);
  return {
    windowLaps: Math.max(2, Math.round(n(o?.windowLaps, d.windowLaps, 2))),
    minLaps: Math.round(n(o?.minLaps, d.minLaps, 1)),
    minFocusLossSec: n(o?.minFocusLossSec, d.minFocusLossSec, 0),
    consistencyEvery: Math.round(n(o?.consistencyEvery, d.consistencyEvery, 0)),
    summaryEvery: Math.round(n(o?.summaryEvery, d.summaryEvery, 0)),
    maxWork: Math.max(1, Math.min(5, Math.round(n(o?.maxWork, d.maxWork, 1)))),
    approachCues: typeof o?.approachCues === 'boolean' ? o.approachCues : d.approachCues,
    lapDebrief: typeof o?.lapDebrief === 'boolean' ? o.lapDebrief : d.lapDebrief,
  };
}

/** 'C4' → 4; anything else → null. */
export function cornerNoOf(id: string): number | null {
  const m = /^C(\d+)$/i.exec(String(id || ''));
  return m ? Number(m[1]) : null;
}

/* -------------------------------------------------------------------------- */
/*  Words for Piper                                                           */
/* -------------------------------------------------------------------------- */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 4 → "four", 23 → "twenty-three"; 100 and up stay digits. */
export function numberWords(n: number): string {
  const v = Math.round(Math.abs(n));
  if (v < 20) return ONES[v]!;
  if (v < 100) return v % 10 ? `${TENS[Math.floor(v / 10)]}-${ONES[v % 10]}` : TENS[Math.floor(v / 10)]!;
  return String(v);
}

/** 'C4' → "corner four"; an id without a number is said as it is. */
export function speakableCorner(id: string): string {
  const no = cornerNoOf(id);
  return no !== null ? `corner ${numberWords(no)}` : String(id || 'that corner');
}

const cap1 = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Time as an engineer says it on the radio, extending sessionPhrases.ts
 * `speakableTenths` with the halves: "a tenth", "a tenth and a half", "two
 * tenths", "half a second", "a second"; over that, speakableGap ("1.4
 * seconds").
 */
export function speakableCoachTime(sec: number): string {
  const abs = Math.abs(sec);
  if (!finite(abs) || abs < 0.05) return 'less than a tenth';
  if (abs < 0.125) return 'a tenth';
  if (abs < 0.2) return 'a tenth and a half';
  if (abs >= 0.45 && abs < 0.55) return 'half a second';
  if (abs < 0.95) return `${numberWords(Math.round(abs * 10))} tenths`;
  if (abs < 1.05) return 'a second';
  return speakableGap(abs);
}

/** A spread said as "within": rounded UP to the tenth ("within three tenths"). */
function withinWords(sec: number): string {
  const t = Math.max(1, Math.ceil(sec * 10 - 1e-9));
  if (t === 1) return 'a tenth';
  if (t === 5) return 'half a second';
  if (t < 10) return `${numberWords(t)} tenths`;
  return 'a second';
}

/** A loose spread: "over a second", "over two seconds", "about seven tenths". */
function spreadWords(sec: number): string {
  if (sec < 0.95) return `about ${speakableCoachTime(sec)}`;
  const s = Math.floor(sec + 0.05);
  return s <= 1 ? 'over a second' : `over ${numberWords(s)} seconds`;
}

const metres = (m: number): string => `${numberWords(Math.abs(m))} metres`;
/** "four kph": what an engineer says, and two words where "kilometres an hour" is four. */
const kph = (k: number): string => `${numberWords(Math.abs(k))} kph`;

/* -------------------------------------------------------------------------- */
/*  One lap's corners                                                         */
/* -------------------------------------------------------------------------- */

function detailOf(c: CornerPhaseLoss, L: number): CornerDetail {
  const straight = c.straightFlag && finite(c.straightSec) && c.straightSec > 0 ? c.straightSec : 0;
  const ph = {} as Record<CoachPhase, number>;
  for (const p of COACH_PHASES) ph[p] = finite(c.phases?.[p]) ? c.phases[p] : 0;
  ph.exitRun -= straight;
  const m = c.mine || ({} as CornerPhaseLoss['mine']);
  const f = c.ref || ({} as CornerPhaseLoss['ref']);
  const diff = (a: number | null | undefined, b: number | null | undefined): number | null =>
    finite(a) && finite(b) ? a - b : null;
  const brake = diff(f.brakeOnD, m.brakeOnD);
  const pickup = diff(f.pickupD, m.pickupD);
  return {
    ph,
    brakeM: brake === null || !(L > 0) ? null : r3(brake * L),
    minKph: diff(f.minKph, m.minKph),
    exitKph: diff(f.exitKph, m.exitKph),
    pickupM: pickup === null || !(L > 0) ? null : r3(pickup * L),
    entryD: c.entryD,
    apexD: c.apexD,
    exitD: c.exitD,
  };
}

function recentOf(lap: LiveCoachLap): RecentLap {
  const byCorner: Record<string, number> = {};
  const detail: Record<string, CornerDetail> = {};
  const L = finite(lap.trackLengthM) ? lap.trackLengthM : 0;
  for (const c of lap.breakdown?.corners || []) {
    if (!c || !c.id || !finite(c.lossSec)) continue;
    byCorner[c.id] = r3(driverLoss(c));
    detail[c.id] = detailOf(c, L);
  }
  return { lapNo: lap.lapNo, lapSec: lap.lapSec, byCorner, detail };
}

/**
 * True when a lap's time is an outlier against the session's recent valid
 * laps (see {@link LAP_OUTLIER_MADS}). `prior` excludes the lap itself.
 */
export function lapOutlier(lapSec: number, prior: readonly number[]): boolean {
  if (!finite(lapSec) || lapSec <= 0) return true;
  const xs = prior.filter((v) => finite(v) && v > 0).slice(-LAP_HISTORY);
  if (xs.length) {
    const best = Math.min(...xs);
    if (lapSec > best + Math.max(LAP_GROSS_SEC, LAP_GROSS_SHARE * best)) return true;
  }
  const all = [...xs, lapSec];
  if (all.length < 4) return false;
  const med = median(all);
  const mad = median(all.map((v) => Math.abs(v - med)));
  const cap = med + Math.max(LAP_OUTLIER_FLOOR_SEC, LAP_OUTLIER_FLOOR_SHARE * med, LAP_OUTLIER_MADS * mad);
  return lapSec > cap;
}

/* -------------------------------------------------------------------------- */
/*  Judging corners over the window                                           */
/* -------------------------------------------------------------------------- */

interface CornerJudge {
  id: string;
  mean: number;
  /** Laps it was scored on, and lost on. */
  laps: number;
  lost: number;
  /** Last two laps' losses, oldest first (missing = null). */
  last2: (number | null)[];
}

function judge(recent: readonly RecentLap[], id: string): CornerJudge {
  const vals = recent.map((r) => (finite(r.byCorner[id]) ? r.byCorner[id]! : null));
  const got = vals.filter(finite);
  return {
    id,
    mean: mean(got) ?? 0,
    laps: got.length,
    lost: got.filter((v) => v > LOST_SEC).length,
    last2: vals.slice(-2),
  };
}

function underFor2(j: CornerJudge, minSec: number): boolean {
  return j.last2.length === 2 && j.last2.every((v) => finite(v) && v < minSec);
}

/** The corner to work on, or null. */
function pickFocus(
  recent: readonly RecentLap[],
  o: Required<LiveCoachOptions>,
  exclude: ReadonlySet<string>,
): CornerJudge | null {
  const ids = new Set<string>();
  for (const r of recent) for (const id of Object.keys(r.byCorner)) ids.add(id);
  const needLost = Math.min(2, recent.length);
  let best: CornerJudge | null = null;
  for (const id of ids) {
    if (exclude.has(id)) continue;
    const j = judge(recent, id);
    if (j.lost < needLost || j.mean < o.minFocusLossSec) continue;
    if (underFor2(j, o.minFocusLossSec)) continue; // already sorted on the last two laps
    if (!best || j.mean > best.mean || (j.mean === best.mean && id < best.id)) best = j;
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/*  The cue                                                                   */
/* -------------------------------------------------------------------------- */

interface CueWords {
  cue: LiveFocusCue;
  short: string;
  /** "braking about ten metres early" — what is happening. */
  what: string;
  /** "brake ten metres later" — what to do. */
  todo: string;
}

function windowDetails(recent: readonly RecentLap[], id: string): CornerDetail[] {
  return recent.map((r) => r.detail?.[id]).filter((d): d is CornerDetail => !!d);
}

/** The phase most of a corner's driver loss sits in, over the window. */
function dominantPhase(ds: readonly CornerDetail[]): CoachPhase {
  let best: CoachPhase = 'braking';
  let bestV = -Infinity;
  for (const p of COACH_PHASES) {
    const v = mean(ds.map((d) => d.ph[p])) ?? 0;
    if (v > bestV) {
      best = p;
      bestV = v;
    }
  }
  return best;
}

/** Every phase but turn-in, by mean loss, largest first; never one the driver GAINS in. */
function otherPhasesByLoss(ds: readonly CornerDetail[]): CoachPhase[] {
  return COACH_PHASES.filter((p) => p !== 'turnIn')
    .map((p) => ({ p, v: mean(ds.map((d) => d.ph[p])) ?? 0 }))
    .filter((x) => x.v >= 0)
    .sort((a, b) => b.v - a.v)
    .map((x) => x.p);
}

/**
 * One measured number over the window, or null when the laps disagree. The
 * MEDIAN, not the mean: three laps is a small sample, and one lap with a
 * moment (37 km/h down in Road Atlanta's C3, 2026-10-08) must not make the
 * advice. And at least two laps must agree on the direction, each by at least
 * `min` (so ±5 m of noise round a matched braking point never flips "later"
 * to "earlier" lap to lap): a braking point that was 64 m early, 15 m late and 81 m
 * early on three laps (Road Atlanta C2, a light dab of brake) is noise, and
 * the honest words are the phase's, not a number.
 */
function agreed(ds: readonly CornerDetail[], k: 'brakeM' | 'minKph' | 'exitKph' | 'pickupM', min: number): number | null {
  const xs = ds.map((d) => d[k]).filter(finite);
  if (!xs.length) return null;
  const m = median(xs);
  if (xs.length >= 2) {
    const agree = xs.filter((x) => Math.sign(x) === Math.sign(m) && Math.abs(x) >= min).length;
    if (agree < 2) return null;
  }
  return m;
}

const round5 = (m: number): number => Math.round(m / 5) * 5;

/** Which number a cue is about, so a focus keeps talking about the same thing. */
type CueKind = 'brake' | 'minKph' | 'throttle' | 'exitKph';

function kindOf(c: LiveFocusCue): CueKind | null {
  if (c.brakeShiftM !== undefined) return 'brake';
  if (c.minKphGain !== undefined) return 'minKph';
  if (c.throttleShiftM !== undefined) return 'throttle';
  if (c.exitKphGain !== undefined) return 'exitKph';
  return null;
}

function brakeCue(phase: CoachPhase, ds: readonly CornerDetail[]): CueWords | null {
  const b = agreed(ds, 'brakeM', MIN_SHIFT_M);
  if (b === null) return null;
  const m = Math.max(-MAX_BRAKE_M, Math.min(MAX_BRAKE_M, round5(b)));
  if (Math.abs(m) < MIN_SHIFT_M) return null;
  // Capped: "over twenty-five metres", never a false "about".
  const amount = Math.abs(round5(b)) > MAX_BRAKE_M ? `over ${metres(m)}` : `about ${metres(m)}`;
  return m > 0
    ? { cue: { phase, brakeShiftM: m }, short: `Brake ${m} m later`, what: `braking ${amount} early`, todo: `brake ${metres(m)} later` }
    : { cue: { phase, brakeShiftM: m }, short: `Brake ${-m} m earlier`, what: `braking ${amount} too late`, todo: `brake ${metres(m)} earlier` };
}

function minKphCue(phase: CoachPhase, ds: readonly CornerDetail[]): CueWords | null {
  const k = agreed(ds, 'minKph', MIN_KPH);
  if (k === null) return null;
  const g = Math.round(k);
  if (g < MIN_KPH) return null;
  return { cue: { phase, minKphGain: g }, short: `+${g} km/h mid-corner`, what: `${kph(g)} down mid-corner`, todo: `carry ${kph(g)} more mid-corner` };
}

function throttleCue(phase: CoachPhase, ds: readonly CornerDetail[]): CueWords | null {
  const p = agreed(ds, 'pickupM', MIN_SHIFT_M);
  if (p === null) return null;
  const m = Math.max(-MAX_BRAKE_M, round5(p));
  if (m > -MIN_SHIFT_M) return null; // full throttle later is never advised
  const amount = Math.abs(round5(p)) > MAX_BRAKE_M ? `over ${metres(m)}` : metres(m);
  return { cue: { phase, throttleShiftM: m }, short: `Throttle ${-m} m sooner`, what: `on the throttle ${amount} late`, todo: `throttle ${metres(m)} sooner` };
}

function exitKphCue(phase: CoachPhase, ds: readonly CornerDetail[]): CueWords | null {
  const e = agreed(ds, 'exitKph', MIN_KPH);
  if (e === null) return null;
  const g = Math.round(e);
  if (g < MIN_KPH) return null;
  return { cue: { phase, exitKphGain: g }, short: `+${g} km/h on exit`, what: `${kph(g)} down on the exit`, todo: `${kph(g)} more on the exit` };
}

const CUE_OF: Record<CueKind, (phase: CoachPhase, ds: readonly CornerDetail[]) => CueWords | null> = {
  brake: brakeCue,
  minKph: minKphCue,
  throttle: throttleCue,
  exitKph: exitKphCue,
};

/** The measurable cue for one phase, or null when its number is too small, missing or disputed. */
function measuredCue(phase: CoachPhase, ds: readonly CornerDetail[]): CueWords | null {
  if (phase === 'braking') return brakeCue(phase, ds);
  if (phase === 'midCorner') return minKphCue(phase, ds);
  if (phase === 'exit' || phase === 'exitRun') return throttleCue(phase, ds) || exitKphCue(phase, ds);
  return null; // turn-in has no single number
}

const PHASE_ONLY: Record<CoachPhase, { short: string; what: string; todo: string }> = {
  braking: { short: 'Time under braking', what: 'losing it under braking', todo: 'tidy up the braking' },
  turnIn: { short: 'Smoother turn-in', what: 'losing it on turn-in', todo: 'smoother on turn-in' },
  midCorner: { short: 'More speed mid-corner', what: 'losing it mid-corner', todo: 'more speed mid-corner' },
  exit: { short: 'Better exit', what: 'losing it on the exit', todo: 'a cleaner exit' },
  exitRun: { short: 'Drive out harder', what: 'losing it on the run out', todo: 'drive out harder' },
};

function phaseOnly(ph: CoachPhase): CueWords {
  const w = PHASE_ONLY[ph];
  return { cue: { phase: ph }, short: w.short, what: w.what, todo: w.todo };
}

/**
 * The cue for a corner over the window. A NEW focus: the dominant phase's
 * number; turn-in only when no other phase the driver is not gaining in has
 * one. A focus already held (`pinned`, its cue at the pick) keeps its phase
 * and the same kind of number, re-measured ("Throttle 10 m sooner" becomes
 * "Throttle 5 m sooner", never "+4 km/h on exit" the lap after), and falls
 * back to the phase's words when the number has gone.
 */
function cueFor(recent: readonly RecentLap[], id: string, pinned?: LiveFocusCue): CueWords {
  const ds = windowDetails(recent, id);
  if (pinned) {
    const k = kindOf(pinned);
    return (k && CUE_OF[k](pinned.phase, ds)) || phaseOnly(pinned.phase);
  }
  const ph = dominantPhase(ds);
  const got = measuredCue(ph, ds);
  if (got) return got;
  if (ph === 'turnIn') {
    for (const p of otherPhasesByLoss(ds)) {
      const alt = measuredCue(p, ds);
      if (alt) return alt;
    }
  }
  return phaseOnly(ph);
}

/* -------------------------------------------------------------------------- */
/*  The lines                                                                 */
/* -------------------------------------------------------------------------- */

function call(kind: LiveCoachKind, text: string): LiveCoachCall {
  return { kind, text, priority: PRIORITY[kind] };
}

/**
 * The first of the bank, from the lap's variant on, that fits
 * {@link MAX_SPOKEN_WORDS}; the shortest when none does. A long corner number
 * ("corner twenty-three") and a long cue together can overrun the variant the
 * lap number picked: the next one is said instead, never a clipped line.
 */
function fit(variant: number, bank: readonly string[]): string {
  const k = Math.abs(Math.trunc(variant)) % bank.length;
  for (let i = 0; i < bank.length; i += 1) {
    const t = bank[(k + i) % bank.length]!;
    if (spokenWordCount(t) <= MAX_SPOKEN_WORDS) return t;
  }
  return [...bank].sort((x, y) => spokenWordCount(x) - spokenWordCount(y))[0]!;
}

function focusLine(corner: string, cw: CueWords, lossSec: number, v: number, lead: 'first' | 'next' | 'swap', from?: string): string {
  const C = cap1(corner);
  const worth = speakableCoachTime(lossSec);
  if (lead === 'swap' && from) {
    return fit(v, [
      `Let's leave ${from} for now. ${C}, ${cw.todo}.`,
      `Leave ${from} for now. Try ${corner}: ${cw.todo}.`,
      `Let's leave ${from} for now. Try ${corner}.`,
    ]);
  }
  if (lead === 'next') {
    return fit(v, [
      `Next one's ${corner}: ${cw.what}. Worth ${worth}.`,
      `Next up, ${corner}. ${cap1(cw.todo)}, worth ${worth}.`,
      `Next one's ${corner}: ${cw.what}.`,
      `Next up, ${corner}: ${cw.todo}.`,
    ]);
  }
  return fit(v, [
    `${C}, you're ${cw.what}. Worth ${worth}.`,
    `${C}'s costing ${worth}. ${cap1(cw.todo)}.`,
    `Biggest loss is ${corner}: ${cw.todo}.`,
    `${C} is where it's going: ${cw.what}.`,
    `${C}: ${cw.todo}.`,
  ]);
}

function reminderLine(corner: string, cw: CueWords, improving: boolean, v: number): string {
  const C = cap1(corner);
  if (improving) {
    // Better than at the pick, still not there: the next bit of the same cue.
    return fit(v, [`${C}'s better. Now ${cw.todo}.`, `Good through ${corner}, still ${cw.todo}.`, `${C}'s coming, keep at it.`]);
  }
  return fit(v, [`${C} again, ${cw.todo}.`, `Still ${corner}: ${cw.todo}.`, `${C}, ${cw.todo}.`]);
}

function improvingLine(corner: string, gainSec: number, v: number): string {
  const C = cap1(corner);
  if (gainSec < 0.05) return pick(v, [`Better into ${corner}, keep that going.`, `${C}'s getting better.`]);
  const g = speakableCoachTime(gainSec);
  return pick(v, [
    `Better into ${corner}, that's ${g} back.`,
    `${C}'s coming, ${g} found.`,
    `That's better through ${corner}, ${g} back.`,
  ]);
}

function fixedLine(corner: string, v: number): string {
  const C = cap1(corner);
  return pick(v, [`${C}'s sorted.`, `That's ${corner} done, nice work.`, `${C}'s sorted, good job.`]);
}

function consistencyLine(laps: readonly RecentLap[], v: number): string | null {
  const n = laps.length;
  if (n < 3) return null;
  const secs = laps.map((l) => l.lapSec).filter((s) => finite(s) && s > 0);
  if (secs.length < 3) return null;
  const spread = Math.max(...secs) - Math.min(...secs);
  const nW = numberWords(secs.length);
  if (spread <= TIDY_SPREAD_SEC) {
    const w = withinWords(spread);
    return pick(v, [
      `Last ${nW} within ${w}, nice and tidy.`,
      `${cap1(nW)} laps inside ${w}. Tidy.`,
      `Good rhythm, last ${nW} within ${w}.`,
    ]);
  }
  // The corner that varies most, by the stdev of its driver loss.
  const ids = new Set<string>();
  for (const l of laps) for (const id of Object.keys(l.byCorner)) ids.add(id);
  let worst: { id: string; sd: number } | null = null;
  for (const id of ids) {
    const xs = laps.map((l) => l.byCorner[id]).filter(finite);
    if (xs.length < 3) continue;
    const sd = stdev(xs);
    if (sd !== null && (!worst || sd > worst.sd || (sd === worst.sd && id < worst.id))) worst = { id, sd };
  }
  const s = spreadWords(spread);
  if (worst && worst.sd >= VARIES_SEC) {
    const c = speakableCorner(worst.id);
    return pick(v, [
      `Lap times spread ${s}; ${c} varies the most.`,
      `Last ${nW} spread ${s}. ${cap1(c)}'s the inconsistent one.`,
    ]);
  }
  return pick(v, [`Lap times spread ${s} over the last ${nW}.`, `Last ${nW} spread ${s}, work on the rhythm.`]);
}

/* -------------------------------------------------------------------------- */
/*  The focus object                                                          */
/* -------------------------------------------------------------------------- */

function focusOf(
  recent: readonly RecentLap[],
  id: string,
  status: LiveFocusStatus,
  sinceLapNo: number,
  pinned: LiveFocusCue | undefined,
): { focus: LiveFocus; words: CueWords } {
  const j = judge(recent, id);
  const words = cueFor(recent, id, pinned);
  let geo: CornerDetail | undefined;
  for (let i = recent.length - 1; i >= 0 && !geo; i -= 1) geo = recent[i]!.detail?.[id];
  const corner = speakableCorner(id);
  const no = cornerNoOf(id);
  return {
    focus: {
      cornerId: id,
      cornerNo: no ?? 0,
      entryD: geo ? geo.entryD : 0,
      apexD: geo ? geo.apexD : 0,
      exitD: geo ? geo.exitD : 0,
      lossSec: r3(j.mean),
      cue: words.cue,
      short: words.short.length <= SHORT_MAX ? words.short : words.short.slice(0, SHORT_MAX),
      spoken: `${cap1(corner)}, you're ${words.what}.`,
      status,
      sinceLapNo,
    },
    words,
  };
}

/* -------------------------------------------------------------------------- */
/*  The engine                                                                */
/* -------------------------------------------------------------------------- */

export function initLiveCoach(sessionKey: string): LiveCoachState {
  const s: EngineState = {
    sessionKey: String(sessionKey || ''),
    validLaps: 0,
    recent: [],
    focus: null,
    fixed: [],
    lastConsistencyAt: 0,
    lastSummaryAt: 0,
    refLapId: null,
    history: [],
    lapSecs: [],
    focusMeta: null,
    parked: [],
    refKind: null,
    seen: [],
  };
  return s;
}

function cloneState(s: LiveCoachState): EngineState {
  const c = JSON.parse(JSON.stringify(s || initLiveCoach(''))) as EngineState;
  c.recent = Array.isArray(c.recent) ? c.recent : [];
  c.fixed = Array.isArray(c.fixed) ? c.fixed : [];
  c.history = Array.isArray(c.history) ? c.history : [...c.recent];
  c.lapSecs = Array.isArray(c.lapSecs) ? c.lapSecs : c.recent.map((r) => r.lapSec);
  c.parked = Array.isArray(c.parked) ? c.parked : [];
  c.seen = Array.isArray(c.seen) ? c.seen : [];
  c.validLaps = finite(c.validLaps) ? c.validLaps : 0;
  c.lastConsistencyAt = finite(c.lastConsistencyAt) ? c.lastConsistencyAt : 0;
  c.lastSummaryAt = finite(c.lastSummaryAt) ? c.lastSummaryAt : 0;
  if (c.focus && !c.focusMeta) {
    c.focusMeta = { pickedAt: c.validLaps, startSec: c.focus.lossSec, improvedAt: c.validLaps, saidAt: c.validLaps, saidGain: 0, cue: c.focus.cue };
  }
  return c;
}

/** The step's answer; `focus` is the state's own (the service publishes it as is). */
function done(s: EngineState, calls: LiveCoachCall[], wantSummary: boolean): LiveCoachStep {
  return { state: s, calls, focus: s.focus, wantSummary };
}

export function stepLiveCoach(state: LiveCoachState, lap: LiveCoachLap, opts?: LiveCoachOptions): LiveCoachStep {
  const o = opt(opts);
  const s = cloneState(state);
  const calls: LiveCoachCall[] = [];
  if (!lap) return done(s, calls, false);

  // The same lap twice (a retry, a reload) says nothing the second time.
  if (lap.lapId && s.seen!.includes(lap.lapId)) return done(s, calls, false);
  if (lap.lapId) s.seen = [...s.seen!, lap.lapId].slice(-8);

  // A different KIND of reference: start over against it, quietly.
  const kind = lap.refKind || 'sessionBest';
  if (s.refKind && s.refKind !== kind) {
    s.recent = [];
    s.history = [];
    s.focus = null;
    s.focusMeta = null;
    s.fixed = [];
    s.parked = [];
  }
  s.refKind = kind;

  // Which laps count.
  if (!lap.valid || !lap.breakdown || !finite(lap.lapSec) || lap.lapSec <= 0) return done(s, calls, false);
  const outlier = lapOutlier(lap.lapSec, s.lapSecs!);
  s.lapSecs = [...s.lapSecs!, lap.lapSec].slice(-LAP_HISTORY);
  if (outlier) return done(s, calls, false);
  s.refLapId = lap.refLapId ?? lap.breakdown.refLapId ?? null;

  const r = recentOf(lap);
  const keep = Math.max(o.windowLaps, o.consistencyEvery, 2);
  s.history = [...s.history!, r].slice(-keep);
  s.recent = s.history.slice(-o.windowLaps);
  s.validLaps += 1;
  const n = s.validLaps;
  const v = lap.lapNo;
  s.parked = s.parked!.filter((p) => p.until > n);

  const minLaps = kind === 'sessionBest' ? o.minLaps : 1;
  const ready = n >= minLaps;

  // Last lap's fixed focus makes way now.
  let lead: 'first' | 'next' = 'first';
  if (s.focus && s.focus.status === 'fixed') {
    s.focus = null;
    s.focusMeta = null;
    lead = 'next';
  }

  if (s.focus && s.focusMeta) {
    const f = s.focus;
    const m = s.focusMeta;
    const j = judge(s.recent, f.cornerId);
    const latest = r.byCorner[f.cornerId];
    const sinceTwo = n - m.pickedAt >= 2;
    let status: LiveFocusStatus = 'holding';
    if (sinceTwo && underFor2(j, o.minFocusLossSec)) status = 'fixed';
    else if (finite(latest) && (latest <= m.startSec - IMPROVE_SEC || latest <= m.startSec * (1 - IMPROVE_SHARE))) status = 'improving';
    // Never more back than it was losing: past that it is gaining on the reference.
    const gain = finite(latest) ? Math.min(m.startSec, m.startSec - latest) : 0;
    // A step forward is a NEW best gain there. Sitting at the same "better"
    // lap after lap is a plateau, and counts towards the nag like holding:
    // a focus picked off two slow first laps is "improving" for ever.
    const stepForward = status === 'improving' && (m.saidGain <= 0 ? gain > 0 : gain >= m.saidGain + IMPROVE_SEC);
    if (stepForward) m.improvedAt = n;
    const corner = speakableCorner(f.cornerId);

    if (status === 'fixed') {
      const built = focusOf(s.recent, f.cornerId, 'fixed', f.sinceLapNo, m.cue || f.cue);
      s.focus = built.focus;
      if (!s.fixed.includes(f.cornerId)) s.fixed = [...s.fixed, f.cornerId];
      calls.push(call('coachProgress', fixedLine(corner, v)));
      m.saidAt = n;
    } else if (!stepForward && n - m.improvedAt >= NAG_LAPS) {
      // Nagging: park it and move to the next corner, if there is one worth it.
      const exclude = new Set([...s.fixed, ...s.parked!.map((p) => p.id), f.cornerId]);
      const next = pickFocus(s.recent, o, exclude);
      if (next) {
        s.parked = [...s.parked!, { id: f.cornerId, until: n + NAG_LAPS }];
        const built = focusOf(s.recent, next.id, 'new', v, undefined);
        s.focus = built.focus;
        s.focusMeta = { pickedAt: n, startSec: next.mean, improvedAt: n, saidAt: n, saidGain: 0, cue: built.focus.cue };
        calls.push(call('coachFocus', focusLine(speakableCorner(next.id), built.words, next.mean, v, 'swap', corner)));
      } else {
        const built = focusOf(s.recent, f.cornerId, status, f.sinceLapNo, m.cue || f.cue);
        s.focus = built.focus;
        if (n - m.saidAt >= 2 && finite(latest)) {
          calls.push(call('coachFocus', reminderLine(corner, built.words, status === 'improving', v)));
          m.saidAt = n;
        }
      }
    } else {
      const built = focusOf(s.recent, f.cornerId, status, f.sinceLapNo, m.cue || f.cue);
      s.focus = built.focus;
      if (stepForward) {
        calls.push(call('coachProgress', improvingLine(corner, gain, v)));
        m.saidGain = gain;
        m.saidAt = n;
      } else if (n - m.saidAt >= 2 && finite(latest)) {
        calls.push(call('coachFocus', reminderLine(corner, built.words, status === 'improving', v)));
        m.saidAt = n;
      }
    }
  } else if (!s.focus && ready) {
    // Nothing to work on yet (or last lap's was fixed): pick one.
    const exclude = new Set([...s.fixed, ...s.parked!.map((p) => p.id)]);
    const next = pickFocus(s.recent, o, exclude);
    if (next) {
      const built = focusOf(s.recent, next.id, 'new', v, undefined);
      s.focus = built.focus;
      s.focusMeta = { pickedAt: n, startSec: next.mean, improvedAt: n, saidAt: n, saidGain: 0, cue: built.focus.cue };
      calls.push(call('coachFocus', focusLine(speakableCorner(next.id), built.words, next.mean, v, lead)));
    }
  }

  // Consistency, on its laps.
  if (ready && o.consistencyEvery > 0 && n - s.lastConsistencyAt >= o.consistencyEvery) {
    const text = consistencyLine(s.history.slice(-o.consistencyEvery), v);
    s.lastConsistencyAt = n;
    if (text) calls.push(call('coachConsistency', text));
  }

  // The AI summary, on its laps.
  let wantSummary = false;
  if (ready && o.summaryEvery > 0 && n - s.lastSummaryAt >= o.summaryEvery) {
    wantSummary = true;
    s.lastSummaryAt = n;
  }

  return done(s, calls, wantSummary);
}

/** The engine as the contract names it. */
export const liveCoachEngine: LiveCoachEngine = { initLiveCoach, stepLiveCoach };
