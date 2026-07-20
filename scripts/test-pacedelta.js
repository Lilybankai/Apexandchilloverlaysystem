/**
 * Regression checks for the pace-delta engine (no test framework in this repo —
 * plain node, run with `npm run test:delta` after a build).
 *
 * Covers the mid-lap-join corruption: joining a session part-way round and
 * crossing the line once produced a "lap" whose duration was the length of that
 * fragment, which beat the real best on time and overwrote the persisted PB.
 */
// Regression check for the mid-lap-join corruption + delta stability.
const { LocalPaceDeltaTracker } = require(require('path').join(__dirname,'..','dist','telemetry','paceDelta.js'));

const TRACK = 4655, REST_MS = 190, FRAME = 1 / 30;
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/**
 * A continuous car. The sim clock never jumps — a discontinuity is exactly what
 * the tracker's sanity limits are meant to reject, so a harness that jumps the
 * clock between phases tests nothing real.
 */
function car(tr, restBest, startFrac) {
  let elapsed = 1000, dist = (startFrac || 0) * TRACK;
  let restDist = dist, restAt = -1e9, restVel = 0;
  return {
    /** Drive one lap in `lapSec`; returns every tSession seen during it. */
    lap(lapSec) {
      const speed = TRACK / lapSec;
      const remain = lapSec * (1 - (dist / TRACK - Math.floor(dist / TRACK)));
      const vals = [];
      let frames = 0;
      for (let k = 0; k < Math.round(remain / FRAME); k++) {
        elapsed += FRAME; dist += speed * FRAME;
        const nowMs = elapsed * 1000;
        let fresh = false;
        if (nowMs - restAt >= REST_MS) { restAt = nowMs; restDist = dist; restVel = speed; fresh = true; }
        const age = Math.min(0.5, (nowMs - restAt) / 1000);
        const l = (restDist + restVel * age) / TRACK;
        const d = Math.min(1, Math.max(0, l - Math.floor(l)));
        const r = tr.update(d, elapsed, restBest, '', fresh);
        frames++;
        if (r.tSession !== -1) vals.push(r.tSession);
      }
      return { vals, frames };
    },
  };
}
function drive(tr, laps, startFrac, restBest) {
  const c = car(tr, restBest, startFrac);
  let out = null;
  for (const l of laps) out = c.lap(l);
  return out;
}

console.log('\n1) Mid-lap join must NOT create a reference from the fragment');
{
  const tr = new LocalPaceDeltaTracker();
  drive(tr, [95], 0.51, 103.9);              // join at 51%, cross the line once
  check('no session ref from a half lap', tr.session === null, 'session=' + (tr.session && tr.session.lapSec.toFixed(2)));
  check('no allTime ref from a half lap', tr.allTime === null, 'allTime=' + (tr.allTime && tr.allTime.lapSec.toFixed(2)));
  check('no last ref from a half lap', tr.last === null);
}

console.log('\n2) A genuine full lap after the join IS adopted');
{
  const tr = new LocalPaceDeltaTracker();
  drive(tr, [95, 95], 0.51, 103.9);          // fragment, then one real lap
  check('session ref adopted', tr.session !== null && Math.abs(tr.session.lapSec - 95) < 0.5,
    'lapSec=' + (tr.session && tr.session.lapSec.toFixed(2)));
  check('trace covers the lap', !!tr.session && tr.session.trace[0].d <= 0.05 &&
    tr.session.trace[tr.session.trace.length - 1].d >= 0.9,
    tr.session && tr.session.trace[0].d.toFixed(3) + '..' + tr.session.trace[tr.session.trace.length-1].d.toFixed(3));
}

console.log('\n3) A real full lap cannot be displaced by an impossibly fast one');
{
  const tr = new LocalPaceDeltaTracker();
  const c = car(tr, 95, 0.51);
  c.lap(95); c.lap(95);
  const before = tr.allTime.lapSec;
  c.lap(40);                                 // 40s "lap" — a teleport/track reset
  check('fast fragment rejected', Math.abs(tr.allTime.lapSec - before) < 0.01,
    'allTime=' + tr.allTime.lapSec.toFixed(2));
}

console.log('\n4) Delta is known and stable on the lap after a reference exists');
{
  const tr = new LocalPaceDeltaTracker();
  const c = car(tr, 95, 0.51);
  c.lap(95); c.lap(95);                      // fragment, then the reference lap
  const { vals, frames } = c.lap(95.3);      // now a lap 0.30s slower
  const known = vals.length / frames;
  check('delta known for >95% of the lap', known > 0.95, (known * 100).toFixed(0) + '%');
  let maxStep = 0;
  for (let i = 1; i < vals.length; i++) maxStep = Math.max(maxStep, Math.abs(vals[i] - vals[i - 1]));
  check('max frame-to-frame step < 0.01s', maxStep < 0.01, maxStep.toFixed(4) + 's');
  const final = vals[vals.length - 1];
  check('final delta ~ +0.30s', final !== undefined && Math.abs(final - 0.30) < 0.06,
    final === undefined ? 'none' : final.toFixed(3) + 's');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
