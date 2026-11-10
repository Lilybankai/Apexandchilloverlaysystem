/**
 * @file src/telemetry/iracing/teamIdentity.ts
 * @module telemetry/iracing/teamIdentity
 *
 * Which iRacing car is OURS, and whether WE are the one driving it — the two
 * facts the team relay is gated on (`StandingEntry.isOwn` and
 * `StandingEntry.teammateDriving`, see telemetry/teammateRelay.ts and
 * electron/sim-gates.js).
 *
 * ## ⚠ Untested on a real team race
 * Written 2026-11-10 from the irsdk documentation and the solo captures only.
 * No team-event capture exists yet (scratchpad plan-iracing-local.md, "needs a
 * team race"). Every rule below fails CLOSED — when anything is missing or
 * disagrees, nobody is "a teammate driving", so the relay shows nothing rather
 * than a stranger's tyres. Verify against a capture of a real team race before
 * relying on it, and correct this note with what was seen.
 *
 * ## What iRacing says, per the SDK docs
 *   • `WeekendInfo.TeamRacing: 1` in a team event, 0 otherwise.
 *   • `DriverInfo.DriverCarIdx` is the car of the member at THIS PC — in a
 *     team event, the TEAM's car, whoever is in it. `PlayerCarIdx` agrees.
 *   • `DriverInfo.DriverUserID` is the member at this PC.
 *   • `Drivers[].UserID` / `UserName` are the CURRENT driver of each car; they
 *     change at a driver swap. `TeamID` / `TeamName` stay with the car.
 *   • `IsOnTrack` (telemetry) is true only while THIS member is in the car on
 *     track.
 *
 * ## The rules
 *   1. Not a team event → the car at `DriverCarIdx` is ours and we drive it
 *      (today's behaviour; solo captures pass through unchanged).
 *   2. Team event, `IsOnTrack` → we are in the car: ours, driving.
 *   3. Team event, the car's current `UserID` is ours → ours, driving (in the
 *      garage / pits between stints).
 *   4. Team event, the car's current `UserID` is known, non-zero and NOT ours,
 *      and our own `DriverUserID` is known → a teammate has it.
 *   5. Anything else (no row, a zero id, our id unknown) → neither: not driven
 *      here (so nothing publishes) and no teammate (so nothing is relayed).
 *
 * The session-info YAML lags a swap by up to its refresh period, so for a few
 * seconds after a swap rule 4 still names the previous driver. The relay's
 * driver-name check then fails (the relayed row names the new driver), which
 * is the closed direction.
 */

import type { IrSessionInfo } from './sessionInfo';

export interface IrTeamStint {
  /** The car index that is ours (the team car in a team event), or -1. */
  carIdx: number;
  /** A team event (`WeekendInfo.TeamRacing`). */
  teamRacing: boolean;
  /** We are the car's driver right now: the car may carry `isOwn`. */
  drivingHere: boolean;
  /** A teammate is at the wheel of our car: the car carries `teammateDriving`. */
  teammateDriving: boolean;
}

/**
 * Decide {@link IrTeamStint} for one frame. `ownIdx` is the provider's own-car
 * index (`PlayerCarIdx`, else `DriverCarIdx`); `isOnTrack` is telemetry
 * `IsOnTrack`. Pure.
 */
export function irTeamStint(info: IrSessionInfo, ownIdx: number, isOnTrack: boolean): IrTeamStint {
  const carIdx = Number.isInteger(ownIdx) && ownIdx >= 0 ? ownIdx : -1;
  if (!info.teamRacing) {
    return { carIdx, teamRacing: false, drivingHere: carIdx >= 0, teammateDriving: false };
  }
  const closed: IrTeamStint = { carIdx, teamRacing: true, drivingHere: false, teammateDriving: false };
  if (carIdx < 0) return closed;
  if (isOnTrack) return { ...closed, drivingHere: true };
  const row = info.drivers.find((d) => d.carIdx === carIdx);
  const self = info.driverUserId > 0 ? info.driverUserId : 0;
  const current = row && row.userId > 0 ? row.userId : 0;
  if (!row || !self || !current) return closed;
  if (current === self) return { ...closed, drivingHere: true };
  return { ...closed, teammateDriving: true };
}

/**
 * A sim-issued id for THIS session, for the relay's same-session check:
 * `ir-<SubSessionID>-<SessionNum>`. Two servers at the same circuit, or
 * practice and race of one event, never share it. Undefined when iRacing
 * publishes no subsession (offline testing, where there is no team to relay).
 */
export function irSessionId(info: IrSessionInfo, sessionNum: number): string | undefined {
  if (!(info.subSessionId > 0) || !Number.isInteger(sessionNum) || sessionNum < 0) return undefined;
  return `ir-${info.subSessionId}-${sessionNum}`;
}
