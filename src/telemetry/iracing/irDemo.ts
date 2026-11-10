/**
 * The demo feed, dressed as an iRacing session.
 *
 * The simulator (`simulatorProvider.ts`) produces an LMU-shaped field —
 * Hypercar/LMP2/LMP3/GT3, Virtual Energy, LMU brand and rank badges, track
 * limit POINTS. In iRacing mode that is the wrong product to demo: the owner
 * asked (2026-11-10) for "the demo overlays for iRacing [to] show the iRacing
 * overlays and not the LMU ones". So this takes the simulator's frame and
 * re-labels it into what the iRacing provider publishes:
 *
 *  - `source: 'iracing'` (still `connected: false`, so the DEMO badge stays) —
 *    the widgets switch to their iRacing wording on that field alone;
 *  - iRacing class names (GTP / LMP2 / LMP3 / GT3), every car with an iRating
 *    and a licence, and in races the projected iRating change per class from
 *    the same community formula the live provider uses (none for Rookies —
 *    iRacing does not rate them);
 *  - incidents in the Track Limits block (1x off track, 2x loss of control,
 *    4x contact against a 17x limit) instead of LMU's quarter-point charges;
 *  - the iRacing-only player blocks the Damage / iRacing Pit / Race Control
 *    widgets read (repair, pitService, flags), and the tyre "pit reading" age;
 *  - LMU-only extras removed: Virtual Energy, brand / driver / rank badges, the
 *    LMU MFD block.
 *
 * Pure: a function of the simulator's frame and its session clock, so the same
 * demo second always looks the same. Every rating and licence is derived from
 * the car's slot, never from a real person.
 */

import {
  UNKNOWN_VALUE,
  type DriverFlagState,
  type PitServiceItem,
  type PitServiceState,
  type RepairState,
  type StandingEntry,
  type TelemetryFrame,
  type TrackLimitsState,
} from '../types';
import { iRatingDeltasByClass, type IRatingEntry } from './irating';

/** LMU class labels → what iRacing calls the nearest class. */
const CLASS_MAP: Record<string, string> = {
  HYPERCAR: 'GTP',
  LMH: 'GTP',
  LMDH: 'GTP',
  LMP2: 'LMP2',
  LMP3: 'LMP3',
  GT3: 'GT3',
  LMGT3: 'GT3',
  GTE: 'GT3',
};

/** Rating bands per class: faster classes carry higher-rated drivers. */
const IR_BAND: Record<string, [number, number]> = {
  GTP: [2600, 5200],
  LMP2: [1900, 3600],
  LMP3: [1400, 2700],
  GT3: [900, 2400],
};

/** Licence ladder, best first; Rookies appear in the slowest class only. */
const LICENCES = ['A', 'B', 'C', 'D', 'R'] as const;

/** The incident a demo session "has", on a fixed 10-minute loop. */
const INCIDENT_SCRIPT: ReadonlyArray<{ atSec: number; x: number }> = [
  { atSec: 95, x: 1 },
  { atSec: 240, x: 2 },
  { atSec: 410, x: 4 },
  { atSec: 530, x: 1 },
];
const INCIDENT_LOOP_SEC = 600;
const INCIDENT_LIMIT = 17;

/** A stable 0..1 pseudo-random from a slot id (no Math.random: a demo is repeatable). */
function unit(slot: number, salt: number): number {
  const x = Math.sin((slot + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function irClass(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  return CLASS_MAP[raw.toUpperCase()] ?? raw;
}

function ratingFor(slot: number, cls: string | undefined): number {
  const [lo, hi] = IR_BAND[cls ?? ''] ?? [1200, 3000];
  return Math.round(lo + unit(slot, 1) * (hi - lo));
}

function licenceFor(slot: number, cls: string | undefined): { text: string } {
  // GTP: A/B; prototypes: B/C/D; GT3: C/D/R — the shape of a real split.
  const pool =
    cls === 'GTP' ? LICENCES.slice(0, 2) : cls === 'GT3' ? LICENCES.slice(2) : LICENCES.slice(1, 4);
  const letter = pool[Math.floor(unit(slot, 2) * pool.length)] ?? 'D';
  const sr = (1.2 + unit(slot, 3) * 3.6).toFixed(2);
  return { text: `${letter} ${sr}` };
}

/** Strip the LMU-only extras from a standings or relative row, in place. */
function stripLmu(row: Record<string, unknown>): void {
  delete row.virtualEnergy;
  delete row.manufacturer;
  delete row.driverBadge;
  delete row.driverRank;
  delete row.safetyRank;
}

/** The scripted incidents up to `elapsed` seconds, newest first. */
function incidentsAt(elapsed: number): { count: number; charges: number[]; lastAt: number } {
  const loops = Math.floor(elapsed / INCIDENT_LOOP_SEC);
  const inLoop = elapsed - loops * INCIDENT_LOOP_SEC;
  const charges: number[] = [];
  let lastAt = -1;
  // Only the current loop's incidents count: each loop is a fresh "session",
  // so the demo never marches into a DQ and sits there.
  for (const e of INCIDENT_SCRIPT) {
    if (e.atSec <= inLoop) {
      charges.unshift(e.x);
      lastAt = loops * INCIDENT_LOOP_SEC + e.atSec;
    }
  }
  return { count: charges.reduce((a, b) => a + b, 0), charges, lastAt };
}

/**
 * Turn one simulator frame into an iRacing-shaped demo frame. Mutates and
 * returns the frame it is given (the simulator builds a fresh one per poll).
 */
export function toIracingDemo(frame: TelemetryFrame, clockSec?: number): TelemetryFrame {
  const f = frame as TelemetryFrame & Record<string, unknown>;
  f.source = 'iracing';
  // The simulator publishes no session clock, so the caller passes its own
  // (seconds since the demo started); a frame that has one uses it.
  const rawElapsed = typeof clockSec === 'number' ? clockSec : frame.session.elapsedSec;
  const elapsed: number = typeof rawElapsed === 'number' && Number.isFinite(rawElapsed) && rawElapsed > 0 ? rawElapsed : 0;

  /* --- the field ----------------------------------------------------------- */
  const classIds = new Map<string, number>();
  for (const s of frame.standings) {
    s.carClass = irClass(s.carClass);
    stripLmu(s as unknown as Record<string, unknown>);
    s.iRating = ratingFor(s.slotId, s.carClass);
    s.license = licenceFor(s.slotId, s.carClass);
    if (s.carClass && !classIds.has(s.carClass)) classIds.set(s.carClass, classIds.size + 1);
  }
  if (frame.session.type === 'race') {
    const entries: IRatingEntry[] = frame.standings.map((s) => ({
      key: s.slotId,
      classId: classIds.get(s.carClass ?? '') ?? 0,
      ir: s.iRating ?? 0,
      rank: s.classPosition ?? s.position,
      started: true,
    }));
    const deltas = iRatingDeltasByClass(entries);
    for (const s of frame.standings) {
      const d = deltas.get(s.slotId);
      // iRacing does not rate a Rookie's own iRating (see iracingProvider.ts).
      if (d !== undefined && !/^R\b/.test(s.license?.text ?? '')) s.iRatingDelta = d;
    }
  }
  const bySlot = new Map<number, StandingEntry>(frame.standings.map((s) => [s.slotId, s]));
  for (const r of frame.relative) {
    r.carClass = irClass(r.carClass);
    stripLmu(r as unknown as Record<string, unknown>);
    const s = bySlot.get(r.slotId);
    if (s) {
      if (s.iRating !== undefined) r.iRating = s.iRating;
      if (s.license) r.license = s.license;
      if (s.iRatingDelta !== undefined) r.iRatingDelta = s.iRatingDelta;
    }
  }
  if (frame.radar) for (const b of frame.radar) b.carClass = irClass(b.carClass);

  /* --- fuel: no Virtual Energy on iRacing ---------------------------------- */
  const fuel = frame.fuel as unknown as Record<string, unknown>;
  for (const k of Object.keys(fuel)) if (/^(virtualEnergy|ve)/.test(k)) delete fuel[k];

  /* --- the player's iRacing blocks ----------------------------------------- */
  const p = frame.player;
  delete (f as Record<string, unknown>).mfd;
  delete (p as unknown as Record<string, unknown>).mfd;
  // LMU's per-component damage (aero, suspension) has no iRacing source; the
  // live provider never sets it, and the Damage widget draws iRacing's repair
  // block instead (below).
  delete (p as unknown as Record<string, unknown>).damage;
  delete (p as unknown as Record<string, unknown>).chassis;
  delete (p as unknown as Record<string, unknown>).hybrid;

  const inc = incidentsAt(elapsed);
  const trackLimits: TrackLimitsState = {
    points: inc.count,
    pointsLimit: INCIDENT_LIMIT,
    pointsLimitEnforced: true,
    charges: inc.charges,
    charged: inc.charges.length,
    msSinceCharge: inc.lastAt >= 0 ? Math.round((elapsed - inc.lastAt) * 1000) : UNKNOWN_VALUE,
    penalties: 0,
    msSincePenalty: UNKNOWN_VALUE,
    msSinceServed: UNKNOWN_VALUE,
    // The lap with the latest incident reads NOT CLEAN for the next ~90 s.
    lapValid: !(inc.lastAt >= 0 && elapsed - inc.lastAt < 90),
  };
  p.trackLimits = trackLimits;

  // A contact (the 4x) leaves an optional repair for a minute and a half.
  const sinceContact = inc.charges[0] === 4 && inc.lastAt >= 0 ? elapsed - inc.lastAt : Infinity;
  const repair: RepairState = {
    required: sinceContact < 90 ? 'optional' : 'none',
    meatball: false,
    repairSec: 0,
    optionalRepairSec: sinceContact < 90 ? 18 : 0,
    fastRepairsLeft: 1,
    fastRepairsUsed: 0,
    fastRepairQueued: false,
    towSec: 0,
    ...(sinceContact < 600 ? { lastImpactG: 6.4, msSinceImpact: Math.round(sinceContact * 1000) } : {}),
  };
  p.repair = repair;

  const inPit = !!(p.pit && p.pit.phase === 'stopped');
  const item = (id: PitServiceItem['id'], label: string, on: boolean): PitServiceItem => ({
    id,
    label,
    state: on ? (inPit ? 'done' : 'requested') : 'off',
  });
  const pitService: PitServiceState = {
    items: [
      item('lf', 'LF', true),
      item('rf', 'RF', true),
      item('lr', 'LR', true),
      item('rr', 'RR', true),
      item('fuel', 'FUEL', true),
      item('tearoff', 'TEAR-OFF', true),
      item('fastRepair', 'FR', false),
    ],
    fuelAddL: Math.max(0, Math.round(frame.fuel.refuelToFinishLiters > 0 ? frame.fuel.refuelToFinishLiters : 0)),
    autoFuel: true,
    pressuresKpa: [165, 165, 160, 160],
    status: inPit ? 'inProgress' : 'none',
    active: inPit,
    elapsedSec: 0,
    lastStopSec: 38.6,
    commandsEnabled: false,
  };
  p.pitService = pitService;

  const flag = frame.session.flag;
  const flags: DriverFlagState = {
    checkered: flag === 'checkered',
    white: !!frame.session.finalLap && flag !== 'checkered',
    green: flag === 'green',
    localYellow: flag === 'yellow',
    caution: false,
    blue: flag === 'blue',
    debris: false,
    black: false,
    furled: false,
    meatball: false,
    disqualified: false,
  };
  p.flags = flags;

  // iRacing refreshes tyre temps/wear only in the pit stall: label them so.
  if (p.tyres && p.tyres.frontLeft && p.tyres.frontLeft.tempC !== UNKNOWN_VALUE) {
    p.tyres.readingAgeSec = Math.round(elapsed % 900);
  }
  return frame;
}
