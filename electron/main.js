/**
 * electron/main.js — Apex Overlay System desktop app (main process).
 * -----------------------------------------------------------------------------
 * Wraps the existing lightweight telemetry server in a small desktop window so
 * league members don't need a terminal. The Electron main process:
 *
 *   1. Runs the compiled telemetry server (dist/server) IN-PROCESS — same code
 *      as `npm start`, just started from here with settings from the UI.
 *   2. Persists the operator's choices (port, rate, demo mode, which overlays
 *      they use) to userData/config.json so it remembers between launches.
 *   3. Opens a control-panel window (the renderer) and exposes a small, safe
 *      IPC API to it via preload.js.
 *   4. Watches its own WebSocket feed so the panel can show LIVE / DEMO / NO DATA.
 *
 * The overlays themselves are unchanged: they are still served over HTTP and
 * added to OBS as Browser Sources. This app just makes running the server and
 * copying the overlay URLs painless.
 */

'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  clipboard,
  screen,
  globalShortcut,
  dialog,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');
const { autoUpdater } = require('electron-updater');

/* -------------------------------------------------------------------------- */
/*  Overlay catalog — every widget, each addable to OBS as its own source.    */
/* -------------------------------------------------------------------------- */

/**
 * The order here is the order shown in the control panel. `id` matches the
 * ?w=<id> value understood by overlay/widget.html and the widget's
 * data-widget attribute.
 */
const OVERLAY_CATALOG = [
  { id: 'standings', label: 'Standings', description: 'Full field, gaps, pit status' },
  { id: 'relative', label: 'Relative / Timing', description: 'Nearest cars, live delta' },
  { id: 'delta', label: 'Delta', description: 'Live gap to your best lap' },
  { id: 'pacedelta', label: 'Pace Delta', description: 'Δt + Δv vs session/all-time/last (Pacelogic-style)' },
  { id: 'weather', label: 'Weather', description: 'Current conditions + forecast' },
  { id: 'fuel', label: 'Fuel Calculator', description: 'Per-lap use, laps left, pit window' },
  // Interactive planner + fuel-ratio control: like the MFD it has clickable
  // inputs, so it defaults out of the locked, click-through in-game layer and
  // belongs in a browser tab / OBS source where the setup fields work.
  {
    id: 'fuelplan',
    label: 'Fuel Planner',
    description: 'Pre-race fuel/VE plan, live stint timer, fuel-ratio control (LMU only)',
    ingameDefault: false,
  },
  { id: 'tyres', label: 'Tyre Temps', description: 'Four-corner temperatures' },
  { id: 'pedals', label: 'Pedal Inputs', description: 'Throttle / brake / clutch trace' },
  { id: 'pedalsv', label: 'Pedal Inputs (Vertical)', description: 'Rising pedal levels + steering-angle arc' },
  { id: 'motion', label: 'Motion (G / Rotation / Attitude)', description: 'Traction circle, yaw + slip, pitch + roll' },
  { id: 'damage', label: 'Damage & Repair', description: "What's broken, and the sim's own repair time (LMU only)" },
  { id: 'radar', label: 'Proximity Radar', description: 'Spotter view — cars alongside, ahead and behind' },
  // A clickable control page, not a HUD graphic: it belongs in a browser tab
  // (or an OBS source as a readout), never the locked, click-through in-game
  // layer — so it defaults out of the in-game set.
  {
    id: 'mfd',
    label: 'MFD Control',
    description: 'Set pit strategy from the overlay — open in a browser to click (LMU only)',
    ingameDefault: false,
  },
];

/* -------------------------------------------------------------------------- */
/*  Persisted settings                                                        */
/* -------------------------------------------------------------------------- */

const MIN_PORT = 1;
const MAX_PORT = 65535;
const MIN_HZ = 1;
const MAX_HZ = 120;

/** Default settings for a fresh install (all overlays enabled). */
function defaultSettings() {
  const enabledOverlays = {};
  const ingameOverlays = {};
  for (const o of OVERLAY_CATALOG) {
    enabledOverlays[o.id] = true;
    ingameOverlays[o.id] = o.ingameDefault !== false;
  }
  return {
    httpPort: 8080,
    updateRateHz: 30,
    forceSimulator: false,
    provider: 'lmu', // 'lmu' | 'rf2' | 'simulator'
    lmuApiPort: 6397,
    enabledOverlays,
    // In-game display: overlays rendered over the sim itself (transparent
    // click-through window) instead of / as well as OBS Browser Sources.
    ingameEnabled: false,
    ingameOverlays,
    // Saved widget placement in the in-game layer:
    // { [id]: {x, y, scale, w?, h?} } — w/h are the operator's edge-resized
    // width/height in px; absent means "the widget's own size".
    ingameLayout: {},
    // Global hotkey that toggles the in-game overlay (Show in game). An Electron
    // accelerator string; '' means unbound. Rebindable from the control panel.
    ingameToggleShortcut: 'F8',
    // Global hotkey for INTERACT mode: makes the whole in-game layer clickable +
    // focusable so its widgets (Fuel Planner, MFD, etc.) can be operated over the
    // game, then handed back to the sim. '' means unbound.
    ingameInteractShortcut: 'F7',
    // Rotating sponsor logos under the standings tower. Images are copied into
    // <userData>/sponsors/ and served by our own server at /sponsors/ — see
    // `sponsorDir` in the server config for why they live outside overlay/.
    sponsorsEnabled: false,
    sponsorIntervalSec: 12,
    // Opacity of every widget's panel background, as a percentage. 100 is the
    // original solid design (fully occludes the sim's own HUD); 0 removes the
    // background, border and header from every widget so only the live data
    // floats over the game. Applied by overlay/js/appearance.js.
    panelOpacity: 100,
    // Global multiplier on the overlay's type scale, as a percentage. Every font
    // size in theme.css is declared as calc(Npx * var(--fs-scale)), so this moves
    // the whole hierarchy together rather than any one value: the relative
    // emphasis between critical, important and context text is a design
    // decision, but how big all of it needs to be depends on the operator's
    // screen size and how far away they sit. 80–120 (the widgets have fixed
    // widths, and past ~125% the busiest panels stop fitting their own text —
    // see SCALE_MAX in appearance.js), applied by appearance.js.
    textScale: 100,
    // Whether a critical value blooms cyan when it changes (see the crit()
    // helpers in overlay/js/client.js). On by default — it is the whole point of
    // marking a value critical — but it is a visual effect over live footage, so
    // it can be turned off for a broadcast that wants a completely static look.
    changeGlow: true,
    // Keyboard bindings, { [actionId]: accelerator } — see electron/actions.js
    // for the action vocabulary. Registered as GLOBAL hotkeys, so they also fire
    // while the sim has focus, and a Stream Deck "Hotkey" button (which just
    // injects a keystroke) binds here with no Stream-Deck-specific code.
    // The two overlay entries mirror the legacy single-purpose shortcut
    // settings below, which the hero-section chip still edits.
    actionBindings: {
      'overlay.toggle': 'F8',
      'overlay.interact': 'F7',
    },
    // Per-widget display mode, { [widgetId]: mode }. Empty means every widget
    // uses its own default, so this stays out of the way until something is
    // deliberately switched. Delivered with panelOpacity (see applyAppearance).
    widgetModes: {},
    // Wheel/controller bindings:
    //   { [actionId]: { inc?: {device, button}, dec?: {device, button} } }
    // A `delta` action can take two buttons (an encoder's two directions); a
    // `pulse` action uses `inc` alone. Kept separate from actionBindings because
    // a wheel button is a device+number, not an accelerator string — and unlike
    // a global hotkey it is NOT consumed, so the sim still sees it too.
    wheelBindings: {},
  };
}

/**
 * The modes each switchable widget cycles through, in order. The first entry is
 * the default and must preserve the widget's original behaviour, so an operator
 * who never touches this sees no change at all.
 */
const WIDGET_MODES = {
  // 'auto' keeps the existing core-temp → surface → tread fallback.
  tyres: ['auto', 'temp', 'surface', 'tread'],
};

/** Action ids whose binding is mirrored by a legacy single-purpose setting. */
const LEGACY_SHORTCUT_ACTIONS = {
  'overlay.toggle': 'ingameToggleShortcut',
  'overlay.interact': 'ingameInteractShortcut',
};

/** Directory holding the operator's copied-in sponsor logo images. */
function sponsorDir() {
  return path.join(app.getPath('userData'), 'sponsors');
}

/** Image extensions accepted as sponsor logos (mirrors the server's list). */
const SPONSOR_EXTS = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];

/** Sponsor logo filenames currently installed, sorted (= their display order). */
function listSponsors() {
  try {
    return fs
      .readdirSync(sponsorDir(), { withFileTypes: true })
      .filter((e) => e.isFile() && SPONSOR_EXTS.includes(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // no directory yet — nothing configured
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/** Clamp helper for numeric settings coming from disk or the UI. */
function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Normalize a global-shortcut accelerator from disk or the UI. Accepts any
 * string (validity is enforced at register time, wrapped in try/catch); an
 * empty string is the explicit "unbound" state. Non-strings fall back.
 */
function normalizeShortcut(value, fallback) {
  if (value === '') return '';
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

/** Bounds for an in-game widget's edge-resized width/height, in px. */
const MIN_ITEM_PX = 56;
const MAX_ITEM_PX = 4000;

/**
 * Validate one in-game placement entry, or null if it isn't one. Shared by the
 * load and save paths so a layout can never be normalized two different ways.
 *
 * `w`/`h` are optional and only carried when genuinely present: their absence is
 * meaningful (use the widget's design width / let the content set the height),
 * so a missing value must not be written back as a 0.
 */
function normalizeLayoutEntry(l) {
  if (!l || !Number.isFinite(l.x) || !Number.isFinite(l.y)) return null;
  const entry = {
    x: Math.round(l.x),
    y: Math.round(l.y),
    scale: Number.isFinite(l.scale) ? Math.min(3, Math.max(0.4, l.scale)) : 1,
  };
  if (Number.isFinite(l.w) && l.w > 0) {
    entry.w = clamp(l.w, MIN_ITEM_PX, MAX_ITEM_PX, MIN_ITEM_PX);
  }
  if (Number.isFinite(l.h) && l.h > 0) {
    entry.h = clamp(l.h, MIN_ITEM_PX, MAX_ITEM_PX, MIN_ITEM_PX);
  }
  return entry;
}

/** Load settings, merged over defaults so missing/old keys are filled in. */
function loadSettings() {
  const defaults = defaultSettings();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {};
  } catch {
    stored = {}; // first run or unreadable — use defaults
  }
  const enabledOverlays = { ...defaults.enabledOverlays };
  const ingameOverlays = { ...defaults.ingameOverlays };
  for (const o of OVERLAY_CATALOG) {
    if (stored.enabledOverlays && typeof stored.enabledOverlays[o.id] === 'boolean') {
      enabledOverlays[o.id] = stored.enabledOverlays[o.id];
    }
    if (stored.ingameOverlays && typeof stored.ingameOverlays[o.id] === 'boolean') {
      ingameOverlays[o.id] = stored.ingameOverlays[o.id];
    }
  }
  const ingameLayout = {};
  if (stored.ingameLayout && typeof stored.ingameLayout === 'object') {
    for (const o of OVERLAY_CATALOG) {
      const entry = normalizeLayoutEntry(stored.ingameLayout[o.id]);
      if (entry) ingameLayout[o.id] = entry;
    }
  }
  return {
    httpPort: clamp(stored.httpPort, MIN_PORT, MAX_PORT, defaults.httpPort),
    updateRateHz: clamp(stored.updateRateHz, MIN_HZ, MAX_HZ, defaults.updateRateHz),
    forceSimulator:
      typeof stored.forceSimulator === 'boolean' ? stored.forceSimulator : defaults.forceSimulator,
    provider:
      stored.provider === 'lmu' || stored.provider === 'rf2' || stored.provider === 'simulator'
        ? stored.provider
        : defaults.provider,
    lmuApiPort: clamp(stored.lmuApiPort, MIN_PORT, MAX_PORT, defaults.lmuApiPort),
    enabledOverlays,
    ingameEnabled:
      typeof stored.ingameEnabled === 'boolean' ? stored.ingameEnabled : defaults.ingameEnabled,
    ingameOverlays,
    ingameLayout,
    ingameToggleShortcut: normalizeShortcut(
      stored.ingameToggleShortcut,
      defaults.ingameToggleShortcut,
    ),
    ingameInteractShortcut: normalizeShortcut(
      stored.ingameInteractShortcut,
      defaults.ingameInteractShortcut,
    ),
    sponsorsEnabled:
      typeof stored.sponsorsEnabled === 'boolean'
        ? stored.sponsorsEnabled
        : defaults.sponsorsEnabled,
    sponsorIntervalSec: clamp(stored.sponsorIntervalSec, 3, 120, defaults.sponsorIntervalSec),
    panelOpacity: clamp(stored.panelOpacity, 0, 100, defaults.panelOpacity),
    textScale: clamp(stored.textScale, 80, 120, defaults.textScale),
    changeGlow:
      typeof stored.changeGlow === 'boolean' ? stored.changeGlow : defaults.changeGlow,
    actionBindings: normalizeBindings(stored, defaults),
    widgetModes: normalizeWidgetModes(stored),
    wheelBindings: normalizeWheelBindings(stored),
  };
}

/** Validate the wheel binding map; a malformed entry is dropped, not trusted. */
function normalizeWheelBindings(stored) {
  const out = {};
  const from = stored && typeof stored.wheelBindings === 'object' ? stored.wheelBindings : null;
  if (!from) return out;
  for (const [actionId, entry] of Object.entries(from)) {
    if (typeof actionId !== 'string' || !entry || typeof entry !== 'object') continue;
    const clean = {};
    for (const dir of ['inc', 'dec']) {
      const b = entry[dir];
      if (b && typeof b.device === 'string' && Number.isFinite(b.button) && b.button > 0) {
        clean[dir] = { device: b.device, button: Math.round(b.button) };
      }
    }
    if (clean.inc || clean.dec) out[actionId] = clean;
  }
  return out;
}

/** Keep only widget/mode pairs we still recognise, so a stale config is inert. */
function normalizeWidgetModes(stored) {
  const out = {};
  const from = stored && typeof stored.widgetModes === 'object' ? stored.widgetModes : null;
  if (!from) return out;
  for (const [widget, mode] of Object.entries(from)) {
    const allowed = WIDGET_MODES[widget];
    if (allowed && allowed.includes(mode)) out[widget] = mode;
  }
  return out;
}

/**
 * Resolve the action→accelerator map from disk.
 *
 * Migration matters here: installs predating the bindings map have only the two
 * legacy shortcut fields, so those seed the corresponding actions rather than
 * being silently dropped — an operator who set F9 for "show in game" keeps F9.
 */
function normalizeBindings(stored, defaults) {
  const out = {};
  const from = stored && typeof stored.actionBindings === 'object' ? stored.actionBindings : null;
  if (from) {
    for (const [id, accel] of Object.entries(from)) {
      if (typeof id === 'string' && typeof accel === 'string') out[id] = accel.trim();
    }
  }
  for (const [actionId, legacyKey] of Object.entries(LEGACY_SHORTCUT_ACTIONS)) {
    if (out[actionId] === undefined) {
      const legacy = stored ? stored[legacyKey] : undefined;
      out[actionId] =
        typeof legacy === 'string' ? legacy.trim() : defaults.actionBindings[actionId];
    }
  }
  return out;
}

/** Persist settings to userData, tolerant of transient write failures. */
function saveSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[app] failed to save settings:', err.message);
  }
}

/* -------------------------------------------------------------------------- */
/*  Telemetry server lifecycle (runs the compiled dist/server in-process)     */
/* -------------------------------------------------------------------------- */

let serverModule = null; // lazily required from dist
let shutdownFn = null; // resolves the running server's shutdown
let starting = false;

/** Absolute path to the overlay assets, both in dev and inside the package. */
function overlayDir() {
  return path.join(__dirname, '..', 'overlay');
}

/** Build the server's ServerConfig from persisted settings. */
function buildServerConfig(settings) {
  return {
    host: '127.0.0.1',
    httpPort: settings.httpPort,
    wsPort: settings.httpPort, // WS shares the HTTP port
    wsPath: '/ws',
    updateRateHz: settings.updateRateHz,
    overlayDir: overlayDir(), // absolute — resolve(cwd, abs) === abs
    forceSimulator: settings.forceSimulator,
    // Le Mans Ultimate REST API is the default live source (robust, whole-field).
    provider: settings.provider === 'rf2' || settings.provider === 'simulator'
      ? settings.provider
      : 'lmu',
    lmuApiPort: Number.isFinite(settings.lmuApiPort) ? settings.lmuApiPort : 6397,
    // Empty when sponsors are off, which makes the server 404 the whole
    // /sponsors/ route rather than serving a directory nobody asked for.
    sponsorDir: settings.sponsorsEnabled ? sponsorDir() : '',
    sponsorIntervalSec: settings.sponsorIntervalSec,
    // Boot values only — changes are pushed live via applyAppearance(), so the
    // sliders never restart the server.
    panelOpacity: settings.panelOpacity,
    textScale: settings.textScale,
    changeGlow: settings.changeGlow,
    verbose: false,
  };
}

/** Require the compiled server, surfacing a clear error if it isn't built. */
function requireServer() {
  if (serverModule) return serverModule;
  const entry = path.join(__dirname, '..', 'dist', 'server', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(
      'Server build not found (dist/server/index.js). Run "npm run build" first.',
    );
  }
  serverModule = require(entry);
  return serverModule;
}

/** Start (or restart) the telemetry server with the current settings. */
async function startServer() {
  if (starting) return;
  starting = true;
  try {
    await stopServer();
    const settings = loadSettings();
    const config = buildServerConfig(settings);
    const mod = requireServer();
    shutdownFn = await mod.start(config);
    status.running = true;
    status.port = config.httpPort;
    status.error = null;
    connectStatusFeed(config.httpPort, config.wsPath);
    syncOverlayWindow();
    console.log(`[app] server started on port ${config.httpPort}`);
  } catch (err) {
    status.running = false;
    status.feed = 'stopped';
    // Translate the most common failure (busy port) into plain language.
    status.error = /EADDRINUSE/.test(err.message)
      ? `Port ${loadSettings().httpPort} is already in use. Change the port and try again.`
      : err.message;
    console.error('[app] failed to start server:', err.message);
  } finally {
    starting = false;
    pushStatus();
  }
}

/** Stop the telemetry server if running. */
async function stopServer() {
  destroyOverlayWindow();
  disconnectStatusFeed();
  if (shutdownFn) {
    try {
      await shutdownFn();
    } catch (err) {
      console.error('[app] error during shutdown:', err.message);
    }
    shutdownFn = null;
  }
  status.running = false;
  status.feed = 'stopped';
  pushStatus();
}

/* -------------------------------------------------------------------------- */
/*  Live status feed — main process peeks at its own WS to report the state.  */
/* -------------------------------------------------------------------------- */

const NO_DATA_MS = 2500; // no frame within this window => "no-data"

const status = {
  running: false,
  port: null,
  feed: 'stopped', // 'stopped' | 'no-data' | 'demo' | 'live'
  demo: false,
  error: null,
};

let statusWs = null;
let lastFrameAt = 0;
let feedWatchTimer = null;

function connectStatusFeed(port, wsPath) {
  disconnectStatusFeed();
  lastFrameAt = 0;
  const url = `ws://127.0.0.1:${port}${wsPath}`;
  try {
    statusWs = new WebSocket(url);
  } catch {
    statusWs = null;
    return;
  }
  statusWs.on('message', (data) => {
    lastFrameAt = Date.now();
    try {
      const frame = JSON.parse(data.toString());
      // client.js treats connected === false as the demo/simulator feed.
      const demo = !!(frame && frame.connected === false);
      const feed = demo ? 'demo' : 'live';
      // Push only on a genuine transition. Frames arrive at the broadcast rate
      // (up to 120/s) and the feed flag changes perhaps twice a session, so an
      // unconditional push here would be far worse than the 1 Hz churn this
      // replaced. The watchdog below owns the opposite transition (→ no-data).
      if (demo !== status.demo || feed !== status.feed) {
        status.demo = demo;
        status.feed = feed;
        pushStatus();
      }
    } catch {
      /* ignore malformed frame */
    }
  });
  statusWs.on('error', () => {
    /* reported via the no-data watchdog below */
  });

  // Watchdog: if frames stop arriving, reflect "no data" in the panel.
  //
  // Only pushes when something actually changed. It used to send unconditionally
  // every second, which re-rendered the whole panel once a second for the entire
  // time the app was open — pure churn, since the live/demo/no-data flag is the
  // only thing this timer can alter, and the socket's own message handler
  // already pushes when the feed state flips the other way.
  feedWatchTimer = setInterval(() => {
    if (!status.running) return;
    const stale = lastFrameAt === 0 || Date.now() - lastFrameAt > NO_DATA_MS;
    if (stale && status.feed !== 'no-data') {
      status.feed = 'no-data';
      pushStatus();
    }
  }, 1000);
  feedWatchTimer.unref?.();
}

function disconnectStatusFeed() {
  if (feedWatchTimer) {
    clearInterval(feedWatchTimer);
    feedWatchTimer = null;
  }
  if (statusWs) {
    try {
      statusWs.terminate();
    } catch {
      /* ignore */
    }
    statusWs = null;
  }
}

/** Status snapshot for the UI, including the in-game edit state. */
function statusForUi() {
  return { ...status, ingameEditing };
}

/** Push the current status object to the renderer (if the window is open). */
function pushStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status:update', statusForUi());
  }
}

/** Push the current settings to the renderer so its controls stay in sync. */
function pushSettings(settings) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings:changed', settings);
  }
}

/**
 * Flip the "Show in game" setting and reflect it everywhere: persist, re-sync
 * the overlay window, and update the control panel. Invoked by the global
 * hotkey (and reusable elsewhere).
 */
function toggleIngame() {
  const settings = loadSettings();
  const next = { ...settings, ingameEnabled: !settings.ingameEnabled };
  saveSettings(next);
  syncOverlayWindow();
  pushStatus();
  pushSettings(next);
}

/**
 * Applies the appearance settings — widget-background opacity, text scale and
 * the change glow — everywhere they are consumed, with no restart and no reload:
 *
 *   - the running server, which serves it at /appearance.json to OBS Browser
 *     Sources and browser tabs (they re-read it about once a second);
 *   - the in-game layer, pushed straight to the window so the operator sees the
 *     background fade as they drag the slider.
 *
 * Safe to call before the server is up (the require simply fails and the value
 * is picked up from the config at the next start).
 */
function applyAppearance(settings) {
  const s = settings || loadSettings();
  const payload = {
    panelOpacity: s.panelOpacity,
    textScale: s.textScale,
    changeGlow: s.changeGlow,
    widgetModes: s.widgetModes || {},
  };
  try {
    requireServer().setAppearance(payload);
  } catch (err) {
    // Not built / not started yet — buildServerConfig() carries the value in.
  }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('ingame:appearance', payload);
  }
}

/* -------------------------------------------------------------------------- */
/*  Action registry — the vocabulary every input source binds to               */
/* -------------------------------------------------------------------------- */

/** Lazily built so it sees a working dist/ and the current settings. */
let actions = null;

/**
 * Persist a partial settings change and reflect it everywhere, the same way the
 * IPC handler does. Actions use this so a bound encoder turning the background
 * opacity behaves identically to dragging the slider in the panel.
 */
function applySettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...partial };
  saveSettings(next);
  // Both of these ride the appearance channel, so either changing means the
  // overlays need re-telling.
  if (
    (partial.panelOpacity !== undefined && partial.panelOpacity !== current.panelOpacity) ||
    partial.widgetModes !== undefined
  ) {
    applyAppearance(next);
  }
  pushSettings(next);
  return next;
}

function getActions() {
  if (!actions) {
    const { createActions } = require('./actions');
    actions = createActions({
      loadSettings,
      applySettings,
      toggleIngame,
      toggleIngameInteract,
      resetLayout: () => {
        const settings = loadSettings();
        saveSettings({ ...settings, ingameLayout: {} });
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('ingame:layout-reset');
        }
      },
      /** Advance a widget to its next display mode and push it to the overlays. */
      cycleWidgetMode: (widgetId) => {
        const modes = WIDGET_MODES[widgetId];
        if (!modes) return;
        const settings = loadSettings();
        const current = (settings.widgetModes || {})[widgetId] || modes[0];
        const next = modes[(modes.indexOf(current) + 1) % modes.length];
        applySettings({ widgetModes: { ...settings.widgetModes, [widgetId]: next } });
      },
    });
  }
  return actions;
}

/* -------------------------------------------------------------------------- */
/*  Wheel / controller input                                                   */
/* -------------------------------------------------------------------------- */

let gamepad = null;
/** Set while the bindings UI is waiting for the operator to press a button. */
let wheelCapture = null;

/**
 * The reader, created on first use. Polling is only started when something is
 * actually bound to a wheel button (or a capture is open), so an operator who
 * binds nothing pays no cost at all.
 */
function getGamepad() {
  if (!gamepad) {
    const { GamepadReader } = require('./gamepad');
    gamepad = new GamepadReader({
      verbose: false,
      onButton: (device, button, down) => onWheelButton(device, button, down),
    });
  }
  return gamepad;
}

/** Start/stop polling to match whether any binding (or capture) needs it. */
function syncGamepad(settings) {
  const s = settings || loadSettings();
  const wanted =
    wheelCapture !== null ||
    Object.keys(s.wheelBindings || {}).length > 0 ||
    // Also poll purely to KEEP THE AID SHADOW HONEST while the server is up: the
    // estimated aids are only trustworthy if we see the driver's wheel presses
    // too. One small state read per device per tick, so this is cheap.
    (status.running && wantsAidFollow());
  if (!wanted && !gamepad) return; // never opened, nothing to do
  getGamepad().setActive(wanted);
}

/**
 * A wheel button changed. Only the press edge acts: a held button should fire
 * once, and an encoder detent arrives as a rapid down/up pair, so acting on the
 * release as well would double every step.
 */
function onWheelButton(device, button, down) {
  if (!down) return;

  if (wheelCapture) {
    const capture = wheelCapture;
    wheelCapture = null;
    capture.resolve({ ok: true, device, button });
    syncGamepad();
    return;
  }

  // The driver may adjust an aid on their WHEEL rather than through the overlay
  // — those presses go straight to LMU and we never see a request. Watching the
  // very buttons LMU is bound to is what stops the estimated TC/ABS/motor-map
  // values drifting the moment the wheel is used.
  followWheelAid(device, button);

  const bindings = loadSettings().wheelBindings || {};
  for (const [actionId, entry] of Object.entries(bindings)) {
    for (const dir of ['inc', 'dec']) {
      const b = entry[dir];
      if (b && b.device === device && b.button === button) {
        void runAction(actionId, dir === 'dec' ? -1 : 1);
      }
    }
  }
}

/** LMU's bind set, cached — re-reading a file per button edge would be silly. */
let lmuBindCache = { at: 0, binds: null };
const LMU_BIND_TTL_MS = 10_000;

function lmuBinds() {
  const now = Date.now();
  if (lmuBindCache.binds && now - lmuBindCache.at < LMU_BIND_TTL_MS) return lmuBindCache.binds;
  try {
    const kb = require(path.join(__dirname, '..', 'dist', 'server', 'lmuKeybinds.js'));
    lmuBindCache = { at: now, binds: kb.readLmuKeybinds() };
  } catch {
    lmuBindCache = { at: now, binds: null };
  }
  return lmuBindCache.binds;
}

/** True when any tracked aid has a wheel button, i.e. following is worth doing. */
function wantsAidFollow() {
  const binds = lmuBinds();
  if (!binds) return false;
  try {
    const shadow = require(path.join(__dirname, '..', 'dist', 'server', 'aidShadow.js'));
    return binds.aids.some(
      (a) => shadow.isTracked(a.id) && (a.incWheel || a.decWheel),
    );
  } catch {
    return false;
  }
}

/** Nudge the shadow when a watched wheel button steps an aid in-game. */
function followWheelAid(device, button) {
  const binds = lmuBinds();
  if (!binds) return;
  let shadow;
  try {
    shadow = require(path.join(__dirname, '..', 'dist', 'server', 'aidShadow.js'));
  } catch {
    return;
  }
  for (const aid of binds.aids) {
    if (!shadow.isTracked(aid.id)) continue;
    const inc = aid.incWheel;
    const dec = aid.decWheel;
    if (inc && inc.device === device && inc.button === button) shadow.bump(aid.id, 1, 'wheel');
    else if (dec && dec.device === device && dec.button === button) shadow.bump(aid.id, -1, 'wheel');
  }
}

/** Run an action by id, logging failures rather than letting them escape. */
async function runAction(id, dir) {
  const result = await getActions().run(id, dir);
  if (result && result.ok === false) {
    console.warn(`[action] ${id} failed: ${result.error}`);
  }
  return result;
}

/**
 * (Re)register every keyboard binding as a GLOBAL hotkey, so it fires while the
 * sim has focus — and so a Stream Deck button, which merely injects a keystroke,
 * works through the same path with nothing Stream-Deck-specific in the app.
 *
 * Clears previous registrations first; an empty accelerator means unbound. Each
 * registration is wrapped so one invalid or already-taken accelerator can never
 * crash startup or block the rest.
 *
 * Note a global hotkey is CONSUMED: the key will not also reach LMU. Bindings
 * should therefore use keys the sim does not itself bind — surfaced in the UI.
 *
 * @returns {{registered: string[], failed: {action: string, accel: string, reason: string}[]}}
 */
function applyBindings(settings) {
  globalShortcut.unregisterAll();
  const s = settings || loadSettings();
  const result = { registered: [], failed: [] };
  const seen = new Map(); // accelerator -> first action that claimed it

  for (const [actionId, accel] of Object.entries(s.actionBindings || {})) {
    if (!accel) continue;
    if (seen.has(accel)) {
      result.failed.push({
        action: actionId,
        accel,
        reason: `already bound to "${seen.get(accel)}"`,
      });
      continue;
    }
    try {
      const ok = globalShortcut.register(accel, () => {
        void runAction(actionId, 1);
      });
      if (ok) {
        seen.set(accel, actionId);
        result.registered.push(actionId);
      } else {
        result.failed.push({ action: actionId, accel, reason: 'in use by another app' });
      }
    } catch (err) {
      result.failed.push({ action: actionId, accel, reason: err.message });
    }
  }
  for (const f of result.failed) {
    console.warn(`[app] hotkey "${f.accel}" for ${f.action} not registered: ${f.reason}`);
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Overlay URL helpers                                                        */
/* -------------------------------------------------------------------------- */

function baseUrl() {
  const port = status.port || loadSettings().httpPort;
  return `http://127.0.0.1:${port}`;
}

/**
 * Whether an overlay is in the in-game layer: an explicit saved choice wins,
 * otherwise the catalog default (all HUD widgets on; control pages like MFD off).
 * A never-before-seen id (new in an update) therefore takes the catalog default
 * rather than being force-enabled.
 */
function isIngame(settings, o) {
  if (o.id in settings.ingameOverlays) return settings.ingameOverlays[o.id] !== false;
  return o.ingameDefault !== false;
}

/** Full catalog with per-overlay OBS URLs and enabled state for the UI. */
function overlaysForUi() {
  const settings = loadSettings();
  const base = baseUrl();
  return OVERLAY_CATALOG.map((o) => ({
    ...o,
    enabled: settings.enabledOverlays[o.id] !== false,
    ingame: isIngame(settings, o),
    url: `${base}/widget.html?w=${o.id}`,
  }));
}

/* -------------------------------------------------------------------------- */
/*  In-game overlay layer                                                      */
/* -------------------------------------------------------------------------- */
/*
 * ONE transparent, frameless, always-on-top window spanning the primary
 * display hosts every in-game widget (a single renderer process — far lighter
 * than a window per widget). While locked it is fully click-through
 * (setIgnoreMouseEvents) and non-focusable, so the game never loses input.
 * "Edit layout" re-enables mouse events so the operator can drag/resize
 * widgets on screen; placement is persisted to settings.ingameLayout.
 * The window is destroyed whenever it is not needed, freeing its renderer.
 *
 * Note: the game must run Borderless/Windowed (normal for sim racing) — an
 * exclusive-fullscreen game draws over every OS window, including this one.
 */

let overlayWin = null;
let ingameEditing = false;
let ingameInteractive = false;

/** URL of the in-game layer page, carrying the enabled widget list. */
function ingameUrl(settings) {
  const ids = OVERLAY_CATALOG.filter((o) => isIngame(settings, o)).map((o) => o.id);
  return `${baseUrl()}/ingame.html?widgets=${ids.join(',')}`;
}

/** Creates/reloads/destroys the in-game window to match settings + status. */
function syncOverlayWindow() {
  const settings = loadSettings();
  const wanted =
    status.running &&
    settings.ingameEnabled &&
    OVERLAY_CATALOG.some((o) => settings.ingameOverlays[o.id] !== false);

  if (!wanted) {
    destroyOverlayWindow();
    return;
  }

  const url = ingameUrl(settings);
  if (overlayWin && !overlayWin.isDestroyed()) {
    if (overlayWin.ingameUrl !== url) {
      overlayWin.ingameUrl = url;
      void overlayWin.loadURL(url);
    }
    return;
  }

  const bounds = screen.getPrimaryDisplay().bounds;
  overlayWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Never steal focus from the game — mouse still works in edit mode.
    focusable: false,
    alwaysOnTop: true,
    title: 'Apex Overlays (in-game)',
    webPreferences: {
      preload: path.join(__dirname, 'ingame-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep telemetry painting while the game window has focus.
      backgroundThrottling: false,
    },
  });
  // 'screen-saver' level floats above borderless-fullscreen game windows.
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  applyIngameMouse(); // click-through unless edit/interact is already on
  overlayWin.ingameUrl = url;
  // The layer is push-fed its appearance (it deliberately does no polling), so
  // every load — including the reloads triggered by a widget-list change — has
  // to be re-told the current value.
  overlayWin.webContents.on('did-finish-load', () => applyAppearance());
  void overlayWin.loadURL(url);
  overlayWin.on('closed', () => {
    overlayWin = null;
    ingameInteractive = false;
    if (ingameEditing) setIngameEdit(false);
  });
}

function destroyOverlayWindow() {
  if (ingameEditing) setIngameEdit(false);
  ingameInteractive = false;
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  overlayWin = null;
}

/**
 * Derives the window's mouse/focus state from the edit + interact flags. The
 * layer captures the mouse (and becomes focusable, so text fields and dropdowns
 * work) whenever either mode is active; otherwise it is fully click-through and
 * non-focusable so the game keeps all input.
 */
function applyIngameMouse() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const active = ingameEditing || ingameInteractive;
  overlayWin.setIgnoreMouseEvents(!active);
  try {
    overlayWin.setFocusable(active);
  } catch (e) {
    /* setFocusable unsupported here — mouse capture still works */
  }
}

/** Locks/unlocks the layer for on-screen editing and tells both windows. */
function setIngameEdit(editing) {
  ingameEditing = !!editing;
  if (overlayWin && !overlayWin.isDestroyed()) {
    applyIngameMouse();
    overlayWin.webContents.send('ingame:edit', ingameEditing);
  }
  pushStatus();
}

/**
 * Interact mode: make the whole in-game layer clickable + focusable so its
 * widgets (Fuel Planner setup, fuel-ratio buttons, MFD…) can be operated over
 * the running game, then handed back. Distinct from edit mode — no drag/resize,
 * the widgets' own controls receive the clicks (see overlay/js/ingame.js).
 */
function setIngameInteract(on) {
  ingameInteractive = !!on;
  if (overlayWin && !overlayWin.isDestroyed()) {
    applyIngameMouse();
    // Focus the layer so keyboard input (Race min, etc.) works; release on exit
    // so the sim regains input.
    try {
      if (ingameInteractive) overlayWin.focus();
      else overlayWin.blur();
    } catch (e) {
      /* best-effort focus handoff */
    }
    overlayWin.webContents.send('ingame:interact', ingameInteractive);
  }
  pushStatus();
}

/** Hotkey handler: ensure the layer exists, then flip interact mode. */
function toggleIngameInteract() {
  syncOverlayWindow();
  setIngameInteract(!ingameInteractive);
}

/* -------------------------------------------------------------------------- */
/*  IPC — the safe API the control panel calls (see preload.js)               */
/* -------------------------------------------------------------------------- */

function registerIpc() {
  ipcMain.handle('app:getState', () => ({
    settings: loadSettings(),
    overlays: overlaysForUi(),
    combinedUrl: `${baseUrl()}/`,
    status: statusForUi(),
    // The running build, straight from the packaged package.json. Shown in the
    // top bar so a user reporting a bug can say which version they are on
    // without hunting through Add/Remove Programs.
    appVersion: app.getVersion(),
  }));

  ipcMain.handle('settings:update', async (_evt, partial) => {
    const current = loadSettings();
    const next = { ...current };
    if (partial && typeof partial === 'object') {
      if (partial.httpPort !== undefined) {
        next.httpPort = clamp(partial.httpPort, MIN_PORT, MAX_PORT, current.httpPort);
      }
      if (partial.updateRateHz !== undefined) {
        next.updateRateHz = clamp(partial.updateRateHz, MIN_HZ, MAX_HZ, current.updateRateHz);
      }
      if (typeof partial.forceSimulator === 'boolean') {
        next.forceSimulator = partial.forceSimulator;
      }
      if (partial.enabledOverlays && typeof partial.enabledOverlays === 'object') {
        next.enabledOverlays = { ...current.enabledOverlays, ...partial.enabledOverlays };
      }
      if (typeof partial.ingameEnabled === 'boolean') {
        next.ingameEnabled = partial.ingameEnabled;
      }
      if (partial.ingameOverlays && typeof partial.ingameOverlays === 'object') {
        next.ingameOverlays = { ...current.ingameOverlays, ...partial.ingameOverlays };
      }
      if (typeof partial.ingameToggleShortcut === 'string') {
        next.ingameToggleShortcut = normalizeShortcut(
          partial.ingameToggleShortcut,
          current.ingameToggleShortcut,
        );
      }
      if (typeof partial.sponsorsEnabled === 'boolean') {
        next.sponsorsEnabled = partial.sponsorsEnabled;
      }
      if (partial.sponsorIntervalSec !== undefined) {
        next.sponsorIntervalSec = clamp(partial.sponsorIntervalSec, 3, 120, current.sponsorIntervalSec);
      }
      if (partial.panelOpacity !== undefined) {
        next.panelOpacity = clamp(partial.panelOpacity, 0, 100, current.panelOpacity);
      }
      if (partial.actionBindings && typeof partial.actionBindings === 'object') {
        next.actionBindings = { ...current.actionBindings };
        for (const [id, accel] of Object.entries(partial.actionBindings)) {
          if (typeof id !== 'string' || typeof accel !== 'string') continue;
          next.actionBindings[id] = accel.trim();
          // Keep the legacy single-purpose settings in step so the hero-section
          // hotkey chip keeps showing the truth.
          const legacyKey = LEGACY_SHORTCUT_ACTIONS[id];
          if (legacyKey) next[legacyKey] = accel.trim();
        }
      }
    }

    // The legacy chip writes ingameToggleShortcut directly; mirror it back into
    // the bindings map, which is what actually gets registered.
    for (const [actionId, legacyKey] of Object.entries(LEGACY_SHORTCUT_ACTIONS)) {
      if (partial && typeof partial[legacyKey] === 'string') {
        next.actionBindings = { ...next.actionBindings, [actionId]: next[legacyKey] };
      }
    }
    saveSettings(next);

    // Look-and-feel only: applied live to the server and the in-game layer, so
    // these are deliberately NOT part of the restart check below.
    if (
      next.panelOpacity !== current.panelOpacity ||
      next.textScale !== current.textScale ||
      next.changeGlow !== current.changeGlow
    ) {
      applyAppearance(next);
    }

    // Re-register hotkeys whenever any binding changed. Compared as a whole map
    // rather than per-key: a rebind, a clear and a brand-new binding all need
    // the same re-registration pass.
    if (JSON.stringify(next.actionBindings) !== JSON.stringify(current.actionBindings)) {
      applyBindings(next);
    }

    // Port, rate, demo and sponsor changes require a server restart to take
    // effect — the sponsor route and interval are baked into the ServerConfig at
    // boot, so without this the /sponsors/ endpoint keeps its old behaviour.
    const needsRestart =
      status.running &&
      (next.httpPort !== current.httpPort ||
        next.updateRateHz !== current.updateRateHz ||
        next.forceSimulator !== current.forceSimulator ||
        next.sponsorsEnabled !== current.sponsorsEnabled ||
        next.sponsorIntervalSec !== current.sponsorIntervalSec);
    if (needsRestart) await startServer();
    // Reflect in-game display choices immediately (create/reload/close layer).
    syncOverlayWindow();

    return {
      settings: next,
      overlays: overlaysForUi(),
      combinedUrl: `${baseUrl()}/`,
      status: statusForUi(),
    };
  });

  // --- Sponsor logos ------------------------------------------------------
  // Images are COPIED into <userData>/sponsors/ rather than referenced where the
  // user picked them: the overlay is served over HTTP, so an arbitrary path on
  // disk is not reachable, and a copy also survives the user moving or deleting
  // the original mid-season.

  ipcMain.handle('sponsors:list', () => listSponsors());

  ipcMain.handle('sponsors:add', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add sponsor logos',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'] }],
    });
    if (result.canceled) return listSponsors();
    try {
      fs.mkdirSync(sponsorDir(), { recursive: true });
    } catch (err) {
      console.error('[app] cannot create sponsor dir:', err.message);
      return listSponsors();
    }
    for (const src of result.filePaths) {
      // Keep the original name where possible, but never let a picked file
      // overwrite one already in place — suffix instead.
      const ext = path.extname(src);
      const stem = path.basename(src, ext);
      let name = stem + ext;
      let n = 2;
      while (fs.existsSync(path.join(sponsorDir(), name))) name = `${stem}-${n++}${ext}`;
      try {
        fs.copyFileSync(src, path.join(sponsorDir(), name));
      } catch (err) {
        console.error('[app] failed to copy sponsor logo:', err.message);
      }
    }
    return listSponsors();
  });

  ipcMain.handle('sponsors:remove', (_evt, name) => {
    // Only ever delete a plain filename inside our own directory — never a path
    // the renderer supplies verbatim.
    if (typeof name !== 'string' || name !== path.basename(name)) return listSponsors();
    try {
      fs.unlinkSync(path.join(sponsorDir(), name));
    } catch {
      /* already gone */
    }
    return listSponsors();
  });

  ipcMain.handle('server:start', async () => {
    await startServer();
    return statusForUi();
  });

  ipcMain.handle('server:stop', async () => {
    await stopServer();
    return statusForUi();
  });

  /* ---- In-game overlay layer ---- */

  ipcMain.handle('ingame:editStart', () => {
    syncOverlayWindow(); // make sure the layer exists before unlocking it
    setIngameEdit(true);
    return statusForUi();
  });

  ipcMain.handle('ingame:editStop', () => {
    setIngameEdit(false);
    return statusForUi();
  });

  /** Called by the in-game page itself (Done button in the edit toolbar). */
  ipcMain.handle('ingame:editDone', () => {
    setIngameEdit(false);
    return true;
  });

  /** Toggle/exit interact mode from a control-panel button or the page banner. */
  ipcMain.handle('ingame:interactToggle', () => {
    toggleIngameInteract();
    return statusForUi();
  });
  ipcMain.handle('ingame:interactStop', () => {
    setIngameInteract(false);
    return true;
  });

  ipcMain.handle('ingame:layoutGet', () => loadSettings().ingameLayout);

  ipcMain.handle('ingame:layoutSave', (_evt, layout) => {
    if (!layout || typeof layout !== 'object') return false;
    const settings = loadSettings();
    const merged = { ...settings.ingameLayout };
    for (const o of OVERLAY_CATALOG) {
      const entry = normalizeLayoutEntry(layout[o.id]);
      // Replace, don't merge: the page sends whole entries, and dropping w/h is
      // how a double-clicked handle returns that dimension to automatic.
      if (entry) merged[o.id] = entry;
    }
    saveSettings({ ...settings, ingameLayout: merged });
    return true;
  });

  ipcMain.handle('ingame:layoutReset', () => {
    const settings = loadSettings();
    saveSettings({ ...settings, ingameLayout: {} });
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('ingame:layout-reset');
    }
    return true;
  });

  /* ---- Bindable actions ---- */

  /**
   * The action catalog plus each one's current binding, for the Bindings card.
   * Built fresh per call: the driving-aid actions come from LMU's own bind file,
   * so the list changes when the driver rebinds in-game.
   */
  ipcMain.handle('actions:list', () => {
    const settings = loadSettings();
    return getActions()
      .list()
      .map((a) => ({
        ...a,
        binding: settings.actionBindings[a.id] || '',
        wheel: settings.wheelBindings[a.id] || null,
      }));
  });

  /** Bind (or clear, with an empty accelerator) one action. */
  ipcMain.handle('actions:bind', (_evt, actionId, accelerator) => {
    if (typeof actionId !== 'string' || typeof accelerator !== 'string') {
      return { ok: false, error: 'bad arguments' };
    }
    const current = loadSettings();
    const next = {
      ...current,
      actionBindings: { ...current.actionBindings, [actionId]: accelerator.trim() },
    };
    const legacyKey = LEGACY_SHORTCUT_ACTIONS[actionId];
    if (legacyKey) next[legacyKey] = accelerator.trim();
    saveSettings(next);
    const applied = applyBindings(next);
    pushSettings(next);
    const failure = applied.failed.find((f) => f.action === actionId);
    return { ok: !failure, error: failure ? failure.reason : undefined, settings: next };
  });

  /** Fire an action from the UI — used by the "test" button beside each row. */
  ipcMain.handle('actions:run', async (_evt, actionId, dir) => {
    if (typeof actionId !== 'string') return { ok: false, error: 'bad action id' };
    return runAction(actionId, Number(dir) || 1);
  });

  /* ---- Wheel bindings ---- */

  /** Attached controllers plus whether the reader works on this host. */
  ipcMain.handle('wheel:devices', () => {
    const g = getGamepad();
    // Opening is idempotent; this also picks up a wheel plugged in since boot.
    g.setActive(true);
    const devices = g.list();
    syncGamepad();
    return { available: g.available, error: g.failed, devices };
  });

  /**
   * Wait for the operator to press a wheel button, for binding capture.
   * Resolves with the button, or after a timeout so a stuck capture cannot
   * leave the reader polling forever.
   */
  ipcMain.handle('wheel:capture', async () => {
    if (wheelCapture) {
      wheelCapture.resolve({ ok: false, error: 'another capture is already open' });
      wheelCapture = null;
    }
    const g = getGamepad();
    if (!g.available) return { ok: false, error: g.failed || 'controller input unavailable' };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (wheelCapture && wheelCapture.timer === timer) {
          wheelCapture = null;
          syncGamepad();
          resolve({ ok: false, error: 'timed out — no button pressed' });
        }
      }, 10000);
      timer.unref?.();
      wheelCapture = {
        timer,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      };
      syncGamepad();
    });
  });

  /** Bind (or clear, with a null button) one direction of one action. */
  ipcMain.handle('wheel:bind', (_evt, actionId, dir, binding) => {
    if (typeof actionId !== 'string' || (dir !== 'inc' && dir !== 'dec')) {
      return { ok: false, error: 'bad arguments' };
    }
    const current = loadSettings();
    const entry = { ...(current.wheelBindings[actionId] || {}) };
    if (binding && typeof binding.device === 'string' && Number.isFinite(binding.button)) {
      entry[dir] = { device: binding.device, button: Math.round(binding.button) };
    } else {
      delete entry[dir];
    }
    const wheelBindings = { ...current.wheelBindings };
    if (entry.inc || entry.dec) wheelBindings[actionId] = entry;
    else delete wheelBindings[actionId];

    const next = { ...current, wheelBindings };
    saveSettings(next);
    syncGamepad(next);
    pushSettings(next);
    return { ok: true, settings: next };
  });

  ipcMain.handle('clipboard:write', (_evt, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
    return true;
  });

  ipcMain.handle('overlay:openInBrowser', (_evt, url) => {
    if (typeof url === 'string' && /^https?:\/\/127\.0\.0\.1:/.test(url)) {
      void shell.openExternal(url);
    }
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/*  Auto-update (via electron-updater + GitHub Releases)                       */
/* -------------------------------------------------------------------------- */

/** Latest known update state, mirrored to the control panel. */
const updateState = {
  status: 'idle', // idle | checking | available | downloading | ready | none | error
  version: null,
  percent: 0,
  error: null,
};

function pushUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', { ...updateState });
  }
}

/**
 * Wires electron-updater to the GitHub Releases feed and relays progress to the
 * renderer so the panel can show a "new version available" banner. We do NOT
 * auto-download — the operator clicks to update, so a stream is never disrupted.
 */
function setupAutoUpdate() {
  // The IPC surface must exist even in a dev run (the panel always calls
  // update:getState on boot); only the updater wiring needs a packaged app.
  ipcMain.handle('update:getState', () => ({ ...updateState }));

  if (!app.isPackaged) {
    updateState.status = 'idle';
    ipcMain.handle('update:check', () => ({ ...updateState }));
    ipcMain.handle('update:download', () => ({ ...updateState }));
    ipcMain.handle('update:install', () => {});
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    updateState.status = 'checking';
    updateState.error = null;
    pushUpdate();
  });
  autoUpdater.on('update-available', (info) => {
    updateState.status = 'available';
    updateState.version = info && info.version ? info.version : null;
    pushUpdate();
  });
  autoUpdater.on('update-not-available', () => {
    updateState.status = 'none';
    pushUpdate();
  });
  autoUpdater.on('download-progress', (p) => {
    updateState.status = 'downloading';
    updateState.percent = Math.round((p && p.percent) || 0);
    pushUpdate();
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState.status = 'ready';
    updateState.version = info && info.version ? info.version : updateState.version;
    pushUpdate();
  });
  autoUpdater.on('error', (err) => {
    updateState.status = 'error';
    updateState.error = err == null ? 'unknown error' : String(err.message || err);
    pushUpdate();
  });

  ipcMain.handle('update:check', () => {
    if (!app.isPackaged) return { ...updateState };
    autoUpdater.checkForUpdates().catch((e) => {
      updateState.status = 'error';
      updateState.error = String(e.message || e);
      pushUpdate();
    });
    return { ...updateState };
  });
  ipcMain.handle('update:download', () => {
    autoUpdater.downloadUpdate().catch((e) => {
      updateState.status = 'error';
      updateState.error = String(e.message || e);
      pushUpdate();
    });
    return { ...updateState };
  });
  ipcMain.handle('update:install', () => {
    // Quit and run the freshly-downloaded installer.
    autoUpdater.quitAndInstall();
  });

  // Check once shortly after launch (don't block startup).
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      /* offline / no releases yet — stay idle */
    });
  }, 3000);
}

/* -------------------------------------------------------------------------- */
/*  Window + app lifecycle                                                     */
/* -------------------------------------------------------------------------- */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#060a12',
    title: 'Apex Overlay System',
    icon: path.join(__dirname, 'control-panel', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.removeMenu?.();
  void mainWindow.loadFile(path.join(__dirname, 'control-panel', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    // The in-game layer must not outlive the control panel (it would also keep
    // 'window-all-closed' from firing, leaving a ghost process).
    destroyOverlayWindow();
  });
}

/* Dev-only hooks (no effect unless the env vars are set):
 * APEX_USERDATA — use an alternate settings dir, keeping a dev run's config
 *                 away from the real installation's.
 * APEX_SHOT     — after startup, capture every window as PNGs into this
 *                 directory and quit (visual smoke-test of the UI). */
if (process.env.APEX_USERDATA) {
  app.setPath('userData', process.env.APEX_USERDATA);
}

async function captureWindowsAndQuit(dir) {
  const shots = [
    ['panel', mainWindow],
    ['ingame', overlayWin],
  ];
  const snap = async (name, win) => {
    if (!win || win.isDestroyed()) return;
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `shot-${name}.png`), img.toPNG());
    } catch (err) {
      console.error(`[dev] capture ${name} failed:`, err.message);
    }
  };
  for (const [name, win] of shots) await snap(name, win);
  // Also exercise edit mode on the in-game layer, if it is up.
  if (overlayWin && !overlayWin.isDestroyed()) {
    setIngameEdit(true);
    await new Promise((r) => setTimeout(r, 600));
    await snap('ingame-edit', overlayWin);
  }
  app.quit();
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  setupAutoUpdate();
  applyBindings(loadSettings());
  syncGamepad();
  // Auto-start the server so overlays are live as soon as the app opens.
  await startServer();

  if (process.env.APEX_SHOT) {
    setTimeout(() => void captureWindowsAndQuit(process.env.APEX_SHOT), 3500);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Release the DirectInput devices; leaving them acquired holds COM objects
  // alive past process teardown.
  if (gamepad) gamepad.close();
});

app.on('before-quit', () => {
  // Best-effort synchronous-ish cleanup; the loop is unref'd so this is quick.
  void stopServer();
});
