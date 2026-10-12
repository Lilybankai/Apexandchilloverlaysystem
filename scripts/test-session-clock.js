/**
 * scripts/test-session-clock.js — the session clock after rejoining a race.
 *
 * The regression this pins down (THE-33, Carl, 2026-10): mid-race, leave the
 * session / stop and start the overlays, come back — and everything reads
 * right except the time and laps remaining, which reset to the whole race.
 *
 * The clock came from REST `timeRemainingInGamePhase`, which LMU computes on
 * the CLIENT as `maxTime − (currentEventTime − startEventTime)`, with
 * `startEventTime` latched when this client sees the green. A client that loads
 * back into a race in progress sees a fresh green, so the timer restarts from
 * the full length. The fix reads the session's absolute end from shared memory
 * (`mEndET − mCurrentET`) first — see src/telemetry/sessionClock.ts.
 *
 * Every number below is from a real capture: the 6 h ELMS MP race at
 * Silverstone, 2026-08-22 (~/.apex-overlay/finish-probe-*.jsonl):
 *   REST  currentEventTime 21567.8, endEventTime 21600, maxTime 21600,
 *         startEventTime 172.0225, timeRemainingInGamePhase 204.09
 *   MMF   mCurrentET 21567.6, mEndET 21772
 * The "rejoined" REST payload is that one as a client that loaded back in at
 * ET 21540 sees it: its green latched at 21540, its phase timer near 6 h.
 *
 * Run: node scripts/test-session-clock.js   (needs a built dist/)
 */

'use strict';

const path = require('node:path');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? `   [${detail}]` : ''));
  ok ? pass++ : fail++;
};

const dist = path.join(__dirname, '..', 'dist', 'telemetry');
const { resolveTimeRemaining } = require(path.join(dist, 'sessionClock.js'));
const { LmuRestProvider } = require(path.join(dist, 'lmuRestProvider.js'));
const { UNKNOWN_VALUE } = require(path.join(dist, 'types.js'));

// --- The captured race --------------------------------------------------------
const TRUE_LEFT = 204; // what the race actually had to run at this instant
const FLT_MIN = 1.1754943508222875e-38; // LMU's "green not latched yet"

const restInRace = {
  currentEventTime: 21567.8,
  endEventTime: 21600,
  maxTime: 21600,
  startEventTime: 172.0225067138672,
  timeRemainingInGamePhase: 204.09375,
};
const REJOIN_ET = 21540;
const restRejoined = {
  ...restInRace,
  startEventTime: REJOIN_ET,
  timeRemainingInGamePhase: 21600 - (21567.8 - REJOIN_ET), // 21572.2 — "6:59:32"
};
const smInRace = { currentET: 21567.6, endET: 21772.0225 };

const near = (v, want, tol = 1) => Math.abs(v - want) <= tol;

try {
  console.log('\nresolveTimeRemaining — a client that was in the race from the start');
  let r = resolveTimeRemaining({ running: true, rest: restInRace, sharedMemory: smInRace });
  check('shared memory answers', r.source === 'sharedMemory', r.source);
  check('and agrees with the phase timer', near(r.sec, TRUE_LEFT), r.sec);
  r = resolveTimeRemaining({ running: true, rest: restInRace, sharedMemory: null });
  check('no shared memory: the REST timer, as before', r.source === 'restPhase' && near(r.sec, TRUE_LEFT), `${r.source} ${r.sec}`);

  console.log('\nresolveTimeRemaining — the same instant after leaving and rejoining (THE-33)');
  r = resolveTimeRemaining({ running: true, rest: restRejoined, sharedMemory: smInRace });
  check('the true time left, not the whole race', near(r.sec, TRUE_LEFT), r.sec);
  check('read from the server end time', r.source === 'sharedMemory', r.source);
  check(
    'the REST timer really is the bug it looks like',
    restRejoined.timeRemainingInGamePhase > 21000,
    restRejoined.timeRemainingInGamePhase,
  );

  console.log('\nresolveTimeRemaining — shared memory it must NOT believe');
  // A mapping left over from the previous session: its clock is somewhere else.
  r = resolveTimeRemaining({
    running: true,
    rest: restInRace,
    sharedMemory: { currentET: 3500, endET: 3722 },
  });
  check('stale mapping (clock 18000 s away): falls back to REST', r.source === 'restPhase' && near(r.sec, TRUE_LEFT), `${r.source} ${r.sec}`);
  r = resolveTimeRemaining({ running: true, rest: restInRace, sharedMemory: { currentET: 21567.6, endET: 0 } });
  check('no end time published: falls back to REST', r.source === 'restPhase', r.source);
  r = resolveTimeRemaining({ running: true, rest: restInRace, sharedMemory: { currentET: NaN, endET: NaN } });
  check('torn/garbage read: falls back to REST', r.source === 'restPhase', r.source);
  r = resolveTimeRemaining({
    running: true,
    rest: restInRace,
    sharedMemory: { currentET: 21567.6, endET: 21567.6 + 4294967295 },
  });
  check('sentinel-sized end: falls back to REST', r.source === 'restPhase', r.source);

  console.log('\nresolveTimeRemaining — the flag and after');
  r = resolveTimeRemaining({
    running: true,
    rest: { ...restInRace, currentEventTime: 21790, timeRemainingInGamePhase: -1 },
    sharedMemory: { currentET: 21790, endET: 21772.0225 },
  });
  check('clock expired, leader still to cross: 0, not negative', r.sec === 0, r.sec);

  console.log('\nresolveTimeRemaining — pre-green keeps its old behaviour');
  // Formation at Daytona (2026-08-04): no green latched, phase timer -1. The
  // fuel planner reads "about the whole race" here; nothing may change.
  const formation = {
    currentEventTime: 60,
    endEventTime: 3600,
    maxTime: 3600,
    startEventTime: FLT_MIN,
    timeRemainingInGamePhase: -1,
  };
  r = resolveTimeRemaining({ running: false, rest: formation, sharedMemory: { currentET: 60, endET: 3600 } });
  check('formation: endEventTime − currentEventTime, as ever', r.source === 'restEnd' && r.sec === 3540, `${r.source} ${r.sec}`);
  r = resolveTimeRemaining({ running: false, rest: {}, sharedMemory: null });
  check('nothing published: unknown', r.sec === UNKNOWN_VALUE && r.source === 'none', `${r.source} ${r.sec}`);

  console.log('\nresolveTimeRemaining — running, no phase field (older build)');
  r = resolveTimeRemaining({
    running: true,
    rest: { ...restInRace, timeRemainingInGamePhase: undefined },
    sharedMemory: null,
  });
  check(
    'start + length − now, not endEventTime − now (which is a LENGTH, short by the formation)',
    r.source === 'restStart' && near(r.sec, TRUE_LEFT),
    `${r.source} ${r.sec}`,
  );

  // --- The provider, attached to the rejoined race ------------------------------
  console.log('\nLmuRestProvider — first frame after attaching to the rejoined race');
  // Constructed, never start()ed: buildSession touches no timer or socket. The
  // shared-memory reader is stubbed to the captured header.
  const p = new LmuRestProvider({ verbose: false });
  p.localCar.sessionClock = () => smInRace;
  p.localCar.sectorFlagBytes = () => null;
  p.localCar.inRealtime = () => null;

  const car = (slotID, position, carClass, lapsCompleted, bestLapTime, extra) => ({
    slotID,
    position,
    carClass,
    lapsCompleted,
    bestLapTime,
    gamePhase: 'GREEN',
    flag: 'GREEN',
    driverName: `Driver ${slotID}`,
    ...extra,
  });
  // The Silverstone leader (Hypercar, 190 laps, 105.42 best) and our car — an
  // LMP2 a few laps down, lapping ~114 s.
  const cars = [
    car(6, 1, 'Hyper', 190, 105.4228515625),
    car(31, 9, 'LMP2', 176, 114.2, { player: true, hasFocus: true, focus: true }),
  ];
  const si = {
    ...restRejoined,
    trackName: 'Silverstone Grand Prix Circuit - ELMS',
    session: 'RACE1',
    gamePhase: 5,
    maximumLaps: 4294967295,
    numberOfVehicles: 35,
    lapDistance: 5869.22,
  };
  const gs = { gamePhase: 'GPHASE_GREEN' };

  let s = p.buildSession(cars, si, cars[1], gs);
  check('session is the running race', s.type === 'race' && s.phase === 'green' && s.notStarted === false, `${s.type} ${s.phase}`);
  check('time remaining is the race\'s, from the first frame', near(s.timeRemainingSec, TRUE_LEFT), s.timeRemainingSec);
  check(
    'laps remaining follows it (~2 at 114 s), not ~190',
    s.lapsRemaining !== UNKNOWN_VALUE && s.lapsRemaining <= 3,
    s.lapsRemaining,
  );
  check('booked length still the full race for the pre-session header', s.scheduledLengthSec === 21600, s.scheduledLengthSec);

  console.log('\nLmuRestProvider — same rejoined race on a rig with no shared memory');
  p.localCar.sessionClock = () => null;
  s = p.buildSession(cars, si, cars[1], gs);
  // Documented limitation (sessionClock module note): REST alone has no server
  // end time to recover from, so this rig keeps LMU's timer. Pinned so a
  // change here is a decision, not an accident.
  check(
    'falls back to LMU\'s own timer, unchanged',
    s.timeRemainingSec === Math.round(restRejoined.timeRemainingInGamePhase),
    s.timeRemainingSec,
  );

  console.log('\nLmuRestProvider — a client that never left reads the same as before');
  p.localCar.sessionClock = () => smInRace;
  s = p.buildSession(cars, { ...si, ...restInRace }, cars[1], gs);
  check('time remaining', near(s.timeRemainingSec, TRUE_LEFT), s.timeRemainingSec);
} catch (err) {
  console.error(err);
  fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
