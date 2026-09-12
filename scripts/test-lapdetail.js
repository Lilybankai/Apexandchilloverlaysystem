/**
 * test-lapdetail.js — joining a lap to its trace and its circuit.
 * -----------------------------------------------------------------------------
 * `src/telemetry/lapDetail.ts` is three derivations, and each of them fails
 * SILENTLY when it is wrong — which is what this file exists for:
 *
 *   1. The track-map key. A lap's `trackKey` and a track map's `key` are two
 *      different schemes (`circuit-of-the-americas_5497` against
 *      `circuit-of-the-americas-5500`). Hand one to the other's loader and it
 *      simply misses, forever, and the map view is empty with no error
 *      anywhere. The tests below pin the exact shape of both.
 *   2. The sector marks. A sector line drawn in the wrong place is worse than
 *      none, because every judgement made against it is wrong in a way the
 *      driver cannot see.
 *   3. The driven line. A v1 trace has none and can never have one, so
 *      `hasLine` has to be the truth rather than an optimistic guess — the
 *      renderer changes what it draws on the strength of it.
 *
 * Run: npm run test:lapdetail
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const D = require(path.join(__dirname, '..', 'dist', 'telemetry', 'lapDetail.js'));
const TM = require(path.join(__dirname, '..', 'dist', 'telemetry', 'trackMap.js'));
const PD = require(path.join(__dirname, '..', 'dist', 'telemetry', 'paceDelta.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/* -------------------------------------------------------------------------- */
/*  1. The two key schemes                                                    */
/* -------------------------------------------------------------------------- */

{
  const lap = { track: 'Circuit of the Americas', trackConfig: undefined, trackLengthM: 5497 };

  // The trap itself, stated from both sides. If either of these ever changes,
  // this file is where you find out — not a blank map view six months later.
  check('the lap log keys with an underscore and exact metres',
    PD.trackKeyOf(lap.track, lap.trackLengthM) === 'circuit-of-the-americas_5497',
    PD.trackKeyOf(lap.track, lap.trackLengthM));
  check('the track map keys with a hyphen and metres rounded to ten',
    D.mapKeyForLap(lap) === 'circuit-of-the-americas-5500', D.mapKeyForLap(lap));
  check('so the two are NOT the same string',
    PD.trackKeyOf(lap.track, lap.trackLengthM) !== D.mapKeyForLap(lap));

  // …and the map's own key function is what we go through, so they cannot drift.
  check('the key comes from the map module, not a rewrite',
    D.mapKeyForLap(lap) === TM.trackKey(lap.track, undefined, lap.trackLengthM));

  check('rounding goes both ways',
    D.mapKeyForLap({ track: 'Spa', trackLengthM: 6982 }) === 'spa-6980',
    D.mapKeyForLap({ track: 'Spa', trackLengthM: 6982 }));
  check('a layout name is kept when the sim gives one',
    D.mapKeyForLap({ track: 'Paul Ricard', trackConfig: '1A', trackLengthM: 5700 })
      === 'paul-ricard-1a-5700',
    D.mapKeyForLap({ track: 'Paul Ricard', trackConfig: '1A', trackLengthM: 5700 }));
  check('a config that only repeats the name is not doubled up',
    D.mapKeyForLap({ track: 'Monza', trackConfig: 'Monza', trackLengthM: 5780 })
      === 'monza-5780',
    D.mapKeyForLap({ track: 'Monza', trackConfig: 'Monza', trackLengthM: 5780 }));
  check('a nameless track still produces a key, not a crash',
    D.mapKeyForLap({ track: '', trackLengthM: 0 }) === 'unknown-0',
    D.mapKeyForLap({ track: '', trackLengthM: 0 }));
}

{
  // The regression that matters: every circuit that ships with the app has to
  // be reachable from a lap driven on it. This walks the bundle itself, so a
  // renamed file or a changed key scheme fails here.
  const dir = TM.builtinTrackMapDir();
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  let reachable = 0;
  const unreachable = [];
  for (const m of index.maps) {
    // Rebuild the lap a driver would have logged at that circuit: the sim
    // reports the venue name and a length in whole metres.
    const key = D.mapKeyForLap({ track: m.name, trackConfig: m.config, trackLengthM: m.lengthM });
    if (TM.loadTrackMap(key)) reachable++;
    else unreachable.push(`${m.key} (asked for ${key})`);
  }
  check('every bundled circuit is reachable from a lap driven on it',
    unreachable.length === 0, unreachable.join('; ') || `${reachable} of ${index.maps.length}`);
}

/* -------------------------------------------------------------------------- */
/*  2. Sector marks                                                           */
/* -------------------------------------------------------------------------- */

/** A synthetic lap: constant speed, so distance and time are proportional. */
function evenTrace(points, lapSec) {
  const d = [];
  const t = [];
  for (let i = 0; i < points; i++) {
    d.push(i / (points - 1));
    t.push((i / (points - 1)) * lapSec);
  }
  return { lapSec, count: points, truncated: false, d, t, speedKph: d.map(() => 100) };
}

{
  const trace = evenTrace(1001, 100);
  // A third and two thirds of a lap driven at constant speed.
  const marks = D.sectorMarks(trace, 100_000, 33_333, 33_334);
  check('S1 lands where the time says', Math.abs(marks.s1 - 0.33333) < 0.002, `${marks.s1}`);
  check('S2 is the SUM of the first two sectors, not the second',
    Math.abs(marks.s2 - 0.66667) < 0.002, `${marks.s2}`);
}

{
  // The trace's clock and the sim's disagree by a few ms a lap; the mark has to
  // ride the trace's, because that is the axis it will be drawn on.
  const trace = evenTrace(1001, 99);
  const marks = D.sectorMarks(trace, 100_000, 50_000, 25_000);
  check('the split is scaled onto the trace clock',
    Math.abs(marks.s1 - 0.5) < 0.002, `${marks.s1}`);
}

{
  const trace = evenTrace(1001, 100);
  check('no splits, no marks',
    D.sectorMarks(trace, 100_000).s1 === null && D.sectorMarks(trace, 100_000).s2 === null);
  check('S2 needs both splits, not just the second',
    D.sectorMarks(trace, 100_000, undefined, 30_000).s2 === null);
  check('a boundary past the end of the lap is refused',
    D.sectorMarks(trace, 100_000, 120_000).s1 === null);
  check('a zero lap time is refused rather than divided by',
    D.sectorMarks(trace, 0, 30_000, 30_000).s1 === null);
  check('a trace with no clock is refused',
    D.sectorMarks({ ...trace, lapSec: 0 }, 100_000, 30_000, 30_000).s1 === null);
  check('mismatched columns are refused',
    D.sectorMarks({ ...trace, t: [0, 1] }, 100_000, 30_000, 30_000).s1 === null);
}

{
  // Interpolation: with only ten samples the mark must still land between them
  // rather than snapping to the nearest, which at Le Mans is 7 m of road.
  const coarse = evenTrace(11, 100);
  const marks = D.sectorMarks(coarse, 100_000, 25_000, 25_000);
  check('the mark is interpolated between samples',
    Math.abs(marks.s1 - 0.25) < 0.001, `${marks.s1}`);
  check('and is not snapped to a sample', coarse.d.indexOf(marks.s1) === -1);
}

/* -------------------------------------------------------------------------- */
/*  3. The driven line, and v-max                                             */
/* -------------------------------------------------------------------------- */

{
  const trace = evenTrace(5, 10);
  check('no columns, no line', D.hasDrivenLine(trace) === false);
  check('both columns and the right length is a line',
    D.hasDrivenLine({ ...trace, x: [1, 2, 3, 4, 5], z: [1, 2, 3, 4, 5] }) === true);
  check('one column alone is not a line',
    D.hasDrivenLine({ ...trace, x: [1, 2, 3, 4, 5] }) === false);
  check('columns that do not line up are not a line',
    D.hasDrivenLine({ ...trace, x: [1, 2], z: [1, 2] }) === false);
  check('a single point is not a line',
    D.hasDrivenLine({ ...evenTrace(1, 1), x: [1], z: [1] }) === false);
}

{
  check('v-max is the maximum of the column',
    D.vMaxOf({ speedKph: [100, 288, 4] }) === 288);
  check('an empty column has no v-max', D.vMaxOf({ speedKph: [] }) === null);
  check('a missing column has no v-max', D.vMaxOf({}) === null);
  check('junk in the column is stepped over',
    D.vMaxOf({ speedKph: [10, NaN, 40, Infinity] }) === 40);
}

/* -------------------------------------------------------------------------- */
/*  4. Loading off disk                                                       */
/* -------------------------------------------------------------------------- */

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-lapdetail-'));
  const laps = path.join(root, 'laps');
  const traces = path.join(root, 'traces');
  fs.mkdirSync(laps, { recursive: true });

  const at = '2026-09-06T20:14:31.000Z';
  const rec = {
    v: 6, id: 'lap-a', at, sim: 'lmu',
    track: 'Circuit of the Americas', trackKey: 'circuit-of-the-americas_5497',
    trackLengthM: 5497, car: 'Ferrari 296 GT3', carClass: 'LMGT3',
    lapMs: 100_000, distanceM: 5497, sessionType: 'practice',
    clean: true, dirty: [], s1Ms: 30_000, s2Ms: 40_000, s3Ms: 30_000,
  };
  fs.writeFileSync(path.join(laps, '2026-09-06.jsonl'), `${JSON.stringify(rec)}\n`);

  const write = (id, day, extra) => {
    const dir = path.join(traces, day);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      v: extra && extra.x ? 2 : 1, lapId: id, at, sim: 'lmu',
      trackKey: rec.trackKey, track: rec.track, trackLengthM: 5497,
      car: rec.car, carClass: rec.carClass, lapMs: rec.lapMs,
      trace: { ...evenTrace(101, 100), throttle: [], ...extra },
    }));
  };
  write('lap-a', '2026-09-06');

  const got = D.loadLapDetail('lap-a', at, '', { laps, traces });
  check('a lap with a trace loads', got.detail !== null, JSON.stringify(got.reason));
  check('it carries the record\'s lap time, not the file\'s', got.detail.lapMs === 100_000);
  check('it resolves the circuit key', got.detail.mapKey === 'circuit-of-the-americas-5500');
  check('and finds the bundled circuit', got.map !== null && got.map.points.length > 100);
  check('sectors are placed', Math.abs(got.detail.sectors.s1 - 0.3) < 0.01, `${got.detail.sectors.s1}`);
  check('a v1 trace reports no line', got.detail.hasLine === false);
  check('v-max comes off the trace', got.detail.vMaxKph === 100);

  const again = D.loadLapDetail('lap-a', at, got.detail.mapKey, { laps, traces });
  check('a circuit the caller already holds is not resent', again.map === null);
  check('but the lap still comes back', again.detail !== null);

  // A lap with no trace, and a trace with no lap.
  check('a lap id nobody has is named as such',
    D.loadLapDetail('nope', at, '', { laps, traces }).reason === 'no-lap');
  fs.appendFileSync(path.join(laps, '2026-09-06.jsonl'),
    `${JSON.stringify({ ...rec, id: 'lap-b' })}\n`);
  const noTrace = D.loadLapDetail('lap-b', at, '', { laps, traces });
  check('a lap whose trace was never written says so', noTrace.reason === 'no-trace');
  check('and hands back nothing to draw', noTrace.detail === null && noTrace.map === null);

  // A v2 trace does report its line.
  write('lap-c', '2026-09-06', { x: new Array(101).fill(10), z: new Array(101).fill(20) });
  fs.appendFileSync(path.join(laps, '2026-09-06.jsonl'),
    `${JSON.stringify({ ...rec, id: 'lap-c' })}\n`);
  check('a v2 trace reports its line',
    D.loadLapDetail('lap-c', at, '', { laps, traces }).detail.hasLine === true);

  // A lap logged either side of UTC midnight is still found.
  const late = '2026-09-07T00:00:04.000Z';
  fs.writeFileSync(path.join(laps, '2026-09-06.jsonl') + '', fs.readFileSync(path.join(laps, '2026-09-06.jsonl')));
  fs.appendFileSync(path.join(laps, '2026-09-06.jsonl'),
    `${JSON.stringify({ ...rec, id: 'lap-d', at: late })}\n`);
  check('a lap filed on the day before its timestamp is still found',
    D.findLap('lap-d', late, laps) !== null);
  check('an unparseable timestamp is null, not a throw',
    D.findLap('lap-d', 'not-a-date', laps) === null);

  fs.rmSync(root, { recursive: true, force: true });
}

/* -------------------------------------------------------------------------- */
/*  Phase 3 — two laps                                                        */
/* -------------------------------------------------------------------------- */

{
  // The lap clock at a distance, on a lap driven at constant speed: the answer
  // is the fraction of the lap, times the lap time, and nothing else.
  const trace = evenTrace(201, 100);
  check('the line is time zero', D.timeAtDistance(trace, 0) === 0);
  check('half way round is half the lap', Math.abs(D.timeAtDistance(trace, 0.5) - 50) < 0.01);
  check('and the end is the whole lap', Math.abs(D.timeAtDistance(trace, 1) - 100) < 0.01);
  check('between samples it interpolates',
    Math.abs(D.timeAtDistance(trace, 0.5025) - 50.25) < 0.05,
    `${D.timeAtDistance(trace, 0.5025)}`);
  check('past the end is clamped, not extrapolated',
    D.timeAtDistance(trace, 4) === D.timeAtDistance(trace, 1));

  // The clock is normalised: a recorder that started its clock at 812.4 must
  // give the same answers as one that started at zero.
  const late = evenTrace(201, 100);
  late.t = late.t.map((v) => v + 812.4);
  check('a trace whose clock did not start at zero reads the same',
    Math.abs(D.timeAtDistance(late, 0.5) - 50) < 0.01,
    `${D.timeAtDistance(late, 0.5)}`);

  check('a trace with one sample has no clock', D.timeAtDistance(evenTrace(1, 10), 0.5) === null);
}

{
  // Two laps, the second five percent slower everywhere. At every point of the
  // road the first is ahead, and the gap grows to the difference in lap time.
  const fast = evenTrace(201, 100);
  const slow = evenTrace(201, 105);
  const delta = D.deltaTrace(fast, slow);
  check('the delta is on the studied lap\'s own grid', delta.d.length === fast.d.length);
  check('it starts level', Math.abs(delta.dt[0]) < 0.001);
  check('the faster lap is AHEAD, so the gap is negative',
    delta.dt[100] < 0, `${delta.dt[100]}`);
  check('and it ends at the difference between the two lap times',
    Math.abs(delta.dt[delta.dt.length - 1] + 5) < 0.02, `${delta.dt[delta.dt.length - 1]}`);
  check('the reach is the widest the gap ever got',
    Math.abs(delta.reach - 5) < 0.02, `${delta.reach}`);

  // …and the other way round, because the sign is the whole message.
  const other = D.deltaTrace(slow, fast);
  check('the slower lap is BEHIND, so the gap is positive',
    other.dt[other.dt.length - 1] > 4.9, `${other.dt[other.dt.length - 1]}`);

  check('a lap with nothing to compare against is null',
    D.deltaTrace(fast, evenTrace(1, 10)) === null);
}

{
  // Micro-sectors scale with the circuit: ~500 m each, clamped 8..20 (plan
  // decision 3), so a short national layout and Le Mans do not both get 13.
  check('Silverstone National (1.6 km) gets the floor', D.microSectorCount(1640) === 8);
  check('COTA (5.5 km) gets eleven', D.microSectorCount(5497) === 11);
  check('Spa (7 km) gets fourteen', D.microSectorCount(6980) === 14);
  check('Le Mans (13.6 km) gets the ceiling, not 27', D.microSectorCount(13_626) === 20);
  check('a circuit of no length still gets a sane count', D.microSectorCount(0) === 8);
}

{
  const fast = evenTrace(401, 100);
  const slow = evenTrace(401, 110);
  const segs = D.microSectors(fast, slow, 5497);
  check('one entry per micro-sector', segs.length === 11, `${segs.length}`);
  check('they are numbered from one', segs[0].no === 1 && segs[10].no === 11);
  check('they tile the lap end to end',
    segs[0].from === 0 && Math.abs(segs[10].to - 1) < 1e-9);
  check('each one is the same stretch of road on both laps',
    segs.every((s, i) => i === 0 || Math.abs(s.from - segs[i - 1].to) < 1e-9));
  check('the studied lap takes a lap\'s worth of time in total',
    Math.abs(segs.reduce((a, s) => a + s.aSec, 0) - 100) < 0.05);
  check('a lap ten percent slower loses in every sector',
    segs.every((s) => s.deltaSec < 0), `${segs[0].deltaSec}`);
  check('and the losses add up to the difference in lap time',
    Math.abs(segs.reduce((a, s) => a + s.deltaSec, 0) + 10) < 0.05,
    `${segs.reduce((a, s) => a + s.deltaSec, 0)}`);

  const alone = D.microSectors(fast, null, 5497);
  check('with nothing to compare against the sectors are still cut',
    alone.length === 11 && alone[0].aSec > 0);
  check('…but no difference is invented',
    alone.every((s) => s.deltaSec === null && s.bSec === null));
}

{
  // The whole join, end to end, against two laps on disk.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-lapcmp-'));
  const laps = path.join(root, 'laps');
  const traces = path.join(root, 'traces');
  fs.mkdirSync(laps, { recursive: true });
  const at = '2026-09-06T20:14:31.000Z';
  const at2 = '2026-09-06T20:16:31.000Z';
  const base = {
    v: 6, at, sim: 'lmu', track: 'Circuit of the Americas',
    trackKey: 'circuit-of-the-americas_5497', trackLengthM: 5497,
    car: 'Ferrari 296 GT3', carClass: 'LMGT3', distanceM: 5497,
    sessionType: 'practice', clean: true, dirty: [],
    s1Ms: 30_000, s2Ms: 40_000, s3Ms: 30_000,
  };
  fs.writeFileSync(path.join(laps, '2026-09-06.jsonl'),
    `${JSON.stringify({ ...base, id: 'one', lapMs: 100_000 })}\n`
    + `${JSON.stringify({ ...base, id: 'two', at: at2, lapMs: 104_000 })}\n`);
  const writeTrace = (id, when, lapSec) => {
    const dir = path.join(traces, '2026-09-06');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      v: 1, lapId: id, at: when, sim: 'lmu', trackKey: base.trackKey,
      track: base.track, trackLengthM: 5497, car: base.car, carClass: base.carClass,
      lapMs: lapSec * 1000, trace: evenTrace(201, lapSec),
    }));
  };
  writeTrace('one', at, 100);
  writeTrace('two', at2, 104);

  const solo = D.loadLapCompare('one', at, null, '', { laps, traces });
  check('one lap on its own still loads', solo.detail !== null);
  check('with no comparison', solo.vs === null && solo.delta === null);
  check('but with its micro-sectors already cut', solo.micro.length === 11);

  const pair = D.loadLapCompare('one', at, { id: 'two', at: at2 }, '', { laps, traces });
  check('the comparison lap comes back in full, not as a delta alone',
    pair.vs !== null && pair.vs.channels.d.length === 201);
  check('the delta is built', pair.delta !== null);
  check('and says the studied lap was four seconds up by the line',
    Math.abs(pair.delta.dt[pair.delta.dt.length - 1] + 4) < 0.05,
    `${pair.delta.dt[pair.delta.dt.length - 1]}`);
  check('the micro-sectors carry both laps', pair.micro.every((s) => s.bSec !== null));
  // The circuit crosses the bridge once, not twice: both laps are on it.
  check('the circuit is sent once', pair.map !== null);

  const missing = D.loadLapCompare('one', at, { id: 'ghost', at: at2 }, '', { laps, traces });
  check('a comparison lap that is not there does not lose the lap being studied',
    missing.detail !== null && missing.vs === null);
  check('and the reason is named', missing.vsReason === 'no-lap');

  fs.rmSync(root, { recursive: true, force: true });
}

/* -------------------------------------------------------------------------- */
/*  A lap from the league (2026-09-12: compare with anyone on the board)      */
/*                                                                            */
/*  The comparison lap may now be a board lap fetched from `lap_traces`.      */
/*  `detailFromCloudTrace` is the only new shaping; the maths after it is     */
/*  the same `compareWith` both paths share — pinned here so a board          */
/*  comparison can never read differently from one against your own lap.     */
/* -------------------------------------------------------------------------- */

{
  const studied = { track: 'Circuit of the Americas', mapKey: 'circuit-of-the-americas-5500' };
  const trace = evenTrace(301, 102);
  trace.x = trace.d.map((f) => f * 1000);
  trace.z = trace.d.map((f) => f * 500);
  const payload = {
    found: true, driverId: 'a1b2', car: 'Porsche 992 GT3 R', carClass: 'GT3',
    lapMs: 102_000, s1Ms: 30_000, s2Ms: 42_000, s3Ms: 30_000,
    setAt: '2026-09-11T19:00:00.000Z', data: trace,
  };

  const lap = D.detailFromCloudTrace(payload, studied);
  check('a board trace shapes into a lap', lap !== null);
  check('named by the driver under a board: prefix', lap && lap.lapId === 'board:a1b2', lap && lap.lapId);
  check('the board time is the lap time', lap && lap.lapMs === 102_000);
  check('the car travels with it', lap && lap.car === 'Porsche 992 GT3 R');
  check('it borrows the studied lap\'s circuit', lap && lap.mapKey === studied.mapKey && lap.track === studied.track);
  check('a v2 payload has its line', lap && lap.hasLine === true);
  check('the sector lines are found on it',
    lap && lap.sectors.s1 !== null && lap.sectors.s2 !== null && lap.sectors.s1 < lap.sectors.s2);
  check('and the columns are the payload\'s own, not a copy', lap && lap.channels === trace);

  const v1 = D.detailFromCloudTrace({ ...payload, data: evenTrace(301, 102) }, studied);
  check('a pre-line board lap still shapes, and says it has no line', v1 !== null && v1.hasLine === false);

  const halfLine = evenTrace(301, 102);
  halfLine.x = halfLine.d.map((f) => f);
  check('a line with only one column is not a line',
    D.detailFromCloudTrace({ ...payload, data: halfLine }, studied).hasLine === false);

  const noSplits = D.detailFromCloudTrace({ ...payload, s1Ms: null, s2Ms: null, s3Ms: null }, studied);
  check('missing splits mean no sector lines, not a crash',
    noSplits !== null && noSplits.sectors.s1 === null && noSplits.sectors.s2 === null);

  // What the league can answer with that is NOT a lap.
  check('found:false is no lap', D.detailFromCloudTrace({ found: false }, studied) === null);
  check('nothing is no lap', D.detailFromCloudTrace(null, studied) === null);
  check('data that is not a trace is no lap',
    D.detailFromCloudTrace({ ...payload, data: { hello: 'world' } }, studied) === null);
  check('a trace with columns of different lengths is no lap',
    D.detailFromCloudTrace({ ...payload, data: { ...trace, t: trace.t.slice(0, 10) } }, studied) === null);
  check('distance and time alone are enough to compare — the charts cope with a missing column',
    D.detailFromCloudTrace({ ...payload, data: { d: trace.d, t: trace.t } }, studied) !== null);
  check('…but distance without time is not',
    D.detailFromCloudTrace({ ...payload, data: { d: trace.d } }, studied) === null);
}

{
  // The two comparison paths meet in compareWith(): a board lap and one of
  // your own that carry the same trace must produce the same measurement.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-boardcmp-'));
  const laps = path.join(root, 'laps');
  const traces = path.join(root, 'traces');
  fs.mkdirSync(laps, { recursive: true });
  const at = '2026-09-06T20:14:31.000Z';
  const at2 = '2026-09-06T20:16:31.000Z';
  const base = {
    v: 6, at, sim: 'lmu', track: 'Circuit of the Americas',
    trackKey: 'circuit-of-the-americas_5497', trackLengthM: 5497,
    car: 'Ferrari 296 GT3', carClass: 'GT3', distanceM: 5497,
    sessionType: 'practice', clean: true, dirty: [],
    s1Ms: 30_000, s2Ms: 40_000, s3Ms: 30_000,
  };
  fs.writeFileSync(path.join(laps, '2026-09-06.jsonl'),
    `${JSON.stringify({ ...base, id: 'one', lapMs: 100_000 })}\n`
    + `${JSON.stringify({ ...base, id: 'two', at: at2, lapMs: 104_000 })}\n`);
  const write = (id, when, lapSec) => {
    const dir = path.join(traces, '2026-09-06');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      v: 1, lapId: id, at: when, sim: 'lmu', trackKey: base.trackKey,
      track: base.track, trackLengthM: 5497, car: base.car, carClass: base.carClass,
      lapMs: lapSec * 1000, trace: evenTrace(201, lapSec),
    }));
  };
  write('one', at, 100);
  write('two', at2, 104);

  const alone = D.loadLapAlone('one', at, '', { laps, traces });
  check('a lap alone knows its circuit\'s length', alone.lengthM === 5497, `${alone.lengthM}`);
  check('and has its micro-sectors cut with nothing to compare', alone.micro.length === 11 && alone.vs === null);

  const own = D.loadLapCompare('one', at, { id: 'two', at: at2 }, '', { laps, traces });
  const rival = D.detailFromCloudTrace({
    found: true, driverId: 'r1', car: 'BMW M4 GT3', carClass: 'GT3', lapMs: 104_000,
    s1Ms: 30_000, s2Ms: 40_000, s3Ms: 30_000, setAt: at2, data: evenTrace(201, 104),
  }, alone.detail);
  const board = D.compareWith(alone, rival);
  check('a board lap compares', board.vs !== null && board.delta !== null);
  check('the board lap is the one handed in', board.vs === rival);
  check('the same trace measures the same against a rival as against yourself',
    Math.abs(board.delta.dt[board.delta.dt.length - 1] - own.delta.dt[own.delta.dt.length - 1]) < 1e-9
      && board.micro.length === own.micro.length
      && board.micro.every((s, i) => Math.abs(s.deltaSec - own.micro[i].deltaSec) < 1e-9));
  check('positive is still losing', board.delta.dt[board.delta.dt.length - 1] < 0);
  check('the studied lap is untouched', board.detail === alone.detail && board.lengthM === 5497);
  check('a comparison cannot be laid under a lap that did not load',
    D.compareWith({ detail: null, map: null, vs: null, delta: null, micro: [], lengthM: 0 }, rival).vs === null);

  // The Leaderboard tab's other half: which of YOUR laps to open against a row.
  const SR = require(path.join(__dirname, '..', 'dist', 'telemetry', 'stintReview.js'));
  fs.appendFileSync(path.join(laps, '2026-09-06.jsonl'),
    `${JSON.stringify({ ...base, id: 'dirty', at: '2026-09-06T20:18:31.000Z', lapMs: 98_000, clean: false, dirty: ['limits'] })}\n`
    + `${JSON.stringify({ ...base, id: 'untraced', at: '2026-09-06T20:20:31.000Z', lapMs: 99_000 })}\n`
    + `${JSON.stringify({ ...base, id: 'lmp2', at: '2026-09-06T20:22:31.000Z', lapMs: 90_000, carClass: 'LMP2' })}\n`);
  write('dirty', '2026-09-06T20:18:31.000Z', 98);
  write('lmp2', '2026-09-06T20:22:31.000Z', 90);

  const best = SR.bestTracedLap(['circuit-of-the-americas_5497'], 'GT3', laps);
  check('your best studiable lap here is found', best !== null && best.id === 'one', best && best.id);
  check('it knows which session to open', best !== null && typeof best.sessionId === 'string' && best.sessionId.length > 0);
  check('a quicker dirty lap is not it', best !== null && best.lapMs === 100_000);
  check('nor a quicker lap with no trace', best === null || best.id !== 'untraced');
  check('the class is respected', SR.bestTracedLap(['circuit-of-the-americas_5497'], 'LMP2', laps).id === 'lmp2');
  check('…case-insensitively', SR.bestTracedLap(['circuit-of-the-americas_5497'], 'gt3', laps).id === 'one');
  check('any of the league\'s keys for the circuit will do',
    SR.bestTracedLap(['some-merged-alias', 'CIRCUIT-OF-THE-AMERICAS_5497'], 'GT3', laps).id === 'one');
  check('an unknown circuit is null, not a lap elsewhere', SR.bestTracedLap(['spa_6980'], 'GT3', laps) === null);
  check('no keys is null', SR.bestTracedLap([], 'GT3', laps) === null);

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\ntest-lapdetail: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
