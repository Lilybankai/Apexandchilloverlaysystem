/**
 * @file src/telemetry/sessionCalls.ts
 * @module telemetry/sessionCalls
 *
 * **The engineer in qualifying and practice.** Until this module the radio was
 * silent in a qualifying session — every race-story kind is RACE_ONLY in
 * `triggers.ts`, rightly, because "fastest lap changes hands" is a different
 * story when the whole point of the session is the fastest lap. A driver's
 * report (2026-10) was simply "you didn't give me any sector updates in
 * qualifying". This is the hotlap engineer: what a real one says on a push lap
 * and after it.
 *
 * ## The kinds, and who hears them
 *
 * | kind             | session      | tier      | the call                                         |
 * |------------------|--------------|-----------|--------------------------------------------------|
 * | `qualiLap`       | qualifying   | essential | your lap: time, class position, verdict, pole     |
 * | `qualiPole`      | qualifying   | essential | class pole changes OWNER (never the same car)     |
 * | `qualiBeaten`    | qualifying   | essential | someone beat your time and you lost places        |
 * | `qualiTimeLeft`  | qualifying   | essential | at the line: is there time for another lap        |
 * | `qualiGrid`      | qualifying   | essential | once, at your flag: where you'll start            |
 * | `practiceLap`    | practice     | standard  | personal best, or the lap was deleted             |
 * | `sectorImproved` | both         | standard  | S1/S2 up on your best lap, or a purple split      |
 *
 * (The tiers live in `electron/engineer.js` TRIGGER_TIERS; they are restated
 * here because the table is the design.)
 *
 * ## Discipline — this is what makes it an engineer, not a timing screen
 *
 * - **Only flying laps.** A lap is summarised only if we watched it start at
 *   the line, it never touched the pit lane (out-laps begin there, in-laps end
 *   there), no FCY/red flag ran during it, the car had not already taken the
 *   flag (cool-down lap), and — when it was valid — it was within
 *   {@link PUSH_LAP_RATIO} of the best. A lap two seconds off is a cool-down or
 *   an abandoned run; the driver knows.
 * - **One lap summary per lap**, spoken after the line. It waits
 *   {@link LAP_SETTLE_MS} so the standings have re-sorted (LMU orders a
 *   qualifying session by best lap; the class position must be the one AFTER
 *   this lap), then waits for a quiet channel for up to
 *   {@link LAP_SUMMARY_MAX_WAIT_MS} rather than being clipped by the global gate.
 * - **Sector calls only on improvements, at most one per lap**, and never in
 *   the last {@link PROTECT_LINE_SEC} seconds before the line — a sector call
 *   there would take the global gate and the lap summary (the call that
 *   matters) would be dropped behind it.
 * - **Board news (pole, beaten) waits for the board to settle** for
 *   {@link BOARD_SETTLE_MS}: at the end of a session a dozen laps land inside a
 *   few seconds, and that is ONE call naming where you are now, not five.
 * - **Silence in the pit lane and before green**; and every call checks the
 *   global gate before it is offered, so a lower-value call never steals the
 *   slot from a higher one and is dropped later as stale.
 *
 * ## What the data can and cannot prove (read before tuning)
 *
 * - Lap validity is LMU's `countLapFlag` (`player.trackLimits.lapValid`):
 *   `false` the instant a cut voids the lap, restored if the sim forgives it.
 *   The verdict used is the LAST reading before the line. A lap LMU deletes
 *   also tends to publish `lastLapTime = -1`, which corroborates a false read
 *   seen late in the lap. Validity was probed in a race session (2026-08-04);
 *   that qualifying behaves the same is an assumption, not a measurement.
 * - Sector splits for the lap IN PROGRESS are not published on the frame (only
 *   the completed lap's `lastSector1Sec/2Sec`). The sector call therefore reads
 *   the delta engine's own `tSession` (time delta to the session-best lap at
 *   the same track position) at the frame the car's REST `sector` field flips
 *   — distance-based, so it does not inherit the poll's timing jitter. "Up two
 *   tenths" means "up two tenths on your best LAP through that sector". A
 *   purple estimate adds that delta to the best lap's own split and compares it
 *   with every class car's best split (completed laps we watched), with a
 *   {@link PURPLE_MARGIN_SEC} margin so an estimate never claims a purple it
 *   only nearly set. No `paceDeltas` (spectating, dead shared memory) = no
 *   sector calls.
 * - How a qualifying session ends in LMU was NOT observable in any recording on
 *   hand (only races were recorded). The race probe showed the chequered flag
 *   SHOWING when the clock expires (`session.finalLap`) and a per-car
 *   `finishStatus` once the car crosses after it; LMU carries a qualifying
 *   FINISHED status into the race (2026-08-28 report), so it does publish it in
 *   qualifying. The time-left call is pure timing — "time for one more after
 *   this" means you will cross the line again before the clock reads zero. It
 *   never states what the rules let you finish.
 */

import { UNKNOWN_VALUE, isPreGreen } from './types';
import type { StandingEntry, TelemetryFrame } from './types';

/* -------------------------------------------------------------------------- */
/*  Kinds                                                                       */
/* -------------------------------------------------------------------------- */

/** The qualifying/practice trigger kinds this module offers. */
export type SessionCallKind =
  | 'qualiLap'
  | 'qualiPole'
  | 'qualiBeaten'
  | 'qualiTimeLeft'
  | 'qualiGrid'
  | 'practiceLap'
  | 'sectorImproved';

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** Wait after the line before the lap summary is built, ms (standings re-sort). */
export const LAP_SETTLE_MS = 1200;

/** A lap summary still unsaid this long after the line is dropped, ms. */
export const LAP_SUMMARY_MAX_WAIT_MS = 12_000;

/** The grid call may wait this long for a quiet channel, ms. */
export const GRID_MAX_WAIT_MS = 30_000;

/** How long the class times must stay unchanged before board news is offered, ms. */
export const BOARD_SETTLE_MS = 2500;

/** No sector or board call when the line is closer than this, seconds. */
export const PROTECT_LINE_SEC = 18;

/** A valid lap slower than best × this is a cool-down / abandoned run — silent. */
export const PUSH_LAP_RATIO = 1.015;

/** Qualifying: a sector must be at least this far up on the best lap, s. */
export const QUALI_SECTOR_MIN_GAIN_SEC = 0.1;

/** Practice ("light"): a sector must be at least this far up, s. */
export const PRACTICE_SECTOR_MIN_GAIN_SEC = 0.3;

/** A purple estimate must beat the class-best split by this much, s. */
export const PURPLE_MARGIN_SEC = 0.05;

/** The delta engine's session best must match the sim's best lap within this, s. */
const REF_MATCH_SEC = 0.15;

/** A deferred call due within this of one being offered rides along with it, ms. */
const NEAR_READY_MS = 500;

/** Margin on the time-left arithmetic, s — inside it the call is "tight". */
const TIME_LEFT_MARGIN_SEC = 3;

/* -------------------------------------------------------------------------- */
/*  The host — EngineerTriggers' gates, lent to this module                     */
/* -------------------------------------------------------------------------- */

/**
 * What the trigger layer lends this module: its debounce gates. Everything
 * offered here goes through the SAME `offer()` as every other kind, so the
 * cooldown, coalesce, global-interval and staleness rules apply unchanged.
 */
export interface SessionCallHost {
  offer(
    kind: SessionCallKind,
    atMs: number,
    detail: string,
    facts: Record<string, string | number | boolean>,
  ): boolean;
  /** Whether this kind is still inside its cooldown. */
  cooling(kind: SessionCallKind, atMs: number): boolean;
  /** Whether a cue offered now would clear the global gate when its coalesce window closes. */
  gateOpenSoon(atMs: number): boolean;
  /** Whether other candidates are already waiting — a call offered now would ride (and lose to) them. */
  busy(): boolean;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function known(n: number | undefined | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n !== UNKNOWN_VALUE;
}

function posTime(n: number | undefined): number | null {
  return known(n) && n > 0 ? n : null;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

type SessionFamily = 'qualifying' | 'practice' | null;

function familyOf(frame: TelemetryFrame): SessionFamily {
  const t = frame.session.type;
  if (t === 'qualifying') return 'qualifying';
  if (t === 'practice' || t === 'testday' || t === 'warmup') return 'practice';
  return null;
}

/**
 * OUR row: the car this driver is in (`isOwn`) where the sim says, else the
 * focused car. In qualifying a driver often sits in the garage watching
 * someone else on the monitor, and `isPlayer` follows the camera — a lap
 * summary for the car being watched would be someone else's lap.
 */
function playerRow(frame: TelemetryFrame): StandingEntry | undefined {
  return frame.standings?.find((s) => s.isOwn === true) ?? frame.standings?.find((s) => s.isPlayer);
}

/** The camera is on another car: the frame's per-car `player` block is not ours. */
function watchingOther(me: StandingEntry): boolean {
  return me.isPlayer !== true;
}

/** The player's class mates (including the player), or the whole field when classless. */
function classRows(frame: TelemetryFrame, me: StandingEntry): StandingEntry[] {
  return me.carClass ? frame.standings.filter((e) => e.carClass === me.carClass) : frame.standings;
}

/** Whether the field has more than one class (so "in class" means something). */
function isMulticlass(frame: TelemetryFrame, me: StandingEntry): boolean {
  if (!me.carClass) return false;
  return frame.standings.some((e) => !!e.carClass && e.carClass !== me.carClass);
}

/** Splits of a completed lap from its cumulative boundaries, or null. */
function splitsOf(e: StandingEntry): [number, number, number] | null {
  const lap = posTime(e.lastLapSec);
  const c1 = posTime(e.lastSector1Sec);
  const c2 = posTime(e.lastSector2Sec);
  if (lap === null || c1 === null || c2 === null) return null;
  const s1 = c1;
  const s2 = c2 - c1;
  const s3 = lap - c2;
  if (s1 <= 0 || s2 <= 0 || s3 <= 0) return null;
  return [s1, s2, s3];
}

/** Class position for speech facts. */
function classPosOf(me: StandingEntry): number {
  return known(me.classPosition) ? me.classPosition! : known(me.position) ? me.position : UNKNOWN_VALUE;
}

/**
 * Seconds until the car reaches the line on this lap, or Infinity when the
 * frame cannot say (no lap clock or no reference) — Infinity never blocks.
 */
function secondsToLine(frame: TelemetryFrame, me: StandingEntry): number {
  const pd = frame.player?.paceDeltas;
  const ref = pd && known(pd.predictedLapSec) && pd.predictedLapSec > 0
    ? pd.predictedLapSec
    : posTime(me.bestLapSec);
  const clock = pd && known(pd.lapTimeSec) && pd.lapTimeSec >= 0
    ? pd.lapTimeSec
    : known(frame.player?.lap?.current) && frame.player.lap.current >= 0
      ? frame.player.lap.current
      : null;
  if (ref === null || clock === null) return Infinity;
  return ref - clock;
}

/** One call this module is holding until it is ready and the channel is free. */
interface Deferred {
  kind: SessionCallKind;
  readyAt: number;
  expiresAt: number;
  /** Built at ready time, so positions are the settled ones. `null` = say nothing. */
  build: (frame: TelemetryFrame) => { detail: string; facts: Record<string, string | number | boolean> } | null;
  /** Called if it expires unsaid. */
  onExpire?: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Tier-1 answer: "where do I start"                                           */
/* -------------------------------------------------------------------------- */

/**
 * The qualifying answer to the `gridStart` question — the CURRENT provisional
 * grid slot (in a race the same intent answers "where did I start"). Returns
 * `null` outside qualifying so the caller falls through to its race answer.
 */
export function qualifyingGridAnswer(frame: TelemetryFrame): { ok: boolean; text: string } | null {
  if (frame.session?.type !== 'qualifying') return null;
  const me = playerRow(frame);
  if (!me) return { ok: false, text: 'No standings yet.' };
  if (posTime(me.bestLapSec) === null) return { ok: false, text: 'No lap time on the board yet.' };
  const cls = classPosOf(me);
  if (!known(cls)) return { ok: false, text: 'No standings yet.' };
  const multi = isMulticlass(frame, me);
  const where = multi && known(me.position) ? `P${cls} in class, P${me.position} overall` : `P${cls}`;
  const done = me.isPlayer === true ? frame.player?.finished === true : frame.session.finalLap === true && me.inPit;
  const running = classRows(frame, me).some((e) => !e.isPlayer && !e.inPit && !e.retired);
  if (done && !running) return { ok: true, text: `You'll start ${where}.` };
  return { ok: true, text: `Provisionally ${where}.` };
}

/* -------------------------------------------------------------------------- */
/*  The detector                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Qualifying/practice edge detection. Owned by `EngineerTriggers`, which feeds
 * it every frame after its own detectors and lends it the gates. Stateful like
 * its owner; reset with it on a session change.
 */
export class SessionCalls {
  /* ---- lap tracking (the player) ----------------------------------------- */
  private lapNo: number = UNKNOWN_VALUE;
  /** We saw the current lap begin at the line (not a mid-lap attach). */
  private lapStartKnown = false;
  private lapPitted = false;
  private lapNeutralised = false;
  private lapStartFinished = false;
  /** Last `lapValid` reading on the current lap (undefined = no channel/none yet). */
  private lastValid: boolean | undefined;
  private sawInvalid = false;
  /** Class position when the current lap started — "still P4". */
  private classPosAtLapStart: number = UNKNOWN_VALUE;
  /** The player's best lap last frame. */
  private prevBest: number = UNKNOWN_VALUE;
  /**
   * The player's best when the current lap began — the "before" a lap is
   * judged against. Not last frame's: if the sim publishes the new best a poll
   * ahead of the lap count, last frame already holds THIS lap's time.
   */
  private bestAtLapStart: number = UNKNOWN_VALUE;

  /* ---- sectors -------------------------------------------------------------- */
  private prevSector = 0;
  /** tSession at the S1 line this lap, or null before it. */
  private cumS1: number | null = null;
  private sectorCalledThisLap = false;
  /** Splits of the lap that set the player's current best, and its time. */
  private pbSplits: { lapSec: number; splits: [number, number, number] } | null = null;
  /** Each car's best split per sector off completed laps we watched, by slot. */
  private bestSplits = new Map<number, [number, number, number]>();
  private carLaps = new Map<number, number>();

  /* ---- the board (qualifying) ------------------------------------------------ */
  private boardSig = '';
  private boardSince = 0;
  private poleBase: { slotId: number; sec: number } | null = null;
  private posBase: number = UNKNOWN_VALUE;
  private aheadBase = new Set<number>();

  /* ---- once-a-session ----------------------------------------------------------- */
  private gridQueued = false;
  private gridSaid = false;
  private prevFinished = false;
  private timeLeftSaid = new Set<string>();

  private deferred: Deferred[] = [];

  private readonly sectorGainQuali: number;
  private readonly sectorGainPractice: number;

  public constructor(config: { sectorGainQualiSec?: number; sectorGainPracticeSec?: number } = {}) {
    this.sectorGainQuali = config.sectorGainQualiSec ?? QUALI_SECTOR_MIN_GAIN_SEC;
    this.sectorGainPractice = config.sectorGainPracticeSec ?? PRACTICE_SECTOR_MIN_GAIN_SEC;
  }

  /** Forget the session. */
  public reset(): void {
    this.lapNo = UNKNOWN_VALUE;
    this.lapStartKnown = false;
    this.lapPitted = false;
    this.lapNeutralised = false;
    this.lapStartFinished = false;
    this.lastValid = undefined;
    this.sawInvalid = false;
    this.classPosAtLapStart = UNKNOWN_VALUE;
    this.prevBest = UNKNOWN_VALUE;
    this.bestAtLapStart = UNKNOWN_VALUE;
    this.prevSector = 0;
    this.cumS1 = null;
    this.sectorCalledThisLap = false;
    this.pbSplits = null;
    this.bestSplits.clear();
    this.carLaps.clear();
    this.boardSig = '';
    this.boardSince = 0;
    this.poleBase = null;
    this.posBase = UNKNOWN_VALUE;
    this.aheadBase.clear();
    this.gridQueued = false;
    this.gridSaid = false;
    this.prevFinished = false;
    this.timeLeftSaid.clear();
    this.deferred = [];
  }

  /**
   * Seed the levels from the frame the trigger layer primes on — no offers.
   * The lap in progress is NOT known to have started at the line, so it is
   * never summarised; the board's pole and our position are where they are.
   */
  public observe(frame: TelemetryFrame, now: number): void {
    if (!familyOf(frame)) return;
    const me = playerRow(frame);
    this.prevFinished = frame.player?.finished === true;
    this.observeSplits(frame, false);
    if (!me) return;
    this.lapNo = known(me.lapsCompleted) ? me.lapsCompleted : UNKNOWN_VALUE;
    this.lapStartKnown = false;
    this.prevBest = posTime(me.bestLapSec) ?? UNKNOWN_VALUE;
    this.prevSector = me.sector ?? 0;
    this.seedBoard(frame, me, now);
  }

  /** Advance one frame. */
  public detect(frame: TelemetryFrame, now: number, host: SessionCallHost): void {
    const family = familyOf(frame);
    if (!family) return; // races are triggers.ts' story — not one compare spent here
    const me = playerRow(frame);
    this.observeSplits(frame, true);
    if (!me || frame.session.notStarted || isPreGreen(frame.session.phase)) {
      // Nothing to coach. The lap in progress can no longer be trusted.
      this.lapStartKnown = false;
      if (me) {
        this.lapNo = known(me.lapsCompleted) ? me.lapsCompleted : UNKNOWN_VALUE;
        this.prevBest = posTime(me.bestLapSec) ?? UNKNOWN_VALUE;
        this.prevSector = me.sector ?? 0;
      }
      this.prevFinished = frame.player?.finished === true;
      return;
    }

    if (watchingOther(me)) {
      // Validity, the lap clock and the delta describe the watched car; our
      // own lap in progress cannot be judged from them. Re-anchor and wait.
      this.lapNo = known(me.lapsCompleted) ? me.lapsCompleted : UNKNOWN_VALUE;
      this.lapStartKnown = false;
      this.prevSector = 0;
    } else {
      this.detectLap(frame, me, family, now);
      this.detectSector(frame, me, family, now, host);
    }
    if (family === 'qualifying') {
      this.detectBoard(frame, me, now, host);
      this.detectGrid(frame, me, now);
    }
    this.flushDeferred(frame, now, host);

    this.prevBest = posTime(me.bestLapSec) ?? this.prevBest;
    this.prevFinished = frame.player?.finished === true;
  }

  /* ---- laps ---------------------------------------------------------------- */

  private detectLap(frame: TelemetryFrame, me: StandingEntry, family: 'qualifying' | 'practice', now: number): void {
    const laps = known(me.lapsCompleted) ? me.lapsCompleted : UNKNOWN_VALUE;
    const phase = frame.session.phase;
    const neutral = phase === 'fullCourseYellow' || phase === 'redFlag' || frame.session.flag === 'red';
    const valid = frame.player?.trackLimits?.lapValid;

    if (!known(laps)) return;
    if (!known(this.lapNo) || laps < this.lapNo || laps > this.lapNo + 1) {
      // First sight, a reset or a jump: re-anchor, and do not trust this lap.
      this.lapNo = laps;
      this.startLap(frame, me, false);
      return;
    }

    if (laps === this.lapNo) {
      // Mid-lap: accumulate the things that disqualify it from being a push lap.
      if (me.inPit) this.lapPitted = true;
      if (neutral) this.lapNeutralised = true;
      if (valid !== undefined) {
        this.lastValid = valid;
        if (!valid) this.sawInvalid = true;
      }
      return;
    }

    // ---- THE LINE: lap `this.lapNo + 1` just completed -----------------------
    const flying =
      this.lapStartKnown &&
      !this.lapPitted &&
      !me.inPit && // crossing in the pit lane = an in-lap
      !this.lapStartFinished &&
      !this.lapNeutralised;
    const verdictValid = this.lastValid;
    const sawInvalid = this.sawInvalid;
    const bestBefore = this.bestAtLapStart;
    const posBefore = this.classPosAtLapStart;
    const completedLap = laps;

    if (flying) {
      const kind: SessionCallKind = family === 'qualifying' ? 'qualiLap' : 'practiceLap';
      // The time-left read is taken AT the line (the clock now), spoken with the summary.
      const timeLeft = family === 'qualifying' ? this.timeLeftRead(frame, me) : null;
      this.deferred.push({
        kind,
        readyAt: now + LAP_SETTLE_MS,
        expiresAt: now + LAP_SUMMARY_MAX_WAIT_MS,
        build: (f) => this.buildLapSummary(f, family, completedLap, verdictValid, sawInvalid, bestBefore, posBefore),
      });
      if (timeLeft) this.queueTimeLeft(timeLeft, now);
    } else if (family === 'qualifying' && !me.inPit) {
      // An out-lap ending at the line starts the flying lap: the clock question
      // is just as live, there is simply no lap to summarise.
      const timeLeft = this.timeLeftRead(frame, me);
      if (timeLeft) this.queueTimeLeft(timeLeft, now);
    }

    this.lapNo = laps;
    this.startLap(frame, me, true);
  }

  /** A new lap begins on this frame. `atLine` = we saw it begin at the line. */
  private startLap(frame: TelemetryFrame, me: StandingEntry, atLine: boolean): void {
    const phase = frame.session.phase;
    this.lapStartKnown = atLine;
    this.lapPitted = me.inPit === true;
    this.lapNeutralised = phase === 'fullCourseYellow' || phase === 'redFlag' || frame.session.flag === 'red';
    this.lapStartFinished = frame.player?.finished === true;
    this.lastValid = undefined;
    this.sawInvalid = false;
    this.classPosAtLapStart = classPosOf(me);
    this.bestAtLapStart = posTime(me.bestLapSec) ?? UNKNOWN_VALUE;
    this.cumS1 = null;
    this.sectorCalledThisLap = false;
  }

  /**
   * Turn a completed flying lap into its one call — or null (silence) when the
   * lap turns out not to be worth one: no time published for a valid lap, a
   * cool-down pace, or (practice) a lap that was neither a best nor deleted.
   */
  private buildLapSummary(
    frame: TelemetryFrame,
    family: 'qualifying' | 'practice',
    lapNo: number,
    lastValid: boolean | undefined,
    sawInvalid: boolean,
    bestBefore: number,
    posBefore: number,
  ): { detail: string; facts: Record<string, string | number | boolean> } | null {
    const me = playerRow(frame);
    if (!me) return null;
    const last = posTime(me.lastLapSec);
    // Deleted: the stewards' last word on the lap was "void" — or they voided it
    // late and the sim withheld the time, which is how LMU publishes a deletion.
    const deleted = lastValid === false || (sawInvalid && last === null);
    const facts: Record<string, string | number | boolean> = { session: family, lap: lapNo };
    if (deleted) {
      facts.verdict = 'deleted';
      return { detail: 'lap deleted — track limits', facts };
    }
    if (last === null) return null;

    const bestNow = posTime(me.bestLapSec);
    const prev = posTime(bestBefore);
    // The sim must agree this lap is the best now, or it did not count for time.
    const isBestNow = bestNow !== null && Math.abs(bestNow - last) < 0.01;
    const pb = isBestNow && (prev === null || last < prev - 0.0005);
    facts.lapSec = r3(last);

    if (family === 'practice') {
      // Light: a best that IMPROVES on an earlier one. The first time on the
      // board is just a lap (practicePace owns the first-benchmark call).
      if (!pb || prev === null) return null;
      facts.verdict = 'pb';
      facts.gainSec = r3(prev - last);
      return { detail: `practice personal best ${last.toFixed(3)}`, facts };
    }

    const cls = classPosOf(me);
    facts.classPosition = cls;
    if (known(me.position)) facts.position = me.position;
    facts.multiclass = isMulticlass(frame, me);
    if (pb) {
      facts.verdict = prev === null ? 'first' : 'pb';
      if (prev !== null) facts.gainSec = r3(prev - last);
      facts.pole = cls === 1;
      facts.keptPole = cls === 1 && posBefore === 1;
      return {
        detail: `${facts.pole ? 'provisional pole' : 'personal best'} ${last.toFixed(3)}`,
        facts,
      };
    }
    if (bestNow === null) return null;
    const off = last - bestNow;
    if (off < 0 || last > bestNow * PUSH_LAP_RATIO) return null; // a cool-down or an abandoned run
    facts.verdict = 'off';
    facts.offSec = r3(off);
    facts.samePosition = known(posBefore) && posBefore === cls;
    return { detail: `lap ${last.toFixed(3)}, ${off.toFixed(2)} off best`, facts };
  }

  /* ---- time for one more -------------------------------------------------- */

  /**
   * At the line, on track, in a timed qualifying session: can the car start
   * another lap after the one it is starting now? Timing only — the lap now
   * starting ends after `lap` seconds; if the clock still has time on it then,
   * the car will cross the line again before it reads zero.
   *
   * Returns the verdict only when it is one worth saying (a single further go,
   * none, or too close to call); "plenty of time" is not news.
   */
  private timeLeftRead(frame: TelemetryFrame, me: StandingEntry): { verdict: string; timeLeftSec: number } | null {
    const t = frame.session.timeRemainingSec;
    if (!known(t) || t <= 0) return null;
    if (frame.session.finalLap === true || frame.player?.finished === true) return null;
    const lap = posTime(me.bestLapSec) ?? posTime(me.lastLapSec);
    if (lap === null) return null;
    const after = t - lap; // clock left when the lap now starting ends
    let verdict: string;
    if (after > lap + TIME_LEFT_MARGIN_SEC) return null; // two or more still to come — not news yet
    else if (after > TIME_LEFT_MARGIN_SEC) verdict = 'oneMore';
    else if (after < -TIME_LEFT_MARGIN_SEC) verdict = 'last';
    else verdict = 'tight';
    return { verdict, timeLeftSec: Math.round(t) };
  }

  private queueTimeLeft(read: { verdict: string; timeLeftSec: number }, now: number): void {
    if (this.timeLeftSaid.has(read.verdict)) return;
    // 'tight' and 'last' are the same news twice; one of them is enough.
    if (read.verdict !== 'oneMore' && (this.timeLeftSaid.has('last') || this.timeLeftSaid.has('tight'))) return;
    this.timeLeftSaid.add(read.verdict);
    this.deferred.push({
      kind: 'qualiTimeLeft',
      readyAt: now + LAP_SETTLE_MS,
      expiresAt: now + LAP_SUMMARY_MAX_WAIT_MS,
      build: () => ({
        detail: `time left ${read.timeLeftSec}s — ${read.verdict}`,
        facts: { verdict: read.verdict, timeLeftSec: read.timeLeftSec },
      }),
    });
  }

  /* ---- sectors -------------------------------------------------------------- */

  /** Fold every car's completed-lap splits into its best-per-sector. */
  private observeSplits(frame: TelemetryFrame, edgesOnly: boolean): void {
    for (const e of frame.standings ?? []) {
      const laps = known(e.lapsCompleted) ? e.lapsCompleted : 0;
      const seen = this.carLaps.get(e.slotId);
      this.carLaps.set(e.slotId, laps);
      if (edgesOnly && (seen === undefined || laps <= seen)) continue;
      if (e.inPit) continue;
      const sp = splitsOf(e);
      if (!sp) continue;
      const best = this.bestSplits.get(e.slotId);
      if (!best) this.bestSplits.set(e.slotId, [sp[0], sp[1], sp[2]]);
      else for (let i = 0; i < 3; i++) if (sp[i]! < best[i]!) best[i] = sp[i]!;
      // The player's best LAP's own splits: the reference a sector delta is against.
      if (e.isPlayer) {
        const lap = posTime(e.lastLapSec);
        const best = posTime(e.bestLapSec);
        if (lap !== null && best !== null && Math.abs(lap - best) < 0.01) {
          this.pbSplits = { lapSec: lap, splits: sp };
        }
      }
    }
  }

  private detectSector(
    frame: TelemetryFrame,
    me: StandingEntry,
    family: 'qualifying' | 'practice',
    now: number,
    host: SessionCallHost,
  ): void {
    const sector = me.sector ?? 0;
    const prev = this.prevSector;
    this.prevSector = sector;
    const boundary = prev === 1 && sector === 2 ? 1 : prev === 2 && sector === 3 ? 2 : 0;
    if (!boundary) return;

    const pd = frame.player?.paceDeltas;
    const best = posTime(me.bestLapSec);
    if (!pd || !known(pd.tSession) || !known(pd.refSessionSec) || best === null) return;
    // The delta engine's reference must be the sim's best lap, or "up on your
    // best" would be measured against a different lap.
    if (Math.abs(pd.refSessionSec - best) > REF_MATCH_SEC) return;

    let secDelta: number;
    if (boundary === 1) {
      this.cumS1 = pd.tSession;
      secDelta = pd.tSession;
    } else {
      if (this.cumS1 === null) return;
      secDelta = pd.tSession - this.cumS1;
    }

    // Only on a push lap that still counts, on track, before the flag.
    if (
      !this.lapStartKnown ||
      this.lapPitted ||
      me.inPit ||
      this.lapNeutralised ||
      this.lapStartFinished ||
      frame.player?.finished === true ||
      frame.player?.trackLimits?.lapValid === false ||
      this.sawInvalid ||
      this.sectorCalledThisLap
    ) {
      return;
    }

    // Purple: the best lap's own split plus the delta through this sector,
    // against every class car's best split — the player's own included.
    let purple = false;
    const pbs = this.pbSplits;
    if (pbs && Math.abs(pbs.lapSec - best) < 0.01) {
      const est = pbs.splits[boundary - 1]! + secDelta;
      let classBest = Infinity;
      for (const e of classRows(frame, me)) {
        const sp = this.bestSplits.get(e.slotId);
        if (sp && sp[boundary - 1]! < classBest) classBest = sp[boundary - 1]!;
      }
      purple = Number.isFinite(classBest) && est < classBest - PURPLE_MARGIN_SEC;
    }
    const minGain = family === 'qualifying' ? this.sectorGainQuali : this.sectorGainPractice;
    const up = secDelta <= -minGain;
    if (!purple && !up) return;

    // The line is the call that matters; never take the gate from it.
    if (secondsToLine(frame, me) < PROTECT_LINE_SEC) return;
    if (this.deferred.length > 0 || host.busy() || !host.gateOpenSoon(now)) return;
    if (host.cooling('sectorImproved', now)) return;

    if (
      host.offer('sectorImproved', now, `S${boundary} ${purple ? 'purple' : `up ${(-secDelta).toFixed(2)}`}`, {
        sector: boundary,
        deltaSec: r3(secDelta),
        purple,
        session: family,
      })
    ) {
      this.sectorCalledThisLap = true;
    }
  }

  /* ---- the board: pole and being beaten ------------------------------------ */

  private boardState(frame: TelemetryFrame, me: StandingEntry): {
    sig: string;
    holder: StandingEntry | null;
    ahead: Set<number>;
  } {
    let holder: StandingEntry | null = null;
    const parts: string[] = [];
    const ahead = new Set<number>();
    const myCls = me.classPosition;
    for (const e of classRows(frame, me)) {
      const b = posTime(e.bestLapSec);
      if (b !== null) {
        parts.push(`${e.slotId}:${b}`);
        if (!holder || b < holder.bestLapSec) holder = e;
      }
      if (!e.isPlayer && known(e.classPosition) && known(myCls) && e.classPosition! < myCls!) ahead.add(e.slotId);
    }
    return { sig: parts.join(','), holder, ahead };
  }

  private seedBoard(frame: TelemetryFrame, me: StandingEntry, now: number): void {
    const b = this.boardState(frame, me);
    this.boardSig = b.sig;
    this.boardSince = now;
    this.poleBase = b.holder ? { slotId: b.holder.slotId, sec: b.holder.bestLapSec } : null;
    this.absorbPosition(me, b.ahead);
  }

  private absorbPosition(me: StandingEntry, ahead: Set<number>): void {
    this.posBase = posTime(me.bestLapSec) !== null && known(me.classPosition) ? me.classPosition! : UNKNOWN_VALUE;
    this.aheadBase = new Set(ahead);
  }

  private detectBoard(frame: TelemetryFrame, me: StandingEntry, now: number, host: SessionCallHost): void {
    const b = this.boardState(frame, me);
    if (b.sig !== this.boardSig) {
      this.boardSig = b.sig;
      this.boardSince = now;
    }

    // Our own improvement moves us — that is the lap summary's news, not this.
    const myBest = posTime(me.bestLapSec);
    const improved = myBest !== null && (!known(this.prevBest) || myBest < this.prevBest - 0.0005);
    if (improved || !known(this.posBase)) {
      if (myBest !== null) this.absorbPosition(me, b.ahead);
    }
    if (b.holder?.isPlayer) this.poleBase = { slotId: b.holder.slotId, sec: b.holder.bestLapSec };

    if (now - this.boardSince < BOARD_SETTLE_MS) return;

    // Pole: seed silently the first time anyone is on the board; the same car
    // going quicker is not a change of hands.
    let poleNews = false;
    if (b.holder) {
      if (!this.poleBase) this.poleBase = { slotId: b.holder.slotId, sec: b.holder.bestLapSec };
      else if (b.holder.slotId === this.poleBase.slotId) this.poleBase.sec = b.holder.bestLapSec;
      else if (b.holder.bestLapSec < this.poleBase.sec - 0.0005) poleNews = true;
    }

    const cls = known(me.classPosition) ? me.classPosition! : UNKNOWN_VALUE;
    if (known(this.posBase) && known(cls) && cls < this.posBase) this.absorbPosition(me, b.ahead);
    const beatenNews = known(this.posBase) && known(cls) && cls > this.posBase;
    if (!poleNews && !beatenNews) return;

    // Hold board news while our own lap is about to land, and for a quiet channel.
    if (this.deferred.length > 0 || host.busy() || !host.gateOpenSoon(now)) return;
    if (this.onFlyingLap(me) && secondsToLine(frame, me) < PROTECT_LINE_SEC) return;

    const multiclass = isMulticlass(frame, me);
    if (poleNews && b.holder && !host.cooling('qualiPole', now)) {
      const wasMine = this.poleBase?.slotId === me.slotId;
      if (
        host.offer('qualiPole', now, 'pole changes hands', {
          name: b.holder.driverName,
          lapSec: r3(b.holder.bestLapSec),
          wasMine,
          classPosition: cls,
          multiclass,
        })
      ) {
        this.poleBase = { slotId: b.holder.slotId, sec: b.holder.bestLapSec };
      }
    }
    if (beatenNews && !host.cooling('qualiBeaten', now)) {
      const passers = classRows(frame, me)
        .filter((e) => b.ahead.has(e.slotId) && !this.aheadBase.has(e.slotId))
        .sort((x, y) => (x.classPosition ?? 99) - (y.classPosition ?? 99));
      const lost = cls - this.posBase;
      const facts: Record<string, string | number | boolean> = {
        from: this.posBase,
        to: cls,
        count: lost,
        multiclass,
      };
      // Name the car only when it is unambiguous: one place lost to one car.
      if (lost === 1 && passers.length === 1) facts.name = passers[0]!.driverName;
      if (host.offer('qualiBeaten', now, lost === 1 ? 'beaten — one place lost' : `beaten — ${lost} places lost`, facts)) {
        this.absorbPosition(me, b.ahead);
      }
    }
  }

  private onFlyingLap(me: StandingEntry): boolean {
    return this.lapStartKnown && !this.lapPitted && !me.inPit;
  }

  /* ---- the grid ------------------------------------------------------------ */

  /**
   * Once, when qualifying is over FOR US: our car took the flag (`finished`
   * edge), or the flag is out while we sit in the pit lane (we will not cross
   * the line again), or — on a provider with no per-car finish — the session's
   * own chequered phase. Waits {@link LAP_SETTLE_MS} so it rides with the
   * final lap's summary as one call.
   */
  private detectGrid(frame: TelemetryFrame, me: StandingEntry, now: number): void {
    if (this.gridSaid || this.gridQueued) return;
    const ours = !watchingOther(me); // `finished` is the FOCUSED car's verdict
    const finished = ours && frame.player?.finished === true;
    const canSeeFinish = !ours || frame.player?.finished !== undefined;
    const flagOut = frame.session.finalLap === true || frame.session.phase === 'checkered';
    const crossed = finished && !this.prevFinished;
    const parked = flagOut && me.inPit;
    const phaseOnly = !canSeeFinish && frame.session.phase === 'checkered';
    if (!crossed && !parked && !phaseOnly) return;
    if (posTime(me.bestLapSec) === null) return; // no time, no grid slot to speak of
    this.gridQueued = true;
    this.deferred.push({
      kind: 'qualiGrid',
      readyAt: now + LAP_SETTLE_MS,
      expiresAt: now + GRID_MAX_WAIT_MS,
      build: (f) => {
        const row = playerRow(f);
        if (!row) return null;
        const cls = classPosOf(row);
        if (!known(cls)) return null;
        const running = classRows(f, row).some((e) => !e.isPlayer && !e.inPit && !e.retired);
        this.gridSaid = true;
        return {
          detail: `grid P${cls}${running ? ' (provisional)' : ''}`,
          facts: {
            classPosition: cls,
            position: known(row.position) ? row.position : UNKNOWN_VALUE,
            multiclass: isMulticlass(f, row),
            provisional: running,
          },
        };
      },
      onExpire: () => {
        this.gridQueued = false; // a parked-at-the-flag condition can re-queue it
      },
    });
  }

  /* ---- deferred calls -------------------------------------------------------- */

  /**
   * Offer every ready deferred call in ONE frame, so they coalesce into one
   * cue (the lap, the clock and the grid are one radio call at the line). They
   * wait for a free channel rather than being offered into a shut global gate,
   * where the trigger layer would hold them four seconds and drop them.
   */
  private flushDeferred(frame: TelemetryFrame, now: number, host: SessionCallHost): void {
    if (this.deferred.length === 0) return;
    const keep: Deferred[] = [];
    const ready: Deferred[] = [];
    const anyReady = this.deferred.some((d) => now >= d.readyAt && now <= d.expiresAt);
    for (const d of this.deferred) {
      if (now > d.expiresAt) {
        d.onExpire?.();
        continue;
      }
      // Something is going out: take along anything due within half a second
      // (the finish verdict can land a poll after the lap count), so the lap
      // and the grid are one call, not two fighting for the gate.
      (anyReady && d.readyAt - now <= NEAR_READY_MS ? ready : keep).push(d);
    }
    if (ready.length && (host.busy() || !host.gateOpenSoon(now))) {
      this.deferred = keep.concat(ready);
      return;
    }
    this.deferred = keep;
    for (const d of ready) {
      const built = d.build(frame);
      if (!built) continue;
      if (host.cooling(d.kind, now)) continue;
      host.offer(d.kind, now, built.detail, built.facts);
    }
  }
}
