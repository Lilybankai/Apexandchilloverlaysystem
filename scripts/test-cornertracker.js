/**
 * scripts/test-cornertracker.js — the live corner-by-corner score, tick by tick.
 * -----------------------------------------------------------------------------
 * `cornerTracker.ts` keeps a few numbers per corner instead of the whole live
 * lap, and that economy is only worth having if it gives the SAME answer as
 * `corners.ts`'s `cornerResult` run on the whole lap afterwards. So every
 * planted difference here is scored both ways and compared:
 *
 *   §1 a real lap (Road Atlanta, GT3) replayed against itself scores zero;
 *   §2 time lost at one apex, braking later everywhere, and less apex speed
 *      read the same as `cornerResult` on the same columns;
 *   §3 the lap boundary: the previous lap's strip, a fresh strip, `seq`;
 *   §4 what the driver sees approaching a corner (index, metres, brake point);
 *   §5 the states that must NOT invent a number: an inactive ghost, a tow, a
 *      mid-lap start, a lap with no corners, frames already sent.
 *
 * Run: npm run test:cornertracker
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CornerTracker } = require('../dist/telemetry/cornerTracker');
const { cornerResult } = require('../dist/telemetry/corners');
const { ghostFromTrace } = require('../dist/telemetry/ghostLap');
const { interpTime } = require('../dist/telemetry/paceDelta');

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

const file = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'trace-road-atlanta-gt3.json'), 'utf8'),
);
const ghost = ghostFromTrace(file, '1:21.275');
const L = ghost.trackLengthM;
const corners = ghost.corners;
const n = corners.length;

/** The ghost's own cleaned columns — the reference `cornerResult` is given. */
const ref = {
  d: ghost.trace.map((s) => s.d),
  t: ghost.trace.map((s) => s.t),
  brake: ghost.brake,
  speedKph: ghost.speedKph,
};

/** A live lap: the reference's columns with some of them replaced. */
function liveLap(over) {
  return Object.assign({ d: ref.d, t: ref.t, brake: ref.brake, speedKph: ref.speedKph }, over);
}

/**
 * Drive `tracker` through `live`, one tick per sample, with the gap worked
 * out exactly as `ghostGap` does (`t − t_ref(d)` on the cleaned curve).
 * Returns the state after the last tick.
 */
function drive(tracker, live, opts) {
  const o = opts || {};
  let st;
  for (let i = 0; i < live.d.length; i++) {
    const d = live.d[i];
    const gap = o.inactive && o.inactive(d) ? NaN : live.t[i] - interpTime(ghost.trace, d);
    st = tracker.update(ghost, d, gap, live.brake[i], live.speedKph[i]);
    if (o.each) o.each(st, d, i);
  }
  return st;
}

/** Close a lap by driving the first sample of the next. */
function crossLine(tracker) {
  return tracker.update(ghost, 0.0005, 0, 0, 200);
}

/** Every corner's verdict as it was scored, keyed by index. */
function verdicts(tracker, live, opts) {
  const out = new Array(n).fill(null);
  let seen = 0;
  drive(tracker, live, Object.assign({}, opts, {
    each(st) {
      if (st && st.last && st.last.seq !== seen) {
        seen = st.last.seq;
        out[st.last.index] = st.last;
      }
    },
  }));
  return out;
}

const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;

console.log('\n1) A lap against itself');
{
  check('the fixture lap has corners to score', n === 10, n);
  const v = verdicts(new CornerTracker(), liveLap({}));
  check('every corner is scored on the lap', v.every((x) => x !== null));
  check('zero time everywhere', v.every((x) => x.deltaSec === 0), v.map((x) => x.deltaSec).join(','));
  check('zero braking difference where it braked', v.every((x) => x.brakeDeltaM === null || x.brakeDeltaM === 0) && v.some((x) => x.brakeDeltaM === 0));
  check('zero apex speed difference', v.every((x) => x.apexKphDelta === 0));
  const self = corners.map((c) => cornerResult(c, ref, ref, L));
  check('braked corners are the ones cornerResult says braked', v.every((x, k) => (x.brakeDeltaM === null) === (self[k].brakeDeltaM === null)));
}

console.log('\n2) Planted differences read as cornerResult reads them');
{
  // 0.3 s lost at C7's apex.
  const k = 6;
  const c = corners[k];
  const apexI = ref.d.findIndex((d) => d > c.apexD);
  const slow = liveLap({ t: ref.t.map((t, i) => (i >= apexI ? t + 0.3 : t)) });
  const v = verdicts(new CornerTracker(), slow);
  const want = corners.map((cc) => cornerResult(cc, ref, slow, L).deltaSec);
  check('0.3 s lost through C7 reads +0.3 s', near(v[k].deltaSec, 0.3, 1e-3), v[k].deltaSec);
  check('every corner agrees with cornerResult to the millisecond', v.every((x, i) => near(x.deltaSec, want[i], 1e-3)), v.map((x) => x.deltaSec).join(','));
  check('the corners before are untouched', v.slice(0, k).every((x) => x.deltaSec === 0));

  // Brake two samples later everywhere.
  const late = liveLap({ brake: ref.brake.map((_, i) => (i >= 2 ? ref.brake[i - 2] : 0)) });
  const lv = verdicts(new CornerTracker(), late);
  const lw = corners.map((cc) => cornerResult(cc, ref, late, L).brakeDeltaM);
  const braked = lv.filter((x) => x.brakeDeltaM !== null);
  check('braking later reads POSITIVE metres', braked.length >= 5 && braked.every((x) => x.brakeDeltaM > 5 && x.brakeDeltaM < 20), braked.map((x) => x.brakeDeltaM).join(','));
  check('…the same metres cornerResult reads', lv.every((x, i) => (x.brakeDeltaM === null && lw[i] === null) || near(x.brakeDeltaM, lw[i], 0.11)), lw.join(','));

  // Brake earlier: one sample before the reference's onset into C1.
  const early = liveLap({ brake: ref.brake.map((b, i) => (i + 2 < ref.brake.length ? Math.max(b, ref.brake[i + 2]) : b)) });
  const ev = verdicts(new CornerTracker(), early);
  const firstBraked = ev.find((x) => x.brakeDeltaM !== null);
  check('braking earlier reads NEGATIVE metres', firstBraked && firstBraked.brakeDeltaM < -5, firstBraked && firstBraked.brakeDeltaM);

  // 5% less speed through C7 only.
  const slower = liveLap({
    speedKph: ref.speedKph.map((s, i) => (ref.d[i] >= c.entryD && ref.d[i] <= c.exitD ? s * 0.95 : s)),
  });
  const sv = verdicts(new CornerTracker(), slower);
  const sw = cornerResult(c, ref, slower, L).apexKphDelta;
  check('less apex speed reads NEGATIVE', sv[k].apexKphDelta < 0, sv[k].apexKphDelta);
  check('…by what cornerResult reads', near(sv[k].apexKphDelta, sw, 0.11), `${sv[k].apexKphDelta} vs ${sw}`);
  check('…and only there', sv.every((x, i) => i === k || x.apexKphDelta === 0));

  // A 30 Hz feed between the samples, not on them: still within a hundredth.
  const tr = new CornerTracker();
  let seen = 0;
  const hv = new Array(n).fill(null);
  for (let i = 1; i < slow.d.length; i++) {
    for (let s = 0; s < 3; s++) {
      const f = s / 3;
      const d = slow.d[i - 1] + (slow.d[i] - slow.d[i - 1]) * f;
      const t = slow.t[i - 1] + (slow.t[i] - slow.t[i - 1]) * f;
      const st = tr.update(ghost, d, t - interpTime(ghost.trace, d), slow.brake[i - 1], slow.speedKph[i - 1]);
      if (st && st.last && st.last.seq !== seen) {
        seen = st.last.seq;
        hv[st.last.index] = st.last;
      }
    }
  }
  check('ticks between samples: C7 still reads +0.3 s', hv[k] && near(hv[k].deltaSec, 0.3, 0.01), hv[k] && hv[k].deltaSec);
}

console.log('\n3) The lap boundary');
{
  const tr = new CornerTracker();
  const k = 6;
  const apexI = ref.d.findIndex((d) => d > corners[k].apexD);
  const slow = liveLap({ t: ref.t.map((t, i) => (i >= apexI ? t + 0.3 : t)) });
  const end = drive(tr, slow);
  check('mid-lap: the strip fills as corners are driven', end.lapCorners.filter((x) => x !== null).length === n);
  check('…and there is no previous lap yet', end.prevLapCorners.length === n && end.prevLapCorners.every((x) => x === null));
  const lastSeq = end.last.seq;
  const after = crossLine(tr);
  check('over the line: the finished lap becomes the previous strip', after.prevLapCorners === end.lapCorners);
  check('…C7 still reads +0.3 s on it', near(after.prevLapCorners[k], 0.3, 1e-3));
  check('…and the new strip is empty', after.lapCorners.length === n && after.lapCorners.every((x) => x === null));
  check('…the last verdict stands until the next corner', after.last.seq === lastSeq);
  const lap2 = drive(tr, liveLap({}));
  check('a second lap scores afresh, and seq keeps counting', lap2.last.seq === lastSeq + n && lap2.lapCorners.every((x) => x === 0));
}

console.log('\n4) Approaching a corner');
{
  const tr = new CornerTracker();
  const k = 0;
  const c = corners[k];
  const refBrake = ghost.brakes.find((b) => b.d >= c.entryD - 100 / L && b.d <= c.apexD);
  const at = (refBrake ? refBrake.d : c.entryD) - 150 / L;
  const st = tr.update(ghost, at, 0, 0, 200);
  check('the next corner is C1', st.index === k && st.inside === false);
  check('metres to its entry', Math.abs(st.toEntryM - (c.entryD - at) * L) <= 1, st.toEntryM);
  check('metres to the reference brake point', refBrake && Math.abs(st.toBrakeM - 150) <= 1, st.toBrakeM);
  const inside = tr.update(ghost, c.apexD, 0, 0.5, 120);
  check('inside the corner: index stays, inside, no countdown', inside.index === k && inside.inside && inside.toEntryM === 0 && inside.toBrakeM === undefined);
  const lastC = corners[n - 1];
  const tail = new CornerTracker();
  tail.update(ghost, lastC.exitD - 0.002, 0, 0, 200);
  const past = tail.update(ghost, lastC.exitD + 0.002, 0, 0, 200);
  check('after the last corner, the next is C1 of the next lap', past.index === 0 && past.toEntryM > 0 && Math.abs(past.toEntryM - (1 - (lastC.exitD + 0.002) + corners[0].entryD) * L) <= 1, past.toEntryM);
}

console.log('\n5) Nothing invented');
{
  const c = corners[3];
  const v = verdicts(new CornerTracker(), liveLap({}), { inactive: (d) => d > c.entryD - 0.01 && d < c.exitD + 0.01 });
  check('ghost inactive through a corner: no time for it', v[3].deltaSec === null);
  check('…its neighbours are still scored', v[2].deltaSec === 0 && v[4].deltaSec === 0);
  check('…braking and apex speed need no gap, so they still read', v[3].apexKphDelta === 0);

  // A tow: from before C3 straight to after C5.
  const tow = new CornerTracker();
  tow.update(ghost, corners[2].entryD - 0.01, 0, 0, 200);
  const st = tow.update(ghost, corners[4].exitD + 0.01, 0, 0, 200);
  check('a tow scores nothing it jumped over', st.lapCorners.every((x) => x === null) && st.last === undefined);
  check('…and the next corner is the one after it', st.index === 5);

  // Joining mid-corner.
  const mid = new CornerTracker();
  let first = null;
  let seen = 0;
  drive(mid, liveLap({ d: ref.d.filter((d) => d >= corners[1].apexD), t: ref.t.filter((_, i) => ref.d[i] >= corners[1].apexD), brake: ref.brake.filter((_, i) => ref.d[i] >= corners[1].apexD), speedKph: ref.speedKph.filter((_, i) => ref.d[i] >= corners[1].apexD) }), {
    each(s) {
      if (s && s.last && s.last.seq !== seen) {
        seen = s.last.seq;
        if (!first) first = s.last;
      }
    },
  });
  check('joining mid-corner: that corner has no time', first && first.index === 1 && first.deltaSec === null);

  const bare = Object.assign({}, ghost, { corners: [] });
  check('a lap with no corners: no corner block', new CornerTracker().update(bare, 0.5, 0, 0, 200) === undefined);
  check('no position: no corner block', new CornerTracker().update(ghost, NaN, 0, 0, 200) === undefined);

  // Frames already handed on keep what they said.
  const tr = new CornerTracker();
  let held = null;
  drive(tr, liveLap({}), {
    each(s) {
      if (!held && s && s.last) held = s;
    },
  });
  check('a sent frame’s strip is never edited afterwards', held.lapCorners.filter((x) => x !== null).length === 1);

  // A new ghost lap: everything starts again.
  const other = ghostFromTrace(file, 'again');
  const re = tr.update(other, 0.5, 0, 0, 200);
  check('a different ghost lap starts a clean sheet', re.last === undefined && re.prevLapCorners.every((x) => x === null));
  tr.reset();
  const after = tr.update(other, 0.5, 0, 0, 200);
  check('after reset, the next tick scores nothing it did not see', after.last === undefined);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
