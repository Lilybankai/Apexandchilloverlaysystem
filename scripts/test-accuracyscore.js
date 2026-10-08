/**
 * scripts/test-accuracyscore.js — the accuracy score (src/telemetry/accuracyScore.ts,
 * Practice Review phase 3).
 * -----------------------------------------------------------------------------
 *   §1 a lap against itself scores 100 everywhere and has nothing to gain;
 *   §2 each planted fault lowers ITS OWN part, in ITS OWN corner, and nothing
 *      else: braking 15 m early, a slow pick-up, 3 m off the line, 10 km/h
 *      down at the apex;
 *   §3 a faster apex is not an error (speed is one-sided);
 *   §4 bigger error, fewer points (monotonic);
 *   §5 a part that cannot be measured drops out — never scored 0 or 100;
 *   §6 the lap weights corners by the time the target spends in them, and
 *      pointsToGain adds up to what the lap is short of 100;
 *   §7 the debrief, the lap view and the trend carry the score.
 *
 * The lap is a real one with a driven line: scripts/fixtures/trace-road-atlanta-gt3.json.
 *
 * Run: node scripts/test-accuracyscore.js (build first)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dist = (m) => require(path.join(__dirname, '..', 'dist', 'telemetry', m));
const { scoreLap, scoreCorner, lapFromCorners, cornerErrors, SCORING } = dist('accuracyScore.js');
const { cleanCols, buildPracticeReview } = dist('practiceReview.js');
const { cornerRows } = dist('practiceLap.js');
const { findCorners } = dist('corners.js');

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

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'trace-road-atlanta-gt3.json'), 'utf8'));
const L = fixture.trackLengthM;
const ref = cleanCols(fixture.trace);
const corners = findCorners({ ...ref }, L);
const copy = () => JSON.parse(JSON.stringify(ref));

/** A corner with a braking zone and a long run to the next corner, for clean planting. */
function pickCorner() {
  for (let i = 0; i + 1 < corners.length; i++) {
    const c = corners[i];
    const e = cornerErrors(ref, ref, corners, i, L);
    const gapM = (corners[i + 1].entryD - c.exitD) * L;
    if (e.brakeOnM !== null && e.pickupM !== null && gapM > 250) return i;
  }
  return 0;
}
const K = pickCorner();
const C = corners[K];
const inSpan = (d, a, b) => d >= a && d <= b;

console.log(`\n§1 a lap against itself (${corners.length} corners; planted faults go in C${K + 1})`);
{
  const s = scoreLap(ref, ref, corners, L);
  check('lap total is 100', s.score && s.score.total === 100, JSON.stringify(s.score));
  check('every part is 100', s.score && ['braking', 'throttle', 'line', 'speed'].every((p) => s.score[p] === 100));
  check('every corner is 100', s.corners.every((c) => c && c.total === 100));
  check('nothing to gain anywhere', s.pointsToGain.every((p) => p === 0));
}

/** Score a lap with one planted fault; report corner K's parts and whether anything else moved. */
function planted(mutate) {
  const lap = copy();
  mutate(lap);
  const s = scoreLap(lap, ref, corners, L);
  const others = s.corners.filter((c, i) => i !== K && (!c || c.total !== 100)).length;
  return { s, k: s.corners[K], others };
}

console.log('\n§2 each fault lowers its own part, in its own corner');
{
  // Braking 15 m early: the brake column read 15 m further on, through the zone.
  const sh = 15 / L;
  const from = C.entryD - 140 / L;
  const r = planted((lap) => {
    const src = ref.brake;
    lap.brake = ref.d.map((d, i) => {
      if (!inSpan(d, from, C.apexD)) return src[i];
      let j = i;
      while (j + 1 < ref.d.length && ref.d[j] < d + sh) j++;
      return src[j];
    });
  });
  check('braking 15 m early: braking drops', r.k.braking < 100, JSON.stringify(r.k));
  check('…throttle, line and speed stay at 100', r.k.throttle === 100 && r.k.line === 100 && r.k.speed === 100);
  check('…no other corner moves', r.others === 0, r.others);
}
{
  // A slow pick-up: part throttle for 60 m after the apex.
  const r = planted((lap) => {
    lap.throttle = ref.throttle.map((v, i) => (inSpan(ref.d[i], C.apexD, C.apexD + 60 / L) ? Math.min(v, 0.5) : v));
  });
  check('a slow pick-up: throttle drops', r.k.throttle < 100, JSON.stringify(r.k));
  check('…braking, line and speed stay at 100', r.k.braking === 100 && r.k.line === 100 && r.k.speed === 100);
  check('…no other corner moves', r.others === 0, r.others);
}
{
  const r = planted((lap) => {
    lap.x = ref.x.map((v, i) => (inSpan(ref.d[i], C.entryD, C.exitD) ? v + 3 : v));
  });
  check('3 m off the line: line drops', r.k.line < 100, JSON.stringify(r.k));
  check('…braking, throttle and speed stay at 100', r.k.braking === 100 && r.k.throttle === 100 && r.k.speed === 100);
  check('…no other corner moves', r.others === 0, r.others);
}
{
  const r = planted((lap) => {
    lap.speedKph = ref.speedKph.map((v, i) => (inSpan(ref.d[i], C.entryD, C.exitD) ? v - 10 : v));
  });
  check('10 km/h down at the apex: speed drops', r.k.speed < 100, JSON.stringify(r.k));
  check('…braking, throttle and line stay at 100', r.k.braking === 100 && r.k.throttle === 100 && r.k.line === 100);
  check('…no other corner moves', r.others === 0, r.others);
}

console.log('\n§3 speed is one-sided');
{
  const r = planted((lap) => {
    lap.speedKph = ref.speedKph.map((v, i) => (inSpan(ref.d[i], C.entryD, C.exitD) ? v + 10 : v));
  });
  check('10 km/h FASTER at the apex costs nothing', r.k.speed === 100 && r.k.total === 100, JSON.stringify(r.k));
}

console.log('\n§4 bigger error, fewer points');
{
  const e0 = cornerErrors(ref, ref, corners, K, L);
  const series = (key, values) =>
    values.map((v) => scoreCorner({ ...e0, [key]: v }));
  const strictlyDown = (xs, part) => xs.every((s, i) => i === 0 || s[part] < xs[i - 1][part]);
  check('braking point: 5 → 10 → 20 → 40 m', strictlyDown(series('brakeOnM', [5, 10, 20, 40]), 'braking'));
  check('line: 0.5 → 1 → 2 → 4 m', strictlyDown(series('lineM', [0.5, 1, 2, 4]), 'line'));
  check('apex: −2 → −5 → −10 → −20 km/h', strictlyDown(series('apexKph', [-2, -5, -10, -20]), 'speed'));
  check('late pick-up: 10 → 30 → 60 → 120 m', strictlyDown(series('pickupM', [10, 30, 60, 120]), 'throttle'));
  const early = scoreCorner({ ...e0, pickupM: -40 }).throttle;
  const late = scoreCorner({ ...e0, pickupM: 40 }).throttle;
  check('an early pick-up costs less than an equally late one', early > late, `${early.toFixed(1)} > ${late.toFixed(1)}`);
}

console.log('\n§5 a part that cannot be measured drops out');
{
  const lap = copy();
  delete lap.x;
  delete lap.z;
  const s = scoreLap(lap, ref, corners, L);
  check('no driven line: line is null, not 0 or 100', s.score && s.score.line === null, JSON.stringify(s.score));
  check('…and the total is still 100 from the other parts', s.score.total === 100);
  const e = { brakeOnM: 10, brakeOffM: null, pickupM: null, flatPts: null, lineM: null, apexKph: -12.5, refSec: 2, deltaSec: 0.1 };
  const sc = scoreCorner(e);
  const w = SCORING.weights;
  const expect = (sc.braking * w.braking + sc.speed * w.speed) / (w.braking + w.speed);
  check('only braking and speed measured: total is their weighted mean', Math.abs(sc.total - expect) < 1e-9 && sc.throttle === null && sc.line === null);
  const none = { brakeOnM: null, brakeOffM: null, pickupM: null, flatPts: null, lineM: null, apexKph: null, refSec: 1, deltaSec: null };
  check('nothing measured: no score at all', scoreCorner(none) === null);
}

console.log('\n§6 corner weighting and points to gain');
{
  const mk = (total, refSec) => ({ e: { refSec }, s: { total, braking: total, throttle: null, line: null, speed: null } });
  const lap = lapFromCorners([mk(50, 1), mk(100, 3)]);
  check('a 1 s corner at 50 and a 3 s corner at 100 make 88 (87.5)', lap.score.total === 88, lap.score.total);
  check('pointsToGain: 12.5 in the short corner, 0 in the long one', lap.pointsToGain[0] === 12.5 && lap.pointsToGain[1] === 0, lap.pointsToGain.join(','));
  const swapped = lapFromCorners([mk(50, 3), mk(100, 1)]);
  check('the same 50 in the LONG corner costs more (63)', swapped.score.total === 63, swapped.score.total);

  const faulty = copy();
  faulty.speedKph = ref.speedKph.map((v, i) => (inSpan(ref.d[i], C.entryD, C.exitD) ? v - 10 : v));
  const s = scoreLap(faulty, ref, corners, L);
  const sum = s.pointsToGain.reduce((a, b) => a + b, 0);
  check('on a real lap, pointsToGain adds up to 100 − total (within rounding)', Math.abs(sum - (100 - s.score.total)) <= 0.6 + corners.length * 0.05, `${sum.toFixed(1)} vs ${100 - s.score.total}`);
  check('…and all of it is in the faulty corner', s.pointsToGain.every((p, i) => (i === K ? p > 0 : p === 0)));
}

console.log('\n§7 the debrief, the lap view and the trend carry the score');
{
  const rows = cornerRows(ref, ref, corners, L);
  check('lap view rows: score 100 and nothing to gain against itself', rows.every((r) => r.score && r.score.total === 100 && r.pointsToGain === 0));

  // A two-lap session: the lap itself (the session best) and a slower copy.
  const slow = JSON.parse(JSON.stringify(fixture.trace));
  slow.speedKph = slow.speedKph.map((v, i) => (inSpan(slow.d[i], C.entryD, C.exitD) ? v - 10 : v));
  slow.t = slow.t.map((t) => t * 1.01);
  const lapMs = Math.round(fixture.trace.lapSec * 1000);
  const lap = (id, no, ms) => ({ id, at: `2026-10-08T10:0${no}:00.000Z`, lapNo: no, lapMs: ms, clean: true, timed: true, hasTrace: true });
  const session = {
    id: 's1', track: 'Road Atlanta', car: 'car', carClass: 'GT3', trackLengthM: L, sessionType: 'practice',
    startedAt: '2026-10-08T10:00:00.000Z', endedAt: '2026-10-08T10:10:00.000Z',
    stints: [{ laps: [lap('best', 1, lapMs), lap('slow', 2, Math.round(lapMs * 1.01))] }],
  };
  const traces = new Map([['best', { trace: fixture.trace }], ['slow', { trace: slow }]]);
  const review = buildPracticeReview({ session, traces, target: null });
  const best = review.laps.find((l) => l.lapNo === 1);
  const slowLap = review.laps.find((l) => l.lapNo === 2);
  check('the target lap scores 100 against itself', best.score && best.score.total === 100);
  check('…but is left out of the session average and best', review.score.avg === slowLap.score.total && review.score.bestLapNo === 2, JSON.stringify(review.score));
  check('the slower lap scores below 100', slowLap.score.total < 100, slowLap.score.total);
  check('lap corners carry their score', slowLap.corners[K].score && slowLap.corners[K].score.speed < 100);
  check('the corner summary averages it', review.corners[K].avgScore === slowLap.corners[K].score.total, review.corners[K].avgScore);

  // The trend reads the same reviews off disk.
  const { loadPracticeTrend, clearPracticeTrendCache } = dist('practiceTrend.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-trend-'));
  try {
    check('trend: no track key, no points', loadPracticeTrend({ trackKey: '', carClass: 'GT3' }, { reviewDir: tmp, lapDir: tmp, traceDir: tmp }).length === 0);
    clearPracticeTrendCache();
    check('trend: an empty lap log, no points', loadPracticeTrend({ trackKey: 'x_1', carClass: 'GT3' }, { reviewDir: tmp, lapDir: tmp, traceDir: tmp }).length === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
