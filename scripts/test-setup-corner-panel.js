/**
 * scripts/test-setup-corner-panel.js — the engineer card actually RENDERS.
 * -----------------------------------------------------------------------------
 * The corner-balance macros reach the panel through three files that only
 * meet in the browser: setup-directions.js, setup-macros.js and the editor's
 * buildMacros/restage/Apply. The headless suite (test-setup.js) pins the pure
 * halves; this runs the REAL setup files, in index.html's order, inside
 * node:vm against a stub DOM and a stub window.apex.setup bridge, and fails on
 * any throw. It checks the part a driver sees and the part they never do:
 *
 *   - the card draws a "Corner balance" heading over five sliders and a
 *     "Track & conditions" heading over four
 *   - dragging a balance slider stages changes through resolveMacro with the
 *     direction self-check's options attached
 *   - an Apply whose labels contradict the direction table is remembered for
 *     that car, and the next restage hands the correction to resolveMacro
 *
 * Run: node scripts/test-setup-corner-panel.js   (needs a built dist/)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { projectSetupState } = require('../dist/telemetry/setupState.js');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`);
  if (!ok) failures += 1;
}

/** A DOM element that accepts anything; listeners and children are kept so the test can drive them. */
function stub(label, overrides) {
  const store = { __label: label, children: [], listeners: {}, ...(overrides || {}) };
  const target = function () {};
  return new Proxy(target, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return [][Symbol.iterator].bind(store.children);
      if (k === 'then') return undefined;
      if (k === 'addEventListener') {
        return (type, fn) => {
          (store.listeners[type] ??= []).push(fn);
        };
      }
      if (k === 'replaceChildren') return (...kids) => { store.children = kids; };
      if (k === 'appendChild' || k === 'append') {
        return (...kids) => {
          store.children.push(...kids);
          return kids[0];
        };
      }
      if (k === 'textContent' && !('textContent' in store)) return '';
      if (k in store) return store[k];
      const child = stub(`${label}.${String(k)}`);
      store[k] = child;
      return child;
    },
    set(_t, k, v) {
      // Clearing a container the DOM way empties it.
      if (k === 'textContent' && v === '') store.children = [];
      store[k] = v;
      return true;
    },
    apply() {
      return stub(`${label}()`);
    },
  });
}

const fire = async (el, type) => {
  for (const fn of el.listeners[type] || []) await fn({ target: el, preventDefault() {}, stopPropagation() {} });
};

(async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'garage-gt3.json'), 'utf8'));
  const base = projectSetupState(fixture, 'Oreca 07', 'LMP2');
  const state = { ...base, carModel: 'Oreca 07', trackName: 'Spa', trackFolder: 'Spa', session: 'PRACTICE1' };

  // After Apply the sim answers with the bias index two steps UP but its label
  // moved FORWARD — a car whose ladder runs against the table.
  const applied = JSON.parse(JSON.stringify(state));
  const bb = applied.settings.find((s) => s.key === 'VM_BRAKE_BALANCE');
  bb.value += 2;
  bb.stringValue = '53.2:46.8';

  const elements = new Map();
  const view = stub('view', { getAttribute: (n) => (n === 'data-active' ? 'true' : null) });
  const document = {
    visibilityState: 'visible',
    querySelector: (sel) => {
      if (sel === '[data-view="setups"]') return view;
      if (!elements.has(sel)) elements.set(sel, stub(sel));
      return elements.get(sel);
    },
    querySelectorAll: () => [],
    createElement: (tag) => stub(`<${tag}>`),
    createTextNode: (t) => stub(`text:${t}`),
    addEventListener: () => {},
    body: stub('body'),
    get activeElement() {
      return null;
    },
  };

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const writes = [];
  const setupBridge = new Proxy(
    {
      state: async () => state,
      writeBatch: async (w) => {
        writes.push(...w);
        return { ok: true, results: w.map((x) => ({ key: x.key, ok: true, applied: x.value })), state: applied };
      },
      libList: async () => ({ ok: true, entries: [] }),
      cloudList: async () => ({ ok: true, rows: [] }),
      carImage: async () => ({ ok: false }),
    },
    { get: (t, k) => (k in t ? t[k] : async () => ({ ok: false })) },
  );

  const warnings = [];
  const errors = [];
  const sandbox = {
    document,
    localStorage,
    console: { ...console, warn: (...a) => warnings.push(a.join(' ')) },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    navigator: {},
    location: {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getComputedStyle: () => stub('style'),
  };
  sandbox.window = sandbox;
  sandbox.apex = new Proxy({ setup: setupBridge }, { get: (t, k) => (k in t ? t[k] : stub(`apex.${String(k)}`)) });
  sandbox.addEventListener = () => {};
  const context = vm.createContext(sandbox);

  process.on('unhandledRejection', (e) => errors.push(e));
  const dir = path.join(__dirname, '..', 'electron', 'control-panel');
  // index.html's order for the setup editor's files.
  for (const f of ['setup-groups.js', 'setup-info.js', 'setup-directions.js', 'setup-macros.js', 'setup-tags.js', 'setup-guide.js', 'setup-editor.js']) {
    try {
      vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), context, { filename: f });
    } catch (e) {
      errors.push(e);
    }
  }

  // Record what restage hands resolveMacro.
  const calls = [];
  const real = sandbox.APEX_SETUP_MACROS.resolveMacro;
  sandbox.APEX_SETUP_MACROS.resolveMacro = (...args) => {
    calls.push(args);
    return real(...args);
  };

  await new Promise((r) => setTimeout(r, 60)); // shown() → poll → applyState → buildMacros

  console.log('\nThe engineer card');
  check('the setup files load and render without throwing', errors.length === 0, errors.map((e) => String((e && e.message) || e)).join(' | ') || 'clean');

  const list = elements.get('#setup-macro-list');
  const kids = list ? list.children : [];
  const shape = kids.map((k) => (k.className === 'su-macro-group' ? `[${k.children[0].textContent}]` : 'slider')).join(' ');
  check(
    'a Corner balance heading over five sliders, then Track & conditions over four',
    shape === '[Corner balance] slider slider slider slider slider [Track & conditions] slider slider slider slider',
    shape,
  );
  const ends = kids[0] && kids[0].children[1];
  check('the balance heading names its two ends', !!ends && /Stable/.test(ends.textContent) && /Rotation/.test(ends.textContent), ends && ends.textContent);
  const firstSlider = kids[1];
  const label = firstSlider && firstSlider.children[0];
  check('sliders carry their driver-English hint', !!label && label.textContent === 'Slow entry' && /Right =/.test(label.title));

  // Drag "Slow entry" to +2.
  const range = firstSlider.children[2];
  range.value = '2';
  await fire(range, 'input');
  const apply = elements.get('#setup-apply');
  check('dragging a balance slider stages changes', apply.disabled === false, String(elements.get('#setup-staged-count').textContent));
  const last = calls[calls.length - 1];
  check('restage passes the self-check options to resolveMacro', !!last && last[4] && 'flips' in last[4]);

  // Apply: the sim's answer contradicts the table on brake bias.
  await fire(apply, 'click');
  await new Promise((r) => setTimeout(r, 20));
  check('Apply sends the staged bias change', writes.some((w) => w.key === 'VM_BRAKE_BALANCE'));
  const flips = sandbox.APEX_SETUP_DIRECTIONS.flipsFor('Oreca 07');
  check('a contradicting Apply is remembered for that car', !!flips && flips.VM_BRAKE_BALANCE === -1, JSON.stringify(flips));
  check('…and logged', warnings.some((w) => /VM_BRAKE_BALANCE ran against the direction table/.test(w)));
  check('…and only for that car', sandbox.APEX_SETUP_DIRECTIONS.flipsFor('Some Other Car') === null);

  calls.length = 0;
  range.value = '1';
  await fire(range, 'input');
  const after = calls[calls.length - 1];
  check('the next restage hands the correction to resolveMacro', !!after && after[4] && after[4].flips && after[4].flips.VM_BRAKE_BALANCE === -1);
  check('nothing threw along the way', errors.length === 0, errors.map((e) => String((e && e.message) || e)).join(' | ') || 'clean');

  console.log(failures === 0 ? '\nAll corner-panel checks passed.' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
