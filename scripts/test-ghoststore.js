/**
 * scripts/test-ghoststore.js — choosing Ghost HUD's lap without ever blocking
 * the frame loop.
 * -----------------------------------------------------------------------------
 * The first Ghost HUD chose its lap with synchronous reads inside the frame
 * loop, on the thread that composites every overlay, and got three things
 * wrong besides (see `ghostSelector.ts`): Hypercar never found a ghost, a miss
 * stuck until the combo changed, and a new best was never adopted. Each has a
 * section here, and the first rule — no synchronous `fs` — is enforced by
 * making every sync read THROW while a selection or load is running.
 *
 * Everything runs against a temporary lap store; the driver's real one is
 * never touched.
 *
 * Run: npm run test:ghoststore
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GhostIndex, loadBestGhost } = require('../dist/telemetry/ghostStore');
const { GhostSelector, MAX_RETRIES, RETRY_BASE_MS } = require('../dist/telemetry/ghostSelector');
const { traceFilePath } = require('../dist/telemetry/lapTrace');
const { trackKeyOf } = require('../dist/telemetry/paceDelta');
const { LmuRestProvider } = require('../dist/telemetry/lmuRestProvider');

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

/* ------------------------------ the sync guard ---------------------------- */

/**
 * While armed, every synchronous read or stat on `fs` throws and is counted.
 * Armed around `sync()` and every awaited load, so a sync call anywhere on the
 * selection path — however deep — fails the run instead of passing silently.
 */
const SYNC_FNS = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'openSync', 'readSync', 'accessSync', 'fstatSync'];
const real = {};
let syncHits = 0;
for (const name of SYNC_FNS) real[name] = fs[name];
function arm() {
  for (const name of SYNC_FNS) {
    fs[name] = function guarded(...args) {
      syncHits++;
      throw new Error(`sync fs call during ghost selection: ${name}(${String(args[0])})`);
    };
  }
}
function disarm() {
  for (const name of SYNC_FNS) fs[name] = real[name];
}
async function guarded(fn) {
  arm();
  try {
    return await fn();
  } finally {
    disarm();
  }
}

/** Counts directory scans, so "no I/O" and "one retry" are measurable. */
let readdirCalls = 0;
const realReaddir = fs.promises.readdir;
fs.promises.readdir = function counted(...args) {
  readdirCalls++;
  return realReaddir.apply(this, args);
};

/* ------------------------------ a temp lap store -------------------------- */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ghoststore-'));
let storeN = 0;
function newStore() {
  const dir = path.join(ROOT, `s${storeN++}`);
  const dirs = { laps: path.join(dir, 'laps'), traces: path.join(dir, 'traces') };
  fs.mkdirSync(dirs.laps, { recursive: true });
  fs.mkdirSync(dirs.traces, { recursive: true });
  return dirs;
}

const TRACK = 'Michelin Raceway Road Atlanta';
const TRACK_LEN = 4083;
const TRACK_KEY = trackKeyOf(TRACK, TRACK_LEN);
let lapN = 0;

/** A lap record as `lapLog` writes it. */
function rec(over = {}) {
  lapN++;
  return Object.assign(
    {
      v: 7,
      id: `lap-${String(lapN).padStart(4, '0')}`,
      at: '2026-10-05T12:00:00.000Z',
      sim: 'lmu',
      track: TRACK,
      trackKey: TRACK_KEY,
      trackLengthM: TRACK_LEN,
      car: 'Test Car #1',
      carClass: 'HYPERCAR',
      lapMs: 80_000,
      clean: true,
      condition: 'dry',
    },
    over,
  );
}

function appendLaps(dirs, recs, day = '2026-10-05') {
  fs.appendFileSync(path.join(dirs.laps, `${day}.jsonl`), recs.map((r) => JSON.stringify(r) + '\n').join(''));
}

/** A constant-speed trace for a record, with or without the driven line. */
function writeTraceFor(dirs, r, { line = true } = {}) {
  const n = 400;
  const lapSec = r.lapMs / 1000;
  const d = [];
  const t = [];
  for (let i = 0; i <= n; i++) {
    d.push(i / n);
    t.push((i / n) * lapSec);
  }
  const file = {
    v: line ? 2 : 1,
    lapId: r.id,
    at: r.at,
    sim: r.sim,
    trackKey: r.trackKey,
    track: r.track,
    trackLengthM: r.trackLengthM,
    car: r.car,
    carClass: r.carClass,
    lapMs: r.lapMs,
    trace: {
      lapSec,
      count: d.length,
      truncated: false,
      d,
      t,
      speedKph: d.map(() => 180),
      ...(line ? { x: d.map((v) => v * 1000), z: d.map(() => 0) } : {}),
    },
  };
  const p = traceFilePath(r.id, r.at, dirs.traces);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(file));
}

const COMBO = { sim: 'lmu', trackKey: TRACK_KEY, carClass: 'HYPERCAR', condition: 'dry' };

/* ---------------------------------- tests --------------------------------- */

async function main() {
  console.log('\n1) The index: incremental, whole lines only');
  {
    const dirs = newStore();
    const a = rec({ lapMs: 81_000 });
    const b = rec({ lapMs: 80_500 });
    appendLaps(dirs, [a, b]);
    const index = new GhostIndex(dirs.laps);
    await guarded(() => index.refresh());
    const list = index.candidates(COMBO);
    check('both laps indexed', list.length === 2);
    check('fastest first', list[0].lapId === b.id);

    // Count the bytes each refresh actually reads.
    let readBytes = 0;
    const realOpen = fs.promises.open;
    fs.promises.open = async function counted(...args) {
      const fh = await realOpen.apply(this, args);
      const realRead = fh.read.bind(fh);
      fh.read = async (buf, off, len, pos) => {
        const r = await realRead(buf, off, len, pos);
        readBytes += r.bytesRead;
        return r;
      };
      return fh;
    };
    try {
      const c = rec({ lapMs: 79_000 });
      const line = JSON.stringify(c) + '\n';
      // Torn: the lap's line is half-written when the scan lands.
      fs.appendFileSync(path.join(dirs.laps, '2026-10-05.jsonl'), line.slice(0, 40));
      readBytes = 0;
      await guarded(() => index.refresh());
      check('a half-written line is not read as a lap', index.candidates(COMBO).length === 2);
      check('…and only the appended bytes were read', readBytes === 40, readBytes);
      fs.appendFileSync(path.join(dirs.laps, '2026-10-05.jsonl'), line.slice(40));
      readBytes = 0;
      await guarded(() => index.refresh());
      check('completed, it appears — fastest now', index.candidates(COMBO)[0].lapId === c.id);
      check('…reading only from the last line boundary on', readBytes === line.length, `${readBytes} of ${line.length}`);
      readBytes = 0;
      await guarded(() => index.refresh());
      check('a refresh with nothing new reads nothing', readBytes === 0, readBytes);
    } finally {
      fs.promises.open = realOpen;
    }

    // Concurrent refreshes share one follow-up scan rather than piling up.
    const before = readdirCalls;
    await Promise.all([index.refresh(), index.refresh(), index.refresh(), index.refresh()]);
    check('four concurrent refreshes cost at most two scans', readdirCalls - before <= 2, readdirCalls - before);
  }

  console.log('\n2) The combo key is the NORMALISED class');
  {
    const dirs = newStore();
    appendLaps(dirs, [rec({ carClass: 'HYPERCAR' })]);
    const index = new GhostIndex(dirs.laps);
    await index.refresh();
    check('"HYPERCAR" (what lap records store) finds the lap', index.candidates(COMBO).length === 1);
    check('LMU\'s raw "Hyper" finds nothing — why the provider must normalise', index.candidates({ ...COMBO, carClass: 'Hyper' }).length === 0);
    appendLaps(dirs, [rec({ clean: false, lapMs: 70_000 }), rec({ condition: 'wet', lapMs: 70_000 })]);
    await index.refresh();
    check('cut laps are left out by default', index.candidates(COMBO).every((c) => c.clean));
    check('another surface is left out', index.candidates(COMBO).every((c) => c.condition === 'dry'));
    check('a picker can ask for cut laps', index.candidates({ ...COMBO, cleanOnly: false }).length === 2);
  }

  console.log('\n3) Loading: a lap with a line wins, untraced laps are skipped');
  {
    const dirs = newStore();
    const noLine = rec({ lapMs: 79_000 });
    const withLine = rec({ lapMs: 80_000 });
    appendLaps(dirs, [noLine, withLine]);
    writeTraceFor(dirs, noLine, { line: false });
    writeTraceFor(dirs, withLine);
    const index = new GhostIndex(dirs.laps);
    const g = await guarded(() => loadBestGhost(index, COMBO, dirs));
    check('the fastest lap WITH a line is preferred', g && g.lapId === withLine.id, g && g.lapId);

    const dirs2 = newStore();
    const only = rec({ lapMs: 79_000 });
    appendLaps(dirs2, [only]);
    writeTraceFor(dirs2, only, { line: false });
    const g2 = await guarded(() => loadBestGhost(new GhostIndex(dirs2.laps), COMBO, dirs2));
    check('with no line anywhere, the fastest loadable lap still counts', g2 && g2.lapId === only.id);

    // Six quicker laps whose traces were never written (spectated, or from
    // before traces) must not use up the probe and hide the real one.
    const dirs3 = newStore();
    const ghosts = [1, 2, 3, 4, 5, 6].map((i) => rec({ lapMs: 70_000 + i }));
    const real3 = rec({ lapMs: 80_000 });
    appendLaps(dirs3, [...ghosts, real3]);
    writeTraceFor(dirs3, real3);
    const index3 = new GhostIndex(dirs3.laps);
    const g3 = await guarded(() => loadBestGhost(index3, COMBO, dirs3));
    check('untraced laps do not count against the probe', g3 && g3.lapId === real3.id, g3 && g3.lapId);
    check('…and are not probed again', index3.candidates(COMBO).length === 1);
  }

  console.log('\n4) Not wanted: no I/O at all');
  {
    const dirs = newStore();
    const r = rec();
    appendLaps(dirs, [r]);
    writeTraceFor(dirs, r);
    const published = [];
    const sel = new GhostSelector({ dirs, publish: (l) => published.push(l) });
    const scans = readdirCalls;
    const hits = syncHits;
    await guarded(async () => {
      for (let i = 0; i < 100; i++) sel.sync(COMBO, 1000 + i * 33);
      await sel.settled();
    });
    check('a hundred frames with the ghost unwanted scan nothing', readdirCalls === scans, readdirCalls - scans);
    check('…make no sync fs call', syncHits === hits);
    check('…and choose nothing', sel.lap === null && published.length === 0);
  }

  console.log('\n5) Wanted: loaded asynchronously, never with a sync read');
  {
    const dirs = newStore();
    const r = rec();
    appendLaps(dirs, [r]);
    writeTraceFor(dirs, r);
    const published = [];
    const sel = new GhostSelector({ dirs, publish: (l) => published.push(l) });
    sel.setWanted(true);
    const hits = syncHits;
    await guarded(async () => {
      sel.sync(COMBO, 1000);
      check('the frame that starts a load returns before it finishes', sel.lap === null);
      await sel.settled();
    });
    check('no sync fs call anywhere on the load path', syncHits === hits, syncHits - hits);
    check('the ghost is chosen', sel.lap && sel.lap.lapId === r.id);
    check('…and published once', published.length === 1 && published[0] === sel.lap);
    const scans = readdirCalls;
    for (let i = 0; i < 100; i++) sel.sync(COMBO, 2000 + i * 33);
    await sel.settled();
    check('steady state: a hundred frames scan nothing', readdirCalls === scans);

    sel.setWanted(false);
    check('unwanted again: the selection is dropped', sel.lap === null && published[published.length - 1] === null);
  }

  console.log('\n6) A miss is retried with backoff — and not forever');
  {
    const dirs = newStore();
    let now = 10_000;
    const sel = new GhostSelector({ dirs, now: () => now });
    sel.setWanted(true);
    sel.sync(COMBO, now);
    await sel.settled();
    check('an empty store: no ghost yet', sel.lap === null);

    const r = rec();
    appendLaps(dirs, [r]);
    writeTraceFor(dirs, r);
    const scans = readdirCalls;
    now += RETRY_BASE_MS - 1;
    sel.sync(COMBO, now);
    await sel.settled();
    check('no retry before the backoff has run', readdirCalls === scans && sel.lap === null);
    now += 1;
    await guarded(async () => {
      sel.sync(COMBO, now);
      await sel.settled();
    });
    check('the retry finds the lap that arrived — no sticky null', sel.lap && sel.lap.lapId === r.id);

    const dirs2 = newStore();
    let now2 = 0;
    const sel2 = new GhostSelector({ dirs: dirs2, now: () => now2 });
    sel2.setWanted(true);
    const start = readdirCalls;
    for (let i = 0; i < 40; i++) {
      sel2.sync(COMBO, now2);
      await sel2.settled();
      now2 += 120_000; // far past any backoff
    }
    const loads = readdirCalls - start;
    check(`a store that stays empty is tried 1 + ${MAX_RETRIES} times, then left alone`, loads === 1 + MAX_RETRIES, loads);

    // …until a lap is driven, which re-arms it directly.
    const r2 = rec();
    appendLaps(dirs2, [r2]);
    writeTraceFor(dirs2, r2);
    sel2.noteLap(r2);
    sel2.sync(COMBO, now2);
    await sel2.settled();
    check('a new lap re-arms a selector that had given up', sel2.lap && sel2.lap.lapId === r2.id);
  }

  console.log('\n7) A new best is adopted');
  {
    const dirs = newStore();
    const first = rec({ lapMs: 82_000 });
    appendLaps(dirs, [first]);
    writeTraceFor(dirs, first);
    const published = [];
    const sel = new GhostSelector({ dirs, publish: (l) => published.push(l) });
    sel.setWanted(true);
    sel.sync(COMBO, 0);
    await sel.settled();
    check('the first lap is chosen', sel.lap.lapId === first.id);

    // The provider writes the record and its trace, then calls noteLap.
    const better = rec({ lapMs: 81_000 });
    appendLaps(dirs, [better]);
    writeTraceFor(dirs, better);
    sel.noteLap(better);
    await guarded(async () => {
      sel.sync(COMBO, 33);
      await sel.settled();
    });
    check('a quicker clean lap replaces it', sel.lap.lapId === better.id);
    check('…and is published', published[published.length - 1] === sel.lap);

    const scans = readdirCalls;
    const slower = rec({ lapMs: 83_000 });
    const cut = rec({ lapMs: 70_000, clean: false });
    const wet = rec({ lapMs: 70_000, condition: 'wet' });
    const otherClass = rec({ lapMs: 70_000, carClass: 'LMP2' });
    appendLaps(dirs, [slower, cut, wet, otherClass]);
    for (const r of [slower, cut, wet, otherClass]) sel.noteLap(r);
    sel.sync(COMBO, 66);
    await sel.settled();
    check('a slower, cut, wet or other-class lap does not re-arm', readdirCalls === scans && sel.lap.lapId === better.id);
  }

  console.log('\n8) A stale load never overwrites a newer combo');
  {
    const dirs = newStore();
    const dry = rec({ lapMs: 80_000 });
    const damp = rec({ lapMs: 85_000, condition: 'damp' });
    appendLaps(dirs, [dry, damp]);
    writeTraceFor(dirs, dry);
    writeTraceFor(dirs, damp);

    // Hold the dry lap's trace read open until released.
    let release;
    const gate = new Promise((r) => (release = r));
    const realReadFile = fs.promises.readFile;
    fs.promises.readFile = async function held(p, ...rest) {
      if (String(p).includes(dry.id)) await gate;
      return realReadFile.call(this, p, ...rest);
    };
    try {
      const published = [];
      const sel = new GhostSelector({ dirs, publish: (l) => published.push(l) });
      sel.setWanted(true);
      sel.sync(COMBO, 0); // dry: starts, then stalls on its trace read
      await new Promise((r) => setTimeout(r, 20));
      sel.sync({ ...COMBO, condition: 'damp' }, 33); // it rained
      await sel.settled();
      check('the newer combo is chosen', sel.lap && sel.lap.lapId === damp.id);
      release();
      await new Promise((r) => setTimeout(r, 50));
      check('the stalled dry read lands late and is DROPPED', sel.lap.lapId === damp.id);
      check('…it was never published', published.every((l) => !l || l.lapId !== dry.id));

      // Same race against switching the ghost off.
      let release2;
      const gate2 = new Promise((r) => (release2 = r));
      fs.promises.readFile = async function held2(p, ...rest) {
        if (String(p).includes(dry.id)) await gate2;
        return realReadFile.call(this, p, ...rest);
      };
      const sel2 = new GhostSelector({ dirs });
      sel2.setWanted(true);
      sel2.sync(COMBO, 0);
      await new Promise((r) => setTimeout(r, 20));
      sel2.setWanted(false);
      release2();
      await new Promise((r) => setTimeout(r, 50));
      check('a load finishing after the ghost was switched off is dropped', sel2.lap === null);
    } finally {
      fs.promises.readFile = realReadFile;
    }
  }

  console.log('\n9) The provider: raw "Hyper" finds the HYPERCAR ghost, with no sync read');
  {
    const dirs = newStore();
    const r = rec({ carClass: 'HYPERCAR' });
    appendLaps(dirs, [r]);
    writeTraceFor(dirs, r);
    // Constructed, never started: syncGhost touches no timer, socket or
    // shared memory. Its selector is pointed at the temp store.
    const p = new LmuRestProvider({ verbose: false });
    p.ghost = new GhostSelector({ dirs });
    const hits = syncHits;
    await guarded(async () => {
      p.syncGhost(TRACK, TRACK_LEN, 'Hyper', 0, 1000);
      await p.ghost.settled();
    });
    check('unwanted by default: nothing is chosen', p.ghost.lap === null);
    p.setGhostWanted(true);
    await guarded(async () => {
      p.syncGhost(TRACK, TRACK_LEN, 'Hyper', 0, 1000);
      await p.ghost.settled();
    });
    check('…once wanted, LMU\'s "Hyper" finds the HYPERCAR lap', p.ghost.lap && p.ghost.lap.lapId === r.id);
    check('…with no sync fs call', syncHits === hits);
    p.syncGhost(TRACK, TRACK_LEN, 'Hyper', 0.5, 2000); // soaked: a wet combo with no laps
    await p.ghost.settled();
    check('a surface change drops the dry lap', p.ghost.lap === null);
    p.syncGhost(TRACK, TRACK_LEN, undefined, 0, 3000);
    check('no class: nothing chosen', p.ghost.lap === null);
  }
}

main()
  .catch((err) => {
    failed++;
    console.log(`  FAIL  threw: ${err && err.stack}`);
  })
  .finally(() => {
    disarm();
    try {
      fs.rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* temp dir; the OS will have it */
    }
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  });
