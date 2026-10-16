/**
 * scripts/test-setup-history-panel.js — the Setups tab's History RENDERS.
 * -----------------------------------------------------------------------------
 * Boots the real setup-editor.js (with the real groups / info / macros / tags /
 * history-core files) in node:vm against a small fake DOM and a stub
 * window.apex.setup built from the live GT3 capture, then drives the History
 * sub-tab the way a driver would:
 *
 *   - the History tab button exists beside the six garage pages
 *   - opening it lists the versions, grouped by day, in the sim's wording
 *   - "Restore this version" STAGES the diff from the live car — locked and
 *     missing keys skipped and named — and calls neither setup.write nor
 *     setup.writeBatch until Apply, which then carries source 'restore'
 *   - "Compare with now" draws the diff without staging anything
 *   - with the sim shut, the offline card's button opens a readable History
 *     whose Restore is disabled with a reason
 *   - an empty history explains itself
 *
 * Self-contained on purpose (the nudge branch adds scripts/test-setup-panel.js
 * in parallel); any throw inside the panel fails the run.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { projectSetupState } = require('../dist/telemetry/setupState.js');
const core = require('../electron/control-panel/setup-history-core.js');

const PANEL = path.join(__dirname, '..', 'electron', 'control-panel');
const GARAGE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'garage-gt3.json'), 'utf8'));
const KEY = 'Ferrari 296 LMGT3|Spa';

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  ok ? pass++ : fail++;
};

/* ---- a fake DOM: just enough of it, and honest about text ---------------- */

class Node {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.className = '';
    this.title = '';
    this.offsetWidth = 100;
    const self = this;
    this.classList = {
      add: (...c) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
      remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => self.className.split(/\s+/).includes(c),
      toggle: (c, on) => { const has = self.classList.contains(c); const want = on === undefined ? !has : on; want ? self.classList.add(c) : self.classList.remove(c); return want; },
    };
  }
  get firstChild() { return this.children[0] || null; }
  get childElementCount() { return this.children.filter((c) => c.tagName !== '#TEXT').length; }
  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v) {
    this.children.forEach((c) => (c.parentNode = null));
    this.children = [];
    const s = String(v ?? '');
    if (s) this.appendChild(textNode(s));
  }
  get innerText() { return this.textContent; }
  set innerHTML(html) {
    this.textContent = '';
    const h = String(html || '');
    const use = /<use href="([^"]+)"/.exec(h);
    if (/<svg/.test(h)) {
      const svg = new Node('svg', this.ownerDocument);
      const cls = /<svg class="([^"]*)"/.exec(h);
      if (cls) svg.setAttribute('class', cls[1]);
      if (use) {
        const u = new Node('use', this.ownerDocument);
        u.setAttribute('href', use[1]);
        svg.appendChild(u);
      }
      this.appendChild(svg);
    } else if (h) {
      this.appendChild(textNode(h.replace(/<[^>]+>/g, '')));
    }
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...kids) { for (const k of kids) this.appendChild(typeof k === 'string' ? textNode(k) : k); }
  prepend(...kids) {
    for (const k of kids.reverse()) {
      const n = typeof k === 'string' ? textNode(k) : k;
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.children.unshift(n);
    }
  }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, n);
    return n;
  }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...kids) { this.textContent = ''; this.append(...kids); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return k === 'class' ? this.className : this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener() {}
  dispatch(type, extra) {
    const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, key: '', ...extra };
    for (const fn of this.listeners.get(type) || []) fn(ev);
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() {}
  blur() {}
  select() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20, right: 100, bottom: 20 }; }
  closest() { return null; }
  matches(sel) { return matches(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return all(this, (n) => matches(n, sel)); }
}

function textNode(s) {
  const t = new Node('#text', null);
  Object.defineProperty(t, 'textContent', { get: () => s, set: (v) => (s = String(v)) });
  return t;
}

/** Simple selectors only: `tag`, `.a.b`, `tag.a`, `[attr="v"]`. */
function matches(n, sel) {
  if (n.tagName === '#TEXT') return false;
  const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
  if (attr) return n.getAttribute(attr[1]) === attr[2];
  const m = /^([a-z0-9]*)((?:\.[\w-]+)*)$/i.exec(sel);
  if (!m) return false;
  if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
  const classes = m[2].split('.').filter(Boolean);
  return classes.every((c) => n.classList.contains(c));
}

function all(root, pred) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (pred(c)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

const byClass = (root, cls) => all(root, (n) => n.classList && n.classList.contains(cls));
const buttonNamed = (root, text) => all(root, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === text);

/* ---- boot ----------------------------------------------------------------- */

function liveState() {
  const raw = JSON.parse(JSON.stringify(GARAGE));
  raw.VM_FRONT_ANTISWAY.isFreeSetting = false; // locked by the ruleset in this session
  const s = projectSetupState(raw, 'Ferrari 296 LMGT3', 'GT3');
  return {
    ...s,
    carModel: 'Ferrari 296 LMGT3',
    trackFolder: 'Spa',
    trackName: 'Circuit de Spa-Francorchamps',
    session: 'PRACTICE1',
    vehId: '',
    historyKey: KEY,
  };
}

/** Two versions: the baseline (earlier) and an engineer Apply (newest, on the car). */
function historyFixture() {
  const now = Date.now();
  const snap = core.snapshotFromGarage(GARAGE);
  const baseline = core.cloneSnapshot(snap);
  baseline.values.VM_REAR_WING = 2;
  baseline.strings.VM_REAR_WING = 'P3';
  baseline.values.VM_FRONT_ANTISWAY = 3; // locked on the live car → skipped
  baseline.strings.VM_FRONT_ANTISWAY = 'D30 S-S';
  baseline.values.VM_MADE_UP_KEY = 1; // not on this car → skipped
  baseline.strings.VM_MADE_UP_KEY = 'On';
  const e1 = { id: 'e1', at: now - 60000, source: 'session', values: baseline.values, strings: baseline.strings, changes: [] };
  const e2 = {
    id: 'e2', at: now - 1000, source: 'engineer', label: 'More front turn-in +2',
    values: snap.values, strings: snap.strings,
    changes: [
      { key: 'VM_REAR_WING', from: 2, to: 4, fromStr: 'P3', toStr: 'P5' },
      { key: 'VM_FRONT_ANTISWAY', from: 3, to: 15, fromStr: 'D30 S-S', toStr: 'D36 H-H' },
    ],
  };
  return [e2, e1]; // newest first, as main sends them
}

async function boot({ connected = true, entries = historyFixture() } = {}) {
  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    listeners: new Map(),
    ids: new Map(),
  };
  const view = new Node('section', doc);
  view.setAttribute('data-view', 'setups');
  view.setAttribute('data-active', 'true');
  const tagFor = (id) =>
    /-(apply|revert|toggle|import|save|confirm|cancel|copy|file|publish|ok|close|refresh|feedback|send|share|open)$/.test(id) ? 'button'
      : /-(track|car|class|sort)$/.test(id) && id.startsWith('setup-') ? 'select'
      : /-(name|follow)$/.test(id) ? 'input'
      : /-(message|notes)$/.test(id) ? 'textarea'
      : 'div';
  const document = {
    get visibilityState() { return doc.visibilityState; },
    get activeElement() { return doc.activeElement; },
    querySelector(sel) {
      if (sel === '[data-view="setups"]') return view;
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        if (!doc.ids.has(id)) {
          const n = new Node(tagFor(id), doc);
          n.setAttribute('id', id);
          if (id === 'setup-offline') n.appendChild(new Node('p', doc));
          if (id === 'setup-canvas-wrap') n.appendChild(new Node('img', doc));
          if (id === 'setup-body' || id === 'setup-side') n.hidden = true;
          if (id === 'setup-apply' || id === 'setup-revert') n.disabled = true; // as in the markup
          doc.ids.set(id, n);
        }
        return doc.ids.get(id);
      }
      return null;
    },
    querySelectorAll: () => [],
    getElementById(id) { return this.querySelector(`#${id}`); },
    createElement: (tag) => new Node(tag, doc),
    createTextNode: (t) => textNode(String(t)),
    addEventListener: (type, fn) => {
      if (!doc.listeners.has(type)) doc.listeners.set(type, []);
      doc.listeners.get(type).push(fn);
    },
    body: new Node('body', doc),
  };

  const calls = { write: [], writeBatch: [], list: [], entry: [], clear: [] };
  const state = connected ? liveState() : { connected: false, car: '', carClass: '', symmetric: false, settings: [] };
  const setup = {
    state: async () => state,
    write: async (key, value) => { calls.write.push({ key, value }); return { ok: true }; },
    writeBatch: async (writes, meta) => {
      calls.writeBatch.push({ writes, meta });
      return { ok: true, results: writes.map((w) => ({ key: w.key, ok: true, applied: w.value })), state };
    },
    carImage: async () => ({ ok: false }),
    libList: async () => [],
    cloudList: async () => ({ ok: false, error: 'offline in test' }),
    history: {
      list: async (key) => {
        calls.list.push(key);
        const list = entries.map((e) => ({ id: e.id, at: e.at, source: e.source, label: e.label, changes: e.changes, ...(e.id === 'e2' ? { isCurrent: true } : {}) }));
        return {
          ok: true,
          currentId: connected ? KEY : '',
          live: connected,
          key: { id: KEY, car: 'Ferrari 296 LMGT3', trackFolder: 'Spa', trackName: 'Circuit de Spa-Francorchamps', carClass: 'GT3', count: list.length },
          keys: [{ id: KEY, car: 'Ferrari 296 LMGT3', trackFolder: 'Spa', trackName: 'Circuit de Spa-Francorchamps', count: list.length, lastAt: Date.now() }],
          entries: list,
          pending: null,
        };
      },
      entry: async (key, id) => {
        calls.entry.push({ key, id });
        const e = entries.find((x) => x.id === id);
        return e ? { ok: true, entry: JSON.parse(JSON.stringify(e)) } : { ok: false };
      },
      clear: async (key) => { calls.clear.push(key); return { ok: true }; },
    },
  };

  const store = new Map();
  const window = {
    apex: { setup },
    addEventListener: () => {},
    APEX_FEATURE_CATALOG: { note: () => {} },
  };
  const errors = [];
  const context = vm.createContext({
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Date,
    Intl,
    navigator: { clipboard: { writeText: async () => {} } },
    location: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  });
  const onRejection = (e) => errors.push(e);
  process.on('unhandledRejection', onRejection);
  for (const f of ['setup-groups.js', 'setup-info.js', 'setup-macros.js', 'setup-history-core.js', 'setup-tags.js', 'setup-editor.js']) {
    try {
      vm.runInContext(fs.readFileSync(path.join(PANEL, f), 'utf8'), context, { filename: f });
    } catch (e) {
      errors.push(e);
    }
  }
  const settle = async (ms = 30) => {
    await new Promise((r) => setTimeout(r, ms));
  };
  await settle();
  const el = (id) => document.querySelector(`#${id}`);
  const stop = () => {
    window.apexSetup && window.apexSetup.hidden();
    process.removeListener('unhandledRejection', onRejection);
  };
  return { el, calls, errors, settle, stop, window };
}

(async () => {
  console.log('\nLive car: the History tab lists, restores by staging, compares');
  {
    const t = await boot();
    const tabs = t.el('setup-tabs');
    const histBtn = tabs.children.find((b) => b.getAttribute('data-tab') === 'history');
    check('the editor booted without throwing', t.errors.length === 0, t.errors.map((e) => String(e && e.stack || e)).join(' | ') || 'clean');
    check('a History button sits beside the garage pages', Boolean(histBtn) && tabs.children.length === 7 && histBtn.textContent.includes('History'), tabs.children.map((b) => b.textContent).join(','));
    check('…with the clock icon from the sprite', histBtn && all(histBtn, (n) => n.tagName === 'USE')[0]?.getAttribute('href') === '#i-clock');

    histBtn.click();
    await t.settle();
    const rows = () => byClass(t.el('setup-rows'), 'su-hist__row');
    check('opening it asks main for the list', t.calls.list.length >= 1);
    check('every version is listed', rows().length === 2, String(rows().length));
    check('grouped under a day heading', byClass(t.el('setup-rows'), 'su-section__title').some((h) => h.textContent === 'Today'));
    const newest = rows()[0];
    const summary = byClass(newest, 'su-hist__summary')[0];
    check('the summary names the changes in the sim’s wording', summary && /2 changes: .*P3 → P5/.test(summary.textContent), summary && summary.textContent);
    check('…carries the Apply’s label', summary && summary.textContent.includes('More front turn-in +2'));
    check('…and the source', byClass(newest, 'su-hist__src')[0].textContent.includes('Race engineer'));
    check('the version on the car is marked and cannot be restored onto itself', newest.getAttribute('data-current') === 'true' && buttonNamed(newest, 'Restore this version')[0].disabled === true);

    // Expand the full diff.
    const more = byClass(newest, 'su-hist__more')[0];
    more.click();
    await t.settle();
    const diff = byClass(rows()[0], 'su-hist__diff')[0];
    check('expanding shows every change, before → after', diff && byClass(diff, 'su-hist__line').length === 2 && diff.textContent.includes('D30 S-S → D36 H-H'), diff && diff.textContent);

    // Compare the baseline with now — nothing staged.
    const base = rows()[1];
    buttonNamed(base, 'Compare with now')[0].click();
    await t.settle();
    const cmp = byClass(rows()[1], 'su-hist__diff')[0];
    check('Compare with now draws the restore diff inline', cmp && cmp.textContent.includes('P5 → P3'), cmp && cmp.textContent);
    check('…naming what a restore would skip', cmp && cmp.textContent.includes('fixed by ruleset') && cmp.textContent.includes('not on this car'));
    check('…and stages nothing', t.el('setup-apply').disabled === true && t.el('setup-staged').getAttribute('data-ready') !== 'true');

    // Restore the baseline.
    const restore = buttonNamed(rows()[1], 'Restore this version')[0];
    check('Restore is enabled on an older version', restore && restore.disabled === false, restore && restore.title);
    restore.click();
    await t.settle();
    const bar = t.el('setup-staged-count').textContent;
    check('Restore stages through the staged bar', /Restore to .* loaded · 1 setting staged · 2 skipped/.test(bar), bar);
    check('…and arms Apply', t.el('setup-apply').disabled === false && t.el('setup-staged').getAttribute('data-ready') === 'true');
    check('…without writing anything', t.calls.write.length === 0 && t.calls.writeBatch.length === 0);
    const status = byClass(t.el('setup-rows'), 'su-hist__status')[0];
    check('History says what was staged and what was skipped', status && /1 change staged .* Apply to send\. Skipped .*fixed by ruleset.*not on this car/.test(status.textContent), status && status.textContent);

    // Apply sends exactly the staged keys, named as a restore.
    t.el('setup-apply').click();
    await t.settle();
    const sent = t.calls.writeBatch[0];
    check('Apply sends only the restorable key', sent && sent.writes.length === 1 && sent.writes[0].key === 'VM_REAR_WING' && sent.writes[0].value === 2, sent && JSON.stringify(sent.writes));
    check('…tagged as a restore for History', sent && sent.meta && sent.meta.source === 'restore' && /^Restored to /.test(sent.meta.label), sent && JSON.stringify(sent.meta));
    check('…and History re-reads straight after', t.calls.list.length >= 2);
    check('no throws along the way', t.errors.length === 0, t.errors.map((e) => String(e && e.message || e)).join(' | ') || 'clean');
    t.stop();
  }

  console.log('\nSim shut: History is readable, Restore explains why not');
  {
    const t = await boot({ connected: false });
    check('the offline card is up', t.el('setup-offline').hidden === false && t.el('setup-body').hidden === true);
    t.el('setup-history-open').click();
    await t.settle();
    check('the offline button opens History in the editor frame', t.el('setup-body').hidden === false && t.el('setup-offline').hidden === true);
    const rows = byClass(t.el('setup-rows'), 'su-hist__row');
    check('versions are listed offline', rows.length === 2);
    const restore = buttonNamed(rows[1], 'Restore this version')[0];
    check('Restore is disabled with a reason', restore && restore.disabled === true && /LMU running/.test(restore.title), restore && restore.title);
    const pages = t.el('setup-tabs').children.filter((b) => b.getAttribute('data-tab') !== 'history');
    check('the garage pages are disabled while offline', pages.length === 6 && pages.every((b) => b.disabled));
    check('no throws offline', t.errors.length === 0, t.errors.map((e) => String(e && e.message || e)).join(' | ') || 'clean');
    t.stop();
  }

  console.log('\nNo versions yet: the empty state explains itself');
  {
    const t = await boot({ entries: [] });
    const histBtn = t.el('setup-tabs').children.find((b) => b.getAttribute('data-tab') === 'history');
    histBtn.click();
    await t.settle();
    const empty = byClass(t.el('setup-rows'), 'su-lib__empty')[0];
    check('an empty history says what will appear', empty && /No versions yet/.test(empty.textContent), empty && empty.textContent);
    check('no throws when empty', t.errors.length === 0);
    t.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
