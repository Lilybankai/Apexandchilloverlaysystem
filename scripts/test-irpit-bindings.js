#!/usr/bin/env node
/**
 * The iRacing pit BINDINGS and the panel's show / hide (1.3.16-beta.7).
 *
 * Carl could not find any iRacing binding rows in Settings on beta.6. They were
 * there (Settings → Controls), but the group is built through actions.js's
 * `tryRequire`, which swallows a load failure — a broken require would make the
 * whole group vanish with no error anywhere. This pins every row, its sim and
 * its kind, that the panel toggle cycles the widget mode, and that the per-tyre
 * and pressure intents plan into real commands.
 *
 * Run: `npm run test:irpit-bindings` (after `npm run build`).
 */
'use strict';

const path = require('path');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   [${detail}]`}`);
};

(async () => {
  const { createActions } = require(path.join(__dirname, '..', 'electron', 'actions.js'));
  let cycled = null;
  const deps = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === 'loadSettings'
          ? () => ({})
          : k === 'cycleWidgetMode'
            ? (id) => {
                cycled = id;
              }
            : async () => ({ ok: true }),
    },
  );
  const acts = createActions(deps);
  const ir = acts.list().filter((x) => x.group === 'iRacing pit');
  const want = [
    'irpit.toggle',
    'irpit.fuel',
    'irpit.fuelToFinish',
    'irpit.tyresAll',
    'irpit.tyresNone',
    'irpit.fastRepair',
    'irpit.tearoff',
    'irpit.clear',
    'irpit.tyre.lf',
    'irpit.tyre.rf',
    'irpit.tyre.lr',
    'irpit.tyre.rr',
    'irpit.pressure.all',
    'irpit.pressure.lf',
    'irpit.pressure.rf',
    'irpit.pressure.lr',
    'irpit.pressure.rr',
  ];
  const missing = want.filter((id) => !ir.some((x) => x.id === id));
  check('all 17 iRacing pit rows exist', missing.length === 0, `missing ${missing.join(',')}`);
  check(
    'every one is iRacing-only',
    ir.every((x) => Array.isArray(x.sims) && x.sims.length === 1 && x.sims[0] === 'iracing'),
  );
  check(
    'pressures and fuel are ± (delta) bindings; the rest single presses',
    ir.every((x) => (x.id.startsWith('irpit.pressure.') || x.id === 'irpit.fuel' ? x.kind === 'delta' : x.kind === 'pulse')),
  );
  const none = acts.list().filter((x) => x.group === 'iRacing pit' && !x.sims);
  check('no iRacing pit row leaks into LMU mode (all carry sims)', none.length === 0);

  const r = await acts.run('irpit.toggle');
  check('Show / hide panel cycles the irpit widget mode', r && r.ok === true && cycled === 'irpit', JSON.stringify(r));

  const C = require(path.join(__dirname, '..', 'dist', 'server', 'irPitControl.js'));
  const service = {
    items: [
      { id: 'lf', label: 'LF', state: 'requested' },
      { id: 'rf', label: 'RF', state: 'requested' },
      { id: 'lr', label: 'LR', state: 'off' },
      { id: 'rr', label: 'RR', state: 'off' },
      { id: 'fuel', label: 'FUEL', state: 'off' },
    ],
    pressuresKpa: [165, 165, 160, 160],
    fuelAddL: 0,
    autoFuel: false,
  };
  const plan = (intent) => {
    try {
      return C.planPitIntent(intent, { service });
    } catch (e) {
      return String(e && e.message);
    }
  };
  const lrOn = plan({ kind: 'tyre', corner: 'lr' });
  check('LR tyre on (was off) → one command', Array.isArray(lrOn) && lrOn.length === 1, JSON.stringify(lrOn));
  const lfOff = plan({ kind: 'tyre', corner: 'lf' });
  check(
    'LF tyre off (was on) → clear, then re-tick RF only',
    Array.isArray(lfOff) && lfOff.length === 2,
    JSON.stringify(lfOff),
  );
  const all = plan({ kind: 'pressure', corner: 'all', deltaKpa: 7 });
  check(
    'all-four pressure + → four tyre commands, each 7 kPa up',
    Array.isArray(all) && all.length === 4 && all[0].param === 172 && all[2].param === 167,
    JSON.stringify(all),
  );
  const rr = plan({ kind: 'pressure', corner: 'rr', deltaKpa: -7 });
  check('RR pressure − → one command at 153 kPa', Array.isArray(rr) && rr.length === 1 && rr[0].param === 153, JSON.stringify(rr));

  // The panel's two display modes are registered where main validates them.
  const mainSrc = require('fs').readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  check("WIDGET_MODES.irpit = ['pits', 'always']", /irpit: \['pits', 'always'\]/.test(mainSrc));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
