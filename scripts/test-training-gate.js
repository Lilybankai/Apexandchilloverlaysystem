/**
 * scripts/test-training-gate.js — when the training layer runs, and when not.
 * -----------------------------------------------------------------------------
 * electron/trainingGate.js decides whether the training overlays' window
 * exists. Getting it wrong either way is visible: open in a race, and a
 * practice tool draws over a race; closed in practice, and the Training tab's
 * switch does nothing. Pinned here:
 *
 *   1. the whole channel × mode × running × session matrix — live only when all
 *      four say so, and the reason names the first one that does not;
 *   2. the hold-over: a practice answer survives ~10 s of no session (loading
 *      screens, a session change) and then expires; a session that says it is
 *      a race ends it at once;
 *   3. demo frames are never a session (the simulator calls every frame a
 *      race), only a gap a practice answer is held across;
 *   4. subscribers hear changes, not repeats.
 *
 * Pure: invented clocks, no Electron. Run: node scripts/test-training-gate.js
 */

'use strict';

const {
  createTrainingGate,
  evaluate,
  sessionOfFrame,
  HOLD_MS,
} = require('../electron/trainingGate');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
}

const live = (type, demo = false) => ({ type, demo });
const ALL_ON = { mode: true, beta: true, running: true, session: live('practice') };

console.log('\ntraining gate: the matrix');
{
  const sessions = ['practice', 'testday', 'qualifying', 'warmup', 'race', 'unknown', null];
  let combos = 0;
  let wrong = [];
  for (const beta of [true, false]) {
    for (const mode of [true, false]) {
      for (const running of [true, false]) {
        for (const type of sessions) {
          combos++;
          const r = evaluate(
            { mode, beta, running, session: type ? live(type) : null },
            1000,
            0,
          );
          const want = beta && mode && running && (type === 'practice' || type === 'testday');
          let reason = 'live';
          if (!beta) reason = 'channel';
          else if (!mode) reason = 'race-mode';
          else if (!running) reason = 'stopped';
          else if (!(type === 'practice' || type === 'testday')) {
            reason = type && type !== 'unknown' ? 'session' : 'no-session';
          }
          if (r.active !== want || r.reason !== reason) {
            wrong.push(`${beta}/${mode}/${running}/${type} → ${r.active},${r.reason}`);
          }
        }
      }
    }
  }
  check(`all ${combos} combinations answer as specified`, wrong.length === 0, wrong.slice(0, 4).join('; '));
  check('practice with everything on is live', evaluate(ALL_ON, 0, 0).active === true);
  check('a test day is live too', evaluate({ ...ALL_ON, session: live('testday') }, 0, 0).active);
  check(
    'a race is not, and says it is the session',
    evaluate({ ...ALL_ON, session: live('race') }, 0, 0).reason === 'session',
  );
  check(
    'the reason carries the session type for the panel',
    evaluate({ ...ALL_ON, session: live('qualifying') }, 0, 0).sessionType === 'qualifying',
  );
}

console.log('\ntraining gate: holding a practice answer between sessions');
{
  const g = createTrainingGate();
  g.update({ mode: true, beta: true, running: true, session: live('practice') }, 1000);
  check('practice → live', g.state().active);

  g.update({ session: null }, 2000); // feed went quiet: a loading screen
  check('no session for 1 s → still live (held)', g.state().active, g.state().reason);
  check('a held answer says when it runs out', g.state().heldUntil === 1000 + HOLD_MS, g.state().heldUntil);

  g.update({ session: live('unknown') }, 1000 + HOLD_MS - 1);
  check('"unknown" just inside the hold → still live', g.state().active);

  g.update({}, 1000 + HOLD_MS);
  check('time alone runs the hold out', !g.state().active && g.state().reason === 'no-session', g.state().reason);

  g.update({ session: live('practice') }, 20000);
  check('back in practice → live again', g.state().active);
  g.update({ session: live('race') }, 20500);
  check('a race ends it at once, no hold', !g.state().active && g.state().reason === 'session');
  g.update({ session: null }, 21000);
  check('and a gap after the race does not bring back the old practice', !g.state().active);

  const h = createTrainingGate();
  h.update({ mode: false, beta: true, running: true, session: live('practice') }, 0);
  check('Race mode is off even in practice', !h.state().active && h.state().reason === 'race-mode');
  h.update({ mode: true }, 500);
  check('switching to Training mid-practice is live at once', h.state().active);
  h.update({ running: false }, 600);
  check('stopping the server is immediate (no hold)', !h.state().active && h.state().reason === 'stopped');
  h.update({ running: true, beta: false }, 700);
  check('leaving beta is immediate', !h.state().active && h.state().reason === 'channel');
}

console.log('\ntraining gate: demo frames');
{
  check(
    'a demo frame is no session, whatever it calls itself',
    evaluate({ ...ALL_ON, session: live('practice', true) }, 0, 0).reason === 'no-session',
  );
  check(
    "the simulator's race is not a race either (it labels every frame one)",
    evaluate({ ...ALL_ON, session: live('race', true) }, 0, 0).reason === 'no-session',
  );
  // LMU closed mid-practice and the simulator stood in: a gap, not a race.
  const g = createTrainingGate();
  g.update({ mode: true, beta: true, running: true, session: live('practice') }, 1000);
  g.update({ session: live('race', true) }, 2000);
  check('demo frames after practice are a gap: the answer is held', g.state().active, g.state().reason);
  g.update({ session: live('race', true) }, 1000 + HOLD_MS);
  check('…and runs out like any gap', !g.state().active && g.state().reason === 'no-session', g.state().reason);
}

console.log('\ntraining gate: reading a frame');
{
  const a = sessionOfFrame({ connected: true, session: { type: 'practice' } });
  check('a live practice frame', a && a.type === 'practice' && a.demo === false);
  const b = sessionOfFrame({ connected: false, session: { type: 'race' } });
  check('a demo frame is marked demo', b && b.demo === true && b.type === 'race');
  const c = sessionOfFrame({ connected: true });
  check('a frame without a session reads as unknown', c && c.type === 'unknown');
  check('no frame is no session', sessionOfFrame(null) === null);
}

console.log('\ntraining gate: subscribers hear changes, not repeats');
{
  const g = createTrainingGate();
  const heard = [];
  const off = g.subscribe((s, prev) => heard.push(`${prev.active}->${s.active}:${s.reason}`));
  g.update({ mode: true, beta: true, running: true, session: live('practice') }, 0);
  for (let t = 250; t < 3000; t += 250) g.update({ session: live('practice') }, t); // 4 Hz frames
  check('one open, however many frames follow', heard.length === 1 && heard[0] === 'false->true:live', heard.join(' '));
  g.update({ session: live('race') }, 3000);
  check('one close', heard.length === 2 && heard[1] === 'true->false:session', heard.join(' '));
  g.update({ running: false }, 3100);
  check('a reason change alone is heard (the panel line follows it)', heard.length === 3, heard.join(' '));
  off();
  g.update({ running: true, session: live('practice') }, 3200);
  check('unsubscribed is unsubscribed', heard.length === 3);

  const k = createTrainingGate();
  const flips = [];
  k.subscribe(() => {
    throw new Error('a broken listener');
  });
  k.subscribe((s) => flips.push(s.active));
  k.update({ mode: true, beta: true, running: true, session: live('practice') }, 0);
  check('one throwing listener does not silence the next', flips.length === 1 && flips[0] === true);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
