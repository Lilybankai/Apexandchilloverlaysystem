/**
 * test-teammate-relay.js — a teammate's relayed tyres/damage/fuel on our overlays.
 * -----------------------------------------------------------------------------
 * telemetry/teammateRelay.ts decides, once per broadcast frame, whether the car
 * the camera is on is a teammate's that the team relay has fresh data for, and
 * if so splices their tyres, damage and fuel in over this PC's blanks. The
 * rules that matter: never while we are driving the watched car, only for the
 * matching entry, never when stale, and never mutating the provider's frame.
 *
 * Also runs the real relay payload builder (electron/team-snapshot.js) into it,
 * so the two ends of the wire are checked against each other.
 *
 * Run: npm run test:teammate-relay   (needs `npm run build` first)
 */

'use strict';

const path = require('path');
const {
  applyTeammateRelay,
  matchRelaySource,
  RELAY_MAX_AGE_SEC,
} = require(path.join(__dirname, '..', 'dist', 'telemetry', 'teammateRelay.js'));
const { buildTeamSnapshot } = require(path.join(__dirname, '..', 'electron', 'team-snapshot.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const U = -1;
const blankTyre = () => ({ tempC: U, surfaceTempC: U, wear: U });
const blankTyres = () => ({
  frontLeft: blankTyre(), frontRight: blankTyre(), rearLeft: blankTyre(), rearRight: blankTyre(),
});

/** What this PC's feed looks like while spectating our #12 LMP2 at Daytona. */
function spectatorFrame(over = {}) {
  return {
    schemaVersion: 1,
    source: 'lmu',
    connected: true,
    timestamp: 1,
    session: { track: 'Daytona International Speedway', onTrack: true },
    player: { slotId: 30, gear: 4, speedKph: 241, rpm: 8000, tyres: blankTyres() },
    standings: [
      { slotId: 7, carNumber: '12', carClass: 'GT3', driverName: 'Rival', isPlayer: false },
      { slotId: 30, carNumber: '12', carClass: 'LMP2', driverName: 'Scott Cruz', isPlayer: true },
      { slotId: 41, carNumber: '3', carClass: 'LMP2', driverName: 'Other', isPlayer: false },
    ],
    fuel: { levelLiters: U, capacityLiters: U, lapsRemaining: 9 },
    ...over,
  };
}

/** A relay row as the driving PC publishes it (built by the real snapshot builder). */
function drivingPayload(over = {}) {
  const tyre = (wear, temp) => ({
    wear, tempC: temp, coreC: temp + 3, innerC: temp + 1, middleC: temp, outerC: temp - 1,
    surfaceTempC: temp + 6, surfaceInnerC: temp + 5, surfaceMiddleC: temp + 6, surfaceOuterC: temp + 7,
    pressureKpa: 176.8, brakeTempC: 420, optimalTempC: 90, compound: 'Medium',
  });
  const frame = {
    source: 'lmu',
    connected: true,
    session: { track: 'Daytona International Speedway', onTrack: true },
    player: {
      position: 5,
      tyres: { frontLeft: tyre(0.86, 88), frontRight: tyre(0.85, 89), rearLeft: tyre(0.9, 84), rearRight: tyre(0.91, 85) },
      damage: {
        aero: 0.12, suspension: [0, 0.3, 0, 0], brakeThicknessMm: [30, 30, 31, 31],
        partsDetached: 1, worst: 0.3, hasDamage: true, repairSeconds: 41.5, repairBodySeconds: 20,
        repairSelection: 'all', repairOptions: ['Do Not Repair'], tyreChangeSeconds: 12,
        tyreCornersSelected: 4, stopLengthSeconds: 70.2, randomDelayMaxSeconds: 3,
      },
    },
    standings: [{ slotId: 30, carNumber: '12', carClass: 'LMP2', driverName: 'Scott Cruz', isPlayer: true, isOwn: true }],
    fuel: { levelLiters: 51, capacityLiters: 75, perLapAvgLiters: 2.97, lapsRemaining: 17 },
    weather: null,
    ...over,
  };
  return buildTeamSnapshot(frame, 1000);
}

const relayOf = (payload, ageSec = 1, receivedAt = 10_000, name = 'Scott Cruz') => ({
  receivedAt,
  sources: [{ userId: 'u-scott', name, ageSec, snapshot: payload }],
});

// ── The happy path: a teammate driving our car, this PC watching ───────────
{
  const frame = spectatorFrame();
  const before = JSON.stringify(frame);
  const out = applyTeammateRelay(frame, relayOf(drivingPayload()), 10_500);
  const fl = out.player.tyres.frontLeft;
  check('tyre temps arrive', fl.tempC === 88 && fl.coreC === 91, JSON.stringify(fl));
  check('tyre wear arrives', fl.wear === 0.86 && out.player.tyres.rearRight.wear === 0.91);
  check('surface temps + bands arrive', fl.surfaceTempC === 94 && fl.surfaceOuterC === 95);
  check('pressure, brake temp, compound, optimum arrive',
    fl.pressureKpa === 176.8 && fl.brakeTempC === 420 && fl.compound === 'Medium' && fl.optimalTempC === 90);
  const d = out.player.damage;
  check('damage arrives whole', d && d.aero === 0.12 && d.suspension[1] === 0.3 && d.hasDamage === true);
  check('repair screen arrives', d.stopLengthSeconds === 70.2 && d.repairSelection === 'all' &&
    d.tyreCornersSelected === 4 && d.brakeThicknessMm[2] === 31 && d.randomDelayMaxSeconds === 3);
  check('fuel arrives in litres', out.fuel.levelLiters === 51 && out.fuel.perLapAvgLiters === 2.97);
  check('marked relayed with name and age',
    out.player.relayed && out.player.relayed.driverName === 'Scott Cruz' && out.player.relayed.ageSec === 1.5,
    JSON.stringify(out.player.relayed));
  check('live local channels untouched', out.player.speedKph === 241 && out.player.gear === 4);
  check('input frame not mutated', JSON.stringify(frame) === before);
  check('standings untouched', out.standings === frame.standings);
}

// ── Never while we are driving the watched car ─────────────────────────────
{
  const frame = spectatorFrame();
  frame.standings[1].isOwn = true;
  const out = applyTeammateRelay(frame, relayOf(drivingPayload()), 10_500);
  check('own driven car never overridden', out === frame);
}

// ── Only the matching entry ────────────────────────────────────────────────
{
  const other = spectatorFrame();
  other.standings[1].isPlayer = false;
  other.standings[2].isPlayer = true; // camera on #3
  check('a different car number is left alone',
    applyTeammateRelay(other, relayOf(drivingPayload()), 10_500) === other);

  const gt3 = spectatorFrame();
  gt3.standings[1].isPlayer = false;
  gt3.standings[0].isPlayer = true; // #12 GT3, same number, other class
  check('same number in another class is left alone',
    applyTeammateRelay(gt3, relayOf(drivingPayload()), 10_500) === gt3);

  const elsewhere = drivingPayload({ session: { track: 'Sebring', onTrack: true } });
  const f = spectatorFrame();
  check('a teammate at another circuit is left alone',
    applyTeammateRelay(f, relayOf(elsewhere), 10_500) === f);

  const noFocus = spectatorFrame();
  noFocus.standings.forEach((r) => { r.isPlayer = false; });
  check('no focus row → untouched', applyTeammateRelay(noFocus, relayOf(drivingPayload()), 10_500) === noFocus);
}

// ── Fresh or not at all ────────────────────────────────────────────────────
{
  const f = spectatorFrame();
  check('row already too old at read → dropped',
    applyTeammateRelay(f, relayOf(drivingPayload(), RELAY_MAX_AGE_SEC + 1), 10_000) === f);
  check('row aged out since the read → dropped',
    applyTeammateRelay(f, relayOf(drivingPayload(), 2), 10_000 + (RELAY_MAX_AGE_SEC - 1) * 1000) === f);
  check('row within the window → applied',
    applyTeammateRelay(f, relayOf(drivingPayload(), 2), 12_000).player.relayed !== undefined);
}

// ── Guards ─────────────────────────────────────────────────────────────────
{
  const f = spectatorFrame();
  check('null relay → same frame', applyTeammateRelay(f, null, 1) === f);
  const demo = spectatorFrame({ connected: false });
  check('demo frame → untouched', applyTeammateRelay(demo, relayOf(drivingPayload()), 10_500) === demo);
  const rf2 = spectatorFrame({ source: 'rf2' });
  check('non-LMU source → untouched (no isOwn to trust)',
    applyTeammateRelay(rf2, relayOf(drivingPayload()), 10_500) === rf2);
  const offline = drivingPayload({ connected: false });
  check('a relayed demo frame is never shown',
    applyTeammateRelay(f, relayOf(offline), 10_500) === f);
}

// ── Two teammates driving: the watched one wins, the fresher on a tie ─────
{
  const f = spectatorFrame();
  const mine = drivingPayload();
  const theirs = drivingPayload({
    standings: [{ slotId: 41, carNumber: '3', carClass: 'LMP2', driverName: 'Other', isPlayer: true }],
  });
  const relay = {
    receivedAt: 10_000,
    sources: [
      { name: 'Other', ageSec: 0.2, snapshot: theirs },
      { name: 'Scott Cruz', ageSec: 1.2, snapshot: mine },
      { name: 'Scott (old app)', ageSec: 0.8, snapshot: mine },
    ],
  };
  const hit = matchRelaySource(f, relay, 10_000);
  check('picks the row for the watched car, freshest first',
    hit && hit.source.name === 'Scott (old app)', hit && hit.source.name);
}

// ── An older teammate app: headline damage only, no surface temps ──────────
{
  const f = spectatorFrame();
  const old = drivingPayload();
  old.car.damage = { aero: 0, suspension: [0, 0, 0, 0], worst: 0, hasDamage: false, repairSeconds: U, partsDetached: 0 };
  for (const k of Object.keys(old.car.tyres)) delete old.car.tyres[k].surfaceTempC;
  const out = applyTeammateRelay(f, relayOf(old), 10_500);
  const d = out.player.damage;
  check('missing repair fields read unknown, not zero',
    d.stopLengthSeconds === U && d.tyreChangeSeconds === U && d.brakeThicknessMm.every((v) => v === U));
  check('missing selection reads unavailable', d.repairSelection === 'unavailable' && d.tyreCornersSelected === 0);
  check('clean car stays clean', d.hasDamage === false);
  check('missing surface temp stays absent', !('surfaceTempC' in out.player.tyres.frontLeft));
  check('temps still arrive', out.player.tyres.frontLeft.tempC === 88);
}

console.log(`teammate relay: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
