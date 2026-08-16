/**
 * raster.js — how many real pixels a <canvas> should be drawn with.
 * -----------------------------------------------------------------------------
 * Every canvas widget (pedals, pedalsv, motion, radar, trackmap, speedo) sizes
 * its bitmap to `CSS size x backing scale` and then calls
 * `setTransform(scale, 0, 0, scale, 0, 0)` so its drawing code can keep working
 * in CSS pixels. This module owns that scale, because getting it from
 * `devicePixelRatio` alone was wrong on exactly the screens that matter most.
 *
 * THE BUG THIS EXISTS TO FIX
 *
 * Both of the overlay's rendering paths put the widgets inside a CSS transform:
 *
 *   - the OBS pages (index.html) draw into a fixed 1920x1080 `.stage` that is
 *     `transform: scale()`d to the Browser Source size — so a 4K source scales
 *     the whole design by 2;
 *   - the in-game layer scales each widget on its own, `transform: scale(n)`
 *     with n up to 3 (overlay/js/ingame.js), which is how a driver makes the
 *     overlay readable on a big screen or a 4K TV.
 *
 * Chromium re-rasterises TEXT and BORDERS under a transform, so the CSS widgets
 * stay sharp at any scale. A canvas does not: its bitmap is whatever was
 * allocated, and the transform magnifies that bitmap like a photo. And the
 * allocation was keyed on `canvas.clientWidth`, which is the element's
 * PRE-TRANSFORM layout width — so a widget scaled to 2x got a 1x bitmap blown
 * up to twice its size. On the driver's own monitor at scale 1 nothing was
 * visibly wrong, which is why this survived: it only showed up on a big screen,
 * or on a stream watched back at 4K, where the drawn widgets (track map, radar,
 * pedal traces) were soft while the text beside them was pin sharp.
 *
 * `getBoundingClientRect()` reports the POST-transform box, so dividing it by
 * the layout box recovers the accumulated scale of every ancestor — which means
 * one helper covers both paths without either of them having to tell us which
 * page the widget is on, or a widget having to know it is being scaled at all.
 */
(function () {
  "use strict";

  /**
   * Ceiling on the backing scale. The in-game scale caps at 3 and can sit on top
   * of a 2x device ratio, so the honest product reaches 6 — and a track map at
   * 900 CSS px wide would then allocate a 5400px bitmap and rebake its cached
   * circuit path into it on every resize. 4 is past the point where more pixels
   * are visible on any real display and keeps the worst case affordable on the
   * integrated GPUs some drivers stream from.
   */
  var MAX_BACKING = 4;

  /**
   * The scale `el`'s bitmap should be drawn at: the device pixel ratio times the
   * accumulated CSS transform on it.
   *
   * Floored at the device ratio rather than following a scale below 1. A widget
   * scaled down needs fewer pixels in theory, but the widgets draw hairlines and
   * small type in CSS units, and thinning their backing store is how those turn
   * to mush — the pixels saved are not worth the one thing this module exists to
   * protect.
   *
   * Rounded to 2 decimals so a sub-pixel jitter in the measured rectangle cannot
   * flip the computed bitmap size back and forth. Callers treat a size change as
   * "reallocate and rebake every cache", so an unstable scale here would be an
   * expensive loop rather than a cosmetic wobble.
   *
   * @param {Element} el element whose on-screen scale is wanted (the canvas).
   * @returns {number} backing scale, >= devicePixelRatio, <= MAX_BACKING.
   */
  function backingScale(el) {
    var dpr = window.devicePixelRatio || 1;
    if (!el || typeof el.getBoundingClientRect !== "function") return dpr;

    // offsetWidth, not clientWidth: getBoundingClientRect() measures the border
    // box, and clientWidth excludes the border. Dividing one by the other would
    // report a widget as permanently 1.007x scaled and allocate an odd-sized
    // bitmap on every single widget that has a 1px border — which is all of them.
    var layout = el.offsetWidth;
    if (!layout) return dpr;

    var rect = el.getBoundingClientRect();
    if (!rect || !rect.width) return dpr;

    var eff = rect.width / layout;
    if (!isFinite(eff) || eff < 1) eff = 1;

    var scale = Math.round(dpr * eff * 100) / 100;
    return scale > MAX_BACKING ? MAX_BACKING : scale;
  }

  window.ApexRaster = {
    backingScale: backingScale,
    MAX_BACKING: MAX_BACKING,
  };
})();
