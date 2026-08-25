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
  r3.svc.onCue(cueOf('practicePace', {
    reason: 'periodic', lapSec: 104, band: 'Midpack',
    deltaAlienSec: 4, deltaCompetitiveSec: 3,
  }), r3.svc.lastFrame);
  check('standard includes practice pace coaching',
    r3.spoken.some((t) => /Practice pace check/.test(t)), r3.spoken.join('|'));

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
  check('alien gap wording stays local',
    matchGrammarText('how far am i off alien pace') === 'paceAlien');
  check('competitive target wording stays local',
    matchGrammarText('what pace do i need to be competitive') === 'paceCompetitive');
  check('midpack target wording stays local',
    matchGrammarText('what is mid pack pace') === 'paceMidpack');
  check('empty text does not match', matchGrammarText('') === null);
  check('"sector times" reaches sectors', matchGrammarText('sector times') === 'sectors');
  check('"last lap sectors" prefers sectors over last lap',
    matchGrammarText('last lap sectors') === 'sectors');
  check('"penalty points" reaches trackLimits', matchGrammarText('penalty points') === 'trackLimits');
  // Day-one field wordings (2026-08-19 engineer_calls log): whisper writes
  // digits, drivers say "last five" — both must land on avgAhead, not the cloud.
  check('digits normalize to words',
    matchGrammarText('last 5 average for the cars ahead') === 'avgAhead',
    String(matchGrammarText('last 5 average for the cars ahead')));
  check('"top 5 average lap" reaches avgAhead',
    matchGrammarText('Top 5 average lap') === 'avgAhead');
  check('"last five average" reaches avgAhead',
    matchGrammarText('last five average') === 'avgAhead');
  // First-week field wordings (2026-08-20/21 engineer_calls log): each of
  // these reached the cloud — and cost a budgeted call — for an answer Tier 1
  // already had.
  check('"gap to car ahead" reaches gapAhead',
    matchGrammarText('gap to car ahead') === 'gapAhead');
  check('"what are my tyre temperatures" reaches tyres',
    matchGrammarText('What are my tyre temperatures?') === 'tyres');
  check('US spelling normalizes — "tire temp" reaches tyres',
    matchGrammarText('tire temp') === 'tyres');
  check('"how many laps till I need to pit" prefers pitWindow over lapsLeft',
    matchGrammarText('How many laps till I need to pit?') === 'pitWindow',
    String(matchGrammarText('How many laps till I need to pit?')));
  check('"when should I pit" reaches pitWindow',
    matchGrammarText('when should I pit') === 'pitWindow');
  check('"fuel ratio" reaches fuelRatio, not fuel',
    matchGrammarText("What's my fuel ratio?") === 'fuelRatio');
  check('"track temperature" reaches weather, not tyres',
    matchGrammarText('track temperature') === 'weather');
  // The fuzzy pass: one-letter STT mishears on multi-word phrases route home
  // ("LUST five average", 2026-08-19 log) — but a single word is never fuzzed,
  // because "full" is one edit from "fuel" and a near-miss deserves the cloud,
  // not a confident wrong answer.
  check('fuzzy: "lust five average" reaches avgAhead',
    matchGrammarText('lust five average') === 'avgAhead',
    String(matchGrammarText('lust five average')));
  check('fuzzy: a lone near-miss word does not match',
    matchGrammarText('full') === null, String(matchGrammarText('full')));
  // The trend/pit-exit set (2026-08-23).
  check('"am I catching him" reaches catching',
    matchGrammarText('am I catching him?') === 'catching');
  check('"is he catching me" reaches defending, not catching',
    matchGrammarText('is he catching me') === 'defending');
  check('"how long will the tyres last" reaches tyreLife, not tyres',
    matchGrammarText('how long will the tyres last') === 'tyreLife',
    String(matchGrammarText('how long will the tyres last')));
  check('"tyre life" reaches tyreLife',
    matchGrammarText('tyre life') === 'tyreLife');
  check('"where do I come out if I box now" reaches pitExit',
    matchGrammarText('where do I come out if I box now') === 'pitExit');
  check('"if I pit now where do I end up" reaches pitExit',
    matchGrammarText('if I pit now where do I end up') === 'pitExit');
}

console.log('\n9) The volume slider scales the audio, and old settings read as full');
{
  // The service side: slider percent → squared amplitude gain, read per clip.
  let settings = { engineer: { readouts: 'essential', volume: 50 } };
  const svc = new EngineerService({
    dir: path.join(require('node:os').tmpdir(), 'apex-queue-test'),
    loadSettings: () => settings,
    onStatus: () => {},
  });
  check('50% slider is a quarter of full amplitude', svc.volumeGain() === 0.25);
  check('status carries the percent', svc.status().volume === 50);
  settings = { engineer: { readouts: 'essential' } }; // written by an older build
  check('missing volume reads as full', svc.volumeGain() === 1 && svc.status().volume === 100);
  settings = { engineer: { readouts: 'essential', volume: 0 } };
  check('0% is silent, not full', svc.volumeGain() === 0);

  // The DSP side: the gain lands in the samples radio-fx writes.
  const radioFx = require('../electron/radio-fx');
  const tone = new Float64Array(2205);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / 22050);
  const peakOf = (arr) => arr.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const full = peakOf(radioFx.processSamples(tone, 22050));
  const half = peakOf(radioFx.processSamples(tone, 22050, 0.5));
  check('gain 0.5 halves the processed peak',
    Math.abs(half - full / 2) < 0.01, `full ${full.toFixed(3)}, half ${half.toFixed(3)}`);
  check('no gain argument means unchanged output', Math.abs(full - 0.89) < 0.01, full.toFixed(3));
}

console.log('\n10) Bound callouts speak immediately, no microphone');
{
  // A Stream Deck / wheel press is driver-initiated: it speaks even when the
  // unprompted dial is Quiet and the driver is busy, and it never opens the mic.
  const r = rig('off');
  r.svc.lastFrame = drivingFrame(true);
  const frame = {
    schemaVersion: 1,
    source: 'test',
    timestamp: 0,
    connected: true,
    session: { track: 'T', type: 'race', numCars: 1, phase: 'green', currentLap: 4 },
    player: { trackLimits: { points: 1.5, pointsLimit: 5, penalties: 0 } },
    standings: [{
      slotId: 1, position: 3, driverName: 'Carl Jones', isPlayer: true, carClass: 'GT3',
      classPosition: 2,
      lastLapSec: 103.42, bestLapSec: 102.1,
      lastSector1Sec: 28.1, lastSector2Sec: 71.4,
      gapToLeaderSec: -1, gapToAheadSec: -1, lapsBehind: 0, lapsCompleted: 4, inPit: false,
    }],
    relative: [],
    fuel: {},
  };
  check('commands module loaded', !!r.svc.commands);
  if (r.svc.commands) r.svc.commands.update(frame);

  const last = r.svc.speakIntent('lastLap');
  check('lastLap callout ok while busy and quiet-preset',
    last.ok && /1 43\.4/.test(r.spoken[0] || ''), r.spoken[0]);

  r.spoken.length = 0;
  const sec = r.svc.speakIntent('sectors');
  check('sectors callout speaks splits',
    sec.ok && /28\.1/.test(r.spoken[0] || '') && /43\.3/.test(r.spoken[0] || ''), r.spoken[0]);

  r.spoken.length = 0;
  const pts = r.svc.speakIntent('trackLimits');
  check('track-limit callout speaks points',
    pts.ok && /1\.5 of 5/.test(r.spoken[0] || ''), r.spoken[0]);

  r.spoken.length = 0;
  r.svc.heldReadout = { text: 'stale', expiresAt: Date.now() + 99999 };
  r.svc.speakIntent('position');
  check('a callout drops a held readout', r.svc.heldReadout === null);
  check('position callout spoke', /P2/.test(r.spoken[0] || ''), r.spoken[0]);

  r.svc.running = false;
  const off = r.svc.speakIntent('lastLap');
  check('callout while engineer off is an error', off.ok === false && /not running/.test(off.error || ''));
  r.svc.running = true;
  const unknown = r.svc.speakIntent('notAThing');
  check('unknown intent is an error', unknown.ok === false);
}

console.log('\n11) Callout actions register and fire speakIntent');
{
  const { createActions } = require('../electron/actions');
  const { ENGINEER_CALLOUTS } = require('../electron/engineer');
  const fired = [];
  const acts = createActions({
    engineerAsk: async () => ({ ok: true }),
    engineerSpeak: (intent) => { fired.push(intent); return { ok: true }; },
  });
  const ids = acts.list().filter((a) => a.group === 'Engineer').map((a) => a.id);
  check('PTT is in the engineer group', ids.includes('engineer.ask'));
  check(
    'every callout has a bindable action',
    ENGINEER_CALLOUTS.every((c) => ids.includes(`engineer.call.${c.intent}`)),
    ENGINEER_CALLOUTS.filter((c) => !ids.includes(`engineer.call.${c.intent}`)).map((c) => c.intent).join(',') || 'all present',
  );
  void acts.run('engineer.call.lastLap');
  check('running the last-lap action speaks that intent', fired[0] === 'lastLap');
  void acts.run('engineer.call.sectors');
  check('running the sectors action speaks that intent', fired[1] === 'sectors');
  void acts.run('engineer.call.trackLimits');
  check('running the points action speaks that intent', fired[2] === 'trackLimits');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
