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
 *
 * ## The census
 * Breadcrumbs only name work somebody thought to wrap. The 130 s beat in the
 * logs from 30 Aug–3 Sep 2026 is the other case: every stall reported
 * `during=idle` with each in-flight poller `+0ms` old — i.e. those timers had
 * only just fired as the loop came back, so they were the block's victims, not
 * its cause. Nothing on the thread owned up to it, which is exactly what an
 * uninstrumented callback looks like.
 *
 * So {@link installCensus} wraps the global timer functions once, at startup,
 * and remembers any fire whose SYNCHRONOUS part ran long (only synchronous work
 * can block the loop — an await returns to it). Timers are named by where they
 * were created, so the report says `ran=main.js:1329/812ms` rather than leaving
 * us to infer a culprit from a period. Two clock reads per fire, an entry only
 * past {@link CENSUS_FLOOR_MS}, and a fixed-size ring: cheap enough to leave on.
 *
 * A stall that prints `ran=none` is a finding too — it rules out every JS timer
 * in the process and points at native work, GC, or the OS.
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
/**
 * A timer fire whose synchronous part ran this long is worth a census entry.
 * Well under THRESHOLD_MS on purpose: a stall is often several callbacks
 * landing in the same turn, and the report should show all of them, not only
 * the one that on its own crossed the line.
 */
const CENSUS_FLOOR_MS = 50;
/** Slow fires kept. A report only quotes the ones inside the stall window. */
const CENSUS_KEEP = 16;

/**
 * The real timer functions, captured before {@link installCensus} can patch
 * them, so this file's own tick is never wrapped by its own census — the log
 * would otherwise blame the watcher for the fs append it does while reporting.
 */
const nativeSetInterval = setInterval;

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
/** Slow timer fires, oldest first: `{ site, ms, at }`. See {@link installCensus}. */
const census = [];
let censusOn = false;
/** Stamped into the session header so a log says which build wrote it. */
let appVersion = '';

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

/**
 * Where a timer was scheduled, as `file.js:line`, read off a stack captured at
 * SCHEDULE time. Creating an interval happens once; its callback then fires
 * forever with the name already in hand, so the stack costs nothing per fire.
 *
 * @param {number} depth frames above this one to name
 * @param {string} fallback used when the stack is unreadable (bundled/native)
 */
function siteOf(depth, fallback) {
  const line = (new Error().stack || '').split('\n')[depth];
  if (!line) return fallback;
  const m = /([^()\s]+[\\/][^()\s]+?):(\d+):\d+\)?\s*$/.exec(line);
  return m ? `${path.basename(m[1])}:${m[2]}` : fallback;
}

/**
 * Wrap a timer callback so a long synchronous run leaves a census entry.
 *
 * Only the synchronous part is timed, and deliberately: an `async` callback
 * hands the loop back at its first await, so the time after that is not a
 * freeze. This is what makes the census readable — `lmu:poll` awaiting a REST
 * call for 400 ms never appears, while a 900 ms JSON.parse does.
 */
function watched(fn, site) {
  return function censused(...args) {
    const started = Date.now();
    try {
      return fn.apply(this, args);
    } finally {
      const took = Date.now() - started;
      if (took >= CENSUS_FLOOR_MS) {
        census.push({ site, ms: took, at: Date.now() });
        if (census.length > CENSUS_KEEP) census.shift();
      }
    }
  };
}

/**
 * Patch the global timer functions so every scheduled callback in this process
 * is named and timed — ours, Electron's, and our dependencies'. Call it once,
 * as early in main as possible: anything scheduled before it stays invisible.
 *
 * The patch is careful to be boring. It wraps the callback and nothing else, so
 * the caller still gets the real `Timeout` back and `clearInterval`, `unref()`
 * and `util.promisify` keep working; a non-function first argument is passed
 * straight through untouched.
 *
 * @param {object} [target] the object holding the timer functions (tests)
 * @returns {boolean} whether this call was the one that installed it
 */
function installCensus(target = globalThis) {
  if (censusOn) return false;
  censusOn = true;
  const realInterval = target.setInterval;
  const realTimeout = target.setTimeout;
  const promisify = Symbol.for('nodejs.util.promisify.custom');
  target.setInterval = function setInterval(fn, ms, ...args) {
    if (typeof fn !== 'function') return realInterval.call(this, fn, ms, ...args);
    return realInterval.call(this, watched(fn, siteOf(3, `interval@${ms}ms`)), ms, ...args);
  };
  // A timeout is scheduled far more often than an interval — every socket in
  // the process arms one — so it is named by its callback rather than by a
  // stack we would pay for thousands of times an hour. Repeating work almost
  // always uses setInterval, which is the case the census exists for.
  target.setTimeout = function setTimeout(fn, ms, ...args) {
    if (typeof fn !== 'function') return realTimeout.call(this, fn, ms, ...args);
    return realTimeout.call(this, watched(fn, `${fn.name || 'timeout'}@${ms || 0}ms`), ms, ...args);
  };
  target.setInterval[promisify] = realInterval[promisify];
  target.setTimeout[promisify] = realTimeout[promisify];
  return true;
}

/**
 * The census entries that overlap a stall of `late` ms ending now, newest
 * first, and drop everything older — the same "recent past only" rule the
 * worst-step line follows, for the same reason: a slow callback from ten
 * minutes ago is not what just froze the overlays.
 */
function censusFor(now, late) {
  if (!censusOn) return '';
  const window = late + TICK_MS * 2;
  const hits = [];
  for (const e of census) if (now - e.at <= window) hits.push(`${e.site}/${e.ms}ms`);
  census.length = 0;
  return ` ran=${hits.length ? hits.reverse().join(',') : 'none'}`;
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
 * @param {string} [version] the running build, stamped on the session header
 */
function start(userDataDir, context, version) {
  if (timer) return;
  logPath = path.join(userDataDir, 'stalls.log');
  appVersion = version || '';
  last = Date.now();
  // Without this the first stall of every session subtracts from zero and
  // prints the epoch as a breadcrumb age ("stale 1788341542844ms"), which is
  // the first thing anyone reading the log has to be told to ignore.
  breadcrumbAt = last;
  // The build belongs on this line. A log spans weeks and several updates, and
  // "did the fix help" is unanswerable without knowing which session ran which
  // build — the 130 s beat was read across four builds before anyone noticed
  // the file never says so.
  const build = appVersion ? `, v${appVersion}` : '';
  write(
    `--- session started ${new Date().toISOString()} (threshold ${THRESHOLD_MS}ms${build}) ---`,
  );
  timer = nativeSetInterval(() => {
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
    // Every timer callback that ran long inside this stall, whether or not
    // anybody wrapped it in a breadcrumb. This is the line that names an
    // uninstrumented culprit; `ran=none` names one too, by exclusion.
    const ran = censusFor(now, late);
    let extra = '';
    if (context) {
      try {
        extra = ` ${JSON.stringify(context())}`;
      } catch {
        /* context is a nicety */
      }
    }
    write(
      `${new Date(now).toISOString()} STALL ${late}ms during=${during}${open}${slowest}${ran}${extra}`,
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
  census.length = 0;
}

/** For the diagnostics panel / support bundle. */
function summary() {
  return {
    stalls: stallCount,
    worstMs,
    thresholdMs: THRESHOLD_MS,
    logPath,
    version: appVersion,
    census: censusOn,
  };
}

module.exports = {
  start,
  stop,
  mark,
  begin,
  end,
  around,
  installCensus,
  summary,
  TICK_MS,
  THRESHOLD_MS,
  CENSUS_FLOOR_MS,
};
