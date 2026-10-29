/**
 * scripts/test-showsteps.js — what "Show me" draws for a lap's worst corners.
 * -----------------------------------------------------------------------------
 * `showSteps.ts` picks the corners to walk the driver through and decides the
 * marks, the arrow and the words. The renderer trusts it blindly, so:
 *
 *   §1 a synthetic lap with a braking point planted 20 m early: the step must
 *      say "Brake 20 m later", with the arrow from the driver's point to the
 *      reference's;
 *   §2 real pairs: worst corner first, at most `top`, windows that cover the
 *      corner, marks for both laps (with x/z on a lap with a line, without on
 *      v1), arrows and words in the agreed vocabulary;
 *   §3 what must NOT be a step: a self-compare, a corner whose loss is all a
 *      tow, an empty breakdown.
 *
 * Run: npm run test:showsteps
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { showSteps, driverLoss } = require('../dist/telemetry/showSteps');
const { lapLoss } = require('../dist/telemetry/timeLoss');
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
const ARROW_WORDS = /^(Brake|Release the brake|Turn in|Back on the throttle|Flat) \d+ m (later|earlier)$/;

/* ------------------------------ a synthetic lap --------------------------- */

/**
 * Straights and arcs every 5 m; speed is the lowest V profile (0.5 km/h per
 * metre of braking, 0.5 of acceleration) capped at 250, clock integrated from
 * speed. `early` brakes that many metres sooner for the corner at `earlyAt`
 * (a longer, gentler zone to the same apex speed).
 */
function buildLap(segments, early = 0, earlyApex = -1) {
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
  const vAt = (ss) =>
    Math.min(
      VMAX,
      ...apexes.map(([a, v], k) => {
        if (ss >= a) return v + 0.5 * (ss - a);
        const zone = (VMAX - v) / 0.5;
        const len = k === earlyApex ? zone + early : zone;
        return v + ((VMAX - v) * (a - ss)) / len;
      }),
    );
  const tr = { d: [], t: [], speedKph: [], brake: [], throttle: [], latG: [], x: [], z: [] };
  let t = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const v = vAt(p.s);
    if (i > 0) t += (p.s - pts[i - 1].s) / (((v + vAt(pts[i - 1].s)) / 2) / 3.6);
    const slowing = vAt(p.s + 1) < v;
    tr.d.push(p.s / L);
    tr.t.push(t);
    tr.speedKph.push(v);
    tr.brake.push(slowing ? 0.8 : 0);
    tr.throttle.push(slowing ? 0 : 1);
    tr.latG.push(0);
    tr.x.push(p.x);
    tr.z.push(p.z);
  }
  return { tr, L };
}

const LAYOUT = [
  { len: 600 },
  { arc: true, r: 50, deg: 90, dir: 1, vmin: 100 },
  { len: 800 },
  { arc: true, r: 30, deg: 120, dir: -1, vmin: 70 },
  { len: 600 },
];

console.log('\n1) A braking point planted 20 m early');
{
  const ref = buildLap(LAYOUT);
  const mine = buildLap(LAYOUT, 20, 1); // brakes 20 m early for C2
  const L = ref.L;
  const corners = findCorners(ref.tr, L).map((c, i) => ({ id: `C${i + 1}`, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
  const R = { lapId: 'r', lapSec: null, cols: ref.tr };
  const M = { lapId: 'm', lapSec: null, cols: mine.tr };
  const b = lapLoss(M, R, corners, L);
  const steps = showSteps(b, M, R);
  const s = steps[0];
  check('one step, for C2', steps.length === 1 && s.cornerId === 'C2', steps.map((x) => x.cornerId).join());
  check('the arrow says "Brake 20 m later"', s.arrows.length === 1 && s.arrows[0].label === 'Brake 20 m later', s.arrows.map((a) => a.label).join());
  const c2 = b.corners[1];
  check('the arrow runs from your brake point to the reference\'s', s.arrows[0].fromD === c2.mine.brakeOnD && s.arrows[0].toD === c2.ref.brakeOnD);
  check('the words name the corner, the loss and the phase', /^C2: 0\.\d\d s, most of it in the braking\. Brake 20 m later\.$/.test(s.text), s.text);
  check('the window covers your braking point and the reference\'s exit', s.window[0] < c2.mine.brakeOnD && s.window[1] > c2.exitD);
  const kinds = (who) => s.marks.filter((mk) => mk.who === who).map((mk) => mk.kind).join();
  check('marks for both laps: brake, turn-in, apex, throttle, full', kinds('you') === 'brake,turnin,apex,throttle,full' && kinds('ref') === kinds('you'), `${kinds('you')} / ${kinds('ref')}`);
  check('marks carry x/z on a lap with a line', s.marks.every((mk) => typeof mk.x === 'number' && typeof mk.z === 'number'));
  const ap = s.marks.find((mk) => mk.kind === 'apex' && mk.who === 'ref');
  check('the apex mark is labelled with its speed (70 km/h, between samples)', /^7[01] km\/h$/.test(ap.label), ap.label);
  check('the track length can be passed instead of read off the breakdown', showSteps({ ...b, trackLengthM: undefined }, M, R, 3, L).length === 1);
  check('…and without either there is nothing to draw', showSteps({ ...b, trackLengthM: undefined }, M, R).length === 0);
}

console.log('\n2) Real laps');
for (const [label, refName, mineName, lined] of [
  ['Road Atlanta GT3', 'trace-road-atlanta-gt3.json', 'trace-road-atlanta-gt3-slow.json', true],
  ['Le Mans LMP2', 'trace-le-mans-lmp2-ref.json', 'trace-le-mans-lmp2-slow.json', true],
  ['Laguna Seca v1', 'trace-laguna-seca-gt3-v1.json', 'trace-laguna-seca-gt3-v1-slow.json', false],
]) {
  const Rf = fixture(refName);
  const Mf = fixture(mineName);
  const L = Rf.trackLengthM;
  const corners = findCorners(Rf.trace, L).map((c, i) => ({ id: `C${i + 1}`, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
  const R = { lapId: Rf.lapId, lapSec: Rf.lapMs / 1000, cols: Rf.trace };
  const M = { lapId: Mf.lapId, lapSec: Mf.lapMs / 1000, cols: Mf.trace };
  const b = lapLoss(M, R, corners, L);
  const steps = showSteps(b, M, R);
  const byId = (id) => b.corners.find((c) => c.id === id);
  check(`${label}: three steps`, steps.length === 3, steps.map((s) => s.cornerId).join());
  const own = steps.map((s) => driverLoss(byId(s.cornerId)));
  check(`${label}: worst driver-owned loss first`, own.every((v, i) => i === 0 || v <= own[i - 1]) && own[0] === Math.max(...b.corners.map(driverLoss)), own.map((v) => v.toFixed(3)).join(' > '));
  check(`${label}: top = 1 gives one`, showSteps(b, M, R, 1).length === 1);
  check(`${label}: windows inside the lap and around the corner`, steps.every((s) => {
    const c = byId(s.cornerId);
    return s.window[0] >= 0 && s.window[1] <= 1 && s.window[0] < c.entryD && s.window[1] > c.exitD;
  }));
  check(`${label}: marks for both laps`, steps.every((s) => s.marks.some((mk) => mk.who === 'you') && s.marks.some((mk) => mk.who === 'ref')));
  const placed = steps.every((s) => s.marks.every((mk) => (lined ? typeof mk.x === 'number' && typeof mk.z === 'number' : mk.x === undefined && mk.z === undefined)));
  check(`${label}: ${lined ? 'x/z on every mark' : 'no x/z without a line'}`, placed);
  const arrows = steps.flatMap((s) => s.arrows);
  check(`${label}: arrows in the agreed words`, arrows.length >= 1 && arrows.every((a) => ARROW_WORDS.test(a.label)), arrows.map((a) => a.label).join(' | '));
  check(`${label}: words start with the corner and its loss`, steps.every((s) => s.text.startsWith(`${s.cornerId}: `) && / s, most of it in /.test(s.text)));
  for (const s of steps) console.log(`        ${s.text}`);
}

console.log('\n3) What is not a step');
{
  const Rf = fixture('trace-road-atlanta-gt3.json');
  const L = Rf.trackLengthM;
  const corners = findCorners(Rf.trace, L).map((c, i) => ({ id: `C${i + 1}`, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
  const R = { lapId: Rf.lapId, lapSec: Rf.lapMs / 1000, cols: Rf.trace };
  const self = lapLoss(R, R, corners, L);
  check('a self-compare: no steps', showSteps(self, R, R).length === 0);

  // A corner whose whole loss is a tow on the straight after it.
  const Mf = fixture('trace-road-atlanta-gt3-slow.json');
  const M = { lapId: Mf.lapId, lapSec: Mf.lapMs / 1000, cols: Mf.trace };
  const b = lapLoss(M, R, corners, L);
  const worst = b.corners.slice().sort((x, y) => y.lossSec - x.lossSec)[0];
  const towed = { ...b, corners: b.corners.map((c) => (c === worst ? { ...c, straightFlag: 'tow', straightSec: c.lossSec } : c)) };
  const steps = showSteps(towed, M, R, 10);
  check('a corner lost entirely to a tow is never a step', !steps.some((s) => s.cornerId === worst.id), worst.id);
  const partly = { ...b, corners: b.corners.map((c) => (c === worst ? { ...c, straightFlag: 'car', straightSec: 0.05 } : c)) };
  const ps = showSteps(partly, M, R, 10).find((s) => s.cornerId === worst.id);
  check('a partly-towed corner says so in its words', ps && /straight-line speed for the reference, not driving\.$/.test(ps.text), ps && ps.text);
  check('an empty breakdown: no steps', showSteps({ corners: [] }, M, R).length === 0);
  check('top = 0: no steps', showSteps(b, M, R, 0).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
