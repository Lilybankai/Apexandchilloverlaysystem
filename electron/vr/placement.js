/**
 * electron/vr/placement.js — which widgets are in the headset, where each one
 * sits, and the matrix SteamVR takes for it. Pure: no Electron, no OpenVR, so
 * it is testable.
 * -----------------------------------------------------------------------------
 * ## World-locked, never head-locked (Carl, 2026-09-28)
 *
 * Every panel is fixed in the SEATED tracking space: the driver puts it where
 * they want it and it stays there while their head moves, like a gauge bolted
 * to the dash. A panel that follows the head makes people sick. The seated
 * space is the one SteamVR's "Reset seated position" moves, and — verified by
 * the PSVR2 tester, 2026-09-28 — LMU's own recentre key moves it too, so the
 * panels stay lined up with the cockpit through a recentre. No recentre of
 * our own is needed.
 *
 * ## One panel per widget (Phase 2, from the PSVR2 tester's first session)
 *
 * Phase 1 put the speedo and relative side by side on one panel. The tester
 * wanted each where he chose — "like the normal overlay system" — and each
 * switchable on its own. So every widget carries its own placement here, and
 * the worker gives each its own SteamVR overlay.
 *
 * Positions are metres from the seated origin, which is the driver's eyes at
 * the last recentre: `distance` straight ahead, `height` up (negative = below
 * eye line), `side` to the right (negative = left). With every angle at zero a
 * panel turns to face the driver wherever it is put; `tilt`, `turn` and `roll`
 * (degrees) rotate it from there — tilt leans the top edge away, turn swings
 * the right edge away, roll turns it clockwise in its own plane.
 *
 * SteamVR draws overlays over the game's picture, never behind anything in it:
 * a panel over the wheel covers the driver's hands whatever its distance. That
 * cannot be changed from outside the game (only drawing inside LMU could, which
 * is what EAC exists to stop), so `opacity` is the tool for a panel that has to
 * overlap the wheel, and placement clear of it is the real answer.
 */

'use strict';

/**
 * The widgets that can go in the headset, in the order the control panel lists
 * them, and where each first appears. The pixel width each is drawn at lives
 * in overlay/css/vr.css. Interactive widgets (MFD, fuel planner) and chat are
 * left out: nobody can click a panel in a headset. Every id here needs its
 * widget script in overlay/vr.html.
 */
const VR_WIDGETS = Object.freeze({
  speedo: { on: true, distance: 0.8, height: -0.32, side: 0, width: 0.5 },
  relative: { on: true, distance: 0.8, height: -0.12, side: 0.42, width: 0.26 },
  standings: { on: false, distance: 0.9, height: 0.05, side: -0.55, width: 0.34 },
  delta: { on: false, distance: 0.8, height: -0.08, side: 0, width: 0.18 },
  pacedelta: { on: false, distance: 0.8, height: 0.08, side: 0, width: 0.2 },
  refpace: { on: false, distance: 0.85, height: 0.1, side: 0.42, width: 0.2 },
  radar: { on: false, distance: 0.8, height: -0.12, side: -0.42, width: 0.2 },
  fuel: { on: false, distance: 0.85, height: 0.1, side: 0.45, width: 0.24 },
  tyres: { on: false, distance: 0.8, height: -0.32, side: 0.42, width: 0.18 },
  trackmap: { on: false, distance: 0.85, height: 0.1, side: -0.45, width: 0.26 },
  pedals: { on: false, distance: 0.8, height: -0.42, side: -0.3, width: 0.2 },
  weather: { on: false, distance: 0.9, height: 0.25, side: 0, width: 0.26 },
  racecontrol: { on: false, distance: 0.85, height: 0.18, side: 0, width: 0.2 },
  damage: { on: false, distance: 0.8, height: -0.32, side: -0.42, width: 0.16 },
  limits: { on: false, distance: 0.85, height: 0.12, side: 0.2, width: 0.2 },
});

const VR_WIDGET_IDS = Object.freeze(Object.keys(VR_WIDGETS));

/** Inclusive bounds for every numeric per-widget field. Metres, degrees, 0–1. */
const VR_LIMITS = Object.freeze({
  distance: [0.2, 3],
  height: [-1.5, 1.5],
  side: [-2, 2],
  width: [0.05, 2],
  tilt: [-180, 180],
  turn: [-180, 180],
  roll: [-180, 180],
  // Not zero: a panel faded to nothing is a panel the driver thinks is broken.
  // Switching it off is the switch's job.
  opacity: [0.1, 1],
});

/** Resolution each field is stored at: centimetres, whole degrees, 5 %. */
const VR_STEP = Object.freeze({
  distance: 0.01,
  height: 0.01,
  side: 0.01,
  width: 0.01,
  tilt: 1,
  turn: 1,
  roll: 1,
  opacity: 0.05,
});

const PLACEMENT_KEYS = Object.freeze(Object.keys(VR_LIMITS));

/** A widget's placement as it ships. */
function widgetDefaults(id) {
  const w = VR_WIDGETS[id];
  return {
    on: w.on,
    distance: w.distance,
    height: w.height,
    side: w.side,
    width: w.width,
    tilt: 0,
    turn: 0,
    roll: 0,
    opacity: 1,
  };
}

function clampField(value, key, fallback) {
  const [lo, hi] = VR_LIMITS[key];
  const n = typeof value === 'number' ? value : Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return fallback;
  // Stored at the step's resolution: nobody can see a millimetre in a headset,
  // and a slider that writes 0.30000000000000004 into config.json helps nobody.
  const step = VR_STEP[key];
  const snapped = Math.round(Math.min(hi, Math.max(lo, n)) / step) * step;
  return Math.round(snapped * 1000) / 1000;
}

function normalizeWidget(id, stored) {
  const d = widgetDefaults(id);
  const s = stored && typeof stored === 'object' ? stored : {};
  const out = { on: typeof s.on === 'boolean' ? s.on : d.on };
  for (const key of PLACEMENT_KEYS) out[key] = clampField(s[key], key, d[key]);
  return out;
}

/**
 * A complete, sane `vr` settings block from whatever was stored (or nothing).
 * Unknown widget ids are dropped; missing ones get their defaults, so a widget
 * added in a later release simply appears in the list, switched off.
 *
 * A Phase 1 block (one shared panel: {enabled, distance, height, side, width})
 * keeps only `enabled` — its placement was for a 1340 px two-widget panel and
 * means nothing for either widget on its own.
 */
function normalizeVr(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const widgets = {};
  const storedWidgets = s.widgets && typeof s.widgets === 'object' ? s.widgets : {};
  for (const id of VR_WIDGET_IDS) widgets[id] = normalizeWidget(id, storedWidgets[id]);
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : false,
    widgets,
  };
}

/**
 * Merge a partial update from the control panel into the current block:
 * `{enabled}` and/or `{widgets: {id: {field: value}}}`, field by field, so a
 * slider sends only its own number. `{widgets: {id: null}}` puts that widget
 * back to its defaults.
 */
function mergeVr(current, patch) {
  const cur = normalizeVr(current);
  if (!patch || typeof patch !== 'object') return cur;
  const next = { enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled, widgets: {} };
  const pw = patch.widgets && typeof patch.widgets === 'object' ? patch.widgets : {};
  for (const id of VR_WIDGET_IDS) {
    if (pw[id] === null) next.widgets[id] = widgetDefaults(id);
    else if (pw[id] && typeof pw[id] === 'object') next.widgets[id] = { ...cur.widgets[id], ...pw[id] };
    else next.widgets[id] = cur.widgets[id];
  }
  return normalizeVr(next);
}

/** The ids switched on, in list order. */
function enabledWidgets(vr) {
  return VR_WIDGET_IDS.filter((id) => vr && vr.widgets && vr.widgets[id] && vr.widgets[id].on);
}

const DEG = Math.PI / 180;

/** 3×3 product, row-major arrays of 9. */
function mul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

const rotX = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotZ = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

/**
 * The seated-space transform for a panel at this placement, as SteamVR's
 * HmdMatrix34_t: 12 floats, row-major 3×4, translation in the last column.
 *
 * An overlay's front faces +Z. The panel sits at (side, height, -distance).
 * First it is turned to face the eyes — yaw θ = atan2(-side, distance), then
 * pitch φ = atan2(height, horizontal distance), which makes the front point
 * exactly back at the origin — and then the driver's own angles are applied in
 * the panel's frame: turn about its vertical axis, tilt about its horizontal
 * one, roll about its facing axis. With all three at zero it is the Phase 1
 * facing transform exactly.
 */
function panelMatrix(p) {
  const x = p.side;
  const y = p.height;
  const z = -p.distance;
  const horiz = Math.hypot(x, p.distance);
  const face = mul3(rotY(Math.atan2(-x, p.distance)), rotX(Math.atan2(y, horiz)));
  // Tilt: top edge AWAY from the driver for a positive value (a negative X
  // rotation). Turn: right edge away (a positive Y rotation moves +X to -Z).
  // Roll: clockwise as seen from the front (a negative Z rotation).
  const own = mul3(mul3(rotY((p.turn || 0) * DEG), rotX(-(p.tilt || 0) * DEG)), rotZ(-(p.roll || 0) * DEG));
  const r = mul3(face, own);
  return [r[0], r[1], r[2], x, r[3], r[4], r[5], y, r[6], r[7], r[8], z];
}

module.exports = {
  VR_WIDGETS,
  VR_WIDGET_IDS,
  VR_LIMITS,
  VR_STEP,
  widgetDefaults,
  normalizeVr,
  mergeVr,
  enabledWidgets,
  panelMatrix,
};
