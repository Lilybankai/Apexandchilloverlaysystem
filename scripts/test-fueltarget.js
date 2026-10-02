/**
 * scripts/test-fueltarget.js — "I want to save one lap of fuel".
 * -----------------------------------------------------------------------------
 * The fuel-saving target (src/telemetry/fuelTarget.ts): the push-to-talk
 * parse, the target math for tank-bound, energy-bound and both-close cars, the
 * per-lap report's numbers and wording, the laps that must never be reported
 * (pit lane, full-course yellow, a partial lap), the ways a target ends
 * (cancel, a stop, a session change, banked), the honest refusals — and the
 * routing: the new phrases must not steal "fuel", "fuel to the finish", "how
 * much fuel", "fuel ratio" or "energy" from their old homes.
 *
 * Run: npm run build && node scripts/test-fueltarget.js
 */

'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  parseFuelTargetAsk,
  lapReportLine,
  speakableSaveLaps,
  FuelTargetTracker,
} = require('../dist/telemetry/fuelTarget');
const { EngineerCommands } = require('../dist/telemetry/engineerCommands');
const {
  EngineerService,
  GRAMMAR,
  matchGrammarText,
  matchPositionQuery,
  radioNoise,
} = require('../electron/engineer');

const UNKNOWN = -1;

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* ---- a little car ----------------------------------------------------------- */

/**
 * A player car that drives laps. Levels are litres / percent; `veAvg` null =
 * a car with no virtual energy. Every frame carries the averages the fuel
 * widget would show — the tracker reads them only when a target is set.
 */
function makeCar({ fuel = 72.59, fuelAvg = 3.81, ve = null, veAvg = null, track = 'Test Ring', lapsToFinish, rounded = false } = {}) {
  const st = {
    fuel, ve, lap: 0, frac: 0.0, inPit: false, pitStops: 0, phase: 'green', driver: 'Carl Jones', track, type: 'race',
  };
  const frame = () => {
    const f = {
      // `rounded`: what the real calculator publishes — 0.1 L for the widgets,
      // the millilitre in levelLitersExact.
      levelLiters: rounded ? Math.round(st.fuel * 10) / 10 : st.fuel,
      ...(rounded ? { levelLitersExact: Math.round(st.fuel * 1000) / 1000 } : {}),
      capacityLiters: 100,
      perLapAvgLiters: fuelAvg,
      lapsRemaining: fuelAvg > 0 ? st.fuel / fuelAvg : UNKNOWN,
      lapsToFinish: lapsToFinish === undefined ? UNKNOWN : lapsToFinish,
      fuelToFinishLiters: UNKNOWN,
      fuelDeltaLiters: UNKNOWN,
      refuelToFinishLiters: 0,
    };
    if (st.ve !== null) {
      f.virtualEnergyPct = rounded ? Math.round(st.ve * 10) / 10 : st.ve;
      if (veAvg) {
        f.virtualEnergyPerLapPct = veAvg;
        f.virtualEnergyLapsRemaining = st.ve / veAvg;
      }
    }
    return {
      schemaVersion: 1,
      source: 'test',
      timestamp: 0,
      connected: true,
      session: { track: st.track, type: st.type, numCars: 2, phase: st.phase, currentLap: st.lap + 1 },
      player: {},
      standings: [
        {
          slotId: 1, position: 1, driverName: st.driver, isPlayer: true, lapsCompleted: st.lap,
          lapFraction: st.frac, inPit: st.inPit, pitStops: st.pitStops, lastLapSec: 100, bestLapSec: 100,
          ...(rounded && st.ve !== null ? { virtualEnergy: st.ve / 100 } : {}),
        },
        { slotId: 2, position: 2, driverName: 'Anna Smith', isPlayer: false, lapsCompleted: st.lap, inPit: false, lastLapSec: 101 },
      ],
      relative: [],
      weather: {},
      fuel: f,
    };
  };
  return {
    st,
    frame,
    /** Drive one whole lap: the line frame, a mid-lap frame, the next line. */
    lap(sink, burnFuel, burnVe = 0, opts = {}) {
      st.frac = 0.5;
      if (opts.pitMid) st.inPit = true;
      if (opts.fcyMid) st.phase = 'fullCourseYellow';
      st.fuel -= burnFuel / 2;
      if (st.ve !== null) st.ve -= burnVe / 2;
      sink(frame());
      if (opts.pitMid) st.inPit = false;
      if (opts.fcyMid) st.phase = 'green';
      st.fuel -= burnFuel / 2;
      if (st.ve !== null) st.ve -= burnVe / 2;
      st.lap += 1;
      st.frac = 0.0;
      sink(frame());
    },
    /** Move round the current lap without crossing the line (no burn). */
    at(sink, frac) {
      st.frac = frac;
      sink(frame());
    },
  };
}

/** A tracker with two clean laps of history on the given car, sitting just past the line. */
function warmed(opts) {
  const t = new FuelTargetTracker();
  const car = makeCar(opts);
  const feed = (f) => t.update(f);
  feed(car.frame()); // first look AT the line → anchors cleanly
  car.lap(feed, opts && opts.fuelAvg ? opts.fuelAvg : 3.81, opts && opts.veAvg ? opts.veAvg : 0);
  car.lap(feed, opts && opts.fuelAvg ? opts.fuelAvg : 3.81, opts && opts.veAvg ? opts.veAvg : 0);
  car.at(feed, 0.05);
  return { t, car, feed };
}

/* ========================================================================== */
console.log('\n1) Parsing what the driver said');
/* ========================================================================== */
{
  const SET = [
    ['save one lap', 1],
    ['Save a lap.', 1],
    ['save a lap of fuel', 1],
    ['I want to save one lap of fuel.', 1],
    ['save 1 lap', 1],
    ['save two laps', 2],
    ['Save 2 laps', 2],
    ['save half a lap', 0.5],
    ['save 0.5 laps', 0.5],
    ['save 1.5 laps', 1.5],
    ['save a lap and a half', 1.5],
    ['save one and a half laps', 1.5],
    ['we need to save another lap', 1],
    ['stretch the stint by a lap', 1],
    ['safe one lap', 1], // whisper's mishear of "save"
  ];
  for (const [q, n] of SET) {
    const p = parseFuelTargetAsk(q);
    check(`"${q}" -> set ${n}`, p && p.kind === 'set' && p.laps === n && !p.budget, JSON.stringify(p));
  }
  const e = parseFuelTargetAsk('save one lap of energy');
  check('"save one lap of energy" -> set 1, energy', e && e.kind === 'set' && e.laps === 1 && e.budget === 'energy', JSON.stringify(e));
  const ve = parseFuelTargetAsk('can we save a lap on VE');
  check('"…on VE" -> energy', ve && ve.budget === 'energy', JSON.stringify(ve));

  for (const q of ['fuel target', "what's my target?", 'am I on target', 'energy target', 'saving target', "how's the saving going"]) {
    const p = parseFuelTargetAsk(q);
    check(`"${q}" -> read`, p && p.kind === 'read', JSON.stringify(p));
  }
  for (const q of ['cancel fuel target', 'stop saving', 'target off', 'fuel target off', 'cancel target', 'clear the target', 'no more saving', 'Stop the fuel saving.']) {
    const p = parseFuelTargetAsk(q);
    check(`"${q}" -> cancel`, p && p.kind === 'cancel', JSON.stringify(p));
  }
  for (const q of [
    'fuel', 'fuel to the finish', 'how much fuel', 'how much fuel do I need to put in', 'fuel ratio',
    'energy', "how's my energy", 'virtual energy', 'enough fuel', 'should I save fuel',
    'how many laps can I save', 'last lap', 'gap ahead', "what's the alien pace target",
    'what is the pace target', '', 'save the setup',
  ]) {
    check(`"${q}" -> not a fuel-target ask`, parseFuelTargetAsk(q) === null, JSON.stringify(parseFuelTargetAsk(q)));
  }

  // Every phrase the SAPI grammar carries for the new intents parses to that
  // intent (the fast path hands SAPI's text to the parser), and no phrase of
  // any OTHER intent is claimed by it.
  const KIND = { fuelSave: 'set', fuelTarget: 'read', fuelTargetOff: 'cancel' };
  const wrong = [];
  for (const g of GRAMMAR) {
    for (const ph of g.phrases) {
      const p = parseFuelTargetAsk(ph);
      const want = KIND[g.intent] || null;
      if ((p ? p.kind : null) !== want) wrong.push(`${g.intent}:"${ph}"->${p ? p.kind : 'null'}`);
    }
  }
  check('grammar phrases parse to their own intent, and only theirs', wrong.length === 0, wrong.join(' ') || 'all consistent');
  check('every save phrase carries a lap count',
    GRAMMAR.find((g) => g.intent === 'fuelSave').phrases.every((ph) => parseFuelTargetAsk(ph).laps > 0));

  check('speakable: half a lap', speakableSaveLaps(0.5) === 'half a lap');
  check('speakable: a lap', speakableSaveLaps(1) === 'a lap');
  check('speakable: a lap and a half', speakableSaveLaps(1.5) === 'a lap and a half');
  check('speakable: two laps', speakableSaveLaps(2) === 'two laps');
  check('speakable: two and a half laps', speakableSaveLaps(2.5) === 'two and a half laps');
}

/* ========================================================================== */
console.log('\n2) Routing — ask() order: noise, fuel target, position, phrase list');
/* ========================================================================== */
{
  const route = (q) => {
    const noise = radioNoise(q, []);
    if (noise) return noise;
    const ft = parseFuelTargetAsk(q);
    if (ft) return `fuelTarget:${ft.kind}`;
    if (matchPositionQuery(q)) return 'position';
    return matchGrammarText(q) || 'cloud';
  };
  const ROUTES = [
    // Old homes that must hold.
    ['fuel', 'fuel'],
    ['fuel to the finish', 'fuel'],
    ['Fuel to the end?', 'fuel'],
    ['how much fuel', 'fuel'],
    ['fuel state', 'fuel'],
    ['enough fuel', 'fuel'],
    ['fuel ratio', 'fuelRatio'],
    ['energy', 'energy'],
    ["how's my energy", 'energy'],
    ['virtual energy', 'energy'],
    ['pit window', 'pitWindow'],
    ['last lap', 'lastLap'],
    ['how many laps', 'lapsLeft'],
    ['what is alien pace', 'paceAlien'],
    // The new asks.
    ['I want to save one lap of fuel', 'fuelTarget:set'],
    ['save one lap', 'fuelTarget:set'],
    ['save 2 laps', 'fuelTarget:set'],
    ['save half a lap', 'fuelTarget:set'],
    ['save one lap of energy', 'fuelTarget:set'],
    ['fuel target', 'fuelTarget:read'],
    ["what's my target", 'fuelTarget:read'],
    ['cancel fuel target', 'fuelTarget:cancel'],
    ['stop saving', 'fuelTarget:cancel'],
    ['target off', 'fuelTarget:cancel'],
  ];
  for (const [q, want] of ROUTES) {
    const got = route(q);
    check(`route "${q}" -> ${want}`, got === want, got);
  }
  // If the parser were ever bypassed, the phrase list still lands the new
  // phrases on the new intents (longest needle beats the 'fuel' stem).
  check('phrase list: "save one lap of fuel" -> fuelSave', matchGrammarText('save one lap of fuel') === 'fuelSave');
  check('phrase list: "save one lap of energy" -> fuelSave', matchGrammarText('save one lap of energy') === 'fuelSave');
  check('phrase list: "fuel target off" -> fuelTargetOff', matchGrammarText('fuel target off') === 'fuelTargetOff');
  check('phrase list: "cancel fuel target" -> fuelTargetOff', matchGrammarText('cancel fuel target') === 'fuelTargetOff');
  check('phrase list: "fuel target" -> fuelTarget', matchGrammarText('fuel target') === 'fuelTarget');
  check('phrase list: "fuel" still -> fuel', matchGrammarText('fuel') === 'fuel');
}

/* ========================================================================== */
console.log('\n3) Refusals — never a target without enough data');
/* ========================================================================== */
{
  const t = new FuelTargetTracker();
  let r = t.set(1);
  check('no frame -> "No telemetry yet."', !r.ok && r.text === 'No telemetry yet.', r.text);

  // The widget already shows an average, but the tracker has watched no lap.
  const car = makeCar();
  t.update(car.frame());
  r = t.set(1);
  check('no watched burn -> "Need a couple of laps of burn first."', !r.ok && r.text === 'Need a couple of laps of burn first.', r.text);
  car.lap((f) => t.update(f), 3.81);
  r = t.set(1);
  check('one lap is not a couple', !r.ok && /couple of laps/.test(r.text), r.text);
  check('…and nothing armed', !t.isActive);

  const noAvg = new FuelTargetTracker();
  const car2 = makeCar({ fuelAvg: UNKNOWN });
  noAvg.update(car2.frame());
  car2.lap((f) => noAvg.update(f), 3.8);
  car2.lap((f) => noAvg.update(f), 3.8);
  r = noAvg.set(1);
  check('no published average -> refuses', !r.ok && /couple of laps/.test(r.text), r.text);

  let w = warmed();
  r = w.t.set(10);
  check('ten laps -> refuses (that is a stop)', !r.ok && /most I'll plan/.test(r.text), r.text);
  r = w.t.set(1, 'energy');
  check('energy asked on a car without it -> "No virtual energy on this car."', !r.ok && r.text === 'No virtual energy on this car.', r.text);

  w = warmed();
  w.car.st.inPit = true;
  w.feed(w.car.frame());
  r = w.t.set(1);
  check('in the pit lane -> ask once back out', !r.ok && /back out on track/.test(r.text), r.text);

  w = warmed({ fuel: 10 });
  w.car.st.fuel = 2.5;
  w.feed(w.car.frame());
  r = w.t.set(1);
  check('under a lap left -> nothing to stretch', !r.ok && /Under a lap left/.test(r.text), r.text);
}

/* ========================================================================== */
console.log('\n4) The target math');
/* ========================================================================== */
{
  // Tank-bound, no virtual energy: 72.59 L at 3.81 covers 19.05 laps; save
  // one → 20.05; 72.59 / 20.05 = 3.62.
  let w = warmed({ fuel: 72.59 + 2 * 3.81 });
  let level = w.car.st.fuel;
  let L = level / 3.81;
  let r = w.t.set(1);
  check('tank-bound: target 3.62 litres', r.ok && /target 3\.62 litres a lap — you're averaging 3\.81\./.test(r.text), r.text);
  check('…the stretch is said back unambiguously',
    r.text.includes(`stretches the stint from ${L.toFixed(1)} laps to ${(L + 1).toFixed(1)}`), r.text);
  check('…no "limit" lead on a car with one budget', /^To save a lap/.test(r.text), r.text);
  check('…the lap in progress counts (set just past the line)', !/First reading/.test(r.text), r.text);
  check('…the formula: B / (B/a + N)', Math.abs(level / (level / 3.81 + 1) - 3.62) < 0.005, String(level / (level / 3.81 + 1)));

  // Half a lap, two laps.
  w = warmed({ fuel: 72.59 + 2 * 3.81 });
  level = w.car.st.fuel;
  r = w.t.set(0.5);
  check('half a lap', r.ok && r.text.includes(`To save half a lap, target ${(level / (level / 3.81 + 0.5)).toFixed(2)} litres`), r.text);
  r = w.t.set(2);
  check('two laps (a new ask replaces the old)', r.ok && r.text.includes(`To save two laps, target ${(level / (level / 3.81 + 2)).toFixed(2)} litres`), r.text);

  // Energy-bound: 70 L at 3.50 covers 20.0; 62 % at 3.40 covers 18.24.
  // Stint 18.24, goal 19.24; energy 62 / 19.24 = 3.22; the tank covers 20 ≥ 19.24.
  w = warmed({ fuel: 70 + 2 * 3.5, fuelAvg: 3.5, ve: 62 + 2 * 3.4, veAvg: 3.4 });
  r = w.t.set(1);
  check('energy-bound: "Energy\'s the limit."', r.ok && /^Energy's the limit\./.test(r.text), r.text);
  check('…target 3.22 percent, averaging 3.40', /target 3\.22 percent a lap — you're averaging 3\.40\./.test(r.text), r.text);
  check('…no fuel target', !/litres/.test(r.text), r.text);
  check('…stint 18.2 -> 19.2', /from 18\.2 laps to 19\.2\./.test(r.text), r.text);

  // "of energy" named explicitly: same plan.
  r = w.t.set(1, 'energy');
  check('"save one lap of energy" on an energy-bound car -> same energy target', /target 3\.22 percent/.test(r.text), r.text);

  // Tank-bound with energy present: "Fuel's the limit."
  w = warmed({ fuel: 60 + 2 * 3.5, fuelAvg: 3.5, ve: 80 + 2 * 3.4, veAvg: 3.4 });
  r = w.t.set(1);
  check('tank-bound with energy aboard: "Fuel\'s the limit."', /^Fuel's the limit\./.test(r.text) && /litres a lap/.test(r.text) && !/percent a lap/.test(r.text), r.text);

  // Both close: 66 L at 3.50 covers 18.86; 62 % at 3.40 covers 18.24. Goal
  // 19.24 is beyond BOTH, so both get a target: 66/19.24 = 3.43, 62/19.24 = 3.22.
  w = warmed({ fuel: 66 + 2 * 3.5, fuelAvg: 3.5, ve: 62 + 2 * 3.4, veAvg: 3.4 });
  r = w.t.set(1);
  check('both close: both targets', /^Fuel and energy both need it\./.test(r.text) &&
    /target 3\.43 litres and 3\.22 percent a lap — you're averaging 3\.50 and 3\.40\./.test(r.text), r.text);

  // The finish: lapsToFinish between the stint and the goal.
  w = warmed({ fuel: 72.59 + 2 * 3.81, lapsToFinish: 19.5 });
  r = w.t.set(1);
  check('goal reaches the flag -> "Hit it and you make the finish."', /Hit it and you make the finish\./.test(r.text), r.text);
  w = warmed({ fuel: 72.59 + 2 * 3.81, lapsToFinish: 12 });
  r = w.t.set(1);
  check('already enough -> "You already make the finish."', /You already make the finish\./.test(r.text), r.text);

  // A big cut is named.
  w = warmed({ fuel: 20 + 2 * 3.81 });
  r = w.t.set(1);
  check('a 16 percent cut is flagged as a big ask', /That's a 16 percent cut — a big ask\./.test(r.text), r.text);
}

/* ========================================================================== */
console.log('\n5) The per-lap report');
/* ========================================================================== */
{
  check('wording: over', lapReportLine([{ budget: 'fuel', burn: 3.7, target: 3.62 }]) ===
    '3.70 litres that lap, target 3.62 — eight hundredths over.');
  check('wording: under', lapReportLine([{ budget: 'fuel', burn: 3.58, target: 3.62 }]) ===
    '3.58 litres that lap, four hundredths under target — keep that.');
  check('wording: on', lapReportLine([{ budget: 'fuel', burn: 3.619, target: 3.62 }]) === '3.62 litres that lap — right on target.');
  check('wording: one hundredth is singular', /one hundredth over/.test(lapReportLine([{ budget: 'fuel', burn: 3.63, target: 3.62 }])));
  check('wording: a tenth+ is said as a number with the unit',
    lapReportLine([{ budget: 'energy', burn: 3.4, target: 3.22 }]) === '3.40 percent that lap, target 3.22 — 0.18 percent over.');
  check('wording: hundredths come off the ROUNDED numbers (3.704 vs 3.616 = 3.70 vs 3.62 = eight)',
    /eight hundredths over/.test(lapReportLine([{ budget: 'fuel', burn: 3.704, target: 3.616 }])));
  const two = lapReportLine([
    { budget: 'fuel', burn: 3.7, target: 3.62 },
    { budget: 'energy', burn: 3.18, target: 3.22 },
  ]);
  check('wording: both budgets, labelled', two ===
    'Fuel 3.70 litres, eight hundredths over the 3.62 target. Energy 3.18 percent, four hundredths under target.', two);

  // Live: target 3.62, laps of 3.70, 3.58, 3.62.
  const w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.t.set(1);
  check('nothing to say before a lap completes', w.t.takeReport() === null);
  w.car.lap(w.feed, 3.7);
  let rep = w.t.takeReport();
  check('lap 1: 3.70 vs 3.62 -> eight hundredths over', rep === '3.70 litres that lap, target 3.62 — eight hundredths over.', rep);
  check('a report is taken once', w.t.takeReport() === null);
  w.car.lap(w.feed, 3.58);
  rep = w.t.takeReport();
  check('lap 2: 3.58 -> four under, keep that', rep === '3.58 litres that lap, four hundredths under target — keep that.', rep);
  w.car.lap(w.feed, 3.62);
  rep = w.t.takeReport();
  // Saved = (3.81-3.70)+(3.81-3.58)+(3.81-3.62) = 0.53 L = 0.14 of a lap at 3.81.
  check('lap 3: on target + the every-third-lap saved-so-far', rep === '3.62 litres that lap — right on target. That\'s 0.1 of a lap saved so far.', rep);

  const rb = w.t.readBack();
  check('read back: target, last lap, saved', rb.ok &&
    rb.text === "Saving a lap: target 3.62 litres a lap. Last lap 3.62 litres. That's 0.1 of a lap saved so far.", rb.text);

  // Resolution: the widgets' levels are rounded to 0.1, which alone would turn
  // a 3.66 L lap into 3.60 or 3.70. The report must use the exact sources.
  const rd = warmed({ fuel: 72.59 + 2 * 3.81, rounded: true });
  rd.t.set(1);
  rd.car.lap(rd.feed, 3.66);
  rep = rd.t.takeReport();
  check('rounded widget levels: the burn still reads 3.66 (levelLitersExact)', /^3\.66 litres that lap/.test(rep || ''), rep);
  const re = warmed({ fuel: 70 + 2 * 3.5, fuelAvg: 3.5, ve: 62.04 + 2 * 3.4, veAvg: 3.4, rounded: true });
  re.t.set(1);
  re.car.lap(re.feed, 3.4, 3.27);
  rep = re.t.takeReport();
  check('rounded energy pct: the burn still reads 3.27 (player row virtualEnergy)', /^3\.27 percent that lap/.test(rep || ''), rep);

  // Energy-bound live report reads percent.
  const e = warmed({ fuel: 70 + 2 * 3.5, fuelAvg: 3.5, ve: 62 + 2 * 3.4, veAvg: 3.4 });
  e.t.set(1);
  e.car.lap(e.feed, 3.4, 3.31);
  rep = e.t.takeReport();
  check('energy-bound lap: percent, nine hundredths over 3.22', rep === '3.31 percent that lap, target 3.22 — nine hundredths over.', rep);
}

/* ========================================================================== */
console.log('\n6) Laps that are never reported');
/* ========================================================================== */
{
  // Set mid-lap: that lap is part-driven before the ask — not reported.
  let w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.car.at(w.feed, 0.6);
  let r = w.t.set(1);
  check('set mid-lap -> says when the first reading comes', /First reading at the end of the next full lap\./.test(r.text), r.text);
  w.car.st.frac = 0.6;
  // finish the lap in progress (burn only the remainder)
  w.car.st.fuel -= 1.5;
  w.car.st.lap += 1;
  w.car.st.frac = 0;
  w.feed(w.car.frame());
  check('…the partial lap is not reported', w.t.takeReport() === null);
  w.car.lap(w.feed, 3.6);
  check('…the next full lap is', /^3\.60 litres that lap/.test(w.t.takeReport() || ''));

  // A drive through the pit lane (no stop counted, no fuel in): that lap is
  // skipped, the target lives on.
  w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.t.set(1);
  w.car.lap(w.feed, 3.4, 0, { pitMid: true });
  check('pit-lane lap -> not reported', w.t.takeReport() === null);
  check('…target still live', w.t.isActive);
  w.car.lap(w.feed, 3.65);
  check('…the next clean lap is reported', /^3\.65 litres that lap/.test(w.t.takeReport() || ''));

  // A lap under full-course yellow.
  w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.t.set(1);
  w.car.lap(w.feed, 2.1, 0, { fcyMid: true });
  check('FCY lap -> not reported', w.t.takeReport() === null && w.t.isActive);
  w.car.lap(w.feed, 3.6);
  check('…green again -> reported', /^3\.60 litres that lap/.test(w.t.takeReport() || ''));
}

/* ========================================================================== */
console.log('\n7) How a target ends');
/* ========================================================================== */
{
  // Cancel.
  let w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.t.set(1);
  w.car.lap(w.feed, 3.5);
  w.t.takeReport();
  let r = w.t.cancel();
  // Saved 0.31 L at 3.81 = 0.08 of a lap → "0.1 of a lap".
  check('cancel -> "Fuel target off." + what was saved', r.ok && r.text === "Fuel target off. That's 0.1 of a lap saved so far.", r.text);
  check('…and it is off', !w.t.isActive);
  r = w.t.cancel();
  check('cancel with none -> "No fuel target to cancel."', r.text === 'No fuel target to cancel.', r.text);
  r = w.t.readBack();
  check('read back with none -> says so, and how to set one', !r.ok && /No fuel target set/.test(r.text), r.text);

  // A pit stop with fuel going in ends the stint, and the driver is told.
  w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.t.set(1);
  w.car.st.inPit = true;
  w.car.st.frac = 0.95;
  w.feed(w.car.frame());
  w.car.st.pitStops = 1;
  w.car.st.fuel += 40;
  w.feed(w.car.frame());
  check('a stop -> target cleared', !w.t.isActive);
  check('…and the driver is told', w.t.takeReport() === 'Saving target cleared — new stint. Ask again when you want one.');
  w.car.st.inPit = false;
  w.car.lap(w.feed, 3.8);
  check('…the out-lap says nothing', w.t.takeReport() === null);

  // A refuel the stop counter missed (fuel rose) ends it too.
  w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.t.set(1);
  w.car.st.fuel += 5;
  w.feed(w.car.frame());
  check('a level rise alone -> target cleared', !w.t.isActive && /new stint/.test(w.t.takeReport() || ''));

  // Session change: silent.
  w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.t.set(1);
  w.car.st.track = 'Other Ring';
  w.feed(w.car.frame());
  check('session change -> cleared silently', !w.t.isActive && w.t.takeReport() === null);
  r = w.t.set(1);
  check('…and the new session needs its own laps of burn', !r.ok && /couple of laps/.test(r.text), r.text);

  // Driver swap: silent.
  w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.t.set(1);
  w.car.st.driver = 'Someone Else';
  w.feed(w.car.frame());
  check('driver swap -> cleared silently', !w.t.isActive && w.t.takeReport() === null);

  // Chequered flag: silent.
  w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.t.set(1);
  w.car.st.phase = 'checkered';
  w.feed(w.car.frame());
  check('chequered flag -> cleared silently', !w.t.isActive && w.t.takeReport() === null);

  // Banked: save half a lap, then two laps far under the old average.
  w = warmed({ fuel: 72.59 + 2 * 3.81 });
  w.t.set(0.5);
  w.car.lap(w.feed, 2.9); // saves 0.91 L = 0.24 of a lap
  w.t.takeReport();
  w.car.lap(w.feed, 2.9); // 0.48 of a lap
  check('not banked short of the goal', w.t.isActive);
  w.car.lap(w.feed, 3.7); // +0.11 → 0.51 ≥ 0.5
  const rep = w.t.takeReport();
  check('banked -> says so and retires the target', /That's half a lap saved — target off\.$/.test(rep || '') && !w.t.isActive, rep);
}

/* ========================================================================== */
console.log('\n8) Through EngineerCommands and the engineer service');
/* ========================================================================== */
(async () => {
  {
    const eng = new EngineerCommands();
    check('askFuelTarget: not a fuel ask -> null', eng.askFuelTarget('gap ahead') === null);
    let a = eng.askFuelTarget('save one lap');
    check('askFuelTarget before telemetry -> No telemetry', a && !a.ok && a.intent === 'fuelSave' && /No telemetry/.test(a.text), a && a.text);
    const car = makeCar({ fuel: 72.59 + 2 * 3.81 });
    const feed = (f) => eng.update(f);
    feed(car.frame());
    car.lap(feed, 3.81);
    car.lap(feed, 3.81);
    car.at(feed, 0.05);
    a = eng.askFuelTarget('I want to save one lap of fuel');
    check('askFuelTarget: set -> fuelSave answer with the target', a.ok && a.intent === 'fuelSave' && /target 3\.62 litres/.test(a.text), a.text);
    a = eng.answer('fuelTarget');
    check('answer(fuelTarget) reads it back', a.ok && /^Saving a lap: target 3\.62 litres a lap\./.test(a.text), a.text);
    a = eng.answer('fuelSave');
    check('answer(fuelSave) with no number asks for one', !a.ok && /How many laps/.test(a.text), a.text);
    car.lap(feed, 3.7);
    check('takeFuelTargetReport hands over the lap line', /eight hundredths over/.test(eng.takeFuelTargetReport() || ''));
    a = eng.answer('fuelTargetOff');
    check('answer(fuelTargetOff) cancels', a.ok && /^Fuel target off\./.test(a.text), a.text);
    // The neighbours are untouched.
    a = eng.answer('fuel');
    check('the fuel intent still answers the fuel state', a.ok && /^Fuel for/.test(a.text), a.text);
  }

  // The service: the per-lap line rides the readout gate — every preset but
  // Off, and never over a driver who is busy.
  const service = (preset, { busy = false } = {}) => {
    let settings = { engineerEnabled: true, engineer: { readouts: preset } };
    const svc = new EngineerService({
      dir: path.join(os.tmpdir(), 'apex-fueltarget-test'),
      loadSettings: () => settings,
      onStatus: () => {},
      noteUsage: () => {},
    });
    svc.running = true;
    const spoken = [];
    svc.speak = (t) => spoken.push(t);
    svc.commands = new EngineerCommands();
    const car = makeCar({ fuel: 72.59 + 2 * 3.81 });
    const feed = (f) => {
      if (busy) f.player = { pedals: { brake: 0.9, throttle: 0 } };
      svc.commands.update(f);
      svc.lastFrame = f;
      svc.pumpFuelTarget();
    };
    feed(car.frame());
    car.lap(feed, 3.81);
    car.lap(feed, 3.81);
    car.at(feed, 0.05);
    return { svc, spoken, car, feed, setPreset: (p) => (settings = { ...settings, engineer: { readouts: p } }) };
  };
  for (const preset of ['essential', 'standard']) {
    const s = service(preset);
    s.svc.commands.askFuelTarget('save one lap');
    s.car.lap(s.feed, 3.7);
    check(`preset ${preset}: the lap line is spoken`, s.spoken.length === 1 && /eight hundredths over/.test(s.spoken[0]), s.spoken.join('|'));
  }
  {
    const s = service('off');
    s.svc.commands.askFuelTarget('save one lap');
    s.car.lap(s.feed, 3.7);
    check('preset off: silent', s.spoken.length === 0, s.spoken.join('|'));
  }
  {
    const s = service('essential', { busy: true });
    s.svc.commands.askFuelTarget('save one lap');
    s.car.lap(s.feed, 3.7);
    check('busy driving: held, not spoken over the braking zone',
      s.spoken.length === 0 && s.svc.heldReadout && /eight hundredths over/.test(s.svc.heldReadout.text),
      s.spoken.join('|'));
  }

  // ask(): the SAPI fast path and the whisper path both reach the parser
  // before the phrase list's 'fuel'.
  const askRig = (line, whisper) => {
    const s = service('essential');
    const { svc, spoken } = s;
    spoken.length = 0;
    svc.recognizerReady = true;
    svc.freeFormLive = true;
    svc.playChirp = () => {};
    svc.pushStatus = () => {};
    svc.recognizer = { stdin: { write: () => setImmediate(() => svc.onRecognizerLine(line)) } };
    svc.transcribeClip = async () => ({ question: whisper || '', sttMs: whisper ? 500 : null });
    return { svc, spoken };
  };
  {
    const { svc, spoken } = askRig('HEARD\tfuelSave\t0.95\tC:\\w\\a.wav\tsave two laps');
    const res = await svc.ask();
    check('SAPI "save two laps" -> two-lap target, tier1', /^To save two laps, target/.test(spoken[0] || '') && res.outcome === 'tier1', spoken.join('|'));
  }
  {
    const { svc, spoken } = askRig('FREE\tC:\\w\\b.wav\t0.4\tsave one lap of fuel', 'I want to save one lap of fuel.');
    const res = await svc.ask();
    check('whisper "I want to save one lap of fuel" -> the target, not the fuel state',
      /^To save a lap, target 3\.62 litres/.test(spoken[0] || '') && res.outcome === 'tier1', spoken.join('|'));
  }
  {
    const { svc, spoken } = askRig('HEARD\tfuel\t0.95\tC:\\w\\c.wav\tfuel');
    await svc.ask();
    check('SAPI "fuel" -> still the fuel state', /^Fuel for/.test(spoken[0] || ''), spoken.join('|'));
  }
  {
    const { svc, spoken } = askRig('FREE\tC:\\w\\d.wav\t0.4\tstop saving', 'Stop saving.');
    await svc.ask();
    check('whisper "Stop saving." -> cancel', /^No fuel target to cancel\./.test(spoken[0] || ''), spoken.join('|'));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
