#!/usr/bin/env node
/**
 * scripts/test-mfd-ui.js — the MFD's auto-fade clock and layout wiring.
 * -----------------------------------------------------------------------------
 * Two widget-side features whose failure mode is silence:
 *
 *   auto-fade   a timing rule. Wrong by a beat and the widget either vanishes
 *               under a mouse that was aiming at it, or never comes back when
 *               the bound row-next/row-previous buttons move the cursor — and
 *               the driver pressing those buttons is, by definition, not
 *               looking at a log. The state machine lives in
 *               createFadeController (widgets/mfd.js), pure and timer-injected
 *               precisely so it can be exercised here with a fake clock.
 *
 *   layout      a settings chain. 'row' has to survive the same nine-file trip
 *               every appearance knob takes (catalog → WIDGET_MODES → modes
 *               channel → widget), and a miss anywhere is a dropdown that
 *               moves and does nothing — the class of bug test-panel-parity
 *               exists for on the markup side.
 *
 * The widget file is loaded in a vm sandbox (the test-carclass-ui bargain);
 * electron/main.js cannot be required, so it is read as text and matched (the
 * test-startup bargain).
 *
 * Run: node scripts/test-mfd-ui.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

/* ----------------------- load the widget headlessly ---------------------- */

const sandbox = {
  window: {
    ApexOverlay: { registerWidget() {} },
    setTimeout,
    clearTimeout,
  },
  console,
};
vm.createContext(sandbox);
vm.runInContext(read('overlay', 'js', 'widgets', 'mfd.js'), sandbox, {
  filename: 'mfd.js',
});
const api = sandbox.window.ApexMfd;

console.log('\nthe widget exposes its pure half');
check('window.ApexMfd exists', !!api);
check('the fade delay is three seconds', api && api.FADE_AFTER_MS === 3000, api && api.FADE_AFTER_MS);
check(
  "layouts are ['stack','row'], stacked first (the default must stay first)",
  api && Array.isArray(api.LAYOUTS) && api.LAYOUTS[0] === 'stack' && api.LAYOUTS[1] === 'row',
  api && api.LAYOUTS.join(','),
);

/* ------------------------------ a fake clock ----------------------------- */

function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    armed: () => pending.size,
  };
}

function makeController() {
  const clock = fakeClock();
  const log = [];
  const ctl = api.createFadeController({
    delayMs: 3000,
    setFaded: (on) => log.push(on),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, log, ctl };
}

console.log('\nauto-fade — the clock');

{
  const { clock, ctl } = makeController();
  ctl.setEnabled(true);
  clock.advance(2999);
  check('one beat early: still visible', !ctl.isFaded());
  clock.advance(1);
  check('three seconds idle: faded', ctl.isFaded());
}

{
  // The user's exact scenario: faded, then a bound row-next/previous button
  // moves the cursor — the widget must come straight back.
  const { clock, log, ctl } = makeController();
  ctl.setEnabled(true);
  clock.advance(3000);
  check('setup: faded', ctl.isFaded());
  ctl.activity();
  check('cursor moved: visible again immediately', !ctl.isFaded());
  check('and the un-fade was actually painted', log[log.length - 1] === false);
  clock.advance(3000);
  check('idle again after the wake: fades again', ctl.isFaded());
}

{
  // Activity before the deadline restarts the clock, not merely delays it.
  const { clock, ctl } = makeController();
  ctl.setEnabled(true);
  clock.advance(2900);
  ctl.activity();
  clock.advance(2900);
  check('activity at 2.9s: not faded at 5.8s', !ctl.isFaded());
  clock.advance(100);
  check('fades a full three seconds after the LAST touch', ctl.isFaded());
}

{
  // The pointer holds it awake — fading a menu out from under a mouse that is
  // aiming at it turns clicks into misclicks.
  const { clock, ctl } = makeController();
  ctl.setEnabled(true);
  ctl.hover(true);
  clock.advance(60000);
  check('hovered for a minute: never fades', !ctl.isFaded());
  ctl.hover(false);
  clock.advance(3000);
  check('pointer left: the clock re-arms and it fades', ctl.isFaded());
  ctl.hover(true);
  check('pointer returning to a faded widget wakes it', !ctl.isFaded());
}

{
  // Switching the setting off can never strand the widget invisible.
  const { clock, ctl } = makeController();
  ctl.setEnabled(true);
  clock.advance(3000);
  check('setup: faded', ctl.isFaded());
  ctl.setEnabled(false);
  check('feature off: shown immediately', !ctl.isFaded());
  clock.advance(60000);
  check('feature off: never fades again', !ctl.isFaded());
}

{
  // Disabled is genuinely inert — activity while off must not arm anything.
  const { clock, ctl } = makeController();
  ctl.activity();
  ctl.hover(false);
  clock.advance(60000);
  check('never enabled: never fades', !ctl.isFaded());
  check('never enabled: no timer left armed', clock.armed() === 0);
}

{
  // Enabling arms the clock by itself — "after three seconds of inactivity"
  // includes the three seconds after flipping the switch.
  const { clock, ctl } = makeController();
  ctl.setEnabled(true);
  clock.advance(3000);
  check('enabled then untouched: fades with no activity ever seen', ctl.isFaded());
}

{
  // Each transition paints exactly once — a repaint per poll would fight the
  // CSS transition mid-fade.
  const { clock, log, ctl } = makeController();
  ctl.setEnabled(true);
  clock.advance(3000);
  ctl.activity();
  ctl.activity();
  ctl.activity();
  check(
    'repeated activity paints the un-fade once',
    JSON.stringify(log) === JSON.stringify([true, false]),
    JSON.stringify(log),
  );
}

/* --------------------------- the settings chain -------------------------- */

console.log('\nauto-fade + layout survive the settings chain');

const main = read('electron', 'main.js');
const serverTs = read('src', 'server', 'index.ts');
const appearanceJs = read('overlay', 'js', 'appearance.js');
const mfdJs = read('overlay', 'js', 'widgets', 'mfd.js');
const overlayCss = read('overlay', 'css', 'overlay.css');
const panelHtml = read('electron', 'control-panel', 'index.html');
const panelJs = read('electron', 'control-panel', 'control-panel.js');

check('main: mfdAutoFade defaults off', /mfdAutoFade: false,/.test(main));
check(
  'main: the loader validates it as a boolean',
  /typeof stored\.mfdAutoFade === 'boolean'/.test(main),
);
check(
  'main: settings:update accepts it (the whitelist drops unnamed keys silently)',
  /typeof partial\.mfdAutoFade === 'boolean'/.test(main),
);
check('main: it rides the appearance payload', /mfdAutoFade: !!s\.mfdAutoFade,/.test(main));
check(
  'main: a change triggers the appearance push',
  /next\.mfdAutoFade !== current\.mfdAutoFade/.test(main),
);
check("main: WIDGET_MODES.mfd is ['stack','row']", /mfd: \['stack', 'row'\]/.test(main));
check(
  'main: the mfd catalog entry declares the designs dropdown',
  /id: 'stack', label: 'Vertical/.test(main) && /id: 'row', label: 'Horizontal/.test(main),
);

check(
  'server: setAppearance validates mfdAutoFade',
  /next\?\.mfdAutoFade === 'boolean'/.test(serverTs),
);
check('server: the Appearance default is off', /mfdAutoFade: false,/.test(serverTs));

check('appearance.js: exposes onMfdFade', /onMfdFade: function \(cb\)/.test(appearanceJs));
check(
  'appearance.js: applied from BOTH the push and the poll',
  (appearanceJs.match(/applyMfdFade\(/g) || []).length >= 3,
  (appearanceJs.match(/applyMfdFade\(/g) || []).length + ' call sites',
);

check(
  'mfd.js: the cursor poll wakes the widget (moved, not first)',
  /if \(first\) return;[\s\S]{0,200}fadeActivity\(\);/.test(mfdJs),
);
check(
  'mfd.js: clicking a row wakes it too',
  /function aimCursorAt\(key\) \{\s*\r?\n\s*fadeActivity\(\);/.test(mfdJs),
);
check('mfd.js: subscribes to the setting', /onMfdFade\(function \(on\)/.test(mfdJs));
check('mfd.js: subscribes to the layout mode', /modes && modes\.mfd/.test(mfdJs));

check('css: the row layout exists', /#widget-mfd\[data-layout="row"\] \.mfd__wrap/.test(overlayCss));
check(
  'css: row columns guard min-width (one long label must not blow the row out)',
  /#widget-mfd\[data-layout="row"\] \.mfd__group \{[^}]*min-width: 0/.test(overlayCss),
);
check(
  'css: the faded state is opacity 0',
  /#widget-mfd\[data-mfd-faded\] \{[^}]*opacity: 0/.test(overlayCss),
);
check(
  'css: edit mode overrides the fade (an invisible widget cannot be dragged)',
  /body\.ig-editing #widget-mfd\[data-mfd-faded\] \{[^}]*opacity: 1/.test(overlayCss),
);

check('panel: the toggle exists', /id="mfd-fade-toggle"/.test(panelHtml));
check(
  'panel: it renders from state with plain truthiness',
  /mfdFadeToggle\.checked = !!settings\.mfdAutoFade/.test(panelJs),
);
check(
  'panel: moving it writes the setting',
  /updateSettings\(\{ mfdAutoFade: mfdFadeToggle\.checked \}\)/.test(panelJs),
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
