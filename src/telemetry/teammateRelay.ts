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
 *   • **Only for the watched car, and only when it is not ours to drive.** The
 *     focus row (`isPlayer`) must not also be `isOwn`: when we are in the car,
 *     our local telemetry is live and a second-old relay would be a downgrade.
 *   • **Matched by car number, class and circuit** — the entry's identity,
 *     which is stable across driver swaps. Slot ids are not compared: they are
 *     the server's, and a rejoin can move them.
 *   • **Fresh or not at all.** The relay is ~1–2 s behind by design. Anything
 *     older than {@link RELAY_MAX_AGE_SEC} is dropped and the widgets go back
 *     to "—": a frozen "no damage" is a lie a driver would act on.
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

/** Older than this and the relayed block is dropped rather than shown. */
export const RELAY_MAX_AGE_SEC = 6;

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

/** Is this relayed snapshot the entry the camera is on? */
function sameCar(snapshot: any, focus: any, track: unknown): boolean {
  const car = snapshot && snapshot.car;
  if (!car || !focus) return false;
  const number = norm(car.carNumber);
  if (!number || number !== norm(focus.carNumber)) return false;
  // Car numbers repeat across classes in a multiclass field.
  const a = norm(car.carClass);
  const b = norm(focus.carClass);
  if (a && b && a !== b) return false;
  // And a fresh row from a teammate at another circuit is not this car.
  const here = norm(track);
  const there = norm(snapshot.session && snapshot.session.track);
  if (here && there && here !== there) return false;
  return true;
}

/**
 * Pick the relay row that describes the car being watched, or null.
 * Exported for the tests; {@link applyTeammateRelay} is the entry point.
 */
export function matchRelaySource(
  frame: TelemetryFrame,
  relay: TeammateRelay | null,
  nowMs: number,
): { source: RelaySource; ageSec: number } | null {
  if (!relay || !Array.isArray(relay.sources) || !frame || frame.connected === false) return null;
  // Only LMU marks which row is the car driven here (`isOwn`); without that
  // there is no telling a spectated car from our own, so never guess.
  if (frame.source !== 'lmu') return null;
  const focus = Array.isArray(frame.standings) ? frame.standings.find((r) => r && r.isPlayer) : undefined;
  // Our own car with us in it: local telemetry is live, never override it.
  if (!focus || focus.isOwn === true) return null;
  const held = Math.max(0, (nowMs - relay.receivedAt) / 1000);
  let best: { source: RelaySource; ageSec: number } | null = null;
  for (const s of relay.sources) {
    if (!s || !s.snapshot || s.snapshot.connected === false) continue;
    const ageSec = (num(s.ageSec) ? s.ageSec : Infinity) + held;
    if (!(ageSec <= RELAY_MAX_AGE_SEC)) continue;
    if (!sameCar(s.snapshot, focus, frame.session && frame.session.track)) continue;
    if (!best || ageSec < best.ageSec) best = { source: s, ageSec };
  }
  return best;
}

/**
 * The frame with the watched teammate's tyres, damage and fuel spliced in, or
 * the frame untouched when there is nothing fresh that matches. Never mutates
 * its input.
 */
export function applyTeammateRelay(
  frame: TelemetryFrame,
  relay: TeammateRelay | null,
  nowMs: number,
): TelemetryFrame {
  const hit = matchRelaySource(frame, relay, nowMs);
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
