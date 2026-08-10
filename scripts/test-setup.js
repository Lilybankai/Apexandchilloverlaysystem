/**
 * scripts/test-setup.js — the setup editor's headless contract.
 * -----------------------------------------------------------------------------
 * Pins the pure halves of the setup editor to a REAL car's data: the checked-in
 * fixtures under scripts/fixtures/garage-*.json are live captures of LMU's
 * `getPlayerGarageData` (made by probe-garage-keys.js --save), so every rule
 * asserted here was true of the actual sim at capture time:
 *
 *   1. projection — the maxValue-is-a-count convention, the dirty flag,
 *      gearGraph/symmetric skipping, payload-order preservation
 *   2. the write-key guard — accepts every real key, rejects the shapes a
 *      request could smuggle
 *   3. grouping — every real key has an explicit or pattern home (the
 *      catch-all renders, but a key landing there is a regression)
 *   4. macros — every match hits at least one real key (or names a key the
 *      class genuinely lacks), resolution clamps, skips locked keys, and
 *      staging back to zero clicks stages nothing
 *
 * Run: node scripts/test-setup.js   (needs a built dist/ for the projection)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { GARAGE_WRITE_KEY, projectSetupState } = require('../dist/telemetry/setupState.js');
const groups = require('../electron/control-panel/setup-groups.js');
const infoApi = require('../electron/control-panel/setup-info.js');
const macroApi = require('../electron/control-panel/setup-macros.js');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`);
  if (!ok) failures += 1;
}

const fixtureDir = path.join(__dirname, 'fixtures');
const fixtures = fs
  .readdirSync(fixtureDir)
  .filter((f) => /^garage-[a-z0-9-]+\.json$/.test(f))
  .map((f) => ({ name: f, data: JSON.parse(fs.readFileSync(path.join(fixtureDir, f), 'utf8')) }));

if (fixtures.length === 0) {
  console.error('No fixtures in scripts/fixtures — run probe-garage-keys.js --save <class> first.');
  process.exit(1);
}

for (const { name, data } of fixtures) {
  console.log(`\n${name}`);
  const state = projectSetupState(data, 'Test Car', 'GT3');

  /* ---- 1. projection ---------------------------------------------------- */

  const rawSettingKeys = Object.keys(data).filter(
    (k) => data[k] && typeof data[k].value === 'number' && typeof data[k].maxValue === 'number',
  );
  check(
    'every setting-shaped key projects, nothing else does',
    state.settings.length === rawSettingKeys.length,
    `${state.settings.length} of ${rawSettingKeys.length}`,
  );
  check(
    'gearGraph and symmetric are not settings',
    !state.settings.some((s) => s.key === 'gearGraph' || s.key === 'symmetric'),
  );
  check('symmetric passes through as a boolean', typeof state.symmetric === 'boolean');

  const maxOk = state.settings.every((s) => {
    const raw = data[s.key];
    return s.max === Math.max(raw.minValue ?? 0, raw.maxValue - 1);
  });
  check('max is inclusive (maxValue is an option count)', maxOk);

  const dirtyOk = state.settings.every((s) => {
    const raw = data[s.key];
    const last = typeof raw.lastSavedStringValue === 'string' ? raw.lastSavedStringValue : raw.stringValue;
    return s.dirty === (raw.stringValue !== last);
  });
  check('dirty flag mirrors stringValue vs lastSavedStringValue', dirtyOk);

  const orderOk = state.settings.every((s, i) => rawSettingKeys[i] === s.key);
  check('payload order preserved', orderOk);

  /* ---- 2. write-key guard ------------------------------------------------- */

  check(
    'guard accepts every real key',
    state.settings.every((s) => GARAGE_WRITE_KEY.test(s.key)),
  );
  const evil = [
    'VM_X; DROP',
    'WM_CAMBER-W_XX',
    'WM_CAMBER-W_FLX',
    'vm_brake_balance',
    'VM_BRAKE_BALANCE/../secret',
    'WM_PRESSURE',
    '',
  ];
  check(
    'guard rejects malformed keys',
    evil.every((k) => !GARAGE_WRITE_KEY.test(k)),
  );

  /* ---- 3. grouping ---------------------------------------------------------- */

  const homeless = state.settings
    .map((s) => ({ key: s.key, c: groups.classifyKey(s.key) }))
    .filter((x) => !x.c.explicit && !x.c.pattern)
    .map((x) => x.key);
  check('every key has an explicit or pattern home', homeless.length === 0, homeless.join(', ') || 'all placed');

  const badTabs = state.settings
    .map((s) => groups.classifyKey(s.key).tab)
    .filter((t) => !groups.TABS.includes(t));
  check('every classification lands on a real tab', badTabs.length === 0);

  /* ---- 4. macros -------------------------------------------------------------- */

  const settingsMap = new Map(
    state.settings.map((s) => [
      s.key,
      { value: s.value, min: s.min, max: s.max, isFree: s.isFree, available: s.available },
    ]),
  );
  const keys = state.settings.map((s) => s.key);

  // Every match must resolve to at least one key of THIS fixture, or be a key
  // that legitimately varies by class (hybrid/oval hardware) — a typo'd match
  // silently nudging nothing is precisely the bug this catches.
  const CLASS_VARIABLE = new Set(['VM_TORQUE_SPLIT']); // hybrid-only; in overrides
  const deadMatches = [];
  for (const macro of macroApi.MACROS) {
    for (const e of macro.effects) {
      if (macroApi.expandMatch(e.match, keys).length === 0 && !CLASS_VARIABLE.has(e.match)) {
        deadMatches.push(`${macro.id}:${e.match}`);
      }
    }
  }
  check('every macro match hits this car', deadMatches.length === 0, deadMatches.join(', ') || 'all live');

  // Full-scale resolution stays in bounds and never touches a locked key.
  let outOfBounds = 0;
  let lockedTouched = 0;
  for (const macro of macroApi.MACROS) {
    for (const clicks of [-macroApi.RANGE, macroApi.RANGE]) {
      const { changes } = macroApi.resolveMacro(macro, clicks, settingsMap, 'GT3');
      for (const ch of changes) {
        const s = settingsMap.get(ch.key);
        if (ch.to < s.min || ch.to > s.max) outOfBounds += 1;
        if (s.isFree === false || s.min >= s.max) lockedTouched += 1;
      }
    }
  }
  check('macro resolution clamps to the sim bounds', outOfBounds === 0);
  check('macro resolution skips locked and fixed keys', lockedTouched === 0);

  const zero = macroApi.MACROS.map((m) => macroApi.resolveMacro(m, 0, settingsMap, 'GT3'));
  check(
    'zero clicks stages nothing',
    zero.every((r) => r.changes.length === 0),
  );

  /* ---- 5. info coverage --------------------------------------------------------- */

  // Every ADJUSTABLE key should have authored info text — the ⓘ falls back to
  // generic words, but an adjustable control without an explanation defeats
  // the feature's purpose. Fixed rows may stay generic.
  const uncovered = [];
  for (const s of state.settings) {
    if (!s.available || s.min >= s.max) continue;
    const family = s.key.replace(/-W_(FL|FR|RL|RR)$/, '');
    if (!infoApi.infoFor(family)) uncovered.push(family);
  }
  const uniqUncovered = [...new Set(uncovered)];
  check('every adjustable key has info text', uniqUncovered.length === 0, uniqUncovered.join(', ') || 'covered');
}

console.log(failures === 0 ? '\nAll setup checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
