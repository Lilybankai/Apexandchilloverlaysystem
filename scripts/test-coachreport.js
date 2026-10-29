/**
 * scripts/test-coachreport.js — the coach's template words
 * (src/telemetry/coachReport.ts).
 * -----------------------------------------------------------------------------
 * The template is the layer the AI may only re-word, so its numbers and its
 * blame must be right. Every figure here is planted:
 *
 *   §1 without engine breakdowns (the stub era) the debrief's own corner rows
 *      give a full report: the right worst corners, in order, with the right
 *      phase, tip, priority and per-lap losses; dirty laps and the target lap
 *      itself never count;
 *   §2 the pattern takeaway ("Braking too early in key corners", chip
 *      "≈0.32 s total"), the sector takeaway from sector times, the target
 *      takeaway — and never more than three;
 *   §3 aimFor: best − 0.7 × top losses, never below the theoretical best,
 *      never at or above the best, null when there is nothing to win;
 *   §4 breakdown mode: phases decide the phase; straight time flagged 'tow' or
 *      'car' is never the driver's — out of every loss ranked, tipped or aimed;
 *   §5 deterministic: the same input gives the same report byte for byte;
 *   §6 lap scope from rows; applyAi keeps the template's chips and refuses
 *      unknown ids; old cached reviews (no per-lap rows) still get words.
 *
 * Run: npm run build && node scripts/test-coachreport.js
 */

'use strict';

const R = require('../dist/telemetry/coachReport');

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
const near = (a, b, tol = 1e-6) => typeof a === 'number' && Math.abs(a - b) <= tol;
const show = (v) => JSON.stringify(v);

/* ------------------------------- fixtures -------------------------------- */

/**
 * Five corners, six laps. Lap 3 is dirty, lap 6 is the session best (the
 * target). Per corner, per lap: [deltaSec, brakeDeltaM, apexKphDelta].
 *   C1  matched (tiny noise)
 *   C2  brakes ~8 m early, ≈0.20 s a lap          → braking, high
 *   C3  gains time
 *   C4  ~5 km/h slow at the apex, ≈0.15 s a lap    → midCorner, high
 *   C5  brakes ~6 m early, ≈0.12 s a lap           → braking, medium
 */
const PLAN = {
  C1: [[0.01, 1, 0], [0.0, 0, 0], [0.5, 0, 0], [0.01, 0, 0], [-0.01, 0, 0]],
  C2: [[0.22, -8, 0], [0.18, -9, 0], [0.9, -30, -9], [0.2, -7, 0], [0.2, -8, 0]],
  C3: [[-0.05, 2, 2], [-0.04, 1, 2], [0, 0, 0], [-0.06, 2, 3], [-0.05, 1, 2]],
  C4: [[0.16, 0, -5], [0.14, 0, -4], [0.6, 0, -12], [0.15, 0, -5], [0.15, 0, -6]],
  C5: [[0.12, -6, 0], [0.13, -6, 0], [0.3, 0, 0], [0.11, -5, 0], [0.12, -7, 0]],
};
const IDS = Object.keys(PLAN);
const SPANS = [0.05, 0.25, 0.45, 0.62, 0.85];

function fixtureReview() {
  const target = { kind: 'sessionBest', label: 'Session best · 1:39.800', lapId: 'L6', lapSec: 99.8 };
  const lapSecs = [100.5, 100.4, 102.0, 100.3, 100.2, 99.8];
  const laps = lapSecs.map((lapSec, i) => ({
    at: `2026-10-29T10:0${i}:00.000Z`,
    lapNo: i + 1,
    lapSec,
    valid: i !== 2,
    hasTrace: true,
    deltaSec: Math.round((lapSec - 99.8) * 1000) / 1000,
    corners:
      i === 5
        ? IDS.map((_, k) => ({ index: k, deltaSec: 0, brakeDeltaM: 0, apexKphDelta: 0, score: null }))
        : IDS.map((id, k) => {
            const [d, b, a] = PLAN[id][i];
            return { index: k, deltaSec: d, brakeDeltaM: b, apexKphDelta: a, score: null };
          }),
    score: null,
  }));
  return {
    id: 'S1',
    track: 'Test Raceway',
    car: 'Car',
    carClass: 'GT3',
    trackLengthM: 4000,
    startedAt: '2026-10-29T10:00:00.000Z',
    endedAt: '2026-10-29T10:10:00.000Z',
    target,
    laps,
    bestLapSec: 99.8,
    theoreticalBestSec: 99.5,
    consistencySec: 0.27,
    corners: IDS.map((id, k) => ({
      index: k,
      entryD: SPANS[k],
      apexD: SPANS[k] + 0.02,
      exitD: SPANS[k] + 0.04,
      laps: 5,
      avgLossSec: null,
      bestSec: null,
      worstSec: null,
      avgBrakeDeltaM: null,
      avgApexKphDelta: null,
      avgScore: null,
    })),
    score: { avg: null, best: null, bestLapNo: null },
  };
}

const LAP_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
const OPTS = { sessionId: 'S1', sequences: [], fairness: [], lapIds: LAP_IDS, generatedAt: '2026-10-29T10:10:00.000Z' };

/* ---------------------------------- §1 ----------------------------------- */

console.log('\n§1 fallback: the debrief rows alone');
const review = fixtureReview();
const rep = R.buildSessionCoach(review, [], OPTS);
check('scope session, source template, version stamped', rep.scope === 'session' && rep.source === 'template' && rep.version === R.COACH_REPORT_VERSION);
check('worst = C2, C4, C5 in that order', show(rep.worst.map((w) => w.id)) === show(['C2', 'C4', 'C5']), show(rep.worst.map((w) => w.id)));
const c2 = rep.worst[0];
check('C2 mean loss over valid non-target laps only (0.20)', near(c2.lossSec, 0.2, 1e-3), c2.lossSec);
check('C2 per-lap: 6 slots, dirty lap and target lap null', show(c2.perLapSec) === show([0.22, 0.18, null, 0.2, 0.2, null]), show(c2.perLapSec));
check('C2 phase braking, priority high', c2.phase === 'braking' && c2.priority === 'high');
check('C2 tip in the panel\'s words', c2.tip === 'Brake 8 m later.', c2.tip);
const c4 = rep.worst[1];
check('C4 phase midCorner, tip carries apex speed', c4.phase === 'midCorner' && c4.tip === 'Carry 5 km/h more to the apex.', c4.tip);
check('C5 priority medium (0.12 s)', rep.worst[2].priority === 'medium', rep.worst[2].priority);
check('confidence 0..1, consistent corner high', c2.confidence > 0.6 && c2.confidence <= 1, c2.confidence);
check('worst never holds a gaining corner', !rep.worst.some((w) => w.id === 'C3' || w.id === 'C1'));
check('every worst factId exists', rep.worst.every((w) => w.factIds.every((id) => rep.facts.some((f) => f.id === id))));
const f2 = rep.facts.find((f) => f.id === 'C2.brakeDeltaM');
check('fact C2.brakeDeltaM: negative = earlier, words agree', f2 && f2.value === -8 && /8 m earlier/.test(f2.text), f2 && f2.text);
check('fact C2.consistency counts laps', (rep.facts.find((f) => f.id === 'C2.consistency') || {}).text === 'C2 lost time on 4 of 4 laps.');
check('fact ids are unique', new Set(rep.facts.map((f) => f.id)).size === rep.facts.length);

/* ---------------------------------- §2 ----------------------------------- */

console.log('\n§2 takeaways');
check('at most three', rep.takeaways.length <= 3 && rep.takeaways.length >= 2, rep.takeaways.length);
const t1 = rep.takeaways[0];
check('first: braking pattern across C2 and C5', t1.title === 'Braking too early in key corners' && show(t1.cornerIds) === show(['C2', 'C5']), t1.title);
check('pattern chip ≈0.32 s total, tone loss', t1.chip === '≈0.32 s total' && t1.tone === 'loss', t1.chip);
const target = rep.takeaways.find((t) => t.tone === 'target');
check('target takeaway "Aim for …" matches aimForSec', target && target.chip === `Aim for ${R.fmtAim(rep.aimForSec)}`, target && target.chip);
check('every takeaway factId exists', rep.takeaways.every((t) => t.factIds.every((id) => rep.facts.some((f) => f.id === id))));
check('no sector data → potential falls back to the theoretical best', rep.takeaways.some((t) => t.tone === 'potential' && /0.30 s potential/.test(t.chip)), show(rep.takeaways.map((t) => t.chip)));

const sectorTimes = [
  [33.0, 34.0, 33.5],
  [33.1, 33.9, 33.4],
  null,
  [33.0, 33.9, 33.4],
  [33.0, 33.8, 33.4],
  [32.9, 33.8, 33.1],
];
// Best lap (L6) sector 3 = 33.1 vs fastest 33.1: 0; S1 32.9 is fastest … plant S3 so L6 lags:
sectorTimes[5] = [32.9, 33.8, 33.5];
sectorTimes[3] = [33.0, 33.9, 33.1];
const repS = R.buildSessionCoach(review, [], { ...OPTS, sectorTimes, sectorD: { s1: 0.33, s2: 0.66 } });
const st = repS.takeaways.find((t) => t.tone === 'potential');
check('sector takeaway: "Biggest gains in final sector", 0.40 s', st && st.title === 'Biggest gains in final sector' && st.chip === '0.40 s potential', st && `${st.title} / ${st.chip}`);
check('sector takeaway names the losing corner in it (C5)', st && show(st.cornerIds) === show(['C5']), st && show(st.cornerIds));
check('still at most three', repS.takeaways.length <= 3);

/* ---------------------------------- §3 ----------------------------------- */

console.log('\n§3 aimFor bounds');
check('report aim = best − 0.7 × top three (99.471), clamped to the theoretical 99.5', near(rep.aimForSec, 99.5, 1e-6), rep.aimForSec);
check('unclamped: best − 0.7 × top three', near(R.buildSessionCoach({ ...fixtureReview(), theoreticalBestSec: 99.0 }, [], OPTS).aimForSec, 99.8 - 0.7 * (0.2 + 0.15 + 0.12), 2e-3));
check('aim ≥ theoretical best', rep.aimForSec >= review.theoreticalBestSec);
check('aim < best', rep.aimForSec < review.bestLapSec);
check('clamped to the theoretical best', R.aimFor(100, 2, 99.6) === 99.6);
check('no theoretical: plain share', near(R.aimFor(100, 1, null), 99.3));
check('nothing to win → null', R.aimFor(100, 0, 99) === null && R.aimFor(100, 0.03, 99) === null);
check('no best → null', R.aimFor(null, 1, 99) === null);
check('theoretical equal to best → null (never "aim for" the time you did)', R.aimFor(100, 1, 100) === null);

/* ---------------------------------- §4 ----------------------------------- */

console.log('\n§4 breakdowns: phases, and the straight is not the driver');
function phaseLoss(id, index, lossSec, phases, opts = {}) {
  const P = { braking: 0, turnIn: 0, midCorner: 0, exit: 0, exitRun: 0, ...phases };
  return {
    id,
    index,
    entryD: SPANS[index],
    apexD: SPANS[index] + 0.02,
    exitD: SPANS[index] + 0.04,
    runEndD: SPANS[index] + 0.1,
    lossSec,
    phases: P,
    mine: { brakeOnD: opts.brakeMine ?? 0.1, brakeOffD: null, turnInD: null, apexD: null, pickupD: opts.pickMine ?? 0.2, fullThrottleD: null, entryKph: null, minKph: opts.minMine ?? 100, exitKph: null, topKph: null },
    ref: { brakeOnD: 0.1, brakeOffD: null, turnInD: null, apexD: null, pickupD: 0.2, fullThrottleD: null, entryKph: null, minKph: 100, exitKph: null, topKph: null },
    straightFlag: opts.flag ?? null,
    straightSec: opts.straight ?? 0,
  };
}
function breakdown(lapId) {
  return {
    lapId,
    refLapId: 'L6',
    corners: [
      // C1: exit-phase loss, throttle 10 m late.
      phaseLoss('C1', 0, 0.18, { exit: 0.06, exitRun: 0.12 }, { pickMine: 0.2 + 10 / 4000 }),
      // C2: 0.45 s, 0.40 of it a TOW on the straight after.
      phaseLoss('C2', 1, 0.45, { braking: 0.03, exitRun: 0.42 }, { flag: 'tow', straight: 0.4 }),
      // C3: all of it the car's straight-line speed.
      phaseLoss('C3', 2, 0.3, { exitRun: 0.3 }, { flag: 'car', straight: 0.3 }),
      // C4: braking 6 m early.
      phaseLoss('C4', 3, 0.1, { braking: 0.08, midCorner: 0.02 }, { brakeMine: 0.1 - 6 / 4000 }),
    ],
    sequences: [],
    leadInSec: 0,
    totalSec: 1.03,
    residualSec: 0,
  };
}
const bds = ['L1', 'L2', 'L4', 'L5'].map(breakdown);
const repB = R.buildSessionCoach(review, bds, { ...OPTS, sequences: [{ cornerIds: ['C3', 'C4'], lossSec: 0.12, kind: 'trade' }] });
check('worst = C1, C4 (C2 is mostly tow, C3 all car)', show(repB.worst.map((w) => w.id)) === show(['C1', 'C4', 'C2']) || show(repB.worst.map((w) => w.id)) === show(['C1', 'C4']), show(repB.worst.map((w) => w.id)));
const wC2 = repB.worst.find((w) => w.id === 'C2');
check('C2 ranked on driver loss only (0.05), never 0.45', !wC2 || near(wC2.lossSec, 0.05, 1e-3), wC2 && wC2.lossSec);
check('C3 (all car) is not in worst', !repB.worst.some((w) => w.id === 'C3'));
check('C2 phase is braking, not the tow\'s exit run', !wC2 || wC2.phase === 'braking', wC2 && wC2.phase);
const C1 = repB.worst[0];
check('C1 phase from the split: exitRun', C1.phase === 'exitRun', C1.phase);
check('C1 tip: throttle pick-up', /throttle 10 m sooner/.test(C1.tip), C1.tip);
check('C4 tip: brake later', repB.worst[1].tip === 'Brake 6 m later.', repB.worst[1].tip);
check('tow fact says whose it is', /tow, not your driving/.test((repB.facts.find((f) => f.id === 'C2.straight') || {}).text || ''));
check('car fact says whose it is', /straight-line speed, not your driving/.test((repB.facts.find((f) => f.id === 'C3.straight') || {}).text || ''));
const blame = repB.takeaways.filter((t) => t.tone !== 'potential').flatMap((t) => t.cornerIds);
check('no loss/target takeaway blames C3', !blame.includes('C3'), show(blame));
const c2loss = repB.facts.find((f) => f.id === 'C2.loss');
check('C2.loss fact is the driver\'s 0.05 s', c2loss && near(c2loss.value, 0.05, 1e-3), c2loss && c2loss.text);
check('aim ignores flagged time', near(repB.aimForSec, Math.max(99.5, 99.8 - 0.7 * (0.18 + 0.1 + 0.05)), 2e-3), repB.aimForSec);
check('sequence fact present', repB.facts.some((f) => f.id === 'seq.C3-C4.loss' && /trade time/.test(f.text)));
check('fairness passes through', show(R.buildSessionCoach(review, [], { ...OPTS, fairness: [{ kind: 'fuel', severity: 'warn', text: '≈0.4 s of the gap is fuel', estSec: 0.4 }] }).fairness) === show([{ kind: 'fuel', severity: 'warn', text: '≈0.4 s of the gap is fuel', estSec: 0.4 }]));
check('per-lap aligned by lap id', show(C1.perLapSec) === show([0.18, 0.18, null, 0.18, 0.18, null]), show(C1.perLapSec));

/* ---------------------------------- §5 ----------------------------------- */

console.log('\n§5 deterministic');
check('same input, same bytes (fallback)', show(R.buildSessionCoach(fixtureReview(), [], OPTS)) === show(rep));
check('same input, same bytes (breakdowns)', show(R.buildSessionCoach(fixtureReview(), ['L1', 'L2', 'L4', 'L5'].map(breakdown), { ...OPTS, sequences: [{ cornerIds: ['C3', 'C4'], lossSec: 0.12, kind: 'trade' }] })) === show(repB));
check('generatedAt from the input, not the clock', rep.generatedAt === '2026-10-29T10:10:00.000Z');

/* ---------------------------------- §6 ----------------------------------- */

console.log('\n§6 lap scope, applyAi, old reviews');
const lap = R.buildLapCoach({
  sessionId: 'S1',
  lapId: 'L1',
  breakdown: null,
  rows: [
    { id: 'C1', deltaSec: 0.3, brakeDeltaM: -12, apexKphDelta: -3 },
    { id: 'C2', deltaSec: -0.1, brakeDeltaM: 4, apexKphDelta: 2 },
    { id: 'C3', deltaSec: null, brakeDeltaM: null, apexKphDelta: null },
  ],
  lapSec: 100.5,
  refSec: 99.8,
  refLabel: 'Session best',
  theoreticalBestSec: 99.5,
  trackLengthM: 4000,
  generatedAt: 'x',
});
check('lap scope, lapId kept', lap.scope === 'lap' && lap.lapId === 'L1');
check('lap worst = C1 with both fixes', lap.worst.length === 1 && lap.worst[0].tip === 'Brake 12 m later and carry 3 km/h more to the apex.', lap.worst[0] && lap.worst[0].tip);
check('lap gap fact', (lap.facts.find((f) => f.id === 'lap.gap') || {}).text === '0.70 s off the reference (Session best).');
check('lap: one lap is never a sure habit', lap.worst[0].confidence <= 0.5, lap.worst[0].confidence);
check('lap takeaways ≤ 3', lap.takeaways.length <= 3);

const aiOk = {
  headline: 'Your braking is where the time is.',
  takeaways: [
    { title: 'Later on the brakes', body: 'C2 and C5 both want a later braking point.', factIds: ['pattern.brakeEarly', 'C2.loss'], cornerIds: ['C2', 'C5'] },
    { title: 'Push the apex in C4', body: 'Carry more speed to the apex in C4.', factIds: ['C4.minKphDelta'], cornerIds: ['C4'] },
  ],
  sequences: [],
};
const merged = R.applyAi(rep, aiOk);
check('applyAi: source ai, AI headline', merged.source === 'ai' && merged.headline === aiOk.headline);
check('applyAi: twin chip kept from the template', merged.takeaways[0].chip === '≈0.32 s total' && merged.takeaways[0].tone === 'loss', merged.takeaways[0].chip);
check('applyAi: numbers untouched (worst, aim, facts)', show(merged.worst) === show(rep.worst) && merged.aimForSec === rep.aimForSec && merged.facts === rep.facts);
const bad = R.applyAi(rep, { headline: 'x', takeaways: [{ title: 't', body: 'b', factIds: ['C9.loss'], cornerIds: [] }], sequences: [] });
check('applyAi: unknown fact id → template stands', bad === rep);
check('applyAi: null → template stands', R.applyAi(rep, null) === rep);

const old = fixtureReview();
old.laps.forEach((l) => (l.corners = []));
old.corners[1].avgLossSec = 0.2;
old.corners[1].avgBrakeDeltaM = -8;
old.corners[3].avgLossSec = 0.1;
old.corners[3].avgApexKphDelta = -4;
const repOld = R.buildSessionCoach(old, [], OPTS);
check('old cached review (summaries only) still gets words', show(repOld.worst.map((w) => w.id)) === show(['C2', 'C4']) && repOld.takeaways.length >= 1, show(repOld.worst.map((w) => w.id)));
const empty = R.buildSessionCoach({ ...fixtureReview(), corners: [], laps: [], bestLapSec: null, theoreticalBestSec: null, target: null }, [], OPTS);
check('empty session: no crash, no takeaways, a headline', empty.worst.length === 0 && empty.takeaways.length === 0 && !!empty.headline && empty.aimForSec === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
