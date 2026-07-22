/**
 * widgets/chassis.js — a wireframe GT3 seen from behind and above, with live
 * corner loads and suspension travel.
 * -----------------------------------------------------------------------------
 * Renders `frame.player.chassis` (see src/telemetry/chassis.ts, which owns every
 * threshold — nothing here decides what counts as overloaded or airborne) plus
 * `frame.player.motion` for attitude and `frame.player.tyres` for heat.
 *
 * ## The view
 * A fixed camera at the mid-point between directly behind and directly above —
 * 45° elevation, on the car's centreline. That single angle is what makes both
 * halves of the readout legible at once: roll is visible because you can see
 * across the car, and pitch is visible because you can see along it. Directly
 * behind would hide pitch; directly above would hide both.
 *
 * ## What moves, and what does not
 * The BODY rotates about the car's centre — a point inside the body at mid
 * wheelbase, which is the pivot a driver actually feels. The WHEELS do not
 * rotate with it: they stay on the road and move only vertically, by their own
 * suspension deflection.
 *
 * That split is the whole point of the widget. If the wheels rotated with the
 * body, the car would look like a rigid model being waggled and the suspension
 * would be invisible. Keeping the wheels planted means the gap between body and
 * wheel IS the suspension travel, so compression and droop are read directly
 * off the picture rather than only off the numbers.
 *
 * ## Why the attitude is exaggerated
 * A GT3 rolls perhaps 1.5° and pitches under 2°. Drawn true-to-scale the car
 * would look welded solid, so body rotation is multiplied by ATT_GAIN. The
 * readout underneath always shows the TRUE degrees — the picture is an
 * amplifier, the numbers are the instrument, and the header says so. `?gain=`
 * overrides it (1 = true scale) for anyone who wants the honest angle.
 *
 * Modes, each independently switchable from the Browser Source URL:
 *
 *   ?car=on|off    CAR    — the wireframe, corner load columns and flags.
 *   ?susp=on|off   SUSP   — the four-corner suspension/load readout table.
 *   ?dist=on|off   DIST   — front/rear, left/right and cross-weight bars.
 *
 * All three default ON. Turning all three off renders a note rather than an
 * empty frame.
 *
 * Runs at full broadcast rate (throttleMs 0).
 */
(function () {
  "use strict";

  /* ------------------------------ tuning ---------------------------------- */

  /**
   * Body rotation multiplier. 7 makes a 1.5° roll read as a clear 10.5° on
   * screen — obvious at streaming resolution without the car looking like it is
   * falling over under braking.
   */
  var ATT_GAIN = 7;

  /** Camera elevation, degrees. 45 = exactly midway behind/above (see header). */
  var CAM_ELEV_DEG = 45;

  /**
   * Suspension travel multiplier for the drawn body/wheel gap. Real travel is a
   * few tens of mm on a car drawn ~4.5 m long; at true scale the body would
   * move a fraction of a pixel. Same bargain as ATT_GAIN — the table shows mm.
   */
  var TRAVEL_GAIN = 9;

  /** Load-column height at ratio 1.0, in metres of car-space. */
  var COLUMN_UNIT_M = 0.55;

  /** localStorage key for the operator's chosen opacity. */
  var OPACITY_KEY = "apex-chassis-opacity";
  /** Floor for the slider — below this the widget is invisible, not translucent. */
  var MIN_OPACITY = 0.15;

  /* ------------------------------ palette --------------------------------- */
  // Canvas needs literals, so these mirror the tokens in css/theme.css. Keep in
  // step with it if the brand palette moves.
  var C_BODY = "#9fb4d8"; // body wireframe
  var C_BODY_HI = "#dbe4ff"; // wing, and any edge that should read as nearest
  var C_GROUND = "#333d5c"; // road grid
  var C_OK = "#35d07f"; // normal load
  var C_LIGHT = "#ffd23e"; // gone light
  var C_AIR = "#22d3ee"; // airborne
  var C_OVER = "#ff4d4d"; // overloaded

  /* ---------------------------- car geometry ------------------------------ */

  /**
   * The GT3 as a series of cross-sections along its length, in METRES, with the
   * origin at the car's centre: mid-wheelbase longitudinally, and at the height
   * the body pivots about. `+x` right, `+y` up, `+z` forward.
   *
   * Built from stations rather than as a hand-listed edge soup because a
   * station list is something you can actually edit — nudge one number and the
   * body reshapes consistently, with the longitudinal stringers following.
   *
   *   z   station position along the car
   *   w   half-width at floor level
   *   bw  half-width at the waist, and `by` its height
   *   rw  half-width of the cabin, `0` where there is no roof, `ry` its height
   */
  var GROUND_Y = -0.42;
  var STATIONS = [
    { z: 2.30, w: 0.30, bw: 0.36, by: -0.18, rw: 0, ry: 0 }, // splitter / nose tip
    { z: 1.90, w: 0.86, bw: 0.78, by: -0.02, rw: 0, ry: 0 }, // front clam
    { z: 1.32, w: 1.02, bw: 0.90, by: 0.14, rw: 0, ry: 0 }, // front axle line
    { z: 0.80, w: 1.00, bw: 0.92, by: 0.18, rw: 0.40, ry: 0.62 }, // screen base
    { z: 0.10, w: 1.00, bw: 0.94, by: 0.20, rw: 0.46, ry: 0.72 }, // roof front
    { z: -0.60, w: 1.01, bw: 0.93, by: 0.18, rw: 0.45, ry: 0.71 }, // roof rear
    { z: -1.10, w: 1.02, bw: 0.90, by: 0.14, rw: 0.32, ry: 0.60 }, // rear screen
    { z: -1.85, w: 0.98, bw: 0.84, by: 0.08, rw: 0, ry: 0 }, // rear haunch
    { z: -2.30, w: 0.72, bw: 0.60, by: -0.04, rw: 0, ry: 0 }, // tail
  ];

  /** Wheel positions and size, metres. Axles match the 1.32/-1.85 stations. */
  var WHEEL_R = 0.36;
  var WHEEL_X = 0.92;
  var AXLE_F_Z = 1.32;
  var AXLE_R_Z = -1.32;
  var WHEEL_Y = GROUND_Y + WHEEL_R;

  /**
   * The four corners in the order the telemetry uses (FL, FR, RL, RR), each with
   * its position and the label the readout shows. One list drives the 3D
   * markers, the flags and the table, so they can never disagree about which
   * corner is which.
   */
  var CORNERS = [
    { key: "frontLeft", label: "FL", x: -WHEEL_X, z: AXLE_F_Z, tyre: "frontLeft" },
    { key: "frontRight", label: "FR", x: WHEEL_X, z: AXLE_F_Z, tyre: "frontRight" },
    { key: "rearLeft", label: "RL", x: -WHEEL_X, z: AXLE_R_Z, tyre: "rearLeft" },
    { key: "rearRight", label: "RR", x: WHEEL_X, z: AXLE_R_Z, tyre: "rearRight" },
  ];

  /** Rear wing, metres: main plane plus endplates. A GT3's clearest signature. */
  var WING = { z: -2.12, y: 0.88, halfSpan: 0.88, chord: 0.30, plateTop: 0.98, plateBot: 0.52 };

  /* ------------------------------- state ---------------------------------- */

  var modeCar = true, modeSusp = true, modeDist = true;
  var canvas, gctx, dpr = 1;
  var cssW = 0, cssH = 0;
  var headerMeta;
  var cells = {}; // suspension table value cells, by "<corner>.<field>"
  var distEls = {};
  var cache = {};
  var attGain = ATT_GAIN;

  /** Canvas height (CSS px). Tall enough that a 4.6 m car foreshortened to 45°
   * still leaves headroom for the load columns and their flags. */
  var H_CAR = 210;

  function sizeCanvas() {
    if (!canvas) return;
    cssW = canvas.clientWidth || 260;
    cssH = H_CAR;
    canvas.style.height = cssH + "px";
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------------------------- 3D projection ----------------------------- */

  var camCos = Math.cos((CAM_ELEV_DEG * Math.PI) / 180);
  var camSin = Math.sin((CAM_ELEV_DEG * Math.PI) / 180);

  /**
   * Camera azimuth in degrees, `0` = exactly on the car's centreline.
   *
   * Zero is the default because it is the view this widget is specified around
   * — the mid-point between directly behind and directly above — and because
   * on-axis is the honest one for an instrument: roll shows as pure left/right
   * asymmetry and pitch as pure vertical, with no perspective mixing the two.
   *
   * It has one unavoidable cost. A wheel is a circle in the y–z plane, and at
   * azimuth 0 the view direction lies inside that plane, so every wheel
   * projects to a line — they render as slabs, not discs. That is geometry, not
   * a bug, and no amount of drawing detail fixes it. Anyone who would rather
   * have a car that reads as three-dimensional than an instrument that reads
   * as exact can set `?yaw=15` and get elliptical wheels.
   */
  var camYawCos = 1, camYawSin = 0;

  function setYaw(deg) {
    var r = (deg * Math.PI) / 180;
    camYawCos = Math.cos(r);
    camYawSin = Math.sin(r);
  }

  // Body attitude for the current frame, as sin/cos pairs so the per-vertex
  // transform is multiply-only. Rebuilt once per draw, not per point.
  var rollC = 1, rollS = 0, pitchC = 1, pitchS = 0;

  function setAttitude(pitchDeg, rollDeg) {
    var p = (pitchDeg * attGain * Math.PI) / 180;
    var r = (rollDeg * attGain * Math.PI) / 180;
    pitchC = Math.cos(p);
    pitchS = Math.sin(p);
    rollC = Math.cos(r);
    rollS = Math.sin(r);
  }

  /**
   * Car-space point → screen, for a point that belongs to the BODY (so it takes
   * the pitch/roll rotation about the origin).
   *
   * Roll is applied before pitch, matching the physical order: the body leans on
   * its springs about the long axis, and that whole leaning body then pitches.
   *
   * Sign conventions follow src/telemetry/motion.ts exactly — roll positive =
   * right side UP, pitch positive = nose UP. Getting either backwards produces a
   * car that leans into its corners, which looks plausible and is wrong.
   */
  function projBody(x, y, z, out) {
    // Roll about the forward axis: +x rises as roll goes positive.
    var x1 = x * rollC - y * rollS;
    var y1 = y * rollC + x * rollS;
    // Pitch about the right axis: +z (nose) rises as pitch goes positive.
    var z1 = z * pitchC - y1 * pitchS;
    var y2 = y1 * pitchC + z * pitchS;
    return proj(x1, y2, z1, out);
  }

  /**
   * Car-space point → screen for a point that does NOT rotate with the body:
   * the wheels, the ground grid and the load columns, all of which live in the
   * road's frame rather than the chassis's.
   */
  function proj(x, y, z, out) {
    out = out || {};
    // Swing the camera around the vertical axis first (a no-op at the default
    // yaw of 0), then drop it to the elevation angle.
    var xr = x * camYawCos + z * camYawSin;
    var zr = z * camYawCos - x * camYawSin;
    out.x = xr;
    // Screen y grows downward, hence the negation: a point higher in the world
    // and a point further up the track both move UP the screen.
    out.y = -(y * camCos + zr * camSin);
    // Painter's depth — larger is further away, so the nose sorts behind.
    out.d = zr * camCos - y * camSin;
    return out;
  }

  // Scratch objects, reused so a 30 Hz redraw allocates nothing.
  var pa = {}, pb = {};

  /** Screen-space transform from car metres to canvas pixels, set per draw. */
  var sx0 = 0, sy0 = 0, scale = 40;

  function toPx(p) {
    p.px = sx0 + p.x * scale;
    p.py = sy0 + p.y * scale;
    return p;
  }

  function line(ctx2d, ax, ay, az, bx, by, bz, body) {
    var f = body ? projBody : proj;
    toPx(f(ax, ay, az, pa));
    toPx(f(bx, by, bz, pb));
    ctx2d.moveTo(pa.px, pa.py);
    ctx2d.lineTo(pb.px, pb.py);
  }

  /* ------------------------------ drawing --------------------------------- */

  /** The road the car sits on: a grid, so pitch and roll have something to read against. */
  function drawGround(ctx2d) {
    ctx2d.save();
    ctx2d.strokeStyle = C_GROUND;
    ctx2d.globalAlpha = 0.9;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    var halfX = 1.7, halfZ = 2.7;
    for (var gx = -halfX; gx <= halfX + 0.01; gx += 0.85) {
      line(ctx2d, gx, GROUND_Y, -halfZ, gx, GROUND_Y, halfZ, false);
    }
    for (var gz = -halfZ; gz <= halfZ + 0.01; gz += 0.9) {
      line(ctx2d, -halfX, GROUND_Y, gz, halfX, GROUND_Y, gz, false);
    }
    ctx2d.stroke();
    ctx2d.restore();
  }

  /** One cross-section ring at a station, as a closed loop of car-space points. */
  function ringPoints(s) {
    var pts = [
      [-s.w, GROUND_Y],
      [-s.bw, s.by],
    ];
    if (s.rw > 0) {
      pts.push([-s.rw, s.ry]);
      pts.push([s.rw, s.ry]);
    } else {
      // No cabin here: close across the top of the waist so the section is still
      // a closed loop rather than an open U.
      pts.push([0, s.by + 0.06]);
    }
    pts.push([s.bw, s.by]);
    pts.push([s.w, GROUND_Y]);
    return pts;
  }

  /** The wireframe body: cross-section rings plus longitudinal stringers. */
  function drawBody(ctx2d) {
    ctx2d.save();
    ctx2d.strokeStyle = C_BODY;
    ctx2d.lineWidth = 1;
    ctx2d.globalAlpha = 0.75;
    ctx2d.beginPath();

    // Rings.
    for (var i = 0; i < STATIONS.length; i++) {
      var s = STATIONS[i];
      var pts = ringPoints(s);
      for (var k = 0; k < pts.length - 1; k++) {
        line(ctx2d, pts[k][0], pts[k][1], s.z, pts[k + 1][0], pts[k + 1][1], s.z, true);
      }
    }

    // Longitudinal stringers between adjacent stations, at each level. The roof
    // pair is only drawn where BOTH stations have a cabin, so the greenhouse
    // does not sprout lines into the bonnet.
    for (var j = 0; j < STATIONS.length - 1; j++) {
      var a = STATIONS[j], b = STATIONS[j + 1];
      line(ctx2d, -a.w, GROUND_Y, a.z, -b.w, GROUND_Y, b.z, true);
      line(ctx2d, a.w, GROUND_Y, a.z, b.w, GROUND_Y, b.z, true);
      line(ctx2d, -a.bw, a.by, a.z, -b.bw, b.by, b.z, true);
      line(ctx2d, a.bw, a.by, a.z, b.bw, b.by, b.z, true);
      if (a.rw > 0 && b.rw > 0) {
        line(ctx2d, -a.rw, a.ry, a.z, -b.rw, b.ry, b.z, true);
        line(ctx2d, a.rw, a.ry, a.z, b.rw, b.ry, b.z, true);
      }
    }
    ctx2d.stroke();
    ctx2d.restore();

    drawWing(ctx2d);
  }

  /** Rear wing — the silhouette cue that says "GT3" rather than "saloon". */
  function drawWing(ctx2d) {
    ctx2d.save();
    ctx2d.strokeStyle = C_BODY_HI;
    ctx2d.globalAlpha = 0.8;
    ctx2d.lineWidth = 1.2;
    ctx2d.beginPath();
    var hs = WING.halfSpan, zf = WING.z + WING.chord / 2, zr = WING.z - WING.chord / 2;
    // Main plane, as a flat rectangle.
    line(ctx2d, -hs, WING.y, zf, hs, WING.y, zf, true);
    line(ctx2d, -hs, WING.y, zr, hs, WING.y, zr, true);
    line(ctx2d, -hs, WING.y, zf, -hs, WING.y, zr, true);
    line(ctx2d, hs, WING.y, zf, hs, WING.y, zr, true);
    // Endplates.
    line(ctx2d, -hs, WING.plateBot, WING.z, -hs, WING.plateTop, WING.z, true);
    line(ctx2d, hs, WING.plateBot, WING.z, hs, WING.plateTop, WING.z, true);
    // Swan-neck supports down to the deck.
    line(ctx2d, -0.42, WING.y, WING.z, -0.42, 0.20, WING.z + 0.34, true);
    line(ctx2d, 0.42, WING.y, WING.z, 0.42, 0.20, WING.z + 0.34, true);
    ctx2d.stroke();
    ctx2d.restore();
  }

  /**
   * A wheel, as a circle in the plane it rolls in, lifted by its own suspension
   * travel. Deliberately NOT rotated with the body — see the file header.
   *
   * Tyre surface temperature tints it: the wheel is the natural place to show
   * heat, and it means the load picture and the heat picture share one object
   * instead of competing for space.
   */
  function drawWheel(ctx2d, corner, state, tyre) {
    // Deflection is positive-compressed, so more load pulls the wheel UP
    // relative to the body. With the body fixed in the projection and the wheel
    // free, the visible gap is the travel either way round.
    var lift = state ? (state.deflectionMm / 1000) * TRAVEL_GAIN : 0;
    var cy = WHEEL_Y - lift;

    var tint = C_BODY;
    if (tyre && typeof tyre.tempC === "number" && tyre.tempC > 0) {
      // Cold blue → working green → hot magenta. Bands chosen for slicks: under
      // 70 °C is not switched on, over 105 °C is overheating.
      var t = tyre.tempC;
      tint = t < 70 ? "#4f8bff" : t < 90 ? "#35d07f" : t < 105 ? "#ffd23e" : "#ec4899";
    }

    ctx2d.save();
    ctx2d.strokeStyle = tint;
    ctx2d.globalAlpha = state && state.airborne ? 0.4 : 1;
    ctx2d.lineWidth = 1.6;
    if (state && state.airborne) ctx2d.setLineDash([3, 3]);

    // Drawn as a short cylinder — inner and outer rims joined at the extremes —
    // rather than a single circle. A lone circle sat flat against the body
    // wireframe and read as another body line; two rims and their joins give it
    // enough width to register as a wheel at streaming resolution.
    var SEG = 18;
    var halfTread = 0.14;
    var rim = function (xOff) {
      ctx2d.beginPath();
      for (var i = 0; i <= SEG; i++) {
        var a = (i / SEG) * Math.PI * 2;
        toPx(proj(corner.x + xOff, cy + Math.sin(a) * WHEEL_R, corner.z + Math.cos(a) * WHEEL_R, pa));
        if (i === 0) ctx2d.moveTo(pa.px, pa.py);
        else ctx2d.lineTo(pa.px, pa.py);
      }
      ctx2d.stroke();
    };
    rim(-halfTread);
    rim(halfTread);
    // Tread joins at top/bottom/front/back of the circle.
    ctx2d.beginPath();
    for (var j = 0; j < 4; j++) {
      var ang = (j / 4) * Math.PI * 2;
      var wy = cy + Math.sin(ang) * WHEEL_R;
      var wz = corner.z + Math.cos(ang) * WHEEL_R;
      line(ctx2d, corner.x - halfTread, wy, wz, corner.x + halfTread, wy, wz, false);
    }
    ctx2d.stroke();
    ctx2d.restore();
  }

  /**
   * The load column at a corner: a vertical bar from the road whose height is
   * the corner's load, colour-coded by state.
   *
   * Height uses `loadRatio` when the tracker has calibrated, and falls back to
   * `shareOfTotal × 4` before then — the two agree at 1.0 for an evenly loaded
   * car, so the column does not jump when calibration completes.
   */
  function drawColumn(ctx2d, corner, state) {
    if (!state) return;
    var ratio =
      state.loadRatio !== -1 ? state.loadRatio : state.shareOfTotal * 4;
    var h = Math.max(0, Math.min(2.2, ratio)) * COLUMN_UNIT_M;

    var col = C_OK;
    if (state.airborne) col = C_AIR;
    else if (state.overloaded) col = C_OVER;
    else if (state.light) col = C_LIGHT;

    ctx2d.save();
    ctx2d.strokeStyle = col;
    ctx2d.lineWidth = 3;
    ctx2d.globalAlpha = 0.9;
    ctx2d.beginPath();
    // Well outboard of the widest body station (half-width 1.02) so the column
    // and its flag never overlap the wireframe — at 1.28 they sat on the sills
    // and read as part of the car.
    var cx = corner.x * 1.72;
    line(ctx2d, cx, GROUND_Y, corner.z, cx, GROUND_Y + h, corner.z, false);
    ctx2d.stroke();

    // A cap disc on the road, radius tracking load — readable at a glance even
    // when the column is foreshortened by the camera angle.
    ctx2d.globalAlpha = 0.5;
    ctx2d.fillStyle = col;
    toPx(proj(cx, GROUND_Y, corner.z, pa));
    ctx2d.beginPath();
    ctx2d.arc(pa.px, pa.py, 2 + Math.min(5, ratio * 3), 0, Math.PI * 2);
    ctx2d.fill();

    // State flag. Only for the states that matter — a label on every corner all
    // the time is noise, and the column colour already carries the normal case.
    var flag = state.airborne ? "AIR" : state.overloaded ? "OVER" : state.light ? "LIGHT" : "";
    if (flag) {
      ctx2d.globalAlpha = 1;
      ctx2d.fillStyle = col;
      ctx2d.font = "bold 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx2d.textAlign = corner.x < 0 ? "right" : "left";
      ctx2d.textBaseline = "middle";
      toPx(proj(cx, GROUND_Y + h + 0.18, corner.z, pa));
      ctx2d.fillText(flag, pa.px + (corner.x < 0 ? -3 : 3), pa.py);
    }
    ctx2d.restore();
  }

  /** Fits the car to the canvas and draws the whole 3D pane. */
  function drawCar(ctx2d, chassis, motion, tyres) {
    // Fit. The width that matters is NOT the car's — it is the span out to the
    // load columns and their flags, which sit at ±1.72 × the wheel line. Fitting
    // the body alone pushed the flags off the canvas edge.
    var spanX = WHEEL_X * 1.72 * 2 + 1.0; // columns plus room for "LIGHT"
    var spanY = 4.6 * camSin + 1.5 * camCos; // car length foreshortened, plus height
    scale = Math.min(cssW / spanX, cssH / spanY);
    sx0 = cssW / 2;
    // Biased below centre: the camera is behind, so the tail is nearest and
    // lowest on screen, and the wing needs the room more than the nose does.
    sy0 = cssH * 0.5;

    setAttitude(motion ? motion.pitch : 0, motion ? motion.roll : 0);

    drawGround(ctx2d);

    // Far corners first so nearer geometry overdraws them. With only four
    // wheels and one body a full depth sort is overkill; front axle before rear
    // is the whole of it, since the camera is behind.
    for (var i = 0; i < CORNERS.length; i++) {
      var c = CORNERS[i];
      if (c.z <= 0) continue;
      drawWheel(ctx2d, c, chassis ? chassis[c.key] : null, tyres ? tyres[c.tyre] : null);
      drawColumn(ctx2d, c, chassis ? chassis[c.key] : null);
    }
    drawBody(ctx2d);
    for (var j = 0; j < CORNERS.length; j++) {
      var c2 = CORNERS[j];
      if (c2.z > 0) continue;
      drawWheel(ctx2d, c2, chassis ? chassis[c2.key] : null, tyres ? tyres[c2.tyre] : null);
      drawColumn(ctx2d, c2, chassis ? chassis[c2.key] : null);
    }
  }

  /* ------------------------------- DOM ------------------------------------ */

  /** One row of the suspension table: label + load + travel + ride height. */
  function makeSuspRow(parent, corner) {
    var row = document.createElement("div");
    row.className = "chassis__row";
    row.setAttribute("data-corner", corner.label);

    var lab = document.createElement("span");
    lab.className = "chassis__row-label";
    lab.textContent = corner.label;
    row.appendChild(lab);

    var bar = document.createElement("div");
    bar.className = "chassis__bar";
    var fill = document.createElement("i");
    fill.className = "chassis__bar-fill";
    bar.appendChild(fill);
    row.appendChild(bar);
    cells[corner.label + ".fill"] = fill;

    ["load", "trav", "ride"].forEach(function (field) {
      var v = document.createElement("span");
      v.className = "chassis__row-val chassis__row-val--" + field;
      v.textContent = "—";
      row.appendChild(v);
      cells[corner.label + "." + field] = v;
    });

    parent.appendChild(row);
    return row;
  }

  /** A labelled left/right distribution bar (front/rear, left/right, cross). */
  function makeDistBar(parent, key, leftLabel, rightLabel) {
    var wrap = document.createElement("div");
    wrap.className = "chassis__dist";

    var l = document.createElement("span");
    l.className = "chassis__dist-label";
    l.textContent = leftLabel;
    var track = document.createElement("div");
    track.className = "chassis__dist-track";
    var fill = document.createElement("i");
    fill.className = "chassis__dist-fill";
    track.appendChild(fill);
    var r = document.createElement("span");
    r.className = "chassis__dist-label chassis__dist-label--right";
    r.textContent = rightLabel;
    var val = document.createElement("span");
    val.className = "chassis__dist-val";
    val.textContent = "—";

    wrap.appendChild(l);
    wrap.appendChild(track);
    wrap.appendChild(r);
    wrap.appendChild(val);
    parent.appendChild(wrap);
    distEls[key] = { fill: fill, val: val };
  }

  /**
   * Hover-revealed opacity slider, so the widget can sit over the track as a
   * see-through practice HUD.
   *
   * Mirrors the control in widgets/motion.js, including both of its non-obvious
   * requirements: the fade is applied to the panel CONTENTS with the slider as
   * their sibling (CSS opacity on a parent cannot be undone by a child, so a
   * slider inside the faded box would fade out of reach), and below full
   * opacity the panel chrome is dropped entirely rather than faded, because a
   * translucent dark box over a track still reads as a box.
   *
   * The two are kept separate rather than shared because each widget is a
   * self-contained module here; if a third one needs it, that is the point to
   * lift it into client.js.
   */
  function buildOpacityControl(root, params) {
    var applyOpacity = function (v) {
      root.style.setProperty("--chassis-op", String(v));
      root.setAttribute("data-transparent", v < 1 ? "true" : "false");
    };

    var stored = null;
    try {
      var raw = localStorage.getItem(OPACITY_KEY);
      if (raw !== null && isFinite(parseFloat(raw))) stored = parseFloat(raw);
    } catch (e) {
      /* private mode — the slider still works, it just won't persist */
    }
    var fromUrl = parseFloat(params.get("opacity"));
    var initial = isFinite(fromUrl) ? fromUrl : stored !== null ? stored : 1;
    initial = Math.min(1, Math.max(MIN_OPACITY, initial));

    var bar = document.createElement("div");
    bar.className = "chassis__opacity";

    var label = document.createElement("span");
    label.className = "chassis__opacity-label";
    label.textContent = "OPACITY";

    var slider = document.createElement("input");
    slider.className = "chassis__opacity-range";
    slider.type = "range";
    slider.min = String(Math.round(MIN_OPACITY * 100));
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(initial * 100));

    var readout = document.createElement("span");
    readout.className = "chassis__opacity-val";
    readout.textContent = slider.value + "%";

    slider.addEventListener("input", function () {
      var v = Math.min(1, Math.max(MIN_OPACITY, Number(slider.value) / 100));
      applyOpacity(v);
      readout.textContent = Math.round(v * 100) + "%";
      try {
        localStorage.setItem(OPACITY_KEY, String(v));
      } catch (e) {
        /* ignore */
      }
    });

    // The in-game layer starts a drag on pointerdown anywhere inside a widget;
    // without this, grabbing the slider drags the whole widget instead.
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      bar.addEventListener(evt, function (e) { e.stopPropagation(); });
    });

    bar.appendChild(label);
    bar.appendChild(slider);
    bar.appendChild(readout);

    // Zero-height positioning context appended after the body — .widget is
    // forced `position: static !important` by single.css and ingame.css, so an
    // absolutely-positioned bar anchored to it would escape to an outer
    // ancestor on two of the three pages.
    var anchor = document.createElement("div");
    anchor.className = "chassis__opacity-anchor";
    anchor.appendChild(bar);
    root.appendChild(anchor);
    applyOpacity(initial);
  }

  function init(root, ctx) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";
    cells = {};
    distEls = {};
    cache = {};

    var params = new URLSearchParams(window.location.search);
    var off = function (name) {
      var v = (params.get(name) || "").toLowerCase();
      return v === "off" || v === "0" || v === "false";
    };
    modeCar = !off("car");
    modeSusp = !off("susp");
    modeDist = !off("dist");

    var gainParam = parseFloat(params.get("gain"));
    // 1 = true scale. Clamped so a typo cannot fold the car inside out.
    attGain = isFinite(gainParam) ? Math.min(20, Math.max(1, gainParam)) : ATT_GAIN;

    // Camera azimuth. Clamped to ±40°: past that the car is being viewed from
    // the quarter rather than from behind, and left/right stops reading as
    // left/right — which is the one thing this view must never lose.
    var yawParam = parseFloat(params.get("yaw"));
    setYaw(isFinite(yawParam) ? Math.min(40, Math.max(-40, yawParam)) : 0);

    buildOpacityControl(root, params);

    if (!modeCar && !modeSusp && !modeDist) {
      mount.innerHTML =
        '<div class="placeholder">All chassis modes are off ' +
        "(?car / ?susp / ?dist)</div>";
      canvas = null;
      return;
    }

    var wrap = document.createElement("div");
    wrap.className = "chassis__wrap";

    if (modeCar) {
      canvas = document.createElement("canvas");
      canvas.className = "chassis__canvas";
      wrap.appendChild(canvas);
    } else {
      canvas = null;
    }

    if (modeSusp) {
      var head = document.createElement("div");
      head.className = "chassis__row chassis__row--head";
      ["", "LOAD", "N", "TRAV", "RIDE"].forEach(function (t, i) {
        var s = document.createElement("span");
        // Index 1 is the bar column, which has no header text of its own.
        s.className = i === 1 ? "chassis__bar chassis__bar--head" : "chassis__row-label";
        s.textContent = i === 1 ? "" : t;
        head.appendChild(s);
      });
      wrap.appendChild(head);
      for (var i = 0; i < CORNERS.length; i++) makeSuspRow(wrap, CORNERS[i]);
    }

    if (modeDist) {
      var dist = document.createElement("div");
      dist.className = "chassis__dists";
      makeDistBar(dist, "fr", "FRT", "REAR");
      makeDistBar(dist, "lr", "L", "R");
      makeDistBar(dist, "x", "X-WT", "");
      wrap.appendChild(dist);
    }

    mount.appendChild(wrap);

    if (canvas) {
      gctx = canvas.getContext("2d");
      sizeCanvas();
      window.addEventListener("resize", sizeCanvas, { passive: true });
    }
  }

  /* ------------------------------ updating -------------------------------- */

  function setText(el, key, text) {
    if (!el || cache[key] === text) return;
    cache[key] = text;
    el.textContent = text;
  }

  function setStyle(el, key, prop, value) {
    if (!el || cache[key] === value) return;
    cache[key] = value;
    el.style.setProperty(prop, value);
  }

  function stateOf(c) {
    return c.airborne ? "air" : c.overloaded ? "over" : c.light ? "light" : "ok";
  }

  function update(frame, ctx) {
    var p = frame.player;
    var chassis = p && p.chassis;
    var motion = p && p.motion;
    var tyres = p && p.tyres;

    if (!chassis) {
      // Spectating, or the sim does not populate the wheel block. Say so rather
      // than drawing a flat car with four equal loads, which would look like a
      // working readout of a car standing still.
      setText(headerMeta, "meta", "NO CHASSIS DATA");
      if (gctx && canvas) {
        gctx.clearRect(0, 0, cssW, cssH);
        // The car is still worth drawing — it shows the widget is alive and
        // gives the operator something to frame in OBS before a session starts.
        drawCar(gctx, null, motion, tyres);
      }
      return;
    }

    if (modeCar && gctx) {
      if (cssW === 0) { sizeCanvas(); }
      if (cssW > 0) {
        gctx.clearRect(0, 0, cssW, cssH);
        gctx.globalAlpha = 1;
        drawCar(gctx, chassis, motion, tyres);
      }
    }

    if (modeSusp) {
      for (var i = 0; i < CORNERS.length; i++) {
        var c = CORNERS[i];
        var s = chassis[c.key];
        if (!s) continue;
        var ratio = s.loadRatio !== -1 ? s.loadRatio : s.shareOfTotal * 4;
        var pct = Math.max(0, Math.min(100, (ratio / 2) * 100));
        setStyle(cells[c.label + ".fill"], c.label + ".w", "width", pct.toFixed(0) + "%");
        setStyle(cells[c.label + ".fill"], c.label + ".s", "--state", stateOf(s));
        var fillEl = cells[c.label + ".fill"];
        if (fillEl && cache[c.label + ".attr"] !== stateOf(s)) {
          cache[c.label + ".attr"] = stateOf(s);
          fillEl.setAttribute("data-state", stateOf(s));
        }
        setText(cells[c.label + ".load"], c.label + ".load", (s.loadN / 1000).toFixed(2) + "k");
        setText(cells[c.label + ".trav"], c.label + ".trav", s.deflectionMm.toFixed(0) + "mm");
        setText(cells[c.label + ".ride"], c.label + ".ride", s.rideHeightMm.toFixed(0) + "mm");
      }
    }

    if (modeDist) {
      // Each bar shows the FIRST-named side's share, so the fill growing always
      // means "more load on the label at the left".
      var bars = [
        { key: "fr", share: chassis.frontShare, text: Math.round(chassis.frontShare * 100) + "/" + Math.round(chassis.rearShare * 100) },
        { key: "lr", share: chassis.leftShare, text: Math.round(chassis.leftShare * 100) + "/" + Math.round(chassis.rightShare * 100) },
        { key: "x", share: chassis.crossShare, text: Math.round(chassis.crossShare * 100) + "%" },
      ];
      for (var b = 0; b < bars.length; b++) {
        var el = distEls[bars[b].key];
        if (!el) continue;
        setStyle(el.fill, "d." + bars[b].key, "width", (bars[b].share * 100).toFixed(1) + "%");
        setText(el.val, "dv." + bars[b].key, bars[b].text);
      }
    }

    // Header: total load, plus the honest attitude in true degrees and a note
    // that the picture is amplified — the one place the gain is disclosed.
    var meta = Math.round(chassis.totalLoadN / 1000) + "kN";
    if (motion) {
      meta +=
        " · P" + motion.pitch.toFixed(1) + "° R" + motion.roll.toFixed(1) + "°";
    }
    if (!chassis.calibrated) meta += " · CAL…";
    else if (attGain !== 1) meta += " · ×" + attGain;
    if (chassis.wheelsAirborne > 0) meta += " · " + chassis.wheelsAirborne + " AIR";
    setText(headerMeta, "meta", meta);
  }

  window.ApexOverlay.registerWidget("chassis", {
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
