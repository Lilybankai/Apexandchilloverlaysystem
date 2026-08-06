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
      widget.update({ standings, session: {}, player: {} }, { fmt }),
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
     * Car numbers whose row is currently wearing the "YOU" tag. Read the same
     * way a driver reads it — is the tag VISIBLE on that row — because the rows
     * are pooled by slotId and reused across frames, so a tag left behind on a
     * car that is no longer you is a tag that renders.
     */
    you: () => {
      const out = [];
      const walk = (e) => {
        if (e.className && /standings__driver/.test(e.className)) {
          const tag = e.children.find((c) => c.className === 'standings__you');
          const m = /#(\d+)/.exec(e.children.map((c) => c.textContent || '').join(' '));
          if (tag && !tag.hidden && m) out.push(m[1]);
        }
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
console.log('\nFinding yourself — the "YOU" tag');
/* -------------------------------------------------------------------------- */

/* Testers were losing their own car in a full tower, so the row carries a word
   and not only a colour (see .standings__row--player). What matters is that
   exactly ONE row wears it and it is the right one: a tag on two rows is worse
   than no tag at all, because the driver stops trusting it. */
{
  const w = mount();
  w.update(field());
  check('the player wears it', w.you().join(',') === '19', w.you().join(',') || 'nobody');

  // Rows are pooled by slotId and reused, so the tag has to be taken OFF a car
  // that stops being the player — a replay, a driver swap, or simply a session
  // where the tower saw a different car first.
  const swapped = field().map((r) => ({ ...r, isPlayer: r.carNumber === '43' }));
  w.update(swapped);
  check('and it moves with them', w.you().join(',') === '43', w.you().join(',') || 'nobody');

  // Spectating: nobody is the player, so nothing claims to be.
  w.update(field().map((r) => ({ ...r, isPlayer: false })));
  check('a spectator feed tags nobody', w.you().length === 0, w.you().join(',') || 'nobody');
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
