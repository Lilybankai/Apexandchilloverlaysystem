/**
 * ghostLap.ts — the reference lap behind Ghost HUD.
 * -----------------------------------------------------------------------------
 * Ghost HUD draws a perspective corridor on the driver's screen with a bright
 * cross-rung — the *gate* — sitting at the chosen reference lap's position on
 * the road. Hold station and the picture is still; lose drive out of a corner
 * and the gate shrinks away toward the vanishing point. The driver reads the
 * gap as geometry rather than as a number.
 *
 * ## Why this module is small
 * Almost nothing new is needed. `paceDelta.ts` already answers both halves of
 * the question for laps driven *this session*:
 *
 *   • where was the reference at this point on the road   → {@link interpTime}
 *   • how far had the reference got at this instant        → {@link interpDist}
 *
 * What Ghost HUD adds is a reference the driver **picked** — a lap off the
 * local trace store, possibly from weeks ago — instead of one the engine
 * adopted automatically, and a gap in METRES so the corridor has something to
 * place the gate on. `PaceDeltas` is entirely in seconds, and seconds cannot
 * be put on a road without knowing how fast the reference was travelling.
 *
 * ## Why the trace is cleaned and NOT resampled
 * It is tempting to resample a stored trace onto a uniform distance grid, and
 * the first draft of the plan said to. It would lose information: traces are
 * decimated at `MIN_D_STEP = 0.001` of a lap and arrive with ~820-990 points,
 * so a 512-point grid is a downsample, and the interpolators handle irregular
 * spacing natively anyway (binary search, then linear between neighbours).
 * Resampling would buy nothing and cost resolution.
 *
 * What the stored columns genuinely do need is a **monotonicity guarantee**.
 * {@link interpDist} relies on `t` rising with `d` so it can binary-search the
 * same array by either axis, and {@link interpTime} divides by the span
 * between neighbours. A stationary car, a reset, or position noise can put a
 * repeated or backwards sample in the columns, which is a zero or negative
 * span to divide by. {@link cleanTrace} is that guarantee and nothing more.
 *
 * ## Dependency-free on purpose
 * Nothing here imports `fs`, and the lap-time formatter it would otherwise
 * borrow (`raceLog.formatLapTime`) drags in `fs`/`os`/`path` and a dozen
 * modules with it. So {@link GhostLap.label} is supplied by the caller, and
 * this module stays testable headlessly — see `scripts/test-ghostlap.js`.
 */

import { interpDist, interpTime, type Sample } from './paceDelta';
import type { TraceFile } from './lapTrace';
import { UNKNOWN_VALUE, type GhostState } from './types';

/**
 * Beyond this |gap| the pairing is not a gap but a mistake — the wrong lap, a
 * different track, a trace from another car. Same threshold and same reasoning
 * as `paceDelta.SANE_LIMIT_SEC`: report nothing rather than nonsense.
 */
const SANE_GAP_SEC = 30;

/**
 * A lap's distance curve covers "the whole lap" when it starts within this
 * fraction of the line and ends within it. Traces are flag-to-flag, so a full
 * one lands well inside; anything looser is a fragment and the corridor will
 * simply read inactive outside the span it does cover.
 */
const FULL_LAP_EDGE = 0.02;

/** Longest believable lap, seconds. Le Mans in the wet is ~4.5 min. */
const MAX_LAP_SEC = 20 * 60;

/** The reference lap Ghost HUD is chasing. */
export interface GhostLap {
  /**
   * The lap's distance→time curve, cleaned by {@link cleanTrace}. Strictly
   * increasing in both axes, so {@link interpTime} and {@link interpDist} can
   * both binary-search it.
   */
  trace: Sample[];
  /** The lap's own duration, seconds. */
  lapSec: number;
  /**
   * Track length in metres — the scale that turns a lap-fraction gap into the
   * metres the corridor geometry needs.
   */
  trackLengthM: number;
  /** `LapRecord.id` of the lap being chased. */
  lapId: string;
  /**
   * Ready-made label for the overlay, e.g. `"your best · 1:13.730 · dry"`.
   * Supplied by the caller — see the note on dependencies in the file header.
   */
  label: string;
  /**
   * Whether the curve spans a whole lap. A fragment still makes a usable
   * ghost over the part it covers; this exists so a surface can say so.
   */
  full: boolean;
}

/**
 * Pair up the `d` and `t` columns of a stored trace into a curve the
 * interpolators can use, dropping anything that would break them.
 *
 * Rejected, in order: non-finite values, distances outside `0..1`, and any
 * sample that does not advance strictly in `d` while not going backwards in
 * `t`. The last one is the point of the function — see the file header.
 *
 * Returns `[]` when fewer than two usable samples survive, which every caller
 * treats as "no ghost" rather than as an error.
 */
export function cleanTrace(d: readonly number[], t: readonly number[]): Sample[] {
  const n = Math.min(d.length, t.length);
  const out: Sample[] = [];
  for (let i = 0; i < n; i += 1) {
    const dd = d[i]!;
    const tt = t[i]!;
    if (!Number.isFinite(dd) || !Number.isFinite(tt)) continue;
    if (dd < 0 || dd > 1 || tt < 0) continue;
    const prev = out[out.length - 1];
    // Strictly forward in distance, never backward in time. A repeated or
    // reversed sample carries no information — a stationary car, a reset, or
    // position noise — and leaves a zero-width span for the interpolators to
    // divide by.
    if (prev && (dd <= prev.d || tt < prev.t)) continue;
    out.push({ d: dd, t: tt });
  }
  return out.length < 2 ? [] : out;
}

/**
 * Build a ghost from a stored lap trace, or `null` when the file cannot
 * support one.
 *
 * The lap's duration comes from `trace.lapSec` — the measured flag-to-flag
 * time — and only falls back to the sim's `lapMs`. That order is deliberate:
 * a large minority of stored traces carry `lapMs: 0` because the sim published
 * no time for the lap, while `trace.lapSec` was measured by the recorder and
 * is always present.
 *
 * @param label - Overlay label; see {@link GhostLap.label}.
 */
export function ghostFromTrace(file: TraceFile, label: string): GhostLap | null {
  const tr = file?.trace;
  if (!tr || !Array.isArray(tr.d) || !Array.isArray(tr.t)) return null;

  const trace = cleanTrace(tr.d, tr.t);
  if (trace.length < 2) return null;

  const measured = Number.isFinite(tr.lapSec) && tr.lapSec > 0 ? tr.lapSec : 0;
  const fromMs = Number.isFinite(file.lapMs) && file.lapMs > 0 ? file.lapMs / 1000 : 0;
  const lapSec = measured || fromMs;
  if (lapSec <= 0 || lapSec > MAX_LAP_SEC) return null;

  const trackLengthM = Number.isFinite(file.trackLengthM) ? file.trackLengthM : 0;
  if (trackLengthM <= 0) return null;

  const first = trace[0]!;
  const last = trace[trace.length - 1]!;
  return {
    trace,
    lapSec,
    trackLengthM,
    lapId: String(file.lapId || ''),
    label,
    full: first.d <= FULL_LAP_EDGE && last.d >= 1 - FULL_LAP_EDGE,
  };
}

/**
 * Where the ghost is right now, for the wire.
 *
 * @param lap - The selected ghost, or `null` when none is.
 * @param t   - Seconds into the current lap, on the delta engine's own clock.
 *              Must come from a lap that was entered over the start/finish
 *              line: before that the clock began wherever the car happened to
 *              be, and the gate would sit tens of metres from the truth. The
 *              caller gates on it — see `paceDelta`'s `fromLine`.
 * @param d   - Road position as a lap fraction `0..1`, from the caller's
 *              `RoadPosition` observer. It must be that filtered estimate,
 *              for the same reason `paceDelta.update` insists on it: the
 *              reference curve was built from values off the same filter, so
 *              live and reference positions only cancel each other's lag if
 *              both came through it.
 *
 * Returns `undefined` only when there is no ghost at all. With a ghost loaded
 * but out of reach it returns an **inactive** state rather than nothing, so a
 * surface can keep showing which lap is selected while the gap reads blank.
 */
export function ghostGap(lap: GhostLap | null, t: number, d: number): GhostState | undefined {
  if (!lap) return undefined;

  const idle: GhostState = {
    active: false,
    gapSec: UNKNOWN_VALUE,
    gapM: UNKNOWN_VALUE,
    refLapSec: round2(lap.lapSec),
    sourceLapId: lap.lapId,
    sourceLabel: lap.label,
  };
  if (lap.trace.length < 2) return idle;
  if (!Number.isFinite(t) || !Number.isFinite(d) || t < 0 || d < 0 || d > 1) return idle;

  // Both interpolators answer -1 outside the span the trace covers, which is a
  // routine state and not a fault: a fragment of a lap, or a driver far enough
  // off the reference pace that this instant has no counterpart on it.
  const refT = interpTime(lap.trace, d);
  const refD = interpDist(lap.trace, t);
  if (refT < 0 || refD < 0) return idle;

  // Positive = the ghost is up the road. `gapSec` is the same arithmetic as
  // `paceDelta`'s Delta T and carries the same sign; it is only described from
  // the chased car's point of view instead of the driver's.
  const gapSec = t - refT;
  const gapM = (refD - d) * lap.trackLengthM;
  if (!Number.isFinite(gapSec) || Math.abs(gapSec) > SANE_GAP_SEC) return idle;
  // A gap longer than the circuit is a lapping situation the corridor has no
  // way to draw, and far more often a mismatched trace.
  if (!Number.isFinite(gapM) || Math.abs(gapM) >= lap.trackLengthM) return idle;

  return {
    ...idle,
    active: true,
    // Wire precision deliberately finer than the two decimals the readout
    // shows, for the reason `paceDelta.round4` gives: the widget eases these
    // over successive frames, and rounding to display precision here would
    // quantise its input and reintroduce visible stepping.
    gapSec: round4(gapSec),
    gapM: round2(gapM),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
