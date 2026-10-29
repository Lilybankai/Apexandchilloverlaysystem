/**
 * coachContract.ts — the shapes the AI driving coach is built from.
 * =============================================================================
 *
 * 2026-10-29, Carl: a coach that says where a lap loses time, in which part of
 * which corner, why, and what to change (in answer to Delta's Auto Insights
 * 2.0). Several pieces are built in parallel and meet here:
 *
 *   - `cornerCatalog.ts`   stable corners per layout (C1..Cn that keep their
 *                          number from session to session);
 *   - `cornerPhases.ts` + `timeLoss.ts` + `cornerSequences.ts`
 *                          a lap against a reference, split per corner and
 *                          per phase, exactly additive (→ LapLossBreakdown);
 *   - `fairTarget.ts`      whether a comparison lap is a fair one to chase
 *                          (→ FairnessFlag);
 *   - `coachReport.ts`     the words: template sentences from the numbers,
 *                          plus the optional AI narrative (→ CoachReport);
 *   - `drivingHabits.ts`   the same numbers across laps and sessions.
 *
 * Types only — nothing here runs. Units and signs are pinned once, here:
 *
 *   - Distances along the lap are LAP FRACTIONS 0..1, as everywhere else in
 *     the trace code (`corners.ts`). Metres only where a field says `M`.
 *   - Time: positive = LOSING (the studied lap was slower), as `cornerResult`.
 *   - A braking delta is positive when the studied lap braked LATER.
 *   - A speed delta is positive when the studied lap was FASTER.
 */

/* -------------------------------------------------------------------------- */
/*  Corners                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The parts of a corner, in road order. `exitRun` is full throttle out of
 * the corner up to the next corner's braking point: a slow exit costs most of
 * its time on the straight after it, and without this phase about a third of
 * a lap's loss belonged to no corner.
 */
export type CoachPhase = 'braking' | 'turnIn' | 'midCorner' | 'exit' | 'exitRun';

export const COACH_PHASES: readonly CoachPhase[] = ['braking', 'turnIn', 'midCorner', 'exit', 'exitRun'];

/** One corner of a layout as the catalogue keeps it. */
export interface CatalogCorner {
  /** 'C1'..'Cn', in lap order. Stable for the layout: never renumbered by one lap. */
  id: string;
  entryD: number;
  apexD: number;
  exitD: number;
  /** Which way it turns; null when only found by speed. */
  dir: 'L' | 'R' | null;
  /** Id of the sequence (linked corners: chicanes, esses) this corner belongs to, if any. */
  seq: string | null;
}

export interface CornerCatalog {
  /** The track map key (layout + length), as `data/trackmaps`. */
  mapKey: string;
  trackLengthM: number;
  /** How many laps voted. */
  builtFrom: number;
  corners: CatalogCorner[];
  /** Linked corners, in lap order. */
  sequences: { id: string; cornerIds: string[]; kind: 'chicane' | 'complex' }[];
}

/** Where things happened through one corner on one lap. Lap fractions; null = not found. */
export interface PhasePoints {
  brakeOnD: number | null;
  brakeOffD: number | null;
  turnInD: number | null;
  apexD: number | null;
  pickupD: number | null;
  fullThrottleD: number | null;
  entryKph: number | null;
  minKph: number | null;
  exitKph: number | null;
  /** Speed where the exit run meets the next braking point (the end of the straight). */
  topKph: number | null;
}

/** One corner of a studied lap against a reference lap. */
export interface CornerPhaseLoss {
  /** The catalogue id when the layout has one, else C(index+1) off the reference. */
  id: string;
  index: number;
  /** Boundaries on the REFERENCE lap (they are what makes the split additive). */
  entryD: number;
  apexD: number;
  exitD: number;
  /** End of the exit run: the next corner's brake onset (or entry). */
  runEndD: number;
  /** Studied − reference, entry → runEnd. Positive = losing. Equals the sum of `phases`. */
  lossSec: number;
  phases: Record<CoachPhase, number>;
  mine: PhasePoints;
  ref: PhasePoints;
  /**
   * Loss on the exit run that is NOT the driver's: the gap grew along the
   * straight at equal throttle with no worse exit — a tow ('tow') or a car /
   * setup with more straight-line speed ('car'). Coaching leaves it out.
   */
  straightFlag: null | 'tow' | 'car';
  straightSec: number;
}

export interface CornerSequence {
  cornerIds: string[];
  /** Studied − reference over the whole sequence. */
  lossSec: number;
  /**
   * 'trade': gave time in one corner to win it back in the next (coach the
   *   total, not the halves); 'carry': a loss early in the sequence carried
   *   through it; 'linked': neither, but they are one piece of road.
   */
  kind: 'trade' | 'carry' | 'linked';
}

/** A whole lap against its reference, per corner and per phase. */
export interface LapLossBreakdown {
  lapId: string;
  refLapId: string;
  corners: CornerPhaseLoss[];
  sequences: CornerSequence[];
  /** Before the first corner's entry (start of the lap). */
  leadInSec: number;
  /** Sum of every segment (leadIn + every corner's lossSec). */
  totalSec: number;
  /** Official lap delta minus `totalSec`: trace clock vs timing, shown, never hidden. */
  residualSec: number;
}

/* -------------------------------------------------------------------------- */
/*  Fair targets                                                              */
/* -------------------------------------------------------------------------- */

export interface FairnessFlag {
  kind: 'fuel' | 'trackTemp' | 'airTemp' | 'tow' | 'car' | 'compound' | 'session' | 'energy' | 'condition';
  /** 'info' = mention it; 'warn' = a chip on the target; 'drop' = not picked automatically. */
  severity: 'info' | 'warn' | 'drop';
  /** Short words for a chip, e.g. "≈0.4 s of the gap is fuel". */
  text: string;
  /** Estimated seconds of the gap this explains, when it can be estimated. */
  estSec?: number;
}

/* -------------------------------------------------------------------------- */
/*  Words                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One number the coach may talk about. Template sentences are made from these
 * and the AI may only CITE them by id — it never types a number itself; the
 * panel fills numbers in from the cited facts.
 */
export interface CoachFact {
  id: string;
  cornerId?: string;
  phase?: CoachPhase;
  /** e.g. 'phaseLoss', 'brakeDeltaM', 'minKphDelta', 'pickupDeltaM', 'sectorLoss', 'consistency'. */
  kind: string;
  value: number;
  unit: 's' | 'm' | 'kph' | '%' | 'C' | 'L' | 'pts' | 'laps';
  /** The template sentence for this fact on its own. */
  text: string;
}

export interface CoachTakeaway {
  title: string;
  body: string;
  /** A short pill: "≈0.45 s total", "0.32 s potential", "Aim for 3:37.8". */
  chip: string;
  tone: 'loss' | 'potential' | 'target';
  cornerIds: string[];
  factIds: string[];
}

/** A corner worth working on, for "Where time is lost". */
export interface CoachCornerItem {
  id: string;
  /** Mean loss per valid lap against the reference. Positive = losing. */
  lossSec: number;
  priority: 'high' | 'medium' | 'low';
  /** The phase most of the loss sits in. */
  phase: CoachPhase;
  tip: string;
  /** 0..1: how consistent the loss is across laps (one bad lap is not a habit). */
  confidence: number;
  /** Loss in this corner on every lap of the session, lap order; null = not scored. */
  perLapSec: (number | null)[];
  factIds: string[];
}

export interface CoachReport {
  /** Bump when the shape or the template wording changes (cache key). */
  version: number;
  scope: 'session' | 'lap';
  sessionId: string;
  lapId: string | null;
  source: 'template' | 'ai';
  headline: string;
  takeaways: CoachTakeaway[];
  worst: CoachCornerItem[];
  sequences: CornerSequence[];
  /** A realistic next target: the theoretical best, or best + what the top items are worth. */
  aimForSec: number | null;
  fairness: FairnessFlag[];
  facts: CoachFact[];
  generatedAt: string;
}

/** What `coach:ai` sends the cloud and gets back (see supabase/functions/coach). */
export interface CoachAiRequest {
  kind: 'session' | 'lap' | 'habits';
  /** Cache key: same input → the stored answer, no new model call. */
  inputHash: string;
  context: { track: string; car: string; carClass: string; targetLabel: string; lapSec: number | null; refSec: number | null };
  facts: CoachFact[];
}

export interface CoachAiResult {
  headline: string;
  takeaways: { title: string; body: string; factIds: string[]; cornerIds: string[] }[];
  sequences: { cornerIds: string[]; narrative: string; factIds: string[] }[];
}

/* -------------------------------------------------------------------------- */
/*  Show me                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A point to draw on the lap map and the channel charts
 * (`review-charts.js` `drawLapMap` / `drawChannels`, `opts.marks`).
 * `x`/`z` when the lap carries a line; otherwise the chart places it on the
 * centreline at `d`, as the cursor already does.
 */
export interface ShowMark {
  d: number;
  x?: number | null;
  z?: number | null;
  kind: 'brake' | 'turnin' | 'apex' | 'throttle' | 'full';
  who: 'you' | 'ref';
  label?: string;
}

/** An arrow along the studied lap's line, from one distance to another: "brake 12 m later". */
export interface ShowArrow {
  fromD: number;
  toD: number;
  label: string;
}

/** One step of "Show me": a stretch of road, what to draw on it, and the words. */
export interface ShowStep {
  cornerId: string;
  window: [number, number];
  marks: ShowMark[];
  arrows: ShowArrow[];
  text: string;
}

/* -------------------------------------------------------------------------- */
/*  Your driving                                                              */
/* -------------------------------------------------------------------------- */

export interface HabitsReport {
  trackKey: string;
  carClass: string;
  sessions: number;
  laps: number;
  /** Per session, oldest first. */
  trend: { sessionId: string; at: string; bestSec: number | null; avgSec: number | null; spreadSec: number | null; accuracy: number | null; refPct: number | null }[];
  /** Per catalogue corner: how the driver habitually drives it. */
  corners: { id: string; laps: number; brakeSpreadM: number | null; minKphSpread: number | null; avgLossSec: number | null; habit: string | null }[];
  /** Whole-lap habits: coasting %, brake/throttle overlap, trail braking, aids. */
  lap: { kind: string; value: number; unit: string; text: string }[];
  facts: CoachFact[];
}
