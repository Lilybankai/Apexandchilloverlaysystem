/**
 * test-teamcloud.js — the relay's pure decision helpers.
 * -----------------------------------------------------------------------------
 * team-cloud.js runs against live Supabase and a live feed; what can be pinned
 * offline is every decision it makes: who publishes (only the machine with
 * real local tyre data), which source a watcher follows (freshest driving
 * row), how the race history is thinned under the relay's size cap, and what
 * counts as an invite code.
 *
 * Run: npm run test:teamcloud
 */

'use strict';

const path = require('path');
const {
  eligibleToPublish,
  pickActiveSource,
  thinHistory,
  normalizeCode,
  HISTORY_MAX_BYTES,
} = require(path.join(__dirname, '..', 'electron', 'team-cloud.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── eligibleToPublish: only the driving PC's live frames ───────────────────
{
  const tyres = { frontLeft: { wear: 0.8 }, frontRight: { wear: 0.8 }, rearLeft: { wear: 0.7 }, rearRight: { wear: 0.7 } };
  const frame = { connected: true, session: { onTrack: true } };
  const snap = { car: { tyres } };

  check('live on-track frame with tyres publishes', eligibleToPublish(frame, snap));
  check('demo frame never publishes', !eligibleToPublish({ ...frame, connected: false }, snap));
  check('garage/menu never publishes',
    !eligibleToPublish({ connected: true, session: { onTrack: false } }, snap));
  check('missing onTrack counts as on track (older feeds)',
    eligibleToPublish({ connected: true, session: {} }, snap));
  check('no tyre data never publishes (spectating)',
    !eligibleToPublish(frame, { car: { tyres: null } }));
  check('tyres without wear never publish',
    !eligibleToPublish(frame, { car: { tyres: { frontLeft: {} } } }));
  check('null frame/snapshot never publish',
    !eligibleToPublish(null, snap) && !eligibleToPublish(frame, null));
}

// ── pickActiveSource: freshest driving row, else freshest row ──────────────
{
  const driving = (age, name) => ({
    user_id: name, name, age_sec: age,
    payload: { car: { tyres: { frontLeft: { wear: 0.5 } } } },
  });
  const watching = (age, name) => ({ user_id: name, name, age_sec: age, payload: { car: {} } });

  check('empty team → null', pickActiveSource([]) === null && pickActiveSource(null) === null);
  check('single source wins', pickActiveSource([watching(50, 'a')]).name === 'a');
  check('driving row beats fresher watcher',
    pickActiveSource([watching(1, 'watcher'), driving(9, 'driver')]).name === 'driver');
  check('freshest of two driving rows wins (driver swap)',
    pickActiveSource([driving(40, 'out-lap'), driving(3, 'in-car')]).name === 'in-car');
  check('all watchers → freshest watcher',
    pickActiveSource([watching(30, 'old'), watching(4, 'fresh')]).name === 'fresh');
  check('missing age treated as stale',
    pickActiveSource([{ user_id: 'x', name: 'x', payload: {} }, watching(5, 'aged')]).name === 'aged');
}

// ── thinHistory: under the cap, latest point always kept ───────────────────
{
  const laps = (n) => Array.from({ length: n }, (_, i) => ({ lap: i + 1, pos: 3, clsPos: 1, lastSec: 214.5 }));
  const small = { revision: 7, sessionKey: 'monza|race', cars: [{ slotId: 1, name: 'A', laps: laps(30) }], wear: [] };
  check('small history passes through untouched', thinHistory(small) === small);

  const big = {
    revision: 9,
    sessionKey: 'sarthe|race',
    cars: Array.from({ length: 62 }, (_, i) => ({ slotId: i, name: `Driver ${i}`, cls: 'HYPERCAR', laps: laps(380) })),
    wear: Array.from({ length: 380 }, (_, i) => ({ lap: i + 1, fl: 0.9, fr: 0.9, rl: 0.9, rr: 0.9 })),
  };
  check('Le Mans-sized history is over the cap raw', JSON.stringify(big).length > HISTORY_MAX_BYTES);
  const thin = thinHistory(big);
  check('thinned history fits the cap', thin && JSON.stringify(thin).length <= HISTORY_MAX_BYTES,
    thin ? `${JSON.stringify(thin).length} bytes` : 'null');
  check('thinning keeps the revision', thin && thin.revision === 9);
  check('every car keeps its latest lap', thin && thin.cars.every(
    (c) => c.laps[c.laps.length - 1].lap === 380));
  check('original object untouched', big.cars[0].laps.length === 380);
  check('null history → null', thinHistory(null) === null);
}

// ── normalizeCode ──────────────────────────────────────────────────────────
{
  check('full code passes', normalizeCode('APX-7K2FQ9') === 'APX-7K2FQ9');
  check('lowercase + spaces normalised', normalizeCode('  apx-7k2fq9 ') === 'APX-7K2FQ9');
  check('bare six characters get the prefix', normalizeCode('7k2fq9') === 'APX-7K2FQ9');
  check('garbage refused', normalizeCode('hello world') === '' && normalizeCode('') === '');
  check('too short refused', normalizeCode('APX-7K2') === '');
}

console.log(`\ntest-teamcloud: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
