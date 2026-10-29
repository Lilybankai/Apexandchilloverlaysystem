/**
 * scripts/test-coachipc.js — the coach's IPC and loader
 * (electron/coach-ipc.js, src/telemetry/coachLoad.ts).
 * -----------------------------------------------------------------------------
 *   §1 the request: facts cleaned and capped, the hash stable, sensitive to
 *      every fact and to the template version, and recomputed for a caller's
 *      own request (a cache entry cannot be aimed);
 *   §2 the AI path with a fake cloud: one call, then the disk cache (offline
 *      works); identical requests in flight share one call; failures map to
 *      codes and are never cached;
 *   §3 the handlers on a fake ipcMain: practice ones beta-gated, review:coach
 *      and coach:ai not; bad arguments answered, never thrown;
 *   §4 end to end on disk (a real Road Atlanta lap, planted faults): the
 *      session coach, the lap coach and the Review comparison coach find the
 *      planted corner; practice:coachAi merges the AI words over the template.
 *
 * Run: npm run build && node scripts/test-coachipc.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IPC = require('../electron/coach-ipc');
const { _test: T } = IPC;
const { COACH_REPORT_VERSION } = require('../dist/telemetry/coachReport');
const { loadSessionCoach, loadLapCoach, loadReviewCoach } = require('../dist/telemetry/coachLoad');
const { listSessions } = require('../dist/telemetry/stintReview');
const { findCorners } = require('../dist/telemetry/corners');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}
const show = (v) => JSON.stringify(v);
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

const FACTS = [
  { id: 'C2.loss', cornerId: 'C2', kind: 'cornerLoss', value: 0.2, unit: 's', text: 'C2 costs 0.20 s a lap on average.', extra: 'dropped' },
  { id: 'C2.brakeDeltaM', cornerId: 'C2', phase: 'braking', kind: 'brakeDeltaM', value: -8, unit: 'm', text: 'C2: you brake 8 m earlier than the target.' },
];
const CTX = { track: 'Road Atlanta', car: 'Car', carClass: 'GT3', targetLabel: 'Session best', lapSec: 80.1, refSec: 79.9 };
const REPORT = { scope: 'session', facts: FACTS, takeaways: [] };

/* ---------------------------------- §1 ----------------------------------- */

console.log('\n§1 the request and its hash');
{
  const req = T.requestFromReport(REPORT, CTX, COACH_REPORT_VERSION);
  check('kind from scope', req.kind === 'session' && T.requestFromReport({ ...REPORT, scope: 'lap' }, CTX, 1).kind === 'lap');
  check('facts keep only the wire fields', show(Object.keys(req.facts[0]).sort()) === show(['cornerId', 'id', 'kind', 'text', 'unit', 'value']));
  check('hash is sha256 hex', /^[0-9a-f]{64}$/.test(req.inputHash));
  check('same input, same hash', T.requestFromReport(REPORT, CTX, COACH_REPORT_VERSION).inputHash === req.inputHash);
  const changed = { ...REPORT, facts: [FACTS[0], { ...FACTS[1], value: -9, text: 'C2: you brake 9 m earlier than the target.' }] };
  check('a changed fact changes the hash', T.requestFromReport(changed, CTX, COACH_REPORT_VERSION).inputHash !== req.inputHash);
  check('a new template version changes the hash', T.requestFromReport(REPORT, CTX, COACH_REPORT_VERSION + 1).inputHash !== req.inputHash);
  check('the context changes the hash', T.requestFromReport(REPORT, { ...CTX, track: 'Spa' }, COACH_REPORT_VERSION).inputHash !== req.inputHash);
  // 85 facts with the cited and session-wide ones LAST, as a real session
  // orders them: the cut must keep those and drop corner detail instead.
  {
    const detail = Array.from({ length: 80 }, (_, i) => ({ id: `C${(i % 9) + 1}.d${i}`, kind: 'x', value: i, unit: 's', text: `detail ${i}` }));
    const tail = ['pattern.brakeEarly', 'S3.loss', 'session.aimFor', 'seq.C2-C4.loss', 'C2.loss'].map((id, i) => ({ id, kind: 'x', value: i, unit: 's', text: `wide ${id}` }));
    const rep = { scope: 'session', facts: [...detail, ...tail], takeaways: [{ factIds: ['pattern.brakeEarly', 'C2.loss'] }], worst: [{ factIds: ['C2.loss'] }] };
    const sent = new Set(T.requestFromReport(rep, CTX, COACH_REPORT_VERSION).facts.map((f) => f.id));
    check('over the cap: cited facts are kept', sent.has('pattern.brakeEarly') && sent.has('C2.loss'));
    check('over the cap: session-wide facts are kept', sent.has('S3.loss') && sent.has('session.aimFor') && sent.has('seq.C2-C4.loss'));
    check('over the cap: corner detail is what goes', !sent.has('C9.d80') && sent.size === 60);
  }
  const many = { scope: 'session', facts: Array.from({ length: 90 }, (_, i) => ({ id: `f${i}`, kind: 'x', value: i, unit: 's', text: `fact ${i}` })) };
  check('facts capped at 60', T.requestFromReport(many, CTX, 1).facts.length === 60);
  const raw = T.requestFromRaw({ kind: 'habits', inputHash: 'aimed', context: CTX, facts: FACTS }, COACH_REPORT_VERSION);
  check('raw request: hash recomputed, never the caller\'s', raw && raw.inputHash !== 'aimed' && /^[0-9a-f]{64}$/.test(raw.inputHash));
  check('raw request: unknown kind refused', T.requestFromRaw({ kind: 'chat', facts: FACTS }, 1) === null);
  check('raw request: no facts refused', T.requestFromRaw({ kind: 'habits', facts: [] }, 1) === null);
}

/* ---------------------------------- §2 ----------------------------------- */

const AI = {
  headline: 'Braking into C2 is the lap.',
  takeaways: [{ title: 'Later into C2', body: 'Brake later into C2.', factIds: ['C2.loss', 'C2.brakeDeltaM'], cornerIds: ['C2'] }],
  sequences: [],
};

function fakeAuth(answer) {
  const calls = [];
  return {
    calls,
    async functionsInvoke(fn, body) {
      calls.push({ fn, body });
      await new Promise((r) => setTimeout(r, 5));
      return typeof answer === 'function' ? answer(body) : answer;
    },
    async rpc() {
      return { ok: false, error: 'no network in tests' };
    },
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-coachipc-'));
  try {
    console.log('\n§2 the AI path, with its caches');
    {
      const auth = fakeAuth({ ok: true, body: { ok: true, ai: AI } });
      const ai = T.createAi({ authService: auth, userDataDir: () => root });
      const req = T.requestFromReport(REPORT, CTX, COACH_REPORT_VERSION);
      const [a, b] = await Promise.all([ai.ask(req), ai.ask(req)]);
      check('two asks in flight, one cloud call', auth.calls.length === 1, auth.calls.length);
      check('the call goes to the coach function with the request', auth.calls[0].fn === 'coach' && auth.calls[0].body.inputHash === req.inputHash);
      check('both get the answer', a.ok && b.ok && show(a.ai) === show(AI));
      check('written to userData/coach-cache/<hash>.json', fs.existsSync(path.join(root, 'coach-cache', `${req.inputHash}.json`)));
      const offline = T.createAi({ authService: fakeAuth({ ok: false, error: 'offline' }), userDataDir: () => root });
      const c = await offline.ask(req);
      check('a fresh process, offline: served from the cache', c.ok && c.cached === true && show(c.ai) === show(AI));

      const codes = [
        [{ ok: false, signedOut: true }, 'signed-out'],
        [{ ok: false, status: 403 }, 'entitled'],
        [{ ok: false, status: 404 }, 'unavailable'],
        [{ ok: false, status: 429 }, 'burst'],
        [{ ok: true, body: { ok: false, code: 'rejected' } }, 'rejected'],
      ];
      for (const [answer, code] of codes) {
        const dir = fs.mkdtempSync(path.join(root, 'c-'));
        const x = T.createAi({ authService: fakeAuth(answer), userDataDir: () => dir });
        const r = await x.ask(req);
        check(`failure → code ${code}, not cached`, !r.ok && r.code === code && !fs.existsSync(path.join(dir, 'coach-cache', `${req.inputHash}.json`)), r.code);
      }
    }

    console.log('\n§3 handlers');
    const handlers = new Map();
    const fakeIpc = { handle: (ch, fn) => handlers.set(ch, fn) };
    let beta = false;
    const auth = fakeAuth({ ok: true, body: { ok: true, ai: AI } });
    const dataDir = fs.mkdtempSync(path.join(root, 'ud-'));
    const reviewDir = path.join(root, 'none');
    IPC.register(fakeIpc, { authService: auth, reviewDir: () => reviewDir, userDataDir: () => dataDir, practiceAllowed: () => beta });
    check('all five channels registered', ['practice:coach', 'practice:coachAi', 'practice:coachLap', 'review:coach', 'coach:ai'].every((c) => handlers.has(c)));
    const call = (ch, arg) => handlers.get(ch)({}, arg);
    check('practice:coach gated off beta', (await call('practice:coach', { sessionId: 'x' })).ok === false);
    check('practice:coachAi gated off beta', (await call('practice:coachAi', { sessionId: 'x' })).ok === false);
    const gl = await call('practice:coachLap', { sessionId: 'x', lapId: 'y' });
    check('practice:coachLap gated off beta, shape kept', gl.ok === false && Array.isArray(gl.show) && gl.breakdown === null);
    beta = true;
    check('no session id → ok:false', (await call('practice:coach', {})).ok === false && (await call('practice:coach', null)).ok === false);
    check('review:coach without a lap → ok:false', (await call('review:coach', {})).ok === false);
    const rb = await call('review:coach', { id: 'a', at: 'b', vs: { board: { driverId: 'd', trackId: 't', carClass: 'GT3' } } });
    check('review:coach board lap offline → ok:false "unavailable"', rb.ok === false && rb.error === 'unavailable', rb.error);
    const ca = await call('coach:ai', { report: REPORT, context: CTX });
    check('coach:ai from a report', ca.ok && show(ca.ai) === show(AI));
    const ch = await call('coach:ai', { kind: 'habits', context: CTX, facts: FACTS });
    check('coach:ai with a habits request', ch.ok && auth.calls.some((c) => c.body.kind === 'habits'));
    check('coach:ai with nothing → ok:false', (await call('coach:ai', {})).ok === false);

    console.log('\n§4 end to end, on disk');
    {
      const FIX = require('./fixtures/trace-road-atlanta-gt3.json');
      const L = FIX.trackLengthM;
      const BASE = FIX.trace;
      const FULL = findCorners(BASE, L);
      const K = FULL.findIndex((c, i) => c.brakeD !== null && i > 0);
      const clone = (tr) => Object.fromEntries(Object.entries(tr).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]));
      const faulted = ({ lossSec = 0, kph = 0, shiftM = 0 }) => {
        const tr = clone(BASE);
        const c = FULL[K];
        const n = tr.d.length;
        if (shiftM) {
          const from = c.entryD - 150 / L;
          for (let i = 0; i < n; i++) {
            const d = tr.d[i];
            if (d < from || d > c.apexD) continue;
            const want = d - shiftM / L;
            let j = 0;
            while (j < n - 1 && BASE.d[j + 1] < want) j++;
            const a = BASE.d[j], b = BASE.d[Math.min(j + 1, n - 1)];
            const f = b > a ? Math.min(1, Math.max(0, (want - a) / (b - a))) : 0;
            tr.brake[i] = BASE.brake[j] + (BASE.brake[Math.min(j + 1, n - 1)] - BASE.brake[j]) * f;
          }
        }
        for (let i = 0; i < n; i++) {
          const d = tr.d[i];
          if (lossSec && d > c.entryD) tr.t[i] += lossSec * (d >= c.exitD ? 1 : (d - c.entryD) / (c.exitD - c.entryD));
          if (kph && d >= c.entryD && d <= c.exitD) tr.speedKph[i] -= kph;
        }
        tr.lapSec += lossSec;
        return tr;
      };
      const disk = fs.mkdtempSync(path.join(root, 'disk-'));
      const laps = path.join(disk, 'laps');
      const traces = path.join(disk, 'traces');
      const reviews = path.join(disk, 'practice-reviews');
      fs.mkdirSync(laps, { recursive: true });
      fs.mkdirSync(reviews, { recursive: true });
      const day = '2026-10-29';
      const rec = { v: 6, sim: 'lmu', track: FIX.track, trackKey: FIX.trackKey, trackLengthM: L, car: FIX.car, carClass: FIX.carClass, distanceM: L, sessionType: 'practice', clean: true, dirty: [] };
      const lapsIn = [
        { id: 'p1', at: `${day}T10:00:00.000Z`, trace: faulted({ lossSec: 0.25, shiftM: -15, kph: 4 }) },
        { id: 'p2', at: `${day}T10:01:30.000Z`, trace: BASE },
        { id: 'p3', at: `${day}T10:03:00.000Z`, trace: faulted({ lossSec: 0.2, shiftM: -15, kph: 4 }) },
        { id: 'p4', at: `${day}T10:04:30.000Z`, trace: faulted({ lossSec: 0.22, shiftM: -15, kph: 4 }) },
      ];
      fs.writeFileSync(
        path.join(laps, `${day}.jsonl`),
        lapsIn.map((l) => JSON.stringify({ ...rec, id: l.id, at: l.at, lapMs: Math.round(l.trace.lapSec * 1000) })).join('\n') + '\n',
      );
      for (const l of lapsIn) {
        const dir = path.join(traces, day);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `${l.id}.json`),
          JSON.stringify({ v: 2, lapId: l.id, at: l.at, sim: 'lmu', trackKey: FIX.trackKey, track: FIX.track, trackLengthM: L, car: FIX.car, carClass: FIX.carClass, lapMs: Math.round(l.trace.lapSec * 1000), trace: l.trace }),
        );
      }
      const sid = listSessions(laps)[0].id;
      const deps = { reviewDir: reviews, lapDir: laps, traceDir: traces };
      const want = `C${K + 1}`;

      const s = loadSessionCoach({ sessionId: sid }, deps);
      check('session coach built', s && s.report.scope === 'session' && s.report.sessionId === sid);
      check(`worst corner is the planted one (${want})`, s && s.report.worst[0] && s.report.worst[0].id === want, s && show(s.report.worst.map((w) => [w.id, w.lossSec])));
      check('≈0.22 s a lap there', s && near(s.report.worst[0].lossSec, 0.223, 0.02), s && s.report.worst[0].lossSec);
      check('tip: brake later and carry speed', s && /^Brake 15 m later and carry 4 km\/h more to the apex\.$/.test(s.report.worst[0].tip), s && s.report.worst[0].tip);
      check('the target lap is not in the per-lap losses', s && s.report.worst[0].perLapSec[1] === null, s && show(s.report.worst[0].perLapSec));
      check('targetLapId is accepted without the fair loader', !!loadSessionCoach({ sessionId: sid, targetLapId: 'board:x' }, deps));
      check('unknown session → null', loadSessionCoach({ sessionId: 'nope' }, deps) === null);

      const lc = loadLapCoach({ sessionId: sid, lapId: 'p3', at: lapsIn[2].at }, deps);
      check('lap coach: scope lap, planted corner first', lc && lc.report.scope === 'lap' && lc.report.worst[0] && lc.report.worst[0].id === want, lc && show(lc.report.worst.map((w) => w.id)));
      check('lap coach: breakdown and show present (stub-empty is fine)', lc && 'breakdown' in lc && Array.isArray(lc.show));
      check('unknown lap → null', loadLapCoach({ sessionId: sid, lapId: 'zz' }, deps) === null);

      const rc = loadReviewCoach({ id: 'p3', at: lapsIn[2].at, vs: { id: 'p2', at: lapsIn[1].at } }, { lapDir: laps, traceDir: traces });
      check('review coach vs an own lap: planted corner first', rc && rc.report.worst[0] && rc.report.worst[0].id === want, rc && show(rc.report.worst.map((w) => w.id)));
      check('review coach without vs → null', loadReviewCoach({ id: 'p3', at: lapsIn[2].at }, { lapDir: laps, traceDir: traces }) === null);
      const board = { found: true, driverId: 'd1', lapMs: lapsIn[1].trace.lapSec * 1000, data: BASE };
      const rb2 = loadReviewCoach({ id: 'p3', at: lapsIn[2].at, vs: { board: { driverId: 'd1', trackId: 't', carClass: 'GT3' } } }, { lapDir: laps, traceDir: traces, boardPayload: board });
      check('review coach vs a board lap payload', rb2 && rb2.report.worst[0] && rb2.report.worst[0].id === want);

      // The AI words over this session's template (the handler's own path, minus the default lap log).
      const auth2 = fakeAuth((body) => ({
        ok: true,
        body: {
          ok: true,
          ai: {
            headline: `Braking into ${want} is the lap.`,
            takeaways: [{ title: `Later into ${want}`, body: `Brake later into ${want}.`, factIds: [`${want}.loss`], cornerIds: [want] }],
            sequences: [],
          },
        },
      }));
      const tpl = loadSessionCoach({ sessionId: sid }, deps).report;
      const R = require('../dist/telemetry/coachReport');
      const req = T.requestFromReport(tpl, CTX, R.COACH_REPORT_VERSION);
      const ai = T.createAi({ authService: auth2, userDataDir: () => dataDir });
      const got = await ai.ask(req);
      const merged = R.applyAi(tpl, got.ai);
      check('AI words merged over the template: source ai, worst untouched', merged.source === 'ai' && show(merged.worst) === show(tpl.worst) && merged.takeaways[0].title === `Later into ${want}`);
      check('merged takeaway keeps a template chip', merged.takeaways[0].chip && merged.takeaways[0].chip === tpl.takeaways.find((t) => t.factIds.includes(`${want}.loss`)).chip, merged.takeaways[0].chip);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
