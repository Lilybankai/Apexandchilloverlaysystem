/**
 * @file src/telemetry/iracing/irRaceControl.ts
 * @module telemetry/iracing/irRaceControl
 *
 * Builds the frame's {@link IracingRaceControl} block: the iRacing facts the
 * race engineer needs (the player's own flag bits, the session's lap limit,
 * the player's settled lap count) that no generic block carries. Kept out of
 * `iracingProvider.ts` so the provider only has to call it.
 *
 * ## What the 2026-11-10 captures showed
 * - Lap-limited ("Lone Qualify", `SessionLaps: 2`): leaving the pits the car's
 *   `LapCompleted` reads **-1** (the out lap); the green flag (`0x4`) shows
 *   ~11 s before the line that starts the first timed lap (`LapCompleted` 0),
 *   the white (`0x2`) ~11 s before the line that starts the LAST one, the
 *   chequered (`0x1`) ~11 s before the line that ends it (`LapCompleted` 2 =
 *   the limit). `SessionState` only reaches Checkered 5 s after that line, and
 *   the per-car finish latch never fires in qualifying, so "done" is the lap
 *   count reaching the limit.
 * - `LapLastLapTime` lands 1.4–1.8 s AFTER `LapCompleted` steps. A lap summary
 *   built off the raw count reads the PREVIOUS lap's time (it did, on both
 *   captured qualifying runs), so {@link IracingRaceControl.lapsCompleted} only
 *   steps once the time has moved, or after {@link LAP_TIME_SETTLE_MS}.
 * - Race: the meatball (`0x100000`) came 10.7 s after a crash; the black flag
 *   (`0x10000`) cleared on serving; `0x20000` disqualify came at the 17x limit.
 *   Cautions (`0x4000/0x8000`) were never exercised — the bits are from
 *   `irsdk_defines.h`.
 */

import { UNKNOWN_VALUE } from '../types';
import type { IracingRaceControl } from '../types';
import type { IrsdkFrame } from './irsdk';

/** `irsdk_Flags` bits read here. */
const F = {
  checkered: 0x1,
  white: 0x2,
  yellow: 0x8,
  yellowWaving: 0x100,
  oneLapToGreen: 0x200,
  caution: 0x4000,
  cautionWaving: 0x8000,
  black: 0x10000,
  disqualify: 0x20000,
  furled: 0x80000,
  repair: 0x100000,
} as const;

/** How long a lap count may wait for its time before it is published anyway, ms. */
export const LAP_TIME_SETTLE_MS = 3000;

const fin = (n: number): boolean => Number.isFinite(n);

/** Stateful (the settled lap count); one per provider, reset per session. */
export class IrRaceControlReader {
  private laps = Number.NaN;
  private pendingLaps = Number.NaN;
  private pendingSince = -1;
  private lastAtStep = Number.NaN;

  public reset(): void {
    this.laps = Number.NaN;
    this.pendingLaps = Number.NaN;
    this.pendingSince = -1;
    this.lastAtStep = Number.NaN;
  }

  /**
   * @param f - this tick's telemetry
   * @param flags - `SessionFlags` as uint32
   * @param lapLimit - `SessionLaps` of the current session (0 = unlimited)
   * @param incidentLimit - `WeekendOptions.IncidentLimit` (0 = none)
   * @param isRace - lap limits in a race are the race distance, not a run
   */
  public read(
    f: IrsdkFrame,
    flags: number,
    lapLimit: number,
    incidentLimit: number,
    isRace: boolean,
    nowMs: number,
  ): IracingRaceControl {
    const laps = this.settle(f, nowMs);
    const caution = (flags & (F.caution | F.cautionWaving)) !== 0;
    const limit = lapLimit > 0 ? lapLimit : 0;
    const tow = f.num('PlayerCarTowTime');
    return {
      white: (flags & F.white) !== 0,
      checkered: (flags & F.checkered) !== 0,
      caution,
      oneLapToGreen: caution && (flags & F.oneLapToGreen) !== 0,
      localYellow: !caution && (flags & (F.yellow | F.yellowWaving)) !== 0,
      black: (flags & F.black) !== 0,
      furled: (flags & F.furled) !== 0,
      meatball: (flags & F.repair) !== 0,
      disqualified: (flags & F.disqualify) !== 0,
      pitsOpen: f.has('PitsOpen') ? f.bool('PitsOpen') : true,
      lapLimit: limit,
      // iRacing's out lap is -1, which is also our "unknown" sentinel on the
      // wire: the out lap is said apart and counts as 0 laps completed.
      lapsCompleted: !fin(laps) ? UNKNOWN_VALUE : Math.max(0, laps),
      outLap: fin(laps) && laps < 0,
      sessionDone: !isRace && limit > 0 && fin(laps) && laps >= limit,
      incidentLimit: incidentLimit > 0 ? incidentLimit : 0,
      towSec: fin(tow) && tow > 0 ? Math.round(tow * 10) / 10 : 0,
    };
  }

  /** The player's LapCompleted, held until that lap's time has landed. */
  private settle(f: IrsdkFrame, nowMs: number): number {
    const raw = f.num('LapCompleted');
    const last = f.num('LapLastLapTime');
    if (!f.bool('IsOnTrack') || !fin(raw)) {
      // Out of the car: nothing to count (NaN = unknown). The level is kept so
      // re-entering the same run does not read as a jump.
      return Number.NaN;
    }
    if (!fin(this.laps) || raw < this.laps || raw > this.laps + 1) {
      // First sight, a reset (back to the pits) or a jump: take it as it is.
      this.laps = raw;
      this.pendingSince = -1;
      return raw;
    }
    if (raw === this.laps) {
      this.pendingSince = -1;
      return raw;
    }
    // raw === laps + 1: the line. Wait for the lap time to move.
    if (this.pendingSince < 0 || this.pendingLaps !== raw) {
      this.pendingSince = nowMs;
      this.pendingLaps = raw;
      this.lastAtStep = last;
    }
    // An out lap (-1 → 0) has no time to wait for.
    const timeMoved = fin(last) && last > 0 && last !== this.lastAtStep;
    if (this.laps < 0 || timeMoved || nowMs - this.pendingSince >= LAP_TIME_SETTLE_MS) {
      this.laps = raw;
      this.pendingSince = -1;
    }
    return this.laps;
  }
}
