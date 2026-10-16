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

/* ---- macro helpers (shared by the fixture loop and the census section) ---- */

const dirsApi = require('../electron/control-panel/setup-directions.js');

/**
 * The class each garage capture really is. garage-gt3.json predates the
 * census and is NOT a GT3: its brake ladder (17 = 52.3:47.7), "D36 H-H" front
 * bar, FF6 diff ramps, 220 N/mm / 950 lbf/in springs, "Linked" TC slip and
 * N/A ABS are an Oreca 07 LMP2 rung for rung (checked against the census
 * below). Kept under its old name because other suites load it by that name.
 */
const FIXTURE_CLASS = { 'garage-gt3.json': 'LMP2' };

/** Every class with an override block, plus the ELMS spelling that falls back to LMP2. */
const MACRO_CLASSES = ['GT3', 'GTE', 'HYPERCAR', 'LMP2', 'LMP2_ELMS', 'LMP3'];

const MEANINGFUL_SKIPS = new Set(['fixed by ruleset', 'detached']);

/** Settings whose index 0 is "Detached"/"N/A" — no bar or spring at all. */
const DETACHABLE = ['VM_FRONT_ANTISWAY', 'VM_REAR_ANTISWAY', 'VM_FRONT_3RD_SPRING', 'VM_REAR_3RD_SPRING'];

function noisySkips(settings, cls) {
  const out = new Set();
  for (const macro of macroApi.MACROS) {
    for (const clicks of [-macroApi.RANGE, macroApi.RANGE]) {
      for (const sk of macroApi.resolveMacro(macro, clicks, settings, cls).skipped) {
        if (!MEANINGFUL_SKIPS.has(sk.reason)) out.add(`${macro.id}:${sk.key || sk.match} (${sk.reason})`);
      }
    }
  }
  return [...out];
}

function floorRespected(settings) {
  // Two probes per floored key: sitting just above the floor (a macro may not
  // step down onto Detached), and sitting on it (a macro may not re-fit it).
  // Named here rather than read from the table, so a floor deleted from the
  // table fails this instead of quietly dropping out of it.
  const floored = [...settings.keys()].filter((k) => DETACHABLE.includes(k));
  for (const k of floored) {
    for (const at of [0, 1]) {
      const s = new Map(settings);
      s.set(k, { ...settings.get(k), value: at, min: 0, max: Math.max(4, settings.get(k).max) });
      for (const cls of MACRO_CLASSES) {
        for (const macro of macroApi.MACROS) {
          for (let clicks = -macroApi.RANGE; clicks <= macroApi.RANGE; clicks += 1) {
            for (const ch of macroApi.resolveMacro(macro, clicks, s, cls).changes) {
              if (ch.key === k && (ch.to < 1 || ch.from < 1)) return false;
            }
          }
        }
      }
    }
  }
  return true;
}

/** A copy with every adjustable key in the middle of its range. */
function centred(settings) {
  const out = new Map();
  for (const [k, s] of settings) {
    out.set(k, s.min < s.max ? { ...s, value: Math.round((s.min + s.max) / 2) } : { ...s });
  }
  return out;
}

function balanceStillAtOneClick(settings, cls) {
  const still = [];
  for (const macro of macroApi.MACROS.filter((m) => m.group === 'balance')) {
    for (const clicks of [-1, 1]) {
      if (macroApi.resolveMacro(macro, clicks, settings, cls).changes.length === 0) still.push(`${macro.id}@${clicks}`);
    }
  }
  return still;
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
  // silently nudging nothing is precisely the bug this catches. Class
  // overrides' extra effects are held to the same rule. Nothing is exempt
  // today: every key a macro names is published (if sometimes fixed) by
  // every car LMU ships.
  const CLASS_VARIABLE = new Set();
  const deadMatches = [];
  for (const macro of macroApi.MACROS) {
    const extras = Object.values(macro.classOverrides || {}).flatMap((ov) => ov.extra || []);
    for (const e of [...macro.effects, ...extras]) {
      if (macroApi.expandMatch(e.match, keys).length === 0 && !CLASS_VARIABLE.has(e.match)) {
        deadMatches.push(`${macro.id}:${e.match}`);
      }
    }
  }
  check('every macro match hits this car', deadMatches.length === 0, deadMatches.join(', ') || 'all live');

  // Full-scale resolution stays in bounds and never touches a locked key — on
  // every class with overrides, so each override block actually runs.
  let outOfBounds = 0;
  let lockedTouched = 0;
  for (const cls of MACRO_CLASSES) {
    for (const macro of macroApi.MACROS) {
      for (const clicks of [-macroApi.RANGE, macroApi.RANGE]) {
        const { changes } = macroApi.resolveMacro(macro, clicks, settingsMap, cls);
        for (const ch of changes) {
          const s = settingsMap.get(ch.key);
          if (ch.to < s.min || ch.to > s.max) outOfBounds += 1;
          if (s.isFree === false || s.min >= s.max) lockedTouched += 1;
        }
      }
    }
  }
  check('macro resolution clamps to the sim bounds', outOfBounds === 0, MACRO_CLASSES.join(' '));
  check('macro resolution skips locked and fixed keys', lockedTouched === 0);

  const zero = macroApi.MACROS.map((m) => macroApi.resolveMacro(m, 0, settingsMap, 'GT3'));
  check(
    'zero clicks stages nothing',
    zero.every((r) => r.changes.length === 0),
  );

  // This capture's real class (see FIXTURE_CLASS): at full scale, every skip
  // must name something THIS car has locked or detached — never a part the
  // whole class was built without, which is an override's job to remove.
  const trueClass = FIXTURE_CLASS[name] || 'GT3';
  const noise = noisySkips(settingsMap, trueClass);
  check(`as ${trueClass}, every skip is meaningful`, noise.length === 0, noise.join(', ') || 'only locked/detached');

  // Detached bars and unfitted third springs: never stepped onto, never off.
  check('no macro ever moves a bar or third spring onto index 0', floorRespected(settingsMap), MACRO_CLASSES.join(' '));

  // From a centred setup (an end-stop legitimately blocks one direction),
  // one click either way moves at least one real setting.
  for (const cls of ['GT3', trueClass]) {
    const still = balanceStillAtOneClick(centred(settingsMap), cls);
    check(`as ${cls}, every balance slider moves a setting at ±1 click`, still.length === 0, still.join(', ') || 'all move');
  }

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

  // The census reads the //label half of each line through svmKeyFor, which
  // must place every line exactly where parseSvmValues does.
  const { svmKeyFor } = require('../dist/telemetry/svmMap.js');
  let section = '';
  const viaKeyFor = {};
  for (const raw of svm.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[([A-Z0-9]+)\]$/.exec(line);
    if (sec) section = sec[1];
    const kv = /^([A-Za-z0-9]+)=(-?\d+)(?:\/\/|$)/.exec(line);
    const key = kv ? svmKeyFor(section, kv[1]) : null;
    if (key) viaKeyFor[key] = Number(kv[2]);
  }
  const keyForDrift = Object.keys(parsed.values).filter((k) => viaKeyFor[k] !== parsed.values[k]);
  check(
    'svmKeyFor places every line where parseSvmValues does',
    keyForDrift.length === 0 && Object.keys(viaKeyFor).length === Object.keys(parsed.values).length,
    keyForDrift.join(', ') || `${Object.keys(viaKeyFor).length} keys`,
  );
}

/* ---- corner balance: the macro table and the direction table ---------------
 *
 * The engineer's balance sliders are only as right as the direction each key
 * is moved in. Directions live in setup-directions.js with their evidence;
 * this pins the macros to that table, the table to every saved setup on the
 * census (scripts/fixtures/svm-ladders.json), and — once a human has walked a
 * car with probe-setup-ladders.js — to the full ladders it captures.
 */
{
  console.log('\nCorner balance — macros and directions');
  const groupIds = macroApi.GROUPS.map((g) => g.id);

  check(
    'every macro names a real group',
    macroApi.MACROS.every((m) => groupIds.includes(m.group)),
    groupIds.join(', '),
  );
  const order = macroApi.MACROS.map((m) => m.group);
  const contiguous = order.every((g, i) => i === 0 || g === order[i - 1] || !order.slice(0, i).includes(g));
  check('groups are contiguous, so each heading renders once', contiguous, order.join(' '));
  const balance = macroApi.MACROS.filter((m) => m.group === 'balance').map((m) => m.id);
  check(
    'Corner balance is slow entry, slow mid, slow exit, medium, fast',
    balance.join(',') === 'slow-entry,slow-mid,slow-exit,medium,fast',
    balance.join(', '),
  );
  check(
    'the four situational sliders stay, under conditions',
    ['top-speed', 'kerb-compliance', 'tyre-temps', 'bumpy-track'].every(
      (id) => (macroApi.MACROS.find((m) => m.id === id) || {}).group === 'conditions',
    ),
  );
  const badHint = macroApi.MACROS.filter(
    (m) => !m.hint || m.hint.length < 30 || (m.group === 'balance' && !/right/i.test(m.hint)),
  );
  check(
    'every slider explains itself (balance hints say what right does)',
    badHint.length === 0,
    badHint.map((m) => m.id).join(', ') || 'all',
  );

  // Every effect, base and override, in physical terms the table can turn
  // into an index direction. A family missing from the table is a guess.
  const allEffects = macroApi.MACROS.flatMap((m) =>
    [
      ...m.effects,
      ...Object.values(m.classOverrides || {}).flatMap((ov) => ov.extra || []),
    ].map((e) => ({ id: m.id, ...e })),
  );
  const unsourced = allEffects.filter((e) => !dirsApi.TABLE[dirsApi.familyOfMatch(e.match)]);
  check(
    'every effect’s direction comes from the direction table',
    unsourced.length === 0,
    unsourced.map((e) => `${e.id}:${e.match}`).join(', ') || `${allEffects.length} effects`,
  );
  const badWant = allEffects.filter((e) => e.want !== 1 && e.want !== -1);
  check('every effect wants +1 or −1, never a raw index sign', badWant.length === 0);
  const unverified = allEffects.filter((e) => {
    const t = dirsApi.TABLE[dirsApi.familyOfMatch(e.match)];
    return t && !t.verified;
  });
  check(
    'no macro moves a key whose direction is unverified',
    unverified.length === 0,
    unverified.map((e) => `${e.id}:${e.match}`).join(', ') || 'all verified',
  );
  const WEIGHTS = new Set([1, 0.8, 0.6, 0.4, 0.2]);
  const reweights = macroApi.MACROS.flatMap((m) =>
    Object.values(m.classOverrides || {}).flatMap((ov) => (ov.reweight || []).map((r) => r.weight)),
  );
  const allWeights = [...allEffects.map((e) => e.weight), ...reweights.filter((w) => w !== 0)];
  check('weights come from the 1 / 0.8 / 0.6 / 0.4 / 0.2 ladder', allWeights.every((w) => WEIGHTS.has(w)));
  // clicks × weight landing on .5 is the only place a rounding rule could make
  // +n and −n differ; with these weights it never does.
  let halfway = 0;
  for (const w of allWeights) {
    for (let c = 1; c <= macroApi.RANGE; c += 1) if (Math.abs(((c * w) % 1) - 0.5) < 1e-9) halfway += 1;
  }
  check('+n and −n clicks are exact mirror images (no .5 products)', halfway === 0);

  /* ---- the census ---------------------------------------------------------- */

  const census = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'svm-ladders.json'), 'utf8'));
  const cars = Object.entries(census.cars);
  const DEAD = /^(N\/A|Non-adjustable|Fixed)$/i; // labels of a setting that cannot move
  check('the census covers GT3, Hypercar and LMP2', ['GT3', 'HYPERCAR', 'LMP2'].every((c) => cars.some(([, v]) => v.class === c)));

  const against = [];
  let agreed = 0;
  for (const [car, { keys: ks }] of cars) {
    for (const [k, rungs] of Object.entries(ks)) {
      const r = dirsApi.checkRungs(k, Object.entries(rungs));
      if (r.verdict === 'agree') agreed += 1;
      else if (r.verdict === 'disagree' || r.verdict === 'mixed') against.push(`${car} ${k} (${r.verdict})`);
    }
  }
  check(
    'the direction table agrees with every parseable ladder in the census',
    against.length === 0 && agreed > 300,
    against.slice(0, 6).join(' | ') || `${agreed} ladders agree`,
  );

  // Any setting the census shows as "Detached"/"N/A" at index 0 with real
  // labels above it must be in DETACHABLE (and floored in the table) — a new
  // one would otherwise be stepped onto "Detached" as if it were "softer".
  const detachedAtZero = new Set();
  for (const [, { keys: ks }] of cars) {
    for (const [k, rungs] of Object.entries(ks)) {
      const zeroLabel = String(rungs['0'] || '').trim();
      const above = Object.entries(rungs).filter(([i, l]) => Number(i) > 0 && !DEAD.test(String(l).trim()));
      if (/^(Detached|N\/A)$/i.test(zeroLabel) && above.length) detachedAtZero.add(k);
    }
  }
  const unguarded = [...detachedAtZero].filter((k) => !DETACHABLE.includes(k) || !(dirsApi.entryFor(k) || {}).floor);
  check(
    'every setting with "Detached"/"N/A" at index 0 is floored',
    unguarded.length === 0,
    unguarded.join(', ') || [...detachedAtZero].join(', '),
  );

  // garage-gt3.json is an Oreca 07: its labels sit on the census Oreca's
  // ladders, and merged with them the table still agrees.
  const oreca = census.cars['ELMS2025 LMP2_ELMS Oreca_07'];
  const garage = fixtures.find((f) => f.name === 'garage-gt3.json');
  if (oreca && garage) {
    let same = 0;
    const mergedAgainst = [];
    for (const [k, rungs] of Object.entries(oreca.keys)) {
      const g = garage.data[k];
      if (!g || typeof g.value !== 'number') continue;
      if (rungs[g.value] !== undefined && rungs[g.value].trim() === String(g.stringValue).trim()) same += 1;
      const r = dirsApi.checkRungs(k, [...Object.entries(rungs), [g.value, g.stringValue]]);
      if (r.verdict === 'disagree' || r.verdict === 'mixed') mergedAgainst.push(k);
    }
    check('garage-gt3.json is the Oreca 07 LMP2 rung for rung', same >= 60, `${same} rungs identical`);
    check(
      'the table agrees with the garage capture merged into the Oreca census',
      mergedAgainst.length === 0,
      mergedAgainst.join(', ') || 'agrees',
    );
  }

  /**
   * A class-wide settings map from the census: a key is adjustable when any
   * car in the class saved two different indices, fixed when every label it
   * ever showed is "N/A"/"Non-adjustable"/"Fixed", and otherwise assumed
   * adjustable a little either side of what was seen (nobody happened to move
   * it). Values sit mid-range.
   */
  function classMap(cls) {
    const seen = new Map();
    for (const [, car] of cars) {
      if (car.class !== cls) continue;
      for (const [k, rungs] of Object.entries(car.keys)) {
        if (!seen.has(k)) seen.set(k, { idx: new Set(), dead: true });
        const s = seen.get(k);
        for (const [i, label] of Object.entries(rungs)) {
          s.idx.add(Number(i));
          if (!DEAD.test(String(label).trim())) s.dead = false;
        }
      }
    }
    const map = new Map();
    const proven = new Set();
    for (const [k, s] of seen) {
      const idx = [...s.idx].sort((a, b) => a - b);
      const lo = idx[0];
      const hi = idx[idx.length - 1];
      if (idx.length >= 2) {
        proven.add(k);
        map.set(k, { value: Math.round((lo + hi) / 2), min: 0, max: hi, isFree: true, available: true });
      } else if (s.dead) {
        map.set(k, { value: lo, min: lo, max: lo, isFree: true, available: true });
      } else {
        map.set(k, { value: lo, min: Math.max(0, lo - 2), max: lo + 2, isFree: true, available: true });
      }
    }
    return { map, proven };
  }

  const CENSUS_CLASSES = ['GT3', 'HYPERCAR', 'LMP2', 'LMP2_ELMS'];
  const maps = Object.fromEntries(CENSUS_CLASSES.map((c) => [c, classMap(c)]));

  // A dead effect inflates "N skipped" on every car: each family a macro names
  // must be proven adjustable (two saved indices) in at least one class.
  const neverMoves = allEffects.filter(
    (e) =>
      !CENSUS_CLASSES.some((c) =>
        [...maps[c].proven].some((k) => macroApi.expandMatch(e.match, [k]).length > 0),
      ),
  );
  check(
    'no macro names a setting no car in the census ever adjusts',
    neverMoves.length === 0,
    [...new Set(neverMoves.map((e) => e.match))].join(', ') || 'all live somewhere',
  );

  for (const cls of CENSUS_CLASSES) {
    const { map } = maps[cls];
    const noise = noisySkips(map, cls);
    check(`${cls} (census): every skip is meaningful`, noise.length === 0, noise.slice(0, 6).join(', ') || 'none');
    const still = balanceStillAtOneClick(map, cls);
    check(`${cls} (census): every balance slider moves a setting at ±1 click`, still.length === 0, still.join(', ') || 'all move');
    check(`${cls} (census): no bar or third spring moves onto index 0`, floorRespected(map));
  }

  // The directions the balance sliders actually push, spelled out on a GT3:
  // right = more rotation means rearward bias, a softer front bar, less TC,
  // less rear wing — the four levers a driver would name.
  const gt3 = maps.GT3.map;
  const moveOf = (id, key) => {
    const ch = macroApi
      .resolveMacro(macroApi.MACROS.find((m) => m.id === id), 1, gt3, 'GT3')
      .changes.find((c) => c.key === key);
    return ch ? Math.sign(ch.to - ch.from) : 0;
  };
  check('slow entry +1 moves the bias rearward (index up)', moveOf('slow-entry', 'VM_BRAKE_BALANCE') === 1);
  check('slow mid +1 softens the front bar (index down)', moveOf('slow-mid', 'VM_FRONT_ANTISWAY') === -1);
  check('slow exit +1 takes TC away (index down)', moveOf('slow-exit', 'VM_TRACTIONCONTROLMAP') === -1);
  check('fast +1 trims the rear wing (index down)', moveOf('fast', 'VM_REAR_WING') === -1);
  const lmp2 = maps.LMP2.map;
  const coast = macroApi
    .resolveMacro(macroApi.MACROS.find((m) => m.id === 'slow-entry'), 1, lmp2, 'LMP2')
    .changes.find((c) => c.key === 'VM_DIFF_COAST');
  check('LMP2 slow entry +1 frees the coast ramp (less lock = index down)', !!coast && coast.to < coast.from);

  /* ---- probe ladders override the table ------------------------------------ */

  const ladderFiles = fs.readdirSync(fixtureDir).filter((f) => /^ladders-[a-z0-9-]+\.json$/.test(f));
  const ladderDocs = ladderFiles.map((f) => JSON.parse(fs.readFileSync(path.join(fixtureDir, f), 'utf8')));
  const ladderReport = dirsApi.applyLadders(ladderDocs);
  const ladderAgainst = ladderReport.filter((r) => r.verdict !== 'agree');
  check(
    'probe ladders agree with the table (a FAIL names the entry to flip)',
    ladderAgainst.length === 0,
    ladderFiles.length
      ? ladderAgainst.map((r) => `${r.cls} ${r.key}: ${r.verdict}`).join(' | ') || `${ladderReport.length} keys in ${ladderFiles.join(', ')}`
      : 'no ladders-*.json yet — run probe-setup-ladders.js in the garage',
  );
  dirsApi.clearLadders();

  // Synthetic: a class whose brake ladder runs FORWARD as the index rises.
  const report = dirsApi.applyLadders([
    {
      class: 'testclass',
      keys: { VM_BRAKE_BALANCE: { min: 0, max: 2, labels: ['45.0:55.0', '50.0:50.0', '55.0:45.0'] } },
    },
  ]);
  check(
    'a contradicting ladder is reported',
    report.length === 1 && report[0].verdict === 'disagree' && report[0].observed === -1,
  );
  check('…and overrides the table for that class only', dirsApi.signFor('VM_BRAKE_BALANCE', 'TESTCLASS') === -1 && dirsApi.signFor('VM_BRAKE_BALANCE', 'GT3') === 1);
  const entry = macroApi.MACROS.find((m) => m.id === 'slow-entry');
  const mid = new Map([['VM_BRAKE_BALANCE', { value: 10, min: 0, max: 20, isFree: true, available: true }]]);
  const onTest = macroApi.resolveMacro(entry, 1, mid, 'TESTCLASS').changes[0];
  const onGt3 = macroApi.resolveMacro(entry, 1, mid, 'GT3').changes[0];
  check('…so the macro moves that class the other way', onTest && onGt3 && onTest.to === 9 && onGt3.to === 11);
  dirsApi.clearLadders();
  check('clearing ladders restores the table', dirsApi.signFor('VM_BRAKE_BALANCE', 'TESTCLASS') === 1);

  /* ---- the runtime self-check -------------------------------------------- */

  check('a rearward bias step agrees', dirsApi.observe('VM_BRAKE_BALANCE', 17, '52.3:47.7', 18, '51.9:48.1').verdict === 'agree');
  const flipped = dirsApi.observe('VM_BRAKE_BALANCE', 17, '52.3:47.7', 18, '52.8:47.2');
  check('a forward bias step on a higher index disagrees', flipped.verdict === 'disagree' && flipped.observed === -1);
  check('bare damper clicks prove nothing either way', dirsApi.observe('WM_SLOWBUMP-W_FL', 10, 'B31', 11, 'B30').verdict === 'unknown');
  check('a ramp diff locks as its angle falls', dirsApi.observe('VM_DIFF_POWER', 0, 'FF6-60 deg', 1, 'FF6-55 deg').verdict === 'agree');
  check('mixed units still compare (cm vs in)', dirsApi.observe('WM_RIDEHEIGHT-W_FL', 14, '1.929 in', 15, '5.0 cm').verdict === 'agree');
  const flippedRun = macroApi.resolveMacro(entry, 1, mid, 'GT3', { flips: { VM_BRAKE_BALANCE: -1 } }).changes[0];
  check('a remembered per-car flip reverses the macro on that car', !!flippedRun && flippedRun.to === 9);
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

/* ---- installing into the sim's own custom setups ---------------------------
 *
 * The path a shared setup takes now: a file dropped into
 * `Settings/<trackFolder>/`, never a write onto the car. Two things have to
 * hold or the feature is worse than what it replaced — it must not overwrite a
 * setup the driver already had under that name, and it must refuse rather than
 * guess when it does not know the track.
 */
{
  const { SetupLibrary } = require('../dist/telemetry/setupLibrary.js');
  const os = require('node:os');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-setuplib-'));
  const settingsDir = path.join(root, 'Settings');
  fs.mkdirSync(settingsDir, { recursive: true });
  const stubController = { refreshSetupFiles: async () => ({ ok: true }) };
  const lib = new SetupLibrary(path.join(root, 'lib'), stubController, settingsDir);
  const svm = ['[GENERAL]', 'VehicleClassSetting=GT3 Test_Car_LMGT3 WEC2025', ''].join(String.fromCharCode(10));

  const first = lib.writeIntoSim(svm, 'Spa race — low drag', 'Spa');
  check('install writes into Settings/<trackFolder>', first.ok && first.inGameName === 'Spa race — low drag');
  check(
    'the .svm lands where the game looks',
    fs.existsSync(path.join(settingsDir, 'Spa', 'Spa race — low drag.svm')),
  );

  // The driver's own file of the same name is the exact thing this must not eat.
  const second = lib.writeIntoSim('DIFFERENT', 'Spa race — low drag', 'Spa');
  check(
    'a name collision suffixes instead of overwriting',
    second.ok && second.inGameName === 'Spa race — low drag (2)',
  );
  check(
    'the original file survives a collision',
    fs.readFileSync(path.join(settingsDir, 'Spa', 'Spa race — low drag.svm'), 'utf8') === svm,
  );

  const noFolder = lib.writeIntoSim(svm, 'Nowhere', '');
  check('install refuses without a track folder', !noFolder.ok, noFolder.error);

  const noSim = new SetupLibrary(path.join(root, 'lib2'), stubController, null);
  const missing = noSim.writeIntoSim(svm, 'Nowhere', 'Spa');
  check('install refuses with no LMU install', !missing.ok, missing.error);

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll setup checks passed.' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
