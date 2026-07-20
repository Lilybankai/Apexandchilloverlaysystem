/**
 * Regression checks for the multiclass derivations (no test framework in this
 * repo — plain node, run with `npm run test:multiclass` after a build).
 *
 * Covers:
 *  - car-class normalisation and speed ranking (`carClass.ts`);
 *  - position-in-class / gap-to-class-leader (`assignClassPositions`);
 *  - the blue-flag / backmarker yield rule (`yieldAlert.ts`).
 *
 * These are the derivations behind the standings tower's class groups and the
 * relative widget's yield banner. All are pure functions over plain objects, so
 * they are testable without a sim running.
 */
const path = require('path');
const dist = (m) => require(path.join(__dirname, '..', 'dist', 'telemetry', m));
const { normalizeClass, classRank, isFasterClass, assignClassPositions } = dist('carClass.js');
const { shouldYield } = dist('yieldAlert.js');

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

/* -------------------------------------------------------------------------- */
console.log('\n4) Blue-flag / backmarker yield rule');

const y = (o) => shouldYield({
  gapSec: -1.5, lapsDifference: 0, fasterClass: false, closingRateSec: 0.2, inPit: false, ...o,
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
