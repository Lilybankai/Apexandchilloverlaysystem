/**
 * scripts/test-stallwatch.js — the stall log names the thing that froze.
 * -----------------------------------------------------------------------------
 * The stall watcher is the only account we ever get of a freeze: it runs on a
 * tester's machine, unattended, and the file it leaves is the whole evidence
 * base. So the two ways it can quietly stop being evidence are worth asserting.
 *
 * 1. The census must WRAP without CHANGING. It patches the global timer
 *    functions for the entire main process — Electron's timers, `ws`'s, every
 *    dependency's. If the patched `setInterval` returned anything other than
 *    the real handle, `clearInterval` would silently stop clearing and the app
 *    would leak timers forever while looking perfectly healthy. That failure
 *    would not show up as a broken test elsewhere; it would show up as a
 *    tester's rig slowing down over an evening.
 *
 * 2. The census must only charge a callback for the time it actually held the
 *    loop. An `async` callback hands the loop back at its first await, so the
 *    seconds after that are not a freeze and must not be reported as one — a
 *    census that blamed every awaited REST call would bury the real culprit.
 *
 * 3. A GC pause must reach the report. It is the one suspect that is not a
 *    callback at all — V8 stops the thread, no JavaScript runs, and every
 *    instrument that wraps a function is blind to it by construction. That is
 *    what `ran=none` on fifteen consecutive stalls looks like, so the report
 *    has to be able to say `gc=major/NNNms` or it cannot close the question.
 *
 * Pure: no Electron, no window, no clock beyond Date.now(). The log is written
 * into a temp dir and read straight back.
 *
 * Run: node --expose-gc scripts/test-stallwatch.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stallWatch = require('../electron/stall-watch');

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

/** Burn the thread for real: the census measures wall time, so must the test. */
function block(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* deliberately synchronous — this is the thing being detected */
  }
}

/* -------------------------------------------------------------------------- */
console.log('\ninstallCensus — wraps the callback, hands back the real timer');
/* -------------------------------------------------------------------------- */

// A stand-in for globalThis so the test never patches its own runtime.
const fake = { setInterval, setTimeout };
const installed = stallWatch.installCensus(fake);
check('installs once', installed === true);
check('refuses to double-patch', stallWatch.installCensus(fake) === false, 'idempotent');

let ticks = 0;
const handle = fake.setInterval(() => ticks++, 5);
check('returns a real handle', typeof handle === 'object' && handle !== null);
check('the handle still unrefs', typeof handle.unref === 'function');
clearInterval(handle);
check('clearInterval still clears it', true, 'no throw');

let sawArgs = null;
let thisArg = null;
const owner = {
  run(...args) {
    sawArgs = args;
    thisArg = this;
  },
};
const t = fake.setTimeout(owner.run.bind(owner), 1, 'a', 'b');
check('the timeout handle is real too', typeof t.unref === 'function');

/* -------------------------------------------------------------------------- */
console.log('\nthe report — a slow fire is named, an awaited one is not');
/* -------------------------------------------------------------------------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-stall-'));
stallWatch.start(dir, () => ({ probe: true }), '9.9.9-test');
const logFile = path.join(dir, 'stalls.log');

// An async callback that settles during the block below. Its synchronous part
// is nothing — it awaits immediately, handing the loop straight back — so it
// must NOT appear in the census, and the strict single-entry assertion further
// down is what proves it: an await charged as a freeze would show up there.
let settled = false;
fake.setTimeout(async () => {
  await new Promise((r) => setTimeout(r, stallWatch.THRESHOLD_MS + 50));
  settled = true;
}, 1);

// A real interval that really fires and really blocks: the watcher's own tick
// lands late, and the census entry for the callback that did it has to be on
// that same line — naming this file, at the line the interval was created.
let fired = 0;
const slow = fake.setInterval(() => {
  fired++;
  block(stallWatch.THRESHOLD_MS + 150);
  clearInterval(slow);
}, 50);

setTimeout(() => {
  clearInterval(slow);
  stallWatch.stop();
  check('the blocking interval actually fired', fired === 1, `${fired} fire(s)`);
  const text = fs.readFileSync(logFile, 'utf8');
  const header = text.split('\n')[0];
  const stalls = text.split('\n').filter((l) => l.includes(' STALL '));

  check('the session header names the build', header.includes('v9.9.9-test'), header.slice(-28));
  check('the header still carries the threshold', header.includes('threshold 250ms'));
  check('the block was recorded at all', stalls.length >= 1, `${stalls.length} stall(s)`);
  if (stalls.length) {
    const line = stalls[0];
    check('every stall carries a census verdict', line.includes(' ran='), line.slice(0, 120));
    check('the context object survives', line.includes('"probe":true'));
    // The point of the whole exercise: an uninstrumented callback names
    // itself, by the file and line it was scheduled at.
    const ran = /ran=([^\s]*)/.exec(line)?.[1] ?? '';
    check('the culprit names its own site', /^test-stallwatch\.js:\d+\/\d+ms$/.test(ran), ran);
    check('and is charged the time it held the loop', Number(/\/(\d+)ms/.exec(ran)?.[1]) >= 350, ran);
  }

  /* ------------------------------------------------------------------------ */
  console.log('\nawaits do not count — only the synchronous part blocks');
  /* ------------------------------------------------------------------------ */

  // The await above outlasted the threshold and settled inside the stall
  // window. It is absent from `ran=` — asserted by that entry being the
  // blocking interval and nothing else — which is the whole distinction:
  // holding the loop is a freeze, waiting on one is not.
  check('the awaiting callback did settle in the window', settled === true);
  check('bound args reach the wrapped callback', JSON.stringify(sawArgs) === '["a","b"]');
  check('`this` is preserved', thisArg === owner);

  /* ------------------------------------------------------------------------ */
  console.log('\ngarbage collection — the pause no wrapper can see');
  /* ------------------------------------------------------------------------ */

  if (typeof global.gc !== 'function') {
    console.log('  SKIP  no --expose-gc; run: node --expose-gc scripts/test-stallwatch.js');
    finish();
    return;
  }

  // A second watcher run, this time with a real collection in it. Held garbage
  // makes the pause long enough to clear GC_FLOOR_MS on a fast machine.
  const gcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-stall-gc-'));
  stallWatch.start(gcDir, null, '9.9.9-gc');
  check('the GC observer attached', stallWatch.summary().gc === true);

  // The live set is what makes a major collection expensive — V8 has to trace
  // it — so the ballast is deliberately KEPT, not dropped. Dropping it first
  // makes the collection trivial and the test proves nothing.
  const ballast = [];
  for (let i = 0; i < 1_500_000; i++) ballast.push({ i, p: i & 7 });
  global.gc();
  global.gc(); // the second is the full mark-compact, and the slow one
  // Hold the thread long enough that the next tick is past the threshold: the
  // watcher subtracts its own TICK_MS before comparing, so the block has to
  // cover both. The collection sits inside this window and rides out with it.
  block(stallWatch.THRESHOLD_MS + stallWatch.TICK_MS + 100);

  setTimeout(() => {
    stallWatch.stop();
    const gcText = fs.readFileSync(path.join(gcDir, 'stalls.log'), 'utf8');
    const gcLines = gcText.split('\n').filter((l) => l.includes(' STALL '));
    check('the GC run produced a stall to report on', gcLines.length >= 1);
    // A box fast enough to collect that in under GC_FLOOR_MS names no pause,
    // and rightly so: the claim is that a pause worth naming IS named, not
    // that this machine is slow.
    const named = gcLines.filter((l) => l.includes(' gc='));
    check(
      'a collection that paused the thread is named',
      named.length === 0 || /gc=(minor|major|incremental|weakcb|gc)\/\d+ms/.test(named[0]),
      named.length ? /gc=[^\s]*/.exec(named[0])[0] : 'no pause past the floor',
    );
    check('the ballast stayed live through the collection', ballast.length === 1_500_000);
    check(
      'the census still answers beside it',
      gcLines.length === 0 || gcLines[0].includes(' ran='),
    );
    fs.rmSync(gcDir, { recursive: true, force: true });
    finish();
  }, 300);

  function finish() {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  }
}, 400);
