/**
 * @file src/telemetry/strategyCorpus.ts
 * @module telemetry/strategyCorpus
 *
 * The **strategy corpus** upload plan: which of the local pit stops and
 * consumption laps still need sending to the cloud, and what each becomes on
 * the wire.
 *
 * ## Why this exists
 * The stop database (`stopLog.ts`) and the consumption block on every lap
 * (`lapLog.ts`, record v5) are the training set the strategy engine's
 * coefficients are fitted from — refuel rate, burn per lap, tyre degradation,
 * service time (`docs/RACE-STRATEGY-ENGINE.md` §3, §6). Both were written to
 * the driver's own disk and nowhere else, which meant the corpus could never be
 * bigger than one PC's race weekends. A refuel rate is per car class and a
 * burn is per class and track: that grid is only ever filled by every driver's
 * rows landing together. Migration 0015 gives them somewhere to land; this
 * module decides what to send.
 *
 * ## How it differs from the lap plan
 * `lapLog.buildUploadPlan` sends AGGREGATES — a best per board, a count per
 * day — recomputed from the files each run, so nothing needs a ledger. A stop
 * is not an aggregate: it is one event, sent once, and it never changes
 * afterwards. So the cache here is a set of ids the server has accepted
 * (`SyncCache.corpus`), and the diff is "every row whose id is not in the
 * set". The server is keyed on the same id, so a row offered twice (a crash
 * between the accept and the cache write) is a no-op there, not a duplicate.
 *
 * ## What is and is not offered
 *   - Every stop with an id. Garage visits and drive-throughs included: the
 *     server stores the log unjudged and the QUERY picks the real refuel stops,
 *     the same rule `stopLog.ts` explains for why it does not filter locally.
 *   - Only laps that carry a consumption reading — a fuel level or a wear
 *     reading. A v1–v4 lap, or a v5 lap driven without shared memory, has
 *     nothing to teach a fit and is not offered rather than being refused.
 *
 * Pure: reads files through the two logs' own readers, touches no network.
 */

import { type LapRecord, type SyncCache, lapDir, listDays, readDay } from './lapLog';
import { type StopRecord, readStops, stopDir } from './stopLog';
import { UNKNOWN_VALUE } from './types';

/* -------------------------------------------------------------------------- */
/*  The plan                                                                  */
/* -------------------------------------------------------------------------- */

/** Everything on disk that the corpus could hold. */
export interface CorpusPlan {
  /** Newest first. */
  stops: StopRecord[];
  /** Newest first. */
  laps: LapRecord[];
}

/** Whether a lap carries anything a strategy fit can use. */
export function hasConsumption(lap: LapRecord): boolean {
  if (!lap.id) return false;
  const fuel = typeof lap.fuelStartL === 'number' && Number.isFinite(lap.fuelStartL);
  const wear = Array.isArray(lap.wearAtLine) && lap.wearAtLine.length === 4;
  return fuel || wear;
}

/**
 * Build the full desired corpus from every stop and lap file on disk.
 *
 * Both directories default to the real ones beside the app's other logs; a
 * test passes its own. Newest first, so a driver's most recent race — the one
 * they are most likely to ask the engineer about — is what lands when a run
 * is cut short by the per-run cap.
 */
export function buildCorpusPlan(lapsDir = lapDir(), stopsDir = stopDir()): CorpusPlan {
  const stops = readStops(stopsDir)
    .filter((s) => typeof s.id === 'string' && s.id.length > 0)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const laps: LapRecord[] = [];
  for (const day of listDays(lapsDir).reverse()) {
    const dayLaps = readDay(day, lapsDir).filter(hasConsumption);
    // Within a day the file is append-ordered (oldest first); flip it.
    for (let i = dayLaps.length - 1; i >= 0; i--) laps.push(dayLaps[i] as LapRecord);
  }
  return { stops, laps };
}

/* -------------------------------------------------------------------------- */
/*  The cache                                                                 */
/* -------------------------------------------------------------------------- */

/** Cache / rejection key for a stop. */
export function stopKey(stop: StopRecord): string {
  return `stop:${stop.id}`;
}

/** Cache / rejection key for a consumption lap. */
export function lapKey(lap: LapRecord): string {
  return `burn:${lap.id}`;
}

/** Reduce a plan to the rows the server has neither accepted nor refused. */
export function diffCorpus(plan: CorpusPlan, cache: SyncCache): CorpusPlan {
  const sent = (cache && cache.corpus) || {};
  const rejected = (cache && cache.rejected) || {};
  const pending = (key: string): boolean => !sent[key] && !rejected[key];
  return {
    stops: plan.stops.filter((s) => pending(stopKey(s))),
    laps: plan.laps.filter((l) => pending(lapKey(l))),
  };
}

/** Record an accepted row, so the next diff skips it. */
export function markCorpusSent(cache: SyncCache, key: string): void {
  if (!cache.corpus) cache.corpus = {};
  cache.corpus[key] = 1;
}

/* -------------------------------------------------------------------------- */
/*  The wire shape                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The lap length a `trackKeyOf` key encodes (`<slug>_<metres>`), or 0.
 *
 * A stop record carries the key but not the length itself, and the server's
 * `resolve_track` wants both. The key IS the length, rounded, so nothing is
 * lost reading it back; 0 is what the lap uploader sends when the sim never
 * published one, and the server already copes with that.
 */
export function trackLengthFromKey(trackKey: string): number {
  const m = /_(\d+)$/.exec(trackKey || '');
  return m ? Number(m[1]) : 0;
}

/** A finite number, or null — the server stores NULL, never a sentinel. */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v !== UNKNOWN_VALUE ? v : null;
}

/** A four-corner wear array, or null. */
function wearOrNull(w: unknown): number[] | null {
  return Array.isArray(w) && w.length === 4 && w.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? (w as number[])
    : null;
}

/** The `submit_pit_stop` parameters for one stop. */
export function stopPayload(stop: StopRecord, appVersion: string): Record<string, unknown> {
  return {
    p_id: stop.id,
    p_sim: stop.sim,
    p_track_key: stop.trackKey,
    p_track_name: stop.track,
    p_track_length_m: trackLengthFromKey(stop.trackKey),
    p_car_class: stop.carClass,
    p_car: stop.car || '',
    p_session_type: stop.sessionType || '',
    p_stopped_at: stop.at,
    p_lap: stop.lap,
    p_stop_no: stop.stopNo,
    p_lane_sec: stop.laneSec,
    // UNKNOWN_VALUE means "no speed channel", which is NULL up there — never a
    // negative duration, and never a zero that would read as an instant stop.
    p_stationary_sec: numOrNull(stop.stationarySec),
    p_booked_sec: numOrNull(stop.bookedSec),
    p_fuel_added_l: numOrNull(stop.fuelAddedL),
    p_fuel_before_l: numOrNull(stop.fuelBeforeL),
    p_fuel_after_l: numOrNull(stop.fuelAfterL),
    p_ve_added_pct: numOrNull(stop.veAddedPct),
    p_tyres_changed: !!stop.tyresChanged,
    p_wear_before: wearOrNull(stop.wearBefore),
    p_wear_after: wearOrNull(stop.wearAfter),
    p_compound_fitted: stop.compoundFitted || null,
    p_app_version: appVersion,
  };
}

/** The `submit_lap_consumption` parameters for one lap. */
export function lapPayload(lap: LapRecord, appVersion: string): Record<string, unknown> {
  return {
    p_id: lap.id,
    p_sim: lap.sim,
    p_track_key: lap.trackKey,
    p_track_name: lap.track,
    p_track_length_m: lap.trackLengthM || trackLengthFromKey(lap.trackKey),
    p_car_class: lap.carClass,
    p_car: lap.car || '',
    p_session_type: lap.sessionType || '',
    p_set_at: lap.at,
    p_lap_ms: lap.lapMs,
    p_clean: !!lap.clean,
    p_dirty: Array.isArray(lap.dirty) ? lap.dirty : [],
    p_fuel_start_l: numOrNull(lap.fuelStartL),
    p_fuel_end_l: numOrNull(lap.fuelEndL),
    p_fuel_used_l: numOrNull(lap.fuelUsedL),
    p_capacity_l: numOrNull(lap.capacityL),
    p_ve_start_pct: numOrNull(lap.veStartPct),
    p_ve_end_pct: numOrNull(lap.veEndPct),
    p_wear_at_line: wearOrNull(lap.wearAtLine),
    p_compound: lap.compound || null,
    p_stint_lap: numOrNull(lap.stintLap),
    p_is_out_lap: !!lap.isOutLap,
    p_is_in_lap: !!lap.isInLap,
    p_track_temp_c: numOrNull(lap.trackTempC),
    p_ambient_temp_c: numOrNull(lap.ambientTempC),
    p_wet: typeof lap.wet === 'boolean' ? lap.wet : null,
    p_app_version: appVersion,
  };
}
