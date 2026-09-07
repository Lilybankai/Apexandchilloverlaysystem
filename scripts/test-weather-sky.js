#!/usr/bin/env node
/**
 * scripts/test-weather-sky.js — the weather widget's sky glyphs.
 * -----------------------------------------------------------------------------
 * The forecast strip draws a sky icon per slot. That data was already arriving
 * and being thrown away — the provider maps LMU's forecast nodes to a SkyState
 * per slot and weather.js stamped it on the cell as `data-sky`, but nothing
 * painted it — so the failure this file guards is the same one coming back:
 * a sky that reaches the widget and renders as nothing.
 *
 * Five things are pinned, each of which broke or nearly broke while this was
 * being built:
 *
 *   1. EVERY SkyState HAS A GLYPH. The union is read out of src/telemetry/
 *      types.ts rather than restated here, so adding a seventh sky upstream
 *      fails this test instead of shipping a blank slot. A missing glyph is
 *      invisible in review and invisible in a screenshot of a dry session.
 *
 *   2. AN UNKNOWN SKY DRAWS NOTHING. The widget must not fall back to a cloud
 *      for a sky it does not recognise: an icon is read as fact in a fifth of a
 *      second, and inventing an overcast sky is worse than leaving a gap. This
 *      is the same rule the rest of the overlay follows — nothing is invented.
 *
 *   3. THE CSS ACTUALLY COLOURS THEM. `fill: currentColor` on the <svg> is the
 *      whole reason the glyphs follow the panel's text colour, including the
 *      lift they get in translucent-panel mode. It was omitted on the first
 *      pass and every icon rendered in the SVG default of BLACK — on a
 *      near-black panel, which is to say invisible. Nothing else in the build
 *      catches that: it is valid CSS, valid SVG, and a widget that looks empty.
 *
 *   4. RAIN INTENSITY IS NOT TRAPPED BEHIND THE FORECAST GATE. The strip is
 *      only rebuilt when its signature changes, because forecasts evolve
 *      slowly. Intensity does not — it moves while the forecast stands still.
 *      Writing the PRECIPITATION row inside that gate (the obvious place, right
 *      beside the icon reading the same slot) freezes the number at whatever it
 *      said when the forecast last shifted, and nothing looks broken: the row is
 *      populated, plausible and stale. Two frames with one forecast and two
 *      intensities is the whole test.
 *
 *   5. THE SUN DOES NOT BORROW THE CAUTION COLOUR. --warn means "something is
 *      wrong" everywhere else in this overlay. A sunny forecast is not a
 *      warning, so the glyphs carry their own palette; the storm bolt is the one
 *      deliberate exception.
 *
 * Run: node scripts/test-weather-sky.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log('  ok   ' + label);
  } else {
    failed++;
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/* ---------------------------------------------------------------------------
 * A DOM stub just big enough for this widget. Deliberately not a DOM library:
 * the point is to run the FILE THAT SHIPS, and the widget only ever needs
 * createElement, a couple of data-role lookups, and innerHTML as a way of
 * emptying a node.
 * ------------------------------------------------------------------------ */
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    attrs: {},
    _html: '',
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    classList: {
      toggle() {},
      add() {},
      remove() {},
    },
    querySelector(sel) {
      const m = /^\[data-role="(.+)"\]$/.exec(sel);
      if (!m) return null;
      const want = m[1];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.attrs['data-role'] === want) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return this._html;
    },
    set(v) {
      this._html = String(v);
      // The widget uses `innerHTML = ""` to empty a node before rebuilding it.
      if (this._html === '') this.children = [];
    },
  });
  return el;
}

/** Every element in the subtree, root included. */
function flatten(node, out) {
  out = out || [];
  out.push(node);
  for (const c of node.children) flatten(c, out);
  return out;
}

const registered = {};
const sandbox = {
  window: {
    ApexOverlay: {
      registerWidget(name, def) {
        registered[name] = def;
      },
    },
  },
  document: { createElement: (t) => makeEl(t) },
  Math,
  console,
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(read('overlay', 'js', 'widgets', 'weather.js'), sandbox, {
  filename: 'weather.js',
});

const widget = registered.weather;

console.log('\nregistration');
check(
  'the weather widget registers with init + update',
  !!widget && typeof widget.init === 'function' && typeof widget.update === 'function',
);
if (!widget) {
  console.log('\n  cannot continue without the widget\n');
  process.exit(1);
}

/* ------------------------------- the harness ----------------------------- */

const fmt = {
  temp: (c) => (typeof c === 'number' ? Math.round(c) + '°' : '—'),
  pct: (v) => (typeof v === 'number' ? v * 100 : 0),
};
const ctx = { fmt, critPulse() {} };

/** Mount the widget on a fresh root. `push` drives another frame through it. */
function mount(weather) {
  const root = makeEl('section');
  const header = makeEl('span');
  header.setAttribute('data-role', 'track-state');
  const body = makeEl('div');
  body.setAttribute('data-role', 'mount');
  root.appendChild(header);
  root.appendChild(body);
  widget.init(root);
  const push = (w) => {
    widget.update({ weather: w }, ctx);
    return body;
  };
  push(weather);
  return { root, mount: body, push };
}

/** Mount and drive one frame — the common case. */
function render(weather) {
  return mount(weather);
}

/** The named facts, as a { LABEL: value } map. */
function factsOf(node) {
  const cells = flatten(node);
  const out = {};
  for (let i = 0; i < cells.length; i++) {
    if (/(^|\s)weather__fact-k(\s|$)/.test(String(cells[i].className))) {
      const v = cells.find(
        (c, j) => j > i && /(^|\s)weather__fact-v(\s|$)/.test(String(c.className)),
      );
      if (v) out[cells[i].textContent] = v.textContent;
    }
  }
  return out;
}

function slotsOf(mount) {
  return flatten(mount).filter((el) => String(el.className) === 'weather__slot');
}

function iconsIn(node) {
  return flatten(node).filter((el) => /(^|\s)weather__icon(\s|$)/.test(String(el.className)));
}

const baseWeather = (forecast) => ({
  trackTempC: 22,
  ambientTempC: 21,
  rainIntensity: 0.4,
  trackWetness: 0.4,
  trackCondition: 'WET',
  forecast,
});

/* --------------------------- 1. every sky is drawn ----------------------- */

const typesSrc = read('src', 'telemetry', 'types.ts');
const unionMatch = /export type SkyState =([^;]+);/.exec(typesSrc);
const SKIES = unionMatch
  ? unionMatch[1].split('|').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  : [];

console.log('\nevery SkyState the providers can emit has a glyph');
check('the SkyState union was read out of src/telemetry/types.ts', SKIES.length >= 6,
  'found ' + JSON.stringify(SKIES));

const all = render(
  baseWeather(
    SKIES.map((sky, i) => ({
      label: 'S' + i,
      minutesAhead: i * 15,
      sky,
      airTempC: 20,
      trackTempC: 22,
      rainChance: 0.3,
    })),
  ),
);
const allSlots = slotsOf(all.mount);
check('one slot per forecast entry', allSlots.length === SKIES.length,
  'got ' + allSlots.length + ' of ' + SKIES.length);

SKIES.forEach((sky, i) => {
  const slot = allSlots[i];
  const icons = slot ? iconsIn(slot) : [];
  const svg = icons.length === 1 && /<svg[\s>]/.test(icons[0].innerHTML);
  check("sky '" + sky + "' draws exactly one <svg>", svg,
    icons.length + ' icon(s), html=' + JSON.stringify((icons[0] || {}).innerHTML || '').slice(0, 60));
  check("sky '" + sky + "' labels its icon for a screen reader",
    !!(icons[0] && icons[0].getAttribute('aria-label')));
});

/* ------------------------- 2. an unknown sky draws nothing --------------- */

console.log('\nan unrecognised sky is a gap, never a guess');
const unknown = render(
  baseWeather([
    { label: 'START', minutesAhead: 0, sky: 'meteors', airTempC: 20, trackTempC: 22, rainChance: 0.1 },
  ]),
);
const unknownIcons = iconsIn(slotsOf(unknown.mount)[0] || makeEl('div'));
check('an unknown sky renders no <svg> rather than a stand-in',
  unknownIcons.length === 1 && unknownIcons[0].innerHTML === '',
  JSON.stringify((unknownIcons[0] || {}).innerHTML));

/* ---------------------- 3. the now block, and what it replaced ----------- */

console.log('\nthe current conditions block');
const now = render(
  baseWeather([
    { label: 'START', minutesAhead: 0, sky: 'storm', airTempC: 20, trackTempC: 22, rainChance: 0.9 },
    { label: '25%', minutesAhead: 15, sky: 'clear', airTempC: 21, trackTempC: 24, rainChance: 0.05 },
  ]),
);
const nowIcons = iconsIn(now.mount).filter((el) => /weather__icon--now/.test(String(el.className)));
check('the now block carries its own, larger icon', nowIcons.length === 1);
check('the now icon is painted from the current slot',
  !!nowIcons[0] && nowIcons[0].getAttribute('data-sky') === 'storm',
  String(nowIcons[0] && nowIcons[0].getAttribute('data-sky')));
check('the now icon draws an <svg>', !!nowIcons[0] && /<svg[\s>]/.test(nowIcons[0].innerHTML));

// The text sky label it replaced is gone. Kept as a test because leaving both
// in is the easy mistake: they read as a caption and a picture of the caption,
// and the block only has room for one.
const widgetSrc = read('overlay', 'js', 'widgets', 'weather.js');
check('the old text sky label is gone from the meta column',
  !/skyEl/.test(widgetSrc));
check('SKY_LABEL is still used, as the icon\'s accessible name',
  /aria-label[^\n]*SKY_LABEL|SKY_LABEL\[sky\]/.test(widgetSrc));

/* ------------------------------ 4. the CSS ------------------------------- */

console.log('\nthe stylesheet actually colours and sizes them');
const css = read('overlay', 'css', 'overlay.css');
check('the <svg> fills with currentColor (or it renders BLACK on a black panel)',
  /\.weather__icon svg\s*\{[^}]*fill:\s*currentColor/.test(css));
check('a forecast-slot icon has a size', /\.weather__slot \.weather__icon\s*\{[^}]*width:/.test(css));
check('the now icon has its own, larger size', /\.weather__icon--now\s*\{[^}]*width:/.test(css));
check('falling rain is drawn in the rain token', /\.wx-wet\s*\{[^}]*stroke:\s*var\(--sky-drop\)/.test(css));
check('the storm bolt is drawn in the warn token', /\.wx-bolt\s*\{[^}]*fill:\s*var\(--warn\)/.test(css));
check('sky and temperature share a row', /\.weather__slot-row\s*\{[^}]*display:\s*flex/.test(css));
// Redundant once a sky glyph sits on the row above it.
check('the umbrella prefix on the rain percentage is gone',
  !/\.weather__slot-rain::before/.test(css));

const theme = read('overlay', 'css', 'theme.css');
check('--sky-drop is defined', /--sky-drop:/.test(theme));
check('the glyphs get a halo when the panel goes translucent, as the text does',
  /html\[data-panel-bg="translucent"\][^{]*\.weather__icon[^{]*\{[^}]*drop-shadow/.test(theme));

/* --------------------- 5. the current-conditions block ------------------- */

console.log('\ncurrent conditions reads as three named facts');
const conds = mount(
  baseWeather([
    { label: 'START', minutesAhead: 0, sky: 'rain', airTempC: 21, trackTempC: 22, rainChance: 0.75 },
    { label: '25%', minutesAhead: 15, sky: 'rain', airTempC: 21, trackTempC: 22, rainChance: 0.7 },
  ]),
);
const f = factsOf(conds.mount);
check('AIR TEMP is named and filled', f['AIR TEMP'] === '21°', JSON.stringify(f));
check('CONDITION carries the band and the wetness', f.CONDITION === 'WET (40%)', f.CONDITION);
check('PRECIPITATION names what is falling, with its intensity',
  f.PRECIPITATION === 'RAIN 40%', f.PRECIPITATION);
check('the track temperature keeps a caption of its own',
  flatten(conds.mount).some((el) => String(el.className) === 'weather__temp-cap'
    && el.textContent === 'TRACK TEMP'));
check('the track temperature is the number alone, with nothing inline',
  flatten(conds.mount).some((el) => String(el.className) === 'weather__temp'
    && el.textContent === '22°'));

// A dry, clear session must not read as raining anywhere in the block.
const dry = mount({
  trackTempC: 30, ambientTempC: 22, rainIntensity: 0, trackWetness: 0,
  forecast: [{ label: 'START', minutesAhead: 0, sky: 'clear', airTempC: 22, trackTempC: 30, rainChance: 0 }],
});
const fd = factsOf(dry.mount);
check('a clear, dry session precipitates NONE', fd.PRECIPITATION === 'NONE', fd.PRECIPITATION);
check('a dry track reads DRY, not "WET (0%)"', fd.CONDITION === 'DRY', fd.CONDITION);

// An overcast sky is not precipitation. This is the distinction the row exists
// for — the icon says cloud, and the row says nothing is coming out of it.
const grey = mount({
  trackTempC: 24, ambientTempC: 19, rainIntensity: 0, trackWetness: 0,
  forecast: [{ label: 'START', minutesAhead: 0, sky: 'overcast', airTempC: 19, trackTempC: 24, rainChance: 0.2 }],
});
check('an overcast sky still precipitates NONE',
  factsOf(grey.mount).PRECIPITATION === 'NONE', factsOf(grey.mount).PRECIPITATION);

// The trend survived the rebuild. A track at 30% drying and one at 30% getting
// wetter are opposite calls and the percentage alone cannot separate them.
const trend = mount({
  trackTempC: 22, ambientTempC: 21, rainIntensity: 0.1, trackWetness: 0.3,
  trackCondition: 'DAMP', trackTrend: 'drying',
  forecast: [{ label: 'START', minutesAhead: 0, sky: 'lightRain', airTempC: 21, trackTempC: 22, rainChance: 0.3 }],
});
check('a drying track is marked as drying',
  /▼/.test(factsOf(trend.mount).CONDITION), factsOf(trend.mount).CONDITION);

/* ------- 6. precipitation is not stuck behind the forecast gate ---------- */

// The forecast strip is only rebuilt when its SIGNATURE changes, because
// forecasts evolve slowly. Rain intensity does not: it moves while the forecast
// stands still. Writing the precipitation row inside that gate — the obvious
// place, right beside the icon that reads the same slot — freezes it at
// whatever it said when the forecast last shifted. Nothing on screen looks
// broken; the number is simply old.
console.log('\nrain intensity is not trapped behind the forecast-signature gate');
const FIXED_FORECAST = [
  { label: 'START', minutesAhead: 0, sky: 'rain', airTempC: 21, trackTempC: 22, rainChance: 0.75 },
  { label: '25%', minutesAhead: 15, sky: 'rain', airTempC: 21, trackTempC: 22, rainChance: 0.7 },
];
const live = mount({
  trackTempC: 22, ambientTempC: 21, rainIntensity: 0.2, trackWetness: 0.4,
  trackCondition: 'WET', forecast: FIXED_FORECAST,
});
check('it starts at the first intensity', factsOf(live.mount).PRECIPITATION === 'RAIN 20%',
  factsOf(live.mount).PRECIPITATION);
// Same forecast object shape, harder rain.
live.push({
  trackTempC: 22, ambientTempC: 21, rainIntensity: 0.8, trackWetness: 0.4,
  trackCondition: 'WET', forecast: FIXED_FORECAST,
});
check('it follows the intensity up while the forecast stands still',
  factsOf(live.mount).PRECIPITATION === 'RAIN 80%', factsOf(live.mount).PRECIPITATION);

/* ----------------------------- 7. the palette ---------------------------- */

console.log('\nthe glyphs are painted, not left to inherit');
check('the sun has its own colour', /\.wx-sun\s*\{[^}]*fill:\s*var\(--sky-sun\)/.test(css));
check('the rays are the same colour as the sun',
  /\.wx-ray\s*\{[^}]*stroke:\s*var\(--sky-sun\)/.test(css));
check('a cloud with weather in it is painted heavier',
  /\.wx-cloud\s*\{[^}]*fill:\s*var\(--sky-cloud\)/.test(css));
check('a fair-weather cloud is painted lighter',
  /\.wx-cloud-fair\s*\{[^}]*fill:\s*var\(--sky-cloud-fair\)/.test(css));
['--sky-sun', '--sky-cloud', '--sky-cloud-fair', '--sky-drop'].forEach((tok) => {
  check('theme.css defines ' + tok, new RegExp(tok.replace(/-/g, '\\-') + ':').test(theme));
});
// The sun must not borrow the caution amber: --warn means "something is wrong"
// everywhere else in the overlay, and a sunny forecast is not a warning. The
// storm bolt is the one deliberate exception.
check('the sun does not borrow the caution colour',
  !/\.wx-sun\s*\{[^}]*var\(--warn\)/.test(css));
check('every glyph shape carries a class', !/wx-(sun|ray|cloud|cloud-fair|wet|bolt)="/.test(widgetSrc));

/* -------------------------------- summary -------------------------------- */

console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
