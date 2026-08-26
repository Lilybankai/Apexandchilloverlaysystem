/**
 * scripts/bench-widgets.js — overlay widget inventory + update cost.
 * -----------------------------------------------------------------------------
 * Two halves:
 *
 *   1. Static inventory. Every overlay/js/widgets/*.js is read for its
 *      `throttleMs` and whether it allocates a <canvas>. This is how we tell
 *      whether the original "only pedals runs at 30 Hz" rule still holds.
 *
 *   2. Timed update(). Widgets that can be mounted against the same kind of
 *      DOM stub scripts/test-standings.js uses are driven with a 12-car frame
 *      and a 62-car frame. Canvas drawing is stubbed — this is JS / DOM-reconcile
 *      cost, not GPU fill-rate. GPU compositing of a transparent Electron
 *      window over the sim is the other half of the stutter and cannot be
 *      measured from Node.
 *
 * Run: node scripts/bench-widgets.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  ROOT,
  DEFAULT_HZ,
  timeMany,
  fmtMs,
  printTable,
  heading,
  loadSimulator,
  expandField,
} = require('./lib/bench-util');

const WIDGET_DIR = path.join(ROOT, 'overlay', 'js', 'widgets');

/** Catalog defaults from electron/main.js — HUD on, control pages off. */
const INGAME_OFF_BY_DEFAULT = new Set(['fuelplan', 'mfd', 'chat']);

const ORIGINALLY_FULL_RATE = ['pedals'];

function inventory() {
  const files = fs.readdirSync(WIDGET_DIR).filter((f) => f.endsWith('.js'));
  const widgets = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(WIDGET_DIR, file), 'utf8');
    const idMatch = /registerWidget\(\s*["']([^"']+)["']/.exec(src);
    if (!idMatch) continue; // speedo-lmp2 is a design, not a widget
    const id = idMatch[1];
    const throttleMatch = /throttleMs\s*:\s*(\d+)/.exec(src);
    const throttleMs = throttleMatch ? Number(throttleMatch[1]) : 0;
    const canvas = /createElement\(\s*["']canvas["']\s*\)/.test(src) || /getContext\(\s*["']2d["']/.test(src);
    // Full-rate widgets follow the connection, not a baked-in 30. Inventory
    // prints the default; dispatchLoad() substitutes the rate under test.
    const updatesPerSec = throttleMs === 0 ? DEFAULT_HZ : 1000 / throttleMs;
    widgets.push({
      id,
      file,
      throttleMs,
      canvas,
      updatesPerSec,
      fullRate: throttleMs === 0,
      ingameDefault: !INGAME_OFF_BY_DEFAULT.has(id),
    });
  }
  widgets.sort((a, b) => a.throttleMs - b.throttleMs || a.id.localeCompare(b.id));
  return widgets;
}

function dispatchLoad(widgets, hz) {
  let full = 0;
  let throttled = 0;
  let canvasFull = 0;
  for (const w of widgets) {
    if (!w.ingameDefault) continue;
    if (w.fullRate) {
      full += 1;
      if (w.canvas) canvasFull += 1;
    } else {
      throttled += hz / (1000 / w.throttleMs > hz ? hz : 1000 / w.throttleMs);
    }
  }
  // updates per second across the default in-game set
  let ups = 0;
  let canvasUps = 0;
  for (const w of widgets) {
    if (!w.ingameDefault) continue;
    const rate = w.fullRate ? hz : Math.min(hz, w.updatesPerSec);
    ups += rate;
    if (w.canvas) canvasUps += rate;
  }
  return { full, canvasFull, ups, canvasUps };
}

/* ------------------------------ DOM stub ----------------------------- */

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    _innerHTML: '',
    hidden: false,
    title: '',
    src: '',
    width: tag === 'canvas' ? 300 : 0,
    height: tag === 'canvas' ? 90 : 0,
    clientWidth: tag === 'canvas' ? 300 : 280,
    clientHeight: tag === 'canvas' ? 90 : 140,
    children: [],
    attrs: {},
    parentNode: null,
    style: { setProperty() {}, removeProperty() {}, cssText: '', display: '', width: '', height: '' },
    dataset: {},
    appendChild(c) {
      if (!c) return c;
      if (c.parentNode && c.parentNode !== this) {
        const i = c.parentNode.children.indexOf(c);
        if (i >= 0) c.parentNode.children.splice(i, 1);
      } else if (c.parentNode === this) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
      }
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    },
    insertBefore(c, ref) {
      if (c && c.parentNode) {
        const i = c.parentNode.children.indexOf(c);
        if (i >= 0) c.parentNode.children.splice(i, 1);
      }
      c.parentNode = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx >= 0) this.children.splice(idx, 0, c);
      else this.children.push(c);
      return c;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'class') this.className = String(v);
    },
    getAttribute(k) {
      if (k === 'class') return this.className;
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    hasAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k);
    },
    getBoundingClientRect() {
      return { width: this.clientWidth, height: this.clientHeight, top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight };
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) {
      return find(this, sel);
    },
    querySelectorAll(sel) {
      const out = [];
      walk(this, (e) => {
        if (e !== this && matches(e, sel)) out.push(e);
      });
      return out;
    },
    getContext(kind) {
      if (kind !== '2d') return null;
      return makeCtx(this);
    },
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
      toggle() {},
    },
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(v) {
      this._innerHTML = String(v);
      if (v === '' || v == null) {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
      }
    },
  };
  return el;
}

function makeCtx(canvas) {
  const noop = () => {};
  const grad = { addColorStop: noop };
  return {
    canvas,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '',
    textAlign: '',
    textBaseline: '',
    lineCap: '',
    lineJoin: '',
    shadowBlur: 0,
    shadowColor: '',
    miterLimit: 0,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    clearRect: noop,
    strokeRect: noop,
    fillText: noop,
    strokeText: noop,
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    setTransform: noop,
    resetTransform: noop,
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    measureText: (t) => ({ width: String(t).length * 7 }),
    setLineDash: noop,
    getLineDash: () => [],
    arc: noop,
    arcTo: noop,
    ellipse: noop,
    rect: noop,
    roundRect: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    clip: noop,
    drawImage: noop,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray((w || 1) * (h || 1) * 4), width: w || 1, height: h || 1 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData: noop,
  };
}

function matches(el, sel) {
  if (!sel) return false;
  const role = /\[data-role="([^"]+)"\]/.exec(sel);
  if (role) return el.attrs && el.attrs['data-role'] === role[1];
  if (sel[0] === '.') return (el.className || '').split(/\s+/).includes(sel.slice(1));
  if (sel[0] === '#') return el.attrs && el.attrs.id === sel.slice(1);
  if (/^[a-zA-Z][\w-]*$/.test(sel)) return el.tagName === sel.toUpperCase();
  return false;
}

function find(root, sel) {
  let hit = null;
  walk(root, (e) => {
    if (!hit && e !== root && matches(e, sel)) hit = e;
  });
  return hit;
}

function walk(el, fn) {
  fn(el);
  for (const c of el.children) walk(c, fn);
}

function makeSandbox(onRegister) {
  const document = {
    createElement: makeElement,
    createElementNS: (_ns, tag) => makeElement(tag),
    querySelector: () => null,
    addEventListener() {},
  };
  const window = {
    location: { search: '' },
    devicePixelRatio: 1,
    ApexOverlay: {
      registerWidget: (id, def) => onRegister(id, def),
      classColor: () => '#6cf',
      classAbbrev: (c) => String(c || '').slice(0, 3),
      classLabel: (c) => String(c || ''),
      sessionStrip: () => () => {},
      sessionLabel: () => 'RACE',
      sessionLength: () => '',
      playerLapsCompleted: () => 4,
      driverBadgeLabel: (b) => b || '',
      applyRankBadge() {},
    },
    ApexAppearance: {
      onStandings() {},
      onSpeedUnit() {},
      onRadarIcons() {},
    },
    ApexRaster: { backingScale: () => 1 },
    ApexSpeedoDesigns: {},
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => (cb(0), 0),
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  window.window = window;
  window.document = document;
  const sandbox = {
    console,
    document,
    window,
    location: window.location,
    URLSearchParams,
    Date,
    Math,
    JSON,
    Set,
    Map,
    WeakMap,
    Array,
    Object,
    Number,
    String,
    Boolean,
    isFinite,
    parseInt,
    parseFloat,
    Infinity,
    NaN,
    undefined,
    Float32Array,
    Uint8ClampedArray,
    Int32Array,
    performance: { now: () => Date.now() },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: () => Promise.reject(new Error('no network in bench')),
    ResizeObserver: function ResizeObserver() {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    Path2D: function Path2D() {},
    Image: function Image() {
      this.src = '';
      this.onload = null;
    },
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

function mountWidget(id) {
  const srcPath = path.join(WIDGET_DIR, `${id}.js`);
  if (!fs.existsSync(srcPath)) throw new Error(`no widget file for ${id}`);
  const src = fs.readFileSync(srcPath, 'utf8');
  let def = null;
  const sandbox = makeSandbox((_id, d) => {
    def = d;
  });
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: `${id}.js` });
  if (!def) throw new Error(`${id}.js registered no widget`);

  const root = makeElement('section');
  const gear = makeElement('span');
  gear.setAttribute('data-role', 'gear');
  const mount = makeElement('div');
  mount.setAttribute('data-role', 'mount');
  const header = makeElement('div');
  header.setAttribute('data-role', 'header');
  root.appendChild(gear);
  root.appendChild(mount);
  root.appendChild(header);
  // Extra common roles so widgets that query them do not throw.
  for (const role of [
    'last', 'best', 'current', 'delta', 'alert', 'body', 'rows',
    'canvas', 'trace', 'bars', 'strip',
  ]) {
    const el = makeElement('div');
    el.setAttribute('data-role', role);
    root.appendChild(el);
  }

  const ctx = {
    fmt: {
      has: (v) => typeof v === 'number' && v > -1,
      gap: (v) => (typeof v === 'number' ? `+${v.toFixed(3)}` : '—'),
      relGap: (v) => (typeof v === 'number' ? v.toFixed(1) : '—'),
      intVal: (v) => (typeof v === 'number' ? String(Math.round(v)) : '—'),
      lapTime: (v) => (typeof v === 'number' && v > 0 ? v.toFixed(3) : '—'),
      delta: (v) => (typeof v === 'number' ? v.toFixed(3) : '—'),
      temp: (v) => (typeof v === 'number' ? `${Math.round(v)}°` : '—'),
      temp1: (v) => (typeof v === 'number' ? `${v.toFixed(1)}°` : '—'),
      tempSpan: (d) => d,
      tempValue: (v) => (typeof v === 'number' ? v : null),
      tempUnitLabel: () => '°C',
      liters: (v) => (typeof v === 'number' ? v.toFixed(1) : '—'),
      pct: (v) => (typeof v === 'number' ? Math.round(v * 100) : 0),
      gearLabel: (g) => (g === 0 ? 'N' : g < 0 ? 'R' : String(g)),
      speedValue: (k) => (typeof k === 'number' ? String(Math.round(k)) : '—'),
      speedUnitLabel: () => 'km/h',
      speed: (k) => (typeof k === 'number' ? `${Math.round(k)} km/h` : '—'),
    },
    crit: (_el, text) => {
      if (_el) _el.textContent = text;
    },
    critHtml() {},
    critAttr() {},
    critPulse() {},
    sessionLabel: () => 'RACE',
    sessionLength: () => '6:00:00',
    classColor: () => '#6cf',
    classAbbrev: (c) => String(c || '').slice(0, 3),
    classLabel: (c) => String(c || ''),
    driverBadgeLabel: (b) => b || '',
    applyRankBadge() {},
    consequenceMs: 0,
    consequenceFresh: () => false,
    servedFresh: () => false,
    penaltyCount: (tl) => (tl && typeof tl.penalties === 'number' ? tl.penalties : 0),
    penaltyText: () => '',
    penaltyLabel: () => '',
  };

  def.init(root, ctx);
  return {
    update: (frame) => def.update(frame, ctx),
    throttleMs: def.throttleMs || 0,
  };
}

const TIMEABLE = ['standings', 'relative', 'pedals', 'pedalsv', 'radar', 'trackmap', 'limits', 'delta'];

function timeWidgets(baseFrame) {
  const frames = {
    12: expandField(baseFrame, 12),
    62: expandField(baseFrame, 62, { padRadar: true }),
  };
  const rows = [];
  for (const id of TIMEABLE) {
    let widget;
    try {
      widget = mountWidget(id);
    } catch (err) {
      rows.push({ id, ok: false, error: err.message });
      continue;
    }
    const entry = { id, ok: true, throttleMs: widget.throttleMs, byCars: {} };
    for (const n of [12, 62]) {
      const frame = frames[n];
      try {
        widget.update(frame);
        const { stats } = timeMany(() => widget.update(frame), 80, 10);
        entry.byCars[n] = stats;
      } catch (err) {
        entry.byCars[n] = { error: err.message };
      }
    }
    rows.push(entry);
  }
  return rows;
}

function run(opts) {
  const quiet = opts && opts.quiet;
  const widgets = inventory();
  const load30 = dispatchLoad(widgets, 30);
  const load60 = dispatchLoad(widgets, 60);
  const fullRate = widgets.filter((w) => w.fullRate).map((w) => w.id);

  let timed = [];
  let timedError = null;
  try {
    const provider = loadSimulator();
    provider.start();
    let frame = null;
    let t = 1_000_000;
    for (let i = 0; i < 80; i++) {
      t += 1000 / 30;
      frame = provider.poll(t, 1000 / 30);
    }
    provider.stop();
    timed = timeWidgets(frame);
  } catch (err) {
    timedError = err.message;
  }

  const result = { widgets, load30, load60, fullRate, originally: ORIGINALLY_FULL_RATE, timed, timedError };
  if (!quiet) print(result);
  return result;
}

function print(result) {
  heading('4. Widget inventory (from source, not a guess)');
  printTable(
    [
      { key: 'id', label: 'widget' },
      { key: 'ms', label: 'throttleMs', align: 'right' },
      { key: 'hz', label: 'updates/s', align: 'right' },
      { key: 'kind', label: 'draw' },
      { key: 'ig', label: 'in-game default' },
    ],
    result.widgets.map((w) => ({
      id: w.id,
      ms: String(w.throttleMs),
      hz: w.updatesPerSec.toFixed(1),
      kind: w.canvas ? 'canvas' : 'DOM',
      ig: w.ingameDefault ? 'on' : 'off',
    })),
  );

  const added = result.fullRate.filter((id) => !result.originally.includes(id));
  console.log(
    `\n  Original full-rate set (ARCHITECTURE.md):  ${result.originally.join(', ')}` +
      `\n  Current full-rate set:                    ${result.fullRate.join(', ')}` +
      `\n  Added at 30 Hz since that rule was written: ${added.length ? added.join(', ') : '(none)'}`,
  );
  console.log(
    `\n  Default in-game layer @ 30 Hz: ${result.load30.full} full-rate widgets` +
      ` (${result.load30.canvasFull} canvas),` +
      `\n  ~${result.load30.ups.toFixed(0)} widget updates/s` +
      ` of which ~${result.load30.canvasUps.toFixed(0)} are canvas redraws.` +
      `\n  Same layer @ 60 Hz: ~${result.load60.ups.toFixed(0)} updates/s,` +
      ` ~${result.load60.canvasUps.toFixed(0)} canvas redraws.`,
  );

  heading('5. Widget update() cost (JS only — canvas GPU is not in this number)');
  if (result.timedError) {
    console.log(`  skipped: ${result.timedError}`);
    return;
  }
  printTable(
    [
      { key: 'id', label: 'widget' },
      { key: 'ok', label: '' },
      { key: 'c12', label: '12-car mean', align: 'right' },
      { key: 'c62', label: '62-car mean', align: 'right' },
      { key: 'c62p99', label: '62-car p99', align: 'right' },
    ],
    result.timed.map((t) => {
      if (!t.ok) {
        return { id: t.id, ok: 'skip', c12: t.error, c62: '', c62p99: '' };
      }
      const a = t.byCars[12];
      const b = t.byCars[62];
      return {
        id: t.id,
        ok: 'ok',
        c12: a && !a.error ? fmtMs(a.mean) : (a && a.error) || '—',
        c62: b && !b.error ? fmtMs(b.mean) : (b && b.error) || '—',
        c62p99: b && !b.error ? fmtMs(b.p99) : '',
      };
    }),
  );
  console.log(
    `\n  Standings / trackmap grow with the grid. Pedals / radar / delta do not` +
      `\n  (radar is range-capped; pedals are four channels). A stutter that` +
      `\n  tracks field size is the tower or the map, not the pedal widget.`,
  );
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('[bench-widgets] failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

module.exports = { run, inventory };
