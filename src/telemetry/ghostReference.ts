/**
 * ghostReference.ts — a lap from somewhere other than this disk, for Ghost HUD
 * to chase.
 * -----------------------------------------------------------------------------
 * The ghost selector's own answer is the driver's fastest clean local lap. The
 * Training tab can instead point it at a lap on the league board — anyone's —
 * which the desktop app fetches, caches and hands to the server. This module
 * is the server's half of that hand-over: it checks what arrived, says which
 * combo it belongs to, and turns it into a {@link GhostLap}.
 *
 * ## Why it is combo-stamped
 * The reference is fetched for the combo the app last SAW, a quarter of a
 * second behind the provider and on its own schedule. A lap for the previous
 * circuit, another class or a dry board lap once it has started raining is the
 * wrong thing to chase, so every reference carries the
 * `sim | trackKey | carClass | condition` it was fetched for and the selector
 * only uses it while the combo being driven is exactly that.
 *
 * ## Why the track length is the live one
 * The league's trace payload carries no track length (`lap_traces.data` is the
 * columns alone), and the ghost needs one to turn lap fractions into metres.
 * The board row was looked up from this circuit's own `trackKey`, which embeds
 * its rounded length, so the live length IS the length the lap was driven on.
 *
 * Like `ghostLap.ts`, nothing here touches `fs` or the network.
 */

import { ghostFromTrace, type GhostLap } from './ghostLap';
import type { TrackCondition } from './lapLog';
import type { CompletedTrace, TraceFile } from './lapTrace';

/** Which combo a reference was fetched for, and how to show it. */
export interface GhostReferenceMeta {
  sim: string;
  trackKey: string;
  /** Normalised class, as the board and every lap record key it. */
  carClass: string;
  condition: TrackCondition;
  /**
   * Unique per reference lap — `board:<driverId>:<lapMs>`. Becomes the ghost's
   * `lapId` and so `player.ghost.sourceLapId`, which the widget refetches
   * `/ghost.json` on. A new board time is a new id.
   */
  refId: string;
  /** Overlay label, e.g. `"J. Smith · 1:47.831 · board"`. */
  label: string;
  /** The board time in ms, used when the trace's own `lapSec` is missing. */
  lapMs: number;
}

/** A checked reference: the meta plus the trace columns it came with. */
export interface GhostReference extends GhostReferenceMeta {
  trace: CompletedTrace;
}

/** The combo fields a reference is matched on. */
export interface ReferenceCombo {
  sim: string;
  trackKey: string;
  carClass: string;
  condition: TrackCondition;
}

const CONDITIONS: readonly TrackCondition[] = ['dry', 'damp', 'wet'];

/**
 * Check what the app handed over and build a {@link GhostReference}, or
 * `null` when it is not usable. Nothing is trusted: the payload crossed a
 * module boundary from plain JS, and its columns came off the network.
 */
export function makeGhostReference(trace: unknown, meta: unknown): GhostReference | null {
  if (!trace || typeof trace !== 'object' || !meta || typeof meta !== 'object') return null;
  const m = meta as Partial<GhostReferenceMeta>;
  const tr = trace as Partial<CompletedTrace>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const sim = str(m.sim);
  const trackKey = str(m.trackKey);
  const carClass = str(m.carClass);
  const refId = str(m.refId);
  const condition = CONDITIONS.includes(m.condition as TrackCondition)
    ? (m.condition as TrackCondition)
    : null;
  if (!sim || !trackKey || !carClass || !refId || !condition) return null;
  if (!Array.isArray(tr.d) || !Array.isArray(tr.t) || tr.d.length < 2) return null;
  const lapMs = Number.isFinite(m.lapMs) && (m.lapMs as number) > 0 ? (m.lapMs as number) : 0;
  return {
    sim,
    trackKey,
    carClass,
    condition,
    refId,
    label: str(m.label) || refId,
    lapMs,
    trace: tr as CompletedTrace,
  };
}

/** Whether a reference was fetched for exactly this combo. */
export function referenceMatches(
  ref: ReferenceCombo | null | undefined,
  combo: ReferenceCombo | null | undefined,
): boolean {
  return (
    !!ref &&
    !!combo &&
    ref.sim === combo.sim &&
    ref.trackKey === combo.trackKey &&
    ref.carClass === combo.carClass &&
    ref.condition === combo.condition
  );
}

/**
 * Build the ghost for a reference on the circuit being driven, or `null` when
 * the columns cannot support one (see {@link ghostFromTrace}).
 *
 * @param trackLengthM - The LIVE track length; see the file header.
 */
export function ghostFromReference(ref: GhostReference, trackLengthM: number): GhostLap | null {
  if (!ref || !(Number.isFinite(trackLengthM) && trackLengthM > 0)) return null;
  const file: TraceFile = {
    v: Array.isArray(ref.trace.x) && Array.isArray(ref.trace.z) ? 2 : 1,
    lapId: ref.refId,
    at: '',
    sim: ref.sim,
    trackKey: ref.trackKey,
    track: '',
    trackLengthM,
    car: '',
    carClass: ref.carClass,
    lapMs: ref.lapMs,
    trace: ref.trace,
  };
  return ghostFromTrace(file, ref.label);
}
