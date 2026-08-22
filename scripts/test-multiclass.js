/**
 * Regression checks for the multiclass derivations (no test framework in this
 * repo — plain node, run with `npm run test:multiclass` after a build).
 *
 * Covers:
 *  - car-class normalisation and speed ranking (`carClass.ts`);
 *  - position-in-class / gap-to-class-leader (`assignClassPositions`);
 *  - the standings->relative class-position join (`copyClassPositions`);
 *  - the blue-flag / backmarker yield rule (`yieldAlert.ts`).
 *
 * These are the derivations behind the standings tower's class groups and the
 * relative widget's yield banner. All are pure functions over plain objects, so
 * they are testable without a sim running.
 */
const path = require('path');
const dist = (m) => require(path.join(__dirname, '..', 'dist', 'telemetry', m));
const { normalizeClass, classRank, isFasterClass, assignClassPositions, copyClassPositions } =
  dist('carClass.js');
const { shouldYield, shouldWarnTraffic } = dist('yieldAlert.js');

const UNKNOWN = -1;
let pass = 0,
  fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* -------------------------------------------------------------------------- */
console.log('\n1) Class normalisation collapses LMU/mod spellings');

check('Hypercar aliases collapse',
  ['Hypercar', 'HYPER', 'LMH', 'LMDh', 'GTP'].every((s) => normalizeClass(s) === 'HYPERCAR'),
  ['Hypercar', 'HYPER', 'LMH', 'LMDh', 'GTP'].map(normalizeClass).join(','));
check('LMGT3 / GT3 collapse', normalizeClass('LMGT3') === 'GT3' && normalizeClass('GT3') === 'GT3');
check('punctuation + case ignored', normalizeClass('lm-gt3') === 'GT3', normalizeClass('lm-gt3'));
check('empty is undefined', normalizeClass('') === undefined && normalizeClass(null) === undefined);
// An unknown class must survive, upper-cased, so a mod field still groups.
check('unknown class passes through', normalizeClass('TCR Cup') === 'TCR CUP', normalizeClass('TCR Cup'));

console.log('\n2) Class ranking only asserts order between KNOWN classes');
check('Hypercar faster than GT3', isFasterClass('HYPERCAR', 'GT3'));
check('GT3 not faster than LMP2', !isFasterClass('GT3', 'LMP2'));
check('LMP3 faster than GT3', isFasterClass('LMP3', 'GT3'));
// The load-bearing one: an unknown class must never claim to be faster, or a mod
// entry would fire a blue flag at a car it is not actually catching.
check('unknown class is never "faster"', !isFasterClass('TCR CUP', 'GT3'));
check('nothing is faster than an unknown class', !isFasterClass('HYPERCAR', 'TCR CUP'));
check('undefined ranks last', classRank(undefined) >= classRank('GT4'));

/* -------------------------------------------------------------------------- */
console.log('\n3) Position in class and gap to class leader');

// A realistic multiclass order: HC leads, a GT3 running high, then the rest.
const rows = [
  { position: 1, carClass: 'HYPERCAR', gapToLeaderSec: 0, lapsBehind: 0 },
  { position: 2, carClass: 'HYPERCAR', gapToLeaderSec: 4.5, lapsBehind: 0 },
  { position: 3, carClass: 'GT3', gapToLeaderSec: 62.0, lapsBehind: 0 },
  { position: 4, carClass: 'HYPERCAR', gapToLeaderSec: 70.0, lapsBehind: 0 },
  { position: 5, carClass: 'GT3', gapToLeaderSec: 75.5, lapsBehind: 0 },
  // Lapped GT3: its seconds-behind figure is not comparable any more.
  { position: 6, carClass: 'GT3', gapToLeaderSec: UNKNOWN, lapsBehind: 1 },
];
assignClassPositions(rows);

check('class positions count within class',
  rows.map((r) => r.classPosition).join(',') === '1,2,1,3,2,3',
  rows.map((r) => r.classPosition).join(','));
check('class leader gap is 0', rows[2].gapToClassLeaderSec === 0);
check('gap is measured to the CLASS leader, not the race leader',
  rows[4].gapToClassLeaderSec === 13.5, String(rows[4].gapToClassLeaderSec));
check('overall leader still reads 0', rows[0].gapToClassLeaderSec === 0);
check('3rd Hypercar gap unaffected by the GT3 between them',
  rows[3].gapToClassLeaderSec === 70, String(rows[3].gapToClassLeaderSec));
// A lapped car must not report a seconds gap: the figure is meaningless once the
// two cars are no longer on the same lap.
check('lapped car reports unknown gap, not a number',
  rows[5].gapToClassLeaderSec === UNKNOWN, String(rows[5].gapToClassLeaderSec));
check('lapped car reports laps behind its class leader',
  rows[5].classLapsBehind === 1, String(rows[5].classLapsBehind));

// Class laps-behind must be relative to the CLASS leader, not the race leader:
// a whole class can be a lap down without any of them being lapped by each other.
const downClass = [
  { position: 1, carClass: 'HYPERCAR', gapToLeaderSec: 0, lapsBehind: 0 },
  { position: 8, carClass: 'GT3', gapToLeaderSec: UNKNOWN, lapsBehind: 2 },
  { position: 9, carClass: 'GT3', gapToLeaderSec: UNKNOWN, lapsBehind: 2 },
  { position: 12, carClass: 'GT3', gapToLeaderSec: UNKNOWN, lapsBehind: 3 },
];
assignClassPositions(downClass);
check('a whole class 2 laps down still leads its own class on lap 0',
  downClass[1].classLapsBehind === 0 && downClass[2].classLapsBehind === 0,
  downClass.map((r) => r.classLapsBehind).join(','));
check('the genuinely lapped GT3 reads 1 lap down in class',
  downClass[3].classLapsBehind === 1, String(downClass[3].classLapsBehind));

// The bug a beta tester photographed: two cars in the same class, on the same
// lap, fifteen seconds apart, with the OVERALL leader on the road between them.
// The sim steps `lapsBehind` per car as the leader goes past, so the two hold
// different values — and differencing them used to invent a lap that is not
// there. Counted off track position instead, the pair are level.
//
// Numbers are a real Barcelona-shaped race: ~1:44 laps, so 0.15 of a lap is the
// fifteen seconds the tester was actually looking at.
const leaderBetween = [
  // Hypercar leader, mid-lap on lap 20.
  { position: 1, carClass: 'HYPERCAR', gapToLeaderSec: 0, lapsBehind: 0, lapsCompleted: 20, lapFraction: 0.5 },
  // GT3 leader: the overall leader has passed it once since it started this lap.
  { position: 7, carClass: 'GT3', gapToLeaderSec: UNKNOWN, lapsBehind: 1, lapsCompleted: 18, lapFraction: 0.6 },
  // GT3 second, 0.15 of a lap back — and already passed a SECOND time, because
  // the leader is now between the two of them.
  { position: 9, carClass: 'GT3', gapToLeaderSec: UNKNOWN, lapsBehind: 2, lapsCompleted: 18, lapFraction: 0.45 },
];
assignClassPositions(leaderBetween);
check('the leader sitting between two GT3s does not put a lap between them',
  leaderBetween[2].classLapsBehind === 0,
  'classLapsBehind=' + leaderBetween[2].classLapsBehind);
check('and the class leader still reads level with itself',
  leaderBetween[1].classLapsBehind === 0, String(leaderBetween[1].classLapsBehind));

// The same field, one lap later for the second GT3: now genuinely a lap down.
const reallyLapped = [
  { position: 1, carClass: 'HYPERCAR', gapToLeaderSec: 0, lapsBehind: 0, lapsCompleted: 20, lapFraction: 0.5 },
  { position: 7, carClass: 'GT3', gapToLeaderSec: UNKNOWN, lapsBehind: 1, lapsCompleted: 18, lapFraction: 0.6 },
  { position: 12, carClass: 'GT3', gapToLeaderSec: UNKNOWN, lapsBehind: 2, lapsCompleted: 17, lapFraction: 0.45 },
];
assignClassPositions(reallyLapped);
check('a GT3 that really is a lap down still says so',
  reallyLapped[2].classLapsBehind === 1, String(reallyLapped[2].classLapsBehind));

// Either car crossing the line must not flicker the reading. The class leader
// has just started a new lap; the car behind has not reached the line yet.
const acrossTheLine = [
  { position: 7, carClass: 'GT3', gapToLeaderSec: 0, lapsBehind: 1, lapsCompleted: 19, lapFraction: 0.002 },
  { position: 8, carClass: 'GT3', gapToLeaderSec: 15.2, lapsBehind: 1, lapsCompleted: 18, lapFraction: 0.995 },
];
assignClassPositions(acrossTheLine);
check('the start/finish line between two cars is not a lap either',
  acrossTheLine[1].classLapsBehind === 0, String(acrossTheLine[1].classLapsBehind));
// And because they are level, the seconds come back: a car reading "+1L" is a
// car whose real gap the tower has stopped showing at all.
check('so the tower gets its seconds back instead of a phantom lap',
  acrossTheLine[1].gapToClassLeaderSec === 15.2,
  String(acrossTheLine[1].gapToClassLeaderSec));

// No track position published: the old difference is still the best available
// answer, and a sim that gives none must render exactly what it always did.
const noPosition = [
  { position: 1, carClass: 'GT3', gapToLeaderSec: 0, lapsBehind: 1, lapsCompleted: 18 },
  { position: 2, carClass: 'GT3', gapToLeaderSec: UNKNOWN, lapsBehind: 2, lapsCompleted: 17 },
];
assignClassPositions(noPosition);
check('without a track position it falls back to the difference',
  noPosition[1].classLapsBehind === 1, String(noPosition[1].classLapsBehind));

// A fraction outside 0..1 is a field that is not what we think it is. Discard
// it rather than clamp: a confident wrong answer is worse than the fallback.
const badFraction = [
  { position: 1, carClass: 'GT3', gapToLeaderSec: 0, lapsBehind: 1, lapsCompleted: 18, lapFraction: 0.5 },
  { position: 2, carClass: 'GT3', gapToLeaderSec: UNKNOWN, lapsBehind: 2, lapsCompleted: 17, lapFraction: 12.4 },
];
assignClassPositions(badFraction);
check('a nonsense lap fraction falls back rather than being clamped',
  badFraction[1].classLapsBehind === 1, String(badFraction[1].classLapsBehind));

/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */
console.log('\n3b) Class positions reach the relative panel by slot id, not by counting');

// The relative list is a handful of cars picked by PROXIMITY, so a class
// position counted within it would number a car by how many of its class happen
// to be nearby. The join must quote the standings' figure verbatim.
const std = [
  { slotId: 10, position: 1, carClass: 'HYPERCAR', gapToLeaderSec: 0, lapsBehind: 0 },
  { slotId: 11, position: 2, carClass: 'HYPERCAR', gapToLeaderSec: 4, lapsBehind: 0 },
  { slotId: 20, position: 9, carClass: 'GT3', gapToLeaderSec: 80, lapsBehind: 0 },
  { slotId: 21, position: 10, carClass: 'GT3', gapToLeaderSec: 84, lapsBehind: 0 },
  { slotId: 22, position: 11, carClass: 'GT3', gapToLeaderSec: 90, lapsBehind: 0 },
];
assignClassPositions(std);

// A GT3 in the middle of its own train: the two cars either side are the 2nd and
// 3rd of their class, and counting locally would call them 1st and 2nd.
const rel = [
  { slotId: 21, position: 10 },
  { slotId: 22, position: 11 },
];
copyClassPositions(std, rel);
check('a GT3 pair mid-field keeps its FIELD-WIDE class positions',
  rel[0].classPosition === 2 && rel[1].classPosition === 3,
  rel.map((r) => r.classPosition).join(','));

// Cars from different classes on the same screen each count in their own.
const mixed = [{ slotId: 11, position: 2 }, { slotId: 20, position: 9 }];
copyClassPositions(std, mixed);
check('each class counts in its own', mixed[0].classPosition === 2 && mixed[1].classPosition === 1,
  mixed.map((r) => r.classPosition).join(','));

// A car the standings cannot place must be LEFT alone — the widget reads an
// absent classPosition as "fall back to overall for the whole table", and a
// zero or a copied overall position would defeat that.
const unknownCar = [{ slotId: 99, position: 14 }];
copyClassPositions(std, unknownCar);
check('a car absent from the standings gets no class position',
  unknownCar[0].classPosition === undefined, String(unknownCar[0].classPosition));

// A single-class field still assigns positions; the widget, not the join,
// decides not to show them.
const solo = [{ slotId: 30, position: 1, carClass: 'GT3', gapToLeaderSec: 0, lapsBehind: 0 }];
assignClassPositions(solo);
const soloRel = [{ slotId: 30, position: 1 }];
copyClassPositions(solo, soloRel);
check('a single-class field still joins', soloRel[0].classPosition === 1,
  String(soloRel[0].classPosition));

// Empty inputs must not throw — both happen for a frame or two at session load.
copyClassPositions([], [{ slotId: 1, position: 1 }]);
copyClassPositions(std, []);
check('empty standings / empty relative are no-ops', true);

/* -------------------------------------------------------------------------- */
console.log('\n4) Blue-flag / backmarker yield rule');

const y = (o) => shouldYield({
  gapSec: -1.5, lapsDifference: 0, fasterClass: false, slowerClass: false,
  closingRateSec: 0.2, inPit: false, ...o,
});

check('faster class closing from behind fires', y({ fasterClass: true }));
check('a car a lap up fires even when not closing',
  y({ lapsDifference: 1, closingRateSec: -0.5 }));
// The direction test: a faster car AHEAD of us is not our problem.
check('faster class AHEAD on the road does not fire', !y({ fasterClass: true, gapSec: 2.0 }));
check('too far behind does not fire', !y({ fasterClass: true, gapSec: -4.0 }));
check('same class closing does not fire', !y({ fasterClass: false }));
// Without the closing test the banner latches on to a same-lap faster-class car
// that is circulating at the same pace and never actually arrives.
check('faster class NOT closing does not fire', !y({ fasterClass: true, closingRateSec: 0 }));
check('faster class pulling away does not fire', !y({ fasterClass: true, closingRateSec: -0.3 }));
check('unmeasured closing rate does not fire', !y({ fasterClass: true, closingRateSec: UNKNOWN }));
// A car in the pit lane is off the racing line; its road gap means nothing.
check('a car in the pits never fires', !y({ fasterClass: true, inPit: true }));
check('a lapped car in the pits never fires', !y({ lapsDifference: 1, inPit: true }));

/* -------------------------------------------------------------------------- */
console.log('\n5) Backmarker-ahead (ghost) rule — the mirror of the blue flag');

const t = (o) => shouldWarnTraffic({
  gapSec: 1.5, lapsDifference: 0, fasterClass: false, slowerClass: false,
  closingRateSec: 0.2, inPit: false, ...o,
});

check('a lapped car ahead that we are catching fires', t({ lapsDifference: -1 }));
check('a slower class ahead that we are catching fires', t({ slowerClass: true }));
// The direction test, and the one that matters most: this rule and the blue
// flag must never both fire on the same car, or the row would claim we owe a
// car a move AND have to pass it.
check('a car BEHIND us does not fire', !t({ gapSec: -1.5, lapsDifference: -1 }));
check('too far ahead does not fire', !t({ lapsDifference: -1, gapSec: 3.0 }));
// Unlike the blue flag, closing is required even for a lapped car: one holding
// station ahead of you is not a problem you are about to have.
check('a lapped car we are NOT closing on does not fire',
  !t({ lapsDifference: -1, closingRateSec: 0 }));
check('a lapped car pulling away does not fire',
  !t({ lapsDifference: -1, closingRateSec: -0.3 }));
check('unmeasured closing rate does not fire',
  !t({ lapsDifference: -1, closingRateSec: UNKNOWN }));
check('same class, same lap, ahead does not fire', !t({}));
// A faster car ahead of us is not traffic — it is simply gone.
check('a FASTER class ahead does not fire', !t({ fasterClass: true }));
check('an unknown class ahead does not fire (slowerClass false)', !t({}));
check('a car in the pits never fires', !t({ lapsDifference: -1, inPit: true }));

// Mutual exclusivity across the full sign range: no single car may ever be both
// a blue flag and a backmarker.
let bothFired = 0;
for (const gapSec of [-3, -2, -1, -0.5, 0.5, 1, 2, 3]) {
  for (const lapsDifference of [-1, 0, 1]) {
    for (const fasterClass of [true, false]) {
      for (const closingRateSec of [-0.3, 0, 0.2]) {
        const input = {
          gapSec, lapsDifference, fasterClass,
          slowerClass: !fasterClass && lapsDifference === 0 ? true : false,
          closingRateSec, inPit: false,
        };
        if (shouldYield(input) && shouldWarnTraffic(input)) bothFired++;
      }
    }
  }
}
check('no car is ever both a blue flag and a backmarker', bothFired === 0,
  bothFired + ' collisions');

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
