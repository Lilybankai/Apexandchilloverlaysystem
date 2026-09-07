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
 * Three things are pinned, each of which broke or nearly broke while this was
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

/** Mount the widget on a fresh root and drive one frame through it. */
function render(weather) {
  const root = makeEl('section');
  const header = makeEl('span');
  header.setAttribute('data-role', 'track-state');
  const mount = makeEl('div');
  mount.setAttribute('data-role', 'mount');
  root.appendChild(header);
  root.appendChild(mount);
  widget.init(root);
  widget.update({ weather }, ctx);
  return { root, mount };
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

/* -------------------------------- summary -------------------------------- */

console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
