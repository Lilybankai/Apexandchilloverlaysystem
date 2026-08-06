/**
 * electron/lapUpload.js — sends the local lap database up to the league.
 * -----------------------------------------------------------------------------
 * The other half of `telemetry/lapLog`. That module writes every completed lap
 * to `~/.apex-overlay/laps/<date>.jsonl` and never touches the network; this one
 * carries what those files say up to Supabase and never touches the sim.
 *
 * The split is deliberate and is what makes a race weekend with no internet a
 * non-event: laps are recorded by the half that cannot fail for network reasons,
 * and uploading is a separate job that catches up whenever it can.
 *
 * ## What actually gets sent
 * Not laps. Two aggregates, both computed fresh from the files by
 * `buildUploadPlan()`:
 *
 *   - a per-day lap COUNT per track and class  → `submit_activity`
 *   - an all-time BEST clean lap per track and class → `submit_lap`
 *
 * Four hundred practice laps become one row saying "400", not four hundred rows.
 *
 * ## Why there is no queue
 * Both RPCs are idempotent — the server keeps the greater counter and the faster
 * lap — so the right client recomputes the desired state and sends it, rather
 * than maintaining a queue with a cursor that can desync from the data. See the
 * long note above `buildUploadPlan` in `lapLog.ts` for why that matters.
 *
 * `lap-sync.json` beside the app's settings is therefore a CACHE, not a ledger.
 * Delete it and the next run re-sends everything, which the server absorbs
 * without double-counting. It exists only so an idle app is not re-sending the
 * same forty rows every five minutes.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

/** Set by init() — where `lap-sync.json` lives. */
let userDataDir = null;
/** The auth module, injected so this can be driven headless by a test. */
let auth = null;
/** Lazily required from `dist/`, like the panel's summary handler. */
let lapLog = null;
/** Lazily required beside it — the trace store (`readTrace`). */
let lapTrace = null;

/**
 * How often to try, in ms. Laps arrive continuously while someone is driving,
 * but nothing downstream is real-time: the league board is read between
 * sessions, not during one. Five minutes keeps a long stint at a handful of
 * requests rather than one per lap.
 */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Most rows to send in one run, per kind.
 *
 * A driver returning after months offline could have hundreds of pending days.
 * Sending them all in one burst would stall the app's first minute and look, to
 * the API, exactly like something misbehaving. The remainder goes next run, and
 * because the plan is recomputed each time, "the remainder" needs no bookkeeping.
 */
const MAX_PER_RUN = 40;

/**
 * Most driving TRACES to send in one run — far fewer than the row kinds above,
 * because each is tens of KB where a row is tens of bytes. Five per run still
 * drains any realistic backlog within an evening (a new best per track per
 * class is a rare event), without ever turning a sync into an upload session.
 */
const MAX_TRACES_PER_RUN = 5;

/** Current state, mirrored to the renderer so a driver can see it working. */
const state = {
  /** 'idle' | 'syncing' | 'ok' | 'offline' | 'signed-out' | 'error' */
  status: 'idle',
  /** ms epoch of the last fully successful run, or null. */
  lastOkAt: null,
  /** Rows still waiting after the last run. */
  pending: 0,
  /** Rows sent by the last run. */
  sent: 0,
  /** Human-readable problem, when status is 'error'. */
  error: null,
};

let timer = null;
let running = false;
/** Called after every run so the panel can re-render. */
let onChange = () => {};

/* -------------------------------------------------------------------------- */
/*  The cache                                                                 */
/* -------------------------------------------------------------------------- */

function cachePath() {
  return path.join(userDataDir || '.', 'lap-sync.json');
}

function loadCache() {
  const empty = lapLog.emptySyncCache();
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    // Merged over a fresh shape rather than trusted: a cache written by an older
    // build may not have every field, and a missing one must mean "nothing sent"
    // rather than a crash on first read.
    return {
      activity: raw && typeof raw.activity === 'object' ? raw.activity : empty.activity,
      bests: raw && typeof raw.bests === 'object' ? raw.bests : empty.bests,
      traces: raw && typeof raw.traces === 'object' ? raw.traces : empty.traces,
      rejected: raw && typeof raw.rejected === 'object' ? raw.rejected : empty.rejected,
    };
  } catch {
    return empty; // first run, or hand-edited — re-send everything
  }
}

function saveCache(cache) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(cache), 'utf8');
  } catch (err) {
    // Losing the cache costs redundant requests next run, never correctness, so
    // this is logged and shrugged off rather than failing the sync.
    console.error('[laps] could not write sync cache:', err.message);
  }
}

/* -------------------------------------------------------------------------- */
/*  One run                                                                   */
/* -------------------------------------------------------------------------- */

/** Require the compiled lap log, or null when `dist/` is missing. */
function requireLapLog() {
  if (lapLog) return lapLog;
  try {
    lapLog = require(path.join(__dirname, '..', 'dist', 'telemetry', 'lapLog.js'));
  } catch (err) {
    console.error('[laps] lap log unavailable:', err.message);
    return null;
  }
  return lapLog;
}

/**
 * Require the compiled trace store, or null. Separate from `requireLapLog`
 * because a build that predates traces must still sync laps — a missing module
 * only means every trace reads as "no local file", which settles harmlessly.
 */
function requireLapTrace() {
  if (lapTrace) return lapTrace;
  try {
    lapTrace = require(path.join(__dirname, '..', 'dist', 'telemetry', 'lapTrace.js'));
  } catch {
    return null;
  }
  return lapTrace;
}

/**
 * Send everything the local files say is missing from the league database.
 *
 * Never throws and never rejects: it is called from a timer and from IPC, and
 * an uploader that can take down either is worse than one that quietly retries.
 */
async function sync({ reason = 'timer' } = {}) {
  if (running) return { ...state, skipped: 'already-running' };
  if (!requireLapLog()) {
    setState({ status: 'error', error: 'Lap database unavailable (run npm run build).' });
    return { ...state };
  }

  running = true;
  setState({ status: 'syncing', error: null });
  try {
    const plan = lapLog.buildUploadPlan();
    const cache = loadCache();
    const pending = lapLog.diffPlan(plan, cache);
    // Traces pend independently of their best row: a best can be cached as sent
    // while its trace is not — the feature shipped later, or a run stopped
    // between the two — and the plan is recomputed each run either way.
    const pendingTraces =
      typeof lapLog.traceNeedsSend === 'function'
        ? plan.bests.filter((row) => lapLog.traceNeedsSend(row, cache))
        : [];
    const total = pending.activity.length + pending.bests.length + pendingTraces.length;

    if (total === 0) {
      setState({ status: 'ok', pending: 0, sent: 0, lastOkAt: Date.now(), error: null });
      return { ...state };
    }

    // Bests first. If a run is cut short by a flaky connection, the thing a
    // driver cares about landing is the lap time, not the day's lap count.
    const bests = pending.bests.slice(0, MAX_PER_RUN);
    const activity = pending.activity.slice(0, MAX_PER_RUN);
    let sent = 0;
    let dirty = false;

    for (const row of bests) {
      const res = await sendBest(row, cache);
      if (res.stop) return finish(res, sent, total, dirty, cache);
      if (res.sent) sent++;
      dirty = dirty || res.cached;
    }
    for (const row of activity) {
      const res = await sendActivity(row, cache);
      if (res.stop) return finish(res, sent, total, dirty, cache);
      if (res.sent) sent++;
      dirty = dirty || res.cached;
    }
    // Traces last: the biggest payloads carrying the least urgent data. Every
    // best they describe has already been offered above, so the server-side
    // "is this the board lap" check can only fail for reasons that are
    // permanent — which is exactly what settling the cache entry records.
    for (const row of pendingTraces.slice(0, MAX_TRACES_PER_RUN)) {
      const res = await sendTrace(row, cache);
      if (res.stop) return finish(res, sent, total, dirty, cache);
      if (res.sent) sent++;
      dirty = dirty || res.cached;
    }

    if (dirty) saveCache(cache);
    const left = total - sent;
    setState({
      status: 'ok',
      sent,
      pending: left,
      lastOkAt: Date.now(),
      error: null,
    });
    if (reason !== 'timer' || sent) {
      console.log(`[laps] synced ${sent} row(s)${left ? `, ${left} still pending` : ''}`);
    }
    return { ...state };
  } catch (err) {
    // A bug in here must not stop the app or stop future attempts.
    setState({ status: 'error', error: err.message });
    console.error('[laps] sync failed:', err.message);
    return { ...state };
  } finally {
    running = false;
  }
}

/** Persist whatever landed before we stopped, and report why we stopped. */
function finish(res, sent, total, dirty, cache) {
  if (dirty) saveCache(cache);
  setState({
    status: res.signedOut ? 'signed-out' : 'offline',
    sent,
    pending: total - sent,
    error: res.signedOut ? null : res.error,
  });
  return { ...state };
}

/**
 * Classify one RPC result.
 *
 * Three outcomes, and telling them apart is the whole job:
 *   - **accepted** — cache it, never send it again.
 *   - **refused for good** (`accepted: false`) — the server has judged the row
 *     itself: an impossible time, a day out of range. Cache the refusal, because
 *     retrying is guaranteed to fail and would do so every five minutes forever.
 *   - **failed** — offline, a 500, a revoked token. Cache NOTHING and stop the
 *     run; the row is still pending and the next run will offer it again.
 */
function classify(res, key, cache) {
  if (res.ok) {
    const body = res.body || {};
    if (body.accepted === false) {
      lapLog.markRejected(cache, key, String(body.reason || 'refused'));
      console.warn(`[laps] server refused ${key}: ${body.reason}`);
      return { sent: false, cached: true, stop: false };
    }
    return { sent: true, cached: true, stop: false, body };
  }
  return { sent: false, cached: false, stop: true, signedOut: !!res.signedOut, error: res.error };
}

async function sendBest(row, cache) {
  const res = await auth.rpc('submit_lap', {
    p_sim: row.sim,
    p_track_key: row.trackKey,
    p_track_name: row.trackName,
    p_track_length_m: row.trackLengthM,
    p_car_class: row.carClass,
    p_car: row.car,
    p_lap_ms: row.lapMs,
    p_set_at: row.setAt,
    p_conditions: row.conditions,
    p_app_version: appVersion,
  });
  const out = classify(res, lapLog.bestKey(row), cache);
  if (out.sent) {
    lapLog.markBestSent(cache, row);
    // The server says whether this actually beat what was there and where it now
    // sits. Worth logging: it is the one moment the league becomes visible.
    if (out.body && out.body.improved) {
      console.log(`[laps] new best ${row.trackName} ${row.carClass}: P${out.body.rank}`);
    }
  }
  return out;
}

/**
 * Send one best lap's driving trace, when a local trace file exists for it.
 *
 * "No file" is settled, not retried: the trace was either never recorded
 * (spectating, shared memory down, a lap from before the recorder shipped) or
 * has been pruned, and neither changes on a five-minute timer. The entry
 * re-arms by itself when a faster lap replaces the best — see
 * `traceNeedsSend` in lapLog.ts.
 */
async function sendTrace(row, cache) {
  const traces = requireLapTrace();
  const file = traces ? traces.readTrace(row.lapId, row.setAt) : null;
  if (!file) {
    lapLog.markTraceSettled(cache, row);
    return { sent: false, cached: true, stop: false };
  }
  const res = await auth.rpc('submit_lap_trace', {
    p_sim: row.sim,
    p_track_key: row.trackKey,
    p_track_name: row.trackName,
    p_track_length_m: row.trackLengthM,
    p_car_class: row.carClass,
    p_car: row.car,
    p_lap_ms: row.lapMs,
    p_set_at: row.setAt,
    p_s1_ms: file.s1Ms ?? null,
    p_s2_ms: file.s2Ms ?? null,
    p_s3_ms: file.s3Ms ?? null,
    p_data: file.trace,
    p_app_version: appVersion,
  });
  const out = classify(res, `trace:${lapLog.bestKey(row)}`, cache);
  // Accepted and refused both settle: a refusal here (`not_board_lap`,
  // `trace_too_large`) is a judgement about this exact lap, and this exact lap
  // will never change. `classify` already recorded refusals in `rejected`;
  // settling by lap time is what lets a FUTURE faster lap try again.
  if (out.cached) lapLog.markTraceSettled(cache, row);
  if (out.sent) {
    console.log(`[laps] trace uploaded for ${row.trackName} ${row.carClass}`);
  }
  return out;
}

async function sendActivity(row, cache) {
  const res = await auth.rpc('submit_activity', {
    p_sim: row.sim,
    p_track_key: row.trackKey,
    p_track_name: row.trackName,
    p_track_length_m: row.trackLengthM,
    p_car_class: row.carClass,
    p_day: row.day,
    p_laps: row.laps,
    p_clean_laps: row.cleanLaps,
    p_distance_m: row.distanceM,
    p_driving_ms: row.drivingMs,
  });
  const out = classify(res, lapLog.activityKey(row), cache);
  if (out.sent) lapLog.markActivitySent(cache, row);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

let appVersion = '';

function setState(patch) {
  Object.assign(state, patch);
  try {
    onChange({ ...state });
  } catch {
    /* the window went away mid-run */
  }
}

/** Snapshot for the renderer. */
function stateForUi() {
  return { ...state };
}

/**
 * Start the background uploader.
 *
 * @param opts.userDataDir  where to keep `lap-sync.json`
 * @param opts.auth         the auth module (injected for headless tests)
 * @param opts.appVersion   stamped onto each submitted lap
 * @param opts.onChange     called with the state after every run
 */
function init(opts) {
  userDataDir = opts.userDataDir;
  auth = opts.auth;
  appVersion = opts.appVersion || '';
  if (typeof opts.onChange === 'function') onChange = opts.onChange;

  stop();
  timer = setInterval(() => void sync({ reason: 'timer' }), SYNC_INTERVAL_MS);
  // Timers must not hold the app open at quit.
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  init,
  stop,
  sync,
  stateForUi,
  // Exported for the offline test.
  SYNC_INTERVAL_MS,
  MAX_PER_RUN,
};
