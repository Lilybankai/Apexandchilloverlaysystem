/**
 * scripts/test-schedule.js — SimGrid championship mapping for the Schedule tab.
 * -----------------------------------------------------------------------------
 * The tab's only job is to show the league calendar honestly: the next round,
 * the remaining rounds, and a signup URL that actually opens SimGrid. The
 * mapping from GridOS JSON onto that shape is easy to get quietly wrong
 * (unsorted rounds, a past race labelled "next", a crafted photo URL leaking
 * into CSS, the API key travelling with the payload), so this asserts it
 * without Electron and without the renderer.
 *
 * Run: node scripts/test-schedule.js
 */

'use strict';

const simgrid = require('../electron/simgrid');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

const THURSDAY_SPEC = simgrid.LEAGUES.find((l) => l.id === 25619);
const SATURDAY_SPEC = simgrid.LEAGUES.find((l) => l.id === 24215);

/* A reduced GridOS championship: two finished rounds and two still to run. */
const RAW = {
  id: 25619,
  name: 'LMU Apex And Chill Thursday League LMP2 & GT3',
  game_name: 'Le Mans Ultimate',
  url: 'https://www.thesimgrid.com/championships/25619',
  results_url: 'https://www.thesimgrid.com/championships/25619/results',
  discord_url: 'https://discord.gg/3sKF42Pk8e',
  accepting_registrations: true,
  spots_taken: 35,
  capacity: 38,
  image: 'https://cdn.thesimgrid.com/zuwclajcyc6be5x1k6seai3mhc3w',
  upcoming_race: { id: 2002 },
  races: [
    {
      id: 2001,
      race_name: 'Round 6 Lusail',
      display_name: 'Round 6 Lusail',
      starts_at: '2026-08-20T18:45:00.000Z',
      ended: true,
      results_available: false,
      track: {
        name: 'Qatar (WEC)',
        composite_name: 'Qatar (WEC)',
        photo: 'https://cdn.thesimgrid.com/qatar',
      },
    },
    {
      id: 2003,
      race_name: 'Round 8 Cota',
      display_name: 'Round 8 Cota',
      starts_at: '2026-09-10T18:45:00.000Z',
      ended: false,
      results_available: false,
      track: {
        name: 'COTA (WEC)',
        composite_name: 'COTA (WEC)',
        photo: 'https://evil.example/not-a-cdn.png',
      },
    },
    {
      id: 2002,
      race_name: 'Round 7 Daytona',
      display_name: 'Round 7 Daytona',
      starts_at: '2026-08-27T18:46:00.000Z',
      ended: false,
      results_available: false,
      track: {
        name: 'Daytona International Speedway Road Course',
        composite_name: 'Daytona International Speedway Road Course',
        photo: 'https://cdn.thesimgrid.com/daytona',
      },
    },
  ],
};

const NOW = Date.parse('2026-08-21T17:00:00.000Z');

console.log('\nleague ids');
check('Thursday championship is 25619', THURSDAY_SPEC && THURSDAY_SPEC.id === 25619);
check('Saturday championship is 24215', SATURDAY_SPEC && SATURDAY_SPEC.id === 24215);
check('Thursday labelled Thursday', THURSDAY_SPEC && THURSDAY_SPEC.day === 'thursday');
check('Saturday labelled Saturday', SATURDAY_SPEC && SATURDAY_SPEC.day === 'saturday');

console.log('\nleagueOf — shape and order');
{
  const league = simgrid.leagueOf(RAW, THURSDAY_SPEC, NOW);
  check('keeps championship id', league.id === 25619);
  check('keeps the SimGrid name', league.name.includes('Thursday'));
  check('signup url is the championship page', league.url === simgrid.championshipUrl(25619));
  check('results url is the results page', league.url.endsWith('/25619') && league.resultsUrl.endsWith('/results'));
  check('discord invite survives', league.discordUrl === 'https://discord.gg/3sKF42Pk8e');
  check('registration flag', league.accepting === true);
  check('spots 35/38', league.spotsTaken === 35 && league.capacity === 38);
  check('cdn image kept', league.image === RAW.image);
  check('three races', league.races.length === 3, league.races.length);
  check(
    'races sorted by start time',
    league.races.map((r) => r.id).join(',') === '2001,2002,2003',
    league.races.map((r) => r.id).join(','),
  );
  check('past round is done', league.races[0].status === 'done');
  check('upcoming_race is next', league.races[1].status === 'next' && league.next && league.next.id === 2002);
  check('later round is upcoming', league.races[2].status === 'upcoming');
  check('next race name', league.next && league.next.name === 'Round 7 Daytona');
  check('next track name', league.next && league.next.track.name.includes('Daytona'));
  check('cdn photo kept on next', league.next && league.next.track.photo === 'https://cdn.thesimgrid.com/daytona');
  check('non-cdn photo stripped', league.races[2].track.photo === null);
  check(
    'each race signs up on the championship page',
    league.races.every((r) => r.signupUrl === league.url),
  );
}

console.log('\nleagueOf — hostile input');
{
  const league = simgrid.leagueOf(
    {
      id: 25619,
      name: 'X',
      url: 'https://evil.example/phish',
      results_url: 'javascript:alert(1)',
      discord_url: 'https://evil.example/discord',
      image: 'https://evil.example/img.png',
      races: [
        {
          id: 1,
          race_name: 'Round 1',
          starts_at: '2026-09-01T18:00:00.000Z',
          ended: false,
          track: { photo: 'javascript:alert(1)', name: 'Spa' },
        },
        {
          id: 2,
          race_name: 'Round 2',
          starts_at: '2026-09-08T18:00:00.000Z',
          ended: false,
          track: { photo: 'https://cdn.thesimgrid.com/foo"bar', name: 'Monza' },
        },
      ],
    },
    THURSDAY_SPEC,
    NOW,
  );
  check('hostile championship url replaced', league.url === simgrid.championshipUrl(25619), league.url);
  check('hostile results url replaced', league.resultsUrl === simgrid.resultsUrl(25619), league.resultsUrl);
  check('hostile discord dropped', league.discordUrl === null);
  check('hostile image dropped', league.image === null);
  check('hostile track photo dropped', league.races[0].track.photo === null);
  check('quoted cdn photo dropped', league.races[1].track.photo === null);
  check('missing upcoming_race still marks first open as next', league.races[0].status === 'next');
}

console.log('\nisSimGridUrl');
check('championship page allowed', simgrid.isSimGridUrl('https://www.thesimgrid.com/championships/25619'));
check('bare host allowed', simgrid.isSimGridUrl('https://thesimgrid.com/championships/25619'));
check('cdn allowed', simgrid.isSimGridUrl('https://cdn.thesimgrid.com/foo'));
check('http rejected', !simgrid.isSimGridUrl('http://www.thesimgrid.com/championships/25619'));
check('subdomain rejected', !simgrid.isSimGridUrl('https://evil.thesimgrid.com/x'));
check('lookalike rejected', !simgrid.isSimGridUrl('https://www.thesimgrid.com.evil.tld/x'));

console.log('\ngetSchedule — injected fetch, no key leak, cache');
{
  simgrid.resetCache();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init && init.headers && init.headers.Authorization });
    const id = Number(String(url).split('/').pop());
    const spec = simgrid.LEAGUES.find((l) => l.id === id) || THURSDAY_SPEC;
    return {
      ok: true,
      json: async () => ({ ...RAW, id, name: spec.label, upcoming_race: { id: 2002 } }),
    };
  };
  return simgrid
    .getSchedule({ force: true, now: NOW, fetchImpl })
    .then((first) => {
      check('ok', first.ok === true);
      check('two leagues', first.leagues.length === 2, first.leagues.length);
      check('fetched both championships', seen.length === 2, seen.length);
      check(
        'Authorization is Bearer (not exposed on payload)',
        seen.every((s) => typeof s.auth === 'string' && s.auth.startsWith('Bearer ')),
      );
      const blob = JSON.stringify(first);
      check('payload does not contain the API key', !blob.includes('PhEDyzEVPztV4yMJYsmQjKWy'));
      check('payload does not contain Bearer', !blob.includes('Bearer'));
      check(
        'Thursday then Saturday',
        first.leagues[0].day === 'thursday' && first.leagues[1].day === 'saturday',
        first.leagues.map((l) => l.day).join(','),
      );
      check('signup links are https SimGrid', first.leagues.every((l) => simgrid.isSimGridUrl(l.url)));
      return simgrid.getSchedule({ now: NOW + 1000, fetchImpl }).then((second) => {
        check('cache reused within five minutes', seen.length === 2 && second === first, seen.length);
        return simgrid.getSchedule({ force: true, now: NOW + 1000, fetchImpl }).then(() => {
          check('force bypasses the cache', seen.length === 4, seen.length);
        });
      });
    })
    .then(() => liveFetch())
    .then(() => {
      console.log(`\n${passed} passed, ${failed} failed\n`);
      process.exit(failed ? 1 : 0);
    })
    .catch((err) => {
      failed++;
      console.log(`  FAIL  getSchedule threw   [${err && err.message}]`);
      console.log(`\n${passed} passed, ${failed} failed\n`);
      process.exit(1);
    });
}

async function liveFetch() {
  console.log('\ngetSchedule — live SimGrid (the two league championships)');
  simgrid.resetCache();
  const res = await simgrid.getSchedule({ force: true });
  check('live ok', res.ok === true, res.error);
  if (!res.ok) return;
  check('live returned both leagues', res.leagues.length === 2, res.leagues.length);
  const thu = res.leagues.find((l) => l.id === 25619);
  const sat = res.leagues.find((l) => l.id === 24215);
  check('live Thursday present', !!thu, thu && thu.name);
  check('live Saturday present', !!sat, sat && sat.name);
  check('live Thursday has races', thu && thu.races.length > 0, thu && thu.races.length);
  check('live Saturday has races', sat && sat.races.length > 0, sat && sat.races.length);
  check('live Thursday next race', !!(thu && thu.next), thu && thu.next && thu.next.name);
  check('live Saturday next race', !!(sat && sat.next), sat && sat.next && sat.next.name);
  check(
    'live signup URLs are SimGrid championship pages',
    [thu, sat].every((l) => l && simgrid.isSimGridUrl(l.url) && /\/championships\/\d+$/.test(l.url)),
  );
  check('live payload has no API key', !JSON.stringify(res).includes('PhEDyzEVPztV4yMJYsmQjKWy'));
}
