/**
 * scripts/test-setup-history.js — the Setups tab's History, headless.
 * -----------------------------------------------------------------------------
 * Pins down both halves against the live GT3 garage capture
 * (scripts/fixtures/garage-gt3.json):
 *
 *   1. the pure core (electron/control-panel/setup-history-core.js) — snapshots
 *      leave out fuel / virtual energy / the pit-stop plan, diffs, the cap,
 *      the one-line summary, day grouping, and the restore plan skipping
 *      locked, missing and out-of-range keys rather than clamping them
 *   2. the recorder + store (electron/setupHistory.js) on fake timers — the
 *      session baseline, editor writes folded into one version after the quiet
 *      window, net-zero windows leaving nothing, garage-screen edits recorded
 *      as 'game', our own in-flight writes NOT mistaken for the game, Apply
 *      batches recorded at once with their label, the cap, persistence across
 *      a restart, atomic writes, and a corrupt file surviving as .bak
 *
 * Run: node scripts/test-setup-history.js   (needs a built dist/ for projection)
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../electron/control-panel/setup-history-core.js');
const { SetupHistory } = require('../electron/setupHistory.js');
const { projectSetupState } = require('../dist/telemetry/setupState.js');

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  if (ok) passes += 1;
  else failures += 1;
}

const GARAGE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'garage-gt3.json'), 'utf8'),
);
const clone = (o) => JSON.parse(JSON.stringify(o));

/** The raw payload with some keys moved: `{ KEY: [value, stringValue] }`. */
function garageWith(changes, base = GARAGE) {
  const g = clone(base);
  for (const [k, [v, str]] of Object.entries(changes || {})) {
    g[k].value = v;
    g[k].stringValue = str === undefined ? `step ${v}` : str;
  }
  return g;
}

/** What `setup:state` returns for that payload, at a car + track. */
function stateOf(raw, where = {}) {
  const s = projectSetupState(raw, where.car || 'Ferrari 296 LMGT3', 'GT3');
  return {
    ...s,
    carModel: where.car || 'Ferrari 296 LMGT3',
    trackFolder: where.trackFolder || 'Spa',
    trackName: where.trackName || 'Circuit de Spa-Francorchamps',
  };
}

/* ---- a fake clock: setTimer queues, advance() fires what is due ---------- */
function fakeClock(start = Date.UTC(2026, 9, 16, 13, 0, 0)) {
  let now = start;
  let timers = [];
  let seq = 0;
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { id: ++seq, at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      timers = timers.filter((x) => x !== t);
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
    },
    pending: () => timers.length,
  };
}

const quietLog = { warn: () => {}, log: () => {}, error: () => {} };

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `apex-sethist-${name}-`));
  return d;
}

function makeHistory(dir, clock, extra = {}) {
  return new SetupHistory({
    dir,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: quietLog,
    ...extra,
  });
}

(async () => {
  /* ====================================================================== */
  console.log('\n1. Core — snapshots leave strategy out');
  {
    const snap = core.snapshotFromGarage(GARAGE);
    const keys = Object.keys(snap.values);
    for (const k of ['VM_FUEL_LEVEL', 'VM_VIRTUAL_ENERGY', 'VM_NUM_PITSTOPS', 'VM_PITSTOP_1', 'VM_PITSTOP_2', 'VM_PITSTOP_3']) {
      check(`${k} is not in a snapshot`, !keys.includes(k));
    }
    check('setup keys are (rear wing, camber FL, brake bias)', ['VM_REAR_WING', 'WM_CAMBER-W_FL', 'VM_BRAKE_BALANCE'].every((k) => keys.includes(k)));
    check('the sim wording rides along', snap.strings.VM_REAR_WING === 'P5', snap.strings.VM_REAR_WING);
    check('symmetric / gearGraph are not settings', !keys.includes('symmetric') && !keys.includes('gearGraph'));
    check('keys the car lacks (available:false) are left out', !keys.includes('VM_GEAR_9'));

    const fromState = core.snapshotFromSettings(stateOf(GARAGE).settings);
    check('state and raw payload give the same snapshot', core.sameSnapshot(snap, fromState));

    const refuelled = core.snapshotFromGarage(garageWith({ VM_FUEL_LEVEL: [20, '25.0L'], VM_PITSTOP_1: [3] }));
    check('refuelling and re-planning stops is no diff at all', core.diffSnapshots(snap, refuelled).length === 0);

    // Even a snapshot that somehow carried a fuel key never diffs on it.
    const a = { values: { VM_FUEL_LEVEL: 1, VM_REAR_WING: 4 }, strings: {} };
    const b = { values: { VM_FUEL_LEVEL: 9, VM_REAR_WING: 5 }, strings: { VM_REAR_WING: 'P6' } };
    const d = core.diffSnapshots(a, b);
    check('diff ignores excluded keys even when present', d.length === 1 && d[0].key === 'VM_REAR_WING', JSON.stringify(d));
    check('diff carries from/to and the wording', d[0].from === 4 && d[0].to === 5 && d[0].toStr === 'P6');
  }

  console.log('\n2. Core — summary, cap, grouping, file validation');
  {
    const changes = [
      { key: 'VM_REAR_WING', from: 4, to: 5, fromStr: 'P5', toStr: 'P6' },
      { key: 'VM_FRONT_ANTISWAY', from: 15, to: 14, fromStr: 'D36 H-H', toStr: 'D36 H-S' },
      { key: 'WM_CAMBER-W_FL', from: 11, to: 10, fromStr: '-1.5 deg', toStr: '-1.6 deg' },
      { key: 'WM_CAMBER-W_FR', from: 11, to: 10, fromStr: '', toStr: '' },
    ];
    const line = core.summarise(changes, (k) => k.replace(/^VM_|^WM_/, ''), 2);
    check('summary names the count, the first changes, and the rest', line === '4 changes: REAR_WING P5 → P6, FRONT_ANTISWAY D36 H-H → D36 H-S, +2 more', line);
    check('summary falls back to the index without wording', core.summarise([changes[3]]).includes('11 → 10'));
    check('an empty diff says so', core.summarise([]) === 'No changes');

    const many = Array.from({ length: 130 }, (_, i) => ({ id: String(i), at: i }));
    const capped = core.capEntries(many, 100);
    check('cap keeps the newest 100', capped.length === 100 && capped[0].id === '30' && capped[99].id === '129');

    const now = new Date(2026, 9, 16, 15, 0).getTime();
    const groups = core.groupByDay(
      [
        { id: 'a', at: new Date(2026, 9, 16, 14, 0).getTime() },
        { id: 'b', at: new Date(2026, 9, 16, 9, 0).getTime() },
        { id: 'c', at: new Date(2026, 9, 15, 22, 0).getTime() },
        { id: 'd', at: new Date(2026, 9, 2, 22, 0).getTime() },
      ],
      now,
    );
    check('grouped Today / Yesterday / date', groups.length === 3 && groups[0].label === 'Today' && groups[0].entries.length === 2 && groups[1].label === 'Yesterday');

    check('a non-history file is rejected', core.validateFile({ hello: 1 }) === null && core.validateFile(null) === null);
    const v = core.validateFile({ v: 1, car: 'X', trackFolder: 'Spa', entries: [{ id: 'x', at: 2, source: 'nope', values: {} }, { junk: true }, { id: 'y', at: 1, source: 'editor', values: {} }] });
    check('bad rows dropped, good rows kept oldest-first, unknown source read as game', v && v.entries.length === 2 && v.entries[0].id === 'y' && v.entries[1].source === 'game');
    check('keyId needs both car and track', core.keyId('Car', 'Spa') === 'Car|Spa' && core.keyId('', 'Spa') === '' && core.keyId('Car', '') === '');
  }

  console.log('\n3. Core — the restore plan skips, never clamps');
  {
    const current = new Map(stateOf(GARAGE).settings.map((s) => [s.key, { ...s }]));
    current.get('VM_FRONT_ANTISWAY').isFree = false; // ruleset-locked on this car
    current.delete('VM_TORQUE_SPLIT'); // a key this car does not have
    const target = {
      VM_REAR_WING: 6, // free, differs → write
      'WM_CAMBER-W_FL': current.get('WM_CAMBER-W_FL').value, // same → unchanged
      VM_FRONT_ANTISWAY: 3, // locked → skipped
      VM_TORQUE_SPLIT: 1, // missing → skipped
      VM_BRAKE_DUCTS: 99, // out of range → skipped, not clamped
      VM_FUEL_LEVEL: 3, // strategy → ignored entirely
    };
    const plan = core.restorePlan(target, current);
    check('writes only the free, differing key', plan.writes.length === 1 && plan.writes[0].key === 'VM_REAR_WING' && plan.writes[0].value === 6, JSON.stringify(plan.writes));
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.key, s.reason]));
    check('locked key skipped with a reason', reasons.VM_FRONT_ANTISWAY === 'fixed by ruleset');
    check('missing key skipped with a reason', reasons.VM_TORQUE_SPLIT === 'not on this car');
    check('out-of-range key skipped, not clamped', reasons.VM_BRAKE_DUCTS === 'out of range on this car');
    check('fuel never enters a restore', !plan.writes.some((w) => w.key === 'VM_FUEL_LEVEL') && !reasons.VM_FUEL_LEVEL);
    check('unchanged keys counted', plan.unchanged === 1);
    check('a plain object works as the current setup too', core.restorePlan({ VM_REAR_WING: 6 }, Object.fromEntries(current)).writes.length === 1);
  }

  /* ====================================================================== */
  console.log('\n4. Recorder — baseline, editor coalescing, net-zero');
  {
    const dir = tmpDir('rec');
    const clock = fakeClock();
    const h = makeHistory(dir, clock);
    const id = h.observeState(stateOf(GARAGE));
    await h.idle();
    check('observeState returns the car + track key', id === 'Ferrari 296 LMGT3|Spa', id);
    let list = await h.list();
    check('first sight records a Session start baseline', list.entries.length === 1 && list.entries[0].source === 'session' && list.entries[0].changes.length === 0);
    check('…which is marked as what is on the car', list.entries[0].isCurrent === true);

    h.observeState(stateOf(GARAGE));
    await h.idle();
    check('an unchanged poll records nothing', (await h.list()).entries.length === 1);

    // Three slider writes on two keys, the way the editor sends them.
    h.expectWrites(['VM_REAR_WING']);
    await h.noteWrite({ key: 'VM_REAR_WING', value: 5, str: 'P6' });
    clock.advance(2000);
    h.expectWrites(['VM_REAR_WING']);
    await h.noteWrite({ key: 'VM_REAR_WING', value: 6, str: 'P7' });
    h.expectWrites(['WM_CAMBER-W_FL']);
    await h.noteWrite({ key: 'WM_CAMBER-W_FL', value: 10, str: '-1.6 deg' });
    list = await h.list();
    check('nothing recorded inside the quiet window', list.entries.length === 1);
    check('…but the panel is told a version is pending', list.pending && list.pending.source === 'editor' && list.pending.count === 2, JSON.stringify(list.pending));
    clock.advance(9000);
    await h.idle();
    check('still nothing 9 s after the last write', (await h.list()).entries.length === 1);
    clock.advance(1500);
    await h.idle();
    list = await h.list();
    check('one editor version after 10 s quiet', list.entries.length === 2 && list.entries[0].source === 'editor');
    const ch = list.entries[0].changes;
    check('…holding the NET change of both keys', ch.length === 2 && ch.find((c) => c.key === 'VM_REAR_WING').from === 4 && ch.find((c) => c.key === 'VM_REAR_WING').to === 6, JSON.stringify(ch));
    check('…in the sim wording', ch.find((c) => c.key === 'VM_REAR_WING').toStr === 'P7');

    // Up one and back down: nothing happened.
    h.expectWrites(['VM_REAR_WING']);
    await h.noteWrite({ key: 'VM_REAR_WING', value: 7, str: 'P8' });
    await h.noteWrite({ key: 'VM_REAR_WING', value: 6, str: 'P7' });
    clock.advance(11000);
    await h.idle();
    check('a window that nets out to zero records nothing', (await h.list()).entries.length === 2);
  }

  console.log('\n5. Recorder — changes made in LMU’s garage, and our own writes in flight');
  {
    const dir = tmpDir('game');
    const clock = fakeClock();
    let resolved = 0;
    const h = makeHistory(dir, clock, {
      resolveKey: async () => {
        resolved++;
        return { car: 'Ferrari 296 LMGT3', trackFolder: 'Spa', trackName: 'Spa' };
      },
    });
    // The provider's poll alone (Setups tab shut): it has to ask where we are.
    h.observeGarage(GARAGE);
    await h.idle();
    check('a garage poll with no context resolves car + track once', resolved === 1);
    check('…and records the baseline', (await h.list()).entries.length === 1);

    h.observeGarage(GARAGE);
    await h.idle();
    check('an unchanged poll asks nothing and records nothing', resolved === 1 && (await h.list()).entries.length === 1);

    // Refuelling in the garage is not a setup change.
    h.observeGarage(garageWith({ VM_FUEL_LEVEL: [30, '35.0L'], VM_VIRTUAL_ENERGY: [10] }));
    await h.idle();
    clock.advance(11000);
    await h.idle();
    check('a refuel in the garage records nothing', (await h.list()).entries.length === 1);

    // Two clicks in the garage screen, three seconds apart.
    h.observeGarage(garageWith({ VM_REAR_WING: [5, 'P6'] }));
    await h.idle();
    clock.advance(3000);
    h.observeGarage(garageWith({ VM_REAR_WING: [6, 'P7'] }));
    await h.idle();
    clock.advance(10500);
    await h.idle();
    let list = await h.list();
    check('garage-screen clicks fold into one "game" version', list.entries.length === 2 && list.entries[0].source === 'game' && list.entries[0].changes.length === 1 && list.entries[0].changes[0].to === 6, JSON.stringify(list.entries[0]));

    // Our own write, with a poll that was already in flight returning the old value.
    const afterGame = garageWith({ VM_REAR_WING: [6, 'P7'] });
    h.expectWrites(['WM_CAMBER-W_FL']);
    h.observeGarage(afterGame); // stale: camber still at 11
    await h.noteWrite({ key: 'WM_CAMBER-W_FL', value: 10, str: '-1.6 deg' });
    h.observeGarage(afterGame); // still stale, still inside the guard
    await h.idle();
    clock.advance(10500);
    await h.idle();
    list = await h.list();
    check('our write is "editor", not undone by a stale poll', list.entries.length === 3 && list.entries[0].source === 'editor', list.entries.map((e) => e.source).join(','));
    check('…and no phantom "game" version appeared', !list.entries.slice(0, 1).some((e) => e.source === 'game'));
    const live = garageWith({ VM_REAR_WING: [6, 'P7'], 'WM_CAMBER-W_FL': [10, '-1.6 deg'] });
    h.observeGarage(live);
    clock.advance(11000);
    await h.idle();
    check('the poll catching up with our write records nothing', (await h.list()).entries.length === 3);

    // An editor window open when the garage screen changes something else.
    h.expectWrites(['VM_FRONT_WING']);
    await h.noteWrite({ key: 'VM_FRONT_WING', value: 2, str: 'P3' });
    h.observeGarage(garageWith({ VM_REAR_WING: [6, 'P7'], 'WM_CAMBER-W_FL': [10, '-1.6 deg'], VM_FRONT_WING: [2, 'P3'], VM_BRAKE_DUCTS: [2, 'step 2'] }));
    await h.idle();
    list = await h.list();
    check('a game change closes the open editor window first', list.entries[0].source === 'editor' && list.entries[0].changes.some((c) => c.key === 'VM_FRONT_WING'));
    clock.advance(11000);
    await h.idle();
    list = await h.list();
    check('…then records itself as "game"', list.entries[0].source === 'game' && list.entries[0].changes.length === 1 && list.entries[0].changes[0].key === 'VM_BRAKE_DUCTS');

    // A different car shows up in the poll.
    resolved = 0;
    const other = clone(GARAGE);
    delete other.VM_TORQUE_SPLIT; // a different key set
    h.observeGarage(other);
    h.resolveKey = async () => {
      resolved++;
      return { car: 'BMW M4 LMGT3', trackFolder: 'Spa' };
    };
    h.observeGarage(other);
    await h.idle();
    list = await h.list();
    check('a car change starts that car’s own history', list.key && list.key.car === 'BMW M4 LMGT3' && list.entries.length === 1 && list.entries[0].source === 'session');
    check('…and both histories are listed', list.keys.length === 2);
    const ferrari = await h.list('Ferrari 296 LMGT3|Spa');
    check('the other history is still browsable', ferrari.key.car === 'Ferrari 296 LMGT3' && ferrari.entries.length >= 5);
  }

  console.log('\n6. Recorder — Apply batches, labels, restore, the cap');
  {
    const dir = tmpDir('batch');
    const clock = fakeClock();
    const h = makeHistory(dir, clock, { cap: 6 });
    h.observeState(stateOf(GARAGE));
    await h.idle();
    // Editor window open, then an Apply: the window closes first.
    await h.noteWrite({ key: 'VM_FRONT_WING', value: 3, str: 'P4' });
    h.expectWrites(['VM_REAR_WING', 'VM_BRAKE_DUCTS']);
    const e = await h.noteBatch({ source: 'engineer', label: 'More front turn-in +2' }, [
      { key: 'VM_REAR_WING', value: 2, str: 'P3' },
      { key: 'VM_BRAKE_DUCTS', value: 1, str: 'step 1' },
    ]);
    let list = await h.list();
    check('an Apply is recorded at once', e && list.entries[0].source === 'engineer' && list.entries[0].label === 'More front turn-in +2');
    check('…after the open editor window was closed', list.entries[1].source === 'editor' && list.entries.length === 3);

    await h.noteBatch({ source: 'restore', label: 'Restored to 14:32' }, [{ key: 'VM_REAR_WING', value: 4, str: 'P5' }]);
    list = await h.list();
    check('a restore is a version of its own', list.entries[0].source === 'restore' && list.entries[0].label === 'Restored to 14:32');
    await h.noteBatch({ source: 'hacker', label: 'x'.repeat(500) }, [{ key: 'VM_REAR_WING', value: 5 }]);
    list = await h.list();
    check('an unknown source is read as engineer, a long label trimmed', list.entries[0].source === 'engineer' && list.entries[0].label.length === 80);
    const before = (await h.list()).entries.length;
    await h.noteBatch({ source: 'library' }, [{ key: 'VM_REAR_WING', value: 5 }]);
    check('an Apply that changed nothing records nothing', (await h.list()).entries.length === before);

    for (let i = 0; i < 6; i++) {
      await h.noteBatch({ source: 'engineer' }, [{ key: 'VM_REAR_WING', value: i % 2 ? 1 : 2 }]);
    }
    list = await h.list();
    check('the cap holds (6 here, 100 in the app)', list.entries.length === 6 && list.key.count === 6, String(list.entries.length));
    check('…oldest dropped first', !list.entries.some((x) => x.source === 'session'));

    const full = await h.entry(list.key.id, list.entries[1].id);
    check('entry() returns the full snapshot', full && full.values && full.values.VM_REAR_WING !== undefined && full.strings && Object.keys(full.values).length > 100);
    check('…with no fuel or pit-stop keys in it', !('VM_FUEL_LEVEL' in full.values) && !('VM_PITSTOP_1' in full.values));
    check('entry() refuses an unknown id', (await h.entry(list.key.id, 'nope')) === null && (await h.entry('', 'x')) === null);
  }

  console.log('\n7. Store — persistence, atomic writes, corrupt files, clear, quit');
  {
    const dir = tmpDir('store');
    const clock = fakeClock();
    let h = makeHistory(dir, clock);
    h.observeState(stateOf(GARAGE));
    await h.idle();
    await h.noteBatch({ source: 'engineer' }, [{ key: 'VM_REAR_WING', value: 6, str: 'P7' }]);
    await h.idle();
    const files = fs.readdirSync(dir);
    check('a history file and an index on disk', files.includes('index.json') && files.some((f) => /^Ferrari-296-LMGT3__Spa-[0-9a-f]{8}\.json$/.test(f)), files.join(','));
    check('no temp files left behind', !files.some((f) => f.endsWith('.tmp')));
    const file = path.join(dir, files.find((f) => f.startsWith('Ferrari')));
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('the file is a valid v1 history', onDisk.v === 1 && onDisk.entries.length === 2 && onDisk.car === 'Ferrari 296 LMGT3');

    // A restart: the same car, unchanged, is no new baseline…
    h = makeHistory(dir, clock);
    h.observeState(stateOf(garageWith({ VM_REAR_WING: [6, 'P7'] })));
    await h.idle();
    let list = await h.list();
    check('history survives a restart', list.entries.length === 2);
    check('an unchanged car after a restart records no new baseline', list.entries[0].source === 'engineer');
    // …but one changed while the app was shut is.
    h = makeHistory(dir, clock);
    h.observeState(stateOf(garageWith({ VM_REAR_WING: [6, 'P7'], VM_FRONT_WING: [1, 'P2'] })));
    await h.idle();
    list = await h.list();
    check('a car changed while the app was shut gets a Session start with the diff', list.entries.length === 3 && list.entries[0].source === 'session' && list.entries[0].changes.length === 1 && list.entries[0].changes[0].key === 'VM_FRONT_WING');

    // Atomic: a rename that always fails leaves the previous file intact.
    const good = fs.readFileSync(file, 'utf8');
    const failingFsp = {
      ...require('node:fs/promises'),
      rename: async () => {
        const err = new Error('EPERM: simulated');
        err.code = 'EPERM';
        throw err;
      },
    };
    const hf = makeHistory(dir, clock, { fsp: failingFsp });
    hf.observeState(stateOf(garageWith({ VM_REAR_WING: [6, 'P7'], VM_FRONT_WING: [1, 'P2'] })));
    await hf.idle();
    await hf.noteBatch({ source: 'engineer' }, [{ key: 'VM_REAR_WING', value: 1, str: 'P2' }]);
    await hf.idle();
    check('a failed write never truncates the real file', fs.readFileSync(file, 'utf8') === good);
    check('…and cleans up its temp file', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));

    // Corrupt: garbage in the file must not crash; start fresh, keep a .bak.
    fs.writeFileSync(file, '{"v":1,"entries":[{"id":"x", TRUNCATED');
    h = makeHistory(dir, clock);
    let threw = null;
    try {
      h.observeState(stateOf(GARAGE));
      await h.idle();
      list = await h.list();
    } catch (err) {
      threw = err;
    }
    check('a corrupt history file does not throw', threw === null, threw && threw.message);
    check('…the history starts again from a fresh baseline', list && list.entries.length === 1 && list.entries[0].source === 'session');
    check('…and the bad file is kept as .bak', fs.existsSync(`${file}.bak`) && fs.readFileSync(`${file}.bak`, 'utf8').includes('TRUNCATED'));
    check('…and the new file is valid again', JSON.parse(fs.readFileSync(file, 'utf8')).entries.length === 1);

    // A corrupt index is rebuilt from the history files.
    fs.writeFileSync(path.join(dir, 'index.json'), 'not json');
    h = makeHistory(dir, clock);
    list = await h.list();
    check('a corrupt index is rebuilt from the files', list.keys.length === 1 && list.key && list.key.car === 'Ferrari 296 LMGT3', JSON.stringify(list.keys));
    check('…and kept as .bak too', fs.existsSync(path.join(dir, 'index.json.bak')));

    // Clear: the file goes, and the next sighting starts history again.
    h.observeState(stateOf(GARAGE));
    await h.idle();
    const res = await h.clear('Ferrari 296 LMGT3|Spa');
    check('clear() succeeds', res && res.ok === true);
    check('…removes the file', !fs.existsSync(file));
    h.observeState(stateOf(GARAGE));
    await h.idle();
    list = await h.list();
    check('…and the next sighting records a fresh baseline', list.entries.length === 1 && list.entries[0].source === 'session');
    check('clear() validates its key', (await h.clear('')).ok === false);

    // Quit inside an open window: shutdown() folds it and writes it, synchronously.
    await h.noteWrite({ key: 'VM_REAR_WING', value: 8, str: 'P9' });
    h.shutdown();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('quit folds the open editor window into a version on disk', after.entries.length === 2 && after.entries[1].source === 'editor');
    h.observeGarage(garageWith({ VM_REAR_WING: [1] }));
    check('nothing is recorded after quit', h.ctx === null || h.ctx.pending === null);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
