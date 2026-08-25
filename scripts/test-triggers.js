/**
 * scripts/test-triggers.js — when the race engineer would speak.
 * -----------------------------------------------------------------------------
 * Phase 0 of the race-engineer feature is a bet: that the moments worth a radio
 * call can be found in the telemetry we already produce, and that the debounce
 * around them can be tuned before any of the expensive parts exist. This script
 * is how that bet gets settled — for free, with no key, no model and no network.
 *
 * Two modes:
 *
 *   node scripts/test-triggers.js
 *       The unit suite. Every gate in `telemetry/triggers.ts` — edge-only, the
 *       per-kind cooldown, the coalesce window, the global interval, the staleness
 *       drop — driven by hand-built frames.
 *
 *   node scripts/test-triggers.js --replay <recording.jsonl> [--tune]
 *       Feed a recorded session through the detector and print **every line it
 *       would have fired**, with the race clock beside it. Recordings come from
 *       `scripts/record-session.js`. This is the tuning loop: watch the race, read
 *       the log, decide whether the engineer spoke at the right moments.
 *
 * Replay tunables (all optional, defaults are the module's):
 *   --coalesce <ms>  --global <ms>  --cooldown <ms>  --fuel-laps <n>  --demo
 *   (`--demo` also replays frames marked `connected: false`, i.e. simulator data.)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  EngineerTriggers,
  TRIGGER_PRIORITY,
  DEFAULT_COALESCE_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_GLOBAL_MIN_INTERVAL_MS,
  DEFAULT_FUEL_WINDOW_LAPS,
} = require('../dist/telemetry/triggers');

/** Sentinel for unknown numerics — mirrors UNKNOWN_VALUE in types.ts. */
const UNKNOWN = -1;

// Replay is a different job from the unit suite, so it takes over the process
// before a single check runs. `replay` and its helpers are function declarations,
// which hoist — the dispatch belongs here, where the reader looks for it, rather
// than a thousand lines below the tests it has to skip.
const argv = process.argv.slice(2);
const replayAt = argv.indexOf('--replay');
if (replayAt !== -1) {
  const num = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : Number(argv[i + 1]);
  };
  const config = {};
  if (num('--coalesce') !== undefined) config.coalesceMs = num('--coalesce');
  if (num('--global') !== undefined) config.globalMinIntervalMs = num('--global');
  if (num('--cooldown') !== undefined) config.cooldownMs = num('--cooldown');
  if (num('--fuel-laps') !== undefined) config.fuelWindowLaps = num('--fuel-laps');
  if (argv.includes('--demo')) config.ignoreDisconnected = false;
  replay(argv[replayAt + 1], config);
  process.exit(0);
}

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

/* -------------------------------------------------------------------------- */
/*  Frame building                                                             */
/* -------------------------------------------------------------------------- */

/** A minimal green-flag race frame; tests override only what they exercise. */
function baseFrame() {
  return {
    schemaVersion: 1,
    source: 'lmu',
    timestamp: 0,
    connected: true,
    session: {
      type: 'race',
      phase: 'green',
      flag: 'green',
      track: 'Test Circuit',
      timeRemainingSec: 1800,
      totalLaps: 0,
      lapsRemaining: 14,
      currentLap: 4,
      numCars: 20,
      notStarted: false,
      scheduledLengthSec: 3600,
    },
    player: {
      slotId: 1,
      position: 7,
      pedals: { throttle: 1, brake: 0, clutch: 0, steer: 0 },
      gear: 5,
      speedKph: 210,
      rpm: 7500,
      maxRpm: 9000,
      lap: { current: 30, last: 100, best: 99, delta: UNKNOWN, sector: 1 },
      tyres: {
        frontLeft: { tempC: 90, wear: 1 },
        frontRight: { tempC: 90, wear: 1 },
        rearLeft: { tempC: 92, wear: 1 },
        rearRight: { tempC: 92, wear: 1 },
      },
      damage: {
        aero: 0,
        suspension: [0, 0, 0, 0],
        brakeThicknessMm: [28, 28, 28, 28],
        partsDetached: 0,
        worst: 0,
        hasDamage: false,
        repairSeconds: 0,
        repairBodySeconds: 0,
        repairSelection: 'unavailable',
        repairOptions: [],
        tyreChangeSeconds: 0,
        tyreCornersSelected: 0,
        stopLengthSeconds: UNKNOWN,
        randomDelayMaxSeconds: UNKNOWN,
      },
      trackLimits: {
        points: 0,
        pointsLimit: 10,
        charges: [],
        charged: 0,
        msSinceCharge: UNKNOWN,
        penalties: 0,
        msSincePenalty: UNKNOWN,
        msSinceServed: UNKNOWN,
      },
    },
    standings: [
      { slotId: 1, position: 7, driverName: 'Player', carClass: 'GT3', classPosition: 3,
        gapToLeaderSec: 21, gapToAheadSec: 1.4, lapsBehind: 0, bestLapSec: 99,
        lastLapSec: 100, lapsCompleted: 3, inPit: false, isPlayer: true },
    ],
    relative: [],
    weather: { trackTempC: 30, ambientTempC: 22, rainIntensity: 0, trackWetness: 0, forecast: [] },
    fuel: {
      levelLiters: 60,
      capacityLiters: 80,
      perLapAvgLiters: 2.6,
      lapsRemaining: 22,
      lapsToFinish: 14,
      fuelToFinishLiters: 37,
      fuelDeltaLiters: 23,
      refuelToFinishLiters: 0,
      pitThisLap: false,
    },
  };
}

/** Deep-merge `over` onto `base` (arrays replaced wholesale). */
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/**
 * A harness that walks the detector forward in 250 ms steps — about the rate the
 * recorder samples at, and fine enough that the 1.5 s coalesce window has room to
 * be tested from either side.
 */
function rig(config, overrides) {
  const triggers = new EngineerTriggers(config);
  let now = 1_000_000;
  let state = merge(baseFrame(), overrides || {});
  const cues = [];

  // The detector's first frame is the one it primes on, so the rig spends one
  // here — on the UNCHANGED state. Without it every test's first change would
  // arrive as the priming frame and could never be an edge, which would make the
  // suite quietly agree with a detector that never fired at all.
  triggers.update(merge(state, { timestamp: now }));

  /** Advance one step with the current state (optionally changed first). */
  const step = (over, dtMs) => {
    if (over) state = merge(state, over);
    now += dtMs === undefined ? 250 : dtMs;
    const frame = merge(state, { timestamp: now });
    const cue = triggers.update(frame);
    if (cue) cues.push(cue);
    return cue;
  };
  /** Hold the current state for `ms`, collecting anything it fires. */
  const hold = (ms) => {
    let last = null;
    for (let elapsed = 0; elapsed < ms; elapsed += 250) last = step(null) || last;
    return last;
  };
  /** Change state, then hold long enough for the coalesce window to close. */
  const fire = (over, ms) => {
    step(over);
    return hold(ms === undefined ? DEFAULT_COALESCE_MS + 500 : ms);
  };

  return {
    triggers,
    step,
    hold,
    fire,
    cues,
    get last() { return cues[cues.length - 1] || null; },
    get stats() { return triggers.getStats(); },
    get nowMs() { return now; },
    kinds: () => cues.map((c) => c.kind),
  };
}

/** Every kind carried by a cue. */
const kindsOf = (cue) => (cue ? cue.triggers.map((t) => t.kind) : []);

/* -------------------------------------------------------------------------- */
/*  1) Priming — the first frame teaches, it does not talk                     */
/* -------------------------------------------------------------------------- */

console.log('\n1) Nothing fires on the frame we arrive on');

{
  // Attaching to a car that is already bent, already penalised and already low
  // on fuel must produce silence: the driver was there for all of it.
  const r = rig({}, {
    player: {
      damage: { hasDamage: true, worst: 0.4 },
      trackLimits: { penalties: 1 },
    },
    fuel: { lapsRemaining: 1.2, pitThisLap: true },
  });
  r.hold(6000);
  check('a mid-race attach says nothing', r.cues.length === 0, `${r.cues.length} cues`);
  check('…but the frames were seen', r.stats.frames > 20, r.stats.frames);
}

{
  const r = rig();
  r.hold(10_000);
  check('a quiet green-flag stint says nothing', r.cues.length === 0, `${r.cues.length} cues`);
}

/* -------------------------------------------------------------------------- */
/*  2) The session's own lifecycle                                             */
/* -------------------------------------------------------------------------- */

console.log('\n2) Green, yellow, restart, white, chequered');

{
  const r = rig({}, { session: { phase: 'countdown', flag: 'none', notStarted: true } });
  r.hold(2000);
  check('the countdown is not a start', r.cues.length === 0, `${r.cues.length} cues`);

  r.step({ session: { phase: 'green', flag: 'green', notStarted: false } });
  check('…and the cue is not emitted instantly', r.cues.length === 0, 'coalescing');

  r.hold(DEFAULT_COALESCE_MS + 500);
  check('the green flag fires once the window closes', r.last?.kind === 'raceStart', r.last?.kind);
  check('…and the line carries the position', /P7/.test(r.last?.line || ''), r.last?.line);

  // A start can only happen once; a flag flicker later must not re-announce it.
  r.hold(40_000);
  r.fire({ session: { phase: 'formation' } });
  r.fire({ session: { phase: 'green' } });
  check('a second "start" is refused', r.kinds().filter((k) => k === 'raceStart').length === 1,
    r.kinds().join(','));
}

{
  const r = rig();
  r.fire({ session: { phase: 'fullCourseYellow', flag: 'doubleYellow' } });
  check('a full-course yellow fires', r.last?.kind === 'fullCourseYellow', r.last?.kind);

  r.hold(35_000);
  r.fire({ session: { phase: 'green', flag: 'green' } });
  check('going back green is a RESTART, not a start', r.last?.kind === 'restart', r.last?.kind);
}

{
  const r = rig();
  r.fire({ session: { flag: 'white' } });
  check('the white flag fires', r.last?.kind === 'finalLap', r.last?.kind);

  r.hold(20_000);
  r.fire({ session: { flag: 'checkered', phase: 'checkered' } });
  check('…and so does the chequered', r.last?.kind === 'checkered', r.last?.kind);
}

/* The end of a race as Le Mans Ultimate actually publishes it, probed through a
   live finish 2026-08-22 (scripts/probe-race-finish.js):

     - there is NO white flag. Ever. The marshalling channel goes clear ->
       CHEQUERED, so the branch this used to wait for had never fired on LMU.
     - the session's own `checkered` phase arrives when the LEADER crosses, 23 s
       after the flag came out and 24 s BEFORE the car being watched finished.
       Congratulating a driver there is congratulating them mid-lap.

   So the last-lap call rides `session.finalLap` and the result rides the car's
   own `player.finished`. */
{
  const r = rig();
  r.fire({ session: { finalLap: true } });
  check('the chequered flag being OUT is the last-lap call',
    r.last?.kind === 'finalLap', r.last?.kind);

  // The leader crossing moves the session phase. A provider that CAN see
  // per-car finishes says so by publishing `finished` at all — false included —
  // and while it says false there is nothing to congratulate.
  r.hold(20_000);
  r.fire({
    session: { finalLap: true, phase: 'checkered', flag: 'checkered' },
    player: { finished: false },
  });
  check('the leader finishing is NOT our chequered call',
    r.kinds().filter((k) => k === 'checkered').length === 0, r.kinds().join(','));

  r.hold(20_000);
  r.fire({
    session: { finalLap: true, phase: 'checkered', flag: 'checkered' },
    player: { finished: true, finishPosition: 4, finishClassPosition: 2 },
  });
  check('OUR car crossing the line is', r.last?.kind === 'checkered', r.last?.kind);
  check('…and it carries the latched result',
    r.last?.triggers?.[0]?.facts?.position === 4 &&
      r.last?.triggers?.[0]?.facts?.classPosition === 2,
    JSON.stringify(r.last?.triggers?.[0]?.facts));

  // Still finished on the next frame is not a second finish.
  r.hold(40_000);
  r.fire({ player: { finished: true, finishPosition: 4 } });
  check('and it only fires once',
    r.kinds().filter((k) => k === 'checkered').length === 1, r.kinds().join(','));
}

{
  // A driver who has already taken the flag is not about to start a last lap.
  const r = rig();
  r.fire({ session: { finalLap: true }, player: { finished: true, finishPosition: 9 } });
  check('no last-lap call to a car that has already finished',
    r.kinds().filter((k) => k === 'finalLap').length === 0, r.kinds().join(','));
}

{
  // A provider with no per-car verdict (plain rF2, demo) must still get a call
  // at the flag — the session phase is the best statement it has.
  const r = rig();
  r.fire({ session: { phase: 'checkered', flag: 'checkered' } });
  check('without a per-car verdict the phase still fires',
    r.last?.kind === 'checkered', r.last?.kind);
}

{
  // The race-lifecycle calls have no meaning in practice: there is no last lap
  // of a practice session, and nobody needs "green flag, P7 of 20" on an out-lap.
  const r = rig({}, {
    session: { type: 'practice', phase: 'countdown', flag: 'none', notStarted: true },
  });
  r.fire({ session: { phase: 'green', flag: 'green', notStarted: false } });
  r.fire({ session: { flag: 'white' } });
  check('practice gets no start and no last lap', r.cues.length === 0, r.kinds().join(','));
  check('…and says why', r.stats.suppressed.sessionType >= 2, r.stats.suppressed.sessionType);
}

/* -------------------------------------------------------------------------- */
/*  3) Contact — the edge, not the level                                       */
/* -------------------------------------------------------------------------- */

console.log('\n3) One shunt is one call');

{
  const r = rig();
  r.fire({ player: { damage: { hasDamage: true, worst: 0.25, repairSeconds: 18 } } });
  check('contact fires', r.last?.kind === 'incident', r.last?.kind);
  check('…with a bucketed severity, not a number',
    r.last?.triggers[0]?.facts.severity === 'moderate', r.last?.triggers[0]?.facts.severity);
  check('…and the sim\'s own repair time', r.last?.triggers[0]?.facts.repairSeconds === 18,
    r.last?.triggers[0]?.facts.repairSeconds);

  // A bent car reads "damaged" for the rest of the stint. That is a level, and
  // the whole point of the edge rule is that it must not re-announce it.
  const before = r.cues.length;
  r.hold(60_000);
  check('the damage sitting there says nothing more', r.cues.length === before,
    `${r.cues.length - before} extra`);
  check('…and the suppression count stays sane', r.stats.suppressed.cooldown <= 2,
    r.stats.suppressed.cooldown);
}

{
  const r = rig();
  r.fire({ player: { damage: { hasDamage: true, worst: 0.2 } } });
  // A second impact inside the cooldown is still the same conversation.
  r.fire({ player: { damage: { worst: 0.45 } } });
  check('a second hit inside the cooldown is held back',
    r.cues.filter((c) => c.kind === 'incident').length === 1, r.kinds().join(','));

  r.hold(30_000);
  r.fire({ player: { damage: { worst: 0.7 } } });
  check('…but a materially worse car after it does fire',
    r.cues.filter((c) => c.kind === 'incident').length === 2, r.kinds().join(','));
  check('…flagged as a repeat', r.last?.triggers[0]?.facts.repeat === true,
    r.last?.triggers[0]?.facts.repeat);
}

{
  const r = rig();
  r.fire({ player: { damage: { hasDamage: true, worst: 0.3 } } });
  r.hold(40_000);
  r.hold(1000);
  r.fire({ player: { damage: { hasDamage: false, worst: 0 } } });   // repaired
  const before = r.cues.length;
  r.hold(30_000);
  r.fire({ player: { damage: { hasDamage: true, worst: 0.1 } } });
  check('after a repair the next contact is new again',
    r.cues.length === before + 1, `${r.cues.length - before}`);
}

/* -------------------------------------------------------------------------- */
/*  4) The stewards                                                            */
/* -------------------------------------------------------------------------- */

console.log('\n4) Penalties, both directions');

{
  const r = rig();
  r.fire({ player: { trackLimits: { penalties: 1, penaltyType: 'DRIVE THRU' } } });
  check('a penalty fires', r.last?.kind === 'penalty', r.last?.kind);
  check('…named when the sim names it', /DRIVE THRU/.test(r.last?.line || ''), r.last?.line);

  r.hold(25_000);
  r.fire({ player: { trackLimits: { penalties: 0 } } });
  check('serving it is its own call', r.last?.kind === 'penaltyServed', r.last?.kind);
}

{
  // The channel being unavailable must not read as a clean sheet, in either
  // direction — this is the same rule the frame's own omit-don't-zero convention
  // encodes.
  const r = rig({}, { player: { trackLimits: { penalties: UNKNOWN } } });
  r.fire({ player: { trackLimits: { penalties: UNKNOWN } } });
  check('an unavailable penalty channel is silent', r.cues.length === 0, r.kinds().join(','));
}

/* -------------------------------------------------------------------------- */
/*  5) Fuel                                                                    */
/* -------------------------------------------------------------------------- */

console.log('\n5) Fuel and energy');

{
  const r = rig();
  r.fire({ fuel: { lapsRemaining: 2.4 } });
  check('crossing into the pit window fires', r.last?.kind === 'fuelWindow', r.last?.kind);
  check('…naming which budget', r.last?.triggers[0]?.facts.budget === 'fuel',
    r.last?.triggers[0]?.facts.budget);

  // The estimate wobbles as the consumption average settles. Hovering on the
  // threshold must not chatter.
  const before = r.cues.length;
  for (let i = 0; i < 12; i++) r.fire({ fuel: { lapsRemaining: i % 2 ? 3.1 : 2.8 } }, 1000);
  check('a figure wobbling on the threshold stays quiet', r.cues.length === before,
    `${r.cues.length - before} extra`);

  // A refuel takes it a clear lap clear of the threshold: the call re-arms.
  r.fire({ fuel: { lapsRemaining: 20 } });
  r.hold(95_000);
  r.fire({ fuel: { lapsRemaining: 2.0 } });
  check('…but after a stop the window call is made again',
    r.cues.filter((c) => c.kind === 'fuelWindow').length === 2, r.kinds().join(','));
}

{
  const r = rig();
  r.fire({ fuel: { pitThisLap: true, pitThisLapReason: 'energy', lapsRemaining: 0.8 } });
  check('"pit this lap" fires as its own, harder call', r.last?.kind === 'fuelCritical',
    r.last?.kind);
  check('…naming energy rather than fuel', /energy/.test(r.last?.line || ''), r.last?.line);
}

{
  // The energy budget being the tighter of the two is what LMU cars actually do.
  const r = rig();
  r.fire({ fuel: { lapsRemaining: 12, virtualEnergyLapsRemaining: 2.2 } });
  check('the tighter budget is the one called',
    r.last?.triggers[0]?.facts.budget === 'energy', r.last?.triggers[0]?.facts.budget);
}

/* -------------------------------------------------------------------------- */
/*  6) Coalescing and priority                                                 */
/* -------------------------------------------------------------------------- */

console.log('\n6) One calm sentence, not five overlapping ones');

{
  // Contact, and then a penalty for the same moment, a quarter of a second
  // apart. A real engineer says that once.
  const r = rig();
  r.step({ player: { damage: { hasDamage: true, worst: 0.3 } } });
  r.step({ player: { trackLimits: { penalties: 1 } } });
  r.hold(DEFAULT_COALESCE_MS + 500);

  check('two edges make one cue', r.cues.length === 1, `${r.cues.length} cues`);
  check('…carrying both', kindsOf(r.last).length === 2, kindsOf(r.last).join(','));
  check('…led by the contact', r.last?.kind === 'incident', r.last?.kind);
  check('…in priority order',
    kindsOf(r.last).length === 2 && r.last.triggers[0].priority >= r.last.triggers[1].priority,
    r.last?.triggers.map((t) => t.priority).join('>'));
  check('…and the line reads as one sentence', /\+/.test(r.last?.line || ''), r.last?.line);
}

{
  const r = rig();
  r.step({ session: { phase: 'redFlag', flag: 'red' } });
  r.step({ player: { damage: { hasDamage: true, worst: 0.6 } } });
  r.hold(DEFAULT_COALESCE_MS + 500);
  check('a red flag outranks the damage that caused it', r.last?.kind === 'redFlag', r.last?.kind);
  check('…and the priority table agrees',
    TRIGGER_PRIORITY.redFlag > TRIGGER_PRIORITY.incident, 'redFlag > incident');
}

/* -------------------------------------------------------------------------- */
/*  7) The global gate, and why held lines expire                              */
/* -------------------------------------------------------------------------- */

console.log('\n7) At most one line every N seconds — and late is worse than never');

{
  const r = rig({ globalMinIntervalMs: 20_000, maxHoldMs: 4000 });
  r.fire({ player: { damage: { hasDamage: true, worst: 0.3 } } });
  check('the first call goes out', r.cues.length === 1, `${r.cues.length}`);

  // Something else happens five seconds later: inside the global interval.
  r.hold(5000);
  r.fire({ player: { trackLimits: { penalties: 1 } } });
  check('a second call inside the interval is not made', r.cues.length === 1, `${r.cues.length}`);

  // …and it is DROPPED, not queued. Nothing arrives when the gate opens.
  r.hold(30_000);
  check('…and never arrives late', r.cues.length === 1, r.kinds().join(','));
  check('…counted as stale', r.stats.suppressed.stale >= 1, r.stats.suppressed.stale);
}

{
  // Past the interval, the next real thing is said normally.
  const r = rig({ globalMinIntervalMs: 10_000 });
  r.fire({ player: { damage: { hasDamage: true, worst: 0.3 } } });
  r.hold(15_000);
  r.fire({ player: { trackLimits: { penalties: 1 } } });
  check('past the interval the engineer speaks again', r.cues.length === 2, r.kinds().join(','));
}

/* -------------------------------------------------------------------------- */
/*  8) Session boundaries and dead feeds                                       */
/* -------------------------------------------------------------------------- */

console.log('\n8) Sessions, demo frames, and a clock that goes backwards');

{
  const r = rig();
  r.fire({ player: { damage: { hasDamage: true, worst: 0.3 } } });
  const before = r.cues.length;
  // A new session: the damage is on a different car in a different race, and the
  // detector must re-prime rather than re-announce.
  r.fire({ session: { track: 'Another Circuit' } });
  r.hold(10_000);
  check('a new session re-primes silently', r.cues.length === before, r.kinds().join(','));
}

{
  // The simulator's placeholder frames are not a car anyone is driving.
  const r = rig({}, { connected: false });
  r.fire({ player: { damage: { hasDamage: true, worst: 0.5 } } });
  r.fire({ player: { trackLimits: { penalties: 2 } } });
  check('demo frames are ignored', r.cues.length === 0, r.kinds().join(','));
  check('…and not even counted as frames', r.stats.frames === 0, r.stats.frames);
}

{
  // Replaying a recording twice, or reattaching to a feed, sends the clock
  // backwards — every cooldown would then sit in the future forever.
  const r = rig();
  r.fire({ player: { damage: { hasDamage: true, worst: 0.3 } } });
  check('the first pass fires', r.cues.length === 1, `${r.cues.length}`);
  r.step(null, -600_000);           // clock jumps back ten minutes
  r.hold(2000);
  r.fire({ player: { damage: { hasDamage: false, worst: 0 } } });
  r.fire({ player: { damage: { hasDamage: true, worst: 0.3 } } });
  check('a backwards clock resets rather than gagging the engineer',
    r.cues.length === 2, `${r.cues.length}`);
}

/* -------------------------------------------------------------------------- */
/*  9) The cost of the layer itself                                            */
/* -------------------------------------------------------------------------- */

console.log('\n9) The layer has to be free at 30 Hz');

{
  const triggers = new EngineerTriggers();
  const frame = baseFrame();
  const started = process.hrtime.bigint();
  const N = 60 * 30 * 30;                       // half an hour at 30 Hz
  for (let i = 0; i < N; i++) {
    frame.timestamp = 1_000_000 + i * 33;
    triggers.update(frame);
  }
  const perFrameUs = Number(process.hrtime.bigint() - started) / 1000 / N;
  check('a quiet frame costs well under 10 µs', perFrameUs < 10, `${perFrameUs.toFixed(2)} µs`);
  check('…and half an hour of them says nothing', triggers.getStats().cues === 0,
    triggers.getStats().cues);
}

/* -------------------------------------------------------------------------- */
/*  10) The race-story kinds (Standard preset, v3)                             */
/* -------------------------------------------------------------------------- */

console.log('\n10) The race-story kinds fire on edges the standings can prove');

/** A rival row in the player's class, for the story detectors. */
function rival(slotId, over) {
  return {
    slotId, position: slotId, driverName: `Rival ${slotId}`, carClass: 'GT3',
    classPosition: slotId, gapToLeaderSec: 5, gapToAheadSec: 1, lapsBehind: 0,
    bestLapSec: UNKNOWN, lastLapSec: UNKNOWN, lapsCompleted: 3, inPit: false,
    isPlayer: false, ...over,
  };
}
/** The base player row (classPosition 3) with overrides. */
function playerRowOver(over) {
  return {
    slotId: 1, position: 7, driverName: 'Player', carClass: 'GT3', classPosition: 3,
    gapToLeaderSec: 21, gapToAheadSec: 1.4, lapsBehind: 0, bestLapSec: 99,
    lastLapSec: 100, lapsCompleted: 3, inPit: false, isPlayer: true, ...over,
  };
}

{
  // A personal best is an IMPROVEMENT — the first recorded best stays silent.
  const r = rig({}, { standings: [playerRowOver({ bestLapSec: UNKNOWN })] });
  r.fire({ standings: [playerRowOver({ bestLapSec: 99 })] });
  check('the first best lap of the session is not news', r.cues.length === 0, r.kinds().join());
  const cue = r.fire({ standings: [playerRowOver({ bestLapSec: 98.4 })] });
  check('improving on it is', cue && cue.kind === 'fastestLapSelf', cue && cue.line);
  check('…and the time rides in the facts', cue && cue.triggers[0].facts.lapSec === 98.4,
    cue && JSON.stringify(cue.triggers[0].facts));
}

{
  // Field fastest: fires when it changes OWNER, not when the holder improves.
  const field = (aBest, bBest) => ({
    standings: [playerRowOver({}), rival(2, { bestLapSec: aBest }), rival(4, { bestLapSec: bBest })],
  });
  const r = rig({}, field(97, 98));
  r.fire(field(96.5, 98)); // the holder goes quicker — same owner, no call
  check('the holder improving is not a change of hands', !r.kinds().includes('fastestLapField'), r.kinds().join());
  const cue = r.fire(field(96.5, 96.2));
  check('a rival taking it is', cue && cue.kind === 'fastestLapField', cue && cue.line);
  check('…named, with the time', cue && cue.triggers[0].facts.name === 'Rival 4', cue && JSON.stringify(cue.triggers[0].facts));
}

{
  // The holder vanishing (disconnect) recomputes the minimum to a SLOWER lap —
  // which must not read as a purple.
  const r = rig({}, {
    standings: [playerRowOver({}), rival(2, { bestLapSec: 97 }), rival(4, { bestLapSec: 98 })],
  });
  r.fire({ standings: [playerRowOver({}), rival(4, { bestLapSec: 98 })] });
  check('a disconnecting holder is not a fastest lap', !r.kinds().includes('fastestLapField'), r.kinds().join());
}

{
  // The player taking the overall fastest is fastestLapSelf's story, not field's.
  const r = rig({}, { standings: [playerRowOver({ bestLapSec: 99 }), rival(2, { bestLapSec: 97 })] });
  const cue = r.fire({ standings: [playerRowOver({ bestLapSec: 96.5 }), rival(2, { bestLapSec: 97 })] });
  check('your own purple speaks as your lap', cue && cue.kind === 'fastestLapSelf', cue && cue.line);
  check('…never as the field call', !r.kinds().includes('fastestLapField'), r.kinds().join());
}

{
  // Position changes: real ones speak — once they have HELD for the settle
  // window — while lap 1, the pit lane and standings flickers stay quiet.
  const r = rig({}, {});
  const cue = r.fire({ standings: [playerRowOver({ position: 6 })] }, 5000);
  check('a place gained on track speaks once it settles', cue && cue.kind === 'positionChange', cue && cue.line);
  check('…with direction in the facts', cue && cue.triggers[0].facts.gained === true,
    cue && JSON.stringify(cue.triggers[0].facts));

  const r2 = rig({}, { session: { currentLap: 1 } });
  r2.fire({ standings: [playerRowOver({ position: 3 })] }, 5000);
  check('lap-1 shuffles are the start, not news', !r2.kinds().includes('positionChange'), r2.kinds().join());

  const r3 = rig({}, { player: { pit: { phase: 'stopped', working: true, elapsedSec: 4, plannedSec: 30, slackSec: 0 } } });
  r3.fire({ standings: [playerRowOver({ position: 9 })] }, 5000);
  check('places lost while stationary in the box are not', !r3.kinds().includes('positionChange'), r3.kinds().join());

  // The 2026-08-19 replay glitch: the feed flicked P1 → P25 for a moment and
  // the engineer announced it. A change that does not survive the settle
  // window is a feed artefact, not an overtake.
  const r4 = rig({}, {});
  r4.step({ standings: [playerRowOver({ position: 25 })] });
  r4.hold(1000); // flicker holds for only a second…
  r4.step({ standings: [playerRowOver({ position: 7 })] }); // …then snaps back
  r4.hold(6000);
  check('a standings flicker never speaks', !r4.kinds().includes('positionChange'), r4.kinds().join());

  // …but a genuine crash that STAYS lost is announced once, settled.
  const r5 = rig({}, {});
  const settled = r5.fire({ standings: [playerRowOver({ position: 25 })] }, 6000);
  check('a real fall through the field speaks once settled',
    settled && settled.kind === 'positionChange' && settled.triggers[0].facts.to === 25,
    settled && settled.line);
}

{
  // The class neighbour boxing.
  const grid = (aheadInPit) => ({
    standings: [playerRowOver({}), rival(2, { classPosition: 2, inPit: aheadInPit }), rival(4, { classPosition: 4 })],
  });
  const r = rig({}, grid(false));
  const cue = r.fire(grid(true));
  check('the car ahead pitting speaks', cue && cue.kind === 'rivalPitted', cue && cue.line);
  check('…and says which side', cue && cue.triggers[0].facts.where === 'ahead',
    cue && JSON.stringify(cue.triggers[0].facts));
}

{
  // The strategy window opening, off the fuel calculator's own lap.
  const r = rig({}, { fuel: { pitWindowOpenLap: 6 } });
  r.fire({ session: { currentLap: 5 } });
  check('one lap short of the window stays quiet', !r.kinds().includes('pitWindowOpen'), r.kinds().join());
  const cue = r.fire({ session: { currentLap: 6 } });
  check('reaching it speaks', cue && cue.kind === 'pitWindowOpen', cue && cue.line);
}

{
  // Blue flags ride the relative feed's own yieldTo — and work in ANY session.
  const r = rig({}, { session: { type: 'practice' } });
  const cue = r.fire({
    relative: [{ slotId: 9, position: 2, driverName: 'Hyper Car', relativeGapSec: -2.1,
      lapsDifference: 0, inPit: false, isPlayer: false, yieldTo: true }],
  });
  check('a faster class closing speaks even in practice', cue && cue.kind === 'yieldTo', cue && cue.line);
  check('…with the name and gap', cue && cue.triggers[0].facts.name === 'Hyper Car' && cue.triggers[0].facts.gapSec === 2.1,
    cue && JSON.stringify(cue.triggers[0].facts));
}

{
  // …but the race-story kinds are race-only: qualifying purples are chatter.
  const r = rig({}, { session: { type: 'qualifying' }, standings: [playerRowOver({ bestLapSec: 99 })] });
  r.fire({ standings: [playerRowOver({ bestLapSec: 95 })] });
  check('a qualifying personal best stays off the radio', r.cues.length === 0, r.kinds().join());
  check('…counted as a session-type suppression', r.stats.suppressed.sessionType > 0, r.stats.suppressed.sessionType);
}

{
  // Practice pace: first resolved benchmark, a faster band, then one unchanged
  // reminder after four completed laps. It never runs in qualifying.
  const pace = (over) => ({
    ok: true,
    percent: 104,
    bandLabel: 'Midpack',
    bandId: 'midpack',
    deltaSec: 4,
    refSec: 100,
    lapSec: 104,
    layoutName: 'Grand Prix',
    sheetClass: 'LMGT3',
    ...over,
  });
  const practice = rig({}, {
    session: { type: 'practice' },
    standings: [playerRowOver({ lapsCompleted: 0, bestLapSec: UNKNOWN })],
    player: { paceScore: { ok: false, lapSec: UNKNOWN } },
  });
  let cue = practice.fire({
    standings: [playerRowOver({ lapsCompleted: 1, bestLapSec: 104 })],
    player: { paceScore: pace({}) },
  });
  check('first scored practice lap establishes the benchmark',
    cue && cue.kind === 'practicePace' && cue.triggers[0].facts.reason === 'first',
    cue && cue.line);
  check('practice benchmark carries band and target gaps',
    cue && cue.triggers[0].facts.band === 'Midpack' &&
      cue.triggers[0].facts.deltaAlienSec === 4 &&
      cue.triggers[0].facts.deltaCompetitiveSec === 3,
    cue && JSON.stringify(cue.triggers[0].facts));

  practice.hold(90_000);
  cue = practice.fire({
    standings: [playerRowOver({ lapsCompleted: 2, bestLapSec: 100.8 })],
    player: { paceScore: pace({
      percent: 100.8, bandLabel: 'Competitive', bandId: 'competitive',
      deltaSec: 0.8, lapSec: 100.8,
    }) },
  });
  check('moving into a faster band speaks immediately',
    cue && cue.kind === 'practicePace' && cue.triggers[0].facts.reason === 'band-improved',
    cue && cue.line);

  practice.hold(90_000);
  cue = practice.fire({
    standings: [playerRowOver({ lapsCompleted: 6, bestLapSec: 100.8 })],
  });
  check('unchanged practice pace repeats only after four laps',
    cue && cue.kind === 'practicePace' && cue.triggers[0].facts.reason === 'periodic',
    cue && cue.line);

  const quali = rig({}, {
    session: { type: 'qualifying' },
    standings: [playerRowOver({ lapsCompleted: 0, bestLapSec: UNKNOWN })],
    player: { paceScore: { ok: false, lapSec: UNKNOWN } },
  });
  quali.fire({
    standings: [playerRowOver({ lapsCompleted: 1, bestLapSec: 104 })],
    player: { paceScore: pace({}) },
  });
  check('reference race-pace reminders stay out of qualifying',
    !quali.kinds().includes('practicePace'), quali.kinds().join());

  const live = rig({}, {
    session: { type: 'practice' },
    standings: [playerRowOver({ lapsCompleted: 0, bestLapSec: UNKNOWN })],
    player: { paceScore: { ok: false, lapSec: UNKNOWN } },
  });
  live.fire({
    standings: [playerRowOver({ lapsCompleted: 1, bestLapSec: 104 })],
    player: { paceScore: pace({}) },
  });
  live.hold(90_000);
  live.triggers.setPracticePaceLapInterval(2);
  cue = live.fire({
    standings: [playerRowOver({ lapsCompleted: 3, bestLapSec: 104 })],
  });
  check('a live frequency change preserves state and uses the new interval',
    cue && cue.kind === 'practicePace' && cue.triggers[0].facts.reason === 'periodic',
    cue && cue.line);
}

/* -------------------------------------------------------------------------- */
/*  11) The phrasebook — every cue has words, and the words carry the facts    */
/* -------------------------------------------------------------------------- */

console.log('\n11) The phrasebook turns cues into radio lines');

{
  const { phraseForCue } = require('../dist/telemetry/engineerPhrases');

  // Collect one real cue per kind by driving the detector, then insist every
  // one of them speaks. A kind with no words is a silent trigger — legal for
  // future kinds, but every kind that EXISTS today must have a line.
  const collected = new Map();
  const collect = (r) => { for (const c of r.cues) collected.set(c.kind, c); };

  const r1 = rig({}, { session: { phase: 'formation', flag: 'none', notStarted: true }, standings: [playerRowOver({})] });
  r1.fire({ session: { phase: 'green', flag: 'green', notStarted: false } });
  r1.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r1.fire({ session: { phase: 'fullCourseYellow', flag: 'doubleYellow' } });
  r1.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r1.fire({ session: { phase: 'green', flag: 'green' } });
  r1.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r1.fire({ session: { flag: 'white' } });
  r1.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r1.fire({ session: { flag: 'checkered', phase: 'checkered' } });
  collect(r1);

  const r2 = rig({}, {});
  r2.fire({ player: { damage: { hasDamage: true, worst: 0.3, repairSeconds: 14 } } });
  r2.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r2.fire({ player: { trackLimits: { penalties: 1, penaltyType: 'STOP/GO' } } });
  r2.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r2.fire({ player: { trackLimits: { penalties: 0 } } });
  r2.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r2.fire({ fuel: { lapsRemaining: 2.5 } });
  r2.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r2.fire({ fuel: { pitThisLap: true, pitThisLapReason: 'fuel' } });
  collect(r2);

  const r3 = rig({}, { standings: [playerRowOver({})] });
  r3.fire({ session: { phase: 'redFlag', flag: 'red' } });
  collect(r3);

  // One rolling race for the story kinds. The standings array is replaced
  // wholesale by the rig's merge, so each step re-states the whole grid.
  const grid = (s) => ({
    standings: [
      playerRowOver({ bestLapSec: s.pBest, position: s.pPos ?? 7 }),
      rival(2, { classPosition: 2, bestLapSec: s.r2Best, inPit: s.r2Pit === true }),
      rival(5, { classPosition: 5, bestLapSec: s.r5Best }),
    ],
  });
  const r4 = rig({}, grid({ pBest: 99, r2Best: 97, r5Best: 98 }));
  r4.fire(grid({ pBest: 98.2, r2Best: 97, r5Best: 98 })); // personal best
  r4.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r4.fire(grid({ pBest: 98.2, r2Best: 97, r5Best: 96.1 })); // purple changes hands
  r4.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r4.fire(grid({ pBest: 98.2, r2Best: 97, r5Best: 96.1, pPos: 6 })); // place gained
  r4.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r4.fire(grid({ pBest: 98.2, r2Best: 97, r5Best: 96.1, pPos: 6, r2Pit: true })); // rival boxes
  r4.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r4.fire({ fuel: { pitWindowOpenLap: 4 } });
  r4.hold(DEFAULT_GLOBAL_MIN_INTERVAL_MS);
  r4.fire({ relative: [{ slotId: 9, position: 2, driverName: 'Hyper Car', relativeGapSec: -2.1,
    lapsDifference: 0, inPit: false, isPlayer: false, yieldTo: true }] });
  collect(r4);

  const r5 = rig({}, {
    session: { type: 'practice' },
    standings: [playerRowOver({ lapsCompleted: 0, bestLapSec: UNKNOWN })],
    player: { paceScore: { ok: false, lapSec: UNKNOWN } },
  });
  r5.fire({
    standings: [playerRowOver({ lapsCompleted: 1, bestLapSec: 104 })],
    player: { paceScore: {
      ok: true, percent: 104, bandLabel: 'Midpack', bandId: 'midpack',
      deltaSec: 4, refSec: 100, lapSec: 104,
    } },
  });
  collect(r5);

  const expected = [
    'raceStart', 'fullCourseYellow', 'restart', 'finalLap', 'checkered',
    'incident', 'penalty', 'penaltyServed', 'fuelWindow', 'fuelCritical', 'redFlag',
    'fastestLapSelf', 'fastestLapField', 'positionChange', 'rivalPitted', 'pitWindowOpen', 'yieldTo',
    'practicePace',
  ];
  for (const kind of expected) {
    const cue = collected.get(kind);
    if (!cue) {
      check(`${kind}: cue collected for the phrase check`, false, 'never fired in the harness');
      continue;
    }
    // Variant 0 pins the canonical line; every other variant must also be a
    // real sentence — an empty alternate would be a silent radio call.
    const line = phraseForCue(cue, null, 0);
    check(`${kind}: has words`, typeof line === 'string' && line.length > 4, line);
    for (let v = 1; v <= 4; v++) {
      const alt = phraseForCue(cue, null, v);
      if (typeof alt !== 'string' || alt.length <= 4) {
        check(`${kind}: variant ${v} is a real sentence`, false, String(alt));
      }
    }
  }
  check('every variant of every kind is a real sentence', true);

  // Spot-check that the words carry the cue's own facts, not placeholders —
  // pinned to variant 0, the canonical wording.
  const pb = collected.get('fastestLapSelf');
  check('fastestLapSelf speaks the time', pb && /1 38\.2/.test(phraseForCue(pb, null, 0)), pb && phraseForCue(pb, null, 0));
  const blue = collected.get('yieldTo');
  check('yieldTo names the car and the gap',
    blue && /Blue flags — Car closing, 2\.1 seconds back/.test(phraseForCue(blue, null, 0)),
    blue && phraseForCue(blue, null, 0));
  const pos = collected.get('positionChange');
  check('positionChange speaks the new place', pos && /P6/.test(phraseForCue(pos, null, 0)), pos && phraseForCue(pos, null, 0));
  const pen = collected.get('penalty');
  check('penalty names the type', pen && /STOP\/GO/.test(phraseForCue(pen, null, 0)), pen && phraseForCue(pen, null, 0));
  const practicePace = collected.get('practicePace');
  check('practicePace speaks the best, band and target gap',
    practicePace && /1 44\.0/.test(phraseForCue(practicePace, null, 0)) &&
      /Midpack/.test(phraseForCue(practicePace, null, 0)) &&
      /3\.0 seconds to competitive pace/.test(phraseForCue(practicePace, null, 0)),
    practicePace && phraseForCue(practicePace, null, 0));

  // The variation machinery itself: alternates differ, every variant of a
  // bank carries the same facts, and the derived pick is deterministic — a
  // replay must produce the same radio twice.
  if (pb) {
    const v0 = phraseForCue(pb, null, 0);
    const v1 = phraseForCue(pb, null, 1);
    check('variants are different sentences', v0 !== v1, `${v0} | ${v1}`);
    for (let v = 0; v <= 3; v++) {
      const line = phraseForCue(pb, null, v);
      if (!/1 38\.2/.test(line)) {
        check(`fastestLapSelf variant ${v} still carries the time`, false, line);
      }
    }
    check('every variant carries the facts', true);
    check('the derived pick is deterministic',
      phraseForCue(pb, null) === phraseForCue(pb, null), phraseForCue(pb, null));
  }
}

/* -------------------------------------------------------------------------- */
/*  Replay mode                                                                */
/* -------------------------------------------------------------------------- */

/** `hh:mm:ss` from the start of the recording. */
function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function replay(file, config) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`no such recording: ${abs}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const triggers = new EngineerTriggers(config);

  let firstMs = 0;
  let frames = 0;
  let bad = 0;

  console.log(`\nReplaying ${path.basename(abs)}`);
  console.log(
    `  coalesce=${config.coalesceMs ?? DEFAULT_COALESCE_MS}ms  ` +
    `global=${config.globalMinIntervalMs ?? DEFAULT_GLOBAL_MIN_INTERVAL_MS}ms  ` +
    `cooldown=${config.cooldownMs ?? DEFAULT_COOLDOWN_MS}ms  ` +
    `fuelWindow=${config.fuelWindowLaps ?? DEFAULT_FUEL_WINDOW_LAPS} laps\n`,
  );

  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      bad++;
      continue;
    }
    // A recording's header line describes the session, not a frame.
    if (!frame || !frame.session || !frame.timestamp) continue;
    frames++;
    if (!firstMs) firstMs = frame.timestamp;

    const cue = triggers.update(frame);
    if (cue) {
      console.log(`  ${clock(cue.atMs - firstMs)}  [${cue.kind}] ${cue.line}`);
    }
  }

  const stats = triggers.getStats();
  console.log(`\n  ${frames} frames read (${stats.frames} live)${bad ? `, ${bad} unparseable` : ''}`);
  console.log(`  ${stats.cues} cues fired` +
    (stats.cues ? `: ${Object.entries(stats.fired).map(([k, n]) => `${k}×${n}`).join(', ')}` : ''));
  const s = stats.suppressed;
  console.log(
    `  suppressed — cooldown ${s.cooldown}, global interval ${s.global}, stale ${s.stale}, ` +
    `once-only ${s.once}, wrong session ${s.sessionType}`,
  );
  console.log(
    '\n  Read the suppressions as the tuning signal: a high "global interval" count means the\n' +
    '  minimum gap is eating real news, and a high "cooldown" count means a detector is chattering.\n',
  );
}

/* -------------------------------------------------------------------------- */
/*  Result                                                                     */
/* -------------------------------------------------------------------------- */

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
