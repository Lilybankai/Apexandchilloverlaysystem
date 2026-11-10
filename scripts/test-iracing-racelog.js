/**
 * test-iracing-racelog.js — Review ▸ Race log for iRacing, from local data.
 * -----------------------------------------------------------------------------
 * iRacing writes no results file and the Data API is off-limits, so the race
 * log is the session-info YAML's ResultsPositions (kept on disk by
 * telemetry/iracing/raceResults.ts) joined to the generic live recorder
 * (raceLogRecorder.ts, header source 'iracing'). Checked here, on the committed
 * anonymised fixture (scripts/fixtures/iracing-cap1, a race 2 laps in) and on
 * a synthetic finished + official copy of it:
 *
 *   1. buildRaceSnapshot: grid from QualifyResultsInfo (0-based → 1-based),
 *      positions, laps, best laps, status, and the field's incidents only once
 *      official (they read 0 live).
 *   2. IrRaceResultsRecorder: throttled writes, urgent on chequered/official,
 *      nothing in a replay or with no folder, flush on the way out.
 *   3. The provider writes the copy (raceResultsDir) from a real fixture frame.
 *   4. irRaceLog: the copy paired with a live recording made by the REAL
 *      recorder from iRacing-shaped frames; incident steps in iRacing's words;
 *      the results' finish; the classification; a live-only race listed
 *      provisional; LMU's race list never shows an iRacing race.
 *   5. The wiring: main answers review:racelogs/racelog in iRacing mode, the
 *      Review panel offers the Race log tab there, the renderer drops the
 *      replay and the car picker for an iRacing log.
 *
 * Run: npm run test:iracing-racelog   (needs `npm run build` first)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const dist = (p) => require(path.join(__dirname, '..', 'dist', 'telemetry', p));
const { parseSessionInfo } = dist('iracing/sessionInfo.js');
const { buildRaceSnapshot, IrRaceResultsRecorder, WRITE_EVERY_MS } = dist('iracing/raceResults.js');
const { IRacingProvider } = dist('iracing/iracingProvider.js');
const ir = dist('iracing/irRaceLog.js');
const { RaceLogRecorder, liveFileFor } = dist('raceLogRecorder.js');
const { listRaceLogs } = dist('raceLog.js');

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
const yamlLive = zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'session-145.yaml.gz'))).toString('latin1');
const frames = zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'frames.ndjson.gz'))).toString('utf8').trim().split('\n');
const raceRow = JSON.parse(frames[frames.length - 1]);
const OWN = raceRow.PlayerCarIdx;
const TRACK = 'Winton Motor Raceway - National';

/**
 * The fixture's race, finished and official: the race session's
 * ResultsOfficial set, real incident counts, one DQ.
 */
function yamlOfficial() {
  const i = yamlLive.indexOf('SessionType: Race');
  let head = yamlLive.slice(0, i);
  let race = yamlLive.slice(i);
  race = race.replace(/ResultsOfficial: 0/, 'ResultsOfficial: 1');
  let n = 0;
  race = race.replace(/Incidents: 0/g, () => `Incidents: ${[0, 2, 6, 1, 4, 0, 8, 3, 0, 5, 2][n++ % 11]}`);
  // The car classified last: disqualified (iRacing's ReasonOutId 29).
  const end = race.indexOf('ResultsAverageLapTime');
  const at = race.lastIndexOf('ReasonOutId: 0', end);
  const fixed = race.slice(at).replace(/^ReasonOutId: 0(\r?\n\s+ReasonOutStr: )Running/, 'ReasonOutId: 29$1DQ');
  race = race.slice(0, at) + fixed;
  return head + race;
}

const teleOf = (over = {}) => ({
  sessionNum: 2,
  sessionTimeSec: raceRow.SessionTime,
  sessionState: 4,
  track: TRACK,
  ourIncidents: 0,
  replay: false,
  ...over,
});

// ── 1. buildRaceSnapshot ─────────────────────────────────────────────────────
const info = parseSessionInfo(yamlLive);
const live0 = buildRaceSnapshot(info, teleOf(), null, raceRow._t);
{
  check('fixture: a race copy is built', !!live0);
  check('id from subsession + session number', live0.id === 'ir-1-2', live0.id);
  check('session start = wall clock minus SessionTime', Math.abs(live0.sessionStartMs - (raceRow._t - raceRow.SessionTime * 1000)) < 2);
  const me = live0.cars.find((c) => c.carIdx === OWN);
  check('our car is in it', !!me);
  check('our place from ResultsPositions', me.position === 3, me.position);
  check('grid from QualifyResultsInfo, 0-based → P2', me.gridPosition === 2, me.gridPosition);
  check('pole sitter is P1 on the grid', live0.cars.find((c) => c.carIdx === 7).gridPosition === 1);
  check('laps complete', me.laps === 2);
  check('best lap in ms', me.bestLapMs === 94890, me.bestLapMs);
  check('a live race: status Running', me.status === 'Running');
  check('a live race: the field\'s incidents are unknown, not 0', live0.cars.every((c) => c.incidents === null));
  check('the DQ limit is carried', live0.incidentLimit === 17);
  check('not multiclass (one class in the fixture)', live0.multiclass === false);
  check('drivers seen are remembered', me.drivers.length === 1 && me.drivers[0] === me.driver);
  check('practice is not a race', buildRaceSnapshot(info, teleOf({ sessionNum: 0 }), null, raceRow._t) === null);

  const swapped = { ...info, drivers: info.drivers.map((d) => (d.carIdx === OWN ? { ...d, userName: 'Second Driver' } : d)) };
  const after = buildRaceSnapshot(swapped, teleOf(), live0, raceRow._t + 1000);
  check('a swap adds the new driver, keeps the first', after.cars.find((c) => c.carIdx === OWN).drivers.join() === `${me.driver},Second Driver`);

  const off = parseSessionInfo(yamlOfficial());
  const fin = buildRaceSnapshot(off, teleOf({ sessionState: 6, ourIncidents: 7 }), live0, raceRow._t + 60_000);
  const me2 = fin.cars.find((c) => c.carIdx === OWN);
  check('official: results flagged official', fin.resultsOfficial === true);
  check('official: the field\'s incidents appear', fin.cars.some((c) => c.incidents > 0));
  check('after the flag: Finished', me2.status === 'Finished');
  check('our incidents from telemetry', fin.ourIncidents === 7);
  check('a DQ keeps iRacing\'s word', fin.cars.some((c) => c.status === 'DQ'), fin.cars.map((c) => c.status).join());
  check('the start time is kept from the first copy', fin.sessionStartMs === live0.sessionStartMs);
}

// ── 2. The recorder ─────────────────────────────────────────────────────────
async function recorderChecks() {
  const written = [];
  const io = {
    mkdir: async () => undefined,
    writeFile: async (f, t) => { written.push({ f, t }); },
    rename: async () => undefined,
  };
  const rec = new IrRaceResultsRecorder('X:/nowhere', io);
  let t = raceRow._t;
  rec.update(info, teleOf(), t);
  await rec.flush();
  check('first copy written at once', written.length === 1);
  const info2 = { ...info }; // a new parse, same content
  rec.update(info2, teleOf(), (t += 1000));
  await rec.flush();
  check('unchanged content is not rewritten', written.length === 1, written.length);
  const moved = { ...info, sessions: info.sessions.map((s) => (s.num === 2 ? { ...s, results: s.results.map((r) => ({ ...r, lapsComplete: r.lapsComplete + 1 })) } : s)) };
  rec.update(moved, teleOf(), (t += 1000));
  check('a change inside the throttle waits', written.length === 1);
  rec.update(moved, teleOf({ sessionState: 5 }), (t += 1000));
  await new Promise((r) => setImmediate(r));
  await rec.flush();
  check('the chequered flag writes at once', written.length === 2, written.length);
  const moved2 = { ...moved, sessions: moved.sessions.map((s) => (s.num === 2 ? { ...s, results: s.results.map((r) => ({ ...r, lapsComplete: r.lapsComplete + 1 })) } : s)) };
  rec.update(moved2, teleOf({ sessionState: 5 }), (t += 1000));
  await rec.flush();
  check('flush writes a pending change', written.length === 3, written.length);
  rec.update(moved2, teleOf({ sessionState: 5, replay: true, ourIncidents: 9 }), (t += WRITE_EVERY_MS + 1));
  await rec.flush();
  check('a replay records nothing', written.length === 3 && rec.current().ourIncidents !== 9);
  check('the file is <id>.json.tmp, renamed', /ir-1-2\.json\.tmp$/.test(written[0].f));
  const none = new IrRaceResultsRecorder(null, io);
  none.update(info, teleOf(), t);
  await none.flush();
  check('no folder: nothing written', written.length === 3);
}

// ── 3. The provider writes it ───────────────────────────────────────────────
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

async function providerChecks(tmp) {
  const dir = path.join(tmp, 'prov');
  const source = {
    open: () => true, close() {}, isOpen: () => true, connected: () => true,
    read: () => frameOf(raceRow), sessionInfoUpdate: () => 1,
    readSessionInfo: () => Buffer.from(yamlLive, 'latin1'),
  };
  const p = new IRacingProvider({ verbose: false }, { source, lapSink: null, raceResultsDir: dir });
  p.start();
  const fr = p.poll(raceRow._t, 100);
  await p.raceResults.flush();
  p.stop();
  const file = path.join(dir, 'ir-1-2.json');
  check('provider: frame is a live race', fr.connected && fr.session.type === 'race');
  check('provider: the results copy is on disk', fs.existsSync(file));
  const snap = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  check('provider: the copy names the frame\'s track', snap && snap.track === fr.session.track, snap && snap.track);
  const quiet = new IRacingProvider({ verbose: false }, { source, lapSink: null });
  check('provider with a test source writes nowhere by default', quiet.raceResults && quiet.raceResults.current() === null);
}

// ── 4. irRaceLog against a real live recording ──────────────────────────────
/** A minimal iRacing-shaped frame for the generic recorder. */
function liveFrame(t, o) {
  const row = {
    slotId: OWN, position: o.pos, classPosition: o.pos, isOwn: true, isPlayer: true,
    lapsCompleted: o.laps, lastLapSec: o.last ?? -1, inPit: !!o.pit, driverName: 'Driver 8',
    carNumber: '9', carClass: 'BMW M2 G87',
  };
  return {
    schemaVersion: 1, source: 'iracing', connected: true, timestamp: t,
    session: {
      type: 'race', phase: o.phase || 'green', flag: 'green', track: TRACK,
      elapsedSec: o.et, notStarted: o.phase === 'countdown', finalLap: false, onTrack: true,
    },
    player: { trackLimits: { points: o.inc ?? 0, pointsLimit: 17, penalties: o.black ? 1 : 0 } },
    standings: [row, { ...row, slotId: 2, position: 1, classPosition: 1, isOwn: undefined, isPlayer: false, driverName: 'Driver 2' }],
  };
}

async function logChecks(tmp) {
  const stateDir = path.join(tmp, 'racelog');
  const irDir = path.join(stateDir, 'iracing');
  fs.mkdirSync(irDir, { recursive: true });
  const start = live0.sessionStartMs;
  const rec = new RaceLogRecorder();
  const lines = [];
  const feed = (et, o) => lines.push(...rec.update(liveFrame(start + et * 1000, { et, ...o }), start + et * 1000));
  feed(100, { phase: 'countdown', pos: 2, laps: 0 });
  feed(101, { pos: 2, laps: 0 });
  feed(150, { pos: 2, laps: 0, inc: 1 });
  feed(190, { pos: 3, laps: 1, last: 95.1, inc: 1 });
  feed(194, { pos: 3, laps: 1, last: 95.1, inc: 3 });
  feed(230, { pos: 3, laps: 1, last: 95.1, inc: 7, black: true });
  feed(260, { pos: 3, laps: 1, last: 95.1, inc: 7 });
  feed(285, { pos: 3, laps: 2, last: 94.89, inc: 7 });
  feed(290, { pos: 3, laps: 2, last: 94.89, inc: 7, pit: true });
  check('the real recorder writes an iRacing header', lines.some((l) => l.t === 'header' && l.source === 'iracing'));
  const liveFile = liveFileFor(start, stateDir);
  fs.writeFileSync(liveFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // A replay frame never opens a race (the recorder's replay guard).
  const rr = new RaceLogRecorder();
  const rf = liveFrame(start, { et: 50, pos: 1, laps: 0 });
  rf.session.replay = true;
  check('a replay frame records nothing', rr.update(rf, start).length === 0);

  // The results copy, finished and official.
  const off = parseSessionInfo(yamlOfficial());
  const fin = buildRaceSnapshot(off, teleOf({ sessionState: 6, ourIncidents: 7 }), live0, start + 400_000);
  fs.writeFileSync(path.join(irDir, `${fin.id}.json`), JSON.stringify(fin));

  // A second iRacing race recorded live with no copy (an older app, a crash).
  const rec2 = new RaceLogRecorder();
  const l2 = [];
  const s2 = start + 86_400_000 / 4;
  const feed2 = (et, o) => l2.push(...rec2.update(liveFrame(s2 + et * 1000, { et, ...o }), s2 + et * 1000));
  feed2(10, { phase: 'countdown', pos: 5, laps: 0 });
  feed2(11, { pos: 5, laps: 0 });
  feed2(100, { pos: 4, laps: 1, last: 99.5 });
  fs.appendFileSync(liveFileFor(s2, stateDir), l2.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const opts = { dir: irDir, liveDir: stateDir, now: start + 1_000_000 };
  const list = ir.listIrRaceLogs(opts);
  check('two iRacing races listed', list.length === 2, list.map((r) => r.id).join());
  const row = list.find((r) => r.id === 'ir-1-2');
  check('the copy is listed with our finish', row && row.finishPosition === 3, row && row.finishPosition);
  check('…and its grid', row && row.gridPosition === 2);
  check('…not provisional', row && row.provisional === false);
  check('…with our laps', row && row.laps === 2);
  const lone = list.find((r) => r.id.startsWith('irlive:'));
  check('the live-only race is provisional', lone && lone.provisional === true);

  const log = ir.loadIrRaceLog('ir-1-2', opts);
  check('loads', !!log && log.sim === 'iracing');
  check('our car is the slot', log.slot === OWN);
  check('finish from the results', log.finishPosition === 3 && log.finishStatus === 'Finished');
  const texts = log.events.map((e) => `${e.kind}:${e.text}`);
  check('incident +1x reads Off track', texts.some((t) => t === 'limits:Off track: +1x (1x of 17x)'), texts.join(' | '));
  check('incident +2x reads Loss of control', texts.some((t) => t === 'limits:Loss of control: +2x (3x of 17x)'));
  check('incident +4x reads Car contact, as a contact', texts.some((t) => t === 'contact:Car contact: +4x (7x of 17x)'));
  check('no LMU "Track limits" wording survives', !texts.some((t) => /Track limits/.test(t)));
  check('a black flag reads as one', texts.some((t) => t === 'penalty:Black flag shown'));
  check('the start is at the grid slot', log.events.find((e) => e.kind === 'start').detail.position === 2);
  check('exactly one finish line, from the results', log.events.filter((e) => e.kind === 'finish').length === 1
    && /Finished P3, 2 laps/.test(log.events.find((e) => e.kind === 'finish').text));
  check('laps from the live log', log.events.some((e) => e.kind === 'lap' && e.detail && e.detail.lapMs === 95100));
  check('pit stop from the live log', log.events.some((e) => e.kind === 'pit'));
  check('classification sorted by place', log.classification.map((r) => r.position).filter((p) => p).every((p, i, a) => !i || a[i - 1] <= p));
  check('classification marks our car', log.classification.filter((r) => r.ours).length === 1);
  check('official: the field\'s incidents shown', log.classification.some((r) => typeof r.incidents === 'number' && r.incidents > 0));
  check('our incident points carried', log.incidents.points === 7 && log.incidents.limit === 17 && log.incidents.fieldPublished === true);
  check('a DQ in the classification', log.classification.some((r) => r.status === 'DQ'));

  // The same race while it was still live: the field's incidents withheld.
  const liveCopy = { ...live0, ourIncidents: 3 };
  const early = ir.buildIrRaceLog(liveCopy, null);
  check('live copy: the field\'s incidents withheld', early.classification.every((r) => r.incidents === null));
  check('live copy: our finish line says the race was running', /still running/.test(early.events[early.events.length - 1].text));
  check('copy with no live log: start (grid) + finish', early.events.length === 2 && early.events[0].kind === 'start');

  const loneLog = ir.loadIrRaceLog(lone.id, opts);
  check('the live-only race loads', loneLog && loneLog.sim === 'iracing' && loneLog.provisional === true);
  check('unknown ids load nothing', ir.loadIrRaceLog('../etc', opts) === null && ir.loadIrRaceLog('ir-9-9', opts) === null);

  // LMU's list from the same folder: no iRacing race.
  const lmu = listRaceLogs(null, { stateDir, now: opts.now, laps: [] });
  check('LMU\'s race list never shows an iRacing race', lmu.length === 0, lmu.map((r) => r.id).join());

  // Real names never committed: the fixture is anonymised.
  check('fixture names are anonymised', log.classification.every((r) => r.drivers.every((d) => /^Driver \d+$/.test(d))));
}

// ── 5. The wiring ───────────────────────────────────────────────────────────
function wiringChecks() {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const main = read('electron', 'main.js');
  const m = /const LMU_ONLY_IPC =\s*\/(.+)\/;/.exec(main);
  const re = m ? new RegExp(m[1]) : null;
  check('LMU_ONLY_IPC found', !!re);
  if (re) {
    check('review:racelogs answers in iRacing mode', !re.test('review:racelogs'));
    check('review:racelog answers in iRacing mode', !re.test('review:racelog'));
    check('the car picker stays LMU only', re.test('review:racelogPick'));
    check('the replay jump stays LMU only', re.test('review:replayOpen'));
  }
  check('main routes the iRacing list to irRaceLog', /getActiveSim\(\) === 'iracing'[\s\S]{0,300}listIrRaceLogs\(\)/.test(main));
  check('main routes the iRacing log to irRaceLog', /getActiveSim\(\) === 'iracing'[\s\S]{0,300}loadIrRaceLog\(id\)/.test(main));
  const panel = read('electron', 'control-panel', 'review-panel.js');
  check('Review offers Race log in iRacing mode when a race paired', /if \(!IS_LMU\) return TABS\.filter\(\(t\) => !t\.coach && \(!t\.race \|\| \(s && raceOf\.has\(s\.id\)\)\)\)/.test(panel));
  check('Review reads the race list in both sims', /const racesRead = RL \? RL\.load\(\)/.test(panel));
  const rl = read('electron', 'control-panel', 'review-racelog.js');
  check('renderer: no replay buttons on an iRacing log', /!isIr\(log\) \? \{ ok: replayOk\(\)/.test(rl));
  check('renderer: never asks the game about an iRacing replay', /async function askGame\(id\) \{\s*if \(isIr\(log\)\) return;/.test(rl));
  check('renderer: draws the classification', /\$\{isIr\(log\) \? resultsHtml\(log\) : ''\}/.test(rl));
  check('renderer: no car picker for an iRacing log', /isIr\(log\) && log\.slot === null/.test(rl));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-irlog-'));
  try {
    await recorderChecks();
    await providerChecks(tmp);
    await logChecks(tmp);
    wiringChecks();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`iracing race log: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
