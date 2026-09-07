/**
 * electron/stall-profiler.js — the stack that was on the thread when it froze.
 * -----------------------------------------------------------------------------
 * The census in {@link module:electron/stall-watch} can only name work that was
 * scheduled through a timer, because a wrapper is all it has: it patches
 * `setInterval` and `setTimeout` and times the synchronous part of each fire.
 * That covers exactly one of the ways code gets onto this thread, and it is not
 * the way this app mostly runs. Every poller here is `async`, so the expensive
 * half — everything after the first `await` — is a promise continuation,
 * drained by the microtask queue, wrapped by nothing. An IPC handler, a socket
 * `data` event, a native callback and a garbage collection are all invisible
 * for the same reason.
 *
 * That is why every stall in the 30 Aug–7 Sep logs reads `ran=none`. It is not
 * evidence that no JavaScript ran; it is the shape of the blind spot.
 *
 * A sampling profiler has no blind spot. V8 interrupts the thread on a fixed
 * clock and writes down the stack it finds, whatever put it there, and it
 * labels the frames it cannot attribute to JavaScript: `(garbage collector)`
 * when V8 has stopped the world, `(program)` when the thread is inside the VM
 * or a native call. So the answer to "what held the loop for two seconds" is
 * whichever frame owns the samples between the last healthy tick and this one.
 *
 * The profiler runs continuously in short windows and throws each window away
 * when the next one starts, so the cost is a fixed 1 ms interrupt and a few
 * thousand samples in memory — never a growing buffer. A stall stops the
 * current window, reads the samples inside the freeze, and starts the next one;
 * the log gets a one-line verdict and, for the long freezes, a `.cpuprofile`
 * next to stalls.log that opens in Chrome DevTools as-is.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * How often V8 interrupts the thread, in MICROseconds. 1 ms puts ~250 samples
 * inside the smallest stall the watcher reports, which is enough for a leaf to
 * win by a margin rather than by luck.
 */
const SAMPLE_US = 1000;
/**
 * Throw the samples away and start again this often. The window only has to
 * outlive one stall; keeping more is memory spent on a freeze that already has
 * its answer.
 */
const WINDOW_MS = 30_000;
/** Write a `.cpuprofile` for a stall at least this long. */
const DUMP_FLOOR_MS = 750;
/** Profiles kept on disk. The newest freeze is the one anybody opens. */
const KEEP_DUMPS = 6;
/** Frames named in the log line. Past three it is noise, not evidence. */
const TOP_FRAMES = 3;
/**
 * The instrument's own frames. Reading a profile means stopping it, writing a
 * file and starting the next window, and all of that lands in the window that
 * has just opened — so back-to-back stalls would otherwise be blamed on the
 * profiler, which is the one answer that is never useful.
 */
const SELF_RE = /stall-profiler\.js$|^node:inspector/;
/**
 * A verdict needs this share of the freeze covered by samples, and at least
 * this many milliseconds of them, before it is worth printing. A window that
 * opened halfway through the stall holds a handful of samples of whatever came
 * last, and naming that would be a guess presented as a measurement.
 */
const MIN_COVERAGE = 0.3;
const MIN_SAMPLED_MS = 50;

let session = null;
let dumpDir = '';
/** Wall clock at the moment the current window started, to date its samples. */
let windowWallMs = 0;
/** `startTime` of the current window in V8's own microsecond clock. */
let windowBaseUs = 0;
let running = false;
/** Newest first, so the oldest is the one that gets deleted. */
const dumps = [];
let lastError = '';

/**
 * V8 gives sample times in its own microsecond clock. Both clocks advance at
 * the same rate over a 30 s window, so anchoring the profile's `startTime` to
 * the wall clock read as it began is accurate to well inside one sample.
 */
function wallOf(us) {
  return windowWallMs + (us - windowBaseUs) / 1000;
}

/**
 * Post a message and hand back the reply. The inspector session for this
 * isolate dispatches in-process, so the reply lands before `post` returns — but
 * a runtime that ever made it asynchronous would otherwise leave us reading a
 * profile that has not arrived, so the reply is proven rather than assumed.
 */
function ask(method, params) {
  let reply;
  session.post(method, params, (err, result) => {
    if (err) lastError = String((err && err.message) || err);
    else reply = result;
  });
  return reply;
}

/** Begin a window, remembering the wall clock it has to be read against. */
function openWindow() {
  windowWallMs = Date.now();
  // `Profiler.start` does not report its own origin, so the microsecond base
  // stays unknown until the profile is stopped and says where it began.
  windowBaseUs = 0;
  ask('Profiler.start');
}

/**
 * Start profiling. Safe to call on a runtime with no inspector (a locked-down
 * build, a future Electron): the watcher then reports without a `hot=` field
 * rather than failing to report at all.
 *
 * @param {string} dir where to write `.cpuprofile` dumps
 * @returns {boolean} whether sampling is on
 */
function start(dir) {
  if (running) return true;
  if (process.env.APEX_STALL_PROFILE === '0') return false;
  try {
    const inspector = require('node:inspector');
    session = new inspector.Session();
    session.connect();
    ask('Profiler.enable');
    ask('Profiler.setSamplingInterval', { interval: SAMPLE_US });
    dumpDir = dir;
    running = true;
    openWindow();
    return true;
  } catch (err) {
    lastError = String((err && err.message) || err);
    session = null;
    running = false;
    return false;
  }
}

function stop() {
  if (!running) return;
  try {
    ask('Profiler.stop');
    ask('Profiler.disable');
    session.disconnect();
  } catch {
    /* a diagnostic must never be the thing that breaks shutdown */
  }
  session = null;
  running = false;
}

/**
 * Recycle the window if it has run long enough. Called on the watcher's happy
 * path, so it does nothing but compare two numbers unless it is time.
 */
function recycle(now) {
  if (!running) return;
  if (now - windowWallMs < WINDOW_MS) return;
  ask('Profiler.stop');
  openWindow();
}

/** `name file:line`, or the bare V8 label for `(garbage collector)` and kin. */
function frameName(node) {
  const f = (node && node.callFrame) || {};
  const name = f.functionName || '(anonymous)';
  if (!f.url) return name;
  const file = f.url.startsWith('node:')
    ? f.url
    : path.basename(f.url.replace(/^file:\/\/\/?/, ''));
  return `${name} ${file}:${(f.lineNumber === undefined ? -1 : f.lineNumber) + 1}`;
}

/**
 * Self time per stack leaf between `from` and `to`, and the profile trimmed to
 * the same span. Self time is the honest measure for a freeze: the frame that
 * owns the samples is the frame that was executing, while total time would hand
 * the verdict to whatever happened to be at the bottom of every stack.
 */
function slice(profile, from, to) {
  const byId = new Map();
  const mine = new Set();
  for (const n of profile.nodes || []) {
    byId.set(n.id, n);
    const url = (n.callFrame && n.callFrame.url) || '';
    if (SELF_RE.test(url.replace(/^file:\/\/\/?/, ''))) mine.add(n.id);
  }
  const self = new Map();
  const samples = [];
  const deltas = [];
  let t = profile.startTime;
  let inWindow = 0;
  const ids = profile.samples || [];
  const dt = profile.timeDeltas || [];
  for (let i = 0; i < ids.length; i++) {
    t += dt[i] || 0;
    const at = wallOf(t);
    if (at < from) continue;
    if (at > to) break;
    // Kept in the dump — a human reading the profile should see the whole
    // window — but never counted towards the verdict.
    samples.push(ids[i]);
    deltas.push(dt[i] || 0);
    if (mine.has(ids[i])) continue;
    const ms = (dt[i] || 0) / 1000;
    inWindow += ms;
    self.set(ids[i], (self.get(ids[i]) || 0) + ms);
  }
  const top = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_FRAMES)
    .map(([id, ms]) => ({ name: byId.has(id) ? frameName(byId.get(id)) : `node#${id}`, ms }));
  return { top, inWindow, trimmed: { ...profile, samples, timeDeltas: deltas } };
}

function pruneDumps() {
  while (dumps.length > KEEP_DUMPS) {
    const old = dumps.pop();
    try {
      fs.unlinkSync(old);
    } catch {
      /* already gone */
    }
  }
}

/**
 * What the thread was doing during a stall of `late` ms that ended at `now`, as
 * a log fragment. Stops the current window to read it and opens the next one,
 * so two stalls in a row each get their own answer.
 *
 * The window opened here starts AFTER the stall, which is why the field comes
 * back empty on the first stall of a session: there is no profile older than
 * the profiler. Every stall after that has one.
 */
function report(now, late, lead = 200) {
  if (!running) return '';
  const profile = ask('Profiler.stop');
  if (!profile || !profile.profile) {
    openWindow();
    return '';
  }
  const p = profile.profile;
  // V8 reports the window's own origin, so anchor the sample clock on it rather
  // than on the wall clock read a fraction of a millisecond earlier.
  windowBaseUs = p.startTime;
  const from = now - late - lead;
  const { top, inWindow, trimmed } = slice(p, from, now);
  openWindow();
  // Say so rather than going quiet: a missing field reads as "the profiler is
  // not running", and the difference matters to whoever reads the log next.
  if (!top.length || inWindow < MIN_SAMPLED_MS || inWindow < late * MIN_COVERAGE) {
    return ` hot=unsampled(${Math.round(inWindow)}ms of ${late}ms)`;
  }
  const parts = top.map((f) => `${f.name}/${Math.round(f.ms)}ms`);
  let dump = '';
  if (late >= DUMP_FLOOR_MS && dumpDir) {
    const name = `stall-${new Date(now).toISOString().replace(/[:.]/g, '-')}.cpuprofile`;
    const file = path.join(dumpDir, name);
    try {
      fs.writeFileSync(file, JSON.stringify(trimmed));
      dumps.unshift(file);
      pruneDumps();
      dump = ` profile=${name}`;
    } catch {
      /* the log line is the part that matters */
    }
  }
  return ` hot=${parts.join(',')} sampled=${Math.round(inWindow)}ms${dump}`;
}

/** For the diagnostics panel / support bundle. */
function summary() {
  return {
    running,
    sampleUs: SAMPLE_US,
    windowMs: WINDOW_MS,
    dumps: dumps.length,
    error: lastError,
  };
}

module.exports = {
  start,
  stop,
  recycle,
  report,
  summary,
  slice,
  frameName,
  SAMPLE_US,
  WINDOW_MS,
  DUMP_FLOOR_MS,
  MIN_COVERAGE,
  MIN_SAMPLED_MS,
};
