/**
 * scripts/test-sequences.js — linked corners, on one lap and across a session.
 * -----------------------------------------------------------------------------
 * `cornerSequences.ts` decides which corners the coach talks about as one
 * (chicanes, esses, the Porsche Curves) and whether the driver traded time
 * between them or carried a loss through. Wrong answers here read as
 * confident coaching ("you lose 0.1 s in C7" when C8 won it back), so:
 *
 *   §1 the trade / carry / linked rule on hand-made losses;
 *   §2 which corners link on one lap: short reference exit run, never flat
 *      between, the catalogue's list — and NOT a long straight, and not
 *      "never flat" on a lap with no throttle channel;
 *   §3 a session of seeded laps: a chicane that trades, a complex that
 *      carries, two corners a straight apart that correlate (fuel, tyres)
 *      and must NOT be returned, too few laps, a catalogue sequence with no
 *      pattern;
 *   §4 a real Le Mans pair: the Porsche Curves and the Ford chicanes come out
 *      as sequences.
 *
 * Run: npm run test:sequences
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  findSequences,
  sessionSequences,
  linkedToNext,
  kindOf,
  pearson,
  LINK_GAP_M,
  SESSION_MIN_LAPS,
} = require('../dist/telemetry/cornerSequences');
const { lapLoss } = require('../dist/telemetry/timeLoss');
const { findCorners } = require('../dist/telemetry/corners');

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

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

/* ------------------------- hand-made breakdowns --------------------------- */

const L = 5000;
const pts = (over = {}) => ({
  brakeOnD: null,
  brakeOffD: null,
  turnInD: null,
  apexD: null,
  pickupD: 0.5,
  fullThrottleD: 0.5,
  entryKph: null,
  minKph: null,
  exitKph: null,
  topKph: null,
  ...over,
});

/**
 * A breakdown from rows of { id, loss, runM (reference exit run, metres),
 * neverFlat?, noThrottle? }, laid out every 400 m.
 */
function makeB(rows, withLength = true) {
  let s = 100;
  const corners = rows.map((r, k) => {
    const entryD = s / L;
    const apexD = (s + 60) / L;
    const exitD = (s + 120) / L;
    const runEndD = exitD + (r.runM ?? 300) / L;
    s = runEndD * L;
    const ref = r.noThrottle
      ? pts({ pickupD: null, fullThrottleD: null })
      : r.neverFlat
        ? pts({ fullThrottleD: null })
        : pts();
    const loss = r.loss ?? 0;
    return {
      id: r.id,
      index: k,
      entryD,
      apexD,
      exitD: r.neverFlat ? runEndD : exitD,
      runEndD,
      lossSec: loss,
      phases: { braking: 0, turnIn: 0, midCorner: loss, exit: 0, exitRun: 0 },
      mine: pts(),
      ref,
      straightFlag: null,
      straightSec: 0,
    };
  });
  // Runs end where the next corner starts.
  for (let k = 0; k + 1 < corners.length; k++) corners[k].runEndD = corners[k + 1].entryD;
  const b = { lapId: 'm', refLapId: 'r', corners, sequences: [], leadInSec: 0, totalSec: 0, residualSec: 0 };
  if (withLength) b.trackLengthM = L;
  return b;
}

console.log('\n1) Trade, carry or just linked');
{
  check('opposite signs that cancel: trade', kindOf([{ lossSec: 0.12 }, { lossSec: -0.1 }]) === 'trade');
  check('opposite signs that do NOT cancel: not a trade', kindOf([{ lossSec: 0.3 }, { lossSec: -0.05 }]) !== 'trade');
  check('a loss carried through: carry', kindOf([{ lossSec: 0.1 }, { lossSec: 0.06 }, { lossSec: 0.03 }]) === 'carry');
  check('a gain carried through: carry', kindOf([{ lossSec: -0.1 }, { lossSec: -0.04 }]) === 'carry');
  check('a loss that stops dead: linked', kindOf([{ lossSec: 0.1 }, { lossSec: 0 }]) === 'linked');
  check('a first corner too small to read: linked', kindOf([{ lossSec: 0.005 }, { lossSec: 0.2 }]) === 'linked');
  check('pearson: perfect, inverse, flat', Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-12 && Math.abs(pearson([1, 2, 3], [3, 2, 1]) + 1) < 1e-12 && pearson([1, 1, 1], [1, 2, 3]) === null);
}

console.log('\n2) Which corners link on one lap');
{
  const rows = [
    { id: 'C1', loss: 0.05, runM: 300 },
    { id: 'C2', loss: 0.12, runM: 50 }, //          → C3: a short run
    { id: 'C3', loss: -0.1, neverFlat: true }, //   → C4: never flat between
    { id: 'C4', loss: 0.01, runM: 400 },
    { id: 'C5', loss: 0.2, runM: LINK_GAP_M + 20 }, // just too far
    { id: 'C6', loss: 0.1, runM: 300 },
  ];
  const b = makeB(rows);
  const links = linkedToNext(b);
  check('links: C2→C3 (short run) and C3→C4 (never flat) only', links.join() === 'false,true,true,false,false,false', links.join());
  const seqs = findSequences(b);
  check('one sequence: C2, C3, C4', seqs.length === 1 && seqs[0].cornerIds.join() === 'C2,C3,C4', JSON.stringify(seqs));
  check('its loss is the sum', Math.abs(seqs[0].lossSec - 0.03) < 1e-12);
  check('0.12 then −0.10 then 0.01: a trade', seqs[0].kind === 'trade');

  const cat = { mapKey: 'x', trackLengthM: L, builtFrom: 5, corners: [], sequences: [{ id: 'S1', cornerIds: ['C5', 'C6'], kind: 'complex' }] };
  const withCat = findSequences(b, cat);
  check('the catalogue joins C5–C6 across a longer run', withCat.length === 2 && withCat[1].cornerIds.join() === 'C5,C6' && withCat[1].kind === 'carry', JSON.stringify(withCat.map((s) => s.cornerIds.join('-') + ':' + s.kind)));

  const noLen = makeB(rows, false);
  const nl = linkedToNext(noLen);
  check('without a track length: only the never-flat rule (and the catalogue)', nl.join() === 'false,false,true,false,false,false', nl.join());
  check('…unless one is passed', linkedToNext(noLen, null, L).join() === links.join());

  const bare = makeB(rows.map((r) => ({ ...r, neverFlat: false, noThrottle: true, runM: 300 })));
  check('no throttle channel: "never flat" does not link everything', linkedToNext(bare).every((v) => !v));
  check('nothing linked: no sequences', findSequences(makeB([{ id: 'C1', runM: 300 }, { id: 'C2', runM: 300 }])).length === 0);
  check('an empty breakdown: no sequences', findSequences({ corners: [] }).length === 0);
}

console.log('\n3) Across a session');
{
  // Seeded noise: the same numbers every run.
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  const lap = () => {
    const fuel = rnd() * 0.2; //               a lap-wide factor
    const c2 = rnd() * 0.2;
    const c5 = rnd() * 0.2;
    return makeB([
      { id: 'C1', loss: fuel + rnd() * 0.02, runM: 600 }, // a straight to C2…
      { id: 'C2', loss: fuel + c2, runM: 40 }, //             …but C1/C2 correlate through `fuel`
      { id: 'C3', loss: -c2 + rnd() * 0.03, runM: 500 }, //  chicane: C3 gives back C2
      { id: 'C4', loss: rnd() * 0.1, runM: 300 },
      { id: 'C5', loss: c5, runM: 60 }, //                    a complex: carried through
      { id: 'C6', loss: 0.8 * c5 + rnd() * 0.02, runM: 60 },
      { id: 'C7', loss: 0.6 * c5 + rnd() * 0.02, runM: 400 },
      { id: 'C8', loss: rnd() * 0.1, runM: 50 }, //            linked, but no pattern
      { id: 'C9', loss: rnd() * 0.1, runM: 300 },
    ]);
  };
  const laps = Array.from({ length: 12 }, lap);
  const c1 = laps.map((b) => b.corners[0].lossSec);
  const c2 = laps.map((b) => b.corners[1].lossSec);
  check('(set-up) C1 and C2 really do correlate', pearson(c1, c2) > 0.5, pearson(c1, c2).toFixed(2));
  const seqs = sessionSequences(laps);
  const show = seqs.map((s) => `${s.cornerIds.join('-')}:${s.kind}`).join(' ');
  const find = (ids) => seqs.find((s) => s.cornerIds.join() === ids);
  check('the chicane C2–C3 trades', find('C2,C3') && find('C2,C3').kind === 'trade', show);
  check('the complex C5–C6–C7 carries, as one sequence', find('C5,C6,C7') && find('C5,C6,C7').kind === 'carry', show);
  check('C1–C2, a straight apart, is NOT a sequence however they correlate', !seqs.some((s) => s.cornerIds.includes('C1')), show);
  check('C8–C9 (linked, no pattern) is not reported', !seqs.some((s) => s.cornerIds.includes('C8')), show);
  const mean = laps.reduce((a, b) => a + b.corners[4].lossSec + b.corners[5].lossSec + b.corners[6].lossSec, 0) / laps.length;
  check('lossSec is the mean total over the laps', Math.abs(find('C5,C6,C7').lossSec - mean) < 1e-12, `${find('C5,C6,C7').lossSec.toFixed(4)}`);
  check(`fewer than ${SESSION_MIN_LAPS} laps: nothing`, sessionSequences(laps.slice(0, SESSION_MIN_LAPS - 1)).length === 0);
  const cat = { mapKey: 'x', trackLengthM: L, builtFrom: 5, corners: [], sequences: [{ id: 'S9', cornerIds: ['C8', 'C9'], kind: 'chicane' }] };
  const withCat = sessionSequences(laps, cat);
  const s89 = withCat.find((s) => s.cornerIds.join() === 'C8,C9');
  check('a catalogue sequence with no pattern still comes back, as linked', s89 && s89.kind === 'linked', withCat.map((s) => `${s.cornerIds.join('-')}:${s.kind}`).join(' '));
}

console.log('\n4) A real Le Mans pair');
{
  const R = fixture('trace-le-mans-lmp2-ref.json');
  const M = fixture('trace-le-mans-lmp2-slow.json');
  const Lm = R.trackLengthM;
  const corners = findCorners(R.trace, Lm).map((c, i) => ({ id: `C${i + 1}`, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD }));
  const b = lapLoss({ lapId: M.lapId, lapSec: M.lapMs / 1000, cols: M.trace }, { lapId: R.lapId, lapSec: R.lapMs / 1000, cols: R.trace }, corners, Lm);
  const apexM = (id) => b.corners.find((c) => c.id === id).apexD * Lm;
  const span = (s) => s.cornerIds.map(apexM);
  const desc = b.sequences.map((s) => `${s.cornerIds.join('-')}@${Math.round(span(s)[0])}:${s.kind}`).join(' ');
  check('lapLoss fills sequences', b.sequences.length >= 3, desc);
  const porsche = b.sequences.find((s) => span(s).every((m) => m > 11200 && m < 12600) && s.cornerIds.length >= 3);
  check('the Porsche Curves (11.2–12.6 km) are one sequence of 3+ corners', !!porsche, desc);
  const ford = b.sequences.find((s) => span(s).every((m) => m > 13000));
  check('the Ford chicanes (after 13 km) are a sequence', !!ford, desc);
  check('sequence losses are sums of their corners', b.sequences.every((s) => Math.abs(s.lossSec - s.cornerIds.reduce((a, id) => a + b.corners.find((c) => c.id === id).lossSec, 0)) < 1e-12));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
