/**
 * @file src/server/config.ts
 * @module server/config
 *
 * Central runtime configuration for the Apex & Chill overlay server.
 *
 * Values are resolved from environment variables (so the Windows launcher can
 * override them without editing source) and fall back to sensible, lightweight
 * defaults. Keeping every tunable in one place avoids magic numbers scattered
 * across the server and provider code.
 */

/** Resolved server configuration. See {@link loadConfig}. */
export interface ServerConfig {
  /** Interface/host to bind the HTTP+WebSocket server to. */
  host: string;
  /**
   * HTTP port. The static overlay files and the WebSocket endpoint are both
   * served from this port (the WS server is attached to the HTTP server), so a
   * single URL/port is all OBS needs.
   */
  httpPort: number;
  /**
   * WebSocket port. Defaults to {@link httpPort} (shared HTTP server). Set a
   * different value only if you deliberately want a standalone WS port.
   */
  wsPort: number;
  /** URL path the WebSocket endpoint is mounted at (e.g. `/ws`). */
  wsPath: string;
  /**
   * Telemetry broadcast rate in frames per second. Higher = smoother pedal
   * traces but more CPU/bandwidth. 30 Hz is a good stream default.
   */
  updateRateHz: number;
  /** Filesystem path (relative to project root) of the static overlay assets. */
  overlayDir: string;
  /**
   * Forces the simulator provider even when a real sim is running. Useful for
   * demos and for building overlays without the game open.
   */
  forceSimulator: boolean;
  /**
   * Which live telemetry source to use:
   * - `lmu` — Le Mans Ultimate REST API (default; robust, whole-field data).
   * - `rf2` — rF2/LMU shared-memory reader (physics for the local car).
   * - `simulator` — always synthetic demo data.
   * {@link forceSimulator} overrides this to `simulator`.
   */
  provider: 'lmu' | 'rf2' | 'simulator';
  /** Localhost port of the LMU REST API (used when `provider` is `lmu`). */
  lmuApiPort: number;
  /**
   * Absolute path of the directory holding the operator's sponsor logo images,
   * served read-only under `/sponsors/`. Empty when no sponsor branding is
   * configured, in which case that route 404s.
   *
   * This is a **second** static root, separate from {@link overlayDir}: the
   * images live in the app's user-data directory (they are user content, and
   * must survive an app update), not inside the shipped overlay assets.
   */
  sponsorDir: string;
  /** Seconds each sponsor logo is shown before cross-fading to the next. */
  sponsorIntervalSec: number;
  /**
   * Opacity of every widget's panel background, as a percentage (0..100).
   * Served to the overlays at `/appearance.json`, where it becomes the
   * `--panel-alpha` CSS token (see overlay/js/appearance.js). `100` is the
   * original solid design; `0` removes every panel background, border and
   * header so only the live data floats over the game.
   *
   * This is the boot value only — the desktop app retunes it at runtime
   * through `setAppearance()`, so moving its slider does not restart the
   * server or interrupt a broadcast.
   */
  panelOpacity: number;
  /**
   * Boot value for the global type-scale multiplier, 80..120 (percent), driving
   * the `--fs-scale` CSS token. Every font size in the overlay is declared as
   * `calc(Npx * var(--fs-scale))`, so this moves the whole size hierarchy
   * together — the relative emphasis between critical, important and context
   * text stays fixed, while how large all of it needs to be follows the
   * operator's screen size and seating distance.
   *
   * Retuned at runtime through `setAppearance()`, exactly like `panelOpacity`.
   */
  textScale: number;
  /**
   * Boot value for the change glow: whether a critical value blooms cyan the
   * moment it changes (see the `crit()` helpers in overlay/js/client.js).
   * Retuned at runtime through `setAppearance()`.
   */
  changeGlow: boolean;
  /**
   * Boot value for the radar's car-icon size, 30..150 (percent).
   *
   * This is the radar's zoom, not a multiplier on the artwork: the icons are
   * drawn at the cars' real footprint, so the only honest way to make them
   * smaller is to show more metres (100% = the classic 18 m range, 50% = 36 m).
   * Retuned at runtime through `setAppearance()`, exactly like `panelOpacity`.
   */
  radarIconScale: number;
  /**
   * Boot value for the audio cues: whether the short synthesised tones sound at
   * all (see `overlay/js/audio.js`). Retuned at runtime through
   * `setAppearance()`, like every other look-and-feel value here.
   */
  audioCues: boolean;
  /** Boot value for the cues' master volume, 0..100 (percent). */
  audioVolume: number;
  /**
   * Twitch channel whose chat the overlay's chat widget shows, as the bare login
   * (a URL or `#name` is normalized on the way in). Twitch chat is read
   * anonymously over IRC — no account link, no credential — so a channel name is
   * the only thing this needs. Empty disables the Twitch half of the feed.
   *
   * Live source for the desktop app: it pushes the operator's channel in through
   * `setChatConfig()` without a restart. This is the boot value, so a standalone
   * `npm start` gets a working Twitch feed from one env var.
   */
  twitchChannel: string;
  /**
   * YouTube live-chat id for the overlay's chat widget. Unlike Twitch, YouTube
   * has no anonymous read, so this (and {@link youTubeAccessToken}) come from the
   * desktop app's Google sign-in, which discovers the id for the active
   * broadcast. Empty disables the YouTube half of the feed. Retuned live through
   * `setChatConfig()`.
   */
  youTubeLiveChatId: string;
  /** OAuth access token for the YouTube live-chat polling calls (see above). */
  youTubeAccessToken: string;
  /** Enables verbose logging. */
  verbose: boolean;
}

/** Default configuration used when no environment override is present. */
export const DEFAULT_CONFIG: Readonly<ServerConfig> = Object.freeze({
  host: '127.0.0.1',
  // 17080 since v0.57.1 — 8080 is the most contested alternate-HTTP port on
  // Windows and frequently sits inside a Hyper-V/WSL port reservation, which is
  // refused with EACCES and no process to blame. See defaultSettings() in
  // electron/main.js for the full reasoning; the two must agree, since the
  // desktop app and `npm start` serve the same overlays to the same OBS.
  httpPort: 17080,
  wsPort: 17080,
  wsPath: '/ws',
  updateRateHz: 30,
  overlayDir: 'overlay',
  forceSimulator: false,
  provider: 'lmu',
  lmuApiPort: 6397,
  sponsorDir: '',
  sponsorIntervalSec: 12,
  panelOpacity: 100,
  textScale: 100,
  changeGlow: true,
  radarIconScale: 50,
  audioCues: true,
  audioVolume: 60,
  twitchChannel: '',
  youTubeLiveChatId: '',
  youTubeAccessToken: '',
  verbose: false,
});

/** Lower/upper safety bounds for the broadcast rate. */
const MIN_UPDATE_RATE_HZ = 1;
const MAX_UPDATE_RATE_HZ = 120;

/**
 * Parses an integer from an environment string, returning `fallback` when the
 * variable is unset or not a finite integer.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// A decimal pair (envFloat / clampFloat) lived here for the track-limits
// threshold — the one setting on this object that was a distance in metres, where
// rounding "2.4" to 2 would have moved it by most of a wheel. The geometric
// detector it tuned has been retired, and every remaining setting is an integer.

/** Parses a TCP port from an env var, clamped into the valid 1..65535 range. */
function envPort(name: string, fallback: number): number {
  return clamp(envInt(name, fallback), 1, 65535);
}

/** Parses a boolean env var. Truthy values: `1`, `true`, `yes`, `on`. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** Parses a string env var, trimming and falling back when empty/unset. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

/** Parses the provider selector env var, falling back on any unknown value. */
function envProvider(name: string, fallback: ServerConfig['provider']): ServerConfig['provider'] {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === 'lmu' || raw === 'rf2' || raw === 'simulator') return raw;
  return fallback;
}

/** Clamps `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolves the effective {@link ServerConfig} from environment variables layered
 * over {@link DEFAULT_CONFIG}. Recognised variables:
 *
 * - `APEX_HOST` — bind host (default `127.0.0.1`)
 * - `APEX_HTTP_PORT` — HTTP/overlay port, clamped to 1..65535 (default `17080`)
 * - `APEX_WS_PORT` — WebSocket port, clamped to 1..65535 (default = HTTP port)
 * - `APEX_WS_PATH` — WebSocket path (default `/ws`)
 * - `APEX_UPDATE_HZ` — broadcast rate, clamped to 1..120 (default `30`)
 * - `APEX_OVERLAY_DIR` — static overlay directory (default `overlay`)
 * - `APEX_FORCE_SIM` — force simulator provider (default `false`)
 * - `APEX_PROVIDER` — `lmu` | `rf2` | `simulator` (default `lmu`)
 * - `APEX_LMU_PORT` — LMU REST API port, clamped to 1..65535 (default `6397`)
 * - `APEX_SPONSOR_DIR` — sponsor logo directory served at `/sponsors/` (default none)
 * - `APEX_SPONSOR_SEC` — seconds per sponsor logo, clamped to 3..120 (default `12`)
 * - `APEX_PANEL_OPACITY` — widget background opacity %, clamped to 0..100 (default `100`)
 * - `APEX_AUDIO_CUES` — play the synthesised audio cues (default `true`)
 * - `APEX_AUDIO_VOLUME` — cue volume %, clamped to 0..100 (default `60`)
 * - `APEX_VERBOSE` — verbose logging (default `false`)
 *
 * @returns A fully-resolved, ready-to-use configuration object.
 */
export function loadConfig(): ServerConfig {
  // Ports are clamped here, matching what the Electron path already does when it
  // builds a config from config.json — otherwise `APEX_HTTP_PORT=99999` reached
  // `server.listen()` unvalidated and failed with an opaque range error.
  const httpPort = envPort('APEX_HTTP_PORT', DEFAULT_CONFIG.httpPort);
  return {
    host: envStr('APEX_HOST', DEFAULT_CONFIG.host),
    httpPort,
    // WS shares the HTTP port unless explicitly overridden.
    wsPort: envPort('APEX_WS_PORT', httpPort),
    wsPath: envStr('APEX_WS_PATH', DEFAULT_CONFIG.wsPath),
    updateRateHz: clamp(
      envInt('APEX_UPDATE_HZ', DEFAULT_CONFIG.updateRateHz),
      MIN_UPDATE_RATE_HZ,
      MAX_UPDATE_RATE_HZ,
    ),
    overlayDir: envStr('APEX_OVERLAY_DIR', DEFAULT_CONFIG.overlayDir),
    forceSimulator: envBool('APEX_FORCE_SIM', DEFAULT_CONFIG.forceSimulator),
    provider: envProvider('APEX_PROVIDER', DEFAULT_CONFIG.provider),
    lmuApiPort: envPort('APEX_LMU_PORT', DEFAULT_CONFIG.lmuApiPort),
    sponsorDir: envStr('APEX_SPONSOR_DIR', DEFAULT_CONFIG.sponsorDir),
    sponsorIntervalSec: clamp(
      envInt('APEX_SPONSOR_SEC', DEFAULT_CONFIG.sponsorIntervalSec),
      3,
      120,
    ),
    panelOpacity: clamp(envInt('APEX_PANEL_OPACITY', DEFAULT_CONFIG.panelOpacity), 0, 100),
    textScale: clamp(envInt('APEX_TEXT_SCALE', DEFAULT_CONFIG.textScale), 80, 120),
    changeGlow: envBool('APEX_CHANGE_GLOW', DEFAULT_CONFIG.changeGlow),
    radarIconScale: clamp(envInt('APEX_RADAR_ICONS', DEFAULT_CONFIG.radarIconScale), 30, 150),
    audioCues: envBool('APEX_AUDIO_CUES', DEFAULT_CONFIG.audioCues),
    audioVolume: clamp(envInt('APEX_AUDIO_VOLUME', DEFAULT_CONFIG.audioVolume), 0, 100),
    twitchChannel: envStr('APEX_TWITCH_CHANNEL', DEFAULT_CONFIG.twitchChannel),
    youTubeLiveChatId: envStr('APEX_YT_LIVE_CHAT_ID', DEFAULT_CONFIG.youTubeLiveChatId),
    youTubeAccessToken: envStr('APEX_YT_TOKEN', DEFAULT_CONFIG.youTubeAccessToken),
    verbose: envBool('APEX_VERBOSE', DEFAULT_CONFIG.verbose),
  };
}

/** Milliseconds between broadcasts for a given rate. */
export function frameIntervalMs(config: Pick<ServerConfig, 'updateRateHz'>): number {
  return Math.round(1000 / config.updateRateHz);
}
