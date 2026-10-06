/**
 * scripts/test-overlay-centre.js — the per-widget "Reset position" button.
 * -----------------------------------------------------------------------------
 * Each card on the Overlays screen carries a button that sends that one in-game
 * widget back to the middle of the MAIN screen — for the widget that has gone
 * missing after a monitor was unplugged, or a resolution or Windows Scale %
 * changed, and is now drawn where no screen shows it.
 *
 * The whole risk is coordinate spaces. The layer is one window spanning every
 * monitor, so its origin is a screen to the left (or above) on a multi-monitor
 * rig, and on a mixed-scaling desktop its pixels are not any one display's DIP.
 * Layout is stored relative to the PRIMARY display's top-left, which is what
 * makes "the middle of the main screen" a sum with no window origin in it — and
 * what these tests prove, by carrying each answer all the way out to a desktop
 * pixel and checking it is the primary's centre.
 *
 * Three pieces, pinned here because they live in different processes:
 *   1. centreOnPrimary — the maths (electron/overlay-geometry.js);
 *   2. centredLayoutEntry — what main saves when it cannot see the widget;
 *   3. centreItem in overlay/js/ingame.js — the page's re-centre on the size
 *      it actually drew, which must agree with (1) because it is a copy of it.
 *
 * No test framework in this repo — plain node, run with
 * `npm run test:overlaycentre`. ingame.js is a browser-side IIFE, so it is
 * evaluated against a minimal DOM stub (same approach as test-ingame-layout.js).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  overlayGeometryFrom,
  centreOnPrimary,
  centredLayoutEntry,
  CENTRE_GUESS,
} = require('../electron/overlay-geometry');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const eq = (name, got, want) =>
  check(name, got === want, got === want ? '' : 'got ' + got + ', want ' + want);

/**
 * A layout x/y carried out to the desktop pixel it is drawn at: the window's
 * origin, plus the pad the page adds (applyItem), plus the stored value.
 */
const desktopX = (g, x) => g.bounds.x + g.screens.padX + x;
const desktopY = (g, y) => g.bounds.y + g.screens.padY + y;

/* -------------------------------------------------------------------------- */
/*  1. centreOnPrimary                                                         */
/* -------------------------------------------------------------------------- */

console.log('\ncentreOnPrimary — one monitor');

{
  const g = overlayGeometryFrom(
    [{ x: 0, y: 0, width: 1920, height: 1080 }],
    { x: 0, y: 0, width: 1920, height: 1080 },
  );
  const at = centreOnPrimary(g.screens, { width: 400, height: 240 });
  eq('single: x is half the room left over', at.x, 760);
  eq('single: y is half the room left over', at.y, 420);
  eq('single: widget centre is the screen centre (x)', desktopX(g, at.x) + 200, 960);
  eq('single: widget centre is the screen centre (y)', desktopY(g, at.y) + 120, 540);
}

{
  // Odd leftovers round rather than leaving half-pixels in the stored layout,
  // which normalizeLayoutEntry would round anyway.
  const at = centreOnPrimary({ primary: { width: 1920, height: 1080 } }, { width: 301, height: 201 });
  eq('odd sizes: x is a whole pixel', Number.isInteger(at.x), true);
  eq('odd sizes: y is a whole pixel', Number.isInteger(at.y), true);
}

console.log('\ncentreOnPrimary — a screen left of / above the main one');

{
  // The case the button exists for: a secondary on the LEFT, so the layer's
  // window starts at x = -1920 and the page draws everything 1920px further
  // right than it is stored. The stored answer must not carry that offset — the
  // page adds it — and the drawn widget must still land on the primary.
  const g = overlayGeometryFrom(
    [
      { x: -1920, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ],
    { x: 0, y: 0, width: 1920, height: 1080 },
  );
  eq('left secondary: the layer origin is negative', g.bounds.x, -1920);
  eq('left secondary: padX is the screen to the left', g.screens.padX, 1920);
  const at = centreOnPrimary(g.screens, { width: 400, height: 240 });
  eq('left secondary: stored x is primary-relative (no window origin in it)', at.x, 760);
  eq('left secondary: CSS left the page will set', at.x + g.screens.padX, 2680);
  eq('left secondary: drawn centre is the PRIMARY centre', desktopX(g, at.x) + 200, 960);
}

{
  // Triples without Surround, and a 1440p primary between 1080p sides: the
  // primary's own size decides, not the 6400px desktop.
  const g = overlayGeometryFrom(
    [
      { x: -1920, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 2560, height: 1440 },
      { x: 2560, y: 0, width: 1920, height: 1080 },
    ],
    { x: 0, y: 0, width: 2560, height: 1440 },
  );
  const at = centreOnPrimary(g.screens, { width: 560, height: 800 });
  eq('staggered triple: centred on the 2560 primary, not the desktop', at.x, 1000);
  eq('staggered triple: centred on the 1440 primary height', at.y, 320);
  eq('staggered triple: drawn centre is the primary centre', desktopX(g, at.x) + 280, 1280);
}

{
  // A screen stacked ABOVE: the y axis gets the same treatment through padY.
  const g = overlayGeometryFrom(
    [
      { x: 0, y: -1200, width: 1920, height: 1200 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ],
    { x: 0, y: 0, width: 1920, height: 1080 },
  );
  const at = centreOnPrimary(g.screens, { width: 400, height: 240 });
  eq('stacked above: stored y is primary-relative', at.y, 420);
  eq('stacked above: drawn centre is the primary centre', desktopY(g, at.y) + 120, 540);
}

{
  // Primary NOT at the desktop origin in the space the rects were measured in
  // (physical pixels on Windows can do this; DIP never does, but the maths must
  // not care). Everything is relative to the primary's own top-left.
  const g = overlayGeometryFrom(
    [
      { x: 1000, y: 500, width: 1920, height: 1080 },
      { x: -920, y: 500, width: 1920, height: 1080 },
    ],
    { x: 1000, y: 500, width: 1920, height: 1080 },
  );
  const at = centreOnPrimary(g.screens, { width: 400, height: 240 });
  eq('primary off origin: stored x unchanged', at.x, 760);
  eq('primary off origin: drawn x centre is the primary centre', desktopX(g, at.x) + 200, 1000 + 960);
  eq('primary off origin: drawn y centre is the primary centre', desktopY(g, at.y) + 120, 500 + 540);
}

{
  // MIXED SCALING (see mixed-display-scaling in the project notes): a 1080p
  // screen above a 4K one at 150%, with the window given the 4K's 150%. The
  // primary arrives in the WINDOW's pixels — 2560×1440 — which is what the page
  // measures widgets in, so centring there is centring on the panel.
  const toWindow = (scale) => (r) => {
    const x = Math.round(r.x / scale);
    const y = Math.round(r.y / scale);
    return {
      x,
      y,
      width: Math.round((r.x + r.width) / scale) - x,
      height: Math.round((r.y + r.height) / scale) - y,
    };
  };
  const g = overlayGeometryFrom(
    [
      { x: 0, y: -1080, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 3840, height: 2160 },
    ],
    { x: 0, y: 0, width: 3840, height: 2160 },
    toWindow(1.5),
  );
  eq('mixed @150%: primary in window pixels', g.screens.primary.width, 2560);
  const at = centreOnPrimary(g.screens, { width: 400, height: 240 });
  eq('mixed @150%: x centred in window pixels', at.x, 1080);
  eq('mixed @150%: y centred in window pixels', at.y, 600);
  // Out to the physical panel: (layout + window origin + pad) × scale.
  eq(
    'mixed @150%: physical centre is the 4K panel centre',
    (desktopY(g, at.y) + 120) * 1.5,
    1080,
  );
}

console.log('\ncentreOnPrimary — bigger than the screen');

{
  const s = { primary: { width: 1920, height: 1080 } };
  const both = centreOnPrimary(s, { width: 2500, height: 1300 });
  eq('too big both ways: pinned to primary left', both.x, 0);
  eq('too big both ways: pinned to primary top', both.y, 0);
  const tall = centreOnPrimary(s, { width: 400, height: 1300 });
  eq('too tall only: still centred across', tall.x, 760);
  eq('too tall only: pinned to the top', tall.y, 0);
  const g = overlayGeometryFrom(
    [
      { x: -1920, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ],
    { x: 0, y: 0, width: 1920, height: 1080 },
  );
  const left = centreOnPrimary(g.screens, { width: 2500, height: 1300 });
  eq(
    'too big, left secondary: top-left is the PRIMARY top-left, not the desktop',
    desktopX(g, left.x),
    0,
  );
}

{
  // Junk in, a usable position out — this runs from a button press, and a throw
  // would leave the widget exactly as lost as it was.
  const a = centreOnPrimary(null, { width: 400, height: 240 });
  eq('no geometry: x pinned at 0', a.x, 0);
  eq('no geometry: y pinned at 0', a.y, 0);
  const b = centreOnPrimary({ primary: { width: 1920, height: 1080 } }, null);
  eq('no box: the screen centre', b.x, 960);
}

/* -------------------------------------------------------------------------- */
/*  2. centredLayoutEntry — what main saves                                    */
/* -------------------------------------------------------------------------- */

console.log('\ncentredLayoutEntry — main, which cannot see the widget');

{
  const screens = { primary: { width: 1920, height: 1080 } };
  const fresh = centredLayoutEntry(screens, undefined);
  eq('never placed: centred on the guess (x)', fresh.x, (1920 - CENTRE_GUESS.width) / 2);
  eq('never placed: centred on the guess (y)', fresh.y, (1080 - CENTRE_GUESS.height) / 2);
  eq('never placed: scale 1', fresh.scale, 1);
  eq('never placed: no width invented', 'w' in fresh, false);
  eq('never placed: no height invented', 'h' in fresh, false);

  // Lost on a screen that is no longer there, stretched and scaled by the
  // operator. Only the position was lost: the size stays theirs.
  const lost = centredLayoutEntry(screens, { x: -2400, y: 3000, scale: 1.5, w: 500, h: 300 });
  eq('lost widget: keeps its scale', lost.scale, 1.5);
  eq('lost widget: keeps its width', lost.w, 500);
  eq('lost widget: keeps its height', lost.h, 300);
  eq('lost widget: centred on its SCALED width', lost.x, (1920 - 750) / 2);
  eq('lost widget: centred on its SCALED height', lost.y, (1080 - 450) / 2);

  const huge = centredLayoutEntry(screens, { x: 9000, y: 9000, scale: 3, w: 1200 });
  eq('scaled past the screen: pinned left', huge.x, 0);
  check('scaled past the screen: still within the primary vertically', huge.y >= 0 && huge.y < 1080);
}

/* -------------------------------------------------------------------------- */
/*  3. The page — centreItem in overlay/js/ingame.js                           */
/* -------------------------------------------------------------------------- */

/** The smallest DOM ingame.js will load against; it never paints here. */
function makeElement(tag, size) {
  const set = new Set();
  return {
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    style: {},
    children: [],
    attrs: {},
    offsetWidth: size ? size.w : 300,
    offsetHeight: size ? size.h : 200,
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
    closest() {
      return null;
    },
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    },
  };
}

/**
 * Load ingame.js with one widget per entry in `sizes` ({id: {w, h}}), the app
 * bridge reporting `screens` and `saved`. Returns the elements, the captured
 * centre callback and whatever the page last saved.
 */
function loadLayer({ screens, saved, sizes }) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'js', 'ingame.js'), 'utf8');
  const items = Object.keys(sizes).map((id) => {
    const el = makeElement('div', sizes[id]);
    el.setAttribute('data-id', id);
    return el;
  });
  const byId = {};
  for (const id of ['ig-toolbar', 'ig-done', 'ig-reset', 'ig-interact-hint', 'ig-interact-done', 'ig-screens']) {
    byId[id] = makeElement('div');
  }
  const state = { saved: null, centre: null };
  const bridge = {
    getLayout: () => Promise.resolve(saved || {}),
    saveLayout: (l) => {
      state.saved = JSON.parse(JSON.stringify(l));
      return Promise.resolve();
    },
    getScreens: () => Promise.resolve(screens),
    onScreens: () => {},
    onEdit: () => {},
    onInteract: () => {},
    onLayoutReset: () => {},
    onLayoutCentre: (cb) => {
      state.centre = cb;
    },
    editDone: () => {},
    interactStop: () => {},
  };
  const sandbox = {
    document: {
      body: makeElement('body'),
      getElementById: (id) => byId[id] || null,
      querySelectorAll: (sel) => (sel === '.ig-item' ? items : []),
      createElement: (t) => makeElement(t),
      addEventListener: () => {},
    },
    window: { innerWidth: 1920, innerHeight: 1080, apexIngame: bridge, dispatchEvent: () => {} },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    Object,
    Array,
    JSON,
    isFinite,
    console,
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const item = (id) => items.find((el) => el.getAttribute('data-id') === id);
  return { item, state };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const waitSave = () => new Promise((r) => setTimeout(r, 320));

async function run() {
  console.log('\ningame.js — centreItem');

  const LEFT = overlayGeometryFrom(
    [
      { x: -1920, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ],
    { x: 0, y: 0, width: 1920, height: 1080 },
  );

  {
    // A tester's standings tower stranded on the left monitor he has since
    // unplugged — main's guess arrives, and the page redoes it on the 300×200
    // box it actually drew, at the operator's scale of 2.
    const saved = { standings: { x: -1500, y: 200, scale: 2 } };
    const layer = loadLayer({ screens: LEFT.screens, saved, sizes: { standings: { w: 300, h: 200 } } });
    await settle();
    check('page: the bridge offers the centre hook', typeof layer.state.centre === 'function');
    const entry = centredLayoutEntry(LEFT.screens, saved.standings);
    layer.state.centre({ id: 'standings', entry });
    const want = centreOnPrimary(LEFT.screens, { width: 600, height: 400 });
    const el = layer.item('standings');
    eq('page: CSS left is the measured centre plus padX', parseFloat(el.style.left), want.x + 1920);
    eq('page: CSS top is the measured centre', parseFloat(el.style.top), want.y);
    eq('page: drawn centre is the primary centre', -1920 + parseFloat(el.style.left) + 300, 960);
    eq('page: scale kept', el.style.transform, 'scale(2)');
    await waitSave();
    check('page: saved through the drag path', !!(layer.state.saved && layer.state.saved.standings));
    eq('page: saved x agrees with centreOnPrimary', layer.state.saved.standings.x, want.x);
    eq('page: saved y agrees with centreOnPrimary', layer.state.saved.standings.y, want.y);
  }

  {
    // Bigger than the screen when drawn: pinned to the primary's top-left.
    const layer = loadLayer({
      screens: LEFT.screens,
      saved: {},
      sizes: { chat: { w: 1200, h: 900 } },
    });
    await settle();
    layer.state.centre({ id: 'chat', entry: { x: 0, y: 0, scale: 2 } });
    const el = layer.item('chat');
    eq('page, too big: CSS left is the primary left edge', parseFloat(el.style.left), 1920);
    eq('page, too big: CSS top is the primary top edge', parseFloat(el.style.top), 0);
  }

  {
    // A widget that is NOT on this layer (switched off in game). The page has
    // nothing to measure, but it must still adopt main's entry: it holds every
    // widget's placement and saves all of them on the next drag, so keeping the
    // old one would write the lost position straight back.
    const saved = { standings: { x: 24, y: 24, scale: 1 }, tyres: { x: -3000, y: 50, scale: 1 } };
    const layer = loadLayer({ screens: LEFT.screens, saved, sizes: { standings: { w: 300, h: 200 } } });
    await settle();
    layer.state.centre({ id: 'tyres', entry: { x: 760, y: 420, scale: 1 } });
    // Any later save — a drag of another widget — carries the whole layout.
    layer.state.centre({ id: 'standings', entry: { x: 24, y: 24, scale: 1 } });
    await waitSave();
    eq('page, widget not on layer: next save carries main\'s x', layer.state.saved.tyres.x, 760);
    eq('page, widget not on layer: next save carries main\'s y', layer.state.saved.tyres.y, 420);
  }

  {
    // A widget on the layer but not laid out yet (0×0): keep main's centring
    // rather than "centring" a zero box onto the screen's exact middle.
    const layer = loadLayer({ screens: LEFT.screens, saved: {}, sizes: { delta: { w: 0, h: 0 } } });
    await settle();
    layer.state.centre({ id: 'delta', entry: { x: 700, y: 400, scale: 1 } });
    const el = layer.item('delta');
    eq('page, unmeasured widget: main\'s x stands', parseFloat(el.style.left), 700 + 1920);
    eq('page, unmeasured widget: main\'s y stands', parseFloat(el.style.top), 400);
  }

  {
    // Junk from the wire is ignored, not thrown on.
    const layer = loadLayer({ screens: LEFT.screens, saved: {}, sizes: { delta: { w: 300, h: 100 } } });
    await settle();
    let threw = false;
    try {
      layer.state.centre({ id: 'delta', entry: { x: NaN, y: 0 } });
      layer.state.centre({ id: 'delta' });
    } catch (e) {
      threw = true;
    }
    eq('page, junk entry: no throw', threw, false);
  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
