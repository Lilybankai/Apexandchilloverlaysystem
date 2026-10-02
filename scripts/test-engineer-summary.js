/**
 * scripts/test-engineer-summary.js — the bucketed payload Tier 2 is allowed to see.
 * -----------------------------------------------------------------------------
 * The proxy must never receive a raw telemetry frame. This suite checks the
 * summary builder: it carries the numbers a free-form question needs, it omits
 * missing data rather than sending -1, and tyres/damage leave as bands.
 */

'use strict';

const { engineerSummary, CLASS_STANDINGS_BUDGET } = require('../dist/telemetry/engineerSummary');
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
  // Summary v3: the litre-side numbers behind "how much fuel do I need to put
  // in" (answered wrongly by the cloud on 2026-08-20 for want of them).
  check('fuel litres carried', s.fuelL === 40 && s.tankL === 80);
  check('fuel to finish + margin carried', s.fuelToFinishL === 36 && s.fuelDeltaL === 2);
  check('refuel-to-finish carried', s.refuelToFinishL === 0);
  check('track and air temps carried', s.trackTempC === 30 && s.airTempC === 22);
  check('field size carried', s.carsTotal === 3 && s.carsInClass === 3);
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
  check('no fuel litres', s.fuelL === undefined && s.tankL === undefined);
  check('no refuel read without a projection', s.refuelToFinishL === undefined);
  check('no fuel ratio without both burns', s.fuelPerEnergyRatio === undefined);
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
  check('energy percent carried', s.energyPct === 60);
  check('fuel ratio derived from the burns (2.83/4.62)', s.fuelPerEnergyRatio === 0.61);
}

console.log('\n5b) trend/pit-exit extras copy onto the payload; absent extras add nothing');
{
  const s = engineerSummary(frame({}), undefined, {
    aheadTrendSecPerLap: 0.6,
    lapsToCatchAhead: 6,
    tyreWorstPct: 74,
    tyreWearPctPerLap: 3,
    tyreLapsLeft: 19,
    pitLossSec: 32,
    pitLossSamples: 1,
    pitExitPosition: 3,
    pitExitBehind: 'Brown',
    pitExitBehindGapSec: 10,
  });
  check('gap trend carried', s.aheadTrendSecPerLap === 0.6 && s.lapsToCatchAhead === 6);
  check('tyre life carried', s.tyreWorstPct === 74 && s.tyreLapsLeft === 19);
  check('pit projection carried', s.pitLossSec === 32 && s.pitExitPosition === 3 && s.pitExitBehind === 'Brown');
  const bare = engineerSummary(frame({}));
  check('no extras means no trend fields', bare.aheadTrendSecPerLap === undefined && bare.pitLossSec === undefined);
}

console.log('\n5c) resolved reference pace rides Tier 2 as precomputed targets and gaps');
{
  const s = engineerSummary(frame({
    player: {
      paceScore: {
        ok: true,
        percent: 104,
        bandLabel: 'Midpack',
        bandId: 'midpack',
        deltaSec: 4,
        refSec: 100,
        hotlapSec: 98,
        lapSec: 104,
        layoutName: 'Grand Prix',
        sheetClass: 'LMGT3',
        assumed: true,
        credit: { author: 'Ohne Speed', title: 'LMU laptimes', sheetUrl: 'https://example.test' },
      },
    },
  }));
  check('pace identity and source carried',
    s.paceLayout === 'Grand Prix' && s.paceClass === 'LMGT3' &&
      s.paceReferenceAssumed === true && s.paceReferenceSource === 'Ohne Speed');
  check('race and hotlap references stay distinct',
    s.paceAlienRaceSec === 100 && s.paceAlienHotlapSec === 98);
  check('named target times precomputed',
    s.paceCompetitiveSec === 101 && s.paceMidpackSec === 105);
  check('best, percentage and band carried',
    s.paceBestLapSec === 104 && s.pacePercent === 104 && s.paceBand === 'Midpack');
  check('target deltas precomputed',
    s.paceDeltaToAlienSec === 4 && s.paceDeltaToCompetitiveSec === 3 &&
      s.paceDeltaToMidpackSec === -1);
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

console.log('\n8) damage bands: the prompt\'s 0.04 floor, a lost part at least medium');
{
  const band = (worst, over = {}) => {
    const d = {
      aero: worst, suspension: [0, 0, 0, 0], brakeThicknessMm: [0, 0, 0, 0], partsDetached: 0, worst,
      hasDamage: worst > 0.005, repairSeconds: 12, repairBodySeconds: 12, repairSelection: '', repairOptions: [],
      tyreChangeSeconds: 0, tyreCornersSelected: 0, stopLengthSeconds: UNKNOWN_VALUE, ...over,
    };
    return engineerSummary(frame({
      player: {
        slotId: 1, position: 3, pedals: { throttle: 0, brake: 0, clutch: 0, steer: 0 },
        gear: 3, speedKph: 100, rpm: 5000, maxRpm: 8000, lap: {}, tyres: {}, damage: d,
      },
    })).damage;
  };
  // The HUD's noise floor (0.005) calls these minor; the engineer is not told.
  check('a 1% scuff is none', band(0.01) === 'none', band(0.01));
  check('a 3.9% scuff is none', band(0.039) === 'none', band(0.039));
  check('4% is light, as it always was', band(0.04) === 'light', band(0.04));
  check('major on the HUD is medium', band(0.2) === 'medium', band(0.2));
  check('critical on the HUD is heavy', band(0.6) === 'heavy', band(0.6));
  check('a lost part under the floor is still medium', band(0.01, { partsDetached: 1 }) === 'medium', band(0.01, { partsDetached: 1 }));
}

/* ---- summary v5 (2026-10-02): the timing sheet, sectors, tyre numbers ---- */

/** A class of `n` GT3s (plus `others` Hypercars mixed in), the player at class `me`. */
function field(n, me, over = {}) {
  const rows = [];
  for (let p = 1; p <= n; p++) {
    rows.push({
      slotId: 100 + p, position: p * 2, classPosition: p, carClass: 'GT3',
      driverName: `First Surname${p}`, carNumber: String(p + 10),
      gapToLeaderSec: 30 + (p - 1) * 2.5, gapToClassLeaderSec: (p - 1) * 2.5, gapToAheadSec: 2.5,
      lapsBehind: 0, classLapsBehind: 0, classLapsBehindExact: (p - 1) * 0.03,
      bestLapSec: 100 + p * 0.21, lastLapSec: 101 + p * 0.33,
      lastSector1Sec: 30 + p * 0.1, lastSector2Sec: 65 + p * 0.2,
      lapsCompleted: 9, inPit: false, pitStops: 1, isPlayer: p === me,
      ...(over[p] || {}),
    });
    rows.push({
      slotId: 500 + p, position: p * 2 - 1, carClass: 'HYPERCAR', classPosition: p,
      driverName: `Hyper Car${p}`, gapToLeaderSec: p, gapToClassLeaderSec: p, gapToAheadSec: 1,
      lapsBehind: 0, bestLapSec: 90, lastLapSec: 91, lapsCompleted: 10, inPit: false, isPlayer: false,
    });
  }
  return rows.sort((a, b) => a.position - b.position);
}

console.log('\n9) the class timing sheet: real rows, class-only, sorted, gaps from the class chain');
{
  const windows = { 104: { avg: 101.94, count: 4 } };
  const s = engineerSummary(frame({ standings: field(8, 6, { 4: { tyreCompound: 'Medium', pitStops: 2 } }) }), (id) => windows[id] || null);
  const sheet = s.classStandings;
  check('one row per class car, Hypercars excluded', sheet.length === 8, sheet.length);
  check('sorted by class position', sheet.map((r) => r.pos).join(',') === '1,2,3,4,5,6,7,8');
  check('the leader reads a real 0', sheet[0].gap === 0 && sheet[0].interval === undefined);
  const p4 = sheet[3];
  check('gap to class leader', p4.gap === 7.5, p4.gap);
  check('interval to the car in front', p4.interval === 2.5, p4.interval);
  check('toMe = seconds to the driver (P4 vs P6)', p4.toMe === 5, p4.toMe);
  check('last / best / avg / stops / tyre / car', p4.last === 102.3 && p4.best === 100.8 && p4.avg === 101.9 && p4.avgN === 4 &&
    p4.stops === 2 && p4.tyre === 'Medium' && p4.car === '14', JSON.stringify(p4));
  check('surname for the radio', p4.name === 'Surname4');
  const mine = sheet.find((r) => r.me);
  check('own row flagged, no toMe on it', mine && mine.pos === 6 && mine.toMe === undefined);
  check('not partial when the whole class fits', s.classStandingsPartial === undefined);
  check('no retirements → no classRetired', s.classRetired === undefined);
}

console.log('\n10) lapped cars: laps, never a wrapped seconds figure, never differenced floors');
{
  const UNK = UNKNOWN_VALUE;
  const s = engineerSummary(frame({
    standings: field(6, 2, {
      // P5 is 1.7 laps down, P6 2.2 — floors 1 and 2, but only 0.5 apart.
      5: { gapToClassLeaderSec: UNK, gapToLeaderSec: UNK, classLapsBehind: 1, classLapsBehindExact: 1.7 },
      6: { gapToClassLeaderSec: UNK, gapToLeaderSec: UNK, classLapsBehind: 2, classLapsBehindExact: 2.2, retired: true, inPit: true },
    }),
  }));
  const r5 = s.classStandings.find((r) => r.pos === 5);
  const r6 = s.classStandings.find((r) => r.pos === 6);
  check('lapped car carries lapsDown, no gap', r5.lapsDown === 1 && r5.gap === undefined, JSON.stringify(r5));
  check('lapped car to the driver: whole laps from the exact deficit', r5.lapsToMe === 1 && r5.toMe === undefined, JSON.stringify(r5));
  check('0.5 laps apart → no interval at all (floors 2−1 would say a lap)', r6.interval === undefined && r6.intervalLaps === undefined, JSON.stringify(r6));
  check('retired car is "out", not "inPit"', r6.out === true && r6.inPit === undefined);
  check('class retirements counted', s.classRetired === 1);
  // The driver themselves lapped: the leader block speaks laps, not seconds.
  const t = engineerSummary(frame({
    standings: field(4, 4, { 4: { gapToClassLeaderSec: UNK, gapToLeaderSec: UNK, classLapsBehind: 1, classLapsBehindExact: 1.2 } }),
  }));
  check('lapped driver: classLeader.lapsDown, no gapSec', t.classLeader.lapsDown === 1 && t.classLeader.gapSec === undefined, JSON.stringify(t.classLeader));
}

console.log('\n11) the leader block, own sectors, sector deltas');
{
  const s = engineerSummary(frame({ standings: field(5, 3) }), (id) => (id === 101 ? { avg: 101.5, count: 5 } : null));
  const L = s.classLeader;
  check('leader named, driver\'s gap to them', L.name === 'Surname1' && L.gapSec === 5, JSON.stringify(L));
  check('leader laps + average', L.lastLapSec === 101.3 && L.bestLapSec === 100.2 && L.avgLapSec === 101.5 && L.avgLaps === 5);
  // Leader: S1 30.1, S2 64.2-30.1... boundaries 30.1 / 65.2, lap 101.33.
  check('leader sectors from boundaries', JSON.stringify(L.sectorsSec) === JSON.stringify([30.1, 35.1, 36.13]), JSON.stringify(L.sectorsSec));
  check('own sectors', JSON.stringify(s.lastSectorsSec) === JSON.stringify([30.3, 35.3, 36.39]), JSON.stringify(s.lastSectorsSec));
  check('own minus leader, positive = slower', JSON.stringify(s.lastSectorsVsLeaderSec) === JSON.stringify([0.2, 0.2, 0.26]), JSON.stringify(s.lastSectorsVsLeaderSec));
  check('class-best of last-lap splits', JSON.stringify(s.classBestLastSectorsSec) === JSON.stringify([30.1, 35.1, 36.13]));
}

console.log('\n12) the player leads: no leader block, no deltas; missing sectors are omitted');
{
  const s = engineerSummary(frame({ standings: field(4, 1) }));
  check('no classLeader when the driver leads', s.classLeader === undefined);
  check('no deltas to a leader who is the driver', s.lastSectorsVsLeaderSec === undefined);
  check('own row is P1 with gap 0', s.classStandings[0].me === true && s.classStandings[0].gap === 0);
  const torn = engineerSummary(frame({
    standings: field(4, 2, {
      1: { lastSector1Sec: undefined, lastSector2Sec: undefined },
      2: { lastSector2Sec: UNKNOWN_VALUE },
    }),
  }));
  check('withheld own sectors → no lastSectorsSec', torn.lastSectorsSec === undefined);
  check('leader without sectors → no sectorsSec, no deltas',
    torn.classLeader.sectorsSec === undefined && torn.lastSectorsVsLeaderSec === undefined);
  const lone = engineerSummary(frame({ standings: [field(1, 1).find((e) => e.isPlayer)] }));
  check('a class of one has no sheet', lone.classStandings === undefined && lone.classLeader === undefined);
}

console.log('\n13) per-corner tyre numbers ride beside the band');
{
  const corner = (coreC, optimalTempC, pressureKpa, wear) => ({ tempC: coreC - 2, coreC, optimalTempC, pressureKpa, wear, compound: 'Medium' });
  const s = engineerSummary(frame({
    player: {
      tyres: {
        frontLeft: corner(84.4, 90, 171.6, 0.93), frontRight: corner(86, 90, 172, 0.91),
        rearLeft: corner(95.6, 90, 168, 0.97), rearRight: corner(97, 90, 169, 0.96),
      },
    },
  }));
  check('core temps per corner', JSON.stringify(s.tyreCoreC) === '[84,86,96,97]', JSON.stringify(s.tyreCoreC));
  check('one optimal when all agree', s.tyreOptimalC === 90);
  check('pressures, kPa', JSON.stringify(s.tyrePressureKpa) === '[172,172,168,169]');
  check('tread percent', JSON.stringify(s.tyreTreadPct) === '[93,91,97,96]');
  check('compound', s.tyreCompound === 'Medium');
  check('band still there', s.tyres === 'fronts in the window, rears in the window' || typeof s.tyres === 'string', s.tyres);
  const partial = engineerSummary(frame({}));
  check('no tyre numbers from empty corners', partial.tyreCoreC === undefined && partial.tyrePressureKpa === undefined && partial.tyreOptimalC === undefined);
}

console.log('\n14) payload size: a 34-car class stays well inside the 8000-char limit');
{
  // A worst case: Le Mans-length names, every optional field present, a
  // 34-car class plus 28 others, a race summary with every extra.
  const windows = {};
  const st = field(34, 28);
  for (const e of st) {
    if (e.carClass !== 'GT3') continue;
    e.driverName = 'Maximilian Wolfeschlegelsteinhausen';
    e.tyreCompound = 'Medium';
    e.pitStops = 12;
    windows[e.slotId] = { avg: 245.123, count: 5 };
  }
  const s = engineerSummary(frame({
    standings: st,
    player: { tyres: {
      frontLeft: { coreC: 84, optimalTempC: 90, pressureKpa: 171, wear: 0.9, compound: 'Medium' },
      frontRight: { coreC: 85, optimalTempC: 91, pressureKpa: 171, wear: 0.9, compound: 'Medium' },
      rearLeft: { coreC: 86, optimalTempC: 92, pressureKpa: 171, wear: 0.9, compound: 'Medium' },
      rearRight: { coreC: 87, optimalTempC: 93, pressureKpa: 171, wear: 0.9, compound: 'Medium' },
    } },
  }), (id) => windows[id] || null, {
    aheadTrendSecPerLap: 0.6, lapsToCatchAhead: 6, behindTrendSecPerLap: -0.3, tyreWorstPct: 74,
    tyreWearPctPerLap: 3, tyreLapsLeft: 19, fuelLastLapL: 7.2, energyLastLapPct: 8.7, pitLossSec: 32,
    pitLossSamples: 8, pitExitPosition: 3, pitExitBehind: 'Wolfeschlegelsteinhausen', pitExitBehindGapSec: 10,
    pitExitAheadOf: 'Wolfeschlegelsteinhausen', pitExitAheadOfGapSec: 4,
  });
  const sheetBytes = JSON.stringify(s.classStandings).length;
  const total = JSON.stringify(s).length;
  check('sheet within its byte budget', sheetBytes <= CLASS_STANDINGS_BUDGET, `${sheetBytes} <= ${CLASS_STANDINGS_BUDGET}`);
  check('whole summary well under 8000 (≤ 6000)', total <= 6000, total);
  check('trimmed sheet says so', s.classStandingsPartial === true);
  const pos = s.classStandings.map((r) => r.pos);
  check('leader, podium and the driver\'s window always kept',
    [1, 2, 3, 25, 26, 27, 28, 29, 30, 31].every((p) => pos.includes(p)), pos.join(','));
  check('still sorted by class position', pos.every((p, i) => i === 0 || p > pos[i - 1]));
  check('fills outward from the driver (P20 before P5)', pos.includes(20) && !pos.includes(5), pos.join(','));
  console.log(`        (worst case: ${pos.length} of 34 rows, sheet ${sheetBytes} B, summary ${total} B)`);
}

if (fail) {
  console.log(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n${pass} passed`);
