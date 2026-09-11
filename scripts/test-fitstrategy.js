/**
 * scripts/test-fitstrategy.js — the strategy fitter, against races whose
 * coefficients are known in advance.
 * -----------------------------------------------------------------------------
 * A fitter cannot be checked against real laps: there is no ground truth to
 * compare with, and a regression will always return a number. So every case
 * here SYNTHESISES a race from coefficients this file chose, runs the fitter,
 * and asserts it recovered them. If the maths drifts, the recovered numbers
 * move away from the ones that generated the laps and the test says so.
 *
 * The silent bugs this exists for, in the order they would actually bite:
 *
 *  - **A confident, precise, wrong kFuel.** Inside a single stint the fuel
 *    falls as the stint lap rises, so the two predictors are one column and
 *    the split between them is arbitrary — but least squares still returns a
 *    tidy pair of numbers with a high r². `refusesCollinear` builds exactly
 *    that corpus and asserts the fitter refuses instead of answering.
 *  - A cliff term invented out of noise (a fourth parameter always improves a
 *    least-squares fit), or a real cliff missed.
 *  - A refuel rate dragged down by a driver swap that `tyres_changed = false`
 *    let through.
 *  - Pit loss read off `lane_sec`, which is entry-to-exit and not the time
 *    lost against staying out.
 *  - The table keyed on `car`, which is a livery string, shattering samples.
 *  - v<5 laps (no consumption block) counted as if they carried fuel.
 *
 * Run: node scripts/test-fitstrategy.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const F = require('./fit-strategy');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`); }
}

const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

/** Deterministic pseudo-random, so a failure is always reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Build a stint of laps under a known model:
 *   lapSec = base + kFuel·fuel + lin·stintLap + cliff·max(0, stintLap − cliffAt)
 * Fuel falls by `burn` each lap, which is what makes the two predictors
 * correlated — the whole difficulty the fitter has to survive.
 */
function stint({ startFuel, laps, base, kFuel, lin, cliffAt = null, cliffRate = 0,
                 burn = 2.9, capacity = 120, noise = 0.05, rand, carClass = 'GT3',
                 track = 'Test Circuit', trackKey = 'test_5000', car = 'Car A', wet = false }) {
  const out = [];
  let fuel = startFuel;
  for (let i = 1; i <= laps; i++) {
    const deg = lin * i + (cliffAt && i > cliffAt ? cliffRate * (i - cliffAt) : 0);
    const jitter = (rand() - 0.5) * 2 * noise;
    const sec = base + kFuel * fuel + deg + jitter;
    out.push({
      carClass, car, track, trackKey, trackLengthM: 5000, sessionType: 'race',
      lapMs: Math.round(sec * 1000), clean: true,
      fuelStartL: Number(fuel.toFixed(2)), fuelUsedL: burn, capacityL: capacity,
      compound: 'Medium', stintLap: i, isOutLap: false, isInLap: false, wet,
    });
    fuel -= burn;
  }
  return out;
}

// ===========================================================================
console.log('\nsolver and regression');
// ===========================================================================
{
  const x = F.solve([[2, 1], [1, 3]], [5, 10]);
  check('solve() handles a 2x2', near(x[0], 1, 1e-9) && near(x[1], 3, 1e-9), x && x.map((v) => v.toFixed(2)).join(','));
  check('solve() refuses a singular matrix', F.solve([[1, 2], [2, 4]], [3, 6]) === null);

  // y = 5 + 2a + 3b, exactly.
  const X = [[1, 1], [2, 1], [3, 2], [4, 7], [5, 3], [9, 2]];
  const y = X.map(([a, b]) => 5 + 2 * a + 3 * b);
  const fit = F.ols(X, y);
  check('ols() recovers an exact plane',
    near(fit.intercept, 5, 1e-6) && near(fit.coef[0], 2, 1e-6) && near(fit.coef[1], 3, 1e-6),
    `${fit.intercept.toFixed(3)} + ${fit.coef[0].toFixed(3)}a + ${fit.coef[1].toFixed(3)}b`);

  // Three wild points in forty — a stint's worth of laps with some traffic in
  // it, which is what this function is actually for. The plain fit is dragged
  // to 3.95; the robust pass should find its way back to 2.
  const rand = rng(5);
  const Xb = [], yb = [];
  for (let i = 0; i < 40; i++) {
    const a = rand() * 10, b = rand() * 5;
    Xb.push([a, b]);
    yb.push(5 + 2 * a + 3 * b + (rand() - 0.5) * 0.2);
  }
  yb[3] += 90; yb[17] -= 70; yb[28] += 55;
  const plain = F.ols(Xb, yb);
  const robust = F.robustOls(Xb, yb);
  check('robustOls() recovers the truth the plain fit lost to outliers',
    near(robust.coef[0], 2, 0.05) && near(robust.coef[1], 3, 0.05) && Math.abs(plain.coef[0] - 2) > 1,
    `plain ${plain.coef[0].toFixed(2)} vs robust ${robust.coef[0].toFixed(2)} (want 2)`);
  check('…and says how many laps it threw away', robust.dropped === 3, `${robust.dropped}`);

  // The other half of being robust is knowing when not to be. One point in six
  // carrying a huge residual is not an outlier, it is a quarter of what you
  // know; "cleaning" it would be inventing a fit from three points.
  const y2 = y.slice(); y2[3] += 90;
  const tiny = F.robustOls(X, y2);
  check('…and refuses to clean a sample too small to judge', tiny.dropped === 0, `dropped ${tiny.dropped} of 6`);
}

// ===========================================================================
console.log('\nrecovering a known race');
// ===========================================================================
{
  const rand = rng(7);
  const TRUTH = { base: 90, kFuel: 0.03, lin: 0.02, burn: 2.9 };
  // Four stints that START AT DIFFERENT FUEL LOADS — the only thing that makes
  // the fuel and tyre terms separable, and what a real race provides for free.
  const laps = [
    ...stint({ ...TRUTH, startFuel: 120, laps: 20, rand }),
    ...stint({ ...TRUTH, startFuel: 80, laps: 18, rand }),
    ...stint({ ...TRUTH, startFuel: 105, laps: 22, rand }),
    ...stint({ ...TRUTH, startFuel: 60, laps: 16, rand }),
  ];
  const stops = Array.from({ length: 6 }, () => ({
    carClass: 'GT3', track: 'Test Circuit', trackKey: 'test_5000', sessionType: 'race',
    laneSec: 60, stationarySec: 40, fuelAddedL: 60, tyresChanged: false,
  }));
  const table = F.buildTable({ laps, stops, source: 'test' });
  const row = table.rows[0];

  check('one row per class/track', table.rows.length === 1, `${table.rows.length}`);
  check('basePaceSec recovered', near(row.basePaceSec, TRUTH.base, 0.5), `${row.basePaceSec} vs ${TRUTH.base}`);
  check('kFuelSecPerL recovered', near(row.kFuelSecPerL, TRUTH.kFuel, 0.004), `${row.kFuelSecPerL} vs ${TRUTH.kFuel}`);
  check('tyre linSecPerLap recovered', near(row.tyre.linSecPerLap, TRUTH.lin, 0.004), `${row.tyre.linSecPerLap} vs ${TRUTH.lin}`);
  check('burnBaseLPerLap recovered', near(row.burnBaseLPerLap, TRUTH.burn, 0.01), `${row.burnBaseLPerLap}`);
  check('capacity carried through', row.capacityL === 120, `${row.capacityL}`);
  check('kFuel confidence is measured', row.confidence.kFuel === 'measured', row.confidence.kFuel);
  check('collinearity measured and survivable', row.diagnostics.collinearity < F.COLLIN_REFUSE, `r=${row.diagnostics.collinearity}`);
  check('kLift is never fitted', row.kLiftSecPerLPerLap === null && row.confidence.kLift === 'none');
  check('whyNot always names the missing save option',
    row.whyNot.some((w) => /lift-and-coast/.test(w)));
}

// ===========================================================================
console.log('\nthe collinearity refusal — the one that would lie');
// ===========================================================================
{
  const rand = rng(11);
  // Every stint identical: same start fuel, same length. Plenty of laps, a
  // beautiful r², and the fuel/stint split is pure arbitrage.
  const laps = [
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 120, laps: 20, rand }),
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 120, laps: 20, rand }),
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 120, laps: 20, rand }),
  ];
  const table = F.buildTable({ laps, stops: [], source: 'test' });
  const row = table.rows[0];
  check('60 laps are not enough when they are all the same stint',
    row.confidence.kFuel === 'none', `kFuel=${row.confidence.kFuel}`);
  check('…and the fitter says WHY, in words',
    row.whyNot.some((w) => /collinear/.test(w)),
    row.whyNot.find((w) => /collinear/.test(w)));
  check('…and emits no kFuel number at all', row.kFuelSecPerL === null, `${row.kFuelSecPerL}`);
  check('…while the burn, which does not depend on the split, still fits',
    row.confidence.burn === 'measured', row.confidence.burn);
}

// ===========================================================================
console.log('\nthe tyre cliff');
// ===========================================================================
{
  const rand = rng(23);
  const withCliff = [
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 120, laps: 30, cliffAt: 20, cliffRate: 0.25, rand }),
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 85, laps: 28, cliffAt: 20, cliffRate: 0.25, rand }),
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 110, laps: 26, cliffAt: 20, cliffRate: 0.25, rand }),
  ];
  const rowC = F.buildTable({ laps: withCliff, stops: [], source: 'test' }).rows[0];
  check('a real cliff is found near where it was put',
    rowC.tyre.cliffLap != null && Math.abs(rowC.tyre.cliffLap - 20) <= 3,
    `cliffLap=${rowC.tyre.cliffLap} (truth 20)`);
  check('…with roughly the right extra slope',
    near(rowC.tyre.cliffSecPerLap, 0.25, 0.12), `${rowC.tyre.cliffSecPerLap} vs 0.25`);

  const rand2 = rng(29);
  const noCliff = [
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 120, laps: 30, rand: rand2 }),
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 85, laps: 28, rand: rand2 }),
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 110, laps: 26, rand: rand2 }),
  ];
  const rowN = F.buildTable({ laps: noCliff, stops: [], source: 'test' }).rows[0];
  check('no cliff is invented when the tyres just wear linearly',
    rowN.tyre.cliffLap === null, `cliffLap=${rowN.tyre.cliffLap}`);

  const rand3 = rng(31);
  const shortStints = [
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 120, laps: 10, rand: rand3 }),
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 85, laps: 10, rand: rand3 }),
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 105, laps: 10, rand: rand3 }),
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 60, laps: 10, rand: rand3 }),
  ];
  const rowS = F.buildTable({ laps: shortStints, stops: [], source: 'test' }).rows[0];
  check('a cliff is refused when no stint ran far enough to see one',
    rowS.tyre && rowS.tyre.cliffLap === null && rowS.confidence.cliff === 'none');
}

// ===========================================================================
console.log('\nrefuel rate: pooled per class, contamination dropped');
// ===========================================================================
{
  const mk = (carClass, trackKey, fuelAddedL, stationarySec, extra = {}) => ({
    carClass, trackKey, track: trackKey, sessionType: 'race',
    laneSec: 60, stationarySec, fuelAddedL, tyresChanged: false, ...extra,
  });
  const stops = [
    // GT3 at 1.5 L/s, spread over three circuits — one pair alone never
    // reaches the bar, the class pool does.
    mk('GT3', 'a', 60, 40), mk('GT3', 'a', 45, 30),
    mk('GT3', 'b', 60, 40), mk('GT3', 'b', 75, 50),
    mk('GT3', 'c', 30, 20),
    // A driver swap: 23 L across 102 s, inside `tyres_changed = false`.
    mk('GT3', 'c', 23.3, 102),
    // Not stops a rate can be read from.
    mk('GT3', 'a', 60, 40, { tyresChanged: true }),
    mk('GT3', 'a', 60, 40, { sessionType: 'practice' }),
    mk('GT3', 'a', 2, 40),
    mk('GT3', 'a', 60, 3),
  ];
  const byClass = F.fitRefuelByClass(stops);
  const gt3 = byClass.get('GT3');
  check('rate is the median of the honest stops', near(gt3.refuelLPerSec, 1.5, 0.01), `${gt3.refuelLPerSec} L/s`);
  check('the driver swap is dropped as contaminated', gt3.dropped === 1, `dropped ${gt3.dropped} of ${gt3.stopsBeforeFilter}`);
  check('tyre stops, practice, small fills and torn reads never counted', gt3.stops === 5, `${gt3.stops} stops`);
  check('pooling counts the circuits it drew from', gt3.tracks === 3, `${gt3.tracks}`);
  check('confidence is measured at the bar', gt3.confidence === 'measured', gt3.confidence);

  const thin = F.fitRefuelByClass([mk('LMP3', 'a', 60, 40), mk('LMP3', 'a', 60, 40)]);
  check('…and refused below it', thin.get('LMP3').confidence === 'none', `${thin.get('LMP3').stops} stops`);
}

// ===========================================================================
console.log('\nthe pit cycle, measured from in-laps and out-laps');
// ===========================================================================
{
  const rand = rng(41);
  const laps = [
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 120, laps: 20, rand }),
    ...stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 85, laps: 18, rand }),
  ];
  const base = 90 + 0.03 * 90; // a typical mid-race lap under the same model
  // Ten pit cycles: the in-lap loses 12 s, the out-lap 26 s (service included).
  for (let i = 0; i < 10; i++) {
    laps.push({ carClass: 'GT3', car: 'Car A', track: 'Test Circuit', trackKey: 'test_5000',
      sessionType: 'race', lapMs: Math.round((base + 12) * 1000), clean: false,
      stintLap: 19, isInLap: true, isOutLap: false, capacityL: 120 });
    laps.push({ carClass: 'GT3', car: 'Car A', track: 'Test Circuit', trackKey: 'test_5000',
      sessionType: 'race', lapMs: Math.round((base + 26) * 1000), clean: false,
      stintLap: 1, isOutLap: true, isInLap: false, capacityL: 120 });
  }
  const stops = Array.from({ length: 6 }, () => ({
    carClass: 'GT3', trackKey: 'test_5000', track: 'Test Circuit', sessionType: 'race',
    laneSec: 70, stationarySec: 38, fuelAddedL: 60, tyresChanged: false,
  }));
  const row = F.buildTable({ laps, stops, source: 'test' }).rows[0];
  check('pit cycle loss is the in-lap plus out-lap excess', near(row.pitCycleLossSec, 38, 2.5), `${row.pitCycleLossSec} s vs 38`);
  check('…and is measured, not guessed from lane_sec',
    row.confidence.pit === 'measured' && row.pitCycleLossSec !== 70, row.confidence.pit);
  check('reference stationary time rides along for §5\'s adjustment',
    near(row.referenceStationarySec, 38, 0.1), `${row.referenceStationarySec} s`);
  check('in-laps and out-laps stay OUT of the pace regression',
    row.n.paceLaps === 38, `${row.n.paceLaps} pace laps of ${laps.length} rows`);
}

// ===========================================================================
console.log('\nrefusals and grouping');
// ===========================================================================
{
  const rand = rng(53);
  const thin = stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 120, laps: 6, rand });
  const row = F.buildTable({ laps: thin, stops: [], source: 'test' }).rows[0];
  check('a handful of laps fits nothing', row.confidence.kFuel === 'none' && row.confidence.burn === 'partial',
    `kFuel=${row.confidence.kFuel} burn=${row.confidence.burn}`);
  check('…and the row is still emitted, so the engine can say why',
    row.whyNot.length > 0, row.whyNot[0]);

  // Same class and track, two livery strings. One row, not two.
  const rand2 = rng(59);
  const a = stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 120, laps: 20, car: 'BMW GT3 Custom Team 2025 #397', rand: rand2 });
  const b = stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 80, laps: 20, car: 'BMW GT3 Custom Team 2026 #397', rand: rand2 });
  const t = F.buildTable({ laps: [...a, ...b], stops: [], source: 'test' });
  check('livery strings do not shatter a sample', t.rows.length === 1 && t.rows[0].n.paceLaps === 40,
    `${t.rows.length} row(s), ${t.rows[0].n.paceLaps} laps`);

  // Wet laps have nothing to say about dry pace.
  const rand3 = rng(61);
  const dry = stint({ base: 90, kFuel: 0.03, lin: 0.02, startFuel: 120, laps: 20, rand: rand3 });
  const wet = stint({ base: 120, kFuel: 0.03, lin: 0.02, startFuel: 80, laps: 20, wet: true, rand: rand3 });
  const tw = F.buildTable({ laps: [...dry, ...wet], stops: [], source: 'test' }).rows[0];
  check('wet laps are kept out of the pace fit', tw.n.paceLaps === 20, `${tw.n.paceLaps}`);

  // A negative tyre term is track evolution, not a tyre that improves with age.
  const rand4 = rng(67);
  const improving = [
    ...stint({ base: 90, kFuel: 0.03, lin: -0.05, startFuel: 120, laps: 20, rand: rand4 }),
    ...stint({ base: 90, kFuel: 0.03, lin: -0.05, startFuel: 80, laps: 20, rand: rand4 }),
  ];
  const ri = F.buildTable({ laps: improving, stops: [], source: 'test' }).rows[0];
  check('a negative degradation term is refused, not shipped',
    ri.tyre === null && ri.whyNot.some((w) => /negative/.test(w)),
    ri.whyNot.find((w) => /negative/.test(w)));
}

// ===========================================================================
console.log('\nreading this machine\'s logs');
// ===========================================================================
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-fit-'));
  fs.mkdirSync(path.join(root, 'laps'));
  fs.mkdirSync(path.join(root, 'stops'));
  const lapLines = [
    // v4: no consumption block. Must be invisible to the fitter.
    JSON.stringify({ v: 4, carClass: 'GT3', track: 'T', trackKey: 't', lapMs: 90000, clean: true }),
    JSON.stringify({ v: 5, carClass: 'GT3', track: 'T', trackKey: 't', lapMs: 90000, clean: true,
      fuelStartL: 100, fuelUsedL: 2.9, capacityL: 120, stintLap: 3 }),
    'not json at all',
  ];
  fs.writeFileSync(path.join(root, 'laps', '2026-09-11.jsonl'), `${lapLines.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'stops', '2026-09-11.jsonl'),
    `${JSON.stringify({ v: 1, carClass: 'GT3', trackKey: 't', sessionType: 'race', laneSec: 60, stationarySec: -1, fuelAddedL: 50, tyresChanged: false })}\n`);

  const local = F.readLocal({ root });
  check('pre-v5 laps are skipped', local.laps.length === 1, `${local.laps.length} lap(s)`);
  check('a torn line does not take the run down', true);
  check('UNKNOWN_VALUE stationary time becomes null, never a negative stop',
    local.stops[0].stationarySec === null, `${local.stops[0].stationarySec}`);
  check('a null stationary stop cannot become a refuel rate',
    F.fitRefuelByClass(local.stops).size === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\ntest-fitstrategy: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
