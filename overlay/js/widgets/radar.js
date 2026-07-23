/**
 * widgets/radar.js — spatial proximity radar (spotter's-eye view).
 * -----------------------------------------------------------------------------
 * Renders `frame.radar` (see src/telemetry/radar.ts, which owns the world→local
 * projection — nothing here reasons about the sim's axes). Each blip is a car's
 * position RELATIVE to the player: the vertical axis is longitudinal (up =
 * ahead), the horizontal axis is lateral (right = the player's right), and the
 * player sits fixed at the centre.
 *
 * The point of a radar over the relative/timing widget: the relative list is
 * 1-D (how far round the lap), so it cannot tell you a car is drawing alongside
 * on your LEFT. This can. When a car overlaps you longitudinally (`alongside`),
 * the matching edge bar lights — the "don't turn in" warning.
 *
 * URL params (all optional):
 *   ?range=<m>     Longitudinal display range each way, metres (default 70,
 *                  clamped 20..150). Lateral zoom is fixed so a car a metre off
 *                  your door is clearly offset.
 *   ?opacity=0..1  HUD opacity (also a hover slider), so it can sit over the
 *                  track as a see-through practice aid.
 *
 * Runs at full broadcast rate (throttleMs 0) — positions move every frame.
 */
(function () {
  "use strict";

  /* ------------------------------ class colours --------------------------- */
  // Same palette as the standings/relative widgets so a blip's colour matches
  // the tower. Known classes get a stable colour; anything else hashes to one.
  var KNOWN_CLASS_COLORS = {
    HYPERCAR: "#ff5470", HYPER: "#ff5470", LMH: "#ff5470", LMDH: "#ff5470", GTP: "#ff5470",
    LMP2: "#4f8bff", LMP3: "#22d3ee",
    GT3: "#35d07f", LMGT3: "#35d07f", GTE: "#ffb020", GT4: "#ffb020",
  };
  var CLASS_COLORS = ["#8b5cf6", "#22d3ee", "#ec4899", "#4f8bff", "#35d07f", "#ffb020"];
  var classColorCache = {};
  function classColor(cls) {
    if (!cls) return "#6b7387";
    if (classColorCache[cls]) return classColorCache[cls];
    var known = KNOWN_CLASS_COLORS[String(cls).toUpperCase()];
    if (known) return (classColorCache[cls] = known);
    var hash = 0;
    for (var i = 0; i < cls.length; i++) hash = (hash * 31 + cls.charCodeAt(i)) | 0;
    var color = CLASS_COLORS[Math.abs(hash) % CLASS_COLORS.length];
    classColorCache[cls] = color;
    return color;
  }

  /* -------------------------------- config -------------------------------- */

  /** Longitudinal display range each way, metres. Overridable with ?range=. */
  var rangeM = 70;
  var RANGE_MIN = 20, RANGE_MAX = 150;
  /**
   * Lateral half-width shown, metres. Fixed and much tighter than the
   * longitudinal range: real side-by-side gaps are a couple of metres, so the
   * lateral axis is zoomed in to make them legible. A track is a handful of car
   * widths across, so ±12 m covers "on the same bit of tarmac" with margin.
   */
  var LATERAL_RANGE_M = 12;
  /**
   * A car within this longitudinal gap (metres) is treated as ALONGSIDE for the
   * edge-bar warning even if the provider's own flag hasn't tripped — kept in
   * step with ALONGSIDE_LON_M in radar.ts. The provider is authoritative; this
   * is only the display fallback when the flag is absent.
   */
  var ALONGSIDE_M = 6;

  /** localStorage key for the operator's chosen opacity (mirrors motion.js). */
  var OPACITY_KEY = "apex-radar-opacity";
  var MIN_OPACITY = 0.15;

  /* ------------------------------- elements ------------------------------- */

  var canvas, gctx, cssW = 0, cssH = 0, dpr = 1;
  var headerMeta;
  var metaCache = "";

  /** Aspect: taller than wide, like a spotter strip. Height = width × this. */
  var ASPECT = 1.5;

  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth || 200;
    var h = Math.round(w * ASPECT);
    var d = window.devicePixelRatio || 1;
    var bw = Math.round(w * d);
    var bh = Math.round(h * d);
    if (bw === canvas.width && bh === canvas.height && w === cssW) return;
    cssW = w; cssH = h; dpr = d;
    canvas.style.height = cssH + "px";
    // Add the border chrome back so the content box is exactly cssH tall and the
    // bitmap is never squashed to fit (same fix as motion.js).
    var chrome = canvas.offsetHeight - canvas.clientHeight;
    if (chrome > 0) canvas.style.height = cssH + chrome + "px";
    canvas.width = bw; canvas.height = bh;
    if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  var sizeTick = 0;
  var SIZE_CHECK_FRAMES = 15;

  function watchSize(el) {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () { sizeCanvas(); }).observe(el);
    }
    window.addEventListener("resize", sizeCanvas, { passive: true });
  }

  /* --------------------------- opacity HUD control ------------------------ */
  // Same contract as motion.js: fade the CONTENTS (not the section) so the
  // hover slider stays visible, and drop the panel chrome below full opacity so
  // the widget reads as a HUD over the track rather than a box.
  function buildOpacityControl(root, params) {
    var apply = function (v) {
      root.style.setProperty("--radar-op", String(v));
      root.setAttribute("data-transparent", v < 1 ? "true" : "false");
    };
    var stored = null;
    try {
      var raw = localStorage.getItem(OPACITY_KEY);
      if (raw !== null && isFinite(parseFloat(raw))) stored = parseFloat(raw);
    } catch (e) { /* private mode */ }
    var fromUrl = parseFloat(params.get("opacity"));
    var initial = isFinite(fromUrl) ? fromUrl : stored !== null ? stored : 1;
    initial = Math.min(1, Math.max(MIN_OPACITY, initial));

    var bar = document.createElement("div");
    bar.className = "radar__opacity";
    var label = document.createElement("span");
    label.className = "radar__opacity-label";
    label.textContent = "OPACITY";
    var slider = document.createElement("input");
    slider.className = "radar__opacity-range";
    slider.type = "range";
    slider.min = String(Math.round(MIN_OPACITY * 100));
    slider.max = "100"; slider.step = "1";
    slider.value = String(Math.round(initial * 100));
    var readout = document.createElement("span");
    readout.className = "radar__opacity-val";
    readout.textContent = slider.value + "%";
    slider.addEventListener("input", function () {
      var v = Math.min(1, Math.max(MIN_OPACITY, Number(slider.value) / 100));
      apply(v);
      readout.textContent = Math.round(v * 100) + "%";
      try { localStorage.setItem(OPACITY_KEY, String(v)); } catch (e) { /* ignore */ }
    });
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      bar.addEventListener(evt, function (e) { e.stopPropagation(); });
    });
    bar.appendChild(label); bar.appendChild(slider); bar.appendChild(readout);
    var anchor = document.createElement("div");
    anchor.className = "radar__opacity-anchor";
    anchor.appendChild(bar);
    root.appendChild(anchor);
    apply(initial);
  }

  /* --------------------------------- init --------------------------------- */

  function init(root, ctx) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var params = new URLSearchParams(window.location.search);
    var r = parseFloat(params.get("range"));
    if (isFinite(r)) rangeM = Math.min(RANGE_MAX, Math.max(RANGE_MIN, r));

    buildOpacityControl(root, params);

    var wrap = document.createElement("div");
    wrap.className = "radar__wrap";
    canvas = document.createElement("canvas");
    canvas.className = "radar__canvas";
    wrap.appendChild(canvas);
    mount.appendChild(wrap);

    gctx = canvas.getContext("2d");
    sizeCanvas();
    watchSize(canvas);
  }

  /* -------------------------------- drawing ------------------------------- */

  /** Map a blip's (lateral, longitudinal) metres to canvas pixels. */
  function toXY(lat, lon, pad) {
    var cx = cssW / 2, cy = cssH / 2;
    var x = cx + (lat / LATERAL_RANGE_M) * (cssW / 2 - pad);
    var y = cy - (lon / rangeM) * (cssH / 2 - pad);
    return [x, y];
  }

  function drawScope() {
    var cx = cssW / 2, cy = cssH / 2;
    var pad = 6;

    // Backdrop.
    gctx.save();
    gctx.fillStyle = "rgba(10,12,18,0.55)";
    gctx.fillRect(0, 0, cssW, cssH);

    // Longitudinal distance gridlines (dashed) at nice round metres, labelled.
    gctx.strokeStyle = "#aeb6c8";
    gctx.setLineDash([2, 3]);
    gctx.lineWidth = 1;
    gctx.font = "8px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    gctx.textBaseline = "middle";
    var step = rangeM <= 40 ? 10 : rangeM <= 80 ? 20 : 40;
    for (var d = step; d <= rangeM; d += step) {
      var frac = d / rangeM;
      var dy = (cy - pad) * frac;
      gctx.globalAlpha = 0.16;
      gctx.beginPath();
      gctx.moveTo(pad, cy - dy); gctx.lineTo(cssW - pad, cy - dy);
      gctx.moveTo(pad, cy + dy); gctx.lineTo(cssW - pad, cy + dy);
      gctx.stroke();
      gctx.globalAlpha = 0.4;
      gctx.fillStyle = "#aeb6c8";
      gctx.fillText(d + "", pad + 1, cy - dy - 5);
    }
    gctx.setLineDash([]);

    // Centre axes.
    gctx.globalAlpha = 0.22;
    gctx.beginPath();
    gctx.moveTo(cx, pad); gctx.lineTo(cx, cssH - pad);
    gctx.moveTo(pad, cy); gctx.lineTo(cssW - pad, cy);
    gctx.stroke();
    gctx.restore();
  }

  /** The player's own car, a fixed chevron at the centre pointing forward. */
  function drawEgo() {
    var cx = cssW / 2, cy = cssH / 2;
    gctx.save();
    gctx.fillStyle = "#dbe4ff";
    gctx.beginPath();
    gctx.moveTo(cx, cy - 6);
    gctx.lineTo(cx - 5, cy + 5);
    gctx.lineTo(cx + 5, cy + 5);
    gctx.closePath();
    gctx.fill();
    gctx.restore();
  }

  /**
   * Edge warning bars: left/right glow when a car is alongside on that side, and
   * the ends glow when one is right on the nose / tail. Intensity rises as the
   * car gets closer, so a door-to-door pass ramps up rather than blinking on.
   */
  function drawWarnings(blips) {
    var left = 0, right = 0;
    for (var i = 0; i < blips.length; i++) {
      var b = blips[i];
      var alongside = b.alongside || Math.abs(b.longitudinalM) <= ALONGSIDE_M;
      if (!alongside) continue;
      if (Math.abs(b.lateralM) > LATERAL_RANGE_M) continue;
      var intensity = 1 - Math.abs(b.longitudinalM) / ALONGSIDE_M; // 1 = dead level
      intensity = Math.max(0.25, Math.min(1, intensity));
      if (b.lateralM < 0) left = Math.max(left, intensity);
      else right = Math.max(right, intensity);
    }
    var barW = 5;
    if (left > 0) {
      gctx.save();
      gctx.globalAlpha = 0.25 + 0.6 * left;
      gctx.fillStyle = "#ff3b3b";
      gctx.fillRect(0, 0, barW, cssH);
      gctx.restore();
    }
    if (right > 0) {
      gctx.save();
      gctx.globalAlpha = 0.25 + 0.6 * right;
      gctx.fillStyle = "#ff3b3b";
      gctx.fillRect(cssW - barW, 0, barW, cssH);
      gctx.restore();
    }
  }

  function drawBlip(b) {
    // Longitudinal beyond the display range is dropped (the provider already
    // capped at 150 m); lateral beyond the strip clamps to the edge with a hint
    // so a car well off to the side still registers rather than vanishing.
    if (Math.abs(b.longitudinalM) > rangeM) return;
    var pad = 8;
    var clampedLat = Math.max(-LATERAL_RANGE_M, Math.min(LATERAL_RANGE_M, b.lateralM));
    var xy = toXY(clampedLat, b.longitudinalM, pad);
    var col = classColor(b.carClass);

    gctx.save();
    // Faster-class cars get a halo so a Hypercar bearing down reads instantly.
    if (b.isFasterClass) {
      gctx.globalAlpha = 0.35;
      gctx.fillStyle = col;
      gctx.beginPath();
      gctx.arc(xy[0], xy[1], 8, 0, Math.PI * 2);
      gctx.fill();
      gctx.globalAlpha = 1;
    }
    gctx.fillStyle = col;
    gctx.strokeStyle = "rgba(0,0,0,0.6)";
    gctx.lineWidth = 1;
    gctx.beginPath();
    gctx.arc(xy[0], xy[1], 5, 0, Math.PI * 2);
    gctx.fill();
    gctx.stroke();

    // Car number, when we have one and there's room.
    if (b.carNumber) {
      gctx.fillStyle = "#0a0c12";
      gctx.font = "bold 7px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      gctx.textAlign = "center";
      gctx.textBaseline = "middle";
      gctx.fillText(String(b.carNumber).slice(0, 3), xy[0], xy[1] + 0.5);
    }
    gctx.restore();
  }

  function setMeta(text) {
    if (!headerMeta || metaCache === text) return;
    metaCache = text;
    headerMeta.textContent = text;
  }

  /* -------------------------------- update -------------------------------- */

  function update(frame) {
    if (!canvas) return;
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) sizeCanvas();
    if (!gctx || cssW === 0) { sizeCanvas(); if (cssW === 0) return; }

    var blips = frame.radar;
    gctx.clearRect(0, 0, cssW, cssH);
    drawScope();

    if (!blips) {
      // Omitted entirely = no world position for the driven car (spectating, or
      // no shared memory). Say why rather than drawing an empty scope, which
      // would read as "nobody near you" — a very different, and dangerous, claim.
      drawEgo();
      gctx.save();
      gctx.fillStyle = "#6b7387";
      gctx.font = "9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      gctx.textAlign = "center";
      gctx.fillText("NO RADAR DATA", cssW / 2, cssH - 10);
      gctx.restore();
      setMeta("— m");
      return;
    }

    drawWarnings(blips);
    drawEgo();
    // Draw furthest first so the nearest blip sits on top of any overlap.
    for (var i = blips.length - 1; i >= 0; i--) drawBlip(blips[i]);

    // Header: range + the nearest car's distance (blips are nearest-first).
    var nearest = blips.length ? Math.round(blips[0].distanceM) + " m" : "clear";
    setMeta("±" + Math.round(rangeM) + " m · " + nearest);
  }

  window.ApexOverlay.registerWidget("radar", {
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
