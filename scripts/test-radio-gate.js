/**
 * scripts/test-radio-gate.js — radio etiquette: when the engineer may talk.
 * -----------------------------------------------------------------------------
 * Drivers hate radio in the braking zones and through corners, want it brief,
 * and want a "keep quiet" button. This suite covers the four pieces that
 * answer that (2026-10-02):
 *
 *   1. the gate itself (src/telemetry/radioGate.ts): straights, dwell, the
 *      learned map's runway, start quiet, urgency tiers, the one-slot hold;
 *   2. the service wiring (electron/engineer.js): sayReadout / pumpHeldReadout
 *      fed a synthetic pedal/steer/latG stream through observeFrame;
 *   3. the driver's radio controls on push-to-talk: "keep quiet", "talk to
 *      me", "repeat that" — routing, state, session reset, repeat-last;
 *   4. the "Only talk on straights" setting (whitelist + panel) and line
 *      discipline: every existing phrase-bank line ≤ MAX_SPOKEN_WORDS;
 *   5. "Mature radio" (2026-10-08): banter/savage roasts on mistakes only,
 *      facts kept, safety calls never touched, "keep quiet" reads clean.
 *
 * Audio is stubbed at the Piper stdin, so the real speak() runs (it is what
 * remembers the last line for "repeat that").
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gateMod = require('../dist/telemetry/radioGate.js');
const phrases = require('../dist/telemetry/engineerPhrases.js');
const { TRIGGER_PRIORITY } = require('../dist/telemetry/triggers.js');
const {
  EngineerService,
  GRAMMAR,
  RADIO_CONTROL_INTENTS,
  TRIGGER_TIERS,
  matchGrammarText,
  radioNoise,
} = require('../electron/engineer');
const { DEFAULT_ENGINEER_SETTINGS, sanitizeEngineer } = require('../electron/engineer-settings');

const { RadioGate, GATE, HOLD_BUDGET_MS, urgencyOf, keepHeld, heldRank, requiredRunwaySec } = gateMod;

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* -------------------------------------------------------------------------- */
/*  Frame builders                                                             */
/* -------------------------------------------------------------------------- */

const T0 = 1_800_000_000_000;

/** One frame of driving. Everything defaults to "flat out, wheel straight". */
function frame(o = {}) {
  const f = {
    timestamp: o.t !== undefined ? T0 + o.t : T0,
    source: 'test',
    session: { track: o.track || 'Test Ring', type: 'race', numCars: o.numCars || 20, phase: o.phase || 'green' },
    player: {
      pedals: {
        throttle: o.throttle !== undefined ? o.throttle : 1,
        brake: o.brake !== undefined ? o.brake : 0,
        clutch: 0,
        steer: o.steer !== undefined ? o.steer : 0,
      },
      motion: { latG: o.latG !== undefined ? o.latG : 0 },
      speedKph: o.kph !== undefined ? o.kph : 220,
    },
    standings: o.frac !== undefined ? [{ isPlayer: true, lapFraction: o.frac }] : [],
    relative: [],
    radar: o.alongside ? [{ slotId: 2, alongside: true, lateralM: 2, longitudinalM: 0, distanceM: 2 }] : [],
  };
  if (o.noPedals) delete f.player.pedals;
  return f;
}

/** Feed a gate `ms` of the same driving at 30 Hz from `t`; returns the end time. */
function drive(gate, t, ms, o = {}) {
  const step = 1000 / 30;
  let last = null;
  for (let x = 0; x <= ms; x += step) {
    last = frame({ ...o, t: t + x });
    gate.observe(last);
  }
  return { t: t + ms, frame: last };
}

const ON = { onlyStraights: true };

/* -------------------------------------------------------------------------- */
console.log('\n1) Urgency: every existing kind has a tier, and unknown kinds are polite');
{
  const expectUrgent = ['redFlag', 'fullCourseYellow', 'sectorYellow', 'penalty', 'fuelCritical', 'raceStart', 'restart', 'yieldTo'];
  const expectPriority = ['incident', 'finalLap', 'checkered', 'fuelWindow', 'penaltyServed', 'sectorClear', 'pitWindowOpen'];
  const expectNormal = ['fastestLapSelf', 'fastestLapField', 'positionChange', 'rivalPitted', 'practicePace'];
  const table = Object.keys(TRIGGER_PRIORITY)
    .map((k) => `${k}=${urgencyOf(k)}`)
    .join(' ');
  console.log('        ' + table);
  check('urgent kinds', expectUrgent.every((k) => urgencyOf(k) === 'urgent'));
  check('priority kinds', expectPriority.every((k) => urgencyOf(k) === 'priority'));
  check('normal kinds', expectNormal.every((k) => urgencyOf(k) === 'normal'));
  const classified = new Set([...expectUrgent, ...expectPriority, ...expectNormal]);
  check(
    'every kind triggers.ts knew on 2026-10-02 still exists (a rename would un-tier it)',
    [...classified].every((k) => k in TRIGGER_PRIORITY && k in TRIGGER_TIERS),
    [...classified].filter((k) => !(k in TRIGGER_PRIORITY)).join(',') || 'all 20 present',
  );
  check('an unknown kind is normal', urgencyOf('someFutureKind') === 'normal' && urgencyOf(undefined) === 'normal');
  check('a prototype key is not a kind', urgencyOf('toString') === 'normal' && urgencyOf('constructor') === 'normal');
  check('the driver-requested fuel-target report is "requested"', urgencyOf('fuelTargetLap') === 'requested');
  check('the map is exported for other branches to extend', typeof gateMod.KIND_URGENCY === 'object' &&
    Object.keys(TRIGGER_PRIORITY).every((k) => k in gateMod.KIND_URGENCY));
  check('rank order: urgent > priority > requested > normal',
    gateMod.URGENCY_RANK.urgent > gateMod.URGENCY_RANK.priority &&
      gateMod.URGENCY_RANK.priority > gateMod.URGENCY_RANK.requested &&
      gateMod.URGENCY_RANK.requested > gateMod.URGENCY_RANK.normal);
  check('budgets: urgent 4 s, normal 15 s, priority and requested 25 s',
    HOLD_BUDGET_MS.urgent === 4000 && HOLD_BUDGET_MS.normal === 15000 &&
      HOLD_BUDGET_MS.priority === 25000 && HOLD_BUDGET_MS.requested === 25000);
  const newKinds = Object.keys(TRIGGER_PRIORITY).filter((k) => !classified.has(k));
  if (newKinds.length) console.log('  INFO  kinds added since (tier = ' + newKinds.map((k) => `${k}:${urgencyOf(k)}`).join(', ') + ')');
}

/* -------------------------------------------------------------------------- */
console.log('\n2) The instantaneous rule: brakes, wheel, lateral load, alongside');
{
  const g = new RadioGate();
  check('braking zone holds', g.verdict(frame({ throttle: 0, brake: 0.8 }), ON).reason === 'braking');
  check('trail-brake residue holds', g.verdict(frame({ throttle: 0.95, brake: 0.1 }), ON).reason === 'braking');
  check('a lift holds', g.verdict(frame({ throttle: 0.6 }), ON).reason === 'throttle');
  check('turning holds', g.verdict(frame({ steer: 0.2 }), ON).reason === 'steering');
  check('steering noise on a straight is fine (±0.06 is 75% of straight time)', g.verdict(frame({ steer: -0.06 }), ON).clear);
  check('a fast corner on little lock holds (LMP2: 1.2 g at 0.07 lock)',
    g.verdict(frame({ steer: 0.07, latG: 1.2 }), ON).reason === 'cornering');
  check('banking-level load on a straight wheel is fine (Daytona ~0.7 g)',
    g.verdict(frame({ steer: 0.03, latG: 0.7 }), ON).clear);
  check('a car alongside holds', g.verdict(frame({ alongside: true }), ON).reason === 'alongside');
  check('an out-of-stream straight frame is judged on its own (no dwell)', g.verdict(frame({}), ON).clear);
  check('no pedal block reads as clear, like the old gate', g.verdict(frame({ noPedals: true }), ON).clear);
  check('no frame at all reads as clear', g.verdict(null, ON).clear);
}

/* -------------------------------------------------------------------------- */
console.log('\n3) The dwell: a straight must hold before a line starts');
{
  const g = new RadioGate();
  let r = drive(g, 0, 2000, { throttle: 0.3, steer: 0.4 }); // a corner
  check('corner → hold', !g.verdict(r.frame, ON).clear, g.verdict(r.frame, ON).reason);
  r = drive(g, r.t + 33, 400); // flat, 0.4 s
  check('0.4 s into the straight → settling', g.verdict(r.frame, ON).reason === 'settling');
  r = drive(g, r.t + 33, 500); // ≥ 0.8 s now
  check(`≥ ${GATE.dwellMs} ms flat → clear`, g.verdict(r.frame, ON).clear, g.verdict(r.frame, ON).reason);
  r = drive(g, r.t + 33, 0, { brake: 0.7, throttle: 0 });
  check('the braking zone arrives → hold again', g.verdict(r.frame, ON).reason === 'braking');
  r = drive(g, r.t + 33, 0);
  check('…and the very next flat frame has no dwell yet', g.verdict(r.frame, ON).reason === 'settling');
}

/* -------------------------------------------------------------------------- */
console.log('\n4) Starts, cautions, stops and the setting');
{
  const g = new RadioGate();
  let r = drive(g, 0, 1000, { phase: 'countdown', kph: 0, throttle: 0.6 });
  r = drive(g, r.t + 33, 3000, { phase: 'green' }); // green, flat for 3 s
  check('3 s after the green flag → start quiet', g.verdict(r.frame, ON).reason === 'start');
  r = drive(g, r.t + 33, 6000, { phase: 'green' });
  check(`${GATE.startQuietMs / 1000} s later → clear`, g.verdict(r.frame, ON).clear, g.verdict(r.frame, ON).reason);
  r = drive(g, r.t + 33, 500, { phase: 'fullCourseYellow', throttle: 0.4, steer: 0.3 });
  check('behind the safety car, mid-corner → clear (nobody is racing)', g.verdict(r.frame, ON).reason === 'caution');
  r = drive(g, r.t + 33, 500, { phase: 'green' });
  check('the restart buys the same quiet', g.verdict(r.frame, ON).reason === 'start');
  const g2 = new RadioGate();
  r = drive(g2, 0, 500, { kph: 0, throttle: 0 });
  check('parked → clear', g2.verdict(r.frame, ON).reason === 'stopped');
  const corner = frame({ throttle: 0.4, steer: 0.3, latG: 1.5 });
  check('setting off: a corner is fine (the old rule)', g2.verdict(corner, { onlyStraights: false }).clear);
  check('setting off: deep braking still holds', !g2.verdict(frame({ brake: 0.8 }), { onlyStraights: false }).clear);
  check('setting off: alongside still holds', !g2.verdict(frame({ alongside: true }), { onlyStraights: false }).clear);
}

/* -------------------------------------------------------------------------- */
console.log('\n5) Learned straights: the gate looks ahead');
{
  // A 60 s lap: straight 0–0.30, corner 0.30–0.40, straight 0.40–0.80, corner 0.80–1.
  const g = new RadioGate();
  const LAP = 60_000;
  const at = (frac) => {
    const corner = (frac >= 0.3 && frac < 0.4) || frac >= 0.8;
    return corner ? { throttle: 0.3, steer: 0.3, latG: 1.4 } : {};
  };
  let t = 0;
  const step = 1000 / 30;
  let lastFrame = null;
  const lapTo = (laps, stopFrac) => {
    for (let lap = 0; lap < laps; lap++) {
      for (let x = 0; x < LAP; x += step) {
        const frac = x / LAP;
        if (stopFrac !== undefined && lap === laps - 1 && frac >= stopFrac) return;
        lastFrame = frame({ ...at(frac), frac, t });
        g.observe(lastFrame);
        t += step;
      }
    }
  };
  lapTo(1, 0.27);
  check('first lap, unlearned: 0.27 is just a straight → clear', g.verdict(lastFrame, ON).clear, g.verdict(lastFrame, ON).reason);
  check('…and the map has no runway to offer yet', g.runwaySec(0.27) === null);
  lapTo(3, 0.27);
  const v = g.verdict(lastFrame, { onlyStraights: true, words: 10 });
  check('three laps in: 0.27 is 1.8 s from the corner → runway hold', v.reason === 'runway', `${v.reason} ${v.runwaySec && v.runwaySec.toFixed(2)} s`);
  check('a 10-word line needs ~4.2 s', Math.abs(requiredRunwaySec(10) - 4.17) < 0.05, requiredRunwaySec(10).toFixed(2));
  const v3 = g.verdict(lastFrame, { onlyStraights: true, words: 10, waitedMs: GATE.runwayPatienceMs });
  check(`…but a line that has already waited ${GATE.runwayPatienceMs / 1000} s takes the short straight`, v3.clear, v3.reason);
  lapTo(1, 0.41);
  const v2 = g.verdict(lastFrame, { onlyStraights: true, words: 10 });
  check('just onto the long straight (0.6 s flat): learned dwell lets it go early',
    v2.clear && v2.runwaySec > 20, `${v2.reason} ${v2.runwaySec && v2.runwaySec.toFixed(1)} s`);
  check('the runway is the time to the corner, not the distance', Math.abs(v2.runwaySec - 23.4) < 0.6, v2.runwaySec.toFixed(1));
  // A new session at the same track keeps the map; a new track forgets it.
  const r1 = g.observe(frame({ frac: 0.5, t: t + 100, numCars: 21 }));
  check('a new session is reported', r1.sessionChanged === true);
  check('…and the same track keeps its learned straights', g.runwaySec(0.5) !== null);
  g.observe(frame({ frac: 0.5, t: t + 200, numCars: 21, track: 'Elsewhere' }));
  check('a new track forgets them', g.runwaySec(0.5) === null);
}

/* -------------------------------------------------------------------------- */
console.log('\n6) The one-slot hold: replacement by rank');
{
  const line = (urgency, priority, text) => ({ text, urgency, priority, heldAtMs: 0, expiresAt: 1 });
  const fast = line('normal', 30, 'fastest');
  const pos = line('normal', 25, 'position');
  const dmg = line('priority', 85, 'damage');
  const fcy = line('urgent', 90, 'fcy');
  check('nothing held → the newcomer', keepHeld(null, pos) === pos);
  check('newer normal of higher priority replaces', keepHeld(pos, fast) === fast);
  check('newer normal of equal priority replaces (fresher news)', keepHeld(pos, line('normal', 25, 'p2')).text === 'p2');
  check('an older higher-priority normal stays', keepHeld(fast, pos) === fast);
  check('a priority line is never displaced by chatter', keepHeld(dmg, fast) === dmg);
  check('urgent displaces priority', keepHeld(dmg, fcy) === fcy);
  const fuelRep = line('requested', 0, 'fuel report');
  check('a requested report survives routine chatter on the same lap edge',
    keepHeld(fuelRep, fast) === fuelRep && keepHeld(fuelRep, pos) === fuelRep);
  check('…and displaces held chatter', keepHeld(fast, fuelRep) === fuelRep);
  check('…but yields to a must-hear call', keepHeld(fuelRep, dmg) === dmg);
  check('a legacy held line without a tier still ranks', Number.isFinite(heldRank({ priority: undefined, urgency: undefined })));
}

/* -------------------------------------------------------------------------- */
/*  The service                                                                */
/* -------------------------------------------------------------------------- */

function service(engineer = {}) {
  let settings = { engineerEnabled: true, engineerVoice: 'en_GB-alan-medium', engineer: { readouts: 'standard', ...engineer } };
  const svc = new EngineerService({
    dir: path.join(os.tmpdir(), 'apex-radio-gate-test'),
    loadSettings: () => settings,
    onStatus: () => {},
  });
  const spoken = [];
  svc.running = true;
  // Stub at Piper's stdin so the REAL speak() runs (lastLine, the echo log).
  svc.piper = { stdin: { writable: true, write: (t) => spoken.push(String(t).trim()) } };
  let now = T0;
  svc.clock = () => now;
  return {
    svc,
    spoken,
    advance: (ms) => (now += ms),
    set: (patch) => (settings = { ...settings, engineer: { ...settings.engineer, ...patch } }),
    feed: (ms, o) => {
      // The stream drives the gate; `now` follows the frames' clock.
      const step = 1000 / 30;
      for (let x = 0; x <= ms; x += step) {
        now += step;
        svc.observeFrame(frame({ ...o, t: now - T0 }));
        svc.pumpHeldReadout();
      }
    },
  };
}

function cueOf(kind, facts) {
  const trigger = { kind, atMs: 0, priority: TRIGGER_PRIORITY[kind] || 0, detail: kind, facts: facts || {} };
  return {
    atMs: 0,
    kind,
    triggers: [trigger],
    context: { sessionType: 'race', phase: 'green', flag: 'green', track: 'T', position: 7, classPosition: 3, carClass: 'GT3', numCars: 20, currentLap: 4, lapsRemaining: 10 },
    line: kind,
  };
}

console.log('\n7) Service: a normal call waits out the braking zone and the corner');
{
  const r = service();
  r.feed(500, { brake: 0.9, throttle: 0 });
  r.svc.onCue(cueOf('positionChange', { to: 6, gained: true }), r.svc.lastFrame);
  check('braking zone → held', r.spoken.length === 0 && !!r.svc.heldReadout);
  check('…as a normal line with a 15 s budget', r.svc.heldReadout.urgency === 'normal' &&
    r.svc.heldReadout.expiresAt - r.svc.heldReadout.heldAtMs === 15000);
  r.feed(1500, { throttle: 0.5, steer: 0.35, latG: 1.6 });
  check('corner → still held', r.spoken.length === 0);
  r.feed(500, {});
  check('0.5 s onto the straight → still settling', r.spoken.length === 0);
  r.feed(500, {});
  check('≥ 0.8 s flat → spoken', r.spoken.length === 1 && /P6/.test(r.spoken[0]), r.spoken.join('|'));
}

console.log('\n8) Service: urgent kinds skip the straights rule, not the braking zone');
{
  // Carl 2026-10-02: "only on straights" and still talking in corners — every
  // urgent kind (traffic countdowns, blue flags) bypassed the gate entirely.
  const r = service();
  r.feed(300, { brake: 0.9, throttle: 0 });
  r.svc.onCue(cueOf('fullCourseYellow'), r.svc.lastFrame);
  check('safety car in a braking zone → held, not spoken', r.spoken.length === 0 && !!r.svc.heldReadout && r.svc.heldReadout.urgency === 'urgent');
  r.feed(300, { throttle: 0.6 });
  check('…and said the moment the car is off the brake, part throttle or not', r.spoken.length === 1 && /course yellow|Safety car/i.test(r.spoken[0]), r.spoken.join('|'));

  // A safety call that finds no calm moment is said anyway after 1.5 s.
  r.feed(100, { brake: 0.9, throttle: 0 });
  r.svc.onCue(cueOf('fuelCritical', { reason: 'fuel' }), r.svc.lastFrame);
  r.feed(1000, { throttle: 0.5, steer: 0.4, latG: 1.6 });
  check('box this lap waits through the corner…', r.spoken.length === 1);
  r.feed(700, { throttle: 0.5, steer: 0.4, latG: 1.6 });
  check(`…but past ${GATE.urgentPatienceMs} ms it is said regardless`, r.spoken.length === 2 && /[Bb]ox/.test(r.spoken[1]), r.spoken.join('|'));

  // A blue flag is useful, not vital: never mid-corner, dropped on its budget.
  r.svc.onCue(cueOf('yieldTo', { name: 'A Smith', gapSec: 1.2 }), r.svc.lastFrame);
  r.feed(3000, { throttle: 0.5, steer: 0.4, latG: 1.6 });
  check('blue flags are not said mid-corner', r.spoken.length === 2, r.spoken.join('|'));
  r.feed(1500, { throttle: 0.5, steer: 0.4, latG: 1.6 });
  check('…and are dropped past 4 s rather than said late', r.spoken.length === 2 && !r.svc.heldReadout);
  r.feed(100, { throttle: 0.7 });
  r.svc.onCue(cueOf('yieldTo', { name: 'A Smith', gapSec: 1.2 }), r.svc.lastFrame);
  check('…and said at once on a corner exit (calm, not a straight)', r.spoken.length === 3, r.spoken.join('|'));

  // A red flag still waits for the CHANNEL, on a 4 s budget.
  r.svc.audioInFlight = 1;
  r.svc.onCue(cueOf('redFlag'), r.svc.lastFrame);
  check('urgent + answer still playing → held', r.spoken.length === 3 && r.svc.heldReadout.urgency === 'urgent');
  r.advance(4100);
  r.svc.audioInFlight = 0;
  r.svc.pumpHeldReadout();
  check('…and dropped past 4 s rather than spoken late', r.spoken.length === 3 && !r.svc.heldReadout);
  r.svc.audioInFlight = 1;
  r.svc.onCue(cueOf('redFlag'), r.svc.lastFrame);
  r.advance(1000);
  r.svc.audioInFlight = 0;
  r.svc.pumpHeldReadout(); // the PLAYED line
  check('inside 4 s the PLAYED line releases it', r.spoken.length === 4 && /Red flag/.test(r.spoken[3]));

  // The gate on its own: urgent → the calm rule, never the dwell or runway.
  const g = new RadioGate();
  const d = drive(g, T0, 100, { throttle: 0.5 });
  check('gate: urgent on part throttle, no dwell → clear', g.verdict(d.frame, { ...ON, kind: 'trafficBehind' }).clear === true);
  check('gate: a normal line there → not clear', g.verdict(d.frame, { ...ON, kind: 'positionChange' }).clear === false);
  const b = drive(g, d.t, 100, { brake: 0.4, throttle: 0 });
  check('gate: urgent in the brakes → braking', g.verdict(b.frame, { ...ON, kind: 'trafficBehind' }).reason === 'braking');
  check('gate: a safety kind past its patience → clear', g.verdict(b.frame, { ...ON, kind: 'sectorYellow', waitedMs: GATE.urgentPatienceMs }).clear === true);
  check('gate: a traffic call has no such patience', g.verdict(b.frame, { ...ON, kind: 'trafficBehind', waitedMs: 3000 }).clear === false);
  check('breaksQuiet: the safety kinds only', ['redFlag', 'sectorYellow', 'penalty', 'fuelCritical'].every(gateMod.breaksQuiet) &&
    !['yieldTo', 'trafficBehind', 'trafficAhead', 'raceStart', 'restart', 'positionChange', null].some(gateMod.breaksQuiet));
}

console.log('\n9) Service: per-urgency expiry');
{
  const r = service();
  r.feed(200, { brake: 0.9, throttle: 0 });
  r.svc.onCue(cueOf('fastestLapField', { name: 'A Smith', lapSec: 101.2 }), r.svc.lastFrame);
  r.feed(14500, { throttle: 0.5, steer: 0.3 }); // a long, twisty section
  check('a normal line survives 14.5 s of corners', !!r.svc.heldReadout && r.spoken.length === 0);
  r.feed(600, { throttle: 0.5, steer: 0.3 });
  check('…and is dropped past 15 s', !r.svc.heldReadout && r.spoken.length === 0);

  r.svc.onCue(cueOf('finalLap'), r.svc.lastFrame);
  r.feed(20000, { throttle: 0.5, steer: 0.3 }); // Spa: line → La Source → Eau Rouge
  check('a priority line (last lap) survives 20 s', !!r.svc.heldReadout && r.svc.heldReadout.urgency === 'priority');
  r.feed(1000, {});
  check('…and lands on the next straight', r.spoken.length === 1 && /[Ll]ast lap|Final lap|last one/.test(r.spoken[0]), r.spoken.join('|'));
}

console.log('\n10) Service: never more than one held line');
{
  const r = service();
  r.feed(200, { brake: 0.9, throttle: 0 });
  r.svc.onCue(cueOf('positionChange', { to: 6, gained: true }), r.svc.lastFrame);
  r.svc.onCue(cueOf('fastestLapSelf', { lapSec: 101.2 }), r.svc.lastFrame);
  check('a newer, higher normal replaces the held one', /1 41\.2/.test(r.svc.heldReadout.text), r.svc.heldReadout.text);
  r.svc.onCue(cueOf('incident', { severity: 'major', repairSeconds: 40 }), r.svc.lastFrame);
  check('damage (priority) takes the slot', r.svc.heldReadout.kind === 'incident');
  r.svc.onCue(cueOf('positionChange', { to: 5, gained: true }), r.svc.lastFrame);
  check('…and chatter cannot push it off', r.svc.heldReadout.kind === 'incident');
  r.feed(1200, {});
  check('one line spoken on the straight, the damage', r.spoken.length === 1 && /damage/.test(r.spoken[0]), r.spoken.join('|'));
}

console.log('\n10b) Service: a requested report keeps its slot through the lap edge');
{
  const r = service();
  r.feed(200, { brake: 0.9, throttle: 0 });
  r.svc.sayReadout('3.70 litres that lap, target 3.62.', { kind: 'fuelTargetLap', priority: 0 });
  check('held as requested, 25 s budget', r.svc.heldReadout.urgency === 'requested' &&
    r.svc.heldReadout.expiresAt - r.svc.heldReadout.heldAtMs === 25000);
  r.svc.onCue(cueOf('fastestLapSelf', { lapSec: 101.2 }), r.svc.lastFrame);
  r.svc.onCue(cueOf('positionChange', { to: 5, gained: true }), r.svc.lastFrame);
  check('fastest lap and a position change do not push it off', r.svc.heldReadout.kind === 'fuelTargetLap');
  r.feed(18000, { throttle: 0.5, steer: 0.3 });
  check('it outlives the 15 s routine budget', !!r.svc.heldReadout && r.svc.heldReadout.kind === 'fuelTargetLap');
  r.feed(1200, {});
  check('…and lands on the next straight', r.spoken.length === 1 && /3\.70 litres/.test(r.spoken[0]), r.spoken.join('|'));
}

console.log('\n11) Service: the setting');
{
  const r = service({ onlyStraights: false });
  r.feed(300, { throttle: 0.4, steer: 0.3, latG: 1.5 });
  r.svc.onCue(cueOf('positionChange', { to: 6, gained: true }), r.svc.lastFrame);
  check('"Only talk on straights" off: mid-corner speaks (old rule)', r.spoken.length === 1);
  r.feed(300, { brake: 0.9, throttle: 0 });
  r.svc.onCue(cueOf('fastestLapSelf', { lapSec: 101.2 }), r.svc.lastFrame);
  check('…but deep braking still holds', r.spoken.length === 1 && !!r.svc.heldReadout);
  const w = service();
  const seen = [];
  w.svc.radioGate.verdict = (f, opts) => (seen.push(opts), { clear: false, reason: 'runway' });
  w.svc.lastFrame = frame({});
  w.svc.sayReadout('Up to P6.', { kind: 'positionChange', priority: 25 });
  w.advance(3500);
  w.svc.pumpHeldReadout();
  check('the held line tells the gate how long it has waited (the runway patience)',
    seen.length === 2 && seen[0].waitedMs === undefined && seen[1].waitedMs === 3500 && seen[1].text === 'Up to P6.',
    JSON.stringify(seen.map((o) => o.waitedMs)));
  const st = service().svc.status();
  check('status carries onlyStraights (default on) and radioQuiet', st.onlyStraights === true && st.radioQuiet === false);
  check('the answer path is never gated: a callout speaks mid-corner',
    (() => {
      const q = service();
      q.feed(300, { brake: 0.9, throttle: 0 });
      q.svc.commands.update({ ...frame({}), connected: true, standings: [{ slotId: 1, position: 3, isPlayer: true, driverName: 'C J', classPosition: 2, lastLapSec: 103.4, bestLapSec: 102, lapsCompleted: 4, gapToLeaderSec: -1, gapToAheadSec: -1, lapsBehind: 0, inPit: false }], fuel: {} });
      return q.svc.speakIntent('lastLap').ok && q.spoken.length === 1;
    })());
}

/* -------------------------------------------------------------------------- */
/*  Radio controls                                                             */
/* -------------------------------------------------------------------------- */

console.log('\n12) Radio controls: phrases route, and steal nothing');
{
  const route = (t) => matchGrammarText(t);
  check('"keep quiet" → radioQuiet', route('keep quiet') === 'radioQuiet');
  check('"radio silence please" → radioQuiet', route('radio silence please') === 'radioQuiet');
  check('"quiet please" → radioQuiet', route('Quiet, please.') === 'radioQuiet');
  // 2026-10-02 call log: "mute engineer," went to the cloud and got "Copy that."
  check('"mute engineer" → radioQuiet', route('mute engineer,') === 'radioQuiet');
  check('"shut up" / "stop the calls" / "quiet" → radioQuiet',
    ['shut up', 'stop the calls please', 'Quiet.', 'mute the radio', 'no more calls'].every((t) => route(t) === 'radioQuiet'));
  check('"unmute" → radioTalk, not radioQuiet', route('unmute engineer') === 'radioTalk' && route('unmute') === 'radioTalk');
  check('whisper\'s "[Silence]" on an empty clip does not mute the radio', route('[Silence]') !== 'radioQuiet');
  check('"stop saving" is still the fuel target, not quiet', route('stop saving') !== 'radioQuiet');
  check('"talk to me" → radioTalk', route('OK, talk to me') === 'radioTalk');
  check('"radio on" → radioTalk', route('radio on') === 'radioTalk');
  check('"you can talk" → radioTalk', route('you can talk now') === 'radioTalk');
  check('"repeat that" → radioRepeat', route('repeat that') === 'radioRepeat');
  check('"say again" → radioRepeat', route('Say again?') === 'radioRepeat');
  check('"say that again" → radioRepeat', route('can you say that again') === 'radioRepeat');
  check('"repeat" → radioRepeat', route('repeat') === 'radioRepeat');
  check('a question phrase still wins a length tie ("gap ahead" vs "say again")',
    route('say again the gap ahead') !== 'radioRepeat');
  check('every control is in the grammar with a group', [...RADIO_CONTROL_INTENTS].every((i) => {
    const g = GRAMMAR.find((x) => x.intent === i);
    return g && g.group === 'Radio';
  }));
  // The driver's words must survive the noise filter, even straight after the
  // engineer's own "Say again?".
  const SPOKEN = ['Say again?', 'Up to P6. Keep it rolling.'];
  for (const t of ['say again', 'say that again', 'repeat', 'repeat that', 'keep quiet', 'radio silence', 'talk to me', 'can you say that again please']) {
    check(`radioNoise passes "${t}"`, radioNoise(t, SPOKEN) === null, String(radioNoise(t, SPOKEN)));
  }
}

/** Drive the real ask() with the mic, whisper and cloud stubbed. */
function asker(engineer) {
  const r = service(engineer);
  const cloud = [];
  let heard = { kind: 'FREE', text: '', wav: 'clip.wav' };
  let whisper = '';
  r.svc.recognizerReady = true;
  r.svc.playChirp = () => {};
  r.svc.pushStatus = () => {};
  r.svc.recognizer = { stdin: { write: () => setImmediate(() => r.svc.pendingListen && r.svc.pendingListen(heard)) } };
  r.svc.transcribeClip = async () => ({ question: whisper, sttMs: 5 });
  r.svc.askTier2 = async (q) => {
    cloud.push(q);
    return 'cloud-ok';
  };
  r.svc.commands.update({
    ...frame({}),
    connected: true,
    standings: [{ slotId: 1, position: 3, isPlayer: true, driverName: 'Carl Jones', classPosition: 2, lastLapSec: 103.42, bestLapSec: 102.1, lapsCompleted: 4, gapToLeaderSec: -1, gapToAheadSec: -1, lapsBehind: 0, inPit: false }],
    fuel: { levelLiters: 40, perLapAvgLiters: 4, lapsRemaining: 10 },
  });
  return {
    ...r,
    cloud,
    say: async (text) => {
      whisper = text;
      heard = { kind: 'FREE', text: '', wav: 'clip.wav' };
      r.spoken.length = 0;
      const res = await r.svc.ask();
      return { said: r.spoken.join('|'), res };
    },
    sapi: async (intent) => {
      heard = { kind: 'HEARD', intent, wrapped: false, confidence: 0.95, wav: 'clip.wav', text: '' };
      r.spoken.length = 0;
      const res = await r.svc.ask();
      return { said: r.spoken.join('|'), res };
    },
  };
}

async function radioControls() {
  console.log('\n13) Radio controls: quiet / talk / repeat, end to end through ask()');
  const a = asker();
  let out = await a.say('keep quiet');
  check('"keep quiet" → "Copy, quiet."', out.said === 'Copy, quiet.' && a.svc.radioQuiet === true, out.said);
  check('…counted as a Tier-1 answer, never the cloud', out.res.outcome === 'tier1' && a.cloud.length === 0);
  check('status shows the quiet radio', a.svc.status().radioQuiet === true);
  a.spoken.length = 0;
  a.feed(1200, {});
  a.svc.onCue(cueOf('positionChange', { to: 6, gained: true }), a.svc.lastFrame);
  a.svc.onCue(cueOf('incident', { severity: 'major' }), a.svc.lastFrame);
  check('quiet mutes normal and priority calls, even on a straight', a.spoken.length === 0 && !a.svc.heldReadout);
  a.svc.onCue(cueOf('yieldTo', { name: 'A Smith', gapSec: 1.2 }), a.svc.lastFrame);
  a.svc.onCue(cueOf('raceStart'), a.svc.lastFrame);
  check('…and urgent-but-not-vital ones too (blue flags, green flag)', a.spoken.length === 0 && !a.svc.heldReadout, a.spoken.join('|'));
  a.svc.onCue(cueOf('fullCourseYellow'), a.svc.lastFrame);
  check('…but a safety call still speaks', a.spoken.length === 1 && /yellow|Safety/i.test(a.spoken[0]));
  out = await a.say('OK, you can talk');
  check('"you can talk" → "Copy, back on."', out.said === 'Copy, back on.' && a.svc.radioQuiet === false, out.said);
  a.spoken.length = 0;
  a.svc.onCue(cueOf('positionChange', { to: 6, gained: true }), a.svc.lastFrame);
  check('normal calls are back', a.spoken.length === 1);

  out = await a.say('fuel');
  const fuelLine = out.said;
  out = await a.say('say that again');
  check('"say that again" repeats the last answer', out.said === fuelLine && !!fuelLine, `${out.said} / ${fuelLine}`);
  out = await a.say('xq'); // too short → the engineer's own "Say again?"
  out = await a.say('repeat that');
  check('…and skips the engineer\'s own "Say again?"', out.said === fuelLine, out.said);
  a.feed(1200, {});
  a.svc.onCue(cueOf('fastestLapField', { name: 'Anna Smith', lapSec: 101.2 }), a.svc.lastFrame);
  out = await a.sapi('radioRepeat');
  check('a proactive call is repeatable too (SAPI fast path)', /Smith/.test(out.said) && a.cloud.length === 0, out.said);
  out = await a.sapi('radioQuiet');
  out = await a.say('repeat');
  check('an acknowledgement is never what gets repeated', /Smith/.test(out.said), out.said);

  const b = asker();
  out = await b.say('say again');
  check('nothing said yet → "Nothing to repeat."', out.said === 'Nothing to repeat.', out.said);
  out = await b.say('talk to me about fuel');
  check('"talk to me about fuel" is a fuel question, not a control', /fuel|litre|laps/i.test(out.said) && b.svc.radioQuiet === false, out.said);
  out = await b.say('say again the gap ahead');
  check('"say again the gap ahead" reads the gap', !/Nothing to repeat/.test(out.said) && b.cloud.length === 0, out.said);

  console.log('\n14) Radio controls: a new session lifts the quiet');
  const c = asker();
  c.feed(100, {});
  await c.say('radio silence');
  check('quiet on', c.svc.radioQuiet === true);
  c.feed(500, {}); // same session
  check('the same session keeps it', c.svc.radioQuiet === true);
  c.feed(100, { numCars: 31 }); // the race after qualifying
  check('a new session resets it', c.svc.radioQuiet === false);
  c.svc.radioQuiet = true;
  c.svc.stop();
  check('a pipeline restart (voice change) keeps it', c.svc.radioQuiet === true);
}

/* -------------------------------------------------------------------------- */
/*  Settings + panel                                                           */
/* -------------------------------------------------------------------------- */

function settingsAndPanel() {
  console.log('\n15) The setting is whitelisted, defaulted and wired');
  check('default is ON', DEFAULT_ENGINEER_SETTINGS.onlyStraights === true);
  check('false survives sanitize', sanitizeEngineer({ onlyStraights: false }).onlyStraights === false);
  check('true survives sanitize', sanitizeEngineer({ onlyStraights: true }).onlyStraights === true);
  check('junk falls back to the stored value', sanitizeEngineer({ onlyStraights: 'yes' }, { onlyStraights: false }).onlyStraights === false);
  check('older settings (no field) read as ON', sanitizeEngineer({ readouts: 'standard' }).onlyStraights === true);
  check('a partial patch keeps the other fields', (() => {
    const cur = sanitizeEngineer({ readouts: 'standard', volume: 70, practicePaceReminderLaps: 6 });
    const next = sanitizeEngineer({ ...cur, onlyStraights: false }, cur);
    return next.readouts === 'standard' && next.volume === 70 && next.practicePaceReminderLaps === 6 && next.onlyStraights === false;
  })());
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  check('main.js persists the engineer block through sanitizeEngineer', /next\.engineer = sanitizeEngineer\(/.test(main));
  const html = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'index.html'), 'utf8');
  const panel = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'engineer-panel.js'), 'utf8');
  check('the Engineer tab has the switch', /<input type="checkbox" id="eng-straights"/.test(html));
  check('…which says a new session lifts "keep quiet"', /so does a new\s+session/.test(html) && /"keep quiet"/.test(html));
  check('the panel persists it', /onlyStraights:\s*straights\.checked/.test(panel));
  check('the status line shows the quiet radio', /s\.radioQuiet/.test(panel));
  const labels = /const INTENT_LABELS = \{([\s\S]*?)\n  \};/.exec(panel);
  const missing = GRAMMAR.map((g) => g.intent).filter((i) => !labels || !new RegExp(`\\b${i}:`).test(labels[1]));
  check('every grammar intent has a panel label', missing.length === 0, missing.join(',') || 'all labelled');
}

/* -------------------------------------------------------------------------- */
/*  Line discipline                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Representative facts for every branch of every EXISTING kind. A new kind
 * gets the same check by adding a row — the sweep reports kinds it has no
 * facts for instead of failing on them.
 */
const LINE_FACTS = {
  raceStart: [{}],
  restart: [{}],
  fullCourseYellow: [{}],
  sectorYellow: [
    { sectors: '2' },
    { sectors: '1,3' },
    { sectors: '1,2,3', all: true },
    { sectors: '2', driver: 'Bernardo Sousa', aheadM: 850, lapM: 4600 },
    { sectors: '2', driver: 'Bernardo Sousa', aheadM: 2200, lapM: 13600 },
    { sectors: '1,2,3', all: true, causeSector: '2', driver: 'Bernardo Sousa', aheadM: 850, lapM: 4600 },
    { sectors: '1,3', driver: 'Bernardo Sousa' },
  ],
  sectorClear: [{}],
  redFlag: [{}],
  finalLap: [{}],
  checkered: [{ classPosition: 12 }, {}],
  incident: [
    { severity: 'minor' }, { severity: 'minor', repeat: true },
    { severity: 'major', repairSeconds: 45 }, { severity: 'major', repairSeconds: 45, repeat: true },
    { severity: 'critical', repairSeconds: 120 }, { severity: 'critical', repairSeconds: 120, repeat: true },
  ],
  penalty: [{}, { penaltyType: 'drive-through' }, { penaltyType: 'stop and go 10 seconds' }],
  penaltyServed: [{}],
  fuelWindow: [{ lapsLeft: 2.4 }, { lapsLeft: 2.4, budget: 'energy' }, {}],
  fuelCritical: [{}, { reason: 'energy' }],
  fastestLapSelf: [{ lapSec: 103.456 }, {}],
  fastestLapField: [{ lapSec: 103.456, name: 'Riccardo Agostini' }, { name: 'Riccardo Agostini' }],
  positionChange: [{ to: 12, gained: true }, { to: 12, gained: false }],
  rivalPitted: [{ name: 'Riccardo Agostini', where: 'ahead' }, { name: 'Riccardo Agostini', where: 'behind' }],
  pitWindowOpen: [{}],
  // Round-5 kinds (merge review, 2026-10-02): the same ≤14-word discipline.
  qualiLap: [
    { verdict: 'pb', lapSec: 99.2, classPosition: 2, multiclass: false, gainSec: 0.3 },
    { verdict: 'first', lapSec: 99.2, classPosition: 9, multiclass: true },
    { verdict: 'off', lapSec: 99.6, offSec: 0.4, classPosition: 5, samePosition: false, multiclass: true },
    { verdict: 'deleted' },
  ],
  qualiPole: [
    { name: 'Riccardo Agostini', lapSec: 98.1, wasMine: true, classPosition: 2, multiclass: true },
    { name: 'Riccardo Agostini', lapSec: 98.1, wasMine: false, classPosition: 12, multiclass: true },
  ],
  qualiBeaten: [{ from: 3, to: 5, count: 2, multiclass: true }, { from: 2, to: 3, count: 1, name: 'Riccardo Agostini', multiclass: true }],
  qualiTimeLeft: [{ verdict: 'tight', timeLeftSec: 95 }, { verdict: 'last', timeLeftSec: 50 }, { verdict: 'more', timeLeftSec: 180 }],
  qualiGrid: [{ classPosition: 6, position: 14, multiclass: true, provisional: false }, { classPosition: 6, position: 14, multiclass: true, provisional: true }],
  practiceLap: [{ verdict: 'pb', lapSec: 99.2, gainSec: 0.25 }, { verdict: 'deleted' }],
  sectorImproved: [{ sector: 2, deltaSec: -0.14, purple: false }, { sector: 1, deltaSec: -0.3, purple: true }],
  rivalStop: [
    { name: 'Riccardo Agostini', where: 'ahead', gapSec: 3.1, rejoinSec: -12.4, outcome: 'dropsBehind' },
    { name: 'Riccardo Agostini', where: 'ahead', gapSec: 3.1, rejoinSec: 7.6, outcome: 'closeAhead' },
    { name: 'Riccardo Agostini', where: 'behind', gapSec: 1.2, outcome: 'undercut' },
    { name: 'Riccardo Agostini', where: 'behind', gapSec: 1.2, outcome: 'undercut', energyLapsInHand: 3 },
    { name: 'Riccardo Agostini', where: 'ahead', gapSec: 3.1, outcome: 'fact' },
  ],
  rivalRejoin: [{ name: 'Riccardo Agostini', gapSec: 6.4, where: 'behind' }],
  yieldTo: [
    { lapping: true, sameClass: true, name: 'Riccardo Agostini', gapSec: 12.4 },
    { lapping: true },
    { name: 'Riccardo Agostini', gapSec: 2.4 },
    {},
  ],
  practicePace: [
    { reason: 'first', lapSec: 103.4, band: 'Competitive', deltaAlienSec: 1.2, deltaCompetitiveSec: 0.4 },
    { reason: 'band-improved', lapSec: 103.4, band: 'Competitive', deltaAlienSec: 1.2, deltaCompetitiveSec: -0.1 },
    { reason: 'periodic', lapSec: 103.4, band: 'Midpack', deltaAlienSec: 2.2, deltaCompetitiveSec: 1.4 },
    { reason: 'periodic', lapSec: 103.4, band: 'Alien', deltaAlienSec: 0 },
  ],
};

function lineDiscipline() {
  console.log(`\n16) Line discipline: every bank line ≤ ${phrases.MAX_SPOKEN_WORDS} spoken words`);
  check('the helper is exported for future kinds', typeof phrases.spokenWordCount === 'function' && typeof phrases.lineTooLong === 'function');
  check('dashes are not words', phrases.spokenWordCount('Contact — minor damage, keep going.') === 5);
  const ctxFrame = { standings: [{ isPlayer: true, bestLapSec: 102.345 }] };
  const tooLong = [];
  let lines = 0;
  for (const [kind, list] of Object.entries(LINE_FACTS)) {
    for (const facts of list) {
      for (const tone of phrases.RADIO_TONES) {
        for (let v = 0; v < 6; v++) {
          const cue = cueOf(kind, facts);
          cue.context.classPosition = 12;
          cue.context.numCars = 24;
          const t = phrases.phraseForCue(cue, ctxFrame, v, tone);
          if (!t) continue;
          lines++;
          if (phrases.lineTooLong(t)) tooLong.push(`${tone} ${phrases.spokenWordCount(t)}: ${t}`);
        }
      }
    }
  }
  check(`${lines} rendered lines across ${Object.keys(LINE_FACTS).length} kinds, none over the limit`, tooLong.length === 0, tooLong.join(' || ') || 'all short');
  // Addons ride on a lead line; they stay a single short clause.
  const addonLens = ['penalty', 'incident', 'fuelCritical'].map((k) => {
    const cue = cueOf('positionChange', { to: 6, gained: true });
    cue.triggers.push({ kind: k, atMs: 0, priority: 0, detail: k, facts: {} });
    const base = phrases.phraseForCue(cueOf('positionChange', { to: 6, gained: true }), null, 0);
    return phrases.spokenWordCount(phrases.phraseForCue(cue, null, 0)) - phrases.spokenWordCount(base);
  });
  check('addons are ≤ 7 words', addonLens.every((n) => n > 0 && n <= 7), addonLens.join(','));
  const unswept = Object.keys(TRIGGER_TIERS).filter((k) => !LINE_FACTS[k]);
  if (unswept.length) console.log(`  INFO  no line facts yet for: ${unswept.join(', ')} — add a row to LINE_FACTS`);
}

/* "Mature radio": the engineer may swear at a mistake, and only at a mistake. */
async function matureRadio() {
  console.log('\nM) Mature radio: roasts ride on the facts, never on a safety call');
  check('default is clean', DEFAULT_ENGINEER_SETTINGS.radioTone === 'clean');
  check('banter / savage survive sanitize', sanitizeEngineer({ radioTone: 'banter' }).radioTone === 'banter' && sanitizeEngineer({ radioTone: 'savage' }).radioTone === 'savage');
  check('junk falls back to the stored value', sanitizeEngineer({ radioTone: 'filthy' }, { radioTone: 'banter' }).radioTone === 'banter');
  check('older settings (no field) read as clean', sanitizeEngineer({ readouts: 'standard' }).radioTone === 'clean');
  check('the settings list matches the phrasebook', JSON.stringify(require('../electron/engineer-settings').RADIO_TONES) === JSON.stringify(phrases.RADIO_TONES));

  const say = (kind, facts, tone, v = 0) => phrases.phraseForCue(cueOf(kind, facts), null, v, tone);
  const swears = /fuck|shit|twat|bloody|hell|crap|daft|stupid|brilliant|lovely|cheers|asleep|marvellous|nan's/i;
  // Clean is the old radio, word for word.
  const sweep = Object.entries(LINE_FACTS).flatMap(([k, list]) => list.map((f) => [k, f]));
  const changed = sweep.filter(([k, f]) => [0, 1, 2].some((v) => say(k, f, 'clean', v) !== phrases.phraseForCue(cueOf(k, f), null, v)));
  check('clean = the line without a tone, every kind', changed.length === 0, changed.map(([k]) => k).join(',') || 'identical');

  // The three mistakes get roasted, and keep every fact.
  for (const tone of ['banter', 'savage']) {
    const lines = [0, 1, 2].map((v) => [
      say('incident', { severity: 'minor' }, tone, v),
      say('incident', { severity: 'major', repairSeconds: 45 }, tone, v),
      say('incident', { severity: 'critical', repairSeconds: 120 }, tone, v),
      say('penalty', { penaltyType: 'drive-through' }, tone, v),
      say('positionChange', { to: 12, gained: false }, tone, v),
    ]);
    const clean = [0, 1, 2].map((v) => [
      say('incident', { severity: 'minor' }, 'clean', v),
      say('incident', { severity: 'major', repairSeconds: 45 }, 'clean', v),
      say('incident', { severity: 'critical', repairSeconds: 120 }, 'clean', v),
      say('penalty', { penaltyType: 'drive-through' }, 'clean', v),
      say('positionChange', { to: 12, gained: false }, 'clean', v),
    ]);
    const same = lines.flat().filter((t, i) => t === clean.flat()[i]);
    check(`${tone}: every mistake line differs from the clean one`, same.length === 0, same.join(' | ') || 'all');
    check(`${tone}: severity, repair time, penalty and place survive`, lines.every(([mi, ma, cr, pe, pc]) =>
      /minor/i.test(mi) && /major/i.test(ma) && /45 seconds/.test(ma) && /critical/i.test(cr) && /120 seconds/.test(cr) && /drive-through/.test(pe) && /P12\b/.test(pc)));
  }
  check('savage swears properly, banter never does', [0, 1, 2].some((v) => /fuck/.test(say('incident', { severity: 'minor' }, 'savage', v))) &&
    sweep.every(([k, f]) => [0, 1, 2].every((v) => !/fuck|shit|twat/i.test(say(k, f, 'banter', v) || ''))));
  check('a gained place is not roasted', say('positionChange', { to: 6, gained: true }, 'savage') === say('positionChange', { to: 6, gained: true }, 'clean'));

  // Safety and everything else: the same words whatever the tone.
  const notMistakes = sweep.filter(([k, f]) => !['incident', 'penalty'].includes(k) && !(k === 'positionChange' && f.gained === false));
  const touched = notMistakes.filter(([k, f]) => [0, 1, 2].some((v) => say(k, f, 'savage', v) !== say(k, f, 'clean', v)));
  check('flags, fuel, blue flags and the rest are never roasted', touched.length === 0, touched.map(([k]) => k).join(',') || `${notMistakes.length} fact sets clean`);

  // A must-not-miss addon keeps the clean wording, so it still fits the line.
  const both = cueOf('incident', { severity: 'minor' });
  both.triggers.push({ kind: 'fuelCritical', atMs: 0, priority: 70, detail: 'fuelCritical', facts: {} });
  check('damage + box this lap stays clean', phrases.phraseForCue(both, null, 0, 'savage') === phrases.phraseForCue(both, null, 0, 'clean'));

  // The service: the setting reaches the radio; "keep quiet" gets it clean.
  const r = service({ radioTone: 'savage' });
  r.feed(3000, {});
  r.svc.onCue(cueOf('penalty', { penaltyType: 'drive-through' }), r.svc.lastFrame);
  check('savage reaches the radio', r.spoken.length === 1 && swears.test(r.spoken[0]) && /drive-through/.test(r.spoken[0]), r.spoken.join('|'));
  check('status() echoes the tone for the panel', r.svc.status().radioTone === 'savage');
  r.spoken.length = 0;
  r.svc.radioQuiet = true;
  r.advance(30_000);
  r.feed(3000, {});
  r.svc.onCue(cueOf('penalty', { penaltyType: 'drive-through' }), r.svc.lastFrame);
  check('under "keep quiet" a penalty still speaks, but clean', r.spoken.length === 1 && !swears.test(r.spoken[0]), r.spoken.join('|'));
  r.set({ radioTone: 'nonsense' });
  check('a corrupt stored tone reads as clean', r.svc.radioTone() === 'clean');

  // The free-form answers: the tone rides the cloud request only when chosen.
  const bodies = [];
  for (const tone of ['clean', 'banter']) {
    const c = service({ radioTone: tone });
    c.svc.lastFrame = frame({});
    c.svc.summaryMod = { engineerSummary: () => ({ connected: true }) };
    c.svc.cloudAsk = async (b) => {
      bodies.push(b);
      return null;
    };
    await c.svc.askTier2('how is my pace looking', 5);
  }
  check('clean sends no tone field (the old request)', !!bodies[0] && !('tone' in bodies[0]));
  check('banter sends tone: banter', !!bodies[1] && bodies[1].tone === 'banter');

  // The panel and the cloud prompt.
  const html = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'index.html'), 'utf8');
  const panel = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'engineer-panel.js'), 'utf8');
  check('the Engineer tab has the picker, Off first', /<select class="field__input" id="eng-tone">\s*<option value="clean">/.test(html));
  check('the panel persists it', /radioTone:\s*tone\.value/.test(panel));
  const fn = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'engineer', 'index.ts'), 'utf8');
  check('the cloud prompt takes the addendum only for banter / savage', /body\.tone === 'banter' \|\| body\.tone === 'savage'/.test(fn) && /SYSTEM \+ toneAddendum/.test(fn));
}

/* A traffic countdown is frozen into its words: urgent, and a 750 ms cap. */
function trafficHold() {
  console.log('\nT) Traffic countdowns never land late');
  const gate = require('../dist/telemetry/radioGate.js');
  check('trafficBehind / trafficAhead are urgent', gate.urgencyOf('trafficBehind') === 'urgent' && gate.urgencyOf('trafficAhead') === 'urgent');
  const r = service();
  r.svc.audioInFlight = 1; // the channel is busy: the line must be held
  r.svc.sayReadout('Hypercar behind, with you in about 6 seconds.', { kind: 'trafficBehind', priority: 46 });
  const h = r.svc.heldReadout;
  check('held while the channel is busy', !!h && h.kind === 'trafficBehind');
  check('…for 750 ms, not the urgent budget', !!h && h.expiresAt - h.heldAtMs === 750, h && String(h.expiresAt - h.heldAtMs));
  r.advance(800);
  r.svc.audioInFlight = 0;
  r.svc.pumpHeldReadout();
  check('…and dropped once stale, never spoken late', r.spoken.length === 0, r.spoken.join('|'));
}

radioControls()
  .then(() => {
    trafficHold();
    settingsAndPanel();
    lineDiscipline();
    return matureRadio();
  })
  .then(() => {
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
