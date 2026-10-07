/**
 * scripts/test-training-widgets.js — the maths under Trace, Corner card and
 * Lap strip, and the wiring that keeps them out of the race overlay.
 * -----------------------------------------------------------------------------
 * The widgets are canvases and text; what can go wrong quietly is underneath:
 *
 *   §1 the trail of your inputs by the metre — filled between frames, not
 *      across a tow, read back only for the metre it holds;
 *   §2 the reference on the same metre grid, and its braking zones starting
 *      where the server's corner card measures from;
 *   §3 the lap unwrapped through the line, so the strip never jumps back;
 *   §4 sectors as gap differences: at the reference's own lines, learned
 *      from the car when it has none, rolled over at the line;
 *   §5 the words and colours both corner widgets share;
 *   §6 the hosts: registered at the right rates, shells kept out of
 *      ingame.html, scripts loaded before the widgets that need them.
 *
 * Run: npm run test:trainingwidgets
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TR = require('../overlay/js/training-trace.js');
const LAPS = require('../overlay/js/training-laps.js');
const { ghostFromTrace, ghostJson } = require('../dist/telemetry/ghostLap');
const { brakePoints, BRAKE_ON, BRAKE_OFF, ZONE_GAP_M } = require('../dist/telemetry/brakePoints');

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
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const file = JSON.parse(read('scripts', 'fixtures', 'trace-road-atlanta-gt3.json'));
const line = ghostJson(ghostFromTrace(file, '1:21.275'));
const L = line.trackLengthM;

console.log('\n1) Your trail, by the metre');
{
  check('the brake thresholds mirror brakePoints.ts', TR.BRAKE_ON === BRAKE_ON && TR.BRAKE_OFF === BRAKE_OFF && TR.ZONE_GAP_M === ZONE_GAP_M);
  const tr = TR.createTrail(64);
  TR.writeTrail(tr, 100.2, 1, 0, 0);
  TR.writeTrail(tr, 104.9, 0, 1, 0.4);
  const at = (m) => TR.trailSlot(tr, m);
  check('both frames land in their own metre', at(100) >= 0 && at(104) >= 0);
  check('the metres between are filled on a straight line', [101, 102, 103].every((m) => at(m) >= 0) && near(tr.thr[at(102)], 0.5, 1e-6) && near(tr.brk[at(102)], 0.5, 1e-6) && near(tr.str[at(102)], 0.2, 1e-6), tr.thr[at(102)]);
  check('a metre never written reads as empty', at(99) === -1 && at(105) === -1);
  TR.writeTrail(tr, 104.95, 0.3, 0.2, 0);
  check('a frame in the same metre overwrites it', near(tr.thr[at(104)], 0.3, 1e-6));
  TR.writeTrail(tr, 104.95 + TR.MAX_FILL_M + 5, 1, 0, 0);
  check('a tow is not bridged: the metres it jumped stay empty', at(120) === -1 && at(Math.floor(104.95 + TR.MAX_FILL_M + 5)) >= 0);
  // The ring is 64 m: metre 100 has been overwritten by metre 164 if written.
  const ring = TR.createTrail(8);
  for (let m = 0; m < 20; m++) TR.writeTrail(ring, m + 0.5, m / 20, 0, 0);
  check('the ring forgets what it has overwritten', TR.trailSlot(ring, 5) === -1 && TR.trailSlot(ring, 15) >= 0);
  TR.resetTrail(ring);
  check('reset empties it', TR.trailSlot(ring, 15) === -1);
}

console.log('\n2) The reference on the metre grid');
{
  const g = TR.resampleRef(line, L);
  check('one bin per metre of lap', g.n === Math.floor(L), g.n);
  check('every metre the trace covers is filled', g.ok.reduce((a, b) => a + b, 0) >= g.n - 2);
  // At a sample's own distance the grid must read that sample.
  const i = 300;
  const m = Math.round(line.d[i] * L);
  const j = line.d.findIndex((d) => d * L >= m);
  const f = (m / L - line.d[j - 1]) / (line.d[j] - line.d[j - 1]);
  const want = line.throttle[j - 1] + (line.throttle[j] - line.throttle[j - 1]) * f;
  check('a metre reads the trace interpolated there', near(g.thr[m], want, 1e-4), `${g.thr[m]} vs ${want}`);
  const frag = TR.resampleRef(Object.assign({}, line, { full: false }), L);
  check('a fragment leaves the metres it does not cover blank', frag.ok[0] === 0 && frag.ok[g.n - 1] === 0 && g.ok[0] === 1 && g.ok[g.n - 1] === 1);
  check('no pedals, no grid (the widget says so instead)', TR.resampleRef({ d: line.d, t: line.t }, L) === null);

  const z = TR.brakeZones(g, line, L);
  const server = brakePoints({ d: line.d, brake: line.brake }, L);
  check('one zone per server braking point', z.on.length === server.length && z.on.length === 6, z.on.length);
  check('…starting where the corner card measures from', Array.from(z.on).every((m2, k) => near(m2, server[k].d * L, 0.01)));
  check('…ending after they start, before the next', Array.from(z.off).every((o, k) => o > z.on[k] && (k + 1 >= z.on.length || o < z.on[k + 1])), Array.from(z.off).map((o, k) => Math.round(o - z.on[k])).join(','));
  const zd = TR.brakeZones(g, Object.assign({}, line, { brakes: undefined }), L);
  check('without the server list, the grid detector finds the same zones', zd.on.length === z.on.length && Array.from(zd.on).every((m2, k) => Math.abs(m2 - z.on[k]) <= 2), Array.from(zd.on).map((m2, k) => (m2 - z.on[k]).toFixed(1)).join(','));
}

console.log('\n3) Through the line');
{
  const u = TR.createUnwrap();
  const seq = [0.97, 0.99, 0.002, 0.01, 0.009, 0.5];
  const out = seq.map((d) => TR.unwrap(u, d));
  check('the line adds a lap, so distance keeps rising', out[2] > out[1] && near(out[2], 1.002, 1e-9));
  check('settling back a little stays a little', near(out[4], 1.009, 1e-9));
  const v = TR.createUnwrap();
  TR.unwrap(v, 0.003);
  check('settling back over the line takes the lap away again', near(TR.unwrap(v, 0.998), -0.002, 1e-9));
  check('lapIndex reads negative metres from the end of the lap', TR.lapIndex(-3, 4083) === 4080 && TR.lapIndex(4085, 4083) === 2);
}

console.log('\n4) Sectors');
{
  const st = LAPS.createSectors();
  check('the reference lines are taken when sane', LAPS.setLines(st, line.sectorD[0], line.sectorD[1]) && st.fromRef);
  check('…and refused when not', !LAPS.setLines(LAPS.createSectors(), 0.6, 0.3));
  const [s1, s2] = st.line;
  // Drive a lap whose gap gains then loses — a smooth curve, as a real gap
  // is at frame spacing — at 120 frames a lap, so the lines fall between
  // frames and have to be interpolated.
  const gapAt = (d) => 0.9 * d * d - 0.3 * d;
  const lastD = 119.5 / 120;
  for (let i = 0; i <= 119; i++) LAPS.stepSectors(st, (i + 0.5) / 120, gapAt((i + 0.5) / 120));
  check('S1 is the gap at the S1 line', near(st.cur[0], gapAt(s1), 1e-4), `${st.cur[0].toFixed(4)} vs ${gapAt(s1).toFixed(4)}`);
  check('S2 is the gap at S2 minus the gap at S1', near(st.cur[1], gapAt(s2) - gapAt(s1), 1e-4), st.cur[1].toFixed(4));
  check('a gaining sector reads as a gain', st.cur[0] < 0 && LAPS.toneOf(st.cur[0]) === 'gain');
  check('S3 is still running before the line', Number.isNaN(st.cur[2]) && st.live === 2 && near(st.liveDelta, gapAt(lastD) - gapAt(s2), 1e-4));
  LAPS.stepSectors(st, 0.002, 0);
  check('at the line S3 closes on the last gap, and the lap rolls', near(st.prev[2], gapAt(lastD) - gapAt(s2), 1e-4) && near(st.prev[0], gapAt(s1), 1e-4) && st.cur.every(Number.isNaN));
  check('the new lap starts in S1', st.live === 0);

  // Inactive ghost at the S2 line: S2 and S3 cannot be scored, S1 still is.
  const blind = LAPS.createSectors();
  LAPS.setLines(blind, s1, s2);
  for (let i = 0; i <= 119; i++) {
    const d = (i + 0.5) / 120;
    LAPS.stepSectors(blind, d, Math.abs(d - s2) < 0.02 ? NaN : gapAt(d));
  }
  check('no gap at a line: that sector is unknown, not zero', near(blind.cur[0], gapAt(s1), 1e-4) && Number.isNaN(blind.cur[1]));

  const ref = LAPS.refSplits(line, s1, s2);
  const sum = ref[0] + ref[1] + ref[2];
  check('the reference splits add up to its lap', near(sum, line.lapSec, 1e-6), ref.map((x) => x.toFixed(3)).join(' + '));
  check('…and match the sim\'s own sector times', near(ref[0], file.s1Ms / 1000, 0.05) && near(ref[1], file.s2Ms / 1000, 0.05), `${ref[0].toFixed(3)} vs ${file.s1Ms / 1000}`);

  // Learning the lines from REST snapshots when the lap carries none.
  const lr = LAPS.createSectors();
  const real = 0.3;
  // Lap 1: snapshots every 0.013 of a lap, phase 0.004 — the line lies between two.
  for (let f = 0.004; f < 0.6; f += 0.013) LAPS.learnLine(lr, f < real ? 1 : 2, f, f + 0.002, 0);
  const err1 = Math.abs(lr.line[0] - real);
  // Lap 2: a different phase narrows the bracket.
  lr.restSector = 0;
  for (let f = 0.0105; f < 0.6; f += 0.013) LAPS.learnLine(lr, f < real ? 1 : 2, f, f + 0.002, 0);
  const err2 = Math.abs(lr.line[0] - real);
  check('a line learned from REST lies inside the snapshot bracket', err1 <= 0.0066, err1.toFixed(4));
  check('…and a second lap narrows it', err2 <= err1 && err2 <= 0.004, err2.toFixed(4));
  check('learning never overrides the reference lines', !LAPS.learnLine(st, 2, 0.5, 0.5, 0) && st.line[0] === s1);
  const late = LAPS.createSectors();
  LAPS.learnLine(late, 1, 0.29, 0.31, 0.07);
  LAPS.learnLine(late, 2, 0.305, 0.315, 0.08);
  check('a line learned just after crossing it still scores this lap', near(late.cur[0], 0.08, 1e-9), late.cur[0]);
}

console.log('\n5) The words');
{
  check('C1..Cn, the reference lap\'s order', LAPS.cornerName(0) === 'C1' && LAPS.cornerName(9) === 'C10');
  check('signed with a real minus', LAPS.fmtSigned(-0.214) === '−0.21' && LAPS.fmtSigned(0.3) === '+0.30' && LAPS.fmtSigned(-0.001) === '0.00' && LAPS.fmtSigned(NaN) === '—');
  check('tones', LAPS.toneOf(-0.1) === 'gain' && LAPS.toneOf(0.1) === 'loss' && LAPS.toneOf(0.01) === 'level' && LAPS.toneOf(null) === 'none');
  check('strength: nothing in the level band, full at FULL_SEC', LAPS.strength(0.02) === 0 && LAPS.strength(LAPS.FULL_SEC) === 1 && LAPS.strength(-0.5) === 1 && LAPS.strength(0.05) > 0.3);
  check('brake phrases', LAPS.brakePhrase(-12.4) === 'braked 12 m early' && LAPS.brakePhrase(8) === 'braked 8 m later' && LAPS.brakePhrase(2) === 'same brake point' && LAPS.brakePhrase(null) === null);
  check('apex phrases, in the driver\'s unit', LAPS.apexPhrase(-6.2) === 'apex −6 km/h' && LAPS.apexPhrase(6.5, 'mph') === 'apex +4 mph' && LAPS.apexPhrase(0.4) === 'apex speed level' && LAPS.apexPhrase(null) === null);
  check('the next line', LAPS.nextPhrase({ index: 5, inside: false, toEntryM: 320, toBrakeM: 140 }) === 'C6 · brake in 140 m' && LAPS.nextPhrase({ index: 5, inside: false, toEntryM: 320 }) === 'C6 · 320 m' && LAPS.nextPhrase({ index: 5, inside: true, toEntryM: 0 }) === 'in C6');
}

console.log('\n6) Hosts');
{
  const reg = (id) => {
    const src = read('overlay', 'js', 'widgets', id + '.js');
    const m = new RegExp('registerWidget\\("' + id + '",[\\s\\S]*?throttleMs:\\s*(\\d+)').exec(src);
    return m ? Number(m[1]) : null;
  };
  check('Trace takes every frame (its loop interpolates them)', reg('traininginputs') === 0);
  check('Corner card and Lap strip are throttled', reg('trainingcorner') > 0 && reg('trainingsectors') > 0);
  const shells = read('overlay', 'js', 'training-shells.js');
  check('a shell for each', ['traininginputs', 'trainingcorner', 'trainingsectors'].every((id) => shells.includes('shells.' + id + ' =')));
  check('the race overlay never loads the training shells, scripts or styles', !/training-|training\.css|widgets\/training/.test(read('overlay', 'ingame.html')));
  check('shells.js itself has no training shells', !/traininginputs|trainingcorner|trainingsectors/.test(read('overlay', 'js', 'shells.js')));
  // widget.html (OBS) loads every training script whichever widget ?w= names.
  // Loaded on a page with no training shell, they must register and nothing
  // else: no fetch, no timer, no paint loop, no listener.
  {
    const vm = require('node:vm');
    const did = [];
    const registered = [];
    const spy = (name) => () => {
      did.push(name);
      return 0;
    };
    const page = {
      fetch: spy('fetch'),
      requestAnimationFrame: spy('requestAnimationFrame'),
      setTimeout: spy('setTimeout'),
      setInterval: spy('setInterval'),
      addEventListener: spy('window.addEventListener'),
      ResizeObserver: function () {
        did.push('ResizeObserver');
        this.observe = () => {};
      },
      getComputedStyle: spy('getComputedStyle'),
      performance: { now: () => 0 },
      console,
      ApexOverlay: { registerWidget: (id) => registered.push(id) },
      ApexRaster: { backingScale: () => 1 },
      document: {
        addEventListener: spy('document.addEventListener'),
        querySelector: () => null,
        documentElement: { getAttribute: () => null },
      },
    };
    page.window = page;
    vm.createContext(page);
    const order = ['ghost-geom.js', 'ghost-pose.js', 'training-trace.js', 'training-laps.js', 'training-ghost.js',
      'widgets/ghosthud.js', 'widgets/traininginputs.js', 'widgets/trainingcorner.js', 'widgets/trainingsectors.js'];
    for (const f of order) vm.runInContext(read('overlay', 'js', ...f.split('/')), page, { filename: f });
    check('loaded without a shell, all four register', ['ghosthud', 'traininginputs', 'trainingcorner', 'trainingsectors'].every((id) => registered.includes(id)), registered.join(','));
    check('…and do nothing else until a widget inits (no fetch, timer, loop or listener)', did.length === 0, did.join(','));
  }
  const trace = read('overlay', 'js', 'widgets', 'traininginputs.js');
  check('Trace reads its theme once, not per paint', (trace.match(/getComputedStyle/g) || []).length === 1);
  check('Trace reports its paint cost to the layer health', trace.includes('noteWork("traininginputs"'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
