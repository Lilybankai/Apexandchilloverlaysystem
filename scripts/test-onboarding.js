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
  setupsToured: true,
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
// The order below it is "nothing works without this" first. The last two are
// the ones nobody is blocked by: the voice, which is genuinely optional, and
// the setup screen, which is a thing to learn rather than a thing to switch on.
check(
  'the optional two come last',
  ob.STEPS.slice(-2).map((s) => s.id).join(',') === 'engineer,setups',
  ob.STEPS.slice(-2).map((s) => s.id).join(','),
);
// The gap called out after the first cut: the checklist walked someone through
// six things and never mentioned the Setups tab at all.
check('the setup screen is on the list', ob.STEPS.some((s) => s.id === 'setups'));

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

check('the setups row ticks once the tour is taken', done(but({ setupsToured: true }), 'setups') === true);
check('and not before', done(but({ setupsToured: false }), 'setups') === false);
// The one row with nothing measurable behind it, so it must not pretend: the
// tab is perfectly useful with an empty library, and checking for a saved
// setup would nag anyone using it correctly.
check(
  'it says what taking the tour gets you',
  /apply/i.test(note(but({ setupsToured: false }), 'setups') || ''),
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


/* -------------------------------------------------------------------------- */
console.log('\nHiding it, and getting it back');
/* -------------------------------------------------------------------------- */
/*
 * The card is the ONLY way into the five tours, so "Hide this" was a one-way
 * door: hide it on day one and the walkthrough was gone for good, with no
 * control anywhere in the app to bring it back. These assert the way back
 * exists, and that it clears the flag rather than only un-hiding the card.
 */

check('the header button is in the page', /id="onboard-reopen"/.test(html));
check(
  'and starts hidden, because the card is on screen when it is not',
  /id="onboard-reopen"[^>]*\shidden/.test(html),
);
check('the module can bring the card back', typeof ob.restore === 'function');

// The flag, not just the hidden attribute: a card un-hidden without clearing
// DISMISS_KEY comes back for this session and is gone again next launch.
{
  const store = new Map();
  const stub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  let usable = true;
  try {
    globalThis.localStorage = stub;
  } catch {
    usable = false; // a Node build that owns the name — these checks are moot
  }
  if (usable) {
    store.set(ob.DISMISS_KEY, ob.LIST_VERSION);
    check('a hidden card reports itself dismissed', ob.dismissed() === true);
    ob.undismiss();
    check('and undismiss clears that', ob.dismissed() === false);
    check('leaving nothing behind in storage', store.has(ob.DISMISS_KEY) === false);
    // Twice over is what a double-click on the button is.
    ob.undismiss();
    check('which is safe to repeat', ob.dismissed() === false);
  }
}


/* -------------------------------------------------------------------------- */
console.log('\nSurviving the nav');
/* -------------------------------------------------------------------------- */
/*
 * The checklist is the first thing a new install shows and the only way into
 * the five tours, so it is the last thing that should break when the shell is
 * restyled. It survived the top-bar-to-side-rail move in v0.91 for one reason:
 * it navigates through the ROUTER (window.apexNav.showView), never by finding
 * and clicking a nav button. A rail item, a tab, a command palette -- none of
 * it matters to a caller that asks the router to go somewhere.
 *
 * These freeze that. The failure they exist to catch is someone "simplifying"
 * goTo() into a `document.querySelector('.tab[data-tab=...]').click()`, which
 * would work perfectly until the day the nav markup changes again -- and then
 * strand every new driver on a checklist whose rows do nothing.
 */

const obJs = fs.readFileSync(path.join(PANEL, 'onboarding.js'), 'utf8');
const tourJs = fs.readFileSync(path.join(PANEL, 'tour.js'), 'utf8');

check('the checklist navigates through the router', /apexNav/.test(obJs));
check('and so does the walkthrough it launches', /apexNav/.test(tourJs));
check(
  'neither reaches into the nav markup for a button to click',
  !/\.tab\[data-tab|querySelector\([^)]*\.tab\b|getElementById\(['"]rail/.test(obJs + tourJs),
);
check('the router still exports showView for them', /window\.apexNav\s*=\s*\{[^}]*showView/.test(panelJs));
check(
  'and showSettingsPane, which the pane-deep rows need',
  /window\.apexNav\s*=\s*\{[^}]*showSettingsPane/.test(panelJs),
);

// Every view the checklist and the tours navigate to must be a real section.
// A typo here is a row that goes nowhere, which looks exactly like a dead app.
{
  const declared = new Set([...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]));
  const wanted = new Set([
    ...[...obJs.matchAll(/view:\s*'([a-z]+)'/g)].map((m) => m[1]),
    ...[...tourJs.matchAll(/view:\s*'([a-z]+)'/g)].map((m) => m[1]),
  ]);
  const missing = [...wanted].filter((v) => !declared.has(v));
  check('every view they navigate to exists', missing.length === 0, missing.join(', ') || 'all present');
}

// The card itself lives inside a view, so it rides along with the content
// column wherever the nav goes. If it ever ends up outside .content it would
// be laid out beside the rail instead of inside the page.
check(
  'the card is inside the content column, not the shell chrome',
  html.indexOf('id="onboard-card"') > html.indexOf('<div class="content" id="content">'),
);
check(
  'and inside the dashboard view specifically',
  html.indexOf('id="onboard-card"') > html.indexOf('data-view="dashboard"'),
);


/* -------------------------------------------------------------------------- */
console.log('\nThe rail it now sits beside');
/* -------------------------------------------------------------------------- */
/*
 * The side rail (v0.91). The router finds its items with `.tab[data-tab]` and
 * nothing else, which is why the move cost it no changes -- so that selector,
 * and the labels the tooltips are copied from, are the contract.
 */

check('the rail is in the page', /<nav class="rail" id="rail"/.test(html));
check('it wraps the content in a row', /<div class="body">/.test(html));

{
  // Every destination the router knows must be a rail item, and every rail
  // item must have a view behind it. Either half missing is a dead click.
  const tabs = [...html.matchAll(/class="tab"[^>]*data-tab="([a-z]+)"/g)].map((m) => m[1]);
  const declared = new Set([...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]));
  const orphans = tabs.filter((t) => !declared.has(t));
  check('every rail item has a view behind it', orphans.length === 0, orphans.join(', ') || 'all wired');
  check('nothing was dropped in the move', tabs.length === 12, `${tabs.length} items`);
  check('settings is a destination of its own now', tabs.includes('settings'));
  check(
    'and the gear that used to toggle back to the last tab is gone',
    !/lastContentTab/.test(panelJs),
  );
}

{
  // The collapsed rail is icons only. Every item must carry a label for the
  // tooltip to be copied FROM -- an item with no label collapses to an
  // anonymous glyph, which is the exact bug the old icon-only top bar had.
  const items = [...html.matchAll(/<button class="(?:tab|rail__collapse)"[\s\S]{0,320}?<\/button>/g)].map(
    (m) => m[0],
  );
  const unlabelled = items.filter((h) => !/class="tab__label">[^<]+</.test(h));
  check(
    'every rail item has a label to name itself by',
    unlabelled.length === 0,
    `${items.length} items`,
  );
  check('the tooltip text is copied from that label, not written twice', /data-tip/.test(panelJs));
  check('and an aria-label with it, for when the label is display:none', /aria-label/.test(panelJs));
  check('the collapse toggle exists', /id="rail-toggle"/.test(html));
  check('and its state is remembered', /apex\.panel\.railCollapsed/.test(panelJs));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
