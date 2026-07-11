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
  /** Enables verbose logging. */
  verbose: boolean;
}

/** Default configuration used when no environment override is present. */
export const DEFAULT_CONFIG: Readonly<ServerConfig> = Object.freeze({
  host: '127.0.0.1',
  httpPort: 8080,
  wsPort: 8080,
  wsPath: '/ws',
  updateRateHz: 30,
  overlayDir: 'overlay',
  forceSimulator: false,
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

/** Clamps `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolves the effective {@link ServerConfig} from environment variables layered
 * over {@link DEFAULT_CONFIG}. Recognised variables:
 *
 * - `APEX_HOST` — bind host (default `127.0.0.1`)
 * - `APEX_HTTP_PORT` — HTTP/overlay port (default `8080`)
 * - `APEX_WS_PORT` — WebSocket port (default = HTTP port)
 * - `APEX_WS_PATH` — WebSocket path (default `/ws`)
 * - `APEX_UPDATE_HZ` — broadcast rate, clamped to 1..120 (default `30`)
 * - `APEX_OVERLAY_DIR` — static overlay directory (default `overlay`)
 * - `APEX_FORCE_SIM` — force simulator provider (default `false`)
 * - `APEX_VERBOSE` — verbose logging (default `false`)
 *
 * @returns A fully-resolved, ready-to-use configuration object.
 */
export function loadConfig(): ServerConfig {
  const httpPort = envInt('APEX_HTTP_PORT', DEFAULT_CONFIG.httpPort);
  return {
    host: envStr('APEX_HOST', DEFAULT_CONFIG.host),
    httpPort,
    // WS shares the HTTP port unless explicitly overridden.
    wsPort: envInt('APEX_WS_PORT', httpPort),
    wsPath: envStr('APEX_WS_PATH', DEFAULT_CONFIG.wsPath),
    updateRateHz: clamp(
      envInt('APEX_UPDATE_HZ', DEFAULT_CONFIG.updateRateHz),
      MIN_UPDATE_RATE_HZ,
      MAX_UPDATE_RATE_HZ,
    ),
    overlayDir: envStr('APEX_OVERLAY_DIR', DEFAULT_CONFIG.overlayDir),
    forceSimulator: envBool('APEX_FORCE_SIM', DEFAULT_CONFIG.forceSimulator),
    verbose: envBool('APEX_VERBOSE', DEFAULT_CONFIG.verbose),
  };
}

/** Milliseconds between broadcasts for a given rate. */
export function frameIntervalMs(config: Pick<ServerConfig, 'updateRateHz'>): number {
  return Math.round(1000 / config.updateRateHz);
}
