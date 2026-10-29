/**
 * fairTargetLoad.ts — the disk half of fair targets: the driver's own lap.
 * =============================================================================
 *
 * For `practice:targets` (electron/fair-ipc.js):
 *
 *   loadFairSession(sessionId: string, lapDir?: string): FairSessionInfo | null
 *
 *     The session's circuit and class (what the board is looked up by) and
 *     `mine` — its best VALID lap (clean, with a real time) described as a
 *     {@link TargetLapInfo}, conditions included. `null` only when no session
 *     has that id; `mine` is null when the session has no valid lap.
 *
 * The conditions come from the lap log's own record rather than the Review's
 * `ReviewLap`, because the record carries what the review does not: the tank
 * size (`capacityL`), the virtual energy at the line (`veStartPct`) and the
 * banded surface (`condition`, lap log v7+). They are the same fields the lap
 * uploader puts on the board (`lapLog.boardLapConditions`), so the two sides
 * of a fairness comparison are measured the same way.
 *
 * A pre-v7 lap has no `condition`; it is read from `wetness` when there is
 * one, else taken as dry unless the old `wet` flag says otherwise — then it is
 * unknown (`null`), which raises no surface flag rather than a wrong one.
 */

import { conditionOf, dayStamp, lapDir as defaultLapDir, readDay, type LapRecord } from './lapLog';
import { loadSession, type ReviewLap } from './stintReview';
import type { TargetLapInfo } from './fairTarget';

export interface FairSessionInfo {
  session: {
    id: string;
    sim: string;
    track: string;
    trackKey: string;
    trackLengthM: number;
    car: string;
    carClass: string;
    sessionType: string;
  };
  mine: TargetLapInfo | null;
}

function pos(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The lap log record for a lap: its UTC day's file first, then the days either side. */
export function findLapRecord(lap: { id?: string; at: string }, dir: string): LapRecord | null {
  if (!lap.id) return null;
  const ms = Date.parse(lap.at);
  if (!Number.isFinite(ms)) return null;
  const DAY = 86_400_000;
  for (const off of [0, -DAY, DAY]) {
    const hit = readDay(dayStamp(ms + off), dir).find((r) => r && r.id === lap.id);
    if (hit) return hit;
  }
  return null;
}

/** The surface a record was driven on, or null when it cannot be told. */
export function recordCondition(rec: LapRecord | null): string | null {
  if (!rec) return null;
  if (rec.condition === 'dry' || rec.condition === 'damp' || rec.condition === 'wet') return rec.condition;
  if (typeof rec.wetness === 'number' && Number.isFinite(rec.wetness)) return conditionOf(rec.wetness);
  return rec.wet === true ? null : 'dry';
}

/** The session's best valid lap: clean, with a real time. Trace not required. */
export function bestValid(laps: readonly ReviewLap[]): ReviewLap | null {
  let best: ReviewLap | null = null;
  for (const l of laps) {
    if (!(l.clean === true && l.timed === true && l.lapMs > 0)) continue;
    if (!best || l.lapMs < best.lapMs) best = l;
  }
  return best;
}

export function loadFairSession(sessionId: string, lapDir = defaultLapDir()): FairSessionInfo | null {
  const s = loadSession(sessionId, lapDir);
  if (!s) return null;
  const session = {
    id: s.id,
    sim: s.sim,
    track: s.track,
    trackKey: s.trackKey,
    trackLengthM: s.trackLengthM,
    car: s.car,
    carClass: s.carClass,
    sessionType: s.sessionType,
  };
  const best = bestValid(s.stints.flatMap((st) => st.laps));
  if (!best) return { session, mine: null };

  const rec = findLapRecord(best, lapDir);
  const mine: TargetLapInfo = {
    lapId: best.id || best.at,
    driver: 'You',
    car: (rec && rec.car) || s.car,
    carClass: s.carClass,
    lapSec: best.lapMs / 1000,
    sessionType: s.sessionType || null,
    trackTempC: finite(rec ? rec.trackTempC : best.trackTempC),
    airTempC: finite(rec ? rec.ambientTempC : best.ambientTempC),
    fuelStartL: pos(rec ? rec.fuelStartL : best.fuelStartL),
    fuelCapacityL: pos(rec && rec.capacityL),
    vePct: pos(rec && rec.veStartPct),
    compound: (rec && typeof rec.compound === 'string' && rec.compound.trim()) || best.compound || null,
    condition: rec ? recordCondition(rec) : best.wet ? null : 'dry',
    clean: true,
    trackKey: s.trackKey,
    hasTrace: best.hasTrace,
  };
  return { session, mine };
}
