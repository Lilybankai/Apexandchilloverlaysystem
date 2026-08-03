/**
 * scripts/test-trackmap.js — the circuit learner's guards.
 * -----------------------------------------------------------------------------
 * The track map is learned from the driven car rather than shipped, which means
 * the widget draws whatever this module believes. A map is also SAVED the moment
 * it is published, so a bad one is not a bad frame — it is a bad circuit shown
 * at that track forever, until someone deletes a file they don't know about.
 *
 * So the cases here are the ways a lap lies: a car teleported to the garage
 * mid-lap, a lap driven down the pit lane, a session polled so slowly the
 * samples are tens of metres apart, and a venue whose two layouts share a name.
 * Each has one correct answer and none of them is visible in a typecheck.
 *
 * Run: node scripts/test-trackmap.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TrackMapBuilder,
  trackKey,
  loadTrackMap,
  saveTrackMap,
  smoothClosed,
  getPublishedTrackMap,
  setPublishedTrackMap,
  DEFAULT_HALF_WIDTH_M,
} = require('../dist/telemetry/trackMap');

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

/** A scratch directory per run, so a test never reads or writes the real cache. */
function scratch() {
  const dir = path.join(os.tmpdir(), `apex-trackmap-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const LENGTH = 3000;
const R = LENGTH / (2 * Math.PI); // a circular "circuit" of exactly LENGTH metres

/** The world position of a car `d` metres round the reference circle. */
function onCircle(d) {
  const a = (d / LENGTH) * Math.PI * 2;
  return { x: R * Math.cos(a), y: 10 * Math.sin(a * 2), z: R * Math.sin(a) };
}

/**
 * Drive `stepM` metres at a time through the builder, a little past the line —
 * as a real out-lap does. Stopping exactly on the line would leave the last bins
 * of the lap unvisited and test a situation that never happens on track.
 */
function driveLap(b, stepM, over, laps = 1.08) {
  let last = null;
  for (let d = 0; d < LENGTH * laps; d += stepM) {
    const at = d % LENGTH;
    last = b.update(
      Object.assign(
        {
          trackName: 'Test Circuit',
          lengthM: LENGTH,
          lapDistM: at,
          pos: onCircle(at),
          inPit: false,
          edgeM: 7,
        },
        typeof over === 'function' ? over(at) : over,
      ),
    );
  }
  return last;
}

/* ------------------------------- identity -------------------------------- */
{
  const monza = trackKey('Autodromo Nazionale Monza', undefined, 5793);
  const junior = trackKey('Autodromo Nazionale Monza', undefined, 2405);
  check('two layouts of one venue get different keys', monza !== junior, `${monza} vs ${junior}`);
  check(
    'a re-measured length by a metre keeps the same key',
    trackKey('Spa', undefined, 7004) === trackKey('Spa', undefined, 7001),
  );
  check(
    'the scene name separates layouts that share a length',
    trackKey('Le Mans', 'Bugatti', 13626) !== trackKey('Le Mans', '24h', 13626),
  );
}

/* ------------------------------- learning -------------------------------- */
{
  const b = new TrackMapBuilder(scratch());
  const half = b.update({
    trackName: 'Test Circuit',
    lengthM: LENGTH,
    lapDistM: 0,
    pos: onCircle(0),
    inPit: false,
  });
  check('one sample is not a circuit', half.ready === false && half.progress < 0.05, half.progress);

  const done = driveLap(b, 4);
  check('a full lap publishes a shape', done.ready === true, `progress ${done.progress}`);
  check('the shape is a closed loop of points', done.path && done.path.points.length > 200, done.path && done.path.points.length);

  // Every learned point must sit on the circle it was driven round: this is the
  // check that the whole pipeline (binning, interpolation, smoothing) preserves
  // the shape rather than merely producing one.
  let worst = 0;
  for (const [x, z] of done.path.points) {
    worst = Math.max(worst, Math.abs(Math.hypot(x, z) - R));
  }
  check('every point lands on the driven line', worst < 1.5, `worst ${worst.toFixed(2)} m`);
  check(
    'the road width comes from the sim, not the fallback',
    Math.abs(done.path.halfWidthM - 7) < 0.2,
    done.path.halfWidthM,
  );
  check('elevation is carried through', done.path.points.some((p) => Math.abs(p[2]) > 5));
}

/* --------------------------- a slow poll rate ---------------------------- */
{
  // 1 Hz at racing speed is ~35 m between samples — every bin in between has to
  // be filled by interpolation or the map never completes.
  const b = new TrackMapBuilder(scratch());
  const done = driveLap(b, 35);
  check('a 35 m sample spacing still completes the lap', done.ready === true, `progress ${done.progress}`);
}
{
  // …but a jump wider than the fill bound is a teleport, not a straight.
  const b = new TrackMapBuilder(scratch());
  const done = driveLap(b, 200);
  check('a 200 m jump is never bridged into road', done.ready === false, `progress ${done.progress}`);
}

/* ------------------------------- the pits -------------------------------- */
{
  const b = new TrackMapBuilder(scratch());
  const done = driveLap(b, 4, { inPit: true });
  check('a lap in the pit lane teaches nothing', done.ready === false, `progress ${done.progress}`);
}
{
  // A pit stop mid-lap leaves a hole where the car was in the lane. A short one
  // is bridged; this one is 300 m, which is a corner's worth of invented road.
  const b = new TrackMapBuilder(scratch());
  const done = driveLap(b, 4, (d) => (d > 600 && d < 900 ? { inPit: true } : null));
  check('a 300 m hole is refused rather than guessed at', done.ready === false, `progress ${done.progress}`);
}

/* ------------------------------ a teleport ------------------------------- */
{
  const b = new TrackMapBuilder(scratch());
  // One sample from the garage, 400 m away from the road, dropped into the
  // middle of an otherwise clean lap.
  const done = driveLap(b, 4, (d) =>
    d >= 1200 && d < 1204 ? { pos: { x: 400, y: 0, z: 400 } } : null,
  );
  check('a teleported sample does not publish a spike', done.ready === true);
  if (done.ready) {
    let worst = 0;
    for (const [x, z] of done.path.points) worst = Math.max(worst, Math.abs(Math.hypot(x, z) - R));
    check('the teleport is discarded, not drawn', worst < 5, `worst ${worst.toFixed(2)} m`);
  }
}

/* ------------------------------ persistence ------------------------------ */
{
  const dir = scratch();
  const first = new TrackMapBuilder(dir);
  const built = driveLap(first, 4);
  check('a learned circuit is written to disk', built.ready === true);

  const second = new TrackMapBuilder(dir);
  const reloaded = second.update({
    trackName: 'Test Circuit',
    lengthM: LENGTH,
    lapDistM: 0,
    pos: onCircle(0),
    inPit: false,
  });
  check(
    'the next session draws it on the first frame',
    reloaded.ready === true && reloaded.path.points.length === built.path.points.length,
  );
  check(
    'a track that has never been driven is not ready',
    loadTrackMap('never-been-here-1234', dir) === null,
  );
}

/* ------------------------- who is being served --------------------------- */
{
  // The live provider drops to the simulator whenever the sim is unreachable, and
  // the simulator publishes its own demo circuit. When the sim comes back, the
  // learned shape has to take the served slot back — or the frame names this
  // track while `/trackmap.json` hands out the demo oval.
  const b = new TrackMapBuilder(scratch());
  const built = driveLap(b, 4);
  setPublishedTrackMap({ key: 'demo-circuit', points: [], revision: 1 });
  b.update({
    trackName: 'Test Circuit',
    lengthM: LENGTH,
    lapDistM: 0,
    pos: onCircle(0),
    inPit: false,
  });
  check(
    'a learned circuit takes the served slot back from demo mode',
    getPublishedTrackMap().key === built.path.key,
    getPublishedTrackMap().key,
  );
}

/* --------------------------- changing circuits --------------------------- */
{
  const b = new TrackMapBuilder(scratch());
  driveLap(b, 4);
  const other = b.update({
    trackName: 'Somewhere Else',
    lengthM: 4200,
    lapDistM: 0,
    pos: { x: 0, y: 0, z: 500 },
    inPit: false,
  });
  check('a new track drops the old shape', other.ready === false, other.key);
  check('and the revision moves so the widget refetches', other.revision >= 1, other.revision);
}

/* ------------------------------- guards ---------------------------------- */
{
  const b = new TrackMapBuilder(scratch());
  const none = b.update({
    trackName: 'Test Circuit',
    lengthM: 0,
    lapDistM: 0,
    pos: onCircle(0),
    inPit: false,
  });
  check('no lap length means no map', none.ready === false && none.key === '');

  const spectating = new TrackMapBuilder(scratch());
  let last;
  for (let d = 0; d < LENGTH; d += 4) {
    last = spectating.update({
      trackName: 'Test Circuit',
      lengthM: LENGTH,
      lapDistM: d,
      pos: null, // no shared memory — spectating a broadcast
      inPit: false,
    });
  }
  check('spectating learns nothing rather than drawing a lie', last.ready === false);
}
{
  const b = new TrackMapBuilder(scratch());
  const done = driveLap(b, 4, { edgeM: null });
  check(
    'no track-edge channel falls back to a sane road width',
    done.path.halfWidthM === DEFAULT_HALF_WIDTH_M,
    done.path.halfWidthM,
  );
}
{
  const dir = scratch();
  saveTrackMap({ key: 'broken', points: [[1, 2, 3]], lengthM: 100, halfWidthM: 6 }, dir);
  check('a truncated cache file is rejected, not half-drawn', loadTrackMap('broken', dir) === null);
}

/* ------------------------------- smoothing -------------------------------- */
{
  // The window has to wrap: the start/finish line is the most-looked-at point on
  // the map, and a smoother that stops at the array's end leaves a kink on it.
  const ring = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    ring.push({ x: Math.cos(a) * 100, y: 0, z: Math.sin(a) * 100 });
  }
  ring[0] = { x: 130, y: 0, z: 0 }; // one point pushed off the circle, on the line
  const out = smoothClosed(ring, 2);
  const err = (p) => Math.abs(Math.hypot(p.x, p.z) - 100);
  check('smoothing pulls a kink on the start line back in', err(out[0]) < err(ring[0]) / 2);
  check('and it wraps, so the last point is smoothed too', err(out[63]) < 6, err(out[63]).toFixed(2));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
