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

const { cleanTrace, ghostFromTrace, ghostGap } = require('../dist/telemetry/ghostLap');
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
    trace: { lapSec: o.lapSec, count: (o.d || []).length, truncated: false, d: o.d, t: o.t },
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
