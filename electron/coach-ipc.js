/**
 * coach-ipc.js — the AI driving coach's IPC (2026-10-29).
 * =============================================================================
 *
 * Everything between the renderer and the model. Registered from main.js with
 * one line beside the `practice:*` handlers:
 *
 *   require('./coach-ipc').register(ipcMain, {
 *     authService,                 // electron/auth.js (rpc, functionsInvoke)
 *     reviewDir: () => string,     // practice-reviews folder (snapshots)
 *     userDataDir: () => string,   // app.getPath('userData'), for coach-cache/
 *     practiceAllowed: () => bool, // practiceOnThisChannel(loadSettings())
 *   });
 *
 * Handlers (all answer `{ ok, ..., error? }`; see coach-brief "Renderer API"):
 *
 *   practice:coach    { sessionId, targetLapId? }
 *                     → { ok, report }               template words, fast
 *   practice:coachAi  { sessionId, targetLapId? }
 *                     → { ok, report, ai, cached }   source 'ai'; ok:false keeps
 *                                                    the template on screen
 *   practice:coachLap { sessionId, lapId, at, targetLapId? }
 *                     → { ok, report, breakdown, show }
 *   review:coach      the object the Review tab sends `review:lap`
 *                     ({ id, at, haveMapKey?, vs }) → { ok, report, breakdown, show }
 *   coach:ai          a CoachAiRequest (kind 'habits' etc.; inputHash optional),
 *                     or { report, context? } → { ok, ai, cached }
 *
 * The three practice ones are beta-gated like the rest of the Practice tab
 * (`practiceOnThisChannel`). `review:coach` and `coach:ai` are not: Review is
 * a stable tab, and the coach function checks membership itself.
 *
 * ## The AI cache
 * The request is hashed (report version + kind + context + every fact's id,
 * value, unit and text). An answer is kept in `userData/coach-cache/<hash>.json`,
 * so reopening a session is free and works offline; the cloud keeps the same
 * key per user (coach_calls) so a reinstall is free too. Identical requests in
 * flight at once share one call.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist', 'telemetry');
const CACHE_V = 1;
const MAX_FACTS = 60;
const AI_TIMEOUT_MS = 30000;

const str = (v) => (typeof v === 'string' ? v : '');
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);

function coachLoad() {
  return require(path.join(DIST, 'coachLoad.js'));
}
function coachReport() {
  return require(path.join(DIST, 'coachReport.js'));
}

/* -------------------------------------------------------------------------- */
/*  Requests and hashes (pure; exported for scripts/test-coachipc.js)        */
/* -------------------------------------------------------------------------- */

/** Facts as they go to the cloud: the fields the function reads, capped. */
function wireFacts(facts) {
  return (Array.isArray(facts) ? facts : [])
    .filter((f) => f && typeof f.id === 'string' && typeof f.text === 'string' && Number.isFinite(Number(f.value)))
    .slice(0, MAX_FACTS)
    .map((f) => {
      const out = { id: f.id, kind: str(f.kind), value: Number(f.value), unit: str(f.unit), text: f.text };
      if (typeof f.cornerId === 'string') out.cornerId = f.cornerId;
      if (typeof f.phase === 'string') out.phase = f.phase;
      return out;
    });
}

function wireContext(c) {
  const x = c && typeof c === 'object' ? c : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    track: str(x.track),
    car: str(x.car),
    carClass: str(x.carClass),
    targetLabel: str(x.targetLabel),
    lapSec: num(x.lapSec),
    refSec: num(x.refSec),
  };
}

/** The cache key: everything the model sees, and the template version that made it. */
function inputHash(kind, context, facts, version) {
  const canon = JSON.stringify([
    version,
    kind,
    [context.track, context.car, context.carClass, context.targetLabel, context.lapSec, context.refSec],
    facts.map((f) => [f.id, f.value, f.unit, f.text]),
  ]);
  return crypto.createHash('sha256').update(canon).digest('hex');
}

/** A CoachAiRequest from a report and its context. */
/**
 * A report's facts, most important first, for when there are more than
 * MAX_FACTS (a Road Atlanta session has 85). Report order puts every corner's
 * detail before the session-wide facts, so a plain cut dropped exactly what
 * the takeaways cite — the braking pattern, the sector, the aim. First the
 * facts the template cites, then the session-wide ones, then the rest as
 * they came.
 */
function factsByWeight(report) {
  const facts = Array.isArray(report && report.facts) ? report.facts : [];
  const cited = new Set([
    ...(Array.isArray(report.takeaways) ? report.takeaways : []).flatMap((t) => (t && Array.isArray(t.factIds) ? t.factIds : [])),
    ...(Array.isArray(report.worst) ? report.worst : []).flatMap((w) => (w && Array.isArray(w.factIds) ? w.factIds : [])),
  ]);
  const rank = (f) => (cited.has(f && f.id) ? 0 : /^(?:session|pattern|seq|fair|lap|S\d)\./.test(String(f && f.id)) ? 1 : 2);
  return facts
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map((x) => x.f);
}

function requestFromReport(report, context, version) {
  const kind = report && report.scope === 'lap' ? 'lap' : 'session';
  const ctx = wireContext(context);
  const facts = wireFacts(report ? factsByWeight(report) : []);
  return { kind, inputHash: inputHash(kind, ctx, facts, version), context: ctx, facts };
}

/** A caller's own CoachAiRequest, cleaned; the hash is recomputed so a cache entry can't be aimed. */
function requestFromRaw(req, version) {
  const kind = ['session', 'lap', 'habits'].includes(req && req.kind) ? req.kind : null;
  if (!kind) return null;
  const ctx = wireContext(req.context);
  const facts = wireFacts(req.facts);
  if (!facts.length) return null;
  return { kind, inputHash: inputHash(kind, ctx, facts, version), context: ctx, facts };
}

function contextOfReview(review) {
  return {
    track: review.track,
    car: review.car,
    carClass: review.carClass,
    targetLabel: review.target ? review.target.label : '',
    lapSec: review.bestLapSec,
    refSec: review.target ? review.target.lapSec : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  The AI call, with its two caches                                          */
/* -------------------------------------------------------------------------- */

function createAi({ authService, userDataDir }) {
  const inflight = new Map();
  const cacheDir = () => path.join(userDataDir(), 'coach-cache');
  const cacheFile = (hash) => path.join(cacheDir(), `${hash}.json`);

  function readCache(hash) {
    try {
      const v = JSON.parse(fs.readFileSync(cacheFile(hash), 'utf8'));
      return v && v.v === CACHE_V && v.ai && Array.isArray(v.ai.takeaways) ? v.ai : null;
    } catch {
      return null;
    }
  }

  function writeCache(hash, req, ai) {
    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      const tmp = `${cacheFile(hash)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_V, at: new Date().toISOString(), kind: req.kind, ai }));
      fs.renameSync(tmp, cacheFile(hash));
    } catch (err) {
      console.error('[coach] cache write failed:', err.message);
    }
  }

  async function callCloud(req) {
    const res = await authService.functionsInvoke('coach', req, { timeoutMs: AI_TIMEOUT_MS });
    if (!res || !res.ok) {
      const status = res && res.status;
      const code = res && res.signedOut ? 'signed-out'
        : status === 403 ? 'entitled'
          : status === 404 ? 'unavailable'
            : status === 429 ? 'burst'
              : 'error';
      return { ok: false, ai: null, code, error: (res && res.error) || 'Coach unavailable.' };
    }
    const body = res.body || {};
    if (!body.ok || !body.ai) return { ok: false, ai: null, code: body.code || 'rejected', error: body.error || 'No coach reply.' };
    return { ok: true, ai: body.ai, cached: !!body.cached };
  }

  /** `{ ok, ai, cached }` for a cleaned request. */
  async function ask(req) {
    const hit = readCache(req.inputHash);
    if (hit) return { ok: true, ai: hit, cached: true };
    if (inflight.has(req.inputHash)) return inflight.get(req.inputHash);
    const p = (async () => {
      try {
        const out = await callCloud(req);
        if (out.ok) writeCache(req.inputHash, req, out.ai);
        return out;
      } catch (err) {
        return { ok: false, ai: null, code: 'error', error: err.message };
      } finally {
        inflight.delete(req.inputHash);
      }
    })();
    inflight.set(req.inputHash, p);
    return p;
  }

  return { ask, readCache };
}

/* -------------------------------------------------------------------------- */
/*  Registration                                                              */
/* -------------------------------------------------------------------------- */

function register(ipcMain, deps) {
  const { authService } = deps;
  const reviewDir = () => (typeof deps.reviewDir === 'function' ? deps.reviewDir() : deps.reviewDir);
  const allowed = () => (typeof deps.practiceAllowed === 'function' ? !!deps.practiceAllowed() : true);
  const ai = createAi({ authService, userDataDir: deps.userDataDir });
  const gated = { ok: false, report: null, error: 'Practice is a beta feature.' };

  /** The leaderboard target behind `targetLapId`, fetched as review:practice fetches it. */
  const loaderDeps = async (args) => {
    const out = { reviewDir: reviewDir() };
    // Resolved by main.js exactly as review:practice resolves it, so the
    // coach measures against the lap the debrief beside it shows.
    if (args.targetLapId && typeof deps.targetOpts === 'function') {
      try {
        const t = await deps.targetOpts(args.sessionId, args.targetLapId);
        if (t && t.opts && t.opts.target) out.target = t.opts.target;
        if (t && t.opts && t.opts.sessionBest) out.sessionBest = true;
      } catch {
        /* the session's own target stands */
      }
    }
    return out;
  };

  const sessionArgs = (req) => ({
    sessionId: str(req && req.sessionId),
    targetLapId: strOrNull(req && req.targetLapId),
  });

  ipcMain.handle('practice:coach', async (_evt, req) => {
    if (!allowed()) return gated;
    const args = sessionArgs(req);
    if (!args.sessionId) return { ok: false, report: null, error: 'no session' };
    try {
      const out = coachLoad().loadSessionCoach(args, await loaderDeps(args));
      return out ? { ok: true, report: out.report } : { ok: false, report: null, error: 'session not found' };
    } catch (err) {
      console.error('[app] practice coach unavailable:', err.message);
      return { ok: false, report: null, error: err.message };
    }
  });

  ipcMain.handle('practice:coachAi', async (_evt, req) => {
    if (!allowed()) return gated;
    const args = sessionArgs(req);
    if (!args.sessionId) return { ok: false, report: null, error: 'no session' };
    try {
      const out = coachLoad().loadSessionCoach(args, await loaderDeps(args));
      if (!out) return { ok: false, report: null, error: 'session not found' };
      const R = coachReport();
      if (!out.report.facts.length || !out.report.takeaways.length) {
        return { ok: false, report: null, code: 'nothing', error: 'Nothing for the coach to say yet.' };
      }
      const request = requestFromReport(out.report, contextOfReview(out.review), R.COACH_REPORT_VERSION);
      const res = await ai.ask(request);
      if (!res.ok) return { ok: false, report: null, code: res.code, error: res.error };
      const merged = R.applyAi(out.report, res.ai);
      if (merged.source !== 'ai') return { ok: false, report: null, code: 'rejected', error: 'The coach reply did not fit this session.' };
      return { ok: true, report: merged, ai: res.ai, cached: !!res.cached };
    } catch (err) {
      console.error('[app] practice coach AI unavailable:', err.message);
      return { ok: false, report: null, error: err.message };
    }
  });

  ipcMain.handle('practice:coachLap', async (_evt, req) => {
    if (!allowed()) return { ...gated, breakdown: null, show: [] };
    const args = { ...sessionArgs(req), lapId: str(req && req.lapId), at: str(req && req.at) };
    if (!args.sessionId || !args.lapId) return { ok: false, report: null, breakdown: null, show: [], error: 'no lap' };
    try {
      const out = coachLoad().loadLapCoach(args, await loaderDeps(args));
      return out
        ? { ok: true, report: out.report, breakdown: out.breakdown, show: out.show }
        : { ok: false, report: null, breakdown: null, show: [], error: 'lap not found' };
    } catch (err) {
      console.error('[app] practice lap coach unavailable:', err.message);
      return { ok: false, report: null, breakdown: null, show: [], error: err.message };
    }
  });

  /**
   * The Review tab's comparison, coached. Same argument as `review:lap`; a
   * board lap's trace is fetched exactly as that handler fetches it.
   */
  ipcMain.handle('review:coach', async (_evt, req) => {
    const none = { ok: false, report: null, breakdown: null, show: [] };
    const id = str(req && req.id);
    const at = str(req && req.at);
    if (!id || !at) return { ...none, error: 'no lap' };
    try {
      const vs = req && req.vs && typeof req.vs === 'object' ? req.vs : null;
      let boardPayload = null;
      if (vs && vs.board && typeof vs.board === 'object') {
        const ref = {
          p_driver_id: str(vs.board.driverId),
          p_track_id: str(vs.board.trackId),
          p_car_class: str(vs.board.carClass),
        };
        if (!ref.p_driver_id || !ref.p_track_id || !ref.p_car_class) return { ...none, error: 'no board lap' };
        const res = await authService.rpc('get_lap_trace', ref);
        if (!res.ok) return { ...none, error: res.signedOut ? 'signed-out' : 'unavailable' };
        boardPayload = res.body;
      }
      const args = { id, at, haveMapKey: str(req.haveMapKey), vs };
      const out = coachLoad().loadReviewCoach(args, { boardPayload });
      return out ? { ok: true, report: out.report, breakdown: out.breakdown, show: out.show } : { ...none, error: 'no comparison' };
    } catch (err) {
      console.error('[app] review coach unavailable:', err.message);
      return { ...none, error: err.message };
    }
  });

  /** A CoachAiRequest (or `{ report, context }`) → the validated AI words. */
  ipcMain.handle('coach:ai', async (_evt, req) => {
    try {
      const R = coachReport();
      const request = req && req.report && Array.isArray(req.report.facts)
        ? requestFromReport(req.report, req.context, R.COACH_REPORT_VERSION)
        : requestFromRaw(req, R.COACH_REPORT_VERSION);
      if (!request || !request.facts.length) return { ok: false, ai: null, error: 'no facts' };
      const res = await ai.ask(request);
      return res.ok ? { ok: true, ai: res.ai, cached: !!res.cached } : { ok: false, ai: null, code: res.code, error: res.error };
    } catch (err) {
      console.error('[app] coach AI unavailable:', err.message);
      return { ok: false, ai: null, error: err.message };
    }
  });
}

module.exports = {
  register,
  // For scripts/test-coachipc.js.
  _test: { wireFacts, wireContext, inputHash, requestFromReport, requestFromRaw, createAi },
};
