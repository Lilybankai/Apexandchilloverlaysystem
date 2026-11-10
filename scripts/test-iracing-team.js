/**
 * test-iracing-team.js — the team relay on iRacing, end to end, on synthetic
 * team-race session info.
 * -----------------------------------------------------------------------------
 * ⚠ There is NO capture of a real iRacing team race yet. Everything team-shaped
 * here is the committed anonymised solo fixture (scripts/fixtures/iracing-cap1)
 * with its YAML edited into a team event: `TeamRacing: 1`, our car's current
 * `UserID` set to us or to a teammate. What it proves is that the rules in
 * telemetry/iracing/teamIdentity.ts, teammateRelay.ts, team-cloud.js and
 * sim-gates.js agree with each other and fail closed — not that iRacing really
 * publishes a team event this way. Re-run against a real team capture first.
 *
 *   1. teamIdentity: solo / in the car / in the garage / teammate driving /
 *      ids missing.
 *   2. The provider on the fixture's last race frame: `isOwn`,
 *      `teammateDriving` and `session.sessionId` on the solo fixture and on
 *      each team variant.
 *   3. Both ends: the teammate's PC publishes (eligibleToPublish), ours does
 *      not, ours asks for the relay (watchingAnotherCar), and the relayed fuel
 *      and tyres land — and nothing lands from another subsession, an LMU row,
 *      a beta.5 row with no session id, or with the camera on a stranger.
 *   4. The reference-pace sim gate (sim-gates.scoresReferencePace).
 *
 * Run: npm run test:iracing-team   (needs `npm run build` first)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dist = (p) => require(path.join(__dirname, '..', 'dist', 'telemetry', p));
const { IRacingProvider } = dist('iracing/iracingProvider.js');
const { parseSessionInfo } = dist('iracing/sessionInfo.js');
const { irTeamStint, irSessionId } = dist('iracing/teamIdentity.js');
const { applyTeammateRelay } = dist('teammateRelay.js');
const { buildTeamSnapshot } = require('../electron/team-snapshot.js');
const { eligibleToPublish } = require('../electron/team-cloud.js');
const { watchingAnotherCar, scoresReferencePace, drivingHere } = require('../electron/sim-gates.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.error(`  FAIL ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
}

const FIX = path.join(__dirname, 'fixtures', 'iracing-cap1');
const yamlSolo = zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'session-145.yaml.gz'))).toString('latin1');
const lines = zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'frames.ndjson.gz'))).toString('utf8').trim().split('\n');
const raceRow = JSON.parse(lines[lines.length - 1]);
const OWN = raceRow.PlayerCarIdx; // 8 in the fixture

const SELF = 555001;
const MATE = 555002;

/** The fixture YAML turned into a team event: our car's CURRENT driver is `current`. */
function teamYaml({ self = SELF, current = MATE, name = 'Teammate Two', subsession = null } = {}) {
  let y = yamlSolo.replace(/^ TeamRacing: 0/m, ' TeamRacing: 1');
  y = y.replace(/^ DriverUserID: \d+/m, ` DriverUserID: ${self}`);
  if (subsession !== null) y = y.replace(/^ SubSessionID: \d+/m, ` SubSessionID: ${subsession}`);
  // Our car's block: its current UserName / UserID.
  y = y.replace(new RegExp(`(- CarIdx: ${OWN}\\r?\\n   UserName: )[^\\r\\n]*`), `$1${name}`);
  y = y.replace(new RegExp(`(- CarIdx: ${OWN}\\r?\\n(?:   [^\\r\\n]*\\r?\\n)*?   UserID: )\\d+`), `$1${current}`);
  y = y.replace(new RegExp(`(- CarIdx: ${OWN}\\r?\\n(?:   [^\\r\\n]*\\r?\\n)*?   TeamID: )\\d+`), (_m, a) => `${a}4242`);
  y = y.replace(new RegExp(`(- CarIdx: ${OWN}\\r?\\n(?:   [^\\r\\n]*\\r?\\n)*?   TeamName: )[^\\r\\n]*`), '$1Apex Test Team');
  return y;
}

/** An IrsdkFrame over a plain row object (test-iracing.js's pattern). */
function frameOf(o) {
  return {
    tick: o._tick,
    has: (n) => o[n] !== undefined,
    count: (n) => (Array.isArray(o[n]) ? o[n].length : o[n] === undefined ? 0 : 1),
    num: (n, i = 0) => {
      let v = o[n];
      if (Array.isArray(v)) v = v[i];
      return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : NaN;
    },
    bool(n, i) {
      const v = this.num(n, i);
      return Number.isFinite(v) && v !== 0;
    },
  };
}

/** One provider frame from a YAML and a patch over the fixture's race row. */
function frameFrom(yaml, patch = {}) {
  const row = { ...raceRow, ...patch };
  const source = {
    open: () => true,
    close() {},
    isOpen: () => true,
    connected: () => true,
    read: () => frameOf(row),
    sessionInfoUpdate: () => 1,
    readSessionInfo: () => Buffer.from(yaml, 'latin1'),
  };
  const p = new IRacingProvider({ verbose: false }, { source, lapSink: null });
  p.start();
  const fr = p.poll(raceRow._t, 100);
  p.stop();
  return fr;
}

const ownRow = (fr) => fr.standings.find((s) => s.slotId === OWN);

// ── 1. teamIdentity ─────────────────────────────────────────────────────────
{
  const solo = parseSessionInfo(yamlSolo);
  check('fixture parses', !!solo && solo.teamRacing === false);
  check('DriverUserID is parsed', solo.driverUserId > 0, solo.driverUserId);
  check('TeamID is parsed per driver', solo.drivers.every((d) => typeof d.teamId === 'number'));
  const s0 = irTeamStint(solo, OWN, false);
  check('solo: our car, driven here, no teammate', s0.drivingHere && !s0.teammateDriving && s0.carIdx === OWN);

  const mate = parseSessionInfo(teamYaml());
  check('team YAML parses as a team event', mate.teamRacing === true);
  check('team YAML: our car names its current driver', mate.drivers.find((d) => d.carIdx === OWN).userId === MATE);
  check('team YAML: TeamID survives the edit', mate.drivers.find((d) => d.carIdx === OWN).teamId === 4242);
  const inCar = irTeamStint(mate, OWN, true);
  check('team, IsOnTrack: we are driving (whatever the lagging YAML says)', inCar.drivingHere && !inCar.teammateDriving);
  const tm = irTeamStint(mate, OWN, false);
  check('team, teammate in our car: teammateDriving, not driven here', tm.teammateDriving && !tm.drivingHere);

  const garage = irTeamStint(parseSessionInfo(teamYaml({ current: SELF })), OWN, false);
  check('team, we are the current driver (garage): driven here', garage.drivingHere && !garage.teammateDriving);
  const noSelf = irTeamStint(parseSessionInfo(teamYaml({ self: 0 })), OWN, false);
  check('team, our own id unknown: neither (closed)', !noSelf.drivingHere && !noSelf.teammateDriving);
  const noCur = irTeamStint(parseSessionInfo(teamYaml({ current: 0 })), OWN, false);
  check('team, the car\'s current id unknown: neither (closed)', !noCur.drivingHere && !noCur.teammateDriving);
  const noCar = irTeamStint(mate, -1, false);
  check('team, no own car index: neither (closed)', !noCar.drivingHere && !noCar.teammateDriving);

  check('session id: subsession + session number', irSessionId(mate, 2) === 'ir-1-2');
  check('no subsession (offline): no session id', irSessionId({ ...mate, subSessionId: 0 }, 2) === undefined);
}

// ── 2. The provider ─────────────────────────────────────────────────────────
{
  const solo = frameFrom(yamlSolo);
  check('solo fixture frame is live iRacing', solo.connected && solo.source === 'iracing');
  check('solo: our row is isOwn', ownRow(solo).isOwn === true);
  check('solo: no row is teammateDriving', !solo.standings.some((s) => s.teammateDriving));
  check('solo: exactly one isOwn row', solo.standings.filter((s) => s.isOwn).length === 1);
  check('solo: session id carried', solo.session.sessionId === 'ir-1-2', solo.session.sessionId);

  const spect = frameFrom(teamYaml(), { IsOnTrack: false, CamCarIdx: OWN });
  check('team, teammate driving: our row is NOT isOwn', ownRow(spect).isOwn !== true);
  check('team, teammate driving: our row carries teammateDriving', ownRow(spect).teammateDriving === true);
  check('team, teammate driving: our row names the teammate', ownRow(spect).driverName === 'Teammate Two');
  check('team, teammate driving: no other row is flagged',
    spect.standings.filter((s) => s.teammateDriving).length === 1);

  const driving = frameFrom(teamYaml({ self: MATE }), { IsOnTrack: true, CamCarIdx: OWN });
  check('team, the teammate\'s own PC: isOwn, not teammateDriving',
    ownRow(driving).isOwn === true && !ownRow(driving).teammateDriving);
}

// ── 3. Both ends of the relay ───────────────────────────────────────────────
{
  // The teammate's PC: driving our team car.
  const theirs = frameFrom(teamYaml({ self: MATE }), { IsOnTrack: true, CamCarIdx: OWN, FuelLevel: 41.5 });
  const snap = buildTeamSnapshot(theirs, theirs.timestamp);
  check('teammate PC: drivingHere', drivingHere(theirs));
  check('teammate PC: publishes', eligibleToPublish(theirs, snap));
  check('payload carries the session id', snap.session.sessionId === 'ir-1-2');
  check('payload carries the sim', snap.source === 'iracing');

  // This PC: a crew member watching our car while the teammate drives.
  const ours = frameFrom(teamYaml(), { IsOnTrack: false, CamCarIdx: OWN, FuelLevel: 0 });
  check('our PC (not driving): never publishes', !eligibleToPublish(ours, buildTeamSnapshot(ours, ours.timestamp)));
  check('our PC: asks for the relay', watchingAnotherCar(ours));

  const relay = (payload, extra = {}) => ({
    receivedAt: ours.timestamp,
    selfUserId: 'u-me',
    sources: [{ userId: 'u-mate', name: 'Teammate Two', ageSec: 1, snapshot: payload }],
    ...extra,
  });
  const out = applyTeammateRelay(ours, relay(snap), ours.timestamp + 200);
  check('relayed: marked with the teammate', out.player.relayed && out.player.relayed.driverName === 'Teammate Two');
  check('relayed: fuel arrives', out.fuel && out.fuel === snap.fuel, JSON.stringify(out.fuel && out.fuel.levelLiters));

  const other = frameFrom(teamYaml({ self: MATE, subsession: 777 }), { IsOnTrack: true, CamCarIdx: OWN });
  const otherSnap = buildTeamSnapshot(other, other.timestamp);
  check('another subsession: nothing relayed', !applyTeammateRelay(ours, relay(otherSnap), ours.timestamp + 200).player.relayed);

  const beta5 = JSON.parse(JSON.stringify(snap));
  delete beta5.session.sessionId;
  check('a row with no session id (1.3.16-beta.5): nothing relayed',
    !applyTeammateRelay(ours, relay(beta5), ours.timestamp + 200).player.relayed);

  const lmuRow = { ...JSON.parse(JSON.stringify(snap)), source: 'lmu' };
  check('an LMU row: nothing relayed onto iRacing', !applyTeammateRelay(ours, relay(lmuRow), ours.timestamp + 200).player.relayed);

  const stranger = raceRow.CarIdxPosition.findIndex((p, i) => i !== OWN && p > 0);
  const camAway = frameFrom(teamYaml(), { IsOnTrack: false, CamCarIdx: stranger, FuelLevel: 0 });
  check('camera on a stranger: no relay asked for', !watchingAnotherCar(camAway));
  check('camera on a stranger: nothing relayed', !applyTeammateRelay(camAway, relay(snap), camAway.timestamp + 200).player.relayed);

  const solo = frameFrom(yamlSolo);
  check('solo race: no relay asked for', !watchingAnotherCar(solo));
  check('solo race: nothing relayed, whatever arrives', !applyTeammateRelay(solo, relay(snap), solo.timestamp + 200).player.relayed);

  const stale = relay(snap);
  stale.sources[0].ageSec = 30;
  check('stale row: nothing relayed', !applyTeammateRelay(ours, stale, ours.timestamp + 200).player.relayed);
  check('own row skipped by user id',
    !applyTeammateRelay(ours, relay(snap, { selfUserId: 'u-mate' }), ours.timestamp + 200).player.relayed);
}

// ── 4. Reference pace is LMU only ───────────────────────────────────────────
{
  check('an LMU session is scored', scoresReferencePace({ sim: 'lmu' }));
  check('a session with no sim (old lap log) is LMU', scoresReferencePace({}));
  check('an iRacing session is never scored', !scoresReferencePace({ sim: 'iracing' }));
  check('no session, no score', !scoresReferencePace(null));
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  check('main gates sessionPaceFor on the sim', /function sessionPaceFor[\s\S]{0,300}scoresReferencePace\(session\)/.test(main));
}

console.log(`iracing team: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
