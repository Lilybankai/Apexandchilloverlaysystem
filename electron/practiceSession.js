/**
 * electron/practiceSession.js — when a practice session has finished.
 * -----------------------------------------------------------------------------
 * The Practice Review (docs/PRACTICE-REVIEW-PLAN.md) is offered the moment the
 * driver leaves a practice session they actually drove in. Nothing in the feed
 * says "the session ended", so this watches the session the frames describe
 * and decides it, the way electron/trainingGate.js decides whether training
 * runs:
 *
 *   - A session STARTS on the first real (non-demo) frame whose session type
 *     is practice or a test day.
 *   - While it runs, every new positive `player.lap.last` is a timed lap, and
 *     every change of `player.ghost.sourceLapId` is reported — the lap being
 *     chased, which main snapshots as the review's target.
 *   - It ENDS when the feed says plainly that this is another session (a race,
 *     qualifying, warm-up: at once), or says nothing — no frame, a loading
 *     screen, `unknown`, the demo simulator standing in for a closed sim — for
 *     END_HOLD_MS. A loading screen between two practice runs is a few seconds
 *     and must not end anything; the training gate's 10 s hold proves those
 *     gaps exist, and this hold is longer than it.
 *
 * One `ended` per session, and only for a session with at least one timed
 * lap: a driver who loaded in, looked around and left has nothing to review.
 * Returning to practice after an end starts a new session.
 *
 * Pure: no Electron, an injected clock. scripts/test-practicesession.js drives it.
 */

'use strict';

/**
 * How long the feed may say nothing before a practice session is over. The
 * training gate's hold (10 s) already rides out loading screens; at 20 s the
 * "review ready" notice landed after Carl had stopped looking (2026-10-08).
 */
const END_HOLD_MS = 10000;

/** Sessions that are reviewed as practice. */
const PRACTICE_SESSIONS = new Set(['practice', 'testday']);

/**
 * What one frame says about the session: `{ type }` from a real frame, `null`
 * for a demo frame or no frame (a gap, not a session).
 */
function sessionTypeOf(frame) {
  if (!frame || typeof frame !== 'object' || frame.connected === false) return null;
  const s = frame.session;
  return s && typeof s.type === 'string' && s.type ? s.type : 'unknown';
}

/** The player's standings row, for the car and class, when the frame has one. */
function playerRow(frame) {
  const rows = Array.isArray(frame.standings) ? frame.standings : [];
  for (const r of rows) if (r && r.isPlayer) return r;
  return null;
}

/**
 * @param {{ onEnded?: (s: object) => void, onGhost?: (g: object) => void }} [o]
 */
function createPracticeWatch(o = {}) {
  /** The session being watched, or null. */
  let cur = null;
  /** When a real frame last said "this is practice". */
  let lastSeenAt = 0;
  const ended = [];
  const ghosts = [];

  function emit(list, cb, value) {
    list.push(value);
    if (typeof cb === 'function') {
      try {
        cb(value);
      } catch {
        /* a listener must never be the feed's problem */
      }
    }
  }

  function finish(now) {
    const s = cur;
    cur = null;
    if (!s || s.laps < 1) return;
    emit(ended, o.onEnded, {
      track: s.track,
      car: s.car,
      carClass: s.carClass,
      sessionType: s.type,
      laps: s.laps,
      bestLapSec: s.bestLapSec,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date(s.lastSeenAt || now).toISOString(),
      ghostLapId: s.ghostLapId,
    });
  }

  return {
    /**
     * One frame, or `null` for "time passed with no frame" (the watchdog's
     * beat, which is what lets a silent feed end a session).
     */
    update(frame, now) {
      const type = frame === null ? null : sessionTypeOf(frame);
      const practice = type !== null && PRACTICE_SESSIONS.has(type);

      if (practice) {
        if (!cur) {
          cur = {
            type,
            track: '',
            car: '',
            carClass: '',
            startedAt: now,
            lastSeenAt: now,
            laps: 0,
            bestLapSec: null,
            lastLap: NaN,
            ghostLapId: '',
          };
        }
        cur.lastSeenAt = now;
        lastSeenAt = now;
        const s = frame.session || {};
        if (typeof s.track === 'string' && s.track) cur.track = s.track;
        const row = playerRow(frame);
        if (row) {
          if (typeof row.carClass === 'string' && row.carClass) cur.carClass = row.carClass;
          // The feed has no model name on the row; the lap log has it, and main
          // prefers that. The manufacturer is the best the frame can do.
          const car = row.vehicle || row.car || row.carName || row.manufacturer;
          if (typeof car === 'string' && car) cur.car = car;
        }
        const p = frame.player || {};
        const last = p.lap && typeof p.lap.last === 'number' ? p.lap.last : -1;
        // A new positive last-lap time is a lap completed. The first reading
        // is a baseline, not a lap: joining with a time already on the board
        // (a lap driven before the app connected) is not this session's.
        if (Number.isNaN(cur.lastLap)) {
          cur.lastLap = last;
        } else if (last > 0 && last !== cur.lastLap) {
          cur.lastLap = last;
          cur.laps += 1;
          if (cur.bestLapSec === null || last < cur.bestLapSec) cur.bestLapSec = last;
        }
        const g = p.ghost;
        const gid = g && typeof g.sourceLapId === 'string' ? g.sourceLapId : '';
        if (gid && gid !== cur.ghostLapId) {
          cur.ghostLapId = gid;
          emit(ghosts, o.onGhost, { sourceLapId: gid, sourceLabel: g.sourceLabel || '', refLapSec: g.refLapSec });
        }
        return;
      }

      if (!cur) return;
      if (type !== null && type !== 'unknown') {
        // The sim says plainly this is something else: over now.
        finish(now);
        return;
      }
      // A gap. Over once it has lasted the hold.
      if (now - lastSeenAt >= END_HOLD_MS) finish(now);
    },

    /** The session being watched, for diagnostics; null between sessions. */
    current() {
      return cur ? { ...cur } : null;
    },

    /** Everything emitted so far (tests). */
    _ended: ended,
    _ghosts: ghosts,
  };
}

module.exports = { createPracticeWatch, sessionTypeOf, END_HOLD_MS, PRACTICE_SESSIONS };
