/**
 * @file src/telemetry/garageTap.ts
 * @module telemetry/garageTap
 *
 * Lets the Electron side see each garage-setup payload the provider already
 * fetches, without fetching it again.
 *
 * The LMU provider polls `getPlayerGarageData` every few seconds for the MFD
 * (see `refreshGarageAids`). The Setups tab's History wants the same payload —
 * it is how a change made in LMU's own garage screen gets recorded, whether or
 * not the Setups tab is open — and a second poller for a 100+ key payload on
 * the main thread would be pure waste. So, like stallMark.ts, the dependency
 * is inverted: main injects a sink once, and until it does (or forever, under
 * the bench and test harnesses) publishing is one null check.
 *
 * The sink is called synchronously on the poll's own tick, so it must be
 * cheap; electron/setupHistory.js only compares in memory and defers anything
 * slower. A throwing sink is swallowed — a history bug must never cost the
 * MFD its data.
 */

export type GarageSink = (garage: Record<string, unknown>) => void;

let sink: GarageSink | null = null;

/** Wire the consumer in (main), or pull it out again (`null`, for tests). */
export function setGarageSink(next: GarageSink | null): void {
  sink = next;
}

/** Hand a freshly fetched garage payload to the consumer, if there is one. */
export function publishGarage(garage: Record<string, unknown>): void {
  if (!sink) return;
  try {
    sink(garage);
  } catch {
    /* never the provider's problem */
  }
}
