/**
 * electron/trainingLayer.js — the training overlays' own window.
 * -----------------------------------------------------------------------------
 * Training widgets (Ghost HUD first) draw more than the race widgets do and are
 * only wanted in practice, so they do not share the race layer's window. They
 * get a second transparent, click-through, always-on-top window with its own
 * renderer process, loading overlay/training.html. It exists only while the
 * training gate is open and a training widget is switched on; the rest of the
 * time there is no window and no renderer, so a race pays nothing for it.
 *
 * Everything about the window copies the race layer (main.js syncOverlayWindow)
 * on purpose — same flags, same z-level, same geometry path through main's
 * applyOverlayGeometry (the work-area clamp and mixed-scaling handling) — so a
 * fix to one is visibly a fix owed to the other.
 *
 * What it does NOT share is recovery. It has its own layer watch and its own
 * diagnosis (lines headed TRAINING in stalls.log), and nothing in here can
 * reach the race window: a frozen Ghost HUD is reloaded or rebuilt on its own,
 * and a race-layer recovery never touches this one.
 *
 * Electron arrives through `deps`, so scripts/test-training-layer.js can drive
 * the lifecycle with a fake BrowserWindow.
 */

'use strict';

const { createLayerWatch, createLayerDiagnosis } = require('./layer-watch');

/** How often the paint reports are checked — the race layer's interval. */
const WATCH_TICK_MS = 2000;

/**
 * @param {object} deps
 * @param {Function} deps.BrowserWindow
 * @param {string}   deps.preload        path to the bridge (ingame-preload.js)
 * @param {(opts: {win: object, notify: boolean}) => void} deps.applyGeometry
 * @param {() => {x:number,y:number,width:number,height:number}} deps.initialBounds
 * @param {() => object} deps.appearance  the appearance payload for a fresh page
 * @param {(now: number) => boolean} deps.feedLive
 * @param {(line: string) => void} deps.log  stalls.log
 * @param {(win: object) => string} deps.processContext
 * @param {() => void} [deps.onChange]  the window came or went, or editing flipped
 * @param {() => number} [deps.now]
 */
function createTrainingLayer(deps) {
  const now = deps.now || Date.now;
  const watch = createLayerWatch();
  const diagnosis = createLayerDiagnosis({ label: 'TRAINING' });
  let win = null;
  let url = '';
  let editing = false;
  let visible = false;
  let watchTimer = null;

  const alive = () => !!win && !win.isDestroyed();
  const changed = () => {
    if (deps.onChange) deps.onChange();
  };

  function applyMouse() {
    if (!alive()) return;
    win.setIgnoreMouseEvents(!editing);
    try {
      win.setFocusable(editing);
    } catch {
      /* setFocusable unsupported here — mouse capture still works */
    }
  }

  function applyVisibility() {
    if (!alive()) return;
    // Edit mode always shows, as on the race layer: laying out from the sim's
    // menus has to work.
    const want = editing || visible;
    if (want === win.isVisible()) return;
    if (want) {
      watch.excuse(now());
      win.showInactive(); // never show(): the game keeps the focus
    } else {
      win.hide();
    }
  }

  function startWatch() {
    if (watchTimer) return;
    watchTimer = setInterval(tick, WATCH_TICK_MS);
    if (watchTimer.unref) watchTimer.unref();
  }

  function stopWatch() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  }

  /** One watch tick: the race layer's rules, acting on this window only. */
  function tick() {
    if (!alive()) return;
    const t = now();
    const verdict = watch.check({
      now: t,
      visible: win.isVisible(),
      loading: win.webContents.isLoading(),
      feedLive: deps.feedLive(t),
    });
    if (verdict.action === 'ok') return;
    const quiet = `no paint for ${verdict.quietMs}ms with the feed live`;
    if (verdict.action === 'give-up') {
      deps.log(`TRAINING still frozen after repeated recoveries (${quiet}) — leaving it`);
    } else if (verdict.action === 'reload') {
      deps.log(`TRAINING reloaded (${quiet})${deps.processContext(win)}`);
      diagnosis.reset();
      win.webContents.reload();
    } else {
      recreate(`${quiet}, again soon after a reload`);
    }
  }

  function build() {
    const b = deps.initialBounds();
    const w = new deps.BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      show: false,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      alwaysOnTop: true,
      title: 'Apex AIO (training)',
      webPreferences: {
        preload: deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // Keep painting while the game has focus.
        backgroundThrottling: false,
      },
    });
    win = w;
    // The constructor clamps to the primary work area; this is what sizes it.
    deps.applyGeometry({ win: w, notify: false });
    w.setAlwaysOnTop(true, 'screen-saver');
    applyMouse();
    applyVisibility();
    w.webContents.on('did-finish-load', () => {
      watch.excuse(now());
      if (w.isDestroyed()) return;
      w.webContents.send('ingame:appearance', deps.appearance());
      w.webContents.send('ingame:edit', editing);
    });
    w.webContents.on('render-process-gone', (_evt, details) => {
      const reason = (details && details.reason) || 'unknown';
      deps.log(`TRAINING renderer gone reason=${reason} exit=${details && details.exitCode}`);
      if (reason === 'clean-exit' || w.isDestroyed()) return;
      watch.excuse(now());
      try {
        w.webContents.reload();
      } catch {
        recreate('renderer gone, reload refused');
      }
    });
    w.webContents.on('unresponsive', () => deps.log('TRAINING renderer unresponsive'));
    w.webContents.on('responsive', () => deps.log('TRAINING renderer responsive again'));
    // Only this window may clear the slot — a rebuild replaces it in one breath.
    w.on('closed', () => {
      if (win !== w && win !== null) return;
      win = null;
      stopWatch();
      editing = false;
      changed();
    });
    watch.excuse(now());
    void w.loadURL(url);
    startWatch();
    changed();
  }

  function destroy() {
    editing = false;
    stopWatch();
    diagnosis.reset();
    const w = win;
    win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  /** A new window, a new renderer, a new surface — this layer's only. */
  function recreate(why) {
    deps.log(`TRAINING recreated (${why})${deps.processContext(win)}`);
    const keepUrl = url;
    destroy();
    url = keepUrl;
    build();
  }

  return {
    /**
     * Make the window match: exist with `next.url` when `next.wanted`, and be
     * on screen when `next.visible`. Idempotent — called on every settings
     * change and every gate flip.
     */
    sync(next) {
      visible = !!next.visible;
      if (!next.wanted) {
        if (win) {
          // A deliberate stop: the next window starts with a clean record.
          watch.forget();
          destroy();
          changed();
        }
        return;
      }
      if (alive()) {
        deps.applyGeometry({ win, notify: true });
        if (url !== next.url) {
          url = next.url;
          void win.loadURL(url);
        }
        applyVisibility();
        return;
      }
      url = next.url;
      build();
    },

    /** Auto show/hide moved (the driver went to the menus or came back). */
    setVisible(on) {
      visible = !!on;
      applyVisibility();
    },

    /** Lock or unlock the layer for dragging. Returns the new state. */
    setEditing(on) {
      editing = !!on && alive();
      if (!alive()) return editing;
      applyMouse();
      applyVisibility();
      // Both layers sit at the same z-level; whichever is being edited must be
      // the one on top, or the race widgets cover the handles.
      if (editing) win.moveTop();
      win.webContents.send('ingame:edit', editing);
      return editing;
    },

    /** One health report from this window's page (see overlay/js/client.js). */
    health(r) {
      if (!alive() || !r || typeof r !== 'object') return;
      const t = now();
      if (r.painted > 0) watch.painted(t);
      const lines = diagnosis.report(t, r, { visible: win.isVisible(), feedLive: deps.feedLive(t) });
      if (lines.length) {
        const ctx = deps.processContext(win);
        for (const line of lines) deps.log(line + ctx);
      }
    },

    /** Whether an IPC message came from this layer's page. */
    owns(sender) {
      return alive() && sender === win.webContents;
    },

    recreate(why) {
      if (alive()) recreate(why);
    },

    window: () => (alive() ? win : null),
    editing: () => editing,
    /** For tests: run one watch tick now. */
    _tick: tick,
  };
}

module.exports = { createTrainingLayer, WATCH_TICK_MS };
