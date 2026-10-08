/**
 * traininginputs.js — Telemetry: you against the reference lap, by the metre.
 * -----------------------------------------------------------------------------
 * Three panels on one road axis, 500 m behind the car to 400 m ahead, with
 * the car fixed on a glowing cyan cursor:
 *
 *   THROTTLE / BRAKE %  your throttle (green) and brake (red) as solid lines
 *   SPEED               your speed (cyan, a soft fill under it)
 *   GAP TO REF          the time gap, filled red above zero while you are
 *                       behind, green below while you are ahead
 *
 * The reference lap is a dotted white line in every panel, across the whole
 * window: behind the car it is what to compare with, ahead of it — where you
 * have not driven yet — it is a look-ahead at the next braking zone and
 * apex. Your lines stop at the cursor. Each corner in view is a translucent
 * purple band labelled C1..Cn (the reference's own corner order, never an
 * official name); the one being driven or coming next is the strongest.
 *
 * Why distance and not time: a time axis stretches every corner by how slowly
 * it is taken, so the same corner never sits in the same place twice and two
 * laps cannot be laid over each other. Metres can: the reference's brake
 * point is a place on the road, and on this axis it is a fixed mark.
 *
 * ## Painting
 * Ghost HUD's arrangement (`ghosthud.js`): `update` files the car's road
 * position as a timestamped sample in `ghost-pose.js`, a `requestAnimationFrame`
 * loop paints it interpolated 40 ms behind the newest, so the strip scrolls at
 * display rate rather than stepping at the feed rate. The loop stops when the
 * widget is hidden or the feed goes stale; the next frame wakes it.
 *
 * Distance is the server's filtered road position (`ghost.atD`) — the axis
 * the gap and the reference's own curve are on — unwrapped across the line
 * so the strip runs straight through it. Your inputs, speed and gap go into
 * one-metre bins and the reference is resampled onto the same grid once per
 * lap (`training-trace.js`), so painting is index arithmetic with nothing to
 * search and nothing to allocate.
 */
(function () {
  "use strict";

  var TR = window.ApexTrainingTrace;
  var POSE = window.ApexGhostPose;
  var LAPS = window.ApexTrainingLaps;
  var GHOST = window.ApexTrainingGhost;

  /* ------------------------------- framing -------------------------------- */

  /** Metres either side of the car. */
  var BEHIND_M = 500;
  var AHEAD_M = 400;
  var SPAN_M = BEHIND_M + AHEAD_M;

  /**
   * The design the geometry below is drawn in: a 790 × 358 canvas (an 830 px
   * card less its padding). Everything scales with the width; the height
   * follows it.
   */
  var DW = 790;
  var DH = 358;
  var ASPECT = DH / DW;
  /** Left gutter for tick labels, right margin. Design px. */
  var GUT_L = 48;
  var GUT_R = 6;
  /** Panels: top and height, design px. Titles sit just above each. */
  var P_PEDAL = { top: 26, h: 104 };
  var P_SPEED = { top: 172, h: 104 };
  /**
   * The gap strip: zero line and half-height. It plots the gap RELATIVE to
   * its value at the window's left edge — over 900 m the gap itself moves a
   * tenth or two on top of a second or more, and drawn absolute it is a flat
   * line. Relative, it shows where in view time was lost (above, red) or won
   * (below, green). The edge's absolute gap is printed as the zero tick and
   * the live one at the cursor, so the numbers stay whole. Its scale is the
   * largest change in view rounded up to GAP_STEP_S, never under GAP_MIN_S.
   */
  var GAP_Y = 322;
  var GAP_AMP = 14;
  var GAP_MIN_S = 0.1;
  var GAP_STEP_S = 0.05;
  var AXIS_Y = 350;
  /** Distance labels every this many lap metres. */
  var TICK_M = 200;

  /** See `ghost-pose.js`; the same values Ghost HUD paints with. */
  var POSE_DELAY_MS = 40;
  var POSE_MAX_EXTRAP_MS = 100;
  var POSE_HOLD_MS = 250;
  /** A backward step longer than this is a reset or a tow: the trail starts again. */
  var TRAIL_BACK_M = 50;
  var SIZE_CHECK_FRAMES = 30;
  var KPH_TO_MPH = 0.621371;

  /* -------------------------------- colour -------------------------------- */

  /** Theme tokens, read ONCE at init (a canvas cannot use `var(--…)`). */
  var C = {
    throttle: "#35d07f",
    brake: "#ff5470",
    gain: "#35d07f",
    loss: "#ff5470",
    cyan: "#22d3ee",
    purple: "#8b5cf6",
    text: "#f4f6fb",
    text2: "#aeb6c8",
    muted: "#6b7387",
    ref: "rgba(244,246,251,0.78)",
    num: '"Bahnschrift", "DIN Alternate", "Arial Narrow", sans-serif',
    ui: '"Segoe UI", system-ui, sans-serif',
  };
  var C_GRID = "rgba(255,255,255,0.06)";
  var C_AHEAD = "rgba(255,255,255,0.022)";
  var C_INK = "rgba(6,8,14,0.85)";

  /** Derived from the tokens once, in `readTokens`. */
  var gapLossFill = "";
  var gapGainFill = "";
  var bandNow = "";
  var bandOther = "";
  var labelBandOther = "";
  var cursorGlow = "";

  /* -------------------------------- state --------------------------------- */

  var canvas = null;
  var gctx = null;
  var headerMeta = null;
  var refNameEl = null;
  var cssW = 0;
  var cssH = 0;
  var dpr = 1;
  var boxW = -1;
  var sizeTick = 0;
  var noteWork = null;
  var paintVer = 0;
  var unitMph = false;

  /** The reference, prepared once per lap: grid, corner spans, speed axis. */
  var line = null;
  var lapM = 0;
  var grid = null;
  var hasSpeed = false;
  var cIn = null;
  var cOut = null;
  var cName = null;
  /** The speed axis, km/h: the drawn range and the three ticks. */
  var spdLo = 0;
  var spdHi = 300;
  var spdTicks = [0, 150, 300];
  var lastLabel = "";

  var ghostState = null;
  var unwrapper = TR ? TR.createUnwrap() : null;
  var trail = TR ? TR.createTrail(1024) : null;
  var lastUm = NaN;

  var poseBuf = POSE ? POSE.create({ delayMs: POSE_DELAY_MS, maxExtrapMs: POSE_MAX_EXTRAP_MS, holdMs: POSE_HOLD_MS }) : null;
  var pose = { x: 0, z: 0, h: 0, gapM: 0, ageMs: 0 };

  var rafId = 0;
  var shownNote = null;
  var shownNoteVer = -1;
  /**
   * What the last full paint drew from: the car's metre, the newest values
   * written to the trail, and `paintVer`. The same again (a parked car) is
   * not repainted. `ver: -1` = a note is showing.
   */
  var drawn = { ver: -1, m: NaN, thr: NaN, brk: NaN, spd: NaN, gap: NaN };

  /* ---------------------- per-paint scratch (no garbage) ------------------- */

  var N = SPAN_M + 2;
  var px = new Float32Array(N);
  var rThr = new Float32Array(N);
  var rBrk = new Float32Array(N);
  var rSpd = new Float32Array(N);
  var rOk = new Uint8Array(N);
  var mThr = new Float32Array(N);
  var mBrk = new Float32Array(N);
  var mSpd = new Float32Array(N);
  var mGap = new Float32Array(N);
  var mOk = new Uint8Array(N);

  /** Geometry in CSS px, set by `sizeCanvas`. */
  var k = 1;
  var xL = 0;
  var xR = 0;
  var xNow = 0;
  var pxPerM = 1;
  var pTop = 0;
  var pBot = 0;
  var sTop = 0;
  var sBot = 0;
  var gZero = 0;
  var gAmp = 0;
  var yAxis = 0;
  var fontTitle = "";
  var fontTick = "";
  var fontBand = "";
  var fontVal = "";
  var fontNote = "";
  var gSpeed = null;
  var gFade = null;
  var spacing = false;

  /** Tick label text, rebuilt only when the unit or the axis changes. */
  var tickText = ["", "", ""];
  var titleSpeed = "SPEED KM/H";
  /** The gap readout at the cursor, rebuilt only when its hundredths change. */
  var gapShown = NaN;
  var gapText = "";
  /** The change that fills the strip this paint, and the gap it is measured from, s. */
  var gapFull = GAP_MIN_S;
  var gapBase = NaN;
  var baseShown = NaN;
  var baseText = "0";

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
      C.gain = pick("--pos-gain", C.gain);
      C.loss = pick("--pos-loss", C.loss);
      C.cyan = pick("--ac-cyan", C.cyan);
      C.purple = pick("--ac-purple", C.purple);
      C.text = pick("--text-primary", C.text);
      C.text2 = pick("--text-secondary", C.text2);
      C.muted = pick("--text-muted", C.muted);
      C.ref = pick("--tw-ref", C.ref);
      C.num = pick("--tw-num", C.num);
      C.ui = pick("--tw-ui", C.ui);
    } catch (e) {
      /* no computed style here; the fallbacks stand */
    }
    gapLossFill = withAlpha(C.loss, 0.18, "#ff5470");
    gapGainFill = withAlpha(C.gain, 0.18, "#35d07f");
    bandNow = withAlpha(C.purple, 0.11, "#8b5cf6");
    bandOther = withAlpha(C.purple, 0.05, "#8b5cf6");
    labelBandOther = withAlpha(C.purple, 0.55, "#8b5cf6");
    cursorGlow = withAlpha(C.cyan, 0.22, "#22d3ee");
  }

  /** A `#rgb`/`#rrggbb` token at an alpha; any other form uses `fallbackHex`. */
  function withAlpha(colour, a, fallbackHex) {
    var h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colour) ? colour.slice(1) : fallbackHex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  /* --------------------------------- line --------------------------------- */

  /** The expensive half, once per lap selection: ~4 k metres resampled. */
  function setLine(data) {
    line = data;
    lapM = data && data.trackLengthM > 0 ? data.trackLengthM : 0;
    grid = data && lapM ? TR.resampleRef(data, lapM) : null;
    cIn = null;
    cOut = null;
    cName = null;
    hasSpeed = false;
    if (grid) {
      // The speed axis is the reference's own range, fixed for the lap, so
      // the ticks never wander while you drive.
      var lo = Infinity;
      var hi = -Infinity;
      for (var m = 0; m < grid.n; m++) {
        if (!grid.ok[m]) continue;
        var v = grid.spd[m];
        if (!isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi > lo) {
        hasSpeed = true;
        var range = hi - lo;
        spdLo = Math.max(0, lo - range * 0.14);
        spdHi = hi + range * 0.06;
        spdTicks = [lo, (lo + hi) / 2, hi];
      }
    }
    if (grid && Array.isArray(data.corners)) {
      var ins = [];
      var outs = [];
      var names = [];
      for (var i = 0; i < data.corners.length; i++) {
        var c = data.corners[i];
        if (!c || !isFinite(c.entryD) || !isFinite(c.exitD)) continue;
        var a = c.entryD * lapM;
        var b = c.exitD * lapM;
        if (b < a) b += lapM; // a corner over the line
        ins.push(a);
        outs.push(b);
        names.push(LAPS.cornerName(i));
      }
      cIn = Float64Array.from(ins);
      cOut = Float64Array.from(outs);
      cName = names;
    }
    retick();
    paintVer++;
    wake();
  }

  /** Speed tick labels and the panel title, in the driver's unit. */
  function retick() {
    var f = unitMph ? KPH_TO_MPH : 1;
    for (var i = 0; i < 3; i++) tickText[i] = String(Math.round(spdTicks[i] * f));
    titleSpeed = unitMph ? "SPEED MPH" : "SPEED KM/H";
  }

  /** "A. Winters · 1:19.299 · board" → "A. Winters". */
  function refName(label) {
    var s = String(label || "").split(" · ")[0].trim();
    if (!s) return "Reference";
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* -------------------------------- sizing -------------------------------- */

  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth;
    if (!w) return;
    var h = Math.round(w * ASPECT);
    var d = window.ApexRaster.backingScale(canvas);
    var bw = Math.round(w * d);
    var bh = Math.round(h * d);
    if (bw === canvas.width && bh === canvas.height && w === cssW) return;
    cssW = w;
    cssH = h;
    dpr = d;
    canvas.style.height = cssH + "px";
    var extra = canvas.offsetHeight - canvas.clientHeight;
    if (extra > 0) canvas.style.height = cssH + extra + "px";
    canvas.width = bw;
    canvas.height = bh;

    k = cssW / DW;
    xL = GUT_L * k;
    xR = cssW - GUT_R * k;
    pxPerM = (xR - xL) / SPAN_M;
    xNow = xL + BEHIND_M * pxPerM;
    pTop = P_PEDAL.top * k;
    pBot = (P_PEDAL.top + P_PEDAL.h) * k;
    sTop = P_SPEED.top * k;
    sBot = (P_SPEED.top + P_SPEED.h) * k;
    gZero = GAP_Y * k;
    gAmp = GAP_AMP * k;
    yAxis = AXIS_Y * k;
    fontTitle = "600 " + Math.max(9, Math.round(12 * k)) + "px " + C.ui;
    fontTick = Math.max(9, Math.round(13 * k)) + "px " + C.num;
    fontBand = "600 " + Math.max(9, Math.round(13 * k)) + "px " + C.num;
    fontVal = "600 " + Math.max(10, Math.round(15 * k)) + "px " + C.num;
    fontNote = "600 " + Math.max(11, Math.round(15 * k)) + "px " + C.ui;
    spacing = "letterSpacing" in gctx;

    // One gradient per size, never per paint.
    gSpeed = gctx.createLinearGradient(0, sTop, 0, sBot);
    gSpeed.addColorStop(0, withAlpha(C.cyan, 0.24, "#22d3ee"));
    gSpeed.addColorStop(1, withAlpha(C.cyan, 0, "#22d3ee"));
    gFade = gctx.createLinearGradient(cssW * 0.9, 0, cssW, 0);
    gFade.addColorStop(0, "rgba(0,0,0,0)");
    gFade.addColorStop(1, "rgba(0,0,0,1)");
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
   * bridge — Ghost HUD's rule and for its reason: a hidden window's document
   * still reads as visible with background throttling off. True with no
   * bridge (OBS).
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

  /** Hidden widget, hidden window, minimised layer, or an OBS source auto-hidden off-track. */
  function shown() {
    if (!layerShown || document.hidden || boxW === 0) return false;
    return document.documentElement.getAttribute("data-autohidden") !== "true";
  }

  /* ------------------------------- sampling ------------------------------- */

  /**
   * Fill the per-paint columns for the window starting at metre `m0`: the
   * reference across the whole window, yours up to the car.
   *
   * @returns {number} How many metre columns there are.
   */
  function sample(m0, nowM) {
    var first = Math.ceil(m0);
    var cnt = 0;
    for (var m = first; m <= m0 + SPAN_M && cnt < N; m++, cnt++) {
      px[cnt] = xL + (m - m0) * pxPerM;
      var gi = TR.lapIndex(m, grid.n);
      rOk[cnt] = grid.ok[gi];
      rThr[cnt] = grid.thr[gi];
      rBrk[cnt] = grid.brk[gi];
      rSpd[cnt] = grid.spd[gi];
      var s = m <= nowM ? TR.trailSlot(trail, m) : -1;
      mOk[cnt] = s >= 0 ? 1 : 0;
      if (s >= 0) {
        mThr[cnt] = trail.thr[s];
        mBrk[cnt] = trail.brk[s];
        mSpd[cnt] = trail.spd[s];
        mGap[cnt] = trail.gap[s];
      }
    }
    return cnt;
  }

  /* ------------------------------- painting ------------------------------- */

  function yPedal(v) {
    return pBot - (v < 0 ? 0 : v > 1 ? 1 : v) * (pBot - pTop);
  }
  function ySpeed(v) {
    var f = (v - spdLo) / (spdHi - spdLo);
    return sBot - (f < 0 ? 0 : f > 1 ? 1 : f) * (sBot - sTop);
  }
  function yGap(v) {
    var f = (v - gapBase) / gapFull;
    if (f > 1) f = 1;
    else if (f < -1) f = -1;
    return gZero - f * gAmp;
  }

  /**
   * Trace one channel as a path through the columns where it is valid,
   * broken where it is not. `kind`: 0 pedal, 1 speed, 2 gap. Leaves the path
   * open for the caller to stroke (or close and fill).
   */
  function tracePath(vals, ok, from, to, kind) {
    gctx.beginPath();
    var on = false;
    for (var i = from; i <= to; i++) {
      var v = vals[i];
      if (ok[i] !== 1 || v !== v) {
        on = false;
        continue;
      }
      var y = kind === 0 ? yPedal(v) : kind === 1 ? ySpeed(v) : yGap(v);
      if (!on) gctx.moveTo(px[i], y);
      else gctx.lineTo(px[i], y);
      on = true;
    }
  }

  /** The reference as a dotted white line. */
  function dotted(vals, from, to, kind) {
    tracePath(vals, rOk, from, to, kind);
    gctx.stroke();
  }

  /**
   * One filled area per run of valid columns, from `y0` out to the channel —
   * the speed fill under your line, and the gap strip either side of zero.
   */
  function fillArea(vals, from, to, kind, y0) {
    gctx.beginPath();
    var open = -1;
    for (var i = from; i <= to + 1; i++) {
      var good = i <= to && mOk[i] === 1 && vals[i] === vals[i];
      if (good && open < 0) {
        open = i;
        gctx.moveTo(px[i], y0);
      }
      if (good) gctx.lineTo(px[i], kind === 1 ? ySpeed(vals[i]) : yGap(vals[i]));
      if (!good && open >= 0) {
        gctx.lineTo(px[i - 1], y0);
        gctx.closePath();
        open = -1;
      }
    }
    gctx.fill();
  }

  function setSpacing(px) {
    if (spacing) gctx.letterSpacing = px + "px";
  }

  /** The gap at the window's left edge, as the strip's zero tick. */
  function gapBaseText() {
    if (gapBase !== gapBase) return "0";
    var g = Math.round(gapBase * 100) / 100;
    if (g !== baseShown) {
      baseShown = g;
      baseText = signed(g);
    }
    return baseText;
  }

  /** "+1.41", "−0.08", "±0.00". */
  function signed(g) {
    return (g > 0 ? "+" : g < 0 ? "−" : "±") + Math.abs(g).toFixed(2);
  }

  /** Grid rules, tick labels and the three panel titles. */
  function drawFrame() {
    gctx.fillStyle = C_GRID;
    var rules = [pTop, (pTop + pBot) / 2, pBot, ySpeed(spdTicks[0]), ySpeed(spdTicks[1]), ySpeed(spdTicks[2]), gZero];
    for (var i = 0; i < rules.length; i++) gctx.fillRect(xL, Math.round(rules[i]) - 0.5, xR - xL, 1);

    gctx.font = fontTick;
    gctx.textAlign = "right";
    gctx.textBaseline = "middle";
    gctx.fillStyle = C.muted;
    var tx = xL - 10 * k;
    gctx.fillText("100", tx, pTop);
    gctx.fillText("50", tx, (pTop + pBot) / 2);
    gctx.fillText("0", tx, pBot);
    if (hasSpeed) {
      for (var t = 0; t < 3; t++) gctx.fillText(tickText[t], tx, ySpeed(spdTicks[t]));
    }
    gctx.fillText(gapBaseText(), tx, gZero);

    gctx.font = fontTitle;
    gctx.textAlign = "left";
    gctx.textBaseline = "alphabetic";
    gctx.fillStyle = C.text2;
    setSpacing(1.7 * k);
    gctx.fillText("THROTTLE / BRAKE %", xL + 4 * k, pTop - 8 * k);
    if (hasSpeed) gctx.fillText(titleSpeed, xL + 4 * k, sTop - 8 * k);
    gctx.fillText("GAP TO REF", xL + 4 * k, gZero - gAmp - 6 * k);
    setSpacing(0);
  }

  /**
   * The corners in view as translucent purple bands across all three
   * panels, each named at the top of the speed panel. The one being driven,
   * or the next, is the strongest.
   */
  function drawCorners(m0, nowM) {
    if (!cIn || !cIn.length) return;
    var base = Math.floor(m0 / lapM) * lapM;
    // The corner being driven or coming next: the first whose exit is ahead.
    var nextIn = Infinity;
    for (var lap = 0; lap < 2; lap++) {
      for (var i = 0; i < cIn.length; i++) {
        var e = base + lap * lapM + cOut[i];
        if (e >= nowM && base + lap * lapM + cIn[i] < nextIn) nextIn = base + lap * lapM + cIn[i];
      }
    }
    gctx.font = fontBand;
    gctx.textAlign = "center";
    gctx.textBaseline = "alphabetic";
    setSpacing(1.5 * k);
    var top = pTop - 2 * k;
    var bot = gZero + gAmp + 2 * k;
    for (var l2 = 0; l2 < 2; l2++) {
      for (var j = 0; j < cIn.length; j++) {
        var a = base + l2 * lapM + cIn[j];
        var b = base + l2 * lapM + cOut[j];
        if (b < m0 || a > m0 + SPAN_M) continue;
        var x0 = Math.max(xL, xL + (a - m0) * pxPerM);
        var x1 = Math.min(xR, xL + (b - m0) * pxPerM);
        if (x1 <= x0) continue;
        var now = a === nextIn;
        gctx.fillStyle = now ? bandNow : bandOther;
        gctx.fillRect(x0, top, x1 - x0, bot - top);
        var xc = (x0 + x1) / 2;
        if (xc > xL + 14 * k && xc < xR - 14 * k) {
          gctx.fillStyle = now ? C.purple : labelBandOther;
          gctx.fillText(cName[j], xc, sTop - 8 * k);
        }
      }
    }
    setSpacing(0);
  }

  /** Lap metres along the bottom, every TICK_M. */
  function drawAxis(m0) {
    gctx.font = fontTick;
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    gctx.fillStyle = C.muted;
    var first = Math.ceil(m0 / TICK_M) * TICK_M;
    for (var m = first; m <= m0 + SPAN_M; m += TICK_M) {
      var x = xL + (m - m0) * pxPerM;
      if (x < xL + 20 * k || x > xR - 24 * k) continue;
      var lm = TR.lapIndex(m, lapM);
      // Near the line a 200 m step lands on a lap length that is not one.
      if (lm % TICK_M > 1 && TICK_M - (lm % TICK_M) > 1) continue;
      gctx.fillText(Math.round(lm) + " m", x, yAxis);
    }
  }

  /** The cursor: a glowing cyan line with dots on your current values. */
  function drawCursor(kNow, gapNow) {
    var top = pTop - 10 * k;
    var bot = gZero + gAmp + 8 * k;
    gctx.fillStyle = cursorGlow;
    gctx.fillRect(xNow - 3 * k, top, 6 * k, bot - top);
    gctx.fillStyle = C.cyan;
    gctx.fillRect(xNow - 1, top, 2, bot - top);
    var r = 5 * k;
    var dot = function (y, fill) {
      gctx.beginPath();
      gctx.arc(xNow, y, r, 0, Math.PI * 2);
      gctx.fillStyle = fill;
      gctx.fill();
      gctx.lineWidth = 2 * k;
      gctx.strokeStyle = C_INK;
      gctx.stroke();
    };
    if (mOk[kNow]) {
      var thr = mThr[kNow];
      var brk = mBrk[kNow];
      if (brk > 0.02) dot(yPedal(brk), C.brake);
      if (thr > 0.02 || brk <= 0.02) dot(yPedal(thr), C.throttle);
      if (hasSpeed && mSpd[kNow] === mSpd[kNow]) dot(ySpeed(mSpd[kNow]), C.cyan);
    }
    if (gapNow === gapNow) {
      var g = Math.round(gapNow * 100) / 100;
      if (g !== gapShown) {
        gapShown = g;
        gapText = signed(g);
      }
      gctx.font = fontVal;
      gctx.textAlign = "left";
      gctx.textBaseline = "middle";
      gctx.fillStyle = g > 0 ? C.loss : g < 0 ? C.gain : C.text;
      gctx.fillText(gapText, xNow + 9 * k, gZero - gAmp + 2 * k);
    }
  }

  /** The far end of the look-ahead fades out rather than stopping at a hard cut. */
  function fadeEdge() {
    gctx.globalCompositeOperation = "destination-out";
    gctx.fillStyle = gFade;
    gctx.fillRect(cssW * 0.9, 0, cssW * 0.1 + 1, yAxis - 10 * k);
    gctx.globalCompositeOperation = "source-over";
  }

  var NOTE_NO_GHOST = "NO GHOST LAP";
  var NOTE_NO_INPUTS = "THIS LAP HAS NO RECORDED INPUTS";
  var NOTE_WAITING = "WAITING FOR CAR POSITION";

  function paintNote(note) {
    drawn.ver = -1;
    if (note === shownNote && shownNoteVer === paintVer) return false;
    shownNote = note;
    shownNoteVer = paintVer;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);
    gctx.font = fontNote;
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    gctx.fillStyle = C.muted;
    setSpacing(1.6 * k);
    gctx.fillText(note, cssW / 2, cssH / 2);
    setSpacing(0);
    return false;
  }

  /** One display frame. True while there is motion to keep painting. */
  function paint(nowMs) {
    if (!ghostState) return paintNote(NOTE_NO_GHOST);
    if (!line) return paintNote(NOTE_NO_GHOST);
    if (!grid) return paintNote(NOTE_NO_INPUTS);
    var st = POSE.sample(poseBuf, nowMs, pose);
    if (st === POSE.NONE || st === POSE.STALE) return paintNote(NOTE_WAITING);
    // Parked: the same metre and the same values under the cursor draw the
    // same strip. Stop the loop instead of repainting it; a frame wakes it.
    if (
      drawn.ver === paintVer &&
      pose.x === drawn.m &&
      trail.lastThr === drawn.thr &&
      trail.lastBrk === drawn.brk &&
      (trail.lastSpd === drawn.spd || (trail.lastSpd !== trail.lastSpd && drawn.spd !== drawn.spd)) &&
      (trail.lastGap === drawn.gap || (trail.lastGap !== trail.lastGap && drawn.gap !== drawn.gap))
    ) {
      return false;
    }
    shownNote = null;

    var nowM = pose.x;
    var m0 = nowM - BEHIND_M;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);

    var cnt = sample(m0, nowM);
    var last = cnt - 1;
    // The last column at or behind the car.
    var kNow = Math.min(last, Math.max(0, Math.floor(nowM) - Math.ceil(m0)));
    gapBase = NaN;
    var gMax = 0;
    for (var gi = 0; gi <= kNow; gi++) {
      var gv = mGap[gi];
      if (mOk[gi] !== 1 || gv !== gv) continue;
      if (gapBase !== gapBase) gapBase = gv;
      if (Math.abs(gv - gapBase) > gMax) gMax = Math.abs(gv - gapBase);
    }
    gapFull = Math.max(GAP_MIN_S, Math.ceil(gMax / GAP_STEP_S) * GAP_STEP_S);

    // The look-ahead sits on a faintly lighter ground: "done" and "coming"
    // split before anything is read.
    gctx.fillStyle = C_AHEAD;
    gctx.fillRect(xNow, pTop - 2 * k, xR - xNow, gZero + gAmp - pTop + 4 * k);

    drawCorners(m0, nowM);
    drawFrame();

    gctx.lineJoin = "round";
    gctx.lineCap = "round";

    // The reference: dotted white, the whole window.
    gctx.setLineDash([0.5, 5 * k]);
    gctx.lineWidth = 2.4 * k;
    gctx.strokeStyle = C.ref;
    dotted(rThr, 0, last, 0);
    dotted(rBrk, 0, last, 0);
    if (hasSpeed) dotted(rSpd, 0, last, 1);
    gctx.setLineDash([]);

    // Yours: solid, up to the car.
    if (hasSpeed) {
      gctx.fillStyle = gSpeed;
      fillArea(mSpd, 0, kNow, 1, sBot);
      gctx.lineWidth = 3 * k;
      gctx.strokeStyle = C.cyan;
      tracePath(mSpd, mOk, 0, kNow, 1);
      gctx.stroke();
    }
    gctx.lineWidth = 3 * k;
    gctx.strokeStyle = C.throttle;
    tracePath(mThr, mOk, 0, kNow, 0);
    gctx.stroke();
    gctx.strokeStyle = C.brake;
    tracePath(mBrk, mOk, 0, kNow, 0);
    gctx.stroke();

    // The gap: red above zero (behind), green below (ahead), each clipped to
    // its own side so one path colours itself.
    gctx.save();
    gctx.beginPath();
    gctx.rect(xL, gZero - gAmp - 1, xR - xL, gAmp + 1);
    gctx.clip();
    gctx.fillStyle = gapLossFill;
    fillArea(mGap, 0, kNow, 2, gZero);
    gctx.lineWidth = 2 * k;
    gctx.strokeStyle = C.loss;
    tracePath(mGap, mOk, 0, kNow, 2);
    gctx.stroke();
    gctx.restore();
    gctx.save();
    gctx.beginPath();
    gctx.rect(xL, gZero, xR - xL, gAmp + 1);
    gctx.clip();
    gctx.fillStyle = gapGainFill;
    fillArea(mGap, 0, kNow, 2, gZero);
    gctx.lineWidth = 2 * k;
    gctx.strokeStyle = C.gain;
    tracePath(mGap, mOk, 0, kNow, 2);
    gctx.stroke();
    gctx.restore();

    fadeEdge();
    drawAxis(m0);
    drawCursor(kNow, trail.lastGap);

    drawn.ver = paintVer;
    drawn.m = nowM;
    drawn.thr = trail.lastThr;
    drawn.brk = trail.lastBrk;
    drawn.spd = trail.lastSpd;
    drawn.gap = trail.lastGap;
    return true;
  }

  /* --------------------------------- loop --------------------------------- */

  var raf =
    typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : function (fn) {
          return window.setTimeout(fn, 16);
        };

  function wake() {
    if (!rafId && gctx) rafId = raf(tick);
  }

  function tick() {
    rafId = 0;
    if (!cssW || !cssH || !shown()) return;
    // performance.now(), the clock the samples are stamped on in `update`.
    var t0 = performance.now();
    var moving = false;
    try {
      moving = paint(t0);
    } catch (err) {
      console.error("[Apex] widget 'traininginputs' paint failed:", err);
    }
    if (noteWork) noteWork("traininginputs", performance.now() - t0);
    if (moving) wake();
  }

  /* -------------------------------- update -------------------------------- */

  /** Data intake only: file the road position and inputs, keep the line current. */
  function update(frame) {
    if (!gctx || !TR || !POSE || !LAPS || !GHOST) return;
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) sizeCanvas();
    var player = frame && frame.player;
    var ghost = player ? player.ghost : null;
    GHOST.sync(ghost);
    ghostState = ghost || null;

    var label = ghost && ghost.sourceLabel ? ghost.sourceLabel : "";
    if (label !== lastLabel) {
      lastLabel = label;
      if (headerMeta) headerMeta.textContent = label || "—";
      if (refNameEl) refNameEl.textContent = refName(label);
    }

    var d = ghost && typeof ghost.atD === "number" ? ghost.atD : NaN;
    if (lapM > 0 && isFinite(d)) {
      var um = TR.unwrap(unwrapper, d) * lapM;
      if (isFinite(lastUm) && um < lastUm - TRAIL_BACK_M) TR.resetTrail(trail);
      lastUm = um;
      var p = player.pedals;
      if (p) {
        var kph = typeof player.speedKph === "number" && player.speedKph >= 0 ? player.speedKph : NaN;
        var gap = ghost.active && typeof ghost.gapSec === "number" ? ghost.gapSec : NaN;
        TR.writeTrail(trail, um, +p.throttle || 0, +p.brake || 0, +p.steer || 0, kph, gap);
      }
      var t = POSE.stamp(poseBuf, frame.timestamp, performance.now());
      POSE.push(poseBuf, t, um, 0, 0, 0);
    }
    wake();
  }

  /* --------------------------------- init --------------------------------- */

  function init(root) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML =
      '<div class="ttele">' +
      '<div class="ttele__top">' +
      '<span class="tw-label ttele__title">Telemetry</span>' +
      '<div class="ttele__legend">' +
      '<span class="ttele__key"><i class="ttele__swatch ttele__swatch--you"></i>You</span>' +
      '<span class="ttele__key"><i class="ttele__swatch ttele__swatch--ref"></i><b data-role="refname">Reference</b></span>' +
      "</div></div></div>";
    var wrap = mount.firstChild;
    refNameEl = wrap.querySelector('[data-role="refname"]');
    canvas = document.createElement("canvas");
    canvas.className = "ttele__canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "Throttle and brake, speed, and the time gap over the last 500 metres against the reference lap, " +
        "which is drawn dotted and carries on 400 metres ahead of the car. Corners are shaded purple.",
    );
    wrap.appendChild(canvas);
    gctx = canvas.getContext("2d");
    if (!TR || !POSE || !LAPS || !GHOST) {
      console.error("[Apex] Telemetry needs training-trace.js, training-laps.js, training-ghost.js and ghost-pose.js loaded first");
      return;
    }
    var api = window.ApexOverlay;
    noteWork = api && typeof api.noteWidgetWork === "function" ? api.noteWidgetWork : null;
    readTokens();
    var look = window.ApexAppearance;
    if (look && typeof look.onSpeedUnit === "function") {
      look.onSpeedUnit(function (u) {
        unitMph = u === "mph";
        retick();
        paintVer++;
        wake();
      });
    }
    sizeCanvas();
    watchSize(canvas);
    watchLayer();
    GHOST.subscribe(setLine);
  }

  window.ApexOverlay.registerWidget("traininginputs", {
    // Every frame: `update` only files a sample, and the interpolation needs
    // every one of them — see Ghost HUD, which is in the same position.
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
