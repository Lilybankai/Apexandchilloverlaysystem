/**
 * @file src/telemetry/raceLogRecorder.ts
 * @module telemetry/raceLogRecorder
 *
 * The race log's **live recorder**: phase 2 of `docs/RACE-LOG-PLAN.md`. It
 * writes down, as it happens, what the results XML never will (flags, our
 * graded damage) and a crash-proof copy of what it will (laps, positions,
 * contacts, limits, penalties). The XML is written once, ~80 s after the flag,
 * and a game crash means no XML at all; this file is then the only record.
 *
 * ## Lossless, unlike the engineer
 * The edges are the engineer's own ({@link flagEdges} in `triggers.ts`), but
 * none of its gates: no cooldown, no coalescing, no global interval, no lap-1
 * or pit-cycle silence. A radio call is rationed; a log line is not.
 *
 * ## Whose car
 * RACE sessions only, following OUR car: the provider's team-car slot (which
 * survives a driver swap), else the row LMU flags `isOwn`. Never `isPlayer`,
 * which follows the camera. Damage is the PC's own car by construction (the
 * repair screen 404s for anyone else's). Who we are is learnt afresh each race:
 * a slot or a team-mate carried over from the last one is a rival's car at the
 * next track.
 *
 * ## Not in a replay
 * A replay the game is playing looks like a race to every endpoint the frame
 * is built from (live 2026-09-30: `sessionInfo` RACE1, `GSTATE_DYN`, the
 * replay's cars in `/rest/watch/standings`), and each backward seek rewinds
 * `et`, which would open a new race. Only `/navigation/state`'s `settingMode`
 * (`SETTING_REPLAY_PLAYBACK`) tells it apart, so the provider hands that over
 * with our identity ({@link RaceIdentity.replay}) and nothing is recorded
 * while it says so, or before it has said anything at all.
 *
 * ## The clock
 * Every line carries session `et` (`session.elapsedSec`, LMU `currentEventTime`)
 * and wall time. `et` is the XML's clock and the replay's, so a live event
 * lines up with both; wall time is only for pairing and file names.
 *
 * ## Cost
 * Outside a race: two compares a frame. In a race: the shared flag compares,
 * one standings scan for our row, and a damage compare only when the repair
 * screen's object changes (every 3 s); ~0.75 µs a frame replaying a real race,
 * a third of the engineer's. All IO is async appends ({@link LiveRaceLog});
 * nothing here blocks the loop.
 *
 * ## File
 * `~/.apex-overlay/racelog/live-<UTC day>.jsonl`: a `header` line per race (and
 * again on a new day, or when our slot becomes known), then one `event` line
 * per event, each carrying the header's `key`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UNKNOWN_VALUE, isPreGreen } from './types';
import type { SessionPhase, StandingEntry, TelemetryFrame, TelemetrySource } from './types';
import type { DamageGrade, RaceLogDetail, RaceLogKind } from './raceLogTypes';
import { flagEdges, yellowSectorLevel, type FlagLevels } from './triggers';
import { findYellowCause } from './yellowCause';
import { damageZones, gradeWorse, overallGrade } from './damage';
import { dayStamp } from './lapLog';

/* -------------------------------------------------------------------------- */
/*  File shapes                                                                */
/* -------------------------------------------------------------------------- */

/** One race's opening line. Repeated (same `key`) when a field fills in. */
export interface LiveHeader {
  t: 'header';
  v: 1;
  /** `track|race|<session start, unix s>`. Not `sessionKeyOf`, which moves on MP joins. */
  key: string;
  track: string;
  sessionType: 'race';
  source: TelemetrySource;
  /** Wall ms at session `et` 0 (first frame's wall minus its `et`); the first frame's wall without `et`. */
  sessionStartMs: number;
  /** Wall ms and `et` of the first frame recorded. */
  firstAt: number;
  firstEt: number | null;
  /** The phase we arrived in; anything past pre-green means we joined late. */
  firstPhase: string;
  /** Our car's slot (the XML's `Name(n)`), when known. */
  slot: number | null;
  carNumber?: string;
  carClass?: string;
  driver?: string;
  multiclass: boolean;
}

/** One event line. `raceS` is not stored: it is derived from the green flag at read time. */
export interface LiveEvent {
  t: 'event';
  key: string;
  /** Wall ms. */
  at: number;
  /** Session-elapsed seconds, or `null` when the source publishes no clock. */
  et: number | null;
  lap: number;
  kind: RaceLogKind;
  text: string;
  detail?: RaceLogDetail;
}

export type LiveLine = LiveHeader | LiveEvent;

/** Our car, as the provider knows it. `names` are normalised (see {@link normName}). */
export interface RaceIdentity {
  slot: number | null;
  names: string[];
  /**
   * The game is playing a replay (`settingMode` `SETTING_REPLAY_PLAYBACK`):
   * nothing on screen is ours to record. `null` until the provider has read it,
   * which holds a race's first line back; absent from a source that cannot know.
   */
  replay?: boolean | null;
}

/** LMU decorates some names with a `#1234` discriminator; the XML and the incident list may not. */
export function normName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/#\d+\s*$/, '').trim().toLowerCase() : '';
}

/* -------------------------------------------------------------------------- */
/*  The recorder (pure: frames in, lines out)                                  */
/* -------------------------------------------------------------------------- */

const NONE: readonly LiveLine[] = Object.freeze([]);

/** How long a lap edge waits for its lap time to land, ms (REST can lag a poll). */
const LAP_TIME_WAIT_MS = 3000;
/** How often the provider is asked who we are, ms. */
const IDENTITY_EVERY_MS = 1000;
/** `et` running backwards by more than this is a new session (a restart), s. */
const ET_REWIND_S = 5;
/** How long a pre-green phase must hold after the green to mean a restarted session, ms. */
const REGRID_MS = 3000;
/** A first damage reading this soon after joining a race late was already on the car, ms. */
const LATE_DAMAGE_MS = 10_000;
/** A clean car: the damage baseline for a race recorded from the grid. */
const CLEAN: DamageBase = { grade: 'none', zones: [] };
/** …and never within this of a race's first frame, ms. */
const REGRID_GRACE_MS = 10_000;
/** Two reports of one contact (each car files its own) land within this, s. */
const CONTACT_SAME_S = 1;

/** What LMU names scenery as, and how the log says it. */
const SCENERY: Readonly<Record<string, string>> = {
  immovable: 'the wall',
  sign: 'a sign',
  cone: 'a cone',
  post: 'a post',
};

interface DamageBase {
  grade: DamageGrade;
  zones: string[];
}

export class RaceLogRecorder {
  private readonly identityOf: (() => RaceIdentity | null) | null;

  // ---- the race we are in ----
  private header: LiveHeader | null = null;
  private lastEt: number | null = null;
  private lastEtAt = 0;
  private identityAt = -Infinity;
  private names: ReadonlySet<string> = new Set();
  private slot: number | null = null;
  private standings: readonly StandingEntry[] = [];
  /** Whether the game is playing a replay, `null` not yet known (see {@link RaceIdentity.replay}). */
  private replay: boolean | null = false;
  /** The previous race ended by a restart in this run, so the next one starts at its first `et`. */
  private restarted = false;
  /**
   * Incident rows before this `et` belong to an earlier session: LMU need not
   * clear its list on a restart. `null` for a race joined mid-way, whose
   * earlier contacts are real.
   */
  private startEt: number | null = null;
  private startEtPending = false;

  // ---- last tick's levels ----
  private flags: FlagLevels = freshFlags();
  private greenEt: number | null = null;
  private chequeredOut = false;
  private finishedLogged = false;
  private rowSlot: number | null = null;
  private laps = -1;
  private lastLapSec: number = UNKNOWN_VALUE;
  private linePos: number = UNKNOWN_VALUE;
  private lineClassPos: number = UNKNOWN_VALUE;
  private inPit: boolean | null = null;
  private driver = '';
  private retired = false;
  private pendingLap: { lap: number; at: number; et: number | null; prevLapSec: number } | null = null;
  /** `et` at each lap end, so a late event (a contact) can be put on its lap. */
  private lapEnds: number[] = [];
  private damageRef: object | null = null;
  private damage: DamageBase | null = null;
  private points: number = UNKNOWN_VALUE;
  private penalties: number = UNKNOWN_VALUE;
  private contacts: { a: string; b: string; et: number }[] = [];
  private regridSince: number | null = null;

  public constructor(opts: { identity?: () => RaceIdentity | null } = {}) {
    this.identityOf = opts.identity ?? null;
  }

  /** Whether a race is being recorded, for the incident poll to key on. */
  public inRace(): boolean {
    return this.header !== null;
  }

  /**
   * Advance by one frame. Returns the lines to append: almost always none,
   * and allocates nothing but a small sector array when nothing happened.
   */
  public update(frame: TelemetryFrame, nowMs: number = frame.timestamp): readonly LiveLine[] {
    if (!frame.connected) return NONE; // demo data, or the sim between reconnects
    const s = frame.session;
    if (s.type !== 'race') {
      if (this.header) this.end();
      this.restarted = false;
      return NONE;
    }
    const et = typeof s.elapsedSec === 'number' && s.elapsedSec > 0 ? s.elapsedSec : null;
    // Back on the grid after the green, held a moment so one odd frame cannot
    // split a race: the session was restarted. Not in a race's first seconds:
    // a restart can rewind the clock (a new race already) before the phase
    // catches up, and that is one restart, not two.
    const regrid =
      this.flags.seenGreen && isPreGreen(s.phase) && !!this.header && nowMs - this.header.firstAt > REGRID_GRACE_MS;
    if (!regrid) this.regridSince = null;
    else if (this.regridSince === null) this.regridSince = nowMs;
    if (this.header && s.track !== this.header.track) this.end(); // another track: a new race
    if (
      this.header &&
      ((et !== null && this.lastEt !== null && et < this.lastEt - ET_REWIND_S) ||
        (this.regridSince !== null && nowMs - this.regridSince >= REGRID_MS))
    ) {
      this.end(); // a rewound clock, or back to the grid: the session restarted
      this.restarted = true;
    }
    if (et !== null) {
      this.lastEt = et;
      this.lastEtAt = nowMs;
    }
    this.standings = frame.standings;
    this.refreshIdentity(frame, nowMs);
    if (this.replay !== false) {
      // A replay, or not yet known whether it is: nothing here is a race of ours.
      if (this.header) this.end();
      this.restarted = false;
      return NONE;
    }
    if (this.startEtPending && et !== null) {
      this.startEt = et;
      this.startEtPending = false;
    }

    if (!this.header) return this.begin(frame, nowMs, et);

    this.tickNow = nowMs;
    this.tickOut = null;
    const emit = this.emit;
    this.detectFlags(frame, nowMs, emit);
    const row = this.ourRow(frame);
    if (row) this.detectRow(row, nowMs, emit);
    this.detectDamage(frame, emit, nowMs);
    this.detectStewards(frame, emit);

    // Our slot arrived after the header was written (teams load on a 10 s timer).
    if (this.slot !== null && this.header.slot === null) {
      this.header = { ...this.header, slot: this.slot, ...carOf(row) };
      (this.tickOut ??= []).push(this.header);
    }
    const out = this.tickOut;
    this.tickOut = null;
    return out ?? NONE;
  }

  /** This tick's clock and lines, for {@link emit}: one closure for the recorder's life, not one a frame. */
  private tickNow = 0;
  private tickOut: LiveLine[] | null = null;
  private readonly emit: Emit = (kind, text, detail, stamp) => {
    const now = this.tickNow;
    const ev = stamp
      ? this.event(stamp.at, stamp.et, kind, text, detail, stamp.lap)
      : this.event(now, this.etAt(now), kind, text, detail);
    (this.tickOut ??= []).push(ev);
  };

  /**
   * Feed `getIncidentsList`'s rows (`[{player, contactWith, et}]`, the whole
   * field). Keeps ours: either side named one of our drivers. Each car files
   * its own report, so a pair within {@link CONTACT_SAME_S} is one contact.
   */
  public noteIncidents(rows: unknown, nowMs: number): readonly LiveLine[] {
    if (!this.header || !Array.isArray(rows) || this.names.size === 0) return NONE;
    let out: LiveLine[] | null = null;
    const nowEt = this.etAt(nowMs);
    for (const r of rows as { player?: unknown; contactWith?: unknown; et?: unknown }[]) {
      const et = typeof r?.et === 'number' && Number.isFinite(r.et) ? Math.round(r.et * 100) / 100 : null;
      if (et === null) continue;
      if (nowEt !== null && et > nowEt + ET_REWIND_S) continue; // not this session's
      if (this.startEt !== null && et < this.startEt) continue; // the session before a restart
      const a = normName(r.player);
      const b = normName(r.contactWith);
      const usA = this.names.has(a);
      const usB = this.names.has(b);
      if (!usA && !usB) continue;
      const [x, y] = a < b ? [a, b] : [b, a];
      if (this.contacts.some((c) => c.a === x && c.b === y && Math.abs(c.et - et) < CONTACT_SAME_S)) continue;
      this.contacts.push({ a: x, b: y, et });
      const other = usA ? r.contactWith : r.player;
      const at = nowEt !== null ? Math.round(nowMs - (nowEt - et) * 1000) : nowMs;
      const { text, detail } = this.contactWords(typeof other === 'string' ? other : '');
      (out ??= []).push(this.event(at, et, 'contact', text, detail));
    }
    return out ?? NONE;
  }

  /* ---- detection ---------------------------------------------------------- */

  private detectFlags(frame: TelemetryFrame, nowMs: number, emit: Emit): void {
    for (const e of flagEdges(this.flags, frame)) {
      switch (e.kind) {
        case 'raceStart': {
          const row = this.ourRow(frame);
          this.greenEt = this.etAt(nowMs);
          this.flags.seenGreen = true; // so the start line itself is on lap 1
          const grid = row ? (row.gridPosition ?? row.position) : UNKNOWN_VALUE;
          const cls = row?.classPosition ?? UNKNOWN_VALUE;
          this.linePos = grid;
          this.lineClassPos = cls;
          emit(
            'start',
            known(grid) ? `Green flag. Started ${this.where(grid, cls, row)}` : 'Green flag',
            known(grid) ? { position: grid, ...(known(cls) ? { classPosition: cls } : {}) } : undefined,
          );
          break;
        }
        case 'restart':
          emit('flag', 'Restart: racing resumes');
          break;
        case 'redFlag':
          emit('flag', 'Red flag');
          break;
        case 'fullCourseYellow':
          emit('flag', 'Full-course yellow');
          break;
        case 'sectorYellow': {
          // All three at once is REST's one flag copied three times, not three incidents.
          const all = e.lit.length === 3;
          const cause =
            findYellowCause(frame, all ? [] : e.fresh) ?? (all ? null : findYellowCause(frame, e.lit));
          const where = all ? 'Yellow flags out' : `Yellow flag in S${e.fresh.join(', S')}`;
          emit('flag', cause ? `${where} (${cause.name})` : where);
          break;
        }
        case 'sectorClear':
          emit('flag', 'Yellow flags cleared');
          break;
        case 'finalLap':
          emit('flag', 'Chequered flag out: final lap');
          break;
        case 'checkered':
          break; // the engineer's is the CAMERA car's; ours is the next line crossing (detectRow)
      }
    }
    this.storeFlags(frame);
  }

  private detectRow(row: StandingEntry, nowMs: number, emit: Emit): void {
    if (row.slotId !== this.rowSlot) {
      // A new car to follow (first sight, or identity changed): levels, no events.
      this.rowSlot = row.slotId;
      this.laps = row.lapsCompleted;
      this.lastLapSec = row.lastLapSec;
      this.inPit = row.inPit;
      this.driver = row.driverName;
      this.retired = row.retired === true;
      if (!known(this.linePos)) {
        this.linePos = row.position;
        this.lineClassPos = row.classPosition ?? UNKNOWN_VALUE;
      }
      return;
    }

    // A lap time can land a poll after the lap count; hold the lap briefly.
    const p = this.pendingLap;
    if (p && (row.lastLapSec !== p.prevLapSec || nowMs - p.at >= LAP_TIME_WAIT_MS)) {
      const moved = row.lastLapSec !== p.prevLapSec;
      const stamp = { at: p.at, et: p.et, lap: p.lap };
      if (moved && known(row.lastLapSec) && row.lastLapSec > 0) {
        const ms = Math.round(row.lastLapSec * 1000);
        emit('lap', `Lap ${p.lap}  ${lapTime(row.lastLapSec)}`, { lapMs: ms }, stamp);
      } else if (!known(row.lastLapSec) || row.lastLapSec <= 0) {
        // LMU publishes -1 for a lap it did not count (a cut, a lap-1 start).
        emit('lap', `Lap ${p.lap}  no time`, { invalid: true }, stamp);
      } else {
        emit('lap', `Lap ${p.lap}`, undefined, stamp); // a time that never moved: unknown
      }
      this.pendingLap = null;
    }

    if (row.lapsCompleted > this.laps && this.laps >= 0) {
      const et = this.etAt(nowMs);
      if (et !== null) this.lapEnds.push(et);
      const q = this.pendingLap;
      if (q) {
        // Two crossings inside the wait: the first never got its time.
        emit('lap', `Lap ${q.lap}`, undefined, { at: q.at, et: q.et, lap: q.lap });
      }
      this.pendingLap = { lap: row.lapsCompleted, at: nowMs, et, prevLapSec: this.lastLapSec };
      // Stamped with the lap just completed, like the XML's lap-end rows.
      const crossing = { at: nowMs, et, lap: row.lapsCompleted };
      this.lineCrossed(row, emit, crossing);
      if (this.chequeredOut && !this.finishedLogged) {
        this.finishedLogged = true;
        emit(
          'finish',
          `Chequered flag. Finished ${this.where(row.position, row.classPosition, row)}, ${row.lapsCompleted} laps`,
          {
            position: row.position,
            ...(known(row.classPosition) ? { classPosition: row.classPosition } : {}),
            status: 'Finished',
          },
          crossing,
        );
      }
    }
    this.laps = row.lapsCompleted;
    this.lastLapSec = row.lastLapSec;

    if (this.inPit !== null && row.inPit !== this.inPit) {
      emit('pit', row.inPit ? 'Pit in' : 'Pit out', row.inPit ? { pitIn: true } : undefined);
    }
    this.inPit = row.inPit;

    if (row.driverName && this.driver && row.driverName !== this.driver) {
      emit('driver', `Driver change: ${row.driverName} takes over from ${this.driver}`);
    }
    if (row.driverName) this.driver = row.driverName;

    if (row.retired === true && !this.retired && !this.finishedLogged) {
      this.finishedLogged = true;
      const where = known(row.position) ? `, P${row.position}` : '';
      emit('finish', `Retired${where}`, { ...(known(row.position) ? { position: row.position } : {}), status: 'DNF' });
    }
    this.retired = row.retired === true;
  }

  /** Places gained or lost since the last line crossing (the grid, on lap 1). */
  private lineCrossed(row: StandingEntry, emit: Emit, crossing: Stamp): void {
    const pos = row.position;
    const cls = row.classPosition ?? UNKNOWN_VALUE;
    if (known(this.linePos) && known(pos) && pos !== this.linePos) {
      const gained = this.linePos - pos;
      const n = Math.abs(gained);
      const text = `${gained > 0 ? 'Gained' : 'Lost'} ${n} place${n === 1 ? '' : 's'}, now ${this.where(pos, cls, row)}`;
      const detail: RaceLogDetail = {
        position: pos,
        gained,
        ...(known(cls) ? { classPosition: cls } : {}),
        ...(known(cls) && known(this.lineClassPos) ? { classGained: this.lineClassPos - cls } : {}),
      };
      emit('position', text, detail, crossing);
    }
    this.linePos = pos;
    this.lineClassPos = cls;
  }

  /**
   * A new line only when the car gets WORSE: the grade rises, or a zone that was
   * clean is now damaged. Never per 3 s poll. A repair lowers the baseline, so
   * the next hit after a stop is news again.
   */
  private detectDamage(frame: TelemetryFrame, emit: Emit, nowMs: number): void {
    const d = frame.player?.damage;
    if (!d || d === this.damageRef) return;
    this.damageRef = d;
    const grade = overallGrade(d);
    const zones = damageZones(d);
    // No reading yet: a race joined late may have damage we did not see happen
    // (say so, once); otherwise the car started clean.
    const h = this.header!;
    const arrived = !isPreGreen(h.firstPhase as SessionPhase) && nowMs - h.firstAt < LATE_DAMAGE_MS;
    const base = this.damage ?? (arrived ? null : CLEAN);
    this.damage = { grade, zones };
    if (grade === 'none') return;
    const worse = !base || gradeWorse(grade, base.grade) || zones.some((z) => !base.zones.includes(z));
    if (!worse) return;
    const parts = known(d.partsDetached) && d.partsDetached > 0 ? d.partsDetached : 0;
    const off = parts ? ` (${parts} part${parts === 1 ? '' : 's'} off)` : '';
    const late = base ? '' : ' (already on the car when recording began)';
    emit('damage', `${cap(grade)} damage: ${zones.join(', ')}${off}${late}`, { grade, zones });
  }

  /** Track-limit points and penalties, from the stewards' own numbers (our car's). */
  private detectStewards(frame: TelemetryFrame, emit: Emit): void {
    const tl = frame.player?.trackLimits;
    if (!tl) return;
    if (known(tl.points)) {
      if (known(this.points) && tl.points > this.points) {
        const limit = known(tl.pointsLimit) ? tl.pointsLimit : undefined;
        emit('limits', `Track limits: ${pts(tl.points)}${limit ? ` of ${limit}` : ''} points`, {
          warningPoints: tl.points,
          ...(limit ? { pointsLimit: limit } : {}),
        });
      }
      this.points = tl.points;
    }
    if (known(tl.penalties)) {
      if (known(this.penalties) && tl.penalties > this.penalties) {
        const kind = tl.penaltyType || undefined;
        emit('penalty', kind ? `Penalty: ${kind}` : 'Penalty issued', kind ? { penaltyKind: kind } : undefined);
      } else if (known(this.penalties) && tl.penalties < this.penalties) {
        emit('penalty', 'Penalty served');
      }
      this.penalties = tl.penalties;
    }
  }

  /* ---- plumbing ----------------------------------------------------------- */

  private begin(frame: TelemetryFrame, nowMs: number, et: number | null): readonly LiveLine[] {
    const s = frame.session;
    const startMs = et !== null ? Math.round(nowMs - et * 1000) : nowMs;
    const row = this.ourRow(frame);
    const classes = new Set<string>();
    for (const e of frame.standings) if (e.carClass) classes.add(e.carClass);
    this.header = {
      t: 'header',
      v: 1,
      key: `${s.track}|race|${Math.round(startMs / 1000)}`,
      track: s.track,
      sessionType: 'race',
      source: frame.source,
      sessionStartMs: startMs,
      firstAt: nowMs,
      firstEt: et,
      firstPhase: s.phase,
      slot: this.slot,
      ...carOf(row),
      multiclass: classes.size > 1,
    };
    // From the grid, or straight after a restart, the race began on this frame,
    // so an incident row stamped earlier is the last session's. Joined mid-way,
    // earlier rows are this race's own and there is no floor.
    const fromStart = isPreGreen(s.phase) || this.restarted;
    this.restarted = false;
    this.startEt = fromStart ? et : null;
    this.startEtPending = fromStart && et === null;
    // Prime every level from the frame we arrive on: an edge needs a before.
    this.storeFlags(frame);
    this.chequeredOut = s.finalLap === true;
    if (row) this.detectRow(row, nowMs, () => undefined);
    // Damage is NOT primed here: detectDamage decides whether a first reading
    // is news or was already on the car when a race was joined late.
    const tl = frame.player?.trackLimits;
    if (tl) {
      this.points = tl.points;
      this.penalties = tl.penalties;
    }
    return [this.header];
  }

  /** Forget the race. The next race frame writes a new header. */
  private end(): void {
    this.header = null;
    this.lastEt = null;
    this.flags = freshFlags();
    this.greenEt = null;
    this.chequeredOut = false;
    this.finishedLogged = false;
    this.rowSlot = null;
    this.laps = -1;
    this.lastLapSec = UNKNOWN_VALUE;
    this.linePos = UNKNOWN_VALUE;
    this.lineClassPos = UNKNOWN_VALUE;
    this.inPit = null;
    this.driver = '';
    this.retired = false;
    this.pendingLap = null;
    this.lapEnds = [];
    this.damageRef = null;
    this.damage = null;
    this.points = UNKNOWN_VALUE;
    this.penalties = UNKNOWN_VALUE;
    this.contacts = [];
    this.identityAt = -Infinity;
    this.regridSince = null;
    this.startEt = null;
    this.startEtPending = false;
    // Who we were is per race: the last race's slot is a rival's car at the
    // next track, and its team-mates' contacts are not ours there.
    this.names = new Set();
    this.slot = null;
    this.standings = [];
  }

  private storeFlags(frame: TelemetryFrame): void {
    const s = frame.session;
    const f = this.flags;
    if (s.phase === 'green' || (f.notStarted && !s.notStarted)) f.seenGreen = true;
    f.phase = s.phase;
    f.flag = s.flag;
    f.notStarted = s.notStarted === true;
    f.yellowSectors = yellowSectorLevel(frame);
    f.finalLap = s.finalLap === true;
    f.finished = frame.player?.finished === true;
    if (f.finalLap) this.chequeredOut = true;
  }

  private refreshIdentity(frame: TelemetryFrame, nowMs: number): void {
    if (nowMs - this.identityAt < IDENTITY_EVERY_MS) return;
    this.identityAt = nowMs;
    const id = this.identityOf ? this.identityOf() : null;
    this.replay = id?.replay === undefined ? false : id.replay;
    const own = frame.standings.find((e) => e.isOwn === true);
    const slot = id?.slot ?? own?.slotId ?? this.slot;
    const names = new Set<string>(id?.names ?? []);
    const ownName = normName(own?.driverName);
    if (ownName) names.add(ownName);
    for (const n of this.names) names.add(n); // a swap never forgets a teammate
    // No slot from the provider or the sim: the row one of our drivers is in.
    const byName = slot == null && names.size > 0
      ? frame.standings.find((e) => names.has(normName(e.driverName)))
      : undefined;
    this.slot = slot ?? byName?.slotId ?? null;
    this.names = names;
  }

  private ourRow(frame: TelemetryFrame): StandingEntry | undefined {
    const slot = this.slot;
    if (slot === null) return undefined;
    for (const e of frame.standings) if (e.slotId === slot) return e;
    return undefined;
  }

  /** Session `et` now: the frame's, or extrapolated a few seconds from the last one. */
  private etAt(nowMs: number): number | null {
    if (this.lastEt === null) return null;
    const dt = (nowMs - this.lastEtAt) / 1000;
    return dt >= 0 && dt < 10 ? Math.round((this.lastEt + dt) * 10) / 10 : this.lastEt;
  }

  private lapAt(et: number | null): number {
    if (!this.flags.seenGreen) return 0; // on the grid, or the formation lap
    if (et === null) return this.laps >= 0 ? this.laps + 1 : 0;
    if (this.greenEt !== null && et < this.greenEt) return 0;
    let n = 0;
    for (const end of this.lapEnds) if (end <= et) n++;
    // Lap ends from before we attached are not in the list: offset by what we missed.
    const missed = this.laps >= 0 ? Math.max(0, this.laps - this.lapEnds.length) : 0;
    return n + missed + 1;
  }

  private event(
    at: number,
    et: number | null,
    kind: RaceLogKind,
    text: string,
    detail?: RaceLogDetail,
    lap?: number,
  ): LiveEvent {
    return {
      t: 'event',
      key: this.header!.key,
      at,
      et,
      lap: lap ?? this.lapAt(et),
      kind,
      text,
      ...(detail ? { detail } : {}),
    };
  }

  /** `P9 (P3 in GT3)` in a multiclass field, `P9` otherwise. */
  private where(pos: number, cls: number | undefined, row: StandingEntry | undefined): string {
    const multi = this.header?.multiclass === true;
    return multi && known(cls) && row?.carClass ? `P${pos} (P${cls} in ${row.carClass})` : `P${pos}`;
  }

  private contactWords(other: string): { text: string; detail: RaceLogDetail } {
    if (!other.trim()) return { text: 'Contact', detail: {} };
    const scenery = SCENERY[other.trim().toLowerCase()];
    if (scenery) return { text: `Contact with ${scenery}`, detail: { scenery: other.trim() } };
    const who = normName(other);
    const row = this.standings.find((e) => normName(e.driverName) === who);
    const num = row?.carNumber;
    return {
      text: `Contact with ${other}${num ? ` (#${num})` : ''}`,
      detail: { otherName: other, ...(num ? { otherNumber: num } : {}), ...(row ? { otherSlot: row.slotId } : {}) },
    };
  }
}

/** When an event happened, if not now: a lap line is stamped at its crossing. */
interface Stamp {
  at: number;
  et: number | null;
  lap: number;
}

type Emit = (kind: RaceLogKind, text: string, detail?: RaceLogDetail, stamp?: Stamp) => void;

function freshFlags(): FlagLevels {
  return {
    phase: 'unknown',
    flag: '',
    notStarted: true,
    seenGreen: false,
    yellowSectors: null,
    finalLap: false,
    finished: false,
  };
}

function carOf(row: StandingEntry | undefined): Pick<LiveHeader, 'carNumber' | 'carClass' | 'driver'> {
  if (!row) return {};
  return {
    ...(row.carNumber ? { carNumber: row.carNumber } : {}),
    ...(row.carClass ? { carClass: row.carClass } : {}),
    ...(row.driverName ? { driver: row.driverName } : {}),
  };
}

function known(n: number | undefined | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n !== UNKNOWN_VALUE;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Quarter-point multiples, printed without trailing zeros: `2`, `1.25`. */
function pts(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** `1:52.671`. */
export function lapTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/* -------------------------------------------------------------------------- */
/*  Storage: async appends only                                                */
/* -------------------------------------------------------------------------- */

/** `~/.apex-overlay/racelog`, beside the lap log: the server writes it, with or without Electron. */
export function raceLogDir(): string {
  return path.join(os.homedir(), '.apex-overlay', 'racelog');
}

/** The live file for a wall time's UTC day. */
export function liveFileFor(ms: number, dir = raceLogDir()): string {
  return path.join(dir, `live-${dayStamp(ms)}.jsonl`);
}

/** The two calls the writer makes, injectable so a failing disk can be tested. */
export interface LiveLogFs {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  appendFile(file: string, text: string, encoding: 'utf8'): Promise<void>;
}

/** After a failed append, try again this much later, ms (an AV scan holding a new file lets go in seconds). */
const RETRY_MS = 5000;
/**
 * Unwritten text kept per file while the disk refuses it, chars. A 4 h race
 * logs ~1,500 lines of ~200 chars, so this holds a whole one; past it the
 * oldest is dropped rather than the overlay's memory.
 */
const MAX_PENDING_CHARS = 512 * 1024;

/**
 * Appends lines with `fs.promises` only, one write in flight, so a slow disk
 * or an AV scan costs the loop nothing (see the 2026-08-27 stall fixes). Each
 * day's file opens with the race's header, so a file is readable on its own.
 *
 * A failed append keeps its text (header included) and retries it, bounded:
 * dropping it would lose the header, and {@link parseLiveLog} throws away every
 * later event for want of one, i.e. the rest of the race. Text past the bound
 * is dropped and the file un-marked, so the next line re-sends the header.
 */
export class LiveLogWriter {
  private readonly dir: string;
  private readonly io: LiveLogFs;
  private buffer = new Map<string, string>();
  private writing: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private madeDir = false;
  /** Header per key, and the files it has been written to. */
  private headers = new Map<string, { header: LiveHeader; files: Set<string> }>();
  private warned = false;

  public constructor(dir = raceLogDir(), io: LiveLogFs = fs.promises) {
    this.dir = dir;
    this.io = io;
  }

  public write(lines: readonly LiveLine[]): void {
    if (lines.length === 0) return;
    for (const line of lines) {
      const at = line.t === 'header' ? line.firstAt : line.at;
      const file = liveFileFor(at, this.dir);
      if (line.t === 'header') {
        const h = this.headers.get(line.key) ?? { header: line, files: new Set<string>() };
        h.header = line;
        h.files.add(file);
        this.headers.set(line.key, h);
      } else {
        const h = this.headers.get(line.key);
        if (h && !h.files.has(file)) {
          h.files.add(file); // a race across UTC midnight, or a dropped header: repeat it
          this.append(file, h.header);
        }
      }
      this.append(file, line);
    }
    // While a retry is waiting, new lines join it rather than hammering a held file.
    if (!this.writing && !this.retryTimer) this.writing = this.drain();
  }

  /** Resolves once everything written so far is on disk, or has failed again. */
  public async flush(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      if (!this.writing && this.buffer.size > 0) this.writing = this.drain();
    }
    while (this.writing) await this.writing;
  }

  /** Chars waiting to be written, for tests. */
  public pendingChars(): number {
    let n = 0;
    for (const text of this.buffer.values()) n += text.length;
    return n;
  }

  private append(file: string, line: LiveLine): void {
    this.buffer.set(file, (this.buffer.get(file) ?? '') + `${JSON.stringify(line)}\n`);
  }

  private async drain(): Promise<void> {
    try {
      while (this.buffer.size > 0) {
        const batch = this.buffer;
        this.buffer = new Map();
        const failed = new Map<string, string>();
        let error: unknown = null;
        try {
          if (!this.madeDir) {
            await this.io.mkdir(this.dir, { recursive: true });
            this.madeDir = true;
          }
        } catch (err) {
          error = err;
        }
        for (const [file, text] of batch) {
          if (error !== null && !this.madeDir) {
            failed.set(file, text);
            continue;
          }
          try {
            await this.io.appendFile(file, text, 'utf8');
          } catch (err) {
            error = err;
            failed.set(file, text);
          }
        }
        if (failed.size > 0) {
          // A log line that cannot be written is not worth taking the overlay down for.
          if (!this.warned) console.error('[racelog] write failed, will retry:', (error as Error)?.message);
          this.warned = true;
          this.requeue(failed);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.writing && this.buffer.size > 0) this.writing = this.drain();
          }, RETRY_MS);
          this.retryTimer.unref?.();
          return;
        }
      }
    } finally {
      this.writing = null;
    }
  }

  /** Put failed text back ahead of anything newer for the same file, within {@link MAX_PENDING_CHARS}. */
  private requeue(failed: Map<string, string>): void {
    for (const [file, text] of failed) {
      const all = text + (this.buffer.get(file) ?? '');
      if (all.length <= MAX_PENDING_CHARS) {
        this.buffer.set(file, all);
        continue;
      }
      // Too much held: drop it all (a line cut in half is worse than none) and
      // un-mark the file, so the next line for each race re-sends its header.
      this.buffer.delete(file);
      for (const h of this.headers.values()) h.files.delete(file);
    }
  }
}

/**
 * The recorder wired to the disk and to LMU's incident list: what the server
 * loop runs. `onFrame` is the per-frame call; the incident poll is its own
 * async timer, live only during a race.
 */
export class LiveRaceLog {
  private readonly recorder: RaceLogRecorder;
  private readonly writer: LiveLogWriter;
  private readonly fetchIncidents: (() => Promise<unknown>) | null;
  private readonly timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  public constructor(
    opts: {
      identity?: () => RaceIdentity | null;
      fetchIncidents?: () => Promise<unknown>;
      dir?: string;
      pollMs?: number;
    } = {},
  ) {
    this.recorder = new RaceLogRecorder(opts.identity ? { identity: opts.identity } : {});
    this.writer = new LiveLogWriter(opts.dir);
    this.fetchIncidents = opts.fetchIncidents ?? null;
    if (this.fetchIncidents) {
      this.timer = setInterval(() => void this.pollIncidents(), opts.pollMs ?? 2000);
      this.timer.unref?.();
    }
  }

  public onFrame(frame: TelemetryFrame, nowMs: number): void {
    const lines = this.recorder.update(frame, nowMs);
    if (lines.length > 0) this.writer.write(lines);
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.writer.flush();
  }

  private async pollIncidents(): Promise<void> {
    if (this.polling || !this.fetchIncidents || !this.recorder.inRace()) return;
    this.polling = true;
    try {
      const rows = await this.fetchIncidents();
      this.writer.write(this.recorder.noteIncidents(rows, Date.now()));
    } catch {
      /* outside a session the endpoint 400s; the next tick tries again */
    } finally {
      this.polling = false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Reading it back                                                            */
/* -------------------------------------------------------------------------- */

/** One race from the live files, segments from app restarts joined. */
export interface LiveRace {
  header: LiveHeader;
  /** By `et` (wall time where `et` is missing), duplicates from restarts removed. */
  events: LiveEvent[];
  /** The green flag, when the recorder saw it. */
  greenEt: number | null;
  greenAt: number | null;
  /** Wall ms of the last line. */
  lastAt: number;
  finished: boolean;
}

/** Two headers this close in session start, same track, are one race recorded twice (an app restart), ms. */
const SAME_RACE_MS = 60_000;

/**
 * Parses live files' text (several days may be concatenated) into races.
 * Torn or foreign lines are skipped: the file is appended to live.
 */
export function parseLiveLog(text: string): LiveRace[] {
  const races: LiveRace[] = [];
  const byKey = new Map<string, LiveRace>();
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line: LiveLine;
    try {
      line = JSON.parse(raw) as LiveLine;
    } catch {
      continue;
    }
    if (line?.t === 'header' && typeof line.key === 'string') {
      let race = byKey.get(line.key);
      if (!race) {
        race =
          races.find(
            (r) =>
              r.header.track === line.track &&
              Math.abs(r.header.sessionStartMs - (line as LiveHeader).sessionStartMs) <= SAME_RACE_MS,
          ) ?? undefined;
        if (!race) {
          race = { header: line, events: [], greenEt: null, greenAt: null, lastAt: line.firstAt, finished: false };
          races.push(race);
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
    } else if (line?.t === 'event' && typeof line.key === 'string' && typeof line.text === 'string') {
      const race = byKey.get(line.key);
      if (!race) continue;
      race.events.push(line);
      race.lastAt = Math.max(race.lastAt, line.at);
    }
  }
  for (const r of races) {
    r.events = dedupe(r.events.sort(byTime));
    const green = r.events.find((e) => e.kind === 'start');
    r.greenEt = green?.et ?? null;
    r.greenAt = green?.at ?? null;
    r.finished = r.events.some((e) => e.kind === 'finish');
  }
  return races;
}

function byTime(a: LiveEvent, b: LiveEvent): number {
  if (a.et !== null && b.et !== null && a.et !== b.et) return a.et - b.et;
  return a.at - b.at;
}

/** A restart re-reads the whole incident list; the same line twice within a second is one. */
function dedupe(events: LiveEvent[]): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const e of events) {
    const dup = out.some(
      (o) =>
        o.kind === e.kind &&
        o.text === e.text &&
        (o.et !== null && e.et !== null ? Math.abs(o.et - e.et) < 1 : Math.abs(o.at - e.at) < 1000),
    );
    if (!dup) out.push(e);
  }
  return out;
}

/**
 * Every live race recorded since `sinceMs` (default: the last 14 days). Async;
 * a missing directory is an empty list, never an error.
 */
export async function loadLiveLog(opts: { dir?: string; sinceMs?: number } = {}): Promise<LiveRace[]> {
  const dir = opts.dir ?? raceLogDir();
  const since = dayStamp(opts.sinceMs ?? Date.now() - 14 * 86_400_000);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const files = names
    .filter((n) => /^live-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(5, 15) >= since)
    .sort();
  const texts: string[] = [];
  for (const f of files) {
    try {
      texts.push(await fs.promises.readFile(path.join(dir, f), 'utf8'));
    } catch {
      /* raced a rotation; skip the day */
    }
  }
  return parseLiveLog(texts.join('\n'));
}
