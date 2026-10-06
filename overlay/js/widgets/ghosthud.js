/**
 * ghosthud.js — Ghost HUD: a fast lap's racing line, on the road ahead of you.
 * -----------------------------------------------------------------------------
 * The road in front of the car, drawn from the learned circuit so it bends the
 * way the circuit bends, with a chosen lap's racing line painted on it — green
 * where that lap was on the power, amber off it, red under braking. A marker
 * shows where that lap is on the clock right now, the line you have just driven
 * trails behind you for comparison, and the signed seconds sit in the corner.
 *
 * ## What v1 got wrong
 * The first version drew a fixed trapezoid with a bar whose height encoded the
 * gap. Its header said "screen-space rails need only 1-D data" — true, and the
 * exact reason it read as a delta bar turned on its side. One degree of
 * freedom, one moving part, and a hairpin drawn identically to a straight.
 *
 * Nothing about chasing a lap is one-dimensional. The information is lateral
 * and angular: where across the road the line goes, how early it turns in, how
 * soon it straightens. All of that was thrown away before anything was drawn.
 *
 * ## Why a line and not a car
 * A car was prototyped and dropped. A line uses the whole lap rather than one
 * sample of it, stays legible at 60 m where a car is a dot near the horizon,
 * and is a convention drivers already read from every racing game. It also
 * answers the actual question — "where did it get more drive?" — directly: its
 * line turns green earlier out of the corner than yours does.
 *
 * ## Only the road AHEAD can carry the ghost; only the road BEHIND can carry you
 * The ghost's line is drawn forward, because that is the part a driver can act
 * on. Your own line can only be drawn backward, and not because of taste: you
 * have not driven the road ahead yet this lap, so there is no line of yours
 * there to show. The trail behind comes from where the car has actually been.
 *
 * ## Where the data comes from
 * Nothing here is new telemetry. The player's world position rides
 * `frame.trackMap.cars[isPlayer]`, their heading `frame.player.motion.heading`,
 * the circuit `/trackmap.json`, and the ghost's line `/ghost.json` — all four
 * in the sim's own world axes, so a lap recorded weeks ago lands on today's
 * road with no fitting. The maths lives in `ghost-geom.js`, which is pure and
 * tested headlessly; this file is the painting.
 */

(function () {
  "use strict";

  var GEO = window.ApexGhostGeom;

  /* ------------------------------- framing -------------------------------- */

  /** How much road is drawn, metres. Behind must stay inside CAM_BACK. */
  var VIEW_AHEAD_M = 95;
  var VIEW_BEHIND_M = 12;

  /** Chase camera: metres behind and above the car, and its downward tilt. */
  var CAM_BACK = 14;
  var CAM_H = 3.1;
  var CAM_PITCH = 0.105;
  var FOV_DEG = 52;
  /** The horizon's share of the canvas height. */
  var HORIZON = 0.3;
  /** Canvas height as a fraction of its width. */
  var ASPECT = 0.48;

  /**
   * Step between drawn points, metres. Two metres was visibly faceted in the
   * prototype: traces are rounded to 10 cm at ~10 Hz, so the stored line is a
   * polyline of real corners and sampling coarsely keeps every one of them.
   */
  var STEP_M = 1;

  /** Ribbon widths in METRES, so they narrow with distance like paint would. */
  var GHOST_W = 0.45;
  var TRAIL_W = 0.22;

  /** How far back the driven trail is kept, and how finely it is sampled. */
  var TRAIL_STEP_M = 1.5;
  var TRAIL_MAX = Math.ceil(VIEW_BEHIND_M / TRAIL_STEP_M) + 4;

  /* -------------------------------- colour -------------------------------- */

  var C_ROAD = "#191d24";
  var C_EDGE = "#3a414d";
  var C_TRAIL = "#7f8794";
  var C_INK = "#0b0d10";
  var C_LEVEL = "#e8eaed";
  var C_BEHIND = "#d55e00";
  var C_AHEAD = "#2fbf71";

  /** |gapSec| at or under this is a dead heat. */
  var LEVEL_SEC = 0.05;

  /* ------------------------------- smoothing ------------------------------ */

  /**
   * Low-pass on the player's pose, seconds, applied with a dt-DERIVED
   * coefficient (`a = 1 - exp(-dt / TAU)`) and never a fixed per-frame
   * fraction: a fixed fraction silently assumes a fixed frame interval, and
   * this widget is throttled and drops frames. Same form as
   * `paceDelta.Channel` server-side.
   *
   * Short on purpose. The pose only needs the jitter taken off it; more lag
   * than this and the road swims behind the car through a quick change of
   * direction.
   */
  var POSE_TAU = 0.06;
  /** A heading change larger than this in one sample is a reset, not a corner. */
  var HEADING_JUMP_DEG = 90;

  /* -------------------------------- state --------------------------------- */

  var canvas = null;
  var gctx = null;
  var headerMeta = null;
  var cssW = 0;
  var cssH = 0;
  var dpr = 1;

  /** The circuit, from `/trackmap.json`. */
  var shape = null;
  var haveKey = "";
  var haveRevision = -1;
  var shapeFetching = false;

  /** The ghost's line, from `/ghost.json`. */
  var line = null;
  var haveLapId = "";
  var lineFetching = false;

  var poseX = 0;
  var poseZ = 0;
  var poseH = 0;
  var poseAt = -1;

  /** Where the car has actually been, newest last. */
  var trail = [];

  var lastLabel = "";

  /* ------------------------------- fetching -------------------------------- */

  /**
   * Keep the circuit in step with the frame.
   *
   * Lifted from `trackmap.js`, including the parts that look redundant: a shape
   * can be WITHDRAWN as well as replaced, there is one in-flight flag and no
   * queue, `204` means "not learned yet" rather than an error, and the cached
   * value and its key always die together — nulling one without the other is
   * how a stale shape outlives the circuit it describes.
   */
  function ensureShape(map) {
    if (!map) return;
    if (shape && (!map.ready || map.key !== haveKey)) {
      shape = null;
      haveKey = "";
      haveRevision = -1;
    }
    if (!map.ready || shapeFetching) return;
    if (shape && map.key === haveKey && map.revision === haveRevision) return;
    shapeFetching = true;
    var wantKey = map.key;
    var wantRev = map.revision;
    fetch("/trackmap.json", { cache: "no-store" })
      .then(function (r) {
        if (r.status === 204) return null;
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        shapeFetching = false;
        if (!data || !data.points || data.points.length < 8) return;
        shape = data;
        haveKey = wantKey;
        haveRevision = wantRev;
      })
      .catch(function () {
        shapeFetching = false;
      });
  }

  /**
   * Keep the ghost's line in step with the selection.
   *
   * `sourceLapId` moves exactly when the provider picks a different lap, so it
   * is the cache key and no new wire field was needed for any of this.
   */
  function ensureLine(ghost) {
    var id = ghost && ghost.sourceLapId ? ghost.sourceLapId : "";
    if (!id) {
      line = null;
      haveLapId = "";
      return;
    }
    if (line && haveLapId === id) return;
    if (lineFetching) return;
    lineFetching = true;
    fetch("/ghost.json", { cache: "no-store" })
      .then(function (r) {
        if (r.status === 204) return null; // no ghost, or a lap with no line
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        lineFetching = false;
        if (!data || !data.d || !data.x || data.d.length < 8) return;
        line = data;
        haveLapId = data.lapId || id;
      })
      .catch(function () {
        lineFetching = false;
      });
  }

  /* -------------------------------- sizing -------------------------------- */

  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth || 640;
    var h = Math.round(w * ASPECT);
    var d = window.ApexRaster.backingScale(canvas);
    var bw = Math.round(w * d);
    var bh = Math.round(h * d);
    if (bw === canvas.width && bh === canvas.height && w === cssW) return;
    cssW = w;
    cssH = h;
    dpr = d;
    canvas.style.height = cssH + "px";
    // Put the border chrome back so the content box is exactly cssH tall and
    // the bitmap is never squashed to fit (same fix as motion.js / radar.js).
    var extra = canvas.offsetHeight - canvas.clientHeight;
    if (extra > 0) canvas.style.height = cssH + extra + "px";
    canvas.width = bw;
    canvas.height = bh;
    if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  var sizeTick = 0;
  var SIZE_CHECK_FRAMES = 15;

  function watchSize(el) {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () {
        sizeCanvas();
      }).observe(el);
    }
    window.addEventListener("resize", sizeCanvas, { passive: true });
  }

  /* -------------------------------- helpers -------------------------------- */

  function playerCar(frame) {
    var cars = frame && frame.trackMap && frame.trackMap.cars;
    if (!cars) return null;
    for (var i = 0; i < cars.length; i++) {
      if (cars[i].isPlayer) return cars[i];
    }
    return null;
  }

  /** Shortest signed difference between two headings, degrees. */
  function headingDelta(a, b) {
    return ((a - b + 540) % 360) - 180;
  }

  /**
   * Ease the pose. Position eases straight; heading eases the SHORT way round,
   * or a car at 179° and one at −179° would swing the whole world through 358°
   * to travel two.
   */
  function easePose(x, z, h, nowMs) {
    var dt = poseAt < 0 ? -1 : (nowMs - poseAt) / 1000;
    poseAt = nowMs;
    if (dt <= 0 || dt > 0.5) {
      poseX = x;
      poseZ = z;
      poseH = h;
      return;
    }
    var a = 1 - Math.exp(-dt / POSE_TAU);
    poseX += (x - poseX) * a;
    poseZ += (z - poseZ) * a;
    var dh = headingDelta(h, poseH);
    // A reset, a tow, or a spin: adopt it rather than sweeping the world round.
    if (Math.abs(dh) > HEADING_JUMP_DEG) poseH = h;
    else poseH += dh * a;
  }

  /** Remember where the car has been, at a roughly fixed spacing. */
  function noteTrail(x, z) {
    var last = trail.length ? trail[trail.length - 1] : null;
    if (last && Math.hypot(x - last.x, z - last.z) < TRAIL_STEP_M) return;
    // A jump means a reset or a teleport; a trail across it would be a line
    // the car never drove.
    if (last && Math.hypot(x - last.x, z - last.z) > 60) trail.length = 0;
    trail.push({ x: x, z: z });
    if (trail.length > TRAIL_MAX) trail.shift();
  }

  function bandColour(gapSec) {
    if (Math.abs(gapSec) <= LEVEL_SEC) return C_LEVEL;
    return gapSec > 0 ? C_BEHIND : C_AHEAD;
  }

  function fmtDelta(sec) {
    var s = Math.abs(sec) < 0.005 ? 0 : sec;
    return (s > 0 ? "+" : s < 0 ? "-" : "") + Math.abs(s).toFixed(2);
  }

  /* -------------------------------- drawing -------------------------------- */

  /**
   * Draw a ribbon of real world width through a list of world points.
   *
   * Width is in METRES, not pixels, so it narrows with distance. A constant
   * pixel stroke reads as a wire floating above the road; a quad strip sits on
   * it. `colourFn` is handed each point's index so a ribbon can change colour
   * along its length in one pass.
   */
  function ribbon(cam, pts, widthM, colourFn, alpha) {
    if (!pts || pts.length < 2) return;
    var half = widthM / 2;
    var prev = null;
    gctx.globalAlpha = alpha;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i];
      var b = pts[i + 1] || pts[i - 1];
      if (!a || !b) {
        prev = null;
        continue;
      }
      var tx = (pts[i + 1] ? b.x - a.x : a.x - b.x);
      var tz = (pts[i + 1] ? b.z - a.z : a.z - b.z);
      var len = Math.hypot(tx, tz);
      if (len < 1e-6) {
        prev = null;
        continue;
      }
      var nx = tz / len;
      var nz = -tx / len;
      var wl = GEO.worldToLocal(poseH, poseX, poseZ, a.x + nx * half, a.z + nz * half);
      var wr = GEO.worldToLocal(poseH, poseX, poseZ, a.x - nx * half, a.z - nz * half);
      var ql = GEO.project(cam, wl.lat, a.e, wl.lon);
      var qr = GEO.project(cam, wr.lat, a.e, wr.lon);
      var cur = ql && qr ? { l: ql, r: qr, i: i } : null;
      if (prev && cur) {
        gctx.beginPath();
        gctx.moveTo(prev.l.x, prev.l.y);
        gctx.lineTo(cur.l.x, cur.l.y);
        gctx.lineTo(cur.r.x, cur.r.y);
        gctx.lineTo(prev.r.x, prev.r.y);
        gctx.closePath();
        gctx.fillStyle = colourFn(prev.i);
        gctx.fill();
      }
      prev = cur;
    }
    gctx.globalAlpha = 1;
  }

  /** Sample the ghost's stored line over a window of road, as world points. */
  function ghostPoints(baseD, fromM, toM) {
    var lapM = shape.lengthM || 1;
    var out = [];
    for (var m = fromM; m <= toM; m += STEP_M) {
      var d = baseD + m / lapM;
      d -= Math.floor(d); // wrap, so the ribbon survives the start/finish line
      var a = GEO.lineAtSmooth(line, d);
      if (!a) continue;
      out.push({ x: a.x, z: a.z, e: GEO.roadElevation(shape, d * lapM) + 0.05, d: d });
    }
    return out;
  }

  /** The road surface and its edges, from the learned circuit. */
  function drawRoad(cam, myDistM) {
    var slice = GEO.roadSlice(shape, myDistM - VIEW_BEHIND_M, myDistM + VIEW_AHEAD_M);
    if (slice.length < 2) return false;
    var half = shape.halfWidthM > 0 ? shape.halfWidthM : 6;
    var L = [];
    var R = [];
    for (var i = 0; i < slice.length; i++) {
      var s = slice[i];
      var wl = GEO.worldToLocal(poseH, poseX, poseZ, s.x + s.nx * half, s.z + s.nz * half);
      var wr = GEO.worldToLocal(poseH, poseX, poseZ, s.x - s.nx * half, s.z - s.nz * half);
      L.push(GEO.project(cam, wl.lat, s.y, wl.lon));
      R.push(GEO.project(cam, wr.lat, s.y, wr.lon));
    }
    var started = false;
    gctx.beginPath();
    for (var a = L.length - 1; a >= 0; a--) {
      if (!L[a]) continue;
      if (!started) {
        gctx.moveTo(L[a].x, L[a].y);
        started = true;
      } else gctx.lineTo(L[a].x, L[a].y);
    }
    if (!started) return false;
    for (var b = 0; b < R.length; b++) if (R[b]) gctx.lineTo(R[b].x, R[b].y);
    gctx.closePath();
    gctx.fillStyle = C_ROAD;
    gctx.fill();

    gctx.strokeStyle = C_EDGE;
    gctx.lineWidth = 2;
    for (var e = 0; e < 2; e++) {
      var side = e ? R : L;
      gctx.beginPath();
      var on = false;
      for (var k = 0; k < side.length; k++) {
        if (!side[k]) {
          on = false;
          continue;
        }
        if (!on) {
          gctx.moveTo(side[k].x, side[k].y);
          on = true;
        } else gctx.lineTo(side[k].x, side[k].y);
      }
      gctx.stroke();
    }
    return true;
  }

  /**
   * Where the ghost is on the clock right now, as a gate STANDING on its line.
   *
   * It was an arrow lying on the road first. A flat shape seen from a camera
   * barely above the surface foreshortens into a sliver — at 7 m it read as a
   * white smear across the track rather than as a marker. Anything meant to be
   * found at a glance has to have height.
   */
  function drawGhostMark(cam, atD, gapM) {
    var lapM = shape.lengthM || 1;
    var d = atD + gapM / lapM;
    d -= Math.floor(d);
    var a = GEO.lineAtSmooth(line, d);
    var b = GEO.lineAtSmooth(line, (d + 0.0008) % 1);
    if (!a || !b) return;
    var tx = b.x - a.x;
    var tz = b.z - a.z;
    var len = Math.hypot(tx, tz);
    if (len < 1e-6) return;
    // Across the line, so the gate faces the driver rather than edge-on.
    var nx = tz / len;
    var nz = -tx / len;
    var e = GEO.roadElevation(shape, d * lapM);
    var HALF = 1.1;
    var TOP = 1.3;
    var bl = GEO.worldToLocal(poseH, poseX, poseZ, a.x + nx * HALF, a.z + nz * HALF);
    var br = GEO.worldToLocal(poseH, poseX, poseZ, a.x - nx * HALF, a.z - nz * HALF);
    var p1 = GEO.project(cam, bl.lat, e, bl.lon);
    var p2 = GEO.project(cam, br.lat, e, br.lon);
    var p3 = GEO.project(cam, br.lat, e + TOP, br.lon);
    var p4 = GEO.project(cam, bl.lat, e + TOP, bl.lon);
    if (!p1 || !p2 || !p3 || !p4) return;
    gctx.beginPath();
    gctx.moveTo(p1.x, p1.y);
    gctx.lineTo(p2.x, p2.y);
    gctx.lineTo(p3.x, p3.y);
    gctx.lineTo(p4.x, p4.y);
    gctx.closePath();
    gctx.globalAlpha = 0.3;
    gctx.fillStyle = C_LEVEL;
    gctx.fill();
    gctx.globalAlpha = 1;
    // The posts carry the read; the panel between them is only a hint of body.
    gctx.strokeStyle = C_LEVEL;
    gctx.lineWidth = 2.5;
    gctx.lineCap = 'round';
    gctx.beginPath();
    gctx.moveTo(p1.x, p1.y);
    gctx.lineTo(p4.x, p4.y);
    gctx.moveTo(p2.x, p2.y);
    gctx.lineTo(p3.x, p3.y);
    gctx.moveTo(p4.x, p4.y);
    gctx.lineTo(p3.x, p3.y);
    gctx.stroke();
  }
  /** Signed seconds, outlined — an outline is required over a moving picture. */
  function drawReadout(text, colour) {
    var size = Math.max(16, Math.round(cssW * 0.045));
    gctx.font = "600 " + size + 'px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
    gctx.textAlign = "left";
    gctx.textBaseline = "alphabetic";
    gctx.lineJoin = "round";
    gctx.lineWidth = Math.max(2, size * 0.075) * 2;
    gctx.strokeStyle = C_INK;
    gctx.globalAlpha = 0.75;
    gctx.strokeText(text, 14, cssH - 14);
    gctx.globalAlpha = 1;
    gctx.fillStyle = colour;
    gctx.fillText(text, 14, cssH - 14);
  }

  function drawNote(note) {
    var size = Math.max(11, Math.round(cssW * 0.021));
    gctx.font = "500 " + size + 'px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    gctx.globalAlpha = 0.6;
    gctx.fillStyle = C_EDGE;
    gctx.fillText(note, cssW / 2, cssH / 2);
    gctx.globalAlpha = 1;
  }

  /* -------------------------------- update -------------------------------- */

  function update(frame) {
    if (!gctx || !canvas || !GEO) return;
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) sizeCanvas();
    if (!cssW || !cssH) return;

    var ghost = frame && frame.player ? frame.player.ghost : null;
    ensureShape(frame ? frame.trackMap : null);
    ensureLine(ghost);

    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);

    if (headerMeta) {
      var label = ghost && ghost.sourceLabel ? ghost.sourceLabel : "—";
      if (label !== lastLabel) {
        headerMeta.textContent = label;
        lastLabel = label;
      }
    }

    if (!ghost) {
      drawNote("no ghost lap");
      trail.length = 0;
      return;
    }

    var me = playerCar(frame);
    var motion = frame.player.motion;
    var havePose =
      !!me &&
      typeof me.x === "number" &&
      typeof me.z === "number" &&
      typeof me.lapFraction === "number" &&
      !!motion &&
      typeof motion.heading === "number";

    // Both pose channels come and go together: spectating, no plugin, or the
    // sim sitting in a menu. `lapFraction` survives on its own but is
    // one-dimensional, and pinning the line to the centreline would throw away
    // the lateral channel that is the entire point — so say why instead of
    // drawing a road that is half true.
    if (!havePose || !shape || !line) {
      drawNote(
        !havePose
          ? "waiting for car position"
          : !shape
            ? "learning the circuit"
            : "this lap has no driven line",
      );
      if (ghost.active) drawReadout(fmtDelta(ghost.gapSec), bandColour(ghost.gapSec));
      return;
    }

    var nowMs =
      typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    easePose(me.x, me.z, motion.heading, nowMs);
    noteTrail(me.x, me.z);

    var lapM = shape.lengthM || 1;
    var atD = me.lapFraction;
    var myDistM = atD * lapM;

    var cam = GEO.camera({
      cx: cssW / 2,
      cy: cssH * HORIZON,
      f: cssW / 2 / Math.tan(((FOV_DEG / 2) * Math.PI) / 180),
      back: CAM_BACK,
      height: CAM_H,
      pitch: CAM_PITCH,
      // The eye rides the player's OWN road height. Pinned to absolute world Y
      // it sits underground on a climb and in the air on a descent, and the
      // frame goes empty — which is exactly what the prototype did on Road
      // Atlanta's 8 m of elevation change.
      roadY: GEO.roadElevation(shape, myDistM),
    });

    if (!drawRoad(cam, myDistM)) {
      drawNote("off the circuit");
      return;
    }

    // Where you have actually just been. Only backwards: there is no line of
    // yours on road you have not driven yet.
    if (trail.length > 1) {
      var tpts = [];
      for (var i = 0; i < trail.length; i++) {
        tpts.push({
          x: trail[i].x,
          z: trail[i].z,
          e: GEO.roadElevation(shape, myDistM) + 0.03,
        });
      }
      ribbon(cam, tpts, TRAIL_W, function () {
        return C_TRAIL;
      }, 0.45);
    }

    // The ghost's line, ahead only: running it behind the car puts its widest,
    // closest segment in the driver's face for no information.
    var gpts = ghostPoints(atD, 0, VIEW_AHEAD_M);
    ribbon(
      cam,
      gpts,
      GHOST_W,
      function (i) {
        var d = gpts[i].d;
        return GEO.pedalColour(GEO.channelAt(line, "brake", d), GEO.channelAt(line, "throttle", d));
      },
      0.92,
    );

    if (ghost.active) {
      drawGhostMark(cam, atD, ghost.gapM);
      drawReadout(fmtDelta(ghost.gapSec), bandColour(ghost.gapSec));
    }
  }

  /* --------------------------------- init --------------------------------- */

  function init(root) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var wrap = document.createElement("div");
    wrap.className = "ghosthud__wrap";
    canvas = document.createElement("canvas");
    canvas.className = "ghosthud__canvas";
    wrap.appendChild(canvas);
    mount.appendChild(wrap);

    gctx = canvas.getContext("2d");
    sizeCanvas();
    watchSize(canvas);
  }

  window.ApexOverlay.registerWidget("ghosthud", {
    throttleMs: 33,
    init: init,
    update: update,
  });
})();
