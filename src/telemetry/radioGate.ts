/**
 * @file src/telemetry/radioGate.ts
 * @module telemetry/radioGate
 *
 * **When the engineer may open his mouth.** Every proactive line — every
 * trigger cue, whichever detector raised it — passes through this gate before
 * it reaches the voice. Answers to the driver's own questions do not: he asked.
 *
 * ## Talk on the straights
 * Real drivers hate radio in the braking zones and through corners ("no
 * talking in the braking zones!"), and CrewChief users lean on its "don't talk
 * in corners" control. So a proactive line is spoken only when the car is on a
 * straight: flat on the throttle, off the brake, wheel near centre, little
 * lateral load, nobody alongside — held for a short dwell, so a corner exit
 * that happens to be flat for three frames does not count.
 *
 * ## Learned straights
 * Each lap teaches the gate where the straights are: lap distance is cut into
 * {@link GATE.learnBins} bins, and each bin remembers how often the car was
 * straight in it and how long it takes to drive through. Once a bin has been
 * seen on two laps the gate can look AHEAD — a line is not started one second
 * before the braking zone, because the gate knows how many seconds of straight
 * are left and how long the sentence takes to say. On a long learned straight
 * the dwell shrinks, so the call lands at the start of the straight instead of
 * a second into it.
 *
 * ## Urgency
 * {@link KIND_URGENCY} sorts kinds into four tiers, highest first:
 *  - `urgent` — rule changes and things that cannot wait (red flag, safety car,
 *    a yellow ahead, a penalty, box this lap, the green flag, blue flags).
 *    These bypass the driving check entirely; only a busy channel holds them.
 *  - `priority` — must-hear, but can wait for the next straight (damage, last
 *    lap, the flag, fuel window). Long hold budget.
 *  - `requested` — reports the DRIVER asked for (the per-lap fuel-target
 *    report). Wait for a straight like any call, with the long budget, and
 *    are never displaced by routine race story landing on the same lap edge.
 *  - `normal` — routine race story. Waits for a straight; dropped if none comes.
 * A kind this module has never heard of is `normal`: a future detector speaks
 * politely until someone decides otherwise.
 *
 * Pure and headless like its siblings: no audio, no I/O. The clock is the
 * frames' own `timestamp`, so a recording replays to the same verdicts.
 */

import type { TelemetryFrame } from './types';
import { UNKNOWN_VALUE } from './types';
import { sessionKeyOf } from './triggers';
import { spokenWordCount } from './engineerPhrases';

/* -------------------------------------------------------------------------- */
/*  Urgency                                                                    */
/* -------------------------------------------------------------------------- */

export type RadioUrgency = 'urgent' | 'priority' | 'requested' | 'normal';

/**
 * Every proactive kind's tier — THE map to extend when a detector adds a kind
 * (an unlisted kind is `normal`). Kept as one explicit table, normals too, so
 * a reviewer sees every decision in one place.
 *
 * `urgent` is "does saying this five seconds late make it wrong or
 * dangerous": a safety car called on the next straight has already cost a pass
 * under yellow, a blue flag called after the car has gone by is noise, "box
 * this lap" after the pit entry is a lost race.
 */
export const KIND_URGENCY: Readonly<Record<string, RadioUrgency>> = {
  redFlag: 'urgent',
  fullCourseYellow: 'urgent',
  sectorYellow: 'urgent',
  penalty: 'urgent',
  fuelCritical: 'urgent',
  raceStart: 'urgent',
  restart: 'urgent',
  yieldTo: 'urgent',

  incident: 'priority',
  finalLap: 'priority',
  checkered: 'priority',
  fuelWindow: 'priority',
  penaltyServed: 'priority',
  sectorClear: 'priority',
  pitWindowOpen: 'priority',

  // Driver-requested reports. The fuel-saving branch's per-lap report; the
  // qualifying branch's lap summary at the line belongs here too.
  fuelTargetLap: 'requested',

  // Qualifying and practice (sessionCalls.ts). The lap summary, pole and
  // place changes, time left and the grid slot are the session's whole story,
  // so they hold for the long budget and are never displaced by routine
  // lines. A sector improvement is stale within seconds — routine.
  qualiLap: 'priority',
  qualiPole: 'priority',
  qualiBeaten: 'priority',
  qualiTimeLeft: 'priority',
  qualiGrid: 'priority',
  practiceLap: 'priority',
  sectorImproved: 'normal',

  // Rival stops (rivalStop.ts): strategy, not a hazard — waits for a straight.
  rivalStop: 'normal',
  rivalRejoin: 'normal',

  fastestLapSelf: 'normal',
  fastestLapField: 'normal',
  positionChange: 'normal',
  rivalPitted: 'normal',
  practicePace: 'normal',
};

/** The tier for a trigger kind; unknown and missing kinds are `normal`. */
export function urgencyOf(kind: string | null | undefined): RadioUrgency {
  return (kind && Object.prototype.hasOwnProperty.call(KIND_URGENCY, kind) && KIND_URGENCY[kind]) || 'normal';
}

/**
 * How long a held line may wait for its moment before it is dropped, ms. An
 * urgent line only ever waits for the channel (an answer playing), so its
 * budget is short. A normal line waits for a straight: replaying 903 recorded
 * laps (14 circuits, 2026-10-02) through this gate, a call arriving at a
 * random moment waited 4.6 s median, 11.6 s at p90 — a 12 s budget dropped
 * 8.6% of them, 15 s drops 3.3%. `priority` and `requested` (25 s) lose 0.3%:
 * Daytona's line sits on the banking, and a call there waits ~11 s for the
 * back straight.
 */
export const HOLD_BUDGET_MS: Readonly<Record<RadioUrgency, number>> = {
  urgent: 4000,
  priority: 25000,
  requested: 25000,
  normal: 15000,
};

/**
 * The one-slot hold's ordering: urgent > priority (must-hear) > requested
 * (driver-asked reports) > normal (routine). A requested report yields only to
 * a must-hear call, never to routine race story on the same lap edge.
 */
export const URGENCY_RANK: Readonly<Record<RadioUrgency, number>> = { urgent: 3, priority: 2, requested: 1, normal: 0 };

/** One line waiting for the channel. `priority` is TRIGGER_PRIORITY (0 when unknown). */
export interface HeldLine {
  text: string;
  kind?: string | null;
  urgency: RadioUrgency;
  priority: number;
  heldAtMs: number;
  expiresAt: number;
}

/** Ordering for the one-slot hold: tier first, then the trigger's own priority. */
export function heldRank(line: Pick<HeldLine, 'urgency' | 'priority'>): number {
  return (URGENCY_RANK[line.urgency] ?? 0) * 1000 + (typeof line.priority === 'number' && Number.isFinite(line.priority) ? line.priority : 0);
}

/**
 * Never more than one held line. A newer line replaces the held one unless the
 * held one outranks it — a fresher race-story call is better than a stale one,
 * but chatter never pushes damage or a yellow off the radio.
 */
export function keepHeld(current: HeldLine | null | undefined, incoming: HeldLine): HeldLine {
  if (!current) return incoming;
  return heldRank(incoming) >= heldRank(current) ? incoming : current;
}

/* -------------------------------------------------------------------------- */
/*  The straight detector                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Thresholds. Measured, not guessed: across 903 recorded laps (14 circuits, GT3
 * to Hypercar) the wheel sits inside ±0.06 on a straight 75% of the time, while
 * an LMP2 in a fast corner can pull 1.2 g with only 0.07 of lock — so steering
 * alone cannot see a fast corner and lateral G has to. Flat out with the wheel
 * straight, |latG| is 0.4 g at Spa and 0.7 g on Daytona's banking (median), so
 * the G limit is 1.0, not the 0.5 a flat road would suggest. With these, the
 * car is straight-ish for 44% of a lap, 36% once the dwell is applied, and has
 * room for a whole ten-word line (the runway) for 16%.
 */
export const GATE = {
  /** Flat: throttle at or above this. */
  throttleMin: 0.9,
  /** Off the brake: at or below this (trail-brake residue counts as braking). */
  brakeMax: 0.05,
  /** Wheel near centre, -1..1 scale. */
  steerMax: 0.1,
  /** Lateral load, g, when the motion block is published. */
  latGMax: 1.0,
  /** The "busy" brake of the old rule, still used when the straights rule is off. */
  busyBrake: 0.6,
  /** Straight-ish must have held this long before a line starts, ms. */
  dwellMs: 800,
  /** …or this long when the learned map says a long straight lies ahead. */
  learnedDwellMs: 300,
  /** No race-story calls for this long after the green flag (start or restart), ms. */
  startQuietMs: 8000,
  /** Below this the car is parked or crawling: nothing to interrupt. */
  stoppedKph: 10,
  /** Lap-distance bins for the learned straights. */
  learnBins: 200,
  /** A bin is trusted once it has been driven through this many times. */
  learnMinVisits: 2,
  /** …and is a straight when the car was straight-ish for this share of its frames. */
  learnStraightRatio: 0.6,
  /** A pass through one bin longer than this is a stop or a crawl — not learned. */
  learnMaxPassMs: 10000,
  /** Piper's speaking rate, words per second, for sizing the runway a line needs. */
  wordsPerSec: 2.8,
  /** Synthesis + radio effect latency before the first word, seconds. */
  speechLeadSec: 0.6,
  /** Runway floor / ceiling, seconds. */
  runwayMinSec: 1.5,
  runwayMaxSec: 5,
  /**
   * How long a held line insists on a straight long enough to say all of it,
   * ms. After this it takes any straight the dwell allows: the map is a
   * PREFERENCE — on a short-straight circuit an absolute rule would hold a
   * call until it expired.
   */
  runwayPatienceMs: 3000,
} as const;

/** Why the gate said what it said — for tests, logs and the replay report. */
export type GateReason =
  | 'clear'
  | 'noFrame'
  | 'stopped'
  | 'caution'
  | 'alongside'
  | 'braking'
  | 'throttle'
  | 'steering'
  | 'cornering'
  | 'settling'
  | 'start'
  | 'runway';

export interface GateVerdict {
  clear: boolean;
  reason: GateReason;
  /** Seconds of learned straight ahead, when the map knows this part of the lap. */
  runwaySec?: number;
}

export interface GateOptions {
  /** The "Only talk on straights" setting. Off = the old rule (hard braking or alongside). */
  onlyStraights: boolean;
  /** Words in the line about to be spoken — sizes the runway it needs. */
  words?: number;
  /** …or the line itself, counted with spokenWordCount. */
  text?: string;
  /** How long the line has already waited, ms — past {@link GATE.runwayPatienceMs} the runway is not required. */
  waitedMs?: number;
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n !== UNKNOWN_VALUE;
}

/** Seconds of straight a line of `words` words needs in front of it. */
export function requiredRunwaySec(words: number | undefined): number {
  const w = finite(words) && words > 0 ? words : 8;
  const sec = GATE.speechLeadSec + w / GATE.wordsPerSec;
  return Math.max(GATE.runwayMinSec, Math.min(GATE.runwayMaxSec, sec));
}

function alongside(frame: TelemetryFrame): boolean {
  return Array.isArray(frame.radar) && frame.radar.some((b) => b && b.alongside);
}

/**
 * Is this ONE frame straight-ish? 'clear' or the first reason it is not. No
 * pedal block (spectating, REST-only) reads as "can't tell" → clear; the old
 * gate behaved the same, and holding every call forever is worse.
 */
export function instantReason(frame: TelemetryFrame): GateReason {
  const p = frame.player?.pedals;
  if (!p) return 'clear';
  if (finite(p.brake) && p.brake > GATE.brakeMax) return 'braking';
  if (finite(p.throttle) && p.throttle < GATE.throttleMin) return 'throttle';
  if (finite(p.steer) && Math.abs(p.steer) > GATE.steerMax) return 'steering';
  const m = frame.player?.motion;
  if (m && finite(m.latG) && Math.abs(m.latG) > GATE.latGMax) return 'cornering';
  return 'clear';
}

/** The player's progress round the lap, 0..1, when the sim publishes it. */
function playerFraction(frame: TelemetryFrame): number | null {
  const me = frame.standings?.find((e) => e && e.isPlayer);
  if (me && finite(me.lapFraction) && me.lapFraction >= 0 && me.lapFraction <= 1) return me.lapFraction;
  const car = frame.trackMap?.cars?.find((c) => c && c.isPlayer);
  if (car && finite(car.lapFraction) && car.lapFraction >= 0 && car.lapFraction <= 1) return car.lapFraction;
  return null;
}

interface Bin {
  frames: number;
  straight: number;
  visits: number;
  passMs: number;
}

/**
 * The gate's memory: how long the car has been straight-ish, when the last
 * green flag was, and the learned straights for this track.
 */
export class RadioGate {
  private straightSince: number | null = null;
  private lastObserved: TelemetryFrame | null = null;
  private lastAt = 0;
  private lastPhase: string | null = null;
  private startQuietUntil = 0;
  private sessionKey = '';
  private trackKey = '';
  private bins: Bin[] = [];
  private bin = -1;
  private binEnteredAt = 0;

  constructor() {
    this.resetLearned();
  }

  /** Forget the learned straights (a new track). */
  private resetLearned(): void {
    this.bins = Array.from({ length: GATE.learnBins }, () => ({ frames: 0, straight: 0, visits: 0, passMs: 0 }));
    this.bin = -1;
  }

  /** Forget everything — the engineer stopped. */
  reset(): void {
    this.straightSince = null;
    this.lastObserved = null;
    this.lastAt = 0;
    this.lastPhase = null;
    this.startQuietUntil = 0;
    this.sessionKey = '';
    this.trackKey = '';
    this.resetLearned();
  }

  /**
   * Feed one frame from the stream. Returns `sessionChanged: true` on the first
   * frame of a new session (the caller resets its radio-silence state there).
   * Learned straights survive a session change at the same track — practice
   * teaches the race.
   */
  observe(frame: TelemetryFrame, atMs?: number): { sessionChanged: boolean } {
    const at = finite(frame.timestamp) && frame.timestamp > 0 ? frame.timestamp : (atMs ?? Date.now());
    let sessionChanged = false;
    if (frame.session) {
      const key = sessionKeyOf(frame);
      if (key !== this.sessionKey) {
        sessionChanged = this.sessionKey !== '';
        this.sessionKey = key;
        this.straightSince = null;
        this.startQuietUntil = 0;
        this.lastPhase = null;
      }
      const track = String(frame.session.track ?? '');
      if (track !== this.trackKey) {
        this.trackKey = track;
        this.resetLearned();
      }
      // A green flag after anything that is not green — the start, or the
      // restart after a safety car or red — buys a few seconds of quiet: the
      // driver is in a pack, and only the green call itself (urgent) speaks.
      const phase = frame.session.phase;
      if (phase === 'green' && this.lastPhase !== null && this.lastPhase !== 'green' && this.lastPhase !== 'garage') {
        this.startQuietUntil = at + GATE.startQuietMs;
      }
      this.lastPhase = phase ?? null;
    }
    // A clock that ran backwards (a replay restarted) is a fresh stream.
    if (at < this.lastAt) this.straightSince = null;
    const straight = instantReason(frame) === 'clear' && !alongside(frame);
    if (straight) {
      if (this.straightSince === null) this.straightSince = at;
    } else {
      this.straightSince = null;
    }
    this.learn(frame, at, instantReason(frame) === 'clear');
    this.lastObserved = frame;
    this.lastAt = at;
    return { sessionChanged };
  }

  private learn(frame: TelemetryFrame, at: number, straight: boolean): void {
    const frac = playerFraction(frame);
    const kph = frame.player?.speedKph;
    if (!frame.player?.pedals || frac === null || (finite(kph) && kph < GATE.stoppedKph) || frame.session?.phase !== 'green') {
      this.bin = -1; // a stop, the pits under caution, no position: not a lap to learn from
      return;
    }
    const b = Math.min(GATE.learnBins - 1, Math.floor(frac * GATE.learnBins));
    const cell = this.bins[b]!;
    cell.frames++;
    if (straight) cell.straight++;
    if (b !== this.bin) {
      if (this.bin >= 0) {
        const prev = this.bins[this.bin]!;
        const pass = at - this.binEnteredAt;
        // Only a pass into the NEXT bin is a clean one (a skip means a dropped
        // feed); a long one is a crawl.
        const next = (this.bin + 1) % GATE.learnBins;
        if (b === next && pass > 0 && pass < GATE.learnMaxPassMs) {
          prev.visits++;
          prev.passMs += pass;
        }
      }
      this.bin = b;
      this.binEnteredAt = at;
    }
  }

  /** Is this bin known, and a straight? null = not learned yet. */
  private binStraight(b: number): boolean | null {
    const cell = this.bins[b]!;
    if (cell.visits < GATE.learnMinVisits || cell.frames === 0) return null;
    return cell.straight / cell.frames >= GATE.learnStraightRatio;
  }

  /**
   * Seconds of learned straight ahead of `frac`, or null when the bin under
   * the car has not been learned yet (the first laps of a session).
   */
  runwaySec(frac: number, atMs?: number): number | null {
    const b0 = Math.min(GATE.learnBins - 1, Math.floor(frac * GATE.learnBins));
    if (this.binStraight(b0) === null) return null;
    let sec = 0;
    for (let i = 0; i < GATE.learnBins; i++) {
      const b = (b0 + i) % GATE.learnBins;
      if (this.binStraight(b) !== true) break;
      const cell = this.bins[b]!;
      let pass = cell.passMs / cell.visits / 1000;
      // Part of the bin under the car is already behind it.
      if (i === 0 && b === this.bin && finite(atMs)) pass = Math.max(0, pass - (atMs - this.binEnteredAt) / 1000);
      sec += pass;
      if (sec > 60) break;
    }
    return sec;
  }

  /**
   * May a proactive line start now? `frame` is normally the last one
   * {@link observe} saw; a frame handed in from outside the stream (a test, a
   * one-off check) is judged on its own, with no dwell and no map.
   */
  verdict(frame: TelemetryFrame | null | undefined, opts: GateOptions): GateVerdict {
    if (!frame) return { clear: true, reason: 'noFrame' };
    if (alongside(frame)) return { clear: false, reason: 'alongside' };
    const p = frame.player?.pedals;
    if (!opts.onlyStraights) {
      // The old rule: deep in the brakes, or side by side.
      if (p && finite(p.brake) && p.brake > GATE.busyBrake) return { clear: false, reason: 'braking' };
      return { clear: true, reason: 'clear' };
    }
    const streamed = frame === this.lastObserved;
    const at = streamed ? this.lastAt : finite(frame.timestamp) ? frame.timestamp : 0;
    const phase = frame.session?.phase;
    // Behind the safety car, on the formation lap, on the grid, on the cool-
    // down lap: nobody is racing, and the straights rule would hold every
    // call for minutes. Only the hard-braking check still applies.
    if (phase && phase !== 'green') {
      if (p && finite(p.brake) && p.brake > GATE.busyBrake) return { clear: false, reason: 'braking' };
      return { clear: true, reason: 'caution' };
    }
    if (streamed && at < this.startQuietUntil) return { clear: false, reason: 'start' };
    const kph = frame.player?.speedKph;
    if (finite(kph) && kph >= 0 && kph < GATE.stoppedKph && p && !(finite(p.throttle) && p.throttle > 0.5)) {
      return { clear: true, reason: 'stopped' };
    }
    const instant = instantReason(frame);
    if (instant !== 'clear') return { clear: false, reason: instant };
    if (!streamed) return { clear: true, reason: 'clear' };

    const frac = playerFraction(frame);
    const runway = frac === null ? null : this.runwaySec(frac, at);
    const need = requiredRunwaySec(opts.words ?? (opts.text !== undefined ? spokenWordCount(opts.text) : undefined));
    const dwell = this.straightSince === null ? 0 : at - this.straightSince;
    if (runway !== null && runway >= need) {
      // A known long straight ahead: go as soon as the car has settled on it.
      if (dwell < GATE.learnedDwellMs) return { clear: false, reason: 'settling', runwaySec: runway };
      return { clear: true, reason: 'clear', runwaySec: runway };
    }
    const patient = !(finite(opts.waitedMs) && opts.waitedMs >= GATE.runwayPatienceMs);
    if (runway !== null && patient) return { clear: false, reason: 'runway', runwaySec: runway };
    if (dwell < GATE.dwellMs) return { clear: false, reason: 'settling', ...(runway !== null ? { runwaySec: runway } : {}) };
    return { clear: true, reason: 'clear', ...(runway !== null ? { runwaySec: runway } : {}) };
  }
}
