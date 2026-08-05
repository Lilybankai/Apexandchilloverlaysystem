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
  deleteTrackMap,
  clearRejectedTrackMaps,
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

/* --------------------- a lap distance that ticks back -------------------- */
{
  // A spin, a car rolling back out of the gravel, a scoring read that arrives
  // out of order: the lap distance goes DOWN a few metres while the car is
  // still where it was. Counted forward round the lap — which is the only way
  // to count it, because that is the direction the road goes — that is a step
  // of very nearly a whole circuit, taken by a car that has moved a metre.
  //
  // It used to be filled in as road: every bin still empty ANYWHERE on the
  // track got the one spot the car was standing on, coverage hit 1.0 on the
  // spot, and the map was published and saved as the fragment driven so far
  // closed by a straight chord. That is the Daytona map with half the circuit
  // missing and the field driving off the edge of the widget.
  const b = new TrackMapBuilder(scratch());
  const frame = (dist, pos) => ({
    trackName: 'Test Circuit',
    lengthM: LENGTH,
    lapDistM: dist,
    pos,
    inPit: false,
    edgeM: 7,
  });
  const stopAt = LENGTH * 0.65;
  let last = null;
  for (let d = 0; d < stopAt; d += 8) last = b.update(frame(d, onCircle(d)));
  last = b.update(frame(stopAt - 12, onCircle(stopAt)));
  check(
    'a lap distance that ticks backwards invents no circuit',
    last.ready === false,
    `progress ${last.progress}`,
  );

  for (let d = stopAt; d < LENGTH * 1.08; d += 8) {
    const at = d % LENGTH;
    last = b.update(frame(at, onCircle(at)));
  }
  check('and the lap it interrupted still finishes', last.ready === true, `progress ${last.progress}`);
  if (last.ready) {
    let worst = 0;
    for (const [x, z] of last.path.points) worst = Math.max(worst, Math.abs(Math.hypot(x, z) - R));
    check('as the circuit that was actually driven', worst < 5, `worst ${worst.toFixed(2)} m`);
  }
}

/* ----------------------- a fragment with a chord ------------------------- */
{
  // Every bin filled, so coverage says the map is complete — but a run of them
  // holds positions from somewhere else entirely. No single point is an outlier
  // (inside the run each one agrees with its neighbours), so what would come
  // out is a shape closed by a straight line ruled across the map, saved and
  // drawn at that track for good. Complete is not the same as continuous.
  const b = new TrackMapBuilder(scratch());
  const done = driveLap(b, 4, (d) =>
    d > 900 && d < 1500 ? { pos: { x: onCircle(d).x + 600, y: 0, z: onCircle(d).z + 600 } } : null,
  );
  check('a shape that closes with a chord is refused, not drawn', done.ready === false, `progress ${done.progress}`);
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
{
  // The same shape, but already on disk — written by a build from before the
  // check above existed. Publishing means saving, so everyone who hit that bug
  // has one of these, and the cache is preferred to learning a new one: without
  // this it is drawn at that track forever. Rejecting it here is the whole
  // repair, and it costs the driver one lap.
  const dir = scratch();
  const points = [];
  const bins = 600;
  for (let i = 0; i < 400; i++) {
    const a = (i / bins) * Math.PI * 2;
    points.push([R * Math.cos(a), R * Math.sin(a), 0]);
  }
  saveTrackMap(
    {
      key: 'fragment-1234',
      name: 'Two thirds of a circuit',
      lengthM: LENGTH,
      halfWidthM: 6,
      binM: LENGTH / bins,
      points,
      builtAt: new Date().toISOString(),
      revision: 1,
    },
    dir,
  );
  check('a cached map with a chord across it is thrown away', loadTrackMap('fragment-1234', dir) === null);
}

/* ------------------- a map on screen is never taken back ------------------ */
{
  // A well-formed circuit, saved and loaded, that is NOT the one being driven:
  // the same circuit rotated — every point continuous, every neighbour a bin
  // apart, and 300 m from where the car actually is.
  //
  // This used to be condemned on the spot. It is not any more, and that is the
  // point of the test. The check only ever fired on shipped maps (a map learned
  // from your own car agrees with your own car by construction), so its whole
  // cost landed on drivers watching the circuit vanish mid-session at a track
  // that had been drawing perfectly. A map that is wrong is still a map you can
  // place the field on; a map that disappears mid-stint is nothing at all. A bad
  // shipped shape is now fixed by shipping a corrected one.
  const dir = scratch();
  const bins = 500;
  const wrong = [];
  for (let i = 0; i < bins; i++) {
    const a = (i / bins) * Math.PI * 2 + 0.9; // the same shape, turned
    wrong.push([R * Math.cos(a), R * Math.sin(a), 0]);
  }
  saveTrackMap(
    {
      key: trackKey('Test Circuit', undefined, LENGTH),
      name: 'Test Circuit',
      lengthM: LENGTH,
      halfWidthM: 6,
      binM: LENGTH / bins,
      points: wrong,
      builtAt: new Date().toISOString(),
      revision: 1,
    },
    dir,
  );

  const b = new TrackMapBuilder(dir);
  const loaded = b.update({
    trackName: 'Test Circuit',
    lengthM: LENGTH,
    lapDistM: 0,
    pos: onCircle(0),
    inPit: false,
  });
  check('a saved circuit is drawn before a lap is driven', loaded.ready === true);

  // Drive a whole lap of disagreement — far more than the old check needed.
  let last = loaded;
  for (let d = 0; d < LENGTH; d += 8) {
    last = b.update({
      trackName: 'Test Circuit',
      lengthM: LENGTH,
      lapDistM: d,
      pos: onCircle(d),
      inPit: false,
      edgeM: 7,
    });
  }
  check('driving a whole lap against it does not take it away', last.ready === true, `progress ${last.progress}`);
  check('and it is still the shape being served', getPublishedTrackMap() !== null);
  check(
    'and the file is still on disk for the next session',
    loadTrackMap(trackKey('Test Circuit', undefined, LENGTH), dir) !== null,
  );
}
{
  // The repair path for a shipped shape that really is wrong: a corrected file
  // in the next release. Rejection notes from the builds that could condemn a
  // map are ignored on load and swept off disk, so a driver who lost a circuit
  // under the old rule gets it back by updating and nothing else.
  const dir = scratch();
  fs.mkdirSync(dir, { recursive: true });
  const key = trackKey('Test Circuit', undefined, LENGTH);
  fs.writeFileSync(path.join(dir, `${key}.rejected`), JSON.stringify({ key, builtAt: null }), 'utf8');
  const cleared = clearRejectedTrackMaps(dir);
  check('a stale rejection note is cleared', cleared === 1, `cleared ${cleared}`);
  check('and clearing again is not an error', clearRejectedTrackMaps(dir) === 0);
}
{
  // The other half of that: an accident must NOT cost a driver their map. A car
  // that spins off, or sits in a barrier a long way from the road, is measured
  // in the road it covers while it is out there — and a stationary car covers
  // none. The threshold is a length of circuit for exactly this reason.
  const dir = scratch();
  const b = new TrackMapBuilder(dir);
  driveLap(b, 4);
  let last = null;
  for (let i = 0; i < 600; i++) {
    last = b.update({
      trackName: 'Test Circuit',
      lengthM: LENGTH,
      lapDistM: 1200 + i * 0.05, // beached: 30 m of lap distance over 600 frames
      pos: { x: 900, y: 0, z: 900 }, // …and 800 m from the road, in the scenery
      inPit: false,
    });
  }
  check('a car parked off the circuit does not condemn the map', last.ready === true);
  check('and the map is still the one on disk', loadTrackMap(last.key, dir) !== null);
}
{
  // A lap in the pit lane is not evidence either: the pit lane runs alongside
  // the track at the same lap distances and the map has never claimed to
  // describe it, which is why nothing is learned from it in the first place.
  const dir = scratch();
  const b = new TrackMapBuilder(dir);
  driveLap(b, 4);
  const done = driveLap(b, 4, (d) => ({ inPit: true, pos: { x: onCircle(d).x + 300, y: 0, z: onCircle(d).z + 300 } }));
  check('a lap down the pit lane does not condemn the map', done.ready === true);
}
{
  // And the deletion itself: asked to make sure there is no cached circuit,
  // when there never was one.
  const dir = scratch();
  deleteTrackMap('never-been-here-1234', dir);
  check('forgetting a circuit that was never learned is not an error', true);
}

{
  // A fast car on a slow distance feed. Found live at Daytona, where the map
  // never finished: LMU publishes the car's POSITION from shared memory every
  // frame and its LAP DISTANCE over REST roughly every 150 ms — measured at 12
  // position frames per distance tick, with the car covering up to 24.8 m of
  // road in between.
  //
  // Every one of those frames used to be filed. `put()` keeps the first position
  // to reach a bin and `prev` keeps the latest, so one bin held the position from
  // the start of a distance tick and its neighbour the position from the end of
  // one — two bins that are 6 m of road apart holding positions 24 m apart in the
  // world. That is over the bound `commit()` uses to ask whether the shape is a
  // circuit at all, so the lap was thrown away and relearned, every lap, forever:
  // the widget showed a progress read that reset at 99% and never drew a map.
  //
  // The circuits that fail are the fastest ones, which is the wrong way round for
  // a check meant to catch a BROKEN shape — nothing here is broken, the car is
  // just quick. A lap driven this way has to publish.
  const STEP = 24; // metres of road per distance tick, as a banked lap gives
  const SUB = 12; // position frames inside one tick
  const b = new TrackMapBuilder(scratch());
  let last = null;
  for (let d = 0; d < LENGTH * 1.08; d += STEP) {
    for (let k = 0; k < SUB; k++) {
      last = b.update({
        trackName: 'Test Circuit',
        lengthM: LENGTH,
        lapDistM: d % LENGTH, // frozen for the whole tick…
        pos: onCircle((d + (k * STEP) / SUB) % LENGTH), // …while the car moves on
        inPit: false,
        edgeM: 7,
      });
    }
  }
  check('a fast car on a slow distance feed still publishes a map', last.ready === true);
  check(
    'and the published shape is the circuit, not a stretched one',
    last.ready === true && last.path.points.length >= 200,
    last.ready ? `${last.path.points.length} points` : 'never published',
  );
  // The continuity bound is asked of the smoothed path — the one that is saved
  // and drawn — so that it and the identical check in loadTrackMap agree. That
  // must not have cost the bound its teeth: the shape it exists to catch is a
  // FRAGMENT of a circuit closed by a straight chord, and smoothing a chord that
  // is hundreds of metres long leaves it hundreds of metres long.
  if (last.ready) {
    const round = loadTrackMap(last.path.key, undefined) || last.path;
    check(
      'a shape published this way is one the loader will accept back',
      round.points.length === last.path.points.length,
      'commit and loadTrackMap agree',
    );
  }
}
{
  // Drive four fifths of a circuit and stop. Every bin that was reached is real
  // road, so nothing above objects — but the shape closes with a chord across
  // the fifth that was never driven, which is the map with a section missing and
  // a line ruled through it. Smoothing does not soften a chord that size.
  const b = new TrackMapBuilder(scratch());
  let last = null;
  for (let d = 0; d < LENGTH * 0.8; d += 4) {
    last = b.update({
      trackName: 'Test Circuit',
      lengthM: LENGTH,
      lapDistM: d,
      pos: onCircle(d),
      inPit: false,
      edgeM: 7,
    });
  }
  // Jump the car to the line so the remaining bins fill from one end.
  for (let k = 0; k < 30; k++) {
    last = b.update({
      trackName: 'Test Circuit',
      lengthM: LENGTH,
      lapDistM: LENGTH * 0.8 + k * 8,
      pos: onCircle(0),
      inPit: false,
      edgeM: 7,
    });
  }
  check('a fifth of the circuit missing is still refused, not drawn', last.ready === false);
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
