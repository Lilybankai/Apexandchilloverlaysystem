/**
 * scripts/test-vr.js — the headset panels' pure parts.
 * -----------------------------------------------------------------------------
 * Nothing here needs SteamVR or a headset. It pins down the things that would
 * fail silently on a tester's rig rather than loudly on this one:
 *
 * 1. A panel FACES the driver wherever it is put, and the driver's own tilt,
 *    turn and roll rotate it the way the control panel says they do. A sign
 *    slip leaves a panel edge-on or back-to-front — SteamVR draws an overlay
 *    from its front only, so the symptom is "the panel vanished".
 *
 * 2. Settings are always complete and in range, whatever a hand-edited or old
 *    config.json holds (including the Phase 1 one-panel shape), and a slider's
 *    partial update changes exactly the one number it sent.
 *
 * 3. The OpenVR function-table layout still matches the interface versions it
 *    is pinned to. A name dropped or added shifts every slot after it, and the
 *    app then calls the wrong function — crash or worse — at the first use.
 *
 * Run: node scripts/test-vr.js
 */

'use strict';

const {
  VR_WIDGETS,
  VR_WIDGET_IDS,
  VR_LIMITS,
  VR_MFD_HIDE_CHOICES,
  VR_MFD_HIDE_DEFAULT,
  widgetDefaults,
  normalizeVr,
  mergeVr,
  enabledWidgets,
  panelMatrix,
} = require('../electron/vr/placement');
const {
  OVERLAY_FNS,
  SYSTEM_FNS,
  IVROVERLAY_VERSION,
  IVRSYSTEM_VERSION,
  VREVENT_SIZE,
} = require('../electron/vr/openvr');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const col = (m, j) => [m[j], m[4 + j], m[8 + j]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const P = (o) => ({ distance: 0.8, height: 0, side: 0, tilt: 0, turn: 0, roll: 0, ...o });

function rigid(m) {
  const [x, y, z] = [col(m, 0), col(m, 1), col(m, 2)];
  return (
    near(dot(x, x), 1) && near(dot(y, y), 1) && near(dot(z, z), 1) &&
    near(dot(x, y), 0) && near(dot(y, z), 0) && near(dot(x, z), 0) &&
    near(dot(cross(x, y), z), 1)
  );
}

/* ------------------------------ facing -------------------------------- */
console.log('\nA panel faces the driver');
{
  const cases = [
    { distance: 0.8, height: -0.25, side: 0 },
    { distance: 0.8, height: 0, side: 0 },
    { distance: 0.6, height: -0.4, side: 0.5 },
    { distance: 1.2, height: 0.3, side: -0.9 },
    { distance: 0.3, height: -1, side: 1.2 },
  ];
  for (const c of cases) {
    const m = panelMatrix(P(c));
    const at = [m[3], m[7], m[11]];
    check(
      `sits where it was put (${c.side}, ${c.height}, -${c.distance})`,
      near(at[0], c.side) && near(at[1], c.height) && near(at[2], -c.distance),
      at.map((v) => v.toFixed(3)).join(', '),
    );
    const toEyes = [-c.side, -c.height, c.distance];
    const d = dot(col(m, 2), toEyes) / Math.hypot(...toEyes);
    check(`front points at the eyes from (${c.side}, ${c.height})`, near(d, 1, 1e-9), d.toFixed(9));
    check(`rigid, no roll, from (${c.side}, ${c.height})`, rigid(m) && near(col(m, 0)[1], 0));
  }
  const straight = panelMatrix(P({ distance: 1 }));
  check(
    'straight ahead at eye height, no angles, is the identity rotation',
    [0, 1, 2, 4, 5, 6, 8, 9, 10].every((i, k) => near(straight[i], [1, 0, 0, 0, 1, 0, 0, 0, 1][k])),
  );
}

/* ---------------------------- the driver's angles ---------------------- */
console.log("\nTilt, turn and roll do what the control panel says");
{
  // Straight ahead, so the panel's frame is the world's: +Z is toward the eyes.
  const tilt = panelMatrix(P({ tilt: 30 }));
  const up = col(tilt, 1);
  check('tilt + leans the top edge AWAY (up vector goes to -Z)', up[2] < 0 && near(up[2], -Math.sin(Math.PI / 6)), up[2].toFixed(3));
  const turn = panelMatrix(P({ turn: 30 }));
  const right = col(turn, 0);
  check('turn + swings the right edge AWAY (right vector goes to -Z)', right[2] < 0 && near(right[2], -Math.sin(Math.PI / 6)), right[2].toFixed(3));
  const roll = panelMatrix(P({ roll: 30 }));
  const rx = col(roll, 0);
  check('roll + turns clockwise seen from the front (right vector dips)', rx[1] < 0 && near(rx[1], -0.5), rx[1].toFixed(3));
  check('roll keeps the panel facing the driver', near(col(roll, 2)[2], 1));

  for (const angles of [{ tilt: 180 }, { turn: -180 }, { roll: 90 }, { tilt: 45, turn: -60, roll: 170 }]) {
    const m = panelMatrix(P({ side: 0.3, height: -0.2, ...angles }));
    check(`still a rigid rotation at ${JSON.stringify(angles)}`, rigid(m));
  }
  const back = panelMatrix(P({ turn: 180 }));
  check('turn 180 shows the back (front points away)', near(col(back, 2)[2], -1));
  const offCentre = panelMatrix(P({ side: 0.5, height: -0.3 }));
  const offCentreTilted = panelMatrix(P({ side: 0.5, height: -0.3, tilt: 0 }));
  check('zero angles off-centre are exactly the auto-facing transform', offCentre.every((v, i) => near(v, offCentreTilted[i])));
  check('position is untouched by any angle', near(panelMatrix(P({ side: 0.2, tilt: 70, turn: 30, roll: 10 }))[3], 0.2));
}

/* ----------------------------- settings -------------------------------- */
console.log('\nSettings are always complete and sane');
{
  const d = normalizeVr(undefined);
  check('VR ships switched off', d.enabled === false);
  check('every VR widget has settings', VR_WIDGET_IDS.every((id) => d.widgets[id]));
  check('speedo and relative ship switched on, nothing else', JSON.stringify(enabledWidgets(d)) === '["speedo","relative"]', enabledWidgets(d).join(','));
  for (const id of VR_WIDGET_IDS) {
    const w = widgetDefaults(id);
    const inside = Object.keys(VR_LIMITS).every((k) => w[k] >= VR_LIMITS[k][0] && w[k] <= VR_LIMITS[k][1]);
    if (!inside) check(`default for ${id} is inside the limits`, false, JSON.stringify(w));
  }
  check('every default is inside the limits', true);

  const phase1 = normalizeVr({ enabled: true, distance: 1.1, height: -0.3, side: 0.2, width: 0.8 });
  check('a Phase 1 block keeps enabled', phase1.enabled === true);
  check('…and gets per-widget defaults, not its shared panel placement', phase1.widgets.speedo.distance === VR_WIDGETS.speedo.distance);

  const junk = normalizeVr({
    enabled: 'yes',
    widgets: { speedo: { on: 'no', distance: 'far', height: NaN, width: Infinity, tilt: null }, ghost: { on: true } },
  });
  check('junk enabled falls back to off', junk.enabled === false);
  check('junk on falls back to the default', junk.widgets.speedo.on === true);
  check('junk numbers fall back to defaults', junk.widgets.speedo.distance === VR_WIDGETS.speedo.distance && junk.widgets.speedo.height === VR_WIDGETS.speedo.height);
  check('Infinity is junk, not a huge panel', junk.widgets.speedo.width === VR_WIDGETS.speedo.width);
  check('an unknown widget id is dropped', !('ghost' in junk.widgets));

  const wild = normalizeVr({ widgets: { relative: { distance: 50, height: -9, side: 4, width: 0.001, tilt: 400, turn: -999, roll: 181, opacity: 0 } } }).widgets.relative;
  check('out-of-range values are clamped', wild.distance === 3 && wild.height === -1.5 && wild.side === 2 && wild.width === 0.05);
  check('angles clamp to ±180', wild.tilt === 180 && wild.turn === -180 && wild.roll === 180);
  check('opacity never reaches zero', wild.opacity === 0.1);

  const fine = normalizeVr({ widgets: { relative: { distance: 0.30000000000000004, height: -0.254, tilt: 12.6, opacity: 0.63 } } }).widgets.relative;
  check('centimetres, whole degrees, 5 % steps', fine.distance === 0.3 && fine.height === -0.25 && fine.tilt === 13 && fine.opacity === 0.65, JSON.stringify(fine));
  check('a numeric string is read as its number', normalizeVr({ widgets: { speedo: { side: '0.07' } } }).widgets.speedo.side === 0.07);
}

console.log('\nA partial update changes exactly what it sent');
{
  const base = normalizeVr({ enabled: true, widgets: { speedo: { side: 0.1, tilt: 5 } } });
  const m1 = mergeVr(base, { widgets: { speedo: { height: -0.4 } } });
  check('one field of one widget moves', m1.widgets.speedo.height === -0.4);
  check('its other fields stay', m1.widgets.speedo.side === 0.1 && m1.widgets.speedo.tilt === 5);
  check('other widgets stay', JSON.stringify(m1.widgets.relative) === JSON.stringify(base.widgets.relative));
  check('enabled stays when not sent', m1.enabled === true);
  const m2 = mergeVr(base, { widgets: { radar: { on: true } } });
  check('switching a widget on adds it to the headset', enabledWidgets(m2).includes('radar'));
  const m3 = mergeVr(base, { widgets: { speedo: null } });
  check('null puts one widget back to its defaults', JSON.stringify(m3.widgets.speedo) === JSON.stringify(widgetDefaults('speedo')));
  check('…and only that one', m3.enabled === true);
  const m4 = mergeVr(base, { enabled: false });
  check('the master switch alone leaves placements alone', m4.enabled === false && m4.widgets.speedo.side === 0.1);
  const m5 = mergeVr(base, { widgets: { speedo: { on: false }, relative: { on: false } } });
  check('every widget can be off with VR still on', m5.enabled === true && enabledWidgets(m5).length === 0);
}

/* ------------------------------ the MFD -------------------------------- */
console.log('\nThe headset MFD');
{
  const fs = require('node:fs');
  const path = require('node:path');
  const d = normalizeVr(undefined);
  check('the MFD is a VR widget', VR_WIDGET_IDS.includes('mfd'));
  check('…switched off until the driver asks for it', d.widgets.mfd.on === false);
  check('it hides after 3 s by default, as on screen', d.mfdHideSec === 3 && VR_MFD_HIDE_DEFAULT === 3);
  check('a stored choice is kept', normalizeVr({ mfdHideSec: 10 }).mfdHideSec === 10);
  check('a value off the list falls back to the default', normalizeVr({ mfdHideSec: 7 }).mfdHideSec === 3);
  check('…and junk does too', normalizeVr({ mfdHideSec: 'soon' }).mfdHideSec === 3);
  const base = normalizeVr({ enabled: true, mfdHideSec: 5 });
  check('a merge can change it', mergeVr(base, { mfdHideSec: 20 }).mfdHideSec === 20);
  check('a merge that does not send it keeps it', mergeVr(base, { widgets: { mfd: { on: true } } }).mfdHideSec === 5);
  check('a merge with a bad value keeps the current one', mergeVr(base, { mfdHideSec: 4 }).mfdHideSec === 5);
  check('every choice is whole seconds', VR_MFD_HIDE_CHOICES.every((n) => Number.isInteger(n) && n > 0));

  // Every VR widget has to be loadable on the headset page, or its panel is
  // an empty rectangle.
  const html = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'vr.html'), 'utf8');
  const shells = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'js', 'shells.js'), 'utf8');
  for (const id of VR_WIDGET_IDS) {
    const script = id === 'speedo' ? 'speedo.js' : `${id}.js`;
    check(`vr.html loads the ${id} widget`, html.includes(`js/widgets/${script}`));
  }
  check('the MFD has a shell to draw into', /\bmfd:/.test(shells));

  // The page URL pins the MFD's auto-hide on, at the driver's time.
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'vr', 'index.js'), 'utf8');
  check('the VR page pins the MFD fade on', /&fade=on&fadems=\$\{hideMs\}/.test(src));
  const hub = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'index.html'), 'utf8');
  for (const n of VR_MFD_HIDE_CHOICES) {
    check(`the Hide after list offers ${n} s`, new RegExp(`id="vr-mfd-hide"[\\s\\S]*?<option value="${n}"`).test(hub));
  }
}

/* --------------------------- OpenVR layout ----------------------------- */
console.log('\nOpenVR function tables match their pinned versions');
{
  // Counts from openvr_capi.h (openvr master, 2026-09): VR_IVROverlay_FnTable
  // for IVROverlay_028 and VR_IVRSystem_FnTable for IVRSystem_026.
  check('pinned to IVROverlay_028', IVROVERLAY_VERSION === 'IVROverlay_028');
  check('pinned to IVRSystem_026', IVRSYSTEM_VERSION === 'IVRSystem_026');
  check('IVROverlay_028 has 82 slots', OVERLAY_FNS.length === 82, OVERLAY_FNS.length);
  check('IVRSystem_026 has 51 slots', SYSTEM_FNS.length === 51, SYSTEM_FNS.length);
  check('no duplicate overlay names', new Set(OVERLAY_FNS).size === OVERLAY_FNS.length);
  check('no duplicate system names', new Set(SYSTEM_FNS).size === SYSTEM_FNS.length);

  // The slots actually called, at the positions the header puts them.
  const expectOverlay = {
    CreateOverlay: 1,
    DestroyOverlay: 3,
    GetOverlayErrorNameFromEnum: 8,
    SetOverlayFlag: 11,
    SetOverlayAlpha: 16,
    SetOverlayWidthInMeters: 22,
    SetOverlayTextureBounds: 30,
    SetOverlayTransformAbsolute: 33,
    ShowOverlay: 43,
    HideOverlay: 44,
    IsOverlayVisible: 45,
    SetOverlayTexture: 60,
  };
  for (const [name, idx] of Object.entries(expectOverlay)) {
    check(`IVROverlay.${name} is slot ${idx}`, OVERLAY_FNS.indexOf(name) === idx, OVERLAY_FNS.indexOf(name));
  }
  const expectSystem = { GetDXGIOutputInfo: 8, PollNextEvent: 30, AcknowledgeQuit_Exiting: 47, GetRuntimeVersion: 49 };
  for (const [name, idx] of Object.entries(expectSystem)) {
    check(`IVRSystem.${name} is slot ${idx}`, SYSTEM_FNS.indexOf(name) === idx, SYSTEM_FNS.indexOf(name));
  }
  check('VREvent_t is 64 bytes on Windows x64', VREVENT_SIZE === 64);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
