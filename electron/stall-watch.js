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
 * Steps running right now, label → the ms they started at.
 *
 * A single breadcrumb cannot describe this process: the provider alone has
 * eight pollers in flight at once, and with one variable the one that finishes
 * first wipes the label of the one still running — so the slow step gets
 * reported as 'idle'. A set keeps every step that is genuinely open, which is
 * the question a stall report has to answer.
 */
const inflight = new Map();
/**
 * The slowest step to have COMPLETED since the last report, and how long it
 * took. This is the smoking gun: a step that took 1.4 s and finished as the
 * stall ended is the stall, whether or not it was still open when the timer
 * fired. Cleared after each report so it always describes the recent past.
 */
let worstStep = null;

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

/**
 * Open a step. Safe to nest and to overlap with other steps: each label keeps
 * its own start time, so two pollers in flight are both reported.
 *
 * A label already open is left at its original start time — a poller that
 * re-entered before its last run settled has been running since the FIRST one,
 * and that is the age worth printing.
 */
function begin(what) {
  if (!inflight.has(what)) inflight.set(what, Date.now());
}

/** Close a step, remembering it if it was the slowest one this window. */
function end(what) {
  const startedAt = inflight.get(what);
  if (startedAt === undefined) return;
  inflight.delete(what);
  const took = Date.now() - startedAt;
  if (!worstStep || took > worstStep.ms) worstStep = { what, ms: took, at: Date.now() };
}

/** Wrap an async step so it is reported for as long as it is in flight. */
async function around(what, fn) {
  begin(what);
  try {
    return await fn();
  } finally {
    end(what);
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
  // Without this the first stall of every session subtracts from zero and
  // prints the epoch as a breadcrumb age ("stale 1788341542844ms"), which is
  // the first thing anyone reading the log has to be told to ignore.
  breadcrumbAt = last;
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
    // Steps still open, oldest first — the one that spans the whole stall is
    // the candidate, and the young ones beside it are just what a busy process
    // looks like.
    let open = '';
    if (inflight.size) {
      const names = [...inflight.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([what, at]) => `${what}+${now - at}ms`)
        .join(',');
      open = ` inflight=${names}`;
    }
    // Only quote a completed step that finished inside this stall. A slow
    // step from ten minutes ago is not what just froze the overlays, and
    // printing it beside this timestamp would read as though it were.
    let slowest = '';
    if (worstStep && worstStep.ms >= THRESHOLD_MS && now - worstStep.at <= late + TICK_MS * 2) {
      slowest = ` slowest=${worstStep.what}/${worstStep.ms}ms`;
    }
    worstStep = null;
    let extra = '';
    if (context) {
      try {
        extra = ` ${JSON.stringify(context())}`;
      } catch {
        /* context is a nicety */
      }
    }
    write(
      `${new Date(now).toISOString()} STALL ${late}ms during=${during}${open}${slowest}${extra}`,
    );
  }, TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  inflight.clear();
  worstStep = null;
}

/** For the diagnostics panel / support bundle. */
function summary() {
  return { stalls: stallCount, worstMs, thresholdMs: THRESHOLD_MS, logPath };
}

module.exports = { start, stop, mark, begin, end, around, summary, TICK_MS, THRESHOLD_MS };
