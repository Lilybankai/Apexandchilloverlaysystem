/**
 * scripts/probe-lmu-grip.js — find where LMU publishes the TRACK GRIP level.
 * -----------------------------------------------------------------------------
 * The in-game MFD shows a track grip / rubbering-in readout. The overlay's
 * weather widget deliberately does not, because when the track-condition block
 * was built (v0.28.0) nothing published it: `/rest/watch/sessionInfo` carries
 * wetness and temperatures only, and the `Extended` / `PitInfo` shared-memory
 * blocks read empty.
 *
 * That search was too narrow. It predates the discovery that LMU's own UI is a
 * web app served by the SAME server on :6397 — which is how
 * `/rest/garage/UIScreen/TireManagement` turned up carrying the sim's per-compound
 * optimal tyre temperatures, a number that had also been assumed unpublished.
 * Whatever the MFD renders, it fetched from somewhere on this port.
 *
 * So this probe does not guess endpoint names. It reads the Swagger spec, GETs
 * every parameterless endpoint in it, and walks each response looking for:
 *
 *   - keys whose NAME is grip-shaped (grip, rubber, marble, surface, track state)
 *   - keys whose VALUE looks like a grip figure sitting near a known one, so a
 *     field called something unexpected still shows up
 *
 * Run it TWICE — once in the garage and once after a stint's running — and
 * diff: rubbering-in is the thing that changes as a session runs, so a field that
 * moved between the two is the field, and one that did not is a setup constant.
 *
 * Usage — start LMU, load into a session, then:
 *
 *   node scripts/probe-lmu-grip.js                  # scan, print candidates
 *   node scripts/probe-lmu-grip.js --all            # print every numeric 0..1 / 0..100 too
 *   node scripts/probe-lmu-grip.js --save before.json
 *   node scripts/probe-lmu-grip.js --diff before.json
 *
 * Read-only throughout: it issues nothing but GETs.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', 6397));
const ALL = process.argv.includes('--all');
const SAVE = argOf('--save', null);
const DIFF = argOf('--diff', null);

/** Swagger spec locations, newest ASP.NET conventions first. */
const SWAGGER_PATHS = ['/swagger-schema.json', '/swagger/v1/swagger.json', '/swagger.json'];

/**
 * Endpoints worth trying even if the spec does not list them.
 *
 * The spec has been complete every time it was read, but the TireManagement find
 * came from a UIScreen path, and that family is where a track-state screen would
 * live if the MFD has one.
 */
const EXTRA_PATHS = [
  '/rest/watch/sessionInfo',
  '/rest/sessions',
  '/rest/garage/UIScreen/TireManagement',
  '/rest/garage/UIScreen/RaceInfo',
  '/rest/garage/UIScreen/TrackInfo',
  '/rest/garage/UIScreen/Weather',
  '/rest/garage/UIScreen/OverviewInformation',
  '/rest/garage/UIScreen/DriverInfo',
  '/rest/garage/track',
  '/rest/garage/trackInfo',
  '/rest/watch/trackInfo',
  '/rest/watch/weather',
];

/** Key names that would BE the thing. Matched case-insensitively, anywhere. */
const NAME_HINTS =
  /grip|rubber|marble|dirt|dust|greentrack|track.?state|track.?condition|surface|usage|laid|worn/i;

/** Values in these ranges are grip-shaped; used only with --all. */
const isFraction = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const isPercent = (v) => typeof v === 'number' && v > 1 && v <= 100;

function get(path) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path, timeout: 6000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ status: res.statusCode, json: null });
          try {
            resolve({ status: 200, json: JSON.parse(body), bytes: body.length });
          } catch {
            resolve({ status: 200, json: null, bytes: body.length });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, json: null });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
  });
}

/** Walk a JSON tree, yielding every `path -> primitive` leaf. */
function* leaves(node, path = '') {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    // Arrays of objects are indexed; long arrays of numbers are summarised.
    for (let i = 0; i < node.length && i < 8; i++) yield* leaves(node[i], `${path}[${i}]`);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) yield* leaves(v, path ? `${path}.${k}` : k);
    return;
  }
  yield [path, node];
}

async function main() {
  console.log(`\nProbing LMU REST on 127.0.0.1:${PORT} for a track-grip channel.\n`);

  // --- 1. every path the spec knows, plus the hand-picked extras -------------
  const paths = new Set(EXTRA_PATHS);
  let spec = null;
  for (const p of SWAGGER_PATHS) {
    const r = await get(p);
    if (r.json) {
      spec = r.json;
      console.log(`  swagger: ${p}`);
      break;
    }
  }
  if (spec && spec.paths) {
    for (const [path, ops] of Object.entries(spec.paths)) {
      // Parameterless GETs only — anything with a {placeholder} needs an id we
      // do not have, and a POST is not something a probe should be firing.
      if (!ops || typeof ops !== 'object' || !ops.get) continue;
      if (path.includes('{')) continue;
      paths.add(path);
    }
    console.log(`  ${Object.keys(spec.paths).length} paths in the spec`);
  } else {
    console.log('  swagger: NOT FOUND — falling back to the known-endpoint list');
  }
  console.log(`  ${paths.size} endpoints to scan\n`);

  // --- 2. fetch them all and collect every leaf -----------------------------
  const snapshot = {};
  const named = [];
  const numeric = [];
  let reached = 0;

  for (const path of [...paths].sort()) {
    const r = await get(path);
    if (r.status !== 200 || !r.json) continue;
    reached++;
    for (const [key, value] of leaves(r.json)) {
      const full = `${path} → ${key}`;
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        snapshot[full] = value;
      }
      if (NAME_HINTS.test(key)) named.push([full, value]);
      else if (ALL && (isFraction(value) || isPercent(value))) numeric.push([full, value]);
    }
  }
  console.log(`  ${reached} endpoints answered\n`);

  // --- 3. report ------------------------------------------------------------
  console.log('NAME MATCHES (grip / rubber / surface / track-state shaped keys)');
  if (!named.length) console.log('  — none —');
  for (const [k, v] of named) console.log(`  ${k} = ${JSON.stringify(v)}`);

  if (ALL) {
    console.log('\nNUMERIC CANDIDATES (0..1 fractions and 1..100 percentages)');
    for (const [k, v] of numeric) console.log(`  ${k} = ${v}`);
  }

  // --- 4. save / diff -------------------------------------------------------
  if (SAVE) {
    fs.writeFileSync(SAVE, JSON.stringify(snapshot, null, 1));
    console.log(`\nSnapshot of ${Object.keys(snapshot).length} leaves written to ${SAVE}`);
    console.log('Run a stint, then: node scripts/probe-lmu-grip.js --diff ' + SAVE);
  }

  if (DIFF) {
    let before;
    try {
      before = JSON.parse(fs.readFileSync(DIFF, 'utf8'));
    } catch (err) {
      console.log(`\nCould not read ${DIFF}: ${err.message}`);
      return;
    }
    console.log(`\nCHANGED SINCE ${DIFF} — a rubbering-in figure MUST be in here`);
    let moved = 0;
    for (const [k, v] of Object.entries(snapshot)) {
      if (!(k in before)) continue; // new keys are noise (menus change shape)
      if (before[k] === v) continue;
      // Temperatures, clocks and fuel move constantly; they are not what we want,
      // but printing them costs nothing and hiding them risks hiding the answer.
      console.log(`  ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(v)}`);
      moved++;
    }
    if (!moved) console.log('  — nothing moved —');
  }

  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
