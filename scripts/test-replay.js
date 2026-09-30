/**
 * scripts/test-replay.js — the race log's jump into the game's replay.
 * -----------------------------------------------------------------------------
 * `src/server/lmuReplay.ts` drives the real game: it loads a replay, which
 * throws away whatever the game was doing. So it is tested against a FAKE LMU
 * here and never against the real one, and the fake copies what the game did
 * when the sequence was driven by hand on 2026-09-30 (docs/RACE-LOG-PLAN.md,
 * table C):
 *   - `GET /rest/watch/play/{id}` answers `7`, then `/navigation/state` walks
 *     NAV_EVENT + GSTATE_INIT with a loading bar, the bar ends, and only a
 *     couple of polls later does gameState reach GSTATE_DYN;
 *   - focus / replayTime / replayCommand answer 400 until DYN;
 *   - a PUT or POST with no Content-Length answers 400 with an empty body.
 * On top of that it can quit mid-load (`down` drops every socket) and change
 * under a sequence (`hook` runs before each answer), which is how the guards
 * that re-read the game before every state-changing call are pinned.
 * The pairing cases use the real replay names, timestamps and mtime gaps read
 * off this machine the same day, including the Spa restart whose two replays
 * share one timestamp.
 *
 * Run: node scripts/test-replay.js   (after `npm run build`)
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  LmuReplayController,
  pairReplay,
  readRaceInfo,
  resultsPathFor,
  replayNameMatches,
  loadTimeoutMs,
} = require('../dist/server/lmuReplay');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
}

/* ----------------------------- the real data ----------------------------- */

const REPLAY_DIR = 'C:\\LMU\\UserData\\Replays\\';
const rep = (name, timestamp, session = 'RACE', size = 600e6, sceneDesc = 'X') => ({
  replayName: name,
  replayDirectory: REPLAY_DIR,
  size,
  timestamp,
  metadata: { session, sceneDesc, eventType: 'specialevent' },
});

/** Spa, 2026-08-16: the second race of the event reused the first's timestamp. */
const SPA_38_MTIME = 1786915650_000;
const SPA_39_MTIME = 1786919301_000;

function realisticList() {
  const rows = [
    rep('Circuit de la Sarthe P1 30', 1790336307, 'PRACTICE', 50e6, 'LEMANSWEC'),
    rep('Circuit de la Sarthe Q1 26', 1790336307, 'QUALIFY', 40e6, 'LEMANSWEC'),
    rep('Circuit de la Sarthe R1 27', 1790355263, 'RACE', 3509e6, 'LEMANSWEC'),
    rep('Circuit de la Sarthe R1 26', 1790336307, 'RACE', 38e6, 'LEMANSWEC'),
    rep('Circuit de la Sarthe R1 25', 1790325364, 'RACE', 508e6, 'LEMANSWEC'),
    // Same venue, different layout, and a start one second off one of ours.
    rep('Circuit de la Sarthe Mulsanne R1 1', 1790336303, 'RACE', 5e6, 'LEMANSWEC_MULSANNE'),
    rep('Grand Prix of Long Beach R1 1', 1790276202, 'RACE', 642e6, 'LONGBEACH'),
    rep('Silverstone Grand Prix Circuit - ELMS R1 5', 1789909716, 'RACE', 2589e6, 'SILVERSTONEELMS'),
    rep('Circuit de Spa-Francorchamps R1 39', 1786903236, 'RACE', 628e6, 'SPAELMS'),
    rep('Circuit de Spa-Francorchamps R1 38', 1786903236, 'RACE', 1979e6, 'SPAELMS'),
    rep('Circuit de Spa-Francorchamps R1 37', 1786895926, 'RACE', 989e6, 'SPAELMS'),
    // Warm-ups are tagged RACE too; the name keeps them out.
    rep('Circuit de Spa-Francorchamps WU 4', 1786903229, 'RACE', 1e5, 'SPAWEC'),
    rep('Autódromo José Carlos Pace R1 3', 1784484279, 'RACE', 3457e6, 'INTERLAGOSWEC'),
  ];
  return rows.map((r, id) => ({ id, ...r }));
}

const VCR_MTIMES = {
  'Circuit de Spa-Francorchamps R1 38': SPA_38_MTIME,
  'Circuit de Spa-Francorchamps R1 39': SPA_39_MTIME,
  'Circuit de la Sarthe R1 26': 1790336302_000 + 7_000_000,
};
const vcrMtimeMs = (e) => VCR_MTIMES[e.replayName] ?? null;

const RACES = {
  '2026_09_25_12_42_51-05R1.xml': {
    raceId: '2026_09_25_12_42_51-05R1.xml', course: 'Circuit de la Sarthe', session: 'R1',
    startedAt: 1790336302, xmlMtimeMs: 1790336302_000 + 7_000_000,
  },
  '2026_09_24_21_38_11-49R1.xml': {
    raceId: '2026_09_24_21_38_11-49R1.xml', course: 'Grand Prix of Long Beach', session: 'R1',
    startedAt: 1790276199, xmlMtimeMs: null,
  },
  '2026_09_20_18_28_11-74R1.xml': {
    raceId: '2026_09_20_18_28_11-74R1.xml', course: 'Silverstone Grand Prix Circuit - ELMS', session: 'R1',
    startedAt: 1789909712, xmlMtimeMs: null,
  },
  '2026_08_16_22_27_30-74R1.xml': {
    raceId: '2026_08_16_22_27_30-74R1.xml', course: 'Circuit de Spa-Francorchamps', session: 'R1',
    startedAt: 1786903229, xmlMtimeMs: SPA_38_MTIME,
  },
  '2026_08_16_23_28_21-26R1.xml': {
    raceId: '2026_08_16_23_28_21-26R1.xml', course: 'Circuit de Spa-Francorchamps', session: 'R1',
    startedAt: 1786915661, xmlMtimeMs: SPA_39_MTIME,
  },
  // The game kept five Le Mans races and moved on: no replay left.
  '2026_09_03_23_42_02-69R1.xml': {
    raceId: '2026_09_03_23_42_02-69R1.xml', course: 'Circuit de la Sarthe', session: 'R1',
    startedAt: 1788472220, xmlMtimeMs: 1788475322_000,
  },
  '2026_07_19_22_10_00-11R1.xml': {
    raceId: '2026_07_19_22_10_00-11R1.xml', course: 'Autódromo José Carlos Pace', session: 'R1',
    startedAt: 1784484275, xmlMtimeMs: null,
  },
};

/* ------------------------------- the fake game ------------------------------- */

function makeFakeLmu() {
  const g = {
    nav: { navigationState: 'NAV_MAIN_MENU', gameState: 'GSTATE_SETUP', settingMode: 'SETTING_GRANDPRIX' },
    loading: false,
    percentage: -1,
    list: realisticList(),
    /** Polls of /navigation/state since the last play; drives INIT → DYN. */
    polls: -1,
    /** Loading-bar polls before the bar ends. */
    barPolls: 4,
    neverFinish: false,
    /** The user backs out to the menu on this load poll. */
    leaveAtPoll: 0,
    playAnswer: 7,
    played: [],
    log: [],
    missingLength: 0,
    /** The game has quit: every request's socket is dropped unanswered. */
    down: false,
    /** Called with (method, url) before each request is answered; may change the game. */
    hook: null,
    /** focus / replayTime / play answer 400 even in DYN. */
    refuseJumps: false,
    /** The slot the camera is on; -1 before a replay has one. */
    focus: -1,
    /** The next N focus reads answer slot 0: the camera settling on the leader. */
    focusSlips: 0,
    /** Requests go unanswered (the game busy opening a big file) while > 0. */
    hang: 0,
  };
  const advance = () => {
    if (g.polls < 0) return;
    g.polls++;
    if (g.leaveAtPoll && g.polls === g.leaveAtPoll) {
      Object.assign(g.nav, { navigationState: 'NAV_MAIN_MENU', gameState: 'GSTATE_SETUP' });
      g.loading = false; g.percentage = -1; g.polls = -1;
      return;
    }
    if (g.neverFinish) {
      Object.assign(g.nav, { gameState: 'GSTATE_INIT' });
      g.loading = true;
      g.percentage = 0.5;
      return;
    }
    const i = g.polls;
    if (i === 1) {
      g.loading = false; g.percentage = -1; g.nav.gameState = 'GSTATE_SETUP';
    } else if (i <= g.barPolls + 1) {
      g.loading = true; g.percentage = (i - 1) / g.barPolls; g.nav.gameState = 'GSTATE_INIT';
    } else if (i === g.barPolls + 2) {
      // The bar has ended; the game has not. This is the "~6 s too early".
      g.loading = false; g.percentage = -1; g.nav.gameState = 'GSTATE_INIT';
    } else if (i === g.barPolls + 3) {
      g.nav.gameState = 'GSTATE_RESTART';
    } else {
      g.nav.gameState = 'GSTATE_DYN';
      g.polls = -1;
    }
  };
  const dyn = () => g.nav.settingMode === 'SETTING_REPLAY_PLAYBACK' && g.nav.gameState === 'GSTATE_DYN';

  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    };
    const u = req.url;
    g.log.push(`${req.method} ${u}`);
    if (g.hook) g.hook(req.method, u);
    if (g.down) {
      req.socket.destroy();
      return undefined;
    }
    if (g.hang > 0) {
      g.hang--;
      return undefined; // no answer at all: the client times out
    }
    if ((req.method === 'PUT' || req.method === 'POST') && req.headers['content-length'] === undefined) {
      g.missingLength++;
      return send(400);
    }
    let m;
    if (req.method === 'GET' && u === '/navigation/state') {
      advance();
      return send(200, {
        loadingStatus: { loading: g.loading, percentage: g.percentage, loadingData: '{}' },
        state: { ...g.nav, appBuild: 14200, gamePhase: 'BEFORE' },
      });
    }
    if (req.method === 'GET' && u === '/rest/watch/replays') return send(200, g.list);
    if (req.method === 'GET' && (m = /^\/rest\/watch\/play\/(\d+)$/.exec(u))) {
      const row = g.list.find((r) => r.id === Number(m[1]));
      g.played.push(row ? row.replayName : `?${m[1]}`);
      Object.assign(g.nav, { navigationState: 'NAV_EVENT', settingMode: 'SETTING_REPLAY_PLAYBACK', gameState: 'GSTATE_SETUP' });
      g.polls = 0;
      return send(200, g.playAnswer);
    }
    if (req.method === 'PUT' && /^\/rest\/watch\/(focus\/\d+|replayTime\/[\d.]+|replayCommand\/VCRCOMMAND_PLAY)$/.test(u)) {
      if (!dyn() || g.refuseJumps) return send(400, 'Cannot check replay status when not in a session');
      if ((m = /^\/rest\/watch\/focus\/(\d+)$/.exec(u))) g.focus = Number(m[1]);
      return send(200, '');
    }
    if (req.method === 'GET' && u === '/rest/watch/focus') {
      if (g.focusSlips > 0) {
        g.focusSlips--;
        g.focus = 0;
      }
      return send(200, g.focus);
    }
    if (req.method === 'POST' && u === '/navigation/action/NAV_TO_MAIN_MENU') {
      // settingMode is left as it was: the menu check must not lean on it.
      Object.assign(g.nav, { navigationState: 'NAV_MAIN_MENU', gameState: 'GSTATE_SETUP' });
      g.polls = -1;
      return send(200, '');
    }
    return send(404, 'not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ g, server, port: server.address().port }));
  });
}

/** A virtual clock: each wait advances it and yields, so a 3-minute timeout runs in a blink. */
function virtualClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: (ms) => new Promise((r) => { t += ms; setImmediate(r); }),
  };
}

function controllerFor(port, extra = {}) {
  const clock = virtualClock();
  const c = new LmuReplayController({
    baseUrl: `http://127.0.0.1:${port}`,
    now: clock.now,
    sleep: clock.sleep,
    resolveRace: (id) => RACES[id] ?? null,
    vcrMtimeMs,
    watchMs: 0,
    ...extra,
  });
  const seen = [];
  c.onStatus((s) => seen.push(s));
  return { c, seen };
}

const jumpsIn = (log) => log.filter((l) => l.startsWith('PUT '));
const playsIn = (log) => log.filter((l) => l.startsWith('GET /rest/watch/play/'));

/* ---------------------------------- cases ---------------------------------- */

async function main() {
  console.log('\npairing');
  {
    const list = realisticList();
    const pick = (id) => pairReplay(RACES[id], list, vcrMtimeMs)?.replayName ?? null;
    check('Le Mans R1 → its own race replay, not practice, qualifying or Mulsanne',
      pick('2026_09_25_12_42_51-05R1.xml') === 'Circuit de la Sarthe R1 26', pick('2026_09_25_12_42_51-05R1.xml'));
    check('Long Beach pairs on timestamp alone (+3 s)', pick('2026_09_24_21_38_11-49R1.xml') === 'Grand Prix of Long Beach R1 1');
    check('Silverstone ELMS: the course name with a dash in it', pick('2026_09_20_18_28_11-74R1.xml') === 'Silverstone Grand Prix Circuit - ELMS R1 5');
    check('Spa restart, first race: shared timestamp, the .Vcr mtime picks R1 38',
      pick('2026_08_16_22_27_30-74R1.xml') === 'Circuit de Spa-Francorchamps R1 38', pick('2026_08_16_22_27_30-74R1.xml'));
    check('Spa restart, second race: 3½ h off on timestamp, found by mtime → R1 39',
      pick('2026_08_16_23_28_21-26R1.xml') === 'Circuit de Spa-Francorchamps R1 39', pick('2026_08_16_23_28_21-26R1.xml'));
    check('a race whose replay the game deleted pairs with nothing', pick('2026_09_03_23_42_02-69R1.xml') === null);
    check('accented course names match', pick('2026_07_19_22_10_00-11R1.xml') === 'Autódromo José Carlos Pace R1 3');
    check('a warm-up tagged RACE is not a race', !replayNameMatches('Circuit de Spa-Francorchamps WU 4', 'Circuit de Spa-Francorchamps', 'R1'));
    check('Mulsanne is not the Sarthe', !replayNameMatches('Circuit de la Sarthe Mulsanne R1 1', 'Circuit de la Sarthe', 'R1'));
    const lateStart = { ...RACES['2026_09_24_21_38_11-49R1.xml'], startedAt: 1790276202 - 200 };
    check('a timestamp 200 s off, with no mtime, does not pair', pairReplay(lateStart, list) === null);

    // The header reader, against a file shaped like the real ones.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-replay-'));
    const f = path.join(dir, '2026_09_24_21_38_11-49R1.xml');
    fs.writeFileSync(f, [
      '<?xml version="1.0" encoding="utf-8"?>', '<rFactorXML version="1.0">', '<RaceResults>',
      '<DateTime>1790276199</DateTime>', '<TrackVenue>Grand Prix of Long Beach</TrackVenue>',
      '<TrackCourse>Grand Prix of Long Beach &amp; Co</TrackCourse>', '<Race>',
      '<DateTime>1790277519</DateTime>', '<Stream>', '</Stream>', '</Race>', '</RaceResults>',
    ].join('\n'));
    const info = readRaceInfo(f);
    check('readRaceInfo takes the TOP-level DateTime (event start), not the race one',
      info && info.startedAt === 1790276199, info && info.startedAt);
    check('readRaceInfo decodes entities and reads the session from the name',
      info && info.course === 'Grand Prix of Long Beach & Co' && info.session === 'R1' && info.xmlMtimeMs > 0);
    check('readRaceInfo: a missing file is null', readRaceInfo(path.join(dir, 'nope.xml')) === null);
    check('resultsPathFor refuses a path that walks out', resultsPathFor('..\\..\\x.xml') === null && resultsPathFor('a/b.xml') === null);
    check('resultsPathFor honours the Game folder override',
      (() => {
        const root = path.join(dir, 'LMU');
        fs.mkdirSync(path.join(root, 'UserData', 'Log', 'Results'), { recursive: true });
        fs.copyFileSync(f, path.join(root, 'UserData', 'Log', 'Results', path.basename(f)));
        return resultsPathFor(path.basename(f), { APEX_LMU_ROOT: root + '\\', APEX_LMU_LOG_DIR: path.join(dir, 'none') })
          === path.join(root, 'UserData', 'Log', 'Results', path.basename(f));
      })());
    check('load budget: 3 min floor, more for 4 GB', loadTimeoutMs(642e6) === 180_000 && loadTimeoutMs(4.2e9) > 180_000 && loadTimeoutMs(null) === 180_000);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const { g, server, port } = await makeFakeLmu();
  try {
    console.log('\nthe fake keeps the game\'s rules');
    {
      const raw = await new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write('PUT /rest/watch/focus/3 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
        let d = '';
        s.on('data', (c) => (d += c));
        s.on('end', () => resolve(d));
      });
      check('a PUT with no Content-Length is a 400', /^HTTP\/1\.1 400/.test(raw));
    }

    console.log('\nhappy path');
    const RACE = '2026_09_20_18_28_11-74R1.xml';
    const { c, seen } = controllerFor(port);
    {
      const avail = await c.findReplayFor(RACE);
      check('findReplayFor names the replay before any click', avail.ok && avail.replay.replayName === 'Silverstone Grand Prix Circuit - ELMS R1 5');
      // The game adds a replay between the check and the click: every id moves.
      g.list = [{ id: 0, ...rep('Daytona International Speedway Road Course P1 35', 1790800000, 'PRACTICE') },
        ...realisticList().map((r) => ({ ...r, id: r.id + 1 }))];
      g.log.length = 0;
      g.missingLength = 0;
      const first = await c.openAt({ raceId: RACE, slot: 9, et: 12742.3 });
      check('openAt returns at once with loading', first.phase === 'loading' && first.raceId === RACE, first.phase);
      const done = await c.settled();
      check('ends ready', done.phase === 'ready' && done.message === null, `${done.phase} ${done.message}`);
      check('played the right replay by its CURRENT id (list re-fetched before play)',
        g.played.at(-1) === 'Silverstone Grand Prix Circuit - ELMS R1 5');
      const listAt = g.log.lastIndexOf('GET /rest/watch/replays');
      const playAt = g.log.findIndex((l) => l.startsWith('GET /rest/watch/play/'));
      check('the list fetch sits right before play', listAt >= 0 && listAt < playAt);
      check('focus by slot, seek to et − 5, then play, in that order',
        JSON.stringify(jumpsIn(g.log)) === JSON.stringify([
          'PUT /rest/watch/focus/9', 'PUT /rest/watch/replayTime/12737.3', 'PUT /rest/watch/replayCommand/VCRCOMMAND_PLAY',
        ]), jumpsIn(g.log).join(' | '));
      check('no jump call went out before DYN (none were refused)', !g.log.some((l, i) => l.startsWith('PUT') && i < g.log.indexOf('PUT /rest/watch/focus/9')));
      check('every PUT carried Content-Length', g.missingLength === 0);
      const progress = seen.filter((s) => s.phase === 'loading' && s.progress != null).map((s) => s.progress);
      check('progress climbs from the loading bar', progress.length >= 3 && progress.every((p, i) => i === 0 || p >= progress[i - 1]), progress.join(','));
    }

    console.log('\nsecond jump in the same race');
    {
      g.log.length = 0;
      const s = await c.openAt({ raceId: RACE, slot: 12, et: 3.2, leadS: 5 });
      check('answers ready without loading', s.phase === 'ready');
      check('no reload', playsIn(g.log).length === 0 && !g.log.includes('GET /rest/watch/replays'));
      check('just focus + seek (clamped at 0) + play', JSON.stringify(jumpsIn(g.log)) === JSON.stringify([
        'PUT /rest/watch/focus/12', 'PUT /rest/watch/replayTime/0', 'PUT /rest/watch/replayCommand/VCRCOMMAND_PLAY',
      ]), jumpsIn(g.log).join(' | '));
    }

    console.log('\nuser leaves the replay');
    {
      Object.assign(g.nav, { navigationState: 'NAV_MAIN_MENU', gameState: 'GSTATE_SETUP' });
      const s = await c.refresh();
      check('refresh sees it and goes idle', s.phase === 'idle' && /left/.test(s.message || ''), `${s.phase} ${s.message}`);
      g.log.length = 0;
      await c.openAt({ raceId: RACE, slot: 9, et: 100 });
      const again = await c.settled();
      check('the next click loads again', again.phase === 'ready' && playsIn(g.log).length === 1);
    }

    console.log('\nclicks while loading are coalesced');
    {
      const other = '2026_09_24_21_38_11-49R1.xml';
      Object.assign(g.nav, { navigationState: 'NAV_MAIN_MENU', gameState: 'GSTATE_SETUP', settingMode: 'SETTING_GRANDPRIX' });
      await c.refresh();
      g.log.length = 0;
      g.barPolls = 12;
      const a = await c.openAt({ raceId: other, slot: 25, et: 592.2 });
      const b = await c.openAt({ raceId: other, slot: 7, et: 1000 });
      const x = await c.openAt({ raceId: RACE, slot: 1, et: 50 });
      check('first click loads', a.phase === 'loading');
      check('second click in the same race is absorbed', b.phase === 'loading' && b.raceId === other);
      check('a click for another race while loading is refused, not queued', x.raceId === other && /Another replay is loading/.test(x.message || ''), x.message);
      check('…and says so with busy, since the status beside it is the other race\'s', x.busy === true && !a.busy && !b.busy);
      await c.settled();
      g.barPolls = 4;
      check('one load only', playsIn(g.log).length === 1, playsIn(g.log).length);
      check('the replay lands on the LAST click', JSON.stringify(jumpsIn(g.log)) === JSON.stringify([
        'PUT /rest/watch/focus/7', 'PUT /rest/watch/replayTime/995', 'PUT /rest/watch/replayCommand/VCRCOMMAND_PLAY',
      ]), jumpsIn(g.log).join(' | '));
    }

    console.log('\nanother race\'s replay on screen');
    {
      g.log.length = 0;
      await c.openAt({ raceId: RACE, slot: 9, et: 200 });
      const s = await c.settled();
      check('goes back to the menu first, then loads', g.log.indexOf('POST /navigation/action/NAV_TO_MAIN_MENU') >= 0 &&
        g.log.indexOf('POST /navigation/action/NAV_TO_MAIN_MENU') < g.log.findIndex((l) => l.startsWith('GET /rest/watch/play/')));
      check('and ends ready on the new race', s.phase === 'ready' && s.raceId === RACE);
    }

    console.log('\nblocked in a live session');
    {
      const fresh = controllerFor(port).c;
      Object.assign(g.nav, { navigationState: 'NAV_EVENT', gameState: 'GSTATE_DYN', settingMode: 'SETTING_GRANDPRIX' });
      g.log.length = 0;
      const s = await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      await fresh.settled();
      check('phase blocked with the leave-your-session line', s.phase === 'blocked' && /Leave your session/.test(s.message || ''), s.message);
      check('nothing but a state read went to the game', g.log.every((l) => l === 'GET /navigation/state'), g.log.join(' | '));
    }

    console.log('\nreplay unavailable');
    {
      const fresh = controllerFor(port).c;
      Object.assign(g.nav, { navigationState: 'NAV_MAIN_MENU', gameState: 'GSTATE_SETUP', settingMode: 'SETTING_GRANDPRIX' });
      const gone = '2026_09_03_23_42_02-69R1.xml';
      const avail = await fresh.findReplayFor(gone);
      check('findReplayFor says no-replay', !avail.ok && avail.reason === 'no-replay' && /replaced/.test(avail.message));
      g.log.length = 0;
      const s = await fresh.openAt({ raceId: gone, slot: 3, et: 60 });
      check('openAt answers unavailable and plays nothing', s.phase === 'unavailable' && playsIn(g.log).length === 0, s.phase);
      const nores = await fresh.findReplayFor('2099_01_01_00_00_00-00R1.xml');
      check('no results file → no-results', !nores.ok && nores.reason === 'no-results');
      const offline = new LmuReplayController({ baseUrl: 'http://127.0.0.1:1', resolveRace: (id) => RACES[id] ?? null, watchMs: 0, httpTimeoutMs: 500 });
      const off = await offline.findReplayFor(RACE);
      check('game not running → game-offline', !off.ok && off.reason === 'game-offline');
      const offOpen = await offline.openAt({ raceId: RACE, slot: 1, et: 1 });
      check('openAt with the game closed is an error, not a hang', offOpen.phase === 'error', offOpen.message);
      const bad = await fresh.openAt({ raceId: '../evil.xml', slot: 1, et: 1 });
      check('a bad request changes nothing', bad.phase === 'unavailable' && fresh.status().message !== bad.message && /Nothing/.test(bad.message || ''));
    }

    console.log('\nuser leaves while it loads');
    {
      const { c: fresh } = controllerFor(port);
      Object.assign(g.nav, { navigationState: 'NAV_MAIN_MENU', gameState: 'GSTATE_SETUP', settingMode: 'SETTING_GRANDPRIX' });
      g.leaveAtPoll = 3;
      g.log.length = 0;
      await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      const s = await fresh.settled();
      g.leaveAtPoll = 0;
      check('goes idle, no jump sent', s.phase === 'idle' && /left/.test(s.message || '') && jumpsIn(g.log).length === 0, `${s.phase} ${s.message}`);
    }

    console.log('\nload timeout');
    {
      const { c: fresh } = controllerFor(port);
      Object.assign(g.nav, { navigationState: 'NAV_MAIN_MENU', gameState: 'GSTATE_SETUP', settingMode: 'SETTING_GRANDPRIX' });
      g.neverFinish = true;
      g.log.length = 0;
      await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      const s = await fresh.settled();
      g.neverFinish = false;
      check('errors with the timeout line', s.phase === 'error' && /too long/.test(s.message || ''), `${s.phase} ${s.message}`);
      check('sent no jump', jumpsIn(g.log).length === 0);
      const polls = g.log.filter((l) => l === 'GET /navigation/state').length;
      check('polled every 500 ms for the size-scaled budget', polls >= loadTimeoutMs(2589e6) / 500 - 2, polls);
    }

    const MENU = { navigationState: 'NAV_MAIN_MENU', gameState: 'GSTATE_SETUP', settingMode: 'SETTING_GRANDPRIX' };
    const LIVE = { navigationState: 'NAV_EVENT', gameState: 'GSTATE_DYN', settingMode: 'SETTING_GRANDPRIX' };
    const OTHER_REPLAY = { navigationState: 'NAV_EVENT', gameState: 'GSTATE_DYN', settingMode: 'SETTING_REPLAY_PLAYBACK' };
    const navPolls = (log) => log.filter((l) => l === 'GET /navigation/state').length;
    /** Put the game somewhere, with no load in progress (the timeout case leaves one running). */
    const put = (state) => {
      Object.assign(g.nav, state);
      g.polls = -1; g.loading = false; g.percentage = -1;
    };
    /** Drop the game's sockets from the Nth state poll after play. */
    const quitAfterPlay = (n, backAfter = 0) => {
      let since = -1;
      let dropped = 0;
      return (m, u) => {
        if (u.startsWith('/rest/watch/play/')) since = 0;
        else if (u === '/navigation/state' && since >= 0 && ++since === n) g.down = true;
        if (g.down && backAfter && ++dropped > backAfter) g.down = false;
      };
    };

    console.log('\nthe game closes while it loads');
    {
      const { c: fresh } = controllerFor(port);
      put(MENU);
      g.barPolls = 12;
      g.hook = quitAfterPlay(3);
      g.log.length = 0;
      await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      const s = await fresh.settled();
      const afterPlay = g.log.slice(g.log.findIndex((l) => l.startsWith('GET /rest/watch/play/')));
      check('errors with the game-closed line', s.phase === 'error' && s.message === 'The game closed while the replay was loading.', `${s.phase} ${s.message}`);
      check('gives up after ~5 s of silence, not the 3-minute budget', navPolls(afterPlay) <= 16, navPolls(afterPlay));
      check('sent no jump', jumpsIn(g.log).length === 0);
      g.log.length = 0;
      const again = await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      await fresh.settled();
      check('forgot the load: the next click finds the game gone', again.phase === 'error' && /isn't running/.test(again.message || ''), again.message);
      g.down = false;
      g.hook = null;
      g.barPolls = 4;
    }

    console.log('\na second of silence mid-load is not a closed game');
    {
      const { c: fresh } = controllerFor(port);
      put(MENU);
      g.barPolls = 8;
      g.hook = quitAfterPlay(3, 4); // four polls (2 s) unanswered, then back
      g.log.length = 0;
      await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      const s = await fresh.settled();
      g.down = false;
      g.hook = null;
      g.barPolls = 4;
      check('rides it out and ends ready', s.phase === 'ready', `${s.phase} ${s.message}`);
    }

    // Live, 2026-09-30, Le Mans R1 27 (3.5 GB): at 100% the game stopped
    // ANSWERING for ~15 s while it opened the file. Read as "closed", the
    // controller gave up just before the replay appeared, no jump went out,
    // and the camera sat on slot 0: the driver's "wrong car".
    console.log('\nthe game going quiet at 100% is busy, not closed');
    {
      const { c: fresh } = controllerFor(port, { httpTimeoutMs: 30 });
      put(MENU);
      g.barPolls = 6;
      let since = -1;
      g.hook = (m, u) => {
        if (u.startsWith('/rest/watch/play/')) since = 0;
        else if (u === '/navigation/state' && since >= 0 && ++since === 8) g.hang = 30; // ~15 s of polls
      };
      g.log.length = 0;
      await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      const s = await fresh.settled();
      g.hook = null;
      g.hang = 0;
      g.barPolls = 4;
      check('waits it out and ends ready', s.phase === 'ready', `${s.phase} ${s.message}`);
      check('and the jump went out', jumpsIn(g.log).some((l) => l === 'PUT /rest/watch/focus/9'), jumpsIn(g.log).join(' | '));

      // Quiet again while it plays: the watcher keeps the replay ours, so the
      // next click jumps instead of closing and reloading it.
      g.hang = 3;
      const r = await fresh.refresh();
      g.hang = 0;
      check('a quiet game keeps the replay ours', r.phase === 'ready', `${r.phase} ${r.message}`);
      g.log.length = 0;
      await fresh.openAt({ raceId: RACE, slot: 9, et: 400 });
      await fresh.settled();
      check('the next click jumps, no reload', !g.log.some((l) => l.startsWith('GET /rest/watch/play/') || l.includes('NAV_TO_MAIN_MENU')),
        g.log.filter((l) => !l.startsWith('GET /navigation')).join(' | '));
    }

    console.log('\nthe camera slips to slot 0 after the jump');
    {
      const { c: fresh } = controllerFor(port);
      put(MENU);
      await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      await fresh.settled();
      g.log.length = 0;
      g.focusSlips = 1;
      await fresh.openAt({ raceId: RACE, slot: 9, et: 300 });
      await fresh.settled();
      const focuses = g.log.filter((l) => l === 'PUT /rest/watch/focus/9').length;
      check('reads the camera back and puts it on our car again', focuses === 2 && g.focus === 9, `${focuses} focus PUTs, camera on ${g.focus}`);
      check('stops once it holds', g.log.filter((l) => l === 'GET /rest/watch/focus').length === 2);
    }

    console.log('\nthe driver leaves between jump retries');
    {
      const { c: fresh } = controllerFor(port);
      put(MENU);
      await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      await fresh.settled();
      // The jump calls 400 for a moment; before the retry, a live session.
      g.refuseJumps = true;
      g.hook = (m, u) => { if (m === 'PUT' && u.startsWith('/rest/watch/focus/')) put(LIVE); };
      g.log.length = 0;
      const s = await fresh.openAt({ raceId: RACE, slot: 4, et: 300 });
      g.hook = null;
      const focuses = g.log.filter((l) => l.startsWith('PUT /rest/watch/focus/')).length;
      check('one focus, then the retry looks and stops', focuses === 1 && jumpsIn(g.log).length === 1, jumpsIn(g.log).join(' | '));
      check('goes idle with the left-the-replay line', s.phase === 'idle' && /left/.test(s.message || ''), `${s.phase} ${s.message}`);
      check('a look went out between the attempts', g.log.indexOf('GET /navigation/state', g.log.indexOf('PUT /rest/watch/focus/4')) > 0);

      // Still in the replay, just refusing: the retries run their course.
      put(MENU);
      await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      g.refuseJumps = false;
      await fresh.settled();
      g.refuseJumps = true;
      g.log.length = 0;
      const r = await fresh.openAt({ raceId: RACE, slot: 4, et: 300 });
      g.refuseJumps = false;
      const tries = g.log.filter((l) => l.startsWith('PUT /rest/watch/focus/')).length;
      check('a replay that stays on screen still gets all six tries', tries === 6 && r.phase === 'error' && /wouldn't jump/.test(r.message || ''), `${tries} ${r.message}`);
    }

    console.log('\nthe game is read again right before it is navigated');
    {
      // Another replay on screen at the click; a live session by the time
      // the replay list has come back.
      const { c: fresh } = controllerFor(port);
      put(OTHER_REPLAY);
      g.hook = (m, u) => { if (u === '/rest/watch/replays') put(LIVE); };
      g.log.length = 0;
      await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      const s = await fresh.settled();
      g.hook = null;
      check('no exit to the menu from a live session', !g.log.includes('POST /navigation/action/NAV_TO_MAIN_MENU'), g.log.join(' | '));
      check('no play either, and it answers blocked', playsIn(g.log).length === 0 && s.phase === 'blocked', s.phase);
      const listAt = g.log.indexOf('GET /rest/watch/replays');
      check('the deciding look came after the list fetch', g.log.indexOf('GET /navigation/state', listAt) > listAt);

      // The driver closed that replay themselves meanwhile: straight to play.
      const { c: f2 } = controllerFor(port);
      put(OTHER_REPLAY);
      g.hook = (m, u) => { if (u === '/rest/watch/replays') Object.assign(g.nav, { navigationState: 'NAV_MAIN_MENU', gameState: 'GSTATE_SETUP' }); };
      g.log.length = 0;
      await f2.openAt({ raceId: RACE, slot: 9, et: 200 });
      const s2 = await f2.settled();
      g.hook = null;
      check('already at the menu: no exit call, loads and ends ready',
        !g.log.includes('POST /navigation/action/NAV_TO_MAIN_MENU') && playsIn(g.log).length === 1 && s2.phase === 'ready', s2.phase);

      // At the menu on the click, in a session by the time play would go out.
      const { c: f3 } = controllerFor(port);
      put(MENU);
      g.hook = (m, u) => { if (u === '/rest/watch/replays') put(LIVE); };
      g.log.length = 0;
      await f3.openAt({ raceId: RACE, slot: 9, et: 200 });
      const s3 = await f3.settled();
      g.hook = null;
      check('menu → live session before play: nothing is played', playsIn(g.log).length === 0 && s3.phase === 'blocked', s3.phase);
    }

    console.log('\ndispose stops what is in flight');
    {
      const realWait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Mid-load: the controller is let go of between accept and play.
      const { c: fresh, seen } = controllerFor(port);
      put(MENU);
      g.log.length = 0;
      const first = await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      fresh.dispose();
      const heard = seen.length;
      await fresh.settled();
      const n = g.log.length;
      await realWait(60);
      check('the load stops at its next await: nothing is played', first.phase === 'loading' && playsIn(g.log).length === 0, g.log.join(' | '));
      check('no request after it settled', g.log.length === n);
      check('no status after dispose', seen.length === heard);
      const after = await fresh.openAt({ raceId: RACE, slot: 9, et: 200 });
      await realWait(30);
      check('a click after dispose sends nothing', g.log.length === n && after.phase === 'loading');

      // Mid-jump, with the watcher on: its finally used to re-arm the timer.
      const w = new LmuReplayController({
        baseUrl: `http://127.0.0.1:${port}`,
        resolveRace: (id) => RACES[id] ?? null,
        vcrMtimeMs,
        watchMs: 15,
        now: virtualClock().now,
        sleep: (ms) => realWait(Math.min(ms, 5)),
      });
      put(MENU);
      await w.openAt({ raceId: RACE, slot: 9, et: 200 });
      await w.settled();
      check('(setup) loaded and ready', w.status().phase === 'ready', w.status().phase);
      g.refuseJumps = true;
      g.log.length = 0;
      const p = w.openAt({ raceId: RACE, slot: 4, et: 300 });
      while (!g.log.some((l) => l.startsWith('PUT /rest/watch/focus/'))) await realWait(2);
      w.dispose();
      await p;
      await w.settled();
      const m = g.log.length;
      await realWait(120);
      g.refuseJumps = false;
      check('mid-jump dispose: no retry and no watcher polls afterwards', g.log.length === m && m <= 3, g.log.join(' | '));
    }
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
