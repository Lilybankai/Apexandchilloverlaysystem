/**
 * overlay/js/notch-dock.js — seat the delta widget in the speedo cluster's notch.
 * -----------------------------------------------------------------------------
 * The delta's bottom edge is cut to the shape of the recess in the top of the
 * speedo cluster, so the two read as one piece of bezel rather than a panel
 * parked on top of another. This file is what keeps that cut honest.
 *
 * It exists because the first version of the docking did the conversion BY HAND.
 * The cluster's notch is authored in a 1000-unit design box (NOTCH_L/NOTCH_R/CH/
 * NOTCH_TOP in widgets/speedo.js); someone multiplied those by 0.49 — the ratio
 * for one cluster width, 490px — and pasted `95px / 72.5px / 25.5px` into
 * overlay.css. That is correct at exactly one size and wrong at every other, and
 * nothing linked the copy back to the original, so resizing the cluster slid the
 * notch out from under a cut that stayed where it was. The screenshot that
 * prompted this rewrite is that divergence.
 *
 * So: measure, never restate. The profile comes from `ApexSpeedo.NOTCH` (design
 * units, derived from the silhouette's own constants) and the scale comes from a
 * live `getBoundingClientRect()` of the stage the artwork is actually drawn into.
 *
 * Three details that are easy to get wrong and account for most of the residual
 * misfit in the hand-converted version:
 *
 *  1. The artwork is fitted into the stage with letterboxing — `s = min(w/DW,
 *     h/DH)` and a centring offset — exactly as `placeBoxes()` in speedo.js does
 *     it. Dragging the cluster's bottom edge pins a height, and from then on the
 *     shell is NARROWER than the stage and pushed DOWN by half the slack. Using
 *     width alone (as `× 0.49` implicitly did) puts the notch in the wrong place
 *     and the wrong size the moment anyone height-boxes the cluster.
 *  2. `clip-path` is resolved in the element's own coordinate space, BEFORE its
 *     transform. The in-game layer scales widgets with `transform: scale()`, so
 *     a measurement in screen pixels has to be divided back through the delta's
 *     own scale or the cut comes out wrong by that factor.
 *  3. The notch is not necessarily under the delta's centre. The polygon used to
 *     assume it was (`50% ± half`), which is only true while both widgets sit on
 *     the same centre line; nudging either one sideways sheared the cut off the
 *     recess. `--notch-cx` carries that offset so the cut tracks the real notch.
 *
 * Only the Apex cluster design has a notch. The LMP2 design is a flat plate
 * (widgets/speedo-lmp2.js, a 1200×720 box), so there is nothing to measure and
 * the stylesheet's own values stand — as they do on the combined OBS page and
 * the standalone widget source, where there is no cluster on the page at all.
 */

(function () {
  "use strict";

  /** The design that owns the notch; every other one is a flat plate. */
  var NOTCHED_DESIGN = "apex";

  /**
   * The stage the cluster's artwork is drawn into, but only when the design up
   * is the one with a notch in it. `data-design` is written by buildDesign() in
   * speedo.js; its absence means the default (Apex) design, not "no design".
   */
  function notchedStage() {
    var stage = document.querySelector('#widget-speedo [data-role="stage"]');
    if (!stage) return null;
    var design = stage.getAttribute("data-design") || NOTCHED_DESIGN;
    return design === NOTCHED_DESIGN ? stage : null;
  }

  /**
   * Where the notch actually is on screen, in CSS pixels, or null if there is
   * no cluster to measure. `rimY` is the shell's own y=0 — the top edge the
   * delta's flanks rest on — and `plateauY` is the floor of the recess its
   * chamfered tip comes down to.
   */
  function notchRect() {
    var api = window.ApexSpeedo;
    if (!api || !api.NOTCH || !api.DESIGN) return null;
    var stage = notchedStage();
    if (!stage) return null;

    var r = stage.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;

    // The same fit-inside-and-centre the canvas uses (speedo.js placeBoxes).
    var s = Math.min(r.width / api.DESIGN.w, r.height / api.DESIGN.h);
    var ox = (r.width - api.DESIGN.w * s) / 2;
    var oy = (r.height - api.DESIGN.h * s) / 2;

    var depth = api.NOTCH.depth * s;
    return {
      cx: r.left + ox + (api.DESIGN.w * s) / 2,
      rimY: r.top + oy,
      plateauY: r.top + oy + depth,
      rimHalf: api.NOTCH.rimHalf * s,
      tipHalf: api.NOTCH.tipHalf * s,
      depth: depth,
      scale: s,
    };
  }

  /**
   * The delta's rendered scale. Measured rather than read off the layout,
   * because this file also runs on pages that have no layout manager: the ratio
   * of the drawn box to the laid-out box is the transform whatever put it there.
   */
  function renderedScale(el) {
    var w = el.offsetWidth;
    if (!w) return 1;
    var drawn = el.getBoundingClientRect().width;
    return drawn > 0 ? drawn / w : 1;
  }

  /**
   * Re-cut the delta's bottom edge to the cluster as it is right now. Safe to
   * call on any page and at any time; it does nothing when either widget is
   * missing, so the stylesheet's authored fallback stands.
   */
  function measure() {
    var delta = document.getElementById("widget-delta");
    if (!delta) return false;

    var notch = notchRect();
    if (!notch) return false;

    // Back out of screen space into the delta's own, which is what clip-path
    // resolves against — see (2) in the header.
    var ds = renderedScale(delta);
    var dr = delta.getBoundingClientRect();
    var deltaCx = dr.left + dr.width / 2;

    delta.style.setProperty("--notch-rim-half", (notch.rimHalf / ds).toFixed(2) + "px");
    delta.style.setProperty("--notch-tip-half", (notch.tipHalf / ds).toFixed(2) + "px");
    delta.style.setProperty("--notch-depth", (notch.depth / ds).toFixed(2) + "px");
    delta.style.setProperty("--notch-cx", ((notch.cx - deltaCx) / ds).toFixed(2) + "px");
    return true;
  }

  /**
   * The top the delta wants, in screen pixels, for its tip to come down onto the
   * plateau exactly. Returned rather than applied: on the in-game layer the
   * position is the operator's to set and is persisted, so the layout manager
   * decides whether to use this (magnetic docking) or leave the widget be.
   */
  function seatTop() {
    var delta = document.getElementById("widget-delta");
    if (!delta) return null;
    var notch = notchRect();
    if (!notch) return null;
    return notch.plateauY - delta.getBoundingClientRect().height;
  }

  /* ------------------------------- observers ------------------------------ */

  /*
   * Content-driven changes — the operator's Text size slider growing the delta's
   * track, the cluster reflowing — arrive here. Position changes do NOT: moving
   * a widget does not resize it. The in-game layout manager calls measure()
   * directly from applyItem(), which is its single write path for both.
   */
  var observer = null;

  function watch() {
    if (observer || typeof ResizeObserver !== "function") return;
    observer = new ResizeObserver(function () {
      measure();
    });
    var delta = document.getElementById("widget-delta");
    var stage = notchedStage();
    if (delta) observer.observe(delta);
    if (stage) observer.observe(stage);
  }

  function start() {
    measure();
    watch();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
  // The cluster builds its stage asynchronously (initDispatch → buildDesign), so
  // the first measure can land before there is anything to measure. A load pass
  // catches that without polling.
  window.addEventListener("load", start);
  window.addEventListener("resize", measure);

  window.ApexNotchDock = {
    measure: measure,
    notchRect: notchRect,
    seatTop: seatTop,
  };
})();
