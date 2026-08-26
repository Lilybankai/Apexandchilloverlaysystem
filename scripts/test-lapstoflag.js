/**
 * scripts/test-lapstoflag.js — the laps-to-the-flag prediction.
 * -----------------------------------------------------------------------------
 * A lap-limited race's lap total belongs to the car WINNING it. Everyone else
 * runs for the same length of time and completes whatever their own pace
 * covers, so `totalLaps − leaderLaps` is the leader's answer being handed to
 * the whole field. In a single-class race that is harmless — everyone laps at
 * about the same rate — and in LMU's multiclass fields it is not.
 *
 * The pace figures below are real, taken from a live 24-car session at Sebring
 * on 2026-08-26: Hypercar best 93.59 s, LMP2 101.33 s, GT3 106.19 s.
 *
 * The other half of this file is the guard that made the probe worth running:
 * LMU's per-car `estimatedLapTime` is not per-car. Across those 24 cars it was
 * one identical value on every row, including cars with no laps at all. Nothing
 * here may treat two cars' paces as different unless they really are, and the
 * `paceSec <= leaderPaceSec` case exists so a field that collapses to one pace
 * degrades to the exact subtraction rather than to nonsense.
 *
 * No test framework in this repo — plain node, run with
 * `npm run test:lapstoflag`.
 */
'use strict';

const path = require('path');
const { predictLapsToFlag } = require(
  path.join(__dirname, '..', 'dist', 'telemetry', 'lapsToFlag.js'),
);

const UNKNOWN = -1;
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

// Real class paces, Sebring, 2026-08-26.
const HYPER = 93.59, LMP2 = 101.33, GT3 = 106.19;

/* -------------------------------------------------------------------------- */
console.log('\n1) A lap race: the leader owns the lap total, not the field');
{
  // Leader on lap 12 of 40 (11 done) => 29 laps still to run for them.
  const base = { totalLaps: 40, timeRemainingSec: UNKNOWN, leaderLapsCompleted: 11 };

  const hyper = predictLapsToFlag({ ...base, leaderPaceSec: HYPER, paceSec: HYPER });
  check('the leading class gets the exact subtraction',
    hyper.laps === 29 && hyper.estimated === false, hyper.laps + ' est=' + hyper.estimated);

  // 29 Hypercar laps is 2714 s of racing; a GT3 covers 25.6 of those, so 26.
  const gt3 = predictLapsToFlag({ ...base, leaderPaceSec: HYPER, paceSec: GT3 });
  check('a GT3 gets fewer laps than the Hypercar, and is hedged',
    gt3.laps === 26 && gt3.estimated === true, gt3.laps + ' est=' + gt3.estimated);
  check('which is the three laps the old subtraction was over by',
    29 - gt3.laps === 3, String(29 - gt3.laps));

  // LMP2 sits between the two, and the ordering must never invert.
  const lmp2 = predictLapsToFlag({ ...base, leaderPaceSec: HYPER, paceSec: LMP2 });
  check('LMP2 lands between Hypercar and GT3',
    lmp2.laps < hyper.laps && lmp2.laps > gt3.laps, `${hyper.laps} > ${lmp2.laps} > ${gt3.laps}`);
}

console.log('\n2) It never invents laps a car cannot run');
{
  const base = { totalLaps: 40, timeRemainingSec: UNKNOWN, leaderLapsCompleted: 11 };
  // A class quicker than the leader is a contradiction — the leader would not be
  // leading. Float noise between two similar laps must not manufacture one
  // either. Both fall back to the exact answer rather than reporting MORE laps
  // left than the leader themselves has.
  const quicker = predictLapsToFlag({ ...base, leaderPaceSec: GT3, paceSec: HYPER });
  check('a class quicker than the leader cannot gain laps',
    quicker.laps === 29 && quicker.estimated === false, quicker.laps + ' est=' + quicker.estimated);
  const noise = predictLapsToFlag({ ...base, leaderPaceSec: 93.59, paceSec: 93.5899 });
  check('float noise does not manufacture a prediction',
    noise.laps === 29 && noise.estimated === false, noise.laps + ' est=' + noise.estimated);

  // THE probe guard. LMU publishes one `estimatedLapTime` for the whole field;
  // feeding that in gives both cars the same pace, and the honest answer is the
  // subtraction, NOT a confident-looking prediction that every class shares.
  const collapsed = predictLapsToFlag({ ...base, leaderPaceSec: 108.777, paceSec: 108.777 });
  check('one pace for the whole field degrades to the exact answer',
    collapsed.laps === 29 && collapsed.estimated === false,
    collapsed.laps + ' est=' + collapsed.estimated);
}

console.log('\n3) A timed race divides the clock by the class pace');
{
  const base = { totalLaps: 0, leaderLapsCompleted: 40, leaderPaceSec: HYPER };
  // One hour left. A Hypercar fits 38.5 laps in it, a GT3 33.9.
  const hyper = predictLapsToFlag({ ...base, timeRemainingSec: 3600, paceSec: HYPER });
  const gt3 = predictLapsToFlag({ ...base, timeRemainingSec: 3600, paceSec: GT3 });
  check('the Hypercar gets its own lap count', hyper.laps === 39, String(hyper.laps));
  check('the GT3 gets fewer', gt3.laps === 34, String(gt3.laps));
  check('an hour of clock is five laps apart between the classes',
    hyper.laps - gt3.laps === 5, String(hyper.laps - gt3.laps));
  check('and both are hedged, because a clock is always a guess',
    hyper.estimated === true && gt3.estimated === true, '');
  // Rounded UP: a car mid-lap when the flag falls still brings that lap home.
  const part = predictLapsToFlag({ ...base, timeRemainingSec: 110, paceSec: GT3 });
  check('a part lap still counts as a lap to run', part.laps === 2, String(part.laps));
  const sliver = predictLapsToFlag({ ...base, timeRemainingSec: 3, paceSec: GT3 });
  check('and the last sliver is never zero laps', sliver.laps === 1, String(sliver.laps));
}

console.log('\n4) Missing inputs refuse rather than guess');
{
  const base = { totalLaps: 40, timeRemainingSec: UNKNOWN, leaderLapsCompleted: 11 };
  const noPace = predictLapsToFlag({ ...base, leaderPaceSec: UNKNOWN, paceSec: UNKNOWN });
  check('no pace at all still gives the leader-based subtraction',
    noPace.laps === 29 && noPace.estimated === false, noPace.laps + ' est=' + noPace.estimated);
  const halfPace = predictLapsToFlag({ ...base, leaderPaceSec: HYPER, paceSec: UNKNOWN });
  check('one pace missing is not enough for a ratio',
    halfPace.laps === 29 && halfPace.estimated === false, String(halfPace.laps));

  // A lap time of 3 s or 40 minutes is a broken field, not a fast car.
  const absurd = predictLapsToFlag({ ...base, leaderPaceSec: HYPER, paceSec: 2 });
  check('an absurd lap time is rejected, not believed', absurd.laps === 29, String(absurd.laps));

  const noClock = predictLapsToFlag({
    totalLaps: 0, timeRemainingSec: UNKNOWN, leaderLapsCompleted: 5,
    leaderPaceSec: HYPER, paceSec: GT3,
  });
  check('a timed race with no clock says nothing at all',
    noClock.laps === UNKNOWN, String(noClock.laps));
}

console.log('\n5) The end of the race');
{
  const done = predictLapsToFlag({
    totalLaps: 40, timeRemainingSec: UNKNOWN, leaderLapsCompleted: 40,
    leaderPaceSec: HYPER, paceSec: GT3,
  });
  check('the leader on the distance means zero laps left, as a fact not a guess',
    done.laps === 0 && done.estimated === false, done.laps + ' est=' + done.estimated);
  const past = predictLapsToFlag({
    totalLaps: 40, timeRemainingSec: UNKNOWN, leaderLapsCompleted: 41,
    leaderPaceSec: HYPER, paceSec: GT3,
  });
  check('and past it never goes negative', past.laps === 0, String(past.laps));
  // The final lap for a slower class is still a whole lap, never rounded away.
  const last = predictLapsToFlag({
    totalLaps: 40, timeRemainingSec: UNKNOWN, leaderLapsCompleted: 39,
    leaderPaceSec: HYPER, paceSec: GT3,
  });
  check('the last lap survives the ratio', last.laps === 1, String(last.laps));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
