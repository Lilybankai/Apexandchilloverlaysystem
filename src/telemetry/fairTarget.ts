/**
 * fairTarget.ts — is a comparison lap a fair one to chase?
 * =============================================================================
 *
 * 2026-10-29, Carl: comparison laps "that are fair, or flagged when they
 * aren't". A board lap 1.2 s quicker than yours is not 1.2 s of driving if it
 * was set in qualifying on ten litres, on a track 12 °C cooler, in another car
 * of the class. This module looks at what is known about two laps — the
 * driver's own and a candidate (usually a leaderboard row) — and says, in
 * short chip-sized words, what makes the comparison unfair and, where it can
 * be estimated, how much of the gap that explains.
 *
 * ## The rules
 * Hard (severity `drop` — shown, never picked automatically):
 *   - same CLASS (a different class is a different car with a different pace);
 *   - same SURFACE band (`dry` / `damp` / `wet`, `lapLog.conditionOf`);
 *   - a CLEAN lap (board laps always are; a local one may not be).
 *
 * Soft:
 *   - car: a different car in the same class → `warn` "different car (BoP)",
 *     when both models can be told ({@link carModelOf}).
 *   - fuel: seconds from the litres between the two laps (below). `warn` when
 *     the estimate is over {@link FUEL_WARN_SEC} or over {@link FUEL_WARN_SHARE}
 *     of the gap. A QUALIFYING lap with no fuel recorded → `info` (kind
 *     `session`) "likely low fuel, fresh tyres" — 144 of the board's 155
 *     qualifying rows carry no fuel (2026-10-29), so this is the common case.
 *   - track temperature: ≤ 5 °C apart is fine; 5–10 °C `warn`; > 10 °C `drop`.
 *   - air temperature: > 5 °C apart `warn`.
 *   - compound: both known and different → `warn`.
 *   - energy: the candidate began the lap on little virtual energy → `info`.
 *   - tow: no data says whether a board lap had one; never raised here (the
 *     time-loss engine flags straight-line gaps per corner instead).
 *
 * A side that did not record a value raises nothing for it: "not recorded" is
 * not evidence of unfairness, and only ~6% of board rows carry fuel at all.
 *
 * ## Fuel, and why most of it is an estimate
 * Seconds per litre come from a PHYSICS PRIOR unless the strategy fit has a
 * solid number for the track and class:
 *
 *     sec/L ≈ {@link FUEL_SEC_PER_KG_PER_100S} × {@link FUEL_KG_PER_L} × lapSec / 100
 *
 * ≈0.035 s per kg per 100 s of lap, and petrol at ≈0.74 kg/L. BOTH ARE
 * UNVERIFIED rules of thumb (a common sim-racing figure, not measured in LMU),
 * so every fuel chip says "≈". The fitted `kFuelSecPerL` in
 * `data/strategy-coefficients.json` (fuel-coefficients.js) is too noisy to use
 * wholesale — 0.003 to 0.19 s/L across pairs, with t-statistics above 4 on
 * values three times the prior (Road Atlanta LMP2 0.059, Le Mans LMP3 0.186).
 * Only a fit that is significant (t ≥ 3.5) AND agrees with the prior to
 * within ×0.75–×1.5 is used; on the 2026-10-06 fit that is Daytona LMP2
 * (0.0305 s/L, t 3.92, prior 0.026) and Fuji GT3 (0.0228 s/L, t 6.42, 8
 * drivers, prior 0.027) — {@link SOLID_FUEL_SEC_PER_L}.
 *
 * Worth knowing: the three other significant GT3 fits (Monza t 6.0, Road
 * Atlanta t 5.9, Daytona t 3.7) all sit at ≈0.45× the prior. Either the prior
 * overstates fuel for GT3 by about two, or those fits are pulled down by fuel
 * and tyre age moving together (collinearity 0.57–0.77). Until that is
 * settled the prior is used, which can only over-explain a gap — the safe
 * direction for a chip that says "this part is not your driving".
 *
 * Signs: the GAP is `me.lapSec − cand.lapSec` (positive = the candidate is
 * quicker, the thing being chased). `fuelSec` and a fuel flag's `estSec` are
 * the part of that gap fuel explains: positive when the DRIVER carried more.
 *
 * Pure: no fs, no Electron, no clock.
 */

import type { FairnessFlag } from './coachContract';

/** What is known about a lap: the driver's own, or a leaderboard candidate. */
export interface TargetLapInfo {
  lapId: string;
  driver?: string;
  car: string;
  carClass: string;
  lapSec: number;
  sessionType?: string | null;
  trackTempC?: number | null;
  airTempC?: number | null;
  fuelStartL?: number | null;
  fuelCapacityL?: number | null;
  vePct?: number | null;
  compound?: string | null;
  condition?: string | null;
  hasLine?: boolean;
  /** ADDED (fair): `false` = a lap the stewards would not count. Absent = clean (board laps always are). */
  clean?: boolean;
  /** ADDED (fair): the lap log's track key, so a solid fitted fuel coefficient can be found. */
  trackKey?: string | null;
  /** ADDED (fair): a trace exists to compare against (board `has_trace`). Absent = unknown. */
  hasTrace?: boolean;
}

export interface TargetAssessment {
  flags: FairnessFlag[];
  /** Estimated seconds of the gap that fuel explains; null when it cannot be estimated. */
  fuelSec: number | null;
  /** Lower is fairer. */
  score: number;
}

/* -------------------------------------------------------------------------- */
/*  Thresholds                                                                */
/* -------------------------------------------------------------------------- */

/** UNVERIFIED rule of thumb: seconds per kg of fuel per 100 s of lap time. */
export const FUEL_SEC_PER_KG_PER_100S = 0.035;
/** UNVERIFIED: petrol density, kg per litre. */
export const FUEL_KG_PER_L = 0.74;
/** A fuel estimate above this many seconds is a chip. */
export const FUEL_WARN_SEC = 0.15;
/** ...or above this share of the gap — */
export const FUEL_WARN_SHARE = 0.25;
/** — but never for less than this: "≈0.02 s is fuel" on a 0.05 s gap is noise, not unfairness. */
export const FUEL_SHARE_FLOOR_SEC = 0.05;
/** Track temperature apart: at most this is fine… */
export const TRACK_TEMP_OK_C = 5;
/** …up to this is a warning, beyond it the lap is not picked. */
export const TRACK_TEMP_DROP_C = 10;
/** Air temperature apart beyond this is a warning. */
export const AIR_TEMP_WARN_C = 5;
/** A candidate that began on less virtual energy than this (%) gets an info chip… */
export const VE_LOW_PCT = 50;
/** …unless the driver's own lap began within this many points of it. */
export const VE_LOW_MARGIN_PCT = 15;
/** The ideal target is this much quicker than the driver's lap (fraction of their time). */
export const PICK_BAND: readonly [number, number] = [0.005, 0.015];

/**
 * Fitted seconds per litre that are solid enough to use instead of the prior,
 * keyed `trackKey|CLASS`. See the header for the rule; on the 2026-10-06 fit
 * (`data/strategy-coefficients.json`) two pairs pass it:
 *   - Daytona LMP2: 54 laps, 2 drivers, t = 3.92, prior ≈0.026 s/L;
 *   - Fuji GT3:    281 laps, 8 drivers, t = 6.42, prior ≈0.027 s/L.
 */
export const SOLID_FUEL_SEC_PER_L: Readonly<Record<string, number>> = {
  'daytona-international-speedway-road-course_5734|LMP2': 0.03046,
  'fuji-speedway_4536|GT3': 0.02281,
};

const SEVERITY_WEIGHT: Record<FairnessFlag['severity'], number> = { info: 1, warn: 10, drop: 100 };

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function fin(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function norm(s: unknown): string {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/** "0.4", "0.08" — one decimal at a tenth and above, two below. */
function secText(s: number): string {
  const a = Math.abs(s);
  return a >= 0.095 ? a.toFixed(1) : a.toFixed(2);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * The car MODEL a lap-log / board `car` string names, lower-cased, or null
 * when it cannot be told. The string is LMU's vehicle (livery) name:
 *
 *   "BMW GT3 Custom Team 2026 #397"   → "bmw gt3"   (a custom livery: the
 *   "Oreca 07 Custom Team 2025 #397"  → "oreca 07"   model is what precedes
 *   "911GT3R ELMS Custom Team 2026"   → "911gt3r elms"   "Custom Team")
 *   "Team WRT 2026 #32:WEC"           → null        (a team's livery: which
 *                                                    car is not in the name)
 *
 * The year and the number are not the car: the same model's 2025 and 2026
 * liveries compare equal. Measured 2026-10-29: 18 distinct strings on the GT3
 * board alone, most of them liveries of the same few cars — comparing the raw
 * strings would call nearly every board lap a different car.
 */
export function carModelOf(car: unknown): string | null {
  if (typeof car !== 'string') return null;
  const m = /^(.*?)\s+custom\s+team\b/i.exec(car.trim());
  if (!m) return null;
  const model = m[1]!.replace(/\s+/g, ' ').trim().toLowerCase();
  return model || null;
}

/**
 * Seconds per litre for a lap of `lapSec` at `trackKey` in `carClass`: the
 * solid fit when there is one, else the physics prior. `null` without a lap time.
 */
export function fuelSecPerL(trackKey: string | null | undefined, carClass: string, lapSec: number): number | null {
  const solid = trackKey ? SOLID_FUEL_SEC_PER_L[`${trackKey}|${String(carClass || '').trim().toUpperCase()}`] : undefined;
  if (fin(solid)) return solid;
  if (!fin(lapSec) || lapSec <= 0) return null;
  return (FUEL_SEC_PER_KG_PER_100S * FUEL_KG_PER_L * lapSec) / 100;
}

/* -------------------------------------------------------------------------- */
/*  Assessment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What makes `cand` an unfair lap for `me` to chase. Flags come in a fixed
 * order (hard rules first), and `score` adds 100 per `drop`, 10 per `warn`
 * and 1 per `info` — so fewer and milder flags always rank fairer.
 */
export function assessTarget(me: TargetLapInfo, cand: TargetLapInfo): TargetAssessment {
  const flags: FairnessFlag[] = [];
  const gap = fin(me.lapSec) && fin(cand.lapSec) && me.lapSec > 0 && cand.lapSec > 0 ? me.lapSec - cand.lapSec : null;

  // ---- hard rules ----
  const myClass = norm(me.carClass);
  const theirClass = norm(cand.carClass);
  if (myClass && theirClass && myClass !== theirClass) {
    flags.push({ kind: 'car', severity: 'drop', text: `different class (${String(cand.carClass).trim()})` });
  }
  const myCond = norm(me.condition);
  const theirCond = norm(cand.condition);
  if (myCond && theirCond && myCond !== theirCond) {
    flags.push({ kind: 'condition', severity: 'drop', text: `${theirCond} track, yours ${myCond}` });
  }
  if (cand.clean === false) {
    flags.push({ kind: 'session', severity: 'drop', text: 'not a clean lap' });
  }

  // ---- car ----
  // Only when both models are KNOWN: an official livery names the team, not
  // the car, and "Team WRT" vs "BMW GT3" may well be the same car.
  const myModel = carModelOf(me.car);
  const theirModel = carModelOf(cand.car);
  if (myModel && theirModel && myModel !== theirModel && !(myClass && theirClass && myClass !== theirClass)) {
    flags.push({ kind: 'car', severity: 'warn', text: 'different car (BoP)' });
  }

  // ---- fuel ----
  let fuelSec: number | null = null;
  const myFuel = fin(me.fuelStartL) && me.fuelStartL > 0 ? me.fuelStartL : null;
  const theirFuel = fin(cand.fuelStartL) && cand.fuelStartL > 0 ? cand.fuelStartL : null;
  if (myFuel !== null && theirFuel !== null) {
    const k = fuelSecPerL(cand.trackKey || me.trackKey, cand.carClass || me.carClass, cand.lapSec > 0 ? cand.lapSec : me.lapSec);
    if (k !== null) {
      fuelSec = round3((myFuel - theirFuel) * k);
      const a = Math.abs(fuelSec);
      const share = gap !== null && Math.abs(gap) > 0 ? a / Math.abs(gap) : 0;
      if (a > FUEL_WARN_SEC || (a >= FUEL_SHARE_FLOOR_SEC && share > FUEL_WARN_SHARE)) {
        const litres = Math.round(Math.abs(myFuel - theirFuel));
        flags.push({
          kind: 'fuel',
          severity: 'warn',
          text: fuelSec > 0
            ? `≈${secText(fuelSec)} s of the gap is fuel (${litres} L)`
            : `they ran ≈${litres} L heavier (≈${secText(fuelSec)} s)`,
          estSec: fuelSec,
        });
      }
    }
  } else if (theirFuel === null && norm(cand.sessionType) === 'qualifying') {
    flags.push({ kind: 'session', severity: 'info', text: 'likely low fuel, fresh tyres' });
  }

  // ---- temperatures ----
  if (fin(me.trackTempC) && fin(cand.trackTempC)) {
    const d = cand.trackTempC - me.trackTempC;
    const a = Math.abs(d);
    if (a > TRACK_TEMP_OK_C) {
      flags.push({
        kind: 'trackTemp',
        severity: a > TRACK_TEMP_DROP_C ? 'drop' : 'warn',
        text: `track ${Math.round(a)} °C ${d > 0 ? 'hotter' : 'cooler'}`,
      });
    }
  }
  if (fin(me.airTempC) && fin(cand.airTempC)) {
    const d = cand.airTempC - me.airTempC;
    if (Math.abs(d) > AIR_TEMP_WARN_C) {
      flags.push({ kind: 'airTemp', severity: 'warn', text: `air ${Math.round(Math.abs(d))} °C ${d > 0 ? 'hotter' : 'cooler'}` });
    }
  }

  // ---- tyres ----
  const myTyre = norm(me.compound);
  const theirTyre = norm(cand.compound);
  if (myTyre && theirTyre && myTyre !== theirTyre) {
    flags.push({ kind: 'compound', severity: 'warn', text: `on ${String(cand.compound).trim()} tyres` });
  }

  // ---- virtual energy ----
  if (fin(cand.vePct) && cand.vePct > 0 && cand.vePct < VE_LOW_PCT) {
    const mineVe = fin(me.vePct) && me.vePct > 0 ? me.vePct : null;
    if (mineVe === null || mineVe - cand.vePct >= VE_LOW_MARGIN_PCT) {
      flags.push({ kind: 'energy', severity: 'info', text: `low energy start (${Math.round(cand.vePct)}%)` });
    }
  }

  const score = flags.reduce((s, f) => s + SEVERITY_WEIGHT[f.severity], 0);
  return { flags, fuelSec, score };
}

/* -------------------------------------------------------------------------- */
/*  Picking                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How well a candidate's pace suits as a target: 0 = 0.5–1.5% quicker than
 * mine (the band worth chasing), 1 = quicker still, 2 = under 0.5% quicker,
 * 3 = not quicker at all (or unknown).
 */
function paceBand(me: TargetLapInfo, cand: TargetLapInfo): number {
  if (!(fin(me.lapSec) && me.lapSec > 0 && fin(cand.lapSec) && cand.lapSec > 0)) return 3;
  const share = (me.lapSec - cand.lapSec) / me.lapSec;
  if (share <= 0) return 3;
  if (share < PICK_BAND[0]) return 2;
  if (share <= PICK_BAND[1]) return 0;
  return 1;
}

/**
 * Every candidate assessed and ranked fairest-first, and the one to chase.
 *
 * Ranked by `score` (fewest, mildest flags), then by pace: a lap 0.5–1.5%
 * quicker than mine beats one far quicker, which beats one barely quicker; a
 * slower lap comes last. Within a band, the lap nearest 1% quicker first.
 *
 * The pick is the top of that list that is QUICKER than mine and carries no
 * `drop` flag — `null` when nothing qualifies (chasing a slower lap teaches
 * nothing). A candidate known to have no trace (`hasTrace === false`) is
 * never the pick: there would be nothing to measure against.
 */
export function pickFairTarget(
  me: TargetLapInfo,
  cands: readonly TargetLapInfo[],
): { pick: TargetLapInfo | null; ranked: { lap: TargetLapInfo; assessment: TargetAssessment }[] } {
  const mid = (PICK_BAND[0] + PICK_BAND[1]) / 2;
  const scored = cands.map((lap, i) => {
    const assessment = assessTarget(me, lap);
    const band = paceBand(me, lap);
    const share = fin(me.lapSec) && me.lapSec > 0 && fin(lap.lapSec) ? (me.lapSec - lap.lapSec) / me.lapSec : 0;
    return { lap, assessment, band, dist: Math.abs(share - mid), i };
  });
  scored.sort(
    (a, b) =>
      a.assessment.score - b.assessment.score ||
      a.band - b.band ||
      a.dist - b.dist ||
      a.lap.lapSec - b.lap.lapSec ||
      a.i - b.i,
  );
  const ranked = scored.map(({ lap, assessment }) => ({ lap, assessment }));
  const top = scored.find(
    (s) => s.band !== 3 && s.lap.hasTrace !== false && !s.assessment.flags.some((f) => f.severity === 'drop'),
  );
  return { pick: top ? top.lap : null, ranked };
}
