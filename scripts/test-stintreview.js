/**
 * test-stintreview.js — the stint reviewer's reading side.
 * -----------------------------------------------------------------------------
 * `src/telemetry/stintReview.ts` infers something the lap log does not record:
 * where one sitting in the car ended and the next began. Everything the Review
 * tab shows hangs off that inference, so this pins it down — plus the derived
 * numbers, which are the whole feature and none of which are stored anywhere.
 *
 * The bugs it is here to catch are the quiet ones:
 *   - a 40-minute break welded into one session, or a pit stop splitting one
 *   - a dirty lap setting the best, or moving the average
 *   - "0.0 L" where the truth is "we never read the fuel"
 *   - an optimal lap faster than physics because the sectors came from a
 *     different lap's feed than the lap time did
 *
 * Run: npm run test:stintreview
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R = require(path.join(__dirname, '..', 'dist', 'telemetry', 'stintReview.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const T0 = Date.parse('2026-09-06T18:00:00.000Z');

/**
 * One lap record. `endMs` is when it crossed the line; everything else has a
 * sane default so a test only states the field it is about.
 */
function lap(endMs, over = {}) {
  const lapMs = over.lapMs !== undefined ? over.lapMs : 107_000;
  const dirty = over.dirty || [];
  return {
    v: 6,
    id: over.id || `lap-${endMs}`,
    at: new Date(endMs).toISOString(),
    sim: 'lmu',
    track: 'Spa-Francorchamps',
    trackKey: 'spafrancorchamps_6980',
    trackLengthM: 6980,
    car: 'Ferrari 296 GT3',
    carClass: 'LMGT3',
    lapMs,
    distanceM: 6980,
    sessionType: 'practice',
    clean: dirty.length === 0,
    dirty,
    ...over,
  };
}

/** A run of `n` laps ending at `startMs`, each `gapMs` apart. */
function run(startMs, n, over = () => ({})) {
  const out = [];
  let t = startMs;
  for (let i = 0; i < n; i++) {
    const extra = over(i) || {};
    const rec = lap(t, extra);
    out.push(rec);
    t += (extra.lapMs !== undefined ? extra.lapMs : 107_000);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                  */
/* -------------------------------------------------------------------------- */

{
  // A normal 10-minute break in the garage is one session; 40 minutes is two.
  const a = run(T0, 5);
  const b = run(T0 + 10 * 60_000 + 5 * 107_000, 5);
  check('a 10-minute break stays one session', R.groupSessions([...a, ...b]).length === 1);

  const c = run(T0 + 40 * 60_000 + 5 * 107_000, 5);
  check('a 40-minute break is two sessions', R.groupSessions([...a, ...c]).length === 2);
}

{
  // The threshold itself, from both sides — the constant is exported so this
  // asserts the rule rather than a number copied out of the source.
  const first = lap(T0);
  const inside = lap(T0 + R.SESSION_GAP_MS + 107_000);      // idle == the gap
  const outside = lap(T0 + R.SESSION_GAP_MS + 107_000 + 1); // one ms over
  check('idle exactly at the gap is still one session', R.groupSessions([first, inside]).length === 1);
  check('one ms over the gap splits', R.groupSessions([first, outside]).length === 2);
}

{
  // Practice → qualifying is a new session no matter how quickly it follows.
  const p = run(T0, 3);
  const q = run(T0 + 3 * 107_000 + 30_000, 3, () => ({ sessionType: 'qualifying' }));
  const sessions = R.groupSessions([...p, ...q]);
  check('a session-type change splits', sessions.length === 2);
  check('and each keeps its own type',
    sessions[0].sessionType === 'practice' && sessions[1].sessionType === 'qualifying');

  const other = run(T0 + 3 * 107_000 + 30_000, 3, () => ({ car: 'Porsche 911 GT3 R' }));
  check('a car change splits', R.groupSessions([...p, ...other]).length === 2);

  const away = run(T0 + 3 * 107_000 + 30_000, 3,
    () => ({ track: 'Monza', trackKey: 'monza_5780' }));
  check('a track change splits', R.groupSessions([...p, ...away]).length === 2);
}

{
  // Order in, order out: the caller may hand over day files in any order.
  const laps = run(T0, 6);
  const shuffled = [laps[3], laps[0], laps[5], laps[1], laps[4], laps[2]];
  const s = R.groupSessions(shuffled)[0];
  check('unsorted input is sorted', s.stats.laps === 6);
  check('lap numbers follow the clock', s.stints[0].laps.map((l) => l.lapNo).join() === '1,2,3,4,5,6');
}

/* -------------------------------------------------------------------------- */
/*  Stints                                                                    */
/* -------------------------------------------------------------------------- */

{
  // The real signal: the log's own pit flags and stint counter.
  const laps = [
    lap(T0 + 0 * 107_000, { isOutLap: true, stintLap: 1 }),
    lap(T0 + 1 * 107_000, { stintLap: 2 }),
    lap(T0 + 2 * 107_000, { stintLap: 3, isInLap: true }),
    lap(T0 + 2 * 107_000 + 140_000, { isOutLap: true, stintLap: 1 }),
    lap(T0 + 2 * 107_000 + 140_000 + 107_000, { stintLap: 2 }),
  ];
  const s = R.groupSessions(laps)[0];
  check('a pit stop makes two stints', s.stints.length === 2, `${s.stints.length}`);
  check('the stop stays inside one session', s.stats.laps === 5);
  check('stint 1 kept its three laps', s.stints[0].laps.length === 3);
  check('stint 2 starts on the out-lap', s.stints[1].laps[0].isOutLap === true);
  check('stint lap numbers restart', s.stints[1].laps.map((l) => l.stintLap).join() === '1,2');
  check('session lap numbers do not', s.stints[1].laps.map((l) => l.lapNo).join() === '4,5');

  // An in-lap followed by an out-lap is ONE break, not two.
  check('one break per stop', s.stints.length === 2);
}

{
  // Pre-v5 laps carry no pit flags at all. The idle gap is the only signal
  // left, and it must not fire on a normal lap-to-lap interval.
  const laps = [
    lap(T0, { v: 4, stintLap: undefined }),
    lap(T0 + 107_000, { v: 4, stintLap: undefined }),
    lap(T0 + 107_000 + R.STINT_GAP_MS + 107_000 + 1, { v: 4, stintLap: undefined }),
  ];
  const s = R.groupSessions(laps)[0];
  check('old laps split on a long unexplained gap', s.stints.length === 2, `${s.stints.length}`);
  check('and not on a normal one', s.stints[0].laps.length === 2);
}

{
  // A v4→v5 boundary is one lap with the counter and one without. That is a
  // schema change, not a pit stop, and must not read as one.
  const laps = [
    lap(T0, { v: 4, stintLap: undefined }),
    lap(T0 + 107_000, { v: 5, stintLap: 7 }),
    lap(T0 + 2 * 107_000, { v: 5, stintLap: 8 }),
  ];
  check('a schema boundary is not a pit stop', R.groupSessions(laps)[0].stints.length === 1);
}

/* -------------------------------------------------------------------------- */
/*  The derived numbers                                                       */
/* -------------------------------------------------------------------------- */

{
  const laps = [
    lap(T0 + 0 * 107_000, { lapMs: 130_000, isOutLap: true, dirty: ['pit'] }),
    lap(T0 + 1 * 107_000, { lapMs: 107_400, s1Ms: 30_100, s2Ms: 40_200, s3Ms: 37_100 }),
    lap(T0 + 2 * 107_000, { lapMs: 106_900, s1Ms: 29_900, s2Ms: 40_400, s3Ms: 36_600 }),
    lap(T0 + 3 * 107_000, { lapMs: 104_100, s1Ms: 28_000, s2Ms: 39_000, s3Ms: 37_100, dirty: ['limits'] }),
    lap(T0 + 4 * 107_000, { lapMs: 107_100, s1Ms: 30_000, s2Ms: 40_100, s3Ms: 37_000 }),
  ];
  const st = R.groupSessions(laps)[0].stats;

  check('every lap is counted', st.laps === 5, `${st.laps}`);
  check('only the clean ones score', st.cleanLaps === 3, `${st.cleanLaps}`);
  check('the dirty flyer does not set the best', st.bestMs === 106_900, `${st.bestMs}`);
  check('the out-lap does not move the average',
    Math.round(st.averageMs) === Math.round((107_400 + 106_900 + 107_100) / 3), `${st.averageMs}`);
  check('best sectors come from clean laps only',
    st.bestSectors.join() === [29_900, 40_100, 36_600].join(), st.bestSectors.join());
  check('optimal is the sum of them', st.optimalMs === 29_900 + 40_100 + 36_600, `${st.optimalMs}`);
  check('untapped is best minus optimal', st.untappedMs === 106_900 - 106_600, `${st.untappedMs}`);
  check('clean percentage counts timed laps', Math.abs(st.cleanPct - 3 / 5) < 1e-9, `${st.cleanPct}`);
  check('dirty reasons are named and counted',
    st.dirtyBy.pit === 1 && st.dirtyBy.limits === 1, JSON.stringify(st.dirtyBy));
  check('drive time is the sum of the timed laps',
    st.driveMs === 130_000 + 107_400 + 106_900 + 104_100 + 107_100, `${st.driveMs}`);
}

{
  // Sectors and lap time can come from different feed reads. An "optimal" lap
  // faster than the fastest lap actually driven would show negative untapped
  // potential, which reads as the driver having beaten themselves.
  const laps = [
    lap(T0, { lapMs: 100_000, s1Ms: 40_000, s2Ms: 40_000, s3Ms: 40_000 }),
    lap(T0 + 107_000, { lapMs: 101_000, s1Ms: 40_100, s2Ms: 40_100, s3Ms: 40_100 }),
  ];
  const st = R.groupSessions(laps)[0].stats;
  check('optimal never beats the best real lap', st.optimalMs === 100_000, `${st.optimalMs}`);
  check('untapped never goes negative', st.untappedMs === 0, `${st.untappedMs}`);
}

{
  // A lap with no sectors leaves the optimal unclaimed rather than summing two.
  const laps = [
    lap(T0, { s1Ms: 30_000, s2Ms: 40_000 }),
    lap(T0 + 107_000, { s1Ms: 30_100, s2Ms: 40_100 }),
  ];
  const st = R.groupSessions(laps)[0].stats;
  check('no S3 means no optimal', st.optimalMs === null, `${st.optimalMs}`);
  check('and no untapped claim', st.untappedMs === null);
}

{
  // The implausible verdict is the log's own: the lap is shown, never timed.
  const laps = [
    lap(T0, { lapMs: 1_200_000, dirty: ['implausible'] }),
    lap(T0 + 1_300_000, { lapMs: 107_000 }),
  ];
  const s = R.groupSessions(laps)[0];
  const st = s.stats;
  check('an implausible lap is still listed', st.laps === 2);
  check('but is not timed', st.timedLaps === 1, `${st.timedLaps}`);
  check('and never sets the best', st.bestMs === 107_000, `${st.bestMs}`);
  check('the lap row says so', s.stints[0].laps[0].timed === false);
}

{
  // Nothing clean at all: null, not a dirty lap wearing the best's hat.
  const laps = [lap(T0, { dirty: ['limits'] }), lap(T0 + 107_000, { dirty: ['pit'] })];
  const st = R.groupSessions(laps)[0].stats;
  check('no clean lap → no best', st.bestMs === null);
  check('no clean lap → no average', st.averageMs === null);
  check('no clean lap → no consistency', st.consistency === null);
  check('but the laps are still there', st.laps === 2);
}

/* -------------------------------------------------------------------------- */
/*  Consumption: absent is not zero                                           */
/* -------------------------------------------------------------------------- */

{
  const laps = [
    lap(T0, { fuelUsedL: 2.9, veStartPct: 100, veEndPct: 96.6, tempAtLine: [88, 81, 82, 78] }),
    lap(T0 + 107_000, { fuelUsedL: 2.7, veStartPct: 96.6, veEndPct: 93.2 }),
    lap(T0 + 2 * 107_000, { tempAtLine: [90, 83, 84, 80] }), // shared memory dropped
  ];
  const st = R.groupSessions(laps)[0].stats;
  check('fuel sums only the laps that measured it',
    Math.abs(st.fuelUsedL - 5.6) < 1e-9, `${st.fuelUsedL}`);
  check('and averages over those laps, not all of them',
    Math.abs(st.fuelPerLapL - 2.8) < 1e-9, `${st.fuelPerLapL}`);
  check('energy sums the drops', Math.abs(st.veUsedPct - 6.8) < 1e-6, `${st.veUsedPct}`);
  check('tyre temps average the laps that carried them',
    Math.abs(st.tempAvg[0] - 89) < 1e-9, `${st.tempAvg && st.tempAvg[0]}`);
}

{
  const st = R.groupSessions(run(T0, 4))[0].stats;
  check('no fuel readings → null, never 0', st.fuelUsedL === null);
  check('no energy readings → null', st.veUsedPct === null);
  check('no tyre temps → null', st.tempAvg === null);
  check('no wear → null', st.wearEnd === null);
}

{
  // Refuelling is a rise, not a burn, and the log omits fuelUsedL for it. The
  // same rule applies to energy, which we DO derive here.
  const laps = [
    lap(T0, { veStartPct: 20, veEndPct: 100 }), // the rig topped it up
    lap(T0 + 107_000, { veStartPct: 100, veEndPct: 96 }),
  ];
  const st = R.groupSessions(laps)[0].stats;
  check('a refuel is not counted as consumption', Math.abs(st.veUsedPct - 4) < 1e-9, `${st.veUsedPct}`);
}

{
  // Wear is reported as the tyres were LEFT — the last lap that had a reading.
  const laps = [
    lap(T0, { wearAtLine: [1, 1, 1, 1] }),
    lap(T0 + 107_000, { wearAtLine: [0.94, 0.93, 0.96, 0.91] }),
    lap(T0 + 2 * 107_000, {}),
  ];
  const st = R.groupSessions(laps)[0].stats;
  check('wear is the last reading, not the last lap',
    st.wearEnd && Math.abs(st.wearEnd[3] - 0.91) < 1e-9, JSON.stringify(st.wearEnd));
}

/* -------------------------------------------------------------------------- */
/*  Consistency                                                               */
/* -------------------------------------------------------------------------- */

{
  check('a single lap has no spread', R.consistencyScore(null, 107_000) === null);
  check('a metronome scores 100', R.consistencyScore(107_000 * 0.001, 107_000) === 100);
  check('two percent scores 0', R.consistencyScore(107_000 * 0.02, 107_000) === 0);
  check('anything worse still scores 0', R.consistencyScore(107_000 * 0.5, 107_000) === 0);

  const tight = R.consistencyScore(107_000 * 0.002, 107_000);
  const loose = R.consistencyScore(107_000 * 0.008, 107_000);
  check('tighter always scores higher', tight > loose, `${tight} vs ${loose}`);
  check('and stays in range', tight <= 100 && loose >= 0);
}

{
  // The spread is what the UI leads with, so it must be the real number.
  const laps = [
    lap(T0, { lapMs: 107_000 }),
    lap(T0 + 107_000, { lapMs: 107_500 }),
    lap(T0 + 2 * 107_000, { lapMs: 106_500 }),
  ];
  const st = R.groupSessions(laps)[0].stats;
  check('spread is the sample stdev in ms', Math.abs(st.spreadMs - 500) < 1e-9, `${st.spreadMs}`);
}

/* -------------------------------------------------------------------------- */
/*  Reading the log off disk                                                  */
/* -------------------------------------------------------------------------- */

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-review-'));
  const lapsDir = path.join(dir, 'laps');
  fs.mkdirSync(lapsDir, { recursive: true });

  const morning = run(Date.parse('2026-09-05T09:00:00.000Z'), 4);
  const evening = run(Date.parse('2026-09-06T20:00:00.000Z'), 6,
    (i) => ({ lapMs: 106_400 + i * 50 }));
  const write = (day, records) =>
    fs.writeFileSync(
      path.join(lapsDir, `${day}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  write('2026-09-05', morning);
  write('2026-09-06', evening);
  // A torn final line is normal — the file is appended to while a lap crosses
  // the line — and must cost that line, not the day.
  fs.appendFileSync(path.join(lapsDir, '2026-09-06.jsonl'), '{"v":6,"at":"2026-');

  const list = R.listSessions(lapsDir);
  check('both sessions are listed', list.length === 2, `${list.length}`);
  check('newest first', list[0].startedAt > list[1].startedAt);
  check('the torn line is skipped, the day is not', list[0].laps === 6, `${list[0].laps}`);
  check('the row carries a best', list[0].bestMs === 106_400);
  check('the row carries the stint count', list[0].stints === 1);
  check('list rows carry no laps', list[0].laps !== undefined && list[0].stints !== undefined
    && !Array.isArray(list[0].stintList));

  const full = R.loadSession(list[0].id, lapsDir);
  check('a listed id loads', full !== null);
  check('the loaded session has its laps', full.stints[0].laps.length === 6);
  check('an unknown id is null, not a throw', R.loadSession('nope', lapsDir) === null);

  // Personal best and the trend both need laps from OUTSIDE the session.
  check('the personal best spans the whole log', full.pbMs === 106_400, `${full.pbMs}`);
  check('and says this session set it', full.pbHere === true);
  const older = R.loadSession(list[1].id, lapsDir);
  check('an older session knows it is not the record', older.pbHere === false);
  check('the trend has one point per day driven', full.trend.length === 2, `${full.trend.length}`);
  check('trend is oldest first', full.trend[0].day === '2026-09-05');
  check('trend takes the day\'s best', full.trend[1].bestMs === 106_400);

  check('a missing folder is empty, not a throw',
    R.listSessions(path.join(dir, 'nothing-here')).length === 0);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* -------------------------------------------------------------------------- */
/*  The career strip                                                          */
/*                                                                            */
/*  Every total across the top of the Review tab, derived from the log alone. */
/* -------------------------------------------------------------------------- */

{
  // Two circuits, two cars, two days, and one lap with no time on it — which
  // is the shape every one of these totals has to survive.
  const day2 = Date.parse('2026-09-07T18:00:00.000Z');
  const recs = [
    lap(T0 + 108_000, { id: 'c1', lapMs: 108_000 }),
    lap(T0 + 215_000, { id: 'c2', lapMs: 107_000 }),
    lap(T0 + 320_000, { id: 'c3', lapMs: 0, dirty: ['pit'] }),
    lap(day2, {
      id: 'c4', lapMs: 96_000, track: 'Monza', trackKey: 'monza_5780',
      trackLengthM: 5780, distanceM: 5780, car: 'Porsche 963', carClass: 'HYPERCAR',
    }),
  ];
  const c = R.careerStats(recs);

  check('every lap is counted, timed or not', c.laps === 4, `${c.laps}`);
  check('clean laps are counted separately', c.cleanLaps === 3, `${c.cleanLaps}`);
  check('and timed laps separately again', c.timedLaps === 3, `${c.timedLaps}`);
  check('distance is the sum of the circuits driven',
    c.distanceM === 6980 * 3 + 5780, `${c.distanceM}`);
  check('time at the wheel is the timed laps only',
    c.driveMs === 108_000 + 107_000 + 96_000, `${c.driveMs}`);
  check('circuits are distinct', c.tracks === 2, `${c.tracks}`);
  check('cars are distinct', c.cars === 2, `${c.cars}`);
  check('classes are distinct', c.classes === 2, `${c.classes}`);
  check('days are distinct', c.days === 2, `${c.days}`);
  check('sessions agree with the grouping the list itself uses',
    c.sessions === R.groupSessions(recs).length, `${c.sessions}`);
  check('the first and last lap bracket the history',
    c.firstAt === recs[0].at && c.lastAt === recs[3].at);

  check('the busiest circuit leads',
    c.topTracks[0].name === 'Spa-Francorchamps' && c.topTracks[0].laps === 3,
    JSON.stringify(c.topTracks[0]));
  check('carrying its own best lap', c.topTracks[0].bestMs === 107_000);
  check('a lap with no time never becomes a best', c.topCars[0].bestMs === 107_000);
  check('and the busiest car with it', c.topCars[0].name === 'Ferrari 296 GT3');

  const none = R.careerStats([]);
  check('an empty log is zeroes, not a throw', none.laps === 0 && none.tracks === 0);
  check('and names no first lap', none.firstAt === null);
}

console.log(`\ntest-stintreview: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
