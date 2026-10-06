/**
 * widgets/pedals.js — pedal inputs + rolling trail-brake trace (bottom-centre).
 * -----------------------------------------------------------------------------
 * The signature "trail-braking" widget. Renders `frame.player.pedals`
 * (throttle/brake/clutch/steer 0..1, steer -1..1) as:
 *   - a scrolling Canvas trace overlaying throttle (green) and brake (red) so
 *     you can read brake-release vs throttle-application overlap;
 *   - TC (yellow) and ABS (blue) strength lines rising from the floor of the
 *     trace — how hard each aid is working, on the same time axis;
 *   - vertical bars for the live throttle/brake/clutch values;
 *   - a GT-style steering wheel that turns with the real wheel.
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
   *   wheel — a GT wheel beside the bars, rotated by the real steering angle
   *           with a red arc for how much lock is wound on (default).
   *   trace — a centre-anchored line through the pedal trace. Was the default
   *           until 2026-10; drivers found a white line crossing the pedal
   *           areas harder to read than a wheel, so it is opt-in now.
   *   dot   — the original left/right dot on a strip under the bars.
   *   off   — none.
   */
  var steerMode = "wheel";
  /** Lock-to-lock used when the sim does not publish one (`steerRangeDeg`). */
  var DEFAULT_STEER_RANGE = 540;
  /** Fraction of the canvas half-height a full lock deflects the trace. */
  var STEER_GAIN = 0.9;
  // Frames left to keep drawing the aid lines after the last intervention
  // (avoids per-frame full-ring scans just to know if anything is visible).
  // The channels arrive already smoothed into a strength envelope — see
  // src/telemetry/aidIntervention.ts — so they are drawn as they come.
  var tcHot = 0;
  var absHot = 0;

  var canvas, gctx, dpr = 1;
  var fillThrottle, fillBrake, fillClutch;
  var valThrottle, valBrake, valClutch;
  var steerDot, headerGear;
  var chipTc, chipAbs;
  var wheelCanvas, wctx, wheelDeg, wheelDpr = 1, wheelCss = 0;
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

  /**
   * Matches the canvas BITMAP to the element's current CSS size.
   *
   * Has to track the element, not the window: the in-game layer lets the
   * operator drag a widget narrower without the window changing size, and a
   * stale bitmap is then scaled to fit by a different factor on each axis,
   * which distorts everything drawn in it.
   *
   * Idempotent, so a ResizeObserver watching the element cannot feed itself.
   */
  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth || 260;
    var h = canvas.clientHeight || 90;
    var d = window.ApexRaster.backingScale(canvas);
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

    var params = new URLSearchParams(window.location.search);
    var sm = (params.get("steer") || "wheel").toLowerCase();
    steerMode = sm === "dot" || sm === "off" || sm === "trace" ? sm : "wheel";

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

    if (steerMode === "wheel") {
      var wheel = document.createElement("div");
      wheel.className = "pedals__wheel";
      wheelCanvas = document.createElement("canvas");
      wheelCanvas.className = "pedals__wheel-canvas";
      wheelDeg = document.createElement("div");
      wheelDeg.className = "pedal-bar__val pedals__wheel-deg";
      wheelDeg.textContent = "0°";
      wheel.appendChild(wheelCanvas);
      wheel.appendChild(wheelDeg);
      wrap.appendChild(wheel);
    } else {
      wheelCanvas = null;
      wheelDeg = null;
    }

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
    watchSize(canvas);
    if (wheelCanvas) {
      wctx = wheelCanvas.getContext("2d");
      sizeWheel();
      if (typeof ResizeObserver === "function") {
        new ResizeObserver(sizeWheel).observe(wheelCanvas);
      }
    }
  }

  /** Same contract as {@link sizeCanvas}, for the square wheel canvas. */
  function sizeWheel() {
    if (!wheelCanvas) return;
    var w = wheelCanvas.clientWidth || 84;
    var d = window.ApexRaster.backingScale(wheelCanvas);
    var bw = Math.round(w * d);
    if (bw === wheelCanvas.width && w === wheelCss) return;
    wheelCss = w;
    wheelDpr = d;
    wheelCanvas.width = bw;
    wheelCanvas.height = bw;
    cache.wheelAngle = null; // force a redraw at the new size
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
   * An aid's strength as its own channel: a line rising from the floor of the
   * trace, 0 = not working, full height = the whole pedal removed. Drawn only
   * over the stretches where the aid was working, each closed back to the floor
   * with a faint fill, so a TC burst out of a hairpin reads as one hump whose
   * height is how hard it cut.
   */
  function drawAidStrength(ctx2d, cut, color) {
    if (count < 2) return;
    var start = (head - count + CAP) % CAP;
    var stepX = cssW / (CAP - 1);
    var h = cssH;
    var inRun = false;
    ctx2d.beginPath();
    for (var i = 0; i <= count; i++) {
      var c = i < count ? cut[(start + i) % CAP] : 0;
      var x = i * stepX;
      if (c > 0.005) {
        if (c > 1) c = 1;
        if (!inRun) {
          inRun = true;
          ctx2d.moveTo(x, h);
        }
        ctx2d.lineTo(x, h - c * h);
      } else if (inRun) {
        // Close the run back down to the floor at the previous sample.
        ctx2d.lineTo(x - stepX, h);
        inRun = false;
      }
    }
    ctx2d.globalAlpha = 0.28;
    ctx2d.fillStyle = color;
    ctx2d.fill();
    ctx2d.globalAlpha = 1;
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 2;
    ctx2d.lineJoin = "round";
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
    if (absHot > 0) drawAidStrength(gctx, brkCut, "#3ec5ff");
    if (tcHot > 0) drawAidStrength(gctx, thrCut, "#ffd23e");
    // Steering on top: it is the thinnest line and must stay readable over the
    // filled pedal areas.
    if (steerMode === "trace") drawSteerTrace(gctx);
  }

  /** A point on a circle of radius r at `deg` (0 = 3 o'clock, clockwise). */
  function polar(r, deg) {
    var a = (deg * Math.PI) / 180;
    return [r * Math.cos(a), r * Math.sin(a)];
  }

  /**
   * The GT wheel, turned by `deg` (positive = right / clockwise).
   *
   * The outer ring is fixed and carries a red arc from 12 o'clock to the
   * current angle — the amount of lock wound on, readable even at a glance
   * where the wheel's own rotation is not (a GT rim at 180° looks much like
   * one at 0°). The wheel inside is a flat-topped GT rim with a yellow centre
   * marker, so straight-ahead is unmistakable.
   */
  function drawWheel(deg) {
    if (!wctx) return;
    if (wheelCss === 0) { sizeWheel(); if (wheelCss === 0) return; }
    var S = wheelCss;
    var c = S / 2;
    var g = wctx;
    g.setTransform(wheelDpr, 0, 0, wheelDpr, 0, 0);
    g.clearRect(0, 0, S, S);
    g.lineCap = "round";
    g.lineJoin = "round";

    // Fixed outer ring + lock arc.
    var ringR = c - 3;
    g.beginPath();
    g.arc(c, c, ringR, 0, Math.PI * 2);
    g.strokeStyle = "rgba(255,255,255,0.10)";
    g.lineWidth = 3;
    g.stroke();
    var shown = deg > 360 ? 360 : deg < -360 ? -360 : deg;
    if (Math.abs(shown) >= 0.5) {
      var a0 = -Math.PI / 2;
      var a1 = a0 + (shown * Math.PI) / 180;
      g.beginPath();
      g.arc(c, c, ringR, Math.min(a0, a1), Math.max(a0, a1));
      g.strokeStyle = "#ff3b3b";
      g.lineWidth = 3;
      g.stroke();
      // White tip marking where the arc ends.
      var tip = polar(ringR, shown - 90);
      g.save();
      g.translate(c + tip[0], c + tip[1]);
      g.rotate(a1);
      g.beginPath();
      g.moveTo(-3, 0); g.lineTo(0, -3); g.lineTo(3, 0); g.lineTo(0, 3);
      g.closePath();
      g.fillStyle = "#ffffff";
      g.fill();
      g.restore();
    }

    // The wheel, rotated about the centre.
    var r = S * 0.36;
    g.save();
    g.translate(c, c);
    g.rotate((deg * Math.PI) / 180);

    var tl = polar(r, -125), tr = polar(r, -55);
    var bl = polar(r, 125), br = polar(r, 55);

    // Rim: grips joined by a flat top and a flat bottom — the GT silhouette.
    // One closed path stroked twice (dark body, lighter core) so it reads as a
    // padded rim against the dark panel rather than a flat outline.
    g.beginPath();
    g.moveTo(tl[0], tl[1]);
    g.lineTo(tr[0], tr[1]);
    g.arc(0, 0, r, (-55 * Math.PI) / 180, (55 * Math.PI) / 180);
    g.lineTo(bl[0], bl[1]);
    g.arc(0, 0, r, (125 * Math.PI) / 180, (235 * Math.PI) / 180);
    g.closePath();
    g.strokeStyle = "#4a505b";
    g.lineWidth = S * 0.11;
    g.stroke();
    g.strokeStyle = "#2a2e35";
    g.lineWidth = S * 0.06;
    g.stroke();

    // Spokes out to the grips.
    g.fillStyle = "#3a3f48";
    g.fillRect(0.55 * r, -0.1 * r, 0.42 * r, 0.2 * r);
    g.fillRect(-0.97 * r, -0.1 * r, 0.42 * r, 0.2 * r);

    // Centre plate with a dash screen and four buttons.
    var pw = 1.2 * r, ph = 0.95 * r, py = -0.42 * r;
    g.beginPath();
    if (g.roundRect) g.roundRect(-pw / 2, py, pw, ph, 0.18 * r);
    else g.rect(-pw / 2, py, pw, ph);
    g.fillStyle = "#16181d";
    g.fill();
    g.strokeStyle = "#4a505b";
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = "#0c1f15";
    g.fillRect(-0.3 * r, -0.3 * r, 0.6 * r, 0.28 * r);
    g.strokeStyle = "rgba(53,208,127,0.8)";
    g.strokeRect(-0.3 * r, -0.3 * r, 0.6 * r, 0.28 * r);
    var dots = [
      [-0.38, 0.16, "#ff5470"], [0.38, 0.16, "#3ec5ff"],
      [-0.14, 0.32, "#ffd23e"], [0.14, 0.32, "#35d07f"],
    ];
    var dr = Math.max(1.3, 0.03 * S);
    for (var i = 0; i < dots.length; i++) {
      g.beginPath();
      g.arc(dots[i][0] * r, dots[i][1] * r, dr, 0, Math.PI * 2);
      g.fillStyle = dots[i][2];
      g.fill();
    }

    // Yellow 12 o'clock marker on the top of the rim.
    g.strokeStyle = "#ffd23e";
    g.lineWidth = S * 0.11;
    g.lineCap = "butt";
    g.beginPath(); g.moveTo(-0.08 * r, tl[1]); g.lineTo(0.08 * r, tl[1]); g.stroke();
    g.lineCap = "round";
    g.restore();
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
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) { sizeCanvas(); sizeWheel(); }
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

    // Wheel: steer -1..1 is half the lock-to-lock either way. Redrawn only when
    // the angle moves by half a degree, so a held straight costs nothing.
    if (wheelCanvas) {
      var range = typeof ped.steerRangeDeg === "number" && ped.steerRangeDeg > 0
        ? ped.steerRangeDeg : DEFAULT_STEER_RANGE;
      var deg = (steer * range) / 2;
      var key = Math.round(deg * 2);
      if (cache.wheelAngle !== key) {
        cache.wheelAngle = key;
        drawWheel(deg);
        var whole = Math.round(Math.abs(deg));
        var label = whole === 0 ? "0°" : (deg < 0 ? "L " : "R ") + whole + "°";
        if (cache.wheelDeg !== label) { cache.wheelDeg = label; wheelDeg.textContent = label; }
      }
    }

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
      // fmt.speed carries the driver's chosen unit (see client.js) — the same
      // one the motion widget uses, so two panels can never disagree.
      var text = g + " · " + fmt.speed(p.speedKph);
      if (cache.gear !== text) { cache.gear = text; headerGear.textContent = text; }
    }
  }

  window.ApexOverlay.registerWidget("pedals", {
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
