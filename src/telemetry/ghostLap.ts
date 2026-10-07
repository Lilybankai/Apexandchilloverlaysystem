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
 * ## The time origin is NOT rebased, and that is deliberate
 * `lapDetail.timeAtDistance` subtracts the trace's own `t[0]` before answering.
 * This module does not, and the difference is load-bearing.
 *
 * A stored trace's `t` is already seconds-into-lap measured from the
 * interpolated start/finish crossing: a real lap on this disk has
 * `t[0] = 0.0050 s` at `d[0] = 0.00009`, which is 0.37 m past the line at
 * ~74 m/s — exactly 5 ms. So `t[0]` is not an offset to remove, it is when the
 * first sample genuinely landed, and the live clock this is compared against
 * shares that origin. Subtracting it would claim the car reached `d[0]`
 * instantly, biasing every gap by up to one sample interval — which at Le
 * Mans's 3.8 Hz is a quarter of a second.
 *
 * Cross-checked on 7 408 real samples from 11 Road Atlanta LMP2 laps: the two
 * paths agree to 50 µs once `lapDetail`'s rebase is added back, and the whole
 * residual is that one constant. `scripts/test-ghostlap.js` §7 pins it, because
 * "make it match lapDetail" is a plausible-looking change that would silently
 * bias the entire feature.
 *
 * ## Dependency-free on purpose
 * Nothing here imports `fs`, and the lap-time formatter it would otherwise
 * borrow (`raceLog.formatLapTime`) drags in `fs`/`os`/`path` and a dozen
 * modules with it. So {@link GhostLap.label} is supplied by the caller, and
 * this module stays testable headlessly — see `scripts/test-ghostlap.js`.
 */

import { brakePoints } from './brakePoints';
import { findCorners, type Corner } from './corners';
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
  /**
   * The driven LINE and the inputs along it, index-aligned with {@link trace}.
   *
   * v1 of Ghost HUD dropped these on the floor: screen-space rails needed only
   * the distance curve, and that economy is exactly why the result read as a
   * delta bar turned on its side. A line drawn on the road needs where the car
   * actually was, and `brake`/`throttle` are what colour it.
   *
   * Absent together when the lap was recorded with shared memory silent — a
   * position has no honest neutral value, so it is omitted rather than zeroed
   * (see `TraceChannels.x`). {@link ghostHasLine} is the guard.
   */
  x?: number[];
  z?: number[];
  brake?: number[];
  throttle?: number[];
  /**
   * The rest of the inputs, for a training view that shows what the hands and
   * feet did: steering (-1..1 of lock), gear, and speed in km/h. Each is
   * present only when the stored trace carries it, filtered by the same pass
   * as the line.
   */
  steer?: number[];
  gear?: number[];
  speedKph?: number[];
  /**
   * Where each braking zone begins, computed once when the ghost is built —
   * never per frame or per request. Absent when the lap has no brake channel.
   * See `brakePoints.ts`.
   */
  brakes?: GhostBrake[];
  /**
   * The lap cut into corners, computed once when the ghost is built. Absent
   * when the lap has no speed channel. See `corners.ts`.
   */
  corners?: Corner[];
  /**
   * Where the sim's S1 and S2 lines fell on this lap, as lap fractions, so a
   * sector readout can split the reference at the real sector lines rather
   * than learn them from a live car crossing them. Absent when the lap record
   * carried no sector times (an invalidated lap, an older trace).
   */
  sectorD?: [number, number];
}

/** One braking point on the ghost's lap. `x`/`z` are `null` without a line. */
export interface GhostBrake {
  d: number;
  x: number | null;
  z: number | null;
}

/** Whether this ghost can be drawn on the road, as opposed to only counted. */
export function ghostHasLine(lap: GhostLap | null): boolean {
  return !!(
    lap &&
    lap.x &&
    lap.z &&
    lap.x.length === lap.trace.length &&
    lap.z.length === lap.trace.length
  );
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
  return cleanTraceIndexed(d, t).samples;
}

/**
 * {@link cleanTrace}, but also returning the source index of each surviving
 * sample.
 *
 * The extra return exists so the other columns — the driven line, the inputs —
 * can be filtered by the SAME pass. Filtering them independently would let the
 * arrays drift apart by a sample, and a line one sample out of step with its
 * own distance curve is a line drawn slightly in the wrong place, which is the
 * hardest kind of wrong to see.
 */
export function cleanTraceIndexed(
  d: readonly number[],
  t: readonly number[],
): { samples: Sample[]; keep: number[] } {
  const n = Math.min(d.length, t.length);
  const out: Sample[] = [];
  const keep: number[] = [];
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
    keep.push(i);
  }
  return out.length < 2 ? { samples: [], keep: [] } : { samples: out, keep };
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

  const { samples: trace, keep } = cleanTraceIndexed(tr.d, tr.t);
  if (trace.length < 2) return null;

  // Every other column is filtered by `keep`, never independently — see
  // cleanTraceIndexed for why a one-sample drift is the dangerous kind.
  const pick = (col: readonly number[] | undefined): number[] | undefined => {
    if (!col || col.length < tr.d.length) return undefined;
    const out = new Array<number>(keep.length);
    for (let i = 0; i < keep.length; i += 1) out[i] = col[keep[i]!]!;
    return out;
  };
  const x = pick(tr.x);
  const z = pick(tr.z);

  const measured = Number.isFinite(tr.lapSec) && tr.lapSec > 0 ? tr.lapSec : 0;
  const fromMs = Number.isFinite(file.lapMs) && file.lapMs > 0 ? file.lapMs / 1000 : 0;
  const lapSec = measured || fromMs;
  if (lapSec <= 0 || lapSec > MAX_LAP_SEC) return null;

  const trackLengthM = Number.isFinite(file.trackLengthM) ? file.trackLengthM : 0;
  if (trackLengthM <= 0) return null;

  const first = trace[0]!;
  const last = trace[trace.length - 1]!;
  const brake = pick(tr.brake);
  const throttle = pick(tr.throttle);
  const steer = pick(tr.steer);
  const gear = pick(tr.gear);
  const speedKph = pick(tr.speedKph);
  // Position is all-or-nothing: half a line is worse than none, because the
  // drawn half would look authoritative.
  const line = x && z ? { x, z } : {};
  const lap: GhostLap = {
    trace,
    lapSec,
    trackLengthM,
    lapId: String(file.lapId || ''),
    label,
    full: first.d <= FULL_LAP_EDGE && last.d >= 1 - FULL_LAP_EDGE,
    ...line,
    ...(brake ? { brake } : {}),
    ...(throttle ? { throttle } : {}),
    ...(steer ? { steer } : {}),
    ...(gear ? { gear } : {}),
    ...(speedKph ? { speedKph } : {}),
  };

  // Braking points and corners are properties of the LAP, so they are worked
  // out here, once, from the cleaned columns. Being index-aligned with `trace`,
  // every position they report sits on the line the widget draws.
  const d = trace.map((sm) => sm.d);
  if (brake) {
    lap.brakes = brakePoints({ d, brake, ...line }, trackLengthM).map((bp) => ({
      d: round6(bp.d),
      x: bp.x === null ? null : round2(bp.x),
      z: bp.z === null ? null : round2(bp.z),
    }));
  }
  const sectorD = sectorLines(trace, lapSec, file.lapMs, file.s1Ms, file.s2Ms);
  if (sectorD) lap.sectorD = sectorD;
  if (speedKph) {
    lap.corners = findCorners(
      { d, speedKph, ...(brake ? { brake } : {}), ...(throttle ? { throttle } : {}), ...line },
      trackLengthM,
    );
  }
  return lap;
}

/**
 * Where the sim's sector lines fell on a lap, as lap fractions.
 *
 * The derivation `lapDetail.sectorMarks` uses, and for its reasons: the
 * record's `s1Ms`/`s2Ms` are DURATIONS on the sim's clock, so they are summed
 * into boundary times and scaled onto the trace's own clock by the ratio of
 * the two lap times before the distance is read off. Redone here on the
 * cleaned curve rather than imported, so this module stays free of the lap
 * store's file I/O. `null` rather than a guess when either line cannot be
 * placed — a sector split at the wrong place misjudges every lap against it.
 */
function sectorLines(
  trace: Sample[],
  lapSec: number,
  lapMs: number,
  s1Ms: number | undefined,
  s2Ms: number | undefined,
): [number, number] | null {
  if (!(lapMs > 0) || !(lapSec > 0) || !(Number(s1Ms) > 0) || !(Number(s2Ms) > 0)) return null;
  const scale = lapSec / lapMs;
  const d1 = interpDist(trace, s1Ms! * scale);
  const d2 = interpDist(trace, (s1Ms! + s2Ms!) * scale);
  if (!(d1 > 0) || !(d2 > d1) || !(d2 < 1)) return null;
  return [round6(d1), round6(d2)];
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

  const dOk = Number.isFinite(d) && d >= 0 && d <= 1;
  const idle: GhostState = {
    active: false,
    gapSec: UNKNOWN_VALUE,
    gapM: UNKNOWN_VALUE,
    refLapSec: round2(lap.lapSec),
    sourceLapId: lap.lapId,
    sourceLabel: lap.label,
    // The driver's own road position, on the same filtered axis the gap is
    // worked out on. Present even when the gap is not: a surface drawing the
    // road needs to know where the car is either way.
    ...(dOk ? { atD: round6(d) } : {}),
  };
  if (lap.trace.length < 2) return idle;
  if (!Number.isFinite(t) || !dOk || t < 0) return idle;

  // Both answer -1 outside the span the trace covers, which is a routine state
  // and not a fault: a fragment of a lap, or a driver far enough off the
  // reference pace that this instant has no counterpart on it.
  const refT = interpTime(lap.trace, d);
  const refD = ghostDistAt(lap, t);
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

/**
 * How far round the ghost has got `t` seconds into the lap, as a lap fraction.
 * It may exceed 1, and is `-1` when there is no honest answer.
 *
 * Within the trace this is plain {@link interpDist}. The case it exists for is
 * the end of the lap: a driver slower than the reference is still short of the
 * line when the reference's lap time runs out, and `interpDist` answers -1
 * there, so the ghost used to vanish for the last gap-seconds of every lap —
 * just as the driver closes on the line and most wants to see it. The ghost has
 * crossed the line and gone on, so it is carried over onto a repeat of its own
 * lap: first the short run from its last sample to the line, then the start of
 * the lap again, at 1 + the distance.
 *
 * Only a FULL lap wraps. A fragment's end is not the line, and carrying it on
 * would invent a position for a car that was never recorded there.
 */
export function ghostDistAt(lap: GhostLap, t: number): number {
  const tr = lap.trace;
  const first = tr[0]!;
  const last = tr[tr.length - 1]!;
  if (t <= last.t || !lap.full) return interpDist(tr, t);
  // Between the last sample and the line: the trace stops a sample short of
  // d = 1, and the lap's own duration says when the line was reached.
  if (t <= lap.lapSec) {
    const span = lap.lapSec - last.t;
    return span > 0 ? last.d + (1 - last.d) * ((t - last.t) / span) : 1;
  }
  // On into the next lap. More than a whole lap behind is no gap the corridor
  // can draw, and `ghostGap` refuses it on distance anyway.
  const tw = t - lap.lapSec;
  if (tw > last.t) return -1;
  if (tw < first.t) return 1 + (first.t > 0 ? first.d * (tw / first.t) : first.d);
  return 1 + interpDist(tr, tw);
}

/* ----------------------------- what HTTP serves --------------------------- */

/**
 * The ghost currently being served at `/ghost.json`.
 *
 * Module-level and mutable for exactly the reason `trackMap.ts`'s `published`
 * is: the provider chooses the ghost inside its poll loop, and the HTTP route
 * holds no reference to the provider. One ghost is selected at a time, so one
 * slot is the whole of the state.
 *
 * It rides HTTP rather than the frame for the same reason the circuit does —
 * it is ~800 points that change only when the ghost changes, and repeating
 * that thirty times a second would say something still true.
 */
let publishedGhost: GhostLap | null = null;

/** Publish a ghost for `/ghost.json`. Called when the selection changes. */
export function setPublishedGhost(lap: GhostLap | null): void {
  publishedGhost = lap;
}

/** The ghost currently served, or `null` when none is selected. */
export function getPublishedGhost(): GhostLap | null {
  return publishedGhost;
}

/** A corner as `/ghost.json` serves it. See `corners.ts` for how each is found. */
export interface GhostJsonCorner {
  entryD: number;
  apexD: number;
  exitD: number;
  apexX: number | null;
  apexZ: number | null;
  minKph: number;
}

/**
 * The body of `/ghost.json`: the lap's columns, flattened, index-aligned with
 * `d`. Every optional array is present only when the stored trace carried it,
 * so a widget tests for it rather than for a placeholder.
 */
export interface GhostJson {
  lapId: string;
  label: string;
  lapSec: number;
  trackLengthM: number;
  full: boolean;
  d: number[];
  t: number[];
  x: number[];
  z: number[];
  brake?: number[];
  throttle?: number[];
  steer?: number[];
  gear?: number[];
  speedKph?: number[];
  brakes?: GhostBrake[];
  corners?: GhostJsonCorner[];
  /** The reference's S1 and S2 lines as lap fractions; see {@link GhostLap.sectorD}. */
  sectorD?: [number, number];
}

/**
 * Shape a ghost for `/ghost.json`, or `null` when it has no line to draw —
 * the route answers `204` for that, as before.
 *
 * Flattened to plain columns rather than the in-memory shape: the widget
 * wants arrays it can index, and `trace` is an array of objects. Corners lose
 * their sample indices, which point into the server's copy and mean nothing
 * to anyone else.
 */
export function ghostJson(lap: GhostLap | null): GhostJson | null {
  if (!lap || !ghostHasLine(lap)) return null;
  return {
    lapId: lap.lapId,
    label: lap.label,
    lapSec: lap.lapSec,
    trackLengthM: lap.trackLengthM,
    full: lap.full,
    d: lap.trace.map((s) => s.d),
    t: lap.trace.map((s) => s.t),
    x: lap.x!,
    z: lap.z!,
    ...(lap.brake ? { brake: lap.brake } : {}),
    ...(lap.throttle ? { throttle: lap.throttle } : {}),
    ...(lap.steer ? { steer: lap.steer } : {}),
    ...(lap.gear ? { gear: lap.gear } : {}),
    ...(lap.speedKph ? { speedKph: lap.speedKph } : {}),
    ...(lap.brakes ? { brakes: lap.brakes } : {}),
    ...(lap.corners
      ? {
          corners: lap.corners.map((c) => ({
            entryD: round6(c.entryD),
            apexD: round6(c.apexD),
            exitD: round6(c.exitD),
            apexX: c.apexX,
            apexZ: c.apexZ,
            minKph: c.minKph,
          })),
        }
      : {}),
    ...(lap.sectorD ? { sectorD: lap.sectorD } : {}),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
