/**
 * scripts/test-ghostgeom.js — Ghost HUD's geometry: signs, wrap, projection.
 * -----------------------------------------------------------------------------
 * The widget turns a world position and a heading into "where on the road ahead
 * of me is that". A flipped sign puts the car you are chasing on the wrong side
 * of the road, and a wrap bug blanks the whole view for one second every lap as
 * the window crosses the start/finish line. Neither shows up in a typecheck and
 * both look plausible in a screenshot.
 *
 * So each case builds a physical situation with ONE correct answer — a point
 * dead ahead, a point on the left, the player pointed east, a window straddling
 * the line — and asserts it, the same way `scripts/test-radar.js` does for the
 * radar's projection.
 *
 * Run: node scripts/test-ghostgeom.js
 */

'use strict';

const G = require('../overlay/js/ghost-geom');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  } else {
    failed++;
    console.log('  FAIL  ' + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  }
}

const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);

console.log('');
console.log('1) worldToLocal — the sign flip that puts a rival on the wrong side');
{
  // Heading 0 means the nose points along world +Z. So +Z is ahead and, in the
  // sim's left-handed frame, +X is to the driver's right.
  let r = G.worldToLocal(0, 0, 0, 0, 10);
  check('nose along +Z: a point at +Z is AHEAD', near(r.lon, 10) && near(r.lat, 0), r.lon + ',' + r.lat);

  r = G.worldToLocal(0, 0, 0, 10, 0);
  check('…a point at +X is to the RIGHT', near(r.lat, 10) && near(r.lon, 0), r.lat + ',' + r.lon);

  r = G.worldToLocal(0, 0, 0, -10, 0);
  check('…a point at −X is to the LEFT', near(r.lat, -10), r.lat);

  r = G.worldToLocal(0, 0, 0, 0, -10);
  check('…a point at −Z is BEHIND', near(r.lon, -10), r.lon);

  // Turn the car to face +X. What was on the right is now straight ahead.
  r = G.worldToLocal(90, 0, 0, 10, 0);
  check('nose along +X: the +X point is now ahead', near(r.lon, 10, 1e-9) && near(r.lat, 0, 1e-9), r.lon + ',' + r.lat);

  r = G.worldToLocal(90, 0, 0, 0, 10);
  check('…and the +Z point is now on the LEFT', near(r.lat, -10, 1e-9), r.lat);

  // Facing backwards.
  r = G.worldToLocal(180, 0, 0, 0, 10);
  check('nose along −Z: the +Z point is behind', near(r.lon, -10, 1e-9), r.lon);

  // The player is not at the origin.
  r = G.worldToLocal(0, 100, 200, 100, 215);
  check('player offset: only the delta matters', near(r.lon, 15) && near(r.lat, 0), r.lon + ',' + r.lat);

  // Distance is preserved whatever the heading — a rotation cannot stretch.
  let worst = 0;
  for (let h = -180; h <= 180; h += 17) {
    const q = G.worldToLocal(h, 3, -4, 13, 21);
    worst = Math.max(worst, Math.abs(Math.hypot(q.lat, q.lon) - Math.hypot(10, 25)));
  }
  check('rotation preserves distance at every heading', worst < 1e-9, worst.toExponential(1));
}

console.log('');
console.log('2) roadSlice — the window, and the lap wrap that blanks a view');
{
  // A 100-point circle of circumference 1000 m: easy to reason about.
  const R = 1000 / (2 * Math.PI);
  const pts = [];
  for (let i = 0; i < 100; i++) {
    const a = (i / 100) * 2 * Math.PI;
    pts.push([R * Math.cos(a), R * Math.sin(a), 0]);
  }
  const shape = { points: pts, binM: 10, lengthM: 1000 };

  let s = G.roadSlice(shape, 100, 200);
  check('a plain window has the right span', s.length === 11, s.length);

  // THE case: the window straddles the start/finish line. Index 0 is on the
  // line, so a slice that clamped instead of wrapping would blank the road for
  // a second every lap, exactly as the driver crossed it.
  s = G.roadSlice(shape, -30, 50);
  check('a window across the line still returns points', s.length === 9, s.length);
  check('…and it is continuous across index 0', s.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)));
  const step = Math.hypot(s[3].x - s[2].x, s[3].z - s[2].z);
  check('…with no jump where it wraps', near(step, 10, 0.2), step.toFixed(2) + ' m');

  // Past the end of the lap wraps the same way.
  s = G.roadSlice(shape, 980, 1040);  // indices 98..104 inclusive = 7
  check('a window past the lap end wraps too', s.length === 7 && s.every((p) => Number.isFinite(p.x)), s.length);

  // The normal must point across the road, not along it.
  s = G.roadSlice(shape, 0, 100);
  const p0 = s[0];
  const along = Math.hypot(s[1].x - s[0].x, s[1].z - s[0].z);
  const dot = ((s[1].x - s[0].x) / along) * p0.nx + ((s[1].z - s[0].z) / along) * p0.nz;
  check('the normal is perpendicular to the road', Math.abs(dot) < 1e-6, dot.toExponential(1));
  check('the normal is a unit vector', near(Math.hypot(p0.nx, p0.nz), 1, 1e-9));

  // Guards.
  check('a window longer than the lap is capped', G.roadSlice(shape, 0, 5000).length <= 101, G.roadSlice(shape, 0, 5000).length);
  check('no shape is an empty slice', G.roadSlice(null, 0, 100).length === 0);
  check('a stub shape is an empty slice', G.roadSlice({ points: [[0, 0, 0]] }, 0, 100).length === 0);

  // A repeated map point has no direction; the normal must not collapse.
  const dup = { points: [[0, 0, 0], [0, 0, 0], [10, 0, 0], [20, 0, 0], [30, 0, 0]], binM: 10, lengthM: 50 };
  const ds = G.roadSlice(dup, 0, 40);
  check('a repeated point keeps a usable normal', ds.every((p) => Math.hypot(p.nx, p.nz) > 0.5 || p === ds[0]), 'ok');
}

console.log('');
console.log('3) roadElevation — read from the road, never from a lap');
{
  const shape = { points: [[0, 0, 5], [10, 0, 6], [20, 0, 7], [30, 0, 8]], binM: 10, lengthM: 40 };
  check('elevation at the first bin', G.roadElevation(shape, 0) === 5);
  check('elevation mid-lap', G.roadElevation(shape, 25) === 7);
  // 45 m round a 40 m lap is 5 m in, which is bin 0.
  check('elevation wraps past the lap', G.roadElevation(shape, 45) === 5, G.roadElevation(shape, 45));
  check('elevation wraps backwards', G.roadElevation(shape, -10) === 8, G.roadElevation(shape, -10));
  check('a flat map reads zero', G.roadElevation({ points: [[0, 0], [1, 0]], binM: 1 }, 0) === 0);
  check('no shape reads zero', G.roadElevation(null, 10) === 0);
}

console.log('');
console.log('4) lineAt — a position off a lap, and the columns it refuses');
{
  const line = { d: [0, 0.25, 0.5, 1], x: [0, 10, 20, 40], z: [0, -10, -20, -40] };
  let q = G.lineAt(line, 0.25);
  check('on a sample, exactly', near(q.x, 10) && near(q.z, -10), q.x + ',' + q.z);
  q = G.lineAt(line, 0.375);
  check('between samples, linearly', near(q.x, 15) && near(q.z, -15), q.x + ',' + q.z);
  q = G.lineAt(line, -1);
  check('before the span clamps to the first', near(q.x, 0));
  q = G.lineAt(line, 2);
  check('after the span clamps to the last', near(q.x, 40));

  check('no line is null', G.lineAt(null, 0.5) === null);
  check('missing z is null', G.lineAt({ d: [0, 1], x: [0, 1] }, 0.5) === null);
  // A column of the wrong length cannot be trusted to align, and a line drawn
  // one sample out of step is the hardest kind of wrong to see.
  check('a mismatched column is null, not guessed', G.lineAt({ d: [0, 0.5, 1], x: [0, 1], z: [0, 1] }, 0.5) === null);

  const ch = { d: [0, 0.5, 1], brake: [0, 1, 0] };
  check('channelAt interpolates', near(G.channelAt(ch, 'brake', 0.25), 0.5), G.channelAt(ch, 'brake', 0.25));
  check('a missing channel is 0, not NaN', G.channelAt(ch, 'throttle', 0.5) === 0);
}

console.log('');
console.log('5) project — the chase camera, and the elevation trap');
{
  const cam = G.camera({ cx: 300, cy: 90, f: 600, back: 14, pitch: 0, height: 3, roadY: 0 });

  let q = G.project(cam, 0, 0, 0);
  check('a point at the car is on the centre line', near(q.x, 300), q.x);
  check('…and below the horizon', q.y > cam.cy, q.y);

  const far = G.project(cam, 0, 0, 1000);
  check('a distant point sits nearer the horizon', far.y < q.y && far.y > cam.cy - 1, far.y.toFixed(1));

  check('a point to the right is right of centre', G.project(cam, 5, 0, 20).x > 300);
  check('a point to the left is left of centre', G.project(cam, -5, 0, 20).x < 300);

  // Equal lateral offsets must shrink with distance — this is the whole reason
  // a scene is drawn in perspective rather than on a linear axis.
  const nearOff = G.project(cam, 5, 0, 10).x - 300;
  const farOff = G.project(cam, 5, 0, 60).x - 300;
  check('the same offset is smaller further away', farOff < nearOff && farOff > 0, nearOff.toFixed(0) + ' -> ' + farOff.toFixed(0));

  check('behind the near plane is null', G.project(cam, 0, 0, -20) === null);
  check('exactly at the camera is null', G.project(cam, 0, 0, -14) === null);

  // THE elevation trap. The eye must ride the player's own road height; pinned
  // to absolute world Y, a climbing circuit pushes the whole road off screen.
  // Road Atlanta swings -3.7 m to +4.5 m, and the prototype went blank on it.
  const high = G.camera({ cx: 300, cy: 90, f: 600, back: 14, pitch: 0, height: 3, roadY: 4.5 });
  const onHigh = G.project(high, 0, 4.5, 20);
  const low = G.camera({ cx: 300, cy: 90, f: 600, back: 14, pitch: 0, height: 3, roadY: -3.7 });
  const onLow = G.project(low, 0, -3.7, 20);
  check('road at +4.5 m projects where road at −3.7 m does', near(onHigh.y, onLow.y, 1e-9), onHigh.y.toFixed(2));
  check('…and both are on screen, not above it', onHigh.y > cam.cy && onLow.y > cam.cy);

  // A crest ahead really should rise toward the horizon.
  const flat = G.project(low, 0, -3.7, 40);
  const crest = G.project(low, 0, -1.7, 40);
  check('ground rising ahead draws higher up the screen', crest.y < flat.y, crest.y.toFixed(1) + ' < ' + flat.y.toFixed(1));
}

console.log('');
console.log('6) pedalColour — the convention drivers already read');
{
  check('braking is red', G.pedalColour(0.9, 0) === '#D55E00');
  check('coasting is amber', G.pedalColour(0, 0.2) === '#E0A423');
  check('on the power is green', G.pedalColour(0, 1) === '#2FBF71');
  check('a brush of brake still reads as braking', G.pedalColour(0.2, 0.9) === '#D55E00');
  check('trailing throttle is not yet green', G.pedalColour(0, 0.5) === '#E0A423');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
console.log('');
process.exit(failed === 0 ? 0 : 1);
