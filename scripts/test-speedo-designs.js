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
    strokeRect: noop, fillText: noop, drawImage: noop,
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => '#000',
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
}

function makeCanvas() {
  return {
    width: 0, height: 0, style: {}, className: '',
    getContext: () => ctx2d(),
  };
}

const stage = {
  getBoundingClientRect: () => ({ width: 800, height: 450 }),
};
const mount = {
  innerHTML: '',
  appendChild() {},
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
  getComputedStyle: () => ({ getPropertyValue: () => '1' }),
  ResizeObserver: class {
    observe() {}
  },
  console,
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
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
};
const wctx = { fmt, crit() {} };

const corner = { tempC: 86, pressureKpa: 170, surfaceTempC: 90 };
const FULL = {
  connected: true,
  session: { name: 'RACE' },
  player: {
    gear: 3, rpm: 6200, maxRpm: 8000, speedKph: 167, position: 12, lapsCompleted: 24,
    lap: { last: 83.456, best: 82.901, current: 21.4, delta: -0.12 },
    paceDeltas: { lapTimeSec: 83.1 },
    tyres: { frontLeft: corner, frontRight: corner, rearLeft: corner, rearRight: corner },
    pit: { limiterOn: false },
  },
  fuel: { levelLiters: 51.2, perLapAvgLiters: 2.29, lapsRemaining: 22.3, virtualEnergyPct: 51, virtualEnergyPerLapPct: 2.2 },
  mfd: {
    aids: [
      { key: 'tc', label: 'TC', value: 6, minValue: 0, maxValue: 11, text: '6' },
      { key: 'tcCut', label: 'TC Cut', value: 4, minValue: 0, maxValue: 11, text: '4' },
      { key: 'abs', label: 'ABS', value: 3, minValue: 0, maxValue: 11, text: '3' },
      { key: 'motorMap', label: 'Map', value: 1, minValue: 0, maxValue: 9, text: '1' },
      { key: 'VM_BRAKE_BALANCE', label: 'Brake Bias', value: 12, minValue: 0, maxValue: 60, text: '52.5:47.5' },
    ],
  },
  weather: { trackTempC: 35, airTempC: 24 },
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
  check('laps via the shared helper', v.laps === 24, v.laps);
}
{
  const v = kit.pull(null, wctx);
  check('null frame: gear falls to dash', v.gear === '—', v.gear);
  check('null frame: numbers are null, not NaN', v.speed === null && v.rpm === null && v.fuelL === null);
  check('null frame: tyres are null pairs', v.fl.p === null && v.rr.t === null);
  check('null frame: no aids', v.tc === null && v.bias === null);
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
