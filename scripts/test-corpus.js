/**
 * scripts/test-corpus.js — the strategy corpus: what leaves the PC, and once.
 * -----------------------------------------------------------------------------
 * Two halves. The pure half (`strategyCorpus.ts`): which local stops and laps
 * are worth offering, what each becomes on the wire, and how the cache keeps a
 * sent row from being offered again. The wired half: a headless `lapUpload`
 * sync against a fake `auth.rpc`, asserting the corpus rides the existing run
 * — accepted rows land in the cache, refusals are remembered, and an outage
 * caches nothing so the rows are re-offered next time.
 *
 * The silent bugs this is for: a lap without a fuel reading offered forever
 * (refused every five minutes for the life of the install); a stop re-sent on
 * every run because the cache key drifted; UNKNOWN_VALUE stationary time sent
 * as -1 and stored as a negative stop; a run that read the machine's REAL laps
 * because the test forgot to point it at a temp folder.
 *
 * Run: node scripts/test-corpus.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildCorpusPlan,
  hasConsumption,
  diffCorpus,
  markCorpusSent,
  stopKey,
  lapKey,
  stopPayload,
  lapPayload,
  trackLengthFromKey,
} = require('../dist/telemetry/strategyCorpus');
const { appendLap, emptySyncCache, markRejected } = require('../dist/telemetry/lapLog');
const { appendStop } = require('../dist/telemetry/stopLog');
const { UNKNOWN_VALUE } = require('../dist/telemetry/types');
const lapUpload = require('../electron/lapUpload');

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

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `apex-corpus-${tag}-`));
}

const HOUR = 3_600_000;
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** A v5 lap with a consumption block, overridable per case. */
function lap(over = {}) {
  const rec = {
    v: 5,
    id: over.id !== undefined ? over.id : uuid(),
    at: new Date(over.atMs !== undefined ? over.atMs : Date.now()).toISOString(),
    sim: 'lmu',
    track: 'Daytona International Speedway Road Course',
    trackKey: 'daytona-international-speedway-road-course_5734',
    trackLengthM: 5734,
    car: 'Oreca 07',
    carClass: 'LMP2',
    lapMs: 100_310,
    distanceM: 5734,
    sessionType: 'race',
    clean: over.clean !== false,
    dirty: over.clean === false ? ['limits'] : [],
    fuelStartL: 60.2,
    fuelEndL: 57.3,
    fuelUsedL: 2.9,
    capacityL: 75,
    wearAtLine: [0.91, 0.9, 0.93, 0.92],
    compound: 'Medium',
    stintLap: 7,
    ...over,
  };
  // `undefined` overrides mean "leave the field out entirely".
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  return rec;
}

/** A completed stop record, as stopLog writes it. */
function stop(over = {}) {
  const rec = {
    v: 1,
    id: over.id !== undefined ? over.id : uuid(),
    at: new Date(over.atMs !== undefined ? over.atMs : Date.now()).toISOString(),
    sim: 'lmu',
    track: 'Daytona International Speedway Road Course',
    trackKey: 'daytona-international-speedway-road-course_5734',
    car: 'Oreca 07',
    carClass: 'LMP2',
    sessionType: 'race',
    lap: 24,
    stopNo: 1,
    laneSec: 72.73,
    stationarySec: 38.79,
    bookedSec: 2.1,
    fuelAddedL: 59.1,
    fuelBeforeL: 4.2,
    fuelAfterL: 63.3,
    tyresChanged: false,
    wearBefore: [0.6, 0.61, 0.65, 0.64],
    wearAfter: [0.6, 0.61, 0.65, 0.64],
    ...over,
  };
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  return rec;
}

/* -------------------------------------------------------------------------- */
console.log('\nwhat is offered\n');
/* -------------------------------------------------------------------------- */

{
  check('a v5 lap with fuel has consumption', hasConsumption(lap()));
  check('…or with wear only', hasConsumption(lap({ fuelStartL: undefined, fuelEndL: undefined, fuelUsedL: undefined })));
  check(
    'a v5 lap with neither is NOT offered',
    !hasConsumption(lap({ fuelStartL: undefined, fuelEndL: undefined, fuelUsedL: undefined, wearAtLine: undefined })),
  );
  check('a lap without an id is not offered', !hasConsumption(lap({ id: undefined })));
  check('a pre-v5 lap is not offered', !hasConsumption({ v: 3, id: uuid(), lapMs: 1, trackKey: 'x_1' }));
}

{
  const laps = tmpdir('laps');
  const stops = tmpdir('stops');
  const now = Date.now();

  appendLap(lap({ atMs: now - 30 * HOUR, fuelUsedL: 2.7 }), laps); // yesterday (UTC file)
  appendLap(lap({ atMs: now - 2 * HOUR }), laps);
  appendLap(lap({ atMs: now - 1 * HOUR }), laps); // newest
  appendLap(lap({ atMs: now - 1.5 * HOUR, fuelStartL: undefined, fuelEndL: undefined, fuelUsedL: undefined, wearAtLine: undefined }), laps);
  appendLap({ v: 1, at: new Date(now).toISOString(), sim: 'lmu', track: 'Spa', trackKey: 'spa_7004', trackLengthM: 7004, car: '', carClass: 'GT3', lapMs: 139_000, distanceM: 7004, sessionType: 'practice', clean: true, dirty: [] }, laps);

  appendStop(stop({ atMs: now - 3 * HOUR }), stops);
  appendStop(stop({ atMs: now - 1 * HOUR }), stops);
  appendStop(stop({ atMs: now - 2 * HOUR, id: '' }), stops); // no id — cannot be keyed

  const plan = buildCorpusPlan(laps, stops);
  check('three laps carry consumption', plan.laps.length === 3, plan.laps.length);
  check(
    'laps come newest first',
    plan.laps.every((l, i) => i === 0 || plan.laps[i - 1].at >= l.at),
    plan.laps.map((l) => l.at.slice(11, 16)).join(' > '),
  );
  check('two stops have ids', plan.stops.length === 2, plan.stops.length);
  check('stops come newest first', plan.stops[0].at > plan.stops[1].at);

  // The cache: nothing sent → everything pending; mark one of each → the rest.
  const cache = emptySyncCache();
  let pending = diffCorpus(plan, cache);
  check('an empty cache leaves everything pending', pending.laps.length === 3 && pending.stops.length === 2);
  markCorpusSent(cache, lapKey(plan.laps[0]));
  markCorpusSent(cache, stopKey(plan.stops[0]));
  pending = diffCorpus(plan, cache);
  check('a sent lap is not offered again', pending.laps.length === 2, pending.laps.length);
  check('a sent stop is not offered again', pending.stops.length === 1, pending.stops.length);
  markRejected(cache, lapKey(plan.laps[1]), 'implausible_time');
  pending = diffCorpus(plan, cache);
  check('a refused lap is never offered again', pending.laps.length === 1, pending.laps.length);
  check(
    'a cache from before the corpus shipped reads as nothing sent',
    diffCorpus(plan, { activity: {}, bests: {}, traces: {}, rejected: {} }).laps.length === 3,
  );

  fs.rmSync(laps, { recursive: true, force: true });
  fs.rmSync(stops, { recursive: true, force: true });
}

/* -------------------------------------------------------------------------- */
console.log('\nthe wire shape\n');
/* -------------------------------------------------------------------------- */

{
  check('track length is read back out of the key', trackLengthFromKey('daytona-international-speedway-road-course_5734') === 5734);
  check('…and is 0 when the key has none', trackLengthFromKey('unknown_0') === 0 && trackLengthFromKey('') === 0);

  const s = stop({ stationarySec: UNKNOWN_VALUE, bookedSec: undefined, compoundFitted: undefined });
  const p = stopPayload(s, '0.98.0');
  check('stop payload carries the record id', p.p_id === s.id);
  check('UNKNOWN_VALUE stationary time goes up as null', p.p_stationary_sec === null, p.p_stationary_sec);
  check('a missing booked time goes up as null, not undefined', p.p_booked_sec === null);
  check('a missing compound goes up as null', p.p_compound_fitted === null);
  check('lane time and fuel are carried', p.p_lane_sec === 72.73 && p.p_fuel_added_l === 59.1);
  check('wear arrays are carried whole', Array.isArray(p.p_wear_before) && p.p_wear_before.length === 4);
  check('the track length is derived from the key', p.p_track_length_m === 5734, p.p_track_length_m);
  check('the app version is stamped', p.p_app_version === '0.98.0');

  const measured = stopPayload(stop(), '');
  check('a measured stationary time is carried as-is', measured.p_stationary_sec === 38.79);

  const l = lap({ wet: true, trackTempC: 31.5 });
  const q = lapPayload(l, '0.98.0');
  check('lap payload carries the lap id', q.p_id === l.id);
  check('…the burn and the levels', q.p_fuel_used_l === 2.9 && q.p_fuel_start_l === 60.2 && q.p_fuel_end_l === 57.3);
  check('…the stint position and wear', q.p_stint_lap === 7 && q.p_wear_at_line.length === 4);
  check('…clean and the dirty reasons', q.p_clean === true && Array.isArray(q.p_dirty) && q.p_dirty.length === 0);
  check('…conditions', q.p_wet === true && q.p_track_temp_c === 31.5);
  check('…and the VE fields as null when the class has none', q.p_ve_start_pct === null && q.p_ve_end_pct === null);
  const dry = lapPayload(lap(), '');
  check('an unknown wet flag goes up as null, not false', dry.p_wet === null);
  const inLap = lapPayload(lap({ fuelUsedL: undefined, isInLap: true, dirty: ['pit'], clean: false }), '');
  check('an in-lap keeps its levels but has no burn', inLap.p_fuel_used_l === null && inLap.p_fuel_start_l === 60.2 && inLap.p_is_in_lap === true);
}

/* -------------------------------------------------------------------------- */
console.log('\nriding the sync\n');
/* -------------------------------------------------------------------------- */

/** A fake auth whose rpc() records every call and answers as told. */
function fakeAuth(answer) {
  const calls = [];
  return {
    calls,
    rpc: async (name, params) => {
      calls.push({ name, params });
      return answer(name, params);
    },
  };
}

const accept = () => ({ ok: true, body: { accepted: true } });

async function run() {
  const laps = tmpdir('laps');
  const stops = tmpdir('stops');
  const userData = tmpdir('userdata');
  const now = Date.now();
  for (let i = 0; i < 3; i++) appendLap(lap({ atMs: now - i * HOUR }), laps);
  appendStop(stop({ atMs: now - HOUR }), stops);
  appendStop(stop({ atMs: now - 2 * HOUR, id: 'not-a-uuid', laneSec: 1 }), stops); // the server will refuse this one

  {
    const auth = fakeAuth((name, params) => {
      if (name === 'submit_pit_stop' && params.p_id === 'not-a-uuid') {
        return { ok: true, body: { accepted: false, reason: 'bad_id' } };
      }
      return accept();
    });
    lapUpload.init({ userDataDir: userData, auth, appVersion: '0.98.0', dirs: { laps, stops }, noTimer: true });
    const state = await lapUpload.sync({ reason: 'test' });

    const stopCalls = auth.calls.filter((c) => c.name === 'submit_pit_stop');
    const lapCalls = auth.calls.filter((c) => c.name === 'submit_lap_consumption');
    check('the run finished ok', state.status === 'ok', state.status);
    check('both stops were offered', stopCalls.length === 2, stopCalls.length);
    check('all three consumption laps were offered', lapCalls.length === 3, lapCalls.length);
    check('the lap plan still went too (a best and activity)', auth.calls.some((c) => c.name === 'submit_lap'));
    check('the payloads name the RPC parameters', lapCalls.every((c) => typeof c.params.p_id === 'string' && 'p_fuel_used_l' in c.params));

    const cache = JSON.parse(fs.readFileSync(path.join(userData, 'lap-sync.json'), 'utf8'));
    const sentKeys = Object.keys(cache.corpus || {});
    check('accepted rows are in the cache', sentKeys.length === 4, sentKeys.join(','));
    check('the refused stop is remembered as rejected', cache.rejected['stop:not-a-uuid'] === 'bad_id', JSON.stringify(cache.rejected));
  }

  {
    // Second run: nothing new on disk → not a single corpus request.
    const auth = fakeAuth(accept);
    lapUpload.init({ userDataDir: userData, auth, appVersion: '0.98.0', dirs: { laps, stops }, noTimer: true });
    await lapUpload.sync({ reason: 'test' });
    const corpusCalls = auth.calls.filter((c) => c.name === 'submit_pit_stop' || c.name === 'submit_lap_consumption');
    check('a second run re-offers nothing', corpusCalls.length === 0, corpusCalls.map((c) => c.name).join(','));

    // A new lap lands → exactly one more request.
    appendLap(lap({ atMs: now + HOUR }), laps);
    await lapUpload.sync({ reason: 'test' });
    const again = auth.calls.filter((c) => c.name === 'submit_lap_consumption');
    check('a new lap is offered once', again.length === 1, again.length);
  }

  {
    // An outage: nothing cached, and the run reports offline rather than ok.
    const laps2 = tmpdir('laps2');
    const stops2 = tmpdir('stops2');
    const userData2 = tmpdir('userdata2');
    appendStop(stop({ atMs: now }), stops2);
    const auth = fakeAuth(() => ({ ok: false, error: 'fetch failed' }));
    lapUpload.init({ userDataDir: userData2, auth, appVersion: '0.98.0', dirs: { laps: laps2, stops: stops2 }, noTimer: true });
    const state = await lapUpload.sync({ reason: 'test' });
    check('an outage reports offline', state.status === 'offline', state.status);
    check('…with the stop still pending', state.pending === 1, state.pending);
    check('…and nothing written to the cache', !fs.existsSync(path.join(userData2, 'lap-sync.json')));

    // Back online: the same stop is offered again.
    const auth2 = fakeAuth(accept);
    lapUpload.init({ userDataDir: userData2, auth: auth2, appVersion: '0.98.0', dirs: { laps: laps2, stops: stops2 }, noTimer: true });
    await lapUpload.sync({ reason: 'test' });
    check('…and re-offered once the league is back', auth2.calls.filter((c) => c.name === 'submit_pit_stop').length === 1);

    fs.rmSync(laps2, { recursive: true, force: true });
    fs.rmSync(stops2, { recursive: true, force: true });
    fs.rmSync(userData2, { recursive: true, force: true });
  }

  {
    // The per-run cap: a backlog drains over several runs, never in one burst.
    const laps3 = tmpdir('laps3');
    const stops3 = tmpdir('stops3');
    const userData3 = tmpdir('userdata3');
    const n = lapUpload.MAX_CORPUS_PER_RUN + 7;
    // Dirty laps: no board best, so no trace pends and the count below is
    // exactly the corpus remainder.
    for (let i = 0; i < n; i++) appendLap(lap({ atMs: now - i * 60_000, clean: false }), laps3);
    const auth = fakeAuth(accept);
    lapUpload.init({ userDataDir: userData3, auth, appVersion: '0.98.0', dirs: { laps: laps3, stops: stops3 }, noTimer: true });
    const first = await lapUpload.sync({ reason: 'test' });
    const firstLaps = auth.calls.filter((c) => c.name === 'submit_lap_consumption').length;
    check('a backlog is capped per run', firstLaps === lapUpload.MAX_CORPUS_PER_RUN, firstLaps);
    check('…and the remainder is reported pending', first.pending === 7, first.pending);
    await lapUpload.sync({ reason: 'test' });
    const total = auth.calls.filter((c) => c.name === 'submit_lap_consumption').length;
    check('…then drains on the next run', total === n, total);

    fs.rmSync(laps3, { recursive: true, force: true });
    fs.rmSync(stops3, { recursive: true, force: true });
    fs.rmSync(userData3, { recursive: true, force: true });
  }

  lapUpload.stop();
  fs.rmSync(laps, { recursive: true, force: true });
  fs.rmSync(stops, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}

run().then(() => {
  console.log(`\ntest-corpus: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
