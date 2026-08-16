/**
 * scripts/test-ingame-layout.js — the in-game layer across multiple monitors.
 * -----------------------------------------------------------------------------
 * The layer's window spans the whole desktop rather than the primary display, so
 * a triple-screen rig that is NOT running NVIDIA Surround — three separate
 * displays as far as Windows is concerned — can have the delta on the right-hand
 * screen and the tyres on the left. Under Surround the three panels arrive as
 * one wide display and none of this engages; that is why the bug only ever
 * showed up on the rigs without it.
 *
 * Two halves are pinned here, because they have to agree and they live in
 * different processes:
 *
 *   1. electron/overlay-geometry.js — the window's bounds and the geometry
 *      handed to the page, over monitor arrangements nobody on this project
 *      owns: a primary display that is not the leftmost, a portrait side screen,
 *      three panels of different heights.
 *   2. overlay/js/ingame.js — the placement, clamping and rescue maths that
 *      consumes it.
 *
 * THE INVARIANT THAT MATTERS MOST is the first group: on a single monitor every
 * number this change introduced must collapse to what it was, and on a triple
 * rig an ALREADY-SAVED layout must land on the same physical pixel it did
 * before. Layout coordinates are measured from the primary display for exactly
 * that reason — desktop coordinates would have moved every existing tester's
 * widgets one screen to the left on upgrade, silently, with no way back but
 * Reset layout. There is no migration step to get wrong because there is no
 * migration; these tests are what says so.
 *
 * No test framework in this repo — plain node, run with `npm run test:ingame`.
 * ingame.js is a browser-side IIFE, so it is evaluated against a minimal DOM
 * stub rather than imported (same approach as test-carclass-ui.js).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { overlayGeometryFrom } = require('../electron/overlay-geometry');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const eq = (name, got, want) =>
  check(name, got === want, got === want ? '' : 'got ' + got + ', want ' + want);

/* -------------------------------------------------------------------------- */
/*  Monitor arrangements                                                       */
/* -------------------------------------------------------------------------- */
/*
 * Windows puts the primary display at (0, 0) and lays the others out around it,
 * so a left-hand screen has a NEGATIVE x. That sign is the whole reason the old
 * code could not cope: every clamp in the layer treated 0 as the left edge of
 * the world.
 */

/** One 1080p monitor — the rig this change must not disturb in any particular. */
const SINGLE = {
  displays: [{ x: 0, y: 0, width: 1920, height: 1080 }],
  primary: { x: 0, y: 0, width: 1920, height: 1080 },
};

/** Surround: three panels presented to Windows as one wide display. */
const SURROUND = {
  displays: [{ x: 0, y: 0, width: 5760, height: 1080 }],
  primary: { x: 0, y: 0, width: 5760, height: 1080 },
};

/** Triples without Surround: three separate 1080p displays, centre primary. */
const TRIPLE = {
  displays: [
    { x: -1920, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 1920, height: 1080 },
  ],
  primary: { x: 0, y: 0, width: 1920, height: 1080 },
};

/**
 * Mixed heights: a 1440p centre screen flanked by 1080p ones sitting at y=0.
 * The union is 1440 tall, so the desktop rectangle contains 360px of dead space
 * under each side screen — space that is inside the window and on no monitor.
 */
const STAGGERED = {
  displays: [
    { x: -1920, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 2560, height: 1440 },
    { x: 2560, y: 0, width: 1920, height: 1080 },
  ],
  primary: { x: 0, y: 0, width: 2560, height: 1440 },
};

/* -------------------------------------------------------------------------- */
/*  1. Window bounds + geometry                                                */
/* -------------------------------------------------------------------------- */

console.log('\noverlayGeometryFrom — window bounds');

{
  const g = overlayGeometryFrom(SINGLE.displays, SINGLE.primary);
  // The old code was literally `screen.getPrimaryDisplay().bounds`. This is the
  // regression guard for every single-monitor user: same window, same origin.
  eq('single: window x', g.bounds.x, 0);
  eq('single: window y', g.bounds.y, 0);
  eq('single: window width', g.bounds.width, 1920);
  eq('single: window height', g.bounds.height, 1080);
  eq('single: padX is 0', g.screens.padX, 0);
  eq('single: padY is 0', g.screens.padY, 0);
  eq('single: one screen rect', g.screens.rects.length, 1);
}

{
  const g = overlayGeometryFrom(SURROUND.displays, SURROUND.primary);
  eq('surround: window width is the whole span', g.bounds.width, 5760);
  eq('surround: padX is 0', g.screens.padX, 0);
  // Surround was already working, and it works because it looks like one screen.
  eq('surround: still one screen rect', g.screens.rects.length, 1);
}

{
  const g = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
  eq('triple: window starts at the left screen', g.bounds.x, -1920);
  eq('triple: window spans all three', g.bounds.width, 5760);
  eq('triple: window height', g.bounds.height, 1080);
  // The offset the page adds to every widget to turn a primary-relative
  // coordinate into a window-relative one.
  eq('triple: padX is the left screen', g.screens.padX, 1920);
  eq('triple: padY is 0', g.screens.padY, 0);
  eq('triple: three screen rects', g.screens.rects.length, 3);
  eq('triple: left screen is negative in layout coords', g.screens.rects[0].x, -1920);
  eq('triple: centre screen is the origin', g.screens.rects[1].x, 0);
  eq('triple: right screen', g.screens.rects[2].x, 1920);
  // Defaults are laid out against this, not against the 5760-wide desktop.
  eq('triple: primary stays 1920 wide', g.screens.primary.width, 1920);
}

{
  const g = overlayGeometryFrom(STAGGERED.displays, STAGGERED.primary);
  eq('staggered: window width', g.bounds.width, 1920 + 2560 + 1920);
  eq('staggered: window height is the tallest', g.bounds.height, 1440);
  eq('staggered: padX', g.screens.padX, 1920);
  eq('staggered: primary is the 1440p screen', g.screens.primary.height, 1440);
}

{
  // A vertical side screen sitting above the primary: padY stops being 0, which
  // is the only case where the Y axis behaves like the X one.
  const g = overlayGeometryFrom(
    [
      { x: 0, y: -1200, width: 1920, height: 1200 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ],
    { x: 0, y: 0, width: 1920, height: 1080 },
  );
  eq('stacked: window top', g.bounds.y, -1200);
  eq('stacked: padY is the screen above', g.screens.padY, 1200);
  eq('stacked: padX still 0', g.screens.padX, 0);
}

{
  // Defensive: Electron has been seen to report a display mid-reconfiguration.
  // Junk must degrade to the primary screen, never to an Infinity-sized window.
  const g = overlayGeometryFrom([], { x: 0, y: 0, width: 1920, height: 1080 });
  eq('empty display list: falls back to primary width', g.bounds.width, 1920);
  eq('empty display list: one rect', g.screens.rects.length, 1);
  const j = overlayGeometryFrom(
    [null, { x: 0, y: 0, width: 0, height: 0 }, { x: NaN, y: 0, width: 100, height: 100 }],
    { x: 0, y: 0, width: 1920, height: 1080 },
  );
  eq('junk displays: window width stays finite', j.bounds.width, 1920);
  eq('junk displays: junk rects dropped', j.screens.rects.length, 1);
}

/* -------------------------------------------------------------------------- */
/*  2. The layer itself                                                        */
/* -------------------------------------------------------------------------- */

/** The smallest DOM ingame.js will load against; it never paints here. */
function makeElement(tag) {
  const el = {
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    style: {},
    children: [],
    attrs: {},
    // Widgets are boxes of a fixed size for the purposes of these tests; a
    // widget's real height comes from its content, which needs a layout engine.
    offsetWidth: 300,
    offsetHeight: 200,
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
      _set: new Set(),
      add(c) {
        this._set.add(c);
      },
      remove(c) {
        this._set.delete(c);
      },
      contains(c) {
        return this._set.has(c);
      },
      toggle(c, on) {
        on ? this._set.add(c) : this._set.delete(c);
      },
    },
  };
  return el;
}

/**
 * Load ingame.js against a stub DOM holding one widget per id, with the app
 * bridge reporting `screens` and `saved`. Returns handles on the pieces the
 * tests drive: the item elements, the document listeners the layer installed
 * (so pointer gestures can be replayed), and whatever it last saved.
 */
function loadLayer({ screens, saved, ids }) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'overlay', 'js', 'ingame.js'),
    'utf8',
  );

  const items = (ids || ['standings']).map((id) => {
    const el = makeElement('div');
    el.setAttribute('data-id', id);
    return el;
  });

  const byId = {
    'ig-toolbar': makeElement('div'),
    'ig-done': makeElement('button'),
    'ig-reset': makeElement('button'),
    'ig-interact-hint': makeElement('div'),
    'ig-interact-done': makeElement('button'),
    'ig-screens': makeElement('div'),
  };

  const listeners = {};
  const state = { savedLayout: null, edit: null, screensCb: null, resizes: 0 };

  const doc = {
    body: makeElement('body'),
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => (sel === '.ig-item' ? items : []),
    createElement: makeElement,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
  };

  const bridge = {
    getLayout: () => Promise.resolve(saved || {}),
    saveLayout: (l) => {
      state.savedLayout = JSON.parse(JSON.stringify(l));
      return Promise.resolve();
    },
    getScreens: () => Promise.resolve(screens),
    onScreens: (cb) => {
      state.screensCb = cb;
    },
    onEdit: (cb) => {
      state.edit = cb;
    },
    onInteract: () => {},
    onLayoutReset: () => {},
    editDone: () => {},
    interactStop: () => {},
  };

  const sandbox = {
    document: doc,
    // Deliberately NOT the desktop size: anything still reading innerWidth
    // instead of the geometry would be laying out against one screen, which is
    // the bug. 1920 makes such a slip show up as a wrong number, not a lucky one.
    // dispatchEvent/Event are how the layer tells the canvas widgets to
    // re-measure after a scale change (nudgeCanvasSizes → overlay/js/raster.js).
    // A transform is not a layout change, so nothing else would tell them.
    window: {
      innerWidth: 1920,
      innerHeight: 1080,
      apexIngame: bridge,
      dispatchEvent: (ev) => {
        if (ev && ev.type === 'resize') state.resizes++;
      },
    },
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
  const left = (id) => parseFloat(item(id).style.left);
  const top = (id) => parseFloat(item(id).style.top);

  return {
    items,
    item,
    left,
    top,
    // Placement in LAYOUT coordinates, read back off the element. Writes to the
    // store are debounced by a quarter-second, so this is what most assertions
    // want; `waitSave` below is for the ones actually testing persistence.
    layoutX: (id) => left(id) - screens.padX,
    layoutY: (id) => top(id) - screens.padY,
    waitSave: () => new Promise((r) => setTimeout(r, 320)),
    byId,
    listeners,
    state,
    setEditing: (on) => state.edit(on),
    /** Replay a press-drag-release on a widget, in window (CSS) pixels. */
    drag(id, fromX, fromY, toX, toY) {
      const el = item(id);
      const target = {
        closest: (sel) => (sel === '.ig-item' ? el : null),
      };
      listeners.pointerdown({ button: 0, target, clientX: fromX, clientY: fromY, preventDefault() {} });
      listeners.pointermove({ clientX: toX, clientY: toY });
      listeners.pointerup({});
    },
  };
}

/** Let the boot promise chain (loadLayout + loadScreens) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function run() {
  console.log('\ningame.js — placement');

  {
    // A layout saved before this change, on the single monitor it was saved on.
    const saved = { standings: { x: 24, y: 24, scale: 1 } };
    const g = overlayGeometryFrom(SINGLE.displays, SINGLE.primary);
    const layer = loadLayer({ screens: g.screens, saved });
    await settle();
    eq('single: widget CSS left is its saved x', layer.left('standings'), 24);
    eq('single: widget CSS top is its saved y', layer.top('standings'), 24);
  }

  {
    // THE MIGRATION-FREE PROOF. Same saved layout, now on a triple rig. The CSS
    // offset changes (the window starts a screen further left), but the physical
    // desktop pixel does not — which is why no existing layout had to be
    // rewritten, and why nobody's widgets move when they update.
    const saved = { standings: { x: 24, y: 24, scale: 1 } };
    const g = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
    const layer = loadLayer({ screens: g.screens, saved });
    await settle();
    eq('triple: CSS left is offset by the left screen', layer.left('standings'), 1920 + 24);
    const desktopX = g.bounds.x + layer.left('standings');
    eq('triple: SAME desktop pixel as before the change', desktopX, 24);
    const desktopY = g.bounds.y + layer.top('standings');
    eq('triple: same desktop pixel vertically', desktopY, 24);
  }

  {
    // Defaults are sized to the primary display. On a triple rig the desktop is
    // 5760 wide, and a right-anchored default computed against THAT would land
    // on the far right monitor — a fresh install would come up scattered over
    // three screens and read as broken.
    const g = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
    const layer = loadLayer({ screens: g.screens, saved: {}, ids: ['relative'] });
    await settle();
    // `relative` defaults to vw - 424, which must be 1920 - 424 = 1496 (on the
    // centre screen), not 5760 - 424.
    eq('triple: default lands on the primary screen', layer.left('relative'), 1920 + 1496);
    const desktopX = g.bounds.x + layer.left('relative');
    check(
      'triple: default is within the primary display',
      desktopX >= 0 && desktopX < 1920,
      'desktop x ' + desktopX,
    );
  }

  console.log('\ningame.js — dragging across screens');

  {
    // The point of the whole exercise: pick a widget up on the centre screen and
    // put it down on the left one. Before this change the clamp pinned x at 0.
    const g = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
    const layer = loadLayer({ screens: g.screens, saved: { standings: { x: 100, y: 100, scale: 1 } } });
    await settle();
    layer.setEditing(true);
    layer.drag('standings', 2100, 200, 600, 200); // 1500px left, onto the left screen
    eq('drag left: x is negative (left screen)', layer.layoutX('standings'), -1400);
    const desktopX = g.bounds.x + layer.left('standings');
    check(
      'drag left: widget is physically on the left monitor',
      desktopX >= -1920 && desktopX < 0,
      'desktop x ' + desktopX,
    );
    // And it survives the save path — a negative coordinate must not be
    // normalised away between the page and the settings file.
    await layer.waitSave();
    eq('drag left: negative x persisted', layer.state.savedLayout.standings.x, -1400);
  }

  {
    // And onto the right-hand screen, which the old clamp also refused.
    const g = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
    const layer = loadLayer({ screens: g.screens, saved: { standings: { x: 100, y: 100, scale: 1 } } });
    await settle();
    layer.setEditing(true);
    layer.drag('standings', 2100, 200, 4100, 200); // 2000px right
    eq('drag right: x is past the primary screen', layer.layoutX('standings'), 2100);
    const desktopX = g.bounds.x + layer.left('standings');
    check(
      'drag right: widget is physically on the right monitor',
      desktopX >= 1920 && desktopX < 3840,
      'desktop x ' + desktopX,
    );
  }

  {
    // The far edges still hold a grabbable sliver, so a widget can never be
    // dragged clean off the desktop and lost.
    const g = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
    const layer = loadLayer({ screens: g.screens, saved: { standings: { x: 0, y: 0, scale: 1 } } });
    await settle();
    layer.setEditing(true);
    layer.drag('standings', 2000, 200, -9000, 200);
    const x = layer.layoutX('standings');
    // Left edge of the desktop is -1920 in layout coords; 40px must remain.
    eq('drag off the left: clamped to a 40px sliver', x, -1920 + 40 - 300);
    check('drag off the left: still on the desktop', x + 300 > -1920, 'x ' + x);
  }

  {
    // Single monitor, same gesture: the clamp is exactly what it always was.
    const g = overlayGeometryFrom(SINGLE.displays, SINGLE.primary);
    const layer = loadLayer({ screens: g.screens, saved: { standings: { x: 0, y: 0, scale: 1 } } });
    await settle();
    layer.setEditing(true);
    layer.drag('standings', 500, 200, -9000, 200);
    eq('single: drag off the left clamps at 40 - width', layer.layoutX('standings'), 40 - 300);
    layer.drag('standings', 100, 200, 9000, 200);
    eq('single: drag off the right clamps at width - 40', layer.layoutX('standings'), 1920 - 40);
  }

  console.log('\ningame.js — rescue from dead space');

  {
    // A staggered rig leaves 360px of dead space under each side screen, inside
    // the window and on no monitor. A widget let go there would be invisible
    // with no handle to drag it back by, so it is pulled onto the nearest screen.
    const g = overlayGeometryFrom(STAGGERED.displays, STAGGERED.primary);
    const layer = loadLayer({ screens: g.screens, saved: { standings: { x: 100, y: 100, scale: 1 } } });
    await settle();
    layer.setEditing(true);
    // Drop it at layout (-1000, 1200): below the left screen, beside the centre
    // one — inside the desktop rectangle, on nothing.
    layer.drag('standings', 1920 + 100, 100, 1920 - 1000, 1200);
    const lx = layer.layoutX('standings');
    const ly = layer.layoutY('standings');
    const onAScreen = g.screens.rects.some(
      (r) => lx < r.x + r.width && lx + 300 > r.x && ly < r.y + r.height && ly + 200 > r.y,
    );
    check('staggered: rescued onto a real screen', onAScreen, 'landed at ' + lx + ',' + ly);
  }

  {
    // The rescue must not fire on a rig with no dead space: a widget deliberately
    // straddling the bezel between two screens stays where it was put.
    const g = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
    const layer = loadLayer({ screens: g.screens, saved: { standings: { x: 0, y: 100, scale: 1 } } });
    await settle();
    layer.setEditing(true);
    // Land it at x = -150: half on the left screen, half on the centre one.
    layer.drag('standings', 1920 + 0, 100, 1920 - 150, 100);
    eq('triple: a deliberate bezel straddle survives', layer.layoutX('standings'), -150);
  }

  console.log('\ningame.js — resizing on a left-hand screen');

  {
    // The left-edge resize cap is measured from the desktop's left edge. Measured
    // from 0 — as it was, when 0 was the only left edge there was — the anchor's
    // own coordinate is negative on a left-hand screen, the cap collapses to the
    // minimum, and the widget can never be widened again.
    const g = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
    const layer = loadLayer({
      screens: g.screens,
      saved: { standings: { x: -1000, y: 100, scale: 1, w: 300 } },
    });
    await settle();
    layer.setEditing(true);
    const el = layer.item('standings');
    const target = {
      closest: (sel) =>
        sel === '.ig-item__handle'
          ? { getAttribute: () => 'width-w' }
          : sel === '.ig-item'
            ? el
            : null,
    };
    // Grab the left edge (CSS x = 1920 - 1000 = 920) and pull it 200px left.
    layer.listeners.pointerdown({
      button: 0,
      target,
      clientX: 920,
      clientY: 150,
      preventDefault() {},
    });
    layer.listeners.pointermove({ clientX: 720, clientY: 150 });
    layer.listeners.pointerup({});
    await layer.waitSave();
    const l = layer.state.savedLayout.standings;
    eq('left screen: widening from the left edge works', l.w, 500);
    eq('left screen: the right edge held still', l.x + l.w, -1000 + 300);
    // Resizing changes how big the widget is DRAWN, and a canvas gets no more
    // pixels from a transform on its own — so the release has to tell the
    // widgets to re-cut their bitmaps, or the drawn ones stay magnified. The
    // track map has no frame-count backstop and would stay soft for the session.
    check(
      'resizing nudges the canvas widgets to re-measure',
      layer.state.resizes > 0,
      layer.state.resizes + ' resize events',
    );
  }

  console.log('\ningame.js — screen outlines');

  {
    const g = overlayGeometryFrom(SINGLE.displays, SINGLE.primary);
    const layer = loadLayer({ screens: g.screens, saved: {} });
    await settle();
    // A one-monitor rig must not gain edit-mode chrome it has no use for.
    eq('single: no screen outlines drawn', layer.byId['ig-screens'].children.length, 0);
  }

  {
    const g = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
    const layer = loadLayer({ screens: g.screens, saved: {} });
    await settle();
    eq('triple: one outline per monitor', layer.byId['ig-screens'].children.length, 3);
    eq(
      'triple: left outline sits at the window edge',
      layer.byId['ig-screens'].children[0].style.left,
      '0px',
    );
    eq(
      'triple: right outline',
      layer.byId['ig-screens'].children[2].style.left,
      3840 + 'px',
    );
  }

  console.log('\ningame.js — desktop changing shape mid-session');

  {
    // A monitor plugged in while the layer is up. Widgets must be re-placed
    // against the new window origin — the CSS offset moves even though the saved
    // coordinate does not — or every one of them jumps a screen.
    const single = overlayGeometryFrom(SINGLE.displays, SINGLE.primary);
    const layer = loadLayer({
      screens: single.screens,
      saved: { standings: { x: 24, y: 24, scale: 1 } },
    });
    await settle();
    eq('before: CSS left on one monitor', layer.left('standings'), 24);
    const triple = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
    layer.state.screensCb(triple.screens);
    eq('after plugging in: CSS left re-offset', layer.left('standings'), 1920 + 24);
    const desktopX = triple.bounds.x + layer.left('standings');
    eq('after plugging in: same physical pixel', desktopX, 24);
    eq('after plugging in: outlines appear', layer.byId['ig-screens'].children.length, 3);
  }

  {
    // Junk geometry over the bridge must not strand the layer with no screens.
    const g = overlayGeometryFrom(TRIPLE.displays, TRIPLE.primary);
    const layer = loadLayer({ screens: g.screens, saved: { standings: { x: 24, y: 24, scale: 1 } } });
    await settle();
    layer.state.screensCb({ width: 0, height: 0 });
    check(
      'junk geometry: falls back rather than throwing',
      Number.isFinite(layer.left('standings')),
      'left ' + layer.item('standings').style.left,
    );
  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
