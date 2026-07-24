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

  /** The player's own car: a fixed arrow at the centre pointing forward,
   *  outlined so it stays visible over any part of the game feed. */
  function drawEgo() {
    var cx = cssW / 2, cy = cssH / 2;
    var s = ICON * 0.6;
    gctx.save();
    gctx.fillStyle = "#e9eefb";
    gctx.strokeStyle = "rgba(0,0,0,0.75)";
    gctx.lineWidth = 1.6;
    gctx.beginPath();
    gctx.moveTo(cx, cy - s); // nose
    gctx.lineTo(cx - s * 0.78, cy + s * 0.72); // rear left
    gctx.lineTo(cx, cy + s * 0.32); // tail notch
    gctx.lineTo(cx + s * 0.78, cy + s * 0.72); // rear right
    gctx.closePath();
    gctx.fill();
    gctx.stroke();
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

  /**
   * Half-length of a car icon, CSS px. Deliberately large — the blips are the
   * whole point of the HUD (the scope backdrop is gone), so the per-class
   * silhouette needs to read at a glance.
   */
  var ICON = 18;

  /** Shape family for a class label — GT box vs the prototype silhouettes. */
  function carFamily(cls) {
    var c = String(cls || "").toUpperCase();
    if (/HYPER|LMH|LMDH|GTP/.test(c)) return "hyper";
    if (/LMP2/.test(c)) return "lmp2";
    if (/LMP3/.test(c)) return "lmp3";
    if (/GT/.test(c)) return "gt"; // GT3, LMGT3, GTE, GT4
    return "generic";
  }

  /** Rounded-rectangle sub-path (adds to the current path). */
  function roundRect(x, y, w, h, r) {
    gctx.moveTo(x + r, y);
    gctx.arcTo(x + w, y, x + w, y + h, r);
    gctx.arcTo(x + w, y + h, x, y + h, r);
    gctx.arcTo(x, y + h, x, y, r);
    gctx.arcTo(x, y, x + w, y, r);
  }

  /** A GT car from above: boxy body with a distinct cabin. Points up (−y). */
  function drawGT(col) {
    var hl = ICON, hw = ICON * 0.62;
    gctx.fillStyle = col;
    gctx.beginPath();
    roundRect(-hw, -hl, hw * 2, hl * 2, hw * 0.55);
    gctx.fill();
    gctx.stroke();
    // Cabin / greenhouse toward the rear — a darker inset.
    gctx.fillStyle = "rgba(0,0,0,0.30)";
    gctx.beginPath();
    roundRect(-hw * 0.6, -hl * 0.1, hw * 1.2, hl * 0.9, hw * 0.35);
    gctx.fill();
  }

  /** A Le Mans prototype from above: teardrop body + cockpit canopy. Points up. */
  function drawProto(col, opts) {
    var sc = opts.scale || 1;
    var hl = ICON * sc;
    var hw = ICON * 0.56 * sc * (opts.wide || 1);
    gctx.fillStyle = col;
    gctx.beginPath();
    if (opts.sharp) {
      gctx.moveTo(0, -hl); // sharp nose (hypercar)
      gctx.lineTo(hw, -hl * 0.08);
    } else {
      gctx.moveTo(0, -hl);
      gctx.quadraticCurveTo(hw, -hl, hw, -hl * 0.08); // rounded nose
    }
    gctx.lineTo(hw, hl * 0.78);
    gctx.quadraticCurveTo(hw, hl, hw * 0.55, hl); // rear right
    gctx.lineTo(-hw * 0.55, hl);
    gctx.quadraticCurveTo(-hw, hl, -hw, hl * 0.78); // rear left
    gctx.lineTo(-hw, -hl * 0.08);
    if (opts.sharp) gctx.lineTo(0, -hl);
    else gctx.quadraticCurveTo(-hw, -hl, 0, -hl);
    gctx.closePath();
    gctx.fill();
    gctx.stroke();
    // Cockpit canopy.
    gctx.fillStyle = "rgba(0,0,0,0.32)";
    gctx.beginPath();
    gctx.ellipse(0, -hl * 0.02, hw * 0.44, hl * 0.34, 0, 0, Math.PI * 2);
    gctx.fill();
    // Shark fin down the spine (hypercar only).
    if (opts.fin) {
      gctx.beginPath();
      gctx.moveTo(0, hl * 0.12);
      gctx.lineTo(-1.3, hl * 0.92);
      gctx.lineTo(1.3, hl * 0.92);
      gctx.closePath();
      gctx.fill();
    }
  }

  /** A Pac-Man-style ghost for a backmarker (a slower-class car being lapped). */
  function drawGhost(col) {
    var w = ICON * 0.72, h = ICON * 1.7;
    var top = -h / 2, bottom = h / 2, r = w;
    gctx.fillStyle = col;
    gctx.beginPath();
    gctx.moveTo(-w, bottom);
    gctx.lineTo(-w, top + r);
    gctx.arc(0, top + r, r, Math.PI, 2 * Math.PI, false); // dome over the top
    gctx.lineTo(w, bottom);
    var feet = 3;
    var fw = (2 * w) / feet;
    for (var i = 0; i < feet; i++) {
      var x0 = w - i * fw;
      var x1 = x0 - fw;
      gctx.quadraticCurveTo((x0 + x1) / 2, bottom - h * 0.15, x1, bottom);
    }
    gctx.closePath();
    gctx.fill();
    gctx.stroke();
    // Eyes — the giveaway that it's a ghost.
    var ey = top + r, ex = w * 0.42, er = w * 0.4;
    gctx.fillStyle = "#ffffff";
    gctx.beginPath();
    gctx.arc(-ex, ey, er, 0, Math.PI * 2);
    gctx.arc(ex, ey, er, 0, Math.PI * 2);
    gctx.fill();
    gctx.fillStyle = "#0a0c12";
    var pr = er * 0.55;
    gctx.beginPath();
    gctx.arc(-ex, ey + er * 0.12, pr, 0, Math.PI * 2);
    gctx.arc(ex, ey + er * 0.12, pr, 0, Math.PI * 2);
    gctx.fill();
  }

  function drawBlip(b) {
    // Longitudinal beyond the display range is dropped (the provider already
    // capped at 150 m); lateral beyond the strip clamps to the edge with a hint
    // so a car well off to the side still registers rather than vanishing.
    if (Math.abs(b.longitudinalM) > rangeM) return;
    var pad = 10;
    var clampedLat = Math.max(-LATERAL_RANGE_M, Math.min(LATERAL_RANGE_M, b.lateralM));
    var xy = toXY(clampedLat, b.longitudinalM, pad);
    var col = classColor(b.carClass);

    gctx.save();
    gctx.translate(xy[0], xy[1]);

    // Faster-class cars get a halo RING so a Hypercar bearing down reads
    // instantly — a ring rather than a filled disc, so the silhouette shows.
    if (b.isFasterClass) {
      gctx.save();
      gctx.globalAlpha = 0.22;
      gctx.fillStyle = col;
      gctx.beginPath();
      gctx.arc(0, 0, ICON * 1.5, 0, Math.PI * 2);
      gctx.fill();
      gctx.globalAlpha = 0.95;
      gctx.strokeStyle = col;
      gctx.lineWidth = 1.6;
      gctx.beginPath();
      gctx.arc(0, 0, ICON * 1.5, 0, Math.PI * 2);
      gctx.stroke();
      gctx.restore();
    }

    gctx.strokeStyle = "rgba(0,0,0,0.6)";
    gctx.lineWidth = 1.2;

    // A backmarker — a car you're lapping — draws as a ghost, not a car: either a
    // genuinely slower class, or any car a lap or more down. A faster-class car is
    // never ghosted (its ring warns you), even if it's temporarily a lap behind.
    var backmarker = !b.isFasterClass && (b.slowerClass || (b.lapsDown || 0) >= 1);
    if (backmarker) {
      drawGhost(col);
      gctx.restore();
      return;
    }

    var fam = carFamily(b.carClass);
    if (fam === "gt") drawGT(col);
    else if (fam === "hyper") drawProto(col, { sharp: true, fin: true, wide: 1.05 });
    else if (fam === "lmp2") drawProto(col, { sharp: false, wide: 0.92 });
    else if (fam === "lmp3") drawProto(col, { sharp: false, wide: 0.85, scale: 0.82 });
    else {
      gctx.fillStyle = col;
      gctx.beginPath();
      gctx.arc(0, 0, ICON * 0.7, 0, Math.PI * 2);
      gctx.fill();
      gctx.stroke();
    }

    // Car number below the icon, when we have one — kept off the silhouette so
    // the shape stays readable.
    if (b.carNumber) {
      gctx.fillStyle = "#e6ebf5";
      gctx.strokeStyle = "rgba(0,0,0,0.85)";
      gctx.lineWidth = 2.5;
      gctx.font = "bold 8px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      gctx.textAlign = "center";
      gctx.textBaseline = "middle";
      var ny = ICON + 7;
      gctx.strokeText(String(b.carNumber).slice(0, 3), 0, ny);
      gctx.fillText(String(b.carNumber).slice(0, 3), 0, ny);
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
