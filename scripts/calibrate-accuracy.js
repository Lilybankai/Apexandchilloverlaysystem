/**
 * scripts/calibrate-accuracy.js — choose the accuracy score's constants from
 * the laps on THIS machine, and say how well the score predicts lap time.
 * -----------------------------------------------------------------------------
 * The rule (docs/PRACTICE-REVIEW-PLAN.md, phase 3): a higher score must mean a
 * faster lap. So every lap of every session is scored against that session's
 * best valid lap, and the score is compared with the time actually lost:
 *
 *   corner level  Spearman ρ of a corner's total vs its deltaSec, pooled
 *   lap level     Spearman ρ of a lap's total vs its delta to the best, taken
 *                 WITHIN each session (tracks differ, so pooling laps across
 *                 tracks would measure the tracks) and averaged, weighted by
 *                 laps
 *
 * ρ should be NEGATIVE (more points, less time lost); "agreement" below is −ρ.
 *
 * The constants are chosen by REPEATED HOLDOUT: five different 70/30 splits
 * of the sessions (by a hash of the id, so every run is the same), a
 * coordinate-descent search on each split's 70%, and the candidate with the
 * best mean agreement on the five held-out 30%s is kept. With ~50 sessions a
 * single split's held-out figure moves by ±0.02 with the luck of the draw.
 *
 * Run: node scripts/calibrate-accuracy.js [--json]   (build first)
 */

'use strict';

const path = require('node:path');
const dist = (m) => require(path.join(__dirname, '..', 'dist', 'telemetry', m));
const { listSessions, loadSession } = dist('stintReview.js');
const { readTrace } = dist('lapTrace.js');
const { cleanCols, practiceReference } = dist('practiceReview.js');
const { cornerErrors, scoreCorner, lapFromCorners, SCORING } = dist('accuracyScore.js');

const asJson = process.argv.includes('--json');
const log = (...a) => {
  if (!asJson) console.log(...a);
};

/* ------------------------------- statistics ------------------------------ */

function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function spearman(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = ra.reduce((s, v) => s + v, 0) / n;
  const mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/* ------------------------------- the data -------------------------------- */

const t0 = Date.now();
const listed = listSessions();
const all = Array.isArray(listed) ? listed : listed.sessions;
const sessions = [];
let lapsSeen = 0;
for (const meta of all) {
  const s = loadSession(meta.id);
  if (!s || !(s.trackLengthM > 0)) continue;
  const laps = s.stints.flatMap((st) => st.laps).filter((l) => l.clean && l.timed && l.lapMs > 0 && l.id && l.hasTrace);
  if (laps.length < 4) continue;
  const cols = new Map();
  for (const l of laps) {
    const f = readTrace(l.id, l.at);
    const c = f && f.trace ? cleanCols(f.trace) : null;
    if (c && c.d[0] <= 0.02 && c.d[c.d.length - 1] >= 0.98) cols.set(l.id, c);
  }
  if (cols.size < 4) continue;
  const ref = practiceReference(s, cols, null);
  if (!ref || ref.corners.length < 3) continue;
  const best = ref.target.lapSec;
  const rows = [];
  for (const l of laps) {
    if (l.id === ref.target.lapId || !cols.has(l.id)) continue;
    const lapSec = l.lapMs / 1000;
    // A lap past 110% of the best is a spin or a moment, not technique: its
    // time says nothing about how closely the corners were copied.
    if (lapSec > best * 1.1) continue;
    const c = cols.get(l.id);
    const errs = ref.corners.map((_k, i) => cornerErrors(c, ref.ref, ref.corners, i, s.trackLengthM));
    rows.push({ delta: lapSec - best, errs, line: !!c.x });
    lapsSeen++;
  }
  if (rows.length >= 3) {
    sessions.push({ id: s.id, track: s.track, type: s.sessionType, rows });
  }
}
log(`${sessions.length} sessions, ${lapsSeen} laps scored against their session's best (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
log(`  with a driven line: ${sessions.reduce((n, s) => n + s.rows.filter((r) => r.line).length, 0)} laps`);
/** Split k: ~30% of sessions held out, by a hash of the id and the seed. */
const SPLITS = 5;
const split = (k) => ({
  train: sessions.filter((x) => hash(x.id + '#' + k) >= 0.3),
  test: sessions.filter((x) => hash(x.id + '#' + k) < 0.3),
});
let { train, test } = split(0);
log(`  ${SPLITS} splits, each ~70% train / ~30% held out (split 0: ${train.length} / ${test.length})`);

/* ------------------------------ evaluation ------------------------------- */

function evaluate(set, k, pick) {
  // pick: optional part name — score with that part alone.
  const kk = pick
    ? { scales: k.scales, weights: { braking: 0, throttle: 0, line: 0, speed: 0, [pick]: 1 } }
    : k;
  let lapRhoSum = 0;
  let lapN = 0;
  const cs = [];
  const cd = [];
  for (const s of set) {
    const scores = [];
    const deltas = [];
    for (const r of s.rows) {
      const raw = r.errs.map((e) => ({ e, s: scoreCorner(e, kk) }));
      for (const x of raw) {
        if (x.s && x.e.deltaSec !== null) {
          cs.push(x.s.total);
          cd.push(x.e.deltaSec);
        }
      }
      const lap = lapFromCorners(raw, kk);
      if (lap.score) {
        scores.push(lap.score.total);
        deltas.push(r.delta);
      }
    }
    const rho = spearman(scores, deltas);
    if (rho !== null) {
      lapRhoSum += rho * scores.length;
      lapN += scores.length;
    }
  }
  return {
    lap: lapN ? -lapRhoSum / lapN : null,
    corner: cs.length >= 3 ? -spearman(cs, cd) : null,
    corners: cs.length,
  };
}

const fmt = (v) => (v === null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(3));
function report(title, k) {
  log(`\n${title}`);
  log('                 lap agreement (train / held out)   corner agreement (train / held out)');
  for (const p of [null, 'braking', 'throttle', 'line', 'speed']) {
    const a = evaluate(train, k, p);
    const b = evaluate(test, k, p);
    log(`  ${(p || 'TOTAL').padEnd(9)}      ${fmt(a.lap)} / ${fmt(b.lap)}                    ${fmt(a.corner)} / ${fmt(b.corner)}   (${a.corners}+${b.corners} corners)`);
  }
}

const clone = (k) => JSON.parse(JSON.stringify(k));
const start = clone(SCORING);
report('Before calibration (the constants in accuracyScore.ts):', start);

/* --------------------------- coordinate descent -------------------------- */

// Every part stays in, at a plausible scale, between half and double weight:
// on ~50 sessions a free search 'wins' by switching a part off (a scale so
// large it always scores 100), and the held-out sessions show that is fitting
// noise, not lap time. The plan's rule is to DOWN-weight a weak part.
const GRID = {
  'scales.brakeOnM': [8, 10, 15, 20, 25, 35],
  'scales.brakeOffM': [25, 40, 60, 90],
  'scales.pickupM': [25, 40, 60, 90],
  'scales.flatPts': [10, 20, 35],
  'scales.lineM': [1, 1.5, 2.5, 4],
  'scales.apexKph': [6, 9, 13, 18, 25],
  'weights.braking': [0.5, 1, 2],
  'weights.throttle': [0.5, 1, 2],
  'weights.line': [0.5, 1, 2],
  'weights.speed': [1, 2, 3],
};
const get = (k, p) => p.split('.').reduce((o, x) => o[x], k);
const set = (k, p, v) => {
  const [a, b] = p.split('.');
  k[a][b] = v;
};
// Objective: lap agreement on the training sessions, with the corner
// agreement as a small tie-break — the same question asked at two sizes.

/** Coordinate descent on one training set, from `from`. */
function descend(trainSet, from) {
  const obj = (k) => {
    const e = evaluate(trainSet, k);
    return (e.lap || 0) + 0.25 * (e.corner || 0);
  };
  let cur = clone(from);
  let curObj = obj(cur);
  for (let round = 1; round <= 3; round++) {
    let moved = false;
    for (const p of Object.keys(GRID)) {
      for (const v of GRID[p]) {
        if (get(cur, p) === v) continue;
        const k = clone(cur);
        set(k, p, v);
        const o = obj(k);
        if (o > curObj + 1e-4) {
          cur = k;
          curObj = o;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return cur;
}

// Repeated holdout: a search on each split's training sessions gives one
// candidate per split (plus the starting constants). Every candidate is then
// judged on EVERY split's held-out sessions, and the one with the best mean
// held-out lap agreement is kept: no single lucky split chooses the score.
const candidates = [clone(start)];
for (let k = 0; k < SPLITS; k++) candidates.push(descend(split(k).train, start));
const heldOut = (cand) => {
  let lap = 0;
  let tr = 0;
  for (let k = 0; k < SPLITS; k++) {
    const sp = split(k);
    lap += evaluate(sp.test, cand).lap || 0;
    tr += evaluate(sp.train, cand).lap || 0;
  }
  return { test: lap / SPLITS, train: tr / SPLITS };
};
let best = candidates[0];
let bestHeld = heldOut(best);
log('\nCandidates (mean lap agreement over the ' + SPLITS + ' splits, train / held out):');
candidates.forEach((c, i) => {
  const h = heldOut(c);
  log('  ' + (i === 0 ? 'start ' : 'split ' + (i - 1)) + '  ' + fmt(h.train) + ' / ' + fmt(h.test) + '   ' + JSON.stringify(c));
  if (h.test > bestHeld.test + 1e-4) {
    best = c;
    bestHeld = h;
  }
});
log('\nKept: mean lap agreement ' + fmt(bestHeld.train) + ' train / ' + fmt(bestHeld.test) + ' held out');

report('After calibration (split 0 shown per part):', best);
log('\nChosen constants:');
log(JSON.stringify(best, null, 2));

if (asJson) {
  const out = { sessions: sessions.length, laps: lapsSeen, train: train.length, test: test.length, chosen: best, parts: {} };
  for (const p of [null, 'braking', 'throttle', 'line', 'speed']) {
    out.parts[p || 'total'] = { before: [evaluate(train, start, p), evaluate(test, start, p)], after: [evaluate(train, best, p), evaluate(test, best, p)] };
  }
  console.log(JSON.stringify(out, null, 2));
}
