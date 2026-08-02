/**
 * scripts/test-mfd.js — the two pit-menu decisions that are pure judgement.
 * -----------------------------------------------------------------------------
 * Most of the MFD is plumbing over LMU's REST API and can only be exercised
 * against a running game. Two pieces are not, and both are the kind of thing
 * that fails silently and expensively:
 *
 *   projectTyreControl  collapses LMU's four per-corner tyre rows into one
 *                       compound control. Get the option list or the "are all
 *                       four the same" test wrong and the widget confidently
 *                       reports a compound the car is not on.
 *
 *   isServiceRow        decides what a stop-and-go strips off the next stop.
 *                       Too greedy and serving a penalty silently wipes the
 *                       driver's aero and pressure setup; too timid and the
 *                       "stop-go" takes a full service and does not discharge
 *                       the penalty at all. `FUEL RATIO:` is the trap — it
 *                       reads as fuel and is a strategy setting for later stops.
 *
 * Run: node scripts/test-mfd.js
 */

'use strict';

const {
  isAllFourTyreRow,
  isFuelRow,
  isServiceRow,
  nextTyreOption,
  projectAids,
  projectPitMenu,
  projectTyreControl,
  tyreOptionSet,
} = require('../dist/telemetry/mfdControl');

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

/** A per-corner tyre row as LMU publishes it. */
function corner(name, currentSetting, options) {
  return {
    'PMC Value': 100 + name.charCodeAt(0),
    name,
    currentSetting,
    settings: options.map((text) => ({ text })),
  };
}

const COMPOUNDS = ['No Change', 'New Medium', 'New Wet'];
const CORNERS = ['FL TIRE:', 'FR TIRE:', 'RL TIRE:', 'RR TIRE:'];

/** All four corners on the same option. */
function allFour(setting, options = COMPOUNDS) {
  return CORNERS.map((n) => corner(n, setting, options));
}

console.log('\n1) The compound list comes from the sim, not from us');

{
  const t = projectTyreControl(allFour(1));
  check('the options are the sim\'s own names', JSON.stringify(t.options) === JSON.stringify(COMPOUNDS), t.options.join('/'));
  check('the current selection is read back', t.current === 1, t.current);
  check('…with its text', t.currentText === 'New Medium', t.currentText);
  check('four matching corners are not mixed', t.mixed === false);
}

{
  // A class running hards and softs must get hards and softs, with no code here
  // knowing what a compound is.
  const opts = ['No Change', 'New Soft', 'New Medium', 'New Hard', 'New Wet'];
  const t = projectTyreControl(allFour(3, opts));
  check('a five-compound car gets all five', t.options.length === 5, t.options.length);
  check('…and reads back the hard', t.currentText === 'New Hard', t.currentText);
}

console.log('\n2) Mixed corners are stated, never resolved to one corner');

{
  const rows = allFour(1);
  rows[2].currentSetting = 0; // RL left on No Change
  const t = projectTyreControl(rows);
  check('a disagreeing corner reads as mixed', t.mixed === true);
  check('…with no single current index', t.current === -1, t.current);
  check('…and says so in the text', t.currentText === 'Mixed', t.currentText);
}

console.log('\n3) Which rows are part of the menu at all');

{
  // TIRES: is the sim's own all-four shortcut with its own option list. Counting
  // it as a corner would double it against the corners it drives.
  const rows = allFour(1).concat([corner('TIRES:', 0, ['No Change', 'All Four'])]);
  const t = projectTyreControl(rows);
  check('the TIRES: shortcut is not treated as a corner', t.options.length === 3, t.options.length);
  check('…so four matching corners still read unmixed', t.mixed === false);
}

{
  check('a menu with no tyre rows yields no control', projectTyreControl([{ name: 'FUEL:', settings: [{ text: '0' }] }]) === null);
  check('an empty menu yields no control', projectTyreControl([]) === null);
  check('a missing menu yields no control', projectTyreControl(null) === null);
}

{
  // If the sim ever published a shorter list for one corner, offering the driver
  // fewer compounds than the car has would be the worse failure.
  const rows = allFour(0);
  rows[1].settings = [{ text: 'No Change' }, { text: 'New Medium' }];
  const t = projectTyreControl(rows);
  check('the longest option list wins', t.options.length === 3, t.options.length);
}

console.log('\n4) The slots that are not compounds');

{
  // Sampled live from LMU: the tyre rows carry a fixed slot list per car, with
  // the compounds this car/event does not run filled in as INVALID, and the
  // all-four row carries a "Mixed Tyres" slot that is a STATE, not a choice.
  // Stepping onto either is a dead end the driver cannot see coming.
  const LIVE_CORNER = ['No Change', 'New Medium ', 'New Wet ', 'INVALID'];
  const LIVE_ALL_FOUR = [...LIVE_CORNER, 'Mixed Tyres'];

  const set = tyreOptionSet(corner('FL TIRE:', 0, LIVE_CORNER));
  check('INVALID is not offered', set.options.join('/') === 'No Change/New Medium/New Wet',
    set.options.join('/'));
  check('…and the raw slot each compound writes is kept', set.raw.join() === '0,1,2', set.raw.join());

  const all = tyreOptionSet(corner('TIRES:', 4, LIVE_ALL_FOUR));
  check('"Mixed Tyres" is not offered either', all.options.length === 3, all.options.join('/'));

  // The user-facing order, and the whole point: no change, then the compounds
  // this car actually has.
  check('the order is the sim\'s own', all.options[0] === 'No Change' && all.options[1] === 'New Medium'
    && all.options[2] === 'New Wet', all.options.join(' → '));

  // A class running four compounds gets four — nothing here knows what a
  // compound is, so hards and softs arrive on their own when the car has them.
  const four = tyreOptionSet(
    corner('FL TIRE:', 0, ['No Change', 'New Soft', 'New Medium', 'New Hard', 'New Wet']),
  );
  check('a car with soft/hard gets soft/hard', four.options.length === 5, four.options.join('/'));

  const t = projectTyreControl(CORNERS.map((n) => corner(n, 2, LIVE_CORNER)));
  check('the collapsed control offers only real compounds', t.options.length === 3, t.options.join('/'));
  check('…and reads the corners back', t.currentText === 'New Wet', t.currentText);
}

{
  // Where ± lands. Clamped, never wrapped: wrapping from the last compound back
  // to "No Change" would cancel the tyre change on one extra blind press.
  check('+ steps up the list', nextTyreOption(0, 1, 3) === 1);
  check('− steps back down', nextTyreOption(2, -1, 3) === 1);
  check('+ clamps at the last compound', nextTyreOption(2, 1, 3) === 2);
  check('− clamps at No Change', nextTyreOption(0, -1, 3) === 0);
  // A mixed set is one press from being a single compound, either way.
  check('+ on a mixed set books the first compound', nextTyreOption(-1, 1, 3) === 1);
  check('− on a mixed set clears to No Change', nextTyreOption(-1, -1, 3) === 0);
  check('a one-option row cannot move', nextTyreOption(-1, 1, 1) === 0);
}

{
  // The row lies about itself: LMU leaves TIRES: on "Mixed Tyres" even when all
  // four corners agree, so the widget must read the corners instead.
  const menu = [
    corner('TIRES:', 4, ['No Change', 'New Medium ', 'New Wet ', 'INVALID', 'Mixed Tyres']),
    ...CORNERS.map((n) => corner(n, 2, ['No Change', 'New Medium ', 'New Wet ', 'INVALID'])),
  ];
  const projected = projectPitMenu(menu);
  const all = projected.find((r) => isAllFourTyreRow(r.name));
  check('TIRES: shows what the corners are on', all.currentText === 'New Wet', all.currentText);
  check('…and offers only the real compounds', all.settingCount === 3, all.settingCount);

  menu[1].currentSetting = 1; // one corner off on its own
  const mixed = projectPitMenu(menu).find((r) => isAllFourTyreRow(r.name));
  check('genuinely mixed corners still read Mixed', mixed.currentText === 'Mixed', mixed.currentText);
}

console.log('\n5) The driving aids are READINGS, not guesses');

{
  // These were declared unreadable for two releases and counted instead. They
  // are readable — single bytes in what stock rF2 leaves as reserved space, on
  // the player's record only. Sampled live: TC 7/11, ABS 9/9, motor map 1/1.
  const live = {
    tc: { value: 7, max: 11 },
    tcSlip: { value: 7, max: 11 },
    tcCut: { value: 7, max: 11 },
    abs: { value: 9, max: 9 },
    motorMap: { value: 1, max: 1 },
    tcActive: false,
    absActive: false,
  };
  const rows = projectAids(null, 0.51, live);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  check('every aid the car reports becomes a row', rows.length === 6, rows.map((r) => r.key).join());
  check('brake bias stays a front:rear split', byKey.BRAKE_BIAS.text === '49.0:51.0', byKey.BRAKE_BIAS.text);
  check('TC reads its step and its headroom', byKey.tc.text === '7/11', byKey.tc.text);
  check('…and carries the max as a bound', byKey.tc.maxValue === 11, byKey.tc.maxValue);
  check('TC slip and power cut are separate rows', !!byKey.tcSlip && !!byKey.tcCut);
  check('nothing is tagged as an estimate', rows.every((r) => !/est/.test(r.text)), rows.map((r) => r.text).join());

  // A car that does not offer a control reports max 0 for it. Showing that as a
  // permanent "0" would read as "turned off", which is a different and alarming
  // thing to tell a driver.
  const gt = projectAids(null, 0.51, { ...live, motorMap: { value: 0, max: 0 } });
  check('a control this car lacks is omitted, not shown as 0',
    !gt.some((r) => r.key === 'motorMap'), gt.map((r) => r.key).join());
}

{
  // Every car except the player's own publishes zeros in this block. Reporting
  // that as "TC 0" on a car running TC 7 is the trap that made the whole thing
  // look unsupported in the first place.
  const rows = projectAids(null, 0.51, null);
  check('no live block means brake bias alone', rows.length === 1 && rows[0].key === 'BRAKE_BIAS',
    rows.map((r) => r.key).join());
  const setup = projectAids({ VM_BRAKE_BALANCE: { value: 32, maxValue: 57, stringValue: '49.0:51.0' } });
  check('and with no live car at all, the setup value stands in', setup.length === 1, setup.length);
}

console.log('\n6) What a stop-and-go strips, and what it must not');

{
  check('the four corners are service', CORNERS.every(isServiceRow));
  check('damage is service', isServiceRow('DAMAGE:'));
  check('a driver change is service', isServiceRow('DRIVER:'));
  check('fuel is service', isServiceRow('FUEL:'));
  check('virtual energy is service', isServiceRow('VIRTUAL ENERGY:'));
}

{
  // The trap: FUEL RATIO is how much goes in at FUTURE stops. Zeroing it would
  // quietly rewrite the driver's fuelling plan for the rest of the race.
  check('FUEL RATIO is NOT service', !isServiceRow('FUEL RATIO:'));
  check('the wing is not service', !isServiceRow('FRONT WING:'));
  check('brake ducts are not service', !isServiceRow('F BRAKE DUCT:'));
  check('pressures are not service', !isServiceRow('FL PRESS:'));
  check('an empty name is not service', !isServiceRow(''));
  check('an unknown row is left alone', !isServiceRow('SOME FUTURE ROW:'));
}

console.log('\n7) What scrolling SERVE back to OFF refills');

{
  // The narrower predicate: the rows that are an AMOUNT going into the car, and
  // therefore the only part of a cleared stop that can be safely put back.
  check('fuel is refilled', isFuelRow('FUEL:'));
  check('virtual energy is refilled', isFuelRow('VIRTUAL ENERGY:'));
  check('FUEL RATIO is NOT refilled', !isFuelRow('FUEL RATIO:'));
  check('an empty name is not fuel', !isFuelRow(''));
}

{
  // The point of the narrowness. A driver who changes their mind about serving a
  // penalty must not be handed back a driver change or a tyre stop they never
  // booked — those were cleared and were never copied anywhere to restore from.
  check('a driver change is NOT refilled', !isFuelRow('DRIVER:'));
  check('damage is NOT refilled', !isFuelRow('DAMAGE:'));
  check('the tyres are NOT refilled', !CORNERS.some(isFuelRow));
  // …and every row that IS refilled must have been one the clear emptied, or
  // OFF would be setting something the penalty never touched.
  check('everything refilled was cleared first',
    ['FUEL:', 'VIRTUAL ENERGY:'].every((n) => isFuelRow(n) && isServiceRow(n)));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
