/**
 * scripts/test-dailies.js — LMU's official race calendar, mapped.
 * -----------------------------------------------------------------------------
 * `electron/lmu-dailies.js` turns three RaceOS payloads into the cards the
 * Schedule tab draws. Every interesting bug in that mapping is SILENT — the tab
 * still renders, the times still tick, and the driver is simply told the wrong
 * thing about a race they are about to enter. Two of them were live in the
 * first cut and are the reason this file exists:
 *
 *   1. **`seriesId` names the TIER, not the event.** All three Beginner events
 *      share `9e88176e-…`, so joining an event's settings to it gives every
 *      Beginner race whichever settings landed first — "LMP3 Fixed at Bahrain".
 *      The join is the event TITLE, within its tier.
 *   2. **`entryRequirement` is a floor, not the tier's SR band.** The service
 *      answers {rank:"Bronze", tier:0} for beginner, intermediate AND advanced.
 *      Badging tiers from it tells a Bronze driver the Gold races are open.
 *
 * The rest holds the contract the renderer leans on: times are UTC ISO and
 * sorted, past occurrences are gone, a class chip is never guessed, and a
 * failure is an empty payload with a reason rather than a throw.
 *
 * Fixtures are trimmed from real responses captured 2026-09-17
 * (`scripts/probe-lmu-dailies.js --out`), keeping the shapes exactly.
 *
 * Run: node scripts/test-dailies.js
 */

'use strict';

const dailies = require('../electron/lmu-dailies');

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

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const NOW = Date.parse('2026-09-17T10:05:00Z');

/** One `daily/schedule` tier entry. Note `seriesid`, lower-case `id`. */
function scheduleEvent(name, scene, track, cars, duration, times) {
  return {
    seriesid: '9e88176e-a25b-435c-ad2f-03d111d7a04e', // the TIER's id, shared
    eventname: name,
    scene,
    track,
    tracklayout: '',
    cars,
    duration,
    heroimage: 'https://rf2-ui-images-prod.s3.eu-west-1.amazonaws.com/hero.webp',
    cardimage: 'https://rf2-ui-images-prod.s3.eu-west-1.amazonaws.com/card.webp',
    times,
  };
}

const SCHEDULE = {
  tiers: {
    beginner: [
      scheduleEvent('LMP3 Fixed', 'MonzaWEC', 'Monza', ['Ligier_JSP325_2025'], '31m30s', [
        '2026-09-17T10:00:00Z',
        '2026-09-17T10:30:00Z',
        '2026-09-17T11:15:00Z',
      ]),
      scheduleEvent('LMGT3 Fixed', 'BahrainWEC', 'BahrainWEC_2023', ['BMW_M4_LMGT3_2023'], '31m30s', [
        '2026-09-17T09:15:00Z', // already gone at NOW
        '2026-09-17T10:45:00Z',
      ]),
      scheduleEvent('LMGTE Fixed', 'SpaWEC', 'Spa Francorchamps', ['Ferrari_488_GTE_2023'], '31m30s', [
        '2026-09-17T10:15:00Z',
      ]),
    ],
    intermediate: [],
    advanced: [],
  },
  frequency: { beginner: '15 mins', intermediate: '20 mins', advanced: '30 mins' },
};

/** One `daily/list/{tier}` instance, trimmed to the fields the mapping reads. */
function listItem(title, trackName, trackFriendly, layoutName, cars, raceDuration, over = {}) {
  return {
    id: `id-${title}`,
    seriesId: '9e88176e-a25b-435c-ad2f-03d111d7a04e', // shared again — the trap
    type: 'daily',
    status: 'Waiting',
    configuration: {
      seriesId: '9e88176e-a25b-435c-ad2f-03d111d7a04e',
      title,
      starts: '2026-09-17T10:00:00Z',
      registrationOpens: '2026-09-17T09:30:00Z',
      tier: { name: 'beginner', entryRequirement: { rank: 'Bronze', tier: 0 } },
      content: {
        track: {
          name: trackName,
          friendly: trackFriendly,
          subItems: [{ name: layoutName, friendly: trackFriendly }],
        },
        cars: cars.map((friendly) => ({ name: friendly, friendly })),
      },
      sessions: [
        { type: 'Practice', duration: '3m', waitTime: '0m', timeOfDay: '13h40m' },
        { type: 'Qualifying', duration: '7m', waitTime: '0m', timeOfDay: '13h45m' },
        { type: 'Race', duration: raceDuration, waitTime: '4m', timeOfDay: '14h' },
      ],
      settings: {
        fixedSetup: true,
        maxPlayers: 20,
        tires: { limitedTireSets: true, availableTires: 8 },
        tyreWarmers: true,
        ...over,
      },
    },
    registrations: [],
  };
}

const BEGINNER_LIST = [
  listItem('LMGT3 Fixed', 'BahrainWEC', 'BahrainWEC_2023', '8 Hours of Bahrain', ['BMW_M4_LMGT3_2023'], '20m'),
  listItem('LMGTE Fixed', 'SpaWEC', 'Spa Francorchamps', '6 Hours of Spa-Francorchamps', ['Ferrari_488_GTE_2023'], '20m'),
  listItem('LMP3 Fixed', 'MonzaWEC', 'Monza', '6 Hours of Monza', ['Ligier_JSP325_2025'], '20m', {
    maxPlayers: 24, // a per-event difference the join must preserve
  }),
];

const WEEKLY = [
  {
    seriesId: '6aaa8dc4868a2490734ac62f',
    starts: '2026-09-17T10:00:00Z',
    teamEvent: false,
    title: 'WEC Weekly Community Tests',
    tier: { name: 'weekly', entryRequirement: { rank: 'Silver', tier: 2 } },
    type: 'specialevent',
    configuration: {
      content: {
        track: { name: 'LeMansWEC', friendly: 'Le Mans', subItems: [{ name: '24 Heures du Mans' }] },
        cars: [{ friendly: 'Oreca_07_ELMS_2023' }, { friendly: 'Ferrari_499P_2023' }],
      },
      sessions: [{ type: 'Race', duration: '1h30m' }],
      settings: { tires: { availableTires: 10 }, tyreWarmers: false, fixedSetup: false, maxPlayers: 62 },
    },
    events: [
      { id: 'w1', starts: '2026-09-17T08:00:00Z', registrationOpens: '2026-09-16T08:00:00Z', registrations: 61, isRegistered: false },
      { id: 'w3', starts: '2026-09-17T14:00:00Z', registrationOpens: '2026-09-16T14:00:00Z', registrations: 6, isRegistered: true },
      { id: 'w2', starts: '2026-09-17T12:00:00Z', registrationOpens: '2026-09-16T12:00:00Z', registrations: 7, isRegistered: false },
    ],
  },
];

/* -------------------------------------------------------------------------- */

console.log('\nCar classes — never guessed');
{
  check('LMGT3 from a GT3 car', dailies.classesOf(['BMW_M4_LMGT3_2023']).join() === 'LMGT3');
  check('LMP2 from an Oreca', dailies.classesOf(['Oreca_07_ELMS_2023']).join() === 'LMP2');
  check('LMP3 from a Ligier JSP3', dailies.classesOf(['Ligier_JSP325_2025']).join() === 'LMP3');
  check('Hypercar from a 499P', dailies.classesOf(['Ferrari_499P_2023']).join() === 'Hypercar');
  const multi = dailies.classesOf(['Oreca_07_ELMS_2023', 'Ligier_JSP325_2025', 'BMW_M4_LMGT3_2023']);
  check('display order is fixed, not arrival order', multi.join('/') === 'LMP2/LMP3/LMGT3', multi.join('/'));
  check('a repeat class appears once', dailies.classesOf(['BMW_M4_LMGT3_2023', 'Ferrari_296GT3_2023']).length === 1);
  check('an unknown car contributes no chip', dailies.classesOf(['Some_New_Thing_2031']).length === 0);
  check('a non-array is not a crash', dailies.classesOf(null).length === 0);
}

console.log('\nDurations');
{
  check('"20m" → 20', dailies.durationMin('20m') === 20);
  check('"1h12m30s" → 72.5', dailies.durationMin('1h12m30s') === 72.5);
  check('"1h30m" → 90', dailies.durationMin('1h30m') === 90);
  check('unparseable → null, not 0', dailies.durationMin('soon') === null);
  check('empty → null', dailies.durationMin('') === null);
  check('"15 mins" cadence → 15', dailies.cadenceMin('15 mins') === 15);
  check('missing cadence → null', dailies.cadenceMin(undefined) === null);
}

console.log('\nThe seriesId trap — settings must follow the TITLE, not the id');
{
  const p = dailies.buildPayload(
    { schedule: SCHEDULE, lists: { beginner: BEGINNER_LIST }, specials: {} },
    NOW,
  );
  const beginner = p.tiers.find((t) => t.key === 'beginner');
  const byTitle = new Map(beginner.events.map((e) => [e.title, e]));

  check('all three events kept', beginner.events.length === 3, beginner.events.map((e) => e.title).join());
  check('LMGT3 Fixed is at Bahrain', byTitle.get('LMGT3 Fixed').track === '8 Hours of Bahrain', byTitle.get('LMGT3 Fixed').track);
  check('LMP3 Fixed is at Monza', byTitle.get('LMP3 Fixed').track === '6 Hours of Monza', byTitle.get('LMP3 Fixed').track);
  check('LMGTE Fixed is at Spa', byTitle.get('LMGTE Fixed').track === '6 Hours of Spa-Francorchamps', byTitle.get('LMGTE Fixed').track);
  check(
    'three events, three tracks — not one repeated',
    new Set(beginner.events.map((e) => e.track)).size === 3,
  );
  check('a per-event setting survives the join', byTitle.get('LMP3 Fixed').maxPlayers === 24, byTitle.get('LMP3 Fixed').maxPlayers);
  check('classes come from the event, not the tier', byTitle.get('LMGTE Fixed').classes.join() === 'LMGTE');
  check('race length is the RACE session, not the whole event', byTitle.get('LMGT3 Fixed').raceMin === 20);
  check('event length is still carried', byTitle.get('LMGT3 Fixed').eventMin === 31.5);
}

console.log('\nTier badges — the SR band, not the matchmaker floor');
{
  const p = dailies.buildPayload({ schedule: SCHEDULE, lists: { beginner: BEGINNER_LIST }, specials: {} }, NOW);
  const badges = p.tiers.map((t) => `${t.label}:${t.badge}`);
  check('beginner is Bronze', p.tiers[0].badge === 'Bronze');
  check('intermediate is Silver, not the served Bronze', p.tiers[1].badge === 'Silver', badges.join(' '));
  check('advanced is Gold, not the served Bronze', p.tiers[2].badge === 'Gold', badges.join(' '));
  check('cadence is read per tier', p.tiers.map((t) => t.cadenceMin).join() === '15,20,30');
}

console.log('\nOccurrences');
{
  const p = dailies.buildPayload({ schedule: SCHEDULE, lists: { beginner: BEGINNER_LIST }, specials: {} }, NOW);
  const beginner = p.tiers.find((t) => t.key === 'beginner');
  const times = beginner.upcoming.map((u) => u.startsAt);

  check('the past occurrence is dropped', !times.includes('2026-09-17T09:15:00.000Z'), times.join(' '));
  check('next is the soonest of ALL events, across the rotation', beginner.next.startsAt === '2026-09-17T10:15:00.000Z', beginner.next.startsAt);
  check('next names the right event', beginner.next.title === 'LMGTE Fixed', beginner.next.title);
  check(
    'sorted by time, not grouped by event',
    times.join(' ') === [...times].sort().join(' '),
    times.map((t) => t.slice(11, 16)).join(' '),
  );
  check('every time is a UTC ISO string', times.every((t) => t.endsWith('Z') && !Number.isNaN(Date.parse(t))));
  check(
    'registration opens is derived from the served lead, not assumed',
    beginner.next.registrationOpens === '2026-09-17T09:45:00.000Z',
    beginner.next.registrationOpens,
  );
  check('the occurrence carries what a card needs', beginner.next.raceMin === 20 && beginner.next.tyreSets === 8);
  check('raw time arrays are not shipped to the renderer', !('times' in beginner.events[0]));
}

console.log('\nThe repeating pattern the calendar is built from');
{
  check('minutes past UTC midnight', dailies.minutesOfDay(['2026-09-17T00:15:00Z', '2026-09-17T13:45:00Z']).join() === '15,825');
  check('sorted, whatever order they arrive in', dailies.minutesOfDay(['2026-09-17T23:45:00Z', '2026-09-17T00:00:00Z']).join() === '0,1425');
  check('duplicates collapse', dailies.minutesOfDay(['2026-09-17T10:00:00Z', '2026-09-18T10:00:00Z']).join() === '600');
  check('a start off the minute is dropped, never rounded', dailies.minutesOfDay(['2026-09-17T10:00:30Z']).length === 0);
  check('junk is not a crash', dailies.minutesOfDay(['soon', null, undefined]).length === 0);

  const p = dailies.buildPayload({ schedule: SCHEDULE, lists: { beginner: BEGINNER_LIST }, specials: {} }, NOW);
  const beginner = p.tiers.find((t) => t.key === 'beginner');
  const byTitle = new Map(beginner.events.map((e) => [e.title, e]));
  check('every event carries its pattern', beginner.events.every((e) => Array.isArray(e.minutesUtc)));
  check(
    'and it is the whole day, including starts already past',
    byTitle.get('LMGT3 Fixed').minutesUtc.join() === '555,645',
    byTitle.get('LMGT3 Fixed').minutesUtc.join(),
  );
  /* The calendar leans on this: 45, 60 and 90 all divide 1440, so one day's
     pattern is every day's pattern and any date can be drawn without another
     fetch. If LMU ever ships a cadence that does not divide a day, projecting
     it forward would drift — and this is where that shows up. */
  const REAL_CADENCES = [45, 60, 90];
  check('every real cadence divides a day exactly', REAL_CADENCES.every((c) => 1440 % c === 0), REAL_CADENCES.join('/'));
}

console.log('\nSpecial events');
{
  const p = dailies.buildPayload({ schedule: SCHEDULE, lists: {}, specials: { weekly: WEEKLY } }, NOW);
  check('one series mapped', p.series.length === 1);
  const s = p.series[0];
  check('slots are sorted, whatever order they arrived in', s.slots.map((x) => x.startsAt).join() === ['2026-09-17T12:00:00.000Z', '2026-09-17T14:00:00.000Z'].join(), s.slots.map((x) => x.startsAt.slice(11, 16)).join());
  check('the 08:00 slot is past and gone', !s.slots.some((x) => x.startsAt.startsWith('2026-09-17T08')));
  check('registration counts survive as numbers', s.next.registrations === 7, String(s.next.registrations));
  check('our own entry is flagged on the series', s.registered === true);
  check('and on the slot it belongs to', s.slots.find((x) => x.startsAt.startsWith('2026-09-17T14')).isRegistered === true);
  check('entryRequirement IS used here', `${s.rank}${s.rankTier}` === 'Silver2', `${s.rank}${s.rankTier}`);
  check('race length from the race session', s.raceMin === 90);
  check('classes across the field', s.classes.join('/') === 'Hypercar/LMP2', s.classes.join('/'));
}

console.log('\nDegrading');
{
  const noDetail = dailies.buildPayload({ schedule: SCHEDULE, lists: {}, specials: {} }, NOW);
  const beginner = noDetail.tiers.find((t) => t.key === 'beginner');
  check('without details the events still appear', beginner.events.length === 3);
  check('…with their names', beginner.events.map((e) => e.title).includes('LMGT3 Fixed'));
  check('…and their times', beginner.upcoming.length === 4, String(beginner.upcoming.length));
  check('…and classes from the schedule car list', beginner.events[0].classes.join() === 'LMP3');
  check('a missing setting is null, never 0', beginner.events[0].tyreSets === null);
  check('a missing registration lead leaves no fake time', beginner.next.registrationOpens === null);

  const nothing = dailies.buildPayload({}, NOW);
  check('an empty input is a payload, not a throw', Array.isArray(nothing.tiers) && nothing.tiers.length === 3);
  check('…with no occurrences', nothing.tiers.every((t) => t.next === null));

  const empty = dailies.emptyPayload('offline', 'Start the game.', NOW);
  check('a failure has the same shape', empty.ok === false && Array.isArray(empty.tiers) && Array.isArray(empty.series));
  check('…and carries a reason the tab can act on', empty.reason === 'offline');
}

console.log('\nThe client, without a network');
{
  const calls = [];
  const fakeCall = async (method, path) => {
    calls.push(path);
    if (path === '/authenticate') return { accessToken: 'tok' };
    if (path === 'api/v1/daily/schedule') return SCHEDULE;
    if (path.startsWith('api/v1/daily/list/beginner')) return BEGINNER_LIST;
    if (path === 'api/v1/special-events/weekly') return WEEKLY;
    throw new Error(`${path} HTTP 500`);
  };

  (async () => {
    dailies.resetCache();
    const p = await dailies.getDailies({
      now: NOW,
      ticketImpl: async () => 'ticket',
      callImpl: fakeCall,
    });
    check('a partial service still produces a tab', p.ok === true);
    check('…and says so rather than hiding the gap', /unavailable/i.test(p.error || ''), p.error);
    check('the beginner tier is complete', p.tiers[0].events.every((e) => e.raceMin === 20));
    check('the failed tiers are empty, not broken', p.tiers[1].events.length === 0);
    check('only three list calls are made — a tier rotates', calls.filter((c) => c.includes('daily/list')).length === 3);
    check('…each taking 3, not the whole day', calls.filter((c) => c.includes('take=3')).length === 3);

    calls.length = 0;
    await dailies.getDailies({ now: NOW + 1000, ticketImpl: async () => 'ticket', callImpl: fakeCall });
    check('a second ask inside the cache window costs nothing', calls.length === 0);

    calls.length = 0;
    await dailies.getDailies({ now: NOW + 2000, force: true, ticketImpl: async () => 'ticket', callImpl: fakeCall });
    check('force bypasses the cache', calls.length > 0);
    check('…and reuses the token rather than re-authenticating', !calls.includes('/authenticate'));

    dailies.resetCache();
    const offline = await dailies.getDailies({
      now: NOW,
      ticketImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
      callImpl: fakeCall,
    });
    check('no game means offline, not an error', offline.ok === false && offline.reason === 'offline');
    check('…with a message that tells the driver what to do', /Le Mans Ultimate/.test(offline.error || ''));

    dailies.resetCache();
    const refused = await dailies.getDailies({
      now: NOW,
      ticketImpl: async () => 'ticket',
      callImpl: async (m, p2) => {
        if (p2 === '/authenticate') throw new Error('401');
        return {};
      },
    });
    check('a refused ticket is reported as auth', refused.reason === 'auth', refused.reason);

    dailies.resetCache();
    const dead = await dailies.getDailies({
      now: NOW,
      ticketImpl: async () => 'ticket',
      callImpl: async (m, p2) => {
        if (p2 === '/authenticate') return { accessToken: 'tok' };
        throw new Error('timeout');
      },
    });
    check('no schedule at all is a network failure', dead.reason === 'network', dead.reason);
    check('…and still returns the empty shape', dead.tiers.length === 0 && dead.series.length === 0);

    dailies.resetCache();
    console.log(`\n${failed ? 'FAILED' : 'OK'} — ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  })();
}
