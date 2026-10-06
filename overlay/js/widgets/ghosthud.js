/**
 * ghosthud.js — Ghost HUD: the gap to a chosen reference lap, as geometry.
 * -----------------------------------------------------------------------------
 * A perspective corridor drawn on the driver's screen, with a bright cross-bar
 * — the GATE — sitting where the chosen reference lap is on the road. Hold
 * station and the picture is still. Lose drive out of a corner and the gate
 * shrinks away toward the vanishing point. The gap is read as geometry, with
 * the seconds readout as a confirmation rather than the primary channel.
 *
 * Fed by `frame.player.ghost` (see `telemetry/ghostLap.ts`), whose `gapM` is a
 * signed distance: positive means the ghost is up the road.
 *
 * ## This is a gauge drawn in perspective space, not a camera
 * The obvious implementation — project the gate with true perspective,
 * `y = f*h/z` — was built first and then thrown away, because it spends
 * almost all of its pixels on the first few metres. At a 420 px width the
 * gate sat 189 px below the horizon at 3 m and 20 px at 28 m, so the whole
 * 10-28 m range — the part a driver is actually training against — moved it
 * 36 px out of 189. Shortening the corridor truncated that problem without
 * fixing it; the 144:1 gradient ratio is intrinsic to `1/z`.
 *
 * So depth is LINEAR in distance here. The rails still converge and the
 * picture still reads as a road going away, but a metre of gap is worth the
 * same number of pixels wherever it falls. That is not a fudge: egocentric
 * distance has a Stevens exponent of about 0.97-1.0, so a linear
 * metres-to-length mapping is within a percentage point of perceptually
 * uniform. What would be wrong is MIXING the two — drawing the gate on a
 * ground plane that renders as `1/d` while intending its travel to read as
 * `d`. Position and width are both linear here, so they agree.
 *
 * The axis is signed and centred on your own car: +/-GAP_RANGE_M fills the
 * corridor, with a datum line across the middle for where you are. Past that
 * the gate pins and a chevron says which way it ran out; the readout carries
 * the number.
 *
 * Worth knowing why the overlay earns its place at all: looming detection sits
 * around 0.003-0.008 rad/s, so a car closing at 1 m/s is below threshold
 * beyond roughly 14-25 m. Over much of this range the eye cannot read the gap
 * changing on its own.
 *
 * ## Continuous rails, sparse rungs
 * A floating mark reads as FARTHER than its ground point, and every texture
 * discontinuity adds a small compensating slant bias that compounds with
 * distance. Continuous ground-contacting rails are therefore more veridical
 * than a ladder of rungs. The rungs that remain are a scale at 5 m intervals,
 * not the channel.
 *
 * ## Colour is the redundant label
 * Position carries the gap; colour only says which side of level it is on.
 * That ordering is deliberate — position ranks first among visual encodings
 * and hue ranks last, and several standards advise against putting meaning on
 * a red/green axis alone. With the information already in the geometry, the
 * familiar green/red reads as a label rather than as a single point of
 * failure for a colour-blind driver. The "red" is vermillion, not pure red,
 * and the three states separate in luminance as well as hue so they survive
 * greyscale.
 *
 * ## Throttled, and why that is enough
 * `throttleMs: 33` rather than full rate. The runtime is rAF-coalesced and
 * latest-wins and the default broadcast is 30 Hz, so at stock settings this is
 * every frame anyway; the smoothness comes from the easing below, not from the
 * sample rate. It also keeps `scripts/test-bench.js`'s frozen full-rate set
 * ("the five instruments, not the whole HUD") meaningful.
 */

(function () {
  "use strict";

  /* ------------------------------- geometry ------------------------------- */

  /**
   * The corridor is a SIGNED gap axis centred on your own car, not a stretch
   * of road ahead of it. The datum line across the middle is you; the gate
   * rises above it when the ghost is up the road and falls below it when the
   * ghost is behind.
   *
   * The first version ran the axis forward-only and mirrored a negative gap
   * back into it, which put the gate in the SAME place for 21 m ahead and 21 m
   * behind and left colour as the only thing telling them apart. That is
   * precisely the failure the rest of this file is written to avoid: position
   * is the channel, colour is the label. Signed about a datum, position alone
   * answers it.
   *
   * +/-20 m fills the corridor, which is about +/-0.4 s at racing speed and
   * covers the training case; 5 m then reads as a quarter of the half-height.
   */
  var GAP_RANGE_M = 20;

  /**
   * Corridor height and rail half-widths, as fractions of widget width, so the
   * geometry is identical at any size. The near end is nearly full width and
   * the far end is narrow — the taper is what makes it read as a road rather
   * than as a ladder, and it is linear so it agrees with the linear depth.
   */
  var H_PER_PX = 0.45;
  var HW_NEAR_PER_PX = 0.46;
  var HW_FAR_PER_PX = 0.055;

  /** Rung spacing, metres. Evenly spaced now, so they read as a scale. */
  var RUNG_M = 5;

  /** Chrome above the corridor, and the strip the readout gets below. */
  var PAD_TOP = 8;
  var READOUT_H = 30;
  /**
   * Clear space between the corridor's bottom edge and the readout. A gate
   * pinned at the far-behind end sits ON that edge and still has to fit its
   * uprights and its chevron somewhere; without this they are drawn through
   * the number.
   */
  var GATE_ROOM = 20;

  /* -------------------------------- colour -------------------------------- */

  /**
   * Three states, separated in luminance as well as hue so the picture still
   * reads in greyscale: vermillion (~0.46) < green (~0.62) < white (~0.91).
   * Vermillion rather than pure red on purpose — `#FF0000` is the worst case
   * for a protanope and vibrates against a dark track.
   */
  var C_GHOST_AHEAD = "#D55E00";
  var C_LEVEL = "#E8EAED";
  var C_YOU_AHEAD = "#2FBF71";
  var C_RAIL = "#8A9099";
  var C_INK = "#0B0D10";

  /** |gapSec| at or under this is a dead heat. */
  var LEVEL_SEC = 0.05;

  /**
   * Band hysteresis. A raw threshold crossing flickers the colour whenever the
   * gap sits near level, and a band change is the most visually loud thing
   * this widget does. Entering a band needs 8% more than the threshold,
   * leaving it needs to fall 15% below — plus a dwell, short to arm and long
   * to disarm. The band index itself is never low-passed: filtering an
   * integer state produces values that mean nothing.
   */
  var BAND_ENTER = 1.08;
  var BAND_LEAVE = 0.85;
  var DWELL_ENTER_MS = 60;
  var DWELL_LEAVE_MS = 250;
  /** Cross-fade on a band change. A hard cut at 2-5 Hz reads as a pulse. */
  var BAND_FADE_MS = 120;

  /* ------------------------------- smoothing ------------------------------ */

  /**
   * Low-pass time constant for the gate's position, seconds.
   *
   * Applied with a dt-DERIVED coefficient — `a = 1 - exp(-dt / TAU)` — and not
   * a fixed per-frame fraction. A hard-coded fraction silently assumes a fixed
   * frame interval; this widget is throttled and frames drop, so the same
   * constant would mean different smoothing at different rates. Tau depends
   * only on the cutoff, so it stays correct when the rate moves. Same form as
   * `paceDelta.Channel` server-side.
   */
  var TAU_SEC = 0.1;
  /** Below this the eased value snaps, so it cannot creep forever. */
  var SNAP_M = 0.02;

  /* -------------------------------- state --------------------------------- */

  var canvas = null;
  var gctx = null;
  var headerMeta = null;
  var cssW = 0;
  var cssH = 0;
  var dpr = 1;
  var H = 180;
  var HW_NEAR = 184;
  var HW_FAR = 22;
  var horizonY = PAD_TOP;

  /**
   * The static corridor, rendered once to an offscreen canvas. Per frame the
   * widget blits this and draws the gate and the readout over it.
   *
   * `chrome` and `chromeKey` are nulled TOGETHER, always. Dropping the canvas
   * while leaving the key set lands on `drawImage(null, ...)`, which throws
   * every frame for the rest of the session — the same trap `trackmap.js`
   * warns about twice.
   */
  var chrome = null;
  var chromeKey = "";

  var easedM = 0;
  var easedAt = -1;
  /** -1 = you ahead, 0 = level, 1 = ghost ahead. */
  var band = 0;
  var bandPending = 0;
  var bandPendingAt = 0;
  var bandFadeFrom = 0;
  var bandFadeAt = -1;
  var lastLabel = "";
  var lastText = "";

  /* ------------------------------- helpers -------------------------------- */

  /**
   * Signed gap in metres -> corridor coordinate, `0` at the bottom (ghost a
   * full range BEHIND) through `0.5` at the datum to `1` at the top (a full
   * range AHEAD). Linear, and clamped: past the range the gate pins and the
   * chevron says so.
   */
  function vOfGap(m) {
    return clamp(0.5 + (0.5 * m) / GAP_RANGE_M, 0, 1);
  }

  /** Screen y for a corridor coordinate. */
  function yOfV(v) {
    return horizonY + H * (1 - v);
  }

  /** Rail half-width there, tapering linearly so position and width agree. */
  function halfOfV(v) {
    return HW_NEAR + (HW_FAR - HW_NEAR) * v;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function mix(a, b, f) {
    return a + (b - a) * f;
  }

  /** `#rrggbb` -> [r,g,b]. Only ever called on the literals above. */
  function rgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  function mixHex(a, b, f) {
    var x = rgb(a);
    var y = rgb(b);
    return (
      "rgb(" +
      Math.round(mix(x[0], y[0], f)) +
      "," +
      Math.round(mix(x[1], y[1], f)) +
      "," +
      Math.round(mix(x[2], y[2], f)) +
      ")"
    );
  }

  function colourOf(b) {
    return b > 0 ? C_GHOST_AHEAD : b < 0 ? C_YOU_AHEAD : C_LEVEL;
  }

  /** `+0.24` / `-1.08` / `0.00`, always signed and always two decimals. */
  function fmtDelta(sec) {
    var s = Math.abs(sec) < 0.005 ? 0 : sec;
    return (s > 0 ? "+" : s < 0 ? "-" : "") + Math.abs(s).toFixed(2);
  }

  /* ------------------------------- sizing --------------------------------- */

  /**
   * Height is DERIVED from width, not set as an aspect ratio, so the corridor,
   * the chrome above it and the readout strip below it always add up exactly
   * and the near rails cannot be cut off by a rounding error.
   */
  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth || 400;
    var hh = Math.round(w * H_PER_PX);
    var h = Math.round(PAD_TOP + hh + GATE_ROOM + READOUT_H);
    var d = window.ApexRaster.backingScale(canvas);
    var bw = Math.round(w * d);
    var bh = Math.round(h * d);
    if (bw === canvas.width && bh === canvas.height && w === cssW) return;

    cssW = w;
    cssH = h;
    dpr = d;
    H = hh;
    HW_NEAR = w * HW_NEAR_PER_PX;
    HW_FAR = w * HW_FAR_PER_PX;
    horizonY = PAD_TOP;
    canvas.style.height = cssH + "px";
    // Put the border chrome back so the content box is exactly cssH tall and
    // the bitmap is never squashed to fit (same fix as motion.js / radar.js).
    var extra = canvas.offsetHeight - canvas.clientHeight;
    if (extra > 0) canvas.style.height = cssH + extra + "px";
    canvas.width = bw;
    canvas.height = bh;
    if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Together. Always.
    chrome = null;
    chromeKey = "";
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

  /* ------------------------------- the chrome ----------------------------- */

  /**
   * The corridor: two continuous rails from the near end to the far end, a
   * closing bar at the far end, and 5 m rungs as a scale.
   *
   * Drawn once per size into an offscreen canvas. Every coordinate is rounded
   * to a whole pixel plus a half-pixel stroke offset — this never moves, and
   * sub-pixel jitter on something that should look nailed down is exactly what
   * makes a HUD tiring to sit behind.
   */
  function renderChrome() {
    var key = cssW + "x" + cssH + "@" + dpr;
    if (chrome && chromeKey === key) return;

    var c = document.createElement("canvas");
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    var x = c.getContext("2d");
    if (!x) {
      chrome = null;
      chromeKey = "";
      return;
    }
    x.setTransform(dpr, 0, 0, dpr, 0, 0);

    var cx = Math.round(cssW / 2) + 0.5;
    var nearY = Math.round(yOfV(0)) + 0.5;
    var nearH = Math.round(halfOfV(0));
    var farY = Math.round(yOfV(1)) + 0.5;
    var farH = Math.round(halfOfV(1));

    // Rungs first, so the rails sit on top of their ends.
    x.lineWidth = 1;
    for (var m = -GAP_RANGE_M + RUNG_M; m <= GAP_RANGE_M - RUNG_M; m += RUNG_M) {
      if (m === 0) continue; // the datum is drawn separately, and louder
      var rv = vOfGap(m);
      var ry = Math.round(yOfV(rv)) + 0.5;
      var rh = Math.round(halfOfV(rv));
      // Fade with distance from the datum: the rungs nearest you matter most.
      x.globalAlpha = 0.1 + 0.2 * (1 - Math.abs(m) / GAP_RANGE_M);
      x.strokeStyle = C_RAIL;
      x.beginPath();
      x.moveTo(cx - rh, ry);
      x.lineTo(cx + rh, ry);
      x.stroke();
    }

    // The rails. Straight lines in screen space, because a straight line on
    // the ground plane projects to a straight line.
    x.globalAlpha = 0.5;
    x.strokeStyle = C_RAIL;
    x.lineWidth = 1.5;
    x.beginPath();
    x.moveTo(cx - nearH, nearY);
    x.lineTo(cx - farH, farY);
    x.moveTo(cx + nearH, nearY);
    x.lineTo(cx + farH, farY);
    x.stroke();

    // The far edge — the corridor ends here rather than running to a vanishing
    // point it would reach only at infinity.
    x.globalAlpha = 0.35;
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(cx - farH, farY);
    x.lineTo(cx + farH, farY);
    x.stroke();

    // The datum: YOU. Everything the gate does is read against this line, so
    // it is the brightest thing in the static chrome and the only part drawn
    // with ticks. Without it a gate sitting mid-corridor says nothing — there
    // would be no zero to be above or below.
    var dv = 0.5;
    var dy = Math.round(yOfV(dv)) + 0.5;
    var dh = Math.round(halfOfV(dv));
    x.globalAlpha = 0.85;
    x.strokeStyle = C_RAIL;
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(cx - dh, dy);
    x.lineTo(cx + dh, dy);
    x.stroke();
    // Inward ticks, so the datum reads as a mark on the corridor rather than
    // as one more rung in the scale.
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(cx - dh, dy - 5);
    x.lineTo(cx - dh, dy + 5);
    x.moveTo(cx + dh, dy - 5);
    x.lineTo(cx + dh, dy + 5);
    x.stroke();

    x.globalAlpha = 1;
    chrome = c;
    chromeKey = key;
  }

  /* -------------------------------- bands --------------------------------- */

  /**
   * Resolve the colour band with hysteresis and dwell. Returns the settled
   * band; `band` only ever moves one step at a time and only after the new
   * state has persisted.
   */
  function settleBand(gapSec, nowMs) {
    var want;
    if (band === 0) {
      // Leaving level needs a clear margin over the threshold.
      want = gapSec > LEVEL_SEC * BAND_ENTER ? 1 : gapSec < -LEVEL_SEC * BAND_ENTER ? -1 : 0;
    } else {
      // Returning to level needs the gap to fall well inside it.
      want = Math.abs(gapSec) < LEVEL_SEC * BAND_LEAVE ? 0 : band;
      // A straight flip through level (hard to do, but possible on a reset).
      if (band > 0 && gapSec < -LEVEL_SEC * BAND_ENTER) want = -1;
      if (band < 0 && gapSec > LEVEL_SEC * BAND_ENTER) want = 1;
    }

    if (want === band) {
      bandPending = band;
      return band;
    }
    if (want !== bandPending) {
      bandPending = want;
      bandPendingAt = nowMs;
      return band;
    }
    // Short to arm, long to disarm: a real change should show quickly, but a
    // return to neutral should not race a wobble.
    var need = want === 0 ? DWELL_LEAVE_MS : DWELL_ENTER_MS;
    if (nowMs - bandPendingAt < need) return band;

    bandFadeFrom = band;
    bandFadeAt = nowMs;
    band = want;
    return band;
  }

  /** The band colour, cross-faded across a change. */
  function bandColour(nowMs) {
    if (bandFadeAt < 0) return colourOf(band);
    var f = (nowMs - bandFadeAt) / BAND_FADE_MS;
    if (f >= 1) {
      bandFadeAt = -1;
      return colourOf(band);
    }
    return mixHex(colourOf(bandFadeFrom), colourOf(band), f < 0 ? 0 : f);
  }

  /* ------------------------------- drawing -------------------------------- */

  function drawGate(x, v, colour, beyond) {
    var cx = cssW / 2;
    var y = yOfV(v);
    var half = halfOfV(v);

    // Outlined, because an outline is required for a readable mark over a
    // DYNAMIC background and ours is the track going past at 250 km/h.
    x.lineCap = "round";
    x.strokeStyle = C_INK;
    x.lineWidth = 6;
    x.globalAlpha = 0.55;
    x.beginPath();
    x.moveTo(cx - half, y);
    x.lineTo(cx + half, y);
    x.stroke();

    x.globalAlpha = 1;
    x.strokeStyle = colour;
    x.lineWidth = 3;
    x.beginPath();
    x.moveTo(cx - half, y);
    x.lineTo(cx + half, y);
    x.stroke();

    // Short uprights at the gate's ends, so it reads as a gate standing ON the
    // road rather than as a line floating across it. Ground contact is what
    // makes a mark's distance legible at all.
    // Capped: at the wide end 0.22 of the half-width is ~42 px of post,
    // which hangs a pinned gate straight through the readout below it.
    var postLen = Math.max(3, Math.min(13, half * 0.22));
    var post = postLen * (v >= 0.5 ? 1 : -1);
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(cx - half, y);
    x.lineTo(cx - half, y - post);
    x.moveTo(cx + half, y);
    x.lineTo(cx + half, y - post);
    x.stroke();

    if (!beyond) return;
    // Past the corridor's reach: say so, instead of pinning the gate and
    // letting the pinned position read as the distance. The chevron points
    // the way it ran out of room, so a pegged gate at the top and one at the
    // bottom still cannot be confused.
    var up = v >= 0.5;
    x.globalAlpha = 0.8;
    x.fillStyle = colour;
    var ty = up ? y - postLen - 4 : y + postLen + 4;
    x.beginPath();
    x.moveTo(cx, ty + (up ? -5 : 5));
    x.lineTo(cx - 5, ty);
    x.lineTo(cx + 5, ty);
    x.closePath();
    x.fill();
    x.globalAlpha = 1;
  }

  /** The signed seconds, outlined, centred under the corridor. */
  function drawReadout(x, text, colour) {
    var cx = Math.round(cssW / 2);
    var y = Math.round(cssH - READOUT_H / 2 + 1);
    // ~20 arcmin of character height at a normal viewing distance is the
    // recommended minimum for in-vehicle text; this tracks widget width so it
    // holds when the driver scales the HUD up.
    var size = Math.max(13, Math.round(cssW * 0.075));
    x.font = "600 " + size + 'px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.lineJoin = "round";
    // Stroke-to-cap-height stays under 0.08 — thicker starts eating the glyph.
    x.lineWidth = Math.max(2, size * 0.075) * 2;
    x.strokeStyle = C_INK;
    x.globalAlpha = 0.75;
    x.strokeText(text, cx, y);
    x.globalAlpha = 1;
    x.fillStyle = colour;
    x.fillText(text, cx, y);
  }

  function drawIdle(x, note) {
    var cx = Math.round(cssW / 2);
    var y = Math.round(cssH - READOUT_H / 2 + 1);
    var size = Math.max(10, Math.round(cssW * 0.034));
    x.font = "500 " + size + 'px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.globalAlpha = 0.55;
    x.fillStyle = C_RAIL;
    x.fillText(note, cx, y);
    x.globalAlpha = 1;
  }

  /* -------------------------------- update -------------------------------- */

  function update(frame) {
    if (!gctx || !canvas) return;
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) sizeCanvas();
    if (!cssW || !cssH) return;

    renderChrome();

    var g = frame && frame.player ? frame.player.ghost : null;
    var nowMs =
      typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

    var x = gctx;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, cssW, cssH);

    // No ghost at all — nothing selected, or spectating.
    if (!g) {
      x.globalAlpha = 0.3;
      if (chrome) x.drawImage(chrome, 0, 0, cssW, cssH);
      x.globalAlpha = 1;
      drawIdle(x, "no ghost lap");
      if (headerMeta && lastLabel !== "") {
        headerMeta.textContent = "—";
        lastLabel = "";
      }
      easedAt = -1;
      return;
    }

    if (headerMeta && g.sourceLabel !== lastLabel) {
      headerMeta.textContent = g.sourceLabel || "—";
      lastLabel = g.sourceLabel || "—";
    }

    // Loaded but out of reach: off the end of the trace's covered span, or in
    // the pits. Show the corridor empty rather than a stale gate.
    if (!g.active) {
      x.globalAlpha = 0.45;
      if (chrome) x.drawImage(chrome, 0, 0, cssW, cssH);
      x.globalAlpha = 1;
      drawIdle(x, "waiting for the line");
      easedAt = -1;
      return;
    }

    // Ease the distance, with a dt-derived coefficient. A lap boundary resets
    // the gap discontinuously, so the first sample after a gap in time is
    // adopted rather than ramped into — ramping would sweep the gate the whole
    // length of the corridor for no physical reason.
    var dt = easedAt < 0 ? -1 : (nowMs - easedAt) / 1000;
    if (dt <= 0 || dt > 0.5) {
      easedM = g.gapM;
    } else {
      var a = 1 - Math.exp(-dt / TAU_SEC);
      easedM += (g.gapM - easedM) * a;
      if (Math.abs(g.gapM - easedM) < SNAP_M) easedM = g.gapM;
    }
    easedAt = nowMs;

    var b = settleBand(g.gapSec, nowMs);
    var colour = bandColour(nowMs);

    x.drawImage(chrome, 0, 0, cssW, cssH);

    // The corridor is forward-facing, so a ghost BEHIND cannot be placed in
    // it. Mirror the position about the near end and dim it: the driver is
    // ahead, the gate is in the mirror, and the number is the authority.
    // Signed, so ahead and behind are different PLACES rather than the same
    // place in two colours. No dimming for the behind case either — that would
    // put meaning back into something other than position.
    var beyond = Math.abs(easedM) > GAP_RANGE_M;
    drawGate(x, vOfGap(easedM), colour, beyond);

    var text = fmtDelta(g.gapSec);
    // Quantise, compare, then write — the house rule, and the reason the
    // readout does not re-layout on every frame.
    if (text !== lastText) lastText = text;
    drawReadout(x, text, colour);

    void b;
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
