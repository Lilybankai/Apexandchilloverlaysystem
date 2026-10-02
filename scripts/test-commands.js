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
  speakableSplit,
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
  // Counted off the leader of the DRIVER'S class, not the overall leader — the
  // same number the standings strip prints. A GT3 in a race led by a Hypercar
  // two laps up the road must not be told the Hypercar's laps-to-go, or the
  // driver gets two different answers depending on which they look at.
  eng4.update(frame({ session: { totalLaps: 20, currentLap: 17, classLeaderLap: 15 } }));
  a = eng4.answer('lapsLeft');
  check('lapsLeft: counts off the class leader, not the race leader',
    a.ok && /6 laps to go/.test(a.text), a.text);
  // No class resolved (spectating, an unknown mod class): fall back to the
  // overall leader rather than refusing to answer at all.
  eng4.update(frame({ session: { totalLaps: 20, currentLap: 17, classLeaderLap: -1 } }));
  a = eng4.answer('lapsLeft');
  check('lapsLeft: falls back to the race leader when no class is known',
    a.ok && /4 laps to go/.test(a.text), a.text);
  // A published prediction wins and is spoken as one — the driver hears that it
  // is an estimate, which the subtraction never was.
  eng4.update(frame({
    session: { totalLaps: 20, currentLap: 17, classLeaderLap: 15, lapsRemaining: 5 },
  }));
  a = eng4.answer('lapsLeft');
  check('lapsLeft: a prediction is spoken as an estimate',
    a.ok && /About 5 laps to go/.test(a.text), a.text);
  // ...but the last lap is the last lap, never "about one".
  eng4.update(frame({
    session: { totalLaps: 20, currentLap: 20, classLeaderLap: 20, lapsRemaining: 1 },
  }));
  a = eng4.answer('lapsLeft');
  check('lapsLeft: the final lap is never hedged', a.ok && /last lap/.test(a.text), a.text);

  // -- fuel ------------------------------------------------------------------
  // The answer speaks the TIGHTER budget: LMU cars run a tank AND a virtual-
  // energy allowance, and the driver pits for whichever runs out first.
  const eng5 = new EngineerCommands();
  eng5.update(frame({ fuel: { lapsRemaining: 14.2, lapsToFinish: 12, fuelDeltaLiters: 4.1 } }));
  a = eng5.answer('fuel');
  check('fuel: good to finish', a.ok && /14\.2 laps/.test(a.text) && /Good to the finish/.test(a.text), a.text);
  eng5.update(frame({ fuel: { lapsRemaining: 6.5, lapsToFinish: 9, fuelDeltaLiters: -5.3 } }));
  a = eng5.answer('fuel');
  check('fuel: short of finish, in laps',
    a.ok && /2\.5 laps short on fuel/.test(a.text) && /need a stop/.test(a.text), a.text);
  eng5.update(frame({ fuel: { lapsRemaining: 1.2, pitThisLap: true } }));
  a = eng5.answer('fuel');
  check('fuel: box this lap', a.ok && /Box this lap/.test(a.text), a.text);
  eng5.update(frame({}));
  a = eng5.answer('fuel');
  check('fuel: unknown -> refuses', a.ok === false, a.text);

  // The 2026-08-19 race bug, verbatim: tank fine, energy 2.9 laps short —
  // "good to the finish" off the tank alone is a race-losing answer.
  eng5.update(frame({
    fuel: {
      lapsRemaining: 28.5, virtualEnergyLapsRemaining: 24.1, lapsToFinish: 27,
      fuelDeltaLiters: 4.1,
    },
  }));
  a = eng5.answer('fuel');
  check('fuel: energy is the binding budget',
    a.ok && /Fuel for 28\.5 laps, energy for 24\.1/.test(a.text) &&
      /2\.9 laps short on energy/.test(a.text) && /need a stop/.test(a.text),
    a.text);
  eng5.update(frame({
    fuel: { lapsRemaining: 28.5, virtualEnergyLapsRemaining: 29.0, lapsToFinish: 27 },
  }));
  a = eng5.answer('fuel');
  check('fuel: both budgets cover it', a.ok && /Good to the finish/.test(a.text), a.text);

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

  // -- sectors (cumulative LMU boundaries → three splits) --------------------
  const engSec = new EngineerCommands();
  engSec.update(
    frame({
      standings: gt3Field([
        {},
        { lastLapSec: 108.937, lastSector1Sec: 27.89, lastSector2Sec: 76.2 },
        {},
      ]),
    }),
  );
  a = engSec.answer('sectors');
  check(
    'sectors: three splits from cumulative boundaries',
    a.ok && /27\.9/.test(a.text) && /48\.3/.test(a.text) && /32\.7/.test(a.text),
    a.text,
  );
  const engSecNone = new EngineerCommands();
  engSecNone.update(
    frame({
      standings: gt3Field([{}, { lastLapSec: 103.42 }, {}]),
    }),
  );
  a = engSecNone.answer('sectors');
  check('sectors: last lap but no splits refuses', a.ok === false && /No sector/.test(a.text), a.text);
  const engSecTorn = new EngineerCommands();
  engSecTorn.update(
    frame({
      standings: gt3Field([
        {},
        { lastLapSec: 103.42, lastSector1Sec: 29.09, lastSector2Sec: -1 },
        {},
      ]),
    }),
  );
  a = engSecTorn.answer('sectors');
  check('sectors: torn pair (-1) refuses whole, not half', a.ok === false, a.text);
  check('speakableSplit: sub-minute drops the unit', speakableSplit(28.1) === '28.1');
  check('speakableSplit: minute-plus uses lap-time form', speakableSplit(74.3) === '1 14.3', speakableSplit(74.3));

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
  check('damage: major aero + repair time',
    a.ok && /Major damage — aero/.test(a.text) && /Repairs about 12 seconds/.test(a.text), a.text);

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
  engW.update(frame({
    fuel: { virtualEnergyPct: 55, virtualEnergyLapsRemaining: 24.1, lapsToFinish: 27 },
  }));
  a = engW.answer('energy');
  check('energy: names the shortfall to the flag',
    a.ok && /2\.9 laps short of the finish/.test(a.text), a.text);

  // fuel ratio — the MFD aid when the car exposes one, the burn ratio when it
  // doesn't, an honest refusal when neither read exists (asked twice on
  // 2026-08-19 and refused by the cloud).
  engW.update(frame({
    mfd: { pit: [], aids: [{ key: 'VM_FUEL_RATIO', label: 'Fuel Ratio', value: 5, minValue: 0, maxValue: 10, text: '1.05' }] },
  }));
  a = engW.answer('fuelRatio');
  check('fuelRatio: MFD aid wins when present', a.ok && /Fuel ratio 1\.05/.test(a.text), a.text);
  engW.update(frame({ fuel: { perLapAvgLiters: 2.9, virtualEnergyPerLapPct: 3.5 } }));
  a = engW.answer('fuelRatio');
  check('fuelRatio: burn ratio from both per-lap rates',
    a.ok && /0\.83 litres per percent of energy/.test(a.text), a.text);
  engW.update(frame({}));
  a = engW.answer('fuelRatio');
  check('fuelRatio: refuses without a read', a.ok === false, a.text);

  // -- trends: per-lap history behind "am I catching him" ---------------------
  // Three player lap edges with the class-leader gap shrinking 5.0 → 4.4 → 3.8:
  // 0.6 a lap, caught in about six.
  const engC = new EngineerCommands();
  const chaseLap = (lap, myLast, myGap) => frame({
    standings: gt3Field([
      { lapsCompleted: lap },
      { lastLapSec: myLast, lapsCompleted: lap, gapToClassLeaderSec: myGap },
      {},
    ]),
  });
  engC.update(chaseLap(5, 100.1, 5.0));
  a = engC.answer('catching');
  check('catching: one sample is no trend', a.ok === false, a.text);
  engC.update(chaseLap(6, 100.2, 4.4));
  engC.update(chaseLap(7, 100.3, 3.8));
  a = engC.answer('catching');
  check('catching: rate and time-to-catch',
    a.ok && /taking 0\.6 a lap out of Smith/.test(a.text) && /about 6 laps/.test(a.text), a.text);
  const extras = engC.summaryExtras();
  check('summaryExtras: the same trend rides the cloud payload',
    extras.aheadTrendSecPerLap === 0.6 && extras.lapsToCatchAhead === 6,
    JSON.stringify(extras));

  const engD = new EngineerCommands();
  const defendLap = (lap, myLast, brownGap) => frame({
    standings: gt3Field([
      { lapsCompleted: lap },
      { lastLapSec: myLast, lapsCompleted: lap },
      { gapToClassLeaderSec: brownGap, lapsCompleted: lap },
    ]),
  });
  engD.update(defendLap(5, 100.1, 8.4)); // gap behind 6.0
  engD.update(defendLap(6, 100.2, 7.6)); // 5.2
  engD.update(defendLap(7, 100.3, 6.8)); // 4.4 — he's taking 0.8 a lap
  a = engD.answer('defending');
  check('defending: the car behind closing is named with a rate',
    a.ok && /Brown's taking 0\.8 a lap out of you/.test(a.text) && /about 6 laps/.test(a.text), a.text);

  // Tyre life: min corner wear 0.80 → 0.77 → 0.74 across three laps.
  const engY = new EngineerCommands();
  const wearLap = (lap, myLast, wear) => frame({
    player: {
      tyres: {
        frontLeft: { wear },
        frontRight: { wear: wear + 0.05 },
        rearLeft: { wear: wear + 0.02 },
        rearRight: { wear: wear + 0.04 },
      },
    },
    standings: gt3Field([{}, { lastLapSec: myLast, lapsCompleted: lap }, {}]),
  });
  engY.update(wearLap(5, 100.1, 0.80));
  a = engY.answer('tyreLife');
  check('tyreLife: one sample has tread but no rate', a.ok === false && /80 percent/.test(a.text), a.text);
  engY.update(wearLap(6, 100.2, 0.77));
  engY.update(wearLap(7, 100.3, 0.74));
  a = engY.answer('tyreLife');
  check('tyreLife: wear rate and laps left',
    a.ok && /74 percent/.test(a.text) && /3\.0 a lap/.test(a.text) && /roughly 19 more laps/.test(a.text),
    a.text);

  // -- pit exit: measured loss, honest refusal first --------------------------
  const engX = new EngineerCommands();
  const pitFrame = (brown) => frame({
    standings: gt3Field([
      { gapToLeaderSec: 0, lapsBehind: 0, lapsCompleted: 6, pitStops: 0 },
      { gapToLeaderSec: 20, gapToClassLeaderSec: 20, lapsBehind: 0, lapsCompleted: 6 },
      { gapToLeaderSec: 10, gapToClassLeaderSec: 10, lapsBehind: 0, lapsCompleted: 5, pitStops: 1, ...brown },
    ]),
  });
  engX.update(pitFrame({}));
  a = engX.answer('pitExit');
  check('pitExit: refuses before any stop is measured',
    a.ok === false && /nobody's made a stop/.test(a.text), a.text);
  engX.update(pitFrame({ inPit: true }));
  engX.update(pitFrame({ inPit: false, lapsCompleted: 6, gapToLeaderSec: 40, gapToClassLeaderSec: 40 }));
  engX.update(pitFrame({ inPit: false, lapsCompleted: 7, gapToLeaderSec: 42, gapToClassLeaderSec: 42 }));
  a = engX.answer('pitExit');
  check('pitExit: measured 32s loss projects the exit position',
    a.ok && /around P3/.test(a.text) && /10\.0 seconds behind Brown/.test(a.text) &&
      /One of those cars still has to stop/.test(a.text) && /one stop we've timed/.test(a.text),
    a.text);
  const xExtras = engX.summaryExtras();
  check('summaryExtras: pit projection rides the cloud payload',
    xExtras.pitLossSec === 32 && xExtras.pitExitPosition === 3 && xExtras.pitExitBehind === 'Brown',
    JSON.stringify(xExtras));

  // pace — current score plus named Ohne Speed race-pace targets
  const engP = new EngineerCommands();
  engP.update(frame({ player: { paceScore: {
    ok: true, percent: 104, bandLabel: 'Midpack', bandId: 'midpack',
    deltaSec: 4, refSec: 100, hotlapSec: 98, lapSec: 104,
    layoutName: 'Grand Prix', sheetClass: 'LMGT3',
  } } }));
  a = engP.answer('pace');
  check('pace: best + band + alien delta',
    a.ok && /Your best is 1 44\.0/.test(a.text) && /104 percent — Midpack/.test(a.text) &&
      /4\.0 off alien race pace/.test(a.text), a.text);
  a = engP.answer('paceAlien');
  check('paceAlien: target + driver delta',
    a.ok && /Alien race pace for LMGT3 at Grand Prix is 1 40\.0/.test(a.text) &&
      /4\.0 seconds to find/.test(a.text), a.text);
  a = engP.answer('paceCompetitive');
  check('paceCompetitive: 101 percent target + delta',
    a.ok && /Competitive race pace.*1 41\.0/.test(a.text) && /3\.0 seconds to find/.test(a.text), a.text);
  a = engP.answer('paceMidpack');
  check('paceMidpack: 105 percent target already met',
    a.ok && /Midpack race pace.*1 45\.0/.test(a.text) && /1\.0 seconds faster/.test(a.text), a.text);

  // The reference is useful before the first flying lap; only the comparison
  // waits for a lap.
  engP.update(frame({ player: { paceScore: {
    ok: false, reason: 'no-lap', detail: 'Set a lap to see where you land.',
    refSec: 100, lapSec: UNKNOWN, layoutName: 'Grand Prix', sheetClass: 'LMGT3',
  } } }));
  a = engP.answer('paceCompetitive');
  check('paceCompetitive: target available before first lap',
    a.ok && /Competitive race pace.*1 41\.0 or better/.test(a.text) && !/Your best/.test(a.text), a.text);

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

  // A trimmed recording can lack whole blocks — a missing weather block must
  // refuse, not throw (found replaying the 2026-08-19 race).
  const engTrim = new EngineerCommands();
  const noWeather = frame({});
  delete noWeather.weather;
  delete noWeather.fuel;
  engTrim.update(noWeather);
  a = engTrim.answer('weather');
  check('weather: absent block refuses instead of throwing', a.ok === false, a.text);
  a = engTrim.answer('fuel');
  check('fuel: absent block refuses instead of throwing', a.ok === false, a.text);
  a = engTrim.answer('pitWindow');
  check('pitWindow: absent block refuses instead of throwing', a.ok === false, a.text);

  // every new intent refuses honestly on an empty frame
  const engEmpty = new EngineerCommands();
  engEmpty.update(frame({}));
  for (const intent of [
    'tyres', 'pressures', 'damage', 'brakes', 'pitStop', 'pitWindow', 'energy', 'fuelRatio', 'hybrid',
    'pace', 'paceAlien', 'paceCompetitive', 'paceMidpack', 'catching', 'defending', 'tyreLife',
    'pitExit', 'bestLap', 'fieldFastest', 'leader',
    'gridStart', 'trackLimits', 'flags', 'weather', 'brakeBias', 'tractionControl', 'sectors',
  ]) {
    a = engEmpty.answer(intent);
    check(intent + ': empty frame refuses honestly', a.ok === false, a.text);
  }

  // -- clean averages (2026-10-02) --------------------------------------------
  // The Fuji field report: own average 106.4 against a best of 103.1 and a last
  // of 103.6 — pit laps were sitting in the window. A lap enters the average
  // only off a lap-COUNT edge, with no pit lane, not the race's opening lap, not
  // under FCY/red, and within 107% of the car's best.
  {
    const engAvg = new EngineerCommands();
    let mine = { lapsCompleted: 0, lastLapSec: UNKNOWN, bestLapSec: UNKNOWN, inPit: false, pitStops: 0 };
    let phase = 'green';
    const push = () => engAvg.update(frame({ session: { phase }, standings: gt3Field([{}, mine, {}]) }));
    const lap = (sec, over) => {
      mine = { ...mine, ...over, lapsCompleted: mine.lapsCompleted + 1, lastLapSec: sec };
      if (sec > 0 && (mine.bestLapSec === UNKNOWN || sec < mine.bestLapSec)) mine.bestLapSec = sec;
      push();
      push(); // a repeat frame must never count the lap twice
    };
    push(); // first sight on the grid, lap 0
    lap(112.0); // race lap 1 — the start, excluded
    let avg = engAvg.averageOf(2);
    check('clean avg: the race opening lap is not pace', avg === null, JSON.stringify(avg));
    lap(103.1);
    lap(103.6);
    lap(103.6); // identical consecutive times: the count edge keeps both
    avg = engAvg.averageOf(2);
    check('clean avg: identical consecutive laps both count (lap-count edge)',
      avg && avg.count === 3, JSON.stringify(avg));
    // In-lap: the car is in the lane when it crosses the line (pit entry before it).
    mine = { ...mine, inPit: true };
    push();
    lap(131.0, { inPit: true, pitStops: 1 });
    // Out-lap: starts in the lane, so it carries the mark too.
    mine = { ...mine, inPit: false };
    push();
    lap(124.0);
    avg = engAvg.averageOf(2);
    check('clean avg: in-lap and out-lap left out', avg && avg.count === 3, JSON.stringify(avg));
    // A stop the pit flag never showed (only the count moved) is still a pit lap.
    mine = { ...mine, pitStops: 2 };
    push();
    lap(104.0);
    avg = engAvg.averageOf(2);
    check('clean avg: a lap whose pit count moved is left out', avg && avg.count === 3, JSON.stringify(avg));
    // Full-course yellow for part of a lap.
    phase = 'fullCourseYellow';
    push();
    phase = 'green';
    lap(109.0);
    avg = engAvg.averageOf(2);
    check('clean avg: a lap run partly under FCY is left out', avg && avg.count === 3, JSON.stringify(avg));
    // A spin: no pit, no flag, but 115 is past 107% of 103.1.
    lap(115.0);
    avg = engAvg.averageOf(2);
    check('clean avg: a 107% outlier is left out', avg && avg.count === 3, JSON.stringify(avg));
    lap(103.4);
    avg = engAvg.averageOf(2);
    check('clean avg: the Fuji window is pace, not pit stops',
      avg && avg.count === 4 && Math.abs(avg.avg - (103.1 + 103.6 + 103.6 + 103.4) / 4) < 1e-9,
      JSON.stringify(avg));
    a = engAvg.answer('myAverage');
    check('myAverage: own clean average with the lap count and best',
      a.ok && /^Last 4 clean laps averaging 1 43\.4, best 1 43\.1\.$/.test(a.text), a.text);
    // A driver swap (team race) starts the window again.
    mine = { ...mine, driverName: 'New Driver' };
    push();
    a = engAvg.answer('myAverage');
    check('clean avg: a driver change empties the window', a.ok === false, a.text);
    lap(103.9);
    a = engAvg.answer('myAverage');
    check('myAverage: one lap says so', a.ok && /^One clean lap so far, 1 43\.9, best 1 43\.1\.$/.test(a.text), a.text);
  }
  {
    // The outlier rule re-judges at read time: a lap kept while it was the only
    // reference is dropped once a best 8% quicker exists.
    const engOut = new EngineerCommands();
    engOut.update(frame({ session: { type: 'practice' }, standings: gt3Field([{}, { lastLapSec: 112, lapsCompleted: 3 }, {}]) }));
    engOut.update(frame({ session: { type: 'practice' }, standings: gt3Field([{}, { lastLapSec: 103.5, bestLapSec: 103.5, lapsCompleted: 4 }, {}]) }));
    const avg = engOut.averageOf(2);
    check('clean avg: a later best re-judges older laps', avg && avg.count === 1 && avg.avg === 103.5, JSON.stringify(avg));
    // Practice: lap 1 is not a race start and is kept.
    const engPr = new EngineerCommands();
    engPr.update(frame({ session: { type: 'practice' }, standings: gt3Field([{}, { lapsCompleted: 0 }, {}]) }));
    engPr.update(frame({ session: { type: 'practice' }, standings: gt3Field([{}, { lastLapSec: 104, lapsCompleted: 1 }, {}]) }));
    check('clean avg: lap 1 of a practice session is kept', (engPr.averageOf(2) || {}).count === 1);
  }
  {
    // avgAhead and carAhead read the same clean windows — a rival's stop no
    // longer makes the driver look a second quicker than him.
    const engRiv = new EngineerCommands();
    const both = (lapN, smith, jones, smithOver) => engRiv.update(frame({
      standings: gt3Field([
        { lastLapSec: smith, lapsCompleted: lapN, ...smithOver },
        { lastLapSec: jones, lapsCompleted: lapN },
        {},
      ]),
    }));
    both(4, 101, 102);
    both(5, 101, 102);
    both(5, 101, 102, { inPit: true });
    both(6, 133, 102, { inPit: true, pitStops: 1 });
    both(6, 133, 102, { inPit: false, pitStops: 1 });
    both(7, 124, 102, { pitStops: 1 }); // the out-lap: started in the lane
    both(8, 101.2, 102, { pitStops: 1 });
    a = engRiv.answer('avgAhead');
    check('avgAhead: the rival\'s pit laps stay out of his average',
      a.ok && /Smith averaging 1 41\.1/.test(a.text) && /Smith is 0\.9 quicker/.test(a.text), a.text);
  }
  {
    const engNone = new EngineerCommands();
    engNone.update(frame({ standings: gt3Field() }));
    a = engNone.answer('myAverage');
    check('myAverage: no laps refuses honestly', a.ok === false && /No clean laps/.test(a.text), a.text);
  }

  // -- position-addressed answers (2026-10-02) ---------------------------------
  // The cloud invented a pace for P5 and relabelled the gap ahead as "the gap
  // to P10". The standings carry every car; the answers are local now.
  {
    const engPos = new EngineerCommands();
    const ask = (q) => engPos.answerPosition(q);
    a = ask({ intent: 'gapTo', positions: [5] });
    check('position: no telemetry refuses', a.ok === false && /No telemetry/.test(a.text), a.text);

    // A multiclass field: an LMP2 is P1 OVERALL, the GT3 class is Smith/Jones/Brown.
    const field = () => [
      car(7, { position: 1, driverName: 'Leo Proto', carClass: 'LMP2', classPosition: 1, gapToClassLeaderSec: 0, gapToLeaderSec: 0, lastLapSec: 95.2 }),
      ...gt3Field([
        { gapToLeaderSec: 40, lastLapSec: 103.0, bestLapSec: 102.4, carNumber: '23', lastSector1Sec: 32.2, lastSector2Sec: 70.1, classLapsBehindExact: 0 },
        { gapToLeaderSec: 42.4, lastLapSec: 103.6, bestLapSec: 103.1, lastSector1Sec: 32.4, lastSector2Sec: 70.0, classLapsBehindExact: 0.02 },
        { gapToLeaderSec: 47.9, lastLapSec: 104.1, bestLapSec: 103.9, classLapsBehindExact: 0.07 },
      ]),
    ];
    for (let i = 0; i < 3; i++) engPos.update(frame({ session: { numCars: 4 }, standings: field() }));

    a = ask({ intent: 'gapTo', positions: [3] });
    check('position: gap to P3 (class) behind', a.ok && /^P3 in class, Brown, 5\.5 seconds behind you\.$/.test(a.text), a.text);
    a = ask({ intent: 'gapTo', positions: [1] });
    check('position: gap to P1 means the CLASS leader, not the LMP2',
      a.ok && /^P1 in class, Smith, 2\.4 seconds ahead\.$/.test(a.text), a.text);
    a = ask({ intent: 'gapTo', positions: [1], overall: true });
    check('position: "P1 overall" reaches the LMP2',
      a.ok && /P1 overall, Proto, 42\.4 seconds ahead/.test(a.text), a.text);
    a = ask({ intent: 'gapTo', positions: [2] });
    check('position: the player asking for their own position', a.ok && /That's you — P2 in class/.test(a.text), a.text);
    a = ask({ intent: 'gapBetween', positions: [1, 3] });
    check('position: gap between two other cars',
      a.ok && /^P1 in class Smith leads P3 in class Brown by 7\.9 seconds\.$/.test(a.text), a.text);
    a = ask({ intent: 'gapBetween', positions: [3, 2] });
    check('position: a "between" that names the player speaks from the seat',
      a.ok && /^P3 in class, Brown, 5\.5 seconds behind you\.$/.test(a.text), a.text);
    a = ask({ intent: 'gapTo', positions: [9] });
    check('position: past the end of the class refuses with the class size',
      a.ok === false && /Only 3 cars in class/.test(a.text), a.text);
    a = ask({ intent: 'whoIs', positions: [1] });
    check('position: who is P1', a.ok && /^P1 in class is Smith, number 23, 2\.4 seconds ahead\.$/.test(a.text), a.text);
    a = ask({ intent: 'paceOf', positions: [1] });
    check('position: pace of the class leader — last, clean average, best, verdict',
      a.ok && /P1 in class, Smith: last lap 1 43\.0/.test(a.text) && /best 1 42\.4/.test(a.text), a.text);
    a = ask({ intent: 'paceOf', positions: [2] });
    check('position: pace of my own position is my own average', a.ok && /^That's you\. /.test(a.text), a.text);
    a = ask({ intent: 'sectorsVs', positions: [1], sectors: [1, 2] });
    check('position: sector one and two against P1',
      a.ok && /Last laps against Smith, P1 in class: sector one, 0\.2 down; sector two, 0\.3 up\./.test(a.text), a.text);
    a = ask({ intent: 'mySector', positions: [], sectors: [1] });
    check('mySector: one named split against the class best we have timed',
      a.ok && /^Sector one, 32\.4, 0\.2 off the class best, Smith's 32\.2\.$/.test(a.text), a.text);
    a = ask({ intent: 'mySector', positions: [], sectors: [2] });
    check('mySector: the class best is mine', a.ok && /Sector two, 37\.6, the best in class we've timed/.test(a.text), a.text);
    a = ask({ intent: 'sectorsVs', positions: [3] });
    check('position: no splits on the target refuses honestly', a.ok === false && /No sector times on Brown/.test(a.text), a.text);
  }
  {
    // Lapped cars: laps apart off the UNFLOORED exact deficit, never two
    // floored classLapsBehind; a lapped car with no exact deficit is named as
    // lapped and given no number.
    const engLap = new EngineerCommands();
    engLap.update(frame({
      standings: gt3Field([
        { classLapsBehindExact: 0 },
        { classLapsBehindExact: 0.4 },
        { gapToClassLeaderSec: UNKNOWN, classLapsBehind: 1, classLapsBehindExact: 1.6 },
      ]),
    }));
    a = engLap.answerPosition({ intent: 'gapTo', positions: [3] });
    check('position: a car a lap down is spoken in laps', a.ok && /Brown, 1 lap behind you/.test(a.text), a.text);
    engLap.update(frame({
      standings: gt3Field([
        {},
        { classLapsBehind: 0 },
        { gapToClassLeaderSec: UNKNOWN, classLapsBehind: 1 },
      ]),
    }));
    a = engLap.answerPosition({ intent: 'gapTo', positions: [3] });
    check('position: lapped with no exact deficit refuses, says why',
      a.ok === false && /no clean gap/i.test(a.text) && /Brown is off the lead lap/.test(a.text), a.text);
    // 0.4 and 1.3 floored are 0 and 1 — but the cars are 0.9 of a lap apart.
    engLap.update(frame({
      standings: gt3Field([
        { classLapsBehindExact: 0 },
        { classLapsBehindExact: 0.4, classLapsBehind: 0 },
        { gapToClassLeaderSec: 95, classLapsBehind: 1, classLapsBehindExact: 1.3 },
      ]),
    }));
    a = engLap.answerPosition({ intent: 'gapTo', positions: [3] });
    check('position: never subtracts floored lap counts',
      a.ok && /92\.6 seconds|1 32\.6/.test(a.text) && !/lap behind/.test(a.text), a.text);
    // Single-class field: no "in class" qualifier.
    const engOne = new EngineerCommands();
    engOne.update(frame({ standings: gt3Field() }));
    a = engOne.answerPosition({ intent: 'gapTo', positions: [1] });
    check('position: single-class field drops the "in class" qualifier', a.ok && /^P1, Smith/.test(a.text), a.text);
    // No standings for the asked position at all.
    const engEmptyPos = new EngineerCommands();
    engEmptyPos.update(frame({}));
    a = engEmptyPos.answerPosition({ intent: 'paceOf', positions: [5] });
    check('position: empty standings refuse', a.ok === false && /No car at P5/.test(a.text), a.text);
  }

  // -- the grammar and the answers can never drift ----------------------------
  // The recognizer's phrase table lives in electron/engineer.js; if an intent
  // exists on one side only, the button either can't reach an answer or hears
  // a phrase nothing will answer. Checked here so it fails in `npm test`, not
  // in a race.
  const { GRAMMAR, ENGINEER_CALLOUTS, RADIO_CONTROL_INTENTS, matchGrammarText, matchPositionQuery, radioNoise } = require('../electron/engineer');
  // Radio controls ("keep quiet", "repeat that") are grammar entries with no
  // command answer — ask() handles them (test-radio-gate.js).
  const gIntents = new Set(GRAMMAR.map((g) => g.intent).filter((i) => !RADIO_CONTROL_INTENTS.has(i)));
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
  // The panel's reference card is grouped straight off this table; an entry
  // without a group would render under a stray "More" heading.
  check(
    'every grammar entry carries a group',
    GRAMMAR.every((g) => typeof g.group === 'string' && g.group.length > 0),
    GRAMMAR.filter((g) => !g.group).map((g) => g.intent).join(',') || 'all grouped',
  );
  // Callout buttons must name a real intent or a Stream Deck press speaks nothing.
  check(
    'every callout is a real intent',
    ENGINEER_CALLOUTS.every((c) => COMMAND_INTENTS.includes(c.intent)),
    ENGINEER_CALLOUTS.filter((c) => !COMMAND_INTENTS.includes(c.intent)).map((c) => c.intent).join(',') || 'all real',
  );
  check(
    'callouts have unique intents',
    new Set(ENGINEER_CALLOUTS.map((c) => c.intent)).size === ENGINEER_CALLOUTS.length,
  );
  check(
    'callouts cover last lap, sectors and track limits',
    ['lastLap', 'sectors', 'trackLimits'].every((i) => ENGINEER_CALLOUTS.some((c) => c.intent === i)),
  );

  /* ---- ask routing: noise guard, then phrase list, then cloud ------------- */
  // Every transcript below is verbatim from the engineer_calls log. The order
  // matters: radioNoise runs FIRST, because a whisper repetition loop reliably
  // contains a grammar word and would otherwise earn a confident Tier 1 answer.
  const SPOKEN = ["I'd box this lap.", 'One minute remaining in session.'];
  // Same order as ask(): noise, then a position query, then the phrase list.
  const route = (q) =>
    radioNoise(q, SPOKEN) || (matchPositionQuery(q) ? 'position' : matchGrammarText(q) ? 'grammar' : 'cloud');
  // The exact destination, for the routing table below.
  const routeTo = (q) => {
    const noise = radioNoise(q, SPOKEN);
    if (noise) return noise;
    const pq = matchPositionQuery(q);
    if (pq) return `position:${pq.intent}:${pq.positions.join(',')}${pq.sectors ? ':s' + pq.sectors.join(',') : ''}${pq.overall ? ':overall' : ''}`;
    return matchGrammarText(q) || 'cloud';
  };
  // 2026-10-02 field transcripts, verbatim from the engineer_calls log. Each
  // one either reached the cloud (which invented an answer) or hit the WRONG
  // Tier-1 intent. Before → after is in the comment.
  const ROUTING = [
    ['average of the car ahead', 'carAhead'], // carAhead → carAhead (it worked; keep it)
    ["what's my average?", 'myAverage'], // cloud → myAverage
    ['what is my average', 'myAverage'], // cloud → myAverage
    ['my average lap time', 'myAverage'], // lastLap (wrong) → myAverage
    ["what's my five lap average", 'myAverage'], // avgAhead (wrong) → myAverage
    ["what's my last five average", 'myAverage'], // avgAhead (wrong) → myAverage
    ["what's my 5 lap average", 'myAverage'], // whisper digits
    ['my pace average', 'myAverage'], // pace (wrong) → myAverage
    ['what is the pace of P5?', 'position:paceOf:5'], // cloud (fabricated) → local
    ['gap to P10.', 'position:gapTo:10'], // cloud (relabelled gap ahead) → local
    ['what is the gap between P5 and P6?', 'position:gapBetween:5,6'], // cloud → local
    ['update me on class leaders times', 'position:paceOf:1'], // cloud → local
    ["what's my sector one?", 'position:mySector::s1'], // cloud → local
    ['what is my time difference in sector 1 and 2 to P1 in class?', 'position:sectorsVs:1:s1,2'], // cloud → local
    // Neighbours that must keep their old homes.
    ['last five average', 'avgAhead'],
    ['Top 5 average lap', 'avgAhead'],
    ['five lap average front', 'avgAhead'],
    ['last lap time', 'lastLap'],
    ["how's my pace", 'pace'],
    ['sectors', 'sectors'],
    ['sector times', 'sectors'],
    ['is there a yellow in sector two', 'flags'],
    ['gap to the leader', 'leader'],
    ["who's the class leader", 'leader'],
    ['what position am i in', 'position'],
    ['what is the gap to position five overall', 'position:gapTo:5:overall'],
    ["who's in second place", 'position:whoIs:2'],
    ["what's P3's pace", 'position:paceOf:3'],
    ['the leader\'s last lap', 'position:paceOf:1'],
    ['give me one second', 'cloud'],
    ['what gear for turn five', 'cloud'],
  ];
  for (const [q, want] of ROUTING) {
    const got = routeTo(q);
    check(`routing: "${q}" -> ${want}`, got === want, got);
  }
  const routes = (name, want, qs) =>
    check(
      `route/${name} -> ${want}`,
      qs.every((q) => route(q) === want),
      qs.filter((q) => route(q) !== want).map((q) => `${q}=${route(q)}`).join(' | ') || 'all',
    );

  // Shorthand the phrase list missed until 2026-09-06; each was a paid call.
  routes('clipped shorthand', 'grammar', ['tyre', 'tyres', 'tires', 'ahead', 'ahead.', 'behind', 'in front', 'damage', 'gap ahead']);
  // Whisper's repetition hallucination on silence, and our own voice returning
  // through the mic — neither is a question and neither may reach the cloud.
  routes('whisper loop', 'loop', [
    'rear, tyre, rear, tyre, rear, tyre, box, box, box, box, rear, tyre',
    'this lap, box this lap, box this lap',
  ]);
  routes('own voice echoed back', 'echo', ['1.1 minutes remaining in session.']);
  routes('stray single words', 'noword', ['prompt,', 'heads,', 'switch.', 'lows', 'mate', 'ladder', 'fire', 'hardship']);
  routes('nothing at all', 'empty', ['...', '']);
  // Real asks the guard must never swallow: racing questions the cloud answers.
  routes('real questions survive', 'cloud', [
    'session update', 'retired a car', 'round of the pack', 'and the next lap.',
    'box to retire the car.', 'overall', 'status.', 'and the', 'car at',
    'how many cars are pitting before me I had?',
    'what time do I need on this track to be competitive',
  ]);
  check(
    'echo needs five words — a driver repeating a call still gets through',
    radioNoise('box this lap', SPOKEN) === null,
    String(radioNoise('box this lap', SPOKEN)),
  );

  // gapAhead's "laps apart" off the UNFLOORED class counts: 5.95 and 6.05
  // floor to 5 and 6, which used to speak "1 lap and 2.0 seconds" for a car
  // two seconds up the road.
  {
    const { EngineerCommands } = require('../dist/telemetry/engineerCommands.js');
    const row = (o) => Object.assign({ slotId: 0, driverName: 'X', carClass: 'GT3', position: 1, classPosition: 1,
      gapToLeaderSec: 0, gapToClassLeaderSec: 0, lastLapSec: 100, bestLapSec: 100, lapsCompleted: 5, pitStops: 0, inPit: false }, o);
    const c = new EngineerCommands();
    c.update({ session: { type: 'race', phase: 'green' }, relative: [], standings: [
      row({ slotId: 1, driverName: 'Ann Lead', classPosition: 5, position: 5, gapToClassLeaderSec: 30, classLapsBehind: 5, classLapsBehindExact: 5.95 }),
      row({ slotId: 2, driverName: 'Me Me', isPlayer: true, classPosition: 6, position: 6, gapToClassLeaderSec: 32, classLapsBehind: 6, classLapsBehindExact: 6.05 }),
    ] });
    const t = c.answer('gapAhead').text;
    check('gap ahead never invents a lap from two floored counts', !/lap/.test(t) && /2\.0/.test(t), t);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
