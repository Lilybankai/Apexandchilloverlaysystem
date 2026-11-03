/**
 * Tests for electron/live-coach.js — the live practice coach's service — and
 * its lap-log half, electron/live-coach-measure.js.
 *
 * The engine (liveCoach.ts) and the voice (liveCoachVoice.ts) are built on
 * other branches, so this drives the service with a small fake of each that
 * follows liveCoachContract.ts. Nothing here touches the network or the
 * driver's own files: the lap log is a temp folder.
 *
 *   node scripts/test-livecoach-service.js
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLiveCoach, aiRequestOf, refKindOf, KINDS } = require('../electron/live-coach');
const M = require('../electron/live-coach-measure');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/*  Fakes that follow the contract                                            */
/* -------------------------------------------------------------------------- */

/** A tiny engine: counts valid laps, picks the worst corner after minLaps, asks for a summary every 3. */
function fakeEngine() {
  const seen = [];
  return {
    seen,
    initLiveCoach(sessionKey) {
      return { sessionKey, validLaps: 0, recent: [], focus: null, fixed: [], lastConsistencyAt: 0, lastSummaryAt: 0, refLapId: null };
    },
    stepLiveCoach(state, lap, opts) {
      seen.push(lap);
      const minLaps = (opts && opts.minLaps) || 2;
      const next = { ...state, recent: state.recent.slice() };
      const calls = [];
      if (!lap.valid || !lap.breakdown) return { state: next, calls, focus: next.focus, wantSummary: false };
      next.validLaps += 1;
      const byCorner = {};
      for (const c of lap.breakdown.corners) byCorner[c.cornerId] = c.lossSec;
      next.recent.push({ lapNo: lap.lapNo, lapSec: lap.lapSec, byCorner });
      if (next.validLaps >= minLaps) {
        const worst = lap.breakdown.corners.slice().sort((a, b) => b.lossSec - a.lossSec)[0];
        const no = Number(worst.cornerId.slice(1));
        const status = next.focus && next.focus.cornerId === worst.cornerId ? 'holding' : 'new';
        next.focus = {
          cornerId: worst.cornerId, cornerNo: no, entryD: 0.1, apexD: 0.12, exitD: 0.14, lossSec: worst.lossSec,
          cue: { phase: 'braking', brakeShiftM: 10 }, short: 'Brake 10 m later', spoken: `Corner ${no}, brake later.`,
          status, sinceLapNo: lap.lapNo,
        };
        calls.push({ kind: status === 'new' ? 'coachFocus' : 'coachProgress', text: `Corner ${no}, brake about ten metres later.`, priority: 1 });
      }
      if (next.validLaps === 3) calls.push({ kind: 'coachConsistency', text: 'Laps are within two tenths.', priority: 0 });
      const wantSummary = next.validLaps > 0 && next.validLaps % 3 === 0;
      if (wantSummary) next.lastSummaryAt = next.validLaps;
      return { state: next, calls, focus: next.focus, wantSummary };
    },
  };
}

function fakeVoice() {
  const asked = [];
  return {
    asked,
    answerCoachQuestion: () => null,
    summaryFacts(snap) {
      asked.push(snap);
      return { facts: [{ id: 'live.focus', text: 'C4 costs 0.15 s a lap', value: 0.15, unit: 's', cornerId: 'C4' }, { id: 'live.laps', text: `${snap.state.validLaps} laps` }], prompt: 'Summarise.' };
    },
    speakableSummary(reply, snap, request) {
      const ai = reply && 'ai' in reply ? reply.ai : reply;
      this.lastRequest = request;
      return ai && ai.headline ? `Summary: ${ai.headline}` : null;
    },
  };
}

function breakdownOf(lapId, losses) {
  return {
    lapId,
    refLapId: 'ref',
    corners: Object.entries(losses).map(([cornerId, lossSec]) => ({ cornerId, lossSec })),
    sequences: [],
    leadInSec: 0,
    totalSec: Object.values(losses).reduce((a, b) => a + b, 0),
    residualSec: 0.01,
  };
}

/** A measured lap as the worker answers it. */
function found(lapNo, o = {}) {
  const lapId = o.lapId || `lap-${lapNo}`;
  return {
    found: true,
    lap: {
      lapId, at: new Date(1e12 + lapNo * 80000).toISOString(), lapNo, lapSec: o.lapSec || 80 + lapNo / 10,
      valid: o.valid !== false, breakdown: o.valid === false ? null : breakdownOf(lapId, o.losses || { C2: 0.05, C4: 0.2, C7: 0.1 }),
      trackLengthM: 4000, sessionId: 'S1', refLapId: 'ref', refSec: 79.5, deltaSec: 0.36,
    },
    ms: { total: 120 },
  };
}

const PRACTICE = (o = {}) => ({ connected: true, session: { type: o.type || 'practice', track: 'Road Atlanta' }, player: { lap: { last: -1 } } });

/**
 * A rig: settings, a watcher session, the measure (miss `misses` times, then
 * answer `answer(lapNo)`), and everything the service said and published.
 */
function rig(o = {}) {
  const settings = { updateChannel: o.channel || 'beta', engineer: { liveCoach: o.liveCoach !== false } };
  const r = {
    settings,
    session: { startedAt: 1000, type: 'practice', track: 'Road Atlanta', car: 'Porsche', carClass: 'GT3' },
    said: [],
    published: [],
    dropped: [],
    measures: [],
    ai: [],
    logs: [],
    engine: o.engine === null ? null : fakeEngine(),
    voice: fakeVoice(),
    misses: o.misses ?? 2,
    sayOk: o.sayOk !== false,
    askAi: o.askAi,
  };
  let lapNo = 0;
  const attempts = new Map();
  r.coach = createLiveCoach({
    loadSettings: () => r.settings,
    betaOk: (s) => s.updateChannel === 'beta',
    currentSession: () => r.session,
    target: (lap) => (lap.ghostLapId ? { kind: 'chased', label: 'A. Winters', lapId: lap.ghostLapId, lapSec: 79.3, columns: {} } : null),
    measure: async (req) => {
      r.measures.push(req);
      const key = `${req.atMs}`;
      const n = (attempts.get(key) || 0) + 1;
      attempts.set(key, n);
      if (o.measureDelayMs) await wait(o.measureDelayMs);
      if (n <= r.misses) return { found: false };
      return (o.answer || found)(req.lapNo || ++lapNo, req);
    },
    loadEngine: () => r.engine,
    loadVoice: () => r.voice,
    say: (text, meta) => {
      r.said.push({ text, ...meta });
      return r.sayOk;
    },
    dropHeld: (kinds) => r.dropped.push(kinds),
    publish: (ov) => r.published.push(ov),
    askAi: async (req) => {
      r.ai.push(req);
      return r.askAi ? r.askAi(req) : { ok: true, ai: { headline: 'tidy session' } };
    },
    log: (line) => r.logs.push(line),
    options: { retryMs: 5, retryForMs: o.retryForMs ?? 2000, summaryTimeoutMs: o.summaryTimeoutMs ?? 200, gateEveryMs: 0 },
  });
  r.lap = (i, extra = {}) =>
    r.coach.onLap({ lapSec: 80 + i / 10, lapCount: i, at: 1000 + i * 80000, startedAt: r.session.startedAt, sessionType: r.session.type, track: 'Road Atlanta', car: 'Porsche', carClass: 'GT3', ghostLapId: '', ...extra });
  return r;
}

const lastPub = (r) => r.published[r.published.length - 1];

/* -------------------------------------------------------------------------- */

(async () => {
  console.log('\nA practice lap completes: the lap log is retried, the calls are said');
  {
    const r = rig({ misses: 3 });
    r.coach.update(PRACTICE(), 0);
    check('the coach is on as the practice frame arrives', r.coach.active());
    check('…and the card is published at once, learning', r.published.length === 1 && lastPub(r) && lastPub(r).focus === null && lastPub(r).validLaps === 0 && lastPub(r).minLaps === 2, JSON.stringify(lastPub(r)));
    r.lap(1);
    await r.coach._idle();
    check('the lap log was looked at until the lap was there (3 misses + 1)', r.measures.length === 4, r.measures.length);
    const q = r.measures[0];
    check('…asked for by time, crossing and track', q.lapSec === 80.1 && q.atMs === 81000 && q.track === 'Road Atlanta' && q.target === null);
    check('the first valid lap says nothing (minLaps)', r.said.length === 0);
    check('…and the card counts it', lastPub(r).validLaps === 1 && lastPub(r).lastLapSec === found(1).lap.lapSec && lastPub(r).lastDeltaSec === 0.36, JSON.stringify(lastPub(r)));
    r.lap(2);
    await r.coach._idle();
    check('the second valid lap names the focus corner as coachFocus', r.said.length === 1 && r.said[0].kind === 'coachFocus' && /Corner 4/.test(r.said[0].text), JSON.stringify(r.said));
    check('…with the engine\'s priority', r.said[0].priority === 1);
    const card = lastPub(r);
    check('the card shows the focus, the contract\'s fields only', card.focus && card.focus.cornerId === 'C4' && card.focus.short === 'Brake 10 m later' && card.focus.status === 'new' && !('cue' in card.focus) && !('spoken' in card.focus), JSON.stringify(card.focus));
    check('…and its rev bumped once for the new focus', card.rev === 1, card.rev);
    check('…measured against your session best', card.refKind === 'sessionBest');
    r.lap(3);
    await r.coach._idle();
    const kinds = r.said.map((c) => c.kind).join(',');
    check('the third: progress on the same corner + the consistency call', kinds === 'coachFocus,coachProgress,coachConsistency,coachSummary' || kinds.startsWith('coachFocus,coachProgress,coachConsistency'), kinds);
    check('…a status step on the same corner does not bump the rev', lastPub(r).rev === 1, lastPub(r).rev);
    await wait(30);
    check('every kind said is a coach kind', r.said.every((c) => KINDS.includes(c.kind)));
    const t = r.coach.timings();
    check('timings recorded per lap (looks, worker ms, main ms)', t.length === 3 && t[0].attempts === 4 && t[0].workerMs === 120 && t[0].mainMs >= 0, JSON.stringify(t[0]));
    const snap = r.coach.snapshot();
    check('the snapshot carries the state, the last lap and the length', snap && snap.state.validLaps === 3 && snap.last.lapNo === 3 && snap.lastValid.lapNo === 3 && snap.trackLengthM === 4000);
  }

  console.log('\nInvalid laps, chased targets, a lap that never lands');
  {
    const r = rig({ misses: 0, answer: (n) => found(n, { valid: false }) });
    r.coach.update(PRACTICE(), 0);
    r.lap(1);
    await r.coach._idle();
    const seen = r.engine.seen[0];
    check('an out-lap / cut lap reaches the engine as invalid, no breakdown', seen && seen.valid === false && seen.breakdown === null);
    check('…and nothing is said', r.said.length === 0);
    check('…the snapshot has it as last, not lastValid', r.coach.snapshot().last.lapNo === 1 && r.coach.snapshot().lastValid === null);

    const c = rig({ misses: 0 });
    c.coach.update(PRACTICE(), 0);
    c.lap(1, { ghostLapId: 'board:abc:79300' });
    await c.coach._idle();
    check('a chased board lap is handed to the measurer', c.measures[0].target && c.measures[0].target.lapId === 'board:abc:79300');
    check('…and the lap and the card call it the board lap', c.engine.seen[0].refKind === 'board' && lastPub(c).refKind === 'board');
    check('refKind: own chased lap / board / none', refKindOf({ lapId: 'x' }) === 'chased' && refKindOf({ lapId: 'board:a:1' }) === 'board' && refKindOf(null) === 'sessionBest');

    const n = rig({ misses: 1e9, retryForMs: 40 });
    n.coach.update(PRACTICE(), 0);
    n.lap(1);
    await n.coach._idle();
    check('a lap that never reaches the log is given up quietly', n.said.length === 0 && n.engine.seen.length === 0 && n.logs.some((l) => /never reached the lap log/.test(l)));
    check('…after several looks', n.measures.length >= 3, n.measures.length);
  }

  console.log('\nA non-practice session: silent, the card cleared, pending work dropped');
  {
    const r = rig({ misses: 0, measureDelayMs: 30 });
    r.coach.update(PRACTICE(), 0);
    r.lap(1);
    r.lap(2);
    await wait(5); // lap 1's measure is in flight
    r.coach.update(PRACTICE({ type: 'qualifying' }), 10);
    check('qualifying stops it at once', !r.coach.active());
    check('…the card is cleared (null published)', lastPub(r) === null);
    check('…held coach lines are dropped from the engineer', r.dropped.length === 1 && r.dropped[0].join() === KINDS.join());
    await wait(80);
    check('…and the lap that was in flight is never said or stepped', r.said.length === 0 && r.engine.seen.length === 0, r.engine.seen.length);
    check('the snapshot is null while off', r.coach.snapshot() === null);
    const before = r.published.length;
    r.coach.update(PRACTICE({ type: 'race' }), 20);
    r.coach.update(PRACTICE({ type: 'race' }), 30);
    check('a race publishes nothing more (null is said once)', r.published.length === before);
    r.lap(3, { sessionType: 'race' });
    check('a race lap is ignored', r.measures.length <= 2);
    for (const type of ['warmup', 'replay']) {
      const w = rig();
      w.coach.update(PRACTICE(), 0);
      w.coach.update(type === 'replay' ? { connected: true, session: { type: 'practice', replay: true } } : PRACTICE({ type }), 1);
      check(`${type} stops it too`, !w.coach.active() && lastPub(w) === null);
    }
    const t = rig();
    t.session.type = 'testday';
    t.coach.update(PRACTICE({ type: 'testday' }), 0);
    check('a test day runs it', t.coach.active());
  }

  console.log('\nLoading screens and new sessions');
  {
    const r = rig({ misses: 0 });
    r.coach.update(PRACTICE(), 0);
    r.lap(1);
    r.lap(2);
    await r.coach._idle();
    r.coach.update(null, 100); // the watchdog: no frame
    r.coach.update({ connected: true, session: { type: 'unknown' } }, 200); // a loading screen
    check('a loading screen keeps it running, state and all', r.coach.active() && r.coach.snapshot().state.validLaps === 2);
    r.coach.update(PRACTICE(), 300);
    check('…and practice resumes the same session', r.coach.snapshot().state.validLaps === 2);
    r.session = null; // the watcher's hold ran out
    r.coach.update(null, 400);
    check('the watcher ending its session turns the coach off', !r.coach.active() && lastPub(r) === null);
    r.session = { startedAt: 9000, type: 'practice', track: 'Road Atlanta' };
    r.coach.update(PRACTICE(), 500);
    check('a new session starts fresh', r.coach.active() && r.coach.snapshot().state.validLaps === 0 && /^live:/.test(r.coach.snapshot().state.sessionKey));
    // The watcher starting a new session under a running coach (no gap seen).
    r.session = { startedAt: 20000, type: 'practice', track: 'Road Atlanta' };
    r.lap(1);
    await r.coach._idle();
    check('a lap from a newer watcher session resets the state first', r.coach.snapshot().state.validLaps === 1, r.coach.snapshot().state.validLaps);
  }

  console.log('\nStable channel, the setting, no engine');
  {
    const r = rig({ channel: 'stable' });
    r.coach.update(PRACTICE(), 0);
    r.lap(1);
    await wait(20);
    check('stable: never on, nothing published, nothing measured', !r.coach.active() && r.published.length === 0 && r.measures.length === 0);

    const off = rig({ liveCoach: false });
    off.coach.update(PRACTICE(), 0);
    off.lap(1);
    await wait(20);
    check('setting off: never on, nothing published, nothing measured', !off.coach.active() && off.published.length === 0 && off.measures.length === 0);

    const mid = rig({ misses: 0 });
    mid.coach.update(PRACTICE(), 0);
    check('setting on: running', mid.coach.active());
    mid.settings = { ...mid.settings, engineer: { liveCoach: false } };
    mid.coach.update(PRACTICE(), 10);
    check('switching it off mid-session clears the card', !mid.coach.active() && lastPub(mid) === null);
    mid.settings = { ...mid.settings, engineer: {} };
    mid.coach.update(PRACTICE(), 20);
    check('an older settings file (no field) reads as on', mid.coach.active());

    const none = rig({ engine: null });
    none.coach.update(PRACTICE(), 0);
    check('without the engine built it stays off', !none.coach.active() && none.published.length === 0);

    const deaf = rig({ misses: 0, sayOk: false });
    deaf.coach.update(PRACTICE(), 0);
    deaf.lap(1);
    deaf.lap(2);
    await deaf.coach._idle();
    check('engineer not running: the card still works', lastPub(deaf).focus && lastPub(deaf).focus.cornerId === 'C4');
    check('…and timings say nothing was said', deaf.coach.timings()[1].said.length === 0);
  }

  console.log('\nThe AI summary');
  {
    const r = rig({ misses: 0 });
    r.coach.update(PRACTICE(), 0);
    for (let i = 1; i <= 3; i++) r.lap(i);
    await r.coach._idle();
    await wait(20);
    const sum = r.said.filter((c) => c.kind === 'coachSummary');
    check('summary success: said once, as coachSummary', sum.length === 1 && sum[0].text === 'Summary: tidy session', JSON.stringify(r.said));
    const req = r.ai[0];
    check('…asked as a session request with the voice\'s facts', req && req.kind === 'session' && req.facts.length === 2 && req.facts[0].cornerId === 'C4');
    check('…every fact carries a number (missing = 0)', req.facts.every((f) => Number.isFinite(f.value)) && req.facts[1].value === 0);
    check('…and the context names the track and the last lap', req.context.track === 'Road Atlanta' && req.context.carClass === 'GT3' && req.context.lapSec > 80 && req.context.refSec === 79.5);
    check('…the voice saw the snapshot', r.voice.asked[0] && r.voice.asked[0].state.validLaps === 3);

    const slow = rig({ misses: 0, summaryTimeoutMs: 30, askAi: () => new Promise(() => {}) });
    slow.coach.update(PRACTICE(), 0);
    for (let i = 1; i <= 3; i++) slow.lap(i);
    await slow.coach._idle();
    await wait(80);
    check('summary timeout: silence', !slow.said.some((c) => c.kind === 'coachSummary') && slow.logs.some((l) => /no summary: timeout/.test(l)));

    const late = rig({ misses: 0, summaryTimeoutMs: 1000, askAi: () => wait(60).then(() => ({ ok: true, ai: { headline: 'late' } })) });
    late.coach.update(PRACTICE(), 0);
    for (let i = 1; i <= 3; i++) late.lap(i);
    await late.coach._idle();
    late.coach.update(PRACTICE({ type: 'race' }), 10); // the session switches while the AI thinks
    await wait(120);
    check('a session switch mid-summary: not said', !late.said.some((c) => c.kind === 'coachSummary'), JSON.stringify(late.said.map((c) => c.kind)));

    const fresh = rig({ misses: 0, summaryTimeoutMs: 1000, askAi: () => wait(60).then(() => ({ ok: true, ai: { headline: 'old' } })) });
    fresh.coach.update(PRACTICE(), 0);
    for (let i = 1; i <= 3; i++) fresh.lap(i);
    await fresh.coach._idle();
    fresh.session = { startedAt: 777, type: 'practice', track: 'Road Atlanta' };
    fresh.coach.update(PRACTICE(), 10); // a new practice session, same type
    await wait(120);
    check('…nor after a new practice session started', !fresh.said.some((c) => c.kind === 'coachSummary'));

    const bad = rig({ misses: 0, askAi: () => ({ ok: false, code: 'entitled' }) });
    bad.coach.update(PRACTICE(), 0);
    for (let i = 1; i <= 3; i++) bad.lap(i);
    await bad.coach._idle();
    await wait(20);
    check('not a member (or any failure): silence', !bad.said.some((c) => c.kind === 'coachSummary') && bad.logs.some((l) => /no summary: entitled/.test(l)));

    const thrown = rig({ misses: 0, askAi: () => { throw new Error('boom'); } });
    thrown.coach.update(PRACTICE(), 0);
    for (let i = 1; i <= 3; i++) thrown.lap(i);
    await thrown.coach._idle();
    await wait(20);
    check('a throwing AI call: silence, no crash', !thrown.said.some((c) => c.kind === 'coachSummary'));

    // The voice's richer request (claude/lc-voice summaryRequest): sent as
    // built, and handed back with the reply so its fact ids can be checked.
    const rq = rig({ misses: 0 });
    const built = { kind: 'session', inputHash: '', context: { track: 'Road Atlanta' }, facts: [{ id: 'C4.loss', kind: 'phaseLoss', value: 0.15, unit: 's', text: 'C4 costs 0.15 s', cornerId: 'C4' }] };
    rq.voice.summaryRequest = (snap, ctx) => {
      rq.voice.ctx = ctx;
      return built;
    };
    rq.coach.update(PRACTICE(), 0);
    for (let i = 1; i <= 3; i++) rq.lap(i);
    await rq.coach._idle();
    await wait(20);
    check("summaryRequest: the voice's request goes out as built", rq.ai[0] === built && rq.voice.ctx.track === 'Road Atlanta' && rq.voice.ctx.carClass === 'GT3');
    check('…the same request comes back with the reply to speakableSummary', rq.voice.lastRequest === built);
    check('…and the summary is said', rq.said.some((c) => c.kind === 'coachSummary'));

    const nv = rig({ misses: 0 });
    nv.voice = null;
    const nvCoach = createLiveCoach({
      loadSettings: () => nv.settings, betaOk: () => true, currentSession: () => nv.session,
      measure: async () => found(nv.said.length + 1), loadEngine: () => fakeEngine(), loadVoice: () => null,
      say: (t, m) => nv.said.push({ t, ...m }), publish: () => {}, askAi: async () => ({ ok: true, ai: { headline: 'x' } }),
      options: { retryMs: 1, gateEveryMs: 0 },
    });
    nvCoach.update(PRACTICE(), 0);
    for (let i = 1; i <= 3; i++) nvCoach.onLap({ lapSec: 80, at: i, startedAt: 1000, sessionType: 'practice' });
    await nvCoach._idle();
    check('without the voice module there is no summary, and no crash', !nv.said.some((c) => c.kind === 'coachSummary'));
    const a = aiRequestOf({ facts: [{ id: 'x', text: '' }, { id: 'y', text: 'ok', value: '2.5' }, null] }, {});
    check('aiRequestOf drops empty facts and reads numeric strings', a.facts.length === 1 && a.facts[0].value === 2.5 && a.context.lapSec === null);
  }

  console.log('\nThe engineer: sayTiered and dropHeld');
  {
    const { EngineerService, TRIGGER_TIERS } = require('../electron/engineer');
    let settings = { engineerEnabled: true, engineerVoice: 'en_GB-alan-medium', engineer: { readouts: 'essential' } };
    const svc = new EngineerService({ dir: path.join(os.tmpdir(), 'apex-livecoach-test'), loadSettings: () => settings, onStatus: () => {} });
    const spoken = [];
    svc.speak = (text) => spoken.push(text);
    check('not running: nothing', svc.sayTiered('Corner four.', { kind: 'coachFocus' }) === false && spoken.length === 0);
    svc.running = true;
    check('every coach kind is essential', KINDS.every((k) => TRIGGER_TIERS[k] === 'essential'));
    check('essential preset: said', svc.sayTiered('Corner four.', { kind: 'coachFocus', priority: 1 }) === true && spoken.length === 1);
    settings = { ...settings, engineer: { readouts: 'standard' } };
    check('standard preset: said', svc.sayTiered('Better.', { kind: 'coachProgress' }) === true && spoken.length === 2);
    settings = { ...settings, engineer: { readouts: 'off' } };
    check('Quiet preset: not said', svc.sayTiered('Summary.', { kind: 'coachSummary' }) === false && spoken.length === 2);
    settings = { ...settings, engineer: { readouts: 'essential' } };
    check('an unknown kind never speaks', svc.sayTiered('x', { kind: 'nope' }) === false && svc.sayTiered('x', {}) === false);
    svc.radioQuiet = true;
    svc.sayTiered('Corner four.', { kind: 'coachFocus' });
    check('"keep quiet" silences it', spoken.length === 2 && !svc.heldReadout);
    svc.radioQuiet = false;
    svc.asking = true; // the channel is busy: the line is held
    svc.sayTiered('Corner four.', { kind: 'coachFocus' });
    check('a busy channel holds it', svc.heldReadout && svc.heldReadout.kind === 'coachFocus' && svc.heldReadout.urgency === 'normal');
    svc.dropHeld(['trackLimits']);
    check('dropHeld leaves other kinds', !!svc.heldReadout);
    svc.dropHeld(KINDS);
    check('dropHeld drops a held coach line', svc.heldReadout === null);
    check('status() carries the switch, default on', svc.status().liveCoach === true);
    settings = { ...settings, engineer: { readouts: 'essential', liveCoach: false } };
    check('…and off when switched off', svc.status().liveCoach === false);
    const { sanitizeEngineer, DEFAULT_ENGINEER_SETTINGS } = require('../electron/engineer-settings');
    check('settings: default on, false survives sanitize, junk keeps the stored value', DEFAULT_ENGINEER_SETTINGS.liveCoach === true && sanitizeEngineer({ liveCoach: false }).liveCoach === false && sanitizeEngineer({ liveCoach: 'no' }, { liveCoach: false }).liveCoach === false && sanitizeEngineer({}).liveCoach === true);
  }

  console.log('\nThe server: player.coach on every frame while set, absent once cleared');
  {
    const server = require('../dist/server/index');
    check('setLiveCoach and the frame stamp are exported', typeof server.setLiveCoach === 'function' && typeof server.stampLiveCoach === 'function');
    const card = { focus: null, validLaps: 0, minLaps: 2, lastLapSec: null, lastDeltaSec: null, refKind: 'sessionBest', rev: 0 };
    const f1 = { player: {} };
    server.stampLiveCoach(f1);
    check('nothing set: no coach field at all', !('coach' in f1.player));
    server.setLiveCoach(card);
    const f2 = { player: {} };
    const f3 = { player: {} };
    server.stampLiveCoach(f2);
    server.stampLiveCoach(f3);
    check('set: every frame carries it', f2.player.coach === card && f3.player.coach === card);
    server.setLiveCoach(null);
    server.stampLiveCoach(f2); // a provider that reuses its player object
    check('cleared: the field is gone, not null', !('coach' in f2.player));
    server.setLiveCoach('junk');
    const f4 = { player: {} };
    server.stampLiveCoach(f4);
    check('junk is treated as cleared', !('coach' in f4.player));
    server.stampLiveCoach({}); // a frame with no player block
    check('a frame without a player block is left alone', true);
    server.setLiveCoach(null);
  }

  console.log('\nThe lap log half (live-coach-measure.js)');
  {
    const rec = (over) => ({ v: 7, id: 'L', at: '2026-11-03T10:00:00.000Z', sim: 'lmu', track: 'Road Atlanta', trackKey: 'ra_4083', trackLengthM: 4083, car: 'P', carClass: 'GT3', lapMs: 80123, distanceM: 4083, sessionType: 'practice', clean: true, dirty: [], ...over });
    const at = Date.parse('2026-11-03T10:00:00.000Z');
    check('match: same time and crossing', M.matchRecord([rec()], { lapSec: 80.123, atMs: at + 300, track: 'Road Atlanta' }) !== null);
    check('…not another lap time', M.matchRecord([rec()], { lapSec: 80.5, atMs: at }) === null);
    check('…not a crossing far away', M.matchRecord([rec()], { lapSec: 80.123, atMs: at + 60000 }) === null);
    check('…not another track', M.matchRecord([rec()], { lapSec: 80.123, atMs: at, track: 'Sebring' }) === null);
    check('…the nearest of two', M.matchRecord([rec({ id: 'a', at: new Date(at - 9000).toISOString() }), rec({ id: 'b', at: new Date(at + 1000).toISOString() })], { lapSec: 80.123, atMs: at }).id === 'b');
    const rl = { timed: true, hasTrace: true, isOutLap: false, isInLap: false };
    check('coachable: a clean traced flying lap', M.coachable(rec(), rl));
    check('…not an out-lap, an in-lap, a cut, no trace', !M.coachable(rec({ isOutLap: true }), rl) && !M.coachable(rec({ isInLap: true }), rl) && !M.coachable(rec({ clean: false, dirty: ['limits'] }), rl) && !M.coachable(rec(), { ...rl, hasTrace: false }));

    // A temp lap log: the record lands after two looks, as the verdict hold makes it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-livecoach-'));
    const lapDir = path.join(dir, 'laps');
    const traceDir = path.join(dir, 'traces');
    fs.mkdirSync(lapDir, { recursive: true });
    const day = path.join(lapDir, '2026-11-03.jsonl');
    const out = rec({ id: 'out', at: '2026-11-03T09:58:40.000Z', lapMs: 95000, isOutLap: true, clean: false, dirty: ['pit'] });
    fs.writeFileSync(day, JSON.stringify(out) + '\n');
    const m = M.createMeasurer({ lapDir, traceDir, reviewDir: path.join(dir, 'reviews') });
    const req = { lapSec: 80.123, atMs: at + 200, track: 'Road Atlanta', target: null };
    check('look 1: not there yet', m.attempt(req).found === false);
    check('look 2: the file has not grown, not there', m.attempt(req).found === false);
    fs.appendFileSync(day, JSON.stringify(rec({ id: 'fly', stintLap: 2 })) + '\n');
    const got = m.attempt(req);
    check('look 3: found once it lands', got.found === true && got.lap.lapId === 'fly', JSON.stringify(got).slice(0, 200));
    check('…in the lap-log session that holds it, numbered as the review numbers it', got.lap && got.lap.sessionId === `${out.at}~ra_4083` && got.lap.lapNo === 2, got.lap && `${got.lap.sessionId} #${got.lap.lapNo}`);
    check('…not coachable without a trace, so not measured', got.lap.valid === false && got.lap.hasTrace === false && got.lap.breakdown === null);
    check('…the reference is the session best so far, with its delta', got.lap.refLapId === 'fly' && got.lap.refSec === 80.123 && got.lap.deltaSec === 0);
    check('…and what each step cost', got.ms && got.ms.total >= 0);
    const chased = m.attempt({ ...req, target: { lapId: 'board:x:79000' } });
    check('a chased target whose columns the worker lost is asked for again', chased.found === false && chased.needTarget === true);
    fs.rmSync(dir, { recursive: true, force: true });

    // The worker round trip: a lap from 1970 is in nobody's lap log.
    const client = M.createWorkerClient({ reviewDir: () => '' });
    const t0 = Date.now();
    const w1 = await client.measure({ lapSec: 80, atMs: 1000, track: '', target: null });
    check('the worker answers "not there yet" for a lap that is not in the log', w1 && w1.found === false, JSON.stringify(w1));
    const w2 = await client.measure({ lapSec: 80, atMs: 1000, track: '', target: { kind: 'chased', label: 'x', lapId: 'own:1', lapSec: 79, columns: { d: [0, 1], t: [0, 79] } } });
    const w3 = await client.measure({ lapSec: 80, atMs: 1000, track: '', target: { kind: 'chased', label: 'x', lapId: 'own:1', lapSec: 79, columns: { d: [0, 1], t: [0, 79] } } });
    check('…and keeps a chased target\'s columns across looks (sent once)', w2 && w2.found === false && !w2.needTarget && w3 && !w3.needTarget, JSON.stringify(w3));
    console.log(`        worker round trips: ${Date.now() - t0} ms for three (start-up included)`);
    client.close();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
