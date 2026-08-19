/**
 * electron/overlay-geometry.js — where the in-game layer's window goes.
 * -----------------------------------------------------------------------------
 * Pure geometry, split out of main.js so it can be tested against monitor
 * arrangements nobody here owns — a left-hand portrait screen, three panels of
 * different heights, a primary display that is not the leftmost, a screen
 * stacked above another at a different Windows scaling — without an Electron
 * process or those monitors. main.js supplies the real numbers from
 * `screen.getAllDisplays()`; scripts/test-ingame-layout.js supplies invented
 * ones.
 *
 * See the doc on overlayGeometryFrom for what the coordinate space is and why
 * it is measured from the primary display rather than from the desktop.
 */

'use strict';

/**
 * The mapping used when the display rects already are in the window's own pixel
 * space — every uniform-DPI desktop, which is all of them bar the mixed ones.
 * Identity by reference as well as by value, so `rebase` can skip the work and
 * hand the caller's own object straight back.
 */
const SAME_SPACE = (rect) => rect;

/**
 * Move one rect into the overlay window's pixel space, refusing anything the
 * mapping cannot produce a sane answer for.
 *
 * Falling back to the UNMAPPED rect on a bad conversion is deliberate: the
 * worst case is then exactly the behaviour this file had before the mapping
 * existed, which is correct everywhere except the mixed-scaling desktops the
 * mapping is for. A throw here would take the overlay window down with it.
 */
function rebase(rect, map) {
  if (map === SAME_SPACE) return rect;
  let out = null;
  try {
    out = map(rect);
  } catch (e) {
    out = null;
  }
  if (
    !out ||
    !Number.isFinite(out.x) ||
    !Number.isFinite(out.y) ||
    !(out.width > 0) ||
    !(out.height > 0)
  ) {
    return rect;
  }
  return out;
}

/**
 * Bounds for the overlay window, plus the geometry the page lays widgets out
 * against.
 *
 * The window spans the union of every display, not the primary one. That is the
 * whole of what lets a triple-screen rig put the delta on the right-hand screen
 * and the tyres on the left: the layer previously *was* the middle monitor, so
 * there was no canvas either side to drag onto. Rigs running NVIDIA Surround
 * never hit this, because Surround hands Windows one 5760-wide display — the
 * union is then that single display, and on a single monitor the union is the
 * monitor, so for both of those this returns exactly the bounds it always did.
 *
 * `screens` is expressed in LAYOUT coordinates: (0, 0) is the top-left of the
 * primary display, not of the desktop. Two things fall out of anchoring there,
 * both of which matter more than the extra subtraction costs:
 *
 *   - nobody's saved layout moves on upgrade. Desktop coordinates would put the
 *     origin on the left-hand monitor, so every widget an existing tester has
 *     placed would silently jump one screen left the first time they updated.
 *   - the reference survives the desktop changing shape. Unplug the left screen
 *     and the desktop origin moves; the primary display's does not, so widgets
 *     on the remaining screens stay where they were put.
 *
 * A widget parked on a left-hand screen therefore carries a negative x, which is
 * why the renderer's clamps can no longer assume 0 is the left edge.
 *
 * `padX`/`padY` are the one number the page needs to turn a layout coordinate
 * into a CSS one: how far the primary display's top-left sits from the window's.
 * Both are 0 whenever nothing is left of / above the main screen — which is to
 * say, always, on the single-monitor rigs this must not disturb.
 *
 * ---------------------------------------------------------------------------
 * WHICH PIXELS THESE NUMBERS ARE, AND WHY IT NEEDED SAYING
 *
 * Every rect in and out of here has to live in ONE pixel space, and on Windows
 * that is not automatic. `screen.getAllDisplays()` reports each display in ITS
 * OWN DIP — a 4K panel at 150% scaling arrives as 2560×1440, a 1080p panel next
 * to it at 100% as 1920×1080 — so the union of those rects is not a rectangle
 * measured in anything. A Chromium window, meanwhile, has a SINGLE device scale
 * factor for its whole self (Windows picks it from whichever monitor the window
 * overlaps most), and both `setBounds` and the page's CSS pixels are in that one
 * scale. Mix the two and the window comes out short: a tester with a 4K screen
 * at 150% under a 100% one found the layer covering the top two-thirds of it,
 * with widgets refusing to be dragged any lower — 2560 of DIP laid out as 2560
 * physical pixels on a 3840-pixel panel.
 *
 * So `displays`/`primary` are in whatever space the caller measured (PHYSICAL
 * screen pixels, from main.js on Windows), and `toWindow` maps that space into
 * the window's. Omit it and nothing is rebased, which is right for every desktop
 * whose screens share a scale factor: there the two spaces are the same one, and
 * every number below is what it has always been.
 *
 * @param {Array<{x:number,y:number,width:number,height:number}>} displays
 *   Every display's bounds, in one consistent pixel space.
 * @param {{x:number,y:number,width:number,height:number}} primary
 *   The primary display's bounds, in that same space.
 * @param {(rect: {x:number,y:number,width:number,height:number}) =>
 *   {x:number,y:number,width:number,height:number}} [toWindow]
 *   Maps that space into the overlay window's own pixel space. Optional; the
 *   identity when absent.
 */
function overlayGeometryFrom(displays, primary, toWindow) {
  const map = typeof toWindow === 'function' ? toWindow : SAME_SPACE;
  const base = rebase(primary, map);
  // Seeded with the primary display so an empty or junk display list still
  // yields the old single-screen behaviour rather than an Infinity-sized window.
  let left = base.x;
  let top = base.y;
  let right = base.x + base.width;
  let bottom = base.y + base.height;
  const rects = [];
  for (const raw of displays || []) {
    if (
      !raw ||
      !Number.isFinite(raw.x) ||
      !Number.isFinite(raw.y) ||
      !(raw.width > 0) ||
      !(raw.height > 0)
    ) {
      continue;
    }
    // Rebased one display at a time, because that is the only granularity the
    // mapping is defined at: each rect is measured against the scale factor of
    // the screen it belongs to, and only the result is comparable across them.
    const d = rebase(raw, map);
    left = Math.min(left, d.x);
    top = Math.min(top, d.y);
    right = Math.max(right, d.x + d.width);
    bottom = Math.max(bottom, d.y + d.height);
    rects.push({
      x: d.x - base.x,
      y: d.y - base.y,
      width: d.width,
      height: d.height,
    });
  }
  if (!rects.length) {
    rects.push({ x: 0, y: 0, width: base.width, height: base.height });
  }
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  return {
    bounds,
    screens: {
      padX: base.x - left,
      padY: base.y - top,
      width: bounds.width,
      height: bounds.height,
      primary: { width: base.width, height: base.height },
      rects,
    },
  };
}

module.exports = { overlayGeometryFrom };
