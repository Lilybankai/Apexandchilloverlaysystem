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
  DEFAULT_POINTS_LIMIT,
  INSTANT_PENALTY_POINTS,
  MAX_INFRINGEMENT_POINTS,
  DEFAULT_OFF_TRACK_MARGIN_M,
  HALF_CAR_WIDTH_M,
  RECOVERY_MARGIN_M,
  MIN_EXCURSION_MS,
  MIN_SPEED_KPH,
  AT_RISK_WINDOW_MS,
  LIFT_THROTTLE,
  POINT_STEP_M,
  setTrackLimitsMargin,
  trackLimitsMargin,
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
      throttle: 1,
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
const WIDE = EDGE + DEFAULT_OFF_TRACK_MARGIN_M + 1.5;
/** Only just past the threshold — the cheapest infringement, worth one point. */
const JUST_WIDE = EDGE + DEFAULT_OFF_TRACK_MARGIN_M + 0.2;
/** Comfortably inside it. */
const ONTRACK = 1.0;

console.log('\n1) One excursion is one warning');

{
  const r = rig();
  r.hold(ONTRACK, 500);
  check('a clean lap counts nothing', r.state.warnings === 0, r.state.warnings);
  check('…and is not flagged off-track', r.state.offTrack === false);

  r.hold(WIDE, 1600);
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
  const justInside = EDGE + DEFAULT_OFF_TRACK_MARGIN_M - 0.2; // inside the trigger, inside the band
  r.hold(WIDE, 700);
  r.hold(justInside, 400);
  r.hold(WIDE, 700);
  r.hold(justInside, 400);
  r.hold(WIDE, 700);
  check('dithering on the threshold counts once', r.state.warnings === 1, r.state.warnings);
}

{
  // …but genuinely gathering it up and going wide again IS two mistakes.
  const r = rig();
  r.hold(WIDE, 1600);
  r.hold(ONTRACK, 600); // well inside the recovery band
  r.hold(WIDE, 1600);
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
  r.hold(EDGE + DEFAULT_OFF_TRACK_MARGIN_M - 0.2, 1500);
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
      throttle: 1,
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
    throttle: 1,
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
    throttle: 1,
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
  r.hold(WIDE, 1600);
  r.hold(ONTRACK, 400);
  check('warnings accumulate within a session', r.state.warnings === 1, r.state.warnings);
  r.hold(ONTRACK, 100, { sessionKey: 'the-race' });
  check('a new session wipes them', r.state.warnings === 0, r.state.warnings);
}

console.log('\n6) Points — the unit LMU actually judges limits in');

{
  const r = rig();
  r.hold(ONTRACK, 100);
  check('the points limit defaults to the constant', r.state.pointsLimit === DEFAULT_POINTS_LIMIT, r.state.pointsLimit);
  check('a clean session has scored nothing', r.state.points === 0, r.state.points);

  // A wheel over the line is not the same offence as a lap through the run-off,
  // so the score has to move with how far off the road it got.
  // JUST past the threshold, not a step past it — WIDE is exactly one
  // POINT_STEP_M out and correctly scores two.
  r.hold(JUST_WIDE, 1600);
  r.hold(ONTRACK, 600);
  const light = r.state.points;
  check('a modest cut scores one point', light === 1, light);

  const r2 = rig();
  r2.hold(EDGE + DEFAULT_OFF_TRACK_MARGIN_M + 2 * POINT_STEP_M + 0.2, 1600);
  r2.hold(ONTRACK, 600);
  check('a much deeper cut scores more', r2.state.points > light, r2.state.points);
  check(
    '…and is capped where the sim stops caring',
    r2.state.points <= MAX_INFRINGEMENT_POINTS,
    `${r2.state.points} <= ${MAX_INFRINGEMENT_POINTS}`,
  );
  check(
    'the cap is the instant-drive-through figure',
    MAX_INFRINGEMENT_POINTS === INSTANT_PENALTY_POINTS,
    MAX_INFRINGEMENT_POINTS,
  );
  check('the last infringement reports its own worth', r2.state.lastInfringementPoints === r2.state.points, r2.state.lastInfringementPoints);
}

{
  // The limit is a league setting, not a law — LMU configures it per session.
  const r = rig();
  r.hold(ONTRACK, 100, { pointsLimit: 4 });
  check('a session limit overrides the default', r.state.pointsLimit === 4, r.state.pointsLimit);
  r.hold(ONTRACK, 100, { pointsLimit: 0 });
  check('a nonsense limit falls back', r.state.pointsLimit === DEFAULT_POINTS_LIMIT, r.state.pointsLimit);
}

{
  // Points accumulate past the limit rather than clamping: a driver already
  // penalised still needs to know they are digging further in.
  const r = rig();
  for (let i = 0; i < 4; i++) {
    r.hold(JUST_WIDE, 1600);
    r.hold(ONTRACK, 600);
  }
  check('points accumulate across infringements', r.state.points === 4, r.state.points);
  check('…and so does the infringement count', r.state.warnings === 4, r.state.warnings);
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
    RECOVERY_MARGIN_M > 0 && RECOVERY_MARGIN_M < DEFAULT_OFF_TRACK_MARGIN_M,
    `${RECOVERY_MARGIN_M} < ${DEFAULT_OFF_TRACK_MARGIN_M}`,
  );
}

console.log('\n7) The threshold, and why it is not half a car\'s width');

{
  // The regression this section exists for: `mTrackEdge` marks the AIW's
  // drivable surface, which sits at or inside the white line — so the KERB is
  // already past it. At a half-car-width margin, riding a kerb the way every
  // driver rides a kerb counted as running wide.
  const onTheKerb = EDGE + HALF_CAR_WIDTH_M + 0.3; // outer wheels on the kerb
  const r = rig();
  r.hold(onTheKerb, 2000);
  check('riding a kerb does NOT count at the default', r.state.warnings === 0, r.state.warnings);

  check(
    'the default clears a kerb rather than just the car',
    DEFAULT_OFF_TRACK_MARGIN_M > HALF_CAR_WIDTH_M + 1.0,
    `${DEFAULT_OFF_TRACK_MARGIN_M} m vs ${HALF_CAR_WIDTH_M} m half-car`,
  );

  // …and genuinely off, past the kerb, still counts.
  const r2 = rig();
  r2.hold(EDGE + DEFAULT_OFF_TRACK_MARGIN_M + 0.5, 1600);
  check('being properly off still counts', r2.state.warnings === 1, r2.state.warnings);
}

{
  // The operator's threshold is per-poll, so it retunes a RUNNING session.
  const r = rig();
  const onTheKerb = EDGE + HALF_CAR_WIDTH_M + 0.3;
  r.hold(onTheKerb, 1600);
  check('kerb ignored at the default margin', r.state.warnings === 0, r.state.warnings);
  // Turn the threshold down to the old strict value mid-session…
  r.hold(onTheKerb, 1600, { marginM: HALF_CAR_WIDTH_M });
  check('…and the same position now counts', r.state.warnings === 1, r.state.warnings);
}

{
  // The global setter is what the control panel drives; it must clamp, and it
  // must be readable back so the server can report what is in force.
  const before = trackLimitsMargin();
  check('the live margin defaults to the constant', before === DEFAULT_OFF_TRACK_MARGIN_M, before);
  check('an absurdly small margin is clamped up', setTrackLimitsMargin(0.01) === 0.5);
  check('an absurdly large one is clamped down', setTrackLimitsMargin(999) === 5);
  check('null restores the default', setTrackLimitsMargin(null) === DEFAULT_OFF_TRACK_MARGIN_M);
  check('a sane value is taken verbatim', setTrackLimitsMargin(1.8) === 1.8);

  // …and the tracker actually follows it, with no per-poll input.
  const r = rig();
  r.hold(EDGE + 2.0, 1600); // past 1.8, inside the 2.4 default
  check('the tracker follows the live margin', r.state.warnings === 1, r.state.warnings);
  setTrackLimitsMargin(null); // leave global state as we found it
}

console.log('\n8) The at-risk window, and giving the time back');

{
  // LMU raises a Race Control notice the moment you are at risk and gives you
  // "a brief opportunity to slow down whilst the violation is calculated".
  // Nothing may score before that window has run.
  const r = rig();
  r.step(WIDE);
  check('going off puts the driver AT RISK immediately', r.state.atRisk === true);
  check('…and nothing has scored yet', r.state.points === 0, r.state.points);

  r.hold(WIDE, AT_RISK_WINDOW_MS - 200);
  check('still at risk inside the window', r.state.atRisk === true);
  check('…still nothing scored', r.state.points === 0, r.state.points);

  r.hold(WIDE, 400);
  check('past the window it scores', r.state.points > 0, r.state.points);
  check('…and is no longer at risk', r.state.atRisk === false);
}

{
  // Lift, and it costs nothing. This is the whole mechanic.
  const r = rig();
  r.hold(WIDE, 300);
  r.hold(WIDE, 1600, { throttle: 0 });
  r.hold(ONTRACK, 400);
  check('lifting inside the window scores nothing', r.state.points === 0, r.state.points);
  check('…and counts as an infringement given back', r.state.negated === 1, r.state.negated);
  check('…leaving the scored count at zero', r.state.warnings === 0, r.state.warnings);
  check('…and stamping a time-since', r.state.msSinceNegated >= 0, r.state.msSinceNegated);
}

{
  // Staying on the throttle costs the points.
  const r = rig();
  r.hold(WIDE, 1900, { throttle: 1 });
  r.hold(ONTRACK, 400);
  check('staying on the throttle scores', r.state.points > 0, r.state.points);
  check('…and nothing was given back', r.state.negated === 0, r.state.negated);
}

{
  // A feathered throttle IS a lift — the rule asks you to slow, not to brake.
  const r = rig();
  r.hold(WIDE, 1900, { throttle: LIFT_THROTTLE });
  r.hold(ONTRACK, 400);
  check('a feathered throttle counts as lifting', r.state.negated === 1, r.state.negated);
}

{
  // Lifting for a moment is enough; the driver need not stay off it all window.
  const r = rig();
  r.hold(WIDE, 200, { throttle: 1 });
  r.hold(WIDE, 200, { throttle: 0 });      // a brief lift…
  r.hold(WIDE, 1500, { throttle: 1 });     // …then back on it
  r.hold(ONTRACK, 400);
  check('a brief lift inside the window still saves it', r.state.negated === 1, r.state.negated);
}

{
  // liftedInTime is what lets the widget flip from "LIFT" to "saved" while the
  // car is still off the road — it must only be true while the verdict is open.
  const r = rig();
  r.hold(WIDE, 300, { throttle: 1 });
  check('not flagged as lifted while still on the throttle', r.state.liftedInTime === false);
  r.hold(WIDE, 200, { throttle: 0 });
  check('flagged the moment the driver lifts', r.state.liftedInTime === true);
  check('…while still at risk', r.state.atRisk === true);
  r.hold(WIDE, 1600, { throttle: 0 });
  check('and cleared once the verdict is in', r.state.liftedInTime === false);
}

{
  // No throttle channel (spectating): score everything rather than quietly
  // forgiving infringements that did cost the driver points in the sim.
  const r = rig();
  r.hold(WIDE, 1900, { throttle: null });
  r.hold(ONTRACK, 400);
  check('with no throttle channel it still scores', r.state.points > 0, r.state.points);
  check('…and nothing is credited as given back', r.state.negated === 0, r.state.negated);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
