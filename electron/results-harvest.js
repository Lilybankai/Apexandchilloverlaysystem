/**
 * electron/results-harvest.js — official race results, from the game to the cloud.
 * -----------------------------------------------------------------------------
 * The second half of docs/DISCORD-NOTIFICATIONS.md, and the only part of it
 * that has to run on a driver's PC.
 *
 * RaceOS publishes the full classification of every official event, but the
 * token for it is bought with a Steam session ticket from the running game, so
 * no server can ever fetch it. This module does the fetch, projects the payload
 * down (src/telemetry/raceosResults.ts) and hands the result to
 * `submit_event_results`, which dedupes on the event id — twelve members of a
 * league all uploading the same race produce one row and one Discord message.
 *
 * ## Why it does not simply poll
 *
 * The payload is ~230 KB PER EVENT (2.3 MB for ten, measured). Polling it every
 * few minutes would be megabytes an hour of someone's connection to learn
 * nothing, and most of the time nothing is what there is to learn. So:
 *
 *   - Nothing happens at all unless the game is running. The ticket call fails
 *     in milliseconds against a closed port, which is the cheapest possible
 *     "no".
 *   - A poll asks for ONE event (`take=1`, ~230 KB). If its id is already in
 *     the ledger, the driver has not finished anything since the last look and
 *     the poll stops there. Only a genuinely new event triggers the wider
 *     `take=3` fetch that catches a triple-header run while the app was shut.
 *   - The ledger is on disk, so restarting the app does not re-upload a week of
 *     racing — the RPC would dedupe it anyway, but a megabyte per launch to
 *     discover that is not free either.
 *
 * ## What it must never send
 *
 * Only the projection's whitelist: names, positions, laps, times, status. Not
 * ratings (the service redacts other players' anyway, and republishing a leak
 * would be our doing) and never anything from `api/v1/player`, which returns
 * the account's email address and a live verification code. This is the one
 * pipeline in the product that ends in a public Discord message, and it is the
 * projection — not this file — that decides what survives.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Between polls, when the game is up and something has been driven. */
const POLL_MS = 15 * 60 * 1000;
/** After sign-in or launch, wait for the session to settle before the first look. */
const FIRST_LOOK_MS = 60 * 1000;
/** How many events the catch-up fetch asks for once a new one is spotted. */
const CATCHUP_TAKE = 3;
/** Ledger cap — event keys are ~40 bytes and this is only a "seen it" set. */
const LEDGER_MAX = 400;

let auth = null;
let client = null;
let ledgerPath = null;
/** Event keys already uploaded, newest last. */
let seen = [];
let timer = null;
/** The one-off look scheduled when the driver's name first becomes known. */
let nameTimer = null;
let running = false;
/** Set by main whenever a frame arrives: the game is up and being driven. */
let dirty = false;
let lastNames = [];

function signedIn() {
  try {
    return !!(auth && auth.stateForUi().signedIn);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  The ledger                                                                */
/* -------------------------------------------------------------------------- */

function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    seen = Array.isArray(raw.seen) ? raw.seen.filter((k) => typeof k === 'string') : [];
  } catch {
    seen = [];
  }
}

function remember(key) {
  if (seen.includes(key)) return;
  seen.push(key);
  if (seen.length > LEDGER_MAX) seen = seen.slice(-LEDGER_MAX);
  try {
    fs.writeFileSync(ledgerPath, JSON.stringify({ seen }, null, 0));
  } catch {
    // A ledger we cannot write means we re-upload next launch and the RPC says
    // "already have it". Wasteful, not wrong — never worth failing over.
  }
}

/* -------------------------------------------------------------------------- */
/*  The harvest                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One pass. Cheap when there is nothing to find, which is nearly always.
 *
 * `reason` is only for the log line; `force` skips the "has anything been
 * driven" gate, for the manual button and the first look after sign-in.
 */
async function harvest({ reason = 'poll', force = false } = {}) {
  if (running || !signedIn() || !client) return { ok: false, skipped: true };
  if (!force && !dirty) return { ok: true, skipped: true };
  // Nothing to do until the driver has a name. `api/v1/results` is the
  // service's GLOBAL recent-results feed, not this account's history, so a
  // pass that cannot tell which row is ours would upload whatever strangers
  // finished last — which on 2026-09-17 was 24 of 39 uploads.
  if (!lastNames.length) return { ok: true, skipped: true, reason: 'no-name' };
  running = true;
  try {
    // One event. If we already know it, nothing has been finished since the
    // last look and this costs a single request instead of a megabyte.
    const probe = await client.fetchRecent(lastNames, 1);
    if (!probe.length) {
      // Either the game is shut, the token could not be bought, or this account
      // has never run an official event. All three are ordinary.
      dirty = false;
      return { ok: true, events: 0 };
    }
    if (seen.includes(probe[0].eventKey)) {
      dirty = false;
      return { ok: true, events: 0 };
    }

    const events = await client.fetchRecent(lastNames, CATCHUP_TAKE);
    const fresh = events.filter((e) => !seen.includes(e.eventKey));
    let stored = 0;

    for (const event of fresh) {
      // Not our race. Remembered so the next pass does not pay to rediscover
      // it; a race we WERE in but could not be matched to is the same outcome,
      // and the server refuses those anyway (see 0033).
      if (!event.mine) {
        remember(event.eventKey);
        continue;
      }
      const res = await auth.rpc('submit_event_results', {
        p_event_key: event.eventKey,
        p_event_type: event.eventType,
        p_name: event.name,
        p_track: event.track,
        p_started_at: event.startedAt,
        p_classification: event.classification,
        p_me: event.mine || '',
      });
      if (!res.ok) {
        // Offline, or the token expired mid-batch. Leave it out of the ledger
        // and the next pass picks it up; the RPC is idempotent either way.
        console.error('[results] upload failed:', res.error);
        break;
      }
      if (res.body && res.body.ok === false) {
        // A refusal is about THIS event's shape and will not improve on a
        // retry — remember it so we stop paying for it every pass.
        console.error(`[results] refused (${res.body.reason}): ${event.eventKey}`);
        remember(event.eventKey);
        continue;
      }
      remember(event.eventKey);
      stored++;
    }

    if (stored) console.log(`[results] ${stored} event(s) uploaded (${reason})`);
    dirty = false;
    return { ok: true, events: stored };
  } catch (err) {
    console.error('[results] harvest threw:', err && err.message ? err.message : err);
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    running = false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} opts
 * @param {object} opts.auth          the auth module (rpc + stateForUi)
 * @param {string} opts.userDataDir   where the ledger lives
 * @param {number} [opts.lmuApiPort]  LMU's loopback port
 * @param {Function} opts.loadClient  () => RaceosResultsClient ctor, injected so
 *                                    this file does not reach into dist/ itself
 *                                    (and so the test can hand it a fake)
 */
function init(opts) {
  auth = opts.auth;
  ledgerPath = path.join(opts.userDataDir, 'results-sync.json');
  loadLedger();
  // Per-run state, explicitly cleared: "something has been driven" and "this is
  // what the driver is called" are both claims about a session that has not
  // started yet. Carrying either across an init would spend a request on
  // nothing, or tag a classification row with a name from another account.
  dirty = false;
  lastNames = [];

  try {
    const Ctor = opts.loadClient();
    client = new Ctor({ lmuApiPort: opts.lmuApiPort || 6397 });
  } catch (err) {
    // The compiled module is missing — a dev running electron without a build.
    // Results simply do not harvest; nothing else cares.
    console.error('[results] no RaceOS client:', err && err.message ? err.message : err);
    client = null;
  }

  stop();
  timer = setInterval(() => void harvest({ reason: 'poll' }), POLL_MS);
  timer.unref?.();
  // The startup look stays for the case where a name is already known (a
  // re-init mid-session); with none it returns 'no-name' and costs nothing.
  setTimeout(() => void harvest({ reason: 'startup', force: true }), FIRST_LOOK_MS).unref?.();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (nameTimer) {
    clearTimeout(nameTimer);
    nameTimer = null;
  }
}

/**
 * Called by main on every frame. Two jobs, both cheap enough for 1 Hz: note
 * that the game is up and being driven, and keep the driver's own name current
 * so their row in a classification can be identified.
 */
function noteFrame(frame) {
  dirty = true;
  // The standings row flagged as ours carries the name the results service
  // will have used, which the PlayerState block does not — same row
  // team-snapshot.js reaches for, and for the same reason.
  const mine = frame && Array.isArray(frame.standings)
    ? frame.standings.find((row) => row && row.isPlayer)
    : null;
  const name = mine && mine.driverName ? String(mine.driverName).trim() : '';
  if (name && !lastNames.includes(name)) {
    // Kept, not replaced: a driver who renames mid-season still matches the
    // results of races they ran under the old name.
    const firstName = lastNames.length === 0;
    lastNames = [...lastNames.slice(-4), name];
    // The first name of the session is what the startup look was waiting for:
    // it fired 60 s after launch, usually before any frame, and uploaded with
    // no idea which row was ours. Now it runs the moment it can be useful.
    if (firstName) {
      if (nameTimer) clearTimeout(nameTimer);
      nameTimer = setTimeout(() => void harvest({ reason: 'first-name', force: true }), 5000);
      nameTimer.unref?.();
    }
  }
}

function onAuthChanged() {
  if (!signedIn()) return;
  setTimeout(() => void harvest({ reason: 'sign-in', force: true }), FIRST_LOOK_MS).unref?.();
}

module.exports = {
  init,
  stop,
  harvest,
  noteFrame,
  onAuthChanged,
  // For scripts/test-results.js.
  _state: () => ({ seen: [...seen], dirty, names: [...lastNames] }),
  POLL_MS,
  CATCHUP_TAKE,
  LEDGER_MAX,
};
