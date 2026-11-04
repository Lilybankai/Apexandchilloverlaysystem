/**
 * liveCoachContract.ts — the shared shapes of the live practice coach.
 * -----------------------------------------------------------------------------
 * The Practice tab's coach, while the driver is still driving: after every
 * timed lap of a PRACTICE (or test-day) session the engineer may say one
 * short line about the corner that is costing the most, consistently, and an
 * in-game card shows that corner and what to change. Never in qualifying, a
 * race or a warm-up.
 *
 * Four pieces build against this file and nothing else of each other:
 *
 *   - `liveCoach.ts` (engine, pure): one lap's breakdown in → the new state,
 *     the radio calls to make and the focus to show. {@link stepLiveCoach}.
 *   - `electron/live-coach.js` (service): watches laps land in the lap log
 *     during a practice session, runs the coach loader on the session so far,
 *     steps the engine, says the calls through the engineer's `sayReadout`
 *     and publishes {@link LiveCoachOverlay} on the frame as `player.coach`.
 *   - `overlay/js/widgets/trainingfocus.js` (widget): the in-game Focus card,
 *     reading only `frame.player.coach`.
 *   - `liveCoachVoice.ts` (voice + AI): the driver's questions answered from
 *     {@link LiveCoachSnapshot}, and the every-few-laps AI summary.
 *
 * Conventions are the coach's (coachContract.ts): distances on a lap are lap
 * FRACTIONS 0..1 unless a name ends in `M` (metres); positive seconds =
 * losing; brake delta positive = braking LATER than the reference; speed delta
 * positive = FASTER. Corner ids are the ones the Practice tab shows ('C1'..),
 * from the corner catalogue when the layout has one — the radio says
 * "corner 4" for 'C4', never "turn 4" (they are not the official turns).
 * Time a corner's exit run lost to a tow or a faster car (`straightFlag`) is
 * never the driver's and never coached.
 */

import type { CoachPhase, LapLossBreakdown } from './coachContract';

/* -------------------------------------------------------------------------- */
/*  Input: one lap as the engine sees it                                      */
/* -------------------------------------------------------------------------- */

export interface LiveCoachLap {
  lapId: string;
  lapNo: number;
  lapSec: number;
  /** False for an out-lap, an in-lap, a lap with an off / track-limits flag, or no trace. */
  valid: boolean;
  /** This lap against the session's current reference; null when it could not be measured. */
  breakdown: LapLossBreakdown | null;
  /** Lap length in metres, to turn fractions into "10 metres". */
  trackLengthM: number;
  /** What it is measured against, for the words ("your best", "the leaderboard lap"). */
  refKind: 'sessionBest' | 'board' | 'chased';
  refLapId: string | null;
  /** When the lap completed (ISO). */
  at: string;
}

export interface LiveCoachOptions {
  /** How many recent valid laps a focus is judged over. Default 3. */
  windowLaps?: number;
  /** Valid laps needed before the coach says anything. Default 2. */
  minLaps?: number;
  /** A corner must cost at least this much on average to be a focus (s). Default 0.08. */
  minFocusLossSec?: number;
  /** Consistency call every this many valid laps; 0 = never. Default 5. */
  consistencyEvery?: number;
  /** AI summary every this many valid laps; 0 = never. Default 5. */
  summaryEvery?: number;
  /**
   * Coach v2 (2026-11-04): how many corners the coach works on at once — the
   * work list. 1 = the v1 behaviour (one focus). Default 3.
   */
  maxWork?: number;
  /** Approach cues on the radio before each work-list corner. Default true. */
  approachCues?: boolean;
  /** A lap-end line ("better at four and nine, five still costing…") after each valid lap. Default true. */
  lapDebrief?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  The focus                                                                 */
/* -------------------------------------------------------------------------- */

/** What to change in the focus corner, as one measurable thing. */
export interface LiveFocusCue {
  phase: CoachPhase;
  /** Metres: + = brake later than now. Present when the cue is about the braking point. */
  brakeShiftM?: number;
  /** km/h: + = carry more minimum speed. */
  minKphGain?: number;
  /** Metres: + = get to full throttle later is never advised; − = pick up earlier. */
  throttleShiftM?: number;
  /** km/h: + = more exit speed onto the straight. */
  exitKphGain?: number;
}

export type LiveFocusStatus = 'new' | 'holding' | 'improving' | 'fixed';

export interface LiveFocus {
  cornerId: string;
  /** 4 for 'C4'. */
  cornerNo: number;
  /** Where it is on the lap (fractions), for the card's map and its "approaching" light. */
  entryD: number;
  apexD: number;
  exitD: number;
  /** Average loss in this corner over the window (s), driver's part only. */
  lossSec: number;
  cue: LiveFocusCue;
  /** The card's words, ≤ 28 characters: "Brake 10 m later". */
  short: string;
  /** The radio's words, one sentence. */
  spoken: string;
  status: LiveFocusStatus;
  /** The valid lap this focus was first picked on. */
  sinceLapNo: number;

  /* ---- Coach v2 (2026-11-04), all optional so v1 producers stay valid ---- */
  /**
   * Where the approach cue is timed against (fraction): the reference's brake
   * point when the corner has one, else entryD. The service speaks the cue so
   * it ENDS before the car gets here.
   */
  cueD?: number;
  /**
   * The approach cue, at most 8 words, speakable, said on the straight BEFORE
   * the corner: "Corner five, brake ten metres later." Absent = no cue this
   * lap (e.g. the corner was fine last lap).
   */
  approach?: string;
  /** This corner's driver loss on the last valid lap (s), for "still costing". */
  lastLossSec?: number;
  /** The window loss when the corner joined the work list (s), the baseline gains are told against. */
  baselineSec?: number;
  /** Time won back against that baseline (s, + = better), window mean. */
  gainSec?: number;
  /** A second measurable change in the same corner, when one agrees across the window. */
  cue2?: LiveFocusCue;
  /** Position in the work list, 1 = costs most. */
  rank?: number;
}

/* -------------------------------------------------------------------------- */
/*  Output: radio calls                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The engineer kinds the live coach speaks under. Each is added to
 * radioGate.ts KIND_URGENCY (all 'normal' — never through a braking zone,
 * never through "keep quiet") and engineer.js TRIGGER_TIERS.
 */
export type LiveCoachKind =
  | 'coachFocus'
  | 'coachProgress'
  | 'coachConsistency'
  | 'coachSummary'
  /** v2: said on the straight before a work-list corner. Never late: dropped if it cannot finish before {@link LiveFocus.cueD}. */
  | 'coachApproach'
  /** v2: the lap-end line: what got better this lap, what is still costing. */
  | 'coachLapDebrief'
  /** v2: the run debrief: improved this, this and this; still to work on that and that. In-lap, pit entry, or asked for. */
  | 'coachRunDebrief';

export const LIVE_COACH_KINDS: readonly LiveCoachKind[] = [
  'coachFocus',
  'coachProgress',
  'coachConsistency',
  'coachSummary',
  'coachApproach',
  'coachLapDebrief',
  'coachRunDebrief',
];

/**
 * v2: how long a held coachApproach may wait for the channel before it is
 * dropped, ms. Short on purpose: an approach cue said after the braking point
 * is worse than none. radioGate.ts uses this as a per-kind hold override.
 */
export const APPROACH_HOLD_MS = 1500;

export interface LiveCoachCall {
  kind: LiveCoachKind;
  /** One or two short sentences, speakable (no "C4", no "Δ", numbers in words where Piper needs it). */
  text: string;
  priority: number;
}

/* -------------------------------------------------------------------------- */
/*  Engine state                                                              */
/* -------------------------------------------------------------------------- */

/** Plain JSON: the service may keep it across a loading screen within the session. */
export interface LiveCoachState {
  sessionKey: string;
  validLaps: number;
  /** The last `windowLaps` valid laps' per-corner driver loss (s), newest last. */
  recent: { lapNo: number; lapSec: number; byCorner: Record<string, number> }[];
  focus: LiveFocus | null;
  /**
   * v2: the work list, costliest first, at most maxWork. `focus` stays equal
   * to work[0] (or null) so v1 readers keep working. Optional: a v1 state
   * reads as [focus].
   */
  work?: LiveFocus[];
  /**
   * v2: corners fixed or clearly improved THIS RUN (since the last pit stop /
   * run debrief), with the time won back: what the run debrief says first.
   */
  runImproved?: { cornerId: string; gainSec: number }[];
  /** v2: valid-lap count when the current run started (after the last pit / debrief). */
  runStartLap?: number;
  /** Corners already fixed this session, so the coach moves on and does not nag. */
  fixed: string[];
  /** Valid-lap count at the last consistency call / last summary request. */
  lastConsistencyAt: number;
  lastSummaryAt: number;
  refLapId: string | null;
}

export interface LiveCoachStep {
  state: LiveCoachState;
  calls: LiveCoachCall[];
  focus: LiveFocus | null;
  /** True when the service should ask the AI for a summary now ({@link LiveCoachOptions.summaryEvery}). */
  wantSummary: boolean;
  /** v2: the work list after this lap (same as state.work). */
  work?: LiveFocus[];
}

/**
 * v2: where the car is, for the approach cue. From the frame: lap fraction
 * (trackMap.cars[player].lapFraction, ~7 Hz, or player.ghost.atD when live),
 * speed, the lap number, and whether it is in the pit lane.
 */
export interface LiveCoachPosition {
  lapD: number;
  speedKph: number;
  lapNo: number;
  inPit: boolean;
  trackLengthM: number;
}

/** v2: one approach cue to say now. */
export interface LiveApproachCue {
  cornerId: string;
  text: string;
  /** Seconds until the car reaches cueD at its current speed. */
  etaSec: number;
}

/**
 * v2: the run debrief as templates (always available; the AI may rewrite it).
 * `improved` and `still` name corners; `text` is at most 3 speakable sentences.
 */
export interface LiveRunDebrief {
  improved: { cornerId: string; gainSec: number }[];
  still: { cornerId: string; lossSec: number; what: string }[];
  text: string;
  laps: number;
}

/** The engine's entry points (liveCoach.ts implements these). */
export interface LiveCoachEngine {
  initLiveCoach(sessionKey: string): LiveCoachState;
  stepLiveCoach(state: LiveCoachState, lap: LiveCoachLap, opts?: LiveCoachOptions): LiveCoachStep;
  /**
   * v2, pure: the approach cue to say NOW, or null. `cued` = corner ids
   * already cued on this lap (the service keeps it, cleared at the line). Fires
   * when the car is heading for a work-list corner with an `approach` line,
   * ETA to cueD between the time the words take (+ lead) and a few seconds
   * more, not in the pit, above a crawl.
   */
  approachCueAt?(state: LiveCoachState, pos: LiveCoachPosition, cued: readonly string[], opts?: LiveCoachOptions): LiveApproachCue | null;
  /** v2, pure: the run debrief so far (since runStartLap). Null before minLaps. */
  runDebrief?(state: LiveCoachState): LiveRunDebrief | null;
  /** v2, pure: start a new run (after a pit stop / a debrief was said). */
  startRun?(state: LiveCoachState): LiveCoachState;
}

/* -------------------------------------------------------------------------- */
/*  To the overlay: frame.player.coach                                        */
/* -------------------------------------------------------------------------- */

/**
 * Published by the service on every frame while a practice session with the
 * live coach on is running; ABSENT otherwise (the widget hides). Small: no
 * traces, no history.
 */
export interface LiveCoachOverlay {
  focus: Pick<LiveFocus, 'cornerId' | 'cornerNo' | 'entryD' | 'apexD' | 'exitD' | 'lossSec' | 'short' | 'status'> | null;
  /**
   * v2: the work list for the card (same subset + gain/rank), costliest first.
   * The card shows the NEXT one the car is heading for as the big line and the
   * others as small chips. Optional: absent = v1 (focus only).
   */
  work?: (Pick<LiveFocus, 'cornerId' | 'cornerNo' | 'entryD' | 'apexD' | 'exitD' | 'lossSec' | 'short' | 'status'> &
    Pick<LiveFocus, 'gainSec' | 'rank' | 'cueD'>)[];
  /** v2: corners improved this run, for a small "C4 better by 0.2" row. */
  improved?: { cornerId: string; cornerNo: number; gainSec: number }[];
  /** Valid laps counted; the card says "Learning your laps…" until minLaps. */
  validLaps: number;
  minLaps: number;
  /** The last lap's time and its delta to the reference (s; + = slower), for a small footer. */
  lastLapSec: number | null;
  lastDeltaSec: number | null;
  refKind: LiveCoachLap['refKind'];
  /** Bumped whenever focus changes, so the widget can flash once. */
  rev: number;
}

/* -------------------------------------------------------------------------- */
/*  To the voice: questions and the AI summary                                */
/* -------------------------------------------------------------------------- */

/** Everything a question about the session so far can be answered from. */
export interface LiveCoachSnapshot {
  state: LiveCoachState;
  /** The latest valid lap's breakdown, and the last lap whatever it was. */
  lastValid: LiveCoachLap | null;
  last: LiveCoachLap | null;
  trackLengthM: number;
}

/** liveCoachVoice.ts implements these; the service and engineer.js call them. */
export interface LiveCoachVoice {
  /**
   * The driver's words → an answer, or null when the words are not a coach
   * question ("how was that lap", "where am I losing time", "what about
   * corner seven", "what should I work on"). Null snapshot = not in a
   * practice session with the coach on: answer that plainly.
   */
  answerCoachQuestion(text: string, snap: LiveCoachSnapshot | null): string | null;
  /** The AI request for an every-few-laps summary, from the same facts the Practice tab uses. */
  summaryFacts(snap: LiveCoachSnapshot): { facts: { id: string; text: string }[]; prompt: string };
  /** The AI's reply → a speakable summary (≤ 2 sentences), or null to fall back to silence. */
  speakableSummary(reply: unknown, snap: LiveCoachSnapshot): string | null;
  /**
   * v2: the run debrief's AI request (facts from {@link LiveRunDebrief} plus
   * the snapshot), in the same shape the service already sends for the
   * summary. Optional.
   */
  debriefRequest?(debrief: LiveRunDebrief, snap: LiveCoachSnapshot, ctx: unknown): unknown;
  /** v2: the AI's reply → at most 3 speakable sentences naming only corners in the debrief, or null (say the template). */
  speakableDebrief?(reply: unknown, debrief: LiveRunDebrief, snap: LiveCoachSnapshot): string | null;
}
