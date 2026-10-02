/**
 * scripts/test-rivalstop.js — what a rival's pit stop means for you.
 * -----------------------------------------------------------------------------
 * The `rivalStop` / `rivalRejoin` trigger kinds (src/telemetry/rivalStop.ts),
 * driven through the real EngineerTriggers gates and the real phrasebook with
 * synthetic frame sequences. The brief was "only if it is CRITICAL", so most of
 * these checks are about SILENCE: the stop that changes nothing, the
 * drive-through, the retirement, the lapped car, the other class.
 *
 *   node scripts/test-rivalstop.js
 *   node scripts/test-rivalstop.js --replay <recording.jsonl> [--demo]
 *       Talkativeness check: every rivalStop/rivalRejoin line a recording would
 *       have produced, spoken text included, plus how many class stops it saw.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { EngineerTriggers } = require('../dist/telemetry/triggers');
const { phraseForCue } = require('../dist/telemetry/engineerPhrases');
const { PitLossModel } = require('../dist/telemetry/pitExit');

const UNKNOWN = -1;

const argv = process.argv.slice(2);
if (argv.includes('--replay')) {
  replay(argv[argv.indexOf('--replay') + 1], argv.includes('--demo'));
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
/*  A tiny race                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One car. `gap` is seconds behind the CLASS leader (the field LMU keeps alive
 * for lapped cars); the overall gap is UNKNOWN for everyone but the leader, as
 * it is in a long multiclass race — which is also what makes the pit-loss
 * model's class fallback necessary.
 */
function car(slotId, over) {
  return {
    slotId,
    position: slotId,
    driverName: `Driver ${slotId}`,
    carClass: 'GT3',
    classPosition: slotId,
    gapToClassLeaderSec: (slotId - 1) * 10,
    classLapsBehind: 0,
    gapToLeaderSec: UNKNOWN,
    gapToAheadSec: UNKNOWN,
    lapsBehind: 1,
    bestLapSec: 100,
    lastLapSec: 100,
    lapsCompleted: 10,
    inPit: false,
    speedMps: 50,
    pitStops: 0,
    isPlayer: false,
    ...over,
  };
}

/**
 * The race: the player is GT3 P4 (slot 4). `cars` is a map slot → overrides,
 * re-read every step, so a test mutates it between runs.
 */
function race(opts = {}) {
  const triggers = new EngineerTriggers();
  let now = 2_000_000;
  const cars = new Map();
  for (let s = 1; s <= 8; s++) cars.set(s, s === 4 ? { isPlayer: true, driverName: 'Player Me' } : {});
  const session = { currentLap: 11, phase: 'green', flag: 'green', ...(opts.session || {}) };
  const fuel = { lapsRemaining: 12, lapsToFinish: 30, ...(opts.fuel || {}) };
  const extra = opts.extra || [];
  const cues = [];

  const frame = () => ({
    schemaVersion: 1,
    source: 'lmu',
    timestamp: now,
    connected: true,
    session: {
      type: 'race', track: 'Test Ring', numCars: 8 + extra.length, notStarted: false,
      lapsRemaining: 30, timeRemainingSec: 3000, totalLaps: 0, scheduledLengthSec: 3600,
      ...session,
    },
    player: { slotId: 4, position: 4, pit: { phase: cars.get(4).inPit ? 'stopped' : 'none' } },
    standings: [
      ...[...cars.entries()].map(([s, o]) => car(s, o)),
      ...extra,
    ],
    relative: [],
    fuel,
  });

  triggers.update(frame()); // prime
  const step = (ms = 250) => {
    now += ms;
    const cue = triggers.update(frame());
    if (cue) cues.push(cue);
    return cue;
  };
  const run = (ms) => {
    for (let t = 0; t < ms; t += 250) step();
  };
  /** Set a car's overrides (merged). */
  const set = (slot, over) => cars.set(slot, { ...cars.get(slot), ...over });
  /**
   * A full pit visit: in, down the lane, stationary for `standMs`, back up the
   * lane, and OUT — the out frame is staged but not yet run, so a test can set
   * the gap the car rejoins with before the next run() sees the exit.
   */
  const stop = (slot, { standMs = 20_000, laneMs = 6000, speed = true } = {}) => {
    run(500); // whatever the test just staged is read on track first
    set(slot, { inPit: true, speedMps: speed ? 20 : undefined });
    run(laneMs);
    set(slot, { speedMps: speed ? 0 : undefined });
    run(standMs);
    set(slot, { speedMps: speed ? 20 : undefined });
    run(laneMs);
    set(slot, { inPit: false, speedMps: 50 });
  };
  /**
   * Teach the pit-loss model three `loss`-second stops (the projection's
   * minimum), from cars far enough down the class not to be your neighbours.
   */
  const measureLoss = (loss = 30) => {
    for (const s of [6, 7, 8]) {
      const g = cars.get(s).gapToClassLeaderSec ?? (s - 1) * 10;
      stop(s);
      run(1000);
      set(s, { lapsCompleted: 11, gapToClassLeaderSec: g + loss, pitStops: 1 });
      run(1000);
    }
  };
  return {
    triggers, step, run, set, stop, measureLoss, cues, frame,
    get nowMs() { return now; },
    rival: () => cues.filter((c) => c.triggers.some((t) => t.kind === 'rivalStop' || t.kind === 'rivalRejoin')),
    said: (c) => (c ? phraseForCue(c, null, 0) : null),
  };
}

const factsOf = (cue, kind) => cue && (cue.triggers.find((t) => t.kind === kind) || {}).facts;

/* -------------------------------------------------------------------------- */
/*  1) The car ahead pits, with a measured loss                                 */
/* -------------------------------------------------------------------------- */

console.log('\n1) Car ahead boxes — measured loss projects where it rejoins');

{
  // Ahead (slot 3) is 10 s up the road; loss 30 → out about 20 behind: a
  // place changes hands on the road.
  const r = race();
  r.measureLoss(30);
  check('measuring a stop says nothing (not a neighbour)', r.rival().length === 0, r.rival().map((c) => c.line).join(' | '));
  r.set(3, { inPit: true, speedMps: 20 });
  r.run(4000);
  check('lane entry alone is not yet a call (could be a drive-through)', r.rival().length === 0);
  r.set(3, { speedMps: 0 });
  r.run(9000);
  const cue = r.rival()[0];
  const f = factsOf(cue, 'rivalStop');
  check('a real stop by the car ahead speaks', !!cue, r.cues.map((c) => c.kind).join());
  check('…projected to drop behind you', f && f.outcome === 'dropsBehind' && f.rejoinSec === -20, JSON.stringify(f));
  check('…from the measured loss', f && f.lossSec === 30 && f.lossSamples === 3, JSON.stringify(f));
  const line = cue && r.said(cue);
  check('…said with "about", in whole seconds', /about 20 seconds behind you/.test(line || ''), line);
  check('…and short', line && line.split(/\s+/).length <= 14, line);
}

{
  // Ahead 22 s up the road (slot 3 gap 8 vs my 30), loss 30 → out about 8
  // behind: still a change. Ahead 40 s away → 10 s ahead after: close ahead.
  const r = race();
  r.measureLoss(30);
  r.set(3, { gapToClassLeaderSec: -10 }); // 40 s ahead of my 30
  r.stop(3);
  const cue = r.rival()[0];
  const f = factsOf(cue, 'rivalStop');
  check('car ahead staying ahead but within 15 s is a call', f && f.outcome === 'closeAhead' && f.rejoinSec === 10,
    JSON.stringify(f));
  check('…"ahead of you"', /about 10 seconds ahead of you/.test(r.said(cue) || ''), r.said(cue));
}

{
  // 60 s up the road, loss 30: still 30 s clear after. Not news.
  const r = race();
  r.measureLoss(30);
  r.set(3, { gapToClassLeaderSec: -30 });
  r.stop(3);
  check('car ahead staying well clear after its stop is silent', r.rival().length === 0,
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  // Projected out right around you.
  const r = race();
  r.measureLoss(30);
  r.set(3, { gapToClassLeaderSec: 0.5 }); // 29.5 ahead → -0.5
  r.stop(3);
  const f = factsOf(r.rival()[0], 'rivalStop');
  check('projected out within 1.5 s reads "level"', f && f.outcome === 'level', JSON.stringify(f));
}

/* -------------------------------------------------------------------------- */
/*  2) The car behind                                                           */
/* -------------------------------------------------------------------------- */

console.log('\n2) Car behind boxes — the undercut, or nothing');

{
  const r = race();
  r.measureLoss(30);
  r.set(5, { gapToClassLeaderSec: 31.2 }); // 1.2 behind me
  r.stop(5);
  const cue = r.rival()[0];
  const f = factsOf(cue, 'rivalStop');
  check('car behind from 1.2 s while you still have to stop: undercut', f && f.outcome === 'undercut', JSON.stringify(f));
  const line = r.said(cue) || '';
  check('…"close after your stop"', /1\.2 seconds behind — close after your stop/.test(line), line);
  check('…never a verdict on whether it works', !/work|will pass|lose the place|gain/.test(line), line);
}

{
  const r = race();
  r.measureLoss(30);
  r.set(5, { gapToClassLeaderSec: 38 }); // 8 behind
  r.stop(5);
  check('car behind from 8 s (out of the window, rejoins ~38 back) is silent', r.rival().length === 0,
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  // You have already made the stop the car behind is making now — no
  // "after your stop" line, and 1.2 + 30 behind is no fight.
  const r = race();
  r.measureLoss(30);
  r.set(4, { pitStops: 1 });
  r.set(5, { gapToClassLeaderSec: 31.2, pitStops: 0 });
  r.run(500);
  r.stop(5);
  check('car behind boxing AFTER you already stopped is silent', r.rival().length === 0,
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  // Fuel to the end: there is no "your stop" to be close after.
  const r = race({ fuel: { lapsRemaining: 40, lapsToFinish: 30 } });
  r.measureLoss(30);
  r.set(5, { gapToClassLeaderSec: 31.2 });
  r.stop(5);
  check('car behind boxing when you are fuelled to the flag is silent', r.rival().length === 0,
    r.rival().map((c) => r.said(c)).join(' | '));
}

/* -------------------------------------------------------------------------- */
/*  3) Nothing measured yet — the fact, and only for a direct fight              */
/* -------------------------------------------------------------------------- */

console.log('\n3) No pit loss measured — fact only');

{
  // One stop measured is not enough to project from (a damage repair would be
  // a median of one): still fact-only.
  const r = race();
  r.stop(8);
  r.run(1000);
  r.set(8, { lapsCompleted: 11, gapToClassLeaderSec: 100 });
  r.run(1000);
  r.set(3, { gapToClassLeaderSec: 27 }); // 3 s ahead
  r.stop(3);
  const cue = r.rival()[0];
  const f = factsOf(cue, 'rivalStop');
  check('car ahead from 3 s, no loss measured: the fact', f && f.outcome === 'fact', JSON.stringify(f));
  check('…with no projection in the facts', f && f.rejoinSec === undefined && f.lossSec === undefined, JSON.stringify(f));
  const line = r.said(cue) || '';
  check('…and none in the words', !/about|projected|rejoin/.test(line), line);
}

{
  const r = race();
  r.stop(3); // 10 s ahead
  check('car ahead from 10 s, no loss measured: silent', r.rival().length === 0,
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  const r = race({ session: { phase: 'fullCourseYellow', flag: 'doubleYellow' } });
  r.measureLoss(30);
  r.set(3, { gapToClassLeaderSec: 27 });
  r.stop(3);
  const f = factsOf(r.rival()[0], 'rivalStop');
  check('under a full-course yellow the measured loss is NOT used', f && f.outcome === 'fact' && f.fcy === true,
    JSON.stringify(f));
}

/* -------------------------------------------------------------------------- */
/*  4) Not stops / not rivals                                                   */
/* -------------------------------------------------------------------------- */

console.log('\n4) Drive-throughs, retirements, lapped cars, other classes');

{
  const r = race();
  r.measureLoss(30);
  // Through the lane at limiter speed, never stopping.
  r.set(3, { inPit: true, speedMps: 22 });
  r.run(20_000);
  r.set(3, { inPit: false, speedMps: 50 });
  r.run(8000);
  check('a drive-through (never stationary) is not a stop', r.rival().length === 0,
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  const r = race();
  r.measureLoss(30);
  r.set(3, { inPit: true, speedMps: 0, retired: true });
  r.run(15_000);
  check('a retirement is not a stop', r.rival().length === 0, r.rival().map((c) => r.said(c)).join(' | '));
}

{
  const r = race();
  r.measureLoss(30);
  r.set(3, { speedMps: 0 }); // stopped out on circuit…
  r.run(3000);
  r.set(3, { inPit: true, speedMps: 0 }); // …then recovered to the garage
  r.run(15_000);
  check('a car recovered to the garage after stopping on track is not a stop', r.rival().length === 0,
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  // Car ahead in class is a LAP up on you (exact counts 0.2 vs 1.4).
  const r = race();
  r.measureLoss(30);
  r.set(3, { classLapsBehindExact: 0.2, gapToClassLeaderSec: 20 });
  r.set(4, { classLapsBehindExact: 1.4, classLapsBehind: 1, gapToClassLeaderSec: UNKNOWN });
  r.run(500);
  r.stop(3);
  check('a neighbour a lap or more away is silent (a stop cannot swap you)', r.rival().length === 0,
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  // A Hypercar directly ahead on the road and in overall position boxes.
  const hyper = {
    slotId: 20, position: 3, driverName: 'Hyper Fast', carClass: 'HYPERCAR', classPosition: 1,
    gapToClassLeaderSec: 0, classLapsBehind: 0, gapToLeaderSec: 0, gapToAheadSec: UNKNOWN,
    lapsBehind: 0, bestLapSec: 90, lastLapSec: 90, lapsCompleted: 11, inPit: false, speedMps: 60,
    pitStops: 0, isPlayer: false,
  };
  const r = race({ extra: [hyper] });
  r.measureLoss(30);
  hyper.inPit = true;
  hyper.speedMps = 0;
  r.run(15_000);
  check('another class boxing is ignored', r.rival().length === 0, r.rival().map((c) => r.said(c)).join(' | '));
}

{
  const r = race();
  r.measureLoss(30);
  r.set(4, { inPit: true }); // you are in the lane too
  r.run(500);
  r.stop(3);
  check('nothing about a rival while you are in the pit lane yourself', r.rival().length === 0,
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  const r = race({ session: { currentLap: 1 } });
  r.set(3, { gapToClassLeaderSec: 27, lapsCompleted: 0 });
  r.stop(3);
  check('a lap-one stop (damage, chaos) is silent', r.rival().length === 0, r.rival().map((c) => r.said(c)).join(' | '));
}

{
  const r = race();
  r.measureLoss(30);
  r.stop(3); // 10 s ahead → dropsBehind, called
  r.run(20_000);
  r.stop(3); // a second visit (a penalty stop) inside two minutes
  check('the same rival is not announced twice inside its cooldown', r.rival().filter((c) => c.kind === 'rivalStop').length === 1,
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  // No per-car speed (rF2, demo): a dwell of 5 s confirms instead.
  const r = race();
  r.set(3, { gapToClassLeaderSec: 27 });
  r.run(500);
  r.set(3, { inPit: true, speedMps: undefined });
  r.run(3000);
  check('without per-car speed, under 5 s in the lane is not yet a stop', r.rival().length === 0);
  r.run(10_000);
  const f = factsOf(r.rival()[0], 'rivalStop');
  check('…and is after a 5 s dwell, flagged unverified', f && f.stationaryVerified === false, JSON.stringify(f));
}

/* -------------------------------------------------------------------------- */
/*  5) Coalescing                                                               */
/* -------------------------------------------------------------------------- */

console.log('\n5) A pit-cycle burst is one line');

{
  const r = race();
  r.measureLoss(30);
  r.run(25_000); // the measuring stop is not part of this burst
  // Both neighbours plus two others dive in together.
  r.set(5, { gapToClassLeaderSec: 31.2 });
  r.run(500);
  for (const s of [2, 3, 5, 6]) r.set(s, { inPit: true, speedMps: 20 });
  r.run(4000);
  for (const s of [2, 3, 5, 6]) r.set(s, { speedMps: 0 });
  r.run(12_000);
  const stops = r.rival().filter((c) => c.kind === 'rivalStop');
  check('four class cars boxing together → ONE rival line', stops.length === 1, stops.map((c) => r.said(c)).join(' | '));
  const f = factsOf(stops[0], 'rivalStop');
  check('…led by the car ahead (the one whose stop moves your place)', f && f.where === 'ahead', JSON.stringify(f));
  check('…naming the car behind too', f && f.alsoName === 'Driver 5', JSON.stringify(f));
  check('…and counting the rest', f && f.othersInPit === 2, JSON.stringify(f));
  const line = r.said(stops[0]) || '';
  check('…in one short sentence', /Driver 5|5 too/.test(line) && line.split(/\s+/).length <= 15, line);
}

{
  // The car two ahead boxes; the car directly ahead follows it in 8 s later.
  // One line, led by the direct neighbour — the lesser call must not win the
  // global gate and leave the important one unsaid.
  const r = race();
  r.measureLoss(30);
  r.set(4, { pitStops: 1 }); // you have made your stop; they have not
  r.run(25_000);
  r.set(2, { inPit: true, speedMps: 20 });
  r.run(4000);
  r.set(2, { speedMps: 0 });
  r.run(4000);
  r.set(3, { inPit: true, speedMps: 20 });
  r.run(4000);
  r.set(3, { speedMps: 0 });
  r.run(15_000);
  const stops = r.rival().filter((c) => c.kind === 'rivalStop');
  const f = factsOf(stops[0], 'rivalStop');
  check('two ahead then directly ahead → one line, led by the direct neighbour',
    stops.length === 1 && f.where === 'ahead' && f.alsoName === 'Driver 2', stops.map((c) => r.said(c)).join(' | '));
}

{
  const r = race();
  r.measureLoss(30);
  r.set(4, { pitStops: 1 });
  r.run(25_000);
  r.stop(2); // 20 s ahead, loss 30 → out about 10 behind
  const stops = r.rival().filter((c) => c.kind === 'rivalStop');
  const f = factsOf(stops[0], 'rivalStop');
  check('two ahead, after your stop, dropping behind you → called after its longer hold',
    stops.length === 1 && f.where === 'ahead2' && f.outcome === 'dropsBehind', stops.map((c) => r.said(c)).join(' | '));

  const r2 = race();
  r2.measureLoss(30);
  r2.run(25_000);
  r2.stop(2);
  check('…but silent while you still have your own stop to make (it comes back past)',
    r2.rival().length === 0, r2.rival().map((c) => r2.said(c)).join(' | '));
}

/* -------------------------------------------------------------------------- */
/*  6) The follow-up                                                            */
/* -------------------------------------------------------------------------- */

console.log('\n6) One follow-up, only when the rejoin differs');

{
  // Ahead 25 s, loss 30 → projected out 5 behind. Comes out 6.4 behind.
  const r = race();
  r.measureLoss(30);
  r.set(3, { gapToClassLeaderSec: 5 });
  r.run(500);
  r.stop(3);
  r.set(3, { gapToClassLeaderSec: 36.4 });
  r.run(8000);
  const rejoin = r.rival().find((c) => c.kind === 'rivalRejoin');
  const f = factsOf(rejoin, 'rivalRejoin');
  check('rejoin 1.4 s off the projection → follow-up', f && f.where === 'behind' && f.gapSec === 6.4, JSON.stringify(f));
  check('…"Driver 3\'s out, 6.4 seconds behind."', r.said(rejoin) === "3's out, 6.4 seconds behind.", r.said(rejoin));
}

{
  const r = race();
  r.measureLoss(30);
  r.set(3, { gapToClassLeaderSec: 5 });
  r.run(500);
  r.stop(3);
  r.set(3, { gapToClassLeaderSec: 35.4 }); // 5.4 behind, projected 5
  r.run(8000);
  check('rejoin within 1 s of the projection → no follow-up', !r.rival().some((c) => c.kind === 'rivalRejoin'),
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  // Projected out behind, actually came out AHEAD (a quick stop).
  const r = race();
  r.measureLoss(30);
  r.set(3, { gapToClassLeaderSec: 5 });
  r.run(500);
  r.stop(3);
  r.set(3, { gapToClassLeaderSec: 28 });
  r.run(8000);
  const f = factsOf(r.rival().find((c) => c.kind === 'rivalRejoin'), 'rivalRejoin');
  check('came out on the other side of you → follow-up says ahead', f && f.where === 'ahead' && f.gapSec === 2, JSON.stringify(f));
}

{
  // Far away on rejoin: not a fight, not news.
  const r = race();
  r.measureLoss(30);
  r.stop(3); // 10 ahead → projected 20 behind
  r.set(3, { gapToClassLeaderSec: 55 }); // 25 behind
  r.run(8000);
  check('rejoining far from you → no follow-up', !r.rival().some((c) => c.kind === 'rivalRejoin'),
    r.rival().map((c) => r.said(c)).join(' | '));
}

{
  // Fact-only call: the follow-up is the first real number, if close.
  const r = race();
  r.set(3, { gapToClassLeaderSec: 27 });
  r.run(500);
  r.stop(3);
  r.set(3, { gapToClassLeaderSec: 33 });
  r.run(8000);
  const f = factsOf(r.rival().find((c) => c.kind === 'rivalRejoin'), 'rivalRejoin');
  check('after a fact-only call, a close rejoin is reported', f && f.gapSec === 3 && f.where === 'behind', JSON.stringify(f));
}

/* -------------------------------------------------------------------------- */
/*  7) Energy, position shuffle, phrases                                        */
/* -------------------------------------------------------------------------- */

console.log('\n7) Energy context, the position shuffle, every phrase');

{
  // Energy is your binding budget (8 laps vs 12 of fuel); burn 5 %/lap; the
  // car ahead came in with 15 % (3 laps) → you have 5 laps more.
  const r = race({ fuel: { lapsRemaining: 12, lapsToFinish: 30, virtualEnergyLapsRemaining: 8, virtualEnergyPerLapPct: 5 } });
  r.measureLoss(30);
  r.set(3, { virtualEnergy: 0.15 });
  r.run(500);
  r.stop(3);
  const cue = r.rival()[0];
  const f = factsOf(cue, 'rivalStop');
  check('laps of energy in hand over the rival ride along', f && f.energyLapsInHand === 5, JSON.stringify(f));
  check('…and are said', / 5 laps more energy\./.test(r.said(cue) || ''), r.said(cue));
}

{
  // Fuel is binding (6 laps of fuel vs 8 of energy): energy laps say nothing.
  const r = race({ fuel: { lapsRemaining: 6, lapsToFinish: 30, virtualEnergyLapsRemaining: 8, virtualEnergyPerLapPct: 5 } });
  r.measureLoss(30);
  r.set(3, { virtualEnergy: 0.15 });
  r.run(500);
  r.stop(3);
  const f = factsOf(r.rival()[0], 'rivalStop');
  check('no energy clause when fuel, not energy, sets your stop', f && f.energyLapsInHand === undefined, JSON.stringify(f));
}

{
  // The car ahead falls behind you in the standings while in the lane: that
  // is the rival-stop story, not "Up to P3".
  const r = race();
  r.measureLoss(30);
  r.run(3000);
  r.set(3, { inPit: true, speedMps: 20 });
  r.run(2000);
  r.set(3, { position: 4, classPosition: 4 });
  r.set(4, { position: 3, classPosition: 3 });
  r.run(1000);
  r.set(3, { speedMps: 0 });
  r.run(12_000);
  check('the standings shuffle from a neighbour\'s stop is not a positionChange call',
    !r.cues.some((c) => c.kind === 'positionChange'), r.cues.map((c) => c.kind).join());
}

{
  const mk = (facts, kind = 'rivalStop') => ({
    atMs: 0, kind, line: '', context: { classPosition: 4, position: 4, numCars: 8 },
    triggers: [{ kind, atMs: 0, priority: 1, detail: '', facts }],
  });
  const base = { name: 'Sam Brown', where: 'ahead', gapSec: 3.1, rejoinSec: -12.4 };
  const banks = [
    { ...base, outcome: 'dropsBehind' },
    { ...base, where: 'ahead2', outcome: 'dropsBehind' },
    { ...base, rejoinSec: 0.6, outcome: 'level' },
    { ...base, rejoinSec: 7.6, outcome: 'closeAhead' },
    { ...base, where: 'behind', rejoinSec: -12, outcome: 'closeBehind' },
    { ...base, where: 'behind', gapSec: 1.2, outcome: 'undercut', energyLapsInHand: 3 },
    { name: 'Sam Brown', where: 'ahead', gapSec: 3.1, outcome: 'fact' },
    { name: 'Sam Brown', where: 'behind', gapSec: 2.2, outcome: 'fact' },
    { ...base, outcome: 'dropsBehind', alsoName: 'Jo Smith', energyLapsInHand: 1 },
    { ...base, outcome: 'dropsBehind', othersInPit: 3 },
  ];
  let worst = 0;
  let worstLine = '';
  let worstAll = 0;
  let allOk = true;
  for (const facts of banks) {
    for (let v = 0; v < 3; v++) {
      const line = phraseForCue(mk(facts), null, v);
      if (!line || /undefined|NaN|null/.test(line)) allOk = false;
      const all = line ? line.split(/\s+/).length : 0;
      const base = line ? line.replace(/ \d+ laps? more energy\.$/, '').split(/\s+/).length : 0;
      if (base > worst) { worst = base; worstLine = line; }
      worstAll = Math.max(worstAll, all);
    }
  }
  check('every rivalStop phrase variant is a real sentence', allOk);
  check('…the line itself ≤ 14 words', worst <= 14, `${worst}: ${worstLine}`);
  check('…≤ 19 with the energy sentence on', worstAll <= 19, `${worstAll}`);
  console.log(`        e.g. "${phraseForCue(mk(banks[0]), null, 0)}"`);
  console.log(`        e.g. "${phraseForCue(mk(banks[5]), null, 0)}"`);
  console.log(`        e.g. "${phraseForCue(mk(banks[6]), null, 0)}"`);
  console.log(`        e.g. "${phraseForCue(mk(banks[8]), null, 0)}"`);
  const proj = phraseForCue(mk({ ...base, outcome: 'dropsBehind' }), null, 0);
  check('projections say "about" and never a tenth', /about 12 seconds/.test(proj) && !/12\.4/.test(proj), proj);
  const rj = phraseForCue(mk({ name: 'Sam Brown', where: 'behind', gapSec: 6.4 }, 'rivalRejoin'), null, 0);
  check('the rejoin line keeps the measured tenth', rj === "Brown's out, 6.4 seconds behind.", rj);
}

/* -------------------------------------------------------------------------- */
/*  8) The pit-loss model learns in a lapped field                              */
/* -------------------------------------------------------------------------- */

console.log('\n8) PitLossModel: class-leader fallback when the overall gap is zeroed');

{
  const m = new PitLossModel();
  const fr = (over) => ({
    source: 'lmu', session: { track: 'T', type: 'race', numCars: 2 },
    standings: [
      car(1, { isPlayer: true, gapToClassLeaderSec: 0 }),
      car(2, { gapToClassLeaderSec: 20, ...over }),
    ],
  });
  m.update(fr({}));
  m.update(fr({ inPit: true, speedMps: 0 }));
  m.update(fr({ inPit: false, lapsCompleted: 10 }));
  m.update(fr({ inPit: false, lapsCompleted: 11, gapToClassLeaderSec: 52 }));
  const est = m.estimate();
  check('a lapped car (overall gap UNKNOWN) still yields a sample off the class gap', est && est.lossSec === 32,
    JSON.stringify(est));

  const m2 = new PitLossModel();
  const fr2 = (over) => ({
    source: 'lmu', session: { track: 'T', type: 'race', numCars: 2 },
    standings: [car(1, { isPlayer: true, gapToClassLeaderSec: 25 }), car(2, { gapToClassLeaderSec: 0, ...over })],
  });
  m2.update(fr2({}));
  m2.update(fr2({ inPit: true, speedMps: 0 }));
  m2.update(fr2({ inPit: false, lapsCompleted: 10 }));
  m2.update(fr2({ inPit: false, lapsCompleted: 11, gapToClassLeaderSec: 7 }));
  check('the class LEADER\'s own stop is not measured against itself', m2.estimate() === null, JSON.stringify(m2.estimate()));

  const m3 = new PitLossModel();
  m3.update(fr({}));
  m3.update(fr({ inPit: true, speedMps: 22 })); // through the lane at the limiter…
  m3.update(fr({ inPit: true, speedMps: 21 }));
  m3.update(fr({ inPit: false, lapsCompleted: 10 })); // …never stopping
  m3.update(fr({ inPit: false, lapsCompleted: 11, gapToClassLeaderSec: 30 }));
  check('a drive-through is not a pit-loss sample', m3.estimate() === null, JSON.stringify(m3.estimate()));

  const m4 = new PitLossModel();
  m4.update(fr({}));
  m4.update(fr({ inPit: true, speedMps: undefined })); // a provider with no per-car speed
  m4.update(fr({ inPit: false, lapsCompleted: 10 }));
  m4.update(fr({ inPit: false, lapsCompleted: 11, gapToClassLeaderSec: 52 }));
  check('…but without per-car speed a lane visit still counts (cannot tell)', m4.estimate() && m4.estimate().lossSec === 32,
    JSON.stringify(m4.estimate()));
}

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

/* -------------------------------------------------------------------------- */
/*  Replay                                                                      */
/* -------------------------------------------------------------------------- */

function replay(file, demo) {
  const abs = path.resolve(file);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const triggers = new EngineerTriggers(demo ? { ignoreDisconnected: false } : {});
  let first = 0;
  let frames = 0;
  let classStops = 0;
  let oldWouldOffer = 0; // the retired rivalPitted edge: any ±1 neighbour entering the lane
  const prevPit = new Map();
  let calls = 0;
  console.log(`\nReplaying ${path.basename(abs)} — rival-stop calls only`);
  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      continue;
    }
    if (!frame || !frame.session || !frame.timestamp) continue;
    if (!demo && frame.connected === false) continue;
    frames++;
    first = first || frame.timestamp;
    const me = (frame.standings || []).find((e) => e.isPlayer);
    for (const e of frame.standings || []) {
      if (me && e.carClass !== me.carClass) continue;
      if (prevPit.get(e.slotId) === false && e.inPit === true) {
        classStops++;
        if (me && Math.abs((e.classPosition ?? 0) - (me.classPosition ?? 99)) === 1) oldWouldOffer++;
      }
      prevPit.set(e.slotId, e.inPit === true);
    }
    const cue = triggers.update(frame);
    if (cue && cue.triggers.some((t) => t.kind === 'rivalStop' || t.kind === 'rivalRejoin')) {
      calls++;
      const s = Math.round((cue.atMs - first) / 1000);
      const clock = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
      console.log(`  ${clock}  [${cue.kind}] "${phraseForCue(cue, frame)}"   (${cue.line})`);
    }
  }
  const st = triggers.getStats();
  console.log(`\n  ${frames} frames, ${classStops} lane entries by player-class cars, ${calls} rival calls`);
  console.log(`  (the old rivalPitted edge would have offered ${oldWouldOffer}: every class neighbour's lane entry)`);
  console.log(`  all cues: ${st.cues} — ${Object.entries(st.fired).map(([k, n]) => `${k}×${n}`).join(', ')}`);
}
