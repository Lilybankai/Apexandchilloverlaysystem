#!/usr/bin/env node
/**
 * scripts/test-docking.js — the notch fit and magnetic docking are actually wired.
 * -----------------------------------------------------------------------------
 * Two features whose failure mode is silence, which is why this file exists.
 *
 * The delta widget's bottom edge is cut to the shape of the speedo cluster's
 * notch. That cut used to be three pixel values hand-converted from the
 * silhouette's constants at ONE cluster width and pasted into overlay.css, with
 * nothing linking the copy back to the original — so the moment anyone resized
 * the cluster the notch moved and the cut did not, and every build reported
 * success. The fix is a measurement (overlay/js/notch-dock.js) driven by a
 * profile exported from the widget that owns the shape. What this file pins is
 * the CHAIN: the export exists, the measuring module is loaded on the one page
 * that has both widgets, and the layout manager calls it from its write path. A
 * break anywhere along it looks exactly like the bug it replaced.
 *
 * Magnetic docking is a boolean that has to survive nine files to do anything —
 * default, loader, IPC whitelist, IPC handler, push-on-change, preload, page,
 * panel markup, panel handler. A miss in any one of them is a switch that moves
 * and does nothing, which is precisely the class of bug scripts/test-panel-parity
 * exists for on the markup side. The BEHAVIOUR of the snap is tested where it
 * lives, against a real gesture, in scripts/test-ingame-layout.js.
 *
 * electron/main.js cannot be required (it pulls in Electron), so it is read as
 * text and matched — the same bargain scripts/test-startup.js takes.
 *
 * Run: node scripts/test-docking.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const main = read('electron', 'main.js');
const preload = read('electron', 'ingame-preload.js');
const ingameJs = read('overlay', 'js', 'ingame.js');
const ingameHtml = read('overlay', 'ingame.html');
const indexHtml = read('overlay', 'index.html');
const overlayCss = read('overlay', 'css', 'overlay.css');
const ingameCss = read('overlay', 'css', 'ingame.css');
const speedoJs = read('overlay', 'js', 'widgets', 'speedo.js');
const notchDock = read('overlay', 'js', 'notch-dock.js');
const panelHtml = read('electron', 'control-panel', 'index.html');
const panelJs = read('electron', 'control-panel', 'control-panel.js');

/* ------------------------- the notch is measured ------------------------- */

console.log('\nthe delta seats in a notch it MEASURES');

check(
  'speedo.js exports a notch profile',
  /NOTCH:\s*\{/.test(speedoJs),
  'ApexSpeedo.NOTCH',
);
check(
  'the profile is derived from the shell constants, not restated',
  /rimHalf:\s*DW\s*\/\s*2\s*-\s*\(NOTCH_L\s*-\s*CH\)/.test(speedoJs) &&
    /tipHalf:\s*NOTCH_R\s*-\s*DW\s*\/\s*2/.test(speedoJs) &&
    /depth:\s*NOTCH_TOP/.test(speedoJs),
  'a literal here would drift from shellPath again',
);
check(
  'notch-dock reads the profile rather than carrying its own copy',
  /ApexSpeedo/.test(notchDock) && /NOTCH/.test(notchDock),
  'measure, never restate',
);
check(
  'the measurement letterboxes the way the canvas does',
  /Math\.min\(\s*r\.width\s*\/\s*api\.DESIGN\.w\s*,\s*r\.height\s*\/\s*api\.DESIGN\.h\s*\)/.test(
    notchDock,
  ),
  'width alone misplaces the notch on a height-boxed cluster',
);
check(
  'the cut is divided back through the delta’s own scale',
  /renderedScale/.test(notchDock) && /\/\s*ds\)/.test(notchDock),
  'clip-path resolves BEFORE transform',
);
check(
  'only the notched cluster design is measured',
  /NOTCHED_DESIGN/.test(notchDock) && /data-design/.test(notchDock),
  'the LMP2 design is a flat plate',
);

check(
  'the stylesheet carries a horizontal offset for the cut',
  /--notch-cx/.test(overlayCss),
  'without it the cut assumes the notch is under 50%',
);
check(
  'the clip polygon actually uses that offset',
  /calc\(50%\s*\+\s*var\(--notch-cx\)\s*\+\s*var\(--notch-rim-half\)\)/.test(overlayCss),
  'declared but unused is the same bug with extra steps',
);

check(
  'ingame.html loads the measuring module',
  /notch-dock\.js/.test(ingameHtml),
  'the only page with both widgets',
);
check(
  'the combined OBS page does not',
  !/notch-dock\.js/.test(indexHtml),
  'no cluster there to measure',
);
check(
  'the layout manager re-cuts from its write path',
  /ApexNotchDock/.test(ingameJs) && /refitNotch/.test(ingameJs),
  'a ResizeObserver cannot see a MOVE',
);
check(
  'the default placement is measured rather than guessed',
  /seatDeltaDefault/.test(ingameJs),
  'the hardcoded ~112px height is wrong at any text scale but 1.0',
);

/* --------------------------- magnetic docking ---------------------------- */

console.log('\nmagnetic docking survives the trip from switch to drag');

check(
  'main: the setting has a default',
  /ingameMagneticDock:\s*false/.test(main),
  'ships OFF — it changes what an existing drag does',
);
check(
  'main: the loader validates it as a boolean',
  /ingameMagneticDock:\s*\n?\s*typeof stored\.ingameMagneticDock === 'boolean'/.test(main),
  'an unvalidated key survives a hand-edited config.json as anything at all',
);
check(
  'main: settings:update accepts it',
  /typeof partial\.ingameMagneticDock === 'boolean'/.test(main),
  'the whitelist drops unnamed keys SILENTLY',
);
check(
  'main: the layer can read it at boot',
  /ipcMain\.handle\('ingame:dockGet'/.test(main),
  '',
);
check(
  'main: a change is pushed to a layer already open',
  /send\('ingame:dock',/.test(main),
  'otherwise the switch is dead until the layer is rebuilt',
);
check(
  'main: it is NOT on the appearance channel',
  !/ingameMagneticDock/.test(main.slice(main.indexOf('function applyAppearance'), main.indexOf('function applyAppearance') + 1400)),
  'that one is polled once a second by every OBS source',
);

check(
  'preload: the page can read the flag',
  /getDocking:/.test(preload),
  '',
);
check('preload: and follow it', /onDocking:/.test(preload), '');

check(
  'page: the drag reads the flag',
  /var magnetic = false/.test(ingameJs),
  '',
);
check(
  'page: Alt suppresses the magnet',
  /!ev\.altKey/.test(ingameJs),
  'a placement that a snap would fight needs an escape hatch',
);
check(
  'page: the magnet only runs while the flag is on',
  /if \(magnetic && !ev\.altKey\)/.test(ingameJs),
  '',
);
check(
  'page: a seam matches the shared edge',
  /matchHeight/.test(ingameJs) && /matchWidth/.test(ingameJs),
  'align AND match size',
);
check(
  'page: the width match backs out the optional-column bump',
  /widthBumpFor\(id\)/.test(ingameJs.slice(ingameJs.indexOf('function matchWidth'))),
  'or standings gains 70px per snap',
);
check(
  'page: corner-scale drags are left alone',
  /drag\.mode !== "scale" && drag\.mode !== "scale-nw"/.test(ingameJs),
  'scale is quantised; the target edge is often unreachable',
);
check(
  'page: the mark is cleared when editing ends',
  /else hideMark\(\)/.test(ingameJs),
  'or it is left painted over the sim',
);

check(
  'css: the mark is gated on edit mode AND an active snap',
  /body\.ig-editing \.ig-snap\[data-on\]/.test(ingameCss),
  '',
);
check(
  'css: the mark sits in front of the handles',
  /\.ig-snap\s*\{[^}]*z-index/.test(ingameCss),
  'the screen guides rely on DOM order; this one cannot',
);
check(
  'css: the mark is never hit-tested',
  /\.ig-snap\s*\{[^}]*pointer-events:\s*none/.test(ingameCss),
  '',
);

check(
  'panel: the switch exists',
  /id="ingame-dock-toggle"/.test(panelHtml),
  '',
);
check(
  'panel: it sits with the layout controls',
  panelHtml.indexOf('ingame-dock-toggle') < panelHtml.indexOf('ig-edit-btn'),
  'it does nothing outside Edit layout',
);
check(
  'panel: the switch renders from state',
  /ingameDockToggle\.checked = !!settings\.ingameMagneticDock/.test(panelJs),
  'plain truthiness, because it ships off',
);
check(
  'panel: moving it writes the setting',
  /updateSettings\(\{\s*ingameMagneticDock:/.test(panelJs),
  '',
);
check(
  'panel: and says so',
  /Magnetic docking on/.test(panelJs),
  'the switch has no visible effect from this window',
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
