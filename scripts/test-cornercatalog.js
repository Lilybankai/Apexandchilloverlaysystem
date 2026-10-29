/**
 * scripts/test-cornercatalog.js — stable corner numbers per layout.
 * -----------------------------------------------------------------------------
 * The corner catalogue exists so that "C5" is the same corner every session.
 * Every way that can go wrong is silent — a corner added on a rebuild shifts
 * every number after it, a snap that pairs the wrong apex names the wrong
 * bend, a surface that numbers by position disagrees with one that reads the
 * id — so:
 *
 *   §1 the loader: the shipped files load, a bad file is refused whole, and
 *      the async loader (the ghost's path) agrees with the sync one;
 *   §2 the shipped catalogues: valid, keyed by their file name, built from
 *      >= 8 laps, Road Atlanta 10 corners (what test-corners pins for one lap);
 *   §3 snapping real laps whose own counts differ (9, 10, 11) — every one
 *      comes back as the same ten ids at the same corners;
 *   §4 the pairing rule and the fallback without a catalogue;
 *   §5 the builder: dead-reckoned heading, sequences, and ids that stay put
 *      when the catalogue is rebuilt with extra laps;
 *   §6 the surfaces: practice review and lap rows, the ghost and /ghost.json,
 *      a snapshot's served corners, numbered as the driver saw them;
 *   §7 packaging: data/corners ships the way data/trackmaps does.
 *
 * Run: npm run test:cornercatalog
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadCornerCatalog,
  loadCornerCatalogAsync,
  catalogForTrack,
  cornersForLap,
  catalogCorners,
  snapToCatalog,
  builtinCornerCatalogDir,
  resetCornerCatalogCache,
  SNAP_M,
} = require('../dist/telemetry/cornerCatalog');
const { findCorners } = require('../dist/telemetry/corners');
const { buildPracticeReview } = require('../dist/telemetry/practiceReview');
const { cornerRows } = require('../dist/telemetry/practiceLap');
const { ghostFromTrace, ghostJson, applyCornerCatalog } = require('../dist/telemetry/ghostLap');
const builder = require('./build-corner-catalog.js');

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

const ROOT = path.join(__dirname, '..');
const RA_KEY = 'michelin-raceway-road-atlanta-4080';
const FX = require('./fixtures/corner-catalog-road-atlanta.json');
const L = FX.trackLengthM;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-cornercat-'));

/** The invariants every corner list must keep. */
function wellFormed(cs) {
  return cs.every(
    (c, i) =>
      c.entryD < c.apexD &&
      c.apexD < c.exitD &&
      c.entryD >= 0 &&
      c.exitD <= 1 &&
      (i === 0 || c.entryD >= cs[i - 1].exitD),
  );
}
const idsInOrder = (cs) => cs.every((c, i) => c.id === `C${i + 1}`);
const m = (d) => Math.round(d * L);

/* --------------------------------- §1 ------------------------------------ */

console.log('\n§1 the loader');
const RA = loadCornerCatalog(RA_KEY);
{
  check('Road Atlanta loads from the shipped directory', !!RA && RA.mapKey === RA_KEY);
  check('…from <repo>/data/corners in a clone', builtinCornerCatalogDir() === path.join(ROOT, 'data', 'corners'), builtinCornerCatalogDir());
  check('a layout with no catalogue → null', loadCornerCatalog('nowhere-1234') === null);
  check('an empty key → null', loadCornerCatalog('') === null);
  check('catalogForTrack finds it by the lap\'s own name and length', catalogForTrack({ track: 'Michelin Raceway Road Atlanta', trackLengthM: 4083.4 }) !== null);
  check('…and a zero length finds nothing', catalogForTrack({ track: 'Michelin Raceway Road Atlanta', trackLengthM: 0 }) === null);

  const good = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'corners', `${RA_KEY}.json`), 'utf8'));
  const write = (name, mut) => {
    const c = JSON.parse(JSON.stringify(good));
    mut(c);
    fs.writeFileSync(path.join(tmp, `${name}.json`), JSON.stringify({ ...c, mapKey: name }));
  };
  write('ok-1', () => undefined);
  write('ids-out-of-order', (c) => { c.corners[1].id = 'C3'; });
  write('inside-out', (c) => { c.corners[2].exitD = c.corners[2].entryD; });
  write('overlap', (c) => { c.corners[3].entryD = c.corners[2].apexD; });
  write('bad-dir', (c) => { c.corners[0].dir = 'up'; });
  write('no-corners', (c) => { c.corners = []; });
  fs.writeFileSync(path.join(tmp, 'torn.json'), '{"mapKey":"torn","corn');
  fs.writeFileSync(path.join(tmp, 'other-key.json'), JSON.stringify(good));
  check('a valid file in a named directory loads', loadCornerCatalog('ok-1', tmp) !== null);
  for (const bad of ['ids-out-of-order', 'inside-out', 'overlap', 'bad-dir', 'no-corners', 'torn']) {
    check(`refused whole: ${bad}`, loadCornerCatalog(bad, tmp) === null);
  }
  check('refused: a file whose mapKey is another layout\'s', loadCornerCatalog('other-key', tmp) === null);
}

/* --------------------------------- §2 ------------------------------------ */

console.log('\n§2 the shipped catalogues');
const shipped = fs.readdirSync(path.join(ROOT, 'data', 'corners')).filter((f) => f.endsWith('.json'));
{
  check('at least a dozen layouts ship a catalogue', shipped.length >= 12, shipped.length);
  const bad = [];
  for (const f of shipped) {
    const key = f.slice(0, -5);
    const c = loadCornerCatalog(key);
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'corners', f), 'utf8'));
    if (!c) bad.push(`${key}: refused by the loader`);
    else if (!wellFormed(c.corners) || !idsInOrder(c.corners)) bad.push(`${key}: malformed`);
    else if (!(c.builtFrom >= 8)) bad.push(`${key}: only ${c.builtFrom} laps`);
    else if (!raw.built || !/^\d{4}-\d{2}-\d{2}$/.test(raw.built.at) || raw.built.laps !== c.builtFrom) bad.push(`${key}: no build note`);
    else if (!c.corners.every((k) => k.dir === 'L' || k.dir === 'R')) bad.push(`${key}: a corner with no direction`);
    else {
      const ids = new Set(c.corners.map((k) => k.id));
      for (const s of c.sequences) {
        if (!(s.cornerIds.length >= 2) || !s.cornerIds.every((id) => ids.has(id))) bad.push(`${key}: sequence ${s.id}`);
        if (s.kind !== (s.cornerIds.length >= 3 ? 'complex' : 'chicane')) bad.push(`${key}: sequence ${s.id} kind`);
        if (!s.cornerIds.every((id) => c.corners.find((k) => k.id === id).seq === s.id)) bad.push(`${key}: seq back-links`);
      }
    }
  }
  check('every shipped file is valid, keyed by its name, ≥ 8 laps, with a build note', bad.length === 0, bad.join('; '));
  check('Road Atlanta: 10 corners (test-corners pins 10 for one good lap)', RA.corners.length === 10, RA.corners.length);
  check('Road Atlanta: T1 is a right-hander, the esses alternate R-L-R', RA.corners[0].dir === 'R' && RA.corners[1].dir === 'R' && RA.corners[2].dir === 'L' && RA.corners[3].dir === 'R');
  const lm = loadCornerCatalog('circuit-de-la-sarthe-13620');
  check('Le Mans: 19–23 corners, one number each', !!lm && lm.corners.length >= 19 && lm.corners.length <= 23, lm && lm.corners.length);
  check('Le Mans: the Porsche Curves are one complex', !!lm && lm.sequences.some((s) => s.kind === 'complex' && s.cornerIds.length >= 4));
  const dy = loadCornerCatalog('daytona-international-speedway-road-course-5730');
  check('Daytona: the banking is not a corner (7 corners)', !!dy && dy.corners.length === 7, dy && dy.corners.length);
}

/* --------------------------------- §3 ------------------------------------ */

console.log('\n§3 real laps snapped onto the catalogue');
{
  const own = FX.laps.map((l) => l.ownCorners);
  check('the fixture laps disagree on their own (9, 10 and 11 corners)', own.includes(9) && own.includes(10) && own.includes(11), own.join(','));
  const apexes = [];
  for (const [i, lap] of FX.laps.entries()) {
    const cs = catalogCorners(lap.trace, L, RA);
    apexes.push(cs.map((c) => c.apexD));
    check(`lap ${i + 1} (own ${lap.ownCorners}): ten corners, C1..C10, well formed`, cs.length === 10 && idsInOrder(cs) && wellFormed(cs));
    check(`lap ${i + 1}: every corner within ${SNAP_M} m of its catalogue apex`,
      cs.every((c, k) => Math.abs(c.apexD - RA.corners[k].apexD) * L <= SNAP_M + 0.5),
      cs.map((c) => m(c.apexD)).join(' '));
    check(`lap ${i + 1}: indices agree with the fractions`, cs.every((c) => c.entryI <= c.apexI && c.apexI <= c.exitI));
  }
  // The same corner, whichever lap is the reference: C5 never wanders more
  // than the snap radius from C5 on another lap's numbering.
  let worst = 0;
  for (let k = 0; k < 10; k += 1) {
    const ds = apexes.map((a) => a[k]);
    worst = Math.max(worst, (Math.max(...ds) - Math.min(...ds)) * L);
  }
  check('each id is the same corner on every lap (spread under 2 × snap radius)', worst < 2 * SNAP_M, `${Math.round(worst)} m`);
  const lap0 = FX.laps.find((l) => l.ownCorners === 11);
  const paired = snapToCatalog(findCorners(lap0.trace, L), RA, L).filter((p) => p !== null).length;
  check('an 11-corner lap: its extra corners are dropped, the rest keep their own spans', paired >= 8 && paired <= 10, paired);
}

/* --------------------------------- §4 ------------------------------------ */

console.log('\n§4 pairing, and no catalogue');
{
  const cat = { corners: [{ apexD: 0.1 }, { apexD: 0.2 }, { apexD: 0.3 }] };
  const Lm = 1000;
  const p = snapToCatalog([{ apexD: 0.103 }, { apexD: 0.25 }, { apexD: 0.36 }], cat, Lm);
  check('nearest apex within 40 m pairs; 60 m away does not', p[0] === 0 && p[1] === null && p[2] === null, JSON.stringify(p));
  const p2 = snapToCatalog([{ apexD: 0.105 }, { apexD: 0.112 }], cat, Lm);
  check('one to one: two found apexes near one corner → only the nearer pairs', p2[0] === 0 && p2[1] === null);
  const p3 = snapToCatalog([{ apexD: 0.135 }], { corners: [{ apexD: 0.1 }, { apexD: 0.16 }] }, Lm);
  check('closest pair wins across neighbours', p3[0] === null && p3[1] === 0, JSON.stringify(p3));

  const lap = FX.laps[0].trace;
  const plain = findCorners(lap, L);
  const fb = catalogCorners(lap, L, null);
  check('no catalogue: the lap\'s own corners, numbered C1..Cn', fb.length === plain.length && idsInOrder(fb) && fb.every((c, i) => c.apexD === plain[i].apexD));
  const a = cornersForLap({ mapKey: 'nowhere-1234', trackLengthM: L, ref: lap });
  check('cornersForLap with an unknown layout: source reference, own count', a.source === 'reference' && a.catalog === null && a.corners.length === plain.length);
  const b = cornersForLap({ mapKey: RA_KEY, trackLengthM: L, ref: lap });
  check('cornersForLap at Road Atlanta: source catalog, 10 ids', b.source === 'catalog' && b.corners.length === 10 && idsInOrder(b.corners));
  const c = cornersForLap({ mapKey: RA_KEY, trackLengthM: L, ref: lap, catalog: null });
  check('cornersForLap with catalog: null forces the reference', c.source === 'reference');
  check('no speed channel: no corners either way', catalogCorners({ d: lap.d }, L, RA).length === 0 && catalogCorners({ d: lap.d }, L, null).length === 0);
}

/* --------------------------------- §5 ------------------------------------ */

console.log('\n§5 the builder');

/**
 * A synthetic circuit: straights and arcs sampled every 5 m, the line laid
 * by integrating the heading (left = heading rising, the sign the real line
 * has). Speed is V-shaped into each slow arc's apex; brake while slowing.
 * `kinkDeg` sets the fast kink (100 m long either way, so nothing after it
 * moves): 34° is a corner, 20° is not (on the line 28° reads as ~24°, under
 * corners.ts MIN_TURN_DEG — the Le Mans kink's trouble exactly).
 */
function synthLap({ kinkDeg = 20, jitter = 0 } = {}) {
  const segs = [
    ['s', 300 + jitter], ['a', -90, 40, 80],
    ['s', 400 - jitter], ['a', 60, 80, 110], ['s', 30], ['a', -60, 80, 110],
    ['s', 500 + jitter], ['a', -kinkDeg, (100 * 180) / (Math.PI * kinkDeg), null],
    ['s', 400], ['a', 120, 50, 90], ['s', 30], ['a', -50, 90, 120], ['s', 30], ['a', 50, 90, 120],
    ['s', 400 - jitter],
  ];
  const STEP = 5;
  const pts = [];
  const apexS = [];
  let s = 0;
  let h = 0;
  for (const g of segs) {
    if (g[0] === 's') {
      for (let u = 0; u < g[1]; u += STEP) pts.push({ s: s + u, h });
      s += g[1];
    } else {
      const len = (Math.abs(g[1]) * Math.PI * g[2]) / 180;
      const k = (g[1] * Math.PI) / 180 / len;
      if (g[3] !== null) apexS.push({ s: s + len / 2, kph: g[3] });
      for (let u = 0; u < len; u += STEP) pts.push({ s: s + u, h: h + k * u });
      h += k * len;
      s += len;
    }
  }
  const total = s;
  const d = [], x = [], z = [], v = [], brake = [], throttle = [], t = [];
  let px = 0, pz = 0, pt = 0;
  for (let i = 0; i < pts.length; i += 1) {
    if (i > 0) {
      const ds = pts[i].s - pts[i - 1].s;
      px += Math.cos(pts[i - 1].h) * ds;
      pz += Math.sin(pts[i - 1].h) * ds;
    }
    d.push(pts[i].s / total);
    x.push(px);
    z.push(pz);
    let sp = 250;
    for (const a of apexS) sp = Math.min(sp, a.kph + 0.5 * Math.abs(pts[i].s - a.s));
    v.push(sp);
  }
  for (let i = 0; i < v.length; i += 1) {
    const slowing = i + 1 < v.length && v[i + 1] < v[i];
    brake.push(slowing ? 0.8 : 0);
    throttle.push(slowing ? 0 : 1);
    if (i > 0) pt += ((d[i] - d[i - 1]) * total) / (v[i] / 3.6);
    t.push(pt);
  }
  return { trackLengthM: total, trace: { d, t, x, z, speedKph: v, brake, throttle } };
}

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const laps = (n, kinkShare) =>
  Array.from({ length: n }, (_, i) => synthLap({ kinkDeg: i < Math.round(n * kinkShare) ? 34 : 20, jitter: Math.round((rnd() - 0.5) * 16) }));
const ids = (c) => c.corners.map((k) => `${k.id}${k.dir}@${Math.round(k.apexD * c.trackLengthM)}`).join(' ');
const sameCorners = (a, b, tolM = 12) =>
  a.corners.length === b.corners.length &&
  a.corners.every((k, i) => k.id === b.corners[i].id && k.dir === b.corners[i].dir && Math.abs(k.apexD * a.trackLengthM - b.corners[i].apexD * b.trackLengthM) <= tolM);
{
  const one = synthLap({ kinkDeg: 34 });
  check('synthetic lap: 7 corners with the kink, 6 without', findCorners(one.trace, one.trackLengthM).length === 7 && findCorners(synthLap().trace, synthLap().trackLengthM).length === 6);

  const first = laps(20, 0.5);
  const A = builder.buildCatalog(first, { mapKey: 'synth', at: '2026-10-29' }).catalog;
  check('20 laps, the kink in half of them: 6 corners, the kink left out', A.corners.length === 6, ids(A));
  check('directions from the line: R, L, R, L, R, L', A.corners.map((k) => k.dir).join('') === 'RLRLRL');
  check('the L-R pair 30 m apart is a chicane', A.sequences.some((s) => s.kind === 'chicane' && s.cornerIds.join() === 'C2,C3'), JSON.stringify(A.sequences));
  check('three linked corners are one complex', A.sequences.some((s) => s.kind === 'complex' && s.cornerIds.join() === 'C4,C5,C6'));
  check('C1 stands alone', A.corners[0].seq === null);
  check('the build note counts the laps', A.builtFrom === 20 && A.built.laps === 20 && A.built.cutBy.line === 20);

  // Ten more laps, all with the kink: 20 of 30 = 67% — over the first-build
  // bar, under the bar for joining an existing catalogue.
  const more = first.concat(laps(10, 1));
  const B = builder.buildCatalog(more, { mapKey: 'synth', previous: A }).catalog;
  check('rebuilt with extra laps: the same ids at the same corners', sameCorners(A, B), `${ids(A)} → ${ids(B)}`);
  const fresh = builder.buildCatalog(more, { mapKey: 'synth' }).catalog;
  check('…which is the hysteresis at work: a fresh vote on the same laps adds the kink', fresh.corners.length === 7, ids(fresh));
  const C = builder.buildCatalog(more.concat(laps(30, 1)), { mapKey: 'synth', previous: A }).catalog;
  check('a corner seen in ≥ 70% of laps does join (and renumbers after it)', C.corners.length === 7, ids(C));
  const D = builder.buildCatalog(laps(20, 0.45), { mapKey: 'synth', previous: fresh }).catalog;
  check('a corner already catalogued stays while seen in ≥ 40% of laps', sameCorners(fresh, D), `${ids(fresh)} → ${ids(D)}`);
  const E = builder.buildCatalog(laps(20, 0.2), { mapKey: 'synth', previous: fresh }).catalog;
  check('…and goes below that', E.corners.length === 6, ids(E));

  // Real laps: the five fixture laps rebuilt onto the shipped catalogue keep
  // all ten corners, though only two of them read the 1990 m bend.
  const real = FX.laps.map((l) => ({ ...l, trackLengthM: L }));
  const R = builder.buildCatalog(real, { mapKey: RA_KEY, previous: RA }).catalog;
  check('Road Atlanta rebuilt from the fixture laps onto the shipped catalogue: same 10 ids', R.corners.length === 10 && R.corners.every((k, i) => k.dir === RA.corners[i].dir && Math.abs(k.apexD - RA.corners[i].apexD) * L <= SNAP_M), ids(R));

  // A lap with no line is cut on a line dead-reckoned from lateral G.
  const t = require('./fixtures/trace-road-atlanta-gt3.json');
  const { x, z, ...noLine } = t.trace;
  const byLatG = builder.lapCorners(noLine, t.trackLengthM);
  const byLine = builder.lapCorners(t.trace, t.trackLengthM);
  check('latG heading: the v1 cut is made from lateral G', byLatG && byLatG.source === 'latG' && byLine.source === 'line');
  const hits = byLine.corners.filter((c) => byLatG.corners.some((g) => g.dir === c.dir && Math.abs(g.apexM - c.apexM) <= 25)).length;
  check('latG heading: ≥ 9 of the line\'s 10 corners found, same direction, within 25 m', hits >= 9, `${hits}/${byLine.corners.length}`);
  const h = builder.headingFromLatG(t.trace.d, t.trace.latG, t.trace.speedKph, t.trackLengthM);
  const turned = ((h[h.length - 1] - h[0]) * 180) / Math.PI;
  check('latG heading: a lap turns through about one full circle', Math.abs(Math.abs(turned) - 360) < 45, `${Math.round(turned)}°`);
}

/* --------------------------------- §6 ------------------------------------ */

console.log('\n§6 the surfaces number by the catalogue');
{
  let seq = 0;
  const mk = (lap, lapMs) => {
    seq += 1;
    const id = `lap-${seq}`;
    const at = new Date(Date.UTC(2026, 9, 29, 10, 0, seq * 90)).toISOString();
    return {
      review: { id, at, lapNo: seq, stintNo: 1, stintLap: seq, lapMs, clean: true, dirty: [], timed: true, isOutLap: false, isInLap: false, hasTrace: true },
      file: { v: 2, lapId: id, at, sim: 'lmu', trackKey: 'x', track: 'Michelin Raceway Road Atlanta', trackLengthM: L, car: 'c', carClass: lap.carClass, lapMs, trace: { ...lap.trace, lapSec: lap.lapSec } },
    };
  };
  const sessionOf = (ls) => {
    const rs = ls.map((l) => l.review);
    return {
      session: {
        id: `${rs[0].at}~x`, sim: 'lmu', track: 'Michelin Raceway Road Atlanta', trackKey: 'x', trackLengthM: L, car: 'c', carClass: 'GT3', sessionType: 'practice',
        startedAt: rs[0].at, endedAt: rs[rs.length - 1].at,
        stints: [{ no: 1, startedAt: rs[0].at, endedAt: rs[rs.length - 1].at, laps: rs, stats: {} }],
        stats: {}, pbMs: null, pbHere: false, trend: [],
      },
      traces: new Map(ls.map((l) => [l.review.id, l.file])),
    };
  };
  // Two sessions whose best laps cut themselves differently (11 and 9).
  const eleven = FX.laps.find((l) => l.ownCorners === 11);
  const nine = FX.laps.find((l) => l.ownCorners === 9);
  const other = FX.laps.find((l) => l.ownCorners === 10);
  const s1 = sessionOf([mk(eleven, 80000), mk(other, 90000)]);
  const s2 = sessionOf([mk(nine, 80000), mk(other, 90000)]);
  const plain1 = buildPracticeReview({ ...s1, target: null });
  const plain2 = buildPracticeReview({ ...s2, target: null });
  check('without a catalogue the two sessions disagree (the bug)', plain1.corners.length !== plain2.corners.length, `${plain1.corners.length} vs ${plain2.corners.length}`);
  const r1 = buildPracticeReview({ ...s1, target: null, catalog: RA });
  const r2 = buildPracticeReview({ ...s2, target: null, catalog: RA });
  check('with it, both sessions have the same ten corners, C1..C10', r1.corners.length === 10 && r2.corners.length === 10 && idsInOrder(r1.corners) && idsInOrder(r2.corners));
  check('…and C5 is the same corner in both', Math.abs(r1.corners[4].apexD - r2.corners[4].apexD) * L <= 2 * SNAP_M, `${m(r1.corners[4].apexD)} vs ${m(r2.corners[4].apexD)}`);
  check('every lap row carries the corner ids', r1.laps.every((l) => l.corners.length === 0 || (l.corners.length === 10 && idsInOrder(l.corners))));
  check('ids match positions (index + 1) — the panel and overlay number by position', r1.corners.every((c, i) => c.index === i && c.id === `C${i + 1}`));
  check('without a catalogue, ids are C1..Cn by position', idsInOrder(plain1.corners));

  // A snapshot's served corners are what the driver saw, and are kept.
  const tgt = (corners) => ({ kind: 'chased', label: 'x', lapId: 'board:x', lapSec: 80, columns: { ...other.trace, trackLengthM: L, ...(corners ? { corners } : {}) } });
  const servedOld = findCorners(other.trace, L).map((c) => ({ entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
  const rOld = buildPracticeReview({ ...s1, target: tgt(servedOld), catalog: RA });
  check('an older snapshot (served corners, no ids) keeps its own list, C1..Cn', rOld.corners.length === servedOld.length && idsInOrder(rOld.corners));
  const servedNew = catalogCorners(other.trace, L, RA).map((c) => ({ id: c.id, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
  const rNew = buildPracticeReview({ ...s1, target: tgt(servedNew), catalog: RA });
  check('a snapshot from a catalogued ghost keeps its ids', rNew.corners.length === 10 && rNew.corners.every((c, i) => c.id === servedNew[i].id && c.apexD === servedNew[i].apexD));
  const rNone = buildPracticeReview({ ...s1, target: tgt(null), catalog: RA });
  check('a snapshot without served corners is cut by the catalogue', rNone.corners.length === 10 && idsInOrder(rNone.corners));

  // The lap deep dive's rows.
  const refCols = { ...other.trace };
  const rows = cornerRows({ ...eleven.trace }, refCols, servedNew, L);
  check('cornerRows: a row per catalogue corner with its id', rows.length === 10 && idsInOrder(rows));
  const rowsNoId = cornerRows({ ...eleven.trace }, refCols, servedOld, L);
  check('cornerRows without ids: C(index+1)', idsInOrder(rowsNoId));

  // The ghost: what /ghost.json serves and the Corner Analysis card numbers.
  const file = mk(eleven, 80000).file;
  const gPlain = ghostFromTrace(file, 'x');
  const gCat = ghostFromTrace(file, 'x', RA);
  check('ghost without a catalogue: its own 11 corners', gPlain.corners.length === 11);
  check('ghost with the catalogue: 10, C1..C10', gCat.corners.length === 10 && idsInOrder(gCat.corners));
  const j = ghostJson(gCat);
  check('/ghost.json serves the ids', j.corners.length === 10 && idsInOrder(j.corners));
  const before = gPlain.corners;
  applyCornerCatalog(gPlain, RA);
  check('applyCornerCatalog re-cuts a built ghost (a new array, the old one untouched)', gPlain.corners !== before && before.length === 11 && gPlain.corners.length === 10 && idsInOrder(gPlain.corners));
  check('…to exactly what ghostFromTrace builds with it', gPlain.corners.every((c, i) => c.apexD === gCat.corners[i].apexD && c.entryD === gCat.corners[i].entryD));
  const g2 = ghostFromTrace(file, 'x');
  applyCornerCatalog(g2, null);
  check('applyCornerCatalog(null) leaves the lap\'s own corners', g2.corners.length === 11);
  check('the ghost and the review agree corner for corner', rNew.corners.every((c, i) => Math.abs(c.apexD - catalogCorners(other.trace, L, RA)[i].apexD) < 1e-9));
}

/* --------------------------------- §7 ------------------------------------ */

console.log('\n§7 packaging');
(async () => {
  const builderCfg = fs.readFileSync(path.join(ROOT, 'electron-builder.js'), 'utf8');
  check("the installer's files include data/**/* (trackmaps and corners alike)", /'data\/\*\*\/\*'/.test(builderCfg));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('the dev builder is not shipped: scripts/ is not in the files', !/'scripts\//.test(builderCfg) && !(pkg.build && pkg.build.files));

  resetCornerCatalogCache();
  const a = await loadCornerCatalogAsync(RA_KEY);
  check('async loader: the same catalogue as the sync one', !!a && JSON.stringify(a) === JSON.stringify(loadCornerCatalog(RA_KEY)));
  check('async loader: missing → null', (await loadCornerCatalogAsync('nowhere-1234')) === null);
  check('async loader: a named directory', (await loadCornerCatalogAsync('ok-1', tmp)) !== null && (await loadCornerCatalogAsync('overlap', tmp)) === null);

  const realFs = require('node:fs');
  const names = ['readFileSync', 'statSync', 'existsSync', 'readdirSync'];
  const saved = names.map((n) => realFs[n]);
  let syncHits = 0;
  names.forEach((n, i) => { realFs[n] = function (...args) { syncHits += 1; return saved[i].apply(this, args); }; });
  resetCornerCatalogCache();
  try {
    await loadCornerCatalogAsync(RA_KEY);
    await loadCornerCatalogAsync('daytona-international-speedway-road-course-5730');
  } finally {
    names.forEach((n, i) => { realFs[n] = saved[i]; });
  }
  check('async loader: no sync fs call (it runs beside the frame loop)', syncHits === 0, syncHits);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
