/**
 * @file src/telemetry/iracing/raceResults.ts
 * @module telemetry/iracing/raceResults
 *
 * The iRacing race log's **results half**: a small JSON copy of the race's
 * classification, kept on disk while the race runs and after it ends.
 *
 * ## Why a copy at all
 * iRacing writes **no local results file** (scratchpad plan-iracing-local.md:
 * "final classifications exist only in the YAML and on iRacing's web/Data
 * API"). The Data API is off-limits (no new OAuth clients; its terms ban
 * commercial use without consent), so the only local record of who finished
 * where is the session-info YAML's `ResultsPositions`, which is gone the moment
 * the driver leaves the session. This keeps the latest one.
 *
 * The other half — laps, positions at the line, pit stops, flags, incident
 * steps as they happened — is the generic live recorder
 * (`raceLogRecorder.ts`), which already runs on iRacing frames. The two are
 * joined at read time by `irRaceLog.ts`.
 *
 * ## What the YAML says, and when (captures CAP-2/4/5)
 *   • `ResultsPositions[]`: Position (1-based), ClassPosition (0-based, made
 *     1-based by sessionInfo.ts), LapsComplete, FastestTime, LapsLed,
 *     ReasonOutId/Str (`Running`, `DQ`, …).
 *   • `Incidents` reads **0 for everyone, us included, while the race is live**
 *     (`ResultsOfficial: 0`). Real counts appear once the session is official.
 *     So the field's incidents are kept only from an official copy, and ours
 *     come from telemetry (`PlayerCarMyIncidentCount`, the team count in a team
 *     event) throughout.
 *   • `QualifyResultsInfo` is the qualifying order: the grid, as near as the
 *     YAML says it (a heat or a penalty can still move a car).
 *
 * ## Cost
 * Rebuilt only when the parsed session info object changes (≤ 1/s, see
 * SessionInfoCache), the session state moves or our incident count moves —
 * never per frame. Written async, at most every {@link WRITE_EVERY_MS} unless
 * the chequered flag or the official result has just arrived. Nothing here
 * blocks the frame loop.
 *
 * ## File
 * `~/.apex-overlay/racelog/iracing/<id>.json`, `id` = `ir-<SubSessionID>-<SessionNum>`
 * (or `ir-local-<start s>-<SessionNum>` offline). Local only; never uploaded.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeClassFor } from '../carClass';
import type { TelemetryFrame } from '../types';
import type { IrsdkFrame } from './irsdk';
import type { IrSessionInfo } from './sessionInfo';

/** One car in the copy. Positions 1-based; `null` when the YAML has none yet. */
export interface IrRaceCar {
  carIdx: number;
  carNumber: string;
  carClass: string;
  car: string;
  /** The driver in it now. */
  driver: string;
  /** Every name seen driving it, in order (a team event's swaps). */
  drivers: string[];
  team: string;
  gridPosition: number | null;
  gridClassPosition: number | null;
  position: number | null;
  classPosition: number | null;
  laps: number;
  lapsLed: number;
  bestLapMs: number | null;
  /** Only from an official copy (see the module note); `null` until then. */
  incidents: number | null;
  /** `Finished`, `Running` (no flag yet), or iRacing's own `ReasonOutStr` (`DQ`, `Disconnected`…). */
  status: string;
  reasonOutId: number;
}

export interface IrRaceSnapshot {
  v: 1;
  sim: 'iracing';
  id: string;
  subSessionId: number;
  sessionNum: number;
  /** The frame's `session.track`, which the live recorder's header carries too. */
  track: string;
  trackLengthM: number;
  /** Wall ms at SessionTime 0: the live header's `sessionStartMs`. */
  sessionStartMs: number;
  updatedAt: number;
  official: boolean;
  teamRacing: boolean;
  ownCarIdx: number;
  incidentLimit: number;
  /** Our car's incident points from telemetry (team count in a team event); null when never read. */
  ourIncidents: number | null;
  resultsOfficial: boolean;
  /** The chequered flag has been shown (SessionState ≥ Checkered). */
  checkered: boolean;
  multiclass: boolean;
  scheduledLaps: number;
  scheduledSec: number;
  cars: IrRaceCar[];
}

/** What the provider hands over from telemetry for one frame. */
export interface IrRaceTele {
  sessionNum: number;
  /** `SessionTime`, seconds. */
  sessionTimeSec: number;
  /** `SessionState`. */
  sessionState: number;
  /** The frame's `session.track`. */
  track: string;
  /** `PlayerCarMyIncidentCount` / `PlayerCarTeamIncidentCount` (team events); NaN when absent. */
  ourIncidents: number;
  /** A replay is playing: nothing is recorded. */
  replay: boolean;
}

/** The telemetry half of {@link IrRaceTele}, read off one SDK row and the frame built from it. */
export function raceTeleOf(f: IrsdkFrame, info: IrSessionInfo, frame: TelemetryFrame): IrRaceTele {
  const n = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  const team = info.teamRacing ? f.num('PlayerCarTeamIncidentCount') : NaN;
  const mine = f.num('PlayerCarMyIncidentCount');
  return {
    sessionNum: n(f.num('SessionNum'), info.currentSessionNum),
    sessionTimeSec: n(f.num('SessionTime'), 0),
    sessionState: n(f.num('SessionState'), 0),
    track: frame.session.track,
    ourIncidents: Number.isFinite(team) && team >= 0 ? team : mine,
    replay: frame.session.replay === true || f.bool('IsReplayPlaying'),
  };
}

/** `SessionState` value of the chequered flag. */
const SS_CHECKERED = 5;
/** At most one write this often while nothing decisive changes, ms. */
export const WRITE_EVERY_MS = 15_000;

/** `~/.apex-overlay/racelog/iracing`. */
export function irRaceResultsDir(): string {
  return path.join(os.homedir(), '.apex-overlay', 'racelog', 'iracing');
}

/** The race session the frame is in, or undefined (practice, qualifying, none). */
function raceSession(info: IrSessionInfo, sessionNum: number) {
  const s = info.sessions.find((x) => x.num === sessionNum);
  return s && /race/i.test(s.type) ? s : undefined;
}

/** The copy's id. Exported for the test. */
export function raceIdOf(info: IrSessionInfo, sessionNum: number, sessionStartMs: number): string {
  return info.subSessionId > 0
    ? `ir-${info.subSessionId}-${sessionNum}`
    : `ir-local-${Math.round(sessionStartMs / 1000)}-${sessionNum}`;
}

/**
 * The copy for this frame, or null when this is not a race we are entered in.
 * `prev` (the same race's last copy) carries the drivers seen and the start
 * time forward. Pure.
 */
export function buildRaceSnapshot(
  info: IrSessionInfo,
  tele: IrRaceTele,
  prev: IrRaceSnapshot | null,
  nowMs: number,
): IrRaceSnapshot | null {
  const session = raceSession(info, tele.sessionNum);
  if (!session) return null;
  const entrants = info.drivers.filter(
    (d) => d.carIdx >= 0 && d.carIdx < 64 && !d.isSpectator && !d.isPaceCar && d.carIdx !== info.paceCarIdx,
  );
  const own = info.driverCarIdx;
  if (!entrants.some((d) => d.carIdx === own)) return null; // a spectator: no car of ours
  const startMs =
    prev?.sessionStartMs ??
    Math.round(nowMs - (Number.isFinite(tele.sessionTimeSec) ? tele.sessionTimeSec : 0) * 1000);
  const id = raceIdOf(info, tele.sessionNum, startMs);
  const same = prev && prev.id === id ? prev : null;
  const checkered = (same?.checkered ?? false) || tele.sessionState >= SS_CHECKERED;
  const official = session.resultsOfficial;
  const results = new Map(session.results.map((r) => [r.carIdx, r]));
  const grid = new Map(info.qualifyResults.map((q) => [q.carIdx, q]));
  const before = new Map((same?.cars ?? []).map((c) => [c.carIdx, c]));
  const classes = new Set<string>();

  const cars: IrRaceCar[] = entrants.map((d) => {
    const r = results.get(d.carIdx);
    const q = grid.get(d.carIdx);
    const was = before.get(d.carIdx);
    const drivers = was ? was.drivers.slice() : [];
    if (d.userName && !drivers.includes(d.userName)) drivers.push(d.userName);
    const carClass = normalizeClassFor('iracing', d.carClassShortName) || d.carClassShortName;
    if (carClass) classes.add(carClass);
    const out = r && r.reasonOutId !== 0;
    return {
      carIdx: d.carIdx,
      carNumber: d.carNumber,
      carClass,
      car: d.carScreenName,
      driver: d.userName,
      drivers,
      team: d.teamName,
      gridPosition: q && q.position > 0 ? q.position : null,
      gridClassPosition: q && q.classPosition > 0 ? q.classPosition : null,
      position: r && r.position > 0 ? r.position : null,
      classPosition: r && r.classPosition > 0 ? r.classPosition : null,
      laps: r ? Math.max(0, r.lapsComplete) : 0,
      lapsLed: r ? Math.max(0, r.lapsLed) : 0,
      bestLapMs: r && r.fastestTime > 0 ? Math.round(r.fastestTime * 1000) : null,
      // Live, the YAML says 0 for everyone: a 0 is not a clean race until official.
      incidents: r && official ? Math.max(0, r.incidents) : (was?.incidents ?? null),
      status: !r ? '' : out ? r.reasonOutStr || 'Out' : checkered || official ? 'Finished' : 'Running',
      reasonOutId: r ? r.reasonOutId : 0,
    };
  });
  const inc = Number.isFinite(tele.ourIncidents) && tele.ourIncidents >= 0 ? tele.ourIncidents : null;
  return {
    v: 1,
    sim: 'iracing',
    id,
    subSessionId: info.subSessionId,
    sessionNum: tele.sessionNum,
    track: tele.track,
    trackLengthM: info.trackLengthM,
    sessionStartMs: startMs,
    updatedAt: nowMs,
    official: info.official,
    teamRacing: info.teamRacing,
    ownCarIdx: own,
    incidentLimit: info.incidentLimit,
    ourIncidents: inc === null ? (same?.ourIncidents ?? null) : Math.max(inc, same?.ourIncidents ?? 0),
    resultsOfficial: official,
    checkered,
    multiclass: classes.size > 1,
    scheduledLaps: session.laps,
    scheduledSec: session.timeSec,
    cars,
  };
}

/** What changes the copy's meaning; `updatedAt` alone never forces a write. */
function signature(s: IrRaceSnapshot): string {
  const cars = s.cars.map((c) => `${c.carIdx}:${c.position}:${c.laps}:${c.status}:${c.incidents}:${c.bestLapMs}:${c.drivers.length}`);
  return `${s.id}|${s.resultsOfficial}|${s.checkered}|${s.ourIncidents}|${cars.join(',')}`;
}

/** The filesystem calls the recorder makes, injectable for the test. */
export interface RaceResultsFs {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(file: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/**
 * Keeps the copy current and on disk. One per provider. `dir` null records
 * nothing (tests, capture replays).
 */
export class IrRaceResultsRecorder {
  private snap: IrRaceSnapshot | null = null;
  private builtFrom: { info: IrSessionInfo | null; state: number; inc: number; num: number } = {
    info: null,
    state: -1,
    inc: NaN,
    num: -1,
  };
  private writtenSig = '';
  /** The signature last handed to the writer (written or on its way). */
  private queuedSig = '';
  private lastWriteAt = -Infinity;
  private writing: Promise<void> | null = null;
  private again: IrRaceSnapshot | null = null;
  private madeDir = false;
  private warned = false;
  /** Writes completed, for the test. */
  public writes = 0;

  public constructor(
    private readonly dir: string | null,
    private readonly io: RaceResultsFs = fs.promises as unknown as RaceResultsFs,
  ) {}

  /** The latest copy (tests and diagnostics). */
  public current(): IrRaceSnapshot | null {
    return this.snap;
  }

  /** Feed one frame's worth. Cheap unless the session info or state moved. */
  public update(info: IrSessionInfo, tele: IrRaceTele, nowMs: number): void {
    if (!this.dir) return;
    if (tele.replay) return;
    const b = this.builtFrom;
    const inc = Number.isFinite(tele.ourIncidents) ? tele.ourIncidents : NaN;
    const moved =
      b.info !== info ||
      b.num !== tele.sessionNum ||
      (b.state >= SS_CHECKERED) !== (tele.sessionState >= SS_CHECKERED) ||
      !(inc === b.inc || (Number.isNaN(inc) && Number.isNaN(b.inc)));
    if (!moved) return;
    this.builtFrom = { info, state: tele.sessionState, inc, num: tele.sessionNum };
    const next = buildRaceSnapshot(info, tele, this.snap, nowMs);
    if (!next) {
      this.flushLast();
      this.snap = null;
      return;
    }
    if (this.snap && this.snap.id !== next.id) this.flushLast();
    const urgent =
      !this.snap ||
      this.snap.id !== next.id ||
      next.resultsOfficial !== this.snap.resultsOfficial ||
      next.checkered !== this.snap.checkered;
    this.snap = next;
    if (urgent || nowMs - this.lastWriteAt >= WRITE_EVERY_MS) this.write(next, nowMs);
  }

  /** Write whatever has not been written. Resolves when it is on disk (or failed). */
  public async flush(): Promise<void> {
    this.flushLast();
    while (this.writing) await this.writing;
  }

  private flushLast(): void {
    if (this.snap && signature(this.snap) !== this.queuedSig) this.write(this.snap, this.snap.updatedAt);
  }

  private write(s: IrRaceSnapshot, nowMs: number): void {
    const sig = signature(s);
    if (sig === this.queuedSig) return;
    this.queuedSig = sig;
    this.lastWriteAt = nowMs;
    if (this.writing) {
      this.again = s; // the newest wins; written when the current one lands
      return;
    }
    this.writing = this.drain(s);
  }

  private async drain(first: IrRaceSnapshot): Promise<void> {
    let s: IrRaceSnapshot | null = first;
    while (s) {
      const sig = signature(s);
      try {
        const dir = this.dir as string;
        if (!this.madeDir) {
          await this.io.mkdir(dir, { recursive: true });
          this.madeDir = true;
        }
        const file = path.join(dir, `${s.id}.json`);
        await this.io.writeFile(`${file}.tmp`, JSON.stringify(s));
        await this.io.rename(`${file}.tmp`, file);
        this.writtenSig = sig;
        this.writes++;
      } catch (err) {
        if (!this.warned) console.error('[racelog] iRacing results copy failed:', (err as Error).message);
        this.warned = true;
        // Not on disk: the next change (or flush) tries again.
        if (this.queuedSig === sig) this.queuedSig = this.writtenSig;
      }
      s = this.again;
      this.again = null;
    }
    this.writing = null;
  }
}
