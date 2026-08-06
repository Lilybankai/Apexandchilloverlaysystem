/**
 * scripts/test-laptrace.js — the training-trace recorder and its store.
 * -----------------------------------------------------------------------------
 * The trace recorder is the capture side of the training feature: every flying
 * lap becomes a distance-indexed curve of what the driver did. Its failure
 * modes are all silent — a lap that quietly recorded nothing, a fragment kept
 * as if it were a lap, a file written that cannot be matched back to its
 * record — so each case drives the real recorder through a synthetic stint at
 * frame rate and asserts on what came out.
 *
 * The sector-split maths in lapLog is exercised here too, against the exact
 * shapes the live probe saw on 2026-08-06: cumulative boundaries on a valid
 * lap, `-1` on an invalidated one, and a torn pair.
 *
 * Run: node scripts/test-laptrace.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LapTraceRecorder,
  writeTrace,
  readTrace,
  traceFilePath,
  pruneTraces,
  TRACE_KEEP_DAYS,
} = require('../dist/telemetry/lapTrace');
const { LapRecorder, VERDICT_HOLD_MS } = require('../dist/telemetry/lapLog');

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

/** Flat channels — tests that care about a channel set it explicitly. */
function ch(over) {
  return {
    throttle: 0.8,
    brake: 0,
    steer: 0.05,
    gear: 4,
    speedKph: 180,
    latG: 0.4,
    lonG: -0.2,
    tc: 0,
    abs: 0,
    ...over,
  };
}

/**
 * A car the tests can drive: continuous position and clock, stepped through
 * the recorder at ~30 Hz the way `buildFrame` feeds the real one. `lap()`
 * advances exactly one lap's worth of road; both state variables persist
 * between calls, because that is the property the sloppy first version of
 * this harness violated — a position that teleports between laps exercises
 * the reset paths, not the recording path.
 */
function rig(rec, startD = 0, startT = 100) {
  let d = startD;
  let t = startT;
  return {
    /** Drive `lapSec` seconds covering one full lap. Returns any emitted trace. */
    lap(lapSec, opts = {}) {
      const steps = Math.round(lapSec * 30);
      let out = null;
      for (let i = 1; i <= steps; i++) {
        d += 1 / steps;
        if (d >= 1) d -= 1;
        t += lapSec / steps;
        const done = rec.update(d, t, ch(opts.channels ? opts.channels(d) : {}));
        if (done) out = done;
      }
      return out;
    },
    /** Sit still (or crawl) for `sec` seconds at ~5 Hz. */
    park(sec, over = {}) {
      for (let i = 1; i <= sec * 5; i++) {
        t += 0.2;
        rec.update(d, t, ch({ speedKph: 0, gear: 0, ...over }));
      }
    },
    /** Jump the clock (feed gap / rewind). */
    warp(sec) {
      t += sec;
    },
    get t() {
      return t;
    },
  };
}

console.log('\n— a full lap records, a fragment does not —');
{
  const rec = new LapTraceRecorder();
  const car = rig(rec, 0.4);
  // The first pass over the line only arms the recorder; the "lap" before it
  // began mid-track and must not be emitted.
  const armed = car.lap(90);
  check('the fragment before the first crossing is not a lap', armed === null);
  const lap = car.lap(90);
  check('the first flag-to-flag lap is emitted', lap !== null);
  check('its measured time is the driven time', lap && Math.abs(lap.lapSec - 90) < 0.5, lap && lap.lapSec);
  check('columns are index-aligned', lap && lap.d.length === lap.count && lap.throttle.length === lap.count);
  check('it resolves braking zones (>=500 points on a 90 s lap)', lap && lap.count >= 500, lap && lap.count);
  const dSorted = lap && lap.d.every((v, i) => i === 0 || v >= lap.d[i - 1]);
  check('distance is monotonic', !!dSorted);
}

console.log('\n— channels land in the right columns —');
{
  const rec = new LapTraceRecorder();
  const car = rig(rec, 0.5);
  car.lap(90);
  // Brake hard only in the middle third of the lap.
  const lap = car.lap(90, {
    channels: (d) => (d > 0.33 && d < 0.66 ? { brake: 1, throttle: 0 } : {}),
  });
  // The rig starts at d=0.5, so the emitted lap holds the braking zone in its
  // 0.50–0.66 stretch (the second call's first half) — sample inside and out.
  const mid = lap.d.findIndex((v) => v > 0.55);
  const outside = lap.d.findIndex((v) => v > 0.75);
  check('brake trace shows the braking zone', lap.brake[mid] === 1 && lap.throttle[mid] === 0);
  check('and nothing outside it', lap.brake[outside] === 0 && lap.throttle[outside] === 0.8);
}

console.log('\n— a stationary car keeps recording on the time backstop —');
{
  // Hand-rolled: drive 40% of a lap, spin to a stop for 20 s, finish the lap.
  const rec = new LapTraceRecorder();
  let d = 0.9;
  let t = 100;
  const step = (dd, dt, over) => {
    d = (d + dd) % 1;
    t += dt;
    return rec.update(d, t, ch(over || {}));
  };
  // Two crossings set up a recording lap that starts at the line: the first
  // arms, the second (during the 0.4 leg below, a quarter in) begins the lap
  // that will contain the stop.
  for (let i = 0; i < 90 * 30; i++) step(1 / (90 * 30), 1 / 30); // arming lap, back to d=0.9
  let out = null;
  for (let i = 0; i < 40 * 30; i++) out = step(0.4 / (40 * 30), 1 / 30) || out;
  out = null; // that crossing emitted the arming lap's successor — not under test
  for (let i = 0; i < 20 * 5; i++) out = step(0, 0.2, { speedKph: 0, gear: 0 }) || out;
  for (let i = 0; i < 50 * 30; i++) out = step(0.8 / (50 * 30), 1 / 30) || out;
  check('the lap with a stop in it still completes', out !== null);
  const parked = out && out.speedKph.filter((v) => v === 0).length;
  // 20 s at one time-backstop sample per 0.6 s (0.2 s polls × the 0.5 s gap).
  check('the stop itself is sampled (>=30 zero-speed points in 20 s)', parked >= 30, parked);
}

console.log('\n— resets: rewind, long gap —');
{
  const rec = new LapTraceRecorder();
  const car = rig(rec, 0.7, 1000);
  car.lap(90);
  // Session restart: the clock rewinds. Nothing may complete off mixed clocks.
  const rewound = rig(rec, 0.7, 10);
  const lap = rewound.lap(90);
  check('a clock rewind starts over instead of emitting', lap === null);
  // And a feed gap mid-lap voids the lap in progress: three crossings — arm,
  // one clean lap, then a lap with a 10 s hole in its middle. Exactly one lap
  // may come out, and it must be the clean one.
  const rec2 = new LapTraceRecorder();
  let d2 = 0.5; // mid-track start, so crossings fall mid-leg, not on leg seams
  let t2 = 100;
  const emitted = [];
  const step2 = (dd, dt) => {
    d2 = (d2 + dd) % 1;
    t2 += dt;
    const done = rec2.update(d2, t2, ch({}));
    if (done) emitted.push(done);
  };
  for (let i = 0; i < 90 * 30; i++) step2(1 / (90 * 30), 1 / 30); // crossing mid-leg arms
  for (let i = 0; i < 90 * 30; i++) step2(1 / (90 * 30), 1 / 30); // clean lap emits at ITS mid-leg crossing
  for (let i = 0; i < 30 * 30; i++) step2(0.33 / (30 * 30), 1 / 30); // next lap, a third in…
  t2 += 10; // …the feed drops for 10 s…
  for (let i = 0; i < 60 * 30; i++) step2(0.67 / (60 * 30), 1 / 30); // …then it finishes at the line
  check('only the clean lap came out of three crossings', emitted.length === 1, emitted.length);
  check(
    'and it is the clean one, not the gap-straddler',
    emitted.length === 1 && Math.abs(emitted[0].lapSec - 90) < 0.5,
    emitted[0] && emitted[0].lapSec,
  );
}

console.log('\n— store: write, read back, prune —');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-traces-'));
  const rec = new LapTraceRecorder();
  const car = rig(rec, 0.3);
  car.lap(90);
  const trace = car.lap(90);
  const at = new Date('2026-08-06T20:00:00Z').toISOString();
  const file = {
    v: 1,
    lapId: 'test-lap-id',
    at,
    sim: 'lmu',
    trackKey: 'algarve_4653',
    track: 'Algarve',
    trackLengthM: 4653,
    car: 'BMW GT3',
    carClass: 'GT3',
    lapMs: 90123,
    s1Ms: 27890,
    s2Ms: 48310,
    s3Ms: 13923,
    trace,
  };
  writeTrace(file, dir);
  const back = readTrace('test-lap-id', at, dir);
  check('a written trace reads back whole', back !== null && back.trace.count === trace.count);
  check('sectors survive the round trip', back && back.s1Ms === 27890 && back.s3Ms === 13923);
  check('an unknown id reads as null', readTrace('nope', at, dir) === null);
  check('the file sits in its UTC day folder', fs.existsSync(path.join(dir, '2026-08-06', 'test-lap-id.json')));
  // A trace ~90 s of racing must stay a sane size on disk.
  const bytes = fs.statSync(traceFilePath('test-lap-id', at, dir)).size;
  check('file size is tens of KB, not MB', bytes > 5_000 && bytes < 200_000, `${Math.round(bytes / 1024)} KB`);

  // Prune: a day inside the window survives, one outside it goes.
  const oldAt = new Date(Date.parse(at) - (TRACE_KEEP_DAYS + 5) * 86_400_000).toISOString();
  writeTrace({ ...file, lapId: 'old-lap', at: oldAt }, dir);
  pruneTraces(Date.parse(at), dir);
  check('pruning removes days past retention', readTrace('old-lap', oldAt, dir) === null);
  check('and keeps days inside it', readTrace('test-lap-id', at, dir) !== null);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n— sector splits on the lap record (live-probed shapes) —');
{
  // Drive the real LapRecorder to a completed lap and read the splits off the
  // record, with the boundary values the 2026-08-06 probe saw.
  const runStint = (sectors) => {
    const r = new LapRecorder();
    const base = {
      sim: 'lmu',
      track: 'Algarve',
      trackLengthM: 4653,
      car: 'BMW GT3',
      carClass: 'GT3',
      sessionType: 'race',
      lapsCompleted: 0,
      lastLapSec: -1,
      inPit: false,
      limitWarnings: 0,
      penalties: 0,
    };
    let now = 1_000_000;
    r.update({ ...base }, now); // stint change — resets, nothing adopted yet
    now += 500;
    r.update({ ...base }, now); // first sighting — adopts the lap count
    now += 108_437;
    r.update({ ...base, lapsCompleted: 1, lastLapSec: 108.937, ...sectors }, now);
    // Ride the verdict hold out with quiet polls.
    let rec = null;
    for (let i = 0; i < 50 && !rec; i++) {
      now += 1000 + VERDICT_HOLD_MS / 10;
      rec = r.update({ ...base, lapsCompleted: 1, lastLapSec: 108.937, ...sectors }, now);
    }
    return rec;
  };

  const valid = runStint({ sector1Sec: 27.89, sector2Sec: 76.2 });
  check('a valid lap gets all three splits', !!valid && valid.s1Ms === 27890 && valid.s2Ms === 48310 && valid.s3Ms === 32737);
  check('splits sum to the lap', valid && valid.s1Ms + valid.s2Ms + valid.s3Ms === valid.lapMs);
  check('the record carries an id for its trace', valid && typeof valid.id === 'string' && valid.id.length >= 32);

  const invalidated = runStint({ sector1Sec: -1, sector2Sec: -1 });
  check('an invalidated lap (-1 boundaries) gets none', !!invalidated && invalidated.s1Ms === undefined);

  const torn = runStint({ sector1Sec: 29.09, sector2Sec: -1 });
  check('a torn pair is dropped whole, not half-kept', !!torn && torn.s1Ms === undefined && torn.s2Ms === undefined);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
