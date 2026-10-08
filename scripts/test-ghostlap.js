/**
 * scripts/test-ghostlap.js — Ghost HUD's reference lap: signs, guards, rates.
 * -----------------------------------------------------------------------------
 * Ghost HUD places a gate on a perspective corridor at the chosen lap's
 * position on the road. A flipped sign puts the car you are chasing behind you
 * while you are losing time to it — plausible-looking, and exactly the lie a
 * training aid must never tell. None of that is caught by a typecheck or
 * visible on a screenshot.
 *
 * So each case builds a lap with ONE correct answer. The synthetic reference is
 * a 1000 m circuit lapped in 100 s at a constant 10 m/s, which makes the two
 * answers checkable against each other by hand: 50 m of gap at 10 m/s must read
 * as 5 s, or the metres and the seconds disagree and one of them is wrong.
 *
 * Section 5 answers the question the plan flagged as a risk: stored traces come
 * in at 4-10 Hz, not the 30-60 Hz the recorder's comments claim, and at Le Mans
 * the low end means ~65 m between samples. So the same physical lap is built at
 * both rates and the gaps are required to agree.
 *
 * Run: node scripts/test-ghostlap.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  cleanTrace,
  ghostDistAt,
  ghostFromTrace,
  ghostGap,
  ghostHasLine,
  ghostJson,
  getPublishedGhost,
  setPublishedGhost,
} = require('../dist/telemetry/ghostLap');
const { brakePoints } = require('../dist/telemetry/brakePoints');
const { findCorners } = require('../dist/telemetry/corners');
const { sectorMarks } = require('../dist/telemetry/lapDetail');
const { UNKNOWN_VALUE } = require('../dist/telemetry/types');

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

const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

/** A `TraceFile`-shaped object; only the fields `ghostFromTrace` reads. */
function traceFile(over) {
  const o = Object.assign(
    { lapId: 'lap-1', trackLengthM: 1000, lapMs: 100_000, d: null, t: null, lapSec: 100 },
    over,
  );
  return {
    v: 2,
    lapId: o.lapId,
    at: '2026-10-05T12:00:00.000Z',
    sim: 'lmu',
    trackKey: 'test_1000',
    track: 'Test',
    trackLengthM: o.trackLengthM,
    car: 'Test Car',
    carClass: 'GT3',
    lapMs: o.lapMs,
    trace: {
      lapSec: o.lapSec,
      count: (o.d || []).length,
      truncated: false,
      d: o.d,
      t: o.t,
      ...(o.x ? { x: o.x } : {}),
      ...(o.z ? { z: o.z } : {}),
      ...(o.brake ? { brake: o.brake } : {}),
      ...(o.throttle ? { throttle: o.throttle } : {}),
      ...(o.steer ? { steer: o.steer } : {}),
      ...(o.gear ? { gear: o.gear } : {}),
      ...(o.speedKph ? { speedKph: o.speedKph } : {}),
    },
  };
}

/** Constant-speed lap: 1000 m in 100 s, sampled at `hz`. */
function flatLap(hz = 10, lapSec = 100) {
  const d = [];
  const t = [];
  const n = Math.round(lapSec * hz);
  for (let i = 0; i <= n; i += 1) {
    const tt = (i / n) * lapSec;
    d.push(tt / lapSec);
    t.push(tt);
  }
  return { d, t };
}

/** The 10 m/s reference ghost used by most cases below. */
function flatGhost(hz = 10) {
  const { d, t } = flatLap(hz);
  return ghostFromTrace(traceFile({ d, t }), 'your best · 1:40.000 · dry');
}

console.log('\n1) Sign conventions — the flip that matters');
{
  const g = flatGhost();
  check('a well-formed trace builds a ghost', g !== null);

  // Dead level: at t=50 s the reference was exactly half way round.
  const level = ghostGap(g, 50, 0.5);
  check('level: active', level.active === true);
  check('level: gapSec ~0', near(level.gapSec, 0, 1e-6), level.gapSec);
  check('level: gapM ~0', near(level.gapM, 0, 1e-6), level.gapM);

  // You are 50 m short of where the reference had got to by now.
  const behind = ghostGap(g, 50, 0.45);
  check('behind: gapM is POSITIVE (ghost up the road)', behind.gapM > 0, behind.gapM);
  check('behind: gapM is 50 m', near(behind.gapM, 50, 0.01), behind.gapM);
  check('behind: gapSec is POSITIVE', behind.gapSec > 0, behind.gapSec);
  check('behind: gapSec is 5 s', near(behind.gapSec, 5, 0.01), behind.gapSec);
  check(
    'behind: metres and seconds agree at 10 m/s',
    near(behind.gapM / 10, behind.gapSec, 0.01),
    `${behind.gapM}m / ${behind.gapSec}s`,
  );

  // You are 50 m past it.
  const ahead = ghostGap(g, 50, 0.55);
  check('ahead: gapM is NEGATIVE (ghost behind you)', ahead.gapM < 0, ahead.gapM);
  check('ahead: gapM is −50 m', near(ahead.gapM, -50, 0.01), ahead.gapM);
  check('ahead: gapSec is NEGATIVE', ahead.gapSec < 0, ahead.gapSec);
  check('ahead: gapSec is −5 s', near(ahead.gapSec, -5, 0.01), ahead.gapSec);
}

console.log('\n2) gapSec must equal paceDelta Delta T — the two can never disagree');
{
  // Delta T is `t − t_ref(d)`. A driver running Ghost HUD and the pacedelta
  // widget side by side sees both numbers; if they drift apart one is lying.
  const g = flatGhost();
  const { interpTime } = require('../dist/telemetry/paceDelta');
  for (const [t, d] of [[50, 0.45], [20, 0.25], [90, 0.88]]) {
    const got = ghostGap(g, t, d);
    const deltaT = t - interpTime(g.trace, d);
    check(`t=${t} d=${d}: gapSec === Delta T`, near(got.gapSec, deltaT, 1e-4), `${got.gapSec} vs ${deltaT}`);
  }
}

console.log('\n3) Guards — nothing, out of span, and nonsense');
{
  check('no ghost selected is undefined, not a blank state', ghostGap(null, 50, 0.5) === undefined);

  const g = flatGhost();
  // Past the end of the covered span: a routine state, not a fault.
  const late = ghostGap(g, 200, 0.5);
  check('t beyond the trace: inactive, not absent', late !== undefined && late.active === false);
  check('inactive still names the lap', late.sourceLapId === 'lap-1' && late.sourceLabel.length > 0);
  check('inactive reports UNKNOWN gaps', late.gapSec === UNKNOWN_VALUE && late.gapM === UNKNOWN_VALUE);
  check('inactive still reports the ref lap time', near(late.refLapSec, 100, 1e-6), late.refLapSec);

  check('NaN t is inactive', ghostGap(g, NaN, 0.5).active === false);
  check('NaN d is inactive', ghostGap(g, 50, NaN).active === false);
  check('negative t is inactive', ghostGap(g, -1, 0.5).active === false);
  check('d above 1 is inactive', ghostGap(g, 50, 1.5).active === false);

  // A gap of a whole circuit is a lapping situation the corridor cannot draw,
  // and far more often a trace from somewhere else.
  const wrong = ghostFromTrace(traceFile(Object.assign({ trackLengthM: 1 }, flatLap())), 'x');
  const huge = ghostGap(wrong, 50, 0.0);
  check('a gap of a whole lap is rejected', huge.active === false, huge.gapM);
}

console.log('\n4) cleanTrace — the monotonicity guarantee');
{
  check('fewer than two samples is empty', cleanTrace([0.5], [1]).length === 0);
  check('empty in, empty out', cleanTrace([], []).length === 0);

  const nan = cleanTrace([0, NaN, 0.5, 1], [0, 10, 50, 100]);
  check('NaN distance dropped', nan.length === 3, nan.length);

  const dup = cleanTrace([0, 0.5, 0.5, 1], [0, 50, 51, 100]);
  check('repeated distance dropped', dup.length === 3, dup.length);

  const back = cleanTrace([0, 0.5, 0.4, 1], [0, 50, 60, 100]);
  check('backwards distance dropped', back.length === 3, back.length);

  const rew = cleanTrace([0, 0.5, 0.6, 1], [0, 50, 40, 100]);
  check('backwards time dropped', rew.length === 3, rew.length);

  const oob = cleanTrace([0, 1.4, 0.5, 1], [0, 20, 50, 100]);
  check('distance above 1 dropped', oob.length === 3, oob.length);

  const ok = cleanTrace([0, 0.25, 0.5, 1], [0, 25, 50, 100]);
  check('a clean trace survives intact', ok.length === 4, ok.length);
  check('output is strictly increasing in d', ok.every((s, i) => i === 0 || s.d > ok[i - 1].d));
  check('output never goes back in t', ok.every((s, i) => i === 0 || s.t >= ok[i - 1].t));
}

console.log('\n5) Stored-trace quirks — lapMs 0, fragments, bad length');
{
  const { d, t } = flatLap();

  // A large minority of real traces carry lapMs 0 because the sim published no
  // time for the lap, while the recorder's own measurement is always there.
  const noMs = ghostFromTrace(traceFile({ d, t, lapMs: 0, lapSec: 73.73 }), 'x');
  check('lapMs 0 falls back to the measured lapSec', noMs !== null && near(noMs.lapSec, 73.73, 1e-9), noMs && noMs.lapSec);

  const noSec = ghostFromTrace(traceFile({ d, t, lapMs: 95_000, lapSec: 0 }), 'x');
  check('missing lapSec falls back to lapMs', noSec !== null && near(noSec.lapSec, 95, 1e-9), noSec && noSec.lapSec);

  check('both missing is no ghost', ghostFromTrace(traceFile({ d, t, lapMs: 0, lapSec: 0 }), 'x') === null);
  check('an absurd lap time is no ghost', ghostFromTrace(traceFile({ d, t, lapSec: 99_999 }), 'x') === null);
  check('a zero track length is no ghost', ghostFromTrace(traceFile({ d, t, trackLengthM: 0 }), 'x') === null);
  check('no columns is no ghost', ghostFromTrace(traceFile({ d: null, t: null }), 'x') === null);

  check('a whole lap is marked full', flatGhost().full === true);

  // Half a lap still makes a usable ghost over the half it covers.
  const half = { d: d.slice(0, Math.floor(d.length / 2)), t: t.slice(0, Math.floor(t.length / 2)) };
  const frag = ghostFromTrace(traceFile(half), 'x');
  check('a fragment is not full', frag !== null && frag.full === false);
  check('a fragment still answers inside its span', ghostGap(frag, 20, 0.2).active === true);
  check('a fragment is inactive outside it', ghostGap(frag, 80, 0.8).active === false);
}

console.log('\n6) Sample rate — 4 Hz (Le Mans) must agree with 50 Hz');
{
  // A lap whose speed genuinely varies, so the sampling rate can matter: a
  // constant-speed lap is exactly linear and would pass trivially.
  const T = 100;
  const K = 0.8; // < 1 keeps d monotonic
  const dist = (tt) => tt / T - (K * Math.sin((2 * Math.PI * tt) / T)) / (2 * Math.PI);
  function build(hz) {
    const d = [];
    const t = [];
    const n = Math.round(T * hz);
    for (let i = 0; i <= n; i += 1) {
      const tt = (i / n) * T;
      d.push(dist(tt));
      t.push(tt);
    }
    return ghostFromTrace(traceFile({ d, t, lapSec: T }), 'x');
  }
  const coarse = build(4);
  const fine = build(50);
  check('both rates build a ghost', coarse !== null && fine !== null);

  // The probes MUST fall between samples. At 4 Hz the samples sit on exact
  // quarter-seconds, so sweeping whole seconds lands on them every time and
  // compares two exact reads — which passes at 0.00000 without interpolating
  // anything. The offsets below are deliberately off-grid at both rates.
  let worstSec = 0;
  let worstM = 0;
  let probes = 0;
  for (let tt = 5.1234; tt <= 95; tt += 3.7137) {
    const d = dist(tt - 3.0771); // a little way behind the reference
    const a = ghostGap(coarse, tt, d);
    const b = ghostGap(fine, tt, d);
    if (!a.active || !b.active) {
      check(`t=${tt.toFixed(3)}: both rates active`, false);
      continue;
    }
    probes += 1;
    worstSec = Math.max(worstSec, Math.abs(a.gapSec - b.gapSec));
    worstM = Math.max(worstM, Math.abs(a.gapM - b.gapM));
  }
  check('the sweep actually probed off-grid points', probes > 20 && worstM > 0, `${probes} probes`);
  check('4 Hz agrees with 50 Hz on seconds (<10 ms)', worstSec < 0.01, `${worstSec.toFixed(5)} s`);
  check('4 Hz agrees with 50 Hz on metres (<0.5 m)', worstM < 0.5, `${worstM.toFixed(4)} m`);

  // And the sign still survives at the coarse rate, which is the point.
  const late = ghostGap(coarse, 50.187, dist(47.113));
  check('4 Hz still reads the ghost as ahead', late.active && late.gapM > 0, late.gapM);
}

console.log('\n7) The time origin must NOT be rebased');
{
  // `lapDetail.timeAtDistance` subtracts the trace's own t[0]; this must not.
  // A stored trace's `t` is already measured from the start/finish crossing, so
  // t[0] is when the first sample landed, not an offset to remove — and the
  // live clock it is compared against shares that origin. Rebasing would bias
  // every gap by up to one sample interval: a quarter of a second at Le Mans.
  //
  // This lap's samples start 2 s in, so a rebase would be unmissable.
  const { d, t } = flatLap();
  const from = t.findIndex((v) => v >= 2);
  const late = ghostFromTrace(traceFile({ d: d.slice(from), t: t.slice(from) }), 'x');
  check('a late-starting trace still builds', late !== null, late && late.trace[0].t);
  check('its first sample really is at t=2', near(late.trace[0].t, 2, 1e-9), late.trace[0].t);

  // The reference reached half distance at t=50 either way — dropping early
  // samples changed nothing about that.
  const g = ghostGap(late, 50, 0.5);
  check('level stays level with a late first sample', g.active && near(g.gapSec, 0, 1e-6), g.gapSec);
  check('it did NOT rebase by t[0] (would read 2 s)', Math.abs(g.gapSec) < 0.001, g.gapSec);
}

console.log('');
console.log("8) The driven line, and the column alignment that carries it");
{
  const { d, t } = flatLap();
  // A line that simply counts, so a misalignment shows as an off-by-one rather
  // than as a plausible-looking position.
  const x = d.map((_, i) => i);
  const z = d.map((_, i) => -i);

  const g = ghostFromTrace(traceFile({ d, t, x, z }), 'x');
  check('a v2 trace keeps its line', ghostHasLine(g) === true);
  check('line length matches the cleaned curve', g.x.length === g.trace.length, g.x.length);

  const bare = ghostFromTrace(traceFile({ d, t }), 'x');
  check('a v1 trace has no line', ghostHasLine(bare) === false);
  check('…but is still a usable ghost', bare !== null && bare.trace.length > 2);
  check('a null ghost has no line', ghostHasLine(null) === false);

  // THE case. Corrupt one sample of the distance curve and the line must lose
  // the SAME index — not a different one, and not none. A line one sample out
  // of step is drawn slightly in the wrong place, which is the hardest kind of
  // wrong to notice on screen.
  const bad = d.slice();
  bad[5] = bad[4];                       // duplicate distance: cleanTrace drops it
  const sk = ghostFromTrace(traceFile({ d: bad, t, x, z }), 'x');
  check('the corrupt sample is dropped', sk.trace.length === d.length - 1, sk.trace.length);
  check('the line is dropped in step', sk.x.length === sk.trace.length, sk.x.length);
  check('…and it is index 5 that went', sk.x[4] === 4 && sk.x[5] === 6, sk.x[4] + ',' + sk.x[5]);
  check('z went with it', sk.z[4] === -4 && sk.z[5] === -6, sk.z[4] + ',' + sk.z[5]);

  // A short column cannot be trusted to align, so it is refused outright.
  const short = ghostFromTrace(traceFile({ d, t, x: x.slice(0, 10), z }), 'x');
  check('a truncated line is refused, not padded', ghostHasLine(short) === false);

  const inputs = ghostFromTrace(traceFile({ d, t, x, z, brake: d.map(() => 0.5) }), 'x');
  check('brake rides along when present', inputs.brake.length === inputs.trace.length);
  check('throttle is absent when the trace has none', inputs.throttle === undefined);
}

console.log('');
console.log("9) The slot /ghost.json serves from");
{
  const { d, t } = flatLap();
  const g = ghostFromTrace(traceFile({ d, t, x: d.map(() => 1), z: d.map(() => 2) }), 'x');
  setPublishedGhost(null);
  check('nothing published to begin with', getPublishedGhost() === null);
  setPublishedGhost(g);
  check('publishing makes it readable', getPublishedGhost() === g);
  setPublishedGhost(null);
  check('and it can be withdrawn', getPublishedGhost() === null);
}

console.log('');
console.log('10) Past the line — the ghost wraps instead of vanishing');
{
  // The reference ends its lap at 100 s. A driver 1.5 s down is still short of
  // the line when that runs out, and used to lose the ghost for the last
  // 1.5 s of every lap.
  const g = flatGhost();
  const late = ghostGap(g, 100.5, 0.99);
  check('1.5 s down near the line: still active', late.active === true);
  check('…the ghost is 15 m up the road, over the line', near(late.gapM, 15, 0.01), late.gapM);
  check('…and 1.5 s ahead in time', near(late.gapSec, 1.5, 1e-3), late.gapSec);
  check('the wrapped distance is past 1', near(ghostDistAt(g, 100.5), 1.005, 1e-9), ghostDistAt(g, 100.5));

  // A trace whose last sample lands before the line: the gap between that
  // sample and the lap's own end is the run to the line, not a hole.
  const { d, t } = flatLap();
  const cut = d.findIndex((v) => v >= 0.995);
  const short = ghostFromTrace(traceFile({ d: d.slice(0, cut + 1), t: t.slice(0, cut + 1) }), 'x');
  check('a trace ending 5 m short is still full', short.full === true);
  check('between its last sample and the line, the ghost runs on', near(ghostDistAt(short, 99.8), 0.998, 1e-6), ghostDistAt(short, 99.8));
  check('…and that reads as a live gap', ghostGap(short, 99.8, 0.99).active === true);

  // Seconds and metres still agree across the wrap at the reference's 10 m/s.
  const w = ghostGap(g, 103, 0.985);
  check('wrapped: metres and seconds agree at 10 m/s', w.active && near(w.gapM / 10, w.gapSec, 0.01), `${w.gapM} m / ${w.gapSec} s`);

  // A fragment's end is not the line: carrying it on would invent a car.
  const half = ghostFromTrace(traceFile({ d: d.slice(0, 600), t: t.slice(0, 600) }), 'x');
  check('a fragment does NOT wrap', ghostDistAt(half, 70) === -1 && ghostGap(half, 70, 0.55).active === false);
  // More than a whole lap behind is no gap at all.
  check('a lap and more down: no answer', ghostDistAt(g, 250) === -1);
  check('…and the gap is idle', ghostGap(g, 120, 0.5).active === false);
  // Inside the lap nothing changed.
  check('inside the lap the wrap is plain interpDist', near(ghostDistAt(g, 42), 0.42, 1e-9));
}

console.log('');
console.log("11) atD — the driver's smooth road position rides on the state");
{
  const g = flatGhost();
  const live = ghostGap(g, 50, 0.4512345678);
  check('active states carry atD', live.atD === 0.451235, live.atD);
  const idle = ghostGap(g, 200, 0.5);
  check('idle states carry it too (the road still needs the car)', idle.active === false && idle.atD === 0.5);
  check('an unknown position carries none', !('atD' in ghostGap(g, 50, NaN)));
  check('an out-of-range position carries none', !('atD' in ghostGap(g, 50, 1.2)));
}

console.log('');
console.log('12) The other inputs ride along, filtered in step');
{
  const { d, t } = flatLap();
  const x = d.map((_, i) => i);
  const z = d.map(() => 0);
  const steer = d.map((_, i) => i / 1000);
  const gear = d.map((_, i) => 2 + (i % 5));
  const speedKph = d.map((_, i) => 100 + i);
  const bad = d.slice();
  bad[7] = bad[6]; // dropped by cleanTrace
  const g = ghostFromTrace(traceFile({ d: bad, t, x, z, steer, gear, speedKph }), 'x');
  check('steer, gear and speed are kept', !!(g.steer && g.gear && g.speedKph) && g.steer.length === g.trace.length);
  check('…dropped at the same index as the line', g.speedKph[6] === 106 && g.speedKph[7] === 108 && g.x[7] === 8);
  const bare = ghostFromTrace(traceFile({ d, t }), 'x');
  check('absent when the trace has none', !bare.steer && !bare.gear && !bare.speedKph && !bare.corners && !bare.brakes);
}

console.log('');
console.log('13) Braking points and corners, computed once with the ghost');
{
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'trace-road-atlanta-gt3.json'), 'utf8'));
  const g = ghostFromTrace(f, '1:21.275');
  check('a real lap builds', g !== null && ghostHasLine(g));
  const cd = g.trace.map((s) => s.d);
  const expectBrakes = brakePoints({ d: cd, brake: g.brake, x: g.x, z: g.z }, g.trackLengthM);
  check('brakes are the detector run on the cleaned columns', g.brakes.length === expectBrakes.length && g.brakes.length === 6, g.brakes.length);
  check('…placed on the line', g.brakes.every((b) => Number.isFinite(b.x) && Number.isFinite(b.z)));
  check("…at the detector's distances", g.brakes.every((b, i) => Math.abs(b.d - expectBrakes[i].d) < 1e-6));
  const expectCorners = findCorners({ d: cd, speedKph: g.speedKph, brake: g.brake, throttle: g.throttle, x: g.x, z: g.z }, g.trackLengthM);
  check('corners are the segmentation run on the cleaned columns', g.corners.length === expectCorners.length && g.corners.length === 10, g.corners.length);
  check("the stored file's columns are untouched", f.trace.d.length === f.trace.count);
}

console.log('');
console.log('14) /ghost.json — the contract');
{
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'trace-road-atlanta-gt3.json'), 'utf8'));
  const g = ghostFromTrace(f, '1:21.275');
  const j = ghostJson(g);
  const keys = Object.keys(j).sort().join(',');
  check('the exact key set', keys === 'brake,brakes,corners,d,full,gear,label,lapId,lapSec,sectorD,speedKph,steer,t,throttle,trackLengthM,x,z', keys);
  check('every column is index-aligned with d', ['t', 'x', 'z', 'brake', 'throttle', 'steer', 'gear', 'speedKph'].every((k) => j[k].length === j.d.length));
  check('brakes are {d, x, z}', j.brakes.every((b) => Object.keys(b).sort().join(',') === 'd,x,z'));
  const ck = Object.keys(j.corners[0]).sort().join(',');
  check('corners are {entryD, apexD, exitD, apexX, apexZ, minKph} and nothing else', ck === 'apexD,apexX,apexZ,entryD,exitD,minKph', ck);
  check('corners in order, entry < apex < exit', j.corners.every((c, i) => c.entryD < c.apexD && c.apexD < c.exitD && (i === 0 || c.entryD >= j.corners[i - 1].exitD)));
  // The sector lines must land where the Review tab puts them: the same
  // derivation, run on the cleaned curve rather than the raw columns.
  const marks = sectorMarks(f.trace, f.lapMs, f.s1Ms, f.s2Ms);
  check('sectorD is [S1, S2] where the Review tab draws the lines',
    Array.isArray(j.sectorD) && j.sectorD.length === 2 &&
      Math.abs(j.sectorD[0] - marks.s1) < 1e-3 && Math.abs(j.sectorD[1] - marks.s2) < 1e-3,
    `${j.sectorD} vs ${marks.s1},${marks.s2}`);
  const unsplit = ghostJson(ghostFromTrace(Object.assign({}, f, { s1Ms: undefined, s2Ms: undefined }), 'x'));
  check('a lap with no sector times has no sectorD, not a guess', !('sectorD' in unsplit));
  check('the body survives a JSON round trip unchanged', JSON.stringify(JSON.parse(JSON.stringify(j))) === JSON.stringify(j));
  check('the body is a sensible size', JSON.stringify(j).length < 150_000, `${(JSON.stringify(j).length / 1024).toFixed(1)} KB`);

  const { d, t } = flatLap();
  // A lap with no driven line is still a reference for Trace and the Lap
  // strip: served without x/z, never refused (it used to answer 204).
  const unlined = ghostJson(ghostFromTrace(Object.assign({}, f, { trace: Object.assign({}, f.trace, { x: undefined, z: undefined }) }), 'x'));
  const unlinedKeys = unlined ? Object.keys(unlined).sort().join(',') : '';
  check('no line: a body all the same, without x and z',
    unlinedKeys === 'brake,brakes,corners,d,full,gear,label,lapId,lapSec,sectorD,speedKph,steer,t,throttle,trackLengthM', unlinedKeys);
  check('…its columns still index-aligned with d', unlined && ['t', 'brake', 'throttle', 'steer', 'gear', 'speedKph'].every((k) => unlined[k].length === unlined.d.length));
  check('…and its brakes have no position', unlined && unlined.brakes.length > 0 && unlined.brakes.every((b) => b.x === null && b.z === null));
  const bare = ghostJson(ghostFromTrace(traceFile({ d, t }), 'x'));
  check('a bare d/t lap: just the curve', bare && Object.keys(bare).sort().join(',') === 'd,full,label,lapId,lapSec,t,trackLengthM');
  check('no ghost is no body (the route answers 204)', ghostJson(null) === null);
  const lineOnly = ghostJson(ghostFromTrace(traceFile({ d, t, x: d.map(() => 1), z: d.map(() => 2) }), 'x'));
  check('optional arrays are absent, not empty, when the trace lacks them',
    ['brake', 'throttle', 'steer', 'gear', 'speedKph', 'brakes', 'corners', 'sectorD'].every((k) => !(k in lineOnly)));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
