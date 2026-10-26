/**
 * test-comparegears.js — both cars' gears on the Review lap comparison.
 * -----------------------------------------------------------------------------
 * Carl, 2026-10-26: "on the compare lap time screen … it's not showing both
 * cars' gear changes". The data was never the problem: every local trace
 * (1 364 on the dev box, 2026-08-07 → 2026-10-25) and every board trace in
 * `lap_traces` (564, all with a full-length `gear` column) carries gear for
 * both laps. The Gear band was simply the one channel band built without
 * `compare: true`, a phase 3 decision ("two staircases are unreadable") that
 * the reviewcharts suite pinned. This suite pins the reverse, and the two
 * things that made two staircases unreadable:
 *
 *   1. **Overlap.** Two cars are in the same gear at the same corner for most
 *      of a lap, so two lines at the same height hide one another. The band
 *      pulls them `separate` px apart.
 *   2. **Shift blips.** LMU reports neutral for the instant the box is between
 *      gears and the recorder catches it on every lap (~12 a lap), each a spike
 *      to the floor. `gearDrawn` holds a short run of them at the gear left.
 *
 * Plus the degrade: a lap with no gear data says so in the band.
 *
 * If `~/.apex-overlay/traces` exists the last block also draws two REAL laps
 * from the same circuit; it is skipped (and says so) on a box without them.
 *
 * Run: npm run test:comparegears
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHARTS = require(path.join(__dirname, '..', 'electron', 'control-panel', 'review-charts.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A recording 2D context that remembers the dash and colour of every stroke. */
function fakeCanvas(w = 900, h = 420) {
  const calls = [];
  let dash = 0;
  let path = [];
  const ctx = {
    setTransform() {}, clearRect() {}, fillRect() {}, closePath() {},
    save() {}, restore() {}, clip() {}, rect() {}, drawImage() {}, translate() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    arc() {},
    stroke() { calls.push({ op: 'stroke', color: this.strokeStyle, dash, pts: path.slice() }); },
    fill() {},
    fillText(t, x, y) { calls.push({ op: 'text', t: String(t), x, y }); },
    setLineDash(d) { dash = (d || []).length; },
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
  };
  return {
    calls,
    canvas: { width: 0, height: 0, getBoundingClientRect: () => ({ width: w, height: h }), getContext: () => ctx },
  };
}

/** A lap's columns with the given gear column (and a speed to go with it). */
function lap(gear, over = {}) {
  const n = gear.length;
  const d = gear.map((_, i) => i / (n - 1));
  return {
    d, t: d.map((v) => v * 100),
    throttle: d.map(() => 1), brake: d.map(() => 0), steer: d.map(() => 0),
    gear, speedKph: d.map(() => 180),
    latG: d.map(() => 0), lonG: d.map(() => 0), tc: d.map(() => 0), abs: d.map(() => 0),
    lapSec: 100, count: n, truncated: false,
    ...over,
  };
}

const bands = CHARTS.channelBands({});
const gearIdx = bands.findIndex((b) => b.label === 'Gear');
const gearBand = bands[gearIdx];

/** The strokes that fall inside the gear band of a drawn geometry. */
function gearStrokes(calls, geom) {
  const b = geom.bands.find((x) => x.label === 'Gear');
  return calls.filter((c) => c.op === 'stroke' && c.pts.length > 1
    && c.pts.every(([, y]) => y >= b.y0 - 3 && y <= b.y1 + 3));
}

/* -------------------------------------------------------------------------- */
/*  The cause: the band never asked for the other lap                         */
/* -------------------------------------------------------------------------- */

{
  check('there is a Gear band', gearIdx >= 0);
  check('it takes the comparison lap, like every other channel', gearBand.compare === true);
  const s = gearBand.series[0];
  check('the other lap has its own paler shade of the channel colour',
    typeof s.cmp === 'string' && s.cmp !== s.color, `${s.color} / ${s.cmp}`);
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
  };
  check('…paler, as speed / pedals / steering do it',
    typeof s.cmp === 'string' && lum(s.cmp) > lum(s.color));
  check('still drawn as steps', s.step === true);
  check('the two lines are pulled apart', gearBand.separate > 0 && gearBand.separate <= 3);
  check('and a lap without gear data is named', typeof gearBand.missing === 'string');
}

/* -------------------------------------------------------------------------- */
/*  Two laps drawn: two staircases, one solid one dashed, both visible       */
/* -------------------------------------------------------------------------- */

{
  const mine = lap([2, 2, 3, 3, 4, 4, 5, 5, 4, 3, 3, 4, 5, 6, 6, 6, 5, 4, 3, 3]);
  const theirs = lap([2, 3, 3, 4, 4, 5, 5, 6, 5, 4, 3, 3, 4, 5, 6, 7, 6, 4, 3, 3]);

  const solo = fakeCanvas();
  const soloGeom = CHARTS.drawChannels(solo.canvas, mine, bands, {});
  check('alone, one gear line', gearStrokes(solo.calls, soloGeom).length === 1,
    `${gearStrokes(solo.calls, soloGeom).length}`);

  const both = fakeCanvas();
  const geom = CHARTS.drawChannels(both.canvas, mine, bands, { vs: theirs });
  const lines = gearStrokes(both.calls, geom);
  check('with a comparison lap, TWO gear lines', lines.length === 2, `${lines.length}`);
  const dashed = lines.find((l) => l.dash > 0);
  const solid = lines.find((l) => l.dash === 0);
  check('theirs dashed, in the comparison shade', dashed && dashed.color === gearBand.series[0].cmp,
    dashed && dashed.color);
  check('yours solid, in the channel colour', solid && solid.color === gearBand.series[0].color);
  check('theirs goes down first, so yours is on top',
    lines.indexOf(dashed) < lines.indexOf(solid));

  // The axis covers both: their 7th is above anything you used.
  const b = geom.bands.find((x) => x.label === 'Gear');
  const topLabel = both.calls.find((c) => c.op === 'text' && Math.abs(c.y - b.y0) < 0.01 && c.x < geom.x0);
  check('the axis reaches the other lap\'s top gear', topLabel && Number(topLabel.t) >= 7,
    topLabel && topLabel.t);
  check('no missing-data note when both laps have gear', !b.missing
    && !both.calls.some((c) => c.op === 'text' && /no gear data/.test(c.t)));
}

{
  // Identical laps: the overlap case. Drawn at one height the solid line
  // covers the dashed one completely — which is what "only one car's gears"
  // looks like even when both are drawn.
  const g = [3, 3, 4, 4, 5, 5, 4, 3, 3, 4];
  const c = fakeCanvas();
  const geom = CHARTS.drawChannels(c.canvas, lap(g), bands, { vs: lap(g.slice()) });
  const [a, b] = gearStrokes(c.calls, geom);
  const gap = a && b ? Math.abs(a.pts[0][1] - b.pts[0][1]) : 0;
  check('two laps in the same gear do not sit on one line', gap >= 2 * gearBand.separate - 1e-9, `${gap}`);
  const yours = [a, b].find((l) => l && l.dash === 0);
  const theirs = [a, b].find((l) => l && l.dash > 0);
  check('yours above, theirs below', yours && theirs && yours.pts[0][1] < theirs.pts[0][1]);
  // …and only when there IS a second lap: alone, the line is where the axis says.
  const one = fakeCanvas();
  const g1 = CHARTS.drawChannels(one.canvas, lap(g), bands, {});
  const solo = gearStrokes(one.calls, g1)[0];
  check('alone, the line is not nudged', yours && Math.abs(solo.pts[0][1] - (yours.pts[0][1] + gearBand.separate)) < 1e-9);
}

/* -------------------------------------------------------------------------- */
/*  Shift blips: a neutral caught mid-shift is drawn as the shift             */
/* -------------------------------------------------------------------------- */

{
  const raw = [4, 4, 0, 3, 3, 3, 0, 0, 2, 2];
  const cols = lap(raw);
  const drawn = CHARTS.gearDrawn(cols);
  check('a one-sample neutral at speed is held at the gear it left', drawn[2] === 4, drawn.join());
  check('a two-sample one too', drawn[6] === 3 && drawn[7] === 3, drawn.join());
  check('the real gears are untouched', drawn[3] === 3 && drawn[8] === 2);
  check('the trace itself is not rewritten (the readout reads it raw)', cols.gear[2] === 0 && cols.gear !== drawn);

  const long = lap([3, 3, 0, 0, 0, 0, 0, 2, 2, 2]);
  check('a long neutral is real (a spin, a stall) and is kept', CHARTS.gearDrawn(long).slice(2, 7).every((v) => v === 0));

  const slow = lap([1, 1, 0, 1, 1, 1], { speedKph: [10, 10, 10, 10, 10, 10] });
  check('a neutral at walking pace (the pits) is kept', CHARTS.gearDrawn(slow)[2] === 0);

  const rev = lap([-1, -1, -1, 0, 1, 1]);
  check('reverse at the start of a lap is left as it is', CHARTS.gearDrawn(rev).slice(0, 3).every((v) => v === -1));

  const tail = lap([4, 4, 5, 0]);
  check('a neutral on the last sample has no gear after it, so it stays', CHARTS.gearDrawn(tail)[3] === 0);

  check('the band draws the held column', gearBand.series[0].column === CHARTS.gearDrawn);

  const c = fakeCanvas();
  const geom = CHARTS.drawChannels(c.canvas, cols, bands, {});
  const line = gearStrokes(c.calls, geom)[0];
  const b = geom.bands.find((x) => x.label === 'Gear');
  check('so no stroke falls to the floor of the band', line && line.pts.every(([, y]) => y < b.y1 - 0.5),
    line && JSON.stringify(line.pts.map(([, y]) => Math.round(y))));
}

/* -------------------------------------------------------------------------- */
/*  Degrade: a lap without gear data says so                                  */
/* -------------------------------------------------------------------------- */

{
  check('gearKnown: a normal lap', CHARTS.gearKnown(lap([3, 4, 5])) === true);
  check('gearKnown: no column', CHARTS.gearKnown({ d: [0, 1] }) === false);
  check('gearKnown: no lap', CHARTS.gearKnown(null) === false);
  check('gearKnown: a column of zeros was never read', CHARTS.gearKnown(lap([0, 0, 0])) === false);
  check('gearKnown: wrong length for the lap', CHARTS.gearKnown(lap([3, 4, 5]), 4) === false);

  const mine = lap([3, 4, 5, 4, 3, 3]);
  const theirs = lap([3, 4, 5, 4, 3, 3]);
  delete theirs.gear;
  const c = fakeCanvas();
  const geom = CHARTS.drawChannels(c.canvas, mine, bands, { vs: theirs });
  const b = geom.bands.find((x) => x.label === 'Gear');
  check('the other lap without gear: noted in the geometry', JSON.stringify(b.missing) === '["theirs"]',
    JSON.stringify(b.missing));
  check('…and on the band, in words', c.calls.some((x) => x.op === 'text' && x.t === 'no gear data for the other lap'));
  check('…and your line is still drawn', gearStrokes(c.calls, geom).length === 1);
  const alone = fakeCanvas();
  const ga = CHARTS.drawChannels(alone.canvas, mine, bands, {});
  check('…at its true height, not nudged away from a line that is not there',
    Math.abs(gearStrokes(c.calls, geom)[0].pts[0][1] - gearStrokes(alone.calls, ga)[0].pts[0][1]) < 1e-9);

  const zeros = lap([0, 0, 0, 0, 0, 0]);
  const c2 = fakeCanvas();
  const g2 = CHARTS.drawChannels(c2.canvas, zeros, bands, { vs: mine });
  const b2 = g2.bands.find((x) => x.label === 'Gear');
  check('your lap without gear: "this lap"', c2.calls.some((x) => x.op === 'text' && x.t === 'no gear data for this lap'),
    JSON.stringify(b2.missing));
  check('…and no flat line on the floor pretending to be neutral', gearStrokes(c2.calls, g2).length === 1);

  const c3 = fakeCanvas();
  CHARTS.drawChannels(c3.canvas, zeros, bands, { vs: lap([0, 0, 0, 0, 0, 0]) });
  check('neither: "either lap"', c3.calls.some((x) => x.op === 'text' && x.t === 'no gear data for either lap'));

  const c4 = fakeCanvas();
  CHARTS.drawChannels(c4.canvas, mine, bands, {});
  check('no comparison, a complete lap: no note at all', !c4.calls.some((x) => x.op === 'text' && /no gear data/.test(x.t)));
}

/* -------------------------------------------------------------------------- */
/*  Two real laps from this box, when it has them                             */
/* -------------------------------------------------------------------------- */

{
  const root = path.join(os.homedir(), '.apex-overlay', 'traces');
  const byTrack = new Map();
  if (fs.existsSync(root)) {
    const days = fs.readdirSync(root).sort().reverse();
    outer: for (const day of days) {
      const dir = path.join(root, day);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        let j;
        try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        if (!j || !j.trace || !Array.isArray(j.trace.d) || j.trace.d.length < 100) continue;
        const k = j.track || '';
        const list = byTrack.get(k) || [];
        list.push(j.trace);
        byTrack.set(k, list);
        if (list.length >= 2) break outer;
      }
    }
  }
  const pair = [...byTrack.values()].find((l) => l.length >= 2);
  if (!pair) {
    console.log('  (no two local laps at one circuit on this box — real-data block skipped)');
  } else {
    const [mine, theirs] = pair;
    check('real laps: both carry gear', CHARTS.gearKnown(mine, mine.d.length) && CHARTS.gearKnown(theirs, theirs.d.length));
    const c = fakeCanvas(1400, 600);
    const geom = CHARTS.drawChannels(c.canvas, mine, CHARTS.channelBands({ delta: false }), { vs: theirs });
    const lines = gearStrokes(c.calls, geom);
    check('real laps: two gear lines, one dashed', lines.length === 2 && lines.some((l) => l.dash > 0)
      && lines.some((l) => l.dash === 0), `${lines.length}`);
    const b = geom.bands.find((x) => x.label === 'Gear');
    const floorHits = (l) => l.pts.filter(([, y]) => y > b.y1 - 3).length;
    check('real laps: shift blips no longer reach the floor',
      lines.every((l) => floorHits(l) === 0), lines.map(floorHits).join());
  }
}

console.log(`\ntest-comparegears: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
