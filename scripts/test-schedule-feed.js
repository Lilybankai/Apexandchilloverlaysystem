/**
 * scripts/test-schedule-feed.js — the Schedule tab's shared web copy.
 * -----------------------------------------------------------------------------
 * The web pit wall shows the calendars a desktop app published
 * (electron/schedule-cloud.js → public.schedule_feed). Three things must hold:
 *
 *   1. forPublish never lets a personal field or a stale/partial copy out.
 *   2. A copy hours old is brought up to date before it is drawn — the league
 *      rounds roll over, the dailies' "next up" is regenerated.
 *   3. The background sweep reads a source ONLY when the shared copy is stale,
 *      so a room of running apps costs RaceOS one read, not one each.
 *
 * Plus the load-order rule that lets the desktop open straight onto the tab.
 *
 * Run: node scripts/test-schedule-feed.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const core = require(path.join(ROOT, 'electron', 'control-panel', 'schedule-core.js'));
const lmuDailies = require(path.join(ROOT, 'electron', 'lmu-dailies.js'));
const scheduleCloud = require(path.join(ROOT, 'electron', 'schedule-cloud.js'));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const NOW = Date.parse('2026-09-30T10:00:00Z');
const iso = (min) => new Date(NOW + min * 60000).toISOString();

/* -------------------------------------------------------------------------- */
console.log('\nforPublish');

const dailies = {
  ok: true,
  fetchedAt: iso(-5),
  weekStart: '2026-09-29T10:00:00.000Z',
  reason: null,
  error: null,
  tiers: [
    {
      key: 'beginner',
      label: 'Beginner',
      events: [{ title: 'LMP3 Fixed', track: 'Fuji', minutesUtc: [0, 45, 90], registrationLeadMin: 30 }],
      next: null,
      upcoming: [],
    },
  ],
  series: [
    {
      title: 'ELMS 4 Hours',
      registered: true,
      next: { id: 'a', startsAt: iso(60), isRegistered: true, registrations: 4 },
      slots: [
        { id: 'a', startsAt: iso(60), isRegistered: true, registrations: 4 },
        { id: 'b', startsAt: iso(300), isRegistered: false, registrations: 0 },
      ],
    },
  ],
};

const pub = core.forPublish('dailies', dailies);
check('a live daily calendar is published', !!pub);
check('…with "you are entered" cleared on the series', pub && pub.series[0].registered === false);
check('…and on every slot', pub && pub.series[0].slots.every((s) => s.isRegistered === false));
check('…and on the series\' next slot', pub && pub.series[0].next.isRegistered === false);
check('…keeping the entry counts', pub && pub.series[0].slots[0].registrations === 4);
check('…without touching the tab\'s own copy', dailies.series[0].registered === true && dailies.series[0].slots[0].isRegistered === true);
check('…and without reason/error', pub && !('reason' in pub) && !('error' in pub));
check('a copy restored from disk is NOT published', core.forPublish('dailies', { ...dailies, cached: true, savedAt: iso(-600) }) === null);
check('a failed read is not published', core.forPublish('dailies', { ...dailies, ok: false }) === null);
check('a daily calendar with no tiers is not published', core.forPublish('dailies', { ...dailies, tiers: [] }) === null);
check('an unknown source is not published', core.forPublish('weekly', dailies) === null);
check('null is not published', core.forPublish('league', null) === null);

const league = {
  ok: true,
  fetchedAt: iso(-5),
  partial: false,
  error: null,
  leagues: [
    {
      id: 1,
      label: 'Thursday league',
      next: null,
      races: [
        { id: 10, name: 'R1', startsAt: iso(-60 * 24 * 7), ended: true, status: 'done' },
        { id: 11, name: 'R2', startsAt: iso(-30), ended: false, status: 'next' },
        { id: 12, name: 'R3', startsAt: iso(60 * 24 * 7), ended: false, status: 'upcoming' },
        { id: 13, name: 'R4', startsAt: iso(60 * 24 * 14), ended: false, status: 'upcoming' },
      ],
    },
  ],
};
check('a complete league read is published', !!core.forPublish('league', league));
check('a PARTIAL league read is not (it would replace a complete one)', core.forPublish('league', { ...league, partial: true }) === null);

/* -------------------------------------------------------------------------- */
console.log('\nrestoreLeague');

const rolled = core.restoreLeague(league, NOW);
const races = rolled.leagues[0].races;
check('a "next" round whose start has passed is done', races[1].status === 'done', races[1]);
check('…and the first open round becomes next', races[2].status === 'next', races[2]);
check('…and is the league\'s hero', rolled.leagues[0].next && rolled.leagues[0].next.id === 12);
check('later rounds stay upcoming', races[3].status === 'upcoming');
const fresh = core.restoreLeague(league, NOW - 60 * 60000);
check('SimGrid\'s own "next" stands while it is still ahead', fresh.leagues[0].races[1].status === 'next' && fresh.leagues[0].next.id === 11);
check('the input is not mutated', league.leagues[0].races[1].status === 'next');

/* -------------------------------------------------------------------------- */
console.log('\nrestoreDailies');

check('the desktop and the web share ONE restore', lmuDailies.restore === core.restoreDailies);
check('…and one upcoming count', lmuDailies.UPCOMING_PER_TIER === core.UPCOMING_PER_TIER);
const r = core.restoreDailies(dailies, NOW);
check('next up is regenerated from the rotation, never in the past', r.tiers[0].next && Date.parse(r.tiers[0].next.startsAt) >= NOW);
check('…at the rotation\'s next start (00:00/00:45/01:30 UTC → 00:00 tomorrow)',
  r.tiers[0].next.startsAt === '2026-10-01T00:00:00.000Z', r.tiers[0].next);
check('…with its entries-open instant', r.tiers[0].next.registrationOpens === '2026-09-30T23:30:00.000Z');
const later = core.restoreDailies(dailies, NOW + 120 * 60000);
check('a special slot that has run is dropped', later.series[0].slots.length === 1 && later.series[0].next.id === 'b');

/* -------------------------------------------------------------------------- */
console.log('\ndailiesFromFeed — which daily copy is drawn');

// This week's RaceOS copy (an app with the game running) …
const appCopy = {
  ok: true,
  fetchedAt: iso(-60),
  weekStart: '2026-09-29T10:00:00.000Z',
  tiers: [{
    key: 'beginner', label: 'Beginner', badge: 'Bronze', cadenceMin: 15,
    events: [{
      seriesId: 's1', title: 'LMP3 Fixed', track: '8 Hours of Bahrain', scene: 'BahrainWEC',
      classes: ['LMP3'], raceMin: 20, fixedSetup: true, tyreSets: 8, tyreWarmers: true, maxPlayers: 20,
      map: { d: 'M0 0L1 1Z', view: 100 }, minutesUtc: [0, 45, 90], registrationLeadMin: 30,
    }],
  }],
  series: [{ title: 'ELMS 4 Hours', registered: false, slots: [{ id: 'x', startsAt: iso(600), isRegistered: false, registrations: 3 }] }],
};
// … and racecontrol.gg's plainer public copy, from the server.
const pubCopy = {
  ok: true, source: 'racecontrol', fetchedAt: iso(-10), weekStart: null, series: [],
  tiers: [{
    key: 'beginner', label: 'Beginner', badge: 'Bronze', cadenceMin: 15,
    events: [
      { title: 'LMP3 Fixed', track: 'Bahrain WEC', scene: null, classes: [], raceMin: null, fixedSetup: null, map: null, eventMin: 32, minutesUtc: [0, 45, 90], registrationLeadMin: 30 },
      { title: 'LMGT3 Fixed', track: 'Spa Francorchamps', scene: null, classes: [], raceMin: null, fixedSetup: null, map: null, eventMin: 32, minutesUtc: [15, 60, 105], registrationLeadMin: 30 },
    ],
  }],
};
const feedRow = (payload, minAgo) => ({ payload, fetched_at: iso(-minAgo), age_sec: minAgo * 60 });

check('nothing in the feed → null', core.dailiesFromFeed({ ok: true, dailies: null, dailies_public: null }, NOW) === null);
check('a null feed → null', core.dailiesFromFeed(null, NOW) === null);

let got = core.dailiesFromFeed({ dailies: feedRow(appCopy, 60), dailies_public: feedRow(pubCopy, 10) }, NOW);
check('this week\'s RaceOS copy wins over the public one', got && got.origin === 'app');
check('…with its circuit maps and classes', got && got.payload.tiers[0].events[0].map && got.payload.tiers[0].events[0].classes[0] === 'LMP3');
check('…brought up to date (next up is in the future)', got && Date.parse(got.payload.tiers[0].next.startsAt) >= NOW);

const lastWeek = { ...appCopy, weekStart: '2026-09-15T10:00:00.000Z' };
got = core.dailiesFromFeed({ dailies: feedRow(lastWeek, 60 * 24 * 9), dailies_public: feedRow(pubCopy, 10) }, NOW);
check('after LMU rotates, the public copy wins', got && got.origin === 'public');
const lmp3Pub = got && got.payload.tiers[0].events.find((e) => e.title === 'LMP3 Fixed');
const gt3Pub = got && got.payload.tiers[0].events.find((e) => e.title === 'LMGT3 Fixed');
check('…the matching series gets its rules back (classes, race length, setup)',
  lmp3Pub && lmp3Pub.classes[0] === 'LMP3' && lmp3Pub.raceMin === 20 && lmp3Pub.fixedSetup === true, lmp3Pub);
check('…and, the track matching too, its proper name and outline',
  lmp3Pub && lmp3Pub.track === '8 Hours of Bahrain' && lmp3Pub.map && lmp3Pub.scene === 'BahrainWEC', lmp3Pub);
check('…an unknown series is left plain — nothing guessed', gt3Pub && gt3Pub.classes.length === 0 && gt3Pub.map === null && gt3Pub.track === 'Spa Francorchamps');
check('…the dated special events still ride along', got && got.payload.series.length === 1);

const moved = { ...pubCopy, tiers: [{ ...pubCopy.tiers[0], events: [{ ...pubCopy.tiers[0].events[0], track: 'Portimao WEC' }] }] };
got = core.dailiesFromFeed({ dailies: feedRow(lastWeek, 60 * 24 * 9), dailies_public: feedRow(moved, 10) }, NOW);
const movedEv = got && got.payload.tiers[0].events[0];
check('a series that moved circuit keeps its rules but NOT last week\'s track or map',
  movedEv && movedEv.classes[0] === 'LMP3' && movedEv.track === 'Portimao WEC' && movedEv.map === null, movedEv);

// Seen live 2026-09-30: last week "One Stint Sprint" ran at Daytona; this week
// racecontrol.gg says Road Atlanta. A first-word match ("road") put Daytona's
// name and outline on it.
const daytona = {
  ...lastWeek,
  tiers: [{ ...appCopy.tiers[0], key: 'advanced', events: [{ ...appCopy.tiers[0].events[0], title: 'One Stint Sprint', track: 'Daytona International Speedway Road Course', scene: 'DAYTONA_RC' }] }],
};
const atlanta = { ...pubCopy, tiers: [{ ...pubCopy.tiers[0], key: 'advanced', events: [{ ...pubCopy.tiers[0].events[0], title: 'One Stint Sprint', track: 'Road Atlanta' }] }] };
got = core.dailiesFromFeed({ dailies: feedRow(daytona, 60 * 24 * 9), dailies_public: feedRow(atlanta, 10) }, NOW);
const osEv = got && got.payload.tiers[0].events[0];
check('"Road Atlanta" is not matched to "Daytona … Road Course"', osEv && osEv.track === 'Road Atlanta' && osEv.map === null, osEv);
const atlantaApp = { ...daytona, tiers: [{ ...daytona.tiers[0], events: [{ ...daytona.tiers[0].events[0], track: 'Michelin Raceway Road Atlanta', scene: 'ATLANTA' }] }] };
got = core.dailiesFromFeed({ dailies: feedRow(atlantaApp, 60 * 24 * 9), dailies_public: feedRow(atlanta, 10) }, NOW);
check('…but is matched to "Michelin Raceway Road Atlanta"', got && got.payload.tiers[0].events[0].track === 'Michelin Raceway Road Atlanta');

got = core.dailiesFromFeed({ dailies: feedRow(lastWeek, 60 * 24 * 9), dailies_public: null }, NOW);
check('an old RaceOS copy alone is still drawn, marked stale', got && got.origin === 'stale');
got = core.dailiesFromFeed({ dailies: null, dailies_public: feedRow(pubCopy, 10) }, NOW);
check('the public copy alone is drawn', got && got.origin === 'public' && got.payload.tiers[0].events.length === 2);
check('…with its age from the row', got && got.ageSec === 600 && got.fetchedAt === iso(-10));

const lg = core.leagueFromFeed({ league: feedRow(league, 30) }, NOW);
check('leagueFromFeed rolls the rounds over', lg && lg.payload.leagues[0].next.id === 12);
check('leagueFromFeed with no row → null', core.leagueFromFeed({ league: null }, NOW) === null);

/* -------------------------------------------------------------------------- */
console.log('\nschedule-cloud');

function fakeAuth({ signedIn = true, age = { ok: true, league: null, dailies: null }, ageOk = true } = {}) {
  const calls = [];
  return {
    calls,
    stateForUi: () => ({ signedIn }),
    rpc: async (fn, body) => {
      calls.push({ fn, body });
      if (fn === 'schedule_feed_age') return ageOk ? { ok: true, body: age } : { ok: false, status: 404, error: 'no fn' };
      if (fn === 'schedule_feed_publish') return { ok: true, body: { ok: true, stored: true } };
      return { ok: false, error: 'unexpected' };
    },
  };
}

function readersCounting() {
  const n = { league: 0, dailies: 0 };
  return {
    n,
    readers: {
      league: async () => { n.league += 1; return league; },
      dailies: async () => { n.dailies += 1; return dailies; },
    },
  };
}

(async () => {
  // Signed out: nothing at all.
  scheduleCloud._reset();
  let auth = fakeAuth({ signedIn: false });
  let rc = readersCounting();
  scheduleCloud.init({ auth, readers: rc.readers });
  scheduleCloud.stop();
  let res = await scheduleCloud.sweep();
  check('signed out: a sweep makes no call and no read', auth.calls.length === 0 && rc.n.league + rc.n.dailies === 0);

  // Both fresh: one RPC, no reads.
  scheduleCloud._reset();
  auth = fakeAuth({ age: { ok: true, league: 600, dailies: 600 } });
  rc = readersCounting();
  scheduleCloud.init({ auth, readers: rc.readers });
  scheduleCloud.stop();
  res = await scheduleCloud.sweep();
  check('both copies fresh: ONE rpc and no reads', auth.calls.length === 1 && rc.n.league + rc.n.dailies === 0, auth.calls.map((c) => c.fn));

  // Dailies stale, league fresh.
  scheduleCloud._reset();
  auth = fakeAuth({ age: { ok: true, league: 600, dailies: scheduleCloud.STALE_SEC.dailies + 1 } });
  rc = readersCounting();
  scheduleCloud.init({ auth, readers: rc.readers });
  scheduleCloud.stop();
  res = await scheduleCloud.sweep();
  check('a stale daily copy is re-read…', rc.n.dailies === 1 && rc.n.league === 0, rc.n);
  const sent = auth.calls.find((c) => c.fn === 'schedule_feed_publish');
  check('…and published', !!sent && sent.body.p_source === 'dailies');
  check('…through forPublish (no personal flags)', sent && sent.body.p_payload.series[0].registered === false);
  check('…stamped with the time the DESKTOP read it', sent && sent.body.p_fetched_at === dailies.fetchedAt);

  // Never published at all (null age) counts as stale.
  scheduleCloud._reset();
  auth = fakeAuth({ age: { ok: true, league: null, dailies: null } });
  rc = readersCounting();
  scheduleCloud.init({ auth, readers: rc.readers });
  scheduleCloud.stop();
  res = await scheduleCloud.sweep();
  check('an empty feed is filled from both sources', rc.n.league === 1 && rc.n.dailies === 1, rc.n);

  // The migration is missing (the age RPC 404s): quiet no-op.
  scheduleCloud._reset();
  auth = fakeAuth({ ageOk: false });
  rc = readersCounting();
  scheduleCloud.init({ auth, readers: rc.readers });
  scheduleCloud.stop();
  res = await scheduleCloud.sweep();
  check('no feed on the project: no reads, no publish, no throw', res.ok === false && rc.n.league + rc.n.dailies === 0);

  // offer(): the gap stops a tab that is refreshed repeatedly.
  scheduleCloud._reset();
  auth = fakeAuth();
  scheduleCloud.init({ auth, readers: {} });
  scheduleCloud.stop();
  const first = await scheduleCloud.publish('league', league, NOW);
  const second = await scheduleCloud.publish('league', league, NOW + 60000);
  const third = await scheduleCloud.publish('league', league, NOW + scheduleCloud.PUBLISH_GAP_MS + 1);
  check('a live league read is published', first.ok === true);
  check('…but not again within the gap', second.ok === false && second.reason === 'recent');
  check('…and again after it', third.ok === true);
  const cachedTry = await scheduleCloud.publish('dailies', { ...dailies, cached: true }, NOW);
  check('a saved daily copy is never sent', cachedTry.reason === 'nothing');
  scheduleCloud._reset();

  /* ------------------------------------------------------------------------ */
  console.log('\nload order');

  const html = fs.readFileSync(path.join(ROOT, 'electron', 'control-panel', 'index.html'), 'utf8');
  const sp = html.indexOf('<script src="schedule-panel.js"></script>');
  const cp = html.indexOf('<script src="control-panel.js"></script>');
  const fc = html.indexOf('<script src="feature-catalog.js"></script>');
  check('the desktop loads schedule-panel.js', sp > 0);
  check('…BEFORE control-panel.js (a launch that opens on Schedule)', sp > 0 && sp < cp);
  check('…and after feature-catalog.js (it counts usage)', fc > 0 && fc < sp);
  const board = fs.readFileSync(path.join(ROOT, 'web', 'src', 'board.html'), 'utf8');
  const order = ['schedule-core.js', 'web-bridge.js', 'schedule-panel.js', 'web-shell.js'].map((f) =>
    board.indexOf(`<script src="${f}"></script>`),
  );
  check('the web loads core → bridge → panel → shell', order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), order);
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-web.js'), 'utf8');
  check('build-web ships the Schedule files', ['schedule-core.js', 'schedule-panel.js', 'schedule-panel.css'].every((f) => build.includes(`'${f}'`)));

  console.log(`\n${failed ? 'FAILED' : 'OK'} - ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
