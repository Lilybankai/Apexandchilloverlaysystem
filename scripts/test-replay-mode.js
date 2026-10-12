/**
 * scripts/test-replay-mode.js — the overlays while LMU plays a replay (THE-35).
 *
 * Pins three things:
 *
 *   1. Detection and focus — replay mode only on `/navigation/state`'s positive
 *      SETTING_REPLAY_PLAYBACK, and the overlays follow the replay CAMERA's car
 *      (`/rest/watch/focus`), never the row the recording marks `player`.
 *   2. Nothing from a replay escapes as ours — no lap/stop reaches the lap log
 *      (and so neither the upload, the leaderboards, the corpus nor a Discord
 *      PB), the engineer's trigger engine stays silent, the team relay neither
 *      publishes it nor splices a teammate into it, the Team history skips it.
 *   3. No stale numbers — the garage screens (tyre wear, damage, MFD, pit) and a
 *      shared-memory buffer that is not provably live never reach the frame.
 *   4. The replay's own live data (LMU's websockets on :6398) — opened only in
 *      a replay, closed on exit, built into the frame from a real capture, and
 *      every safeguard above still holding for a frame built from it; a dead
 *      feed falls back to the REST frame. The mapping itself is pinned in
 *      scripts/test-replay-feed.js.
 *
 * Drives the real provider's buildFrame with stubbed shared-memory readers and
 * spied recorders; no sim, no network. Live frames are built alongside as the
 * control, so a guard that broke the driving path would fail here too.
 *
 * Run: node scripts/test-replay-mode.js   (needs a built dist/)
 */

'use strict';

const path = require('node:path');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? `   [${detail}]` : ''));
  ok ? pass++ : fail++;
};

const dist = (...p) => path.join(__dirname, '..', 'dist', ...p);
const rm = require(dist('telemetry', 'replayMode.js'));
const { LmuRestProvider } = require(dist('telemetry', 'lmuRestProvider.js'));
const { EngineerTriggers } = require(dist('telemetry', 'triggers.js'));
const { applyTeammateRelay } = require(dist('telemetry', 'teammateRelay.js'));
const { eligibleToPublish } = require(path.join(__dirname, '..', 'electron', 'team-cloud.js'));
const { TeamHistory } = require(path.join(__dirname, '..', 'electron', 'team-history.js'));

const UNKNOWN = -1;

/* -------------------------------------------------------------------------- */
console.log('\ndetection — only the positive answer');
check('SETTING_REPLAY_PLAYBACK is a replay', rm.isReplayNav({ state: { settingMode: 'SETTING_REPLAY_PLAYBACK' } }));
check('another setting mode is not', !rm.isReplayNav({ state: { settingMode: 'SETTING_RACE' } }));
check('no state is not', !rm.isReplayNav({}));
check('null is not', !rm.isReplayNav(null));
check('isReplayFrame: flag true', rm.isReplayFrame({ session: { replay: true } }));
check('isReplayFrame: absent', !rm.isReplayFrame({ session: {} }));

console.log('\nfocus — the replay camera, then the old rule');
check('bare number', rm.parseFocusSlot(25) === 25);
check('numeric string', rm.parseFocusSlot(' 9 ') === 9);
check('junk', rm.parseFocusSlot({ slot: 3 }) === null && rm.parseFocusSlot(-1) === null && rm.parseFocusSlot('x') === null);
const rows = [
  { slotID: 1 },
  { slotID: 3, player: true, hasFocus: true },
  { slotID: 9 },
];
check('replay camera slot wins over hasFocus/player', rm.pickFocusCar(rows, 9).slotID === 9);
check('unknown camera slot falls back to hasFocus', rm.pickFocusCar(rows, 44).slotID === 3);
check('live (null) keeps the old rule', rm.pickFocusCar(rows, null).slotID === 3);
check('no focus at all → first row', rm.pickFocusCar([{ slotID: 5 }, { slotID: 6 }], null).slotID === 5);

/* -------------------------------------------------------------------------- */
console.log('\nshared-memory gate — a frozen buffer is never shown');
{
  const g = new rm.ReplayPhysicsGate();
  let t = 0;
  let ok = false;
  for (let i = 0; i < 40; i++) ok = g.accept(9, 1234.5, 180, 180, (t += 33)) || ok;
  check('constant clock, matching speed: never trusted', ok === false);

  g.reset();
  t = 0;
  let et = 100;
  const seen = [];
  for (let i = 0; i < 8; i++) seen.push(g.accept(9, (et += 0.033), 200, 203, (t += 33)));
  check('moving clock + agreeing speed: not on the first reads', seen[0] === false && seen[3] === false);
  check('…trusted after a run of agreement', seen[7] === true, seen.join(','));
  // A camera cut: same buffer, different car — starts from distrust.
  check('slot change drops trust', g.accept(12, (et += 0.033), 200, 203, (t += 33)) === false);

  g.reset();
  for (let i = 0; i < 8; i++) g.accept(9, (et += 0.033), 150, 150, (t += 33));
  let after = true;
  for (let i = 0; i < 6; i++) after = g.accept(9, (et += 0.033), 40, 250, (t += 33));
  check('sustained speed disagreement drops trust (another car’s record)', after === false);

  g.reset();
  for (let i = 0; i < 8; i++) g.accept(9, (et += 0.033), 150, 150, (t += 33));
  let frozen = true;
  for (let i = 0; i < 40; i++) frozen = g.accept(9, et, 150, 150, (t += 33)); // clock stops
  check('clock stops (buffer froze) → dropped within ~1 s', frozen === false);
}

console.log('\nseek detector');
{
  const s = new rm.ReplaySeekDetector();
  let t = 0;
  check('first sample is not a seek', s.update(1000, (t += 150)) === false);
  check('normal playback', s.update(1000.15, (t += 150)) === false);
  check('paused (same et)', s.update(1000.15, (t += 5000)) === false);
  check('fast-forward 8x is not a seek', s.update(1001.35, (t += 150)) === false);
  check('backwards jump is a seek', s.update(400, (t += 150)) === true);
  check('forward jump of minutes is a seek', s.update(3400, (t += 150)) === true);
}

/* -------------------------------------------------------------------------- */
console.log('\nprovider — a replay frame follows the camera and drives nothing');

// Steerable clock for every Date.now() inside the provider.
const realNow = Date.now;
let clock = 5_000_000;
Date.now = () => clock;

/** A shared-memory record shaped like LmuLocalCarReader.read's. */
function physics(over = {}) {
  const four = () => [80, 81, 82, 83];
  return {
    throttle: 0.8, brake: 0, clutch: 0, steer: 0.1, tc: 0, abs: 0, steerRangeDeg: 0,
    gear: 4, speedKph: 200, speedMps: 55.6, rpm: 7000, maxRpm: 8000,
    elapsedSec: 1000, lapNumber: 3, fuelLiters: 50, capacityLiters: 100,
    rearBrakeBias: 0.55, limiterOn: false, batteryCharge: 0.5, motorTorqueNm: 100,
    tyreTempsC: four(), tyreHudTempsC: four(), tyreCoreC: four(), tyreBrakeC: four(),
    tyrePressureKpa: four(), tyreSurfaceBandsC: [null, null, null, null],
    tyreLinerBandsC: [null, null, null, null], motion: null, rawCorners: null,
    chassis: null, aidSettings: null,
    ...over,
  };
}

function makeProvider() {
  const p = new LmuRestProvider({ verbose: false });
  const reads = [];
  p.__sm = { bySlot: new Map() };
  p.localCar = {
    read: (slot) => {
      reads.push(slot);
      const f = p.__sm.bySlot.get(slot);
      return f ? f() : null;
    },
    readField: () => null,
    inRealtime: () => null,
    sessionClock: () => null, // THE-33 reads the event clock here; no shared memory in this stub
    sectorFlagBytes: () => [1, 1, 1], // a frozen buffer showing yellow everywhere
    available: () => true,
    start: () => {},
    stop: () => {},
  };
  p.scoring = {
    read: () => null,
    readPlayerName: () => '',
    readTrackName: () => '',
    readServerName: () => '', // THE-34's relay session identity; offline in this stub
    start: () => {},
    stop: () => {},
  };
  const spy = { laps: 0, stops: 0 };
  p.lapRecorder = { update: () => { spy.laps++; return null; } };
  p.stopRecorder = { update: () => { spy.stops++; return null; } };
  // Garage screens with data in them — THIS PC's car, which a replay must not show.
  p.tyreWear = [0.91, 0.92, 0.93, 0.94];
  p.lastGarageOkAt = clock;
  p.damage = { aero: 0.2, stopLengthSeconds: 0 };
  p.lastDamageOkAt = clock;
  return { p, spy, reads };
}

function standingsRows(laps) {
  return [
    {
      slotID: 3, driverName: 'Carl Jones', carClass: 'LMGT3', carNumber: '87', position: 4,
      lapsCompleted: laps, bestLapTime: 100, lastLapTime: 101, lapDistance: 1200, player: true,
      hasFocus: false, carVelocity: { velocity: 50 }, fuelFraction: 0.6, countLapFlag: 'COUNT_LAP_AND_TIME',
    },
    {
      slotID: 9, driverName: 'Roffe', carClass: 'LMGT3', carNumber: '23', position: 2,
      lapsCompleted: laps, bestLapTime: 99, lastLapTime: 99.5, lapDistance: 3000, hasFocus: true,
      carVelocity: { velocity: 60 }, fuelFraction: 0.4,
    },
  ];
}
const sessionInfo = (et) => ({
  trackName: 'Spa', session: 'RACE1', lapDistance: 7000, currentEventTime: et,
  endEventTime: 20000, gamePhase: 5, numberOfVehicles: 2,
});

function frame(p, laps, et, replayState, cameraSlot) {
  p.standings = standingsRows(laps);
  p.session = sessionInfo(et);
  p.replayPlayback = replayState;
  p.replayFocusSlot = replayState === true ? cameraSlot : null;
  p.lastOkAt = clock;
  return p.buildFrame(clock);
}

(async () => {
try {
  // ---- control: a live frame is built exactly as before --------------------
  {
    const { p, spy } = makeProvider();
    p.__sm.bySlot.set(3, () => physics({ elapsedSec: clock / 1000 }));
    const f = frame(p, 5, 1000, false, null);
    check('live: no replay flag', f.session.replay === undefined);
    check('live: player block is the focused car (slot 9 hasFocus)', f.player.slotId === 9);
    check('live: our row is still marked own', f.standings.some((r) => r.slotId === 3 && r.isOwn === true));
    check('live: lap log fed', spy.laps === 1 && spy.stops === 1, `${spy.laps}/${spy.stops}`);
    check('live: shared-memory sector flags still read', Array.isArray(f.session.sectorFlags) && f.session.sectorFlags[0] === 'yellow');
  }

  // ---- replay --------------------------------------------------------------
  const { p, spy } = makeProvider();
  // A FROZEN buffer for the camera car: same clock every read.
  p.__sm.bySlot.set(9, () => physics({ elapsedSec: 777, speedKph: 216 }));
  p.__sm.bySlot.set(3, () => physics({ elapsedSec: 777 }));
  let f;
  let et = 4000;
  for (let i = 0; i < 30; i++) {
    clock += 33;
    if (i % 5 === 0) et += 0.15;
    f = frame(p, 10 + Math.floor(i / 3), et, true, 9); // laps tick over while watching
  }
  check('replay: session.replay set', f.session.replay === true);
  check('replay: onTrack false (no consumer thinks anyone is driving)', f.session.onTrack === false);
  check('replay: player block is the CAMERA car, not the recording’s player row', f.player.slotId === 9, f.player.slotId);
  check('replay: standings isPlayer = camera car', f.standings.find((r) => r.isPlayer).slotId === 9);
  check('replay: no row is ours', !f.standings.some((r) => r.isOwn === true));
  check('replay: lap log never fed (no upload, board, corpus or PB)', spy.laps === 0, spy.laps);
  check('replay: stop log never fed (strategy corpus)', spy.stops === 0, spy.stops);
  check('replay: no MFD (pit menu is this PC’s car)', f.mfd === undefined);
  check('replay: no radar', f.radar === undefined);
  check('replay: track map marks the camera car', !!f.trackMap &&
    f.trackMap.cars.filter((c) => c.isPlayer).map((c) => c.slotId).join() === '9');
  check('replay: no damage from the garage screen', f.player.damage === undefined);
  check('replay: no pit block', f.player.pit === undefined);
  check('replay: no track limits', f.player.trackLimits === undefined);
  check('replay: tyre wear blanked (garage car’s 0.91 not shown)', f.player.tyres.frontLeft.wear === UNKNOWN, f.player.tyres.frontLeft.wear);
  check('replay: frozen buffer → no gear/rpm', f.player.gear === UNKNOWN && f.player.rpm === UNKNOWN, `${f.player.gear}/${f.player.rpm}`);
  check('replay: frozen buffer → flat pedals, REST speed', f.player.pedals.throttle === 0 && f.player.speedKph === 216, f.player.speedKph);
  check('replay: fuel litres blank (laps-only)', f.fuel.levelLiters === UNKNOWN);
  check('replay: frozen shared-memory sector flags ignored', !f.session.sectorFlags || !f.session.sectorFlags.includes('yellow'));

  // A buffer that IS live for the camera car: clock moves, speed agrees with REST.
  let smEt = 2000;
  p.__sm.bySlot.set(9, () => physics({ elapsedSec: (smEt += 0.033), speedKph: 214, gear: 5, rpm: 7600 }));
  for (let i = 0; i < 8; i++) {
    clock += 33;
    f = frame(p, 20, (et += 0.033), true, 9);
  }
  check('replay: live buffer for the camera car → gear/rpm shown', f.player.gear === 5 && f.player.rpm === 7600, `${f.player.gear}/${f.player.rpm}`);
  check('replay: …with dead channels still blank (fuel litres, temps)', f.player.tyres.frontLeft.tempC === UNKNOWN);
  check('replay: still no lap logged', spy.laps === 0);

  // Camera cut to the car the recording calls "player": still not ours.
  clock += 33;
  f = frame(p, 20, (et += 0.033), true, 3);
  check('camera cut to the recording’s player row: followed', f.player.slotId === 3);
  check('…and still nothing is ours', !f.standings.some((r) => r.isOwn === true) && spy.laps === 0);

  // A seek bumps the epoch (learned state reset).
  const before = p.replayEpoch;
  clock += 150;
  f = frame(p, 20, 600, true, 3);
  check('backwards seek starts a new replay epoch', p.replayEpoch === before + 1, `${before}→${p.replayEpoch}`);

  // Leaving the replay: the live path comes straight back.
  clock += 150;
  f = frame(p, 21, 50, false, null);
  check('back to live: no replay flag', f.session.replay === undefined && f.session.onTrack !== false);
  check('back to live: our row is ours again', f.standings.some((r) => r.slotId === 3 && r.isOwn === true));
  check('back to live: lap log fed again', spy.laps === 1, spy.laps);

  // Not yet known (navigation/state unanswered): a lap is not written.
  const { p: p2, spy: spy2 } = makeProvider();
  frame(p2, 5, 1000, null, null);
  check('replay state unknown: lap log not fed', spy2.laps === 0 && spy2.stops === 0);
  check('replay state unknown: frame is NOT marked replay (positive detection only)', frame(p2, 5, 1000, null, null).session.replay === undefined);

  /* ------------------------------------------------------------------------ */
  console.log('\ndownstream — engineer, relay, team history');
  const liveFrame = frame(makeProvider().p, 5, 1000, false, null);
  const rf = frame(makeProvider().p, 5, 1000, true, 9);

  // The same replay frames, once as they are and once with the replay flag
  // stripped (the control): the control must make the engineer talk, or the
  // silence proves nothing.
  const runTriggers = (strip) => {
    const trig = new EngineerTriggers({});
    let cues = 0;
    for (let i = 0; i < 60; i++) {
      const x = JSON.parse(JSON.stringify(rf));
      if (strip) { delete x.session.replay; x.session.onTrack = true; }
      x.timestamp = 1_000_000 + i * 20_000;
      // A start (formation → green), then a yellow, then the chequer: calls the
      // engineer makes in every live race.
      x.session.phase = i < 5 ? 'formation' : i < 40 ? 'green' : 'checkered';
      x.session.notStarted = i < 5;
      x.session.flag = i >= 20 && i < 25 ? 'yellow' : i >= 40 ? 'checkered' : 'green';
      x.session.finalLap = i >= 38;
      if (trig.update(x, x.timestamp)) cues++;
    }
    return { trig, cues };
  };
  const control = runTriggers(true);
  check('control: the same frames, unflagged, DO make the engineer talk', control.cues > 0, control.cues);
  const { trig, cues } = runTriggers(false);
  check('engineer triggers: silent for a whole replay', cues === 0, cues);
  const lf = JSON.parse(JSON.stringify(liveFrame));
  lf.timestamp = 9_000_000;
  check('engineer triggers: first live frame after a replay primes (no edge fired)', trig.update(lf, lf.timestamp) === null);

  const withTyres = JSON.parse(JSON.stringify(rf));
  withTyres.player.tyres.frontLeft.wear = 0.8;
  const snap = { car: { tyres: withTyres.player.tyres } };
  const unflagged = JSON.parse(JSON.stringify(withTyres));
  delete unflagged.session.replay;
  unflagged.session.onTrack = true;
  // THE-34: the publisher only speaks for the car driven on this PC.
  for (const r of unflagged.standings || []) if (r && r.isPlayer) r.isOwn = true;
  check('control: the unflagged frame would be published', eligibleToPublish(unflagged, snap) === true);
  check('team relay: a replay frame is never published', eligibleToPublish(withTyres, snap) === false);

  // A fresh relay row for the very car on the replay camera (#23, LMGT3, Spa).
  const corner = { wear: 0.5, tempC: 90 };
  const relay = {
    receivedAt: clock,
    sources: [{
      name: 'Teammate', ageSec: 0.5,
      snapshot: {
        connected: true, session: { track: 'Spa' },
        car: { carNumber: '23', carClass: 'GT3',
          tyres: { frontLeft: corner, frontRight: corner, rearLeft: corner, rearRight: corner } },
      },
    }],
  };
  // A teammate in our car, identity complete, as THE-34's relay gate demands —
  // so the only difference between the control and the replay frame is the flag.
  const asTeammateDriving = (x) => {
    const r = (x.standings || []).find((s) => s && s.isPlayer);
    if (r) { r.isOwn = false; r.teammateDriving = true; }
    if (!x.session.type) x.session.type = 'race';
    return r;
  };
  const rfTeam = JSON.parse(JSON.stringify(rf));
  const ourRow = asTeammateDriving(rfTeam);
  relay.sources[0].snapshot.session.type = rfTeam.session.type;
  relay.sources[0].snapshot.car.driverName = ourRow ? ourRow.driverName : undefined;
  const rfUnflagged = JSON.parse(JSON.stringify(rfTeam));
  delete rfUnflagged.session.replay;
  check('control: the unflagged frame WOULD take the relay', applyTeammateRelay(rfUnflagged, relay, clock) !== rfUnflagged);
  check('team relay: never spliced into a replay frame', applyTeammateRelay(rfTeam, relay, clock) === rfTeam);

  const hist = new TeamHistory();
  const hf = JSON.parse(JSON.stringify(rf));
  hist.update(hf);
  check('team history: replay frames ignored', hist.cars.size === 0);
  const hist2 = new TeamHistory();
  hist2.update(rfUnflagged);
  check('control: the unflagged frame IS recorded', hist2.cars.size > 0, hist2.cars.size);

  // Training layer and Practice Review (claude/training-overlays): a replay of
  // a practice session is not practice.
  const { sessionOfFrame } = require('../electron/trainingGate');
  const { sessionTypeOf } = require('../electron/practiceSession');
  const practiceReplay = { connected: true, source: 'lmu', session: { type: 'practice', replay: true } };
  const practiceLive = { connected: true, source: 'lmu', session: { type: 'practice', onTrack: true } };
  check('control: a live practice frame reads as practice (training gate)', sessionOfFrame(practiceLive).type === 'practice');
  check('training gate: a practice REPLAY is not practice', sessionOfFrame(practiceReplay).type !== 'practice');
  check('control: a live practice frame reads as practice (practice review)', sessionTypeOf(practiceLive) === 'practice');
  check('practice review: a practice REPLAY is not practice', sessionTypeOf(practiceReplay) !== 'practice');

  /* ------------------------------------------------------------------------ */
  console.log('\nreplay websockets — the replay’s own live data (THE-35 follow-up)');
  const { ReplayFeed } = require(dist('telemetry', 'replayFeed.js'));
  const fx = require('./fixtures/replay-ws-road-atlanta.json');

  /** Fake ws clients the provider's feed is given instead of real sockets. */
  const fakeSockets = () => {
    const made = [];
    const factory = (url) => {
      const h = {};
      const s = {
        url, sent: [], closed: false,
        on(ev, fn) { (h[ev] = h[ev] || []).push(fn); },
        send(d) { s.sent.push(d); },
        close() { s.closed = true; }, terminate() { s.closed = true; },
        fire(ev, arg) { for (const fn of h[ev] || []) fn(arg); },
      };
      made.push(s);
      return s;
    };
    return { made, factory };
  };

  // Socket lifecycle through the provider's own replay detection.
  {
    const { p } = makeProvider();
    const { made, factory } = fakeSockets();
    p.replayFeed = new ReplayFeed({ port: 6398, factory });
    let nav = 'SETTING_RACE';
    p.getJson = async (route) => {
      if (route === '/navigation/state') return { state: { settingMode: nav } };
      throw new Error('not stubbed: ' + route);
    };
    await p.refreshReplayMode();
    check('live session: no replay socket is ever opened', made.length === 0 && !p.replayFeed.isActive());
    nav = 'SETTING_REPLAY_PLAYBACK';
    await p.refreshReplayMode();
    check('replay detected: both replay sockets open', made.length === 2 && p.replayFeed.isActive());
    await p.refreshReplayMode();
    check('still in the replay: no extra sockets', made.length === 2);
    nav = 'SETTING_RACE';
    await p.refreshReplayMode();
    check('replay exit: both sockets closed', made.every((s) => s.closed) && !p.replayFeed.isActive());
    nav = 'SETTING_REPLAY_PLAYBACK';
    await p.refreshReplayMode();
    p.stop();
    check('provider stop closes them too', made.slice(2).every((s) => s.closed) && !p.replayFeed.isActive());
  }

  // A frame built from the feed — and every safeguard still holding.
  const restSessionRA = {
    trackName: 'Michelin Raceway Road Atlanta', session: 'RACE1', lapDistance: fx.trackLengthM,
    currentEventTime: 0, endEventTime: fx.endEventTime, gamePhase: 9, numberOfVehicles: 39,
    timeRemainingInGamePhase: 12486, sectorFlag: ['YELLOW', 'UNKNOWN', 'UNKNOWN'],
  };
  // REST in a replay: the LOADED session's rows, frozen — other drivers, lap 0,
  // a fuel fraction, a FORMATION phase. None of it may reach the frame.
  const frozenRest = () => [
    { slotID: 2, driverName: 'Urtubia Javitxu', carClass: 'GT3', carNumber: '399', position: 3,
      lapsCompleted: 0, bestLapTime: -1, lastLapTime: 0, lapDistance: -0.6, hasFocus: true,
      carVelocity: { velocity: 0 }, fuelFraction: 0.83, gamePhase: 'FORMATION', flag: 'GREEN',
      vehicleFilename: '397_26_AMV', carId: 'amr-car-id', timeBehindLeader: 1.6, player: true },
    { slotID: 3, driverName: 'Someone Else', carClass: 'Hyper', carNumber: '73', position: 1,
      lapsCompleted: 0, bestLapTime: -1, lastLapTime: 0, lapDistance: 0, carVelocity: { velocity: 0 },
      fuelFraction: 0.9, gamePhase: 'FORMATION' },
  ];
  const wsFrame = (p, fire, restFocus = Number(fx.restFocus)) => {
    if (fire) fire();
    p.standings = frozenRest();
    p.session = { ...restSessionRA };
    p.replayPlayback = true;
    p.replayFocusSlot = restFocus;
    p.lastOkAt = clock;
    return p.buildFrame(clock);
  };
  {
    const { p, spy } = makeProvider();
    p.manufacturerById.set('amr-car-id', 'Aston Martin');
    const { made, factory } = fakeSockets();
    p.replayFeed = new ReplayFeed({ port: 6398, factory });
    p.replayFeed.setActive(true);
    const ui = made.find((s) => s.url.endsWith('/ui'));
    const rm = made.find((s) => s.url.endsWith('/replaymetrics'));
    ui.fire('open');
    rm.fire('open');
    const m0 = fx.replaymetrics[0].msg.body;
    const et0 = m0.replayStartET + m0.currentReplayPos;
    clock += 50;
    const f = wsFrame(p, () => {
      rm.fire('message', JSON.stringify(fx.replaymetrics[0].msg));
      ui.fire('message', JSON.stringify(fx.ui[0].msg));
    });
    check('ws frame: still a replay, nobody driving', f.session.replay === true && f.session.onTrack === false);
    check('ws frame: the whole replay field, not the frozen REST two', f.standings.length === 39, f.standings.length);
    check('ws frame: standings in the replay’s order (P1 Chastain)', f.standings[0].driverName === 'Oliver Chastain' && f.standings[0].position === 1);
    const me = f.standings.find((r) => r.isPlayer);
    check('ws frame: the camera car is the RECORDING’s driver, not REST’s', me && me.slotId === 2 && me.driverName === 'M Aranguren', me && me.driverName);
    check('ws frame: P2 shows its laps down, not a seconds gap', f.standings[1].lapsBehind === 6 && f.standings[1].gapToLeaderSec === UNKNOWN);
    check('ws frame: manufacturer joined by vehicle file', me.manufacturer === 'Aston Martin', me.manufacturer);
    check('ws frame: player block = camera car', f.player.slotId === 2);
    check('ws frame: speed from replaymetrics, mph → km/h', f.player.speedKph === Math.round(m0.speed * 1.609344), f.player.speedKph);
    check('ws frame: gear / rpm / pedals live', f.player.gear === m0.gear && f.player.rpm === m0.rpm && f.player.maxRpm === m0.maxRPM && f.player.pedals.throttle === m0.throttle);
    check('ws frame: lap clock / last lap / sector from the sim', f.player.lap.current === Math.round(m0.timeIntoLap * 100) / 100 && f.player.lap.last === Math.round(m0.finalLapTime * 1000) / 1000 && f.player.lap.sector === m0.sectorNum);
    check('ws frame: the replay clock, not REST’s frozen 0', Math.abs(f.session.elapsedSec - et0) < 0.11, f.session.elapsedSec);
    check('ws frame: time remaining = booked end − replay clock', Math.abs(f.session.timeRemainingSec - (fx.endEventTime - et0)) <= 1, f.session.timeRemainingSec);
    check('ws frame: phase from the replay (green), not REST’s frozen FORMATION', f.session.phase === 'green' && f.session.notStarted === false);
    check('ws frame: frozen REST yellow not on the rail', f.session.sectorFlags === undefined);
    const dot = f.trackMap && f.trackMap.cars.find((c) => c.slotId === 2);
    const raw = fx.ui[0].msg.body.find((r) => r.slotID === 2);
    check('ws frame: map dot at the replay’s world position', dot && dot.x === Math.round(raw.posX * 100) / 100 && dot.z === Math.round(raw.posZ * 100) / 100 && dot.isPlayer === true);
    check('ws frame: relative built around the camera car', f.relative.some((r) => r.isPlayer && r.slotId === 2) && f.relative.length > 1);
    check('ws frame: no fuel from REST’s frozen fraction', f.fuel.levelFraction === undefined || f.fuel.levelFraction === UNKNOWN || f.fuel.levelLiters === UNKNOWN);
    check('ws frame: no tyres / damage / MFD / radar / limits', f.player.tyres.frontLeft.wear === UNKNOWN && f.player.damage === undefined && f.mfd === undefined && f.radar === undefined && f.player.trackLimits === undefined);
    check('ws frame: no hybrid, no motion invented', f.player.hybrid === undefined && f.player.motion === undefined);
    check('ws frame: no row is ours (REST’s player:true row ignored)', !f.standings.some((r) => r.isOwn === true));

    // Three channels name the camera car; a cut REST has not caught up with
    // yet must not put one car's pedals under another car's name.
    clock += 20;
    const lagging = wsFrame(p, null, 3);
    check('camera reconcile: REST focus lagging a cut → the car the metrics describe', lagging.player.slotId === 2 && lagging.player.gear === m0.gear, lagging.player.slotId);
    clock += 20;
    const unknownSlot = wsFrame(p, null, 77);
    check('camera reconcile: REST focus on no row → the car the metrics describe', unknownSlot.player.slotId === 2);

    // Play the 30 s through; the lap log, stop log and engineer stay out of it.
    const trig = new EngineerTriggers({});
    let cues = 0;
    let last = f;
    for (let i = 0; i < 60; i++) {
      clock += 150;
      const m = JSON.parse(JSON.stringify(fx.replaymetrics[0].msg));
      m.body.currentReplayPos += i * 0.15;
      last = wsFrame(p, () => {
        rm.fire('message', JSON.stringify(m));
        ui.fire('message', JSON.stringify(fx.ui[i % 2].msg));
      });
      if (trig.update(last, last.timestamp)) cues++;
    }
    check('ws replay: lap log never fed', spy.laps === 0, spy.laps);
    check('ws replay: stop log never fed', spy.stops === 0, spy.stops);
    check('ws replay: engineer silent', cues === 0, cues);
    const snapWs = { car: { tyres: last.player.tyres } };
    check('ws replay: never published to the team relay', eligibleToPublish(last, snapWs) === false);
    const histWs = new TeamHistory();
    histWs.update(JSON.parse(JSON.stringify(last)));
    check('ws replay: team history ignores it', histWs.cars.size === 0);
    const relayWs = JSON.parse(JSON.stringify(last));
    check('ws replay: no teammate spliced in', applyTeammateRelay(relayWs, relay, clock) === relayWs);
    const practiceWs = JSON.parse(JSON.stringify(last));
    practiceWs.session.type = 'practice';
    check('ws replay: training gate / practice review do not see practice',
      sessionOfFrame(practiceWs).type !== 'practice' && sessionTypeOf(practiceWs) !== 'practice');

    // A dead feed degrades to the frame the replay had before the feed existed.
    ui.fire('close');
    rm.fire('close');
    clock += 2500;
    const dead = wsFrame(p);
    check('feed dropped: frame falls back to REST (no crash)', dead.session.replay === true && dead.standings.length === 2, dead.standings.length);
    check('feed dropped: still nothing logged', spy.laps === 0 && spy.stops === 0);
    p.replayFeed.setActive(false);
  }

  // Live driving with a (hypothetically) chatty feed object: never consulted.
  {
    const { p, spy } = makeProvider();
    p.__sm.bySlot.set(3, () => physics({ elapsedSec: clock / 1000 }));
    const { made, factory } = fakeSockets();
    p.replayFeed = new ReplayFeed({ port: 6398, factory });
    const lf2 = frame(p, 5, 1000, false, null);
    check('live: no socket, REST standings, lap log fed', made.length === 0 && lf2.standings.length === 2 && spy.laps === 1);
  }
} finally {
  Date.now = realNow;
}

/* -------------------------------------------------------------------------- */
console.log('\noverlay — widgets with nothing true to say about a replay step aside');
{
  const fs = require('node:fs');
  const vm = require('node:vm');
  const el = () => ({
    attrs: {}, children: [], classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; }, appendChild(c) { return c; }, querySelector() { return null; },
  });
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      readyState: 'loading', documentElement: el(), createElement: el,
      querySelector: () => null, getElementById: () => null, addEventListener: () => {},
    },
    window: { addEventListener: () => {}, location: { search: '', protocol: 'http:' } },
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'overlay', 'js', 'client.js'), 'utf8'), sandbox);
  const { replayHides } = sandbox.window.ApexOverlay;
  const withGear = { player: { gear: 4 } };
  const noGear = { player: { gear: -1 } };
  // fuel joined the list with the replay feed: the replay carries no fuel at
  // all, and REST's fraction is the loaded session's, frozen at its start.
  for (const w of ['tyres', 'damage', 'mfd', 'fuel', 'fuelplan', 'radar', 'limits', 'motion', 'refpace', 'ghosthud']) {
    check(`${w}: hidden in a replay`, replayHides(w, withGear) === true);
  }
  for (const w of ['standings', 'relative', 'delta', 'pacedelta', 'racecontrol', 'weather', 'trackmap', 'speedo']) {
    check(`${w}: shown in a replay`, replayHides(w, noGear) === false);
  }
  check('pedals: hidden while the camera car has no live inputs', replayHides('pedals', noGear) === true);
  check('pedals: shown once it has', replayHides('pedals', withGear) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
