/**
 * test-teamnarrow.js — the pit wall on a small screen.
 * -----------------------------------------------------------------------------
 * The web pit wall is the desktop's Team tab served to whatever the driver's
 * crew happens to be holding, which in practice is a phone. Two things broke
 * there, and both are the kind that come back:
 *
 *   1. The timing sheet is fourteen columns wide — 767px of table. In a 340px
 *      widget the scroller cropped it, and what fell off the right was Gap,
 *      Int and vs Me: the three columns the page exists to show. The sheet now
 *      SHEDS columns as its box narrows (container queries in team-panel.css,
 *      keyed to `data-col` written by team-panel.js), so the fix lives in two
 *      files that can drift apart. This test is the thing that notices.
 *
 *   2. The Board menu hangs off the right edge of its button, and on a phone
 *      that button wraps to the middle of the strip, which put the whole menu
 *      off the LEFT of the screen. team-panel.js measures and pushes it back.
 *
 * Text-level checks, deliberately: there is no DOM here, and what has to stay
 * true is an agreement between a renderer and a stylesheet.
 *
 * Run: npm run test:teamnarrow
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PANEL = path.join(__dirname, '..', 'electron', 'control-panel');
const JS = fs.readFileSync(path.join(PANEL, 'team-panel.js'), 'utf8');
const CSS = fs.readFileSync(path.join(PANEL, 'team-panel.css'), 'utf8');
const WEBCSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'web.css'), 'utf8');

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Every `data-col="x"` in the sheet's <th>s / <td>s. */
function cols(tag) {
  const re = new RegExp(`<${tag}[^>]*data-col="([a-z0-9]+)"`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(JS))) out.push(m[1]);
  return out;
}

// ── The header and the row describe the same sheet ────────────────────────
{
  const th = cols('th');
  const td = cols('td');
  check('the sheet has its fourteen columns', th.length === 14, `${th.length} headings`);
  check('every heading has a cell under it', th.every((c) => td.includes(c)),
    th.filter((c) => !td.includes(c)).join(', '));
  check('every cell has a heading over it', td.every((c) => th.includes(c)),
    td.filter((c) => !th.includes(c)).join(', '));
  check('no column is named twice', new Set(th).size === th.length);
}

// ── What the stylesheet folds, and what it must never fold ────────────────
{
  const folded = new Set();
  const re = /\.team-t th\[data-col="([a-z0-9]+)"\]/g;
  let m;
  while ((m = re.exec(CSS))) folded.add(m[1]);
  const th = new Set(cols('th'));

  check('every folded column is a real one', [...folded].every((c) => th.has(c)),
    [...folded].filter((c) => !th.has(c)).join(', '));

  // The sheet is a pit wall's sheet: class position, car number, driver, the
  // last lap and the gap to the car it is chasing. Fold any of those and the
  // widget stops being worth opening on a phone.
  for (const keep of ['p', 'num', 'driver', 'last', 'gap']) {
    check(`the ${keep} column is never folded away`, !folded.has(keep));
  }
  // And the ones that pay for them.
  for (const drop of ['ovr', 'best', 'avg', 'tyre', 'stops', 've', 'pit', 'int']) {
    check(`the ${drop} column folds on a narrow board`, folded.has(drop));
  }
  check('a folded column takes its cells with it',
    [...folded].every((c) => CSS.includes(`.team-t td[data-col="${c}"]`)),
    [...folded].filter((c) => !CSS.includes(`.team-t td[data-col="${c}"]`)).join(', '));
}

// ── The footnote does not describe a column that has been folded away ─────
{
  check('the Avg 5 sentence is marked so it can go with the column',
    /data-note="avg"/.test(JS) && /\.team-note \[data-note="avg"\]/.test(CSS));
}

// ── The Board menu is put back inside the window when it opens ────────────
{
  check('there is a placement pass', /function placeBoardMenu\(/.test(JS));
  check('opening the menu runs it', /renderBoardMenu\(\);\s*[\r\n]+\s*placeBoardMenu\(\);/.test(JS));
  check('it measures against the window, not the button',
    /document\.documentElement/.test(JS.slice(JS.indexOf('function placeBoardMenu('),
      JS.indexOf('function setBoardMenu('))));
  check('and the panel can never be wider than the screen',
    /max-width: calc\(100vw - 20px\)/.test(CSS));
  check('a rotate re-places an open menu', /window\.addEventListener\('resize', placeBoardMenu\)/.test(JS));
}

// ── On a phone the PAGE scrolls, not a box inside it ──────────────────────
{
  // The desktop frame locks html/body to the window and scrolls one inner div.
  // In a browser that hides the bottom of the board under the URL bar, so the
  // web build unlocks it below the width where the board stacks anyway.
  const q = WEBCSS.slice(WEBCSS.indexOf('@media (max-width: 900px)'));
  check('the web build unlocks the frame on small screens',
    /html, body \{ height: auto; overflow: visible; \}/.test(q));
  check('and keeps the identity strip in reach', /position: sticky/.test(q));
}

console.log(`\ntest-teamnarrow: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
