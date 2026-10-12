/**
 * telemetry/teammateRelay.ts — a teammate's own telemetry, on OUR overlays.
 * -----------------------------------------------------------------------------
 * While a teammate drives our car, this PC is a spectator: LMU publishes gear,
 * revs and pedals for the watched car, but no tyres at all, and damage only
 * for the car driven here (see docs/TEAM-ENGINEER-PAGE.md and the probe notes
 * in `readSpectatedCar`). So the tyre and damage widgets went to "—" for the
 * whole of every stint we were not driving.
 *
 * The teammate's own app already has all of it, and already publishes it to
 * the team relay once a second (electron/team-cloud.js). Main reads that relay
 * and hands the newest rows to the server; this module splices the matching
 * row's tyres, damage and fuel into the frame the overlays receive, in place
 * of the blanks.
 *
 * ## The rules, and why each one exists
 *   • **Only on OUR car, while LMU says a teammate is driving it.** The watched
 *     row must carry `teammateDriving` (the LMU provider's `trackTeamStint`:
 *     our entry, nobody here in it, the sim saying a teammate is). It used to
 *     be "the watched row is not `isOwn`", which is also true of every stranger
 *     the camera lands on and of any frame where the player flag blinks.
 *   • **Same session.** The relayed row's track and session type must equal
 *     ours, and its server name too whenever both sides publish one. Empty
 *     track/type on either side fails closed. THE-34 (2026-10): Micky drove
 *     the race car while Scott lapped a PRACTICE server at the same circuit in
 *     the same car — same number, class and track, so both rows matched and
 *     the overlays flipped between them.
 *   • **Same car, same driver.** Car number and class must match (both
 *     required), and the relayed row's driver must be the one LMU's own
 *     scoring has in our car right now. Only one human can be in it, so only
 *     one teammate's row can ever pass.
 *   • **Never our own row.** The reader's own relay row is skipped by user id.
 *   • **Fresh or not at all.** The relay is ~1–2 s behind by design. Anything
 *     older than {@link RELAY_MAX_AGE_SEC} is dropped and the widgets go back
 *     to "—": a frozen "no damage" is a lie a driver would act on.
 *   • **Sticky.** {@link TeammateRelayGate} keeps the source it locked onto
 *     while that source still passes, and rides out up to
 *     {@link RELAY_GATE_HOLD_MS} of a missing `teammateDriving` flag (still
 *     requiring every identity check), so one bad frame neither blanks the
 *     widgets nor flips sources. Being in the car ourselves ends it at once.
 *   • **Overridable.** The driver can pin one teammate (still subject to every
 *     check above — a pinned teammate in another session shows nothing, with a
 *     status saying so) or switch the relay off. See {@link RelayMode}.
 *   • **Marked.** `player.relayed` names whose data it is and how old, so the
 *     widgets can say so, and so the relay publisher never re-publishes a
 *     teammate's data as this machine's own (team-cloud's eligibleToPublish).
 *
 * Speed, gear, pedals and everything else stay local — they are live for the
 * spectated car already, and a second-old copy would be strictly worse.
 *
 * Pure — no IO, no clock — so scripts/test-teammate-relay.js can drive it.
 */

import {
  UNKNOWN_VALUE,
  type DamageState,
  type FuelState,
  type RepairSelection,
  type TelemetryFrame,
  type TyreSet,
  type TyreState,
} from './types';
import type { DamageGrade } from './raceLogTypes';
import { damageGrade } from './damage';

/** Older than this and the relayed block is dropped rather than shown. */
export const RELAY_MAX_AGE_SEC = 6;

/**
 * How long a locked source survives the watched row LOSING its
 * `teammateDriving` flag, provided every identity check still passes. Covers a
 * REST poll that comes back without `GetGameState`; a real change (we got in,
 * the camera moved to another car, the driver swapped) fails an identity check
 * and ends the relay immediately regardless.
 */
export const RELAY_GATE_HOLD_MS = 1500;

/**
 * Where the overlays' relayed data may come from — the driver's choice in
 * Settings ▸ Application ▸ Relay source:
 *   • `auto` — whichever teammate passes the gate (the default);
 *   • `pin`  — only {@link TeammateRelay.pinUserId}, and still only when they
 *              pass the gate (in our session, driving our car);
 *   • `off`  — never.
 */
export type RelayMode = 'auto' | 'pin' | 'off';

/** One teammate's relay row, as main hands it over. */
export interface RelaySource {
  userId?: string;
  /** Display name on the team roster. */
  name?: string;
  /** Row age reported by the server at read time. */
  ageSec: number;
  /** The relayed payload — electron/team-snapshot.js's shape. */
  snapshot: any;
}

/** The newest read, stamped with when main received it. */
export interface TeammateRelay {
  /** Wall-clock ms when main received this read. */
  receivedAt: number;
  sources: RelaySource[];
  /** The signed-in user at THIS PC — their own row is never a source. */
  selfUserId?: string;
  /** Source selection; absent means `auto`. */
  mode?: RelayMode;
  /** With `mode: 'pin'`, the only teammate whose row may be used. */
  pinUserId?: string;
  /** The pinned teammate's roster name, for the status line. */
  pinName?: string;
}

/**
 * What the gate decided on the latest frame, worded for the Settings status
 * line next to the Relay source picker.
 *   • `showing`        — relayed data is on the overlays (`driverName` set);
 *   • `idle`           — nothing to relay: we are driving, or no teammate has
 *                        our car;
 *   • `none`           — a teammate has our car but no row passes the gate;
 *   • `no-data`        — the pinned teammate is not sending anything fresh;
 *   • `not-in-session` — the pinned teammate's row is from another session;
 *   • `not-driving`    — the pinned teammate is in our session, not in our car;
 *   • `off`            — the driver switched the relay off.
 */
export interface RelayStatus {
  state: 'showing' | 'idle' | 'none' | 'no-data' | 'not-in-session' | 'not-driving' | 'off';
  text: string;
  driverName?: string;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const known = (v: unknown): v is number => num(v) && v !== UNKNOWN_VALUE;

function norm(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

/** A relayed corner back to a TyreState; missing channels become unknown. */
function tyreFrom(t: any): TyreState {
  const out: TyreState = {
    tempC: known(t?.tempC) ? t.tempC : UNKNOWN_VALUE,
    wear: known(t?.wear) ? t.wear : UNKNOWN_VALUE,
  };
  if (known(t?.surfaceTempC)) out.surfaceTempC = t.surfaceTempC;
  if (known(t?.coreC)) out.coreC = t.coreC;
  if (known(t?.innerC) && known(t?.middleC) && known(t?.outerC)) {
    out.innerC = t.innerC;
    out.middleC = t.middleC;
    out.outerC = t.outerC;
  }
  if (known(t?.surfaceInnerC) && known(t?.surfaceMiddleC) && known(t?.surfaceOuterC)) {
    out.surfaceInnerC = t.surfaceInnerC;
    out.surfaceMiddleC = t.surfaceMiddleC;
    out.surfaceOuterC = t.surfaceOuterC;
  }
  if (known(t?.optimalTempC)) out.optimalTempC = t.optimalTempC;
  if (known(t?.pressureKpa)) out.pressureKpa = t.pressureKpa;
  if (known(t?.brakeTempC)) out.brakeTempC = t.brakeTempC;
  if (typeof t?.compound === 'string' && t.compound) out.compound = t.compound;
  return out;
}

function tyresFrom(t: any): TyreSet | null {
  if (!t || !t.frontLeft || !t.frontRight || !t.rearLeft || !t.rearRight) return null;
  return {
    frontLeft: tyreFrom(t.frontLeft),
    frontRight: tyreFrom(t.frontRight),
    rearLeft: tyreFrom(t.rearLeft),
    rearRight: tyreFrom(t.rearRight),
  };
}

const SELECTIONS: RepairSelection[] = ['none', 'body', 'all', 'unavailable'];

function quad(v: unknown, fallback: number): [number, number, number, number] {
  const a = Array.isArray(v) ? v : [];
  return [0, 1, 2, 3].map((i) => (num(a[i]) ? a[i] : fallback)) as [number, number, number, number];
}

/**
 * A relayed damage block back to a full DamageState. An older teammate app
 * relays only the headline fields; the repair-menu ones then read unknown,
 * which the widget already renders as "—" / "N/A" rather than as zeros.
 */
function damageFrom(d: any): DamageState | null {
  if (!d || typeof d !== 'object' || !num(d.aero)) return null;
  const n = (v: unknown): number => (num(v) ? v : UNKNOWN_VALUE);
  const suspension = quad(d.suspension, 0);
  return {
    aero: d.aero,
    suspension,
    brakeThicknessMm: quad(d.brakeThicknessMm, UNKNOWN_VALUE),
    partsDetached: n(d.partsDetached),
    worst: num(d.worst) ? d.worst : Math.max(d.aero, ...suspension),
    hasDamage: d.hasDamage === true,
    // Graded here, not trusted off the wire: an older teammate app sends none,
    // and the widget must colour a relayed car on this build's cut-offs.
    grades: {
      aero: damageGrade(d.aero),
      suspension: suspension.map(damageGrade) as [DamageGrade, DamageGrade, DamageGrade, DamageGrade],
    },
    repairSeconds: n(d.repairSeconds),
    repairBodySeconds: n(d.repairBodySeconds),
    repairSelection: SELECTIONS.includes(d.repairSelection) ? d.repairSelection : 'unavailable',
    repairOptions: Array.isArray(d.repairOptions)
      ? d.repairOptions.filter((o: unknown) => typeof o === 'string')
      : [],
    tyreChangeSeconds: n(d.tyreChangeSeconds),
    tyreCornersSelected: num(d.tyreCornersSelected) ? d.tyreCornersSelected : 0,
    stopLengthSeconds: n(d.stopLengthSeconds),
    randomDelayMaxSeconds: n(d.randomDelayMaxSeconds),
  };
}

/** A driver name as both ends of the wire can agree on it: LMU's `#1234`
 *  uniqueness suffix stripped, whitespace collapsed, case folded. */
function normDriver(v: unknown): string {
  return String(v ?? '')
    .replace(/#\d+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Why a relayed row is or is not the car being watched:
 *   • `session` — another circuit, session type or server, or either side has
 *                 no track/type to compare (fails closed);
 *   • `car`     — another car number or class, or either side has none;
 *   • `driver`  — our car, but LMU has somebody else at the wheel;
 *   • `ok`      — this is our car, in our session, with this driver in it.
 */
type RowVerdict = 'ok' | 'session' | 'car' | 'driver';

function rowVerdict(snapshot: any, focus: any, session: any): RowVerdict {
  const car = snapshot && snapshot.car;
  const theirs = (snapshot && snapshot.session) || {};
  const ours = session || {};
  // Session identity. Track and type are REQUIRED on both sides: a row that
  // cannot say which session it came from is never assumed to be ours.
  const hereTrack = norm(ours.track);
  const thereTrack = norm(theirs.track);
  const hereType = norm(ours.type);
  const thereType = norm(theirs.type);
  if (!hereTrack || !thereTrack || hereTrack !== thereTrack) return 'session';
  if (!hereType || !thereType || hereType !== thereType) return 'session';
  // The server name tells two servers at the same circuit apart. Compared
  // whenever BOTH ends publish one; a teammate on an app that predates it
  // still has to pass every other check, including the driver below.
  const hereServer = norm(ours.serverName);
  const thereServer = norm(theirs.serverName);
  if (hereServer && thereServer && hereServer !== thereServer) return 'session';
  // The entry. Car numbers repeat across classes in a multiclass field.
  if (!car || !focus) return 'car';
  const number = norm(car.carNumber);
  if (!number || number !== norm(focus.carNumber)) return 'car';
  const a = norm(car.carClass);
  const b = norm(focus.carClass);
  if (!a || !b || a !== b) return 'car';
  // And the human in it: the relayed driver must be the one LMU's own scoring
  // has in our car right now. One seat, so at most one teammate can pass.
  const relayedDriver = normDriver(car.driverName);
  const inOurCar = normDriver(focus.driverName);
  if (!relayedDriver || !inOurCar || relayedDriver !== inOurCar) return 'driver';
  return 'ok';
}

/** The watched row, or undefined. */
function focusRow(frame: TelemetryFrame): any {
  return Array.isArray(frame.standings) ? frame.standings.find((r) => r && r.isPlayer) : undefined;
}

/** First name for a status line — "Scott isn't in your session". */
function firstName(name: unknown): string {
  return String(name ?? '').trim().split(/\s+/)[0] || 'That teammate';
}

/** Lock state carried between frames by {@link TeammateRelayGate}. */
interface GateLock {
  /** Key of the source the overlays are showing, or null. */
  key: string | null;
  /** When the watched row last carried `teammateDriving` with a hit. */
  lastGateAt: number;
}

const keyOf = (s: RelaySource): string => String(s.userId || s.name || '');

const STATUS_IDLE_DRIVING: RelayStatus = {
  state: 'idle',
  text: 'You are in the car — your own telemetry is used.',
};
const STATUS_IDLE_WAITING: RelayStatus = {
  state: 'idle',
  text: 'Waiting for a teammate to drive your car.',
};

/**
 * The whole decision for one frame: which row (if any) goes on the overlays,
 * and the status line that explains it. `lock` carries the hysteresis between
 * frames; pass a fresh one for a stateless answer.
 */
function decide(
  frame: TelemetryFrame,
  relay: TeammateRelay | null,
  nowMs: number,
  lock: GateLock,
): { hit: { source: RelaySource; ageSec: number } | null; status: RelayStatus } {
  const drop = (status: RelayStatus) => {
    lock.key = null;
    return { hit: null, status };
  };
  const mode: RelayMode = relay && (relay.mode === 'pin' || relay.mode === 'off') ? relay.mode : 'auto';
  if (mode === 'off') {
    return drop({ state: 'off', text: "Relay off — teammates' telemetry is never put on your overlays." });
  }
  if (!relay || !Array.isArray(relay.sources) || !frame || frame.connected === false) {
    return drop(STATUS_IDLE_WAITING);
  }
  // Only LMU says which car is ours and who is in it; never guess elsewhere.
  if (frame.source !== 'lmu') return drop(STATUS_IDLE_WAITING);
  // A replay's car is a recording; a teammate's live tyres are not its tyres (THE-35).
  if (frame.session && frame.session.replay === true) return drop(STATUS_IDLE_WAITING);
  const focus = focusRow(frame);
  // In the car ourselves: local telemetry is live, never override it — and no
  // hold, the relay ends on this frame.
  if (focus && focus.isOwn === true) return drop(STATUS_IDLE_DRIVING);
  if (!focus) return drop(STATUS_IDLE_WAITING);

  const gateOn = focus.teammateDriving === true;
  const holding = !gateOn && lock.key !== null && nowMs - lock.lastGateAt <= RELAY_GATE_HOLD_MS;
  if (!gateOn && !holding) return drop(STATUS_IDLE_WAITING);

  const held = Math.max(0, (nowMs - relay.receivedAt) / 1000);
  const self = relay.selfUserId ? String(relay.selfUserId) : '';
  const fresh: { source: RelaySource; ageSec: number }[] = [];
  for (const s of relay.sources) {
    if (!s || !s.snapshot || s.snapshot.connected === false) continue;
    // Our own row is never a teammate's data.
    if (self && s.userId && String(s.userId) === self) continue;
    const ageSec = (num(s.ageSec) ? s.ageSec : Infinity) + held;
    if (!(ageSec <= RELAY_MAX_AGE_SEC)) continue;
    fresh.push({ source: s, ageSec });
  }

  let pool = fresh;
  if (mode === 'pin') {
    const pinName = firstName(relay.pinName);
    pool = fresh.filter((c) => !!relay.pinUserId && String(c.source.userId || '') === String(relay.pinUserId));
    if (!pool.length) {
      return drop({ state: 'no-data', text: `${pinName} isn't sending telemetry right now.` });
    }
    const verdicts = pool.map((c) => rowVerdict(c.source.snapshot, focus, frame.session));
    if (!verdicts.includes('ok')) {
      return drop(
        verdicts.includes('driver') || verdicts.includes('car')
          ? { state: 'not-driving', text: `${pinName} isn't driving your car.` }
          : { state: 'not-in-session', text: `${pinName} isn't in your session — nothing is relayed.` },
      );
    }
  }

  const passing = pool.filter((c) => rowVerdict(c.source.snapshot, focus, frame.session) === 'ok');
  // Riding out a missing flag: only the source already on screen may continue.
  const eligible = holding ? passing.filter((c) => keyOf(c.source) === lock.key) : passing;
  if (!eligible.length) {
    return drop({
      state: 'none',
      text: 'A teammate has your car, but nobody in your session is relaying it.',
    });
  }
  // Stay on the locked source while it passes; otherwise the freshest.
  let hit = eligible.find((c) => keyOf(c.source) === lock.key) || null;
  if (!hit) {
    for (const c of eligible) if (!hit || c.ageSec < hit.ageSec) hit = c;
  }
  if (!hit) return drop(STATUS_IDLE_WAITING);
  lock.key = keyOf(hit.source);
  if (gateOn) lock.lastGateAt = nowMs;
  const who = String(hit.source.name || (hit.source.snapshot.car && hit.source.snapshot.car.driverName) || 'teammate');
  return {
    hit,
    status: { state: 'showing', text: `Showing ${who}'s telemetry on your overlays.`, driverName: who },
  };
}

/**
 * Pick the relay row that describes the car being watched, or null — the
 * stateless form of the gate (no hysteresis). Exported for the tests;
 * {@link TeammateRelayGate} is what the frame loop uses.
 */
export function matchRelaySource(
  frame: TelemetryFrame,
  relay: TeammateRelay | null,
  nowMs: number,
): { source: RelaySource; ageSec: number } | null {
  return decide(frame, relay, nowMs, { key: null, lastGateAt: -Infinity }).hit;
}

/** The status line for one frame, stateless. Exported for the tests. */
export function relayStatus(frame: TelemetryFrame, relay: TeammateRelay | null, nowMs: number): RelayStatus {
  return decide(frame, relay, nowMs, { key: null, lastGateAt: -Infinity }).status;
}

/** Splice a matched row's tyres, damage and fuel into a copy of the frame. */
function splice(frame: TelemetryFrame, hit: { source: RelaySource; ageSec: number } | null): TelemetryFrame {
  if (!hit) return frame;
  const snap = hit.source.snapshot;
  const tyres = tyresFrom(snap.car.tyres);
  const damage = damageFrom(snap.car.damage);
  const fuel: FuelState | null =
    snap.fuel && typeof snap.fuel === 'object' ? (snap.fuel as FuelState) : null;
  if (!tyres && !damage && !fuel) return frame;

  const player = { ...frame.player };
  if (tyres) player.tyres = tyres;
  if (damage) player.damage = damage;
  player.relayed = {
    driverName: String(hit.source.name || snap.car.driverName || 'teammate'),
    ageSec: Math.round(hit.ageSec * 10) / 10,
  };
  return { ...frame, player, ...(fuel ? { fuel } : {}) };
}

/**
 * The frame with the watched teammate's tyres, damage and fuel spliced in, or
 * the frame untouched when nothing passes the gate. Stateless; never mutates
 * its input.
 */
export function applyTeammateRelay(
  frame: TelemetryFrame,
  relay: TeammateRelay | null,
  nowMs: number,
): TelemetryFrame {
  return splice(frame, matchRelaySource(frame, relay, nowMs));
}

/**
 * The gate with memory, one per overlay server: sticks to the source it is
 * showing and rides out a single dropped `teammateDriving` flag (see
 * {@link RELAY_GATE_HOLD_MS}), and keeps the latest {@link RelayStatus} for
 * the Settings status line.
 */
export class TeammateRelayGate {
  private lock: GateLock = { key: null, lastGateAt: -Infinity };
  private last: RelayStatus = STATUS_IDLE_WAITING;

  apply(frame: TelemetryFrame, relay: TeammateRelay | null, nowMs: number): TelemetryFrame {
    const { hit, status } = decide(frame, relay, nowMs, this.lock);
    this.last = status;
    return splice(frame, hit);
  }

  /** What the gate decided on the latest frame. */
  status(): RelayStatus {
    return this.last;
  }

  reset(): void {
    this.lock = { key: null, lastGateAt: -Infinity };
    this.last = STATUS_IDLE_WAITING;
  }
}
