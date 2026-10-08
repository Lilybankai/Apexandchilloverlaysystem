/**
 * scripts/test-ghostref.js — a board lap injected into the ghost selector.
 * -----------------------------------------------------------------------------
 * The Training tab can point Ghost HUD at a league board lap; the desktop app
 * fetches it and hands it to the server with `setGhostReference(trace, meta)`.
 * This pins the selector's side of that:
 *
 *   1. a reference for the combo being driven beats the local best;
 *   2. a reference for any other combo (track, class, surface) is never used;
 *   3. each reference has its own `sourceLapId`, so the widget refetches;
 *   4. clearing it goes back to the local best — and never leaves the board
 *      lap showing when there is no local lap to replace it;
 *   5. a reference arriving mid-load wins over the slower local read
 *      (generation-safe), and a new local PB does not displace it;
 *   6. none of it makes a synchronous fs call;
 *   7. the server entry point validates what it is handed.
 *
 * Run: npm run test:ghostref
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GhostSelector } = require('../dist/telemetry/ghostSelector');
const {
  makeGhostReference,
  referenceMatches,
  ghostFromReference,
} = require('../dist/telemetry/ghostReference');
const { ghostGap } = require('../dist/telemetry/ghostLap');
const { traceFilePath } = require('../dist/telemetry/lapTrace');
const { trackKeyOf } = require('../dist/telemetry/paceDelta');

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

const SYNC_FNS = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'openSync', 'readSync', 'accessSync', 'fstatSync', 'writeFileSync'];
const real = {};
let syncHits = 0;
for (const name of SYNC_FNS) real[name] = fs[name];
async function guarded(fn) {
  for (const name of SYNC_FNS) {
    fs[name] = function guardedFs(...args) {
      syncHits++;
      throw new Error(`sync fs call during ghost selection: ${name}(${String(args[0])})`);
    };
  }
  try {
    return await fn();
  } finally {
    for (const name of SYNC_FNS) fs[name] = real[name];
  }
}

/* ------------------------------ fixtures ---------------------------------- */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ghostref-'));
let storeN = 0;
function newStore() {
  const dir = path.join(ROOT, `s${storeN++}`);
  const dirs = { laps: path.join(dir, 'laps'), traces: path.join(dir, 'traces') };
  fs.mkdirSync(dirs.laps, { recursive: true });
  fs.mkdirSync(dirs.traces, { recursive: true });
  return dirs;
}

const TRACK = 'Autodromo Nazionale Monza';
const TRACK_LEN = 5781;
const TRACK_KEY = trackKeyOf(TRACK, TRACK_LEN);
const COMBO = { sim: 'lmu', trackKey: TRACK_KEY, carClass: 'GT3', condition: 'dry', trackLengthM: TRACK_LEN };

function columns(lapSec, n = 400, line = true) {
  const d = [];
  const t = [];
  for (let i = 0; i <= n; i++) {
    d.push(i / n);
    t.push((i / n) * lapSec);
  }
  return {
    lapSec,
    count: d.length,
    truncated: false,
    d,
    t,
    speedKph: d.map((v) => 150 + 100 * Math.abs(Math.sin(v * 12))),
    brake: d.map((v) => (Math.sin(v * 12) > 0.9 ? 0.8 : 0)),
    throttle: d.map((v) => (Math.sin(v * 12) > 0.9 ? 0 : 1)),
    ...(line ? { x: d.map((v) => v * 1000), z: d.map(() => 0) } : {}),
  };
}

let lapN = 0;
function addLocalLap(dirs, lapMs) {
  lapN++;
  const r = {
    v: 7,
    id: `lap-${lapN}`,
    at: '2026-10-05T12:00:00.000Z',
    sim: 'lmu',
    track: TRACK,
    trackKey: TRACK_KEY,
    trackLengthM: TRACK_LEN,
    car: 'Test GT3 #1',
    carClass: 'GT3',
    lapMs,
    clean: true,
    condition: 'dry',
  };
  fs.appendFileSync(path.join(dirs.laps, '2026-10-05.jsonl'), JSON.stringify(r) + '\n');
  const p = traceFilePath(r.id, r.at, dirs.traces);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({ v: 2, lapId: r.id, at: r.at, sim: 'lmu', trackKey: TRACK_KEY, track: TRACK, trackLengthM: TRACK_LEN, car: r.car, carClass: 'GT3', lapMs, trace: columns(lapMs / 1000) }),
  );
  return r;
}

function boardRef(over = {}, lapMs = 109_820) {
  const meta = {
    sim: 'lmu',
    trackKey: TRACK_KEY,
    carClass: 'GT3',
    condition: 'dry',
    refId: `board:drv-1:${lapMs}`,
    label: `J. Smith · ${lapMs} · board`,
    lapMs,
    ...over,
  };
  return makeGhostReference(columns(lapMs / 1000), meta);
}

/* ---------------------------------- tests --------------------------------- */

async function main() {
  console.log('\n1) The reference itself');
  {
    const ref = boardRef();
    check('a well-formed reference is accepted', !!ref && ref.refId === 'board:drv-1:109820');
    check('no meta → refused', makeGhostReference(columns(100), null) === null);
    check('no trackKey → refused', makeGhostReference(columns(100), { ...ref, trackKey: '' }) === null);
    check('unknown surface → refused', makeGhostReference(columns(100), { ...ref, condition: 'icy' }) === null);
    check('no distance column → refused', makeGhostReference({ t: [0, 1] }, ref) === null);
    check('matches its own combo', referenceMatches(ref, COMBO));
    check('not another track', !referenceMatches(ref, { ...COMBO, trackKey: 'spa_7004' }));
    check('not another class', !referenceMatches(ref, { ...COMBO, carClass: 'LMP2' }));
    check('not another surface', !referenceMatches(ref, { ...COMBO, condition: 'damp' }));
    const lap = ghostFromReference(ref, TRACK_LEN);
    check('builds a ghost on the LIVE track length', lap && lap.trackLengthM === TRACK_LEN);
    check('…with its line, brakes and corners', lap && lap.x && lap.brakes && Array.isArray(lap.corners));
    check('…id and label from the meta', lap && lap.lapId === ref.refId && lap.label === ref.label);
    check('no live length → no ghost', ghostFromReference(ref, 0) === null);
    const gap = ghostGap(lap, 10, 0.1);
    check('the frame carries the reference id as sourceLapId', gap && gap.sourceLapId === ref.refId);
  }

  console.log('\n2) Priority: the reference for this combo beats the local best');
  {
    const dirs = newStore();
    const local = addLocalLap(dirs, 108_000); // quicker than the board lap, still not chased
    const published = [];
    const sel = new GhostSelector({ dirs, publish: (l) => published.push(l) });
    sel.setWanted(true);
    const hits = syncHits;
    await guarded(async () => {
      sel.sync(COMBO, 1000);
      await sel.settled();
    });
    check('with no reference: the local best', sel.lap && sel.lap.lapId === local.id);
    const ref = boardRef();
    await guarded(async () => {
      sel.setReference(ref);
      await sel.settled();
      for (let i = 0; i < 50; i++) sel.sync(COMBO, 2000 + i * 33);
      await sel.settled();
    });
    check('no sync fs call on the reference path', syncHits === hits, syncHits - hits);
    check('the reference is chased', sel.lap && sel.lap.lapId === ref.refId);
    check('…published once', published.filter((l) => l && l.lapId === ref.refId).length === 1);

    const ref2 = boardRef({}, 109_500);
    sel.setReference(ref2);
    await sel.settled();
    check('a new board time is a new sourceLapId', sel.lap && sel.lap.lapId === 'board:drv-1:109500' && sel.lap.lapId !== ref.refId);

    sel.setReference(null);
    await sel.settled();
    check('cleared → back to the local best', sel.lap && sel.lap.lapId === local.id);
  }

  console.log('\n3) Combo check: a reference for another combo is never used');
  {
    const dirs = newStore();
    const local = addLocalLap(dirs, 110_000);
    const sel = new GhostSelector({ dirs });
    sel.setWanted(true);
    sel.setReference(boardRef({ trackKey: 'circuit-de-spa-francorchamps_7004' }));
    sel.sync(COMBO, 1000);
    await sel.settled();
    check('another track: the local best', sel.lap && sel.lap.lapId === local.id);
    sel.setReference(boardRef({ carClass: 'LMP2' }));
    await sel.settled();
    check('another class: the local best', sel.lap && sel.lap.lapId === local.id);
    sel.setReference(boardRef());
    await sel.settled();
    check('this combo: the reference', sel.lap && sel.lap.lapId.startsWith('board:'));
    sel.sync({ ...COMBO, condition: 'damp' }, 2000);
    await sel.settled();
    check('the surface turns damp: the dry board lap is dropped', !sel.lap || !sel.lap.lapId.startsWith('board:'));
    sel.sync(COMBO, 3000);
    await sel.settled();
    check('dry again: the reference comes back', sel.lap && sel.lap.lapId.startsWith('board:'));
  }

  console.log('\n4) No local lap: clearing the reference leaves nothing, not the board lap');
  {
    const dirs = newStore();
    const published = [];
    const sel = new GhostSelector({ dirs, publish: (l) => published.push(l) });
    sel.setWanted(true);
    sel.setReference(boardRef());
    sel.sync(COMBO, 1000);
    await sel.settled();
    check('the reference is chased with an empty store', sel.lap && sel.lap.lapId.startsWith('board:'));
    sel.setReference(null);
    await sel.settled();
    check('cleared with no local lap → no ghost', sel.lap === null);
    check('…and the widget was told', published[published.length - 1] === null);
    const bad = makeGhostReference({ d: [0.5, 0.4], t: [1, 2] }, boardRef());
    sel.setReference(bad);
    await sel.settled();
    check('a reference that cannot be built falls through to the (empty) local best', sel.lap === null);
  }

  console.log('\n5) Generation-safe, and a new PB does not displace the chosen lap');
  {
    const dirs = newStore();
    addLocalLap(dirs, 111_000);
    const sel = new GhostSelector({ dirs });
    sel.setWanted(true);
    sel.sync(COMBO, 1000); // a local load is now in flight
    sel.setReference(boardRef()); // …and the reference lands before it finishes
    await sel.settled();
    await new Promise((r) => setTimeout(r, 20));
    check('the slower local read does not put the local lap back', sel.lap && sel.lap.lapId.startsWith('board:'));
    sel.noteLap({ id: 'pb', sim: 'lmu', trackKey: TRACK_KEY, carClass: 'GT3', condition: 'dry', clean: true, lapMs: 100_000 });
    sel.sync(COMBO, 2000);
    await sel.settled();
    check('a new clean PB does not replace the chosen reference', sel.lap && sel.lap.lapId.startsWith('board:'));
    sel.setWanted(false);
    check('unwanted: nothing selected', sel.lap === null);
    sel.setWanted(true);
    sel.sync(COMBO, 3000);
    await sel.settled();
    check('wanted again: the reference is still remembered', sel.lap && sel.lap.lapId.startsWith('board:'));
  }

  console.log('\n6) The server entry point');
  {
    const server = require('../dist/server/index');
    check('setGhostReference is exported', typeof server.setGhostReference === 'function');
    check('null is always accepted', server.setGhostReference(null) === true);
    check('garbage is refused', server.setGhostReference({ d: 'x' }, {}) === false);
    const ref = boardRef();
    const { trace, ...meta } = ref;
    check('a real reference is accepted (before any provider exists)', server.setGhostReference(trace, meta) === true);
    server.setGhostReference(null);
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
