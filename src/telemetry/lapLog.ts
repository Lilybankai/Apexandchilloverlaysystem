/**
 * @file src/telemetry/lapLog.ts
 * @module telemetry/lapLog
 *
 * The **lap database**: every completed lap, written to a local JSONL file, and
 * the rolling-window summary the control panel's "Your week" card reads back.
 *
 * This is the foundation both league features stand on — the weekly lap counter
 * and, later, the per-class leaderboard — so the shape of what it records is
 * deliberately a superset of what either one currently displays.
 *
 * ## Why local files, and why every lap
 * Nothing here talks to the network. Laps land on disk first and are uploaded
 * later by the desktop app, which is the half of the system that holds the
 * account (`electron/auth.js`). That split buys three things worth having:
 *
 *   - **Offline works.** A race weekend with the router down still counts. The
 *     upload is a separate concern that reads a file, not a step that can lose
 *     a lap by failing.
 *   - **Headless works.** Someone running `npm start` without the Electron app
 *     still accumulates laps; they upload next time the app opens.
 *   - **The cloud stays small.** Every lap is cheap on disk and expensive in a
 *     shared database. The league only ever needs two aggregates out of this —
 *     a lap COUNT per day and a BEST time per class — and both are derivable
 *     from the file. Storing 400 practice laps in Postgres to display the
 *     number 400 would be the wrong trade.
 *
 * ## What counts as a lap time
 * The recorded time is the **sim's own** `lastLapTime`, not a time reconstructed
 * from our sampling. `paceDelta.ts` builds its own lap clock because it needs a
 * distance→time trace for the delta bar, and for that job a reconstruction is
 * fine. A leaderboard entry is a claim about what the sim said, so it uses what
 * the sim said.
 *
 * ## What counts as CLEAN — and why that is our opinion, not the sim's
 * LMU publishes no per-lap validity. It judges track limits internally against
 * the white line, shows warnings on its own HUD, and exposes only the
 * consequence — `mNumPenalties` — once a penalty has actually landed. There is
 * no channel, in shared memory or over REST, that says "that lap was deleted".
 * (See the module note in `trackLimits.ts`, which had to make the same
 * admission.)
 *
 * So `clean` here is the Apex rule, defined in {@link DirtyReason}, and it must
 * be presented to drivers as the league's rule rather than as the stewards'. It
 * is deliberately *stricter* than the sim in one direction — any excursion at
 * all voids the lap, where LMU allows a count before it acts — because a
 * leaderboard wants laps nobody can argue with, and the driver keeps the lap in
 * their own history either way.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UNKNOWN_VALUE } from './types';
import { trackKeyOf } from './paceDelta';

/* -------------------------------------------------------------------------- */
/*  Record shape                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Why a lap is not clean. A lap can collect several; all of them are kept,
 * because "off track AND served a penalty" and "off track" are different
 * stories when someone asks why their time is not on the board.
 *
 * - `pit`      — the car was in the pit lane or its garage stall during the lap
 *                (in-lap, out-lap, or a drive-through). At most circuits the pit
 *                lane spans the start/finish line, so this catches both halves.
 * - `limits`   — our own excursion counter moved during the lap. Approximate by
 *                construction; see the note above.
 * - `penalty`  — the sim's outstanding-penalty count rose during the lap. This
 *                one IS the stewards, so it is reported without hedging.
 * - `partial`  — the lap was already in progress when we started watching (the
 *                app opened mid-stint, or the feed dropped and recovered), so
 *                nothing can be said about the parts we did not see.
 * - `implausible` — the sim's own lap time failed the sanity floor/ceiling. The
 *                lap is still counted as driven; it is just not a time.
 */
export type DirtyReason = 'pit' | 'limits' | 'penalty' | 'partial' | 'implausible';

/** One completed lap, as written to disk. One JSON object per line. */
export interface LapRecord {
  /**
   * Schema version, so a later reader can migrate rather than guess.
   *
   * `2` added the two layout-identifying fields below. Nothing needs migrating:
   * both are optional, and a v1 lap simply cannot be pace-scored at a venue with
   * more than one layout — which is the correct outcome, since at the time it
   * was written we genuinely did not record which layout it was.
   */
  v: 1 | 2;
  /** Wall-clock completion time, ISO 8601. */
  at: string;
  /** Which sim produced it (`"lmu"`, `"rf2"`, `"simulator"`). */
  sim: string;
  /** Track name exactly as the sim gave it. */
  track: string;
  /** Normalised `name_length` key — the stable identity across name variants. */
  trackKey: string;
  /**
   * Layout/config name, when the provider published one. Absent for LMU, whose
   * REST feed names only the venue.
   */
  trackConfig?: string;
  /**
   * The sim's INTERNAL track name — the scene, from `rF2ScoringInfo.mTrackName`.
   *
   * Stored because it is the only channel that states which LAYOUT is loaded,
   * and a lap is scored against a layout's reference pace long after the session
   * that set it has gone. Without it a Monza lap in the history can never be
   * told apart from a Curva Grande one, and those are ~10 s apart.
   */
  simTrackName?: string;
  /** Lap length in metres, `0` when the sim did not publish one. */
  trackLengthM: number;
  /** Car model from the Scoring buffer; `""` when unreadable (spectating). */
  car: string;
  /** Canonical class label (`"GT3"`, `"HYPERCAR"`, …); `""` when unknown. */
  carClass: string;
  /** The sim's own lap time in whole milliseconds. */
  lapMs: number;
  /** Distance credited for this lap, metres — the weekly card's mileage. */
  distanceM: number;
  /** Session category the lap was set in (`"practice"`, `"race"`, …). */
  sessionType: string;
  /** `true` only when {@link dirty} is empty. Stored, not derived, so a later
   *  rule change cannot silently re-label laps already in someone's history. */
  clean: boolean;
  /** Everything wrong with the lap; empty on a clean one. */
  dirty: DirtyReason[];
  /** Track surface temperature in °C, when the sim published one. */
  trackTempC?: number;
  /** Ambient temperature in °C, when the sim published one. */
  ambientTempC?: number;
  /** `true` when there was standing water / rain during the lap. */
  wet?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Plausibility                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Bounds a lap time must fall inside to be treated as a time at all.
 *
 * The same guards `paceDelta.lapDone` applies to its reference traces, and for
 * the same reason: too fast is a fragment (a mid-lap join, a teleport, a track
 * reset) whose duration is not a lap time, and too slow is a lap with a stop in
 * it. Only the slow side used to be checked there, which is how a 48 s half-lap
 * once beat a genuine 94 s best.
 */
const MIN_LAP_MS = 5_000;
const MAX_LAP_MS = 3_600_000;

/* -------------------------------------------------------------------------- */
/*  Recorder                                                                  */
/* -------------------------------------------------------------------------- */

/** Per-poll state the recorder needs to decide when a lap ended, and how. */
export interface LapInput {
  /** Which sim is feeding us. */
  sim: string;
  /** Track name from the sim. */
  track: string;
  /** Layout/config name, when the provider publishes one. */
  trackConfig?: string;
  /** The sim's internal (scene) track name, when shared memory gave one. */
  simTrackName?: string;
  /** Lap length, metres; `0` when unknown. */
  trackLengthM: number;
  /** Car model, `""` when unreadable. */
  car: string;
  /** Canonical class label, `""` when unknown. */
  carClass: string;
  /** Session category. */
  sessionType: string;
  /** Laps this car has completed, from the sim. */
  lapsCompleted: number;
  /** The sim's own last lap time in seconds, or {@link UNKNOWN_VALUE}. */
  lastLapSec: number;
  /** `true` while the car is in the pit lane or its garage stall. */
  inPit: boolean;
  /** Our excursion count this session, or {@link UNKNOWN_VALUE} when unreadable. */
  limitWarnings: number;
  /** The sim's penalty count, or {@link UNKNOWN_VALUE} when unreadable. */
  penalties: number;
  /** Track surface temp, °C. */
  trackTempC?: number;
  /** Ambient temp, °C. */
  ambientTempC?: number;
  /** `true` when it is raining or the surface is wet. */
  wet?: boolean;
}

/**
 * Watches the driven car and emits one {@link LapRecord} per completed lap.
 *
 * Pure and synchronous — it does no file IO, so the provider can drive it every
 * poll and the tests can drive it with a scripted stint
 * (`scripts/test-laplog.js`). Writing is {@link LapWriter}'s job.
 */
export class LapRecorder {
  /** Identity of the stint we are watching; a change resets everything. */
  private key = '';
  /** `lapsCompleted` at the previous poll; `-1` before the first one. */
  private prevLaps = -1;
  /** Faults accumulated since the current lap began. */
  private dirty = new Set<DirtyReason>();
  /** Counter baselines taken when the current lap began. */
  private limitsAtStart: number = UNKNOWN_VALUE;
  private penaltiesAtStart: number = UNKNOWN_VALUE;

  /**
   * Feed one poll's state. Returns a record on the poll where a lap completed,
   * otherwise `null`.
   */
  public update(input: LapInput, nowMs: number): LapRecord | null {
    // A stint is one car at one track in one session type. Any change of those
    // makes the counters incomparable — `lapsCompleted` restarts, the excursion
    // count is zeroed by trackLimits on the same trigger — so start over rather
    // than emit one nonsense lap across the boundary.
    const key = `${input.track}|${input.sessionType}|${input.car}|${input.carClass}`;
    if (key !== this.key) {
      this.key = key;
      this.reset(input);
      return null;
    }

    const laps = input.lapsCompleted;
    if (typeof laps !== 'number' || !Number.isFinite(laps) || laps < 0) return null;

    // First sighting of this stint: adopt the count, and remember that whatever
    // is on track right now began before we were watching.
    if (this.prevLaps < 0) {
      this.reset(input);
      this.prevLaps = laps;
      this.dirty.add('partial');
      return null;
    }

    this.observe(input);

    // The sim's count going BACKWARDS is a session restart or a return to the
    // garage that the stint key did not catch (same track, same car, same
    // session type — e.g. "restart race"). Re-baseline; nothing completed.
    if (laps < this.prevLaps) {
      this.reset(input);
      this.prevLaps = laps;
      this.dirty.add('partial');
      return null;
    }

    if (laps === this.prevLaps) return null;

    // A jump of more than one means we missed a lap boundary entirely (the feed
    // dropped, or the app was asleep). Credit nothing: the one thing worse than
    // missing a lap from someone's weekly total is inventing laps they might not
    // have driven, and `lastLapTime` only describes the most recent one anyway.
    const stepped = laps - this.prevLaps;
    this.prevLaps = laps;
    if (stepped !== 1) {
      this.startLap(input);
      this.dirty.add('partial');
      return null;
    }

    const record = this.build(input, nowMs);
    this.startLap(input);
    return record;
  }

  /** Fold this poll's state into the current lap's fault set. */
  private observe(input: LapInput): void {
    if (input.inPit) this.dirty.add('pit');
    if (
      this.limitsAtStart !== UNKNOWN_VALUE &&
      input.limitWarnings !== UNKNOWN_VALUE &&
      input.limitWarnings > this.limitsAtStart
    ) {
      this.dirty.add('limits');
    }
    if (
      this.penaltiesAtStart !== UNKNOWN_VALUE &&
      input.penalties !== UNKNOWN_VALUE &&
      input.penalties > this.penaltiesAtStart
    ) {
      this.dirty.add('penalty');
    }
  }

  /** Turn the finished lap into a record. */
  private build(input: LapInput, nowMs: number): LapRecord {
    const lapMs =
      input.lastLapSec > 0 && Number.isFinite(input.lastLapSec)
        ? Math.round(input.lastLapSec * 1000)
        : 0;
    const dirty = new Set(this.dirty);
    if (lapMs < MIN_LAP_MS || lapMs > MAX_LAP_MS) dirty.add('implausible');

    const reasons = [...dirty];
    return {
      v: 2,
      at: new Date(nowMs).toISOString(),
      sim: input.sim,
      track: input.track,
      trackKey: trackKeyOf(input.track, input.trackLengthM),
      ...(input.trackConfig ? { trackConfig: input.trackConfig } : {}),
      ...(input.simTrackName ? { simTrackName: input.simTrackName } : {}),
      trackLengthM: Math.round(input.trackLengthM) || 0,
      car: input.car,
      carClass: input.carClass,
      lapMs,
      distanceM: Math.round(input.trackLengthM) || 0,
      sessionType: input.sessionType,
      clean: reasons.length === 0,
      dirty: reasons,
      ...(typeof input.trackTempC === 'number' ? { trackTempC: input.trackTempC } : {}),
      ...(typeof input.ambientTempC === 'number' ? { ambientTempC: input.ambientTempC } : {}),
      ...(input.wet !== undefined ? { wet: !!input.wet } : {}),
    };
  }

  /** Begin a fresh lap, re-baselining the counters we watch for movement. */
  private startLap(input: LapInput): void {
    this.dirty = new Set();
    this.limitsAtStart = input.limitWarnings;
    this.penaltiesAtStart = input.penalties;
    // The car is usually still ON the line when this runs, but if it is in the
    // pit lane the new lap is already compromised.
    if (input.inPit) this.dirty.add('pit');
  }

  /** Full reset — new stint, or a rewound lap count. */
  private reset(input: LapInput): void {
    this.prevLaps = -1;
    this.startLap(input);
  }
}

/* -------------------------------------------------------------------------- */
/*  Storage                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Directory holding the lap files, one per UTC day.
 *
 * Beside the PB traces (`~/.apex-overlay/pb`) rather than in Electron's
 * `userData`, because the server writes these and the server runs with or
 * without Electron.
 */
export function lapDir(): string {
  return path.join(os.homedir(), '.apex-overlay', 'laps');
}

/**
 * UTC date stamp (`YYYY-MM-DD`) for a timestamp.
 *
 * UTC, not local time, and deliberately so: the file name is an identity, not a
 * display. A driver who moves timezone (or whose clock crosses DST mid-stint)
 * must not end up with two files claiming the same day, and the rolling 7-day
 * window the panel shows does not care where the boundary falls. If a
 * Monday-to-Sunday league week is ever added, it can group these by local date
 * at read time from the `at` field, which carries the offset-free instant.
 */
export function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Append one lap to today's file. Best-effort: never throws at the caller. */
export function appendLap(record: LapRecord, dir = lapDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, `${dayStamp(Date.parse(record.at))}.jsonl`),
      `${JSON.stringify(record)}\n`,
      'utf8',
    );
  } catch {
    /* a lap that cannot be written is not worth taking the overlay down for */
  }
}

/**
 * Read the laps for one UTC day.
 *
 * A malformed line is skipped rather than failing the day: the file is appended
 * to live, so the last line can legitimately be half-written when a read races
 * a lap crossing the line, and losing the whole week's total to that would be a
 * bug the user sees every time it happens.
 */
export function readDay(day: string, dir = lapDir()): LapRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, `${day}.jsonl`), 'utf8');
  } catch {
    return []; // no laps that day
  }
  const out: LapRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as LapRecord;
      if (rec && typeof rec.lapMs === 'number') out.push(rec);
    } catch {
      /* torn final line, or hand-edited */
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Rolling summary                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One day's activity. Present for every day in the window, including the ones
 * with nothing on them — the dashboard draws a bar per day and a missing Tuesday
 * would silently shorten the week rather than showing the gap, which is the one
 * thing a week chart exists to show.
 */
export interface LapDay {
  /** UTC date stamp, `YYYY-MM-DD`. */
  day: string;
  laps: number;
  cleanLaps: number;
  distanceM: number;
  drivingMs: number;
}

/** A driver's activity over a window — what the "This week" card renders. */
export interface LapSummary {
  /** Per-day breakdown, oldest first, one entry per day in the window. */
  byDay: LapDay[];
  /** Every lap driven, clean or not. */
  laps: number;
  /** The subset that passed the clean-lap rule. */
  cleanLaps: number;
  /** Total distance, metres. */
  distanceM: number;
  /** Total lap time, milliseconds — time actually on a flying lap. */
  drivingMs: number;
  /** Distinct tracks driven. */
  tracks: number;
  /** Best clean lap per `trackKey|carClass`, for the leaderboard upload. */
  bests: LapBest[];
}

/** The best clean lap at one track in one class. */
export interface LapBest {
  trackKey: string;
  track: string;
  carClass: string;
  /** Car the time was set in — metadata on a class-keyed board. */
  car: string;
  lapMs: number;
  at: string;
  /**
   * The three fields `referencePace` needs to identify which LAYOUT this was, so
   * the dashboard can score the time without re-reading the day files. Carried
   * on the summary rather than looked up later because the lap already knew.
   */
  trackLengthM: number;
  trackConfig?: string;
  simTrackName?: string;
}

/**
 * Summarise the last `days` UTC days, inclusive of today.
 *
 * Seven days is the league's rolling week. It is a *rolling* window rather than
 * Monday-to-Sunday on purpose: it needs no timezone policy to be meaningful,
 * and the per-day files below support a calendar week later without a migration.
 */
export function summarize(nowMs: number, days = 7, dir = lapDir()): LapSummary {
  const stamps: string[] = [];
  for (let i = days - 1; i >= 0; i--) stamps.push(dayStamp(nowMs - i * 86_400_000));

  const summary: LapSummary = {
    byDay: stamps.map((day) => ({ day, laps: 0, cleanLaps: 0, distanceM: 0, drivingMs: 0 })),
    laps: 0,
    cleanLaps: 0,
    distanceM: 0,
    drivingMs: 0,
    tracks: 0,
    bests: [],
  };

  const seenTracks = new Set<string>();
  // Keyed by track + CLASS, not track + car: the league's boards are per class,
  // so a driver's entry is their best in the class whichever car set it. The car
  // travels with the time as metadata. (The local delta reference is keyed the
  // other way round — see `refKeyOf` for why those two differ.)
  const best = new Map<string, LapBest>();

  for (let i = 0; i < stamps.length; i++) {
    const day = stamps[i]!;
    const bucket = summary.byDay[i]!;
    for (const rec of readDay(day, dir)) {
      summary.laps++;
      bucket.laps++;
      summary.distanceM += rec.distanceM || 0;
      bucket.distanceM += rec.distanceM || 0;
      if (rec.lapMs >= MIN_LAP_MS && rec.lapMs <= MAX_LAP_MS) {
        summary.drivingMs += rec.lapMs;
        bucket.drivingMs += rec.lapMs;
      }
      if (rec.trackKey) seenTracks.add(rec.trackKey);
      if (!rec.clean) continue;
      summary.cleanLaps++;
      bucket.cleanLaps++;

      const key = `${rec.trackKey}|${rec.carClass}`;
      const held = best.get(key);
      if (!held || rec.lapMs < held.lapMs) {
        best.set(key, {
          trackKey: rec.trackKey,
          track: rec.track,
          carClass: rec.carClass,
          car: rec.car,
          lapMs: rec.lapMs,
          at: rec.at,
          trackLengthM: rec.trackLengthM || 0,
          ...(rec.trackConfig ? { trackConfig: rec.trackConfig } : {}),
          ...(rec.simTrackName ? { simTrackName: rec.simTrackName } : {}),
        });
      }
    }
  }

  summary.tracks = seenTracks.size;
  summary.bests = [...best.values()].sort((a, b) =>
    a.track === b.track ? a.carClass.localeCompare(b.carClass) : a.track.localeCompare(b.track),
  );
  return summary;
}

/* -------------------------------------------------------------------------- */
/*  Upload plan                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Turning the local files into what the league's database should hold.
 *
 * ## Why this is a recomputed STATE, not a queue of events
 * The obvious design is an append-only queue with a cursor: every lap becomes a
 * message, the cursor records how far we got, and the uploader drains it. That
 * design has a failure mode this one cannot have — a cursor that desyncs from
 * the data. Lose it and you double-count; advance it before the write lands and
 * you silently drop laps; corrupt it and there is no way to tell which happened.
 *
 * Both server RPCs were built to be idempotent instead: `submit_activity` keeps
 * the GREATER of stored and incoming, and `submit_lap` only ever replaces a
 * slower time. That makes the correct client the simplest one — recompute what
 * the database should say from the files that are the source of truth, and send
 * it. Sending the same thing twice is a no-op by construction.
 *
 * The cache the uploader keeps beside this is therefore purely an optimisation:
 * it stops us re-sending rows that have not changed. Deleting it costs a burst
 * of redundant requests and nothing else, which is a very different class of bug
 * from a broken cursor.
 */

/** One day's counters for one track and class — a `submit_activity` call. */
export interface PendingActivity {
  day: string;
  sim: string;
  trackKey: string;
  trackName: string;
  trackLengthM: number;
  carClass: string;
  laps: number;
  cleanLaps: number;
  distanceM: number;
  drivingMs: number;
}

/** An all-time best clean lap for one track and class — a `submit_lap` call. */
export interface PendingBest {
  sim: string;
  trackKey: string;
  trackName: string;
  trackLengthM: number;
  /**
   * Layout hints, carried for the local pace score rather than for the upload —
   * the server neither reads nor stores them. They live here because this is
   * already the "best lap per track and class" projection the panel needs, and
   * building a second one that differs only in these two fields would be a
   * second place for the definition of "your best" to drift.
   */
  trackConfig?: string;
  simTrackName?: string;
  carClass: string;
  car: string;
  lapMs: number;
  setAt: string;
  conditions: Record<string, unknown>;
}

/** Everything the local files say the league database should contain. */
export interface UploadPlan {
  activity: PendingActivity[];
  bests: PendingBest[];
}

/**
 * How far back to scan. Generous rather than tight — someone can come back from
 * a long break with months of local laps — but bounded, so this can never grow
 * into reading an unbounded directory on a timer.
 */
const MAX_SCAN_DAYS = 365;

/** Day stamps we actually hold files for, oldest first. */
export function listDays(dir = lapDir()): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // nothing has been driven yet
  }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .map((n) => n.slice(0, 10))
    .sort()
    .slice(-MAX_SCAN_DAYS);
}

/**
 * Build the full desired state from every lap file on disk.
 *
 * Activity is grouped per day; bests are ALL-TIME rather than windowed, because
 * a leaderboard entry does not expire at the end of the week the way the
 * dashboard's rolling count does.
 */
export function buildUploadPlan(dir = lapDir()): UploadPlan {
  const activity = new Map<string, PendingActivity>();
  const bests = new Map<string, PendingBest>();

  for (const day of listDays(dir)) {
    for (const rec of readDay(day, dir)) {
      const carClass = (rec.carClass || '').toUpperCase();
      const sim = rec.sim || 'lmu';
      const trackKey = rec.trackKey || '';
      // No track identity means nothing to attach the lap to at the other end.
      if (!trackKey) continue;

      const aKey = `${day}|${sim}|${trackKey}|${carClass}`;
      let row = activity.get(aKey);
      if (!row) {
        row = {
          day,
          sim,
          trackKey,
          trackName: rec.track || trackKey,
          trackLengthM: rec.trackLengthM || 0,
          carClass,
          laps: 0,
          cleanLaps: 0,
          distanceM: 0,
          drivingMs: 0,
        };
        activity.set(aKey, row);
      }
      // A lap with no recognised class is still a lap DRIVEN, so it counts here;
      // the server buckets those under UNKNOWN. It is only the board below that
      // it cannot go on.
      row.laps++;
      row.distanceM += rec.distanceM || 0;
      if (rec.lapMs >= MIN_LAP_MS && rec.lapMs <= MAX_LAP_MS) row.drivingMs += rec.lapMs;
      if (!rec.clean) continue;
      row.cleanLaps++;

      // Only a clean, plausible, classified lap is ever offered to a board. The
      // server checks the same bounds; checking them here too means an
      // impossible time never becomes a request that can only be refused.
      if (rec.lapMs < MIN_LAP_MS || rec.lapMs > MAX_LAP_MS) continue;
      if (!carClass) continue;

      const bKey = `${sim}|${trackKey}|${carClass}`;
      const held = bests.get(bKey);
      if (!held || rec.lapMs < held.lapMs) {
        bests.set(bKey, {
          sim,
          trackKey,
          trackName: rec.track || trackKey,
          trackLengthM: rec.trackLengthM || 0,
          ...(rec.trackConfig ? { trackConfig: rec.trackConfig } : {}),
          ...(rec.simTrackName ? { simTrackName: rec.simTrackName } : {}),
          carClass,
          car: rec.car || '',
          lapMs: rec.lapMs,
          setAt: rec.at,
          conditions: {
            sessionType: rec.sessionType || '',
            ...(typeof rec.trackTempC === 'number' ? { trackTempC: rec.trackTempC } : {}),
            ...(typeof rec.ambientTempC === 'number' ? { ambientTempC: rec.ambientTempC } : {}),
            ...(rec.wet !== undefined ? { wet: !!rec.wet } : {}),
          },
        });
      }
    }
  }

  return {
    // Newest day first: if a run is capped, the days someone is most likely to
    // be looking at on the dashboard are the ones that got through.
    activity: [...activity.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    bests: [...bests.values()],
  };
}

/* -------------------------------------------------------------------------- */
/*  Diffing against what has already been sent                                */
/* -------------------------------------------------------------------------- */

/**
 * What the uploader remembers having successfully sent.
 *
 * `rejected` holds rows the SERVER refused for a reason that will never change
 * (an implausible time, a day outside the accepted range). Without it, a single
 * malformed lap becomes a request retried every few minutes for as long as the
 * app is installed.
 */
export interface SyncCache {
  /** `day|sim|trackKey|class` → the four counters last accepted. */
  activity: Record<string, string>;
  /** `sim|trackKey|class` → the best lap time last accepted, in ms. */
  bests: Record<string, number>;
  /** Keys the server permanently refused, with its reason. */
  rejected: Record<string, string>;
}

export function emptySyncCache(): SyncCache {
  return { activity: {}, bests: {}, rejected: {} };
}

/** Stable identity for an activity row. */
export function activityKey(row: PendingActivity): string {
  return `${row.day}|${row.sim}|${row.trackKey}|${row.carClass}`;
}

/** Stable identity for a best-lap row. */
export function bestKey(row: PendingBest): string {
  return `${row.sim}|${row.trackKey}|${row.carClass}`;
}

/** The counter tuple, as remembered in the cache. */
function activityCounters(row: PendingActivity): string {
  return `${row.laps}/${row.cleanLaps}/${row.distanceM}/${row.drivingMs}`;
}

/**
 * Reduce a full plan to only the rows worth sending.
 *
 * Activity is sent when ANY counter has moved since it was last accepted — not
 * only when the lap count did — because a day can gain clean laps or distance
 * without gaining laps.
 *
 * A best is sent only when it is genuinely FASTER than what the server last
 * accepted. Re-offering an equal time would be harmless (the server keeps the
 * earlier one) but it would be one request per run, forever, for every board a
 * driver is on.
 */
export function diffPlan(plan: UploadPlan, cache: SyncCache): UploadPlan {
  const c = cache || emptySyncCache();
  const rejected = c.rejected || {};
  return {
    activity: plan.activity.filter((row) => {
      const key = activityKey(row);
      if (rejected[key]) return false;
      return (c.activity || {})[key] !== activityCounters(row);
    }),
    bests: plan.bests.filter((row) => {
      const key = bestKey(row);
      if (rejected[key]) return false;
      const sent = (c.bests || {})[key];
      return typeof sent !== 'number' || row.lapMs < sent;
    }),
  };
}

/** Record a successful send, so the next diff skips it. */
export function markActivitySent(cache: SyncCache, row: PendingActivity): void {
  cache.activity[activityKey(row)] = activityCounters(row);
}

/** Record a successful best-lap send. */
export function markBestSent(cache: SyncCache, row: PendingBest): void {
  const key = bestKey(row);
  const sent = cache.bests[key];
  // Never move the remembered time backwards: the server keeps the fastest, so
  // claiming a slower one was accepted would make us re-send it every run.
  if (typeof sent !== 'number' || row.lapMs < sent) cache.bests[key] = row.lapMs;
}

/** Record a permanent refusal so it is never retried. */
export function markRejected(cache: SyncCache, key: string, reason: string): void {
  cache.rejected[key] = reason;
}
