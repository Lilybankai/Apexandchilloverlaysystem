/**
 * electron/main.js — Apex AIO System desktop app (main process).
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
const authService = require('./auth');
const billingService = require('./billing');
const startup = require('./startup');
const changelog = require('./changelog');
const updateChannel = require('./updateChannel');
const updateCache = require('./updateCache');
const lapUpload = require('./lapUpload');
const usageReporter = require('./usageReporter');
const chatLink = require('./chatLink');
const streamBot = require('./streamBot');
const simgrid = require('./simgrid');
const { overlayGeometryFrom } = require('./overlay-geometry');
const {
  DEFAULT_ENGINEER_SETTINGS,
  sanitizeEngineer,
} = require('./engineer-settings');

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
  {
    id: 'refpace',
    label: 'Reference Pace',
    description: "Your lap vs the class benchmark — Alien to Offline (times by Ohne Speed)",
  },
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
    // A banner across this card on the Overlays screen. The field is generic
    // rather than a fuelplan special case, so the next widget to be reworked
    // says so by adding one line here and nothing in the renderer.
    //
    // It is worth having at all because a rebuilt widget is invisible to
    // everyone who already made up their mind about the old one: a driver who
    // turned the planner off a season ago never opens its card again, and the
    // release notes only reach whoever reads them. The card is where the
    // decision to use a widget is actually made, so that is where the news
    // belongs. Remove the line when it stops being news.
    banner: 'Rebuilt',
  },
  { id: 'tyres', label: 'Tyre Temps', description: 'Four-corner temperatures' },
  {
    id: 'speedo',
    label: 'Speedo Cluster',
    description:
      'Speed, revs, gear + fuel, energy and hybrid battery — the panel lights up with the revs',
    // Selectable cluster designs, drawn as a dropdown on the card. Generic
    // machinery: any widget can grow one by declaring `designs` here plus a
    // matching WIDGET_MODES entry — the card builder and the settings handler
    // never name a widget id. Ids must satisfy the server's mode-slug rule
    // (short alnum), and the FIRST entry is the default and must preserve the
    // widget's original behaviour.
    designs: [
      { id: 'apex', label: 'Apex — twin rev bars' },
      { id: 'lmp2', label: 'LMP2 — Cosworth CDU' },
      { id: 'real', label: 'Apex Real — machined cluster' },
      { id: 'p911', label: 'GT3 — Porsche 911 GT3 R' },
      { id: 'aston', label: 'GT3 — Aston Martin Vantage' },
      { id: 'm4', label: 'GT3 — BMW M4' },
      { id: 'z06', label: 'GT3 — Corvette Z06' },
      { id: 'f296', label: 'GT3 — Ferrari 296' },
      { id: 'mstg', label: 'GT3 — Ford Mustang' },
      { id: 'lambo', label: 'GT3 — Lamborghini Huracan' },
      { id: 'rcf', label: 'GT3 — Lexus RC F' },
      { id: 'm720', label: 'GT3 — McLaren 720S' },
      { id: 'amg', label: 'GT3 — Mercedes-AMG' },
    ],
  },
  { id: 'pedals', label: 'Pedal Inputs', description: 'Throttle / brake / clutch trace' },
  { id: 'pedalsv', label: 'Pedal Inputs (Vertical)', description: 'Rising pedal levels + steering-angle arc' },
  { id: 'motion', label: 'Motion (G / Rotation / Attitude)', description: 'Traction circle, yaw + slip, pitch + roll' },
  { id: 'damage', label: 'Damage & Repair', description: "What's broken, and the sim's own repair time (LMU only)" },
  { id: 'radar', label: 'Proximity Radar', description: 'Spotter view — cars alongside, ahead and behind' },
  {
    id: 'trackmap',
    label: 'Track Map',
    description: 'The circuit in 2.5-D with every car on it — learned from your first lap',
  },
  {
    id: 'limits',
    label: 'Track Limits',
    description: 'Excursions this session, the sim\'s penalties, and how much road is left',
  },
  {
    id: 'racecontrol',
    label: 'Race Control',
    description: 'Start lights, green flag, sector yellows, and the pit-limiter prompts (LMU only)',
  },
  // A clickable control page, not a HUD graphic: it belongs in a browser tab
  // (or an OBS source as a readout), never the locked, click-through in-game
  // layer — so it defaults out of the in-game set.
  {
    id: 'mfd',
    label: 'MFD Control',
    description: 'Set pit strategy from the overlay — open in a browser to click (LMU only)',
    ingameDefault: false,
    // Same generic machinery as the speedo's designs: the card grows a DESIGN
    // dropdown from this list alone. 'stack' is the original two-sections-deep
    // column; 'row' lays the sections out side by side for a rig that has more
    // width than height to give it — a bottom edge, an ultrawide's flank.
    designs: [
      { id: 'stack', label: 'Vertical — sections stacked' },
      { id: 'row', label: 'Horizontal — sections side by side' },
    ],
  },
  // Stream chat pulls its own feed from the /chat socket, not the telemetry
  // frame. Off in the in-game set by default — it is a deliberate add (a side
  // monitor on a triple-screen rig), not something to drop over everyone's sim.
  // `group` is generic (like `banner`/`designs`): the renderer partitions by it
  // without ever naming a widget id, and 'streaming' cards render inside the
  // Streamers tab rather than the main Overlays grid.
  {
    id: 'chat',
    label: 'Stream Chat',
    description: 'YouTube + Twitch chat on screen — link your accounts in the Accounts pane',
    ingameDefault: false,
    group: 'streaming',
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
    /*
     * 17080, not the 8080 this shipped with until v0.57.1.
     *
     * 8080 is the most contested alternate-HTTP port on Windows — Jenkins,
     * Tomcat, dev servers, routers, NAS boxes, printers and (the one that
     * matters here) SimHub's web server all gravitate to the 8000-9999 band.
     * Worse, Hyper-V/WSL/Docker reserve contiguous blocks of ports, and a port
     * inside one is refused with EACCES and no process to point at: a beta
     * tester on v0.57.0 could not start the app at all for exactly that reason.
     *
     * 17080 is clear of that band, clear of the things a sim racer actually
     * runs (4455 OBS WebSocket, 6463-6472 Discord, 27015+ Steam, 6397 LMU's own
     * API), and well below the Windows dynamic range (49152+) that the
     * reservations are drawn from. The trailing 80 reads as HTTP for whoever is
     * typing it into OBS.
     *
     * This is a DEFAULT, so it only applies to installs with no stored port —
     * anyone already running keeps theirs, and their OBS sources keep working.
     */
    httpPort: 17080,
    updateRateHz: 30,
    forceSimulator: false,
    provider: 'lmu', // 'lmu' | 'rf2' | 'simulator'
    lmuApiPort: 6397,
    enabledOverlays,
    // In-game display: overlays rendered over the sim itself (transparent
    // click-through window) instead of / as well as OBS Browser Sources.
    ingameEnabled: false,
    // Auto show/hide: the layer appears when the driver is actually at the
    // wheel and hides on every one of the sim's own screens — ESC/monitor,
    // garage, setup — and outside a session entirely. Driven by the feed's
    // session.onTrack flag (see the status-feed watcher). With this on,
    // "Show in game" means ARMED rather than "on screen right now"; edit and
    // interact modes still force the layer visible so it can always be laid
    // out. On by default: it is what every overlay tool does, and the driver
    // who wants the layer over their menus can switch it off.
    ingameAutoHide: true,
    // Magnetic docking: while laying out the in-game layer, a widget dragged or
    // resized near another one snaps flush against it and takes the neighbour's
    // measurement along the shared edge, so a row of panels comes out aligned
    // and equal instead of eyeballed a pixel at a time. A magnet mark shows on
    // the seam that is about to take, and holding Alt suppresses it for a drag
    // that wants to land somewhere a snap would fight.
    //
    // OFF by default, unlike most helpers here: it changes what an existing
    // drag DOES, and an operator who has already laid out a screen should not
    // find their widgets jumping on upgrade. It is opt-in until it has some
    // mileage on it.
    ingameMagneticDock: false,
    ingameOverlays,
    // The voice race engineer (push-to-talk questions answered from telemetry).
    // Off until the operator downloads a voice and flips the switch — the
    // feature spawns three helper processes, so it must be a choice.
    engineerEnabled: false,
    engineerVoice: 'en_GB-alan-medium',
    // Everything else the engineer learns to do lives in this ONE nested
    // object, so a new field is one line here plus sanitizeEngineer — never
    // another entry in the three flat whitelists (the v3 plan's settings seam).
    // `readouts` is the proactive-calls dial: 'off' | 'essential' | 'standard'.
    // Essential = flags, fuel, penalties, damage; Standard adds the race-story
    // calls (fastest laps, position moves, rivals' stops, blue flags).
    // `volume` is the radio volume, 0–100 (100 = full). Applied to the audio
    // samples themselves — the player sidecar has no volume control.
    // `practicePaceReminderLaps` controls unchanged reference-pace reminders;
    // first benchmarks and faster-band moves are always called on Standard.
    engineer: { ...DEFAULT_ENGINEER_SETTINGS },
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
    // Whether the MFD Control widget fades itself out after three seconds
    // without the driver touching it — a cursor move from the bound ▲ ▼ + −
    // buttons (or the mouse) brings it straight back. For the driver who wants
    // the pit menu on screen only while they are actually working it. Off by
    // default: a widget that vanishes on its own is a behaviour someone must
    // choose, not discover.
    mfdAutoFade: false,
    // Radar car-icon size, 30..150 (percent). This is the radar's ZOOM: it sets
    // the display range (100% = the classic 18 m, 50% = 36 m and therefore
    // half-size cars), because the icons are drawn at the cars' real footprint
    // and a size multiplier over that geometry would break the widget's one
    // promise — an icon's edge is the car's edge. Delivered on the appearance
    // channel like panelOpacity/textScale, so dragging it retunes live sources.
    radarIconScale: 50,
    // Short synthesised tones for the events a driver cannot see coming while
    // looking at the track: a track-limits warning, a penalty landing, the pit
    // release. On by default — the cue exists because the visual alone is
    // missed at the exact moments it matters — and silenced with one switch for
    // a broadcast whose audio is already mixed. See overlay/js/audio.js for why
    // these are synthesised rather than shipped as files.
    audioCues: true,
    // Master volume for those cues, as a percentage. 60 sits under a sim's own
    // engine and spotter audio without disappearing into it.
    audioVolume: 60,
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
    // Per-widget background opacity, { [widgetId]: 0..100 } — an exception to
    // panelOpacity above, not a second copy of it. A widget listed here ignores
    // the global slider; one that is absent (the default, and the whole map on a
    // fresh install) follows it. This is the "everything at 50% for a clean
    // stream, except fuel" case, which cannot be a global setting because which
    // widget has to stay solid differs by driver and by session.
    widgetOpacity: {},
    /*
     * Speed readouts: 'kph' (the sim's own unit) or 'mph'.
     *
     * App-wide rather than per widget, because three widgets show speed — both
     * inputs panels and motion — and a driver reading 168 on one and 104 on the
     * other would be right to think something was broken.
     */
    speedUnit: 'kph',
    /*
     * Temperature readouts: 'c' (the sim's own unit) or 'f'.
     *
     * Same reasoning as speedUnit, and the same scope — the tyres widget, the
     * Speedo designs and the weather panel all print temperatures, and one
     * preference is the only way they can be made to agree. It changes the
     * PRINTING only: the operating-window lamp and the thermal ramp still judge
     * in Celsius against the sim's own optimum.
     */
    tempUnit: 'c',
    /*
     * How much of the field the standings tower shows.
     *
     * A whole grid is 20-30 rows, which is right for a broadcast and far too
     * much screen for someone driving. Rather than a single row cap — which in a
     * multiclass field means a GT3 driver watching a Hypercar-only tower — the
     * view is composed from two ideas that together cover what anyone actually
     * asks for:
     *
     *   top     the leaders, always shown
     *   ahead   cars in front of you
     *   behind  cars behind you
     *
     * and `scope`, which decides whether those are counted within YOUR CLASS or
     * across the whole field. So "three in front, three behind" is
     * top 0 / ahead 3 / behind 3, and "top ten of each class" is top 10 with
     * scope 'class' — the same three numbers, no modes to enumerate.
     *
     * `limit: 'all'` is the default and means the tower behaves exactly as it
     * always has. The numbers are kept while it is set, so turning the cap off
     * and on again returns to the same view rather than to a guess.
     *
     * `gap` is what the GAP column counts — 'leader' (cumulative, the broadcast
     * reading) or 'ahead' (the interval to the car in front, which is what a
     * driver is actually racing). Independent of the composition above: any
     * amount of the field can be shown either way.
     *
     * `fastest` is what the fastest-lap banner reports — 'class' (one lap per
     * class, the default) or 'overall' (one lap, the quickest in the race). Per
     * class leads because in a multiclass field the overall fastest is always
     * the top category's, so a GT3 driver reading it learns nothing about their
     * own race; a single-class field draws one line under either setting.
     *
     * `pos` is which position the panel header reports — 'overall' (your place
     * in the field, the default and what it has always shown) or 'class' (your
     * place among your own category, "GT3 10/13"). Overall stays the default
     * because a single-class field is the common case and the two readings are
     * identical there; in a multiclass race the class number is usually the one
     * being raced for, which is why it is offered at all.
     *
     * `decimals` is how precisely the GAP/INT column is read — 3 (the sim's own
     * truth, and the default), 2, or 1. A driver glancing at the column mid-corner
     * is reading whether a gap is growing or shrinking, and the third decimal
     * changes every frame whatever the car is doing: at 1 it is a number that
     * only moves when something happened. The column also gives its spare width
     * back to the driver names, which is the column with none to spare.
     *
     * `names` is how those names are written — 'full' ("Matt Haskins", the
     * default and what the tower has always drawn), 'surname' ("M.Haskins") or
     * 'forename' ("Matt.H"). Which of the two halves identifies a driver is a
     * fact about the grid, not about the software: a league that races by first
     * name wants 'forename' and a broadcast wants 'surname'. The name in full is
     * always on the row's tooltip, so nothing is lost by abbreviating.
     */
    standings: {
      limit: 'all', // 'all' | 'custom'
      scope: 'class', // 'class' | 'field'
      top: 0,
      ahead: 3,
      behind: 3,
      gap: 'leader', // 'leader' | 'ahead'
      fastest: 'class', // 'class' | 'overall'
      pos: 'overall', // 'overall' | 'class'
      decimals: 3, // 1 | 2 | 3
      names: 'full', // 'full' | 'surname' | 'forename'
      // 'on' adds a last-5-laps average column (pit laps left out) — the pace
      // each car is actually running, next to the one-off BEST. Off by
      // default: it is 70px of tower that comes straight out of the driver
      // names anywhere the panel cannot grow (the in-game layer grows it —
      // see widthBumpFor in overlay/js/ingame.js).
      avg: 'off', // 'off' | 'on'
    },
    // Wheel/controller bindings:
    //   { [actionId]: { inc?: {device, button}, dec?: {device, button} } }
    // A `delta` action can take two buttons (an encoder's two directions); a
    // `pulse` action uses `inc` alone. Kept separate from actionBindings because
    // a wheel button is a device+number, not an accelerator string — and unlike
    // a global hotkey it is NOT consumed, so the sim still sees it too.
    wheelBindings: {},
    /*
     * Desktop app behaviour — where the app lives when it isn't the thing being
     * looked at.
     *
     * `launchOnStartup` writes a Windows Run-key entry pointing at this exe with
     * `--hidden`, so a boot starts the app MINIMISED in the taskbar rather than
     * throwing a maximised window over whatever the person is doing. Off by
     * default: an app that installs itself into someone's boot without being
     * asked is a bad citizen.
     *
     * There is deliberately NO notification-area icon and NO minimise-to-tray.
     * Both shipped in 0.65.0 and were removed on driver feedback: minimising
     * made the window vanish into the tray overflow flyout, which reads as the
     * app having gone somewhere weird rather than as a minimised app. The
     * window now behaves like any other: minimise puts it in the taskbar,
     * close quits the whole app. Nothing is throttled while minimised (see
     * createWindow's backgroundThrottling).
     */
    launchOnStartup: false,
    // Account: the operator picked "Continue offline" on the sign-in screen, so
    // don't show it again on launch (they can still sign in from the top bar).
    offlineMode: false,
    // Last address that signed in, purely to prefill the sign-in field. Never a
    // credential — tokens live in session.json, handled by electron/auth.js.
    lastAuthEmail: '',
    // The version whose release notes this driver has actually read. Empty on a
    // fresh install, which is the difference between "new here" (say nothing)
    // and "just updated" (show what changed) — see setupChangelogIpc.
    lastSeenVersion: '',
    // Which GitHub Releases feed this install follows: 'stable' (the release
    // everyone gets) or 'beta' (prereleases too, for the people building the
    // thing). Defaults to stable, so an install that never touches this setting
    // can never be handed an untested build — see setupAutoUpdate.
    updateChannel: 'stable',
  };
}

/**
 * The modes each switchable widget cycles through, in order. The first entry is
 * the default and must preserve the widget's original behaviour, so an operator
 * who never touches this sees no change at all.
 */
const WIDGET_MODES = {
  // 'auto' keeps the existing core-temp → surface → tread fallback. 'map' is the
  // four-tyre graphic; it comes last so the three number views stay one press
  // apart from each other, as they were before it existed.
  tyres: ['auto', 'temp', 'surface', 'tread', 'map'],
  // The cluster's selectable designs. 'apex' is the house twin-rev-bar cluster;
  // 'lmp2' is the Cosworth-CDU-style LMP2 dash. Kept in step with the `designs`
  // list on the speedo catalog entry, which is what the card's dropdown renders.
  // 'real' is the machined repaint of the Apex cluster; the ten after it are
  // the per-car LMGT3 plates (speedo-gt3.js). Order here is dropdown order.
  speedo: ['apex', 'lmp2', 'real', 'p911', 'aston', 'm4', 'z06', 'f296', 'mstg', 'lambo', 'rcf', 'm720', 'amg'],
  // The MFD's layout. 'stack' is the original column; 'row' puts the sections
  // side by side. In step with the mfd catalog entry's `designs` list.
  mfd: ['stack', 'row'],
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
    ingameAutoHide:
      typeof stored.ingameAutoHide === 'boolean' ? stored.ingameAutoHide : defaults.ingameAutoHide,
    ingameMagneticDock:
      typeof stored.ingameMagneticDock === 'boolean'
        ? stored.ingameMagneticDock
        : defaults.ingameMagneticDock,
    ingameOverlays,
    ingameLayout,
    engineerEnabled:
      typeof stored.engineerEnabled === 'boolean' ? stored.engineerEnabled : defaults.engineerEnabled,
    engineerVoice:
      typeof stored.engineerVoice === 'string' && stored.engineerVoice.trim()
        ? stored.engineerVoice.trim()
        : defaults.engineerVoice,
    engineer: sanitizeEngineer(stored.engineer, defaults.engineer),
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
    mfdAutoFade:
      typeof stored.mfdAutoFade === 'boolean' ? stored.mfdAutoFade : defaults.mfdAutoFade,
    radarIconScale: clamp(stored.radarIconScale, 30, 150, defaults.radarIconScale),
    audioCues: typeof stored.audioCues === 'boolean' ? stored.audioCues : defaults.audioCues,
    audioVolume: clamp(stored.audioVolume, 0, 100, defaults.audioVolume),
    actionBindings: normalizeBindings(stored, defaults),
    widgetModes: normalizeWidgetModes(stored),
    widgetOpacity: normalizeWidgetOpacity(stored),
    speedUnit: stored.speedUnit === 'mph' ? 'mph' : defaults.speedUnit,
    tempUnit: stored.tempUnit === 'f' ? 'f' : defaults.tempUnit,
    standings: normalizeStandings(stored),
    wheelBindings: normalizeWheelBindings(stored),
    launchOnStartup:
      typeof stored.launchOnStartup === 'boolean'
        ? stored.launchOnStartup
        : defaults.launchOnStartup,
    offlineMode: typeof stored.offlineMode === 'boolean' ? stored.offlineMode : defaults.offlineMode,
    lastAuthEmail:
      typeof stored.lastAuthEmail === 'string' ? stored.lastAuthEmail : defaults.lastAuthEmail,
    lastSeenVersion:
      typeof stored.lastSeenVersion === 'string'
        ? stored.lastSeenVersion
        : defaults.lastSeenVersion,
    updateChannel: updateChannel.normalizeChannel(stored.updateChannel),
    // Which team the relay publishes to / the pit wall watches (a UUID from
    // my_teams). team-cloud re-validates it against the live roster.
    teamActiveId:
      typeof stored.teamActiveId === 'string' && stored.teamActiveId
        ? stored.teamActiveId
        : null,
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

/**
 * Validate the standings composition from disk or the UI.
 *
 * Every field falls back independently, so a config carrying only `limit` (or
 * only a changed `ahead`) is still a complete, sane object by the time anything
 * renders from it. The counts are capped at 30 — beyond a full grid the numbers
 * stop meaning anything, and an unbounded value here is a row count the overlay
 * would try to lay out.
 */
function normalizeStandings(stored) {
  const d = defaultSettings().standings;
  const from = stored && typeof stored.standings === 'object' ? stored.standings : {};
  return {
    limit: from.limit === 'custom' ? 'custom' : d.limit,
    scope: from.scope === 'field' ? 'field' : d.scope,
    top: clamp(from.top, 0, 30, d.top),
    ahead: clamp(from.ahead, 0, 30, d.ahead),
    behind: clamp(from.behind, 0, 30, d.behind),
    gap: from.gap === 'ahead' ? 'ahead' : d.gap,
    fastest: from.fastest === 'overall' ? 'overall' : d.fastest,
    pos: from.pos === 'class' ? 'class' : d.pos,
    // An allow-list rather than a clamp: 1, 2 and 3 are the whole of what the
    // column can mean, so a stored 0 or 7 is not a number to bring into range,
    // it is a value this build does not have and the default is the answer.
    decimals: from.decimals === 1 || from.decimals === 2 ? from.decimals : d.decimals,
    names: from.names === 'surname' || from.names === 'forename' ? from.names : d.names,
    avg: from.avg === 'on' ? 'on' : d.avg,
  };
}

/**
 * Keep only background overrides for widgets that still exist, clamped to the
 * slider's own range. A widget dropped from the catalog leaves its entry behind
 * in config.json; keeping it would put an id on the appearance channel that
 * nothing on the overlay side can ever match.
 */
function normalizeWidgetOpacity(stored) {
  const out = {};
  const from = stored && typeof stored.widgetOpacity === 'object' ? stored.widgetOpacity : null;
  if (!from) return out;
  for (const o of OVERLAY_CATALOG) {
    const v = Number(from[o.id]);
    if (Number.isFinite(v)) out[o.id] = Math.min(100, Math.max(0, Math.round(v)));
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
    radarIconScale: settings.radarIconScale,
    audioCues: settings.audioCues,
    audioVolume: settings.audioVolume,
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

/**
 * Whether a failed bind means "this port is not available to us" rather than a
 * real fault. Two codes, two different causes, one answer — try another port:
 *
 *   EADDRINUSE — something else is listening there.
 *   EACCES     — nothing is listening, but Windows will not hand the port over.
 *                Usually Hyper-V/WSL2/Docker, which RESERVE contiguous blocks of
 *                ports (`netsh interface ipv4 show excludedportrange tcp`); a
 *                port inside one is refused with no process to point at. This is
 *                what a first beta tester hit on 8080 in v0.57.0, where it
 *                surfaced as the raw "listen EACCES: permission denied".
 */
function isPortUnavailable(err) {
  return /EADDRINUSE|EACCES/.test(String((err && (err.code || err.message)) || ''));
}

/**
 * Ports to try, in order, starting from the configured one.
 *
 * The small steps cover a single busy neighbour. The big jumps exist because a
 * Windows reservation is a BLOCK, routinely dozens or hundreds of ports wide —
 * walking +1, +2, +3 out of a blocked 8080 can land inside the same reservation
 * every time, which looks exactly like the app being broken.
 */
function portCandidates(configured) {
  const seen = new Set();
  return [configured, ...[1, 2, 3, 250, 1000].map((s) => configured + s), 18080, 28080].filter(
    (p) => p >= MIN_PORT && p <= MAX_PORT && !seen.has(p) && seen.add(p),
  );
}

/** Start (or restart) the telemetry server with the current settings. */
async function startServer() {
  if (starting) return;
  starting = true;
  try {
    await stopServer();
    const settings = loadSettings();
    const mod = requireServer();

    /*
     * A port the machine will not give us must not be the end of the app. The
     * overlays are served over loopback to OBS and to the in-game layer, so the
     * exact number matters only in that it has to be written down somewhere —
     * and refusing to start teaches a driver nothing except that it is broken.
     * So: take the first port that binds, then say plainly that it moved,
     * because their OBS browser sources point at the old one.
     */
    let config = null;
    let lastErr = null;
    for (const port of portCandidates(settings.httpPort)) {
      config = buildServerConfig({ ...settings, httpPort: port });
      try {
        shutdownFn = await mod.start(config);
        lastErr = null;
        break;
      } catch (err) {
        shutdownFn = null;
        lastErr = err;
        config = null;
        // Anything that is not a port problem is a real failure: report it as
        // itself rather than hiding it behind eight more attempts at the same.
        if (!isPortUnavailable(err)) break;
      }
    }
    if (lastErr) throw lastErr;
    // The ServerConfig carries the plain sliders in, but not the two per-widget
    // maps (modes and background overrides) — they have no config field and the
    // server boots them empty. Without this, a widget kept solid inside a faded
    // overlay silently rejoined the rest of the set every time the app started
    // or the port changed, until the operator touched a setting.
    applyAppearance(settings);
    status.running = true;
    status.port = config.httpPort;
    status.error = null;

    // Moving port is not an error — the app is running — but it is not silent
    // either: every OBS browser source the operator has already added points at
    // the old number and will show nothing until it is changed.
    if (config.httpPort !== settings.httpPort) {
      const moved = { ...settings, httpPort: config.httpPort };
      saveSettings(moved);
      pushSettings(moved);
      status.error =
        `This PC would not let the overlays use port ${settings.httpPort}, so they moved to ` +
        `${config.httpPort}. Everything works — but any OBS browser source you have already ` +
        `added still points at the old port. Copy the new links from the Overlays tab.`;
      console.warn(`[app] port ${settings.httpPort} unavailable — moved to ${config.httpPort}`);
    }

    connectStatusFeed(config.httpPort, config.wsPath);
    syncOverlayWindow();
    void syncEngineer();
    console.log(`[app] server started on port ${config.httpPort}`);
  } catch (err) {
    status.running = false;
    status.feed = 'stopped';
    // Every port we tried was refused. Say which failure it was, because the two
    // have completely different fixes and the raw Node message ("listen EACCES:
    // permission denied 127.0.0.1:8080") tells a driver nothing at all.
    const port = loadSettings().httpPort;
    if (/EACCES/.test(err.message)) {
      status.error =
        `Windows is blocking port ${port} and the alternatives tried after it. This is usually ` +
        `Hyper-V, WSL or Docker reserving a block of ports. Set a different port in ` +
        `Settings → Server, or run "net stop winnat" then "net start winnat" in an admin ` +
        `Command Prompt to release the reservations.`;
    } else if (/EADDRINUSE/.test(err.message)) {
      status.error = `Port ${port} is already in use. Change the port and try again.`;
    } else {
      status.error = err.message;
    }
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
/** Last time a status-feed frame was actually parsed (they are mostly dropped). */
let lastStateScanAt = 0;
let feedWatchTimer = null;

/* ---- Team tab feed (docs/TEAM-ENGINEER-PAGE.md Phase 1) -------------------
 * The status socket above already parses every frame; while the Team view is
 * open we also prune the latest one to a 1 Hz snapshot and push it. The tab
 * subscribes on entry and unsubscribes on exit, so with any other view active
 * this costs exactly nothing — the throttle gate below is the first line. */
let teamViewOpen = false;
let lastTeamPushAt = 0;
let lastFeedFrame = null; // newest parsed frame, so subscribe can answer instantly
const TEAM_PUSH_MS = 1000;
const { buildTeamSnapshot } = require('./team-snapshot');
const { TeamHistory, tyreProjection } = require('./team-history');
const teamCloud = require('./team-cloud');

/**
 * The race memory behind the Positions/lap-time charts and the tyre
 * projection. Fed at 1 Hz whether or not the Team tab is open — an engineer
 * opening the page on lap 40 wants laps 1–40 — and reset by its own session
 * keying. The 1 Hz gate lives here, not in the class, so the 30 Hz feed
 * costs one timestamp compare per frame.
 */
const teamHistory = new TeamHistory();
let lastHistoryFeedAt = 0;
/** History revision last sent to the renderer, so unchanged laps cost nothing. */
let lastSentHistoryRev = -1;

/**
 * The learned circuit shape, fetched from the server's own /trackmap.json
 * (the panel's CSP cannot fetch, so main forwards it over IPC). Downsampled:
 * a panel-sized map does not need 1500 points. Sent once per revision.
 */
let teamMapShape = null; // {key, revision, lengthM, points: [[x,z],...]}
let teamMapShapeFetching = false;
let lastSentShapeRev = -1;
let feedHttpPort = 0;

function fetchTeamMapShape(revision) {
  if (teamMapShapeFetching || !feedHttpPort) return;
  teamMapShapeFetching = true;
  const http = require('http');
  const req = http.get(
    { host: '127.0.0.1', port: feedHttpPort, path: '/trackmap.json', timeout: 4000 },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        teamMapShapeFetching = false;
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        teamMapShapeFetching = false;
        try {
          const map = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const pts = Array.isArray(map.points) ? map.points : [];
          const step = Math.max(1, Math.ceil(pts.length / 400));
          teamMapShape = {
            key: map.key,
            revision: map.revision ?? revision,
            lengthM: map.lengthM,
            points: pts.filter((_, i) => i % step === 0).map((p) => [p[0], p[1]]),
          };
        } catch {
          /* half-written or empty — the next revision bump retries */
        }
      });
    },
  );
  req.on('error', () => {
    teamMapShapeFetching = false;
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
}

/** Build the snapshot plus the heavy extras the renderer caches by revision. */
function teamSnapshotWithExtras(frame, now, everything) {
  const snap = buildTeamSnapshot(frame, now);
  if (!snap) return snap;
  const tm = frame.trackMap;
  if (tm && tm.ready && (!teamMapShape || teamMapShape.revision !== tm.revision)) {
    fetchTeamMapShape(tm.revision);
  }
  snap.historyRevision = teamHistory.revision;
  if (everything || teamHistory.revision !== lastSentHistoryRev) {
    snap.history = teamHistory.state();
    lastSentHistoryRev = teamHistory.revision;
  }
  // Tiny (four subtractions over ≤5 laps) — computed every push so the tyre
  // plan is always current without the renderer owning any maths.
  snap.tyrePlan = tyreProjection(teamHistory.wear);
  if (teamMapShape && (everything || teamMapShape.revision !== lastSentShapeRev)) {
    snap.mapShape = teamMapShape;
    lastSentShapeRev = teamMapShape.revision;
  }
  return snap;
}

/**
 * Everything the relay publisher needs, gathered from the feed state this file
 * owns. Called by team-cloud on its own 3 s beat; cheap when there is no frame.
 */
function collectForRelay() {
  if (!lastFeedFrame) return null;
  const snapshot = buildTeamSnapshot(lastFeedFrame, Date.now());
  if (snapshot) snapshot.tyrePlan = tyreProjection(teamHistory.wear);
  return {
    frame: lastFeedFrame,
    snapshot,
    mapShape: teamMapShape,
    history: teamHistory.state(),
  };
}

/** Push a pruned snapshot of this frame to the Team tab, at most 1/s. */
function maybePushTeamSnapshot(frame) {
  const now = Date.now();
  // The race memory records regardless of the tab — that is its whole point.
  if (now - lastHistoryFeedAt >= TEAM_PUSH_MS) {
    lastHistoryFeedAt = now;
    try {
      teamHistory.update(frame);
    } catch {
      /* a malformed frame must never take the feed down */
    }
  }
  if (!teamViewOpen) return;
  if (now - lastTeamPushAt < TEAM_PUSH_MS) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  lastTeamPushAt = now;
  try {
    mainWindow.webContents.send('team:update', teamSnapshotWithExtras(frame, now, false));
  } catch {
    /* window mid-teardown — the next frame retries */
  }
}

/**
 * Whether the live feed currently says the driver is at the wheel — the input
 * to auto show/hide. `false` covers every way of not being on track: the sim's
 * menu/monitor/garage screens (session.onTrack === false), no session loaded
 * (the provider falls back to demo within ~2 s of the REST API going quiet),
 * the game not running at all, and the feed simply not flowing. Only a live
 * frame that does not say otherwise sets it true.
 */
let feedOnTrack = false;

/** Record a feed verdict and reflect a change on the in-game layer at once. */
function setFeedOnTrack(onTrack) {
  if (onTrack === feedOnTrack) return;
  feedOnTrack = onTrack;
  applyIngameVisibility();
}

/**
 * Where the status feed should be connected, or null when it should not be.
 *
 * This is what makes the feed self-healing: the socket's own close/error
 * handlers redial while a target stands, and disconnectStatusFeed() clears the
 * target so a deliberate stop stays stopped. Without the redial, one dropped
 * socket silently ended the feed for the rest of the run — the watchdog then
 * read "no data" forever, and with auto show/hide on that HID THE IN-GAME
 * OVERLAYS mid-race until the operator pressed stop/start (the exact tester
 * report this fixes).
 */
let statusFeedTarget = null;
let statusFeedRedialTimer = null;
let statusFeedRedialDelay = 1000;
const STATUS_FEED_REDIAL_MAX_MS = 10_000;

function scheduleStatusFeedRedial() {
  if (!statusFeedTarget || statusFeedRedialTimer) return;
  statusFeedRedialTimer = setTimeout(() => {
    statusFeedRedialTimer = null;
    if (!statusFeedTarget) return;
    console.warn('[app] status feed down — redialling');
    dialStatusFeed();
  }, statusFeedRedialDelay);
  statusFeedRedialTimer.unref?.();
  statusFeedRedialDelay = Math.min(STATUS_FEED_REDIAL_MAX_MS, statusFeedRedialDelay * 2);
}

function connectStatusFeed(port, wsPath) {
  disconnectStatusFeed();
  statusFeedTarget = { port, wsPath };
  statusFeedRedialDelay = 1000;
  dialStatusFeed();
}

function dialStatusFeed() {
  if (!statusFeedTarget) return;
  const { port, wsPath } = statusFeedTarget;
  lastFrameAt = 0;
  feedHttpPort = port; // the Team map shape is fetched from this same server
  const url = `ws://127.0.0.1:${port}${wsPath}`;
  let sock;
  try {
    sock = new WebSocket(url);
  } catch {
    statusWs = null;
    scheduleStatusFeedRedial();
    return;
  }
  statusWs = sock;
  sock.on('open', () => {
    statusFeedRedialDelay = 1000; // a good connection resets the backoff
  });
  sock.on('close', () => {
    // Identity-guarded: a replaced socket's late close must not tear down (or
    // redial over) the one that replaced it.
    if (statusWs !== sock) return;
    statusWs = null;
    scheduleStatusFeedRedial();
  });
  sock.on('message', (data) => {
    if (statusWs !== sock) return; // a replaced socket's stragglers
    const now = Date.now();
    lastFrameAt = now; // liveness is the message arriving; it needs no content
    // Parse only when a consumer is actually due. Every consumer of this feed
    // is slow — the live/demo/on-track flags move perhaps twice a session and
    // the Team beat is 1 Hz — but the parse itself used to run at the full
    // broadcast rate: a ~20-50 KB JSON graph allocated 30-120×/s ON THE
    // ELECTRON MAIN THREAD, whose GC pauses are exactly the periodic hitch the
    // transparent in-game window cannot hide. ~4 Hz keeps every consumer
    // fresher than the 1 s no-data watchdog while shedding ~95% of the work.
    const teamDue =
      now - lastHistoryFeedAt >= TEAM_PUSH_MS ||
      (teamViewOpen && now - lastTeamPushAt >= TEAM_PUSH_MS);
    if (!teamDue && now - lastStateScanAt < 250) return; // dropped unparsed
    lastStateScanAt = now;
    try {
      const frame = JSON.parse(data.toString());
      // client.js treats connected === false as the demo/simulator feed.
      const demo = !!(frame && frame.connected === false);
      const feed = demo ? 'demo' : 'live';
      // At the wheel = a live frame whose session does not say onTrack:false.
      // Absent counts as true (a source without the channel must never hide
      // the layer); a demo frame counts as false (no session to draw over —
      // DELIBERATE demo mode is exempted inside ingameShouldBeVisible, not
      // here, so the flag keeps meaning one thing).
      setFeedOnTrack(!demo && !!(frame && (!frame.session || frame.session.onTrack !== false)));
      // Push only on a genuine transition. Frames arrive at the broadcast rate
      // (up to 120/s) and the feed flag changes perhaps twice a session, so an
      // unconditional push here would be far worse than the 1 Hz churn this
      // replaced. The watchdog below owns the opposite transition (→ no-data).
      if (demo !== status.demo || feed !== status.feed) {
        status.demo = demo;
        status.feed = feed;
        pushStatus();
      }
      lastFeedFrame = frame;
      maybePushTeamSnapshot(frame);
    } catch {
      /* ignore malformed frame */
    }
  });
  sock.on('error', () => {
    /* 'close' follows and owns the redial; the watchdog reports the gap */
  });

  // Watchdog: if frames stop arriving, reflect "no data" in the panel — and
  // put a silent-but-open socket down so the redial path can replace it. A
  // socket can stop delivering without ever closing (the server side wedged,
  // or the connection dying without a RST); terminate() forces the 'close'
  // that schedules the redial, so a blip costs seconds, not the session.
  //
  // Only pushes when something actually changed. It used to send unconditionally
  // every second, which re-rendered the whole panel once a second for the entire
  // time the app was open — pure churn, since the live/demo/no-data flag is the
  // only thing this timer can alter, and the socket's own message handler
  // already pushes when the feed state flips the other way.
  if (!feedWatchTimer) {
    feedWatchTimer = setInterval(() => {
      if (!status.running) return;
      const stale = lastFrameAt === 0 || Date.now() - lastFrameAt > NO_DATA_MS;
      if (stale) setFeedOnTrack(false);
      if (stale && status.feed !== 'no-data') {
        status.feed = 'no-data';
        pushStatus();
      }
      if (stale && statusWs && lastFrameAt !== 0) {
        console.warn('[app] status feed silent on an open socket — recycling it');
        try {
          statusWs.terminate(); // its 'close' handler schedules the redial
        } catch {
          statusWs = null;
          scheduleStatusFeedRedial();
        }
      }
    }, 1000);
    feedWatchTimer.unref?.();
  }
}

function disconnectStatusFeed() {
  // A deliberate stop: drop the redial target first so no handler re-dials.
  statusFeedTarget = null;
  if (statusFeedRedialTimer) {
    clearTimeout(statusFeedRedialTimer);
    statusFeedRedialTimer = null;
  }
  setFeedOnTrack(false);
  // Blank the pit wall promptly rather than letting it age out: a stopped
  // server is "no data", not "data from 8 seconds ago".
  lastFeedFrame = null;
  if (teamViewOpen && mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('team:update', null);
    } catch {
      /* window mid-teardown */
    }
  }
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

/** Push the account state (signed in / who) to whichever page is loaded. */
function pushAuth() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:changed', authStateForUi());
  }
}

/** Push the entitlement snapshot so the Settings card tracks billing changes. */
function pushBilling(snap) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('billing:changed', snap);
  }
}

/** Push the lap uploader's state so the Dashboard can show whether it is working. */
function pushLapSync(syncState) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('laps:sync', syncState);
  }
}

/**
 * Push the current wheel list so the bindings page tracks unplug/replug live.
 * Fired by the reader whenever an enumeration ends differently from the last
 * one — the same payload the 'wheel:devices' handler answers with.
 */
function pushWheelDevices() {
  if (mainWindow && !mainWindow.isDestroyed() && gamepad) {
    mainWindow.webContents.send('wheel:devices-changed', {
      available: gamepad.available,
      error: gamepad.failed,
      devices: gamepad.list(),
      problems: gamepad.problems,
    });
  }
}

/** Account state plus the remembered email the sign-in screen prefills with. */
function authStateForUi() {
  return { ...authService.stateForUi(), lastEmail: loadSettings().lastAuthEmail || '' };
}

/** Push the streaming-chat link state (which platforms are linked) to the panel. */
function pushChatState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('chatState:changed', chatLink.stateForUi());
  }
  // The bot's capabilities (may it type? as whom?) are derived from the link
  // state, so any link change recomputes the engine's working config too.
  try {
    streamBot.pushServerConfig();
  } catch {
    /* not initialised yet — its own init pushes */
  }
}

/** Push the stream-bot state (commands, timers, goals, budget) to the panel. */
function pushStreamBotState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('streamBot:changed', state || streamBot.stateForUi());
  }
}

/**
 * Forward the bot's working config to the running server. Same staging story
 * as applyChatConfig: safe before the server exists.
 */
function applyBotConfig(cfg) {
  try {
    requireServer().setStreamBotConfig(cfg || {});
  } catch (err) {
    // Not built / not started yet — server start() seeds from the staged value.
  }
}

/**
 * Forward the chat sources to the running server, effective immediately. Safe
 * before the server is up (the require carries the value in at the next start,
 * via the staged pendingChatConfig in server/index.ts).
 */
function applyChatConfig(cfg) {
  try {
    requireServer().setChatConfig(cfg || {});
  } catch (err) {
    // Not built / not started yet — server start() seeds from the staged value.
  }
}

/**
 * Set "Show in game" and reflect it everywhere: persist, re-sync the overlay
 * window, and update the control panel.
 */
function setIngameEnabled(enabled) {
  const settings = loadSettings();
  const next = { ...settings, ingameEnabled: !!enabled };
  saveSettings(next);
  syncOverlayWindow();
  pushStatus();
  pushSettings(next);
}

/**
 * The in-game hotkey, which walks the three states the layer actually has:
 *
 *     Show ──▶ Off ──▶ Edit layout ──▶ Show ──▶ …
 *
 * One key instead of two, because the thing it replaces was worse: moving a
 * widget meant alt-tabbing out of the game to the control panel, clicking Edit
 * layout, tabbing back, dragging, and tabbing out again to finish. Laying out
 * an overlay is something you do *while looking at it over the game*, so the
 * way in has to be reachable from inside the game.
 *
 * The cost of folding three states into one key is that the trip back from Off
 * to Show goes through Edit layout — press it twice. That is the trade the
 * cycle makes: nothing is lost by passing through (a layout only changes if you
 * drag something), and the alternative is a second hotkey for a mode most
 * drivers touch once and then never again.
 *
 * Edit is skipped when there is no layer to edit — with the server stopped this
 * degrades to a plain on/off toggle rather than a mode with nothing in it.
 */
function cycleIngame() {
  // Edit → Show. Leave the mode; the layer stays where it is.
  if (ingameEditing) {
    setIngameEdit(false);
    return;
  }

  const settings = loadSettings();

  // Show → Off.
  if (settings.ingameEnabled) {
    setIngameEnabled(false);
    return;
  }

  // Off → Edit layout. The layer has to come back before it can be edited.
  setIngameEnabled(true);
  if (overlayWin && !overlayWin.isDestroyed()) setIngameEdit(true);
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
    mfdAutoFade: !!s.mfdAutoFade,
    radarIconScale: s.radarIconScale,
    audioCues: s.audioCues,
    audioVolume: s.audioVolume,
    widgetModes: s.widgetModes || {},
    widgetOpacity: s.widgetOpacity || {},
    standings: s.standings || defaultSettings().standings,
    speedUnit: s.speedUnit === 'mph' ? 'mph' : 'kph',
    tempUnit: s.tempUnit === 'f' ? 'f' : 'c',
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

// An applyTuning() sat here, the telemetry-side counterpart to applyAppearance():
// live changes to what the SERVER computes rather than to how an overlay draws
// it. Its only setting was the track-limits threshold, and the geometric detector
// that used it has been retired in favour of the sim's own charges. Nothing on
// the telemetry side is operator-tunable now.

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
    partial.widgetModes !== undefined ||
    partial.widgetOpacity !== undefined ||
    partial.standings !== undefined ||
    partial.speedUnit !== undefined ||
    partial.tempUnit !== undefined
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
      engineerAsk: () => getEngineer().ask(),
      engineerSpeak: (intent) => getEngineer().speakIntent(intent),
      cycleIngame,
      toggleIngameInteract,
      resetLayout: () => {
        const settings = loadSettings();
        saveSettings({ ...settings, ingameLayout: {} });
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.webContents.send('ingame:layout-reset');
        }
      },
      /**
       * Force a wheel re-enumeration and answer with the product names found.
       * Deferred one macrotask on purpose: a wheel-bound press arrives from
       * inside the reader's own poll loop, and rescanning there would release
       * the very device array being iterated.
       */
      rescanWheels: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        const g = getGamepad();
        g.rescan();
        syncGamepad();
        pushWheelDevices();
        return g.list().map((d) => d.product);
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
/*  The race engineer (voice commands over the radio)                          */
/* -------------------------------------------------------------------------- */

let engineerService = null;

/** The service, created on first use — an operator who never enables it pays nothing. */
function getEngineer() {
  if (!engineerService) {
    const { EngineerService } = require('./engineer');
    // Packaged: the installer ships piper + whisper in resources/ (signed —
    // see electron-builder.js). Dev: scripts/stage-bundled.js fills
    // build/bundled with the same layout; without it the service falls back
    // to the userData downloads exactly as before.
    const bundledRoot = app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, '..', 'build', 'bundled');
    engineerService = new EngineerService({
      dir: path.join(app.getPath('userData'), 'piper'),
      whisperDir: path.join(app.getPath('userData'), 'whisper'),
      bundledDir: path.join(bundledRoot, 'piper'),
      bundledWhisperDir: path.join(bundledRoot, 'whisper'),
      // Packaged, the signed sidecar scripts live in resources/; in dev they
      // are run straight from the repo (engineer.js defaults to that).
      ...(app.isPackaged ? { sidecarsDir: path.join(process.resourcesPath, 'sidecars') } : {}),
      loadSettings,
      onStatus: (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('engineer:status', payload);
        }
      },
      cloudAsk: (body) => authService.functionsInvoke('engineer', body, { timeoutMs: 8000 }),
      cloudBudget: () => authService.rpc('engineer_budget', {}),
      cloudRate: (id, rating) => authService.rpc('rate_engineer_call', { p_id: id, p_rating: rating }),
    });
  }
  return engineerService;
}

/**
 * Bring the engineer in line with reality: running exactly when the feature is
 * on, the server is up, and the selected voice is actually on disk. Always a
 * stop-then-start so a voice or port change never needs its own code path.
 */
async function syncEngineer(settings) {
  const s = settings || loadSettings();
  const eng = getEngineer();
  const installed = eng.engineInstalled() && eng.voiceInstalled(s.engineerVoice);
  const wanted = !!s.engineerEnabled && status.running && installed;
  if (eng.running) eng.stop();
  if (wanted) {
    try {
      await eng.start(status.port);
    } catch (err) {
      eng.lastError = err && err.message ? err.message : String(err);
    }
  } else if (!!s.engineerEnabled && !installed && eng.vanished(s.engineerVoice)) {
    // Downloaded before, gone now — almost always antivirus quarantine.
    // Silence here reads as a dead toggle in the field; say what happened.
    eng.lastError =
      'The voice files have gone missing since they were downloaded — antivirus ' +
      'software may have quarantined them. Restore them, or re-download the voice.';
  } else {
    eng.lastError = null;
  }
  eng.pushStatus();
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
      onDevicesChanged: () => pushWheelDevices(),
    });
  }
  return gamepad;
}

/** Start/stop polling to match whether any binding (or capture) needs it. */
function syncGamepad(settings) {
  const s = settings || loadSettings();
  // Polled only for what the operator has actually bound (or is binding). It
  // used to poll whenever the server was up, purely to watch the driver's own
  // aid buttons and keep an estimated TC/ABS value honest — the aids are read
  // live from the car now, so nobody has to watch the wheel to know where they
  // are set.
  const wanted = wheelCapture !== null || Object.keys(s.wheelBindings || {}).length > 0;
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
    // The label is carried with the binding because "hat 1 up" only makes sense
    // next to the device that reported it — the number alone reads as "btn 201".
    const { describeButton } = require('./gamepad');
    capture.resolve({ ok: true, device, button, label: describeButton(button) });
    syncGamepad();
    return;
  }

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

/**
 * Run an action by id, putting the outcome where the driver can see it.
 *
 * A bound button is pressed with both hands on the wheel and no terminal in
 * sight, so a failure that only reaches console.warn reads as a dead button —
 * which is exactly how an unbound Pit Request key presented. Failures go to
 * the in-game layer as a transient notice, named after the action's label so
 * the message says what was pressed; successes stay silent unless the action
 * carried its own `notice`, because most of them (overlay toggle, a pit value
 * stepping) are their own feedback.
 */
async function runAction(id, dir) {
  const result = await getActions().run(id, dir);
  if (result && result.ok === false) {
    console.warn(`[action] ${id} failed: ${result.error}`);
    const action = getActions().get(id);
    sendIngameNotice({
      kind: 'error',
      text: `${(action && action.label) || id}: ${result.error || 'failed'}`,
    });
  } else if (result && result.notice) {
    sendIngameNotice({ kind: 'ok', text: result.notice });
  }
  return result;
}

/** Push a transient notice to the in-game layer, if it is up to show one. */
function sendIngameNotice(notice) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('ingame:notice', notice);
  }
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
/**
 * Bindings for actions this app has REMOVED, matched by id prefix.
 *
 * Deliberately an explicit list rather than "anything the registry doesn't
 * know". Half the registry is conditional — the pit actions only exist when
 * `dist/` loaded — so a sweep against the live registry would quietly delete a
 * driver's pit bindings on the one launch where a module failed to load. An
 * explicit list can only ever remove what it names.
 */
const REMOVED_ACTION_PREFIXES = [
  // Per-aid delta actions (`aid.tc`, `aid.abs`, …). The MFD cursor reaches
  // every aid, so these were redundant — and worse than redundant: nothing
  // stopped the same wheel button carrying both `aid.tc` and `pit.valueInc`,
  // which moved traction control every time the driver changed a pit value.
  'aid.',
];

/**
 * Drops bindings left behind by removed actions.
 *
 * A stale binding is not merely untidy. A global hotkey for a dead action still
 * **consumes the key** — it stops reaching the sim and does nothing in
 * exchange — and a stale wheel binding keeps firing a lookup on every press.
 * Neither is visible in the UI, because the row it belonged to is gone.
 */
function pruneRemovedBindings() {
  const isRemoved = (id) => REMOVED_ACTION_PREFIXES.some((p) => id.startsWith(p));
  const s = loadSettings();
  const actionBindings = {};
  const wheelBindings = {};
  const dropped = [];
  for (const [id, accel] of Object.entries(s.actionBindings || {})) {
    if (!isRemoved(id)) actionBindings[id] = accel;
    else if (accel) dropped.push(`${id} (key ${accel})`);
  }
  for (const [id, entry] of Object.entries(s.wheelBindings || {})) {
    if (!isRemoved(id)) wheelBindings[id] = entry;
    else dropped.push(`${id} (wheel)`);
  }
  const changed =
    Object.keys(actionBindings).length !== Object.keys(s.actionBindings || {}).length ||
    Object.keys(wheelBindings).length !== Object.keys(s.wheelBindings || {}).length;
  if (!changed) return;

  if (dropped.length > 0) {
    console.log(`[bindings] removed ${dropped.length} binding(s) for actions that no longer exist:`);
    for (const d of dropped) console.log(`  ${d}`);
  }
  saveSettings({ ...s, actionBindings, wheelBindings });
}

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
    // The widget's own background, and the global it would otherwise follow.
    // `undefined` opacity is the card's "Auto" state — it has no override, and
    // the global is what it needs to SHOW while that is true.
    opacity: settings.widgetOpacity[o.id],
    globalOpacity: settings.panelOpacity,
    // Only the standings tower has one, and only its card draws the control.
    // Sent on every overlay so the card builder stays a plain map over the
    // catalog rather than a special case that has to know which id it is on.
    view: o.id === 'standings' ? settings.standings : undefined,
    // The selected design for widgets that declare `designs` in the catalog —
    // absent from settings means the first (default) entry.
    design: o.designs ? settings.widgetModes[o.id] || o.designs[0].id : undefined,
  }));
}

/* -------------------------------------------------------------------------- */
/*  In-game overlay layer                                                      */
/* -------------------------------------------------------------------------- */
/*
 * ONE transparent, frameless, always-on-top window spanning the whole desktop
 * hosts every in-game widget (a single renderer process — far lighter than a
 * window per widget). While locked it is fully click-through
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

/**
 * Every display's bounds in PHYSICAL screen pixels, and the primary's.
 *
 * `display.bounds` is in that display's OWN DIP, so on a desktop whose screens
 * do not share a Windows scaling percentage the rects cannot be compared with
 * each other, let alone unioned — see the pixel-space note in
 * electron/overlay-geometry.js for what that cost a tester. Physical pixels are
 * the one space every screen agrees on, so the union is taken there and mapped
 * into the window's space afterwards.
 *
 * Returns null when the conversion is not available — dipToScreenRect is
 * Windows-only — which puts this back on the raw DIP numbers it used before.
 * That is the correct fallback rather than a bug: the two spaces differ only
 * where scale factors do.
 */
function physicalDisplayBounds() {
  if (typeof screen.dipToScreenRect !== 'function') return null;
  try {
    const primary = screen.dipToScreenRect(null, screen.getPrimaryDisplay().bounds);
    if (!primary || !(primary.width > 0) || !(primary.height > 0)) return null;
    return {
      all: screen.getAllDisplays().map((d) => screen.dipToScreenRect(null, d.bounds)),
      primary,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Where the in-game layer lives, and the geometry it lays widgets out against.
 * The maths — and the reasoning behind the coordinate space, which is what makes
 * this change invisible to everyone on one monitor — is in
 * electron/overlay-geometry.js, so it can be tested against monitor
 * arrangements nobody here owns.
 *
 * The mapping handed to it converts physical pixels into the OVERLAY WINDOW'S
 * pixels, which is what `setBounds` takes and what the page's CSS pixels are.
 * `screenToDipRect` is passed the window itself so it uses that window's scale
 * factor rather than the nearest display's — the two differ precisely on the
 * mixed-scaling desktops this exists for. Before the window is built there is
 * nothing to pass and the nearest display is the best guess going; the call
 * straight after construction gets it right, and that one is the one that sizes
 * the layer.
 */
function overlayGeometry() {
  const phys = physicalDisplayBounds();
  if (!phys || typeof screen.screenToDipRect !== 'function') {
    return overlayGeometryFrom(
      screen.getAllDisplays().map((d) => d.bounds),
      screen.getPrimaryDisplay().bounds,
    );
  }
  const win = overlayWin && !overlayWin.isDestroyed() ? overlayWin : null;
  return overlayGeometryFrom(phys.all, phys.primary, (r) => screen.screenToDipRect(win, r));
}

/**
 * Force the layer onto the current desktop rectangle, and (unless it is still
 * loading) tell the page its new geometry.
 *
 * THIS IS NOT OPTIONAL POLISH — it is how the window gets its size at all.
 * BrowserWindow's constructor silently clamps the initial size to the PRIMARY
 * DISPLAY'S WORK AREA, and no combination of resizable/maximizable/
 * fullscreenable prevents it: asking for the 4480×1440 union of a two-monitor
 * desktop hands back 2560×1392. `setBounds` after construction is not clamped,
 * so the size in the constructor is only a starting guess and this is what makes
 * it true. Measured on Electron 33, 2026-08-06.
 *
 * That clamp had already cost us something nobody had connected: 1392 is the
 * work area, i.e. the screen less the 48px taskbar, so the layer has always been
 * a taskbar shorter than the screen it claimed to cover. Every bottom-anchored
 * widget default (tyres, pedals, damage) sat that much high, and the bottom
 * strip of the screen could not be used at all.
 *
 * Also called on display add/remove/metrics-changed, so plugging in the third
 * monitor or changing a resolution does not need the overlay toggled off and on
 * again. The bounds comparison matters there: `display-metrics-changed` fires
 * for things that leave the desktop rectangle alone — a work-area change when
 * the taskbar auto-hides, most obviously — and this window is drawn over a
 * running race, so it must not be touched for those.
 *
 * Loops because the answer can depend on where the window already is. The
 * bounds are in the window's own scale factor, and Windows takes that from
 * whichever monitor the window overlaps most — so on a desktop with mixed
 * scaling, growing the layer across a second screen can change the units the
 * rectangle was measured in, and the second pass is what asks again in the new
 * ones. Converges immediately on every rig whose screens share a scale factor,
 * which is all of them bar the mixed ones; the cap is there so a pathological
 * arrangement oscillates twice rather than forever.
 */
function applyOverlayGeometry({ notify = true } = {}) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  let geom = overlayGeometry();
  for (let pass = 0; pass < 3; pass++) {
    const cur = overlayWin.getBounds();
    const changed =
      cur.x !== geom.bounds.x ||
      cur.y !== geom.bounds.y ||
      cur.width !== geom.bounds.width ||
      cur.height !== geom.bounds.height;
    if (!changed) break;
    // The window is created non-resizable and non-movable so the operator can
    // never drag or stretch the layer itself. Windows enforces that against
    // setBounds too, so both are lifted for the width of the call.
    try {
      overlayWin.setResizable(true);
      overlayWin.setMovable(true);
      overlayWin.setBounds(geom.bounds);
    } finally {
      overlayWin.setResizable(false);
      overlayWin.setMovable(false);
    }
    geom = overlayGeometry();
  }
  if (notify) overlayWin.webContents.send('ingame:screens', geom.screens);
}

/**
 * Watch for the desktop changing shape. Debounced because these events arrive
 * in bursts — a single monitor being plugged in fires several — and each one
 * would otherwise re-bound the window the driver is looking through.
 */
let overlayGeometryTimer = null;
function watchDisplays() {
  const onChange = () => {
    if (overlayGeometryTimer) clearTimeout(overlayGeometryTimer);
    overlayGeometryTimer = setTimeout(() => {
      overlayGeometryTimer = null;
      applyOverlayGeometry();
    }, 400);
  };
  screen.on('display-added', onChange);
  screen.on('display-removed', onChange);
  screen.on('display-metrics-changed', onChange);
}

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
    // Catch a desktop that changed shape while the layer was hidden — the
    // watcher only fires while it is up.
    applyOverlayGeometry();
    if (overlayWin.ingameUrl !== url) {
      overlayWin.ingameUrl = url;
      void overlayWin.loadURL(url);
    }
    applyIngameVisibility(settings);
    return;
  }

  const { bounds } = overlayGeometry();
  overlayWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    // Born hidden; applyIngameVisibility below decides whether it appears.
    // With auto show/hide on and the driver in the menus, creating-then-hiding
    // would flash a frame of overlay over their screen.
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
    // Never steal focus from the game — mouse still works in edit mode.
    focusable: false,
    alwaysOnTop: true,
    title: 'Apex AIO (in-game)',
    webPreferences: {
      preload: path.join(__dirname, 'ingame-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep telemetry painting while the game window has focus.
      backgroundThrottling: false,
      // The audio cues (overlay/js/audio.js) are the point of this: Chromium
      // refuses to start an AudioContext without a user gesture, and this is a
      // click-through window over a game that nobody ever clicks — so without
      // this the one layer where a cue matters most would be the one layer that
      // stays silent. Nothing here plays media on its own; the only sound is a
      // cue a widget fires on an event the driver asked to be told about.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // The constructor's size is only a starting guess — Windows clamps it to the
  // primary display's work area no matter what is asked for. This is what
  // actually sizes the layer to the desktop; see applyOverlayGeometry. No
  // notify: the page has not loaded yet and fetches its own geometry at boot.
  applyOverlayGeometry({ notify: false });
  // 'screen-saver' level floats above borderless-fullscreen game windows.
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  applyIngameMouse(); // click-through unless edit/interact is already on
  applyIngameVisibility(settings); // shown now, or when the feed says on-track
  overlayWin.ingameUrl = url;
  // The layer is push-fed everything (it deliberately does no polling), so
  // every load — including the reloads triggered by a widget-list change — has
  // to be re-told the current state.
  //
  // Edit and interact are re-sent for the same reason, and it matters more than
  // it looks. A `send()` to a page that has not loaded yet is simply dropped, so
  // entering edit mode in the same breath as creating the window — which is what
  // the Off → Edit step of the hotkey cycle does — would flip every flag in the
  // main process and leave the layer itself with no handles on it. The same gap
  // let a widget-list change reload the page out of edit mode while the app
  // still believed it was in one.
  overlayWin.webContents.on('did-finish-load', () => {
    applyAppearance();
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.webContents.send('ingame:edit', ingameEditing);
    overlayWin.webContents.send('ingame:interact', ingameInteractive);
  });
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
 * Auto show/hide: whether the layer should be ON SCREEN right now. Distinct
 * from `wanted` in syncOverlayWindow, which decides whether the layer should
 * EXIST — the window lives for the whole time the sim might come back (so a
 * menu visit costs a hide/show, not a renderer teardown and page reload), and
 * this decides whether it is currently drawn.
 *
 *   - Edit / interact mode always shows: both exist to be used while looking
 *     at the layer, and edit is reachable from the control panel while the
 *     driver is sitting in the menus.
 *   - Auto off = the pre-auto behaviour: visible whenever it exists.
 *   - Deliberate demo mode (forced simulator, or the simulator chosen as the
 *     provider) is a preview with no session to key off, so it always shows.
 *     The FALLBACK to demo — LMU stopped answering — keeps auto in force;
 *     that distinction is why this checks settings rather than the feed flag.
 *   - Otherwise the feed decides: live frames whose session says the driver
 *     is at the wheel (see setFeedOnTrack).
 */
function ingameShouldBeVisible(settings) {
  if (ingameEditing || ingameInteractive) return true;
  const s = settings || loadSettings();
  if (!s.ingameAutoHide) return true;
  if (s.forceSimulator || s.provider === 'simulator') return true;
  return feedOnTrack;
}

/** Reflect ingameShouldBeVisible on the layer window, if there is one. */
function applyIngameVisibility(settings) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const want = ingameShouldBeVisible(settings);
  if (want === overlayWin.isVisible()) return;
  // showInactive, never show: the window is non-focusable and must not take
  // input from the game even for the moment it appears.
  if (want) overlayWin.showInactive();
  else overlayWin.hide();
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
    // Editing forces the layer on screen even when auto show/hide has it
    // hidden (laying out from the sim's menus must work); leaving edit mode
    // hands the decision back.
    applyIngameVisibility();
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
    applyIngameVisibility(); // same forcing rule as edit mode
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
/*  Pace scoring                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Score one lap against the reference table and shape it for the renderer.
 *
 * Extracted because three surfaces now score laps — the Leaderboard's own-bests
 * list, the Dashboard's week bests, and a clicked row on a league board — and
 * they must agree to the decimal. A second copy of this shaping would be a
 * second definition of what "103.2%" means, which is the kind of drift nobody
 * notices until two cards on the same screen disagree.
 *
 * `input` carries whatever layout hints the caller has. A board row has only
 * the track's name and length; a local lap also knows the sim's scene name and
 * the declared config. Fewer hints is not an error — it just makes an ambiguous
 * layout more likely, and `scoreLap` says so rather than guessing.
 */
function paceRowFor(ref, input) {
  const row = {
    track: input.track,
    carClass: input.carClass,
    car: input.car,
    lapMs: input.lapMs,
  };
  const scored = ref.scoreLap({
    track: input.track,
    trackConfig: input.trackConfig,
    simTrackName: input.simTrackName,
    trackLengthM: input.trackLengthM,
    carClass: input.carClass,
    car: input.car,
    lapMs: input.lapMs,
  });
  if (!scored.ok || !scored.score) {
    return { ...row, ok: false, reason: scored.reason, detail: scored.detail };
  }
  return {
    ...row,
    ok: true,
    percent: scored.score.percent,
    bandId: scored.score.bandId,
    bandLabel: scored.score.bandLabel,
    refMs: scored.score.refMs,
    layoutName: scored.score.layoutName,
    // The circuit as the reference table names it, which is not always what the
    // sim called it — and a layout on its own ("Grand Prix") says nothing
    // without the venue in front of it.
    circuitName: scored.score.circuitName,
    // How the layout was identified. `'only'` means the circuit has just one
    // layout in the table, which is what lets the UI drop a meaningless
    // "· Grand Prix" from a single-layout venue.
    via: scored.score.via,
    sheetClass: scored.score.sheetClass,
    assumed: scored.score.assumed,
  };
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
      if (typeof partial.ingameAutoHide === 'boolean') {
        next.ingameAutoHide = partial.ingameAutoHide;
      }
      if (typeof partial.ingameMagneticDock === 'boolean') {
        next.ingameMagneticDock = partial.ingameMagneticDock;
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
      // These two were missing from this handler while the control panel has
      // been sending both since they were added: the Text size slider and the
      // Change glow switch wrote to a key nothing here copied into `next`, so
      // they were saved nowhere and pushed nowhere.
      if (partial.textScale !== undefined) {
        next.textScale = clamp(partial.textScale, 80, 120, current.textScale);
      }
      if (typeof partial.changeGlow === 'boolean') {
        next.changeGlow = partial.changeGlow;
      }
      if (typeof partial.mfdAutoFade === 'boolean') {
        next.mfdAutoFade = partial.mfdAutoFade;
      }
      // Per-widget background overrides, merged key by key so a card can send
      // just its own widget. `null` is the documented "hand this one back to the
      // global slider" value — an override has to be removable, and a merge
      // alone could only ever add.
      if (partial.widgetOpacity && typeof partial.widgetOpacity === 'object') {
        const merged = { ...current.widgetOpacity };
        for (const [id, value] of Object.entries(partial.widgetOpacity)) {
          if (value === null || value === undefined) delete merged[id];
          else merged[id] = clamp(value, 0, 100, 100);
        }
        next.widgetOpacity = normalizeWidgetOpacity({ widgetOpacity: merged });
      }
      // Per-widget mode/design choices, merged key by key so a card can send
      // just its own widget. `null` removes the entry (back to the default).
      // Until this branch existed only the hotkey/wheel action path could write
      // widgetModes — a panel dropdown's update arrived here and was silently
      // dropped on the floor.
      if (partial.widgetModes && typeof partial.widgetModes === 'object') {
        const merged = { ...current.widgetModes };
        for (const [id, value] of Object.entries(partial.widgetModes)) {
          if (value === null || value === undefined) delete merged[id];
          else merged[id] = value;
        }
        next.widgetModes = normalizeWidgetModes({ widgetModes: merged });
      }
      // Standings composition, merged field by field so the panel can send one
      // number without restating the other four.
      if (partial.standings && typeof partial.standings === 'object') {
        next.standings = normalizeStandings({
          standings: { ...current.standings, ...partial.standings },
        });
      }
      if (partial.speedUnit === 'kph' || partial.speedUnit === 'mph') {
        next.speedUnit = partial.speedUnit;
      }
      if (partial.tempUnit === 'c' || partial.tempUnit === 'f') {
        next.tempUnit = partial.tempUnit;
      }
      if (partial.radarIconScale !== undefined) {
        next.radarIconScale = clamp(partial.radarIconScale, 30, 150, current.radarIconScale);
      }
      if (typeof partial.launchOnStartup === 'boolean') {
        next.launchOnStartup = partial.launchOnStartup;
      }
      if (typeof partial.audioCues === 'boolean') {
        next.audioCues = partial.audioCues;
      }
      if (partial.audioVolume !== undefined) {
        next.audioVolume = clamp(partial.audioVolume, 0, 100, current.audioVolume);
      }
      if (typeof partial.engineerEnabled === 'boolean') {
        next.engineerEnabled = partial.engineerEnabled;
      }
      if (typeof partial.engineerVoice === 'string' && partial.engineerVoice.trim()) {
        next.engineerVoice = partial.engineerVoice.trim();
      }
      if (partial.engineer && typeof partial.engineer === 'object') {
        // Merge-then-sanitize, so a partial like { engineer: { readouts } }
        // can't wipe fields it didn't mention. No restart: the engineer reads
        // live fields from this block and applies interval changes in place.
        next.engineer = sanitizeEngineer(
          { ...current.engineer, ...partial.engineer },
          current.engineer,
        );
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
      next.changeGlow !== current.changeGlow ||
      next.mfdAutoFade !== current.mfdAutoFade ||
      next.radarIconScale !== current.radarIconScale ||
      next.audioCues !== current.audioCues ||
      next.audioVolume !== current.audioVolume ||
      JSON.stringify(next.widgetOpacity) !== JSON.stringify(current.widgetOpacity) ||
      JSON.stringify(next.widgetModes) !== JSON.stringify(current.widgetModes) ||
      JSON.stringify(next.standings) !== JSON.stringify(current.standings) ||
      next.speedUnit !== current.speedUnit ||
      next.tempUnit !== current.tempUnit
    ) {
      applyAppearance(next);
    }

    // Desktop behaviour: both take effect the moment the switch moves, rather
    // than at the next launch. A "launch on startup" switch that only wrote the
    // registry entry on quit would be indistinguishable from a broken one until
    // the operator rebooted.
    if (next.launchOnStartup !== current.launchOnStartup) applyLaunchOnStartup(next);

    // Magnetic docking reaches a layer that may already be open in edit mode.
    // Pushing it means the operator can flip the switch and carry on dragging;
    // without this the change would only land the next time the layer was
    // rebuilt, which reads as a dead switch.
    if (next.ingameMagneticDock !== current.ingameMagneticDock) {
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('ingame:dock', !!next.ingameMagneticDock);
      }
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

    // The engineer restarts on its own switches (and a server restart moved the
    // port under it, which syncEngineer also repairs).
    if (
      next.engineerEnabled !== current.engineerEnabled ||
      next.engineerVoice !== current.engineerVoice ||
      needsRestart
    ) {
      void syncEngineer(next);
    } else if (
      engineerService &&
      JSON.stringify(next.engineer) !== JSON.stringify(current.engineer)
    ) {
      // Nested controls change nothing about the voice pipeline. Apply mutable
      // trigger tuning in place so its session history survives, then refresh
      // the panel with the sanitized value.
      engineerService.applyLiveSettings();
      engineerService.pushStatus();
    }

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

  // Desktop geometry for the layer: how many screens there are, where they sit
  // relative to the primary one, and how far the window's own top-left is from
  // it. Fetched once at boot; pushed again over 'ingame:screens' if the desktop
  // changes shape underneath a running layer.
  ipcMain.handle('ingame:screensGet', () => overlayGeometry().screens);

  // Whether widgets snap to each other while being laid out. Read once at boot
  // and pushed on 'ingame:dock' when the switch moves, so a layer already open
  // in edit mode picks the change up without being reopened. Deliberately NOT
  // on the appearance channel: that one is polled once a second over HTTP by
  // every OBS Browser Source, and a layout-editor preference has no business
  // being broadcast to them.
  ipcMain.handle('ingame:dockGet', () => !!loadSettings().ingameMagneticDock);

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

  /* ---- Lap database ---- */

  /**
   * The Dashboard's "Your week" card: a rolling 7-day summary of the local lap
   * files that `telemetry/lapLog` writes.
   *
   * Read on demand rather than cached, because the file grows underneath us
   * while the driver is on track and the card is meant to move when they come
   * back to it. A week of hard practice is a few hundred short lines — reading
   * it costs less than the IPC round trip that asked for it.
   *
   * The module is required lazily and defensively: the summary is a nicety, and
   * an unbuilt or broken `dist/` must degrade this card to zeroes rather than
   * take down the whole panel, which is the one screen that can start the server.
   */
  ipcMain.handle('laps:week', () => {
    try {
      const lapLog = require(path.join(__dirname, '..', 'dist', 'telemetry', 'lapLog.js'));
      return lapLog.summarize(Date.now(), 7);
    } catch (err) {
      console.error('[app] lap summary unavailable:', err.message);
      return { days: [], laps: 0, cleanLaps: 0, distanceM: 0, drivingMs: 0, tracks: 0, bests: [] };
    }
  });

  /**
   * Pace scores for the driver's best CLEAN laps — the Dashboard's fourth stat
   * tile and the Leaderboard tab's reference card.
   *
   * Clean laps rather than the sim's session best, unlike the overlay: this
   * screen is closer to a claim about the driver than a live readout, and the
   * league's own rule is that a time with an excursion in it is not a time. The
   * two surfaces are allowed to disagree by exactly that much, and the widget's
   * own comment says the same from the other side.
   *
   * The attribution rides on the response rather than being hardcoded in the
   * renderer, so the panel physically cannot render a score without having
   * Ohne Speed's credit to hand.
   */
  ipcMain.handle('laps:pace', () => {
    try {
      const lapLog = require(path.join(__dirname, '..', 'dist', 'telemetry', 'lapLog.js'));
      const ref = require(path.join(__dirname, '..', 'dist', 'telemetry', 'referencePace.js'));
      // All-time bests, not this week's: a personal best does not expire on
      // Sunday the way the rolling lap count does.
      const plan = lapLog.buildUploadPlan();
      const rows = plan.bests.map((best) =>
        paceRowFor(ref, {
          track: best.trackName,
          trackConfig: best.trackConfig,
          simTrackName: best.simTrackName,
          trackLengthM: best.trackLengthM,
          carClass: best.carClass,
          car: best.car,
          lapMs: best.lapMs,
        }),
      );
      // Best first — the tile shows the single strongest result, and a driver
      // reading the list wants their high-water mark at the top.
      const scored = rows.filter((r) => r.ok).sort((a, b) => a.percent - b.percent);
      const unscored = rows.filter((r) => !r.ok);
      return {
        rows: [...scored, ...unscored],
        best: scored[0] || null,
        credit: ref.referenceCredit(),
        sheetUpdated: ref.referenceUpdated(),
      };
    } catch (err) {
      console.error('[app] pace scores unavailable:', err.message);
      return { rows: [], best: null, credit: null, sheetUpdated: '' };
    }
  });

  /**
   * Score an arbitrary set of laps — the same scoring as `laps:pace`, but for
   * laps the caller already has rather than for the driver's own bests.
   *
   * Two callers, and neither could use `laps:pace`:
   *   - the Dashboard's "best clean laps this week", which are THIS WEEK's
   *     times. `laps:pace` reads all-time bests, so scoring a week row through
   *     it would quietly show a faster lap than the one on the screen.
   *   - a row clicked on a league board, which is another driver's lap and is
   *     not in the local files at all.
   *
   * Scoring is pure and local — a table lookup and a division — so a batch of a
   * full board costs less than the round trip that asked for it. Capped anyway:
   * the renderer is trusted, but a channel that will loop over whatever array it
   * is handed is a bad shape to leave lying around.
   */
  ipcMain.handle('laps:score', (_evt, laps) => {
    if (!Array.isArray(laps) || !laps.length) return [];
    try {
      const ref = require(path.join(__dirname, '..', 'dist', 'telemetry', 'referencePace.js'));
      return laps.slice(0, 250).map((lap) =>
        paceRowFor(ref, {
          track: String((lap && lap.track) || ''),
          trackConfig: lap && lap.trackConfig ? String(lap.trackConfig) : undefined,
          simTrackName: lap && lap.simTrackName ? String(lap.simTrackName) : undefined,
          trackLengthM: Number((lap && lap.trackLengthM) || 0),
          carClass: String((lap && lap.carClass) || ''),
          car: String((lap && lap.car) || ''),
          lapMs: Number((lap && lap.lapMs) || 0),
        }),
      );
    } catch (err) {
      // Same degradation as the pace card: an unbuilt `dist/` costs the scores,
      // not the screen. The renderer leaves those rows unscored and inert.
      console.error('[app] lap scoring unavailable:', err.message);
      return [];
    }
  });

  /* ---- Setup editor ----
   *
   * The Setups tab's whole data path: a fresh read-through of LMU's garage API
   * per call, writes validated server-side against the sim's own bounds. No
   * cache and no timer here on purpose — the renderer polls only while the tab
   * is visible, so a closed tab costs literally nothing.
   *
   * Talks to LMU directly (not through the overlay server) so setup editing
   * works with the stream server stopped. The controller is rebuilt when the
   * configured LMU port changes and kept otherwise — it is stateless, but
   * requiring dist/ on every slider tick would be silly.
   */
  let setupController = null;
  let setupControllerPort = 0;
  const getSetupController = () => {
    const settings = loadSettings();
    const port = Number.isFinite(settings.lmuApiPort) ? settings.lmuApiPort : 6397;
    if (!setupController || setupControllerPort !== port) {
      const mod = require(path.join(__dirname, '..', 'dist', 'telemetry', 'setupControl.js'));
      setupController = new mod.SetupController({ lmuApiPort: port });
      setupControllerPort = port;
    }
    return setupController;
  };

  ipcMain.handle('setup:state', async () => {
    try {
      return await getSetupController().getState();
    } catch (err) {
      // An unbuilt dist/ degrades to the tab's offline card, not a dead panel.
      console.error('[app] setup state unavailable:', err.message);
      return { connected: false, car: '', carClass: '', symmetric: false, settings: [] };
    }
  });

  ipcMain.handle('setup:write', async (_evt, payload) => {
    try {
      const key = String((payload && payload.key) || '');
      const value = Number(payload && payload.value);
      if (!key || !Number.isFinite(value)) return { ok: false, error: 'needs { key, value }' };
      return await getSetupController().setValue(key, value);
    } catch (err) {
      console.error('[app] setup write failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setup:writeBatch', async (_evt, payload) => {
    try {
      const writes = payload && Array.isArray(payload.writes) ? payload.writes : [];
      if (!writes.length) return { ok: false, error: 'needs { writes: [...] }' };
      return await getSetupController().setBatch(writes);
    } catch (err) {
      console.error('[app] setup batch failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  /**
   * The current car's 3/4 render in its own livery — a custom paint included,
   * fetched from raceos.gg — as a data URL the panel's CSP accepts (img-src
   * allows data:). Cached by the controller's key: the .VEH id for stock art,
   * the S3 URI for a custom paint (a re-upload is a new URI, so a repainted
   * livery refreshes on the next car change instead of sticking forever).
   */
  const carImageCache = new Map();
  ipcMain.handle('setup:carImage', async () => {
    try {
      const img = await getSetupController().carImage();
      if (!img) return { ok: false };
      if (!carImageCache.has(img.key)) {
        // A handful of liveries per session at most; 12 is generous.
        if (carImageCache.size >= 12) {
          carImageCache.delete(carImageCache.keys().next().value);
        }
        carImageCache.set(img.key, `data:image/webp;base64,${img.webp.toString('base64')}`);
      }
      return { ok: true, vehId: img.vehId, dataUrl: carImageCache.get(img.key) };
    } catch (err) {
      console.error('[app] car image unavailable:', err.message);
      return { ok: false };
    }
  });

  /* ---- Setup library ----
   *
   * Named, colour-tagged copies of real .svm files under the app's own
   * userData — the sim writes them (save) and reads them back (load) via its
   * REST API, the app owns the catalogue. Sharing is the raw .svm through OS
   * save/open dialogs: the artifact works for ANY LMU player, app or not.
   *
   * Every list is enriched with the driver's best lap for the entry's track
   * and class from the local lap database — that join happens here because
   * main already owns lapLog, and freezing the lap into the entry at save
   * time would show a stale best forever after.
   */
  let setupLibrary = null;
  const getSetupLibrary = () => {
    const controller = getSetupController();
    if (!setupLibrary || setupLibrary.__controller !== controller) {
      const lib = require(path.join(__dirname, '..', 'dist', 'telemetry', 'setupLibrary.js'));
      const kb = require(path.join(__dirname, '..', 'dist', 'server', 'lmuKeybinds.js'));
      const kbPath = kb.findKeyboardConfig();
      const settingsDir = kbPath ? path.join(path.dirname(kbPath), 'Settings') : null;
      setupLibrary = new lib.SetupLibrary(
        path.join(app.getPath('userData'), 'setups'),
        controller,
        settingsDir && fs.existsSync(settingsDir) ? settingsDir : null,
      );
      setupLibrary.__controller = controller;
    }
    return setupLibrary;
  };

  /** Best clean lap per (trackName, carClass) from the local lap files. */
  const bestLapFor = (bests, entry) => {
    if (!Array.isArray(bests)) return null;
    const hit = bests.find(
      (b) =>
        b &&
        (b.trackName || '').toLowerCase() === (entry.trackName || '').toLowerCase() &&
        (b.carClass || '').toUpperCase() === (entry.carClass || '').toUpperCase(),
    );
    return hit ? { lapMs: hit.lapMs, setAt: hit.setAt } : null;
  };

  ipcMain.handle('setuplib:list', () => {
    try {
      const entries = getSetupLibrary().list();
      let bests = [];
      try {
        const lapLog = require(path.join(__dirname, '..', 'dist', 'telemetry', 'lapLog.js'));
        bests = lapLog.buildUploadPlan().bests;
      } catch {
        /* no lap database — entries simply carry no best lap */
      }
      return {
        ok: true,
        entries: entries.map((e) => ({ ...e, bestLap: bestLapFor(bests, e) })),
      };
    } catch (err) {
      console.error('[app] setup library list failed:', err.message);
      return { ok: false, error: err.message, entries: [] };
    }
  });

  ipcMain.handle('setuplib:save', async (_evt, meta) => {
    try {
      const res = await getSetupLibrary().saveCurrent(meta || {});
      if (!res.ok) console.error('[app] setup library save failed:', res.error);
      return res;
    } catch (err) {
      console.error('[app] setup library save failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  // Share half 2: put the .svm ON THE CLIPBOARD AS A FILE, so Ctrl+V drops it
  // straight into Discord or WhatsApp. Electron's clipboard API cannot write
  // the Windows CF_HDROP file format, but PowerShell's Set-Clipboard can, and
  // this is a user-initiated click on a file the app owns.
  ipcMain.handle('setuplib:clip', async (_evt, payload) => {
    try {
      const lib = getSetupLibrary();
      const entry = lib.list().find((e) => e.id === String(payload && payload.id));
      if (!entry) return { ok: false, error: 'setup not in library' };
      // Copy under the readable name — what lands in the chat says what it is.
      const stagingDir = path.join(app.getPath('userData'), 'setups', 'share');
      fs.mkdirSync(stagingDir, { recursive: true });
      const shareFile = path.join(stagingDir, `${entry.name}.svm`);
      const res = lib.exportTo(entry.id, shareFile);
      if (!res.ok) return res;
      const { execFile } = require('node:child_process');
      await new Promise((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-Command', `Set-Clipboard -LiteralPath '${shareFile.replace(/'/g, "''")}'`],
          { windowsHide: true },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      return { ok: true, entry };
    } catch (err) {
      console.error('[app] setup clipboard share failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setuplib:update', (_evt, payload) => {
    try {
      return getSetupLibrary().update(String(payload && payload.id), (payload && payload.patch) || {});
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setuplib:delete', (_evt, payload) => {
    try {
      return getSetupLibrary().remove(String(payload && payload.id));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Share = hand the raw .svm to the OS. The save dialog defaults to the
  // entry's readable name so what lands in a Discord DM says what it is.
  ipcMain.handle('setuplib:export', async (_evt, payload) => {
    try {
      const lib = getSetupLibrary();
      const entry = lib.list().find((e) => e.id === String(payload && payload.id));
      if (!entry) return { ok: false, error: 'setup not in library' };
      const res = await dialog.showSaveDialog({
        title: 'Share setup',
        defaultPath: `${entry.name}.svm`,
        filters: [{ name: 'LMU setup', extensions: ['svm'] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      return lib.exportTo(entry.id, res.filePath);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setuplib:import', async () => {
    try {
      const res = await dialog.showOpenDialog({
        title: 'Import setup',
        properties: ['openFile'],
        filters: [{ name: 'LMU setup', extensions: ['svm'] }],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
      return getSetupLibrary().importFrom(res.filePaths[0], {});
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ---- League leaderboard ----
   *
   * The boards themselves live in Postgres, because a leaderboard is the one
   * part of the lap database that is inherently about other people — everything
   * else in this file reads local files on purpose. Two security-definer RPCs do
   * the ranking and the join server-side (`leaderboard`, `leaderboard_filters`);
   * the rows they return were already readable under RLS, so they buy one round
   * trip instead of three, not extra access.
   */

  /** Track/class/car combinations that actually have laps on them. */
  ipcMain.handle('leaderboard:filters', async () => {
    const res = await authService.rpc('leaderboard_filters', { p_sim: 'lmu' });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in to see the league boards.' : res.error || 'Board unavailable.',
        rows: [],
      };
    }
    return { ok: true, rows: Array.isArray(res.body) ? res.body : [] };
  });

  /**
   * One board, ranked. `car` is a narrowing filter rather than a second axis:
   * boards stay keyed on (track, class) the way `submit_lap` stores them, so a
   * driver's entry is their best in the class whichever car set it.
   */
  ipcMain.handle('leaderboard:rows', async (_evt, query) => {
    const q = query || {};
    const res = await authService.rpc('leaderboard', {
      p_sim: 'lmu',
      p_track_id: q.trackId || null,
      p_car_class: q.carClass || null,
      p_car: q.car || null,
      p_limit: 200,
    });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in to see the league boards.' : res.error || 'Board unavailable.',
        rows: [],
      };
    }
    return { ok: true, rows: Array.isArray(res.body) ? res.body : [] };
  });

  /** Where the lap uploader has got to, for the Dashboard's sync line. */
  ipcMain.handle('laps:syncState', () => lapUpload.stateForUi());

  /**
   * Sync now. The background timer runs every few minutes, which is right for a
   * driver mid-stint and far too slow for one who has just finished and wants to
   * see their time on the board.
   */
  ipcMain.handle('laps:sync', () => lapUpload.sync({ reason: 'manual' }));

  /* ---- Community setups ----
   *
   * The setup library's cloud half: publish a library entry (the raw .svm
   * travels whole, alongside its parsed values), browse everyone's shares,
   * download one back into BOTH the sim's own Settings tree (so it appears in
   * the game's setup screen) and the local library (so the panel can stage
   * it), and rate what you have downloaded. All five are thin wrappers over
   * security-definer RPCs — the server owns the download gate and the
   * one-rating-per-driver rule.
   *
   * "Verified" lap times are attached HERE, in main, never typed by the
   * renderer: the uploader's (and rater's) best clean lap for the setup's
   * track+class comes straight from the local lap database.
   */

  /**
   * The renderer never invents a lap time; main looks it up or sends null.
   * With a fingerprint, the lap log is asked for the best clean lap DRIVEN ON
   * that setup first (`onSetup: true` — attribution proven by the stamp each
   * v4 lap carries); the plain track+class best is the labelled fallback.
   */
  const verifiedBest = (trackName, carClass, fingerprint) => {
    try {
      const lapLog = require(path.join(__dirname, '..', 'dist', 'telemetry', 'lapLog.js'));
      if (fingerprint) {
        const on = lapLog.bestOnSetup(trackName, carClass, fingerprint);
        if (on) return { lapMs: on.lapMs, onSetup: true };
      }
      const hit = bestLapFor(lapLog.buildUploadPlan().bests, { trackName, carClass });
      return { lapMs: hit ? hit.lapMs : null, onSetup: false };
    } catch {
      return { lapMs: null, onSetup: false };
    }
  };

  const cloudFail = (res, verb) => ({
    ok: false,
    signedOut: !!res.signedOut,
    error: res.signedOut ? `Sign in to ${verb} community setups.` : res.error || 'Community unavailable.',
  });

  /** Every public setup, light rows — the renderer filters/sorts locally. */
  ipcMain.handle('setupcloud:list', async () => {
    const res = await authService.rpc('browse_setups', {});
    if (!res.ok) return { ...cloudFail(res, 'browse'), rows: [] };
    return { ok: true, rows: Array.isArray(res.body) ? res.body : [] };
  });

  ipcMain.handle('setupcloud:publish', async (_evt, payload) => {
    const p = payload || {};
    try {
      const lib = getSetupLibrary();
      const entry = lib.list().find((e) => e.id === String(p.id));
      if (!entry) return { ok: false, error: 'setup not in library' };
      if (!entry.trackFolder) {
        // Imported files carry no track; only garage-saved entries know theirs.
        return { ok: false, error: 'This setup has no track attached — re-save it from the garage first.' };
      }
      const svmText = fs.readFileSync(
        path.join(app.getPath('userData'), 'setups', 'files', entry.fileName),
        'utf8',
      );
      const fp = require(path.join(__dirname, '..', 'dist', 'telemetry', 'setupFingerprint.js'))
        .fingerprintValues(entry.values || {});
      const best = verifiedBest(entry.trackName, entry.carClass, fp);
      const res = await authService.rpc('publish_setup', {
        p_name: String(p.name || entry.name).slice(0, 60),
        p_notes: String(p.notes ?? entry.notes ?? '').slice(0, 500),
        p_track_folder: entry.trackFolder,
        p_track_name: entry.trackName || '',
        p_car: entry.car || '',
        p_car_class: entry.carClass || '',
        p_vehicle_class: entry.vehicleClass || '',
        p_session_type: entry.sessionType || '',
        p_tags: Array.isArray(p.tags) ? p.tags.map((t) => String(t).slice(0, 24)).slice(0, 8) : [],
        p_values: entry.values || {},
        p_svm: svmText,
        p_best_lap_ms: best.lapMs,
        p_app_version: app.getVersion(),
        p_fingerprint: fp,
        p_best_lap_on_setup: best.onSetup,
      });
      if (!res.ok) return cloudFail(res, 'publish');
      const body = res.body || {};
      if (!body.ok) return { ok: false, error: `Publish refused (${body.reason || 'unknown'}).` };
      return { ok: true, id: body.id };
    } catch (err) {
      console.error('[app] setup publish failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setupcloud:unpublish', async (_evt, payload) => {
    const res = await authService.rpc('unpublish_setup', { p_id: String(payload && payload.id) });
    if (!res.ok) return cloudFail(res, 'manage');
    return { ok: !!(res.body && res.body.ok) };
  });

  /**
   * Download = three landings from one fetch: the raw .svm into the sim's own
   * Settings/<trackFolder>/ (that alone makes it loadable in-game), a copy
   * into the local library via the normal import path, and — when LMU is
   * running — a refreshsetups poke so the game's list updates without a
   * restart. The sim tree being missing degrades to library-only, reported.
   */
  ipcMain.handle('setupcloud:download', async (_evt, payload) => {
    const res = await authService.rpc('download_setup', { p_id: String(payload && payload.id) });
    if (!res.ok) return cloudFail(res, 'download');
    const body = res.body || {};
    if (!body.ok || !body.setup) return { ok: false, error: `Download refused (${body.reason || 'unknown'}).` };
    const s = body.setup;
    try {
      const safe =
        String(s.name)
          .replace(/[<>:"/\\|?*]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60) || 'Community setup';

      // Stage the file once under its readable name, then let the normal
      // import path file it into the library with full metadata.
      const stagingDir = path.join(app.getPath('userData'), 'setups', 'share');
      fs.mkdirSync(stagingDir, { recursive: true });
      const staged = path.join(stagingDir, `${safe}.svm`);
      fs.writeFileSync(staged, s.svm);
      const imported = getSetupLibrary().importFrom(staged, {
        name: s.name,
        trackFolder: s.trackFolder,
        trackName: s.trackName,
        sessionType: s.sessionType,
      });

      // Into the sim's own tree, where the in-game setup screen looks.
      let inGame = false;
      const kb = require(path.join(__dirname, '..', 'dist', 'server', 'lmuKeybinds.js'));
      const kbPath = kb.findKeyboardConfig();
      const settingsDir = kbPath ? path.join(path.dirname(kbPath), 'Settings') : null;
      if (settingsDir && fs.existsSync(settingsDir) && s.trackFolder) {
        const dir = path.join(settingsDir, s.trackFolder);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${safe}.svm`), s.svm);
        inGame = true;
        // Only works while LMU runs; failing to poke a closed sim is fine —
        // it rescans the folder on its next launch anyway.
        try {
          await getSetupController().refreshSetupFiles();
        } catch {
          /* sim not running */
        }
      }
      return { ok: true, inGame, entry: imported.ok ? imported.entry : null, setup: { ...s, svm: undefined } };
    } catch (err) {
      console.error('[app] setup download failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setupcloud:rate', async (_evt, payload) => {
    const p = payload || {};
    const stars = Math.max(1, Math.min(5, Math.round(Number(p.stars) || 0)));
    const best = verifiedBest(
      String(p.trackName || ''),
      String(p.carClass || ''),
      String(p.fingerprint || ''),
    );
    const res = await authService.rpc('rate_setup', {
      p_id: String(p.id),
      p_stars: stars,
      p_lap_ms: best.lapMs,
      p_lap_on_setup: best.onSetup,
    });
    if (!res.ok) return cloudFail(res, 'rate');
    const body = res.body || {};
    if (!body.ok) {
      const why =
        body.reason === 'not_downloaded'
          ? 'Download the setup before rating it.'
          : body.reason === 'own_setup'
            ? 'You cannot rate your own setup.'
            : `Rating refused (${body.reason || 'unknown'}).`;
      return { ok: false, error: why };
    }
    return { ok: true, avgStars: body.avgStars, ratingCount: body.ratingCount };
  });

  /* ---- Feedback + admin panel ----
   *
   * Thin, like the leaderboard handlers: auth.js owns the token and the call,
   * and the RPCs authorise themselves server-side (submit_feedback needs a
   * session; the admin_* functions check is_admin). Main just shapes the result
   * the way the renderer expects — `signedOut` reported as a state, never an
   * error — and clamps the inputs.
   */

  /** File one suggestion/bug from the Suggestions tab. */
  ipcMain.handle('feedback:submit', async (_evt, payload) => {
    const p = payload || {};
    const kind = ['idea', 'bug', 'other'].includes(p.kind) ? p.kind : 'idea';
    const message = typeof p.message === 'string' ? p.message.trim() : '';
    if (!message) return { ok: false, error: 'Type a message first.' };
    const res = await authService.rpc('submit_feedback', {
      p_kind: kind,
      p_message: message.slice(0, 4000),
      p_app_version: app.getVersion(),
    });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in to send feedback.' : res.error || 'Could not send.',
      };
    }
    return { ok: true, id: res.body };
  });

  /**
   * Replies the league has written that this driver has not read yet.
   *
   * Called on panel start and again after a sign-in, which is why a signed-out
   * result is reported as an empty list rather than an error: at boot there is
   * very often no session yet, and an unread check is not something to put a
   * red message on screen about.
   */
  ipcMain.handle('feedback:unreadReplies', async () => {
    const res = await authService.rpc('feedback_unread_replies', {});
    if (!res.ok) return { ok: false, signedOut: !!res.signedOut, rows: [] };
    return { ok: true, rows: Array.isArray(res.body) ? res.body : [] };
  });

  /** Acknowledge one reply, so it stops being offered. */
  ipcMain.handle('feedback:markReplySeen', async (_evt, payload) => {
    const id = Number((payload || {}).id);
    if (!Number.isFinite(id)) return { ok: false, error: 'bad arguments' };
    const res = await authService.rpc('feedback_mark_reply_seen', { p_id: id });
    if (!res.ok) return { ok: false, signedOut: !!res.signedOut, error: res.error || 'Failed.' };
    return { ok: true };
  });

  /**
   * League calendar for the Schedule tab: Thursday + Saturday championships
   * from SimGrid. The Bearer token stays in electron/simgrid.js; this handler
   * only ever returns names, times and https signup URLs.
   */
  ipcMain.handle('schedule:get', (_evt, query) =>
    simgrid.getSchedule({ force: !!(query && query.force) }),
  );

  /**
   * Whether the signed-in driver is a league admin — decides whether the panel
   * shows the Admin tab at all. A non-admin (or signed-out) driver just gets
   * `isAdmin: false`; the RPC never raises for them.
   */
  ipcMain.handle('admin:whoami', async () => {
    const res = await authService.rpc('admin_whoami', {});
    if (!res.ok) return { ok: false, isAdmin: false, signedOut: !!res.signedOut };
    return { ok: true, isAdmin: res.body === true };
  });

  /** The admin dashboard's headline numbers (usage, versions, 14-day trend). */
  ipcMain.handle('admin:overview', async () => {
    const res = await authService.rpc('admin_usage_overview', {});
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Unavailable.',
      };
    }
    return { ok: true, data: res.body || {} };
  });

  /** The feedback inbox, optionally filtered by status. */
  ipcMain.handle('admin:feedback', async (_evt, query) => {
    const q = query || {};
    const status = ['new', 'planned', 'in_progress', 'done', 'declined'].includes(q.status)
      ? q.status
      : null;
    const res = await authService.rpc('admin_feedback_list', { p_status: status, p_limit: 200 });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Unavailable.',
        rows: [],
      };
    }
    return { ok: true, rows: Array.isArray(res.body) ? res.body : [] };
  });

  /**
   * The driver roster — one row per account with name, email, how many times
   * the app has been opened, and when it was last open. Search and sort are
   * pushed to the server so a growing league does not turn into a growing
   * download; both are whitelisted there as well as here.
   */
  ipcMain.handle('admin:users', async (_evt, query) => {
    const q = query || {};
    const search = typeof q.search === 'string' ? q.search.trim().slice(0, 80) : '';
    const sort = ['last_seen', 'logins', 'name', 'joined', 'access'].includes(q.sort)
      ? q.sort
      : 'last_seen';
    const res = await authService.rpc('admin_users_list', {
      p_search: search || null,
      p_sort: sort,
      p_limit: 500,
    });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Unavailable.',
        rows: [],
      };
    }
    return { ok: true, rows: Array.isArray(res.body) ? res.body : [] };
  });

  /** Triage one feedback item to a new status. */
  ipcMain.handle('admin:setFeedbackStatus', async (_evt, payload) => {
    const p = payload || {};
    const id = Number(p.id);
    const status = ['new', 'planned', 'in_progress', 'done', 'declined'].includes(p.status)
      ? p.status
      : null;
    if (!Number.isFinite(id) || !status) return { ok: false, error: 'bad arguments' };
    const res = await authService.rpc('admin_feedback_set_status', { p_id: id, p_status: status });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Could not update.',
      };
    }
    return { ok: true };
  });

  /**
   * Answer one feedback item, optionally moving its status in the same call.
   *
   * The reply is clamped to the same 4000 characters as the message it answers
   * — the RPC clamps too, but a renderer that has already lost the tail is a
   * clearer bug than a server that silently truncated.
   */
  ipcMain.handle('admin:replyFeedback', async (_evt, payload) => {
    const p = payload || {};
    const id = Number(p.id);
    const reply = typeof p.reply === 'string' ? p.reply.trim() : '';
    const status = ['new', 'planned', 'in_progress', 'done', 'declined'].includes(p.status)
      ? p.status
      : null;
    if (!Number.isFinite(id)) return { ok: false, error: 'bad arguments' };
    if (!reply) return { ok: false, error: 'Write a reply first.' };
    const res = await authService.rpc('admin_feedback_reply', {
      p_id: id,
      p_reply: reply.slice(0, 4000),
      p_status: status,
    });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Could not send the reply.',
      };
    }
    return { ok: true };
  });

  /** Withdraw a reply — for the one sent against the wrong item. */
  ipcMain.handle('admin:clearFeedbackReply', async (_evt, payload) => {
    const id = Number((payload || {}).id);
    if (!Number.isFinite(id)) return { ok: false, error: 'bad arguments' };
    const res = await authService.rpc('admin_feedback_clear_reply', { p_id: id });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Could not remove the reply.',
      };
    }
    return { ok: true };
  });

  /**
   * Accounts whose card has failed, soonest deadline first.
   *
   * Rows carry the deadline the SERVER computed, not a day count worked out
   * here — the same rule that decides entitlement, so the admin list and the
   * lock can never tell different stories.
   */
  ipcMain.handle('admin:pastDue', async () => {
    const res = await authService.rpc('admin_billing_past_due', {});
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Unavailable.',
        rows: [],
      };
    }
    return { ok: true, rows: Array.isArray(res.body) ? res.body : [] };
  });

  /* ---- Admin: free access (league comps + voucher codes, v0.69.0) ---- */

  /** Codes issued + accounts currently comped, for the Free access card. */
  ipcMain.handle('admin:freeAccess', async () => {
    const res = await authService.rpc('admin_free_access_list', {});
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Unavailable.',
      };
    }
    return { ok: true, data: res.body || { codes: [], comps: [] } };
  });

  /** Cut N single-use league codes, all carrying the same note. */
  ipcMain.handle('admin:issueCodes', async (_evt, payload) => {
    const p = payload || {};
    const count = Math.max(1, Math.min(50, Math.round(Number(p.count) || 1)));
    const note = typeof p.note === 'string' ? p.note.trim().slice(0, 120) : '';
    const res = await authService.rpc('admin_issue_league_codes', {
      p_count: count,
      p_note: note,
    });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Could not issue codes.',
      };
    }
    return { ok: true, codes: Array.isArray(res.body) ? res.body : [] };
  });

  /**
   * The Billing section's numbers: the free/trial/paying mix, today's run rate,
   * and twelve months of MRR and churn. One RPC because they are one picture —
   * a chart that disagrees with the tile above it is worse than no chart.
   */
  ipcMain.handle('admin:billing', async () => {
    const res = await authService.rpc('admin_billing_overview', {});
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Unavailable.',
      };
    }
    return { ok: true, data: res.body || null };
  });

  /**
   * Put an account on free access. The reason is whitelisted here as well as in
   * the RPC — the database coerces anything unexpected to 'league', and a
   * silently changed reason is the sort of thing nobody notices until they are
   * trying to work out why a paying customer was never charged.
   */
  ipcMain.handle('admin:grantFree', async (_evt, payload) => {
    const p = payload || {};
    const id = typeof p.userId === 'string' ? p.userId : '';
    const reason = ['league', 'beta', 'friend', 'staff'].includes(p.reason) ? p.reason : null;
    if (!id || !reason) return { ok: false, error: 'bad arguments' };
    const note = typeof p.note === 'string' ? p.note.trim().slice(0, 120) : '';
    const res = await authService.rpc('admin_grant_free_access', {
      p_user_id: id,
      p_reason: reason,
      p_note: note,
    });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Could not grant access.',
      };
    }
    return { ok: true };
  });

  /** Pull an account's free access (and burn any code it redeemed). */
  ipcMain.handle('admin:revokeFree', async (_evt, payload) => {
    const id = payload && typeof payload.userId === 'string' ? payload.userId : '';
    if (!id) return { ok: false, error: 'bad arguments' };
    const res = await authService.rpc('admin_revoke_free_access', { p_user_id: id });
    if (!res.ok) {
      return {
        ok: false,
        signedOut: !!res.signedOut,
        error: res.signedOut ? 'Sign in as an admin.' : res.error || 'Could not revoke.',
      };
    }
    return { ok: true };
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

  // --- Race engineer -------------------------------------------------------
  ipcMain.handle('engineer:status', () => getEngineer().status());
  ipcMain.handle('engineer:download', async (_evt, voiceId) => {
    try {
      await getEngineer().download(String(voiceId));
      // A finished download may be the missing piece — bring the service up.
      await syncEngineer();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  ipcMain.handle('engineer:preview', (_evt, voiceId) => getEngineer().preview(String(voiceId)));
  ipcMain.handle('engineer:test', () => getEngineer().test());
  ipcMain.handle('engineer:ask', () => getEngineer().ask());
  ipcMain.handle('engineer:downloadStt', async () => {
    try {
      await getEngineer().downloadStt();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  ipcMain.handle('engineer:removeVoice', (_evt, voiceId) => {
    try {
      return { ok: true, bytes: getEngineer().removeVoice(String(voiceId)) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  ipcMain.handle('engineer:removeUnusedVoices', () => {
    try {
      return { ok: true, ...getEngineer().removeUnusedVoices() };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  ipcMain.handle('engineer:rate', (_evt, id, rating) => getEngineer().rate(String(id), String(rating)));

  /* ---- Team tab (pit-wall view) ---- */
  // Subscribe answers with the current snapshot so the tab paints on entry
  // instead of waiting out the 1 s push cadence; pushes then keep it live.
  ipcMain.handle('team:subscribe', () => {
    teamViewOpen = true;
    lastTeamPushAt = 0; // next frame pushes immediately
    // `everything` — a fresh subscriber has no cached history or map shape.
    return lastFeedFrame ? teamSnapshotWithExtras(lastFeedFrame, Date.now(), true) : null;
  });
  ipcMain.handle('team:unsubscribe', () => {
    teamViewOpen = false;
  });

  /* ---- Teams + relay (Phase 2, electron/team-cloud.js) ----
   * Thin pass-throughs: the module owns the state and pushes changes over
   * 'team:cloud' (roster/publish status) and 'team:relay' (watched car). */
  ipcMain.handle('team:cloudState', () => teamCloud.stateForUi());
  ipcMain.handle('team:refreshTeams', () => teamCloud.refreshTeams().then(() => teamCloud.stateForUi()));
  ipcMain.handle('team:create', (_evt, name) => teamCloud.createTeam(name));
  ipcMain.handle('team:join', (_evt, code) => teamCloud.joinTeam(code));
  ipcMain.handle('team:leave', (_evt, id) => teamCloud.leaveTeam(id));
  ipcMain.handle('team:delete', (_evt, id) => teamCloud.deleteTeam(id));
  ipcMain.handle('team:removeMember', (_evt, id, userId) => teamCloud.removeMember(id, userId));
  ipcMain.handle('team:rotateCode', (_evt, id) => teamCloud.rotateCode(id));
  ipcMain.handle('team:rename', (_evt, id, name) => teamCloud.renameTeam(id, name));
  ipcMain.handle('team:setActive', (_evt, id) => teamCloud.setActiveTeam(id));
  ipcMain.handle('team:watch', (_evt, on) => teamCloud.setWatching(!!on));

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
  /**
   * LMU's own controls file. The overlay can only press what the game has bound
   * to a KEY, and most drivers have their aids on wheel buttons — so on a fresh
   * rig these controls are simply unusable until something writes the missing
   * binds. See server/lmuBinder for the key pool and why it cannot collide.
   */
  const lmuBinder = () => {
    try {
      return require(path.join(__dirname, '..', 'dist', 'server', 'lmuBinder.js'));
    } catch {
      return null;
    }
  };

  ipcMain.handle('lmuBind:plan', () => {
    const mod = lmuBinder();
    if (!mod) return { ok: false, error: 'binder unavailable (build not present)' };
    return { ok: true, ...mod.planLmuBindings() };
  });

  ipcMain.handle('lmuBind:apply', () => {
    const mod = lmuBinder();
    if (!mod) return { ok: false, error: 'binder unavailable (build not present)', written: [] };
    return mod.applyLmuBindings();
  });

  ipcMain.handle('lmuBind:restore', () => {
    const mod = lmuBinder();
    if (!mod) return { ok: false, error: 'binder unavailable (build not present)' };
    return mod.restoreLmuBindings();
  });

  /*
   * Shared-memory plugin health, for the panel's status card.
   *
   * This exists because the plugin can be installed perfectly and still never
   * load: it links against MSVCR120 (VC++ 2013), and on a machine without that
   * runtime LMU skips it silently — no buffers, no delta, no radar, no map,
   * and nothing anywhere saying why. Read-only; the install itself still
   * happens on server startup.
   */
  const pluginInstaller = () => {
    try {
      return require(path.join(__dirname, '..', 'dist', 'server', 'pluginInstaller.js'));
    } catch {
      return null;
    }
  };

  ipcMain.handle('plugin:status', () => {
    const mod = pluginInstaller();
    if (!mod) return { ok: false, error: 'installer unavailable (build not present)' };
    return { ok: true, ...mod.inspectSharedMemoryPlugin() };
  });

  /** Retry the install now — the "I closed the game" button. */
  ipcMain.handle('plugin:install', () => {
    const mod = pluginInstaller();
    if (!mod) return { ok: false, error: 'installer unavailable (build not present)' };
    try {
      return { ok: true, ...mod.ensureSharedMemoryPlugin() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('wheel:devices', () => {
    const g = getGamepad();
    // A full re-enumeration, so a wheel plugged in since boot is picked up —
    // opening alone never did that, whatever the old comment here claimed.
    g.rescan();
    g.setActive(true);
    const devices = g.list();
    syncGamepad();
    return { available: g.available, error: g.failed, devices, problems: g.problems };
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
      const button = Math.round(binding.button);
      const { describeButton } = require('./gamepad');
      entry[dir] = { device: binding.device, button, label: describeButton(button) };
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

  /* ---- Account (see electron/auth.js) ----
   *
   * These handlers are thin: auth.js owns validation, the Supabase calls and
   * the session file. Main's only extra jobs are remembering the address for
   * the next launch and swapping the window between auth.html and index.html. */

  ipcMain.handle('auth:getState', () => authStateForUi());

  ipcMain.handle('auth:signIn', async (_evt, payload) => {
    const res = await authService.signIn(payload || {});
    if (res.ok) {
      rememberEmail(payload && payload.email);
      // Anything driven while signed out is sitting in the local files waiting
      // for exactly this moment. Not awaited — signing in must not block on it.
      void lapUpload.sync({ reason: 'sign-in' });
      teamCloud.onAuthChanged();
    }
    return res;
  });

  ipcMain.handle('auth:register', async (_evt, payload) => {
    const res = await authService.register(payload || {});
    if (res.ok) rememberEmail(payload && payload.email);
    return res;
  });

  ipcMain.handle('auth:resendConfirmation', (_evt, payload) =>
    authService.resendConfirmation(payload || {}),
  );

  ipcMain.handle('auth:requestReset', (_evt, payload) =>
    authService.requestReset(payload || {}),
  );

  ipcMain.handle('auth:resetPassword', async (_evt, payload) => {
    const res = await authService.resetPassword(payload || {});
    if (res.ok) rememberEmail(res.email);
    return res;
  });

  ipcMain.handle('auth:signOut', async () => {
    const res = await authService.signOut();
    // The entitlement cache belongs to the account that just left — the next
    // sign-in may be someone else, and a comp must not carry across.
    billingService.clear();
    teamCloud.onAuthChanged();
    loadPage('auth');
    return res;
  });

  /**
   * GDPR right to erasure. The delete-account edge function verifies the
   * caller's own JWT, cancels/deletes the Stripe customer, and deletes the
   * auth user — every cloud row the account owns goes with it (the schema
   * cascades). This side then forgets everything local that belonged to the
   * account. The renderer asks for typed confirmation before calling this;
   * the edge function separately requires the literal confirm token so a
   * stray IPC replay cannot erase an account.
   */
  ipcMain.handle('auth:deleteAccount', async () => {
    const res = await authService.functionsInvoke(
      'delete-account',
      { confirm: 'DELETE' },
      { timeoutMs: 30000 },
    );
    if (!res.ok) {
      return {
        ok: false,
        error:
          (res.body && res.body.error) ||
          res.error ||
          'Deletion failed — check your connection and try again.',
      };
    }
    // The account no longer exists server-side; the local sign-out's revoke
    // call may 401 into the void, which is fine — what matters is that the
    // remembered session is cleared.
    try {
      await authService.signOut();
    } catch {
      /* session file cleared regardless */
    }
    billingService.clear();
    teamCloud.onAuthChanged();
    // The upload ledger belonged to the deleted account. A future sign-in on
    // this PC must not believe these laps were already submitted.
    try {
      fs.rmSync(path.join(app.getPath('userData'), 'lap-sync.json'), { force: true });
    } catch {
      /* nothing to forget */
    }
    loadPage('auth');
    return { ok: true };
  });

  /**
   * Signed in (or registered without confirmation) — into the app IF this
   * account may use it. The subscription gates the whole panel: a fresh
   * account gets `entitled: false` back and the auth page shows the subscribe
   * screen instead. (The RPC re-authorises server-side regardless — this gate
   * decides what is shown, the database decides what is true.)
   */
  ipcMain.handle('auth:enterApp', async () => {
    const snap = await billingService.refresh({ maxAgeMs: 5000 });
    if (snap.entitled) {
      loadPage('panel');
      // The server only auto-starts for entitled accounts; catch up now.
      void startServer();
    }
    return { ...authStateForUi(), entitled: !!snap.entitled, billing: snap };
  });

  // 'auth:continueOffline' existed while the app was free-with-an-optional-
  // account. The subscription (v0.69.0) retired it: offline use now rides the
  // billing grace window for accounts that have already been seen entitled.

  /** Back to the account screens from the panel's "Sign in" button. */
  ipcMain.handle('auth:showAuth', () => {
    loadPage('auth');
    return authStateForUi();
  });

  /** Terms of Use / Privacy Policy — bundled documents in their own window. */
  ipcMain.handle('legal:open', (_evt, section) => {
    openLegalWindow(section);
    return { ok: true };
  });

  /* ---- Billing (see electron/billing.js) ----
   *
   * Checkout and the Customer Portal are Stripe-hosted pages opened in the
   * SYSTEM browser — the panel's CSP cannot (and should not) render a payment
   * page, and this way the card never comes anywhere near the app. The URLs
   * come from our own edge functions, so they are trusted by construction and
   * deliberately do not go through the renderer's EXTERNAL_HOSTS allowlist. */

  ipcMain.handle('billing:status', () => billingService.refresh({ maxAgeMs: 15000 }));

  ipcMain.handle('billing:checkout', async () => {
    const res = await billingService.checkoutUrl();
    if (!res.ok) return res;
    if (res.alreadySubscribed) {
      // Paid in another window/install — nothing to buy, just re-read.
      void billingService.refresh({ maxAgeMs: 0 });
      return { ok: true, alreadySubscribed: true };
    }
    void shell.openExternal(res.url);
    return { ok: true };
  });

  ipcMain.handle('billing:portal', async () => {
    const res = await billingService.portalUrl();
    if (!res.ok) return res;
    void shell.openExternal(res.url);
    return { ok: true };
  });

  ipcMain.handle('billing:redeemCode', (_evt, code) => billingService.redeemCode(code));

  /* ---- Streaming chat linking (see electron/chatLink.js) ----
   *
   * Twitch is read anonymously, so "linking" it is just remembering a channel
   * name. YouTube needs Google OAuth, which runs entirely in chatLink (main),
   * so the renderer never sees a token — only the sanitised state below. */

  ipcMain.handle('chatLink:status', () => chatLink.stateForUi());

  ipcMain.handle('chatLink:setTwitchChannel', (_evt, name) =>
    chatLink.setTwitchChannel(typeof name === 'string' ? name : ''),
  );

  ipcMain.handle('chatLink:linkYouTube', () => chatLink.linkYouTube());

  ipcMain.handle('chatLink:unlinkYouTube', () => chatLink.unlinkYouTube());

  // The bot's Twitch login (Device Code Grant — the code itself is surfaced
  // through chatState:changed while the link is pending).
  ipcMain.handle('chatLink:linkTwitch', () => chatLink.linkTwitch());

  ipcMain.handle('chatLink:unlinkTwitch', () => chatLink.unlinkTwitch());

  /* ---- Stream bot (see electron/streamBot.js) ----
   *
   * The panel edits whole sections (commands, timers, alerts, goals, settings)
   * and this side validates them; nothing here carries a credential. */

  ipcMain.handle('streamBot:get', () => streamBot.stateForUi());

  ipcMain.handle('streamBot:update', (_evt, payload) => {
    const section = payload && typeof payload.section === 'string' ? payload.section : '';
    return streamBot.update(section, payload ? payload.value : undefined);
  });

  ipcMain.handle('streamBot:setEnabled', (_evt, on) => streamBot.setEnabled(on === true));

  ipcMain.handle('streamBot:goalAdjust', (_evt, payload) =>
    streamBot.goalAdjust(
      payload && typeof payload.goalId === 'string' ? payload.goalId : '',
      payload ? Number(payload.delta) : 0,
    ),
  );

  ipcMain.handle('clipboard:write', (_evt, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
    return true;
  });

  ipcMain.handle('overlay:openInBrowser', (_evt, url) => {
    if (typeof url === 'string' && (isLocalOverlayUrl(url) || isAllowedExternal(url))) {
      void shell.openExternal(url);
    }
    return true;
  });
}

/** An overlay page served by our own server — the original reason this exists. */
function isLocalOverlayUrl(url) {
  return /^https?:\/\/127\.0\.0\.1:/.test(url);
}

/**
 * The handful of outside sites the panel itself links to: the project's own
 * releases page (What's New), and the credits/attribution links. An allowlist
 * rather than "any https" because the release notes are rendered with clickable
 * links, and a renderer that can hand ANY address to the system browser is a
 * bigger surface than this app needs. HTTPS only, exact hosts only — no
 * subdomain wildcards, so `github.com.evil.tld` cannot match.
 */
const EXTERNAL_HOSTS = new Set([
  'github.com',
  'www.youtube.com',
  'youtube.com',
  'docs.google.com',
  'discord.gg',
  // Schedule tab — championship signup / results pages on SimGrid.
  'www.thesimgrid.com',
  'thesimgrid.com',
]);

function isAllowedExternal(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname);
  } catch {
    return false; // not a URL at all
  }
}

/* -------------------------------------------------------------------------- */
/*  What's new (release notes from the bundled CHANGELOG.md)                    */
/* -------------------------------------------------------------------------- */

/**
 * The release notes the panel draws. Read from the CHANGELOG.md shipped inside
 * the package (see `build.files`), so an updated app can say what changed
 * before it has spoken to the network — and can never show notes that differ
 * from the release it is actually running.
 */
function setupChangelogIpc() {
  /** Every parsed entry, newest first. Empty if the file is missing. */
  const entries = () => changelog.loadEntries(app.getAppPath());

  // The whole history, for the "release notes" view opened from the version in
  // the footer. Capped: the file goes back to 0.4.0 and nobody scrolls that
  // far, but the cap is generous enough that a driver who skipped a month
  // still sees everything they missed.
  ipcMain.handle('changelog:history', () => ({
    current: app.getVersion(),
    entries: entries().slice(0, 40),
  }));

  /**
   * What to show on launch. Three cases, and the difference matters:
   *   - no version recorded → a fresh install. Say nothing (there is no "new"
   *     for someone who has never run an older build) and remember where we
   *     came in, so the NEXT update does have something to compare against.
   *   - recorded version older than this one → just updated. Return every entry
   *     in between, so skipping two releases still shows both.
   *   - anything else (same version, or a downgrade) → nothing to say.
   */
  ipcMain.handle('changelog:pending', () => {
    const current = app.getVersion();
    const settings = loadSettings();
    const seen = settings.lastSeenVersion;

    if (!seen) {
      saveSettings({ ...settings, lastSeenVersion: current });
      return { show: false, current, from: '', entries: [] };
    }
    if (changelog.compareVersions(seen, current) >= 0) {
      return { show: false, current, from: seen, entries: [] };
    }

    const missed = changelog.entriesSince(entries(), seen, current);
    // An update whose notes we cannot read (older CHANGELOG, hand-edited file)
    // shows nothing rather than an empty box; the version is recorded anyway so
    // it does not ask again on every launch.
    if (!missed.length) {
      saveSettings({ ...settings, lastSeenVersion: current });
      return { show: false, current, from: seen, entries: [] };
    }
    return { show: true, current, from: seen, entries: missed };
  });

  /**
   * Called when the driver closes the What's New panel — not when it opens, so
   * a crash or a force-quit mid-read means they get another chance to read it.
   */
  ipcMain.handle('changelog:markSeen', () => {
    const settings = loadSettings();
    const current = app.getVersion();
    if (settings.lastSeenVersion !== current) {
      saveSettings({ ...settings, lastSeenVersion: current });
    }
    return { current };
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
  // Which feed this install is following ('stable' | 'beta'), and whether the
  // build currently RUNNING is a prerelease. The two disagree for exactly as
  // long as it takes a beta tester to switch back to stable and be moved onto
  // it, which is the moment the panel most needs to explain itself.
  channel: 'stable',
  running: null, // e.g. '0.57.0-beta.2' — filled in at setup
  runningIsBeta: false,
  // Whether the version being OFFERED is a prerelease. A stable-channel install
  // can never see one; a beta-channel install sees both, so the banner has to
  // say which it is before someone installs it mid-league-night.
  offeredIsBeta: false,
  // Release notes for the version being offered, as plain text. They come from
  // the GitHub release body (which `npm run release` fills from this same
  // CHANGELOG), so the banner can say what the update contains BEFORE it is
  // installed. Null when the feed carried none.
  notes: null,
};

/**
 * electron-updater hands release notes over as the GitHub release body, which
 * arrives as HTML (and, with `fullChangelog`, as an array of releases). It is
 * remote text, so it is flattened to plain paragraphs here and drawn with
 * textContent in the renderer — no markup from the network ever reaches the
 * panel's DOM.
 */
function plainReleaseNotes(raw) {
  const parts = Array.isArray(raw)
    ? raw.map((r) => (r && typeof r === 'object' ? r.note : r))
    : [raw];
  const text = parts
    .filter((p) => typeof p === 'string' && p.trim())
    .join('\n')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? text.slice(0, 8000) : null;
}

function pushUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', { ...updateState });
  }
}

/**
 * Point the updater at one of the two feeds. This is the whole of the channel
 * mechanism on the app side; everything else here is about saying which one is
 * on. The rule itself lives in electron/updateChannel.js, shared with the
 * release script so the two can never drift apart.
 */
function applyUpdateChannel(channel) {
  updateState.channel = updateChannel.normalizeChannel(channel);
  if (!app.isPackaged) return;
  const flags = updateChannel.updaterFlags(updateState.channel, updateState.running);
  autoUpdater.allowPrerelease = flags.allowPrerelease;
  autoUpdater.allowDowngrade = flags.allowDowngrade;
}

/**
 * Wires electron-updater to the GitHub Releases feed and relays progress to the
 * renderer so the panel can show a "new version available" banner. We do NOT
 * auto-download — the operator clicks to update, so a stream is never disrupted.
 */
function setupAutoUpdate() {
  updateState.running = app.getVersion();
  updateState.runningIsBeta = updateChannel.isPrereleaseVersion(updateState.running);
  applyUpdateChannel(loadSettings().updateChannel);

  // The IPC surface must exist even in a dev run (the panel always calls
  // update:getState on boot); only the updater wiring needs a packaged app.
  ipcMain.handle('update:getState', () => ({ ...updateState }));

  /**
   * Switch feeds. The setting is persisted first — a driver who picks beta and
   * then quits before the check finishes is still on beta next launch — and the
   * check runs immediately, because the only reason anyone touches this control
   * is to get onto (or off) another build right now.
   */
  ipcMain.handle('update:setChannel', (_evt, channel) => {
    const next = updateChannel.normalizeChannel(channel);
    const settings = loadSettings();
    if (settings.updateChannel !== next) {
      saveSettings({ ...settings, updateChannel: next });
    }
    applyUpdateChannel(next);
    // Whatever was found on the old feed no longer applies to this one.
    updateState.status = 'idle';
    updateState.version = null;
    updateState.notes = null;
    updateState.percent = 0;
    updateState.error = null;
    updateState.offeredIsBeta = false;
    pushUpdate();
    if (app.isPackaged) {
      autoUpdater.checkForUpdates().catch((e) => {
        updateState.status = 'error';
        updateState.error = String(e.message || e);
        pushUpdate();
      });
    }
    return { ...updateState };
  });

  if (!app.isPackaged) {
    updateState.status = 'idle';
    ipcMain.handle('update:check', () => ({ ...updateState }));
    ipcMain.handle('update:download', () => ({ ...updateState }));
    ipcMain.handle('update:install', () => {});
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  /*
   * A log, and a 287 MB reclaim.
   *
   * The logger goes on FIRST, before any check can run, because the one line
   * worth having — "Cannot download differentially, fallback to full download"
   * — is emitted during the very first download and nowhere else. Without it
   * there is no way to tell a 10.7 MB differential update from a 287.5 MB full
   * one; both look identical from outside.
   *
   * Then the pending copy of the installer that just ran is dropped. See
   * electron/updateCache.js for why that is safe and why `installer.exe` stays.
   */
  const updaterLog = updateCache.createLogger(app);
  autoUpdater.logger = updaterLog;
  updaterLog.info(`--- ${app.getName()} ${app.getVersion()} (${updateState.channel}) ---`);
  updateCache.reclaimPending(app, updaterLog);

  autoUpdater.on('checking-for-update', () => {
    updateState.status = 'checking';
    updateState.error = null;
    pushUpdate();
  });
  autoUpdater.on('update-available', (info) => {
    updateState.status = 'available';
    updateState.version = info && info.version ? info.version : null;
    updateState.offeredIsBeta = updateChannel.isPrereleaseVersion(updateState.version);
    updateState.notes = plainReleaseNotes(info && info.releaseNotes);
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
    updateState.offeredIsBeta = updateChannel.isPrereleaseVersion(updateState.version);
    updateState.notes = plainReleaseNotes(info && info.releaseNotes) || updateState.notes;
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

/** Remember the address that just signed in, to prefill the field next time. */
function rememberEmail(email) {
  if (typeof email !== 'string' || !email.trim()) return;
  const settings = loadSettings();
  const next = email.trim().slice(0, 254);
  if (settings.lastAuthEmail !== next) saveSettings({ ...settings, lastAuthEmail: next });
}

/**
 * Which page the single window shows. Since the subscription (v0.69.0) the
 * panel needs BOTH a signed-in account and entitlement — here that means the
 * cached answer, because this runs before any network call: a subscriber whose
 * hotel wifi is down still gets their overlays (the grace window in
 * billing.js), while a fresh install lands on the account screens. The
 * background refresh right after startup corrects an out-of-date cache both
 * ways. The old "continue offline" free path is gone with the free app.
 */
function initialPage() {
  return authService.stateForUi().signedIn && billingService.entitledNow() ? 'panel' : 'auth';
}

/**
 * React to a fresh entitlement answer: an account that is no longer allowed in
 * (subscription lapsed, comp revoked, signed out remotely) is walked back to
 * the account screens — where auth.js shows the subscribe screen — and the
 * overlay server is stopped so the OBS sources gate with the app.
 */
function enforceEntitlement(snap) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (snap && snap.entitled) return;
  const onPanel = /index\.html(?:[?#].*)?$/.test(mainWindow.webContents.getURL() || '');
  if (onPanel) {
    void stopServer();
    loadPage('auth');
  }
}

/** Swap the window between the account screens and the control panel. */
function loadPage(page) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const file = page === 'auth' ? 'auth.html' : 'index.html';
  void mainWindow.loadFile(path.join(__dirname, 'control-panel', file));
}

/**
 * The Terms of Use / Privacy Policy, in their own small window. The documents
 * ship inside the app (control-panel/legal.html) so they are readable offline,
 * before signing in, and cannot disagree with the build that shows them.
 * One window, re-focused and re-anchored on repeat opens.
 */
let legalWindow = null;
function openLegalWindow(section) {
  const hash = section === 'privacy' ? 'privacy' : 'terms';
  const file = path.join(__dirname, 'control-panel', 'legal.html');
  if (legalWindow && !legalWindow.isDestroyed()) {
    void legalWindow.loadFile(file, { hash });
    legalWindow.focus();
    return;
  }
  legalWindow = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 520,
    minHeight: 420,
    backgroundColor: '#060a12',
    title: 'Apex AIO System — Terms & Privacy',
    icon: path.join(__dirname, 'control-panel', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    // A static local document: no preload, no Node, fully sandboxed.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  legalWindow.removeMenu?.();
  legalWindow.on('closed', () => {
    legalWindow = null;
  });
  void legalWindow.loadFile(file, { hash });
}

function createWindow() {
  const mode = startup.initialWindowMode({ argv: process.argv });

  mainWindow = new BrowserWindow({
    // The Hub shell's nav carries five tabs, the mode toggle, the feed pill, the
    // gear, the account chip and the power button on one row: at 1000px they
    // fit only by dropping the tab labels to icons (see hub.css), which is the
    // narrow-window fallback rather than the intended first run.
    //
    // These are the RESTORE-DOWN size, not the size anyone sees first: the app
    // opens maximised (below). They are what the window returns to when the
    // operator un-maximises it, so they still have to be a sensible shape.
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    // Maximise before the first paint, not after: showing at 1180×820 and then
    // snapping to full screen is a visible jump on every single launch.
    show: false,
    backgroundColor: '#060a12',
    title: 'Apex AIO System',
    icon: path.join(__dirname, 'control-panel', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The panel keeps working while it is minimised or covered. Chromium
      // throttles an unseen window's timers to once a minute, which would
      // stall the feed watcher, the lap-sync ticks and the update poll for as
      // long as the window is away — exactly the hours this app is meant to be
      // minding things. The telemetry server and the in-game layer live
      // outside this renderer and were never affected either way.
      backgroundThrottling: false,
    },
  });

  mainWindow.removeMenu?.();
  loadPage(initialPage());

  // Coming back to the window is the moment entitlement most likely changed:
  // checkout and the Customer Portal both happen in the browser, and the way
  // back into the app is alt-tabbing to it. Cheap — billing.js collapses this
  // to at most one network call per half-minute.
  mainWindow.on('focus', () => {
    if (!authService.stateForUi().signedIn) return;
    void billingService.refresh({ maxAgeMs: 30000 }).then(enforceEntitlement).catch(() => {});
  });

  // There is deliberately NO 'minimize' handler here. Minimise-to-tray shipped
  // in 0.65.0 and was removed on driver feedback: a window that vanishes into
  // the notification-area overflow reads as the app having gone somewhere
  // weird, not as a minimised app. Minimise now does what it does everywhere
  // else — the window sits in the taskbar until it is clicked.

  mainWindow.on('closed', () => {
    mainWindow = null;
    // The in-game layer must not outlive the control panel (it would also keep
    // 'window-all-closed' from firing, leaving a ghost process).
    destroyOverlayWindow();
  });

  if (mode === 'maximized') {
    mainWindow.maximize();
    mainWindow.show();
  } else {
    // A login-item launch: on screen only as a taskbar button, maximised when
    // the operator clicks it.
    mainWindow.maximize(); // the size it restores to when they click it
    mainWindow.minimize();
    mainWindow.show();
  }
}

/** Bring the control panel back — from a second launch, or the macOS dock. */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    // A deliberate open always ends on screen, whatever mode createWindow
    // picked for this launch's argv.
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.maximize();
      mainWindow.show();
    }
    return;
  }
  // show() before restore() — harmless when the window is merely minimised,
  // and the safe order if it is ever hidden too (a hidden window restored
  // before being shown comes back as a ghost that paints nothing; reproduced
  // and measured 2026-08-10 while minimise still hid to the tray).
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  // A deliberate open must also end on TOP — including over a borderless
  // fullscreen sim. focus() cannot take the foreground from another process on
  // Windows (the OS just flashes the taskbar instead), so ride above
  // everything for one beat and drop back into the normal band.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.focus();
}

/**
 * Write (or clear) the Windows Run-key entry that brings the app back after a
 * reboot. The decision about whether it is safe to write at all — and with what
 * — lives in electron/startup.js; this just performs it.
 */
function applyLaunchOnStartup(settings) {
  const item = startup.loginItemSettingsFor({
    enabled: settings.launchOnStartup,
    execPath: process.execPath,
    isPackaged: app.isPackaged,
  });
  if (!item) return; // dev run: the setting is remembered, the registry is not touched
  try {
    app.setLoginItemSettings(item);
  } catch (err) {
    console.error('[app] failed to set launch-on-startup:', err.message);
  }
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

  // If the window opened on the account screens, walk them: they are one page
  // with six states, and only the first would otherwise ever be captured.
  if (mainWindow && !mainWindow.isDestroyed() && /auth\.html$/.test(mainWindow.webContents.getURL())) {
    for (const screen of [
      'register',
      'subscribe',
      'reset-request',
      'reset-verify',
      'reset-done',
      'confirm',
    ]) {
      try {
        await mainWindow.webContents.executeJavaScript(
          `window.__shot ? window.__shot('${screen}') : null`,
        );
      } catch {
        /* the page exposes __shot only in dev — skip if absent */
      }
      await new Promise((r) => setTimeout(r, 250));
      await snap(`auth-${screen}`, mainWindow);
    }
  }

  // Also exercise edit mode on the in-game layer, if it is up.
  if (overlayWin && !overlayWin.isDestroyed()) {
    setIngameEdit(true);
    await new Promise((r) => setTimeout(r, 600));
    await snap('ingame-edit', overlayWin);
  }
  app.quit();
}

/*
 * One instance, always.
 *
 * A second copy would boot behind the first, fail to bind the server port, and
 * report the port as busy — while the double-click that started it looked like
 * it did nothing. The second launch hands its request to the running copy
 * instead, which is what the operator meant by clicking: show me the app.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return; // a copy is already running; this one is on its way out
  // Before createWindow(): whether a session is remembered decides which page
  // the window opens on.
  authService.init(app.getPath('userData'));
  // Before createWindow() too: initialPage() reads the cached entitlement.
  billingService.init({
    userDataDir: app.getPath('userData'),
    auth: authService,
    onChange: pushBilling,
  });
  registerIpc();
  // Needs the app ready — screen is unusable before it.
  watchDisplays();

  // Reapplying the Run-key entry on every launch is what keeps the switch
  // honest after an update or a reinstall has replaced the exe the old entry
  // pointed at.
  applyLaunchOnStartup(loadSettings());
  createWindow();

  // Turn a remembered refresh token into a live session in the background — a
  // slow or offline network must not hold up the panel or the server.
  //
  // The lap uploader is started from inside this chain rather than beside it:
  // its first run needs a live token, and firing it before the refresh has
  // landed would guarantee one wasted signed-out attempt on every launch.
  void authService
    .restore()
    .then((authState) => {
      pushAuth(authState);
      lapUpload.init({
        userDataDir: app.getPath('userData'),
        auth: authService,
        appVersion: app.getVersion(),
        onChange: pushLapSync,
      });
      // Catch up on anything driven while signed out or offline.
      void lapUpload.sync({ reason: 'startup' });
      // Teams + relay: started from the same chain because its first roster
      // fetch wants a live token too. Publishing then gates itself on the
      // feed, so with no team or no car this costs a timestamp check per beat.
      teamCloud.init({
        auth: authService,
        collect: collectForRelay,
        store: {
          getActiveTeam: () => loadSettings().teamActiveId || null,
          setActiveTeam: (id) => {
            const current = loadSettings();
            saveSettings({ ...current, teamActiveId: id || null });
          },
        },
        onTeams: (state) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            try { mainWindow.webContents.send('team:cloud', state); } catch { /* teardown */ }
          }
        },
        onRelay: (update) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            try { mainWindow.webContents.send('team:relay', update); } catch { /* teardown */ }
          }
        },
      });
      // Start the usage heartbeat from inside the same chain, for the same
      // reason: its first beat wants a live token, so firing it before the
      // refresh lands would waste one signed-out attempt every launch.
      usageReporter.init({ auth: authService, appVersion: app.getVersion() });
      // Now the session is live, ask the server whether this account may still
      // be in the app. A cache that let the panel open gets corrected here if
      // the subscription lapsed while the app was closed — and vice versa, a
      // stale "no" is upgraded so the next launch opens straight into the panel.
      void billingService
        .refresh({ maxAgeMs: 0 })
        .then(enforceEntitlement)
        .catch((err) => console.error('[billing] refresh failed:', err.message));
    })
    .catch((err) => console.error('[auth] restore failed:', err.message));

  setupChangelogIpc();
  setupAutoUpdate();
  pruneRemovedBindings();
  applyBindings(loadSettings());
  syncGamepad();
  // Auto-start the server so overlays are live as soon as the app opens — but
  // only for an account the cache says may use the app: the overlays are
  // served over HTTP to OBS, so an unentitled install must not get them by
  // simply never signing in. enterApp starts it for everyone else the moment
  // they are through the gate.
  if (initialPage() === 'panel') await startServer();

  // Streaming chat: link state persists across launches, so bring it back up now
  // and forward the operator's sources to the just-started server. The YouTube
  // token-refresh hook lets the server ask for a fresh token when its stream
  // 401s, rather than spinning on a dead credential.
  chatLink.init({
    userDataDir: app.getPath('userData'),
    onChange: pushChatState,
    applyChatConfig,
  });
  // The stream bot's desktop half: persistence + policy here, engine in the
  // server. Initialised after chatLink so its first config push already sees
  // which accounts are linked.
  streamBot.init({
    userDataDir: app.getPath('userData'),
    onChange: pushStreamBotState,
    applyBotConfig,
    getLinkState: () => chatLink.stateForUi(),
  });
  try {
    requireServer().setChatYouTubeAuthErrorHandler(() => chatLink.handleYouTubeAuthError());
    // "The chat ended" is the only event that can change which broadcast we
    // should be reading, so it is the only thing that sends us looking for a new
    // one. Before this hook, chatLink asked YouTube once a minute, all day, and
    // that idle poll alone cost ~14% of the daily quota per install.
    requireServer().setChatYouTubeChatEndedHandler(() => chatLink.handleYouTubeChatEnded());
    // Twitch's mirror of the same contract: a rejected login stops the IRC
    // client, and this hook mints a fresh token and hands it back.
    requireServer().setChatTwitchAuthErrorHandler(() => chatLink.handleTwitchAuthError());
    // The engine reports YouTube quota spend + goal movement up for persistence.
    requireServer().setStreamBotHandlers({
      onQuotaUsed: (n) => streamBot.noteQuotaUsed(n),
      onGoalChanged: (goalId, current) => streamBot.noteGoalChanged(goalId, current),
    });
  } catch (err) {
    /* server not built — the standalone path doesn't use chatLink anyway */
  }

  if (process.env.APEX_SHOT) {
    setTimeout(() => void captureWindowsAndQuit(process.env.APEX_SHOT), 3500);
  }

  app.on('activate', () => {
    // macOS dock click: the window has to end up on screen, which
    // showMainWindow guarantees whatever state it is in.
    showMainWindow();
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
  // Kill the engineer's sidecars (Piper, player, recognizer) — they are plain
  // child processes and would outlive the app as orphans otherwise.
  if (engineerService) engineerService.stop();
});

app.on('before-quit', () => {
  // Best-effort synchronous-ish cleanup; the loop is unref'd so this is quick.
  void stopServer();
});
