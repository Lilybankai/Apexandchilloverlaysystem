/**
 * scripts/test-demo-realism.js — demo mode drives like a race, not like a demo.
 * -----------------------------------------------------------------------------
 * The simulator is what every overlay shows when the sim is not running, and
 * what a launch video is shot against. It used to be sine waves and timers:
 * inputs that fluttered, a track-limits charge every 35 s, damage that came
 * and went on a clock, a pit stop every 100 s with the car still moving. This
 * pins the properties that make it read as a real stint instead — measured
 * over a twenty-minute run at the overlay's own 30 Hz, so a regression back
 * toward the flutter shows up as a number, not an opinion.
 *
 * Run: node scripts/test-demo-realism.js
 */

'use strict';

const { SimulatorProvider, DEMO_PROFILE_LAP_SEC } = require('../dist/telemetry/simulatorProvider');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

const HZ = 30;
const dt = 1 / HZ;
const MINUTES = 20;

/* ------------------------------ the drive ------------------------------ */

const sim = new SimulatorProvider();
let t = 0;
const frames = [];
for (let i = 0; i < HZ * 60 * MINUTES; i++) {
  t += dt;
  frames.push(sim.poll(t * 1000, dt * 1000));
}
const green = frames.filter((f) => f.session.phase === 'green');
const onTrack = green.filter((f) => f.player.pit.phase === 'none');
const player = (f) => f.player;

console.log('\nthe car\n');
{
  const speeds = onTrack.map((f) => player(f).speedKph);
  check('the car reaches a real top speed', Math.max(...speeds) > 240, Math.max(...speeds));
  check('…and slows to a real hairpin speed', Math.min(...speeds) < 90 && Math.min(...speeds) > 40, Math.min(...speeds));

  // No flutter: speed cannot change faster than the car can accelerate or
  // brake, and the pedals move like a foot, not like noise.
  let maxDv = 0;
  let maxDthr = 0;
  let maxDbrk = 0;
  for (let i = 1; i < onTrack.length; i++) {
    const a = player(onTrack[i - 1]);
    const b = player(onTrack[i]);
    if (a.lap.current > b.lap.current) continue; // the line, or a reset
    maxDv = Math.max(maxDv, Math.abs(b.speedKph - a.speedKph));
    maxDthr = Math.max(maxDthr, Math.abs(b.pedals.throttle - a.pedals.throttle));
    maxDbrk = Math.max(maxDbrk, Math.abs(b.pedals.brake - a.pedals.brake));
  }
  check('speed never jumps more than a real car can in one frame', maxDv <= 2.5, `${maxDv.toFixed(2)} km/h per frame`);
  check('throttle moves like a foot, not noise', maxDthr <= 0.5, maxDthr.toFixed(2));
  check('brake moves like a foot, not noise', maxDbrk <= 0.5, maxDbrk.toFixed(2));

  const flat = onTrack.filter((f) => player(f).speedKph > 230);
  const flatAtFull = flat.filter((f) => player(f).pedals.throttle >= 0.99).length / Math.max(1, flat.length);
  check('flat out on the straights means full throttle', flatAtFull > 0.8, `${(flatAtFull * 100).toFixed(0)}% of frames >230 km/h`);

  const gears = new Set(onTrack.map((f) => player(f).gear));
  check('the gearbox is used top to bottom', gears.has(2) && gears.has(6), [...gears].sort().join(','));
  let shifts = 0;
  for (let i = 1; i < onTrack.length; i++) if (player(onTrack[i]).gear !== player(onTrack[i - 1]).gear) shifts++;
  const laps = onTrack.length / (HZ * DEMO_PROFILE_LAP_SEC);
  check('a plausible number of gear changes per lap', shifts / laps > 12 && shifts / laps < 60, (shifts / laps).toFixed(1));

  // The revs saw: they reach the shift band and drop after each upshift.
  const nearShift = onTrack.filter((f) => player(f).rpm >= 8400).length;
  check('the shift band is reached', nearShift > 0, nearShift);
  let dropAfterUp = 0;
  let ups = 0;
  for (let i = 1; i < onTrack.length; i++) {
    const a = player(onTrack[i - 1]);
    const b = player(onTrack[i]);
    if (b.gear === a.gear + 1) {
      ups++;
      if (b.rpm < a.rpm - 400) dropAfterUp++;
    }
  }
  check('revs drop on every upshift', ups > 0 && dropAfterUp === ups, `${dropAfterUp}/${ups}`);

  const lapTimes = [];
  for (let i = 1; i < green.length; i++) {
    if (player(green[i]).lap.last !== player(green[i - 1]).lap.last) lapTimes.push(player(green[i]).lap.last);
  }
  const clean = lapTimes.filter((s) => s < 115);
  check('lap times land near the profile pace', clean.length > 3 && clean.every((s) => s > DEMO_PROFILE_LAP_SEC - 2 && s < DEMO_PROFILE_LAP_SEC + 8), clean.map((s) => s.toFixed(1)).join(' '));
  check('…and are not all identical', new Set(clean.map((s) => s.toFixed(1))).size > 2);

  const deltas = onTrack.map((f) => Math.abs(player(f).lap.delta));
  // Out-laps legitimately carry a +10 s delta; the flutter this guards
  // against was a delta that swung on its own.
  check('the live delta stays in a believable band on track', Math.max(...deltas) < 20, Math.max(...deltas).toFixed(1));
}

console.log('\nthe race\n');
{
  // Positions change like a timing screen: a few per lap at most, not
  // flickering — and never back and forth within a few seconds.
  const pos = green.map((f) => player(f).position);
  let changes = 0;
  let flips = 0;
  let lastChangeAt = -1e9;
  for (let i = 1; i < pos.length; i++) {
    if (pos[i] !== pos[i - 1]) {
      changes++;
      // Cars filing into the pits together do swap on a timing screen; a
      // flip on the road within seconds is the thing that must not happen.
      if (i - lastChangeAt < HZ * 8 && player(green[i]).pit.phase === 'none') flips++;
      lastChangeAt = i;
    }
  }
  const raceLaps = green.length / (HZ * DEMO_PROFILE_LAP_SEC);
  check('position changes are occasional', changes / raceLaps < 4, `${changes} in ${raceLaps.toFixed(1)} laps`);
  check('…and do not flip back within seconds', flips <= 3, flips);

  const order = green.map((f) => f.standings.map((s) => s.slotId).join(','));
  let fieldChanges = 0;
  for (let i = 1; i < order.length; i++) if (order[i] !== order[i - 1]) fieldChanges++;
  check('the field order settles between events', fieldChanges / raceLaps < 12, `${fieldChanges} in ${raceLaps.toFixed(1)} laps`);

  // Track limits: rare, and at a corner exit.
  const charges = [];
  for (let i = 1; i < green.length; i++) {
    const a = player(green[i - 1]).trackLimits;
    const b = player(green[i]).trackLimits;
    if (a && b && b.charged > a.charged) charges.push(i);
  }
  check('a track-limits charge is seen early on', charges.length >= 1 && charges[0] < HZ * 240, charges[0]);
  check('…but charges are rare', charges.length / raceLaps < 0.5, `${charges.length} in ${raceLaps.toFixed(1)} laps`);

  // Yellows: a few, not a rail that blinks.
  let yellows = 0;
  for (let i = 1; i < green.length; i++) {
    const a = green[i - 1].session.sectorFlags.includes('yellow');
    const b = green[i].session.sectorFlags.includes('yellow');
    if (b && !a) yellows++;
  }
  check('sector yellows are occasional', yellows >= 1 && yellows <= 4, yellows);

  // The stop: called by fuel, taken once, at a standstill.
  const stopped = green.filter((f) => player(f).pit.phase === 'stopped');
  check('the car makes one fuel stop in twenty minutes', stopped.length > 0);
  check('…standing still in the box', stopped.every((f) => player(f).speedKph === 0 && player(f).gear === 0));
  check('…for the booked time', stopped.length / HZ > 15 && stopped.length / HZ < 60, `${(stopped.length / HZ).toFixed(1)} s`);
  const beforeStop = green.findIndex((f) => player(f).pit.phase === 'entering');
  const firstStopIdx = green.findIndex((f) => player(f).pit.phase === 'stopped');
  const afterStop = green.slice(firstStopIdx).find((f) => player(f).pit.phase === 'none');
  check('fuel is low before the stop and full after it', green[beforeStop].fuel.levelLiters < 10 && afterStop.fuel.levelLiters > 30, `${green[beforeStop].fuel.levelLiters} → ${afterStop.fuel.levelLiters}`);
  check('the fuel widget called the stop first', green.slice(0, beforeStop).some((f) => f.fuel.pitThisLap === true));
  const lane = green.filter((f) => player(f).pit.phase === 'entering' || player(f).pit.phase === 'exiting');
  check('the lane is driven on the limiter', lane.every((f) => player(f).speedKph <= 65 && player(f).pit.limiterOn));

  // Damage does not flicker: either carried until the stop, or never there.
  const dmg = green.map((f) => (player(f).damage ? player(f).damage.stopLengthSeconds : 0));
  let dmgFlips = 0;
  for (let i = 1; i < dmg.length; i++) if (dmg[i] > 40 !== dmg[i - 1] > 40) dmgFlips++;
  check('damage does not come and go on a clock', dmgFlips <= 2, dmgFlips);

  // The weather is a dry race with a forecast, not a shower every ten minutes.
  const wet = green.filter((f) => f.weather.rainIntensity > 0).length / green.length;
  check('mostly dry', wet < 0.3, `${(wet * 100).toFixed(0)}% of frames wet`);
}

console.log(`\ntest-demo-realism: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
