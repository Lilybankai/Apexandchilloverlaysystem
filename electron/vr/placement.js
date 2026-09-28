/**
 * electron/vr/placement.js — where the headset panel sits, as settings and as
 * the matrix SteamVR takes. Pure: no Electron, no OpenVR, so it is testable.
 * -----------------------------------------------------------------------------
 * ## World-locked, never head-locked (Carl, 2026-09-28)
 *
 * The panel is fixed in the SEATED tracking space: the driver puts it where
 * they want it and it stays there while their head moves, like a gauge bolted
 * to the dash. A panel that follows the head makes people sick. The seated
 * space is the one SteamVR's "Reset seated position" moves. Whether LMU's own
 * recentre key moves it too (rather than offsetting only its own camera) is
 * NOT verified yet — it is on the tester's Phase 1 checklist; if it does not,
 * Phase 2 needs a recentre of our own.
 *
 * Positions are metres from the seated origin, which is the driver's eyes at
 * the last recentre: `distance` straight ahead, `height` up (negative = below
 * eye line), `side` to the right (negative = left). The panel always turns to
 * face the origin, so moving it off to one side or down low never leaves it
 * edge-on to the driver.
 */

'use strict';

const VR_DEFAULTS = Object.freeze({
  enabled: false,
  // Just beyond a GT wheel rim, low enough to sit under the horizon.
  distance: 0.8,
  height: -0.25,
  side: 0,
  // The panel is 1340 px of widgets; at 80 cm the relative's rows come out
  // about the size of a dash readout at arm's length on a PSVR2.
  width: 0.8,
});

/** Inclusive bounds for every numeric field, in metres. */
const VR_LIMITS = Object.freeze({
  distance: [0.3, 2],
  height: [-1, 0.6],
  side: [-1.2, 1.2],
  width: [0.15, 1.5],
});

function clampField(value, key) {
  const [lo, hi] = VR_LIMITS[key];
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return VR_DEFAULTS[key];
  // Centimetre resolution: nobody can see a millimetre in a headset, and a
  // slider that writes 0.30000000000000004 into config.json helps nobody.
  return Math.round(Math.min(hi, Math.max(lo, n)) * 100) / 100;
}

/** A complete, sane `vr` settings block from whatever was stored (or nothing). */
function normalizeVr(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : VR_DEFAULTS.enabled,
    distance: clampField(s.distance ?? VR_DEFAULTS.distance, 'distance'),
    height: clampField(s.height ?? VR_DEFAULTS.height, 'height'),
    side: clampField(s.side ?? VR_DEFAULTS.side, 'side'),
    width: clampField(s.width ?? VR_DEFAULTS.width, 'width'),
  };
}

/**
 * The seated-space transform for a panel at this placement, as SteamVR's
 * HmdMatrix34_t: 12 floats, row-major 3×4, translation in the last column.
 *
 * An overlay's front faces +Z. The panel sits at (side, height, -distance) and
 * is turned by yaw θ then pitch φ so that front points back at the origin:
 *   R = Ry(θ)·Rx(φ),  θ = atan2(-side, distance),  φ = atan2(height, horiz)
 * which makes R·(0,0,1) exactly the unit vector from the panel to the eyes.
 */
function panelMatrix(placement) {
  const x = placement.side;
  const y = placement.height;
  const z = -placement.distance;
  const horiz = Math.hypot(x, placement.distance);
  const yaw = Math.atan2(-x, placement.distance);
  const pitch = Math.atan2(y, horiz);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [
    cy, sy * sp, sy * cp, x,
    0, cp, -sp, y,
    -sy, cy * sp, cy * cp, z,
  ];
}

module.exports = { VR_DEFAULTS, VR_LIMITS, normalizeVr, panelMatrix };
