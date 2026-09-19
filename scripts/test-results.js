/**
 * scripts/test-results.js — official race results, from RaceOS to the cloud.
 * -----------------------------------------------------------------------------
 * Two halves, and the first one is a security test wearing a data-mapping coat.
 *
 * 1. THE PROJECTION IS A WHITELIST. `api/v1/results` is 2.3 MB for ten events
 *    because it embeds everything: every team's members, every livery URL, every
 *    per-driver rating adjustment with its reason text — and the neighbouring
 *    `api/v1/player` hands back the account's email address and a live
 *    verification code. What survives projectResults() is the only thing that
 *    reaches our database, and from there a PUBLIC Discord message. So this
 *    asserts the exact key set of a projected row, not merely that the fields we
 *    want are present: a payload that grows a field must not carry it through.
 *
 * 2. THE HARVESTER MUST BE CHEAP WHEN THERE IS NOTHING TO FIND, which is nearly
 *    always. One event is ~230 KB, so the poll asks for one, and if it is
 *    already in the ledger it must stop there — not fetch three more to
 *    rediscover that. That single short-circuit is the difference between a few
 *    hundred KB an hour and a few megabytes.
 *
 * The field PATHS themselves cannot be tested here, because no live payload has
 * ever been saved — the fixture below is built from the shape
 * scripts/probe-raceos-results.js printed, which is why ROW_PATHS holds a list
 * of candidates per field rather than one name. Run that probe with LMU up
 * before trusting the mapping.
 *
 * Run: node scripts/test-results.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { projectResults, toMs } = require('../dist/telemetry/raceosResults.js');
const harvest = require('../electron/results-harvest');

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

/**
 * One event in the shape the probe described, with the noise that makes the
 * real payload 230 KB an event: rating adjustments with reasons, team rosters,
 * livery URLs — and, standing in for the worst case, an email address. None of
 * it may come out the other side.
 */
function fixture() {
  const driver = (pos, name, best, extra = {}) => ({
    position: pos,
    classPosition: pos,
    gridPos: pos + 1,
    driverName: name,
    carName: 'Lexus RCF LMGT3',
    carClass: 'LMGT3',
    Laps: 18,
    bestLapTime: best,
    finishTime: '43:09.574',
    finishStatus: 'Finished',
    // Everything below is real payload weight and must not survive.
    email: 'someone@example.com',
    steamId: '76561198000000000',
    liveryUrl: 'https://cdn.example/livery.png',
    ratingChange: { dr: 12.4, sr: -0.2, reason: 'Qualifying you finished 10th of 23' },
    aids: { abs: true, tc: 2 },
    teamMembers: [{ name, email: 'someone@example.com' }],
    ...extra,
  });

  return {
    results: [
      {
        id: 'evt-9001',
        eventType: 'daily',
        eventName: 'LMGT3 Fixed',
        trackName: 'Silverstone Grand Prix Circuit - WEC',
        startTime: '2026-09-06T18:58:00Z',
        race: {
          results: [
            driver(3, 'Third Driver', '2:01.500'),
            driver(1, 'First Driver', '2:00.412'),
            driver(2, 'Second Driver', '2:00.830'),
            driver(11, 'Josh Christie', '2:00.829'),
            // Not a classification row: no position, no name.
            { summary: true, totalEntries: 23 },
          ],
        },
      },
      {
        // No id — cannot be deduped, so it must be dropped rather than invented.
        eventType: 'daily',
        eventName: 'Nameless',
        race: { results: [driver(1, 'Someone', '1:30.000')] },
      },
    ],
  };
}

/** A fake auth module that records every RPC. */
function fakeAuth(answer) {
  const calls = [];
  return {
    calls,
    stateForUi: () => ({ signedIn: true }),
    async rpc(fn, args) {
      calls.push({ fn, args });
      return answer ? answer(args) : { ok: true, body: { ok: true, stored: true } };
    },
  };
}

/** A fake RaceOS client: records each take, answers from a queue. */
function fakeClient(queues) {
  const takes = [];
  return {
    takes,
    Ctor: class {
      // eslint-disable-next-line no-unused-vars
      constructor(_opts) {}
      async fetchRecent(_names, take) {
        takes.push(take);
        return queues.shift() ?? [];
      }
    },
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-results-'));
}

async function main() {
  console.log('\nOfficial race results\n');

  /* ------------------------------------------------------ 1. the projection */
  console.log('Projection');
  {
    const events = projectResults(fixture(), ['Josh Christie']);

    check('the event with no id is dropped', events.length === 1, `${events.length} event(s)`);
    const e = events[0];
    check('event key is prefixed by source', e.eventKey === 'raceos:evt-9001', e.eventKey);
    check('name and track survive', e.name === 'LMGT3 Fixed' && !!e.track);
    check('start time is ISO', e.startedAt === '2026-09-06T18:58:00.000Z', e.startedAt);
    check('the summary row is not a driver', e.classification.length === 4, e.classification.length);
    check(
      'the field is sorted by position',
      e.classification.map((r) => r.pos).join(',') === '1,2,3,11',
      e.classification.map((r) => r.pos).join(','),
    );
    check('our own row is identified', e.mine === 'Josh Christie', String(e.mine));

    // THE test. Not "are the fields we want there" but "is anything else".
    const WANTED = [
      'pos', 'classPos', 'gridPos', 'name', 'car', 'carClass',
      'laps', 'bestLapMs', 'totalMs', 'status',
    ].sort();
    const got = Object.keys(e.classification[0]).sort();
    check('a projected row has EXACTLY the whitelisted keys', got.join(',') === WANTED.join(','), got.join(','));

    const asText = JSON.stringify(events);
    for (const leak of ['email', 'example.com', 'steamId', 'ratingChange', 'liveryUrl', 'teamMembers', 'aids']) {
      check(`nothing called ${leak} survives`, !asText.includes(leak));
    }

    check('lap times are milliseconds', e.classification[0].bestLapMs === 120412, e.classification[0].bestLapMs);
    check('race time is milliseconds', e.classification[0].totalMs === 2589574, e.classification[0].totalMs);

    // An event we were not in still projects; it is the HARVESTER that
    // declines to upload it (below), so the projection stays a pure function.
    const anon = projectResults(fixture(), []);
    check('an unidentifiable driver still yields the event', anon.length === 1 && anon[0].mine === null);

    // RaceOS shows some accounts as "Name#1234" where the game's standings row
    // says "Name" — and the other way round. Neither spelling may lose the
    // driver their own result.
    const tagged = projectResults(fixture(), ['josh christie#4321']);
    check('a #discriminator on our side still matches', tagged[0].mine === 'Josh Christie', String(tagged[0].mine));
    check('so does case and spacing', projectResults(fixture(), ['  JOSH   Christie '])[0].mine === 'Josh Christie');

    /* ---- The live shape, which the fixture above is NOT ------------------
     *
     * The fixture puts the rows at `race.results` and calls the car `carName`.
     * The real service does neither: a session holds an ARRAY OF HEATS, so the
     * rows are at `race.races[0].results`, and the car is `carType`. Both were
     * wrong when this shipped, and both failed silently — `raceRowsOf` found no
     * rows, `projectResults` skipped the event, and the harvest reported
     * "0 events" forever rather than erroring. Taken from ten real events on
     * 2026-09-17 (scripts/probe-raceos-results.js --out). */
    const live = {
      results: [
        {
          eventId: 'evt-live-1',
          eventType: 'specialevent',
          title: 'Lone Star Le Mans',
          track: 'COTAWEC_NATIONAL',
          date: '2026-09-13T08:00:00Z',
          race: {
            sessionNo: '1',
            races: [
              {
                mostLapsCompleted: 185,
                results: [
                  {
                    name: 'Erki Kasevali',
                    position: '1',
                    classPosition: '1',
                    gridPos: '1',
                    carType: 'BMW M Hybrid V8',
                    vehName: 'BMWMH Custom Team 2026 #397',
                    carClass: 'Hyper',
                    Laps: 185,
                    laps: null, // the lower-case one is null — order matters
                    bestLapTime: '112.9902',
                    finishTime: '21655.0175',
                    finishStatus: 'Finished Normally',
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    const liveOut = projectResults(live, ['Erki Kasevali']);
    check('a real event is projected at all', liveOut.length === 1, String(liveOut.length));
    if (liveOut.length) {
      const r = liveOut[0].classification[0];
      check('rows are found one level down, in races[]', liveOut[0].classification.length === 1);
      check('position survives', r.pos === 1, String(r.pos));
      check('the car is the MODEL, not empty', r.car === 'BMW M Hybrid V8', JSON.stringify(r.car));
      check('Laps wins over the null lower-case laps', r.laps === 185, String(r.laps));
      check('a bare-seconds best lap becomes ms', r.bestLapMs === 112990, String(r.bestLapMs));
      check('and so does the finish time', r.totalMs === 21655, String(r.totalMs));
      check('the event id is the dedupe key', liveOut[0].eventKey === 'raceos:evt-live-1', liveOut[0].eventKey);
      check('our own driver is tagged', liveOut[0].mine === 'Erki Kasevali', String(liveOut[0].mine));
    }

    check('garbage in, empty out', projectResults(null).length === 0);
    check('an empty payload is not an error', projectResults({ results: [] }).length === 0);
  }

  console.log('\nTime parsing');
  {
    const cases = [
      ['2:00.830', 120830],
      ['1:59.9', 119900],
      ['59.123', 59123],
      [120830, 120830],
      [120.83, 120830],
      ['', null],
      [null, null],
      [0, null],
      [-5, null],
    ];
    for (const [input, want] of cases) {
      const got = toMs(input);
      check(`${JSON.stringify(input)} → ${want}`, got === want, got);
    }
  }

  /* -------------------------------------------------------- 2. the harvest */
  console.log('\nThe harvest is cheap when there is nothing to find');
  {
    const known = [{ eventKey: 'raceos:evt-1', eventType: 'daily', name: 'A', track: 'T', startedAt: null, classification: [{ pos: 1, name: 'x' }], mine: 'x' }];
    const client = fakeClient([known, known]);
    const auth = fakeAuth();
    harvest.init({ auth, userDataDir: tmpDir(), loadClient: () => client.Ctor });

    // Until the driver has a name, even a forced pass must not ask: the feed
    // is global, and a pass that cannot tell which row is ours would upload
    // whoever finished last on the platform.
    const nameless = await harvest.harvest({ force: true });
    check('no name, no request', nameless.skipped === true && nameless.reason === 'no-name', JSON.stringify(nameless));
    check('not even the probe', client.takes.length === 0);
    harvest.noteFrame({ standings: [{ driverName: 'x', isOwn: true, isPlayer: true }] });

    // First pass: nothing known yet, so the probe finds something new and the
    // catch-up fetch follows.
    const first = await harvest.harvest({ force: true });
    check('the first pass uploads', first.events === 1, JSON.stringify(first));
    check('it probed with take=1 then fetched wider', client.takes.join(',') === '1,3', client.takes.join(','));
    check('the upload went to submit_event_results', auth.calls.every((c) => c.fn === 'submit_event_results'));

    const sent = auth.calls[0].args;
    check('the event key travels', sent.p_event_key === 'raceos:evt-1');
    check('our own name travels', sent.p_me === 'x');
    check(
      'nothing but the named columns is sent',
      Object.keys(sent).sort().join(',') ===
        'p_classification,p_event_key,p_event_type,p_me,p_name,p_started_at,p_track',
      Object.keys(sent).sort().join(','),
    );

    // Second pass: the probe sees the same event and must stop dead.
    client.takes.length = 0;
    auth.calls.length = 0;
    const second = await harvest.harvest({ force: true });
    check('a second pass uploads nothing', second.events === 0);
    check('and cost exactly one request', client.takes.join(',') === '1', client.takes.join(','));
    check('with no RPC at all', auth.calls.length === 0);
    harvest.stop();
  }

  console.log('\nThe ledger, and refusals');
  {
    const dir = tmpDir();
    const one = [{ eventKey: 'raceos:evt-2', eventType: '', name: '', track: '', startedAt: null, classification: [{ pos: 1, name: 'x' }], mine: 'x' }];
    const named = () => harvest.noteFrame({ standings: [{ driverName: 'x', isOwn: true, isPlayer: true }] });

    // A refusal is about this event's shape and will never improve. It must be
    // remembered, or every pass pays for it again forever.
    const refusing = fakeClient([one, one]);
    const auth = fakeAuth(() => ({ ok: true, body: { ok: false, reason: 'implausible_field' } }));
    harvest.init({ auth, userDataDir: dir, loadClient: () => refusing.Ctor });
    named();
    await harvest.harvest({ force: true });
    check('a refused event is remembered', harvest._state().seen.includes('raceos:evt-2'));
    harvest.stop();

    // A transport failure is the opposite: it must NOT be remembered, or the
    // event is lost for good.
    const dir2 = tmpDir();
    const failing = fakeClient([one, one]);
    const offline = fakeAuth(() => ({ ok: false, error: 'offline' }));
    harvest.init({ auth: offline, userDataDir: dir2, loadClient: () => failing.Ctor });
    named();
    await harvest.harvest({ force: true });
    check('an upload failure is not remembered', !harvest._state().seen.includes('raceos:evt-2'));
    harvest.stop();

    // A race we were NOT in is the common case on a global feed. It is
    // remembered — so the next pass does not pay to rediscover it — and it
    // never reaches the server.
    const dir3 = tmpDir();
    const stranger = [{ ...one[0], eventKey: 'raceos:evt-stranger', mine: null }];
    const strangers = fakeClient([stranger, stranger]);
    const quiet = fakeAuth();
    harvest.init({ auth: quiet, userDataDir: dir3, loadClient: () => strangers.Ctor });
    named();
    const skipped = await harvest.harvest({ force: true });
    check("a stranger's race is not uploaded", skipped.events === 0 && quiet.calls.length === 0, JSON.stringify(skipped));
    check('but is remembered', harvest._state().seen.includes('raceos:evt-stranger'));
    harvest.stop();

    // And the ledger survives a restart.
    const persisted = fakeClient([one, one]);
    const ok = fakeAuth();
    harvest.init({ auth: ok, userDataDir: dir, loadClient: () => persisted.Ctor });
    check('the ledger was reloaded from disk', harvest._state().seen.includes('raceos:evt-2'));
    harvest.stop();
  }

  console.log('\nKnowing which driver is us');
  {
    harvest.init({ auth: fakeAuth(), userDataDir: tmpDir(), loadClient: () => fakeClient([]).Ctor });
    harvest.noteFrame({
      standings: [
        { driverName: 'Someone Else', isOwn: false, isPlayer: false },
        { driverName: 'Josh Christie', isOwn: true, isPlayer: true },
      ],
    });
    check('the name comes from the row flagged as ours', harvest._state().names.includes('Josh Christie'));
    check('and not from the others', !harvest._state().names.includes('Someone Else'));

    // isPlayer is broadcast focus: after the flag it is whoever the camera is
    // on. On 2026-09-19 that put George Barr in a league's channel as "your
    // driver" because a member was watching him. Focus must never name us.
    harvest.noteFrame({
      standings: [
        { driverName: 'George Barr', isOwn: false, isPlayer: true },
        { driverName: 'Josh Christie', isOwn: true, isPlayer: false },
      ],
    });
    check('the car in broadcast focus is not us', !harvest._state().names.includes('George Barr'));
    harvest.noteFrame({ standings: [{ driverName: 'Spectated Only', isPlayer: true }] });
    check('a frame with no own car names nobody', !harvest._state().names.includes('Spectated Only'));

    harvest.noteFrame({ standings: [{ driverName: 'Renamed Driver', isOwn: true, isPlayer: true }] });
    const names = harvest._state().names;
    check('a rename keeps the old name too', names.includes('Josh Christie') && names.includes('Renamed Driver'), names.join(','));
    check('a frame marks there is something to look for', harvest._state().dirty === true);
    harvest.stop();
  }

  console.log('\nNothing happens without a reason to');
  {
    const client = fakeClient([[{ eventKey: 'raceos:evt-3', classification: [{ pos: 1, name: 'x' }], mine: '' }]]);
    const auth = fakeAuth();
    harvest.init({ auth, userDataDir: tmpDir(), loadClient: () => client.Ctor });
    // No noteFrame: the game has not been running, so an unforced pass must not
    // spend a request.
    const res = await harvest.harvest({});
    check('an unforced pass with no activity does nothing', res.skipped === true);
    check('and made no request', client.takes.length === 0);

    const out = await harvest.harvest({ force: false });
    check('still nothing on a second try', out.skipped === true && client.takes.length === 0);
    harvest.stop();
  }

  console.log('\nSigned out');
  {
    const client = fakeClient([[{ eventKey: 'raceos:evt-4', classification: [{ pos: 1, name: 'x' }] }]]);
    const auth = fakeAuth();
    auth.stateForUi = () => ({ signedIn: false });
    harvest.init({ auth, userDataDir: tmpDir(), loadClient: () => client.Ctor });
    const res = await harvest.harvest({ force: true });
    check('a signed-out app harvests nothing', res.skipped === true);
    check('and never asks the service', client.takes.length === 0);
    harvest.stop();
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('\n  the test harness itself threw:', err);
    process.exit(1);
  });
