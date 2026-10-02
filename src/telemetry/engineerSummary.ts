/**
 * @file src/telemetry/engineerSummary.ts
 * @module telemetry/engineerSummary
 *
 * **What leaves the PC for a Tier-2 question.** A bucketed, few-hundred-token
 * snapshot of the race — never the raw frame, never the microphone. The Edge
 * Function's prompt is forbidden to invent numbers that are not in this object,
 * so every figure here is a figure the radio is allowed to speak.
 *
 * Damage goes out as a band (radio English). Fuel, energy, gaps and lap times
 * go out rounded, because those are the numbers a free-form strategy question
 * actually needs.
 *
 * Summary v5 (2026-10-02) — every failure in the late-September call log was a
 * question about data the summary did not carry, answered with a neighbour's
 * figure: "pace of P5" got the Competitive target, "gap to P10" got the gap to
 * the car ahead, "class leader times" got P2's lap. So the class timing sheet
 * (`classStandings`), the class leader, last-lap sector splits and per-corner
 * tyre numbers now ride along. The tyre band stays as the verdict; the numbers
 * sit beside it because a driver rated the band-only answer "wrong".
 */

import { UNKNOWN_VALUE } from './types';
import type { StandingEntry, TelemetryFrame } from './types';
import { overallGrade } from './damage';
import type { DamageGrade } from './raceLogTypes';
import {
  deltaToReferencePaceTarget,
  referencePaceTargets,
} from './paceTargets';

const TYRE_WINDOW_C = 8;

export interface EngineerCar {
  name: string;
  gapSec: number;
  class?: string;
  /** Their most recent completed lap, seconds. */
  lastLapSec?: number;
  /** Their best lap this session, seconds. */
  bestLapSec?: number;
  /** Their rolling average over the last few laps (see avgLaps), seconds. */
  avgLapSec?: number;
  /** How many laps that average covers (≤5). */
  avgLaps?: number;
  /** True while they are in the pit lane right now. */
  inPit?: boolean;
  /** Completed pit stops, when the sim tracks it. */
  pitStops?: number;
}

/**
 * One row of the class timing sheet the cloud gets (summary v5, 2026-10-02).
 *
 * Every gap here is a figure the standings widget would print for the same
 * car — the same `gapToClassLeaderSec` chain `EngineerCommands.classGap`
 * differences — so the radio cannot disagree with the screen. Keys are short
 * because twenty of these ride every call; the prompt's legend spells them out.
 *
 * Seconds-or-laps, never both: a car on the class leader's lap has `gap`, a
 * lapped one has `lapsDown`. LMU zeroes the overall-gap field for every lapped
 * car, and two rows' floored lap counts cannot be subtracted (a 1.47-lap
 * separation reads as two laps), so the between-cars figures (`interval`,
 * `toMe`) come from seconds when both cars have them and from the UNFLOORED
 * `classLapsBehindExact` otherwise — or are left out.
 */
export interface EngineerClassCar {
  /** Class position, 1-based. */
  pos: number;
  /** Radio name (surname, or "car 7"). */
  name: string;
  /** Car number as painted, when known. */
  car?: string;
  /** `true` on the driver's own row. */
  me?: true;
  /** Seconds behind the class leader (0 for the leader). Absent when lapped. */
  gap?: number;
  /** Whole laps down on the class leader, when lapped (instead of `gap`). */
  lapsDown?: number;
  /** Seconds to the class car directly in front. */
  interval?: number;
  /** Whole laps to the class car directly in front, when a lap or more apart. */
  intervalLaps?: number;
  /** Seconds between this car and the driver (unsigned — `pos` says which side). */
  toMe?: number;
  /** Whole laps between this car and the driver, when a lap or more apart. */
  lapsToMe?: number;
  /** Last lap, seconds. */
  last?: number;
  /** Best lap this session, seconds. */
  best?: number;
  /** Rolling average (EngineerCommands.averageOf), seconds, and its lap count. */
  avg?: number;
  avgN?: number;
  /** Completed pit stops. */
  stops?: number;
  /** In the pit lane right now. */
  inPit?: true;
  /** Retired / disqualified. */
  out?: true;
  /** Fitted compound, when the sim says. */
  tyre?: string;
}

/** The class leader, for "what's the leader doing" — absent when the driver leads. */
export interface EngineerLeader {
  name: string;
  /** The DRIVER's gap to the leader, seconds (on the leader's lap). */
  gapSec?: number;
  /** The driver's whole laps down on the leader (instead of gapSec). */
  lapsDown?: number;
  lastLapSec?: number;
  bestLapSec?: number;
  avgLapSec?: number;
  avgLaps?: number;
  /** The leader's last-lap S1/S2/S3 split durations, seconds. */
  sectorsSec?: [number, number, number];
  pitStops?: number;
  inPit?: boolean;
}

/**
 * A caller-supplied read of a car's rolling lap-time window, keyed by slot id.
 * The summary builder is a pure function of one frame, but "last five average"
 * needs history — the engineer service passes `EngineerCommands.averageOf`
 * here, so the cloud speaks from the same windows Tier 1 does. The 2026-08-19
 * engineer_calls log shows drivers asking for exactly this and being refused.
 */
export type LapAverageOf = (slotId: number) => { avg: number; count: number } | null;

export interface EngineerSummary {
  track: string;
  session: string;
  phase: string;
  flag: string;
  connected: boolean;
  class?: string;
  position?: number;
  classPosition?: number;
  currentLap?: number;
  lapsToFinish?: number;
  timeRemainingMin?: number;
  lastLapSec?: number;
  bestLapSec?: number;
  /** Best lap used by the reference scorer, seconds. */
  paceBestLapSec?: number;
  /** Best lap as a percentage of Ohne Speed's alien race-pace reference. */
  pacePercent?: number;
  /** Named source-table band: Alien, Competitive, Good, Midpack, etc. */
  paceBand?: string;
  /** The 100% alien race-pace benchmark for this resolved class/layout. */
  paceAlienRaceSec?: number;
  /** Separate alien qualifying/hotlap benchmark, when published. */
  paceAlienHotlapSec?: number;
  /** Slowest lap that still qualifies as Competitive (101% today). */
  paceCompetitiveSec?: number;
  /** Slowest lap that still qualifies as Midpack (105% today). */
  paceMidpackSec?: number;
  /** Positive = seconds the best lap still needs to find for each target. */
  paceDeltaToAlienSec?: number;
  paceDeltaToCompetitiveSec?: number;
  paceDeltaToMidpackSec?: number;
  /** Source-table identity used for the comparison. */
  paceLayout?: string;
  paceClass?: string;
  paceReferenceAssumed?: boolean;
  paceReferenceSource?: string;
  ahead?: EngineerCar;
  behind?: EngineerCar;
  /** Player's rolling average over the last few laps (see myAvgLaps), seconds. */
  myAvgLapSec?: number;
  /** How many laps that average covers (≤5). */
  myAvgLaps?: number;
  /** Player's completed pit stops, when tracked. */
  myPitStops?: number;
  /** Class cars ahead of the player that are in the pit lane right now. */
  classAheadInPitNow?: number;
  /** Class cars ahead of the player that have not made a pit stop yet. */
  classAheadNoStopYet?: number;
  /**
   * Cars ahead (same class, on an energy budget) projected to be forced into
   * the pits before the player — positions that come back on strategy alone.
   */
  carsAheadPittingFirst?: number;
  /** How many cars ahead were comparable for that projection. */
  carsAheadCompared?: number;
  fuelLaps?: number;
  energyLaps?: number;
  /** Current fuel in the tank, litres. */
  fuelL?: number;
  /** Tank capacity, litres, when the sim publishes it. */
  tankL?: number;
  /** Litres needed to reach the finish from here. */
  fuelToFinishL?: number;
  /**
   * Litres to ADD at the next stop to reach the finish (0 = none needed). The
   * direct answer to "how much fuel do I need to put in" — asked on 2026-08-20
   * and answered with the wrong number because the cloud only had laps.
   */
  refuelToFinishL?: number;
  /** Fuel margin at the flag, litres: positive = surplus, negative = short. */
  fuelDeltaL?: number;
  /** Remaining virtual energy, percent 0–100. */
  energyPct?: number;
  /** Energy margin at the flag, percentage points: positive = surplus. */
  energyDeltaPct?: number;
  /**
   * Litres of fuel burned per percentage point of virtual energy — the burn
   * ratio drivers call the "fuel ratio" (asked twice on 2026-08-19, refused).
   */
  fuelPerEnergyRatio?: number;
  /** Average fuel burn, litres per lap. */
  fuelPerLapL?: number;
  /** Average virtual-energy burn, percentage points per lap. */
  energyPerLapPct?: number;
  fuelToFlag?: 'good' | 'short' | 'critical' | 'unknown';
  pitThisLap?: boolean;
  tyres?: string;
  damage?: string;
  repairSec?: number;
  weather?: string;
  rain?: string;
  /** Track surface temperature, °C. */
  trackTempC?: number;
  /** Air temperature, °C. */
  airTempC?: number;
  yellows?: string;
  trackLimits?: string;
  hybridPct?: number;
  /** Cars in the player's class (the player included). */
  carsInClass?: number;
  /** Cars in the whole field. */
  carsTotal?: number;
  /* ---- trend + pit-exit extras (2026-08-23), from EngineerCommands ------- */
  /** Gap-ahead change, sec/lap; positive = the player is closing. */
  aheadTrendSecPerLap?: number;
  /** Laps until the player catches the car ahead at the current rate. */
  lapsToCatchAhead?: number;
  /** Gap-behind change, sec/lap; positive = the car behind is closing. */
  behindTrendSecPerLap?: number;
  /** Worst tyre's remaining tread, percent. */
  tyreWorstPct?: number;
  /** Worst tyre's wear rate, percentage points per lap. */
  tyreWearPctPerLap?: number;
  /** Laps until the worst tyre reaches the worn floor at that rate. */
  tyreLapsLeft?: number;
  /** Fuel burned on the last completed lap, litres. */
  fuelLastLapL?: number;
  /** Virtual energy burned on the last completed lap, percentage points. */
  energyLastLapPct?: number;
  /** Median measured total pit loss this session (lane + stop), seconds. */
  pitLossSec?: number;
  /** How many observed stops that median covers. */
  pitLossSamples?: number;
  /** Projected class position if the player boxed now. */
  pitExitPosition?: number;
  /** Who the player would come out behind, and by how much. */
  pitExitBehind?: string;
  pitExitBehindGapSec?: number;
  /** Who the player would come out ahead of, and by how much. */
  pitExitAheadOf?: string;
  pitExitAheadOfGapSec?: number;
  /* ---- summary v5 (2026-10-02): the timing sheet, sectors, tyre numbers -- */
  /**
   * The class timing sheet: the leader, the driver and a window around the
   * driver first, then the rest of the class nearest-first, until
   * {@link CLASS_STANDINGS_BUDGET} bytes. Sorted by class position.
   */
  classStandings?: EngineerClassCar[];
  /** True when classStandings had to leave cars out — absent ones are NOT in the data. */
  classStandingsPartial?: boolean;
  /** The class leader (absent when the driver leads the class). */
  classLeader?: EngineerLeader;
  /** Class cars retired or disqualified. Absent when none are. */
  classRetired?: number;
  /** The driver's last-lap S1/S2/S3 split durations, seconds. */
  lastSectorsSec?: [number, number, number];
  /** Driver's last-lap splits minus the class leader's: positive = the driver was slower. */
  lastSectorsVsLeaderSec?: [number, number, number];
  /**
   * Quickest of each split across every class car's MOST RECENT lap (not a
   * session-best sector — the frame carries no sector history).
   */
  classBestLastSectorsSec?: [number, number, number];
  /** Core temperature per corner, °C, [FL, FR, RL, RR]. */
  tyreCoreC?: number[];
  /** The sim's optimal tyre temperature, °C — one number when all four agree. */
  tyreOptimalC?: number | number[];
  /** Tyre pressures, kPa, [FL, FR, RL, RR]. */
  tyrePressureKpa?: number[];
  /** Remaining tread per corner, percent, [FL, FR, RL, RR]. */
  tyreTreadPct?: number[];
  /** Fitted compound (one name when all four match). */
  tyreCompound?: string;
}

/**
 * Byte budget for {@link EngineerSummary.classStandings}. The edge function
 * refuses a summary over 8000 characters (MAX_SUMMARY_CHARS, and the
 * already-deployed v13 enforces it too, so an app that ships ahead of the
 * function must still fit); the rest of a busy race summary measures ~2.3 KB
 * (2026-10-01 Le Mans row: 2291). 3200 keeps the worst case under 5 KB — the
 * whole class at most events (~24 rows at typical name lengths; a 34-car
 * class of 35-letter names measures 19 rows, summary 4.8 KB, in the test).
 */
export const CLASS_STANDINGS_BUDGET = 3200;

/**
 * The trend/pit-exit read handed in by the engineer service — the return shape
 * of `EngineerCommands.summaryExtras()`. Optional and pre-rounded; every field
 * copies straight onto the summary.
 */
export type EngineerExtras = Pick<
  EngineerSummary,
  | 'aheadTrendSecPerLap'
  | 'lapsToCatchAhead'
  | 'behindTrendSecPerLap'
  | 'tyreWorstPct'
  | 'tyreWearPctPerLap'
  | 'tyreLapsLeft'
  | 'fuelLastLapL'
  | 'energyLastLapPct'
  | 'pitLossSec'
  | 'pitLossSamples'
  | 'pitExitPosition'
  | 'pitExitBehind'
  | 'pitExitBehindGapSec'
  | 'pitExitAheadOf'
  | 'pitExitAheadOfGapSec'
>;

function known(n: number | undefined | null): n is number {
  return typeof n === 'number' && n !== UNKNOWN_VALUE && Number.isFinite(n);
}

function radioName(entry: StandingEntry): string {
  const name = (entry.driverName || '').trim();
  if (!name) return entry.carNumber ? `car ${entry.carNumber}` : 'the car';
  const parts = name.split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Pace and pit facts for one rival, appended to their gap entry. */
function enrichCar(car: EngineerCar, entry: StandingEntry, avgOf?: LapAverageOf): EngineerCar {
  if (known(entry.lastLapSec) && entry.lastLapSec > 0) car.lastLapSec = round1(entry.lastLapSec);
  if (known(entry.bestLapSec) && entry.bestLapSec > 0) car.bestLapSec = round1(entry.bestLapSec);
  const avg = avgOf ? avgOf(entry.slotId) : null;
  if (avg && avg.count > 0) {
    car.avgLapSec = round1(avg.avg);
    car.avgLaps = avg.count;
  }
  if (entry.inPit) car.inPit = true;
  if (known(entry.pitStops)) car.pitStops = entry.pitStops;
  return car;
}

function classNeighbour(
  frame: TelemetryFrame,
  dir: -1 | 1,
  avgOf?: LapAverageOf,
): EngineerCar | undefined {
  const me = frame.standings.find((e) => e.isPlayer);
  if (!me || !known(me.position)) return undefined;
  const mine = me.carClass;
  const field = mine
    ? frame.standings.filter((e) => e.carClass === mine)
    : frame.standings;
  const ordered = field
    .filter((e) => known(e.position))
    .slice()
    .sort((a, b) => a.position - b.position);
  const i = ordered.findIndex((e) => e.slotId === me.slotId);
  if (i < 0) return undefined;
  const other = ordered[i + dir];
  if (!other) return undefined;
  const gap = known(other.gapToAheadSec) && dir === 1
    ? other.gapToAheadSec
    : known(me.gapToAheadSec) && dir === -1
      ? me.gapToAheadSec
      : undefined;
  // Prefer the relative feed's signed gap when we can find the same car.
  const rel = (frame.relative || []).find((r) => r.slotId === other.slotId);
  const gapSec = rel && known(rel.relativeGapSec)
    ? Math.abs(rel.relativeGapSec)
    : known(gap)
      ? Math.abs(gap)
      : undefined;
  const car: EngineerCar = {
    name: radioName(other),
    gapSec: gapSec === undefined ? 0 : round1(gapSec),
    class: other.carClass,
  };
  return enrichCar(car, other, avgOf);
}

/**
 * The pit picture of the class cars ahead: how many are in the lane right now,
 * and how many have yet to make a stop. "How many cars are pitting before me"
 * was asked twice on day one (2026-08-19 engineer_calls log) and the cloud had
 * nothing — these two counts are what the scoring feed can actually prove.
 */
function classAheadPits(
  frame: TelemetryFrame,
): { inPitNow: number; noStopYet: number; anyTracked: boolean } | undefined {
  const me = frame.standings.find((e) => e.isPlayer);
  if (!me || !known(me.position)) return undefined;
  const mine = me.carClass;
  const myPos = known(me.classPosition) && mine ? me.classPosition : me.position;
  const aheadCars = frame.standings.filter((e) => {
    if (e.isPlayer) return false;
    if (mine && e.carClass !== mine) return false;
    const pos = known(e.classPosition) && mine ? e.classPosition : e.position;
    return known(pos) && pos < myPos;
  });
  if (!aheadCars.length) return undefined;
  let inPitNow = 0;
  let noStopYet = 0;
  let anyTracked = false;
  for (const e of aheadCars) {
    if (e.inPit) inPitNow++;
    if (known(e.pitStops)) {
      anyTracked = true;
      if (e.pitStops === 0) noStopYet++;
    }
  }
  return { inPitNow, noStopYet, anyTracked };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Cumulative S1/S2 boundaries plus the lap time → three split durations, or
 * undefined. All-or-nothing, as `EngineerCommands`' lastLapSplits: a withheld
 * or torn pair is no data, not two real splits and an invented third.
 */
function splits(e: StandingEntry | undefined): [number, number, number] | undefined {
  if (!e) return undefined;
  const { lastSector1Sec: b1, lastSector2Sec: b2, lastLapSec: lap } = e;
  if (!known(b1) || !known(b2) || !known(lap) || lap <= 0) return undefined;
  const s = [b1, b2 - b1, lap - b2];
  if (s.some((x) => x <= 0)) return undefined;
  return [round2(s[0]!), round2(s[1]!), round2(s[2]!)];
}

/** The player's class, position-ordered; the whole field when the class is unknown. */
function classRows(frame: TelemetryFrame, me: StandingEntry): StandingEntry[] {
  const mine = me.carClass;
  const rows = (frame.standings || []).filter((e) => (mine ? e.carClass === mine : true));
  const pos = (e: StandingEntry): number =>
    mine && known(e.classPosition) ? e.classPosition! : e.position;
  return rows.filter((e) => known(pos(e))).sort((a, b) => pos(a) - pos(b));
}

/**
 * Seconds — or whole laps — between two cars of the same class, from the same
 * sources the timing sheet uses. Seconds only when both are on the class
 * leader's lap (`gapToClassLeaderSec` known for both). Laps only from the
 * unfloored `classLapsBehindExact`, never by subtracting two floored counts.
 * Falls back to the relative feed for a car the player can see on track.
 */
function between(
  frame: TelemetryFrame,
  a: StandingEntry,
  b: StandingEntry,
): { sec?: number; laps?: number } {
  if (known(a.gapToClassLeaderSec) && known(b.gapToClassLeaderSec)) {
    return { sec: round1(Math.abs(a.gapToClassLeaderSec - b.gapToClassLeaderSec)) };
  }
  if (known(a.classLapsBehindExact) && known(b.classLapsBehindExact)) {
    const laps = Math.floor(Math.abs(a.classLapsBehindExact - b.classLapsBehindExact) + 1e-6);
    if (laps >= 1) return { laps };
  }
  // On-track fallback, only for a pair on the class leader's lap (an on-track
  // gap across a lap boundary is not a race gap) with the player in it.
  const other = a.isPlayer ? b : b.isPlayer ? a : undefined;
  const sameLap = (e: StandingEntry): boolean => !known(e.classLapsBehind) || e.classLapsBehind === 0;
  if (other && sameLap(a) && sameLap(b)) {
    const rel = (frame.relative || []).find((r) => r.slotId === other.slotId);
    if (rel && known(rel.relativeGapSec) && rel.relativeGapSec !== 0) {
      return { sec: round1(Math.abs(rel.relativeGapSec)) };
    }
  }
  return {};
}

function classCar(
  frame: TelemetryFrame,
  e: StandingEntry,
  pos: number,
  prev: StandingEntry | undefined,
  me: StandingEntry,
  avgOf?: LapAverageOf,
): EngineerClassCar {
  const c: EngineerClassCar = { pos, name: radioName(e) };
  if (e.carNumber) c.car = String(e.carNumber);
  if (e.isPlayer) c.me = true;
  const down = known(e.classLapsBehind) ? e.classLapsBehind! : 0;
  // The leader reads a real 0 — never mistake it for "unknown".
  if (pos === 1) c.gap = 0;
  else if (down >= 1) c.lapsDown = down;
  else if (known(e.gapToClassLeaderSec)) c.gap = round1(e.gapToClassLeaderSec);
  if (prev) {
    const iv = between(frame, prev, e);
    if (iv.sec !== undefined) c.interval = iv.sec;
    else if (iv.laps !== undefined) c.intervalLaps = iv.laps;
  }
  if (!e.isPlayer) {
    const tm = between(frame, me, e);
    if (tm.sec !== undefined) c.toMe = tm.sec;
    else if (tm.laps !== undefined) c.lapsToMe = tm.laps;
  }
  if (known(e.lastLapSec) && e.lastLapSec > 0) c.last = round1(e.lastLapSec);
  if (known(e.bestLapSec) && e.bestLapSec > 0) c.best = round1(e.bestLapSec);
  const avg = avgOf ? avgOf(e.slotId) : null;
  if (avg && avg.count > 0) {
    c.avg = round1(avg.avg);
    c.avgN = avg.count;
  }
  if (known(e.pitStops)) c.stops = e.pitStops;
  if (e.retired) c.out = true;
  else if (e.inPit) c.inPit = true;
  if (e.tyreCompound) c.tyre = e.tyreCompound;
  return c;
}

/**
 * The class timing sheet, cut to {@link CLASS_STANDINGS_BUDGET}. Priority is
 * what drivers actually ask about (2026-09 engineer_calls): the leader ("class
 * leader times"), the driver, the cars either side, the podium, then outward
 * from the driver one place at a time, ahead before behind. "Gap to P10" from
 * P16 needs P10 on the sheet; the leader of a 34-car class needs to be there
 * even when the driver is P28.
 */
function classStandings(
  frame: TelemetryFrame,
  me: StandingEntry,
  avgOf?: LapAverageOf,
): { rows: EngineerClassCar[]; partial: boolean; ordered: StandingEntry[] } | undefined {
  const ordered = classRows(frame, me);
  if (ordered.length < 2) return undefined;
  const mine = me.carClass;
  const posOf = (e: StandingEntry, i: number): number =>
    mine && known(e.classPosition) ? e.classPosition! : i + 1;
  const all = ordered.map((e, i) => classCar(frame, e, posOf(e, i), ordered[i - 1], me, avgOf));
  const myIdx = ordered.findIndex((e) => e.slotId === me.slotId);
  const order: number[] = [0, myIdx];
  const near = (d: number): void => {
    order.push(myIdx - d, myIdx + d);
  };
  near(1);
  near(2);
  order.push(1, 2);
  for (let d = 3; d < ordered.length; d++) near(d);
  const picked = new Set<number>();
  let bytes = 2; // the array brackets
  for (const i of order) {
    if (i < 0 || i >= all.length || picked.has(i)) continue;
    const size = JSON.stringify(all[i]).length + 1;
    if (bytes + size > CLASS_STANDINGS_BUDGET) continue;
    picked.add(i);
    bytes += size;
  }
  const rows = [...picked].sort((a, b) => a - b).map((i) => all[i]!);
  return { rows, partial: rows.length < all.length, ordered };
}

/** Per-corner tyre numbers, [FL, FR, RL, RR]; each array only when all four are known. */
function tyreNumbers(frame: TelemetryFrame): Partial<EngineerSummary> {
  const t = frame.player?.tyres;
  if (!t) return {};
  const corners = [t.frontLeft, t.frontRight, t.rearLeft, t.rearRight];
  const four = (read: (c: (typeof corners)[number]) => number | undefined): number[] | undefined => {
    const v = corners.map((c) => (c ? read(c) : undefined));
    return v.every((x) => x !== undefined) ? (v as number[]) : undefined;
  };
  const out: Partial<EngineerSummary> = {};
  const core = four((c) => (known(c.coreC) ? Math.round(c.coreC!) : known(c.tempC) && c.tempC > 0 ? Math.round(c.tempC) : undefined));
  if (core) out.tyreCoreC = core;
  const opt = four((c) => (known(c.optimalTempC) && c.optimalTempC! > 0 ? Math.round(c.optimalTempC!) : undefined));
  if (opt) out.tyreOptimalC = opt.every((x) => x === opt[0]) ? opt[0]! : opt;
  const kpa = four((c) => (known(c.pressureKpa) && c.pressureKpa! > 0 ? Math.round(c.pressureKpa!) : undefined));
  if (kpa) out.tyrePressureKpa = kpa;
  const tread = four((c) => (known(c.wear) && c.wear >= 0 && c.wear <= 1 ? Math.round(c.wear * 100) : undefined));
  if (tread) out.tyreTreadPct = tread;
  const compounds = corners.map((c) => c?.compound).filter((x): x is string => !!x);
  if (compounds.length === 4 && compounds.every((x) => x === compounds[0])) out.tyreCompound = compounds[0];
  return out;
}

function tyreBand(frame: TelemetryFrame): string | undefined {
  const t = frame.player?.tyres;
  if (!t) return undefined;
  const corners = [t.frontLeft, t.frontRight, t.rearLeft, t.rearRight];
  const core = corners.map((c) =>
    known(c?.coreC) ? c.coreC : known(c?.tempC) ? c.tempC : undefined,
  );
  if (core.every((c) => c === undefined)) return undefined;
  const optimal = corners.map((c) => (known(c?.optimalTempC) ? c.optimalTempC : undefined));
  const axle = (i: number, j: number): number | undefined => {
    const ds = [i, j]
      .filter((k) => core[k] !== undefined && optimal[k] !== undefined)
      .map((k) => core[k]! - optimal[k]!);
    return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : undefined;
  };
  const word = (d: number): string =>
    Math.abs(d) <= TYRE_WINDOW_C ? 'in the window' : d > 0 ? 'over' : 'under';
  const front = axle(0, 1);
  const rear = axle(2, 3);
  if (front !== undefined && rear !== undefined) {
    if (Math.abs(front) <= TYRE_WINDOW_C && Math.abs(rear) <= TYRE_WINDOW_C) return 'in the window';
    return `fronts ${word(front)}, rears ${word(rear)}`;
  }
  return 'temps available';
}

const PROMPT_DAMAGE_WORD: Readonly<Record<DamageGrade, string>> = {
  none: 'none',
  minor: 'light',
  major: 'medium',
  critical: 'heavy',
};

/**
 * Below this worst-component severity the summary says `none`, as it always
 * has. It is the prompt's contract (`light` has meant 0.04+ since the band was
 * written), and a 0.5–4% scuff that the HUD's 0.005 noise floor calls minor is
 * not worth the engineer's words. The summary only: the widget and the race
 * log keep the HUD's scale.
 */
const PROMPT_DAMAGE_FLOOR = 0.04;

function damageBand(frame: TelemetryFrame): { band: string; repairSec?: number } | undefined {
  const d = frame.player?.damage;
  if (!d) return undefined;
  const worst = known(d.worst) ? d.worst : 0;
  // The HUD's scale (damage.ts), spelt in the words the deployed engineer
  // prompt already documents (`none | light | medium | heavy`), so the cloud
  // function needs no redeploy: minor → light, major → medium, critical → heavy.
  // A lost part is at least major whatever the numbers say, so it skips the floor.
  const partsOff = known(d.partsDetached) && d.partsDetached > 0;
  const grade =
    partsOff || (d.hasDamage && worst >= PROMPT_DAMAGE_FLOOR)
      ? overallGrade({ worst, partsDetached: d.partsDetached })
      : 'none';
  const band = PROMPT_DAMAGE_WORD[grade];
  const repairSec = known(d.repairSeconds) && d.repairSeconds > 0 ? Math.round(d.repairSeconds) : undefined;
  return { band, repairSec };
}

function fuelToFlag(frame: TelemetryFrame): EngineerSummary['fuelToFlag'] {
  const f = frame.fuel;
  if (!f || !known(f.lapsRemaining)) return 'unknown';
  const tank = f.lapsRemaining;
  const energy = known(f.virtualEnergyLapsRemaining) ? f.virtualEnergyLapsRemaining : tank;
  const binding = Math.min(tank, energy);
  if (f.pitThisLap) return 'critical';
  if (known(f.lapsToFinish) && f.lapsToFinish > 0) {
    const short = f.lapsToFinish - binding;
    if (short <= 0) return 'good';
    if (short < 2) return 'short';
    return 'short';
  }
  return 'unknown';
}

function rainWord(frame: TelemetryFrame): string | undefined {
  const w = frame.weather;
  if (!w) return undefined;
  const now = known(w.rainIntensity) ? w.rainIntensity : 0;
  if (now >= 0.4) return 'raining';
  if (now >= 0.08) return 'spitting';
  const later = (w.forecast || []).some((s) => known(s.rainIntensity) && s.rainIntensity >= 0.2);
  if (later) return 'rain later';
  return 'dry';
}

/**
 * Build the payload the proxy is allowed to see. Returns null when there is
 * no frame yet — the app should not call the cloud with an empty race.
 * `avgOf` (optional) is the Tier-1 lap-history read — see {@link LapAverageOf}.
 */
export function engineerSummary(
  frame: TelemetryFrame | null | undefined,
  avgOf?: LapAverageOf,
  extras?: EngineerExtras | null,
): EngineerSummary | null {
  if (!frame || !frame.session) return null;
  const s = frame.session;
  const me = (frame.standings || []).find((e) => e.isPlayer);
  const fuel = frame.fuel;
  const dmg = damageBand(frame);
  const yellows = Array.isArray(s.sectorFlags)
    ? s.sectorFlags
        .map((f, i) => (f && f !== 'green' && f !== 'none' ? `S${i + 1}` : ''))
        .filter(Boolean)
        .join(' ')
    : '';
  const tl = frame.player?.trackLimits;
  const out: EngineerSummary = {
    track: s.track || '',
    session: String(s.type || ''),
    phase: String(s.phase || ''),
    flag: String(s.flag || ''),
    connected: !!frame.connected,
  };
  if (me?.carClass) out.class = me.carClass;
  if (me && known(me.position)) out.position = me.position;
  if (me && known(me.classPosition)) out.classPosition = me.classPosition;
  // The DRIVER'S lap, not the race's. `s.currentLap` is the overall leader's,
  // which in a multiclass field is a Hypercar's — an engineer told "currentLap
  // 12" while its driver is on lap 10 will talk about a race the driver is not
  // in. Falls back to the leader's only when there is no player row at all.
  const ownLap = me && known(me.lapsCompleted) && me.lapsCompleted >= 0 ? me.lapsCompleted + 1 : UNKNOWN_VALUE;
  if (known(ownLap) && ownLap > 0) out.currentLap = ownLap;
  else if (known(s.currentLap) && s.currentLap > 0) out.currentLap = s.currentLap;
  if (fuel && known(fuel.lapsToFinish) && fuel.lapsToFinish > 0) out.lapsToFinish = round1(fuel.lapsToFinish);
  else if (known(s.lapsRemaining) && s.lapsRemaining > 0) out.lapsToFinish = round1(s.lapsRemaining);
  if (known(s.timeRemainingSec) && s.timeRemainingSec > 0) {
    out.timeRemainingMin = round1(s.timeRemainingSec / 60);
  }
  if (me && known(me.lastLapSec) && me.lastLapSec > 0) out.lastLapSec = round1(me.lastLapSec);
  if (me && known(me.bestLapSec) && me.bestLapSec > 0) out.bestLapSec = round1(me.bestLapSec);
  const pace = frame.player?.paceScore;
  if (pace && known(pace.refSec) && pace.refSec > 0) {
    const targets = referencePaceTargets(pace);
    out.paceAlienRaceSec = round1(pace.refSec);
    if (known(pace.hotlapSec) && pace.hotlapSec > 0) out.paceAlienHotlapSec = round1(pace.hotlapSec);
    if (known(pace.lapSec) && pace.lapSec > 0) out.paceBestLapSec = round1(pace.lapSec);
    if (known(pace.percent)) out.pacePercent = round1(pace.percent);
    if (pace.bandLabel) out.paceBand = pace.bandLabel;
    if (targets.competitive) out.paceCompetitiveSec = targets.competitive.lapSec;
    if (targets.midpack) out.paceMidpackSec = targets.midpack.lapSec;
    const alienDelta = deltaToReferencePaceTarget(pace, targets.alien);
    const competitiveDelta = deltaToReferencePaceTarget(pace, targets.competitive);
    const midpackDelta = deltaToReferencePaceTarget(pace, targets.midpack);
    if (alienDelta !== null) out.paceDeltaToAlienSec = alienDelta;
    if (competitiveDelta !== null) out.paceDeltaToCompetitiveSec = competitiveDelta;
    if (midpackDelta !== null) out.paceDeltaToMidpackSec = midpackDelta;
    if (pace.layoutName) out.paceLayout = pace.layoutName;
    if (pace.sheetClass) out.paceClass = pace.sheetClass;
    if (pace.assumed) out.paceReferenceAssumed = true;
    if (pace.credit?.author) out.paceReferenceSource = pace.credit.author;
  }
  const ahead = classNeighbour(frame, -1, avgOf);
  const behind = classNeighbour(frame, 1, avgOf);
  if (ahead) out.ahead = ahead;
  if (behind) out.behind = behind;
  const myAvg = me && avgOf ? avgOf(me.slotId) : null;
  if (myAvg && myAvg.count > 0) {
    out.myAvgLapSec = round1(myAvg.avg);
    out.myAvgLaps = myAvg.count;
  }
  if (me && known(me.pitStops)) out.myPitStops = me.pitStops;
  const pits = classAheadPits(frame);
  if (pits) {
    out.classAheadInPitNow = pits.inPitNow;
    if (pits.anyTracked) out.classAheadNoStopYet = pits.noStopYet;
  }
  if (fuel && known(fuel.veCarsAheadPittingFirst)) {
    out.carsAheadPittingFirst = fuel.veCarsAheadPittingFirst;
    if (known(fuel.veCarsAheadCompared)) out.carsAheadCompared = fuel.veCarsAheadCompared;
  }
  if (fuel && known(fuel.lapsRemaining)) out.fuelLaps = round1(fuel.lapsRemaining);
  if (fuel && known(fuel.virtualEnergyLapsRemaining)) out.energyLaps = round1(fuel.virtualEnergyLapsRemaining);
  if (fuel && known(fuel.levelLiters) && fuel.levelLiters >= 0) out.fuelL = round1(fuel.levelLiters);
  if (fuel && known(fuel.capacityLiters) && fuel.capacityLiters > 0) out.tankL = round1(fuel.capacityLiters);
  if (fuel && known(fuel.fuelToFinishLiters) && fuel.fuelToFinishLiters >= 0) {
    out.fuelToFinishL = round1(fuel.fuelToFinishLiters);
  }
  // Only when a real to-the-flag projection exists: the calculator's refuel
  // field defaults to 0, and "add nothing" with no projection behind it is a
  // wrong answer, not a safe one.
  if (
    fuel &&
    known(fuel.refuelToFinishLiters) && fuel.refuelToFinishLiters >= 0 &&
    known(fuel.fuelToFinishLiters) && fuel.fuelToFinishLiters >= 0
  ) {
    out.refuelToFinishL = round1(fuel.refuelToFinishLiters);
  }
  if (fuel && known(fuel.fuelDeltaLiters)) out.fuelDeltaL = round1(fuel.fuelDeltaLiters);
  if (fuel && known(fuel.virtualEnergyPct)) out.energyPct = Math.round(fuel.virtualEnergyPct);
  if (fuel && known(fuel.virtualEnergyDeltaPct)) out.energyDeltaPct = round1(fuel.virtualEnergyDeltaPct);
  if (
    fuel &&
    known(fuel.perLapAvgLiters) && fuel.perLapAvgLiters > 0 &&
    known(fuel.virtualEnergyPerLapPct) && fuel.virtualEnergyPerLapPct > 0
  ) {
    out.fuelPerEnergyRatio = Math.round((fuel.perLapAvgLiters / fuel.virtualEnergyPerLapPct) * 100) / 100;
  }
  if (fuel && known(fuel.perLapAvgLiters) && fuel.perLapAvgLiters > 0) {
    out.fuelPerLapL = round1(fuel.perLapAvgLiters);
  }
  if (fuel && known(fuel.virtualEnergyPerLapPct) && fuel.virtualEnergyPerLapPct > 0) {
    out.energyPerLapPct = round1(fuel.virtualEnergyPerLapPct);
  }
  out.fuelToFlag = fuelToFlag(frame);
  if (fuel?.pitThisLap) out.pitThisLap = true;
  const tyres = tyreBand(frame);
  if (tyres) out.tyres = tyres;
  if (dmg) {
    out.damage = dmg.band;
    if (dmg.repairSec !== undefined) out.repairSec = dmg.repairSec;
  }
  if (frame.weather?.trackCondition) out.weather = frame.weather.trackCondition;
  const rain = rainWord(frame);
  if (rain) out.rain = rain;
  if (known(frame.weather?.trackTempC)) out.trackTempC = Math.round(frame.weather!.trackTempC);
  if (known(frame.weather?.ambientTempC)) out.airTempC = Math.round(frame.weather!.ambientTempC);
  const total = (frame.standings || []).length;
  if (total > 0) {
    out.carsTotal = total;
    if (me?.carClass) {
      out.carsInClass = frame.standings.filter((e) => e.carClass === me.carClass).length;
    }
  }
  if (yellows) out.yellows = yellows;
  if (tl && known(tl.points) && tl.points > 0) {
    out.trackLimits = `${tl.points} points`;
  }
  const hy = frame.player?.hybrid;
  if (hy && known(hy.chargeFraction)) out.hybridPct = Math.round(hy.chargeFraction * 100);
  Object.assign(out, tyreNumbers(frame));
  if (me) {
    const sheet = classStandings(frame, me, avgOf);
    if (sheet) {
      out.classStandings = sheet.rows;
      if (sheet.partial) out.classStandingsPartial = true;
      const retired = sheet.ordered.filter((e) => e.retired).length;
      if (retired > 0) out.classRetired = retired;
      const mySplits = splits(me);
      if (mySplits) out.lastSectorsSec = mySplits;
      const leader = sheet.ordered[0]!;
      if (leader.slotId !== me.slotId) {
        const lb: EngineerLeader = { name: radioName(leader) };
        const mine = sheet.rows.find((r) => r.me);
        if (mine?.lapsDown !== undefined) lb.lapsDown = mine.lapsDown;
        else if (mine?.gap !== undefined) lb.gapSec = mine.gap;
        if (known(leader.lastLapSec) && leader.lastLapSec > 0) lb.lastLapSec = round1(leader.lastLapSec);
        if (known(leader.bestLapSec) && leader.bestLapSec > 0) lb.bestLapSec = round1(leader.bestLapSec);
        const lavg = avgOf ? avgOf(leader.slotId) : null;
        if (lavg && lavg.count > 0) {
          lb.avgLapSec = round1(lavg.avg);
          lb.avgLaps = lavg.count;
        }
        const ls = splits(leader);
        if (ls) {
          lb.sectorsSec = ls;
          if (mySplits) {
            out.lastSectorsVsLeaderSec = [
              round2(mySplits[0] - ls[0]),
              round2(mySplits[1] - ls[1]),
              round2(mySplits[2] - ls[2]),
            ];
          }
        }
        if (known(leader.pitStops)) lb.pitStops = leader.pitStops;
        if (leader.inPit && !leader.retired) lb.inPit = true;
        out.classLeader = lb;
      }
      const all = sheet.ordered.map(splits).filter((x): x is [number, number, number] => !!x);
      if (all.length >= 2) {
        out.classBestLastSectorsSec = [
          Math.min(...all.map((x) => x[0])),
          Math.min(...all.map((x) => x[1])),
          Math.min(...all.map((x) => x[2])),
        ];
      }
    }
  }
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined && v !== null) {
        (out as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}
