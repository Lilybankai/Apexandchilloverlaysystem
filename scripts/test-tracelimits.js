/**
 * scripts/test-tracelimits.js — parsing LMU's trace log into real points.
 * -----------------------------------------------------------------------------
 * The reader's job is to turn several MB of the game's own debug output into one
 * number a driver acts on, and every bug in it is silent. A regex that misses
 * `WarnPts` shows a driver 0.00 while the stewards have them at 4.75. A read that
 * lands mid-line drops the one incident that mattered. A pit-lane speeding penalty
 * mistaken for a drive-through zeroes a total that was still owed.
 *
 * So the fixtures here are REAL lines, copied verbatim out of a live trace
 * (Laguna Seca, 2026-07-29) including the ones whose values were independently
 * confirmed against the driver's own HUD: a deep hairpin cut read 1.00 in the game
 * and must read 1.00 here.
 *
 * Run: node scripts/test-tracelimits.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseTraceLine,
  parseTracePenalty,
  parseTraceSession,
  TraceLimitsAccumulator,
  LmuTraceLimitsReader,
} = require('../dist/telemetry/lmuTraceLimits');

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

/* --------------------------- real captured lines --------------------------- */

const OFF_TRACK =
  '18135.60s score.cpp    4205: Track Limits: Off Track WP: 633 TimeIntoLap: 68.03 ' +
  'SpeedDiff: -3.85 LapDistance: 2938.04 WetTrackScalar: 1.00 PredictedTimeWP: 68.07 ' +
  'CurrentTimeDiff: 31.86 PredictedSpeedWP:41.09 PredictedLapTime: 84.92 LeftTrack: 0.22 WallRiding: 0';

const BACK_ON =
  '18137.68s score.cpp    4822: Track Limits: Back On Track; Lap: 1 LapDist: 3029.19';

/** The 1.00-point hairpin cut — value confirmed on the in-game HUD. */
const SCORED_100 =
  '18137.68s score.cpp     626: Track Limits: WarnPts: 1.00 Pts: 0.84 ET: 2.08 PlaceDiff: 0.00 ' +
  'TimeSkipped: 0.33 OnLimit: 0.06 BrakingZone: 0.00  OnLimitGripAverage: 1.19  TimeRatio: 0.21 ' +
  'OffTime: 0.08 OffThrottle: 0.02 SpeedDiffLeave: 0.00 SpeedDiffRejoin: 0.00 DistPts: 0.13 ' +
  'WallPts 0.00 PitPits: 0.00 PtsScaling: 1.00 MaxOffTrack: 12.91 ResetOffTrackDist: 0';

const SCORED_050 =
  '18141.85s score.cpp     626: Track Limits: WarnPts: 0.50 Pts: 0.43 ET: 6.24 PlaceDiff: 0.00 ' +
  'TimeSkipped: -0.52 OnLimit: 0.50 BrakingZone: 0.00  OnLimitGripAverage: 0.16  TimeRatio: 0.21 ' +
  'OffTime: 0.08 OffThrottle: 0.02 SpeedDiffLeave: 0.00 SpeedDiffRejoin: 0.00 DistPts: 0.13 ' +
  'WallPts 0.00 PitPits: 0.00 PtsScaling: 1.00 MaxOffTrack: 12.91 ResetOffTrackDist: 0';

/** Charged nothing: the driver LOST time going off. */
const SCORED_ZERO =
  '18116.92s score.cpp     626: Track Limits: WarnPts: 0.00 Pts: -1.01 ET: 2.60 PlaceDiff: 0.00 ' +
  'TimeSkipped: -1.11 OnLimit: 0.02 BrakingZone: 0.00  OnLimitGripAverage: 0.00  TimeRatio: 0.00 ' +
  'OffTime: 0.06 OffThrottle: 0.03 SpeedDiffLeave: 0.00 SpeedDiffRejoin: 0.00 DistPts: -0.00 ' +
  'WallPts 0.00 PitPits: 0.00 PtsScaling: 1.00 MaxOffTrack: 1.38 ResetOffTrackDist: 0';

const WARNING = '18141.85s score.cpp    4083: Track Limits: Warning; Lap: 1 LapDist: 3183.09';
const NO_CUT = '18116.92s score.cpp    4117: Track Limits: No Track Cut; Lap: 1 LapDist: 2416.38';
const OFF_AGAIN = '1322.89s score.cpp    4473: Track Limits: Off Track Again; Lap: 8 LapDist: 2555.91';
const PIT_ENTRY = '4001.10s score.cpp    4152: Track Limits: Valid Pit Entry ';

/** Names ANOTHER driver — pass monitoring, nothing to do with our car. */
const OTHER_DRIVER =
  '2487.75s score.cpp     547: Track Limits: Ignored passed on Timur Boguslavskiy due to in speed too low';

/**
 * The wording the sim ACTUALLY uses when accumulated cuts earn their penalty.
 * Captured live at the two moments the driver was given a drive-through.
 */
const PEN_TRACK_LIMITS =
  '16382.48s score.cpp    1365: Local penalty et=16382.48 0 10 0 0 "Track Limits"';

const PEN_PITLANE =
  '2487.75s score.cpp    1365: Local penalty et=4807.4 0 10 0 0 "Speeding In Pitlane"';
const PEN_DRIVE_THROUGH =
  '5100.00s score.cpp    1365: Local penalty et=5000.0 0 10 0 0 "Drive Through Penalty"';
const PEN_STOP_GO = '5200.00s score.cpp    1365: Local penalty et=5100.0 0 10 0 0 "Stop/Go Penalty"';

/** A session beginning — practice, qualifying, race, or a race restart. */
const SESSION_START = '16868.68s steward.cpp  9371: SessionName="Race"';

/*
 * The SAME lines as the game writes them in a FRESH session.
 *
 * The timestamp sits in a right-aligned fixed-width column, so while the game has
 * been running for less than about 2.7 hours the seconds are 3-4 digits and the
 * line arrives with LEADING SPACES. Every other fixture in this file was copied
 * from a five-hour-old session where the field was full — which is how a reader
 * that only worked after 2.7 hours of uptime passed 59 assertions and then
 * recorded nothing at all in a freshly launched race.
 */
const PADDED_WARNING = '  373.36s score.cpp    4083: Track Limits: Warning; Lap: 1 LapDist: 668.62';
const PADDED_SCORED =
  '  373.36s score.cpp     626: Track Limits: WarnPts: 0.50 Pts: 0.29 ET: 3.21 ' +
  'TimeSkipped: 0.11 DistPts: 0.02 PtsScaling: 1.00 MaxOffTrack: 2.60 ResetOffTrackDist: 0';
const PADDED_SESSION = '  160.42s steward.cpp  9371: SessionName="Race"';
const PADDED_PENALTY =
  '  451.40s score.cpp    1365: Local penalty et=451.4 0 10 0 0 "Track Limits"';

const NOISE = '18137.68s gr_dx11.cpp  921: Invalid offset"';

/* ------------------------------- the parser ------------------------------- */

console.log('\nparsing');

const off = parseTraceLine(OFF_TRACK);
check('an Off Track line parses', off !== null);
check('…with its verdict', off && off.verdict === 'off-track', off && off.verdict);
check('…and LapDistance, not LapDist', off && off.lapDistM === 2938.04, off && off.lapDistM);
check('…and the game clock', off && off.atGameSec === 18135.6, off && off.atGameSec);

const scored = parseTraceLine(SCORED_100);
check('the breakdown line yields the charge', scored && scored.warnPts === 1, scored && scored.warnPts);
check('…the raw pre-quantisation score', scored && scored.rawPts === 0.84, scored && scored.rawPts);
check('…time gained, the actual input', scored && scored.timeSkippedSec === 0.33, scored && scored.timeSkippedSec);
check('…and how far off it went', scored && scored.maxOffTrackM === 12.91, scored && scored.maxOffTrackM);

const backOn = parseTraceLine(BACK_ON);
check('Back On Track gives lap + distance', backOn && backOn.lap === 1 && backOn.lapDistM === 3029.19,
  backOn && `${backOn.lap} @ ${backOn.lapDistM}`);

check('a negative raw score parses as negative',
  parseTraceLine(SCORED_ZERO).rawPts === -1.01, parseTraceLine(SCORED_ZERO).rawPts);
check('Warning is a verdict', parseTraceLine(WARNING).verdict === 'warning');
check('No Track Cut is a verdict', parseTraceLine(NO_CUT).verdict === 'no-track-cut');
check('Off Track Again is distinct from Off Track',
  parseTraceLine(OFF_AGAIN).verdict === 'off-track-again', parseTraceLine(OFF_AGAIN).verdict);
check('Valid Pit Entry is a verdict', parseTraceLine(PIT_ENTRY).verdict === 'valid-pit-entry');

check('a line about another driver is refused', parseTraceLine(OTHER_DRIVER) === null);
check('unrelated trace output is refused', parseTraceLine(NOISE) === null);
check('an empty line is refused', parseTraceLine('') === null);
check('a truncated line is refused, not thrown',
  parseTraceLine('18137.68s score.cpp     626: Track Li') === null);

check('a penalty line names the penalty',
  parseTracePenalty(PEN_PITLANE).name === 'Speeding In Pitlane',
  parseTracePenalty(PEN_PITLANE).name);
check('a track-limits line is not a penalty line', parseTracePenalty(BACK_ON) === null);

// The log is CRLF. In JavaScript `\r` is a line terminator, so `.` does not match
// it and a trailing carriage return defeats the `$` anchor — every real line parsed
// as null until this was handled. Found by replaying an actual trace file, which no
// amount of hand-typed fixtures would have caught.
check('a CRLF-terminated line still parses',
  parseTraceLine(`${SCORED_100}\r`) !== null);
check('…with the charge intact',
  parseTraceLine(`${SCORED_100}\r`).warnPts === 1,
  parseTraceLine(`${SCORED_100}\r`).warnPts);
check('…and a CRLF penalty line too',
  parseTracePenalty(`${PEN_TRACK_LIMITS}\r`).name === 'Track Limits');

/* ----------------------------- accumulation ------------------------------ */

console.log('\naccumulating');

let acc = new TraceLimitsAccumulator();
check('nothing charged to begin with', acc.state().points === 0, acc.state().points);

acc.push(WARNING);
acc.push(SCORED_050);
check('a settled Warning is charged', acc.state().points === 0.5, acc.state().points);
check('…counted as one incident', acc.state().charged === 1, acc.state().charged);
check('…and carries its verdict', acc.state().lastIncident.verdict === 'warning',
  acc.state().lastIncident.verdict);
check('…with the lap distance from that verdict line',
  acc.state().lastIncident.lapDistM === 3183.09, acc.state().lastIncident.lapDistM);

// The provisional evaluation the sim makes the instant the car rejoins. It is not a
// charge: for one race the provisional figures ran to 3.75 while the settled verdict
// charged 0.25, and none of them appear in the session-end XML.
acc.push(OFF_TRACK);
acc.push(BACK_ON);
acc.push(SCORED_100);
check('a provisional Back On Track evaluation is NOT charged',
  acc.state().points === 0.5, acc.state().points);
check('…and does not count as an incident', acc.state().charged === 1, acc.state().charged);

acc.push(WARNING);
acc.push(SCORED_100);
check('charges add up', acc.state().points === 1.5, acc.state().points);

acc.push(NO_CUT);
acc.push(SCORED_ZERO);
check('a No Track Cut verdict charges nothing', acc.state().points === 1.5, acc.state().points);
check('…and is not counted as an incident', acc.state().charged === 2, acc.state().charged);

// Quarter-points in binary floating point: 0.25 + 0.5 must not become 0.7500000000000001.
acc = new TraceLimitsAccumulator();
for (let i = 0; i < 3; i++) {
  acc.push(WARNING);
  acc.push(SCORED_050);
}
check('repeated quarter-points stay exact', acc.state().points === 1.5, acc.state().points);

// "Ruled on, charged nothing" is still a ruling, and it is what tells the widget
// nothing is outstanding — the sim's log reaches us up to ~25s late, so the count of
// rulings is how a caller knows whether the total on screen is behind.
acc = new TraceLimitsAccumulator();
check('nothing ruled on yet', acc.state().settled === 0, acc.state().settled);
acc.push(OFF_TRACK);
acc.push(BACK_ON);
acc.push(SCORED_100);
check('a provisional evaluation is not a ruling', acc.state().settled === 0,
  acc.state().settled);
acc.push(NO_CUT);
check('No Track Cut counts as ruled on', acc.state().settled === 1, acc.state().settled);
acc.push(WARNING);
check('…and so does a Warning', acc.state().settled === 2, acc.state().settled);
acc.push(SESSION_START);
check('a new session clears the rulings', acc.state().settled === 0, acc.state().settled);

console.log('\ndischarge');

acc = new TraceLimitsAccumulator();
acc.push(WARNING);
acc.push(SCORED_100);
acc.push(PEN_PITLANE);
check('a pit-lane speeding penalty does NOT clear track-limit points',
  acc.state().points === 1, acc.state().points);

acc.push(PEN_TRACK_LIMITS);
check('the sim’s own "Track Limits" penalty clears them', acc.state().points === 0,
  acc.state().points);

// Each of these charges FIRST, so "cleared" means something. Pushing a provisional
// pair here would leave the total at zero and the assertion would pass on a reader
// whose discharge was completely broken.
acc.push(WARNING);
acc.push(SCORED_100);
check('charged again before the next discharge', acc.state().points === 1, acc.state().points);
acc.push(PEN_DRIVE_THROUGH);
check('a drive-through clears them', acc.state().points === 0, acc.state().points);
check('…and the incident count with it', acc.state().charged === 0, acc.state().charged);
check('…while still reporting what the penalty was',
  acc.state().lastPenalty.name === 'Drive Through Penalty', acc.state().lastPenalty.name);

acc.push(WARNING);
acc.push(SCORED_100);
check('charged again', acc.state().points === 1, acc.state().points);
acc.push(PEN_STOP_GO);
check('a stop/go clears them too', acc.state().points === 0, acc.state().points);

acc.push(WARNING);
acc.push(SCORED_100);
check('charged once more', acc.state().points === 1, acc.state().points);
acc.reset();
check('a session change clears everything', acc.state().points === 0, acc.state().points);
check('…including the last incident', acc.state().lastIncident === null);

// The sim's own session marker. Without it the reader carries practice's cuts into
// qualifying: replaying one evening's trace reached 39 points against an allowance
// of 5, because only a penalty was resetting the total.
acc = new TraceLimitsAccumulator();
acc.push(WARNING);
acc.push(SCORED_100);
check('points accumulate within a session', acc.state().points === 1, acc.state().points);
acc.push(SESSION_START);
check('a SessionName line resets the total', acc.state().points === 0, acc.state().points);
check('…and names the session it belongs to', acc.state().session === 'Race', acc.state().session);

console.log('\nordering');

// A breakdown with no verdict before it cannot be attributed to a settled Warning,
// so it is not charged — being unhelpful beats inventing points a driver never got.
acc = new TraceLimitsAccumulator();
acc.push(SCORED_100);
check('an orphan breakdown line is not charged', acc.state().points === 0, acc.state().points);
check('…and no incident is recorded', acc.state().lastIncident === null);

// The verdict and its breakdown can straddle a read boundary; the pairing has to
// survive being fed in two separate batches.
acc = new TraceLimitsAccumulator();
acc.push(WARNING);
acc.push(SCORED_050);
check('a verdict/breakdown pair split across reads still charges',
  acc.state().points === 0.5, acc.state().points);

// One verdict must not charge twice, however many breakdown lines follow it.
acc = new TraceLimitsAccumulator();
acc.push(WARNING);
acc.push(SCORED_050);
acc.push(SCORED_100);
check('a second breakdown after one verdict is not charged again',
  acc.state().points === 0.5, acc.state().points);

// A verdict line with no breakdown must not be charged as an incident.
acc = new TraceLimitsAccumulator();
acc.push(WARNING);
check('a verdict with no breakdown charges nothing', acc.state().points === 0, acc.state().points);
check('…and is not an incident', acc.state().charged === 0, acc.state().charged);

/* ---------------------- a freshly launched session ------------------------- */

// The reader recorded nothing for the first ~2.7 hours of every session, because the
// game right-aligns its timestamp column and every fixture above came from a
// long-running session where the column was full. Reported from a live race.
console.log('\na freshly launched session (padded timestamps)');

check('a padded verdict line parses', parseTraceLine(PADDED_WARNING) !== null);
check('…with its verdict', parseTraceLine(PADDED_WARNING)?.verdict === 'warning',
  parseTraceLine(PADDED_WARNING)?.verdict);
check('a padded breakdown line parses', parseTraceLine(PADDED_SCORED)?.warnPts === 0.5,
  parseTraceLine(PADDED_SCORED)?.warnPts);
check('a padded session line parses', parseTraceSession(PADDED_SESSION)?.session === 'Race',
  parseTraceSession(PADDED_SESSION)?.session);
check('a padded penalty line parses', parseTracePenalty(PADDED_PENALTY)?.name === 'Track Limits',
  parseTracePenalty(PADDED_PENALTY)?.name);

acc = new TraceLimitsAccumulator();
acc.push(PADDED_SESSION);
acc.push(PADDED_WARNING);
acc.push(PADDED_SCORED);
check('a fresh session accumulates', acc.state().points === 0.5, acc.state().points);
check('…and knows its session', acc.state().session === 'Race', acc.state().session);
acc.push(PADDED_PENALTY);
check('…and discharges', acc.state().points === 0, acc.state().points);

/* ------------------------- recovering a session ---------------------------- */

// Restarting the overlay four cuts into a race must not show the driver 0 while the
// stewards have them at 4.75. The reader starts at the END of the trace so old
// sessions are not replayed, which made a mid-session restart lose the total
// entirely — reported from a live race. It now replays from the last SessionName.
console.log('\nrecovering the total after a restart');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-trace-'));
const traceFile = path.join(tmp, 'trace_2026_07_29_17_57_29-62.txt');

function writeTrace(lines) {
  // CRLF, as the game writes it.
  fs.writeFileSync(traceFile, lines.join('\r\n') + '\r\n', 'latin1');
}

function readerState() {
  const prev = process.env.APEX_LMU_LOG_DIR;
  process.env.APEX_LMU_LOG_DIR = tmp;
  const r = new LmuTraceLimitsReader(false);
  r.start();
  const s = r.state();
  r.stop();
  if (prev === undefined) delete process.env.APEX_LMU_LOG_DIR;
  else process.env.APEX_LMU_LOG_DIR = prev;
  return s;
}

// An earlier session's cuts, then this session's — only the latter may count.
writeTrace([
  '100.00s steward.cpp  9371: SessionName="Practice"',
  WARNING,
  SCORED_100,
  WARNING,
  SCORED_100,
  '16868.68s steward.cpp  9371: SessionName="Race"',
  WARNING,
  SCORED_050,
  WARNING,
  SCORED_100,
]);
let st = readerState();
check('a mid-session restart recovers the running total', st && st.points === 1.5,
  st && st.points);
check('…counting only the current session', st && st.charged === 2, st && st.charged);
check('…and naming it', st && st.session === 'Race', st && st.session);

// No marker in the file at all: nothing can be attributed, so nothing is claimed.
writeTrace([WARNING, SCORED_100, WARNING, SCORED_050]);
st = readerState();
check('with no session marker, nothing is replayed', st && st.points === 0, st && st.points);

// The game keeps a plain `trace.txt` beside the dated files: an exit-time copy of the
// session that just finished, byte-identical and with the same mtime. Picked by mtime
// alone that tie can win, leaving the reader tailing a static copy of a dead session.
writeTrace([
  '16868.68s steward.cpp  9371: SessionName="Race"',
  WARNING,
  SCORED_050,
]);
fs.writeFileSync(
  path.join(tmp, 'trace.txt'),
  ['100.00s steward.cpp  9371: SessionName="Practice"', WARNING, SCORED_100, WARNING, SCORED_100].join('\r\n'),
  'latin1',
);
st = readerState();
check('a plain trace.txt is not mistaken for the live log', st && st.points === 0.5,
  st && st.points);
check('…so the dead session’s total is not shown', st && st.charged === 1, st && st.charged);

// A discharge inside the session must survive the replay.
writeTrace([
  '16868.68s steward.cpp  9371: SessionName="Race"',
  WARNING,
  SCORED_100,
  PEN_TRACK_LIMITS,
  WARNING,
  SCORED_050,
]);
st = readerState();
check('a discharge during the session is replayed too', st && st.points === 0.5, st && st.points);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 1 && 0 : 1);
