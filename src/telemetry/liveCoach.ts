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
 *
 * # Coach v2 (2026-11-04): the work list, approach cues, debriefs
 *
 * Carl and the testers, after the first beta: one corner at a time is too
 * little, and the engineer does not say enough. So:
 *
 * ## The work list (`state.work`, up to `maxWork`, default 3)
 * Every corner that qualifies as a focus above is a CANDIDATE; the list holds
 * the costliest of them, costliest (by the window mean) first, `rank` 1..n.
 * Each corner on it lives exactly the life of the v1 focus — new →
 * improving / holding → fixed, its cue's phase and kind of number pinned at
 * the join, parked after {@link NAG_LAPS} counted laps without a step forward
 * when another candidate can take its slot — independently of the others. A
 * fixed corner shows ticked for one lap, is remembered in `runImproved` with
 * the time won back this run, and the NEXT counted lap fills its slot with
 * the next candidate (v1's "Next one's corner nine"). A corner is never
 * swapped out because another had one bad lap: a slot only frees when its
 * corner is fixed or parked. `state.focus` is always `work[0]` (or null), so
 * every v1 reader keeps working, and with `maxWork: 1` the engine is v1, call
 * for call.
 *
 * Each corner carries its `baselineSec` (window mean when it joined),
 * `gainSec` (baseline − window mean now, never more than the baseline),
 * `lastLossSec` (the last counted lap), `cueD` (where the reference brakes,
 * else the entry: what an approach cue is timed against), `cue2` (a second
 * measured change in another phase or of the other kind, when at least two
 * laps of the window agree on it and its phase costs
 * {@link CUE2_MIN_SEC}) and `approach`, the ≤ {@link APPROACH_MAX_WORDS}-word
 * line said on the straight before it ("Corner five, brake ten metres
 * later."). `approach` is ABSENT when the corner was fine on the last counted
 * lap (under `minFocusLossSec`): it rests a lap rather than nag a corner the
 * driver just got right.
 *
 * ## Approach cues ({@link approachCueAt}, pure, called per frame by the service)
 * The next work corner ahead of the car (by `cueD`, wrapping at the line) is
 * the only one that may be cued. It fires when the time to its `cueD` at the
 * current speed is inside [words / {@link GATE}.wordsPerSec +
 * GATE.speechLeadSec + {@link APPROACH_MARGIN_SEC}, that +
 * {@link APPROACH_WINDOW_SEC}]: early enough that the words END before the
 * braking point, late enough that they are about the corner in front. Never
 * in the pit lane, under {@link APPROACH_MIN_KPH}, before minLaps, twice for
 * one corner a lap (`cued`), for a resting or fixed corner, or with
 * `approachCues` off. Two work corners close together: the second is
 * considered only once the car is past the first's cue point, so it is cued
 * only if its words still fit — never said late.
 *
 * ## Lap-end lines (`coachLapDebrief`, when maxWork > 1 and `lapDebrief`)
 * They replace v1's per-lap focus / progress / reminder lines. After a
 * counted lap, one or two short sentences: the corners that took a step
 * forward (v1's rule: a NEW best gain on the baseline) or were fixed, with
 * the time back, then the costliest corner still costing on that lap with
 * what to change ("Better at four and nine, two tenths back. Five's still
 * costing a tenth: brake ten metres later."). A "still" sentence on its own
 * comes at most every second lap, and never about a corner that joined this
 * lap. Nothing worth saying, no line. A corner joining the list keeps v1's
 * short announcement (`coachFocus`: "Working on corners four, nine and two.
 * Four first: brake ten metres later." / "Next one's corner nine…" / "Let's
 * leave corner four for now…"). Consistency and the summary keep their
 * cadence. With `lapDebrief` off and maxWork > 1, the v1 lines are said for
 * the most newsworthy corner only (fixed > swapped > better > reminder), so
 * a lap is still never more than one line plus a join.
 *
 * ## The run debrief ({@link runDebrief}, {@link startRun})
 * Since `runStartLap`: the corners fixed this run (`runImproved`) and the
 * work corners at least {@link IMPROVE_SEC} better than when the run began,
 * with the total; then the work corners still costing, each with what is
 * happening ("Still to work on: five, braking about ten metres early, and
 * eleven, seven kph down on the exit."). At most three sentences and
 * {@link RUN_DEBRIEF_MAX_WORDS} words; null before minLaps counted laps in
 * the run. `startRun` clears `runImproved` and re-bases every work corner's
 * run gain on its window mean now.
 *
 * ## Priorities
 * All seven kinds are 'normal' urgency (radioGate.ts), so every number here
 * sits below any 'priority' kind (practiceLap's lap-time call among them) by
 * tier, whatever its value. Among themselves: the one-slot hold keeps the
 * HELD line unless the newcomer ranks at least as high, so coachApproach
 * (22) displaces a held lap-end line and is never displaced by one; the run
 * debrief (20) outranks the per-lap lines; coachLapDebrief shares
 * coachProgress's 18 (it replaces it), above a join line (17).
 */

import { COACH_PHASES, type CoachPhase, type CornerPhaseLoss } from './coachContract';
import { driverLoss } from './coachReport';
import { speakableGap } from './engineerCommands';
import { MAX_SPOKEN_WORDS, spokenWordCount } from './engineerPhrases';
import { GATE } from './radioGate';
import type {
  LiveApproachCue,
  LiveCoachCall,
  LiveCoachEngine,
  LiveCoachKind,
  LiveCoachLap,
  LiveCoachOptions,
  LiveCoachPosition,
  LiveCoachState,
  LiveCoachStep,
  LiveFocus,
  LiveFocusCue,
  LiveFocusStatus,
  LiveRunDebrief,
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

/** v2: an approach cue is one breath: at most this many spoken words. */
export const APPROACH_MAX_WORDS = 8;
/** v2: no approach cue below this speed (km/h): a crawl, a spin, the pit exit road. */
export const APPROACH_MIN_KPH = 60;
/**
 * v2: slack on top of the words' own time (s). The ETA is at the CURRENT
 * speed and the car is still accelerating down the straight, so it runs long;
 * the frame position is ~7 Hz besides.
 */
export const APPROACH_MARGIN_SEC = 0.5;
/** v2: how much earlier than the last moment that still fits a cue may start (s). */
export const APPROACH_WINDOW_SEC = 3;
/** v2: the reference's brake onset is the cue point when it is at most this far before the corner's entry (m). */
export const CUE_BACK_MAX_M = 600;
/** v2: a second change (`cue2`) is offered when its phase costs at least this on average (s). */
export const CUE2_MIN_SEC = 0.03;
/** v2: the run debrief's limit, in spoken words (three sentences on the in-lap). */
export const RUN_DEBRIEF_MAX_WORDS = 45;

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

/**
 * Radio priorities, within the 'normal' tier (see "Priorities" above): the
 * approach cue first (time-critical, dropped rather than said late), then the
 * run debrief, then the per-lap lines; progress / the lap-end line above the
 * focus line.
 */
export const LIVE_COACH_PRIORITY: Readonly<Record<LiveCoachKind, number>> = {
  coachApproach: 22,
  coachRunDebrief: 20,
  coachProgress: 18,
  coachLapDebrief: 18,
  coachFocus: 17,
  coachConsistency: 16,
  coachSummary: 15,
};
const PRIORITY = LIVE_COACH_PRIORITY;

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
  /**
   * v2: the reference's brake onset (fraction) when it belongs to this corner
   * (before the apex, at most {@link CUE_BACK_MAX_M} before the entry); null
   * for a lift or a flat corner. Absent in a v1 state.
   */
  refBrakeD?: number | null;
}

interface RecentLap {
  lapNo: number;
  lapSec: number;
  byCorner: Record<string, number>;
  detail?: Record<string, CornerDetail>;
}

/** What the engine remembers about one work-list corner (v1: the focus). */
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
  /** v2: its window mean when the current run started (or when it joined, if later): the run debrief's baseline. */
  runBase?: number;
}

interface EngineState extends LiveCoachState {
  /** Up to max(windowLaps, consistencyEvery) counted laps, newest last (the consistency call's laps). */
  history?: RecentLap[];
  /** Recent valid lap times, counted or not, for the outlier rule. */
  lapSecs?: number[];
  /** v1 state only (read once, migrated into workMeta). */
  focusMeta?: FocusMeta | null;
  /** v2: per work-list corner, by id. */
  workMeta?: Record<string, FocusMeta>;
  /** v2: the minLaps in force at the last step (1 against a board / chased lap), for runDebrief / approachCueAt. */
  minLaps?: number;
  /** v2: the minFocusLossSec in force at the last step, for runDebrief. */
  minFocusLossSec?: number;
  /** v2: counted-lap number of the last lap-end "still costing" sentence said on its own. */
  lastStillAt?: number;
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
    refBrakeD: finite(f.brakeOnD) && brakesForCorner(f.brakeOnD, c.entryD, c.apexD, L) ? wrap1(f.brakeOnD) : null,
  };
}

/** A lap fraction into [0, 1). */
const wrap1 = (d: number): number => ((d % 1) + 1) % 1;
/** The shortest signed lap distance a − b, in (−0.5, 0.5]. */
const circ = (a: number, b: number): number => {
  const x = wrap1(a - b);
  return x > 0.5 ? x - 1 : x;
};

/**
 * Is a reference brake onset this corner's? Before its apex and not more
 * than {@link CUE_BACK_MAX_M} before its entry (wrapping at the line: C1's
 * braking can start before the line).
 */
function brakesForCorner(brakeD: number, entryD: number, apexD: number, L: number): boolean {
  if (!finite(entryD) || !finite(apexD)) return false;
  const back = circ(entryD, brakeD); // + = braking starts before the entry
  const span = Math.max(0, circ(apexD, entryD));
  if (back < -span) return false; // after the apex: not this corner's braking
  return L > 0 ? back * L <= CUE_BACK_MAX_M : back <= 0.05;
}

/** Where a corner's approach cue is timed against: the reference brake point, else the entry. */
function cueDOf(d: CornerDetail): number {
  return finite(d.refBrakeD) ? d.refBrakeD : wrap1(d.entryD);
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

/**
 * Every corner worth working on, costliest first (ties by id): lost on two
 * laps of the window (one when there is only one), a mean of at least
 * `minFocusLossSec`, not already under it on the last two laps, not excluded.
 * v1's focus is the first; v2's work list takes as many as it has slots.
 */
function candidates(
  recent: readonly RecentLap[],
  o: Required<LiveCoachOptions>,
  exclude: ReadonlySet<string>,
): CornerJudge[] {
  const ids = new Set<string>();
  for (const r of recent) for (const id of Object.keys(r.byCorner)) ids.add(id);
  const needLost = Math.min(2, recent.length);
  const out: CornerJudge[] = [];
  for (const id of ids) {
    if (exclude.has(id)) continue;
    const j = judge(recent, id);
    if (j.lost < needLost || j.mean < o.minFocusLossSec) continue;
    if (underFor2(j, o.minFocusLossSec)) continue; // already sorted on the last two laps
    out.push(j);
  }
  return out.sort((a, b) => b.mean - a.mean || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

/**
 * v2: a second measured change in the same corner (`cue2`), or null. The
 * phases the driver loses at least {@link CUE2_MIN_SEC} in, costliest first,
 * each phase's own numbers (the exit's earlier pick-up, then its exit speed),
 * the first that is of a different KIND from the main cue and that two laps
 * of the window agree on ({@link agreed}). Never off one lap: one lap is an
 * anecdote, and the main cue already says what it shows. Not pinned: it is
 * detail, said only while the window agrees on it.
 */
function secondCue(recent: readonly RecentLap[], id: string, primary: LiveFocusCue): CueWords | null {
  const ds = windowDetails(recent, id);
  if (ds.length < 2) return null;
  const pk = kindOf(primary);
  const byLoss = COACH_PHASES.filter((p) => p !== 'turnIn')
    .map((p) => ({ p, v: mean(ds.map((d) => d.ph[p])) ?? 0 }))
    .filter((x) => x.v >= CUE2_MIN_SEC)
    .sort((a, b) => b.v - a.v);
  for (const { p } of byLoss) {
    const fns: CueKind[] = p === 'braking' ? ['brake'] : p === 'midCorner' ? ['minKph'] : ['throttle', 'exitKph'];
    for (const k of fns) {
      if (k === pk) continue;
      const c = CUE_OF[k](p, ds);
      if (c) return c;
    }
  }
  return null;
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

/**
 * v2: the first of the bank, IN ORDER, that fits `max` words; the shortest
 * when none does. The banks below are written most detailed first, so the
 * line says as much as one breath allows.
 */
function firstFit(bank: readonly string[], max: number = MAX_SPOKEN_WORDS): string {
  for (const t of bank) if (spokenWordCount(t) <= max) return t;
  return [...bank].sort((x, y) => spokenWordCount(x) - spokenWordCount(y))[0]!;
}

/** 'C4' → "four" (in a list after "corners", or a second sentence); an id without a number as it is. */
function bareCorner(id: string): string {
  const no = cornerNoOf(id);
  return no !== null ? numberWords(no) : String(id || 'that corner');
}

/** ["four", "nine", "two"] → "four, nine and two". */
function listWords(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] || '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** "corner four" / "corners four and nine". */
/** Corner ids in lap order (C2 before C10), for a list said aloud. */
function lapOrder(ids: readonly string[]): string[] {
  const key = (id: string): number => cornerNoOf(id) ?? Number.MAX_SAFE_INTEGER;
  return [...ids].sort((a, b) => key(a) - key(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function cornersWords(ids: readonly string[]): string {
  return ids.length === 1 ? speakableCorner(ids[0]!) : `corners ${listWords(ids.map(bareCorner))}`;
}

/** The cue's "what to do", with the second change when there is one. */
function todoWith(cw: CueWords, second: CueWords | null | undefined): string {
  return second ? `${cw.todo} and ${second.todo}` : cw.todo;
}

/**
 * v2: the approach cue, ≤ {@link APPROACH_MAX_WORDS} words: the corner and
 * the main change with its number ("Corner five, brake ten metres later."),
 * else the phase's words, else none. Never the second change: one breath.
 */
function approachLine(corner: string, cw: CueWords): string | undefined {
  const full = `${cap1(corner)}, ${cw.todo}.`;
  if (spokenWordCount(full) <= APPROACH_MAX_WORDS) return full;
  const phase = `${cap1(corner)}, ${PHASE_ONLY[cw.cue.phase].todo}.`;
  return spokenWordCount(phase) <= APPROACH_MAX_WORDS ? phase : undefined;
}

function focusLine(
  corner: string,
  cw: CueWords,
  lossSec: number,
  v: number,
  lead: 'first' | 'next' | 'swap',
  from?: string,
  second?: CueWords | null,
): string {
  const C = cap1(corner);
  const worth = speakableCoachTime(lossSec);
  // v2: with a second change the window agrees on, the detailed line first
  // when it fits one breath; otherwise the v1 banks exactly.
  if (second) {
    const both = todoWith(cw, second);
    const rich =
      lead === 'swap' && from
        ? [`Let's leave ${from} for now. ${C}: ${both}.`]
        : lead === 'next'
          ? [`Next one's ${corner}: ${both}. Worth ${worth}.`, `Next one's ${corner}: ${both}.`]
          : [`${C}: ${both}. Worth ${worth}.`, `${C}: ${both}.`];
    for (const t of rich) if (spokenWordCount(t) <= MAX_SPOKEN_WORDS) return t;
  }
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

/** One corner joining the work list, as the v2 join line needs it. */
interface Joined {
  id: string;
  words: CueWords;
  second: CueWords | null;
  lossSec: number;
}

/**
 * v2: the announcement when corners JOIN the work list (coachFocus). One
 * corner: v1's lines ("Biggest loss is corner four: …", "Next one's corner
 * nine: …"). Several (the first fill): the list, then the costliest's cue —
 * "Working on corners four, nine and two. Four first: brake ten metres
 * later." The approach cues say the rest, corner by corner.
 */
function joinLine(joined: readonly Joined[], lead: 'first' | 'next', v: number): string {
  const top = joined[0]!;
  if (joined.length === 1) return focusLine(speakableCorner(top.id), top.words, top.lossSec, v, lead, undefined, top.second);
  const names = listWords(lapOrder(joined.map((j) => j.id)).map(bareCorner));
  const head = lead === 'first' ? `Working on corners ${names}.` : `Next up, corners ${names}.`;
  const T = cap1(bareCorner(top.id));
  return firstFit([
    `${head} ${T} first: ${todoWith(top.words, top.second)}.`,
    `${head} ${T} first: ${top.words.todo}.`,
    `${head} ${T}'s worth ${speakableCoachTime(top.lossSec)}.`,
    head,
  ]);
}

/** A corner that took a step forward (or was fixed) on this lap. */
interface Better {
  id: string;
  gainSec: number;
  fixed: boolean;
}

/** The corner still costing, for the lap-end line's second sentence. */
interface Still {
  id: string;
  latestSec: number;
  words: CueWords;
  second: CueWords | null;
}

/**
 * v2: the lap-end line (coachLapDebrief), or null. What got better ("Better
 * at four and nine, two tenths back." / "Corner four's sorted, a tenth
 * back.") and what is still costing on this lap, with its numbers ("Five's
 * still costing a tenth and a half: brake ten metres later."), the most
 * detailed pair that fits {@link MAX_SPOKEN_WORDS}. The time back is said
 * before the still-sentence's detail is: it is what the driver earned.
 */
function lapDebriefLine(better: readonly Better[], still: Still | null): { text: string; saidStill: boolean } | null {
  const s1: string[] = [];
  if (better.length) {
    const ids = lapOrder(better.map((b) => b.id));
    const total = better.reduce((a, b) => a + Math.max(0, b.gainSec), 0);
    const back = total >= 0.05 ? speakableCoachTime(total) : null;
    if (better.every((b) => b.fixed)) {
      const C = cap1(cornersWords(ids));
      const verb = ids.length === 1 ? `${C}'s sorted` : `${C} sorted`;
      if (back) s1.push(`${verb}, ${back} back.`);
      s1.push(`${verb}.`);
    } else {
      const named = cornersWords(ids);
      const bare = ids.length === 1 ? named : listWords(ids.map(bareCorner));
      if (back) s1.push(`Better through ${named}, ${back} back.`, `Better at ${bare}, ${back} back.`);
      s1.push(`Better through ${named}.`, `Better at ${bare}.`);
    }
  }
  const s2: string[] = [];
  if (still) {
    const S = s1.length ? cap1(bareCorner(still.id)) : cap1(speakableCorner(still.id));
    const worth = speakableCoachTime(still.latestSec);
    if (still.second) s2.push(`${S}'s still costing ${worth}: ${todoWith(still.words, still.second)}.`);
    s2.push(`${S}'s still costing ${worth}: ${still.words.todo}.`, `${S} still: ${still.words.todo}.`, `${S}'s still costing ${worth}.`);
  }
  if (!s1.length && !s2.length) return null;
  if (!s1.length) return { text: firstFit(s2), saidStill: true };
  if (!s2.length) return { text: firstFit(s1), saidStill: false };
  for (const a of s1) {
    for (const b of s2) {
      const t = `${a} ${b}`;
      if (spokenWordCount(t) <= MAX_SPOKEN_WORDS) return { text: t, saidStill: true };
    }
  }
  return { text: firstFit(s1), saidStill: false }; // the still part waits for a lap with room
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

const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;

/** One work-list corner, built, with the words its lines are made of. */
interface Built {
  focus: LiveFocus;
  words: CueWords;
  second: CueWords | null;
}

/**
 * One work-list corner as the card, the radio and the voice see it, over the
 * window. `meta` is its baseline (absent: the window mean is). The v2 fields
 * ride along whatever maxWork is: a v1 reader ignores them.
 */
function focusOf(
  recent: readonly RecentLap[],
  id: string,
  status: LiveFocusStatus,
  sinceLapNo: number,
  pinned: LiveFocusCue | undefined,
  meta?: FocusMeta | null,
  minFocusLossSec: number = LIVE_COACH_DEFAULTS.minFocusLossSec,
): Built {
  const j = judge(recent, id);
  const words = cueFor(recent, id, pinned);
  const second = secondCue(recent, id, words.cue);
  let geo: CornerDetail | undefined;
  for (let i = recent.length - 1; i >= 0 && !geo; i -= 1) geo = recent[i]!.detail?.[id];
  const corner = speakableCorner(id);
  const no = cornerNoOf(id);
  const lastLap = recent.length ? recent[recent.length - 1]!.byCorner[id] : undefined;
  const base = meta && finite(meta.startSec) ? meta.startSec : j.mean;
  const focus: LiveFocus = {
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
    baselineSec: r3(base),
    // Never more back than it was losing: past that it is gaining on the reference.
    gainSec: r3(Math.min(base, base - j.mean)),
  };
  if (geo) focus.cueD = r5(cueDOf(geo));
  if (finite(lastLap)) focus.lastLossSec = r3(lastLap);
  if (second) focus.cue2 = second.cue;
  // A corner that was fine on the last counted lap rests: no cue on the way
  // in. A fixed one is done.
  const resting = finite(lastLap) && lastLap < minFocusLossSec;
  if (status !== 'fixed' && !resting) {
    const a = approachLine(corner, words);
    if (a) focus.approach = a;
  }
  return { focus, words, second };
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
    work: [],
    runImproved: [],
    runStartLap: 0,
    fixed: [],
    lastConsistencyAt: 0,
    lastSummaryAt: 0,
    refLapId: null,
    history: [],
    lapSecs: [],
    workMeta: {},
    parked: [],
    refKind: null,
    seen: [],
    lastStillAt: 0,
  };
  return s;
}

function newMeta(n: number, startSec: number, cue: LiveFocusCue | undefined): FocusMeta {
  return { pickedAt: n, startSec, improvedAt: n, saidAt: n, saidGain: 0, cue, runBase: startSec };
}

/**
 * A deep copy, every field defaulted. A v1 state (focus + focusMeta, no work
 * list) reads as a one-corner work list, so a state kept across an update
 * carries on.
 */
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
  c.work = Array.isArray(c.work) ? c.work.filter((f) => f && f.cornerId) : c.focus ? [c.focus] : [];
  c.workMeta = c.workMeta && typeof c.workMeta === 'object' ? c.workMeta : {};
  if (c.focus && c.focusMeta && !c.workMeta[c.focus.cornerId]) c.workMeta[c.focus.cornerId] = c.focusMeta;
  delete c.focusMeta;
  for (const f of c.work) {
    if (!c.workMeta[f.cornerId]) {
      c.workMeta[f.cornerId] = newMeta(c.validLaps, finite(f.baselineSec) ? f.baselineSec : f.lossSec, f.cue);
    }
  }
  c.focus = c.work[0] ?? null;
  c.runImproved = Array.isArray(c.runImproved) ? c.runImproved : [];
  c.runStartLap = finite(c.runStartLap) ? c.runStartLap : 0;
  c.lastStillAt = finite(c.lastStillAt) ? c.lastStillAt : 0;
  return c;
}

/** The step's answer; `focus` and `work` are the state's own (the service publishes them as they are). */
function done(s: EngineState, calls: LiveCoachCall[], wantSummary: boolean): LiveCoachStep {
  return { state: s, calls, focus: s.focus, wantSummary, work: s.work };
}

/** Remember a corner improved this run (the larger gain if it is there already). */
function addImproved(s: EngineState, id: string, gainSec: number): void {
  const list = (s.runImproved || []).filter((x) => x.cornerId !== id);
  const had = (s.runImproved || []).find((x) => x.cornerId === id);
  list.push({ cornerId: id, gainSec: r3(Math.max(gainSec, had ? had.gainSec : 0)) });
  s.runImproved = list;
}

/** What happened to one work-list corner on this lap. */
type EventKind = 'fixed' | 'swap' | 'step' | 'remind';
interface CornerEvent {
  kind: EventKind;
  id: string;
  built: Built;
  meta: FocusMeta;
  /** Time back on this lap against its baseline (s). */
  gain: number;
  /** For a swap: the corner it replaced. */
  from?: string;
  /** Its window mean, for a swap's words. */
  lossSec: number;
}

const EVENT_ORDER: readonly EventKind[] = ['fixed', 'swap', 'step', 'remind'];

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
    s.work = [];
    s.workMeta = {};
    s.fixed = [];
    s.parked = [];
    s.runImproved = [];
    s.runStartLap = s.validLaps;
  }
  s.refKind = kind;
  const minLaps = kind === 'sessionBest' ? o.minLaps : 1;
  s.minLaps = minLaps;
  s.minFocusLossSec = o.minFocusLossSec;

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
  const ready = n >= minLaps;
  const meta = s.workMeta!;

  // Last lap's fixed corners make way now; their slots fill below.
  const hadWork = s.work!.length > 0;
  s.work = s.work!.filter((f) => {
    if (f.status !== 'fixed') return true;
    delete meta[f.cornerId];
    return false;
  });

  // Every work corner, re-judged on its own.
  const events: CornerEvent[] = [];
  const kept: LiveFocus[] = [];
  const builtOf: Record<string, Built> = {};
  const joined: Joined[] = [];
  const swappedIn = new Set<string>();
  for (const f of s.work) {
    const id = f.cornerId;
    const m = meta[id] || (meta[id] = newMeta(n - 1, finite(f.baselineSec) ? f.baselineSec : f.lossSec, f.cue));
    const j = judge(s.recent, id);
    const latest = r.byCorner[id];
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

    if (status === 'fixed') {
      const b = focusOf(s.recent, id, 'fixed', f.sinceLapNo, m.cue || f.cue, m, o.minFocusLossSec);
      kept.push(b.focus);
      builtOf[id] = b;
      if (!s.fixed.includes(id)) s.fixed = [...s.fixed, id];
      // For the run debrief: the time won back since the run began, off the two clean laps.
      const now = mean(j.last2.filter(finite)) ?? j.mean;
      const base = finite(m.runBase) ? m.runBase : m.startSec;
      addImproved(s, id, Math.max(0, Math.min(base, base - now)));
      events.push({ kind: 'fixed', id, built: b, meta: m, gain, lossSec: j.mean });
      continue;
    }
    if (!stepForward && n - m.improvedAt >= NAG_LAPS) {
      // Nagging: park it and give its slot to the next corner, if one is worth it.
      const exclude = new Set([...s.fixed, ...s.parked!.map((p) => p.id), ...s.work.map((x) => x.cornerId), ...kept.map((x) => x.cornerId)]);
      const next = candidates(s.recent, o, exclude)[0];
      if (next) {
        s.parked = [...s.parked!, { id, until: n + NAG_LAPS }];
        delete meta[id];
        const b = focusOf(s.recent, next.id, 'new', v, undefined, null, o.minFocusLossSec);
        const nm = newMeta(n, next.mean, b.focus.cue);
        meta[next.id] = nm;
        kept.push(b.focus);
        builtOf[next.id] = b;
        swappedIn.add(next.id);
        joined.push({ id: next.id, words: b.words, second: b.second, lossSec: next.mean });
        events.push({ kind: 'swap', id: next.id, built: b, meta: nm, gain: 0, from: id, lossSec: next.mean });
        continue;
      }
    }
    const b = focusOf(s.recent, id, status, f.sinceLapNo, m.cue || f.cue, m, o.minFocusLossSec);
    kept.push(b.focus);
    builtOf[id] = b;
    if (stepForward) events.push({ kind: 'step', id, built: b, meta: m, gain, lossSec: j.mean });
    else if (n - m.saidAt >= 2 && finite(latest)) events.push({ kind: 'remind', id, built: b, meta: m, gain, lossSec: j.mean });
  }

  // Free slots (none yet, a fixed corner gone, fewer candidates than slots
  // before): the costliest candidates join.
  if (ready && kept.length < o.maxWork) {
    const exclude = new Set([...s.fixed, ...s.parked!.map((p) => p.id), ...kept.map((x) => x.cornerId)]);
    for (const c of candidates(s.recent, o, exclude).slice(0, o.maxWork - kept.length)) {
      const b = focusOf(s.recent, c.id, 'new', v, undefined, null, o.minFocusLossSec);
      meta[c.id] = newMeta(n, c.mean, b.focus.cue);
      kept.push(b.focus);
      builtOf[c.id] = b;
      joined.push({ id: c.id, words: b.words, second: b.second, lossSec: c.mean });
    }
  }

  // Costliest first; a corner fixed on this lap shows (ticked) at the end.
  kept.sort(
    (a, b) =>
      (a.status === 'fixed' ? 1 : 0) - (b.status === 'fixed' ? 1 : 0) ||
      b.lossSec - a.lossSec ||
      (a.cornerId < b.cornerId ? -1 : a.cornerId > b.cornerId ? 1 : 0),
  );
  kept.forEach((f, i) => {
    f.rank = i + 1;
  });
  s.work = kept;
  s.focus = kept[0] ?? null;
  const rankOf = (id: string): number => kept.findIndex((f) => f.cornerId === id);
  joined.sort((a, b) => b.lossSec - a.lossSec || rankOf(a.id) - rankOf(b.id));
  const lead: 'first' | 'next' = hadWork ? 'next' : 'first';
  const swap = events.find((e) => e.kind === 'swap');

  if (o.maxWork > 1 && o.lapDebrief) {
    // v2: one lap-end line instead of a line per corner.
    const better: Better[] = events
      .filter((e) => e.kind === 'fixed' || e.kind === 'step')
      .sort((a, b) => rankOf(a.id) - rankOf(b.id))
      .map((e) => ({ id: e.id, gainSec: e.gain, fixed: e.kind === 'fixed' }));
    // The corner still costing on this lap: the one said least recently
    // (then the costliest), so the line goes round the list instead of
    // naming the top corner every time — its approach cue says it each lap.
    // On its own, at most every second lap; never on a lap a corner joined
    // (the join line is that lap's coaching).
    let still: Still | null = null;
    if (!joined.length) {
      const skip = new Set(better.map((b) => b.id));
      const soloOk = n - (s.lastStillAt ?? 0) >= 2;
      let bestSaid = Infinity;
      for (const f of kept) {
        if (f.status === 'fixed' || skip.has(f.cornerId)) continue;
        const latest = r.byCorner[f.cornerId];
        if (!finite(latest) || latest < o.minFocusLossSec) continue;
        const m = meta[f.cornerId];
        const saidAt = m ? m.saidAt : 0;
        if (!better.length && (!soloOk || n - saidAt < 2)) continue;
        if (saidAt >= bestSaid) continue; // kept is costliest first: ties keep the costlier
        bestSaid = saidAt;
        still = { id: f.cornerId, latestSec: latest, words: builtOf[f.cornerId]!.words, second: builtOf[f.cornerId]!.second };
      }
    }
    const line = lapDebriefLine(better, still);
    if (line) {
      calls.push(call('coachLapDebrief', line.text));
      for (const e of events) {
        if (e.kind !== 'step') continue;
        e.meta.saidGain = e.gain;
        e.meta.saidAt = n;
      }
      if (still && line.saidStill) {
        const m = meta[still.id];
        if (m) m.saidAt = n;
        s.lastStillAt = n;
      }
    }
    if (swap) {
      calls.push(call('coachFocus', focusLine(speakableCorner(swap.id), swap.built.words, swap.lossSec, v, 'swap', speakableCorner(swap.from!), swap.built.second)));
    } else if (joined.length) {
      calls.push(call('coachFocus', joinLine(joined, lead, v)));
    }
  } else {
    // v1 lines: the most newsworthy corner's (maxWork 1: the focus's), one at most.
    const e = [...events].sort((a, b) => EVENT_ORDER.indexOf(a.kind) - EVENT_ORDER.indexOf(b.kind) || rankOf(a.id) - rankOf(b.id))[0];
    if (e) {
      const corner = speakableCorner(e.id);
      if (e.kind === 'fixed') {
        calls.push(call('coachProgress', fixedLine(corner, v)));
        e.meta.saidAt = n;
      } else if (e.kind === 'swap') {
        calls.push(call('coachFocus', focusLine(corner, e.built.words, e.lossSec, v, 'swap', speakableCorner(e.from!), e.built.second)));
      } else if (e.kind === 'step') {
        calls.push(call('coachProgress', improvingLine(corner, e.gain, v)));
        e.meta.saidGain = e.gain;
        e.meta.saidAt = n;
      } else {
        calls.push(call('coachFocus', reminderLine(corner, e.built.words, e.built.focus.status === 'improving', v)));
        e.meta.saidAt = n;
      }
    }
    // A corner joining that no swap line has named.
    const fresh = joined.filter((j) => !swappedIn.has(j.id));
    if (fresh.length) calls.push(call('coachFocus', joinLine(fresh, lead, v)));
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

/* -------------------------------------------------------------------------- */
/*  v2: approach cues                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The approach cue to say NOW, or null (see "Approach cues" above). Pure: the
 * service calls it on every frame with the car's position and the corners it
 * has already cued on this lap (cleared at the line), and says what comes
 * back as a `coachApproach` (priority {@link LIVE_COACH_PRIORITY}).
 *
 * The ETA is distance to `cueD` over the current speed. The words must end
 * before the car gets there: they take spokenWordCount / GATE.wordsPerSec +
 * GATE.speechLeadSec, plus {@link APPROACH_MARGIN_SEC}; the cue may start up
 * to {@link APPROACH_WINDOW_SEC} before that last moment, never after it.
 */
export function approachCueAt(
  state: LiveCoachState,
  pos: LiveCoachPosition,
  cued: readonly string[],
  opts?: LiveCoachOptions,
): LiveApproachCue | null {
  const o = opt(opts);
  if (!o.approachCues || !state || !pos) return null;
  if (pos.inPit) return null;
  if (!finite(pos.speedKph) || pos.speedKph < APPROACH_MIN_KPH) return null;
  if (!finite(pos.lapD)) return null;
  const L = finite(pos.trackLengthM) && pos.trackLengthM > 0 ? pos.trackLengthM : 0;
  if (!L) return null;
  const es = state as EngineState;
  // The minLaps the last step used (1 against a board or chased lap), else the options.
  const minLaps = finite(es.minLaps) ? es.minLaps : o.minLaps;
  if (!finite(state.validLaps) || state.validLaps < minLaps) return null;
  const work = Array.isArray(state.work) ? state.work : state.focus ? [state.focus] : [];
  const at = wrap1(pos.lapD);
  // The next work corner ahead, by its cue point, wrapping at the line. Only
  // that one may be cued: the one after it waits until the car is past it.
  let next: LiveFocus | null = null;
  let ahead = Infinity;
  for (const f of work) {
    if (!f || f.status === 'fixed') continue;
    const cd = finite(f.cueD) ? f.cueD : f.entryD;
    if (!finite(cd)) continue;
    const a = wrap1(cd - at);
    if (a < ahead) {
      ahead = a;
      next = f;
    }
  }
  if (!next || !next.approach) return null;
  if (Array.isArray(cued) && cued.includes(next.cornerId)) return null;
  const etaSec = (ahead * L) / (pos.speedKph / 3.6);
  const need = spokenWordCount(next.approach) / GATE.wordsPerSec + GATE.speechLeadSec + APPROACH_MARGIN_SEC;
  if (etaSec < need || etaSec > need + APPROACH_WINDOW_SEC) return null;
  return { cornerId: next.cornerId, text: next.approach, etaSec: Math.round(etaSec * 100) / 100 };
}

/* -------------------------------------------------------------------------- */
/*  v2: the run debrief                                                       */
/* -------------------------------------------------------------------------- */

/** The still-to-work corner with the words the template needs. */
interface StillItem {
  cornerId: string;
  lossSec: number;
  what: string;
  words: CueWords;
  second: CueWords | null;
}

/**
 * The run so far (since `runStartLap`), as a template the AI may rewrite
 * (see "The run debrief" above); null before minLaps counted laps this run.
 */
export function runDebrief(state: LiveCoachState): LiveRunDebrief | null {
  if (!state) return null;
  const s = state as EngineState;
  const n = finite(s.validLaps) ? s.validLaps : 0;
  const laps = Math.max(0, n - (finite(s.runStartLap) ? s.runStartLap : 0));
  const minLaps = finite(s.minLaps) ? s.minLaps : LIVE_COACH_DEFAULTS.minLaps;
  if (laps < Math.max(1, minLaps)) return null;
  const minLoss = finite(s.minFocusLossSec) ? s.minFocusLossSec : LIVE_COACH_DEFAULTS.minFocusLossSec;
  const recent = Array.isArray(s.recent) ? s.recent : [];
  const work = Array.isArray(s.work) ? s.work : s.focus ? [s.focus] : [];
  const meta = s.workMeta || {};

  const gains = new Map<string, number>();
  for (const x of s.runImproved || []) {
    if (x && x.cornerId && finite(x.gainSec)) gains.set(x.cornerId, Math.max(gains.get(x.cornerId) ?? 0, x.gainSec));
  }
  const still: StillItem[] = [];
  for (const f of work) {
    if (!f || f.status === 'fixed') continue; // in runImproved already
    const m = meta[f.cornerId];
    const j = judge(recent, f.cornerId);
    const base = m ? (finite(m.runBase) ? m.runBase : m.startSec) : finite(f.baselineSec) ? f.baselineSec : j.mean;
    const g = Math.min(base, base - j.mean);
    // Clearly better: v1's improving rule against the run's baseline, so a
    // corner that moved a few hundredths is not both "improved" and "still".
    if (g >= IMPROVE_SEC && (g >= IMPROVE_SHARE * base || j.mean < minLoss)) gains.set(f.cornerId, Math.max(gains.get(f.cornerId) ?? 0, g));
    if (j.laps && j.mean >= minLoss) {
      const words = cueFor(recent, f.cornerId, (m && m.cue) || f.cue);
      still.push({ cornerId: f.cornerId, lossSec: r3(j.mean), what: words.what, words, second: secondCue(recent, f.cornerId, words.cue) });
    }
  }
  const improved = [...gains.entries()]
    .map(([cornerId, gainSec]) => ({ cornerId, gainSec: r3(Math.max(0, gainSec)) }))
    .sort((a, b) => b.gainSec - a.gainSec || (a.cornerId < b.cornerId ? -1 : 1));
  still.sort((a, b) => b.lossSec - a.lossSec);
  return {
    improved,
    still: still.map(({ cornerId, lossSec, what }) => ({ cornerId, lossSec, what })),
    text: runDebriefText(improved, still),
    laps,
  };
}

/**
 * ≤ 3 sentences, ≤ {@link RUN_DEBRIEF_MAX_WORDS} words: improved (with the
 * total), still to work on (each with what is happening), and what is left
 * on the table — the most detailed version that fits.
 */
function runDebriefText(improved: readonly { cornerId: string; gainSec: number }[], still: readonly StillItem[]): string {
  const s1: string[] = [];
  if (improved.length) {
    const ids = lapOrder(improved.map((x) => x.cornerId));
    const total = improved.reduce((a, x) => a + x.gainSec, 0);
    const t = total >= 0.05 ? speakableCoachTime(total) : null;
    if (ids.length === 1) {
      if (t) s1.push(`You've improved ${speakableCorner(ids[0]!)}, ${t} back.`);
      s1.push(`You've improved ${speakableCorner(ids[0]!)}.`);
    } else {
      if (t) s1.push(`You've improved ${cornersWords(ids)}, about ${t} in all.`);
      s1.push(`You've improved ${cornersWords(ids)}.`);
    }
  } else if (still.length) {
    s1.push('No clear gains yet this run.');
  } else {
    return 'No corner stands out this run. Keep it tidy.';
  }
  if (!still.length) return firstFit(s1, RUN_DEBRIEF_MAX_WORDS);

  const top = still.slice(0, 3);
  const s2: string[] = [];
  if (top.length === 1) {
    s2.push(`Still to work on: ${speakableCorner(top[0]!.cornerId)}, ${top[0]!.what}.`);
  } else {
    for (let k = top.length; k >= 2; k -= 1) {
      const xs = top.slice(0, k).map((x) => `${bareCorner(x.cornerId)}, ${x.what}`);
      s2.push(`Still to work on: ${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}.`);
    }
    s2.push(`Still to work on: ${cornersWords(top.map((x) => x.cornerId))}.`);
  }
  const s3: string[] = [];
  const t0 = top[0]!;
  if (top.length === 1) {
    if (t0.second) s3.push(`${cap1(t0.words.todo)} and ${t0.second.todo}, worth ${speakableCoachTime(t0.lossSec)}.`);
    s3.push(`${cap1(t0.words.todo)}, worth ${speakableCoachTime(t0.lossSec)}.`);
  } else {
    const left = still.reduce((a, x) => a + x.lossSec, 0);
    s3.push(`${cap1(bareCorner(t0.cornerId))} first: ${todoWith(t0.words, t0.second)}.`, `${cap1(bareCorner(t0.cornerId))} first: ${t0.words.todo}.`, `About ${speakableCoachTime(left)} still there.`);
  }
  const bank: string[] = [];
  for (const a of s1) for (const b of s2) for (const c of s3) bank.push(`${a} ${b} ${c}`);
  for (const a of s1) for (const b of s2) bank.push(`${a} ${b}`);
  return firstFit(bank, RUN_DEBRIEF_MAX_WORDS);
}

/**
 * A new run: after a pit stop, or once the run debrief was said. The
 * improvements so far are forgotten and every work corner's run baseline is
 * its window mean now; the work list, the window and the session's fixed
 * corners are kept.
 */
export function startRun(state: LiveCoachState): LiveCoachState {
  const s = cloneState(state);
  s.runImproved = [];
  s.runStartLap = s.validLaps;
  for (const f of s.work!) {
    const m = s.workMeta![f.cornerId];
    if (m) m.runBase = r3(judge(s.recent, f.cornerId).mean);
  }
  return s;
}

/** The engine as the contract names it. */
export const liveCoachEngine: LiveCoachEngine = { initLiveCoach, stepLiveCoach, approachCueAt, runDebrief, startRun };
