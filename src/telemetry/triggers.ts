/**
 * @file src/telemetry/triggers.ts
 * @module telemetry/triggers
 *
 * **When the race engineer speaks.** The edge-detection and debounce layer that
 * decides which moments in a session are worth one calm line on the radio — and,
 * far more often, that this moment is not one of them.
 *
 * This is Phase 0 of the race-engineer feature and it deliberately contains no
 * network, no model, no prompt and no words. It answers exactly one question:
 * *should the engineer say something right now, and about what*. Everything
 * downstream — the summary builder, the cloud proxy, the voice — is a separate
 * concern that can be built and replaced without touching this file, and this
 * file can be tuned against real races before a single token is spent
 * (`scripts/test-triggers.js`, including its `--replay` mode).
 *
 * ## The rule that makes the whole feature affordable: never per frame
 * The overlay's brief is to stay light on a streaming PC, and the single design
 * decision that keeps this feature inside that brief is that it fires on
 * discrete **edges** in state, not on frames. The 30 Hz loop already does the
 * hard work — reading the sim, computing fuel, tracking penalties — so all this
 * does per tick is a handful of scalar compares against the previous tick, with
 * no allocation on the path where nothing happened. A cue object is built only
 * at the instant one is actually emitted, which on a clean race is a few times
 * an hour.
 *
 * That is also what pins the eventual API cost near zero: a trigger layer that
 * cannot fire per frame cannot run up a bill per frame.
 *
 * ## Four separate gates, because one shunt is not twenty radio calls
 * A crash reads as "damaged" for several seconds and a safety car churns the
 * flag state; a naive detector turns each into a burst. So a candidate has to
 * pass all of:
 *
 *   1. **Edge only** — the transition, never the level. `false → true` fires;
 *      `true` sitting there does not.
 *   2. **Per-trigger cooldown** — the same kind cannot fire again for
 *      {@link DEFAULT_COOLDOWN_MS} (overridden per kind in {@link COOLDOWN_MS}),
 *      so a car grinding down the barrier is one call, not eight.
 *   3. **Coalesce window** — candidates are buffered for
 *      {@link DEFAULT_COALESCE_MS} and emitted as one cue carrying the whole
 *      set, priority-ordered. Contact, a penalty and a position loss inside two
 *      seconds are one thing that happened, and a real engineer says it in one
 *      sentence.
 *   4. **Global minimum interval** — at most one cue every
 *      {@link DEFAULT_GLOBAL_MIN_INTERVAL_MS}, whatever fired.
 *
 * ## Held lines expire rather than queue
 * When the global gate is shut, buffered candidates are held — but only for
 * {@link DEFAULT_MAX_HOLD_MS}. After that they are dropped and counted in
 * {@link TriggerStats}. This is the one place where a queue would have been the
 * obvious implementation and the wrong one: an engineer telling you about
 * contact twenty-five seconds after you felt it is not late information, it is
 * wrong information, and it arrives while you are dealing with whatever came
 * next. Silence is the better failure.
 *
 * ## Priming, and why nothing fires on the first frame
 * Every detector needs the previous value, so the first frame after a reset only
 * records levels. Without that rule, attaching the overlay to a car that already
 * has damage would announce the damage — the driver knows, they were there — and
 * every session would open with a burst of phantom edges.
 *
 * A session change ({@link sessionKeyOf}) resets everything, for the same reason
 * `trackLimits.ts` does: a penalty served in qualifying is not news in the race.
 */

import { UNKNOWN_VALUE, isPreGreen } from './types';
import type { SessionPhase, StandingEntry, TelemetryFrame } from './types';
import {
  deltaToReferencePaceTarget,
  referencePaceTargets,
} from './paceTargets';

/* -------------------------------------------------------------------------- */
/*  What the engineer can be told about                                        */
/* -------------------------------------------------------------------------- */

/**
 * The kinds of moment worth a radio call.
 *
 * Deliberately a closed, short list. Every entry here is a **state change the
 * telemetry can prove**, which is the same line the feature's remit draws: the
 * engineer comments on what it can see. There is no `slowPace` or `rivalPitted`
 * kind, not because they would be hard to detect but because acting on them
 * means asserting a strategy we cannot verify.
 */
export type EngineerTriggerKind =
  /** The race has gone green from the grid, the formation lap or the countdown. */
  | 'raceStart'
  /** A full-course yellow / safety car has been called. */
  | 'fullCourseYellow'
  /** The session has been red-flagged. */
  | 'redFlag'
  /** Racing has resumed after a full-course yellow or a red flag. */
  | 'restart'
  /** A LOCAL yellow appeared in one or more sectors (not a full-course yellow). */
  | 'sectorYellow'
  /** Every local yellow has cleared — the whole lap is green again. */
  | 'sectorClear'
  /** The car has picked up damage it did not have. */
  | 'incident'
  /** The sim has issued a penalty. */
  | 'penalty'
  /** The sim's penalty count came back down — one has been discharged. */
  | 'penaltyServed'
  /** Fuel or energy is down to the last few laps; the pit window is here. */
  | 'fuelWindow'
  /** Come in at the end of this lap or you will not get back (`fuel.pitThisLap`). */
  | 'fuelCritical'
  /** The white flag — last lap. */
  | 'finalLap'
  /** The chequered flag. */
  | 'checkered'
  // Standard-preset kinds (v3, 2026-08-19) — the race-story layer. Same law as
  // the rest: a state change the telemetry can prove, never an inference.
  /** The player's best lap improved on a previous best (never the first best). */
  | 'fastestLapSelf'
  /** The field's fastest lap changed OWNER — not merely improved. */
  | 'fastestLapField'
  /** The player's overall position stepped, outside lap 1 and pit cycles. */
  | 'positionChange'
  /** The class neighbour directly ahead or behind entered the pit lane. */
  | 'rivalPitted'
  /** The current lap reached the fuel calculator's pit-window-open lap. */
  | 'pitWindowOpen'
  /** A faster-class car with the right of way is closing — blue flags coming. */
  | 'yieldTo'
  /** Practice benchmark established, improved into a new band, or due for a check. */
  | 'practicePace';

/**
 * Relative importance, higher wins. Used to order a coalesced cue and to choose
 * its leading kind, so a cue that carries both contact and a penalty leads with
 * the contact — which is what the driver is dealing with in that second.
 *
 * The ordering is the plan's: red flag > full-course yellow > incident > penalty
 * > pit/fuel > everything else.
 */
export const TRIGGER_PRIORITY: Readonly<Record<EngineerTriggerKind, number>> = {
  redFlag: 100,
  fullCourseYellow: 90,
  incident: 85,
  sectorYellow: 80, // timely: the driver may be arriving at it this corner
  penalty: 75,
  fuelCritical: 70,
  checkered: 65,
  finalLap: 60,
  penaltyServed: 55,
  restart: 50,
  sectorClear: 48, // worth saying promptly — the driver can push again
  yieldTo: 47, // timely: the faster car is arriving NOW
  raceStart: 45,
  fuelWindow: 40,
  pitWindowOpen: 38,
  fastestLapSelf: 30,
  fastestLapField: 28,
  positionChange: 25,
  rivalPitted: 22,
  practicePace: 20,
};

/**
 * Kinds that can only meaningfully happen once in a session. A second "race
 * start" is always a detector artefact — a flag state flickering, a feed
 * dropping and recovering — never a second start.
 *
 * The red flag is pointedly NOT in here: a session can be stopped twice.
 */
const ONCE_PER_SESSION: ReadonlySet<EngineerTriggerKind> = new Set<EngineerTriggerKind>([
  'raceStart',
  'finalLap',
  'checkered',
]);

/**
 * Kinds that only make sense in a **race**. Fuel, damage and penalties matter in
 * any session — a driver burning a set of tyres in practice still wants to know
 * they picked up damage — but a "green flag, P7, 24 cars" call during a
 * qualifying out-lap is noise, and there is no last lap of a practice session.
 */
const RACE_ONLY: ReadonlySet<EngineerTriggerKind> = new Set<EngineerTriggerKind>([
  'raceStart',
  'finalLap',
  'checkered',
  'restart',
  // The race-story kinds: fastest laps change owner constantly in qualifying,
  // positions shuffle all session in practice, and a rival's stop only means
  // something when there is a race to undercut. Blue-flag traffic (yieldTo) is
  // pointedly NOT here — a faster class arriving matters in any session.
  'fastestLapSelf',
  'fastestLapField',
  'positionChange',
  'rivalPitted',
  'pitWindowOpen',
]);

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** How long candidates are buffered before being emitted as one cue, ms. */
export const DEFAULT_COALESCE_MS = 1500;

/** Default per-kind cooldown, ms — the same kind cannot re-fire inside it. */
export const DEFAULT_COOLDOWN_MS = 30_000;

/** At most one cue this often, ms, whatever fired. */
export const DEFAULT_GLOBAL_MIN_INTERVAL_MS = 15_000;

/**
 * How long a candidate may sit waiting for the global gate before it is dropped,
 * ms. See the module note on why this is not a queue.
 */
export const DEFAULT_MAX_HOLD_MS = 4_000;

/** Laps of fuel/energy left at which the pit window is called. */
export const DEFAULT_FUEL_WINDOW_LAPS = 3;

/** Completed practice laps between unchanged reference-pace reminders. */
export const DEFAULT_PRACTICE_PACE_LAP_INTERVAL = 4;

/**
 * How long a new position must HOLD before it is announced, ms. The 2026-08-19
 * race replay showed the standings flickering a driver from P1 to P25 for a
 * few frames — a feed artefact, not an overtake. A real change of position
 * survives 2.5 s; a glitch (or the churn mid-incident) does not, and the
 * settled outcome is announced once instead of every intermediate shuffle.
 */
export const POSITION_SETTLE_MS = 2500;

/**
 * Per-kind cooldown overrides. The shapes differ: damage keeps reading damaged
 * for as long as the car is bent, so its cooldown is about not re-announcing the
 * same shunt; fuel moves over minutes, so a second fuel call inside a minute is
 * always the same news twice.
 */
const COOLDOWN_MS: Readonly<Partial<Record<EngineerTriggerKind, number>>> = {
  incident: 25_000,
  penalty: 20_000,
  penaltyServed: 20_000,
  fuelWindow: 90_000,
  fuelCritical: 60_000,
  fullCourseYellow: 30_000,
  restart: 30_000,
  // Local yellows come and go in seconds (both live probes cleared inside 7 s);
  // a long cooldown here would eat the NEXT incident's call, not repeats of
  // this one — the pending-dedupe already handles the same edge twice.
  sectorYellow: 15_000,
  sectorClear: 15_000,
  // The race-story kinds are lower-stakes, so they get LONGER cooldowns — a
  // position swap fight should be one call, not a commentary stream.
  fastestLapSelf: 20_000, // can't re-fire before the next lap anyway
  fastestLapField: 30_000,
  positionChange: 45_000,
  rivalPitted: 30_000,
  pitWindowOpen: 60_000,
  yieldTo: 60_000,
  practicePace: 90_000,
};

/**
 * How far {@link DamageState.worst} has to JUMP between two consecutive frames
 * before it counts as a second impact, `0..1`.
 *
 * A jump rather than a level ("worse than when I last spoke") on purpose: a level
 * stays true, so it would re-announce the moment the cooldown expired — telling
 * the driver their car is worse than they thought half a minute after they hit
 * the wall. An impact is a step change, and a step change is an edge.
 */
const DAMAGE_WORSENED_STEP = 0.15;

/** Tunables, all optional — anything omitted takes the default above. */
export interface EngineerTriggerConfig {
  /** Buffer window before a cue is emitted, ms. */
  coalesceMs?: number;
  /** Default per-kind cooldown, ms. */
  cooldownMs?: number;
  /** Minimum gap between cues of any kind, ms. */
  globalMinIntervalMs?: number;
  /** How long a held candidate stays fresh, ms. */
  maxHoldMs?: number;
  /** Laps of fuel remaining that opens the pit-window call. */
  fuelWindowLaps?: number;
  /** Completed practice laps between unchanged reference-pace reminders. */
  practicePaceLapInterval?: number;
  /**
   * Whether frames with `connected: false` are ignored. On by default: those are
   * the simulator's placeholder frames, and an engineer talking over demo data
   * would be talking about a car nobody is driving. The replay harness turns it
   * off when replaying a recording made from the simulator.
   */
  ignoreDisconnected?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  What comes out                                                             */
/* -------------------------------------------------------------------------- */

/** One detected edge, before any coalescing. */
export interface EngineerTrigger {
  /** Which kind of moment this is. */
  kind: EngineerTriggerKind;
  /** Frame time at which the edge was detected, ms. */
  atMs: number;
  /** {@link TRIGGER_PRIORITY} for this kind, copied so consumers need not look it up. */
  priority: number;
  /**
   * A short factual phrase describing the edge — `"contact, damage now moderate"`.
   *
   * This is **not** what the engineer says. It is the tuning log's rendering of
   * what was detected, and the raw material the P2 summary builder will turn into
   * a prompt. Keeping the two apart is what lets this layer be judged on whether
   * it fired at the right moment, separately from whether the words were good.
   */
  detail: string;
  /**
   * Machine-readable facts about this specific edge, deliberately small and
   * already bucketed where a raw number would be noise (damage severity is
   * `"light"`/`"moderate"`/`"heavy"`, not `0.37`).
   */
  facts: Readonly<Record<string, string | number | boolean>>;
}

/** The race-wide context a cue is emitted into — read once, at emit time. */
export interface EngineerCueContext {
  /** Session category, e.g. `"race"`. */
  sessionType: string;
  /** Session phase at the moment of the cue. */
  phase: SessionPhase;
  /** Global flag at the moment of the cue. */
  flag: string;
  /** Track name as the sim gave it. */
  track: string;
  /** Overall race position, or {@link UNKNOWN_VALUE}. */
  position: number;
  /** Position within the player's class, or {@link UNKNOWN_VALUE}. */
  classPosition: number;
  /** Canonical class label, or `""` when unknown. */
  carClass: string;
  /** Cars in the session. */
  numCars: number;
  /** Leader's lap, or {@link UNKNOWN_VALUE}. */
  currentLap: number;
  /** Laps still to run, or {@link UNKNOWN_VALUE}. */
  lapsRemaining: number;
}

/**
 * One moment the engineer should speak about — the unit this layer produces, and
 * the unit P1/P2 will turn into a request and a line of speech.
 */
export interface EngineerCue {
  /** Frame time the cue was emitted, ms. */
  atMs: number;
  /** The highest-priority kind in {@link triggers} — what the line should lead with. */
  kind: EngineerTriggerKind;
  /** Every edge folded into this cue, highest priority first, at least one. */
  triggers: EngineerTrigger[];
  /** Race-wide context at the moment of the cue. */
  context: EngineerCueContext;
  /**
   * The tuning log's one-line rendering of the whole cue. Again: not the
   * engineer's words — see {@link EngineerTrigger.detail}.
   */
  line: string;
}

/** Why a candidate never became a cue. */
export type SuppressionReason = 'cooldown' | 'once' | 'sessionType' | 'global' | 'stale';

/**
 * Running counts, for tuning. The suppressions matter more than the fires: a
 * replay whose `global` count is high is telling you the minimum interval is
 * eating real news, and one whose `cooldown` count is high is telling you the
 * detector is chattering.
 */
export interface TriggerStats {
  /** Frames seen since the last reset. */
  frames: number;
  /** Cues emitted, by kind. */
  fired: Partial<Record<EngineerTriggerKind, number>>;
  /** Total cues emitted. */
  cues: number;
  /** Candidates suppressed, by reason. */
  suppressed: Record<SuppressionReason, number>;
}

/* -------------------------------------------------------------------------- */
/*  Session identity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * An identity for the session a frame belongs to. Changing it wipes the
 * detector's memory.
 *
 * Track + session type + car count, because those are the three things that
 * cannot stay the same across a session boundary in practice, and none of them
 * flickers within one. Deliberately not the lap or the clock — both move
 * constantly, and a key that changes mid-session would reset the detector every
 * tick and therefore never fire anything.
 */
export function sessionKeyOf(frame: TelemetryFrame): string {
  return `${frame.source}|${frame.session.track}|${frame.session.type}|${frame.session.numCars}`;
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** `true` when a numeric channel actually carries a value. */
function known(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n !== UNKNOWN_VALUE;
}

/**
 * Damage severity in the three words a driver would use. Bucketed here rather
 * than passed through as `0..1` because the difference between 0.31 and 0.34 is
 * not a thing anyone can act on, and a stable label is what stops a prompt (and
 * a log) churning while a number wobbles.
 */
function damageBucket(worst: number): string {
  if (worst >= 0.5) return 'heavy';
  if (worst >= 0.2) return 'moderate';
  return 'light';
}

/**
 * Laps left on whichever budget is **tighter**. LMU cars run a fuel tank and a
 * virtual-energy allowance at the same time and either can be the binding one —
 * the driver has to pit for whichever runs out first, so that is the one the
 * window is measured against. `Infinity` when neither is published.
 */
function tighterFuelLaps(frame: TelemetryFrame): number {
  const fuel = frame.fuel;
  if (!fuel) return Infinity;
  const byFuel = known(fuel.lapsRemaining) ? fuel.lapsRemaining : Infinity;
  const byEnergy = known(fuel.virtualEnergyLapsRemaining)
    ? fuel.virtualEnergyLapsRemaining
    : Infinity;
  return Math.min(byFuel, byEnergy);
}

/** The player's row in the standings, when there is one. */
function playerRow(frame: TelemetryFrame): StandingEntry | undefined {
  return frame.standings?.find((s) => s.isPlayer);
}

interface PracticePaceRead {
  lap: number;
  percent: number;
  band: string;
  facts: Record<string, string | number | boolean>;
}

/**
 * The compact, fully resolved benchmark a practice call can safely speak.
 * Test days share practice semantics; qualifying is excluded because this table
 * is explicitly race pace and a hotlap session needs different coaching.
 */
function practicePaceRead(frame: TelemetryFrame): PracticePaceRead | null {
  if (frame.session.type !== 'practice' && frame.session.type !== 'testday') return null;
  const score = frame.player?.paceScore;
  if (
    !score?.ok ||
    !known(score.percent) ||
    !known(score.lapSec) ||
    !known(score.refSec) ||
    !score.bandLabel
  ) {
    return null;
  }
  const me = playerRow(frame);
  const lap = me && known(me.lapsCompleted)
    ? me.lapsCompleted
    : known(frame.session.currentLap)
      ? frame.session.currentLap
      : UNKNOWN_VALUE;
  if (!known(lap) || lap <= 0) return null;

  const targets = referencePaceTargets(score);
  const facts: Record<string, string | number | boolean> = {
    lapSec: Math.round(score.lapSec * 10) / 10,
    percent: Math.round(score.percent * 10) / 10,
    band: score.bandLabel,
    alienSec: Math.round(score.refSec * 10) / 10,
  };
  const alienDelta = deltaToReferencePaceTarget(score, targets.alien);
  const competitiveDelta = deltaToReferencePaceTarget(score, targets.competitive);
  if (alienDelta !== null) facts.deltaAlienSec = alienDelta;
  if (targets.competitive) facts.competitiveSec = targets.competitive.lapSec;
  if (competitiveDelta !== null) facts.deltaCompetitiveSec = competitiveDelta;
  if (score.layoutName) facts.layout = score.layoutName;
  if (score.sheetClass) facts.paceClass = score.sheetClass;
  return { lap, percent: score.percent, band: score.bandLabel, facts };
}

/** This frame's race-story levels — computed once, compared and then stored. */
interface RaceStoryLevels {
  /** Holder of the class fastest lap, when anyone has set one. */
  holder: StandingEntry | null;
  /** The class neighbours' pit state, keyed by slot. */
  neighbourPit: Map<number, { inPit: boolean; name: string; where: 'ahead' | 'behind' }>;
  /** Whether any relative row carries the right of way. */
  yieldAny: boolean;
  /** The closest such car, for the call. */
  nearestYield: { name: string; gapSec: number } | null;
  /** Whether the strategy pit window reads as open. */
  windowOpen: boolean;
}

/**
 * One pass over standings + relative for everything the race-story detectors
 * compare. Shared by detection and by priming, so attaching mid-race seeds the
 * same baselines a running detector would hold — an edge needs a *before*, and
 * a missing baseline must read as "unknown", never as "everything just changed".
 */
function raceStoryLevels(frame: TelemetryFrame, me: StandingEntry | undefined): RaceStoryLevels {
  let holder: StandingEntry | null = null;
  for (const e of frame.standings) {
    if (!known(e.bestLapSec) || e.bestLapSec <= 0) continue;
    if (me?.carClass && e.carClass !== me.carClass) continue;
    if (!holder || e.bestLapSec < holder.bestLapSec) holder = e;
  }

  const neighbourPit = new Map<number, { inPit: boolean; name: string; where: 'ahead' | 'behind' }>();
  if (me && known(me.classPosition) && me.carClass) {
    for (const dir of [-1, 1] as const) {
      const want = me.classPosition + dir;
      const rival = frame.standings.find(
        (e) => e.carClass === me.carClass && e.classPosition === want,
      );
      if (rival) {
        neighbourPit.set(rival.slotId, {
          inPit: rival.inPit === true,
          name: rival.driverName,
          where: dir === -1 ? 'ahead' : 'behind',
        });
      }
    }
  }

  let yieldAny = false;
  let nearestYield: { name: string; gapSec: number } | null = null;
  for (const r of frame.relative) {
    if (r.yieldTo !== true) continue;
    yieldAny = true;
    if (known(r.relativeGapSec)) {
      const abs = Math.abs(r.relativeGapSec);
      if (!nearestYield || abs < nearestYield.gapSec) {
        nearestYield = { name: r.driverName, gapSec: abs };
      }
    }
  }

  const openLap = frame.fuel?.pitWindowOpenLap;
  const lap = frame.session.currentLap;
  const windowOpen = known(openLap) && known(lap) && lap > 0 && lap >= openLap!;

  return { holder, neighbourPit, yieldAny, nearestYield, windowOpen };
}

/* -------------------------------------------------------------------------- */
/*  The detector                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Watches a stream of {@link TelemetryFrame}s and emits an {@link EngineerCue}
 * on the rare frames that deserve one.
 *
 * Feed it every frame; it returns `null` on almost all of them. Stateful — it
 * holds the previous tick's scalars and the debounce clocks — which is why it is
 * a class, and why it lives here rather than in a provider: one implementation,
 * shared by all three sources, testable headless.
 *
 * ```ts
 * const triggers = new EngineerTriggers();
 * // …in the loop, after the frame is built:
 * const cue = triggers.update(frame);
 * if (cue) console.log(cue.line);   // P1 will send it instead
 * ```
 */
export class EngineerTriggers {
  private readonly coalesceMs: number;
  private readonly cooldownMs: number;
  private readonly globalMinIntervalMs: number;
  private readonly maxHoldMs: number;
  private readonly fuelWindowLaps: number;
  private practicePaceLapInterval: number;
  private readonly ignoreDisconnected: boolean;

  /** Session this detector's memory belongs to; a change wipes it. */
  private sessionKey = '';
  /** `false` until a frame has been seen, so nothing fires on the first one. */
  private primed = false;

  /* ---- previous-tick levels, one per detector ---------------------------- */
  /** Session type of the last frame seen — the {@link RACE_ONLY} gate reads it. */
  private lastSessionType = 'unknown';
  private prevPhase: SessionPhase = 'unknown';
  private prevFlag = '';
  private prevNotStarted = true;
  private prevHasDamage: boolean | undefined;
  /** Last frame's worst-component severity — the baseline a second impact jumps from. */
  private prevDamageWorst = 0;
  private prevPenalties: number = UNKNOWN_VALUE;
  private prevPitThisLap = false;
  /** `true` once the fuel-window call has been made and not yet re-armed. */
  private fuelWindowArmed = true;
  /** `true` once the session has gone green at least once (so green = restart). */
  private seenGreen = false;
  /**
   * Which sectors read yellow last tick — or `null` before the first frame
   * that carries sector data (and through FCY/red, whose blanket yellows are
   * not local news; see {@link detectSessionFlags}). `null` re-primes silently.
   */
  private prevYellowSectors: [boolean, boolean, boolean] | null = null;
  /** Previous frame's `session.finalLap`, for the chequered-flag-shown edge. */
  private prevFinalLap = false;
  /** Previous frame's `player.finished`, for the crossed-the-line edge. */
  private prevFinished = false;

  /* ---- race-story levels (Standard preset, v3) ---------------------------- */
  /** The player's best lap last tick — a decrease is a new personal best. */
  private prevBestSelf: number = UNKNOWN_VALUE;
  /** Who held the field's (class) fastest lap last tick, and at what time. */
  private prevFieldFastest: { slotId: number; sec: number } | null = null;
  /** The last position the engineer announced (or silently absorbed). */
  private posAnnounced: number = UNKNOWN_VALUE;
  /** A position change waiting out {@link POSITION_SETTLE_MS}. */
  private posCandidate: { pos: number; sinceMs: number } | null = null;
  /** The player's pit phase last tick — position swaps during a stop are noise. */
  private prevPitPhase = 'none';
  /** `inPit` for the two class neighbours last tick, keyed by slot. */
  private prevNeighbourPit = new Map<number, boolean>();
  /** Whether any relative row carried `yieldTo` last tick. */
  private prevYieldAny = false;
  /** Whether the strategy window read as open last tick. */
  private prevWindowOpen = false;
  /** Last resolved practice score, for detecting movement into a faster band. */
  private prevPracticePacePercent: number = UNKNOWN_VALUE;
  private prevPracticePaceBand = '';
  /** Completed lap at the last practice benchmark event. */
  private lastPracticePaceLap: number = UNKNOWN_VALUE;

  /* ---- debounce clocks --------------------------------------------------- */
  private lastFiredAt = new Map<EngineerTriggerKind, number>();
  private firedOnce = new Set<EngineerTriggerKind>();
  private lastCueAt = 0;
  private pending: EngineerTrigger[] = [];
  private pendingSince = 0;

  private stats: TriggerStats = freshStats();

  public constructor(config: EngineerTriggerConfig = {}) {
    this.coalesceMs = config.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.globalMinIntervalMs = config.globalMinIntervalMs ?? DEFAULT_GLOBAL_MIN_INTERVAL_MS;
    this.maxHoldMs = config.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
    this.fuelWindowLaps = config.fuelWindowLaps ?? DEFAULT_FUEL_WINDOW_LAPS;
    this.practicePaceLapInterval = DEFAULT_PRACTICE_PACE_LAP_INTERVAL;
    this.setPracticePaceLapInterval(
      config.practicePaceLapInterval ?? DEFAULT_PRACTICE_PACE_LAP_INTERVAL,
    );
    this.ignoreDisconnected = config.ignoreDisconnected ?? true;
  }

  /** Everything counted since the last {@link resetStats}. */
  public getStats(): TriggerStats {
    return {
      frames: this.stats.frames,
      cues: this.stats.cues,
      fired: { ...this.stats.fired },
      suppressed: { ...this.stats.suppressed },
    };
  }

  /** Zero the counters without disturbing the detector's memory. */
  public resetStats(): void {
    this.stats = freshStats();
  }

  /**
   * Change the periodic practice reminder interval without resetting session
   * history. UI settings call this live; invalid direct callers get the default.
   */
  public setPracticePaceLapInterval(laps: number): void {
    this.practicePaceLapInterval = Number.isFinite(laps)
      ? Math.max(1, Math.round(laps))
      : DEFAULT_PRACTICE_PACE_LAP_INTERVAL;
  }

  /**
   * Forget the session — every level, clock and held candidate. Called
   * automatically when {@link sessionKeyOf} changes; public so a caller that
   * knows better (the feed dropped, the driver left the car) can say so.
   */
  public reset(): void {
    this.primed = false;
    this.prevPhase = 'unknown';
    this.prevFlag = '';
    this.prevNotStarted = true;
    this.prevHasDamage = undefined;
    this.prevDamageWorst = 0;
    this.prevPenalties = UNKNOWN_VALUE;
    this.prevPitThisLap = false;
    this.fuelWindowArmed = true;
    this.seenGreen = false;
    this.prevYellowSectors = null;
    this.prevFinalLap = false;
    this.prevFinished = false;
    this.prevBestSelf = UNKNOWN_VALUE;
    this.prevFieldFastest = null;
    this.posAnnounced = UNKNOWN_VALUE;
    this.posCandidate = null;
    this.prevPitPhase = 'none';
    this.prevNeighbourPit.clear();
    this.prevYieldAny = false;
    this.prevWindowOpen = false;
    this.prevPracticePacePercent = UNKNOWN_VALUE;
    this.prevPracticePaceBand = '';
    this.lastPracticePaceLap = UNKNOWN_VALUE;
    this.lastFiredAt.clear();
    this.firedOnce.clear();
    this.lastCueAt = 0;
    this.pending = [];
    this.pendingSince = 0;
  }

  /**
   * Advance by one frame.
   *
   * @param frame - The frame just built by the provider.
   * @param nowMs - Clock to judge cooldowns against. Defaults to the frame's own
   *   timestamp, which is what makes a replay run at the pace the race did
   *   rather than at the pace the file is read.
   * @returns A cue when this frame's edges (or ones held from just before it)
   *   have earned one — otherwise `null`, which is the overwhelmingly common case.
   */
  public update(frame: TelemetryFrame, nowMs?: number): EngineerCue | null {
    const now = known(nowMs) ? nowMs : frame.timestamp;

    if (this.ignoreDisconnected && !frame.connected) {
      // Placeholder data. Not a reset — the sim reconnecting mid-session should
      // resume, not re-announce — but nothing is learned from it either, so the
      // levels stay as they were and the next real frame re-primes against them.
      return null;
    }

    const key = sessionKeyOf(frame);
    if (key !== this.sessionKey) {
      this.sessionKey = key;
      this.reset();
    }

    this.stats.frames++;

    // A backwards clock is a replay looping or a feed being re-attached; either
    // way every cooldown below is now in the future and would gate everything
    // forever.
    if (this.lastCueAt > now || this.pendingSince > now) this.reset();

    if (!this.primed) {
      this.record(frame);
      // The fuel window is the one detector whose condition is a LEVEL rather
      // than an edge, so priming has to arm it from where the car actually is:
      // attaching to a driver who is already three laps from empty must not
      // open with a pit-window call about a window they have been in for a lap.
      this.fuelWindowArmed = tighterFuelLaps(frame) > this.fuelWindowLaps;
      // The race-story baselines seed the same way: the fastest-lap holder,
      // the neighbours' pit state, the blue flag and the window are all levels
      // on the frame we arrive on — an edge needs a before, and this is it.
      this.observeRaceStory(frame);
      this.observePracticePace(frame);
      this.primed = true;
      return null;
    }

    this.detect(frame, now);
    this.record(frame);
    return this.flush(frame, now);
  }

  /* ---- detection: one small method per edge ------------------------------ */

  /** Runs every detector against this frame, offering what it finds. */
  private detect(frame: TelemetryFrame, now: number): void {
    this.detectSessionFlags(frame, now);
    this.detectDamage(frame, now);
    this.detectPenalties(frame, now);
    this.detectFuel(frame, now);
    this.detectRaceStory(frame, now);
    this.detectPracticePace(frame, now);
  }

  /** Green, yellow, red, white, chequered — the session's own lifecycle. */
  private detectSessionFlags(frame: TelemetryFrame, now: number): void {
    const { phase, flag } = frame.session;

    // Red flag: phase or flag, whichever the provider expresses it through.
    if ((phase === 'redFlag' && this.prevPhase !== 'redFlag') || (flag === 'red' && this.prevFlag !== 'red')) {
      this.offer('redFlag', now, 'session red-flagged', { phase, flag });
    }

    // Full-course yellow. The flag alone is not enough — a local yellow shows as
    // `yellow` too, and a driver does not need a radio call for a marshal post
    // two corners away — so the phase is what is trusted, with the flag only
    // corroborating when the provider does not move the phase.
    const wasFcy = this.prevPhase === 'fullCourseYellow';
    const isFcy = phase === 'fullCourseYellow' || flag === 'doubleYellow';
    if (isFcy && !wasFcy && this.prevFlag !== 'doubleYellow') {
      this.offer('fullCourseYellow', now, 'full-course yellow', { phase, flag });
    }

    // LOCAL yellows, per sector. Only meaningful outside FCY/red — under those
    // every sector reads yellow and the calls above own the story — so the
    // level is parked at null there and re-primes silently after, which also
    // swallows the phantom "all clear" the blanket's withdrawal would fake.
    //
    // On an LMU rig with live shared memory the sectors are real (decoded
    // 2026-08-26); with only REST the one published flag arrives copied into
    // all three slots, so `all: true` is the phrase layer's cue to say
    // "yellow flags out" rather than claim three separate incidents.
    const sectors = frame.session.sectorFlags;
    if (sectors && !isFcy && phase !== 'redFlag' && flag !== 'red') {
      const yellowNow = sectors.map((f) => f === 'yellow' || f === 'doubleYellow');
      const prev = this.prevYellowSectors; // maintained by record(), null re-primes
      if (prev) {
        const appeared = yellowNow.some((y, i) => y && !prev[i]);
        if (appeared) {
          const lit = yellowNow.flatMap((y, i) => (y ? [i + 1] : []));
          this.offer('sectorYellow', now, `local yellow — S${lit.join(' S')}`, {
            sectors: lit.join(','),
            all: lit.length === 3,
          });
        } else if (prev.some(Boolean) && !yellowNow.some(Boolean)) {
          this.offer('sectorClear', now, 'local yellows cleared', {});
        }
      }
    }

    // Green. The first one in a race is the start; a later one is a restart, and
    // the driver needs to hear those differently — "lights out" versus "we go
    // again, you're P7".
    const goneGreen = phase === 'green' && this.prevPhase !== 'green';
    const startedFromGrid = this.prevNotStarted && !frame.session.notStarted;
    if (goneGreen || startedFromGrid) {
      if (this.seenGreen && isPreGreen(this.prevPhase) === false) {
        this.offer('restart', now, 'racing resumes', { from: this.prevPhase });
      } else {
        this.offer('raceStart', now, 'green flag', { numCars: frame.session.numCars });
      }
      this.seenGreen = true;
    }

    // LAST LAP. Two ways in, because sims disagree about how they say it:
    //
    //   - a white flag, which is the convention this used to wait for alone —
    //     and which Le Mans Ultimate never shows. Probed through a full race
    //     finish 2026-08-22: the marshalling channel goes straight from clear to
    //     CHEQUERED, so on LMU this branch had never once fired.
    //   - `session.finalLap`: the chequered flag is OUT and the cars still
    //     running are on their last lap. That is 23 s before the session reaches
    //     its checkered phase and 46 s before the car being watched actually
    //     crossed, which is the difference between a last-lap call and a
    //     commiseration.
    //
    // Not fired once we are already finished: a driver who has taken the flag is
    // not about to start a last lap. `finished` is absent on providers that
    // cannot see it, and absent must not suppress the call.
    const finished = frame.player?.finished === true;
    const finalLap = frame.session.finalLap === true;
    if (
      !finished &&
      ((flag === 'white' && this.prevFlag !== 'white') || (finalLap && !this.prevFinalLap))
    ) {
      this.offer('finalLap', now, 'last lap', {
        position: frame.player?.position ?? UNKNOWN_VALUE,
      });
    }
    this.prevFinalLap = finalLap;

    // THE FLAG. Our own car crossing the line, not the session's phase changing
    // — the phase moves when the LEADER finishes, and congratulating a driver on
    // a result while they still have most of a lap to run is worse than saying
    // nothing. The phase is kept only as the fallback for a provider with no
    // per-car verdict, where it is the best statement available.
    const canSeeFinish = frame.player?.finished !== undefined;
    const crossedLine = finished && !this.prevFinished;
    const phaseCheckered =
      (flag === 'checkered' && this.prevFlag !== 'checkered') ||
      (phase === 'checkered' && this.prevPhase !== 'checkered');
    if (crossedLine || (!canSeeFinish && phaseCheckered)) {
      this.offer('checkered', now, 'chequered flag', {
        // The LATCHED result where the provider has one — a live position keeps
        // moving while the rest of the field is still coming round.
        position:
          frame.player?.finishPosition ?? frame.player?.position ?? UNKNOWN_VALUE,
        ...(frame.player?.finishClassPosition !== undefined
          ? { classPosition: frame.player.finishClassPosition }
          : {}),
      });
    }
    this.prevFinished = finished;
  }

  /**
   * Contact. Fires on the car acquiring damage it did not have, and again on a
   * genuine second impact — a jump of {@link DAMAGE_WORSENED_STEP} between
   * consecutive frames, not the same bodywork still being bent.
   *
   * The block is absent on providers that cannot see it and while spectating, and
   * absent is not clean: an undefined previous reading means the detector has
   * nothing to compare and stays quiet rather than announcing a car it has only
   * just started watching.
   */
  private detectDamage(frame: TelemetryFrame, now: number): void {
    const damage = frame.player?.damage;
    if (!damage) return;
    if (this.prevHasDamage === undefined) return;

    const worst = known(damage.worst) ? damage.worst : 0;
    const appeared = damage.hasDamage && !this.prevHasDamage;
    const struckAgain = damage.hasDamage && worst - this.prevDamageWorst >= DAMAGE_WORSENED_STEP;
    if (!appeared && !struckAgain) return;

    const severity = damageBucket(worst);
    const facts: Record<string, string | number | boolean> = {
      severity,
      repeat: !appeared,
    };
    if (known(damage.repairSeconds)) facts.repairSeconds = Math.round(damage.repairSeconds);
    if (known(damage.partsDetached) && damage.partsDetached > 0) {
      facts.partsDetached = damage.partsDetached;
    }
    if (known(frame.player?.position)) facts.position = frame.player.position;

    this.offer(
      'incident',
      now,
      appeared ? `contact — ${severity} damage` : `contact again — damage now ${severity}`,
      facts,
    );
  }

  /**
   * The stewards. Both directions are news and they are different news: a
   * penalty appearing is something to plan around, and the count coming back
   * down is the only confirmation the sim ever gives that a drive-through
   * counted (see `trackLimits.ts`).
   */
  private detectPenalties(frame: TelemetryFrame, now: number): void {
    const penalties = frame.player?.trackLimits?.penalties;
    if (!known(penalties)) return;
    if (!known(this.prevPenalties)) return;

    if (penalties > this.prevPenalties) {
      const facts: Record<string, string | number | boolean> = { outstanding: penalties };
      const type = frame.player.trackLimits?.penaltyType;
      if (type) facts.penaltyType = type;
      this.offer('penalty', now, type ? `penalty issued — ${type}` : 'penalty issued', facts);
    } else if (penalties < this.prevPenalties) {
      this.offer('penaltyServed', now, 'penalty served', { outstanding: penalties });
    }
  }

  /**
   * Fuel and energy. Two calls with different jobs:
   *
   * - **`fuelCritical`** rides `fuel.pitThisLap`, which the fuel calculator
   *   already computes as a projection to the start/finish line. It is the only
   *   fuel fact this layer treats as urgent, and it is deliberately taken from
   *   there rather than re-derived: one place owns that arithmetic.
   * - **`fuelWindow`** is the advisory one, fired when the laps remaining first
   *   crosses down through the threshold. It re-arms only once the figure climbs
   *   a clear lap back above it, so a number hovering on the boundary — which is
   *   exactly what it does as consumption averages settle — cannot chatter.
   */
  private detectFuel(frame: TelemetryFrame, now: number): void {
    const fuel = frame.fuel;
    if (!fuel) return;

    const pitThisLap = fuel.pitThisLap === true;
    if (pitThisLap && !this.prevPitThisLap) {
      this.offer('fuelCritical', now, `pit this lap for ${fuel.pitThisLapReason ?? 'fuel'}`, {
        reason: fuel.pitThisLapReason ?? 'fuel',
        lapsRemaining: known(fuel.lapsRemaining) ? Math.round(fuel.lapsRemaining * 10) / 10 : UNKNOWN_VALUE,
      });
    }

    const fuelLaps = known(fuel.lapsRemaining) ? fuel.lapsRemaining : Infinity;
    const energyLaps = known(fuel.virtualEnergyLapsRemaining)
      ? fuel.virtualEnergyLapsRemaining
      : Infinity;
    const laps = tighterFuelLaps(frame);
    if (!Number.isFinite(laps)) return;

    if (laps <= this.fuelWindowLaps && this.fuelWindowArmed && !this.cooling('fuelWindow', now)) {
      if (
        this.offer('fuelWindow', now, `pit window — ${laps.toFixed(1)} laps of ${energyLaps < fuelLaps ? 'energy' : 'fuel'} left`, {
          budget: energyLaps < fuelLaps ? 'energy' : 'fuel',
          lapsLeft: Math.round(laps * 10) / 10,
          lapsToFinish: known(fuel.lapsToFinish) ? fuel.lapsToFinish : UNKNOWN_VALUE,
        })
      ) {
        this.fuelWindowArmed = false;
      }
    } else if (laps > this.fuelWindowLaps + 1) {
      // A clear lap above the threshold — the car has been refuelled (or the
      // average has settled), so the call is worth making again.
      this.fuelWindowArmed = true;
    }
  }

  /**
   * The race-story kinds (Standard preset): fastest laps, position moves, the
   * rivals' stops, blue flags, the strategy window. All edges on fields the
   * frame already carries; the whole method is a handful of scalar compares
   * plus one pass over the standings, well inside the layer's measured
   * sub-microsecond budget. The RACE_ONLY set gates most of these to races —
   * that check lives in `offer()`, so the detectors stay uniform.
   */
  private detectRaceStory(frame: TelemetryFrame, now: number): void {
    const me = playerRow(frame);
    const cur = raceStoryLevels(frame, me);

    // Personal best: a DECREASE from a previous known best, never the first
    // best (the first flying lap always "improves" on nothing — not news).
    if (me && known(me.bestLapSec) && me.bestLapSec > 0) {
      if (
        known(this.prevBestSelf) &&
        this.prevBestSelf > 0 &&
        me.bestLapSec < this.prevBestSelf - 0.001
      ) {
        this.offer('fastestLapSelf', now, 'personal best lap', {
          lapSec: Math.round(me.bestLapSec * 1000) / 1000,
        });
      }
    }

    // Field fastest changing OWNER inside the player's class. Guarded on the
    // new time actually beating the old one, so a holder disconnecting (and the
    // min recomputing to someone slower) never reads as a purple lap.
    if (cur.holder && this.prevFieldFastest) {
      const prev = this.prevFieldFastest;
      if (
        cur.holder.slotId !== prev.slotId &&
        cur.holder.bestLapSec <= prev.sec &&
        !cur.holder.isPlayer // the player's own purple is fastestLapSelf's story
      ) {
        this.offer('fastestLapField', now, 'fastest lap changes hands', {
          name: cur.holder.driverName,
          lapSec: Math.round(cur.holder.bestLapSec * 1000) / 1000,
        });
      }
    }

    // Position change — suppressed through lap 1 (the start is its own story)
    // and any own-pit cycle (a swap while stationary in the box is not a
    // race), and a new position must HOLD for {@link POSITION_SETTLE_MS}
    // before it is news: the standings can flicker wildly for a few frames.
    const pitPhase = frame.player?.pit?.phase ?? 'none';
    if (me && known(me.position)) {
      const lap = frame.session.currentLap;
      const absorb =
        pitPhase !== 'none' ||
        this.prevPitPhase !== 'none' ||
        !known(lap) ||
        lap <= 1 ||
        !known(this.posAnnounced);
      if (absorb) {
        // Not announceable right now — track silently so nothing is "owed"
        // from before the pit stop or the opening lap.
        this.posAnnounced = me.position;
        this.posCandidate = null;
      } else if (me.position === this.posAnnounced) {
        this.posCandidate = null; // back where we left it — a flicker, not news
      } else if (!this.posCandidate || this.posCandidate.pos !== me.position) {
        this.posCandidate = { pos: me.position, sinceMs: now };
      } else if (now - this.posCandidate.sinceMs >= POSITION_SETTLE_MS) {
        const gained = me.position < this.posAnnounced;
        this.offer('positionChange', now, gained ? 'position gained' : 'position lost', {
          from: this.posAnnounced,
          to: me.position,
          gained,
          classPosition: known(me.classPosition) ? me.classPosition! : UNKNOWN_VALUE,
        });
        // Absorbed either way: if the offer lost to a cooldown, announcing the
        // same move after the cooldown would be old news.
        this.posAnnounced = me.position;
        this.posCandidate = null;
      }
    }

    // The class neighbours' stops. Identity is re-derived every tick, so a
    // neighbour changing (someone passed them) simply rotates the map — an id
    // with no previous reading cannot fire.
    for (const [slotId, entry] of cur.neighbourPit) {
      if (this.prevNeighbourPit.get(slotId) === false && entry.inPit) {
        this.offer('rivalPitted', now, 'rival pitted', {
          name: entry.name,
          where: entry.where,
        });
      }
    }

    // The strategy window opening — the fuel calculator's own projection, not
    // re-derived here. The boolean re-arms by itself when a stop moves the
    // window to a future lap.
    if (cur.windowOpen && !this.prevWindowOpen && known(frame.fuel?.pitWindowOpenLap)) {
      this.offer('pitWindowOpen', now, 'strategy pit window open', {
        openLap: frame.fuel.pitWindowOpenLap!,
      });
    }

    // Blue flags: the relative feed's own yieldTo flag — one place owns the
    // faster-class rules (`yieldAlert.ts` / carClass.ts), and it is not here.
    if (cur.yieldAny && !this.prevYieldAny) {
      const facts: Record<string, string | number | boolean> = {};
      if (cur.nearestYield) {
        facts.name = cur.nearestYield.name;
        facts.gapSec = Math.round(cur.nearestYield.gapSec * 10) / 10;
      }
      this.offer('yieldTo', now, 'blue flags — faster class closing', facts);
    }

    this.storeRaceStory(cur);
  }

  /**
   * Practice-only pace coaching: establish the first scored benchmark, announce
   * a move into a faster source-table band, then repeat the unchanged best only
   * every few completed laps. The timing is deterministic for replay tuning;
   * phrase variants provide the occasional, non-robotic delivery.
   */
  private detectPracticePace(frame: TelemetryFrame, now: number): void {
    const read = practicePaceRead(frame);
    if (!read) return;

    const firstBenchmark = !known(this.prevPracticePacePercent);
    const fasterBand =
      !firstBenchmark &&
      !!this.prevPracticePaceBand &&
      read.band !== this.prevPracticePaceBand &&
      read.percent < this.prevPracticePacePercent;
    const periodic =
      !firstBenchmark &&
      !fasterBand &&
      known(this.lastPracticePaceLap) &&
      read.lap - this.lastPracticePaceLap >= this.practicePaceLapInterval;

    if (firstBenchmark || fasterBand || periodic) {
      const reason = firstBenchmark ? 'first' : fasterBand ? 'band-improved' : 'periodic';
      this.offer('practicePace', now, `practice pace — ${read.band}`, {
        ...read.facts,
        reason,
      });
      // Absorb the event even if another radio call wins the gate. Repeating
      // stale pace news after a cooldown would be worse than waiting four laps.
      this.lastPracticePaceLap = read.lap;
    }
    this.prevPracticePacePercent = read.percent;
    this.prevPracticePaceBand = read.band;
  }

  /** Seed the race-story baselines from the priming frame — levels, no offers. */
  private observeRaceStory(frame: TelemetryFrame): void {
    const me = playerRow(frame);
    this.storeRaceStory(raceStoryLevels(frame, me));
    this.posAnnounced = me && known(me.position) ? me.position : UNKNOWN_VALUE;
    this.posCandidate = null;
  }

  /** Seed an existing practice score without announcing it on mid-session attach. */
  private observePracticePace(frame: TelemetryFrame): void {
    const read = practicePaceRead(frame);
    if (!read) return;
    this.prevPracticePacePercent = read.percent;
    this.prevPracticePaceBand = read.band;
    this.lastPracticePaceLap = read.lap;
  }

  /** Remember this frame's race-story levels for the next tick's comparisons. */
  private storeRaceStory(cur: RaceStoryLevels): void {
    if (cur.holder) {
      this.prevFieldFastest = { slotId: cur.holder.slotId, sec: cur.holder.bestLapSec };
    }
    const pit = new Map<number, boolean>();
    for (const [slotId, entry] of cur.neighbourPit) pit.set(slotId, entry.inPit);
    this.prevNeighbourPit = pit;
    this.prevYieldAny = cur.yieldAny;
    this.prevWindowOpen = cur.windowOpen;
  }

  /* ---- the gates --------------------------------------------------------- */

  /**
   * Whether this kind is inside its cooldown. Read by the detectors whose
   * condition is a level rather than an edge, so they can stay quiet without
   * offering the same suppressed candidate on every frame.
   */
  private cooling(kind: EngineerTriggerKind, atMs: number): boolean {
    const last = this.lastFiredAt.get(kind);
    return last !== undefined && atMs - last < (COOLDOWN_MS[kind] ?? this.cooldownMs);
  }

  /**
   * Offer a detected edge to the debounce gates. Returns whether it was accepted
   * into the pending buffer — the callers that keep their own re-arm state
   * (damage, fuel) need to know, so a suppressed call is not silently treated as
   * having been made.
   */
  private offer(
    kind: EngineerTriggerKind,
    atMs: number,
    detail: string,
    facts: Record<string, string | number | boolean>,
  ): boolean {
    if (this.firedOnce.has(kind)) {
      this.stats.suppressed.once++;
      return false;
    }
    if (RACE_ONLY.has(kind) && this.lastSessionType !== 'race') {
      this.stats.suppressed.sessionType++;
      return false;
    }
    const last = this.lastFiredAt.get(kind);
    const cooldown = COOLDOWN_MS[kind] ?? this.cooldownMs;
    if (last !== undefined && atMs - last < cooldown) {
      this.stats.suppressed.cooldown++;
      return false;
    }
    // Already waiting to be said — the same edge detected twice inside the
    // coalesce window is one thing that happened.
    if (this.pending.some((t) => t.kind === kind)) return false;

    if (this.pending.length === 0) this.pendingSince = atMs;
    this.pending.push({ kind, atMs, priority: TRIGGER_PRIORITY[kind], detail, facts });
    return true;
  }

  /**
   * Emit the buffered candidates if the coalesce window has closed and the
   * global gate is open; drop them if they have gone stale waiting.
   */
  private flush(frame: TelemetryFrame, now: number): EngineerCue | null {
    if (this.pending.length === 0) return null;
    if (now - this.pendingSince < this.coalesceMs) return null;

    if (this.lastCueAt !== 0 && now - this.lastCueAt < this.globalMinIntervalMs) {
      if (now - this.pendingSince > this.maxHoldMs) {
        this.stats.suppressed.stale += this.pending.length;
        this.pending = [];
      } else {
        this.stats.suppressed.global++;
      }
      return null;
    }

    const triggers = this.pending.sort((a, b) => b.priority - a.priority || a.atMs - b.atMs);
    this.pending = [];
    const lead = triggers[0];
    if (!lead) return null;

    for (const t of triggers) {
      this.lastFiredAt.set(t.kind, now);
      if (ONCE_PER_SESSION.has(t.kind)) this.firedOnce.add(t.kind);
      this.stats.fired[t.kind] = (this.stats.fired[t.kind] ?? 0) + 1;
    }
    this.lastCueAt = now;
    this.stats.cues++;

    const context = contextOf(frame);
    return {
      atMs: now,
      kind: lead.kind,
      triggers,
      context,
      line: renderLine(triggers, context),
    };
  }

  /* ---- level recording --------------------------------------------------- */

  /** Remember this frame's levels for the next tick's comparisons. */
  private record(frame: TelemetryFrame): void {
    this.lastSessionType = frame.session.type;
    this.prevPhase = frame.session.phase;
    this.prevFlag = frame.session.flag;
    this.prevNotStarted = frame.session.notStarted === true;
    if (frame.session.phase === 'green') this.seenGreen = true;

    // The sector-yellow level. Parked at null while FCY/red blankets the rail
    // (their withdrawal must not read as a local all-clear) and while the
    // provider carries no rail at all; the next plain frame re-primes silently.
    const s = frame.session;
    const blanket =
      s.phase === 'fullCourseYellow' || s.flag === 'doubleYellow' ||
      s.phase === 'redFlag' || s.flag === 'red';
    this.prevYellowSectors =
      !s.sectorFlags || blanket
        ? null
        : (s.sectorFlags.map((f) => f === 'yellow' || f === 'doubleYellow') as [
            boolean,
            boolean,
            boolean,
          ]);

    const damage = frame.player?.damage;
    if (damage) {
      this.prevHasDamage = damage.hasDamage;
      this.prevDamageWorst = known(damage.worst) ? damage.worst : 0;
    }

    const penalties = frame.player?.trackLimits?.penalties;
    if (known(penalties)) this.prevPenalties = penalties;

    this.prevPitThisLap = frame.fuel?.pitThisLap === true;

    // Race-story levels. (The field-fastest holder, neighbour-pit map, yield
    // flag, window boolean and position-settle state update inside
    // detectRaceStory itself, where the values are already in hand.)
    const me = playerRow(frame);
    if (me && known(me.bestLapSec) && me.bestLapSec > 0) this.prevBestSelf = me.bestLapSec;
    this.prevPitPhase = frame.player?.pit?.phase ?? 'none';
  }
}

/* -------------------------------------------------------------------------- */
/*  Rendering (the tuning log only — the engineer's words are P2's job)        */
/* -------------------------------------------------------------------------- */

/** Zeroed counters. */
function freshStats(): TriggerStats {
  return {
    frames: 0,
    cues: 0,
    fired: {},
    suppressed: { cooldown: 0, once: 0, sessionType: 0, global: 0, stale: 0 },
  };
}

/** Race-wide context, read once at the moment a cue is emitted. */
function contextOf(frame: TelemetryFrame): EngineerCueContext {
  const row = playerRow(frame);
  const classPosition = row?.classPosition;
  return {
    sessionType: frame.session.type,
    phase: frame.session.phase,
    flag: frame.session.flag,
    track: frame.session.track,
    position: known(frame.player?.position) ? frame.player.position : UNKNOWN_VALUE,
    classPosition: known(classPosition) ? classPosition : UNKNOWN_VALUE,
    carClass: row?.carClass ?? '',
    numCars: frame.session.numCars,
    currentLap: known(frame.session.currentLap) ? frame.session.currentLap : UNKNOWN_VALUE,
    lapsRemaining: known(frame.session.lapsRemaining) ? frame.session.lapsRemaining : UNKNOWN_VALUE,
  };
}

/**
 * One log line for a cue: what fired, and where the driver was when it did.
 * Exported so the replay harness and any future dry-run switch render identically
 * — a tuning log whose format drifts between tools is a tuning log you cannot
 * diff against yesterday's.
 */
export function renderLine(triggers: EngineerTrigger[], context: EngineerCueContext): string {
  const what = triggers.map((t) => t.detail).join(' + ');
  const where: string[] = [];
  if (context.position !== UNKNOWN_VALUE) {
    where.push(
      context.classPosition !== UNKNOWN_VALUE && context.carClass
        ? `P${context.position} (${context.carClass} P${context.classPosition})`
        : `P${context.position}`,
    );
  }
  if (context.currentLap !== UNKNOWN_VALUE) {
    where.push(
      context.lapsRemaining !== UNKNOWN_VALUE
        ? `lap ${context.currentLap}, ${context.lapsRemaining} to go`
        : `lap ${context.currentLap}`,
    );
  }
  return where.length ? `${what} · ${where.join(' · ')}` : what;
}
