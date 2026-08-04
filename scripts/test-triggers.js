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
