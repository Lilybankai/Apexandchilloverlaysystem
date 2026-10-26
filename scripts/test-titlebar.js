/**
 * scripts/test-titlebar.js — the control panel's own title bar.
 * -----------------------------------------------------------------------------
 * The main window has no Windows caption bar (electron/titleBar.js): the
 * panel's top strip is the drag area and Windows draws the real caption
 * buttons over its right end. Three ways that silently goes wrong, none of
 * which a screenshot of the page shows:
 *
 *   1. A control in the strip is not marked no-drag. It still LOOKS fine, but
 *      Windows treats a click on it as the start of a window drag and the
 *      button is dead. Start/Stop lives in that strip.
 *   2. The strip's right padding stops reserving room for the caption
 *      buttons — e.g. a later stylesheet resets `padding` — and Start slides
 *      under the minimise button.
 *   3. The buttons' colours or height drift from the strip they sit on.
 *
 * The Terms & Privacy window gets the same treatment over its own header.
 * The boundary: those two windows and no others. The in-game, training and
 * VR layers stay frameless.
 *
 * Run: node scripts/test-titlebar.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PANEL = path.join(ROOT, 'electron', 'control-panel');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const titleBar = require('../electron/titleBar');
const mainJs = read(ROOT, 'electron', 'main.js');
const hubCss = read(PANEL, 'hub.css');
const panelCss = read(PANEL, 'control-panel.css');
const indexHtml = read(PANEL, 'index.html');
const authHtml = read(PANEL, 'auth.html');
const authCss = read(PANEL, 'auth.css');
const legalHtml = read(PANEL, 'legal.html');

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** Every `selector { body }` at any nesting depth, as [selector, body]. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(css)))) out.push([m[1].trim(), m[2]]);
  return out;
}
const cssVar = (css, name) => {
  const m = stripComments(css).match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
};

/* -------------------------------------------------------------------------- */
console.log('\nthe window options');
/* -------------------------------------------------------------------------- */

const chrome = titleBar.mainWindowChrome();
check('the caption bar is hidden', chrome.titleBarStyle === 'hidden');
check(
  'the caption buttons are an overlay, not removed',
  chrome.titleBarOverlay && typeof chrome.titleBarOverlay === 'object',
  'titleBarOverlay keeps the real Windows buttons (Snap Layouts, hit-testing)',
);
const ov = chrome.titleBarOverlay || {};
check('the overlay names a colour', /^#[0-9a-f]{6}$/i.test(ov.color || ''), String(ov.color));
check('the overlay names a glyph colour', /^#[0-9a-f]{6}$/i.test(ov.symbolColor || ''), String(ov.symbolColor));
check(
  'the buttons are the colour of the strip (control-panel.css --bg)',
  (ov.color || '').toLowerCase() === (cssVar(panelCss, '--bg') || '').toLowerCase(),
  `${ov.color} vs ${cssVar(panelCss, '--bg')}`,
);
check(
  'the glyphs are the panel\'s secondary text (--text-2)',
  (ov.symbolColor || '').toLowerCase() === (cssVar(panelCss, '--text-2') || '').toLowerCase(),
);
check(
  'setTitleBarOverlay gets the same options',
  JSON.stringify(titleBar.titleBarOverlay()) === JSON.stringify(ov),
);

const topbarRules = rules(hubCss).filter(([sel]) => sel === '.topbar');
const topbarHeight = topbarRules
  .map(([, body]) => (body.match(/(?:^|;|\s)height:\s*(\d+)px/) || [])[1])
  .find(Boolean);
check('hub.css gives the strip a fixed height', Boolean(topbarHeight));
check(
  'the buttons fill the strip above its 1px rule',
  ov.height === Number(topbarHeight) - 1 && titleBar.TOPBAR_HEIGHT === Number(topbarHeight),
  `overlay ${ov.height}px, strip ${topbarHeight}px`,
);

/* -------------------------------------------------------------------------- */
console.log('\nonly the main window and the Terms window');
/* -------------------------------------------------------------------------- */

/** The options object of the `new BrowserWindow({` that follows `anchor`. */
function windowBlock(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  const start = src.indexOf('new ', at);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && (depth -= 1) === 0) return src.slice(open, i + 1);
  }
  return null;
}
const mainBlock = windowBlock(mainJs, 'mainWindow = new BrowserWindow(');
check('the main window is found in main.js', Boolean(mainBlock));
check(
  'the main window takes the title bar options',
  /\.\.\.titleBar\.mainWindowChrome\(\)/.test(mainBlock || ''),
);
check('main.js requires electron/titleBar', /require\('\.\/titleBar'\)/.test(mainJs));

const others = [
  ['the in-game layer', mainJs, 'overlayWin = new BrowserWindow('],
  ['the training layer', read(ROOT, 'electron', 'trainingLayer.js'), 'new deps.BrowserWindow('],
  ['the VR panel window', read(ROOT, 'electron', 'vr', 'index.js'), 'new this.BrowserWindow('],
];
for (const [name, src, anchor] of others) {
  const block = windowBlock(src, anchor);
  check(`${name} is found`, Boolean(block));
  check(
    `${name} keeps its own frame`,
    block && !/titleBarStyle|titleBarOverlay|WindowChrome/.test(block),
  );
  check(`${name} is still frameless`, /frame:\s*false/.test(block || ''));
}

/* -------------------------------------------------------------------------- */
console.log('\nthe strip is the drag area, and keeps clear of the buttons');
/* -------------------------------------------------------------------------- */

check(
  'the strip is draggable',
  topbarRules.some(([, body]) => /-webkit-app-region:\s*drag/.test(body)),
);
const capW = cssVar(hubCss, '--caption-w') || '';
check(
  '--caption-w is read from the window-controls overlay',
  /env\(titlebar-area-width/.test(capW) && /env\(titlebar-area-x/.test(capW),
  capW,
);
check(
  'and is 0 where there is no overlay (browser, web pit wall)',
  /env\(titlebar-area-width,\s*100vw\)/.test(capW) && /env\(titlebar-area-x,\s*0px\)/.test(capW),
);
const padRules = rules(hubCss).filter(
  ([sel, body]) => sel.split(',').some((s) => s.trim() === '.topbar') && /(^|;|\s)padding(-right)?\s*:/.test(body),
);
check('exactly one rule pads the strip', padRules.length === 1, `${padRules.length} rules`);
check(
  'and its right side reserves the caption buttons',
  padRules.length === 1 && /padding:[^;]*var\(--caption-w\)/.test(padRules[0][1]),
);
// Every stylesheet the panel loads AFTER hub.css: a later one resetting the
// strip's padding would quietly undo the reservation. (control-panel.css loads
// first and is overridden by hub.css, which is why its old padding is fine.)
const sheets = [...indexHtml.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
check('the panel stylesheets are found', sheets.includes('hub.css') && sheets.length > 3);
for (const sheet of sheets.slice(sheets.indexOf('hub.css') + 1)) {
  const bad = rules(read(PANEL, sheet)).filter(
    ([sel, body]) => /\.topbar\b/.test(sel) && /(^|;|\s)(padding(-right)?|-webkit-app-region)\s*:/.test(body),
  );
  check(`${sheet} leaves the strip's padding and drag alone`, bad.length === 0, bad.map(([s]) => s).join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\nevery control in the strip is clickable (no-drag)');
/* -------------------------------------------------------------------------- */

const parse = (sel) => ({
  tag: (sel.match(/^[a-z][\w-]*/i) || [])[0] || null,
  classes: [...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
  attrs: [...sel.matchAll(/\[([\w-]+)\]/g)].map((m) => m[1]),
});
/**
 * A stylesheet's no-drag selectors under `scope` (`.topbar`, `header`), as
 * simple compounds (tag, .class, [attr]), returned as a matcher for parsed
 * elements. `.count` is how many compounds it found.
 */
function noDragMatcher(css, scope) {
  const list = rules(css)
    .filter(([, body]) => /-webkit-app-region:\s*no-drag/.test(body))
    .flatMap(([sel]) =>
      sel
        .split(/,(?![^(]*\))/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith(`${scope} `))
        .map((s) => s.slice(scope.length + 1).trim()),
    )
    .flatMap((s) => {
      const m = s.match(/^:is\(([^)]*)\)$/);
      return m ? m[1].split(',').map((x) => x.trim()) : [s];
    });
  const compounds = list.map(parse);
  const fn = (el) =>
    compounds.some(
      (c) =>
        (!c.tag || c.tag === el.tag) &&
        c.classes.every((k) => el.classes.includes(k)) &&
        c.attrs.every((a) => a in el.attrs) &&
        (c.tag || c.classes.length || c.attrs.length),
    );
  fn.count = compounds.length;
  return fn;
}
const matches = noDragMatcher(hubCss, '.topbar');
check('a no-drag rule exists for the strip', matches.count > 0);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'label', 'summary', 'details', 'option']);
const INTERACTIVE_ATTRS = ['tabindex', 'role', 'title', 'contenteditable', 'onclick', 'draggable'];

/** Elements inside the first header matching `opener`, each with its ancestors. */
function headerElements(html, opener = /<header\s+class="topbar"/) {
  const src = html.replace(/<!--[\s\S]*?-->/g, '');
  const start = src.search(opener);
  if (start < 0) return null;
  const end = src.indexOf('</header>', start);
  const chunk = src.slice(start, end);
  const out = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(chunk))) {
    const [, close, rawTag, rawAttrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (close) {
      while (stack.length && stack.pop().tag !== tag);
      continue;
    }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([\w-:]+)(?:\s*=\s*"([^"]*)")?/g)) attrs[a[1].toLowerCase()] = a[2] ?? '';
    const el = { tag, attrs, classes: (attrs.class || '').split(/\s+/).filter(Boolean), ancestors: [...stack] };
    out.push(el);
    if (!selfClose && !VOID.has(tag)) stack.push(el);
  }
  return out;
}

const els = headerElements(indexHtml);
check('the top strip is found in index.html', Array.isArray(els) && els.length > 5);
const interactive = (els || []).filter(
  (el) => INTERACTIVE_TAGS.has(el.tag) || INTERACTIVE_ATTRS.some((a) => a in el.attrs),
);
const ids = interactive.map((el) => el.attrs.id).filter(Boolean);
// Guard the parser itself: if it stopped finding the controls we know are
// there, "every control is no-drag" would pass vacuously.
for (const id of ['power-btn', 'signout-btn', 'signin-btn', 'mode-seg']) {
  check(`the strip's #${id} is seen`, ids.includes(id));
}
check(
  'both halves of the Race/Training switch are seen',
  interactive.filter((el) => el.tag === 'button' && 'data-mode' in el.attrs).length === 2,
);
for (const el of interactive) {
  const name = el.attrs.id ? `#${el.attrs.id}` : `<${el.tag}${el.classes.length ? `.${el.classes.join('.')}` : ''}${'data-mode' in el.attrs ? `[data-mode=${el.attrs['data-mode']}]` : ''}>`;
  check(`${name} is no-drag`, matches(el) || el.ancestors.some(matches), 'it would be a dead click');
}

// Controls added by script would escape the markup check above. None do
// today; if that changes, they must carry a no-drag selector too.
const scripts = fs.readdirSync(PANEL).filter((f) => f.endsWith('.js') && !f.startsWith('__shot'));
const touching = scripts.filter((f) => /['"`.]topbar\b|querySelector\(['"]header/.test(read(PANEL, f)));
check(
  'no panel script builds controls into the strip',
  touching.length === 0,
  `${touching.join(', ')} — check what it adds is covered by the no-drag rule in hub.css, then update this test`,
);

/* -------------------------------------------------------------------------- */
console.log('\nthe account screens (same window)');
/* -------------------------------------------------------------------------- */

check('auth.html has a drag strip', /<div class="titlebar"[^>]*><\/div>/.test(authHtml), 'an empty element');
const authStrip = rules(authCss).find(([sel]) => sel === '.titlebar');
check('auth.css styles it', Boolean(authStrip));
check('it is draggable', authStrip && /-webkit-app-region:\s*drag/.test(authStrip[1]));
check(
  'it is the overlay\'s height, and nothing outside the app',
  authStrip && /height:\s*env\(titlebar-area-height,\s*0px\)/.test(authStrip[1]),
);
check(
  'the form rests below it',
  rules(authCss).some(([sel, body]) => sel === '.auth__form' && /padding-top:[^;]*env\(titlebar-area-height/.test(body)),
);

/* -------------------------------------------------------------------------- */
console.log('\nthe Terms & Privacy window');
/* -------------------------------------------------------------------------- */

const legalBlock = windowBlock(mainJs, 'legalWindow = new BrowserWindow(');
check('the Terms window is found in main.js', Boolean(legalBlock));
check('it takes its title bar options', /\.\.\.titleBar\.legalWindowChrome\(\)/.test(legalBlock || ''));
const legalStyle = (legalHtml.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
const lc = titleBar.legalWindowChrome();
const lov = lc.titleBarOverlay || {};
check('its caption bar is hidden', lc.titleBarStyle === 'hidden');
check(
  'its buttons are the colour of its header (--panel)',
  (lov.color || '').toLowerCase() === (cssVar(legalStyle, '--panel') || '').toLowerCase(),
  `${lov.color} vs ${cssVar(legalStyle, '--panel')}`,
);
check(
  "its glyphs are the document's secondary text (--dim)",
  (lov.symbolColor || '').toLowerCase() === (cssVar(legalStyle, '--dim') || '').toLowerCase(),
);
// The first `header {}` is the screen rule; the print one comes later.
const screenHeader = (rules(legalStyle).find(([sel]) => sel === 'header') || [])[1] || '';
check('the header is draggable', /-webkit-app-region:\s*drag/.test(screenHeader));
check(
  'the header is as tall as the buttons plus its rule',
  Number((screenHeader.match(/min-height:\s*(\d+)px/) || [])[1]) === lov.height + 1,
);
check(
  'its right side reserves the caption buttons',
  /padding:[^;]*var\(--caption-w\)/.test(screenHeader) &&
    /env\(titlebar-area-width,\s*100vw\)/.test(cssVar(legalStyle, '--caption-w') || ''),
);
check('a narrow window wraps the links instead of hiding them', /flex-wrap:\s*wrap/.test(screenHeader));
// If the page itself scrolled, its scrollbar would run up the right edge
// under the caption buttons (the close button would sit on the scroll-up end).
const legalRule = (sel) => (rules(legalStyle).find(([s]) => s === sel) || [])[1] || '';
check(
  'the page does not scroll; the document does, below the header',
  /overflow:\s*hidden/.test(legalRule('body')) && /overflow-y:\s*auto/.test(legalRule('main')),
);
const legalMatches = noDragMatcher(legalStyle, 'header');
check('a no-drag rule exists for the header', legalMatches.count > 0);
const legalInteractive = (headerElements(legalHtml, /<header>/) || []).filter(
  (el) => INTERACTIVE_TAGS.has(el.tag) || INTERACTIVE_ATTRS.some((a) => a in el.attrs),
);
check(
  "the header's three section links are seen",
  legalInteractive.filter((el) => el.tag === 'a').length === 3,
  `${legalInteractive.length} interactive elements`,
);
for (const el of legalInteractive) {
  const name = `<${el.tag}${el.attrs.href ? ` href=${el.attrs.href}` : ''}>`;
  check(`${name} is no-drag`, legalMatches(el) || el.ancestors.some(legalMatches), 'it would be a dead click');
}
check('no script in the document can add controls to the header', !/<script\b/i.test(legalHtml));

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
