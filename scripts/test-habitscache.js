/**
 * scripts/test-habitscache.js — the per-lap feature cache behind "Your driving"
 * (src/telemetry/drivingHabitsLoad.ts).
 * -----------------------------------------------------------------------------
 * The cache is what makes the habits view affordable (on the dev PC 69 MB of
 * traces; a cold pass over the biggest track ~0.2–0.3 s, a warm one ~12 ms).
 * Its failure modes are silent — a cache that re-parses everything every
 * time looks exactly like one that works, only slower; one that never
 * re-extracts after the maths change serves stale numbers for ever — so:
 *
 *   §1 a cold load extracts every traced lap once and writes the cache where
 *      an app update cannot touch it (~/.apex-overlay/coach/<trackKey>.json);
 *   §2 a warm load parses no lap (one trace: the corner reference);
 *   §3 a new lap → only that lap is extracted;
 *   §4 a cache from another FEATURE_VERSION is thrown away and every lap is
 *      extracted again; a torn cache file is rebuilt, not fatal;
 *   §5 a lap whose trace is missing is remembered as such and not re-read;
 *   §6 ended practice sessions keep their accuracy; the report has the
 *      contract's shape and the reference-fallback note;
 *   §7 two loads at once share one pass.
 *
 * Laps are real (scripts/fixtures/trace-road-atlanta-gt3.json), written into a
 * throwaway lap log + trace store under the OS temp dir.
 *
 * Run: node scripts/test-habitscache.js (build first)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadDrivingHabits, habitsCacheFile, habitsCacheDir } = require('../dist/telemetry/drivingHabitsLoad');
const { FEATURE_VERSION } = require('../dist/telemetry/drivingHabits');
const { traceFilePath } = require('../dist/telemetry/lapTrace');

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

const FIX = require('./fixtures/trace-road-atlanta-gt3.json');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-habits-'));
const LAPS = path.join(ROOT, 'laps');
const TRACES = path.join(ROOT, 'traces');
const CACHE = path.join(ROOT, 'coach');
fs.mkdirSync(LAPS, { recursive: true });

/** A copy of the fixture trace with the clock stretched by `k` (a slower lap). */
function traceScaled(k) {
  const tr = {};
  for (const [key, v] of Object.entries(FIX.trace)) tr[key] = Array.isArray(v) ? v.slice() : v;
  tr.t = tr.t.map((t) => t * k);
  tr.lapSec = FIX.trace.lapSec * k;
  return tr;
}

let seq = 0;
const T0 = Date.parse('2026-10-20T10:00:00.000Z');
/** Append one lap (and, unless `noTrace`, its trace) to the throwaway store. */
function addLap({ k = 1, minutes, sessionType = 'practice', noTrace = false } = {}) {
  seq++;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const lapMs = Math.round(FIX.lapMs * k);
  const at = new Date(T0 + (minutes ?? seq * 1.6) * 60_000).toISOString();
  const rec = {
    v: 7, id, at, sim: 'lmu', track: FIX.track, trackKey: FIX.trackKey, trackLengthM: FIX.trackLengthM,
    car: FIX.car, carClass: FIX.carClass, lapMs, distanceM: FIX.trackLengthM, sessionType,
    clean: true, dirty: [], wet: false, wetness: 0, condition: 'dry',
  };
  fs.appendFileSync(path.join(LAPS, `${at.slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n');
  if (!noTrace) {
    const p = traceFilePath(id, at, TRACES);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      v: 2, lapId: id, at, sim: 'lmu', trackKey: FIX.trackKey, track: FIX.track, trackLengthM: FIX.trackLengthM,
      car: FIX.car, carClass: FIX.carClass, lapMs, trace: traceScaled(k),
    }));
  }
  return id;
}

// An empty catalogue folder: the fixture is Road Atlanta, which ships a
// catalogue, and these sections pin the reference fallback. §6 also loads
// the shipped one.
const NO_CATALOG = path.join(ROOT, 'no-catalog');
fs.mkdirSync(NO_CATALOG, { recursive: true });
const deps = (onStats) => ({ lapDir: LAPS, traceDir: TRACES, cacheDir: CACHE, cornerDir: NO_CATALOG, onStats });
async function load(now = Date.parse('2026-10-29T12:00:00.000Z')) {
  let stats = null;
  const report = await loadDrivingHabits({ trackKey: FIX.trackKey, carClass: FIX.carClass }, deps((s) => (stats = s)), now);
  return { report, stats };
}

(async () => {
  try {
    // One practice session of six laps, a bit of scatter.
    const ks = [1.012, 1.004, 1.0, 1.006, 1.002, 1.009];
    ks.forEach((k) => addLap({ k }));

    /* §1 cold */
    console.log('\n§1 cold load');
    const cold = await load();
    check('a report comes back', cold.report && Array.isArray(cold.report.trend));
    check('every traced lap extracted once (6)', cold.stats.extracted === 6, JSON.stringify(cold.stats));
    check('the cache file is written', cold.stats.cacheWritten && fs.existsSync(habitsCacheFile(FIX.trackKey, CACHE)));
    const file = JSON.parse(fs.readFileSync(habitsCacheFile(FIX.trackKey, CACHE), 'utf8'));
    check('…keyed by FEATURE_VERSION and lap id', file.v === FEATURE_VERSION && Object.keys(file.laps).length === 6);
    check('…with corner features cut by a corner key', Object.values(file.laps).every((l) => typeof l.ck === 'string' && Array.isArray(l.c)));
    check('the default cache lives beside the lap log, not in the app folder', habitsCacheDir() === path.join(os.homedir(), '.apex-overlay', 'coach'));
    check('a track key is a safe file name', path.basename(habitsCacheFile('a/b:c', CACHE)) === 'a_b_c.json');

    /* §2 warm */
    console.log('\n§2 warm load');
    const warm = await load();
    check('nothing extracted', warm.stats.extracted === 0 && warm.stats.cornerCut === 0, JSON.stringify(warm.stats));
    check('at most one trace read (the corner reference)', warm.stats.tracesRead <= 1, warm.stats.tracesRead);
    check('nothing written', warm.stats.cacheWritten === false);
    check('same report', JSON.stringify(warm.report) === JSON.stringify(cold.report));

    /* §3 incremental */
    console.log('\n§3 a new lap');
    addLap({ k: 1.003 });
    const inc = await load();
    check('only the new lap is extracted', inc.stats.extracted === 1, JSON.stringify(inc.stats));
    check('the report counts it', inc.report.laps === 7);

    /* §4 version bump / torn file */
    console.log('\n§4 version bump');
    const f2 = JSON.parse(fs.readFileSync(habitsCacheFile(FIX.trackKey, CACHE), 'utf8'));
    f2.v = FEATURE_VERSION - 1;
    fs.writeFileSync(habitsCacheFile(FIX.trackKey, CACHE), JSON.stringify(f2));
    const bumped = await load();
    check('a cache from another FEATURE_VERSION → every lap re-extracted', bumped.stats.extracted === 7, JSON.stringify(bumped.stats));
    check('…and rewritten at the current version', JSON.parse(fs.readFileSync(habitsCacheFile(FIX.trackKey, CACHE), 'utf8')).v === FEATURE_VERSION);
    fs.writeFileSync(habitsCacheFile(FIX.trackKey, CACHE), '{"v":1,"laps":{');
    const torn = await load();
    check('a torn cache is rebuilt, not fatal', torn.report && torn.stats.extracted === 7);
    check('no temp file left behind', fs.readdirSync(CACHE).every((n) => n.endsWith('.json')));

    /* §5 missing trace */
    console.log('\n§5 a lap with no trace');
    addLap({ k: 1.001, noTrace: true });
    const miss = await load();
    check('a traceless lap is looked for once', miss.stats.extracted === 1);
    const missAgain = await load();
    check('…and remembered: not looked for again', missAgain.stats.extracted === 0 && missAgain.stats.tracesRead <= 1, JSON.stringify(missAgain.stats));

    /* §6 accuracy + shape */
    console.log('\n§6 accuracy and shape');
    const r = missAgain.report;
    check('one practice session, accuracy kept for it', r.trend.length === 1 && typeof r.trend[0].accuracy === 'number', r.trend[0].accuracy);
    check('the ended session\'s accuracy is cached', missAgain.stats.accuracyBuilt === 0);
    check('contract shape: trend / corners / lap / facts', Array.isArray(r.corners) && Array.isArray(r.lap) && Array.isArray(r.facts) && r.sessions === 1);
    check('stub catalogue → reference fallback, said so', r.cornerSource === 'reference' && typeof r.cornerNote === 'string' && r.corners.length > 0, `${r.cornerSource}, ${r.corners.length} corners`);
    check('per-corner laps from that session', r.corners.every((c) => c.laps === 7), r.corners.map((c) => c.laps).join(','));
    // A session still being driven (its last lap under SESSION_GAP_MS ago):
    // scored every time, never remembered — another lap could still join it.
    const liveDeps = (cb) => ({ ...deps(cb), cacheDir: path.join(ROOT, 'coach-live') });
    const nowLive = Date.parse('2026-10-20T10:20:00.000Z');
    let s1 = null;
    let s2 = null;
    await loadDrivingHabits({ trackKey: FIX.trackKey, carClass: FIX.carClass }, liveDeps((s) => (s1 = s)), nowLive);
    await loadDrivingHabits({ trackKey: FIX.trackKey, carClass: FIX.carClass }, liveDeps((s) => (s2 = s)), nowLive);
    const liveFile = JSON.parse(fs.readFileSync(habitsCacheFile(FIX.trackKey, path.join(ROOT, 'coach-live')), 'utf8'));
    check('a session still being driven is scored afresh each time', s1.accuracyBuilt === 1 && s2.accuracyBuilt === 1 && s2.extracted === 0);
    check('…and its accuracy is not remembered', Object.keys(liveFile.sessions).length === 0);
    // An unknown track: null.
    const none = await loadDrivingHabits({ trackKey: 'nowhere_1', carClass: 'GT3' }, deps());
    check('no sessions at the track → null', none === null);
    // The shipped Road Atlanta catalogue: stable ids, every lap re-cut by it.
    const shipped = await loadDrivingHabits(
      { trackKey: FIX.trackKey, carClass: FIX.carClass },
      { lapDir: LAPS, traceDir: TRACES, cacheDir: path.join(ROOT, 'coach-shipped') },
      Date.parse('2026-10-29T12:00:00.000Z'),
    );
    check('with the shipped catalogue: source catalog, C1..C10', shipped && shipped.cornerSource === 'catalog' && shipped.corners.length === 10, shipped && `${shipped.cornerSource}, ${shipped.corners.length}`);

    /* §7 in flight */
    console.log('\n§7 two loads at once');
    const [a, b] = await Promise.all([load(), load()]);
    check('two concurrent loads share one pass', a.report === b.report);
  } catch (err) {
    failed++;
    console.log('  FAIL  threw: ' + (err && err.stack));
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
