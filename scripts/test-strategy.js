/**
 * test-strategy.js — the race-time model, on races whose answer is known.
 * -----------------------------------------------------------------------------
 * src/telemetry/raceStrategy.ts is a planner, so the useful tests are the ones
 * where arithmetic alone says what the plan must be, and the ones that catch it
 * being confidently wrong:
 *
 *   - a race that fits in one tank must not invent a stop
 *   - a plan must never exceed the tank, at any stint, ever
 *   - the predicted race time must equal lap times plus pit losses, summed by
 *     hand — a model whose own total disagrees with its own parts is useless
 *   - with a fuel-load penalty, an extra stop must WIN where the arithmetic
 *     says it wins, and lose where it loses; the whole reason the module
 *     evaluates a stop count it does not need
 *   - and every refusal must be a refusal, not a default
 *
 * Run: node scripts/test-strategy.js  (needs `npm run build` first)
 */

'use strict';

const path = require('path');

const S = require(path.join(__dirname, '..', 'dist', 'telemetry', 'raceStrategy.js'));

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); return; }
  failed += 1;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  (got: ${JSON.stringify(detail)})`}`);
}
function section(t) { console.log(`\n${t}`); }

/** A plain litre-class race: 100 s laps, 3 L/lap, 90 L tank = 30 laps of range. */
const BASE = {
  raceLaps: 30,
  basePaceSec: 100,
  burnPerLap: 3,
  capacity: 90,
  pitLaneLossSec: 25,
  refuelRatePerSec: 2.5,
  tyreChangeSec: 0,
  tyresEveryStints: 0,
};

// ── No stop where no stop is needed ────────────────────────────────────────
section('A race that fits in one tank');
{
  const st = S.planRace(BASE);
  check('a plan comes back', st.plans.length > 0, st.whyNot);
  const best = st.plans[st.recommended];
  check('it does not invent a stop', best.stops === 0, best.stops);
  check('one stint, the whole race', best.stints.length === 1 && best.stints[0].laps === 30,
    best.stints.map((s) => s.laps));
  check('race time is exactly 30 clean laps', best.totalTimeSec === 3000, best.totalTimeSec);
  check('no pit time is charged', best.stopDetail.length === 0);
  check('the flag arrives with the tank dry, not in deficit', best.fuelMarginUnits === 0,
    best.fuelMarginUnits);
}

// ── The tank is a hard wall ────────────────────────────────────────────────
section('The tank is never exceeded');
{
  for (const raceLaps of [31, 45, 60, 61, 100, 137]) {
    const st = S.planRace({ ...BASE, raceLaps });
    const bad = st.plans.filter((p) => p.stints.some((s) => s.fill > BASE.capacity + 1e-9));
    check(`${raceLaps} laps: no stint is filled past the tank`, bad.length === 0,
      bad.map((p) => p.stints.map((s) => s.fill)));
    const lapsWrong = st.plans.filter(
      (p) => p.stints.reduce((sum, s) => sum + s.laps, 0) !== raceLaps,
    );
    check(`${raceLaps} laps: every plan runs exactly the race distance`, lapsWrong.length === 0);
  }
}

// ── The model agrees with itself ───────────────────────────────────────────
section('Predicted time equals its own parts');
{
  const st = S.planRace({ ...BASE, raceLaps: 60, safetyUnits: 0 });
  const best = st.plans[st.recommended];
  const pit = best.stopDetail.reduce((sum, s) => sum + s.totalSec, 0);
  // No load penalty and no tyre term here, so every lap is basePace exactly.
  const laps = 60 * BASE.basePaceSec;
  check('total = laps + pit losses', Math.abs(best.totalTimeSec - (laps + pit)) < 0.05,
    { total: best.totalTimeSec, laps, pit });
  check('one stop is enough for 60 laps on 30 laps of range', best.stops === 1, best.stops);
  check('the stop is charged the lane plus the refuel',
    Math.abs(best.stopDetail[0].totalSec
      - (BASE.pitLaneLossSec + best.stopDetail[0].refuelSec)) < 0.15,
    best.stopDetail[0]);
}

// ── Sequential service, not parallel ───────────────────────────────────────
section('LMU services sequentially');
{
  const st = S.planRace({ ...BASE, raceLaps: 60, tyreChangeSec: 30, tyresEveryStints: 1 });
  const stop = st.plans[st.recommended].stopDetail[0];
  check('tyres are ADDED to the refuel, never maxed with it',
    Math.abs(stop.totalSec - (stop.laneSec + stop.refuelSec + stop.tyreSec)) < 0.05, stop);
  check('the tyre time is actually charged', stop.tyreSec === 30, stop.tyreSec);

  const never = S.planRace({ ...BASE, raceLaps: 60, tyreChangeSec: 30, tyresEveryStints: 0 });
  check('tyresEveryStints 0 means no tyre time at all',
    never.plans[never.recommended].stopDetail[0].tyreSec === 0);
}

// ── The fuel-load trade-off, the point of the module ───────────────────────
section('An extra stop can pay for itself');
{
  // Hand-built so the answer is not in doubt. 60 laps, 30 laps of range, so
  // one stop is the minimum. A big load penalty makes two stops (lighter
  // average car) worth more than the extra ~55 s of pit loss.
  const heavy = {
    ...BASE, raceLaps: 60, kFuelSecPerUnit: 0.06, tyreChangeSec: 0, tyresEveryStints: 0,
  };
  const st = S.planRace(heavy);
  check('both stop counts are offered', st.plans.length >= 2, st.plans.map((p) => p.stops));
  const one = st.plans.find((p) => p.stops === 1);
  const two = st.plans.find((p) => p.stops === 2);
  check('the two-stop carries less fuel on average', two.meanLoadUnits < one.meanLoadUnits,
    { one: one.meanLoadUnits, two: two.meanLoadUnits });
  check('and with a big load penalty it is the quicker plan', two.totalTimeSec < one.totalTimeSec,
    { one: one.totalTimeSec, two: two.totalTimeSec });
  check('so it is the one recommended', st.plans[st.recommended].stops === 2,
    st.plans[st.recommended].stops);

  // Same race, no load penalty: the extra stop is now pure loss.
  const flat = S.planRace({ ...heavy, kFuelSecPerUnit: 0 });
  check('with no load penalty the minimum stop count wins',
    flat.plans[flat.recommended].stops === 1, flat.plans[flat.recommended].stops);
  check('…and the engine says the comparison is not a real one',
    /fuel-load penalty/.test(flat.whyNot || ''), flat.whyNot);

  // And a small penalty must not flip it — the trade-off has to go both ways
  // or the module is just biased towards stopping.
  const light = S.planRace({ ...heavy, kFuelSecPerUnit: 0.005 });
  check('a small load penalty leaves the minimum stop count winning',
    light.plans[light.recommended].stops === 1, light.plans[light.recommended].stops);
}

// ── Deltas ─────────────────────────────────────────────────────────────────
section('Deltas are against the recommendation');
{
  const st = S.planRace({ ...BASE, raceLaps: 60, kFuelSecPerUnit: 0.06 });
  check('the recommended plan has a zero delta', st.plans[st.recommended].deltaSec === 0);
  check('every other plan is slower, never faster',
    st.plans.every((p, i) => i === st.recommended || p.deltaSec > 0),
    st.plans.map((p) => p.deltaSec));
  check('one plan per stop count — two splits of one strategy are not two choices',
    new Set(st.plans.map((p) => p.stops)).size === st.plans.length,
    st.plans.map((p) => p.stops));
}

// ── Safety margin and the formation lap ────────────────────────────────────
section('Margin and the formation lap');
{
  const st = S.planRace({ ...BASE, raceLaps: 28, safetyUnits: 6 });
  const best = st.plans[st.recommended];
  check('the margin is carried, not spent', best.fuelMarginUnits === 6, best.fuelMarginUnits);
  check('and it still fits the tank', best.stints.every((s) => s.fill <= BASE.capacity));

  // 30 laps of range, 30 racing laps, plus a formation lap = 31 laps of fuel.
  // That cannot be one stint, and the planner must not pretend it can.
  const form = S.planRace({ ...BASE, raceLaps: 30, formationLap: true });
  check('a formation lap that overflows the tank forces a stop',
    form.plans[form.recommended].stops >= 1, form.plans[form.recommended].stops);
  check('the opening stint pays for the formation lap out of its own range',
    form.plans[form.recommended].stints[0].laps < 30,
    form.plans[form.recommended].stints[0].laps);
}

// ── Refusals ───────────────────────────────────────────────────────────────
section('It refuses rather than guesses');
{
  const cases = [
    ['race length is not known', { raceLaps: 0 }, /race length/],
    ['no lap time', { basePaceSec: 0 }, /lap time/],
    ['no consumption', { burnPerLap: 0 }, /consumption/],
    ['no tank', { capacity: 0 }, /tank/],
    ['no pit loss', { pitLaneLossSec: NaN }, /pit loss/],
    ['no refuel rate', { refuelRatePerSec: NaN }, /pit loss/],
    ['a tank that will not cover a lap', { burnPerLap: 200 }, /single lap/],
  ];
  for (const [name, patch, re] of cases) {
    const st = S.planRace({ ...BASE, ...patch });
    check(`${name}: no plan`, st.plans.length === 0 && st.recommended === -1);
    check(`${name}: a reason instead`, re.test(st.whyNot || ''), st.whyNot);
    check(`${name}: confidence is none`, st.confidence === 'none', st.confidence);
  }
}

// ── The modes that are not offered ─────────────────────────────────────────
section('The three modes are refused, out loud');
{
  const st = S.planRace(BASE);
  check('every state explains why save/push are absent', !!st.modesWhyNot);
  check('…and blames the missing coefficient, not the driver',
    /lift/.test(st.modesWhyNot), st.modesWhyNot);
  check('every plan is flat out', st.plans.every((p) => p.liftTargetPerLap === 0));
}

// ── Confidence ─────────────────────────────────────────────────────────────
section('Confidence is the weakest link');
{
  const all = S.planRace({ ...BASE, confidence: { burn: 'measured', pit: 'measured', refuel: 'measured' } });
  check('all measured reads measured', all.confidence === 'measured', all.confidence);
  const one = S.planRace({ ...BASE, confidence: { burn: 'measured', pit: 'none', refuel: 'measured' } });
  check('one unmeasured input drags the whole answer to none', one.confidence === 'none', one.confidence);
  const part = S.planRace({ ...BASE, confidence: { burn: 'measured', pit: 'partial', refuel: 'measured' } });
  check('a partial input makes the answer partial', part.confidence === 'partial', part.confidence);
  const absent = S.planRace(BASE);
  check('saying nothing about confidence is not the same as claiming measured',
    absent.confidence !== 'measured', absent.confidence);
}

// ── A real Virtual Energy race, on the measured numbers ────────────────────
section('A real LMGT3 race on the shipped coefficients');
{
  const COEFFS = require(path.join(__dirname, '..', 'electron', 'control-panel', 'fuel-coefficients.js'));
  const monza = COEFFS.byPair['monza_gp|lmgt3'];
  const cls = COEFFS.byClass.lmgt3;
  check('the fixture is the real shipped data', !!monza && !!cls);

  // Virtual Energy: the tank is 100%, so burn converts at the class capacity.
  const burnPct = (monza.burnLPerLap / cls.capacityL) * 100;
  const st = S.planRace({
    raceLaps: 124,
    basePaceSec: 113.6,
    burnPerLap: burnPct,
    capacity: 100,
    kFuelSecPerUnit: monza.kFuelSecPerL ? monza.kFuelSecPerL * (cls.capacityL / 100) : null,
    pitLaneLossSec: 25,
    refuelRatePerSec: cls.refuelPerSec,
    tyreChangeSec: 30,
    tyresEveryStints: 1,
    safetyUnits: 2 * burnPct,
    confidence: { burn: 'measured', refuel: 'measured', pit: 'none' },
  });
  const best = st.plans[st.recommended];
  check('a four-hour Monza plan builds', !!best, st.whyNot);
  check('it is a three-stop, as the Fuel tab shows', best.stops === 3, best.stops);
  check('no stint exceeds the energy tank', best.stints.every((s) => s.fill <= 100));
  check('the stops are ordered and inside the race', best.stopLaps.every(
    (l, i) => l > 0 && l < 124 && (i === 0 || l > best.stopLaps[i - 1])), best.stopLaps);
  check('the pit loss is unmeasured, so the answer says none',
    st.confidence === 'none', st.confidence);
  // The point of the whole exercise: the measured rig is slower, so the plan
  // spends more time stationary than the old guess would have predicted.
  const guessed = S.planRace({
    raceLaps: 124, basePaceSec: 113.6, burnPerLap: burnPct, capacity: 100,
    pitLaneLossSec: 25, refuelRatePerSec: 2.0, tyreChangeSec: 30, tyresEveryStints: 1,
    safetyUnits: 2 * burnPct,
  });
  const pitOf = (s) => s.plans[s.recommended].stopDetail.reduce((a, b) => a + b.totalSec, 0);
  check('and it costs more pit time than the guessed rig did',
    pitOf(st) > pitOf(guessed) + 30, { measured: pitOf(st), guessed: pitOf(guessed) });
}

console.log(`\ntest-strategy: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
