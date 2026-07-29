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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
