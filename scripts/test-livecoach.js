/**
 * scripts/test-livecoach.js — the live practice coach's engine (liveCoach.ts).
 * -----------------------------------------------------------------------------
 * The engine decides what the race engineer says after a practice lap, so a
 * wrong sign here is the engineer telling a driver who brakes late to brake
 * later. Two halves:
 *
 *   §1–§9 synthetic breakdowns, one rule at a time: the brake shift's sign,
 *         tow / car time left out, invalid and outlier laps, minLaps, the
 *         two-of-three rule, new → improving → fixed → the next focus, the
 *         nag swap, consistency and summary timing, the words (speakable,
 *         ≤ 14 words, short ≤ 28 characters), a change of reference.
 *   §10   a REAL practice session from this machine's lap log + traces,
 *         stepped lap by lap with each lap measured against the session best
 *         so far, as the live service will. Prints the radio transcript.
 *         Skipped (not failed) on a machine with no practice traces.
 *
 * Run: npm run test:livecoach   (after npm run build)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../dist/telemetry/liveCoach');
const { LIVE_COACH_KINDS } = require('../dist/telemetry/liveCoachContract');
const { spokenWordCount, MAX_SPOKEN_WORDS } = require('../dist/telemetry/engineerPhrases');

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

/* ------------------------------ synthetic laps ---------------------------- */

const L = 4000; // metres
const PHASES = ['braking', 'turnIn', 'midCorner', 'exit', 'exitRun'];
const N_CORNERS = 8;
const GEO = Array.from({ length: N_CORNERS }, (_, i) => ({ entryD: 0.1 * i + 0.05, apexD: 0.1 * i + 0.08, exitD: 0.1 * i + 0.1 }));

const pts = (o = {}) => ({
  brakeOnD: null, brakeOffD: null, turnInD: null, apexD: null, pickupD: null, fullThrottleD: null,
  entryKph: null, minKph: null, exitKph: null, topKph: null, ...o,
});

/**
 * One corner. `spec`: { phase: 'braking', sec, brakeM (+ = I brake LATER),
 * minKph (mine − ref), exitKph, pickupM (+ = I pick up LATER), tow }.
 */
function corner(i, spec = {}) {
  const g = GEO[i];
  const phases = { braking: 0, turnIn: 0, midCorner: 0, exit: 0, exitRun: 0 };
  if (spec.sec) phases[spec.phase || 'braking'] += spec.sec;
  if (spec.tow) phases.exitRun += spec.tow;
  const refBrake = g.entryD;
  const refPick = g.apexD + 0.005;
  return {
    id: `C${i + 1}`, index: i, entryD: g.entryD, apexD: g.apexD, exitD: g.exitD, runEndD: i + 1 < N_CORNERS ? GEO[i + 1].entryD : 1,
    lossSec: PHASES.reduce((a, p) => a + phases[p], 0),
    phases,
    mine: pts({
      brakeOnD: spec.brakeM !== undefined ? refBrake + spec.brakeM / L : refBrake,
      minKph: 100 + (spec.minKph || 0),
      exitKph: 150 + (spec.exitKph || 0),
      pickupD: spec.pickupM !== undefined ? refPick + spec.pickupM / L : refPick,
    }),
    ref: pts({ brakeOnD: refBrake, minKph: 100, exitKph: 150, pickupD: refPick }),
    straightFlag: spec.tow ? spec.towKind || 'tow' : null,
    straightSec: spec.tow || 0,
  };
}

/** A lap: `specs` maps corner index → spec. */
let lapSeq = 0;
function lap(lapNo, specs = {}, o = {}) {
  lapSeq++;
  const corners = Array.from({ length: N_CORNERS }, (_, i) => corner(i, specs[i] || {}));
  const total = corners.reduce((a, c) => a + c.lossSec, 0);
  return {
    lapId: o.lapId || `lap-${lapSeq}`,
    lapNo,
    lapSec: o.lapSec !== undefined ? o.lapSec : 90 + total,
    valid: o.valid !== undefined ? o.valid : true,
    breakdown: o.noBreakdown ? null : { lapId: `lap-${lapSeq}`, refLapId: o.refLapId || 'ref-1', corners, sequences: [], leadInSec: 0, totalSec: total, residualSec: 0 },
    trackLengthM: L,
    refKind: o.refKind || 'sessionBest',
    refLapId: o.refLapId || 'ref-1',
    at: `2026-11-03T10:${String(lapNo).padStart(2, '0')}:00.000Z`,
  };
}

/** Steps laps from a state; returns every step. */
function run(laps, opts, state) {
  let s = state || C.initLiveCoach('test');
  const steps = [];
  for (const l of laps) {
    const st = C.stepLiveCoach(s, l, opts);
    steps.push(st);
    s = st.state;
  }
  return steps;
}

const allCalls = [];
function collect(steps) {
  for (const st of steps) allCalls.push(...st.calls);
  if (steps.length) {
    for (const st of steps) if (st.focus) allShorts.push(st.focus.short);
  }
  return steps;
}
const allShorts = [];

console.log('1) The brake shift: + = brake LATER, rounded to 5 m, never more than 25 m');
{
  // I brake 10 m EARLY (mine.brakeOnD is 10 m before ref's): the cue is +10, "later".
  const early = collect(run([1, 2].map((n) => lap(n, { 3: { phase: 'braking', sec: 0.15, brakeM: -11 } }))));
  const f = early[1].focus;
  check('a corner that brakes early becomes the focus on lap 2', f && f.cornerId === 'C4' && f.status === 'new', f && f.cornerId);
  check('brakeShiftM is positive (brake later)', f && f.cue.brakeShiftM === 10, f && JSON.stringify(f.cue));
  check('short: "Brake 10 m later"', f && f.short === 'Brake 10 m later', f && f.short);
  check('the radio says corner four and early / later', early[1].calls.length === 1 && /corner four/i.test(early[1].calls[0].text) && /(early|later)/.test(early[1].calls[0].text), early[1].calls[0] && early[1].calls[0].text);
  check('the call is a coachFocus', early[1].calls[0] && early[1].calls[0].kind === 'coachFocus');
  check('spoken: "Corner four, you\'re braking about ten metres early."', f && f.spoken === "Corner four, you're braking about ten metres early.", f && f.spoken);
  check('lossSec is the window mean', f && Math.abs(f.lossSec - 0.15) < 1e-9, f && f.lossSec);
  check('geometry comes from the breakdown', f && f.entryD === GEO[3].entryD && f.apexD === GEO[3].apexD && f.exitD === GEO[3].exitD && f.cornerNo === 4);

  // I brake 15 m LATE and lose under braking: the cue is −15, "earlier".
  const late = collect(run([1, 2].map((n) => lap(n, { 2: { phase: 'braking', sec: 0.2, brakeM: 14 } }))));
  const g = late[1].focus;
  check('braking late: brakeShiftM is negative (brake earlier)', g && g.cue.brakeShiftM === -15, g && JSON.stringify(g.cue));
  check('short: "Brake 15 m earlier"', g && g.short === 'Brake 15 m earlier', g && g.short);
  check('never says "later" to a driver who brakes late', late[1].calls.every((c) => !/later/.test(c.text)), late[1].calls[0] && late[1].calls[0].text);

  // 60 m early: capped at 25.
  const far = run([1, 2].map((n) => lap(n, { 0: { phase: 'braking', sec: 0.4, brakeM: -60 } })));
  check('never more than 25 m in one go', far[1].focus && far[1].focus.cue.brakeShiftM === 25, far[1].focus && far[1].focus.short);
  // 2 m: too small to say → phase only.
  const tiny = run([1, 2].map((n) => lap(n, { 0: { phase: 'braking', sec: 0.2, brakeM: -2 } })));
  check('a 2 m difference falls back to the phase', tiny[1].focus && tiny[1].focus.cue.brakeShiftM === undefined && /braking/i.test(tiny[1].focus.short), tiny[1].focus && tiny[1].focus.short);
}

console.log('\n2) Mid-corner, exit and turn-in cues');
{
  const mid = run([1, 2].map((n) => lap(n, { 1: { phase: 'midCorner', sec: 0.2, minKph: -4.4 } })));
  check('mid-corner: "+4 km/h mid-corner"', mid[1].focus && mid[1].focus.cue.minKphGain === 4 && mid[1].focus.short === '+4 km/h mid-corner', mid[1].focus && mid[1].focus.short);
  const thr = run([1, 2].map((n) => lap(n, { 1: { phase: 'exit', sec: 0.2, pickupM: 12 } })));
  check('exit, late pick-up: throttleShiftM −10 ("sooner")', thr[1].focus && thr[1].focus.cue.throttleShiftM === -10 && thr[1].focus.short === 'Throttle 10 m sooner', thr[1].focus && `${JSON.stringify(thr[1].focus.cue)} ${thr[1].focus.short}`);
  const ex = run([1, 2].map((n) => lap(n, { 1: { phase: 'exitRun', sec: 0.2, exitKph: -3 } })));
  check('exit run, same pick-up, slower exit: exitKphGain 3', ex[1].focus && ex[1].focus.cue.exitKphGain === 3 && ex[1].focus.short === '+3 km/h on exit', ex[1].focus && ex[1].focus.short);
  const noNum = run([1, 2].map((n) => lap(n, { 1: { phase: 'exit', sec: 0.2 } })));
  check('exit with nothing measurable: phase-only words', noNum[1].focus && noNum[1].focus.cue.phase === 'exit' && noNum[1].focus.short === 'Better exit' && /losing it on the exit/.test(noNum[1].focus.spoken), noNum[1].focus && noNum[1].focus.spoken);
  // Turn-in dominant, but a 10 m early brake is there: turn-in yields.
  const ti = run([1, 2].map((n) => lap(n, { 5: { phase: 'turnIn', sec: 0.2, brakeM: -10 } })));
  const t0 = ti[1].focus;
  check('turn-in only when nothing else fits (here: the brake point)', t0 && t0.cue.brakeShiftM === 10, t0 && JSON.stringify(t0.cue));
  // …and with only a mild braking loss as well, the braking number is used.
  const ti2 = run([1, 2].map((n) => lap(n, { 5: { phase: 'turnIn', sec: 0.2 } })));
  check('turn-in alone: "Smoother turn-in"', ti2[1].focus && ti2[1].focus.cue.phase === 'turnIn' && ti2[1].focus.short === 'Smoother turn-in', ti2[1].focus && ti2[1].focus.short);
}

console.log('\n3) Tow and car time are never coached');
{
  // C2 loses 0.3 s, all of it to a tow on the straight; C5 loses 0.1 s of driver time.
  const st = run([1, 2, 3].map((n) => lap(n, { 1: { tow: 0.3 }, 4: { phase: 'braking', sec: 0.1, brakeM: -8 } })));
  check('the towed corner is not the focus', st[1].focus && st[1].focus.cornerId === 'C5', st[1].focus && st[1].focus.cornerId);
  check('its window loss is the driver\'s part: zero', st[2].state.recent.every((r) => r.byCorner.C2 === 0), JSON.stringify(st[2].state.recent.map((r) => r.byCorner.C2)));
  const car = run([1, 2].map((n) => lap(n, { 1: { tow: 0.4, towKind: 'car', phase: 'exitRun', sec: 0.05 } })));
  check('a faster car\'s straight time is out too (0.05 s left < threshold: no focus)', car[1].focus === null, car[1].focus && car[1].focus.cornerId);
}

console.log('\n4) Invalid, unmeasured and outlier laps are skipped and do not count');
{
  const bad = { 2: { phase: 'braking', sec: 0.2, brakeM: -10 } };
  const s1 = run([lap(1, bad), lap(2, bad, { valid: false }), lap(3, bad, { noBreakdown: true })]);
  check('an invalid lap: no calls, not counted', s1[1].calls.length === 0 && s1[1].state.validLaps === 1);
  check('a lap with no breakdown: no calls, not counted', s1[2].calls.length === 0 && s1[2].state.validLaps === 1 && s1[2].focus === null);
  // Five clean laps around 90.2, then a 96 s lap with a big moment: an outlier.
  const base = [1, 2, 3, 4, 5].map((n) => lap(n, bad, { lapSec: 90.2 + (n % 2) * 0.1 }));
  const s2 = run([...base, lap(6, { 2: { phase: 'braking', sec: 0.2, brakeM: -10 }, 6: { phase: 'midCorner', sec: 5 } }, { lapSec: 95.6 })]);
  check('an outlier lap is skipped', s2[5].calls.length === 0 && s2[5].state.validLaps === 5, `validLaps ${s2[5].state.validLaps}`);
  check('and the outlier\'s 5 s corner is not in the window', s2[5].state.recent.every((r) => !(r.byCorner.C7 > 1)));
  // A lap one second off the median is a normal practice lap, not an outlier.
  const s3 = run([...base, lap(6, bad, { lapSec: 91.2 })]);
  check('a lap a second slower still counts', s3[5].state.validLaps === 6);
  // Early on (fewer than four laps) only a gross lap goes.
  const s4 = run([lap(1, bad, { lapSec: 90 }), lap(2, bad, { lapSec: 120 })]);
  check('a gross lap (30 s slower, lap 2) is skipped', s4[1].state.validLaps === 1);
  check('lapOutlier: 90 vs [90.1, 90.3, 90.2] is fine', C.lapOutlier(90, [90.1, 90.3, 90.2]) === false);
  check('lapOutlier: 99 vs [90.1, 90.3, 90.2, 90.4] is out', C.lapOutlier(99, [90.1, 90.3, 90.2, 90.4]) === true);
  // A repeated lap id is ignored.
  const one = lap(1, bad);
  const s5 = run([one, one]);
  check('the same lap twice counts once', s5[1].state.validLaps === 1 && s5[1].calls.length === 0);
}

console.log('\n5) minLaps and the two-of-three rule');
{
  const bad = { 2: { phase: 'braking', sec: 0.2, brakeM: -10 } };
  const s = run([lap(1, bad), lap(2, bad)], { minLaps: 3 });
  check('nothing before minLaps (3)', s.every((x) => x.calls.length === 0 && x.focus === null));
  const s1 = run([lap(1, bad)]);
  check('one lap against our own best: silent', s1[0].calls.length === 0 && s1[0].focus === null);
  const sb = run([lap(1, bad, { refKind: 'board', refLapId: 'board-1' })]);
  check('one lap against a leaderboard lap: may speak', sb[0].focus && sb[0].focus.cornerId === 'C3' && sb[0].calls.length === 1, sb[0].calls[0] && sb[0].calls[0].text);
  // One big lap in C1 then two clean: lost on 1 of 3 → never a focus, even though its mean is high.
  const once = run([lap(1, { 0: { phase: 'braking', sec: 0.6, brakeM: -20 } }), lap(2, {}), lap(3, {})]);
  check('lost on one lap of three: not a focus', once.every((x) => x.focus === null), JSON.stringify(once.map((x) => x.focus && x.focus.cornerId)));
  // C1 loses 0.1, 0.1, 0 and C2 loses 0.06 x3 → C1 qualifies (2 of 3, mean 0.067 < 0.08? no). Use 0.15.
  const two = run([lap(1, { 0: { phase: 'braking', sec: 0.15, brakeM: -10 } }), lap(2, {}), lap(3, { 0: { phase: 'braking', sec: 0.15, brakeM: -10 } })], { minLaps: 3 });
  check('lost on two of three, mean ≥ 0.08: a focus', two[2].focus && two[2].focus.cornerId === 'C1', two[2].focus && `${two[2].focus.cornerId} ${two[2].focus.lossSec}`);
  const small = run([1, 2, 3].map((n) => lap(n, { 0: { phase: 'braking', sec: 0.05, brakeM: -10 } })));
  check('a mean under minFocusLossSec: not a focus', small.every((x) => x.focus === null));
  const highest = run([1, 2].map((n) => lap(n, { 0: { phase: 'braking', sec: 0.1, brakeM: -10 }, 4: { phase: 'midCorner', sec: 0.25, minKph: -5 } })));
  check('the highest mean wins', highest[1].focus && highest[1].focus.cornerId === 'C5', highest[1].focus && highest[1].focus.cornerId);
}

console.log('\n6) new → improving → fixed → the next focus on the NEXT lap');
{
  const c4 = (sec) => ({ phase: 'braking', sec, brakeM: -10 });
  const c9 = { phase: 'midCorner', sec: 0.12, minKph: -3 };
  const laps = [
    lap(2, { 3: c4(0.2), 7: c9 }),
    lap(3, { 3: c4(0.2), 7: c9 }), // C4 picked (0.2 > 0.12)
    lap(4, { 3: c4(0.1), 7: c9 }), // improving: 0.1 s back
    lap(5, { 3: c4(0.03), 7: c9 }), // under on one
    lap(6, { 3: c4(0.02), 7: c9 }), // under on two → fixed
    lap(7, { 3: c4(0.02), 7: c9 }), // next focus: C8
  ];
  const s = collect(run(laps));
  check('lap 3: C4 is new', s[1].focus && s[1].focus.cornerId === 'C4' && s[1].focus.status === 'new');
  check('sinceLapNo is the lap it was picked on', s[1].focus && s[1].focus.sinceLapNo === 3);
  check('lap 4: improving, with a coachProgress', s[2].focus.status === 'improving' && s[2].calls.length === 1 && s[2].calls[0].kind === 'coachProgress', s[2].calls[0] && s[2].calls[0].text);
  check('…that says a tenth back', s[2].calls[0] && /a tenth/.test(s[2].calls[0].text), s[2].calls[0] && s[2].calls[0].text);
  check('lap 5: still improving, no second "better" for the same tenth', s[3].focus.status === 'improving' && s[3].calls.every((c) => c.kind !== 'coachProgress' || /a tenth and a half|found|back/.test(c.text)), s[3].calls.map((c) => c.text).join(' | '));
  const fx = s[4].calls.filter((c) => c.kind !== 'coachConsistency');
  check('lap 6: fixed, coachProgress "sorted"', s[4].focus.status === 'fixed' && fx.length === 1 && fx[0].kind === 'coachProgress' && /sorted|done/.test(fx[0].text), fx[0] && fx[0].text);
  check('C4 is in state.fixed', s[4].state.fixed.includes('C4'));
  check('the fixed lap does NOT pick the next focus', s[4].focus.cornerId === 'C4');
  check('lap 7: the next focus is C8, "Next one\'s" / "Next up"', s[5].focus && s[5].focus.cornerId === 'C8' && s[5].focus.status === 'new' && /^Next/.test(s[5].calls[0].text), s[5].calls[0] && s[5].calls[0].text);
  check('C4 is never picked again', !s.slice(5).some((x) => x.focus && x.focus.cornerId === 'C4'));
}

console.log('\n7) Holding: a reminder every second lap; nagged six laps → swapped');
{
  const c4 = { phase: 'braking', sec: 0.2, brakeM: -10 };
  const c7 = { phase: 'midCorner', sec: 0.1, minKph: -3 };
  const laps = Array.from({ length: 10 }, (_, i) => lap(i + 2, { 3: c4, 6: c7 }));
  const s = collect(run(laps, { consistencyEvery: 0, summaryEvery: 0 }));
  const said = s.map((x) => (x.calls[0] ? x.calls[0].text : ''));
  check('lap 2 of the window: new focus', s[1].focus.status === 'new' && /orner four/.test(said[1]), said[1]);
  check('next lap: holding, silent', s[2].focus.status === 'holding' && said[2] === '');
  check('the lap after: a short reminder', /orner four/.test(said[3]) && s[3].calls[0].kind === 'coachFocus' && C.SHORT_MAX >= s[3].focus.short.length, said[3]);
  check('and silent again', said[4] === '');
  const swapAt = s.findIndex((x) => x.focus && x.focus.cornerId === 'C7');
  check('after six laps without improving: swapped to corner seven', swapAt === 7, `swap at step ${swapAt}: ${said[swapAt]}`);
  check('"Let\'s leave corner four for now"', swapAt >= 0 && /eave corner four for now/.test(said[swapAt]), said[swapAt]);
  check('C4 is parked, not fixed', swapAt >= 0 && !s[swapAt].state.fixed.includes('C4') && s[swapAt].state.parked.some((p) => p.id === 'C4'));
  const lone = run(Array.from({ length: 10 }, (_, i) => lap(i + 2, { 3: c4 })), { consistencyEvery: 0, summaryEvery: 0 });
  check('no other corner worth it: the focus stays', lone.slice(1).every((x) => x.focus && x.focus.cornerId === 'C4'));
  check('one call at most per lap (no consistency here)', lone.every((x) => x.calls.length <= 1));
}

console.log('\n8) Consistency and summary timing');
{
  const tidy = Array.from({ length: 10 }, (_, i) => lap(i + 2, { 3: { phase: 'braking', sec: 0.2, brakeM: -10 } }, { lapSec: 90 + (i % 3) * 0.1 }));
  const s = collect(run(tidy));
  const cons = s.map((x, i) => [i, x.calls.find((c) => c.kind === 'coachConsistency')]).filter((x) => x[1]);
  check('a consistency call every 5 counted laps (laps 5 and 10)', cons.length === 2 && cons[0][0] === 4 && cons[1][0] === 9, cons.map((x) => x[0]).join(','));
  check('tight: "within … tenths"', cons[0] && /within (two|three) tenths/.test(cons[0][1].text) && /five/i.test(cons[0][1].text), cons[0] && cons[0][1].text);
  check('at most one focus call plus the consistency line', s.every((x) => x.calls.filter((c) => c.kind !== 'coachConsistency').length <= 1));
  const sums = s.map((x, i) => (x.wantSummary ? i : -1)).filter((i) => i >= 0);
  check('wantSummary every 5 counted laps', sums.join(',') === '4,9', sums.join(','));
  check('lastSummaryAt is set', s[9].state.lastSummaryAt === 10 && s[9].state.lastConsistencyAt === 10);
  // A skipped lap does not move them.
  const withBad = [...tidy.slice(0, 4), lap(6.5, {}, { valid: false }), tidy[4]];
  const s2 = run(withBad.map((l, i) => ({ ...l, lapId: `wb-${i}` })));
  check('an invalid lap does not trigger the 5th-lap calls', !s2[4].wantSummary && s2[5].wantSummary);
  // Loose: lap 3 has a big C6 moment.
  const loose = [0, 1, 2, 3, 4].map((i) => lap(i + 2, { 3: { phase: 'braking', sec: 0.2, brakeM: -10 }, 5: { phase: 'midCorner', sec: i === 2 ? 1.0 : 0 } }, { lapSec: 90 + (i === 2 ? 1.2 : 0.1 * i) }));
  const s3 = run(loose);
  const lc = s3[4].calls.find((c) => c.kind === 'coachConsistency');
  check('loose: "spread over a second", corner six varies most', lc && /over a second/.test(lc.text) && /corner six/.test(lc.text), lc && lc.text);
  const off = run(tidy, { consistencyEvery: 0, summaryEvery: 0 });
  check('consistencyEvery / summaryEvery 0 = never', off.every((x) => !x.wantSummary && !x.calls.some((c) => c.kind === 'coachConsistency')));
}

console.log('\n9) A new reference, the state, the words');
{
  const bad = { 2: { phase: 'braking', sec: 0.2, brakeM: -10 } };
  const s = run([lap(1, bad), lap(2, bad), lap(3, bad, { refLapId: 'ref-2' })]);
  check('a new session best as reference keeps the focus and the window', s[2].focus && s[2].focus.cornerId === 'C3' && s[2].state.recent.length === 3 && s[2].state.refLapId === 'ref-2');
  check('…and says nothing about it', s[2].calls.length === 0);
  const s2 = run([lap(4, bad, { refKind: 'board', refLapId: 'b-1' })], undefined, s[2].state);
  check('a leaderboard lap picked: the window starts over', s2[0].state.recent.length === 1 && s2[0].state.validLaps === 4);
  const st = s[1].state;
  const frozen = JSON.stringify(st);
  C.stepLiveCoach(st, lap(9, bad));
  check('stepLiveCoach never mutates the state it is given', JSON.stringify(st) === frozen);
  check('the state is plain JSON (round-trips)', JSON.stringify(JSON.parse(frozen)) === frozen);
  check('initLiveCoach', (() => { const i = C.initLiveCoach('k'); return i.sessionKey === 'k' && i.validLaps === 0 && i.focus === null && i.fixed.length === 0; })());
  check('defaults exported', C.LIVE_COACH_DEFAULTS.windowLaps === 3 && C.LIVE_COACH_DEFAULTS.minLaps === 2 && C.LIVE_COACH_DEFAULTS.minFocusLossSec === 0.08);
  check('engine object implements the contract', typeof C.liveCoachEngine.initLiveCoach === 'function' && typeof C.liveCoachEngine.stepLiveCoach === 'function');
  check('speakableCoachTime: tenth, tenth and a half, two tenths, half a second',
    C.speakableCoachTime(0.1) === 'a tenth' && C.speakableCoachTime(0.15) === 'a tenth and a half' && C.speakableCoachTime(0.21) === 'two tenths' && C.speakableCoachTime(0.5) === 'half a second',
    [0.1, 0.15, 0.21, 0.5, 0.8, 1.4].map(C.speakableCoachTime).join(' / '));
  check('speakableCorner: C4 → corner four, C23 → corner twenty-three', C.speakableCorner('C4') === 'corner four' && C.speakableCorner('C23') === 'corner twenty-three');
}

/** Every line must be speakable and short. */
function wordsOk(calls, shorts, label) {
  const kinds = calls.every((c) => LIVE_COACH_KINDS.includes(c.kind) && Number.isFinite(c.priority));
  check(`${label}: every call is a live-coach kind with a priority`, kinds);
  const long = calls.filter((c) => spokenWordCount(c.text) > MAX_SPOKEN_WORDS);
  check(`${label}: every line ≤ ${MAX_SPOKEN_WORDS} spoken words`, long.length === 0, long.map((c) => `${spokenWordCount(c.text)}: ${c.text}`).join(' | '));
  const ugly = calls.filter((c) => /\bC\d|Δ|km\/h|\d\.\d\d|\bm\b/.test(c.text));
  check(`${label}: nothing unspeakable ("C4", "km/h", "0.15", "m")`, ugly.length === 0, ugly.map((c) => c.text).join(' | '));
  const tooWide = shorts.filter((t) => !t || t.length > C.SHORT_MAX);
  check(`${label}: every card line ≤ ${C.SHORT_MAX} characters`, tooWide.length === 0, tooWide.join(' | '));
}

console.log('\n   The words of every synthetic call above');
wordsOk(allCalls, allShorts, 'synthetic');

/* ------------------------------- §10 real data ---------------------------- */

console.log('\n10) A real practice session, lap by lap, against the session best so far');
{
  const root = path.join(os.homedir(), '.apex-overlay');
  const lapDir = path.join(root, 'laps');
  const traceDir = path.join(root, 'traces');
  let sessions = [];
  try {
    const { listSessions } = require('../dist/telemetry/stintReview');
    sessions = fs.existsSync(lapDir) ? listSessions(lapDir) : [];
  } catch {
    sessions = [];
  }
  const { loadSession } = require('../dist/telemetry/stintReview');
  const { readTrace } = require('../dist/telemetry/lapTrace');
  const { lossInput } = require('../dist/telemetry/coachLoad');
  const { cornersForLap } = require('../dist/telemetry/cornerCatalog');
  const { lapLoss } = require('../dist/telemetry/timeLoss');
  const { findLap, mapKeyForLap } = require('../dist/telemetry/lapDetail');
  const cornerDir = path.join(__dirname, '..', 'data', 'corners');

  /** A session's laps with their traces, lap order. */
  function prepared(sum) {
    const s = loadSession(sum.id, lapDir);
    if (!s) return null;
    const laps = s.stints.flatMap((st) => st.laps).sort((a, b) => a.lapNo - b.lapNo);
    const rows = laps.map((l) => {
      const f = l.id && l.hasTrace ? readTrace(l.id, l.at, traceDir) : null;
      const input = f && f.trace ? lossInput(l.id, l.lapMs / 1000, f.trace) : null;
      const valid = l.clean === true && l.timed === true && !l.isOutLap && !l.isInLap && l.lapMs > 0 && !!input;
      return { l, input, valid };
    });
    return { s, rows };
  }

  const practice = sessions.filter((x) => /practice|test/i.test(x.sessionType || ''));
  const picked = [];
  for (const sum of practice) {
    if (picked.length >= 2) break;
    const p = prepared(sum);
    if (!p) continue;
    const n = p.rows.filter((r) => r.valid).length;
    if (n >= 8) picked.push({ sum, ...p, n });
  }
  if (!picked.length) {
    console.log('  SKIP  no practice session with 8+ traced valid laps on this machine');
  }

  /**
   * Steps one session lap by lap. `mode` 'bestSoFar': each lap against the
   * session's best lap BEFORE it (what the live service sees), printing every
   * lap; 'sessionBest': every lap against the session's best (the Practice
   * tab's reference), printing only what the radio says.
   */
  function replay(P, mode) {
    const { s, rows } = P;
    const L = s.trackLengthM;
    const best = rows.filter((r) => r.valid).sort((a, b) => a.l.lapMs - b.l.lapMs)[0];
    const rec = findLap(best.l.id, best.l.at, lapDir);
    const mapKey = rec ? mapKeyForLap(rec) : null;
    const { corners, source } = cornersForLap({ mapKey, trackLengthM: L, ref: best.input.cols, dir: cornerDir });
    const label = `${s.track} (${mode === 'bestSoFar' ? 'best so far' : 'session best'})`;
    console.log(`\n  ${s.track} · ${s.carClass} · ${P.sum.id.slice(0, 16)} · ${P.n} valid traced laps · ${corners.length} corners (${source}) · ${L} m · vs ${mode === 'bestSoFar' ? 'the best so far' : `the session best ${(best.l.lapMs / 1000).toFixed(3)}`}`);

    let state = C.initLiveCoach(P.sum.id);
    let refRow = mode === 'bestSoFar' ? null : best;
    const calls = [];
    const shorts = [];
    let focusLaps = 0;
    let badBrake = 0;
    let crowded = 0;
    let counted = 0;
    for (const r of rows) {
      const measurable = r.valid && refRow && refRow !== r;
      const breakdown = measurable ? lapLoss(r.input, refRow.input, corners, L) : null;
      const st = C.stepLiveCoach(state, {
        lapId: r.l.id || `n${r.l.lapNo}`,
        lapNo: r.l.lapNo,
        lapSec: r.l.lapMs / 1000,
        valid: r.valid,
        breakdown,
        trackLengthM: L,
        refKind: 'sessionBest',
        refLapId: refRow ? refRow.l.id : null,
        at: r.l.at,
      });
      state = st.state;
      calls.push(...st.calls);
      if (st.calls.filter((c) => c.kind !== 'coachConsistency').length > 1) crowded++;
      if (st.focus) {
        shorts.push(st.focus.short);
        focusLaps++;
        if (st.focus.cue.brakeShiftM !== undefined && Math.abs(st.focus.cue.brakeShiftM) > C.MAX_BRAKE_M) badBrake++;
      }
      const tag = !r.valid ? 'skip (not valid)' : !breakdown ? (refRow === r ? 'skip (is the ref)' : 'skip (no ref yet)') : st.state.validLaps === counted ? 'skip (outlier)' : `vs ${(refRow.l.lapMs / 1000).toFixed(3)}`;
      counted = st.state.validLaps;
      const card = st.focus ? `[${st.focus.cornerId} ${st.focus.status} · ${st.focus.short} · ${st.focus.lossSec.toFixed(2)} s]` : '';
      const said = st.calls.map((c) => `${c.kind}: "${c.text}"`).join('  +  ');
      if (mode === 'bestSoFar') {
        console.log(`    lap ${String(r.l.lapNo).padStart(2)}  ${(r.l.lapMs / 1000).toFixed(3)}  ${tag.padEnd(17)} ${card}${said ? `\n             radio → ${said}` : ''}${st.wantSummary ? '\n             (AI summary requested)' : ''}`);
      } else if (said) {
        console.log(`    lap ${String(r.l.lapNo).padStart(2)}  ${card}\n             radio → ${said}`);
      }
      // The session best so far becomes the reference for the next lap.
      if (mode === 'bestSoFar' && r.valid && (!refRow || r.l.lapMs < refRow.l.lapMs)) refRow = r;
    }
    check(`${label}: the coach found something to work on`, focusLaps > 0, `${focusLaps} laps with a focus, ${calls.length} calls`);
    check(`${label}: never more than one focus line per lap`, crowded === 0);
    check(`${label}: no braking advice over 25 m`, badBrake === 0);
    wordsOk(calls, shorts, label);
  }

  for (const P of picked) replay(P, 'bestSoFar');
  for (const P of picked) replay(P, 'sessionBest');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
