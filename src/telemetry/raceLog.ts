/**
 * @file src/telemetry/raceLog.ts
 * @module telemetry/raceLog
 *
 * Builds the **race log**, a written timeline of one car's race, from LMU's
 * results file. Phase 1 of `docs/RACE-LOG-PLAN.md`: the XML only, so it works
 * for every race already on disk and needs nothing live.
 *
 * ## Which car is ours
 * The file cannot say. `isPlayer` is 1 for every human in multiplayer, and a
 * name is a person, not a car: after a swap our car carries a teammate's name.
 * So, strongest first ({@link findOurSlot}):
 *   1. **the lap log.** Our own `LapRecord.lapMs`, recorded live, equal the
 *      file's lap times to the millisecond. The slot with the most equal laps
 *      (±{@link LAP_MATCH_MS}, at least {@link MIN_LAP_MATCHES}) is ours. It
 *      survives driver swaps and needs no settings;
 *   2. **our driver names**, the ones the app has seen at this PC
 *      (`racelog/names.json`), against every name a slot carried;
 *   3. **the driver's own pick**, remembered per file (`racelog/picks.json`).
 *      A pick outranks both guesses, since it was a person's decision.
 * Nothing found: the log comes back with `slot: null` and the field's cars.
 *
 * ## Positions are derived, not read
 * `<Lap p=…>` disagreed with the order of the stream's own line crossings on
 * 7% of 118 000 laps (two cars sharing P11, for one), and the file gives no
 * class position per lap at all. So both are counted from the crossings: at
 * our crossing of lap N, every car that had already crossed lap N is ahead.
 * Overall and class come from the same count, so they can never disagree
 * with each other.
 *
 * ## What the XML cannot say
 * No flags, no graded damage (only "new suspension/engine damage"), no pit
 * lane times (a `pit` lap is known, the entry and exit are not). Those are the
 * live recorder's, phase 2.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { LapRecord } from './lapLog';
import { dayStamp, lapDir } from './lapLog';
import { findLmuLogDir } from './lmuTraceLimits';
import type {
  ContactSeverity,
  RaceLog,
  RaceLogCar,
  RaceLogDetail,
  RaceLogEvent,
  RaceLogKind,
  RaceLogSummary,
} from './raceLogTypes';
import { parseResultsSteps } from './resultsXml';
import { matchLiveRace, mergeLive, provisionalLog, writtenAt } from './raceLogMerge';
import type { LiveEvent, LiveLine, LiveRace } from './raceLogRecorder';
import type { ResultsDriver, ResultsLap, ResultsSession, StreamEntry } from './resultsXml';
import { readAllLaps } from './stintReview';

/* -------------------------------------------------------------------------- */
/*  Thresholds                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Contact strength at which LMU's wording turns from "Light contact" to
 * "Heavy contact", in the XML's unitless magnitude.
 *
 * LMU makes that call in its LiveSteward system, with thresholds that arrive
 * at runtime from the online service; the exe's code is encrypted, and no XML,
 * trace or REST source records the verdict. So this borrows LMU's **wording**,
 * not its threshold. Across the 207 race files on Carl's PC, 12 297 car-to-car
 * contacts are unimodal on a log scale with no natural break (p50 366, p75 788,
 * p90 1438, p99 4312). 1000 sits near p82: about one contact in five reads
 * heavy. It is applied to the **larger** of the two cars' reports, which differ
 * by a median 1.28× (p90 3.5×). Scenery contacts use the same rule.
 */
export const HEAVY_CONTACT_MIN = 1000;

/** Two reports of the same pair closer than this are one contact, seconds. */
export const CONTACT_PAIR_S = 1;

/**
 * Two damage reports of the same zone closer than this are one, seconds. LMU
 * often reports a hit's suspension damage twice a second or so apart (Long
 * Beach 2026-09-24, slot 25: 154.2 and 155.5).
 */
export const DAMAGE_MERGE_S = 2;

/** A lap-log time and an XML time within this many ms are the same lap. */
export const LAP_MATCH_MS = 2;

/** Equal laps a slot needs before the lap log is trusted to name it. */
export const MIN_LAP_MATCHES = 2;

/**
 * A stream that starts this long after the green flag belongs to a client that
 * joined mid-race: positions before the join are not known, and are not said.
 */
const JOIN_GRACE_S = 60;

/** A repeated track-limits verdict inside this many seconds, points unchanged, is the same one. */
const LIMITS_ECHO_S = 2;

/** Lap-log window around a race, seconds before its start and after its end. */
const WINDOW_BEFORE_S = 300;
const WINDOW_AFTER_S = 600;

/** "Light contact" or "Heavy contact", from the larger of the two reports. */
export function contactSeverity(magnitude: number): ContactSeverity {
  return magnitude >= HEAVY_CONTACT_MIN ? 'heavy' : 'light';
}

/* -------------------------------------------------------------------------- */
/*  Small wording helpers                                                     */
/* -------------------------------------------------------------------------- */

const SCENERY: Record<string, string> = {
  Immovable: 'the wall',
  Post: 'a post',
  Sign: 'a sign',
  Cone: 'a cone',
  Wheel: 'a loose wheel',
  Wing: 'a loose wing',
};

/** English for the penalty reasons servers have sent in other languages. */
const LOCALISED_REASONS: Record<string, string> = {
  'Erlaubtes Energielimit überschritten.': 'Exceeded energy allowance limit',
  "Limite d'énergie autorisée dépassée.": 'Exceeded energy allowance limit',
  'Límite de energía permitida superado.': 'Exceeded energy allowance limit',
  'Limite di energia superato.': 'Exceeded energy allowance limit',
  'Mauvais comportement dans la voie des stands': 'Pitlane misbehaviour',
};

function classLabel(cls: string): string {
  if (cls === 'Hyper') return 'Hypercar';
  return cls.replace(/_/g, ' ');
}

/** `1:52.671`, or `52.671` under a minute. */
export function formatLapTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const m = Math.floor(ms / 60_000);
  const rest = ((ms % 60_000) / 1000).toFixed(3);
  return m > 0 ? `${m}:${rest.padStart(6, '0')}` : rest;
}

function pts(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function places(n: number): string {
  return `${n} place${n === 1 ? '' : 's'}`;
}

function normName(n: string): string {
  return n.trim().replace(/\s+/g, ' ').toLowerCase();
}

function penaltyLabel(kind: string, seconds: number): string {
  switch (kind) {
    case 'Drive Thru':
      return 'Drive-through';
    case 'Stop/Go':
      return seconds > 0 ? `${pts(seconds)} s stop-go` : 'Stop-go';
    case 'Time':
      return seconds > 0 ? `${pts(seconds)} s time penalty` : 'Time penalty';
    case 'Disqualify':
      return 'Disqualified';
    default:
      return kind || 'Penalty';
  }
}

/* -------------------------------------------------------------------------- */
/*  Reading the field                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every name each slot carried: its block, its swaps, the stream, driver
 * changes. One pass over the stream for the whole field, since a listing asks
 * this of every car in 200 files.
 */
function namesBySlot(r: ResultsSession): Map<number, string[]> {
  const acc = new Map<number, Map<string, string>>();
  // Every Score row repeats its driver's name: 29 000 rows in a four-hour race,
  // and the regex in normName was a third of building its log.
  const norm = new Map<string, string>();
  const add = (slot: number, n: string | null | undefined) => {
    if (!n || !n.trim()) return;
    let m = acc.get(slot);
    if (!m) acc.set(slot, (m = new Map()));
    let k = norm.get(n);
    if (k === undefined) norm.set(n, (k = normName(n)));
    m.set(k, n.trim());
  };
  for (const d of r.drivers) {
    if (d.slot === null) continue;
    add(d.slot, d.name);
    for (const sw of d.swaps) add(d.slot, sw.name);
  }
  for (const e of r.stream) {
    if (e.type === 'driverChange') {
      add(e.slot, e.oldName);
      add(e.slot, e.newName);
    } else if (e.type === 'score' || e.type === 'limits' || e.type === 'sector') {
      add(e.slot, e.name);
    }
  }
  const out = new Map<number, string[]>();
  for (const [slot, m] of acc) out.set(slot, [...m.values()]);
  return out;
}

/** Every name that drove the car, in stint order. */
function driversOf(d: ResultsDriver): string[] {
  const out: string[] = [];
  for (const s of d.swaps) if (!out.includes(s.name)) out.push(s.name);
  if (!out.includes(d.name)) out.push(d.name);
  return out;
}

/**
 * When each car crossed the line at the end of each lap: per driver block,
 * lap number → `et`. The stream's own crossing wins; the next lap's start, then
 * start + lap time, fill in where it has none.
 */
function crossingsOf(r: ResultsSession): Map<ResultsDriver, Map<number, number>> {
  const score = new Map<number, Map<number, number>>();
  for (const e of r.stream) {
    if (e.type !== 'score' || e.point !== 0) continue;
    let m = score.get(e.slot);
    if (!m) score.set(e.slot, (m = new Map()));
    m.set(e.lap, e.atEt);
  }
  const out = new Map<ResultsDriver, Map<number, number>>();
  for (const d of r.drivers) {
    const ends = new Map<number, number>();
    const byNum = new Map(d.lapList.map((l) => [l.num, l] as const));
    const own = d.slot !== null ? score.get(d.slot) : undefined;
    for (const lap of d.lapList) {
      const next = byNum.get(lap.num + 1);
      const end = own?.get(lap.num) ?? next?.et ?? (lap.lapTime !== null ? lap.et + lap.lapTime : undefined);
      if (end !== undefined) ends.set(lap.num, end);
    }
    out.set(d, ends);
  }
  return out;
}

interface Contact {
  et: number;
  magnitude: number;
  otherSlot: number | null;
  otherName: string | null;
  object: string | null;
}

/**
 * Every car's contacts, each counted once. LMU logs a contact once per
 * reporting car, so a car-to-car touch arrives as two rows a tenth apart with
 * two different strengths; rows of the same pair within {@link CONTACT_PAIR_S}
 * of a contact's first row are that contact. One pass for the whole field.
 */
function contactsBySlot(r: ResultsSession): Map<number, Contact[]> {
  const out = new Map<number, (Contact & { key: string })[]>();
  const add = (slot: number, c: Contact) => {
    let list = out.get(slot);
    if (!list) out.set(slot, (list = []));
    const key = c.otherSlot !== null ? `car:${c.otherSlot}` : `obj:${c.object ?? ''}`;
    // Rows arrive in time order, so only the newest few can still be open.
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i]!;
      if (c.et - g.et >= CONTACT_PAIR_S) break;
      if (g.key === key) {
        g.magnitude = Math.max(g.magnitude, c.magnitude);
        return;
      }
    }
    list.push({ ...c, key });
  };
  for (const e of r.stream) {
    if (e.type !== 'incident' || e.otherSlot === e.slot) continue;
    add(e.slot, { et: e.et, magnitude: e.magnitude, otherSlot: e.otherSlot, otherName: e.otherName, object: e.object });
    if (e.otherSlot !== null) {
      add(e.otherSlot, { et: e.et, magnitude: e.magnitude, otherSlot: e.slot, otherName: e.name, object: null });
    }
  }
  const res = new Map<number, Contact[]>();
  for (const [slot, list] of out) res.set(slot, list.map(({ key: _key, ...c }) => c));
  return res;
}

/**
 * The track-limits points limit, when the file gives it away. It is not
 * written anywhere; but a penalty verdict lands when a car's total reaches it,
 * and a warning only below it. So the smallest total that drew a penalty is
 * an upper bound, and every warned total a lower one (12 on the 2026-09-25
 * 5 h race: 11.75 + 0.25 drew the drive-through).
 *
 * Only a **whole** number is believed. Across the 207 files the bound came out
 * whole in 32 races (3, 6, 8, 12…) and fractional in 25 (3.25, 11.5…), and a
 * fractional one is an overshoot, a car that jumped past the limit in one
 * excursion. Saying "of 3.25 points" would be inventing a rule, so those races
 * say the points alone.
 */
function pointsLimitOf(r: ResultsSession): number | undefined {
  const last = new Map<number, number>();
  let maxWarned = 0;
  let limit = Infinity;
  for (const e of r.stream) {
    if (e.type !== 'limits') continue;
    if (e.resolution >= 1 && e.resolution <= 3) {
      limit = Math.min(limit, (last.get(e.slot) ?? 0) + e.warningPoints);
    } else if (e.resolution === 4) {
      maxWarned = Math.max(maxWarned, e.currentPoints);
    }
    last.set(e.slot, e.currentPoints);
  }
  return Number.isInteger(limit) && limit > maxWarned ? limit : undefined;
}

/* -------------------------------------------------------------------------- */
/*  Finding our car                                                           */
/* -------------------------------------------------------------------------- */

/** Wall-clock span (ms) a race's lap-log laps must fall inside. */
export function raceWindow(r: ResultsSession): { fromMs: number; toMs: number } {
  // `startedAt` is when this PC's clock read the stream's first row: et 0 on a
  // normal start, the join on a mid-race join. Both read the span from there.
  const base = Math.max(0, r.firstStreamEt ?? 0);
  return {
    fromMs: (r.startedAt - WINDOW_BEFORE_S) * 1000,
    toMs: (r.startedAt + Math.max(0, r.lastEt - base) + WINDOW_AFTER_S) * 1000,
  };
}

/** The lap-log laps set during this race. */
export function lapsInRace(r: ResultsSession, laps: LapRecord[]): LapRecord[] {
  const { fromMs, toMs } = raceWindow(r);
  return laps.filter((l) => {
    const at = Date.parse(l.at);
    return at >= fromMs && at <= toMs && l.lapMs > 0 && (!l.sim || l.sim === 'lmu');
  });
}

/**
 * Share of the matched laps one driver's stints must hold before that driver
 * is taken to be us.
 *
 * Not "every stint a matched lap falls in": the lap log follows the CAR, so it
 * also records laps while a team-mate drives and this PC watches. On four of
 * the team races on disk the matched laps split 43/3, 31/9, 42/6 and 14/7
 * between Carl and a team-mate (taking every stint seeded five team-mates).
 * The majority is usually ours, but not always: a short opening stint by
 * Carl with the PC left recording is a team-mate's majority, and a learnt name
 * is never unlearnt by the listing. So only a clear one counts: 0.8 keeps the
 * 43/3 and 42/6 races and drops the 31/9 and 14/7 ones, which the lap log
 * still places, just without teaching a name.
 */
export const SEED_MAJORITY = 0.8;

/** Matched laps a race needs before its driver is learnt; two place a slot, five name a person. */
export const SEED_MIN_LAPS = 5;

/**
 * Who was driving on the matched laps: the one driver whose stints hold at
 * least {@link SEED_MAJORITY} of at least {@link SEED_MIN_LAPS}, or nobody. The
 * block's `<Swap>` list gives stints by lap; without one, the stream's driver
 * changes give them by time; without either, the car had one driver.
 *
 * `records` is how many lap-log laps fell in the race: one of them can match
 * two XML laps (Silverstone 2026-09-20, slot 9: 1:49.744 matched laps 2 and
 * 19, 1:49.746), so the XML count alone overstates the evidence.
 */
function stintNames(r: ResultsSession, d: ResultsDriver, laps: ResultsLap[], records: number): string[] {
  if (Math.min(laps.length, records) < SEED_MIN_LAPS) return [];
  const tally = new Map<string, number>();
  const changes = r.stream.filter(
    (e): e is Extract<StreamEntry, { type: 'driverChange' }> => e.type === 'driverChange' && e.slot === d.slot,
  );
  for (const lap of laps) {
    let name: string | undefined;
    if (d.swaps.length) {
      name = d.swaps.find((s) => lap.num >= s.startLap && lap.num <= s.endLap)?.name;
    } else if (changes.length) {
      const before = changes.filter((c) => c.et <= lap.et);
      name = before.length ? before[before.length - 1]!.newName : changes[0]!.oldName;
    } else {
      name = d.name;
    }
    if (name && name.trim()) tally.set(name.trim(), (tally.get(name.trim()) ?? 0) + 1);
  }
  let top: [string, number] | null = null;
  for (const t of tally) if (!top || t[1] > top[1]) top = t;
  return top && top[1] >= SEED_MAJORITY * laps.length ? [top[0]] : [];
}

/**
 * The names a lap-log match may teach. None when a name already known drove
 * the same car in the same race, as someone other than the one proposed: we
 * were in that car, so the majority driver may be a team-mate this PC watched.
 * `alsoProposed` are names other races propose in the same listing, so the
 * answer does not hang on which race is read first.
 */
function seedable(proposed: string[], drove: string[], known: Set<string>, alsoProposed?: Map<string, number>): string[] {
  const mine = new Set(proposed.map(normName));
  for (const n of drove.map(normName)) {
    if (mine.has(n)) continue;
    if (known.has(n) || (alsoProposed?.get(n) ?? 0) > 0) return [];
  }
  return proposed.filter((n) => !known.has(normName(n)));
}

/**
 * Which slot is ours: see the module header. `ourLaps` may be the whole lap
 * log; only laps inside the race's window are compared.
 */
export function findOurSlot(
  r: ResultsSession,
  ourLaps: LapRecord[],
  knownNames: string[],
): { slot: number; matchedBy: 'laplog' | 'name'; names?: string[] } | null {
  const mine = lapsInRace(r, ourLaps).map((l) => l.lapMs);
  if (mine.length >= MIN_LAP_MATCHES) {
    let best: ResultsDriver | null = null;
    let bestLaps: ResultsLap[] = [];
    let tie = false;
    for (const d of r.drivers) {
      if (d.slot === null) continue;
      const matched = d.lapList.filter(
        (l) => l.lapTime !== null && mine.some((ms) => Math.abs(Math.round(l.lapTime! * 1000) - ms) <= LAP_MATCH_MS),
      );
      if (matched.length > bestLaps.length) {
        best = d;
        bestLaps = matched;
        tie = false;
      } else if (matched.length === bestLaps.length && matched.length > 0) tie = true;
    }
    if (best && best.slot !== null && bestLaps.length >= MIN_LAP_MATCHES && !tie) {
      return { slot: best.slot, matchedBy: 'laplog', names: stintNames(r, best, bestLaps, mine.length) };
    }
  }

  const known = new Set(knownNames.map(normName).filter(Boolean));
  if (known.size === 0) return null;
  const names = namesBySlot(r);
  let pick: ResultsDriver | null = null;
  for (const d of r.drivers) {
    if (d.slot === null) continue;
    if (!(names.get(d.slot) ?? []).some((n) => known.has(normName(n)))) continue;
    if (!pick || d.lapList.length > pick.lapList.length) pick = d;
  }
  return pick && pick.slot !== null ? { slot: pick.slot, matchedBy: 'name' } : null;
}

/* -------------------------------------------------------------------------- */
/*  Building the log                                                          */
/* -------------------------------------------------------------------------- */

/** Draw order for events sharing an `et`. */
const KIND_ORDER: Record<RaceLogKind, number> = {
  start: 0,
  flag: 1,
  driver: 2,
  contact: 3,
  damage: 4,
  limits: 5,
  penalty: 6,
  lap: 7,
  position: 8,
  pit: 9,
  finish: 10,
};

function carsOf(r: ResultsSession): RaceLogCar[] {
  return r.drivers
    .filter((d) => d.slot !== null)
    .map((d) => ({
      slot: d.slot!,
      carNumber: d.carNumber,
      carClass: d.carClass,
      vehicle: d.vehicle,
      drivers: driversOf(d),
      finishPosition: d.position,
      finishClassPosition: d.classPosition,
    }))
    .sort((a, b) => (a.finishPosition ?? 999) - (b.finishPosition ?? 999));
}

/** The layout's name, e.g. `Silverstone Grand Prix Circuit - ELMS`: what the lap log calls it. */
function trackOf(r: ResultsSession): string {
  return r.header.trackCourse || r.header.trackVenue || r.header.trackEvent;
}

/** The log with no car in it: the header, and the field to pick from. */
function unmatchedLog(r: ResultsSession, id: string): RaceLog {
  return {
    id,
    track: trackOf(r),
    startedAt: r.startedAt,
    slot: null,
    carNumber: '',
    carClass: '',
    vehicle: '',
    drivers: [],
    greenEt: r.raceStartEt ?? 0,
    gridPosition: null,
    gridClassPosition: null,
    finishPosition: null,
    finishClassPosition: null,
    finishStatus: '',
    laps: 0,
    multiclass: new Set(r.drivers.map((d) => d.carClass)).size > 1,
    matchedBy: null,
    provisional: false,
    events: [],
    cars: carsOf(r),
  };
}

/**
 * One car's race as a timeline, oldest first. `slot` is the XML slot; an
 * unknown slot gives the unmatched log rather than an empty one.
 */
export function buildRaceLog(
  r: ResultsSession,
  slot: number,
  matchedBy: 'laplog' | 'name' | 'picked',
  id = '',
): RaceLog {
  const me = r.drivers.find((d) => d.slot === slot);
  if (!me) return unmatchedLog(r, id);

  const greenEt = r.raceStartEt ?? me.lapList[0]?.et ?? 0;
  const multiclass = new Set(r.drivers.map((d) => d.carClass)).size > 1;
  const cls = classLabel(me.carClass);
  const joinEt = r.firstStreamEt !== null && r.firstStreamEt > greenEt + JOIN_GRACE_S ? r.firstStreamEt : null;
  const crossings = crossingsOf(r);
  const myEnds = crossings.get(me)!;
  const laps = me.lapList;

  const events: RaceLogEvent[] = [];
  // The lap being driven at `et`. Past our last crossing it is the lap we
  // never finished, unless we took the flag, when it stays the last one.
  const finished = me.finishStatus === 'Finished Normally';
  const lapAt = (et: number): number => {
    if (et < greenEt) return 0;
    let n = laps.length ? laps[0]!.num : 1;
    for (const l of laps) {
      if (l.et > et) break;
      n = l.num;
      const end = myEnds.get(l.num);
      if (end !== undefined && et >= end && !finished) n = l.num + 1;
    }
    return n;
  };
  const push = (et: number, kind: RaceLogKind, text: string, detail?: RaceLogDetail, lap?: number) => {
    const ev: RaceLogEvent = { et, raceS: et - greenEt, lap: lap ?? lapAt(et), kind, text, source: 'xml' };
    if (detail) ev.detail = detail;
    events.push(ev);
  };
  const where = (pos: number | null, cpos: number | null): string => {
    if (pos === null) return '';
    return multiclass && cpos !== null ? `P${pos} (P${cpos} in ${cls})` : `P${pos}`;
  };

  // START
  const grid = where(me.gridPos, me.classGridPos);
  push(greenEt, 'start', grid ? `Green flag. Started ${grid}` : 'Green flag', {
    ...(me.gridPos !== null ? { position: me.gridPos } : {}),
    ...(me.classGridPos !== null ? { classPosition: me.classGridPos } : {}),
  }, 0);

  // LAPS, POSITIONS, PITS
  const invalidByLimits = new Set<number>();
  const excursions = new Map<number, number>();
  for (const e of r.stream) {
    if (e.type !== 'limits' || e.slot !== slot) continue;
    if (/invalid lap/i.test(e.verdict)) invalidByLimits.add(lapAt(e.et));
    if (isNoAction(e)) excursions.set(lapAt(e.et), (excursions.get(lapAt(e.et)) ?? 0) + 1);
  }
  const classBest = bestBeforeOf(r.drivers.filter((d) => d !== me && d.carClass === me.carClass), crossings);
  let myBest = Infinity;
  let prevPos = me.gridPos;
  let prevCpos = me.classGridPos;
  for (const lap of laps) {
    const end = myEnds.get(lap.num);
    if (end === undefined) continue;
    const invalid = lap.lapTime === null || invalidByLimits.has(lap.num);
    const detail: RaceLogDetail = {};
    const tags: string[] = [];
    if (lap.lapTime !== null) detail.lapMs = Math.round(lap.lapTime * 1000);
    if (invalid) {
      detail.invalid = true;
      tags.push('invalid');
    } else if (lap.lapTime !== null) {
      if (lap.lapTime < myBest && Number.isFinite(myBest)) {
        detail.personalBest = true;
        tags.push('personal best');
      }
      // Beats every counted lap in the class so far, ours included. The first
      // lap anyone times beats nothing, so it is not called a best.
      const prior = Math.min(classBest(end), myBest);
      if (Number.isFinite(prior) && lap.lapTime < prior) {
        detail.classBest = true;
        tags.push(multiclass ? 'class best' : 'fastest lap so far');
      }
      myBest = Math.min(myBest, lap.lapTime);
    }
    if (lap.pit) {
      detail.pitIn = true;
      tags.push('pit in');
    }
    const offs = excursions.get(lap.num) ?? 0;
    if (offs) detail.excursions = offs;
    const time = lap.lapTime !== null ? formatLapTime(lap.lapTime) : 'no time';
    const offTxt = offs ? `(${offs} off-track, no action)` : '';
    push(end, 'lap', [`Lap ${lap.num}`, time, tags.join(', '), offTxt].filter(Boolean).join('  '), detail, lap.num);

    // Position at this crossing, counted from everyone's crossings of the same lap.
    const known = !lap.backfilled && (joinEt === null || end >= joinEt);
    if (known) {
      let pos = 1;
      let cpos = 1;
      for (const [d, ends] of crossings) {
        if (d === me) continue;
        const t = ends.get(lap.num);
        if (t !== undefined && t < end) {
          pos++;
          if (d.carClass === me.carClass) cpos++;
        }
      }
      if (prevPos !== null && (pos !== prevPos || (multiclass && prevCpos !== null && cpos !== prevCpos))) {
        const gained = prevPos - pos;
        const now = `now ${where(pos, cpos)}`;
        const cg = prevCpos !== null ? prevCpos - cpos : 0;
        const text =
          gained > 0
            ? `Gained ${places(gained)}, ${now}`
            : gained < 0
              ? `Lost ${places(-gained)}, ${now}`
              : `${cg > 0 ? 'Gained' : 'Lost'} ${places(Math.abs(cg))} in class, ${now}`;
        const pd: RaceLogDetail = { position: pos, classPosition: cpos, gained };
        if (prevCpos !== null) pd.classGained = prevCpos - cpos;
        push(end, 'position', text, pd, lap.num);
      }
      prevPos = pos;
      prevCpos = cpos;
    } else {
      prevPos = null; // the next known crossing sets the baseline, it says nothing
      prevCpos = null;
    }

    if (lap.pit) push(end, 'pit', 'Pit stop', { pitIn: true }, lap.num);
  }

  // CONTACTS
  for (const c of contactsBySlot(r).get(slot) ?? []) {
    const severity = contactSeverity(c.magnitude);
    const word = severity === 'heavy' ? 'Heavy contact' : 'Light contact';
    if (c.otherSlot !== null) {
      const other = r.drivers.find((d) => d.slot === c.otherSlot);
      const name = c.otherName ?? other?.name ?? `car ${c.otherSlot}`;
      const numTxt = other?.carNumber ? ` (#${other.carNumber})` : '';
      // `Mark Harris#8511`: LMU's tag for a repeated name. Beside a car number
      // it reads as a second number, so the sentence drops it; detail keeps it.
      const shown = name.replace(/#\d+$/, '');
      const detail: RaceLogDetail = { otherSlot: c.otherSlot, otherName: name, severity };
      if (other?.carNumber) detail.otherNumber = other.carNumber;
      push(c.et, 'contact', `${word} with ${shown}${numTxt}`, detail);
    } else {
      const obj = c.object ?? 'scenery';
      push(c.et, 'contact', `${word} with ${SCENERY[obj] ?? obj.toLowerCase()}`, { scenery: obj, severity });
    }
  }

  // DAMAGE
  const lastDamage = new Map<string, number>();
  for (const e of r.stream) {
    if (e.type !== 'sector' || e.slot !== slot || !e.damage) continue;
    const prev = lastDamage.get(e.damage);
    lastDamage.set(e.damage, e.et);
    if (prev !== undefined && e.et - prev < DAMAGE_MERGE_S) continue;
    push(e.et, 'damage', `New ${e.damage} damage`, { zones: [e.damage] });
  }

  // TRACK LIMITS
  const limit = pointsLimitOf(r);
  let prevLimits: Extract<StreamEntry, { type: 'limits' }> | null = null;
  for (const e of r.stream) {
    // "No Further Action" is folded into its lap (see the lap loop): a
    // four-hour race has ~140 of them, and a log of them is not a brief record.
    if (e.type !== 'limits' || e.slot !== slot || isNoAction(e)) continue;
    // LMU often files a verdict again ~1 s later with the points total
    // unchanged (Long Beach 2026-09-24, slot 32: 754.9 then 756.1, both
    // "0.25"). Nothing new was charged, so it is the same moment.
    const echo = prevLimits !== null && e.et - prevLimits.et <= LIMITS_ECHO_S
      && e.resolution === prevLimits.resolution && e.currentPoints === prevLimits.currentPoints;
    prevLimits = e;
    if (echo) continue;
    const detail: RaceLogDetail = { verdict: e.verdict, warningPoints: e.currentPoints };
    if (limit !== undefined) detail.pointsLimit = limit;
    push(e.et, 'limits', limitsText(e.resolution, e.verdict, e.currentPoints, limit), detail);
  }

  // PENALTIES
  const ours = new Set((namesBySlot(r).get(slot) ?? []).map(normName));
  for (const e of r.stream) {
    if (e.type !== 'penalty') continue;
    if (e.action === 'given' && e.slot === slot) {
      const reason = (LOCALISED_REASONS[e.reason] ?? e.reason).replace(/\.$/, '');
      const label = penaltyLabel(e.penalty, e.seconds);
      const text = e.penalty === 'Disqualify' || !reason ? label : `${label} for ${reason.toLowerCase()}`;
      const detail: RaceLogDetail = { penaltyKind: e.penalty };
      if (reason) detail.reason = reason;
      push(e.et, 'penalty', text, detail);
    } else if (e.action === 'served' && ours.has(normName(e.name))) {
      push(e.et, 'penalty', `Served the ${penaltyLabel(e.penalty, 0).toLowerCase()}`, { penaltyKind: e.penalty });
    } else if (e.action === 'converted' && ours.has(normName(e.name))) {
      push(e.et, 'penalty', `Finished before serving the penalty: ${pts(e.seconds)} s added`, {});
    }
  }

  // DRIVER SWAPS
  let swapped = false;
  for (const e of r.stream) {
    if (e.type !== 'driverChange' || e.slot !== slot) continue;
    swapped = true;
    push(e.et, 'driver', `${e.newName} takes over from ${e.oldName}`, {});
  }
  if (!swapped) {
    // No stream rows (an older build, or the change fell before the stream
    // began): the block's own stint list still says who took over when.
    for (let i = 1; i < me.swaps.length; i++) {
      const s = me.swaps[i]!;
      const prev = me.swaps[i - 1]!;
      const at = laps.find((l) => l.num === s.startLap)?.et;
      if (at === undefined || s.name === prev.name) continue;
      push(at, 'driver', `${s.name} takes over from ${prev.name}`, {});
    }
  }

  // FINISH
  const lastEnd = laps.reduce((m, l) => Math.max(m, myEnds.get(l.num) ?? l.et), greenEt);
  const finishPos = where(me.position, me.classPosition);
  const fd: RaceLogDetail = { status: me.finishStatus };
  if (me.position !== null) fd.position = me.position;
  if (me.classPosition !== null) fd.classPosition = me.classPosition;
  const lapsTxt = `${me.laps} lap${me.laps === 1 ? '' : 's'}`;
  const lastLap = laps.length ? laps[laps.length - 1]!.num : 0;
  if (me.finishStatus === 'Finished Normally') {
    push(lastEnd, 'finish', `Chequered flag. Finished ${finishPos}, ${lapsTxt}`, fd, lastLap);
  } else if (me.finishStatus === 'DNF') {
    const lastSeen = r.stream.reduce(
      (m, e) => (streamSlot(e) === slot && e.et > m ? e.et : m),
      lastEnd,
    );
    const why = me.dnfReason && me.dnfReason !== 'DNF' ? `: ${me.dnfReason.toLowerCase()}` : '';
    push(lastSeen, 'finish', `Retired on lap ${lapAt(lastSeen) || 1}${why}`, fd);
  } else if (me.finishStatus === 'DQ') {
    push(lastEnd, 'finish', `Disqualified after ${lapsTxt}`, fd, lastLap);
  } else {
    // `None`: still running when the file was written (the flag had not
    // reached it), or gone from the server. The classification stands either way.
    push(lastEnd, 'finish', `Classified ${finishPos}, ${lapsTxt}`, fd, lastLap);
  }

  events.sort((a, b) => a.et - b.et || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  return {
    id,
    track: trackOf(r),
    startedAt: r.startedAt,
    slot,
    carNumber: me.carNumber,
    carClass: me.carClass,
    vehicle: me.vehicle,
    drivers: driversOf(me),
    greenEt,
    gridPosition: me.gridPos,
    gridClassPosition: me.classGridPos,
    finishPosition: me.position,
    finishClassPosition: me.classPosition,
    finishStatus: me.finishStatus,
    laps: me.laps,
    multiclass,
    matchedBy,
    provisional: false,
    events,
    cars: carsOf(r),
  };
}

/** The slot a stream row is about, when it names one. */
function streamSlot(e: StreamEntry): number | null {
  switch (e.type) {
    case 'incident':
    case 'limits':
    case 'sector':
    case 'score':
    case 'driverChange':
      return e.slot;
    case 'penalty':
      return e.action === 'given' ? e.slot : null;
    default:
      return null;
  }
}

/**
 * A lookup: the fastest counted lap among `cars` that finished before `et`,
 * Infinity if none. Sorted once with running minima, then a binary search per
 * question: scanning every car's laps for each of ours was half the build of a
 * four-hour race (27 cars × 220 laps, asked 220 times).
 */
function bestBeforeOf(cars: ResultsDriver[], crossings: Map<ResultsDriver, Map<number, number>>): (et: number) => number {
  const laps: { end: number; t: number }[] = [];
  for (const d of cars) {
    const ends = crossings.get(d)!;
    for (const l of d.lapList) {
      const end = ends.get(l.num);
      if (l.lapTime !== null && end !== undefined) laps.push({ end, t: l.lapTime });
    }
  }
  laps.sort((a, b) => a.end - b.end);
  const ends = laps.map((l) => l.end);
  const minTo: number[] = [];
  let best = Infinity;
  for (const l of laps) minTo.push((best = Math.min(best, l.t)));
  return (et) => {
    let lo = 0;
    let hi = ends.length; // first index with end >= et
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid]! < et) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? Infinity : minTo[lo - 1]!;
  };
}

/** A track-limits verdict of "No Further Action". */
function isNoAction(e: Extract<StreamEntry, { type: 'limits' }>): boolean {
  return e.resolution === 7 || /no further action/i.test(e.verdict);
}

function limitsText(resolution: number, verdict: string, points: number, limit: number | undefined): string {
  if (/invalid lap/i.test(verdict)) {
    return /cut/i.test(verdict) ? 'Lap invalidated: cut the track' : 'Lap invalidated: left the track';
  }
  switch (resolution) {
    case 7:
      return 'Track limits: no further action';
    case 4:
      return `Track limits: warning, ${pts(points)}${limit !== undefined ? ` of ${pts(limit)}` : ''} point${points === 1 && limit === undefined ? '' : 's'}`;
    case 2:
      return 'Track limits: drive-through penalty';
    case 1:
      return 'Track limits: stop-go penalty';
    case 3:
      return 'Track limits: time penalty';
    case 0:
      return 'Track limits: disqualified';
    default:
      return `Track limits: ${verdict.toLowerCase() || 'verdict'}`;
  }
}

/* -------------------------------------------------------------------------- */
/*  Disk access: written once, run sync or async                              */
/* -------------------------------------------------------------------------- */

/**
 * What the listing, loading and picking steps ask of the disk. They are
 * generators that yield these instead of calling `fs`, so one body serves two
 * drivers: {@link runSync} for the tests and the shot harness, {@link runAsync}
 * for the IPC handlers. Electron's main process also runs the overlay loop,
 * and sync reads and spawns there froze every overlay (2026-08-27, 2026-09-19);
 * run async, every read and write is a promise and a `tick` hands the loop back
 * once a slice is spent.
 */
type Op =
  | { op: 'tick' }
  | { op: 'readdir'; dir: string }
  | { op: 'stat'; files: string[] }
  | { op: 'read'; file: string }
  | { op: 'write'; file: string; value: unknown }
  /** Read-modify-write of a JSON file; `fn` answers the new value, or undefined to leave it. */
  | { op: 'mutate'; file: string; fn: (current: unknown) => unknown };

type Steps<T> = Generator<Op, T, unknown>;

const TICK: Op = { op: 'tick' };

/** Longest run of work between two hand-backs of the event loop, ms: a quarter of a 30 Hz overlay frame. */
const SLICE_MS = 8;

function* readdirStep(dir: string): Steps<string[] | null> {
  return (yield { op: 'readdir', dir }) as string[] | null;
}

function* statStep(files: string[]): Steps<(fs.Stats | null)[]> {
  return (yield { op: 'stat', files }) as (fs.Stats | null)[];
}

function* readStep(file: string): Steps<string | null> {
  return (yield { op: 'read', file }) as string | null;
}

function* writeStep(file: string, value: unknown): Steps<boolean> {
  return (yield { op: 'write', file, value }) as boolean;
}

/** True when `fn` asked for a write and it landed. */
function* mutateStep(file: string, fn: (current: unknown) => unknown): Steps<boolean> {
  return (yield { op: 'mutate', file, fn }) as boolean;
}

/** A plain step generator (one that yields `void` between chunks) as ticks. */
function* ticked<T>(it: Generator<void, T, void>): Steps<T> {
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
    yield TICK;
  }
}

/**
 * A fresh temp name per write. `names.json` has two writers, the provider's
 * {@link rememberDriverName} and the listing's seeding; sharing
 * `names.json.<pid>.tmp` let one rename the other's half-written file, or find
 * it gone (ENOENT).
 */
let tmpSeq = 0;
function tmpFor(file: string): string {
  return `${file}.${process.pid}.${++tmpSeq}.tmp`;
}

function readJsonSync(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonSync(file: string, value: unknown): boolean {
  const tmp = tmpFor(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    fs.rm(tmp, { force: true }, () => undefined);
    return false;
  }
}

async function readJsonAsync(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeJsonAsync(file: string, value: unknown): Promise<boolean> {
  const tmp = tmpFor(file);
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(value), 'utf8');
    await fs.promises.rename(tmp, file);
    return true;
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
}

/**
 * One queue per file: an async read-modify-write finishes before the next one
 * reads, so two writers cannot each add a name and lose the other's.
 */
const queues = new Map<string, Promise<unknown>>();
function serially<T>(file: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(file) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => undefined);
  queues.set(file, tail);
  void tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return run;
}

function doSync(op: Op): unknown {
  switch (op.op) {
    case 'tick':
      return undefined;
    case 'readdir':
      try {
        return fs.readdirSync(op.dir);
      } catch {
        return null;
      }
    case 'stat':
      return op.files.map((f) => {
        try {
          return fs.statSync(f);
        } catch {
          return null;
        }
      });
    case 'read':
      try {
        return fs.readFileSync(op.file, 'utf8');
      } catch {
        return null;
      }
    case 'write':
      return writeJsonSync(op.file, op.value);
    case 'mutate': {
      const next = op.fn(readJsonSync(op.file));
      return next === undefined ? false : writeJsonSync(op.file, next);
    }
  }
}

async function doAsync(op: Op): Promise<unknown> {
  switch (op.op) {
    case 'tick':
      return undefined;
    case 'readdir':
      return fs.promises.readdir(op.dir).catch(() => null);
    case 'stat':
      return Promise.all(op.files.map((f) => fs.promises.stat(f).catch(() => null)));
    case 'read':
      return fs.promises.readFile(op.file, 'utf8').catch(() => null);
    case 'write':
      return serially(op.file, () => writeJsonAsync(op.file, op.value));
    case 'mutate':
      return serially(op.file, async () => {
        const next = op.fn(await readJsonAsync(op.file));
        return next === undefined ? false : writeJsonAsync(op.file, next);
      });
  }
}

/** For tests and the shot harness. The sync writers do not join the async queues. */
function runSync<T>(steps: Steps<T>): T {
  let input: unknown;
  for (;;) {
    const step = steps.next(input);
    if (step.done) return step.value;
    input = doSync(step.value);
  }
}

async function runAsync<T>(steps: Steps<T>): Promise<T> {
  let input: unknown;
  let sliceFrom = performance.now();
  for (;;) {
    const step = steps.next(input);
    if (step.done) return step.value;
    const op = step.value;
    input = undefined;
    if (op.op === 'tick') {
      if (performance.now() - sliceFrom < SLICE_MS) continue;
      await new Promise<void>((resolve) => setImmediate(resolve));
    } else {
      input = await doAsync(op);
    }
    sliceFrom = performance.now();
  }
}

/* -------------------------------------------------------------------------- */
/*  Local state: known names, picks                                           */
/* -------------------------------------------------------------------------- */

/** `~/.apex-overlay/racelog`, beside the lap log. */
export function racelogDir(): string {
  return path.join(os.homedir(), '.apex-overlay', 'racelog');
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * LMU's `UserData\Log\Results`, or null when the game is not found. The Game
 * folder picker (`APEX_LMU_ROOT`, see `lmuKeybinds.lmuRootOverride`) comes
 * first: it is how a driver with LMU outside the Steam libraries gets setups
 * and key bindings working, and the race log must follow it. Then the Steam
 * lookup, as `lmuReplay.resultsPathFor` does.
 */
export function defaultResultsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = typeof env.APEX_LMU_ROOT === 'string' ? env.APEX_LMU_ROOT.trim().replace(/[\\/]+$/, '') : '';
  if (root) {
    const dir = path.join(root, 'UserData', 'Log', 'Results');
    if (isDir(dir)) return dir;
  }
  const log = findLmuLogDir(env);
  return log ? path.join(log, 'Results') : null;
}

function namesOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && n.trim() !== '') : [];
}

function picksOf(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
      if (typeof s === 'number' && Number.isInteger(s) && s >= 0) out[k] = s;
    }
  }
  return out;
}

function* readJsonStep(file: string): Steps<unknown> {
  const text = yield* readStep(file);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The driver names this PC has raced under (`names.json`). */
export function readKnownNames(dir = racelogDir()): string[] {
  return namesOf(readJsonSync(path.join(dir, 'names.json')));
}

const rememberedThisRun = new Set<string>();

/**
 * Add a driver name the sim reported for this PC. Called by the provider when
 * it reads `mPlayerName`, which happens once per run, so this touches the disk
 * at most once per new name. Async all the way: the caller is the telemetry
 * poll, and sync IO on that path is how the overlays froze on 2026-09-19.
 * Queued with every other `names.json` write. Resolves true when a name was
 * added. Never rejects.
 */
export async function rememberDriverName(name: string, dir = racelogDir()): Promise<boolean> {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || rememberedThisRun.has(`${dir}\u0000${normName(n)}`)) return false;
  rememberedThisRun.add(`${dir}\u0000${normName(n)}`);
  try {
    return (await runAsync(seedStep([n], dir))).length > 0;
  } catch {
    return false;
  }
}

/** Add the names not yet known, in one queued write. Answers the names added. */
function* seedStep(names: string[], dir: string): Steps<string[]> {
  let added: string[] = [];
  const wrote = yield* mutateStep(path.join(dir, 'names.json'), (cur) => {
    const have = namesOf(cur);
    const seen = new Set(have.map(normName));
    added = [];
    for (const raw of names) {
      const n = typeof raw === 'string' ? raw.trim() : '';
      if (!n || seen.has(normName(n))) continue;
      seen.add(normName(n));
      added.push(n);
    }
    return added.length ? [...have, ...added] : undefined;
  });
  return wrote ? added : [];
}

/**
 * Add every name not yet known, in one write, queued behind any other
 * `names.json` write. A no-op (no disk write) when nothing is new. Answers the
 * names added. Never rejects.
 */
export async function seedNames(names: string[], dir = racelogDir()): Promise<string[]> {
  try {
    return await runAsync(seedStep(names, dir));
  } catch {
    return [];
  }
}

/** Remembered car picks, results file id → slot. */
export function readPicks(dir = racelogDir()): Record<string, number> {
  return picksOf(readJsonSync(path.join(dir, 'picks.json')));
}

/**
 * Remember (or with null, forget) which car was ours in one file. The bare
 * write, sync: {@link pickSlotAsync} is what the app calls.
 */
export function setPickedSlot(id: string, slot: number | null, dir = racelogDir()): boolean {
  if (!isResultsId(id) || (slot !== null && !(Number.isInteger(slot) && slot >= 0))) return false;
  return runSync(pickWriteStep(id, slot, dir));
}

function* pickWriteStep(id: string, slot: number | null, dir: string): Steps<boolean> {
  return yield* mutateStep(path.join(dir, 'picks.json'), (cur) => {
    const picks = picksOf(cur);
    if (slot === null) delete picks[id];
    else picks[id] = slot;
    return picks;
  });
}

/**
 * The names to forget when a driver picks `slot` in a race their names had
 * placed on another car: the known names that drove the wrongly matched car,
 * less any that also drove the picked one (a team-mate who swapped cars, or a
 * name two people share).
 */
function* unlearnStep(r: ResultsSession, slot: number, laps: LapRecord[], stateDir: string): Steps<string[]> {
  // A lap-log match was not a name's doing: nothing to unlearn.
  const byLaps = findOurSlot(r, laps, []);
  if (byLaps) return [];
  const namesFile = path.join(stateDir, 'names.json');
  const known = namesOf(yield* readJsonStep(namesFile));
  const auto = findOurSlot(r, [], known);
  if (!auto || auto.slot === slot) return [];
  const bySlot = namesBySlot(r);
  const wrong = new Set((bySlot.get(auto.slot) ?? []).map(normName));
  const picked = new Set((bySlot.get(slot) ?? []).map(normName));
  const drop = new Set(known.map(normName).filter((n) => wrong.has(n) && !picked.has(n)));
  if (drop.size === 0) return [];
  let dropped: string[] = [];
  const wrote = yield* mutateStep(namesFile, (cur) => {
    const have = namesOf(cur);
    dropped = have.filter((n) => drop.has(normName(n)));
    return dropped.length ? have.filter((n) => !drop.has(normName(n))) : undefined;
  });
  for (const n of dropped) rememberedThisRun.delete(`${stateDir}\u0000${normName(n)}`);
  return wrote ? dropped : [];
}

function* pickSteps(id: string, slot: number | null, resultsDir: string | null, opts: RaceLogOptions): Steps<boolean> {
  if (!isResultsId(id) || (slot !== null && !(Number.isInteger(slot) && slot >= 0))) return false;
  const stateDir = opts.stateDir ?? racelogDir();
  if (!(yield* pickWriteStep(id, slot, stateDir))) return false;
  if (slot === null || !resultsDir) return true;
  const r = yield* readResultsStep(path.join(resultsDir, id), true);
  if (r) yield* unlearnStep(r, slot, opts.laps ?? readAllLaps(opts.lapDir ?? lapDir()), stateDir);
  return true;
}

/**
 * "Which car was yours?": remember the pick (null forgets it). When the race
 * had been placed by a driver name and the pick is another car, that name was
 * wrong for this PC and is forgotten, unless it also drove the picked car. The
 * lap log and a name learnt in error would otherwise keep placing races on a
 * team-mate. Sync, for tests.
 */
export function pickSlot(
  id: string,
  slot: number | null,
  resultsDir: string | null = defaultResultsDir(),
  opts: RaceLogOptions = {},
): boolean {
  try {
    return runSync(pickSteps(id, slot, resultsDir, opts));
  } catch {
    return false;
  }
}

/** {@link pickSlot}, async: what the `review:racelogPick` handler calls. Never rejects. */
export async function pickSlotAsync(
  id: string,
  slot: number | null,
  resultsDir: string | null = defaultResultsDir(),
  opts: RaceLogOptions = {},
): Promise<boolean> {
  try {
    return await runAsync(pickSteps(id, slot, resultsDir, opts));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Listing and loading                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A race results file name, and nothing that could climb out of the folder.
 * `R1`, `R2`…: a weekend with two races writes one file per race (the 207 on
 * Carl's PC are all `R1`). Practice, qualifying and warm-up (`P1`, `Q1`, `WU`)
 * are not races.
 */
function isResultsId(id: string): boolean {
  return typeof id === 'string' && /^[\w-]+R\d+\.xml$/i.test(id);
}

export interface RaceLogOptions {
  /** The lap log folder; defaults to `~/.apex-overlay/laps`. */
  lapDir?: string;
  /** Names, picks, the summary index and the live files; defaults to {@link racelogDir}. */
  stateDir?: string;
  /** Already-read lap log, to skip reading it again. */
  laps?: LapRecord[];
  /** Wall clock, ms, that the live files' {@link LIVE_DAYS} window counts back from; tests pin it. */
  now?: number;
}

/**
 * What a listing keeps per file, so the next listing need not re-read it.
 * Everything that depends on things that change (picks, names, the lap log)
 * is kept as inputs, not answers, except the lap-log match, which is stored
 * with the lap count it was made from and redone if that count moves.
 */
interface Digest {
  /** The file would not parse; kept so it is not re-read every listing. */
  bad?: true;
  mtimeMs: number;
  size: number;
  track: string;
  startedAt: number;
  /** The green flag's and the file's last `et`, for pairing with a live race. */
  greenEt: number;
  lastEt: number;
  fromMs: number;
  toMs: number;
  /** `names`: who drove the laps that matched, for {@link seedNames}. */
  laplog: { n: number; slot: number | null; names: string[] };
  cars: {
    slot: number;
    names: string[];
    carClass: string;
    position: number | null;
    classPosition: number | null;
    laps: number;
    contacts: number;
    penalties: number;
  }[];
}

interface DigestIndex {
  v: 4;
  files: Record<string, Digest>;
}

/** 4: `laplog.names` follow the tighter {@link SEED_MAJORITY} and {@link SEED_MIN_LAPS}. */
const INDEX_VERSION = 4;
const indexMemo = new Map<string, DigestIndex>();

function* loadIndexStep(stateDir: string): Steps<DigestIndex> {
  const hit = indexMemo.get(stateDir);
  if (hit) return hit;
  const v = (yield* readJsonStep(path.join(stateDir, 'index.json'))) as DigestIndex | undefined;
  // A listing that ran while this one read the file has the newer copy.
  const again = indexMemo.get(stateDir);
  if (again) return again;
  const idx: DigestIndex =
    v && v.v === INDEX_VERSION && v.files && typeof v.files === 'object' ? v : { v: INDEX_VERSION, files: {} };
  indexMemo.set(stateDir, idx);
  return idx;
}

function laplogSlot(r: ResultsSession, laps: LapRecord[]): Digest['laplog'] {
  const inRace = lapsInRace(r, laps);
  const found = inRace.length >= MIN_LAP_MATCHES ? findOurSlot(r, inRace, []) : null;
  return { n: inRace.length, slot: found ? found.slot : null, names: found?.names ?? [] };
}

/**
 * The wall times of the laps {@link lapsInRace} would keep, sorted, so a warm
 * listing counts each file's window by binary search. Date-parsing all 1 176
 * laps once per file was 30 ms of a 38 ms warm listing of 207 files.
 */
function lapTimesOf(laps: LapRecord[]): number[] {
  const out: number[] = [];
  for (const l of laps) {
    if (!(l.lapMs > 0) || (l.sim && l.sim !== 'lmu')) continue;
    const at = Date.parse(l.at);
    if (Number.isFinite(at)) out.push(at);
  }
  return out.sort((a, b) => a - b);
}

/** First index in sorted `xs` whose value is >= `x` (or > `x` with `after`). */
function lowerBound(xs: number[], x: number, after = false): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x || (after && xs[mid] === x)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function countInWindow(times: number[], fromMs: number, toMs: number): number {
  return Math.max(0, lowerBound(times, toMs, true) - lowerBound(times, fromMs));
}

function digestOf(r: ResultsSession, st: fs.Stats, laps: LapRecord[]): Digest {
  const { fromMs, toMs } = raceWindow(r);
  const penalties = new Map<number, number>();
  for (const e of r.stream) {
    if (e.type === 'penalty' && e.action === 'given') penalties.set(e.slot, (penalties.get(e.slot) ?? 0) + 1);
  }
  const names = namesBySlot(r);
  const contacts = contactsBySlot(r);
  return {
    mtimeMs: st.mtimeMs,
    size: st.size,
    track: trackOf(r),
    startedAt: r.startedAt,
    greenEt: r.raceStartEt ?? 0,
    lastEt: r.lastEt,
    fromMs,
    toMs,
    laplog: laplogSlot(r, laps),
    cars: r.drivers
      .filter((d) => d.slot !== null)
      .map((d) => ({
        slot: d.slot!,
        names: names.get(d.slot!) ?? [],
        carClass: d.carClass,
        position: d.position,
        classPosition: d.classPosition,
        laps: d.lapList.length,
        contacts: contacts.get(d.slot!)?.length ?? 0,
        penalties: penalties.get(d.slot!) ?? 0,
      })),
  };
}

function badDigest(st: fs.Stats): Digest {
  return { bad: true, mtimeMs: st.mtimeMs, size: st.size, track: '', startedAt: 0, greenEt: 0, lastEt: 0, fromMs: 0, toMs: 0, laplog: { n: 0, slot: null, names: [] }, cars: [] };
}

/**
 * The race last opened, by file, mtime and size: a pick re-opens the race it
 * was made in, and so does clicking back to it. One file's worth, not a cache
 * of every race.
 */
let lastOpened: { file: string; mtimeMs: number; size: number; r: ResultsSession } | null = null;

/** A race's results, parsed in steps; null when missing, unreadable or not a race. */
function* readResultsStep(file: string, remember = false): Steps<ResultsSession | null> {
  let st: fs.Stats | null = null;
  if (remember) {
    [st = null] = yield* statStep([file]);
    if (!st) return null;
    if (lastOpened && lastOpened.file === file && lastOpened.mtimeMs === st.mtimeMs && lastOpened.size === st.size) {
      return lastOpened.r;
    }
  }
  const text = yield* readStep(file);
  if (text === null) return null;
  const r = yield* ticked(parseResultsSteps(text));
  if (!r || r.sessionType !== 'race') return null;
  if (remember && st) lastOpened = { file, mtimeMs: st.mtimeMs, size: st.size, r };
  return r;
}

/* -------------------------------------------------------------------------- */
/*  The live half (raceLogRecorder.ts)                                        */
/* -------------------------------------------------------------------------- */

/** A live-only race's id: `live:` plus the recorder's race key. */
const LIVE_PREFIX = 'live:';

/**
 * Days of live files read back, the recorder's own `loadLiveLog` window. A
 * live file is only ever needed to pair with a results file written ~80 s
 * after the flag, or to stand in for one the game never wrote. So a crashed,
 * live-only race older than this drops off the list; that is the price of not
 * re-reading every file ever recorded on each open.
 */
export const LIVE_DAYS = 14;

const LIVE_FILE = /^live-\d{4}-\d{2}-\d{2}\.jsonl$/;

/** The recorder's `SAME_RACE_MS`: same track, session starts this close, is one race recorded twice (an app restart), ms. */
const SAME_RACE_MS = 60_000;

/** Parsed lines per live file, kept while its mtime and size hold. */
const liveFileMemo = new Map<string, { mtimeMs: number; size: number; lines: LiveLine[] }>();
/** The races last built per folder, and the files (name, mtime, size) they came from. */
const liveRaceMemo = new Map<string, { sig: string; races: LiveRace[] }>();

/** A live file's valid lines. Torn or foreign lines are skipped: the file is appended to live. */
function liveLinesOf(text: string): LiveLine[] {
  const out: LiveLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: LiveLine;
    try {
      line = JSON.parse(raw) as LiveLine;
    } catch {
      continue;
    }
    if (line?.t === 'header' && typeof line.key === 'string') out.push(line);
    else if (line?.t === 'event' && typeof line.key === 'string' && typeof line.text === 'string') out.push(line);
  }
  return out;
}

function byTime(a: LiveEvent, b: LiveEvent): number {
  if (a.et !== null && b.et !== null && a.et !== b.et) return a.et - b.et;
  return a.at - b.at;
}

/**
 * The recorder's dedupe (the same kind and text within a second, by `et` when
 * both have one, else by wall time), in linear time. Its own compares each
 * event with every one kept: a 24 h race's thousands of lines, squared.
 * Buckets of one second hold every candidate closer than one.
 */
function dedupeLive(events: LiveEvent[]): LiveEvent[] {
  const out: LiveEvent[] = [];
  const byEt = new Map<string, LiveEvent[]>(); // kept events with an et, by floor(et)
  const byAt = new Map<string, LiveEvent[]>(); // every kept event, by floor(at / 1000)
  const near = (m: Map<string, LiveEvent[]>, base: string, b: number, hit: (o: LiveEvent) => boolean): boolean => {
    for (let d = -1; d <= 1; d++) {
      for (const o of m.get(`${base}\u0000${b + d}`) ?? []) if (hit(o)) return true;
    }
    return false;
  };
  const put = (m: Map<string, LiveEvent[]>, key: string, e: LiveEvent) => {
    const list = m.get(key);
    if (list) list.push(e);
    else m.set(key, [e]);
  };
  for (const e of events) {
    const base = `${e.kind}\u0000${e.text}`;
    const atB = Math.floor(e.at / 1000);
    const dup =
      e.et !== null
        ? near(byEt, base, Math.floor(e.et), (o) => Math.abs(o.et! - e.et!) < 1) ||
          near(byAt, base, atB, (o) => o.et === null && Math.abs(o.at - e.at) < 1000)
        : near(byAt, base, atB, (o) => Math.abs(o.at - e.at) < 1000);
    if (dup) continue;
    out.push(e);
    put(byAt, `${base}\u0000${atB}`, e);
    if (e.et !== null) put(byEt, `${base}\u0000${Math.floor(e.et)}`, e);
  }
  return out;
}

/**
 * Races from live files' lines, oldest file first: the recorder's
 * `parseLiveLog`, same answer, in linear time (a Map per key and per track,
 * and {@link dedupeLive}). Days are joined so a race across midnight is one
 * race. Exported for the test that holds the two to the same answer.
 */
export function liveRacesOf(files: readonly (readonly LiveLine[])[]): LiveRace[] {
  const races: LiveRace[] = [];
  const byKey = new Map<string, LiveRace>();
  const byTrack = new Map<string, LiveRace[]>();
  for (const lines of files) {
    for (const line of lines) {
      if (line.t === 'header') {
        let race = byKey.get(line.key);
        if (!race) {
          const same = byTrack.get(line.track);
          race = same?.find((r) => Math.abs(r.header.sessionStartMs - line.sessionStartMs) <= SAME_RACE_MS);
          if (!race) {
            race = { header: line, events: [], greenEt: null, greenAt: null, lastAt: line.firstAt, finished: false };
            races.push(race);
            if (same) same.push(race);
            else byTrack.set(line.track, [race]);
          }
          byKey.set(line.key, race);
        }
        // Later headers fill in what the first could not know.
        race.header = {
          ...race.header,
          slot: race.header.slot ?? line.slot,
          carNumber: race.header.carNumber ?? line.carNumber,
          carClass: race.header.carClass ?? line.carClass,
          driver: race.header.driver ?? line.driver,
        };
      } else {
        const race = byKey.get(line.key);
        if (!race) continue;
        race.events.push(line);
        race.lastAt = Math.max(race.lastAt, line.at);
      }
    }
  }
  for (const r of races) {
    r.events = dedupeLive(r.events.sort(byTime));
    const green = r.events.find((e) => e.kind === 'start');
    r.greenEt = green?.et ?? null;
    r.greenAt = green?.at ?? null;
    r.finished = r.events.some((e) => e.kind === 'finish');
  }
  return races;
}

/**
 * Every race in the last {@link LIVE_DAYS} of live files
 * (`racelog/live-<day>.jsonl`). A file is read and parsed only when its mtime
 * or size moved, and the races are rebuilt only when a file did, so an open
 * with nothing new recorded costs a directory read and a stat per day.
 */
function* liveRacesStep(dir: string, now: number): Steps<LiveRace[]> {
  const all = yield* readdirStep(dir);
  if (!all) return [];
  const since = dayStamp(now - LIVE_DAYS * 86_400_000);
  const names = all.filter((n) => LIVE_FILE.test(n) && n.slice(5, 15) >= since).sort();
  const files = names.map((n) => path.join(dir, n));
  const stats = yield* statStep(files);
  const sig: string[] = [];
  const lines: LiveLine[][] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const st = stats[i];
    if (!st) continue; // raced a delete; the next read sees it
    let hit = liveFileMemo.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      const text = yield* readStep(file);
      if (text === null) continue;
      hit = { mtimeMs: st.mtimeMs, size: st.size, lines: liveLinesOf(text) };
      liveFileMemo.set(file, hit);
      yield TICK;
    }
    sig.push(`${names[i]}:${hit.mtimeMs}:${hit.size}`);
    lines.push(hit.lines);
  }
  // Days that left the window, or the folder, are let go.
  const kept = new Set(files);
  for (const f of liveFileMemo.keys()) if (path.dirname(f) === dir && !kept.has(f)) liveFileMemo.delete(f);
  const key = sig.join('|');
  const memo = liveRaceMemo.get(dir);
  if (memo && memo.sig === key) return memo.races;
  const races = liveRacesOf(lines);
  liveRaceMemo.set(dir, { sig: key, races });
  return races;
}

/**
 * Just enough of a race log for `matchLiveRace` to pair. `lastEt` is the
 * FILE's last `et`, not our car's: the file is written after the whole
 * field's flag, so pairing on a retired car's last event would put the write
 * time an hour early and never pair.
 */
function pairingStub(id: string, d: { track: string; startedAt: number; greenEt: number; lastEt: number }): RaceLog {
  return {
    id,
    track: d.track,
    startedAt: d.startedAt,
    slot: null,
    carNumber: '',
    carClass: '',
    vehicle: '',
    drivers: [],
    greenEt: d.greenEt,
    gridPosition: null,
    gridClassPosition: null,
    finishPosition: null,
    finishClassPosition: null,
    finishStatus: '',
    laps: 0,
    multiclass: false,
    matchedBy: null,
    provisional: false,
    events: [{ et: d.lastEt, raceS: 0, lap: 0, kind: 'finish', text: '', source: 'xml' }],
  };
}

/** Live races no results file pairs with. Only files written within a day are tried. */
function liveOnlyRaces(races: LiveRace[], digests: [string, Digest][]): LiveRace[] {
  if (!races.length) return [];
  return races.filter((race) => {
    for (const [id, d] of digests) {
      const w = writtenAt(id);
      if (w !== null && Math.abs(w - race.lastAt) > 86_400_000) continue;
      if (matchLiveRace(pairingStub(id, d), [race])) return false;
    }
    return true;
  });
}

function liveLogOf(race: LiveRace): RaceLog {
  return { ...provisionalLog(race), id: `${LIVE_PREFIX}${race.header.key}` };
}

function liveSummary(race: LiveRace): RaceLogSummary {
  const log = liveLogOf(race);
  return {
    id: log.id,
    track: log.track,
    startedAt: log.startedAt,
    carClass: log.carClass || null,
    finishPosition: log.finishPosition,
    finishClassPosition: log.finishClassPosition,
    contacts: log.events.filter((e) => e.kind === 'contact').length,
    penalties: log.events.filter((e) => e.kind === 'penalty' && !/^served/i.test(e.text)).length,
    slot: log.slot !== null && log.slot >= 0 ? log.slot : null,
    provisional: true,
  };
}

/**
 * Fold the paired live race into an XML log: flags and graded damage the file
 * never has (see `raceLogMerge.ts`). Only when the recorder followed the same
 * slot, or did not know its slot: our car's damage must never land in the log
 * of a car we only picked or watched.
 */
function* withLiveStep(log: RaceLog, r: ResultsSession, dir: string, now: number): Steps<RaceLog> {
  if (log.slot === null) return log;
  const stub = pairingStub(log.id, { track: log.track, startedAt: log.startedAt, greenEt: log.greenEt, lastEt: r.lastEt });
  const live = matchLiveRace(stub, yield* liveRacesStep(dir, now));
  if (!live || (live.header.slot !== null && live.header.slot !== log.slot)) return log;
  return mergeLive(log, live);
}

/**
 * The listing, as steps: it ticks after each file it had to parse (and inside
 * the parse), and asks for every read and write through {@link Op}, so the
 * async form never holds the event loop for long. A cold listing of the 207
 * files on Carl's PC parses ~120 MB; done in one go on Electron's main process
 * that is a multi-second freeze of every window.
 */
function* listSteps(resultsDir: string | null, opts: RaceLogOptions): Steps<RaceLogSummary[]> {
  const stateDir = opts.stateDir ?? racelogDir();
  // No results folder (game not found, drive offline) still lists what the
  // recorder saw: a crashed race has no file, so that is all there is of it.
  const listed = resultsDir ? yield* readdirStep(resultsDir) : null;
  const names = (listed ?? []).filter(isResultsId).sort();
  const laps = opts.laps ?? readAllLaps(opts.lapDir ?? lapDir());
  const lapTimes = lapTimesOf(laps);
  const knownNames = namesOf(yield* readJsonStep(path.join(stateDir, 'names.json')));
  const known = new Set(knownNames.map(normName));
  const picks = picksOf(yield* readJsonStep(path.join(stateDir, 'picks.json')));
  const idx = yield* loadIndexStep(stateDir);
  let dirty = false;

  // Pass 1: a digest per file, parsing only what is new or changed.
  const stats = resultsDir ? yield* statStep(names.map((id) => path.join(resultsDir, id))) : [];
  const digests: [string, Digest][] = [];
  for (let i = 0; i < names.length; i++) {
    const id = names[i]!;
    const st = stats[i];
    if (!st) continue;
    let dg = idx.files[id];
    const stale = !dg || dg.mtimeMs !== st.mtimeMs || dg.size !== st.size;
    if (stale || (!dg!.bad && countInWindow(lapTimes, dg!.fromMs, dg!.toMs) !== dg!.laplog.n)) {
      const r = yield* readResultsStep(path.join(resultsDir!, id));
      // An unreadable file is remembered as such, so it is not re-read on
      // every listing until the game rewrites it.
      dg = r ? digestOf(r, st, laps) : badDigest(st);
      idx.files[id] = dg;
      dirty = true;
      yield TICK;
    }
    if (!dg!.bad) digests.push([id, dg!]);
  }

  // Every race the lap log placed says who we drove as. Those names then
  // place the races the lap log cannot reach (before July, or laps never
  // recorded), with no wait for the provider to read mPlayerName. Not from a
  // car one of our names (known, or proposed by another race) also drove:
  // there the majority may be a team-mate this PC watched.
  const proposals = digests.filter(([, d]) => d.laplog.slot !== null && d.laplog.names.length > 0);
  const proposedBy = new Map<string, number>();
  for (const [, d] of proposals) for (const n of d.laplog.names) proposedBy.set(normName(n), (proposedBy.get(normName(n)) ?? 0) + 1);
  const seeded = new Set<string>();
  for (const [, d] of proposals) {
    const drove = d.cars.find((c) => c.slot === d.laplog.slot)?.names ?? [];
    for (const n of seedable(d.laplog.names, drove, known, proposedBy)) seeded.add(n);
  }
  if (seeded.size) yield* seedStep([...seeded], stateDir);
  for (const n of seeded) known.add(normName(n));

  // Pass 2: whose car, per file.
  const out: RaceLogSummary[] = [];
  for (const [id, d] of digests) {
    let slot: number | null = null;
    const picked = picks[id];
    if (picked !== undefined && d.cars.some((c) => c.slot === picked)) slot = picked;
    else if (d.laplog.slot !== null) slot = d.laplog.slot;
    else if (known.size) {
      const hits = d.cars.filter((c) => c.names.some((n) => known.has(normName(n))));
      // Same tie-break as findOurSlot: the slot that drove most.
      if (hits.length) slot = hits.reduce((x, y) => (y.laps > x.laps ? y : x)).slot;
    }
    const car = slot !== null ? d.cars.find((c) => c.slot === slot) : undefined;
    out.push({
      id,
      track: d.track,
      startedAt: d.startedAt,
      carClass: car ? car.carClass : null,
      finishPosition: car ? car.position : null,
      finishClassPosition: car ? car.classPosition : null,
      contacts: car ? car.contacts : 0,
      penalties: car ? car.penalties : 0,
      slot,
      provisional: false,
    });
  }

  // Races the recorder saw that have no results file: the game crashed (or
  // the file is still ~80 s from being written). Listed as provisional.
  const live = yield* liveRacesStep(stateDir, opts.now ?? Date.now());
  for (const race of liveOnlyRaces(live, digests)) out.push(liveSummary(race));

  // Forget files the game has deleted, then save what changed. Not when the
  // folder could not be read: an offline drive is not a deleted history.
  if (listed) {
    const present = new Set(names);
    for (const id of Object.keys(idx.files)) {
      if (!present.has(id)) {
        delete idx.files[id];
        dirty = true;
      }
    }
  }
  if (dirty) yield* writeStep(path.join(stateDir, 'index.json'), idx);

  return out.sort((x, y) => y.startedAt - x.startedAt || (x.id < y.id ? 1 : -1));
}

/**
 * Every race results file, newest first, with our car's headline numbers.
 * Parsed files are remembered in `racelog/index.json` by mtime and size, so
 * only new or changed files are read. Sync, for tests and the shot harness.
 * Never throws.
 */
export function listRaceLogs(resultsDir: string | null = defaultResultsDir(), opts: RaceLogOptions = {}): RaceLogSummary[] {
  try {
    return runSync(listSteps(resultsDir, opts));
  } catch {
    return [];
  }
}

/**
 * {@link listRaceLogs} with async reads and writes, handing the event loop
 * back every {@link SLICE_MS}: what the IPC handler calls. Never rejects.
 */
export async function listRaceLogsAsync(
  resultsDir: string | null = defaultResultsDir(),
  opts: RaceLogOptions = {},
): Promise<RaceLogSummary[]> {
  try {
    return await runAsync(listSteps(resultsDir, opts));
  } catch {
    return [];
  }
}

function* loadSteps(id: string, resultsDir: string | null, opts: RaceLogOptions): Steps<RaceLog | null> {
  const stateDir = opts.stateDir ?? racelogDir();
  const now = opts.now ?? Date.now();
  if (typeof id === 'string' && id.startsWith(LIVE_PREFIX)) {
    const key = id.slice(LIVE_PREFIX.length);
    const race = (yield* liveRacesStep(stateDir, now)).find((x) => x.header.key === key);
    return race ? liveLogOf(race) : null;
  }
  if (!resultsDir || !isResultsId(id)) return null;
  const r = yield* readResultsStep(path.join(resultsDir, id), true);
  if (!r) return null;
  const picked = picksOf(yield* readJsonStep(path.join(stateDir, 'picks.json')))[id];
  if (picked !== undefined && r.drivers.some((d) => d.slot === picked)) {
    yield TICK; // the parse and the build are each their own slice
    return yield* withLiveStep(buildRaceLog(r, picked, 'picked', id), r, stateDir, now);
  }
  const laps = opts.laps ?? readAllLaps(opts.lapDir ?? lapDir());
  const knownNames = namesOf(yield* readJsonStep(path.join(stateDir, 'names.json')));
  const found = findOurSlot(r, laps, knownNames);
  if (found?.names?.length) {
    const learn = seedable(found.names, namesBySlot(r).get(found.slot) ?? [], new Set(knownNames.map(normName)));
    if (learn.length) yield* seedStep(learn, stateDir);
  }
  if (!found) return unmatchedLog(r, id);
  yield TICK;
  return yield* withLiveStep(buildRaceLog(r, found.slot, found.matchedBy, id), r, stateDir, now);
}

/**
 * One race's full log, or null when the file is missing or unreadable. When
 * our car cannot be found the log has `slot: null`, no events, and the field
 * in `cars`. Sync, for tests and the shot harness. Never throws.
 */
export function loadRaceLog(id: string, resultsDir: string | null = defaultResultsDir(), opts: RaceLogOptions = {}): RaceLog | null {
  try {
    return runSync(loadSteps(id, resultsDir, opts));
  } catch {
    return null;
  }
}

/**
 * {@link loadRaceLog} with async reads, the parse in slices and the build in
 * its own turn: what the IPC handlers call. Sync, the 5.2 MB four-hour race
 * held the main process for ~92 ms. Never rejects.
 */
export async function loadRaceLogAsync(
  id: string,
  resultsDir: string | null = defaultResultsDir(),
  opts: RaceLogOptions = {},
): Promise<RaceLog | null> {
  try {
    return await runAsync(loadSteps(id, resultsDir, opts));
  } catch {
    return null;
  }
}
