/**
 * scripts/test-timeloss.js — a lap against a reference, per corner and phase.
 * -----------------------------------------------------------------------------
 * `timeLoss.lapLoss` is only worth anything if its seconds add up and land in
 * the right place. So:
 *
 *   §1 a synthetic lap with time planted in one phase at a time (it must be
 *      found there and nowhere else), and straights with a growing, a
 *      collapsing and a decaying speed gap (tow / car / slow exit);
 *   §2 real lap pairs — Road Atlanta and Le Mans with a line, Laguna Seca v1
 *      without — pinned to the invariants: phases sum to the corner, lead-in
 *      plus corners sum to the lap, a self-compare is zero, the residual
 *      against official timing is small, missing channels still add up;
 *   §3 a whole session (40 laps of Le Mans) in well under a second.
 *
 * Run: npm run test:timeloss
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { lapLoss, phaseBoundaries } = require('../dist/telemetry/timeLoss');
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
const PHASES = ['braking', 'turnIn', 'midCorner', 'exit', 'exitRun'];
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const f3 = (v) => (v === null || v === undefined ? 'null' : v.toFixed(3));

/** Invariants every breakdown must keep; returns the first broken one, or ''. */
function broken(b) {
  for (const c of b.corners) {
    const ph = sum(PHASES.map((p) => c.phases[p]));
    if (Math.abs(ph - c.lossSec) > 1e-9) return `${c.id}: phases ${ph} ≠ loss ${c.lossSec}`;
    if (!(c.entryD <= c.apexD && c.apexD <= c.exitD && c.exitD <= c.runEndD)) return `${c.id}: boundaries out of order`;
  }
  const tot = b.leadInSec + sum(b.corners.map((c) => c.lossSec));
  if (Math.abs(tot - b.totalSec) > 1e-9) return `lead-in + corners ${tot} ≠ total ${b.totalSec}`;
  for (let k = 0; k + 1 < b.corners.length; k++) {
    if (Math.abs(b.corners[k].runEndD - b.corners[k + 1].entryD) > 1e-12) return `${b.corners[k].id}: run does not end at the next entry`;
  }
  if (b.corners.length && b.corners[b.corners.length - 1].runEndD !== 1) return 'last corner run does not end at d = 1';
  return '';
}

/* ------------------------------ a synthetic lap --------------------------- */

/**
 * Straights and arcs every 5 m; speed is the lowest V profile (0.5 km/h per
 * metre either side of each apex) capped at 250, then `def(s)` km/h taken off
 * (a slower car on a straight), and the clock integrated from that speed so
 * the lap is self-consistent. Brake while slowing, throttle otherwise.
 */
function buildLap(segments, def = () => 0) {
  const STEP = 5;
  const VMAX = 250;
  const pts = [];
  const apexes = [];
  let x = 0;
  let z = 0;
  let h = 0;
  let s = 0;
  for (const seg of segments) {
    const len = seg.arc ? (seg.r * seg.deg * Math.PI) / 180 : seg.len;
    if (seg.arc && seg.vmin) apexes.push([s + len / 2, seg.vmin]);
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
  const vBase = (ss) => Math.min(VMAX, ...apexes.map(([a, v]) => v + 0.5 * Math.abs(ss - a)));
  const vAt = (ss) => vBase(ss) - def(ss);
  const tr = { d: [], t: [], speedKph: [], brake: [], throttle: [], x: [], z: [] };
  let t = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const v = vAt(p.s);
    if (i > 0) t += (p.s - pts[i - 1].s) / (((v + vAt(pts[i - 1].s)) / 2) / 3.6);
    tr.d.push(p.s / L);
    tr.t.push(t);
    tr.speedKph.push(v);
    const slowing = vBase(p.s + 1) < vBase(p.s);
    tr.brake.push(slowing ? 0.8 : 0);
    tr.throttle.push(slowing ? 0 : 1);
    tr.x.push(p.x);
    tr.z.push(p.z);
  }
  return { tr, L, apexes };
}

const LAYOUT = [
  { len: 500 },
  { arc: true, r: 50, deg: 90, dir: 1, vmin: 100 }, //  C1
  { len: 1500 }, //                                     a long straight, flat from ~840 m
  { arc: true, r: 30, deg: 120, dir: -1, vmin: 70 }, // C2 (brakes from ~1750 m)
  { len: 500 },
  { arc: true, r: 250, deg: 40, dir: 1 }, //             C3, flat
  { len: 400 },
];

/** A lap's clock with `delay` seconds spread evenly over metres [a, b]. */
function delayed(tr, L, a, b, delay) {
  const t = tr.t.map((ti, i) => {
    const s = tr.d[i] * L;
    const f = s <= a ? 0 : s >= b ? 1 : (s - a) / (b - a);
    return ti + delay * f;
  });
  return { ...tr, t };
}

const lap = (id, tr) => ({ lapId: id, lapSec: null, cols: tr });

console.log('\n1) Planted losses on a synthetic lap');
{
  const ref = buildLap(LAYOUT);
  const { tr, L } = ref;
  const corners = findCorners(tr, L).map((c, i) => ({ id: `C${i + 1}`, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
  check('three corners', corners.length === 3);

  const self = lapLoss(lap('r', tr), lap('r', tr), corners, L);
  check('self-compare: every phase and the lap are exactly zero', self.totalSec === 0 && self.leadInSec === 0 && self.corners.every((c) => PHASES.every((p) => c.phases[p] === 0)));
  check('self-compare: invariants', broken(self) === '', broken(self));

  const b0 = self.corners;
  const at = (d) => d * L;
  const plant = (name, a, b, phase, k) => {
    const mine = delayed(tr, L, a, b, 0.25);
    const r = lapLoss(lap('m', mine), lap('r', tr), corners, L);
    const where = k === null ? r.leadInSec : r.corners[k].phases[phase];
    const rest = Math.abs(r.totalSec - where);
    check(`${name}: 0.25 s found there (±1 ms)`, Math.abs(where - 0.25) < 0.001, f3(where));
    check(`${name}: nothing anywhere else`, rest < 0.001, f3(rest));
    check(`${name}: invariants`, broken(r) === '', broken(r));
  };
  // Windows strictly inside each reference phase.
  const c1 = b0[0];
  const pb = phaseBoundaries(corners, self.corners.map((c) => c.ref));
  plant('lead-in', 100, at(c1.entryD) - 20, null, null);
  plant('C1 braking', at(pb[0].s) + 5, at(pb[0].e) - 5, 'braking', 0);
  plant('C1 exit run', at(pb[0].f) + 50, at(pb[0].r) - 50, 'exitRun', 0);
  plant('C2 braking', at(pb[1].s) + 5, at(pb[1].e) - 5, 'braking', 1);
  plant('C3 exit run', at(pb[2].f) + 20, at(pb[2].r) - 20, 'exitRun', 2);
  check('C3 (flat): no braking phase on the reference', c1 && self.corners[2].ref.brakeOnD === null && pb[2].s === pb[2].e);
  check('the last corner runs to the line (runEnd = 1)', self.corners[2].runEndD === 1);

  // Straight-line speed on C1's exit run (flat from ~840 m to ~1750 m).
  const tri = (a, peak, b, top) => (s) => (s <= a || s >= b ? 0 : s <= peak ? (top * (s - a)) / (peak - a) : (top * (b - s)) / (b - peak));
  const ramp = (a, b, top) => (s) => (s <= a ? 0 : s >= b ? 0 : (top * (s - a)) / (b - a));
  const cases = [
    ['a tow: the gap grows, then collapses', tri(900, 1450, 1700, 12), 'tow', 1],
    ['a faster car: the gap grows to the braking point', ramp(900, 1745, 12), 'car', 1],
    ['the studied lap had the tow (gap grows the other way)', tri(900, 1450, 1700, -12), 'tow', -1],
  ];
  for (const [name, def, flag, sign] of cases) {
    const mine = buildLap(LAYOUT, def).tr;
    const r = lapLoss(lap('m', mine), lap('r', tr), corners, L);
    const c = r.corners[0];
    check(`${name}: flagged '${flag}'`, c.straightFlag === flag, `${c.straightFlag} ${f3(c.straightSec)}`);
    check(`${name}: straightSec carries the exit run's sign and most of it`, Math.sign(c.straightSec) === sign && Math.abs(c.straightSec) >= 0.8 * Math.abs(c.phases.exitRun) && Math.abs(c.straightSec) <= Math.abs(c.phases.exitRun) + 1e-9, `${f3(c.straightSec)} of ${f3(c.phases.exitRun)}`);
    check(`${name}: still inside lossSec (invariants)`, broken(r) === '', broken(r));
  }
  {
    // A slow exit: 10 km/h down from mid-corner, the gap shrinking down the straight.
    const exitDef = (s) => (s < 450 || s > 1300 ? 0 : s <= 700 ? 10 : 10 * (1 - (s - 700) / 600));
    const mine = buildLap(LAYOUT, exitDef).tr;
    const r = lapLoss(lap('m', mine), lap('r', tr), corners, L);
    const c = r.corners[0];
    check('a slow exit (gap shrinking): not flagged, all the driver\'s', c.straightFlag === null && c.straightSec === 0 && c.phases.exitRun > 0.05, `${c.straightFlag} ${f3(c.straightSec)}; exit run ${f3(c.phases.exitRun)}; ${PHASES.map((p) => f3(c.phases[p])).join(' ')}`);
  }
}

console.log('\n2) Real laps');
const pairs = [
  ['Road Atlanta GT3', 'trace-road-atlanta-gt3.json', 'trace-road-atlanta-gt3-slow.json'],
  ['Le Mans LMP2', 'trace-le-mans-lmp2-ref.json', 'trace-le-mans-lmp2-slow.json'],
  ['Laguna Seca v1', 'trace-laguna-seca-gt3-v1.json', 'trace-laguna-seca-gt3-v1-slow.json'],
];
const real = {};
for (const [label, refName, mineName] of pairs) {
  const R = fixture(refName);
  const M = fixture(mineName);
  const L = R.trackLengthM;
  const corners = findCorners(R.trace, L).map((c, i) => ({ id: `C${i + 1}`, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
  const ref = { lapId: R.lapId, lapSec: R.lapMs / 1000, cols: R.trace };
  const mine = { lapId: M.lapId, lapSec: M.lapMs / 1000, cols: M.trace };
  const b = lapLoss(mine, ref, corners, L);
  real[label] = { b, R, M, L, corners, ref, mine };
  const official = (M.lapMs - R.lapMs) / 1000;
  check(`${label}: one entry per corner, ids kept, lap order`, b.corners.length === corners.length && b.corners.every((c, k) => c.id === `C${k + 1}` && c.index === k));
  check(`${label}: invariants (phases → corner → lap)`, broken(b) === '', broken(b));
  check(`${label}: total within 50 ms of the official delta`, Math.abs(b.totalSec - official) < 0.05, `${f3(b.totalSec)} vs ${f3(official)}`);
  check(`${label}: residual is official − total`, Math.abs(b.residualSec - (official - b.totalSec)) < 1e-9, f3(b.residualSec));
  check(`${label}: ids and track length carried`, b.lapId === M.lapId && b.refLapId === R.lapId && b.trackLengthM === L);
  const run = sum(b.corners.map((c) => c.phases.exitRun));
  check(`${label}: exit runs hold a real share of the loss`, Math.abs(run) > 0.1, `${f3(run)} of ${f3(b.totalSec)}`);
  const self = lapLoss(ref, ref, corners, L);
  check(`${label}: self-compare is zero, residual zero`, self.totalSec === 0 && self.residualSec === 0 && self.corners.every((c) => c.lossSec === 0 && c.straightFlag === null));
  const shuffled = lapLoss(mine, ref, corners.slice().reverse(), L);
  check(`${label}: corners in any order give the same answer`, shuffled.corners.map((c) => c.id).join() === b.corners.map((c) => c.id).join() && Math.abs(shuffled.totalSec - b.totalSec) < 1e-12);
}

{
  const { b, R, M, L, corners, ref, mine } = real['Road Atlanta GT3'];
  // Without a line (latG only) the turn-ins move but corner totals cannot.
  const strip = (tr) => {
    const c = { ...tr };
    delete c.x;
    delete c.z;
    return c;
  };
  const nb = lapLoss({ ...mine, cols: strip(M.trace) }, { ...ref, cols: strip(R.trace) }, corners, L);
  check('no line: every corner loses exactly the same', nb.corners.every((c, k) => Math.abs(c.lossSec - b.corners[k].lossSec) < 1e-9));
  check('no line: invariants', broken(nb) === '', broken(nb));
  // Speed only: no braking, throttle or curvature — still additive.
  const bare = (tr) => ({ d: tr.d, t: tr.t, speedKph: tr.speedKph });
  const sb = lapLoss({ ...mine, cols: bare(M.trace) }, { ...ref, cols: bare(R.trace) }, corners, L);
  check('speed only: invariants', broken(sb) === '', broken(sb));
  check('speed only: braking phases are zero, brake onsets null', sb.corners.every((c) => c.phases.braking === 0 && c.ref.brakeOnD === null && c.mine.brakeOnD === null));
  check('speed only: same lap total', Math.abs(sb.totalSec - b.totalSec) < 1e-9);
  // No corners: the whole lap is lead-in.
  const nc = lapLoss(mine, ref, [], L);
  check('no corners: the whole lap is lead-in', nc.corners.length === 0 && Math.abs(nc.leadInSec - b.totalSec) < 1e-9 && nc.totalSec === nc.leadInSec);
  // Unusable input.
  check('no track length: all zeros', lapLoss(mine, ref, corners, 0).totalSec === 0);
  check('empty columns: all zeros', lapLoss({ ...mine, cols: { d: [], t: [], speedKph: [] } }, ref, corners, L).corners.length === 0);
  // A flat kink: no braking on either lap.
  const kinks = b.corners.filter((c) => c.ref.brakeOnD === null);
  check('flat corners: braking phase 0', kinks.length > 0 && kinks.every((c) => c.phases.braking === 0), `${kinks.map((c) => c.id).join(',')}`);
}

console.log('\n3) A whole session in well under a second');
{
  const R = fixture('trace-le-mans-lmp2-ref.json');
  const M = fixture('trace-le-mans-lmp2-slow.json');
  const L = R.trackLengthM;
  const corners = findCorners(R.trace, L).map((c, i) => ({ id: `C${i + 1}`, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
  const ref = { lapId: R.lapId, lapSec: R.lapMs / 1000, cols: R.trace };
  // Fresh column objects per lap, so nothing is served from the per-lap cache.
  const laps = Array.from({ length: 40 }, (_, i) => ({ lapId: `m${i}`, lapSec: M.lapMs / 1000, cols: { ...M.trace } }));
  const t0 = process.hrtime.bigint();
  const out = laps.map((m) => lapLoss(m, { ...ref, cols: { ...R.trace } }, corners, L));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(`40 Le Mans laps × ${corners.length} corners under 1 s (fresh reference each time)`, ms < 1000, `${ms.toFixed(0)} ms`);
  check('and every one adds up', out.every((b) => broken(b) === ''));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
