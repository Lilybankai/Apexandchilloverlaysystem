#!/usr/bin/env node
/**
 * scripts/test-speedo-designs.js — the eleven canvas designs actually draw.
 * -----------------------------------------------------------------------------
 * speedo-gt3.js (ten LMGT3 per-car plates + the shared kit) and speedo-real.js
 * (the machined Apex repaint) are canvas designs: a bake() that paints the
 * static plate and a live() that paints the values. Their failure mode is the
 * worst kind — a single missing null-guard or misspelled context method throws
 * inside a rAF-adjacent paint, and the widget goes black while every build
 * step reports success.
 *
 * So every design here is INITIALISED against a stub DOM and DRIVEN twice:
 * once with a fully populated frame, once with an EMPTY one. The empty pass is
 * the contract test — a design must render dashes, never throw, when the feed
 * has no answer (the LMP2 rule: nothing is invented).
 *
 * The full pass is the other half of that contract, and it is the one that was
 * missing. A plate whose box is drawn, labelled, and wired to nothing does not
 * throw and does not look broken in a screenshot — it renders a tidy "—" for
 * ever, and the only way to notice is to know what the box was meant to say.
 * So the stub canvas RECORDS every fillText, and a design that emits a single
 * dash while the frame carries every channel this kit can read fails here.
 * That is what caught the Aston's TC SLIP knob and the BMW's SLIP tile.
 *
 * The wiring half checks the two registries that must agree (WIDGET_MODES and
 * the catalog designs list — the dropdown draws one, the validator trusts the
 * other), the CSS that parks the core canvas per design, and the script
 * includes on both pages that carry the widget.
 *
 * Run: node scripts/test-speedo-designs.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0;
let failed = 0;

/** Every string any design has painted since the last reset. See the header. */
const TEXTS = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

/* ----------------------------- canvas stub ------------------------------ */

function ctx2d() {
  const grad = { addColorStop() {} };
  const noop = () => {};
  return {
    canvas: { width: 1600, height: 900 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left',
    textBaseline: 'alphabetic', globalAlpha: 1, globalCompositeOperation: 'source-over',
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0, lineCap: 'butt',
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arcTo: noop,
    arc: noop, rect: noop, quadraticCurveTo: noop, fill: noop, stroke: noop,
    clip: noop, save: noop, restore: noop, translate: noop, scale: noop,
    rotate: noop, setTransform: noop, clearRect: noop, fillRect: noop,
    strokeRect: noop, drawImage: noop,
    // Recorded, not discarded: the dash sweep below reads this back.
    fillText: (t) => {
      TEXTS.push(String(t));
    },
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => '#000',
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
}

/**
 * The in-game layer's `transform: scale()` on the widget, as the stub models it.
 *
 * A transform changes what getBoundingClientRect() reports and leaves the layout
 * box (clientWidth/offsetWidth) alone. That gap is the entire subject of the
 * sizing test below, so the stub has to reproduce it rather than report one
 * number for both — which is what let the n-squared bug through the first time.
 */
let SCALE = 1;

function makeCanvas() {
  const c = {
    width: 0, height: 0, style: {}, className: '',
    getContext: () => ctx2d(),
    // The layout box follows the CSS width the widget writes; the on-screen box
    // is that, scaled — the relationship raster.js exists to recover.
    get offsetWidth() {
      return parseFloat(c.style.width) || 0;
    },
    getBoundingClientRect: () => ({
      width: c.offsetWidth * SCALE,
      height: (parseFloat(c.style.height) || 0) * SCALE,
    }),
  };
  return c;
}

/* The stage's LAYOUT box is fixed at the design size; only its on-screen
   rectangle grows with the widget's scale. */
const stage = {
  clientWidth: 800,
  clientHeight: 450,
  getBoundingClientRect: () => ({ width: 800 * SCALE, height: 450 * SCALE }),
};
const mount = {
  innerHTML: '',
  last: null,
  appendChild(c) {
    mount.last = c;
  },
};
const rootEl = {
  querySelector: (sel) =>
    sel === '[data-role="stage"]' ? stage : sel === '[data-role="cluster"]' ? mount : null,
};

/* ------------------------------- sandbox --------------------------------- */

const sandbox = {
  window: {
    devicePixelRatio: 1,
    addEventListener() {},
    ApexSpeedo: {
      revFraction: (rpm, max) =>
        typeof rpm === 'number' && typeof max === 'number' && max > 0
          ? Math.max(0, Math.min(1, rpm / max))
          : 0,
      revStage: (f) => (f >= 0.94 ? 'shift' : f >= 0.85 ? 'red' : f >= 0.7 ? 'amber' : 'low'),
    },
    ApexOverlay: {
      playerLapsCompleted: (frame) =>
        frame && frame.player && typeof frame.player.lapsCompleted === 'number'
          ? frame.player.lapsCompleted
          : -1,
    },
  },
  document: { createElement: () => makeCanvas() },
  Math,
  getComputedStyle: () => ({ getPropertyValue: () => '1' }),
  ResizeObserver: class {
    observe() {}
  },
  console,
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
// raster.js first, exactly as the pages load it: the kit sizes its bitmap
// through ApexRaster.backingScale(), and a stub without it would quietly
// exercise the fallback instead of the code that ships.
vm.runInContext(read('overlay', 'js', 'raster.js'), sandbox, { filename: 'raster.js' });
vm.runInContext(read('overlay', 'js', 'widgets', 'speedo-gt3.js'), sandbox, { filename: 'speedo-gt3.js' });
vm.runInContext(read('overlay', 'js', 'widgets', 'speedo-real.js'), sandbox, { filename: 'speedo-real.js' });

const designs = sandbox.window.ApexSpeedoDesigns || {};
const kit = sandbox.window.ApexDashKit;

const IDS = ['real', 'p911', 'aston', 'm4', 'z06', 'f296', 'mstg', 'lambo', 'rcf', 'm720', 'amg'];

console.log('\nregistration');
check('the kit is exported', !!kit);
IDS.forEach(function (id) {
  const d = designs[id];
  check(
    `design '${id}' registered with init + update`,
    !!d && typeof d.init === 'function' && typeof d.update === 'function',
  );
});

/* ------------------------------ fmt + frames ----------------------------- */

const UNKNOWN = -1e9;
const fmt = {
  has: (v) => typeof v === 'number' && isFinite(v) && v !== UNKNOWN,
  lapTime: (s) => {
    const m = Math.floor(s / 60);
    return m + ':' + (s - m * 60).toFixed(3).padStart(6, '0');
  },
  gearLabel: (g) => (g === 0 ? 'N' : g === -1 ? 'R' : typeof g === 'number' ? String(g) : '—'),
  speedValue: (k) => k,
  speedUnitLabel: () => 'kph',
  tempValue: (c) => (typeof c === 'number' && c !== UNKNOWN ? c : null),
  tempUnitLabel: () => '°C',
};
const wctx = { fmt, crit() {} };

/*
 * The FULL frame is the yardstick for the dash sweep, so it has to carry EVERY
 * channel the kit can read — including the ones only a Hypercar publishes
 * (the ARBs) and the ones that live outside `player` (pedals, motion). A gap
 * here is a gap in the sweep: the fixture is what defines "the feed carries
 * everything", and a channel missing from it can never be caught missing from
 * a plate. `airTempC` sat here for exactly that reason — the fixture agreed
 * with the widget and both disagreed with WeatherState.
 */
const corner = { tempC: 86, pressureKpa: 170, surfaceTempC: 90, brakeTempC: 412 };
const FULL = {
  connected: true,
  session: { name: 'RACE' },
  player: {
    gear: 3, rpm: 6200, maxRpm: 8000, speedKph: 167, position: 12, lapsCompleted: 24,
    lap: { last: 83.456, best: 82.901, current: 21.4, delta: -0.12 },
    paceDeltas: { lapTimeSec: 83.1 },
    tyres: { frontLeft: corner, frontRight: corner, rearLeft: corner, rearRight: corner },
    pedals: { throttle: 0.62, brake: 0.14, clutch: 0, steer: -0.2, tc: 0.05, abs: 0 },
    motion: { latG: 1.42, lonG: -0.3, vertG: 0, slipAngle: 1.1 },
    pit: { limiterOn: true },
  },
  fuel: { levelLiters: 51.2, perLapAvgLiters: 2.29, lapsRemaining: 22.3, virtualEnergyPct: 51, virtualEnergyPerLapPct: 2.2 },
  mfd: {
    aids: [
      { key: 'tc', label: 'TC', value: 6, minValue: 0, maxValue: 11, text: '6' },
      { key: 'tcSlip', label: 'TC Slip', value: 8, minValue: 0, maxValue: 11, text: '8' },
      { key: 'tcCut', label: 'TC Cut', value: 4, minValue: 0, maxValue: 11, text: '4' },
      { key: 'abs', label: 'ABS', value: 3, minValue: 0, maxValue: 11, text: '3' },
      { key: 'motorMap', label: 'Map', value: 1, minValue: 0, maxValue: 9, text: '1' },
      { key: 'frontARB', label: 'Front ARB', value: 5, minValue: 0, maxValue: 9, text: '5' },
      { key: 'rearARB', label: 'Rear ARB', value: 2, minValue: 0, maxValue: 9, text: '2' },
      { key: 'VM_BRAKE_BALANCE', label: 'Brake Bias', value: 12, minValue: 0, maxValue: 60, text: '52.5:47.5' },
    ],
  },
  weather: { trackTempC: 35, ambientTempC: 24, trackCondition: 'DRY' },
};
/* keys must match findAid's exact-match contract */
FULL.mfd.aids.push({ key: 'BRAKE_BIAS', label: 'Brake Bias', value: 12, minValue: 0, maxValue: 60, text: '52.5:47.5' });

console.log('\nthe kit reads the frame, and survives its absence');
{
  const v = kit.pull(FULL, wctx);
  check('gear read', v.gear === '3', v.gear);
  check('speed read + rounded', v.speed === 167, v.speed);
  check('rev fraction computed', Math.abs(v.revFrac - 0.775) < 0.001, v.revFrac);
  check('last lap formatted', v.last === '1:23.456', v.last);
  check('delta signed', v.deltaStr === '-0.12', v.deltaStr);
  check('bias front percentage extracted', v.bias === '52.5', v.bias);
  check('tyre corner read', v.fl.p === 170 && v.fl.t === 86);
  check('brake disc temp rides with the corner', v.fl.b === 412, v.fl.b);
  check('laps via the shared helper', v.laps === 24, v.laps);
  // The three TC settings are three channels. Reading the map into a SLIP box
  // is invisible on screen — the box shows A number — so it is pinned here.
  check(
    'the TC family stays three separate settings',
    v.tc.value === 6 && v.tcSlip.value === 8 && v.tcCut.value === 4,
    [v.tc.value, v.tcSlip.value, v.tcCut.value].join('/'),
  );
  check('the ARBs are read when the car publishes them', v.arbF.value === 5 && v.arbR.value === 2);
  // WeatherState calls it `ambientTempC`; `airTempC` is a FORECAST slot field.
  // Reading the wrong one made every AIR box a permanent dash. The field is
  // `airT` rather than `airC` since v0.91.0: the view model converts to the
  // driver's unit, so nothing Celsius reaches the plates. In °C — the default,
  // and what this fixture runs — the number is unchanged.
  check('air temp comes off WeatherState.ambientTempC', v.airT === 24, v.airT);
  check('track condition is the sim\'s own wording', v.trackState === 'DRY', v.trackState);
  check('pedal channels arrive as whole percent', v.throttle === 62 && v.brakePct === 14, v.throttle + '/' + v.brakePct);
  check('lateral G is carried for the plates that print it', v.latG === 1.42, v.latG);
  check('the rev ceiling is carried for the plates that print a ladder', v.maxRpm === 8000, v.maxRpm);
}
{
  const v = kit.pull(null, wctx);
  check('null frame: gear falls to dash', v.gear === '—', v.gear);
  check('null frame: numbers are null, not NaN', v.speed === null && v.rpm === null && v.fuelL === null);
  check('null frame: tyres are null pairs', v.fl.p === null && v.rr.t === null);
  check('null frame: no aids', v.tc === null && v.bias === null);
  check(
    'null frame: no inputs, no motion, no weather wording',
    v.throttle === null && v.brakePct === null && v.latG === null && v.trackState === null,
  );
}
{
  check('biasText: non-ratio wording passes through', kit.biasText({ text: '9 (Understeer)', value: 9 }) === '9 (Understeer)');
  check('biasText: null aid stays null', kit.biasText(null) === null);
}

console.log('\nevery design draws — full frame AND empty frame');
IDS.forEach(function (id) {
  const d = designs[id];
  if (!d) {
    check(`'${id}' drawable`, false, 'not registered');
    return;
  }
  let err = null;
  try {
    d.init(rootEl, wctx);
    d.update(FULL, wctx);
    d.update({}, wctx);
    d.update(null, wctx);
  } catch (e) {
    err = e;
  }
  check(`'${id}' bakes and draws without throwing`, !err, err ? err.message : undefined);
});

/* ----------------------------- the dash sweep ---------------------------- */
/*
 * Given a frame that carries everything, no plate may paint a dash.
 *
 * This is the test the ten plates shipped without, and every miss it would
 * have caught was of one kind: a box drawn and labelled in bake(), with the
 * matching slot in live() left as a `null` placeholder or pointed at the wrong
 * channel. On screen that is a tidy "—" that looks like the feed being honest,
 * which is why it survived a live check in Chrome against the simulator.
 *
 * A design that genuinely cannot fill a box on ANY feed should not draw the
 * box (the rule at the top of speedo-gt3.js) — so "no dashes on a full frame"
 * is the same statement as that rule, made checkable.
 */
console.log('\nno plate paints a dash when the feed carries everything');
IDS.forEach(function (id) {
  const d = designs[id];
  if (!d) {
    check(`'${id}' dash-free on a full frame`, false, 'not registered');
    return;
  }
  TEXTS.length = 0;
  d.init(rootEl, wctx);
  d.update(FULL, wctx);
  const dashes = TEXTS.filter((t) => t.indexOf('—') >= 0);
  check(
    `'${id}' dash-free on a full frame`,
    dashes.length === 0,
    dashes.length ? dashes.join(' | ') : 'all slots resolved',
  );
});

/* The mirror image: with nothing on the feed, a plate must say nothing — not
   guess, not hold the last value, not print a zero it made up. */
console.log('\nand every plate falls to dashes when the feed carries nothing');
IDS.forEach(function (id) {
  const d = designs[id];
  if (!d) return;
  TEXTS.length = 0;
  d.init(rootEl, wctx);
  d.update({}, wctx);
  check(`'${id}' shows dashes on an empty frame`, TEXTS.some((t) => t.indexOf('—') >= 0));
});

/* --------------------------- sizing under scale --------------------------- */
/*
 * The regression this pins: the kit used to letterbox itself from the stage's
 * getBoundingClientRect(), which is the POST-transform box. The in-game layer
 * scales each widget with transform: scale(n), so that fed n back in a second
 * time — the canvas was laid out n times too big and the transform then
 * magnified it again, giving n squared (4x at scale 2), with the stage's
 * overflow:hidden cutting off the rest. It surfaced on drag RELEASE, because a
 * transform is not a layout change and nothing rebaked until ingame.js nudged a
 * resize event through.
 *
 * So: the CSS box comes from the LAYOUT box and takes the scale exactly once.
 * The BITMAP is the opposite case — it does not re-rasterise under a transform,
 * so it must follow the scale, which is what raster.js is for.
 */
console.log('\nthe canvas letterbox takes the widget scale exactly once');
{
  const d = designs.p911;

  SCALE = 1;
  d.init(rootEl, wctx);
  d.update(FULL, wctx);
  const one = mount.last;
  check(
    'at 1x the CSS box is the design box',
    one.style.width === '800px' && one.style.height === '450px',
    one.style.width + ' x ' + one.style.height,
  );
  check('at 1x the bitmap is 1:1', one.width === 800 && one.height === 450, one.width + ' x ' + one.height);

  SCALE = 2;
  d.init(rootEl, wctx);
  d.update(FULL, wctx);
  const two = mount.last;
  check(
    'at 2x the CSS box is UNCHANGED — the transform does the growing',
    two.style.width === '800px' && two.style.height === '450px',
    two.style.width + ' x ' + two.style.height,
  );
  check(
    'at 2x the bitmap doubles — a canvas does not re-rasterise under a transform',
    two.width === 1600 && two.height === 900,
    two.width + ' x ' + two.height,
  );

  SCALE = 1;
}

console.log('\nthe real design keeps the Apex geometry');
{
  const R = sandbox.window.ApexSpeedoReal;
  check('exports the design box', R && R.DESIGN.w === 1000 && R.DESIGN.h === 470);
  check(
    'notch profile matches the cluster (rim 194, tip 148, depth 52)',
    R && R.NOTCH.rimHalf === 194 && R.NOTCH.tipHalf === 148 && R.NOTCH.depth === 52,
  );
  const pts = R.buildGroove(false);
  let monotonic = true;
  for (let i = 1; i < pts.length; i++) if (!(pts[i].len > pts[i - 1].len)) monotonic = false;
  check('groove lengths are strictly increasing (fraction → stroke works)', monotonic, pts.length + ' pts');
  const m = R.buildGroove(true);
  check('mirrored groove is the same length', Math.abs(m[m.length - 1].len - pts[pts.length - 1].len) < 0.01);
}

console.log('\nwiring');
const main = read('electron', 'main.js');
const css = read('overlay', 'css', 'overlay.css');
const ingame = read('overlay', 'ingame.html');
const widget = read('overlay', 'widget.html');

const modesM = /speedo: \[([^\]]+)\]/.exec(main);
const modeIds = modesM ? modesM[1].match(/'([a-z0-9]+)'/g).map((s) => s.slice(1, -1)) : [];
check(
  'WIDGET_MODES.speedo carries every design (apex + lmp2 + the eleven)',
  ['apex', 'lmp2'].concat(IDS).every((id) => modeIds.includes(id)),
  modeIds.join(','),
);
const catalogIds = (main.match(/\{ id: '([a-z0-9]+)', label: '[^']*' \}/g) || [])
  .map((s) => /id: '([a-z0-9]+)'/.exec(s)[1]);
check(
  'the catalog designs dropdown lists the same ids',
  IDS.every((id) => catalogIds.includes(id)),
  IDS.filter((id) => !catalogIds.includes(id)).join(',') || 'all present',
);
check(
  'the two registries agree exactly (drift here = dropdown options the validator rejects)',
  modeIds.filter((id) => id !== 'apex' && id !== 'lmp2' && !['stack', 'row'].includes(id)).every((id) => catalogIds.includes(id)),
);

IDS.forEach(function (id) {
  check(
    `css parks the core canvas for '${id}'`,
    new RegExp('\\.speedo\\[data-design="' + id + '"\\] \\.speedo__bg').test(css),
  );
});
check('css gives the GT3 plates their 800/450 box', /aspect-ratio: 800 \/ 450/.test(css));

[['ingame.html', ingame], ['widget.html', widget]].forEach(function (p2) {
  const gt3 = p2[1].indexOf('speedo-gt3.js');
  const real = p2[1].indexOf('speedo-real.js');
  const core = p2[1].indexOf('widgets/speedo.js');
  check(
    `${p2[0]} loads both design files before speedo.js`,
    gt3 > -1 && real > -1 && core > -1 && gt3 < core && real < core,
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
