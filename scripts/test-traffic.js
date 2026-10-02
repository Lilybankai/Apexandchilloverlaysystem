/**
 * scripts/test-traffic.js — timed traffic calls (src/telemetry/trafficCalls.ts).
 * -----------------------------------------------------------------------------
 * "Timed traffic calls would be very, very helpful, but we need to make sure it
 * is very accurate with the information provided to the driver." — Carl.
 *
 * Three modes:
 *
 *   node scripts/test-traffic.js
 *       The unit suite: synthetic frame sequences through the real
 *       EngineerTriggers + phrasebook. A steady approach fires once, at the
 *       right time, with the right number; noise, pit cars, same-class cars, a
 *       start/finish wrap, a car already alongside, and a blue-flag car never
 *       produce a (second) call.
 *
 *   node scripts/test-traffic.js --replay <recording.jsonl>
 *       Accuracy against a REAL recording (scripts/record-session.js):
 *       (1) what the shipped gates would have said, per lap, with each call
 *           checked against what the following frames show;
 *       (2) the estimator with the class gate OFF (every car), so even a
 *           single-class recording measures predicted-vs-actual contact time.
 *
 *   node scripts/test-traffic.js --inject <recording.jsonl> [--amp 0.3] [--window 6,10]
 *       Real LMU gap noise (each recorded car's residual around its own trend)
 *       laid over synthetic multiclass approaches of known closing rate — the
 *       only multiclass evidence until a multiclass race is recorded. `--amp`
 *       adds a ± variation of the TRUE closing rate around the lap (fraction).
 */

'use strict';

const fs = require('node:fs');

const T = require('../dist/telemetry/trafficCalls');
const { EngineerTriggers } = require('../dist/telemetry/triggers');
const { phraseForCue } = require('../dist/telemetry/engineerPhrases');

const UNKNOWN = -1;
const PLAYER = 1;
const argv = process.argv.slice(2);
if (argv.includes('--replay')) {
  replay(argv[argv.indexOf('--replay') + 1]);
  process.exit(0);
}
if (argv.includes('--inject')) {
  inject(argv[argv.indexOf('--inject') + 1]);
  process.exit(0);
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
}

/* -------------------------------------------------------------------------- */
/*  Scene building                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One frame. `cars`: [{ slot, cls, gap, pace?, pit?, timed?, yieldTo?, name? }].
 * `timed: false` = the provider fell back to its road-distance gap for this
 * car (standings leader-gap unknown).
 */
function frame(t, { cls = 'GT3', pace = 100, cars = [], lap = null, radar, phase = 'green', playerPit = false } = {}) {
  const standings = [
    {
      slotId: PLAYER, position: 5, classPosition: 2, driverName: 'Me Player', carClass: cls,
      bestLapSec: pace, lastLapSec: pace, lapsCompleted: 6, gapToLeaderSec: 40,
      inPit: playerPit, isPlayer: true,
      ...(lap ? { lastSector1Sec: lap.s1, lastSector2Sec: lap.s2, lastLapSec: lap.len } : {}),
    },
  ];
  const relative = [
    { slotId: PLAYER, position: 5, driverName: 'Me Player', carClass: cls, relativeGapSec: 0,
      lapsDifference: 0, inPit: playerPit, isPlayer: true },
  ];
  cars.forEach((c, i) => {
    standings.push({
      slotId: c.slot, position: 10 + i, classPosition: 1, driverName: c.name || `Driver ${c.slot}`,
      carClass: c.cls, bestLapSec: c.pace ?? UNKNOWN, lastLapSec: c.pace ?? UNKNOWN, lapsCompleted: 6,
      gapToLeaderSec: c.timed === false ? UNKNOWN : 20 + i, inPit: !!c.pit, isPlayer: false,
    });
    relative.push({
      slotId: c.slot, position: 10 + i, driverName: c.name || `Driver ${c.slot}`, carClass: c.cls,
      relativeGapSec: Math.round(c.gap * 100) / 100, lapsDifference: c.lapsDifference ?? 0,
      inPit: !!c.pit, isPlayer: false, yieldTo: !!c.yieldTo,
    });
  });
  return {
    schemaVersion: 1, source: 'lmu', timestamp: Math.round(t * 1000), connected: true,
    session: { type: 'race', phase, flag: phase === 'green' ? 'green' : 'yellow', track: 'Test Ring',
      numCars: 20, currentLap: 7, lapsRemaining: 20, notStarted: false },
    player: { slotId: PLAYER, position: 5, lap: { current: lap ? lap.cur(t) : 30, last: pace, best: pace, delta: UNKNOWN, sector: 1 } },
    standings,
    relative,
    ...(radar ? { radar: radar(t) } : {}),
  };
}

/** Drive the real trigger layer; returns every cue with the frame it came on. */
function run(frames) {
  const trig = new EngineerTriggers();
  const cues = [];
  for (const f of frames) {
    const cue = trig.update(f);
    if (cue) cues.push({ cue, frame: f });
  }
  return { trig, cues, kinds: () => cues.map((c) => c.cue.kind) };
}

/** 10 Hz frames from t0 to t1 (seconds). */
function seq(t0, t1, mk) {
  const out = [];
  for (let t = t0; t <= t1 + 1e-9; t += 0.1) out.push(mk(Math.round(t * 10) / 10));
  return out;
}

/** The number spoken in a traffic line. */
const spokenSecs = (line) => {
  const m = /about (\d+)/.exec(line || '');
  return m ? Number(m[1]) : null;
};
const words = (line) => line.replace(/—/g, ' ').split(/\s+/).filter(Boolean).length;

/* -------------------------------------------------------------------------- */
/*  1) A steady approach fires once, at the right time, with the right number  */
/* -------------------------------------------------------------------------- */

console.log('\n1) Steady approaches — one call, the right number');

{
  // A Hypercar (88 s) reeling in a GT3 player (100 s): 0.12 s/s, from 5 s back.
  const R = 0.12;
  const gapAt = (t) => 5 - R * t;
  const contactT = (5 - T.CONTACT_GAP_SEC) / R; // gap reaches "with you"
  const r = run(seq(0, 40, (t) => frame(t, {
    cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -gapAt(t) }],
  })));
  const traffic = r.cues.filter((c) => c.cue.kind === 'trafficBehind');
  check('a faster class closing steadily is called exactly once', traffic.length === 1, r.kinds().join() || 'none');
  const c = traffic[0];
  if (c) {
    const emitT = c.cue.atMs / 1000;
    const trueTtc = contactT - emitT;
    check('…emitted inside the window (after the coalesce)',
      trueTtc >= T.CALL_MIN_TTC_SEC - 1.6 && trueTtc <= T.CALL_MAX_TTC_SEC, trueTtc.toFixed(1));
    const line = phraseForCue(c.cue, c.frame, 0);
    const n = spokenSecs(line);
    const heard = trueTtc - T.SPEECH_LEAD_SEC;
    check('…and the number is right when it is heard (±1 s)', n !== null && Math.abs(n - heard) <= 1,
      `${line} | true ${heard.toFixed(1)} s`);
    check('…in the class drivers use, as time-to-contact, never a gap',
      /^Hypercar behind, with you in about \d+ seconds\.$/.test(line), line);
    check('…facts carry the slot and the contact moment',
      c.cue.triggers[0].facts.slots === '7' && typeof c.cue.triggers[0].facts.contactAtMs === 'number',
      JSON.stringify(c.cue.triggers[0].facts));
  }
}

{
  // The player in a Hypercar (88 s) catching a GT3 (100 s) ahead.
  const R = 0.12;
  const r = run(seq(0, 40, (t) => frame(t, {
    cls: 'HYPERCAR', pace: 88,
    cars: [{ slot: 9, cls: 'GT3', pace: 100, gap: 5 - R * t }],
  })));
  const traffic = r.cues.filter((c) => c.cue.kind === 'trafficAhead');
  check('slower-class traffic ahead is called exactly once', traffic.length === 1, r.kinds().join() || 'none');
  const line = traffic[0] && phraseForCue(traffic[0].cue, traffic[0].frame, 0);
  check('…"GT3 ahead, you\'ll be on it in about N seconds."', /^GT3 ahead, you'll be on it in about \d+ seconds\.$/.test(line || ''), line);
}

{
  // A slow differential (LMP2 on a Hypercar, ~4%) is tracked but never timed:
  // the countdown error grows as 1/rate.
  const r = run(seq(0, 90, (t) => frame(t, {
    cls: 'LMP2', pace: 100,
    cars: [{ slot: 4, cls: 'HYPERCAR', pace: 96, gap: -(4 - 0.04 * t) }],
  })));
  check('a 0.04 s/s approach is never timed out loud', !r.kinds().some((k) => k.startsWith('traffic')), r.kinds().join() || 'none');
}

/* -------------------------------------------------------------------------- */
/*  2) Noise never fires                                                       */
/* -------------------------------------------------------------------------- */

console.log('\n2) A closing rate that is noisy or jumping never fires');

{
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const r = run(seq(0, 40, (t) => frame(t, {
    cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -(5 - 0.12 * t + rnd() * 0.7) }],
  })));
  check('white noise ±0.35 s on the gap → silence', !r.kinds().includes('trafficBehind'), r.kinds().join() || 'none');
}

{
  // Square-wave steps (a feed flicking between its two gap sources).
  const r = run(seq(0, 40, (t) => frame(t, {
    cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -(5 - 0.12 * t + (Math.floor(t / 2) % 2 ? 0.35 : -0.35)) }],
  })));
  check('a gap stepping ±0.35 s every 2 s → silence', !r.kinds().includes('trafficBehind'), r.kinds().join() || 'none');
}

{
  // Closing that stops and starts: fast for 6 s, then stalled for 6 s.
  let g = 6;
  const r = run(seq(0, 60, (t) => {
    if (t > 0) g -= (Math.floor(t / 6) % 2 ? 0 : 0.3) * 0.1;
    return frame(t, { cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -Math.max(0.3, g) }] });
  }));
  check('closing that keeps stopping and starting → silence', !r.kinds().includes('trafficBehind'), r.kinds().join() || 'none');
}

{
  // Lap times say ~1% — the measured 0.12 s/s is a corner-phase artefact.
  const r = run(seq(0, 40, (t) => frame(t, {
    cars: [{ slot: 7, cls: 'Hypercar', pace: 99, gap: -(5 - 0.12 * t) }],
  })));
  check('a rate the lap times disagree with → silence', !r.kinds().includes('trafficBehind'), r.kinds().join() || 'none');
}

{
  const r = run(seq(0, 40, (t) => frame(t, {
    cars: [{ slot: 7, cls: 'Hypercar', gap: -(5 - 0.12 * t) }], // no lap time for the car
  })));
  check('no lap time to cross-check against → silence', !r.kinds().includes('trafficBehind'), r.kinds().join() || 'none');
}

/* -------------------------------------------------------------------------- */
/*  3) Cars that are never traffic                                             */
/* -------------------------------------------------------------------------- */

console.log('\n3) Pit lane, same class, unknown class, FCY, the player in the pits');

{
  const r = run(seq(0, 40, (t) => frame(t, {
    cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -(5 - 0.12 * t), pit: true }],
  })));
  check('a car in the pit lane is ignored', !r.kinds().some((k) => k.startsWith('traffic')), r.kinds().join() || 'none');
}
{
  const r = run(seq(0, 40, (t) => frame(t, {
    cars: [{ slot: 7, cls: 'GT3', pace: 88, gap: -(5 - 0.12 * t) }],
  })));
  check('a same-class car (a rival, not traffic) is ignored', !r.kinds().some((k) => k.startsWith('traffic')), r.kinds().join() || 'none');
}
{
  const r = run(seq(0, 40, (t) => frame(t, {
    cars: [{ slot: 7, cls: 'SuperMod', pace: 88, gap: -(5 - 0.12 * t) }],
  })));
  check('an unrecognised class is ignored', !r.kinds().some((k) => k.startsWith('traffic')), r.kinds().join() || 'none');
}
{
  const r = run(seq(0, 40, (t) => frame(t, {
    phase: t > 5 ? 'fullCourseYellow' : 'green',
    cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -(5 - 0.12 * t) }],
  })));
  check('no traffic calls under a full-course yellow', !r.kinds().some((k) => k.startsWith('traffic')), r.kinds().join() || 'none');
}
{
  const r = run(seq(0, 40, (t) => frame(t, {
    playerPit: true,
    cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -(5 - 0.12 * t) }],
  })));
  check('no traffic calls while the player is in the pit lane', !r.kinds().some((k) => k.startsWith('traffic')), r.kinds().join() || 'none');
}

/* -------------------------------------------------------------------------- */
/*  4) Discontinuities: the start/finish wrap, a source switch                 */
/* -------------------------------------------------------------------------- */

console.log('\n4) A start/finish wrap or a gap-source switch is never read as closing');

{
  // A GT3 ahead holding 3.0 s, then the line: the gap reads 1.5 s and holds.
  // Without the reset, a 10 s fit across that step is a 0.15 s/s "approach".
  const tr = new T.TrafficCallTracker();
  const calls = [];
  let estAfter = null;
  for (let t = 0; t <= 30; t = Math.round((t + 0.1) * 10) / 10) {
    const gap = t < 12 ? 3.0 : 1.5;
    const f = frame(t, { cls: 'HYPERCAR', pace: 88, cars: [{ slot: 9, cls: 'GT3', pace: 100, gap, lapsDifference: t < 12 ? 0 : -1 }] });
    calls.push(...tr.update(f, f.timestamp));
    if (t === 15) estAfter = tr.currentEstimates().get(9) || null;
  }
  check('the wrap restarts the history (no estimate 3 s later)', estAfter === null, JSON.stringify(estAfter));
  check('…and no call comes of it', calls.length === 0, calls.map((c) => c.detail).join(' | '));
}
{
  // A sign flip mid-approach (the car crossed to the other side) also resets.
  const tr = new T.TrafficCallTracker();
  let est = null;
  for (let t = 0; t <= 14; t = Math.round((t + 0.1) * 10) / 10) {
    const gap = t < 10 ? -(5 - 0.12 * t) : 3.5;
    const f = frame(t, { cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap }] });
    tr.update(f, f.timestamp);
    if (t === 12) est = tr.currentEstimates().get(7) || null;
  }
  check('a faster car that is now AHEAD is no longer tracked', est === null, JSON.stringify(est));
}
{
  // The provider switching this car from sim timing to its road model (the
  // car got lapped by the overall leader) changes the gap's scale.
  const tr = new T.TrafficCallTracker();
  let est = null;
  for (let t = 0; t <= 20; t = Math.round((t + 0.1) * 10) / 10) {
    const f = frame(t, { cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -(5 - 0.12 * t), timed: t < 12 }] });
    tr.update(f, f.timestamp);
    if (t === 15) est = tr.currentEstimates().get(7) || null;
  }
  check('a gap-source switch restarts the history', est === null, JSON.stringify(est));
}

/* -------------------------------------------------------------------------- */
/*  5) Grouping, and the "first" in "first with you" staying true              */
/* -------------------------------------------------------------------------- */

console.log('\n5) Cars close together are one line');

{
  const R = 0.12;
  const r = run(seq(0, 40, (t) => frame(t, {
    cls: 'HYPERCAR', pace: 88,
    cars: [
      { slot: 9, cls: 'GT3', pace: 100, gap: 5 - R * t },
      { slot: 10, cls: 'GT3', pace: 100, gap: 5.6 - R * t },
    ],
  })));
  const traffic = r.cues.filter((c) => c.cue.kind === 'trafficAhead');
  check('two GT3s nose to tail → ONE call', traffic.length === 1, r.kinds().join() || 'none');
  const c = traffic[0];
  const line = c && phraseForCue(c.cue, c.frame, 0);
  check('…naming both', c && c.cue.triggers[0].facts.count === 2 && c.cue.triggers[0].facts.slots === '9,10',
    c && JSON.stringify(c.cue.triggers[0].facts));
  check('…"Two GT3s ahead, you\'ll be on them in about N seconds."',
    /^Two GT3s ahead, you'll be on them in about \d+ seconds\.$/.test(line || ''), line);
}

{
  // A nearer slower car that is NOT steady (it just joined from the pits)
  // would make "first" a lie — hold the call while it is there.
  const tr = new T.TrafficCallTracker();
  const calls = [];
  for (let t = 0; t <= 30; t = Math.round((t + 0.1) * 10) / 10) {
    const cars = [{ slot: 9, cls: 'GT3', pace: 100, gap: 5 - 0.12 * t }];
    if (t >= 20) cars.push({ slot: 11, cls: 'GT3', pace: 100, gap: 0.9 }); // appears nearer, no history
    const f = frame(t, { cls: 'HYPERCAR', pace: 88, cars });
    for (const c of tr.update(f, f.timestamp)) {
      calls.push(c);
      for (const s of c.slots) tr.markCalled(s, f.timestamp);
    }
  }
  check('an un-timed car nearer than the lead blocks the call', calls.length === 0, calls.map((c) => c.detail).join(' | '));
}

/* -------------------------------------------------------------------------- */
/*  6) Already there: the radar                                                */
/* -------------------------------------------------------------------------- */

console.log('\n6) A car the radar already shows is never called');

{
  const r = run(seq(0, 40, (t) => frame(t, {
    cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -(5 - 0.12 * t) }],
    radar: () => [{ slotId: 7, lateralM: -2, longitudinalM: -4, distanceM: 4.5, alongside: true }],
  })));
  check('alongside on the radar → no call', !r.kinds().includes('trafficBehind'), r.kinds().join() || 'none');
}
{
  // A cue phrased after the car has drawn alongside says nothing.
  const facts = { count: 1, carClass: 'HYPERCAR', contactAtMs: 20_000, slots: '7', fast: false };
  const late = T.trafficSentence('trafficBehind', facts, 10_000, 0, [{ slotId: 7, longitudinalM: -3, alongside: true }]);
  check('…and the phrase layer re-checks the radar before speaking', late === null, String(late));
  const stale = T.trafficSentence('trafficBehind', facts, 16_000, 0);
  check('a countdown held until it is stale is dropped, not spoken late', stale === null, String(stale));
}

/* -------------------------------------------------------------------------- */
/*  7) The blue flag and the timed call never name the same car twice          */
/* -------------------------------------------------------------------------- */

console.log('\n7) yieldTo and trafficBehind agree — one call per car');

{
  // Provider-style: yieldTo lights once the faster car is within 3 s.
  const R = 0.12;
  const r = run(seq(0, 40, (t) => {
    const g = 5 - R * t;
    return frame(t, { cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -g, yieldTo: g <= 3 }] });
  }));
  const k = r.kinds();
  check('the blue flag names the Hypercar…', k.filter((x) => x === 'yieldTo').length === 1, k.join() || 'none');
  check('…and the timed call does NOT name it again', !k.includes('trafficBehind'), k.join() || 'none');
}

{
  // A Hypercar train: the blue flag names the first, the timed call the second.
  const R = 0.12;
  const r = run(seq(0, 70, (t) => {
    const a = 5 - R * t;
    const b = 7 - R * t;
    const cars = [];
    if (a > -1) cars.push({ slot: 7, cls: 'Hypercar', pace: 88, gap: -a, yieldTo: a <= 3 && a > 0 });
    if (a <= 0) cars.push({ slot: 7, cls: 'Hypercar', pace: 88, gap: -a }); // passed: now ahead
    cars.push({ slot: 8, cls: 'Hypercar', pace: 88, gap: -b, yieldTo: b <= 3 && b > 0 });
    return frame(t, { cars: cars.filter((c) => c.gap !== 0) });
  }));
  const k = r.kinds();
  const timed = r.cues.find((c) => c.cue.kind === 'trafficBehind');
  check('a second car in the train gets the timed call', !!timed && timed.cue.triggers[0].facts.slots === '8', k.join() || 'none');
  check('…one blue flag, one timed call — nobody twice', k.filter((x) => x === 'yieldTo').length === 1 &&
    k.filter((x) => x === 'trafficBehind').length === 1, k.join());
}

{
  // The reverse order: timed first (no blue flag lit yet), then the provider
  // lights yieldTo for the same car — the blue flag stays quiet.
  const R = 0.12;
  const r = run(seq(0, 45, (t) => {
    const g = 5 - R * t;
    return frame(t, { cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -g, yieldTo: g <= 1 }] });
  }));
  const k = r.kinds();
  check('timed first → the later blue flag for that car is suppressed',
    k.includes('trafficBehind') && !k.includes('yieldTo'), k.join() || 'none');
}

/* -------------------------------------------------------------------------- */
/*  8) Where: only when the whole uncertainty band lands in one sector         */
/* -------------------------------------------------------------------------- */

console.log('\n8) Location — only when it cannot be wrong');

{
  const lap = { s1: 25, s2: 60, len: 100 };
  const meRow = { lastSector1Sec: lap.s1, lastSector2Sec: lap.s2, lastLapSec: lap.len };
  const at = (cur, ttc) => T.contactSector({ player: { lap: { current: cur } } }, meRow, ttc);
  check('band wholly inside the next sector → named', at(20, 25) === 2, String(at(20, 25)));
  check('band straddling a sector line → omitted', at(10, 12) === null, String(at(10, 12)));
  check('contact in the sector you are already in → omitted', at(30, 10) === null, String(at(30, 10)));
  check('across the start/finish line → next lap, sector one', at(95, 20) === 1, String(at(95, 20)));
  check('no sector times (invalid last lap) → omitted',
    T.contactSector({ player: { lap: { current: 10 } } }, { lastLapSec: 100 }, 22) === null);
}
{
  // The blue flag gains the sector when it can be placed.
  const R = 0.12;
  const lap = { s1: 25, s2: 60, len: 100, cur: (t) => t % 100 };
  const r = run(seq(0, 30, (t) => {
    const g = 5 - R * t;
    return frame(t, { lap, cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -g, yieldTo: g <= 3 }] });
  }));
  const blue = r.cues.find((c) => c.cue.kind === 'yieldTo');
  const line = blue && phraseForCue(blue.cue, blue.frame, 0);
  check('blue flag + steady estimate → "With you into sector two."',
    !!blue && blue.cue.triggers[0].facts.contactSector === 2 && / With you into sector two\.$/.test(line), line);
}
{
  // …and a blue flag the tracker cannot time reads exactly as before.
  const r = run(seq(0, 3, (t) => frame(t, {
    cars: [{ slot: 7, cls: 'Hypercar', pace: 88, gap: -2.1, yieldTo: t >= 1 }],
  })));
  const blue = r.cues.find((c) => c.cue.kind === 'yieldTo');
  const line = blue && phraseForCue(blue.cue, blue.frame, 0);
  check('an untimed blue flag is unchanged', /^Blue flags — 7 closing, 2\.1 seconds back\. Hold your line\.$/.test(line || ''), line);
}

/* -------------------------------------------------------------------------- */
/*  9) Words                                                                   */
/* -------------------------------------------------------------------------- */

console.log('\n9) Short lines, the classes drivers say, a number that means time');

{
  const base = { contactAtMs: 9000, slots: '7', fast: false };
  const cases = [
    ['trafficBehind', { ...base, count: 1, carClass: 'HYPERCAR' }],
    ['trafficBehind', { ...base, count: 1, carClass: 'LMP2_ELMS', fast: true }],
    ['trafficBehind', { ...base, count: 2, carClass: 'HYPERCAR' }],
    ['trafficBehind', { ...base, count: 2, carClass: 'mixed' }],
    ['trafficBehind', { ...base, count: 1, carClass: 'LMP2', sector: 3 }],
    ['trafficAhead', { ...base, count: 1, carClass: 'GT3' }],
    ['trafficAhead', { ...base, count: 3, carClass: 'GT3' }],
    ['trafficAhead', { ...base, count: 2, carClass: 'mixed' }],
  ];
  let worst = 0;
  let worstLine = '';
  let allOk = true;
  for (const [kind, facts] of cases) {
    for (let v = 0; v < 6; v++) {
      const line = T.trafficSentence(kind, facts, 0, v);
      const w = line ? words(line) : 99;
      if (w > worst) { worst = w; worstLine = line; }
      if (!line || !/about \d+/.test(line) || /\bgap\b|back\b/.test(line)) allOk = false;
    }
  }
  check('every variant speaks "about N" and never a gap', allOk);
  check('every variant is ≤ 11 words', worst <= 11, `${worst}: ${worstLine}`);
  check('Hypercar / LMP2 / GT3 as drivers say them',
    /^Hypercar/.test(T.trafficSentence('trafficBehind', cases[0][1], 0, 0)) &&
      /^LMP2 /.test(T.trafficSentence('trafficBehind', cases[1][1], 0, 0)) &&
      /^Three GT3s/.test(T.trafficSentence('trafficAhead', cases[6][1], 0, 0)),
    T.trafficSentence('trafficBehind', cases[1][1], 0, 0));
  check('the number is whole seconds, the speech lead already taken off',
    spokenSecs(T.trafficSentence('trafficAhead', { ...base, count: 1, carClass: 'GT3', contactAtMs: 8400 }, 0, 0)) === 6,
    T.trafficSentence('trafficAhead', { ...base, count: 1, carClass: 'GT3', contactAtMs: 8400 }, 0, 0));
}

/* -------------------------------------------------------------------------- */
/*  10) Re-arming                                                              */
/* -------------------------------------------------------------------------- */

console.log('\n10) Once per car per approach');

{
  const tr = new T.TrafficCallTracker();
  let n = 0;
  const approach = (t0) => {
    for (let t = t0; t <= t0 + 40; t = Math.round((t + 0.1) * 10) / 10) {
      const g = 5 - 0.12 * (t - t0);
      if (g < 0.6) continue; // stop just short of contact: the car hangs there
      const f = frame(t, { cls: 'HYPERCAR', pace: 88, cars: [{ slot: 9, cls: 'GT3', pace: 100, gap: g }] });
      for (const c of tr.update(f, f.timestamp)) { n++; for (const s of c.slots) tr.markCalled(s, f.timestamp); }
    }
  };
  approach(0);
  approach(40); // the same car, straight back into view
  check('the same car is not called again inside the re-arm time', n === 1, n);
  approach(40 + 40 + T.REARM_SEC + 1);
  check('…but is, on a genuinely new approach later', n === 2, n);
}

/* -------------------------------------------------------------------------- */
/*  11) The lap clock: lapped cars' distance gaps breathe — time does not      */
/* -------------------------------------------------------------------------- */

console.log("\n11) The player's lap clock (LMU gives lapped cars a DISTANCE gap)");

/**
 * A 5 km lap with a real speed profile (30–90 m/s) and a GT3 on the same
 * profile at 89% of the speed. The relative gap is distance × lap time, the
 * way LMU's provider falls back for a lapped car: it breathes by seconds as
 * the GT3 brakes and the player does not.
 */
function profileRace(withFractions) {
  const L = 5000;
  const v = (x) => 60 + 30 * Math.sin((2 * Math.PI * 3 * x) / L);
  let xp = 0;
  let xc = 0.4 * L;
  let tl = 0;
  let t = 0;
  let laps = 0;
  let lapT = null;
  const trig = new EngineerTriggers();
  const cues = [];
  const hist = [];
  for (let i = 0; i < 3600; i++) {
    t = Math.round((t + 0.1) * 10) / 10;
    tl += 0.1;
    xp += v(xp % L) * 0.1;
    xc += 0.89 * v(xc % L) * 0.1;
    if (xp >= L * (laps + 1)) {
      laps++;
      lapT = tl;
      tl = 0;
    }
    let d = (xc - xp) / L;
    d -= Math.round(d);
    const rel = d * (lapT || 85);
    const f = frame(t, { cls: 'HYPERCAR', pace: 85, cars: [{ slot: 2, cls: 'GT3', pace: 95.5, gap: rel, timed: false }] });
    f.player.lap.current = tl;
    if (withFractions) {
      f.standings[0].lapFraction = (xp % L) / L;
      f.standings[1].lapFraction = (xc % L) / L;
    }
    hist.push({ t, rel });
    const cue = trig.update(f);
    if (cue) cues.push({ cue, frame: f });
  }
  return { cues, hist };
}

{
  const { cues, hist } = profileRace(true);
  const timed = cues.filter((c) => c.cue.kind === 'trafficAhead');
  check('with lap fractions: the breathing approach is called once', timed.length === 1, cues.map((c) => c.cue.kind).join() || 'none');
  const c = timed[0];
  if (c) {
    const said = (c.cue.triggers[0].facts.contactAtMs - c.cue.atMs) / 1000;
    const hit = hist.find((h) => h.t * 1000 > c.cue.atMs && Math.abs(h.rel) <= T.CONTACT_GAP_SEC);
    const actual = hit ? hit.t - c.cue.atMs / 1000 : null;
    check('…and the car is reached within 2.5 s of the prediction', actual !== null && Math.abs(actual - said) <= 2.5,
      `predicted ${said.toFixed(1)} s, reached in ${actual && actual.toFixed(1)} s`);
  }
}
{
  const { cues } = profileRace(false);
  check('without them the breathing distance gap is refused — silence, not a guess',
    !cues.some((c) => c.cue.kind.startsWith('traffic')), cues.map((c) => c.cue.kind).join() || 'none');
}
{
  // The clock only learns from clean laps, and survives either feed ticking first at the line.
  const lap = (clock, dirtyAt, clockFirst) => {
    for (let i = 0; i <= 1000; i++) clock.observe(Math.min(0.9999, i / 1000), (i / 1000) * 100, i === dirtyAt);
    if (clockFirst) clock.observe(0.9999, 0.05, false); // the clock resets before the fraction wraps
    clock.observe(0.0005, clockFirst ? 0.1 : 100.05, false); // the fraction wraps (clock maybe not yet)
    clock.observe(0.001, 0.1, false);
  };
  const a = new T.LapClock();
  a.observe(0, 0, false);
  lap(a, 500, false);
  check('a lap with a pit/yellow sample is not learned', !a.ready());
  const b = new T.LapClock();
  b.observe(0, 0, false);
  lap(b, -1, true);
  check('a clean lap is learned (clock resets first)', b.ready(), b.lapSec().toFixed(2));
  const c2 = new T.LapClock();
  c2.observe(0, 0, false);
  lap(c2, -1, false);
  check('a clean lap is learned (fraction wraps first)', c2.ready(), c2.lapSec().toFixed(2));
  check('…gap ahead = time to get there', Math.abs(c2.gap(0.6, 0.5) - 10) < 0.2, c2.gap(0.6, 0.5));
  check('…gap behind is negative', Math.abs(c2.gap(0.4, 0.5) + 10) < 0.2, c2.gap(0.4, 0.5));
  check('…the short way across the line', Math.abs(c2.gap(0.02, 0.97) - 5) < 0.3, c2.gap(0.02, 0.97));
}

/* -------------------------------------------------------------------------- */
/*  12) The voice side: preset tier and a short hold                           */
/* -------------------------------------------------------------------------- */

console.log('\n12) electron/engineer.js — Standard tier, and a countdown never waits long');

{
  const os = require('node:os');
  const path = require('node:path');
  const { EngineerService } = require('../electron/engineer');
  const rig = (preset) => {
    const settings = { engineerEnabled: true, engineerVoice: 'en_GB-alan-medium', engineer: { readouts: preset } };
    const svc = new EngineerService({ dir: path.join(os.tmpdir(), 'apex-traffic-test'), loadSettings: () => settings, onStatus: () => {} });
    svc.running = true;
    const spoken = [];
    svc.speak = (text) => spoken.push(text);
    svc.lastFrame = { session: {}, player: { pedals: { brake: 0 } }, standings: [], relative: [], radar: [] };
    return { svc, spoken };
  };
  const cue = (kind) => ({
    atMs: 0, kind, line: kind,
    triggers: [{ kind, atMs: 0, priority: 46, detail: kind, facts: { count: 1, carClass: 'HYPERCAR', contactAtMs: 9000, slots: '7', fast: false } }],
    context: { sessionType: 'race', phase: 'green', flag: 'green', track: 'T', position: 7, classPosition: 3, carClass: 'GT3', numCars: 10, currentLap: 4, lapsRemaining: 10 },
  });
  const e = rig('essential');
  e.svc.onCue(cue('trafficBehind'), e.svc.lastFrame);
  check('Essential preset: timed traffic stays quiet', e.spoken.length === 0, e.spoken.join('|'));
  const s = rig('standard');
  s.svc.onCue(cue('trafficBehind'), s.svc.lastFrame);
  check('Standard preset: it speaks', s.spoken.length === 1 && /^Hypercar behind, with you in about 7 seconds\.$/.test(s.spoken[0]), s.spoken.join('|'));
  const h = rig('standard');
  h.svc.audioInFlight = 1;
  h.svc.onCue(cue('trafficAhead'), h.svc.lastFrame);
  const wait = h.svc.heldReadout ? h.svc.heldReadout.expiresAt - Date.now() : -1;
  check('a held countdown expires in under a second (not the usual 4 s)', wait > 0 && wait <= 800, `${wait} ms`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/* ========================================================================== */
/*  Replay + validation modes                                                  */
/* ========================================================================== */

function loadFrames(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function q(arr, x) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * x))];
}
function f2(x) {
  return Number.isFinite(x) ? x.toFixed(2) : '-';
}

/** Per-slot gap timeline: what actually happened after a prediction. */
function timelineOf(frames) {
  const tl = new Map();
  for (const f of frames) {
    for (const r of f.relative || []) {
      if (r.isPlayer) continue;
      if (!tl.has(r.slotId)) tl.set(r.slotId, []);
      tl.get(r.slotId).push({ t: f.timestamp, g: r.relativeGapSec, pit: r.inPit, key: `${f.session.track}|${f.session.type}` });
    }
  }
  return tl;
}

/** When the car actually reached the contact gap (or passed), or why not. */
function actualContact(tl, slot, fromMs, side, horizonMs) {
  let prev = null;
  for (const p of tl.get(slot) || []) {
    if (p.t <= fromMs) { prev = p; continue; }
    if (p.t > fromMs + horizonMs) return { never: true };
    if (prev && p.t - prev.t > 1500) return { left: true };
    if (p.pit) return { left: true };
    const sideNow = p.g < 0 ? 'behind' : 'ahead';
    if (Math.abs(p.g) <= T.CONTACT_GAP_SEC || sideNow !== side) return { at: p.t };
    prev = p;
  }
  return { left: true };
}

function replay(file) {
  const frames = loadFrames(file);
  const tl = timelineOf(frames);
  console.log(`replay ${file}: ${frames.length} frames`);

  // (1) The shipped pipeline: what the engineer would have SAID.
  const sessions = new Map();
  for (const f of frames) {
    const k = `${f.session.track} · ${f.session.type}`;
    if (!sessions.has(k)) sessions.set(k, { laps: new Set(), classes: new Set(), frames: 0 });
    const s = sessions.get(k);
    s.frames++;
    if (f.session.phase === 'green') s.laps.add(f.session.currentLap);
    for (const e of f.standings || []) if (e.carClass) s.classes.add(e.carClass);
  }
  const trig = new EngineerTriggers();
  const said = [];
  for (const f of frames) {
    const cue = trig.update(f);
    if (cue && (cue.kind.startsWith('traffic') || cue.kind === 'yieldTo')) said.push({ cue, f });
  }
  console.log('\n(1) Shipped gates — traffic calls the engineer would have made');
  for (const [k, s] of sessions) {
    const n = said.filter((x) => `${x.f.session.track} · ${x.f.session.type}` === k);
    const laps = Math.max(1, s.laps.size);
    console.log(`  ${k}: classes ${[...s.classes].join('/')}, ~${s.laps.size} green laps → ${n.length} traffic/blue-flag calls (${(n.length / laps).toFixed(2)} per lap)`);
  }
  for (const { cue, f } of said) {
    const facts = cue.triggers[0].facts;
    const line = phraseForCue(cue, f, 0);
    let verdict = '';
    if (typeof facts.contactAtMs === 'number') {
      const side = cue.kind === 'trafficAhead' ? 'ahead' : 'behind';
      const slot = Number(String(facts.slots).split(',')[0]);
      const a = actualContact(tl, slot, cue.atMs, side, 60_000);
      const heard = (facts.contactAtMs - cue.atMs) / 1000 - T.SPEECH_LEAD_SEC;
      verdict = a.at
        ? ` → actually ${((a.at - cue.atMs) / 1000 - T.SPEECH_LEAD_SEC).toFixed(1)} s after hearing (said ${heard.toFixed(1)})`
        : a.never ? ' → NEVER arrived within 60 s' : ' → car left the relative / pitted';
    }
    console.log(`  lap ${f.session.currentLap} ${cue.kind}: "${line}"${verdict}`);
  }

  // (2) Estimator accuracy, class gate off.
  const tr = new T.TrafficCallTracker({ classAgnostic: true });
  const preds = [];
  const calls = [];
  let prevKey = '';
  for (const f of frames) {
    const key = `${f.session.track}|${f.session.type}|${f.session.numCars}`;
    if (key !== prevKey) { tr.reset(); prevKey = key; }
    const cs = tr.update(f, f.timestamp);
    for (const [slot, est] of tr.currentEstimates()) {
      if (est.steady) preds.push({ slot, t: f.timestamp, ttc: est.ttcSec, side: est.side });
    }
    for (const c of cs) {
      calls.push({ t: f.timestamp, c, lap: f.session.currentLap });
      for (const s of c.slots) tr.markCalled(s, f.timestamp);
    }
  }
  console.log('\n(2) Estimator, class gate OFF (every car) — steady predictions vs what followed');
  for (const [a, b] of [[3, 6], [6, 10], [10, 15], [15, 30]]) {
    const sel = preds.filter((p) => p.ttc >= a && p.ttc < b);
    const res = sel.map((p) => ({ p, r: actualContact(tl, p.slot, p.t, p.side, Math.max(30_000, p.ttc * 3000 + 5000)) }));
    const hit = res.filter((x) => x.r.at);
    const err = hit.map((x) => (x.r.at - x.p.t) / 1000 - x.p.ttc);
    console.log(`  TTC ${a}-${b}s: ${sel.length} frame-predictions, arrived ${hit.length}, never ${res.filter((x) => x.r.never).length}, left ${res.filter((x) => x.r.left).length} | error median ${f2(q(err, 0.5))} s, p10 ${f2(q(err, 0.1))}, p90 ${f2(q(err, 0.9))}`);
  }
  for (const { t, c, lap } of calls) {
    const side = c.kind === 'trafficBehind' ? 'behind' : 'ahead';
    const a = actualContact(tl, c.slots[0], t, side, 60_000);
    console.log(`  call lap ${lap} ${c.kind} [${c.slots}] predicted ${c.facts.ttcSec} s → ${a.at ? `${((a.at - t) / 1000).toFixed(1)} s` : a.never ? 'never' : 'left'}`);
  }
  console.log(`  class-agnostic calls: ${calls.length}`);
}

function inject(file) {
  const frames = loadFrames(file);
  const tl = timelineOf(frames);
  const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
  const amp = Number(opt('--amp', '0'));
  const [lo, hi] = opt('--window', `${T.CALL_MIN_TTC_SEC},${T.CALL_MAX_TTC_SEC}`).split(',').map(Number);

  // Noise library: every continuous recorded gap series, minus its own 20 s trend.
  const noises = [];
  for (const s of tl.values()) {
    let cur = [];
    const flush = () => { if (cur.length > 120) noises.push(detrend(cur)); cur = []; };
    for (const p of s) {
      const last = cur[cur.length - 1];
      if (last && (p.t - last.t > 1500 || Math.abs(p.g - last.g) > 0.5 || Math.sign(p.g) !== Math.sign(last.g) || p.pit || p.key !== last.key)) flush();
      if (!p.pit && Math.abs(p.g) > 0.3 && Math.abs(p.g) < 4) cur.push(p);
    }
    flush();
  }
  const all = noises.flat().map((x) => x.e);
  const sd = Math.sqrt(all.reduce((a, x) => a + x * x, 0) / Math.max(1, all.length));
  console.log(`noise library: ${noises.length} series, ${all.length} samples, residual sd ${sd.toFixed(3)} s; window ${lo}-${hi} s; rate variation ±${amp * 100}%`);
  // Measured on the 2026-08-19 recording: the wobble grows a little with the gap.
  const sdAt = (g) => (g < 0.5 ? 0.063 : g < 1 ? 0.076 : g < 2 ? 0.079 : g < 3 ? 0.092 : 0.108);

  for (const rate of [0.08, 0.1, 0.12, 0.15, 0.2]) {
    const rows = [];
    for (const nz of noises) {
      for (let off = 0; off + 40 < nz.length; off += 25) {
        const tr = new T.TrafficCallTracker({ callMinTtcSec: lo, callMaxTtcSec: hi });
        const t0 = nz[off].t;
        let g = 4.5;
        let lastT = null;
        let call = null;
        let contact = null;
        for (let i = off; i < nz.length; i++) {
          const t = nz[i].t;
          if (lastT !== null) g -= rate * (1 + amp * Math.sin((2 * Math.PI * (t - t0)) / 25000 + off * 2.39996)) * ((t - lastT) / 1000);
          lastT = t;
          const seen = g + (nz[i].e * sdAt(g)) / sd;
          if (seen <= T.CONTACT_GAP_SEC) { contact = t; break; }
          const f = frame(t / 1000, { cars: [{ slot: 7, cls: 'Hypercar', pace: 100 * (1 - rate), gap: -seen }] });
          f.timestamp = t;
          const cs = tr.update(f, t);
          if (cs.length && !call) { call = { t, ttc: cs[0].facts.ttcSec }; tr.markCalled(7, t); }
        }
        if (contact !== null) rows.push({ call, actual: call ? (contact - call.t) / 1000 : null });
      }
    }
    const called = rows.filter((r) => r.call);
    const err = called.map((r) => r.actual - r.call.ttc);
    const abs = err.map(Math.abs);
    const pct = (n) => `${((100 * n) / Math.max(1, called.length)).toFixed(0)}%`;
    console.log(`  rate ${rate}: ${rows.length} approaches, called ${called.length} (${((100 * called.length) / Math.max(1, rows.length)).toFixed(0)}%) | error median ${f2(q(err, 0.5))} s, p10 ${f2(q(err, 0.1))}, p90 ${f2(q(err, 0.9))} | within 1 s ${pct(abs.filter((x) => x <= 1).length)}, within 2 s ${pct(abs.filter((x) => x <= 2).length)}`);
  }
}

function detrend(s) {
  return s.map((p) => {
    const w = s.filter((x) => Math.abs(x.t - p.t) <= 10_000);
    const n = w.length;
    const mt = w.reduce((a, x) => a + x.t, 0) / n;
    const mg = w.reduce((a, x) => a + Math.abs(x.g), 0) / n;
    let nu = 0;
    let de = 0;
    for (const x of w) { nu += (x.t - mt) * (Math.abs(x.g) - mg); de += (x.t - mt) ** 2; }
    const b = de ? nu / de : 0;
    return { t: p.t, e: Math.abs(p.g) - (mg + b * (p.t - mt)) };
  });
}
