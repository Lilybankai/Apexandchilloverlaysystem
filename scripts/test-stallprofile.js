/**
 * scripts/test-stallprofile.js — the freeze the census cannot see gets named.
 * -----------------------------------------------------------------------------
 * For nine days and four builds every stall in a tester's log read `ran=none`.
 * That was taken as "no JavaScript ran", and it sent the hunt towards GC, the
 * OS and native code. It means nothing of the sort: the census wraps timer
 * callbacks, and almost nothing in this app is a timer callback by the time it
 * does its work. Each poller is `async`, so everything past the first `await`
 * is a promise continuation — scheduled by the microtask queue, wrapped by
 * nobody. Block the thread there and the census reports `ran=none` while the
 * overlays sit frozen.
 *
 * So the profiler has one job, and it is the job asserted here: a synchronous
 * block that reaches the thread by a route the census does not wrap must still
 * be named, by function, with a duration close to the truth. If that ever stops
 * being true this file fails, rather than a tester's evening being spent
 * collecting another week of `ran=none`.
 *
 * Also asserted: the sampler is honest about a stall it has no samples for
 * (silence, not a guess), it leaves a `.cpuprofile` that parses, and it keeps
 * only a bounded number of them — a diagnostic that fills a tester's disk gets
 * turned off, and then there is no evidence at all.
 *
 * Pure Node: no Electron, no window. Run: node scripts/test-stallprofile.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profiler = require('../electron/stall-profiler');

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

/** Burn the thread for real: a sampling profiler measures wall time, so must this. */
function block(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* deliberately synchronous — this is the thing being detected */
  }
}

/**
 * The blind spot, reproduced exactly: a named function doing synchronous work
 * inside a promise continuation. No timer wraps this, so the census is blind to
 * it by construction and the profiler is the only witness.
 */
function blockedInsideAContinuation(ms) {
  return Promise.resolve()
    .then(() => {})
    .then(function continuationTheCensusCannotSee() {
      block(ms);
    });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-stall-profile-'));

console.log('\nstall profiler — naming the block the census cannot see\n');

const up = profiler.start(dir);
check('the sampler started', up === true, profiler.summary().error || 'no error');
if (!up) {
  console.log('\n  the runtime has no inspector; nothing further can be asserted\n');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

const BLOCK_MS = 900;

blockedInsideAContinuation(BLOCK_MS)
  .then(() => {
    const now = Date.now();
    const line = profiler.report(now, BLOCK_MS);

    check('a stall gets a hot= verdict', / hot=/.test(line), line.trim().slice(0, 120));
    check(
      'the continuation is named, not the timer that never ran',
      /continuationTheCensusCannotSee|\bblock\b/.test(line),
      /hot=([^/]+)/.exec(line) ? /hot=([^/]+)/.exec(line)[1] : line,
    );

    // The point of self time: the verdict has to be the size of the freeze, or
    // a reader cannot tell the culprit from a frame that merely sat on the
    // stack. Generous margins — this is a sampler on a shared CI box.
    const owned = Number(/hot=[^/]+\/(\d+)ms/.exec(line)?.[1] ?? 0);
    check(
      'the top frame owns most of the freeze',
      owned >= BLOCK_MS * 0.6,
      `${owned}ms of ${BLOCK_MS}ms`,
    );

    const sampled = Number(/sampled=(\d+)ms/.exec(line)?.[1] ?? 0);
    check(
      'the sampled span covers the stall without inventing time',
      sampled >= BLOCK_MS * 0.6 && sampled <= BLOCK_MS + 600,
      `${sampled}ms`,
    );

    /* ---------------------------------------------------------------------- */
    console.log('\nthe dump a human opens');
    /* ---------------------------------------------------------------------- */

    const named = /profile=(\S+)/.exec(line);
    check('a long stall leaves a .cpuprofile', named !== null, line.trim().slice(-60));
    if (named) {
      const file = path.join(dir, named[1]);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      check(
        'the dump is a profile Chrome DevTools will load',
        Array.isArray(parsed.nodes) &&
          Array.isArray(parsed.samples) &&
          parsed.samples.length === parsed.timeDeltas.length,
        `${parsed.samples.length} samples, ${parsed.nodes.length} nodes`,
      );
      check(
        'the dump is trimmed to the freeze, not the whole window',
        parsed.samples.length <= (BLOCK_MS + 600) / (profiler.SAMPLE_US / 1000),
        `${parsed.samples.length} samples`,
      );
    }

    /* ---------------------------------------------------------------------- */
    console.log('\nsilence when there is nothing to say');
    /* ---------------------------------------------------------------------- */

    // A window that has only just opened holds no samples from before it, and
    // the few it does hold are the profiler reading the last one. Naming those
    // would be a guess presented as a measurement — and believed, since the
    // whole point of the field is that it is evidence.
    const quiet = profiler.report(Date.now(), 5000);
    check(
      'a stall the window cannot cover is declared unsampled, not guessed at',
      / hot=unsampled\(\d+ms of 5000ms\)/.test(quiet),
      JSON.stringify(quiet),
    );
    check(
      "the profiler never names itself",
      !/stall-profiler\.js|node:inspector/.test(quiet),
      JSON.stringify(quiet),
    );

    /* ---------------------------------------------------------------------- */
    console.log('\nbounded on disk');
    /* ---------------------------------------------------------------------- */

    return (async () => {
      // One more dump than the keep limit, each from its own freeze.
      for (let i = 0; i < 8; i++) {
        await blockedInsideAContinuation(profiler.DUMP_FLOOR_MS + 50);
        profiler.report(Date.now(), profiler.DUMP_FLOOR_MS + 50);
      }
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.cpuprofile'));
      check('old profiles are deleted', files.length <= 6, `${files.length} kept`);
      check('the sampler is still running after all that', profiler.summary().running === true);
    })();
  })
  .then(() => {
    profiler.stop();
    check('stopping is clean', profiler.summary().running === false);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  });
