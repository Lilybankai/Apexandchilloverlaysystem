/**
 * @file src/server/index.ts
 * @module server/index
 *
 * Application entrypoint. Wires together the three pieces of the lightweight
 * overlay server:
 *
 * 1. A tiny **static HTTP server** that serves the `overlay/` browser assets
 *    (added to OBS as a Browser Source). No framework — just `http` + `fs`.
 * 2. The **WebSocket broadcast server** ({@link TelemetryWsServer}), attached to
 *    the same HTTP server so everything lives on one port.
 * 3. A fixed-rate **telemetry loop** that polls the active
 *    {@link TelemetryProvider} and broadcasts each {@link TelemetryFrame}.
 *
 * The whole process is a single small Node server — the deliberate "no Electron"
 * choice that keeps the tool light on a streaming PC.
 */

import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { frameIntervalMs, loadConfig, type ServerConfig } from './config';
import { TelemetryWsServer } from './wsServer';
import { ChatHub, type ChatConfig } from './chatHub';
import { ChatWsServer } from './chatWsServer';
import type { TelemetryProvider } from '../telemetry/provider';
import { SimulatorProvider } from '../telemetry/simulatorProvider';
import { RF2Provider } from '../telemetry/rf2Provider';
import { LmuRestProvider } from '../telemetry/lmuRestProvider';
import { MfdController } from '../telemetry/mfdControl';
import { clearRejectedTrackMaps, getPublishedTrackMap } from '../telemetry/trackMap';
import { handleMfdCommand } from './mfdRoutes';
import { setAidRows, setRaceControlRows } from './pitCursor';
import { buildAidRows } from './aidRows';
import { buildRaceControlRows } from './raceControlRows';
import { KeySender } from './keySender';

/** Maps file extensions to Content-Type headers for the static server. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/**
 * Selects the telemetry provider to run.
 *
 * `forceSimulator` (demo mode) always wins and returns the {@link SimulatorProvider}.
 * Otherwise the configured `provider` is honoured:
 * - `lmu` (default) — {@link LmuRestProvider}, reading Le Mans Ultimate's REST API
 *   and falling back to the simulator when the game/API is not up.
 * - `rf2` — {@link RF2Provider}, reading rF2/LMU shared memory (physics for the
 *   locally-driven car), also falling back to the simulator.
 * - `simulator` — always synthetic demo data.
 *
 * Every provider degrades to the simulator internally, so the server always has
 * a working source and never crashes on a missing sim.
 *
 * @param config - Runtime configuration.
 * @returns The provider the telemetry loop will poll.
 */
export function selectProvider(config: ServerConfig): TelemetryProvider {
  if (config.forceSimulator || config.provider === 'simulator') return new SimulatorProvider();
  if (config.provider === 'rf2') return new RF2Provider(config);
  return new LmuRestProvider(config);
}

/* -------------------------------------------------------------------------- */
/*  Appearance — operator look-and-feel, live-tunable                         */
/* -------------------------------------------------------------------------- */

/** The overlay appearance settings served at {@link APPEARANCE_PATH}. */
export interface Appearance {
  /** Widget panel-background opacity, 0..100 (see `ServerConfig.panelOpacity`). */
  panelOpacity: number;
  /**
   * Global multiplier on the overlay's type scale, 80..120 (percent). Moves every
   * font size together so the glance hierarchy keeps its proportions while the
   * operator tunes overall legibility for their screen and seating distance.
   */
  textScale: number;
  /** Whether a critical value blooms cyan when it changes. */
  changeGlow: boolean;
  /**
   * Radar car-icon size, 30..150 (percent) — really the radar's ZOOM, since the
   * icons are drawn at the cars' real footprint and 100% is the classic 18 m
   * range (50% = 36 m, so half-size cars). On this channel rather than a URL
   * param because it is exactly the kind of look-and-feel the operator tunes
   * once from the control panel and expects every live source to follow.
   */
  radarIconScale: number;
  /**
   * Whether the short synthesised audio cues sound at all (see
   * `overlay/js/audio.js`). On by default — a cue exists precisely for the
   * moments a driver's eyes are on the track and the visual is missed — but a
   * broadcast whose audio is already mixed wants one switch that silences the
   * lot.
   */
  audioCues: boolean;
  /** Master volume for those cues, 0..100 (percent). Zero is silence. */
  audioVolume: number;
  /**
   * Per-widget display mode, `{ [widgetId]: mode }` — e.g. `{ tyres: 'tread' }`
   * to show remaining tread instead of temperature.
   *
   * Rides the same channel as the opacity rather than getting one of its own:
   * both are operator look-and-feel that changes a handful of times a session,
   * and the delivery (URL override → in-game IPC push → 1 s poll for OBS) is
   * already solved. An unknown widget id or mode is simply ignored by the
   * overlay, so a stale value can never break a widget.
   */
  widgetModes: Record<string, string>;
  /**
   * Per-widget override of {@link panelOpacity}, `{ [widgetId]: 0..100 }`.
   *
   * A widget named here ignores the global background slider and uses this
   * value instead; one that is absent follows the global. The case is the whole
   * overlay faded for a clean stream with a single panel — fuel, the relative
   * table — kept solid, which is a per-widget decision because which panel that
   * is differs by driver and by session.
   *
   * Sparse on purpose: the map holds only deliberate exceptions, so the default
   * install ships `{}` and every widget keeps following one slider.
   */
  widgetOpacity: Record<string, number>;
  /**
   * How much of the field the standings tower draws.
   *
   * `limit: 'all'` is the whole grid, exactly as the tower has always read.
   * `'custom'` composes the view from the leaders (`top`) plus a window around
   * the player (`ahead`/`behind`), each counted either within the player's own
   * class or across the field (`scope`). Those three numbers express both
   * "three in front, three behind" and "top ten of each class", so there is no
   * list of layout modes to invent and keep in step with a UI.
   *
   * `gap` is a separate axis: what the GAP column counts, cumulative to the
   * leader or the interval to the car in front. Any composition works with
   * either, so it is a field here rather than a mode multiplied into the rest.
   *
   * Rides the appearance channel with everything else here: it is operator
   * look-and-feel, changed a handful of times a session, and the delivery
   * (URL override -> in-game push -> 1 s poll for OBS) is already solved.
   */
  standings: StandingsView;
  /**
   * Unit for every speed readout: `'kph'` (the sim's own) or `'mph'`.
   *
   * App-wide rather than per widget. Three widgets show speed — both inputs
   * panels and motion — and a driver reading 168 on one and 104 on the other
   * would be right to think something was broken.
   */
  speedUnit: 'kph' | 'mph';
}

/** @see Appearance.standings */
export interface StandingsView {
  limit: 'all' | 'custom';
  scope: 'class' | 'field';
  top: number;
  ahead: number;
  behind: number;
  /** What the GAP column counts: the class leader, or the car directly ahead. */
  gap: 'leader' | 'ahead';
  /**
   * What the fastest-lap banner reports: one lap per class (the default), or the
   * single fastest lap of the race. Only one car in a multiclass field can hold
   * the overall, and it is always in the quickest category.
   */
  fastest: 'class' | 'overall';
}

/** URL the overlays read their appearance from. */
const APPEARANCE_PATH = '/appearance.json';

/**
 * Live appearance state. Deliberately module-level and mutable: the desktop app
 * runs this server **in-process**, so it can retune the look through
 * {@link setAppearance} while a session is live. Baking the value into the
 * `ServerConfig` alone would mean restarting the server — and dropping every
 * connected overlay — each time the operator nudged the slider.
 */
const appearance: Appearance = {
  panelOpacity: 100,
  textScale: 100,
  changeGlow: true,
  radarIconScale: 50,
  audioCues: true,
  audioVolume: 60,
  widgetModes: {},
  widgetOpacity: {},
  standings: {
    limit: 'all',
    scope: 'class',
    top: 0,
    ahead: 3,
    behind: 3,
    gap: 'leader',
    fastest: 'class',
  },
  speedUnit: 'kph',
};

/** Current appearance (a deep-enough copy — callers must not mutate the state). */
export function getAppearance(): Appearance {
  return {
    ...appearance,
    widgetModes: { ...appearance.widgetModes },
    widgetOpacity: { ...appearance.widgetOpacity },
    standings: { ...appearance.standings },
  };
}

/**
 * Updates the appearance served to the overlays, effective immediately (they
 * re-read it within a second, or are pushed to directly by the app). Values are
 * clamped and filtered, so a bad caller cannot put nonsense on the wire.
 */
export function setAppearance(next: Partial<Appearance>): Appearance {
  if (typeof next?.panelOpacity === 'number' && Number.isFinite(next.panelOpacity)) {
    appearance.panelOpacity = Math.min(100, Math.max(0, Math.round(next.panelOpacity)));
  }
  if (typeof next?.textScale === 'number' && Number.isFinite(next.textScale)) {
    appearance.textScale = Math.min(120, Math.max(80, Math.round(next.textScale)));
  }
  if (typeof next?.changeGlow === 'boolean') {
    appearance.changeGlow = next.changeGlow;
  }
  if (typeof next?.radarIconScale === 'number' && Number.isFinite(next.radarIconScale)) {
    appearance.radarIconScale = Math.min(150, Math.max(30, Math.round(next.radarIconScale)));
  }
  if (typeof next?.audioCues === 'boolean') {
    appearance.audioCues = next.audioCues;
  }
  if (typeof next?.audioVolume === 'number' && Number.isFinite(next.audioVolume)) {
    appearance.audioVolume = Math.min(100, Math.max(0, Math.round(next.audioVolume)));
  }
  if (next?.widgetModes && typeof next.widgetModes === 'object') {
    for (const [widget, mode] of Object.entries(next.widgetModes)) {
      // Ids/modes are short slugs; anything else is a caller bug, not data.
      if (/^[a-z][a-z0-9]{0,23}$/i.test(widget) && /^[a-z][a-z0-9]{0,23}$/i.test(String(mode))) {
        appearance.widgetModes[widget] = String(mode);
      }
    }
  }
  // Replaced wholesale rather than merged: this map's meaning is "the complete
  // set of widgets that opt out of the global slider", so a widget handed back
  // to the global has to be able to LEAVE it — a merge could only ever add.
  if (next?.widgetOpacity && typeof next.widgetOpacity === 'object') {
    const clean: Record<string, number> = {};
    for (const [widget, value] of Object.entries(next.widgetOpacity)) {
      if (!/^[a-z][a-z0-9]{0,23}$/i.test(widget)) continue;
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      clean[widget] = Math.min(100, Math.max(0, Math.round(n)));
    }
    appearance.widgetOpacity = clean;
  }
  // Merged field by field, so a caller sending one number does not silently
  // reset the other four to whatever its own defaults happen to be.
  if (next?.speedUnit === 'kph' || next?.speedUnit === 'mph') {
    appearance.speedUnit = next.speedUnit;
  }
  if (next?.standings && typeof next.standings === 'object') {
    const v = next.standings as Partial<StandingsView>;
    const count = (n: unknown, fallback: number): number => {
      const x = Number(n);
      return Number.isFinite(x) ? Math.min(30, Math.max(0, Math.round(x))) : fallback;
    };
    appearance.standings = {
      limit: v.limit === 'custom' || v.limit === 'all' ? v.limit : appearance.standings.limit,
      scope: v.scope === 'field' || v.scope === 'class' ? v.scope : appearance.standings.scope,
      top: count(v.top, appearance.standings.top),
      ahead: count(v.ahead, appearance.standings.ahead),
      behind: count(v.behind, appearance.standings.behind),
      gap: v.gap === 'ahead' || v.gap === 'leader' ? v.gap : appearance.standings.gap,
      fastest:
        v.fastest === 'class' || v.fastest === 'overall'
          ? v.fastest
          : appearance.standings.fastest,
    };
  }
  return getAppearance();
}

// There was a live TELEMETRY TUNING channel here, alongside the appearance one:
// same retune-in-process contract, but for what the server COMPUTES rather than
// how it looks. Its only setting was the track-limits threshold — the margin the
// geometric excursion detector used — and that detector has been retired in
// favour of the sim's own charges (telemetry/lmuTraceLimits.ts), so the channel
// went with it. Worth re-creating in this shape if a second such knob ever
// appears; it should not go on `Appearance`, which is served to every browser and
// would put a server-side knob on the wire that no overlay can act on.

/* -------------------------------------------------------------------------- */
/*  Live chat — YouTube + Twitch, merged and served on /chat                  */
/* -------------------------------------------------------------------------- */

/**
 * The live-chat hub, module-level for the same reason the appearance state is:
 * the desktop app runs this server in-process and links/unlinks accounts while a
 * session is live, so it must be able to retune the chat sources through
 * {@link setChatConfig} without restarting the server and dropping every overlay.
 * Null until {@link start} builds it (so the module can be imported by tests
 * that never boot the server).
 */
let chatHub: ChatHub | null = null;

/**
 * Point the chat feed at (or away from) a Twitch channel and/or a YouTube live
 * chat, effective immediately. The desktop app calls this after the operator
 * links an account or edits their channel; a standalone server seeds it once
 * from config at boot. Safe to call before {@link start} — the value is held and
 * applied when the hub is created.
 */
export function setChatConfig(next: ChatConfig): ChatConfig {
  pendingChatConfig = { ...pendingChatConfig, ...next };
  if (chatHub) chatHub.setConfig(pendingChatConfig);
  return { ...pendingChatConfig };
}

/** The chat config currently in force. */
export function getChatConfig(): ChatConfig {
  return chatHub ? chatHub.getConfig() : { ...pendingChatConfig };
}

/** Config staged before the hub exists (or the running hub's, mirrored here). */
let pendingChatConfig: ChatConfig = {};

/** Handler run when YouTube reports its token expired — set by the desktop app. */
let chatAuthErrorHandler: (() => void) | null = null;

/**
 * Register a callback for "the YouTube access token expired". The desktop app
 * uses it to mint a fresh token and hand it back via {@link setChatConfig},
 * which is the whole reason polling stops on a 401 rather than spinning on a
 * dead credential. Wired straight through to the hub when it exists.
 */
export function setChatYouTubeAuthErrorHandler(cb: (() => void) | null): void {
  chatAuthErrorHandler = cb;
  if (chatHub) chatHub.onYouTubeAuthError = () => chatAuthErrorHandler?.();
}

/** Serves the current {@link Appearance} as JSON (never cached). */
function serveAppearance(res: ServerResponse): void {
  const body = JSON.stringify(appearance);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** URL the track-map widget fetches the learned circuit shape from. */
const TRACKMAP_PATH = '/trackmap.json';

/**
 * Serves the circuit currently learned, as JSON.
 *
 * The shape rides HTTP rather than the telemetry frame for the same reason the
 * sponsor manifest does: it is ~1500 points that change when the track changes,
 * and putting it on a 30 Hz wire would repeat tens of kilobytes a second to say
 * something that is still true. The frame carries only a revision number, and the
 * widget refetches this when that moves. `204` — not `404` — before a circuit is
 * learned: there is no error here, only a lap not yet driven, and the widget
 * shows its learning read rather than a failed request.
 */
function serveTrackMap(res: ServerResponse): void {
  const map = getPublishedTrackMap();
  if (!map) {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const body = JSON.stringify(map);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** URL prefix the manufacturer brand badges are served under. */
const BADGE_PREFIX = '/carbadges/';
/**
 * Badge bytes by manufacturer name, `null` = "the game has no badge for this
 * name" (negative result cached so an unbadged manufacturer costs one upstream
 * request per server run, not one per row per page load).
 */
const badgeCache = new Map<string, Buffer | null>();

/** Fetches one badge SVG from the game's own web server; `null` on any miss. */
function fetchBadge(name: string, lmuApiPort: number): Promise<Buffer | null> {
  return new Promise((resolveBadge) => {
    const path = `/start/images/manufacturer/${encodeURIComponent(`Brand=${name}`)}.svg`;
    const req = httpGet({ host: '127.0.0.1', port: lmuApiPort, path, timeout: 4000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolveBadge(null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolveBadge(Buffer.concat(chunks)));
    });
    req.on('error', () => resolveBadge(null));
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/**
 * Serves `/carbadges/<manufacturer>.svg` — the brand badge the standings tower
 * puts beside each driver.
 *
 * The artwork is LMU's own: the game's web server publishes its UI's badge set
 * (`/start/images/manufacturer/Brand=<Name>.svg`, one per manufacturer,
 * matching the `manufacturer` strings its car list uses). Proxied through here
 * rather than hotlinked because the overlay is often viewed from another
 * machine (OBS on a second PC), where the game's `localhost:6397` does not
 * resolve — this server always runs beside the game. Cached in memory for the
 * life of the process, including the game's "no such badge" answer; a name the
 * game cannot draw falls back to its own `Default` badge, and only when even
 * that is unreachable (game closed before the first fetch) does the route 404 —
 * which the widget treats as "show no badge".
 */
async function serveCarBadge(
  res: ServerResponse,
  rawPath: string,
  lmuApiPort: number,
): Promise<void> {
  const name = rawPath.slice(BADGE_PREFIX.length).replace(/\.svg$/i, '').trim();
  // Manufacturer names are words ("Aston Martin", "Mercedes-AMG", "Isotta
  // Fraschini"); anything outside that shape is not a name the game knows.
  if (!name || name.length > 64 || !/^[\w .&-]+$/.test(name)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  let svg = badgeCache.get(name);
  if (svg === undefined) {
    svg = await fetchBadge(name, lmuApiPort);
    badgeCache.set(name, svg);
  }
  if (!svg) {
    let fallback = badgeCache.get('Default');
    if (fallback === undefined) {
      fallback = await fetchBadge('Default', lmuApiPort);
      // A live "no Default either" is worth caching; an unreachable game is
      // not — the fetch is retried next time so badges appear once it is up.
      if (fallback) badgeCache.set('Default', fallback);
    }
    svg = fallback ?? null;
  }
  if (!svg) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Content-Length': svg.length,
    // Stable per game install; let the browser keep it for the session.
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(svg);
}

/** URL prefix the operator's sponsor logos are served under. */
const SPONSOR_PREFIX = '/sponsors/';
/** Image extensions accepted as sponsor logos. */
const SPONSOR_EXTS = new Set(['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp']);

/**
 * Serves `/sponsors/index.json` — the list of logo filenames the overlay should
 * rotate through, plus the configured interval.
 *
 * The overlay fetches this rather than receiving it in the telemetry frame:
 * branding is operator configuration, not telemetry, and putting it on the wire
 * at 30 Hz would repeat a static payload 30 times a second for no reason.
 */
async function serveSponsorManifest(
  res: ServerResponse,
  sponsorRoot: string,
  intervalSec: number,
): Promise<void> {
  let logos: string[] = [];
  try {
    const entries = await fs.readdir(sponsorRoot, { withFileTypes: true });
    logos = entries
      .filter((e) => e.isFile() && SPONSOR_EXTS.has(extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort();
  } catch {
    /* no sponsor directory yet — an empty list is the correct answer */
  }
  const body = JSON.stringify({ intervalSec, logos });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

/**
 * Resolves and serves a static file from the overlay directory, guarding
 * against path traversal outside that root.
 *
 * Requests under {@link SPONSOR_PREFIX} are served from the operator's sponsor
 * directory instead, with the same containment guard applied to that root.
 */
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  overlayRoot: string,
  sponsorRoot: string,
  sponsorIntervalSec: number,
): Promise<void> {
  // Strip query string and decode; default to index.html.
  const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  const relPath = rawPath === '/' ? '/index.html' : rawPath;

  // Appearance is runtime state, not a file on disk.
  if (relPath === APPEARANCE_PATH) {
    serveAppearance(res);
    return;
  }
  // Likewise the learned circuit — it lives in the running provider.
  if (relPath === TRACKMAP_PATH) {
    serveTrackMap(res);
    return;
  }

  let root = overlayRoot;
  let subPath = relPath;
  if (relPath.startsWith(SPONSOR_PREFIX)) {
    if (!sponsorRoot) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (relPath === `${SPONSOR_PREFIX}index.json`) {
      await serveSponsorManifest(res, sponsorRoot, sponsorIntervalSec);
      return;
    }
    root = sponsorRoot;
    subPath = relPath.slice(SPONSOR_PREFIX.length - 1); // keep the leading '/'
  }

  // Normalize and confine to the chosen root (prevents ../ escapes).
  const candidate = resolve(root, '.' + normalize(subPath));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(candidate);
    if (stat.isDirectory()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    const type = CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      // Overlay assets change during development; discourage stale caching.
      'Cache-Control': 'no-cache',
    });
    const stream = createReadStream(candidate);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

/**
 * Boots the server: static HTTP, WebSocket broadcast, and the telemetry loop.
 * @returns A shutdown function that stops the loop and closes both servers.
 */
export async function start(config: ServerConfig = loadConfig()): Promise<() => Promise<void>> {
  const overlayRoot = resolve(process.cwd(), config.overlayDir);
  const sponsorRoot = config.sponsorDir ? resolve(config.sponsorDir) : '';

  // Seed the live appearance from config; the app may retune it later without a
  // restart (see setAppearance).
  setAppearance({
    panelOpacity: config.panelOpacity,
    textScale: config.textScale,
    changeGlow: config.changeGlow,
    radarIconScale: config.radarIconScale,
    audioCues: config.audioCues,
    audioVolume: config.audioVolume,
  });
  // The MFD widget's control plane. `pit`/`aid` write to LMU's REST API (works
  // even under provider `rf2` as long as the game's API is up); `aidkey` injects
  // real keystrokes for the LIVE aids LMU does not expose to REST.
  const mfdDeps = {
    controller: new MfdController({ lmuApiPort: config.lmuApiPort, verbose: config.verbose }),
    keys: new KeySender({ verbose: config.verbose }),
  };
  if (!mfdDeps.keys.available) {
    console.log('[apex-overlay] keystroke injection unavailable — live aid keys disabled.');
  }

  // Everything the MFD can change goes into the one list the cursor walks — the
  // overlay's own rows (SERVE, PIT REQUEST) ahead of the sim's pit menu, the
  // driving aids after it — so the four bindable controls reach every adjustable
  // row and not just the pit ones. Registered here because this is the one place
  // that holds both the controller and the key sender they need.
  setRaceControlRows(() => buildRaceControlRows(mfdDeps.controller, mfdDeps.keys));
  setAidRows(() => buildAidRows(mfdDeps.keys));

  const httpServer = createServer((req, res) => {
    // MFD control requests are handled first; everything else is static assets.
    if (handleMfdCommand(req, res, mfdDeps)) return;
    // Brand badges are proxied from the game, not read from disk — routed here
    // because only this scope knows which port the game's API is on.
    if ((req.url ?? '').startsWith(BADGE_PREFIX)) {
      let rawPath = '';
      try {
        rawPath = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
      } catch {
        /* malformed escape — falls through to the 404 inside */
      }
      void serveCarBadge(res, rawPath, config.lmuApiPort);
      return;
    }
    void serveStatic(req, res, overlayRoot, sponsorRoot, config.sponsorIntervalSec);
  });

  const wsServer = new TelemetryWsServer(config);

  // Live chat: the hub pulls YouTube + Twitch into one normalized feed, the
  // ChatWsServer serves it to the chat widget on /chat. Seeded from config so a
  // standalone `npm start` with APEX_TWITCH_CHANNEL set works with no desktop
  // app; the app retunes it live through setChatConfig().
  chatHub = new ChatHub({ verbose: config.verbose });
  if (chatAuthErrorHandler) chatHub.onYouTubeAuthError = () => chatAuthErrorHandler?.();
  pendingChatConfig = {
    twitchChannel: config.twitchChannel || pendingChatConfig.twitchChannel,
    youTubeLiveChatId: config.youTubeLiveChatId || pendingChatConfig.youTubeLiveChatId,
    youTubeAccessToken: config.youTubeAccessToken || pendingChatConfig.youTubeAccessToken,
  };
  chatHub.setConfig(pendingChatConfig);
  const chatWsServer = new ChatWsServer(chatHub, { verbose: config.verbose });

  // One upgrade router for both WebSocket endpoints. A path-scoped ws server
  // aborts any upgrade whose path it does not own (HTTP 400), so two of them
  // auto-attached to the same HTTP server would abort each other — hence both
  // run in `noServer` mode and are dispatched by path here.
  const chatPath = '/chat';
  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      /* malformed request-target — falls through to destroy below */
    }
    if (pathname === config.wsPath) wsServer.handleUpgrade(req, socket, head);
    else if (pathname === chatPath) chatWsServer.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  // Hand back any circuit an earlier build condemned. Those builds could throw
  // a published map away mid-session and leave a note so the shipped shape was
  // never loaded again; the note outlives the rule that wrote it, so it is
  // cleared here rather than left to cost someone their map forever.
  const revived = clearRejectedTrackMaps();
  if (revived > 0) console.log(`[server] restored ${revived} track map(s) condemned by an earlier build`);

  const provider = selectProvider(config);
  await provider.start();

  // Bind the port, rejecting cleanly if it fails (e.g. the port is already in
  // use). Without an `error` handler the listen callback simply never fires and
  // the caller hangs; a desktop UI needs a real error to show the operator.
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error): void => {
        httpServer.removeListener('listening', onListening);
        rejectListen(err);
      };
      const onListening = (): void => {
        httpServer.removeListener('error', onError);
        resolveListen();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(config.httpPort, config.host);
    });
  } catch (err) {
    // Roll back the pieces already started so a failed bind leaks nothing.
    await provider.stop();
    await wsServer.close();
    await chatWsServer.close();
    chatHub.stop();
    chatHub = null;
    throw err;
  }

  const intervalMs = frameIntervalMs(config);
  // Windows coalesces JS timers to ~15.6 ms multiples, so a plain setInterval
  // at the target rate silently halves anything above ~32 Hz (a 17 ms request
  // fires every 31 ms → 60 Hz delivered as 32). Instead tick at a fast, fixed
  // cadence and broadcast only when a frame is due — the wake-ups between due
  // frames are single timestamp compares, so the cost is negligible and the
  // delivered rate tracks the configured one up to the host's timer floor.
  const tickMs = Math.max(1, Math.min(intervalMs, 8));
  let lastPollMs = Date.now();
  let nextDueMs = Date.now();
  const loop = setInterval(() => {
    const now = Date.now();
    if (now < nextDueMs) return;
    // Fixed cadence; if we fall behind, resume from now rather than bursting.
    nextDueMs = Math.max(nextDueMs + intervalMs, now);
    const dt = now - lastPollMs;
    lastPollMs = now;
    try {
      const frame = provider.poll(now, dt);
      wsServer.broadcast(frame);
    } catch (err) {
      // A provider must never take down the loop; log and keep broadcasting.
      console.error('[loop] provider poll failed:', (err as Error).message);
    }
  }, tickMs);
  loop.unref?.();

  const url = `http://${config.host}:${config.httpPort}/`;
  console.log(`[apex-overlay] serving overlays at ${url}`);
  console.log(`[apex-overlay] websocket at ws://${config.host}:${config.httpPort}${config.wsPath}`);
  console.log(
    `[apex-overlay] provider="${provider.name}" connected=${provider.isConnected()} rate=${config.updateRateHz}Hz`,
  );

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(loop);
    await provider.stop();
    await wsServer.close();
    await chatWsServer.close();
    chatHub?.stop();
    chatHub = null;
    await new Promise<void>((r) => httpServer.close(() => r()));
    console.log('[apex-overlay] stopped');
  };

  return shutdown;
}

/**
 * Runs the server as a standalone process, wiring OS signals to a clean
 * shutdown. Only executes when this module is the entrypoint (not on import).
 */
if (require.main === module) {
  start()
    .then((shutdown) => {
      const onSignal = (): void => {
        void shutdown().then(() => process.exit(0));
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    })
    .catch((err) => {
      console.error('[apex-overlay] failed to start:', err);
      process.exit(1);
    });
}
