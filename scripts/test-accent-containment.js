#!/usr/bin/env node
/**
 * scripts/test-accent-containment.js — the panel is its own containing block.
 * -----------------------------------------------------------------------------
 * Every widget wears a 3px brand accent bar down its left edge. It is chrome,
 * not data, so it is drawn by CSS alone:
 *
 *   .panel          { position: relative; overflow: hidden; }      theme.css
 *   .panel::before  { position: absolute; inset: 0 auto 0 0; }     theme.css
 *
 * `inset: 0 … 0` means "as tall as my containing block", and the ONLY reason
 * that resolves to the panel is the `position: relative` on the line above it.
 * Take that away and the bar goes looking for the next positioned ancestor —
 * and `.panel`'s `overflow: hidden` cannot save it, because overflow clips a
 * descendant only when its containing block is the clipping element or
 * something inside it. An escaped bar is not clipped, it is re-parented.
 *
 * Which is exactly what shipped. Both pages that host a widget outside the
 * 1920x1080 stage have to cancel the stage's absolute anchoring, and both did
 * it with `position: static !important` on `.widget` — the same class the panel
 * carries. On widget.html nothing positioned sat between the widget and the
 * viewport, so the bar took the INITIAL containing block and stretched itself
 * over the full height of the OBS Browser Source: a cyan-to-magenta line
 * running the whole screen, far past the top and bottom of a 71px chat panel.
 * Three of them were live on stream before anyone could name the cause.
 *
 * The in-game layer never showed it, which is what made it hard to find: there
 * `.ig-item` IS absolutely positioned, so the bar landed on a box that happened
 * to match the widget. Close enough to look right, still the wrong box — it
 * measured the wrapper's border box, so it painted over the panel's 1px border
 * and squared off its rounded corner.
 *
 * The fix in both stylesheets is `position: relative` instead of `static`. With
 * every offset left at `auto` the two lay out identically, so nothing moves;
 * the difference is only that the panel stays the containing block for its own
 * chrome. This file pins that, because the failure mode is invisible to a
 * typecheck, invisible in the browser at the window sizes a developer uses, and
 * only fully ugly at the size OBS runs the page at.
 *
 * Text assertions rather than a rendered page: there is no browser in the test
 * suite, and the contract is a property of the stylesheets themselves (same
 * bargain scripts/test-docking.js takes with electron/main.js).
 *
 * Run: node scripts/test-accent-containment.js
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

const themeCss = read('overlay', 'css', 'theme.css');
const singleCss = read('overlay', 'css', 'single.css');
const ingameCss = read('overlay', 'css', 'ingame.css');
const overlayCss = read('overlay', 'css', 'overlay.css');

/* -------------------------------------------------------------------------- */
/*  A very small rule reader                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every declaration block whose selector list matches `selector` exactly, with
 * comments stripped first so a rule quoted in prose cannot be mistaken for a
 * live one. Selectors are compared on collapsed whitespace, which is all the
 * normalising these stylesheets need.
 */
function rules(css, selector) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const want = selector.replace(/\s+/g, ' ').trim();
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(bare))) {
    const sel = m[1].replace(/\s+/g, ' ').trim();
    if (sel === want) out.push(m[2]);
  }
  return out;
}

/** The last declared value of `prop` in a block, `null` if it never appears. */
function decl(block, prop) {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g');
  let m;
  let last = null;
  while ((m = re.exec(block))) last = m[1].trim();
  return last;
}

/** Does this `position` value make the element a containing block for abspos? */
function positioned(value) {
  if (!value) return false;
  const v = value.replace(/!important/, '').trim();
  return v === 'relative' || v === 'absolute' || v === 'fixed' || v === 'sticky';
}

/* -------------------------------------------------------------------------- */
/*  1. The two halves of the accent bar still depend on each other            */
/* -------------------------------------------------------------------------- */

const panel = rules(themeCss, '.panel');
check('theme.css declares .panel', panel.length === 1, `${panel.length} rule(s)`);

const panelPos = panel.length ? decl(panel[0], 'position') : null;
check(
  '.panel is positioned — it is the accent bar\'s containing block',
  positioned(panelPos),
  `position: ${panelPos}`,
);

const bar = rules(themeCss, '.panel::before');
check('theme.css declares .panel::before', bar.length === 1, `${bar.length} rule(s)`);

const barPos = bar.length ? decl(bar[0], 'position') : null;
const barInset = bar.length ? decl(bar[0], 'inset') : null;
check(
  '.panel::before is absolutely positioned',
  (barPos || '').replace(/!important/, '').trim() === 'absolute',
  `position: ${barPos}`,
);
// Two zeros in `inset` = top and bottom both pinned = height comes entirely
// from the containing block. That is the property this whole file protects.
check(
  '.panel::before takes its height from its containing block',
  barInset !== null && /^0\s+\S+\s+0(\s|$)/.test(barInset),
  `inset: ${barInset}`,
);

/* -------------------------------------------------------------------------- */
/*  2. Neither host page un-positions the widget                              */
/* -------------------------------------------------------------------------- */

// The stage anchors widgets with `position: absolute` (overlay.css). A page
// that shows a widget OUTSIDE the stage has to cancel that, and the tell is a
// block that resets the offsets to `auto !important`. Any such block must pick
// a positioned value: `static` is what escaped the bar onto the stream.
const RESETTERS = [
  ['single.css', singleCss, '.single-page .widget'],
  ['ingame.css', ingameCss, '.ig-item .widget'],
];

for (const [file, css, sel] of RESETTERS) {
  const found = rules(css, sel);
  check(`${file} declares ${sel}`, found.length === 1, `${found.length} rule(s)`);
  if (!found.length) continue;

  const pos = decl(found[0], 'position');
  check(
    `${file}: ${sel} stays a containing block (not static)`,
    positioned(pos),
    `position: ${pos}`,
  );
  // The reset is only safe to leave `relative` because the offsets are auto —
  // a stray `top`/`left` here would move the widget rather than just anchor it.
  for (const side of ['top', 'left', 'right', 'bottom']) {
    const v = decl(found[0], side);
    check(
      `${file}: ${sel} neutralises ${side}`,
      v !== null && v.replace(/!important/, '').trim() === 'auto',
      `${side}: ${v}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  3. No stylesheet un-positions .widget or .panel by another route          */
/* -------------------------------------------------------------------------- */

// A future rule could reach the same element through a different selector.
// Rather than enumerate selectors, sweep every block that mentions the widget
// or panel class and reject `position: static` outright — nothing in this
// system has a legitimate reason to want it.
const SHEETS = [
  ['theme.css', themeCss],
  ['overlay.css', overlayCss],
  ['single.css', singleCss],
  ['ingame.css', ingameCss],
];

const offenders = [];
for (const [file, css] of SHEETS) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(bare))) {
    const sel = m[1].replace(/\s+/g, ' ').trim();
    if (!/\.widget\b|\.panel\b/.test(sel)) continue;
    const pos = decl(m[2], 'position');
    if (pos && pos.replace(/!important/, '').trim() === 'static') {
      offenders.push(`${file}: ${sel}`);
    }
  }
}
check(
  'no stylesheet sets position:static on a widget or panel',
  offenders.length === 0,
  offenders.length ? offenders.join(' | ') : 'none',
);

/* -------------------------------------------------------------------------- */
/*  4. The backstops                                                          */
/* -------------------------------------------------------------------------- */

// If some future absolutely-positioned child does escape its widget, these two
// bound it to the widget's own area instead of the whole Browser Source.
const mount = rules(singleCss, '.single-page');
check('single.css declares .single-page', mount.length === 1, `${mount.length} rule(s)`);
check(
  '.single-page is positioned — the escape backstop on the OBS pages',
  mount.length === 1 && positioned(decl(mount[0], 'position')),
  mount.length === 1 ? `position: ${decl(mount[0], 'position')}` : 'missing',
);

const igItem = rules(ingameCss, '.ig-item');
check('ingame.css declares .ig-item', igItem.length === 1, `${igItem.length} rule(s)`);
check(
  '.ig-item is positioned — the same backstop in the in-game layer',
  igItem.length === 1 && positioned(decl(igItem[0], 'position')),
  igItem.length === 1 ? `position: ${decl(igItem[0], 'position')}` : 'missing',
);

/* -------------------------------------------------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
