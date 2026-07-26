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
 * ## The scale is ISOTROPIC, and the cars are drawn at their real size
 * One metre is the same number of pixels across the strip as it is up it, and
 * each car is drawn at its true footprint in metres — a 5.1 m × 2.0 m Hypercar,
 * a 4.76 m × 2.05 m GT3. That is the whole reason the geometry is arranged this
 * way: it makes **sprites touching mean cars touching**, on both axes and at any
 * angle between them.
 *
 * The earlier build had neither property. The two axes ran at different metres
 * per pixel (±12 m lateral against ±70 m longitudinal, so ~5.9 px/m sideways
 * against ~1.6 px/m fore-aft) and the icons were a fixed 36 px regardless. A
 * 36 px icon is 20 m of car at the longitudinal scale, so blips merged a full
 * car length before the cars did; the same icon is ~3.3 m wide at the lateral
 * scale on a narrow strip and under 2 m on a wide one, so side-by-side contact
 * showed as an overlap or a gap depending only on how big the operator had
 * dragged the widget. Deriving both from one metres-per-pixel and sizing the
 * artwork in metres removes all of that.
 *
 * The cost is range: holding the lateral half-width at roughly a track width
 * (~13 m) fixes the scale at ~6 px/m, and the strip's height then affords ±18 m
 * fore-aft rather than ±70. That is a spotter's range, and it is more than the
 * 12 m reveal radius the HUD appears at — a car is on screen before it is close
 * enough to matter. Use `?range=` for more, knowing the cars shrink to match.
 *
 * ## Icon size is the SAME knob as range, deliberately
 * "The cars are too big" and "I want more range" are one control here, not two:
 * the ICONS slider sets the display range (100% = the classic 18 m, 50% = 36 m
 * and therefore half-size cars). It cannot be a size multiplier laid over the
 * geometry — that is exactly the fixed-pixel icon this widget was rebuilt to get
 * rid of, and it would break the one property the radar exists to have (an
 * icon's edge is the car's edge). Zooming out shrinks the cars AND the metres
 * they stand on together, so contact still reads true at every setting.
 *
 * ## Distance fade
 * Opponents fade with distance rather than being clipped by the canvas: the fade
 * starts at the player icon's own centre line and reaches nothing on a rounded
 * perimeter 3.5 car widths to each side and 3.5 car lengths fore and aft. So
 * everything on screen is something within a few car lengths of you, brightest
 * closest, and nothing ever pops in or out at an edge.
 *
 * URL params (all optional):
 *   ?icons=<pct>   Icon size, 30..150 (default 50; also a hover slider). 100% is
 *                  the classic 18 m range — this IS the zoom, see above.
 *   ?range=<m>     Longitudinal display range each way, metres (clamped 8..150).
 *                  The same knob from the other end; wins over ?icons=.
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

  /**
   * The range that counts as 100% icon size — the geometry this widget shipped
   * with. Everything else is expressed as a percentage of it so the slider can
   * talk about car size, which is what the operator actually sees, while the
   * code keeps working in metres.
   */
  var BASE_RANGE_M = 18;

  /**
   * Longitudinal display range each way, metres. Set by the ICONS slider (and
   * overridable with ?range= / ?icons=).
   *
   * This is the ONE scale knob: it sets metres-per-pixel for both axes (see the
   * module note), so the lateral half-width is not configurable independently —
   * it falls out of the strip's width and lands at ~13 m at 100%, which is
   * about a track width. Making it a second knob would be making the two axes
   * disagree again, which is the bug this shape exists to prevent.
   */
  var rangeM = BASE_RANGE_M * 2; // 50% icon size — the default, see ICON_DEFAULT
  var RANGE_MIN = 8, RANGE_MAX = 150;

  /**
   * Icon size as a percentage of the classic geometry, i.e. `BASE_RANGE_M /
   * rangeM`. 50% by default: at 100% the cars filled more of the strip than
   * they needed to at a glance. The bounds are just RANGE_MIN/MAX seen from the
   * other side (150% = 12 m of range, 30% = 60 m).
   */
  var ICON_DEFAULT = 50, ICON_MIN = 30, ICON_MAX = 150;
  /** localStorage key for the operator's chosen icon size. */
  var ICON_SIZE_KEY = "apex-radar-iconsize";
  /** Border inset, CSS px, so a car at the very edge is not half off-canvas. */
  var PAD = 10;
  /**
   * Pixels per metre — the same on both axes. Recomputed in {@link sizeCanvas},
   * since it depends on the strip's height, and read by everything that draws.
   */
  var pxPerM = 6;
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

  /**
   * Distance fade — how far out an opponent stays visible, in the player's own
   * car widths (sideways) and car lengths (fore-aft).
   *
   * The perimeter these describe is a rounded one: an ellipse in metres, so a
   * car coming diagonally fades on the same curve as one coming straight up the
   * inside, and there is no corner of the strip where a blip survives longer
   * than it should. Measured in car sizes rather than metres because that is the
   * unit the driver is actually thinking in — "he's two cars back" — and it
   * scales itself for a 5.1 m Hypercar against a 4.65 m LMP3 for free.
   */
  var FADE_WIDTHS = 3.5, FADE_LENGTHS = 3.5;

  /* ------------------------------- elements ------------------------------- */

  var canvas, gctx, cssW = 0, cssH = 0, dpr = 1;
  var headerMeta;
  var metaCache = "";

  /** Aspect: taller than wide, like a spotter strip. Height = width × this. */
  var ASPECT = 1.5;

  /**
   * One scale for both axes, pinned to the longitudinal range. Everything else
   * — blip positions, car footprints, the lateral extent — is derived from it,
   * so resizing the widget (or moving the ICONS slider) zooms the whole picture
   * rather than changing what "touching" means.
   */
  function applyScale() {
    pxPerM = (cssH / 2 - PAD) / rangeM;
  }

  /** Set the display range from an icon-size percentage, and re-scale. */
  function setIconPercent(pct) {
    var p = Math.min(ICON_MAX, Math.max(ICON_MIN, pct));
    rangeM = Math.min(RANGE_MAX, Math.max(RANGE_MIN, BASE_RANGE_M / (p / 100)));
    applyScale();
  }

  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth || 200;
    var h = Math.round(w * ASPECT);
    var d = window.devicePixelRatio || 1;
    var bw = Math.round(w * d);
    var bh = Math.round(h * d);
    if (bw === canvas.width && bh === canvas.height && w === cssW) return;
    cssW = w; cssH = h; dpr = d;
    applyScale();
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

  /* ----------------------------- HUD controls ----------------------------- */
  // Same contract as motion.js: fade the CONTENTS (not the section) so the
  // hover sliders stay visible, and drop the panel chrome below full opacity so
  // the widget reads as a HUD over the track rather than a box.

  /** Read a persisted number, or null when absent/unparseable/unavailable. */
  function stored(key) {
    try {
      var raw = localStorage.getItem(key);
      if (raw !== null && isFinite(parseFloat(raw))) return parseFloat(raw);
    } catch (e) { /* private mode — the slider still works, it just won't stick */ }
    return null;
  }

  /**
   * One hover slider: LABEL — track — readout. `opts.onInput(value)` receives
   * the raw slider number; persistence is the caller's business, since only it
   * knows what unit the stored value is in.
   */
  function sliderBar(opts) {
    var bar = document.createElement("div");
    bar.className = "radar__ctl " + opts.className;
    var label = document.createElement("span");
    label.className = "radar__ctl-label";
    label.textContent = opts.label;
    var slider = document.createElement("input");
    slider.className = "radar__ctl-range";
    slider.type = "range";
    slider.min = String(opts.min); slider.max = String(opts.max); slider.step = "1";
    slider.value = String(Math.round(opts.value));
    var readout = document.createElement("span");
    readout.className = "radar__ctl-val";
    readout.textContent = slider.value + "%";
    slider.addEventListener("input", function () {
      var v = Math.min(opts.max, Math.max(opts.min, Number(slider.value)));
      readout.textContent = Math.round(v) + "%";
      opts.onInput(v);
    });
    // The in-game layer starts a widget drag on pointerdown anywhere inside a
    // widget; without this, dragging the slider drags the whole radar instead.
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      bar.addEventListener(evt, function (e) { e.stopPropagation(); });
    });
    bar.appendChild(label); bar.appendChild(slider); bar.appendChild(readout);
    return bar;
  }

  function buildControls(root, params) {
    var applyOpacity = function (v) {
      root.style.setProperty("--radar-op", String(v));
      root.setAttribute("data-transparent", v < 1 ? "true" : "false");
    };
    var savedOp = stored(OPACITY_KEY);
    var urlOp = parseFloat(params.get("opacity"));
    var op = isFinite(urlOp) ? urlOp : savedOp !== null ? savedOp : 1;
    op = Math.min(1, Math.max(MIN_OPACITY, op));

    // Icon size, resolved from (in order) ?range=, ?icons=, the saved value, the
    // default. ?range= wins because it names the geometry directly — an operator
    // who has asked for 40 m of range means it, whatever that does to the icons.
    var urlRange = parseFloat(params.get("range"));
    var urlIcons = parseFloat(params.get("icons"));
    var savedIcons = stored(ICON_SIZE_KEY);
    var icons = isFinite(urlRange) && urlRange > 0
      ? (BASE_RANGE_M / Math.min(RANGE_MAX, Math.max(RANGE_MIN, urlRange))) * 100
      : isFinite(urlIcons) ? urlIcons
      : savedIcons !== null ? savedIcons
      : ICON_DEFAULT;
    icons = Math.min(ICON_MAX, Math.max(ICON_MIN, icons));

    var anchor = document.createElement("div");
    anchor.className = "radar__ctl-anchor";
    anchor.appendChild(
      sliderBar({
        className: "radar__opacity",
        label: "OPACITY",
        min: Math.round(MIN_OPACITY * 100), max: 100,
        value: Math.round(op * 100),
        onInput: function (v) {
          applyOpacity(v / 100);
          try { localStorage.setItem(OPACITY_KEY, String(v / 100)); } catch (e) { /* ignore */ }
        },
      }),
    );
    anchor.appendChild(
      sliderBar({
        className: "radar__size",
        label: "ICONS",
        min: ICON_MIN, max: ICON_MAX,
        value: icons,
        onInput: function (v) {
          setIconPercent(v);
          try { localStorage.setItem(ICON_SIZE_KEY, String(v)); } catch (e) { /* ignore */ }
        },
      }),
    );
    root.appendChild(anchor);
    applyOpacity(op);
    // Before sizeCanvas() runs, so the first frame is already at the right zoom.
    setIconPercent(icons);
  }

  /* --------------------------------- init --------------------------------- */

  function init(root, ctx) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var params = new URLSearchParams(window.location.search);
    var rev = parseFloat(params.get("reveal"));
    if (isFinite(rev) && rev > 0) REVEAL_RADIUS_M = Math.min(150, rev);

    // Owns ?range= / ?icons= as well as the sliders, and sets rangeM before
    // sizeCanvas() below bakes it into pxPerM.
    buildControls(root, params);

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

  /**
   * Map a blip's (lateral, longitudinal) metres to canvas pixels, at the single
   * shared scale. The player sits at the centre; +lat is to their right and +lon
   * is ahead (canvas y grows downward, hence the subtraction).
   */
  function toXY(lat, lon) {
    return [cssW / 2 + lat * pxPerM, cssH / 2 - lon * pxPerM];
  }

  /**
   * The lateral half-width the strip currently shows, metres. Derived rather
   * than configured — see {@link rangeM}. Used to decide when a car is far
   * enough to the side to be clamped to the edge rather than drawn off it.
   */
  function lateralRangeM() {
    return (cssW / 2 - PAD) / pxPerM;
  }

  /**
   * The player's own car, fixed at the centre pointing forward.
   *
   * Drawn as the UNTINTED white artwork for the player's own class, so their car
   * is the one white shape among coloured rivals — the fastest possible "which
   * one am I" read, and it needs no extra marker to achieve it. Falls back to the
   * outlined arrow before the sprites decode, or if they failed to load.
   */
  function drawEgo() {
    var cx = cssW / 2, cy = cssH / 2;
    var fam = egoFam;
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
    // Vector fallback, at the same true footprint as the artwork it stands in for.
    var box = footprint(fam);
    gctx.save();
    gctx.translate(cx, cy);
    gctx.fillStyle = "#e9eefb";
    gctx.strokeStyle = "rgba(0,0,0,0.75)";
    gctx.lineWidth = 1.6;
    gctx.beginPath();
    gctx.moveTo(0, -box.hl); // nose
    gctx.lineTo(-box.hw, box.hl); // rear left
    gctx.lineTo(0, box.hl * 0.45); // tail notch
    gctx.lineTo(box.hw, box.hl); // rear right
    gctx.closePath();
    gctx.fill();
    gctx.stroke();
    gctx.restore();
  }

  /**
   * How far the warning glow reaches in from the edge, as a fraction of the
   * strip's width — 0.5, so each bloom BEGINS on the player icon's own centre
   * line and brightens outward to the side the car is on.
   *
   * Half the width is the largest reach that still says which side: the two
   * blooms meet on the centre line at exactly zero, so a car either side lights
   * both flanks and leaves the middle clear. Going past it (0.62 was tried) has
   * them overlapping at strength, the whole HUD goes red, and the one thing the
   * warning exists to tell you — WHICH SIDE — is the thing it stops saying.
   */
  var GLOW_REACH = 0.5;

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
    var latRange = lateralRangeM();
    for (var i = 0; i < blips.length; i++) {
      var b = blips[i];
      var alongside = b.alongside || Math.abs(b.longitudinalM) <= ALONGSIDE_M;
      if (!alongside) continue;
      if (Math.abs(b.lateralM) > latRange) continue;
      // Past the fade perimeter the car itself is not drawn, so warning about it
      // would be a bloom pointing at nothing.
      if (fadeAlpha(b.lateralM, b.longitudinalM) <= 0) continue;
      var intensity = 1 - Math.abs(b.longitudinalM) / ALONGSIDE_M; // 1 = dead level
      intensity = Math.max(0.25, Math.min(1, intensity));
      // Anchor the bloom at the car, so the warning points at where it actually is.
      var y = toXY(0, b.longitudinalM)[1];
      if (b.lateralM < 0) {
        if (intensity > left) { left = intensity; leftY = y; }
      } else if (intensity > right) { right = intensity; rightY = y; }
    }
    if (left <= 0 && right <= 0) return;
    if (left > 0) drawEdgeGlow(0, leftY, left);
    if (right > 0) drawEdgeGlow(cssW, rightY, right);
    // Both blooms are anchored ON a canvas edge, so the canvas rect cuts each
    // one at its brightest point — which is what put a hard vertical line down
    // the side of the widget and made the "soft" warning read as a bar after all.
    // Feathering afterwards is what actually removes it; see featherEdges.
    featherEdges();
  }

  /**
   * How far in from each edge the glow is feathered back to nothing, as a
   * fraction of the strip's width. Wide enough to hide the cut, narrow enough
   * that the bloom still hugs the side rather than floating in from it.
   */
  var FEATHER_FRAC = 0.09;
  var FEATHER_MIN_PX = 9;

  /**
   * Fade the glow out at all four canvas edges, so nothing it draws ends on a
   * hard line.
   *
   * A radial bloom centred on the edge is at its PEAK where the canvas stops.
   * The falloff is smooth in every direction the eye can follow it and then
   * simply ceases at the boundary, which is exactly the sharp edge the soft
   * warning was meant to get rid of. Erasing a short ramp back off each edge
   * makes the alpha profile rise from zero at the boundary to the bloom's peak
   * a few pixels in, so the warning has no hard edge anywhere.
   *
   * `destination-out` erases whatever has been drawn so far, which is safe only
   * because the warnings are the FIRST thing drawn each frame — the ego car and
   * the blips come afterwards and must not be eaten by this. Both edges' blooms
   * are drawn before this runs, so a car either side is feathered once, not
   * twice.
   */
  function featherEdges() {
    var f = Math.max(FEATHER_MIN_PX, cssW * FEATHER_FRAC);
    gctx.save();
    gctx.globalCompositeOperation = "destination-out";
    var ramp = function (x0, y0, x1, y1) {
      var g = gctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, "rgba(0,0,0,1)"); // at the edge: erase completely
      g.addColorStop(1, "rgba(0,0,0,0)"); // f px in: leave the bloom alone
      return g;
    };
    gctx.fillStyle = ramp(0, 0, f, 0);
    gctx.fillRect(0, 0, f, cssH);
    gctx.fillStyle = ramp(cssW, 0, cssW - f, 0);
    gctx.fillRect(cssW - f, 0, f, cssH);
    gctx.fillStyle = ramp(0, 0, 0, f);
    gctx.fillRect(0, 0, cssW, f);
    gctx.fillStyle = ramp(0, cssH, 0, cssH - f);
    gctx.fillRect(0, cssH - f, cssW, f);
    gctx.restore();
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
   * Real car dimensions per class family, METRES — `length` fore-aft, `width`
   * across. These are the published dimensions of the cars the classes actually
   * run (a 5.1 m LMH, a 4.75 m Oreca 07, a 4.76 m GT3), and they are what every
   * icon on the strip is drawn at.
   *
   * Sizing in metres rather than pixels is what makes the radar tell the truth
   * about contact: two icons meet exactly when the two cars would, whatever the
   * range is set to and however large the operator has dragged the widget. The
   * previous fixed 36 px icon could not do that on either axis — see the module
   * note. It also gets the class sizing right for free, so a Hypercar reads as
   * bigger than an LMP3 because it IS, not because of a hand-tuned multiplier.
   */
  var CAR_SIZE_M = {
    hyper: { length: 5.1, width: 2.0 },
    lmp2: { length: 4.75, width: 1.9 },
    lmp3: { length: 4.65, width: 1.9 },
    gt: { length: 4.76, width: 2.05 },
    generic: { length: 4.8, width: 2.0 },
  };

  /** A family's footprint in CSS px, as half-extents: `hl` fore-aft, `hw` across. */
  function footprint(fam) {
    var s = CAR_SIZE_M[fam] || CAR_SIZE_M.generic;
    return { hl: (s.length * pxPerM) / 2, hw: (s.width * pxPerM) / 2 };
  }

  /** The player's own shape family, refreshed once per frame in {@link update}. */
  var egoFam = "generic";

  /**
   * How solidly an opponent at (lat, lon) metres draws — 1 on top of the player,
   * 0 on the fade perimeter and beyond.
   *
   * The fade begins at the player icon's centre line, so distance reads as
   * weight from the very first metre: whatever is closest is always the most
   * solid thing on the strip, which is the order a spotter would call them in.
   * `t` is the distance to the player scaled so the perimeter is t = 1 in every
   * direction (an ellipse in metres — FADE_WIDTHS across, FADE_LENGTHS fore and
   * aft), and the square keeps the near half of that ellipse near-solid instead
   * of dropping everything to half strength the moment it leaves the centre.
   */
  function fadeAlpha(lat, lon) {
    var s = CAR_SIZE_M[egoFam] || CAR_SIZE_M.generic;
    var u = lat / (FADE_WIDTHS * s.width);
    var v = lon / (FADE_LENGTHS * s.length);
    var t = Math.sqrt(u * u + v * v);
    return t >= 1 ? 0 : 1 - t * t;
  }

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
   * Draw a sprite (or tinted canvas) centred on the current origin, nose up,
   * filling exactly the car's real footprint.
   *
   * The artwork's own aspect is deliberately NOT preserved. The PNGs are drawn
   * about 0.58 wide for 1 long, where a real car is nearer 0.40 — a stylistic
   * choice in the artwork, and harmless until the icon started standing in for
   * the car's actual extent. Fitting the art to the footprint narrows it by
   * roughly a third, which is what a car this length really looks like from
   * above, and it keeps the one property the widget needs: the edge of the icon
   * is the edge of the car.
   */
  function drawSpriteImage(src, fam) {
    var box = footprint(fam);
    gctx.drawImage(src, -box.hw, -box.hl, box.hw * 2, box.hl * 2);
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
  function drawGT(col, box) {
    var hl = box.hl, hw = box.hw;
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
  function drawProto(col, box, opts) {
    var hl = box.hl, hw = box.hw;
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

  /**
   * A Pac-Man-style ghost for a backmarker (a slower-class car being lapped).
   * Sized to the car's footprint like every other icon, so a ghost's edges mean
   * the same thing a car's do — a lapped car is still a car you can hit.
   */
  function drawGhost(col, box) {
    var w = box.hw, h = box.hl * 2;
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
    // Anything past the fade perimeter has already reached zero alpha, so it is
    // skipped outright rather than drawn invisibly. This — not the canvas edge —
    // is what bounds the strip now: a blip fades away at a few car lengths, and
    // the display range only decides how large the survivors are drawn.
    var alpha = fadeAlpha(b.lateralM, b.longitudinalM);
    if (alpha <= 0.004) return;
    if (Math.abs(b.longitudinalM) > rangeM) return;
    var latRange = lateralRangeM();
    var clampedLat = Math.max(-latRange, Math.min(latRange, b.lateralM));
    var xy = toXY(clampedLat, b.longitudinalM);
    var col = classColor(b.carClass);
    var fam = carFamily(b.carClass);
    var box = footprint(fam);

    gctx.save();
    gctx.translate(xy[0], xy[1]);
    // Everything below inherits the distance fade — silhouette, halo ring and
    // car number together, so a fading car dims as one object.
    gctx.globalAlpha = alpha;

    // Faster-class cars get a halo RING so a Hypercar bearing down reads
    // instantly — a ring rather than a filled disc, so the silhouette shows.
    // Sized just clear of the car's own footprint so it never masquerades as
    // the car's extent, which is now the one thing an icon's edge means.
    if (b.isFasterClass) {
      var halo = box.hl + 0.9 * pxPerM;
      gctx.save();
      gctx.globalAlpha = alpha * 0.22;
      gctx.fillStyle = col;
      gctx.beginPath();
      gctx.arc(0, 0, halo, 0, Math.PI * 2);
      gctx.fill();
      gctx.globalAlpha = alpha * 0.95;
      gctx.strokeStyle = col;
      gctx.lineWidth = 1.6;
      gctx.beginPath();
      gctx.arc(0, 0, halo, 0, Math.PI * 2);
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
      drawGhost(col, box);
      gctx.restore();
      return;
    }

    // Preferred path: the artwork, recoloured to this car's class. The vector
    // silhouettes below remain for the frames before the PNGs decode, for an
    // unrecognised class with no matching shape, and if the files are missing.
    var tinted = spritesReady ? tintedSprite(fam === "generic" ? "gt" : fam, col) : null;
    if (tinted) {
      drawSpriteImage(tinted, fam);
      drawCarNumber(b, box);
      gctx.restore();
      return;
    }

    if (fam === "gt") drawGT(col, box);
    else if (fam === "hyper") drawProto(col, box, { sharp: true, fin: true });
    else if (fam === "lmp2") drawProto(col, box, { sharp: false });
    else if (fam === "lmp3") drawProto(col, box, { sharp: false });
    else drawGT(col, box);

    drawCarNumber(b, box);
    gctx.restore();
  }

  /** Car number below the icon — kept off the silhouette so the shape reads. */
  function drawCarNumber(b, box) {
    if (!b.carNumber) return;
    gctx.fillStyle = "#e6ebf5";
    gctx.strokeStyle = "rgba(0,0,0,0.85)";
    gctx.lineWidth = 2.5;
    gctx.font = "bold 8px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    var ny = box.hl + 7;
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
    // Before anything is drawn: the fade perimeter is measured in the PLAYER's
    // car widths and lengths, so every blip is judged against one ring rather
    // than each rival lingering by its own size.
    egoFam = carFamily(playerClass(frame));

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
    drawEgo();
    // Draw furthest first so the nearest blip sits on top of any overlap.
    for (var j = blips.length - 1; j >= 0; j--) drawBlip(blips[j]);
  }

  window.ApexOverlay.registerWidget("radar", {
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
