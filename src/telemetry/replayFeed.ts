/**
 * telemetry/replayFeed.ts — the live data of an LMU replay (THE-35 follow-up).
 * -----------------------------------------------------------------------------
 * In a replay, every `/rest/watch/*` endpoint and the rF2 shared-memory Scoring
 * buffer are FROZEN at the start of the loaded session: event time 0, lap 0,
 * grid order, zero speed, identical samples seconds apart — and REST even names
 * different drivers than the recording (probed live 2026-10-12, Road Atlanta,
 * 39 cars). The overlays followed the camera but had nothing moving to show.
 *
 * The replay's live data exists — it is what LMU's own broadcast overlays draw
 * (`<LMU>/Bin/UI.zip` → `overlays/src/overlays.js`) — and it comes over two
 * websockets on the REST port + 1:
 *
 *   - `ws://127.0.0.1:6398/websocket/ui`, after `{"messageType":"SUB","topic":
 *     "LiveStandings"}`: `{topic:'LiveStandings', body:[row per car]}` at ~7 Hz.
 *   - `ws://127.0.0.1:6398/websocket/replaymetrics`, no subscribe: `{type:
 *     'replayMetrics', body}` at ~14 Hz for the CAMERA car — pedals, gear, rpm,
 *     speed in `speedUnit`, G, its lap timing, and the replay clock.
 *
 * What in those feeds is honest was settled against the 30 s capture
 * (`scripts/fixtures/replay-ws-road-atlanta.json`), not assumed:
 *
 *   - LIVE: position, laps completed, `lapDist`, `posX/Y/Z` (the same world
 *     axes the track map's learned paths use — dots fall within metres of the
 *     bundled Road Atlanta line), `localVel*` (|v| × 2.2369 matched the
 *     replaymetrics mph to ±1), best lap and its sectors, `inPits`/`inGarage`,
 *     `slotHasFocus`, driver/number/class/team; every replaymetrics channel.
 *   - `lapDist` is NEGATIVE over the last part of the lap (distance to the
 *     line): −807 at Road Atlanta is 3276 m round a 4083 m lap. Normalised here.
 *   - NOT USABLE: `timeBehindLeader` / `timeBehindNext` (they flip sign and
 *     jump by a lap time as cars cross the line — a road-time figure, not a
 *     race gap), `lapsBehindLeader` (0 for everyone), `lastLapTime` (−1 for
 *     everyone, all race), `timeIntoLap` (negative before the line),
 *     `currentSector` (1 for every car, in every sector), `pitState`,
 *     `numPitstops`, `virtualEnergy` (constant 100) — and REST `fuelFraction`,
 *     tyres, damage, which describe the loaded session, not the recording.
 *
 * So gaps and last laps are TIMED here, the way a real timing system does it:
 * {@link ReplayTiming} remembers, per car, the replay event time at which it
 * passed each point of its race distance (about the last lap and a quarter),
 * and the gap from A to B is "how long ago was A where B is now". It is exact
 * by construction at any point on the lap and needs nothing from the sim but
 * the positions and the replay clock. The cost is honesty about the first lap:
 * a gap reads unknown until the car ahead has been watched passing the spot.
 *
 * Everything here is pure except {@link ReplayFeed}, which owns the two
 * sockets. The provider opens them ONLY while `/navigation/state` says a replay
 * is playing; live driving never constructs a socket.
 */

import { WebSocket } from 'ws';
import type { LocalCarPhysics } from './lmuLocalCar';
import { UNKNOWN_VALUE, type SessionPhase } from './types';
import { liveStandingsPenalties, type PenaltyKind } from './penalties';

/* ------------------------------- raw shapes ------------------------------- */

/** One row of a `LiveStandings` push (only the fields this module reads). */
export interface LiveStandingRow {
  slotID: number;
  slotHasFocus?: boolean;
  driverName?: string;
  position?: number;
  qualiPosition?: number;
  currentLapsCompleted?: number;
  /** Metres from the line; NEGATIVE before it — see {@link normaliseLapDist}. */
  lapDist?: number;
  posX?: number;
  posY?: number;
  posZ?: number;
  localVelX?: number;
  localVelY?: number;
  localVelZ?: number;
  bestLapTime?: number;
  bestLapTimeS1?: number;
  bestLapTimeS2?: number;
  inPits?: boolean;
  inGarage?: boolean;
  pitState?: number;
  finishStatus?: string;
  virtualEnergy?: number;
  vehicleClass?: string;
  vehicleNumber?: string | number;
  vehFilename?: string;
  teamName?: string;
  /**
   * Outstanding penalties by kind — `{ DT, SG, TIME }`, on every row of the
   * 2026-10-12 capture (all zero). LMU's own timing screen shows "DT"/"SG" off
   * the first two; see telemetry/penalties.ts.
   */
  penalties?: { DT?: number; SG?: number; TIME?: number };
}

/** The `body` of a `replayMetrics` push — the replay CAMERA car. */
export interface ReplayMetrics {
  throttle?: number;
  brakes?: number;
  clutch?: number;
  steering?: number;
  gear?: number;
  rpm?: number;
  maxRPM?: number;
  speed?: number;
  /** `'mph'` or `'kph'` — the unit `speed` is ALREADY in (LMU's own UI shows it as-is). */
  speedUnit?: string;
  lateralG?: number;
  longitudinalG?: number;
  /** The lap being driven (laps completed + 1). */
  lapNumber?: number;
  /** Seconds into the current lap; −1 for a moment at the line. */
  timeIntoLap?: number;
  sectorNum?: number;
  /** The last COMPLETED lap's time (matched the camera car's lapTimestamps step). */
  finalLapTime?: number;
  replayDriver?: string;
  replayDriverClass?: string;
  vehicleNumber?: number | string;
  manufacturer?: string;
  virtualEnergyRemaining?: number;
  /** Event time at the replay's first frame. */
  replayStartET?: number;
  /** Seconds into the replay; `replayStartET + currentReplayPos` = event time. */
  currentReplayPos?: number;
  /** Length of the recording, seconds. */
  replayLength?: number;
}

/* --------------------------------- helpers -------------------------------- */

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Metres per mile / 1000 — the one conversion LMU's own overlay does (×2.2369 from m/s). */
const KPH_PER_MPH = 1.609344;

/**
 * Where on the lap a `lapDist` is, `0..len`. LMU publishes the stretch before
 * the line as a negative distance TO it, so −807 on a 4083 m lap is 3276 m.
 */
export function normaliseLapDist(d: number, len: number): number {
  if (!fin(d) || !(len > 0)) return 0;
  let x = d < 0 ? d + len : d;
  if (x >= len) x -= len;
  return clamp(x, 0, len);
}

/** Race distance in metres: laps completed plus the way round this one. */
export function raceDistance(laps: number, lapDist: number, len: number): number {
  return Math.max(0, laps | 0) * len + normaliseLapDist(lapDist, len);
}

/** The replay's event time, or NaN when the push does not carry it. */
export function replayEventTime(m: ReplayMetrics | null | undefined): number {
  if (!m || !fin(m.replayStartET) || !fin(m.currentReplayPos)) return Number.NaN;
  const et = m.replayStartET + m.currentReplayPos;
  return et > 0 ? et : Number.NaN;
}

/**
 * The camera car's speed in km/h, or {@link UNKNOWN_VALUE}. `speed` arrives in
 * whatever `speedUnit` names — `'mph'` in the capture — and LMU's own driver
 * box prints it as-is beside "km/h" only for `'kph'`. A unit this does not
 * recognise is not guessed at.
 */
export function metricsSpeedKph(m: ReplayMetrics | null | undefined): number {
  if (!m || !fin(m.speed)) return UNKNOWN_VALUE;
  const unit = String(m.speedUnit ?? '').trim().toLowerCase().replace(/[\s/]/g, '');
  const s = Math.abs(m.speed);
  if (unit === 'kph' || unit === 'kmh') return s;
  if (unit === 'mph') return s * KPH_PER_MPH;
  return UNKNOWN_VALUE;
}

/** A row's road speed in m/s from its local velocity vector, or undefined. */
export function rowSpeedMps(r: LiveStandingRow): number | undefined {
  if (!fin(r.localVelX) || !fin(r.localVelY) || !fin(r.localVelZ)) return undefined;
  return Math.hypot(r.localVelX, r.localVelY, r.localVelZ);
}

const upperTrim = (v: unknown): string => (v == null ? '' : String(v).trim().toUpperCase());

/**
 * Whether a replaymetrics push describes this car. The metrics name the car
 * by number and class (numbers repeat across classes), never by slot — so a
 * camera cut that one feed has seen and the other not yet is caught here
 * rather than showing one car's pedals under another's name.
 */
export function metricsMatchCar(
  m: ReplayMetrics | null | undefined,
  car: { carNumber?: string; carClass?: string } | undefined,
): boolean {
  if (!m || !car) return false;
  const num = upperTrim(m.vehicleNumber);
  if (num === '' || num !== upperTrim(car.carNumber)) return false;
  const a = upperTrim(m.replayDriverClass);
  const b = upperTrim(car.carClass);
  return a === '' || b === '' || a === b;
}

/** rF2's numeric pit state → the strings REST uses (only non-zero is a claim). */
const PIT_STATES: Record<number, string> = { 1: 'REQUEST', 2: 'ENTERING', 3: 'STOPPED', 4: 'EXITING' };

/* ------------------------------- timing loops ------------------------------ */

/** History kept per car, in laps — enough to time any car within a lap of another. */
const HISTORY_LAPS = 1.25;
/** Fastest believable progress, m/s, plus slack — a jump past it is a torn read. */
const MAX_SPEED_MPS = 120;
const JUMP_SLACK_M = 60;
/** Consecutive implausible samples before a car's history is started afresh. */
const RESYNC_AFTER = 5;
/** A bracket of samples wider than this (s of replay) is a hole, not a measurement. */
const MAX_BRACKET_SEC = 10;

interface CarHistory {
  /** Race distance, metres, strictly increasing. */
  d: number[];
  /** Replay event time at each `d`. */
  t: number[];
  /** Lap index (floor(d / len)) of the last line crossing seen, and its time. */
  crossLap: number;
  crossEt: number;
  lastLapSec: number;
  rejects: number;
}

/** One car as the timing loops see it. */
export interface TimingSample {
  slotId: number;
  laps: number;
  lapDist: number;
  inGarage?: boolean;
}

/**
 * Timing loops over the replay clock: when each car passed each point of its
 * race distance, for about the last lap and a quarter. Gaps and lap times are
 * read off it; see the module note for why the feed's own gap fields are not.
 *
 * Fed once per LiveStandings push with that push's event time. A paused replay
 * (event time not advancing) adds nothing; a seek must {@link reset} it.
 */
export class ReplayTiming {
  private readonly cars = new Map<number, CarHistory>();
  private len = 0;
  private lastEt = Number.NaN;

  public reset(): void {
    this.cars.clear();
    this.lastEt = Number.NaN;
  }

  public update(samples: readonly TimingSample[], et: number, len: number): void {
    if (!fin(et) || et <= 0 || !(len > 0)) return;
    if (len !== this.len) {
      this.reset();
      this.len = len;
    }
    if (fin(this.lastEt) && et <= this.lastEt) {
      // Paused, or the same instant twice. Backwards is a seek, which the
      // provider resets on — but never let one corrupt the history either way.
      if (et < this.lastEt - 1) this.reset();
      else return;
    }
    this.lastEt = et;
    const seen = new Set<number>();
    for (const s of samples) {
      seen.add(s.slotId);
      if (s.inGarage === true || !fin(s.laps) || !fin(s.lapDist)) continue;
      const rd = raceDistance(s.laps, s.lapDist, len);
      const h = this.cars.get(s.slotId);
      if (!h) {
        this.cars.set(s.slotId, fresh(rd, et));
        continue;
      }
      const n = h.d.length;
      const lastD = h.d[n - 1] as number;
      const lastT = h.t[n - 1] as number;
      const dt = et - lastT;
      const delta = rd - lastD;
      // The lap counter and the distance do not always tick in the same push at
      // the line, so one sample can read a lap long or short. Skip those; only a
      // run of them (the car really was moved — back to its box, a reset) starts
      // the history again.
      if (delta < -1 || delta > MAX_SPEED_MPS * Math.max(dt, 0) + JUMP_SLACK_M) {
        if (++h.rejects >= RESYNC_AFTER) this.cars.set(s.slotId, fresh(rd, et));
        continue;
      }
      h.rejects = 0;
      if (delta <= 0) continue;
      const lapA = Math.floor(lastD / len);
      const lapB = Math.floor(rd / len);
      if (lapB > lapA && dt <= MAX_BRACKET_SEC) {
        const tc = lastT + ((lapB * len - lastD) / delta) * dt;
        if (h.crossLap === lapB - 1 && h.crossEt > 0) h.lastLapSec = tc - h.crossEt;
        h.crossLap = lapB;
        h.crossEt = tc;
      }
      h.d.push(rd);
      h.t.push(et);
      // Forget what is more than HISTORY_LAPS behind, in one splice.
      const keepFrom = rd - HISTORY_LAPS * len;
      let cut = 0;
      while (cut < h.d.length - 2 && (h.d[cut] as number) < keepFrom) cut++;
      if (cut > 0) {
        h.d.splice(0, cut);
        h.t.splice(0, cut);
      }
    }
    for (const id of this.cars.keys()) if (!seen.has(id)) this.cars.delete(id);
  }

  /** The replay time at which `slotId` was at race distance `rd`, or null outside its history. */
  public timeAt(slotId: number, rd: number): number | null {
    const h = this.cars.get(slotId);
    if (!h || h.d.length < 2) return null;
    const d = h.d;
    const t = h.t;
    if (rd < (d[0] as number) || rd > (d[d.length - 1] as number)) return null;
    let lo = 0;
    let hi = d.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((d[mid] as number) <= rd) lo = mid;
      else hi = mid;
    }
    const d0 = d[lo] as number;
    const d1 = d[hi] as number;
    const t0 = t[lo] as number;
    const t1 = t[hi] as number;
    if (t1 - t0 > MAX_BRACKET_SEC) return null;
    return d1 > d0 ? t0 + ((rd - d0) / (d1 - d0)) * (t1 - t0) : t0;
  }

  /**
   * Seconds since `aheadSlot` was at race distance `rd` — the gap to it from a
   * car that is at `rd` now. Null when that point is outside its history.
   */
  public gapTo(aheadSlot: number, rd: number, et: number): number | null {
    const at = this.timeAt(aheadSlot, rd);
    return at === null ? null : Math.max(0, et - at);
  }

  /** The car's last lap timed across two observed line crossings, or {@link UNKNOWN_VALUE}. */
  public lastLap(slotId: number): number {
    const h = this.cars.get(slotId);
    return h && h.lastLapSec > 0 ? h.lastLapSec : UNKNOWN_VALUE;
  }
}

function fresh(rd: number, et: number): CarHistory {
  return { d: [rd], t: [et], crossLap: -1, crossEt: 0, lastLapSec: 0, rejects: 0 };
}

/* ---------------------------- standings mapping ---------------------------- */

/**
 * A LiveStandings row in the shape the provider's REST mapping already
 * consumes (`RestStanding`), so standings, relative, the lap-delta engine, the
 * finish latch and the map run on the replay unchanged. Fields the feed does
 * not honestly carry are left out, never zero-filled.
 */
export interface ReplayCar {
  slotID: number;
  position: number;
  carId?: string;
  qualification?: number;
  driverName: string;
  fullTeamName?: string;
  carNumber?: string;
  carClass?: string;
  bestLapTime: number;
  lastLapTime: number;
  timeBehindLeader: number;
  timeBehindNext: number;
  lapsBehindLeader: number;
  timeBehindClassLeader?: number;
  lapsBehindClassLeader?: number;
  lapsCompleted: number;
  lapDistance?: number;
  pitState?: string;
  pitting?: boolean;
  inGarageStall?: boolean;
  hasFocus?: boolean;
  carVelocity?: { velocity?: number };
  finishStatus?: string;
  veFraction?: number;
  /** Outstanding penalties (DT + SG) — see {@link liveStandingsPenalties}. */
  penalties?: number;
  /** Their kind, when the row's DT/SG split names a single one. */
  penaltyKind?: PenaltyKind;
}

/** What one LiveStandings push becomes. */
export interface ReplayField {
  cars: ReplayCar[];
  /** World position per slot — the same axes as the track map's paths. */
  positions: Map<number, { x: number; y: number; z: number }>;
  /** Race distance per slot, metres, for the relative's timed gaps. */
  raceDist: Map<number, number>;
}

/**
 * Map a LiveStandings push onto {@link ReplayCar} rows, with gaps and last
 * laps from `timing` (already fed this push) at event time `et`.
 *
 * @param carIdByFile - vehicle file → REST `carId`, for the manufacturer badge.
 *   REST's frozen rows still list the same machinery as the recording (joined
 *   on `vehFilename` live), even where they name other drivers.
 */
export function buildReplayField(
  rows: readonly LiveStandingRow[],
  timing: ReplayTiming,
  len: number,
  et: number,
  carIdByFile?: ReadonlyMap<string, string>,
): ReplayField {
  const positions = new Map<number, { x: number; y: number; z: number }>();
  const raceDist = new Map<number, number>();
  const valid = rows.filter((r) => r && fin(r.slotID));
  for (const r of valid) {
    raceDist.set(r.slotID, raceDistance(r.currentLapsCompleted ?? 0, r.lapDist ?? 0, len));
    if (fin(r.posX) && fin(r.posY) && fin(r.posZ)) {
      positions.set(r.slotID, { x: r.posX, y: r.posY, z: r.posZ });
    }
  }
  const pos = (r: LiveStandingRow): number => (fin(r.position) && r.position > 0 ? r.position : 999);
  const byPos = new Map<number, LiveStandingRow>();
  for (const r of valid) if (!byPos.has(pos(r))) byPos.set(pos(r), r);
  const leader = valid.reduce<LiveStandingRow | undefined>(
    (best, r) => (!best || pos(r) < pos(best) ? r : best),
    undefined,
  );
  const classLeader = new Map<string, LiveStandingRow>();
  for (const r of valid) {
    const k = upperTrim(r.vehicleClass);
    const cur = classLeader.get(k);
    if (!cur || pos(r) < pos(cur)) classLeader.set(k, r);
  }
  const timed = fin(et) && et > 0;

  /** Laps from `ahead` back to `r` (fractional), and the timed gap when under one. */
  const behind = (r: LiveStandingRow, ahead: LiveStandingRow | undefined) => {
    if (!ahead) return { laps: 0, exact: 0, gap: null as number | null };
    const exact = ((raceDist.get(ahead.slotID) ?? 0) - (raceDist.get(r.slotID) ?? 0)) / len;
    const gap =
      timed && r.inGarage !== true && exact >= 0 && exact < 1
        ? timing.gapTo(ahead.slotID, raceDist.get(r.slotID) ?? 0, et)
        : null;
    return { laps: Math.max(0, Math.floor(exact + 1e-6)), exact, gap };
  };

  const cars = valid.map((r): ReplayCar => {
    const isLeader = r === leader;
    const toLeader = behind(r, isLeader ? undefined : leader);
    const ahead = pos(r) > 1 ? byPos.get(pos(r) - 1) : undefined;
    const toNext = behind(r, ahead);
    const cl = classLeader.get(upperTrim(r.vehicleClass));
    const isClassLeader = cl === r;
    const toClass = behind(r, isClassLeader ? undefined : cl);
    const speed = rowSpeedMps(r);
    const num = r.vehicleNumber == null ? '' : String(r.vehicleNumber).trim();
    const file = typeof r.vehFilename === 'string' ? r.vehFilename : '';
    const carId = file && carIdByFile ? carIdByFile.get(file) : undefined;
    const pit = fin(r.pitState) ? PIT_STATES[r.pitState] : undefined;
    const ve = r.virtualEnergy;
    const car: ReplayCar = {
      slotID: r.slotID,
      position: pos(r) === 999 ? 0 : pos(r),
      driverName: typeof r.driverName === 'string' ? r.driverName : '',
      bestLapTime: fin(r.bestLapTime) ? r.bestLapTime : -1,
      lastLapTime: timing.lastLap(r.slotID),
      // LMU's REST semantics, which the standings mapping already speaks: 0 =
      // "no timed gap" (lapped, or not yet timed) for anyone but the leader.
      timeBehindLeader: isLeader ? 0 : toLeader.gap ?? 0,
      timeBehindNext: toNext.gap ?? 0,
      lapsBehindLeader: isLeader ? 0 : toLeader.laps,
      lapsBehindClassLeader: isClassLeader ? 0 : toClass.laps,
      lapsCompleted: Math.max(0, (r.currentLapsCompleted ?? 0) | 0),
      lapDistance: normaliseLapDist(r.lapDist ?? 0, len),
      pitting: r.inPits === true,
      inGarageStall: r.inGarage === true,
      hasFocus: r.slotHasFocus === true,
    };
    if (isClassLeader) car.timeBehindClassLeader = 0;
    else if (toClass.gap !== null) car.timeBehindClassLeader = toClass.gap;
    if (fin(r.qualiPosition) && r.qualiPosition > 0) car.qualification = r.qualiPosition;
    if (typeof r.teamName === 'string' && r.teamName) car.fullTeamName = r.teamName;
    if (num) car.carNumber = num;
    if (typeof r.vehicleClass === 'string' && r.vehicleClass) car.carClass = r.vehicleClass;
    if (carId) car.carId = carId;
    if (pit) car.pitState = pit;
    if (speed !== undefined) car.carVelocity = { velocity: speed };
    if (typeof r.finishStatus === 'string' && r.finishStatus) car.finishStatus = r.finishStatus;
    // A flat 100 is what every car read for the whole capture, mid-stint — not
    // a reading. Only a value that has visibly moved off full is passed on.
    if (fin(ve) && ve > 0 && ve < 100) car.veFraction = ve / 100;
    // The one place a RIVAL's penalty kind is published: LiveStandings splits
    // the count into drive-throughs and stop/gos (telemetry/penalties.ts).
    const pen = liveStandingsPenalties(r.penalties);
    if (pen) {
      car.penalties = pen.count;
      if (pen.kind) car.penaltyKind = pen.kind;
    }
    return car;
  });
  return { cars, positions, raceDist };
}

/**
 * Signed road gap from the focus car to `slot`, seconds — positive = ahead on
 * the road — timed off {@link ReplayTiming}: a car ahead is "how long ago it was
 * where the focus car is now", a car behind is "how long ago the focus car was
 * where it is now". Null until the history covers the point.
 */
export function replayRoadGap(
  timing: ReplayTiming,
  field: ReplayField,
  focusSlot: number,
  slot: number,
  len: number,
  et: number,
): number | null {
  if (!fin(et) || et <= 0 || !(len > 0)) return null;
  const fd = field.raceDist.get(focusSlot);
  const cd = field.raceDist.get(slot);
  if (fd === undefined || cd === undefined) return null;
  let road = (cd % len) - (fd % len);
  if (road > len / 2) road -= len;
  else if (road < -len / 2) road += len;
  if (road >= 0) {
    const at = timing.timeAt(slot, cd - road);
    return at === null ? null : et - at;
  }
  const at = timing.timeAt(focusSlot, fd + road);
  return at === null ? null : -(et - at);
}

/* ------------------------------ session clock ------------------------------ */

/** A recording that runs this far past the session's booked end is not that session. */
const END_SLACK_SEC = 1800;

/**
 * Seconds left in the replayed session, or {@link UNKNOWN_VALUE}.
 *
 * The booked end comes from REST `sessionInfo.endEventTime` — the LOADED
 * session's, which for a replay of it is the recording's. It is only believed
 * when the recording itself fits inside it (a recording ending more than half
 * an hour after the booked end belongs to another session), and the clock is
 * the replay's own event time, never REST's frozen one.
 */
export function replayTimeRemaining(et: number, endEventTime: unknown, m: ReplayMetrics | null): number {
  if (!fin(et) || et <= 0 || !fin(endEventTime) || endEventTime <= 0 || endEventTime > 1e6) {
    return UNKNOWN_VALUE;
  }
  if (m && fin(m.replayStartET) && fin(m.replayLength)) {
    if (m.replayStartET + m.replayLength > endEventTime + END_SLACK_SEC) return UNKNOWN_VALUE;
  }
  return Math.max(0, Math.round(endEventTime - et));
}

/**
 * The replayed session's phase. The feeds publish none, so only what the cars
 * prove: a FINISHED verdict means the chequer is out, and a leader with a lap
 * on the board means the race is running. Before that it is not claimed — a
 * formation lap and a first green lap look the same from here.
 */
export function replayPhase(cars: readonly ReplayCar[]): SessionPhase {
  if (cars.some((c) => /FINISH/i.test(String(c.finishStatus ?? '')))) return 'checkered';
  return cars.some((c) => c.lapsCompleted >= 1) ? 'green' : 'unknown';
}

/* ------------------------------ camera physics ----------------------------- */

const unknown4 = (): [number, number, number, number] => [
  UNKNOWN_VALUE,
  UNKNOWN_VALUE,
  UNKNOWN_VALUE,
  UNKNOWN_VALUE,
];

/**
 * The camera car's replaymetrics as the player-block physics record. Only the
 * channels the push carries are filled; fuel, hybrid, tyres, motion, aids and
 * the TC/ABS split are the explicit "unknown" shapes the spectator path
 * already uses, so no consumer can mistake them for readings.
 */
export function metricsPhysics(m: ReplayMetrics, et: number): LocalCarPhysics {
  const n = (v: unknown, d = 0): number => (fin(v) ? v : d);
  const kph = metricsSpeedKph(m);
  const throttle = clamp(n(m.throttle), 0, 1);
  const brake = clamp(n(m.brakes), 0, 1);
  const lapTime = n(m.timeIntoLap, UNKNOWN_VALUE);
  return {
    throttle,
    brake,
    clutch: clamp(n(m.clutch), 0, 1),
    steer: clamp(n(m.steering), -1, 1),
    tc: 0,
    abs: 0,
    aidRaw: {
      t: 0,
      throttle,
      filteredThrottle: throttle,
      brake,
      wheelBrake: null,
      tcActive: false,
      absActive: false,
    },
    steerRangeDeg: UNKNOWN_VALUE,
    gear: fin(m.gear) ? Math.round(m.gear) : UNKNOWN_VALUE,
    rpm: fin(m.rpm) && m.rpm >= 0 ? m.rpm : UNKNOWN_VALUE,
    maxRpm: fin(m.maxRPM) && m.maxRPM > 0 ? m.maxRPM : UNKNOWN_VALUE,
    speedKph: kph === UNKNOWN_VALUE ? UNKNOWN_VALUE : Math.round(kph),
    speedMps: kph === UNKNOWN_VALUE ? 0 : kph / 3.6,
    rearBrakeBias: UNKNOWN_VALUE,
    fuelLiters: UNKNOWN_VALUE,
    capacityLiters: UNKNOWN_VALUE,
    limiterOn: null,
    batteryCharge: UNKNOWN_VALUE,
    motorTorqueNm: UNKNOWN_VALUE,
    tyreTempsC: unknown4(),
    tyreHudTempsC: unknown4(),
    tyreSurfaceBandsC: [null, null, null, null],
    tyreLinerBandsC: [null, null, null, null],
    tyreCoreC: unknown4(),
    tyreBrakeC: unknown4(),
    tyrePressureKpa: unknown4(),
    lapNumber: fin(m.lapNumber) ? m.lapNumber : UNKNOWN_VALUE,
    lapTimeSec: lapTime >= 0 ? lapTime : UNKNOWN_VALUE,
    lapStartET: UNKNOWN_VALUE,
    elapsedSec: fin(et) && et > 0 ? et : UNKNOWN_VALUE,
    carNumber: m.vehicleNumber == null ? '' : String(m.vehicleNumber),
    motion: null,
    rawCorners: null,
    chassis: null,
    aidSettings: null,
  };
}

/* --------------------------------- sockets --------------------------------- */

/** The slice of a `ws` client this module uses — injectable for tests. */
export interface ReplaySocket {
  on(event: 'open', fn: () => void): unknown;
  on(event: 'message', fn: (data: unknown) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}
export type ReplaySocketFactory = (url: string) => ReplaySocket;

const defaultFactory: ReplaySocketFactory = (url) =>
  new WebSocket(url, { handshakeTimeout: 3000, perMessageDeflate: false }) as unknown as ReplaySocket;

/** Reconnect backoff, ms: first retry, ceiling. */
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 15_000;
/** A push older than this is not a description of now, unless its socket is up. */
export const REPLAY_FEED_STALE_MS = 2000;
/** A metrics push older than this cannot stamp a standings push with a time. */
const METRICS_CLOCK_MS = 1000;
/** Pushes bigger than this are not what LMU sends; they are not parsed on the main thread. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

interface Channel {
  url: string;
  ws: ReplaySocket | null;
  open: boolean;
  retryMs: number;
  timer: NodeJS.Timeout | null;
}

/** The latest LiveStandings push. */
export interface StandingsPush {
  rows: LiveStandingRow[];
  /** Wall clock at arrival, ms. */
  at: number;
  /** Increments per push — the provider rebuilds only on a new one. */
  seq: number;
  /** Replay event time from the freshest metrics push, or NaN. */
  et: number;
}

/** The latest replayMetrics push. */
export interface MetricsPush {
  body: ReplayMetrics;
  at: number;
  et: number;
}

/**
 * The two replay websockets. Inert until {@link setActive}(true); closed and
 * emptied by {@link setActive}(false). A socket that drops reconnects with
 * backoff; nothing here blocks, throws into the caller, or retains data across
 * an activation — a stale push from a previous replay can never describe this
 * one.
 */
export class ReplayFeed {
  private readonly ui: Channel;
  private readonly rm: Channel;
  private readonly factory: ReplaySocketFactory;
  private readonly verbose: boolean;
  private active = false;
  private seq = 0;
  private lastEtMoveAt = 0;
  /** Sockets opened since construction — tests read it; nothing else should. */
  public opened = 0;
  public standings: StandingsPush | null = null;
  public metrics: MetricsPush | null = null;

  public constructor(opts: { port: number; factory?: ReplaySocketFactory; verbose?: boolean }) {
    const base = `ws://127.0.0.1:${opts.port}/websocket/`;
    this.ui = { url: base + 'ui', ws: null, open: false, retryMs: RETRY_FIRST_MS, timer: null };
    this.rm = { url: base + 'replaymetrics', ws: null, open: false, retryMs: RETRY_FIRST_MS, timer: null };
    this.factory = opts.factory ?? defaultFactory;
    this.verbose = opts.verbose === true;
  }

  public isActive(): boolean {
    return this.active;
  }

  /** Open both sockets (replay playing) or close both and forget everything (not). */
  public setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) {
      if (this.verbose) console.log('[lmu] replay: opening the replay websockets');
      this.connect(this.ui);
      this.connect(this.rm);
    } else {
      this.shut(this.ui);
      this.shut(this.rm);
      this.standings = null;
      this.metrics = null;
      this.lastEtMoveAt = 0;
    }
  }

  /** Whether the standings may describe now: socket up, or the push is fresh. */
  public standingsUsable(nowMs: number): boolean {
    return this.usable(this.ui, this.standings, nowMs);
  }

  public metricsUsable(nowMs: number): boolean {
    return this.usable(this.rm, this.metrics, nowMs);
  }

  /** Whether the replay clock moved in the last second (false = paused, or no clock). */
  public playing(nowMs: number): boolean {
    return this.lastEtMoveAt > 0 && nowMs - this.lastEtMoveAt < METRICS_CLOCK_MS;
  }

  private usable(ch: Channel, push: { at: number } | null, nowMs: number): boolean {
    if (!this.active || !push) return false;
    // An open socket with a quiet feed is a paused replay holding still; a
    // closed one gets a short bridge for the reconnect, then the frame falls
    // back to what it showed before this feed existed.
    return ch.open || nowMs - push.at < REPLAY_FEED_STALE_MS;
  }

  private connect(ch: Channel): void {
    if (!this.active || ch.ws) return;
    let ws: ReplaySocket;
    try {
      ws = this.factory(ch.url);
    } catch (err) {
      if (this.verbose) console.error('[lmu] replay socket failed:', (err as Error).message);
      this.retry(ch);
      return;
    }
    this.opened++;
    ch.ws = ws;
    ws.on('open', () => {
      if (ch.ws !== ws) return;
      ch.open = true;
      ch.retryMs = RETRY_FIRST_MS;
      // The one message LMU's own overlay sends on this socket.
      if (ch === this.ui) {
        try {
          ws.send(JSON.stringify({ messageType: 'SUB', topic: 'LiveStandings' }));
        } catch {
          /* the close handler reconnects */
        }
      }
    });
    ws.on('message', (data: unknown) => {
      if (ch.ws !== ws) return;
      this.onMessage(ch, data);
    });
    // A listener is mandatory: an unhandled 'error' event would throw.
    ws.on('error', (err: Error) => {
      if (this.verbose) console.error('[lmu] replay socket error:', err && err.message);
    });
    ws.on('close', () => {
      if (ch.ws !== ws) return;
      ch.ws = null;
      ch.open = false;
      this.retry(ch);
    });
  }

  private retry(ch: Channel): void {
    if (!this.active || ch.timer) return;
    const wait = ch.retryMs;
    ch.retryMs = Math.min(RETRY_MAX_MS, ch.retryMs * 2);
    ch.timer = setTimeout(() => {
      ch.timer = null;
      this.connect(ch);
    }, wait);
    ch.timer.unref?.();
  }

  private shut(ch: Channel): void {
    if (ch.timer) {
      clearTimeout(ch.timer);
      ch.timer = null;
    }
    const ws = ch.ws;
    ch.ws = null;
    ch.open = false;
    ch.retryMs = RETRY_FIRST_MS;
    if (ws) {
      try {
        if (ws.terminate) ws.terminate();
        else ws.close();
      } catch {
        /* already gone */
      }
    }
  }

  private onMessage(ch: Channel, data: unknown): void {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (data instanceof Buffer) text = data.length > MAX_MESSAGE_BYTES ? '' : data.toString('utf8');
    else if (Array.isArray(data)) text = Buffer.concat(data as Buffer[]).toString('utf8');
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
    else return;
    if (!text || text.length > MAX_MESSAGE_BYTES) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const now = Date.now();
    const o = msg as { topic?: unknown; type?: unknown; body?: unknown };
    if (ch === this.ui) {
      if (o.topic !== 'LiveStandings' || !Array.isArray(o.body)) return;
      const m = this.metrics;
      this.standings = {
        rows: o.body as LiveStandingRow[],
        at: now,
        seq: ++this.seq,
        et: m && now - m.at < METRICS_CLOCK_MS ? m.et : Number.NaN,
      };
    } else {
      if (o.type !== 'replayMetrics' || !o.body || typeof o.body !== 'object') return;
      const body = o.body as ReplayMetrics;
      const et = replayEventTime(body);
      if (fin(et) && (!this.metrics || et !== this.metrics.et)) this.lastEtMoveAt = now;
      this.metrics = { body, at: now, et };
    }
  }
}
