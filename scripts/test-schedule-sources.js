/**
 * scripts/test-schedule-sources.js — the server job's two readers.
 * -----------------------------------------------------------------------------
 * supabase/functions/_shared/schedule-sources.mjs is what schedule-refresh runs
 * every two hours. It is plain JavaScript precisely so this file can import the
 * SAME code the server runs:
 *
 *   1. parseRaceControl over a saved copy of racecontrol.gg's daily section
 *      (scripts/fixtures/racecontrol-daily.html, fetched 2026-09-30): every
 *      tier, every event, the full day's rotation rebuilt from what is left.
 *   2. The league shaping is a mirror of electron/simgrid.js — run both over
 *      the same SimGrid payload and fail if they ever disagree.
 *   3. The small parsers, at their edges (year roll-over, 12 am/pm, one start
 *      left in the day), and a redesigned page reading as null, not as [].
 *
 * Run: node scripts/test-schedule-sources.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const simgrid = require(path.join(ROOT, 'electron', 'simgrid.js'));

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

(async () => {
  const src = await import(
    pathToFileURL(path.join(ROOT, 'supabase', 'functions', '_shared', 'schedule-sources.mjs')).href
  );

  /* ------------------------------------------------------------------------ */
  console.log('\nparseRaceControl — the saved page');

  const html = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'racecontrol-daily.html'), 'utf8');
  const NOW = Date.parse('2026-09-30T11:36:00Z');
  const p = src.parseRaceControl(html, NOW);
  check('it reads', !!p && p.ok === true);
  check('…as racecontrol, stamped now', p && p.source === 'racecontrol' && p.fetchedAt === new Date(NOW).toISOString());
  check('…three tiers in order', p && p.tiers.map((t) => t.key).join() === 'beginner,intermediate,advanced', p && p.tiers.map((t) => t.key));
  check('…three events in each', p && p.tiers.every((t) => t.events.length === 3));
  check('…with the badges the desktop uses', p && p.tiers.map((t) => t.badge).join() === 'Bronze,Silver,Gold');
  check('…and RaceOS\'s cadences (15/20/30)', p && p.tiers.map((t) => t.cadenceMin).join() === '15,20,30', p && p.tiers.map((t) => t.cadenceMin));

  const ev = (tier, title) => p.tiers.find((t) => t.key === tier).events.find((e) => e.title === title);
  const lmp3 = ev('beginner', 'LMP3 Fixed');
  check('an event: title, tidied track, whole-event length', lmp3 && lmp3.track === 'Bahrain WEC' && lmp3.eventMin === 32, lmp3);
  check('…a whole day of starts, every 45 min', lmp3 && lmp3.minutesUtc.length === 32 && lmp3.minutesUtc[1] - lmp3.minutesUtc[0] === 45);
  check('…from midnight, at the offsets RaceOS gives (:00)', lmp3 && lmp3.minutesUtc[0] === 0);
  const wec = ev('advanced', 'WEC-Xperience');
  check('"1h 14 minutes" reads as 74', wec && wec.eventMin === 74, wec && wec.eventMin);
  check('advanced runs every 90 min (16 a day)', wec && wec.minutesUtc.length === 16);
  const beach = ev('intermediate', 'LMGT3 Sprint Cup');
  check('"Long Beach 2026" loses its year', beach && beach.track === 'Long Beach', beach && beach.track);
  check('nothing is guessed: no classes, no race length, no rules', [lmp3, wec, beach].every(
    (e) => e.classes.length === 0 && e.raceMin === null && e.fixedSetup === null && e.map === null,
  ));
  check('entries open 30 min before, like RaceOS', lmp3.registrationLeadMin === 30);
  check('no special events (the page has none)', p.series.length === 0 && p.weekStart === null);

  // The restored calendar the renderer draws.
  const core = require(path.join(ROOT, 'electron', 'control-panel', 'schedule-core.js'));
  const drawn = core.restoreDailies(p, NOW);
  check('restoreDailies turns it into a "next up" per tier', drawn.tiers.every((t) => t.next && Date.parse(t.next.startsAt) >= NOW));
  check('…the beginner next start is 11:45 UTC (the first time on the page)',
    drawn.tiers[0].next.startsAt === '2026-09-30T11:45:00.000Z', drawn.tiers[0].next.startsAt);

  /* ------------------------------------------------------------------------ */
  console.log('\nparseRaceControl — a redesign');

  check('no daily section → null', src.parseRaceControl('<html><body>new site</body></html>', NOW) === null);
  check('a section with no cards → null', src.parseRaceControl('<h2>Upcoming Daily Races</h2></section>', NOW) === null);
  check('nothing at all → null', src.parseRaceControl('', NOW) === null && src.parseRaceControl(null, NOW) === null);

  /* ------------------------------------------------------------------------ */
  console.log('\nthe small parsers');

  check('"30 Sep at 11:45am" → 11:45 UTC', src.parseStart('30 Sep at 11:45am', NOW) === Date.parse('2026-09-30T11:45:00Z'));
  check('12:15am is 00:15', src.parseStart('1 Oct at 12:15am', NOW) === Date.parse('2026-10-01T00:15:00Z'));
  check('12:30pm is 12:30', src.parseStart('30 Sep at 12:30pm', NOW) === Date.parse('2026-09-30T12:30:00Z'));
  const nye = Date.parse('2026-12-31T23:30:00Z');
  check('read on New Year\'s Eve, "1 Jan" is next year', src.parseStart('1 Jan at 12:00am', nye) === Date.parse('2027-01-01T00:00:00Z'));
  check('rubbish → null', src.parseStart('tomorrow-ish', NOW) === null);
  check('"44 minutes" → 44', src.parseDuration('44 minutes') === 44);
  check('"2 hours" → 120', src.parseDuration('2 hours') === 120);
  check('"TBC" → null', src.parseDuration('TBC') === null);
  const one = src.minutesPattern([Date.parse('2026-09-30T23:25:00Z')], 90);
  check('one start left → the tier\'s spacing rebuilds the day', one.length === 16 && one.includes(1405) && one[0] === 55, one.slice(0, 3));
  check('no starts → no pattern', src.minutesPattern([], 45).length === 0);

  /* ------------------------------------------------------------------------ */
  console.log('\nleague — the server\'s copy of electron/simgrid.js');

  const raw = {
    id: 25619,
    name: 'LMU Apex And Chill Thursday League LMP2 & GT3',
    game_name: 'Le Mans Ultimate',
    url: 'https://www.thesimgrid.com/championships/25619',
    results_url: 'javascript:alert(1)',
    discord_url: 'https://discord.gg/3sKF42Pk8e',
    accepting_registrations: true,
    spots_taken: 35,
    capacity: 38,
    image: 'https://evil.example/x.png',
    upcoming_race: { id: 3 },
    races: [
      { id: 3, display_name: 'Round 3', starts_at: '2026-10-08T18:45:00Z', track: { name: 'Spa', photo: 'https://cdn.thesimgrid.com/abc' } },
      { id: 1, race_name: 'Round 1', starts_at: '2026-09-10T18:45:00Z', ended: true, results_available: true, track: { composite_name: 'COTA (WEC)' } },
      { id: 2, display_name: 'Round 2', starts_at: '2026-09-29T18:45:00Z', track: null },
      { id: 4, display_name: 'Round 4', starts_at: '2026-10-22T18:45:00Z', track: { name: 'Le Mans', photo: 'http://cdn.thesimgrid.com/x' } },
    ],
  };
  const spec = simgrid.LEAGUES[0];
  for (const now of [NOW, Date.parse('2026-10-09T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z')]) {
    const desktop = simgrid.leagueOf(raw, spec, now);
    const server = src.leagueOf(raw, spec, now);
    check(`identical to the desktop at ${new Date(now).toISOString().slice(0, 10)}`,
      JSON.stringify(desktop) === JSON.stringify(server));
  }
  check('same championship list', JSON.stringify(src.LEAGUES) === JSON.stringify(simgrid.LEAGUES));

  const seen = [];
  const fakeFetch = (fail) => async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    return { ok: !fail, status: fail ? 500 : 200, json: async () => ({ ...raw, id: Number(url.split('/').pop()) }) };
  };
  const both = await src.readLeague('KEY', fakeFetch(false), NOW);
  check('readLeague reads both championships', both && both.ok && both.leagues.length === 2);
  check('…from the SimGrid API, with the key as a Bearer',
    seen.length === 2 && seen.every((x) => x.auth === 'Bearer KEY' && x.url.startsWith('https://www.thesimgrid.com/api/v1/championships/')), seen);
  check('…and refuses a partial read', (await src.readLeague('KEY', fakeFetch(true), NOW)) === null);

  console.log(`\n${failed ? 'FAILED' : 'OK'} - ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
