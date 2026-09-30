/**
 * electron/schedule-cloud.js — the Schedule tab's calendars, shared with the web.
 * -----------------------------------------------------------------------------
 * The web pit wall (aio.apexandchillracing.co.uk) shows the same Schedule tab
 * as the desktop, but a browser can read neither of its sources: SimGrid sends
 * no CORS headers, and RaceOS only answers a Steam ticket minted by a running
 * copy of the game. So the desktop — which reads both anyway — publishes what
 * it read to public.schedule_feed (migration 0037), and the web reads that.
 *
 * ## Two ways a calendar gets published
 *
 *   - **offer()** — every live read the Schedule tab makes is offered here,
 *     fire-and-forget. Costs nothing extra: the fetch already happened.
 *   - **sweep()** — every half hour, one cheap RPC asks how old the shared
 *     copies are, and ONLY a stale one is re-read and published. That is what
 *     keeps the web current when nobody has opened the tab, without a room full
 *     of running apps each fetching RaceOS: the first app to notice refreshes
 *     it, and every other app then sees a fresh copy and does nothing.
 *
 * The daily calendar needs the game running (the ticket), so on a PC sitting at
 * the desktop the dailies half of a sweep is one failed loopback connection.
 *
 * ## What it must never send
 *
 * `forPublish` (control-panel/schedule-core.js) decides: live reads only (a
 * copy restored from this PC's disk could overwrite a fresher one), and the
 * "you are entered" flags cleared — the row is shown to every member, and
 * another driver's entry must not read as theirs.
 */

'use strict';

const core = require('./control-panel/schedule-core.js');

/** Between sweeps. */
const SWEEP_MS = 30 * 60 * 1000;
/** After launch or sign-in, let the session settle before the first look. */
const FIRST_LOOK_MS = 2 * 60 * 1000;
/**
 * How old a shared copy may get before a sweep replaces it. The league moves
 * weekly (a new round, a few more sign-ups); the dailies' TIMES never go stale
 * (the web regenerates them from the rotation) but their special-event entry
 * counts do, and so do the circuits once LMU rotates them for the week.
 */
const STALE_SEC = { league: 3 * 3600, dailies: 2 * 3600 };
/** Never publish the same calendar twice inside this — the server caps it too. */
const PUBLISH_GAP_MS = 10 * 60 * 1000;

const SOURCES = ['league', 'dailies'];

let auth = null;
/** source → ({ force }) => Promise<payload>, the same reads the tab makes. */
let readers = {};
let timer = null;
let busy = false;
const lastSent = { league: 0, dailies: 0 };

function signedIn() {
  try {
    return !!(auth && auth.stateForUi().signedIn);
  } catch {
    return false;
  }
}

/**
 * Send one calendar to the shared feed. Resolves to the server's answer, or
 * `{ ok: false, reason }` — never throws, because nothing that calls this has
 * anything useful to do with a failure.
 */
async function publish(source, payload, now = Date.now()) {
  if (!SOURCES.includes(source)) return { ok: false, reason: 'bad_source' };
  if (!signedIn()) return { ok: false, reason: 'signed_out' };
  const copy = core.forPublish(source, payload);
  if (!copy) return { ok: false, reason: 'nothing' };
  if (now - lastSent[source] < PUBLISH_GAP_MS) return { ok: false, reason: 'recent' };
  lastSent[source] = now;

  const fetchedMs = Date.parse(copy.fetchedAt);
  const fetchedAt = Number.isFinite(fetchedMs) ? new Date(fetchedMs).toISOString() : new Date(now).toISOString();
  try {
    const res = await auth.rpc('schedule_feed_publish', {
      p_source: source,
      p_payload: copy,
      p_fetched_at: fetchedAt,
    });
    if (!res.ok) return { ok: false, reason: res.signedOut ? 'signed_out' : 'rpc', error: res.error };
    return res.body || { ok: true };
  } catch (err) {
    return { ok: false, reason: 'rpc', error: err && err.message };
  }
}

/** A live read the Schedule tab just made. Fire-and-forget. */
function offer(source, payload) {
  void publish(source, payload).catch(() => {});
}

/**
 * Refresh whichever shared calendar has gone stale. One RPC when both are
 * fresh, which is nearly always.
 */
async function sweep() {
  if (busy || !signedIn()) return { ok: false, reason: busy ? 'busy' : 'signed_out' };
  busy = true;
  const done = {};
  try {
    const age = await auth.rpc('schedule_feed_age', {});
    // Not ok = signed out, offline, or the migration is not on this project
    // yet. All three mean "try again next sweep", quietly.
    if (!age.ok || !age.body || age.body.ok !== true) return { ok: false, reason: 'age' };
    for (const source of SOURCES) {
      const sec = age.body[source];
      if (Number.isFinite(sec) && sec < STALE_SEC[source]) continue;
      const read = readers[source];
      if (typeof read !== 'function') continue;
      let payload = null;
      try {
        payload = await read({ force: false });
      } catch {
        payload = null;
      }
      done[source] = await publish(source, payload);
    }
    return { ok: true, done };
  } catch {
    return { ok: false, reason: 'error' };
  } finally {
    busy = false;
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.auth      the auth module (rpc + stateForUi)
 * @param {object} opts.readers   { league, dailies } — each `({ force }) =>
 *                                Promise<payload>`, the Schedule tab's reads
 */
function init(opts) {
  auth = opts.auth;
  readers = opts.readers || {};
  stop();
  timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref?.();
  setTimeout(() => void sweep(), FIRST_LOOK_MS).unref?.();
}

/** Signed in (or out): a new account gets its first look after the settle. */
function onAuthChanged() {
  if (!auth) return;
  setTimeout(() => void sweep(), FIRST_LOOK_MS).unref?.();
}

/** Tests only. */
function _reset() {
  stop();
  auth = null;
  readers = {};
  busy = false;
  lastSent.league = 0;
  lastSent.dailies = 0;
}

module.exports = {
  SOURCES,
  STALE_SEC,
  PUBLISH_GAP_MS,
  init,
  offer,
  publish,
  sweep,
  stop,
  onAuthChanged,
  _reset,
};
