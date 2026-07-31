/**
 * @file src/server/chatWsServer.ts
 * @module server/chatWsServer
 *
 * Broadcasts normalized live-chat messages ({@link ChatMessage}) to the overlay
 * chat widget over a WebSocket mounted at `/chat` on the shared HTTP server.
 *
 * It is a deliberate sibling of {@link TelemetryWsServer}, not an extension of
 * it: chat and telemetry have completely different rhythms. Telemetry is a
 * fixed-rate, latest-wins firehose where a dropped frame is forgotten; chat is
 * bursty and every message matters and must arrive in order. Putting chat on its
 * own endpoint keeps a flurry of messages from ever contending with the 30 Hz
 * telemetry broadcast, and lets a source subscribe to one without the other.
 *
 * On connect a client is sent the hub's short backlog so a source added
 * mid-stream paints immediately instead of waiting for the next message — the
 * same "immediate first paint" contract the telemetry server has.
 */

'use strict';

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ChatHub, ChatMessage } from './chatHub';

/** Heartbeat cadence — matches the telemetry server. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Extends the socket with liveness tracking for the heartbeat. */
interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

/** A message as it goes on the wire (a small envelope so a client can branch). */
type ChatEnvelope =
  | { type: 'backlog'; messages: ChatMessage[] }
  | { type: 'msg'; message: ChatMessage };

/**
 * Serves the normalized chat feed from a {@link ChatHub} to every connected
 * overlay client over a `/chat` WebSocket.
 */
export class ChatWsServer {
  private readonly wss: WebSocketServer;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private readonly verbose: boolean;

  public constructor(hub: ChatHub, opts: { verbose?: boolean } = {}) {
    this.verbose = !!opts.verbose;
    // `noServer` mode — the endpoint is dispatched to by index.ts's single
    // `upgrade` router (see wsServer.ts for why a path-scoped server can't just
    // auto-attach when it shares the HTTP server with another endpoint).
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on('connection', (socket: TrackedSocket) => this.handleConnection(socket, hub));
    this.wss.on('error', (err) => {
      console.error('[chat-ws] server error:', err.message);
    });

    // Fan each new message out to every connected overlay.
    this.unsubscribe = hub.onMessage((msg) => this.broadcast({ type: 'msg', message: msg }));

    this.heartbeat = setInterval(() => this.pingClients(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  /** Number of currently-connected overlay clients. */
  public get clientCount(): number {
    return this.wss.clients.size;
  }

  /** Complete an upgrade the HTTP server's `upgrade` router routed to `/chat`. */
  public handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  /** Serialize once and send to every open client. */
  public broadcast(envelope: ChatEnvelope): void {
    const json = JSON.stringify(envelope);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(json);
    }
  }

  public close(): Promise<void> {
    clearInterval(this.heartbeat);
    this.unsubscribe();
    return new Promise((resolve) => {
      for (const client of this.wss.clients) client.terminate();
      this.wss.close(() => resolve());
    });
  }

  /* ------------------------------ internals ------------------------------ */

  private handleConnection(socket: TrackedSocket, hub: ChatHub): void {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('error', (err) => {
      if (this.verbose) console.error('[chat-ws] client error:', err.message);
    });

    // Replay the recent backlog so a mid-stream source is not blank.
    const backlog = hub.snapshot();
    if (backlog.length && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'backlog', messages: backlog } satisfies ChatEnvelope));
    }
    if (this.verbose) console.log(`[chat-ws] client connected (${this.clientCount} total)`);
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
