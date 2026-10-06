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
 *   3. **Every rate ships in the unit its class plans in, and is MEASURED in
 *      it.** Litre classes get litres per second. LMGT3 and Hypercar plan in
 *      Virtual Energy percent, and get the energy rate the fitter measured
 *      directly from energy added (`refuelByClass[c].ve`). This used to be a
 *      conversion, `(L/s ÷ fuel tank) × 100`, and that was wrong: 100 % of
 *      energy is ~82 L of a GT3's fuel, not the 120 L tank, and litres per
 *      second varies by car (fuel ratio) where energy per second does not. The
 *      conversion priced a GT3 refuel at roughly twice its real length.
 *
 *   4. **Pit lane loss is per circuit, class-free** (`byLayout` for the Fuel
 *      tab, `byTrackKey` for anything keyed like the lap log). It is the
 *      fitter's `pitLaneByTrack` — measured race stops' lane time minus their
 *      stationary time — and below its sample bar the circuit is simply absent,
 *      so the planner falls back to its estimate.
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
  'aut-dromo-jos-carlos-pace_4273': 'interlagos_gp',
  'autodromo-enzo-e-dino-ferrari_4901': 'imola_gp',
  'autodromo-nazionale-monza_5781': 'monza_gp',
  'bahrain-international-circuit_5387': 'bahrain_gp',
  'circuit-de-barcelona_4655': 'barcelona_gp',
  'circuit-de-la-sarthe_13624': 'lemans_full',
  'circuit-de-spa-francorchamps_6982': 'spa_gp',
  'circuit-de-spa-francorchamps-endurance_6982': 'spa_endurance',
  'circuit-of-the-americas_5497': 'cota_gp',
  'daytona-international-speedway-road-course_5734': 'daytona_road',
  'fuji-speedway_4536': 'fuji_gp',
  'fuji-speedway-classic_4502': 'fuji_classic',
  'grand-prix-of-long-beach_3187': 'long_beach',
  'michelin-raceway-road-atlanta_4083': 'road_atlanta',
  'lusail-international-circuit_5405': 'qatar_gp',
  'lusail-short-circuit_3676': 'qatar_short',
  'monza-curva-grande-circuit_5745': 'monza_curva_grande',
  'paul-ricard-1a_5699': 'paul_ricard_1a',
  'paul-ricard-1a-v2_5758': 'paul_ricard_1av2',
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
    // A Virtual Energy class is priced from the ENERGY fit and nothing else —
    // its litres-per-second number is the car's fuel ratio talking, not the rig.
    const usesVE = DATA.classUsesVirtualEnergy(classId);
    const fit = usesVE
      ? (entry.ve && entry.ve.confidence === 'measured' && entry.ve.pctPerSec != null
        ? { rate: entry.ve.pctPerSec, fixed: entry.ve.fixedSec || 0, stops: entry.ve.stops, tracks: entry.ve.tracks, p25: entry.ve.p25, p75: entry.ve.p75 }
        : null)
      : (entry.confidence === 'measured' && entry.refuelLPerSec != null
        ? { rate: entry.refuelLPerSec, fixed: 0, stops: entry.stops, tracks: entry.tracks, p25: entry.p25, p75: entry.p75 }
        : null);

    if (!fit) {
      // Keep the refusal: it is what the panel shows instead of a number.
      const stops = (usesVE ? entry.ve && entry.ve.stops : entry.stops) || 0;
      const reason = stops === 0
        ? 'no clean fuel-only race stop recorded for this class yet'
        : `only ${stops} clean fuel-only race stop${stops === 1 ? '' : 's'} recorded — the fit wants 5`;
      const prev = unresolved[classId];
      if (!prev || stops > (prev.stops || 0)) {
        unresolved[classId] = { field: 'refuel', reason, stops };
      }
      continue;
    }

    const candidate = {
      // What the engine consumes: units per second, in the class's own unit.
      // Two decimals, deliberately: the pit box steps in hundredths, and the
      // middle half of the best-populated class spans 2.45-2.48 %/s, so a
      // third decimal would be precision the corpus has not earned.
      refuelPerSec: round(fit.rate, 2),
      unit: usesVE ? 'pct' : 'l',
      // Hose on, hose off: paid once per stop that takes fuel. Zero where the
      // fit could not carry it (always, for the litre classes).
      refuelFixedSec: round(fit.fixed, 1),
      from: corpusClass,
      stops: fit.stops,
      tracks: fit.tracks,
      spread: [round(fit.p25, 3), round(fit.p75, 3)],
    };
    // Tyre change time rides on the class: it is what a tyre stop holds beyond
    // the fuel at THIS rate, so it only exists where the rate does.
    if (entry.tyre && entry.tyre.confidence === 'measured' && entry.tyre.tyreChangeSec != null) {
      candidate.tyreChangeSec = round(entry.tyre.tyreChangeSec, 1);
      candidate.tyreStops = entry.tyre.stops;
      candidate.tyreSpread = [round(entry.tyre.p25, 1), round(entry.tyre.p75, 1)];
    }

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
 * Per class-and-track coefficients: burn and kFuel.
 *
 * Only `measured` values cross over. Pit lane loss used to be derived here
 * from the row's `pitCycleLossSec` minus its stationary time; it no longer
 * is. Those two numbers come from different stops (unmatched in-lap and
 * out-lap medians against a stop median) and disagreed badly — Monza came out
 * at 6.8 s of lane. The lane is now its own per-circuit fit: projectLanes().
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

/**
 * Pit lane loss per circuit, class-free.
 *
 * Two doors onto the same numbers: `byLayout` (the Fuel tab's layout ids, via
 * TRACK_ALIASES) and `byTrackKey` (the lap log's own keys, which is what live
 * telemetry can derive). `measured` only — a circuit under the fitter's sample
 * bar is absent, and the planner keeps its estimate there. Two track keys can
 * share a layout (Silverstone ELMS and WEC); the one with more stops wins.
 */
function projectLanes(table, layouts) {
  const byLayout = {};
  const byTrackKey = {};
  for (const [trackKey, lane] of Object.entries(table.pitLaneByTrack || {})) {
    if (lane.confidence !== 'measured' || lane.laneSec == null) continue;
    const entry = {
      pitLaneLossSec: round(lane.laneSec, 1),
      spread: [round(lane.p25, 1), round(lane.p75, 1)],
      stops: lane.stops,
      drivers: lane.drivers,
    };
    byTrackKey[trackKey] = entry;
    const layoutId = TRACK_ALIASES[trackKey];
    if (!layoutId || !layouts.has(layoutId)) continue;
    const prev = byLayout[layoutId];
    if (!prev || entry.stops > prev.stops) byLayout[layoutId] = entry;
  }
  return { byLayout, byTrackKey };
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
 * why it is still showing an estimate. Rates are measured in the unit their
 * class plans in (litres/second, or Virtual Energy percent/second), with
 * \`refuelFixedSec\` paid once per stop that takes fuel. Pit lane loss is per
 * circuit: \`byLayout\` (Fuel tab ids) and \`byTrackKey\` (lap-log keys).
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
  const { byLayout, byTrackKey } = projectLanes(table, layouts);

  return {
    version: 1,
    fittedAt: table.fittedAt,
    source: table.source,
    corpus: table.corpus,
    byClass,
    byCorpusClass,
    byPair,
    byLayout,
    byTrackKey,
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
    console.log(`    ${id.padEnd(9)} ${String(c.refuelPerSec).padStart(6)} ${unit.padEnd(4)} from ${c.stops} stops across ${c.tracks} tracks${c.refuelFixedSec ? `  (+ ${c.refuelFixedSec} s per stop)` : ''}${c.tyreChangeSec != null ? `  · tyres ${c.tyreChangeSec} s from ${c.tyreStops} stops` : ''}`);
  }
  const lanes = Object.entries(payload.byLayout);
  console.log(`\n  Pit lane loss, measured (${lanes.length} layouts; ${Object.keys(payload.byTrackKey).length} track keys):`);
  for (const [id, l] of lanes) {
    console.log(`    ${id.padEnd(20)} ${String(l.pitLaneLossSec).padStart(5)} s  (${l.spread[0]}–${l.spread[1]})  from ${l.stops} stops`);
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
