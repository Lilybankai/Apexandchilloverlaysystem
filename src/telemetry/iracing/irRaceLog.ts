/**
 * @file src/telemetry/iracing/irRaceLog.ts
 * @module telemetry/iracing/irRaceLog
 *
 * Review ▸ Race log for **iRacing**, from local data only. No iRacing Data API
 * call, ever (no new OAuth clients; its terms ban commercial use without
 * consent — scratchpad plan-iracing-api.md).
 *
 * Two local sources, joined at read time:
 *   1. The **results copy** (raceResults.ts): the session-info YAML's
 *      `ResultsPositions` + `QualifyResultsInfo` as of the last update — the
 *      classification, the grid, laps, best laps, laps led, why a car is out,
 *      and (once official) everyone's incidents.
 *   2. The **live recorder** (raceLogRecorder.ts, header `source: 'iracing'`):
 *      our car's laps, places at the line, pit stops, flags, swaps, and our
 *      incident points as they rose (it reads them off `player.trackLimits`,
 *      which the iRacing provider fills with incidents).
 * Either can stand alone: a copy with no live log is a results card without a
 * timeline; a live log with no copy is listed as provisional.
 *
 * ## Incidents, honestly
 * Ours are exact (telemetry), stepped as they happened: +1x off track, +2x
 * loss of control, +4x contact (iRacing's documented weights; two at once
 * read as their sum). The FIELD's are iRacing's to publish: 0 for everyone
 * while the race is live, real only once `ResultsOfficial` — so the
 * classification shows "—" until then and says why.
 *
 * Pure apart from {@link listIrRaceLogs} / {@link loadIrRaceLog}, which read
 * the two folders. Never throws.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RaceLog, RaceLogEvent, RaceLogResultRow, RaceLogSummary } from '../raceLogTypes';
import type { LiveRace } from '../raceLogRecorder';
import { provisionalLog, sameTrack } from '../raceLogMerge';
import { racelogDir, readLiveRaces } from '../raceLog';
import { irRaceResultsDir, type IrRaceCar, type IrRaceSnapshot } from './raceResults';

/** A live race and a results copy whose session starts lie this close are one race, ms. */
export const PAIR_START_MS = 120_000;
/** A live-only iRacing race's id: this plus the recorder's key. */
const LIVE_PREFIX = 'irlive:';

/* -------------------------------------------------------------------------- */
/*  Pure                                                                      */
/* -------------------------------------------------------------------------- */

/** The live race recorded for this copy, if any. */
export function pairLive(snap: IrRaceSnapshot, races: readonly LiveRace[]): LiveRace | null {
  let best: LiveRace | null = null;
  let bestGap = Infinity;
  for (const r of races) {
    if (r.header.source !== 'iracing') continue;
    if (!sameTrack(r.header.track, snap.track)) continue;
    const gap = Math.abs(r.header.sessionStartMs - snap.sessionStartMs);
    if (gap <= PAIR_START_MS && gap < bestGap) {
      best = r;
      bestGap = gap;
    }
  }
  return best;
}

/** iRacing's incident weights, as words. Exported for the test. */
export function incidentWords(step: number): string {
  switch (step) {
    case 1:
      return 'Off track';
    case 2:
      return 'Loss of control';
    case 4:
      return 'Car contact';
    default:
      return 'Incident';
  }
}

/**
 * The live log's lines, in iRacing's words. The recorder is LMU-shaped: it
 * calls an incident step "Track limits: 6 of 17 points" and a black flag
 * "Penalty issued". Rewritten here, per line, so the stored log stays raw.
 */
export function irEvents(events: readonly RaceLogEvent[], limit: number): RaceLogEvent[] {
  let prev = 0;
  const out: RaceLogEvent[] = [];
  for (const e of events) {
    if (e.kind === 'limits') {
      const total = e.detail?.warningPoints;
      if (typeof total !== 'number' || !Number.isFinite(total)) {
        out.push({ ...e, text: e.text.replace(/^Track limits/, 'Incidents') });
        continue;
      }
      const step = Math.max(0, Math.round(total - prev));
      prev = total;
      const of = limit > 0 ? ` of ${limit}x` : '';
      out.push({
        ...e,
        // A contact is a contact; the rest sit with limits (the warn tone).
        kind: step === 4 ? 'contact' : 'limits',
        text: `${incidentWords(step)}: +${step}x (${total}x${of})`,
        detail: { ...e.detail, warningPoints: total, ...(limit > 0 ? { pointsLimit: limit } : {}) },
      });
      continue;
    }
    if (e.kind === 'penalty') {
      out.push({ ...e, text: /served/i.test(e.text) ? 'Black flag cleared' : 'Black flag shown' });
      continue;
    }
    if (e.kind === 'finish') continue; // the results copy's finish stands instead
    out.push(e);
  }
  return out;
}

const place = (p: number | null) => (p !== null && p > 0 ? `P${p}` : '');

/** The finish line of the timeline, from the copy. */
function finishEvent(snap: IrRaceSnapshot, ours: IrRaceCar | undefined, lastEt: number, greenEt: number): RaceLogEvent {
  const laps = ours ? ours.laps : 0;
  const where = ours
    ? snap.multiclass && ours.classPosition
      ? `${place(ours.position)} (${place(ours.classPosition)} in ${ours.carClass})`
      : place(ours.position)
    : '';
  let text: string;
  if (!ours || !ours.status) text = 'No result for our car';
  else if (ours.status === 'Finished') text = `Chequered flag. Finished ${where || 'unclassified'}, ${laps} laps`;
  else if (ours.status === 'Running') text = `Last classified ${where || '—'} after ${laps} laps (the race was still running)`;
  else text = `${ours.status}${where ? `, classified ${where}` : ''} after ${laps} laps`;
  return {
    et: lastEt,
    raceS: Math.round((lastEt - greenEt) * 10) / 10,
    lap: laps,
    kind: 'finish',
    text,
    source: 'live',
    detail: {
      ...(ours?.position ? { position: ours.position } : {}),
      ...(ours?.classPosition ? { classPosition: ours.classPosition } : {}),
      status: ours?.status || 'Unknown',
    },
  };
}

function classification(snap: IrRaceSnapshot): RaceLogResultRow[] {
  const rows = snap.cars.map((c) => ({
    position: c.position,
    classPosition: c.classPosition,
    carNumber: c.carNumber,
    carClass: c.carClass,
    car: c.car,
    drivers: c.drivers.length ? c.drivers : c.driver ? [c.driver] : [],
    team: snap.teamRacing ? c.team : '',
    gridPosition: c.gridPosition,
    laps: c.laps,
    lapsLed: c.lapsLed,
    bestLapMs: c.bestLapMs,
    incidents: snap.resultsOfficial ? c.incidents : null,
    status: c.status,
    ours: c.carIdx === snap.ownCarIdx,
  }));
  const key = (p: number | null) => (p !== null && p > 0 ? p : 999);
  return rows.sort((a, b) => key(a.position) - key(b.position) || a.carNumber.localeCompare(b.carNumber));
}

/**
 * One race's log from the copy and (when one paired) the live recording.
 * `id` is the copy's own.
 */
export function buildIrRaceLog(snap: IrRaceSnapshot, live: LiveRace | null): RaceLog {
  const ours = snap.cars.find((c) => c.carIdx === snap.ownCarIdx);
  const base = live ? provisionalLog(live) : null;
  const greenEt = base ? base.greenEt : 0;
  let events = base ? irEvents(base.events, snap.incidentLimit) : [];
  // The grid from the qualifying order, so the progression starts there.
  if (ours && ours.gridPosition) {
    const grid = ours.gridPosition;
    const cls = ours.gridClassPosition;
    const start = events.find((e) => e.kind === 'start');
    if (start) {
      start.detail = { ...start.detail, position: grid, ...(cls ? { classPosition: cls } : {}) };
      start.text = `Green flag. Started ${snap.multiclass && cls ? `P${grid} (P${cls} in class)` : `P${grid}`}`;
    } else {
      events.unshift({
        et: greenEt,
        raceS: 0,
        lap: 0,
        kind: 'start',
        text: `Started ${snap.multiclass && cls ? `P${grid} (P${cls} in class)` : `P${grid}`}`,
        source: 'live',
        detail: { position: grid, ...(cls ? { classPosition: cls } : {}) },
      });
    }
  }
  const lastEt = events.reduce((m, e) => Math.max(m, e.et), greenEt);
  events = [...events, finishEvent(snap, ours, lastEt, greenEt)];
  const drivers = ours ? (ours.drivers.length ? ours.drivers : ours.driver ? [ours.driver] : []) : [];
  return {
    id: snap.id,
    track: snap.track,
    startedAt: Math.round(snap.sessionStartMs / 1000),
    slot: ours ? ours.carIdx : null,
    carNumber: ours?.carNumber ?? '',
    carClass: ours?.carClass ?? '',
    vehicle: ours?.car ?? '',
    drivers,
    greenEt,
    gridPosition: ours?.gridPosition ?? base?.gridPosition ?? null,
    gridClassPosition: ours?.gridClassPosition ?? base?.gridClassPosition ?? null,
    finishPosition: ours?.position ?? null,
    finishClassPosition: ours?.classPosition ?? null,
    finishStatus: ours?.status || 'Unknown',
    laps: ours?.laps ?? 0,
    multiclass: snap.multiclass,
    ...(snap.trackLengthM > 0 ? { trackLength: snap.trackLengthM } : {}),
    matchedBy: 'iracing',
    provisional: false,
    events,
    sim: 'iracing',
    classification: classification(snap),
    incidents: { points: snap.ourIncidents, limit: snap.incidentLimit, fieldPublished: snap.resultsOfficial },
    bestLapMs: ours?.bestLapMs ?? null,
  };
}

/** A live-only iRacing race (no copy: an app from before the copy, or a crash). */
export function buildIrLiveOnlyLog(live: LiveRace): RaceLog {
  const base = provisionalLog(live);
  return {
    ...base,
    id: `${LIVE_PREFIX}${live.header.key}`,
    // -1 (unknown) rather than null: an iRacing log has no car picker to fall back on.
    slot: base.slot,
    events: irEvents(base.events, 0).concat(base.events.filter((e) => e.kind === 'finish')),
    sim: 'iracing',
  };
}

/** The list row for a log. */
export function summaryOf(log: RaceLog, endedAtMs: number): RaceLogSummary {
  const count = (k: RaceLogEvent['kind']) => log.events.filter((e) => e.kind === k).length;
  return {
    id: log.id,
    track: log.track,
    startedAt: log.startedAt,
    carClass: log.carClass || null,
    finishPosition: log.finishPosition,
    finishClassPosition: log.finishClassPosition,
    contacts: count('contact'),
    penalties: log.events.filter((e) => e.kind === 'penalty' && !/cleared/i.test(e.text)).length,
    slot: log.slot,
    provisional: log.provisional,
    gridPosition: log.gridPosition,
    gridClassPosition: log.gridClassPosition,
    laps: log.laps,
    limits: count('limits'),
    finishStatus: log.finishStatus,
    multiclass: log.multiclass,
    trackLength: log.trackLength ?? 0,
    endedAt: Math.round(endedAtMs / 1000),
  };
}

/* -------------------------------------------------------------------------- */
/*  IO                                                                        */
/* -------------------------------------------------------------------------- */

export interface IrRaceLogOptions {
  /** The results copies; default `~/.apex-overlay/racelog/iracing`. */
  dir?: string;
  /** The live recorder's folder; default `~/.apex-overlay/racelog`. */
  liveDir?: string;
  now?: number;
}

function isSnapshot(v: unknown): v is IrRaceSnapshot {
  const s = v as IrRaceSnapshot;
  return !!s && s.v === 1 && s.sim === 'iracing' && typeof s.id === 'string' && Array.isArray(s.cars);
}

/** Every results copy in the folder. Unreadable files are skipped. */
export function readSnapshots(dir: string = irRaceResultsDir()): IrRaceSnapshot[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^ir-[\w-]+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: IrRaceSnapshot[] = [];
  for (const n of names) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (isSnapshot(v)) out.push(v);
    } catch {
      /* torn or foreign: skipped */
    }
  }
  return out;
}

function liveIracing(opts: IrRaceLogOptions): LiveRace[] {
  return readLiveRaces(opts.liveDir ?? racelogDir(), opts.now ?? Date.now()).filter((r) => r.header.source === 'iracing');
}

/** Every iRacing race on this PC, newest first. Never throws. */
export function listIrRaceLogs(opts: IrRaceLogOptions = {}): RaceLogSummary[] {
  try {
    const snaps = readSnapshots(opts.dir);
    const live = liveIracing(opts);
    const used = new Set<LiveRace>();
    const out: RaceLogSummary[] = [];
    for (const s of snaps) {
      const l = pairLive(s, live);
      if (l) used.add(l);
      out.push(summaryOf(buildIrRaceLog(s, l), Math.max(s.updatedAt, l ? l.lastAt : 0)));
    }
    for (const l of live) {
      if (!used.has(l)) out.push(summaryOf(buildIrLiveOnlyLog(l), l.lastAt));
    }
    return out.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
  } catch {
    return [];
  }
}

/** One iRacing race's log, or null. Never throws. */
export function loadIrRaceLog(id: string, opts: IrRaceLogOptions = {}): RaceLog | null {
  try {
    if (typeof id !== 'string' || !id) return null;
    const live = liveIracing(opts);
    if (id.startsWith(LIVE_PREFIX)) {
      const key = id.slice(LIVE_PREFIX.length);
      const l = live.find((r) => r.header.key === key);
      return l ? buildIrLiveOnlyLog(l) : null;
    }
    if (!/^ir-[\w-]+$/.test(id)) return null;
    const snap = readSnapshots(opts.dir).find((s) => s.id === id);
    return snap ? buildIrRaceLog(snap, pairLive(snap, live)) : null;
  } catch {
    return null;
  }
}
