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
const { parseSvmValues } = require('../dist/telemetry/svmMap.js');
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

/* ---- .svm parsing (the library's Load path) ------------------------------ */

console.log('\nsample-tune.svm — the .svm → REST-key translation');
{
  const svm = fs.readFileSync(path.join(fixtureDir, 'sample-tune.svm'), 'utf8');
  const parsed = parseSvmValues(svm);

  check('header vehicle class read', parsed.vehicleClass === 'GT3 Test_Car_LMGT3 WEC2025');
  check('symmetric read', parsed.symmetric === true);
  check(
    'every setting name in the fixture is mapped',
    parsed.unmapped.length === 0,
    parsed.unmapped.join(', ') || 'all mapped',
  );
  check(
    'every parsed key is a legal write target',
    Object.keys(parsed.values).every((k) => GARAGE_WRITE_KEY.test(k)),
  );

  // Spot-checks across every section — a mis-mapped name shows as a wrong
  // value because the fixture gives each line a distinct one.
  const expect = {
    VM_FUEL_LEVEL: 90,
    VM_REAR_WING: 4,
    VM_BRAKE_DUCTS_REAR: 4,
    VM_FRONT_ANTISWAY: 6,
    VM_REAR_3RD_TENDERSPRINGTRAVEL: 4,
    VM_BRAKE_BALANCE: 23,
    VM_ANTILOCKBRAKESYSTEMMAP: 9,
    VM_REGEN_LEVEL: 3,
    VM_GEAR_7: 9,
    VM_TORQUE_SPLIT: 1,
    VM_DIFF_PRELOAD: 87,
    VM_CHASSIS_ADJ_11: 3,
    'WM_CAMBER-W_FL': 21,
    'WM_CAMBER-W_RR': 30,
    'WM_PACKERS-W_FR': 7,
    'WM_SRUBBER-W_RL': 5,
    'WM_COMPOUND-W_RR': 4,
  };
  const wrong = Object.entries(expect).filter(([k, v]) => parsed.values[k] !== v);
  check(
    'section+name → key spot checks across all sections',
    wrong.length === 0,
    wrong.map(([k]) => k).join(', ') || `${Object.keys(expect).length} checked`,
  );
  check('the [BASIC] pseudo-sliders are not settings', !('Downforce' in parsed.values));
}

/* ---- 5. the first-run walkthrough ---------------------------------------- */
/*
 * The guide opens itself exactly once per driver, which is also the only time
 * anyone will notice it is wrong. Its wiring is the parity test's job; what is
 * checked here is the content — that every step actually says something, and
 * that the seen flag is versioned, since an unversioned flag can never be used
 * to re-offer the tour when the tab grows.
 */
{
  console.log('\nSetups walkthrough');
  const guide = require('../electron/control-panel/setup-guide.js');
  const steps = guide.STEPS;

  check('there are steps at all', Array.isArray(steps) && steps.length >= 3, `${steps.length} steps`);

  const badId = steps.filter((s) => !/^[a-z][a-z0-9-]*$/.test(String(s.id || '')));
  check('every step has a slug id', badId.length === 0, badId.map((s) => s.id).join(', '));

  const ids = new Set(steps.map((s) => s.id));
  check('no two steps share an id', ids.size === steps.length);

  const thin = steps.filter(
    (s) => !s.title || !s.lead || s.lead.length < 30 || !Array.isArray(s.points) || !s.points.length,
  );
  check(
    'every step has a title, a lead and at least one point',
    thin.length === 0,
    thin.map((s) => s.id).join(', ') || `${steps.length} checked`,
  );

  const emptyPoint = steps.filter((s) => (s.points || []).some((p) => !p || p.trim().length < 20));
  check(
    'no point is a stub',
    emptyPoint.length === 0,
    emptyPoint.map((s) => s.id).join(', '),
  );

  const noIcon = steps.filter((s) => !/^[a-z][a-z0-9-]*$/.test(String(s.icon || '')));
  check('every step names a sprite icon', noIcon.length === 0, noIcon.map((s) => s.id).join(', '));

  // The last step has to say how to get back — it is the only pointer to the
  // "How it works" button anyone is ever shown.
  const last = steps[steps.length - 1];
  check(
    'the last step says how to reopen the walkthrough',
    /how it works/i.test([last.lead, ...(last.points || [])].join(' ')),
  );

  check(
    'the seen flag is versioned',
    typeof guide.GUIDE_VERSION === 'string' && guide.GUIDE_VERSION.length > 0,
    `v${guide.GUIDE_VERSION} under ${guide.SEEN_KEY}`,
  );
  check(
    'the seen key is namespaced with the tab’s other preferences',
    String(guide.SEEN_KEY).startsWith('apex.setup.'),
    guide.SEEN_KEY,
  );
}

console.log(failures === 0 ? '\nAll setup checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
