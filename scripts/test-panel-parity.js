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
  // What the pending update contains, before installing it.
  'update-notes': 'button',

  // Release channel (v0.57.0) — the staff-only card in Settings that decides
  // whether this install follows stable releases or the beta feed. Contracted
  // because it is hidden by default: a broken control here looks exactly like
  // the card correctly staying away, and the failure mode is a beta tester
  // stuck on a build with no way back to stable.
  'updates-card': 'section',
  'update-channel': 'select',
  'update-channel-hint': 'span',
  'update-running': 'span',
  'update-status': 'span',
  'update-check': 'button',

  // Subscription (v0.69.0) — the Settings card showing the account's standing
  // and the way into Stripe's Customer Portal. Contracted because it is hidden
  // while signed out: a broken control here looks exactly like the card
  // correctly staying away, and the failure mode is a paying driver with no
  // way to reach their own billing.
  'sub-card': 'section',
  'sub-plan-status': 'span',
  'sub-hint': 'span',
  'sub-manage-btn': 'button',

  // Admin — league codes (v0.69.0). The whole card only exists for admins, so a
  // lost id fails silently for everyone else by design — exactly what this
  // contract exists to catch.
  'adm-code-note': 'input:text',
  'adm-code-count': 'input:number',
  'adm-code-issue': 'button',
  'adm-code-out': 'p',
  'adm-codes-list': 'ul',
  'adm-codes-empty': 'p',

  // Admin — billing (v0.70.0): the free/trial/paying mix, the run rate, and the
  // twelve-month revenue and churn charts. Contracted for the same reason as
  // the rest of the tab — nobody but staff ever sees these, so a control that
  // stops being wired looks identical to the tab correctly hiding itself.
  'adm-bill-free': 'span',
  'adm-bill-free-sub': 'span',
  'adm-bill-trial': 'span',
  'adm-bill-paying': 'span',
  'adm-bill-paying-sub': 'span',
  'adm-bill-mrr': 'span',
  'adm-bill-mrr-sub': 'span',
  'adm-bill-mix': 'ul',
  'adm-bill-mix-empty': 'p',
  'adm-mrr-chart': 'div',
  'adm-mrr-empty': 'p',
  'adm-mrr-foot': 'p',
  'adm-churn-chart': 'div',
  'adm-churn-empty': 'p',
  'adm-churn-foot': 'p',
  'adm-mrr-tile': 'span',
  'adm-mrr-tile-sub': 'span',

  // Admin — section nav and the version list's expander (v0.70.0). The nav is
  // the only way to reach three of the four sections, so an unwired button here
  // hides most of the tab rather than merely looking wrong.
  'admin-seg': 'nav',
  'adm-versions-more': 'button',
  'adm-versions-foot': 'p',

  // Speed units (v0.57.2) — one app-wide preference behind three widgets'
  // speed readouts. Contracted because a control that silently stops writing
  // leaves the overlays showing kph to someone who set mph, which reads as the
  // conversion being broken rather than the setting being unwired.
  'speed-unit': 'select',

  // What's new — the release-notes sheet (v0.56.0). Contracted because it is
  // shown automatically exactly once per update: if the close controls stop
  // working there is no second chance to notice, and the driver is left with a
  // modal they cannot dismiss.
  whatsnew: 'div',
  'whatsnew-scrim': 'div',
  'whatsnew-title': 'h2',
  'whatsnew-sub': 'p',
  'whatsnew-body': 'div',
  'whatsnew-close': 'button',
  'whatsnew-done': 'button',
  'whatsnew-all': 'a',
  'whatsnew-open': 'button',

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
  // Why a board's laps have no scores, when the reference cannot place them —
  // and the "click a lap" invitation, which is hidden in exactly that case.
  'board-refnote': 'p',
  'board-hint': 'p',

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
  // Renamed after the driver selected on the board — "Your pace" by default.
  'lb-rank-title': 'h2',
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

  // Streamers tab — account linking (moved here from Overlays) + StreamBot
  'streamers-seg': 'nav',
  'streamers-widget-list': 'ul',
  'chat-twitch-input': 'input:text',
  'chat-twitch-status': 'span',
  'chat-tw-link': 'button',
  'chat-tw-unlink': 'button',
  'chat-tw-status': 'span',
  'chat-tw-code': 'span',
  'chat-yt-link': 'button',
  'chat-yt-unlink': 'button',
  'chat-yt-status': 'span',
  'chat-yt-relink': 'span',
  'sb-enabled': 'input:checkbox',
  'sb-platform-twitch': 'input:checkbox',
  'sb-platform-youtube': 'input:checkbox',
  'sb-status': 'span',
  'sb-budget-bar': 'span',
  'sb-budget-text': 'span',
  'sb-budget-session': 'input:number',
  'sb-budget-daily': 'input:number',
  'sb-budget-mininterval': 'input:number',
  'sb-cmd-list': 'ul',
  'sb-cmd-add': 'button',
  'sb-timer-list': 'ul',
  'sb-timer-add': 'button',
  'sb-alert-list': 'ul',
  'sb-goal-list': 'ul',
  'sb-goal-add': 'button',
  'streamer-guide-open': 'button',
  'streamer-guide': 'div',
  'streamer-guide-scrim': 'div',
  'streamer-guide-icon': 'span',
  'streamer-guide-title': 'h2',
  'streamer-guide-sub': 'p',
  'streamer-guide-body': 'div',
  'streamer-guide-dots': 'div',
  'streamer-guide-back': 'button',
  'streamer-guide-next': 'button',
  'streamer-guide-close': 'button',

  // Sponsor logos
  'sponsors-toggle': 'input:checkbox',
  'sponsor-range': 'input:range',
  'sponsor-echo': 'span',
  'sponsor-list': 'ul',
  'sponsor-add': 'button',

  // Keyboard + wheel bindings
  'binding-list': 'ul',
  'bindings-guide-open': 'button',
  'bindings-guide': 'div',
  'bindings-guide-scrim': 'div',
  'bindings-guide-icon': 'span',
  'bindings-guide-title': 'h2',
  'bindings-guide-sub': 'p',
  'bindings-guide-body': 'div',
  'bindings-guide-dots': 'div',
  'bindings-guide-back': 'button',
  'bindings-guide-next': 'button',
  'bindings-guide-close': 'button',

  // Settings — server
  'port-input': 'input:number',
  'port-echo': 'span',
  'rate-range': 'input:range',
  'rate-echo': 'span',
  'demo-toggle': 'input:checkbox',

  // Settings — application behaviour. Contracted because the switch doesn't
  // show its work: a dead "launch on startup" looks identical to a live one
  // until the operator reboots. (Minimise-to-tray is deliberately NOT here any
  // more — it is no longer a setting; the panel always minimises to the tray.)
  'startup-toggle': 'input:checkbox',

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

  // Schedule tab (SimGrid championships). The cards themselves are built at
  // runtime; the frame (filter, refresh, empty/error) is static and contracted
  // because a dropped id here leaves a calendar that looks like it is loading
  // forever.
  'sk-filter': 'nav',
  'sk-refresh': 'button',
  'sk-msg': 'p',
  'sk-grid': 'div',
  'sk-empty': 'p',

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
  // The unread-feedback COUNT is no longer a tile — it is a badge built on the
  // Feedback section's nav button, so it has no id of its own to contract.
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

  // Setup editor (v0.65.0). Only the static frame is contracted — every
  // setting row is built at runtime from the sim's own key set, so rows have
  // no ids at all (kept references instead, per the opacityRow() pattern).
  // A broken id here strands the whole tab, not one control: the poll loop,
  // the apply button and the offline card all hang off these.
  'setup-status': 'span',
  'setup-car': 'span',
  'setup-class': 'span',
  'setup-sym': 'span',
  'setup-offline': 'div',
  'setup-body': 'div',
  'setup-tabs': 'nav',
  'setup-rows': 'div',
  'setup-3d-toggle': 'button',
  'setup-canvas-wrap': 'div',
  'setup-macro-list': 'div',
  'setup-staged': 'div',
  'setup-staged-count': 'span',
  'setup-apply': 'button',
  'setup-revert': 'button',
  'setup-info-pop': 'div',
  'setup-info-title': 'h3',
  'setup-info-body': 'div',
  'setup-info-close': 'button',
  // Setup library (v0.67.0-beta.3): the .svm archive below the editor. Rows
  // and filter options are runtime-built; the frame, the two dialogs and the
  // filter controls are static and contracted.
  'setup-library': 'section',
  'setup-lib-import': 'button',
  'setup-lib-save': 'button',
  'setup-lib-track': 'select',
  'setup-lib-car': 'select',
  'setup-lib-session': 'nav',
  'setup-lib-colors': 'div',
  'setup-lib-sort': 'select',
  'setup-lib-list': 'ul',
  'setup-lib-empty': 'p',
  'setup-save-pop': 'div',
  'setup-save-name': 'input:text',
  'setup-save-session': 'nav',
  'setup-save-colors': 'div',
  'setup-save-confirm': 'button',
  'setup-save-cancel': 'button',
  // Share dialog (v0.67.0-beta.4) — clipboard-as-file for chat apps, or a
  // save dialog. Load lost its dialog the same beta: loading stages in the
  // editor now, so there is nothing destructive left to confirm.
  'setup-share-pop': 'div',
  'setup-share-text': 'p',
  'setup-share-copy': 'button',
  'setup-share-file': 'button',
  'setup-share-cancel': 'button',

  // First-run walkthrough. Contracted because it is the one screen NOBODY
  // clicks their way back into after it breaks: it opens itself once, and a
  // broken Next would strand a driver on step one of six.
  'setup-guide-open': 'button',
  'setup-guide': 'div',
  'setup-guide-scrim': 'div',
  'setup-guide-icon': 'span',
  'setup-guide-title': 'h2',
  'setup-guide-sub': 'p',
  'setup-guide-body': 'div',
  'setup-guide-dots': 'div',
  'setup-guide-back': 'button',
  'setup-guide-next': 'button',
  'setup-guide-close': 'button',

  // Fuel tab (v0.77.0-beta.1) — the strategy calculator ported from the
  // standalone LMU fuel app. Contracted because fuel-panel.js grabs every one
  // of these at load and wires listeners; a renamed id would leave a dead
  // control that still renders.
  'fuel-reset': 'button',
  'fuel-circuit': 'select',
  'fuel-layout': 'select',
  'fuel-class': 'select',
  'fuel-maker': 'select',
  'fuel-car': 'select',
  'fuel-mode-seg': 'nav',
  'fuel-minutes-field': 'label',
  'fuel-minutes': 'input:number',
  'fuel-chips': 'div',
  'fuel-laps-field': 'label',
  'fuel-laps': 'input:number',
  'fuel-laptime-min': 'input:number',
  'fuel-laptime-sec': 'input:number',
  'fuel-laptime-hint': 'span',
  'fuel-consumption': 'input:number',
  'fuel-consumption-label': 'span',
  'fuel-consumption-hint': 'span',
  'fuel-safety': 'input:number',
  'fuel-formation': 'input:checkbox',
  'fuel-tank-field': 'label',
  'fuel-tank': 'input:number',
  'fuel-tank-hint': 'span',
  'fuel-stint-seg': 'nav',
  'fuel-pit-loss': 'input:number',
  'fuel-pit-rate': 'input:number',
  'fuel-pit-rate-label': 'span',
  'fuel-pit-tyres': 'input:number',
  'fuel-pit-every': 'input:number',
  'fuel-pit-reset': 'button',
  'fuel-empty': 'div',
  'fuel-result': 'div',

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
  // 'offline-btn' left with the free app (v0.69.0): the panel now needs an
  // entitled account, so there is no offline door on the sign-in screen.

  // Subscribe screen (v0.69.0) — the paywall between an account and the app.
  // Contracted hard: a driver who has just PAID lands here waiting for the
  // gate to open, and a dead control at that moment reads as theft.
  'sub-lede': 'p',
  'sub-start-btn': 'button',
  'sub-code-form': 'form',
  'sub-code-input': 'input:text',
  'sub-code-btn': 'button',
  'sub-refresh-btn': 'button',
  'sub-signout-btn': 'button',

  'register-form': 'form',
  'rg-name': 'input:text',
  'rg-email': 'input:email',
  'rg-pw': 'input:password',
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
  // The setup editor's files are part of the same page. The data files carry
  // no DOM wiring but are scanned anyway — free, and future-proof. The
  // setup-3d/ modules and vendor/ are deliberately NOT scanned: they touch no
  // ids (the canvas is created inside #setup-canvas-wrap by the editor).
  jsFiles: [
    'control-panel.js',
    'setup-editor.js',
    'setup-groups.js',
    'setup-info.js',
    'setup-macros.js',
    'setup-guide.js',
    'streamer-guide.js',
    'bindings-guide.js',
    // The Fuel tab. Only the panel is scanned: fuel-data.js is deliberately
    // NOT — its class colors ('#FF3333' …) read as id lookups to this
    // scanner, and neither engine file touches the DOM anyway.
    'fuel-panel.js',
  ],
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
  // The walkthrough names its icons as data (`icon: 'zap'`) and builds the
  // <use> at runtime, so no regex over the source can see them. Taking them
  // from the module itself is exact, and means a step added with a typo'd
  // icon fails here rather than rendering a blank square in front of a driver.
  for (const s of require('../electron/control-panel/setup-guide.js').STEPS) {
    wanted.add(`i-${s.icon}`);
  }
  for (const s of require('../electron/control-panel/streamer-guide.js').STEPS) {
    wanted.add(`i-${s.icon}`);
  }
  for (const s of require('../electron/control-panel/bindings-guide.js').STEPS) {
    wanted.add(`i-${s.icon}`);
  }
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

console.log('\nBindings walkthrough — bindings-guide.js');
{
  const guide = require('../electron/control-panel/bindings-guide.js');
  const textOf = (s) => [s.lead, ...(s.points || [])].join(' ');
  const all = (guide.STEPS || []).map(textOf).join('\n');
  check(
    'guide has a full tour',
    Array.isArray(guide.STEPS) && guide.STEPS.length >= 4,
    guide.STEPS && guide.STEPS.length,
  );
  check(
    'every step is complete',
    (guide.STEPS || []).every(
      (s) => s.id && s.icon && s.title && s.lead && Array.isArray(s.points) && s.points.length > 0,
    ),
  );
  check(
    'no duplicate step ids',
    new Set((guide.STEPS || []).map((s) => s.id)).size === (guide.STEPS || []).length,
  );
  check(
    'covers Stream Deck, F13–F24, and no plugin',
    /Stream Deck/.test(all) && /F13/.test(all) && /no plugin/i.test(all),
  );
  check(
    'says wheels are a different path',
    /Scan for wheels/.test(all) && /DirectInput/.test(all),
  );
}

/* -------------------------------------------------------------------------- */

if (warnings.length) {
  console.log('\nWarnings (not failures)');
  for (const w of warnings) console.log(`  WARN  ${w}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
