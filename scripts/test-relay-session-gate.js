/**
 * test-relay-session-gate.js — a teammate in ANOTHER session never reaches our overlays.
 * -----------------------------------------------------------------------------
 * Linear THE-34 (2026-10): Micky was driving the team car in the race and the
 * spectating teammates' overlays showed his relayed tyres/damage/fuel. Then
 * Scott went and lapped a PRACTICE server — same circuit, same car, same
 * livery number — and his relay row started coming through too: the old gate
 * matched on car number + class + track only, picked the FRESHEST matching
 * row, and the two rows leapfrogged every second.
 *
 * The gate (src/telemetry/teammateRelay.ts) now demands: the watched row is
 * OUR car with LMU saying a teammate drives it (`teammateDriving`), the
 * relayed row is from the same session (track + type, server when both have
 * one; empty fails closed), the same car, and the driver LMU has in it; never
 * the reader's own row; sticky across a one-frame flag drop. On top sits the
 * Relay source picker (THE-34 follow-up): Auto, one pinned teammate (still
 * gated), or Off.
 *
 * Also covers THE-23's holes from the publisher's side (electron/team-cloud.js).
 *
 * Run: npm run test:relay-session-gate   (needs `npm run build` first)
 */

'use strict';

const path = require('path');
const {
  applyTeammateRelay,
  matchRelaySource,
  relayStatus,
  TeammateRelayGate,
  RELAY_GATE_HOLD_MS,
} = require(path.join(__dirname, '..', 'dist', 'telemetry', 'teammateRelay.js'));
const { buildTeamSnapshot } = require(path.join(__dirname, '..', 'electron', 'team-snapshot.js'));
const {
  eligibleToPublish,
  overlaySources,
  pickActiveSource,
  resolveRelaySource,
} = require(path.join(__dirname, '..', 'electron', 'team-cloud.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const U = -1;
const SPA = 'Circuit de Spa-Francorchamps';
const RACE_SERVER = 'ACRL Endurance Round 4';
const blankTyres = () => {
  const t = () => ({ tempC: U, wear: U });
  return { frontLeft: t(), frontRight: t(), rearLeft: t(), rearRight: t() };
};

/** Carl's PC: in the race, spectating our #7 Hypercar while Micky drives it. */
function carlFrame(over = {}, rowOver = {}) {
  return {
    schemaVersion: 1,
    source: 'lmu',
    connected: true,
    timestamp: 1,
    session: { track: SPA, type: 'race', serverName: RACE_SERVER, onTrack: true },
    player: { slotId: 12, gear: 5, speedKph: 280, rpm: 7000, tyres: blankTyres() },
    standings: [
      { slotId: 3, carNumber: '7', carClass: 'GT3', driverName: 'Somebody Else', isPlayer: false },
      {
        slotId: 12, carNumber: '7', carClass: 'Hypercar', driverName: 'Micky Blue',
        isPlayer: true, teammateDriving: true, ...rowOver,
      },
    ],
    fuel: { levelLiters: U, capacityLiters: U },
    ...over,
  };
}

/** A relay payload built by the REAL publisher-side snapshot builder. */
function payload({ driver, type = 'race', server = RACE_SERVER, track = SPA, number = '7', cls = 'Hypercar', wear = 0.8 }) {
  const tyre = { wear, tempC: 85, coreC: 88, pressureKpa: 180, brakeTempC: 500, compound: 'Medium' };
  const frame = {
    source: 'lmu',
    connected: true,
    session: { track, type, serverName: server, onTrack: true },
    player: {
      position: 4,
      tyres: { frontLeft: { ...tyre }, frontRight: { ...tyre }, rearLeft: { ...tyre }, rearRight: { ...tyre } },
      damage: { aero: 0, suspension: [0, 0, 0, 0], worst: 0, hasDamage: false, repairSeconds: 0, partsDetached: 0 },
    },
    standings: [{ slotId: 1, carNumber: number, carClass: cls, driverName: driver, isPlayer: true, isOwn: true }],
    fuel: { levelLiters: 40, capacityLiters: 90 },
    weather: null,
  };
  return buildTeamSnapshot(frame, 1000);
}

const MICKY = { userId: 'u-micky', name: 'Micky Blue' };
const SCOTT = { userId: 'u-scott', name: 'Scott Green' };
const CARL = { userId: 'u-carl', name: 'Carl Jones' };

const mickyRace = () => payload({ driver: 'Micky Blue' });
/** Scott lapping a practice server at the same circuit, in the same car. */
const scottPractice = () => payload({ driver: 'Scott Green', type: 'practice', server: 'LMU Practice Spa 2' });

const relay = (rows, extra = {}) => ({
  receivedAt: 10_000,
  sources: rows.map(([who, snapshot, ageSec = 1]) => ({ ...who, ageSec, snapshot })),
  ...extra,
});

// ── THE-34 itself: Scott's practice row never reaches the race car ─────────
{
  const f = carlFrame();
  // Scott's row is FRESHER — the old gate picked it every other second.
  const r = relay([[MICKY, mickyRace(), 1.4], [SCOTT, scottPractice(), 0.2]]);
  const hit = matchRelaySource(f, r, 10_100);
  check('the driving teammate in our race is accepted', hit && hit.source.userId === 'u-micky', hit && hit.source.name);
  const out = applyTeammateRelay(f, r, 10_100);
  check('…and his data reaches the overlays, tagged with his name',
    out.player.relayed && out.player.relayed.driverName === 'Micky Blue' && out.player.tyres.frontLeft.wear === 0.8);

  // Every frame for a minute, alternating which row is fresher: never Scott.
  const gate = new TeammateRelayGate();
  let sawScott = false;
  let sawMicky = 0;
  for (let i = 0; i < 120; i++) {
    const now = 10_000 + i * 500;
    const rr = {
      receivedAt: now,
      sources: [
        { ...MICKY, ageSec: i % 2 ? 0.2 : 1.8, snapshot: mickyRace() },
        { ...SCOTT, ageSec: i % 2 ? 1.8 : 0.2, snapshot: scottPractice() },
      ],
    };
    const o = gate.apply(f, rr, now);
    if (o.player.relayed && o.player.relayed.driverName === 'Scott Green') sawScott = true;
    if (o.player.relayed && o.player.relayed.driverName === 'Micky Blue') sawMicky++;
  }
  check('over 120 frames of leapfrogging ages, Scott is never shown', !sawScott);
  check('…and Micky is shown on every one of them', sawMicky === 120, String(sawMicky));

  const onlyScott = relay([[SCOTT, scottPractice(), 0.2]]);
  check('a teammate in a different practice session is rejected', applyTeammateRelay(f, onlyScott, 10_100) === f);
  check('…and the status says nobody in our session is relaying',
    relayStatus(f, onlyScott, 10_100).state === 'none');
}

// ── Session identity, piece by piece ──────────────────────────────────────
{
  const f = carlFrame();
  const variants = [
    ['another session type (qualifying)', payload({ driver: 'Micky Blue', type: 'qualifying' })],
    ['another server at the same circuit, same type', payload({ driver: 'Micky Blue', server: 'Other League Race' })],
    ['another circuit', payload({ driver: 'Micky Blue', track: 'Sebring International Raceway' })],
    ['another car number', payload({ driver: 'Micky Blue', number: '8' })],
    ['same number, another class', payload({ driver: 'Micky Blue', cls: 'LMGT3' })],
    ['our car, but LMU has somebody else in it', payload({ driver: 'Scott Green' })],
  ];
  for (const [name, snap] of variants) {
    check(`rejected: ${name}`, applyTeammateRelay(f, relay([[MICKY, snap]]), 10_100) === f);
  }
  // An older teammate app publishes no server name: everything else must hold.
  const noServer = payload({ driver: 'Micky Blue', server: undefined });
  check('accepted: a teammate app without a server name, everything else matching',
    matchRelaySource(f, relay([[MICKY, noServer]]), 10_100) !== null);
  // LMU's "#1234" uniqueness suffix and case/spacing do not break the match.
  const suffixed = carlFrame({}, { driverName: 'micky  blue#4821' });
  check('driver names match across LMU\'s #suffix and spacing',
    matchRelaySource(suffixed, relay([[MICKY, mickyRace()]]), 10_100) !== null);
}

// ── Empty identity fails closed ───────────────────────────────────────────
{
  const r = relay([[MICKY, mickyRace()]]);
  const cases = [
    ['our session type empty', carlFrame({ session: { track: SPA, type: '', serverName: RACE_SERVER } })],
    ['our track empty', carlFrame({ session: { track: '', type: 'race', serverName: RACE_SERVER } })],
    ['our car class empty', carlFrame({}, { carClass: '' })],
    ['our driver name empty', carlFrame({}, { driverName: '' })],
    ['our car number empty', carlFrame({}, { carNumber: '' })],
    ['no teammateDriving flag on the watched row', carlFrame({}, { teammateDriving: undefined })],
  ];
  for (const [name, f] of cases) {
    check(`fails closed: ${name}`, applyTeammateRelay(f, r, 10_100) === f);
  }
  const f = carlFrame();
  const snapCases = [
    ['relayed track missing', (s) => { delete s.session.track; }],
    ['relayed session type missing', (s) => { delete s.session.type; }],
    ['relayed class missing', (s) => { delete s.car.carClass; }],
    ['relayed driver missing', (s) => { delete s.car.driverName; }],
    ['relayed session block missing', (s) => { delete s.session; }],
  ];
  for (const [name, mutate] of snapCases) {
    const s = mickyRace();
    mutate(s);
    check(`fails closed: ${name}`, applyTeammateRelay(f, relay([[MICKY, s]]), 10_100) === f);
  }
}

// ── Never our own row; never while we drive ───────────────────────────────
{
  // Carl's own app's row, claiming the car Micky is in (e.g. stale or echoed).
  const f = carlFrame({}, { driverName: 'Carl Jones' });
  const own = payload({ driver: 'Carl Jones' });
  const r = relay([[CARL, own]], { selfUserId: 'u-carl' });
  check('our own relay row is ignored even when it matches everything', applyTeammateRelay(f, r, 10_100) === f);
  const rows = [
    { user_id: 'u-carl', name: 'Carl', age_sec: 1, payload: own },
    { user_id: 'u-micky', name: 'Micky', age_sec: 1, payload: mickyRace() },
  ];
  const out = overlaySources(rows, 'u-carl');
  check('team-cloud never hands the server our own row', out.length === 1 && out[0].userId === 'u-micky');

  const driving = carlFrame({}, { isOwn: true });
  check('in the car ourselves: never overridden', applyTeammateRelay(driving, relay([[MICKY, mickyRace()]]), 10_100) === driving);
  check('…status says our own telemetry is used', relayStatus(driving, relay([[MICKY, mickyRace()]]), 10_100).state === 'idle');
}

// ── Hysteresis: one bad frame neither blanks nor flips ────────────────────
{
  const gate = new TeammateRelayGate();
  const r = (now, rows) => ({ receivedAt: now, sources: rows });
  const micky = { ...MICKY, ageSec: 1, snapshot: mickyRace() };
  // A second app instance logged in as Micky (or a re-login) — same driver.
  const mickyAlt = { userId: 'u-micky-2', name: 'Micky (laptop)', ageSec: 0.1, snapshot: mickyRace() };
  let o = gate.apply(carlFrame(), r(20_000, [micky]), 20_000);
  check('gate locks onto the driving teammate', o.player.relayed && o.player.relayed.driverName === 'Micky Blue');
  o = gate.apply(carlFrame(), r(20_200, [micky, mickyAlt]), 20_200);
  check('a fresher passing row does not steal a locked source', o.player.relayed.driverName === 'Micky Blue');
  const blip = carlFrame({}, { teammateDriving: undefined });
  o = gate.apply(blip, r(20_400, [micky]), 20_400);
  check('one frame without the flag keeps the relay (hold)', !!o.player.relayed);
  o = gate.apply(blip, r(20_400 + RELAY_GATE_HOLD_MS + 100, [micky]), 20_400 + RELAY_GATE_HOLD_MS + 100);
  check('…but not past the hold window', !o.player.relayed);
  // Hold never lets a WRONG row through: identity still applies during it.
  const gate2 = new TeammateRelayGate();
  gate2.apply(carlFrame(), r(30_000, [micky]), 30_000);
  const swapped = carlFrame({}, { teammateDriving: undefined, driverName: 'Scott Green' });
  o = gate2.apply(swapped, r(30_100, [micky, { ...SCOTT, ageSec: 0.2, snapshot: scottPractice() }]), 30_100);
  check('during the hold a driver change still drops the relay', !o.player.relayed);
  // Getting in the car ends it on that frame, hold or not.
  const gate3 = new TeammateRelayGate();
  gate3.apply(carlFrame(), r(40_000, [micky]), 40_000);
  o = gate3.apply(carlFrame({}, { isOwn: true, teammateDriving: undefined }), r(40_050, [micky]), 40_050);
  check('getting in the car ends the relay at once', !o.player.relayed);
}

// ── Relay source picker: pin and Off ──────────────────────────────────────
{
  const f = carlFrame();
  const rows = [[MICKY, mickyRace(), 1.2], [SCOTT, scottPractice(), 0.2]];

  const pinMicky = relay(rows, { mode: 'pin', pinUserId: 'u-micky', pinName: 'Micky Blue' });
  const hit = matchRelaySource(f, pinMicky, 10_100);
  check('pinned teammate in our session → accepted', hit && hit.source.userId === 'u-micky');
  check('…status names him', relayStatus(f, pinMicky, 10_100).driverName === 'Micky Blue');

  const pinScott = relay(rows, { mode: 'pin', pinUserId: 'u-scott', pinName: 'Scott Green' });
  check('pinned teammate in another session → rejected (nothing shown, not Micky either)',
    applyTeammateRelay(f, pinScott, 10_100) === f);
  const st = relayStatus(f, pinScott, 10_100);
  check('…with a status saying he is not in our session',
    st.state === 'not-in-session' && /Scott isn't in your session/.test(st.text), st.text);

  const pinScottSameRace = relay([[MICKY, mickyRace()], [SCOTT, payload({ driver: 'Scott Green' })]],
    { mode: 'pin', pinUserId: 'u-scott', pinName: 'Scott Green' });
  const st2 = relayStatus(f, pinScottSameRace, 10_100);
  check('pinned teammate in our session but not in our car → not-driving', st2.state === 'not-driving', st2.text);

  const pinGhost = relay([[MICKY, mickyRace()]], { mode: 'pin', pinUserId: 'u-scott', pinName: 'Scott Green' });
  check('pinned teammate sending nothing → no-data', relayStatus(f, pinGhost, 10_100).state === 'no-data');

  const off = relay(rows, { mode: 'off' });
  check('Off → no relay at all, even for the right teammate', applyTeammateRelay(f, off, 10_100) === f);
  check('…status says off', relayStatus(f, off, 10_100).state === 'off');
  const gate = new TeammateRelayGate();
  check('Off through the stateful gate too', !gate.apply(f, off, 10_100).player.relayed);

  // The stored setting resolved against the roster (team-cloud.js).
  const team = { id: 't1', members: [{ user_id: 'u-micky', name: 'Micky Blue' }, { user_id: 'u-carl', name: 'Carl' }] };
  check('resolve: auto', resolveRelaySource('auto', team).mode === 'auto');
  check('resolve: off', resolveRelaySource('off', team).mode === 'off');
  const rp = resolveRelaySource('u-micky', team);
  check('resolve: a member pins', rp.mode === 'pin' && rp.pinUserId === 'u-micky' && rp.pinName === 'Micky Blue');
  check('resolve: a pinned teammate who left the team falls back to Auto',
    resolveRelaySource('u-scott', team).mode === 'auto');
  check('resolve: junk is Auto', resolveRelaySource(undefined, null).mode === 'auto');
}

// ── Publisher side (THE-23) ───────────────────────────────────────────────
{
  const snap = mickyRace();
  const driving = {
    source: 'lmu', connected: true, session: { onTrack: true }, player: {},
    standings: [{ isPlayer: true, isOwn: true, carNumber: '7' }],
  };
  check('publisher: driving our own car → publishes', eligibleToPublish(driving, snap));
  const parkedWatching = {
    ...driving,
    standings: [{ isPlayer: true, carNumber: '7', driverName: 'Micky Blue' }, { isPlayer: false, isOwn: true }],
  };
  check('publisher: camera on another car → never publishes that car\'s identity',
    !eligibleToPublish(parkedWatching, snap));
  // The snapshot carries the session identity the readers compare.
  check('publisher: payload carries track, type and server name',
    snap.session.track === SPA && snap.session.type === 'race' && snap.session.serverName === RACE_SERVER);
}

// ── Team tab: sticky active source ────────────────────────────────────────
{
  const row = (id, age) => ({ user_id: id, name: id, age_sec: age, payload: mickyRace() });
  check('Team tab keeps the previous driving row while fresh',
    pickActiveSource([row('u-scott', 0.2), row('u-micky', 1.5)], 'u-micky').user_id === 'u-micky');
  check('…and moves on once it goes stale',
    pickActiveSource([row('u-scott', 0.2), row('u-micky', 60)], 'u-micky').user_id === 'u-scott');
}

// ── The LMU provider stamps the flag on our team car only ─────────────────
{
  const { LmuRestProvider } = require(path.join(__dirname, '..', 'dist', 'telemetry', 'lmuRestProvider.js'));
  const p = new LmuRestProvider({ verbose: false }); // never start()ed: no IO
  const cars = [
    { slotID: 3, position: 1, driverName: 'Somebody Else', carNumber: '7', carClass: 'GT3', lapsCompleted: 10 },
    { slotID: 12, position: 2, driverName: 'Micky Blue', carNumber: '7', carClass: 'Hypercar', lapsCompleted: 10 },
  ];
  const rows = p.buildStandings(cars, 12, -1, 'spa|RACE', 7000, 12);
  const ours = rows.find((r) => r.slotId === 12);
  const theirs = rows.find((r) => r.slotId === 3);
  check('provider: our team car carries teammateDriving', ours && ours.teammateDriving === true);
  check('provider: no other row does', theirs && theirs.teammateDriving === undefined);
  // Same REST snapshot, teammate no longer driving: the memo must not serve the old flag.
  const again = p.buildStandings(cars, 12, -1, 'spa|RACE', 7000, -1);
  check('provider: flag clears when the stint ends (memo keyed on it)',
    again.every((r) => r.teammateDriving === undefined));
}

// ── team-cloud end to end: what the overlay server is actually handed ─────
async function teamCloudFlow() {
  const teamCloud = require(path.join(__dirname, '..', 'electron', 'team-cloud.js'));
  let setting = 'u-scott';
  const handed = [];
  const team = {
    id: 't1',
    members: [
      { user_id: 'u-carl', name: 'Carl Jones' },
      { user_id: 'u-micky', name: 'Micky Blue' },
      { user_id: 'u-scott', name: 'Scott Green' },
    ],
  };
  const rows = [
    { user_id: 'u-carl', name: 'Carl Jones', age_sec: 0.5, payload: payload({ driver: 'Carl Jones' }) },
    { user_id: 'u-micky', name: 'Micky Blue', age_sec: 1, payload: mickyRace() },
    { user_id: 'u-scott', name: 'Scott Green', age_sec: 0.2, payload: scottPractice() },
  ];
  const auth = {
    stateForUi: () => ({ signedIn: true, user: { id: 'u-carl' } }),
    rpc: async (fn) => {
      if (fn === 'my_teams') return { ok: true, body: [team] };
      if (fn === 'team_relay_read') return { ok: true, body: { sources: rows } };
      return { ok: true, body: {} };
    },
  };
  teamCloud.init({
    auth,
    collect: () => null,
    store: {
      getActiveTeam: () => 't1',
      setActiveTeam: () => {},
      getWebRelay: () => false,
      getRelaySource: () => setting,
      setRelaySource: (v) => { setting = v; },
    },
    onOverlayRelay: (r) => handed.push(r),
    getOverlayStatus: () => ({ state: 'not-in-session', text: "Scott isn't in your session — nothing is relayed." }),
  });
  await teamCloud.refreshTeams();
  teamCloud.setOverlayWanted(true);
  await new Promise((r) => setTimeout(r, 30));
  const last = handed.filter(Boolean).pop();
  check('team-cloud: the server gets the pin with the roster name', last && last.mode === 'pin' &&
    last.pinUserId === 'u-scott' && last.pinName === 'Scott Green', JSON.stringify(last && { ...last, sources: undefined }));
  check('team-cloud: our own row never reaches the server, and our id rides along',
    last && last.selfUserId === 'u-carl' && last.sources.every((s) => s.userId !== 'u-carl'));
  check('team-cloud: the status line carries the gate\'s word',
    /Scott isn't in your session/.test(teamCloud.stateForUi().relayStatus.text));

  // The gate, fed exactly what team-cloud handed over: Scott pinned, in practice → nothing.
  const f = carlFrame();
  check('end to end: pinned Scott in practice puts nothing on the race car',
    applyTeammateRelay(f, { ...last, receivedAt: 10_000 }, 10_100) === f);

  // Off: the overlay read stops and the server is cleared.
  setting = 'off';
  teamCloud.relaySourceChanged();
  check('team-cloud: Off clears the overlay server at once', handed[handed.length - 1] === null);
  check('team-cloud: Off status', teamCloud.stateForUi().relayStatus.state === 'off');

  // Scott leaves the team: the pin falls back to Auto, persisted.
  setting = 'u-scott';
  teamCloud.relaySourceChanged();
  team.members = team.members.filter((m) => m.user_id !== 'u-scott');
  await teamCloud.refreshTeams();
  check('team-cloud: a pinned teammate leaving the team resets the setting to Auto',
    setting === 'auto' && teamCloud.stateForUi().relaySourceEffective.mode === 'auto', setting);
  teamCloud.setOverlayWanted(false);
  teamCloud.stop();
}

teamCloudFlow()
  .catch((e) => check('team-cloud flow ran', false, e && e.stack))
  .then(() => {
    console.log(`relay session gate: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
