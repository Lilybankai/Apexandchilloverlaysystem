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
  { id: 'tyres', label: 'Tyre Temps', description: 'Four-corner temperatures' },
  { id: 'pedals', label: 'Pedal Inputs', description: 'Throttle / brake / clutch trace' },
  { id: 'pedalsv', label: 'Pedal Inputs (Vertical)', description: 'Rising pedal levels + steering-angle arc' },
  { id: 'motion', label: 'Motion (G / Rotation / Attitude)', description: 'Traction circle, yaw + slip, pitch + roll' },
  { id: 'damage', label: 'Damage & Repair', description: "What's broken, and the sim's own repair time (LMU only)" },
  { id: 'radar', label: 'Proximity Radar', description: 'Spotter view — cars alongside, ahead and behind' },
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
    ingameOverlays[o.id] = true;
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
    // Saved widget placement in the in-game layer: { [id]: {x, y, scale} }.
    ingameLayout: {},
    // Global hotkey that toggles the in-game overlay (Show in game). An Electron
    // accelerator string; '' means unbound. Rebindable from the control panel.
    ingameToggleShortcut: 'F8',
    // Rotating sponsor logos under the standings tower. Images are copied into
    // <userData>/sponsors/ and served by our own server at /sponsors/ — see
    // `sponsorDir` in the server config for why they live outside overlay/.
    sponsorsEnabled: false,
    sponsorIntervalSec: 12,
  };
}

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
      const l = stored.ingameLayout[o.id];
      if (l && Number.isFinite(l.x) && Number.isFinite(l.y)) {
        ingameLayout[o.id] = {
          x: Math.round(l.x),
          y: Math.round(l.y),
          scale: Number.isFinite(l.scale) ? Math.min(3, Math.max(0.4, l.scale)) : 1,
        };
      }
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
    sponsorsEnabled:
      typeof stored.sponsorsEnabled === 'boolean'
        ? stored.sponsorsEnabled
        : defaults.sponsorsEnabled,
    sponsorIntervalSec: clamp(stored.sponsorIntervalSec, 3, 120, defaults.sponsorIntervalSec),
  };
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
 * (Re)register the global hotkey that toggles the in-game overlay. Clears any
 * previous binding first; an empty accelerator leaves it unbound. Registration
 * is wrapped so an invalid/occupied accelerator can never crash startup.
 */
function applyToggleShortcut(settings) {
  globalShortcut.unregisterAll();
  const accel = (settings || loadSettings()).ingameToggleShortcut;
  if (!accel) return;
  try {
    const ok = globalShortcut.register(accel, toggleIngame);
    if (!ok) console.warn(`[app] could not register hotkey "${accel}" (in use?)`);
  } catch (err) {
    console.warn(`[app] invalid hotkey "${accel}": ${err.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Overlay URL helpers                                                        */
/* -------------------------------------------------------------------------- */

function baseUrl() {
  const port = status.port || loadSettings().httpPort;
  return `http://127.0.0.1:${port}`;
}

/** Full catalog with per-overlay OBS URLs and enabled state for the UI. */
function overlaysForUi() {
  const settings = loadSettings();
  const base = baseUrl();
  return OVERLAY_CATALOG.map((o) => ({
    ...o,
    enabled: settings.enabledOverlays[o.id] !== false,
    ingame: settings.ingameOverlays[o.id] !== false,
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

/** URL of the in-game layer page, carrying the enabled widget list. */
function ingameUrl(settings) {
  const ids = OVERLAY_CATALOG.filter((o) => settings.ingameOverlays[o.id] !== false).map(
    (o) => o.id,
  );
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
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.ingameUrl = url;
  void overlayWin.loadURL(url);
  overlayWin.on('closed', () => {
    overlayWin = null;
    if (ingameEditing) setIngameEdit(false);
  });
}

function destroyOverlayWindow() {
  if (ingameEditing) setIngameEdit(false);
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  overlayWin = null;
}

/** Locks/unlocks the layer for on-screen editing and tells both windows. */
function setIngameEdit(editing) {
  ingameEditing = !!editing;
  if (overlayWin && !overlayWin.isDestroyed()) {
    if (ingameEditing) {
      overlayWin.setIgnoreMouseEvents(false);
    } else {
      overlayWin.setIgnoreMouseEvents(true);
    }
    overlayWin.webContents.send('ingame:edit', ingameEditing);
  }
  pushStatus();
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
    }
    saveSettings(next);

    // Re-bind the global hotkey if it changed.
    if (next.ingameToggleShortcut !== current.ingameToggleShortcut) {
      applyToggleShortcut(next);
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

  ipcMain.handle('ingame:layoutGet', () => loadSettings().ingameLayout);

  ipcMain.handle('ingame:layoutSave', (_evt, layout) => {
    if (!layout || typeof layout !== 'object') return false;
    const settings = loadSettings();
    const merged = { ...settings.ingameLayout };
    for (const o of OVERLAY_CATALOG) {
      const l = layout[o.id];
      if (l && Number.isFinite(l.x) && Number.isFinite(l.y)) {
        merged[o.id] = {
          x: Math.round(l.x),
          y: Math.round(l.y),
          scale: Number.isFinite(l.scale) ? Math.min(3, Math.max(0.4, l.scale)) : 1,
        };
      }
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
  applyToggleShortcut(loadSettings());
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
});

app.on('before-quit', () => {
  // Best-effort synchronous-ish cleanup; the loop is unref'd so this is quick.
  void stopServer();
});
