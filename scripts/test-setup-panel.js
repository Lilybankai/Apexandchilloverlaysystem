/**
 * scripts/test-setup-panel.js — the Setups tab actually RENDERS, and its
 * controls do what they say.
 * -----------------------------------------------------------------------------
 * Same reason as test-engineer-panel.js: a panel file can pass every id and
 * text test and still die part-way through its first paint. This loads the
 * real setup-groups / -info / -macros / -tags / -guide / -editor scripts into
 * a node:vm context against a small fake DOM, hands the editor a garage state
 * projected from scripts/fixtures/garage-gt3.json, drives it through the
 * first paint on fake timers, and then presses things.
 *
 * Cases are meant to be added: `bootPanel(options)` (exported) returns a
 * booted panel — the fake DOM, the timer clock, every write the editor sent —
 * plus helpers to find rows and press buttons. Copy a block in main() and go.
 *
 * Run: npm run test:setup-panel   (needs `npm run build` for dist/)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { projectSetupState } = require('../dist/telemetry/setupState.js');

const PANEL_DIR = path.join(__dirname, '..', 'electron', 'control-panel');
const SCRIPTS = [
  'setup-groups.js',
  'setup-info.js',
  'setup-macros.js',
  'setup-tags.js',
  'setup-guide.js',
  'setup-editor.js',
];

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* ====================================================================== */
/*  Fake DOM                                                              */
/* ====================================================================== */

/**
 * Just enough of an element for the Setups tab: a real tree (so rows and
 * buttons can be found and pressed), attributes, classes, listeners, and the
 * handful of properties the editor reads back. Not a browser — no layout, no
 * range clamping, no CSS.
 */
class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.title = '';
    this.type = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.src = '';
    this.offsetWidth = 0;
    this._text = '';
    this._root = false; // page elements (looked up by id) count as connected
  }

  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => list().includes(c),
      add: (...cs) => (el.className = [...new Set([...list(), ...cs])].join(' ')),
      remove: (...cs) => (el.className = list().filter((x) => !cs.includes(x)).join(' ')),
      toggle: (c, force) => {
        const on = force === undefined ? !list().includes(c) : Boolean(force);
        if (on) el.classList.add(c);
        else el.classList.remove(c);
        return on;
      },
    };
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = String(v ?? '');
  }
  set innerHTML(v) {
    // Markup is only ever an icon here; keep one opaque child so firstChild works.
    this.textContent = '';
    if (v) this.appendChild(new FakeElement(this.ownerDocument, 'svg'));
  }
  get innerHTML() {
    return '';
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get childElementCount() {
    return this.children.length;
  }
  get options() {
    return this.children;
  }
  get isConnected() {
    for (let n = this; n; n = n.parentNode) if (n._root) return true;
    return false;
  }

  setAttribute(k, v) {
    this.attrs.set(k, String(v));
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...kids) {
    for (const k of kids) this.appendChild(typeof k === 'string' ? this.ownerDocument.createTextNode(k) : k);
  }
  replaceChildren(...kids) {
    this.textContent = '';
    this.append(...kids);
  }
  remove() {
    if (!this.parentNode) return;
    const sibs = this.parentNode.children;
    const i = sibs.indexOf(this);
    if (i >= 0) sibs.splice(i, 1);
    this.parentNode = null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners.get(type);
    if (l) this.listeners.set(type, l.filter((f) => f !== fn));
  }
  /** Fires `type` at this element (no bubbling). Returns whatever promises listeners made. */
  dispatch(type, init = {}) {
    const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...init };
    return (this.listeners.get(type) || []).map((fn) => fn(ev));
  }

  focus() {
    const prev = this.ownerDocument.activeElement;
    if (prev && prev !== this) prev.dispatch('blur');
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    this.dispatch('blur');
  }
  select() {}
  click() {
    this.dispatch('click', { detail: 1 });
  }

  /** Every descendant, depth first. */
  *walk() {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
  /** Tag, `.class`, `[attr]` / `[attr="v"]` and comma lists — the editor's own needs. */
  matches(sel) {
    return String(sel)
      .split(',')
      .some((one) => {
        const s = one.trim();
        const m = s.match(/^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)(?::not\(\[hidden\]\))?$/i);
        if (!m) return false;
        if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
        for (const c of m[2].split('.').filter(Boolean)) if (!this.classList.contains(c)) return false;
        for (const a of m[3].match(/\[[^\]]+\]/g) || []) {
          const [, k, v] = a.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/) || [];
          if (!k) return false;
          if (v === undefined ? !this.hasAttribute(k) : this.getAttribute(k) !== v) return false;
        }
        if (/:not\(\[hidden\]\)$/.test(s) && this.hidden) return false;
        return true;
      });
  }
  querySelector(sel) {
    for (const n of this.walk()) if (n.matches(sel)) return n;
    return null;
  }
  querySelectorAll(sel) {
    return [...this.walk()].filter((n) => n.matches(sel));
  }
}

function makeDocument() {
  const doc = {
    activeElement: null,
    visibilityState: 'visible',
    listeners: new Map(),
  };
  const byId = new Map();
  const view = new FakeElement(doc, 'section');
  view._root = true;
  view.setAttribute('data-view', 'setups');
  view.setAttribute('data-active', 'true'); // the editor self-starts onto it

  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.createElementNS = (_ns, tag) => new FakeElement(doc, tag);
  doc.createTextNode = (t) => {
    const n = new FakeElement(doc, '#text');
    n._text = String(t);
    return n;
  };
  doc.getElementById = (id) => doc.querySelector(`#${id}`);
  doc.querySelector = (sel) => {
    if (sel === '[data-view="setups"]') return view;
    const m = String(sel).match(/^#([\w-]+)$/);
    if (m) {
      // Every page id the panel asks for exists — the parity test owns the
      // contract with index.html; this test owns behaviour.
      if (!byId.has(m[1])) {
        const el = new FakeElement(doc, 'div');
        el.id = m[1];
        el._root = true;
        if (m[1] === 'setup-offline') el.appendChild(new FakeElement(doc, 'p'));
        if (m[1] === 'setup-canvas-wrap') el.appendChild(new FakeElement(doc, 'img'));
        byId.set(m[1], el);
      }
      return byId.get(m[1]);
    }
    for (const root of [view, ...byId.values()]) {
      if (root.matches(sel)) return root;
      const hit = root.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  };
  doc.querySelectorAll = (sel) => [view, ...byId.values()].flatMap((r) => r.querySelectorAll(sel));
  doc.addEventListener = (type, fn) => {
    if (!doc.listeners.has(type)) doc.listeners.set(type, []);
    doc.listeners.get(type).push(fn);
  };
  doc.removeEventListener = () => {};
  return { doc, byId, view };
}

/* ====================================================================== */
/*  Fake clock                                                            */
/* ====================================================================== */

/** setTimeout/clearTimeout on a manual clock; `advance(ms)` runs what falls due. */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map(); // id -> { at, fn, args }
  const flushMicrotasks = () => new Promise((r) => setImmediate(r));
  return {
    setTimeout(fn, ms = 0, ...args) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    now: () => now,
    pending: () => timers.size,
    /** Runs every timer due within `ms`, in time order, letting promises settle between. */
    async advance(ms = 0) {
      const until = now + ms;
      await flushMicrotasks();
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn(...next[1].args);
        for (let i = 0; i < 5; i++) await flushMicrotasks();
      }
      now = until;
      await flushMicrotasks();
    },
  };
}

/* ====================================================================== */
/*  Boot                                                                  */
/* ====================================================================== */

/** The GT3 garage, as setupState.ts projects it for the panel. */
function gt3State(mutate) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'garage-gt3.json'), 'utf8'));
  const state = projectSetupState(raw, 'Test GT3', 'GT3');
  state.vehId = '';
  state.trackName = 'Spa';
  state.trackFolder = 'Spa';
  if (mutate) mutate(state);
  return state;
}

/**
 * Loads the panel scripts into a fresh vm and runs it to its first paint.
 *
 * options:
 *   state        the garage state window.apex.setup.state() returns (default gt3State())
 *   setupApi     extra/overriding window.apex.setup methods
 *   storage      localStorage contents (the walkthrough is pre-marked seen)
 *   writeLatencyMs  how long a live write takes to come back (fake clock)
 *
 * Returns { ctx, doc, byId, clock, errors, writes, batches, state, page, rowsIn,
 *           rowByLabel, buttons, press, hold }.
 */
async function bootPanel(options = {}) {
  const state = options.state || gt3State();
  const { doc, byId } = makeDocument();
  const clock = makeClock();
  const errors = [];
  const writes = []; // [{ key, value }] — every live single-key write
  const batches = []; // [[{ key, value }]] — every Apply

  const current = new Map(state.settings.map((s) => [s.key, s]));
  const setupApi = {
    state: async () => state,
    write: async (key, value) => {
      writes.push({ key, value });
      // The sim's round trip, on the fake clock — 0 answers on the next tick.
      if (options.writeLatencyMs) await new Promise((r) => clock.setTimeout(r, options.writeLatencyMs));
      const s = current.get(key);
      if (!s) return { ok: false, error: 'no such key' };
      const next = { ...s, value, stringValue: `v${value}` };
      current.set(key, next);
      state.settings = state.settings.map((x) => (x.key === key ? next : x));
      return { ok: true, setting: next };
    },
    writeBatch: async (list) => {
      batches.push(list);
      return { ok: true, results: list.map((w) => ({ key: w.key, ok: true })), state };
    },
    carImage: async () => ({ ok: false }),
    ...(options.setupApi || {}),
  };

  const store = new Map(Object.entries({ 'apex.setup.guide.seen': '1', ...(options.storage || {}) }));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const ctx = vm.createContext({
    document: doc,
    localStorage,
    console,
    Promise,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Intl,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    navigator: { clipboard: { writeText: async () => {} } },
    location: {},
  });
  ctx.window = ctx; // the classic scripts hang their APIs off window
  ctx.addEventListener = () => {};
  ctx.apex = { setup: setupApi, feedback: { submit: async () => ({ ok: true }) } };

  const onRejection = (e) => errors.push(e);
  process.on('unhandledRejection', onRejection);
  for (const file of SCRIPTS) {
    try {
      vm.runInContext(fs.readFileSync(path.join(PANEL_DIR, file), 'utf8'), ctx, { filename: file });
    } catch (e) {
      errors.push(e);
    }
  }
  await clock.advance(0); // the self-started poll → applyState → first paint

  const rowsEl = byId.get('setup-rows');
  const page = {
    rows: () => (rowsEl ? rowsEl.querySelectorAll('.su-row') : []),
    macros: () => byId.get('setup-macro-list').querySelectorAll('.su-macro'),
    tabButton: (name) => byId.get('setup-tabs').children.find((b) => b.textContent === name),
    staged: () => byId.get('setup-staged'),
    stagedCount: () => byId.get('setup-staged-count').textContent,
  };

  /** The row whose label reads `label` (exact). */
  const rowByLabel = (label) =>
    page.rows().find((r) => {
      const l = r.querySelector('.su-row__label');
      return l && l.textContent === label;
    }) || null;
  /** The −/+ buttons inside an element, as { dec, inc, all }. */
  const buttons = (el) => {
    const all = el ? el.querySelectorAll('.su-step__btn') : [];
    return { dec: all.find((b) => b.textContent === '−'), inc: all.find((b) => b.textContent === '+'), all };
  };
  /** A real press: pointerdown then pointerup, the way a mouse does it. */
  const press = async (btn, times = 1) => {
    for (let i = 0; i < times; i++) {
      try {
        if (btn.disabled) continue; // a disabled button gets no events
        btn.focus();
        btn.dispatch('pointerdown', { button: 0 });
        btn.dispatch('pointerup', { button: 0 });
        btn.dispatch('click', { detail: 1 });
      } catch (e) {
        errors.push(e);
      }
      await clock.advance(0);
    }
  };
  /** Press and hold for `ms`, then release. */
  const hold = async (btn, ms) => {
    try {
      btn.focus();
      btn.dispatch('pointerdown', { button: 0 });
    } catch (e) {
      errors.push(e);
    }
    await clock.advance(ms);
    btn.dispatch('pointerup', { button: 0 });
    btn.dispatch('click', { detail: 1 });
    await clock.advance(0);
  };

  const done = () => process.off('unhandledRejection', onRejection);
  return { ctx, doc, byId, clock, errors, writes, batches, state, page, rowByLabel, buttons, press, hold, done };
}

/* ====================================================================== */
/*  Cases                                                                 */
/* ====================================================================== */

const errText = (errors) => errors.map((e) => String((e && e.stack) || e).split('\n').slice(0, 2).join(' ')).join(' | ') || 'clean';
const labelOf = (key) => {
  const info = require('../electron/control-panel/setup-info.js').infoFor(key.replace(/-W_(FL|FR|RL|RR)$/, ''));
  return info ? info.title : null;
};

async function main() {
  console.log('\nFirst paint (GT3 fixture)');
  {
    const p = await bootPanel();
    check('loads and paints without throwing', p.errors.length === 0, errText(p.errors));
    check('the editor is showing', p.byId.get('setup-body').hidden === false);
    check('the BASIC page drew rows', p.page.rows().length > 5, p.page.rows().length);

    const adjustable = p.page.rows().filter((r) => r.getAttribute('data-locked') === 'false');
    const locked = p.page.rows().filter((r) => r.getAttribute('data-locked') === 'true');
    check('every adjustable row has a − and a +', adjustable.length > 0 && adjustable.every((r) => p.buttons(r).all.length === 2), `${adjustable.length} rows`);
    check('no fixed row has a ± button', locked.length > 0 && locked.every((r) => p.buttons(r).all.length === 0), `${locked.length} rows`);

    const tcRow = p.rowByLabel(labelOf('VM_TRACTIONCONTROLMAP'));
    const tc = p.buttons(tcRow);
    check(
      'buttons say what they change',
      tc.dec && tc.dec.getAttribute('aria-label') === `Decrease ${labelOf('VM_TRACTIONCONTROLMAP')}` &&
        tc.inc.getAttribute('aria-label') === `Increase ${labelOf('VM_TRACTIONCONTROLMAP')}`,
      tc.dec && tc.dec.getAttribute('aria-label'),
    );

    const fuel = p.buttons(p.rowByLabel(labelOf('VM_FUEL_LEVEL')));
    check('a row at its max has + disabled and − live', fuel.inc && fuel.inc.disabled === true && fuel.dec.disabled === false);

    const macros = p.page.macros();
    check('every engineer slider has a − and a +', macros.length > 0 && macros.every((m) => p.buttons(m).all.length === 2), `${macros.length} macros`);
    check('engineer sliders start at 0, both buttons live', macros.every((m) => !p.buttons(m).dec.disabled && !p.buttons(m).inc.disabled));
    p.done();
  }

  console.log('\n± on a setting writes ONE step, through the debounce');
  {
    const p = await bootPanel();
    const key = 'VM_PITSTOP_1'; // 50 of 0..75: room to step both ways
    const before = p.state.settings.find((s) => s.key === key).value;
    const row = p.rowByLabel(labelOf(key));
    const range = row.querySelector('input');
    const { inc, dec } = p.buttons(row);

    await p.press(inc);
    check('the slider moves one step at once', Number(range.value) === before + 1, `${before} → ${range.value}`);
    check('the value cell paints optimistically', /step/.test(row.querySelector('.su-row__value').textContent), row.querySelector('.su-row__value').textContent);
    check('nothing is sent before the debounce', p.writes.length === 0);
    await p.clock.advance(250);
    check('…then one write of value + 1', p.writes.length === 1 && p.writes[0].key === key && p.writes[0].value === before + 1, JSON.stringify(p.writes));

    p.writes.length = 0;
    await p.press(inc, 3);
    await p.clock.advance(250);
    check('three quick presses coalesce into one write', p.writes.length === 1 && p.writes[0].value === before + 4, JSON.stringify(p.writes));

    p.writes.length = 0;
    await p.press(dec);
    await p.clock.advance(250);
    check('− writes value − 1', p.writes.length === 1 && p.writes[0].value === before + 3, JSON.stringify(p.writes));

    // Up to the bound: + stops there and disables.
    p.writes.length = 0;
    await p.press(inc, 40);
    await p.clock.advance(250);
    check('+ clamps at max and disables', Number(range.value) === Number(range.max) && inc.disabled === true, `${range.value}/${range.max}`);
    check('…and still only one write for the burst', p.writes.length === 1 && p.writes[0].value === Number(range.max), JSON.stringify(p.writes));
    check('nothing threw', p.errors.length === 0, errText(p.errors));
    p.done();
  }

  console.log('\nA press while a write is still in flight');
  {
    // The write for the first press comes back AFTER the second press: its
    // repaint must not snap the thumb back, or the second press's debounce
    // would then send the older value and the press would be lost.
    const p = await bootPanel({ writeLatencyMs: 100 });
    const key = 'VM_PITSTOP_1';
    const before = p.state.settings.find((s) => s.key === key).value;
    const row = p.rowByLabel(labelOf(key));
    const range = row.querySelector('input');
    const { inc } = p.buttons(row);
    await p.press(inc); // t=0: before + 1, debounce → 200
    await p.clock.advance(250); // t=250: write(before + 1) in flight until 300
    await p.press(inc); // before + 2, debounce → 450
    await p.clock.advance(400); // the first write lands at 300; the second goes at 450, lands at 550
    check(
      'both presses reach the sim',
      p.writes.length === 2 && p.writes[1].value === before + 2 && Number(range.value) === before + 2,
      `${JSON.stringify(p.writes)} thumb=${range.value}`,
    );
    check('nothing threw', p.errors.length === 0, errText(p.errors));
    p.done();
  }

  console.log('\nHold to repeat');
  {
    const p = await bootPanel();
    const key = 'VM_PITSTOP_1';
    const before = p.state.settings.find((s) => s.key === key).value;
    const row = p.rowByLabel(labelOf(key));
    const range = row.querySelector('input');
    const { dec } = p.buttons(row);
    await p.hold(dec, 400 + 125 * 3 + 50); // one press, then four repeats
    const moved = before - Number(range.value);
    check('holding repeats after a pause, modestly', moved === 5, `${moved} steps in 825 ms`);
    const at = Number(range.value);
    await p.clock.advance(2000);
    check('releasing stops it', Number(range.value) === at, `${at} → ${range.value}`);
    await p.clock.advance(250);
    // The first step's debounce runs out inside the 400 ms pause; the repeats
    // (125 ms apart) keep re-arming it, so the rest of the hold is one write.
    const holdWrites = p.writes.filter((w) => w.key === key);
    check(
      'a hold sends the first step, then one write at the end',
      holdWrites.length === 2 && holdWrites[1].value === at,
      JSON.stringify(holdWrites),
    );

    const { inc } = p.buttons(row);
    inc.focus();
    inc.dispatch('pointerdown', { button: 0 });
    await p.clock.advance(400 + 125);
    inc.dispatch('pointerleave');
    const left = Number(range.value);
    await p.clock.advance(1000);
    check('leaving the button stops it', Number(range.value) === left, `${left} → ${range.value}`);
    inc.dispatch('pointerdown', { button: 0 });
    await p.clock.advance(400 + 125);
    inc.dispatch('blur');
    const blurred = Number(range.value);
    await p.clock.advance(1000);
    check('losing focus stops it', Number(range.value) === blurred, `${blurred} → ${range.value}`);

    // Enter/Space on a focused button arrives as a click with detail 0.
    const k0 = Number(range.value);
    inc.dispatch('click', { detail: 0 });
    await p.clock.advance(0);
    check('a keyboard press steps once', Number(range.value) === k0 + 1, `${k0} → ${range.value}`);
    check('nothing threw', p.errors.length === 0, errText(p.errors));
    p.done();
  }

  console.log('\nCorner rows');
  {
    const p = await bootPanel();
    const tab = p.page.tabButton('WHEELS & BRAKES');
    tab.dispatch('click');
    await p.clock.advance(0);
    const cornerRows = p.page.rows().filter((r) => r.classList.contains('su-row--corners'));
    check('the WHEELS & BRAKES page has corner rows', cornerRows.length > 0, cornerRows.length);
    const cells = cornerRows.flatMap((r) => r.querySelectorAll('.su-corner'));
    const live = cells.filter((c) => c.querySelector('input'));
    check('every adjustable corner cell has its own − and +', live.length > 0 && live.every((c) => p.buttons(c).all.length === 2), `${live.length} cells`);
    check('fixed corner cells have none', cells.filter((c) => !c.querySelector('input')).every((c) => p.buttons(c).all.length === 0));

    const camber = cornerRows.find((r) => r.querySelector('.su-row__label').textContent === labelOf('WM_CAMBER'));
    const fl = camber && camber.querySelectorAll('.su-corner')[0];
    const flInc = fl && p.buttons(fl).inc;
    const flDec = fl && p.buttons(fl).dec;
    check('corner buttons name the corner', flInc && /front left/.test(flInc.getAttribute('aria-label')), flInc && flInc.getAttribute('aria-label'));
    // The fixture's front camber sits on its top step (index 11 of 0..11).
    check('a corner at its max has + disabled', flInc && flInc.disabled === true && flDec.disabled === false);
    const flBefore = p.state.settings.find((s) => s.key === 'WM_CAMBER-W_FL').value;
    await p.press(flDec);
    await p.clock.advance(250);
    check('− on one corner writes that corner only', p.writes.length === 1 && p.writes[0].key === 'WM_CAMBER-W_FL' && p.writes[0].value === flBefore - 1, JSON.stringify(p.writes));
    check('…and frees its +', flInc.disabled === false);
    check('nothing threw', p.errors.length === 0, errText(p.errors));
    p.done();
  }

  console.log('\nEngineer sliders: ± stages, never writes');
  {
    const p = await bootPanel();
    const turnIn = p.page.macros()[0];
    const { inc, dec } = p.buttons(turnIn);
    const clicks = turnIn.querySelector('.su-macro__clicks');
    await p.press(inc);
    check('+ moves the macro one click', clicks.textContent === '+1', clicks.textContent);
    check('…and stages changes', p.page.staged().getAttribute('data-ready') === 'true' && /staged/.test(p.page.stagedCount()), p.page.stagedCount());
    check('Apply arms', p.byId.get('setup-apply').disabled === false);
    await p.clock.advance(500);
    check('nothing was written live', p.writes.length === 0, JSON.stringify(p.writes));
    await p.press(dec);
    check('− back to 0 stages nothing', clicks.textContent === '0' && p.page.staged().getAttribute('data-ready') === 'false', `${clicks.textContent} / ${p.page.stagedCount()}`);
    await p.press(dec, 8);
    check('− clamps at the bottom and disables', clicks.textContent === '-5' && dec.disabled === true, clicks.textContent);
    p.byId.get('setup-revert').dispatch('click');
    await p.clock.advance(0);
    check('Revert re-enables the buttons at 0', clicks.textContent === '0' && dec.disabled === false && inc.disabled === false);
    check('nothing threw', p.errors.length === 0, errText(p.errors));
    p.done();
  }

  console.log('\nA staged corner keeps its row lit');
  {
    // Front turn-in moves the front camber only. Every corner's paint used to
    // write the shared row's data-staged, so RR (painted last, not staged)
    // switched the whole row off.
    const p = await bootPanel();
    p.page.tabButton('WHEELS & BRAKES').dispatch('click');
    await p.clock.advance(0);
    const frontTurnIn = p.page.macros().find((m) => m.querySelector('.su-macro__label').textContent === 'Front turn-in');
    await p.press(p.buttons(frontTurnIn).inc, 5);
    const camber = p.page.rows().find((r) => r.querySelector('.su-row__label') && r.querySelector('.su-row__label').textContent === labelOf('WM_CAMBER'));
    const cells = camber.querySelectorAll('.su-corner');
    const stagedCells = cells.filter((c) => c.getAttribute('data-staged') === 'true').length;
    check('only the front cells are staged', stagedCells === 2 && cells[0].getAttribute('data-staged') === 'true' && cells[3].getAttribute('data-staged') === 'false', `${stagedCells} of ${cells.length}`);
    check('the row is staged although RR (painted last) is not', camber.getAttribute('data-staged') === 'true');
    check('nothing threw', p.errors.length === 0, errText(p.errors));
    p.done();
  }

  console.log('\nRuleset-locked rows');
  {
    const p = await bootPanel({
      state: gt3State((s) => {
        for (const x of s.settings) if (x.key === 'VM_TRACTIONCONTROLMAP') x.isFree = false;
      }),
    });
    const row = p.rowByLabel(labelOf('VM_TRACTIONCONTROLMAP'));
    check('a ruleset-fixed row renders locked', row && row.getAttribute('data-locked') === 'true');
    check('…with no ± buttons', row && p.buttons(row).all.length === 0);
    check('nothing threw', p.errors.length === 0, errText(p.errors));
    p.done();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

module.exports = { bootPanel, gt3State, FakeElement, makeClock };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
