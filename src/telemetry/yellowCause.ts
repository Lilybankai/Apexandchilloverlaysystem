/**
 * @file src/telemetry/yellowCause.ts
 * @module telemetry/yellowCause
 *
 * Who brought a local yellow out, and how far up the road they are.
 *
 * LMU does not say who a yellow is FOR — `underYellow` never lit once in the
 * 2026-08-26 capture — but in every yellow of that capture the car stopped on
 * track outside the pits sat in the flagged sector. So the cause is read the
 * way a marshal would: the slowest car on the circuit, in a flagged sector,
 * below a crawl. No such car (it is already moving again, or the sim published
 * no speeds) means no name, and the call falls back to the sector alone rather
 * than guess.
 *
 * Shared by the proactive `sectorYellow` call and the on-demand `flags` answer
 * so the two can never name different cars for the same flag.
 */

import type { TelemetryFrame } from './types';

/**
 * Below this a car on the racing surface is stopped or crawling back after an
 * off, not cornering. The slowest corners on the LMU calendar are taken well
 * above it (~60 km/h); the capture's stopped cars read 0–2.7 m/s.
 */
export const YELLOW_CAUSE_MAX_MPS = 10;

export interface YellowCause {
  /** Full driver name, as the standings carry it. */
  name: string;
  /** The sector the car is in (1..3), when the sim said. */
  sector?: 1 | 2 | 3;
  /**
   * Road distance from the player forward to the car, metres, `0`..lap length.
   * Omitted when either car has no track position or the lap length is unknown.
   */
  aheadM?: number;
}

/**
 * The car most likely behind a yellow in `sectors` (1-based), or null.
 *
 * `sectors` empty (or all three) means "any sector": the REST-only rig copies
 * one flag into every slot, so the sector list cannot narrow the search there.
 * The player's own car is never named — they know they are in the gravel.
 */
export function findYellowCause(frame: TelemetryFrame, sectors: number[]): YellowCause | null {
  // Only under green. On the grid, in the cooldown or at the flag every car is
  // stationary by design — the 2026-09-30 capture had 33, then 44, cars at
  // 0 m/s through a race's pre-start — so "the slowest car" means nothing.
  if (frame.session.phase !== 'green' || frame.session.notStarted) return null;
  const anySector = sectors.length === 0 || sectors.length === 3;
  const me = frame.standings.find((e) => e.isPlayer);
  let best: (typeof frame.standings)[number] | null = null;
  for (const e of frame.standings) {
    if (e.isPlayer || e.inPit || e.retired) continue;
    if (typeof e.speedMps !== 'number' || e.speedMps >= YELLOW_CAUSE_MAX_MPS) continue;
    // A car with no sector reading can only be trusted when every sector is
    // flagged anyway; otherwise it may be stopped somewhere unflagged.
    if (!anySector && (e.sector === undefined || !sectors.includes(e.sector))) continue;
    if (!best || e.speedMps < best.speedMps!) best = e;
  }
  if (!best) return null;

  const cause: YellowCause = { name: best.driverName };
  if (best.sector !== undefined) cause.sector = best.sector;
  const len = frame.session.trackLengthM;
  if (
    typeof len === 'number' &&
    len > 0 &&
    typeof best.lapFraction === 'number' &&
    typeof me?.lapFraction === 'number'
  ) {
    const frac = (((best.lapFraction - me.lapFraction) % 1) + 1) % 1;
    cause.aheadM = Math.round(frac * len);
  }
  return cause;
}

/**
 * Where the car is, for speech, relative to the player: "300 metres up the
 * road", "just behind you". Null when the distance is unknown, or so far round
 * the lap that a number would mean nothing to the driver.
 */
export function speakableWhere(aheadM: number | undefined, lapM: number | undefined): string | null {
  if (typeof aheadM !== 'number' || !(aheadM >= 0)) return null;
  const behindM = typeof lapM === 'number' && lapM > 0 ? lapM - aheadM : Infinity;
  if (aheadM < 150) return 'right in front of you';
  if (behindM < 400) return 'just behind you';
  if (aheadM < 1000) return `about ${Math.round(aheadM / 100) * 100} metres up the road`;
  if (aheadM <= 3000) {
    const km = Math.round(aheadM / 500) / 2; // nearest half kilometre
    return `about ${km === 1 ? 'a kilometre' : `${km} kilometres`} up the road`;
  }
  return null;
}
