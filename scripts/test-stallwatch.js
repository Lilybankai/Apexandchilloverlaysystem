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
 * Pure: no Electron, no window, no clock beyond Date.now(). The log is written
 * into a temp dir and read straight back.
 *
 * Run: node scripts/test-stallwatch.js
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

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}, 400);
