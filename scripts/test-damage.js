/**
 * scripts/test-damage.js — the damage decode's contracts.
 * -----------------------------------------------------------------------------
 * This decoder differs from every other one in `telemetry/` in that its input is
 * a third-party JSON payload that can be absent, empty, partial or reshaped by a
 * game update at any time. So most of what matters here is not arithmetic — it
 * is what happens when the payload is NOT what we expect.
 *
 * The single most important case: a missing or malformed payload must produce
 * `null`, never a zeroed state. A zeroed damage block renders identically to a
 * pristine car, and a driver reading "no damage" off a stale or broken feed
 * would drive past the pits on it. Several cases below exist only to pin that.
 *
 * Fixture values are the ones actually measured through a real impact by
 * scripts/probe-lmu-damage.js — 9.5% aero, 19.5% FR, 12.2% RR, FixAllDamage
 * moving 30 -> 35.098 — so the tests describe the sim's real behaviour rather
 * than an idealised version of it.
 *
 * Run: node scripts/test-damage.js
 */

'use strict';

const { decodeDamage, isHeavy, isDamaged, HEAVY_SEVERITY } = require('../dist/telemetry/damage');

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

/** The `DAMAGE:` menu as the sim publishes it on a CLEAN car. */
const MENU_CLEAN = [{ name: 'DAMAGE:', currentSetting: 0, settings: [{ text: 'N/A' }] }];

/** The same entry once there is damage — three options, "Repair All" chosen. */
const menuDamaged = (currentSetting) => [
  {
    name: 'DAMAGE:',
    currentSetting,
    settings: [{ text: 'Do Not Repair' }, { text: 'Repair Body' }, { text: 'Repair All' }],
  },
];

/** A payload with everything clean unless overridden. */
function payload(over) {
  return Object.assign(
    {
      wearables: {
        body: { aero: 0, detachableParts: [true, true, true, true] },
        suspension: [0, 0, 0, 0],
        brakes: [0.0356, 0.0356, 0.032, 0.032],
        tires: [1, 1, 1, 1],
      },
      pitStopTimes: { times: { FixAllDamage: 30, FixAeroDamage: 30 } },
      pitMenu: { pitMenu: MENU_CLEAN },
    },
    over,
  );
}

/** The measured post-impact payload. */
const DAMAGED = payload({
  wearables: {
    body: { aero: 0.0949927270412445, detachableParts: [true, false, true, true] },
    suspension: [0, 0.19498804211616516, 0, 0.12152008712291718],
    brakes: [0.0356, 0.0356, 0.032, 0.032],
    tires: [1, 1, 1, 1],
  },
  pitStopTimes: { times: { FixAllDamage: 35.09784698486328, FixAeroDamage: 30 } },
  pitMenu: { pitMenu: menuDamaged(2) },
});

console.log('\ndamage decode — the clean car\n');
{
  const d = decodeDamage(payload());
  check('decodes a clean payload', d !== null);
  check('reports no damage', d.hasDamage === false);
  check('aero is zero', d.aero === 0, d.aero);
  check('every corner is zero', d.suspension.every((s) => s === 0));
  check('worst is zero', d.worst === 0);
  check('nothing detached', d.partsDetached === 0);
  // A clean car's only menu option is the literal string "N/A" — which is a
  // different statement from the driver declining repairs.
  check('repair selection is unavailable, not none', d.repairSelection === 'unavailable', d.repairSelection);
  check('brake discs convert m -> mm', d.brakeThicknessMm[0] === 35.6, d.brakeThicknessMm[0]);
  check('rear discs too', d.brakeThicknessMm[2] === 32, d.brakeThicknessMm[2]);
}

console.log('\ndamage decode — after the measured impact\n');
{
  const d = decodeDamage(DAMAGED);
  check('decodes the damaged payload', d !== null);
  check('reports damage', d.hasDamage === true);
  check('aero severity survives', Math.abs(d.aero - 0.095) < 0.001, d.aero.toFixed(4));
  check('front-right is the worst corner', d.suspension[1] > d.suspension[3]);
  check('worst is the FR corner', Math.abs(d.worst - 0.195) < 0.001, d.worst.toFixed(4));
  check('undamaged corners stay zero', d.suspension[0] === 0 && d.suspension[2] === 0);
  check('one part detached', d.partsDetached === 1, d.partsDetached);
  // The whole point of the widget: the sim's own live estimate, rounded to the
  // tenth the widget displays.
  check('repair time is the sim figure', d.repairSeconds === 35.1, d.repairSeconds);
  check('body-only time is separate', d.repairBodySeconds === 30, d.repairBodySeconds);
  check('menu selection reads Repair All', d.repairSelection === 'all', d.repairSelection);
  check('the three options are carried', d.repairOptions.length === 3, d.repairOptions.join('/'));
}

console.log('\nseverity thresholds\n');
{
  check('19.5% is heavy', isHeavy(0.195));
  check('9.5% is not heavy', !isHeavy(0.095));
  check('the boundary itself is heavy', isHeavy(HEAVY_SEVERITY));
  check('9.5% still counts as damage', isDamaged(0.095));
  check('exact zero is not damage', !isDamaged(0));
  // A hairline scrape should not send anyone to the pits.
  check('a 0.2% scrape is below the floor', !isDamaged(0.002));
}

console.log('\nthe driver declined repairs\n');
{
  const d = decodeDamage(
    payload({
      wearables: DAMAGED.wearables,
      pitStopTimes: DAMAGED.pitStopTimes,
      pitMenu: { pitMenu: menuDamaged(0) },
    }),
  );
  check('selection reads none, not unavailable', d.repairSelection === 'none', d.repairSelection);
  check('damage is still reported', d.hasDamage === true);
  check('the repair cost is still shown', d.repairSeconds === 35.1, d.repairSeconds);
}
{
  const d = decodeDamage(
    payload({
      wearables: DAMAGED.wearables,
      pitStopTimes: DAMAGED.pitStopTimes,
      pitMenu: { pitMenu: menuDamaged(1) },
    }),
  );
  check('body-only selection is distinguished', d.repairSelection === 'body', d.repairSelection);
}

console.log('\nabsent and malformed payloads — must be null, never zeros\n');
{
  check('null payload', decodeDamage(null) === null);
  check('undefined payload', decodeDamage(undefined) === null);
  check('empty object', decodeDamage({}) === null);
  check('no wearables block', decodeDamage({ pitStopTimes: { times: {} } }) === null);
  check(
    'wearables present but no suspension',
    decodeDamage({ wearables: { body: { aero: 0 } } }) === null,
  );
  check(
    'suspension too short',
    decodeDamage({ wearables: { body: { aero: 0 }, suspension: [0, 0] } }) === null,
  );
  check(
    'a NaN severity rejects the block',
    decodeDamage({ wearables: { body: { aero: NaN }, suspension: [0, 0, 0, 0] } }) === null,
  );
  check(
    'an out-of-range severity rejects the block',
    decodeDamage({ wearables: { body: { aero: 0 }, suspension: [0, 99, 0, 0] } }) === null,
  );
  check(
    'a negative severity rejects the block',
    decodeDamage({ wearables: { body: { aero: -1 }, suspension: [0, 0, 0, 0] } }) === null,
  );
}

console.log('\npartial payloads — degrade, do not fabricate\n');
{
  // Damage present, repair time absent. The widget must be able to tell "no
  // estimate" from "free", so the time is UNKNOWN (-1) rather than 0.
  const d = decodeDamage(
    payload({ wearables: DAMAGED.wearables, pitStopTimes: { times: {} } }),
  );
  check('missing repair time is UNKNOWN, not zero', d.repairSeconds === -1, d.repairSeconds);
  check('damage still decodes without it', d.hasDamage === true);
}
{
  const d = decodeDamage(
    payload({
      wearables: DAMAGED.wearables,
      pitStopTimes: { times: { FixAllDamage: 0 } },
    }),
  );
  check('a zero repair time is rejected as UNKNOWN', d.repairSeconds === -1, d.repairSeconds);
}
{
  const d = decodeDamage(payload({ wearables: { body: { aero: 0 }, suspension: [0, 0, 0, 0] } }));
  check('missing brakes give UNKNOWN per corner', d.brakeThicknessMm[0] === -1);
  check('missing detachableParts gives UNKNOWN', d.partsDetached === -1);
  check('the block still decodes', d !== null);
}
{
  const d = decodeDamage(payload({ pitMenu: {} }));
  check('a missing pit menu is unavailable, not a crash', d.repairSelection === 'unavailable');
  check('and carries no options', d.repairOptions.length === 0);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
