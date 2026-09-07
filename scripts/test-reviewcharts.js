/**
 * test-reviewcharts.js — the Review tab's lap-time chart.
 * -----------------------------------------------------------------------------
 * The painter is pure — canvas in, hit map out — so it can be driven in plain
 * Node against a recording 2D context. Which is worth doing, because the two
 * things it gets wrong are both silent:
 *
 *   1. **Scale.** One three-minute out-lap on a 1:46 circuit will squash every
 *      real lap into the top eighth of the box if the y-domain is taken from
 *      all the laps rather than the clean ones. The chart still draws; it is
 *      just useless, and nothing fails.
 *   2. **The hit map.** The tooltip and the click-to-find-a-lap both read the
 *      coordinates this returns. If they drift from what was painted, hovering
 *      a point reports a different lap — which reads as the data being wrong.
 *
 * Run: npm run test:reviewcharts
 */

'use strict';

const path = require('node:path');

const CHARTS = require(path.join(__dirname, '..', 'electron', 'control-panel', 'review-charts.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/* -------------------------------------------------------------------------- */
/*  A recording canvas                                                        */
/* -------------------------------------------------------------------------- */

function fakeCanvas(w = 640, h = 160) {
  const calls = [];
  const ctx = {
    setTransform() {}, clearRect() {}, fillRect() {}, closePath() {},
    beginPath() { calls.push(['beginPath']); },
    moveTo(x, y) { calls.push(['moveTo', x, y]); },
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    arc(x, y, r) { calls.push(['arc', x, y, r]); },
    stroke() { calls.push(['stroke']); }, fill() { calls.push(['fill']); },
    fillText(t, x, y) { calls.push(['fillText', t, x, y]); },
    setLineDash(d) { calls.push(['setLineDash', (d || []).length]); },
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '',
    textAlign: '', textBaseline: '',
  };
  return {
    calls,
    canvas: {
      width: 0, height: 0,
      getBoundingClientRect: () => ({ width: w, height: h }),
      getContext: () => ctx,
    },
  };
}

const FMT = {
  fmtLap: (ms) => {
    const m = Math.floor(ms / 60000);
    return `${m}:${((ms - m * 60000) / 1000).toFixed(3).padStart(6, '0')}`;
  },
  dayLabel: (day) => day,
};

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

let seq = 0;
function lap(lapMs, over = {}) {
  seq += 1;
  return {
    lapNo: seq, stintNo: over.stintNo || 1, stintLap: seq, lapMs,
    clean: over.clean !== false, dirty: over.dirty || [],
    timed: over.timed !== false, isOutLap: false, isInLap: false, hasTrace: false,
    at: new Date(Date.parse('2026-09-06T18:00:00Z') + seq * lapMs).toISOString(),
    ...over,
  };
}

function session(stints) {
  seq = 0;
  const built = stints.map((laps, i) => ({
    no: i + 1, laps, startedAt: '', endedAt: '',
    stats: { bestMs: null, bestSectors: [null, null, null] },
  }));
  const all = built.flatMap((s) => s.laps);
  const clean = all.filter((l) => l.clean && l.timed).map((l) => l.lapMs);
  return {
    stints: built,
    stats: { bestMs: clean.length ? Math.min(...clean) : null, bestSectors: [null, null, null] },
    trend: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  The lap chart                                                             */
/* -------------------------------------------------------------------------- */

{
  const s = session([[lap(107_400), lap(106_900), lap(107_100), lap(107_600)]]);
  const { canvas } = fakeCanvas();
  const hits = CHARTS.drawLapChart(canvas, s, FMT);

  check('one hit per lap', hits.length === 4, `${hits.length}`);
  check('hits are in lap order', hits.map((h) => h.lap.lapNo).join() === '1,2,3,4');
  check('x increases left to right', hits.every((h, i) => i === 0 || h.px > hits[i - 1].px));
  // Lap time runs UP the y axis, as it does on every timing sparkline and on
  // the reference screens — so the fastest lap is the one nearest the floor.
  check('the fastest lap sits at the bottom',
    hits[1].py === Math.max(...hits.map((h) => h.py)), `${hits[1].py}`);
  check('the slowest sits at the top',
    hits[3].py === Math.min(...hits.map((h) => h.py)), `${hits[3].py}`);
  check('the canvas was sized to its box', canvas.width === 640 && canvas.height === 160);
}

{
  // The scale test: a 3-minute out-lap among 1:46s. Without clamping the four
  // real laps land within a couple of pixels of each other.
  const s = session([[
    lap(186_000, { clean: false, dirty: ['pit'], isOutLap: true }),
    lap(107_400), lap(106_900), lap(107_100), lap(107_600),
  ]]);
  const { canvas } = fakeCanvas(640, 160);
  const hits = CHARTS.drawLapChart(canvas, s, FMT);
  const real = hits.slice(1).map((h) => h.py);
  const spread = Math.max(...real) - Math.min(...real);
  check('the outlier does not flatten the real laps', spread > 40, `${spread.toFixed(1)}px`);
  check('every point stays inside the box', hits.every((h) => h.py >= 0 && h.py <= 160));
  check('the outlier is clamped to the top', hits[0].py <= Math.min(...real), `${hits[0].py}`);
}

{
  // The line must break at a stint boundary — joining across a pit stop draws
  // a slope nobody drove. One moveTo per stint that has a clean lap in it.
  const s = session([
    [lap(107_400), lap(107_100)],
    [lap(106_900, { stintNo: 2 }), lap(107_000, { stintNo: 2 })],
  ]);
  const { canvas, calls } = fakeCanvas();
  CHARTS.drawLapChart(canvas, s, FMT);
  // Gridline moveTos are on whole+0.5 y and span the full width; the series'
  // are not. Count the ones that start at a data x instead.
  const starts = calls.filter(([op, x]) => op === 'moveTo' && x > 54.5 && x < 630);
  check('the series is drawn in two runs', starts.length >= 2, `${starts.length}`);
  check('a boundary rule is dashed', calls.some(([op, n]) => op === 'setLineDash' && n > 0));
  check('the stints are labelled', calls.some(([op, t]) => op === 'fillText' && t === 'S2'));
}

{
  // Degenerate inputs must not throw and must not paint a nonsense box.
  const { canvas } = fakeCanvas();
  check('an empty session paints nothing', CHARTS.drawLapChart(canvas, session([[]]), FMT).length === 0);

  const noTimes = session([[lap(0, { timed: false, clean: false, dirty: ['implausible'] })]]);
  check('a session with no time at all is safe',
    CHARTS.drawLapChart(fakeCanvas().canvas, noTimes, FMT).length === 0);

  const one = session([[lap(107_000)]]);
  const hits = CHARTS.drawLapChart(fakeCanvas().canvas, one, FMT);
  check('a single lap is centred, not divided by zero',
    hits.length === 1 && Number.isFinite(hits[0].px) && hits[0].px > 200, `${hits[0] && hits[0].px}`);

  const flat = session([[lap(107_000), lap(107_000), lap(107_000)]]);
  const flatHits = CHARTS.drawLapChart(fakeCanvas().canvas, flat, FMT);
  check('a metronome still gets a box to draw in',
    flatHits.every((h) => Number.isFinite(h.py)), JSON.stringify(flatHits.map((h) => h.py)));
}

/* -------------------------------------------------------------------------- */
/*  The trend                                                                 */
/* -------------------------------------------------------------------------- */

{
  const trend = [
    { day: '2026-08-20', bestMs: 108_400 },
    { day: '2026-08-27', bestMs: 107_600 },
    { day: '2026-09-06', bestMs: 106_900 },
  ];
  const { canvas, calls } = fakeCanvas(560, 74);
  CHARTS.drawTrend(canvas, trend, '2026-09-06', FMT);
  const dots = calls.filter(([op]) => op === 'arc');
  check('one dot per day driven', dots.length === 3, `${dots.length}`);
  check('the days are spaced by date, not by index',
    Math.abs((dots[1][1] - dots[0][1]) - (dots[2][1] - dots[1][1])) > 20,
    `${dots.map((d) => Math.round(d[1])).join()}`);
  check('this session\'s day is marked larger', dots[2][3] > dots[0][3], `${dots[2][3]}`);
  check('the ends are labelled', calls.some(([op, t]) => op === 'fillText' && t === '2026-08-20'));

  const empty = fakeCanvas();
  CHARTS.drawTrend(empty.canvas, [], '', FMT);
  check('an empty trend paints nothing', !empty.calls.some(([op]) => op === 'arc'));

  const single = fakeCanvas();
  CHARTS.drawTrend(single.canvas, [{ day: '2026-09-06', bestMs: 106_900 }], '2026-09-06', FMT);
  const only = single.calls.filter(([op]) => op === 'arc');
  check('one day is centred rather than divided by zero',
    only.length === 1 && Number.isFinite(only[0][1]) && only[0][1] > 200, `${only[0] && only[0][1]}`);
}


/* -------------------------------------------------------------------------- */
/*  The lap's channels (phase 2)                                              */
/* -------------------------------------------------------------------------- */

/** A synthetic lap's columns, constant-speed so distance tracks time. */
function chans(n, over) {
  const d = [];
  const t = [];
  for (let i = 0; i < n; i++) { d.push(i / (n - 1)); t.push((i / (n - 1)) * 100); }
  return {
    d, t,
    throttle: d.map(() => 1),
    brake: d.map(() => 0),
    steer: d.map(() => 0),
    gear: d.map(() => 4),
    speedKph: d.map((v) => 100 + v * 100),
    latG: d.map(() => 0),
    lonG: d.map(() => 0),
    tc: d.map(() => 0),
    abs: d.map(() => 0),
    lapSec: 100,
    count: n,
    truncated: false,
    ...over,
  };
}

{
  const bands = CHARTS.channelBands({ mph: false });
  check('four bands, in reading order',
    bands.map((b) => b.label).join() === 'Speed,Throttle / brake,Gear,Steering',
    bands.map((b) => b.label).join());
  check('throttle and brake share one band',
    bands[1].series.length === 2 && bands[1].series.map((s) => s.key).join() === 'throttle,brake');
  check('TC and ABS are ticks on that band, not bands of their own',
    (bands[1].marks || []).map((m) => m.key).join() === 'tc,abs');
  check('gear is stepped', bands[2].series[0].step === true);
  check('mph rescales the speed series, not the axis label',
    Math.abs(CHARTS.channelBands({ mph: true })[0].series[0].scale - 0.621371) < 1e-6);
  check('km/h leaves it alone', bands[0].series[0].scale === 1);
}

{
  const { canvas } = fakeCanvas(800, 400);
  const geom = CHARTS.drawChannels(canvas, chans(200), CHARTS.channelBands({}), {
    sectors: { s1: 0.3, s2: 0.7 }, lengthM: 5497, cursorD: -1,
  });
  check('the geometry comes back', geom !== null);
  check('one entry per band', geom.bands.length === 4, `${geom.bands.length}`);
  check('bands stack downward without overlapping',
    geom.bands.every((b, i) => i === 0 || b.y0 >= geom.bands[i - 1].y1));
  check('and all of them fit the box',
    geom.bands.every((b) => b.y0 >= 0 && b.y1 <= 400));
  check('the plot leaves room for the axis on the left', geom.x0 > 20 && geom.x0 < 80);
  check('and reaches the right edge', geom.x1 > 780, `${geom.x1}`);
}

{
  // Steering scaled to the lap: a GT car uses a few degrees nearly everywhere,
  // and on a fixed -100..100 axis every lap is a flat line.
  const small = chans(200, { steer: null });
  small.steer = small.d.map((v) => Math.sin(v * 6) * 0.08);
  const { canvas, calls } = fakeCanvas(800, 400);
  CHARTS.drawChannels(canvas, small, CHARTS.channelBands({}), {});
  const labels = calls.filter(([op]) => op === 'fillText').map(([, t]) => String(t));
  check('the steering axis shrinks to the lap',
    labels.some((t) => t === '12R' || t === '12L'), labels.join(' '));

  const big = chans(200, {});
  big.steer = big.d.map((v) => Math.sin(v * 6) * 0.9);
  const second = fakeCanvas(800, 400);
  CHARTS.drawChannels(second.canvas, big, CHARTS.channelBands({}), {});
  const l2 = second.calls.filter(([op]) => op === 'fillText').map(([, t]) => String(t));
  check('…and grows for a lap that used the wheel',
    l2.some((t) => /^1\d\dR$/.test(t)), l2.join(' '));
}

{
  // Sector rules are drawn once each, across every band — the reason the bands
  // share a canvas at all.
  const { canvas, calls } = fakeCanvas(800, 400);
  CHARTS.drawChannels(canvas, chans(200), CHARTS.channelBands({}), {
    sectors: { s1: 0.3, s2: 0.7 }, lengthM: 5497,
  });
  const labels = calls.filter(([op]) => op === 'fillText').map(([, t]) => String(t));
  check('every sector is named', ['S1', 'S2', 'S3'].every((n) => labels.includes(n)),
    labels.join(' '));
  check('the lap length is on the axis', labels.includes('5497 m'));
  check('a lap with no sectors still draws', CHARTS.drawChannels(
    fakeCanvas().canvas, chans(200), CHARTS.channelBands({}), { sectors: { s1: null, s2: null } },
  ) !== null);
  check('an empty trace paints nothing',
    CHARTS.drawChannels(fakeCanvas().canvas, chans(1), CHARTS.channelBands({}), {}) === null);
}

/* -------------------------------------------------------------------------- */
/*  The lap on the circuit                                                    */
/* -------------------------------------------------------------------------- */

/** A square circuit, 100 m a side, rising 20 m along one edge. */
function squareMap(rise) {
  const points = [];
  for (let i = 0; i < 40; i++) points.push([i * 2.5, 0, rise ? (i / 40) * rise : 0]);
  for (let i = 0; i < 40; i++) points.push([100, i * 2.5, rise || 0]);
  for (let i = 0; i < 40; i++) points.push([100 - i * 2.5, 100, rise ? rise - (i / 40) * rise : 0]);
  for (let i = 0; i < 40; i++) points.push([0, 100 - i * 2.5, 0]);
  return { key: 'square-400', name: 'Square', lengthM: 400, halfWidthM: 6, binM: 2.5, points,
    builtAt: '', revision: 1 };
}

{
  const { canvas, calls } = fakeCanvas(300, 300);
  const out = CHARTS.drawLapMap(canvas, squareMap(20), chans(160), { cursorD: 0.5 });
  check('the map paints', out !== null);
  check('elevation is read off the circuit', out.minY === 0 && out.maxY === 20);
  check('and a circuit with real rise is shaded', out.shaded === true);
  check('a flat circuit is not', CHARTS.drawLapMap(fakeCanvas().canvas, squareMap(0), chans(160), {}).shaded === false);
  check('a v1 lap reports no line on the map', out.placed === false);
  check('the cursor is drawn', calls.some(([op, , , r]) => op === 'arc' && r === 4));
}

{
  // The v1 fallback: the marker goes on the centreline at the right distance.
  // Half way round the square is the far corner, (100, 100).
  const { canvas, calls } = fakeCanvas(300, 300);
  CHARTS.drawLapMap(canvas, squareMap(0), chans(160), { cursorD: 0.5 });
  const dot = calls.filter(([op, , , r]) => op === 'arc' && r === 4)[0];
  const { calls: c2 } = (() => {
    const f = fakeCanvas(300, 300);
    CHARTS.drawLapMap(f.canvas, squareMap(0), chans(160), { cursorD: 0 });
    return f;
  })();
  const start = c2.filter(([op, , , r]) => op === 'arc' && r === 4)[0];
  check('the marker moves with the distance',
    Math.hypot(dot[1] - start[1], dot[2] - start[2]) > 100,
    `${Math.round(dot[1])},${Math.round(dot[2])} vs ${Math.round(start[1])},${Math.round(start[2])}`);
  check('and stays inside the canvas',
    dot[1] >= 0 && dot[1] <= 300 && dot[2] >= 0 && dot[2] <= 300);
}

{
  // A v2 lap draws its own line and puts the marker on THAT, not the centreline.
  const placed = chans(160);
  placed.x = placed.d.map((v) => v * 100);
  placed.z = placed.d.map(() => 50);
  const { canvas } = fakeCanvas(300, 300);
  const out = CHARTS.drawLapMap(canvas, squareMap(0), placed, { cursorD: 0.5, cursorIndex: 80 });
  check('a v2 lap reports its line', out.placed === true);

  const f = fakeCanvas(300, 300);
  CHARTS.drawLapMap(f.canvas, squareMap(0), placed, { cursorD: 0.5, cursorIndex: 80 });
  const dot = f.calls.filter(([op, , , r]) => op === 'arc' && r === 4)[0];
  // Index 80 of 160 is x=50, z=50 — the middle of the box, which the centreline
  // fallback (the far corner) is nowhere near.
  check('the marker follows the driven line, not the centreline',
    Math.abs(dot[1] - 150) < 40 && Math.abs(dot[2] - 150) < 40,
    `${Math.round(dot[1])},${Math.round(dot[2])}`);
}

{
  check('a circuit with no shape paints nothing',
    CHARTS.drawLapMap(fakeCanvas().canvas, { points: [] }, chans(10), {}) === null);
  check('no map at all is safe',
    CHARTS.drawLapMap(fakeCanvas().canvas, null, chans(10), {}) === null);
  check('no cursor is safe',
    CHARTS.drawLapMap(fakeCanvas().canvas, squareMap(0), chans(160), {}) !== null);
}

console.log(`\ntest-reviewcharts: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
