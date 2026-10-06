/**
 * ghost-geom.js — the maths Ghost HUD draws with.
 * -----------------------------------------------------------------------------
 * Four jobs, all pure: put a world point in the driver's frame, cut the stretch
 * of road they can see, read a position off a lap trace, and project the result
 * through a chase camera.
 *
 * Separated from the widget because none of it needs a canvas, and geometry that
 * can only be checked by squinting at a screen is geometry that silently goes
 * wrong. A flipped sign here puts the car you are chasing on the wrong side of
 * the road — plausible-looking, and exactly the lie a training aid must never
 * tell. See `scripts/test-ghostgeom.js`.
 *
 * Loaded as a classic script by the overlay (`window.ApexGhostGeom`) and
 * `require`d by its test, the same arrangement `feature-catalog.js` uses.
 *
 * ## Axes, once, so nothing downstream has to guess
 * The sim's world is left-handed with Y up. `frame.player.motion.heading` is
 * degrees, `0` = the car's nose along world **+Z**, `+90` = along **+X**.
 * Car-local is X right, Y up, Z ahead — the same convention `radar.ts` uses, so
 * `+lat` is to the driver's right and `+lon` is ahead of them.
 */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ApexGhostGeom = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DEG = Math.PI / 180;

  /**
   * A world point in the driver's frame.
   *
   * This is `buildRadar`'s projection reduced to the ground plane. The full
   * version dots against the car's orientation matrix, but `mOri` never reaches
   * the wire; `headingOri()` in `radar.ts` is the proof that heading carries the
   * same information for a flat transform, and this is that transform:
   *
   *   forward = ( sin h, cos h )      right = ( cos h, −sin h )
   *
   * @param {number} headingDeg - `frame.player.motion.heading`.
   * @param {number} px - Player world X.  @param {number} pz - Player world Z.
   * @param {number} x - Target world X.   @param {number} z - Target world Z.
   * @returns {{lat: number, lon: number}} Metres: `+lat` right, `+lon` ahead.
   */
  function worldToLocal(headingDeg, px, pz, x, z) {
    var h = headingDeg * DEG;
    var c = Math.cos(h);
    var s = Math.sin(h);
    var dx = x - px;
    var dz = z - pz;
    return { lat: dx * c - dz * s, lon: dx * s + dz * c };
  }

  /**
   * The stretch of road between two lap distances, as centre points with the
   * outward normal at each.
   *
   * There was no helper for this: `trackmap.js`'s `buildEdges` walks the WHOLE
   * lap in index order because a plan view draws all of it, and `TrackMapPath`
   * stores no tangents. A camera on the road wants a window, and it wants it to
   * wrap — the window straddles the start/finish line once a lap, and a slice
   * that stopped at index 0 would blank the road exactly as the driver crossed
   * the line.
   *
   * @param {object} shape - `/trackmap.json`: `points[[x,z,y]]`, `binM`.
   * @param {number} fromM - Lap distance to start at, metres. May be negative.
   * @param {number} toM - Lap distance to end at, metres. May exceed the lap.
   * @returns {Array<{x,z,y,nx,nz}>} Empty when the shape is unusable.
   */
  function roadSlice(shape, fromM, toM) {
    if (!shape || !shape.points || shape.points.length < 4) return [];
    var pts = shape.points;
    var n = pts.length;
    var binM = shape.binM > 0 ? shape.binM : (shape.lengthM || n) / n;
    var i0 = Math.floor(fromM / binM);
    var i1 = Math.ceil(toM / binM);
    // A window longer than the lap would draw the road on top of itself.
    if (i1 - i0 > n) i1 = i0 + n;
    var out = [];
    for (var i = i0; i <= i1; i++) {
      var a = pts[((i % n) + n) % n];
      var b = pts[((((i + 1) % n) + n) % n)];
      var tx = b[0] - a[0];
      var tz = b[1] - a[1];
      var len = Math.hypot(tx, tz);
      // A repeated map point has no direction. Carry the previous normal rather
      // than emitting a zero one, which would collapse the road to a line there.
      var prev = out.length ? out[out.length - 1] : null;
      var nx = len > 1e-6 ? tz / len : prev ? prev.nx : 0;
      var nz = len > 1e-6 ? -tx / len : prev ? prev.nz : 0;
      out.push({ x: a[0], z: a[1], y: a.length > 2 ? a[2] : 0, nx: nx, nz: nz });
    }
    return out;
  }

  /**
   * Road elevation at a lap distance, from the map rather than from any lap.
   *
   * Traces deliberately record no `y`: the elevation of a lap is the road's, not
   * the driver's (see `TraceChannels.x`). So everything drawn on the road is
   * lifted to the road's own height here, which also means two laps never
   * disagree about where the surface is.
   */
  function roadElevation(shape, distM) {
    if (!shape || !shape.points || !shape.points.length) return 0;
    var pts = shape.points;
    var n = pts.length;
    var binM = shape.binM > 0 ? shape.binM : (shape.lengthM || n) / n;
    var i = ((Math.floor(distM / binM) % n) + n) % n;
    var p = pts[i];
    return p.length > 2 ? p[2] : 0;
  }

  /**
   * Interpolate a lap's driven position at a lap fraction.
   *
   * Binary search for the same reason `paceDelta.interpTime` uses one: the
   * columns are ~800 long and this is called for every point of two lines every
   * frame, so a scan from the front is thousands of compares to find what ten
   * find.
   *
   * @param {object} line - `{d: number[], x: number[], z: number[]}`.
   * @param {number} d - Lap fraction, `0..1`.
   * @returns {{x: number, z: number}|null} `null` when the columns cannot support it.
   */
  function lineAt(line, d) {
    if (!line || !line.d || !line.x || !line.z) return null;
    var dd = line.d;
    var n = dd.length;
    if (n < 2 || line.x.length !== n || line.z.length !== n) return null;
    if (!(d >= dd[0])) return { x: line.x[0], z: line.z[0] };
    if (d >= dd[n - 1]) return { x: line.x[n - 1], z: line.z[n - 1] };
    var lo = 1;
    var hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (dd[mid] >= d) hi = mid;
      else lo = mid + 1;
    }
    var a = dd[lo - 1];
    var b = dd[lo];
    var f = b > a ? (d - a) / (b - a) : 0;
    return {
      x: line.x[lo - 1] + (line.x[lo] - line.x[lo - 1]) * f,
      z: line.z[lo - 1] + (line.z[lo] - line.z[lo - 1]) * f,
    };
  }

  /**
   * The same position, but through a Catmull-Rom spline rather than straight
   * between samples.
   *
   * Traces are decimated to ~0.1% of a lap and rounded to 10 cm, so at racing
   * speed consecutive samples are metres apart. Joined with straight lines the
   * result is a visibly faceted polyline — every sample shows as a corner, and
   * a racing line made of corners is the one thing a racing line must not look
   * like. A spline through the same points removes the facets without inventing
   * a different route: it passes through every recorded sample.
   *
   * UNIFORM Catmull-Rom, which is normally the risky choice: it overshoots
   * into a loop where three samples bunch together. That failure mode does not
   * arise here, and for a structural reason rather than by luck — the recorder
   * decimates on DISTANCE (`MIN_D_STEP` in `lapTrace.ts`), not on time, so the
   * samples are already near-equidistant along the road whatever the car was
   * doing. If that decimation ever becomes time-based, this needs to become
   * centripetal.
   *
   * Measured against a known arc sampled every 7.5 degrees: linear chords
   * deviate up to 10.7 cm, the spline 0.03 cm.
   */
  function lineAtSmooth(line, d) {
    if (!line || !line.d || !line.x || !line.z) return null;
    var dd = line.d;
    var n = dd.length;
    if (n < 4 || line.x.length !== n || line.z.length !== n) return lineAt(line, d);
    if (!(d > dd[0]) || d >= dd[n - 1]) return lineAt(line, d);
    var lo = 1;
    var hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (dd[mid] >= d) hi = mid;
      else lo = mid + 1;
    }
    var i1 = lo - 1;
    var i2 = lo;
    var i0 = i1 > 0 ? i1 - 1 : i1;
    var i3 = i2 < n - 1 ? i2 + 1 : i2;
    var span = dd[i2] - dd[i1];
    var t = span > 0 ? (d - dd[i1]) / span : 0;
    return {
      x: catmull(line.x[i0], line.x[i1], line.x[i2], line.x[i3], t),
      z: catmull(line.z[i0], line.z[i1], line.z[i2], line.z[i3], t),
    };
  }

  /** One axis of a uniform Catmull-Rom segment, t in 0..1 between p1 and p2. */
  function catmull(p0, p1, p2, p3, t) {
    var t2 = t * t;
    var t3 = t2 * t;
    return (
      0.5 *
      (2 * p1 +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    );
  }

  /** The same interpolation for any scalar channel riding the line. */
  function channelAt(line, key, d) {
    var col = line && line[key];
    if (!col || !line.d || col.length !== line.d.length || col.length < 2) return 0;
    var dd = line.d;
    var n = dd.length;
    if (!(d >= dd[0])) return col[0];
    if (d >= dd[n - 1]) return col[n - 1];
    var lo = 1;
    var hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (dd[mid] >= d) hi = mid;
      else lo = mid + 1;
    }
    var a = dd[lo - 1];
    var b = dd[lo];
    var f = b > a ? (d - a) / (b - a) : 0;
    return col[lo - 1] + (col[lo] - col[lo - 1]) * f;
  }

  /**
   * Build the chase camera for a frame.
   *
   * `eyeY` is the one that bites. It must be the player's own ROAD elevation
   * plus the eye height, not an absolute world height: a circuit's elevation
   * swings tens of metres (Road Atlanta runs −3.7 m to +4.5 m), so a camera
   * pinned to absolute Y sits underground on the climbs and in the air on the
   * descents. The prototype did exactly that and the whole frame went empty
   * wherever the track rose.
   */
  function camera(opts) {
    var o = opts || {};
    return {
      cx: o.cx || 0,
      cy: o.cy || 0,
      f: o.f || 600,
      back: o.back === undefined ? 14 : o.back,
      pitch: o.pitch === undefined ? 0.105 : o.pitch,
      near: o.near === undefined ? 0.6 : o.near,
      eyeY: (o.roadY || 0) + (o.height === undefined ? 3.1 : o.height),
    };
  }

  /**
   * Project a car-local ground point to the canvas.
   *
   * @returns {{x: number, y: number, z: number}|null} `null` behind the near
   * plane, which every caller treats as "break the line here" rather than as an
   * error — a road window that starts behind the camera is normal.
   */
  function project(cam, lat, elev, lon) {
    var ey = elev - cam.eyeY;
    var ez = lon + cam.back;
    var cp = Math.cos(cam.pitch);
    var sp = Math.sin(cam.pitch);
    var ry = ey * cp + ez * sp;
    var rz = -ey * sp + ez * cp;
    if (!(rz > cam.near)) return null;
    return { x: cam.cx + (cam.f * lat) / rz, y: cam.cy - (cam.f * ry) / rz, z: rz };
  }

  /**
   * What the ghost was doing, as the colour every driving-aid line already uses.
   * Braking reads red, coasting amber, on the power green — so "it got on the
   * throttle earlier than you" is visible as the line turning green sooner.
   */
  function pedalColour(brake, throttle) {
    if (brake > 0.18) return '#D55E00';
    if (throttle < 0.55) return '#E0A423';
    return '#2FBF71';
  }

  return {
    worldToLocal: worldToLocal,
    roadSlice: roadSlice,
    roadElevation: roadElevation,
    lineAt: lineAt,
    lineAtSmooth: lineAtSmooth,
    channelAt: channelAt,
    camera: camera,
    project: project,
    pedalColour: pedalColour,
  };
});
