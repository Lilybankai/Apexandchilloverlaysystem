/**
 * scripts/test-engineer-panel.js — the Engineer tab actually RENDERS.
 * -----------------------------------------------------------------------------
 * 1.3.5 shipped an Engineer tab with no voice picker: render() referenced the
 * new Mature-radio <select> (module const `tone`) above a block-scoped
 * `const [text, tone] = statusText(s)` in the same function, so every render
 * threw "Cannot access 'tone' before initialization" before it reached the
 * voice list. The id-contract tests (test-panel-parity, test-radio-gate) only
 * read the source as text and passed.
 *
 * This runs the real engineer-panel.js in a vm against a stub DOM, feeds it
 * the real EngineerService.status() payload, and fails on any throw — so a
 * render that dies part-way is caught here, not by a driver.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EngineerService } = require('../electron/engineer');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/** A DOM element that accepts anything: unknown props are more stubs, calls return stubs. */
function stub(label) {
  const store = { __label: label, children: [] };
  const target = function () {};
  return new Proxy(target, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return [][Symbol.iterator].bind(store.children);
      if (k === 'then') return undefined; // not a thenable
      if (k === 'replaceChildren') return (...kids) => { store.children = kids; };
      if (k === 'appendChild' || k === 'append') return (...kids) => { store.children.push(...kids); return kids[0]; };
      if (k in store) return store[k];
      const child = stub(`${label}.${String(k)}`);
      store[k] = child;
      return child;
    },
    set(_t, k, v) {
      store[k] = v;
      return true;
    },
    apply() {
      return stub(`${label}()`);
    },
  });
}

async function run(engineerSettings) {
  const settings = { engineerEnabled: true, engineerVoice: 'en_GB-alan-medium', engineer: { readouts: 'standard', ...engineerSettings } };
  const svc = new EngineerService({ dir: path.join(os.tmpdir(), 'apex-engineer-panel-test'), loadSettings: () => settings, onStatus: () => {} });
  const status = svc.status();

  const elements = new Map();
  const document = {
    querySelector: (sel) => {
      if (!elements.has(sel)) elements.set(sel, stub(sel));
      return elements.get(sel);
    },
    querySelectorAll: () => [],
    createElement: (tag) => stub(`<${tag}>`),
    createTextNode: (t) => stub(`text:${t}`),
    addEventListener: () => {},
    get activeElement() {
      return null;
    },
  };
  const errors = [];
  let pushed = null;
  const api = new Proxy({}, {
    get(_t, k) {
      if (k === 'engineerStatus') return async () => status;
      if (k === 'onEngineerStatus') return (fn) => { pushed = fn; };
      if (k === 'actionsList') return async () => [];
      return async () => ({});
    },
  });
  const window = { apex: api, addEventListener: () => {} };
  const context = vm.createContext({
    window, document, console, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Audio: function () { return stub('audio'); }, navigator: {}, location: {},
  });
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'engineer-panel.js'), 'utf8');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (e) => errors.push(e));
  try {
    vm.runInContext(src, context, { filename: 'engineer-panel.js' });
  } catch (e) {
    errors.push(e);
  }
  await new Promise((r) => setTimeout(r, 50)); // the initial engineerStatus().then(render)
  try {
    if (pushed) pushed(status); // a status push re-renders through the same function
  } catch (e) {
    errors.push(e);
  }
  await new Promise((r) => setTimeout(r, 20));
  return { errors, elements, status };
}

(async () => {
  for (const tone of ['clean', 'banter', 'savage']) {
    console.log(`\n${tone}: the Engineer tab renders end to end`);
    const { errors, elements, status } = await run({ radioTone: tone });
    check('render() runs without throwing', errors.length === 0, errors.map((e) => String(e && e.message || e)).join(' | ') || 'clean');
    const voices = elements.get('#eng-voices');
    const kids = voices ? voices.children : [];
    check('…and draws a row for every voice', Array.isArray(kids) && kids.length === status.voices.length && kids.length > 0, `${kids && kids.length}/${status.voices.length}`);
    const pick = elements.get('#eng-tone');
    check('…and shows the chosen Mature radio setting', !!pick && pick.value === tone, pick && String(pick.value));
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
