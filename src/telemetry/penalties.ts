/**
 * @file src/telemetry/penalties.ts
 * @module telemetry/penalties
 *
 * Outstanding penalties for EVERY car in the field, for the standings tower's
 * penalty badge — and what kind each one is, wherever (and only where) the sim
 * actually says.
 *
 * ## Where the count comes from
 * The count is a per-car fact LMU publishes for the whole field:
 *
 *   - `/rest/watch/standings` rows carry `penalties` (a number). Verified live
 *     for our own car since 2026-08-04 (docs/race-control-signals.md: it rises
 *     the instant a penalty lands and drops when it is served). For the rest of
 *     the field it is the same field on the same row, and LMU's own broadcast
 *     overlay depends on it: `Bin/UI.zip` → `overlays/src/components/
 *     raceupdateoverlay/RaceUpdateOverlay.js` walks EVERY standings entry and
 *     pops its "Penalty" card when `currentEntry.penalties > oldEntry.penalties`.
 *   - stock rF2's Scoring buffer carries the same count per vehicle record
 *     (`mNumPenalties`, offset 194 — the offset the player read has always used;
 *     every record in the array shares the layout).
 *
 * ## Where the KIND comes from — and where it does not
 * The count says nothing about stop/go versus drive-through. The kind is known:
 *
 *   - for OUR car, from the pit-menu row / trace log the provider already reads
 *     (`TrackLimitsState.penaltyType`) — see {@link penaltyKindFromType};
 *   - for every car, in LMU's `LiveStandings` websocket (`:6398/websocket/ui`),
 *     whose rows carry `penalties: { DT, SG, TIME }`. That is the feed LMU's own
 *     in-game timing screen draws its "DT" / "SG" status from (`Bin/UI.zip` →
 *     `start/assets/app-*.js`, `LiveStandingsEntry.displayStatus()`), and our
 *     replay capture holds the object on all 39 rows
 *     (`scripts/fixtures/replay-ws-road-atlanta.json`, every value 0). The app
 *     only subscribes to that socket during a REPLAY (telemetry/replayFeed.ts
 *     — "live driving never constructs a socket"), so this is where the kind of
 *     a rival's penalty is reachable today. See {@link liveStandingsPenalties}.
 *
 * Anywhere else the kind is OMITTED, never inferred: a driver told "SG" about a
 * car serving a drive-through has been told something false, and a bare "PEN"
 * is the honest reading.
 *
 * A kind is only attached when it describes EVERY outstanding penalty on that
 * car. Two penalties of which we can name one would otherwise read as two of
 * that kind.
 */

import type { RelativeEntry, StandingEntry } from './types';

/** The two kinds of outstanding penalty a car serves in the pit lane. */
export type PenaltyKind = 'drive-through' | 'stop-go';

/** The penalty fields a {@link StandingEntry} carries — both omitted when clear. */
export interface PenaltyFields {
  penalties?: number;
  penaltyKind?: PenaltyKind;
}

/**
 * A sim penalty count as a positive whole number, or `undefined` for none.
 *
 * Zero, negatives (an unpopulated record), fractions, NaN and anything that is
 * not a number all mean "no badge" — the tower only ever claims a penalty the
 * sim actually counted.
 */
export function penaltyCount(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const n = Math.floor(raw);
  // 0..99: a count past that is a torn read, not a car with 100 penalties.
  return n > 0 && n < 100 ? n : undefined;
}

/**
 * Our own car's penalty kind, from the provider's `penaltyType` string — the
 * sim's own words off the pit-menu row (`"STOP/GO"`, `"DRIVE THRU"`) or the
 * trace (`"DRIVE THROUGH"`, `"STOP/GO 10S"`). The generic pit-menu `"PENALTY"`
 * row and `"DISQUALIFIED"` name no kind, so they return `undefined`.
 */
export function penaltyKindFromType(type: unknown): PenaltyKind | undefined {
  if (typeof type !== 'string') return undefined;
  const t = type.toUpperCase();
  if (/STOP\s*[/-]?\s*GO/.test(t)) return 'stop-go';
  if (/DRIVE\s*-?\s*(THRU|THROUGH)/.test(t)) return 'drive-through';
  return undefined;
}

/**
 * Count and kind from a LiveStandings row's `penalties` object
 * (`{ DT, SG, TIME }`), or `undefined` when nothing is outstanding.
 *
 * Counted the way LMU's own timing screen counts it: `hasPenalty()` there is
 * `DT > 0 || SG > 0`, and TIME is left out — it is not something served in the
 * lane, and whether it is a count or seconds has never been observed. The kind
 * is named only when one of the two is zero: a car owing a drive-through AND a
 * stop/go has no single kind to show.
 */
export function liveStandingsPenalties(
  raw: unknown,
): { count: number; kind?: PenaltyKind } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as { DT?: unknown; SG?: unknown };
  const dt = penaltyCount(p.DT) ?? 0;
  const sg = penaltyCount(p.SG) ?? 0;
  const count = dt + sg;
  if (count <= 0) return undefined;
  if (dt > 0 && sg === 0) return { count, kind: 'drive-through' };
  if (sg > 0 && dt === 0) return { count, kind: 'stop-go' };
  return { count };
}

/**
 * The fields to spread onto a standings row: nothing at all for a clear car
 * (so the wire carries no zeros for a field of thirty), the count otherwise,
 * and the kind only beside a count.
 *
 * `retired` drops both — a car parked for good has nothing left to serve, and
 * a badge over a disqualified car reads as the stewards still waiting on it.
 */
export function penaltyFields(
  count: number | undefined,
  kind: PenaltyKind | undefined,
  retired = false,
): PenaltyFields {
  if (retired || count === undefined || count <= 0) return {};
  return kind ? { penalties: count, penaltyKind: kind } : { penalties: count };
}

/**
 * Give each relative row its car's penalty fields from the standings, the way
 * `copyClassPositions` gives it the class position: one source of truth, so
 * the tower and the relative panel cannot badge the same car differently.
 *
 * Runs every frame, so it allocates nothing: a field with no penalties (nearly
 * every frame of every race) is one pass over the standings and, at most, a
 * `delete` on a relative row that carried a badge last frame. Otherwise a
 * linear search per relative row — a handful of rows against a field of ~40.
 */
export function copyPenalties(
  standings: readonly StandingEntry[],
  relative: RelativeEntry[],
): void {
  let any = false;
  for (let i = 0; i < standings.length; i++) {
    if (standings[i]!.penalties !== undefined) {
      any = true;
      break;
    }
  }
  for (const row of relative) {
    let src: StandingEntry | undefined;
    if (any) {
      for (let i = 0; i < standings.length; i++) {
        if (standings[i]!.slotId === row.slotId) {
          src = standings[i];
          break;
        }
      }
    }
    if (src && src.penalties !== undefined) {
      row.penalties = src.penalties;
      if (src.penaltyKind) row.penaltyKind = src.penaltyKind;
      else delete row.penaltyKind;
    } else if (row.penalties !== undefined || row.penaltyKind !== undefined) {
      delete row.penalties;
      delete row.penaltyKind;
    }
  }
}
