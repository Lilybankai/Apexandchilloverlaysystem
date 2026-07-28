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
 * The pool itself is the product decision: keys that exist in DirectInput and
 * on no Western keyboard, so no driver can already be using them and no global
 * hotkey in OBS or Discord can be listening for them. CONVERT, NOCONVERT and
 * YEN were each verified against the running game — bound to a real LMU
 * function, pressed with SendInput, and the car's own aid value moved.
 *
 * Run: node scripts/test-lmubinder.js
 */

'use strict';

const { KEY_POOL, WANTED, planLmuBindings } = require('../dist/server/lmuBinder');

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
  check('the verified keys come first', KEY_POOL.slice(0, 3).every((k) => k.proven),
    KEY_POOL.filter((k) => k.proven).length + ' proven');
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

console.log('\n4) When the pool runs out, it says so rather than inventing keys');

{
  const plan = planLmuBindings(binds({}));
  const offered = plan.rows.filter((r) => r.status === 'will-bind').length;
  check('it binds as many as it has keys for', offered === KEY_POOL.length, offered);
  check('…and reports the rest as uncovered', plan.unbindable === WANTED.length - KEY_POOL.length,
    plan.unbindable);
  check('…rather than reusing a pooled key',
    new Set(plan.rows.map((r) => r.proposedDik).filter(Boolean)).size === KEY_POOL.length);
  // Pit Request has no REST equivalent anywhere in LMU's API, so if only one
  // key is ever claimed it has to be that one.
  check('the first key goes to Pit Request', rowFor(plan, 'Pit Request').proposedDik === KEY_POOL[0].dik,
    rowFor(plan, 'Pit Request').proposedLabel);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
