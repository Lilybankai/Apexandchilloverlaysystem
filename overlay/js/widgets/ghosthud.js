/**
 * ghosthud.js — Ghost HUD: a fast lap's racing line, on the road ahead of you.
 * -----------------------------------------------------------------------------
 * The road in front of the car, drawn from the learned circuit so it bends the
 * way the circuit bends, with a chosen lap's racing line painted on it — white
 * with a cyan glow, tinted red where that lap was braking. Glowing red boards
 * lie across the road where it started braking, purple pins (C1..Cn) stand
 * where its line turned hardest, a magenta arrow is where it is on the clock
 * right now, a green arrow is you, and the signed seconds sit in the corner.
 *
 * The training look (2026-10-08): no card. A soft dark vignette sits behind
 * the road and the whole picture fades out at every edge, so the widget has
 * no box to see against the sky or the cockpit.
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
 * the circuit `/trackmap.json`, and the ghost's line `/ghost.json` (fetched
 * once for every training widget by `training-ghost.js`) — all four
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
  var GHOST = window.ApexTrainingGhost;

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
  var GHOST_W = 0.2;
  /** …but never below this in PIXELS, or the far line breaks into dashes. */
  var GHOST_MIN_PX = 1.4;
  /** Extra half-width of the dark keyline, and the glow's blur radius / 2, pixels. */
  var KEYLINE_PX = 1.2;
  var GLOW_PX = 5;
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

  /**
   * The ghost is a magenta arrow on its own line. It fades out as it closes in, fully drawn at GATE_FULL_M and
   * gone by GATE_GONE_M. Closer than that it stands on top of your own
   * chevron and hides the one thing you need to see — and the gap readout
   * already says "level" more precisely than a marker under the car could.
   */
  var GATE_FULL_M = 12;
  var GATE_GONE_M = 6;
  /** The ghost arrow's least on-screen length, px — found however far ahead. */
  var GHOST_ARROW_MIN_PX = 12;

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
    magenta: "#ec4899",
    fontDisplay: '"Bahnschrift", "Arial Narrow", "Segoe UI Semibold", sans-serif',
  };

  /**
   * Fixed paint, not themed — the training look (training.css): the road is a
   * faint white wash over a dark vignette, its edges thin white, the line
   * white with a cyan glow, the ghost magenta, you green.
   */
  var C_EDGE = "rgba(255,255,255,0.32)";
  var C_TICK = "rgba(255,255,255,0.07)";
  var C_INK = "rgba(4,6,12,0.55)";
  var C_INK_STRONG = "rgba(4,6,12,0.85)";
  var C_PLATE = "rgba(10,12,22,0.88)";
  var C_LINE = "#f4f6fb";
  /** The braking stretch of the line keeps a hint of red; everything else is white. */
  var C_LINE_BRAKE = "#ffc2cc";
  var C_LINE_GLOW = "rgba(34,211,238,0.85)";
  var C_PIN_LABEL = "#c4b5fd";
  var C_GHOST_LABEL = "#f9a8d4";
  var C_BRAKE_LABEL = "#ff8095";
  var C_BOARD_GLOW = "rgba(255,61,90,0.9)";
  var F_UI = '"Segoe UI", system-ui, sans-serif';
  /** The vignette's darkness at its centre, before --panel-alpha. */
  var VIGNETTE_ALPHA = 0.78;

  /** Derived from the tokens in `readTokens`; indexed by `GEO.pedalKind`. */
  var kindColour = ["", "", ""];
  var kindGlow = ["", "", ""];
  var brakeFill = "";
  var brakeEdge = "";
  var pinMast = "";
  var gatePost = "";
  var carGlow = "";

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

  /**
   * The ghost's lap, from `/ghost.json` through `training-ghost.js` — one
   * fetch shared with every other training widget on the page, with its
   * back-off for a lap the server has not published. A lap with no driven
   * line arrives without `x`/`z`; it is kept, and painted as a note.
   */
  var line = null;
  /**
   * The circuit that came back empty or failed (`key|revision`), and when it
   * may be asked for again; without this a circuit not learned yet was asked
   * for on every frame, into the server on Electron's main thread.
   */
  var MISS_RETRY_MS = 5000;
  var missShape = "";
  var missShapeUntil = 0;

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
  /** Each pin's corner name, "C1".."Cn" — strings made once per lap, not per paint. */
  var apexName = null;

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
  /**
   * What the last full paint drew from: the pose, the gap and `paintVer`.
   * The same again (a parked car) is not repainted. `ver: -1` = nothing
   * reusable on the canvas (a note is showing).
   */
  var drawn = { ver: -1, x: 0, z: 0, h: 0, gapM: 0, active: false, gap: NaN };

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
  var PA2 = { x: 0, z: 0, nx: 0, nz: 0, i: 0 };
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
  var gFog = null;
  /** The asphalt: a real-space gradient, rebuilt only when size or alpha moves. */
  var gRoad = null;
  var gRoadVer = -1;
  /**
   * The vignette: the widget has no card, so this soft dark pool behind the
   * road is what keeps it legible over a bright sky. A unit radial gradient,
   * squashed to an ellipse by the transform at fill time; rebuilt only when
   * the size or the operator's alpha moves.
   */
  var gVignette = null;
  var gVignetteVer = -1;

  function drawVignette() {
    if (!gVignette || gVignetteVer !== paintVer) {
      var a = VIGNETTE_ALPHA * panelAlpha;
      gVignette = gctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      gVignette.addColorStop(0, "rgba(10,12,22," + a + ")");
      gVignette.addColorStop(0.55, "rgba(10,12,22," + a * 0.72 + ")");
      gVignette.addColorStop(0.8, "rgba(10,12,22," + a * 0.3 + ")");
      gVignette.addColorStop(1, "rgba(10,12,22,0)");
      gVignetteVer = paintVer;
    }
    // Gone by every edge of the canvas, so the widget has no box to see.
    var rx = cssW * 0.5;
    var ry = cssH * 0.5;
    gctx.setTransform(dpr * rx, 0, 0, dpr * ry, dpr * cssW * 0.5, dpr * cssH * 0.52);
    gctx.fillStyle = gVignette;
    gctx.fillRect(-1, -1, 2, 2);
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function buildGradients() {
    gBlend = [];
    for (var a = 0; a < 3; a++) {
      for (var b = 0; b < 3; b++) {
        gBlend.push(unitGradient(kindColour[a], kindColour[b]));
      }
    }
    gFog = unitGradient("rgba(0,0,0,0)", "rgba(0,0,0,1)");
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
      C.magenta = pick("--ac-magenta", C.magenta);
      // Bahnschrift for every number, as on the training cards.
      C.fontDisplay = pick("--tw-num", pick("--font-display", C.fontDisplay));
    } catch (e) {
      /* no computed style here; the fallbacks stand */
    }
    // The reference line is white (the training look: the reference is
    // always white), its braking stretch tinted so where it brakes still reads.
    kindColour[GEO.PEDAL_THROTTLE] = C_LINE;
    kindColour[GEO.PEDAL_COAST] = C_LINE;
    kindColour[GEO.PEDAL_BRAKE] = C_LINE_BRAKE;
    kindGlow[GEO.PEDAL_THROTTLE] = C_LINE_GLOW;
    kindGlow[GEO.PEDAL_COAST] = C_LINE_GLOW;
    kindGlow[GEO.PEDAL_BRAKE] = withAlpha(C.brake, 0.8, "#ff5470");
    brakeFill = withAlpha(C.brake, 0.3, "#ff5470");
    brakeEdge = withAlpha(C.brake, 1, "#ff5470");
    pinMast = withAlpha(C.purple, 0.8, "#8b5cf6");
    gatePost = withAlpha(C.magenta, 0.9, "#ec4899");
    carGlow = withAlpha(C.gain, 0.85, "#35d07f");
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
    var wantKey = map.key;
    var wantRev = map.revision;
    var want = wantKey + "|" + wantRev;
    if (want === missShape && Date.now() < missShapeUntil) return;
    shapeFetching = true;
    function miss() {
      shapeFetching = false;
      missShape = want;
      missShapeUntil = Date.now() + MISS_RETRY_MS;
    }
    fetch("/trackmap.json", { cache: "no-store" })
      .then(function (r) {
        if (r.status === 204) return null;
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.points || data.points.length < 8) return miss();
        shapeFetching = false;
        haveKey = wantKey;
        haveRevision = wantRev;
        setShape(data);
      })
      .catch(miss);
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
    // The expensive half, once per lap selection (~5 ms for a 4 km lap). A lap
    // with no driven line prepares nothing, and `paint` says so.
    var drawable = !!(data && data.x && data.z);
    prep = drawable ? GEO.prepareLine(data, STEP_M, SMOOTH_SIGMA_M, data.trackLengthM || lapM) : null;
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
    var an = [];
    for (var c = 0; c < corners.length; c++) {
      var k = corners[c];
      if (!k || !isFinite(k.apexD) || !isFinite(k.apexX) || !isFinite(k.apexZ)) continue;
      am.push(wrapLap(k.apexD * lapM));
      ax.push(k.apexX);
      az.push(k.apexZ);
      // "C5": the reference's own corner order — the same numbering the
      // Corner card and Lap strip use (training-laps.js cornerName).
      an.push("C" + (c + 1));
    }
    apexM = Float64Array.from(am);
    apexX = Float64Array.from(ax);
    apexZ = Float64Array.from(az);
    apexName = an;
  }

  /* -------------------------------- sizing -------------------------------- */

  var fontValue = "";
  var fontLabel = "";
  var fontNote = "";
  /** Marks on the road: apex names, the ghost's gap. Bahnschrift. */
  var fontMark = "";
  var valuePx = 18;
  var labelPx = 11;

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
    valuePx = Math.max(16, Math.round(cssW * 0.034));
    fontValue = "600 " + valuePx + "px " + C.fontDisplay;
    // Labels in the training cards' small caps: Segoe UI 600, tracked out.
    labelPx = Math.max(10, Math.round(cssW * 0.0185));
    fontLabel = "600 " + labelPx + "px " + F_UI;
    fontNote = "600 " + Math.max(11, Math.round(cssW * 0.02)) + "px " + F_UI;
    fontMark = "600 " + Math.max(11, Math.round(cssW * 0.022)) + "px " + C.fontDisplay;
    gVignette = null;
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
   * Whether the training window is on screen, as main last said over the
   * bridge (`training:shown`). The document cannot tell: with background
   * throttling off it stays "visible" after the window is hidden, and the
   * loop would paint a hidden window at display rate. True wherever nobody
   * says otherwise — an OBS source has no bridge.
   */
  var layerShown = true;

  function watchLayer() {
    var bridge = window.apexIngame;
    if (!bridge || typeof bridge.onTrainingShown !== "function") return;
    bridge.onTrainingShown(function (on) {
      layerShown = on;
      if (on) wake();
    });
  }

  /**
   * Whether painting can be seen at all. A widget switched off is
   * `display:none` (zero width), a minimised layer is a hidden document, a
   * hidden training window says so over the bridge, and an OBS source
   * auto-hidden off-track fades the whole page out.
   */
  function shown() {
    if (!layerShown || document.hidden || boxW === 0) return false;
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
      // Dark enough to hold the line on a bright frame, with a faint white
      // wash that is lighter near the car and dies toward the horizon — the
      // road reads as a surface, not a hole. Through --panel-alpha like every
      // other widget surface.
      gRoad = gctx.createLinearGradient(0, cssH, 0, horizonY);
      gRoad.addColorStop(0, "rgba(44,49,66," + 0.82 * panelAlpha + ")");
      gRoad.addColorStop(0.55, "rgba(28,32,46," + 0.72 * panelAlpha + ")");
      gRoad.addColorStop(1, "rgba(18,21,32," + 0.6 * panelAlpha + ")");
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
      // The near edge is the line itself: drawn hard, like a painted board,
      // and lit — a red bar with a glow, the thing the eye is sent to. The
      // glow is a canvas shadow: a handful of boards in view, never more.
      gctx.lineCap = "round";
      gctx.strokeStyle = brakeEdge;
      gctx.lineWidth = Math.max(2, Math.min(5, Math.abs(Q1.y - Q4.y) * 1.4));
      gctx.shadowColor = C_BOARD_GLOW;
      gctx.shadowBlur = 12;
      gctx.beginPath();
      gctx.moveTo(Q1.x, Q1.y);
      gctx.lineTo(Q2.x, Q2.y);
      gctx.stroke();
      gctx.shadowBlur = 0;
      gctx.shadowColor = "transparent";
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
    // The opaque core overlaps its neighbours by a vertex, so no seam of the
    // keyline shows through between pieces. Its glow is a real blur (a canvas
    // shadow in the stretch's own glow colour — cyan, red where it brakes),
    // not a widened band: a band reads as an outline, not light.
    gctx.shadowBlur = GLOW_PX * 2;
    paintPieces(s, e, nt, 0, kindColour, gBlend, 1, kindGlow);
    gctx.shadowBlur = 0;
    gctx.shadowColor = "transparent";
  }

  /**
   * Paint a span as solid pieces between blends, then the blends. With
   * `glow`, each piece's shadow takes its pedal state's glow colour.
   */
  function paintPieces(s, e, nt, widen, solid, blend, overlap, glow) {
    var from = s;
    for (var j = 0; j <= nt; j++) {
      var to = j < nt ? trLo[j] : e;
      if (to > from) {
        stripPath(Math.max(s, from - overlap), Math.min(e, to + overlap), widen);
        if (glow) gctx.shadowColor = glow[rbKind[from]];
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
      if (glow) gctx.shadowColor = glow[kb];
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
      // Over a crest a far pin can stand up into the title and chips; there
      // it says less than the words it would cover.
      if (Q2.y < CHIP_INSET + valuePx * 2) continue;
      // Full strength within 90 m, dimming to a third at the end of the view.
      gctx.globalAlpha = ahead < 90 ? 1 : 1 - (0.65 * (ahead - 90)) / (VIEW_AHEAD_M - 90);
      var r = Math.max(3, Math.min(6.5, h * 0.26));
      gctx.strokeStyle = pinMast;
      gctx.lineWidth = 1.25;
      gctx.beginPath();
      gctx.moveTo(Q1.x, Q1.y);
      gctx.lineTo(Q2.x, Q2.y + r);
      gctx.stroke();
      // A purple dot in a white ring, on a soft purple halo.
      gctx.fillStyle = withAlpha(C.purple, 0.25, "#8b5cf6");
      gctx.beginPath();
      gctx.arc(Q2.x, Q2.y, r * 2, 0, Math.PI * 2);
      gctx.fill();
      gctx.beginPath();
      gctx.arc(Q2.x, Q2.y, r, 0, Math.PI * 2);
      gctx.fillStyle = C.purple;
      gctx.fill();
      gctx.strokeStyle = C.text;
      gctx.lineWidth = Math.max(1.25, r * 0.36);
      gctx.stroke();
      // Its name, beside it — only while it is near enough to be worth reading.
      if (apexName && ahead < VIEW_AHEAD_M * 0.75) {
        gctx.font = fontMark;
        gctx.textAlign = "left";
        gctx.textBaseline = "middle";
        gctx.fillStyle = C_INK_STRONG;
        gctx.fillText(apexName[i], Q2.x + r * 2.2 + 1, Q2.y + 1);
        gctx.fillStyle = C_PIN_LABEL;
        gctx.fillText(apexName[i], Q2.x + r * 2.2, Q2.y);
      }
    }
    gctx.globalAlpha = 1;
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
    ghostMark.on = false;
    if (!(gapM > GATE_GONE_M)) return false;
    var fade = Math.min(1, (gapM - GATE_GONE_M) / (GATE_FULL_M - GATE_GONE_M));
    var gm = at + gapM;
    GEO.preparedAt(prep, wrapLap(gm) / lapM, PA);
    var gx = PA.x;
    var gz = PA.z;
    // Its direction along its own line, from a metre and a half further on.
    GEO.preparedAt(prep, wrapLap(gm + 1.5) / lapM, PA2);
    var tx = PA2.x - gx;
    var tz = PA2.z - gz;
    var tl = Math.hypot(tx, tz);
    if (!(tl > 1e-3)) return false;
    tx /= tl;
    tz /= tl;
    var e = GEO.roadElevationAt(shape, gm);
    // Life size where it is close; never smaller than GHOST_ARROW_MIN_PX tall
    // on screen, or far up the road it shrinks to a speck.
    var k = 1.15;
    if (toScreen(gx, gz, e, Q1) && toScreen(gx + tx * 2.6 * k, gz + tz * 2.6 * k, e, Q2)) {
      var len = Math.hypot(Q2.x - Q1.x, Q2.y - Q1.y);
      if (len > 0.1 && len < GHOST_ARROW_MIN_PX) k *= Math.min(4, GHOST_ARROW_MIN_PX / len);
    }
    gctx.globalAlpha = fade;
    var drawnOk = drawChevron(gx, gz, tx, tz, e + 0.06, k, C.magenta, gatePost, "#fbcfe8");
    gctx.globalAlpha = 1;
    if (!drawnOk) return false;
    // Where its gap goes: beside the arrow, written after the fade so it
    // never fades with the road.
    ghostMark.on = true;
    ghostMark.x = chevLeftX;
    ghostMark.y = chevMidY;
    ghostMark.alpha = fade;
    return true;
  }

  /** The ghost arrow's last screen position, for its gap label. */
  var ghostMark = { on: false, x: 0, y: 0, alpha: 1 };
  /** Set by drawChevron: the arrow's left extreme and vertical middle on screen. */
  var chevLeftX = 0;
  var chevMidY = 0;

  /**
   * An arrow lying on the road at (px, pz) pointing along unit (s, c) — `s`
   * the world-x and `c` the world-z component of forward. Filled `fill`, with
   * a soft glow of `glow` and a fine `edge` outline.
   */
  function drawChevron(px, pz, s, c, e, size, fill, glow, edge) {
    var k = size || 1;
    var ok =
      toScreen(px + s * 2.6 * k, pz + c * 2.6 * k, e, Q1) && // tip
      toScreen(px + (c * 0.85 - s * 0.6) * k, pz + (-s * 0.85 - c * 0.6) * k, e, Q2) && // right
      toScreen(px + s * 0.3 * k, pz + c * 0.3 * k, e, Q3) && // notch
      toScreen(px + (-c * 0.85 - s * 0.6) * k, pz + (s * 0.85 - c * 0.6) * k, e, Q4); // left
    if (!ok) return false;
    quad(Q1, Q2, Q3, Q4);
    gctx.lineJoin = "round";
    gctx.shadowColor = glow;
    gctx.shadowBlur = 14;
    gctx.fillStyle = fill;
    gctx.fill();
    gctx.shadowBlur = 0;
    gctx.shadowColor = "transparent";
    gctx.strokeStyle = edge;
    gctx.lineWidth = 1.25;
    gctx.stroke();
    chevLeftX = Math.min(Q1.x, Q2.x, Q3.x, Q4.x);
    chevMidY = (Math.min(Q1.y, Q2.y, Q4.y) + Math.max(Q1.y, Q2.y, Q4.y)) / 2;
    return true;
  }

  /** The ghost's gap beside its arrow: "+0.42", in light magenta. */
  function drawGhostGap() {
    if (!ghostMark.on || !ghostState || !ghostState.active) return;
    if (chipGap.value === "") return;
    gctx.globalAlpha = ghostMark.alpha;
    gctx.font = fontMark;
    gctx.textAlign = "right";
    gctx.textBaseline = "middle";
    gctx.fillStyle = C_INK_STRONG;
    gctx.fillText(chipGap.value, ghostMark.x - 7, ghostMark.y + 1);
    gctx.fillStyle = C_GHOST_LABEL;
    gctx.fillText(chipGap.value, ghostMark.x - 8, ghostMark.y);
    gctx.globalAlpha = 1;
  }

  /** Fade everything drawn so far into the horizon. One composite op. */
  function fogMask() {
    gctx.beginPath();
    gctx.rect(0, 0, cssW, cssH);
    gctx.globalCompositeOperation = "destination-in";
    fillAlong(gFog, 0, topY, 0, topY + cssH * 0.14, "#000");
    // …and out at the foot too: the widget has no card, so the road must not
    // end on the canvas's bottom edge as a hard cut.
    gctx.beginPath();
    gctx.rect(0, 0, cssW, cssH);
    fillAlong(gFog, 0, cssH, 0, cssH * (1 - BOTTOM_FADE), "#000");
    // …and at the sides, where a wide road runs off the canvas. Each over the
    // WHOLE canvas: destination-in clears everything outside the filled path,
    // and the gradient pads to opaque past its end.
    var side = cssW * SIDE_FADE;
    gctx.beginPath();
    gctx.rect(0, 0, cssW, cssH);
    fillAlong(gFog, 0, 0, side, 0, "#000");
    gctx.beginPath();
    gctx.rect(0, 0, cssW, cssH);
    fillAlong(gFog, cssW, 0, cssW - side, 0, "#000");
    gctx.globalCompositeOperation = "source-over";
  }

  /** The shares of the height and width the road fades out over at the bottom and sides. */
  var BOTTOM_FADE = 0.12;
  var SIDE_FADE = 0.08;

  /** You: a green arrow lying on the road at the car, along its heading, glowing. */
  function drawCar(e) {
    var h = (pose.h * Math.PI) / 180;
    // Car-local (lat right, lon ahead) to world: forward is (sin h, cos h).
    drawChevron(pose.x, pose.z, Math.sin(h), Math.cos(h), e + 0.05, 1, C.gain, carGlow, C_INK_STRONG);
  }

  /* --------------------------------- chips --------------------------------- */

  /**
   * A readout chip: dark plate, colour rail, label, value. Text is measured
   * only when it changes — `measureText` returns a fresh object every call.
   */
  function makeChip() {
    return { label: "", value: "", key: NaN, tint: "", labelColour: "", valueColour: "", lw: -1, vw: -1, ver: -1 };
  }
  var chipGap = makeChip();
  var chipCue = makeChip();

  /**
   * @param {string} tint - "r,g,b" of the pill's tint and edge, as `.tw-chip`
   *   does for loss/gain; "" for a neutral pill.
   */
  function setChip(ch, label, value, tint, labelColour, valueColour) {
    if (label !== ch.label) {
      ch.label = label;
      ch.lw = -1;
    }
    if (value !== ch.value) {
      ch.value = value;
      ch.vw = -1;
    }
    ch.tint = tint;
    ch.labelColour = labelColour;
    ch.valueColour = valueColour;
  }

  /** Small caps, tracked out — the canvas has letterSpacing in Chromium 99+. */
  function setTracking(px) {
    if ("letterSpacing" in gctx) gctx.letterSpacing = px + "px";
  }

  /**
   * A readout pill — the training cards' `.tw-chip`: a dark plate (it has to
   * hold over the game, not over a card), the tone's tint and edge on top,
   * a small-caps label and the value in Bahnschrift.
   */
  function drawChip(ch, x, y, alignRight) {
    if (ch.ver !== paintVer) {
      ch.lw = ch.vw = -1;
      ch.ver = paintVer;
    }
    var track = Math.max(1, Math.round(labelPx * 0.16));
    if (ch.lw < 0) {
      gctx.font = fontLabel;
      setTracking(track);
      ch.lw = ch.label ? gctx.measureText(ch.label).width + Math.round(labelPx * 0.7) : 0;
      setTracking(0);
    }
    if (ch.vw < 0) {
      gctx.font = fontValue;
      ch.vw = gctx.measureText(ch.value).width;
    }
    var padX = Math.round(valuePx * 0.55);
    var w = padX * 2 + ch.lw + ch.vw;
    var h = Math.round(valuePx * 1.75);
    var left = alignRight ? x - w : x;
    var r = Math.round(h * 0.3);
    roundRect(left, y, w, h, r);
    gctx.fillStyle = C_PLATE;
    gctx.fill();
    if (ch.tint) {
      gctx.fillStyle = "rgba(" + ch.tint + ",0.15)";
      gctx.fill();
      gctx.strokeStyle = "rgba(" + ch.tint + ",0.45)";
    } else {
      gctx.strokeStyle = "rgba(255,255,255,0.12)";
    }
    gctx.lineWidth = 1;
    roundRect(left + 0.5, y + 0.5, w - 1, h - 1, r);
    gctx.stroke();
    gctx.textBaseline = "middle";
    gctx.textAlign = "left";
    if (ch.label) {
      gctx.font = fontLabel;
      setTracking(track);
      gctx.fillStyle = ch.labelColour;
      gctx.fillText(ch.label, left + padX, y + h / 2 + 1);
      setTracking(0);
    }
    gctx.font = fontValue;
    gctx.fillStyle = ch.valueColour;
    gctx.fillText(ch.value, left + padX + ch.lw, y + h / 2 + 1);
  }

  /** "r,g,b" of a delta's tone, for a pill's tint; "" when level. */
  function deltaTint(gapSec) {
    if (Math.abs(gapSec) <= LEVEL_SEC) return "";
    return gapSec > 0 ? "255,84,112" : "53,208,127";
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
      setChip(chipGap, "GAP", fmtDelta(g), deltaTint(g), C.text2, deltaColour(g));
    }
    drawChip(chipGap, CHIP_INSET, CHIP_INSET, false);
  }

  /** "BRK 63 m" — the metres rebuilt only when they change. */
  function drawBrakeChip(aheadM) {
    var m = Math.round(aheadM);
    if (chipCue.label !== "BRK" || m !== chipCue.key) {
      chipCue.key = m;
      setChip(chipCue, "BRK", m + " m", "255,84,112", C_BRAKE_LABEL, C.text);
    }
    drawChip(chipCue, cssW - CHIP_INSET, CHIP_INSET, true);
  }

  function drawBehindChip() {
    if (chipCue.label !== "GHOST") {
      chipCue.key = NaN;
      setChip(chipCue, "GHOST", "behind", "236,72,153", C_GHOST_LABEL, C.text2);
    }
    drawChip(chipCue, cssW - CHIP_INSET, CHIP_INSET, true);
  }

  /** The chips' inset from the canvas corners, px. */
  var CHIP_INSET = 12;

  /**
   * "RACING LINE · C6" — small caps, centred at the top: the corner the car
   * is in or coming to, in the reference's own C1..Cn numbering (never an
   * official name). The string is rebuilt only when the corner changes.
   */
  var titleIdx = -2;
  var titleText = "RACING LINE";
  function drawTitle() {
    var c = ghostState && ghostState.corner;
    var idx = c && isFinite(c.index) ? c.index : -1;
    if (idx !== titleIdx) {
      titleIdx = idx;
      titleText = idx >= 0 ? "RACING LINE · C" + (idx + 1) : "RACING LINE";
    }
    gctx.font = fontLabel;
    setTracking(Math.max(1, Math.round(labelPx * 0.18)));
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    var y = CHIP_INSET + Math.round(valuePx * 0.875);
    gctx.fillStyle = C_INK_STRONG;
    gctx.fillText(titleText, cssW / 2, y + 1);
    gctx.fillStyle = C.text2;
    gctx.fillText(titleText, cssW / 2, y);
    setTracking(0);
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
    drawn.ver = -1;
    var withGap = !!(ghostState && ghostState.active);
    var gapKey = withGap ? Math.round(ghostState.gapSec * 100) : NaN;
    if (note === shownNote && same(gapKey, shownNoteGap) && shownNoteVer === paintVer) return false;
    shownNote = note;
    shownNoteGap = gapKey;
    shownNoteVer = paintVer;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);
    // The vignette alone, faint, so the note has something to sit on and the
    // widget does not vanish into the scenery while it waits.
    gctx.globalAlpha = 0.6;
    drawVignette();
    gctx.globalAlpha = 1;
    gctx.font = fontNote;
    setTracking(Math.max(1, Math.round(labelPx * 0.18)));
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    gctx.fillStyle = C.muted;
    gctx.fillText(note, cssW / 2, cssH / 2);
    setTracking(0);
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
    // Parked in the pits, or anything else where nothing drawn would move:
    // the canvas already shows this picture. Stop the loop instead of
    // painting it again; the next frame wakes it.
    var gapKey = ghostState.active ? Math.round(ghostState.gapSec * 100) : NaN;
    if (
      drawn.ver === paintVer &&
      pose.x === drawn.x &&
      pose.z === drawn.z &&
      pose.h === drawn.h &&
      pose.gapM === drawn.gapM &&
      !!ghostState.active === drawn.active &&
      same(gapKey, drawn.gap)
    ) {
      return false;
    }
    var at = locate(pose.x, pose.z);
    if (at < 0) return paintNote(NOTE_OFF);
    myM = at;
    shownNote = null;

    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);
    var myE = setCamera(at);
    noteTrail(pose.x, pose.z, myE);

    drawVignette();
    if (!drawRoad(at)) {
      shownNote = null; // the canvas was just cleared, so the note must be drawn
      return paintNote(NOTE_OFF);
    }
    drawTicks(at);
    var nextBrake = drawBrakeBoards(at);
    drawTrail();
    drawGhostLine(buildRibbon(at));
    var active = !!ghostState.active;
    fogMask();
    // Pins and the ghost after the fade: far up the road they must still be
    // found (the pins dim with distance themselves).
    drawApexPins(at);
    var gateDrawn = active && drawGate(at, pose.gapM);
    drawCar(myE);

    // The readouts sit OVER the fade, on plates, so they never fade with it.
    drawTitle();
    if (active) drawGapChip();
    if (gateDrawn) drawGhostGap();
    if (active && !gateDrawn && pose.gapM < 0) drawBehindChip();
    else if (nextBrake <= BRAKE_CUE_M) drawBrakeChip(nextBrake);

    drawn.ver = paintVer;
    drawn.x = pose.x;
    drawn.z = pose.z;
    drawn.h = pose.h;
    drawn.gapM = pose.gapM;
    drawn.active = active;
    drawn.gap = gapKey;
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
    if (!gctx || !GEO || !POSE || !GHOST) return;
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) sizeCanvas();
    if (alphaTick++ % ALPHA_CHECK_FRAMES === 0) pollPanelAlpha();

    var player = frame && frame.player;
    var ghost = player ? player.ghost : null;
    ensureShape(frame ? frame.trackMap : null);
    GHOST.sync(ghost);

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
      "The reference lap's racing line on the road ahead, white, tinted red where it brakes. " +
        "Red boards across the road: where it started braking. Purple pins: where its line curved hardest " +
        "in each corner, not where the kerbs are. The pink arrow: where it is now; the green arrow is you.",
    );
    wrap.appendChild(canvas);
    mount.appendChild(wrap);

    gctx = canvas.getContext("2d");
    if (!GEO || !POSE || !GHOST) {
      console.error("[Apex] Ghost HUD needs ghost-geom.js, ghost-pose.js and training-ghost.js loaded first");
      return;
    }
    var api = window.ApexOverlay;
    noteWork = api && typeof api.noteWidgetWork === "function" ? api.noteWidgetWork : null;
    readTokens();
    buildGradients();
    sizeCanvas();
    watchSize(canvas);
    watchLayer();
    GHOST.subscribe(setLine);
  }

  window.ApexOverlay.registerWidget("ghosthud", {
    // Every frame: `update` only files a sample, and dropping frames here is
    // exactly the stutter the render loop exists to remove.
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
