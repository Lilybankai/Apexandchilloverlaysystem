/**
 * scripts/test-tour.js — the guided walkthrough's anchors and its coverage.
 * -----------------------------------------------------------------------------
 * A tour step is a promise that the app will point at a specific control and
 * explain it. Two ways that promise breaks, both silent:
 *
 *   1. The anchor stops matching anything. The step still runs — it falls back
 *      to a centred card by design, so nothing errors and no test that only
 *      checks "the tour opened" would notice. What a driver gets is a
 *      walkthrough that has stopped walking, which is worse than no tour,
 *      because it was supposed to be the thing that showed them where to look.
 *   2. A step sends someone to a tab or settings pane that no longer exists,
 *      so the click lands nowhere at all.
 *
 * Both are checked here against the real index.html. Ids are resolved exactly;
 * class-based anchors (the overlay cards are injected at runtime) are checked
 * against the stylesheets instead, which is the closest thing to proof that
 * exists without a browser.
 *
 * The rest is coverage: every checklist row must actually reach a tour, and
 * the sections Carl named for the Discord launch — settings and the MFD
 * bindings, overlays and OBS, placement, the engineer, the setup screen — must
 * each be covered by one.
 *
 * Run: node scripts/test-tour.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const tour = require('../electron/control-panel/tour.js');
const onboarding = require('../electron/control-panel/onboarding.js');

const PANEL = path.join(__dirname, '..', 'electron', 'control-panel');
const html = fs.readFileSync(path.join(PANEL, 'index.html'), 'utf8');
const panelJs = fs.readFileSync(path.join(PANEL, 'control-panel.js'), 'utf8');
const css = ['control-panel.css', 'hub.css', 'setup-editor.css', 'tour.css', 'onboarding.css']
  .map((f) => fs.readFileSync(path.join(PANEL, f), 'utf8'))
  .join('\n');

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

const steps = tour.allSteps();

/* -------------------------------------------------------------------------- */
console.log('\nThe tours');
/* -------------------------------------------------------------------------- */

check('there are tours', tour.TOURS.length >= 5, tour.TOURS.length);
check('no duplicate tour ids', new Set(tour.TOURS.map((t) => t.id)).size === tour.TOURS.length);
check(
  'every tour is complete',
  tour.TOURS.every((t) => t.id && t.title && t.icon && t.blurb && t.steps.length >= 3),
);
check(
  'every step is complete',
  steps.every((s) => s.id && s.title && s.body && s.view),
  `${steps.length} steps`,
);
check(
  'no duplicate step ids inside a tour',
  tour.TOURS.every((t) => new Set(t.steps.map((s) => s.id)).size === t.steps.length),
);
// A walkthrough is only worth the name if it is more than a couple of screens.
check('the full tour is substantial', steps.length >= 20, `${steps.length} steps end to end`);

/* -------------------------------------------------------------------------- */
console.log('\nEvery step points at something that exists');
/* -------------------------------------------------------------------------- */
/*
 * The check that matters. A step falls back to a centred card when its anchor
 * is missing — deliberately, so a hidden pane never dead-ends a tour — which
 * means a broken anchor produces no error at all at runtime.
 */

{
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const bad = [];
  const unproven = [];
  for (const s of steps) {
    if (!s.anchor) continue;
    // An `optional` step is allowed to point at nothing: that is the whole
    // point of the mark. It describes a feature this build may not have, and
    // usableSteps() drops it at run time rather than showing it. Requiring its
    // anchor here would fail every stable cut made from a tag older than the
    // feature — which is exactly the cut this mark exists for.
    if (s.optional) continue;
    if (s.anchor.startsWith('#')) {
      // Take the id up to any descendant/pseudo part.
      const id = s.anchor.slice(1).split(/[\s.:>[]/)[0];
      if (!ids.has(id)) bad.push(`${s.tour}/${s.id} -> ${s.anchor}`);
    } else {
      // Injected at runtime, so the markup cannot prove it. The class carrying
      // it is styled, which is the next best evidence that it is still real.
      const cls = (s.anchor.match(/\.([a-z0-9_-]+)/i) || [])[1];
      if (!cls || !css.includes(`.${cls}`)) unproven.push(`${s.tour}/${s.id} -> ${s.anchor}`);
    }
  }
  check(
    'every REQUIRED id anchor resolves in index.html',
    bad.length === 0,
    bad.join(', ') || `${steps.filter((s) => !s.optional).length} checked`,
  );
  check(
    'every runtime anchor has a class the stylesheets know',
    unproven.length === 0,
    unproven.join(', ') || 'ok',
  );
  check('most steps do point at something', steps.filter((s) => s.anchor).length >= steps.length - 1);
}

{
  /*
   * A step marked `optional` describes a feature that is not in every build —
   * a stable release is cut from an older tag than main, so magnetic docking
   * (0.91 beta) is absent from one and present in the other. Such a step must
   * drop out entirely rather than fall back to a centred card, because the
   * fallback would explain a control the driver has no way to reach.
   *
   * Asserted both ways: the marked ones survive when their anchor is there,
   * and vanish when it is not.
   */
  const optional = tour.allSteps().filter((s) => s.optional);
  check('optional steps declare an anchor to test for', optional.every((s) => !!s.anchor));
  const present = { querySelector: () => ({}) };
  const absent = { querySelector: () => null };
  const withDoc = (doc, fn) => {
    const had = 'document' in global;
    const prev = global.document;
    global.document = doc;
    try {
      return fn();
    } finally {
      if (had) global.document = prev;
      else delete global.document;
    }
  };
  const kept = withDoc(present, () => tour.usableSteps(tour.allSteps()).length);
  const dropped = withDoc(absent, () => tour.usableSteps(tour.allSteps()).length);
  check('optional steps are kept when the control exists', kept === tour.allSteps().length, kept);
  check(
    'and dropped when it does not',
    dropped === tour.allSteps().length - optional.length,
    `${dropped} of ${tour.allSteps().length}`,
  );
  // Everything not marked optional must exist in every build, or a tour cut
  // for stable silently loses a step it was relying on.
  check('a required step is never dropped', dropped >= tour.allSteps().length - optional.length);
}

{
  const views = new Set([...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]));
  const panes = new Set([...html.matchAll(/data-settingspane="([a-z]+)"/g)].map((m) => m[1]));
  const badView = steps.filter((s) => !views.has(s.view)).map((s) => `${s.tour}/${s.id}`);
  const badPane = steps.filter((s) => s.pane && !panes.has(s.pane)).map((s) => `${s.tour}/${s.id}`);
  check('every step targets a real tab', badView.length === 0, badView.join(', ') || 'all ok');
  check('every step targets a real settings pane', badPane.length === 0, badPane.join(', ') || 'ok');
}

/* -------------------------------------------------------------------------- */
console.log('\nWhat the walkthrough has to cover');
/* -------------------------------------------------------------------------- */
/*
 * The sections named for the Discord launch. Asserted by SUBJECT rather than
 * by step id, so rewording a step cannot quietly drop a topic — these are the
 * questions the tour exists to answer.
 */

const textOf = (s) => `${s.title} ${s.body} ${s.note || ''}`.toLowerCase();
const all = steps.map(textOf).join('\n');
const inTour = (id) => (tour.tourById(id) || { steps: [] }).steps.map(textOf).join('\n');

check('a tour covers Settings', !!tour.tourById('settings'));
check('a tour covers Overlays', !!tour.tourById('overlays'));
check('a tour covers overlay placement', !!tour.tourById('ingame'));
check('a tour covers the race engineer', !!tour.tourById('engineer'));
// The gap Carl called out: the checklist shipped without the setup screen.
check('a tour covers the setup screen', !!tour.tourById('setups'));

check('the plugin is explained', /plugin/.test(inTour('settings')));
check('the MFD / pit controls are explained', /mfd/.test(inTour('settings')));
check('binding your own keys is explained', /bind/.test(inTour('settings')));
check('Stream Deck gets a mention', /stream deck/.test(all));
check('OBS Browser Source is explained', /browser source/.test(inTour('overlays')));
check('the two destinations are distinguished', /in game/.test(inTour('overlays')));
check('the hotkey cycle is explained', /cycle/.test(inTour('ingame')));
check('edit layout is explained', /edit/.test(inTour('ingame')));
check('push-to-talk is explained', /push-to-talk/.test(inTour('engineer')));
// The single most surprising thing about the Setups tab.
check('Apply-before-anything-happens is explained', /apply/.test(inTour('setups')));
check('the setup library is explained', /library/.test(inTour('setups')));

/* -------------------------------------------------------------------------- */
console.log('\nThe checklist and the tours agree');
/* -------------------------------------------------------------------------- */

{
  const known = new Set(tour.TOURS.map((t) => t.id));
  const rows = onboarding.STEPS;
  const noTour = rows.filter((r) => !r.tour).map((r) => r.id);
  const badTour = rows.filter((r) => r.tour && !known.has(r.tour)).map((r) => r.id);
  check('every checklist row launches a tour', noTour.length === 0, noTour.join(', ') || 'all 7');
  check('and every one names a tour that exists', badTour.length === 0, badTour.join(', ') || 'ok');
  check('there is a Setups row', rows.some((r) => r.id === 'setups'));
  // Nothing should be reachable only by knowing it is there.
  const reached = new Set(rows.map((r) => r.tour));
  const orphan = tour.TOURS.filter((t) => !reached.has(t.id)).map((t) => t.id);
  check('no tour is unreachable from the checklist', orphan.length === 0, orphan.join(', ') || 'ok');
}

/* -------------------------------------------------------------------------- */
console.log('\nWiring');
/* -------------------------------------------------------------------------- */

check('the walkthrough is in the page', /id="tour"/.test(html));
check('and starts hidden', /id="tour"[^>]*\shidden/.test(html));
check('the note line starts hidden', /id="tour-note"[^>]*\shidden/.test(html));
check('its stylesheet is linked', html.includes('href="tour.css"'));
// It navigates between tabs mid-tour, so it needs the panel's routers.
check('the panel publishes its routers', /window\.apexNav\s*=/.test(panelJs));

{
  const at = (f) => html.indexOf(`src="${f}"`);
  check('tour.js loads after the panel', at('tour.js') > at('control-panel.js'));
  // onboarding.js calls APEX_TOUR.start() the moment a row is clicked.
  check('and before the checklist', at('tour.js') < at('onboarding.js'));
}

// The dim is the ring's own box-shadow, and the page underneath has to stay
// clickable — that is the whole difference between this and a slideshow.
check('the container takes no pointer events', /\.tour\s*\{[^}]*pointer-events:\s*none/s.test(css));
check('the ring takes no pointer events', /\.tour__ring\s*\{[^}]*pointer-events:\s*none/s.test(css));
check('the callout does', /\.tour__pop\s*\{[^}]*pointer-events:\s*auto/s.test(css));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
