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

console.log('\n5b) Every aid the MFD shows is one the driver can change');

{
  /*
   * The bug this exists to prevent, which shipped: brake migration, both ARBs
   * and regen were READ live and drawn as rows, and none of them had an entry
   * in the aid table — so an aid with no `inc`/`dec` function name has nothing
   * to press, the widget offers no ±, and the row is a number the driver can
   * look at and not touch. It went unnoticed because it only shows on a
   * Hypercar, an LMP2 or an LMP3: a GT3 never renders those rows at all.
   *
   * A reading with no control is a legitimate state (it is what a spectator
   * gets), so what is asserted is the LINK: every key `projectAids` can emit
   * must resolve in `lmuKeybinds`, whether or not the driver has a key bound
   * to it today. Binding is the driver's business; knowing the function name
   * is ours.
   */
  const { findAid, readLmuKeybinds } = require('../dist/server/lmuKeybinds');
  // An explicit path that cannot exist, so the table comes back with every aid
  // and no keys — this must not depend on whether LMU is installed here.
  const binds = readLmuKeybinds(' no-such-file');

  const everyAid = {
    tc: { value: 7, max: 11 },
    tcSlip: { value: 7, max: 11 },
    tcCut: { value: 7, max: 11 },
    abs: { value: 9, max: 9 },
    motorMap: { value: 1, max: 8 },
    brakeMigration: { value: 3, max: 9 },
    frontARB: { value: 4, max: 11 },
    rearARB: { value: 6, max: 11 },
    tcActive: false,
    absActive: false,
  };
  const garage = {
    VM_REGEN_LEVEL: { value: 5, maxValue: 9, stringValue: '200kW' },
  };
  const rows = projectAids(garage, 0.51, everyAid);

  check('a prototype reports every aid row', rows.length === 10, rows.map((r) => r.key).join());
  const orphans = rows.filter((r) => !findAid(binds, r.key)).map((r) => r.key);
  check('every projected aid resolves to a bindable function', orphans.length === 0,
    orphans.length ? 'no function name for: ' + orphans.join(', ') : rows.length + ' rows checked');

  // The four that were readout-only, named individually so a regression says
  // which one came loose rather than just "one of them".
  for (const key of ['brakeMigration', 'frontARB', 'rearARB', 'regen']) {
    const aid = findAid(binds, key);
    check(`${key} has both directions named`,
      !!aid && !!aid.incFunction && !!aid.decFunction,
      aid ? `${aid.incFunction} / ${aid.decFunction}` : 'no entry');
  }

  /*
   * Brake migration's `+` is FORWARD, and the raw step it moves goes DOWN —
   * step 0 is 2.5% F on the car and step 5 is disabled, so more migration is a
   * lower index. Pinned because this was reported as stepping the wrong way and
   * swapped, wrongly: the press was always right, but the row beside it was
   * showing a bare step index (the garage label having gone stale), so
   * 1.5% F → 2.0% F was displayed as "1.5% F" → "1/5" and read as a decrease.
   * The row derives the real percentage now; see the ladder test below.
   */
  const mig = findAid(binds, 'brakeMigration');
  check('brake migration + is FORWARD, and walks the raw step down',
    mig.incFunction === 'Brake Migration Forward', mig.incFunction);
}

console.log('\n5e) Brake migration reads in the car\'s own words at every step');

{
  /*
   * The garage publishes the sim's wording for ONE step and never follows an
   * in-car change — caught live as `mem 5` against `rest 2 "1.5% F"`. So the row
   * used to drop to "5/5" the moment the driver touched it: the right value in
   * the wrong units, beside a car showing a percentage.
   *
   * The ladder, read off the car, is linear and descending at half a point per
   * step, ending at disabled. Only the increment and the direction are assumed;
   * the position is anchored on whatever sample the garage is holding, so it
   * calibrates itself to the loaded car rather than assuming every car starts
   * at 2.5%.
   */
  const anchor = { VM_BRAKE_MIGRATION: { value: 2, maxValue: 6, stringValue: '1.5% F' } };
  const base = {
    tc: { value: 8, max: 11 }, tcSlip: { value: 10, max: 11 }, tcCut: { value: 7, max: 11 },
    abs: { value: 0, max: 0 }, motorMap: { value: 6, max: 10 },
    frontARB: { value: 6, max: 15 }, rearARB: { value: 1, max: 15 },
    tcActive: false, absActive: false,
  };
  const at = (v, g) => projectAids(g ?? anchor, 0.51, { ...base, brakeMigration: { value: v, max: 5 } })
    .find((r) => r.key === 'brakeMigration').text;

  // The exact table the driver read off the in-car MFD.
  const LADDER = ['2.5% F', '2.0% F', '1.5% F', '1.0% F', '0.5% F', 'Disabled'];
  const got = LADDER.map((_, v) => at(v));
  check('every step reads as the car reads it', got.join('|') === LADDER.join('|'), got.join(', '));

  // The anchor is the sim's own sample, so a car sitting on a different step
  // produces the same ladder rather than one shifted by the difference.
  const other = { VM_BRAKE_MIGRATION: { value: 4, maxValue: 6, stringValue: '0.5% F' } };
  const shifted = LADDER.map((_, v) => at(v, other));
  check('a different anchor gives the same ladder', shifted.join('|') === LADDER.join('|'),
    shifted.join(', '));

  // And it declines to guess rather than inventing a figure it cannot support.
  const unparseable = { VM_BRAKE_MIGRATION: { value: 2, maxValue: 6, stringValue: 'P4' } };
  check('an anchor it cannot read falls back to the honest step',
    at(0, unparseable) === '0/5', at(0, unparseable));
  check('no anchor at all does the same', at(0, {}) === '0/5', at(0, {}));
}

console.log('\n5d) Regen stops claiming a value it can no longer read');

{
  /*
   * Regen is the only aid with no live source anywhere. That was established
   * twice: first by scanning the player's telemetry record for the value the
   * garage endpoint reported, and then — properly — by DIFFING all 1888 bytes at
   * 10 Hz while the driver stepped regen through its whole range, which saw
   * nothing move but tyre and brake temperatures. The first method could only
   * ever have worked if the garage endpoint were live, and the same run proved
   * it is not: it sat on `10 "200kW"` throughout, while the driver wound the car
   * down to zero.
   *
   * So the row was showing 200kW on a car deploying nothing — not merely stale,
   * but most wrong exactly when a Hypercar driver is leaning on it. The value
   * now goes to a dash once anything has moved it, and comes back if the garage
   * ever reports something new.
   */
  const { noteRegenStepped, resetRegenStale } = require('../dist/telemetry/mfdControl');
  const at = (v, s) => ({ VM_REGEN_LEVEL: { value: v, maxValue: 11, stringValue: s } });
  const text = (g) => projectAids(g, 0.51, null).find((r) => r.key === 'regen').text;

  resetRegenStale();
  check('before anything moves it, the setup value stands', text(at(10, '200kW')) === '200kW');

  noteRegenStepped();
  check('after a press the value goes, not stale-but-shown', text(at(10, '200kW')) === '—',
    text(at(10, '200kW')));
  check('…and stays gone while the endpoint repeats itself', text(at(10, '200kW')) === '—');

  // The row must not be blanked for the rest of the session: a driver who goes
  // back to the garage should get their number back.
  check('a garage that reports something new is believed again',
    text(at(7, '140kW')) === '140kW', text(at(7, '140kW')));
  check('…and keeps being believed', text(at(7, '140kW')) === '140kW');

  // The control itself is untouched — the point is to lose the false reading,
  // not the working ±.
  noteRegenStepped();
  const row = projectAids(at(10, '200kW'), 0.51, null).find((r) => r.key === 'regen');
  check('the row and its bounds survive so ± still works',
    !!row && row.maxValue === 10 && row.value === 10, JSON.stringify(row));
  resetRegenStale();
}

console.log('\n5c) The cursor stops only on rows that are on screen');

{
  /*
   * The phantom row, reported from a live LMP2: ▼ walking the MFD stopped
   * between TC Power Cut and Motor Map on nothing at all, and ± there pressed a
   * key the car ignored.
   *
   * The two lists were built from two different questions. The widget draws the
   * aids off the frame, where `projectAids` has already dropped anything the car
   * does not offer; the cursor built its list from the driver's KEY BINDS. A
   * prototype has no ABS — but the driver has ABS bound, because they also race
   * a GT3 — so the cursor kept a row the widget had correctly stopped drawing.
   * Its position in the bind order is exactly where the phantom appeared.
   */
  const { selectAidRows } = require('../dist/server/aidRows');

  // A bind set with everything bound, shaped like the real one.
  const bind = (id, aliases) => ({
    id,
    vmKey: '',
    aliases,
    label: id,
    decFunction: 'd',
    incFunction: 'i',
    dec: { scancode: 1, extended: false, dik: 1 },
    inc: { scancode: 2, extended: false, dik: 2 },
  });
  const allBound = {
    path: 'x',
    keyboardSchemeActive: true,
    aids: [
      bind('brakeBias', ['BRAKE_BIAS']),
      bind('tc', []),
      bind('tcCut', []),
      bind('abs', []),
      bind('motorMap', []),
      bind('regen', []),
    ],
    pit: {},
    all: {},
  };

  // What an LMP2 publishes: no ABS, and no regen either.
  const lmp2 = ['BRAKE_BIAS', 'tc', 'tcCut', 'motorMap'];
  const rows = selectAidRows(allBound, lmp2).map((a) => a.id);
  check('an aid the car does not offer is not a cursor stop', !rows.includes('abs'), rows.join());
  check('…nor is one the car never reported', !rows.includes('regen'), rows.join());
  check('the rows are the car\'s, in the car\'s order',
    rows.join() === 'brakeBias,tc,tcCut,motorMap', rows.join());

  // The other half of the rule has to survive: a row the car HAS but the driver
  // has not bound cannot be stepped, so it is not a stop either.
  const halfBound = { ...allBound, aids: allBound.aids.map((a) =>
    a.id === 'tc' ? { ...a, inc: null, dec: null } : a) };
  const noTc = selectAidRows(halfBound, lmp2).map((a) => a.id);
  check('an unbound aid is still skipped', !noTc.includes('tc'), noTc.join());

  // No live car at all (spectating, game not up) must not empty the cursor —
  // an unknown car is not a car with no controls.
  const blind = selectAidRows(allBound, null).map((a) => a.id);
  check('with no frame behind it, every bound aid is offered', blind.length === 6, blind.join());
  check('…and an empty list means the same thing, not "no aids"',
    selectAidRows(allBound, []).length === 6);
}

console.log('\n5f) The class vetoes controls its cars cannot reach');

{
  /*
   * Reported from a live GT3: both anti-roll-bar rows on the MFD, with ± that
   * step a key the car ignores. The aid bytes were not lying about existing —
   * LMU mirrors the garage SETUP values into them — they were lying about
   * being a cockpit control, and nothing in the data stream can tell those
   * apart. The car's CLASS can; see telemetry/aidAvailability for the matrix
   * and the provenance of every cell.
   */
  const gtLive = {
    tc: { value: 7, max: 11 },
    tcSlip: { value: 7, max: 11 },
    tcCut: { value: 7, max: 11 },
    abs: { value: 9, max: 9 },
    motorMap: { value: 1, max: 1 },
    // The lie, verbatim: a GT3 publishing its garage ARB setup as if it were
    // an in-car adjustment (garage-gt3.json holds 15/16 and 0/16 for the same
    // car the report came from).
    frontARB: { value: 15, max: 15 },
    rearARB: { value: 0, max: 15 },
    tcActive: false,
    absActive: false,
  };
  const gt = projectAids(null, 0.51, gtLive, 'GT3').map((r) => r.key);
  check('a GT3 gets no ARB rows however loud the bytes',
    !gt.includes('frontARB') && !gt.includes('rearARB'), gt.join());
  check('…and keeps every control it does have',
    ['BRAKE_BIAS', 'tc', 'tcSlip', 'tcCut', 'abs', 'motorMap'].every((k) => gt.includes(k)),
    gt.join());

  // The frame spells the class however LMU's entry list does; the veto must
  // resolve `LMGT3` the same way the standings tower does.
  const spelt = projectAids(null, 0.51, gtLive, 'LMGT3').map((r) => r.key);
  check("the frame's own spelling is normalised before the lookup",
    !spelt.includes('frontARB'), spelt.join());

  // Regen reaches the MFD from the garage endpoint, not the live bytes, so the
  // veto has to hold on that path too — a GT3 has nothing to regenerate with.
  const gtRegen = projectAids(
    { VM_REGEN_LEVEL: { value: 5, maxValue: 9, stringValue: '200kW' } },
    0.51, gtLive, 'GT3',
  );
  check('a GT3 gets no regen row even from the garage',
    !gtRegen.some((r) => r.key === 'regen'), gtRegen.map((r) => r.key).join());

  // The slip sub-map is not an LMP2 adjustment (driver report, 2026-08-26:
  // the row was shown and stepped nothing). The power cut beside it is.
  const p2Live = {
    tc: { value: 5, max: 8 },
    tcSlip: { value: 5, max: 8 },
    tcCut: { value: 3, max: 8 },
    abs: { value: 0, max: 0 },
    motorMap: { value: 2, max: 4 },
    tcActive: false,
    absActive: false,
  };
  const p2 = projectAids(null, 0.51, p2Live, 'LMP2').map((r) => r.key);
  check('an LMP2 loses the slip row', !p2.includes('tcSlip'), p2.join());
  check('…but not the power cut beside it', p2.includes('tcCut'), p2.join());
  const elms = projectAids(null, 0.51, p2Live, 'LMP2_ELMS').map((r) => r.key);
  check('the ELMS P2 is the same car for this purpose', !elms.includes('tcSlip'), elms.join());

  // A Hypercar keeps the prototype trio + regen — the veto is per-class, not a
  // blanket suspicion of those four rows.
  const hyLive = {
    tc: { value: 7, max: 11 },
    tcSlip: { value: 10, max: 11 },
    tcCut: { value: 7, max: 11 },
    abs: { value: 0, max: 0 },
    motorMap: { value: 6, max: 10 },
    brakeMigration: { value: 2, max: 5 },
    frontARB: { value: 6, max: 15 },
    rearARB: { value: 1, max: 15 },
    tcActive: false,
    absActive: false,
  };
  const hy = projectAids(
    { VM_REGEN_LEVEL: { value: 10, maxValue: 11, stringValue: '200kW' } },
    0.51, hyLive, 'HYPERCAR',
  ).map((r) => r.key);
  check('a Hypercar keeps migration, both ARBs and regen',
    ['brakeMigration', 'frontARB', 'rearARB', 'regen'].every((k) => hy.includes(k)), hy.join());

  // An unknown car is not a car with no controls — same judgement the cursor
  // makes with no frame behind it. A mod class degrades to the bytes' answer.
  const unk = projectAids(null, 0.51, gtLive, 'SOME_MOD_CLASS').map((r) => r.key);
  check('an unknown class vetoes nothing', unk.includes('frontARB'), unk.join());
  const none = projectAids(null, 0.51, gtLive).map((r) => r.key);
  check('no class at all vetoes nothing', none.includes('frontARB'), none.join());
}

console.log('\n5g) A linked sub-map says so, instead of miming an adjustment');

{
  /*
   * LMU can LINK a car's slip and power-cut maps to the main TC map instead of
   * holding their own value, and while linked their live bytes MIRROR it. The
   * rows showed those mirrored numbers as if they were settings of their own —
   * so every step of TC moved "TC Slip" and "TC Power Cut" in perfect unison,
   * which read as two independent controls being adjusted simultaneously
   * (reported exactly so from a live car). The garage's own word for the state
   * is "Linked", and the row now carries it through the same guarded
   * garage-label path the motor map and ARBs already use.
   */
  const garage = {
    VM_TRACTIONCONTROLSLIPANGLEMAP: { value: 5, maxValue: 9, stringValue: 'Linked' },
    VM_TRACTIONCONTROLPOWERCUTMAP: { value: 5, maxValue: 9, stringValue: '5' },
  };
  const live = {
    tc: { value: 5, max: 8 },
    tcSlip: { value: 5, max: 8 },
    tcCut: { value: 5, max: 8 },
    abs: { value: 9, max: 9 },
    motorMap: { value: 1, max: 1 },
    tcActive: false,
    absActive: false,
  };
  const byKey = Object.fromEntries(
    projectAids(garage, 0.51, live, 'GT3').map((r) => [r.key, r]),
  );
  check('a linked slip map reads "Linked", not a mirrored number',
    byKey.tcSlip.text === 'Linked', byKey.tcSlip.text);
  check('an independent cut map keeps the sim\'s own value',
    byKey.tcCut.text === '5', byKey.tcCut.text);

  // The standing guard: a label belonging to a step the driver has left is
  // worse than no label, so a moved sub-map falls back to the honest index.
  const moved = projectAids(
    garage, 0.51, { ...live, tcSlip: { value: 7, max: 8 } }, 'GT3',
  ).find((r) => r.key === 'tcSlip');
  check('a slip moved off the garage step falls back to the honest index',
    moved.text === '7/8', moved.text);
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
