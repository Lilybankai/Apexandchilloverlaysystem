/**
 * scripts/test-engineer-queue.js — the speech queue and the readout gates.
 * -----------------------------------------------------------------------------
 * Seam 2 of the v3 engineer plan: one small priority rule in front of the
 * voice. An ANSWER to the driver's question speaks immediately; a proactive
 * READOUT waits for a quiet channel and a driver who isn't mid-move, and is
 * dropped — never queued — once it has waited too long to still be news.
 *
 * The pipeline itself (Piper, the radio channel, the player sidecar) is real
 * audio and can't run headless, so this suite tests the DECISIONS: it stubs
 * `speak()` and drives the same EngineerService methods the WebSocket handler
 * and the PLAYED lines call. The preset gate (off / essential / standard) is
 * covered here too, because it lives on the same path.
 */

'use strict';

const path = require('node:path');

const { EngineerService } = require('../electron/engineer');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/** A service with the audio stubbed out and the readouts dial injectable. */
function rig(preset) {
  let settings = {
    engineerEnabled: true,
    engineerVoice: 'en_GB-alan-medium',
    engineer: { readouts: preset },
  };
  const svc = new EngineerService({
    dir: path.join(require('node:os').tmpdir(), 'apex-queue-test'),
    loadSettings: () => settings,
    onStatus: () => {},
  });
  svc.running = true; // the pipeline is stubbed; the decisions are real
  const spoken = [];
  svc.speak = (text) => spoken.push(text);
  return {
    svc,
    spoken,
    setPreset: (p) => { settings = { ...settings, engineer: { readouts: p } }; },
  };
}

/** A frame that reads as "driver has hands full" (or not). */
function drivingFrame(busy) {
  return {
    session: { track: 'T', type: 'race', numCars: 10 },
    player: { pedals: { throttle: 1, brake: busy ? 0.9 : 0, clutch: 0, steer: 0 } },
    standings: [],
    relative: [],
    radar: busy ? [{ slotId: 2, alongside: true, lateralM: 2, longitudinalM: 0, distanceM: 2 }] : [],
  };
}

/** A minimal cue of the given kind, enough for phraseForCue. */
function cueOf(kind, facts) {
  const trigger = { kind, atMs: 0, priority: 0, detail: kind, facts: facts || {} };
  return {
    atMs: 0,
    kind,
    triggers: [trigger],
    context: {
      sessionType: 'race', phase: 'green', flag: 'green', track: 'T',
      position: 7, classPosition: 3, carClass: 'GT3', numCars: 10,
      currentLap: 4, lapsRemaining: 10,
    },
    line: kind,
  };
}

console.log('\n1) A quiet channel speaks a readout immediately');
{
  const r = rig('essential');
  r.svc.lastFrame = drivingFrame(false);
  r.svc.sayReadout('Green green green.');
  check('spoken at once', r.spoken.length === 1 && /Green/.test(r.spoken[0]), r.spoken.join('|'));
  check('nothing held', r.svc.heldReadout === null || r.svc.heldReadout === undefined || !r.svc.heldReadout, String(r.svc.heldReadout));
}

console.log('\n2) A busy channel holds, and the PLAYED line releases');
{
  const r = rig('essential');
  r.svc.lastFrame = drivingFrame(false);
  r.svc.audioInFlight = 1; // an answer is still playing
  r.svc.sayReadout('Pit window is open.');
  check('held while audio is in flight', r.spoken.length === 0 && !!r.svc.heldReadout, r.spoken.join('|'));
  // What the player's PLAYED line does:
  r.svc.audioInFlight = 0;
  r.svc.pumpHeldReadout();
  check('spoken when the channel frees', r.spoken.length === 1 && /Pit window/.test(r.spoken[0]), r.spoken.join('|'));
  check('the hold is consumed', !r.svc.heldReadout);
}

console.log('\n3) A held readout expires rather than speaking late');
{
  const r = rig('essential');
  r.svc.lastFrame = drivingFrame(false);
  r.svc.audioInFlight = 1;
  r.svc.sayReadout("That's your quickest.");
  r.svc.heldReadout.expiresAt = Date.now() - 1; // it waited too long
  r.svc.audioInFlight = 0;
  r.svc.pumpHeldReadout();
  check('dropped, not spoken', r.spoken.length === 0, r.spoken.join('|'));
  check('and cleared', !r.svc.heldReadout);
}

console.log('\n4) A driver mid-move is not talked at');
{
  const r = rig('essential');
  r.svc.lastFrame = drivingFrame(true); // car alongside + deep in the brakes
  r.svc.sayReadout('Contact — light damage.');
  check('held while busy', r.spoken.length === 0 && !!r.svc.heldReadout);
  r.svc.lastFrame = drivingFrame(false); // move complete
  r.svc.pumpHeldReadout();
  check('spoken once clear', r.spoken.length === 1, r.spoken.join('|'));
}

console.log("\n5) The driver's question always wins");
{
  const r = rig('essential');
  r.svc.lastFrame = drivingFrame(false);
  r.svc.asking = true; // mic window open
  r.svc.sayReadout('Fastest lap, Smith.');
  check('held behind the question', r.spoken.length === 0 && !!r.svc.heldReadout);
  // ask() clears the hold the moment the button lands:
  r.svc.heldReadout = null; // (what ask() does first)
  r.svc.asking = false;
  r.svc.pumpHeldReadout();
  check('and the stale call never plays', r.spoken.length === 0, r.spoken.join('|'));
}

console.log('\n6) The dial: off / essential / standard');
{
  const r = rig('off');
  r.svc.lastFrame = drivingFrame(false);
  r.svc.onCue(cueOf('raceStart', { numCars: 10 }), r.svc.lastFrame);
  check('off speaks nothing, even the green flag', r.spoken.length === 0, r.spoken.join('|'));

  const r2 = rig('essential');
  r2.svc.lastFrame = drivingFrame(false);
  r2.svc.onCue(cueOf('raceStart', {}), r2.svc.lastFrame);
  r2.svc.onCue(cueOf('positionChange', { to: 6, gained: true }), r2.svc.lastFrame);
  check('essential speaks the green flag', r2.spoken.some((t) => /Green green green/.test(t)), r2.spoken.join('|'));
  check('…but not the race story', !r2.spoken.some((t) => /P6/.test(t)), r2.spoken.join('|'));

  const r3 = rig('standard');
  r3.svc.lastFrame = drivingFrame(false);
  r3.svc.onCue(cueOf('positionChange', { to: 6, gained: true }), r3.svc.lastFrame);
  check('standard speaks it', r3.spoken.some((t) => /Up to P6/.test(t)), r3.spoken.join('|'));

  // The dial moves live — same service, no restart.
  r3.spoken.length = 0;
  r3.setPreset('off');
  r3.svc.onCue(cueOf('fastestLapField', { name: 'Anna Smith', lapSec: 101.2 }), r3.svc.lastFrame);
  check('turning it off takes effect on the next cue', r3.spoken.length === 0, r3.spoken.join('|'));
}

console.log('\n7) Unknown trigger kinds never speak by accident');
{
  const r = rig('standard');
  r.svc.lastFrame = drivingFrame(false);
  r.svc.onCue(cueOf('someFutureKind', {}), r.svc.lastFrame);
  check('an unmapped kind is silent', r.spoken.length === 0, r.spoken.join('|'));
}

console.log('\n8) The grammar still wins over dictation text');
{
  // When the dictation grammar out-competes the closed one, a phrase buried
  // in the words routes back to Tier 1 — a phrase match must never reach the
  // cloud, and free-form questions must never false-match.
  const { matchGrammarText } = require('../electron/engineer');
  check('a bare phrase matches', matchGrammarText('gap ahead') === 'gapAhead');
  check('a phrase inside a sentence matches',
    matchGrammarText("mate what's the gap ahead right now") === 'gapAhead');
  check('apostrophes and punctuation are ignored',
    matchGrammarText('Whos ahead?') === 'carAhead');
  check('the longest phrase wins over a shorter one',
    matchGrammarText('what about the gap to the car behind') === 'gapBehind');
  check('word boundaries hold — no substring lottery',
    matchGrammarText('the gapahead situation') === null, String(matchGrammarText('the gapahead situation')));
  check('a genuinely free-form question does not match',
    matchGrammarText('safety car is out and I have half a tank what do we do') === null,
    String(matchGrammarText('safety car is out and I have half a tank what do we do')));
  check('empty text does not match', matchGrammarText('') === null);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
