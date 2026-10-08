/**
 * electron/trainingGate.js — whether the training overlays should be running.
 * -----------------------------------------------------------------------------
 * Training overlays (Ghost HUD first) live in their own window and may cost more
 * than the race overlays, so they run only when the driver has asked for them
 * AND the session is one where training makes sense. Four things must all hold:
 *
 *   mode     Training mode is selected (settings.trainingMode)
 *   beta     the install follows the beta channel (main's channel helper)
 *   running  the overlay server is up
 *   session  the sim is in a practice session or a test day
 *
 * The first three are deliberate choices and act immediately. The session is
 * not: between two practice sessions, and on every loading screen, LMU reports
 * no session or `unknown` for a few seconds. Tearing the window down for that
 * and building it again a moment later would cost a renderer start and a page
 * load each time, so the last ELIGIBLE answer is held for HOLD_MS across a gap.
 * A session that says what it is — a race, qualifying, warm-up — ends the hold
 * at once: that is the case the gate exists for.
 *
 * Demo frames (the simulator) are never a session, whether demo mode was chosen
 * or LMU closed and the simulator stood in. The simulator labels every frame a
 * race, so the only honest reading is "no sim": a gap, which a practice answer
 * may be held across. Training is not previewable in demo mode.
 *
 * Pure: no Electron, an injected clock. scripts/test-training-gate.js drives it.
 */

'use strict';

/** How long a practice answer survives a loading screen or a session change. */
const HOLD_MS = 10000;

/** Sessions the training overlays run in. */
const ELIGIBLE_SESSIONS = new Set(['practice', 'testday']);

/**
 * The session part of one telemetry frame, in the shape the gate reads.
 * `null` when the frame says nothing about a session.
 */
function sessionOfFrame(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const type =
    frame.session && typeof frame.session.type === 'string' ? frame.session.type : 'unknown';
  return { type, demo: frame.connected === false };
}

/**
 * Evaluate the gate once. Exported for the tests; the stateful wrapper below is
 * what main uses.
 *
 * @param {{ mode: boolean, beta: boolean, running: boolean,
 *           session: { type: string, demo: boolean } | null }} inputs
 * @param {number} now
 * @param {number} lastEligibleAt  when the session was last seen eligible (0 = never)
 * @returns {{ active: boolean, reason: string, sessionType: string|null,
 *             lastEligibleAt: number, heldUntil: number }}
 */
function evaluate(inputs, now, lastEligibleAt) {
  const s = inputs.session;
  // A demo frame is no session at all (see the header).
  const seen = s && !s.demo ? s.type : null;
  let eligibleAt = lastEligibleAt;
  let sessionOk;
  let sessionType = seen;
  if (seen && ELIGIBLE_SESSIONS.has(seen)) {
    eligibleAt = now;
    sessionOk = true;
  } else if (seen && seen !== 'unknown') {
    // The sim says plainly what this is, and it is not practice: no hold.
    eligibleAt = 0;
    sessionOk = false;
  } else {
    // A gap — no frame, a loading screen, the simulator standing in for a
    // closed sim. Keep the last practice answer for a while.
    sessionOk = eligibleAt > 0 && now - eligibleAt < HOLD_MS;
    sessionType = null;
  }
  const heldUntil = sessionOk && sessionType === null ? eligibleAt + HOLD_MS : 0;

  // The first failing condition is the reason, in the order a driver would
  // fix them: the mode they chose, then the app, then the sim.
  let reason = 'live';
  if (!inputs.beta) reason = 'channel';
  else if (!inputs.mode) reason = 'race-mode';
  else if (!inputs.running) reason = 'stopped';
  else if (!sessionOk) reason = seen && seen !== 'unknown' ? 'session' : 'no-session';

  return {
    active: reason === 'live',
    reason,
    sessionType,
    lastEligibleAt: eligibleAt,
    heldUntil,
  };
}

/**
 * The stateful gate. `update(partial, now)` merges new inputs and re-evaluates;
 * calling it with `{}` just lets time pass, which is how a held answer expires.
 * Subscribers hear every change of `active` or `reason`, with the old state.
 */
function createTrainingGate() {
  const inputs = { mode: false, beta: false, running: false, session: null };
  let lastEligibleAt = 0;
  let state = { active: false, reason: 'channel', sessionType: null, heldUntil: 0 };
  const listeners = new Set();

  return {
    update(partial, now) {
      if (partial && typeof partial === 'object') {
        for (const key of Object.keys(inputs)) {
          if (partial[key] !== undefined) inputs[key] = partial[key];
        }
      }
      const next = evaluate(inputs, now, lastEligibleAt);
      lastEligibleAt = next.lastEligibleAt;
      const prev = state;
      state = {
        active: next.active,
        reason: next.reason,
        sessionType: next.sessionType,
        heldUntil: next.heldUntil,
      };
      if (prev.active !== state.active || prev.reason !== state.reason) {
        for (const fn of listeners) {
          try {
            fn(state, prev);
          } catch {
            /* one listener must not stop the others hearing it */
          }
        }
      }
      return state;
    },

    /** The current answer: `{ active, reason, sessionType, heldUntil }`. */
    state() {
      return state;
    },

    /** Hear changes; returns the unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

module.exports = { createTrainingGate, evaluate, sessionOfFrame, HOLD_MS, ELIGIBLE_SESSIONS };
