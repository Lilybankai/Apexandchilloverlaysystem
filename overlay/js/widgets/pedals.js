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
  var head = 0;
  var count = 0;

  var canvas, gctx, dpr = 1;
  var fillThrottle, fillBrake, fillClutch;
  var valThrottle, valBrake, valClutch;
  var steerDot, headerGear;
  var cssW = 0, cssH = 0;
  var cache = {};

  function pushSample(t, b) {
    thr[head] = t;
    brk[head] = b;
    head = (head + 1) % CAP;
    if (count < CAP) count++;
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

    var wrap = document.createElement("div");
    wrap.className = "pedals__wrap";

    var trace = document.createElement("div");
    trace.className = "pedals__trace";
    canvas = document.createElement("canvas");
    trace.appendChild(canvas);

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

    // Steering readout.
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

    mount.appendChild(wrap);
    mount.appendChild(steer);

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

  function drawTrace() {
    if (!gctx || cssW === 0) { sizeCanvas(); if (cssW === 0) return; }
    gctx.clearRect(0, 0, cssW, cssH);
    // Brake under throttle so throttle line stays readable during overlap.
    drawArea(gctx, brk, "#ff5470", 0.18);
    drawArea(gctx, thr, "#35d07f", 0.16);
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

    // Trace history at full rate.
    pushSample(ped.throttle, ped.brake);
    drawTrace();

    // Live bars.
    var tp = setFill(fillThrottle, "thr", ped.throttle);
    var bp = setFill(fillBrake, "brk", ped.brake);
    var cp = setFill(fillClutch, "clu", ped.clutch);
    if (cache.thrv !== tp) { cache.thrv = tp; valThrottle.textContent = tp; }
    if (cache.brkv !== bp) { cache.brkv = bp; valBrake.textContent = bp; }
    if (cache.cluv !== cp) { cache.cluv = cp; valClutch.textContent = cp; }

    // Steering dot: -1..1 -> 0%..100% across the track.
    var steer = typeof ped.steer === "number" ? ped.steer : 0;
    if (steer < -1) steer = -1; else if (steer > 1) steer = 1;
    var leftPct = (0.5 + steer * 0.5) * 100;
    var leftRounded = Math.round(leftPct);
    if (cache.steer !== leftRounded) {
      cache.steer = leftRounded;
      steerDot.style.left = leftRounded + "%";
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
