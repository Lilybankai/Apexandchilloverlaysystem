/**
 * test-coefficients.js — the measured coefficients, and how they are resolved.
 * -----------------------------------------------------------------------------
 * Two surfaces, one contract:
 *
 *   scripts/build-coefficients.js  projects the fitted table into the Fuel tab's
 *                                  own ids, dropping everything unmeasured.
 *   fuel-strategy.js pitParamsFor  picks between the driver, the corpus and the
 *                                  engine's estimate, and records which won.
 *
 * The tests worth having here are the ones that catch a SILENT wrong number:
 * a coefficient that is `partial` slipping through as if measured, a Virtual
 * Energy class being handed litres per second, the pit-cycle loss reaching the
 * engine without its stationary time subtracted, and a track alias quietly
 * pointing at the wrong layout. Each of those produces a confident plan that is
 * wrong, which docs/RACE-STRATEGY-ENGINE.md §11 exists to prevent.
 */

'use strict';

const path = require('path');

const ENGINE = require(path.join(__dirname, '..', 'electron', 'control-panel', 'fuel-strategy.js'));
const DATA = require(path.join(__dirname, '..', 'electron', 'control-panel', 'fuel-data.js'));
const SHIPPED = require(path.join(__dirname, '..', 'electron', 'control-panel', 'fuel-coefficients.js'));
const builder = require(path.join(__dirname, 'build-coefficients.js'));

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); return; }
  failed += 1;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  (got: ${JSON.stringify(detail)})`}`);
}

function section(title) { console.log(`\n${title}`); }

// ── The generated file is in step with the fit ─────────────────────────────
section('The shipped table matches the fitted table');
{
  const warnings = [];
  const rebuilt = builder.build((m) => warnings.push(m));
  const text = builder.render(rebuilt);
  const onDisk = require('fs').readFileSync(
    path.join(__dirname, '..', 'electron', 'control-panel', 'fuel-coefficients.js'), 'utf8',
  );
  check('fuel-coefficients.js is what build-coefficients.js produces today', onDisk === text,
    onDisk === text ? null : 'run: node scripts/build-coefficients.js');
  check('the projection reports no unmapped track or class', warnings.length === 0, warnings);
}

// ── Only measured numbers ship ─────────────────────────────────────────────
section('Nothing unmeasured crosses into the app');
{
  const fitted = require(path.join(__dirname, '..', 'data', 'strategy-coefficients.json'));

  // The whole honesty argument in one assertion: the fit has a Barcelona GT3
  // pit cycle at 'partial' confidence, and it must NOT be in the shipped table.
  const partialPit = fitted.rows.filter((r) => r.confidence.pit === 'partial');
  check('the fit does have a partial pit cycle to be tempted by', partialPit.length > 0,
    partialPit.length);
  const anyPitLoss = Object.values(SHIPPED.byPair).some((p) => p.pitLaneLossSec != null);
  check('…and no partial pit cycle reached the shipped table', !anyPitLoss);

  // Same rule for the class rates.
  for (const [corpusClass, entry] of Object.entries(fitted.refuelByClass)) {
    const classId = builder.CLASS_ALIASES[corpusClass];
    if (entry.confidence === 'measured') continue;
    const shipped = SHIPPED.byClass[classId];
    const supersededByAnother = shipped && shipped.from !== corpusClass;
    check(`${corpusClass} is refused (${entry.confidence}) so it ships no rate of its own`,
      !shipped || supersededByAnother, shipped && shipped.from);
  }

  // Every burn figure present must be backed by laps, or it is not a measurement.
  const burnsWithoutLaps = Object.entries(SHIPPED.byPair)
    .filter(([, p]) => p.burnLPerLap != null && !p.burnLaps);
  check('every shipped burn figure carries its lap count', burnsWithoutLaps.length === 0,
    burnsWithoutLaps);
}

// ── Identity ───────────────────────────────────────────────────────────────
section('Track and class identity');
{
  const layouts = new Set();
  for (const c of DATA.CIRCUITS) for (const l of c.layouts) layouts.add(l.id);

  const badLayout = Object.entries(builder.TRACK_ALIASES).filter(([, id]) => !layouts.has(id));
  check('every TRACK_ALIASES target is a layout the Fuel tab has', badLayout.length === 0, badLayout);

  const classIds = new Set(DATA.CAR_CLASSES.map((c) => c.id));
  const badClass = Object.entries(builder.CLASS_ALIASES).filter(([, id]) => !classIds.has(id));
  check('every CLASS_ALIASES target is a class the Fuel tab has', badClass.length === 0, badClass);

  // Length is the check that a hand-written alias points somewhere sane. It is
  // deliberately NOT the matcher: Spa GP and Spa Endurance share a length, so
  // matching on it would pick one of them at random.
  const fitted = require(path.join(__dirname, '..', 'data', 'strategy-coefficients.json'));
  const lengthOf = new Map();
  for (const c of DATA.CIRCUITS) for (const l of c.layouts) lengthOf.set(l.id, Math.round(l.length * 1000));
  let worst = { delta: 0 };
  for (const row of fitted.rows) {
    const id = builder.TRACK_ALIASES[row.trackKey];
    if (!id || !row.trackLengthM) continue;
    const delta = Math.abs(row.trackLengthM - lengthOf.get(id));
    if (delta > worst.delta) worst = { delta, key: row.trackKey, id };
  }
  check('no alias lands further than the tolerance from its layout length',
    worst.delta <= builder.LENGTH_TOLERANCE_M, worst);

  const collisions = Object.values(builder.TRACK_ALIASES)
    .filter((id, i, all) => all.indexOf(id) !== i);
  check('the known ELMS/WEC collision is still the only shared layout',
    collisions.length === 1 && collisions[0] === 'silverstone_gp_wec', collisions);
}

// ── Units ──────────────────────────────────────────────────────────────────
section('A Virtual Energy class never receives litres');
{
  for (const [classId, entry] of Object.entries(SHIPPED.byClass)) {
    const usesVE = DATA.classUsesVirtualEnergy(classId);
    check(`${classId} ships its rate as ${usesVE ? 'percent' : 'litres'} per second`,
      entry.unit === (usesVE ? 'pct' : 'l'), entry.unit);
    if (!usesVE) continue;
    const expected = Math.round((entry.refuelLPerSec / entry.capacityL) * 100 * 100) / 100;
    check(`${classId}'s percent rate is its litre rate over its tank`,
      entry.refuelPerSec === expected, { got: entry.refuelPerSec, expected });
    // A percent-per-second rate above the litre figure would mean a tank under
    // 100 L, which no VE class in LMU has — a cheap guard against a flipped
    // conversion that would otherwise look plausible.
    check(`${classId}'s conversion went the right way`, entry.refuelPerSec < entry.refuelLPerSec,
      entry.refuelPerSec);
  }
}

// ── Resolution order ───────────────────────────────────────────────────────
section('pitParamsFor picks in the right order and says so');
{
  const coeffs = SHIPPED;

  const measured = ENGINE.pitParamsFor({ coeffs, classId: 'lmgt3', layoutId: 'monza_gp', useVirtualEnergy: true });
  check('a measured class rate is used', measured.refuelRatePerSec === coeffs.byClass.lmgt3.refuelPerSec,
    measured.refuelRatePerSec);
  check('…and is marked measured', measured.provenance.refuelRatePerSec.source === 'measured');
  check('…carrying the stop count it rests on', measured.provenance.refuelRatePerSec.stops > 0,
    measured.provenance.refuelRatePerSec.stops);

  const overridden = ENGINE.pitParamsFor({
    coeffs, classId: 'lmgt3', layoutId: 'monza_gp', useVirtualEnergy: true,
    overrides: { refuelRatePerSec: 3.3 },
  });
  check('the driver beats the corpus', overridden.refuelRatePerSec === 3.3);
  check('…and is marked as theirs', overridden.provenance.refuelRatePerSec.source === 'you');

  // hypercar is in `unresolved`: no clean fuel-only stop yet.
  const estimated = ENGINE.pitParamsFor({ coeffs, classId: 'hypercar', layoutId: 'spa_gp', useVirtualEnergy: true });
  check('an unmeasured class falls back to the engine estimate',
    estimated.refuelRatePerSec === ENGINE.DEFAULT_PIT_PARAMS.energyRefuelRate, estimated.refuelRatePerSec);
  check('…marked as an estimate', estimated.provenance.refuelRatePerSec.source === 'estimate');
  check('…with the fitter’s own reason, not a generic one',
    /fuel-only race stop/.test(estimated.provenance.refuelRatePerSec.short),
    estimated.provenance.refuelRatePerSec.short);

  // A class with no corpus row at all still has to explain itself.
  const silent = ENGINE.pitParamsFor({ coeffs, classId: 'gte', layoutId: 'monza_gp' });
  check('a class absent from the corpus is still explained',
    silent.provenance.refuelRatePerSec.source === 'estimate'
    && silent.provenance.refuelRatePerSec.short.length > 0,
    silent.provenance.refuelRatePerSec);

  // Pit loss and tyres are unmeasured everywhere today; they must say so
  // rather than quietly presenting the constants as fact.
  check('pit lane loss is an estimate everywhere today',
    measured.provenance.pitLaneLossSec.source === 'estimate');
  check('…and explains what measuring it would take',
    /in-laps/.test(measured.provenance.pitLaneLossSec.why), measured.provenance.pitLaneLossSec.why);
  check('tyre change time is an estimate', measured.provenance.tyreChangeSec.source === 'estimate');

  // The unit guard: asking for litres must not hand back a percent rate.
  const wrongUnit = ENGINE.pitParamsFor({ coeffs, classId: 'lmgt3', layoutId: 'monza_gp', useVirtualEnergy: false });
  check('asking a VE class for a litre rate refuses the percent figure',
    wrongUnit.refuelRatePerSec === ENGINE.DEFAULT_PIT_PARAMS.fuelRefuelRate, wrongUnit.refuelRatePerSec);
  check('…and reports it as an estimate, not a measurement',
    wrongUnit.provenance.refuelRatePerSec.source === 'estimate');
}

// ── Missing table ──────────────────────────────────────────────────────────
section('The calculator survives without the table at all');
{
  const none = ENGINE.pitParamsFor({ coeffs: null, classId: 'lmgt3', layoutId: 'monza_gp', useVirtualEnergy: true });
  check('every field still resolves', Number.isFinite(none.refuelRatePerSec)
    && Number.isFinite(none.pitLaneLossSec) && Number.isFinite(none.tyreChangeSec));
  check('…to the engine defaults', none.refuelRatePerSec === ENGINE.DEFAULT_PIT_PARAMS.energyRefuelRate
    && none.pitLaneLossSec === ENGINE.DEFAULT_PIT_PARAMS.pitLaneLossSec);
  check('…all marked estimate', Object.values(none.provenance).every((p) => p.source === 'estimate'));

  const empty = ENGINE.pitParamsFor();
  check('called with nothing at all it still returns a usable plan input',
    Number.isFinite(empty.refuelRatePerSec) && Number.isFinite(empty.tyresEveryStints));
}

// ── The measured rate actually changes a plan ──────────────────────────────
section('The measurement reaches the plan, not just the label');
{
  // A four-hour LMGT3 race: long enough that the rig rate is paid several
  // times over, which is exactly when a 2.0 %/s guess against a measured
  // 1.28 %/s stops being a rounding error and starts costing a lap.
  const base = {
    raceMode: 'time', raceMinutes: 240, lapTimeSec: 105, consumptionPerLap: 3.4,
    tankCapacity: 100, useVirtualEnergy: true,
  };
  const guessed = ENGINE.buildStrategy({
    ...base,
    pit: ENGINE.pitParamsFor({ coeffs: null, classId: 'lmgt3', useVirtualEnergy: true }),
  });
  const measured = ENGINE.buildStrategy({
    ...base,
    pit: ENGINE.pitParamsFor({ coeffs: SHIPPED, classId: 'lmgt3', layoutId: 'monza_gp', useVirtualEnergy: true }),
  });
  check('both plans build', !!guessed && !!measured);
  // The measured rig is slower than the guess, so a stop costs more time.
  check('the measured rig makes a stop cost more than the guess did',
    measured.totalPitTimeSec > guessed.totalPitTimeSec,
    { measured: measured.totalPitTimeSec, guessed: guessed.totalPitTimeSec });
  check('…by more than a minute over a four-hour race',
    measured.totalPitTimeSec - guessed.totalPitTimeSec > 60,
    { measured: measured.totalPitTimeSec, guessed: guessed.totalPitTimeSec });
  // The consequence that matters on the pit wall: the guessed plan thinks you
  // finish a lap further up the road than you actually will.
  check('…and the guessed plan over-counts the laps you will complete',
    guessed.raceLaps > measured.raceLaps,
    { measuredLaps: measured.raceLaps, guessedLaps: guessed.raceLaps });
}

// ── Measured burn ──────────────────────────────────────────────────────────
section('measuredBurnFor');
{
  const hit = ENGINE.measuredBurnFor({ coeffs: SHIPPED, classId: 'lmgt3', layoutId: 'monza_gp' });
  check('a known class and track returns a burn', hit && hit.litresPerLap > 0, hit);
  check('…with the laps behind it', hit && hit.laps > 0, hit);
  const miss = ENGINE.measuredBurnFor({ coeffs: SHIPPED, classId: 'lmgt3', layoutId: 'sebring_school' });
  check('an unrecorded track returns nothing rather than a neighbour’s number', miss === null, miss);
  check('no table means no burn', ENGINE.measuredBurnFor({ coeffs: null, classId: 'lmgt3', layoutId: 'monza_gp' }) === null);

  // Le Mans is the sanity check that these are real lap burns and not a
  // per-kilometre figure that happened to look plausible.
  const lemans = ENGINE.measuredBurnFor({ coeffs: SHIPPED, classId: 'lmgt3', layoutId: 'lemans_full' });
  const monza = ENGINE.measuredBurnFor({ coeffs: SHIPPED, classId: 'lmgt3', layoutId: 'monza_gp' });
  check('a 13.6 km lap burns more than a 5.8 km one', lemans.litresPerLap > monza.litresPerLap * 1.8,
    { lemans: lemans.litresPerLap, monza: monza.litresPerLap });
}

// ── The live door ──────────────────────────────────────────────────────────
// The Team tab is fed by the sim, which names classes the way the CORPUS does
// (carClass.ts canonical labels) and not the way the Fuel tab does. It looks
// rates up through byCorpusClass, so that index has to hold the same numbers
// and honour the same unit rule — a wrong unit here would price every stop in
// a live race against the wrong scale.
section('byCorpusClass: the door live telemetry comes through');
{
  const CANONICAL = ['HYPERCAR', 'LMP2', 'LMP2_ELMS', 'LMP3', 'GTE', 'GT3', 'GT4'];
  const keys = Object.keys(SHIPPED.byCorpusClass);
  check('every key is a canonical class carClass.ts can produce',
    keys.every((k) => CANONICAL.includes(k) || k === 'LMGT3'), keys);

  // GT3 is what the sim calls the LMGT3 field, and it is the best-populated
  // class in the corpus — if any lookup works, this one must.
  const gt3 = SHIPPED.byCorpusClass.GT3;
  check('GT3 resolves', !!gt3, keys);
  // Deep equality, not identity: the table is serialised as JSON, so the two
  // indexes hold equal objects rather than one shared one. Equal is the whole
  // contract — the two doors must never drift to different numbers.
  check('…to the same numbers the Fuel tab gets for lmgt3',
    JSON.stringify(gt3) === JSON.stringify(SHIPPED.byClass.lmgt3),
    { corpus: gt3, fuelTab: SHIPPED.byClass.lmgt3 });
  check('…in percent per second, because LMGT3 runs Virtual Energy',
    gt3.unit === 'pct', gt3.unit);

  // The pooling decision, pinned: LMP2 and LMP2_ELMS are different
  // homologations sharing a refuelling rig, and `from` must admit which one
  // was actually measured rather than implying both were.
  const p2 = SHIPPED.byCorpusClass.LMP2;
  check('LMP2 resolves through the pooled rig rate', !!p2 && p2.unit === 'l', p2);
  check('…and says which class the measurement actually came from',
    !!p2.from && p2.stops > 0, p2 && { from: p2.from, stops: p2.stops });

  // Hypercar has no measured stop, so the door must be shut, not ajar.
  check('an unmeasured class is absent rather than present-and-empty',
    SHIPPED.byCorpusClass.HYPERCAR === undefined, SHIPPED.byCorpusClass.HYPERCAR);

  // And the shape team-panel.js hands to pitParamsFor must actually resolve.
  const live = ENGINE.pitParamsFor({
    coeffs: { byClass: { live: gt3 }, unresolved: {} },
    classId: 'live',
    useVirtualEnergy: true,
  });
  check('the Team tab’s one-entry lookup resolves to the measured rate',
    live.refuelRatePerSec === gt3.refuelPerSec, live.refuelRatePerSec);
  check('…and is labelled measured, so the page can say so',
    live.provenance.refuelRatePerSec.source === 'measured');

  // The unit guard again, from the live side: a VE class must never be priced
  // in litres per second just because the session was read wrong.
  const wrong = ENGINE.pitParamsFor({
    coeffs: { byClass: { live: gt3 }, unresolved: {} },
    classId: 'live',
    useVirtualEnergy: false,
  });
  check('asked for litres, the percent rate is refused',
    wrong.refuelRatePerSec === ENGINE.DEFAULT_PIT_PARAMS.fuelRefuelRate, wrong.refuelRatePerSec);
}

console.log(`\ntest-coefficients: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
