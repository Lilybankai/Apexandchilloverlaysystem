/**
 * scripts/test-panel-parity.js — the renderer's wiring contract.
 * -----------------------------------------------------------------------------
 * The control panel is plain HTML wired up by id: control-panel.js looks up
 * `#port-input`, `#rate-range`, `#overlay-list` and forty-odd others, attaches
 * listeners, and pushes every change through `window.apex.*`. That wiring is
 * invisible to a typecheck and invisible to a screenshot — rename or retype one
 * element and the control silently stops working while the panel still LOOKS
 * perfect. A slider that no longer moves anything is the worst kind of bug here,
 * because the operator only finds out mid-stream.
 *
 * This exists so the panel can be restyled without that risk. It asserts:
 *
 *   1. every id the JS looks up exists in the HTML          (broken wiring)
 *   2. no id is declared twice                              (last one silently wins)
 *   3. every wired control still has the element type the JS assumes
 *      (a range that became a number reads .value the same and behaves
 *       completely differently)
 *   4. nothing in the HTML is wired to nothing               (dead markup — warning)
 *
 * The CONTRACT maps below are deliberately hand-frozen rather than derived from
 * the current file: derived expectations would follow a mistake straight into the
 * "expected" column and assert nothing at all.
 *
 * Run: node scripts/test-panel-parity.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PANEL = path.join(__dirname, '..', 'electron', 'control-panel');

/* -------------------------------------------------------------------------- */
/*  The frozen contract                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every id the control panel wires, and the element it must remain. `input:*`
 * is a tag plus its type attribute; a bare tag means the type is irrelevant.
 *
 * Grouped the way the UI groups them, so a reviewer can see at a glance which
 * feature loses a control if a line here starts failing.
 */
const PANEL_CONTRACT = {
  // Server + feed status
  'power-btn': 'button',
  'feed-pill': 'div',
  'feed-text': 'span',
  'error-banner': 'div',
  'error-text': 'span',
  'app-version': 'span',

  // App updates
  'update-banner': 'div',
  'update-text': 'span',
  'update-action': 'button',

  // Account (v0.21.0)
  account: 'div',
  'account-initials': 'span',
  'account-name': 'span',
  'account-email': 'span',
  'signout-btn': 'button',
  'signin-btn': 'button',

  // In-game overlay layer
  'ingame-toggle': 'input:checkbox',
  'ig-edit-btn': 'button',
  'ig-reset-btn': 'button',
  'ig-hotkey': 'button',
  'ig-hotkey-clear': 'button',

  // Widgets
  'overlay-list': 'ul',
  'combined-url': 'input:text',

  // Sponsor logos
  'sponsors-toggle': 'input:checkbox',
  'sponsor-range': 'input:range',
  'sponsor-echo': 'span',
  'sponsor-list': 'ul',
  'sponsor-add': 'button',

  // Keyboard + wheel bindings
  'binding-list': 'ul',

  // Settings — server
  'port-input': 'input:number',
  'port-echo': 'span',
  'rate-range': 'input:range',
  'rate-echo': 'span',
  'demo-toggle': 'input:checkbox',

  // Settings — appearance (all three ride the live appearance channel)
  'bg-range': 'input:range',
  'bg-echo': 'span',
  'text-range': 'input:range',
  'text-echo': 'span',
  'radar-icons-range': 'input:range',
  'radar-icons-echo': 'span',

  // Settings — audio + feedback
  'audio-toggle': 'input:checkbox',
  'audio-range': 'input:range',
  'audio-echo': 'span',
  'audio-test': 'button',
  'glow-toggle': 'input:checkbox',

  // Floating
  toast: 'div',
};

/** The same contract for the account screens (shipped v0.21.0). */
const AUTH_CONTRACT = {
  'pitch-lede': 'p',

  'signin-form': 'form',
  'si-email': 'input:email',
  'si-pw': 'input:password',
  'si-remember': 'input:checkbox',
  'offline-btn': 'button',

  'register-form': 'form',
  'rg-name': 'input:text',
  'rg-email': 'input:email',
  'rg-pw': 'input:password',
  'rg-sim': 'select',
  'rg-opt': 'input:checkbox',
  'rg-agree': 'input:checkbox',

  'resend-btn': 'button',

  'reset-request-form': 'form',
  'rr-email': 'input:email',

  'reset-verify-form': 'form',
  'rv-email': 'input:email',
  'rv-code': 'input:text',
  'rv-pw': 'input:password',
  'rv-pw2': 'input:password',
};

/* -------------------------------------------------------------------------- */
/*  Extraction                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every id declared in a page, with the element it sits on. Returns a list (not
 * a map) so duplicates survive to be reported.
 */
function declaredIds(html) {
  const found = [];
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)\bid="([a-zA-Z0-9_-]+)"([^>]*)>/g)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] + m[4];
    const type = /\btype="([a-zA-Z]+)"/.exec(attrs);
    // Only inputs are type-sensitive to the wiring; a <button> behaves the same
    // to us whether or not it spells out type="button".
    found.push({ id: m[3], kind: tag === 'input' && type ? `input:${type[1].toLowerCase()}` : tag });
  }
  return found;
}

/**
 * Every id the renderer looks up. Covers the panel's `$('#x')` helper plus the
 * raw DOM calls, so a future refactor away from the helper is still checked.
 */
function referencedIds(js) {
  const ids = new Set();
  const patterns = [
    /\$\(\s*['"]#([a-zA-Z0-9_-]+)['"]\s*\)/g,
    /querySelector(?:All)?\(\s*['"]#([a-zA-Z0-9_-]+)['"]\s*\)/g,
    /getElementById\(\s*['"]([a-zA-Z0-9_-]+)['"]\s*\)/g,
  ];
  // Deliberately id-only. auth.js also reaches elements by data attribute
  // (`[data-echo="confirm-email"]`, `[data-screen]`, `[data-msg]`) and those are
  // not ids — treating an attribute value as one reports a missing element that
  // was never supposed to exist.
  for (const re of patterns) for (const m of js.matchAll(re)) ids.add(m[1]);
  return ids;
}

/* -------------------------------------------------------------------------- */
/*  Checks                                                                    */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;
const warnings = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

/**
 * Verify one page against its contract.
 *
 * `extraRefs` names ids that legitimately live outside the page's own markup —
 * the panel's widget rows and binding rows are built by JS at runtime, so an id
 * the JS creates itself is not a missing element.
 */
function verifyPage({ label, htmlFile, jsFiles, contract, ignoreUnused = [] }) {
  console.log(`\n${label}`);

  const html = fs.readFileSync(path.join(PANEL, htmlFile), 'utf8');
  const js = jsFiles.map((f) => fs.readFileSync(path.join(PANEL, f), 'utf8')).join('\n');

  const declared = declaredIds(html);
  const declaredSet = new Set(declared.map((d) => d.id));
  const referenced = referencedIds(js);

  // 1. Every id the JS reaches for must exist.
  const missing = [...referenced].filter((id) => !declaredSet.has(id)).sort();
  check(
    `every id ${jsFiles.join('/')} looks up exists in ${htmlFile}`,
    missing.length === 0,
    missing.length ? `MISSING: ${missing.join(', ')}` : `${referenced.size} ids wired`,
  );

  // 2. No duplicate ids. getElementById returns the first; a listener attached
  //    to the second element then fires for a control nobody can see.
  const seen = new Set();
  const dupes = [];
  for (const d of declared) {
    if (seen.has(d.id)) dupes.push(d.id);
    seen.add(d.id);
  }
  check(
    `no duplicate ids in ${htmlFile}`,
    dupes.length === 0,
    dupes.length ? `DUPLICATED: ${[...new Set(dupes)].join(', ')}` : `${declaredSet.size} unique`,
  );

  // 3. Every contracted control is present AND still the right element.
  const byId = new Map(declared.map((d) => [d.id, d.kind]));
  const drifted = [];
  const absent = [];
  for (const [id, want] of Object.entries(contract)) {
    if (!byId.has(id)) absent.push(id);
    else if (byId.get(id) !== want) drifted.push(`${id}: ${want} -> ${byId.get(id)}`);
  }
  check(
    `all ${Object.keys(contract).length} contracted controls present`,
    absent.length === 0,
    absent.length ? `ABSENT: ${absent.join(', ')}` : 'none lost',
  );
  check(
    'no contracted control changed element type',
    drifted.length === 0,
    drifted.length ? drifted.join(' | ') : 'all as contracted',
  );

  // 4. Dead markup is a warning, not a failure — an id can exist for CSS or for
  //    an aria relationship without the JS ever touching it.
  const unused = [...declaredSet]
    .filter((id) => !referenced.has(id) && !ignoreUnused.some((p) => id.startsWith(p)))
    .sort();
  if (unused.length) warnings.push(`${htmlFile}: ids never referenced by JS — ${unused.join(', ')}`);
}

verifyPage({
  label: 'Control panel — index.html <-> control-panel.js',
  htmlFile: 'index.html',
  jsFiles: ['control-panel.js'],
  contract: PANEL_CONTRACT,
});

verifyPage({
  label: 'Account screens — auth.html <-> auth.js',
  htmlFile: 'auth.html',
  jsFiles: ['auth.js'],
  contract: AUTH_CONTRACT,
  // The icon sprite's <symbol id="i-*"> entries are referenced from HTML by
  // <use href>, never from JS.
  ignoreUnused: ['i-'],
});

/* -------------------------------------------------------------------------- */

if (warnings.length) {
  console.log('\nWarnings (not failures)');
  for (const w of warnings) console.log(`  WARN  ${w}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
