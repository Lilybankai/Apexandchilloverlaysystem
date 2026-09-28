/**
 * vr-layout.js — packs the headset page's widgets into one image.
 * -----------------------------------------------------------------------------
 * Runs only on vr.html. The page is never seen as a page: it is painted into
 * one texture, and each widget becomes its own panel in the headset showing
 * only its own rectangle of it (see electron/vr/vrWorker.js). So the layout
 * here has one job — put every widget somewhere, without overlaps, in as
 * little area as it can, and say where — and none of the jobs a visible
 * layout has.
 *
 * Area is the whole cost: every pixel of the page is copied once per frame,
 * at twice the resolution in each direction (RENDER_SCALE in
 * electron/vr/index.js). A plain row-by-row layout wasted over half the image
 * the first time it was measured (a tall standings tower beside the speedo
 * left the space under the speedo empty), so widgets are skyline-packed: tallest
 * first, each into the lowest spot it fits, in a strip about as wide as the
 * square root of their total area.
 *
 * {@link GAP} px of transparency surrounds each widget. It is not cosmetic:
 * the compositor filters the texture when it draws a panel, and a widget packed
 * flush against its neighbour would pick up a hairline of the neighbour's edge.
 *
 * The app asks for the layout (window.__apexVrLayout) after the page loads and
 * once a second after that, because a widget's height is data-driven — the
 * standings tower grows with the field — and resizes the window to fit.
 */
(function () {
  "use strict";

  var GAP = 8;
  var MAX_WIDTH = 2048;

  /**
   * Skyline bottom-left packing. `items` are {id, w, h} (gap included); returns
   * {id: {x, y}} and the height used. The skyline is a list of segments
   * {x, y, w} covering [0, width) — the top of what has been placed so far.
   */
  function pack(items, width) {
    var sky = [{ x: 0, y: 0, w: width }];
    var out = {};
    var height = 0;
    for (var n = 0; n < items.length; n++) {
      var it = items[n];
      var best = null;
      for (var i = 0; i < sky.length; i++) {
        var x = sky[i].x;
        if (x + it.w > width) break;
        var y = 0;
        for (var j = i; j < sky.length && sky[j].x < x + it.w; j++) {
          if (sky[j].y > y) y = sky[j].y;
        }
        if (!best || y < best.y || (y === best.y && x < best.x)) best = { x: x, y: y };
      }
      if (!best) best = { x: 0, y: height }; // wider than the strip: below everything
      out[it.id] = best;
      if (best.y + it.h > height) height = best.y + it.h;
      // Raise the skyline over [best.x, best.x + it.w).
      var left = best.x;
      var right = best.x + it.w;
      var next = [];
      for (var k = 0; k < sky.length; k++) {
        var s = sky[k];
        var sEnd = s.x + s.w;
        if (sEnd <= left || s.x >= right) {
          next.push(s);
          continue;
        }
        if (s.x < left) next.push({ x: s.x, y: s.y, w: left - s.x });
        if (sEnd > right) next.push({ x: right, y: s.y, w: sEnd - right });
      }
      next.push({ x: left, y: best.y + it.h, w: it.w });
      next.sort(function (a, b) { return a.x - b.x; });
      sky = next;
    }
    return { at: out, height: height };
  }

  function layout() {
    var slots = Array.prototype.slice.call(document.querySelectorAll(".vr-slot"));
    var items = [];
    var area = 0;
    var widest = 0;
    for (var i = 0; i < slots.length; i++) {
      var w = Math.ceil(slots[i].offsetWidth);
      var h = Math.ceil(slots[i].offsetHeight);
      if (!w || !h) continue;
      var item = { id: slots[i].getAttribute("data-id"), slot: slots[i], w: w + GAP, h: h + GAP, cw: w, ch: h, order: i };
      items.push(item);
      area += item.w * item.h;
      if (item.w > widest) widest = item.w;
    }
    // Tallest first; list order breaks ties, so the layout does not reshuffle
    // between two widgets of the same height from one poll to the next.
    items.sort(function (a, b) { return b.h - a.h || a.order - b.order; });
    var strip = Math.min(MAX_WIDTH, Math.max(widest, Math.ceil(Math.sqrt(area) * 1.15)));
    var packed = pack(items, strip);
    var rects = {};
    var width = 0;
    for (var n = 0; n < items.length; n++) {
      var it = items[n];
      var p = packed.at[it.id];
      var x = p.x + GAP;
      var y = p.y + GAP;
      it.slot.style.left = x + "px";
      it.slot.style.top = y + "px";
      rects[it.id] = { x: x, y: y, w: it.cw, h: it.ch };
      if (p.x + it.w + GAP > width) width = p.x + it.w + GAP;
    }
    return { width: Math.max(1, width), height: Math.max(1, packed.height + 2 * GAP), rects: rects };
  }

  window.__apexVrLayout = layout;
})();
