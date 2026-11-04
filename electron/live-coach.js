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
 * ## Coach v2 (2026-11-04): on the lap, not only after it
 * The engine keeps a WORK LIST of up to three corners (Engineer tab, "Corners
 * to work on", `settings.engineer.liveCoachCorners`). Two things now happen
 * between the lines:
 *
 *   - **Approach cues** (`coachApproach`). Ten times a second the frame gives
 *     a {@link LiveCoachPosition} — the lap fraction (`player.ghost.atD` when
 *     a ghost runs, else the player's `trackMap.cars[].lapFraction`, ~7 Hz),
 *     the speed, the lap number (the standings row's `lapsCompleted` + 1, or
 *     a count of line crossings) and the pit lane — and the engine's
 *     `approachCueAt` says whether a work-list corner's cue is due NOW: the
 *     words must end before the corner's `cueD`. Each corner is cued at most
 *     once a lap (the `cued` list, emptied when the lap number changes); never
 *     on an out-lap (from the pit lane to the next line) and never before
 *     minLaps. The radio gate holds a cue at most APPROACH_HOLD_MS (1.5 s,
 *     radioGate.ts HOLD_BUDGET_BY_KIND) and drops it rather than say it late.
 *     Switch: `settings.engineer.liveCoachApproach` (default on).
 *   - **The run debrief** (`coachRunDebrief`) on the in-lap: the moment the
 *     car enters the pit lane after a run of ≥ minLaps valid laps. The
 *     engine's `runDebrief` template, rewritten by the AI when the voice
 *     builds a `debriefRequest` and the `coach` function answers within
 *     {@link DEFAULTS.debriefTimeoutMs} (the template otherwise, always),
 *     then `startRun`: the next run is told against its own baseline. A pit
 *     visit after a shorter run still starts a new run, silently. The driver
 *     can ask for it too: `snapshot().runDebrief` (the template, for the
 *     voice's answer), `debriefNow()` (the AI-or-template text, then a new
 *     run) and `endRun()` (a new run after an answer was spoken).
 *
 * The card (`player.coach`) carries the work list and the corners improved
 * this run beside v1's `focus` (always `work[0]`).
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
 * Per frame: one session-type compare and a clock compare; every
 * {@link DEFAULTS.cueEveryMs} (while coaching) a read of the player's ghost,
 * track-map car and standings row into one reused position object, and the
 * engine's `approachCueAt` (pure, a handful of corners); every
 * {@link DEFAULTS.gateEveryMs} a settings read and the watcher's session. Per lap: a `postMessage` a second
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
const KINDS = ['coachFocus', 'coachProgress', 'coachConsistency', 'coachSummary', 'coachApproach', 'coachLapDebrief', 'coachRunDebrief'];

/** Engineer tab "Corners to work on": 1..3, default 3 (liveCoachContract.ts LiveCoachOptions.maxWork). */
const MAX_WORK_CHOICES = Object.freeze([1, 2, 3]);
const DEFAULT_MAX_WORK = 3;

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
  /** How often the frame is read for an approach cue / the pit entry (~10 Hz; the frame loop runs up to 120). */
  cueEveryMs: 100,
  /** The run debrief's AI patience, as the summary's: the template is said instead. */
  debriefTimeoutMs: 10000,
  /** How long the pit-entry debrief waits for a lap still being measured before it speaks without it. */
  debriefLapWaitMs: 8000,
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
/** v2: no approach cue below this (the pit-lane limiter, a spin, a crawl back). */
const MIN_CUE_KPH = 60;
/**
 * v2: the radio priorities (the one-slot hold's tie-break inside 'normal').
 * An approach cue that cannot get the channel at once is worth little 1.5 s
 * later, so it never pushes a held lap line off the slot; the run debrief is
 * said once a run and outranks the per-lap chatter. An engine cue's own
 * `priority`, when it carries one, wins.
 */
const APPROACH_PRIORITY = 0;
const RUN_DEBRIEF_PRIORITY = 3;

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

/** v2: a work-list corner for the card: the focus subset plus gain, rank and cueD (when the engine gave them). */
function overlayWork(f, i) {
  const o = overlayFocus(f);
  if (!o) return null;
  o.rank = Number.isFinite(f.rank) ? f.rank : i + 1;
  if (Number.isFinite(f.gainSec)) o.gainSec = f.gainSec;
  if (Number.isFinite(f.cueD)) o.cueD = f.cueD;
  return o;
}

/** 4 for 'C4'; NaN for anything else. */
function cornerNoOfId(id) {
  const m = /^C(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : NaN;
}

/** v2: the corners improved this run, for the card's small row. */
function overlayImproved(list, work) {
  const out = [];
  for (const it of list) {
    if (!it || typeof it.cornerId !== 'string' || !Number.isFinite(it.gainSec)) continue;
    const w = Array.isArray(work) ? work.find((f) => f && f.cornerId === it.cornerId) : null;
    const no = w && Number.isFinite(w.cornerNo) ? w.cornerNo : cornerNoOfId(it.cornerId);
    if (!Number.isFinite(no)) continue;
    out.push({ cornerId: it.cornerId, cornerNo: no, gainSec: it.gainSec });
  }
  return out;
}

/**
 * Engineer tab settings for the coach, read with their defaults (main hands
 * sanitized settings; a test or an older file may not have the fields).
 */
function coachSettingsOf(settings) {
  const e = (settings && settings.engineer) || {};
  const n = Number(e.liveCoachCorners);
  return {
    approach: e.liveCoachApproach !== false,
    maxWork: MAX_WORK_CHOICES.includes(n) ? n : DEFAULT_MAX_WORK,
  };
}

/**
 * The frame → `pos` (a LiveCoachPosition, reused: nothing allocated per
 * read). Lap fraction: the ghost's filtered `atD` while one runs, else the
 * player's track-map car (REST, ~7 Hz) — trainingfocus.js `carD`. In the pit
 * lane: the track-map car, else the standings row, else the pit phase. Lap
 * number: the standings row's `lapsCompleted` + 1, NaN when the frame has no
 * row (the caller counts line crossings instead).
 */
function readPosition(frame, pos) {
  const p = frame.player;
  pos.speedKph = p && Number.isFinite(p.speedKph) ? p.speedKph : 0;
  pos.lapD = NaN;
  pos.lapNo = NaN;
  let inPit = null;
  const g = p && p.ghost;
  if (g && g.active && Number.isFinite(g.atD)) pos.lapD = g.atD;
  const cars = frame.trackMap && frame.trackMap.cars;
  if (Array.isArray(cars)) {
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c && c.isPlayer) {
        if (typeof c.inPit === 'boolean') inPit = c.inPit;
        if (!Number.isFinite(pos.lapD) && Number.isFinite(c.lapFraction)) pos.lapD = c.lapFraction;
        break;
      }
    }
  }
  const rows = frame.standings;
  if (Array.isArray(rows)) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r && r.isPlayer) {
        if (inPit === null && typeof r.inPit === 'boolean') inPit = r.inPit;
        if (Number.isFinite(r.lapsCompleted)) pos.lapNo = r.lapsCompleted + 1;
        if (!Number.isFinite(pos.lapD) && Number.isFinite(r.lapFraction)) pos.lapD = r.lapFraction;
        break;
      }
    }
  }
  if (inPit === null) {
    const ph = p && p.pit && p.pit.phase;
    inPit = ph === 'entering' || ph === 'stopped' || ph === 'exiting';
  }
  pos.inPit = inPit;
  const s = frame.session;
  pos.trackLengthM = s && s.trackLengthM > 0 ? s.trackLengthM : 0;
  return pos;
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
  const baseEngineOpts = deps.engineOptions || {};
  const minLaps = Number.isFinite(baseEngineOpts.minLaps) ? baseEngineOpts.minLaps : DEFAULT_MIN_LAPS;
  /**
   * What the engine is stepped with: deps.engineOptions plus the Engineer
   * tab's two coach settings (`approachCues`, `maxWork`). Rebuilt only when a
   * setting changes (read with the gates), so the frame loop allocates none.
   */
  let coachCfg = coachSettingsOf(null);
  let engineOpts = { ...baseEngineOpts, approachCues: coachCfg.approach, maxWork: coachCfg.maxWork };
  function applySettings(settings) {
    const c = coachSettingsOf(settings);
    if (c.approach === coachCfg.approach && c.maxWork === coachCfg.maxWork) return;
    coachCfg = c;
    engineOpts = { ...baseEngineOpts, approachCues: c.approach, maxWork: c.maxWork };
  }

  let engine; // undefined = not looked for yet
  let voice;
  const getEngine = () => (engine === undefined ? (engine = (deps.loadEngine || loadEngine)() || null) : engine);
  const getVoice = () => (voice === undefined ? (voice = (deps.loadVoice || loadVoice)() || null) : voice);

  /** The running session, or null. */
  let s = null;
  /** Bumped on every start and stop: work that began under another number is dropped. */
  let gen = 0;
  let nextGateAt = 0;
  let nextCueAt = 0;
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
    applySettings(settings);
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
    // v2: the work list and this run's improved corners, only when the engine
    // keeps them (absent = a v1 engine, and the card shows `focus` alone).
    const work = Array.isArray(st.work) ? st.work.map(overlayWork).filter(Boolean) : null;
    const improved = Array.isArray(st.runImproved) ? overlayImproved(st.runImproved, st.work) : null;
    // The widget flashes once per bump: a new corner (or none) in the list,
    // not a status step.
    const key = work ? work.map((f) => f.cornerId).join(',') : focus ? String(focus.cornerId) : '';
    if (key !== mine.focusKey) {
      mine.focusKey = key;
      mine.rev += 1;
    }
    const overlay = {
      focus,
      validLaps: Number(st.validLaps) || 0,
      minLaps,
      lastLapSec: mine.lastLapSec,
      lastDeltaSec: mine.lastDeltaSec,
      refKind: mine.refKind,
      rev: mine.rev,
    };
    if (work) overlay.work = work;
    if (improved) overlay.improved = improved;
    publish(overlay);
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
      // v2, per frame: the reused position, the corners cued this lap, the
      // lap they were cued on, the pit lane last read, and the out-lap.
      pos: { lapD: NaN, speedKph: 0, lapNo: NaN, inPit: false, trackLengthM: 0 },
      cued: [],
      cueLap: NaN,
      prevD: NaN,
      crossings: 0,
      inPit: null, // null = not read yet: a session that starts in the garage is not a pit entry
      outLap: false,
      debriefBusy: false,
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

  /* ------------------------------------------------------------------------ */
  /*  v2: the run debrief                                                     */
  /* ------------------------------------------------------------------------ */

  function contextOf(mine) {
    return {
      track: mine.track,
      car: mine.car,
      carClass: mine.carClass,
      targetLabel: mine.targetLabel,
      lapSec: mine.lastLapSec,
      refSec: mine.refSec,
    };
  }

  /** deps.askAi, or `{ ok: false, error: 'timeout' }` after `ms`. Never throws. */
  async function askWithin(request, ms) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setT(() => resolve({ ok: false, error: 'timeout' }), ms);
    });
    const asked = Promise.resolve()
      .then(() => deps.askAi(request))
      .catch((err) => ({ ok: false, error: err && err.message }));
    try {
      return await Promise.race([asked, timeout]);
    } finally {
      if (timer !== null) clearT(timer);
    }
  }

  /** The engine's run debrief template for the session so far, or null (a v1 engine, before minLaps, a throw). */
  function runDebriefOf(mine) {
    const e = getEngine();
    if (!e || typeof e.runDebrief !== 'function' || !mine.state) return null;
    try {
      const d = e.runDebrief(mine.state);
      return d && typeof d.text === 'string' && d.text ? d : null;
    } catch (err) {
      log(`[livecoach] run debrief failed: ${err && err.message}`);
      return null;
    }
  }

  /**
   * The words for a debrief: the AI's rewrite when the voice builds a request
   * (liveCoachVoice.ts `debriefRequest`) and the `coach` function answers in
   * time with something `speakableDebrief` accepts; the template otherwise.
   * Null only when the session went away while the AI was asked.
   */
  async function debriefText(mine, g, d, useAi) {
    const v = useAi ? getVoice() : null;
    if (v && typeof v.debriefRequest === 'function' && typeof v.speakableDebrief === 'function' && typeof deps.askAi === 'function') {
      try {
        const ctx = contextOf(mine);
        let request = v.debriefRequest(d, snapshotOf(mine), ctx);
        // The contract's thin { facts, prompt } is filled in as the summary's is.
        if (request && typeof request === 'object' && typeof request.kind !== 'string' && Array.isArray(request.facts)) {
          request = aiRequestOf(request, ctx);
        }
        if (request && Array.isArray(request.facts) && request.facts.length) {
          const res = await askWithin(request, opts.debriefTimeoutMs);
          if (!live(mine, g)) return null;
          if (res && res.ok) {
            const text = v.speakableDebrief(res, d, snapshotOf(mine), request);
            if (typeof text === 'string' && text.trim()) return { text: text.trim(), source: 'ai' };
            log('[livecoach] AI debrief not speakable; the template instead');
          } else {
            log(`[livecoach] no AI debrief: ${(res && (res.code || res.error)) || 'no answer'}; the template instead`);
          }
        }
      } catch (err) {
        log(`[livecoach] AI debrief failed: ${err && err.message}; the template instead`);
      }
    }
    if (!live(mine, g)) return null;
    return { text: d.text, source: 'template' };
  }

  /** The engine's `startRun`: the next run is told against its own baseline. */
  function newRun(mine, why) {
    const e = getEngine();
    if (!e || typeof e.startRun !== 'function' || !mine.state) return false;
    try {
      const next = e.startRun(mine.state);
      if (!next || typeof next !== 'object') return false;
      mine.state = next;
      // A late verdict on a lap before the new run cannot be taken back into it.
      mine.history.length = 0;
      publishCard(mine);
      log(`[livecoach] new run: ${why}`);
      return true;
    } catch (err) {
      log(`[livecoach] startRun failed: ${err && err.message}`);
      return false;
    }
  }

  /**
   * The car entered the pit lane. After a run of ≥ minLaps valid laps: the
   * debrief (AI or template) as `coachRunDebrief`, then a new run. After a
   * shorter one: a new run, silently. A lap still being measured (the last
   * flying lap, usually landed long before) is waited for, briefly.
   */
  function onPitEntry(mine, g) {
    if (mine.debriefBusy) return;
    mine.debriefBusy = true;
    mine.debriefDone = (async () => {
      let timer = null;
      try {
        await Promise.race([mine.chain, new Promise((resolve) => (timer = setT(resolve, opts.debriefLapWaitMs)))]);
        if (timer !== null) clearT(timer);
        if (!live(mine, g)) return;
        const d = runDebriefOf(mine);
        const st = mine.state || {};
        const laps = d && Number.isFinite(d.laps) ? d.laps : (Number(st.validLaps) || 0) - (Number(st.runStartLap) || 0);
        if (d && laps >= minLaps) {
          const out = await debriefText(mine, g, d, true);
          if (!out || !live(mine, g) || !allowed()) return;
          const said = say(out.text, 'coachRunDebrief', RUN_DEBRIEF_PRIORITY);
          log(`[livecoach] run debrief on pit entry (${laps} laps, ${out.source})${said ? '' : ', not said'}`);
        }
        newRun(mine, 'pit entry');
      } catch (err) {
        log(`[livecoach] pit-entry debrief failed: ${err && err.message}`);
      } finally {
        mine.debriefBusy = false;
      }
    })();
  }

  /* ------------------------------------------------------------------------ */
  /*  v2: per frame (throttled) — approach cues and the pit entry             */
  /* ------------------------------------------------------------------------ */

  function tick(mine, frame) {
    const pos = readPosition(frame, mine.pos);
    if (mine.trackLengthM > 0) pos.trackLengthM = mine.trackLengthM;
    const d = pos.lapD;
    // A line crossing: the lap fraction wrapping from late to early, or the
    // row's lap number moving on. Either empties the cued list.
    const wrapped = Number.isFinite(d) && Number.isFinite(mine.prevD) && mine.prevD > 0.8 && d < 0.2;
    if (Number.isFinite(d)) mine.prevD = d;
    const lapKey = Number.isFinite(pos.lapNo) ? pos.lapNo : -1;
    if (wrapped || lapKey !== mine.cueLap) {
      mine.cueLap = lapKey;
      mine.cued.length = 0;
      // The out-lap ends at the first line the car crosses out of the pit lane.
      if (!pos.inPit) mine.outLap = false;
    }
    const was = mine.inPit;
    mine.inPit = pos.inPit;
    if (pos.inPit) mine.outLap = true;
    if (was === false && pos.inPit === true) onPitEntry(mine, mine.gen);

    if (!coachCfg.approach || pos.inPit || mine.outLap || !Number.isFinite(d) || pos.speedKph < MIN_CUE_KPH) return;
    const e = getEngine();
    if (!e || typeof e.approachCueAt !== 'function') return;
    const st = mine.state;
    if (!st || (Number(st.validLaps) || 0) < minLaps) return;
    let cue = null;
    try {
      cue = e.approachCueAt(st, pos, mine.cued, engineOpts);
    } catch (err) {
      if (!mine.cueFailLogged) log(`[livecoach] approachCueAt failed: ${err && err.message}`);
      mine.cueFailLogged = true;
      return;
    }
    if (!cue || typeof cue.text !== 'string' || !cue.text || typeof cue.cornerId !== 'string') return;
    if (mine.cued.includes(cue.cornerId)) return; // once a lap, whatever the engine says
    mine.cued.push(cue.cornerId);
    say(cue.text, 'coachApproach', Number.isFinite(cue.priority) ? cue.priority : APPROACH_PRIORITY);
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
        // v2: ~10 Hz while coaching — approach cues and the pit entry.
        if (s && t >= nextCueAt) {
          nextCueAt = t + opts.cueEveryMs;
          try {
            tick(s, frame);
          } catch (err) {
            log(`[livecoach] frame read failed: ${err && err.message}`);
          }
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

    /**
     * For the voice: everything a question about this session can be answered
     * from; null when off. v2: `runDebrief` (optional on the contract's
     * LiveCoachSnapshot) is the engine's run debrief template so far, or null
     * — what "how am I doing" / "debrief me" says without asking the AI.
     */
    snapshot() {
      if (!s) return null;
      const snap = snapshotOf(s);
      snap.runDebrief = runDebriefOf(s);
      return snap;
    },

    /**
     * v2, on demand ("debrief me"): the run debrief's words — the AI's rewrite
     * when `ai` (default true) and it answers within debriefTimeoutMs, else
     * the template — and then a new run (`startRun`, unless `startRun: false`).
     * Says nothing itself: the caller speaks the answer. Resolves null when
     * the coach is off or there is no debrief yet (before minLaps, a v1
     * engine). `{ text, source: 'ai' | 'template', debrief }`.
     */
    async debriefNow(o = {}) {
      const mine = s;
      if (!mine) return null;
      const g = gen;
      const d = runDebriefOf(mine);
      if (!d) return null;
      const out = await debriefText(mine, g, d, o.ai !== false);
      if (!out || !live(mine, g)) return null;
      if (o.startRun !== false) newRun(mine, 'debrief asked for');
      return { text: out.text, source: out.source, debrief: d };
    },

    /** v2: start a new run now (after an asked-for debrief was spoken from the snapshot). False when off or a v1 engine. */
    endRun(why = 'asked') {
      return s ? newRun(s, why) : false;
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

    /** The pit-entry debrief in flight (or the last one), for tests to await. */
    _debrief() {
      return (s && s.debriefDone) || Promise.resolve();
    },
  };
}

module.exports = { createLiveCoach, aiRequestOf, refKindOf, overlayFocus, overlayWork, overlayImproved, readPosition, coachSettingsOf, KINDS, DEFAULTS, MIN_CUE_KPH };
