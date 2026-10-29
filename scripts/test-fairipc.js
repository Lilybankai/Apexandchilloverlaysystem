/**
 * scripts/test-fairipc.js — fair comparison laps in the main process, and
 * their pills in the Review tab.
 * (electron/fair-ipc.js, src/telemetry/fairTargetLoad.ts,
 *  practiceReviewLoad.boardTargetSnapshot, electron/control-panel/fair-chips.js)
 * -----------------------------------------------------------------------------
 * No Electron and no network: the league RPC is a fake that records its calls,
 * the lap log and traces are written to a temp folder from the real Road
 * Atlanta fixture lap.
 *
 *   §1 pure helpers: board lap ids, labels, a board row as a TargetLapInfo
 *      (board-conditions.js plausibility applies)
 *   §2 my lap off the lap log: best VALID lap, its conditions from the record
 *   §3 `practice:targets`: shape, pick, leader gap, the board cache (TTL,
 *      one read, backoff, stale rows on a failed refresh), signed out,
 *      offline, a wet session reads the wet board
 *   §4 a board lap as a practice target: fetched once then cached, a moved
 *      board time, no trace, signed out — and the debrief and the lap deep
 *      dive measured against it
 *   §5 `review:fairChips` and the register() wiring
 *   §6 fair-chips.js: pills, order, escaping, the one-ask sync
 *
 * Run: node scripts/test-fairipc.js (build first)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fi = require('../electron/fair-ipc');
const { TraceCache, Backoff, cacheKey } = require('../electron/trainingRefCache');
const { loadFairSession } = require('../dist/telemetry/fairTargetLoad');
const { boardTargetSnapshot, loadPracticeReview } = require('../dist/telemetry/practiceReviewLoad');
const { loadPracticeLap } = require('../dist/telemetry/practiceLap');
const { listSessions } = require('../dist/telemetry/stintReview');
const chipsMod = require('../electron/control-panel/fair-chips');

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

/* ------------------------------- fixtures -------------------------------- */

const FIX = require('./fixtures/trace-road-atlanta-gt3.json');
const L = FIX.trackLengthM;
const BASE = FIX.trace;

function scaled(k) {
  const out = {};
  for (const [key, v] of Object.entries(BASE)) out[key] = Array.isArray(v) ? v.slice() : v;
  out.t = BASE.t.map((v) => v * k);
  out.lapSec = BASE.lapSec * k;
  return out;
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-fairipc-'));
const LAPS = path.join(ROOT, 'laps');
const TRACES = path.join(ROOT, 'traces');
const REVIEWS = path.join(ROOT, 'practice-reviews');
const CACHE = path.join(ROOT, 'training-refs');
fs.mkdirSync(LAPS, { recursive: true });
fs.mkdirSync(REVIEWS, { recursive: true });

const DAY = '2026-10-08';
const REC = {
  v: 7, sim: 'lmu', track: FIX.track, trackKey: FIX.trackKey, trackLengthM: L,
  car: FIX.car, carClass: FIX.carClass, distanceM: L, sessionType: 'practice', clean: true, dirty: [],
};
// p1 slow; p2 the best VALID lap (with its conditions); p3 quicker but dirty.
const LAPS_IN = [
  { id: 'p1', at: `${DAY}T10:00:00.000Z`, k: 1.01, extra: {} },
  {
    id: 'p2', at: `${DAY}T10:01:30.000Z`, k: 1.0,
    extra: { fuelStartL: 40, capacityL: 120, veStartPct: 88, compound: 'Medium', trackTempC: 31, ambientTempC: 22, condition: 'dry', wetness: 0 },
  },
  { id: 'p3', at: `${DAY}T10:03:00.000Z`, k: 0.99, extra: { clean: false, dirty: ['offTrack'] } },
];
fs.writeFileSync(path.join(LAPS, `${DAY}.jsonl`), LAPS_IN
  .map((l) => JSON.stringify({ ...REC, id: l.id, at: l.at, lapMs: Math.round(BASE.lapSec * l.k * 1000), ...l.extra }))
  .join('\n') + '\n');
for (const l of LAPS_IN) {
  const dir = path.join(TRACES, DAY);
  fs.mkdirSync(dir, { recursive: true });
  const tr = scaled(l.k);
  fs.writeFileSync(path.join(dir, `${l.id}.json`), JSON.stringify({
    v: 2, lapId: l.id, at: l.at, sim: 'lmu', trackKey: FIX.trackKey, track: FIX.track, trackLengthM: L,
    car: FIX.car, carClass: FIX.carClass, lapMs: Math.round(tr.lapSec * 1000), trace: tr,
  }));
}
const SID = (listSessions(LAPS)[0] || {}).id;
const MY_MS = Math.round(BASE.lapSec * 1000);

const TRACK_ID = '11111111-2222-3333-4444-555555555555';
const DRV_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const DRV_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const DRV_C = 'cccccccc-0000-0000-0000-000000000003';
const A_MS = Math.round(MY_MS * 0.99); // 1% quicker, clean conditions → the fair pick
const B_MS = Math.round(MY_MS * 0.97); // 3% quicker, qualifying, no fuel → info
const C_MS = Math.round(MY_MS * 0.98); // track 15 °C hotter → drop
const rowsDry = () => [
  { track_id: TRACK_ID, rank: 1, driver_id: DRV_B, display_name: 'Bea Fast', car: 'Mustang Custom Team 2026 #397', lap_ms: B_MS, gap_ms: 0, is_you: false,
    has_trace: true, has_line: true, condition: 'dry', session_type: 'qualifying', track_temp_c: 30, air_temp_c: 21 },
  { track_id: TRACK_ID, rank: 2, driver_id: DRV_C, display_name: 'Cal Hot', car: FIX.car, lap_ms: C_MS, gap_ms: B_MS - C_MS, is_you: false,
    has_trace: true, has_line: true, condition: 'dry', session_type: 'practice', track_temp_c: 46, air_temp_c: 22 },
  { track_id: TRACK_ID, rank: 3, driver_id: DRV_A, display_name: 'Al Fair', car: FIX.car, lap_ms: A_MS, gap_ms: A_MS - B_MS, is_you: false,
    has_trace: true, has_line: true, condition: 'dry', session_type: 'practice', track_temp_c: 31.5, air_temp_c: 22,
    fuel_start_l: 41, fuel_capacity_l: 120, compound: 'Medium' },
  { track_id: TRACK_ID, rank: 4, driver_id: 'bad id!', display_name: 'Broken', car: '', lap_ms: 0, has_trace: false },
];

/** A fake league: board_for_lap and get_lap_trace, scripted per test. */
function fakeLeague(opts) {
  const o = opts || {};
  const calls = [];
  const rpc = async (fn, body) => {
    calls.push({ fn, body });
    if (o.signedOut) return { ok: false, signedOut: true, error: 'Not signed in.' };
    if (fn === 'board_for_lap') {
      if (o.boardFails && o.boardFails()) return { ok: false, error: 'offline' };
      return { ok: true, body: o.rows ? o.rows(body) : rowsDry() };
    }
    if (fn === 'get_lap_trace') {
      if (o.traceFails) return { ok: false, error: 'offline' };
      const row = rowsDry().find((r) => r.driver_id === body.p_driver_id);
      const lapMs = o.traceLapMs !== undefined ? o.traceLapMs : row.lap_ms;
      return { ok: true, body: { found: true, driverId: body.p_driver_id, lapMs, car: row.car, setAt: '2026-10-01T00:00:00Z', data: scaled(row.lap_ms / MY_MS) } };
    }
    return { ok: false, error: `unexpected ${fn}` };
  };
  return { rpc, calls };
}

function service(league, extra) {
  const dist = path.join(__dirname, '..', 'dist', 'telemetry');
  let t = (extra && extra.t0) || 1_000_000;
  const svc = new fi.FairService({
    rpc: league.rpc,
    fair: () => require(path.join(dist, 'fairTarget.js')),
    load: () => require(path.join(dist, 'fairTargetLoad.js')),
    practiceLoad: () => require(path.join(dist, 'practiceReviewLoad.js')),
    formatLapTime: require(path.join(dist, 'raceLog.js')).formatLapTime,
    cache: new TraceCache({ dir: (extra && extra.cacheDir) || CACHE, now: () => t }),
    backoff: new Backoff(),
    lapDir: LAPS,
    now: () => t,
  });
  svc.advance = (ms) => { t += ms; };
  return svc;
}

(async () => {
  console.log('\n§1 pure helpers');
  {
    const row = rowsDry()[2];
    const id = fi.boardLapId(row);
    check('board lap id = board:<driverId>:<lapMs>', id === `board:${DRV_A}:${A_MS}`, id);
    const back = fi.parseBoardLapId(id);
    check('…and back', back && back.driverId === DRV_A && back.lapMs === A_MS);
    check('a bad id parses to null', fi.parseBoardLapId('board:x y:1') === null && fi.parseBoardLapId('p2') === null && fi.parseBoardLapId(null) === null);
    check('a row with no time or a bad driver id has no id', fi.boardLapId(rowsDry()[3]) === '' && fi.boardLapId({ driver_id: DRV_A, lap_ms: 1.5 }) === '');
    check('label "A. Fair · 1:20.xxx"', /^A\. Fair · 1:\d\d\.\d{3}$/.test(fi.candidateLabel(row)), fi.candidateLabel(row));
    check('my own row is "You · …"', fi.candidateLabel({ ...row, is_you: true }).startsWith('You · '));
    const t = fi.targetFromBoardRow(row, { carClass: 'GT3', trackKey: FIX.trackKey });
    check('a row as a TargetLapInfo', t.lapId === id && t.carClass === 'GT3' && t.lapSec === A_MS / 1000 && t.fuelStartL === 41
      && t.fuelCapacityL === 120 && t.compound === 'Medium' && t.condition === 'dry' && t.hasTrace === true && t.clean === true
      && t.trackKey === FIX.trackKey && t.sessionType === 'practice', JSON.stringify(t));
    const odd = fi.targetFromBoardRow({ ...row, fuel_start_l: 0, track_temp_c: 200, session_type: 'nonsense', condition: null },
      { carClass: 'GT3', trackKey: 'k', condition: 'damp' });
    check('implausible values are "not recorded" (board-conditions.js rules)', odd.fuelStartL === null && odd.trackTempC === null && odd.sessionType === null);
    check('a row with no condition takes the board\'s', odd.condition === 'damp');
    check('usableRows drops unnamed rows', fi.usableRows(rowsDry()).length === 3 && fi.usableRows(null).length === 0);
  }

  console.log('\n§2 my lap off the lap log');
  {
    check('the fixture is one session', !!SID, SID);
    const info = loadFairSession(SID, LAPS);
    const m = info && info.mine;
    check('best VALID lap: p2, not the quicker dirty p3', m && m.lapId === 'p2' && m.lapSec === MY_MS / 1000, m && m.lapId);
    check('conditions from the record: fuel, tank, energy, compound, temps, surface',
      m && m.fuelStartL === 40 && m.fuelCapacityL === 120 && m.vePct === 88 && m.compound === 'Medium'
        && m.trackTempC === 31 && m.airTempC === 22 && m.condition === 'dry', JSON.stringify(m));
    check('session: circuit, class, type', info.session.trackKey === FIX.trackKey && info.session.carClass === 'GT3' && info.session.sessionType === 'practice');
    check('unknown session → null', loadFairSession('nope', LAPS) === null);
  }

  console.log('\n§3 practice:targets');
  {
    const league = fakeLeague();
    const svc = service(league);
    const r = await svc.targets(SID);
    check('ok, with my lap', r.ok === true && r.mine && r.mine.lapId === 'p2');
    check('three candidates (the unnamed row dropped)', r.candidates.length === 3, r.candidates.length);
    check('ranked fairest first: Al (no flags), Bea (quali info), Cal (drop)',
      r.candidates.map((c) => c.lap.driver).join(',') === 'Al Fair,Bea Fast,Cal Hot', r.candidates.map((c) => c.lap.driver).join(','));
    check('every candidate has a label and an assessment', r.candidates.every((c) => typeof c.label === 'string' && c.assessment && Array.isArray(c.assessment.flags)));
    check('Bea: "likely low fuel, fresh tyres" + different car', (() => {
      const b = r.candidates.find((c) => c.lap.driver === 'Bea Fast');
      return b.assessment.flags.map((f) => f.text).join('|') === 'different car (BoP)|likely low fuel, fresh tyres';
    })(), JSON.stringify(r.candidates[1].assessment.flags));
    check('Cal: track 15 °C hotter → drop', r.candidates[2].assessment.flags.some((f) => f.kind === 'trackTemp' && f.severity === 'drop'));
    check('pick = Al (1% quicker, fair)', r.pick === `board:${DRV_A}:${A_MS}`, r.pick);
    check('leader gap vs the top of the board (Bea)', r.leaderGap && Math.abs(r.leaderGap.sec - (MY_MS - B_MS) / 1000) < 1e-9
      && r.leaderGap.label === `+${((MY_MS - B_MS) / 1000).toFixed(2)} s vs top GT3` && r.leaderGap.flags.length === 2, r.leaderGap && r.leaderGap.label);
    check('the board read is board_for_lap, dry, for this circuit and class',
      league.calls.length === 1 && league.calls[0].fn === 'board_for_lap' && league.calls[0].body.p_track_key === FIX.trackKey
        && league.calls[0].body.p_car_class === 'GT3' && league.calls[0].body.p_condition === 'dry');

    await svc.targets(SID);
    check('a second ask inside 5 min reads no board', league.calls.length === 1);
    svc.advance(fi.BOARD_TTL_MS + 1);
    await svc.targets(SID);
    check('after 5 min it reads again', league.calls.length === 2);

    // Concurrent asks share one read.
    const l2 = fakeLeague();
    const s2 = service(l2);
    await Promise.all([s2.targets(SID), s2.targets(SID), s2.targets(SID)]);
    check('three asks at once → one board read', l2.calls.length === 1, l2.calls.length);

    // Failures.
    let failing = false;
    const l3 = fakeLeague({ boardFails: () => failing });
    const s3 = service(l3);
    await s3.targets(SID);
    failing = true;
    s3.advance(fi.BOARD_TTL_MS + 1);
    const stale = await s3.targets(SID);
    check('a failed refresh serves the last good board', stale.ok === true && stale.candidates.length === 3);
    const n = l3.calls.length;
    await s3.targets(SID);
    check('…and backs off (no immediate re-read)', l3.calls.length === n, `${l3.calls.length} vs ${n}`);

    const l4 = fakeLeague({ boardFails: () => true });
    const off = await service(l4).targets(SID);
    check('offline, nothing cached → ok:false, my lap still there, no candidates',
      off.ok === false && off.mine && off.mine.lapId === 'p2' && off.candidates.length === 0 && off.pick === null && off.leaderGap === null && !!off.error);

    const out = await service(fakeLeague({ signedOut: true })).targets(SID);
    check('signed out → ok:false, signedOut, no candidates', out.ok === false && out.signedOut === true && out.candidates.length === 0);
    check('no session id → ok:false', (await svc.targets('')).ok === false && (await svc.targets('nope')).ok === false);

    // A wet session reads the wet board; its rows have no traces → no pick.
    const wetLaps = path.join(ROOT, 'laps-wet');
    fs.mkdirSync(wetLaps, { recursive: true });
    fs.writeFileSync(path.join(wetLaps, `${DAY}.jsonl`), JSON.stringify({ ...REC, id: 'w1', at: `${DAY}T12:00:00.000Z`, lapMs: MY_MS + 9000, condition: 'wet', wetness: 0.4 }) + '\n');
    const l5 = fakeLeague({ rows: () => rowsDry().slice(0, 3).map((x) => ({ ...x, condition: 'wet', has_trace: false, has_line: false, lap_ms: x.lap_ms + 6000 })) });
    const s5 = service(l5);
    s5.deps.lapDir = wetLaps;
    const wsid = listSessions(wetLaps)[0].id;
    const w = await s5.targets(wsid);
    check('a wet session reads the WET board', l5.calls[0].body.p_condition === 'wet', l5.calls[0].body.p_condition);
    check('…lists it, with a leader gap, but picks nothing (no traces there)', w.ok && w.candidates.length === 3 && w.pick === null && !!w.leaderGap);
  }

  console.log('\n§4 a board lap as the practice target');
  {
    const cacheDir = path.join(ROOT, 'cache-4');
    const league = fakeLeague();
    const svc = service(league, { cacheDir });
    const id = `board:${DRV_A}:${A_MS}`;
    const r = await svc.boardTarget(SID, id);
    check('ok, a snapshot of kind "board"', r.ok && r.target && r.target.kind === 'board', r.error);
    check('lapId is the board id, lapSec the board time, label the candidate label',
      r.target.lapId === id && r.target.lapSec === A_MS / 1000 && /^A\. Fair · /.test(r.target.label), JSON.stringify({ ...r.target, columns: undefined }));
    check('columns are ghost.json\'s: d, t, line, corners', r.target.columns.d.length > 100 && Array.isArray(r.target.columns.x)
      && Array.isArray(r.target.columns.corners) && r.target.columns.corners.length > 0 && r.target.columns.trackLengthM === L);
    check('one board read and one trace fetch', league.calls.map((c) => c.fn).join(',') === 'board_for_lap,get_lap_trace');
    await svc.deps.cache.settled();
    const key = cacheKey(TRACK_ID, 'GT3', DRV_A, A_MS);
    check('the trace is kept in the Training cache\'s format', fs.existsSync(path.join(cacheDir, `${key.split('|').join('.')}.json`)));

    const again = service(league, { cacheDir });
    const before = league.calls.length;
    const r2 = await again.boardTarget(SID, id);
    check('a fresh service (an app restart) reads it from disk: no trace fetch',
      r2.ok && league.calls.slice(before).every((c) => c.fn !== 'get_lap_trace'), league.calls.slice(before).map((c) => c.fn).join(','));

    // The board snapshot directly.
    check('boardTargetSnapshot: no length or time → null',
      boardTargetSnapshot(BASE, { driverId: DRV_A, lapMs: A_MS, label: 'x', trackKey: 'k', trackLengthM: 0, carClass: 'GT3' }) === null
        && boardTargetSnapshot(BASE, { driverId: DRV_A, lapMs: 0, label: 'x', trackKey: 'k', trackLengthM: L, carClass: 'GT3' }) === null);
    check('boardTargetSnapshot: junk columns → null',
      boardTargetSnapshot({ d: [0], t: [0] }, { driverId: DRV_A, lapMs: A_MS, label: 'x', trackKey: 'k', trackLengthM: L, carClass: 'GT3' }) === null);

    // Failures.
    const moved = await service(fakeLeague({ traceLapMs: A_MS - 500 }), { cacheDir: path.join(ROOT, 'cache-moved') }).boardTarget(SID, id);
    check('a trace for another time than the row (board moved between reads) → refused', moved.ok === false && moved.target === null);
    const nt = await service(fakeLeague({ rows: () => rowsDry().map((x) => ({ ...x, has_trace: false })) }), { cacheDir: path.join(ROOT, 'cache-nt') }).boardTarget(SID, id);
    check('a row with no telemetry → refused, says so', nt.ok === false && /telemetry/.test(nt.error), nt.error);
    const gone = await svc.boardTarget(SID, `board:dddddddd-0000-0000-0000-000000000009:${A_MS}`);
    check('a driver not on the board → refused', gone.ok === false && /board/.test(gone.error), gone.error);
    const so = await service(fakeLeague({ signedOut: true }), { cacheDir: path.join(ROOT, 'cache-so') }).boardTarget(SID, id);
    check('signed out → refused, signedOut', so.ok === false && so.signedOut === true);
    const off = await service(fakeLeague({ traceFails: true }), { cacheDir: path.join(ROOT, 'cache-off') }).boardTarget(SID, id);
    check('trace fetch offline → refused', off.ok === false);
    check('an unknown target id → refused', (await svc.boardTarget(SID, 'p2')).ok === false);
    const newer = await svc.boardTarget(SID, `board:${DRV_A}:${A_MS + 999}`);
    check('an old board time for a driver → their CURRENT lap', newer.ok && newer.target.lapId === id, newer.target && newer.target.lapId);

    // The debrief and the deep dive, measured against it.
    const deps = { reviewDir: REVIEWS, lapDir: LAPS, traceDir: TRACES };
    const plain = loadPracticeReview(SID, deps);
    check('without a target: the session best, as before', plain.target.kind === 'sessionBest' && plain.target.lapId === 'p2');
    const vs = loadPracticeReview(SID, deps, { target: r.target });
    check('with { target }: measured against the board lap', vs.target.kind === 'board' && vs.target.lapId === id && vs.target.label === r.target.label);
    const p2 = vs.laps.find((l) => l.lapNo === 2);
    check('p2 is 1% slower than it: delta = my time − board time',
      p2 && Math.abs(p2.deltaSec - (MY_MS - A_MS) / 1000) < 0.002, p2 && p2.deltaSec);
    check('its corners all lose time to a lap 1% quicker everywhere', vs.corners.length > 0 && vs.corners.every((c) => c.avgLossSec === null || c.avgLossSec > 0),
      vs.corners.map((c) => c.avgLossSec).join(','));
    const deep = loadPracticeLap({ sessionId: SID, lapId: 'p2', at: LAPS_IN[1].at, target: r.target }, deps);
    check('practice:lap with { target }: the same board lap, laid under as `vs`',
      deep && deep.target.kind === 'board' && deep.vs && deep.vs.lapId === id, deep && JSON.stringify(deep.target));
    check('…corners one for one with the debrief', deep && deep.corners.length === vs.corners.length);
  }

  console.log('\n§5 review:fairChips and the wiring');
  {
    const svc = service(fakeLeague());
    const c = svc.chips(SID, rowsDry());
    check('chips keyed by driver id, for every named row', c.ok && Object.keys(c.chips).sort().join(',') === [DRV_A, DRV_B, DRV_C].sort().join(','));
    check('Al: none; Cal: the hot track', c.chips[DRV_A].length === 0 && c.chips[DRV_C].some((f) => f.kind === 'trackTemp'));
    check('pick = Al\'s driver id', c.pick === DRV_A, c.pick);
    check('no session → ok:false, empty', svc.chips('', rowsDry()).ok === false && Object.keys(svc.chips('nope', []).chips).length === 0);

    const handlers = {};
    const league = fakeLeague();
    const reg = fi.register({ handle: (name, fn) => { handlers[name] = fn; } }, {
      auth: { rpc: league.rpc }, userData: () => ROOT, lapDir: LAPS, cache: new TraceCache({ dir: path.join(ROOT, 'cache-5') }),
    });
    check('register() adds practice:targets and review:fairChips', typeof handlers['practice:targets'] === 'function' && typeof handlers['review:fairChips'] === 'function');
    check('…and hands back the service', reg instanceof fi.FairService && typeof reg.boardTarget === 'function');
    const viaIpc = await handlers['practice:targets'](null, { sessionId: SID });
    check('practice:targets over the bridge', viaIpc.ok && viaIpc.pick === `board:${DRV_A}:${A_MS}`);
    const bad = await handlers['practice:targets'](null, null);
    check('…a bad request is ok:false, not a throw', bad.ok === false && Array.isArray(bad.candidates));
    const ch = handlers['review:fairChips'](null, { sessionId: SID, rows: rowsDry() });
    check('review:fairChips over the bridge', ch.ok && ch.pick === DRV_A);
  }

  console.log('\n§6 fair-chips.js');
  {
    const { chipsHtml, slimRows } = chipsMod;
    check('no flags → empty', chipsHtml([]) === '' && chipsHtml(null) === '');
    const h = chipsHtml([
      { kind: 'session', severity: 'info', text: 'likely low fuel, fresh tyres' },
      { kind: 'trackTemp', severity: 'drop', text: 'track 12 °C hotter' },
      { kind: 'car', severity: 'warn', text: 'different car (BoP)' },
    ]);
    const order = [...h.matchAll(/data-sev="(\w+)"/g)].map((m) => m[1]).join(',');
    check('worst first: drop, warn, info', order === 'drop,warn,info', order);
    check('a drop says it is not picked, in its title', /not picked automatically/.test(h));
    check('the fair pick pill comes first', /^<span class="fairchips"><span class="fairchip" data-sev="pick"/.test(chipsHtml([], { pick: true })));
    check('text is escaped', !/<b>/.test(chipsHtml([{ kind: 'car', severity: 'warn', text: '<b>x</b>' }])));
    const many = chipsHtml(['a', 'b', 'c', 'd', 'e'].map((t) => ({ kind: 'car', severity: 'warn', text: t })));
    check('at most three pills, "+2" on the last, the rest in its title', (many.match(/class="fairchip"/g) || []).length === 3 && /c \+2/.test(many) && /title="c · d · e"/.test(many));
    check('slimRows keeps only what is assessed', JSON.stringify(Object.keys(slimRows([{ driver_id: 'x', lap_ms: 1, secret: 's' }])[0])) === '["driver_id","lap_ms"]');

    // sync() with a fake window.apex: asks once per (session, rows), repaints once.
    let asked = 0;
    let painted = 0;
    global.window = {
      apex: {
        reviewFairChips: async (req) => {
          asked++;
          return { ok: true, chips: { [DRV_C]: [{ kind: 'trackTemp', severity: 'drop', text: 'track 15 °C hotter' }] }, pick: DRV_A, n: req.rows.length };
        },
      },
    };
    delete require.cache[require.resolve('../electron/control-panel/fair-chips')];
    const live = require('../electron/control-panel/fair-chips');
    const rows = rowsDry();
    const first = live.sync('s1', rows, () => { painted++; });
    check('before the answer: no pills', first.html(rows[1]) === '');
    await new Promise((r) => setTimeout(r, 10));
    const second = live.sync('s1', rows, () => { painted++; });
    check('one ask, one repaint', asked === 1 && painted === 1, `${asked}/${painted}`);
    check('after: Cal has the drop pill, Al the fair pick', /track 15 °C hotter/.test(second.html(rows[1])) && /fair pick/.test(second.html(rows[2])));
    check('rowHtml: a row of its own spanning the table', /^<tr class="fairrow"><td><\/td><td colspan="5">/.test(second.rowHtml(rows[1], 6)));
    check('rowHtml: nothing for a row with no pills', second.rowHtml(rows[0], 6) === '');
    live.sync('s2', rows, () => { painted++; });
    await new Promise((r) => setTimeout(r, 10));
    check('another session asks again', asked === 2);
    window.apex = {};
    check('the call missing → no pills, no throw', live.sync('s3', rows, () => {}).html(rows[1]) === '' && live.sync('s3', rows).rowHtml(rows[1], 6) === '');
    delete global.window;
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
