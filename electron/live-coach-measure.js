/**
 * electron/live-coach-measure.js — one just-driven practice lap, found in the
 * lap log and measured the way the Practice tab measures it.
 * -----------------------------------------------------------------------------
 * The disk half of the live practice coach (electron/live-coach.js). Given a
 * lap the practice watcher saw cross the line — its time, the wall clock at
 * the crossing, the track — {@link createMeasurer}'s `attempt` answers:
 *
 *   - `{ found: false }` while the lap is not in the lap log yet. It will not
 *     be for a while: the recorder HOLDS every lap ~40 s for the stewards'
 *     track-limits verdict before writing it (lapLog.ts VERDICT_HOLD_MS), and
 *     writes its trace in the same tick. The caller retries; an attempt whose
 *     day file has not grown since the last one is a `stat` and nothing more.
 *   - At the line instead (`req.extra`, the server's `LapAtLine`): no look
 *     at all. The record as judged so far is grouped with the logged laps,
 *     and its in-memory trace is measured (coachLoad `extraLap`) against the
 *     reference the logged laps give — `lap.provisional`. `verify` then
 *     watches for the record by id, for its verdict.
 *   - `{ found: true, lap }` once it is: the lap record, the lap-log session
 *     it belongs to (the in-progress counterpart of main.js
 *     `findPracticeSessionId`: the session that CONTAINS this lap, which is
 *     the one the Practice tab will show), whether it may be coached, and its
 *     breakdown against the same target the Practice tab would use
 *     (coachLoad.ts `loadLapCoach`): the chased lap when one is given, else
 *     the session's own best so far.
 *
 * Measuring costs ~150 ms of synchronous file reading and arithmetic on a
 * real log (55 day files, a 23-lap session; 2026-11-03), far too long for the
 * main thread, which composites every overlay. So main runs it in a worker
 * (electron/live-coach-worker.js, {@link createWorkerClient}); the tests and
 * the real-data replay call {@link createMeasurer} directly.
 *
 * No Electron in here: the dist telemetry build and `node:fs` only.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist', 'telemetry');

/** A record's `at` and the frame that saw the lap land within one REST poll; this is generous. */
const MATCH_AT_MS = 15000;
/** The record's lap time and the frame's are the same sim reading, rounded to whole ms. */
const MATCH_LAP_MS = 150;

const dayStamp = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The record for a lap that crossed the line at `ev.atMs` in `ev.lapSec`, or
 * null. Nearest crossing wins when two would do (they cannot, in practice: a
 * lap is longer than the window).
 */
function matchRecord(records, ev) {
  const want = Math.round(Number(ev.lapSec) * 1000);
  if (!(want > 0) || !Number.isFinite(ev.atMs)) return null;
  let best = null;
  let bestGap = Infinity;
  for (const r of records) {
    if (!r || typeof r.lapMs !== 'number' || typeof r.at !== 'string') continue;
    if (Math.abs(r.lapMs - want) > MATCH_LAP_MS) continue;
    if (ev.track && r.track && r.track !== ev.track) continue;
    const gap = Math.abs(Date.parse(r.at) - ev.atMs);
    if (!(gap <= MATCH_AT_MS) || gap >= bestGap) continue;
    best = r;
    bestGap = gap;
  }
  return best;
}

/**
 * The lap-log session a live lap belongs to: the grouped session holding the
 * record (by id; by time and track for a pre-v3 record with none), and the
 * lap as the review numbers it. Null when grouping lost it, which it cannot.
 */
function findLiveSession(sessions, rec) {
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const s = sessions[i];
    for (const st of s.stints) {
      for (const l of st.laps) {
        if (rec.id ? l.id === rec.id : l.at === rec.at && s.trackKey === rec.trackKey) return { session: s, lap: l };
      }
    }
  }
  return null;
}

/**
 * May this lap be coached? Not an out-lap or an in-lap, nothing on it the
 * Apex rule calls dirty (a pit visit, a cut the stewards charged, a penalty,
 * a partial lap, an implausible time), a real time, and a trace to measure.
 */
function coachable(rec, reviewLap) {
  if (!rec || rec.clean !== true) return false;
  if (rec.isOutLap === true || rec.isInLap === true) return false;
  if (!(rec.lapMs > 0)) return false;
  if (!reviewLap || reviewLap.timed !== true || reviewLap.isOutLap || reviewLap.isInLap) return false;
  return reviewLap.hasTrace === true;
}

/** The session's best valid lap so far (the reference when nothing is chased), `except` one lap. */
function sessionBestOf(session, except = null) {
  let best = null;
  for (const st of session.stints) {
    for (const l of st.laps) {
      if (except && l.id === except) continue;
      if (l.clean === true && l.timed === true && l.lapMs > 0 && (!best || l.lapMs < best.lapMs)) best = l;
    }
  }
  return best;
}

/**
 * @param {{ lapDir?: string, traceDir?: string, reviewDir?: string, dist?: string }} [io]
 */
function createMeasurer(io = {}) {
  const dist = io.dist || DIST;
  const lapLog = require(path.join(dist, 'lapLog.js'));
  const stint = require(path.join(dist, 'stintReview.js'));
  const lapTrace = require(path.join(dist, 'lapTrace.js'));
  const coachLoad = require(path.join(dist, 'coachLoad.js'));
  const lapDir = () => io.lapDir || lapLog.lapDir();
  const traceDir = () => io.traceDir || lapTrace.traceDir();

  /** Day-file sizes already searched, per lap asked about: an unchanged file is not read again. */
  const seen = new Map();
  /** Chased targets by lap id, so their columns cross the worker boundary once. */
  const targets = new Map();

  function dayFiles(atMs) {
    const days = new Set([dayStamp(atMs - MATCH_AT_MS), dayStamp(atMs), dayStamp(atMs + MATCH_AT_MS)]);
    return [...days].map((d) => ({ day: d, file: path.join(lapDir(), `${d}.jsonl`) }));
  }

  /** The record, if a day file that grew since the last look now holds it. */
  function lookUp(req, byId) {
    const key = `${byId ? 'id:' + byId : ''}${req.atMs}|${req.lapSec}`;
    let sizes = seen.get(key);
    if (!sizes) {
      sizes = new Map();
      seen.set(key, sizes);
      if (seen.size > 20) seen.delete(seen.keys().next().value);
    }
    for (const { day, file } of dayFiles(req.atMs)) {
      let size = -1;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      if (sizes.get(day) === size) continue;
      sizes.set(day, size);
      const recs = lapLog.readDay(day, lapDir());
      const rec = byId ? recs.find((r) => r && r.id === byId) || null : matchRecord(recs, req);
      if (rec) return rec;
    }
    return null;
  }

  function targetOf(req) {
    const t = req.target;
    if (!t || !t.lapId) return null;
    if (t.columns) {
      targets.set(t.lapId, t);
      if (targets.size > 4) targets.delete(targets.keys().next().value);
      return t;
    }
    return targets.get(t.lapId) || null;
  }

  /**
   * One look. `req`: `{ lapSec, atMs, track?, target?, reviewDir?, extra? }`
   * with `target` the chased lap as main snapshots it (`{ kind, label, lapId,
   * lapSec, columns }`; columns may be left off once sent) or null for the
   * session's best.
   *
   * `extra`: the lap AT THE LINE (`{ record, trace }`, the server's
   * `LapAtLine`), before the lap log has it. Then nothing is looked up: the
   * record (its verdict so far) is grouped with the logged laps to find its
   * session, and the in-memory trace is measured (coachLoad `extraLap`)
   * against the reference the logged laps give. `lap.provisional` says so.
   */
  function attempt(req) {
    const t0 = Date.now();
    // Before the look, which marks the day file read: a target this worker
    // has lost (it was replaced) is asked for again, not silently dropped.
    const target = targetOf(req);
    if (req.target && !target) return { found: false, needTarget: true };
    const extra = req.extra && req.extra.record && req.extra.record.id && req.extra.trace ? req.extra : null;
    const rec = extra ? extra.record : lookUp(req);
    if (!rec) return { found: false };
    const t1 = Date.now();
    const records = stint.readAllLaps(lapDir());
    // In memory only until the verdict hold lets it out: group it with the rest.
    const provisional = !!extra && !records.some((r) => r && r.id === rec.id);
    if (provisional) records.push(rec);
    const sessions = stint.groupSessions(records, traceDir());
    const hit = findLiveSession(sessions, rec);
    const sessionId = hit ? hit.session.id : null;
    const reviewLap = hit ? (provisional ? { ...hit.lap, hasTrace: true } : hit.lap) : null;
    const valid = coachable(rec, reviewLap);
    // The reference is the logged laps' best: the lap at the line is not one of them.
    const best = hit ? sessionBestOf(hit.session, provisional ? rec.id : null) : null;
    const trackLengthM = Number(rec.trackLengthM) || (hit ? hit.session.trackLengthM : 0) || 0;

    let breakdown = null;
    let error = null;
    const t2 = Date.now();
    if (sessionId && rec.id && reviewLap && reviewLap.hasTrace) {
      try {
        const reviewDir = req.reviewDir || io.reviewDir || '';
        const deps = {
          reviewDir,
          lapDir: lapDir(),
          traceDir: traceDir(),
          ...(target ? { target } : { sessionBest: true }),
          ...(provisional ? { extraLap: { lapId: rec.id, at: rec.at, lapMs: rec.lapMs, trace: extra.trace } } : {}),
        };
        const out = coachLoad.loadLapCoach(
          { sessionId, lapId: rec.id, at: rec.at, targetLapId: target ? target.lapId : 'sessionBest' },
          deps,
        );
        breakdown = out ? out.breakdown : null;
      } catch (err) {
        error = err && err.message ? err.message : String(err);
      }
    }
    // A lap measured against itself (it IS the session's new best) says
    // nothing: every corner reads zero, which a coach would hear as "fixed".
    const selfRef = !!(breakdown && breakdown.refLapId === rec.id);
    if (selfRef) breakdown = null;
    const refLapId = target ? target.lapId : best ? best.id || null : null;
    const refSec = target ? Number(target.lapSec) || null : best ? best.lapMs / 1000 : null;
    const lapSec = rec.lapMs / 1000;
    const deltaSec = breakdown
      ? breakdown.totalSec + (Number(breakdown.residualSec) || 0)
      : refSec
        ? lapSec - refSec
        : null;
    const t3 = Date.now();
    return {
      found: true,
      lap: {
        lapId: rec.id || `${rec.at}`,
        at: rec.at,
        lapNo: reviewLap ? reviewLap.lapNo : 0,
        lapSec,
        valid,
        clean: rec.clean === true,
        dirty: Array.isArray(rec.dirty) ? rec.dirty.slice() : [],
        isOutLap: rec.isOutLap === true,
        isInLap: rec.isInLap === true,
        hasTrace: !!(reviewLap && reviewLap.hasTrace),
        trackLengthM,
        sessionId,
        refLapId,
        refSec,
        deltaSec,
        selfRef,
        provisional,
        breakdown,
        error,
      },
      ms: { find: t1 - t0, session: t2 - t1, measure: t3 - t2, total: t3 - t0 },
    };
  }

  /**
   * The lap log's verdict on a lap measured at the line: `{ found: false }`
   * until its record lands, then whether it may still be coached. `req`:
   * `{ lapId, atMs, lapSec }`. A look at an unchanged day file is a `stat`.
   */
  function verify(req) {
    const rec = lookUp(req, req.lapId);
    if (!rec) return { found: false };
    return {
      found: true,
      lapId: rec.id,
      clean: rec.clean === true,
      dirty: Array.isArray(rec.dirty) ? rec.dirty.slice() : [],
      isOutLap: rec.isOutLap === true,
      isInLap: rec.isInLap === true,
      lapMs: rec.lapMs,
      // The trace was in hand at the line; the rest is the record's.
      valid: rec.clean === true && rec.isOutLap !== true && rec.isInLap !== true && rec.lapMs > 0,
    };
  }

  return { attempt, verify };
}

/* -------------------------------------------------------------------------- */
/*  The worker, from main's side                                              */
/* -------------------------------------------------------------------------- */

/** How long one attempt may take in the worker before main stops waiting for it. */
const ATTEMPT_TIMEOUT_MS = 15000;

/**
 * `measure(req) → Promise<attempt result | null>`, run on a worker thread so
 * main never pays for it. Started on first use; a worker that dies is
 * replaced on the next call (and the chased lap's columns are sent again).
 * A failure or a timeout answers null, which the service treats as "not
 * there yet" until its own deadline.
 *
 * @param {{ reviewDir?: () => string, log?: (line: string) => void, workerPath?: string, io?: { lapDir?: string, traceDir?: string } }} [o]
 */
function createWorkerClient(o = {}) {
  const log = typeof o.log === 'function' ? o.log : () => {};
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  /** Target lap ids this worker already holds the columns of. */
  let sent = new Set();

  function gone(w, why) {
    if (worker !== w) return;
    worker = null;
    sent = new Set();
    for (const [, p] of pending) p.resolve(null);
    pending.clear();
    if (why) log(`[livecoach] measuring worker gone: ${why}`);
  }

  function ensure() {
    if (worker) return worker;
    const { Worker } = require('node:worker_threads');
    // `io` (lapDir / traceDir) only for tests and the replay harness; main
    // leaves it out and the worker reads the driver's own log.
    const w = new Worker(o.workerPath || path.join(__dirname, 'live-coach-worker.js'), { workerData: { io: o.io || {} } });
    w.unref();
    w.on('message', (m) => {
      const p = m && pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (!m.ok) log(`[livecoach] measure failed: ${m.error}`);
      p.resolve(m.ok ? m.result : null);
    });
    w.on('error', (err) => gone(w, err && err.message));
    w.on('exit', (code) => gone(w, code ? `exit ${code}` : ''));
    worker = w;
    return w;
  }

  function call(op, req) {
    return new Promise((resolve) => {
      let w;
      try {
        w = ensure();
      } catch (err) {
        log(`[livecoach] no measuring worker: ${err && err.message}`);
        resolve(null);
        return;
      }
      const id = nextId++;
      const body = { ...req, reviewDir: typeof o.reviewDir === 'function' ? o.reviewDir() : req.reviewDir };
      if (req.target && req.target.lapId) {
        if (sent.has(req.target.lapId)) body.target = { lapId: req.target.lapId };
        else sent.add(req.target.lapId);
      }
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve(null);
      }, ATTEMPT_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, {
        timer,
        resolve: (v) => {
          // The worker lost the columns (it was replaced): send them again next time.
          if (v && v.needTarget && req.target) sent.delete(req.target.lapId);
          resolve(v);
        },
      });
      try {
        w.postMessage({ id, op, req: body });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        log(`[livecoach] could not post to the measuring worker: ${err && err.message}`);
        resolve(null);
      }
    });
  }

  return {
    measure(req) {
      return call('attempt', req);
    },
    verify(req) {
      return call('verify', req);
    },
    close() {
      if (worker) {
        const w = worker;
        gone(w, '');
        void w.terminate();
      }
    },
  };
}

module.exports = {
  createMeasurer,
  createWorkerClient,
  matchRecord,
  findLiveSession,
  coachable,
  sessionBestOf,
  MATCH_AT_MS,
  MATCH_LAP_MS,
};
