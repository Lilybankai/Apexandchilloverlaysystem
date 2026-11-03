/**
 * scripts/test-trainingfocus.js — the live coach's Focus card, rendered.
 * -----------------------------------------------------------------------------
 * overlay/js/widgets/trainingfocus.js run in a vm against a small DOM built
 * from its own markup, fed frames with `player.coach` (LiveCoachOverlay in
 * src/telemetry/liveCoachContract.ts):
 *
 *   §1 no coach: hidden, with a dimmed sample for edit mode;
 *   §2 learning, and clean laps with nothing to fix;
 *   §3 a focus: the corner, the change, the cost, the foot by reference kind;
 *   §4 each status's chip;
 *   §5 the approach light on and off by the car's position (and round the
 *      line, and in the pit), held through the exit;
 *   §6 a new rev flashes once, the first sight does not;
 *   §7 the map: the learned circuit, the corner bright, the car's dot;
 *   §8 DOM written only on change;
 *   §9 the hosts and the Race-mode gate (trainingGate.js coachSessionOfFrame).
 *
 * Run: npm run test:trainingfocus
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
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/* -------------------------------------------------------------------------- */
/*  A DOM just big enough for the widget's own markup                          */
/* -------------------------------------------------------------------------- */

let writes = 0;

class El {
  constructor(tag, attrs) {
    this.tagName = tag;
    this.attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.parentNode = null;
    this._text = '';
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { writes++; this._text = String(v); this.children = []; }
  setAttribute(k, v) { writes++; this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { writes++; delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  get classList() { return (this.attrs.class || '').split(/\s+/).filter(Boolean); }
  matches(sel) {
    if (sel.startsWith('.')) return this.classList.includes(sel.slice(1));
    const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
    if (m) return this.attrs[m[1]] === m[2];
    return this.tagName === sel;
  }
  querySelector(sel) {
    for (const c of this.children) {
      if (c.matches(sel)) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }
  set innerHTML(html) {
    this.children = [];
    this._text = '';
    const stack = [this];
    const re = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      const top = stack[stack.length - 1];
      if (m[5] !== undefined) {
        const t = new El('#text');
        t._text = m[5];
        top.appendChild(t);
        continue;
      }
      if (m[1]) { stack.pop(); continue; }
      const attrs = {};
      for (const a of m[3].matchAll(/([\w-:]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
      const e = top.appendChild(new El(m[2].toLowerCase(), attrs));
      if (!m[4]) stack.push(e);
    }
  }
}

/** A fresh page with the widget's shell, the widget loaded and inited. */
function page(opts = {}) {
  const clock = { t: 1_000_000 };
  const timers = [];
  const section = new El('section', { id: 'widget-trainingfocus', 'data-widget': 'trainingfocus' });
  section.innerHTML = '<div class="tw__body" data-role="mount"><div class="tw__wait">Awaiting telemetry…</div></div>';
  let def = null;
  const fetches = [];
  const ctx = {
    console,
    Math, JSON, Number, String, Array, Object, isFinite, isNaN, Infinity, NaN,
    Date: { now: () => clock.t },
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock.t + ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    fetch: opts.fetch
      ? (url) => { fetches.push(url); return opts.fetch(url); }
      : undefined,
    document: { createElementNS: (ns, tag) => new El(tag) },
    ApexOverlay: { registerWidget: (id, d) => { def = { id, ...d }; } },
  };
  if (opts.ghost) ctx.ApexTrainingGhost = opts.ghost;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('overlay', 'js', 'training-laps.js'), ctx, { filename: 'training-laps.js' });
  vm.runInContext(read('overlay', 'js', 'widgets', 'trainingfocus.js'), ctx, { filename: 'trainingfocus.js' });
  def.init(section);
  const card = section.querySelector('.tfoc');
  const q = (cls) => card.querySelector('.' + cls);
  return {
    def, section, card, clock, fetches,
    q,
    text: (cls) => q(cls).textContent,
    update: (frame) => def.update(frame),
    advance(ms) {
      clock.t += ms;
      for (const t of timers) if (t.fn && t.at <= clock.t) { const f = t.fn; t.fn = null; f(); }
    },
  };
}

/** A LiveCoachOverlay with a focus on C4. */
function coachWith(over = {}, focusOver = {}) {
  return Object.assign({
    focus: Object.assign({ cornerId: 'C4', cornerNo: 4, entryD: 0.3, apexD: 0.315, exitD: 0.33, lossSec: 0.152, short: 'Brake 10 m later', status: 'new' }, focusOver),
    validLaps: 4,
    minLaps: 2,
    lastLapSec: 209.41,
    lastDeltaSec: 0.62,
    refKind: 'sessionBest',
    rev: 1,
  }, over);
}

/** A frame: the coach, the car at lap fraction `d` (REST track map), 250 km/h. */
function frame(coach, d, extra = {}) {
  const f = {
    connected: true,
    session: { type: 'practice', trackLengthM: 4000 },
    player: { speedKph: 250 },
    trackMap: { key: 'k', revision: 1, ready: false, cars: [] },
  };
  if (coach !== undefined) f.player.coach = coach;
  if (d !== undefined) f.trackMap.cars = [{ slotId: 1, isPlayer: true, inPit: !!extra.inPit, lapFraction: d }, { slotId: 2, isPlayer: false, inPit: false, lapFraction: 0.31 }];
  if (extra.ghost) f.player.ghost = extra.ghost;
  if (extra.trackMap) Object.assign(f.trackMap, extra.trackMap);
  return f;
}

/* -------------------------------------------------------------------------- */

console.log('\n1) No coach: hidden, a sample for edit mode');
{
  const p = page();
  check('registered as trainingfocus, throttled', p.def.id === 'trainingfocus' && p.def.throttleMs > 0 && p.def.throttleMs <= 100, p.def.throttleMs);
  check('hidden from init, before any frame', p.section.getAttribute('data-coach') === 'none');
  p.update(frame(undefined, 0.2));
  check('a frame without player.coach keeps it hidden', p.section.getAttribute('data-coach') === 'none');
  check('…with the sample under it, for edit mode', p.card.getAttribute('data-sample') === 'true' && p.text('tfoc__corner') === 'C4' && p.text('tfoc__short') === 'Brake 10 m later');
  check('…and the sample has a map to place', p.card.getAttribute('data-map') === 'on' && (p.q('tfoc__outline').getAttribute('d') || '').length > 20);
  check('the sample never lights', p.section.getAttribute('data-approach') === 'off');
  p.update({ connected: true, session: { type: 'practice' } });
  check('a frame with no player at all is no coach either', p.section.getAttribute('data-coach') === 'none');
  const css = read('overlay', 'css', 'training-focus.css');
  check('the CSS hides it without a coach…', /#widget-trainingfocus\[data-coach="none"\]\s*\{\s*visibility:\s*hidden/.test(css));
  check('…and shows it dimmed while editing', /body\.ig-editing #widget-trainingfocus\[data-coach="none"\]\s*\{[^}]*visibility:\s*visible[^}]*opacity:\s*0\.\d+/.test(css));
  check('no backdrop-filter (nothing behind the overlay to blur)', !/backdrop-filter/.test(css));
}

console.log('\n2) Before there is a focus');
{
  const p = page();
  p.update(frame({ focus: null, validLaps: 1, minLaps: 2, lastLapSec: 211.2, lastDeltaSec: null, refKind: 'sessionBest', rev: 0 }, 0.5));
  check('shown once the coach publishes', p.section.getAttribute('data-coach') === 'on' && p.card.getAttribute('data-sample') === 'false');
  check('learning: "Learning your laps… 1 / 2"', p.card.getAttribute('data-mode') === 'learning' && p.text('tfoc__note') === 'Learning your laps… 1 / 2', p.text('tfoc__note'));
  check('…the foot has the lap and no delta', p.text('tfoc__foot') === 'Last 3:31.20', p.text('tfoc__foot'));
  p.update(frame({ focus: null, validLaps: 0, minLaps: 2, lastLapSec: null, lastDeltaSec: null, refKind: 'sessionBest', rev: 0 }, 0.5));
  check('no lap yet: "0 / 2" and an empty foot', p.text('tfoc__note') === 'Learning your laps… 0 / 2' && p.text('tfoc__foot') === '');
  p.update(frame({ focus: null, validLaps: 3, minLaps: 2, lastLapSec: 209.9, lastDeltaSec: 0.05, refKind: 'sessionBest', rev: 0 }, 0.5));
  check('enough laps, nothing costing enough: clean', p.card.getAttribute('data-mode') === 'clean' && p.text('tfoc__note') === 'Clean laps — nothing big to fix', p.text('tfoc__note'));
  check('…and nothing lights without a focus', (p.update(frame(coachWith({ focus: null }), 0.29)), p.section.getAttribute('data-approach') === 'off'));
  const css = read('overlay', 'css', 'training-focus.css');
  check('the CSS keeps it small: no corner block, no chip, before a focus', /\.tfoc:not\(\[data-mode="focus"\]\) \.tfoc__main\s*\{\s*display:\s*none/.test(css) && /\.tfoc:not\(\[data-mode="focus"\]\) \.tfoc__chip\s*\{\s*display:\s*none/.test(css));
}

console.log('\n3) A focus');
{
  const p = page();
  p.update(frame(coachWith(), 0.6));
  check('focus mode', p.card.getAttribute('data-mode') === 'focus');
  check('the corner id, as the Practice tab names it', p.text('tfoc__corner') === 'C4');
  check('the change', p.text('tfoc__short') === 'Brake 10 m later');
  check('the cost: "≈0.15 s a lap"', p.text('tfoc__cost') === '≈0.15 s a lap', p.text('tfoc__cost'));
  check('the foot: "Last 3:29.41 · +0.62 vs best"', p.text('tfoc__foot') === 'Last 3:29.41 · +0.62 vs best', p.text('tfoc__foot'));
  p.update(frame(coachWith({ refKind: 'board', lastDeltaSec: 1.234 }), 0.6));
  check('against a board lap: "vs board"', p.text('tfoc__foot') === 'Last 3:29.41 · +1.23 vs board', p.text('tfoc__foot'));
  p.update(frame(coachWith({ refKind: 'chased', lastDeltaSec: -0.31 }), 0.6));
  check('against the chased lap, quicker: a real minus, "vs target"', p.text('tfoc__foot') === 'Last 3:29.41 · −0.31 vs target', p.text('tfoc__foot'));
  p.update(frame(coachWith({ lastDeltaSec: 0 }), 0.6));
  check('the last lap IS the session best: "your best"', p.text('tfoc__foot') === 'Last 3:29.41 · your best', p.text('tfoc__foot'));
  p.update(frame(coachWith({ lastLapSec: 65.04 }), 0.6));
  check('a lap under 10 s past the minute keeps two digits', p.text('tfoc__foot').startsWith('Last 1:05.04'), p.text('tfoc__foot'));
  p.update(frame(coachWith({}, { cornerId: undefined, cornerNo: 7 }), 0.6));
  check('no id: built from the number', p.text('tfoc__corner') === 'C7');
}

console.log('\n4) Status chips');
{
  const p = page();
  const want = {
    new: ['NEW', 'new'],
    holding: ['WORKING ON IT', 'hold'],
    improving: ['BETTER', 'gain'],
    fixed: ['SORTED ✓', 'gain'],
  };
  for (const [status, [text, tone]] of Object.entries(want)) {
    p.update(frame(coachWith({}, { status }), 0.6));
    const chip = p.q('tfoc__chip');
    check(`${status}: "${text}", ${tone}`, chip.textContent === text && chip.getAttribute('data-tone') === tone && p.card.getAttribute('data-status') === status, `${chip.textContent} ${chip.getAttribute('data-tone')}`);
  }
  p.update(frame(coachWith({}, { status: 'fixed' }), 0.6));
  check('sorted: the cost line says what comes next, not an old loss', p.text('tfoc__cost') === 'On to the next corner', p.text('tfoc__cost'));
  p.update(frame(coachWith({}, { status: 'whatever' }), 0.6));
  check('an unknown status reads as holding, never blank', p.q('tfoc__chip').textContent === 'WORKING ON IT');
}

console.log('\n5) The approach light');
{
  const p = page();
  const c = coachWith();
  // 4000 m lap, 250 km/h: the lead is 3 s × 69.4 m/s = 208 m = 0.052 of a lap.
  p.update(frame(c, 0.2));
  check('400 m out at 250 km/h: off', p.section.getAttribute('data-approach') === 'off' && p.text('tfoc__call') === '');
  p.update(frame(c, 0.26));
  check('160 m out (2.3 s): NEXT', p.section.getAttribute('data-approach') === 'next' && p.text('tfoc__call') === 'NEXT');
  p.update(frame(c, 0.315));
  check('inside the corner: NOW', p.section.getAttribute('data-approach') === 'now' && p.text('tfoc__call') === 'NOW');
  p.advance(100);
  p.update(frame(c, 0.335));
  check('just past the exit: held a moment', p.section.getAttribute('data-approach') === 'now');
  p.advance(500);
  p.update(frame(c, 0.34));
  check('…then off', p.section.getAttribute('data-approach') === 'off' && p.text('tfoc__call') === '');
  const slow = frame(c, 0.28625);
  slow.player.speedKph = 60;
  p.advance(1000);
  p.update(slow);
  check('55 m out at 60 km/h (3.3 s, but inside the 60 m floor): lit', p.section.getAttribute('data-approach') === 'next');
  p.advance(1000);
  const slow2 = frame(c, 0.27);
  slow2.player.speedKph = 60;
  p.update(slow2);
  check('120 m out at 60 km/h (7 s): off', p.section.getAttribute('data-approach') === 'off');

  const q = page();
  const wrap = coachWith({}, { entryD: 0.98, apexD: 0.995, exitD: 0.015 });
  q.update(frame(wrap, 0.95));
  check('a corner across the line: 120 m before, NEXT', q.section.getAttribute('data-approach') === 'next');
  q.update(frame(wrap, 0.005));
  check('…after the line, still NOW', q.section.getAttribute('data-approach') === 'now');

  const r = page();
  r.update(frame(c, 0.29, { inPit: true }));
  check('in the pit lane: never lit', r.section.getAttribute('data-approach') === 'off');
  r.update(frame(c, 0.6, { ghost: { active: true, atD: 0.29 } }));
  check("the ghost's filtered position wins over the REST one", r.section.getAttribute('data-approach') === 'next');
  r.advance(1000);
  const noLen = frame(c, 0.29);
  delete noLen.session.trackLengthM;
  r.update(noLen);
  check('no lap length known: no light rather than a guess', r.section.getAttribute('data-approach') === 'off');
  const noPos = frame(c);
  r.update(noPos);
  check('no position: off', r.section.getAttribute('data-approach') === 'off');
  const css = read('overlay', 'css', 'training-focus.css');
  check('the CSS lights the card edge and shows the pill', /#widget-trainingfocus:is\(\[data-approach="next"\], \[data-approach="now"\]\)\s*\{[^}]*box-shadow/.test(css) && /\[data-approach="now"\]\) \.tfoc__call\s*\{\s*display:\s*inline-block/.test(css));
}

console.log('\n6) A new focus flashes once');
{
  const p = page();
  p.update(frame({ focus: null, validLaps: 1, minLaps: 2, lastLapSec: null, lastDeltaSec: null, refKind: 'sessionBest', rev: 0 }, 0.6));
  check('first sight of the coach: no flash', !p.section.hasAttribute('data-flash'));
  p.update(frame(coachWith({ rev: 1 }), 0.6));
  const first = p.section.getAttribute('data-flash');
  check('the first focus (rev 0 → 1): flash', first === 'a' || first === 'b', first);
  p.update(frame(coachWith({ rev: 1 }), 0.6));
  check('the same rev again: the flash is not restarted', p.section.getAttribute('data-flash') === first);
  p.advance(1500);
  check('…and it ends', !p.section.hasAttribute('data-flash'));
  p.update(frame(coachWith({ rev: 1 }, { status: 'holding' }), 0.6));
  check('a status change with the same rev: no flash', !p.section.hasAttribute('data-flash'));
  p.update(frame(coachWith({ rev: 2 }, { cornerId: 'C9', cornerNo: 9 }), 0.6));
  const second = p.section.getAttribute('data-flash');
  check('a new rev: flash', !!second && p.text('tfoc__corner') === 'C9');
  p.advance(200);
  p.update(frame(coachWith({ rev: 3 }), 0.6));
  check('another new rev inside the flash restarts it (the other name)', p.section.getAttribute('data-flash') !== second && p.section.hasAttribute('data-flash'));
  const q = page();
  q.update(frame(coachWith({ rev: 5 }), 0.6));
  check('a card that appears mid-session with a focus does not flash', !q.section.hasAttribute('data-flash'));
  q.update(frame(undefined, 0.6));
  q.update(frame(coachWith({ rev: 6 }), 0.6));
  check('…nor after the coach went away and came back', !q.section.hasAttribute('data-flash'));
  const css = read('overlay', 'css', 'training-focus.css');
  check('the CSS flash plays once', /\[data-flash="a"\]\s*\{\s*animation:[^;]*\b1;/.test(css) && /\[data-flash="b"\]\s*\{\s*animation:[^;]*\b1;/.test(css));
}

console.log('\n7) The map');
(async () => {
  const shape = JSON.parse(read('data', 'trackmaps', 'bahrain-outer-circuit-3510.json'));
  const p = page({ fetch: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(shape) }) });
  const c = coachWith();
  p.update(frame(c, 0.6));
  check('no track map ready: nothing fetched', p.fetches.length === 0);
  check('…and no map drawn (the sample circuit is only for edit mode)', p.card.getAttribute('data-map') === 'none');
  const tm = { key: shape.key, revision: 3, ready: true };
  p.update(frame(c, 0.6, { trackMap: tm }));
  await new Promise((r) => setImmediate(r));
  p.update(frame(c, 0.6, { trackMap: tm }));
  check('a ready map is fetched once', p.fetches.length === 1 && p.fetches[0] === '/trackmap.json', p.fetches.join(','));
  check('the outline is drawn', p.card.getAttribute('data-map') === 'on' && (p.q('tfoc__outline').getAttribute('d') || '').split('L').length > 100);
  const span = p.q('tfoc__span').getAttribute('d') || '';
  // 0.30..0.33 of 585 bins ≈ 18 points.
  const n = span.split('L').length;
  check('the focus corner is a bright span of its own bins', n >= 15 && n <= 22, n);
  const dot = p.q('tfoc__dot');
  const bin = shape.points[Math.round(0.6 * shape.points.length)];
  check('the car is a dot on the map', dot.getAttribute('data-on') === 'true' && Number.isFinite(Number(dot.getAttribute('cx'))), `${dot.getAttribute('cx')},${dot.getAttribute('cy')} (bin ${bin.slice(0, 2).join(',')})`);
  for (let i = 0; i < 4; i++) p.update(frame(c, 0.6, { trackMap: tm }));
  check('the same revision is not fetched again', p.fetches.length === 1);
  const cx = Number(dot.getAttribute('cx'));
  const cy = Number(dot.getAttribute('cy'));
  check('inside the 150×96 box', cx >= 0 && cx <= 150 && cy >= 0 && cy <= 96, `${cx},${cy}`);
  p.update(frame(coachWith({}, { entryD: 0.7, exitD: 0.72 }), 0.6, { trackMap: tm }));
  check('a new focus corner moves the span', p.q('tfoc__span').getAttribute('d') !== span);

  // No track map yet, but a ghost lap with a driven line: its line is the map.
  let sub = null;
  const ghostStub = { sync() {}, subscribe(cb) { sub = cb; } };
  const g = page({ ghost: ghostStub });
  const N = 200;
  const line = { trackLengthM: 3000, d: [], x: [], z: [] };
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    line.d.push(i / N);
    line.x.push(Math.cos(t) * 500);
    line.z.push(Math.sin(t) * 300);
  }
  sub(line);
  g.update(frame(c, 0.1));
  check('no track map: the ghost lap\'s line is the map', g.card.getAttribute('data-map') === 'on' && (g.q('tfoc__span').getAttribute('d') || '').length > 10);
  sub(null);
  g.update(frame(c, 0.1));
  check('the ghost goes: so does its map', g.card.getAttribute('data-map') === 'none');

  console.log('\n8) Written only on change');
  {
    const w = page();
    const f = frame(coachWith(), 0.6);
    w.update(f);
    const before = writes;
    for (let i = 0; i < 10; i++) w.update(frame(coachWith(), 0.6));
    check('ten identical frames: no DOM writes', writes === before, writes - before);
    w.update(frame(coachWith(), 0.26));
    check('the light coming on writes a handful', writes - before > 0 && writes - before < 8, writes - before);
  }

  console.log('\n9) Hosts and the Race-mode gate');
  {
    const shells = read('overlay', 'js', 'training-shells.js');
    check('a training shell (card look)', /add\("trainingfocus", "Focus", "[^"]+"\);/.test(shells));
    const training = read('overlay', 'training.html');
    const widget = read('overlay', 'widget.html');
    for (const [name, html] of [['training.html', training], ['widget.html', widget]]) {
      check(`${name} loads its script after training-ghost.js, and its styles`,
        html.includes('src="js/widgets/trainingfocus.js"') && html.indexOf('js/training-ghost.js') < html.indexOf('js/widgets/trainingfocus.js') && html.includes('href="css/training-focus.css"'));
    }
    check('the race overlay never loads it', !/trainingfocus|training-focus/.test(read('overlay', 'ingame.html')));
    const main = read('electron', 'main.js');
    const entry = /\{\s*(?:\/\/[^\n]*\n\s*)*id: 'trainingfocus',[\s\S]*?\n {2}\}/.exec(main);
    check('main.js catalogues it: beta, training group, on by default', !!entry && /gated: 'beta'/.test(entry[0]) && /group: 'training'/.test(entry[0]) && /ingameDefault: true/.test(entry[0]));
    check('ingame.js places it on the training layer', /trainingfocus: \{ x: /.test(read('overlay', 'js', 'ingame.js')));
    check('an icon in the panel', /trainingfocus: '[a-z-]+'/.test(read('electron', 'control-panel', 'icons.js')));
    check('the bench keeps it off the race layer', /'trainingfocus'/.test(read('scripts', 'bench-widgets.js')));
    check('the Focus gate is fed every frame and on the silent-feed beat',
      /focusGate\.update\(\{ session: coachSessionOfFrame\(frame\) \}, now\)/.test(main) && /focusGate\.update\(stale \? \{ session: null \} : \{\}, Date\.now\(\)\)/.test(main));
    check('the training window follows the plan, not trainingActive alone', /const plan = trainingWindowPlan\(s\);/.test(main) && !/const wanted = trainingActive\(\) && ids\.length > 0;/.test(main));

    const { coachSessionOfFrame, evaluate, HOLD_MS } = require('../electron/trainingGate');
    const coached = { connected: true, session: { type: 'practice' }, player: { coach: { focus: null, rev: 0 } } };
    const bare = { connected: true, session: { type: 'practice' }, player: {} };
    check('coached practice: the practice session', coachSessionOfFrame(coached).type === 'practice');
    check('practice without a coach: a gap (held, then closed)', coachSessionOfFrame(bare) === null);
    check('a race with a coach somehow on it: still a race', coachSessionOfFrame({ ...coached, session: { type: 'race' } }).type === 'race');
    check('a replay: never', coachSessionOfFrame({ ...coached, session: { type: 'practice', replay: true } }).type === 'replay');
    check('a demo frame: not a session', coachSessionOfFrame({ ...coached, connected: false }).demo === true);
    const on = { mode: true, beta: true, running: true };
    const a = evaluate({ ...on, session: coachSessionOfFrame(coached) }, 1000, 0);
    check('coached practice, card on, beta: the Focus gate opens', a.active);
    const held = evaluate({ ...on, session: coachSessionOfFrame(bare) }, 1000 + HOLD_MS - 1, a.lastEligibleAt);
    const gone = evaluate({ ...on, session: coachSessionOfFrame(bare) }, 1000 + HOLD_MS + 1, a.lastEligibleAt);
    check('the coach stops: held for the hold, then closed', held.active && !gone.active);
    check('…and never opens off beta or with the card off', !evaluate({ ...on, beta: false, session: coachSessionOfFrame(coached) }, 1000, 0).active && !evaluate({ ...on, mode: false, session: coachSessionOfFrame(coached) }, 1000, 0).active);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
