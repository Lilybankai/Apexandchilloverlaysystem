/**
 * scripts/test-onboarding.js — the Get started checklist's claims.
 * -----------------------------------------------------------------------------
 * onboarding.js is six assertions about how this app works, dressed as a card:
 * "the plugin is set up when the verdict is ok", "the sim's controls are done
 * when nothing is left to bind", "an overlay is on screen when the in-game
 * layer is on OR a URL has been copied". Each one reads a different corner of
 * the app, and each one fails in the same silent way — a row that stays ticked
 * for someone who has not done the thing, or nags someone who has.
 *
 * Neither shows up in a screenshot. A wrongly ticked row is worse than no
 * checklist at all, because it is the app telling a new driver they are set up
 * when they are not, and the symptom they get instead is a blank overlay. So
 * the predicates are asserted here directly, against hand-written state.
 *
 * `evaluate()` is pure by design so this file needs no browser, no Electron
 * and no IPC. The rest of the checks are the wiring the module cannot assert
 * about itself: that the page carries the elements it looks up, that its
 * navigation targets exist, and that control-panel.js actually calls it.
 *
 * Run: node scripts/test-onboarding.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ob = require('../electron/control-panel/onboarding.js');

const PANEL = path.join(__dirname, '..', 'electron', 'control-panel');
const html = fs.readFileSync(path.join(PANEL, 'index.html'), 'utf8');
const panelJs = fs.readFileSync(path.join(PANEL, 'control-panel.js'), 'utf8');

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

/** The state of a PC where every single step is finished. */
const DONE = {
  plugin: 'ok',
  lmuKeysKnown: true,
  lmuKeysToBind: 0,
  lmuRunning: false,
  boundActions: 3,
  ingameEnabled: true,
  copiedUrl: false,
  laidOut: true,
  engineerKnown: true,
  engineerVoiceInstalled: true,
  engineerReady: true,
};

/** DONE with one field changed. */
const but = (over) => ({ ...DONE, ...over });

/** Whether one row is ticked in a given state. */
const row = (state, id) => ob.evaluate(state).rows.find((r) => r.id === id);
const done = (state, id) => row(state, id).done;
const note = (state, id) => row(state, id).note;

/* -------------------------------------------------------------------------- */
console.log('\nThe list itself');
/* -------------------------------------------------------------------------- */

check('there are steps', Array.isArray(ob.STEPS) && ob.STEPS.length >= 5, ob.STEPS.length);
check(
  'every step is complete',
  ob.STEPS.every(
    (s) => s.id && s.icon && s.title && s.lead && s.cta && s.view && typeof s.check === 'function',
  ),
);
check('no duplicate step ids', new Set(ob.STEPS.map((s) => s.id)).size === ob.STEPS.length);
// The plugin is the one that makes every other feature blank when it is wrong,
// and the only one whose symptom gives no clue. It leads for that reason.
check('the plugin comes first', ob.STEPS[0].id === 'plugin');
// The order below it is "nothing works without this" first, and the voice —
// the one genuinely optional feature — last.
check('the engineer comes last', ob.STEPS[ob.STEPS.length - 1].id === 'engineer');

/* -------------------------------------------------------------------------- */
console.log('\nA fresh install ticks nothing');
/* -------------------------------------------------------------------------- */
/*
 * The whole point of the card. A brand-new install has all overlays enabled by
 * default (defaultSettings in main.js), so an "overlays are on" row would be
 * ticked before anyone had done anything — which is why the on-screen row asks
 * where they GO instead. Nothing else may drift the same way.
 */

{
  const fresh = ob.evaluate({});
  check('nothing is ticked with no state at all', fresh.done === 0, `${fresh.done}/${fresh.total}`);
  check('and it does not claim to be complete', fresh.complete === false);
  // evaluate() is called before the first IPC answers; it must not throw on the
  // half-built bundle, or the Dashboard render goes with it.
  check('a null state is survivable', ob.evaluate(null).done === 0);
}

check('every step ticks when everything is done', ob.evaluate(DONE).complete === true);

/* -------------------------------------------------------------------------- */
console.log('\nTelemetry plugin');
/* -------------------------------------------------------------------------- */

check("only the 'ok' verdict counts", done(but({ plugin: 'ok' }), 'plugin') === true);
for (const verdict of ['not-installed', 'not-enabled', 'missing-runtime', 'no-lmu', 'unknown']) {
  check(`'${verdict}' does not`, done(but({ plugin: verdict }), 'plugin') === false);
}
// missing-runtime is the one that used to be undiagnosable: every file on disk
// is correct and LMU skips the plugin silently. A bare untickd row would send
// someone to re-install what is already there, so the row says what is wrong.
check(
  'a missing runtime explains itself',
  /runtime/i.test(note(but({ plugin: 'missing-runtime' }), 'plugin') || ''),
);
check(
  'no LMU on the PC explains itself',
  /not found/i.test(note(but({ plugin: 'no-lmu' }), 'plugin') || ''),
);

/* -------------------------------------------------------------------------- */
console.log("\nThe sim's own controls");
/* -------------------------------------------------------------------------- */

check('done when nothing is left to bind', done(DONE, 'lmu-keys') === true);
check(
  'not done while something is unbound',
  done(but({ lmuKeysToBind: 4 }), 'lmu-keys') === false,
);
// The failure this prevents: with no keyboard.json found, toBind is 0 because
// there is nothing to plan against — not because the work is done. Ticking on
// that would tell a driver their pit limiter is bound when it is not.
check(
  'an unreadable config is NOT the same as nothing to do',
  done(but({ lmuKeysKnown: false, lmuKeysToBind: 0 }), 'lmu-keys') === false,
);
check(
  'and it says to launch the game once',
  /launch the game/i.test(note(but({ lmuKeysKnown: false }), 'lmu-keys') || ''),
);
// Binding while LMU runs is thrown away on exit — the one fact that makes this
// step fail invisibly for someone who did press the button.
check(
  'a running sim is called out',
  /close le mans ultimate/i.test(note(but({ lmuKeysToBind: 2, lmuRunning: true }), 'lmu-keys') || ''),
);
check(
  'but not once there is nothing left to bind',
  note(but({ lmuRunning: true }), 'lmu-keys') === null,
);

/* -------------------------------------------------------------------------- */
console.log('\nYour own bindings');
/* -------------------------------------------------------------------------- */

check('one binding is enough', done(but({ boundActions: 1 }), 'bindings') === true);
check('none is not', done(but({ boundActions: 0 }), 'bindings') === false);
// Arriving from this row is the deliberate click the bindings walkthrough waits
// for — it never opens itself, by design.
{
  const step = ob.STEPS.find((s) => s.id === 'bindings');
  check('it opens the bindings walkthrough', step.guide === 'APEX_BINDINGS_GUIDE');
  check(
    'and that walkthrough exists',
    typeof require('../electron/control-panel/bindings-guide.js').open === 'function',
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nGetting an overlay on screen');
/* -------------------------------------------------------------------------- */
/*
 * Two routes and either one finishes the step. OBS cannot be observed from
 * here at all, so a copied URL stands in for it — which is why the row's text
 * claims "you took the URL", not "OBS is configured".
 */

check('the in-game layer counts', done(but({ ingameEnabled: true, copiedUrl: false }), 'on-screen') === true);
check('a copied URL counts', done(but({ ingameEnabled: false, copiedUrl: true }), 'on-screen') === true);
check('neither does not', done(but({ ingameEnabled: false, copiedUrl: false }), 'on-screen') === false);

/* -------------------------------------------------------------------------- */
console.log('\nLayout and the engineer');
/* -------------------------------------------------------------------------- */

check('a saved layout ticks', done(but({ laidOut: true }), 'layout') === true);
check('an untouched one does not', done(but({ laidOut: false }), 'layout') === false);
// Laying out the IN-GAME layer with the layer switched off is not possible, and
// "click Edit layout" would be a dead end. The row says so instead.
check(
  'layout points at the in-game switch first',
  /show in game/i.test(note(but({ laidOut: false, ingameEnabled: false }), 'layout') || ''),
);

check('the engineer needs all three parts', done(but({ engineerReady: true }), 'engineer') === true);
check('and is not done without them', done(but({ engineerReady: false }), 'engineer') === false);
check(
  'a missing voice is named',
  /voice/i.test(note(but({ engineerReady: false, engineerVoiceInstalled: false }), 'engineer') || ''),
);

/* -------------------------------------------------------------------------- */
console.log('\nWiring — the page and the panel');
/* -------------------------------------------------------------------------- */

// Every element the module looks up. test-panel-parity.js covers ids reached
// through getElementById; these are the ones that must also carry the right
// initial state, which the parity contract does not describe.
check('the card is in the page', /id="onboard-card"/.test(html));
check(
  'and starts hidden, so a returning driver never sees it flash',
  /id="onboard-card"[^>]*\shidden/.test(html),
);
check('the completion line starts hidden too', /id="onboard-done"[^>]*\shidden/.test(html));

// Where each row sends you. A typo here is a click that silently does nothing.
{
  const views = new Set([...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]));
  const panes = new Set([...html.matchAll(/data-settingspane="([a-z]+)"/g)].map((m) => m[1]));
  const badView = ob.STEPS.filter((s) => !views.has(s.view)).map((s) => s.id);
  const badPane = ob.STEPS.filter((s) => s.pane && !panes.has(s.pane)).map((s) => s.id);
  const badFocus = ob.STEPS.filter(
    (s) => s.focus && !html.includes(`id="${s.focus.slice(1)}"`),
  ).map((s) => s.id);
  check('every row targets a real tab', badView.length === 0, badView.join(', ') || 'all 6');
  check('every settings row targets a real pane', badPane.length === 0, badPane.join(', ') || 'ok');
  check('every row targets a card that exists', badFocus.length === 0, badFocus.join(', ') || 'ok');
}

// The module cannot navigate without these, and it fails silently if they go:
// the click just does nothing at all.
check('the panel publishes its routers', /window\.apexNav\s*=\s*\{\s*showView,\s*showSettingsPane/.test(panelJs));
check('the card is started at boot', /APEX_ONBOARDING\?\.init\(/.test(panelJs));
check('the Dashboard re-reads it on arrival', /APEX_ONBOARDING\?\.shown\(\)/.test(panelJs));
check('settings pushes reach it', /APEX_ONBOARDING\?\.onSettings\(/.test(panelJs));
// The on-screen row's OBS half has exactly one source of truth.
check('copying a URL is recorded', /APEX_ONBOARDING\?\.copiedOverlayUrl\(\)/.test(panelJs));
{
  // It has to be inside copyUrl specifically. The panel has several copy
  // buttons (the combined URL, one per overlay card) and they all funnel
  // through that one function — a call wired to a single button instead would
  // leave the row unticked for whichever button someone actually used.
  const from = panelJs.indexOf('async function copyUrl(');
  const body = from < 0 ? '' : panelJs.slice(from, panelJs.indexOf('\n  }', from));
  check(
    'and that call sits in copyUrl, which every copy button funnels through',
    body.includes('APEX_ONBOARDING?.copiedOverlayUrl()'),
    from < 0 ? 'copyUrl not found' : `${body.length} chars`,
  );
}

// Load order: onboarding.js reaches for window.apexNav and the bindings guide
// the moment a row is clicked, so it must come after both.
{
  const at = (f) => html.indexOf(`src="${f}"`);
  check('it loads after the panel', at('onboarding.js') > at('control-panel.js'));
  check('and after the bindings walkthrough', at('onboarding.js') > at('bindings-guide.js'));
  check('its stylesheet is linked', html.includes('href="onboarding.css"'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
