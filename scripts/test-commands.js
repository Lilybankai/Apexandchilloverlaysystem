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

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
