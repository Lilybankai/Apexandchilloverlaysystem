/**
 * @file src/telemetry/engineerSummary.ts
 * @module telemetry/engineerSummary
 *
 * **What leaves the PC for a Tier-2 question.** A bucketed, few-hundred-token
 * snapshot of the race — never the raw frame, never the microphone. The Edge
 * Function's prompt is forbidden to invent numbers that are not in this object,
 * so every figure here is a figure the radio is allowed to speak.
 *
 * Tyres and damage go out as bands (privacy + radio English). Fuel, energy,
 * gaps and lap times go out rounded, because those are the numbers a free-form
 * strategy question actually needs.
 */

import { UNKNOWN_VALUE } from './types';
import type { StandingEntry, TelemetryFrame } from './types';
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
}

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

function damageBand(frame: TelemetryFrame): { band: string; repairSec?: number } | undefined {
  const d = frame.player?.damage;
  if (!d) return undefined;
  const worst = known(d.worst) ? d.worst : 0;
  const band = !d.hasDamage || worst < 0.04 ? 'none' : worst < 0.25 ? 'light' : worst < 0.5 ? 'medium' : 'heavy';
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
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined && v !== null) {
        (out as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}
