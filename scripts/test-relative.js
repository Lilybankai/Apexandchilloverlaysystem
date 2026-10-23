/**
 * scripts/test-relative.js — the relative panel's penalty badge.
 * -----------------------------------------------------------------------------
 * The cars either side of you on track are the ones you are racing, and "is the
 * car I am fighting about to drop out to serve a penalty?" is a question this
 * panel can now answer. The badge is the standings tower's — same text, same
 * rules, the same shared helper (client.js `penaltyBadge`, run here from the
 * real source) — so the pins are:
 *
 *   1. what each row says: DT / SG where the frame names the kind, PEN where it
 *      does not, ×N for more than one, nothing for a clear or retired car;
 *   2. it clears the frame the penalty is served;
 *   3. the off switch, from the app (appearance channel) and from an OBS URL
 *      (`?relative=pen=off`), and a pinned URL is deaf to the app;
 *   4. per-frame cost: a row whose badge did not change gets NO DOM write;
 *   5. the stylesheet: one badge rule for both tables, and the badge IMAGES
 *      collapse when `hidden` on the OBS pages (they drew as white boxes).
 *
 * The widget is a browser IIFE, evaluated against a DOM stub and driven
 * through its real `update()`, like scripts/test-standings.js.
 *
 * Run: node scripts/test-relative.js
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

/* ----------------------------- a small DOM stub ---------------------------- */

/** Every textContent write anywhere in the panel, for the per-frame cost check. */
let textWrites = 0;

function makeElement(tag) {
  let text = '';
  const el = {
    tagName: tag,
    className: '',
    innerHTML: '',
    hidden: false,
    title: '',
    children: [],
    attrs: {},
    parentNode: null,
    style: { setProperty() {}, removeProperty() {} },
    get textContent() {
      return text;
    },
    set textContent(v) {
      textWrites++;
      text = String(v);
    },
    appendChild(c) {
      if (c.parentNode) {
        const i = c.parentNode.children.indexOf(c);
        if (i >= 0) c.parentNode.children.splice(i, 1);
      }
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    get childNodes() {
      return this.children;
    },
    insertBefore(c, ref) {
      if (c.parentNode) {
        const i = c.parentNode.children.indexOf(c);
        if (i >= 0) c.parentNode.children.splice(i, 1);
      }
      c.parentNode = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx >= 0) this.children.splice(idx, 0, c);
      else this.children.push(c);
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
    toggled: new Set(),
    classList: {
      add(c) { el.toggled.add(c); },
      remove(c) { el.toggled.delete(c); },
      contains(c) { return el.toggled.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !el.toggled.has(c) : !!force;
        if (on) el.toggled.add(c); else el.toggled.delete(c);
        return on;
      },
    },
  };
  return el;
}

/* ------------------------ the shared runtime's pieces ---------------------- */

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'js', 'client.js'), 'utf8');
const BADGE = (() => {
  const a = CLIENT.indexOf('/* penalty-badge:begin');
  const b = CLIENT.indexOf('/* penalty-badge:end */');
  if (a < 0 || b < a) throw new Error('client.js lost its penalty-badge markers');
  return new Function(`${CLIENT.slice(a, b)}\nreturn { penaltyBadge, penaltyBadgeTitle };`)();
})();

const fmt = {
  UNKNOWN: -1,
  has: (v) => typeof v === 'number' && v > -1,
  intVal: (v) => (typeof v === 'number' ? String(Math.round(v)) : '—'),
  lapTime: (v) => (typeof v === 'number' && v > 0 ? v.toFixed(3) : '—'),
  delta: (v) => (typeof v === 'number' ? v.toFixed(2) : '—'),
  relGap: (v) => (typeof v === 'number' ? (v > 0 ? '+' : '') + v.toFixed(1) : '—'),
};

const SRC = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'js', 'widgets', 'relative.js'), 'utf8');

/** Mount the panel; `search` pins the view as an OBS source would. */
function mount(search) {
  let widget = null;
  let onRelative = null;
  const sandbox = {
    console,
    Date,
    Set,
    Map,
    Math,
    isFinite,
    URLSearchParams,
    document: {
      createElement: makeElement,
      createElementNS: (_ns, tag) => makeElement(tag),
    },
    window: {
      location: { search: search || '' },
      ApexOverlay: {
        registerWidget: (_id, w) => {
          widget = w;
        },
      },
      ApexAppearance: {
        onRelative: (cb) => {
          onRelative = cb;
        },
      },
    },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'relative.js' });
  if (!widget) throw new Error('relative.js registered no widget');
  const root = makeElement('div');
  const mountEl = makeElement('div');
  mountEl.setAttribute('data-role', 'mount');
  root.appendChild(mountEl);
  widget.init(root);

  const ctx = {
    fmt,
    critPulse: () => {},
    classAbbrev: (c) => String(c).slice(0, 3),
    classColor: () => '#fff',
    classLabel: (c) => String(c),
    driverBadgeLabel: (b) => b || '',
    applyRankBadge: () => {},
    penaltyBadge: BADGE.penaltyBadge,
    penaltyBadgeTitle: BADGE.penaltyBadgeTitle,
  };
  const all = (pred) => {
    const out = [];
    const walk = (e) => {
      if (pred(e)) out.push(e);
      for (const c of e.children) walk(c);
    };
    walk(root);
    return out;
  };
  return {
    push: (v) => onRelative && onRelative(v),
    update: (relative) =>
      widget.update({ relative, standings: relative, player: {}, session: {} }, ctx),
    /** slot → the badge as drawn ("" when hidden), in table order. */
    badges: () =>
      all((e) => e.className === 'relative__pen').map((b) => (b.hidden ? '' : b.textContent)),
    badgeEls: () => all((e) => e.className === 'relative__pen'),
  };
}

/** Five cars round the player (#3, slot 3). */
function field(over) {
  const rows = [1, 2, 3, 4, 5].map((slot) => ({
    slotId: slot,
    position: slot,
    driverName: `Driver ${slot}`,
    carNumber: String(slot * 10),
    carClass: 'GT3',
    relativeGapSec: (3 - slot) * 1.5,
    lapsDifference: 0,
    inPit: false,
    isPlayer: slot === 3,
  }));
  return rows.map((r) => (over && over[r.slotId] ? { ...r, ...over[r.slotId] } : r));
}

/* -------------------------------------------------------------------------- */
console.log('\nWhat each row says');
{
  const w = mount();
  w.update(field());
  check('a clean field draws no badge', w.badges().every((b) => b === ''), w.badges().join('|'));
  w.update(field({
    1: { penalties: 1 },
    2: { penalties: 1, penaltyKind: 'drive-through' },
    3: { penalties: 2, penaltyKind: 'stop-go' },
    4: { penalties: 3 },
  }));
  check('PEN / DT / SG×2 / PEN×3 / clear, in table order',
    w.badges().join('|') === 'PEN|DT|SG×2|PEN×3|', w.badges().join('|'));
  const els = w.badgeEls();
  check('the tooltip spells the kind out', els[1].title === 'Drive-through to serve', els[1].title);
  check('…and admits when it cannot', /does not say which kind/.test(els[0].title), els[0].title);
  check('the kind is on the element for the CSS', els[2].getAttribute('data-kind') === 'stop-go');

  w.update(field({ 2: { penalties: 0 }, 3: { penalties: 1, penaltyKind: 'stop-go' } }));
  check('served → cleared, one of two served → SG', w.badges().join('|') === '||SG||', w.badges().join('|'));

  w.update(field({ 1: { penalties: 1, retired: true }, 2: { penalties: -1 }, 4: { penalties: '2' } }));
  check('retired, negative and non-numeric counts draw nothing', w.badges().every((b) => b === ''), w.badges().join('|'));
}

/* -------------------------------------------------------------------------- */
console.log('\nPer-frame cost — no DOM write for a badge that did not change');
{
  const w = mount();
  const f = field({ 2: { penalties: 1, penaltyKind: 'stop-go' } });
  w.update(f);
  const els = w.badgeEls();
  // Count only the badge's own writes: everything else in the row is cached the
  // same way, so a steady frame should write nothing at all.
  textWrites = 0;
  for (let i = 0; i < 50; i++) w.update(f);
  check('fifty identical frames write no text anywhere', textWrites === 0, textWrites);
  check('the badge is still drawn', els[1].textContent === 'SG' && !els[1].hidden);
}

/* -------------------------------------------------------------------------- */
console.log('\nThe off switch');
{
  const w = mount();
  const f = field({ 2: { penalties: 1 } });
  w.update(f);
  check('on by default', w.badges()[1] === 'PEN');
  w.push({ pen: 'off' });
  w.update(f);
  check('the app turns it off', w.badges().every((b) => b === ''));
  w.push({ pen: 'on' });
  w.update(f);
  check('…and back on', w.badges()[1] === 'PEN');
}
{
  const w = mount('?relative=pen=off');
  const f = field({ 2: { penalties: 1 } });
  w.update(f);
  check('?relative=pen=off pins it off', w.badges().every((b) => b === ''));
  w.push({ pen: 'on' });
  w.update(f);
  check('a pinned source ignores the app', w.badges().every((b) => b === ''));
}

/* -------------------------------------------------------------------------- */
console.log('\nThe stylesheet');
{
  const css = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'css', 'overlay.css'), 'utf8');
  check('one badge rule for both tables', /\.standings__pen,\s*\.relative__pen\s*\{/.test(css));
  for (const cls of [
    'standings__badge', 'relative__badge', 'standings__srbadge',
    'relative__srbadge', 'standings__rank', 'relative__rank',
  ]) {
    check(`.${cls}[hidden] collapses on the OBS pages`, css.includes(`.${cls}[hidden]`));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
