/**
 * @file src/telemetry/stopLog.ts
 * @module telemetry/stopLog
 *
 * The **stop database**: one record per pit visit, written beside the lap
 * database, for the same reason and by the same rules.
 *
 * ## Why this exists
 * A strategy engine's answer is dominated by what a stop COSTS, and nothing in
 * this app wrote a stop down. `pitExit.ts` measures a class-wide pit loss from
 * rivals' stops, which is the right input for "where do I come out" — but it
 * cannot say how long OUR car stood still, how much fuel went in, or whether
 * tyres were changed, and those three are what a refuel rate and a service-time
 * model are fitted from. See `docs/RACE-STRATEGY-ENGINE.md` §3.
 *
 * ## What is measured, and what is merely reported
 * Both, separately, because they disagree and the disagreement is informative:
 *
 *   - **`stationarySec`** is measured — wheels stopped, in the lane. This is
 *     the number a refuel rate divides into.
 *   - **`laneSec`** is measured — entry to exit, so it includes the limiter
 *     crawl at both ends. `pitExit`'s loss figure is the same quantity seen
 *     from the timing screen; keeping ours lets the two be reconciled.
 *   - **`bookedSec`** is the sim's OWN total for the service booked on the MFD
 *     (`damage.ts` `stopLengthSeconds`). It is a prediction, not an
 *     observation, and it is recorded as such: it is the only figure available
 *     *before* the stop, which makes it the one a strategy engine has to plan
 *     with, so how well it matches reality is worth knowing.
 *
 * ## Refuel rate needs fuel-only stops
 * LMU services in parallel, so stationary time is the LONGEST job, not the sum.
 * A stop that changed tyres therefore says nothing about how fast fuel flows.
 * `tyresChanged` is recorded so the offline fit can keep the stops that can
 * answer the question and discard the ones that cannot — this module does not
 * do that filtering itself, because a log that has already made judgements is a
 * log you cannot re-interrogate later.
 *
 * Pure and synchronous like {@link LapRecorder}: fed samples, returns a record
 * when a stop completes, does no IO of its own.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UNKNOWN_VALUE } from './types';
import { trackKeyOf } from './paceDelta';

/* -------------------------------------------------------------------------- */
/*  Record shape                                                              */
/* -------------------------------------------------------------------------- */

/** One completed pit visit, as written to disk. One JSON object per line. */
export interface StopRecord {
  /** Schema version. */
  v: 1;
  /** Unique id, so a later feature can attach things to a stop. */
  id: string;
  /** Wall-clock completion time (lane exit), ISO 8601. */
  at: string;
  sim: string;
  track: string;
  trackKey: string;
  car: string;
  carClass: string;
  sessionType: string;
  /** Laps completed when the car entered the lane — where the stop sits. */
  lap: number;
  /** Which stop of this session it was, 1-based. */
  stopNo: number;

  /** Entry to exit, seconds — limiter crawl included. */
  laneSec: number;
  /**
   * Wheels-stopped time in the lane, seconds. `UNKNOWN_VALUE` when no speed
   * channel was available (spectating, no shared memory) — never zero, which
   * would read as an instant stop.
   */
  stationarySec: number;
  /** The sim's own predicted total for the booked service, when it published one. */
  bookedSec?: number;

  /** Litres added. Negative deltas are impossible and are not recorded. */
  fuelAddedL?: number;
  fuelBeforeL?: number;
  fuelAfterL?: number;
  /** Energy added, percent, for classes running an energy budget. */
  veAddedPct?: number;

  /** Any corner's wear rose across the stop. */
  tyresChanged: boolean;
  /** Wear either side, `[FL, FR, RL, RR]`. */
  wearBefore?: [number, number, number, number];
  wearAfter?: [number, number, number, number];
  /** Compound on the car when it left the box. */
  compoundFitted?: string;
}

/* -------------------------------------------------------------------------- */
/*  Recorder                                                                  */
/* -------------------------------------------------------------------------- */

/** One poll of the driven car, from the caller's point of view. */
export interface StopInput {
  sim: string;
  track: string;
  trackLengthM: number;
  car: string;
  carClass: string;
  sessionType: string;
  lapsCompleted: number;
  /** Physically in the pit lane or box right now — `isOnPitLane`, not a request. */
  inPit: boolean;
  /** Road speed, km/h. Omit when no speed channel exists. */
  speedKph?: number;
  fuelL?: number;
  vePct?: number;
  wear?: [number, number, number, number];
  compound?: string;
  /** The sim's own booked-stop total, seconds (`damage.stopLengthSeconds`). */
  bookedSec?: number;
}

/**
 * Below this the car is standing still for our purposes. Generous on purpose:
 * a car being serviced can twitch on its jacks, and the difference between
 * 0 and 3 km/h across a 30 s stop is noise next to what it is measuring.
 */
const STATIONARY_KPH = 3;

/**
 * Consecutive clear samples before a car counts as having left the lane.
 * Mirrors `pitStopCounter`'s re-arm for the same reason: the sim's pit flags
 * flutter mid-service, and a dropped sample must not split one stop into two.
 */
const EXIT_SAMPLES = 5;

/** Discard visits outside this range — a torn read, or a car parked for good. */
const MIN_LANE_SEC = 3;
const MAX_LANE_SEC = 15 * 60;

interface Visit {
  enteredAtMs: number;
  lap: number;
  fuelBefore: number;
  veBefore: number;
  wearBefore?: [number, number, number, number];
  /** Accumulated wheels-stopped time, ms. */
  stillMs: number;
  /** Whether a speed channel was ever seen — separates "0 s" from "no read". */
  sawSpeed: boolean;
  bookedSec: number;
  /** Consecutive samples seen clear of the lane. */
  offFor: number;
  lastSampleMs: number;
}

const num = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v !== UNKNOWN_VALUE;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function wearOf(w: unknown): [number, number, number, number] | undefined {
  return Array.isArray(w) && w.length === 4 && w.every(num)
    ? (w.map((x) => round3(x as number)) as [number, number, number, number])
    : undefined;
}

/**
 * Watches the driven car and emits one {@link StopRecord} per completed pit
 * visit.
 */
export class StopRecorder {
  private key = '';
  private visit: Visit | null = null;
  private stopNo = 0;
  /** Last on-track sample, so a visit knows the state it interrupted. */
  private lastOnTrack: StopInput | null = null;

  /**
   * Feed one poll. Returns a record on the poll a stop completes, else `null`.
   *
   * @param input this poll's state
   * @param nowMs monotonic-enough wall clock; the caller's frame time
   */
  public update(input: StopInput, nowMs: number): StopRecord | null {
    const key = `${input.track}|${input.sessionType}|${input.car}|${input.carClass}`;
    if (key !== this.key) {
      // A visit spanning a session change cannot be timed against anything;
      // drop it rather than write a stop of unknown length.
      this.key = key;
      this.visit = null;
      this.stopNo = 0;
      this.lastOnTrack = null;
    }

    if (!input.inPit) {
      if (!this.visit) {
        this.lastOnTrack = input;
        return null;
      }
      // In the lane a moment ago. Wait out the flutter before calling it over.
      this.visit.offFor++;
      if (this.visit.offFor < EXIT_SAMPLES) return null;
      const done = this.close(input, nowMs);
      this.visit = null;
      this.lastOnTrack = input;
      return done;
    }

    if (!this.visit) {
      // Entering. Baseline from the last ON-TRACK sample where we have one:
      // by the time the pit flag is up the car may already be taking fuel, and
      // a "before" level read then would understate what went in.
      const base = this.lastOnTrack ?? input;
      this.visit = {
        enteredAtMs: nowMs,
        lap: num(input.lapsCompleted) ? input.lapsCompleted : UNKNOWN_VALUE,
        fuelBefore: num(base.fuelL) ? base.fuelL : UNKNOWN_VALUE,
        veBefore: num(base.vePct) && base.vePct > 0 ? base.vePct : UNKNOWN_VALUE,
        wearBefore: wearOf(base.wear),
        stillMs: 0,
        sawSpeed: false,
        bookedSec: UNKNOWN_VALUE,
        offFor: 0,
        lastSampleMs: nowMs,
      };
      return null;
    }

    // Still in the lane. Accumulate.
    const v = this.visit;
    v.offFor = 0;
    const dt = Math.max(0, Math.min(nowMs - v.lastSampleMs, 2000));
    v.lastSampleMs = nowMs;
    if (num(input.speedKph)) {
      v.sawSpeed = true;
      if (input.speedKph < STATIONARY_KPH) v.stillMs += dt;
    }
    // The booked total is only published while the stop is live, and it firms
    // up as the driver edits the MFD — keep the latest.
    if (num(input.bookedSec) && input.bookedSec > 0) v.bookedSec = input.bookedSec;
    return null;
  }

  /** Turn a finished visit into a record, or `null` if it was not a stop. */
  private close(exit: StopInput, nowMs: number): StopRecord | null {
    const v = this.visit;
    if (!v) return null;
    // The exit is EXIT_SAMPLES polls ago; the lane time ends when the car
    // actually cleared it, not when we were satisfied that it had.
    const laneSec = (v.lastSampleMs - v.enteredAtMs) / 1000;
    if (!(laneSec >= MIN_LANE_SEC && laneSec <= MAX_LANE_SEC)) return null;

    this.stopNo++;
    const fuelAfter = num(exit.fuelL) ? exit.fuelL : UNKNOWN_VALUE;
    const added =
      num(v.fuelBefore) && num(fuelAfter) && fuelAfter > v.fuelBefore
        ? fuelAfter - v.fuelBefore
        : UNKNOWN_VALUE;
    const wearAfter = wearOf(exit.wear);
    // Tyres are new when any corner came back with MORE rubber than it had.
    // The 0.02 floor keeps a sampling wobble from reporting a tyre change that
    // never happened, which would poison the refuel-rate fit.
    const before = v.wearBefore;
    const changed =
      !!before && !!wearAfter && wearAfter.some((w, i) => w > (before[i] ?? 1) + 0.02);
    const veAfter = num(exit.vePct) && exit.vePct > 0 ? exit.vePct : UNKNOWN_VALUE;

    return {
      v: 1,
      id: crypto.randomUUID(),
      at: new Date(nowMs).toISOString(),
      sim: exit.sim,
      track: exit.track,
      trackKey: trackKeyOf(exit.track, exit.trackLengthM),
      car: exit.car,
      carClass: exit.carClass,
      sessionType: exit.sessionType,
      lap: num(v.lap) ? v.lap : 0,
      stopNo: this.stopNo,
      laneSec: round2(laneSec),
      // No speed channel means no read — never zero, which would read as a
      // car that never actually stopped.
      stationarySec: v.sawSpeed ? round2(v.stillMs / 1000) : UNKNOWN_VALUE,
      ...(num(v.bookedSec) ? { bookedSec: round2(v.bookedSec) } : {}),
      ...(num(added) ? { fuelAddedL: round2(added) } : {}),
      ...(num(v.fuelBefore) ? { fuelBeforeL: round2(v.fuelBefore) } : {}),
      ...(num(fuelAfter) ? { fuelAfterL: round2(fuelAfter) } : {}),
      ...(num(v.veBefore) && num(veAfter) && veAfter > v.veBefore
        ? { veAddedPct: round2(veAfter - v.veBefore) }
        : {}),
      tyresChanged: changed,
      ...(v.wearBefore ? { wearBefore: v.wearBefore } : {}),
      ...(wearAfter ? { wearAfter } : {}),
      ...(exit.compound ? { compoundFitted: exit.compound } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Storage — mirrors lapLog's, deliberately                                  */
/* -------------------------------------------------------------------------- */

/** Directory holding the stop files, one per UTC day. Beside the lap files. */
export function stopDir(): string {
  return path.join(os.homedir(), '.apex-overlay', 'stops');
}

/** Append one stop to today's file. Best-effort: never throws at the caller. */
export function appendStop(record: StopRecord, dir = stopDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date(record.at).toISOString().slice(0, 10);
    fs.appendFileSync(path.join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`);
  } catch {
    /* a full disk must not take the overlay down mid-race */
  }
}

/** Read back every stop in a directory, skipping lines that will not parse. */
export function readStops(dir = stopDir()): StopRecord[] {
  const out: StopRecord[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as StopRecord);
      } catch {
        /* a torn last line from a crash mid-append */
      }
    }
  }
  return out;
}
