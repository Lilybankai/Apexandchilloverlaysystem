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
 * Energy class being handed litres per second (or litres pushed through the
 * fuel tank and called energy), the diagnostic pit cycle reaching the engine
 * as a lane loss, a circuit under its sample bar shipping a lane, and a track alias quietly
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

  // The unmatched in-lap/out-lap pit cycle is a diagnostic now (it read 6.8 s
  // of lane at Monza). Measured or not, it must never reach the app as a lane.
  const cycles = fitted.rows.filter((r) => r.pitCycleLossSec != null);
  check('the fit still carries pit-cycle diagnostics to be tempted by', cycles.length > 0,
    cycles.length);
  const anyPitLoss = Object.values(SHIPPED.byPair).some((p) => p.pitLaneLossSec != null);
  check('…and no pit cycle reached the shipped table as a lane loss', !anyPitLoss);

  // The lane that DOES ship is the per-circuit fit, and only above its bar.
  const lanes = Object.entries(fitted.pitLaneByTrack || {});
  const bar = fitted.bars.pitLaneStops;
  check('the fit carries a per-circuit pit lane table with a sample bar',
    lanes.length > 0 && bar >= 8, { lanes: lanes.length, bar });
  const under = lanes.filter(([, l]) => l.confidence !== 'measured');
  check('the fit has circuits under the bar to be tempted by', under.length > 0, under.length);
  const leaked = under.filter(([key]) => SHIPPED.byTrackKey[key] != null);
  check('…and none of them shipped a lane', leaked.length === 0, leaked.map(([k]) => k));
  const thin = Object.entries(SHIPPED.byTrackKey).filter(([, l]) => !(l.stops >= bar));
  check('every shipped lane stands on at least the bar of stops', thin.length === 0, thin);
  const layoutsBacked = Object.values(SHIPPED.byLayout)
    .every((l) => Object.values(SHIPPED.byTrackKey).some((t) => JSON.stringify(t) === JSON.stringify(l)));
  check('every per-layout lane is one of the per-track-key lanes', layoutsBacked);

  // Same rule for the class rates — judged in the unit the class plans in: a
  // Virtual Energy class ships only off a measured ENERGY fit, whatever its
  // litre figure says.
  for (const [corpusClass, entry] of Object.entries(fitted.refuelByClass)) {
    const classId = builder.CLASS_ALIASES[corpusClass];
    const usesVE = DATA.classUsesVirtualEnergy(classId);
    const conf = usesVE ? (entry.ve && entry.ve.confidence) || 'none' : entry.confidence;
    if (conf === 'measured') continue;
    const shipped = SHIPPED.byClass[classId];
    const supersededByAnother = shipped && shipped.from !== corpusClass;
    check(`${corpusClass} is refused (${conf}) so it ships no rate of its own`,
      !shipped || supersededByAnother, shipped && shipped.from);
  }

  // Tyre time likewise: only a measured class fit crosses.
  for (const [corpusClass, entry] of Object.entries(fitted.refuelByClass)) {
    if (!entry.tyre || entry.tyre.confidence === 'measured') continue;
    const shipped = SHIPPED.byCorpusClass[corpusClass];
    check(`${corpusClass} tyre time is refused (${entry.tyre.stops} stops) so none ships`,
      !shipped || shipped.from !== corpusClass || shipped.tyreChangeSec == null,
      shipped && shipped.tyreChangeSec);
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
  const fitted = require(path.join(__dirname, '..', 'data', 'strategy-coefficients.json'));
  for (const [classId, entry] of Object.entries(SHIPPED.byClass)) {
    const usesVE = DATA.classUsesVirtualEnergy(classId);
    check(`${classId} ships its rate as ${usesVE ? 'percent' : 'litres'} per second`,
      entry.unit === (usesVE ? 'pct' : 'l'), entry.unit);
    check(`${classId}'s fixed per-stop refuel time is small and non-negative`,
      entry.refuelFixedSec >= 0 && entry.refuelFixedSec <= 5, entry.refuelFixedSec);
    if (!usesVE) {
      check(`${classId} (litres) carries no fixed term`, entry.refuelFixedSec === 0, entry.refuelFixedSec);
      continue;
    }
    // The rate IS the energy fit, rounded — not a litre rate pushed through a
    // tank size. Litres over the 120 L fuel tank gave 1.28 %/s for GT3, when
    // 100 % of energy is ~82 L and the rig refills ~2.5 %/s.
    const ve = fitted.refuelByClass[entry.from].ve;
    check(`${classId}'s percent rate is the measured energy rate`,
      ve && entry.refuelPerSec === Math.round(ve.pctPerSec * 100) / 100,
      { got: entry.refuelPerSec, fitted: ve && ve.pctPerSec });
    const viaTank = Math.round((fitted.refuelByClass[entry.from].refuelLPerSec / 120) * 100 * 100) / 100;
    check(`${classId}'s rate is not litres over the 120 L tank`, entry.refuelPerSec !== viaTank,
      { got: entry.refuelPerSec, viaTank });
    // A plausibility band for a VE rig: a full refill between ~25 s and ~70 s.
    check(`${classId}'s energy rate is a plausible rig (1.5–4 %/s)`,
      entry.refuelPerSec >= 1.5 && entry.refuelPerSec <= 4, entry.refuelPerSec);
  }
}

section('Pricing a Virtual Energy refuel');
{
  const gt3 = SHIPPED.byClass.lmgt3;
  // A 70 % fill: fixed time plus fill over rate, and nothing else.
  const sec = ENGINE.refuelSeconds(70, gt3.refuelPerSec, gt3.refuelFixedSec);
  check('a 70 % GT3 fill costs fixed + 70 / rate',
    Math.abs(sec - (gt3.refuelFixedSec + 70 / gt3.refuelPerSec)) < 1e-9, sec);
  check('…which is under 35 s (the old tank conversion said ~55 s)', sec < 35 && sec > 20, sec);
  check('no fuel, no fixed time', ENGINE.refuelSeconds(0, gt3.refuelPerSec, gt3.refuelFixedSec) === 0);
  check('no rate, no time rather than infinity', ENGINE.refuelSeconds(50, 0, 1) === 0);
  check('a negative fixed term is ignored, not subtracted',
    ENGINE.refuelSeconds(50, 2.5, -3) === 20);
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

  // Monza has enough race stops for a measured lane; the number is the
  // circuit's, whatever the class asking.
  check('a measured circuit lane is used', measured.pitLaneLossSec === coeffs.byLayout.monza_gp.pitLaneLossSec,
    measured.pitLaneLossSec);
  check('…marked measured, with its spread', measured.provenance.pitLaneLossSec.source === 'measured'
    && Array.isArray(measured.provenance.pitLaneLossSec.spread), measured.provenance.pitLaneLossSec);
  const otherClass = ENGINE.pitParamsFor({ coeffs, classId: 'lmp2', layoutId: 'monza_gp' });
  check('…and the same lane for every class', otherClass.pitLaneLossSec === measured.pitLaneLossSec,
    otherClass.pitLaneLossSec);

  // Below the bar: the estimate, saying what measuring it would take.
  const thinLayout = ['spa_gp', 'sebring_full', 'bahrain_gp', 'imola_gp'].find((id) => !coeffs.byLayout[id]);
  const thin = ENGINE.pitParamsFor({ coeffs, classId: 'lmgt3', layoutId: thinLayout, useVirtualEnergy: true });
  check(`a circuit under the sample bar (${thinLayout}) falls back to the 25 s estimate`,
    thin.pitLaneLossSec === ENGINE.DEFAULT_PIT_PARAMS.pitLaneLossSec, thin.pitLaneLossSec);
  check('…marked estimate, explaining what measuring it would take',
    thin.provenance.pitLaneLossSec.source === 'estimate'
    && /race stops/.test(thin.provenance.pitLaneLossSec.why), thin.provenance.pitLaneLossSec);

  // The lap-log door onto the same lanes, for callers keyed like live data.
  const byKey = ENGINE.pitParamsFor({ coeffs, classId: 'lmgt3', trackKey: 'autodromo-nazionale-monza_5781', useVirtualEnergy: true });
  check('a lap-log track key finds the same lane', byKey.pitLaneLossSec === measured.pitLaneLossSec,
    byKey.pitLaneLossSec);

  // Tyres: measured for GT3, the estimate where the class is too thin.
  check('GT3 tyre change time is measured', measured.tyreChangeSec === coeffs.byClass.lmgt3.tyreChangeSec
    && measured.provenance.tyreChangeSec.source === 'measured', measured.tyreChangeSec);
  check('…and well under the old 30 s guess', measured.tyreChangeSec < 20, measured.tyreChangeSec);
  check('a class without enough tyre stops keeps the estimate',
    otherClass.tyreChangeSec === ENGINE.DEFAULT_PIT_PARAMS.tyreChangeSec
    && otherClass.provenance.tyreChangeSec.source === 'estimate', otherClass.provenance.tyreChangeSec);

  // The fixed refuel term rides with the measured rate, and only with it.
  check('a measured VE rate brings its fixed per-stop time',
    measured.refuelFixedSec === coeffs.byClass.lmgt3.refuelFixedSec, measured.refuelFixedSec);
  check('…a driver-typed rate does not', overridden.refuelFixedSec === 0, overridden.refuelFixedSec);

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
  // A four-hour LMGT3 race at Monza: long enough that every pit parameter is
  // paid several times over. The guesses (2.0 %/s, 30 s tyres) are slower than
  // the measured rig and crew, so the guessed plan spends minutes it will not.
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
  check('the measured rig and crew make the stops cheaper than the guess did',
    measured.totalPitTimeSec < guessed.totalPitTimeSec,
    { measured: measured.totalPitTimeSec, guessed: guessed.totalPitTimeSec });
  check('…by more than a minute over a four-hour race',
    guessed.totalPitTimeSec - measured.totalPitTimeSec > 60,
    { measured: measured.totalPitTimeSec, guessed: guessed.totalPitTimeSec });
  // The consequence that matters on the pit wall: the guessed plan thinks you
  // complete fewer laps than you actually will.
  check('…and the guessed plan under-counts the laps you will complete',
    guessed.raceLaps < measured.raceLaps,
    { measuredLaps: measured.raceLaps, guessedLaps: guessed.raceLaps });

  // Each stop's refuel line is the fixed term plus fill over rate, rounded up.
  const stop = measured.stints.find((s) => s.stopAfter);
  const next = measured.stints[stop.index];
  const gt3 = SHIPPED.byClass.lmgt3;
  check('a planned stop prices its refuel with the fixed term',
    stop.stopAfter.refuelSec === Math.ceil(gt3.refuelFixedSec + next.fill / gt3.refuelPerSec),
    { refuelSec: stop.stopAfter.refuelSec, fill: next.fill });
  check('…and its lane at the measured Monza figure',
    stop.stopAfter.pitLaneSec === SHIPPED.byLayout.monza_gp.pitLaneLossSec, stop.stopAfter.pitLaneSec);
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
  check('…bringing the fixed refuel time and the measured tyre time with it',
    live.refuelFixedSec === gt3.refuelFixedSec && live.tyreChangeSec === gt3.tyreChangeSec,
    { fixed: live.refuelFixedSec, tyres: live.tyreChangeSec });
  check('…while the lane, with no circuit given, stays the estimate',
    live.provenance.pitLaneLossSec.source === 'estimate');

  // The lane on the Team tab: the live session's track + length rebuild the
  // very key every corpus stop was filed under. Pinned against the recorder's
  // own trackKeyOf so the two can never drift apart unnoticed.
  const { trackKeyOf } = require(path.join(__dirname, '..', 'dist', 'telemetry', 'paceDelta.js'));
  for (const [name, len] of [['Circuit de la Sarthe', 13624.4], ['Autodromo Nazionale Monza', 5781], ['  Weird -- Name!! ', 0], ['', 4000]]) {
    check(`liveTrackKey matches trackKeyOf for "${name}" / ${len}`,
      ENGINE.liveTrackKey(name, len) === trackKeyOf(name, len),
      { panel: ENGINE.liveTrackKey(name, len), recorder: trackKeyOf(name, len) });
  }
  const lmKey = ENGINE.liveTrackKey('Circuit de la Sarthe', 13624);
  check('the shipped table has a measured lane for Le Mans under the live key',
    !!SHIPPED.byTrackKey && !!SHIPPED.byTrackKey[lmKey], lmKey);
  const atLeMans = ENGINE.pitParamsFor({
    coeffs: { byClass: { live: gt3 }, byTrackKey: SHIPPED.byTrackKey, unresolved: {} },
    classId: 'live',
    trackKey: lmKey,
    useVirtualEnergy: true,
  });
  check('…and the Team tab’s lookup resolves it as measured',
    atLeMans.provenance.pitLaneLossSec.source === 'measured'
      && atLeMans.pitLaneLossSec === SHIPPED.byTrackKey[lmKey].pitLaneLossSec,
    atLeMans.pitLaneLossSec);
  const unknownTrack = ENGINE.pitParamsFor({
    coeffs: { byClass: {}, byTrackKey: SHIPPED.byTrackKey, unresolved: {} },
    classId: 'live',
    trackKey: ENGINE.liveTrackKey('Nowhere Ring', 4321),
    useVirtualEnergy: true,
  });
  check('a circuit without enough stops keeps the 25 s estimate',
    unknownTrack.provenance.pitLaneLossSec.source === 'estimate'
      && unknownTrack.pitLaneLossSec === ENGINE.DEFAULT_PIT_PARAMS.pitLaneLossSec
      && unknownTrack.provenance.refuelRatePerSec.source === 'estimate',
    unknownTrack.pitLaneLossSec);

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
