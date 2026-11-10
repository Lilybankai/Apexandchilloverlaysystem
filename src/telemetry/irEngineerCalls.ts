/**
 * @file src/telemetry/irEngineerCalls.ts
 * @module telemetry/irEngineerCalls
 *
 * **The engineer's iRacing-only calls.** iRacing judges a driver in incident
 * points, shows its flags per car (black, meatball, the black-and-white
 * warning, a disqualification at the incident limit) and runs full-course
 * cautions with a pace car — none of which LMU has, and none of which the
 * generic detectors in `triggers.ts` can read. This module turns the frame's
 * {@link IracingRaceControl} block (built by `iracing/irRaceControl.ts`) and
 * the incident count (the Track Limits block on iRacing) into candidates, and
 * offers them through the SAME gates as every other kind — it is owned by
 * `EngineerTriggers` the way `sessionCalls.ts` is.
 *
 * | call            | kind          | when                                                    |
 * |-----------------|---------------|---------------------------------------------------------|
 * | incidents       | `irIncident`  | the count settles after a rise: "plus four, contact — twelve of seventeen" |
 * | black flag      | `penalty`     | the player's black flag appears (`flag: 'black'`)       |
 * | served          | `penaltyServed` | it clears, not by a DQ                                |
 * | warning         | `penalty`     | the furled black-and-white (`flag: 'furled'`)           |
 * | disqualified    | `penalty`     | the DQ bit (`flag: 'dq'`); incident calls stop          |
 * | meatball / tow  | `irRepair`    | the repair flag; a tow to the pits begins               |
 * | pits / restart  | `irCaution`   | under caution: pits open/closed, one lap to green       |
 * | local yellow    | `sectorYellow`| a yellow at the player's station, no caution            |
 * | out lap         | `qualiTimeLeft` | a lap-limited qualifying run leaves the pits          |
 *
 * ## Incidents: one call per incident, not one per point
 * A spin is 2x and the car leaving the track a moment later is another 1x
 * (measured: 0→1→2 inside 1.1 s, then 3 eleven seconds later in the 2026-11-10
 * crash), so a rise waits {@link INCIDENT_SETTLE_MS} for the count to stop
 * moving and is called once with the whole step. The type is named only when
 * the step was a single iRacing amount (1x off track, 2x loss of control, 4x
 * contact); a mixed step is just "plus three". Outside a race only contact
 * (4x and up) or a count near the limit is worth the radio — an off in
 * practice is something the driver saw, and in qualifying the lap summary
 * already says the lap will not count.
 *
 * Penalty REASONS are not published by iRacing (plan-iracing-local §1.9), so
 * the black flag is never called a drive-through or a stop-and-go here.
 */

import { UNKNOWN_VALUE } from './types';
import type { IracingRaceControl, TelemetryFrame } from './types';

/** How long the incident count must hold still before a rise is called, ms. */
export const INCIDENT_SETTLE_MS = 2500;

/** Outside a race, a step this large (contact) is still called. */
const NON_RACE_MIN_STEP = 4;

/** Points-to-the-limit at which every call carries the warning. */
export const INCIDENT_WARN_LEFT = 4;

/**
 * How long after the green the start position is read, ms. At the green itself:
 * the grid order still holds there (cars still short of the line count lap -1),
 * while a few seconds later a stalled car ahead already reads as a place made.
 */
const START_POSITION_SETTLE_MS = 0;

/** What this module offers — the trigger layer's own kinds. */
export type IrCallKind = 'irIncident' | 'irRepair' | 'irCaution' | 'penalty' | 'penaltyServed' | 'sectorYellow' | 'qualiTimeLeft';

/** The gates `EngineerTriggers` lends (same shape as the session calls' host). */
export interface IrCallHost {
  offer(kind: IrCallKind, atMs: number, detail: string, facts: Record<string, string | number | boolean>): boolean;
  cooling(kind: IrCallKind, atMs: number): boolean;
}

function known(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n !== UNKNOWN_VALUE;
}

/** iRacing's incident amounts, as the radio names them. */
export function incidentType(step: number): string {
  if (step === 1) return 'offTrack';
  if (step === 2) return 'lossOfControl';
  if (step === 4) return 'contact';
  return '';
}

export class IrEngineerCalls {
  private primed = false;
  private prev: IracingRaceControl | null = null;
  private prevInPit = true;
  private incPrev: number = UNKNOWN_VALUE;
  /** A rise waiting to settle: where it started, its single steps, when it last moved. */
  private incPending: { from: number; steps: number[]; lastAt: number } | null = null;
  private dq = false;
  private outLapSaid = false;
  private greenAt = 0;
  private startPos: number = UNKNOWN_VALUE;
  private startClassPos: number = UNKNOWN_VALUE;

  public reset(): void {
    this.primed = false;
    this.prev = null;
    this.prevInPit = true;
    this.incPrev = UNKNOWN_VALUE;
    this.incPending = null;
    this.dq = false;
    this.outLapSaid = false;
    this.greenAt = 0;
    this.startPos = UNKNOWN_VALUE;
    this.startClassPos = UNKNOWN_VALUE;
  }

  /**
   * Where we started the race (overall, and in class), read a few seconds
   * after the green from the live order — {@link UNKNOWN_VALUE} before then
   * or when the engineer joined the race late.
   */
  public startPosition(): { position: number; classPosition: number } {
    return { position: this.startPos, classPosition: this.startClassPos };
  }

  /** Seed from the priming frame: levels only. */
  public observe(frame: TelemetryFrame): void {
    if (frame.source !== 'iracing') return;
    this.record(frame);
    this.primed = true;
  }

  /** Advance one frame. A no-op for every sim but iRacing. */
  public detect(frame: TelemetryFrame, now: number, host: IrCallHost): void {
    if (frame.source !== 'iracing') return;
    const rc = frame.iracing;
    if (!this.primed || !rc) {
      // No block = not our car (spectating) or a replay: re-prime when it returns.
      this.primed = !!rc;
      this.record(frame);
      return;
    }
    const prev = this.prev;
    const race = frame.session.type === 'race';
    const me = frame.standings.find((e) => e.isPlayer);

    this.watchStart(frame, now);
    this.detectIncidents(frame, rc, now, host, race);

    if (prev) {
      // ---- the stewards ----------------------------------------------------
      if (rc.disqualified && !prev.disqualified) {
        this.dq = true;
        this.incPending = null;
        const pts = frame.player?.trackLimits?.points;
        host.offer('penalty', now, 'disqualified', {
          flag: 'dq',
          penaltyType: 'disqualification',
          ...(known(pts) ? { points: rc.incidentLimit > pts ? rc.incidentLimit : pts } : {}),
          ...(rc.incidentLimit > 0 ? { pointsLimit: rc.incidentLimit } : {}),
        });
      } else if (rc.black && !prev.black && !rc.disqualified) {
        host.offer('penalty', now, 'black flag', { flag: 'black', penaltyType: 'black flag' });
      } else if (!rc.black && prev.black && !rc.disqualified && !this.dq) {
        host.offer('penaltyServed', now, 'black flag cleared', { flag: 'black' });
      } else if (rc.furled && !prev.furled && !rc.black && !rc.disqualified) {
        host.offer('penalty', now, 'black-and-white warning', { flag: 'furled' });
      }

      // ---- the car ---------------------------------------------------------
      if (rc.meatball && !prev.meatball && !this.dq) {
        host.offer('irRepair', now, 'meatball — repairs required', { what: 'meatball' });
      }
      if (rc.towSec > 0 && prev.towSec <= 0 && !this.dq) {
        host.offer('irRepair', now, `towed to the pits — ${Math.round(rc.towSec)} s`, {
          what: 'tow',
          towSec: Math.round(rc.towSec),
        });
      }

      // ---- cautions (a race's full-course yellow; the call itself is
      // triggers.ts' fullCourseYellow, which carries the pits state) ---------
      if (race && rc.caution && prev.caution) {
        if (rc.oneLapToGreen && !prev.oneLapToGreen) {
          host.offer('irCaution', now, 'one lap to green', { what: 'oneToGreen' });
        } else if (rc.pitsOpen !== prev.pitsOpen) {
          host.offer('irCaution', now, rc.pitsOpen ? 'pits open' : 'pits closed', {
            what: rc.pitsOpen ? 'pitsOpen' : 'pitsClosed',
          });
        }
      }

      // ---- a local yellow: iRacing flags the player's own station ----------
      if (rc.localYellow && !prev.localYellow && !rc.caution && frame.session.phase === 'green') {
        host.offer('sectorYellow', now, 'local yellow', { sectors: '1,2,3', all: true, sim: 'iracing' });
      }
    }

    // ---- a lap-limited qualifying run starts: the out lap ------------------
    const inPit = me ? me.inPit === true : true;
    if (
      frame.session.type === 'qualifying' &&
      rc.lapLimit > 0 &&
      !this.outLapSaid &&
      me &&
      this.prevInPit &&
      !inPit &&
      rc.outLap
    ) {
      this.outLapSaid = host.offer('qualiTimeLeft', now, `out lap — ${rc.lapLimit} timed`, {
        verdict: 'outLap',
        lapLimit: rc.lapLimit,
      });
    }

    this.record(frame);
  }

  /* ---- incidents ------------------------------------------------------------ */

  private detectIncidents(
    frame: TelemetryFrame,
    rc: IracingRaceControl,
    now: number,
    host: IrCallHost,
    race: boolean,
  ): void {
    const pts = frame.player?.trackLimits?.points;
    if (!known(pts) || pts < 0) return;
    if (!known(this.incPrev) || pts < this.incPrev) {
      // First sight, or the count went DOWN (a new session the key missed).
      this.incPrev = pts;
      this.incPending = null;
      return;
    }
    if (pts > this.incPrev) {
      const step = pts - this.incPrev;
      if (this.incPending) {
        this.incPending.steps.push(step);
        this.incPending.lastAt = now;
      } else {
        this.incPending = { from: this.incPrev, steps: [step], lastAt: now };
      }
      this.incPrev = pts;
    }
    const p = this.incPending;
    if (!p || now - p.lastAt < INCIDENT_SETTLE_MS) return;
    this.incPending = null;
    if (this.dq || rc.disqualified) return; // the DQ call says it all

    const added = pts - p.from;
    const limit = rc.incidentLimit;
    const left = limit > 0 ? limit - pts : UNKNOWN_VALUE;
    const near = known(left) && left <= INCIDENT_WARN_LEFT;
    if (!race && added < NON_RACE_MIN_STEP && !near) return;
    const type = p.steps.length === 1 ? incidentType(added) : '';
    const facts: Record<string, string | number | boolean> = { added, points: pts };
    if (type) facts.type = type;
    if (limit > 0) {
      facts.pointsLimit = limit;
      facts.left = left;
      if (near) facts.warn = left <= 1 ? 'last' : 'near';
    }
    host.offer('irIncident', now, `+${added}x${type ? ` (${type})` : ''} — ${pts}${limit > 0 ? `/${limit}` : ''}`, facts);
  }

  /* ---- the start position ------------------------------------------------------ */

  private watchStart(frame: TelemetryFrame, now: number): void {
    if (frame.session.type !== 'race') return;
    const prevPhase = this.prevPhase;
    this.prevPhase = frame.session.phase;
    if (this.greenAt === 0) {
      // Only a start we watched: green arriving from the grid, not a late join.
      if (frame.session.phase === 'green' && prevPhase !== '' && prevPhase !== 'green') this.greenAt = now;
      return;
    }
    if (known(this.startPos) || now - this.greenAt < START_POSITION_SETTLE_MS) return;
    const me = frame.standings.find((e) => e.isOwn === true) ?? frame.standings.find((e) => e.isPlayer);
    if (!me || !known(me.position) || me.position <= 0) return;
    this.startPos = me.position;
    this.startClassPos = known(me.classPosition) ? me.classPosition! : me.position;
  }

  private prevPhase = '';

  private record(frame: TelemetryFrame): void {
    if (frame.iracing) this.prev = { ...frame.iracing };
    const me = frame.standings.find((e) => e.isPlayer);
    this.prevInPit = me ? me.inPit === true : true;
    if (!known(this.incPrev)) {
      const pts = frame.player?.trackLimits?.points;
      if (known(pts) && pts >= 0) this.incPrev = pts;
    }
    if (frame.session.type === 'race' && this.prevPhase === '') this.prevPhase = frame.session.phase;
  }
}
