/**
 * ghosthud.js — Ghost HUD: a fast lap's racing line, on the road ahead of you.
 * -----------------------------------------------------------------------------
 * The road in front of the car, drawn from the learned circuit so it bends the
 * way the circuit bends, with a chosen lap's racing line painted on it — green
 * where that lap was on the power, amber off it, red under braking. Red boards
 * lie across the road where that lap started braking, pins stand where its line
 * turned hardest, a gate stands where it is on the clock right now, and the
 * signed seconds sit in the corner.
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
 * ## Why it paints on its own clock
 * v2 drew only when a frame arrived, through the dispatcher's 33 ms throttle,
 * and placed the car along the road by the wire's `lapFraction` — REST lap
 * distance, ~7 updates a second and 5–14 m stale — while the camera rode the
 * fresh shared-memory position. The gate lunged ~7 times a second (median
 * 18 px a paint) and the picture moved in steps. Now `update` only files a
 * timestamped sample (`ghost-pose.js`), a `requestAnimationFrame` loop paints
 * the pose interpolated ~40 ms behind the newest sample, and the distance
 * along the road comes from projecting that same position onto the map. Median
 * gate movement fell to under a pixel a paint, the same at a 30 Hz feed.
 *
 * The loop runs only while there is something moving to draw. A stale feed,
 * a hidden widget or a missing circuit or line paints its message once and
 * stops; the next frame wakes it.
 *
 * ## Where the data comes from
 * Nothing here is new telemetry. The player's world position rides
 * `frame.trackMap.cars[isPlayer]`, their heading `frame.player.motion.heading`,
 * the circuit `/trackmap.json`, and the ghost's line `/ghost.json` — all four
 * in the sim's own world axes, so a lap recorded weeks ago lands on today's
 * road with no fitting. `/ghost.json` may also carry the server's `brakes` and
 * `corners`; without them (an older server, a fixture) the same marks are
 * found from the line itself. The maths lives in `ghost-geom.js` and
 * `ghost-pose.js`, both pure and tested headlessly; this file is the painting.
 */

(function () {
  "use strict";

  var GEO = window.ApexGhostGeom;
  var POSE = window.ApexGhostPose;

  /* ------------------------------- framing -------------------------------- */

  /** How much road is drawn, metres. Behind stays well inside CAM_BACK. */
  var VIEW_AHEAD_M = 170;
  var VIEW_BEHIND_M = 16;
  /** Spacing of the road-edge samples. The edges are splines, so 2 m is smooth. */
  var ROAD_STEP_M = 2;

  /**
   * Chase camera: 30 m back and 6.2 m up through a 36° lens, horizon 15% down
   * the canvas, which puts the car about 80% of the way down. A narrow lens
   * from further back keeps the next corner LARGE — the wide, close camera of
   * v2 spent a third of the canvas on the 12 m of road behind the car.
   */
  var CAM_BACK = 30;
  var CAM_H = 6.2;
  var FOV_DEG = 36;
  var HORIZON = 0.15;
  /** The optical centre, as a share of the height; pitch puts the horizon at HORIZON. */
  var CENTRE = 0.5;
  /** Canvas height as a fraction of its width. */
  var ASPECT = 0.48;
  /** Camera yaw: this share of the road's own direction, the rest the car's. */
  var YAW_ROAD = 0.45;

  /* -------------------------------- the line ------------------------------ */

  /** The prepared line's spacing and smoothing, metres (see `prepareLine`). */
  var STEP_M = 1;
  var SMOOTH_SIGMA_M = 1.5;

  /** Ribbon width in METRES, so it narrows with distance like paint would… */
  var GHOST_W = 0.36;
  /** …but never below this in PIXELS, or the far line breaks into dashes. */
  var GHOST_MIN_PX = 1.6;
  /** Extra half-width of the dark keyline and the faint glow, pixels. */
  var KEYLINE_PX = 1.4;
  var GLOW_PX = 3.2;
  /**
   * Samples (metres) either side of a pedal change that the colour blends
   * over. A hard step from red to amber reads as a seam in the paint, not as
   * a driver easing off the brake.
   */
  var BLEND_SAMPLES = 3;

  /** Your own trail: how finely it is kept and how much of it. */
  var TRAIL_STEP_M = 1;
  var TRAIL_MAX = 16;
  /** A step longer than this is a reset or a tow; a trail across it would lie. */
  var TRAIL_JUMP_M = 60;

  /* -------------------------------- the marks ----------------------------- */

  /** Show the brake countdown when the next board is within this. */
  var BRAKE_CUE_M = 220;
  /** How deep a brake board is along the road, metres. */
  var BOARD_DEPTH_M = 2.2;
  /** Faint distance ticks across the road, every this many metres. */
  var TICK_EVERY_M = 20;
  /** An apex pin nearer than this is under the car and says nothing. */
  var PIN_MIN_AHEAD_M = 3;

  /** The ghost's gate: half its width and its height, metres. */
  var GATE_HALF_M = 1.0;
  var GATE_TOP_M = 1.5;
  /**
   * The gate fades out as the ghost closes in, fully drawn at GATE_FULL_M and
   * gone by GATE_GONE_M. Closer than that it stands on top of your own
   * chevron and hides the one thing you need to see — and the gap readout
   * already says "level" more precisely than a marker under the car could.
   */
  var GATE_FULL_M = 12;
  var GATE_GONE_M = 6;

  /* ------------------------------- locating ------------------------------- */

  /** Search this far either side of the last answer for the car's road position. */
  var LOCATE_WINDOW_M = 60;
  /** …and this far either side of the server's figure when there is no last answer. */
  var SEED_WINDOW_M = 150;
  /** Further than this from the centreline is not on this road (pit lane, tow). */
  var MAX_OFF_ROAD_M = 40;

  /* --------------------------------- timing -------------------------------- */

  /** See `ghost-pose.js` for what each of these buys. */
  var POSE_DELAY_MS = 40;
  var POSE_MAX_EXTRAP_MS = 100;
  var POSE_HOLD_MS = 250;

  /** Re-check the canvas size every this many data frames (DPR moves with no resize). */
  var SIZE_CHECK_FRAMES = 30;
  /** Re-read `--panel-alpha` every this many data frames: it is a style recalc. */
  var ALPHA_CHECK_FRAMES = 10;

  /** |gapSec| at or under this is a dead heat. */
  var LEVEL_SEC = 0.05;

  /* -------------------------------- colour -------------------------------- */

  /**
   * Theme tokens, read from the stylesheet ONCE at init. A canvas cannot use
   * `var(--…)`, and reading computed style per frame is a style recalc per
   * frame. These are the fallbacks if a token is missing.
   */
  var C = {
    throttle: "#35d07f",
    coast: "#ffb020",
    brake: "#ff5470",
    gain: "#35d07f",
    loss: "#ff5470",
    text: "#f4f6fb",
    text2: "#aeb6c8",
    muted: "#6b7387",
    cyan: "#22d3ee",
    purple: "#8b5cf6",
    fontDisplay: '"Bahnschrift", "Arial Narrow", "Segoe UI Semibold", sans-serif',
  };

  /** Fixed paint, not themed: the road and the inks that keep marks legible on it. */
  var C_EDGE = "rgba(225,232,246,0.62)";
  var C_TICK = "rgba(174,182,200,0.16)";
  var C_INK = "rgba(4,6,12,0.70)";
  var C_INK_STRONG = "rgba(4,6,12,0.85)";
  var C_PLATE = "rgba(8,10,16,0.78)";
  var C_PLATE_EDGE = "rgba(49,56,80,0.9)";

  /** Derived from the tokens in `readTokens`; indexed by `GEO.pedalKind`. */
  var kindColour = ["", "", ""];
  var kindGlow = ["", "", ""];
  var brakeFill = "";
  var brakeEdge = "";
  var pinMast = "";
  var gatePost = "";

  /* -------------------------------- state --------------------------------- */

  var canvas = null;
  var gctx = null;
  var headerMeta = null;
  var cssW = 0;
  var cssH = 0;
  var dpr = 1;
  /** The canvas's laid-out width from the ResizeObserver; 0 while display:none. */
  var boxW = -1;
  /** Bumped whenever something a cached paint depends on changes. */
  var paintVer = 0;

  var panelAlpha = 1;
  var sizeTick = 0;
  var alphaTick = 0;
  var noteWork = null;

  /** The circuit, from `/trackmap.json`. */
  var shape = null;
  var haveKey = "";
  var haveRevision = -1;
  var shapeFetching = false;
  /** Its lap length and half-width, metres. */
  var lapM = 0;
  var halfW = 6;

  /** The ghost's line, from `/ghost.json`. */
  var line = null;
  var haveLapId = "";
  var lineFetching = false;

  /**
   * Built once per lap or circuit, never per frame: the prepared line, its
   * per-sample elevation and pedal state, and the lap's marks in lap metres.
   */
  var prep = null;
  var prepElev = null;
  var prepKind = null;
  var brakeM = null;
  var apexM = null;
  var apexX = null;
  var apexZ = null;

  /** The newest frame's ghost block, and its server-side road position hints. */
  var ghostState = null;
  var seedFrac = NaN;
  var serverAtD = NaN;
  var lastLabel = "";

  var poseBuf = POSE ? POSE.create({ delayMs: POSE_DELAY_MS, maxExtrapMs: POSE_MAX_EXTRAP_MS, holdMs: POSE_HOLD_MS }) : null;
  var pose = { x: 0, z: 0, h: 0, gapM: 0, ageMs: 0 };
  /** The car's last known lap metres, the hint for the next search; −1 = unknown. */
  var myM = -1;

  /** Where the car has actually been: a ring of [x, z, elevation]. */
  var trX = new Float64Array(TRAIL_MAX);
  var trZ = new Float64Array(TRAIL_MAX);
  var trE = new Float64Array(TRAIL_MAX);
  var trN = 0;
  var trHead = 0;

  /** The animation loop's pending request; 0 when stopped. */
  var rafId = 0;

  /** What the last static paint showed, so an unchanged message is not redrawn. */
  var shownNote = null;
  var shownNoteGap = NaN;
  var shownNoteVer = -1;

  /* ---------------------- per-frame scratch (no garbage) ------------------- */

  var cam = {};
  var camOpts = { cx: 0, cy: 0, f: 1, back: CAM_BACK, height: CAM_H, pitch: 0, roadY: 0 };
  var view = { c: 1, s: 0, px: 0, pz: 0 };
  var horizonY = 0;
  /** The highest point the road reached on screen — where the fade begins. */
  var topY = 0;

  var RS = { x: 0, z: 0, y: 0, tx: 0, tz: 1 };
  var RS2 = { x: 0, z: 0, y: 0, tx: 0, tz: 1 };
  var PA = { x: 0, z: 0, nx: 0, nz: 0, i: 0 };
  var Q = { x: 0, y: 0, z: 0 };
  var Q1 = { x: 0, y: 0, z: 0 };
  var Q2 = { x: 0, y: 0, z: 0 };
  var Q3 = { x: 0, y: 0, z: 0 };
  var Q4 = { x: 0, y: 0, z: 0 };

  var ROAD_N = Math.round((VIEW_AHEAD_M + VIEW_BEHIND_M) / ROAD_STEP_M) + 1;
  var rdLx = new Float32Array(ROAD_N);
  var rdLy = new Float32Array(ROAD_N);
  var rdRx = new Float32Array(ROAD_N);
  var rdRy = new Float32Array(ROAD_N);
  var rdOk = new Uint8Array(ROAD_N);

  /** The ghost ribbon in screen space: centre, unit half-width direction, half-width px. */
  var RIB_N = Math.ceil(VIEW_AHEAD_M / STEP_M) + 2;
  var rbX = new Float32Array(RIB_N);
  var rbY = new Float32Array(RIB_N);
  var rbUx = new Float32Array(RIB_N);
  var rbUy = new Float32Array(RIB_N);
  var rbHw = new Float32Array(RIB_N);
  var rbOk = new Uint8Array(RIB_N);
  var rbKind = new Uint8Array(RIB_N);
  /** Pedal changes within one span, and the blend region round each. */
  var trAt = new Int32Array(RIB_N);
  var trLo = new Int32Array(RIB_N);
  var trHi = new Int32Array(RIB_N);

  /* ------------------------------- gradients ------------------------------ */

  /*
   * Every gradient here is built ONCE in unit space — (0,0) to (1,0) — and
   * stretched onto its target at fill time by the transform (`fillAlong`).
   * A canvas fills a path with the style interpreted in the coordinate system
   * current at fill(), not the one the path was built in, so the path can be
   * laid down in screen space and the gradient mapped onto any segment
   * afterwards. The alternative, createLinearGradient per mark per frame, is a
   * steady stream of garbage from the render loop.
   */
  var gBlend = null; // [from*3 + to] for the core colour
  var gBlendGlow = null; // the same for the glow
  var gFog = null;
  var gGate = null;
  var gBrand = null;
  /** The asphalt: a real-space gradient, rebuilt only when size or alpha moves. */
  var gRoad = null;
  var gRoadVer = -1;

  function buildGradients() {
    gBlend = [];
    gBlendGlow = [];
    for (var a = 0; a < 3; a++) {
      for (var b = 0; b < 3; b++) {
        gBlend.push(unitGradient(kindColour[a], kindColour[b]));
        gBlendGlow.push(unitGradient(kindGlow[a], kindGlow[b]));
      }
    }
    gFog = unitGradient("rgba(0,0,0,0)", "rgba(0,0,0,1)");
    gGate = unitGradient(withAlpha(C.purple, 0.55, "#8b5cf6"), withAlpha(C.purple, 0, "#8b5cf6"));
    gBrand = unitGradient(C.cyan, C.purple);
  }

  function unitGradient(from, to) {
    var g = gctx.createLinearGradient(0, 0, 1, 0);
    g.addColorStop(0, from);
    g.addColorStop(1, to);
    return g;
  }

  /**
   * Fill the current path with a unit gradient laid from (x0,y0) to (x1,y1).
   * A segment too short to give a direction falls back to `solid`.
   */
  function fillAlong(grad, x0, y0, x1, y1, solid) {
    var dx = x1 - x0;
    var dy = y1 - y0;
    if (dx * dx + dy * dy < 1e-4) {
      gctx.fillStyle = solid;
      gctx.fill();
      return;
    }
    gctx.setTransform(dpr * dx, dpr * dy, -dpr * dy, dpr * dx, dpr * x0, dpr * y0);
    gctx.fillStyle = grad;
    gctx.fill();
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* -------------------------------- tokens -------------------------------- */

  function readTokens() {
    try {
      var cs = getComputedStyle(document.documentElement);
      var pick = function (name, fallback) {
        var v = cs.getPropertyValue(name).trim();
        return v || fallback;
      };
      C.throttle = pick("--pedal-throttle", C.throttle);
      C.brake = pick("--pedal-brake", C.brake);
      C.coast = pick("--warn", C.coast);
      C.gain = pick("--pos-gain", C.gain);
      C.loss = pick("--pos-loss", C.loss);
      C.text = pick("--text-primary", C.text);
      C.text2 = pick("--text-secondary", C.text2);
      C.muted = pick("--text-muted", C.muted);
      C.cyan = pick("--ac-cyan", C.cyan);
      C.purple = pick("--ac-purple", C.purple);
      C.fontDisplay = pick("--font-display", C.fontDisplay);
    } catch (e) {
      /* no computed style here; the fallbacks stand */
    }
    kindColour[GEO.PEDAL_THROTTLE] = C.throttle;
    kindColour[GEO.PEDAL_COAST] = C.coast;
    kindColour[GEO.PEDAL_BRAKE] = C.brake;
    kindGlow[GEO.PEDAL_THROTTLE] = withAlpha(C.throttle, 0.18, "#35d07f");
    kindGlow[GEO.PEDAL_COAST] = withAlpha(C.coast, 0.18, "#ffb020");
    kindGlow[GEO.PEDAL_BRAKE] = withAlpha(C.brake, 0.18, "#ff5470");
    brakeFill = withAlpha(C.brake, 0.34, "#ff5470");
    brakeEdge = withAlpha(C.brake, 0.95, "#ff5470");
    pinMast = withAlpha(C.cyan, 0.75, "#22d3ee");
    gatePost = withAlpha(C.purple, 0.55, "#8b5cf6");
  }

  /** A `#rgb`/`#rrggbb` token at an alpha. A token in any other form uses `fallbackHex`. */
  function withAlpha(colour, a, fallbackHex) {
    var h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colour) ? colour.slice(1) : fallbackHex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  /**
   * The operator's background opacity (the "BG" slider), read back out of the
   * cascade: every other widget's panel resolves `--panel-alpha` in CSS, but
   * a canvas has to multiply it into its own asphalt. Sampled from the data
   * path every ALPHA_CHECK_FRAMES, the cadence speedo.js uses, never per paint.
   */
  function pollPanelAlpha() {
    var a = 1;
    try {
      var v = parseFloat(getComputedStyle(canvas).getPropertyValue("--panel-alpha"));
      if (isFinite(v)) a = v < 0 ? 0 : v > 1 ? 1 : v;
    } catch (e) {
      /* keep solid */
    }
    if (a !== panelAlpha) {
      panelAlpha = a;
      paintVer++;
    }
  }

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
      setShape(null);
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
        haveKey = wantKey;
        haveRevision = wantRev;
        setShape(data);
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
      if (line) setLine(null);
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
        haveLapId = data.lapId || id;
        setLine(data);
      })
      .catch(function () {
        lineFetching = false;
      });
  }

  function setShape(data) {
    shape = data;
    lapM = data ? GEO.mapLength(data) : 0;
    halfW = data && data.halfWidthM > 0 ? data.halfWidthM : 6;
    // A new circuit: the old road position and trail mean nothing on it.
    myM = -1;
    trN = 0;
    buildStatic();
  }

  function setLine(data) {
    line = data;
    // The expensive half, once per lap selection (~5 ms for a 4 km lap).
    prep = data ? GEO.prepareLine(data, STEP_M, SMOOTH_SIGMA_M, data.trackLengthM || lapM) : null;
    prepKind = null;
    if (prep) {
      prepKind = new Uint8Array(prep.n);
      for (var i = 0; i < prep.n; i++) prepKind[i] = GEO.pedalKind(prep.brake[i], prep.throttle[i]);
    }
    buildStatic();
  }

  /**
   * Everything that needs BOTH the circuit and the line: the line's elevation
   * (read off the road, never the lap — traces record no `y`), and the brake
   * boards and apex pins in lap metres.
   *
   * The server's `brakes` / `corners` win when they are present, even empty:
   * an empty list from the server is an answer. Only an older server or a
   * fixture, which sends no list at all, falls back to finding them here.
   */
  function buildStatic() {
    prepElev = null;
    brakeM = apexM = apexX = apexZ = null;
    paintVer++;
    if (!shape || !prep) return;

    prepElev = new Float32Array(prep.n);
    for (var i = 0; i < prep.n; i++) prepElev[i] = GEO.roadElevationAt(shape, prep.d[i] * lapM);

    var brakes = Array.isArray(line.brakes) ? line.brakes : GEO.detectBrakes(line, line.trackLengthM || lapM);
    var bm = [];
    for (var b = 0; b < brakes.length; b++) {
      var bk = brakes[b];
      if (bk && isFinite(bk.d)) bm.push(wrapLap(bk.d * lapM));
    }
    brakeM = Float64Array.from(bm);

    var corners = Array.isArray(line.corners) ? line.corners : GEO.detectApexes(prep);
    var am = [];
    var ax = [];
    var az = [];
    for (var c = 0; c < corners.length; c++) {
      var k = corners[c];
      if (!k || !isFinite(k.apexD) || !isFinite(k.apexX) || !isFinite(k.apexZ)) continue;
      am.push(wrapLap(k.apexD * lapM));
      ax.push(k.apexX);
      az.push(k.apexZ);
    }
    apexM = Float64Array.from(am);
    apexX = Float64Array.from(ax);
    apexZ = Float64Array.from(az);
  }

  /* -------------------------------- sizing -------------------------------- */

  var fontValue = "";
  var fontLabel = "";
  var fontNote = "";
  var valuePx = 18;

  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth;
    if (!w) return; // display:none — keep the last size; the loop is stopped anyway
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
    valuePx = Math.max(18, Math.round(cssW * 0.05));
    fontValue = "600 " + valuePx + "px " + C.fontDisplay;
    fontLabel = "600 " + Math.max(9, Math.round(valuePx * 0.42)) + "px " + C.fontDisplay;
    fontNote = "600 " + Math.max(11, Math.round(cssW * 0.021)) + "px " + C.fontDisplay;
    paintVer++;
    wake();
  }

  function watchSize(el) {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function (entries) {
        var r = entries[entries.length - 1].contentRect;
        boxW = r ? r.width : -1;
        sizeCanvas();
        wake();
      }).observe(el);
    }
    window.addEventListener("resize", sizeCanvas, { passive: true });
    document.addEventListener("visibilitychange", wake);
  }

  /**
   * Whether painting can be seen at all. A widget switched off is
   * `display:none` (zero width), a minimised layer is a hidden document, and
   * an OBS source auto-hidden off-track fades the whole page out.
   */
  function shown() {
    if (document.hidden || boxW === 0) return false;
    return document.documentElement.getAttribute("data-autohidden") !== "true";
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

  function wrapLap(m) {
    return ((m % lapM) + lapM) % lapM;
  }

  /** `m − from`, the short way round the lap. */
  function lapAhead(m, from) {
    var a = m - from;
    var half = lapM / 2;
    if (a < -half) a += lapM;
    else if (a > half) a -= lapM;
    return a;
  }

  function fmtDelta(sec) {
    var s = Math.abs(sec) < 0.005 ? 0 : sec;
    return (s > 0 ? "+" : s < 0 ? "−" : "") + Math.abs(s).toFixed(2);
  }

  function deltaColour(gapSec) {
    if (Math.abs(gapSec) <= LEVEL_SEC) return C.text;
    return gapSec > 0 ? C.loss : C.gain;
  }

  /** NaN-aware equality for the static-paint cache. */
  function same(a, b) {
    return a === b || (a !== a && b !== b);
  }

  /* -------------------------------- locating ------------------------------- */

  /**
   * The car's distance along the lap, from its interpolated position.
   *
   * Tried in order of trust: near the last answer (the normal case, and the
   * one that cannot jump to the other side of a hairpin); near the server's
   * own road position — its filtered `atD` when it sends one, else the REST
   * `lapFraction`, which is stale but close enough to seed a window; the whole
   * lap; and finally the server's figure as it stands, so a car just off the
   * map (a wide moment, the pit entry) still gets a road to stand on.
   *
   * @returns {number} Lap metres, or −1 when there is nothing to go on.
   */
  function locate(x, z) {
    var m = null;
    if (myM >= 0) m = GEO.roadDistanceOf(shape, x, z, myM, LOCATE_WINDOW_M, MAX_OFF_ROAD_M);
    var seed = isFinite(serverAtD) ? serverAtD : seedFrac;
    var seedM = isFinite(seed) ? wrapLap(seed * lapM) : NaN;
    if (m === null && isFinite(seedM)) m = GEO.roadDistanceOf(shape, x, z, seedM, SEED_WINDOW_M, MAX_OFF_ROAD_M);
    if (m === null) m = GEO.roadDistanceOf(shape, x, z, NaN, 0, MAX_OFF_ROAD_M);
    if (m === null) return isFinite(seedM) ? seedM : -1;
    return m;
  }

  /** Keep your own last few metres, from the pose actually drawn. */
  function noteTrail(x, z, e) {
    if (trN) {
      var last = (trHead - 1 + TRAIL_MAX) % TRAIL_MAX;
      var step = Math.hypot(x - trX[last], z - trZ[last]);
      if (step < TRAIL_STEP_M) return;
      if (step > TRAIL_JUMP_M) trN = 0;
    }
    trX[trHead] = x;
    trZ[trHead] = z;
    trE[trHead] = e;
    trHead = (trHead + 1) % TRAIL_MAX;
    if (trN < TRAIL_MAX) trN++;
  }

  /* --------------------------------- view ---------------------------------- */

  /** The camera and view for this paint. Returns the car's road elevation. */
  function setCamera(at) {
    var here = GEO.roadAt(shape, at, RS);
    var roadH = (Math.atan2(here.tx, here.tz) * 180) / Math.PI;
    var f = cssW / 2 / Math.tan(((FOV_DEG / 2) * Math.PI) / 180);
    camOpts.cx = cssW / 2;
    camOpts.cy = cssH * CENTRE;
    camOpts.f = f;
    camOpts.pitch = GEO.horizonPitch(f, (CENTRE - HORIZON) * cssH);
    // The eye rides the player's OWN road height. Pinned to absolute world Y it
    // sits underground on a climb and in the air on a descent.
    camOpts.roadY = here.y;
    GEO.camera(camOpts, cam);
    GEO.setView(view, GEO.chaseYaw(pose.h, roadH, YAW_ROAD), pose.x, pose.z);
    horizonY = cssH * HORIZON;
    return here.y;
  }

  /** Project a world point into `out`. */
  function toScreen(x, z, e, out) {
    return GEO.projectWorld(cam, view, x, z, e, out);
  }

  /* ------------------------------- painting -------------------------------- */

  /** The asphalt and its edges, from the learned circuit. False if none of it is visible. */
  function drawRoad(at) {
    var n = 0;
    var top = cssH;
    for (var i = 0; i < ROAD_N; i++) {
      var s = GEO.roadAt(shape, at - VIEW_BEHIND_M + i * ROAD_STEP_M, RS);
      // Right of travel is (tz, −tx).
      var okL = toScreen(s.x - s.tz * halfW, s.z + s.tx * halfW, s.y, Q1);
      var okR = toScreen(s.x + s.tz * halfW, s.z - s.tx * halfW, s.y, Q2);
      rdOk[i] = okL && okR ? 1 : 0;
      if (!rdOk[i]) continue;
      rdLx[i] = Q1.x;
      rdLy[i] = Q1.y;
      rdRx[i] = Q2.x;
      rdRy[i] = Q2.y;
      if (Q1.y < top) top = Q1.y;
      if (Q2.y < top) top = Q2.y;
      n++;
    }
    if (n < 2) return false;
    // Over a crest the far end of the road is well below the horizon, and the
    // fade has to start THERE or the road ends at a hard cut.
    topY = Math.max(horizonY, top);

    if (gRoadVer !== paintVer) {
      // Lighter near the car, falling off toward the horizon, and through
      // --panel-alpha like every other widget surface.
      gRoad = gctx.createLinearGradient(0, cssH, 0, horizonY);
      gRoad.addColorStop(0, "rgba(34,39,54," + 0.96 * panelAlpha + ")");
      gRoad.addColorStop(1, "rgba(18,21,32," + 0.9 * panelAlpha + ")");
      gRoadVer = paintVer;
    }
    gctx.beginPath();
    var started = false;
    for (var a = 0; a < ROAD_N; a++) {
      if (!rdOk[a]) continue;
      if (!started) gctx.moveTo(rdLx[a], rdLy[a]);
      else gctx.lineTo(rdLx[a], rdLy[a]);
      started = true;
    }
    for (var b = ROAD_N - 1; b >= 0; b--) if (rdOk[b]) gctx.lineTo(rdRx[b], rdRy[b]);
    gctx.closePath();
    gctx.fillStyle = gRoad;
    gctx.fill();

    // The edges are the read of the corner's shape: thin and bright.
    gctx.lineJoin = "round";
    gctx.lineCap = "round";
    gctx.strokeStyle = C_EDGE;
    gctx.lineWidth = 1.5;
    strokeEdge(rdLx, rdLy);
    strokeEdge(rdRx, rdRy);
    return true;
  }

  function strokeEdge(xs, ys) {
    gctx.beginPath();
    var on = false;
    for (var k = 0; k < ROAD_N; k++) {
      if (!rdOk[k]) {
        on = false;
        continue;
      }
      if (!on) gctx.moveTo(xs[k], ys[k]);
      else gctx.lineTo(xs[k], ys[k]);
      on = true;
    }
    gctx.stroke();
  }

  /** Faint lines across the road every TICK_EVERY_M: they carry the sense of speed. */
  function drawTicks(at) {
    var w = halfW * 0.92;
    var m0 = Math.ceil((at - VIEW_BEHIND_M) / TICK_EVERY_M) * TICK_EVERY_M;
    gctx.strokeStyle = C_TICK;
    gctx.lineWidth = 1;
    gctx.beginPath();
    for (var m = m0; m <= at + VIEW_AHEAD_M; m += TICK_EVERY_M) {
      var s = GEO.roadAt(shape, m, RS);
      if (!toScreen(s.x - s.tz * w, s.z + s.tx * w, s.y, Q1)) continue;
      if (!toScreen(s.x + s.tz * w, s.z - s.tx * w, s.y, Q2)) continue;
      gctx.moveTo(Q1.x, Q1.y);
      gctx.lineTo(Q2.x, Q2.y);
    }
    gctx.stroke();
  }

  /**
   * A band across the full road where the ghost started braking — a braking
   * board lying on the track, the thing a driver actually aims at.
   *
   * @returns {number} Metres to the next board ahead, or Infinity.
   */
  function drawBrakeBoards(at) {
    var next = Infinity;
    if (!brakeM || !brakeM.length) return next;
    for (var i = 0; i < brakeM.length; i++) {
      var ahead = lapAhead(brakeM[i], at);
      if (ahead < -2 || ahead > VIEW_AHEAD_M) continue;
      if (ahead > 0 && ahead < next) next = ahead;
      var s0 = GEO.roadAt(shape, at + ahead, RS);
      var s1 = GEO.roadAt(shape, at + ahead + BOARD_DEPTH_M, RS2);
      if (!toScreen(s0.x - s0.tz * halfW, s0.z + s0.tx * halfW, s0.y, Q1)) continue;
      if (!toScreen(s0.x + s0.tz * halfW, s0.z - s0.tx * halfW, s0.y, Q2)) continue;
      if (!toScreen(s1.x + s1.tz * halfW, s1.z - s1.tx * halfW, s1.y, Q3)) continue;
      if (!toScreen(s1.x - s1.tz * halfW, s1.z + s1.tx * halfW, s1.y, Q4)) continue;
      quad(Q1, Q2, Q3, Q4);
      gctx.fillStyle = brakeFill;
      gctx.fill();
      // The near edge is the line itself: drawn hard, like a painted board.
      gctx.strokeStyle = brakeEdge;
      gctx.lineWidth = 1.5;
      gctx.beginPath();
      gctx.moveTo(Q1.x, Q1.y);
      gctx.lineTo(Q2.x, Q2.y);
      gctx.stroke();
    }
    return next;
  }

  function quad(a, b, c, d) {
    gctx.beginPath();
    gctx.moveTo(a.x, a.y);
    gctx.lineTo(b.x, b.y);
    gctx.lineTo(c.x, c.y);
    gctx.lineTo(d.x, d.y);
    gctx.closePath();
  }

  /** Your own last few metres: thin, quiet, fading — context, not a feature. */
  function drawTrail() {
    if (trN < 2) return;
    gctx.lineJoin = "round";
    gctx.lineCap = "round";
    gctx.lineWidth = 2;
    gctx.strokeStyle = C.text;
    var first = (trHead - trN + TRAIL_MAX) % TRAIL_MAX;
    for (var k = 1; k < trN; k++) {
      var a = (first + k - 1) % TRAIL_MAX;
      var b = (first + k) % TRAIL_MAX;
      if (!toScreen(trX[a], trZ[a], trE[a] + 0.03, Q1)) continue;
      if (!toScreen(trX[b], trZ[b], trE[b] + 0.03, Q2)) continue;
      gctx.globalAlpha = 0.08 + (0.5 * k) / trN;
      gctx.beginPath();
      gctx.moveTo(Q1.x, Q1.y);
      gctx.lineTo(Q2.x, Q2.y);
      gctx.stroke();
    }
    gctx.globalAlpha = 1;
  }

  /** One ribbon vertex into the screen-space arrays. */
  function ribbonVertex(k, x, z, nx, nz, e, kind) {
    rbKind[k] = kind;
    if (!toScreen(x, z, e, Q1) || !toScreen(x + nx * (GHOST_W / 2), z + nz * (GHOST_W / 2), e, Q2)) {
      rbOk[k] = 0;
      return;
    }
    // One side is projected and mirrored: across 18 cm the perspective
    // difference between the two sides is far below a pixel.
    var ox = Q2.x - Q1.x;
    var oy = Q2.y - Q1.y;
    var ol = Math.hypot(ox, oy);
    rbOk[k] = 1;
    rbX[k] = Q1.x;
    rbY[k] = Q1.y;
    rbUx[k] = ol > 1e-4 ? ox / ol : 1;
    rbUy[k] = ol > 1e-4 ? oy / ol : 0;
    // World width, floored in PIXELS: thins with distance, never breaks up.
    rbHw[k] = ol > GHOST_MIN_PX / 2 ? ol : GHOST_MIN_PX / 2;
  }

  /**
   * The ghost's line from under the car to the end of the view, in screen
   * space. It starts EXACTLY at the car (interpolated between samples) rather
   * than at the next whole metre, or its near end would tick forward a metre
   * at a time right where the eye is.
   *
   * @returns {number} Vertices written.
   */
  function buildRibbon(at) {
    var n = prep.n;
    GEO.preparedAt(prep, wrapLap(at) / lapM, PA);
    var lo = Math.floor(PA.i);
    var hi = lo + 1 < n ? lo + 1 : lo;
    var f = PA.i - lo;
    ribbonVertex(0, PA.x, PA.z, PA.nx, PA.nz, prepElev[lo] + (prepElev[hi] - prepElev[lo]) * f + 0.04, prepKind[f < 0.5 ? lo : hi]);
    var count = 1;
    var i = hi > lo ? hi : lo + 1;
    while (count < RIB_N) {
      if (i >= n) {
        if (!prep.closed) break;
        i -= n;
      }
      ribbonVertex(count++, prep.x[i], prep.z[i], prep.nx[i], prep.nz[i], prepElev[i] + 0.04, prepKind[i]);
      i++;
    }
    return count;
  }

  /** The ribbon from vertex `from` to `to` as one closed path, widened by `widen` px. */
  function stripPath(from, to, widen) {
    gctx.beginPath();
    for (var i = from; i <= to; i++) {
      var w = rbHw[i] + widen;
      if (i === from) gctx.moveTo(rbX[i] + rbUx[i] * w, rbY[i] + rbUy[i] * w);
      else gctx.lineTo(rbX[i] + rbUx[i] * w, rbY[i] + rbUy[i] * w);
    }
    for (var j = to; j >= from; j--) {
      var v = rbHw[j] + widen;
      gctx.lineTo(rbX[j] - rbUx[j] * v, rbY[j] - rbUy[j] * v);
    }
    gctx.closePath();
  }

  /**
   * The ghost's line: a dark keyline so it holds on a bright sunlit frame, a
   * faint glow so it holds on a dark one, and the colour on top.
   *
   * Each stretch of one pedal state is ONE polygon — per-quad fills leave a
   * hairline anti-aliasing seam across the ribbon at every sample — and each
   * change of state blends over BLEND_SAMPLES either side.
   */
  function drawGhostLine(count) {
    var s = -1;
    for (var i = 0; i <= count; i++) {
      var ok = i < count && rbOk[i] === 1;
      if (ok && s < 0) s = i;
      if (!ok && s >= 0) {
        if (i - 1 > s) drawSpan(s, i - 1);
        s = -1;
      }
    }
  }

  function drawSpan(s, e) {
    gctx.fillStyle = C_INK;
    stripPath(s, e, KEYLINE_PX);
    gctx.fill();

    // Where the pedal state changes, and the stretch each change blends over:
    // BLEND_SAMPLES either side, but never past halfway to the next change.
    var nt = 0;
    for (var i = s + 1; i <= e; i++) if (rbKind[i] !== rbKind[i - 1]) trAt[nt++] = i;
    for (var j = 0; j < nt; j++) {
      var k = trAt[j];
      var lo = k - BLEND_SAMPLES;
      var hi = k - 1 + BLEND_SAMPLES;
      if (j > 0) lo = Math.max(lo, (trAt[j - 1] + k) >> 1);
      if (j < nt - 1) hi = Math.min(hi, (k + trAt[j + 1]) >> 1);
      trLo[j] = Math.max(s, lo);
      trHi[j] = Math.min(e, hi);
    }
    paintPieces(s, e, nt, GLOW_PX, kindGlow, gBlendGlow, 0);
    // The opaque core overlaps its neighbours by a vertex, so no seam of the
    // keyline shows through between pieces.
    paintPieces(s, e, nt, 0, kindColour, gBlend, 1);
  }

  /** Paint a span as solid pieces between blends, then the blends. */
  function paintPieces(s, e, nt, widen, solid, blend, overlap) {
    var from = s;
    for (var j = 0; j <= nt; j++) {
      var to = j < nt ? trLo[j] : e;
      if (to > from) {
        stripPath(Math.max(s, from - overlap), Math.min(e, to + overlap), widen);
        gctx.fillStyle = solid[rbKind[from]];
        gctx.fill();
      }
      if (j < nt) from = trHi[j];
    }
    for (var b = 0; b < nt; b++) {
      var lo = trLo[b];
      var hi = trHi[b];
      var ka = rbKind[trAt[b] - 1];
      var kb = rbKind[trAt[b]];
      stripPath(Math.max(s, lo - overlap), Math.min(e, hi + overlap), widen);
      fillAlong(blend[ka * 3 + kb], rbX[lo], rbY[lo], rbX[hi], rbY[hi], solid[kb]);
    }
  }

  /**
   * A pin where the ghost's line turned hardest in each corner: a thin mast
   * and a diamond, tall enough to be found, small enough not to hide the line.
   */
  function drawApexPins(at) {
    if (!apexM || !apexM.length) return;
    for (var i = 0; i < apexM.length; i++) {
      var ahead = lapAhead(apexM[i], at);
      if (ahead < PIN_MIN_AHEAD_M || ahead > VIEW_AHEAD_M) continue;
      var e = GEO.roadElevationAt(shape, apexM[i]);
      if (!toScreen(apexX[i], apexZ[i], e, Q1) || !toScreen(apexX[i], apexZ[i], e + 1.1, Q2)) continue;
      var h = Q1.y - Q2.y;
      if (h < 3) continue;
      var r = Math.max(2.2, Math.min(5, h * 0.22));
      gctx.strokeStyle = pinMast;
      gctx.lineWidth = 1.25;
      gctx.beginPath();
      gctx.moveTo(Q1.x, Q1.y);
      gctx.lineTo(Q2.x, Q2.y + r);
      gctx.stroke();
      gctx.beginPath();
      gctx.moveTo(Q2.x, Q2.y - r);
      gctx.lineTo(Q2.x + r, Q2.y);
      gctx.lineTo(Q2.x, Q2.y + r);
      gctx.lineTo(Q2.x - r, Q2.y);
      gctx.closePath();
      gctx.fillStyle = C.cyan;
      gctx.strokeStyle = C_INK_STRONG;
      gctx.lineWidth = 1;
      gctx.fill();
      gctx.stroke();
    }
  }

  /**
   * The ghost: a light curtain standing on its line — a bright bar across the
   * line and a gradient rising and fading, see-through so the line beneath
   * still reads. Anything meant to be found at a glance needs height; a mark
   * lying flat foreshortens to a sliver from a camera this low.
   *
   * Placed at YOUR road position plus the server's `gapM`, both interpolated,
   * so the gate and the GAP readout always describe the same gap.
   *
   * @returns {boolean} Whether it was drawn.
   */
  function drawGate(at, gapM) {
    if (!(gapM > GATE_GONE_M)) return false;
    var fade = Math.min(1, (gapM - GATE_GONE_M) / (GATE_FULL_M - GATE_GONE_M));
    var gm = at + gapM;
    GEO.preparedAt(prep, wrapLap(gm) / lapM, PA);
    var e = GEO.roadElevationAt(shape, gm);
    var lx = PA.x + PA.nx * GATE_HALF_M;
    var lz = PA.z + PA.nz * GATE_HALF_M;
    var rx = PA.x - PA.nx * GATE_HALF_M;
    var rz = PA.z - PA.nz * GATE_HALF_M;
    if (!toScreen(lx, lz, e, Q1) || !toScreen(rx, rz, e, Q2)) return false;
    if (!toScreen(rx, rz, e + GATE_TOP_M, Q3) || !toScreen(lx, lz, e + GATE_TOP_M, Q4)) return false;

    gctx.globalAlpha = fade;
    quad(Q1, Q2, Q3, Q4);
    fillAlong(gGate, (Q1.x + Q2.x) / 2, (Q1.y + Q2.y) / 2, (Q3.x + Q4.x) / 2, (Q3.y + Q4.y) / 2, gatePost);

    gctx.lineCap = "round";
    gctx.strokeStyle = C_INK;
    gctx.lineWidth = 4.5;
    gctx.beginPath();
    gctx.moveTo(Q1.x, Q1.y);
    gctx.lineTo(Q2.x, Q2.y);
    gctx.stroke();
    // The base bar as a thin filled band rather than a stroke, so the brand
    // gradient can be laid along it (a transformed stroke would scale its width).
    var dx = Q2.x - Q1.x;
    var dy = Q2.y - Q1.y;
    var dl = Math.hypot(dx, dy) || 1;
    var px = (-dy / dl) * 1.25;
    var py = (dx / dl) * 1.25;
    gctx.beginPath();
    gctx.moveTo(Q1.x + px, Q1.y + py);
    gctx.lineTo(Q2.x + px, Q2.y + py);
    gctx.lineTo(Q2.x - px, Q2.y - py);
    gctx.lineTo(Q1.x - px, Q1.y - py);
    gctx.closePath();
    fillAlong(gBrand, Q1.x, Q1.y, Q2.x, Q2.y, C.cyan);

    // Posts, faint: body without a frame.
    gctx.strokeStyle = gatePost;
    gctx.lineWidth = 1.25;
    gctx.beginPath();
    gctx.moveTo(Q1.x, Q1.y);
    gctx.lineTo(Q4.x, Q4.y);
    gctx.moveTo(Q2.x, Q2.y);
    gctx.lineTo(Q3.x, Q3.y);
    gctx.stroke();
    gctx.globalAlpha = 1;
    return true;
  }

  /** Fade everything drawn so far into the horizon. One composite op. */
  function fogMask() {
    gctx.beginPath();
    gctx.rect(0, 0, cssW, cssH);
    gctx.globalCompositeOperation = "destination-in";
    fillAlong(gFog, 0, topY, 0, topY + cssH * 0.14, "#000");
    gctx.globalCompositeOperation = "source-over";
  }

  /** You: a brand-gradient chevron lying on the road at the car, along its heading. */
  function drawCar(e) {
    var h = (pose.h * Math.PI) / 180;
    var c = Math.cos(h);
    var s = Math.sin(h);
    // Car-local (lat right, lon ahead) to world: x = px + c·lat + s·lon, z = pz − s·lat + c·lon.
    var ok =
      toScreen(pose.x + s * 2.6, pose.z + c * 2.6, e + 0.05, Q1) && // tip
      toScreen(pose.x + c * 0.85 - s * 0.6, pose.z - s * 0.85 - c * 0.6, e + 0.05, Q2) && // right
      toScreen(pose.x + s * 0.3, pose.z + c * 0.3, e + 0.05, Q3) && // notch
      toScreen(pose.x - c * 0.85 - s * 0.6, pose.z + s * 0.85 - c * 0.6, e + 0.05, Q4); // left
    if (!ok) return;
    quad(Q1, Q2, Q3, Q4);
    gctx.strokeStyle = C_INK_STRONG;
    gctx.lineWidth = 2;
    gctx.lineJoin = "round";
    gctx.stroke();
    fillAlong(gBrand, Q4.x, Q4.y, Q2.x, Q2.y, C.cyan);
  }

  /* --------------------------------- chips --------------------------------- */

  /**
   * A readout chip: dark plate, colour rail, label, value. Text is measured
   * only when it changes — `measureText` returns a fresh object every call.
   */
  function makeChip() {
    return { label: "", value: "", key: NaN, colour: "", valueColour: "", lw: -1, vw: -1, ver: -1 };
  }
  var chipGap = makeChip();
  var chipCue = makeChip();

  function setChip(ch, label, value, colour, valueColour) {
    if (label !== ch.label) {
      ch.label = label;
      ch.lw = -1;
    }
    if (value !== ch.value) {
      ch.value = value;
      ch.vw = -1;
    }
    ch.colour = colour;
    ch.valueColour = valueColour || colour;
  }

  function drawChip(ch, x, y, alignRight) {
    if (ch.ver !== paintVer) {
      ch.lw = ch.vw = -1;
      ch.ver = paintVer;
    }
    if (ch.lw < 0) {
      gctx.font = fontLabel;
      ch.lw = ch.label ? gctx.measureText(ch.label).width + 8 : 0;
    }
    if (ch.vw < 0) {
      gctx.font = fontValue;
      ch.vw = gctx.measureText(ch.value).width;
    }
    var padX = 10;
    var w = padX * 2 + ch.lw + ch.vw + 3;
    var h = valuePx + 12;
    var left = alignRight ? x - w : x;
    roundRect(left, y, w, h, 6);
    gctx.fillStyle = C_PLATE;
    gctx.fill();
    gctx.strokeStyle = C_PLATE_EDGE;
    gctx.lineWidth = 1;
    gctx.stroke();
    gctx.fillStyle = ch.colour;
    gctx.fillRect(left, y + 5, 3, h - 10);
    gctx.textBaseline = "middle";
    gctx.textAlign = "left";
    if (ch.label) {
      gctx.font = fontLabel;
      gctx.fillStyle = C.text2;
      gctx.fillText(ch.label, left + padX + 2, y + h / 2 + 1);
    }
    gctx.font = fontValue;
    gctx.fillStyle = ch.valueColour;
    gctx.fillText(ch.value, left + padX + 2 + ch.lw, y + h / 2 + 1);
  }

  function roundRect(x, y, w, h, r) {
    gctx.beginPath();
    gctx.moveTo(x + r, y);
    gctx.lineTo(x + w - r, y);
    gctx.arcTo(x + w, y, x + w, y + r, r);
    gctx.lineTo(x + w, y + h - r);
    gctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    gctx.lineTo(x + r, y + h);
    gctx.arcTo(x, y + h, x, y + h - r, r);
    gctx.lineTo(x, y + r);
    gctx.arcTo(x, y, x + r, y, r);
    gctx.closePath();
  }

  /** The signed gap, its string rebuilt only when the hundredths change. */
  function drawGapChip() {
    var g = ghostState.gapSec;
    var key = Math.round(g * 100);
    if (key !== chipGap.key) {
      chipGap.key = key;
      setChip(chipGap, "GAP", fmtDelta(g), deltaColour(g));
    }
    drawChip(chipGap, 12, 12, false);
  }

  /** "BRAKE 63 m" — the metres rebuilt only when they change. */
  function drawBrakeChip(aheadM) {
    var m = Math.round(aheadM);
    if (chipCue.label !== "BRAKE" || m !== chipCue.key) {
      chipCue.key = m;
      setChip(chipCue, "BRAKE", m + " m", C.brake, C.text);
    }
    drawChip(chipCue, cssW - 12, 12, true);
  }

  function drawBehindChip() {
    if (chipCue.label !== "GHOST") {
      chipCue.key = NaN;
      setChip(chipCue, "GHOST", "behind", C.purple, C.text2);
    }
    drawChip(chipCue, cssW - 12, 12, true);
  }

  /* -------------------------------- frames --------------------------------- */

  var NOTE_NO_GHOST = "NO GHOST LAP";
  var NOTE_WAITING = "WAITING FOR CAR POSITION";
  var NOTE_LEARNING = "LEARNING THE CIRCUIT";
  var NOTE_NO_LINE = "THIS LAP HAS NO DRIVEN LINE";
  var NOTE_OFF = "OFF THE CIRCUIT";

  /**
   * A frame with nothing moving in it: a message, and the gap if there is
   * one. Drawn only when it differs from what is already on the canvas.
   *
   * @returns {boolean} Always false — nothing here needs the next display frame.
   */
  function paintNote(note) {
    var withGap = !!(ghostState && ghostState.active);
    var gapKey = withGap ? Math.round(ghostState.gapSec * 100) : NaN;
    if (note === shownNote && same(gapKey, shownNoteGap) && shownNoteVer === paintVer) return false;
    shownNote = note;
    shownNoteGap = gapKey;
    shownNoteVer = paintVer;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);
    gctx.font = fontNote;
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    gctx.fillStyle = C.muted;
    gctx.fillText(note, cssW / 2, cssH / 2);
    if (withGap) drawGapChip();
    return false;
  }

  /**
   * One display frame.
   *
   * @returns {boolean} True while the picture is moving and the loop should
   *   keep running; false when it has settled on something static.
   */
  function paint(nowMs) {
    if (!ghostState) {
      trN = 0;
      return paintNote(NOTE_NO_GHOST);
    }
    var st = POSE.sample(poseBuf, nowMs, pose);
    if (st === POSE.NONE || st === POSE.STALE) {
      // The car's position is gone — spectating, a menu, the feed paused.
      // Forget the road position too: the car may be anywhere when it returns.
      myM = -1;
      return paintNote(NOTE_WAITING);
    }
    if (!shape) return paintNote(NOTE_LEARNING);
    if (!prep || !prepElev) return paintNote(NOTE_NO_LINE);
    var at = locate(pose.x, pose.z);
    if (at < 0) return paintNote(NOTE_OFF);
    myM = at;
    shownNote = null;

    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);
    var myE = setCamera(at);
    noteTrail(pose.x, pose.z, myE);

    if (!drawRoad(at)) {
      shownNote = null; // the canvas was just cleared, so the note must be drawn
      return paintNote(NOTE_OFF);
    }
    drawTicks(at);
    var nextBrake = drawBrakeBoards(at);
    drawTrail();
    drawGhostLine(buildRibbon(at));
    drawApexPins(at);
    var active = !!ghostState.active;
    var gateDrawn = active && drawGate(at, pose.gapM);
    fogMask();
    drawCar(myE);

    // The readouts sit OVER the fade, on plates, so they never fade with it.
    if (active) drawGapChip();
    if (active && !gateDrawn && pose.gapM < 0) drawBehindChip();
    else if (nextBrake <= BRAKE_CUE_M) drawBrakeChip(nextBrake);
    return true;
  }

  /* --------------------------------- loop ---------------------------------- */

  var raf =
    typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : function (fn) {
          return window.setTimeout(fn, 16);
        };

  /** Make sure a paint is coming. Cheap to call on every frame. */
  function wake() {
    if (!rafId && gctx) rafId = raf(tick);
  }

  function tick() {
    rafId = 0;
    if (!cssW || !cssH || !shown()) return; // stopped; a frame, a resize or a show wakes it
    // performance.now(), not the rAF timestamp: samples are stamped on this
    // clock in `update`, and both must be one clock.
    var t0 = performance.now();
    var moving = false;
    try {
      moving = paint(t0);
    } catch (err) {
      // No silent failures — and a throwing paint must not spin the loop.
      console.error("[Apex] widget 'ghosthud' paint failed:", err);
    }
    if (noteWork) noteWork("ghosthud", performance.now() - t0);
    if (moving) wake();
  }

  /* -------------------------------- update -------------------------------- */

  /**
   * Data intake only: file the pose, keep the circuit and line current, and
   * make sure a paint is coming. All drawing is in `tick`, at display rate.
   */
  function update(frame) {
    if (!gctx || !GEO || !POSE) return;
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) sizeCanvas();
    if (alphaTick++ % ALPHA_CHECK_FRAMES === 0) pollPanelAlpha();

    var player = frame && frame.player;
    var ghost = player ? player.ghost : null;
    ensureShape(frame ? frame.trackMap : null);
    ensureLine(ghost);

    if (headerMeta) {
      var label = ghost && ghost.sourceLabel ? ghost.sourceLabel : "—";
      if (label !== lastLabel) {
        headerMeta.textContent = label;
        lastLabel = label;
      }
    }

    ghostState = ghost || null;
    serverAtD = ghost && typeof ghost.atD === "number" ? ghost.atD : NaN;

    // A frame without a pose is NOT a reason to forget the last one: the
    // buffer holds it for POSE_HOLD_MS, so one missing frame never blanks the road.
    var me = playerCar(frame);
    var motion = player ? player.motion : null;
    if (me && typeof me.x === "number" && typeof me.z === "number" && motion && typeof motion.heading === "number") {
      var t = POSE.stamp(poseBuf, frame.timestamp, performance.now());
      POSE.push(poseBuf, t, me.x, me.z, motion.heading, ghost && ghost.active && isFinite(ghost.gapM) ? ghost.gapM : 0);
      seedFrac = typeof me.lapFraction === "number" ? me.lapFraction : NaN;
    }
    wake();
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
    // The legend, for a screen reader. Not a hover `title`: the in-game layer
    // is click-through, and in layout mode a paragraph popping up over the
    // widget being dragged is in the way.
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "The reference lap's racing line on the road ahead: green on the power, amber off it, red braking. " +
        "Red boards across the road: where it started braking. Cyan pins: where its line curved hardest " +
        "in each corner, not where the kerbs are. The purple gate: where it is now.",
    );
    wrap.appendChild(canvas);
    mount.appendChild(wrap);

    gctx = canvas.getContext("2d");
    if (!GEO || !POSE) {
      console.error("[Apex] Ghost HUD needs ghost-geom.js and ghost-pose.js loaded first");
      return;
    }
    var api = window.ApexOverlay;
    noteWork = api && typeof api.noteWidgetWork === "function" ? api.noteWidgetWork : null;
    readTokens();
    buildGradients();
    sizeCanvas();
    watchSize(canvas);
  }

  window.ApexOverlay.registerWidget("ghosthud", {
    // Every frame: `update` only files a sample, and dropping frames here is
    // exactly the stutter the render loop exists to remove.
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
