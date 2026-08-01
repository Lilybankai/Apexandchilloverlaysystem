/**
 * @file src/server/wsServer.ts
 * @module server/wsServer
 *
 * A thin, robust WebSocket broadcast server for telemetry frames. It attaches
 * to an existing Node HTTP server (so the overlay assets and the live data feed
 * share one port/URL — all OBS needs) and pushes each {@link TelemetryFrame} to
 * every connected overlay as compact JSON.
 *
 * Design notes:
 * - **One serialization per broadcast:** the frame is stringified once and the
 *   same buffer is sent to all clients — important at 30 Hz with several
 *   overlays connected.
 * - **Immediate first paint:** a newly-connected overlay is sent the most recent
 *   frame right away, so widgets populate without waiting for the next tick.
 * - **Heartbeat:** dead connections (e.g. OBS source removed) are detected via
 *   ping/pong and terminated so they do not accumulate.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { TelemetryFrame } from '../telemetry/types';
import type { ServerConfig } from './config';

/** How often to ping clients to detect dead connections (ms). */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Skip broadcasting to a client whose send buffer has grown beyond this many
 * bytes: it is not draining fast enough (a stalled/slow consumer), so piling on
 * more frames would only grow memory. At ~1–2 KB/frame and 30 Hz this tolerates
 * roughly a second of backlog before shedding frames for that client only.
 */
const MAX_BUFFERED_BYTES = 64 * 1024;

/** Extends the socket with liveness tracking for the heartbeat. */
interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

/**
 * Broadcasts {@link TelemetryFrame}s to all connected overlay clients over a
 * WebSocket endpoint mounted on a shared HTTP server.
 */
export class TelemetryWsServer {
  private readonly wss: WebSocketServer;
  private readonly heartbeat: NodeJS.Timeout;
  /** Last frame serialized as JSON, replayed to clients on connect. */
  private lastFrameJson: string | null = null;
  private readonly verbose: boolean;

  /**
   * @param config - Runtime config (supplies verbosity).
   *
   * Uses `noServer` mode: the endpoint is NOT auto-attached to an HTTP server,
   * because more than one WebSocket endpoint now shares one HTTP server (telemetry
   * on `/ws`, chat on `/chat`). A path-scoped `WebSocketServer` aborts any upgrade
   * whose path it does not own with a 400, so two of them on one server abort
   * each other — see the single `upgrade` router in index.ts, which dispatches by
   * path to {@link handleUpgrade}.
   */
  public constructor(config: ServerConfig) {
    this.verbose = config.verbose;
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (socket: TrackedSocket) => this.handleConnection(socket));
    this.wss.on('error', (err) => {
      // Never let a server-level socket error crash the process.
      console.error('[ws] server error:', err.message);
    });

    // Periodically ping clients; terminate any that did not answer the last one.
    this.heartbeat = setInterval(() => this.pingClients(), HEARTBEAT_INTERVAL_MS);
    // Do not keep the event loop alive solely for the heartbeat.
    this.heartbeat.unref?.();
  }

  /** Number of currently-connected overlay clients. */
  public get clientCount(): number {
    return this.wss.clients.size;
  }

  /**
   * Complete a WebSocket upgrade the HTTP server's `upgrade` router has decided
   * belongs to this endpoint. Kept explicit (rather than auto-attached) so the
   * router owns path dispatch and two endpoints can share one HTTP server.
   */
  public handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  /**
   * Serializes and sends a frame to every connected client. Serialization
   * happens once; the same string is reused for all sockets.
   */
  public broadcast(frame: TelemetryFrame): void {
    const json = JSON.stringify(frame);
    this.lastFrameJson = json;
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // Backpressure guard: if this client hasn't drained its buffer, drop the
      // frame for it rather than growing memory. Telemetry is latest-wins, so a
      // slow client simply resyncs on the next frame it can accept.
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
        if (this.verbose) {
          console.warn(`[ws] skipping frame for slow client (buffered ${client.bufferedAmount}B)`);
        }
        continue;
      }
      client.send(json);
    }
  }

  /** Closes the server and all client connections. */
  public close(): Promise<void> {
    clearInterval(this.heartbeat);
    return new Promise((resolve) => {
      for (const client of this.wss.clients) client.terminate();
      this.wss.close(() => resolve());
    });
  }

  /* ------------------------------ internals ------------------------------ */

  private handleConnection(socket: TrackedSocket): void {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('error', (err) => {
      // A single client's error must not affect the broadcast loop.
      if (this.verbose) console.error('[ws] client error:', err.message);
    });
    socket.on('message', (data: RawData) => this.handleClientMessage(socket, data));

    // Send the latest frame immediately so the overlay paints without delay.
    if (this.lastFrameJson !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(this.lastFrameJson);
    }
    if (this.verbose) console.log(`[ws] client connected (${this.clientCount} total)`);
  }

  /**
   * Handles inbound client messages. Overlays are consumers only, so the sole
   * supported message is a lightweight `"ping"` to which we reply `"pong"`;
   * anything else is ignored rather than trusted.
   */
  private handleClientMessage(socket: TrackedSocket, data: RawData): void {
    const text = data.toString();
    if (text === 'ping' && socket.readyState === WebSocket.OPEN) {
      socket.send('pong');
    }
  }

  private pingClients(): void {
    for (const client of this.wss.clients as Set<TrackedSocket>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }
}
