/**
 * Checks for the fuel calculator's "PIT THIS LAP" alarm (no test framework in
 * this repo — plain node, run with `npm run test:fuel` after a build).
 *
 * The alarm's contract is not "the tank is low". It is: *from where you are
 * now, you cannot finish this lap and complete another one, even driving the
 * rest of it as economically as anyone realistically can — so come in at the
 * end of this one.* Two properties matter more than the arithmetic:
 *
 *   1. It has to arrive with the lap still ahead of the driver, not at the pit
 *      entry it is warning about. A running frame-by-frame comparison does not:
 *      both of its sides fall as the lap runs, so a car that starts the lap a
 *      hair inside the limit trips it a hair before the line. That is why the
 *      call is taken once, at the line, and the "fires within the first tenth of
 *      the lap" check below is the regression guard for it.
 *   2. It must not cry wolf on a lap a driver could have nursed home, because an
 *      alarm that is sometimes wrong is one drivers learn to drive through.
 */
const { FuelCalculator, resolvePitCall } = require(require('path').join(__dirname, '..', 'dist', 'telemetry', 'fuelCalculator.js'));

const FRAMES = 60;
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/**
 * Drive laps through the calculator.
 * @returns every frame as {lap, frac, fuel, alarm}, plus the final state.
 */
function drive(calc, opts) {
  const burn = opts.burn;
  const cap = opts.capacity === undefined ? 100 : opts.capacity;
  const totalRaceLaps = opts.totalRaceLaps === undefined ? 0 : opts.totalRaceLaps;
  let fuel = opts.startFuel;
  let done = opts.startLap === undefined ? 0 : opts.startLap;
  const frames = [];
  for (let l = 0; l < opts.laps; l++) {
    for (let i = 0; i < FRAMES; i++) {
      const frac = i / FRAMES;
      const s = calc.update({
        currentFuelLiters: fuel,
        capacityLiters: cap,
        lapsCompleted: done,
        totalRaceLaps,
        timeRemainingSec: -1,
        avgLapTimeSec: 90,
        lapFraction: frac,
      });
      frames.push({ lap: done, frac, fuel, alarm: s.pitThisLap === true, state: s });
      fuel = Math.max(0, fuel - burn / FRAMES);
    }
    done++;
  }
  return frames;
}

/** The first frame on which the alarm was raised, or null. */
const firstAlarm = (frames) => frames.find((f) => f.alarm) || null;

/** A calculator that already knows the car's burn rate (two clean laps of it). */
function primed(burn, startFuel, totalRaceLaps) {
  const c = new FuelCalculator();
  drive(c, { laps: 3, burn, startFuel: startFuel + burn * 3, totalRaceLaps: 0 });
  return c;
}

console.log('\n1) No claim without evidence');
{
  const c = new FuelCalculator();
  // One lap only: the burn rate is not known yet, so nothing may be asserted
  // however little is in the tank.
  const frames = drive(c, { laps: 1, burn: 3, startFuel: 1.5 });
  check('silent with no burn history', !firstAlarm(frames), 'raised on frame ' +
    (firstAlarm(frames) ? frames.indexOf(firstAlarm(frames)) : '-'));
}

console.log('\n2) Silent when there is plenty');
{
  const c = new FuelCalculator();
  const frames = drive(c, { laps: 6, burn: 3, startFuel: 60 });
  check('20 laps of fuel raises nothing', !firstAlarm(frames));
}

console.log('\n3) Raised when even saving will not get another lap round');
{
  // Per lap 3.0 L. At the line the car needs 2 laps at the saving rate
  // (2 x 2.7) plus reserve (0.15) = 5.55 L to skip the stop. Give it 5.3.
  const c = primed(3, 5.3, 0);
  const frames = drive(c, { laps: 1, burn: 3, startFuel: 5.3, startLap: 3 });
  const hit = firstAlarm(frames);
  check('alarm raised', !!hit);
  check('raised in the first tenth of the lap', !!hit && hit.frac <= 0.1,
    hit ? 'frac=' + hit.frac.toFixed(3) : 'never');
  check('stays up for the whole lap', frames.every((f) => f.frac < 0.02 || f.alarm),
    'clear frames=' + frames.filter((f) => !f.alarm).length);
}

console.log('\n4) Silent when saving WOULD get it round');
{
  // 5.9 L against the same 5.55 L requirement: tight, but a lap of saving does
  // it, so this is a save call and not a pit call.
  const c = primed(3, 5.9, 0);
  const frames = drive(c, { laps: 1, burn: 3, startFuel: 5.9, startLap: 3 });
  check('no alarm while saving still works', !firstAlarm(frames),
    firstAlarm(frames) ? 'frac=' + firstAlarm(frames).frac.toFixed(3) : 'silent');
}

console.log('\n5) The boundary lap still gets a full lap of warning');
{
  // Sitting a whisker the safe side of the limit at the line. A running
  // comparison raises this one at frac ~0.99 — right at the pit entry. The
  // per-lap decision holds it clear for this lap and raises it at the START of
  // the next, which is the lap it actually applies to.
  const c = primed(3, 5.6, 0);
  const frames = drive(c, { laps: 2, burn: 3, startFuel: 5.6, startLap: 3 });
  const lapOne = frames.filter((f) => f.lap === 3);
  const lapTwo = frames.filter((f) => f.lap === 4);
  check('clear on the lap it can still make', !lapOne.some((f) => f.alarm));
  const hit = lapTwo.find((f) => f.alarm);
  check('raised at the start of the next lap', !!hit && hit.frac <= 0.1,
    hit ? 'frac=' + hit.frac.toFixed(3) : 'never');
}

console.log('\n6) Never sent to the pits on the last lap of a race');
{
  // 18 of 19 laps done, so this is the final lap. Almost dry, but pitting now
  // would throw away the finish the alarm exists to protect.
  const c = new FuelCalculator();
  drive(c, { laps: 3, burn: 3, startFuel: 40, totalRaceLaps: 19 });
  const frames = drive(c, { laps: 1, burn: 3, startFuel: 4, startLap: 18, totalRaceLaps: 19 });
  check('silent on the final lap', !firstAlarm(frames));
}

console.log('\n7) Practice (no known race length) is still warned');
{
  const c = primed(3, 5.3, 0);
  const frames = drive(c, { laps: 1, burn: 3, startFuel: 5.3, startLap: 3, totalRaceLaps: 0 });
  check('unknown race length still raises', !!firstAlarm(frames));
}

console.log('\n8) Stranded mid-lap raises immediately, wherever the car is');
{
  // Attached with almost nothing left, part-way round: the line decision has
  // not been taken yet, so only the continuous net can catch this.
  const c = primed(3, 30, 0);
  const frames = drive(c, { laps: 1, burn: 3, startFuel: 0.9, startLap: 9 });
  const hit = firstAlarm(frames);
  check('raised without waiting for the line', !!hit && hit.frac < 0.35,
    hit ? 'frac=' + hit.frac.toFixed(3) : 'never');
}

console.log('\n9) Putting fuel in stands it down');
{
  const c = primed(3, 5.3, 0);
  const before = drive(c, { laps: 1, burn: 3, startFuel: 5.3, startLap: 3 });
  check('alarm was up', !!firstAlarm(before));
  // The stop: tank refilled, same lap counter (the in-lap has not finished).
  const after = c.update({
    currentFuelLiters: 60,
    capacityLiters: 100,
    lapsCompleted: 3,
    totalRaceLaps: 0,
    timeRemainingSec: -1,
    avgLapTimeSec: 90,
    lapFraction: 0.9,
  });
  check('cleared by refuelling', after.pitThisLap !== true);
}

console.log('\n10) A stop that adds LESS than the lap burned still stands it down');
{
  // The bug this guards: the stand-down used to compare the level against where
  // the lap STARTED, which is a whole lap stale by the time the driver reaches
  // their box. Take on two laps' worth after a lap that burned three and the
  // level is still below where the lap began, so the alarm never cleared — it
  // followed the driver out of the pits and round the next lap. Fuel going in is
  // the event; the level relative to some earlier moment is not.
  const c = primed(3, 5.3, 0);
  const frames = drive(c, { laps: 1, burn: 3, startFuel: 5.3, startLap: 3 });
  check('armed on the way in', !!firstAlarm(frames));
  // A splash of 2.0 L — less than the 3.0 L this lap has already burned.
  const topUp = c.update({
    currentFuelLiters: 4.3,
    capacityLiters: 100,
    lapsCompleted: 3,
    totalRaceLaps: 0,
    timeRemainingSec: -1,
    avgLapTimeSec: 90,
    lapFraction: 0.95,
  });
  check('a partial splash still clears it', topUp.pitThisLap !== true,
    'pitThisLap=' + topUp.pitThisLap);
}

console.log('\n11) Burning fuel never clears it');
{
  // The mirror of the check above: the stand-down must key on the level RISING,
  // so ordinary consumption can never be mistaken for a stop.
  const c = primed(3, 5.3, 0);
  const frames = drive(c, { laps: 1, burn: 3, startFuel: 5.3, startLap: 3 });
  check('stays up while the level only falls', frames.every((f) => f.frac < 0.02 || f.alarm),
    'clear frames=' + frames.filter((f) => !f.alarm).length);
}

console.log('\n12) Same arithmetic in energy units (percent)');
{
  // The virtual-energy channel runs the identical calculator over 0..100 %.
  // 4 % a lap, 7.2 % left: needs 2 x 3.6 + 0.2 = 7.4 to skip the stop.
  const c = new FuelCalculator();
  drive(c, { laps: 3, burn: 4, startFuel: 40, capacity: 100 });
  const frames = drive(c, { laps: 1, burn: 4, startFuel: 7.2, startLap: 3, capacity: 100 });
  const hit = firstAlarm(frames);
  check('energy budget raises the same call', !!hit && hit.frac <= 0.1,
    hit ? 'frac=' + hit.frac.toFixed(3) : 'never');
  const ok = new FuelCalculator();
  drive(ok, { laps: 3, burn: 4, startFuel: 40, capacity: 100 });
  const clear = drive(ok, { laps: 1, burn: 4, startFuel: 8.4, startLap: 3, capacity: 100 });
  check('and stays quiet when energy saving covers it', !firstAlarm(clear));
}

/* ---------------------------------------------------------------------------
 * 13) Resolving the call across BOTH budgets.
 *
 * Fuel and virtual energy each run their own calculator, and each publishes its
 * own `pitThisLap` inside the block it returns. That is the trap this guards:
 * merging the two and then spreading a decision over the top cannot switch the
 * alarm OFF, because "no alarm" is an absent key and an absent key does not
 * overwrite a present one. The in-pit suppression silently did nothing, and an
 * energy-driven alarm arrived with no reason attached — so it rendered with the
 * default wording and told a driver low on virtual energy to pit for FUEL, over
 * and over, right through the stop that fixed neither. That is precisely the
 * "I refuelled and it stayed on" report.
 * ------------------------------------------------------------------------- */
console.log('\n13) The pit call is resolved across both budgets, and can be cleared');
{
  // A block carrying a stale flag from whichever calculator set it.
  const armed = { levelLiters: 4, pitThisLap: true, pitThisLapReason: 'fuel' };

  const clear = resolvePitCall(armed, false, false, false);
  check('neither budget armed clears the flag', clear.pitThisLap === undefined,
    'pitThisLap=' + clear.pitThisLap);
  check('…and the reason with it', clear.pitThisLapReason === undefined);
  check('…without disturbing the rest of the block', clear.levelLiters === 4);

  const inPit = resolvePitCall(armed, true, true, true);
  check('in the pits it is silenced even with both armed', inPit.pitThisLap === undefined,
    'pitThisLap=' + inPit.pitThisLap);

  const fuelOnly = resolvePitCall(armed, true, false, false);
  check('fuel alone reads FUEL', fuelOnly.pitThisLap === true && fuelOnly.pitThisLapReason === 'fuel',
    fuelOnly.pitThisLapReason);

  // The one that was misreporting: energy is the binding budget, so the driver
  // must be sent to the energy row and not the fuel one.
  const energyOnly = resolvePitCall(armed, false, true, false);
  check('energy alone reads ENERGY, not FUEL',
    energyOnly.pitThisLap === true && energyOnly.pitThisLapReason === 'energy',
    energyOnly.pitThisLapReason);

  const both = resolvePitCall(armed, true, true, false);
  check('both armed names ENERGY, the tighter budget', both.pitThisLapReason === 'energy',
    both.pitThisLapReason);
}

/* ---------------------------------------------------------------------------
 * 14-16) The burn rate is the thing the alarm is built on.
 *
 * Laps-of-range is level divided by burn, so an overstated burn understates the
 * range in exact proportion — double the burn and a car with twenty laps in it
 * reads as having ten, then five, and eventually trips an alarm whose own
 * arithmetic was never wrong. That is the "it screamed at me with a full tank"
 * report, and every case below is a way the level moves WITHOUT being driven:
 * a new session loading the setup's fuel, a load edited in the garage, or the
 * calculator simply starting to watch part way round a lap.
 *
 * The outlier test cannot catch any of them on its own, because it needs a
 * rolling average to compare against and these all land on the FIRST sample —
 * the one that defines that average.
 * ------------------------------------------------------------------------- */

/** One frame at an explicit level / lap / road position. */
function frame(calc, o) {
  return calc.update({
    currentFuelLiters: o.fuel,
    capacityLiters: o.capacity === undefined ? 83 : o.capacity,
    lapsCompleted: o.lap,
    totalRaceLaps: o.totalRaceLaps === undefined ? 0 : o.totalRaceLaps,
    timeRemainingSec: -1,
    avgLapTimeSec: 90,
    lapFraction: o.frac === undefined ? 0 : o.frac,
  });
}

/** Burn rate reported on the last frame of a run. */
const finalPerLap = (frames) => frames[frames.length - 1].state.perLapAvgLiters;

console.log('\n14) A tank reloaded between sessions is not a lap of burn');
{
  const c = new FuelCalculator();
  // Practice, sat in the garage on a full tank without going out. Nobody
  // completes a lap, so the lap counter never runs backwards and nothing in the
  // data itself announces that the session changed.
  for (let i = 0; i < 5; i++) frame(c, { fuel: 83, lap: 0 });
  // The race loads what the setup asked for — 50.9 L — still on lap 0. Treated
  // as consumption this is a 34 L lap, fifteen times the real one, and the alarm
  // arrives on lap two of a race the car could run twenty laps of.
  const frames = drive(c, { laps: 4, burn: 2.2, startFuel: 50.9, capacity: 83 });
  const hit = firstAlarm(frames);
  check('no alarm on a car with twenty laps in it', !hit, hit ? 'lap ' + hit.lap : 'silent');
  check('the rate is the lap it actually drove', Math.abs(finalPerLap(frames) - 2.2) < 0.25,
    'perLap=' + finalPerLap(frames));
}

console.log('\n15) Fuel taken OUT in the garage is not fuel burned on track');
{
  const c = new FuelCalculator();
  frame(c, { fuel: 83, lap: 0, frac: 0 });
  frame(c, { fuel: 81.9, lap: 0, frac: 0.5 });
  // 8 L dropped out of the load part way through the lap: far more than a lap
  // burns, but well inside a quarter of the tank, so a size ceiling alone would
  // wave it through. Only knowing that the level was REWRITTEN rejects it.
  frame(c, { fuel: 73.9, lap: 0, frac: 0.51 });
  frame(c, { fuel: 72.8, lap: 0, frac: 0.99 });
  const after = frame(c, { fuel: 72.8, lap: 1, frac: 0 });
  check('the edited lap yields no burn rate at all', after.perLapAvgLiters < 0,
    'perLap=' + after.perLapAvgLiters);
  const frames = drive(c, { laps: 3, burn: 2.2, startFuel: 72.8, startLap: 1, capacity: 83 });
  check('and the clean laps after it measure normally',
    Math.abs(finalPerLap(frames) - 2.2) < 0.25, 'perLap=' + finalPerLap(frames));
}

console.log('\n16) Attaching part way round does not shrink the burn rate');
{
  // The same error the other way up, and the more dangerous one: a third of a
  // lap recorded as a whole lap triples the apparent range, and an alarm that
  // reads three laps of fuel as nine simply never fires.
  const c = new FuelCalculator();
  frame(c, { fuel: 40, lap: 5, frac: 0.7 });
  frame(c, { fuel: 39.4, lap: 5, frac: 0.99 });
  const after = frame(c, { fuel: 39.34, lap: 6, frac: 0 });
  check('the part-lap is not recorded as a lap', after.perLapAvgLiters < 0,
    'perLap=' + after.perLapAvgLiters);
  const frames = drive(c, { laps: 3, burn: 2.2, startFuel: 39.34, startLap: 6, capacity: 83 });
  check('the first whole lap after it sets the rate',
    Math.abs(finalPerLap(frames) - 2.2) < 0.25, 'perLap=' + finalPerLap(frames));
}

/* ---------------------------------------------------------------------------
 * 17-18) Matching the car's own dash.
 *
 * Both cases below came from holding the widget up against LMU's in-car fuel /
 * NRG readout on the same frame and asking why the two disagreed.
 * ------------------------------------------------------------------------- */

console.log('\n17) A lap through the pit lane is not a lap of burn');
{
  const c = new FuelCalculator();
  const green = drive(c, { laps: 4, burn: 2.2, startFuel: 60, capacity: 83 });
  check('green laps measure normally', Math.abs(finalPerLap(green) - 2.2) < 0.05,
    'perLap=' + finalPerLap(green));
  // The in-lap. Same lap of road, but driven to a pit box: half of it at the
  // limiter, so it burns half what a green lap burns. Averaged in, it says the
  // car has range it does not have — and the sim's own consumption log flags
  // exactly these laps, which is why its dash never showed them.
  let fuel = 51.2;
  for (let i = 0; i < FRAMES; i++) {
    c.update({
      currentFuelLiters: fuel, capacityLiters: 83, lapsCompleted: 4,
      totalRaceLaps: 0, timeRemainingSec: -1, avgLapTimeSec: 90,
      lapFraction: i / FRAMES, inPit: i > FRAMES * 0.9,
    });
    fuel -= 1.1 / FRAMES;
  }
  const after = c.update({
    currentFuelLiters: fuel, capacityLiters: 83, lapsCompleted: 5,
    totalRaceLaps: 0, timeRemainingSec: -1, avgLapTimeSec: 90,
    lapFraction: 0, inPit: true,
  });
  check('the pit lap never enters the average', Math.abs(after.perLapAvgLiters - 2.2) < 0.05,
    'perLap=' + after.perLapAvgLiters);
}

console.log('\n18) A practice clock is not a distance to be covered');
{
  // 2h43m of practice left, ninety-second laps: project it and the car is a
  // hundred laps and two hundred litres short of a "finish" nobody is driving
  // to. That is the −199.9 % margin the widget showed in red, sitting over a
  // tank with a dozen good laps in it.
  const at = (isRace) => {
    const c = new FuelCalculator();
    c.seedPerLap(2.2);
    return c.update({
      currentFuelLiters: 26.3, capacityLiters: 83, lapsCompleted: 3,
      totalRaceLaps: 0, timeRemainingSec: 9809, avgLapTimeSec: 90,
      lapFraction: 0, isRace,
    });
  };
  const prac = at(false), race = at(true);
  check('practice has no laps to the flag', prac.lapsToFinish === -1,
    'lapsToFinish=' + prac.lapsToFinish);
  check('…so nothing is projected to one',
    prac.fuelToFinishLiters === -1 && prac.fuelDeltaLiters === -1,
    'toFinish=' + prac.fuelToFinishLiters + ' margin=' + prac.fuelDeltaLiters);
  check('…and refuel-to-finish reads unknown, not a confident zero',
    prac.refuelToFinishLiters === -1, 'refuel=' + prac.refuelToFinishLiters);
  check('the same clock in a race still projects',
    race.lapsToFinish > 100 && race.fuelDeltaLiters < 0,
    'lapsToFinish=' + race.lapsToFinish + ' margin=' + race.fuelDeltaLiters);
  check('what is in the tank is true in either session',
    prac.lapsRemaining === race.lapsRemaining && prac.lapsRemaining > 11,
    'lapsRemaining=' + prac.lapsRemaining);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
