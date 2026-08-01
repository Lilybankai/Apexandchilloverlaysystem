/**
 * electron/usageReporter.js — the app's usage heartbeat.
 * -----------------------------------------------------------------------------
 * The one new data source behind the admin panel. Everything else the league can
 * see about usage arrives only when someone COMPLETES laps (see lapUpload.js) —
 * which misses a streamer who opened the app and ran overlays without ever
 * touching the lap counter. This module lands one row the moment the app opens
 * and refreshes it on a timer, so "how many people, how often" counts every run.
 *
 * It sends exactly one thing: a `record_session` upsert with a client-generated
 * session id, the app version and a coarse OS string. No telemetry, no lap data,
 * nothing about what was on screen — just "this install was open, from then to
 * now". The server keeps the later `last_seen`, so the row is idempotent the same
 * way `submit_activity` is, and re-sending it costs nothing.
 *
 * Signed-in only, by design (matches the product decision): `auth.rpc` reports
 * `signedOut` when there is no session, and this module simply skips quietly
 * until the driver signs in. Nothing here ever throws — it is driven from a timer
 * and from startup, and an uploader that can take either of those down is worse
 * than one that silently retries next tick.
 */

'use strict';

const os = require('node:os');
const crypto = require('node:crypto');

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

/** The auth module, injected so this can be driven headless by a test. */
let auth = null;
/** Stamped onto each heartbeat. */
let appVersion = '';

/**
 * How often to refresh the row, in ms. A session's value is its duration and the
 * fact it happened at all; neither needs second-precision, and a five-minute
 * heartbeat keeps a long stream at a dozen requests rather than one a second.
 * The same cadence the lap uploader runs at.
 */
const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * The current run's identity, generated once per process. Held module-level so
 * every heartbeat updates the SAME row rather than inserting a new one — that is
 * what makes duration (`last_seen - started`) meaningful and the write idempotent.
 */
const sessionId = crypto.randomUUID();
const startedAt = new Date().toISOString();

/**
 * A coarse OS label — platform plus major release, nothing that identifies the
 * machine. Enough to answer "how many are on Windows 11 vs 10" without being a
 * fingerprint.
 */
function osLabel() {
  try {
    return `${process.platform} ${os.release()}`.slice(0, 32);
  } catch {
    return String(process.platform || '').slice(0, 32);
  }
}

let timer = null;

/* -------------------------------------------------------------------------- */
/*  One beat                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Send one heartbeat. Never throws and never rejects.
 *
 * @returns {Promise<{sent:boolean, signedOut?:boolean, error?:string}>}
 */
async function beat({ reason = 'timer' } = {}) {
  if (!auth || typeof auth.rpc !== 'function') return { sent: false, error: 'not-initialised' };
  try {
    const res = await auth.rpc('record_session', {
      p_session_id: sessionId,
      p_app_version: appVersion,
      p_os: osLabel(),
      p_started_at: startedAt,
      p_last_seen_at: new Date().toISOString(),
    });
    if (res.ok) return { sent: true };
    // Signed out is a state, not an error — the next beat tries again once a
    // driver signs in. Anything else (offline, a 500) is likewise retried.
    if (res.signedOut) return { sent: false, signedOut: true };
    return { sent: false, error: res.error };
  } catch (err) {
    // A bug in here must not stop the app or the timer.
    console.error('[usage] heartbeat failed:', err.message);
    return { sent: false, error: err.message };
  }
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Start the heartbeat: one beat now (so a short session still counts), then one
 * every {@link HEARTBEAT_MS}.
 *
 * @param opts.auth        the auth module (injected for headless tests)
 * @param opts.appVersion  stamped onto each heartbeat
 */
function init(opts = {}) {
  auth = opts.auth || null;
  appVersion = opts.appVersion || '';

  stop();
  // Fire once immediately — a five-minute stream should not be invisible.
  void beat({ reason: 'startup' });
  timer = setInterval(() => void beat({ reason: 'timer' }), HEARTBEAT_MS);
  // Must not hold the app open at quit.
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
  beat,
  // Exported for tests / diagnostics.
  sessionId,
  HEARTBEAT_MS,
};
