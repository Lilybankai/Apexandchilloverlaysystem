/**
 * scripts/test-pitcursor.js — the pit-menu cursor's row anchoring.
 * -----------------------------------------------------------------------------
 * The cursor is what the four bindable pit controls (▲ ▼ + −) aim at, and its
 * one hard requirement is that it keeps pointing at the row the driver chose.
 * That is not free: LMU's pit menu changes shape between cars, sessions and
 * damage states — DAMAGE and DRIVER are not always present — so a cursor held as
 * an index alone silently slides onto a different row, and the next `+` lands on
 * a brake duct instead of the left-front tyre. Nobody notices until the stop.
 *
 * So each case here reshapes the menu underneath a cursor and asserts where it
 * ends up, plus the wrap-around and the write targeting. Run:
 *   node scripts/test-pitcursor.js
 */

'use strict';

const {
  getCursor,
  moveCursor,
  moveCursorLive,
  resolveIndex,
  selectRow,
  stepSelected,
} = require('../dist/server/pitCursor');

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

/** A menu row as `receivePitMenu` returns it. */
const row = (name, pmc, settings, current) => ({
  name,
  'PMC Value': pmc,
  currentSetting: current ?? 0,
  settings: (settings ?? ['No Change', 'New Medium', 'New Hard']).map((text) => ({ text })),
});

/** The full menu, as sampled live from LMU. */
const FULL = [
  row('DAMAGE:', 10),
  row('DRIVER:', 11),
  row('FUEL RATIO:', 12),
  row('FL TIRE:', 13),
  row('FR TIRE:', 14),
  row('R WING:', 15),
];
/** The same session minus the two rows that come and go. */
const TRIMMED = FULL.slice(2);

console.log('\n1) The cursor follows its ROW, not its index');

{
  selectRow({ name: 'FL TIRE:' }, FULL);
  check('selecting by name lands on that row', getCursor().index === 3, getCursor().index);
  check(
    'the menu losing two rows above it does NOT move the cursor off FL TIRE',
    TRIMMED[resolveIndex(TRIMMED)].name === 'FL TIRE:',
    TRIMMED[resolveIndex(TRIMMED)].name,
  );
  check('...and the index re-resolves to the new position', resolveIndex(TRIMMED) === 1, resolveIndex(TRIMMED));
}

{
  // The fallback path: the remembered row is gone entirely from this car's menu.
  selectRow({ name: 'DAMAGE:' }, FULL);
  const at = resolveIndex(TRIMMED);
  check('a row that no longer exists falls back to a VALID index', at >= 0 && at < TRIMMED.length, at);
}

console.log('\n2) Moving — wraps rather than dead-ending');

{
  selectRow({ index: 0 }, FULL);
  check('▼ from the first row goes to the second', moveCursor(1, FULL).name === 'DRIVER:');
  selectRow({ index: 0 }, FULL);
  check('▲ from the first row wraps to the LAST', moveCursor(-1, FULL).name === 'R WING:');
  selectRow({ index: FULL.length - 1 }, FULL);
  check('▼ from the last row wraps to the FIRST', moveCursor(1, FULL).name === 'DAMAGE:');
}

console.log('\n3) Empty / absent menu — never throws, never invents a row');

{
  check('resolveIndex of an empty menu is -1', resolveIndex([]) === -1);
  check('moving against an empty menu is a no-op', moveCursor(1, []).index === getCursor().index);
}

console.log('\n4) Live operations against a stub sim');

(async () => {
  // A controller stand-in: records the write, applies it, and can be made to
  // fail the way an out-of-session sim does.
  const stub = (rows) => {
    const state = { writes: [] };
    return {
      state,
      getPitRows: async () => rows,
      setPitRow: async (target, opts) => {
        state.writes.push({ target, opts });
        if (!rows) return { ok: false, status: 0, error: 'no menu' };
        const r = rows.find((x) => x['PMC Value'] === target.pmcValue);
        const next = Math.max(0, Math.min(r.settings.length - 1, r.currentSetting + opts.delta));
        r.currentSetting = next;
        return { ok: true, status: 200, applied: next };
      },
    };
  };

  {
    const menu = FULL.map((r) => ({ ...r, settings: [...r.settings] }));
    const c = stub(menu);
    selectRow({ name: 'FL TIRE:' }, menu);
    const res = await stepSelected(1, c);
    check('+ on the selected row reports the new text', res.text === 'New Medium', res.text);
    check(
      '...and targeted it by the sim\'s own PMC Value, not by position',
      c.state.writes[0].target.pmcValue === 13,
      c.state.writes[0].target.pmcValue,
    );
    check('the cursor has not moved', getCursor().name === 'FL TIRE:', getCursor().name);
    const back = await stepSelected(-1, c);
    check('− returns it', back.text === 'No Change', back.text);
  }

  {
    // The whole point of the name anchor, end to end: the driver aims at FL TIRE
    // on the full menu, the menu loses its first two rows, and + must still hit
    // the tyre rather than whatever slid into index 3.
    const menu = FULL.map((r) => ({ ...r, settings: [...r.settings] }));
    selectRow({ name: 'FL TIRE:' }, menu);
    const trimmed = menu.slice(2);
    const c = stub(trimmed);
    const res = await stepSelected(1, c);
    check('after the menu shrinks, + still changes FL TIRE', c.state.writes[0].target.name === 'FL TIRE:',
      c.state.writes[0].target.name);
    check('...and reports its text, not a neighbour\'s', res.text === 'New Medium', res.text);
  }

  {
    const c = stub(null); // out of a session
    const moved = await moveCursorLive(1, c);
    check('moving with no menu fails cleanly', moved.ok === false && !!moved.error, moved.error);
    const stepped = await stepSelected(1, c);
    check('stepping with no menu fails cleanly', stepped.ok === false && !!stepped.error, stepped.error);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
