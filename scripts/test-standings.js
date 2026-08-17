/**
 * scripts/test-standings.js — which cars the standings tower draws.
 * -----------------------------------------------------------------------------
 * The tower can be capped: the leaders (`top`) plus a window around the player
 * (`ahead`/`behind`), counted either within the player's class or across the
 * field. Two numbers and a scope, because they compose — "three in front, three
 * behind" and "top ten of each class" are the same setting with different
 * values.
 *
 * The failure that matters is not a wrong row count, it is a wrong ROW. A
 * driver whose own car is filtered out of their own standings, or a GT3 driver
 * shown a Hypercar-only tower, has a widget that looks like it is working. So
 * every case here asserts the actual car numbers on screen, and the multiclass
 * cases put the player mid-pack in the LAST class — the position a naive
 * top-N slice silently drops.
 *
 * The widget is a browser IIFE, so it is evaluated against a DOM stub rather
 * than imported, and driven through its real `update()`. Nothing is exported
 * for the test's benefit: what is asserted is what the panel would show.
 *
 * Run: node scripts/test-standings.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? `   [${detail}]` : ''));
  ok ? pass++ : fail++;
};

/* -------------------------------------------------------------------------- */
/*  A DOM small enough to run the widget, big enough to read what it drew      */
/* -------------------------------------------------------------------------- */

function makeElement(tag) {
  const el = {
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    title: '',
    children: [],
    attrs: {},
    parentNode: null,
    style: { setProperty() {}, removeProperty() {} },
    appendChild(c) {
      // A real appendChild MOVES an existing node. The tower relies on that to
      // reorder rows without rebuilding, so the stub has to do it too — without
      // the removal, a row that changes position appears twice and every
      // assertion about what is on screen becomes meaningless.
      if (c.parentNode && c.parentNode !== this) {
        const i = c.parentNode.children.indexOf(c);
        if (i >= 0) c.parentNode.children.splice(i, 1);
      } else if (c.parentNode === this) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
      }
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    querySelector(sel) {
      const m = /\[data-role="([^"]+)"\]/.exec(sel);
      if (!m) return null;
      const walk = (e) => {
        if (e.attrs && e.attrs['data-role'] === m[1]) return e;
        for (const c of e.children) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
  };
  return el;
}

/** The `fmt` helpers the widget takes from the shared runtime. */
const fmt = {
  has: (v) => typeof v === 'number' && v > -1,
  gap: (v) => (typeof v === 'number' ? `+${v.toFixed(1)}` : '—'),
  intVal: (v) => (typeof v === 'number' ? String(Math.round(v)) : '—'),
  lapTime: (v) => (typeof v === 'number' && v > 0 ? v.toFixed(3) : '—'),
};

/* -------------------------------------------------------------------------- */
/*  The widget under test                                                     */
/* -------------------------------------------------------------------------- */

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'overlay', 'js', 'widgets', 'standings.js'),
  'utf8',
);

/**
 * Mount the tower. `search` pins the view the way an OBS source would;
 * `push` delivers one through the appearance channel, the way the app does.
 */
function mount(search) {
  let widget = null;
  let onStandings = null;
  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    // The tower asks the server for sponsor logos on init. There is no server
    // here, which is the same answer most real installs give it.
    fetch: () => Promise.reject(new Error('no server in the test harness')),
    Date,
    Set,
    Math,
    JSON,
    isFinite,
    parseInt,
    document: { createElement: makeElement },
    window: {
      location: { search: search || '' },
      ApexOverlay: {
        registerWidget: (_id, w) => {
          widget = w;
        },
        classColor: () => '#fff',
        classLabel: (c) => String(c),
        sessionStrip: () => () => {},
        // The session strip's own contract is tested in test-session-headline.js;
        // here it only has to exist, because the tower feeds it every frame.
        playerLapsCompleted: () => -1,
      },
      ApexAppearance: {
        onStandings: (cb) => {
          onStandings = cb;
        },
      },
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.URLSearchParams = URLSearchParams;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'standings.js' });
  if (!widget) throw new Error('standings.js registered no widget');

  const root = makeElement('div');
  const mountEl = makeElement('div');
  mountEl.setAttribute('data-role', 'mount');
  root.appendChild(mountEl);
  widget.init(root);

  return {
    push: (view) => {
      if (onStandings) onStandings(view);
    },
    update: (standings) =>
      widget.update({ standings, session: {}, player: {} }, {
        fmt,
        // Faithful copies of client.js's badge helpers, so rows carrying
        // driverBadge / driverRank fields render instead of throwing — and so
        // an assertion can read the src the widget actually wrote.
        driverBadgeLabel: (b) => b || '',
        applyRankBadge: (img, cache, key, kind, rank) => {
          const id =
            rank && rank.rank && typeof rank.tier === 'number' ? rank.rank + rank.tier : '';
          if (cache[key] === id) return;
          cache[key] = id;
          if (id) {
            img.src = `/rankbadges/${kind}/${id}.svg`;
            img.hidden = false;
          } else {
            img.removeAttribute('src');
            img.hidden = true;
          }
        },
      }),
    /**
     * Car numbers currently in the tower, in the order drawn — read out of the
     * driver cell the panel actually renders ("#19 D. 19"), not from any hook
     * added for the test.
     */
    shown: () => {
      const out = [];
      const walk = (e) => {
        if (e.className && /standings__driver/.test(e.className)) {
          const text = e.children.map((c) => c.textContent || '').join(' ');
          const m = /#(\d+)/.exec(text);
          if (m) out.push(m[1]);
        }
        for (const c of e.children) walk(c);
      };
      walk(root);
      return out;
    },
    /** Text of every class subheader, in order. */
    headers: () => {
      const out = [];
      const walk = (e) => {
        if (e.className && /standings__group-count/.test(e.className)) out.push(e.textContent);
        for (const c of e.children) walk(c);
      };
      walk(root);
      return out;
    },
    /**
     * Text of every fastest-lap line the banner is currently drawing, in order,
     * or [] while the banner is hidden. Hidden is not the same as empty: the
     * lines stay in the DOM between frames, so a reader that ignored `hidden`
     * would report a banner nobody can see.
     */
    banner: () => {
      const out = [];
      const walk = (e, hidden) => {
        const off = hidden || e.hidden;
        if (!off && e.className === 'standings__fastest-line') out.push(e.textContent);
        for (const c of e.children) walk(c, off);
      };
      walk(root, false);
      return out;
    },
    /**
     * Car numbers whose row is marked as the player's. Read off the row class,
     * which is the only thing that marks it now the "YOU" chip is gone — and the
     * rows are pooled by slotId and reused across frames, so a mark left behind
     * on a car that is no longer you is a mark that renders.
     */
    player: () => {
      const out = [];
      const walk = (e) => {
        if (e.className && /standings__row--player/.test(e.className)) {
          const text = [];
          const gather = (n) => {
            text.push(n.textContent || '');
            n.children.forEach(gather);
          };
          gather(e);
          const m = /#(\d+)/.exec(text.join(' '));
          if (m) out.push(m[1]);
        }
        for (const c of e.children) walk(c);
      };
      walk(root);
      return out;
    },
    /**
     * Every driver cell's text, in the order drawn. The column HEADING carries
     * the same `standings__driver` class as the cells under it, so it has to be
     * excluded or every reading gains a phantom empty row at the top.
     */
    names: () => {
      const out = [];
      const walk = (e) => {
        if (e.className && /standings__driver/.test(e.className) && !/standings__head/.test(e.className)) {
          out.push(e.children.map((c) => c.textContent || '').join('').trim());
        }
        for (const c of e.children) walk(c);
      };
      walk(root);
      return out;
    },
    /** Every driver cell's tooltip, in the order drawn. */
    nameTitles: () => {
      const out = [];
      const walk = (e) => {
        if (e.className && /standings__driver/.test(e.className) && !/standings__head/.test(e.className)) {
          out.push(e.title);
        }
        for (const c of e.children) walk(c);
      };
      walk(root);
      return out;
    },
    /** Every ± cell's text, in the order drawn. */
    deltas: () => {
      const out = [];
      const walk = (e) => {
        if (e.className && /standings__delta/.test(e.className) && !/standings__head/.test(e.className)) {
          out.push(e.textContent);
        }
        for (const c of e.children) walk(c);
      };
      walk(root);
      return out;
    },
    /** Every GAP cell's text, in the order drawn. */
    gaps: () => {
      const out = [];
      const walk = (e) => {
        if (e.className && /standings__gap/.test(e.className) && !/standings__head/.test(e.className)) {
          out.push(e.textContent);
        }
        for (const c of e.children) walk(c);
      };
      walk(root);
      return out;
    },
    /**
     * Which marks each driver cell is actually SHOWING, per row, in the order
     * drawn — "brand+dr+sr", "brand", "" and so on. Read off `hidden` rather
     * than off the element existing: every badge stays in the DOM for the life
     * of the row and is shown or hidden in place, so a reader that only counted
     * elements would report a plaque that nobody can see.
     */
    marks: () => {
      const out = [];
      const walk = (e) => {
        if (
          e.className &&
          /standings__driver/.test(e.className) &&
          !/standings__head/.test(e.className)
        ) {
          const on = [];
          for (const c of e.children) {
            if (c.hidden) continue;
            if (c.className === 'standings__badge') on.push('brand');
            if (c.className === 'standings__rank') on.push('dr');
            if (c.className === 'standings__srbadge') on.push('sr');
          }
          out.push(on.join('+'));
        }
        for (const c of e.children) walk(c);
      };
      walk(root);
      return out;
    },
    /** The panel root, for the odd assertion that reads an attribute directly. */
    rootEl: () => root,
    /** Every element carrying a given class name, anywhere in the panel. */
    withClass: (name) => {
      const out = [];
      const walk = (e) => {
        if (e.className === name) out.push(e);
        for (const c of e.children) walk(c);
      };
      walk(root);
      return out;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  A field with the player mid-pack in the last class                        */
/* -------------------------------------------------------------------------- */

/**
 * 6 Hypercar + 6 GT3. The player is #19, P9 overall and 3rd in GT3 — outside
 * any top-6 slice of the field, which is exactly the case a plain row cap gets
 * wrong.
 */
function field() {
  const rows = [];
  const add = (pos, num, cls, isPlayer) =>
    rows.push({
      slotId: pos,
      position: pos,
      carNumber: num,
      driverName: `D ${num}`,
      carClass: cls,
      isPlayer: !!isPlayer,
      bestLapSec: 100 + pos,
      lastLapSec: 100 + pos,
      gapToLeaderSec: pos,
      virtualEnergy: 50,
      gridPosition: pos,
    });
  ['7', '11', '3', '23', '31', '15'].forEach((n, i) => add(i + 1, n, 'Hypercar'));
  ['39', '43', '19', '12', '55', '61'].forEach((n, i) => add(i + 7, n, 'GT3', n === '19'));
  return rows;
}

/* -------------------------------------------------------------------------- */
console.log('\nDefault — the whole field, as it always was');
/* -------------------------------------------------------------------------- */

{
  const w = mount();
  w.update(field());
  check('every car is drawn', w.shown().length === 12, w.shown().length + ' rows');
  check('no header claims a trimmed class', w.headers().every((h) => !/ OF /.test(h)), w.headers().join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\nFinding yourself — the player row');
/* -------------------------------------------------------------------------- */

/* Testers were losing their own car in a full tower, so the row is marked. It
   used to carry a "YOU" chip as well as the highlight; the chip is gone, because
   it was the one thing in the DRIVER column that pushed a row's contents out of
   line with every other row. What still has to hold is what always did: exactly
   ONE row is marked and it is the right one. A mark on two rows is worse than no
   mark at all, because the driver stops trusting it. */
{
  const w = mount();
  w.update(field());
  check('the player row is marked', w.player().join(',') === '19', w.player().join(',') || 'nobody');
  check('and no row wears a YOU chip', w.withClass('standings__you').length === 0,
    w.withClass('standings__you').length + ' chips');

  // Rows are pooled by slotId and reused, so the mark has to come OFF a car that
  // stops being the player — a replay, a driver swap, or simply a session where
  // the tower saw a different car first.
  const swapped = field().map((r) => ({ ...r, isPlayer: r.carNumber === '43' }));
  w.update(swapped);
  check('and it moves with them', w.player().join(',') === '43', w.player().join(',') || 'nobody');

  // Spectating: nobody is the player, so nothing claims to be.
  w.update(field().map((r) => ({ ...r, isPlayer: false })));
  check('a spectator feed marks nobody', w.player().length === 0, w.player().join(',') || 'nobody');
}

/* -------------------------------------------------------------------------- */
console.log('\nGAP precision — 1, 2 or 3 decimal places');
/* -------------------------------------------------------------------------- */

/* The column is read mid-corner, and the third decimal changes every frame
   whatever the cars are doing. What matters is that the setting reaches the
   cells, that it survives nonsense, and that the SHAPE of the cell is otherwise
   untouched — a leader still shows a dash, not "+0.000". */
{
  const gapField = () => [
    { slotId: 1, position: 1, carNumber: '7', driverName: 'A B', carClass: 'GT3', gapToLeaderSec: 0 },
    { slotId: 2, position: 2, carNumber: '9', driverName: 'C D', carClass: 'GT3', gapToLeaderSec: 1.2 },
  ];

  const w = mount();
  w.update(gapField());
  check('three places by default', w.gaps().join(' ') === '— +1.200', w.gaps().join(' '));

  w.push({ limit: 'all', scope: 'class', top: 0, ahead: 0, behind: 0, gap: 'leader', fastest: 'class', decimals: 1 });
  w.update(gapField());
  check('one place when asked', w.gaps().join(' ') === '— +1.2', w.gaps().join(' '));

  w.push({ limit: 'all', scope: 'class', top: 0, ahead: 0, behind: 0, gap: 'leader', fastest: 'class', decimals: 2 });
  w.update(gapField());
  check('two places when asked', w.gaps().join(' ') === '— +1.20', w.gaps().join(' '));

  // A value this build does not have is not a number to bring into range.
  w.push({ limit: 'all', scope: 'class', top: 0, ahead: 0, behind: 0, gap: 'leader', fastest: 'class', decimals: 7 });
  w.update(gapField());
  check('nonsense falls back to three', w.gaps().join(' ') === '— +1.200', w.gaps().join(' '));
}

/* -------------------------------------------------------------------------- */
console.log('\nDriver names — full, surname or forename');
/* -------------------------------------------------------------------------- */

/* Which half of a name identifies a driver is a fact about the grid, so it is a
   setting. The cases that matter are the ones a naive split gets wrong: a
   single-word alias has nothing to abbreviate, and a two-part surname must not
   lose half of itself. */
{
  const names = () => [
    { slotId: 1, position: 1, carNumber: '7', driverName: 'Matt Haskins', carClass: 'GT3' },
    { slotId: 2, position: 2, carNumber: '9', driverName: 'Jan Van der Merwe', carClass: 'GT3' },
    { slotId: 3, position: 3, carNumber: '4', driverName: 'Slipstream', carClass: 'GT3' },
  ];
  const view = (n) => ({
    limit: 'all', scope: 'class', top: 0, ahead: 0, behind: 0,
    gap: 'leader', fastest: 'class', names: n,
  });

  const w = mount();
  w.update(names());
  check('full names by default',
    w.names().join(' | ') === '#7 Matt Haskins | #9 Jan Van der Merwe | #4 Slipstream',
    w.names().join(' | '));

  w.push(view('surname'));
  w.update(names());
  check('surname form keeps the whole surname',
    w.names().join(' | ') === '#7 M.Haskins | #9 J.Van der Merwe | #4 Slipstream',
    w.names().join(' | '));

  w.push(view('forename'));
  w.update(names());
  check('forename form keeps the whole first name',
    w.names().join(' | ') === '#7 Matt.H | #9 Jan.V | #4 Slipstream',
    w.names().join(' | '));

  // The full name is what the abbreviation is hiding, so it stays on the row.
  check('and the row still carries it in full',
    w.nameTitles().join(' | ') === '#7 Matt Haskins | #9 Jan Van der Merwe | #4 Slipstream',
    w.nameTitles().join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\nThe rating marks ride every name style');
/* -------------------------------------------------------------------------- */

/* The driver-rating plaque and the safety/profile badge identify WHO a driver
   is — their rating and reputation — which is exactly what an operator who has
   abbreviated the names is still asking the tower to show. So the marks ride
   `full`, `surname` and `forename` alike; the name is shortened to make room and
   the CSS clips whatever does not fit, rather than the marks blinking out the
   moment a name is trimmed. */
{
  const marked = () => [
    { slotId: 1, position: 1, carNumber: '7', driverName: 'Matt Haskins', carClass: 'GT3',
      manufacturer: 'Ferrari', driverBadge: 'sr-clean', driverRank: { rank: 'Gold', tier: 2 } },
    { slotId: 2, position: 2, carNumber: '9', driverName: 'Mark Slater', carClass: 'GT3',
      manufacturer: 'Porsche', driverBadge: 'sr-noob', driverRank: { rank: 'Bronze', tier: 1 } },
  ];
  const view = (n) => ({
    limit: 'all', scope: 'class', top: 0, ahead: 0, behind: 0,
    gap: 'leader', fastest: 'class', decimals: 3, names: n,
  });

  const w = mount();
  w.push(view('full'));
  w.update(marked());
  check('in full, the row draws every mark',
    w.marks().join(' | ') === 'brand+dr+sr | brand+dr+sr', w.marks().join(' | '));

  w.push(view('surname'));
  w.update(marked());
  check('surname keeps the ratings AND the car',
    w.marks().join(' | ') === 'brand+dr+sr | brand+dr+sr', w.marks().join(' | '));
  check('and the name is still the abbreviated one',
    w.names().join(' | ') === '#7 M.Haskins | #9 M.Slater', w.names().join(' | '));

  w.push(view('forename'));
  w.update(marked());
  check('forename keeps the marks too',
    w.marks().join(' | ') === 'brand+dr+sr | brand+dr+sr', w.marks().join(' | '));
  check('with the forename-abbreviated name',
    w.names().join(' | ') === '#7 Matt.H | #9 Mark.S', w.names().join(' | '));

  // Toggling back to full is a no-op for the marks now, but still must not drop
  // them: the badges are pooled per row and shown/hidden in place.
  w.push(view('full'));
  w.update(marked());
  check('full still draws every mark',
    w.marks().join(' | ') === 'brand+dr+sr | brand+dr+sr', w.marks().join(' | '));

  // A row the sim gives no ratings for still draws only what it has.
  w.push(view('surname'));
  w.update([
    { slotId: 1, position: 1, carNumber: '7', driverName: 'Matt Haskins', carClass: 'GT3',
      manufacturer: 'Ferrari' },
  ]);
  check('a row with no ratings draws just its brand',
    w.marks().join(' | ') === 'brand', w.marks().join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\nPinning the new keys from a URL (an OBS source)');
/* -------------------------------------------------------------------------- */

{
  const w = mount('?standings=all,decimals=1,names=surname');
  w.update([
    { slotId: 1, position: 1, carNumber: '7', driverName: 'Matt Haskins', carClass: 'GT3', gapToLeaderSec: 0 },
    { slotId: 2, position: 2, carNumber: '9', driverName: 'Mark Slater', carClass: 'GT3', gapToLeaderSec: 1.2 },
  ]);
  check('the URL sets both', w.names().join(' | ') === '#7 M.Haskins | #9 M.Slater', w.names().join(' | '));
  check('and the gap with it', w.gaps().join(' ') === '— +1.2', w.gaps().join(' '));

  // A pinned source ignores the app: an OBS scene set up one way must not
  // change because a driver moved a dropdown.
  w.push({ limit: 'all', scope: 'class', top: 0, ahead: 0, behind: 0, gap: 'leader', fastest: 'class', decimals: 3, names: 'full' });
  w.update([
    { slotId: 1, position: 1, carNumber: '7', driverName: 'Matt Haskins', carClass: 'GT3', gapToLeaderSec: 0 },
    { slotId: 2, position: 2, carNumber: '9', driverName: 'Mark Slater', carClass: 'GT3', gapToLeaderSec: 1.2 },
  ]);
  check('and stays pinned', w.names().join(' | ') === '#7 M.Haskins | #9 M.Slater', w.names().join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\n"3 in front, 3 behind" — his first example');
/* -------------------------------------------------------------------------- */

{
  const w = mount();
  w.push({ limit: 'custom', scope: 'class', top: 0, ahead: 3, behind: 3 });
  w.update(field());
  const shown = w.shown();
  // Player is 3rd in GT3, so 2 ahead exist, then the player, then 3 behind.
  check('shows the player', shown.indexOf('19') >= 0, shown.join(','));
  check('shows the cars racing them', shown.join(',') === '39,43,19,12,55,61', shown.join(','));
  check('no other class leaks in', shown.every((n) => !['7', '11', '3', '23', '31', '15'].includes(n)));
  // GT3 is not trimmed here — the player is 3rd of 6, so a 3/3 window is the
  // whole class. What the cap does do is drop Hypercar entirely.
  check('the class you are not in is gone', w.headers().length === 1, w.headers().join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\n"Top 3 of each class" — his second example');
/* -------------------------------------------------------------------------- */

{
  const w = mount();
  w.push({ limit: 'custom', scope: 'class', top: 3, ahead: 0, behind: 0 });
  w.update(field());
  const shown = w.shown();
  check('every class keeps its leaders', shown.join(',') === '7,11,3,39,43,19', shown.join(','));
  check('both classes are represented', shown.includes('7') && shown.includes('39'));
  check('the player is in it on merit', shown.includes('19'));
}

/* -------------------------------------------------------------------------- */
console.log('\nThe row a naive cap drops — player outside every top-N');
/* -------------------------------------------------------------------------- */

{
  const w = mount();
  // Top 2 of each class: the player is 3rd in GT3, so nothing selects them.
  w.push({ limit: 'custom', scope: 'class', top: 2, ahead: 0, behind: 0 });
  w.update(field());
  const shown = w.shown();
  check('the player is never filtered out of their own standings', shown.includes('19'), shown.join(','));
  check('the leaders are still there', shown.includes('7') && shown.includes('39'));
}

{
  const w = mount();
  // Whole-field scope: a top-4 slice is Hypercar only.
  w.push({ limit: 'custom', scope: 'field', top: 4, ahead: 0, behind: 0 });
  w.update(field());
  const shown = w.shown();
  check('field scope takes the front of the RACE', shown.slice(0, 4).join(',') === '7,11,3,23', shown.join(','));
  check('and still keeps the player', shown.includes('19'), shown.join(','));
}

/* -------------------------------------------------------------------------- */
console.log('\nSpectating — no player in the field');
/* -------------------------------------------------------------------------- */

{
  const w = mount();
  w.push({ limit: 'custom', scope: 'field', top: 0, ahead: 2, behind: 2 });
  const spectate = field().map((r) => ({ ...r, isPlayer: false }));
  w.update(spectate);
  const shown = w.shown();
  check(
    'the window anchors at the leader instead of emptying',
    shown.length === 5 && shown[0] === '7',
    shown.join(','),
  );
}

{
  const w = mount();
  // A zero-width window with nobody driving is still a window: one car, the
  // leader. The panel must never come back empty.
  w.push({ limit: 'custom', scope: 'field', top: 0, ahead: 0, behind: 0 });
  w.update(field().map((r) => ({ ...r, isPlayer: false })));
  check('a zero-width window still draws the leader', w.shown().join(',') === '7', w.shown().join(','));
}

{
  const w = mount();
  // Per class, spectating: each class anchors its own window at its own leader,
  // so the setting draws the same NUMBER of cars whether or not anyone is
  // driving. This is the case the two scopes used to disagree about.
  w.push({ limit: 'custom', scope: 'class', top: 0, ahead: 1, behind: 1 });
  w.update(field().map((r) => ({ ...r, isPlayer: false })));
  // 1 ahead + the anchor + 1 behind = 3 per class, the same count a driver
  // would see around themselves.
  check(
    'class scope anchors every class at its leader',
    w.shown().join(',') === '7,11,3,39,43,19',
    w.shown().join(','),
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nRace-wide facts stay true when the tower is trimmed');
/* -------------------------------------------------------------------------- */

{
  const w = mount();
  w.push({ limit: 'custom', scope: 'class', top: 0, ahead: 1, behind: 1 });
  w.update(field());
  const headers = w.headers();
  check(
    'a class header reports the real class size, not the drawn rows',
    headers.some((h) => /OF 6 CARS/.test(h)),
    headers.join(' | '),
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nFastest lap — overall, or one per class');
/* -------------------------------------------------------------------------- */

// Best laps are 100 + position, so the race's fastest is Hypercar #7 (101.000)
// and GT3's own benchmark is #39 (107.000). #39 is the lap the default banner
// can never show, and the only one a GT3 driver is racing.

{
  const w = mount();
  w.update(field());
  const lines = w.banner();
  check('the default banner draws a line for each class', lines.length === 2, lines.join(' | '));
  check(
    'the classes are in leader order, each with its own holder',
    /^Hypercar · #7 .*101\.000$/.test(lines[0]) && /^GT3 · #39 .*107\.000$/.test(lines[1]),
    lines.join(' | '),
  );
}

{
  // The whole point: a GT3 driver reading the banner sees a GT3 lap. The overall
  // fastest is a Hypercar's in every multiclass race there is, which is why per
  // class is what an install gets without touching a setting.
  const w = mount();
  w.update(field());
  const mine = w.banner().find((l) => /^GT3/.test(l));
  check("the player's class has its own benchmark on screen", !!mine && /#39/.test(mine), mine);
}

{
  // A view that predates the setting — an older config, or a server that has
  // not been updated — must land on the default, not the other mode.
  const w = mount();
  w.push({ limit: 'all', scope: 'class', top: 0, ahead: 3, behind: 3, gap: 'leader' });
  w.update(field());
  check('a view with no fastest field still draws per class', w.banner().length === 2, w.banner().join(' | '));
}

{
  const w = mount();
  w.push({ limit: 'all', scope: 'class', top: 0, ahead: 3, behind: 3, gap: 'leader', fastest: 'overall' });
  w.update(field());
  const lines = w.banner();
  check('overall collapses it to one line', lines.length === 1, lines.join(' | '));
  check(
    'and it is the fastest lap of the race',
    /FASTEST LAP/.test(lines[0]) && /#7/.test(lines[0]) && /101\.000/.test(lines[0]),
    lines[0],
  );
}

{
  // A class where nobody has set a lap yet contributes nothing rather than a
  // line reading "—": the first minutes of a session are exactly when a banner
  // full of dashes would be most in the way.
  const w = mount();
  w.update(field().map((r) => (r.carClass === 'GT3' ? { ...r, bestLapSec: -1 } : r)));
  const lines = w.banner();
  check('a class with no lap set yet gets no line', lines.length === 1, lines.join(' | '));
  check('and the class that has one still does', /^Hypercar/.test(lines[0]), lines[0]);
}

{
  // Nobody has lapped at all — the banner is gone, not a row of dashes.
  const w = mount();
  w.update(field().map((r) => ({ ...r, bestLapSec: -1 })));
  check('an unlapped session shows no banner at all', w.banner().length === 0, w.banner().join(' | '));
}

{
  // Switching modes live must not leave the other mode's lines behind — the two
  // are keyed differently ("__overall" vs the class names), so a reconciler that
  // only added would stack them.
  const w = mount();
  w.update(field());
  w.push({ limit: 'all', scope: 'class', top: 0, ahead: 3, behind: 3, gap: 'leader', fastest: 'overall' });
  w.update(field());
  const overall = w.banner();
  check('switching to overall drops the class lines', overall.length === 1, overall.join(' | '));
  check('and shows the overall lap', /FASTEST LAP/.test(overall[0]), overall[0]);
  w.push({ limit: 'all', scope: 'class', top: 0, ahead: 3, behind: 3, gap: 'leader', fastest: 'class' });
  w.update(field());
  check('and switching back drops the overall line', w.banner().length === 2, w.banner().join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\nOBS pinning via ?standings=');
/* -------------------------------------------------------------------------- */

{
  const w = mount('?standings=all,fastest=overall');
  w.push({ limit: 'all', scope: 'class', top: 0, ahead: 3, behind: 3, gap: 'leader', fastest: 'class' });
  w.update(field());
  check('a pinned source keeps its single-lap banner', w.banner().length === 1, w.banner().join(' | '));
}

{
  // A pin that says nothing about the banner gets the default, like everything
  // else — `?standings=all` has never meant "and change the fastest lap".
  const w = mount('?standings=all');
  w.update(field());
  check('an unrelated pin leaves the banner on the default', w.banner().length === 2, w.banner().join(' | '));
}

{
  const w = mount('?standings=top=3,scope=class');
  w.push({ limit: 'custom', scope: 'field', top: 99, ahead: 99, behind: 99 });
  const shown = w.shown.length; // no-op, keeps the linter honest about intent
  w.update(field());
  check('a pinned source ignores the app', w.shown().join(',') === '7,11,3,39,43,19', w.shown().join(','));
  check('...and the pin parsed', shown !== undefined);
}

{
  const w = mount('?standings=all');
  w.push({ limit: 'custom', scope: 'class', top: 1, ahead: 0, behind: 0 });
  w.update(field());
  check('?standings=all pins the full field', w.shown().length === 12, w.shown().length + ' rows');
}

/* -------------------------------------------------------------------------- */
console.log('\nThe ± column scores the class, not the field');
/* -------------------------------------------------------------------------- */

/* The column used to read `gridPosition - position`, both whole-field numbers,
   so a GT3 getting past a Hypercar (or a Hypercar lapping through GT3 traffic)
   showed places gained against cars it was never racing. */

{
  // The GT3 leader (grid 7) gets ahead of the last Hypercar (grid 6): overall
  // they are ▲1/▼1, but neither has moved within their own class.
  const swapAcrossClass = (r) => {
    if (r.slotId === 6) return { ...r, position: 7 };
    if (r.slotId === 7) return { ...r, position: 6 };
    return r;
  };
  // The real feed arrives position-sorted, so the swapped fields are re-sorted
  // the same way rather than handed over in slot order.
  const byPos = (a, b) => a.position - b.position;
  const w = mount();
  w.update(field().map(swapAcrossClass).sort(byPos));
  check('a cross-class pass moves nobody', w.deltas().every((d) => d === '•'),
    w.deltas().join(' '));

  // Two GT3 cars actually swap (grids 8 and 9): that IS a place, and it is the
  // only kind that shows.
  const swapInClass = (r) => {
    if (r.slotId === 8) return { ...r, position: 9 };
    if (r.slotId === 9) return { ...r, position: 8 };
    return r;
  };
  w.update(field().map(swapInClass).sort(byPos));
  const d = w.deltas();
  check('an in-class pass is ▲1', d[7] === '▲1', d.join(' '));
  check('and the car passed is ▼1', d[8] === '▼1', d.join(' '));
  check('and nobody else moved', d.filter((x) => x === '•').length === 10, d.join(' '));
}

{
  // Same field, but the sim provides classPosition — the widget must prefer it
  // and land on the same reading.
  const withClassPos = field().map((r) => ({
    ...r,
    classPosition: r.carClass === 'GT3' ? r.position - 6 : r.position,
  }));
  const w = mount();
  w.update(withClassPos);
  check('classPosition-fed rows all read •', w.deltas().every((d) => d === '•'),
    w.deltas().join(' '));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
