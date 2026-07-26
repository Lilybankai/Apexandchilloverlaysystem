/**
 * scripts/test-tracklimits.js — the track-limits counter's edges and guards.
 * -----------------------------------------------------------------------------
 * The counter turns a continuous lateral-position channel into DISCRETE
 * excursions, and every interesting bug lives in that conversion: one wide
 * moment counted five times because the channel dithered across the threshold,
 * a kerb strike counted as a run-off, the pit lane's own geometry racking up
 * warnings on a car doing nothing wrong. None of those show in a typecheck, and
 * none of them are visible on a screenshot of a clean lap.
 *
 * So each case drives the real tracker through a physical situation with one
 * correct answer — run wide once, hover on the limit, come back and go again —
 * and asserts the count. Run: node scripts/test-tracklimits.js
 */

'use strict';

const {
  TrackLimitsTracker,
  WARNING_LIMIT,
  OFF_TRACK_MARGIN_M,
  RECOVERY_MARGIN_M,
  MIN_EXCURSION_MS,
  MIN_SPEED_KPH,
} = require('../dist/telemetry/trackLimits');

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

/** Half-width of the demo track, metres — a typical `mTrackEdge`. */
const EDGE = 7;

/**
 * A little harness that walks a tracker forward in 50 ms steps, which is about
 * the rate a 30 Hz feed delivers and comfortably finer than MIN_EXCURSION_MS.
 */
function rig(over) {
  const t = new TrackLimitsTracker();
  let now = 1000;
  let last = null;
  const step = (lateral, opts) => {
    now += (opts && opts.dtMs) || 50;
    last = t.update({
      pathLateralM: lateral,
      trackEdgeM: EDGE,
      speedKph: 180,
      inPit: false,
      penalties: 0,
      sessionKey: 'test',
      nowMs: now,
      ...over,
      ...opts,
    });
    return last;
  };
  /** Hold a lateral offset for `ms` milliseconds. */
  const hold = (lateral, ms, opts) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) step(lateral, opts);
    return last;
  };
  return { step, hold, get state() { return last; } };
}

/** Comfortably beyond the edge — clear of the half-a-car margin. */
const WIDE = EDGE + OFF_TRACK_MARGIN_M + 1.5;
/** Comfortably inside it. */
const ONTRACK = 1.0;

console.log('\n1) One excursion is one warning');

{
  const r = rig();
  r.hold(ONTRACK, 500);
  check('a clean lap counts nothing', r.state.warnings === 0, r.state.warnings);
  check('…and is not flagged off-track', r.state.offTrack === false);

  r.hold(WIDE, 1000);
  check('running wide counts exactly one', r.state.warnings === 1, r.state.warnings);
  check('…and reports offTrack while out there', r.state.offTrack === true);

  r.hold(ONTRACK, 500);
  check('coming back does not count again', r.state.warnings === 1, r.state.warnings);
  check('…and clears offTrack', r.state.offTrack === false);
}

{
  // The bug this exists to prevent: a long excursion is still ONE mistake, not
  // one per frame it lasts.
  const r = rig();
  r.hold(WIDE, 4000);
  check('a four-second excursion is still one warning', r.state.warnings === 1, r.state.warnings);
}

console.log('\n2) Hysteresis — a car balanced on the limit');

{
  // Straddling the threshold: out, barely back, out again, with the "back"
  // never clearing the recovery band. That is one wide moment, not three.
  const r = rig();
  const justInside = EDGE + OFF_TRACK_MARGIN_M - 0.2; // inside the trigger, inside the band
  r.hold(WIDE, 300);
  r.hold(justInside, 300);
  r.hold(WIDE, 300);
  r.hold(justInside, 300);
  r.hold(WIDE, 300);
  check('dithering on the threshold counts once', r.state.warnings === 1, r.state.warnings);
}

{
  // …but genuinely gathering it up and going wide again IS two mistakes.
  const r = rig();
  r.hold(WIDE, 400);
  r.hold(ONTRACK, 400); // well inside the recovery band
  r.hold(WIDE, 400);
  check('recovering fully and going again counts twice', r.state.warnings === 2, r.state.warnings);
}

console.log('\n3) The guards');

{
  // A single sample past the line is as likely to be a kerb strike as a run-off.
  const r = rig();
  r.step(WIDE); // one 50 ms sample, under MIN_EXCURSION_MS
  r.hold(ONTRACK, 400);
  check(
    `a ${MIN_EXCURSION_MS > 50 ? 'sub-threshold' : 'single-sample'} flick counts nothing`,
    r.state.warnings === 0,
    r.state.warnings,
  );
}

{
  const r = rig();
  r.hold(WIDE, 2000, { inPit: true });
  check('the pit lane never counts', r.state.warnings === 0, r.state.warnings);
}

{
  const r = rig();
  r.hold(WIDE, 2000, { speedKph: MIN_SPEED_KPH - 10 });
  check('a car below walking-out pace never counts', r.state.warnings === 0, r.state.warnings);
}

{
  // Half a car's width of margin: a centre exactly on the edge still has two
  // wheels on the road, which is not a breach anywhere in motorsport.
  const r = rig();
  r.hold(EDGE + OFF_TRACK_MARGIN_M - 0.2, 1500);
  check('a centre on the edge is not all four wheels off', r.state.warnings === 0, r.state.warnings);
}

{
  // The two channels carry the same sign, so the test is on magnitudes — going
  // wide to the LEFT must count exactly like going wide to the right.
  const r = new TrackLimitsTracker();
  let now = 1000;
  let out = null;
  for (let i = 0; i < 30; i++) {
    now += 50;
    out = r.update({
      pathLateralM: -WIDE,
      trackEdgeM: -EDGE, // same sign as the position, as the sim publishes it
      speedKph: 180,
      inPit: false,
      penalties: 0,
      sessionKey: 'test',
      nowMs: now,
    });
  }
  check('running wide to the LEFT counts too', out.warnings === 1, out.warnings);
}

console.log('\n4) The sim\'s own penalties, kept separate from our warnings');

{
  const r = rig();
  r.hold(ONTRACK, 200);
  check('no penalty reported when the sim says zero', r.state.penalties === 0, r.state.penalties);
  check('…and no time-since-penalty', r.state.msSincePenalty === -1, r.state.msSincePenalty);

  r.hold(ONTRACK, 200, { penalties: 1 });
  check('a penalty from the sim is passed straight through', r.state.penalties === 1);
  check('…and stamps a time-since', r.state.msSincePenalty >= 0, r.state.msSincePenalty);
}

{
  // The penalty channel alone is worth a block: the stewards' verdict stands on
  // its own even where the lateral channels are unreadable.
  const t = new TrackLimitsTracker();
  const out = t.update({
    pathLateralM: null,
    trackEdgeM: null,
    speedKph: 180,
    inPit: false,
    penalties: 2,
    sessionKey: 'test',
    nowMs: 1000,
  });
  check('penalties alone still produce a state', out !== null && out.penalties === 2);
  check('…with the distance-to-edge ABSENT, not sentinelled', out.beyondEdgeM === undefined, out.beyondEdgeM);
}

{
  // Neither channel: the block must be ABSENT, not a confident clean sheet.
  const t = new TrackLimitsTracker();
  const out = t.update({
    pathLateralM: null,
    trackEdgeM: null,
    speedKph: 180,
    inPit: false,
    penalties: -1,
    sessionKey: 'test',
    nowMs: 1000,
  });
  check('no channels at all returns null', out === null);
}

console.log('\n5) Sessions');

{
  const r = rig();
  r.hold(WIDE, 500);
  r.hold(ONTRACK, 200);
  check('warnings accumulate within a session', r.state.warnings === 1, r.state.warnings);
  r.hold(ONTRACK, 100, { sessionKey: 'the-race' });
  check('a new session wipes them', r.state.warnings === 0, r.state.warnings);
}

console.log('\n6) The display scale');

{
  const r = rig();
  r.hold(ONTRACK, 100);
  check(`warningLimit is the classic ${WARNING_LIMIT}`, r.state.warningLimit === WARNING_LIMIT);

  // Past the scale the count keeps rising — it is a display scale, not a cap,
  // and a driver on their fifth needs to be told it is five.
  for (let i = 0; i < WARNING_LIMIT + 2; i++) {
    r.hold(WIDE, 400);
    r.hold(ONTRACK, 400);
  }
  check(
    'the count runs past the scale rather than clamping',
    r.state.warnings === WARNING_LIMIT + 2,
    r.state.warnings,
  );
}

{
  // beyondEdgeM is what lets the widget show a car running OUT of road before it
  // runs out, so its sign has to be right on both sides of the line.
  const r = rig();
  r.hold(ONTRACK, 100);
  check('inside the track, beyondEdgeM is negative', r.state.beyondEdgeM < 0, r.state.beyondEdgeM);
  r.hold(WIDE, 400);
  check('outside it, beyondEdgeM is positive', r.state.beyondEdgeM > 0, r.state.beyondEdgeM);
  check(
    'the recovery band is inside the trigger',
    RECOVERY_MARGIN_M > 0 && RECOVERY_MARGIN_M < OFF_TRACK_MARGIN_M,
    `${RECOVERY_MARGIN_M} < ${OFF_TRACK_MARGIN_M}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
