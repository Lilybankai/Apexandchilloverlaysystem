/**
 * scripts/test-lmupath.js — finding Le Mans Ultimate on disk, including when
 * the driver has to say where it is.
 * -----------------------------------------------------------------------------
 * The bug this exists for is one of the nastiest kinds: the app looks entirely
 * healthy and exactly two features fail.
 *
 * Apex reaches the game two different ways. Over its loopback REST API come
 * telemetry, the standings, the delta and every live garage slider — that half
 * needs nothing but a port, and works on any install on any drive. Through the
 * FILE SYSTEM go the three things that write: a community setup dropped into
 * the sim's Settings folder, the missing key bindings written into
 * keyboard.json, and the shared-memory plugin dropped into Plugins. That half
 * needs the install's path, which was inferred entirely from Steam's registry
 * keys and its library list.
 *
 * A tester with the game on Z: (2026-09-07) had perfect telemetry, his own
 * garage edits reaching the car, and both write features failing with "LMU
 * install not found" — with nothing in the app to act on and nowhere to say
 * where the game actually was.
 *
 * So: an override, and the properties that make it safe.
 *
 *   the override WINS over every guess, because it is the one fact here that
 *   is not inferred;
 *
 *   a near-miss in the folder picker is walked to the root it implies rather
 *   than rejected — UserData\player in particular, which is the folder the
 *   setup docs name and therefore the one a driver will pick;
 *
 *   a folder that is genuinely not the game is REFUSED, because storing it
 *   would move the failure from "cannot find it" to "found the wrong thing",
 *   which is worse;
 *
 *   clearing it goes back to plain auto-detection, so a driver who picks the
 *   wrong folder is never stuck with it.
 *
 * Run: node scripts/test-lmupath.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  candidateLmuRoots,
  describeLmuPaths,
  findLmuPlayerDir,
  findLmuSettingsDir,
  looksLikeLmuRoot,
  lmuRootOverride,
  normalizeLmuRoot,
} = require('../dist/server/lmuKeybinds');

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

/* A throwaway install tree, shaped exactly like the real one. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-lmupath-'));
const root = path.join(tmp, 'steamapps', 'common', 'Le Mans Ultimate');
const player = path.join(root, 'UserData', 'player');
fs.mkdirSync(player, { recursive: true });
fs.writeFileSync(path.join(root, 'Le Mans Ultimate.exe'), 'MZ');
fs.writeFileSync(path.join(player, 'keyboard.json'), JSON.stringify({ Input: {} }));

/* Nothing in these tests may depend on the developer's own machine. */
const savedRoot = process.env.APEX_LMU_ROOT;
const savedUserData = process.env.APEX_LMU_USERDATA;
delete process.env.APEX_LMU_ROOT;
delete process.env.APEX_LMU_USERDATA;

function withOverride(value, fn) {
  process.env.APEX_LMU_ROOT = value;
  try {
    return fn();
  } finally {
    delete process.env.APEX_LMU_ROOT;
  }
}

console.log('\n1) Recognising an install');
check('the game root is an install', looksLikeLmuRoot(root));
check('a folder with neither marker is not', !looksLikeLmuRoot(tmp), tmp);

console.log('\n2) Every near-miss in the folder picker lands on the root');
check('the root itself', normalizeLmuRoot(root) === root);
check('a trailing separator', normalizeLmuRoot(root + path.sep) === root);
check('UserData/player — the folder the setup docs name', normalizeLmuRoot(player) === root);
check('UserData', normalizeLmuRoot(path.join(root, 'UserData')) === root);
check(
  'a picked FILE, if the dialog was left in file mode',
  normalizeLmuRoot(path.join(player, 'keyboard.json')) === root,
);
check(
  'steamapps/common — the folder ABOVE the game',
  normalizeLmuRoot(path.join(tmp, 'steamapps', 'common')) === root,
);
check(
  'a Steam library root',
  normalizeLmuRoot(tmp) === root,
  'tmp -> steamapps/common/Le Mans Ultimate',
);

console.log('\n3) A folder that is not the game is refused, not stored');
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-notlmu-'));
check('an unrelated folder', normalizeLmuRoot(empty) === null, empty);
check('an empty string', normalizeLmuRoot('') === null);
check('a relative path', normalizeLmuRoot('Le Mans Ultimate') === null);
check('a non-string', normalizeLmuRoot(null) === null);

console.log('\n4) The override wins over every guess');
check('unset means no override', lmuRootOverride() === null);
withOverride(root, () => {
  check('set means that folder', lmuRootOverride() === root);
  check('and it is the FIRST place looked', candidateLmuRoots()[0] === root, candidateLmuRoots()[0]);
  check('the player folder resolves under it', findLmuPlayerDir() === player);
  check(
    'and the setup folder is Settings beside it',
    findLmuSettingsDir() === path.join(player, 'Settings'),
  );
});
check('clearing it goes back to auto-detection', lmuRootOverride() === null);
check(
  '…and the override is no longer the first candidate',
  candidateLmuRoots()[0] !== root,
  candidateLmuRoots()[0],
);

console.log('\n5) A trailing separator is stored harmlessly');
withOverride(root + path.sep, () => {
  check('the stored value is trimmed of it', lmuRootOverride() === root);
  check('so the player folder still resolves', findLmuPlayerDir() === player);
});

console.log('\n6) Settings is NOT required to exist');
/*
 * LMU creates UserData/player/Settings the first time it saves a setup, so a
 * fresh profile legitimately has a player folder and no Settings folder. This
 * used to be existence-checked, which turned that profile into "LMU install
 * not found" and killed the whole setup library — the writer mkdirs the track
 * folder anyway.
 */
withOverride(root, () => {
  check(
    'a profile that has never saved a setup still gets a Settings path',
    !fs.existsSync(path.join(player, 'Settings')) &&
      findLmuSettingsDir() === path.join(player, 'Settings'),
  );
});

console.log('\n7) The report says where we looked and what we found');
withOverride(root, () => {
  const r = describeLmuPaths();
  check('it reports the chosen folder', r.chosen === root);
  check('…as still valid', r.chosenValid === true);
  check('the winning root is the chosen one', r.root === root);
  check('the player folder is named', r.playerDir === player);
  check('the keyboard file is named', r.keyboardPath === path.join(player, 'keyboard.json'));
  check('and the two file features can work', r.found === true);
  /*
   * `found`, not `ok`, and that distinction is the whole point: this report is
   * spread into an IPC envelope whose own `ok` means "the call succeeded". The
   * game being absent is a SUCCESSFUL call with a negative answer, and while
   * the two shared a name the spread clobbered the envelope — so the card
   * reported "could not check the game folder" in precisely the situation it
   * was built for.
   */
  check('the report does not carry an `ok` of its own', !('ok' in r));
  const chosen = r.candidates.filter((c) => c.source === 'chosen');
  check('the chosen folder is labelled as such', chosen.length === 1 && chosen[0].root === root);
  check('…with both markers found', chosen[0].hasExe && chosen[0].hasPlayer);
});
withOverride(empty, () => {
  const r = describeLmuPaths();
  check('a stale chosen folder is reported invalid', r.chosen === empty && r.chosenValid === false);
});

/* ---- cleanup ------------------------------------------------------------- */
if (savedRoot !== undefined) process.env.APEX_LMU_ROOT = savedRoot;
if (savedUserData !== undefined) process.env.APEX_LMU_USERDATA = savedUserData;
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
