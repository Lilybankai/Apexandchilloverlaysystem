/**
 * Regression checks for the pace-delta engine (no test framework in this repo —
 * plain node, run with `npm run test:delta` after a build).
 *
 * Covers the mid-lap-join corruption: joining a session part-way round and
 * crossing the line once produced a "lap" whose duration was the length of that
 * fragment, which beat the real best on time and overwrote the persisted PB.
 */
// Regression check for the mid-lap-join corruption + delta stability.
const { LocalPaceDeltaTracker, RoadPosition } = require(require('path').join(__dirname,'..','dist','telemetry','paceDelta.js'));

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
    /** Sit out `sec` seconds without moving — a garage stop, or a feed dropout
     *  while the broadcast camera was on somebody else. */
    skip(sec) {
      elapsed += sec;
      const l = dist / TRACK;
      return tr.update(Math.min(1, Math.max(0, l - Math.floor(l))), elapsed, restBest, '');
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

/* ---------------------------------------------------------------------------
 * 5) Steadiness under REALISTIC inputs.
 *
 * The harness above drives at a constant speed and hands the tracker a position
 * that is stale by an exactly known amount — conditions under which almost any
 * arithmetic looks smooth. The rig below models what actually reaches the engine
 * on track, which is where the readout's swaying came from:
 *
 *   • a speed profile with braking zones, so a metre of position error is worth
 *     ~60 ms in the slow corners and ~15 ms on the straights;
 *   • a REST feed that publishes on the game's own clock and arrives over HTTP,
 *     so each snapshot is already 5-85 ms old when it lands, by an amount that
 *     varies packet to packet and cannot be extrapolated away;
 *   • a few percent of torn shared-memory reads, which re-serve the previous
 *     sample and so freeze the delta's time axis for a frame.
 *
 * The car then drives a lap IDENTICAL to its own reference, where the correct
 * readout is a flat 0.00 and every departure from it is measurement noise.
 * Before the road-position observer this rig read a −0.07 s bias wandering over
 * a 0.15 s range with 0.08 s frame-to-frame jumps.
 * ------------------------------------------------------------------------- */
console.log('\n5) Readout is steady under realistic REST jitter and torn reads');
{
  const CORNERS = [0.06, 0.18, 0.31, 0.44, 0.58, 0.71, 0.86];
  const SERVER_HZ = 20;      // rate the game refreshes its own REST snapshot
  const POLL_MS = 150;       // our poll interval (REFRESH_INTERVAL_MS)
  const LAT_MIN = 0.005, LAT_MAX = 0.040; // HTTP + serialization latency (s)
  const TORN_SHARE = 0.05;   // frames whose shared-memory read is unusable

  /** Track speed (m/s) at a lap fraction — straights with seven braking zones. */
  const speedAt = (frac) => {
    let v = 74;
    for (const c of CORNERS) {
      let dx = frac - c;
      if (dx > 0.5) dx -= 1; else if (dx < -0.5) dx += 1;
      v -= 48 * Math.exp(-(dx * dx) / (2 * 0.024 * 0.024));
    }
    return Math.max(16, v);
  };
  // Deterministic PRNG: a flaky test is worse than no test.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
  const interp = (tab, d) => {
    if (d <= tab[0].d) return tab[0].t;
    for (let i = 1; i < tab.length; i++) {
      if (tab[i].d >= d) {
        const a = tab[i - 1], b = tab[i];
        return b.d === a.d ? a.t : a.t + (b.t - a.t) * ((d - a.d) / (b.d - a.d));
      }
    }
    return tab[tab.length - 1].t;
  };

  /** Drive 3 laps; the last at `pace`× the reference speed. Returns per-frame
   *  {got, want} — what the engine reported vs the true delta at that instant.
   *  `spectated` models a car this PC is not driving: no shared-memory speed to
   *  integrate (only the REST snapshot's own, already stale, velocity) and no
   *  shared-memory clock to be torn. */
  function drive(pace, spectated) {
    seed = 12345;
    const tr = new LocalPaceDeltaTracker(), rp = new RoadPosition();
    let elapsed = 1000, pos = 0, lapStart = elapsed, lap = 0;
    let lastServerAt = -1, nextPollAt = elapsed;
    let restPos = 0, restVel = 0, lastOkAt = -1e9;
    let heldElapsed = -1, heldSpeed = 0;
    const history = [];
    let truth = [], refTruth = null;
    const rows = [];

    while (lap < 3) {
      const measuring = lap === 2;
      const before = pos;
      const v = speedAt(pos / TRACK) * (measuring ? pace : 1);
      if (lap === 1) truth.push({ d: pos / TRACK, t: elapsed - lapStart });
      elapsed += FRAME;
      pos += v * FRAME;
      let wrapped = false;
      if (pos >= TRACK) {
        // Interpolate the crossing, as the tracker does — taking it at frame
        // time would put a random half-frame into every "true" delta.
        lapStart = elapsed - FRAME * ((pos - TRACK) / (pos - before));
        pos -= TRACK; lap++; wrapped = true;
        if (lap === 2) refTruth = truth;
      }

      // The game republishes its REST snapshot at its own rate...
      if (elapsed - lastServerAt >= 1 / SERVER_HZ) {
        lastServerAt = elapsed;
        history.push({ pos, vel: v, t: elapsed });
        if (history.length > 40) history.shift();
      }
      // ...and our poll receives whichever one was already published LAT ago.
      if (elapsed >= nextPollAt) {
        nextPollAt = elapsed + POLL_MS / 1000;
        const cutoff = elapsed - (LAT_MIN + rnd() * (LAT_MAX - LAT_MIN));
        let pick = null;
        for (const h of history) if (h.t <= cutoff) pick = h;
        if (pick) { restPos = pick.pos; restVel = pick.vel; lastOkAt = elapsed; }
      }
      // A torn shared-memory read re-serves the previous sample: same clock,
      // same speed, one frame late.
      const torn = !spectated && rnd() < TORN_SHARE;
      const clock = torn && heldElapsed > 0 ? heldElapsed : elapsed;
      heldElapsed = clock;

      const age = Math.min(0.5, Math.max(0, elapsed - lastOkAt));
      const restMps = Math.min(150, Math.max(0, restVel));
      const measuredM = restPos + restMps * age;
      const obsM = rp.step(clock, measuredM, spectated ? restMps : torn ? heldSpeed : v, TRACK);
      heldSpeed = v;
      const r = tr.update(Math.min(1, Math.max(0, obsM / TRACK)), clock, 95, '');

      if (measuring && !wrapped && refTruth && r.tSession !== -1) {
        rows.push({ got: r.tSession, want: elapsed - lapStart - interp(refTruth, pos / TRACK) });
      }
    }
    return rows;
  }

  function stats(rows) {
    const v = rows.slice(45); // the delta legitimately re-seeds at the line
    let lo = Infinity, hi = -Infinity, maxStep = 0;
    for (let i = 0; i < v.length; i++) {
      const e = v[i].got - v[i].want;
      lo = Math.min(lo, e); hi = Math.max(hi, e);
      if (i) maxStep = Math.max(maxStep, Math.abs(v[i].got - v[i - 1].got));
    }
    return { p2p: hi - lo, bias: (lo + hi) / 2, maxStep, final: v[v.length - 1] };
  }

  const flat = stats(drive(1));
  check('identical lap: error spread < 0.05s', flat.p2p < 0.05, 'p2p=' + flat.p2p.toFixed(3) + 's');
  check('identical lap: bias < 0.02s', Math.abs(flat.bias) < 0.02, 'bias=' + flat.bias.toFixed(3) + 's');
  check('identical lap: no frame jumps > 0.01s', flat.maxStep < 0.01, 'maxStep=' + flat.maxStep.toFixed(4) + 's');

  const slow = stats(drive(1 / 1.00316)); // ~0.3s slower over the lap
  check('slower lap still steady', slow.p2p < 0.05 && slow.maxStep < 0.01,
    'p2p=' + slow.p2p.toFixed(3) + ' maxStep=' + slow.maxStep.toFixed(4));
  check('slower lap ends at the real loss', Math.abs(slow.final.got - slow.final.want) < 0.05,
    'got=' + slow.final.got.toFixed(3) + ' true=' + slow.final.want.toFixed(3));

  const fast = stats(drive(1 / 0.99474)); // ~0.5s faster over the lap
  check('faster lap ends at the real gain', Math.abs(fast.final.got - fast.final.want) < 0.05,
    'got=' + fast.final.got.toFixed(3) + ' true=' + fast.final.want.toFixed(3));

  /* ---------------------------------------------------------------------------
   * A SPECTATED car — everything above, minus shared memory. No live speed to
   * integrate (only the REST snapshot's own velocity, stale by the same varying
   * latency as its position) and a wall clock rather than the sim's. This is the
   * path that used to read REST `timeIntoLap`, a position-derived estimate that
   * made the delta cancel to 0.00 no matter how the car drove.
   * ------------------------------------------------------------------------- */
  const spec = stats(drive(1, true));
  check('spectated identical lap steady', spec.p2p < 0.05 && spec.maxStep < 0.01,
    'p2p=' + spec.p2p.toFixed(3) + ' maxStep=' + spec.maxStep.toFixed(4));
  const specSlow = stats(drive(1 / 1.00316, true));
  check('spectated lap reports the real loss', Math.abs(specSlow.final.got - specSlow.final.want) < 0.05,
    'got=' + specSlow.final.got.toFixed(3) + ' true=' + specSlow.final.want.toFixed(3));
  // The old tracker's failure mode: a delta that never leaves zero. A 0.3s
  // slower lap has to actually read as time lost.
  check('spectated delta is not stuck at zero', Math.abs(specSlow.final.got) > 0.15,
    'final=' + specSlow.final.got.toFixed(3) + 's');
}

/* ---------------------------------------------------------------------------
 * 6) A car tracked while the camera is elsewhere still arms its reference.
 *
 * `observe()` is what runs for the 20-odd cars nobody is looking at: it must
 * build exactly the same reference lap as `update()` does, or a cut to a rival
 * would show "—" until that car completed another lap on camera.
 * ------------------------------------------------------------------------- */
console.log('\n6) Unwatched cars still build their reference (observe === update)');
{
  const shown = new LocalPaceDeltaTracker();
  const unwatched = new LocalPaceDeltaTracker();
  const NOTHING = { tSession: -1 };
  // Identical inputs, but routed through observe() instead of update().
  const offCamera = { update: (d, e, best, key) => (unwatched.observe(d, e, best, key), NOTHING) };
  const a = car(shown, 95, 0.51);
  const b = car(offCamera, 95, 0.51);
  a.lap(95); a.lap(94.2);
  b.lap(95); b.lap(94.2);
  check('reference adopted while unwatched',
    unwatched.session !== null && shown.session !== null &&
      Math.abs(unwatched.session.lapSec - shown.session.lapSec) < 0.001,
    'watched=' + (shown.session && shown.session.lapSec.toFixed(2)) +
      ' unwatched=' + (unwatched.session && unwatched.session.lapSec.toFixed(2)));
  check('same trace either way',
    !!unwatched.session && !!shown.session &&
      unwatched.session.trace.length === shown.session.trace.length,
    'pts=' + (unwatched.session && unwatched.session.trace.length));
}

/* ---------------------------------------------------------------------------
 * 7) A car that disappears (garage, feed dropout) must not bank the gap as a lap.
 * ------------------------------------------------------------------------- */
console.log('\n7) A long gap re-anchors instead of banking a bogus lap');
{
  const tr = new LocalPaceDeltaTracker();
  const c = car(tr, 95, 0.51);
  c.lap(95); c.lap(95);                       // fragment, then a real reference
  const before = tr.session.lapSec;
  c.skip(600);                                // ten minutes in the garage
  const after = c.lap(95);                    // rejoin and run to the line
  check('reference survives the gap', Math.abs(tr.session.lapSec - before) < 0.01,
    'lapSec=' + tr.session.lapSec.toFixed(2));
  check('gap is not adopted as a lap', tr.session.lapSec < 600 && tr.last.lapSec < 600,
    'last=' + tr.last.lapSec.toFixed(2));
  check('delta recovers after the gap', after.vals.length > 0,
    'samples=' + after.vals.length);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
