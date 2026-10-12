/**
 * telemetry/replayMode.ts — the overlays while LMU plays a replay (THE-35).
 * -----------------------------------------------------------------------------
 * A replay plays a past session back through the very same REST feed a live
 * one uses: `sessionInfo` says RACE1, `GetGameState` says GSTATE_DYN and the
 * replay's cars are in `/rest/watch/standings` (all live 2026-09-30). The one
 * channel that tells them apart is `/navigation/state` `settingMode`, which
 * reads `SETTING_REPLAY_PLAYBACK` for the whole time a replay is on screen.
 *
 * CORRECTION (probed live 2026-10-12): those REST rows — and the shared-memory
 * Scoring buffer — are FROZEN at the loaded session's start for the whole
 * replay (event time 0, lap 0, grid order, other drivers' names). The replay's
 * moving data comes from LMU's broadcast websockets instead, opened only while
 * this mode is on — see `telemetry/replayFeed.ts`. Everything below still
 * holds; the frozen REST rows are what a frame falls back to when that feed is
 * not answering.
 *
 * Replay mode is entered ONLY on that positive answer. Everything here is
 * pure, so the rules are pinned by `scripts/test-replay-mode.js`:
 *
 *   - **Who the overlays follow.** The replay camera's car. `GET
 *     /rest/watch/focus` returns its slot as a bare number (read back live by
 *     the race log's replay jump, see `server/lmuReplay.ts` holdFocus); the
 *     standings row's own `hasFocus` is the fallback.
 *   - **Nobody is driving.** No row is treated as this PC's car, so the lap
 *     log, the strategy corpus, the traces, the ghost, the radar, the MFD, the
 *     tyres/damage screens and track limits all see "no driven car" — the
 *     spectator path, which the provider already builds by construction.
 *   - **Shared memory is not trusted on sight.** Whether the plugin's
 *     telemetry buffer keeps publishing during a replay has never been
 *     measured. A buffer that stopped updating keeps its last values, so a
 *     record is only shown once its own clock is moving and its speed agrees
 *     with REST's for the same car ({@link ReplayPhysicsGate}).
 *   - **A seek is a new session** as far as any learned state goes: lap deltas,
 *     pace averages and fuel burn learned before a jump describe a different
 *     moment of the race ({@link ReplaySeekDetector}).
 *
 * The frame carries `session.replay = true` and `session.onTrack = false`, so
 * every consumer that is not replay-aware behaves exactly as it does over the
 * sim's menus (nothing published, nothing announced), and the two that are —
 * the in-game layer and OBS auto-hide — choose to show.
 */

import type { TelemetryFrame } from './types';

/** `/navigation/state` `state.settingMode` while a replay is loaded or playing. */
export const REPLAY_SETTING_MODE = 'SETTING_REPLAY_PLAYBACK';

/** The slice of `/navigation/state` this module reads. */
export interface NavStateLike {
  state?: { settingMode?: string } | null;
}

/** Whether a `/navigation/state` body says a replay is playing. Anything else — including a malformed body — is no. */
export function isReplayNav(nav: NavStateLike | null | undefined): boolean {
  return !!nav && !!nav.state && nav.state.settingMode === REPLAY_SETTING_MODE;
}

/**
 * The slot in a `GET /rest/watch/focus` body: a bare number (`25`), sometimes
 * a numeric string. `null` for anything that is not a non-negative integer.
 */
export function parseFocusSlot(body: unknown): number | null {
  const n = typeof body === 'number' ? body : typeof body === 'string' ? Number(body.trim()) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The fields of a standings row the focus choice reads. */
export interface FocusCandidate {
  slotID: number;
  hasFocus?: boolean;
  focus?: boolean;
  player?: boolean;
}

/**
 * The car the overlays describe.
 *
 * Live (`replayFocusSlot` null) this is the provider's long-standing rule:
 * broadcast focus, then the driven car, then the first row. In a replay the
 * camera slot read from `/rest/watch/focus` wins outright, because it is the
 * one channel proven to follow the replay camera; a slot that matches no row
 * (a torn read, a car that has left) falls through to the same rule.
 */
export function pickFocusCar<T extends FocusCandidate>(
  cars: readonly T[],
  replayFocusSlot: number | null,
): T | undefined {
  if (replayFocusSlot !== null) {
    const cam = cars.find((c) => c.slotID === replayFocusSlot);
    if (cam) return cam;
  }
  return cars.find((c) => c.hasFocus || c.focus) ?? cars.find((c) => c.player) ?? cars[0];
}

/** Whether a frame was built from a replay. Absent = live (every provider but LMU never sets it). */
export function isReplayFrame(frame: Pick<TelemetryFrame, 'session'> | null | undefined): boolean {
  return !!frame && !!frame.session && frame.session.replay === true;
}

/**
 * Speed agreement between the shared-memory record and REST for the same car,
 * km/h. REST refreshes every ~150 ms, and a car braking at 5 g sheds ~27 km/h
 * in that time, so the bound must cover a whole REST tick of hard braking.
 */
const SPEED_TOLERANCE_KPH = 30;
/** …or this fraction of the REST speed, whichever is larger. */
const SPEED_TOLERANCE_FRAC = 0.15;
/** Consecutive agreeing reads before a record is believed. */
const TRUST_AFTER = 5;
/** Consecutive disagreeing reads before a believed record is dropped. */
const DISTRUST_AFTER = 5;
/** A record whose own clock has not moved for this long is a frozen buffer. */
const FROZEN_AFTER_MS = 1000;

/**
 * Decides whether the shared-memory record for the replay's focused car is a
 * live reading of THAT car, or a buffer left over from whatever last wrote it.
 *
 * Two tests, both needed:
 *   1. the record's own `mElapsedTime` advanced within the last second — a
 *      plugin that is not publishing leaves the clock where it stopped;
 *   2. its speed agrees with REST's for the same slot, a few reads running —
 *      the identity check the spectator probe used (|vel| matched REST to
 *      ±0.5 km/h every sample when the record was live).
 *
 * Hysteresis both ways so a single torn read neither admits nor drops it.
 * A change of slot (the camera cut) starts the count again from distrust.
 */
export class ReplayPhysicsGate {
  private slot: number | null = null;
  private lastElapsed = Number.NaN;
  private lastElapsedChangeMs = 0;
  private agree = 0;
  private disagree = 0;
  private trusted = false;

  public reset(): void {
    this.slot = null;
    this.lastElapsed = Number.NaN;
    this.lastElapsedChangeMs = 0;
    this.agree = 0;
    this.disagree = 0;
    this.trusted = false;
  }

  /**
   * @param slot          - The focused car's slot.
   * @param elapsedSec    - The record's `mElapsedTime`, or NaN with no record.
   * @param smSpeedKph    - The record's speed.
   * @param restSpeedKph  - REST `carVelocity` for the same car, km/h (negative = unknown).
   * @param nowMs         - Wall clock.
   * @returns Whether the record may be shown this frame.
   */
  public accept(
    slot: number,
    elapsedSec: number,
    smSpeedKph: number,
    restSpeedKph: number,
    nowMs: number,
  ): boolean {
    if (slot !== this.slot) {
      this.reset();
      this.slot = slot;
    }
    if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) {
      this.lastElapsed = Number.NaN;
      this.trusted = false;
      this.agree = 0;
      return false;
    }
    if (Number.isNaN(this.lastElapsed)) {
      // First sight is not movement: a frozen buffer has a clock too.
      this.lastElapsed = elapsedSec;
      this.lastElapsedChangeMs = Number.NEGATIVE_INFINITY;
    } else if (elapsedSec !== this.lastElapsed) {
      this.lastElapsed = elapsedSec;
      this.lastElapsedChangeMs = nowMs;
    }
    const moving = nowMs - this.lastElapsedChangeMs <= FROZEN_AFTER_MS;
    if (!moving) {
      this.trusted = false;
      this.agree = 0;
      return false;
    }
    if (!(restSpeedKph >= 0) || !Number.isFinite(smSpeedKph)) {
      // Nothing to check the identity against: keep the current verdict.
      return this.trusted;
    }
    const tol = Math.max(SPEED_TOLERANCE_KPH, restSpeedKph * SPEED_TOLERANCE_FRAC);
    if (Math.abs(Math.abs(smSpeedKph) - restSpeedKph) <= tol) {
      this.agree++;
      this.disagree = 0;
      if (this.agree >= TRUST_AFTER) this.trusted = true;
    } else {
      this.disagree++;
      this.agree = 0;
      if (this.disagree >= DISTRUST_AFTER) this.trusted = false;
    }
    return this.trusted;
  }
}

/**
 * Seconds of replay clock a jump must exceed, beyond what wall time and a
 * fast-forward could account for, to count as a seek.
 */
const SEEK_SLACK_SEC = 10;
/** Fastest playback a jump is excused by (the replay's fast-forward). */
const MAX_PLAYBACK_RATE = 16;

/**
 * Notices the replay being scrubbed: the session clock (`currentEventTime`,
 * the replay clock — `replayTime` seeks in it) going backwards, or forwards
 * further than playback could have carried it. A paused replay holds still
 * and is not a seek.
 */
export class ReplaySeekDetector {
  private lastEt = Number.NaN;
  private lastMs = 0;

  public reset(): void {
    this.lastEt = Number.NaN;
    this.lastMs = 0;
  }

  /** @returns true when this sample is on the far side of a seek. */
  public update(etSec: number, nowMs: number): boolean {
    if (!Number.isFinite(etSec) || etSec <= 0) return false;
    if (!Number.isFinite(this.lastEt)) {
      this.lastEt = etSec;
      this.lastMs = nowMs;
      return false;
    }
    if (etSec === this.lastEt) return false; // same REST snapshot, or paused
    const jump = etSec - this.lastEt;
    const wallSec = Math.max(0, (nowMs - this.lastMs) / 1000);
    this.lastEt = etSec;
    this.lastMs = nowMs;
    return jump < -1 || jump > SEEK_SLACK_SEC + wallSec * MAX_PLAYBACK_RATE;
  }
}
