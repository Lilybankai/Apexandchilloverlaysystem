/**
 * test-showme.js — "Show me" on the map and the charts, the step-through, and
 * the Review Coach tab's beta gate.
 * -----------------------------------------------------------------------------
 * 2026-10-29, the driving coach. Four promises, each of them silent when it
 * breaks:
 *
 *   1. **Nothing changes without marks.** `drawLapMap` / `drawChannels` take
 *      `opts.marks` / `opts.arrows` now; a caller that passes neither (every
 *      caller before the coach) must get call-for-call the same drawing. An
 *      extra stroke would not fail any other test — it would just be there.
 *   2. **Marks land where they say.** At their own x/z when given, on the
 *      lap's line at `d` when not, on the centreline when the lap has no line;
 *      on the right band of the charts (brake on the pedals, apex on speed).
 *      Arrows follow the STUDIED lap's line, and point the way they are told.
 *   3. **Labels do not pile up.** Two drivers' brake marks a few metres apart
 *      plus an arrow between them is the commonest Show me step there is.
 *   4. **The Coach tab is beta.** Review is a stable tab; the sub-tab must not
 *      show to a driver on stable, nor on a build without the coach's IPC.
 *
 * Plus the step-through's own logic (show-me.js), on a small fake DOM.
 *
 * Run: npm run test:showme
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PANEL = path.join(__dirname, '..', 'electron', 'control-panel');
const CHARTS = require(path.join(PANEL, 'review-charts.js'));
const SHOWME = require(path.join(PANEL, 'show-me.js'));
const COACH = require(path.join(PANEL, 'review-coach.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
}

/* -------------------------------------------------------------------------- */
/*  A recording canvas                                                        */
/* -------------------------------------------------------------------------- */

/** Every call, with the style it was made in, so two drawings can be diffed. */
function fakeCanvas(w = 400, h = 300) {
  const calls = [];
  const rec = (name) => function (...args) {
    calls.push([name, ...args.map((a) => (typeof a === 'number' ? Math.round(a * 100) / 100 : a))]);
  };
  const ctx = {
    setTransform() {}, clearRect() {},
    save: rec('save'), restore: rec('restore'), clip: rec('clip'), rect: rec('rect'),
    translate: rec('translate'), drawImage: rec('drawImage'), closePath: rec('closePath'),
    fillRect: rec('fillRect'), strokeRect: rec('strokeRect'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), arc: rec('arc'),
    stroke() { calls.push(['stroke', this.strokeStyle, this.lineWidth]); },
    fill() { calls.push(['fill', this.fillStyle]); },
    fillText(t, x, y) { calls.push(['fillText', String(t), Math.round(x), Math.round(y), this.fillStyle]); },
    strokeText(t, x, y) { calls.push(['strokeText', String(t), Math.round(x), Math.round(y)]); },
    measureText(t) { return { width: String(t).length * 6 }; },
    setLineDash(d) { calls.push(['setLineDash', (d || []).length]); },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    lineCap: '', lineJoin: '', globalAlpha: 1,
  };
  return {
    calls,
    canvas: { width: 0, height: 0, getBoundingClientRect: () => ({ width: w, height: h }), getContext: () => ctx },
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CYAN = '#26bbf4';
const VIOLET = '#8b7dff';
const ADVICE = '#ffb020';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

/** A square circuit, 100 m a side (as test-reviewcharts). */
function squareMap() {
  const points = [];
  for (let i = 0; i < 40; i++) points.push([i * 2.5, 0, 0]);
  for (let i = 0; i < 40; i++) points.push([100, i * 2.5, 0]);
  for (let i = 0; i < 40; i++) points.push([100 - i * 2.5, 100, 0]);
  for (let i = 0; i < 40; i++) points.push([0, 100 - i * 2.5, 0]);
  return { key: 'square-400', name: 'Square', lengthM: 400, halfWidthM: 6, binM: 2.5, points, builtAt: '', revision: 1 };
}

/** The square's centreline position at lap fraction f. */
function onSquare(f, inset = 0) {
  const s = ((f % 1) + 1) % 1 * 400;
  if (s < 100) return [s, inset];
  if (s < 200) return [100 - inset, s - 100];
  if (s < 300) return [300 - s, 100 - inset];
  return [inset, 400 - s];
}

/** A lap's columns; with `line`, it drives the square `inset` m inside the centreline. */
function lap(n, over = {}, line = null) {
  const d = Array.from({ length: n }, (_, i) => i / (n - 1));
  const out = {
    d, t: d.map((v) => v * 100),
    throttle: d.map((v) => (v > 0.2 && v < 0.27 ? 0 : 1)),
    brake: d.map((v) => (v > 0.2 && v < 0.25 ? 0.9 : 0)),
    steer: d.map(() => 0), gear: d.map(() => 4),
    speedKph: d.map((v) => 150 - (v > 0.2 && v < 0.27 ? 60 : 0)),
    latG: d.map(() => 0), lonG: d.map(() => 0), tc: d.map(() => 0), abs: d.map(() => 0),
    lapSec: 100, count: n, truncated: false,
    ...over,
  };
  if (line) {
    out.x = d.map((v) => onSquare(v, line.inset)[0]);
    out.z = d.map((v) => onSquare(v, line.inset)[1]);
  }
  return out;
}

const boxesOverlap = (a, b) => a && b
  && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0
  && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;

/* ========================================================================== */
console.log('drawLapMap — no marks, no change');
/* ========================================================================== */
{
  const road = squareMap();
  const mine = lap(200, {}, { inset: 1 });
  const vs = lap(200, {}, { inset: -1 });
  const base = { mode: 'inputs', vs, lengthM: 400, cursorD: 0.3, cursorIndex: 60, window: [0.15, 0.35] };
  const draw = (o) => {
    const f = fakeCanvas();
    const out = CHARTS.drawLapMap(f.canvas, road, mine, o);
    return { calls: f.calls, out };
  };
  const plain = draw(base);
  const again = draw({ ...base });
  check('the same drawing twice is the same calls (the comparison is fair)', same(plain.calls, again.calls));
  check('without opts.marks / opts.arrows: call-for-call as before',
    same(plain.calls, draw({ ...base, marks: undefined, arrows: undefined }).calls));
  check('empty marks and arrows draw nothing extra',
    same(plain.calls, draw({ ...base, marks: [], arrows: [] }).calls));
  check('marks and arrows outside the window draw nothing extra',
    same(plain.calls, draw({
      ...base,
      marks: [{ d: 0.8, kind: 'brake', who: 'you', label: 'far away' }],
      arrows: [{ fromD: 0.7, toD: 0.75, label: 'not here' }],
    }).calls));
  check('and the result carries no showme key without marks', !('showme' in plain.out));
  // The pace map too, whole-lap, no comparison.
  const f1 = fakeCanvas();
  const f2 = fakeCanvas();
  CHARTS.drawLapMap(f1.canvas, road, mine, {});
  CHARTS.drawLapMap(f2.canvas, road, mine, { marks: [], arrows: [] });
  check('pace, whole lap: unchanged by empty marks', same(f1.calls, f2.calls));
}

/* ========================================================================== */
console.log('drawLapMap — marks and arrows');
/* ========================================================================== */
{
  const road = squareMap();
  const mine = lap(200, {}, { inset: 1 });
  const vs = lap(200, {}, { inset: -1 });
  const marks = [
    { d: 0.2, kind: 'brake', who: 'you', label: 'You brake' },
    { d: 0.215, kind: 'brake', who: 'ref', label: 'L7 brakes' },
    { d: 0.235, kind: 'turnin', who: 'you' },
    { d: 0.25, kind: 'apex', who: 'you', label: 'Apex 92' },
    { d: 0.27, kind: 'throttle', who: 'you' },
    { d: 0.29, kind: 'full', who: 'ref' },
  ];
  const arrows = [{ fromD: 0.2, toD: 0.215, label: 'brake 6 m later' }];
  const f = fakeCanvas();
  const out = CHARTS.drawLapMap(f.canvas, road, mine, {
    mode: 'inputs', vs, lengthM: 400, window: [0.15, 0.35], marks, arrows,
  });
  const sm = out && out.showme;
  check('the result says what it drew', !!sm && sm.marks.length === 6 && sm.arrows.length === 1,
    sm && `${sm.marks.length} marks, ${sm.arrows.length} arrows`);
  const strokes = f.calls.filter((c) => c[0] === 'stroke');
  check('yours are drawn in cyan', strokes.some((c) => c[1] === CYAN));
  check('theirs in violet', strokes.some((c) => c[1] === VIOLET));
  check('the arrow in the advice amber', strokes.some((c) => c[1] === ADVICE));
  check('the apex is a dot', f.calls.some((c) => c[0] === 'arc' && c[3] > 4 && c[3] < 5));
  const texts = f.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  check('every label is written', ['You brake', 'L7 brakes', 'Turn-in', 'Apex 92', 'Throttle', 'Full', 'brake 6 m later']
    .every((t) => texts.includes(t)), texts.join(' | '));
  // Whole-lap scale, map zoom 1: the inputs-mode YOU/VS labels need zoom > 2.5,
  // the coach's labels do not.
  const whole = fakeCanvas();
  const wout = CHARTS.drawLapMap(whole.canvas, road, mine, { mode: 'inputs', vs, lengthM: 400, marks, arrows });
  check('labels show at whole-lap zoom too',
    wout.zoom < 1.05 && wout.showme.marks.every((m) => m.box), `zoom ${wout.zoom}`);

  // Zoomed past 2.5 the inputs-mode bars name themselves YOU / VS; with the
  // coach's labels on the map those give way rather than sit in fragments
  // under them.
  const zoomedIn = (o) => {
    const fz = fakeCanvas();
    const r = CHARTS.drawLapMap(fz.canvas, road, mine, { mode: 'inputs', vs, lengthM: 400, window: [0.18, 0.24], ...o });
    return { zoom: r.zoom, texts: fz.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]) };
  };
  const bare0 = zoomedIn({});
  const marked = zoomedIn({ marks });
  check('zoomed in, the inputs bars say YOU on their own', bare0.zoom > 2.5 && bare0.texts.includes('YOU'), `zoom ${bare0.zoom}`);
  check('…and leave the naming to the coach when it has marks', !marked.texts.includes('YOU') && marked.texts.includes('You brake'));

  const boxes = [...sm.marks.map((m) => m.box), ...sm.arrows.map((a) => a.box)];
  check('every label found a spot', boxes.every(Boolean));
  let clash = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (boxesOverlap(boxes[i], boxes[j])) clash++;
  check('no two labels overlap', clash === 0, `${clash} overlaps`);

  // Position: x/z wins, then the lap's own line, then the centreline.
  const g = out.geom;
  const at = (m) => {
    const ff = fakeCanvas();
    return CHARTS.drawLapMap(ff.canvas, road, mine, { vs, lengthM: 400, window: [0.15, 0.35], marks: [m] }).showme.marks[0];
  };
  const p1 = at({ d: 0.2, kind: 'apex', who: 'you', x: 50, z: 3 });
  const want1 = g.project(50, 3);
  check('a mark with x/z sits at x/z', Math.hypot(p1.x - want1.x, p1.y - want1.y) < 0.5, `${p1.x},${p1.y}`);
  const p2 = at({ d: 0.2, kind: 'apex', who: 'ref' });
  const vsAt = onSquare(0.2, -1);
  const want2 = g.project(vsAt[0], vsAt[1]);
  check('without x/z, theirs sits on THEIR line at d', Math.hypot(p2.x - want2.x, p2.y - want2.y) < 1.5,
    `${p2.x.toFixed(1)},${p2.y.toFixed(1)} vs ${want2.x.toFixed(1)},${want2.y.toFixed(1)}`);
  const bare = lap(200);
  const ff = fakeCanvas();
  const p3 = CHARTS.drawLapMap(ff.canvas, road, bare, { window: [0.15, 0.35], marks: [{ d: 0.2, kind: 'apex', who: 'you' }] })
    .showme.marks[0];
  const k = Math.floor(0.2 * road.points.length);
  const want3 = g.project(road.points[k][0], road.points[k][1]);
  check('a lap with no line: on the centreline at d (the cursor\'s fallback)',
    Math.hypot(p3.x - want3.x, p3.y - want3.y) < 1, `${p3.x.toFixed(1)},${p3.y.toFixed(1)}`);

  // Arrows follow the studied lap's line, and point the way they are told.
  const arr = (fromD, toD) => {
    const fa = fakeCanvas();
    return CHARTS.drawLapMap(fa.canvas, road, mine, { lengthM: 400, window: [0.15, 0.35], arrows: [{ fromD, toD, label: 'x' }] })
      .showme.arrows[0];
  };
  const fwd = arr(0.2, 0.23);
  const back = arr(0.23, 0.2);
  const pFrom = g.project(...onSquare(0.2, 1));
  const pTo = g.project(...onSquare(0.23, 1));
  const near = (a, b, tol) => Math.hypot(a.x - b.x, a.y - b.y) < tol;
  // Beside the line, not on it — a few px off, never far.
  check('an arrow starts beside the studied lap at fromD', near(fwd.from, pFrom, 16), JSON.stringify(fwd.from));
  check('…and its head is at toD', near(fwd.to, pTo, 16), JSON.stringify(fwd.to));
  check('an arrow from later to earlier points back up the road', near(back.to, pFrom, 16) && near(back.from, pTo, 16));
  check('an arrow is beside the line, not on top of it', !near(fwd.from, pFrom, 2));
}

/* ========================================================================== */
console.log('drawChannels — marks');
/* ========================================================================== */
{
  const mine = lap(200);
  const vs = lap(200);
  const bands = CHARTS.channelBands({});
  const base = { vs, lengthM: 400, window: [0.1, 0.4], cursorD: 0.3 };
  const draw = (o) => {
    const f = fakeCanvas(800, 400);
    const out = CHARTS.drawChannels(f.canvas, mine, bands, o);
    return { calls: f.calls, out };
  };
  const plain = draw(base);
  check('without opts.marks: call-for-call as before', same(plain.calls, draw({ ...base, marks: undefined }).calls));
  check('empty marks draw nothing extra', same(plain.calls, draw({ ...base, marks: [] }).calls));
  check('marks outside the window draw nothing extra',
    same(plain.calls, draw({ ...base, marks: [{ d: 0.9, kind: 'brake', who: 'you' }] }).calls));
  check('and the geometry carries no marks key without them', !('marks' in plain.out));

  const marks = [
    { d: 0.2, kind: 'brake', who: 'you', label: 'You brake' },
    { d: 0.203, kind: 'brake', who: 'you', label: 'and again' },
    { d: 0.21, kind: 'brake', who: 'ref', label: 'L7' },
    { d: 0.25, kind: 'apex', who: 'you', label: 'Apex' },
    { d: 0.27, kind: 'full', who: 'you' },
    { d: 0.23, kind: 'turnin', who: 'you' },
  ];
  const { out, calls } = draw({ ...base, marks });
  const by = (kind) => out.marks.find((m) => m.kind === kind);
  check('one entry per mark in the window', out.marks.length === 6, out.marks.length);
  check('brake goes on the pedal band', by('brake').band === 'Throttle / brake');
  check('full throttle too', by('full').band === 'Throttle / brake');
  check('the apex on speed', by('apex').band === 'Speed');
  check('turn-in on steering', /^Steering/.test(by('turnin').band));
  const span = out.x1 - out.x0;
  const wantX = out.x0 + ((0.2 - 0.1) / 0.3) * span;
  check('a tick sits at its distance in the window', Math.abs(by('brake').x - wantX) < 1, `${by('brake').x} vs ${wantX}`);
  const pedal = plain.out.bands.find((b) => b.label === 'Throttle / brake');
  check('…and runs the height of its band',
    calls.some((c, i) => c[0] === 'moveTo' && Math.abs(c[1] - by('brake').x) < 0.01 && Math.abs(c[2] - pedal.y0) < 0.01
      && calls[i + 1] && calls[i + 1][0] === 'lineTo' && Math.abs(calls[i + 1][2] - pedal.y1) < 0.01));
  check('yours cyan, theirs violet',
    calls.some((c) => c[0] === 'stroke' && c[1] === CYAN) && calls.some((c) => c[0] === 'stroke' && c[1] === VIOLET));
  const chips = out.marks.map((m) => m.box).filter(Boolean);
  let clash = 0;
  for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) if (boxesOverlap(chips[i], chips[j])) clash++;
  check('two marks a few metres apart do not stack their chips', clash === 0, `${clash}`);
  check('both close brake marks still got a chip', out.marks.filter((m) => m.kind === 'brake' && m.who === 'you').every((m) => m.box));
}

/* ========================================================================== */
console.log('show-me.js — the stepping');
/* ========================================================================== */
const STEPS = [
  { cornerId: 'C5', window: [0.2, 0.3], marks: [], arrows: [{ fromD: 0.21, toD: 0.22, label: 'brake 12 m later' }], text: 'You brake 12 m before L7 into C5.' },
  { cornerId: 'C8', window: [0.5, 0.6], marks: [{ d: 0.55, kind: 'apex', who: 'you' }], arrows: [], text: 'Carry 6 km/h more through the apex; you are already on the brakes early enough here.' },
  { cornerId: 'C11', window: [0.8, 0.9], marks: [], arrows: [{ fromD: 0.85, toD: 0.84, label: 'throttle 9 m earlier' }], text: 'Pick up the throttle sooner.' },
];
{
  const c = SHOWME.core(STEPS);
  check('starts at the first step', c.index() === 0 && c.step().cornerId === 'C5');
  check('prev at the start does nothing', c.prev() === false && c.index() === 0);
  check('next moves on', c.next() === true && c.index() === 1);
  check('go clamps past the end (no wrapping)', c.go(9) === true && c.index() === 2 && c.next() === false);
  check('go clamps below zero', c.go(-4) === true && c.index() === 0);
  check('an empty list is safe', SHOWME.core([]).go(1) === false && SHOWME.core(null).step() === null);
  check('the bar reads "1 of 3 · C5 · Brake later"', SHOWME.headOf(STEPS, 0) === '1 of 3 · C5 · Brake later', SHOWME.headOf(STEPS, 0));
  check('numbers come out of an arrow title', SHOWME.titleOf(STEPS[2]) === 'Throttle earlier', SHOWME.titleOf(STEPS[2]));
  check('a speed unit comes out too', SHOWME.titleOf({ arrows: [{ label: 'carry 6 km/h more' }] }) === 'Carry more');
  check('no arrow: the start of the text, short',
    SHOWME.titleOf(STEPS[1]).length <= 32 && /^Carry/.test(SHOWME.titleOf(STEPS[1])), SHOWME.titleOf(STEPS[1]));
  check('a title on the step wins', SHOWME.titleOf({ title: 'Late apex', arrows: [{ label: 'x 1 m' }] }) === 'Late apex');
  check('nothing but a mark: named by the mark', SHOWME.titleOf({ marks: [{ kind: 'brake' }] }) === 'Braking');
}

/** A very small DOM: enough elements for show-me.js to find and fill. */
function fakeDom() {
  const docListeners = {};
  const doc = {
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener(t, fn) { docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn); },
    key(key, over = {}) {
      const evt = { key, defaultPrevented: false, target: over.target || null, preventDefault() { this.defaultPrevented = true; }, ...over };
      for (const fn of docListeners.keydown || []) fn(evt);
      return evt;
    },
    listeners: () => (docListeners.keydown || []).length,
  };
  const node = (cls) => ({ cls, textContent: '', disabled: false, dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const parts = {
    '.showme__count': node(), '.showme__corner': node(), '.showme__title': node(), '.showme__text': node(),
    '[data-showme="prev"]': node(), '[data-showme="next"]': node(),
  };
  let html = '';
  const rootListeners = {};
  const root = {
    isConnected: true,
    visible: true,
    getClientRects() { return this.visible ? [1] : []; },
    querySelector: (sel) => parts[sel] || null,
    querySelectorAll: (sel) => (sel === '[data-showme-go]' ? dots : []),
    addEventListener(t, fn) { (rootListeners[t] = rootListeners[t] || []).push(fn); },
    removeEventListener(t, fn) { rootListeners[t] = (rootListeners[t] || []).filter((f) => f !== fn); },
    click(target) { for (const fn of rootListeners.click || []) fn({ target }); },
  };
  let dots = [];
  const el = {
    ownerDocument: doc,
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v;
      const n = (v.match(/data-showme-go="/g) || []).length;
      dots = Array.from({ length: n }, (_, k) => ({ ...node(), dataset: { showmeGo: String(k) } }));
    },
    querySelector: (sel) => (sel === '.showme' && html.includes('class="showme"') ? root : null),
  };
  const target = (attr, value) => ({ closest: (sel) => (sel === `[${attr}]` ? { dataset: value } : null) });
  return { doc, el, root, parts, target, dots: () => dots };
}

{
  const dom = fakeDom();
  const seen = [];
  const api = SHOWME.mount(dom.el, { steps: STEPS, onStep: (s, i) => seen.push([s.cornerId, i]) });
  check('mounting draws the first step straight away', same(seen, [['C5', 0]]), JSON.stringify(seen));
  check('the bar is filled', dom.parts['.showme__count'].textContent === '1 of 3'
    && dom.parts['.showme__corner'].textContent === 'C5' && dom.parts['.showme__title'].textContent === 'Brake later');
  check('the step text is shown', dom.parts['.showme__text'].textContent === STEPS[0].text);
  check('prev is disabled on the first step', dom.parts['[data-showme="prev"]'].disabled === true);
  dom.root.click(dom.target('data-showme', { showme: 'next' }));
  check('next moves to step 2 and tells the host', same(seen[1], ['C8', 1]));
  dom.doc.key('ArrowRight');
  check('→ moves on', api.index() === 2 && same(seen[2], ['C11', 2]));
  check('next is disabled on the last step', dom.parts['[data-showme="next"]'].disabled === true);
  dom.doc.key('ArrowRight');
  check('→ on the last step does nothing (and tells nobody)', seen.length === 3);
  dom.doc.key('ArrowLeft');
  check('← goes back', api.index() === 1);
  const inField = { closest: (sel) => (/input/.test(sel) ? {} : null) };
  dom.doc.key('ArrowLeft', { target: inField });
  check('arrow keys typed in a text field are left alone', api.index() === 1);
  dom.doc.key('ArrowLeft', { shiftKey: true });
  check('…and with a modifier held', api.index() === 1);
  dom.doc.key('ArrowLeft', { defaultPrevented: true });
  check('…and when something nearer already handled the key', api.index() === 1);
  dom.root.visible = false;
  dom.doc.key('ArrowLeft');
  check('a step-through that is not on screen does not hear the keys', api.index() === 1);
  dom.root.visible = true;
  api.go(0);
  check('go(i) from the host moves it', api.index() === 0 && same(seen[seen.length - 1], ['C5', 0]));
  dom.root.click(dom.target('data-showme-go', { showmeGo: '2' }));
  check('a dot jumps to its step', api.index() === 2);
  const before = seen.length;
  api.go(2);
  check('going to the step already on calls nobody', seen.length === before);
  api.destroy();
  check('destroy takes the key listener off the document', dom.doc.listeners() === 0);
  check('…and empties the element', dom.el.innerHTML === '');

  const dom2 = fakeDom();
  const seen2 = [];
  SHOWME.mount(dom2.el, { steps: STEPS, start: 1, onStep: (s, i) => seen2.push(i) });
  check('start opens on that step', same(seen2, [1]));
  const dom3 = fakeDom();
  const noop = SHOWME.mount(dom3.el, { steps: [], onStep: () => { throw new Error('never'); } });
  check('no steps: says so, and calls nobody', /Nothing to show/.test(dom3.el.innerHTML) && dom3.doc.listeners() === 0);
  noop.go(1);
  noop.destroy();
  const dom4 = fakeDom();
  let threw = false;
  const loud = console.error;
  console.error = () => {};
  try {
    SHOWME.mount(dom4.el, { steps: STEPS, onStep: () => { throw new Error('host broke'); } });
  } catch {
    threw = true;
  }
  console.error = loud;
  check('a host whose onStep throws does not break the bar', !threw);
}

/* ========================================================================== */
console.log('Review Coach tab — the beta gate');
/* ========================================================================== */
{
  const TABS = [
    { id: 'overview' }, { id: 'laps' }, { id: 'tyres' }, { id: 'compare' },
    { id: 'coach', coach: true }, { id: 'racelog', race: true },
  ];
  const ids = (ctx) => COACH.filterTabs(TABS, ctx).map((t) => t.id).join();
  check('stable: no Coach tab', !ids({ followingBeta: false, hasApi: true, sessionType: 'Race' }).includes('coach'));
  check('beta, but a build without reviewCoach: no Coach tab',
    !ids({ followingBeta: true, hasApi: false, sessionType: 'Race' }).includes('coach'));
  check('beta, a race: Coach tab', ids({ followingBeta: true, hasApi: true, sessionType: 'Race' }).includes('coach'));
  check('beta, qualifying: Coach tab', COACH.allowed({ followingBeta: true, hasApi: true, sessionType: 'Qualify' }));
  check('beta, practice: no (the Practice tab coaches practice)',
    !COACH.allowed({ followingBeta: true, hasApi: true, sessionType: 'Practice1' }));
  check('nothing known: no', !COACH.allowed(null) && !COACH.allowed({}));
  check('the other tabs are untouched by the gate',
    ids({ followingBeta: false }) === 'overview,laps,tyres,compare,racelog');

  // The wiring, read from the sources: the gate is only a gate if the panel
  // asks it, and only beta if control-panel.js tells the panel which channel.
  const panel = fs.readFileSync(path.join(PANEL, 'review-panel.js'), 'utf8');
  const cp = fs.readFileSync(path.join(PANEL, 'control-panel.js'), 'utf8');
  const html = fs.readFileSync(path.join(PANEL, 'index.html'), 'utf8');
  const catalog = require(path.join(PANEL, 'feature-catalog.js'));
  check('review-panel.js filters its tabs through the gate', /COACH\.filterTabs\(list, coachCtx\(s\)\)/.test(panel));
  check('…and without review-coach.js there is no Coach tab at all', /list\.filter\(\(t\) => !t\.coach\)/.test(panel));
  check('the Coach tab is marked coach in TABS', /\{ id: 'coach', label: 'Coach', coach: true \}/.test(panel));
  check('the lap view\'s Show me segment is gated too', /function lapCoachSteps[\s\S]{0,200}coachAllowed\(view\.session\)/.test(panel));
  check('it starts from the beta flag, not from true', /let followingBeta = !!window\.apexFollowingBeta;/.test(panel));
  check('control-panel.js pushes followingBeta to Review',
    /window\.apexReview\?\.setBeta\?\.\(followingBeta\)/.test(cp) && /window\.apexFollowingBeta = followingBeta;/.test(cp));
  const at = (src) => html.indexOf(`<script src="${src}"></script>`);
  check('show-me.js and review-coach.js load before review-panel.js',
    at('show-me.js') > 0 && at('review-coach.js') > 0 && at('show-me.js') < at('review-panel.js') && at('review-coach.js') < at('review-panel.js'));
  check('…and before practice-panel.js, which uses Show me too', at('show-me.js') < at('practice-panel.js'));
  check('the stylesheets are linked', html.includes('href="show-me.css"') && html.includes('href="review-coach.css"'));
  const gated = catalog.ACTIONS.filter((a) => /^action:review\.(coach|showme)$/.test(a.slug));
  check('the feature catalog counts the coach, as beta', gated.length === 2 && gated.every((a) => a.gated === 'beta' && a.tab === 'review'));
  check('…and the panel notes both slugs',
    panel.includes("note('action:review.coach')") && panel.includes("note('action:review.showme')"));
  check('the coach is asked with the same args as review:lap',
    /reviewCoach\(lapCompareArgs\(lap, ref\)\)/.test(panel) && /reviewLap\(lapCompareArgs\(lap, vsLap\)\)/.test(panel));
}

/* ========================================================================== */
console.log('Review Coach tab — the markup');
/* ========================================================================== */
{
  const corner = (id, phases, over = {}) => ({
    id, index: 0, entryD: 0, apexD: 0, exitD: 0, runEndD: 0,
    lossSec: Object.values(phases).reduce((a, b) => a + b, 0),
    phases: { braking: 0, turnIn: 0, midCorner: 0, exit: 0, exitRun: 0, ...phases },
    mine: {}, ref: {}, straightFlag: null, straightSec: 0, ...over,
  });
  const breakdown = {
    lapId: 'a', refLapId: 'b', leadInSec: 0.02, totalSec: 0.6, residualSec: 0.01,
    corners: [
      corner('C1', { braking: 0.12, midCorner: 0.05, exit: -0.04 }),
      corner('C2', { exit: 0.03, exitRun: 0.3 }, { straightFlag: 'tow', straightSec: 0.2 }),
    ],
    sequences: [{ cornerIds: ['C1', 'C2'], lossSec: 0.46, kind: 'carry' }],
  };
  const html = COACH.breakdownHtml(breakdown, new Set(['C1']));
  check('one row per corner', (html.match(/<tr data-coachcorner=/g) || []).length === 2);
  check('a corner Show me has a step for is a button-row', /data-coachcorner="C1" data-step="true"/.test(html)
    && !/data-coachcorner="C2" data-step/.test(html));
  check('the tow share is greyed and named', /data-notyou="true"/.test(html) && /tow, not you/.test(html));
  const segs = COACH.segmentsOf(breakdown.corners[1]);
  check('…and split off the exit run', segs.some((s) => s.key === 'exitRun' && s.notYou && Math.abs(s.sec - 0.2) < 1e-9)
    && segs.some((s) => s.key === 'exitRun' && !s.notYou && Math.abs(s.sec - 0.1) < 1e-9));
  check('the driver\'s loss leaves the tow out', html.includes('+0.13 s'), 'C2 = 0.33 - 0.20');
  check('a gain sits left of the axis', /rvc-bar__neg"><i class="rvc-seg" data-phase="exit"/.test(html));
  check('the phase most of it is in', COACH.mainPhase(breakdown.corners[0]) === 'braking');
  check('linked corners are named', /C1–C2/.test(html));
  check('no breakdown says so', /No corner breakdown/.test(COACH.breakdownHtml(null)));

  const report = {
    version: 1, scope: 'lap', sessionId: 's', lapId: 'a', source: 'template',
    headline: 'Braking into C1 <costs> most',
    takeaways: [1, 2, 3, 4].map((n) => ({ title: `T${n}`, body: 'b', chip: '≈0.1 s', tone: 'loss', cornerIds: ['C1'], factIds: [] })),
    worst: [{ id: 'C1', lossSec: 0.13, priority: 'high', phase: 'braking', tip: 'Brake later', confidence: 1, perLapSec: [], factIds: [] }],
    sequences: [], aimForSec: null, fairness: [{ kind: 'fuel', severity: 'warn', text: '≈0.4 s of the gap is fuel' }],
    facts: [], generatedAt: '',
  };
  const rh = COACH.reportHtml(report, {});
  check('the headline is escaped', rh.includes('&lt;costs&gt;'));
  check('three takeaways at most', (rh.match(/class="rvc-take"/g) || []).length === 3);
  check('the worst corner with its phase and tip', /rvc-worst__id">C1/.test(rh) && /Braking/.test(rh) && /Brake later/.test(rh));
  check('a fairness warning is a chip', /fuel/.test(rh));
  check('it says beta on it', /Beta/.test(rh));
  check('no report, no markup', COACH.reportHtml(null) === '');
  check('fmtLoss signs and minus', COACH.fmtLoss(0.123) === '+0.12 s' && COACH.fmtLoss(-0.1) === '−0.10 s' && COACH.fmtLoss(0.001) === '0.00 s');
}

console.log(`\ntest-showme: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
