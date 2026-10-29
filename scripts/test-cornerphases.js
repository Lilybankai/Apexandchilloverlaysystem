/**
 * scripts/test-cornerphases.js — the phase points of each corner on one lap.
 * -----------------------------------------------------------------------------
 * `cornerPhases.ts` finds where the brake went on and off, where the car
 * turned in, the apex, the throttle pick-up and full throttle, for every
 * corner of a lap. The coach's time split hangs on these points, and they
 * fail quietly — a turn-in that drifts 40 m, a pick-up placed in the next
 * corner — so:
 *
 *   §1 a synthetic circuit with one right answer per point, with the driven
 *      line and with lateral acceleration only;
 *   §2 real laps (Road Atlanta and Le Mans with a line, Laguna Seca v1
 *      without): road order, the latG heading against the line, and Le
 *      Mans's 13.6 m spacing interpolated rather than snapped to samples;
 *   §3 missing channels: nulls, never a throw.
 *
 * Run: npm run test:cornerphases
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  phasePoints,
  headingFromLatG,
  curvatureOf,
  prepareLap,
  lapTimeAt,
} = require('../dist/telemetry/cornerPhases');
const { findCorners } = require('../dist/telemetry/corners');

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

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const m = (d, L) => (d === null ? 'null' : Math.round(d * L));

/* ------------------------------ a synthetic lap --------------------------- */

/**
 * Straights and arcs sampled every 5 m (as test-corners.js). Speed is the
 * lowest of V-shaped profiles (0.5 km/h per metre either side of each apex)
 * capped at 250; brake on while slowing, throttle on while speeding up or at
 * the cap; latG is v²/r in g, signed like the heading.
 */
function buildLap(segments) {
  const STEP = 5;
  const VMAX = 250;
  const pts = [];
  const apexes = [];
  const arcs = []; // [s0, s1, signed curvature]
  let x = 0;
  let z = 0;
  let h = 0;
  let s = 0;
  for (const seg of segments) {
    const len = seg.arc ? (seg.r * seg.deg * Math.PI) / 180 : seg.len;
    if (seg.arc) {
      arcs.push([s, s + len, seg.dir / seg.r]);
      if (seg.vmin) apexes.push([s + len / 2, seg.vmin]);
    }
    const n = Math.max(1, Math.round(len / STEP));
    for (let i = 0; i < n; i++) {
      pts.push({ s, x, z });
      const ds = len / n;
      if (seg.arc) h += (seg.dir * ds) / seg.r;
      x += Math.cos(h) * ds;
      z += Math.sin(h) * ds;
      s += ds;
    }
  }
  pts.push({ s, x, z });
  const L = s;
  const vAt = (ss) => Math.min(VMAX, ...apexes.map(([a, v]) => v + 0.5 * Math.abs(ss - a)));
  const kAt = (ss) => {
    for (const [a, b, k] of arcs) if (ss >= a && ss < b) return k;
    return 0;
  };
  const tr = { d: [], t: [], speedKph: [], brake: [], throttle: [], latG: [], x: [], z: [] };
  let t = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const v = vAt(p.s);
    const vNext = vAt(p.s + 1);
    if (i > 0) t += (p.s - pts[i - 1].s) / (((v + vAt(pts[i - 1].s)) / 2) / 3.6);
    tr.d.push(p.s / L);
    tr.t.push(t);
    tr.speedKph.push(v);
    tr.brake.push(vNext < v ? 0.8 : 0);
    tr.throttle.push(vNext > v || v >= VMAX ? 1 : 0);
    tr.latG.push(((v / 3.6) ** 2 * kAt(p.s)) / 9.80665);
    tr.x.push(p.x);
    tr.z.push(p.z);
  }
  return { tr, L, arcs, apexes };
}

const LAYOUT = [
  { len: 500 },
  { arc: true, r: 50, deg: 90, dir: 1, vmin: 100 }, //  C1: a slow left
  { len: 600 },
  { arc: true, r: 30, deg: 120, dir: -1, vmin: 70 }, // C2: a hairpin right
  { len: 500 },
  { arc: true, r: 250, deg: 40, dir: 1 }, //             C3: a fast left, flat
  { len: 400 },
];

console.log('\n1) A synthetic circuit with one right answer per point');
{
  const { tr, L, arcs, apexes } = buildLap(LAYOUT);
  const cs = findCorners(tr, L);
  check('three corners found', cs.length === 3, cs.length);
  const pts = phasePoints(tr, cs, L);
  const [c1, c2, c3] = pts;

  // Braking starts where the V profile leaves 250 km/h: (250 − vmin) / 0.5 m before the apex.
  const brakeS = (k) => apexes[k][0] - (250 - apexes[k][1]) / 0.5;
  check('C1 brake onset where the speed starts to fall (±6 m)', Math.abs(c1.brakeOnD * L - brakeS(0)) < 6, `${m(c1.brakeOnD, L)} vs ${brakeS(0).toFixed(0)}`);
  check('C2 brake onset (±6 m)', Math.abs(c2.brakeOnD * L - brakeS(1)) < 6, `${m(c2.brakeOnD, L)} vs ${brakeS(1).toFixed(0)}`);
  check('C1 brake released at the apex (±6 m)', Math.abs(c1.brakeOffD * L - apexes[0][0]) < 6, `${m(c1.brakeOffD, L)} vs ${apexes[0][0].toFixed(0)}`);
  check('C1 turn-in at the start of the arc (±10 m)', Math.abs(c1.turnInD * L - arcs[0][0]) < 10, `${m(c1.turnInD, L)} vs ${arcs[0][0].toFixed(0)}`);
  check('C2 turn-in at the start of the hairpin (±10 m)', Math.abs(c2.turnInD * L - arcs[1][0]) < 10, `${m(c2.turnInD, L)} vs ${arcs[1][0].toFixed(0)}`);
  check('C1 apex at the speed minimum (±3 m)', Math.abs(c1.apexD * L - apexes[0][0]) < 3, `${m(c1.apexD, L)} vs ${apexes[0][0].toFixed(0)}`);
  check('C1 min speed 100 km/h (±1)', Math.abs(c1.minKph - 100) <= 1, c1.minKph);
  check('C1 pick-up and full throttle at the apex (±6 m)', Math.abs(c1.pickupD * L - apexes[0][0]) < 6 && Math.abs(c1.fullThrottleD * L - apexes[0][0]) < 6, `${m(c1.pickupD, L)} / ${m(c1.fullThrottleD, L)}`);
  check('C1 top speed on the straight after it is the 250 cap', c1.topKph === 250, c1.topKph);
  check('C1 entry speed: braking from 250', Math.abs(c1.entryKph - 250) < 1, c1.entryKph);
  check('C3 (flat) has no braking point', c3.brakeOnD === null && c3.brakeOffD === null);
  check('C3 (flat) still has a turn-in, inside the arc start ±10 m', c3.turnInD !== null && Math.abs(c3.turnInD * L - arcs[2][0]) < 10, m(c3.turnInD, L));

  // The same lap with no line: curvature from latG.
  const noLine = { ...tr };
  delete noLine.x;
  delete noLine.z;
  const pl = phasePoints(noLine, cs, L);
  check('latG-only: the same turn-ins within 3 m', pl.every((p, k) => p.turnInD !== null && Math.abs(p.turnInD - pts[k].turnInD) * L < 3), pl.map((p) => m(p.turnInD, L)).join(','));
  const th = headingFromLatG(tr, L);
  const turned = ((th[th.length - 1] - th[0]) * 180) / Math.PI;
  check('latG heading turns 90 − 120 + 40 = 10° over the lap (±8° of 250° turned)', Math.abs(turned - 10) < 8, turned.toFixed(2));
  check('curvatureOf names its source', curvatureOf(tr, L).source === 'line' && curvatureOf(noLine, L).source === 'latG');

  // The lap clock: 0 at the line, the whole lap at d = 1.
  const p = prepareLap(tr, L);
  check('lap clock reads 0 at d = 0', Math.abs(lapTimeAt(p, 0)) < 1e-9);
  check('lap clock reads the lap at d = 1', Math.abs(lapTimeAt(p, 1) - tr.t[tr.t.length - 1]) < 1e-6, lapTimeAt(p, 1).toFixed(3));
}

console.log('\n2) Real laps');
for (const [name, label] of [
  ['trace-road-atlanta-gt3.json', 'Road Atlanta'],
  ['trace-le-mans-lmp2-ref.json', 'Le Mans LMP2'],
  ['trace-laguna-seca-gt3-v1.json', 'Laguna Seca v1'],
]) {
  const f = fixture(name);
  const L = f.trackLengthM;
  const tr = f.trace;
  const cs = findCorners(tr, L);
  const pts = phasePoints(tr, cs, L);
  check(`${label}: one set of points per corner`, pts.length === cs.length && cs.length >= 8, `${cs.length} corners`);
  let ordered = true;
  let why = '';
  pts.forEach((p, k) => {
    const c = cs[k];
    if (p.brakeOnD !== null && p.brakeOffD !== null && !(p.brakeOnD < p.brakeOffD)) {
      ordered = false;
      why = `C${k + 1} brake`;
    }
    if (p.brakeOnD !== null && (p.brakeOnD < c.entryD - 100 / L - 1e-9 || p.brakeOnD > c.apexD)) {
      ordered = false;
      why = `C${k + 1} brake window`;
    }
    if (p.turnInD !== null && !(p.turnInD <= p.apexD)) {
      ordered = false;
      why = `C${k + 1} turn-in after apex`;
    }
    if (p.pickupD !== null && p.fullThrottleD !== null && !(p.pickupD <= p.fullThrottleD)) {
      ordered = false;
      why = `C${k + 1} pickup after full`;
    }
    if (!(p.apexD >= c.entryD && p.apexD <= c.exitD)) {
      ordered = false;
      why = `C${k + 1} apex outside span`;
    }
  });
  check(`${label}: brake on < off, turn-in ≤ apex, pick-up ≤ full, apex in its span`, ordered, why);
  const withTurn = pts.filter((p) => p.turnInD !== null).length;
  check(`${label}: a turn-in for at least 80% of corners`, withTurn >= 0.8 * pts.length, `${withTurn}/${pts.length}`);
  const braked = pts.filter((p) => p.brakeOnD !== null).length;
  check(`${label}: braking points for the corners that brake`, braked >= 4, `${braked}`);
}

{
  // The latG heading against the line on a lap that has both.
  const f = fixture('trace-road-atlanta-gt3.json');
  const L = f.trackLengthM;
  const tr = f.trace;
  const cs = findCorners(tr, L);
  const a = phasePoints(tr, cs, L);
  const noLine = { ...tr };
  delete noLine.x;
  delete noLine.z;
  const b = phasePoints(noLine, cs, L);
  const errs = [];
  a.forEach((p, k) => {
    if (p.turnInD !== null && b[k].turnInD !== null) errs.push(Math.abs(p.turnInD - b[k].turnInD) * L);
  });
  errs.sort((x, y) => x - y);
  check('Road Atlanta: latG finds every line-based turn-in', errs.length === a.filter((p) => p.turnInD !== null).length, `${errs.length}`);
  check('Road Atlanta: latG turn-ins within 5 m of the line (median)', errs[errs.length >> 1] < 5, errs[errs.length >> 1].toFixed(1));
  const th = headingFromLatG(tr, L);
  const turned = ((th[th.length - 1] - th[0]) * 180) / Math.PI;
  check('Road Atlanta: latG heading closes the lap (one full turn, ±15%)', Math.abs(Math.abs(turned) - 360) < 54, turned.toFixed(0));

  // Dead-reckoned from latG, the line gives the same corners.
  const x = [0];
  const z = [0];
  for (let i = 1; i < th.length; i++) {
    const ds = (tr.d[i] - tr.d[i - 1]) * L;
    x.push(x[i - 1] + Math.cos(th[i]) * ds);
    z.push(z[i - 1] + Math.sin(th[i]) * ds);
  }
  const c2 = findCorners({ ...noLine, x, z }, L);
  const hit = cs.filter((c) => c2.some((q) => Math.abs(q.apexD - c.apexD) * L < 30)).length;
  check('Road Atlanta: a latG line finds ≥ 90% of the line-based apexes', hit >= 0.9 * cs.length, `${hit}/${cs.length}`);
}

{
  // Le Mans samples every ~13.6 m: points are interpolated, not sample distances.
  const f = fixture('trace-le-mans-lmp2-ref.json');
  const L = f.trackLengthM;
  const tr = f.trace;
  const pts = phasePoints(tr, findCorners(tr, L), L);
  const onSample = (d) => tr.d.some((s) => Math.abs(s - d) * L < 0.05);
  const brakes = pts.filter((p) => p.brakeOnD !== null);
  const snapped = brakes.filter((p) => onSample(p.brakeOnD)).length;
  check('Le Mans: braking points fall between samples, not on them', snapped <= brakes.length / 4, `${snapped}/${brakes.length} on a sample`);
  const turns = pts.filter((p) => p.turnInD !== null);
  const tSnapped = turns.filter((p) => onSample(p.turnInD)).length;
  check('Le Mans: turn-ins interpolated too', tSnapped <= turns.length / 4, `${tSnapped}/${turns.length} on a sample`);
}

console.log('\n3) Missing channels');
{
  const f = fixture('trace-road-atlanta-gt3.json');
  const L = f.trackLengthM;
  const cs = findCorners(f.trace, L);
  const bare = { d: f.trace.d, t: f.trace.t, speedKph: f.trace.speedKph };
  let pts;
  let threw = false;
  try {
    pts = phasePoints(bare, cs, L);
  } catch (e) {
    threw = true;
  }
  check('speed only: no throw', !threw);
  check('speed only: no braking, turn-in or throttle points', pts.every((p) => p.brakeOnD === null && p.turnInD === null && p.pickupD === null && p.fullThrottleD === null));
  check('speed only: apex and speeds still found', pts.every((p) => p.apexD !== null && p.minKph !== null));
  check('no columns at all: all-null points', phasePoints({ d: [], t: [], speedKph: [] }, cs, L).every((p) => p.apexD === null));
  check('headingFromLatG without latG: empty', headingFromLatG({ d: [0, 1], speedKph: [1, 1] }, L).length === 0);
  check('no track length: all-null points', phasePoints(f.trace, cs, 0).every((p) => p.apexD === null));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
