/**
 * scripts/test-brakepoints.js — the server-side braking-point detector.
 * -----------------------------------------------------------------------------
 * `src/telemetry/brakePoints.ts` is a port of the detector the Review tab
 * draws its braking ticks with (`electron/control-panel/review-charts.js`).
 * Two copies of one rule drift, and a drift here is silent: Ghost HUD would
 * paint a braking board a few metres from where Review says the same lap
 * braked, and nothing would throw. So beyond the behaviour cases (the same
 * ones `test-reviewcharts.js` pins on the original), section 2 runs BOTH
 * copies over synthetic and real laps and requires identical answers.
 *
 * Run: npm run test:brakepoints
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { brakePoints, brakePointPairs } = require('../dist/telemetry/brakePoints');
const CHARTS = require(path.join(__dirname, '..', 'electron', 'control-panel', 'review-charts.js'));

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

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

// A 1000 m lap sampled every 5 m, with the brake on (0.8) over each [from, to].
const L = 1000;
function mk(onsets) {
  const d = [];
  const brake = [];
  const x = [];
  const z = [];
  for (let i = 0; i < 201; i++) {
    const m = i * 5;
    d.push(m / L);
    x.push(m);
    z.push(0);
    let b = 0;
    for (const [from, to] of onsets) if (m >= from && m <= to) b = 0.8;
    brake.push(b);
  }
  return { d, brake, x, z };
}

console.log('\n1) Behaviour — the cases review-charts.js is pinned on');
{
  const a = mk([[200, 260], [600, 640]]);
  a.brake[39] = 0;
  const pts = brakePoints(a, L);
  check('two zones, not three', pts.length === 2, pts.length);
  // 0 at 195 m, 0.8 at 200 m: the 0.12 crossing is 15% of the way — 195.75 m.
  check('the onset is where the brake crossed the threshold', Math.abs(pts[0].d * L - 195.75) < 0.5, pts[0].d * L);
  check('the onset carries a position when the lap has a line', pts[0].x !== null && Math.abs(pts[0].x - 195.75) < 0.5);
  check('the second onset is the second corner', Math.abs(pts[1].d * L - 595.75) < 0.5, pts[1].d * L);

  const ramp = mk([[600, 640]]);
  ramp.brake[40] = 0.06; // a touch under the ON threshold
  ramp.brake[41] = 0.3; //  on — the crossing is a quarter of the way
  ramp.brake[42] = 0.8;
  const rp = brakePoints(ramp, L);
  check('the onset is interpolated between samples', rp.length === 2 && Math.abs(rp[0].d * L - 201.25) < 0.5, rp[0] && rp[0].d * L);

  check('a 15 m lift inside a zone is the same zone', brakePoints(mk([[200, 230], [245, 260]]), L).length === 1);
  check('no brake channel, no points', brakePoints({ d: a.d, x: a.x, z: a.z }, L).length === 0);
  check('no line: still points, no position', brakePoints({ d: a.d, brake: a.brake }, L)[0].x === null);
  check('a null trace is no points, not a throw', brakePoints(null, L).length === 0);
  check('a line of the wrong length is not used', brakePoints({ d: a.d, brake: a.brake, x: [1], z: [1] }, L)[0].x === null);

  const b = mk([[190, 260]]);
  const pairs = brakePointPairs(a, b, L);
  check('one pair per zone of the studied lap', pairs.length === 2);
  check('paired to the same corner', pairs[0].theirs !== null && Math.abs(pairs[0].theirs.d * L - 185.75) < 0.5);
  check('the studied lap braked LATER, by ten metres', Math.abs(pairs[0].laterM - 10) < 2, pairs[0].laterM);
  check('a zone the other lap never braked for is kept unmatched', pairs[1].theirs === null && pairs[1].laterM === null);
  check('a zone 200 m away is not the same corner', brakePointPairs(a, mk([[400, 440]]), L)[0].theirs === null);
  check('the sign flips the other way round', brakePointPairs(b, a, L)[0].laterM < -8);
}

console.log('\n2) Parity — the port and the Review copy give the SAME answer');
{
  const synthetic = [
    mk([[200, 260], [600, 640]]),
    mk([[0, 40], [500, 520], [530, 560], [990, 1000]]),
    mk([]),
  ];
  const reals = ['trace-road-atlanta-gt3.json', 'trace-monza-gt3.json', 'trace-laguna-seca-gt3-v1.json'].map(fixture);
  let compared = 0;
  for (const tr of synthetic) {
    check(`synthetic lap ${compared}: identical points`, JSON.stringify(brakePoints(tr, L)) === JSON.stringify(CHARTS.brakePoints(tr, L)));
    compared++;
  }
  for (const f of reals) {
    const mine = brakePoints(f.trace, f.trackLengthM);
    const theirs = CHARTS.brakePoints(f.trace, f.trackLengthM);
    check(`${f.trackKey}: identical points (${mine.length})`, mine.length > 0 && JSON.stringify(mine) === JSON.stringify(theirs));
  }
  // Pairs against a copy of the same lap braking 8 m later everywhere.
  const f = reals[0];
  const shifted = Object.assign({}, f.trace, { d: f.trace.d.map((v) => v + 8 / f.trackLengthM) });
  const pm = brakePointPairs(shifted, f.trace, f.trackLengthM);
  const pc = CHARTS.brakePointPairs(shifted, f.trace, f.trackLengthM);
  check('pairs are identical too', JSON.stringify(pm) === JSON.stringify(pc));
  check('…and read the 8 m shift as 8 m later', pm.every((p) => p.laterM !== null && Math.abs(p.laterM - 8) < 0.01), pm.map((p) => p.laterM && p.laterM.toFixed(2)).join(','));
}

console.log('\n3) A real lap — Road Atlanta, GT3');
{
  const f = fixture('trace-road-atlanta-gt3.json');
  const pts = brakePoints(f.trace, f.trackLengthM);
  // T1, T3, T5, T6, T7 and T10a; everything else at Road Atlanta in a GT3 is
  // a lift or flat.
  check('six braking zones', pts.length === 6, pts.map((p) => Math.round(p.d * f.trackLengthM)).join(','));
  check('every one is placed on the line', pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)));
  check('in lap order, all inside the lap', pts.every((p, i) => p.d > 0 && p.d < 1 && (i === 0 || p.d > pts[i - 1].d)));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
