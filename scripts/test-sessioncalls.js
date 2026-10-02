/**
 * scripts/test-sessioncalls.js — the engineer in qualifying and practice.
 * -----------------------------------------------------------------------------
 * `telemetry/sessionCalls.ts` (detection) + `sessionPhrases.ts` (words), driven
 * through the real `EngineerTriggers` gates with synthetic sessions: a small
 * world whose class and overall positions are re-ranked from best laps every
 * frame, the way LMU orders a qualifying session.
 *
 * Covers every kind (qualiLap, qualiPole, qualiBeaten, qualiTimeLeft,
 * qualiGrid, practiceLap, sectorImproved) and the discipline around them:
 * silence on out-laps, in-laps, cool-down laps and in the pit lane; one call
 * for a burst of four cars beating you; pole only on a change of OWNER; only
 * your class; the grid call exactly once; the preset tiers; and the Tier-1
 * "where do I start" answer in qualifying.
 *
 *   npm run build && node scripts/test-sessioncalls.js
 */

'use strict';

const path = require('node:path');
const { EngineerTriggers } = require('../dist/telemetry/triggers');
const { phraseForCue } = require('../dist/telemetry/engineerPhrases');
const { EngineerCommands } = require('../dist/telemetry/engineerCommands');
const { speakableTenths } = require('../dist/telemetry/sessionPhrases');

const UNKNOWN = -1;

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
}

/* -------------------------------------------------------------------------- */
/*  A small qualifying world                                                    */
/* -------------------------------------------------------------------------- */

function car(slotId, name, cls, best, extra) {
  return {
    slotId, name, cls, best, last: best, laps: 3, inPit: false, s1: UNKNOWN, s2: UNKNOWN,
    sector: 1, ...extra,
  };
}

/** A GT3 qualifying session: the player P3 in class on 100.0, a Hypercar ahead overall. */
function world(over) {
  return {
    type: 'qualifying',
    phase: 'green',
    flag: 'green',
    notStarted: false,
    timeRemainingSec: 1500,
    finalLap: false,
    me: {
      slotId: 1, name: 'Carl Driver', cls: 'GT3', best: 100.0, last: 100.0, laps: 2,
      s1: 30.0, s2: 65.0, inPit: false, sector: 1, finished: false, lapValid: true,
      pd: null, lapClock: 10,
    },
    rivals: [
      car(2, 'Ana Ferreira', 'GT3', 99.0, { s1: 29.6, s2: 64.4 }),
      car(3, 'Luc Moreau', 'GT3', 99.5, { s1: 29.8, s2: 64.7 }),
      car(4, 'Ben Hale', 'GT3', 101.0),
      car(5, 'Kai Lund', 'GT3', 101.5),
      car(6, 'Jo Pike', 'GT3', 102.0),
      car(7, 'Max Vos', 'GT3', 102.5),
      car(20, 'Hyper One', 'HYPERCAR', 90.0),
    ],
    ...over,
  };
}

/** Rank by best lap, the way a qualifying board orders itself. */
function ranked(w) {
  const all = [w.me, ...w.rivals];
  const key = (c) => (c.best > 0 ? c.best : 1e9 + c.slotId);
  const overall = [...all].sort((a, b) => key(a) - key(b));
  const pos = new Map(overall.map((c, i) => [c.slotId, i + 1]));
  const cls = new Map();
  for (const klass of new Set(all.map((c) => c.cls))) {
    all.filter((c) => c.cls === klass).sort((a, b) => key(a) - key(b))
      .forEach((c, i) => cls.set(c.slotId, i + 1));
  }
  return { pos, cls };
}

function frameOf(w, t) {
  const { pos, cls } = ranked(w);
  // `w.focus` = the camera is on another car: it gets isPlayer, ours keeps isOwn.
  const row = (c, mine) => {
    const isPlayer = w.focus ? c.slotId === w.focus : mine;
    const r = {
      slotId: c.slotId, position: pos.get(c.slotId), driverName: c.name, carClass: c.cls,
      classPosition: cls.get(c.slotId), gapToLeaderSec: UNKNOWN, gapToAheadSec: UNKNOWN,
      lapsBehind: 0, bestLapSec: c.best, lastLapSec: c.last, lapsCompleted: c.laps,
      inPit: c.inPit, isPlayer, sector: c.sector,
      ...(w.focus && mine ? { isOwn: true } : {}),
    };
    if (c.s1 > 0) r.lastSector1Sec = c.s1;
    if (c.s2 > 0) r.lastSector2Sec = c.s2;
    return r;
  };
  const me = w.me;
  const player = {
    slotId: me.slotId,
    position: pos.get(me.slotId),
    pedals: { throttle: 1, brake: 0, clutch: 0, steer: 0 },
    gear: 5, speedKph: 200, rpm: 7000, maxRpm: 9000,
    lap: { current: me.lapClock, last: me.last, best: me.best, delta: UNKNOWN, sector: UNKNOWN },
    tyres: {},
    finished: me.finished,
    trackLimits: {
      points: 0, pointsLimit: 10, charges: [], charged: 0, msSinceCharge: UNKNOWN,
      penalties: 0, msSincePenalty: UNKNOWN, msSinceServed: UNKNOWN,
      ...(me.lapValid !== undefined ? { lapValid: me.lapValid } : {}),
    },
  };
  if (me.pd) player.paceDeltas = me.pd;
  return {
    schemaVersion: 1, source: 'lmu', timestamp: t, connected: true,
    session: {
      type: w.type, phase: w.phase, flag: w.flag, track: 'Test Ring',
      timeRemainingSec: w.timeRemainingSec, totalLaps: 0, lapsRemaining: UNKNOWN,
      currentLap: 5, classLeaderLap: 5, numCars: 7, notStarted: w.notStarted,
      scheduledLengthSec: 1800,
      ...(w.finalLap ? { finalLap: true } : {}),
    },
    player,
    standings: [row(me, true), ...w.rivals.map((c) => row(c, false))],
    relative: [],
    weather: { trackTempC: 30, ambientTempC: 22, rainIntensity: 0, trackWetness: 0, forecast: [] },
    fuel: { levelLiters: 50, capacityLiters: 100, perLapAvgLiters: 3, lapsRemaining: 16, pitThisLap: false },
  };
}

/** The detector, walking a world forward in 250 ms steps; the clock runs down with it. */
function rig(w) {
  const triggers = new EngineerTriggers();
  let now = 1_000_000;
  const cues = [];
  const lines = [];
  triggers.update(frameOf(w, now)); // priming
  const step = (mutate, dt = 250) => {
    if (mutate) mutate(w);
    now += dt;
    if (w.timeRemainingSec > 0) w.timeRemainingSec = Math.max(0, w.timeRemainingSec - dt / 1000);
    const f = frameOf(w, now);
    const cue = triggers.update(f);
    if (cue) {
      cues.push(cue);
      lines.push(phraseForCue(cue, f, 0));
    }
    return cue;
  };
  const hold = (ms) => {
    for (let e = 0; e < ms; e += 250) step(null);
  };
  return {
    w, triggers, cues, lines, step, hold,
    kinds: () => cues.map((c) => c.kind),
    allKinds: () => cues.flatMap((c) => c.triggers.map((t) => t.kind)),
    since: (n) => ({ cues: cues.slice(n), lines: lines.slice(n) }),
    frame: () => frameOf(w, now),
  };
}

/** Complete the player's lap at the line. */
function crossLine(w, lapSec, opts = {}) {
  const me = w.me;
  me.laps += 1;
  if (opts.deleted) {
    me.last = UNKNOWN;
    me.s1 = UNKNOWN;
    me.s2 = UNKNOWN;
  } else {
    me.last = lapSec;
    if (lapSec < me.best || me.best <= 0) me.best = lapSec;
    me.s1 = opts.s1 ?? lapSec * 0.3;
    me.s2 = opts.s2 ?? lapSec * 0.65;
  }
  me.sector = 1;
  me.lapClock = 0.5;
  me.lapValid = true; // the new lap starts clean
  if (opts.inPit !== undefined) me.inPit = opts.inPit;
  if (opts.finished) me.finished = true;
}

/** Drive one clean full lap's worth of time without crossing (mid-lap). */
const midLap = (r, ms = 20_000) => r.hold(ms);

/** A rival sets a new best. */
function rivalBest(w, slotId, best) {
  const c = w.rivals.find((x) => x.slotId === slotId);
  c.best = best;
  c.last = best;
  c.laps += 1;
}

/** Start the world on a lap we watched begin at the line (one silent crossing first). */
function onFlyingLap(r) {
  r.step((w) => crossLine(w, 103.0)); // first crossing after attach: not summarised
  midLap(r);
}

/* -------------------------------------------------------------------------- */
console.log('\n1) The lap summary — once per flying lap, after the line');
/* -------------------------------------------------------------------------- */
{
  const r = rig(world());
  r.step((w) => crossLine(w, 100.4));
  r.hold(20_000);
  check('the lap in progress when we attached is never summarised', r.cues.length === 0, r.kinds().join());

  r.step((w) => crossLine(w, 99.2, { s1: 29.7, s2: 64.5 })); // P3 → P2 in class
  r.hold(4000);
  const c = r.cues.find((x) => x.kind === 'qualiLap');
  check('a flying PB lap gets a summary', !!c, r.kinds().join());
  check('…exactly one call for the lap', r.cues.filter((x) => x.kind === 'qualiLap').length === 1);
  const line = r.lines[r.cues.indexOf(c)];
  check('…saying PB, time and class position (multiclass)', /^Personal best, 1 39\.2, P2 in class\.$/.test(line), line);
  check('…spoken after the line, once the board has re-sorted', c && c.triggers[0].facts.classPosition === 2,
    c && JSON.stringify(c.triggers[0].facts));

  midLap(r, 80_000);
  r.step((w) => crossLine(w, 99.5));
  r.hold(4000);
  const offLine = r.lines[r.lines.length - 1];
  check('a push lap off the best: time, gap, still-position',
    /^1 39\.5, three tenths off your best, still P2 in class\.$/.test(offLine), offLine);

  const before = r.cues.length;
  midLap(r, 80_000);
  r.step((w) => crossLine(w, 104.8)); // a cool-down / abandoned run
  r.hold(4000);
  check('a cool-down lap (5% off) is silent', r.cues.length === before, r.since(before).lines.join(' | '));
}

{
  const r = rig(world());
  onFlyingLap(r);
  r.step((w) => crossLine(w, 98.7)); // beats Ferreira's 99.0 → class pole
  r.hold(4000);
  check('a lap that takes class pole says "Provisional pole"',
    r.lines.some((l) => /^Provisional pole! 1 38\.7\.$/.test(l)), r.lines.join(' | '));
  midLap(r, 80_000);
  r.step((w) => crossLine(w, 98.5));
  r.hold(4000);
  check('improving while on pole: "still on pole"',
    /still on pole/.test(r.lines[r.lines.length - 1] || ''), r.lines[r.lines.length - 1]);
}

{
  const r = rig(world());
  onFlyingLap(r);
  r.step((w) => { w.me.lapValid = false; }); // a cut voids the lap
  r.hold(5000);
  r.step((w) => crossLine(w, 0, { deleted: true }));
  r.hold(4000);
  check('an invalid lap: "Lap\'s deleted — track limits."',
    r.lines.length === 1 && r.lines[0] === "Lap's deleted — track limits.", r.lines.join(' | '));
}

{
  const r = rig(world());
  onFlyingLap(r);
  r.step((w) => { w.me.lapValid = false; });
  r.hold(2000);
  r.step((w) => { w.me.lapValid = true; }); // the sim forgave it
  r.hold(5000);
  r.step((w) => crossLine(w, 99.8));
  r.hold(4000);
  check('a cut the sim forgave is a normal lap, not "deleted"',
    r.lines.length === 1 && !/deleted/.test(r.lines[0]), r.lines.join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\n2) Silence on out-laps, in-laps and in the pit lane');
/* -------------------------------------------------------------------------- */
{
  const r = rig(world());
  onFlyingLap(r);
  // In-lap: dives into the pit lane and crosses the line in it.
  r.step((w) => { w.me.inPit = true; });
  r.hold(3000);
  r.step((w) => crossLine(w, 120.0, { inPit: true }));
  r.hold(30_000);
  check('the in-lap (crossing in the pit lane) is silent', r.cues.length === 0, r.lines.join(' | '));
  // Out-lap: leaves the pits, crosses the line — that lap began in the lane.
  r.step((w) => { w.me.inPit = false; });
  r.hold(40_000);
  r.step((w) => crossLine(w, 115.0));
  r.hold(30_000);
  check('the out-lap is silent', r.cues.length === 0, r.lines.join(' | '));
  // …and the flying lap after it speaks.
  r.step((w) => crossLine(w, 99.9));
  r.hold(4000);
  check('the flying lap after the out-lap speaks', r.kinds().includes('qualiLap'), r.lines.join(' | '));
}

{
  const r = rig(world());
  r.step((w) => { w.notStarted = true; w.phase = 'garage'; });
  r.hold(2000);
  r.step((w) => crossLine(w, 99.0));
  r.hold(5000);
  check('nothing before the session goes green', r.cues.length === 0, r.lines.join(' | '));
}

{
  // In the garage watching Ferreira on the monitor: HER laps are not ours.
  const r = rig(world({ focus: 2 }));
  r.step((w) => { w.me.inPit = true; });
  r.hold(5000);
  for (let i = 0; i < 3; i++) {
    r.step((w) => { const c = w.rivals[0]; c.laps += 1; c.last = 99.4 - i * 0.1; c.best = Math.min(c.best, c.last); });
    r.hold(30_000);
  }
  check('watching another car: its laps are never summarised as ours',
    !r.allKinds().some((k) => k === 'qualiLap' || k === 'sectorImproved'), r.lines.join(' | '));
  r.step((w) => rivalBest(w, 4, 99.9)); // Hale beats OUR time while we watch
  r.hold(6000);
  check('…but our board news still comes through, about our car',
    r.lines.some((l) => l === "Hale's gone quicker — you're P4 in class now."), r.lines.join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\n3) Pole changes hands; being beaten; only your class');
/* -------------------------------------------------------------------------- */
{
  const r = rig(world());
  r.hold(5000);
  r.step((w) => rivalBest(w, 2, 98.8)); // Ferreira improves her own pole
  r.hold(20_000);
  check('the pole-sitter improving is not a pole change', !r.allKinds().includes('qualiPole'), r.lines.join(' | '));

  r.step((w) => rivalBest(w, 5, 98.6)); // Lund from P6 → pole; we drop P3 → P4
  r.hold(6000);
  const pole = r.cues.find((c) => c.kind === 'qualiPole');
  check('a new pole owner is called', !!pole, r.lines.join(' | '));
  check('…with the name, the time, and where it leaves us',
    r.lines.some((l) => /^New pole: Lund, 1 38\.6\. You're P4 in class now\.$/.test(l)), r.lines.join(' | '));
  check('…as ONE call, not a pole call plus a position call', r.cues.length === 1, r.kinds().join());
}

{
  const r = rig(world());
  r.hold(5000);
  r.step((w) => rivalBest(w, 4, 99.9)); // Hale from P4 → P3; we drop P3 → P4
  r.hold(6000);
  check('one car beats us: named, with the new position',
    r.lines.length === 1 && r.lines[0] === "Hale's gone quicker — you're P4 in class now.", r.lines.join(' | '));
}

{
  // End-of-session burst: four cars behind us all go quicker inside a second.
  const r = rig(world());
  r.hold(5000);
  r.step((w) => rivalBest(w, 4, 99.95));
  r.step((w) => rivalBest(w, 5, 99.9));
  r.step((w) => rivalBest(w, 6, 99.8));
  r.step((w) => rivalBest(w, 7, 99.7));
  r.hold(40_000);
  const beaten = r.cues.filter((c) => c.triggers.some((t) => t.kind === 'qualiBeaten'));
  check('four cars beating us in one burst = ONE call', beaten.length === 1, r.lines.join(' | '));
  check('…naming the count and the new position',
    r.lines.length === 1 && r.lines[0] === "Four cars have gone quicker — you're P7 in class now.", r.lines.join(' | '));
}

{
  // A Hypercar (another class) sets the fastest time of the day.
  const r = rig(world());
  r.hold(5000);
  r.step((w) => rivalBest(w, 20, 88.0));
  r.step((w) => w.rivals.push(car(21, 'Hyper Two', 'HYPERCAR', 89.0))); // a new overall P-ahead of us
  r.hold(20_000);
  check('another class going quicker is not our news', r.cues.length === 0, r.lines.join(' | '));
}

{
  // Being beaten while our own flying lap is about to land: held, then spoken after the summary.
  const r = rig(world({}));
  onFlyingLap(r);
  r.step((w) => {
    w.me.lapClock = 90;
    w.me.pd = pd({ tSession: -0.1, lapTimeSec: 90, refSessionSec: 100.0, predictedLapSec: 99.9 });
  });
  r.step((w) => rivalBest(w, 4, 99.9)); // Hale goes quicker 10 s before our line
  r.hold(6000);
  check('board news is held while our own lap is about to land', r.cues.length === 0, r.lines.join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\n4) Time for one more lap');
/* -------------------------------------------------------------------------- */
function pd(over) {
  return {
    tSession: 0, tAllTime: UNKNOWN, tLast: UNKNOWN, vSession: UNKNOWN, vAllTime: UNKNOWN, vLast: UNKNOWN,
    predictedLapSec: 100, lapTimeSec: 30, refSessionSec: 100, refAllTimeSec: UNKNOWN, lastLapSec: UNKNOWN,
    ...over,
  };
}
{
  const r = rig(world({ timeRemainingSec: 400 }));
  onFlyingLap(r); // ~380 s left
  r.hold(60_000); // ~320 s left — at the line two more after this: not news
  r.step((w) => crossLine(w, 100.3));
  r.hold(4000);
  check('plenty of time: the summary carries no clock call',
    r.lines.length === 1 && !/time for|no time/i.test(r.lines[0]), r.lines.join(' | '));
  r.hold(80_000); // ~236 s left: after this lap ~136 s → one more
  r.step((w) => { w.timeRemainingSec = 170; });
  r.step((w) => crossLine(w, 100.2));
  r.hold(4000);
  const one = r.lines[r.lines.length - 1];
  check('one more go: said with the lap summary, as one call',
    /^1 40\.2, two tenths off your best, still P3 in class\. 3 minutes left — time for one more after this\.$/.test(one), one);
  check('…the clock call is its own kind in the cue',
    r.cues[r.cues.length - 1].triggers.some((t) => t.kind === 'qualiTimeLeft'));
  r.hold(80_000);
  r.step((w) => { w.timeRemainingSec = 60; });
  r.step((w) => crossLine(w, 100.6));
  r.hold(4000);
  const last = r.lines[r.lines.length - 1];
  check('no time for another: said once, honestly (timing, not rules)',
    /No time for another after this one\.$/.test(last), last);
}

{
  // Starting a flying lap from an out-lap: no summary, but the clock call stands alone.
  const r = rig(world({ timeRemainingSec: 200 }));
  r.step((w) => { w.me.inPit = true; });
  r.step((w) => crossLine(w, 120, { inPit: true }));
  r.step((w) => { w.me.inPit = false; });
  r.hold(30_000); // out-lap, ~170 s left
  r.step((w) => { w.timeRemainingSec = 150; });
  r.step((w) => crossLine(w, 118)); // out-lap ends, flying lap begins with 150 s left
  r.hold(4000);
  check('out-lap ending: no lap summary, but "time for one more" stands alone',
    r.lines.length === 1 && /time for one more after this\.$/.test(r.lines[0]), r.lines.join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\n5) The grid slot at the flag — once');
/* -------------------------------------------------------------------------- */
{
  const r = rig(world({ timeRemainingSec: 90 }));
  onFlyingLap(r);
  r.step((w) => { w.timeRemainingSec = 0; w.finalLap = true; }); // the chequered is out
  r.hold(5000);
  r.step((w) => crossLine(w, 99.3, { finished: true }));
  r.hold(6000);
  const flag = r.cues.find((c) => c.triggers.some((t) => t.kind === 'qualiGrid'));
  check('the flag lap: lap summary and grid slot in one call', !!flag && flag.triggers.some((t) => t.kind === 'qualiLap'),
    r.lines.join(' | '));
  check('…provisional while class cars are still running',
    r.lines.some((l) => /^Personal best, 1 39\.3, P2 in class\. That's the flag — provisionally P2 in class, P3 overall\.$/.test(l)),
    r.lines.join(' | '));
  const n = r.cues.length;
  r.hold(60_000);
  r.step((w) => { for (const c of w.rivals) c.inPit = true; });
  r.hold(30_000);
  check('the grid call fires once, not again', !r.since(n).cues.some((c) => c.triggers.some((t) => t.kind === 'qualiGrid')),
    r.since(n).lines.join(' | '));
}

{
  // Parked in the garage when the clock runs out, everyone else back in.
  const r = rig(world());
  r.step((w) => { w.me.inPit = true; for (const c of w.rivals) c.inPit = true; });
  r.hold(20_000);
  r.step((w) => { w.timeRemainingSec = 0; w.finalLap = true; });
  r.hold(5000);
  check('in the garage at the flag: "You\'ll start P3 in class, P4 overall."',
    r.lines.length === 1 && r.lines[0] === "That's the flag. You'll start P3 in class, P4 overall.", r.lines.join(' | '));
  r.hold(60_000);
  check('…once', r.lines.length === 1, r.lines.join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\n6) Sector improvements — only improvements, one per lap, never near the line');
/* -------------------------------------------------------------------------- */
{
  const r = rig(world());
  onFlyingLap(r);
  // PB lap with known splits, so the purple estimate has a reference.
  r.step((w) => crossLine(w, 99.8, { s1: 29.9, s2: 64.8 }));
  r.hold(20_000);
  const n = r.cues.length;
  r.step((w) => { w.me.pd = pd({ tSession: -0.2, lapTimeSec: 29.7, refSessionSec: 99.8, predictedLapSec: 99.6 }); w.me.sector = 2; });
  r.hold(3000);
  const s = r.since(n);
  check('S1 two tenths up on the best lap: a short call',
    s.lines.length === 1 && s.lines[0] === 'Sector one, two tenths up.', s.lines.join(' | '));
  r.hold(30_000);
  r.step((w) => { w.me.pd = pd({ tSession: -0.6, lapTimeSec: 64.2, refSessionSec: 99.8, predictedLapSec: 99.2 }); w.me.sector = 3; });
  r.hold(3000);
  check('a second improvement on the same lap stays silent', r.since(n).cues.length === 1, r.since(n).lines.join(' | '));
}

{
  const r = rig(world());
  onFlyingLap(r);
  r.step((w) => crossLine(w, 99.8, { s1: 29.9, s2: 64.8 }));
  r.hold(20_000);
  const n = r.cues.length;
  // S1 29.9 − 0.4 = 29.5 beats Ferreira's 29.6 class best by more than the margin.
  r.step((w) => { w.me.pd = pd({ tSession: -0.4, lapTimeSec: 29.5, refSessionSec: 99.8, predictedLapSec: 99.4 }); w.me.sector = 2; });
  r.hold(3000);
  check('a class-best split: "Purple sector one."', r.since(n).lines[0] === 'Purple sector one.', r.since(n).lines.join(' | '));
}

{
  const r = rig(world());
  onFlyingLap(r);
  r.step((w) => crossLine(w, 99.8, { s1: 29.9, s2: 64.8 }));
  r.hold(60_000);
  const n = r.cues.length;
  r.step((w) => { w.me.pd = pd({ tSession: 0.1, lapTimeSec: 30.0, refSessionSec: 99.8, predictedLapSec: 99.9 }); w.me.sector = 2; });
  r.hold(15_000);
  // S2 three tenths up, but the line is only 12 s away (short final sector).
  r.step((w) => { w.me.pd = pd({ tSession: -0.2, lapTimeSec: 87.5, refSessionSec: 99.8, predictedLapSec: 99.6 }); w.me.sector = 3; });
  r.hold(3000);
  check('S1 down: silent; S2 up but 12 s from the line: silent (the summary owns the line)',
    r.since(n).cues.length === 0, r.since(n).lines.join(' | '));
}

{
  const r = rig(world());
  r.step((w) => { w.me.inPit = true; });
  r.step((w) => crossLine(w, 120, { inPit: true }));
  r.step((w) => { w.me.inPit = false; });
  r.hold(20_000);
  r.step((w) => { w.me.pd = pd({ tSession: -1.0, lapTimeSec: 40, refSessionSec: 100.0 }); w.me.sector = 2; });
  r.hold(3000);
  check('no sector calls on an out-lap', r.cues.length === 0, r.lines.join(' | '));
}

{
  const r = rig(world());
  onFlyingLap(r);
  r.step((w) => { w.me.pd = pd({ tSession: -0.5, lapTimeSec: 29, refSessionSec: 97.0 }); w.me.sector = 2; });
  r.hold(3000);
  check('no sector call when the delta reference is not the sim\'s best lap', r.cues.length === 0, r.lines.join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\n7) Practice — personal bests, deleted laps, light sectors; no pole or grid talk');
/* -------------------------------------------------------------------------- */
{
  const r = rig(world({ type: 'practice' }));
  onFlyingLap(r);
  r.step((w) => crossLine(w, 99.4));
  r.hold(4000);
  check('practice PB: "Personal best, 1 39.4."', r.lines.length === 1 && r.lines[0] === 'Personal best, 1 39.4.', r.lines.join(' | '));
  check('…as practiceLap', r.kinds()[0] === 'practiceLap', r.kinds().join());
  r.hold(80_000);
  r.step((w) => crossLine(w, 99.9));
  r.hold(4000);
  check('a practice lap that is not a best is silent', r.lines.length === 1, r.lines.join(' | '));
  r.hold(30_000);
  r.step((w) => { w.me.lapValid = false; });
  r.hold(30_000);
  r.step((w) => crossLine(w, 0, { deleted: true }));
  r.hold(4000);
  check('practice deleted lap is called', r.lines[r.lines.length - 1] === "Lap's deleted — track limits.", r.lines.join(' | '));
  const n = r.cues.length;
  r.step((w) => rivalBest(w, 5, 95.0)); // someone takes "pole" in practice
  r.hold(20_000);
  r.step((w) => { w.timeRemainingSec = 0; w.finalLap = true; w.me.inPit = true; });
  r.hold(10_000);
  check('no pole, beaten or grid talk in practice', r.since(n).cues.length === 0, r.since(n).lines.join(' | '));
}

{
  const r = rig(world({ type: 'practice' }));
  onFlyingLap(r);
  r.step((w) => crossLine(w, 99.8, { s1: 29.9, s2: 64.8 }));
  r.hold(20_000);
  const n = r.cues.length;
  r.step((w) => { w.me.pd = pd({ tSession: -0.2, lapTimeSec: 29.7, refSessionSec: 99.8, predictedLapSec: 99.6 }); w.me.sector = 2; });
  r.hold(3000);
  check('practice is light: two tenths up is not a call', r.since(n).cues.length === 0, r.since(n).lines.join(' | '));
  midLap(r, 70_000);
  r.step((w) => { w.me.sector = 1; crossLine(w, 100.5); });
  r.hold(30_000);
  const m = r.cues.length;
  r.step((w) => { w.me.pd = pd({ tSession: -0.4, lapTimeSec: 29.5, refSessionSec: 99.8, predictedLapSec: 99.4 }); w.me.sector = 2; });
  r.hold(3000);
  check('…a bigger gain (or purple) is', r.since(m).cues.length === 1 && r.since(m).cues[0].kind === 'sectorImproved',
    r.since(m).lines.join(' | '));
}

/* -------------------------------------------------------------------------- */
console.log('\n8) Races are untouched');
/* -------------------------------------------------------------------------- */
{
  const r = rig(world({ type: 'race' }));
  onFlyingLap(r);
  r.step((w) => crossLine(w, 99.2));
  r.hold(4000);
  r.step((w) => rivalBest(w, 5, 98.0));
  r.hold(10_000);
  const ours = r.allKinds().filter((k) => /^quali|^practiceLap|^sectorImproved/.test(k));
  check('no qualifying/practice kind ever fires in a race', ours.length === 0, ours.join());
}

/* -------------------------------------------------------------------------- */
console.log('\n9) Words: tenths, every variant real');
/* -------------------------------------------------------------------------- */
check('speakableTenths', speakableTenths(0.03) === 'less than a tenth' && speakableTenths(0.12) === 'a tenth' &&
  speakableTenths(-0.31) === 'three tenths' && speakableTenths(1.42) === '1.4 seconds',
  [0.03, 0.12, -0.31, 1.42].map(speakableTenths).join(', '));
{
  const mk = (kind, facts, extra = []) => ({
    atMs: 0, kind, line: kind,
    triggers: [{ kind, atMs: 0, priority: 1, detail: kind, facts }, ...extra],
    context: { sessionType: 'qualifying', phase: 'green', flag: 'green', track: 'T', position: 9,
      classPosition: 3, carClass: 'GT3', numCars: 20, currentLap: 4, lapsRemaining: UNKNOWN },
  });
  const samples = [
    mk('qualiLap', { verdict: 'pb', lapSec: 99.2, classPosition: 2, multiclass: false, gainSec: 0.3 }),
    mk('qualiLap', { verdict: 'first', lapSec: 99.2, classPosition: 9, multiclass: true }),
    mk('qualiLap', { verdict: 'off', lapSec: 99.6, offSec: 0.4, classPosition: 5, samePosition: false, multiclass: false }),
    mk('qualiLap', { verdict: 'deleted' }),
    mk('qualiPole', { name: 'Ana Ferreira', lapSec: 98.1, wasMine: true, classPosition: 2, multiclass: false }),
    mk('qualiBeaten', { from: 3, to: 5, count: 2, multiclass: true }),
    mk('qualiTimeLeft', { verdict: 'tight', timeLeftSec: 95 }),
    mk('qualiGrid', { classPosition: 6, position: 14, multiclass: true, provisional: false }),
    mk('practiceLap', { verdict: 'pb', lapSec: 99.2, gainSec: 0.25 }),
    mk('sectorImproved', { sector: 2, deltaSec: -0.14, purple: false }),
  ];
  let ok = true;
  const bad = [];
  for (const cue of samples) {
    for (let v = 0; v < 5; v++) {
      const line = phraseForCue(cue, null, v);
      const words = line ? line.split(/\s+/).length : 0;
      if (!line || line.length < 5 || words > 16) { ok = false; bad.push(`${cue.kind}/${v}: ${line}`); }
    }
  }
  check('every variant of every kind is a real sentence, short enough for the radio', ok, bad.join(' | '));
  check('pole lost: "Ferreira takes pole off you — 1 38.1. You\'re P2."',
    phraseForCue(samples[4], null, 0) === "Ferreira takes pole off you — 1 38.1. You're P2.", phraseForCue(samples[4], null, 0));
  check('grid: "That\'s the flag. You\'ll start P6 in class, P14 overall."',
    phraseForCue(samples[7], null, 0) === "That's the flag. You'll start P6 in class, P14 overall.", phraseForCue(samples[7], null, 0));
}

/* -------------------------------------------------------------------------- */
console.log('\n10) The preset tiers, and "where do I start"');
/* -------------------------------------------------------------------------- */
{
  const { EngineerService, matchGrammarText } = require('../electron/engineer');
  const make = (preset) => {
    const svc = new EngineerService({
      dir: path.join(require('node:os').tmpdir(), 'apex-sessioncalls-test'),
      loadSettings: () => ({ engineerEnabled: true, engineerVoice: 'en_GB-alan-medium', engineer: { readouts: preset } }),
      onStatus: () => {},
    });
    svc.running = true;
    const spoken = [];
    svc.speak = (t) => spoken.push(t);
    svc.lastFrame = { player: { pedals: { brake: 0 } }, radar: [] };
    return { svc, spoken };
  };
  const cueOf = (kind, facts) => ({
    atMs: 0, kind, line: kind, triggers: [{ kind, atMs: 0, priority: 1, detail: kind, facts }],
    context: { sessionType: 'qualifying', phase: 'green', flag: 'green', track: 'T', position: 9,
      classPosition: 3, carClass: 'GT3', numCars: 20, currentLap: 4, lapsRemaining: UNKNOWN },
  });
  const essential = { qualiLap: { verdict: 'deleted' }, qualiPole: { name: 'A B', lapSec: 98, wasMine: false },
    qualiBeaten: { from: 2, to: 3, count: 1, name: 'A B' }, qualiTimeLeft: { verdict: 'last', timeLeftSec: 50 },
    qualiGrid: { classPosition: 3, provisional: false } };
  for (const [kind, facts] of Object.entries(essential)) {
    const e = make('essential');
    e.svc.onCue(cueOf(kind, facts), e.svc.lastFrame);
    check(`${kind} speaks on the default Essential preset`, e.spoken.length === 1, e.spoken.join());
  }
  for (const [kind, facts] of Object.entries({ sectorImproved: { sector: 1, deltaSec: -0.3, purple: false },
    practiceLap: { verdict: 'pb', lapSec: 99 } })) {
    const e = make('essential');
    e.svc.onCue(cueOf(kind, facts), e.svc.lastFrame);
    const s = make('standard');
    s.svc.onCue(cueOf(kind, facts), s.svc.lastFrame);
    check(`${kind} is opt-in: silent on Essential, spoken on Standard`, e.spoken.length === 0 && s.spoken.length === 1,
      `${e.spoken.length}/${s.spoken.length}`);
  }

  for (const q of ['where do I start', 'what is my grid position', 'grid slot', 'where will I start']) {
    check(`"${q}" → gridStart`, matchGrammarText(q) === 'gridStart', matchGrammarText(q));
  }
  check('"what position am I in" still → position', matchGrammarText('what position am I in') === 'position');

  const cmd = new EngineerCommands();
  const w = world();
  cmd.update(frameOf(w, 1));
  let a = cmd.answer('gridStart');
  check('qualifying, cars running: "Provisionally P3 in class, P4 overall."',
    a.ok && a.text === 'Provisionally P3 in class, P4 overall.', a.text);
  w.me.finished = true;
  for (const c of w.rivals) c.inPit = true;
  cmd.update(frameOf(w, 2));
  a = cmd.answer('gridStart');
  check('qualifying over: "You\'ll start P3 in class, P4 overall."', a.ok && a.text === "You'll start P3 in class, P4 overall.", a.text);
  const w2 = world();
  w2.me.best = UNKNOWN;
  cmd.update(frameOf(w2, 3));
  a = cmd.answer('gridStart');
  check('no time yet: says so', !a.ok && /No lap time/.test(a.text), a.text);
  const w3 = world({ type: 'race' });
  cmd.update(frameOf(w3, 4));
  a = cmd.answer('gridStart');
  check('in a race the old "where did I start" answer is unchanged', /No grid data|Started P/.test(a.text), a.text);
}

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
