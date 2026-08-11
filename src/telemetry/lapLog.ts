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

import * as crypto from 'node:crypto';
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
   *
   * `3` added {@link id} and the sector splits. Same story: a v1/v2 lap has no
   * trace file to point at and no sectors to show, and nothing downstream
   * requires either.
   *
   * `4` added {@link setupFp}. A pre-v4 lap simply cannot be attributed to a
   * setup — the honest outcome, since nobody recorded what the car was
   * running that day.
   */
  v: 1 | 2 | 3 | 4;
  /**
   * Unique id for this lap (UUID), minted when the record is built. This is the
   * join key between the lap database and everything recorded ABOUT the lap —
   * today the driving trace at `traces/<day>/<id>.json` (see `lapTrace.ts`),
   * later whatever else the training feature wants to attach. Absent on laps
   * written before v3.
   */
  id?: string;
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
  /**
   * Sector **split** times in whole milliseconds, when the sim published them —
   * S1, S2 and S3 as the durations a timing screen shows, not the cumulative
   * boundary times LMU's feed carries (see {@link LapInput.sector1Sec}). All
   * three are present or none: a partial set means the feed glitched at the
   * boundary, and two real sectors plus one wrong one reads as a timing screen
   * that lies.
   */
  s1Ms?: number;
  s2Ms?: number;
  s3Ms?: number;
  /**
   * Fingerprint of the garage setup the lap was driven on (see
   * `setupFingerprint.ts`) — the join key between a lap and a setup in the
   * library or the community catalogue. Absent when the garage endpoint had
   * not answered yet this stint (or on pre-v4 laps).
   */
  setupFp?: string;
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

/**
 * How long a finished lap is held before it is written, waiting for the sim's
 * track-limits verdict on it.
 *
 * LMU buffers its trace log ~4 KB at a time, which measured out at up to ~25 s
 * of lag between a cut happening and the charge for it reaching us (see
 * `docs/TRACK-LIMITS-POINTS.md`). 40 s clears that with room to spare and is
 * still far inside a lap at every circuit LMU runs, so the hold never overlaps
 * the lap after next. Nothing a driver sees depends on it: the lap is on disk
 * long before the session ends, and the upload reads the file, not this class.
 */
export const VERDICT_HOLD_MS = 40_000;

/** A finished lap waiting for its verdict. */
interface HeldLap {
  record: LapRecord;
  /** The sim's number for this lap, to match against what it charged. */
  lapNo: number;
  /** `nowMs` past which the verdict can no longer change anything. */
  until: number;
}

/** Whether the sim charged a cut to this lap. */
function chargedTo(chargedLaps: number[] | undefined, lapNo: number): boolean {
  if (!chargedLaps || lapNo === UNKNOWN_VALUE) return false;
  return chargedLaps.includes(lapNo);
}

/**
 * Cumulative sector boundary times → the three splits, or nothing.
 *
 * All-or-nothing on purpose (see the field note on `LapRecord.s1Ms`): the
 * boundaries must be strictly ordered inside the lap time, each split must be
 * plausible on its own, and any failure drops the whole set. The one glitch
 * this guards against was observed live — a boundary read of `0`/`-1` while the
 * feed catches up with a crossing — and a record with no sectors is honest
 * where one with an invented split is not.
 */
function sectorSplits(
  s1Sec: number | undefined,
  s2Sec: number | undefined,
  lapMs: number,
): Pick<LapRecord, 's1Ms' | 's2Ms' | 's3Ms'> | Record<string, never> {
  if (typeof s1Sec !== 'number' || typeof s2Sec !== 'number') return {};
  if (!Number.isFinite(s1Sec) || !Number.isFinite(s2Sec)) return {};
  const s1 = Math.round(s1Sec * 1000);
  const s2 = Math.round(s2Sec * 1000) - s1;
  const s3 = lapMs - Math.round(s2Sec * 1000);
  if (s1 <= 0 || s2 <= 0 || s3 <= 0) return {};
  return { s1Ms: s1, s2Ms: s2, s3Ms: s3 };
}

/** The same record with `limits` added — records are rebuilt, never mutated. */
function withLimits(rec: LapRecord): LapRecord {
  if (rec.dirty.includes('limits')) return rec;
  const dirty: DirtyReason[] = [...rec.dirty, 'limits'];
  return { ...rec, dirty, clean: false };
}

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
  /**
   * How many track-limit cuts the sim has **charged** for this session, or
   * {@link UNKNOWN_VALUE} when unreadable.
   *
   * The stewards' own count, since the geometry estimate was retired. Kept as
   * the fallback signal for when {@link chargedLaps} cannot say anything: it
   * still detects that *a* cut happened, it just cannot say whose lap it was.
   */
  limitWarnings: number;
  /**
   * The sim's own lap numbers for the laps it has charged something to.
   *
   * This is the channel that actually decides `limits`, because it is the only
   * one that names the guilty lap. See {@link TraceLimitsState.chargedLaps} for
   * why the count alone could never do it. Empty when the trace is unreadable
   * (no LMU log directory, rF2, the simulator provider), which is when the
   * count above takes over.
   */
  chargedLaps?: number[];
  /**
   * The sim's lap number for the lap being driven right now, or
   * {@link UNKNOWN_VALUE} when the provider cannot say.
   *
   * LMU's trace numbers the lap **in progress**, one-based, so this is one more
   * than the completed-lap count. Kept as an input rather than derived here so
   * the mapping lives at the provider that knows the sim's conventions, and so
   * a sim that numbers differently can say so without this class caring.
   */
  currentLapNo?: number;
  /** The sim's penalty count, or {@link UNKNOWN_VALUE} when unreadable. */
  penalties: number;
  /** Track surface temp, °C. */
  trackTempC?: number;
  /** Ambient temp, °C. */
  ambientTempC?: number;
  /** `true` when it is raining or the surface is wet. */
  wet?: boolean;
  /**
   * The just-completed lap's sector boundary times, seconds, **cumulative from
   * the lap's start** — LMU's `lastSectorTime1/2` convention: `sector1Sec` is
   * the clock at the S1 line, `sector2Sec` at the S2 line, and the lap time
   * itself closes S3. Only meaningful on the poll where {@link lapsCompleted}
   * increments, which is when the recorder reads them; {@link LapRecorder.build}
   * converts them to the splits a timing screen shows. Omit when the feed has
   * no sector channel (rF2, the simulator provider).
   */
  sector1Sec?: number;
  sector2Sec?: number;
  /**
   * Current setup fingerprint from the provider's cached garage read
   * (`fingerprintGarageData`). The garage endpoint reports the SETUP, frozen —
   * cockpit clicks never appear (probed live 2026-08-11) — so the value at the
   * line is the value the whole lap was driven on. Omit when no garage read
   * has succeeded; the lap then records no attribution rather than a guess.
   */
  setupFp?: string;
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
  /** The sim's lap number for the lap being driven, when the provider says. */
  private lapNo: number = UNKNOWN_VALUE;
  /** A finished lap waiting for the stewards' verdict to arrive — see below. */
  private held: HeldLap | null = null;

  /**
   * Feed one poll's state. Returns a record once a lap has completed **and** its
   * verdict has settled, otherwise `null`.
   */
  public update(input: LapInput, nowMs: number): LapRecord | null {
    // A stint is one car at one track in one session type. Any change of those
    // makes the counters incomparable — `lapsCompleted` restarts, the excursion
    // count is zeroed by trackLimits on the same trigger — so start over rather
    // than emit one nonsense lap across the boundary.
    const key = `${input.track}|${input.sessionType}|${input.car}|${input.carClass}`;
    if (key !== this.key) {
      // Whatever was held belongs to the stint that is ending, so it goes out
      // now rather than being dropped — an unheard verdict is not grounds for
      // losing the lap, only for judging it on what we did hear.
      const flushed = this.flush();
      this.key = key;
      this.reset(input);
      return flushed;
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
      // A restart renumbers the sim's laps from 1, so a held lap can never be
      // judged against the trace again — let it go with what it has.
      const flushed = this.flush();
      this.reset(input);
      this.prevLaps = laps;
      this.dirty.add('partial');
      return flushed;
    }

    if (laps === this.prevLaps) return this.settle(input, nowMs);

    // A jump of more than one means we missed a lap boundary entirely (the feed
    // dropped, or the app was asleep). Credit nothing: the one thing worse than
    // missing a lap from someone's weekly total is inventing laps they might not
    // have driven, and `lastLapTime` only describes the most recent one anyway.
    const stepped = laps - this.prevLaps;
    this.prevLaps = laps;
    if (stepped !== 1) {
      const flushed = this.flush();
      this.startLap(input);
      this.dirty.add('partial');
      return flushed;
    }

    // The lap is finished but not yet judged: its own cuts may still be sitting
    // in the sim's log buffer. Hold it, keep watching, and let `settle()` emit
    // it once the stewards have had their say. Anything still held from an
    // earlier lap goes out now, so laps are written in the order they were
    // driven — only reachable on a lap shorter than the hold, which the
    // plausibility floor already calls not-a-lap.
    const flushed = this.flush();
    this.held = { record: this.build(input, nowMs), lapNo: this.lapNo, until: nowMs + VERDICT_HOLD_MS };
    this.startLap(input);
    return flushed;
  }

  /**
   * Emit a held lap once its verdict can no longer change, folding in any cut
   * the sim charged to it while it waited.
   *
   * This is the whole point of holding. LMU writes its track-limits ruling to a
   * log it flushes a block at a time, so a cut taken on the last corner of a lap
   * routinely surfaces ~25 s into the NEXT one. Judging at the line therefore
   * got it wrong twice: the lap that cut was written clean, and the following
   * lap — often the driver's answer to the mistake, and their best of the run —
   * was voided for it. Waiting costs nothing a driver can perceive (the lap is
   * on disk before they reach the next corner) and buys the right answer.
   */
  private settle(input: LapInput, nowMs: number): LapRecord | null {
    const held = this.held;
    if (!held) return null;
    if (chargedTo(input.chargedLaps, held.lapNo)) held.record = withLimits(held.record);
    if (nowMs < held.until) return null;
    this.held = null;
    return held.record;
  }

  /** Hand back a held lap unjudged, for the cases where waiting is pointless. */
  private flush(): LapRecord | null {
    const held = this.held;
    this.held = null;
    return held ? held.record : null;
  }

  /** Fold this poll's state into the current lap's fault set. */
  private observe(input: LapInput): void {
    if (input.inPit) this.dirty.add('pit');
    // `this.lapNo` is deliberately NOT refreshed here — it is set once, at the
    // line, by `startLap`. The provider derives it from the completed-lap
    // count, so on the poll that crosses the line it has ALREADY become the
    // next lap's number; adopting it here would stamp the lap being finished
    // with its successor's number and charge every cut to the wrong lap — the
    // exact fault this whole mechanism exists to remove.
    // Named laps first: when the sim has told us WHICH lap it charged, that
    // answer is exact and the running count adds nothing. The count is only
    // consulted when no lap numbers are available at all — rF2, the simulator
    // provider, or LMU with no readable trace — where "a cut happened during
    // this lap" remains the best that can be said.
    if (input.chargedLaps && input.chargedLaps.length > 0) {
      if (chargedTo(input.chargedLaps, this.lapNo)) this.dirty.add('limits');
    } else if (
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
      v: 4,
      id: crypto.randomUUID(),
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
      ...sectorSplits(input.sector1Sec, input.sector2Sec, lapMs),
      ...(input.setupFp ? { setupFp: input.setupFp } : {}),
    };
  }

  /** Begin a fresh lap, re-baselining the counters we watch for movement. */
  private startLap(input: LapInput): void {
    this.dirty = new Set();
    this.limitsAtStart = input.limitWarnings;
    this.penaltiesAtStart = input.penalties;
    // The number the sim will charge this lap under. Read at the line rather
    // than carried forward, so a provider that renumbers (or starts publishing
    // one mid-stint) is followed rather than argued with.
    this.lapNo = typeof input.currentLapNo === 'number' ? input.currentLapNo : UNKNOWN_VALUE;
    // The car is usually still ON the line when this runs, but if it is in the
    // pit lane the new lap is already compromised.
    if (input.inPit) this.dirty.add('pit');
  }

  /** Full reset — new stint, or a rewound lap count. */
  private reset(input: LapInput): void {
    this.prevLaps = -1;
    this.held = null;
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
  /**
   * The best lap's {@link LapRecord.id}, when it has one — the key to its local
   * trace file, which is what the trace uploader sends up beside the time.
   * Absent for a best set before v3 records existed, in which case there is no
   * trace to send and the board entry simply has nothing to teach yet.
   */
  lapId?: string;
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

/**
 * Best clean lap for a track+class DRIVEN ON one specific setup — the
 * attribution query behind "verified pace" on a community setup card. Matches
 * the fingerprint stamped on each v4 lap against the setup's own; laps from
 * before stamping existed can never match, which is the honest outcome.
 * Track matches the way main's library join does: sim display name,
 * case-insensitively.
 */
export function bestOnSetup(
  trackName: string,
  carClass: string,
  setupFp: string,
  dir = lapDir(),
): { lapMs: number; setAt: string } | null {
  if (!setupFp) return null;
  const track = String(trackName || '').trim().toLowerCase();
  const cls = String(carClass || '').trim().toUpperCase();
  if (!track || !cls) return null;
  let best: { lapMs: number; setAt: string } | null = null;
  for (const day of listDays(dir)) {
    for (const rec of readDay(day, dir)) {
      if (!rec.clean || rec.setupFp !== setupFp) continue;
      if ((rec.track || '').toLowerCase() !== track) continue;
      if ((rec.carClass || '').toUpperCase() !== cls) continue;
      if (!best || rec.lapMs < best.lapMs) best = { lapMs: rec.lapMs, setAt: rec.at };
    }
  }
  return best;
}

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
          ...(rec.id ? { lapId: rec.id } : {}),
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
  /**
   * `sim|trackKey|class` → the lap time (ms) whose TRACE was last dealt with —
   * either accepted by the server or found to have no local file, both of which
   * mean "nothing more to do for this best". A faster lap changes the time and
   * so re-arms the entry; see `traceSettled`/`markTraceSettled`.
   */
  traces: Record<string, number>;
  /** Keys the server permanently refused, with its reason. */
  rejected: Record<string, string>;
}

export function emptySyncCache(): SyncCache {
  return { activity: {}, bests: {}, traces: {}, rejected: {} };
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

/**
 * Whether this best's trace still needs sending.
 *
 * True only when the row names a lap id (older laps have no trace at all) and
 * the cache has not settled a trace for this exact lap time. Keyed by time, not
 * lap id, deliberately: the server only keeps the trace of the CURRENT board
 * lap, so what matters is whether the trace for *this time* was dealt with —
 * and a re-driven identical time changes nothing worth re-sending.
 */
export function traceNeedsSend(row: PendingBest, cache: SyncCache): boolean {
  if (!row.lapId) return false;
  return (cache.traces || {})[bestKey(row)] !== row.lapMs;
}

/** Record that this best's trace needs no further attention (sent, or no file). */
export function markTraceSettled(cache: SyncCache, row: PendingBest): void {
  if (!cache.traces) cache.traces = {};
  cache.traces[bestKey(row)] = row.lapMs;
}
