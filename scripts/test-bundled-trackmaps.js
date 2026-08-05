/**
 * scripts/test-bundled-trackmaps.js — the circuits that ship with the app.
 * -----------------------------------------------------------------------------
 * `data/trackmaps/` is the reason a driver's first session at Spa draws the
 * circuit instead of a progress bar. It is also the one part of the track-map
 * system that reaches every machine at once and is never regenerated at runtime:
 * a shape that is broken, misnamed or simply not found is broken for everybody
 * until the next release, and none of that is visible in a typecheck or in a
 * session at a track that happens to work.
 *
 * So the cases here are the ways a BUNDLE fails, which are not the ways a lap
 * fails (`test-trackmap.js` covers those):
 *
 *   - a shipped shape the loader would refuse to draw;
 *   - a shape filed under a key the running app never asks for;
 *   - the bundle not being found at all from where the app is loaded;
 *   - a shipped map winning over the driver's own;
 *   - a shipped map that the car disproves coming back on the next launch.
 *
 * Run: node scripts/test-bundled-trackmaps.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TrackMapBuilder,
  trackKey,
  loadTrackMap,
  saveTrackMap,
  builtinTrackMapDir,
  resetBuiltinTrackMapDir,
  clearRejectedTrackMaps,
} = require('../dist/telemetry/trackMap');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

/** A scratch cache directory, so no test reads or writes the real one. */
function scratch() {
  const dir = path.join(
    os.tmpdir(),
    `apex-bundle-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* --------------------------- the bundle is found -------------------------- */

const dir = builtinTrackMapDir();
check('the bundle is found from the compiled module', typeof dir === 'string' && !!dir, dir || '');
if (!dir) {
  console.log('\n0 passed, 1 failed — nothing else can be checked\n');
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json') && f !== 'index.json');
check('it holds circuits', files.length > 0, `${files.length} maps`);

/* ------------------------- every shipped map draws ------------------------ */
{
  // Held to the loader's guards, not to a weaker "it parsed" bar: being shipped
  // is not evidence of being right, and a bad shape in here is on every machine.
  const empty = scratch(); // no map of this machine's own — the bundle answers
  const bad = [];
  const misfiled = [];
  for (const file of files) {
    const key = file.replace(/\.json$/i, '');
    const map = loadTrackMap(key, empty);
    if (!map) {
      bad.push(file);
      continue;
    }
    if (map.key !== key) misfiled.push(`${file} holds key "${map.key}"`);
    // The key the app looks for is DERIVED from what the sim publishes, so a
    // file whose name is not that derivation is one nothing ever asks for.
    else if (trackKey(map.name, map.config, map.lengthM) !== key) {
      misfiled.push(`${file} is not what trackKey() derives`);
    }
    if (map && map.builtin !== true) misfiled.push(`${file} is not flagged as bundled`);
  }
  check('every shipped circuit passes the loader it will be read by', bad.length === 0, bad.join(', '));
  check('and each is filed under the key the sim will ask for', misfiled.length === 0, misfiled.join('; '));
}

/* ------------------------- the manifest is honest ------------------------- */
{
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  } catch {
    /* reported below */
  }
  const listed = manifest && Array.isArray(manifest.maps) ? manifest.maps.map((m) => m.key).sort() : null;
  const present = files.map((f) => f.replace(/\.json$/i, '')).sort();
  check(
    'the manifest lists exactly the circuits in the bundle',
    listed !== null && listed.length === present.length && listed.every((k, i) => k === present[i]),
    listed ? `${listed.length} listed / ${present.length} present` : 'no readable index.json',
  );
}

/* ---------------- a driver's own map beats the shipped one ---------------- */
{
  // The one ordering that matters. A file in the cache was either learned from
  // this driver's car or written after a shipped shape was condemned; in both
  // cases it knows something the bundle does not.
  const cache = scratch();
  const key = files[0].replace(/\.json$/i, '');
  const shipped = loadTrackMap(key, cache);
  const mine = { ...shipped, name: `${shipped.name} (mine)`, revision: 99 };
  delete mine.builtin;
  saveTrackMap(mine, cache);
  const got = loadTrackMap(key, cache);
  check(
    "the machine's own map wins over the shipped one",
    got !== null && got.name === mine.name && got.builtin !== true,
  );
}

/* ------------- a shipped map stays on screen, right or wrong -------------- */
{
  // A bundled shape used to be condemned the moment the car disagreed with it
  // for 200 m of road, with a note beside the cache so it did not come back.
  // Both are gone. The check could only ever fire on shipped maps — a map learned
  // from your own car agrees with your own car — so every cost of it landed on
  // the drivers the bundle was meant to help, who watched the circuit disappear
  // part-way through a session and not return the next time either.
  const cache = scratch();
  const key = files.find((f) => !/sarthe/.test(f)).replace(/\.json$/i, '');
  const shipped = loadTrackMap(key, cache);
  const builder = new TrackMapBuilder(cache);

  const first = builder.update({
    trackName: shipped.name,
    trackConfig: shipped.config,
    lengthM: shipped.lengthM,
    lapDistM: 0,
    pos: { x: shipped.points[0][0], y: shipped.points[0][2], z: shipped.points[0][1] },
    inPit: false,
  });
  check('a shipped circuit is drawn on the very first frame', first.ready === true, key);

  // Drive nowhere near it, for a long way — the strongest possible disagreement.
  let after = null;
  for (let d = 0; d < 400; d += 5) {
    after = builder.update({
      trackName: shipped.name,
      trackConfig: shipped.config,
      lengthM: shipped.lengthM,
      lapDistM: d,
      pos: { x: 50000, y: 0, z: 50000 },
      inPit: false,
    });
  }
  check('a shipped circuit is not taken away by the car disagreeing', after.ready === true);
  check('and it is never reported as rebuilding', after.relearning !== true);

  resetBuiltinTrackMapDir();
  check('and the next launch loads it again', loadTrackMap(key, cache) !== null);

  // A note left by one of those older builds must not go on costing the driver
  // their circuit: it is ignored on load, and swept off disk at startup.
  fs.writeFileSync(path.join(cache, `${key}.rejected`), JSON.stringify({ key, builtAt: null }), 'utf8');
  resetBuiltinTrackMapDir();
  check('a rejection note from an older build is ignored', loadTrackMap(key, cache) !== null);
  check('and swept off disk', clearRejectedTrackMaps(cache) === 1);
}

/* ------------------------ the bundle can be opted out --------------------- */
{
  const cache = scratch();
  const key = files[0].replace(/\.json$/i, '');
  process.env.APEX_BUILTIN_TRACKMAPS = '0';
  resetBuiltinTrackMapDir();
  check('APEX_BUILTIN_TRACKMAPS=0 goes back to learning from the car', loadTrackMap(key, cache) === null);
  delete process.env.APEX_BUILTIN_TRACKMAPS;
  resetBuiltinTrackMapDir();
  check('and the bundle comes back when it is not disabled', loadTrackMap(key, cache) !== null);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
