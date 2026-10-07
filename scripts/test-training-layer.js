/**
 * scripts/test-training-layer.js — the training overlays' own window.
 * -----------------------------------------------------------------------------
 * electron/trainingLayer.js builds a second transparent, click-through,
 * always-on-top window for the training widgets. Pinned here against a fake
 * BrowserWindow:
 *
 *   1. it exists only while wanted, and costs nothing (no window at all) when
 *      it is not — the whole point of moving Ghost HUD out of the race layer;
 *   2. it is built the way the race layer is: transparent, non-focusable,
 *      unthrottled, at the 'screen-saver' level, sized by main's geometry
 *      (not the constructor), click-through until edited;
 *   3. editing unlocks it and brings it above the race layer (moveTop);
 *   4. its recovery reloads and rebuilds THIS window only — the race window
 *      is never touched;
 *   5. the pages: ingame.html no longer loads Ghost HUD, training.html loads
 *      nothing but the training widgets, widget.html (OBS) still has it.
 *
 * Run: node scripts/test-training-layer.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createTrainingLayer } = require('../electron/trainingLayer');
const { QUIET_MS } = require('../electron/layer-watch');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
}

/* ---------------------------- a fake BrowserWindow ------------------------ */

const built = [];
class FakeWindow {
  constructor(opts) {
    this.opts = opts;
    this.calls = [];
    this.handlers = {};
    this.visible = false;
    this.destroyed = false;
    this.url = '';
    const wcHandlers = {};
    const self = this;
    this.webContents = {
      handlers: wcHandlers,
      sent: [],
      reloads: 0,
      on(evt, fn) {
        wcHandlers[evt] = fn;
      },
      send(ch, payload) {
        this.sent.push([ch, payload]);
      },
      reload() {
        this.reloads++;
      },
      isLoading: () => false,
      getOSProcessId: () => 4242,
      emit(evt, ...args) {
        if (wcHandlers[evt]) wcHandlers[evt](...args);
      },
    };
    this.webContents.owner = self;
    built.push(this);
  }
  on(evt, fn) {
    this.handlers[evt] = fn;
  }
  loadURL(url) {
    this.url = url;
    this.calls.push(['loadURL', url]);
    return Promise.resolve();
  }
  setAlwaysOnTop(on, level) {
    this.calls.push(['setAlwaysOnTop', on, level]);
  }
  setIgnoreMouseEvents(v) {
    this.ignoreMouse = v;
  }
  setFocusable(v) {
    this.focusable = v;
  }
  moveTop() {
    this.calls.push(['moveTop']);
  }
  isVisible() {
    return this.visible;
  }
  showInactive() {
    this.visible = true;
    this.calls.push(['showInactive']);
  }
  show() {
    this.calls.push(['show']); // must never happen: it would take the game's focus
  }
  hide() {
    this.visible = false;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    if (this.handlers.closed) this.handlers.closed();
  }
}

let clock = 0;
const geometry = [];
const logged = [];
let changes = 0;
const layer = createTrainingLayer({
  BrowserWindow: FakeWindow,
  preload: '/app/electron/ingame-preload.js',
  applyGeometry: (opts) => geometry.push(opts),
  initialBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
  appearance: () => ({ panelOpacity: 80 }),
  feedLive: () => true,
  log: (line) => logged.push(line),
  processContext: () => ' ctx',
  onChange: () => changes++,
  now: () => clock,
});

// A race-layer window that main owns. The training layer is never handed it;
// it is here so the tests can say it was never touched.
const raceWin = new FakeWindow({ title: 'race' });
built.length = 0;

const URL_A = 'http://127.0.0.1:17080/training.html?layer=training&widgets=ghosthud';

console.log('\ntraining layer: exists only while wanted');
{
  layer.sync({ wanted: false, url: URL_A, visible: true });
  check('not wanted → no window is ever built', built.length === 0 && layer.window() === null);

  layer.sync({ wanted: true, url: URL_A, visible: false });
  const w = built[0];
  check('wanted → one window', built.length === 1 && layer.window() === w);
  check('it loads the training page', w.url === URL_A);
  check('born hidden, and kept hidden while auto-hide says so', w.visible === false);

  layer.sync({ wanted: true, url: URL_A, visible: true });
  check('same URL again → no rebuild, no reload', built.length === 1 && w.calls.filter((c) => c[0] === 'loadURL').length === 1);
  check('shown with showInactive, never show()', w.visible && !w.calls.some((c) => c[0] === 'show'));

  const URL_B = URL_A + ',other';
  layer.sync({ wanted: true, url: URL_B, visible: true });
  check('a new widget list reloads the same window', built.length === 1 && w.url === URL_B);

  layer.setVisible(false);
  check('auto-hide hides it', !w.visible);
  layer.setVisible(true);

  layer.sync({ wanted: false, url: URL_B, visible: true });
  check('not wanted any more → destroyed, slot empty', w.destroyed && layer.window() === null);
  check('the panel was told each time it came and went', changes >= 2, changes);
}

console.log('\ntraining layer: built like the race layer');
{
  built.length = 0;
  geometry.length = 0;
  layer.sync({ wanted: true, url: URL_A, visible: true });
  const w = built[0];
  const o = w.opts;
  check(
    'transparent, frameless, non-focusable, always on top, off the taskbar',
    o.transparent && o.frame === false && o.focusable === false && o.alwaysOnTop && o.skipTaskbar,
  );
  check('never throttled behind the game', o.webPreferences.backgroundThrottling === false);
  check('isolated, no node in the page', o.webPreferences.contextIsolation && !o.webPreferences.nodeIntegration);
  check('the shared bridge', o.webPreferences.preload.endsWith('ingame-preload.js'));
  check(
    "the race layer's z-level",
    w.calls.some((c) => c[0] === 'setAlwaysOnTop' && c[1] === true && c[2] === 'screen-saver'),
  );
  check(
    "sized by main's geometry right after construction (the work-area clamp)",
    geometry.length >= 1 && geometry[0].win === w && geometry[0].notify === false,
  );
  check('click-through while locked', w.ignoreMouse === true && w.focusable === false);

  w.webContents.emit('did-finish-load');
  const sent = w.webContents.sent.map((s) => s[0]);
  check('a fresh page is told the appearance and the edit state', sent.includes('ingame:appearance') && sent.includes('ingame:edit'));
}

console.log('\ntraining layer: the page hears when it is hidden');
{
  // The page cannot see win.hide() (backgroundThrottling:false keeps its
  // document "visible"), so its paint loops stop only on this message.
  const w = layer.window();
  const shownMsgs = () => w.webContents.sent.filter((s) => s[0] === 'training:shown').map((s) => s[1]);
  w.webContents.sent.length = 0;
  layer.setVisible(false);
  check('hidden → the page is told false', shownMsgs().join() === 'false', shownMsgs().join());
  layer.setVisible(false);
  check('…once, not on every repeat', shownMsgs().length === 1);
  layer.setVisible(true);
  check('shown → told true', shownMsgs().join() === 'false,true', shownMsgs().join());
  layer.setVisible(false);
  w.webContents.sent.length = 0;
  w.webContents.emit('did-finish-load');
  check('a page that loads while hidden is told so at once', shownMsgs().join() === 'false', shownMsgs().join());
  layer.setVisible(true);
  check('the race window is never sent it', !raceWin.webContents.sent.some((s) => s[0] === 'training:shown'));
}

console.log('\ntraining layer: editing');
{
  const w = layer.window();
  w.hide();
  layer.setVisible(false); // driver in the menus
  layer.setEditing(true);
  check('edit unlocks the mouse', w.ignoreMouse === false && w.focusable === true);
  check('edit brings it above the race layer', w.calls.some((c) => c[0] === 'moveTop'));
  check('edit forces it on screen', w.visible === true);
  check('the page hears it', w.webContents.sent.some((s) => s[0] === 'ingame:edit' && s[1] === true));
  check('editing() reports it', layer.editing() === true);
  layer.setEditing(false);
  check('done → click-through again', w.ignoreMouse === true && w.focusable === false);
  check('and auto-hide has its say again', w.visible === false);
  layer.setVisible(true);

  layer.sync({ wanted: false, url: URL_A, visible: true });
  check('editing a window that has gone is not possible', layer.setEditing(true) === false && !layer.editing());
}

console.log('\ntraining layer: recovery touches this window only');
{
  built.length = 0;
  clock = 0;
  logged.length = 0;
  layer.sync({ wanted: true, url: URL_A, visible: true });
  const w = built[0];
  w.webContents.emit('did-finish-load');
  layer.health({ received: 30, painted: 30, worstMs: 1, worstWidget: '', longMs: 0, visibility: 'visible' });

  clock = QUIET_MS + 2000;
  layer._tick();
  check('quiet with the feed live → its own page reloads', w.webContents.reloads === 1, w.webContents.reloads);
  check('logged as TRAINING, not LAYER', logged.some((l) => l.startsWith('TRAINING reloaded')), logged.join(' | '));

  clock = QUIET_MS * 2 + 4000;
  layer._tick();
  const w2 = layer.window();
  check('frozen again soon after → this window is rebuilt', w.destroyed && w2 && w2 !== w && built.length === 2);
  check('the rebuild loads the same page', w2.url === URL_A);
  check(
    'the race window was never touched',
    raceWin.calls.length === 0 && raceWin.webContents.reloads === 0 && !raceWin.destroyed,
  );

  w2.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  check('a crashed renderer is reloaded', w2.webContents.reloads === 1);
  check('and logged', logged.some((l) => l.startsWith('TRAINING renderer gone reason=crashed')));
  w2.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  check('a clean exit is left alone', w2.webContents.reloads === 1);

  layer.recreate('GPU process restarted');
  check('recreate() builds a fresh window', built.length === 3 && layer.window() === built[2] && w2.destroyed);
  check('owns() knows its own page', layer.owns(built[2].webContents) && !layer.owns(raceWin.webContents));

  layer.sync({ wanted: false, url: URL_A, visible: true });
  const before = built.length;
  layer.recreate('nothing there');
  check('recreate() with no window builds nothing', built.length === before && layer.window() === null);
}

console.log('\ntraining layer: Stop takes it down');
{
  // Wired as main wires them: the gate's flips drive layer.sync, with the
  // window wanted while the gate is open and a training widget is on.
  const { createTrainingGate } = require('../electron/trainingGate');
  const gate = createTrainingGate();
  const ids = ['ghosthud'];
  const syncWindow = () =>
    layer.sync({ wanted: gate.state().active && ids.length > 0, url: URL_A, visible: true });
  gate.subscribe((next, prev) => {
    if (next.active !== prev.active) syncWindow();
  });
  built.length = 0;
  gate.update({ mode: true, beta: true, running: true, session: { type: 'practice', demo: false } }, 0);
  const w = layer.window();
  check('practice with the server running → the window is up', !!w && built.length === 1);
  // What stopServer now does after `status.running = false`.
  gate.update({ running: false }, 100);
  check('Stop → the gate says stopped', !gate.state().active && gate.state().reason === 'stopped');
  check('→ and the window is gone', w.destroyed && layer.window() === null);

  // main.js is not loadable here, so the wiring is pinned in its source: every
  // place `status.running` changes must reach the gate before its function
  // ends — directly, or through syncOverlayWindow, which re-syncs it.
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const sites = Array.from(main.matchAll(/status\.running = (true|false);/g));
  const unsynced = sites.filter((m) => {
    const rest = main.slice(m.index, main.indexOf('\n}\n', m.index));
    return !/syncTrainingLayerFenced\(|syncOverlayWindow\(/.test(rest);
  });
  check('every change of status.running re-syncs the training gate', sites.length >= 3 && unsynced.length === 0,
    `${sites.length} sites, unsynced at ${unsynced.map((m) => main.slice(0, m.index).split('\n').length).join(',')}`);
}

console.log('\ntraining layer: the pages');
{
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'overlay', f), 'utf8');
  const scripts = (html) => Array.from(html.matchAll(/<script src="([^"]+)"/g), (m) => m[1]);
  const ingame = scripts(read('ingame.html'));
  const training = scripts(read('training.html'));
  const widget = scripts(read('widget.html'));
  check(
    'ingame.html no longer loads Ghost HUD or its maths',
    !ingame.some((s) => /ghost/.test(s)),
    ingame.filter((s) => /ghost/.test(s)).join(','),
  );
  check(
    'training.html loads Ghost HUD and its maths',
    training.includes('js/ghost-geom.js') && training.includes('js/widgets/ghosthud.js'),
  );
  const TRAINING_WIDGETS = ['ghosthud', 'traininginputs', 'trainingcorner', 'trainingsectors'].map((id) => 'js/widgets/' + id + '.js');
  const raceWidgets = training.filter((s) => s.startsWith('js/widgets/') && !TRAINING_WIDGETS.includes(s));
  check('training.html loads every training widget', TRAINING_WIDGETS.every((w) => training.includes(w)));
  check(
    'ingame.html loads no training widget',
    !ingame.some((s) => TRAINING_WIDGETS.includes(s) || s.startsWith('js/training-')),
  );
  check('training.html loads no race widget', raceWidgets.length === 0, raceWidgets.join(','));
  check(
    'training.html runs the shared runtime and layout manager, layout manager last',
    training.includes('js/client.js') && training[training.length - 1] === 'js/ingame.js',
  );
  check(
    'widget.html (OBS) still offers Ghost HUD',
    widget.includes('js/ghost-geom.js') && widget.includes('js/widgets/ghosthud.js'),
  );
  // OBS hosts every training widget, loaded exactly as the training page does.
  const trainingScripts = (list) => list.filter((s) => /ghost|training/.test(s));
  check(
    "widget.html loads the training scripts in training.html's order",
    trainingScripts(widget).join() === trainingScripts(training).join(),
    trainingScripts(widget).join(','),
  );
  const widgetHtml = read('widget.html');
  check(
    'widget.html has the training shells and styles',
    widgetHtml.includes('src="js/training-shells.js"') && widgetHtml.includes('href="css/training.css"'),
  );
  check(
    'ghost-geom.js loads before ghosthud.js on the training page',
    training.indexOf('js/ghost-geom.js') < training.indexOf('js/widgets/ghosthud.js'),
  );
  // Every widget reads its modules at load, so each must come after them.
  const needs = {
    'js/widgets/ghosthud.js': ['js/ghost-geom.js', 'js/ghost-pose.js', 'js/training-ghost.js'],
    'js/widgets/traininginputs.js': ['js/ghost-pose.js', 'js/training-trace.js', 'js/training-laps.js', 'js/training-ghost.js'],
    'js/widgets/trainingcorner.js': ['js/training-laps.js'],
    'js/widgets/trainingsectors.js': ['js/training-laps.js', 'js/training-ghost.js'],
  };
  const late = [];
  for (const [w, deps] of Object.entries(needs)) {
    for (const d of deps) {
      if (!(training.indexOf(d) >= 0 && training.indexOf(d) < training.indexOf(w))) late.push(`${d}→${w}`);
    }
  }
  check('training.html loads every module before the widgets that read it', late.length === 0, late.join(','));
  check('Ghost HUD has no /ghost.json fetch of its own (one shared fetch per page)',
    !/fetch\(\s*["']\/ghost\.json/.test(read('js/widgets/ghosthud.js')));
}

console.log('\ntraining layer: one list of training widgets');
{
  // The ids live in four places that cannot share code: main.js (the
  // catalog), training-shells.js (the browser pages), ingame.js (default
  // placements) and the bench. training.html reads training-shells.js's
  // list; the rest are held to it here.
  const vm = require('node:vm');
  const root = path.join(__dirname, '..');
  const src = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
  const page = { ApexShells: {} };
  page.window = page;
  vm.runInNewContext(src('overlay', 'js', 'training-shells.js'), page);
  const pageIds = (page.ApexTrainingWidgets || []).slice().sort().join(',');

  const main = src('electron', 'main.js');
  const cat = /const TRAINING_CATALOG = \[([\s\S]*?)\n\];/.exec(main);
  const catalogIds = cat ? Array.from(cat[1].matchAll(/^ {4}id: '([^']+)'/gm), (m) => m[1]).sort().join(',') : '';

  const ing = /function trainingDefaults\(vw, vh\) \{([\s\S]*?)\n {2}\}/.exec(src('overlay', 'js', 'ingame.js'));
  const placedIds = ing ? Array.from(ing[1].matchAll(/^ {6}([a-z0-9]+): \{/gm), (m) => m[1]).sort().join(',') : '';

  const bench = /const INGAME_OFF_BY_DEFAULT = new Set\(\[([\s\S]*?)\]\);/.exec(src('scripts', 'bench-widgets.js'));
  const benchOff = bench ? Array.from(bench[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g), (m) => m[1]) : [];

  check('training-shells.js lists the four training widgets', pageIds === 'ghosthud,trainingcorner,traininginputs,trainingsectors', pageIds);
  check("…and every one has a shell on the training page", (page.ApexTrainingWidgets || []).every((id) => id === 'ghosthud' || !!page.ApexShells[id]));
  check("main.js's TRAINING_CATALOG is the same list", catalogIds === pageIds, catalogIds);
  check("ingame.js places the same list on the training layer", placedIds === pageIds, placedIds);
  check('the bench keeps every one off the race layer', pageIds.split(',').every((id) => benchOff.includes(id)), benchOff.join(','));
  check('training.html takes its whitelist from training-shells.js', /window\.ApexTrainingWidgets/.test(src('overlay', 'training.html')) &&
    !/"traininginputs"/.test(src('overlay', 'training.html')));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
