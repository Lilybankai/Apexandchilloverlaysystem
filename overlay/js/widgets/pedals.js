/**
 * widgets/pedals.js — pedal inputs + rolling trail-brake trace (bottom-centre).
 * -----------------------------------------------------------------------------
 * The signature "trail-braking" widget. Renders `frame.player.pedals`
 * (throttle/brake/clutch/steer 0..1, steer -1..1) as:
 *   - a scrolling Canvas trace overlaying throttle (green) and brake (red) so
 *     you can read brake-release vs throttle-application overlap;
 *   - vertical bars for the live throttle/brake/clutch values;
 *   - a steering position dot.
 *
 * This widget runs at the full broadcast rate (throttleMs 0). The trace uses a
 * fixed-size ring buffer and redraws two short polylines per frame — cheap and
 * allocation-free in steady state.
 */
(function () {
  "use strict";

  var CAP = 300; // trace history length in samples (~10s @30Hz)
  var thr = new Float32Array(CAP);
  var brk = new Float32Array(CAP);
  // Steering history (-1..1), for the centre-anchored steering trace.
  var str = new Float32Array(CAP);
  // Driver-aid intervention per sample (what TC/ABS took off the pedal).
  var thrCut = new Float32Array(CAP);
  var brkCut = new Float32Array(CAP);
  var head = 0;
  var count = 0;

  /**
   * How the steering is drawn, from `?steer=` on the Browser Source URL:
   *   trace — a centre-anchored line through the pedal trace (default). The
   *           steering scrolls with the pedals on the same time axis, so a
   *           corner reads as one shape: brake, turn-in, unwind, throttle.
   *   dot   — the original left/right dot on a strip under the bars.
   *   off   — neither.
   * The line is the point of the change: a dot shows where the wheel is NOW but
   * carries no history, so you cannot see the turn-in rate or a correction.
   */
  var steerMode = "trace";
  /** Fraction of the canvas half-height a full lock deflects the trace. */
  var STEER_GAIN = 0.9;
  // Frames left to keep drawing the aid lines after the last intervention
  // (avoids per-frame full-ring scans just to know if anything is visible).
  var tcHot = 0;
  var absHot = 0;

  var canvas, gctx, dpr = 1;
  var fillThrottle, fillBrake, fillClutch;
  var valThrottle, valBrake, valClutch;
  var steerDot, headerGear;
  var chipTc, chipAbs;
  var cssW = 0, cssH = 0;
  var cache = {};

  function pushSample(t, b, s, tc, abs) {
    thr[head] = t;
    brk[head] = b;
    str[head] = s;
    thrCut[head] = tc;
    brkCut[head] = abs;
    head = (head + 1) % CAP;
    if (count < CAP) count++;
    if (tc > 0.02) tcHot = CAP; else if (tcHot > 0) tcHot--;
    if (abs > 0.02) absHot = CAP; else if (absHot > 0) absHot--;
  }

  function sizeCanvas() {
    if (!canvas) return;
    cssW = canvas.clientWidth || 260;
    cssH = canvas.clientHeight || 90;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function makeBar(parent, label, fillClass) {
    var bar = document.createElement("div");
    bar.className = "pedal-bar";
    var track = document.createElement("div");
    track.className = "pedal-bar__track";
    var fill = document.createElement("div");
    fill.className = "pedal-bar__fill " + fillClass;
    track.appendChild(fill);
    var lab = document.createElement("div");
    lab.className = "pedal-bar__label";
    lab.textContent = label;
    var val = document.createElement("div");
    val.className = "pedal-bar__val";
    val.textContent = "0";
    bar.appendChild(track);
    bar.appendChild(lab);
    bar.appendChild(val);
    parent.appendChild(bar);
    return { fill: fill, val: val };
  }

  function init(root, ctx) {
    headerGear = root.querySelector('[data-role="gear"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var params = new URLSearchParams(window.location.search);
    var sm = (params.get("steer") || "trace").toLowerCase();
    steerMode = sm === "dot" || sm === "off" ? sm : "trace";

    var wrap = document.createElement("div");
    wrap.className = "pedals__wrap";

    var trace = document.createElement("div");
    trace.className = "pedals__trace";
    canvas = document.createElement("canvas");
    trace.appendChild(canvas);

    // TC / ABS chips, lit while the aid is actively intervening.
    var aids = document.createElement("div");
    aids.className = "pedals__aids";
    chipTc = document.createElement("span");
    chipTc.className = "pedals__aid pedals__aid--tc";
    chipTc.textContent = "TC";
    chipAbs = document.createElement("span");
    chipAbs.className = "pedals__aid pedals__aid--abs";
    chipAbs.textContent = "ABS";
    aids.appendChild(chipTc);
    aids.appendChild(chipAbs);
    trace.appendChild(aids);

    var bars = document.createElement("div");
    bars.className = "pedals__bars";
    var t = makeBar(bars, "THR", "pedal-bar__fill--throttle");
    var b = makeBar(bars, "BRK", "pedal-bar__fill--brake");
    var c = makeBar(bars, "CLU", "pedal-bar__fill--clutch");
    fillThrottle = t.fill; valThrottle = t.val;
    fillBrake = b.fill; valBrake = b.val;
    fillClutch = c.fill; valClutch = c.val;

    wrap.appendChild(trace);
    wrap.appendChild(bars);

    mount.appendChild(wrap);

    // Legacy dot readout, only when explicitly asked for: the trace mode draws
    // the steering inside the canvas, so the strip would be redundant height.
    if (steerMode === "dot") {
      var steer = document.createElement("div");
      steer.className = "pedals__steer";
      var stLabel = document.createElement("span");
      stLabel.className = "pedal-bar__label";
      stLabel.textContent = "STEER";
      var stTrack = document.createElement("div");
      stTrack.className = "pedals__steer-track";
      steerDot = document.createElement("div");
      steerDot.className = "pedals__steer-dot";
      stTrack.appendChild(steerDot);
      steer.appendChild(stLabel);
      steer.appendChild(stTrack);
      mount.appendChild(steer);
    } else {
      steerDot = null;
    }

    gctx = canvas.getContext("2d");
    sizeCanvas();
    window.addEventListener("resize", sizeCanvas, { passive: true });
  }

  function drawArea(ctx2d, arr, color, alpha) {
    if (count < 2) return;
    var w = cssW;
    var h = cssH;
    var start = (head - count + CAP) % CAP;
    var stepX = w / (CAP - 1);
    // Filled area under the line.
    ctx2d.beginPath();
    ctx2d.moveTo(0, h);
    for (var i = 0; i < count; i++) {
      var idx = (start + i) % CAP;
      var v = arr[idx];
      if (v < 0) v = 0; else if (v > 1) v = 1;
      var x = i * stepX;
      var y = h - v * h;
      ctx2d.lineTo(x, y);
    }
    ctx2d.lineTo((count - 1) * stepX, h);
    ctx2d.closePath();
    ctx2d.globalAlpha = alpha;
    ctx2d.fillStyle = color;
    ctx2d.fill();
    // Solid line on top.
    ctx2d.globalAlpha = 1;
    ctx2d.beginPath();
    for (var j = 0; j < count; j++) {
      var idx2 = (start + j) % CAP;
      var v2 = arr[idx2];
      if (v2 < 0) v2 = 0; else if (v2 > 1) v2 = 1;
      var x2 = j * stepX;
      var y2 = h - v2 * h;
      if (j === 0) ctx2d.moveTo(x2, y2);
      else ctx2d.lineTo(x2, y2);
    }
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 1.5;
    ctx2d.stroke();
  }

  /**
   * Draws the post-aid ("what the car actually got") line in the aid colour,
   * only over the stretches where the aid was cutting — so TC/ABS activity
   * shows up as coloured notches under the pedal lines.
   */
  function drawAidLine(ctx2d, arr, cut, color) {
    if (count < 2) return;
    var start = (head - count + CAP) % CAP;
    var stepX = cssW / (CAP - 1);
    var open = false;
    ctx2d.beginPath();
    for (var i = 0; i < count; i++) {
      var idx = (start + i) % CAP;
      var c = cut[idx];
      if (c > 0.01) {
        var v = arr[idx] - c;
        if (v < 0) v = 0;
        var x = i * stepX;
        var y = cssH - v * cssH;
        if (open) ctx2d.lineTo(x, y);
        else { ctx2d.moveTo(x, y); open = true; }
      } else {
        open = false;
      }
    }
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 1.5;
    ctx2d.stroke();
  }

  /**
   * Centre-anchored steering trace: a line whose neutral is the canvas
   * mid-height, deflecting UP for right lock and DOWN for left.
   *
   * Reading it against the pedal areas underneath is the whole point — turn-in
   * while still on the brakes, and how much lock is still wound on when the
   * throttle comes back, are both single glances. A dashed centre line marks
   * straight-ahead so a small correction is still legible.
   */
  function drawSteerTrace(ctx2d) {
    if (count < 2) return;
    var mid = cssH / 2;
    var amp = mid * STEER_GAIN;
    var start = (head - count + CAP) % CAP;
    var stepX = cssW / (CAP - 1);

    // Centre reference.
    ctx2d.save();
    ctx2d.setLineDash([3, 4]);
    ctx2d.globalAlpha = 0.28;
    ctx2d.beginPath();
    ctx2d.moveTo(0, mid);
    ctx2d.lineTo(cssW, mid);
    ctx2d.strokeStyle = "#aeb6c8";
    ctx2d.lineWidth = 1;
    ctx2d.stroke();
    ctx2d.restore();

    ctx2d.beginPath();
    for (var i = 0; i < count; i++) {
      var v = str[(start + i) % CAP];
      if (v < -1) v = -1; else if (v > 1) v = 1;
      var x = i * stepX;
      var y = mid - v * amp;
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    // Pale blue-white, deliberately NOT the clutch blue (#4f8bff) — the clutch
    // bar sits inches away in the same widget and the two lines would read as
    // the same channel. Neutral also keeps it from competing with the
    // green/red/amber the pedals and aids already own.
    ctx2d.strokeStyle = "#dbe4ff";
    ctx2d.lineWidth = 1.75;
    ctx2d.stroke();
  }

  function drawTrace() {
    if (!gctx || cssW === 0) { sizeCanvas(); if (cssW === 0) return; }
    gctx.clearRect(0, 0, cssW, cssH);
    // Brake under throttle so throttle line stays readable during overlap.
    drawArea(gctx, brk, "#ff5470", 0.18);
    drawArea(gctx, thr, "#35d07f", 0.16);
    // Aid lines only while there's something to show in the window.
    if (absHot > 0) drawAidLine(gctx, brk, brkCut, "#ff9f1a");
    if (tcHot > 0) drawAidLine(gctx, thr, thrCut, "#ffd23e");
    // Steering on top: it is the thinnest line and must stay readable over the
    // filled pedal areas.
    if (steerMode === "trace") drawSteerTrace(gctx);
  }

  function setFill(el, cacheKey, value) {
    var p = value < 0 ? 0 : value > 1 ? 100 : value * 100;
    var rounded = Math.round(p);
    if (cache[cacheKey] === rounded) return rounded;
    cache[cacheKey] = rounded;
    el.style.height = rounded + "%";
    return rounded;
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var p = frame.player;
    if (!p || !p.pedals) return;
    var ped = p.pedals;
    var tc = typeof ped.tc === "number" ? ped.tc : 0;
    var abs = typeof ped.abs === "number" ? ped.abs : 0;

    var steer = typeof ped.steer === "number" ? ped.steer : 0;
    if (steer < -1) steer = -1; else if (steer > 1) steer = 1;

    // Trace history at full rate.
    pushSample(ped.throttle, ped.brake, steer, tc, abs);
    drawTrace();

    // Live bars.
    var tp = setFill(fillThrottle, "thr", ped.throttle);
    var bp = setFill(fillBrake, "brk", ped.brake);
    var cp = setFill(fillClutch, "clu", ped.clutch);
    if (cache.thrv !== tp) { cache.thrv = tp; valThrottle.textContent = tp; }
    if (cache.brkv !== bp) { cache.brkv = bp; valBrake.textContent = bp; }
    if (cache.cluv !== cp) { cache.cluv = cp; valClutch.textContent = cp; }

    // TC/ABS: recolour the affected bar and light the chip, with the chip's
    // brightness following intervention strength.
    var tcOn = tc > 0.02;
    var absOn = abs > 0.02;
    if (cache.tcOn !== tcOn) {
      cache.tcOn = tcOn;
      fillThrottle.setAttribute("data-aid", String(tcOn));
      chipTc.setAttribute("data-on", String(tcOn));
    }
    if (tcOn) chipTc.style.opacity = String(0.45 + 0.55 * Math.min(1, tc * 2.5));
    if (cache.absOn !== absOn) {
      cache.absOn = absOn;
      fillBrake.setAttribute("data-aid", String(absOn));
      chipAbs.setAttribute("data-on", String(absOn));
    }
    if (absOn) chipAbs.style.opacity = String(0.45 + 0.55 * Math.min(1, abs * 2.5));

    // Steering dot: -1..1 -> 0%..100% across the track. Only present in the
    // legacy `?steer=dot` mode; the trace mode draws it on the canvas instead.
    if (steerDot) {
      var leftRounded = Math.round((0.5 + steer * 0.5) * 100);
      if (cache.steer !== leftRounded) {
        cache.steer = leftRounded;
        steerDot.style.left = leftRounded + "%";
      }
    }

    // Header: gear + speed.
    if (headerGear) {
      var g = fmt.gearLabel(p.gear);
      var spd = fmt.has(p.speedKph) ? Math.round(p.speedKph) : "—";
      var text = g + " · " + spd + " kph";
      if (cache.gear !== text) { cache.gear = text; headerGear.textContent = text; }
    }
  }

  window.ApexOverlay.registerWidget("pedals", {
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
