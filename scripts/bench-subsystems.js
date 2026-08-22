/**
 * scripts/bench-subsystems.js — isolated hot-path pieces that scale with the grid.
 * -----------------------------------------------------------------------------
 * The live provider's poll() does more than the simulator: a whole-field
 * standings map, a class-position pass, a last-5-lap average, a radar
 * projection, a chassis step. Those are pure and already unit-tested; this
 * file times them at 12 / 36 / 62 cars so we can see which of them could
 * crowd a 33 ms budget before the overlay even draws.
 *
 * Shared-memory `readField` (up to 128 record decodes per poll) is Windows +
 * LMU only and is called out, not timed.
 *
 * Run: node scripts/bench-subsystems.js
 */

'use strict';

const path = require('node:path');
const {
  ROOT,
  DEFAULT_HZ,
  timeMany,
  fmtMs,
  pctOfBudget,
  printTable,
  heading,
} = require('./lib/bench-util');

function v(x, y, z) {
  return { x, y, z };
}

function fakeStandings(n) {
  const classes = ['HYPERCAR', 'LMP2', 'GT3'];
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      slotId: i + 1,
      position: i + 1,
      driverName: `D${i + 1}`,
      carNumber: String(i + 1),
      carClass: classes[i % 3],
      gapToLeaderSec: i * 0.8,
      gapToAheadSec: 0.8,
      lapsBehind: 0,
      bestLapSec: 110 + (i % 7) * 0.2,
      lastLapSec: 111 + (i % 5) * 0.15,
      lapsCompleted: 12 + (i % 3),
      inPit: i % 17 === 0,
      isPlayer: i === 8,
    });
  }
  return rows;
}

function fakeRadarCars(n) {
  const cars = [];
  for (let i = 0; i < n; i++) {
    cars.push({
      slotId: i + 2,
      pos: v((i % 9) * 8 - 32, 0, -20 - i * 3),
      carClass: i % 2 ? 'GT3' : 'HYPERCAR',
      carNumber: String(i + 2),
    });
  }
  return cars;
}

function run() {
  const { buildRadar, headingOri } = require(path.join(ROOT, 'dist', 'telemetry', 'radar.js'));
  const { assignClassPositions } = require(path.join(ROOT, 'dist', 'telemetry', 'carClass.js'));
  const { PaceAverageTracker } = require(path.join(ROOT, 'dist', 'telemetry', 'paceAverage.js'));
  const { ChassisTracker } = require(path.join(ROOT, 'dist', 'telemetry', 'chassis.js'));

  const ori = headingOri({ x: 0, z: -1 });
  const sizes = [12, 36, 62];
  const radar = [];
  const klass = [];
  const pace = [];

  for (const n of sizes) {
    const cars = fakeRadarCars(n);
    const input = { playerPos: v(0, 0, 0), ori, cars };
    radar.push({
      cars: n,
      ...timeMany(() => buildRadar(input), 800, 40).stats,
    });

    const rows = fakeStandings(n);
    klass.push({
      cars: n,
      ...timeMany(() => assignClassPositions(rows), 800, 40).stats,
    });

    // A fresh tracker per size, and a lap edge every call, so this times the
    // bookkeeping that actually runs when someone in the field takes a lap —
    // not the steady-state "nothing changed" path.
    const next = fakeStandings(n).map((r) => ({ ...r, lapsCompleted: r.lapsCompleted + 1 }));
    pace.push({
      cars: n,
      ...timeMany(() => {
        const tracker = new PaceAverageTracker();
        tracker.update(rows, 'bench|race');
        tracker.update(next, 'bench|race');
      }, 400, 20).stats,
    });
  }

  const chassis = new ChassisTracker();
  const corner = (loadN) => ({
    loadN,
    deflectionM: loadN / 165000,
    rideHeightM: 0.078,
    suspForceN: loadN * 0.92,
    gripFract: 0.95,
  });
  let clock = 100;
  const chassisStats = timeMany(() => {
    clock += 1 / 30;
    chassis.update(
      [corner(3200), corner(3100), corner(3400), corner(3300)],
      clock,
    );
  }, 800, 40).stats;

  const result = { radar, klass, pace, chassis: chassisStats };

  heading('6. Isolated subsystems (pure JS, scales with the grid)');
  printTable(
    [
      { key: 'name', label: 'work' },
      { key: 'c12', label: '12 cars', align: 'right' },
      { key: 'c36', label: '36 cars', align: 'right' },
      { key: 'c62', label: '62 cars', align: 'right' },
      { key: 'p99', label: '62-car p99', align: 'right' },
      { key: 'budget', label: '% of 30 Hz @62', align: 'right' },
    ],
    [
      line('buildRadar (whole field in range)', radar),
      line('assignClassPositions', klass),
      line('PaceAverageTracker.update', pace),
    ],
  );
  console.log(
    `\n  ChassisTracker.update (driven car only, no field):` +
      `  mean ${fmtMs(chassisStats.mean)}  p99 ${fmtMs(chassisStats.p99)}`,
  );
  console.log(
    `\n  Not timed here (needs Windows + LMU):` +
      `\n    lmuLocalCar.readField — scans up to 128 telemetry records every` +
      `\n    poll for radar + track map. This is the same buffer the 0.5.0 pedal-` +
      `\n    lag fix stopped copying whole. It is now one bounded sweep, not 8×,` +
      `\n    but it still runs on the 30 Hz thread next to the pedal read.`,
  );

  return result;
}

function line(name, series) {
  const a = series[0];
  const b = series[1];
  const c = series[2];
  return {
    name,
    c12: fmtMs(a.mean),
    c36: fmtMs(b.mean),
    c62: fmtMs(c.mean),
    p99: fmtMs(c.p99),
    budget: `${pctOfBudget(c.mean, DEFAULT_HZ).toFixed(2)}%`,
  };
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('[bench-subsystems] failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

module.exports = { run };
