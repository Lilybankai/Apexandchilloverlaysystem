/**
 * scripts/test-tempunit.js — Celsius/Fahrenheit, converted once for everything.
 * -----------------------------------------------------------------------------
 * The sim publishes every temperature in Celsius. Plenty of drivers read tyres
 * in Fahrenheit, so the app has a unit preference — and with it the same trap as
 * the speed unit before it (scripts/test-speedunit.js): the tyres widget, three
 * of the Speedo designs and the weather panel all print temperatures, and a
 * driver reading 96 on one and 205 on the next would be right to think the
 * overlay was broken. The conversion lives once in the shared runtime
 * (`fmt.temp*`), and the unit arrives on the appearance channel so a change
 * retunes every readout live.
 *
 * What is asserted here is what fails SILENTLY rather than visibly:
 *
 *   - the -1 "no data" sentinel. In Celsius `has()` catches it. Converted first
 *     it becomes 30.2 °F, which prints as a perfectly plausible cold tyre on a
 *     panel that should be showing a dash.
 *   - offset vs scale. A window width, a spread and a "6 degrees over" are
 *     DIFFERENCES: 8 °C of margin is 14.4 °F of margin, not 46.4 of anything.
 *     The two conversions are one multiply apart and neither looks wrong.
 *   - the physics staying metric. The operating-window lamp and the blue→red
 *     ramp judge against the sim's own optimum in the sim's own unit; a widget
 *     that handed them a converted number would call an 86 °F tyre — a cold one
 *     — overheating.
 *
 * client.js is a browser IIFE, so it is evaluated against a DOM stub rather
 * than imported. Run: node scripts/test-tempunit.js
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
  let onTemp = null;
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
        onSpeedUnit: (cb) => cb('kph'),
        onTempUnit: (cb) => {
          onTemp = cb;
          cb('c');
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
      if (!onTemp) throw new Error('client.js never subscribed to the temperature unit');
      onTemp(u);
    },
  };
}

const { fmt, setUnit } = loadRuntime();

/* -------------------------------------------------------------------------- */
console.log('\nThe runtime exposes one set of temperature formatters');
/* -------------------------------------------------------------------------- */

check('fmt.temp exists', typeof fmt.temp === 'function');
check('fmt.temp1 exists', typeof fmt.temp1 === 'function');
check('fmt.tempValue exists', typeof fmt.tempValue === 'function');
check('fmt.tempSpan exists', typeof fmt.tempSpan === 'function');
check('fmt.tempUnitLabel exists', typeof fmt.tempUnitLabel === 'function');
// The Celsius-only pair these replaced. Left behind, a widget that still called
// one would quietly opt out of the setting and print Celsius forever.
check('the old Celsius-only helpers are gone', !fmt.tempC && !fmt.tempC1);

/* -------------------------------------------------------------------------- */
console.log("\nCelsius — the sim's own unit, and the default");
/* -------------------------------------------------------------------------- */

check('a temperature is whole degrees', fmt.temp(96.4) === '96°', fmt.temp(96.4));
check('the fine one keeps a decimal', fmt.temp1(96.42) === '96.4°', fmt.temp1(96.42));
check('a freezing track is 0, not blank', fmt.temp(0) === '0°', fmt.temp(0));
check('the label names the unit', fmt.tempUnitLabel() === '°C', fmt.tempUnitLabel());
check('a span passes straight through', fmt.tempSpan(8) === 8, fmt.tempSpan(8));

/* -------------------------------------------------------------------------- */
console.log('\nNo data — the sentinel must never be shown as a temperature');
/* -------------------------------------------------------------------------- */

// -1 is the UNKNOWN_VALUE sentinel shared with types.ts. It has to be caught
// BEFORE the conversion: -1 °C is 30.2 °F, which reads as a cold tyre.
check('the -1 sentinel is a dash', fmt.temp(-1) === '—', fmt.temp(-1));
check('and a dash from the fine one too', fmt.temp1(-1) === '—', fmt.temp1(-1));
check('the value form is null, not a number', fmt.tempValue(-1) === null, String(fmt.tempValue(-1)));
check('undefined is a dash', fmt.temp(undefined) === '—', String(fmt.temp(undefined)));
check('a missing value is null', fmt.tempValue(undefined) === null, String(fmt.tempValue(undefined)));

/* -------------------------------------------------------------------------- */
console.log('\nSwitching to Fahrenheit retunes every readout, live');
/* -------------------------------------------------------------------------- */

setUnit('f');

check('0 °C is 32 °F', fmt.temp(0) === '32°', fmt.temp(0));
check('100 °C is 212 °F', fmt.temp(100) === '212°', fmt.temp(100));
check('a 96 °C tyre is 205 °F', fmt.temp(96) === '205°', fmt.temp(96));
check('the label follows', fmt.tempUnitLabel() === '°F', fmt.tempUnitLabel());
check('the sentinel is still a dash', fmt.temp(-1) === '—', fmt.temp(-1));
check('and still null, not 30.2', fmt.tempValue(-1) === null, String(fmt.tempValue(-1)));

// A tenth of a °F is below anything a driver acts on, and the tyre widget's
// corner cells were sized for "96.4°", not "205.5°".
check('the fine one drops its decimal in °F', fmt.temp1(96.42) === '206°', fmt.temp1(96.42));

/* -------------------------------------------------------------------------- */
console.log('\nA span is scaled, not offset — the difference between 14 and 46');
/* -------------------------------------------------------------------------- */

// The tyre lamp's ±8 °C window, named in the driver's unit. Run through the
// reading conversion instead, it would come out as 46.4 — a window nearly six
// times wider than the lamp is actually using.
check('8 °C of window is 14.4 °F', fmt.tempSpan(8) === 14.4, fmt.tempSpan(8));
check('a 5-degree spread is 9', fmt.tempSpan(5) === 9, fmt.tempSpan(5));
check('no span is null', fmt.tempSpan(undefined) === null, String(fmt.tempSpan(undefined)));
// A span of zero is a real answer — two tyres at the same temperature.
check('zero stays zero in both units', fmt.tempSpan(0) === 0, fmt.tempSpan(0));

/* -------------------------------------------------------------------------- */
console.log('\nValue and sign apart — the canvas dashes size them differently');
/* -------------------------------------------------------------------------- */

check('the value alone carries no degree sign', fmt.tempValue(96) === 204.8, fmt.tempValue(96));
check(
  'value + sign reconstructs fmt.temp',
  `${Math.round(fmt.tempValue(96))}°` === fmt.temp(96),
  `${Math.round(fmt.tempValue(96))}° vs ${fmt.temp(96)}`,
);

/* -------------------------------------------------------------------------- */
console.log('\nA nonsense unit must not blank the readout');
/* -------------------------------------------------------------------------- */

setUnit('kelvin');
check('an unknown unit is ignored, not adopted', fmt.temp(96) === '205°', fmt.temp(96));
setUnit('c');
check('and Celsius comes back', fmt.temp(96) === '96°', fmt.temp(96));

/* -------------------------------------------------------------------------- */
console.log('\nNo widget formats a temperature on its own any more');
/* -------------------------------------------------------------------------- */

const WIDGETS = path.join(__dirname, '..', 'overlay', 'js', 'widgets');
for (const w of ['tyres', 'weather', 'speedo-gt3', 'speedo-lmp2', 'speedo-real']) {
  const src = fs.readFileSync(path.join(WIDGETS, `${w}.js`), 'utf8');
  // A quoted "°C"/"°F" is a unit the widget decided for itself. Prose in a
  // comment is fine — this looks only at string literals.
  check(`${w}.js carries no unit literal of its own`, !/["']\s*°\s*[CF]["']/.test(src));
  // ...and no second copy of the arithmetic.
  check(`${w}.js does not convert on its own`, !/\*\s*1\.8|\*\s*9\s*\/\s*5/.test(src));
}

/* -------------------------------------------------------------------------- */
console.log('\nThe physics stays metric');
/* -------------------------------------------------------------------------- */

// The lamp's window and the thermal ramp's anchors are Celsius constants judged
// against the sim's own published optimum, which is also Celsius. Convert the
// reading before that comparison and an 86 °F tyre is called overheating. So the
// widget must go on handing them the RAW value.
const tyresSrc = fs.readFileSync(path.join(WIDGETS, 'tyres.js'), 'utf8');
check(
  'the lamp is still judged on the raw reading',
  /tempLamp\(t\.tempC, t\.optimalTempC/.test(tyresSrc),
);
check(
  'the ramp is still anchored on the raw optimum',
  /rampColor\(bands\[b\], t\.optimalTempC/.test(tyresSrc),
);
// The tooltip NAMES that window to the driver, so it is the one place the
// constant has to be converted — as a span.
check("but the tooltip names it in the driver's unit", /fmt\.tempSpan\(IN_WINDOW_C\)/.test(tyresSrc));

// Same trap on the GT3 plates, from the other side. Thirteen canvas designs
// share one view model, and by the time live() runs the unit is gone — so every
// temperature is converted ONCE, in pull(), and nothing downstream may compare
// one against a number. A threshold left behind here would be wrong by nearly a
// factor of two the moment a driver picked °F.
const gt3Src = fs.readFileSync(path.join(WIDGETS, 'speedo-gt3.js'), 'utf8');
check('the view model converts every temperature', /trackT: tempNum\(w\.trackTempC\)/.test(gt3Src));
check('air temperature too', /airT: tempNum\(w\.ambientTempC\)/.test(gt3Src));
check('and the per-corner tyre and brake temps', /t: tempNum\(t\.tempC\), b: tempNum\(t\.brakeTempC\)/.test(gt3Src));
check('no Celsius field survives into the plates', !/v\.(trackC|airC)/.test(gt3Src));
check('no plate compares a temperature to a threshold', !/v\.(trackT|airT)\s*[<>]=?\s*\d/.test(gt3Src));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
