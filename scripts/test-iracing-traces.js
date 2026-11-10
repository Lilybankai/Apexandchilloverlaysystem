/**
 * scripts/test-iracing-traces.js — lap traces, pace deltas and sector splits
 * for iRacing (telemetry/iracing/irLapTrace.ts + its wiring in the provider).
 * -----------------------------------------------------------------------------
 * The failures that matter are all silent:
 *   - a trace whose `lapMs` is not EXACTLY its lap record's — the board's
 *     Compare button needs `lap_traces.lap_ms = driver_best_laps.lap_ms`;
 *   - a trace that does not cover the lap, or pairs with the wrong lap;
 *   - a driven line that is invented (the reference outline at the car's lap
 *     fraction is the same every lap — not a line) or drawn off the map;
 *   - four iRacing sectors squeezed into three named ones;
 *   - a tow across the line timed as a short lap and adopted as a best.
 *
 * Part 1 replays the committed anonymised capture (scripts/fixtures/
 * iracing-cap1, Winton, ~3 Hz) through the real provider. Part 2 drives the
 * capture class with synthetic laps on a circle, where the right answer is
 * known exactly.
 *
 * Everything runs against a private home directory (USERPROFILE/HOME), so no
 * lap, trace, map or PB file of the driver's is read or written.
 *
 * Run: npm run build && node scripts/test-iracing-traces.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-irtrace-test-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const dist = (m) => require(path.join(__dirname, '..', 'dist', 'telemetry', m));
const { CaptureSource } = dist('iracing/captureSource.js');
const { IRacingProvider } = dist('iracing/iracingProvider.js');
const {
  IracingLapCapture,
  sectorSplitsFromTrace,
  sectorOf,
  fitDrivenLine,
  LINE_MAX_RMS_M,
} = dist('iracing/irLapTrace.js');
const { mapKeyForLap } = dist('lapDetail.js');
const { trackKey } = dist('trackMap.js');
const { UNKNOWN_VALUE } = dist('types.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
}

/* ------------------------------------------------------------------------- */
console.log('\n1) Fixture replay through the provider (Winton, qualifying + race)');

const fixtureDir = path.join(__dirname, 'fixtures', 'iracing-cap1');
const laps = [];
const files = [];
const frames = [];
{
  const src = new CaptureSource(fixtureDir);
  const p = new IRacingProvider(
    { verbose: false },
    { source: src, lapSink: (r) => laps.push(r), traceSink: (f) => files.push(f), persistReferences: false },
  );
  p.start();
  let lastNow = 0;
  while (!src.done()) {
    const t = src.peekTime();
    const now = Number.isFinite(t) ? t : lastNow + 100;
    lastNow = now;
    const fr = p.poll(now, 100);
    if (src.done()) break;
    if (fr.connected) frames.push({ type: fr.session.type, pd: fr.player.paceDeltas, onTrack: fr.session.onTrack, lap: fr.player.lap });
  }
  p.stop();
}

const timed = laps.filter((r) => r.lapMs > 0);
const byId = new Map(files.map((f) => [f.lapId, f]));
check('the fixture logs its four timed laps', timed.length === 4, timed.map((r) => r.lapMs).join(' '));
check('every timed lap has a trace file', timed.every((r) => byId.has(r.id)), `${files.length} files`);
check(
  'trace file lapMs is EXACTLY the record lapMs (board Compare rule)',
  files.every((f) => laps.find((r) => r.id === f.lapId).lapMs === f.lapMs),
);
check('trace files are iRacing, on the ir-<TrackID> key', files.every((f) => f.sim === 'iracing' && /^ir-\d+$/.test(f.trackKey)));
const flying = timed.filter((r) => {
  const f = byId.get(r.id);
  return f && Math.abs(f.trace.lapSec * 1000 - r.lapMs) < 250;
});
// The race's first lap is timed by iRacing from the start, not the line, so
// exactly one lap is allowed to disagree (and it must still be within 2 s).
check('measured lap time agrees with the sim to <100 ms on flying laps', flying.length === 3 &&
  flying.every((r) => Math.abs(byId.get(r.id).trace.lapSec * 1000 - r.lapMs) < 100),
  flying.map((r) => Math.round(byId.get(r.id).trace.lapSec * 1000 - r.lapMs)).join(' ') + ' ms');
check('distance coverage is complete (starts <1%, ends >99%, no gap >1%)', files.every((f) => {
  const d = f.trace.d;
  let gap = 0;
  for (let i = 1; i < d.length; i++) gap = Math.max(gap, d[i] - d[i - 1]);
  return d[0] < 0.01 && d[d.length - 1] > 0.99 && gap < 0.01;
}));
check('channels are populated (speed, throttle, brake, gear, steer)', files.every((f) => {
  const t = f.trace;
  return Math.max(...t.speedKph) > 100 && Math.max(...t.throttle) > 0.9 && Math.max(...t.brake) > 0.3 &&
    Math.max(...t.gear) >= 3 && Math.min(...t.steer) < 0 && Math.max(...t.steer) > 0;
}));
// At ~3 Hz the line cannot be integrated (ticks > 0.25 s apart) — it must be
// left off, never filled from the reference outline.
check('no driven line is invented when the lap could not be integrated', files.every((f) => f.v === 1 && !f.trace.x && !f.trace.z));
const fourSector = flying.map((r) => r);
check('Winton has four sectors: sectorsMs carries all four, s1..s3 stay absent',
  fourSector.every((r) => Array.isArray(r.sectorsMs) && r.sectorsMs.length === 4 && r.s1Ms === undefined),
  fourSector.map((r) => (r.sectorsMs || []).join('/')).join(' '));
check('sector splits sum to the lap time exactly', fourSector.every((r) => r.sectorsMs.reduce((a, b) => a + b, 0) === r.lapMs));
check('the start lap (timed from the green) gets no scaled sectors', timed.filter((r) => !flying.includes(r)).every((r) => !r.sectorsMs));
check('trace files carry the same sectors as their record', files.every((f) => {
  const r = laps.find((x) => x.id === f.lapId);
  return JSON.stringify(f.sectorsMs) === JSON.stringify(r.sectorsMs);
}));

const driving = frames.filter((f) => f.onTrack && f.pd);
check('paceDeltas published while driving', driving.length > 1500, `${driving.length} frames`);
const withSession = driving.filter((f) => f.pd.tSession !== UNKNOWN_VALUE && f.pd.predictedLapSec !== UNKNOWN_VALUE);
check('session-best delta and predicted lap fill in after the first flying lap', withSession.length > 500, `${withSession.length} frames`);
// Predicted lap at the last sample before each line vs the lap the sim then timed.
const preds = [];
for (let i = 1; i < frames.length; i++) {
  const a = frames[i - 1].pd;
  const b = frames[i].pd;
  if (a && b && a.predictedLapSec !== UNKNOWN_VALUE && a.lapTimeSec > 60 && b.lapTimeSec !== UNKNOWN_VALUE && b.lapTimeSec < 5 && b.lastLapSec !== UNKNOWN_VALUE) {
    preds.push({ pred: a.predictedLapSec, actual: b.lastLapSec });
  }
}
check('predicted lap at the line is within 0.25 s of the lap just completed',
  preds.length >= 2 && preds.every((x) => Math.abs(x.pred - x.actual) < 0.25),
  preds.map((x) => `${x.pred}→${x.actual}`).join(' '));
let maxStep = 0;
for (let i = 1; i < driving.length; i++) {
  const a = driving[i - 1].pd, b = driving[i].pd;
  if (a.tSession !== UNKNOWN_VALUE && b.tSession !== UNKNOWN_VALUE && b.lapTimeSec > a.lapTimeSec && b.lapTimeSec - a.lapTimeSec < 0.5) {
    maxStep = Math.max(maxStep, Math.abs(b.tSession - a.tSession) / (b.lapTimeSec - a.lapTimeSec));
  }
}
check('Delta T never moves faster than the slew limit (1.5 s/s)', maxStep <= 1.5 + 1e-6, maxStep.toFixed(3));
check('lap.sector stays UNKNOWN on a four-sector circuit (contract is 1..3)', frames.every((f) => f.lap.sector === UNKNOWN_VALUE));
check('nothing was written into the home directory by a test-sink provider',
  !fs.existsSync(path.join(home, '.apex-overlay', 'traces')) && !fs.existsSync(path.join(home, '.apex-overlay', 'pb')));

/* ------------------------------------------------------------------------- */
console.log('\n2) Synthetic laps on a circle');

const R = 300;
const L = 2 * Math.PI * R;
const mapPoints = Array.from({ length: 400 }, (_, i) => {
  const th = (i / 400) * 2 * Math.PI;
  return [R * Math.cos(th), R * Math.sin(th), 0];
});
const map = { points: mapPoints };
const SECT3 = [0, 1 / 3, 2 / 3];

/**
 * Drive `nLaps` laps of the circle at `v` m/s, ticking at `hz`. `radiusAt(pct)`
 * sets the driven radius (the line); `headingErr` skews the yaw the integrator
 * sees (a drifting line). Returns the capture and the records it attached.
 */
function drive({ nLaps = 3, v = 40, hz = 30, radiusAt = () => R, headingErr = 0, teleportAt = -1, startPct = 0.5, cap = new IracingLapCapture() } = {}) {
  const lapSec = L / v;
  const dt = 1 / hz;
  let st = 100;
  let wall = 1_000_000;
  const out = { cap, deltas: [], laps: [] };
  let progress = startPct;
  let lapNo = 0;
  let teleported = false;
  while (progress < startPct + nLaps) {
    const pct = progress % 1;
    const r = radiusAt(pct);
    const tick = (p, speed) => ({
      wallMs: wall, sessionTime: st, pct: p, driving: true, trackLengthM: L, refKey: '', bestLapSec: -1,
      inPit: false, surface: 3, incidents: 0, speedMps: speed,
      velX: speed * (r / R), velY: 0, yaw: p * 2 * Math.PI + Math.PI / 2 + headingErr * p,
      channels: { throttle: 1, brake: 0, steer: 0.1, gear: 4, speedKph: speed * 3.6, latG: 0.5, lonG: 0, tc: 0, abs: 0 },
    });
    if (!teleported && teleportAt >= 0 && progress > teleportAt) {
      // A tow: the lap fraction jumps across the line with the car stopped.
      teleported = true;
      progress = Math.ceil(progress) + 0.04;
      st += dt;
      wall += dt * 1000;
      out.deltas.push(cap.update(tick(progress % 1, 0)));
      continue;
    }
    const pd = cap.update(tick(pct, v));
    out.deltas.push(pd);
    const before = Math.floor(progress);
    progress += dt / lapSec;
    st += dt;
    wall += dt * 1000;
    if (Math.floor(progress) !== before && progress > 1) {
      lapNo++;
      // The lap record, as LapGate publishes it ~2 s after the line.
      out.laps.push({ lapMs: Math.round(lapSec * 1000), wall: wall + 2000 });
    }
  }
  return out;
}

function record(lapMs, wallMs, over = {}) {
  return {
    v: 7, id: `lap-${wallMs}`, at: new Date(wallMs).toISOString(), sim: 'iracing', track: 'Test Ring', trackKey: 'ir-1',
    trackLengthM: Math.round(L), car: 'Car', carClass: 'GT3', lapMs, distanceM: Math.round(L), sessionType: 'practice',
    clean: true, dirty: [], ...over,
  };
}

{
  const run = drive({ nLaps: 3 });
  check('two full laps complete on a three-lap run started mid-lap', run.cap.pendingCount() === 2, run.cap.pendingCount());
  const [l1, l2] = run.laps.slice(1);
  const a1 = run.cap.attach(record(l1.lapMs, l1.wall), map, SECT3);
  check('a record pairs with its trace by wall clock + lap time', !!a1.file);
  check('the attached file keeps the record lapMs exactly', a1.file && a1.file.lapMs === l1.lapMs);
  check('three sectors fill s1Ms..s3Ms, not sectorsMs',
    a1.record.s1Ms > 0 && a1.record.s2Ms > 0 && a1.record.s3Ms > 0 && !a1.record.sectorsMs,
    `${a1.record.s1Ms}/${a1.record.s2Ms}/${a1.record.s3Ms}`);
  check('equal thirds of a constant-speed lap split equally (±20 ms)',
    Math.abs(a1.record.s1Ms - l1.lapMs / 3) < 20 && Math.abs(a1.record.s2Ms - l1.lapMs / 3) < 20);
  check('the integrated lap fits the map as a v2 driven line', a1.file.v === 2 && a1.line && a1.line.ok && a1.line.rmsM < 0.5, a1.line && a1.line.rmsM);
  check('line columns are index-aligned with the trace', a1.file.trace.x.length === a1.file.trace.d.length && a1.file.trace.z.length === a1.file.trace.d.length);
  const a2 = run.cap.attach(record(l2.lapMs, l2.wall + 60_000), map, SECT3);
  check('a record with no trace near it in time does not steal one', a2.file === null);
  const a3 = run.cap.attach(record(l2.lapMs + 5000, l2.wall), map, SECT3);
  check('a record whose lap time disagrees by >2 s is refused its trace', a3.file === null);
  const deltas = run.deltas.filter(Boolean);
  const last = deltas[deltas.length - 1];
  check('identical laps read a ~zero session delta', last && last.tSession !== UNKNOWN_VALUE && Math.abs(last.tSession) < 0.02, last && last.tSession);
}

{
  // A line 3 m wide of the map through the second half of the lap: still a
  // line on the circuit, and the fit must show it rather than smooth it away.
  const run = drive({ nLaps: 2.2, startPct: 0.9, radiusAt: (p) => (p > 0.5 ? R + 3 : R) });
  const lap = run.laps[run.laps.length - 1];
  const a = run.cap.attach(record(lap.lapMs, lap.wall), map, SECT3);
  check('a genuinely different line is kept (RMS a few metres, under the bound)', a.file && a.file.v === 2 && a.line.rmsM > 0.5 && a.line.rmsM < LINE_MAX_RMS_M, a.line && a.line.rmsM);
}

{
  // A yaw error growing over the lap: the integral does not describe a path on
  // this map, and must not be drawn.
  const run = drive({ nLaps: 2.2, startPct: 0.9, headingErr: 0.4 });
  const lap = run.laps[run.laps.length - 1];
  const a = run.cap.attach(record(lap.lapMs, lap.wall), map, SECT3);
  check('a drifting integral is dropped: v1, no x/z', a.file && a.file.v === 1 && !a.file.trace.x && a.line && !a.line.ok, a.line && a.line.rmsM);
}

{
  const run = drive({ nLaps: 2.2, startPct: 0.9, hz: 30 });
  const lap = run.laps[run.laps.length - 1];
  const a = run.cap.attach(record(lap.lapMs, lap.wall), null, SECT3);
  check('no map yet: the trace is written without a line', a.file && a.file.v === 1 && !a.file.trace.x);
}

{
  // Tow from 97% across the line: must not complete a lap or set a best.
  const run = drive({ nLaps: 1.6, startPct: 0.5, teleportAt: 1.97 });
  // startPct 0.5 → first crossing at progress 1 (fragment), tow at 1.97.
  check('a tow across the line completes no trace', run.cap.pendingCount() === 0, run.cap.pendingCount());
  const pds = run.deltas.filter(Boolean);
  check('…and adopts no session best', pds.every((p) => p.refSessionSec === UNKNOWN_VALUE));
}

{
  // The last lap of a session lands after the session has changed (the lap
  // log flushes the held record on the stint change).
  const run = drive({ nLaps: 2.2, startPct: 0.9 });
  const lap = run.laps[run.laps.length - 1];
  run.cap.resetSession();
  const a = run.cap.attach(record(lap.lapMs, lap.wall), map, SECT3);
  check('a pending trace survives the session change and still pairs', !!a.file);
}

/* ------------------------------------------------------------------------- */
console.log('\n3) Pure helpers');

{
  // Constant pace on a 90 s trace; the sim timed the lap at 90.9 s, so every
  // split scales by 1 % and the four still sum to the sim's time.
  const d = Array.from({ length: 101 }, (_, i) => i / 100);
  const trace = { lapSec: 90, d, t: d.map((x) => x * 90) };
  const four = sectorSplitsFromTrace(trace, [0, 0.25, 0.5, 0.75], 90900);
  check('sectorSplitsFromTrace: four sectors, scaled to the sim lap', JSON.stringify(four) === JSON.stringify([22725, 22725, 22725, 22725]), four && four.join('/'));
  check('sectorSplitsFromTrace: a hole across a boundary gives none', sectorSplitsFromTrace({ lapSec: 90, d: [0, 0.2, 0.3, 1], t: [0, 18, 27, 90] }, [0, 0.25], 90000) === null);
  check('sectorSplitsFromTrace: no published sectors gives none', sectorSplitsFromTrace(trace, [0], 90000) === null);
  check('sectorOf maps a fraction to its 1-based sector', sectorOf(0.1, SECT3) === 1 && sectorOf(0.5, SECT3) === 2 && sectorOf(0.9, SECT3) === 3);
  check('sectorOf is UNKNOWN without sectors', sectorOf(0.5, [0]) === UNKNOWN_VALUE);
  check('fitDrivenLine refuses with no map', fitDrivenLine([0, 0.5, 1], [0, 1, 2], [0, 1, 2], null) === null);
}

{
  const lap = { sim: 'iracing', track: 'Winton Motor Raceway - National', trackLengthM: 2946 };
  check('iRacing lap → the map key the provider learns under (no layout)',
    mapKeyForLap(lap) === trackKey('iracing-Winton Motor Raceway - National', undefined, 2946.5), mapKeyForLap(lap));
  const cfg = { sim: 'iracing', track: 'Road Atlanta - Full Course', trackConfig: 'Full Course', trackLengthM: 4088 };
  check('iRacing lap with a layout → venue + layout key',
    mapKeyForLap(cfg) === trackKey('iracing-Road Atlanta', 'Full Course', 4088), mapKeyForLap(cfg));
  const lmu = { sim: 'lmu', track: 'Autodromo Nazionale Monza', trackLengthM: 5793 };
  check('LMU lap key unchanged', mapKeyForLap(lmu) === trackKey('Autodromo Nazionale Monza', undefined, 5793));
}

try {
  fs.rmSync(home, { recursive: true, force: true });
} catch {
  /* temp dir */
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
