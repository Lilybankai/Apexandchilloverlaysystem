/**
 * @file src/telemetry/provider.ts
 * @module telemetry/provider
 *
 * The producer side of the telemetry contract. A {@link TelemetryProvider}
 * turns some raw data source (a live sim's shared memory, or a synthetic
 * simulator) into normalized {@link TelemetryFrame} snapshots that the server
 * broadcasts to the overlays.
 *
 * The server drives providers with a simple **pull** model: it calls
 * {@link TelemetryProvider.poll} once per broadcast tick at the configured
 * update rate. This keeps the design allocation-light (no internal timers or
 * event emitters per provider) and makes providers trivially interchangeable —
 * the simulator, the rF2/LMU reader, and any future source all satisfy the same
 * interface, so the WebSocket server never needs to know which one is active.
 */

import type { TelemetryFrame } from './types';

/**
 * A source of normalized telemetry frames.
 *
 * Lifecycle: {@link start} → repeated {@link poll} at the update rate →
 * {@link stop}. Implementations must never throw from {@link poll}; a provider
 * that loses its data source should return the best frame it can (with
 * {@link TelemetryFrame.connected} `= false`) or degrade gracefully rather than
 * crash the broadcast loop.
 */
export interface TelemetryProvider {
  /** Short identifier for logging (e.g. `"simulator"`, `"rf2"`). */
  readonly name: string;

  /**
   * Initialize the provider (open shared memory, seed simulator state, …).
   * Called once before the first {@link poll}. May be async.
   */
  start(): Promise<void> | void;

  /**
   * Whether the provider is currently backed by a **live** data source.
   * `false` for the simulator or when a real source is unavailable — used to
   * flag frames as demo/placeholder data.
   */
  isConnected(): boolean;

  /**
   * Produce the current normalized frame. Called by the server once per tick.
   *
   * @param nowMs - Current wall-clock time (epoch ms), supplied by the server
   *   so providers share a single clock and remain easy to test.
   * @param dtMs - Milliseconds elapsed since the previous poll (>= 0). Providers
   *   that model evolving state (the simulator) advance by this amount.
   * @returns The current {@link TelemetryFrame}. Must not throw.
   */
  poll(nowMs: number, dtMs: number): TelemetryFrame;

  /**
   * Release any resources (close shared-memory handles, clear state). Called
   * once during shutdown. May be async.
   */
  stop(): Promise<void> | void;
}
