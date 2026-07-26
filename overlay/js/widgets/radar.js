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

  /**
   * Proximity reveal: the HUD is invisible until a car is within this radius
   * (metres), then fades in, and fades out again as it leaves. `?reveal=<m>`
   * overrides it. `revealAlpha` is the current eased opacity of the whole canvas;
   * `FADE_RATE` is the per-frame easing toward the target (radar runs every
   * frame, so ~0.15 gives a ~0.2–0.4 s fade).
   */
  var REVEAL_RADIUS_M = 12;
  var FADE_RATE = 0.15;
  var revealAlpha = 0;

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
    var rev = parseFloat(params.get("reveal"));
    if (isFinite(rev) && rev > 0) REVEAL_RADIUS_M = Math.min(150, rev);

    buildOpacityControl(root, params);

    var wrap = document.createElement("div");
    wrap.className = "radar__wrap";
    canvas = document.createElement("canvas");
    canvas.className = "radar__canvas";
    // Start invisible — nothing shows until a car enters the reveal radius.
    canvas.style.opacity = "0";
    wrap.appendChild(canvas);
    mount.appendChild(wrap);

    gctx = canvas.getContext("2d");
    sizeCanvas();
    watchSize(canvas);
    loadSprites();
  }

  /* -------------------------------- drawing ------------------------------- */

  /** Map a blip's (lateral, longitudinal) metres to canvas pixels. */
  function toXY(lat, lon, pad) {
    var cx = cssW / 2, cy = cssH / 2;
    var x = cx + (lat / LATERAL_RANGE_M) * (cssW / 2 - pad);
    var y = cy - (lon / rangeM) * (cssH / 2 - pad);
    return [x, y];
  }

  /**
   * The player's own car, fixed at the centre pointing forward.
   *
   * Drawn as the UNTINTED white artwork for the player's own class, so their car
   * is the one white shape among coloured rivals — the fastest possible "which
   * one am I" read, and it needs no extra marker to achieve it. Falls back to the
   * outlined arrow before the sprites decode, or if they failed to load.
   */
  function drawEgo(playerClass) {
    var cx = cssW / 2, cy = cssH / 2;
    var fam = carFamily(playerClass);
    // An unrecognised (or not yet known) class still gets a car rather than a
    // shapeless marker — the GT silhouette is the most generic of the four.
    var img = spritesReady ? spriteFor(fam === "generic" ? "gt" : fam) : null;
    if (img) {
      gctx.save();
      gctx.translate(cx, cy);
      drawSpriteImage(img, fam);
      gctx.restore();
      return;
    }
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
   * How far the warning glow reaches in from the edge, as a fraction of the
   * strip's width. Long enough that the falloff reads as light rather than as a
   * drawn object, but capped at 0.4: at 0.62 two blooms on a 163px-wide strip met
   * in the middle and the whole HUD just went red, losing the one thing this
   * warning exists to tell you — WHICH SIDE the car is on.
   */
  var GLOW_REACH = 0.4;

  /**
   * Edge proximity warning — a soft red bloom hugging the side a car is arriving
   * on, brightest level with that car.
   *
   * This was a 5px solid bar up the full height of the strip, which read as a
   * piece of UI switching on and drew the eye away from the track. A radial
   * gradient anchored on the edge at the car's own longitudinal position does the
   * same job with none of that: it says "there is something HERE, on your left"
   * rather than just "left", and having no hard edge anywhere means nothing on
   * screen appears or disappears — it only brightens.
   *
   * Built from stacked colour stops rather than a real gaussian blur: canvas
   * `filter = blur()` would cost a full-canvas convolution every frame at 30–60Hz
   * for a shape that is already a smooth falloff by construction. The stop curve
   * below is a rough gaussian, which is indistinguishable here and free.
   */
  function drawWarnings(blips) {
    var left = 0, right = 0;
    var leftY = cssH / 2, rightY = cssH / 2;
    for (var i = 0; i < blips.length; i++) {
      var b = blips[i];
      var alongside = b.alongside || Math.abs(b.longitudinalM) <= ALONGSIDE_M;
      if (!alongside) continue;
      if (Math.abs(b.lateralM) > LATERAL_RANGE_M) continue;
      var intensity = 1 - Math.abs(b.longitudinalM) / ALONGSIDE_M; // 1 = dead level
      intensity = Math.max(0.25, Math.min(1, intensity));
      // Anchor the bloom at the car, so the warning points at where it actually is.
      var y = toXY(0, b.longitudinalM, 10)[1];
      if (b.lateralM < 0) {
        if (intensity > left) { left = intensity; leftY = y; }
      } else if (intensity > right) { right = intensity; rightY = y; }
    }
    if (left > 0) drawEdgeGlow(0, leftY, left);
    if (right > 0) drawEdgeGlow(cssW, rightY, right);
  }

  /** One edge bloom, centred on (edgeX, y) and fading out in every direction. */
  function drawEdgeGlow(edgeX, y, intensity) {
    var radius = cssW * GLOW_REACH;
    var g = gctx.createRadialGradient(edgeX, y, 0, edgeX, y, radius);
    // Peak alpha stays well under 1: this is a tint over the track, not a panel.
    var peak = 0.42 * intensity;
    g.addColorStop(0.0, "rgba(255, 59, 59, " + peak.toFixed(3) + ")");
    g.addColorStop(0.25, "rgba(255, 59, 59, " + (peak * 0.62).toFixed(3) + ")");
    g.addColorStop(0.5, "rgba(255, 59, 59, " + (peak * 0.28).toFixed(3) + ")");
    g.addColorStop(0.75, "rgba(255, 59, 59, " + (peak * 0.08).toFixed(3) + ")");
    g.addColorStop(1.0, "rgba(255, 59, 59, 0)");
    gctx.save();
    gctx.fillStyle = g;
    // The gradient is a circle centred ON the edge, so half of it falls outside
    // the canvas and only the inward half paints — which is what keeps the
    // brightest part hugging the edge where peripheral vision picks it up.
    gctx.fillRect(edgeX - radius, y - radius, radius * 2, radius * 2);
    gctx.restore();
  }

  /**
   * Half-length of a car icon, CSS px. Deliberately large — the blips are the
   * whole point of the HUD (the scope backdrop is gone), so the per-class
   * silhouette needs to read at a glance.
   */
  var ICON = 18;

  /* ------------------------------ car sprites -----------------------------
   * Top-down car artwork, one silhouette per class family, in img/cars/.
   *
   * The files are the WHITE artwork only, and every opponent colour is produced
   * from it at runtime (see `tintedSprite`). One set of shapes therefore covers
   * every class the palette can produce — including the hashed colours handed to
   * mod classes nobody anticipated — instead of needing a new PNG per class.
   * It also makes the player's icon fall out for free: the player is simply the
   * untinted artwork, so their own car reads as white while every rival carries
   * its class colour.
   * -------------------------------------------------------------------------- */

  var SPRITE_FAMILIES = ["hyper", "lmp2", "lmp3", "gt"];
  var sprites = {};
  /** Set once at least one sprite has decoded; until then we draw the vectors. */
  var spritesReady = false;

  function loadSprites() {
    SPRITE_FAMILIES.forEach(function (fam) {
      var img = new Image();
      img.onload = function () {
        spritesReady = true;
      };
      img.onerror = function () {
        // A missing file must not blank the radar — the vector silhouettes below
        // stay as the fallback, which is also what runs on the first few frames
        // before these have decoded.
        sprites[fam] = null;
      };
      img.src = "img/cars/" + fam + ".png";
      sprites[fam] = img;
    });
  }

  function spriteFor(fam) {
    var img = sprites[fam];
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  /**
   * The white artwork recoloured, cached per (family, colour).
   *
   * `multiply` rather than a flat `source-in` fill: the artwork carries its own
   * shading — panel lines, the cockpit, the wing — as greys, and multiplying
   * keeps all of that as darker tones of the class colour. A flat fill would
   * collapse each car to a featureless blob at exactly the size where the
   * silhouette is doing the work. The `destination-in` pass afterwards puts the
   * original alpha back, since the multiply fill covers the whole rect.
   */
  var tintCache = {};

  function tintedSprite(fam, colour) {
    var key = fam + "|" + colour;
    if (tintCache[key]) return tintCache[key];
    var img = spriteFor(fam);
    if (!img) return null;
    var c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    var x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    x.globalCompositeOperation = "multiply";
    x.fillStyle = colour;
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = "destination-in";
    x.drawImage(img, 0, 0);
    tintCache[key] = c;
    return c;
  }

  /**
   * Relative on-screen size per family, so a Hypercar still reads as bigger than
   * an LMP3 the way it does on track. Multiplies the shared ICON length.
   */
  var FAMILY_SCALE = { hyper: 1, lmp2: 0.96, lmp3: 0.86, gt: 0.92, generic: 0.9 };

  /** Draw a sprite (or tinted canvas) centred on the current origin, nose up. */
  function drawSpriteImage(src, fam) {
    var h = ICON * 2 * (FAMILY_SCALE[fam] || 1);
    var w = h * (src.width / src.height);
    gctx.drawImage(src, -w / 2, -h / 2, w, h);
  }

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

    // Preferred path: the artwork, recoloured to this car's class. The vector
    // silhouettes below remain for the frames before the PNGs decode, for an
    // unrecognised class with no matching shape, and if the files are missing.
    var tinted = spritesReady ? tintedSprite(fam === "generic" ? "gt" : fam, col) : null;
    if (tinted) {
      drawSpriteImage(tinted, fam);
      drawCarNumber(b);
      gctx.restore();
      return;
    }

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

    drawCarNumber(b);
    gctx.restore();
  }

  /** Car number below the icon — kept off the silhouette so the shape reads. */
  function drawCarNumber(b) {
    if (!b.carNumber) return;
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

  /**
   * The player's own car class, for picking their silhouette.
   *
   * Read off whichever field list marks the player, because `frame.player` does
   * not carry a class — the blips only describe classes RELATIVE to the player
   * (isFasterClass / slowerClass), so the player's own is not derivable from
   * `frame.radar` alone. Cached: it cannot change without a session change, and
   * this runs every frame.
   */
  var playerClassCache = null;

  function playerClass(frame) {
    if (playerClassCache) return playerClassCache;
    var lists = [frame.standings, frame.relative];
    for (var l = 0; l < lists.length; l++) {
      var list = lists[l];
      if (!list) continue;
      for (var i = 0; i < list.length; i++) {
        if (list[i].isPlayer && list[i].carClass) {
          playerClassCache = list[i].carClass;
          return playerClassCache;
        }
      }
    }
    return null;
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

    var blips = frame.radar || [];

    // Proximity reveal: the whole HUD (every icon AND the player arrow) stays
    // invisible until a car comes within REVEAL_RADIUS_M, then fades in, and
    // fades back out as the nearest car leaves that radius. The fade is applied
    // to the canvas element itself so each icon's own alphas are preserved.
    var nearest = Infinity;
    for (var i = 0; i < blips.length; i++) {
      if (blips[i].distanceM < nearest) nearest = blips[i].distanceM;
    }
    var target = nearest <= REVEAL_RADIUS_M ? 1 : 0;
    revealAlpha += (target - revealAlpha) * FADE_RATE;
    if (target === 0 && revealAlpha < 0.003) revealAlpha = 0;
    canvas.style.opacity = String(revealAlpha);

    // Fully hidden — clear and skip the draw entirely.
    if (revealAlpha <= 0.003) {
      gctx.clearRect(0, 0, cssW, cssH);
      return;
    }

    gctx.clearRect(0, 0, cssW, cssH);
    drawWarnings(blips);
    drawEgo(playerClass(frame));
    // Draw furthest first so the nearest blip sits on top of any overlap.
    for (var j = blips.length - 1; j >= 0; j--) drawBlip(blips[j]);
  }

  window.ApexOverlay.registerWidget("radar", {
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
