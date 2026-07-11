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

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { frameIntervalMs, loadConfig, type ServerConfig } from './config';
import { TelemetryWsServer } from './wsServer';
import type { TelemetryProvider } from '../telemetry/provider';
import { SimulatorProvider } from '../telemetry/simulatorProvider';
import { RF2Provider } from '../telemetry/rf2Provider';
import { LmuRestProvider } from '../telemetry/lmuRestProvider';

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

/**
 * Resolves and serves a static file from the overlay directory, guarding
 * against path traversal outside that root.
 */
async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  overlayRoot: string,
): Promise<void> {
  // Strip query string and decode; default to index.html.
  const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  const relPath = rawPath === '/' ? '/index.html' : rawPath;

  // Normalize and confine to the overlay root (prevents ../ escapes).
  const candidate = resolve(overlayRoot, '.' + normalize(relPath));
  if (candidate !== overlayRoot && !candidate.startsWith(overlayRoot + sep)) {
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

  const httpServer = createServer((req, res) => {
    void serveStatic(req, res, overlayRoot);
  });

  const wsServer = new TelemetryWsServer(httpServer, config);

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
    throw err;
  }

  const intervalMs = frameIntervalMs(config);
  let lastPollMs = Date.now();
  const loop = setInterval(() => {
    const now = Date.now();
    const dt = now - lastPollMs;
    lastPollMs = now;
    try {
      const frame = provider.poll(now, dt);
      wsServer.broadcast(frame);
    } catch (err) {
      // A provider must never take down the loop; log and keep broadcasting.
      console.error('[loop] provider poll failed:', (err as Error).message);
    }
  }, intervalMs);
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
