/**
 * electron/stall-watch.js — name the thing that froze the overlays.
 * -----------------------------------------------------------------------------
 * Every overlay in this app is a renderer fed by the main process at 60 Hz. When
 * main blocks, every overlay blocks with it, then snaps back when the loop
 * frees up — which is exactly what a driver reports as "the overlays froze for
 * a second and then refreshed". The cause is never visible after the fact:
 * there is no log, the app recovers on its own, and by the time anyone looks
 * the stack that did it is long gone.
 *
 * So measure it. A short interval that checks how late it actually fired is a
 * direct read of main-thread health: the loop cannot deliver the timer while
 * something synchronous is running, so lateness IS the block. Anything past
 * THRESHOLD_MS gets written to a rotating log the operator can send us,
 * together with what the app was doing at the time (breadcrumbs left by the
 * suspects — the relay publish, the snapshot build, the DirectInput sweep).
 *
 * Costs nothing when nothing is wrong: one timer, one Date.now(), no allocation
 * on the happy path.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** How often we ask to be woken. Short enough to catch a one-frame hitch. */
const TICK_MS = 100;
/**
 * Report a tick that lands this late. A 60 Hz overlay drops ~15 frames in
 * 250 ms, which is the point a human calls it a freeze rather than a stutter.
 */
const THRESHOLD_MS = 250;
/** Keep the log honest about size: two files, this big each. */
const MAX_BYTES = 512 * 1024;

let timer = null;
let last = 0;
let logPath = '';
/** What main was doing when the tick was due — see {@link mark}. */
let breadcrumb = 'idle';
let breadcrumbAt = 0;
/** Worst lateness seen this run, for the diagnostics readout. */
let worstMs = 0;
let stallCount = 0;

/**
 * Note what the main process is about to do. Cheap enough to call on every
 * 1 Hz tick: two assignments, no allocation. The stall report quotes the most
 * recent mark, so a block gets attributed to the work that was running rather
 * than to whatever happened to be on the stack when the timer fired.
 */
function mark(what) {
  breadcrumb = what;
  breadcrumbAt = Date.now();
}

/** Wrap an async step in a breadcrumb, restoring 'idle' when it settles. */
async function around(what, fn) {
  mark(what);
  try {
    return await fn();
  } finally {
    mark('idle');
  }
}

function rotate() {
  try {
    const st = fs.statSync(logPath);
    if (st.size < MAX_BYTES) return;
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    /* no log yet, or a rename we can live without */
  }
}

function write(line) {
  try {
    rotate();
    fs.appendFileSync(logPath, `${line}\n`);
  } catch {
    /* diagnostics must never be the thing that breaks the app */
  }
}

/**
 * @param {string} userDataDir where to keep stalls.log
 * @param {() => object} [context] optional extra facts to record with a stall
 */
function start(userDataDir, context) {
  if (timer) return;
  logPath = path.join(userDataDir, 'stalls.log');
  last = Date.now();
  write(`--- session started ${new Date().toISOString()} (threshold ${THRESHOLD_MS}ms) ---`);
  timer = setInterval(() => {
    const now = Date.now();
    const late = now - last - TICK_MS;
    last = now;
    if (late < THRESHOLD_MS) return;
    stallCount++;
    if (late > worstMs) worstMs = late;
    // A mark that predates the stall by a long way was not the cause; say so
    // rather than blaming the last thing that happened to run.
    const age = now - breadcrumbAt;
    const during = age <= late + TICK_MS * 2 ? breadcrumb : `${breadcrumb} (stale ${age}ms)`;
    let extra = '';
    if (context) {
      try {
        extra = ` ${JSON.stringify(context())}`;
      } catch {
        /* context is a nicety */
      }
    }
    write(`${new Date(now).toISOString()} STALL ${late}ms during=${during}${extra}`);
  }, TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** For the diagnostics panel / support bundle. */
function summary() {
  return { stalls: stallCount, worstMs, thresholdMs: THRESHOLD_MS, logPath };
}

module.exports = { start, stop, mark, around, summary, TICK_MS, THRESHOLD_MS };
