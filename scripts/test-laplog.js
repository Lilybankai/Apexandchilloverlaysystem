/**
 * scripts/test-laplog.js — the lap database's counting and cleanliness rules.
 * -----------------------------------------------------------------------------
 * This module decides two things that end up in front of the whole league: how
 * many laps you drove this week, and whether a time is allowed on a board. Both
 * are derived from counters that move for boring reasons — a session restart, a
 * spectator switch, a feed dropout, a trip through the garage — and every bug
 * worth having looks completely normal on screen. A lap silently not counted is
 * invisible. A dirty lap silently counted as clean is worse: it puts a time on a
 * leaderboard that the driver cannot defend and everyone else can see.
 *
 * So each case drives the real recorder through a stint with one correct answer
 * — pit out, run wide, restart the session, drop the feed mid-lap — and asserts
 * what came back. The summariser is exercised against a temp directory of real
 * files, because "reads its own writes" is exactly the property that breaks when
 * the record shape drifts.
 *
 * Run: node scripts/test-laplog.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LapRecorder,
  appendLap,
  readDay,
  summarize,
  dayStamp,
} = require('../dist/telemetry/lapLog');

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

/** A believable GT3 lap at a 7 km circuit. */
const LAP_SEC = 138.4;

/**
 * A harness that walks the recorder through a stint the way the provider does:
 * many polls per lap, then a `lap()` that trips the sim's completed-lap counter.
 *
 * `state` is the mutable per-poll input — tests reach in and set `inPit` or bump
 * `limitWarnings` exactly where a driver would have earned it.
 */
function rig(overrides) {
  const r = new LapRecorder();
  let now = 1_700_000_000_000;
  const state = {
    sim: 'lmu',
    track: 'Spa-Francorchamps',
    trackLengthM: 7004,
    car: 'Ferrari 296 GT3',
    carClass: 'GT3',
    sessionType: 'practice',
    lapsCompleted: 0,
    lastLapSec: -1,
    inPit: false,
    limitWarnings: 0,
    penalties: 0,
    ...overrides,
  };

  /** Advance a few polls without completing a lap. */
  const poll = (times = 1) => {
    let out = null;
    for (let i = 0; i < times; i++) {
      now += 150;
      out = r.update({ ...state }, now) || out;
    }
    return out;
  };

  /** Complete one lap: the sim's counter ticks and lastLapTime lands. */
  const lap = (sec = LAP_SEC) => {
    poll(4); // mid-lap polls, where the faults get observed
    state.lapsCompleted += 1;
    state.lastLapSec = sec;
    now += 150;
    return r.update({ ...state }, now);
  };

  return { r, state, poll, lap, now: () => now };
}

console.log('\nlap recorder\n');

{
  // The baseline. The FIRST completed lap can never be clean: the app only
  // started watching partway through it, so nothing can be said about the rest.
  const t = rig();
  const first = t.lap();
  check('first lap is recorded', first !== null);
  check('…but flagged partial, not clean', first && !first.clean, first && first.dirty.join(','));
  check('…and carries the sim time in ms', first && first.lapMs === Math.round(LAP_SEC * 1000), first && first.lapMs);

  const second = t.lap();
  check('the next full lap IS clean', second && second.clean, second && second.dirty.join(','));
  check('…and knows its class', second && second.carClass === 'GT3');
  check('…and its car', second && second.car === 'Ferrari 296 GT3');
  check('…and credits the lap distance', second && second.distanceM === 7004, second && second.distanceM);
}

{
  // A trip through the pits dirties the lap it happened on, and only that lap.
  const t = rig();
  t.lap(); // burn the partial
  t.poll(2);
  t.state.inPit = true;
  t.poll(2);
  t.state.inPit = false;
  const inLap = t.lap();
  check('a lap with a pit visit is dirty', inLap && !inLap.clean);
  check('…for the right reason', inLap && inLap.dirty.includes('pit'), inLap && inLap.dirty.join(','));

  const next = t.lap();
  check('the lap after is clean again', next && next.clean, next && next.dirty.join(','));
}

{
  // Running wide voids the lap. The counter is cumulative for the session, so
  // the rule has to be "did it MOVE during this lap", not "is it non-zero".
  const t = rig();
  t.lap();
  t.lap(); // clean, warnings still 0
  t.poll(2);
  t.state.limitWarnings = 1;
  const wide = t.lap();
  check('an excursion voids the lap', wide && !wide.clean);
  check('…flagged as limits', wide && wide.dirty.includes('limits'), wide && wide.dirty.join(','));

  const after = t.lap();
  check('a standing warning does not void later laps', after && after.clean, after && after.dirty.join(','));
}

{
  // A penalty landing mid-lap is the stewards, not our geometry.
  const t = rig();
  t.lap();
  t.poll(2);
  t.state.penalties = 1;
  const pen = t.lap();
  check('a new penalty voids the lap', pen && pen.dirty.includes('penalty'), pen && pen.dirty.join(','));
}

{
  // Session restart: same track, same car, same session type, but the sim's lap
  // counter rewinds. Nothing completed — and the lap in progress is unknowable.
  const t = rig();
  t.lap();
  t.lap();
  t.state.lapsCompleted = 0;
  const rewound = t.poll(2);
  check('a rewound lap count emits nothing', rewound === null);
  const afterRestart = t.lap();
  check('the first lap after a restart is partial', afterRestart && afterRestart.dirty.includes('partial'), afterRestart && afterRestart.dirty.join(','));
}

{
  // The feed dropped for a while and the counter jumped. Crediting the gap would
  // invent laps; `lastLapTime` only describes the most recent one anyway.
  const t = rig();
  t.lap();
  t.lap();
  t.state.lapsCompleted += 4;
  t.state.lastLapSec = LAP_SEC;
  const jumped = t.poll(1);
  check('a multi-lap jump credits nothing', jumped === null);
  const recovered = t.lap();
  check('…and the recovery lap is partial', recovered && recovered.dirty.includes('partial'), recovered && recovered.dirty.join(','));
}

{
  // Changing car mid-session starts a new stint: the counters are incomparable,
  // so nothing may be emitted across the boundary.
  const t = rig();
  t.lap();
  t.lap();
  t.state.car = 'Porsche 911 GT3 R';
  const swapped = t.poll(2);
  check('a car change emits nothing', swapped === null);
  const firstInNewCar = t.lap();
  check('…and its first lap is partial', firstInNewCar && firstInNewCar.dirty.includes('partial'));
}

{
  // Implausible times are still LAPS — they count for the weekly total — but
  // they are not TIMES, so they must never reach a leaderboard as clean.
  const t = rig();
  t.lap();
  const fragment = t.lap(3.2);
  check('a 3 s "lap" is recorded', fragment !== null);
  check('…but never clean', fragment && !fragment.clean);
  check('…flagged implausible', fragment && fragment.dirty.includes('implausible'), fragment && fragment.dirty.join(','));
}

console.log('\nstorage + rolling summary\n');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-laps-'));
  const now = Date.now();

  const rec = (over) => ({
    v: 1,
    at: new Date(over.atMs !== undefined ? over.atMs : now).toISOString(),
    sim: 'lmu',
    track: over.track || 'Spa-Francorchamps',
    trackKey: over.trackKey || 'spa-francorchamps_7004',
    trackLengthM: 7004,
    car: over.car || 'Ferrari 296 GT3',
    carClass: over.carClass || 'GT3',
    lapMs: over.lapMs,
    distanceM: 7004,
    sessionType: 'practice',
    clean: over.clean !== false,
    dirty: over.clean === false ? ['limits'] : [],
  });

  appendLap(rec({ lapMs: 139_400 }), dir);
  appendLap(rec({ lapMs: 138_100 }), dir); // faster — becomes the class best
  appendLap(rec({ lapMs: 137_000, clean: false }), dir); // faster but dirty
  appendLap(rec({ lapMs: 140_000, car: 'Porsche 911 GT3 R' }), dir);
  appendLap(rec({ lapMs: 210_000, carClass: 'LMP2', trackKey: 'spa-francorchamps_7004' }), dir);
  // Eight days ago — outside the rolling week.
  appendLap(rec({ lapMs: 100_000, atMs: now - 8 * 86_400_000 }), dir);

  const today = readDay(dayStamp(now), dir);
  check('reads back what it wrote', today.length === 5, today.length);

  // A half-written final line is normal: the file is appended to live.
  fs.appendFileSync(path.join(dir, `${dayStamp(now)}.jsonl`), '{"v":1,"lapM', 'utf8');
  check('a torn last line does not lose the day', readDay(dayStamp(now), dir).length === 5);

  const s = summarize(now, 7, dir);
  check('counts every lap in the window', s.laps === 5, s.laps);
  const stamps = s.byDay.map((d) => d.day);
  check('excludes laps older than the window', !stamps.includes(dayStamp(now - 8 * 86_400_000)));

  // The dashboard draws a bar per day, so every day in the window must be
  // present — including the empty ones. A summariser that only emitted days
  // with laps on them would silently shorten the chart to its busy days, which
  // is exactly the information the chart exists to show.
  check('reports every day in the window', s.byDay.length === 7, s.byDay.length);
  check('…oldest first', stamps[0] === dayStamp(now - 6 * 86_400_000) && stamps[6] === dayStamp(now));
  const todayBucket = s.byDay[6];
  check('…with today carrying its laps', todayBucket && todayBucket.laps === 5, todayBucket && todayBucket.laps);
  check('…and its clean subset', todayBucket && todayBucket.cleanLaps === 4, todayBucket && todayBucket.cleanLaps);
  check('…and empty days reading zero', s.byDay.slice(0, 6).every((d) => d.laps === 0));
  check(
    'per-day laps sum to the total',
    s.byDay.reduce((n, d) => n + d.laps, 0) === s.laps,
  );
  check('counts clean laps separately', s.cleanLaps === 4, s.cleanLaps);
  check('sums distance', s.distanceM === 5 * 7004, s.distanceM);
  check('counts distinct tracks', s.tracks === 1, s.tracks);

  const gt3 = s.bests.find((b) => b.carClass === 'GT3');
  check('best is per class, not per car', s.bests.length === 2, s.bests.length);
  check('…and takes the fastest CLEAN lap', gt3 && gt3.lapMs === 138_100, gt3 && gt3.lapMs);
  check('…carrying the car that set it', gt3 && gt3.car === 'Ferrari 296 GT3', gt3 && gt3.car);

  const lmp2 = s.bests.find((b) => b.carClass === 'LMP2');
  check('a second class gets its own entry', lmp2 && lmp2.lapMs === 210_000, lmp2 && lmp2.lapMs);

  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // An empty history is the first-run state and must summarise, not throw.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-laps-empty-'));
  const s = summarize(Date.now(), 7, dir);
  check('an empty history summarises to zero', s.laps === 0 && s.bests.length === 0);
  check('…and still reports its window', s.byDay.length === 7, s.byDay.length);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
