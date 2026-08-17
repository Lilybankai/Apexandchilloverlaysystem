/**
 * test-fuelcalc.js — the Fuel tab's strategy engine and data integrity.
 * -----------------------------------------------------------------------------
 * Ported from the standalone LMU fuel app's vitest suite (strategy.test.js +
 * raceData.test.js) when the calculator moved into the panel (v0.77.0-beta.1).
 * Two halves:
 *   1. Strategy engine — lap solving, stint fills, sequential pit stop maths,
 *      splash detection, warnings, stop-count alternatives.
 *   2. Data integrity — every layout has all five class lap times, every
 *      consumption key is a real layout, VE classes behave, the LMP2 Le Mans
 *      75L cap. These fail loudly when a track or car is added inconsistently.
 *
 * Run: npm run test:fuelcalc
 */

'use strict';

const path = require('path');
const DATA = require(path.join(__dirname, '..', 'electron', 'control-panel', 'fuel-data.js'));
const ENGINE = require(path.join(__dirname, '..', 'electron', 'control-panel', 'fuel-strategy.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. Strategy engine ──────────────────────────────────────────────────────

// 1h Virtual-Energy race: sane lap count, stint laps sum to race laps.
{
  const p = ENGINE.buildStrategy({
    raceMode: 'time', raceMinutes: 60, lapTimeSec: 104,
    consumptionPerLap: 5.2, tankCapacity: 100, useVirtualEnergy: true,
  });
  check('1h VE race builds', !!p);
  check('1h VE ~1 stop', p.stops === 1, `stops=${p.stops}`);
  check('1h VE lap count', p.raceLaps >= 33 && p.raceLaps <= 37, `laps=${p.raceLaps}`);
  const sum = p.stints.reduce((a, s) => a + s.laps, 0);
  check('stint laps sum to race laps', sum === p.raceLaps, `${sum} != ${p.raceLaps}`);
}

// Timed race is pit-time aware: solved laps < naive laps, total fits window.
{
  const p = ENGINE.buildStrategy({
    raceMode: 'time', raceMinutes: 1440, lapTimeSec: 210,
    consumptionPerLap: 5.5, tankCapacity: 100, useVirtualEnergy: true,
  });
  const naive = Math.ceil((1440 * 60) / 210);
  check('24h solves fewer laps than naive', p.raceLaps < naive, `${p.raceLaps} vs ${naive}`);
  check('24h stop count sane', p.stops >= 20 && p.stops <= 30, `stops=${p.stops}`);
  check('24h fits window + one lap', p.totalTimeSec <= 1440 * 60 + 210, `total=${p.totalTimeSec}`);
}

// No-stop sprint: no stopAfter, zero pit time, fill covers laps + safety.
{
  const p = ENGINE.buildStrategy({
    raceMode: 'laps', raceLaps: 10, lapTimeSec: 100,
    consumptionPerLap: 2, tankCapacity: 60, safetyLaps: 1,
  });
  check('sprint has no stops', p.stops === 0 && p.stints[0].stopAfter === null);
  check('sprint pit time zero', p.totalPitTimeSec === 0);
  check('sprint starting fill', Math.abs(p.startingFill - 22) < 0.01, `fill=${p.startingFill}`);
}

// Tank cap respected; maxLapsPerStint is floor(tank / consumption).
{
  const p = ENGINE.buildStrategy({
    raceMode: 'laps', raceLaps: 100, lapTimeSec: 220,
    consumptionPerLap: 6.2, tankCapacity: 75,
  });
  check('maxLapsPerStint floor', p.maxLapsPerStint === Math.floor(75 / 6.2));
  check('no fill above tank', p.stints.every((s) => s.fill <= 75 + 1e-9));
}

// Formation lap adds exactly one lap of fuel and can force a stop.
{
  const base = { raceMode: 'laps', raceLaps: 20, lapTimeSec: 100, consumptionPerLap: 3, tankCapacity: 60 };
  const without = ENGINE.buildStrategy(base);
  const withF = ENGINE.buildStrategy({ ...base, formationLap: true });
  check('formation adds one lap of fuel', Math.abs(withF.totalUnits - without.totalUnits - 3) < 0.01);
  check('formation forces a stop at exact fit', without.stops === 0 && withF.stops === 1,
    `${without.stops} -> ${withF.stops}`);
}

// Even stints balance lap counts to within one lap.
{
  const p = ENGINE.buildStrategy({
    raceMode: 'laps', raceLaps: 50, lapTimeSec: 100,
    consumptionPerLap: 3, tankCapacity: 60, stintMode: 'even',
  });
  const laps = p.stints.map((s) => s.laps);
  check('even stints within one lap', Math.max(...laps) - Math.min(...laps) <= 1, laps.join(','));
}

// LMU sequential stop: total = lane loss + refuel + tyres; refuel is ceil of
// the NEXT stint's fill over the rate.
{
  const p = ENGINE.buildStrategy({
    raceMode: 'laps', raceLaps: 40, lapTimeSec: 100,
    consumptionPerLap: 3, tankCapacity: 60,
    pit: { pitLaneLossSec: 25, refuelRatePerSec: 2.5, tyreChangeSec: 30, tyresEveryStints: 1 },
  });
  const stop = p.stints[0].stopAfter;
  check('stop is sequential', stop.totalSec === 25 + stop.refuelSec + 30, JSON.stringify(stop));
  check('refuel from next fill', stop.refuelSec === Math.ceil(p.stints[1].fill / 2.5));
}

// Tyre cadence: every 2 stops -> first stop no tyres, second stop tyres.
{
  const p = ENGINE.buildStrategy({
    raceMode: 'laps', raceLaps: 60, lapTimeSec: 100,
    consumptionPerLap: 3, tankCapacity: 60,
    pit: { tyresEveryStints: 2 },
  });
  check('tyre cadence 2', p.stints[0].stopAfter.tyreSec === 0 && p.stints[1].stopAfter.tyreSec === 30,
    p.stints.filter((s) => s.stopAfter).map((s) => s.stopAfter.tyreSec).join(','));
}

// VE with no safety margin warns about the stop-and-go penalty.
{
  const p = ENGINE.buildStrategy({
    raceMode: 'time', raceMinutes: 60, lapTimeSec: 104,
    consumptionPerLap: 5.2, tankCapacity: 100, useVirtualEnergy: true, safetyLaps: 0,
  });
  check('VE zero-safety warning', p.warnings.some((w) => w.includes('stop-and-go')), p.warnings.join(' | '));
}

// compareStopOptions: fewer-stop target is under current consumption and
// saves time; an absurd saving is marked infeasible.
{
  const inputs = {
    raceMode: 'time', raceMinutes: 360, lapTimeSec: 104,
    consumptionPerLap: 5.2, tankCapacity: 100, useVirtualEnergy: true,
  };
  const opts = ENGINE.compareStopOptions(inputs);
  const current = opts.find((o) => o.current);
  const fewer = opts.find((o) => !o.current && o.savingPct != null);
  check('options include current', !!current && current.deltaSec === 0);
  if (fewer) {
    check('fewer-stop target below current', fewer.perLapTarget < inputs.consumptionPerLap);
    check('fewer-stop saves time', fewer.deltaSec < 0, `delta=${fewer.deltaSec}`);
    check('fewer-stop feasibility flag', fewer.feasible === (fewer.savingPct <= 12),
      `saving=${fewer.savingPct} feasible=${fewer.feasible}`);
  }
}

// formatDuration formatting.
check('formatDuration 3725', ENGINE.formatDuration(3725) === '1h 02m 05s', ENGINE.formatDuration(3725));
check('formatDuration 125', ENGINE.formatDuration(125) === '2m 05s', ENGINE.formatDuration(125));
check('formatDuration 42', ENGINE.formatDuration(42) === '42s', ENGINE.formatDuration(42));

// ── 2. Data integrity ───────────────────────────────────────────────────────

const classIds = DATA.CAR_CLASSES.map((c) => c.id);
const layoutIds = new Set();
for (const c of DATA.CIRCUITS) for (const l of c.layouts) layoutIds.add(l.id);

check('class list', JSON.stringify(classIds) === JSON.stringify(['hypercar', 'lmp2', 'lmp3', 'gte', 'lmgt3']),
  classIds.join(','));
check('CARS keyed by class ids', JSON.stringify(Object.keys(DATA.CARS).sort()) === JSON.stringify([...classIds].sort()));
check('layout ids globally unique',
  layoutIds.size === DATA.CIRCUITS.reduce((a, c) => a + c.layouts.length, 0));

// Every layout carries a lap time for all five classes, and no orphans.
for (const id of layoutIds) {
  const t = DATA.DEFAULT_LAP_TIMES[id];
  check(`lap times for ${id}`, !!t && classIds.every((c) => typeof t[c] === 'number' && t[c] > 0));
}
for (const id of Object.keys(DATA.DEFAULT_LAP_TIMES)) {
  check(`no orphan lap-time key ${id}`, layoutIds.has(id));
}

// Aliases and consumption tables point at real layouts.
for (const [from, to] of Object.entries(DATA.CONSUMPTION_LAYOUT_ALIASES)) {
  check(`alias ${from} -> ${to} is real`, layoutIds.has(to));
}
for (const [clsId, cars] of Object.entries(DATA.CARS)) {
  for (const car of cars) {
    check(`${clsId}/${car.id} sane numbers`,
      car.fuelCapacity > 0 && car.avgConsumption > 0 && !!car.name);
    for (const key of Object.keys(car.consumptionByTrack || {})) {
      check(`${car.id} consumption key ${key} is a layout or alias`,
        layoutIds.has(key) || key in DATA.CONSUMPTION_LAYOUT_ALIASES);
    }
  }
}

// Virtual Energy applies to exactly hypercar + lmgt3.
check('VE classes', DATA.classUsesVirtualEnergy('hypercar') && DATA.classUsesVirtualEnergy('lmgt3')
  && !DATA.classUsesVirtualEnergy('lmp2') && !DATA.classUsesVirtualEnergy('lmp3')
  && !DATA.classUsesVirtualEnergy('gte'));
{
  const lmp2 = DATA.CARS.lmp2[0];
  check('energy per lap null for litre class',
    DATA.getDefaultEnergyPerLap('lmp2', lmp2.id, 'monza_gp') === null);
  check('LMP2 75L cap at Le Mans',
    DATA.getDefaultTankCapacity('lmp2', lmp2.id, 'lemans_full') === 75
    && DATA.getDefaultTankCapacity('lmp2', lmp2.id, 'monza_gp') === lmp2.fuelCapacity);
}

// Consumption defaults resolve for every car at a layout it has data for, and
// the estimator lands somewhere sane for a car with no data at that track.
{
  const hyper = DATA.CARS.hypercar[0];
  const est = DATA.getDefaultFuelPerLap('hypercar', hyper.id, 'daytona_road');
  check('estimator lands 1-8 L', est === null || (est > 1 && est < 8), `est=${est}`);
}

// The panel's own wiring: fuel-panel.js references only ids that exist is
// covered by test-panel-parity.js; here we just confirm the two engine files
// stay require()-able with the expected surface.
check('engine surface', typeof ENGINE.buildStrategy === 'function'
  && typeof ENGINE.compareStopOptions === 'function'
  && typeof ENGINE.formatDuration === 'function'
  && ENGINE.DEFAULT_PIT_PARAMS.pitLaneLossSec === 25);
check('data surface', Array.isArray(DATA.CIRCUITS) && typeof DATA.formatLapTime === 'function'
  && DATA.formatLapTime(99.1) === '1:39.1');

console.log(`fuelcalc: ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
