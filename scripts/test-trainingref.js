/**
 * scripts/test-trainingref.js — the Training reference in the main process:
 * which board lap to chase, and how its trace is fetched and kept.
 * -----------------------------------------------------------------------------
 * Covers electron/trainingReference.js and electron/trainingRefCache.js with
 * no Electron and no network — the RPC, the sign-in and the server are fakes.
 *
 *   1. pure selection: auto / own / pinned, the fallbacks, settings shape
 *   2. the combo from a feed frame, keyed like the provider keys its ghost
 *   3. the controller: wanted / signed-in gates, delivery, choice changes,
 *      a new board time (lap_ms) re-fetching, retries that heal
 *   4. the cache: LRU bound, superseded times dropped, torn files forgotten,
 *      the backoff doubling to a cap and never becoming permanent
 *   5. no synchronous fs anywhere in the cache or the controller
 *
 * Run: npm run test:trainingref
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tr = require('../electron/trainingReference');
const { TraceCache, Backoff, cacheKey, BACKOFF_BASE_MS, BACKOFF_MAX_MS } = require('../electron/trainingRefCache');
const { trackKeyOf } = require('../dist/telemetry/paceDelta');
const { conditionOf } = require('../dist/telemetry/lapLog');
const { normalizeClass } = require('../dist/telemetry/carClass');
const { formatLapTime } = require('../dist/telemetry/raceLog');

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

/* ------------------------------ the sync guard ---------------------------- */

const SYNC_FNS = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'openSync', 'readSync', 'accessSync', 'fstatSync', 'writeFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'utimesSync'];
const real = {};
let syncHits = 0;
for (const name of SYNC_FNS) real[name] = fs[name];
async function guarded(fn) {
  for (const name of SYNC_FNS) {
    fs[name] = function guardedFs(...args) {
      syncHits++;
      throw new Error(`sync fs call in the training reference: ${name}(${String(args[0])})`);
    };
  }
  try {
    return await fn();
  } finally {
    for (const name of SYNC_FNS) fs[name] = real[name];
  }
}

/* ------------------------------ fixtures ---------------------------------- */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-trainingref-'));
let dirN = 0;
const newDir = () => path.join(ROOT, `c${dirN++}`);

const HELPERS = { trackKeyOf, conditionOf, normalizeClass, formatLapTime };
const TRACK = 'Autodromo Nazionale Monza';
const LEN = 5781;
const TRACK_ID = '11111111-1111-1111-1111-111111111111';
const ME = 'aaaaaaaa-0000-0000-0000-000000000001';
const SMITH = 'aaaaaaaa-0000-0000-0000-000000000002';
const JONES = 'aaaaaaaa-0000-0000-0000-000000000003';

function row(driverId, name, lapMs, over = {}) {
  return {
    track_id: TRACK_ID,
    rank: 0,
    driver_id: driverId,
    display_name: name,
    car: 'Some GT3 #7',
    lap_ms: lapMs,
    is_you: driverId === ME,
    has_trace: true,
    has_line: true,
    ...over,
  };
}

function frame(over = {}) {
  return {
    source: 'lmu',
    connected: true,
    session: { track: TRACK, trackLengthM: LEN },
    weather: { trackWetness: 0 },
    standings: [
      { driverName: 'Watched', carClass: 'HYPERCAR', isPlayer: true },
      { driverName: 'Me', carClass: 'GT3', isPlayer: false, isOwn: true },
    ],
    ...over,
  };
}

function traceBody(driverId, lapMs) {
  const d = [];
  const t = [];
  for (let i = 0; i <= 50; i++) {
    d.push(i / 50);
    t.push((i / 50) * (lapMs / 1000));
  }
  return { found: true, driverId, trackId: TRACK_ID, carClass: 'GT3', car: 'Some GT3 #7', lapMs, setAt: '2026-10-01T00:00:00Z', data: { lapSec: lapMs / 1000, d, t, x: d, z: d } };
}

/** A league that answers from a table, counting calls; `fail` makes it error. */
function fakeLeague() {
  const L = {
    rows: [row(SMITH, 'John Smith', 109_820), row(JONES, 'Ann Jones', 110_400), row(ME, 'Me Myself', 111_000)],
    calls: { board_for_lap: 0, get_lap_trace: 0 },
    fail: { board_for_lap: false, get_lap_trace: false },
    signedOut: false,
    lastBoardArgs: null,
    async rpc(fn, body) {
      L.calls[fn] = (L.calls[fn] || 0) + 1;
      await new Promise((r) => setImmediate(r));
      if (L.signedOut) return { ok: false, signedOut: true, error: 'Not signed in.' };
      if (L.fail[fn]) return { ok: false, status: 0, error: 'offline' };
      if (fn === 'board_for_lap') {
        L.lastBoardArgs = body;
        return { ok: true, body: L.rows.map((r) => ({ ...r })) };
      }
      if (fn === 'get_lap_trace') {
        const r = L.rows.find((x) => x.driver_id === body.p_driver_id);
        return { ok: true, body: r ? traceBody(r.driver_id, r.lap_ms) : { found: false } };
      }
      return { ok: false, error: 'unknown' };
    },
  };
  return L;
}

function rig(opts = {}) {
  const league = fakeLeague();
  let now = 1_000_000;
  const delivered = [];
  const saved = [];
  const statuses = [];
  let signedIn = opts.signedIn !== false;
  let serverUp = opts.serverUp !== false;
  const cache = new TraceCache({ dir: newDir(), now: () => now });
  const ctl = new tr.TrainingReference({
    rpc: league.rpc,
    isSignedIn: () => signedIn,
    cache,
    backoff: new Backoff(),
    deliver: (trace, meta) => {
      if (!serverUp) return false;
      delivered.push(trace ? { trace, meta } : null);
      return true;
    },
    loadChoices: () => opts.choices || {},
    saveChoices: (m) => saved.push(JSON.parse(JSON.stringify(m))),
    helpers: () => HELPERS,
    onChange: (s) => statuses.push(s),
    now: () => now,
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await ctl.settled();
      await cache.settled();
      await new Promise((r) => setImmediate(r));
    }
  };
  return {
    league,
    ctl,
    cache,
    delivered,
    saved,
    statuses,
    settle,
    last: () => delivered[delivered.length - 1],
    advance: (ms) => (now += ms),
    setSignedIn: (v) => (signedIn = v),
    setServerUp: (v) => (serverUp = v),
  };
}

/* ---------------------------------- tests --------------------------------- */

async function main() {
  console.log('\n1) Selection: auto / own / pinned');
  {
    const rows = [row(SMITH, 'John Smith', 109_820), row(JONES, 'Ann Jones', 109_500, { has_line: false }), row(ME, 'Me', 111_000)];
    const auto = tr.chooseReference('auto', rows);
    check('auto: the fastest board lap WITH a line', auto.kind === 'board' && auto.row.driver_id === SMITH);
    check('own: always own', tr.chooseReference('own', rows).kind === 'own');
    check('no lined rows: own, "no-board-line"', tr.chooseReference('auto', [row(SMITH, 'x', 1, { has_line: false })]).reason === 'no-board-line');
    check('empty board: own', tr.chooseReference('auto', []).kind === 'own');
    const lead = tr.chooseReference('auto', [row(ME, 'Me', 100_000), row(SMITH, 'S', 101_000)]);
    check('you hold the fastest lined lap: own, "you-lead"', lead.kind === 'own' && lead.reason === 'you-lead');
    const pin = tr.chooseReference({ driverId: ME, trackId: TRACK_ID }, rows);
    check('pinned: that driver, even yourself', pin.kind === 'board' && pin.row.driver_id === ME);
    const gone = tr.chooseReference({ driverId: JONES, trackId: TRACK_ID }, rows);
    check('pinned row with no line: own, never someone else', gone.kind === 'own' && gone.reason === 'pinned-unavailable');
    check('label', tr.refLabel(row(SMITH, 'John Smith', 107_831), formatLapTime) === 'J. Smith · 1:47.831 · board');
    check('single-name label', tr.shortName('Jammskie') === 'Jammskie' && tr.shortName('') === 'Driver');
    check('refId is per board time', tr.refIdOf(row(SMITH, 'x', 107_831)) === `board:${SMITH}:107831`);
    check('normalizeChoice keeps own / pins, defaults to auto', tr.normalizeChoice('own') === 'own' && tr.normalizeChoice('x') === 'auto' && tr.normalizeChoice({ driverId: SMITH, trackId: TRACK_ID }).driverId === SMITH);
    check('normalizeChoice refuses a hostile id', tr.normalizeChoice({ driverId: '../x', trackId: TRACK_ID }) === 'auto');
    const refs = tr.normalizeTrainingRefs({ 'a_1|GT3': 'own', 'b_2|GT3': 'auto', 'c_3|GT3': { driverId: SMITH, trackId: TRACK_ID }, bad: 'own', 'd|X': 7 });
    check('settings shape: auto is not stored, junk dropped', JSON.stringify(Object.keys(refs)) === JSON.stringify(['a_1|GT3', 'c_3|GT3']));
    check('settings shape from garbage is {}', JSON.stringify(tr.normalizeTrainingRefs([1, 2])) === '{}' && JSON.stringify(tr.normalizeTrainingRefs(null)) === '{}');
    check('traceMatchesRow: same time', tr.traceMatchesRow(traceBody(SMITH, 1000), row(SMITH, 'x', 1000)));
    check('traceMatchesRow: a new time landed between reads', !tr.traceMatchesRow(traceBody(SMITH, 999), row(SMITH, 'x', 1000)));
    check('traceMatchesRow: not found', !tr.traceMatchesRow({ found: false }, row(SMITH, 'x', 1000)));
  }

  console.log('\n2) The combo, from a feed frame');
  {
    const c = tr.comboFromFrame(frame(), HELPERS);
    check('keyed like the provider: trackKeyOf(name, length)', c && c.trackKey === trackKeyOf(TRACK, LEN));
    check('class off the DRIVEN car (isOwn), not the watched one', c && c.carClass === 'GT3');
    check('dry at 0 wetness', c && c.condition === 'dry');
    check('damp at 0.05', tr.comboFromFrame(frame({ weather: { trackWetness: 0.05 } }), HELPERS).condition === 'damp');
    check('demo feed: none', tr.comboFromFrame(frame({ connected: false }), HELPERS) === null);
    check('spectating (no own car): none', tr.comboFromFrame(frame({ standings: [{ carClass: 'GT3', isPlayer: true }] }), HELPERS) === null);
    check('no track length: none', tr.comboFromFrame(frame({ session: { track: TRACK } }), HELPERS) === null);
    check('choiceKey', tr.choiceKey(c) === `${trackKeyOf(TRACK, LEN)}|GT3`);
  }

  console.log('\n3) The controller');
  {
    const R = rig();
    const hits = syncHits;
    await guarded(async () => {
      for (let i = 0; i < 20; i++) R.ctl.noteFrame(frame());
      await R.settle();
    });
    check('not wanted: no league call at all', R.league.calls.board_for_lap === 0 && R.league.calls.get_lap_trace === 0);
    await guarded(async () => {
      R.ctl.setWanted(true);
      R.ctl.noteFrame(frame());
      await R.settle();
    });
    check('no sync fs on the resolve + fetch + cache path', syncHits === hits, syncHits - hits);
    check('the board is read with Review\'s query', R.league.lastBoardArgs && R.league.lastBoardArgs.p_condition === 'dry' && R.league.lastBoardArgs.p_limit === 200 && R.league.lastBoardArgs.p_car_class === 'GT3');
    const d = R.last();
    check('auto delivers the fastest lined lap', d && d.meta.refId === `board:${SMITH}:109820`);
    check('…stamped with the combo', d && d.meta.trackKey === trackKeyOf(TRACK, LEN) && d.meta.carClass === 'GT3' && d.meta.condition === 'dry');
    check('…labelled', d && d.meta.label === 'J. Smith · 1:49.820 · board');
    check('…the trace columns', d && Array.isArray(d.trace.d) && d.trace.d.length === 51);
    check('status: chasing', R.ctl.getStatus().state === 'board');
    const boardCalls = R.league.calls.board_for_lap;
    const traceCalls = R.league.calls.get_lap_trace;
    for (let i = 0; i < 100; i++) R.ctl.noteFrame(frame());
    await R.settle();
    check('steady state: a hundred ticks call nothing', R.league.calls.board_for_lap === boardCalls && R.league.calls.get_lap_trace === traceCalls);
    check('…and deliver nothing new', R.delivered.length === 1);

    // Pin Jones, then own, then auto.
    const opts = await R.ctl.options();
    check('options: rows with who/time/car/line', opts.rows.length === 3 && opts.rows[0].time === '1:49.820' && opts.rows[0].hasLine === true && opts.rows[0].car);
    check('options: the auto pick is marked selected', opts.selected === SMITH && opts.choice === 'auto');
    R.ctl.setChoice({ choice: { driverId: JONES, trackId: TRACK_ID } });
    await R.settle();
    check('pin persists per trackKey|CLASS', R.saved.length === 1 && R.saved[0][`${trackKeyOf(TRACK, LEN)}|GT3`].driverId === JONES);
    check('pin delivers that lap', R.last() && R.last().meta.refId === `board:${JONES}:110400`);
    R.ctl.setChoice({ choice: 'own' });
    await R.settle();
    check('own delivers null (the local best)', R.last() === null && R.ctl.getStatus().reason === 'chosen');
    const tracesBefore = R.league.calls.get_lap_trace;
    R.ctl.setChoice({ choice: 'auto' });
    await R.settle();
    check('back to auto: from the cache, no refetch', R.last() && R.last().meta.refId === `board:${SMITH}:109820` && R.league.calls.get_lap_trace === tracesBefore);
    check('auto is not stored', JSON.stringify(R.saved[R.saved.length - 1]) === '{}');

    // A new board time is noticed when the board goes stale, and refetched.
    R.league.rows[0] = row(SMITH, 'John Smith', 109_100);
    R.ctl.noteFrame(frame());
    await R.settle();
    check('before the board TTL: still the old time', R.last().meta.lapMs === 109_820);
    R.advance(tr.BOARD_TTL_MS + 1);
    R.ctl.noteFrame(frame());
    await R.settle();
    check('after the TTL: the new lap_ms is a new key and refetched', R.last().meta.refId === `board:${SMITH}:109100` && R.league.calls.get_lap_trace === tracesBefore + 1);

    // Damp: own. Signed out: own, no calls.
    R.ctl.noteFrame(frame({ weather: { trackWetness: 0.1 } }));
    await R.settle();
    check('damp surface: own (board laps are dry)', R.last() === null && R.ctl.getStatus().state === 'not-dry');
    R.ctl.noteFrame(frame());
    await R.settle();
    check('dry again: the board lap comes back', R.last() && R.last().meta.refId === `board:${SMITH}:109100`);
    const calls = R.league.calls.board_for_lap + R.league.calls.get_lap_trace;
    R.setSignedIn(false);
    R.ctl.noteFrame(frame());
    await R.settle();
    check('signed out: own, and no league call', R.last() === null && R.ctl.getStatus().state === 'signed-out' && R.league.calls.board_for_lap + R.league.calls.get_lap_trace === calls);
    R.ctl.setWanted(false);
    await R.settle();
    check('unwanted: own', R.last() === null && R.ctl.getStatus().state === 'off');
  }

  console.log('\n4) Failures retry with backoff and heal by themselves');
  {
    const R = rig();
    R.league.fail.get_lap_trace = true;
    R.ctl.setWanted(true);
    R.ctl.noteFrame(frame());
    await R.settle();
    check('trace fetch fails: own meanwhile', R.ctl.getStatus().reason === 'trace-unavailable' && (R.delivered.length === 0 || R.last() === null));
    const n = R.league.calls.get_lap_trace;
    for (let i = 0; i < 20; i++) R.ctl.noteFrame(frame());
    await R.settle();
    check('inside the backoff: no hammering', R.league.calls.get_lap_trace === n);
    R.league.fail.get_lap_trace = false;
    R.advance(BACKOFF_BASE_MS + 1);
    R.ctl.noteFrame(frame());
    await R.settle();
    check('after the backoff: fetched and chased', R.last() && R.last().meta.refId === `board:${SMITH}:109820`);
    const files = fs.readdirSync(R.cache.dir);
    check('only the success was written to disk', files.length === 1 && files[0].includes(SMITH));

    const B = rig();
    B.league.fail.board_for_lap = true;
    B.ctl.setWanted(true);
    B.ctl.noteFrame(frame());
    await B.settle();
    check('board fails: own, "board-unavailable"', B.ctl.getStatus().reason === 'board-unavailable');
    B.league.fail.board_for_lap = false;
    B.advance(BACKOFF_BASE_MS + 1);
    B.ctl.noteFrame(frame());
    await B.settle();
    check('board heals: chased', B.last() && B.last().meta.refId.startsWith('board:'));

    // The server not loaded yet: delivery retried on the next tick.
    const S = rig({ serverUp: false });
    S.ctl.setWanted(true);
    S.ctl.noteFrame(frame());
    await S.settle();
    check('no server yet: nothing delivered', S.delivered.length === 0);
    S.setServerUp(true);
    S.ctl.noteFrame(frame());
    check('server up: delivered on the next tick', S.last() && S.last().meta.refId.startsWith('board:'));

    // An RPC that throws rather than answering is an ordinary, backed-off failure.
    const T = rig();
    T.ctl.deps.rpc = async () => {
      throw new Error('socket hang up');
    };
    T.ctl.setWanted(true);
    T.ctl.noteFrame(frame());
    await T.settle();
    check('a throwing RPC: own, board-unavailable, retry scheduled', T.ctl.getStatus().reason === 'board-unavailable' && T.ctl.getStatus().retryAt > 0);

    // A board row whose trace has moved on (new time between the two reads).
    const M = rig();
    const realRpc = M.league.rpc;
    M.ctl.deps.rpc = async (fn, body) => {
      const res = await realRpc(fn, body);
      if (fn === 'get_lap_trace' && res.ok) res.body.lapMs -= 1;
      return res;
    };
    M.ctl.setWanted(true);
    M.ctl.noteFrame(frame());
    await M.settle();
    check('trace/row time mismatch: not chased, not cached', M.delivered.length === 0 && (() => { try { return fs.readdirSync(M.cache.dir).length === 0; } catch { return true; } })());
  }

  console.log('\n5) The cache');
  {
    const dir = newDir();
    // Real epoch ms: recency is persisted as file mtimes, so the clock must be on their scale.
    let now = Date.now();
    const c = new TraceCache({ dir, max: 3, now: () => now });
    const k = (drv, ms) => cacheKey(TRACK_ID, 'GT3', drv, ms);
    const hits = syncHits;
    await guarded(async () => {
      for (let i = 1; i <= 5; i++) {
        now += 10;
        await c.put(k(`drv-${i}`, 100_000 + i), { n: i });
      }
      await c.settled();
    });
    check('no sync fs in put/evict', syncHits === hits, syncHits - hits);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    check('LRU bound: 5 puts, 3 kept', files.length === 3, files.length);
    const fresh = new TraceCache({ dir, max: 3, now: () => now });
    await guarded(async () => {
      check('oldest evicted (fresh process reads the folder)', (await fresh.get(k('drv-1', 100_001))) === null && (await fresh.get(k('drv-2', 100_002))) === null);
      const hit = await fresh.get(k('drv-3', 100_003));
      check('a kept lap reads back from disk', hit && hit.n === 3);
    });
    check('…with no sync fs', syncHits === hits);
    now += 10;
    await fresh.get(k('drv-3', 100_003)); // touch: now the most recent
    now += 10;
    await fresh.put(k('drv-6', 100_006), { n: 6 });
    await fresh.settled();
    check('a hit refreshes recency: drv-3 survives, drv-4 goes', (await fresh.get(k('drv-3', 100_003))) && !(await fresh.get(k('drv-4', 100_004))));
    await fresh.put(k('drv-3', 99_000), { n: 'faster' });
    await fresh.settled();
    const after = fs.readdirSync(dir).filter((f) => f.includes('drv-3'));
    check('a new time for a driver drops the old one (lap_ms change)', after.length === 1 && after[0].includes('99000'));
    check('cacheKey refuses junk', cacheKey('../x', 'GT3', 'a', 1) === null && cacheKey(TRACK_ID, 'GT3', 'a', 0) === null);

    // A torn file is forgotten, not served and not stuck.
    const torn = new TraceCache({ dir: newDir(), now: () => now });
    await torn.put(k('drv-9', 1234), { ok: 1 });
    await torn.settled();
    const f = path.join(torn.dir, fs.readdirSync(torn.dir)[0]);
    fs.writeFileSync(f, '{"key":');
    const reread = new TraceCache({ dir: torn.dir, now: () => now });
    check('a torn file reads as a miss', (await reread.get(k('drv-9', 1234))) === null);
    await reread.settled();
    check('…and is removed so it can be refetched', fs.readdirSync(torn.dir).length === 0);

    const missing = new TraceCache({ dir: path.join(ROOT, 'never-made') });
    check('a missing folder is an empty cache', (await missing.get(k('x', 1))) === null);
  }

  console.log('\n6) Backoff: doubles, caps, never permanent');
  {
    const b = new Backoff();
    let t = 0;
    const delays = [];
    let heldEveryWindow = true;
    for (let i = 0; i < 12; i++) {
      const at = b.fail('k', t);
      delays.push(at - t);
      if (b.ready('k', at - 1)) heldEveryWindow = false;
      t = at;
    }
    check('not ready inside any window', heldEveryWindow);
    check('ready again once the window passes', b.ready('k', t));
    check('first delay is the base', delays[0] === BACKOFF_BASE_MS);
    check('doubles', delays[1] === BACKOFF_BASE_MS * 2 && delays[2] === BACKOFF_BASE_MS * 4);
    check('caps, and keeps retrying at the cap', delays[11] === BACKOFF_MAX_MS);
    b.clear('k');
    check('a success clears it', b.ready('k', 0) && b.retryAt('k') === 0);
  }

  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* temp */
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
