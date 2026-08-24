/**
 * test-teamhistory.js — the Team page's race memory.
 * -----------------------------------------------------------------------------
 * Drives synthetic races through TeamHistory: laps append exactly once per
 * completed lap, a session change wipes the record, demo frames never
 * pollute, and the tyre projection maths answers with the right corner.
 *
 * Run: npm run test:teamhistory
 */

'use strict';

const path = require('path');
const { TeamHistory, tyreProjection } = require(path.join(__dirname, '..', 'electron', 'team-history.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const frame = (track, laps, wearRR, opts = {}) => ({
  connected: opts.connected !== false,
  session: { track, type: 'race' },
  standings: [
    { slotId: 1, driverName: 'Leader', carClass: 'Hypercar', position: 1, classPosition: 1, lapsCompleted: laps, lastLapSec: 210 + (laps % 3), isPlayer: false },
    { slotId: 7, driverName: 'Carl', carClass: 'LMGT3', carNumber: '87', position: 12, classPosition: 4, lapsCompleted: laps - 1 < 0 ? 0 : laps - 1, lastLapSec: 244.2, isPlayer: true },
  ],
  player: {
    tyres: {
      frontLeft: { wear: 1 - laps * 0.008 }, frontRight: { wear: 1 - laps * 0.009 },
      rearLeft: { wear: 1 - laps * 0.01 }, rearRight: { wear: wearRR },
    },
  },
});

// ── Laps append once per completed lap, repeats are free ───────────────────
{
  const h = new TeamHistory();
  for (let lap = 0; lap <= 10; lap++) {
    h.update(frame('Monza', lap, 1 - lap * 0.02));
    h.update(frame('Monza', lap, 1 - lap * 0.02)); // same second, twice
  }
  const leader = h.state().cars.find((c) => c.slotId === 1);
  check('one entry per lap despite repeat frames', leader.laps.length === 11, `${leader.laps.length}`);
  check('laps are the sim lap numbers', leader.laps[10].lap === 10);
  check('lap times recorded', leader.laps[5].lastSec === 210 + (5 % 3));
  check('player flag carried', h.state().cars.find((c) => c.slotId === 7).isPlayer === true);
  check('wear recorded at OUR lap boundary', h.state().wear.length > 0);
  check('revision moved', h.revision > 0);
}

// ── Session change resets ──────────────────────────────────────────────────
{
  const h = new TeamHistory();
  h.update(frame('Monza', 5, 0.9));
  const revAfterMonza = h.revision;
  h.update(frame('Spa', 1, 0.99));
  check('new track wipes cars', h.state().cars.every((c) => c.laps.length <= 1));
  check('new track wipes wear', h.state().wear.length <= 1);
  check('sessionKey follows', h.sessionKey.startsWith('Spa'), h.sessionKey);
  check('reset bumps revision', h.revision !== revAfterMonza);
}

// ── Demo frames never pollute ──────────────────────────────────────────────
{
  const h = new TeamHistory();
  h.update(frame('Monza', 3, 0.95));
  const before = h.revision;
  h.update(frame('DemoTrack', 99, 0.5, { connected: false }));
  check('demo frame ignored', h.revision === before && h.sessionKey.startsWith('Monza'));
}

// ── Malformed input is a no-op, never a throw ──────────────────────────────
{
  const h = new TeamHistory();
  h.update(null);
  h.update({});
  h.update({ session: {}, standings: 'nope' });
  check('garbage tolerated', h.revision === 0);
}

// ── Tyre projection: rate, cliff lap, worst corner ─────────────────────────
{
  // RR loses 1.5%/lap from 40%: (0.40−0.25)/0.015 = 10 laps to the cliff.
  const wear = [];
  for (let lap = 20; lap <= 26; lap++) {
    wear.push({ lap, fl: 0.8 - (lap - 20) * 0.005, fr: 0.78 - (lap - 20) * 0.006, rl: 0.7 - (lap - 20) * 0.008, rr: 0.4 - (lap - 20) * 0.015 });
  }
  const p = tyreProjection(wear);
  check('projection builds', !!p);
  check('worst corner is RR', p.worstCorner === 'rr', p.worstCorner);
  check('RR rate ~1.5%/lap', Math.abs(p.ratePerLap.rr - 0.015) < 1e-9, String(p.ratePerLap.rr));
  // At lap 26 RR = 0.4 − 6·0.015 = 0.31 → (0.31−0.25)/0.015 = 4 laps left.
  check('laps to the 25% cliff', p.lapsTo25 === 4, `${p.lapsTo25}`);
  check('as-of lap carried', p.asOfLap === 26);
}

// ── Projection guards ──────────────────────────────────────────────────────
{
  check('one point → null', tyreProjection([{ lap: 3, fl: 1, fr: 1, rl: 1, rr: 1 }]) === null);
  check('no laps elapsed → null', tyreProjection([
    { lap: 3, fl: 1, fr: 1, rl: 1, rr: 1 },
    { lap: 3, fl: 1, fr: 1, rl: 1, rr: 1 },
  ]) === null);
  check('zero wear rate → no cliff claim', tyreProjection([
    { lap: 1, fl: 1, fr: 1, rl: 1, rr: 1 },
    { lap: 5, fl: 1, fr: 1, rl: 1, rr: 1 },
  ]).lapsTo25 === null);
}

console.log(`\ntest-teamhistory: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
