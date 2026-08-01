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

  // Dashboard stat tiles. v0.24.0 swapped these from SERVER stats (feed, port,
  // update rate) to the driver stats the design system's Dashboard specifies;
  // the server facts they replaced all live in the footer below.
  'stat-laps-week': 'span',
  'stat-time-driven': 'span',
  'stat-time-sub': 'span',
  'stat-widgets': 'span',
  // The fourth tile was Clean laps, a stand-in for the League rank the design
  // system specifies. v0.26.0 gave it a real answer — pace against the class
  // reference — and clean laps moved onto the week card as `week-clean`.
  'stat-pace': 'span',
  'stat-pace-sub': 'span',

  // This week — the lap database's dashboard card (v0.24.0)
  'week-sub': 'p',
  'week-clean': 'p',
  'week-chart': 'div',
  'week-bests': 'section',
  'week-bests-list': 'ul',
  'week-empty': 'p',

  // Pace vs reference — the Leaderboard tab's first real card (v0.26.0).
  // `pace-credit*` is the attribution for Ohne Speed's reference times and is
  // contracted like any other control: it is part of the feature, and an
  // attribution that can be silently deleted by a restyle is worse than none.
  'pace-list': 'ul',
  'pace-empty': 'p',

  // League boards (v0.45.0) — the cloud half of the Leaderboard tab.
  'board-track': 'select',
  'board-classes': 'div',
  'board-car': 'select',
  'board-title': 'h2',
  'board-count': 'span',
  'board-list': 'ul',
  'board-empty': 'p',

  // The kit's RankBar, twice — Dashboard (`rank-*`) and Leaderboard (`lb-*`).
  // Contracted separately because they are the same component at two ids, and
  // losing one silently would leave the other looking perfectly fine.
  'pace-card': 'section',
  'rank-pct': 'span',
  'rank-band': 'span',
  'rank-name': 'span',
  'rank-lap': 'span',
  'rank-gap': 'span',
  'rank-dot': 'span',
  'rank-note': 'p',
  'lb-rank': 'section',
  'lb-pct': 'span',
  'lb-band': 'span',
  'lb-rank-name': 'span',
  'lb-lap': 'span',
  'lb-gap': 'span',
  'lb-dot': 'span',
  'lb-note': 'p',
  'pace-credit': 'div',
  'pace-credit-title': 'strong',
  'pace-credit-people': 'span',
  'pace-credit-updated': 'span',
  'pace-credit-sheet': 'button',
  'pace-credit-discord': 'button',
  'pace-credit-youtube': 'button',

  // Lap upload status (v0.25.0)
  'sync-dot': 'span',
  'sync-text': 'span',
  'sync-btn': 'button',

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

  // Suggestions — the in-app feedback form (v0.49.0)
  'fb-kind': 'select',
  'fb-message': 'textarea',
  'fb-submit': 'button',
  'fb-status': 'span',

  // Admin panel (v0.49.0) — league-staff usage + feedback inbox. The tab starts
  // hidden and is revealed by admin:whoami, so it is wired like any other
  // control: a restyle that dropped one of these would silently break triage.
  'admin-tab': 'button',
  'admin-msg': 'p',
  'admin-refresh': 'button',
  'adm-active-today': 'span',
  'adm-active-week': 'span',
  'adm-active-month': 'span',
  'adm-sessions-week': 'span',
  'adm-total-users': 'span',
  'adm-new-feedback': 'span',
  'adm-daily-chart': 'div',
  'adm-daily-empty': 'p',
  'adm-versions': 'ul',
  'adm-versions-empty': 'p',
  'adm-fb-filter': 'select',
  'adm-feedback-list': 'ul',
  'adm-feedback-empty': 'p',
  // Driver roster (v0.50.0). The search and sort both re-query the league, so
  // losing either one leaves a list that looks right and answers the wrong
  // question — exactly the silent failure this file exists to catch.
  'adm-users-search': 'input:search',
  'adm-users-sort': 'select',
  'adm-users-list': 'ul',
  'adm-users-empty': 'p',
  'adm-users-note': 'p',

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
    // Any bare '#id' string literal. The shell's stat tiles and footer are
    // addressed through helpers (`setText('#foot-url', …)`), so a selector-call
    // pattern alone cannot see them — and an id that the guard cannot see is an
    // id it cannot protect from being renamed.
    /['"]#([a-zA-Z0-9_-]+)['"]/g,
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
 * Icon ids provided by the shared sprite (icons.js), as `i-<name>`. The sprite is
 * injected at runtime, so from a page's point of view these are declared
 * elsewhere — hence they are added to each page's declared set below.
 */
function spriteIds() {
  const js = fs.readFileSync(path.join(PANEL, 'icons.js'), 'utf8');
  const body = js.slice(js.indexOf('const ICONS = {'), js.indexOf('const NS ='));
  const ids = new Set();
  // Keys are either bare (`monitor:`) or quoted (`'layout-grid':`).
  for (const m of body.matchAll(/^\s{4}(?:'([a-z0-9-]+)'|([a-z0-9-]+)):/gm)) {
    ids.add(`i-${m[1] || m[2]}`);
  }
  return ids;
}

/**
 * Every icon a page asks for, from markup (`<use href="#i-x">`) and from JS
 * (`apexIcon('x')`, `'#i-x'`).
 */
function iconRefs(sources) {
  const refs = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/href="#(i-[a-z0-9-]+)"/g)) refs.add(m[1]);
    for (const m of src.matchAll(/['"]#(i-[a-z0-9-]+)['"]/g)) refs.add(m[1]);
    for (const m of src.matchAll(/apexIcon\(\s*['"]([a-z0-9-]+)['"]/g)) refs.add(`i-${m[1]}`);
    // The widget cards pick their icon indirectly, through the id->icon map in
    // icons.js, so the map's VALUES are references too — without this every
    // per-widget icon reads as unused.
    const map = /APEX_WIDGET_ICONS\s*=\s*\{([\s\S]*?)\};/.exec(src);
    if (map) for (const m of map[1].matchAll(/:\s*'([a-z0-9-]+)'/g)) refs.add(`i-${m[1]}`);
  }
  return refs;
}

/**
 * Verify one page against its contract.
 *
 * `ignoreUnused` names id prefixes that may legitimately go unreferenced by JS.
 */
function verifyPage({ label, htmlFile, jsFiles, contract, ignoreUnused = [] }) {
  console.log(`\n${label}`);

  const html = fs.readFileSync(path.join(PANEL, htmlFile), 'utf8');
  const js = jsFiles.map((f) => fs.readFileSync(path.join(PANEL, f), 'utf8')).join('\n');

  const declared = declaredIds(html);
  const declaredSet = new Set(declared.map((d) => d.id));
  // The sprite's symbols are injected by icons.js rather than written into the
  // page, so they count as declared for the id checks below. They are excluded
  // from the dead-markup warning, which the icon section covers properly.
  const sprite = spriteIds();
  for (const id of sprite) declaredSet.add(id);
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
    .filter(
      (id) =>
        !referenced.has(id) && !sprite.has(id) && !ignoreUnused.some((p) => id.startsWith(p)),
    )
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
/*  Icon sprite                                                               */
/* -------------------------------------------------------------------------- */
/*
 * A <use> pointing at a symbol that does not exist renders NOTHING — no error,
 * no console warning, just a blank space where an icon should be. With ~60
 * hand-written references across two pages that is the single easiest thing to
 * get silently wrong here.
 */

console.log('\nIcon sprite — icons.js');

{
  const available = spriteIds();
  const sources = ['index.html', 'auth.html', 'control-panel.js', 'auth.js', 'icons.js'].map((f) =>
    fs.readFileSync(path.join(PANEL, f), 'utf8'),
  );
  const wanted = iconRefs(sources);
  const missing = [...wanted].filter((id) => !available.has(id)).sort();
  check(
    'every icon referenced by markup or JS exists in the sprite',
    missing.length === 0,
    missing.length ? `MISSING: ${missing.join(', ')}` : `${wanted.size} of ${available.size} used`,
  );

  const unused = [...available].filter((id) => !wanted.has(id)).sort();
  if (unused.length) {
    warnings.push(`icons.js: symbols never referenced — ${unused.join(', ')}`);
  }
}

/* -------------------------------------------------------------------------- */

if (warnings.length) {
  console.log('\nWarnings (not failures)');
  for (const w of warnings) console.log(`  WARN  ${w}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
