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

const { projectTyreControl, isServiceRow } = require('../dist/telemetry/mfdControl');

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

console.log('\n4) What a stop-and-go strips, and what it must not');

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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
