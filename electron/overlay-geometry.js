/**
 * electron/overlay-geometry.js — where the in-game layer's window goes.
 * -----------------------------------------------------------------------------
 * Pure geometry, split out of main.js so it can be tested against monitor
 * arrangements nobody here owns — a left-hand portrait screen, three panels of
 * different heights, a primary display that is not the leftmost — without an
 * Electron process or those monitors. main.js supplies the real numbers from
 * `screen.getAllDisplays()`; scripts/test-ingame-layout.js supplies invented
 * ones.
 *
 * See the doc on overlayGeometryFrom for what the coordinate space is and why
 * it is measured from the primary display rather than from the desktop.
 */

'use strict';

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
 * @param {Array<{x:number,y:number,width:number,height:number}>} displays
 *   Every display's bounds, in DIP, as Electron reports them.
 * @param {{x:number,y:number,width:number,height:number}} primary
 *   The primary display's bounds.
 */
function overlayGeometryFrom(displays, primary) {
  // Seeded with the primary display so an empty or junk display list still
  // yields the old single-screen behaviour rather than an Infinity-sized window.
  let left = primary.x;
  let top = primary.y;
  let right = primary.x + primary.width;
  let bottom = primary.y + primary.height;
  const rects = [];
  for (const d of displays || []) {
    if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.y) || !(d.width > 0) || !(d.height > 0)) {
      continue;
    }
    left = Math.min(left, d.x);
    top = Math.min(top, d.y);
    right = Math.max(right, d.x + d.width);
    bottom = Math.max(bottom, d.y + d.height);
    rects.push({
      x: d.x - primary.x,
      y: d.y - primary.y,
      width: d.width,
      height: d.height,
    });
  }
  if (!rects.length) {
    rects.push({ x: 0, y: 0, width: primary.width, height: primary.height });
  }
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  return {
    bounds,
    screens: {
      padX: primary.x - left,
      padY: primary.y - top,
      width: bounds.width,
      height: bounds.height,
      primary: { width: primary.width, height: primary.height },
      rects,
    },
  };
}

module.exports = { overlayGeometryFrom };
