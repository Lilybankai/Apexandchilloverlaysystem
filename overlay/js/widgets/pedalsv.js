/**
 * widgets/pedalsv.js — vertical inputs readout + steering-angle arc.
 * -----------------------------------------------------------------------------
 * An alternate take on `pedals`, which is left untouched. Where that widget
 * scrolls throttle/brake left-to-right on a time axis, this one is that widget
 * rotated a quarter turn: the pedals become full-width levels that RISE from
 * the bottom of the readout (bottom = 0%, top = 100%), so a stab of brake is a
 * vertical movement rather than a horizontal one.
 *
 * Losing the time axis costs the trail-braking overlap history, so the two
 * levels are drawn translucent and stacked in the same box — where they overlap
 * you are on both pedals, which is the reading the scrolling trace existed to
 * give. Anyone who wants the history still has the original widget.
 *
 * Steering stops being a line on a time axis and becomes what it physically is:
 * an ANGLE. The needle is pinned at the centre-bottom of the readout and only
 * its tip moves, sweeping an arc, so the wheel's position is read the same way
 * you read the wheel itself. A short fan of fading ghosts behind the needle
 * keeps the turn-in rate and correction legibility that the trace had — a bare
 * needle shows where the wheel IS and nothing about how it got there, which is
 * the exact failing that replaced the original steering dot.
 *
 * Runs at the full broadcast rate (throttleMs 0). Per frame it fills two rects,
 * strokes one arc and a handful of short lines — no allocation in steady state.
 */
(function () {
  "use strict";

  /** Steering history (-1..1) for the ghost fan. ~3s at 30 Hz. */
  var CAP = 90;
  var str = new Float32Array(CAP);
  var head = 0;
  var count = 0;

  /** Ghosts sampled every GHOST_STRIDE frames, GHOST_COUNT of them. */
  var GHOST_COUNT = 10;
  var GHOST_STRIDE = 3;

  /** Needle sweep at full lock, in radians from vertical. */
  var MAX_ANGLE = (70 * Math.PI) / 180;

  // Frames left to keep drawing the aid lines after the last intervention.
  var tcHot = 0;
  var absHot = 0;

  var canvas, gctx, dpr = 1;
  var fillThrottle, fillBrake, fillClutch;
  var valThrottle, valBrake, valClutch;
  var headerGear;
  var chipTc, chipAbs;
  var cssW = 0, cssH = 0;
  var cache = {};

  // Live values, kept out of the ring because only steering needs history.
  var curThr = 0, curBrk = 0, curTc = 0, curAbs = 0, curSteer = 0;

  function pushSteer(s) {
    str[head] = s;
    head = (head + 1) % CAP;
    if (count < CAP) count++;
  }

  /** Steering `back` samples ago (0 = newest), clamped to what we have. */
  function steerAt(back) {
    if (back >= count) back = count - 1;
    return str[(head - 1 - back + CAP * 2) % CAP];
  }

  /**
   * Matches the canvas BITMAP to the element's current CSS size.
   *
   * Has to track the element, not the window: the in-game layer lets the
   * operator drag a widget narrower without the window changing size, and a
   * stale bitmap is then scaled to fit by a different factor on each axis —
   * which is how a steering arc drawn as a true arc reaches the screen looking
   * flattened.
   *
   * Idempotent, so a ResizeObserver watching the element cannot feed itself.
   */
  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth || 260;
    var h = canvas.clientHeight || 140;
    var d = window.devicePixelRatio || 1;
    var bw = Math.round(w * d);
    var bh = Math.round(h * d);
    if (bw === canvas.width && bh === canvas.height && w === cssW && h === cssH) return;
    cssW = w;
    cssH = h;
    dpr = d;
    canvas.width = bw;
    canvas.height = bh;
    if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Frames since the canvas size was last re-checked. ResizeObserver does not
   * deliver while a page is not producing frames — a background tab, or an OBS
   * source that is not currently rendering — and a widget can be resized in
   * exactly that state, so the observer alone is not enough. Verified: an
   * observer attached to a hidden page's canvas never fired at all.
   */
  var sizeTick = 0;
  /** Frames between backstop size checks (~0.5 s at 30 Hz). */
  var SIZE_CHECK_FRAMES = 15;

  /**
   * Keeps the bitmap in step however the element is resized — in-game drag
   * handles, OBS source size, or the window. ResizeObserver covers all three
   * when the page is rendering; the window listener and the per-frame backstop
   * cover it when it is not.
   */
  function watchSize(el) {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () {
        sizeCanvas();
      }).observe(el);
    }
    window.addEventListener("resize", sizeCanvas, { passive: true });
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
    wrap.className = "pedalsv__wrap";

    var readout = document.createElement("div");
    readout.className = "pedalsv__readout";
    canvas = document.createElement("canvas");
    readout.appendChild(canvas);

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
    readout.appendChild(aids);

    // The bar column is deliberately identical to the original widget's, down
    // to the shared `.pedal-bar` classes: it is the same reading, and a second
    // dialect of it would only make the two widgets harder to swap between.
    var bars = document.createElement("div");
    bars.className = "pedals__bars";
    var t = makeBar(bars, "THR", "pedal-bar__fill--throttle");
    var b = makeBar(bars, "BRK", "pedal-bar__fill--brake");
    var c = makeBar(bars, "CLU", "pedal-bar__fill--clutch");
    fillThrottle = t.fill; valThrottle = t.val;
    fillBrake = b.fill; valBrake = b.val;
    fillClutch = c.fill; valClutch = c.val;

    wrap.appendChild(readout);
    wrap.appendChild(bars);
    mount.appendChild(wrap);

    gctx = canvas.getContext("2d");
    sizeCanvas();
    watchSize(canvas);
  }

  /** Faint 25/50/75% rules, so a level is readable without staring at it. */
  function drawGrid(ctx2d) {
    ctx2d.save();
    ctx2d.globalAlpha = 0.16;
    ctx2d.strokeStyle = "#aeb6c8";
    ctx2d.lineWidth = 1;
    ctx2d.setLineDash([3, 4]);
    for (var q = 1; q <= 3; q++) {
      var y = Math.round(cssH - (q / 4) * cssH) + 0.5;
      ctx2d.beginPath();
      ctx2d.moveTo(0, y);
      ctx2d.lineTo(cssW, y);
      ctx2d.stroke();
    }
    ctx2d.restore();
  }

  /**
   * A pedal as a full-width level rising from the bottom, with a solid cap on
   * top. The cap is what you actually track — a translucent block's edge is
   * hard to fix on at speed, and the two blocks tint each other where they
   * overlap.
   */
  function drawLevel(ctx2d, value, color, alpha) {
    var v = value < 0 ? 0 : value > 1 ? 1 : value;
    if (v <= 0) return;
    var top = cssH - v * cssH;
    ctx2d.globalAlpha = alpha;
    ctx2d.fillStyle = color;
    ctx2d.fillRect(0, top, cssW, cssH - top);
    ctx2d.globalAlpha = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, top);
    ctx2d.lineTo(cssW, top);
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 2;
    ctx2d.stroke();
  }

  /**
   * Where the aid put the pedal, as a line below the driver's own level. The
   * gap between the two lines is the intervention.
   */
  function drawAidLevel(ctx2d, value, cut, color) {
    if (cut <= 0.01) return;
    var v = value - cut;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    var y = cssH - v * cssH;
    ctx2d.save();
    ctx2d.setLineDash([5, 3]);
    ctx2d.beginPath();
    ctx2d.moveTo(0, y);
    ctx2d.lineTo(cssW, y);
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 2;
    ctx2d.stroke();
    ctx2d.restore();
  }

  /** Needle length, clamped so full lock still lands inside the box. */
  function needleRadius() {
    var byHeight = cssH * 0.88;
    var byWidth = (cssW / 2 - 8) / Math.sin(MAX_ANGLE);
    return Math.min(byHeight, byWidth);
  }

  /**
   * The steering arc: a fixed scale the needle sweeps, drawn once behind it.
   * Without the arc and its ticks the needle is just a leaning line with no
   * sense of how much lock is left, which is most of what the readout is for.
   */
  function drawArc(ctx2d, px, py, r) {
    ctx2d.save();
    ctx2d.globalAlpha = 0.4;
    ctx2d.strokeStyle = "#aeb6c8";
    ctx2d.lineWidth = 1;
    // Canvas angles run from +x; straight up is -90deg. Right lock is +steer.
    ctx2d.beginPath();
    ctx2d.arc(px, py, r, -Math.PI / 2 - MAX_ANGLE, -Math.PI / 2 + MAX_ANGLE);
    ctx2d.stroke();

    // Ticks at centre, half lock and full lock each way.
    var marks = [-1, -0.5, 0, 0.5, 1];
    for (var i = 0; i < marks.length; i++) {
      var a = marks[i] * MAX_ANGLE;
      var sin = Math.sin(a), cos = Math.cos(a);
      var inner = marks[i] === 0 ? r - 10 : r - 6;
      ctx2d.globalAlpha = marks[i] === 0 ? 0.65 : 0.4;
      ctx2d.beginPath();
      ctx2d.moveTo(px + sin * inner, py - cos * inner);
      ctx2d.lineTo(px + sin * r, py - cos * r);
      ctx2d.stroke();
    }
    ctx2d.restore();
  }

  /**
   * The needle, plus a fan of fading ghosts at its recent positions. The ghosts
   * are the whole reason this is not just a dial: how fast the wheel arrived
   * and whether it needed a correction are both in the spacing of the fan.
   */
  function drawNeedle(ctx2d, px, py, r) {
    // Ghosts oldest-first so the brightest ends up on top.
    for (var g = GHOST_COUNT; g >= 1; g--) {
      var back = g * GHOST_STRIDE;
      if (back >= count) continue;
      var gv = steerAt(back);
      var ga = gv * MAX_ANGLE;
      var gr = r * 0.94;
      // Tuned against a 1:1 capture, not a zoomed screenshot: at 0.26 the fan
      // was legible when magnified and effectively gone at broadcast size.
      ctx2d.globalAlpha = 0.42 * (1 - g / (GHOST_COUNT + 1));
      ctx2d.beginPath();
      ctx2d.moveTo(px, py);
      ctx2d.lineTo(px + Math.sin(ga) * gr, py - Math.cos(ga) * gr);
      ctx2d.strokeStyle = "#dbe4ff";
      ctx2d.lineWidth = 1.5;
      ctx2d.stroke();
    }

    var a = curSteer * MAX_ANGLE;
    var tipX = px + Math.sin(a) * r;
    var tipY = py - Math.cos(a) * r;
    ctx2d.globalAlpha = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(px, py);
    ctx2d.lineTo(tipX, tipY);
    // Pale blue-white, deliberately NOT the clutch blue (#4f8bff): the clutch
    // bar sits inches away in the same widget and the two would read as one
    // channel. Neutral also keeps it off the green/red/amber the pedals own.
    ctx2d.strokeStyle = "#dbe4ff";
    ctx2d.lineWidth = 2.25;
    ctx2d.lineCap = "round";
    ctx2d.stroke();
    ctx2d.lineCap = "butt";

    // Tip and hub, so the pivot reads as fixed and the tip as the moving end.
    ctx2d.beginPath();
    ctx2d.arc(tipX, tipY, 3, 0, Math.PI * 2);
    ctx2d.fillStyle = "#dbe4ff";
    ctx2d.fill();
    ctx2d.beginPath();
    ctx2d.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx2d.fillStyle = "#aeb6c8";
    ctx2d.fill();
  }

  /**
   * Lock as a signed percentage. The sim reports steering normalised to the
   * car's own lock, not in degrees, so this is labelled % and never "deg" —
   * the same number means a different wheel angle in a different car.
   */
  function drawLockText(ctx2d) {
    var pct = Math.round(Math.abs(curSteer) * 100);
    var side = pct === 0 ? "" : curSteer > 0 ? " R" : " L";
    ctx2d.save();
    ctx2d.globalAlpha = 0.75;
    ctx2d.fillStyle = "#aeb6c8";
    ctx2d.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx2d.textBaseline = "top";
    ctx2d.fillText(pct + "%" + side, 5, 5);
    ctx2d.restore();
  }

  function draw() {
    if (!gctx || cssW === 0) { sizeCanvas(); if (cssW === 0) return; }
    gctx.clearRect(0, 0, cssW, cssH);
    gctx.globalAlpha = 1;

    drawGrid(gctx);
    // Brake under throttle, matching the original widget's layering so the
    // green cap stays readable through an overlap.
    // Slightly stronger than the scrolling trace's fills: there, a shape read
    // against its neighbours over time; here a single block has to carry the
    // value on its own.
    drawLevel(gctx, curBrk, "#ff5470", 0.26);
    drawLevel(gctx, curThr, "#35d07f", 0.24);
    if (absHot > 0) drawAidLevel(gctx, curBrk, curAbs, "#ff9f1a");
    if (tcHot > 0) drawAidLevel(gctx, curThr, curTc, "#ffd23e");

    var px = cssW / 2;
    var py = cssH - 3;
    var r = needleRadius();
    drawArc(gctx, px, py, r);
    drawNeedle(gctx, px, py, r);
    gctx.globalAlpha = 1;
    drawLockText(gctx);
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
    // Backstop for a resize that arrived while nothing was rendering. Cheap:
    // sizeCanvas() returns immediately unless the element has actually changed.
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) sizeCanvas();
    var fmt = ctx.fmt;
    var p = frame.player;
    if (!p || !p.pedals) return;
    var ped = p.pedals;

    curTc = typeof ped.tc === "number" ? ped.tc : 0;
    curAbs = typeof ped.abs === "number" ? ped.abs : 0;
    curThr = typeof ped.throttle === "number" ? ped.throttle : 0;
    curBrk = typeof ped.brake === "number" ? ped.brake : 0;

    var steer = typeof ped.steer === "number" ? ped.steer : 0;
    if (steer < -1) steer = -1; else if (steer > 1) steer = 1;
    curSteer = steer;

    if (curTc > 0.02) tcHot = CAP; else if (tcHot > 0) tcHot--;
    if (curAbs > 0.02) absHot = CAP; else if (absHot > 0) absHot--;

    pushSteer(steer);
    draw();

    // Live bars.
    var tp = setFill(fillThrottle, "thr", ped.throttle);
    var bp = setFill(fillBrake, "brk", ped.brake);
    var cp = setFill(fillClutch, "clu", ped.clutch);
    if (cache.thrv !== tp) { cache.thrv = tp; valThrottle.textContent = tp; }
    if (cache.brkv !== bp) { cache.brkv = bp; valBrake.textContent = bp; }
    if (cache.cluv !== cp) { cache.cluv = cp; valClutch.textContent = cp; }

    // TC/ABS: recolour the affected bar and light the chip, with the chip's
    // brightness following intervention strength.
    var tcOn = curTc > 0.02;
    var absOn = curAbs > 0.02;
    if (cache.tcOn !== tcOn) {
      cache.tcOn = tcOn;
      fillThrottle.setAttribute("data-aid", String(tcOn));
      chipTc.setAttribute("data-on", String(tcOn));
    }
    if (tcOn) chipTc.style.opacity = String(0.45 + 0.55 * Math.min(1, curTc * 2.5));
    if (cache.absOn !== absOn) {
      cache.absOn = absOn;
      fillBrake.setAttribute("data-aid", String(absOn));
      chipAbs.setAttribute("data-on", String(absOn));
    }
    if (absOn) chipAbs.style.opacity = String(0.45 + 0.55 * Math.min(1, curAbs * 2.5));

    // Header: gear + speed.
    if (headerGear) {
      var g = fmt.gearLabel(p.gear);
      var spd = fmt.has(p.speedKph) ? Math.round(p.speedKph) : "—";
      var text = g + " · " + spd + " kph";
      if (cache.gear !== text) { cache.gear = text; headerGear.textContent = text; }
    }
  }

  window.ApexOverlay.registerWidget("pedalsv", {
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
