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

console.log('\ntotal stop length — read from the sim, never derived\n');
{
  // The exact payload captured from a live stop with `Repair All` and one tyre
  // selected. The arithmetic below is the evidence that the sim ADDS repair and
  // tyre time rather than overlapping them — which is what let this widget show
  // a total at all.
  const LIVE = {
    wearables: {
      body: { aero: 0.2133752703666687, detachableParts: [true, true, true, true, false] },
      suspension: [0, 0.5708523392677307, 0, 0.3849409818649292],
      brakes: [0.0356, 0.0356, 0.032, 0.032],
    },
    pitStopTimes: { times: { FixAllDamage: 102.75341796875, TwoTireChange: 4.5, FourTireChange: 12 } },
    pitStopLength: { timeInSeconds: 107.25341796875 },
    pitMenu: {
      pitMenu: menuDamaged(2).concat([
        { name: 'FR TIRE:', currentSetting: 1, settings: [{ text: 'No Change' }, { text: 'New Wet' }] },
        { name: 'FL TIRE:', currentSetting: 0, settings: [{ text: 'No Change' }, { text: 'New Wet' }] },
        { name: 'RL TIRE:', currentSetting: 0, settings: [{ text: 'No Change' }, { text: 'New Wet' }] },
        { name: 'RR TIRE:', currentSetting: 0, settings: [{ text: 'No Change' }, { text: 'New Wet' }] },
      ]),
    },
  };
  const d = decodeDamage(LIVE);
  check('the live payload decodes', d !== null);
  check('total is the sim figure', d.stopLengthSeconds === 107.3, d.stopLengthSeconds);
  check('repairs are the component', d.repairSeconds === 102.8, d.repairSeconds);
  check('tyres are the other component', d.tyreChangeSeconds === 4.5, d.tyreChangeSeconds);
  check('one corner selected', d.tyreCornersSelected === 1, d.tyreCornersSelected);
  // The relationship that settled the concurrency question. Checked on the raw
  // values rather than the rounded ones, because the point is that they are
  // identical to the bit, not merely close.
  check(
    'total EQUALS repairs + tyres, exactly',
    Math.abs(102.75341796875 + 4.5 - 107.25341796875) < 1e-9,
  );
  check('heavy FR corner reads through', Math.abs(d.suspension[1] - 0.5709) < 0.001, d.suspension[1].toFixed(4));
  check('and is flagged heavy', isHeavy(d.suspension[1]));
}
{
  // A total the sim does not publish must be UNKNOWN, so the widget can fall
  // back to the repair figure and label it as such rather than showing a zero
  // stop.
  const d = decodeDamage(DAMAGED);
  check('no pitStopLength gives UNKNOWN total', d.stopLengthSeconds === -1, d.stopLengthSeconds);
  check('while repairs still read', d.repairSeconds === 35.1, d.repairSeconds);
  const bad = decodeDamage(payload({ pitStopLength: { timeInSeconds: 0 } }));
  check('a zero total is rejected', bad.stopLengthSeconds === -1, bad.stopLengthSeconds);
  const nan = decodeDamage(payload({ pitStopLength: { timeInSeconds: NaN } }));
  check('a NaN total is rejected', nan.stopLengthSeconds === -1, nan.stopLengthSeconds);
}

console.log('\nrandom delay — the published total is a floor, not a prediction\n');
{
  const TIMES = {
    FixAllDamage: 180,
    TwoTireChange: 4.5,
    FourTireChange: 12,
    FixRandomDelay: 5,
    RandomTireDelay: 1,
  };
  const build = (sel, corners) =>
    decodeDamage({
      wearables: DAMAGED.wearables,
      pitStopTimes: { times: TIMES },
      pitStopLength: { timeInSeconds: 184.5 },
      pitMenu: {
        pitMenu: menuDamaged(sel).concat(
          ['FL', 'FR', 'RL', 'RR'].map((c, i) => ({
            name: c + ' TIRE:',
            currentSetting: i < corners ? 1 : 0,
            settings: [{ text: 'No Change' }, { text: 'New Medium' }],
          })),
        ),
      },
    });

  // The measured stop: published total 184.5, actual 187.7 when the car
  // dropped. A 3.2 s residual has to fall inside the quoted range, or the range
  // is a lie of exactly the kind this widget exists to avoid.
  const both = build(2, 1);
  check('repairs + one tyre caps at 6s', both.randomDelayMaxSeconds === 6, both.randomDelayMaxSeconds);
  check('the published total is the floor', both.stopLengthSeconds === 184.5, both.stopLengthSeconds);
  check(
    'the quoted range covers the real 187.7s stop',
    187.7 >= both.stopLengthSeconds &&
      187.7 <= both.stopLengthSeconds + both.randomDelayMaxSeconds,
    both.stopLengthSeconds + '–' + (both.stopLengthSeconds + both.randomDelayMaxSeconds),
  );

  // Only the work actually booked draws a delay, so a simpler stop quotes a
  // tighter range rather than a blanket 6 s.
  const repairsOnly = build(2, 0);
  check('repairs alone cap at 5s', repairsOnly.randomDelayMaxSeconds === 5, repairsOnly.randomDelayMaxSeconds);
  const tyresOnly = build(0, 2);
  check('declining repairs drops the repair delay', tyresOnly.randomDelayMaxSeconds === 1, tyresOnly.randomDelayMaxSeconds);
  const nothing = build(0, 0);
  check('no work booked, no delay', nothing.randomDelayMaxSeconds === 0, nothing.randomDelayMaxSeconds);
}
{
  const d = decodeDamage(DAMAGED);
  check('unpublished caps give UNKNOWN, not 0', d.randomDelayMaxSeconds === -1, d.randomDelayMaxSeconds);
}

console.log('\ntyre change — priced separately, never summed into the repair figure\n');
{
  /** The four per-corner entries, with `selected` of them set to change. */
  const tyreMenu = (selected) =>
    ['FL', 'FR', 'RL', 'RR'].map((c, i) => ({
      name: c + ' TIRE:',
      currentSetting: i < selected ? 1 : 0,
      settings: [{ text: 'No Change' }, { text: 'New Medium' }],
    }));
  const TIMES = { FixAllDamage: 35.098, TwoTireChange: 4.5, FourTireChange: 12 };
  const withTyres = (selected) =>
    decodeDamage({
      wearables: DAMAGED.wearables,
      pitStopTimes: { times: TIMES },
      pitMenu: { pitMenu: menuDamaged(2).concat(tyreMenu(selected)) },
    });

  const none = withTyres(0);
  check('no tyres selected costs nothing', none.tyreChangeSeconds === 0, none.tyreChangeSeconds);
  check('and counts zero corners', none.tyreCornersSelected === 0);

  // The game showed "Tyres: 5 sec" for a single corner against a published
  // TwoTireChange of 4.5 — so one tyre really is priced as two.
  const one = withTyres(1);
  check('one corner is priced as TwoTireChange', one.tyreChangeSeconds === 4.5, one.tyreChangeSeconds);
  check('and counts one corner', one.tyreCornersSelected === 1);

  const two = withTyres(2);
  check('two corners, same price', two.tyreChangeSeconds === 4.5, two.tyreChangeSeconds);

  const three = withTyres(3);
  check('three corners crosses to FourTireChange', three.tyreChangeSeconds === 12, three.tyreChangeSeconds);

  const four = withTyres(4);
  check('all four', four.tyreChangeSeconds === 12, four.tyreChangeSeconds);
  check('and counts four corners', four.tyreCornersSelected === 4);

  // The whole point of keeping them apart: the repair figure must be untouched
  // by whatever the tyres cost.
  check('repair time is NOT summed with tyres', four.repairSeconds === 35.1, four.repairSeconds);

  // `TIRES:` is the all-four shortcut; counting it as a corner would inflate
  // the count to five and push a two-tyre stop into the four-tyre price.
  const withShortcut = decodeDamage({
    wearables: DAMAGED.wearables,
    pitStopTimes: { times: TIMES },
    pitMenu: {
      pitMenu: menuDamaged(2)
        .concat([{ name: 'TIRES:', currentSetting: 1, settings: [{ text: 'No Change' }, { text: 'All' }] }])
        .concat(tyreMenu(2)),
    },
  });
  check('the TIRES: shortcut is not double-counted', withShortcut.tyreCornersSelected === 2, withShortcut.tyreCornersSelected);
  check('so the price stays at two', withShortcut.tyreChangeSeconds === 4.5, withShortcut.tyreChangeSeconds);
}
{
  // A clean car can still be stopping for tyres, and that stop still has a
  // length worth knowing.
  const d = decodeDamage(
    payload({
      pitStopTimes: { times: { TwoTireChange: 4.5, FourTireChange: 12 } },
      pitMenu: {
        pitMenu: MENU_CLEAN.concat(
          ['FL', 'FR', 'RL', 'RR'].map((c) => ({
            name: c + ' TIRE:',
            currentSetting: 1,
            settings: [{ text: 'No Change' }, { text: 'New Medium' }],
          })),
        ),
      },
    }),
  );
  check('an undamaged car still prices its tyre stop', d.tyreChangeSeconds === 12, d.tyreChangeSeconds);
  check('while reporting no damage', d.hasDamage === false);
  check('and no repair estimate', d.repairSeconds === -1, d.repairSeconds);
}
{
  const d = decodeDamage(
    payload({
      pitMenu: {
        pitMenu: MENU_CLEAN.concat([
          { name: 'FL TIRE:', currentSetting: 1, settings: [{ text: 'No Change' }, { text: 'New Medium' }] },
        ]),
      },
      pitStopTimes: { times: {} },
    }),
  );
  check('tyres selected but no published time is UNKNOWN', d.tyreChangeSeconds === -1, d.tyreChangeSeconds);
}
{
  const d = decodeDamage(payload({ pitMenu: {} }));
  check('no pit menu means unknown tyre time', d.tyreChangeSeconds === -1);
  check('and unknown corner count', d.tyreCornersSelected === -1);
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
