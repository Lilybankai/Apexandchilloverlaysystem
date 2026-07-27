/**
 * scripts/test-lapupload.js — what gets sent to the league, and what does not.
 * -----------------------------------------------------------------------------
 * The uploader's correctness is almost entirely in two pure functions:
 * `buildUploadPlan` (what SHOULD the database hold, given these files) and
 * `diffPlan` (what of that has not been sent yet). Everything around them is
 * HTTP and a timer.
 *
 * The bugs worth catching here are all silent. A best lap that is never offered
 * because a dirty lap shadowed it. A day whose counters stop being re-sent after
 * more laps land on it. A refused row retried every five minutes for the life of
 * the install. A remembered "best" that drifts slower and re-uploads forever.
 * None of those raise anything; they just quietly produce a wrong leaderboard or
 * an app that talks to the API in its sleep.
 *
 * Run: node scripts/test-lapupload.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendLap,
  buildUploadPlan,
  diffPlan,
  emptySyncCache,
  activityKey,
  bestKey,
  markActivitySent,
  markBestSent,
  markRejected,
  listDays,
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

const DAY = 86_400_000;

/** A lap record with believable defaults, overridable per case. */
function lap(over) {
  return {
    v: 1,
    at: new Date(over.atMs !== undefined ? over.atMs : Date.now()).toISOString(),
    sim: 'lmu',
    track: over.track || 'Spa-Francorchamps',
    // `!==  undefined`, not `||`: an explicitly EMPTY key is a case under test
    // (a record with no track identity), and a `||` default would quietly swap
    // it for the real one and make the assertion pass for the wrong reason.
    trackKey: over.trackKey !== undefined ? over.trackKey : 'spa-francorchamps_7004',
    trackLengthM: over.len || 7004,
    car: over.car || 'Ferrari 296 GT3',
    carClass: over.carClass !== undefined ? over.carClass : 'GT3',
    lapMs: over.lapMs !== undefined ? over.lapMs : 139_400,
    distanceM: over.len || 7004,
    sessionType: over.sessionType || 'practice',
    clean: over.clean !== false,
    dirty: over.clean === false ? ['limits'] : [],
    ...(over.wet !== undefined ? { wet: over.wet } : {}),
    ...(over.trackTempC !== undefined ? { trackTempC: over.trackTempC } : {}),
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-upload-'));
}

console.log('\nbuilding the plan\n');

{
  const dir = tmpdir();
  const now = Date.now();

  appendLap(lap({ atMs: now, lapMs: 139_400 }), dir);
  appendLap(lap({ atMs: now, lapMs: 138_100 }), dir); // the real best
  appendLap(lap({ atMs: now, lapMs: 137_000, clean: false }), dir); // faster, dirty
  appendLap(lap({ atMs: now, lapMs: 140_000, car: 'Porsche 911 GT3 R' }), dir);
  // Yesterday, and a different class on the same track.
  appendLap(lap({ atMs: now - DAY, lapMs: 141_000 }), dir);
  appendLap(lap({ atMs: now - DAY, lapMs: 125_300, carClass: 'LMP2', car: 'Oreca 07' }), dir);

  const plan = buildUploadPlan(dir);

  check('one activity row per day+class', plan.activity.length === 3, plan.activity.length);
  check('newest day first', plan.activity[0].day === dayStamp(now), plan.activity[0].day);

  const todayGt3 = plan.activity.find((r) => r.day === dayStamp(now) && r.carClass === 'GT3');
  check('…counting every lap driven', todayGt3 && todayGt3.laps === 4, todayGt3 && todayGt3.laps);
  check('…and the clean subset', todayGt3 && todayGt3.cleanLaps === 3, todayGt3 && todayGt3.cleanLaps);
  check('…and the distance', todayGt3 && todayGt3.distanceM === 4 * 7004, todayGt3 && todayGt3.distanceM);

  check('one best per track+class', plan.bests.length === 2, plan.bests.length);
  const gt3 = plan.bests.find((b) => b.carClass === 'GT3');
  check('best ignores a faster DIRTY lap', gt3 && gt3.lapMs === 138_100, gt3 && gt3.lapMs);
  check('…and carries the car that set it', gt3 && gt3.car === 'Ferrari 296 GT3', gt3 && gt3.car);
  check('…and the conditions', gt3 && gt3.conditions.sessionType === 'practice');

  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // Bests are ALL-TIME, not windowed: a leaderboard entry does not expire the
  // way the dashboard's rolling seven days does.
  const dir = tmpdir();
  const now = Date.now();
  appendLap(lap({ atMs: now - 200 * DAY, lapMs: 130_000 }), dir); // ancient, quick
  appendLap(lap({ atMs: now, lapMs: 139_000 }), dir);
  const plan = buildUploadPlan(dir);
  check('a months-old best still counts', plan.bests[0].lapMs === 130_000, plan.bests[0].lapMs);
  check('…and both days report activity', plan.activity.length === 2, plan.activity.length);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // Laps that cannot go on a board must still be COUNTED. "How many laps did I
  // drive" and "what may be ranked" are different questions.
  const dir = tmpdir();
  const now = Date.now();
  appendLap(lap({ atMs: now, carClass: '', lapMs: 139_000 }), dir); // unknown class
  appendLap(lap({ atMs: now, lapMs: 3_200 }), dir); // implausible
  const plan = buildUploadPlan(dir);
  check('unclassified + implausible laps still counted', plan.activity.reduce((n, r) => n + r.laps, 0) === 2);
  check('…but neither is offered to a board', plan.bests.length === 0, plan.bests.length);

  const unknown = plan.activity.find((r) => r.carClass === '');
  check('…and the unclassified one keeps its own bucket', !!unknown);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // A record with no track identity has nowhere to land at the other end.
  const dir = tmpdir();
  appendLap(lap({ atMs: Date.now(), trackKey: '' }), dir);
  const plan = buildUploadPlan(dir);
  check('a lap with no track key is skipped', plan.activity.length === 0 && plan.bests.length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmpdir();
  check('an empty history plans nothing', buildUploadPlan(dir).activity.length === 0);
  check('…and lists no days', listDays(dir).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\ndiffing against what was already sent\n');

{
  const dir = tmpdir();
  const now = Date.now();
  appendLap(lap({ atMs: now, lapMs: 139_400 }), dir);
  const cache = emptySyncCache();

  let plan = buildUploadPlan(dir);
  let pending = diffPlan(plan, cache);
  check('everything is pending on a fresh cache', pending.activity.length === 1 && pending.bests.length === 1);

  // Mark it sent, as a successful run would.
  markActivitySent(cache, pending.activity[0]);
  markBestSent(cache, pending.bests[0]);
  pending = diffPlan(buildUploadPlan(dir), cache);
  check('nothing re-sent when nothing changed', pending.activity.length === 0 && pending.bests.length === 0);

  // Another lap on the same day, slower: the day's counters moved, the best did not.
  appendLap(lap({ atMs: now, lapMs: 142_000 }), dir);
  pending = diffPlan(buildUploadPlan(dir), cache);
  check('more laps re-send the day', pending.activity.length === 1, pending.activity.length);
  check('…but not the unchanged best', pending.bests.length === 0, pending.bests.length);
  markActivitySent(cache, pending.activity[0]);

  // A genuinely faster lap.
  appendLap(lap({ atMs: now, lapMs: 137_500 }), dir);
  pending = diffPlan(buildUploadPlan(dir), cache);
  check('a faster lap is offered', pending.bests.length === 1 && pending.bests[0].lapMs === 137_500);
  markBestSent(cache, pending.bests[0]);

  // A dirty lap that is quicker than the stored best must change nothing.
  appendLap(lap({ atMs: now, lapMs: 130_000, clean: false }), dir);
  pending = diffPlan(buildUploadPlan(dir), cache);
  check('a quicker DIRTY lap is never offered', pending.bests.length === 0, pending.bests.length);

  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // markBestSent must never move the remembered time backwards. If it did, a
  // slower lap would look un-sent forever and the app would upload it on every
  // single run for the life of the install.
  const cache = emptySyncCache();
  const fast = { sim: 'lmu', trackKey: 't_1', carClass: 'GT3', lapMs: 100_000 };
  const slow = { sim: 'lmu', trackKey: 't_1', carClass: 'GT3', lapMs: 105_000 };
  markBestSent(cache, fast);
  markBestSent(cache, slow);
  check('the remembered best never gets slower', cache.bests[bestKey(fast)] === 100_000, cache.bests[bestKey(fast)]);
}

{
  // A row the server refuses for good must never be offered again — otherwise
  // one malformed lap becomes a request every five minutes, forever.
  const dir = tmpdir();
  const now = Date.now();
  appendLap(lap({ atMs: now, lapMs: 139_400 }), dir);
  const cache = emptySyncCache();
  const plan = buildUploadPlan(dir);

  markRejected(cache, activityKey(plan.activity[0]), 'bad_day');
  markRejected(cache, bestKey(plan.bests[0]), 'implausible_time');
  const pending = diffPlan(plan, cache);
  check('a refused activity row is not retried', pending.activity.length === 0);
  check('a refused best is not retried', pending.bests.length === 0);

  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // Losing the cache must cost bandwidth, not correctness — the whole reason the
  // server RPCs were made idempotent. Everything simply becomes pending again.
  const dir = tmpdir();
  appendLap(lap({ atMs: Date.now(), lapMs: 139_400 }), dir);
  const plan = buildUploadPlan(dir);
  const pending = diffPlan(plan, emptySyncCache());
  check('a lost cache re-sends everything', pending.activity.length === 1 && pending.bests.length === 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
