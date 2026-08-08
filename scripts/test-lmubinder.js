/**
 * scripts/test-lmubinder.js — the plan that decides what gets written into
 * Le Mans Ultimate's own controls file.
 * -----------------------------------------------------------------------------
 * This is the one part of the overlay that edits somebody else's config, so the
 * planning rules are worth pinning down. Two of them are safety properties:
 *
 *   never touch what the driver has already bound — re-running must be a
 *   complete no-op, because an earlier version of this walked a binding down
 *   the keyboard on every run (F10 → F11 → F9) and quietly stole Quick Chat #9;
 *
 *   never hand out a key that is already in the file, even one from our own
 *   pool, because "nobody can press a Japanese key" is a very good reason to
 *   expect it to be free and not a guarantee that it is.
 *
 * The pool itself is the product decision: scancodes Windows maps to no virtual
 * key at all, so no driver can already be using them and no global hotkey in OBS
 * or Discord can be listening. Every one was verified against the running game —
 * bound to a real LMU function, pressed with SendInput, and the car's own aid
 * value watched in shared memory.
 *
 * F16-F24 are excluded even though they were tested and worked perfectly:
 * DirectInput's names stop at F15 but the scancodes do not, and F13-F24 is
 * exactly what a Stream Deck emits for "a key no game uses".
 *
 * Run: node scripts/test-lmubinder.js
 */

'use strict';

const {
  ABNT_SCANCODES,
  FKEY_SCANCODES,
  KEY_POOL,
  WANTED,
  planLmuBindings,
} = require('../dist/server/lmuBinder');

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

/** A stand-in for LMU's resolved bind set: `{ "<function>": {dik} }`. */
function binds(all) {
  const out = {};
  for (const [fn, dik] of Object.entries(all)) out[fn] = { scancode: dik & 0x7f, extended: dik >= 0x80, dik };
  return { path: 'C:\\fake\\keyboard.json', keyboardSchemeActive: true, aids: [], pit: {}, all: out };
}

const rowFor = (plan, fn) => plan.rows.find((r) => r.fn === fn);

console.log('\n1) The pool is keys nobody can press');

{
  check('every pooled key is below 0x80', KEY_POOL.every((k) => k.dik < 0x80),
    KEY_POOL.map((k) => k.dik).join());
  // Above 0x80 the codes resolve to E0-prefixed scancodes — the media keys —
  // so binding one would mute the driver's music every time we changed a bias.
  check('…so none of them can resolve to a media key', KEY_POOL.every((k) => (k.dik & 0x80) === 0));
  // The fifteen original keys were each pressed into the running game and moved
  // a real value. The reserve added with the prototype aids has had only the
  // offline half of that check (Windows resolves it to no usable key), so the
  // rule is no longer "all proven" but "proven FIRST": a rig spends every
  // verified key before it can reach an unverified one, and most never do.
  const provenCount = KEY_POOL.filter((k) => k.proven).length;
  check('the verified keys still cover the original wish list', provenCount >= 13,
    provenCount + ' verified of ' + KEY_POOL.length);
  const firstUnproven = KEY_POOL.findIndex((k) => !k.proven);
  check('no verified key sits behind an unverified one',
    firstUnproven === -1 || KEY_POOL.slice(firstUnproven).every((k) => !k.proven),
    'first unverified at index ' + firstUnproven);
  // 115 and 126 look like the rest of the unmapped range and are not: Windows
  // resolves them to VK_ABNT_C1/C2, two real keys on a Brazilian ABNT2 board.
  check('no ABNT keyboard key is in the pool',
    !KEY_POOL.some((k) => ABNT_SCANCODES.includes(k.dik)), ABNT_SCANCODES.join());
  // F16-F24 work perfectly and are still disqualified: a Stream Deck emits them.
  check('no F-key scancode is in the pool',
    !KEY_POOL.some((k) => FKEY_SCANCODES.includes(k.dik)), KEY_POOL.map((k) => k.dik).join());
  check('the pool covers every function on a bare rig', KEY_POOL.length >= WANTED.length,
    KEY_POOL.length + ' keys for ' + WANTED.length + ' functions');
  check('no key appears twice', new Set(KEY_POOL.map((k) => k.dik)).size === KEY_POOL.length);
}

console.log('\n2) A binding the driver already has is never touched');

{
  // Pit Request on F10 is exactly what the older binder produced; a second run
  // must leave it alone rather than move it along.
  const plan = planLmuBindings(binds({ 'Pit Request': 68 }));
  const pit = rowFor(plan, 'Pit Request');
  check('an already-bound function is reported, not rebound', pit.status === 'already-bound', pit.status);
  check('…and keeps the key it had', pit.currentDik === 68, pit.currentDik);
  check('…and is not counted as work to do', !plan.rows.some((r) => r.fn === 'Pit Request' && r.proposedDik));

  const all = {};
  for (const w of WANTED) all[w.fn] = 60 + WANTED.indexOf(w);
  const nothing = planLmuBindings(binds(all));
  check('a fully-bound rig is a complete no-op', nothing.toBind === 0, nothing.toBind);
}

console.log('\n3) A key already in the file is never handed out again');

{
  // The driver has somehow bound a pooled key themselves (an actual Japanese
  // keyboard, a remapper, a previous run of something else).
  const taken = KEY_POOL[0].dik;
  const plan = planLmuBindings(binds({ Headlights: taken }));
  const used = plan.rows.map((r) => r.proposedDik).filter((d) => d != null);
  check('the taken key is not offered to anything', !used.includes(taken), `${taken} vs ${used.join()}`);
  check('…and the rest of the pool still gets used', used.length > 0, used.join());
  check('no two functions are given the same key', new Set(used).size === used.length, used.join());
}

console.log('\n4) A bare rig gets full coverage');

{
  const plan = planLmuBindings(binds({}));
  const offered = plan.rows.filter((r) => r.status === 'will-bind').length;
  check('a rig with nothing bound gets everything bound', offered === WANTED.length, offered);
  check('…with nothing left uncovered', plan.unbindable === 0, plan.unbindable);
  check('…and no key handed out twice',
    new Set(plan.rows.map((r) => r.proposedDik).filter(Boolean)).size === offered);
  // Pit Request has no REST equivalent anywhere in LMU's API, so it goes first.
  check('the first key goes to Pit Request', rowFor(plan, 'Pit Request').proposedDik === KEY_POOL[0].dik,
    rowFor(plan, 'Pit Request').proposedLabel);
}

console.log('\n5) Every aid we press is a function the binder can bind');

{
  /*
   * Two lists have to agree or a control is dead on arrival: the aid table says
   * which LMU function steps an aid, and WANTED says which functions the binder
   * will find a key for. An aid named in the first and missing from the second
   * can never be bound, so it can never be pressed — which is exactly the state
   * brake migration, both ARBs and regen were in.
   */
  const { readLmuKeybinds } = require('../dist/server/lmuKeybinds');
  const table = readLmuKeybinds(' no-such-file');
  const wanted = new Set(WANTED.map((w) => w.fn));
  const missing = [];
  for (const aid of table.aids) {
    if (!wanted.has(aid.incFunction)) missing.push(aid.incFunction);
    if (!wanted.has(aid.decFunction)) missing.push(aid.decFunction);
  }
  check('every aid direction is on the binder\'s wish list', missing.length === 0,
    missing.length ? 'not bindable: ' + missing.join(', ') : table.aids.length * 2 + ' directions');
}

console.log('\n6) The function names are LMU\'s own');

{
  /*
   * The names are matched by LMU as literal strings, and nothing about them is
   * guessable: the eight prototype-aid functions alone use four different
   * verb schemes — Forward/Rearward, Inc/Dec, Increment/Decrement, Up/Down —
   * and `Inc Front ARB` is the only abbreviated one in the game. A typo binds
   * nothing, presses nothing, and reports no error anywhere: the row simply
   * stays dead, which is indistinguishable from the driver not having bound it.
   *
   * So each name is checked against the game's OWN control-function table,
   * which lives as a run of null-terminated strings inside the executable —
   * the same list LMU compares `keyboard.json`'s keys against.
   *
   * Skipped, not failed, where LMU is not installed: this suite runs on
   * machines that have never seen the game.
   */
  const fs = require('node:fs');
  const { findKeyboardConfig } = require('../dist/server/lmuKeybinds');
  const cfg = findKeyboardConfig();
  const exe = cfg ? require('node:path').join(cfg, '..', '..', '..', 'Le Mans Ultimate.exe') : null;

  if (!exe || !fs.existsSync(exe)) {
    console.log('  SKIP  LMU is not installed here — function names unverified');
  } else {
    const buf = fs.readFileSync(exe);
    // Null-terminated on both sides, so a name cannot pass by being a substring
    // of a longer one ("Traction Control Up" inside "Traction Control Up 2").
    const present = (fn) => buf.indexOf(Buffer.from('\0' + fn + '\0', 'latin1')) >= 0;
    const unknown = WANTED.map((w) => w.fn).filter((fn) => !present(fn));
    check('every function name appears in LMU\'s own control table', unknown.length === 0,
      unknown.length ? 'not a function LMU knows: ' + unknown.join(', ') : WANTED.length + ' names');
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
