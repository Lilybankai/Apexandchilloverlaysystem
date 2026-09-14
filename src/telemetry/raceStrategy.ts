/**
 * @file src/telemetry/raceStrategy.ts
 * @module telemetry/raceStrategy
 *
 * How many stops, on which laps, and what it costs to be wrong.
 *
 * ## What this is, and what it deliberately is not
 * `docs/RACE-STRATEGY-ENGINE.md` §9 calls this Phase 1: the race-time model
 * with the **pit-loss and fuel-load terms only**. Two things the document
 * describes are absent here on purpose, and neither is an oversight:
 *
 *   - **The three modes (`save` / `balanced` / `push`) are not emitted.** Two
 *     of the three are defined by a lift-and-coast target, and `kLift` cannot
 *     be fitted — not for want of laps, but because drivers in the corpus do
 *     not lift on purpose, so there is no variation to fit against. §7 already
 *     requires the engine to refuse `save` until that exists. Offering three
 *     modes that are really one mode with three labels would be worse than
 *     offering one and saying why.
 *   - **Tyre degradation is accepted but rarely supplied.** The term is in the
 *     model because the fit will eventually resolve it; today one class-track
 *     pair in the whole corpus has it. Absent, it is zero, and `confidence`
 *     says so rather than pretending the stint is flat.
 *
 * What IS here is the thing §9 says is useful on its own: *you are on a
 * three-stop, the last one is lap 148, and you have 4 L in hand at the flag.*
 *
 * ## The one non-obvious piece of physics
 * A heavier car is slower. At an LMP2-ish `kFuel` of 0.03 s/L, a 75 L tank is
 * **2.3 s/lap** between brimmed and dry — more than most tyre degradation over
 * a stint. So an extra stop is not simply an extra pit loss: it also buys a
 * lighter average fuel load for the whole race. That trade-off is real, it goes
 * the other way at different circuits, and it is the entire reason this module
 * evaluates a stop count it does not strictly need rather than just dividing
 * fuel by tank size.
 *
 * Which also means: **without `kFuel` there is no trade-off to evaluate.** With
 * the term absent every plan of the same stop count costs the same, the extra
 * stop is pure loss, and the answer collapses to "take the minimum". That is
 * still a correct and useful answer — it is just a different question, and
 * `confidence` distinguishes them so a caller never mistakes one for the other.
 *
 * ## Refusals
 * Consistent with §11 and with `pitExit.ts`: this returns a plan or it returns
 * a reason, never a confident guess. No pace, no burn, no tank, or a race
 * length nobody knows — those are `whyNot`, not defaults.
 *
 * Pure: no clock, no network, no sim reads. Fed numbers, tested from synthetic
 * races whose right answer is known by construction.
 */

/** Everything the race-time model needs. Units are abstract: litres, or
 *  Virtual Energy percent on a tank of 100 — the model never cares which,
 *  which is why the same code serves LMP2 and LMGT3. */
export interface RaceStrategyInput {
  /** Racing laps to the flag. Whole laps; see `lapsToFlag.ts` for the hard part. */
  raceLaps: number;
  /** Clean lap time on a nominal fuel load, seconds. */
  basePaceSec: number;
  /** Consumption per racing lap, in tank units. */
  burnPerLap: number;
  /** Usable tank, in the same units. 100 for a Virtual Energy class. */
  capacity: number;

  /** Seconds per lap per unit of fuel carried. Absent = no load penalty modelled. */
  kFuelSecPerUnit?: number | null;
  /** Linear tyre loss, seconds per lap of stint age. Absent = flat stint. */
  tyreLinSecPerLap?: number | null;
  /** Stint lap past which `tyreCliffSecPerLap` also applies. */
  tyreCliffLap?: number | null;
  /** Additional seconds per lap beyond the cliff. */
  tyreCliffSecPerLap?: number | null;

  /** Time lost in the lane against staying out, EXCLUDING service. */
  pitLaneLossSec: number;
  /** Refuelling rate, tank units per second. */
  refuelRatePerSec: number;
  /** Seconds for a set of tyres, added on top (LMU services sequentially). */
  tyreChangeSec?: number;
  /** Fit tyres every N stops; 0 never. */
  tyresEveryStints?: number;

  /** Units carried to the flag beyond the plan's need. */
  safetyUnits?: number;
  /** The formation lap burns from stint one's tank without being a racing lap. */
  formationLap?: boolean;

  /** How much of the model rests on measurement rather than estimate. */
  confidence?: StrategyConfidence;
}

export interface StrategyConfidence {
  burn?: Provenance;
  kFuel?: Provenance;
  tyre?: Provenance;
  pit?: Provenance;
  refuel?: Provenance;
}

export type Provenance = 'measured' | 'partial' | 'none';

export interface StrategyStint {
  /** 1-based. */
  index: number;
  laps: number;
  /** Units put in at the start of this stint. */
  fill: number;
  /** Racing lap this stint ends on; null for the last. */
  endsOnLap: number | null;
}

export interface StrategyStop {
  /** The racing lap you come in at the end of. */
  onLap: number;
  refuelSec: number;
  tyreSec: number;
  laneSec: number;
  totalSec: number;
}

export interface StrategyPlan {
  stops: number;
  stopLaps: number[];
  stints: StrategyStint[];
  stopDetail: StrategyStop[];
  /** Predicted race time: lap times plus every pit loss. */
  totalTimeSec: number;
  /** Against the recommended plan. Positive is slower. */
  deltaSec: number;
  /** Units still in the tank at the flag, on top of the safety margin. */
  fuelMarginUnits: number;
  /** Mean fuel carried across the race — why an extra stop can pay. */
  meanLoadUnits: number;
  /** Only ever `liftTargetPerLap: 0` in Phase 1; kept explicit so a future
   *  lift-aware plan is distinguishable from a flat-out one at a glance. */
  liftTargetPerLap: 0;
}

export interface StrategyState {
  /** Ranked, fastest first. Empty when the inputs cannot support a plan. */
  plans: StrategyPlan[];
  /** Index into `plans`. -1 when there are none. */
  recommended: number;
  /** How much of the answer is measured rather than estimated. */
  confidence: Provenance;
  /** Why there is no plan, or why the plan is weaker than it looks. Never
   *  decoration: a blank widget that is being honest must be distinguishable
   *  from a blank widget that is broken. */
  whyNot?: string;
  /** Why the save/balanced/push triple is not offered yet. */
  modesWhyNot: string;
}

const MODES_WHY_NOT =
  'Fuel-save and push targets need a measured lift-and-coast penalty, and nobody '
  + 'in the shared corpus lifts on purpose — so there is nothing to fit it against. '
  + 'Until there is, every plan here is flat out.';

/** Worst provenance wins: a chain is only as measured as its weakest link. */
function weakest(...values: (Provenance | undefined)[]): Provenance {
  let out: Provenance = 'measured';
  for (const v of values) {
    if (v === 'none') return 'none';
    if (v === 'partial') out = 'partial';
    else if (v === undefined) out = out === 'measured' ? 'partial' : out;
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Lap time at a given fuel load and stint age.
 *
 * Every term beyond `basePaceSec` is optional, and an absent term contributes
 * zero rather than a plausible-looking default. A model that invents its own
 * coefficients produces a confident plan nobody can check.
 */
function lapTimeAt(input: RaceStrategyInput, loadUnits: number, stintLap: number): number {
  let t = input.basePaceSec;
  if (input.kFuelSecPerUnit) t += input.kFuelSecPerUnit * loadUnits;
  if (input.tyreLinSecPerLap) t += input.tyreLinSecPerLap * stintLap;
  if (input.tyreCliffLap && input.tyreCliffSecPerLap && stintLap > input.tyreCliffLap) {
    t += input.tyreCliffSecPerLap * (stintLap - input.tyreCliffLap);
  }
  return t;
}

/**
 * Cost one stop.
 *
 * LMU services sequentially — refuelling and tyres do not overlap — so a stop
 * is lane loss PLUS refuel PLUS tyres, never the maximum of them. That rule is
 * already encoded in the Fuel tab's engine and is repeated here rather than
 * shared, because this module must stay free of the panel.
 */
function stopCost(input: RaceStrategyInput, fill: number, stopNumber: number): StrategyStop {
  const refuelSec = input.refuelRatePerSec > 0 ? fill / input.refuelRatePerSec : 0;
  const every = input.tyresEveryStints ?? 1;
  const tyreSec = every > 0 && stopNumber % every === 0 ? (input.tyreChangeSec ?? 0) : 0;
  return {
    onLap: 0,
    refuelSec: round1(refuelSec),
    tyreSec: round1(tyreSec),
    laneSec: round1(input.pitLaneLossSec),
    totalSec: round1(input.pitLaneLossSec + refuelSec + tyreSec),
  };
}

/**
 * Evaluate one concrete plan: these stint lengths, in this order.
 *
 * Returns null when the plan is not drivable — a stint that needs more fuel
 * than the tank holds is not a slow plan, it is not a plan.
 */
function evaluate(input: RaceStrategyInput, stintLaps: number[]): StrategyPlan | null {
  const {
    capacity, burnPerLap, raceLaps,
    safetyUnits = 0, formationLap = false,
  } = input;

  const stints: StrategyStint[] = [];
  const stopDetail: StrategyStop[] = [];
  const stopLaps: number[] = [];
  let totalTimeSec = 0;
  let loadIntegral = 0;
  let lapsDone = 0;

  for (let i = 0; i < stintLaps.length; i += 1) {
    const laps = stintLaps[i];
    const isLast = i === stintLaps.length - 1;
    if (laps == null || laps < 1) return null;

    // The formation lap burns from stint one's tank but is not a racing lap,
    // so it costs range without ever appearing in the lap count.
    const formationUnits = i === 0 && formationLap ? burnPerLap : 0;
    const need = laps * burnPerLap + formationUnits + (isLast ? safetyUnits : 0);
    if (need > capacity + 1e-9) return null;
    const fill = need;

    // Walk the stint lap by lap: the fuel load falls as it goes, which is the
    // whole point — averaging the load would hide the effect being modelled.
    let load = fill - formationUnits;
    for (let n = 1; n <= laps; n += 1) {
      totalTimeSec += lapTimeAt(input, load, n);
      loadIntegral += load;
      load -= burnPerLap;
    }

    lapsDone += laps;
    stints.push({
      index: i + 1,
      laps,
      fill: round1(fill),
      endsOnLap: isLast ? null : lapsDone,
    });

    if (!isLast) {
      // Charge the stop for the fuel the NEXT stint takes on.
      const nextIsLast = i + 1 === stintLaps.length - 1;
      const nextLaps = stintLaps[i + 1] ?? 0;
      const nextNeed = nextLaps * burnPerLap + (nextIsLast ? safetyUnits : 0);
      const stop = stopCost(input, Math.min(nextNeed, capacity), i + 1);
      stop.onLap = lapsDone;
      totalTimeSec += stop.totalSec;
      stopDetail.push(stop);
      stopLaps.push(lapsDone);
    }
  }

  if (lapsDone !== raceLaps) return null;

  const totalBurn = raceLaps * burnPerLap + (formationLap ? burnPerLap : 0);
  const totalFilled = stints.reduce((sum, s) => sum + s.fill, 0);

  return {
    stops: stintLaps.length - 1,
    stopLaps,
    stints,
    stopDetail,
    totalTimeSec: round2(totalTimeSec),
    deltaSec: 0,
    fuelMarginUnits: round2(totalFilled - totalBurn),
    meanLoadUnits: round1(loadIntegral / Math.max(1, raceLaps)),
    liftTargetPerLap: 0,
  };
}

/**
 * Every way to split `raceLaps` into `stintCount` stints.
 *
 * §5 says brute force, and it is right: the feasible window is narrow because
 * a stint can be no longer than the tank allows, and stints within one plan
 * differ by at most one lap once the total is fixed. So rather than enumerating
 * hundreds of arbitrary splits, enumerate the ones that are actually different:
 * how many stints carry the extra lap, and whether the long ones come first
 * (fill to the brim, short final stint) or last (save the range for the end).
 *
 * That is a handful of candidates per stop count instead of hundreds, and it
 * contains the optimum, because with a monotonic load penalty the best split is
 * always one of the maximally-even or maximally-front-loaded arrangements.
 */
function splits(raceLaps: number, stintCount: number, maxStintLaps: number): number[][] {
  if (stintCount < 1) return [];
  if (stintCount * maxStintLaps < raceLaps) return [];

  const out: number[][] = [];
  const base = Math.floor(raceLaps / stintCount);
  const extra = raceLaps - base * stintCount;

  // Even, with the spare laps at the front, then at the back.
  if (base >= 1) {
    const front: number[] = [];
    const back: number[] = [];
    for (let i = 0; i < stintCount; i += 1) {
      front.push(base + (i < extra ? 1 : 0));
      back.push(base + (i >= stintCount - extra ? 1 : 0));
    }
    out.push(front);
    if (extra > 0) out.push(back);
  }

  // Fill to max each time, short final stint — the classic, and often quickest
  // when the load penalty is small because it minimises fuel carried early.
  const maxFirst: number[] = [];
  let left = raceLaps;
  for (let i = 0; i < stintCount; i += 1) {
    const take = Math.min(maxStintLaps, Math.max(1, left - (stintCount - i - 1)));
    maxFirst.push(take);
    left -= take;
  }
  if (left === 0) out.push(maxFirst);

  // The mirror: short opening stint, full tanks later. Cheapest early laps.
  const maxLast = [...maxFirst].reverse();
  if (maxLast.reduce((a, b) => a + b, 0) === raceLaps) out.push(maxLast);

  // De-duplicate — the arrangements collide whenever the laps divide evenly.
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = s.join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return s.every((n) => n >= 1 && n <= maxStintLaps);
  });
}

/**
 * Plan a race from the grid.
 *
 * Returns a `StrategyState` always — with plans when it can build them, and
 * with `whyNot` when it cannot. It never returns a plan built on a substituted
 * default: that is the failure mode the whole design document is written
 * against, because it gets believed on the lap it is wrong.
 */
export function planRace(input: RaceStrategyInput): StrategyState {
  const empty = (whyNot: string): StrategyState => ({
    plans: [], recommended: -1, confidence: 'none', whyNot, modesWhyNot: MODES_WHY_NOT,
  });

  const { raceLaps, basePaceSec, burnPerLap, capacity } = input;
  if (!Number.isFinite(raceLaps) || raceLaps < 1) return empty('race length is not known yet');
  if (!Number.isFinite(basePaceSec) || basePaceSec <= 0) return empty('no lap time to plan against');
  if (!Number.isFinite(burnPerLap) || burnPerLap <= 0) return empty('no fuel consumption measured yet');
  if (!Number.isFinite(capacity) || capacity <= 0) return empty('tank size is not known');
  if (!Number.isFinite(input.pitLaneLossSec) || !Number.isFinite(input.refuelRatePerSec)) {
    return empty('no pit loss to price a stop with');
  }

  const safetyUnits = input.safetyUnits ?? 0;
  const maxStintLaps = Math.floor(capacity / burnPerLap);
  if (maxStintLaps < 1) return empty('a full tank does not cover a single lap');

  // The minimum is set by range, and the extra stop is the candidate worth
  // testing because a lighter average car can pay for its own pit loss.
  const effectiveLaps = raceLaps + (input.formationLap ? 1 : 0);
  const minStints = Math.max(1, Math.ceil(effectiveLaps / maxStintLaps));

  const plans: StrategyPlan[] = [];
  for (const stintCount of [minStints, minStints + 1]) {
    for (const split of splits(raceLaps, stintCount, maxStintLaps)) {
      const plan = evaluate({ ...input, safetyUnits }, split);
      if (plan) plans.push(plan);
    }
  }
  if (!plans.length) return empty('no stop plan fits this tank over this distance');

  // Rank, then keep the best plan per stop count: two splits of the same stop
  // count are the same STRATEGY, and offering both as choices would be noise.
  plans.sort((a, b) => a.totalTimeSec - b.totalTimeSec);
  const bestPerStopCount = new Map<number, StrategyPlan>();
  for (const p of plans) if (!bestPerStopCount.has(p.stops)) bestPerStopCount.set(p.stops, p);
  const ranked = [...bestPerStopCount.values()].sort((a, b) => a.totalTimeSec - b.totalTimeSec);

  const best = ranked[0];
  if (!best) return empty('no stop plan fits this tank over this distance');
  for (const p of ranked) p.deltaSec = round2(p.totalTimeSec - best.totalTimeSec);

  const c = input.confidence ?? {};
  const confidence = weakest(c.burn, c.pit, c.refuel);

  // Say what the plan cannot see. An extra stop's whole case rests on carrying
  // less fuel, so without kFuel the comparison between stop counts is not a
  // comparison at all — the caller needs to know that before trusting a delta.
  let whyNot: string | undefined;
  if (!input.kFuelSecPerUnit) {
    whyNot = ranked.length > 1
      ? 'No measured fuel-load penalty for this car and track, so an extra stop '
        + 'is priced as pure time lost. The real cost of carrying fuel is not in these numbers.'
      : 'No measured fuel-load penalty for this car and track, so lap times here '
        + 'do not change with fuel load.';
  }

  return {
    plans: ranked,
    recommended: 0,
    confidence,
    whyNot,
    modesWhyNot: MODES_WHY_NOT,
  };
}

export const __testing = { splits, evaluate, lapTimeAt, stopCost, weakest };
