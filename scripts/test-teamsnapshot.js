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
  pressureKpa: 160, optimalTempC: 90, compound: 'Soft',
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
  check('tyre prune drops surface temps', !('surfaceTempC' in s.car.tyres.frontLeft));
  check('fuel copied whole', s.fuel.virtualEnergyPct === 38.5 && s.fuel.levelLiters === 41.2);
  check('forecast pruned to timeline fields', s.weather.forecast[1].label === '50%'
    && !('trackTempC' in s.weather.forecast[1]));
  check('30 Hz noise pruned', !('pedals' in s.car) && !('radar' in s) && !('relative' in s));
  check('sentinels survive untouched (renderer owns them)', s.car.pit.elapsedSec === -1);
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

// ── The snapshot must be cheap: no giant arrays ride along ─────────────────
{
  const f = liveFrame();
  for (let i = 0; i < 60; i++) f.standings.push({ slotId: 100 + i, isPlayer: false, driverName: `x${i}` });
  const bytes = JSON.stringify(buildTeamSnapshot(f, 1)).length;
  check('snapshot stays small with a full grid', bytes < 4096, `${bytes} bytes`);
}

console.log(`\ntest-teamsnapshot: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
