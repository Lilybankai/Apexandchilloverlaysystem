/**
 * scripts/test-pitcursor.js — the MFD cursor's row anchoring and reachability.
 * -----------------------------------------------------------------------------
 * The cursor is what the four bindable controls (▲ ▼ + −) aim at, and it has two
 * hard requirements.
 *
 * It must keep pointing at the row the driver chose. That is not free: LMU's pit
 * menu changes shape between cars, sessions and damage states — DAMAGE and
 * DRIVER are not always present — so a cursor held as an index alone silently
 * slides onto a different row, and the next `+` lands on a brake duct instead of
 * the left-front tyre. Nobody notices until the stop.
 *
 * And it must reach EVERYTHING the widget shows a control for. A row that can
 * only be clicked is a row a driver cannot use with both hands on the wheel, so
 * the walked list covers the overlay's own race-control rows, the sim's pit menu
 * and the driving aids — in that order, which is the order they are drawn.
 *
 * Both failure modes below were live bugs: a tyre row drawn by the widget alone
 * that ▲ ▼ could never land on, and an unscoped name lookup that let the cursor
 * resolve one section's row against another's — which put the highlight on two
 * rows at once and made ▼ appear to jump backwards.
 *
 * Run: node scripts/test-pitcursor.js
 */

'use strict';

const {
  buildRows,
  composeRows,
  getCursor,
  moveCursor,
  moveCursorLive,
  resolveIndex,
  selectRow,
  setAidRows,
  setRaceControlRows,
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

/** The walked list with no providers registered — pit rows only. */
const pitOnly = (menu) => composeRows(menu, null);

const keys = (rows) => rows.map((r) => r.key).join();

console.log('\n1) The cursor follows its ROW, not its index');

{
  const rows = pitOnly(FULL);
  const trimmed = pitOnly(TRIMMED);
  selectRow({ key: 'pit:FL TIRE:' }, rows);
  check('selecting by key lands on that row', getCursor().index === 3, getCursor().index);
  check(
    'the menu losing two rows above it does NOT move the cursor off FL TIRE',
    trimmed[resolveIndex(trimmed)].name === 'FL TIRE:',
    trimmed[resolveIndex(trimmed)].name,
  );
  check('...and the index re-resolves to the new position', resolveIndex(trimmed) === 1, resolveIndex(trimmed));
}

{
  // The fallback path: the remembered row is gone entirely from this car's menu.
  const trimmed = pitOnly(TRIMMED);
  selectRow({ key: 'pit:DAMAGE:' }, pitOnly(FULL));
  const at = resolveIndex(trimmed);
  check('a row that no longer exists falls back to a VALID index', at >= 0 && at < trimmed.length, at);
}

console.log('\n2) Moving — wraps rather than dead-ending');

{
  const rows = pitOnly(FULL);
  selectRow({ index: 0 }, rows);
  check('▼ from the first row goes to the second', moveCursor(1, rows).name === 'DRIVER:');
  selectRow({ index: 0 }, rows);
  check('▲ from the first row wraps to the LAST', moveCursor(-1, rows).name === 'R WING:');
  selectRow({ index: rows.length - 1 }, rows);
  check('▼ from the last row wraps to the FIRST', moveCursor(1, rows).name === 'DAMAGE:');
}

{
  // The bug this guards: ▼ from DAMAGE landed back ON damage, because the row it
  // moved to resolved through a name that matched something else. Walking the
  // whole list must visit every row once and only once.
  const rows = pitOnly(FULL);
  selectRow({ index: 0 }, rows);
  const seen = [];
  for (let i = 0; i < rows.length; i++) seen.push(moveCursor(1, rows).key);
  check(
    'a full lap of ▼ visits every row exactly once',
    new Set(seen).size === rows.length,
    seen.join(' → '),
  );
  check('...and comes back to where it started', seen[seen.length - 1] === rows[0].key, seen[seen.length - 1]);
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
      // Mirrors the real controller's contract, including reporting the text it
      // left the row on — the cursor takes the new value from there rather than
      // re-deriving it, because on a tyre row the applied index is into the
      // selectable compounds and not the row's raw settings.
      setPitRow: async (target, opts) => {
        state.writes.push({ target, opts });
        if (!rows) return { ok: false, status: 0, error: 'no menu' };
        const r = rows.find((x) => x['PMC Value'] === target.pmcValue);
        const next = Math.max(0, Math.min(r.settings.length - 1, r.currentSetting + opts.delta));
        r.currentSetting = next;
        return { ok: true, status: 200, applied: next, appliedText: r.settings[next].text };
      },
    };
  };

  {
    const menu = FULL.map((r) => ({ ...r, settings: [...r.settings] }));
    const c = stub(menu);
    selectRow({ key: 'pit:FL TIRE:' }, pitOnly(menu));
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
    // The whole point of the key anchor, end to end: the driver aims at FL TIRE
    // on the full menu, the menu loses its first two rows, and + must still hit
    // the tyre rather than whatever slid into index 3.
    const menu = FULL.map((r) => ({ ...r, settings: [...r.settings] }));
    selectRow({ key: 'pit:FL TIRE:' }, pitOnly(menu));
    const trimmed = menu.slice(2);
    const c = stub(trimmed);
    const res = await stepSelected(1, c);
    check('after the menu shrinks, + still changes FL TIRE', c.state.writes[0].target.name === 'FL TIRE:',
      c.state.writes[0].target.name);
    check('...and reports its text, not a neighbour\'s', res.text === 'New Medium', res.text);
  }

  {
    // The overlay shows a change in the same beat as the press by reading the
    // cursor's own `text`, so a plain GET of the cursor must carry the value the
    // last operation left the row at — not the one it had before.
    const menu = FULL.map((r) => ({ ...r, settings: [...r.settings] }));
    const c = stub(menu);
    selectRow({ key: 'pit:FR TIRE:' }, pitOnly(menu));
    check('the cursor carries the row\'s current text on landing', getCursor().text === 'No Change',
      getCursor().text);
    await stepSelected(1, c);
    check('...and the NEW text after a step, without another read',
      getCursor().text === 'New Medium', getCursor().text);
  }

  {
    const c = stub(null); // out of a session
    const moved = await moveCursorLive(1, c);
    check('moving with no menu fails cleanly', moved.ok === false && !!moved.error, moved.error);
    const stepped = await stepSelected(1, c);
    check('stepping with no menu fails cleanly', stepped.ok === false && !!stepped.error, stepped.error);
  }

  console.log('\n5) Every adjustable row is in the ONE list the cursor walks');

  {
    // The bug this exists to prevent: rows that rendered fine and were completely
    // unreachable from the four bindable controls — which are the only way to use
    // them with both hands on the wheel.
    let serve = 0;
    let aidSteps = 0;
    setRaceControlRows(() => [
      {
        name: 'SERVE:',
        options: ['OFF', 'DRIVE-THRU', 'STOP/GO'],
        current: serve,
        apply: async (n) => { serve = n; return { ok: true, applied: n }; },
      },
    ]);
    setAidRows(() => [
      {
        id: 'tc',
        label: 'Traction Control',
        text: '3 est',
        step: async () => { aidSteps++; return { ok: true, text: '4 est' }; },
      },
    ]);

    const sim = [row('FUEL:', 20, ['0 L', '10 L'])];
    const rows = composeRows(sim, null);
    check('race rows come first', rows[0].key === 'race:SERVE:', keys(rows));
    check('…the sim rows next', rows[1].key === 'pit:FUEL:');
    check('…and the aids last — the order the widget draws them', rows[2].key === 'aid:tc');

    const guard = {
      getPitRows: async () => sim,
      setPitRow: async () => { throw new Error('must not write the sim menu'); },
    };

    selectRow({ key: 'race:SERVE:' }, rows);
    check('the cursor can land on a race-control row', getCursor().key === 'race:SERVE:');
    check('…and reads its value', getCursor().text === 'OFF', getCursor().text);

    // Stepping must reach the row's own handler, never a pit-menu write.
    const vres = await stepSelected(1, guard);
    check('stepping a race row runs its handler', vres.ok === true && serve === 1, vres.error);
    check('…and reports the new value', getCursor().text === 'DRIVE-THRU', getCursor().text);

    // Clamped, not wrapped: one extra press on a blind control must not roll
    // round from the last option to the first and fire something unintended.
    await stepSelected(1, guard);
    await stepSelected(1, guard);
    check('a race row clamps at its last option', serve === 2, serve);
    await stepSelected(-1, guard);
    await stepSelected(-1, guard);
    await stepSelected(-1, guard);
    check('…and at its first', serve === 0, serve);

    // The aid rows are the half that used to be mouse-only.
    const live = await buildRows(guard);
    selectRow({ key: 'aid:tc' }, live);
    check('the cursor can land on an aid row', getCursor().section === 'aid', getCursor().section);
    const ares = await stepSelected(1, guard);
    check('stepping an aid row presses its key', ares.ok === true && aidSteps === 1, ares.error);
    check('…and reports the estimate it left behind', getCursor().text === '4 est', getCursor().text);
  }

  console.log('\n6) A press never acts on a row the driver did not aim at');

  {
    // Seen live: the sim left its session, the pit menu vanished, and the cursor
    // — anchored on a tyre row that no longer existed — fell back to an index
    // that landed on SERVE, whose action strips the whole pit stop. A press must
    // re-anchor and refuse rather than act on whatever slid underneath it.
    let served = 0;
    setRaceControlRows(() => [
      {
        name: 'SERVE:',
        options: ['OFF', 'DRIVE-THRU', 'STOP/GO'],
        current: 0,
        apply: async (n) => { served++; return { ok: true, applied: n }; },
      },
    ]);
    setAidRows(null);

    const menu = [row('TIRES:', 8, ['No Change', 'New Wet'])];
    selectRow({ key: 'pit:TIRES:' }, composeRows(menu, null));
    check('aimed at the tyre row', getCursor().key === 'pit:TIRES:');

    const gone = { getPitRows: async () => null, setPitRow: async () => ({ ok: true, status: 200 }) };
    const res = await stepSelected(1, gone);
    check('the press is refused when that row has gone', res.ok === false, res.error);
    check('…and SERVE was NOT actioned', served === 0, served);
    check('…while the cursor re-anchors somewhere real', getCursor().key === 'race:SERVE:',
      getCursor().key);
    const second = await stepSelected(1, gone);
    check('the NEXT press acts on the row now selected', second.ok === true && served === 1, served);
  }

  console.log('\n7) A name is only ever resolved within its own section');

  {
    // The failure this rules out: the overlay's rows and the sim's are named in
    // the same style, so an unscoped lookup let one match the other. That is what
    // put the highlight on PIT REQUEST and a pit row at the same time, and made
    // ▼ appear to jump back up the list.
    setRaceControlRows(() => [
      {
        name: 'PIT REQUEST:',
        options: ['NO', 'YES'],
        current: 0,
        apply: async (n) => ({ ok: true, applied: n }),
      },
    ]);
    setAidRows(null);

    const collide = [row('PIT REQUEST:', 30, ['NO', 'YES']), row('DAMAGE:', 31)];
    const rows = composeRows(collide, null);
    check('a same-named sim row is its OWN row in the list', rows.length === 3, keys(rows));

    selectRow({ key: 'pit:PIT REQUEST:' }, rows);
    check('aiming at the sim row lands on the sim row', getCursor().index === 1, getCursor().index);
    check('…and stays there when the list is re-resolved', resolveIndex(rows) === 1, resolveIndex(rows));
    check('…with the section recorded', getCursor().section === 'pit', getCursor().section);

    selectRow({ key: 'race:PIT REQUEST:' }, rows);
    check('aiming at the overlay row lands on the overlay row', getCursor().index === 0, getCursor().index);
    check('…and it too holds on re-resolve', resolveIndex(rows) === 0, resolveIndex(rows));

    setRaceControlRows(null);
    check('clearing the providers removes their rows', composeRows(collide, null).length === 2);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
