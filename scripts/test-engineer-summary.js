/**
 * scripts/test-engineer-summary.js — the bucketed payload Tier 2 is allowed to see.
 * -----------------------------------------------------------------------------
 * The proxy must never receive a raw telemetry frame. This suite checks the
 * summary builder: it carries the numbers a free-form question needs, it omits
 * missing data rather than sending -1, and tyres/damage leave as bands.
 */

'use strict';

const { engineerSummary } = require('../dist/telemetry/engineerSummary');
const { UNKNOWN_VALUE } = require('../dist/telemetry/types');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

function frame(over) {
  return {
    schemaVersion: 1,
    source: 'test',
    timestamp: 0,
    connected: true,
    session: {
      type: 'race',
      phase: 'green',
      flag: 'green',
      track: 'Spa',
      timeRemainingSec: UNKNOWN_VALUE,
      totalLaps: 20,
      lapsRemaining: 12,
      currentLap: 8,
      numCars: 10,
      notStarted: false,
      scheduledLengthSec: UNKNOWN_VALUE,
      ...(over.session || {}),
    },
    player: {
      slotId: 1,
      position: 3,
      pedals: { throttle: 0, brake: 0, clutch: 0, steer: 0 },
      gear: 3,
      speedKph: 100,
      rpm: 5000,
      maxRpm: 8000,
      lap: {},
      tyres: { frontLeft: {}, frontRight: {}, rearLeft: {}, rearRight: {} },
      ...(over.player || {}),
    },
    standings: over.standings || [
      {
        slotId: 2, position: 2, driverName: 'John Smith', carClass: 'GT3',
        classPosition: 2, gapToAheadSec: 1.2, gapToLeaderSec: 4, lapsBehind: 0,
        bestLapSec: 140, lastLapSec: 141, lapsCompleted: 7, inPit: false, isPlayer: false,
      },
      {
        slotId: 1, position: 3, driverName: 'Carla Driver', carClass: 'GT3',
        classPosition: 3, gapToAheadSec: 2.41, gapToLeaderSec: 6.4, lapsBehind: 0,
        bestLapSec: 139.2, lastLapSec: 140.5, lapsCompleted: 7, inPit: false, isPlayer: true,
      },
      {
        slotId: 4, position: 4, driverName: 'Alex Jones', carClass: 'GT3',
        classPosition: 4, gapToAheadSec: 3.1, gapToLeaderSec: 9.5, lapsBehind: 0,
        bestLapSec: 141, lastLapSec: 142, lapsCompleted: 7, inPit: false, isPlayer: false,
      },
    ],
    relative: over.relative || [],
    weather: over.weather || { trackTempC: 30, ambientTempC: 22, rainIntensity: 0, trackWetness: 0, forecast: [] },
    fuel: over.fuel || {
      levelLiters: 40, capacityLiters: 80, perLapAvgLiters: 3,
      lapsRemaining: 12.4, lapsToFinish: 12, fuelToFinishLiters: 36,
      fuelDeltaLiters: 2, refuelToFinishLiters: 0,
    },
    ...over.rest,
  };
}

console.log('\n1) A live race carries the numbers the radio is allowed to speak');
{
  const s = engineerSummary(frame({}));
  check('not null', !!s);
  check('track', s.track === 'Spa');
  check('connected', s.connected === true);
  check('class', s.class === 'GT3');
  check('class position', s.classPosition === 3);
  check('fuel laps rounded', s.fuelLaps === 12.4);
  check('laps to finish', s.lapsToFinish === 12);
  check('last lap rounded', s.lastLapSec === 140.5);
  check('ahead is Smith with a gap', s.ahead && s.ahead.name === 'Smith' && s.ahead.gapSec === 2.4);
  check('behind is Jones', s.behind && s.behind.name === 'Jones');
  check('fuel to flag good (12.4 vs 12 to go)', s.fuelToFlag === 'good');
}

console.log('\n2) Unknown sentinels are omitted, not sent as -1');
{
  const s = engineerSummary(frame({
    fuel: {
      levelLiters: UNKNOWN_VALUE, capacityLiters: UNKNOWN_VALUE, perLapAvgLiters: UNKNOWN_VALUE,
      lapsRemaining: UNKNOWN_VALUE, lapsToFinish: UNKNOWN_VALUE, fuelToFinishLiters: UNKNOWN_VALUE,
      fuelDeltaLiters: UNKNOWN_VALUE, refuelToFinishLiters: 0,
    },
    standings: [{
      slotId: 1, position: UNKNOWN_VALUE, driverName: 'Me', isPlayer: true,
      gapToAheadSec: UNKNOWN_VALUE, gapToLeaderSec: UNKNOWN_VALUE, lapsBehind: 0,
      bestLapSec: UNKNOWN_VALUE, lastLapSec: UNKNOWN_VALUE, lapsCompleted: 0, inPit: false,
    }],
  }));
  check('no fuelLaps', s.fuelLaps === undefined);
  check('fuel to flag unknown', s.fuelToFlag === 'unknown');
  check('no last lap', s.lastLapSec === undefined);
  check('no position', s.position === undefined);
}

console.log('\n3) Tyres and damage leave as bands');
{
  const s = engineerSummary(frame({
    player: {
      slotId: 1, position: 3,
      pedals: { throttle: 0, brake: 0, clutch: 0, steer: 0 },
      gear: 3, speedKph: 100, rpm: 5000, maxRpm: 8000, lap: {},
      tyres: {
        frontLeft: { coreC: 90, optimalTempC: 90 },
        frontRight: { coreC: 91, optimalTempC: 90 },
        rearLeft: { coreC: 89, optimalTempC: 90 },
        rearRight: { coreC: 90, optimalTempC: 90 },
      },
      damage: { aero: 0, suspension: [0, 0, 0, 0], brakeThicknessMm: [0, 0, 0, 0], partsDetached: 0, worst: 0, hasDamage: false, repairSeconds: UNKNOWN_VALUE, repairBodySeconds: UNKNOWN_VALUE, repairSelection: '', repairOptions: [], tyreChangeSeconds: 0, tyreCornersSelected: 0, stopLengthSeconds: UNKNOWN_VALUE },
    },
  }));
  check('tyres in the window', s.tyres === 'in the window');
  check('damage none', s.damage === 'none');
  check('no raw repair when unknown', s.repairSec === undefined);
}

console.log('\n4) A missing frame is not a fake race');
{
  check('null in', engineerSummary(null) === null);
  check('empty in', engineerSummary(undefined) === null);
}

console.log('\n5) rival pace, the pit picture, and burn rates ride the summary');
{
  // The lap-history read Tier 1 owns, stubbed: slot 2 (ahead) has a 5-lap
  // window, the player 3 laps, slot 4 (behind) none yet.
  const windows = { 1: { avg: 140.84, count: 3 }, 2: { avg: 140.12, count: 5 } };
  const avgOf = (slotId) => windows[slotId] || null;
  const s = engineerSummary(frame({
    standings: [
      {
        slotId: 2, position: 2, driverName: 'John Smith', carClass: 'GT3',
        classPosition: 2, gapToAheadSec: 1.2, gapToLeaderSec: 4, lapsBehind: 0,
        bestLapSec: 140, lastLapSec: 141, lapsCompleted: 7, inPit: false, pitStops: 0, isPlayer: false,
      },
      {
        slotId: 5, position: 1, driverName: 'Ada Front', carClass: 'GT3',
        classPosition: 1, gapToAheadSec: 0, gapToLeaderSec: 0, lapsBehind: 0,
        bestLapSec: 139, lastLapSec: 140, lapsCompleted: 7, inPit: true, pitStops: 1, isPlayer: false,
      },
      {
        slotId: 1, position: 3, driverName: 'Carla Driver', carClass: 'GT3',
        classPosition: 3, gapToAheadSec: 2.41, gapToLeaderSec: 6.4, lapsBehind: 0,
        bestLapSec: 139.2, lastLapSec: 140.5, lapsCompleted: 7, inPit: false, pitStops: 1, isPlayer: true,
      },
      {
        slotId: 4, position: 4, driverName: 'Alex Jones', carClass: 'GT3',
        classPosition: 4, gapToAheadSec: 3.1, gapToLeaderSec: 9.5, lapsBehind: 0,
        bestLapSec: 141, lastLapSec: 142, lapsCompleted: 7, inPit: false, pitStops: 0, isPlayer: false,
      },
    ],
    fuel: {
      levelLiters: 40, capacityLiters: 80, perLapAvgLiters: 2.83,
      lapsRemaining: 12.4, lapsToFinish: 12, fuelToFinishLiters: 36,
      fuelDeltaLiters: 2, refuelToFinishLiters: 0,
      virtualEnergyPct: 60, virtualEnergyPerLapPct: 4.62,
      veCarsAheadPittingFirst: 1, veCarsAheadCompared: 2,
    },
  }), avgOf);
  check('ahead carries last lap', s.ahead && s.ahead.lastLapSec === 141);
  check('ahead carries the rolling average', s.ahead && s.ahead.avgLapSec === 140.1 && s.ahead.avgLaps === 5);
  check('ahead pit stops carried', s.ahead && s.ahead.pitStops === 0);
  check('behind has no average yet', s.behind && s.behind.avgLapSec === undefined);
  check('my average', s.myAvgLapSec === 140.8 && s.myAvgLaps === 3);
  check('my stops', s.myPitStops === 1);
  check('one class car ahead in the pits now', s.classAheadInPitNow === 1);
  check('one class car ahead yet to stop', s.classAheadNoStopYet === 1);
  check('energy projection carried', s.carsAheadPittingFirst === 1 && s.carsAheadCompared === 2);
  check('fuel burn per lap', s.fuelPerLapL === 2.8);
  check('energy burn per lap', s.energyPerLapPct === 4.6);
}

console.log('\n6) no history callback means no average fields, not zeros');
{
  const s = engineerSummary(frame({}));
  check('no myAvgLapSec', s.myAvgLapSec === undefined);
  check('ahead still present without averages', s.ahead && s.ahead.avgLapSec === undefined);
  check('no pit-projection fields without fuel data', s.carsAheadPittingFirst === undefined);
}

console.log('\n7) pit-this-lap is critical, yellows name the sector');
{
  const s = engineerSummary(frame({
    fuel: {
      levelLiters: 5, capacityLiters: 80, perLapAvgLiters: 3,
      lapsRemaining: 1.1, lapsToFinish: 10, fuelToFinishLiters: 30,
      fuelDeltaLiters: -25, refuelToFinishLiters: 25, pitThisLap: true, pitThisLapReason: 'fuel',
    },
    session: { sectorFlags: ['none', 'yellow', 'none'] },
  }));
  check('critical', s.fuelToFlag === 'critical' && s.pitThisLap === true);
  check('S2 yellow', s.yellows === 'S2');
}

if (fail) {
  console.log(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n${pass} passed`);
