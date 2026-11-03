/**
 * electron/live-coach.js — the live practice coach, while the driver drives.
 * -----------------------------------------------------------------------------
 * The Practice tab's coach, during the session rather than after it
 * (src/telemetry/liveCoachContract.ts). After every timed lap of a practice
 * session or test day this service:
 *
 *   1. finds the lap in the lap log. It is not there at the line: the
 *      recorder holds each lap ~40 s for the stewards' track-limits verdict
 *      (lapLog.ts VERDICT_HOLD_MS) and writes its trace in the same tick. So
 *      the service looks once a second for up to {@link DEFAULTS.retryForMs}
 *      and gives up quietly. Each look runs on a worker thread
 *      (live-coach-measure.js), which also
 *   2. measures it the way the Practice tab will: coachLoad.ts `loadLapCoach`
 *      against the lap being chased (main's `practiceTarget` snapshot — a
 *      board lap when Ghost HUD chases one) or else the session's own best so
 *      far, inside the lap-log session that holds the lap;
 *   3. steps the engine (liveCoach.ts `stepLiveCoach`, pure and fast) with a
 *      {@link LiveCoachLap}, says each call through the engineer, and
 *      publishes the in-game card ({@link LiveCoachOverlay}, `player.coach`);
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
});

/** The engine's own default (liveCoachContract.ts LiveCoachOptions.minLaps). */
const DEFAULT_MIN_LAPS = 2;
/** Laps remembered for `timings()`. */
const TIMINGS_KEPT = 20;

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
  }

  /** Look for the lap until it lands or the deadline passes. */
  async function chase(mine, g, req) {
    const t0 = now();
    const deadline = t0 + opts.retryForMs;
    let attempts = 0;
    let mainMs = 0;
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
