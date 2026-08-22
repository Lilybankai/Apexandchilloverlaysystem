/**
 * scripts/test-bench.js — the bench suite is wired, complete, and honest.
 * -----------------------------------------------------------------------------
 * The numbers themselves vary by machine, so this file does not fail a run
 * because a poll took 0.4 ms instead of 0.2. What it pins down is the suite:
 *
 *   - every overlay widget declares a throttleMs we can inventory
 *   - the known 30 Hz set is still exactly the five canvas instruments
 *   - field expansion produces N standings (the 6-hour-grid question)
 *   - a short pipeline sample returns finite stats
 *   - the assessment function emits the verdict ids the report is built on
 *
 * Run: node scripts/test-bench.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { inventory } = require('./bench-widgets');
const { expandField, loadSimulator, statsOf, DEFAULT_HZ, budgetMs } = require('./lib/bench-util');
const { assess } = require('./bench');

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

console.log('\ninventory — every widget is visible to the bench');

const widgets = inventory();
const byId = Object.fromEntries(widgets.map((w) => [w.id, w]));

check('at least the original HUD set is present', widgets.length >= 10, `${widgets.length} widgets`);
for (const id of ['pedals', 'pedalsv', 'motion', 'radar', 'speedo', 'standings', 'relative', 'trackmap']) {
  check(`${id} is inventoried`, !!byId[id]);
}

check('pedals is full-rate', byId.pedals && byId.pedals.throttleMs === 0);
check('pedalsv is full-rate', byId.pedalsv && byId.pedalsv.throttleMs === 0);
check('motion is full-rate', byId.motion && byId.motion.throttleMs === 0);
check('radar is full-rate', byId.radar && byId.radar.throttleMs === 0);
check('speedo is full-rate', byId.speedo && byId.speedo.throttleMs === 0);
check('standings is throttled', byId.standings && byId.standings.throttleMs > 0, byId.standings && byId.standings.throttleMs);
check('trackmap is throttled', byId.trackmap && byId.trackmap.throttleMs > 0, byId.trackmap && byId.trackmap.throttleMs);

const fullRate = widgets.filter((w) => w.fullRate).map((w) => w.id).sort();
check(
  'the 30 Hz set is the five instruments, not the whole HUD',
  fullRate.join(',') === 'motion,pedals,pedalsv,radar,speedo',
  fullRate.join(','),
);

console.log('\nfield expansion — a 6-hour grid is representable');

{
  const provider = loadSimulator();
  provider.start();
  let frame = null;
  let t = 1_000_000;
  for (let i = 0; i < 20; i++) {
    t += 1000 / 30;
    frame = provider.poll(t, 1000 / 30);
  }
  provider.stop();

  check('simulator produces a frame', !!(frame && frame.standings && frame.standings.length));
  const demoN = frame.standings.length;
  check('demo field is the documented 12', demoN === 12, demoN);

  const big = expandField(frame, 62);
  check('62-car standings', big.standings.length === 62, big.standings.length);
  check('62-car session.numCars', big.session.numCars === 62, big.session.numCars);
  if (frame.trackMap && frame.trackMap.cars) {
    check('62-car track map', big.trackMap.cars.length === 62, big.trackMap.cars.length);
  }
  const json = JSON.stringify(big);
  check('expanded frame stringifies', json.length > 1000, json.length);
  check('parse round-trips standings', JSON.parse(json).standings.length === 62);
}

console.log('\nstats + budget — the rulers the bench uses');

{
  const s = statsOf([1, 2, 3, 4, 5]);
  check('stats.n', s.n === 5);
  check('stats.min', s.min === 1);
  check('stats.max', s.max === 5);
  check('stats.mean', Math.abs(s.mean - 3) < 1e-9, s.mean);
  check('30 Hz budget is ~33.3 ms', Math.abs(budgetMs(DEFAULT_HZ) - 1000 / 30) < 1e-9);
  check('60 Hz budget is half of that', Math.abs(budgetMs(60) - 1000 / 60) < 1e-9);
}

console.log('\nassessment — verdict ids the report is built on');

{
  const fakeP = {
    pollBench: {
      combinedMean: 0.4,
      payload: { bytes: 12_000 },
    },
    fields: [{ cars: 62, bytes: 40_000 }],
    cadence: { loaded30: { deliveredHz: 29.8, late: 0 } },
  };
  const fakeW = {
    fullRate: ['motion', 'pedals', 'pedalsv', 'radar', 'speedo'],
    originally: ['pedals'],
    load30: { canvasUps: 150 },
    load60: { canvasUps: 300 },
  };
  const notes = assess(fakeP, fakeW);
  const ids = notes.map((n) => n.id);
  for (const id of ['hz-budget', 'payload', 'full-rate', 'cadence', 'ingame-gpu', 'recommendation']) {
    check(`verdict "${id}"`, ids.includes(id));
  }
  check('does not recommend raising Hz', /do not raise Hz/.test(notes.find((n) => n.id === 'recommendation').verdict));
}

console.log('\nsuite files exist');

{
  const root = path.join(__dirname);
  for (const f of [
    'bench.js',
    'bench-pipeline.js',
    'bench-widgets.js',
    'bench-subsystems.js',
    'lib/bench-util.js',
  ]) {
    check(f, fs.existsSync(path.join(root, f)));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
