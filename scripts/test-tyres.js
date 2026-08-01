/**
 * scripts/test-tyres.js — the tyre widget's operating-window lamp + tyre map.
 * -----------------------------------------------------------------------------
 * Two claims are worth pinning down here, because both are the kind that look
 * right on screen while being wrong.
 *
 * **The lamp must go dark when the sim publishes no optimum.** The window it
 * judges against is read from LMU (`optimalCompoundConditions`, per compound and
 * per event — 92 °C for the GT3 medium this was built against, 50 °C for the
 * wet). Nothing else publishes it: spectating a car, or running rF2 rather than
 * LMU, means there is no optimum to judge against. A lamp that defaulted to some
 * baked-in window would then light up green — confidently, and for a window the
 * fitted compound may not have. Dark is the honest answer, and it is one `||`
 * away from being wrong forever.
 *
 * **The tread bands must be oriented to the car, not to the sim's array.** The
 * sim publishes three temperatures per wheel in a fixed car-space direction —
 * its own REST tyre screen names them left/centre/right — so index 0 is the
 * OUTER shoulder on the left of the car and the INNER shoulder on the right.
 * The providers flip it per side so `innerC` always means the shoulder toward
 * the car's centreline. This test covers the widget's half of that contract: it
 * renders inner→centre→outer left-to-right and never re-derives the order, so
 * the two tyres on one axle mirror each other exactly as they do on the car.
 *
 * No test framework in this repo — plain node, run with `npm run test:tyres`.
 * The widget is a browser-side IIFE, so it is evaluated here against a minimal
 * DOM stub rather than imported.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* -------------------------------------------------------------------------- */
/*  A DOM small enough to run the widget, big enough to see what it wrote      */
/* -------------------------------------------------------------------------- */

function makeElement(tag) {
  const el = {
    tagName: tag,
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    title: '',
    style: {},
    children: [],
    attrs: {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelector(sel) { return findByRole(this, sel); },
    classList: {
      add() {}, remove() {}, contains() { return false; }, toggle() {},
    },
  };
  return el;
}

/** Depth-first `[data-role="x"]` lookup, the only selector the widget uses. */
function findByRole(root, sel) {
  const m = /\[data-role="([^"]+)"\]/.exec(sel);
  if (!m) return null;
  const want = m[1];
  const walk = (el) => {
    if (el.attrs && el.attrs['data-role'] === want) return el;
    for (const c of el.children) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/** Everything with the given class, in document order. */
function collect(root, className) {
  const out = [];
  const walk = (el) => {
    if (el.className === className) out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

/** The `fmt` helpers the widget takes from the shared runtime. */
const fmt = {
  has: (v) => typeof v === 'number' && v > -1,
  tempC1: (c) => (typeof c === 'number' && c > -1 ? c.toFixed(1) + '°' : '—'),
};

/**
 * Load the widget, mount it, and hand back a driver.
 *
 * `search` pins the view through the same `?tyres=` param an OBS source would
 * use, which is also the only way to select a view from outside the app.
 */
function mount(search) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'overlay', 'js', 'widgets', 'tyres.js'), 'utf8');
  let widget = null;
  const sandbox = {
    console,
    document: { createElement: makeElement },
    window: {
      location: { search },
      ApexOverlay: { registerWidget: (_id, w) => { widget = w; } },
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.URLSearchParams = URLSearchParams;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'tyres.js' });
  if (!widget) throw new Error('tyres.js registered no widget');

  const root = makeElement('div');
  const compound = makeElement('div');
  compound.setAttribute('data-role', 'compound');
  const mountEl = makeElement('div');
  mountEl.setAttribute('data-role', 'mount');
  root.appendChild(compound);
  root.appendChild(mountEl);
  widget.init(root);

  return {
    root,
    update: (tyres) => widget.update({ player: { tyres } }, { fmt }),
    leds: () => collect(root, 'tyre__led'),
    segs: () => collect(root, 'tyre__seg'),
    strips: () => collect(root, 'tyre__strip'),
    primaries: () => collect(root, 'tyre__wear is-crit'),
  };
}

/** One corner. `over` replaces any field; omit `optimalTempC` to drop it. */
const corner = (over) => Object.assign({
  tempC: 90, coreC: 89, surfaceTempC: 96,
  innerC: 93, middleC: 90, outerC: 87,
  surfaceInnerC: 104, surfaceMiddleC: 96, surfaceOuterC: 88,
  wear: 0.8, compound: 'Medium', optimalTempC: 92,
}, over);

/** A full set, with per-corner overrides. */
const set = (fl, fr, rl, rr) => ({
  frontLeft: corner(fl), frontRight: corner(fr),
  rearLeft: corner(rl), rearRight: corner(rr),
});

/* -------------------------------------------------------------------------- */

console.log('1) The lamp reports the tyre against the sim\'s own optimum');
{
  const w = mount('?tyres=map');
  // Optimum 92: in-window is ±8, near is ±16, beyond that is cold/overheating.
  w.update(set(
    { tempC: 90 },   // 2° under  → in the window
    { tempC: 78 },   // 14° under → on its way in
    { tempC: 103 },  // 11° over  → on its way out
    { tempC: 114 },  // 22° over  → overheating
  ));
  const lamps = w.leds().map((l) => l.getAttribute('data-lamp'));
  check('a tyre at temperature reads ok', lamps[0] === 'ok', lamps[0]);
  check('one still warming reads cold', lamps[1] === 'cold', lamps[1]);
  check('one going away reads hot', lamps[2] === 'hot', lamps[2]);
  check('one well over reads burning', lamps[3] === 'burning', lamps[3]);

  // The edges, because ±8 is the whole definition of "in the window".
  w.update(set({ tempC: 84 }, { tempC: 100 }, { tempC: 83.9 }, { tempC: 100.1 }));
  const edge = w.leds().map((l) => l.getAttribute('data-lamp'));
  check('exactly 8° under is still in', edge[0] === 'ok', edge[0]);
  check('exactly 8° over is still in', edge[1] === 'ok', edge[1]);
  check('a tenth beyond is not', edge[2] === 'cold' && edge[3] === 'hot', edge[2] + '/' + edge[3]);
}

console.log('\n2) With no published optimum the lamp says nothing');
{
  const w = mount('?tyres=map');
  // Spectating, or any sim that does not publish a window. The temperature is
  // perfectly good — it is the VERDICT that has no basis.
  w.update(set(
    { optimalTempC: undefined },
    { optimalTempC: undefined },
    { optimalTempC: undefined },
    { optimalTempC: undefined },
  ));
  const lamps = w.leds().map((l) => l.getAttribute('data-lamp'));
  check('every lamp is dark', lamps.every((l) => l === 'unknown'), lamps.join(','));
  check('and says why', /No optimal temperature/.test(w.leds()[0].title), w.leds()[0].title);

  // A corner with no temperature cannot be judged either, optimum or not.
  const w2 = mount('?tyres=map');
  w2.update(set({ tempC: -1 }, {}, {}, {}));
  check('nor can a corner with no reading', w2.leds()[0].getAttribute('data-lamp') === 'unknown',
    w2.leds()[0].getAttribute('data-lamp'));
  check('while the others still report', w2.leds()[1].getAttribute('data-lamp') === 'ok',
    w2.leds()[1].getAttribute('data-lamp'));
}

console.log('\n3) The map draws the tread inner → centre → outer, as given');
{
  const w = mount('?tyres=map');
  w.update(set({}, {}, {}, {}));
  check('the strip is shown', w.strips().every((s) => s.hidden === false), '');
  const segs = w.segs().slice(0, 3).map((s) => s.textContent);
  // Surface bands are preferred over the liner: they spread far wider across
  // the tread, which is the entire point of drawing a gradient.
  check('it reads the SURFACE bands', segs.join(' ') === '104° 96° 88°', segs.join(' '));
  check('each band is coloured', w.segs().slice(0, 3).every((s) => /^hsl\(/.test(s.style.background)),
    w.segs()[0].style.background);
  // Hotter must be redder: hue runs 210° (blue) down to 0° (red), so the inner
  // shoulder at 104° must carry a LOWER hue than the outer at 88°.
  const hue = (s) => Number(/^hsl\((\d+)/.exec(s.style.background)[1]);
  check('hotter is redder', hue(w.segs()[0]) < hue(w.segs()[2]),
    hue(w.segs()[0]) + ' < ' + hue(w.segs()[2]));
  check('the big line is the core temp', w.primaries()[0].textContent === '89.0°',
    w.primaries()[0].textContent);
}

console.log('\n4) A tyre map with nothing to draw draws nothing');
{
  const w = mount('?tyres=map');
  // Spectating: wear comes from the pit screen but no temperature channel
  // exists, so there is no spread to render.
  w.update(set(
    { surfaceInnerC: undefined, surfaceMiddleC: undefined, surfaceOuterC: undefined,
      innerC: undefined, middleC: undefined, outerC: undefined },
    {}, {}, {},
  ));
  const segs = w.segs().slice(0, 3);
  check('the bands read as unknown', segs.every((s) => s.textContent === '—'),
    segs.map((s) => s.textContent).join(','));
  check('and carry no colour', segs.every((s) => !s.style.background), '');

  // Liner bands stand in when the surface triplet is the missing one.
  const w2 = mount('?tyres=map');
  w2.update(set(
    { surfaceInnerC: undefined, surfaceMiddleC: undefined, surfaceOuterC: undefined },
    {}, {}, {},
  ));
  const fallback = w2.segs().slice(0, 3).map((s) => s.textContent);
  check('the liner stands in for a missing surface', fallback.join(' ') === '93° 90° 87°',
    fallback.join(' '));
}

console.log('\n5) The other views keep working, and keep their lamp');
{
  for (const [view, expect] of [['temp', '90.0°'], ['surface', '96.0°'], ['tread', '80%']]) {
    const w = mount('?tyres=' + view);
    w.update(set({}, {}, {}, {}));
    check(view + ' shows its own reading', w.primaries()[0].textContent === expect,
      w.primaries()[0].textContent);
    check(view + ' hides the tyre map', w.strips()[0].hidden === true, String(w.strips()[0].hidden));
    // The verdict is about the tyre, not about which number is on screen.
    check(view + ' still lights the lamp', w.leds()[0].getAttribute('data-lamp') === 'ok',
      w.leds()[0].getAttribute('data-lamp'));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
