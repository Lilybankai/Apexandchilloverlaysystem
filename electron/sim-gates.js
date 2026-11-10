/**
 * electron/sim-gates.js — which sim a feature may act on, in one place.
 * -----------------------------------------------------------------------------
 * Pure (no Electron, no IO), so scripts/test-sim-gates.js can hold every rule
 * here to the same answer the app gives. main.js and team-cloud.js call these
 * instead of each writing its own `source === 'lmu'`.
 *
 *   • Reference pace (Ohne Speed's sheet) is LMU lap times on LMU layouts. An
 *     iRacing session whose circuit name and length happen to match an LMU
 *     layout must never get an LMU pace card (inventory finding 4).
 *   • The team relay runs on the sims whose provider can say which car is ours
 *     and who is in it: LMU (trackTeamStint) and, since 2026-11-10, iRacing
 *     (telemetry/iracing/teamIdentity.ts). The publish end and the read end
 *     use the same list, so they can never disagree again (finding 3: iRacing
 *     cars published while the overlay end was LMU-gated).
 */

'use strict';

/** Sims whose frames carry `isOwn` / `teammateDriving` the relay can trust. */
const RELAY_SIMS = Object.freeze(['lmu', 'iracing']);

/** Whether frames from this `source` take part in the team relay at all. */
function relaySim(source) {
  return RELAY_SIMS.includes(source);
}

/**
 * Whether a reviewed session may be scored against the LMU reference sheet.
 * A lap log row with no `sim` predates the field and is LMU's.
 */
function scoresReferencePace(session) {
  if (!session) return false;
  const sim = typeof session.sim === 'string' && session.sim ? session.sim : 'lmu';
  return sim === 'lmu';
}

/**
 * Watching OUR car while a teammate drives it: the one case the overlays ask
 * the relay for the driving PC's tyres, damage and fuel. The row must carry
 * the provider's `teammateDriving` (our entry, somebody else at the wheel) —
 * never just "the watched row is not isOwn", which is every stranger the
 * camera lands on (THE-34). The relayed rows are gated again, per frame, in
 * telemetry/teammateRelay.ts.
 */
function watchingAnotherCar(frame) {
  if (!frame || frame.connected === false || !relaySim(frame.source)) return false;
  // A replay's car is a recording — no teammate's live relay belongs on it.
  if (frame.session && frame.session.replay === true) return false;
  if (!Array.isArray(frame.standings)) return false;
  const focus = frame.standings.find((row) => row && row.isPlayer);
  return !!focus && focus.isOwn !== true && focus.teammateDriving === true;
}

/**
 * The watched row is the car driven on THIS PC — the publish side's identity
 * check. The relay payload's car (number, class, DRIVER) comes off the watched
 * row, so a PC parked with the camera on a teammate would otherwise publish
 * its own car's data under the teammate's name. Frames from a sim outside
 * {@link RELAY_SIMS} never publish.
 */
function drivingHere(frame) {
  if (!frame || !relaySim(frame.source) || !Array.isArray(frame.standings)) return false;
  const focus = frame.standings.find((r) => r && r.isPlayer);
  return !!focus && focus.isOwn === true && focus.teammateDriving !== true;
}

module.exports = { RELAY_SIMS, relaySim, scoresReferencePace, watchingAnotherCar, drivingHere };
