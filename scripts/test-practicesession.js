/**
 * Tests for electron/practiceSession.js — when a practice session has ended,
 * for the Practice Review (docs/PRACTICE-REVIEW-PLAN.md).
 *
 *   node scripts/test-practicesession.js
 */
'use strict';

const { createPracticeWatch, END_HOLD_MS } = require('../electron/practiceSession');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  }
}

/** A frame: session type, last lap, optional ghost; `demo` makes it a simulator frame. */
function frame(type, last, o = {}) {
  return {
    connected: o.demo ? false : true,
    session: { type, track: o.track || 'Road Atlanta' },
    player: { lap: { last }, ...(o.ghost ? { ghost: { sourceLapId: o.ghost, sourceLabel: 'A. Winters · 1:19.299 · board', refLapSec: 79.3 } } : {}) },
    standings: [{ isPlayer: true, carClass: 'GT3', vehicle: 'Porsche 911 GT3 R' }],
  };
}

/** Drive `laps` lap times through a watch, one per 80 s, starting at t. */
function drive(w, t, laps, type = 'practice', o = {}) {
  w.update(frame(type, -1, o), t); // baseline: no lap yet
  for (const sec of laps) {
    t += 80000;
    w.update(frame(type, sec, o), t);
  }
  return t;
}

console.log('\npractice session: start, laps, end');
{
  const w = createPracticeWatch();
  let t = drive(w, 1000, [82.1, 80.4, 81.0]);
  check('a running session has not ended', w._ended.length === 0);
  check('three timed laps counted', w.current().laps === 3, w.current().laps);
  w.update(frame('race', -1), t + 1000);
  check('a race after practice ends it at once', w._ended.length === 1);
  const e = w._ended[0] || {};
  check('…with the laps, the best and the track', e.laps === 3 && e.bestLapSec === 80.4 && e.track === 'Road Atlanta', JSON.stringify(e));
  check('…and the car and class from the player row', e.carClass === 'GT3' && e.car === 'Porsche 911 GT3 R');
  check('…and ISO start and end times', /^\d{4}-\d\d-\d\dT/.test(e.startedAt) && e.endedAt > e.startedAt);
  for (let k = 0; k < 5; k++) w.update(frame('race', 90), t + 2000 + k * 1000);
  check('one end per session, however long the race runs', w._ended.length === 1);
}

console.log('\npractice session: gaps');
{
  const w = createPracticeWatch();
  let t = drive(w, 0, [80.0, 79.5]);
  // A loading screen: no frame, then unknown, for under the hold.
  w.update(null, t + 5000);
  w.update(frame('unknown', 79.5), t + 9000);
  w.update(null, t + END_HOLD_MS - 1000);
  check('a gap shorter than the hold does not end it', w._ended.length === 0);
  // Back into practice: the same session carries on.
  w.update(frame('practice', 79.5), t + END_HOLD_MS - 500);
  w.update(frame('practice', 78.9), t + END_HOLD_MS + 60000);
  check('…and the session carries on across it', w.current() && w.current().laps === 3, w.current() && w.current().laps);
  t = t + END_HOLD_MS + 60000;
  w.update(null, t + 1000);
  w.update(null, t + END_HOLD_MS - 1);
  check('silence just under the hold: still running', w._ended.length === 0);
  w.update(null, t + END_HOLD_MS);
  check('silence for the hold ends it', w._ended.length === 1);
  check('…ended at the last practice frame, not when the hold ran out', w._ended[0].endedAt === new Date(t).toISOString(), w._ended[0].endedAt);
  check('a demo frame during the gap is still a gap', (() => {
    const v = createPracticeWatch();
    const u = drive(v, 0, [80]);
    v.update(frame('race', 80, { demo: true }), u + 1000);
    const early = v._ended.length;
    v.update(frame('race', 80, { demo: true }), u + END_HOLD_MS + 1);
    return early === 0 && v._ended.length === 1;
  })());
}

console.log('\npractice session: what is not reviewed');
{
  const w = createPracticeWatch();
  w.update(frame('practice', -1), 0);
  w.update(frame('practice', -1), 30000);
  w.update(frame('race', -1), 31000);
  check('a session with no timed lap ends silently', w._ended.length === 0);
  check('…and is not being watched any more', w.current() === null);

  const d = createPracticeWatch();
  drive(d, 0, [80, 79], 'practice', { demo: true });
  check('demo frames never start a session', d.current() === null);
  d.update(null, END_HOLD_MS * 3);
  check('…so they never end one either', d._ended.length === 0);

  const b = createPracticeWatch();
  b.update(frame('practice', 81.2), 0); // joined with a lap already on the board
  b.update(frame('practice', 81.2), 1000);
  b.update(frame('race', 81.2), 2000);
  check('a lap time already showing on joining is not this session’s lap', b._ended.length === 0);

  const q = createPracticeWatch();
  drive(q, 0, [80], 'qualifying');
  check('qualifying is not practice', q.current() === null);
  const td = createPracticeWatch();
  const tt = drive(td, 0, [80], 'testday');
  td.update(frame('race', -1), tt + 1);
  check('a test day is reviewed like practice', td._ended.length === 1 && td._ended[0].sessionType === 'testday');
}

console.log('\npractice session: back to back');
{
  const w = createPracticeWatch();
  let t = drive(w, 0, [80, 79]);
  w.update(frame('race', 85), t + 1000);
  t = drive(w, t + 600000, [78.8]);
  w.update(null, t + END_HOLD_MS + 1);
  check('returning to practice starts a new session with its own end', w._ended.length === 2);
  check('…counting only its own laps', w._ended[1] && w._ended[1].laps === 1, w._ended[1] && w._ended[1].laps);
}

console.log('\npractice session: the lap being chased');
{
  const seen = [];
  const w = createPracticeWatch({ onGhost: (g) => seen.push(g.sourceLapId) });
  w.update(frame('practice', -1), 0);
  w.update(frame('practice', -1, { ghost: 'board:a:79299' }), 100);
  w.update(frame('practice', -1, { ghost: 'board:a:79299' }), 200);
  w.update(frame('practice', 80.1, { ghost: 'own:x' }), 80000);
  w.update(frame('practice', 80.1), 80100); // a frame without a ghost is not a change
  w.update(frame('practice', 80.1, { ghost: 'own:x' }), 80200);
  check('each change of the chased lap is reported once', seen.join(',') === 'board:a:79299,own:x', seen.join(','));
  w.update(frame('race', -1), 90000);
  check('the end carries the last lap chased', w._ended[0] && w._ended[0].ghostLapId === 'own:x');
  check('a throwing listener does not stop the watch', (() => {
    const v = createPracticeWatch({ onEnded: () => { throw new Error('x'); } });
    const u = drive(v, 0, [80]);
    v.update(frame('race', -1), u + 1);
    return v._ended.length === 1;
  })());
}

console.log('\npractice session: every timed lap, as it crosses the line (onLap)');
{
  const seen = [];
  const w = createPracticeWatch({ onLap: (l) => seen.push(l) });
  w.update(frame('practice', 81.2), 0); // the baseline: a time already on the board
  w.update(frame('practice', 81.2, { ghost: 'own:x' }), 500);
  check('the time showing on joining is not a lap', seen.length === 0);
  w.update(frame('practice', 80.4, { ghost: 'own:x' }), 80000);
  w.update(frame('practice', 80.4, { ghost: 'own:x' }), 80100); // the same time again is not a lap
  w.update(frame('practice', 79.9, { ghost: 'own:x' }), 160000);
  check('one call per new lap time', seen.length === 2, seen.length);
  const a = seen[0] || {};
  check('…with the time, the count and when it crossed', a.lapSec === 80.4 && a.lapCount === 1 && a.at === 80000, JSON.stringify(a));
  check('…the session it belongs to (start time + type) and the track', a.startedAt === 0 && a.sessionType === 'practice' && a.track === 'Road Atlanta');
  check('…the car, the class and the lap being chased', a.carClass === 'GT3' && a.car === 'Porsche 911 GT3 R' && a.ghostLapId === 'own:x');
  check('the second lap counts on', seen[1] && seen[1].lapCount === 2 && seen[1].lapSec === 79.9);
  check('the test list mirrors the calls', w._laps.length === 2);
  // A loading screen inside the session: laps after it keep the same session.
  w.update(null, 165000);
  w.update(frame('practice', 79.9), 170000);
  w.update(frame('practice', 79.5), 250000);
  check('a lap after a loading screen keeps the session start', seen[2] && seen[2].startedAt === 0);
  // A new session: a race, then practice again.
  w.update(frame('race', 90), 260000);
  w.update(frame('practice', 90), 900000);
  w.update(frame('practice', 78.8), 980000);
  check('a lap of the next session names the new start', seen[3] && seen[3].startedAt === 900000 && seen[3].lapCount === 1, seen[3] && seen[3].startedAt);
  const q = [];
  const wq = createPracticeWatch({ onLap: (l) => q.push(l) });
  drive(wq, 0, [80, 79], 'qualifying');
  check('qualifying laps are never reported', q.length === 0);
  check('a throwing onLap does not stop the watch', (() => {
    const v = createPracticeWatch({ onLap: () => { throw new Error('x'); } });
    drive(v, 0, [80, 79]);
    return v.current() && v.current().laps === 2;
  })());
  const cap = createPracticeWatch();
  drive(cap, 0, Array.from({ length: 70 }, (_, i) => 80 + i * 0.01));
  check('the test list is capped', cap._laps.length === 50 && cap.current().laps === 70, cap._laps.length);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
