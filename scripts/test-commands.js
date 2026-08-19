/**
 * scripts/test-commands.js — what the engineer answers when the driver asks.
 * -----------------------------------------------------------------------------
 * Tier 1 of the v2 race-engineer plan is the pull side: a fixed set of questions
 * ("gap ahead", "laps left", "five lap average front") answered from telemetry
 * with no model, no network and no cost. This suite proves the answers are
 * right — and, just as important, that missing data produces an honest "no
 * data" line instead of arithmetic on UNKNOWN_VALUE.
 *
 * Two modes, mirroring test-triggers.js:
 *
 *   node scripts/test-commands.js
 *       The unit suite, driven by hand-built frames.
 *
 *   node scripts/test-commands.js --replay <recording.jsonl> [--every <sec>]
 *       Walk a recorded session (scripts/record-session.js) and print what the
 *       engineer would have answered to every question, at intervals of the
 *       race clock — the tuning loop for phrasing, before any voice exists.
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const {
  EngineerCommands,
  COMMAND_INTENTS,
  speakableLapTime,
} = require('../dist/telemetry/engineerCommands');

const UNKNOWN = -1;

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* ---- frame builder -------------------------------------------------------- */

/**
 * Minimal frame carrying only what engineerCommands reads. `sessionKeyOf` needs
 * source/track/type/numCars; everything else is per-check.
 */
function frame(over) {
  const base = {
    schemaVersion: 1,
    source: 'test',
    timestamp: 0,
    connected: true,
    session: {
      track: 'Test Ring',
      type: 'race',
      numCars: 3,
      phase: 'green',
      timeRemainingSec: UNKNOWN,
      totalLaps: 0,
      lapsRemaining: UNKNOWN,
      currentLap: 5,
    },
    player: {},
    standings: [],
    relative: [],
    weather: {},
    fuel: {
      levelLiters: UNKNOWN,
      capacityLiters: UNKNOWN,
      perLapAvgLiters: UNKNOWN,
      lapsRemaining: UNKNOWN,
      lapsToFinish: UNKNOWN,
      fuelToFinishLiters: UNKNOWN,
      fuelDeltaLiters: UNKNOWN,
      refuelToFinishLiters: 0,
    },
  };
  const merged = { ...base, ...over };
  merged.session = { ...base.session, ...(over && over.session) };
  merged.fuel = { ...base.fuel, ...(over && over.fuel) };
  return merged;
}

function car(slotId, over) {
  return {
    slotId,
    position: slotId,
    driverName: `Driver ${slotId}`,
    isPlayer: false,
    gapToLeaderSec: UNKNOWN,
    bestLapSec: UNKNOWN,
    lastLapSec: UNKNOWN,
    lapsCompleted: 0,
    ...over,
  };
}

/** Three-car GT3 field: leader Smith, player Jones P2, Brown P3. */
function gt3Field(over) {
  const [a, b, c] = over || [{}, {}, {}];
  return [
    car(1, {
      position: 3, // overall pos differs from class pos on purpose
      driverName: 'Anna Smith',
      carClass: 'GT3',
      classPosition: 1,
      gapToClassLeaderSec: 0,
      classLapsBehind: 0,
      ...a,
    }),
    car(2, {
      position: 4,
      driverName: 'Carl Jones',
      isPlayer: true,
      carClass: 'GT3',
      classPosition: 2,
      gapToClassLeaderSec: 2.4,
      classLapsBehind: 0,
      ...b,
    }),
    car(3, {
      position: 5,
      driverName: 'Bo Brown',
      carClass: 'GT3',
      classPosition: 3,
      gapToClassLeaderSec: 7.9,
      classLapsBehind: 0,
      ...c,
    }),
  ];
}

/* ---- replay mode ---------------------------------------------------------- */

const argv = process.argv.slice(2);
const replayAt = argv.indexOf('--replay');
if (replayAt !== -1) {
  const file = argv[replayAt + 1];
  if (!file || !fs.existsSync(file)) {
    console.error('usage: node scripts/test-commands.js --replay <recording.jsonl> [--every <sec>]');
    process.exit(2);
  }
  const everyIdx = argv.indexOf('--every');
  const everySec = everyIdx === -1 ? 120 : Number(argv[everyIdx + 1]);
  replay(file, everySec).then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
} else {
  unit();
}

async function replay(file, everySec) {
  const eng = new EngineerCommands();
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  let first = 0;
  let nextAsk = 0;
  let frames = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      continue;
    }
    frames++;
    if (!first) {
      first = f.timestamp;
      nextAsk = f.timestamp;
    }
    eng.update(f);
    if (f.timestamp >= nextAsk) {
      const clock = ((f.timestamp - first) / 1000).toFixed(0);
      console.log(`\n== race clock +${clock}s ==`);
      for (const intent of COMMAND_INTENTS) {
        const a = eng.answer(intent);
        console.log(`  ${intent.padEnd(9)} ${a.ok ? ' ' : '·'} ${a.text}`);
      }
      nextAsk = f.timestamp + everySec * 1000;
    }
  }
  console.log(`\n${frames} frames replayed from ${file}`);
}

/* ---- unit suite ----------------------------------------------------------- */

function unit() {
  const eng = new EngineerCommands();

  // Nothing fed yet: every intent refuses politely.
  for (const intent of COMMAND_INTENTS) {
    const a = eng.answer(intent);
    check(`${intent}: no telemetry -> refuses`, a.ok === false && /No telemetry/.test(a.text), a.text);
  }

  // -- speakableLapTime ------------------------------------------------------
  check('speakableLapTime: sub-minute keeps unit', speakableLapTime(43.42) === '43.4 seconds', speakableLapTime(43.42));
  check('speakableLapTime: minutes drop unit', speakableLapTime(103.42) === '1 43.4', speakableLapTime(103.42));
  check('speakableLapTime: pads o-clock seconds', speakableLapTime(63.4) === '1 oh 3.4', speakableLapTime(63.4));

  // -- gaps ------------------------------------------------------------------
  eng.update(frame({ standings: gt3Field() }));
  let a = eng.answer('gapAhead');
  check('gapAhead: class gap to Smith', a.ok && /2\.4 seconds/.test(a.text) && /Smith/.test(a.text), a.text);
  a = eng.answer('gapBehind');
  check('gapBehind: class gap to Brown', a.ok && /5\.5 seconds/.test(a.text) && /Brown/.test(a.text), a.text);

  // Player leads the class.
  eng.update(
    frame({
      standings: gt3Field([
        { classPosition: 2, gapToClassLeaderSec: 2.4 },
        { classPosition: 1, gapToClassLeaderSec: 0 },
        {},
      ]),
    }),
  );
  a = eng.answer('gapAhead');
  check('gapAhead: class leader', a.ok && /leading the class/.test(a.text), a.text);

  // Lapped neighbour: the whole-laps difference is spoken.
  eng.update(
    frame({
      standings: gt3Field([{ classLapsBehind: 0 }, { classLapsBehind: 1 }, {}]),
    }),
  );
  a = eng.answer('gapAhead');
  check('gapAhead: lapped -> says laps', a.ok && /1 lap and/.test(a.text), a.text);

  // No class gap chain -> falls back to on-track relative.
  eng.update(
    frame({
      standings: [car(9, { isPlayer: true, position: 2 })],
      relative: [
        { slotId: 4, position: 1, driverName: 'Max Power', relativeGapSec: 1.2 },
        { slotId: 9, position: 2, driverName: 'Me', relativeGapSec: 0 },
        { slotId: 5, position: 3, driverName: 'Slow Joe', relativeGapSec: -0.8 },
      ],
    }),
  );
  a = eng.answer('gapAhead');
  check('gapAhead: relative fallback', a.ok && /on track/.test(a.text) && /1\.2 seconds/.test(a.text) && /Power/.test(a.text), a.text);
  a = eng.answer('gapBehind');
  check('gapBehind: relative fallback', a.ok && /0\.8 seconds/.test(a.text) && /Joe/.test(a.text), a.text);

  // -- rolling five-lap average ---------------------------------------------
  const eng2 = new EngineerCommands();
  // Six laps: window must keep the last five. Smith laps 100..105, Jones 101..106.
  for (let i = 0; i < 6; i++) {
    eng2.update(
      frame({
        standings: gt3Field([
          { lastLapSec: 100 + i },
          { lastLapSec: 101 + i },
          {},
        ]),
      }),
    );
    // A second frame with the same lastLap must NOT double-count the lap.
    eng2.update(
      frame({
        standings: gt3Field([
          { lastLapSec: 100 + i },
          { lastLapSec: 101 + i },
          {},
        ]),
      }),
    );
  }
  a = eng2.answer('avgAhead');
  // Last five of 100..105 avg 103 -> "1 43.0"; player 104 -> "1 44.0"; diff 1.0.
  check('avgAhead: five-lap window', a.ok && /Last 5 laps/.test(a.text) && /1 43\.0/.test(a.text) && /1 44\.0/.test(a.text), a.text);
  check('avgAhead: verdict names quicker car', /Smith is 1\.0 quicker/.test(a.text), a.text);

  // Not enough data on a fresh session.
  const eng3 = new EngineerCommands();
  eng3.update(frame({ standings: gt3Field() }));
  a = eng3.answer('avgAhead');
  check('avgAhead: no laps -> refuses', a.ok === false && /Not enough laps/.test(a.text), a.text);

  // A session change clears the windows.
  eng2.update(
    frame({
      session: { track: 'Other Ring' },
      standings: gt3Field(),
    }),
  );
  a = eng2.answer('avgAhead');
  check('avgAhead: session change resets windows', a.ok === false, a.text);

  // -- car ahead / behind: who + their pace -----------------------------------
  const engCar = new EngineerCommands();
  for (let i = 0; i < 3; i++) {
    engCar.update(
      frame({
        standings: gt3Field([
          { lastLapSec: 104 + i },
          { lastLapSec: 105 + i },
          { lastLapSec: 106 + i },
        ]),
      }),
    );
  }
  a = engCar.answer('carAhead');
  check(
    'carAhead: name, gap and pace',
    a.ok && /Ahead is Smith, 2\.4 seconds/.test(a.text) && /Last lap 1 46\.0/.test(a.text) && /averaging 1 45\.0 over 3/.test(a.text),
    a.text,
  );
  a = engCar.answer('carBehind');
  check(
    'carBehind: name, gap and pace',
    a.ok && /Behind is Brown, 5\.5 seconds/.test(a.text) && /Last lap 1 48\.0/.test(a.text),
    a.text,
  );
  // Class leader has nobody ahead; no lap data yet says so honestly.
  const engCar2 = new EngineerCommands();
  engCar2.update(
    frame({
      standings: gt3Field([
        { classPosition: 2, gapToClassLeaderSec: 2.4 },
        { classPosition: 1, gapToClassLeaderSec: 0 },
        {},
      ]),
    }),
  );
  a = engCar2.answer('carAhead');
  check('carAhead: class leader', a.ok && /nobody ahead/.test(a.text), a.text);
  a = engCar2.answer('carBehind');
  check('carBehind: no lap time yet', a.ok && /No lap time on him yet/.test(a.text), a.text);

  // -- traffic ----------------------------------------------------------------
  const rel = (over) => ({
    slotId: 99,
    position: 9,
    driverName: 'Tail Ender',
    relativeGapSec: 3.1,
    lapsDifference: -1,
    inPit: false,
    isPlayer: false,
    ...over,
  });
  const engT = new EngineerCommands();
  engT.update(frame({ relative: [rel({ trafficAhead: true, closingRateSec: 0.2 })] }));
  a = engT.answer('traffic');
  check(
    'traffic: backmarker ahead, closing',
    a.ok && /Backmarker ahead — Ender, 3\.1 seconds — you're closing/.test(a.text),
    a.text,
  );
  engT.update(
    frame({
      relative: [
        rel({ trafficAhead: true, relativeGapSec: 6.0, driverName: 'Far One' }),
        rel({ slotId: 98, trafficAhead: true, relativeGapSec: 2.2, driverName: 'Near One' }),
        rel({ slotId: 97, yieldTo: true, relativeGapSec: -4.0, driverName: 'Hyper Car' }),
      ],
    }),
  );
  a = engT.answer('traffic');
  check(
    'traffic: multiple + mirrors warning',
    a.ok && /2 backmarkers ahead\. Nearest One, 2\.2 seconds/.test(a.text) && /watch your mirrors/.test(a.text),
    a.text,
  );
  engT.update(
    frame({ relative: [rel({ yieldTo: true, relativeGapSec: -1.8, driverName: 'Blue Flag' })] }),
  );
  a = engT.answer('traffic');
  check(
    'traffic: faster car behind only',
    a.ok && /No backmarkers ahead\. Flag is 1\.8 seconds behind/.test(a.text) && /blue flags/.test(a.text),
    a.text,
  );
  engT.update(frame({ relative: [rel({})] }));
  a = engT.answer('traffic');
  check('traffic: nearby cars but none flagged', a.ok && /clear road/.test(a.text), a.text);
  engT.update(frame({ relative: [] }));
  a = engT.answer('traffic');
  check('traffic: nobody around -> refuses', a.ok === false, a.text);

  // -- laps left -------------------------------------------------------------
  const eng4 = new EngineerCommands();
  eng4.update(frame({ session: { totalLaps: 20, currentLap: 15 } }));
  a = eng4.answer('lapsLeft');
  check('lapsLeft: lap-based', a.ok && /6 laps to go/.test(a.text), a.text);
  eng4.update(frame({ session: { totalLaps: 20, currentLap: 20 } }));
  a = eng4.answer('lapsLeft');
  check('lapsLeft: final lap', a.ok && /last lap/.test(a.text), a.text);
  eng4.update(frame({ session: { totalLaps: 0, currentLap: 8, timeRemainingSec: 43 * 60, lapsRemaining: 22 } }));
  a = eng4.answer('lapsLeft');
  check('lapsLeft: timed with estimate', a.ok && /43 minutes left, about 22 laps/.test(a.text), a.text);
  eng4.update(frame({ session: { totalLaps: 0, currentLap: 8 } }));
  a = eng4.answer('lapsLeft');
  check('lapsLeft: nothing known -> refuses', a.ok === false, a.text);

  // -- fuel ------------------------------------------------------------------
  const eng5 = new EngineerCommands();
  eng5.update(frame({ fuel: { lapsRemaining: 14.2, lapsToFinish: 12, fuelDeltaLiters: 4.1 } }));
  a = eng5.answer('fuel');
  check('fuel: good to finish', a.ok && /14\.2 laps/.test(a.text) && /Good to the finish/.test(a.text), a.text);
  eng5.update(frame({ fuel: { lapsRemaining: 6.5, lapsToFinish: 9, fuelDeltaLiters: -5.3 } }));
  a = eng5.answer('fuel');
  check('fuel: short of finish', a.ok && /5\.3 litres short/.test(a.text), a.text);
  eng5.update(frame({ fuel: { lapsRemaining: 1.2, pitThisLap: true } }));
  a = eng5.answer('fuel');
  check('fuel: box this lap', a.ok && /Box this lap/.test(a.text), a.text);
  eng5.update(frame({}));
  a = eng5.answer('fuel');
  check('fuel: unknown -> refuses', a.ok === false, a.text);

  // -- last lap & position ---------------------------------------------------
  const eng6 = new EngineerCommands();
  eng6.update(
    frame({
      standings: gt3Field([{}, { lastLapSec: 103.42, bestLapSec: 103.42 }, {}]),
    }),
  );
  a = eng6.answer('lastLap');
  check('lastLap: spoken time + PB', a.ok && /1 43\.4/.test(a.text) && /Personal best/.test(a.text), a.text);
  a = eng6.answer('position');
  check('position: class and overall', a.ok && /P2 in class, P4 overall/.test(a.text), a.text);

  // -- Track A: the wider ask-set (v3, 2026-08-19) ----------------------------

  const engA = new EngineerCommands();
  const tyreSet = {
    frontLeft: { tempC: 91, coreC: 91, optimalTempC: 90, wear: 0.9, pressureKpa: 158 },
    frontRight: { tempC: 92, coreC: 92, optimalTempC: 90, wear: 0.88, pressureKpa: 159 },
    rearLeft: { tempC: 88, coreC: 88, optimalTempC: 90, wear: 0.91, pressureKpa: 151 },
    rearRight: { tempC: 89, coreC: 89, optimalTempC: 90, wear: 0.92, pressureKpa: 152 },
  };
  engA.update(frame({ player: { tyres: tyreSet } }));
  a = engA.answer('tyres');
  check('tyres: in the window', a.ok && /in the window/.test(a.text) && /Tread's good/.test(a.text), a.text);
  a = engA.answer('pressures');
  check('pressures: axle averages', a.ok && /fronts 159, rears 152 kPa/.test(a.text), a.text);

  const hotFronts = JSON.parse(JSON.stringify(tyreSet));
  hotFronts.frontLeft.coreC = 102;
  hotFronts.frontRight.coreC = 102;
  engA.update(frame({ player: { tyres: hotFronts } }));
  a = engA.answer('tyres');
  check('tyres: hot fronts lead the sentence', a.ok && /Fronts about 12 over/.test(a.text), a.text);

  const wornCorner = JSON.parse(JSON.stringify(tyreSet));
  wornCorner.frontLeft.wear = 0.1;
  engA.update(frame({ player: { tyres: wornCorner } }));
  a = engA.answer('tyres');
  check('tyres: dying corner named', a.ok && /front left is nearly done — 10 percent left/.test(a.text), a.text);

  // damage / brakes / pit stop
  const dmgBase = {
    aero: 0, suspension: [0, 0, 0, 0], brakeThicknessMm: [24.2, 25, 26, 27],
    partsDetached: 0, worst: 0, hasDamage: false, repairSeconds: 0, repairBodySeconds: 0,
    repairSelection: 'none', repairOptions: [], tyreChangeSeconds: 28,
    tyreCornersSelected: 4, stopLengthSeconds: 34, randomDelayMaxSeconds: 0,
  };
  engA.update(frame({ player: { damage: dmgBase } }));
  a = engA.answer('damage');
  check('damage: clean car', a.ok && /clean/.test(a.text), a.text);
  a = engA.answer('brakes');
  check('brakes: thinnest corner named', a.ok && /front left, 24\.2 millimetres/.test(a.text), a.text);
  a = engA.answer('pitStop');
  check('pitStop: length + tyres', a.ok && /about 34 seconds/.test(a.text) && /Four tyres/.test(a.text), a.text);

  engA.update(frame({
    player: { damage: { ...dmgBase, hasDamage: true, worst: 0.3, aero: 0.3, repairSeconds: 12 } },
  }));
  a = engA.answer('damage');
  check('damage: moderate aero + repair time',
    a.ok && /Moderate damage — aero/.test(a.text) && /12 seconds to fix/.test(a.text), a.text);

  // pit window
  const engW = new EngineerCommands();
  engW.update(frame({ session: { currentLap: 5 }, fuel: { pitWindowOpenLap: 12 } }));
  a = engW.answer('pitWindow');
  check('pitWindow: opens later', a.ok && /opens lap 12 — 7 laps away/.test(a.text), a.text);
  engW.update(frame({ session: { currentLap: 13 }, fuel: { pitWindowOpenLap: 12, lapsRemaining: 4.2 } }));
  a = engW.answer('pitWindow');
  check('pitWindow: open now', a.ok && /window is open/i.test(a.text) && /4\.2 more laps/.test(a.text), a.text);

  // energy & hybrid
  engW.update(frame({
    player: { hybrid: { chargeFraction: 0.84, motorTorqueNm: 0 } },
    fuel: {
      virtualEnergyPct: 62.4, virtualEnergyLapsRemaining: 11.3,
      veCarsAheadPittingFirst: 2, veLapsInHandVsNext: 0.8,
    },
  }));
  a = engW.answer('energy');
  check('energy: percent, laps, strategy read',
    a.ok && /62 percent, 11\.3 laps/.test(a.text) && /2 of the cars ahead have to stop before you/.test(a.text),
    a.text);
  a = engW.answer('hybrid');
  check('hybrid: battery percent', a.ok && /Battery at 84 percent/.test(a.text), a.text);

  // pace — score path, then predicted-lap fallback
  const engP = new EngineerCommands();
  engP.update(frame({ player: { paceScore: { ok: true, percent: 94.2, bandLabel: 'Silver', deltaSec: 0.4, lapSec: 0 } } }));
  a = engP.answer('pace');
  check('pace: score + band + delta', a.ok && /94 percent — Silver/.test(a.text) && /0\.4 off the reference/.test(a.text), a.text);
  engP.update(frame({ player: { paceDeltas: { predictedLapSec: 103.8 } } }));
  a = engP.answer('pace');
  check('pace: predicted-lap fallback', a.ok && /On for 1 43\.8 this lap/.test(a.text), a.text);

  // the field: best lap, fastest lap, leader, grid
  const engF = new EngineerCommands();
  engF.update(frame({
    standings: gt3Field([
      { bestLapSec: 101.5, lastLapSec: 103.0 },
      { bestLapSec: 102.0, gridPosition: 12 },
      { bestLapSec: 101.2 },
    ]),
  }));
  a = engF.answer('bestLap');
  check('bestLap: spoken, no false flattery', a.ok && /Your best, 1 42\.0/.test(a.text) && !/Fastest in class/.test(a.text), a.text);
  a = engF.answer('fieldFastest');
  check('fieldFastest: holder + time', a.ok && /Fastest lap, Brown, 1 41\.2/.test(a.text), a.text);
  a = engF.answer('leader');
  check('leader: name, pace, my gap',
    a.ok && /Smith leads/.test(a.text) && /Last lap 1 43\.0/.test(a.text) && /2\.4 seconds back/.test(a.text), a.text);
  a = engF.answer('gridStart');
  check('gridStart: places made up', a.ok && /Started P12, running P4 — up 8/.test(a.text), a.text);

  engF.update(frame({
    standings: gt3Field([{ bestLapSec: 101.5 }, { bestLapSec: 101.0 }, {}]),
  }));
  a = engF.answer('bestLap');
  check('bestLap: fastest in class tagged', a.ok && /Fastest in class/.test(a.text), a.text);
  a = engF.answer('fieldFastest');
  check('fieldFastest: when it is yours', a.ok && /Fastest lap is yours/.test(a.text), a.text);

  // race control: limits, flags
  const engR = new EngineerCommands();
  engR.update(frame({ player: { trackLimits: { points: 2, pointsLimit: 4, penalties: 0 } } }));
  a = engR.answer('trackLimits');
  check('trackLimits: points + clean', a.ok && /2 of 4 points/.test(a.text) && /clean/.test(a.text), a.text);
  engR.update(frame({ player: { trackLimits: { points: 3, pointsLimit: 4, penalties: 1, penaltyType: 'STOP/GO', lapValid: false } } }));
  a = engR.answer('trackLimits');
  check('trackLimits: invalid lap leads, penalty named',
    a.ok && /^This lap's been invalidated/.test(a.text) && /STOP\/GO/.test(a.text), a.text);
  engR.update(frame({ session: { sectorFlags: ['none', 'yellow', 'none'] } }));
  a = engR.answer('flags');
  check('flags: sector yellow', a.ok && /Yellow in sector 2/.test(a.text), a.text);
  engR.update(frame({ session: { sectorFlags: ['none', 'none', 'none'] } }));
  a = engR.answer('flags');
  check('flags: all clear', a.ok && /green all round/.test(a.text), a.text);
  engR.update(frame({ session: { phase: 'fullCourseYellow' } }));
  a = engR.answer('flags');
  check('flags: FCY overrides sectors', a.ok && /Full course yellow/.test(a.text), a.text);

  // weather
  const engWx = new EngineerCommands();
  engWx.update(frame({
    weather: { trackTempC: 31, ambientTempC: 24, rainIntensity: 0, trackWetness: 0,
      forecast: [{ minutesAhead: 20, rainChance: 0.6, rainIntensity: 0, trackTempC: 29, sky: 'overcast' }] },
  }));
  a = engWx.answer('weather');
  check('weather: rain risk called', a.ok && /Rain risk 60 percent in about 20 minutes/.test(a.text) && /Track 31 degrees/.test(a.text), a.text);
  engWx.update(frame({
    weather: { trackTempC: 31, ambientTempC: 24, rainIntensity: 0, trackWetness: 0, trackTrend: 'drying', forecast: [] },
  }));
  a = engWx.answer('weather');
  check('weather: dry + trend', a.ok && /No rain coming/.test(a.text) && /drying/.test(a.text), a.text);

  // live car settings off the MFD
  const engM = new EngineerCommands();
  engM.update(frame({
    mfd: { pit: [], aids: [
      { key: 'BRAKE_BIAS', label: 'Brake Bias', value: 44, minValue: 0, maxValue: 100, text: '56.0:44.0' },
      { key: 'VM_TRACTION_CONTROL', label: 'TC', value: 5, minValue: 0, maxValue: 11, text: '5' },
    ] },
  }));
  a = engM.answer('brakeBias');
  check('brakeBias: front share spoken', a.ok && /Brake bias 56\.0 front/.test(a.text), a.text);
  a = engM.answer('tractionControl');
  check('tractionControl: label + setting', a.ok && /TC 5/.test(a.text), a.text);
  engM.update(frame({
    mfd: { pit: [], aids: [{ key: 'VM_ABS', label: 'ABS', value: 3, minValue: 0, maxValue: 11, text: '3' }] },
  }));
  a = engM.answer('tractionControl');
  check('tractionControl: car without TC refuses', a.ok === false && /No traction control/.test(a.text), a.text);

  // every new intent refuses honestly on an empty frame
  const engEmpty = new EngineerCommands();
  engEmpty.update(frame({}));
  for (const intent of [
    'tyres', 'pressures', 'damage', 'brakes', 'pitStop', 'pitWindow', 'energy', 'hybrid',
    'pace', 'bestLap', 'fieldFastest', 'leader', 'gridStart', 'trackLimits', 'flags',
    'weather', 'brakeBias', 'tractionControl',
  ]) {
    a = engEmpty.answer(intent);
    check(intent + ': empty frame refuses honestly', a.ok === false, a.text);
  }

  // -- the grammar and the answers can never drift ----------------------------
  // The recognizer's phrase table lives in electron/engineer.js; if an intent
  // exists on one side only, the button either can't reach an answer or hears
  // a phrase nothing will answer. Checked here so it fails in `npm test`, not
  // in a race.
  const { GRAMMAR } = require('../electron/engineer');
  const gIntents = new Set(GRAMMAR.map((g) => g.intent));
  check(
    'grammar covers every intent',
    COMMAND_INTENTS.every((i) => gIntents.has(i)),
    COMMAND_INTENTS.filter((i) => !gIntents.has(i)).join(',') || 'all covered',
  );
  check(
    'grammar has no orphan intents',
    [...gIntents].every((i) => COMMAND_INTENTS.includes(i)),
    [...gIntents].filter((i) => !COMMAND_INTENTS.includes(i)).join(',') || 'none',
  );

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
