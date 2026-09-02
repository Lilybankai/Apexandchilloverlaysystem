/**
 * @file src/telemetry/stallMark.ts
 * @module telemetry/stallMark
 *
 * Lets the telemetry server leave breadcrumbs in the app's stall log.
 *
 * ## Why this exists
 * `startServer()` does not fork anything — it `require`s `dist/server/index.js`
 * straight into the Electron main process (see `electron/main.js`). So every
 * poller in here shares an event loop with the thread that composites the
 * in-game overlay window, and a synchronous second spent parsing a REST payload
 * freezes every overlay exactly as if the main process had done it itself.
 *
 * The stall watcher that records those freezes lives on the Electron side
 * (`electron/stall-watch.js`) and cannot be imported from here: this tree also
 * runs under the bench and test harnesses, with no Electron anywhere. So the
 * dependency is inverted — main injects the watcher once, and until it does
 * (or forever, under a harness) every call here is two no-op function calls.
 *
 * Kept deliberately tiny: the point of instrumenting a stall is to cost nothing
 * on the path that is not stalling.
 */

/** The subset of `electron/stall-watch.js` this module needs. */
export interface StallSink {
  begin(what: string): void;
  end(what: string): void;
}

let sink: StallSink | null = null;

/** Wire the watcher in (main), or pull it out again (`null`, for tests). */
export function setStallSink(next: StallSink | null): void {
  sink = next;
}

/** Open a step. Overlapping and repeated labels are the sink's problem. */
export function begin(what: string): void {
  sink?.begin(what);
}

/** Close a step opened with {@link begin}. */
export function end(what: string): void {
  sink?.end(what);
}

/**
 * Run an async step inside a breadcrumb, so a stall that lands while it is in
 * flight names it. The `finally` matters more than usual here: a step that
 * leaked its label would be reported as in-flight for the rest of the session
 * and quietly poison every stall report after it.
 */
export async function around<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (!sink) return fn(); // no watcher: not even a try/finally
  begin(what);
  try {
    return await fn();
  } finally {
    end(what);
  }
}
