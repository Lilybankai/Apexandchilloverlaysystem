/**
 * scripts/test-vr.js — the headset panel's pure parts.
 * -----------------------------------------------------------------------------
 * Nothing here needs SteamVR or a headset. It pins down the three things that
 * would fail silently on a tester's rig rather than loudly on this one:
 *
 * 1. The panel FACES the driver wherever it is put. A sign slip in the yaw or
 *    pitch leaves it edge-on or back-to-front — SteamVR draws an overlay from
 *    its front only, so the symptom is "the panel vanished when I moved it".
 *
 * 2. Placement settings are always complete and in range, whatever a hand-
 *    edited or old config.json holds. A NaN in the transform puts the panel
 *    nowhere at all.
 *
 * 3. The OpenVR function-table layout still matches the interface versions it
 *    is pinned to. A name dropped or added shifts every slot after it, and the
 *    panel then calls the wrong function — crash or worse — at the first use.
 *
 * Run: node scripts/test-vr.js
 */

'use strict';

const { VR_DEFAULTS, VR_LIMITS, normalizeVr, panelMatrix } = require('../electron/vr/placement');
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

/* ------------------------------ facing -------------------------------- */
console.log('\nThe panel faces the driver');
{
  const cases = [
    { distance: 0.8, height: -0.25, side: 0 },
    { distance: 0.8, height: 0, side: 0 },
    { distance: 0.6, height: -0.4, side: 0.5 },
    { distance: 1.2, height: 0.3, side: -0.9 },
    { distance: 0.3, height: -1, side: 1.2 },
  ];
  for (const c of cases) {
    const m = panelMatrix(c);
    // Translation column = where it was asked to be.
    const at = [m[3], m[7], m[11]];
    check(
      `sits where it was put (${c.side}, ${c.height}, -${c.distance})`,
      near(at[0], c.side) && near(at[1], c.height) && near(at[2], -c.distance),
      at.map((v) => v.toFixed(3)).join(', '),
    );
    // Its front (+Z column of the rotation) points at the eyes.
    const front = [m[2], m[6], m[10]];
    const toEyes = [-c.side, -c.height, c.distance];
    const len = Math.hypot(...toEyes);
    const dot = (front[0] * toEyes[0] + front[1] * toEyes[1] + front[2] * toEyes[2]) / len;
    check(`front points at the eyes from (${c.side}, ${c.height})`, near(dot, 1, 1e-9), dot.toFixed(9));
    // A pure rotation: orthonormal, no mirror (det +1), no roll (X stays level).
    const col = (j) => [m[j], m[4 + j], m[8 + j]];
    const [x, y, z] = [col(0), col(1), col(2)];
    const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    check(
      `rotation is rigid with no roll (${c.side}, ${c.height})`,
      near(d(x, x), 1) && near(d(y, y), 1) && near(d(x, y), 0) && near(d(cross, z), 1) && near(x[1], 0),
    );
  }
  const straight = panelMatrix({ distance: 1, height: 0, side: 0 });
  check(
    'straight ahead at eye height is the identity rotation',
    [0, 1, 2, 4, 5, 6, 8, 9, 10].every((i, k) => near(straight[i], [1, 0, 0, 0, 1, 0, 0, 0, 1][k])),
  );
}

/* ----------------------------- settings -------------------------------- */
console.log('\nPlacement settings are always complete and sane');
{
  const d = normalizeVr(undefined);
  check('nothing stored gives the defaults', JSON.stringify(d) === JSON.stringify({ ...VR_DEFAULTS }));
  check('VR ships switched off', d.enabled === false);

  const junk = normalizeVr({ enabled: 'yes', distance: 'far', height: NaN, side: null, width: Infinity });
  check('junk values fall back to defaults', junk.enabled === false && junk.distance === VR_DEFAULTS.distance);
  check('NaN height falls back', junk.height === VR_DEFAULTS.height);
  check('Infinity width is junk, not a huge panel', junk.width === VR_DEFAULTS.width, junk.width);

  const wild = normalizeVr({ enabled: true, distance: 50, height: -9, side: 4, width: 0.01 });
  check('out-of-range values are clamped', wild.distance === 2 && wild.height === -1 && wild.side === 1.2 && wild.width === 0.15);
  check('enabled survives normalising', wild.enabled === true);

  const fine = normalizeVr({ distance: 0.30000000000000004, height: -0.254 });
  check('rounded to the centimetre', fine.distance === 0.3 && fine.height === -0.25, `${fine.distance}, ${fine.height}`);

  const strings = normalizeVr({ distance: '1.1' });
  check('a numeric string is read as its number', strings.distance === 1.1);

  for (const key of Object.keys(VR_LIMITS)) {
    const v = VR_DEFAULTS[key];
    check(`default ${key} is inside its own limits`, v >= VR_LIMITS[key][0] && v <= VR_LIMITS[key][1]);
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
    SetOverlayFlag: 11,
    SetOverlayAlpha: 16,
    SetOverlayWidthInMeters: 22,
    SetOverlayTransformAbsolute: 33,
    ShowOverlay: 43,
    HideOverlay: 44,
    IsOverlayVisible: 45,
    SetOverlayTexture: 60,
    GetOverlayErrorNameFromEnum: 8,
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
