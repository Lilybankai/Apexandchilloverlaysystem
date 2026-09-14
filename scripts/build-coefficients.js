/**
 * build-coefficients.js — project the fitted table into what the Fuel tab loads.
 * -----------------------------------------------------------------------------
 * `scripts/fit-strategy.js` writes `data/strategy-coefficients.json`: every
 * class/track pair the corpus contains, every coefficient the fit attempted,
 * and — the point of that file — every reason a coefficient was refused. It is
 * a record of the fit, not a runtime asset: ~2400 lines, keyed by the lap log's
 * track keys, and mostly nulls.
 *
 * This script projects it into `electron/control-panel/fuel-coefficients.js`,
 * a classic script exposing `window.APEX_STRATEGY_COEFFS`, keyed by the Fuel
 * tab's OWN circuit/layout/class ids. Three rules make the projection honest:
 *
 *   1. **`measured` only.** A `partial` or `none` coefficient is not carried
 *      over as a number. It is carried over as a REASON, so the panel can say
 *      "estimate, because …" instead of showing a confident wrong figure. This
 *      is §11 of docs/RACE-STRATEGY-ENGINE.md applied to the wire format.
 *
 *   2. **Track and class identity is an explicit table, never a fuzzy match.**
 *      The lap log says `circuit-de-spa-francorchamps_6982`, the Fuel tab says
 *      `spa_gp`, and nothing in either name derives the other. Worse, lengths
 *      collide: Spa GP and Spa Endurance are both 7004 m here, and Silverstone
 *      ELMS and WEC both fit `silverstone_gp_wec`. Length is therefore a CHECK
 *      (a loud warning past LENGTH_TOLERANCE_M), never the matcher.
 *
 *   3. **Units are converted at build time, not at read time.** The fit works
 *      in litres because that is what the rig delivers; LMGT3 and Hypercar plan
 *      in Virtual Energy percent. The conversion is `(L/s ÷ capacity) × 100`,
 *      the same shape fuel-data.js already uses in getDefaultEnergyPerLap, and
 *      it is done here so the panel never holds a number in an unknown unit.
 *
 * Run: node scripts/build-coefficients.js [--check]
 *   --check  verify the committed output matches this input and exit non-zero
 *            if it drifted (what `npm test` runs), writing nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IN = path.join(ROOT, 'data', 'strategy-coefficients.json');
const OUT = path.join(ROOT, 'electron', 'control-panel', 'fuel-coefficients.js');

// A fitted length this far from the Fuel tab's own figure means the alias below
// is probably pointing at the wrong layout. Sebring is the honest outlier: the
// tracks table records 5820 m against a 6019 m circuit, so the bar clears it
// while still catching a genuine mis-mapping.
const LENGTH_TOLERANCE_M = 250;

// ── Identity ───────────────────────────────────────────────────────────────
// Lap-log track key -> Fuel tab layout id. Hand-written and reviewed: see rule
// 2 above for why this is not derived. A key absent here is reported, not
// guessed. Two keys MAY share a layout (ELMS and WEC run the same Silverstone
// tarmac) — the merge rule below decides which fit wins.
const TRACK_ALIASES = {
  'algarve-international-circuit_4635': 'portimao_gp',
  'autodromo-enzo-e-dino-ferrari_4901': 'imola_gp',
  'autodromo-nazionale-monza_5781': 'monza_gp',
  'bahrain-international-circuit_5387': 'bahrain_gp',
  'circuit-de-barcelona_4655': 'barcelona_gp',
  'circuit-de-la-sarthe_13624': 'lemans_full',
  'circuit-de-spa-francorchamps_6982': 'spa_gp',
  'circuit-of-the-americas_5497': 'cota_gp',
  'daytona-international-speedway-road-course_5734': 'daytona_road',
  'lusail-international-circuit_5405': 'qatar_gp',
  'monza-curva-grande-circuit_5745': 'monza_curva_grande',
  'paul-ricard-elms_5807': 'paul_ricard_gp',
  'sebring-international-raceway_5820': 'sebring_full',
  'silverstone-grand-prix-circuit-elms_5869': 'silverstone_gp_wec',
  'silverstone-grand-prix-circuit-wec_5869': 'silverstone_gp_wec',
  'weathertech-raceway-laguna-seca_3590': 'laguna_seca',
};

// Corpus class -> Fuel tab class id. LMU's current GT class is LMGT3; the
// corpus (and migration 0019) still calls it GT3. LMP2_ELMS is the ELMS-spec
// car: a different homologation, the same refuelling rig, so it pools into the
// Fuel tab's single lmp2 class rather than being thrown away.
const CLASS_ALIASES = {
  GT3: 'lmgt3',
  LMGT3: 'lmgt3',
  HYPERCAR: 'hypercar',
  LMP2: 'lmp2',
  LMP2_ELMS: 'lmp2',
  LMP3: 'lmp3',
  GTE: 'gte',
};

// ── Helpers ────────────────────────────────────────────────────────────────

const round = (n, dp) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Load the Fuel tab's own data without a browser. */
function loadFuelData() {
  // eslint-disable-next-line global-require
  return require(path.join(ROOT, 'electron', 'control-panel', 'fuel-data.js'));
}

/** Every layout id the Fuel tab knows, with its length in metres. */
function layoutIndex(DATA) {
  const out = new Map();
  for (const circuit of DATA.CIRCUITS) {
    for (const layout of circuit.layouts) {
      out.set(layout.id, {
        lengthM: Math.round(layout.length * 1000),
        name: `${circuit.name} — ${layout.name}`,
      });
    }
  }
  return out;
}

/**
 * Tank capacity for a corpus class, as the corpus measured it. Used only to
 * convert a litres-per-second rig rate into percent-per-second for the Virtual
 * Energy classes. Refuses when the corpus disagrees with itself.
 */
function capacityFor(rows, carClass) {
  const caps = new Set(
    rows.filter((r) => r.carClass === carClass && r.capacityL).map((r) => r.capacityL),
  );
  return caps.size === 1 ? [...caps][0] : null;
}

// ── Projection ─────────────────────────────────────────────────────────────

/**
 * Per-class refuelling rate, in the unit the class plans in.
 *
 * The rig rate is fitted per CLASS and never per track (fit-strategy.js §refuel)
 * so this is where it belongs. `measured` only: a class the corpus could not
 * resolve appears in `unresolved` with the fitter's own reason, and the panel
 * falls back to the engine's estimate.
 */
function projectClasses(table, DATA, warn) {
  const byClass = {};
  const unresolved = {};

  for (const [corpusClass, entry] of Object.entries(table.refuelByClass || {})) {
    const classId = CLASS_ALIASES[corpusClass];
    if (!classId) {
      warn(`refuelByClass has class '${corpusClass}' with no entry in CLASS_ALIASES — dropped`);
      continue;
    }
    if (entry.confidence !== 'measured' || entry.refuelLPerSec == null) {
      // Keep the refusal: it is what the panel shows instead of a number.
      const reason = entry.stops === 0
        ? 'no clean fuel-only race stop recorded for this class yet'
        : `only ${entry.stops} clean fuel-only race stop${entry.stops === 1 ? '' : 's'} recorded — the fit wants 5`;
      const prev = unresolved[classId];
      if (!prev || (entry.stops || 0) > (prev.stops || 0)) {
        unresolved[classId] = { field: 'refuel', reason, stops: entry.stops || 0 };
      }
      continue;
    }

    const usesVE = DATA.classUsesVirtualEnergy(classId);
    const capacityL = capacityFor(table.rows, corpusClass);
    if (usesVE && !capacityL) {
      warn(`${corpusClass} plans in Virtual Energy but the corpus has no single tank capacity — refuel rate dropped`);
      unresolved[classId] = {
        field: 'refuel',
        reason: 'the corpus disagrees about this class’s tank size, so litres cannot be turned into energy percent',
        stops: entry.stops,
      };
      continue;
    }

    const candidate = {
      // What the engine consumes: units per second, in the class's own unit.
      // Two decimals, deliberately. The p25-p75 spread on the best-populated
      // class is 1.34-1.87 L/s, so a third decimal would be precision the
      // corpus has not earned — and the pit box steps in hundredths.
      refuelPerSec: usesVE
        ? round((entry.refuelLPerSec / capacityL) * 100, 2)
        : round(entry.refuelLPerSec, 2),
      unit: usesVE ? 'pct' : 'l',
      // What the panel shows, so the driver can sanity-check the conversion.
      refuelLPerSec: round(entry.refuelLPerSec, 3),
      capacityL: usesVE ? capacityL : null,
      from: corpusClass,
      stops: entry.stops,
      tracks: entry.tracks,
      spread: [round(entry.p25, 3), round(entry.p75, 3)],
    };

    // Two corpus classes can map to one Fuel tab class (LMP2 and LMP2_ELMS).
    // More clean stops wins; ties go to the wider track spread, because a rate
    // agreed across circuits is the one that generalises.
    const prev = byClass[classId];
    if (!prev
      || candidate.stops > prev.stops
      || (candidate.stops === prev.stops && candidate.tracks > prev.tracks)) {
      byClass[classId] = candidate;
      if (prev) warn(`${corpusClass} supersedes ${prev.from} for '${classId}' (${candidate.stops} stops vs ${prev.stops})`);
    }
  }

  // A class that resolved does not also carry a refusal.
  for (const classId of Object.keys(byClass)) delete unresolved[classId];

  // The same rates, keyed by the CORPUS class name instead.
  //
  // Live telemetry speaks canonical classes (carClass.ts: HYPERCAR, LMP2,
  // LMP2_ELMS, GT3 …) — the same vocabulary the corpus uses and a different one
  // from the Fuel tab's own ids. The Team tab is fed by the sim, so it needs
  // this door rather than the one above. Note LMP2 and LMP2_ELMS both point at
  // whichever of them won: they are different homologations sharing a refuelling
  // rig, and `from` on the entry says which one was actually measured.
  const byCorpusClass = {};
  for (const [corpusClass, classId] of Object.entries(CLASS_ALIASES)) {
    const entry = byClass[classId];
    if (entry) byCorpusClass[corpusClass] = entry;
  }

  return { byClass, byCorpusClass, unresolved };
}

/**
 * Per class-and-track coefficients.
 *
 * Only `measured` values cross over. Note the arithmetic on pit loss: the fit
 * measures `pitCycleLossSec`, the WHOLE cost of a pit cycle including the car
 * standing still, while fuel-strategy.js wants the lane loss ALONE and adds
 * service time itself. Subtracting the reference stationary time converts one
 * into the other; getting this wrong would double-count the service.
 */
function projectPairs(table, layouts, warn) {
  const byPair = {};
  const seen = new Set();

  for (const row of table.rows) {
    const layoutId = TRACK_ALIASES[row.trackKey];
    const classId = CLASS_ALIASES[row.carClass];
    if (!layoutId) { seen.add(row.trackKey); continue; }
    if (!classId) continue;

    const layout = layouts.get(layoutId);
    if (!layout) {
      warn(`TRACK_ALIASES maps '${row.trackKey}' to '${layoutId}', which the Fuel tab does not have`);
      continue;
    }
    if (row.trackLengthM && Math.abs(row.trackLengthM - layout.lengthM) > LENGTH_TOLERANCE_M) {
      warn(`'${row.trackKey}' (${row.trackLengthM} m) maps to ${layoutId} (${layout.lengthM} m) — ${Math.abs(row.trackLengthM - layout.lengthM)} m apart, check the alias`);
    }

    const conf = row.confidence || {};
    const out = {};

    if (conf.burn === 'measured' && row.burnBaseLPerLap != null) {
      out.burnLPerLap = round(row.burnBaseLPerLap, 3);
      out.burnLaps = row.n?.burnLaps ?? null;
    }
    if (conf.kFuel === 'measured' && row.kFuelSecPerL != null) {
      out.kFuelSecPerL = round(row.kFuelSecPerL, 5);
    }
    if (conf.pit === 'measured' && row.pitCycleLossSec != null && row.referenceStationarySec != null) {
      // See the docblock: cycle loss MINUS stationary time is the lane loss.
      out.pitLaneLossSec = round(row.pitCycleLossSec - row.referenceStationarySec, 2);
      out.referenceStationarySec = round(row.referenceStationarySec, 2);
      out.pitStops = row.n?.stops ?? null;
    }

    if (!Object.keys(out).length) continue;
    const key = `${layoutId}|${classId}`;
    const prev = byPair[key];
    // Same merge principle as classes: the fit backed by more laps wins.
    if (!prev || (out.burnLaps || 0) > (prev.burnLaps || 0)) byPair[key] = out;
  }

  for (const key of [...seen].sort()) {
    warn(`fitted track key '${key}' has no entry in TRACK_ALIASES — its rows are not shipped`);
  }
  return byPair;
}

// ── Emit ───────────────────────────────────────────────────────────────────

function render(payload) {
  const json = JSON.stringify(payload, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : `  ${line}`))
    .join('\n');

  return `/**
 * fuel-coefficients.js — measured strategy coefficients, for the Fuel tab.
 * -----------------------------------------------------------------------------
 * GENERATED by scripts/build-coefficients.js from data/strategy-coefficients.json.
 * Do not edit by hand: \`npm test\` re-projects the fit and fails on any drift.
 *
 * Everything here was MEASURED from the shared corpus — a coefficient the fit
 * refused is absent, and its reason sits in \`unresolved\` so the panel can say
 * why it is still showing an estimate. Rates are already in the unit their
 * class plans in (litres/second, or Virtual Energy percent/second).
 *
 * Loaded as a classic script by the panel (window.APEX_STRATEGY_COEFFS) and
 * require()d by scripts/test-coefficients.js — keep it dependency-free.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_STRATEGY_COEFFS = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  return ${json};
});
`;
}

function build(warn) {
  const table = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const DATA = loadFuelData();
  const layouts = layoutIndex(DATA);

  const { byClass, byCorpusClass, unresolved } = projectClasses(table, DATA, warn);
  const byPair = projectPairs(table, layouts, warn);

  return {
    version: 1,
    fittedAt: table.fittedAt,
    source: table.source,
    corpus: table.corpus,
    byClass,
    byCorpusClass,
    byPair,
    unresolved,
  };
}

function main() {
  const check = process.argv.includes('--check');
  const warnings = [];
  const warn = (m) => warnings.push(m);

  const payload = build(warn);
  const text = render(payload);

  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error('fuel-coefficients.js is out of date — run: node scripts/build-coefficients.js');
      process.exit(1);
    }
    console.log('fuel-coefficients.js matches the fitted table.');
    return;
  }

  fs.writeFileSync(OUT, text);

  const classes = Object.entries(payload.byClass);
  console.log(`\nfuel-coefficients.js — from a ${payload.source} fit of ${payload.corpus.laps} laps / ${payload.corpus.stops} stops (${payload.fittedAt})\n`);
  console.log('  Refuelling rate, measured:');
  if (!classes.length) console.log('    (none — every class was refused)');
  for (const [id, c] of classes) {
    const unit = c.unit === 'pct' ? '%/s' : 'L/s';
    console.log(`    ${id.padEnd(9)} ${String(c.refuelPerSec).padStart(6)} ${unit.padEnd(4)} from ${c.stops} stops across ${c.tracks} tracks${c.unit === 'pct' ? `  (${c.refuelLPerSec} L/s ÷ ${c.capacityL} L)` : ''}`);
  }
  const unres = Object.entries(payload.unresolved);
  if (unres.length) {
    console.log('\n  Still an estimate:');
    for (const [id, u] of unres) console.log(`    ${id.padEnd(9)} ${u.reason}`);
  }
  console.log(`\n  Per class-and-track entries: ${Object.keys(payload.byPair).length}`);
  if (warnings.length) {
    console.log('\n  Notes:');
    for (const w of warnings) console.log(`    - ${w}`);
  }
  console.log('');
}

if (require.main === module) main();

module.exports = { build, render, TRACK_ALIASES, CLASS_ALIASES, LENGTH_TOLERANCE_M };
