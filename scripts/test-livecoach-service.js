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
  const settings = { updateChannel: o.channel || 'beta', engineer: { liveCoach: o.liveCoach !== false, ...(o.engineer || {}) } };
  const r = {
    settings,
    session: { startedAt: 1000, type: 'practice', track: 'Road Atlanta', car: 'Porsche', carClass: 'GT3' },
    said: [],
    published: [],
    dropped: [],
    measures: [],
    ai: [],
    logs: [],
    engine: o.engine === null ? null : o.engine || fakeEngine(),
    voice: o.voice || fakeVoice(),
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
    ...(o.lapAtLine ? { lapAtLine: () => true } : {}),
    ...(o.verify ? { verify: (req) => o.verify(req, r) } : {}),
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
    options: { retryMs: 5, retryForMs: o.retryForMs ?? 2000, summaryTimeoutMs: o.summaryTimeoutMs ?? 200, gateEveryMs: 0, crossingWaitMs: o.crossingWaitMs ?? 3000, debriefTimeoutMs: o.debriefTimeoutMs ?? 200, debriefLapWaitMs: 100 },
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


  console.log('\nAt the line: the server\'s lap, stepped at once, judged again when the log has it');
  {
    // The measurer's answer for a lap handed over at the line (req.extra).
    const atLine = (n, req) => {
      if (!req.extra) return found(n);
      const f = found(n, { lapId: req.extra.record.id });
      f.lap.provisional = true;
      f.lap.at = req.extra.record.at;
      return f;
    };
    const crossing = (r, i, t, o = {}) => {
      const lapSec = 80 + i / 10;
      const lap = { record: { id: `L${i}`, at: new Date(t).toISOString(), lapMs: Math.round(lapSec * 1000), track: 'Road Atlanta', clean: true, dirty: [] }, trace: { d: [0, 1], t: [0, lapSec] }, wallMs: t };
      if (!o.late) r.coach.onLapAtLine(lap);
      return lap;
    };
    const verdicts = new Map(); // lapId -> what the log says once it lands
    const verifyAfter = (looks) => (req) => {
      const v = verdicts.get(req.lapId);
      const n = (v && (v.looks = (v.looks || 0) + 1)) || 0;
      return Promise.resolve(v && n >= looks ? { found: true, lapId: req.lapId, ...v.says } : { found: false });
    };

    // 1. The crossing → stepped within the budget, the snapshot fresh at once.
    const r = rig({ misses: 0, lapAtLine: true, answer: atLine, verify: verifyAfter(3) });
    r.coach.update(PRACTICE(), 0);
    let t = Date.now();
    crossing(r, 1, t);
    r.lap(1, { at: t });
    await r.coach._idle();
    check('the lap at the line is measured with the server\'s copy (no lap-log wait)', r.measures.length === 1 && r.measures[0].extra && r.measures[0].extra.record.id === 'L1');
    const tm = r.coach.timings()[0];
    check('…stepped within the budget (crossing → step < 1 s here)', tm.atLine === true && tm.sinceLineMs < 1000, `${tm.sinceLineMs} ms`);
    check('…and the snapshot has that lap at once', r.coach.snapshot().last.lapId === 'L1' && r.coach.snapshot().state.validLaps === 1);
    // 2. Clean verdict → nothing, not stepped twice.
    verdicts.set('L1', { says: { valid: true, clean: true, dirty: [] } });
    await wait(60);
    check('a clean verdict later: not stepped twice', r.engine.seen.length === 1 && r.coach.snapshot().state.validLaps === 1);
    // 3. Lap 2 stepped (says the focus), then its verdict lands dirty: reverted.
    t = Date.now();
    crossing(r, 2, t);
    r.lap(2, { at: t });
    await r.coach._idle();
    check('lap 2 at the line: the focus is said at once', r.said.length === 1 && r.said[0].kind === 'coachFocus' && lastPub(r).focus && lastPub(r).validLaps === 2);
    const pubs = r.published.length;
    verdicts.set('L2', { says: { valid: false, clean: false, dirty: ['limits'] } });
    await wait(60);
    check('a dirty verdict later: reverted to the state before the lap', r.coach.snapshot().state.validLaps === 1 && r.coach.snapshot().state.focus === null, JSON.stringify(r.coach.snapshot().state.validLaps));
    check('…the card re-published without it', r.published.length === pubs + 1 && lastPub(r).validLaps === 1 && lastPub(r).focus === null);
    check('…what was said stands, nothing new is said', r.said.length === 1);
    check('…the snapshot keeps the lap as the last, now invalid', r.coach.snapshot().last.lapId === 'L2' && r.coach.snapshot().last.valid === false && r.coach.snapshot().lastValid.lapId === 'L1');

    // 4. A late verdict on a lap with another lap stepped on top: re-stepped.
    verdicts.clear(); // a fresh session: no verdict has landed yet
    const q = rig({ misses: 0, lapAtLine: true, answer: atLine, verify: verifyAfter(1) });
    q.coach.update(PRACTICE(), 0);
    for (const i of [1, 2, 3]) {
      t = Date.now();
      crossing(q, i, t);
      q.lap(i, { at: t });
      await q.coach._idle();
    }
    // Verdicts: lap 1 clean, lap 3 clean, lap 2 dirty, landing in the order 1, 3, 2.
    verdicts.set('L1', { says: { valid: true } });
    verdicts.set('L3', { says: { valid: true } });
    await wait(30);
    const saidBefore = q.said.length;
    const seenBefore = q.engine.seen.length;
    verdicts.set('L2', { says: { valid: false, dirty: ['limits'] } });
    await wait(60);
    check('lap 2 taken back under lap 3: lap 3 re-stepped on the state before lap 2', q.coach.snapshot().state.validLaps === 2 && q.engine.seen.length === seenBefore + 1 && q.coach.snapshot().last.lapId === 'L3', `${q.coach.snapshot().state.validLaps} ${q.engine.seen.length - seenBefore}`);
    check('…silently', q.said.length === saidBefore);

    // 5. The server's copy arrives a moment AFTER the frame's lap.
    const late = rig({ misses: 0, lapAtLine: true, answer: atLine });
    late.coach.update(PRACTICE(), 0);
    t = Date.now();
    const lap = crossing(late, 1, t, { late: true });
    late.lap(1, { at: t });
    await wait(20);
    late.coach.onLapAtLine(lap);
    await late.coach._idle();
    check('a lap at the line that lands after the frame\'s lap is still used', late.measures.length === 1 && !!late.measures[0].extra);

    // 6. The hook is there but no lap comes (another sim, no trace): the lap log.
    const none = rig({ misses: 1, lapAtLine: true, crossingWaitMs: 30 });
    none.coach.update(PRACTICE(), 0);
    none.lap(1, { at: Date.now() });
    await none.coach._idle();
    check('no lap at the line: falls back to the lap log after the wait', none.measures.length === 2 && none.measures.every((m) => !m.extra) && none.engine.seen.length === 1);
    // 7. No hook at all: the lap log at once (every test above the "At the line" block runs so).
    const old = rig({ misses: 0 });
    old.coach.update(PRACTICE(), 0);
    old.coach.onLapAtLine(crossing(old, 1, Date.now(), { late: true })); // ignored: nobody waits for it
    old.lap(1, { at: Date.now() });
    await old.coach._idle();
    check('hook missing: the disk path, no wait', old.measures.length === 1 && !old.measures[0].extra && old.engine.seen.length === 1);
    // 8. A lap at the line from a race is never kept.
    const off = rig();
    off.coach.update(PRACTICE({ type: 'race' }), 0);
    off.coach.onLapAtLine(crossing(off, 1, Date.now(), { late: true }));
    check('not coaching: a lap at the line is dropped', !off.coach.active());
  }

  console.log('\nAt the line, on disk: the provider hook, the coachLoad seam, the self-reference rule');
  {
    const { synthTrace } = require('./fixtures/livecoach-synth');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-livecoach-synth-'));
    const lapDir = path.join(dir, 'laps');
    const traceDir = path.join(dir, 'traces');
    fs.mkdirSync(path.join(traceDir, '2026-11-03'), { recursive: true });
    fs.mkdirSync(lapDir);
    const base = Date.parse('2026-11-03T10:00:00Z');
    const mk = (id, i, tr, extra = {}) => ({ v: 7, id, at: new Date(base + i * 90000).toISOString(), sim: 'lmu', track: 'Synth', trackKey: 'synth_4000', trackLengthM: 4000, car: 'P', carClass: 'GT3', lapMs: Math.round(tr.lapSec * 1000), distanceM: 4000, sessionType: 'practice', clean: true, dirty: [], ...extra });
    const slow = synthTrace({ corners: [{ d: 0.3, minKph: 100 }, { d: 0.7, minKph: 90 }] });
    const fast = synthTrace();
    const quicker = synthTrace({ corners: [{ d: 0.3, minKph: 115 }, { d: 0.7, minKph: 92 }] });
    const recs = [mk('out', 0, fast, { isOutLap: true, clean: false, dirty: ['pit'] }), mk('A', 1, slow), mk('B', 2, fast)];
    fs.writeFileSync(path.join(lapDir, '2026-11-03.jsonl'), recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
    for (const [x, tr] of [[recs[1], slow], [recs[2], fast]]) {
      fs.writeFileSync(path.join(traceDir, '2026-11-03', `${x.id}.json`), JSON.stringify({ v: 2, lapId: x.id, at: x.at, sim: 'lmu', trackKey: x.trackKey, track: x.track, trackLengthM: 4000, car: 'P', carClass: 'GT3', lapMs: x.lapMs, trace: tr }));
    }
    const m = M.createMeasurer({ lapDir, traceDir, reviewDir: path.join(dir, 'reviews') });
    const ra = m.attempt({ lapSec: recs[1].lapMs / 1000, atMs: Date.parse(recs[1].at) });
    check('disk path: a slower lap is measured against the session best', ra.lap.valid && !!ra.lap.breakdown && ra.lap.refLapId === 'B' && ra.lap.breakdown.totalSec > 0.3, ra.lap.breakdown && ra.lap.breakdown.totalSec.toFixed(3));
    const rb = m.attempt({ lapSec: recs[2].lapMs / 1000, atMs: Date.parse(recs[2].at) });
    check('the self-reference rule: the session best against itself has no breakdown', rb.lap.selfRef === true && rb.lap.breakdown === null);
    // The next lap, at the line: not on disk, its trace in memory.
    const c = mk('C', 3, quicker);
    const rc = m.attempt({ lapSec: c.lapMs / 1000, atMs: Date.parse(c.at), extra: { record: c, trace: quicker } });
    check('at the line: provisional, in the logged session, measured from memory', rc.found && rc.lap.provisional === true && rc.lap.sessionId === `${recs[0].at}~synth_4000` && rc.lap.lapNo === 4 && rc.lap.valid === true);
    check('…against the logged best (not itself), so a faster lap reads as time gained', rc.lap.breakdown && rc.lap.breakdown.refLapId === 'B' && rc.lap.breakdown.totalSec < 0 && rc.lap.selfRef === false, rc.lap.breakdown && rc.lap.breakdown.totalSec.toFixed(3));
    check('…its delta against that best', rc.lap.refSec === recs[2].lapMs / 1000 && rc.lap.deltaSec < 0);
    const dirtyAtLine = m.attempt({ lapSec: c.lapMs / 1000, atMs: Date.parse(c.at), extra: { record: { ...c, clean: false, dirty: ['limits'] }, trace: quicker } });
    check('a cut already charged at the line: provisional and not coachable', dirtyAtLine.lap.provisional && dirtyAtLine.lap.valid === false);
    check('verify: not in the log yet', m.verify({ lapId: 'C', atMs: Date.parse(c.at), lapSec: c.lapMs / 1000 }).found === false);
    fs.appendFileSync(path.join(lapDir, '2026-11-03.jsonl'), JSON.stringify({ ...c, clean: false, dirty: ['limits'] }) + '\n');
    const v = m.verify({ lapId: 'C', atMs: Date.parse(c.at), lapSec: c.lapMs / 1000 });
    check('verify: the record lands with its verdict', v.found && v.valid === false && v.dirty.join() === 'limits');
    const again = m.attempt({ lapSec: c.lapMs / 1000, atMs: Date.parse(c.at), extra: { record: c, trace: quicker } });
    check('a lap at the line already in the log is the log\'s, not provisional', again.lap.provisional === false);
    // The coachLoad seam on its own.
    const coachLoad = require('../dist/telemetry/coachLoad');
    const deps = { reviewDir: path.join(dir, 'reviews'), lapDir, traceDir, sessionBest: true };
    const args = { sessionId: `${recs[0].at}~synth_4000`, lapId: 'D', at: c.at, targetLapId: 'sessionBest' };
    check('coachLoad: an unknown lap without extraLap is null', coachLoad.loadLapCoach(args, deps) === null);
    const viaSeam = coachLoad.loadLapCoach(args, { ...deps, extraLap: { lapId: 'D', at: c.at, lapMs: c.lapMs, trace: quicker } });
    check('coachLoad: extraLap measures it against the session\'s target', viaSeam && viaSeam.breakdown && viaSeam.breakdown.lapId === 'D' && viaSeam.breakdown.refLapId === 'B' && viaSeam.report);
    check('coachLoad: extraLap naming another lap is ignored', coachLoad.loadLapCoach(args, { ...deps, extraLap: { lapId: 'E', at: c.at, lapMs: c.lapMs, trace: quicker } }) === null);
    fs.rmSync(dir, { recursive: true, force: true });

    // The provider's hook, driven on a bare instance (no sim, no timers).
    const { LmuRestProvider } = require('../dist/telemetry/lmuRestProvider');
    const heard = [];
    const p = Object.create(LmuRestProvider.prototype);
    let held = null;
    p.lapRecorder = { pending: () => held };
    p.pendingTraces = [];
    p.lapAnnounced = '';
    p.lapListener = null;
    p.setLapCompleteListener((lap) => heard.push(lap));
    const t0 = Date.parse('2026-11-03T12:00:00Z');
    p.emitLapAtLine(t0);
    check('provider: nothing held, nothing heard', heard.length === 0);
    held = { id: 'X', at: new Date(t0).toISOString(), lapMs: 80000, clean: true, dirty: [] };
    p.emitLapAtLine(t0 + 100);
    check('provider: a held lap waits for its trace', heard.length === 0);
    p.pendingTraces.push({ trace: { lapSec: 70, d: [], t: [] }, wallMs: t0 - 200 }); // the wrong lap time
    p.pendingTraces.push({ trace: { lapSec: 80.02, d: [], t: [] }, wallMs: t0 - 150 });
    p.emitLapAtLine(t0 + 200);
    check('provider: announced once its trace is here, paired by clock and lap time', heard.length === 1 && heard[0].record.id === 'X' && heard[0].trace.lapSec === 80.02 && heard[0].wallMs === t0 - 150);
    p.emitLapAtLine(t0 + 300);
    check('provider: once per lap', heard.length === 1);
    held = { id: 'Y', at: new Date(t0 + 90000).toISOString(), lapMs: 80000, clean: true, dirty: [] };
    p.emitLapAtLine(t0 + 96000);
    check('provider: a lap whose trace never comes is given up (not announced late)', heard.length === 1 && p.lapAnnounced === 'Y');
    p.setLapCompleteListener(() => { throw new Error('x'); });
    held = { id: 'Z', at: new Date(t0 + 180000).toISOString(), lapMs: 80000, clean: true, dirty: [] };
    p.pendingTraces.push({ trace: { lapSec: 80, d: [], t: [] }, wallMs: t0 + 180000 });
    let threw = false;
    try { p.emitLapAtLine(t0 + 180100); } catch { threw = true; }
    check('provider: a throwing listener never takes the frame down', !threw);
    const { LapRecorder } = require('../dist/telemetry/lapLog');
    check('LapRecorder.pending(): null when nothing is held', new LapRecorder().pending() === null);
    const srv = require('../dist/server/index');
    check('server: setLapCompleteListener is exported', typeof srv.setLapCompleteListener === 'function');
    srv.setLapCompleteListener(null);
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

  console.log('\nAt the line, in the provider: one hand-over per lap, matched to its trace');
  {
    // LmuRestProvider.emitLapAtLine without a sim: only the fields it reads.
    const { LmuRestProvider } = require('../dist/telemetry/lmuRestProvider.js');
    const p = Object.create(LmuRestProvider.prototype);
    const heard = [];
    p.setLapCompleteListener((lap) => heard.push(lap));
    const at = '2026-11-03T12:00:00.000Z';
    const atMs = Date.parse(at);
    let held = { id: 'L1', at, lapMs: 80123, dirty: [] };
    p.lapRecorder = { pending: () => (held ? { ...held, dirty: [...held.dirty] } : null) };
    p.lapAnnounced = '';
    p.pendingTraces = [
      { trace: { lapSec: 95.0 }, wallMs: atMs - 95000 }, // the lap before
      { trace: { lapSec: 80.12 }, wallMs: atMs + 40 },
    ];
    p.emitLapAtLine(atMs + 100);
    check('a held lap with its trace is handed over at once', heard.length === 1 && heard[0].record.id === 'L1' && heard[0].trace.lapSec === 80.12);
    p.emitLapAtLine(atMs + 200);
    check('…once: the next frames hand nothing more', heard.length === 1);
    held = { id: 'L2', at: new Date(atMs + 80000).toISOString(), lapMs: 80000, dirty: [] };
    p.emitLapAtLine(atMs + 81000);
    check('a lap whose trace is not here yet waits (no hand-over)', heard.length === 1);
    p.pendingTraces.push({ trace: { lapSec: 80.0 }, wallMs: atMs + 80030 });
    p.emitLapAtLine(atMs + 81100);
    check('…and goes once the trace lands', heard.length === 2 && heard[1].record.id === 'L2');
    held = { id: 'L3', at: new Date(atMs + 160000).toISOString(), lapMs: 80000, dirty: [] };
    p.emitLapAtLine(atMs + 166000);
    check('no trace within 5 s: never handed over (the lap log takes it)', heard.length === 2 && p.lapAnnounced === 'L3');
    p.setLapCompleteListener(() => {
      throw new Error('boom');
    });
    held = { id: 'L4', at: new Date(atMs + 240000).toISOString(), lapMs: 80000, dirty: [] };
    p.pendingTraces.push({ trace: { lapSec: 80.0 }, wallMs: atMs + 240010 });
    let threw = false;
    try {
      p.emitLapAtLine(atMs + 240100);
    } catch {
      threw = true;
    }
    check('a listener that throws never takes the frame down', !threw);
    const { LapRecorder } = require('../dist/telemetry/lapLog.js');
    check('LapRecorder.pending: null with nothing held', new LapRecorder().pending() === null);
  }

  /* ------------------------------------------------------------------------ */
  /*  Coach v2 (2026-11-04): approach cues, the run debrief, the work list    */
  /* ------------------------------------------------------------------------ */

  /**
   * A v2 engine on top of the v1 fake: a work list (C4 at cueD 0.10, C7 at
   * 0.50), corners improved this run, and the three optional entry points
   * written to the contract. `approachCueAt` fires when the ETA to cueD is
   * between the words' own time (+ lead, radioGate GATE) and 3 s more. The
   * real engine is built on another branch; this follows liveCoachContract.ts.
   */
  const { GATE: GATE_V2 } = require('../dist/telemetry/radioGate');
  function fakeEngineV2(o = {}) {
    const base = fakeEngine();
    const e = {
      seen: base.seen,
      opts: [],
      cueCalls: 0,
      starts: 0,
      initLiveCoach: (k) => ({ ...base.initLiveCoach(k), work: [], runImproved: [], runStartLap: 0 }),
      stepLiveCoach(state, lap, opts) {
        e.opts.push(opts);
        const step = base.stepLiveCoach(state, lap, opts);
        const st = step.state;
        if (st.focus) {
          const c7 = { ...st.focus, cornerId: 'C7', cornerNo: 7, entryD: 0.5, apexD: 0.52, exitD: 0.55, lossSec: 0.1, short: 'Exit 3 km/h up', status: 'new', cueD: 0.5, approach: 'Corner seven, pick up earlier.', rank: 2, gainSec: 0 };
          const c4 = { ...st.focus, cueD: 0.1, approach: 'Corner four, brake ten metres later.', rank: 1, gainSec: 0.05, baselineSec: 0.25 };
          st.work = [c4, c7].slice(0, (opts && opts.maxWork) || 3);
          st.focus = st.work[0];
          st.runImproved = st.runStartLap ? [] : [{ cornerId: 'C2', gainSec: 0.12 }];
        }
        return { ...step, work: st.work };
      },
      approachCueAt(state, pos, cued) {
        e.cueCalls++;
        if (o.cueThrows) throw new Error('boom');
        for (const f of state.work || []) {
          if (!f.approach || cued.includes(f.cornerId)) continue;
          const distM = ((((f.cueD - pos.lapD) % 1) + 1) % 1) * pos.trackLengthM;
          const eta = distM / (pos.speedKph / 3.6);
          const need = GATE_V2.speechLeadSec + f.approach.split(/\s+/).length / GATE_V2.wordsPerSec;
          if (eta >= need && eta <= need + 3) return { cornerId: f.cornerId, text: f.approach, etaSec: eta };
        }
        return null;
      },
      runDebrief(state) {
        const laps = state.validLaps - (state.runStartLap || 0);
        if (laps < 2) return null;
        return {
          improved: [{ cornerId: 'C2', gainSec: 0.12 }],
          still: [{ cornerId: 'C4', lossSec: 0.2, what: 'braking ten metres early' }],
          text: "You've improved corner two, a tenth. Still to work on: four, braking ten metres too early.",
          laps,
        };
      },
      startRun(state) {
        e.starts++;
        return { ...state, runStartLap: state.validLaps, runImproved: [] };
      },
    };
    return e;
  }

  function fakeVoiceV2(o = {}) {
    const v = fakeVoice();
    v.debriefAsks = [];
    v.debriefRequest = (debrief, snap, ctx) => {
      v.debriefAsks.push({ debrief, snap, ctx });
      return { kind: 'session', context: { track: ctx.track }, facts: [{ id: 'run.c2', text: 'C2 0.12 s better', kind: 'live', value: 0.12, unit: 's' }] };
    };
    v.speakableDebrief = (reply, debrief) => {
      const ai = reply && 'ai' in reply ? reply.ai : reply;
      if (o.unspeakable) return null;
      return ai && ai.headline ? `AI: ${ai.headline} (${debrief.laps} laps)` : null;
    };
    return v;
  }

  /** One frame on the lap: lap fraction `d`, speed, lap number (lapsCompleted + 1), pit lane. */
  function lapFrame(d, o = {}) {
    return {
      connected: true,
      session: { type: 'practice', track: 'Road Atlanta', trackLengthM: 4000 },
      player: { lap: { last: -1 }, speedKph: o.kph ?? 200, ...(o.ghostD !== undefined ? { ghost: { active: true, atD: o.ghostD } } : {}) },
      trackMap: { cars: [{ slotId: 9, isPlayer: false, lapFraction: 0.9, inPit: false }, { slotId: 1, isPlayer: true, lapFraction: d, inPit: !!o.inPit }] },
      standings: [{ isPlayer: true, lapsCompleted: (o.lap ?? 5) - 1, inPit: !!o.inPit }],
    };
  }

  /** A v2 rig with two valid laps in: the work list is up, the cues can fire. */
  async function v2rig(o = {}) {
    const r = rig({ misses: 0, engine: fakeEngineV2(o), voice: o.voice || fakeVoiceV2(o), ...o });
    r.t = 0;
    r.coach.update(PRACTICE(), r.t);
    r.lap(1);
    r.lap(2);
    await r.coach._idle();
    r.said.length = 0;
    /** Drive the lap from `from` to `to` in `step` fractions, one frame every `dt` ms. */
    r.drive = (from, to, step, fo = {}, dt = 100) => {
      for (let d = from; d <= to + 1e-9; d += step) {
        r.t += dt;
        r.coach.update(lapFrame(Math.round(d * 1e6) / 1e6, fo), r.t);
      }
    };
    return r;
  }
  const cues = (r) => r.said.filter((c) => c.kind === 'coachApproach');
  const debriefs = (r) => r.said.filter((c) => c.kind === 'coachRunDebrief');

  console.log('\nv2 approach cues: said on the straight before the corner, timed to end before it');
  {
    const r = await v2rig();
    // 200 km/h on a 4 km lap: 6 words take 2.74 s = 152 m = 0.038 of a lap, so
    // C4's cue (cueD 0.10) is due from d ≈ 0.020 (5.7 s out) to 0.062 (2.7 s).
    r.drive(0.0, 0.015, 0.005);
    check('not yet: more than 3 s beyond the words\' time out', cues(r).length === 0, JSON.stringify(r.said));
    r.drive(0.02, 0.09, 0.005);
    const c = cues(r);
    check('one cue for corner four, as coachApproach', c.length === 1 && /Corner four/.test(c[0].text), JSON.stringify(c));
    check('…with the default approach priority (0: never pushes a held lap line off)', c[0] && c[0].priority === 0);
    r.drive(0.1, 0.12, 0.005);
    check('cued once a lap: nothing more through the corner', cues(r).length === 1);
    r.drive(0.4, 0.49, 0.005);
    check('the next work corner (seven) gets its own cue on the same lap', cues(r).length === 2 && /Corner seven/.test(cues(r)[1].text), JSON.stringify(cues(r)));
    r.drive(0.4, 0.48, 0.005);
    check('…and only once, even driving the same stretch again', cues(r).length === 2);
    r.drive(0.95, 0.99, 0.01);
    r.drive(0.0, 0.07, 0.005, { lap: 6 });
    check('a new lap: corner four is cued again', cues(r).length === 3 && /Corner four/.test(cues(r)[2].text), JSON.stringify(cues(r)));
  }

  {
    const r = await v2rig();
    // No standings row: the lap number comes from counting the line.
    const noRow = (d) => {
      const f = lapFrame(d);
      delete f.standings;
      return f;
    };
    for (const d of [0.02, 0.03, 0.04]) r.coach.update(noRow(d), (r.t += 100));
    for (const d of [0.95, 0.98, 0.005, 0.02, 0.03]) r.coach.update(noRow(d), (r.t += 100));
    check('no standings row: the wrapping lap fraction is the line (cued again next lap)', cues(r).length === 2, JSON.stringify(cues(r)));
  }

  {
    const r = await v2rig();
    // The ghost's filtered atD wins over the 7 Hz track-map fraction.
    r.drive(0.3, 0.3, 0.005, { ghostD: 0.03 });
    check('the ghost\'s atD is the position while a ghost runs', cues(r).length === 1, JSON.stringify(r.said));
  }

  console.log('\nv2 approach cues: never in the pit lane, an out-lap, a crawl, or before minLaps');
  {
    const r = await v2rig();
    r.drive(0.02, 0.06, 0.005, { inPit: true, kph: 60 });
    check('in the pit lane: no cue', cues(r).length === 0);
    await r.coach._debrief();
    r.drive(0.02, 0.09, 0.005);
    r.drive(0.4, 0.49, 0.005);
    check('the out-lap (pit exit to the line): no cue', cues(r).length === 0, JSON.stringify(cues(r)));
    r.drive(0.95, 0.99, 0.01);
    r.drive(0.0, 0.06, 0.005, { lap: 6 });
    check('the first flying lap: cued', cues(r).length === 1);
  }
  {
    const r = await v2rig();
    r.drive(0.035, 0.06, 0.002, { kph: 50 });
    check('under 60 km/h: no cue', cues(r).length === 0);
  }
  {
    const r = rig({ misses: 0, engine: fakeEngineV2(), voice: fakeVoiceV2() });
    r.coach.update(PRACTICE(), 0);
    r.lap(1);
    await r.coach._idle();
    let t = 0;
    for (let d = 0.02; d < 0.07; d += 0.005) r.coach.update(lapFrame(d), (t += 100));
    check('before minLaps: approachCueAt is not even asked', r.engine.cueCalls === 0 && cues(r).length === 0);
  }
  {
    const r = await v2rig({ engineer: { liveCoachApproach: false } });
    r.drive(0.02, 0.07, 0.005);
    check('cues switched off in the Engineer tab: none, and the engine is not asked', cues(r).length === 0 && r.engine.cueCalls === 0);
  }
  {
    const r = await v2rig({ cueThrows: true });
    r.drive(0.02, 0.07, 0.005);
    check('an engine that throws: no cue, logged once, the frame loop unharmed', cues(r).length === 0 && r.logs.filter((l) => /approachCueAt failed/.test(l)).length === 1);
  }
  {
    const r = rig({ misses: 0 }); // the v1 engine: no approachCueAt, no runDebrief
    r.coach.update(PRACTICE(), 0);
    r.lap(1);
    r.lap(2);
    await r.coach._idle();
    const n = r.said.length;
    let t = 0;
    for (let d = 0.02; d < 0.07; d += 0.005) r.coach.update(lapFrame(d), (t += 100));
    r.coach.update(lapFrame(0.5, { inPit: true }), (t += 100));
    await r.coach._debrief();
    check('a v1 engine: no cue, no debrief, no throw', r.said.length === n && r.coach.active());
    check('…and the card has no work list (the widget falls back to focus)', !('work' in lastPub(r)) && lastPub(r).focus && lastPub(r).focus.cornerId === 'C4');
  }

  console.log('\nv2 approach cues: cheap — about ten reads a second at 120 Hz');
  {
    const r = await v2rig();
    const before = r.engine.cueCalls;
    // 1 s of 120 Hz frames, on a stretch with no cue due.
    for (let i = 0; i < 120; i++) r.coach.update(lapFrame(0.3), (r.t += 1000 / 120));
    const calls = r.engine.cueCalls - before;
    check('120 frames in a second → ~10 engine asks', calls >= 9 && calls <= 11, calls);
    const pos = require('../electron/live-coach').readPosition(lapFrame(0.25, { lap: 7 }), { lapD: NaN, speedKph: 0, lapNo: NaN, inPit: false, trackLengthM: 0 });
    check('readPosition: the player\'s car, its lap, its speed, the lap length', pos.lapD === 0.25 && pos.lapNo === 7 && pos.speedKph === 200 && pos.inPit === false && pos.trackLengthM === 4000, JSON.stringify(pos));
  }

  console.log('\nv2 the run debrief on pit entry: the AI\'s words, else the template, then a new run');
  {
    const r = await v2rig();
    r.drive(0.9, 0.95, 0.01);
    r.coach.update(lapFrame(0.96, { inPit: true, kph: 80 }), (r.t += 100));
    await r.coach._debrief();
    const d = debriefs(r);
    check('AI ok: one coachRunDebrief in the AI\'s words', d.length === 1 && d[0].text === 'AI: tidy session (2 laps)', JSON.stringify(d));
    check('…the voice was asked with the template and the session context', r.voice.debriefAsks.length === 1 && r.voice.debriefAsks[0].debrief.laps === 2 && r.voice.debriefAsks[0].ctx.track === 'Road Atlanta');
    check('…sent to the coach function as the voice built it', r.ai.length === 1 && r.ai[0].kind === 'session' && r.ai[0].facts[0].id === 'run.c2');
    check('…outranks the lap chatter in the one-slot hold', d[0] && d[0].priority === 3);
    check('then startRun: a new run from here', r.engine.starts === 1 && r.coach.snapshot().state.runStartLap === 2);
    check('…and the card re-published without this run\'s improved corners', Array.isArray(lastPub(r).improved) && lastPub(r).improved.length === 0);
    r.drive(0.97, 0.99, 0.01, { inPit: true, kph: 60 });
    r.coach.update(lapFrame(0.99, { inPit: false }), (r.t += 100));
    r.coach.update(lapFrame(0.995, { inPit: true }), (r.t += 100));
    await r.coach._debrief();
    check('back in the pit lane with no laps since: nothing said, a new run all the same', debriefs(r).length === 1 && r.engine.starts === 2);
  }
  {
    const r = await v2rig({ askAi: () => ({ ok: false, code: 'not_member' }) });
    r.coach.update(lapFrame(0.9, { inPit: true }), (r.t += 100));
    await r.coach._debrief();
    const d = debriefs(r);
    check('AI failing: the template is said', d.length === 1 && /^You've improved corner two/.test(d[0].text), JSON.stringify(d));
    check('…then startRun', r.engine.starts === 1);
  }
  {
    const r = await v2rig({
      askAi: () => {
        throw new Error('offline');
      },
    });
    r.coach.update(lapFrame(0.9, { inPit: true }), (r.t += 100));
    await r.coach._debrief();
    check('AI throwing: the template', debriefs(r).length === 1 && r.engine.starts === 1);
  }
  {
    const r = await v2rig({ unspeakable: true });
    r.coach.update(lapFrame(0.9, { inPit: true }), (r.t += 100));
    await r.coach._debrief();
    const d = debriefs(r);
    check('an AI reply the voice will not speak: the template', d.length === 1 && /^You've improved/.test(d[0].text));
  }
  {
    const r = await v2rig({
      debriefTimeoutMs: 60,
      askAi: async () => {
        await wait(250);
        return { ok: true, ai: { headline: 'too late' } };
      },
    });
    const t0 = Date.now();
    r.coach.update(lapFrame(0.9, { inPit: true }), (r.t += 100));
    await r.coach._debrief();
    const took = Date.now() - t0;
    const d = debriefs(r);
    check('AI slow: the template at the timeout, not the late answer', d.length === 1 && /^You've improved/.test(d[0].text) && took < 240, `${took} ms ${JSON.stringify(d)}`);
    await wait(260);
    check('…and the late answer is never said', debriefs(r).length === 1 && r.engine.starts === 1);
  }
  {
    const r = await v2rig({ voice: { ...fakeVoice(), debriefRequest: undefined } });
    r.coach.update(lapFrame(0.9, { inPit: true }), (r.t += 100));
    await r.coach._debrief();
    check('a voice without debriefRequest: the template, the AI not asked', debriefs(r).length === 1 && r.ai.length === 0);
  }
  {
    const r = await v2rig({
      debriefTimeoutMs: 500,
      askAi: async () => {
        await wait(80);
        return { ok: true, ai: { headline: 'x' } };
      },
    });
    r.coach.update(lapFrame(0.9, { inPit: true }), (r.t += 100));
    r.coach.update({ connected: true, session: { type: 'race', track: 'Road Atlanta' }, player: {} }, (r.t += 100));
    await wait(150);
    check('the session ends while the AI is asked: nothing said, no new run', debriefs(r).length === 0 && r.engine.starts === 0);
  }
  {
    // A session that starts in the garage is not a pit entry.
    const r = rig({ misses: 0, engine: fakeEngineV2(), voice: fakeVoiceV2() });
    r.coach.update(lapFrame(0.5, { inPit: true }), 0);
    await r.coach._debrief();
    check('starting in the garage: no debrief, no new run', r.said.length === 0 && r.engine.starts === 0);
  }
  {
    // A one-lap run then the pits: too short to debrief.
    const r = rig({ misses: 0, engine: fakeEngineV2(), voice: fakeVoiceV2() });
    r.coach.update(lapFrame(0.5), 0);
    r.lap(1);
    await r.coach._idle();
    r.coach.update(lapFrame(0.9, { inPit: true }), 200);
    await r.coach._debrief();
    check('a run under minLaps: nothing said, a new run started', debriefs(r).length === 0 && r.engine.starts === 1);
  }

  console.log('\nv2 the debrief on demand: snapshot().runDebrief, debriefNow(), endRun()');
  {
    const r = await v2rig();
    const snap = r.coach.snapshot();
    check('snapshot() carries the run debrief template', snap.runDebrief && snap.runDebrief.laps === 2 && /^You've improved/.test(snap.runDebrief.text));
    const out = await r.coach.debriefNow();
    check('debriefNow(): the AI\'s words, nothing said by the service', out && out.source === 'ai' && out.text === 'AI: tidy session (2 laps)' && r.said.length === 0, JSON.stringify(out));
    check('…then a new run', r.engine.starts === 1 && r.coach.snapshot().runDebrief === null);
    check('…and with nothing since: null', (await r.coach.debriefNow()) === null);
    r.lap(3);
    r.lap(4);
    await r.coach._idle();
    const tpl = await r.coach.debriefNow({ ai: false, startRun: false });
    check('debriefNow({ ai: false, startRun: false }): the template, the run kept', tpl && tpl.source === 'template' && r.engine.starts === 1 && r.voice.debriefAsks.length === 1, JSON.stringify({ tpl, starts: r.engine.starts, ai: r.ai.length }));
    check('endRun(): a new run on request', r.coach.endRun('answered') === true && r.engine.starts === 2);
    r.coach.stop('test');
    check('off: snapshot null, debriefNow null, endRun false', r.coach.snapshot() === null && (await r.coach.debriefNow()) === null && r.coach.endRun() === false);
  }

  console.log('\nv2 the card: the work list and the improved corners on player.coach');
  {
    const r = await v2rig();
    const ov = lastPub(r);
    check('work: costliest first, with rank, gain and cueD', Array.isArray(ov.work) && ov.work.length === 2 && ov.work[0].cornerId === 'C4' && ov.work[0].rank === 1 && ov.work[0].gainSec === 0.05 && ov.work[0].cueD === 0.1 && ov.work[1].cornerId === 'C7', JSON.stringify(ov.work));
    check('…only the contract\'s fields (no spoken text, no approach line)', ov.work.every((w) => !('spoken' in w) && !('approach' in w) && !('cue' in w)));
    check('focus stays for v1 readers, = work[0]', ov.focus && ov.focus.cornerId === 'C4' && !('rank' in ov.focus));
    check('improved: corner number from the id', Array.isArray(ov.improved) && ov.improved.length === 1 && ov.improved[0].cornerId === 'C2' && ov.improved[0].cornerNo === 2 && ov.improved[0].gainSec === 0.12, JSON.stringify(ov.improved));
  }

  console.log('\nv2 settings: the Engineer tab\'s two controls reach the engine');
  {
    const r = await v2rig({ engineer: { liveCoachCorners: 2 } });
    const last = r.engine.opts[r.engine.opts.length - 1];
    check('defaults read: approach cues on, corners as set (2)', last.approachCues === true && last.maxWork === 2, JSON.stringify(last));
    r.settings.engineer = { ...r.settings.engineer, liveCoachCorners: 1, liveCoachApproach: false };
    r.coach.update(PRACTICE(), (r.t += 100));
    r.lap(3);
    await r.coach._idle();
    const next = r.engine.opts[r.engine.opts.length - 1];
    check('a change applies from the next lap: one corner, no cues', next.approachCues === false && next.maxWork === 1, JSON.stringify(next));
    check('…the work list follows', lastPub(r).work.length === 1);
    r.coach.update(PRACTICE(), (r.t += 100));
    r.lap(4);
    await r.coach._idle();
    check('the same settings: the same options object (nothing rebuilt per gate)', r.engine.opts[r.engine.opts.length - 1] === next);
    const { coachSettingsOf } = require('../electron/live-coach');
    check('junk reads as the defaults', JSON.stringify(coachSettingsOf({ engineer: { liveCoachCorners: 9, liveCoachApproach: 'no' } })) === JSON.stringify({ approach: true, maxWork: 3 }));
    const { sanitizeEngineer, DEFAULT_ENGINEER_SETTINGS } = require('../electron/engineer-settings');
    check('settings: defaults on and 3', DEFAULT_ENGINEER_SETTINGS.liveCoachApproach === true && DEFAULT_ENGINEER_SETTINGS.liveCoachCorners === 3);
    check('settings: false and 1–3 survive sanitize ("2" as a number)', sanitizeEngineer({ liveCoachApproach: false }).liveCoachApproach === false && sanitizeEngineer({ liveCoachCorners: '2' }).liveCoachCorners === 2 && sanitizeEngineer({ liveCoachCorners: 1 }).liveCoachCorners === 1);
    check('settings: junk keeps the stored value', sanitizeEngineer({ liveCoachCorners: 5 }, { liveCoachCorners: 1 }).liveCoachCorners === 1 && sanitizeEngineer({ liveCoachApproach: 'x' }, { liveCoachApproach: false }).liveCoachApproach === false);
    const { EngineerService } = require('../electron/engineer');
    let settings = { engineerEnabled: true, engineer: { liveCoachCorners: 2, liveCoachApproach: false } };
    const svc = new EngineerService({ dir: path.join(os.tmpdir(), 'apex-livecoach-test'), loadSettings: () => settings, onStatus: () => {} });
    check('status() carries both for the panel', svc.status().liveCoachCorners === 2 && svc.status().liveCoachApproach === false);
    settings = { engineerEnabled: true, engineer: {} };
    check('…defaults when older settings lack them', svc.status().liveCoachCorners === 3 && svc.status().liveCoachApproach === true);
  }

  console.log('\nv2 the radio: approach cues expire in 1.5 s, the new kinds are routine and essential');
  {
    const gate = require('../dist/telemetry/radioGate');
    const { APPROACH_HOLD_MS } = require('../dist/telemetry/liveCoachContract');
    const { EngineerService, TRIGGER_TIERS } = require('../electron/engineer');
    const v2 = ['coachApproach', 'coachLapDebrief', 'coachRunDebrief'];
    check('the three v2 kinds are in KINDS (dropped with the rest when the coach stops)', v2.every((k) => KINDS.includes(k)));
    check('…normal urgency, never safety, essential on the dial', v2.every((k) => gate.KIND_URGENCY[k] === 'normal' && !gate.breaksQuiet(k) && TRIGGER_TIERS[k] === 'essential'));
    check('HOLD_BUDGET_BY_KIND.coachApproach = APPROACH_HOLD_MS (1.5 s)', gate.HOLD_BUDGET_BY_KIND.coachApproach === APPROACH_HOLD_MS && APPROACH_HOLD_MS === 1500);
    const settings = { engineerEnabled: true, engineerVoice: 'en_GB-alan-medium', engineer: { readouts: 'essential' } };
    const svc = new EngineerService({ dir: path.join(os.tmpdir(), 'apex-livecoach-test'), loadSettings: () => settings, onStatus: () => {} });
    const spoken = [];
    svc.speak = (text) => spoken.push(text);
    svc.running = true;
    let clock = 1000;
    svc.clock = () => clock;
    svc.asking = true;
    svc.sayTiered('Corner five, brake ten metres later.', { kind: 'coachApproach', priority: 0 });
    const h = svc.heldReadout;
    check('a busy channel holds the cue for 1.5 s, not 15', h && h.kind === 'coachApproach' && h.expiresAt - h.heldAtMs === 1500, h && h.expiresAt - h.heldAtMs);
    svc.asking = false;
    clock += 1600;
    svc.pumpHeldReadout();
    check('…and drops it after, never said late', svc.heldReadout === null && spoken.length === 0);
    svc.asking = true;
    svc.sayTiered('Better through four and nine.', { kind: 'coachLapDebrief', priority: 1 });
    check('the lap-end line keeps the normal 15 s budget', svc.heldReadout && svc.heldReadout.expiresAt - svc.heldReadout.heldAtMs === gate.HOLD_BUDGET_MS.normal);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
