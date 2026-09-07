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
    setTransform() {}, clearRect() {}, beginPath() { calls.push(['beginPath']); },
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

console.log(`\ntest-reviewcharts: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
