/**
 * scripts/test-practicelap.js — one practice lap against its session's target
 * (src/telemetry/practiceLap.ts, Practice Review phase 2).
 * -----------------------------------------------------------------------------
 *   §1 a lap against itself: every corner row is exactly level, line 0 m;
 *   §2 a 1.5 m lateral shift through ONE corner reads ≈1.5 m there and 0 elsewhere;
 *   §3 a planted fault (braked 15 m early, 0.2 s, 6 km/h down) is worded as
 *      the overlay's Corner Analysis card words it;
 *   §4 end to end on disk: no snapshot → the session best; a snapshot → the
 *      chased lap with ITS served corners; the corners are the debrief's; the
 *      delta reads positive = losing.
 *
 * The lap is a real one with a driven line: scripts/fixtures/trace-road-atlanta-gt3.json.
 *
 * Run: node scripts/test-practicelap.js (build first)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cornerRows, lineOffset, cornerTip, loadPracticeLap } = require('../dist/telemetry/practiceLap');
const { cleanCols } = require('../dist/telemetry/practiceReview');
const { loadPracticeReview, sessionFileKey } = require('../dist/telemetry/practiceReviewLoad');
const { listSessions } = require('../dist/telemetry/stintReview');
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

const FIX = require('./fixtures/trace-road-atlanta-gt3.json');
const L = FIX.trackLengthM;
const BASE = FIX.trace;
const BASE_MS = FIX.lapMs;
const CORNERS = findCorners(BASE, L).map((c) => ({ entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
const FULL = findCorners(BASE, L);
const K = FULL.findIndex((c, i) => c.brakeD !== null && i > 0);

function cloneTrace(tr) {
  const out = {};
  for (const [k, v] of Object.entries(tr)) out[k] = Array.isArray(v) ? v.slice() : v;
  return out;
}

/** Braked `shiftM` early/late, `lossSec` lost and `kph` down, all in corner K. */
function faulted({ shiftM = 0, lossSec = 0, kph = 0 } = {}) {
  const tr = cloneTrace(BASE);
  const c = FULL[K];
  const from = c.entryD - 150 / L;
  const n = tr.d.length;
  if (shiftM) {
    for (let i = 0; i < n; i++) {
      const d = tr.d[i];
      if (d < from || d > c.apexD) continue;
      const want = d - shiftM / L;
      let j = 0;
      while (j < n - 1 && BASE.d[j + 1] < want) j++;
      const a = BASE.d[j], b = BASE.d[Math.min(j + 1, n - 1)];
      const f = b > a ? Math.min(1, Math.max(0, (want - a) / (b - a))) : 0;
      tr.brake[i] = BASE.brake[j] + (BASE.brake[Math.min(j + 1, n - 1)] - BASE.brake[j]) * f;
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

/** The lap moved `m` metres sideways (perpendicular to its own heading) inside corner K only. */
function shifted(m) {
  const tr = cloneTrace(BASE);
  const c = FULL[K];
  const n = tr.d.length;
  for (let i = 1; i < n - 1; i++) {
    const d = tr.d[i];
    if (d < c.entryD - 2 / L || d > c.exitD + 2 / L) continue;
    const hx = BASE.x[i + 1] - BASE.x[i - 1];
    const hz = BASE.z[i + 1] - BASE.z[i - 1];
    const len = Math.hypot(hx, hz) || 1;
    tr.x[i] = BASE.x[i] + (-hz / len) * m;
    tr.z[i] = BASE.z[i] + (hx / len) * m;
  }
  return tr;
}

console.log('\n§1 a lap against itself');
{
  const me = cleanCols(BASE);
  const rows = cornerRows(me, me, CORNERS, L);
  check('a row per reference corner, C1..Cn in order', rows.length === CORNERS.length && rows.every((r, i) => r.index === i), rows.length);
  check('every time delta is zero', rows.every((r) => r.deltaSec === 0));
  check('every brake delta is zero (where it braked)', rows.every((r) => r.brakeDeltaM === null || r.brakeDeltaM === 0));
  check('every apex and exit speed is level', rows.every((r) => r.apexKphDelta === 0 && r.exitKphDelta === 0));
  check('the line is 0 m off everywhere', rows.every((r) => r.lineOffsetM === 0), rows.map((r) => r.lineOffsetM).join(','));
  check('min speeds agree', rows.every((r) => r.minKph === r.refMinKph && r.minKph !== null));
  check('…and it says so', rows.every((r) => r.tip === 'Matched the reference here'));
}

console.log('\n§2 a 1.5 m lateral shift through one corner');
{
  const ref = cleanCols(BASE);
  const lap = cleanCols(shifted(1.5));
  const rows = cornerRows(lap, ref, CORNERS, L);
  check(`C${K + 1} reads about 1.5 m off line`, near(rows[K].lineOffsetM, 1.5, 0.25), rows[K].lineOffsetM);
  check('every other corner reads ~0 m', rows.every((r, i) => i === K || near(r.lineOffsetM, 0, 0.05)),
    rows.map((r) => r.lineOffsetM).join(','));
  const noLine = cleanCols({ d: BASE.d, t: BASE.t, speedKph: BASE.speedKph, brake: BASE.brake });
  check('no driven line on one lap → null, never guessed', lineOffset(noLine, ref, CORNERS[K].entryD, CORNERS[K].exitD, L) === null);
}

console.log('\n§3 a planted fault, in the Corner Analysis card\'s words');
{
  const ref = cleanCols(BASE);
  const lap = cleanCols(faulted({ shiftM: -15, lossSec: 0.2, kph: 6 }));
  const rows = cornerRows(lap, ref, CORNERS, L);
  const r = rows[K];
  check(`C${K + 1} lost ≈0.2 s`, near(r.deltaSec, 0.2, 0.01), r.deltaSec);
  check('braked ≈15 m EARLY reads negative', near(r.brakeDeltaM, -15, 1), r.brakeDeltaM);
  check('6 km/h down at the apex', near(r.apexKphDelta, -6, 0.2), r.apexKphDelta);
  check('the tip', r.tip === 'Brake 15 m later: +6 km/h at the apex', r.tip);
  check('the gain wording', cornerTip({ deltaSec: -0.1, brakeDeltaM: 8, apexKphDelta: null }) === 'Braked 8 m later — keep it');
  check('no timing wording', cornerTip({ deltaSec: null, brakeDeltaM: null, apexKphDelta: null }) === 'No timing for this corner');
}

console.log('\n§4 end to end, on disk');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-practicelap-'));
  const laps = path.join(root, 'laps');
  const traces = path.join(root, 'traces');
  const reviews = path.join(root, 'practice-reviews');
  fs.mkdirSync(laps, { recursive: true });
  fs.mkdirSync(reviews, { recursive: true });
  const day = '2026-10-08';
  const rec = {
    v: 6, sim: 'lmu', track: FIX.track, trackKey: FIX.trackKey, trackLengthM: L,
    car: FIX.car, carClass: FIX.carClass, distanceM: L, sessionType: 'practice', clean: true, dirty: [],
  };
  const lapsIn = [
    { id: 'p1', at: `${day}T10:00:00.000Z`, trace: faulted({ lossSec: 0.4 }) },
    { id: 'p2', at: `${day}T10:01:30.000Z`, trace: BASE },
    { id: 'p3', at: `${day}T10:03:00.000Z`, trace: faulted({ shiftM: -15, lossSec: 0.2, kph: 6 }) },
  ];
  fs.writeFileSync(path.join(laps, `${day}.jsonl`), lapsIn
    .map((l) => JSON.stringify({ ...rec, id: l.id, at: l.at, lapMs: Math.round(l.trace.lapSec * 1000) }))
    .join('\n') + '\n');
  for (const l of lapsIn) {
    const dir = path.join(traces, day);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${l.id}.json`), JSON.stringify({
      v: 2, lapId: l.id, at: l.at, sim: 'lmu', trackKey: FIX.trackKey, track: FIX.track, trackLengthM: L,
      car: FIX.car, carClass: FIX.carClass, lapMs: Math.round(l.trace.lapSec * 1000), trace: l.trace,
    }));
  }
  const sessions = listSessions(laps);
  const sid = sessions[0] && sessions[0].id;
  check('the three laps make one practice session', sessions.length === 1 && !!sid, sid);
  const deps = { reviewDir: reviews, lapDir: laps, traceDir: traces };

  const best = loadPracticeLap({ sessionId: sid, lapId: 'p3', at: lapsIn[2].at }, deps);
  check('no snapshot → measured against the session best', best && best.target.kind === 'sessionBest' && best.target.lapId === 'p2',
    best && JSON.stringify(best.target));
  check('the session best comes back in full as `vs`', best && best.vs && best.vs.lapId === 'p2' && best.vs.channels.d.length > 100);
  check('the delta is built and POSITIVE = losing', best && best.delta && best.delta.dt[best.delta.dt.length - 1] > 0.15,
    best && best.delta && best.delta.dt[best.delta.dt.length - 1]);
  const review = loadPracticeReview(sid, deps);
  check('its corners are the debrief\'s, one for one',
    best && review && best.corners.length === review.corners.length
      && best.corners.every((c, i) => c.entryD === review.corners[i].entryD && c.exitD === review.corners[i].exitD));
  check(`C${K + 1} carries the planted fault`, best && near(best.corners[K].deltaSec, 0.2, 0.01) && near(best.corners[K].brakeDeltaM, -15, 1),
    best && `${best.corners[K].deltaSec} s, ${best.corners[K].brakeDeltaM} m`);
  check('the map is not resent when the panel holds it',
    (() => {
      const again = loadPracticeLap({ sessionId: sid, lapId: 'p3', at: lapsIn[2].at, haveMapKey: best.detail.mapKey }, deps);
      return again && again.map === null;
    })());

  // A snapshot of a 2.5%-quicker chased lap, with the corner list it served.
  const k = 0.975;
  const served = CORNERS.slice(0, 6);
  const snapshot = {
    v: 1, track: FIX.track, car: FIX.car, carClass: FIX.carClass, trackLengthM: L,
    startedAt: lapsIn[0].at, endedAt: `${day}T10:05:00.000Z`,
    target: {
      kind: 'chased', label: 'A. Winters · 1:19.299 · board', lapId: 'board:winters', lapSec: (BASE_MS / 1000) * k,
      columns: { ...cloneTrace(BASE), t: BASE.t.map((v) => v * k), lapSec: BASE.lapSec * k, trackLengthM: L, corners: served },
    },
  };
  fs.writeFileSync(path.join(reviews, `${sessionFileKey(sid)}.json`), JSON.stringify(snapshot));
  const chased = loadPracticeLap({ sessionId: sid, lapId: 'p2', at: lapsIn[1].at }, deps);
  check('a snapshot → measured against the chased lap', chased && chased.target.kind === 'chased' && chased.target.label.startsWith('A. Winters'));
  check('…which comes back as `vs`, on the studied lap\'s circuit', chased && chased.vs && chased.vs.lapId === 'board:winters'
    && chased.vs.mapKey === chased.detail.mapKey);
  check('…with the corners it served on track', chased && chased.corners.length === served.length);
  check('a lap 2.5% slower everywhere loses in every corner', chased && chased.corners.every((c) => c.deltaSec > 0),
    chased && chased.corners.map((c) => c.deltaSec).join(','));
  check('unknown lap → null', loadPracticeLap({ sessionId: sid, lapId: 'nope', at: '' }, deps) === null);
  check('unknown session → null', loadPracticeLap({ sessionId: 'nope', lapId: 'p1', at: '' }, deps) === null);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
