/**
 * scripts/import-trackmaps.js — bake learned circuits into the shipped app.
 * -----------------------------------------------------------------------------
 * The track map is learned from the driven car (see `src/telemetry/trackMap.ts`
 * for why it cannot be read out of the game), which used to mean every driver at
 * every new circuit spent a lap looking at a progress read instead of a map.
 * They were all learning the SAME shape: the sim's world axes are the sim's, so
 * a circuit learned on one machine lands on the cars on every other one.
 *
 * So the lap is driven once, here, and the result ships. This script is what
 * turns a folder of learned maps into that bundle:
 *
 *     node scripts/import-trackmaps.js                 # from ~/.apex-overlay/tracks
 *     node scripts/import-trackmaps.js <file|dir>...   # from anywhere
 *     node scripts/import-trackmaps.js <dir> --check   # would that source change the bundle?
 *
 * `--check` writes nothing and exits non-zero on any difference. It compares the
 * bundle against THE SOURCE IT IS GIVEN, so it answers "have I imported this
 * folder yet", not "is the bundle valid" — that second question belongs to
 * `scripts/test-bundled-trackmaps.js`, which asks it of the bundle alone.
 *
 * ## Everything is validated by the real loader, not by a copy of its rules
 * A shape that reaches the bundle is on every machine at once, so this refuses
 * far more readily than it accepts. The guards it applies are not reimplemented
 * here — it writes each candidate to a scratch directory under its own key and
 * asks `loadTrackMap()` for it, which is the exact code the app runs at startup.
 * A map this script accepts is one the app can draw, by construction, and a rule
 * added to the loader tomorrow applies here without anybody remembering to.
 *
 * On top of that it checks the one thing the loader cannot: that the file's
 * `key` is the key the running app will LOOK for. The key is derived from track
 * name, layout and lap length (`trackKey`), and a file whose name and contents
 * disagree with that derivation is a map that is never found — a silent miss,
 * which is the failure mode this whole exercise exists to remove.
 *
 * ## Duplicates are decided by shape quality, not by filename
 * The same circuit learned twice gives two files with the same key (a browser
 * download calls the second one `... (1).json`). The one that ships is the one
 * whose worst step between neighbouring points is smallest relative to its bin
 * spacing — the same measure `commit()` uses to decide whether a shape is a
 * circuit at all, so "best" here means "furthest from being rejected". Ties go
 * to the newer lap.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const OUT_DIR = path.join(REPO, 'data', 'trackmaps');
const MANIFEST = path.join(OUT_DIR, 'index.json');

// The loader falls back to the bundle when a key is missing from the directory
// it was given — which here would quietly pass a candidate on the strength of
// the map it is meant to REPLACE. Nothing in this script may consult the bundle.
process.env.APEX_BUILTIN_TRACKMAPS = '0';

let loadTrackMap;
let trackKey;
try {
  ({ loadTrackMap, trackKey } = require('../dist/telemetry/trackMap'));
} catch {
  console.error('Build first: npm run build   (this script validates with the compiled loader)');
  process.exit(2);
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const quiet = args.includes('--quiet');
const sources = args.filter((a) => !a.startsWith('--'));

/* -------------------------------------------------------------------------- */
/*  Gathering                                                                  */
/* -------------------------------------------------------------------------- */

/** Every `.json` under the given files/directories (one level; maps are flat). */
function gather(inputs) {
  const out = [];
  for (const input of inputs) {
    let st;
    try {
      st = fs.statSync(input);
    } catch {
      console.error(`  skip  ${input} — not found`);
      continue;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(input).sort()) {
        if (name.toLowerCase().endsWith('.json') && name !== 'index.json') {
          out.push(path.join(input, name));
        }
      }
    } else if (input.toLowerCase().endsWith('.json')) {
      out.push(input);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** A scratch directory the loader can be pointed at without touching the cache. */
function scratch() {
  const dir = path.join(os.tmpdir(), `apex-trackmap-import-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The worst straight-line step between neighbouring points, closing the loop. */
function largestGap(points) {
  let worst = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Read one candidate and decide whether it may ship.
 *
 * Returns `{ map, gapRatio }` or `{ error }`. The loader is asked LAST, so its
 * verdict is reported against a file that is otherwise well-formed.
 */
function inspect(file, tmp) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: `unreadable JSON (${err.message})` };
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.points)) {
    return { error: 'not a track map (no points array)' };
  }
  if (typeof raw.key !== 'string' || !raw.key) return { error: 'no key' };
  if (typeof raw.name !== 'string' || !raw.name) return { error: 'no track name' };
  if (!Number.isFinite(raw.lengthM)) return { error: 'no lap length' };

  // The key the RUNNING APP will look for. A file that disagrees is never found.
  const derived = trackKey(raw.name, raw.config, raw.lengthM);
  if (derived !== raw.key) {
    return { error: `key "${raw.key}" is not what trackKey() derives ("${derived}")` };
  }

  const binM = Number.isFinite(raw.binM) && raw.binM > 0 ? raw.binM : raw.lengthM / raw.points.length;
  const gap = largestGap(raw.points);

  // The app's own guards, run by the app's own loader.
  const probe = path.join(tmp, `${raw.key}.json`);
  fs.writeFileSync(probe, JSON.stringify(raw), 'utf8');
  const loaded = loadTrackMap(raw.key, tmp);
  fs.rmSync(probe, { force: true });
  if (!loaded) return { error: 'rejected by loadTrackMap() — not a drawable circuit' };

  return {
    gapRatio: gap / binM,
    map: {
      key: raw.key,
      name: raw.name,
      ...(raw.config ? { config: raw.config } : {}),
      lengthM: raw.lengthM,
      halfWidthM: raw.halfWidthM,
      binM: Math.round(binM * 100) / 100,
      points: raw.points,
      builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : new Date().toISOString(),
      // Session-local counters mean nothing in a bundle: the builder stamps its
      // own the moment it publishes this shape (see `publish()`).
      revision: 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Import                                                                     */
/* -------------------------------------------------------------------------- */

function main() {
  const inputs = sources.length ? sources : [path.join(os.homedir(), '.apex-overlay', 'tracks')];
  const files = gather(inputs);
  if (!files.length) {
    console.error(`No .json files found in: ${inputs.join(', ')}`);
    process.exit(2);
  }

  const tmp = scratch();
  const best = new Map(); // key -> { map, gapRatio, file }
  let rejected = 0;
  const notes = [];

  for (const file of files) {
    const label = path.basename(file);
    const res = inspect(file, tmp);
    if (res.error) {
      rejected++;
      notes.push(`  REJECT  ${label} — ${res.error}`);
      continue;
    }
    const prev = best.get(res.map.key);
    if (!prev) {
      best.set(res.map.key, { ...res, file: label });
      continue;
    }
    // Same circuit twice: the smoother shape wins, newer lap breaks a tie.
    const better =
      res.gapRatio < prev.gapRatio - 1e-9 ||
      (Math.abs(res.gapRatio - prev.gapRatio) <= 1e-9 &&
        String(res.map.builtAt) > String(prev.map.builtAt));
    notes.push(
      `  dedupe  ${res.map.key} — ${better ? label : prev.file} kept ` +
        `(gap/bin ${(better ? res.gapRatio : prev.gapRatio).toFixed(2)} vs ` +
        `${(better ? prev.gapRatio : res.gapRatio).toFixed(2)})`,
    );
    if (better) best.set(res.map.key, { ...res, file: label });
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  const keys = [...best.keys()].sort();
  const manifest = {
    // What the bundle covers, for the app to show and for tests to check
    // against the directory. Deliberately holds no timestamp: a regenerated
    // bundle with the same maps in it should be a no-op in the diff.
    maps: keys.map((k) => {
      const m = best.get(k).map;
      return {
        key: m.key,
        name: m.name,
        ...(m.config ? { config: m.config } : {}),
        lengthM: m.lengthM,
        halfWidthM: m.halfWidthM,
        binM: m.binM,
        points: m.points.length,
        builtAt: m.builtAt,
      };
    }),
  };

  const files_ = new Map(keys.map((k) => [`${k}.json`, JSON.stringify(best.get(k).map)]));
  files_.set('index.json', `${JSON.stringify(manifest, null, 2)}\n`);

  if (check) {
    const drift = [];
    let existing = [];
    try {
      existing = fs.readdirSync(OUT_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
    } catch {
      drift.push('data/trackmaps does not exist');
    }
    for (const name of existing) if (!files_.has(name)) drift.push(`stale: ${name}`);
    for (const [name, body] of files_) {
      let cur = null;
      try {
        cur = fs.readFileSync(path.join(OUT_DIR, name), 'utf8');
      } catch {
        drift.push(`missing: ${name}`);
        continue;
      }
      if (cur !== body) drift.push(`differs: ${name}`);
    }
    if (drift.length) {
      console.error('Bundle is out of date:');
      for (const d of drift) console.error(`  ${d}`);
      console.error('Run: npm run trackmaps:import');
      process.exit(1);
    }
    console.log(`Bundle is up to date — ${keys.length} circuits.`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (name.toLowerCase().endsWith('.json') && !files_.has(name)) {
      fs.rmSync(path.join(OUT_DIR, name), { force: true });
      notes.push(`  remove  ${name} — no longer in the source set`);
    }
  }
  let bytes = 0;
  for (const [name, body] of files_) {
    fs.writeFileSync(path.join(OUT_DIR, name), body, 'utf8');
    bytes += Buffer.byteLength(body);
  }

  if (!quiet) {
    for (const n of notes) console.log(n);
    for (const k of keys) {
      const { map } = best.get(k);
      console.log(
        `  bake    ${k.padEnd(44)} ${String(map.points.length).padStart(5)} pts  ` +
          `${(map.lengthM / 1000).toFixed(2)} km`,
      );
    }
  }
  console.log(
    `\nBundled ${keys.length} circuits (${(bytes / 1024).toFixed(0)} KB) into data/trackmaps` +
      (rejected ? ` — ${rejected} rejected` : ''),
  );
}

main();
