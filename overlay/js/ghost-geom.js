/**
 * ghost-geom.js — the maths Ghost HUD draws with.
 * -----------------------------------------------------------------------------
 * All pure: put a world point in the driver's frame, read the road (and where
 * on it a world point is) off the learned map, read a position off a lap trace,
 * turn a lap into the evenly spaced smooth line that gets painted, find where
 * that lap braked and turned, and project the result through a chase camera.
 *
 * The hot-path helpers (`roadAt`, `roadDistanceOf`, `preparedAt`,
 * `projectWorld`) write into a caller-owned object or return a number, never a
 * fresh object: the widget calls them hundreds of times a frame at display
 * rate, and garbage made at that rate is collected as a visible hitch.
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
  function camera(opts, out) {
    var o = opts || {};
    var cam = out || {};
    cam.cx = o.cx || 0;
    cam.cy = o.cy || 0;
    cam.f = o.f || 600;
    cam.back = o.back === undefined ? 14 : o.back;
    cam.pitch = o.pitch === undefined ? 0.105 : o.pitch;
    cam.near = o.near === undefined ? 0.6 : o.near;
    cam.eyeY = (o.roadY || 0) + (o.height === undefined ? 3.1 : o.height);
    // Once per camera, not once per projected point: a frame projects ~750.
    cam.cp = Math.cos(cam.pitch);
    cam.sp = Math.sin(cam.pitch);
    return cam;
  }

  /**
   * Project a car-local ground point to the canvas.
   *
   * @returns {{x: number, y: number, z: number}|null} `null` behind the near
   * plane, which every caller treats as "break the line here" rather than as an
   * error — a road window that starts behind the camera is normal.
   */
  function project(cam, lat, elev, lon) {
    var q = { x: 0, y: 0, z: 0 };
    return projectLocal(cam, lat, elev, lon, q) ? q : null;
  }

  /** `project`, written into `out`. Returns false behind the near plane. */
  function projectLocal(cam, lat, elev, lon, out) {
    var cp = cam.cp === undefined ? Math.cos(cam.pitch) : cam.cp;
    var sp = cam.sp === undefined ? Math.sin(cam.pitch) : cam.sp;
    var ey = elev - cam.eyeY;
    var ez = lon + cam.back;
    var ry = ey * cp + ez * sp;
    var rz = -ey * sp + ez * cp;
    if (!(rz > cam.near)) return false;
    out.x = cam.cx + (cam.f * lat) / rz;
    out.y = cam.cy - (cam.f * ry) / rz;
    out.z = rz;
    return true;
  }

  /**
   * The pose the world is drawn relative to, with its trig done once.
   *
   * `worldToLocal` then `project` is the readable form and the tests keep using
   * it; this pair is the same transform for the render loop, which would
   * otherwise recompute one sine and one cosine and allocate two objects for
   * every one of ~750 points a frame.
   */
  function setView(view, headingDeg, px, pz) {
    var h = headingDeg * DEG;
    view.c = Math.cos(h);
    view.s = Math.sin(h);
    view.px = px;
    view.pz = pz;
    return view;
  }

  /** A world point through `view` and `cam` into `out`. False when unprojectable. */
  function projectWorld(cam, view, x, z, elev, out) {
    var dx = x - view.px;
    var dz = z - view.pz;
    return projectLocal(cam, dx * view.c - dz * view.s, elev, dx * view.s + dz * view.c, out);
  }

  /**
   * The pitch that puts the horizon `abovePx` above the optical centre.
   *
   * Framing is specified as "where the horizon sits" because that is what
   * reads on screen; a point at infinity lands at `cy − f·tan(pitch)`.
   */
  function horizonPitch(f, abovePx) {
    return Math.atan(abovePx / f);
  }

  /** Shortest signed difference `a − b` between two headings, degrees. */
  function headingDelta(a, b) {
    return ((((a - b + 180) % 360) + 360) % 360) - 180;
  }

  /**
   * The chase camera's yaw: part car heading, part road direction.
   *
   * Locked to the car, every steering correction and slide swings the whole
   * road across the widget, which reads as the road moving rather than the
   * car. Locked to the road, the car's own angle to the line disappears —
   * and that angle is half of what a line is for. A blend keeps both. Blended
   * the SHORT way round, or a car at 179° on a road at −179° would swing the
   * camera through 358° to travel two.
   */
  function chaseYaw(carDeg, roadDeg, roadShare) {
    return carDeg + headingDelta(roadDeg, carDeg) * roadShare;
  }

  /**
   * What the ghost was doing, as the colour every driving-aid line already uses.
   * Braking reads red, coasting amber, on the power green — so "it got on the
   * throttle earlier than you" is visible as the line turning green sooner.
   */
  function pedalColour(brake, throttle) {
    var k = pedalKind(brake, throttle);
    return k === PEDAL_BRAKE ? '#D55E00' : k === PEDAL_COAST ? '#E0A423' : '#2FBF71';
  }

  /** The same classification as an index, for a painter with its own palette. */
  var PEDAL_THROTTLE = 0;
  var PEDAL_COAST = 1;
  var PEDAL_BRAKE = 2;
  function pedalKind(brake, throttle) {
    if (brake > 0.18) return PEDAL_BRAKE;
    if (throttle < 0.55) return PEDAL_COAST;
    return PEDAL_THROTTLE;
  }

  /* ------------------------------------------------------------------------ *
   * The road, continuously.
   *
   * The map is binned at ~6 m. Read nearest-bin, the camera's eye height
   * steps every bin on a slope — the whole scene judders vertically — the line
   * lies on a staircase, and the ends of the drawn window jump 6 m at a time.
   * Everything below reads BETWEEN bins instead.
   * ------------------------------------------------------------------------ */

  /**
   * Metres between map points, from `lengthM / n` in preference to `binM`.
   *
   * The builder makes the bins exactly `lengthM / n` wide, but the wire rounds
   * `binM` to the centimetre — 6.00 for Road Atlanta's true 5.9963 — and over
   * 681 bins that rounding adds up to 2.5 m. Indexed by the rounded figure, the
   * map's distances stop agreeing with the lap's: the camera and the ghost's
   * line drift apart toward the end of the lap and snap back together at the
   * start/finish line. (`roadSlice`/`roadElevation` above keep their original
   * reading; nothing in the new painter uses them.)
   */
  function mapBin(shape) {
    var n = shape.points.length;
    if (shape.lengthM > 0) return shape.lengthM / n;
    return shape.binM > 0 ? shape.binM : 1;
  }

  /**
   * The lap length the continuous reads below wrap at, metres — the same
   * metres as `lap fraction × lengthM`, so a map distance and a ghost's `d`
   * convert with one multiply.
   */
  function mapLength(shape) {
    return shape.points.length * mapBin(shape);
  }

  /** Road elevation at a lap distance, LINEAR between bins. */
  function roadElevationAt(shape, distM) {
    if (!shape || !shape.points || !shape.points.length) return 0;
    var pts = shape.points;
    var n = pts.length;
    var u = distM / mapBin(shape);
    var i = Math.floor(u);
    var f = u - i;
    var a = pts[((i % n) + n) % n];
    var b = pts[(((i + 1) % n) + n) % n];
    var ya = a.length > 2 ? a[2] : 0;
    var yb = b.length > 2 ? b[2] : 0;
    return ya + (yb - ya) * f;
  }

  /**
   * The road centre at a lap distance, through a Catmull-Rom spline over the
   * map bins, with its unit tangent and (linear) elevation.
   *
   * Edges built from this are smooth curves rather than a 6 m polyline whose
   * kinks show at close range, and a window cut from it can start and end at
   * any distance — the ends slide with the car instead of snapping bin to bin.
   *
   * @returns {{x, z, y, tx, tz}} `out`, or a new object when none is given.
   */
  function roadAt(shape, distM, out) {
    var o = out || { x: 0, z: 0, y: 0, tx: 0, tz: 1 };
    var pts = shape.points;
    var n = pts.length;
    var u = distM / mapBin(shape);
    var i = Math.floor(u);
    var t = u - i;
    var p0 = pts[(((i - 1) % n) + n) % n];
    var p1 = pts[((i % n) + n) % n];
    var p2 = pts[(((i + 1) % n) + n) % n];
    var p3 = pts[(((i + 2) % n) + n) % n];
    o.x = catmull(p0[0], p1[0], p2[0], p3[0], t);
    o.z = catmull(p0[1], p1[1], p2[1], p3[1], t);
    var y1 = p1.length > 2 ? p1[2] : 0;
    var y2 = p2.length > 2 ? p2[2] : 0;
    o.y = y1 + (y2 - y1) * t;
    var dx = catmullSlope(p0[0], p1[0], p2[0], p3[0], t);
    var dz = catmullSlope(p0[1], p1[1], p2[1], p3[1], t);
    var len = Math.hypot(dx, dz);
    // A run of repeated map points has no direction; keep the caller's last
    // tangent rather than inventing one.
    if (len > 1e-9) {
      o.tx = dx / len;
      o.tz = dz / len;
    }
    return o;
  }

  /** d/dt of one axis of `catmull`. */
  function catmullSlope(p0, p1, p2, p3, t) {
    return (
      0.5 *
      (-p0 + p2 + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t * t)
    );
  }

  /**
   * Where on the map a world point is, as a CONTINUOUS lap distance.
   *
   * The wire's `lapFraction` is REST `lapDistance`: refreshed every ~150 ms,
   * not dead-reckoned, and measured 5–14 m stale against the shared-memory
   * position that places the camera. Anything positioned by it (the ghost's
   * gate, the ends of the drawn window) lunges forward ~7 times a second.
   * Projecting the per-frame position onto the centreline gives a distance that
   * moves every frame and agrees with the camera by construction.
   *
   * Searches `windowM` either side of `hintM` — the last answer, normally —
   * rather than the whole lap, and that is about correctness more than speed:
   * where two parts of a circuit run side by side (a hairpin's two straights),
   * the nearest segment on the WHOLE map can be the wrong one. A non-finite
   * hint scans the whole lap, which is how a position is first acquired.
   *
   * @param {number} maxOffM - Further than this from the centreline is "not on
   *   this road" (the pit lane, a teleport) rather than an answer.
   * @returns {number|null} Lap metres in `[0, mapLength)`, or null.
   */
  function roadDistanceOf(shape, x, z, hintM, windowM, maxOffM) {
    if (!shape || !shape.points || shape.points.length < 4) return null;
    var pts = shape.points;
    var n = pts.length;
    var bin = mapBin(shape);
    var k0 = 0;
    var k1 = n - 1;
    if (isFinite(hintM) && windowM > 0 && windowM * 2 < n * bin) {
      var c = Math.round(hintM / bin);
      var span = Math.ceil(windowM / bin);
      k0 = c - span;
      k1 = c + span;
    }
    var best = Infinity;
    var bestM = 0;
    for (var k = k0; k <= k1; k++) {
      var a = pts[((k % n) + n) % n];
      var b = pts[(((k + 1) % n) + n) % n];
      var vx = b[0] - a[0];
      var vz = b[1] - a[1];
      var vv = vx * vx + vz * vz;
      var t = vv > 1e-9 ? ((x - a[0]) * vx + (z - a[1]) * vz) / vv : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      var px = a[0] + vx * t - x;
      var pz = a[1] + vz * t - z;
      var dd = px * px + pz * pz;
      if (dd < best) {
        best = dd;
        bestM = (k + t) * bin;
      }
    }
    var lim = maxOffM > 0 ? maxOffM : 40;
    if (!(best <= lim * lim)) return null;
    var period = n * bin;
    return ((bestM % period) + period) % period;
  }

  /* ------------------------------------------------------------------------ *
   * The ghost's line, prepared once per lap.
   * ------------------------------------------------------------------------ */

  /**
   * Resample a lap's line to a uniform step along its own arc length, low-pass
   * it, and give every sample its normal and pedal state.
   *
   * Traces are stored at 10 cm resolution and Catmull-Rom passes THROUGH every
   * quantised sample, so the rounding survives as a lateral wobble — about
   * 2 px at 20 m on a 640 px widget, visible as a staircase. A Gaussian over a
   * few metres removes it without moving the line anywhere a driver could see
   * (sigma 1.5 m on a road ~12 m wide).
   *
   * Uniform spacing is also what lets the painter walk the line by INDEX — one
   * sample a metre — with no search per point, and what makes "±3 samples"
   * mean "±3 m" for the colour blend and the curvature read below.
   *
   * Runs once per lap selection, never per frame: ~5 ms for a 4 km lap.
   *
   * @param {object} line - `/ghost.json`: `d`, `x`, `z`, optional `brake`/`throttle`, `full`.
   * @param {number} lapM - The lap's length; `line.trackLengthM` when omitted.
   * @returns {object|null} Typed columns `d x z nx nz brake throttle`, plus
   *   `n`, `step`, `closed`. Null when the line cannot support it.
   */
  function prepareLine(line, stepM, sigmaM, lapM) {
    if (!line || !line.d || !line.x || !line.z || line.d.length < 4) return null;
    var L = lapM > 0 ? lapM : line.trackLengthM;
    if (!(L > 0) || !(stepM > 0)) return null;
    var fine = Math.min(0.25, stepM / 4) / L;
    var d0 = line.d[0];
    var d1 = line.d[line.d.length - 1];
    var D = [];
    var X = [];
    var Z = [];
    var B = [];
    var T = [];
    var prev = lineAtSmooth(line, d0);
    if (!prev) return null;
    var prevD = d0;
    var acc = 0;
    var nextAt = 0;
    for (var d = d0; d <= d1 + fine / 2; d += fine) {
      if (d > d1) d = d1;
      var p = lineAtSmooth(line, d);
      var seg = Math.hypot(p.x - prev.x, p.z - prev.z);
      // Emit every whole step that falls inside this fine segment, placed by
      // interpolating to the exact arc length rather than at the segment's end.
      while (acc + seg >= nextAt) {
        var f = seg > 0 ? (nextAt - acc) / seg : 0;
        var dd = prevD + (d - prevD) * f;
        D.push(dd);
        X.push(prev.x + (p.x - prev.x) * f);
        Z.push(prev.z + (p.z - prev.z) * f);
        B.push(channelAt(line, 'brake', dd));
        T.push(channelAt(line, 'throttle', dd));
        nextAt += stepM;
      }
      acc += seg;
      prev = p;
      prevD = d;
      if (d === d1) break;
    }
    var n = D.length;
    if (n < 4) return null;
    var closed = !!line.full;
    var xs = gaussian(X, n, sigmaM / stepM, closed);
    var zs = gaussian(Z, n, sigmaM / stepM, closed);
    var nx = new Float32Array(n);
    var nz = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      // Central difference, wrapping on a full lap and one-sided at the ends
      // of a partial one.
      var ia = i > 0 ? i - 1 : closed ? n - 1 : i;
      var ib = i < n - 1 ? i + 1 : closed ? 0 : i;
      var tx = xs[ib] - xs[ia];
      var tz = zs[ib] - zs[ia];
      var len = Math.hypot(tx, tz);
      if (len > 1e-9) {
        // Right of travel: forward (sin h, cos h) has right (cos h, −sin h).
        nx[i] = tz / len;
        nz[i] = -tx / len;
      } else if (i > 0) {
        nx[i] = nx[i - 1];
        nz[i] = nz[i - 1];
      }
    }
    return {
      n: n,
      step: stepM,
      closed: closed,
      d: Float64Array.from(D),
      x: xs,
      z: zs,
      nx: nx,
      nz: nz,
      brake: Float32Array.from(B),
      throttle: Float32Array.from(T),
    };
  }

  /** A normalised Gaussian blur of one column, sigma in samples. */
  function gaussian(src, n, sigma, closed) {
    var out = new Float64Array(n);
    if (!(sigma > 0)) {
      for (var c = 0; c < n; c++) out[c] = src[c];
      return out;
    }
    var r = Math.max(1, Math.round(sigma * 3));
    var w = new Float64Array(2 * r + 1);
    for (var k = -r; k <= r; k++) w[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma));
    for (var i = 0; i < n; i++) {
      var acc = 0;
      var ws = 0;
      for (var j = -r; j <= r; j++) {
        var q = i + j;
        var v;
        if (closed) v = src[((q % n) + n) % n];
        else if (q < 0) v = 2 * src[0] - src[Math.min(n - 1, -q)];
        else if (q >= n) v = 2 * src[n - 1] - src[Math.max(0, 2 * (n - 1) - q)];
        // An open end is mirrored THROUGH its endpoint rather than dropped: a
        // window that just lost its far side averages toward the middle and
        // would pull a partial lap's ends in by a metre.
        else v = src[q];
        acc += v * w[j + r];
        ws += w[j + r];
      }
      out[i] = acc / ws;
    }
    return out;
  }

  /** First prepared index whose lap fraction is ≥ `d` (clamped to the ends). */
  function preparedIndex(pl, d) {
    var dd = pl.d;
    var hi = pl.n - 1;
    if (!(d > dd[0])) return 0;
    if (d >= dd[hi]) return hi;
    var lo = 0;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (dd[mid] >= d) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /**
   * The prepared line at a lap fraction, BETWEEN samples.
   *
   * Anything placed by snapping to the nearest sample moves in 1 m steps; at
   * display rate that is a visible tick in the ghost's gate and in where the
   * line begins under the car. `out.i` is the fractional index, so a caller
   * can interpolate its own per-sample columns (elevation, colour) the same way.
   *
   * @returns {{x, z, nx, nz, i}} `out`, or a new object when none is given.
   */
  function preparedAt(pl, d, out) {
    var o = out || { x: 0, z: 0, nx: 0, nz: 0, i: 0 };
    var hi = preparedIndex(pl, d);
    var lo = hi > 0 ? hi - 1 : 0;
    var span = pl.d[hi] - pl.d[lo];
    var f = span > 0 ? (d - pl.d[lo]) / span : 0;
    if (f < 0) f = 0;
    else if (f > 1) f = 1;
    o.x = pl.x[lo] + (pl.x[hi] - pl.x[lo]) * f;
    o.z = pl.z[lo] + (pl.z[hi] - pl.z[lo]) * f;
    var nx = pl.nx[lo] + (pl.nx[hi] - pl.nx[lo]) * f;
    var nz = pl.nz[lo] + (pl.nz[hi] - pl.nz[lo]) * f;
    var len = Math.hypot(nx, nz) || 1;
    o.nx = nx / len;
    o.nz = nz / len;
    o.i = lo + f;
    return o;
  }

  /* ------------------------------------------------------------------------ *
   * Where the lap braked and turned — fallbacks for a server that does not
   * send `brakes` / `corners` with `/ghost.json` (an older build, a fixture).
   * ------------------------------------------------------------------------ */

  /**
   * The lap's brake onsets: `[{d, x, z}]`, the same shape the server sends.
   *
   * Hysteresis rather than one threshold, because a driver's brake trace is
   * not a step: it overshoots, modulates and trails off. On at ≥ 0.12 (a real
   * application, not a foot resting on the pedal); off only below 0.05; and a
   * re-application within 60 m of letting go is the same braking zone — a
   * stab-release-stab into one corner is one board, not three.
   *
   * The onset is interpolated to where the pedal CROSSED the threshold, not the
   * first sample over it: samples are metres apart at speed, and a brake board
   * is something a driver aims at to the metre.
   *
   * A lap that starts already braking has no onset for that zone — it began on
   * the previous lap.
   */
  function detectBrakes(line, lapM, opts) {
    var o = opts || {};
    var on = o.onAt > 0 ? o.onAt : 0.12;
    var off = o.offBelow > 0 ? o.offBelow : 0.05;
    var gapM = o.minGapM >= 0 ? o.minGapM : 60;
    var out = [];
    if (!line || !line.d || !line.brake || line.brake.length !== line.d.length || !(lapM > 0)) {
      return out;
    }
    var d = line.d;
    var b = line.brake;
    var braking = b[0] >= on;
    var releasedAt = -Infinity;
    for (var i = 1; i < d.length; i++) {
      if (!braking && b[i] >= on) {
        braking = true;
        var f = b[i] > b[i - 1] ? (on - b[i - 1]) / (b[i] - b[i - 1]) : 1;
        var dOn = d[i - 1] + (d[i] - d[i - 1]) * f;
        if ((dOn - releasedAt) * lapM >= gapM) {
          var p = lineAtSmooth(line, dOn);
          if (p) out.push({ d: dOn, x: p.x, z: p.z });
        }
      } else if (braking && b[i] < off) {
        braking = false;
        releasedAt = d[i];
      }
    }
    return out;
  }

  /**
   * Where the ghost's line turned hardest, corner by corner: `[{apexD, apexX,
   * apexZ}]`, a subset of the server's `corners` shape.
   *
   * Curvature from the turn between the chords 8 m either side, on a PREPARED
   * line (so 8 samples are 8 m). A stretch counts as a corner once it curves
   * tighter than a 140 m radius and stays one until it eases past 1.67× that,
   * with 50 m between pins: a long sweeper read with a single threshold
   * flickers in and out and plants a picket fence of pins.
   *
   * This is a fact about the LINE, not the circuit — it is where that lap's
   * path bent most, which on a well-driven lap is its apex. It knows nothing
   * of kerbs.
   */
  function detectApexes(pl, opts) {
    var o = opts || {};
    var out = [];
    if (!pl || pl.n < 20) return out;
    var K = Math.max(1, Math.round((o.chordM > 0 ? o.chordM : 8) / pl.step));
    var kIn = o.minCurvature > 0 ? o.minCurvature : 1 / 140;
    var kOut = kIn * 0.6;
    var minGap = o.minGapM > 0 ? o.minGapM : 50;
    var inCorner = false;
    var bestI = -1;
    var bestJ = -1;
    var bestK = 0;
    var lastAt = -Infinity;
    for (var j = K; j < pl.n - K; j++) {
      var ax = pl.x[j] - pl.x[j - K];
      var az = pl.z[j] - pl.z[j - K];
      var bx = pl.x[j + K] - pl.x[j];
      var bz = pl.z[j + K] - pl.z[j];
      var la = Math.hypot(ax, az);
      var lb = Math.hypot(bx, bz);
      if (la < 1e-6 || lb < 1e-6) continue;
      var cross = (ax * bz - az * bx) / (la * lb);
      var kap = Math.abs(Math.asin(Math.max(-1, Math.min(1, cross)))) / ((la + lb) / 2);
      if (!inCorner && kap > kIn) {
        inCorner = true;
        bestK = 0;
      }
      if (inCorner) {
        // The tightest point — but a constant-radius stretch is a PLATEAU of
        // equal curvature, and "first sample of the maximum" would pin its
        // entry. Within 2% counts as the same peak, and the pin goes mid-plateau.
        if (kap > bestK * 1.02) {
          bestK = kap;
          bestI = bestJ = j;
        } else if (kap >= bestK * 0.98 && j === bestJ + 1) {
          bestJ = j;
          if (kap > bestK) bestK = kap;
        }
      }
      if (inCorner && kap < kOut) {
        inCorner = false;
        var apex = (bestI + bestJ) >> 1;
        if ((apex - lastAt) * pl.step >= minGap) {
          out.push({ apexD: pl.d[apex], apexX: pl.x[apex], apexZ: pl.z[apex] });
          lastAt = apex;
        }
      }
    }
    return out;
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
    // Continuous road reads.
    mapLength: mapLength,
    roadElevationAt: roadElevationAt,
    roadAt: roadAt,
    roadDistanceOf: roadDistanceOf,
    // The prepared line.
    prepareLine: prepareLine,
    preparedIndex: preparedIndex,
    preparedAt: preparedAt,
    // Fallback marks.
    detectBrakes: detectBrakes,
    detectApexes: detectApexes,
    // Camera, allocation-free.
    projectLocal: projectLocal,
    setView: setView,
    projectWorld: projectWorld,
    horizonPitch: horizonPitch,
    headingDelta: headingDelta,
    chaseYaw: chaseYaw,
    pedalKind: pedalKind,
    PEDAL_THROTTLE: PEDAL_THROTTLE,
    PEDAL_COAST: PEDAL_COAST,
    PEDAL_BRAKE: PEDAL_BRAKE,
  };
});
