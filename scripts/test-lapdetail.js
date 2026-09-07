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

console.log(`\ntest-lapdetail: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
