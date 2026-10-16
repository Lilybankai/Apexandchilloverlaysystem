/**
 * scripts/census-svm-ladders.js — ladder evidence from the setups already on disk.
 * -----------------------------------------------------------------------------
 * Every .svm LMU writes carries BOTH halves of a ladder rung on each line:
 *
 *   RearBrakeSetting=31//49.3:50.7
 *                    ^^ ^^^^^^^^^
 *                    the step index the REST API uses, and the sim's own label
 *
 * So a folder of saved setups is a free, read-only census of which way every
 * index runs, car by car — no garage writes, no sim running. This script walks
 * the given folders (default: the LMU Settings tree and the app's own setup
 * library), maps each line to its REST key through src/telemetry/svmMap.ts,
 * and writes the distinct (index → label) rungs per car to
 *
 *   scripts/fixtures/svm-ladders.json
 *
 * which scripts/test-setup.js checks electron/control-panel/setup-directions.js
 * against: every family whose labels parse must run the way the table says.
 *
 * Only ladder facts are kept — the car's class string, key, index and label.
 * No setup names, file names, track names or notes leave the source files.
 *
 * Usage:
 *   npm run build                              (svmMap + carClass come from dist/)
 *   node scripts/census-svm-ladders.js         default folders
 *   node scripts/census-svm-ladders.js <dir>…  any folders of .svm files
 *
 * It complements scripts/probe-setup-ladders.js rather than replacing it: a
 * census only sees the rungs somebody happened to save, the probe walks every
 * rung of the car in the garage.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { svmKeyFor } = require('../dist/telemetry/svmMap.js');
const { normalizeClass, CLASS_ORDER } = require('../dist/telemetry/carClass.js');

const OUT = path.join(__dirname, 'fixtures', 'svm-ladders.json');

function defaultRoots() {
  const roots = [];
  const steam = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Le Mans Ultimate\\UserData\\player\\Settings';
  if (fs.existsSync(steam)) roots.push(steam);
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const lib = path.join(appData, 'apex-overlay-system');
  if (fs.existsSync(lib)) roots.push(lib);
  return roots;
}

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.svm$/i.test(e.name)) out.push(p);
  }
}

/** "BMW_M4_LMGT3 GT3 WEC2025" → "GT3": the first token normalizeClass knows. */
function classOf(vehicleClass) {
  for (const tok of String(vehicleClass).split(/\s+/)) {
    const c = normalizeClass(tok);
    if (c && CLASS_ORDER.includes(c)) return c;
  }
  return '';
}

/** One key's rungs per line — a third of the size of indented JSON, and still diffable. */
function compact(doc) {
  const lines = ['{', ` "about": ${JSON.stringify(doc.about)},`, ` "files": ${doc.files},`, ' "cars": {'];
  const names = Object.keys(doc.cars);
  names.forEach((name, ci) => {
    const car = doc.cars[name];
    lines.push(`  ${JSON.stringify(name)}: {`, `   "class": ${JSON.stringify(car.class)},`, '   "keys": {');
    const keys = Object.keys(car.keys);
    keys.forEach((k, ki) => {
      lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(car.keys[k])}${ki < keys.length - 1 ? ',' : ''}`);
    });
    lines.push('   }', `  }${ci < names.length - 1 ? ',' : ''}`);
  });
  lines.push(' }', '}', '');
  return lines.join('\n');
}

function main() {
  const roots = process.argv.slice(2).length ? process.argv.slice(2) : defaultRoots();
  if (!roots.length) {
    console.error('No folders given and no LMU Settings folder found — pass one or more folders of .svm files.');
    process.exit(1);
  }
  const files = [];
  for (const r of roots) walk(r, files);

  const cars = {};
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    let section = '';
    let vehicleClass = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const sec = /^\[([A-Z0-9]+)\]$/.exec(line);
      if (sec) {
        section = sec[1];
        continue;
      }
      const vc = /^VehicleClassSetting="([^"]*)"/.exec(line);
      if (vc) {
        vehicleClass = vc[1];
        continue;
      }
      const kv = /^([A-Za-z0-9]+)=(-?\d+)\/\/(.*)$/.exec(line);
      if (!kv || !vehicleClass) continue;
      const key = svmKeyFor(section, kv[1]);
      if (!key) continue;
      const car = (cars[vehicleClass] ??= { class: classOf(vehicleClass), keys: {} });
      (car.keys[key] ??= {})[kv[2]] = kv[3];
    }
  }

  // Stable output: cars, keys and rungs all sorted, so a re-run diffs cleanly.
  const sorted = {};
  for (const name of Object.keys(cars).sort()) {
    const keys = {};
    for (const k of Object.keys(cars[name].keys).sort()) {
      const rungs = cars[name].keys[k];
      keys[k] = Object.fromEntries(
        Object.keys(rungs)
          .map(Number)
          .sort((a, b) => a - b)
          .map((i) => [String(i), rungs[i]]),
      );
    }
    sorted[name] = { class: cars[name].class, keys };
  }

  const doc = {
    about:
      'Index → label rungs read from saved .svm setups (scripts/census-svm-ladders.js). ' +
      'Ladder facts only: no setup, file or track names.',
    files: files.length,
    cars: sorted,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, compact(doc));
  const byClass = {};
  for (const c of Object.values(sorted)) byClass[c.class || '?'] = (byClass[c.class || '?'] || 0) + 1;
  console.log(`${files.length} setups, ${Object.keys(sorted).length} cars (${JSON.stringify(byClass)}) → ${OUT}`);
}

main();
