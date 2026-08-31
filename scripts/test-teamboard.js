/**
 * test-teamboard.js — the pit-wall board's layout maths.
 * -----------------------------------------------------------------------------
 * team-dashboard.js decides where every widget on the Team page lands when one
 * is dragged, resized or switched on. The engine is the part with no DOM in
 * it, so it is the part worth testing: overlap, the downward push a drop
 * causes, the upward compaction that follows (the "no dead space" rule the old
 * tabs were breaking), and the search for a free slot when a widget comes back
 * on the board.
 *
 * The cases below are boards, not parameter sweeps — a drop onto an occupied
 * cell, a drop that cascades through two rows, a resize that has to shove a
 * neighbour, and a full preset that must survive a round trip unchanged.
 *
 * Run: npm run test:teamboard
 */

'use strict';

const path = require('path');
const DASH = require(path.join(__dirname, '..', 'electron', 'control-panel', 'team-dashboard.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const box = (id, x, y, w, h) => ({ id, x, y, w, h, on: true });
const at = (items, id) => items.find((i) => i.id === id);
/** Every pair on the board must be disjoint — the invariant behind all of it. */
const noOverlap = (items) => !items.some((a, i) => items.slice(i + 1).some((b) => DASH.hits(a, b)));

// ── Overlap is by area, and an item never collides with itself ────────────
{
  const a = box('a', 0, 0, 4, 4);
  check('overlapping boxes hit', DASH.hits(a, box('b', 2, 2, 4, 4)));
  check('touching edges do not hit', !DASH.hits(a, box('b', 4, 0, 4, 4)));
  check('stacked edges do not hit', !DASH.hits(a, box('b', 0, 4, 4, 4)));
  check('an item never hits itself', !DASH.hits(a, a));
}

// ── Compaction pulls everything up and leaves no hole ─────────────────────
{
  const items = [box('a', 0, 5, 6, 4), box('b', 6, 9, 6, 3)];
  DASH.compact(items);
  check('compact floats the top item to y=0', at(items, 'a').y === 0, `y=${at(items, 'a').y}`);
  check('compact floats a column-neighbour to y=0', at(items, 'b').y === 0, `y=${at(items, 'b').y}`);
  check('compact keeps columns', at(items, 'b').x === 6);
  check('compact leaves no overlap', noOverlap(items));
}

{
  // Stacked in the same column: compaction must preserve the ORDER, not
  // collapse them onto each other.
  const items = [box('top', 0, 3, 4, 3), box('mid', 0, 9, 4, 3), box('low', 0, 20, 4, 3)];
  DASH.compact(items);
  check('same-column stack keeps order', at(items, 'top').y === 0 && at(items, 'mid').y === 3 && at(items, 'low').y === 6,
    items.map((i) => `${i.id}@${i.y}`).join(' '));
  check('same-column stack stays disjoint', noOverlap(items));
}

// ── A drop onto an occupied cell pushes the occupant DOWN, then compacts ──
{
  const items = [box('a', 0, 0, 6, 4), box('b', 0, 4, 6, 4)];
  at(items, 'b').y = 0;              // dragged up onto a
  DASH.settle(items, 'b');
  check('the dropped widget keeps the cell it was dropped on', at(items, 'b').y === 0, `b.y=${at(items, 'b').y}`);
  check('the occupant is pushed below it', at(items, 'a').y === 4, `a.y=${at(items, 'a').y}`);
  check('a swap leaves no overlap', noOverlap(items));
}

{
  // A cascade: dropping onto `a` must move `a` onto `b`, which moves too.
  const items = [box('drop', 6, 0, 6, 3), box('a', 0, 0, 6, 3), box('b', 0, 3, 6, 3)];
  at(items, 'drop').x = 0;
  DASH.settle(items, 'drop');
  check('cascade: dropped item holds the top', at(items, 'drop').y === 0);
  check('cascade: first occupant moves down one box', at(items, 'a').y === 3, `a.y=${at(items, 'a').y}`);
  check('cascade: second occupant moves down too', at(items, 'b').y === 6, `b.y=${at(items, 'b').y}`);
  check('cascade leaves no overlap', noOverlap(items));
}

// ── Growing a widget shoves what it grows into ────────────────────────────
{
  const items = [box('big', 0, 0, 6, 4), box('below', 0, 4, 6, 4)];
  at(items, 'big').h = 8;            // dragged the corner down
  DASH.settle(items, 'big');
  check('a resize keeps the new height', at(items, 'big').h === 8);
  check('a resize pushes the neighbour clear', at(items, 'below').y === 8, `below.y=${at(items, 'below').y}`);
  check('a resize leaves no overlap', noOverlap(items));
}

{
  // Widening into a side-by-side neighbour: the loser goes DOWN, never
  // sideways — a board that reshuffles columns under the pointer is unusable.
  const items = [box('left', 0, 0, 6, 4), box('right', 6, 0, 6, 4)];
  at(items, 'left').w = 9;
  DASH.settle(items, 'left');
  check('a widen keeps the new width', at(items, 'left').w === 9);
  check('the side neighbour drops below', at(items, 'right').y === 4, `right.y=${at(items, 'right').y}`);
  check('the side neighbour keeps its column', at(items, 'right').x === 6);
  check('a widen leaves no overlap', noOverlap(items));
}

// ── Switching a widget back on finds the first hole big enough ────────────
{
  const items = [box('a', 0, 0, 8, 4)];
  const back = { id: 'back', x: 0, y: 0, w: 4, h: 4, on: true };
  DASH.placeFree(items, back);
  check('a returning widget fills the gap beside a wide card', back.x === 8 && back.y === 0,
    `back=${back.x},${back.y}`);
  check('a returning widget does not overlap', !DASH.hits(back, items[0]));
}

{
  // No room on the top row: it must go below, not on top of anything.
  const items = [box('a', 0, 0, 12, 4)];
  const back = { id: 'back', x: 0, y: 0, w: 5, h: 3, on: true };
  DASH.placeFree(items, back);
  check('a returning widget lands under a full row', back.y === 4, `back.y=${back.y}`);
  check('a returning widget under a full row does not overlap', !DASH.hits(back, items[0]));
}

// ── The shipped presets have to be legal boards ───────────────────────────
{
  // These mirror team-panel.js's PRESETS. A preset that overlaps or overruns
  // the 12 columns would be silently "fixed" by compaction into something
  // nobody designed, so it is checked here rather than discovered live.
  const PRESETS = {
    engineer: {
      timing: [0, 0, 7, 17], map: [7, 0, 5, 10], fuel: [7, 10, 5, 7],
      tyres: [0, 17, 4, 9], telemetry: [4, 17, 3, 9], strategy: [7, 17, 5, 9],
      positions: [0, 26, 7, 10], laptimes: [7, 26, 5, 10],
      weather: [0, 36, 7, 8], tyreplan: [7, 36, 5, 8],
    },
    strategy: {
      fuel: [0, 0, 4, 9], strategy: [4, 0, 4, 9], tyreplan: [8, 0, 4, 9],
      timing: [0, 9, 7, 17], tyres: [7, 9, 5, 9], weather: [7, 18, 5, 8],
      map: [0, 26, 6, 10], laptimes: [6, 26, 6, 10],
      telemetry: [0, 36, 4, 9], positions: [4, 36, 8, 9],
    },
    telemetry: {
      map: [0, 0, 6, 14], tyres: [6, 0, 4, 10], telemetry: [10, 0, 2, 10],
      weather: [6, 10, 6, 8], timing: [0, 14, 6, 11], fuel: [6, 18, 3, 7],
      strategy: [9, 18, 3, 7], tyreplan: [0, 25, 4, 10], laptimes: [4, 25, 8, 10],
      positions: [0, 35, 12, 9],
    },
  };
  const IDS = ['timing', 'map', 'fuel', 'strategy', 'tyreplan', 'tyres', 'telemetry', 'weather', 'positions', 'laptimes'];

  for (const [name, spec] of Object.entries(PRESETS)) {
    const items = Object.entries(spec).map(([id, [x, y, w, h]]) => box(id, x, y, w, h));
    check(`${name}: every widget is placed`, items.length === IDS.length, `${items.length}`);
    check(`${name}: every widget is known`, IDS.every((id) => spec[id]));
    check(`${name}: nothing overruns 12 columns`, items.every((i) => i.x >= 0 && i.x + i.w <= DASH.COLS),
      items.filter((i) => i.x + i.w > DASH.COLS).map((i) => i.id).join(','));
    check(`${name}: no two widgets overlap`, noOverlap(items),
      items.map((i) => i.id).join(','));

    // Compaction must be a no-op on a preset: if it moves anything, the
    // designed board is not the board the driver actually gets.
    const before = items.map((i) => `${i.id}@${i.x},${i.y}`).join(' ');
    DASH.compact(items);
    check(`${name}: compaction leaves it alone`, items.map((i) => `${i.id}@${i.x},${i.y}`).join(' ') === before,
      items.map((i) => `${i.id}@${i.x},${i.y}`).join(' '));
  }
}

// ── A settle never loses or duplicates a widget ───────────────────────────
{
  const items = [box('a', 0, 0, 4, 4), box('b', 4, 0, 4, 4), box('c', 8, 0, 4, 4), box('d', 0, 4, 12, 4)];
  at(items, 'd').y = 0;
  at(items, 'd').x = 0;
  DASH.settle(items, 'd');
  check('settle keeps the whole board', items.length === 4);
  check('settle keeps ids unique', new Set(items.map((i) => i.id)).size === 4);
  check('a full-width drop pushes all three down', ['a', 'b', 'c'].every((id) => at(items, id).y === 4),
    ['a', 'b', 'c'].map((id) => `${id}@${at(items, id).y}`).join(' '));
  check('a full-width drop leaves no overlap', noOverlap(items));
  check('settle drops its bookkeeping flag', items.every((i) => !('moved' in i)));
}

console.log(`\ntest-teamboard: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
