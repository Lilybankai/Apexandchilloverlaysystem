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
 * §1–§10 are the v1 engine's rules and run with `maxWork: 1` (the `run`
 * helper and the §10 replay pin it). Deliberately: coach v2 (2026-11-04)
 * changes the DEFAULT to a three-corner work list with lap-end lines, and
 * under that default these checks change on purpose — §6's "better" and
 * "sorted" are coachLapDebrief lines, not coachProgress; §7's second corner
 * is on the list from lap 2, so there is nothing to swap to and no
 * reminders (the lap-end line says "still costing" instead); §10 may say a
 * lap-end line AND a join line on one lap. maxWork 1 must stay v1, call for
 * call, so these sections are the v1 regression suite.
 *
 *   §11–§19 coach v2: the work list (selection, ranking, baselines, gains,
 *         fixed → runImproved → the next joins, per-corner anti-nag), the
 *         lap-end line, cue2 and the richer words, cueD and the approach
 *         line, approachCueAt's window, runDebrief / startRun, priorities, a
 *         v1 state migrating, and an end-to-end replay of the synthetic
 *         trace fixture (scripts/fixtures/livecoach-synth.js) through the
 *         real loss pipeline. §20 the real session again with v2 on,
 *         approach cues driven through each lap's own trace and timed
 *         against the trace's clock; prints the transcripts.
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
  for (const [p, sec] of Object.entries(spec.also || {})) phases[p] += sec; // v2: loss in a second phase
  if (spec.tow) phases.exitRun += spec.tow;
  const refBrake = spec.noRefBrake ? null : g.entryD - (spec.refBrakeBackM || 0) / L;
  const refPick = g.apexD + 0.005;
  return {
    id: `C${i + 1}`, index: i, entryD: g.entryD, apexD: g.apexD, exitD: g.exitD, runEndD: i + 1 < N_CORNERS ? GEO[i + 1].entryD : 1,
    lossSec: PHASES.reduce((a, p) => a + phases[p], 0),
    phases,
    mine: pts({
      brakeOnD: refBrake === null ? null : spec.brakeM !== undefined ? refBrake + spec.brakeM / L : refBrake,
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

/** Steps laps from a state; returns every step. v1 sections: maxWork 1 unless the options say otherwise. */
function run(laps, opts, state) {
  let s = state || C.initLiveCoach('test');
  const steps = [];
  const o = { maxWork: 1, ...(opts || {}) };
  for (const l of laps) {
    const st = C.stepLiveCoach(s, l, o);
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
      return { l, input, valid, trace: f && f.trace ? f.trace : null };
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
      }, { maxWork: 1 });
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

  /**
   * §20 coach v2 on the same real sessions, best-so-far as the live service
   * sees it, defaults (three corners, lap-end lines, approach cues). Each
   * lap is DRIVEN through its own trace at ~7 Hz with the state the coach had
   * after the lap before (what the service does on track), so the approach
   * cues land where they would, and each one is timed against the trace's
   * own clock: the words must end before the car reaches the cue point. An
   * in-lap gets the run debrief, then a new run.
   */
  function replay2(P) {
    const { s, rows } = P;
    const L = s.trackLengthM;
    const best = rows.filter((r) => r.valid).sort((a, b) => a.l.lapMs - b.l.lapMs)[0];
    const rec = findLap(best.l.id, best.l.at, lapDir);
    const mapKey = rec ? mapKeyForLap(rec) : null;
    const { corners } = cornersForLap({ mapKey, trackLengthM: L, ref: best.input.cols, dir: cornerDir });
    const label = `${s.track} (v2, best so far)`;
    console.log(`\n  ${s.track} · ${s.carClass} · ${P.sum.id.slice(0, 16)} · coach v2 (maxWork 3), approach cues driven through each lap's trace`);
    let state = C.initLiveCoach(P.sum.id);
    let refRow = null;
    const calls = [];
    const approaches = [];
    const debriefs = [];
    let measured = 0;
    let late = 0;
    let minSlack = Infinity;
    let crowded = 0;
    let printedApproach = 0;
    for (const r of rows) {
      const out = [];
      // On track: approach cues through this lap, from the state before it.
      if (r.trace && !r.l.isOutLap && !r.l.isInLap && Array.isArray(r.trace.d) && Array.isArray(r.trace.speedKph)) {
        const tr = r.trace;
        const cued = [];
        let nextAt = -Infinity;
        for (let k = 0; k < tr.d.length; k += 1) {
          const tk = tr.t[k];
          if (!(tk >= nextAt)) continue;
          nextAt = tk + 1 / 7;
          const cue = C.approachCueAt(state, { lapD: tr.d[k], speedKph: tr.speedKph[k], lapNo: r.l.lapNo, inPit: false, trackLengthM: L }, cued);
          if (!cue) continue;
          cued.push(cue.cornerId);
          approaches.push(cue.text);
          const f = state.work.find((w) => w.cornerId === cue.cornerId);
          let j = -1;
          for (let q = k + 1; q < tr.d.length; q += 1) if (tr.d[q] >= f.cueD) { j = q; break; }
          let slack = null;
          if (j > 0 && f.cueD > tr.d[k]) {
            slack = tr.t[j] - tk - (spokenWordCount(cue.text) / 2.8 + 0.6);
            measured++;
            minSlack = Math.min(minSlack, slack);
            if (slack < 0) late++;
          }
          if (printedApproach < 40) {
            out.push(`             approach @${tr.d[k].toFixed(3)} ${Math.round(tr.speedKph[k])} km/h, ${cue.etaSec.toFixed(1)} s to the brake point${slack !== null ? ` (words end ${slack.toFixed(1)} s early)` : ''} → "${cue.text}"`);
            printedApproach++;
          }
        }
      }
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
      if (st.calls.filter((c) => c.kind === 'coachLapDebrief').length > 1 || st.calls.filter((c) => c.kind === 'coachFocus').length > 1) crowded++;
      for (const c of st.calls) out.push(`             lap end → ${c.kind}: "${c.text}"`);
      if (r.l.isInLap) {
        const d = C.runDebrief(state);
        if (d) {
          debriefs.push(d);
          out.push(`             in-lap → coachRunDebrief: "${d.text}"`);
          state = C.startRun(state);
        }
      }
      const work = st.work && st.work.length ? st.work.map((f) => `${f.cornerId}${f.status === 'fixed' ? '✓' : ''} ${f.lossSec.toFixed(2)}${f.gainSec > 0 ? ` (+${f.gainSec.toFixed(2)})` : ''}`).join(' · ') : '';
      const tag = !r.valid ? (r.l.isInLap ? 'in-lap' : r.l.isOutLap ? 'out-lap' : 'not valid') : !breakdown ? 'no ref yet' : `vs ${(refRow.l.lapMs / 1000).toFixed(3)}`;
      if (out.length || work) console.log(`    lap ${String(r.l.lapNo).padStart(2)}  ${(r.l.lapMs / 1000).toFixed(3)}  ${tag.padEnd(12)} ${work ? `[${work}]` : ''}${out.length ? `\n${out.join('\n')}` : ''}`);
      if (r.valid && (!refRow || r.l.lapMs < refRow.l.lapMs)) refRow = r;
    }
    const d = C.runDebrief(state);
    if (d) {
      debriefs.push(d);
      console.log(`    end of session → coachRunDebrief: "${d.text}"`);
    }
    check(`${label}: approach cues fired`, approaches.length > 0, `${approaches.length} cues`);
    check(`${label}: every approach cue ends before the brake point on the trace's clock`, late === 0, `${measured} measured, ${late} late, tightest ${Number.isFinite(minSlack) ? minSlack.toFixed(2) : '–'} s spare`);
    check(`${label}: every approach ≤ ${C.APPROACH_MAX_WORDS} words, speakable`, approaches.every((t) => spokenWordCount(t) <= C.APPROACH_MAX_WORDS && !/\d|km\/h/.test(t)));
    check(`${label}: at most one lap-end line and one join line a lap`, crowded === 0);
    check(`${label}: run debriefs ≤ 3 sentences, ≤ ${C.RUN_DEBRIEF_MAX_WORDS} words, speakable`, debriefs.length > 0 && debriefs.every((x) => x.text.split(/(?<=\.)\s+/).filter(Boolean).length <= 3 && spokenWordCount(x.text) <= C.RUN_DEBRIEF_MAX_WORDS && !/\bC\d|\d/.test(x.text)), `${debriefs.length} debriefs`);
    check(`${label}: lap-end lines said`, calls.some((c) => c.kind === 'coachLapDebrief'), `${calls.filter((c) => c.kind === 'coachLapDebrief').length}`);
    wordsOk(calls, state.work.map((f) => f.short), label);
  }

  console.log('\n20) Coach v2 on the same real sessions');
  if (!picked.length) console.log('  SKIP  no practice session with 8+ traced valid laps on this machine');
  for (const P of picked) replay2(P);
}

/* ================================ coach v2 ================================ */

/** v2 steps: the options as given (default maxWork 3, lap-end lines on). */
function run2(laps, opts, state) {
  let s = state || C.initLiveCoach('test2');
  const steps = [];
  for (const l of laps) {
    const st = C.stepLiveCoach(s, l, opts);
    steps.push(st);
    s = st.state;
  }
  return steps;
}
const v2Calls = [];
const v2Shorts = [];
const v2Approaches = [];
function collect2(steps) {
  for (const st of steps) {
    v2Calls.push(...st.calls);
    for (const f of st.work || []) {
      v2Shorts.push(f.short);
      if (f.approach !== undefined) v2Approaches.push(f.approach);
    }
  }
  return steps;
}
const ids = (w) => (w || []).map((f) => f.cornerId).join(',');
const QUIET = { consistencyEvery: 0, summaryEvery: 0 };
const brk = (sec, m = -10, o = {}) => ({ phase: 'braking', sec, brakeM: m, ...o });
const mid = (sec, k = -5, o = {}) => ({ phase: 'midCorner', sec, minKph: k, ...o });

console.log('\n11) v2 work list: the costliest three, ranked; focus === work[0]; baselines');
{
  const spec = { 1: brk(0.3, -12), 4: mid(0.2), 6: { phase: 'exit', sec: 0.12, pickupM: 12 }, 7: brk(0.09, -8) };
  const s = collect2(run2([1, 2].map((n) => lap(n, spec)), QUIET));
  const w = s[1].work;
  check('lap 1 (minLaps 2): nothing yet', s[0].work.length === 0 && s[0].calls.length === 0 && s[0].focus === null);
  check('lap 2: the three costliest, costliest first', ids(w) === 'C2,C5,C7', ids(w));
  check('ranks 1, 2, 3', w.map((f) => f.rank).join() === '1,2,3');
  check('focus is work[0] (the same object in the state)', s[1].state.focus === s[1].state.work[0] && s[1].focus === s[1].work[0]);
  check('step.work is the state\'s work list', s[1].work === s[1].state.work);
  check('baselineSec = the window mean at the join; gainSec 0', w.every((f) => Math.abs(f.baselineSec - f.lossSec) < 1e-9 && f.gainSec === 0), w.map((f) => `${f.cornerId} ${f.baselineSec}/${f.gainSec}`).join(' '));
  check('lastLossSec is the last counted lap\'s', w[0].lastLossSec === 0.3 && w[1].lastLossSec === 0.2);
  check('the fourth corner (C8, 0.09 s) waits for a slot', !w.some((f) => f.cornerId === 'C8'));
  const fl = s[1].calls.filter((c) => c.kind === 'coachFocus');
  check('one call: the join line, naming all three', s[1].calls.length === 1 && fl.length === 1 && /^Working on corners two, five and seven\./.test(fl[0].text), fl[0] && fl[0].text);
  check('…and the costliest\'s cue with its number', fl[0] && /Two first: brake ten metres later/.test(fl[0].text), fl[0] && fl[0].text);
  check('every corner has its v2 fields (cueD, approach, rank)', w.every((f) => Number.isFinite(f.cueD) && typeof f.approach === 'string' && f.rank >= 1));
  const m2 = run2([1, 2].map((n) => lap(n, spec)), { ...QUIET, maxWork: 2 });
  check('maxWork 2: two corners', ids(m2[1].work) === 'C2,C5');
  const m1 = run2([1, 2].map((n) => lap(n, spec)), { ...QUIET, maxWork: 1 });
  check('maxWork 1: one corner, the v1 new-focus line (not "Working on")', ids(m1[1].work) === 'C2' && m1[1].calls.length === 1 && /corner two/i.test(m1[1].calls[0].text) && !/Working on/.test(m1[1].calls[0].text), m1[1].calls[0] && m1[1].calls[0].text);
  const tow = run2([1, 2].map((n) => lap(n, { 1: { tow: 0.4 }, 4: brk(0.15) })), QUIET);
  check('tow time never makes the list', ids(tow[1].work) === 'C5', ids(tow[1].work));
  const once = run2([lap(1, { 0: brk(0.6, -20), 3: brk(0.15) }), lap(2, { 3: brk(0.15) }), lap(3, { 3: brk(0.15) })], QUIET);
  check('lost on one lap of three: never on the list', once.every((x) => !x.work.some((f) => f.cornerId === 'C1')), once.map((x) => ids(x.work)).join(' | '));
  // Re-ranked by today's cost: C5 gets worse than C2.
  const rr = run2([lap(1, spec), lap(2, spec), lap(3, { ...spec, 1: brk(0.1, -12), 4: mid(0.5) }), lap(4, { ...spec, 1: brk(0.1, -12), 4: mid(0.5) })], QUIET);
  check('the list re-ranks by the window mean (C5 now costs most)', ids(rr[3].work) === 'C5,C2,C7' && rr[3].focus.cornerId === 'C5' && rr[3].work[0].rank === 1, ids(rr[3].work));
}

console.log('\n12) v2: improving → fixed (runImproved) → the next corner joins the NEXT lap');
{
  const rest = { 4: mid(0.2), 6: mid(0.15, -3), 7: brk(0.1, -8) };
  const L2 = (n, c2) => lap(n, { ...rest, 1: brk(c2) });
  const s = collect2(run2([L2(1, 0.3), L2(2, 0.3), L2(3, 0.15), L2(4, 0.03), L2(5, 0.02), L2(6, 0.02)], QUIET));
  const said = s.map((x) => x.calls.map((c) => `${c.kind}: ${c.text}`).join(' + '));
  check('lap 2: C2, C5, C7 join; C8 waits', ids(s[1].work) === 'C2,C5,C7');
  const d3 = s[2].calls.find((c) => c.kind === 'coachLapDebrief');
  check('lap 3: a coachLapDebrief "better through corner two"', s[2].calls.length === 1 && d3 && /Better through corner two/.test(d3.text), said[2]);
  check('…not a v1 coachProgress line', !s.some((x) => x.calls.some((c) => c.kind === 'coachProgress')));
  check('…with what is still costing', d3 && /(Five|five)'?s? still/.test(d3.text), d3 && d3.text);
  const c2at3 = s[2].work.find((f) => f.cornerId === 'C2');
  check('gainSec is the baseline minus the window mean (0.3 − 0.25)', c2at3 && Math.abs(c2at3.gainSec - 0.05) < 1e-9 && c2at3.status === 'improving', c2at3 && c2at3.gainSec);
  const d4 = s[3].calls.find((c) => c.kind === 'coachLapDebrief');
  check('lap 4: another step forward is said again ("better", with the time back)', d4 && /Better/.test(d4.text) && /tenths? (and a half )?back/.test(d4.text), said[3]);
  const f5 = s[4].work.find((f) => f.cornerId === 'C2');
  check('lap 5: C2 fixed, shown ticked at the end of the list', f5 && f5.status === 'fixed' && s[4].work[s[4].work.length - 1].cornerId === 'C2', ids(s[4].work));
  check('…the lap-end line says it is sorted', s[4].calls.some((c) => c.kind === 'coachLapDebrief' && /sorted/.test(c.text)), said[4]);
  check('…and the fixed corner has no approach cue', f5 && f5.approach === undefined);
  const ri = s[4].state.runImproved.find((x) => x.cornerId === 'C2');
  check('…it is in runImproved with the time won back (0.3 − 0.025)', ri && Math.abs(ri.gainSec - 0.275) < 1e-9, JSON.stringify(s[4].state.runImproved));
  check('…and in state.fixed', s[4].state.fixed.includes('C2'));
  check('…the fixed lap does not fill its slot yet', !s[4].work.some((f) => f.cornerId === 'C8'));
  check('lap 6: C2 has left, C8 joins with "Next one\'s corner eight"', !s[5].work.some((f) => f.cornerId === 'C2') && s[5].work.some((f) => f.cornerId === 'C8' && f.status === 'new') && s[5].calls.some((c) => c.kind === 'coachFocus' && /^Next (one's|up,) corner eight/.test(c.text)), said[5]);
  check('…and the join lap has no "still costing" sentence', !s[5].calls.some((c) => c.kind === 'coachLapDebrief' && /still/.test(c.text)), said[5]);
  check('a lap is never more than one lap-end line and one join line', s.every((x) => x.calls.filter((c) => c.kind === 'coachLapDebrief').length <= 1 && x.calls.filter((c) => c.kind === 'coachFocus').length <= 1));
  // lapDebrief off with a list: v1 lines, one per lap at most (plus a join).
  const off = run2([L2(1, 0.3), L2(2, 0.3), L2(3, 0.15), L2(4, 0.03), L2(5, 0.02), L2(6, 0.02)], { ...QUIET, lapDebrief: false });
  check('lapDebrief off: never a coachLapDebrief', !off.some((x) => x.calls.some((c) => c.kind === 'coachLapDebrief')));
  check('…v1 lines instead (coachProgress "better", then "sorted")', off[2].calls.some((c) => c.kind === 'coachProgress') && off[4].calls.some((c) => c.kind === 'coachProgress' && /sorted|done/.test(c.text)), off.map((x) => x.calls.map((c) => c.text).join(' + ')).join(' | '));
  check('…at most one corner line per lap plus a join', off.every((x) => x.calls.filter((c) => c.kind !== 'coachFocus' || !/^(Next|Working)/.test(c.text)).length <= 1));
}

console.log('\n13) v2: anti-nag per corner, and the "still costing" cadence');
{
  const spec = { 1: brk(0.3), 4: mid(0.2), 6: mid(0.15, -3), 7: brk(0.1, -8) };
  const s = collect2(run2(Array.from({ length: 14 }, (_, i) => lap(i + 1, spec)), QUIET));
  const said = s.map((x) => x.calls.map((c) => c.text).join(' + '));
  const swapAt = s.findIndex((x) => x.work.some((f) => f.cornerId === 'C8'));
  check(`held ${C.NAG_LAPS} counted laps without a step forward: the costliest is parked, C8 takes its slot`, swapAt === 7 && !s[swapAt].work.some((f) => f.cornerId === 'C2') && s[swapAt].state.parked.some((p) => p.id === 'C2'), `step ${swapAt}: ${said[swapAt]}`);
  check('"Let\'s leave corner two for now" (coachFocus)', swapAt >= 0 && s[swapAt].calls.some((c) => c.kind === 'coachFocus' && /eave corner two for now/.test(c.text)), said[swapAt]);
  check('C5 and C7 have nothing to swap to: they stay', swapAt >= 0 && ['C5', 'C7'].every((id) => s[swapAt].work.some((f) => f.cornerId === id)));
  check('C2 is parked, not fixed, and stays off the list while parked', s.slice(swapAt, swapAt + C.NAG_LAPS).every((x) => !x.work.some((f) => f.cornerId === 'C2')) && !s[13].state.fixed.includes('C2'));
  // Its parking over, C2 is a candidate again: the next corner nagged out (C5, held since lap 2) gives it its slot.
  const back = s.findIndex((x, i) => i > swapAt && x.work.some((f) => f.cornerId === 'C2'));
  check('…and comes back when another corner is parked for nagging', back === swapAt + C.NAG_LAPS && s[back].calls.some((c) => /eave corner (five|seven) for now/.test(c.text)), `step ${back}: ${said[back]}`);
  const stills = s.map((x, i) => [i, x.calls.find((c) => c.kind === 'coachLapDebrief')]).filter((x) => x[1]);
  check('holding laps: a lap-end "still costing" line, never on two laps running', stills.length >= 3 && stills.every((x, k) => k === 0 || x[0] - stills[k - 1][0] >= 2), stills.map((x) => `${x[0]}: ${x[1].text}`).join(' | '));
  const named = stills.map((x) => (/^Corner (\w+)/.exec(x[1].text) || [])[1]);
  check('…going round the list, not the top corner every time', new Set(named).size >= 2, named.join(','));
  check('…never on a join lap', stills.every((x) => !s[x[0]].calls.some((c) => c.kind === 'coachFocus')));
  // Nothing worth saying: no line.
  const flat = run2(Array.from({ length: 6 }, (_, i) => lap(i + 1, { 1: brk(0.3) })), QUIET);
  check('one corner holding: a lap-end line at most every second lap', flat.filter((x) => x.calls.length).length <= 3, flat.map((x) => x.calls.length).join(','));
}

console.log('\n14) v2: cue2 and the richer words');
{
  const both = { 2: brk(0.15, -10, { minKph: -4, also: { midCorner: 0.06 } }) };
  const s = run2([1, 2].map((n) => lap(n, both)), QUIET);
  const f = s[1].focus;
  check('main cue: brake 10 m later; cue2: carry 4 km/h more mid-corner', f && f.cue.brakeShiftM === 10 && f.cue2 && f.cue2.minKphGain === 4 && f.cue2.phase === 'midCorner', f && JSON.stringify([f.cue, f.cue2]));
  check('the join line says both, as numbers', s[1].calls[0] && /brake ten metres later and carry four kph more mid-corner/.test(s[1].calls[0].text), s[1].calls[0] && s[1].calls[0].text);
  const v1 = run([1, 2].map((n) => lap(n, both)));
  check('maxWork 1 too: "Corner three: brake ten metres later and carry four kph more…"', v1[1].calls[0] && /^Corner three: brake ten metres later and carry four kph more mid-corner\./.test(v1[1].calls[0].text), v1[1].calls[0] && v1[1].calls[0].text);
  check('the card line stays the main cue', f && f.short === 'Brake 10 m later');
  check('the approach cue stays one breath: the main cue only', f && f.approach === 'Corner three, brake ten metres later.', f && f.approach);
  const small = run2([1, 2].map((n) => lap(n, { 2: brk(0.15, -10, { minKph: -4, also: { midCorner: 0.01 } }) })), QUIET);
  check('no cue2 when its phase costs under 0.03 s', small[1].focus && small[1].focus.cue2 === undefined);
  const dis = run2([lap(1, { 2: brk(0.15, -10, { minKph: -4, also: { midCorner: 0.06 } }) }), lap(2, { 2: brk(0.15, -10, { minKph: 4, also: { midCorner: 0.06 } }) })], QUIET);
  check('no cue2 when the laps disagree on it', dis[1].focus && dis[1].focus.cue2 === undefined, dis[1].focus && JSON.stringify(dis[1].focus.cue2));
  const one = run2([lap(1, both, { refKind: 'board', refLapId: 'b' })], QUIET);
  check('no cue2 off one lap (a board lap on lap one)', one[0].focus && one[0].focus.cue.brakeShiftM === 10 && one[0].focus.cue2 === undefined);
  const ex = run2([1, 2].map((n) => lap(n, { 3: { phase: 'exit', sec: 0.2, pickupM: 12, exitKph: -6, also: { exitRun: 0.05 } } })), QUIET);
  check('exit: throttle sooner, and the exit speed as cue2 (a different kind)', ex[1].focus && ex[1].focus.cue.throttleShiftM === -10 && ex[1].focus.cue2 && ex[1].focus.cue2.exitKphGain === 6, ex[1].focus && JSON.stringify([ex[1].focus.cue, ex[1].focus.cue2]));
  // The lap-end line carries the numbers.
  const rest = { 4: mid(0.2), 6: mid(0.15, -3) };
  const lt = run2([lap(1, { ...rest, 1: brk(0.3) }), lap(2, { ...rest, 1: brk(0.3) }), lap(3, { ...rest, 1: brk(0.3) }), lap(4, { ...rest, 1: brk(0.3) })], QUIET);
  const ln = lt.map((x) => x.calls.find((c) => c.kind === 'coachLapDebrief')).find(Boolean);
  check('"still costing" says how much and what to change', ln && /still costing (a tenth|two tenths|three tenths)[^:]*: (brake|carry)/.test(ln.text), ln && ln.text);
}

console.log('\n15) v2: cueD (the reference brake point) and the approach line');
{
  const at = (spec) => run2([1, 2].map((n) => lap(n, { 3: spec })), QUIET)[1].focus;
  const a = at(brk(0.2, -10, { refBrakeBackM: 40 }));
  check('cueD is the reference brake onset (40 m before the entry)', a && Math.abs(a.cueD - (GEO[3].entryD - 40 / L)) < 1e-6, a && a.cueD);
  const b = at(brk(0.2, -10, { noRefBrake: true }));
  check('no reference brake point (a lift): cueD is the entry', b && Math.abs(b.cueD - GEO[3].entryD) < 1e-9, b && b.cueD);
  const c = at(brk(0.2, -10, { refBrakeBackM: -200 }));
  check('a "brake point" after the apex is not this corner\'s: the entry', c && Math.abs(c.cueD - GEO[3].entryD) < 1e-9, c && c.cueD);
  const d = at(brk(0.2, -10, { refBrakeBackM: 800 }));
  check(`one more than ${C.CUE_BACK_MAX_M} m before the entry is not either`, d && Math.abs(d.cueD - GEO[3].entryD) < 1e-9, d && d.cueD);
  // C1 whose braking starts before the line.
  const wrapLap = (n) => {
    const l = lap(n, { 0: brk(0.2) });
    const c0 = l.breakdown.corners[0];
    Object.assign(c0, { entryD: 0.004, apexD: 0.02, exitD: 0.03 });
    c0.ref.brakeOnD = 0.99;
    c0.mine.brakeOnD = 0.99 - 10 / L;
    return l;
  };
  const w = run2([wrapLap(1), wrapLap(2)], QUIET)[1].focus;
  check('C1 braking before the line: cueD wraps (0.99)', w && Math.abs(w.cueD - 0.99) < 1e-9 && w.cue.brakeShiftM === 10, w && `${w.cueD} ${JSON.stringify(w.cue)}`);
  check('approach: "Corner four, brake ten metres later."', a && a.approach === 'Corner four, brake ten metres later.', a && a.approach);
  // Corner 23 with an exit-speed cue: the longest words, still ≤ 8.
  const renamed = (n) => {
    const l = lap(n, { 3: { phase: 'exitRun', sec: 0.2, exitKph: -7 } });
    l.breakdown.corners[3].id = 'C23';
    return l;
  };
  const f23 = run2([renamed(1), renamed(2)], QUIET)[1].focus;
  check(`corner twenty-three: the approach still ≤ ${C.APPROACH_MAX_WORDS} words`, f23 && f23.approach && spokenWordCount(f23.approach) <= C.APPROACH_MAX_WORDS && /^Corner twenty-three, seven kph more on the exit\.$/.test(f23.approach), f23 && f23.approach);
  const rs = run2([lap(1, { 3: brk(0.2) }), lap(2, { 3: brk(0.2) }), lap(3, { 3: brk(0.03) }), lap(4, { 3: brk(0.2) })], QUIET);
  check('fine on the last lap (under the threshold): no approach, it rests', rs[2].focus && rs[2].focus.cornerId === 'C4' && rs[2].focus.approach === undefined);
  check('…losing again the lap after: the approach is back', rs[3].focus && typeof rs[3].focus.approach === 'string');
  check('lastLossSec tracks the last lap (0.03, then 0.2)', rs[2].focus.lastLossSec === 0.03 && rs[3].focus.lastLossSec === 0.2);
}

console.log('\n16) v2: approachCueAt — the window, the gates, the next corner only');
{
  const KPH = 200;
  const mps = KPH / 3.6;
  const T4 = 'Corner four, brake ten metres later.';
  const T5 = 'Corner five, carry four kph more.';
  const need = (t) => spokenWordCount(t) / 2.8 + 0.6 + C.APPROACH_MARGIN_SEC;
  const item = (id, cueD, approach, o = {}) => ({ cornerId: id, cornerNo: Number(id.slice(1)), entryD: cueD, apexD: cueD + 0.02, exitD: cueD + 0.03, lossSec: 0.2, cue: { phase: 'braking' }, short: 'x', spoken: 'x', status: 'holding', sinceLapNo: 2, cueD, approach, ...o });
  const base = { ...C.initLiveCoach('a'), validLaps: 3, minLaps: 2 };
  const st = (work) => ({ ...base, work, focus: work[0] || null });
  const pos = (cueD, eta, o = {}) => ({ lapD: cueD - (eta * mps) / L, speedKph: KPH, lapNo: 4, inPit: false, trackLengthM: L, ...o });
  const S = st([item('C4', 0.35, T4)]);
  const fire = C.approachCueAt(S, pos(0.35, need(T4) + 1), []);
  check('fires inside the window: corner, words, ETA', fire && fire.cornerId === 'C4' && fire.text === T4 && Math.abs(fire.etaSec - (need(T4) + 1)) < 0.02, fire && JSON.stringify(fire));
  check('the window is words / 2.8 + 0.6 s + the margin', C.approachCueAt(S, pos(0.35, need(T4) + 0.02), []) && !C.approachCueAt(S, pos(0.35, need(T4) - 0.05), []));
  check(`…to ${C.APPROACH_WINDOW_SEC} s more, not earlier`, C.approachCueAt(S, pos(0.35, need(T4) + C.APPROACH_WINDOW_SEC - 0.05), []) && !C.approachCueAt(S, pos(0.35, need(T4) + C.APPROACH_WINDOW_SEC + 0.1), []));
  check('too late to finish before the brake point: dropped, never late', C.approachCueAt(S, pos(0.35, 1.5), []) === null);
  check('in the pit lane: no', C.approachCueAt(S, pos(0.35, need(T4) + 1, { inPit: true }), []) === null);
  check(`under ${C.APPROACH_MIN_KPH} km/h: no`, C.approachCueAt(S, { ...pos(0.35, need(T4) + 1), speedKph: 55 }, []) === null);
  check('already cued this lap: no', C.approachCueAt(S, pos(0.35, need(T4) + 1), ['C4']) === null);
  check('approachCues off: no', C.approachCueAt(S, pos(0.35, need(T4) + 1), [], { approachCues: false }) === null);
  check('before minLaps: no', C.approachCueAt({ ...S, validLaps: 1 }, pos(0.35, need(T4) + 1), []) === null);
  check('against a board lap (minLaps 1 at the last step): from lap one', C.approachCueAt({ ...S, validLaps: 1, minLaps: 1 }, pos(0.35, need(T4) + 1), []) !== null);
  check('no track length: no', C.approachCueAt(S, { ...pos(0.35, need(T4) + 1), trackLengthM: 0 }, []) === null);
  check('a resting corner (no approach line): no', C.approachCueAt(st([item('C4', 0.35, undefined)]), pos(0.35, need(T4) + 1), []) === null);
  check('a fixed corner: no', C.approachCueAt(st([item('C4', 0.35, T4, { status: 'fixed' })]), pos(0.35, need(T4) + 1), []) === null);
  // Wrap at the line: C1's cue point at 0.02, the car at 0.99.
  const W = st([item('C1', 0.02, 'Corner one, brake ten metres later.')]);
  const wp = { lapD: 0.02 - (need(T4) + 1) * mps / L + 1, speedKph: KPH, lapNo: 4, inPit: false, trackLengthM: L };
  const wf = C.approachCueAt(W, wp, []);
  check('wraps at the line (car at 0.9x, cue point at 0.02)', wp.lapD > 0.9 && wf && wf.cornerId === 'C1', `${wp.lapD.toFixed(3)} ${wf && wf.etaSec}`);
  // Two corners close together: only the next may be cued.
  const two = st([item('C4', 0.35, T4), item('C5', 0.40, T5)]);
  const nearC4 = pos(0.35, 1.0); // C4 too late to cue, C5 (160 m further) inside its window
  const c5eta = (0.40 - nearC4.lapD) * L / mps;
  check('two close together: C5 waits while C4 is still ahead, even if its window is open', c5eta > need(T5) && c5eta < need(T5) + C.APPROACH_WINDOW_SEC && C.approachCueAt(two, nearC4, ['C4']) === null, `C5 eta ${c5eta.toFixed(2)}`);
  const past = { ...nearC4, lapD: 0.3505 };
  const p5 = C.approachCueAt(two, past, ['C4']);
  check('…past C4\'s cue point, C5 is cued if its words still fit', p5 && p5.cornerId === 'C5', p5 && JSON.stringify(p5));
  const tight = st([item('C4', 0.35, T4), item('C5', 0.36, T5)]);
  check('…and dropped when they do not', C.approachCueAt(tight, { ...nearC4, lapD: 0.3505 }, ['C4']) === null);
  // Drive a whole lap at 7 Hz: every cue once, all on time.
  const lapState = st([item('C2', 0.15, 'Corner two, brake ten metres later.'), item('C5', 0.45, T5), item('C7', 0.65, 'Corner seven, throttle ten metres sooner.')]);
  const cued = [];
  const fired = [];
  const kph = 180;
  for (let tt = 0; tt < 4000 / (kph / 3.6); tt += 1 / 7) {
    const p = { lapD: (tt * kph / 3.6) / L, speedKph: kph, lapNo: 5, inPit: false, trackLengthM: L };
    const cue = C.approachCueAt(lapState, p, cued);
    if (cue) {
      cued.push(cue.cornerId);
      fired.push(cue);
    }
  }
  check('a lap driven at 7 Hz: each work corner cued exactly once', fired.map((x) => x.cornerId).join() === 'C2,C5,C7', fired.map((x) => `${x.cornerId}@${x.etaSec}`).join(' '));
  check('…every cue with time to finish before its brake point', fired.every((x) => x.etaSec >= need(x.text) - 1e-9), fired.map((x) => `${x.etaSec} ≥ ${need(x.text).toFixed(2)}`).join(', '));
  // From a real step's state.
  const real = run2([1, 2].map((n) => lap(n, { 3: brk(0.2, -10, { refBrakeBackM: 40 }) })), QUIET)[1].state;
  const rf = C.approachCueAt(real, pos(real.work[0].cueD, need(T4) + 0.5), []);
  check('from a stepped state: the cue at the reference brake point', rf && rf.cornerId === 'C4' && rf.text === T4, rf && JSON.stringify(rf));
  check('approachCueAt never mutates the state', (() => { const fz = JSON.stringify(real); C.approachCueAt(real, pos(0.35, 4), []); return JSON.stringify(real) === fz; })());
}

console.log('\n17) v2: runDebrief and startRun');
{
  const L3 = (n, c2, c5, c7 = 0.15) => lap(n, { 1: brk(c2), 4: mid(c5), 6: mid(c7, -3), 7: brk(0.1, -8) });
  const s = run2([L3(1, 0.3, 0.2), L3(2, 0.3, 0.2), L3(3, 0.15, 0.2), L3(4, 0.03, 0.1), L3(5, 0.02, 0.08), L3(6, 0.02, 0.08)], QUIET);
  check('null before minLaps counted laps in the run', C.runDebrief(s[0].state) === null && C.runDebrief(C.initLiveCoach('x')) === null);
  const st6 = s[5].state;
  const frozen = JSON.stringify(st6);
  const d = C.runDebrief(st6);
  check('improved: C2 (fixed) and C5 (better than at the run start), with gains', d && d.improved.map((x) => x.cornerId).join() === 'C2,C5' && d.improved[0].gainSec > 0.25 && d.improved[1].gainSec >= C.IMPROVE_SEC, d && JSON.stringify(d.improved));
  check('still: the work corners still costing, costliest first, each with what is happening', d && d.still.map((x) => x.cornerId).join() === 'C7,C8,C5' && d.still.every((x) => x.lossSec >= 0.08 && /down|early|late|losing/.test(x.what)), d && JSON.stringify(d.still));
  check('laps = counted laps this run', d && d.laps === 6);
  const sentences = d ? d.text.split(/(?<=\.)\s+/).filter(Boolean) : [];
  check(`text: ≤ 3 sentences, ≤ ${C.RUN_DEBRIEF_MAX_WORDS} words`, d && sentences.length <= 3 && spokenWordCount(d.text) <= C.RUN_DEBRIEF_MAX_WORDS, d && `${sentences.length} / ${spokenWordCount(d.text)}: ${d.text}`);
  // Five is in both lists (better, still costing): "more to find", not a contradiction.
  check('text: "You\'ve improved corners two and five, about … in all. Still more to find in seven, …"', d && /^You've improved corners two and five, about [a-z ]+ in all\. Still more to find in seven, /.test(d.text), d && d.text);
  check('text is speakable (no "C7", no digits)', d && !/\bC\d|\d/.test(d.text), d && d.text);
  check('runDebrief never mutates the state', JSON.stringify(st6) === frozen);
  const fresh = C.startRun(st6);
  check('startRun: runImproved cleared, runStartLap = validLaps, the list kept', fresh.runImproved.length === 0 && fresh.runStartLap === 6 && ids(fresh.work) === ids(st6.work) && JSON.stringify(st6) === frozen);
  check('…and the new run has no debrief yet', C.runDebrief(fresh) === null);
  const more = run2([L3(7, 0.02, 0.08), L3(8, 0.02, 0.08)], QUIET, fresh);
  const d2 = C.runDebrief(more[1].state);
  check('two laps into the new run: nothing improved since, still to work on', d2 && d2.improved.length === 0 && d2.still.length >= 2 && /^No clear gains yet this run\. Still to work on:/.test(d2.text), d2 && d2.text);
  const one = run2([lap(1, { 3: brk(0.2, -10, { minKph: -4, also: { midCorner: 0.06 } }) }), lap(2, { 3: brk(0.2, -10, { minKph: -4, also: { midCorner: 0.06 } }) })], QUIET);
  const d3 = C.runDebrief(one[1].state);
  check('one corner still: names it, says what, then what to change and the worth', d3 && /^No clear gains yet this run\. Still to work on: corner four, braking about ten metres early\. Brake ten metres later and carry four kph more mid-corner, worth (two|three) tenths\.$/.test(d3.text), d3 && d3.text);
  const none = run2([lap(1, {}), lap(2, {})], QUIET);
  const d4 = C.runDebrief(none[1].state);
  check('nothing to say: "No corner stands out this run."', d4 && d4.improved.length === 0 && d4.still.length === 0 && /^No corner stands out/.test(d4.text), d4 && d4.text);
  check('engine object: approachCueAt, runDebrief, startRun', ['initLiveCoach', 'stepLiveCoach', 'approachCueAt', 'runDebrief', 'startRun'].every((k) => typeof C.liveCoachEngine[k] === 'function'));
}

console.log('\n18) v2: priorities, the kinds, a v1 state carrying on');
{
  const P = C.LIVE_COACH_PRIORITY;
  check('every live-coach kind has a priority', LIVE_COACH_KINDS.every((k) => Number.isFinite(P[k])));
  check('approach > run debrief > lap-end ≥ focus line', P.coachApproach > P.coachRunDebrief && P.coachRunDebrief > P.coachLapDebrief && P.coachLapDebrief >= P.coachFocus, JSON.stringify(P));
  const { keepHeld } = require('../dist/telemetry/radioGate');
  const held = (kind) => ({ text: kind, kind, urgency: 'normal', priority: P[kind], heldAtMs: 0, expiresAt: 1 });
  check('the one-slot hold: an approach cue displaces a held lap-end line', keepHeld(held('coachLapDebrief'), held('coachApproach')).kind === 'coachApproach');
  check('…and a lap-end line never displaces a held approach cue', keepHeld(held('coachApproach'), held('coachLapDebrief')).kind === 'coachApproach');
  check('…nor does the run debrief', keepHeld(held('coachApproach'), held('coachRunDebrief')).kind === 'coachApproach');
  check('calls carry their kind\'s priority', v2Calls.every((c) => c.priority === P[c.kind]));
  // A v1 state (focus + focusMeta, no work list) steps on as a one-corner list.
  const v1s = run([1, 2].map((n) => lap(n, { 3: brk(0.2) })))[1].state;
  const legacy = JSON.parse(JSON.stringify(v1s));
  legacy.focusMeta = legacy.workMeta[legacy.focus.cornerId];
  delete legacy.work;
  delete legacy.workMeta;
  delete legacy.runImproved;
  delete legacy.runStartLap;
  const on = C.stepLiveCoach(legacy, lap(3, { 3: brk(0.1) }), QUIET);
  check('a v1 state carries on: its focus is work[0], improving', on.work && on.work[0].cornerId === 'C4' && on.focus.cornerId === 'C4' && on.focus.status === 'improving', on.work && ids(on.work));
  check('…no focusMeta left behind', on.state.focusMeta === undefined && !!on.state.workMeta.C4);
}

console.log('\n   The words of every synthetic v2 call above');
wordsOk(v2Calls, v2Shorts, 'synthetic v2');
{
  const bad = v2Approaches.filter((t) => typeof t !== 'string' || spokenWordCount(t) > C.APPROACH_MAX_WORDS || /\bC\d|\d|km\/h/.test(t) || !/^Corner [a-z-]+, /.test(t));
  check(`synthetic v2: every approach line ≤ ${C.APPROACH_MAX_WORDS} words, "Corner <words>, …", speakable`, v2Approaches.length > 0 && bad.length === 0, bad.join(' | ') || `${v2Approaches.length} lines`);
}

console.log('\n19) The synthetic trace fixture through the real loss pipeline (any machine)');
{
  const { synthTrace } = require('./fixtures/livecoach-synth');
  const { lossInput } = require('../dist/telemetry/coachLoad');
  const { cornersForLap } = require('../dist/telemetry/cornerCatalog');
  const { lapLoss } = require('../dist/telemetry/timeLoss');
  const SL = 4000;
  const ref = synthTrace();
  const refIn = lossInput('ref', ref.lapSec, ref);
  const { corners } = cornersForLap({ mapKey: null, trackLengthM: SL, ref: refIn.cols, catalog: null });
  check('the fixture has two corners found by speed', corners.length === 2, corners.map((c) => `${c.id}@${c.entryD.toFixed(3)}`).join(' '));
  // Slow in both corners, then the first one comes good.
  const plan = [
    [100, 80], [100, 80], [101, 80], [109, 80], [110, 80], [110, 81], [110, 82],
  ];
  let state = C.initLiveCoach('synth');
  const lines = [];
  let fires = 0;
  let late = 0;
  let prevTrace = null;
  for (let i = 0; i < plan.length; i += 1) {
    const tr = synthTrace({ corners: [{ d: 0.3, minKph: plan[i][0] }, { d: 0.7, minKph: plan[i][1] }] });
    // Drive this lap with the state from the last one (what the service does).
    const cued = [];
    let nextAt = 0;
    for (let k = 0; k < tr.d.length; k += 1) {
      if (tr.t[k] < nextAt) continue;
      nextAt = tr.t[k] + 1 / 7;
      const cue = C.approachCueAt(state, { lapD: tr.d[k], speedKph: tr.speedKph[k], lapNo: i + 1, inPit: false, trackLengthM: SL }, cued);
      if (!cue) continue;
      cued.push(cue.cornerId);
      fires++;
      const f = state.work.find((w) => w.cornerId === cue.cornerId);
      const j = tr.d.findIndex((x, q) => q > k && x >= f.cueD);
      const slack = j > 0 ? tr.t[j] - tr.t[k] - (spokenWordCount(cue.text) / 2.8 + 0.6) : Infinity;
      if (slack < 0) late++;
      lines.push(`    lap ${i + 1} @${tr.d[k].toFixed(3)} ${Math.round(tr.speedKph[k])} km/h → coachApproach "${cue.text}" (ETA ${cue.etaSec} s, words end ${slack.toFixed(1)} s before the brake point)`);
    }
    const input = lossInput(`s${i}`, tr.lapSec, tr);
    const bd = lapLoss(input, refIn, corners, SL);
    const st = C.stepLiveCoach(state, { lapId: `s${i}`, lapNo: i + 1, lapSec: 90 + tr.lapSec - ref.lapSec, valid: true, breakdown: bd, trackLengthM: SL, refKind: 'sessionBest', refLapId: 'ref', at: '' }, QUIET);
    state = st.state;
    for (const c of st.calls) lines.push(`    lap ${i + 1} end → ${c.kind} "${c.text}"`);
    prevTrace = tr;
  }
  const d = C.runDebrief(state);
  lines.push(`    in-lap → coachRunDebrief "${d && d.text}"`);
  for (const l of lines) console.log(l);
  check('both corners joined the list', state.work.length >= 1 && (state.fixed.includes('C1') || state.work.some((f) => f.cornerId === 'C1')) && state.work.some((f) => f.cornerId === 'C2'), ids(state.work));
  check('approach cues fired on the synthetic laps', fires >= 2, `${fires}`);
  check('…every one finished before the reference brake point (trace clock)', late === 0, `${late} late`);
  check('C1 came good: improved in the run debrief', d && d.improved.some((x) => x.cornerId === 'C1'), d && JSON.stringify(d.improved));
  check('C2 is still to work on, with a speed number', d && d.still.some((x) => x.cornerId === 'C2' && /kph|losing/.test(x.what)), d && JSON.stringify(d.still));
  void prevTrace;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
