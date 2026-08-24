/**
 * test-teamsnapshot.js — the Team tab's 1 Hz frame pruner.
 * -----------------------------------------------------------------------------
 * buildTeamSnapshot runs in main on every push while the Team tab is open, so
 * what matters is that it never throws on the frames a live feed actually
 * produces (demo frames, missing blocks, empty standings) and that identity
 * comes from the standings row flagged isPlayer — the seed of the Phase 2
 * relay payload (docs/TEAM-ENGINEER-PAGE.md).
 *
 * Run: npm run test:teamsnapshot
 */

'use strict';

const path = require('path');
const { buildTeamSnapshot } = require(path.join(__dirname, '..', 'electron', 'team-snapshot.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const tyre = (wear, temp) => ({
  wear, tempC: temp, coreC: temp + 1, innerC: temp + 2, middleC: temp, outerC: temp - 2,
  pressureKpa: 160, brakeTempC: temp * 4, optimalTempC: 90, compound: 'Soft',
  surfaceTempC: temp + 5, // pruned — must NOT survive into the snapshot
});

/** A representative live frame — only the fields the builder reads plus noise. */
function liveFrame() {
  return {
    schemaVersion: 1,
    source: 'lmu',
    connected: true,
    timestamp: 123,
    session: {
      type: 'race', phase: 'green', flag: 'green', track: 'Circuit de la Sarthe',
      trackConfig: 'Full', timeRemainingSec: 3600, scheduledLengthSec: 21600,
      totalLaps: 0, lapsRemaining: -1, currentLap: 42, numCars: 35,
      serverName: 'ACRL Endurance', onTrack: true,
    },
    player: {
      slotId: 7, position: 12,
      speedKph: 231, rpm: 7420, maxRpm: 8600, gear: 5,
      lap: { current: 215.2, last: 214.8, best: 213.1, delta: 0.4, sector: 2 },
      tyres: {
        frontLeft: tyre(0.8, 88), frontRight: tyre(0.75, 91),
        rearLeft: tyre(0.6, 95), rearRight: tyre(0.55, 97),
      },
      pit: { phase: 'none', working: false, elapsedSec: -1, plannedSec: -1, slackSec: -1, limiterOn: false },
      damage: { aero: 0.02, worst: 'aero', hasDamage: true, repairSeconds: 8, partsDetached: 0, suspension: [0, 0, 0, 0] },
      hybrid: { chargeFraction: 0.62, motorTorqueNm: 120 },
      pedals: { throttle: 1, brake: 0, clutch: 0 }, // pruned — 30 Hz noise
    },
    standings: [
      { slotId: 3, position: 1, driverName: 'Leader', isPlayer: false },
      {
        slotId: 7, position: 12, classPosition: 4, driverName: 'Carl',
        carNumber: '87', carClass: 'LMGT3', lapsCompleted: 41, inPit: false,
        pitStops: 2, isPlayer: true,
      },
    ],
    fuel: {
      levelLiters: 41.2, capacityLiters: 99, perLapAvgLiters: 2.9,
      lapsRemaining: 14.2, lapsToFinish: 16.8, fuelToFinishLiters: 48.7,
      fuelDeltaLiters: -7.5, refuelToFinishLiters: 8.2,
      virtualEnergyPct: 38.5, virtualEnergyPerLapPct: 4.4,
      virtualEnergyLapsRemaining: 8.75, virtualEnergyDeltaPct: -35.4,
    },
    weather: {
      trackTempC: 31, ambientTempC: 24, rainIntensity: 0, trackWetness: 0,
      trackCondition: 'DRY', trackTrend: 'steady',
      forecast: [
        { minutesAhead: 0, rainChance: 0, rainIntensity: 0, trackTempC: 31 },
        { minutesAhead: 30, label: '50%', rainChance: 0.7, rainIntensity: 0.4, trackTempC: 26 },
      ],
    },
    radar: { blips: [] },   // pruned
    relative: [],           // pruned
  };
}

// ── A live frame prunes to the page's shape ────────────────────────────────
{
  const s = buildTeamSnapshot(liveFrame(), 1000);
  check('live frame builds', !!s);
  check('at is the passed clock', s.at === 1000);
  check('connected carried', s.connected === true);
  check('identity from the isPlayer row', s.car.driverName === 'Carl' && s.car.carClass === 'LMGT3');
  check('class position from standings', s.car.classPosition === 4, `cp=${s.car.classPosition}`);
  check('pit stops from standings', s.car.pitStops === 2);
  check('tyres survive per corner', s.car.tyres.rearRight.wear === 0.55);
  check('brake temps survive per corner', s.car.tyres.frontLeft.brakeTempC === 88 * 4);
  check('tyre prune drops surface temps', !('surfaceTempC' in s.car.tyres.frontLeft));
  check('speed/rpm/gear carried for the telemetry card', s.car.speedKph === 231
    && s.car.rpm === 7420 && s.car.maxRpm === 8600 && s.car.gear === 5);
  check('lap delta carried', s.car.lap.delta === 0.4);
  check('fuel copied whole', s.fuel.virtualEnergyPct === 38.5 && s.fuel.levelLiters === 41.2);
  check('forecast pruned to timeline fields', s.weather.forecast[1].label === '50%'
    && !('trackTempC' in s.weather.forecast[1]));
  check('30 Hz noise pruned', !('pedals' in s.car) && !('radar' in s) && !('relative' in s));
  check('sentinels survive untouched (renderer owns them)', s.car.pit.elapsedSec === -1);
  check('standings carried for the timing sheet', s.standings.length === 2
    && s.standings[1].avg5Sec === undefined && s.standings[0].driverName === 'Leader');
}

// ── Frames the feed actually produces must not throw ───────────────────────
{
  const demo = liveFrame();
  demo.connected = false;
  demo.standings = [];
  check('demo frame with empty standings builds', !!buildTeamSnapshot(demo, 1)
    && buildTeamSnapshot(demo, 1).car.driverName === undefined);

  const bare = { session: { type: 'practice' }, player: {} };
  const s = buildTeamSnapshot(bare, 1);
  check('bare frame builds with nulls', !!s && s.car.tyres === null && s.fuel === null && s.weather === null);

  check('null frame → null', buildTeamSnapshot(null, 1) === null);
  check('frame without player → null', buildTeamSnapshot({ session: {} }, 1) === null);
  check('frame without session → null', buildTeamSnapshot({ player: {} }, 1) === null);
  check('garbage → null', buildTeamSnapshot('nope', 1) === null);
}

// ── Track map block prunes to placement fields ─────────────────────────────
{
  const f = liveFrame();
  f.trackMap = {
    key: 'sarthe', revision: 3, ready: true, progress: 1,
    cars: [{ slotId: 7, x: 120.5, y: 2, z: -80.1, lapFraction: 0.42, inPit: false, isPlayer: true }],
  };
  const s = buildTeamSnapshot(f, 1);
  check('track map cars carried', s.trackMap.cars.length === 1 && s.trackMap.cars[0].x === 120.5);
  check('track map elevation pruned', !('y' in s.trackMap.cars[0]));
  check('track map revision carried', s.trackMap.revision === 3 && s.trackMap.ready === true);
}

// ── The snapshot must stay cheap even with a full grid ─────────────────────
{
  const f = liveFrame();
  for (let i = 0; i < 60; i++) {
    f.standings.push({
      slotId: 100 + i, isPlayer: false, driverName: `Driver ${i}`, carClass: 'LMP2',
      position: i + 3, classPosition: i + 1, lastLapSec: 220, bestLapSec: 218, avg5Sec: 221,
      gapToLeaderSec: i * 3, gapToAheadSec: 3, lapsCompleted: 40, pitStops: 2,
    });
  }
  const bytes = JSON.stringify(buildTeamSnapshot(f, 1)).length;
  check('snapshot stays modest with a full grid', bytes < 20480, `${bytes} bytes`);
}

console.log(`\ntest-teamsnapshot: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
