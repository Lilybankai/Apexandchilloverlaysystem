/**
 * @file src/telemetry/rivalStop.ts
 * @module telemetry/rivalStop
 *
 * **What a rival's pit stop means for you — and silence when it means nothing.**
 * The upgraded rival-stop call behind the engineer's `rivalStop` and
 * `rivalRejoin` trigger kinds. It replaces the old `rivalPitted` edge, which
 * spoke every time either class neighbour touched the pit lane and said only
 * that they had. The owner's brief (Carl, 2026-10-02) was that the information
 * must be CRITICAL — so this module's job is mostly to stay quiet.
 *
 * ## Which rivals
 * Only the class car directly AHEAD and directly BEHIND, plus the car TWO
 * places ahead when — and only when — a measured pit loss says its stop drops
 * it behind you AND you have already made your own stop (before that, it just
 * comes back past when you box). Never the field; never another class. A neighbour a lap or
 * more away (off the unfloored `classLapsBehindExact`) is not racing you for
 * the place: a stop cannot swap you, so it is not news.
 *
 * ## What it says, from measured numbers only
 * The pit loss is {@link PitLossModel}'s — the median of stops actually watched
 * this session (drive-throughs excluded), used only once it holds
 * {@link MIN_LOSS_SAMPLES} stops. With one:
 *
 *   - car ahead stops: its gap to you minus the loss is where it rejoins —
 *     "Brown's boxed — projected out about 12 seconds behind you." Spoken when
 *     that DROPS it behind you, or leaves it within {@link CLOSE_REJOIN_SEC}.
 *   - car behind stops from within {@link UNDERCUT_WINDOW_SEC} while you still
 *     have a stop to make: "expect them close after your stop" — the undercut,
 *     stated as a fact about timing, never a verdict on whether it works (there
 *     is no fresh-tyre model to back a verdict).
 *
 * Without a measured loss there is no projection: the car ahead/behind is
 * named only when it is in a direct fight with you ({@link FACT_ONLY_MAX_GAP_SEC}).
 * Under a full-course yellow the loss shrinks by an unknown amount, so the
 * same fact-only rule applies.
 *
 * An energy clause rides along when energy is the budget that sets YOUR stop
 * and you had at least a lap more of it than the rival as they came in — the
 * per-car fraction LMU publishes, divided by your own measured burn, the same
 * same-class arithmetic as `veLapsInHandVsNext`.
 *
 * ## One follow-up, only when it changes the picture
 * When an announced rival rejoins, the gap is read once it settles
 * ({@link REJOIN_SETTLE_MS}). It is spoken only if the car came out within
 * {@link REJOIN_CLOSE_SEC} of you AND either nothing was projected or the
 * projection missed by {@link REJOIN_MISS_SEC} or more (or landed on the other
 * side of you). "As predicted" is not news.
 *
 * ## What is not a stop
 *   - a DRIVE-THROUGH: the car is never stationary in the lane. A stop is
 *     confirmed only once the car's published speed has read stationary for
 *     {@link STATIONARY_HOLD_MS}; a lane visit that never stops is dropped.
 *     (A provider with no per-car speed falls back to a dwell of
 *     {@link NO_SPEED_CONFIRM_MS}, which cannot tell the two apart.)
 *   - a RETIREMENT: `retired` cancels everything; a car that was already at a
 *     standstill on track before it "entered the pits" was recovered to the
 *     garage, not boxed; and a car still in the lane after
 *     {@link MAX_STOP_MS} gets no follow-up.
 *   - lap one, and anything while YOU are in the pit lane — your own gap is
 *     meaningless then and you are busy.
 *
 * ## Coalescing
 * Confirmed candidates wait {@link BURST_HOLD_MS} so a pit-cycle burst (or a
 * safety-car stampede) becomes one line about the rival that matters most, with
 * the other neighbour folded in by name and the rest counted. A call about the
 * car two ahead waits longer ({@link AHEAD2_HOLD_MS}) for a direct neighbour to
 * fold into it. Each rival has its own {@link RIVAL_COOLDOWN_MS}.
 *
 * Pure and headless: frames in, at most one event per call out. The trigger
 * layer owns the global gates; this owns *whether a stop is worth a line*.
 */

import { UNKNOWN_VALUE } from './types';
import type { StandingEntry, TelemetryFrame } from './types';
import { PitLossModel } from './pitExit';

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                    */
/* -------------------------------------------------------------------------- */

/** A projected rejoin within this many seconds of you (either side) is a fight. */
export const CLOSE_REJOIN_SEC = 15;
/** Car behind boxing from within this gap, while you still have to stop, is the undercut. */
export const UNDERCUT_WINDOW_SEC = 5;
/** Without a measured loss, a neighbour is only named when this close. */
export const FACT_ONLY_MAX_GAP_SEC = 5;
/** Projected rejoin closer than this to you reads "right around you". */
export const LEVEL_SEC = 1.5;
/** Read the rejoin gap this long after the car leaves the lane. */
export const REJOIN_SETTLE_MS = 4000;
/** The follow-up is only spoken when the car came out this close to you. */
export const REJOIN_CLOSE_SEC = 10;
/** …and only when the projection missed by at least this much. */
export const REJOIN_MISS_SEC = 1;
/** Road speed (m/s) at or below which a car in the lane counts as stopped. */
export const STATIONARY_MPS = 1;
/** How long it must stay stopped before it is a stop. */
export const STATIONARY_HOLD_MS = 1000;
/** Lane dwell that confirms a stop when the provider publishes no per-car speed. */
export const NO_SPEED_CONFIRM_MS = 5000;
/** Last running speed (m/s) below which a pit "entry" was a recovery to the garage. */
export const RECOVERED_MPS = 3;
/** A car in the lane longer than this is retired or rebuilding — no follow-up. */
export const MAX_STOP_MS = 300_000;
/** Candidates are held this long so simultaneous stops become one line. */
export const BURST_HOLD_MS = 4000;
/**
 * A call about the car TWO ahead waits this long for a direct neighbour's stop
 * to fold into it. Without the wait, the lesser line won the global gate and
 * the car directly ahead — boxing a lap later in the same cycle — went unsaid
 * (synthetic multiclass replay, 2026-10-02).
 */
export const AHEAD2_HOLD_MS = 15_000;
/**
 * Stops the pit-loss median must hold before anything is projected from it.
 * One odd stop (a damage repair, a stop-go) is a median of one; three makes
 * the median robust to a single outlier. Until then: fact-only.
 */
export const MIN_LOSS_SAMPLES = 3;
/** Class cars entering the lane within this of the lead stop are counted with it. */
export const BURST_COUNT_MS = 20_000;
/** How long after a near neighbour leaves the lane its position shuffle counts as settling. */
export const PIT_SHUFFLE_SETTLE_MS = 10_000;
/** The same rival is not announced twice inside this. */
export const RIVAL_COOLDOWN_MS = 120_000;

/* -------------------------------------------------------------------------- */
/*  Output                                                                      */
/* -------------------------------------------------------------------------- */

/** Why a stop is worth a line — selects the phrase bank. */
export type RivalStopOutcome =
  /** Car ahead projected to rejoin BEHIND you. */
  | 'dropsBehind'
  /** Projected to rejoin within {@link LEVEL_SEC} of you. */
  | 'level'
  /** Car ahead projected to rejoin still ahead, within {@link CLOSE_REJOIN_SEC}. */
  | 'closeAhead'
  /** Car behind projected to rejoin within {@link CLOSE_REJOIN_SEC} behind. */
  | 'closeBehind'
  /** Car behind boxed from close range while you still have to stop. */
  | 'undercut'
  /** No measured loss (or a yellow): the fact, for a neighbour in a direct fight. */
  | 'fact';

export interface RivalStopEvent {
  kind: 'rivalStop' | 'rivalRejoin';
  /** Slot of the rival the line is about — the trigger layer hands it back on a dropped offer. */
  slotId: number;
  /** Tuning-log rendering. */
  detail: string;
  /** Machine-readable facts for the phrase layer (see engineerPhrases). */
  facts: Record<string, string | number | boolean>;
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                   */
/* -------------------------------------------------------------------------- */

function known(n: number | undefined): n is number {
  return typeof n === 'number' && n !== UNKNOWN_VALUE && Number.isFinite(n);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Signed race gap between the player and a rival: + = rival ahead of you. */
type GapRead = { sec: number } | { laps: number };

/**
 * Race gap, rival relative to you, from the same chain the timing sheet uses.
 * Laps apart come off the UNFLOORED `classLapsBehindExact` — never the
 * difference of two floored counts. Seconds from the class-leader gap, then the
 * overall-leader gap (LMU zeroes it for lapped cars, so it is only ever a
 * lead-lap fallback), then the relative feed's on-track gap for a same-lap car.
 */
export function rivalGap(frame: TelemetryFrame, me: StandingEntry, rival: StandingEntry): GapRead | null {
  if (known(me.classLapsBehindExact) && known(rival.classLapsBehindExact)) {
    const d = me.classLapsBehindExact - rival.classLapsBehindExact;
    if (Math.abs(d) >= 1) return { laps: d };
  }
  if (known(me.gapToClassLeaderSec) && known(rival.gapToClassLeaderSec)) {
    return { sec: me.gapToClassLeaderSec - rival.gapToClassLeaderSec };
  }
  if (known(me.gapToLeaderSec) && known(rival.gapToLeaderSec) && me.lapsBehind === rival.lapsBehind) {
    return { sec: me.gapToLeaderSec - rival.gapToLeaderSec };
  }
  const rel = frame.relative?.find((r) => r.slotId === rival.slotId);
  if (rel && rel.lapsDifference === 0 && known(rel.relativeGapSec) && Math.abs(rel.relativeGapSec) <= 30) {
    return { sec: rel.relativeGapSec };
  }
  return null;
}

function secOf(g: GapRead | null | undefined): number | undefined {
  return g && 'sec' in g ? g.sec : undefined;
}

/** The player's row; null while they have no class to race in. */
function meOf(frame: TelemetryFrame): StandingEntry | null {
  const me = frame.standings?.find((e) => e.isPlayer);
  return me && me.carClass && known(me.classPosition) ? me : null;
}

function playerInPit(frame: TelemetryFrame, me: StandingEntry): boolean {
  return me.inPit === true || (frame.player?.pit?.phase ?? 'none') !== 'none';
}

/**
 * Whether the player still has a stop to make. `true` when it cannot be told —
 * the undercut line is the cautious one to say, and it is only said for a car
 * within {@link UNDERCUT_WINDOW_SEC} anyway.
 */
function playerNeedsStop(frame: TelemetryFrame): boolean {
  const f = frame.fuel;
  if (!f || !known(f.lapsToFinish)) return true;
  const byFuel = known(f.lapsRemaining) ? f.lapsRemaining : Infinity;
  const byEnergy = known(f.virtualEnergyLapsRemaining) ? f.virtualEnergyLapsRemaining! : Infinity;
  const tighter = Math.min(byFuel, byEnergy);
  return !Number.isFinite(tighter) || tighter < f.lapsToFinish;
}

/** Whole laps of energy you have over a rival's fraction at pit entry, or undefined. */
function energyLapsInHand(frame: TelemetryFrame, rivalVe: number | undefined): number | undefined {
  const f = frame.fuel;
  if (!f || rivalVe === undefined || !(rivalVe > 0)) return undefined;
  const myLaps = f.virtualEnergyLapsRemaining;
  const perLap = f.virtualEnergyPerLapPct;
  if (!known(myLaps) || !known(perLap) || perLap! <= 0) return undefined;
  // Only when energy is what sets YOUR stop — otherwise its laps say nothing
  // about when you come in.
  if (known(f.lapsRemaining) && f.lapsRemaining < myLaps!) return undefined;
  const margin = myLaps! - (Math.min(1, rivalVe) * 100) / perLap!;
  return margin >= 1 ? Math.floor(margin) : undefined;
}

/** Surname-ish name, the radio habit shared with engineerCommands. */
function radioName(e: StandingEntry): string {
  const name = (e.driverName || '').trim();
  if (!name) return e.carNumber ? `car ${e.carNumber}` : 'the car';
  const parts = name.split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

type Role = 'ahead' | 'behind' | 'ahead2' | 'none';

/** The last frame a car was out on track — what a stop is measured from. */
interface Running {
  classPosition?: number;
  gap?: GapRead | null;
  ve?: number;
  speedMps?: number;
  pitStops?: number;
}

interface Stop {
  enteredAt: number;
  entry: Running;
  role: Role;
  /** Player's own completed stops when the rival came in. */
  myStops?: number;
  stillSince: number | null;
  speedSeen: boolean;
  /** 'pending' → 'confirmed' (a real stop) → 'decided' (called or judged not worth it). */
  state: 'pending' | 'confirmed' | 'decided';
  /** Recovered to the garage / retired — never called. */
  void: boolean;
  confirmedAt?: number;
}

interface Track {
  inPit: boolean;
  running: Running;
  stop: Stop | null;
  lastCalledAt?: number;
  /** Armed by an announced stop: the projection (signed, + = ahead of you) to judge the rejoin by. */
  followUp?: { projected?: number; dueAt?: number; name: string };
  /** A near neighbour left the lane: its rejoin shuffle settles until this time. */
  settleUntil?: number;
}

interface Candidate {
  slotId: number;
  rank: number;
  name: string;
  facts: Record<string, string | number | boolean>;
  projected?: number;
  detail: string;
}

/* -------------------------------------------------------------------------- */
/*  The watcher                                                                 */
/* -------------------------------------------------------------------------- */

export class RivalStopWatch {
  private readonly loss = new PitLossModel();
  private tracks = new Map<number, Track>();
  /** Class-car lane entries (ms), for counting a burst. */
  private entries: number[] = [];
  private held: Candidate[] = [];
  private heldSince = 0;
  private prevMyClassPos: number | undefined;
  private prevMyStops: number | undefined;

  public reset(): void {
    this.loss.reset();
    this.tracks.clear();
    this.entries = [];
    this.held = [];
    this.heldSince = 0;
    this.prevMyClassPos = undefined;
    this.prevMyStops = undefined;
  }

  /**
   * True while a class car that was within two places of you is in the lane,
   * or left it less than {@link PIT_SHUFFLE_SETTLE_MS} ago — the position
   * shuffle a neighbour's stop causes is this module's story ("projected out
   * behind you"), not an overtake for `positionChange` to announce.
   */
  public neighbourPitActive(now: number): boolean {
    for (const t of this.tracks.values()) {
      // Capped: a car parked for a long repair must not mute position calls
      // for the rest of the stint.
      if (t.inPit && t.stop && t.stop.role !== 'none' && !t.stop.void && now - t.stop.enteredAt < 90_000) {
        return true;
      }
      if (t.settleUntil !== undefined && now < t.settleUntil) return true;
    }
    return false;
  }

  /** The trigger layer could not take the line — no follow-up for a call never made. */
  public dropped(slotId: number, kind: RivalStopEvent['kind']): void {
    if (kind !== 'rivalStop') return;
    const t = this.tracks.get(slotId);
    if (t) t.followUp = undefined;
  }

  /** Advance one frame; returns at most one event. */
  public update(frame: TelemetryFrame, now: number): RivalStopEvent | null {
    this.loss.update(frame);
    const me = meOf(frame);
    if (!me) {
      this.prevMyClassPos = undefined;
      return null;
    }
    const myPit = playerInPit(frame, me);
    const myPos = this.prevMyClassPos;
    const fcy =
      frame.session.phase === 'fullCourseYellow' || frame.session.flag === 'doubleYellow';
    const seen = new Set<number>();

    for (const e of frame.standings) {
      if (e.isPlayer || e.carClass !== me.carClass) continue;
      seen.add(e.slotId);
      let t = this.tracks.get(e.slotId);
      if (!t) {
        // First sighting is a baseline, never an edge.
        t = { inPit: e.inPit === true, running: {}, stop: null };
        this.tracks.set(e.slotId, t);
        if (!t.inPit) t.running = this.runningOf(frame, me, e, myPit);
        continue;
      }

      if (e.retired === true) {
        if (t.stop) t.stop.void = true;
        t.followUp = undefined;
        t.inPit = e.inPit === true;
        continue;
      }

      const inPit = e.inPit === true;
      if (!t.inPit && inPit) {
        // Into the lane: the stop is measured from the last frame on track.
        const role: Role =
          myPos === undefined || !known(t.running.classPosition)
            ? 'none'
            : t.running.classPosition === myPos - 1
              ? 'ahead'
              : t.running.classPosition === myPos + 1
                ? 'behind'
                : t.running.classPosition === myPos - 2
                  ? 'ahead2'
                  : 'none';
        t.stop = {
          enteredAt: now,
          entry: t.running,
          role,
          myStops: this.prevMyStops,
          stillSince: null,
          speedSeen: false,
          state: 'pending',
          // Already at a standstill on track before "entering": recovered to
          // the garage after stopping out on circuit, not a pit stop.
          void: known(t.running.speedMps) && t.running.speedMps! < RECOVERED_MPS,
        };
        this.entries.push(now);
      } else if (t.inPit && !inPit) {
        // Out of the lane. A stop never confirmed was a drive-through (or a
        // lane visit too short to be service) — nothing to say, nothing to follow.
        if (t.followUp && t.stop && t.stop.state === 'decided' && now - t.stop.enteredAt <= MAX_STOP_MS) {
          t.followUp.dueAt = now + REJOIN_SETTLE_MS;
        } else {
          t.followUp = undefined;
        }
        if (t.stop && t.stop.role !== 'none' && !t.stop.void) t.settleUntil = now + PIT_SHUFFLE_SETTLE_MS;
        t.stop = null;
      }

      if (inPit && t.stop && t.stop.state === 'pending' && !t.stop.void) {
        const s = t.stop;
        if (known(e.speedMps)) {
          s.speedSeen = true;
          if (e.speedMps <= STATIONARY_MPS) {
            if (s.stillSince === null) s.stillSince = now;
            if (now - s.stillSince >= STATIONARY_HOLD_MS) s.state = 'confirmed';
          } else {
            s.stillSince = null;
          }
        } else if (!s.speedSeen && now - s.enteredAt >= NO_SPEED_CONFIRM_MS) {
          s.state = 'confirmed';
        }
        if (s.state === 'confirmed') {
          s.confirmedAt = now;
          this.consider(frame, e, t, now, myPit, fcy);
        }
      }
      if (inPit && t.stop && now - t.stop.enteredAt > MAX_STOP_MS) t.followUp = undefined;

      t.inPit = inPit;
      if (!inPit) t.running = this.runningOf(frame, me, e, myPit);
    }

    // Cars that left the session take their state with them.
    if (seen.size !== this.tracks.size) {
      for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.tracks.delete(id);
    }
    if (this.entries.length && now - this.entries[0]! > 2 * BURST_COUNT_MS) {
      this.entries = this.entries.filter((t) => now - t <= 2 * BURST_COUNT_MS);
    }

    this.prevMyClassPos = myPit ? undefined : me.classPosition;
    this.prevMyStops = known(me.pitStops) ? me.pitStops : undefined;

    if (myPit) {
      // Your own stop: nothing about a rival is worth saying over it, and a
      // held line would be stale by the time you rejoin.
      this.held = [];
      return null;
    }
    return this.flushHeld(now) ?? this.followUps(frame, me, now);
  }

  /* ---- internals ---------------------------------------------------------- */

  private runningOf(frame: TelemetryFrame, me: StandingEntry, e: StandingEntry, myPit: boolean): Running {
    const near =
      known(e.classPosition) && Math.abs(e.classPosition! - me.classPosition!) <= 2 && !myPit;
    return {
      classPosition: known(e.classPosition) ? e.classPosition : undefined,
      gap: near ? rivalGap(frame, me, e) : null,
      ve: typeof e.virtualEnergy === 'number' && Number.isFinite(e.virtualEnergy) ? e.virtualEnergy : undefined,
      speedMps: known(e.speedMps) ? e.speedMps : undefined,
      pitStops: known(e.pitStops) ? e.pitStops : undefined,
    };
  }

  /** A confirmed stop → maybe a held candidate. Marks the stop decided either way. */
  private consider(
    frame: TelemetryFrame,
    e: StandingEntry,
    t: Track,
    now: number,
    myPit: boolean,
    fcy: boolean,
  ): void {
    const s = t.stop!;
    s.state = 'decided';
    if (s.role === 'none' || myPit) return;
    const lap = frame.session.currentLap;
    if (!known(lap) || lap <= 1 || !known(e.lapsCompleted) || e.lapsCompleted < 1) return;
    if (t.lastCalledAt !== undefined && now - t.lastCalledAt < RIVAL_COOLDOWN_MS) return;

    const g = secOf(s.entry.gap);
    if (g === undefined) return; // lapped (a stop cannot swap you) or no honest gap
    // The order and the gap must agree about which side the car is on — a
    // torn read is not something to project from.
    if ((s.role === 'behind') !== (g < 0)) return;
    const measured = this.loss.estimate();
    const est = fcy || !measured || measured.samples < MIN_LOSS_SAMPLES ? null : measured;
    const name = radioName(e);
    const facts: Record<string, string | number | boolean> = {
      name: e.driverName,
      where: s.role,
      gapSec: round1(Math.abs(g)),
      stationaryVerified: s.speedSeen,
    };
    if (fcy) facts.fcy = true;

    let outcome: RivalStopOutcome | null = null;
    let projected: number | undefined;
    let rank = 0;
    const youStillStop =
      playerNeedsStop(frame) &&
      !(s.myStops !== undefined && s.entry.pitStops !== undefined && s.myStops > s.entry.pitStops);

    if (est) {
      facts.lossSec = est.lossSec;
      facts.lossSamples = est.samples;
      projected = g - est.lossSec; // + = still ahead of you after the stop
      facts.rejoinSec = round1(projected);
      if (s.role === 'ahead2') {
        // Two ahead only matters when its stop hands you the place for good:
        // you have already made yours (or need none). Before your own stop it
        // simply comes back past when you box — not news.
        if (projected < 0 && !youStillStop) outcome = 'dropsBehind';
        rank = 20;
      } else if (s.role === 'ahead') {
        if (Math.abs(projected) < LEVEL_SEC) outcome = 'level';
        else if (projected < 0) outcome = 'dropsBehind';
        else if (projected <= CLOSE_REJOIN_SEC) outcome = 'closeAhead';
        rank = 30;
      } else if (s.role === 'behind') {
        if (-g <= UNDERCUT_WINDOW_SEC && youStillStop) outcome = 'undercut';
        else if (-projected <= CLOSE_REJOIN_SEC) outcome = 'closeBehind';
        rank = 25;
      }
    } else if (s.role !== 'ahead2' && Math.abs(g) <= FACT_ONLY_MAX_GAP_SEC) {
      outcome = s.role === 'behind' && youStillStop ? 'undercut' : 'fact';
      rank = s.role === 'ahead' ? 15 : 10;
    }
    if (!outcome) return;
    facts.outcome = outcome;

    if (s.role !== 'behind' || outcome === 'undercut') {
      if (youStillStop) {
        const inHand = energyLapsInHand(frame, s.entry.ve);
        if (inHand !== undefined) facts.energyLapsInHand = inHand;
      }
    }

    if (this.held.length === 0) this.heldSince = now;
    this.held.push({
      slotId: e.slotId,
      rank,
      name,
      facts,
      projected,
      detail: `${s.role} rival boxed (${outcome})`,
    });
  }

  /** Emit the held burst as one line about the rival that matters most. */
  private flushHeld(now: number): RivalStopEvent | null {
    if (!this.held.length) return null;
    const direct = this.held.some((c) => c.facts.where !== 'ahead2');
    if (now - this.heldSince < (direct ? BURST_HOLD_MS : AHEAD2_HOLD_MS)) return null;
    const held = this.held.sort((a, b) => b.rank - a.rank);
    this.held = [];
    // A stop that ended while the line was held is old news by now.
    const live = held.filter((c) => this.tracks.get(c.slotId)?.inPit === true);
    const lead = live[0];
    if (!lead) return null;
    const facts = { ...lead.facts };
    const other = live.find((c) => c !== lead);
    if (other) facts.alsoName = String(other.facts.name);
    const leadEntered = this.tracks.get(lead.slotId)?.stop?.enteredAt ?? now;
    const burst = this.entries.filter((t) => Math.abs(t - leadEntered) <= BURST_COUNT_MS).length;
    const others = burst - 1 - (other ? 1 : 0);
    if (others > 0) facts.othersInPit = others;

    for (const c of live) {
      const t = this.tracks.get(c.slotId);
      if (t) t.lastCalledAt = now;
    }
    const t = this.tracks.get(lead.slotId);
    if (t) t.followUp = { projected: lead.projected, name: lead.name };
    return { kind: 'rivalStop', slotId: lead.slotId, detail: lead.detail, facts };
  }

  /** The one follow-up per announced stop, when it is due and only if it matters. */
  private followUps(frame: TelemetryFrame, me: StandingEntry, now: number): RivalStopEvent | null {
    for (const [slotId, t] of this.tracks) {
      const f = t.followUp;
      if (!f || f.dueAt === undefined || now < f.dueAt) continue;
      t.followUp = undefined; // one read, spoken or not
      if (t.inPit) continue;
      const row = frame.standings.find((e) => e.slotId === slotId);
      if (!row) continue;
      const gap = secOf(rivalGap(frame, me, row));
      if (gap === undefined || Math.abs(gap) > REJOIN_CLOSE_SEC) continue;
      if (
        f.projected !== undefined &&
        Math.abs(gap - f.projected) < REJOIN_MISS_SEC &&
        Math.sign(gap) === Math.sign(f.projected)
      ) {
        continue; // came out where we said — not news
      }
      const facts: Record<string, string | number | boolean> = {
        name: row.driverName,
        where: gap >= 0 ? 'ahead' : 'behind',
        gapSec: round1(Math.abs(gap)),
      };
      if (f.projected !== undefined) facts.projectedSec = round1(f.projected);
      return { kind: 'rivalRejoin', slotId, detail: 'rival rejoined', facts };
    }
    return null;
  }
}
