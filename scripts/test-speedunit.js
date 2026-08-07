/**
 * scripts/test-speedunit.js — kph/mph, converted once for every widget.
 * -----------------------------------------------------------------------------
 * Three widgets show speed: both inputs panels and motion. They used to format
 * it themselves, which is how you end up with a driver reading 168 on one panel
 * and 104 on the next and reasonably concluding the overlay is broken. The
 * conversion now lives once in the shared runtime (`fmt.speed`), and the unit
 * arrives on the appearance channel so changing it retunes every readout live.
 *
 * What is asserted here is the arithmetic and the sentinel, because both are
 * silently wrong rather than visibly wrong: a bad divisor still prints a
 * plausible number, and the -1 "no data" sentinel formatted as a speed prints
 * "-1 mph" on a panel that should read "— mph".
 *
 * client.js is a browser IIFE, so it is evaluated against a DOM stub rather
 * than imported. Run: node scripts/test-speedunit.js
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

/** Enough of an element for client.js to boot without touching a real DOM. */
function makeElement(tag) {
  return {
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    children: [],
    attrs: {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector: () => null,
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
  };
}

/**
 * Load the runtime. Returns `fmt` plus the appearance callback client.js
 * registered, so a unit change can be delivered the way the app delivers it.
 */
function loadRuntime() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'js', 'client.js'), 'utf8');
  let onUnit = null;
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    // "loading" parks the boot path on DOMContentLoaded so no socket is opened.
    document: {
      readyState: 'loading',
      documentElement: makeElement('html'),
      createElement: makeElement,
      querySelector: () => null,
      getElementById: () => null,
      addEventListener: () => {},
    },
    window: {
      addEventListener: () => {},
      location: { search: '', protocol: 'http:' },
      ApexAppearance: {
        onSpeedUnit: (cb) => {
          onUnit = cb;
          cb('kph');
        },
      },
    },
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  if (!sandbox.window.ApexOverlay) throw new Error('client.js exposed no ApexOverlay');
  return {
    fmt: sandbox.window.ApexOverlay.fmt,
    setUnit: (u) => {
      if (!onUnit) throw new Error('client.js never subscribed to the speed unit');
      onUnit(u);
    },
  };
}

const { fmt, setUnit } = loadRuntime();

/* -------------------------------------------------------------------------- */
console.log('\nThe runtime exposes one speed formatter');
/* -------------------------------------------------------------------------- */

check('fmt.speed exists', typeof fmt.speed === 'function');
check('fmt.speedFromMs exists', typeof fmt.speedFromMs === 'function');
check('fmt.speedValue exists', typeof fmt.speedValue === 'function');
check('fmt.speedUnitLabel exists', typeof fmt.speedUnitLabel === 'function');

/* -------------------------------------------------------------------------- */
console.log('\nkph — the sim\'s own unit, and the default');
/* -------------------------------------------------------------------------- */

check('a speed carries its unit', fmt.speed(168) === '168 kph', fmt.speed(168));
check('rounded, not truncated', fmt.speed(167.6) === '168 kph', fmt.speed(167.6));
check('a stationary car is 0, not blank', fmt.speed(0) === '0 kph', fmt.speed(0));

/* -------------------------------------------------------------------------- */
console.log('\nNo data — the sentinel must never be shown as a speed');
/* -------------------------------------------------------------------------- */

// -1 is the UNKNOWN_VALUE sentinel shared with types.ts. Printed as a number it
// reads as a car travelling backwards at 1 kph.
check('the -1 sentinel renders as a dash', fmt.speed(-1) === '— kph', fmt.speed(-1));
check('undefined renders as a dash', fmt.speed(undefined) === '— kph', String(fmt.speed(undefined)));
check('the unit stays beside the dash', /kph$/.test(fmt.speed(-1)), fmt.speed(-1));

/* -------------------------------------------------------------------------- */
console.log('\nSwitching to mph retunes every readout, live');
/* -------------------------------------------------------------------------- */

setUnit('mph');

// 1 mile = 1.609344 km exactly. 168 / 1.609344 = 104.39…
check('168 kph is 104 mph', fmt.speed(168) === '104 mph', fmt.speed(168));
check('100 kph is 62 mph', fmt.speed(100) === '62 mph', fmt.speed(100));
check('320 kph is 199 mph', fmt.speed(320) === '199 mph', fmt.speed(320));
check('the dash follows the unit', fmt.speed(-1) === '— mph', fmt.speed(-1));

/* -------------------------------------------------------------------------- */
console.log('\nm/s — the motion widget\'s own units, same conversion');
/* -------------------------------------------------------------------------- */

// The motion widget holds speed in m/s. It must not carry its own ×3.6 and its
// own mph divisor, or it is one edit away from disagreeing with the inputs
// panels — which is the bug this whole change exists to prevent.
check('50 m/s is 112 mph', fmt.speedFromMs(50) === '112 mph', fmt.speedFromMs(50));
setUnit('kph');
check('50 m/s is 180 kph', fmt.speedFromMs(50) === '180 kph', fmt.speedFromMs(50));
check(
  'both formatters agree at the same speed',
  fmt.speedFromMs(50) === fmt.speed(180),
  `${fmt.speedFromMs(50)} vs ${fmt.speed(180)}`,
);
check('the m/s sentinel is a dash too', fmt.speedFromMs(-1) === '— kph', fmt.speedFromMs(-1));

/* -------------------------------------------------------------------------- */
console.log('\nValue and unit apart — the Speedo cluster sizes them differently');
/* -------------------------------------------------------------------------- */

// The cluster prints the number at 58px and the unit at 9px, so it needs the
// two separately. They must be VIEWS on the same arithmetic, never a second copy
// of it — so the pair is asserted to reconstruct fmt.speed() exactly.
setUnit('kph');
check('the value alone carries no unit', fmt.speedValue(168) === '168', fmt.speedValue(168));
check('the label alone is the unit', fmt.speedUnitLabel() === 'kph', fmt.speedUnitLabel());
check(
  'value + label reconstructs fmt.speed',
  `${fmt.speedValue(168)} ${fmt.speedUnitLabel()}` === fmt.speed(168),
  `${fmt.speedValue(168)} ${fmt.speedUnitLabel()}`,
);
setUnit('mph');
check('the value converts with the unit', fmt.speedValue(168) === '104', fmt.speedValue(168));
check('the label follows too', fmt.speedUnitLabel() === 'mph', fmt.speedUnitLabel());
check(
  'they still reconstruct after a unit change',
  `${fmt.speedValue(320)} ${fmt.speedUnitLabel()}` === fmt.speed(320),
  `${fmt.speedValue(320)} ${fmt.speedUnitLabel()}`,
);
// The sentinel must be a BARE dash here, not '— mph': the cluster puts the unit
// in its own element, so a dash carrying one would print the unit twice.
check('the sentinel is a bare dash', fmt.speedValue(-1) === '—', fmt.speedValue(-1));
check(
  'undefined is a bare dash too',
  fmt.speedValue(undefined) === '—',
  String(fmt.speedValue(undefined)),
);
setUnit('kph');

/* -------------------------------------------------------------------------- */
console.log('\nA nonsense unit must not blank the readout');
/* -------------------------------------------------------------------------- */

setUnit('furlongs per fortnight');
check('an unknown unit is ignored, not adopted', fmt.speed(180) === '180 kph', fmt.speed(180));

/* -------------------------------------------------------------------------- */
console.log('\nNo widget formats speed on its own any more');
/* -------------------------------------------------------------------------- */

for (const w of ['pedals', 'pedalsv', 'motion', 'speedo']) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'overlay', 'js', 'widgets', `${w}.js`), 'utf8');
  check(`${w}.js carries no unit string of its own`, !/["'] ?(kph|mph)["']|\* 3\.6/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
