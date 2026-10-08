/**
 * scripts/test-corners.js — cutting a lap into corners, and scoring a live
 * lap through each one.
 * -----------------------------------------------------------------------------
 * Corner segmentation fails quietly: a chicane read as one corner, a lift for
 * traffic read as a corner, a corner window that overlaps the next so the
 * per-corner times no longer add up. None of it throws. So:
 *
 *   §1 builds a synthetic circuit with ONE right answer per feature — a slow
 *      corner, a hairpin, a fast bend taken flat, a straight-line lift, a
 *      chicane and a double apex — and checks each is read the way a driver
 *      would read it, with and without the driven line.
 *   §2 runs real laps from `scripts/fixtures/` (copied from a driver's own
 *      trace store) and checks the counts a driver would give, plus the
 *      invariants every corner list must keep.
 *   §3 scores a live lap against a reference with known, planted differences.
 *
 * Run: npm run test:corners
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  findCorners,
  cornerResult,
  cornerAt,
  cornersExited,
  MIN_SPEED_DROP_KPH,
} = require('../dist/telemetry/corners');

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

/* ------------------------------ a synthetic lap --------------------------- */

/**
 * Lay a lap out of straights and arcs, sampled every 5 m. Each arc may carry
 * an apex speed; speed is the lowest of the V-shaped profiles (0.5 km/h per
 * metre either side of each apex) capped at 250, which is a fair caricature
 * of braking in and driving out. The brake is on while slowing into an apex,
 * the throttle while speeding out of one or at the cap.
 */
function buildLap(segments, extraDips = []) {
  const STEP = 5;
  const VMAX = 250;
  const pts = [];
  const apexes = []; // [s, vmin]
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
  for (const dip of extraDips) apexes.push(dip);
  const vAt = (ss) => Math.min(VMAX, ...apexes.map(([a, v]) => v + 0.5 * Math.abs(ss - a)));
  const tr = { d: [], t: [], speedKph: [], brake: [], throttle: [], x: [], z: [] };
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
    tr.x.push(p.x);
    tr.z.push(p.z);
  }
  return { tr, L, apexes };
}

const LAYOUT = [
  { len: 400 }, //                                        (60 m clear of the line: a zone gap)
  { arc: true, r: 50, deg: 90, dir: 1, vmin: 100 }, //   C1: a slow left
  { len: 600 },
  { arc: true, r: 30, deg: 120, dir: -1, vmin: 70 }, //  C2: a hairpin right
  { len: 500 },
  { arc: true, r: 250, deg: 40, dir: 1 }, //              C3: a fast left, flat
  { len: 700 }, //                                        (a lift for traffic here)
  { arc: true, r: 40, deg: 45, dir: 1, vmin: 120 }, //   C4: chicane, left…
  { arc: true, r: 40, deg: 45, dir: -1, vmin: 125 }, //  C5: …then right
  { len: 300 },
  { arc: true, r: 60, deg: 60, dir: 1, vmin: 110 }, //   C6: a double apex…
  { len: 15 },
  { arc: true, r: 60, deg: 60, dir: 1, vmin: 110 }, //   …one corner
  { len: 300 },
];
// 300 m down the straight after C3, clear of both ends: a 30 km/h lift with
// no steering.
function liftAt() {
  let s = 0;
  for (const seg of LAYOUT.slice(0, 6)) s += seg.arc ? (seg.r * seg.deg * Math.PI) / 180 : seg.len;
  return s + 300;
}
const LIFT_S = liftAt();
const syn = buildLap(LAYOUT, [[LIFT_S, 220]]);

console.log('\n1) A synthetic circuit with one right answer per feature');
{
  const { tr, L } = syn;
  const cs = findCorners(tr, L);
  const at = (c) => Math.round(c.apexD * L);
  check('six corners with the line', cs.length === 6, cs.map(at).join(','));
  check('the straight-line lift is NOT a corner', cs.every((c) => Math.abs(c.apexD * L - LIFT_S) > 50));
  const apexS = (k) => {
    let s = 0;
    for (let i = 0; i < k; i++) s += LAYOUT[i].arc ? (LAYOUT[i].r * LAYOUT[i].deg * Math.PI) / 180 : LAYOUT[i].len;
    return s + (LAYOUT[k].r * LAYOUT[k].deg * Math.PI) / 360;
  };
  check('C1 apex at the arc middle (±5 m)', Math.abs(cs[0].apexD * L - apexS(1)) < 5, `${at(cs[0])} vs ${apexS(1).toFixed(0)}`);
  check('C1 apex speed refined to the true minimum', Math.abs(cs[0].minKph - 100) < 1.5, cs[0].minKph);
  check('C2 hairpin apex speed', Math.abs(cs[1].minKph - 70) < 1.5, cs[1].minKph);
  check('C1 entry is its braking point', cs[0].brakeD !== null && cs[0].entryD === cs[0].brakeD);
  check('C1 braking began ~300 m before its apex', Math.abs((cs[0].apexD - cs[0].entryD) * L - 300) < 10, ((cs[0].apexD - cs[0].entryD) * L).toFixed(1));
  check('C1 exit is the throttle back on, just past the apex', (cs[0].exitD - cs[0].apexD) * L > 0 && (cs[0].exitD - cs[0].apexD) * L < 10, ((cs[0].exitD - cs[0].apexD) * L).toFixed(1));
  check('C3, taken flat, is still a corner', Math.abs(cs[2].apexD * L - apexS(5)) < 40, `${at(cs[2])} vs ${apexS(5).toFixed(0)}`);
  check('…with no braking point', cs[2].brakeD === null);
  check('…and its turn is measured (~40°)', Math.abs(cs[2].turnDeg - 40) < 8, cs[2].turnDeg);
  check('a chicane is TWO corners', Math.abs(cs[3].apexD * L - apexS(7)) < 8 && Math.abs(cs[4].apexD * L - apexS(8)) < 8, `${at(cs[3])},${at(cs[4])}`);
  check('the chicane halves do not overlap', cs[3].exitD <= cs[4].entryD);
  check('a double apex is ONE corner', cs[5].turnDeg > 100, cs[5].turnDeg);
  check('apex positions come from the line', cs.every((c) => Number.isFinite(c.apexX) && Number.isFinite(c.apexZ)));

  // Without the line the same lap is read by speed alone: the lift becomes a
  // corner (nothing can tell it apart), the flat bend vanishes, and a chicane
  // too quick to climb out of between its halves is one dip.
  const bare = Object.assign({}, tr);
  delete bare.x;
  delete bare.z;
  const sp = findCorners(bare, L);
  check('speed-only: five corners', sp.length === 5, sp.map(at).join(','));
  check('speed-only: the lift IS a corner', sp.some((c) => Math.abs(c.apexD * L - LIFT_S) < 10));
  check('speed-only: no positions', sp.every((c) => c.apexX === null && c.turnDeg === null));
  check('speed-only: apexes ≥ 80 m apart (double apex merged)', sp.every((c, i) => i === 0 || (c.apexD - sp[i - 1].apexD) * L >= 80));

  // A dip smaller than the threshold is noise, not a corner.
  const small = buildLap([{ len: 1000 }], [[500, 250 - (MIN_SPEED_DROP_KPH - 2)]]);
  delete small.tr.x;
  delete small.tr.z;
  check(`a ${MIN_SPEED_DROP_KPH - 2} km/h dip is not a corner`, findCorners(small.tr, small.L).length === 0);

  check('no speed channel, no corners', findCorners({ d: tr.d }, L).length === 0);
  check('no length, no corners', findCorners(tr, 0).length === 0);
  check('null, no corners', findCorners(null, L).length === 0);
}

function invariants(name, cs, L, lined) {
  check(`${name}: entry < apex < exit for every corner`, cs.every((c) => c.entryD < c.apexD && c.apexD < c.exitD));
  check(`${name}: corners in lap order, never overlapping`, cs.every((c, i) => i === 0 || c.entryD >= cs[i - 1].exitD));
  check(`${name}: all inside the lap`, cs.every((c) => c.entryD >= 0 && c.exitD <= 1));
  check(`${name}: indices match the fractions`, cs.every((c) => c.entryI < c.apexI && c.apexI < c.exitI));
  if (lined) check(`${name}: every apex placed on the line`, cs.every((c) => Number.isFinite(c.apexX) && Number.isFinite(c.apexZ)));
  check(`${name}: plausible apex speeds`, cs.every((c) => c.minKph > 30 && c.minKph < 320), cs.map((c) => Math.round(c.minKph)).join(','));
}

console.log('\n2) Real laps');
{
  const ra = fixture('trace-road-atlanta-gt3.json');
  const cs = findCorners(ra.trace, ra.trackLengthM);
  const m = (c) => Math.round(c.apexD * ra.trackLengthM);
  // T1, T2, T3, T4/5, T6, T7, T10a, T10b, T11/12 and the run onto the straight:
  // what the line says. Speed minima alone found five.
  check('Road Atlanta GT3: 10 corners', cs.length === 10, cs.map(m).join(','));
  invariants('Road Atlanta', cs, ra.trackLengthM, true);
  check('Road Atlanta: T7 is the slowest corner, under 100 km/h', cs.reduce((a, c) => (c.minKph < a.minKph ? c : a)).minKph < 100);
  check('Road Atlanta: braked corners carry their braking point', cs.filter((c) => c.brakeD !== null).length >= 5);

  const mz = fixture('trace-monza-gt3.json');
  const mcs = findCorners(mz.trace, mz.trackLengthM);
  // Rettifilo (2), Curva Grande, Roggia (2), Lesmo 1, Lesmo 2, Ascari (3 →
  // its first two read as one by curvature), Parabolica.
  check('Monza GT3: 9–11 corners', mcs.length >= 9 && mcs.length <= 11, mcs.map((c) => Math.round(c.apexD * mz.trackLengthM)).join(','));
  invariants('Monza', mcs, mz.trackLengthM, true);
  check('Monza: the Rettifilo is the slowest corner', mcs[0].minKph < 80 || mcs[1].minKph < 80, `${mcs[0].minKph},${mcs[1].minKph}`);

  const lg = fixture('trace-laguna-seca-gt3-v1.json');
  check('the Laguna Seca fixture is a v1 lap with no line', !lg.trace.x);
  const lcs = findCorners(lg.trace, lg.trackLengthM);
  check('Laguna Seca GT3 (speed only): 8–10 corners', lcs.length >= 8 && lcs.length <= 10, lcs.map((c) => Math.round(c.apexD * lg.trackLengthM)).join(','));
  invariants('Laguna Seca', lcs, lg.trackLengthM, false);
  check('Laguna Seca: the Corkscrew region has a sub-110 km/h apex', lcs.some((c) => c.minKph < 110));
}

console.log('\n3) Scoring a live lap through each corner');
{
  const f = fixture('trace-road-atlanta-gt3.json');
  const L = f.trackLengthM;
  const ref = f.trace;
  const cs = findCorners(ref, L);

  const self = cs.map((c) => cornerResult(c, ref, ref, L));
  check('a lap against itself: zero time everywhere', self.every((r) => r.deltaSec === 0));
  check('…zero braking difference where it braked', self.every((r) => r.brakeDeltaM === null || r.brakeDeltaM === 0) && self.some((r) => r.brakeDeltaM === 0));
  check('…zero apex speed difference', self.every((r) => r.apexKphDelta === 0));

  // Plant 0.3 s lost at T7's apex: every sample past it is 0.3 s later. The
  // gap is then 0 at the entry and 0.3 at the exit, exactly.
  const k = 6;
  const c = cs[k];
  const slow = Object.assign({}, ref, {
    t: ref.t.map((t, i) => (i > c.apexI ? t + 0.3 : t)),
  });
  const r = cornerResult(c, ref, slow, L);
  check('0.3 s lost through T7 reads +0.3 s', Math.abs(r.deltaSec - 0.3) < 1e-3, r.deltaSec);
  check('the corner before is untouched', cornerResult(cs[k - 1], ref, slow, L).deltaSec === 0);
  check('the corner after is untouched (the offset cancels)', Math.abs(cornerResult(cs[k + 1], ref, slow, L).deltaSec) < 1e-3);

  // Brake two samples later everywhere: every braking difference is positive.
  const late = Object.assign({}, ref, { brake: ref.brake.map((_, i) => (i >= 2 ? ref.brake[i - 2] : 0)) });
  const lr = cs.map((cc) => cornerResult(cc, ref, late, L)).filter((x) => x.brakeDeltaM !== null);
  check('braking later reads POSITIVE metres', lr.length >= 5 && lr.every((x) => x.brakeDeltaM > 5 && x.brakeDeltaM < 20), lr.map((x) => x.brakeDeltaM).join(','));

  // 5% less speed through T7 only.
  const slower = Object.assign({}, ref, {
    speedKph: ref.speedKph.map((v, i) => (ref.d[i] >= c.entryD && ref.d[i] <= c.exitD ? v * 0.95 : v)),
  });
  const sr = cornerResult(c, ref, slower, L);
  check('less apex speed reads NEGATIVE', sr.apexKphDelta < 0 && Math.abs(sr.apexKphDelta + 0.05 * c.minKph) < 1, sr.apexKphDelta);

  // A live lap that has not reached the exit yet cannot be scored for time.
  const cut = c.apexD;
  const part = { d: ref.d.filter((d) => d <= cut), t: ref.t.filter((_, i) => ref.d[i] <= cut) };
  check('a lap that has not reached the exit: no time yet', cornerResult(c, ref, part, L).deltaSec === null);
  check('no brake or speed channels: those read null', (() => {
    const x = cornerResult(c, ref, part, L);
    return x.brakeDeltaM === null && x.apexKphDelta === null;
  })());

  check('cornerAt finds the corner a position is in', cornerAt(cs, c.apexD) === k);
  check('cornerAt is -1 on a straight', cornerAt(cs, (cs[6].exitD + cs[7].entryD) / 2) === -1);
  check('cornersExited fires as the exit is crossed', JSON.stringify(cornersExited(cs, c.exitD - 0.001, c.exitD + 0.001)) === JSON.stringify([k]));
  check('cornersExited is empty mid-corner', cornersExited(cs, c.apexD - 0.001, c.apexD).length === 0);
  check('cornersExited handles the line', cornersExited([{ exitD: 0.995 }, { exitD: 0.002 }, { exitD: 0.5 }], 0.99, 0.01).join(',') === '0,1');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
