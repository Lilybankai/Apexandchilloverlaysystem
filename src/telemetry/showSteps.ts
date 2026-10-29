/**
 * showSteps.ts — what "Show me" draws for a lap's worst corners.
 * =============================================================================
 *
 * 2026-10-29, the driving coach. "Show me" walks the driver through the
 * corners where the lap lost the most, one step each: the stretch of road to
 * zoom the map and the charts to, both laps' braking / turn-in / apex /
 * throttle / full-throttle points marked on it, an arrow from where the
 * driver did the thing to where the reference did it ("brake 12 m later"),
 * and one line of words. The renderer (`review-charts.js`, `show-me.js`)
 * draws; this module only decides.
 *
 * ## Which corners, which arrow
 * Corners are ranked by the loss the DRIVER owns: `lossSec − straightSec`, so
 * a reference's tow down the back straight is never the top step. The arrow
 * is for the phase holding most of that corner's loss:
 *
 *   braking    brake onset            "brake 12 m later"
 *   turnIn     turn-in point          "turn in 6 m later"
 *   midCorner  throttle pick-up       "back on the throttle 9 m earlier"
 *   exit       full throttle          "flat 15 m earlier"
 *   exitRun    full throttle, else the pick-up
 *
 * with the speed that goes with it in the words ("+4 km/h at the apex"). A
 * phase whose point is missing on either lap, or differs by under
 * {@link MIN_ARROW_M}, falls to the next-worst phase; with none, the step has
 * marks and words but no arrow. Words are km/h and metres, as
 * `practiceLap.cornerTip`.
 *
 * Pure. Tested in `scripts/test-showsteps.js`.
 */

import type { CoachPhase, CornerPhaseLoss, LapLossBreakdown, PhasePoints, ShowArrow, ShowMark, ShowStep } from './coachContract';
import { colAtD, prepareLap, type PreparedLap } from './cornerPhases';
import type { LossLapInput } from './timeLoss';

/** Road shown either side of the corner, metres. */
export const SHOW_MARGIN_M = 60;
/** The longest exit run a step's window takes in, metres (Mulsanne is 2 km). */
export const SHOW_MAX_RUN_M = 400;
/** A point closer than this to the reference's gets no arrow, metres. */
export const MIN_ARROW_M = 3;
/** An apex this much slower is named as the cause of a slow exit, km/h. */
const MIN_APEX_CAUSE_KPH = 3;
/** A corner whose driver loss is under this is not worth a step, seconds. */
export const SHOW_MIN_SEC = 0.02;

type MarkKind = ShowMark['kind'];

const MARK_FIELDS: [MarkKind, keyof PhasePoints][] = [
  ['brake', 'brakeOnD'],
  ['turnin', 'turnInD'],
  ['apex', 'apexD'],
  ['throttle', 'pickupD'],
  ['full', 'fullThrottleD'],
];

const PHASE_WORDS: Record<CoachPhase, string> = {
  braking: 'the braking',
  turnIn: 'the turn-in',
  midCorner: 'mid-corner',
  exit: 'the exit',
  exitRun: 'the straight after it',
};

/**
 * Steps for the `top` corners by driver-owned loss, worst first. Empty when
 * nothing lost {@link SHOW_MIN_SEC} or the breakdown is empty.
 *
 * @param trackLengthM - Optional (an addition to the stub): defaults to the
 *    that  puts on its result.
 */
export function showSteps(
  b: LapLossBreakdown,
  mine: LossLapInput,
  ref: LossLapInput,
  top = 3,
  trackLengthM?: number,
): ShowStep[] {
  if (!b || !Array.isArray(b.corners) || b.corners.length === 0 || !(top > 0)) return [];
  const L = trackLengthM !== undefined && trackLengthM > 0 ? trackLengthM : lengthOf(b, mine, ref);
  if (!(L > 0)) return [];
  const pm = prepareLap(mine.cols, L);
  const pr = prepareLap(ref.cols, L);

  const ranked = b.corners
    .map((c) => ({ c, own: driverLoss(c) }))
    .filter((r) => r.own >= SHOW_MIN_SEC)
    .sort((x, y) => y.own - x.own)
    .slice(0, Math.floor(top));

  return ranked.map(({ c, own }) => stepFor(c, own, pm, pr, L));
}

/** The loss in a corner that the driver owns: everything but a tow or a faster car. */
export function driverLoss(c: Pick<CornerPhaseLoss, 'lossSec' | 'straightSec'>): number {
  return c.lossSec - (Number.isFinite(c.straightSec) ? c.straightSec : 0);
}

function stepFor(c: CornerPhaseLoss, own: number, pm: PreparedLap | null, pr: PreparedLap | null, L: number): ShowStep {
  // Phases by driver-owned loss: the exit run gives back its straight-line share.
  const phaseLoss = (ph: CoachPhase): number => c.phases[ph] - (ph === 'exitRun' ? c.straightSec || 0 : 0);
  const order = (Object.keys(c.phases) as CoachPhase[]).slice().sort((a, b) => phaseLoss(b) - phaseLoss(a));
  const worst = order[0]!;

  const margin = SHOW_MARGIN_M / L;
  const end = worst === 'exitRun' ? Math.min(c.runEndD, c.exitD + SHOW_MAX_RUN_M / L) : c.exitD;
  const lo = Math.min(c.entryD, c.mine.brakeOnD ?? c.entryD, c.mine.turnInD ?? c.entryD);
  const window: [number, number] = [clamp01(lo - margin), clamp01(Math.max(end, c.mine.fullThrottleD ?? end) + margin)];

  const marks: ShowMark[] = [];
  for (const [who, pts, lap] of [
    ['you', c.mine, pm],
    ['ref', c.ref, pr],
  ] as ['you' | 'ref', PhasePoints, PreparedLap | null][]) {
    for (const [kind, field] of MARK_FIELDS) {
      const d = pts[field];
      if (typeof d !== 'number' || !Number.isFinite(d)) continue;
      const m: ShowMark = { d, kind, who };
      if (lap && lap.x && lap.z) {
        const x = colAtD(lap, lap.x, d);
        const z = colAtD(lap, lap.z, d);
        m.x = x === null ? null : round2(x);
        m.z = z === null ? null : round2(z);
      }
      if (kind === 'apex' && pts.minKph !== null) m.label = `${Math.round(pts.minKph)} km/h`;
      marks.push(m);
    }
  }

  // The arrow for the worst phase that has one.
  let arrow: ShowArrow | null = null;
  let arrowPhase: CoachPhase | null = null;
  for (const ph of order) {
    if (phaseLoss(ph) <= 0) break;
    arrow = arrowFor(ph, c, L);
    if (arrow) {
      arrowPhase = ph;
      break;
    }
  }

  const text = sentence(c, own, worst, arrow, arrowPhase);
  return { cornerId: c.id, window, marks, arrows: arrow ? [arrow] : [], text };
}

/** The arrow for one phase: from the driver's point to the reference's, with its words. */
function arrowFor(ph: CoachPhase, c: CornerPhaseLoss, L: number): ShowArrow | null {
  const pair = (f: keyof PhasePoints): [number, number] | null => {
    const a = c.mine[f];
    const b = c.ref[f];
    return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
  };
  const make = (f: keyof PhasePoints, verb: string): ShowArrow | null => {
    const p = pair(f);
    if (!p) return null;
    const m = (p[1] - p[0]) * L;
    if (Math.abs(m) < MIN_ARROW_M) return null;
    return { fromD: p[0], toD: p[1], label: `${verb} ${Math.round(Math.abs(m))} m ${m > 0 ? 'later' : 'earlier'}` };
  };
  switch (ph) {
    case 'braking':
      return make('brakeOnD', 'Brake') ?? make('brakeOffD', 'Release the brake');
    case 'turnIn':
      return make('turnInD', 'Turn in');
    case 'midCorner':
      return make('pickupD', 'Back on the throttle');
    case 'exit':
      return make('fullThrottleD', 'Flat') ?? make('pickupD', 'Back on the throttle');
    case 'exitRun':
      return make('fullThrottleD', 'Flat') ?? make('pickupD', 'Back on the throttle');
    default:
      return null;
  }
}

/** One line: where, how much, which phase, and what to change. */
function sentence(c: CornerPhaseLoss, own: number, worst: CoachPhase, arrow: ShowArrow | null, arrowPhase: CoachPhase | null): string {
  const parts: string[] = [`${c.id}: ${own.toFixed(2)} s, most of it in ${PHASE_WORDS[worst]}.`];
  const advice: string[] = [];
  if (arrow) advice.push(arrow.label);
  const kph = (v: number): string => `${Math.round(Math.abs(v))} km/h`;
  const minGap = c.mine.minKph !== null && c.ref.minKph !== null ? c.mine.minKph - c.ref.minKph : null;
  const exitGap = c.mine.exitKph !== null && c.ref.exitKph !== null ? c.mine.exitKph - c.ref.exitKph : null;
  const phase = arrowPhase ?? worst;
  if (phase === 'exit' || phase === 'exitRun') {
    // A slow exit usually starts with a slow apex: say so when it did.
    if (minGap !== null && minGap <= -MIN_APEX_CAUSE_KPH) advice.push(`carry ${kph(minGap)} more through the apex`);
    else if (exitGap !== null && exitGap <= -1) advice.push(`${kph(exitGap)} more on the exit`);
  } else if (minGap !== null && minGap <= -1) {
    advice.push(`carry ${kph(minGap)} more to the apex`);
  }
  if (advice.length) {
    const line = advice.join(' and ');
    parts.push(line.charAt(0).toUpperCase() + line.slice(1) + '.');
  }
  if (c.straightFlag && Math.abs(c.straightSec) >= 0.01) {
    const who = c.straightSec > 0 ? 'the reference' : 'you';
    const why = c.straightFlag === 'tow' ? 'a tow' : 'straight-line speed';
    parts.push(`Another ${Math.abs(c.straightSec).toFixed(2)} s on the straight was ${why} for ${who}, not driving.`);
  }
  return parts.join(' ');
}

function lengthOf(b: LapLossBreakdown, mine: LossLapInput, ref: LossLapInput): number {
  const own = (b as LapLossBreakdown & { trackLengthM?: number }).trackLengthM;
  if (typeof own === 'number' && own > 0) return own;
  const fromCols = (mine.cols as { trackLengthM?: number }).trackLengthM ?? (ref.cols as { trackLengthM?: number }).trackLengthM;
  return typeof fromCols === 'number' && fromCols > 0 ? fromCols : 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
