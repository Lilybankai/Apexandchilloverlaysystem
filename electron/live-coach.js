/**
 * electron/live-coach.js — the live practice coach, while the driver drives.
 * -----------------------------------------------------------------------------
 * The Practice tab's coach, during the session rather than after it
 * (src/telemetry/liveCoachContract.ts). After every timed lap of a practice
 * session or test day this service:
 *
 *   1. takes the lap AT THE LINE. The lap log will not have it for ~40 s —
 *      the recorder holds each lap for the stewards' track-limits verdict
 *      (lapLog.ts VERDICT_HOLD_MS) — so the server hands main its own copy
 *      the moment the lap completes (`setLapCompleteListener` → main →
 *      {@link onLapAtLine}): the record as judged so far (out- and in-lap,
 *      pit, partial, a cut or penalty already charged) and the trace. The
 *      practice watcher's lap is matched to it by lap time and crossing
 *      clock (≤ {@link DEFAULTS.crossingWaitMs}). Without one (another sim,
 *      no trace, an older server) it falls back to the lap log: a look a
 *      second for up to {@link DEFAULTS.retryForMs}, then quiet. Either way
 *      the work runs on a worker thread (live-coach-measure.js), which
 *   2. measures it the way the Practice tab will: coachLoad.ts `loadLapCoach`
 *      against the lap being chased (main's `practiceTarget` snapshot — a
 *      board lap when Ghost HUD chases one) or else the session's own best so
 *      far, inside the lap-log session that holds the lap;
 *   3. steps the engine (liveCoach.ts `stepLiveCoach`, pure and fast) with a
 *      {@link LiveCoachLap}, says each call through the engineer, and
 *      publishes the in-game card ({@link LiveCoachOverlay}, `player.coach`).
 *      A lap taken at the line is PROVISIONAL: when its record lands with a
 *      dirty verdict (a cut charged after the line) the lap is taken back
 *      out — the state before it restored, any later lap stepped again on
 *      top, the card re-published; what was said stands. A clean verdict
 *      changes nothing (a lap is never stepped twice). The snapshot follows
 *      the step at once;
 *   4. when the engine wants one, asks the AI for a short summary in the
 *      background — the voice's request (liveCoachVoice.ts `summaryRequest`,
 *      or the contract's `summaryFacts` filled in) to the `coach` edge
 *      function through coach-ipc.js `askAi`,
 *      members only, cached and logged there) and says it as `coachSummary`
 *      — only if the same practice session is still running when the answer
 *      lands, and never after {@link DEFAULTS.summaryTimeoutMs}. A failure is
 *      silence.
 *
 * ## When it runs
 * Practice and test days only, on the beta channel only (main's
 * `practiceOnThisChannel`), with the Engineer tab's "Live practice coach"
 * switch on (`settings.engineer.liveCoach`, default on), and with the engine
 * built. The card is published whenever the coach is active; the radio lines
 * also need the engineer running (`deps.say` answers false otherwise and the
 * line is simply not said). A frame that says plainly this is another session
 * (qualifying, a race, a warm-up, a replay) stops it AT ONCE: the card is
 * cleared, any held coach line is dropped, and every lap or summary still in
 * flight is discarded when it lands (a generation check). A loading screen is
 * not another session: the practice watcher (practiceSession.js) rides those
 * out, and the coach keeps its state while the watcher's session lives. A new
 * watcher session is a fresh start.
 *
 * ## What it costs the main thread
 * Per frame: one session-type compare; every {@link DEFAULTS.gateEveryMs} a
 * settings read and the watcher's session. Per lap: a `postMessage` a second
 * while waiting for the record, then the engine step and the card. Measuring
 * itself is in the worker. `timings()` reports what each lap really cost.
 *
 * Testable without Electron: every input is injected — see createLiveCoach.
 */

'use strict';

const path = require('node:path');
const { sessionTypeOf, PRACTICE_SESSIONS } = require('./practiceSession');

const DIST = path.join(__dirname, '..', 'dist', 'telemetry');

/** The engineer kinds the coach speaks under (liveCoachContract.ts LIVE_COACH_KINDS). */
const KINDS = ['coachFocus', 'coachProgress', 'coachConsistency', 'coachSummary'];

const DEFAULTS = Object.freeze({
  /** Between looks for the lap in the lap log. */
  retryMs: 1000,
  /** How long to keep looking: the verdict hold (40 s) and a generous margin. */
  retryForMs: 75000,
  /** The AI summary's patience. Late is worse than nothing on the radio. */
  summaryTimeoutMs: 10000,
  /** How often the gates (setting, channel, the watcher's session) are re-read. */
  gateEveryMs: 2000,
  /** How long a lap waits for the server's copy at the line before falling back to the log. */
  crossingWaitMs: 3000,
});

/** The engine's own default (liveCoachContract.ts LiveCoachOptions.minLaps). */
const DEFAULT_MIN_LAPS = 2;
/** Laps remembered for `timings()`. */
const TIMINGS_KEPT = 20;
/** Laps a late verdict can still take back (and the ones stepped after it, re-stepped). */
const HISTORY_KEPT = 6;
/** A lap at the line and the frame's lap: the same sim reading, the same crossing. */
const LINE_MATCH_LAP_MS = 150;
const LINE_MATCH_AT_MS = 15000;

function loadEngine() {
  try {
    const m = require(path.join(DIST, 'liveCoach.js'));
    return m && typeof m.initLiveCoach === 'function' && typeof m.stepLiveCoach === 'function' ? m : null;
  } catch {
    return null;
  }
}

function loadVoice() {
  try {
    const m = require(path.join(DIST, 'liveCoachVoice.js'));
    return m && (typeof m.summaryRequest === 'function' || typeof m.summaryFacts === 'function') && typeof m.speakableSummary === 'function' ? m : null;
  } catch {
    return null;
  }
}

const hrMs = () => Number(process.hrtime.bigint()) / 1e6;
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What the lap was measured against, for the words. */
function refKindOf(target) {
  if (!target || !target.lapId) return 'sessionBest';
  return String(target.lapId).startsWith('board:') ? 'board' : 'chased';
}

/** The card's copy of a focus: the contract's Pick, nothing else. */
function overlayFocus(f) {
  if (!f || typeof f !== 'object') return null;
  return {
    cornerId: f.cornerId,
    cornerNo: f.cornerNo,
    entryD: f.entryD,
    apexD: f.apexD,
    exitD: f.exitD,
    lossSec: f.lossSec,
    short: f.short,
    status: f.status,
  };
}

/**
 * The AI request for the summary: the voice's facts as the `coach` function
 * takes them (a CoachAiRequest; coach-ipc.js cleans and hashes it again). The
 * function wants a number on every fact; one the voice did not give reads 0,
 * which its direction check ignores. Its `prompt` has nowhere to go on the
 * deployed function (kinds session | lap | habits), so the facts carry it.
 */
function aiRequestOf(sf, ctx) {
  const facts = (sf && Array.isArray(sf.facts) ? sf.facts : [])
    .filter((f) => f && typeof f.id === 'string' && typeof f.text === 'string' && f.text)
    .map((f) => {
      const out = {
        id: f.id,
        text: f.text,
        kind: str(f.kind) || 'live',
        value: num(Number(f.value)) ?? 0,
        unit: str(f.unit),
      };
      if (typeof f.cornerId === 'string') out.cornerId = f.cornerId;
      if (typeof f.phase === 'string') out.phase = f.phase;
      return out;
    });
  return {
    kind: 'session',
    context: {
      track: str(ctx.track),
      car: str(ctx.car),
      carClass: str(ctx.carClass),
      targetLabel: str(ctx.targetLabel),
      lapSec: num(ctx.lapSec),
      refSec: num(ctx.refSec),
    },
    facts,
  };
}

/**
 * @param {{
 *   now?: () => number,
 *   setTimeout?: typeof setTimeout,
 *   clearTimeout?: typeof clearTimeout,
 *   loadSettings: () => object,
 *   betaOk: (settings: object) => boolean,
 *   currentSession: () => ({ startedAt: number, type?: string, track?: string, car?: string, carClass?: string } | null),
 *   target?: (lap: object) => ({ kind: string, label: string, lapId: string, lapSec: number, columns: object } | null),
 *   measure: (req: object) => Promise<object | null>,
 *   loadEngine?: () => object | null,
 *   loadVoice?: () => object | null,
 *   say: (text: string, meta: { kind: string, priority: number }) => boolean,
 *   dropHeld?: (kinds: string[]) => void,
 *   publish: (overlay: object | null) => void,
 *   askAi?: (req: object) => Promise<{ ok: boolean, ai?: unknown }>,
 *   log?: (line: string) => void,
 *   options?: Partial<typeof DEFAULTS>,
 *   engineOptions?: object,
 * }} deps
 */
function createLiveCoach(deps) {
  const now = deps.now || Date.now;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const opts = { ...DEFAULTS, ...(deps.options || {}) };
  const engineOpts = deps.engineOptions || undefined;
  const minLaps = engineOpts && Number.isFinite(engineOpts.minLaps) ? engineOpts.minLaps : DEFAULT_MIN_LAPS;

  let engine; // undefined = not looked for yet
  let voice;
  const getEngine = () => (engine === undefined ? (engine = (deps.loadEngine || loadEngine)() || null) : engine);
  const getVoice = () => (voice === undefined ? (voice = (deps.loadVoice || loadVoice)() || null) : voice);

  /** The running session, or null. */
  let s = null;
  /** Bumped on every start and stop: work that began under another number is dropped. */
  let gen = 0;
  let nextGateAt = 0;
  let lastPublished; // undefined = never published
  const timings = [];
  /** Laps the server handed over at the line (`onLapAtLine`), newest last, and who waits for one. */
  const crossings = [];
  const waiters = [];

  const sleep = (ms) => new Promise((resolve) => setT(resolve, ms));

  const live = (mine, g) => s === mine && gen === g;

  function allowed() {
    let settings = null;
    try {
      settings = deps.loadSettings();
    } catch {
      return false;
    }
    if (!settings || !deps.betaOk(settings)) return false;
    if (settings.engineer && settings.engineer.liveCoach === false) return false;
    return !!getEngine();
  }

  function publish(overlay) {
    if (overlay === null && lastPublished === null) return;
    lastPublished = overlay;
    try {
      deps.publish(overlay);
    } catch (err) {
      log(`[livecoach] publish failed: ${err && err.message}`);
    }
  }

  function publishCard(mine) {
    const st = mine.state || {};
    const focus = overlayFocus(st.focus);
    // The widget flashes once per bump: a new corner (or none), not a status step.
    const key = focus ? String(focus.cornerId) : '';
    if (key !== mine.focusKey) {
      mine.focusKey = key;
      mine.rev += 1;
    }
    publish({
      focus,
      validLaps: Number(st.validLaps) || 0,
      minLaps,
      lastLapSec: mine.lastLapSec,
      lastDeltaSec: mine.lastDeltaSec,
      refKind: mine.refKind,
      rev: mine.rev,
    });
  }

  function start(cur) {
    const key = String(cur.startedAt);
    gen += 1;
    crossings.length = 0; // another session's laps
    let state;
    try {
      state = getEngine().initLiveCoach(`live:${new Date(cur.startedAt).toISOString()}~${str(cur.track)}`);
    } catch (err) {
      log(`[livecoach] engine init failed: ${err && err.message}`);
      s = null;
      return;
    }
    s = {
      key,
      gen,
      state,
      track: str(cur.track),
      car: str(cur.car),
      carClass: str(cur.carClass),
      last: null,
      lastValid: null,
      trackLengthM: 0,
      refKind: 'sessionBest',
      refSec: null,
      targetLabel: '',
      lastLapSec: null,
      lastDeltaSec: null,
      focusKey: '',
      rev: 0,
      chain: Promise.resolve(),
      summaryBusy: false,
      history: [],
    };
    log(`[livecoach] on: ${cur.type || 'practice'} at ${s.track || 'an unnamed track'}`);
    publishCard(s);
  }

  function stop(why) {
    if (!s) return;
    gen += 1;
    s = null;
    publish(null);
    try {
      if (typeof deps.dropHeld === 'function') deps.dropHeld(KINDS);
    } catch {
      /* the engineer's slot is its own business */
    }
    log(`[livecoach] off: ${why}`);
  }

  /** Bring the running state in line with the gates and the watcher's session. */
  function refresh() {
    if (!allowed()) {
      stop('switched off');
      return;
    }
    let cur = null;
    try {
      cur = deps.currentSession();
    } catch {
      cur = null;
    }
    if (!cur) {
      stop('the session ended');
      return;
    }
    if (!s || s.key !== String(cur.startedAt)) start(cur);
  }

  function say(text, kind, priority) {
    try {
      return deps.say(text, { kind, priority: Number(priority) || 0 }) === true;
    } catch (err) {
      log(`[livecoach] say failed: ${err && err.message}`);
      return false;
    }
  }

  function snapshotOf(mine) {
    return { state: mine.state, lastValid: mine.lastValid, last: mine.last, trackLengthM: mine.trackLengthM };
  }

  /** The measured lap → the engine, the radio and the card. */
  function land(mine, g, found, req, waited) {
    const t0 = hrMs();
    const m = found.lap;
    const lap = {
      lapId: m.lapId,
      lapNo: m.lapNo,
      lapSec: m.lapSec,
      valid: m.valid === true,
      breakdown: m.valid === true ? m.breakdown || null : null,
      trackLengthM: m.trackLengthM,
      refKind: refKindOf(req.target),
      refLapId: m.refLapId || null,
      at: m.at,
    };
    let step;
    try {
      step = getEngine().stepLiveCoach(mine.state, lap, engineOpts);
    } catch (err) {
      log(`[livecoach] engine step failed on lap ${lap.lapNo}: ${err && err.message}`);
      return;
    }
    if (!step || !step.state) return;
    // What the coach looked like before this lap, so a verdict that lands
    // later (a cut the stewards charge ~25 s on) can take the lap back out.
    const entry = { lap, pre: mine.state, preLast: mine.last, preLastValid: mine.lastValid, provisional: m.provisional === true };
    mine.history.push(entry);
    if (mine.history.length > HISTORY_KEPT) mine.history.shift();
    mine.state = step.state;
    mine.last = lap;
    if (lap.valid) mine.lastValid = lap;
    if (lap.trackLengthM > 0) mine.trackLengthM = lap.trackLengthM;
    mine.refKind = lap.refKind;
    mine.refSec = num(m.refSec);
    mine.targetLabel = req.target ? str(req.target.label) : 'your best this session';
    mine.lastLapSec = lap.lapSec;
    mine.lastDeltaSec = num(m.deltaSec);
    const said = [];
    for (const call of Array.isArray(step.calls) ? step.calls : []) {
      if (!call || !KINDS.includes(call.kind) || typeof call.text !== 'string' || !call.text) continue;
      if (say(call.text, call.kind, call.priority)) said.push(call.kind);
    }
    publishCard(mine);
    const stepMs = hrMs() - t0;
    timings.push({
      lapNo: lap.lapNo,
      valid: lap.valid,
      atLine: m.provisional === true,
      // From the crossing (the frame that showed the new lap time) to the calls said.
      sinceLineMs: Number.isFinite(req.atMs) ? Math.max(0, now() - req.atMs) : null,
      waitedMs: waited.ms,
      attempts: waited.attempts,
      workerMs: found.ms ? found.ms.total : null,
      mainMs: Math.round((stepMs + waited.mainMs) * 100) / 100,
      calls: (step.calls || []).map((c) => c && c.kind),
      said,
    });
    if (timings.length > TIMINGS_KEPT) timings.shift();
    log(
      `[livecoach] lap ${lap.lapNo} ${lap.valid ? 'coached' : 'not coached'}` +
        ` after ${Math.round(waited.ms / 1000)} s (${waited.attempts} looks), main ${stepMs.toFixed(1)} ms` +
        (said.length ? `, said ${said.join(', ')}` : ''),
    );
    if (step.wantSummary) void summarize(mine, g);
    if (entry.provisional) void verifyLater(mine, g, entry, req);
  }

  /**
   * A lap stepped at the line is judged again when its record lands. Dirty
   * now (a cut charged after the line, mostly) and clean when stepped: take
   * it back out — the state before it, every later lap stepped again on top,
   * the card re-published. What was said stands; nothing is said about it.
   * Clean as stepped: nothing at all (it is never stepped twice).
   */
  async function verifyLater(mine, g, entry, req) {
    if (typeof deps.verify !== 'function') return;
    const deadline = now() + opts.retryForMs;
    for (;;) {
      await sleep(opts.retryMs);
      if (!live(mine, g)) return;
      let v = null;
      try {
        v = await deps.verify({ lapId: entry.lap.lapId, atMs: req.atMs, lapSec: req.lapSec });
      } catch {
        v = null;
      }
      if (!live(mine, g)) return;
      if (v && v.found) {
        if (entry.lap.valid && v.valid === false) revert(mine, entry, v);
        return;
      }
      if (now() >= deadline) return; // the provisional verdict stands
    }
  }

  function revert(mine, entry, verdict) {
    const i = mine.history.indexOf(entry);
    if (i < 0) {
      log(`[livecoach] lap ${entry.lap.lapNo} turned out dirty, too late to take back`);
      return;
    }
    const later = mine.history.slice(i + 1);
    mine.history.splice(i);
    let state = entry.pre;
    let last = { ...entry.lap, valid: false, breakdown: null };
    let lastValid = entry.preLastValid;
    for (const e of later) {
      try {
        const step = getEngine().stepLiveCoach(state, e.lap, engineOpts);
        if (!step || !step.state) continue;
        e.pre = state;
        e.preLast = last;
        e.preLastValid = lastValid;
        state = step.state;
        last = e.lap;
        if (e.lap.valid) lastValid = e.lap;
        mine.history.push(e);
      } catch (err) {
        log(`[livecoach] re-stepping lap ${e.lap.lapNo} failed: ${err && err.message}`);
      }
    }
    mine.state = state;
    mine.last = last;
    mine.lastValid = lastValid;
    publishCard(mine);
    log(`[livecoach] lap ${entry.lap.lapNo} taken back: ${(verdict.dirty || []).join('+') || 'not a coachable lap'}`);
  }

  /** The lap the server handed over at the line for this crossing, waiting up to `crossingWaitMs`. */
  function crossingFor(req) {
    const want = Math.round(req.lapSec * 1000);
    const matches = (c) =>
      !!c && !!c.record && Math.abs(Number(c.record.lapMs) - want) <= LINE_MATCH_LAP_MS &&
      Math.abs(Date.parse(c.record.at) - req.atMs) <= LINE_MATCH_AT_MS &&
      (!req.track || !c.record.track || c.record.track === req.track);
    const k = crossings.findIndex(matches);
    if (k >= 0) return Promise.resolve(crossings.splice(k, 1)[0]);
    return new Promise((resolve) => {
      const w = { matches, resolve };
      waiters.push(w);
      setT(() => {
        const j = waiters.indexOf(w);
        if (j >= 0) waiters.splice(j, 1);
        resolve(null);
      }, opts.crossingWaitMs);
    });
  }

  /** Look for the lap until it lands or the deadline passes. */
  async function chase(mine, g, req) {
    const t0 = now();
    const deadline = t0 + opts.retryForMs;
    let attempts = 0;
    let mainMs = 0;
    // At the line first: the server's copy of the lap, ~40 s before the log's.
    if (typeof deps.lapAtLine === 'function' && deps.lapAtLine()) {
      const c = await crossingFor(req);
      if (!live(mine, g)) return;
      if (c) {
        attempts += 1;
        let res = null;
        const p0 = hrMs();
        try {
          const pending = deps.measure({ ...req, extra: { record: c.record, trace: c.trace } });
          mainMs += hrMs() - p0;
          res = await pending;
        } catch (err) {
          log(`[livecoach] measuring at the line failed: ${err && err.message}`);
        }
        if (!live(mine, g)) return;
        if (res && res.found && res.lap) {
          land(mine, g, res, req, { ms: now() - t0, attempts, mainMs });
          return;
        }
      }
      // No lap from the server (another sim, no trace): the lap log, as before.
    }
    for (;;) {
      if (!live(mine, g)) return;
      attempts += 1;
      let res = null;
      const p0 = hrMs();
      let pending;
      try {
        pending = deps.measure(req);
      } catch (err) {
        pending = null;
        log(`[livecoach] measure threw: ${err && err.message}`);
      }
      mainMs += hrMs() - p0;
      try {
        res = pending ? await pending : null;
      } catch (err) {
        res = null;
        log(`[livecoach] measure failed: ${err && err.message}`);
      }
      if (!live(mine, g)) return;
      if (res && res.found && res.lap) {
        land(mine, g, res, req, { ms: now() - t0, attempts, mainMs });
        return;
      }
      if (now() >= deadline) {
        log(`[livecoach] a ${req.lapSec.toFixed(3)} s lap never reached the lap log (${attempts} looks); not coached`);
        return;
      }
      await sleep(opts.retryMs);
    }
  }

  async function summarize(mine, g) {
    const v = getVoice();
    if (!v || typeof deps.askAi !== 'function' || mine.summaryBusy) return;
    mine.summaryBusy = true;
    let timer = null;
    try {
      const snap = snapshotOf(mine);
      const ctx = {
        track: mine.track,
        car: mine.car,
        carClass: mine.carClass,
        targetLabel: mine.targetLabel,
        lapSec: mine.lastLapSec,
        refSec: mine.refSec,
      };
      // The voice's own CoachAiRequest when it builds one (every fact with a
      // number, as the deployed function insists); else the contract's thin
      // facts, filled in here.
      const request = typeof v.summaryRequest === 'function' ? v.summaryRequest(snap, ctx) : aiRequestOf(v.summaryFacts(snap), ctx);
      if (!request || !Array.isArray(request.facts) || !request.facts.length) return;
      const timeout = new Promise((resolve) => {
        timer = setT(() => resolve({ ok: false, error: 'timeout' }), opts.summaryTimeoutMs);
      });
      const asked = Promise.resolve()
        .then(() => deps.askAi(request))
        .catch((err) => ({ ok: false, error: err && err.message }));
      const res = await Promise.race([asked, timeout]);
      if (!res || !res.ok) {
        log(`[livecoach] no summary: ${(res && (res.code || res.error)) || 'no answer'}`);
        return;
      }
      // Still this practice session, still switched on?
      if (!live(mine, g) || !allowed()) return;
      // The request as sent: the reply's fact ids are checked against it.
      const text = v.speakableSummary(res, snapshotOf(mine), request);
      if (typeof text === 'string' && text) say(text, 'coachSummary', 0);
    } catch (err) {
      log(`[livecoach] summary failed: ${err && err.message}`);
    } finally {
      if (timer !== null) clearT(timer);
      mine.summaryBusy = false;
    }
  }

  return {
    /**
     * Every frame (null = the watchdog's beat with no frame). After the
     * practice watcher has seen the same frame, so its session is current.
     */
    update(frame, t = now()) {
      const type = frame === null || frame === undefined ? null : sessionTypeOf(frame);
      if (type !== null && PRACTICE_SESSIONS.has(type)) {
        if (t >= nextGateAt) {
          nextGateAt = t + opts.gateEveryMs;
          refresh();
        }
        return;
      }
      if (type !== null && type !== 'unknown') {
        // Qualifying, a race, a warm-up, a replay: over now.
        stop(`session is ${type}`);
        return;
      }
      // A gap: a loading screen, the menus, a silent feed. Hold, until the
      // watcher says its session is over.
      if (s && t >= nextGateAt) {
        nextGateAt = t + opts.gateEveryMs;
        let cur = null;
        try {
          cur = deps.currentSession();
        } catch {
          cur = null;
        }
        if (!cur || String(cur.startedAt) !== s.key) stop('the session ended');
      }
    },

    /** practiceSession.js `onLap`: a timed lap crossed the line. */
    onLap(ev) {
      if (!ev || !(Number(ev.lapSec) > 0) || !PRACTICE_SESSIONS.has(ev.sessionType)) return;
      if (!s || s.key !== String(ev.startedAt)) {
        nextGateAt = now() + opts.gateEveryMs;
        refresh();
      }
      if (!s || s.key !== String(ev.startedAt)) return;
      const mine = s;
      const g = gen;
      if (ev.track) mine.track = str(ev.track);
      if (ev.car) mine.car = str(ev.car);
      if (ev.carClass) mine.carClass = str(ev.carClass);
      let target = null;
      try {
        target = typeof deps.target === 'function' ? deps.target(ev) : null;
      } catch {
        target = null;
      }
      const req = { lapSec: Number(ev.lapSec), atMs: Number(ev.at), track: str(ev.track), target };
      // One lap at a time, in the order they were driven.
      mine.chain = mine.chain.then(() => chase(mine, g, req)).catch((err) => log(`[livecoach] lap failed: ${err && err.message}`));
    },

    /**
     * The server's lap at the line (`setLapCompleteListener`: `{ record,
     * trace, wallMs }`). Called on the frame loop: kept, matched later, and
     * only while a session is being coached.
     */
    onLapAtLine(lap) {
      if (!s || !lap || !lap.record || !lap.trace) return;
      const w = waiters.findIndex((x) => x.matches(lap));
      if (w >= 0) {
        const [x] = waiters.splice(w, 1);
        x.resolve(lap);
        return;
      }
      crossings.push(lap);
      if (crossings.length > 3) crossings.shift();
    },

    /** For the voice: everything a question about this session can be answered from; null when off. */
    snapshot() {
      return s ? snapshotOf(s) : null;
    },

    /** Whether the coach is running a session now. */
    active() {
      return !!s;
    },

    /** Stop now (app quitting, the server going down). */
    stop(why = 'stopped') {
      stop(why);
    },

    /** What the latest laps cost (ms), and when they landed. */
    timings() {
      return timings.slice();
    },

    /** The lap chain of the running session, for tests to await. */
    _idle() {
      return s ? s.chain : Promise.resolve();
    },
  };
}

module.exports = { createLiveCoach, aiRequestOf, refKindOf, overlayFocus, KINDS, DEFAULTS };
