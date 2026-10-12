/**
 * scripts/test-practicereview.js — the Practice Review debrief
 * (src/telemetry/practiceReview.ts, practiceReviewLoad.ts).
 * -----------------------------------------------------------------------------
 * A debrief that blames the wrong corner, or turns a loss into a gain, does
 * not look broken — it looks like advice. So every number here is planted:
 *
 *   §1 a lap against itself scores exactly zero, everywhere;
 *   §2 against a reference 2.5% quicker everywhere, everything is a loss;
 *   §3 a planted fault in ONE corner (braked 15 m early, 0.2 s lost, 6 km/h
 *      down at the apex) is found in that corner and no other, with the signs
 *      the plan pins — positive time = losing, positive brake = LATER,
 *      positive apex = MORE speed — and the opposite fault reads the other way;
 *   §4 the theoretical best takes each segment from whichever lap did it best;
 *   §5 dirty laps are listed but never counted; no target → the session best;
 *   §6 the loader's file naming and snapshot matching.
 *
 * The lap is a real one: scripts/fixtures/trace-road-atlanta-gt3.json.
 *
 * Run: node scripts/test-practicereview.js (build first)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildPracticeReview } = require('../dist/telemetry/practiceReview');
const { sessionFileKey, findSnapshot } = require('../dist/telemetry/practiceReviewLoad');
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
const near = (a, b, tol) => a !== null && a !== undefined && Math.abs(a - b) <= tol;

/* ------------------------------- fixtures -------------------------------- */

const FIX = require('./fixtures/trace-road-atlanta-gt3.json');
const L = FIX.trackLengthM;
const BASE = FIX.trace;
const BASE_MS = FIX.lapMs;

/** A copy of the base lap's columns. */
function cloneTrace(tr) {
  const out = {};
  for (const [k, v] of Object.entries(tr)) out[k] = Array.isArray(v) ? v.slice() : v;
  return out;
}

const REF_CORNERS = findCorners(BASE, L);
/** The corner the planted faults go in: one that the reference brakes for. */
const K = REF_CORNERS.findIndex((c, i) => c.brakeD !== null && i > 0);

/**
 * Plant a fault in corner K: the brake trace shifted `shiftM` metres (negative
 * = earlier), `lossSec` added to the clock through the corner (and carried to
 * the end of the lap), and `kph` taken off the speed through it.
 */
function faulted({ shiftM = 0, lossSec = 0, kph = 0 } = {}) {
  const tr = cloneTrace(BASE);
  const c = REF_CORNERS[K];
  const from = c.entryD - 150 / L;
  const n = tr.d.length;
  if (shiftM) {
    const src = BASE.brake;
    for (let i = 0; i < n; i++) {
      const d = tr.d[i];
      if (d < from || d > c.apexD) continue;
      // brake'(d) = brake(d − shift): read the pedal from `shift` metres away.
      const want = d - shiftM / L;
      let j = 0;
      while (j < n - 1 && BASE.d[j + 1] < want) j++;
      const a = BASE.d[j], b = BASE.d[Math.min(j + 1, n - 1)];
      const f = b > a ? Math.min(1, Math.max(0, (want - a) / (b - a))) : 0;
      tr.brake[i] = src[j] + (src[Math.min(j + 1, n - 1)] - src[j]) * f;
    }
  }
  if (lossSec) {
    for (let i = 0; i < n; i++) {
      const d = tr.d[i];
      if (d <= c.entryD) continue;
      const f = d >= c.exitD ? 1 : (d - c.entryD) / (c.exitD - c.entryD);
      tr.t[i] += lossSec * f;
    }
    tr.lapSec += lossSec;
  }
  if (kph) {
    for (let i = 0; i < n; i++) {
      const d = tr.d[i];
      if (d >= c.entryD && d <= c.exitD) tr.speedKph[i] -= kph;
    }
  }
  return tr;
}

let lapSeq = 0;
/** A ReviewLap + its TraceFile. */
function lap({ trace = BASE, lapMs = BASE_MS, clean = true, timed = true, withTrace = true } = {}) {
  lapSeq++;
  const id = `lap-${lapSeq}`;
  const at = new Date(Date.UTC(2026, 9, 8, 10, 0, lapSeq * 90)).toISOString();
  const review = {
    id, at, lapNo: lapSeq, stintNo: 1, stintLap: lapSeq, lapMs,
    clean, dirty: clean ? [] : ['cut'], timed, isOutLap: false, isInLap: false, hasTrace: withTrace,
  };
  const file = withTrace
    ? { v: 2, lapId: id, at, sim: 'lmu', trackKey: FIX.trackKey, track: FIX.track, trackLengthM: L,
        car: FIX.car, carClass: FIX.carClass, lapMs, trace }
    : null;
  return { review, file };
}

function session(laps) {
  lapSeq = 0;
  const rs = laps.map((l) => l.review);
  return {
    session: {
      id: `${rs[0].at}~${FIX.trackKey}`, sim: 'lmu', track: FIX.track, trackKey: FIX.trackKey,
      trackLengthM: L, car: FIX.car, carClass: FIX.carClass, sessionType: 'practice',
      startedAt: rs[0].at, endedAt: rs[rs.length - 1].at,
      stints: [{ no: 1, startedAt: rs[0].at, endedAt: rs[rs.length - 1].at, laps: rs, stats: {} }],
      stats: {}, pbMs: null, pbHere: false, trend: [],
    },
    traces: new Map(laps.map((l) => [l.review.id, l.file])),
  };
}

function targetFrom(tr, lapSec, label = 'A. Winters · 1:19.299 · board') {
  return { kind: 'chased', label, lapId: 'board:x', lapSec, columns: { ...tr, trackLengthM: L } };
}

/* --------------------------------- §1 ------------------------------------ */

console.log('\n§1 a lap against itself scores zero');
{
  lapSeq = 0;
  const s = session([lap()]);
  const r = buildPracticeReview({ ...s, target: targetFrom(BASE, BASE_MS / 1000) });
  check('reference corners found on the real lap', r.corners.length === REF_CORNERS.length && r.corners.length >= 6, r.corners.length);
  check('lap delta is zero', r.laps[0].deltaSec === 0, r.laps[0].deltaSec);
  const cs = r.laps[0].corners;
  check('every corner loses exactly nothing', cs.every((c) => c.deltaSec === 0), cs.map((c) => c.deltaSec).join(','));
  check('every braking point is the same point', cs.every((c) => c.brakeDeltaM === null || c.brakeDeltaM === 0));
  check('every apex speed is the same speed', cs.every((c) => c.apexKphDelta === null || c.apexKphDelta === 0));
  check('target is the chased lap', r.target && r.target.kind === 'chased' && r.target.label.startsWith('A. Winters'));
}

/* --------------------------------- §2 ------------------------------------ */

console.log('\n§2 against a reference 2.5% quicker everywhere');
{
  lapSeq = 0;
  const k = 0.975;
  const quick = { ...cloneTrace(BASE), t: BASE.t.map((v) => v * k), lapSec: BASE.lapSec * k };
  const s = session([lap()]);
  const r = buildPracticeReview({ ...s, target: targetFrom(quick, (BASE_MS / 1000) * k) });
  const d = r.laps[0].deltaSec;
  check('the lap is a loss, by 2.5%', near(d, (BASE_MS / 1000) * 0.025, 0.002), d);
  const losses = r.laps[0].corners.map((c) => c.deltaSec).filter((v) => v !== null);
  check('every corner is a loss (positive)', losses.length > 0 && losses.every((v) => v > 0), losses.join(','));
  const sum = losses.reduce((a, b) => a + b, 0);
  check('the corners hold part of the loss, not more than all of it', sum > 0 && sum < d, `${sum.toFixed(3)} of ${d}`);
  check('corner summary averages the one valid lap', r.corners.every((c) => c.laps === 1 && c.avgLossSec > 0));
}

/* --------------------------------- §3 ------------------------------------ */

console.log(`\n§3 a planted fault in C${K + 1} and nowhere else`);
{
  lapSeq = 0;
  const bad = faulted({ shiftM: -15, lossSec: 0.2, kph: 6 });
  const s = session([lap({ trace: bad, lapMs: BASE_MS + 200 })]);
  const r = buildPracticeReview({ ...s, target: targetFrom(BASE, BASE_MS / 1000) });
  const cs = r.laps[0].corners;
  const c = cs[K];
  check('the lap is 0.2 s down', near(r.laps[0].deltaSec, 0.2, 0.001), r.laps[0].deltaSec);
  check(`C${K + 1} lost the 0.2 s (positive = losing)`, near(c.deltaSec, 0.2, 0.02), c.deltaSec);
  const others = cs.filter((_, i) => i !== K).map((x) => x.deltaSec).filter((v) => v !== null);
  check('no other corner is blamed', others.every((v) => Math.abs(v) < 0.01), others.join(','));
  check(`C${K + 1} braked 15 m EARLY (negative)`, near(c.brakeDeltaM, -15, 3), c.brakeDeltaM);
  check(`C${K + 1} was 6 km/h slower at the apex (negative)`, near(c.apexKphDelta, -6, 0.6), c.apexKphDelta);
  const sum = r.corners[K];
  check('the summary carries the same corner', near(sum.avgLossSec, c.deltaSec, 1e-4) && near(sum.avgBrakeDeltaM, c.brakeDeltaM, 0.1));

  lapSeq = 0;
  const late = faulted({ shiftM: 15 });
  const r2 = buildPracticeReview({ ...session([lap({ trace: late })]), target: targetFrom(BASE, BASE_MS / 1000) });
  check('braking 15 m LATE reads positive', near(r2.laps[0].corners[K].brakeDeltaM, 15, 3), r2.laps[0].corners[K].brakeDeltaM);

  lapSeq = 0;
  const fast = faulted({ lossSec: -0.15, kph: -4 });
  const r3 = buildPracticeReview({ ...session([lap({ trace: fast, lapMs: BASE_MS - 150 })]), target: targetFrom(BASE, BASE_MS / 1000) });
  check('a corner taken quicker reads negative (a gain)', near(r3.laps[0].corners[K].deltaSec, -0.15, 0.02), r3.laps[0].corners[K].deltaSec);
  check('…and its extra apex speed positive', near(r3.laps[0].corners[K].apexKphDelta, 4, 0.6), r3.laps[0].corners[K].apexKphDelta);
}

/* --------------------------------- §4 ------------------------------------ */

console.log('\n§4 the theoretical best');
{
  lapSeq = 0;
  // Lap A loses 0.3 s in corner K; lap B loses 0.2 s everywhere else (spread
  // over the lap). The best of each segment is the base lap's: theoretical =
  // the base time, below both.
  const a = faulted({ lossSec: 0.3 });
  const b = cloneTrace(BASE);
  const c = REF_CORNERS[K];
  for (let i = 0; i < b.d.length; i++) {
    const d = b.d[i];
    // 0.2 s lost outside corner K, linearly in distance.
    const outside = d < c.entryD ? d : d < c.exitD ? c.entryD : d - (c.exitD - c.entryD);
    b.t[i] += (0.2 * outside) / (1 - (c.exitD - c.entryD));
  }
  b.lapSec += 0.2;
  const s = session([lap({ trace: a, lapMs: BASE_MS + 300 }), lap({ trace: b, lapMs: BASE_MS + 200 })]);
  const r = buildPracticeReview({ ...s, target: targetFrom(BASE, BASE_MS / 1000) });
  const best = r.bestLapSec;
  const theo = r.theoreticalBestSec;
  check('best lap is the quicker of the two', near(best, (BASE_MS + 200) / 1000, 1e-6), best);
  check('theoretical best ≤ the best lap', theo !== null && theo <= best + 1e-9, `${theo} vs ${best}`);
  check('…and takes each segment from whichever lap did it best', near(theo, BASE_MS / 1000, 0.03), theo);
  const one = buildPracticeReview({ ...session([lap()]), target: targetFrom(BASE, BASE_MS / 1000) });
  check('one traced lap has no theoretical best', one.theoreticalBestSec === null);
}

/* --------------------------------- §5 ------------------------------------ */

console.log('\n§5 which laps count, and the fallback target');
{
  lapSeq = 0;
  const slow = faulted({ lossSec: 0.5 });
  const quickDirty = faulted({ lossSec: -0.4 });
  const s = session([
    lap({ withTrace: false, lapMs: BASE_MS + 9000 }),           // an out-lap-like lap, no trace
    lap({ trace: slow, lapMs: BASE_MS + 500 }),
    lap({ trace: quickDirty, lapMs: BASE_MS - 400, clean: false }),
    lap({ trace: BASE, lapMs: BASE_MS }),
  ]);
  const r = buildPracticeReview({ ...s, target: null });
  check('every lap is listed', r.laps.length === 4);
  check('a lap with no trace: hasTrace false, no corners', r.laps[0].hasTrace === false && r.laps[0].corners.length === 0);
  check('the dirty lap is marked invalid', r.laps[2].valid === false);
  check('best ignores the faster dirty lap', near(r.bestLapSec, BASE_MS / 1000, 1e-6), r.bestLapSec);
  check('no target → the session best, said so', r.target && r.target.kind === 'sessionBest' && r.target.lapId === s.session.stints[0].laps[3].id && /^Session best · 1:21\.275$/.test(r.target.label), r.target && r.target.label);
  check('the dirty lap is kept out of the corner averages', r.corners[K].laps === 2, r.corners[K].laps);
  check('the session best scores zero against itself', r.laps[3].deltaSec === 0);
  // Consistency over 81.275 / 81.775 (and the 90 s lap is outside 107%).
  const sd = Math.sqrt(((0.25) ** 2 * 2) / 1);
  check('consistency is the spread of valid laps within 107%', near(r.consistencySec, sd, 0.001), r.consistencySec);

  const none = buildPracticeReview({ ...session([lap({ withTrace: false })]), target: null });
  check('nothing traced, no target: laps listed, comparisons null', none.target === null && none.corners.length === 0 &&
    none.laps[0].deltaSec === null && none.theoreticalBestSec === null);
}

console.log('\n§5b the served corner list is used as it is');
{
  lapSeq = 0;
  const served = REF_CORNERS.slice(0, 3).map((c) => ({ entryD: c.entryD, apexD: c.apexD, exitD: c.exitD, apexX: null, apexZ: null, minKph: c.minKph }));
  const t = targetFrom(BASE, BASE_MS / 1000);
  t.columns.corners = served;
  const r = buildPracticeReview({ ...session([lap()]), target: t });
  check("the review's corners are /ghost.json's, numbered as the live card numbered them", r.corners.length === 3 && near(r.corners[2].apexD, served[2].apexD, 1e-12));
}

/* --------------------------------- §6 ------------------------------------ */

console.log('\n§6 the loader: file names and finding the snapshot');
{
  const id = '2026-10-08T10:20:43.000Z~michelin-raceway-road-atlanta_4083';
  const key = sessionFileKey(id);
  check('a session id becomes a legal Windows file name', !/[:<>"/\\|?*~]/.test(key), key);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-prv-'));
  const sess = { track: FIX.track, carClass: 'GT3', startedAt: '2026-10-08T10:00:00.000Z', endedAt: '2026-10-08T10:40:00.000Z' };
  const snap = (endedAt, label, extra = {}) => ({ v: 1, track: FIX.track, carClass: 'GT3', endedAt,
    target: { kind: 'chased', label, lapId: 'x', lapSec: 79.3, columns: { d: [0, 1], t: [0, 79.3] } }, ...extra });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(snap('2026-10-08T10:45:00.000Z', 'first')));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(snap('2026-10-08T10:50:00.000Z', 'later')));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(snap('2026-10-08T12:50:00.000Z', 'another session')));
  fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify(snap('2026-10-08T10:30:00.000Z', 'other class', { carClass: 'Hypercar' })));
  fs.writeFileSync(path.join(dir, 'torn.json'), '{"v":1,');
  const found = findSnapshot('unnamed', sess, dir);
  check('found by track, class and time; the later of two wins', found && found.target.label === 'later', found && found.target.label);
  fs.writeFileSync(path.join(dir, `${sessionFileKey('named')}.json`), JSON.stringify(snap('2026-10-01T00:00:00.000Z', 'by name')));
  const named = findSnapshot('named', sess, dir);
  check('a snapshot named for the session wins over matching', named && named.target.label === 'by name');
  check('nothing in the window → null', findSnapshot('x', { ...sess, startedAt: '2026-10-09T00:00:00.000Z', endedAt: '2026-10-09T01:00:00.000Z' }, dir) === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
