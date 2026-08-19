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

const TYRE_WINDOW_C = 8;

export interface EngineerCar {
  name: string;
  gapSec: number;
  class?: string;
}

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
  ahead?: EngineerCar;
  behind?: EngineerCar;
  fuelLaps?: number;
  energyLaps?: number;
  fuelToFlag?: 'good' | 'short' | 'critical' | 'unknown';
  pitThisLap?: boolean;
  tyres?: string;
  damage?: string;
  repairSec?: number;
  weather?: string;
  rain?: string;
  yellows?: string;
  trackLimits?: string;
  hybridPct?: number;
}

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

function classNeighbour(frame: TelemetryFrame, dir: -1 | 1): EngineerCar | undefined {
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
  if (gapSec === undefined) return { name: radioName(other), gapSec: 0, class: other.carClass };
  return { name: radioName(other), gapSec: round1(gapSec), class: other.carClass };
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
 */
export function engineerSummary(frame: TelemetryFrame | null | undefined): EngineerSummary | null {
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
  if (known(s.currentLap) && s.currentLap > 0) out.currentLap = s.currentLap;
  if (fuel && known(fuel.lapsToFinish) && fuel.lapsToFinish > 0) out.lapsToFinish = round1(fuel.lapsToFinish);
  else if (known(s.lapsRemaining) && s.lapsRemaining > 0) out.lapsToFinish = round1(s.lapsRemaining);
  if (known(s.timeRemainingSec) && s.timeRemainingSec > 0) {
    out.timeRemainingMin = round1(s.timeRemainingSec / 60);
  }
  if (me && known(me.lastLapSec) && me.lastLapSec > 0) out.lastLapSec = round1(me.lastLapSec);
  if (me && known(me.bestLapSec) && me.bestLapSec > 0) out.bestLapSec = round1(me.bestLapSec);
  const ahead = classNeighbour(frame, -1);
  const behind = classNeighbour(frame, 1);
  if (ahead) out.ahead = ahead;
  if (behind) out.behind = behind;
  if (fuel && known(fuel.lapsRemaining)) out.fuelLaps = round1(fuel.lapsRemaining);
  if (fuel && known(fuel.virtualEnergyLapsRemaining)) out.energyLaps = round1(fuel.virtualEnergyLapsRemaining);
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
  if (yellows) out.yellows = yellows;
  if (tl && known(tl.points) && tl.points > 0) {
    out.trackLimits = `${tl.points} points`;
  }
  const hy = frame.player?.hybrid;
  if (hy && known(hy.chargeFraction)) out.hybridPct = Math.round(hy.chargeFraction * 100);
  return out;
}
