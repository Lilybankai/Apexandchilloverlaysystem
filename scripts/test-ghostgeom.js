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
  check('pedalKind agrees with pedalColour', G.pedalKind(0.9, 0) === G.PEDAL_BRAKE && G.pedalKind(0, 0.2) === G.PEDAL_COAST && G.pedalKind(0, 1) === G.PEDAL_THROTTLE);
}

/** A 100-point circle of circumference 1000 m, counter-clockwise from +X. */
function circleShape() {
  const R = 1000 / (2 * Math.PI);
  const pts = [];
  for (let i = 0; i < 100; i++) {
    const a = (i / 100) * 2 * Math.PI;
    pts.push([R * Math.cos(a), R * Math.sin(a), 0]);
  }
  return { shape: { points: pts, binM: 10, lengthM: 1000 }, R };
}

console.log('');
console.log('7) roadElevationAt — the eye must not step every bin on a slope');
{
  const shape = { points: [[0, 0, 5], [10, 0, 6], [20, 0, 7], [30, 0, 8]], binM: 10, lengthM: 40 };
  check('on a bin it is the bin', near(G.roadElevationAt(shape, 10), 6));
  check('between bins it is linear', near(G.roadElevationAt(shape, 25), 7.5), G.roadElevationAt(shape, 25));
  check('it wraps from the last bin back to the first', near(G.roadElevationAt(shape, 35), 6.5), G.roadElevationAt(shape, 35));
  check('…backwards across the line too', near(G.roadElevationAt(shape, -5), 6.5), G.roadElevationAt(shape, -5));
  // The whole point: no step anywhere. Nearest-bin reads jump a full metre here.
  let worst = 0;
  for (let m = 0; m < 40; m += 0.05) worst = Math.max(worst, Math.abs(G.roadElevationAt(shape, m + 0.05) - G.roadElevationAt(shape, m)));
  check('no step bigger than the slope allows (5 cm of road = ≤ 3 mm of rise)', worst < 0.0151, worst.toFixed(4) + ' m');
  check('no shape reads zero', G.roadElevationAt(null, 3) === 0);

  // The wire rounds binM to the centimetre; the lap length is the truth.
  const pts = [];
  for (let i = 0; i < 681; i++) pts.push([i, 0, 0]);
  const rounded = { points: pts, binM: 6, lengthM: 4083.5 };
  check('mapLength is the lap, not bins × rounded binM', near(G.mapLength(rounded), 4083.5, 1e-9), G.mapLength(rounded));
  check('…and falls back to bins × binM with no lengthM', near(G.mapLength({ points: pts, binM: 6 }), 4086), G.mapLength({ points: pts, binM: 6 }));
}

console.log('');
console.log('8) roadAt — a smooth centreline with a tangent');
{
  const { shape, R } = circleShape();
  const out = { x: 0, z: 0, y: 0, tx: 0, tz: 0 };
  const r = G.roadAt(shape, 120, out);
  check('it writes into the caller\'s object', r === out);
  const a12 = (12 / 100) * 2 * Math.PI;
  check('on a bin it passes through the map point', near(r.x, R * Math.cos(a12), 1e-9) && near(r.z, R * Math.sin(a12), 1e-9));
  let worstR = 0;
  let worstDot = 0;
  let worstLen = 0;
  for (let m = 0; m < 1000; m += 1.3) {
    const s = G.roadAt(shape, m);
    worstR = Math.max(worstR, Math.abs(Math.hypot(s.x, s.z) - R));
    worstDot = Math.max(worstDot, Math.abs((s.x * s.tx + s.z * s.tz) / R));
    worstLen = Math.max(worstLen, Math.abs(Math.hypot(s.tx, s.tz) - 1));
  }
  // A 10 m polyline round this circle cuts in by up to 6.2 cm between points.
  check('between bins it stays on the curve (spline, not chords)', worstR < 0.01, (worstR * 100).toFixed(2) + ' cm');
  check('the tangent runs along the road', worstDot < 0.01, worstDot.toExponential(1));
  check('the tangent is a unit vector', worstLen < 1e-9);
  const behind = G.roadAt(shape, -10);
  const wrapped = G.roadAt(shape, 990);
  check('a negative distance wraps to the end of the lap', near(behind.x, wrapped.x, 1e-9) && near(behind.z, wrapped.z, 1e-9));
}

console.log('');
console.log('9) roadDistanceOf — where along the road a world point is');
{
  const { shape, R } = circleShape();
  const at = (m, off) => {
    const a = (m / 1000) * 2 * Math.PI;
    return [(R + off) * Math.cos(a), (R + off) * Math.sin(a)];
  };
  let [x, z] = at(333.3, 0);
  let m = G.roadDistanceOf(shape, x, z, 330, 60, 40);
  check('a point on the road reads its own distance', near(m, 333.3, 0.1), m && m.toFixed(2));
  [x, z] = at(333.3, 4);
  m = G.roadDistanceOf(shape, x, z, 330, 60, 40);
  check('…and a point 4 m to the side reads the same distance', near(m, 333.3, 0.1), m && m.toFixed(2));
  [x, z] = at(998, 0);
  m = G.roadDistanceOf(shape, x, z, 3, 60, 40);
  check('a hint just past the line finds a point just before it', near(m, 998, 0.1), m && m.toFixed(2));
  [x, z] = at(2, 0);
  m = G.roadDistanceOf(shape, x, z, 995, 60, 40);
  check('…and the other way round', near(m, 2, 0.1), m && m.toFixed(2));
  [x, z] = at(500, 0);
  check('no hint scans the whole lap', near(G.roadDistanceOf(shape, x, z, NaN, 0, 40), 500, 0.1));
  [x, z] = at(500, 60);
  check('further off the road than maxOff is null, not a guess', G.roadDistanceOf(shape, x, z, 500, 60, 40) === null);
  check('no shape is null', G.roadDistanceOf(null, 0, 0, 0, 60, 40) === null);

  // A hairpin: up one straight, round a 10 m turn, back down a straight 20 m
  // away. A point between them is equally near both, and only the hint can
  // say which one the car is on. The windowed search must keep to it.
  const pts = [];
  for (let s = 0; s < 500; s += 5) pts.push([0, s, 0]);
  for (let k = 0; k < 6; k++) {
    const a = Math.PI - (k / 6) * Math.PI;
    pts.push([10 + 10 * Math.cos(a), 500 + 10 * Math.sin(a), 0]);
  }
  for (let s = 500; s > 0; s -= 5) pts.push([20, s, 0]);
  for (let k = 0; k < 6; k++) {
    const a = -(k / 6) * Math.PI;
    pts.push([10 + 10 * Math.cos(a), 10 * Math.sin(a), 0]);
  }
  const hp = { points: pts, binM: 5, lengthM: pts.length * 5 };
  const up = G.roadDistanceOf(hp, 9, 250, 250, 60, 40);
  const down = G.roadDistanceOf(hp, 11, 250, 780, 60, 40);
  check('hairpin: hinted on the way up, it stays on the way up', near(up, 250, 1), up && up.toFixed(1));
  check('hairpin: hinted on the way back, it stays on the way back', down > 700 && down < 860, down && down.toFixed(1));
}

console.log('');
console.log('10) prepareLine / preparedAt — the line as painted');
{
  // A straight 1000 m line along +Z whose lateral position was stored rounded
  // to 10 cm, wandering ±8 cm: the staircase the smoothing exists to remove.
  const n = 800;
  const line = { d: [], x: [], z: [], brake: [], throttle: [], trackLengthM: 1000, full: false };
  for (let i = 0; i < n; i++) {
    const d = i / (n - 1);
    line.d.push(d);
    line.z.push(d * 1000);
    line.x.push(Math.round((5 + 0.08 * Math.sin(i * 1.7)) * 10) / 10);
    line.brake.push(d > 0.5 && d < 0.6 ? 1 : 0);
    line.throttle.push(d > 0.5 && d < 0.6 ? 0 : 1);
  }
  const pl = G.prepareLine(line, 1, 1.5, 1000);
  check('it prepares', !!pl && pl.n > 900, pl && pl.n);
  let worstStep = 0;
  for (let i = 1; i < pl.n; i++) worstStep = Math.max(worstStep, Math.abs(Math.hypot(pl.x[i] - pl.x[i - 1], pl.z[i] - pl.z[i - 1]) - 1));
  check('samples are 1 m apart along the line', worstStep < 0.06, worstStep.toFixed(3) + ' m off');
  let rawWobble = 0;
  for (let i = 1; i < n; i++) rawWobble = Math.max(rawWobble, Math.abs(line.x[i] - line.x[i - 1]));
  let wobble = 0;
  for (let i = 20; i < pl.n - 20; i++) wobble = Math.max(wobble, Math.abs(pl.x[i] - pl.x[i - 1]));
  check('the 10 cm storage staircase is smoothed out', wobble < rawWobble / 5, (rawWobble * 100).toFixed(1) + ' cm -> ' + (wobble * 100).toFixed(2) + ' cm');
  let meanX = 0;
  for (let i = 0; i < pl.n; i++) meanX += pl.x[i] / pl.n;
  check('…without moving the line', near(meanX, 5, 0.03), meanX.toFixed(3));
  check('normals are unit and point right of travel (+X for a car heading +Z)', near(pl.nx[300], 1, 1e-3) && near(Math.hypot(pl.nx[300], pl.nz[300]), 1, 1e-6), pl.nx[300] + ',' + pl.nz[300]);
  check('pedal channels ride along', pl.brake[Math.round(pl.n * 0.55)] === 1 && pl.throttle[Math.round(pl.n * 0.2)] === 1);

  const mid = (pl.d[400] + pl.d[401]) / 2;
  const q = G.preparedAt(pl, mid);
  check('preparedAt interpolates between samples', near(q.z, (pl.z[400] + pl.z[401]) / 2, 1e-3) && near(q.i, 400.5, 1e-6), q.i.toFixed(3));
  check('preparedIndex is the first sample at or past d', G.preparedIndex(pl, pl.d[10]) === 10 && G.preparedIndex(pl, (pl.d[10] + pl.d[11]) / 2) === 11);
  check('preparedAt clamps before the first sample', G.preparedAt(pl, -1).i === 0);

  check('a line with no length is not prepared', G.prepareLine({ d: line.d, x: line.x, z: line.z }, 1, 1.5) === null);
  check('a stub line is not prepared', G.prepareLine({ d: [0, 1], x: [0, 0], z: [0, 1], trackLengthM: 10 }, 1, 1.5) === null);
}

console.log('');
console.log('11) detectBrakes — the fallback brake boards');
{
  // A 1000 m lap sampled every metre. Brake columns are written by hand so each
  // case has one right answer.
  const n = 1001;
  const line = { d: [], x: [], z: [], brake: [], trackLengthM: 1000 };
  for (let i = 0; i < n; i++) {
    line.d.push(i / 1000);
    line.x.push(0);
    line.z.push(i);
    line.brake.push(0);
  }
  const press = (from, to, v) => {
    for (let i = from; i <= to; i++) line.brake[i] = v;
  };
  press(200, 250, 1); // zone 1
  line.brake[199] = 0.06; // a ramp: 0.06 -> 1 crosses 0.12 at 199 + 0.06/0.94 m
  press(270, 290, 0.8); // re-applied 20 m after letting go: same zone
  press(600, 640, 0.5); // zone 2
  press(800, 820, 0.1); // a foot resting on the pedal: not a zone
  press(900, 905, 0.4); // zone 3...
  press(906, 909, 0.08); // ...dips but never below 0.05: still zone 3
  press(910, 930, 0.4);

  const b = G.detectBrakes(line, 1000);
  check('three zones, not five', b.length === 3, b.map((x) => (x.d * 1000).toFixed(1)).join(', '));
  check('the onset is where the pedal CROSSED 0.12, not the first sample over it', near(b[0].d * 1000, 199 + 0.06 / 0.94, 0.01), (b[0].d * 1000).toFixed(3));
  check('a re-application within 60 m is the same board', b.every((x) => Math.abs(x.d * 1000 - 270) > 1));
  check('a resting foot below 0.12 is no board', b.every((x) => Math.abs(x.d * 1000 - 800) > 1));
  check('a dip that stays above 0.05 does not split a zone', b.filter((x) => x.d * 1000 > 890).length === 1);
  check('boards carry world x/z from the line', near(b[1].z, 599.24, 0.01) && near(b[1].x, 0, 1e-9), b[1].z.toFixed(3));

  // Same pattern, but the gap after release is 61 m: now it is a new zone.
  const far = JSON.parse(JSON.stringify(line));
  for (let i = 270; i <= 290; i++) far.brake[i] = 0;
  for (let i = 312; i <= 330; i++) far.brake[i] = 0.8;
  check('…and one 61 m after letting go is a new board', G.detectBrakes(far, 1000).length === 4, G.detectBrakes(far, 1000).length);

  const started = JSON.parse(JSON.stringify(line));
  for (let i = 0; i <= 30; i++) started.brake[i] = 1;
  check('a lap that starts on the brakes has no onset there', G.detectBrakes(started, 1000).every((x) => x.d > 0.05));
  check('no brake channel is no boards', G.detectBrakes({ d: line.d, x: line.x, z: line.z }, 1000).length === 0);
  check('the thresholds are options', G.detectBrakes(line, 1000, { onAt: 0.09 }).length === 4);
}

console.log('');
console.log('12) detectApexes — the fallback apex pins');
{
  // Straight, then a 90° left of radius 50 m, then straight: one corner, and
  // its tightest point is in the middle of the arc.
  const P = [];
  for (let s = 0; s < 300; s += 1) P.push([0, s]);
  const arcLen = (Math.PI / 2) * 50;
  for (let s = 0; s < arcLen; s += 1) {
    const a = s / 50;
    P.push([-50 + 50 * Math.cos(a), 300 + 50 * Math.sin(a)]);
  }
  for (let s = 0; s < 300; s += 1) P.push([-50 - s, 350]);
  const total = P.length;
  const line = { d: P.map((_, i) => i / total), x: P.map((p) => p[0]), z: P.map((p) => p[1]), trackLengthM: total, full: false };
  const pl = G.prepareLine(line, 1, 1.5);
  const ap = G.detectApexes(pl);
  check('one corner, one pin', ap.length === 1, ap.length);
  const midArc = (300 + arcLen / 2) / total;
  check('…at the middle of the arc', ap.length === 1 && Math.abs(ap[0].apexD - midArc) * total < 6, ap.length && ((ap[0].apexD - midArc) * total).toFixed(1) + ' m');
  const straight = G.prepareLine({ d: [0, 0.25, 0.5, 0.75, 1], x: [0, 0, 0, 0, 0], z: [0, 250, 500, 750, 1000], trackLengthM: 1000 }, 1, 1.5);
  check('a straight has no apex', G.detectApexes(straight).length === 0);
}

console.log('');
console.log('13) the allocation-free camera, and the chase yaw');
{
  const cam = G.camera({ cx: 320, cy: 150, f: 900, back: 30, pitch: 0.2, height: 6.2, roadY: 1 });
  const view = G.setView({}, 37, 100, -50);
  const out = { x: 0, y: 0, z: 0 };
  let worst = 0;
  for (const [x, z, e] of [[110, -20, 1], [80, 30, 2.5], [130, 10, 0]]) {
    const l = G.worldToLocal(37, 100, -50, x, z);
    const ref = G.project(cam, l.lat, e, l.lon);
    const ok = G.projectWorld(cam, view, x, z, e, out);
    worst = Math.max(worst, ok && ref ? Math.hypot(out.x - ref.x, out.y - ref.y) : Infinity);
  }
  check('projectWorld is worldToLocal + project, exactly', worst < 1e-9, worst.toExponential(1));
  check('…and reports the near plane as false', G.projectWorld(cam, view, 100, -50 - 100 * Math.cos(37 * Math.PI / 180), 1, out) === false);

  const f = 900;
  const level = G.camera({ cx: 0, cy: 150, f, back: 0, pitch: G.horizonPitch(f, 105), height: 6, roadY: 0 });
  const far = G.project(level, 0, 6, 1e7); // at eye height, at infinity
  check('horizonPitch puts the horizon where it was asked', near(far.y, 150 - 105, 0.01), far.y.toFixed(3));

  check('chaseYaw blends the short way round', Math.abs(G.headingDelta(G.chaseYaw(179, -179, 0.5), 180)) < 1e-9, G.chaseYaw(179, -179, 0.5));
  check('…all car at share 0', near(G.chaseYaw(30, 60, 0), 30) && near(G.chaseYaw(30, 60, 1), 60));
  check('headingDelta is in [−180, 180)', G.headingDelta(-170, 170) === 20 && G.headingDelta(170, -170) === -20);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
console.log('');
process.exit(failed === 0 ? 0 : 1);
