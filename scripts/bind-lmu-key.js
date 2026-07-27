/**
 * scripts/bind-lmu-key.js — bind an LMU input function to a keyboard key.
 * -----------------------------------------------------------------------------
 * The overlay can press LMU's own binds (see `server/lmuKeybinds.ts`), but only
 * ones bound to a **key**. Several functions worth driving from a Stream Deck or
 * from the MFD widget — `Pit Request` above all — are commonly bound to a wheel
 * button and nothing else, and a wheel button cannot be synthesised. This writes
 * the missing keyboard binding into LMU's own config so the overlay has
 * something to press.
 *
 * ## The one thing that makes this non-trivial
 * **LMU rewrites `keyboard.json` from memory when it exits.** Edit the file with
 * the game running and the edit is silently thrown away the moment the driver
 * quits — the binding appears to work, survives a test, and is gone the next
 * time they launch. So this refuses to write while LMU is running rather than
 * producing a change that unwrites itself. That is the whole reason this is a
 * script with a guard and not a two-line file edit.
 *
 * A timestamped backup is written beside the file before any change, and
 * `--restore` puts the newest one back.
 *
 * Usage — with Le Mans Ultimate CLOSED:
 *   node scripts/bind-lmu-key.js                       # bind Pit Request to a free F-key
 *   node scripts/bind-lmu-key.js --function "Pit Request" --key F10
 *   node scripts/bind-lmu-key.js --list                # show what is bound now
 *   node scripts/bind-lmu-key.js --restore             # undo, from the newest backup
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const has = (flag) => process.argv.includes(flag);

/**
 * DirectInput scancodes for the keys worth offering. LMU stores DIK values, and
 * `dikToScanKey` in server/lmuKeybinds.ts turns them back into something
 * SendInput can press — so a key is only usable here if it survives that trip.
 * The F-keys do, and are the least likely to already be doing something.
 *
 * F16–F24 are deliberately absent: DirectInput's keyboard map stops at F15, so
 * they cannot be sent at all. That was the bug behind an earlier fixed F13–F24
 * keymap in this project, and re-introducing those codes here would recreate it.
 */
const KEYS = {
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66,
  F9: 67, F10: 68, F11: 87, F12: 88, F13: 100, F14: 101, F15: 102,
};

/** Preference order when picking automatically — highest first, least contested. */
const AUTO_ORDER = ['F10', 'F11', 'F9', 'F6', 'F5', 'F4', 'F3', 'F2', 'F1'];

/** Candidate install locations — mirrors candidatePaths() in lmuKeybinds.ts. */
function findKeyboardConfig() {
  const explicit = process.env.APEX_LMU_USERDATA;
  const roots = new Set(['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']);
  for (const root of [...roots]) {
    try {
      const text = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      const re = /"path"\s+"([^"]+)"/g;
      let m;
      while ((m = re.exec(text)) !== null) roots.add(m[1].replace(/\\\\/g, '\\'));
    } catch {
      /* no library file here */
    }
  }
  const candidates = [];
  if (explicit) candidates.push(path.join(explicit, 'keyboard.json'));
  for (const root of roots) {
    candidates.push(
      path.join(root, 'steamapps', 'common', 'Le Mans Ultimate', 'UserData', 'player', 'keyboard.json'),
    );
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** Whether Le Mans Ultimate is running right now — see the module note. */
function lmuIsRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Le Mans Ultimate.exe" /NH', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /Le Mans Ultimate\.exe/i.test(out);
  } catch {
    // Cannot tell — assume it IS running. Refusing costs the operator one
    // re-run; writing into a live game costs them a binding that vanishes
    // later, which is far harder to diagnose.
    return true;
  }
}

const configPath = findKeyboardConfig();
if (!configPath) {
  console.error(
    'Could not find LMU\'s keyboard.json.\n' +
      'Set APEX_LMU_USERDATA to <LMU>/UserData/player and try again.',
  );
  process.exit(1);
}

const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

/* --------------------------------- --list --------------------------------- */

if (has('--list')) {
  const input = read().Input || {};
  const byDik = new Map();
  for (const [fn, v] of Object.entries(input)) if (typeof v === 'number') byDik.set(v, fn);
  console.log(`\n${configPath}\n`);
  console.log('F-key availability:');
  for (const [name, dik] of Object.entries(KEYS)) {
    const owner = byDik.get(dik);
    console.log(`  ${name.padEnd(4)} dik ${String(dik).padStart(3)}  ${owner ? 'used by ' + owner : 'free'}`);
  }
  const pit = input['Pit Request'];
  console.log(
    `\nPit Request: ${typeof pit === 'number' ? 'bound to dik ' + pit : 'NOT bound to a key'}\n`,
  );
  process.exit(0);
}

/* -------------------------------- --restore ------------------------------- */

if (has('--restore')) {
  const dir = path.dirname(configPath);
  const backups = fs
    .readdirSync(dir)
    .filter((f) => /^keyboard\.apex-backup-.*\.json$/.test(f))
    .sort();
  if (backups.length === 0) {
    console.error('No apex backup found beside keyboard.json — nothing to restore.');
    process.exit(1);
  }
  if (lmuIsRunning()) {
    console.error('Close Le Mans Ultimate first — it rewrites keyboard.json when it exits.');
    process.exit(1);
  }
  const newest = path.join(dir, backups[backups.length - 1]);
  fs.copyFileSync(newest, configPath);
  console.log(`Restored ${path.basename(newest)} -> keyboard.json`);
  process.exit(0);
}

/* --------------------------------- binding -------------------------------- */

const fnName = argOf('--function', 'Pit Request');
const wanted = argOf('--key', null);

const config = read();
const input = config.Input || {};

/**
 * Keys already spoken for — EXCLUDING the target function's own binding.
 *
 * That exclusion is the whole point. Without it, a function that is already
 * bound counts its own key as taken, so the auto-picker skips it and hands out
 * the next one down: run the tool twice and `Pit Request` walks F10 → F11, three
 * times and it is on F9. Which is exactly what happened the first time this was
 * re-run against a config it had already written.
 */
const usedDik = new Set(
  Object.entries(input)
    .filter(([fn, v]) => typeof v === 'number' && fn !== fnName)
    .map(([, v]) => v),
);

// Already on a key we can press, and the caller did not ask for a specific one:
// leave it alone. Re-running this must be a no-op, not a reshuffle — it is the
// kind of tool people run again when they are unsure whether it worked.
if (!wanted && Object.values(KEYS).indexOf(input[fnName]) >= 0) {
  const name = Object.keys(KEYS).find((k) => KEYS[k] === input[fnName]);
  console.log(`"${fnName}" is already bound to ${name}. Nothing to do.`);
  process.exit(0);
}

let keyName = wanted;
if (keyName) {
  if (!(keyName in KEYS)) {
    console.error(`Unsupported key "${keyName}". Choose one of: ${Object.keys(KEYS).join(', ')}`);
    process.exit(1);
  }
} else {
  keyName = AUTO_ORDER.find((k) => !usedDik.has(KEYS[k]));
  if (!keyName) {
    console.error(
      'Every offerable F-key is already bound in LMU. Free one, or pass --key F<n> to take it over.',
    );
    process.exit(1);
  }
}

const dik = KEYS[keyName];
const existingOwner = Object.keys(input).find((fn) => input[fn] === dik && fn !== fnName);

if (input[fnName] === dik) {
  console.log(`"${fnName}" is already bound to ${keyName}. Nothing to do.`);
  process.exit(0);
}

if (lmuIsRunning()) {
  console.error(
    'Le Mans Ultimate is RUNNING.\n\n' +
      'It rewrites keyboard.json from memory when it exits, so a change made now\n' +
      'would be silently thrown away the next time you quit the game — it would\n' +
      'appear to work, then be gone tomorrow.\n\n' +
      'Close LMU, run this again, then start LMU.',
  );
  process.exit(1);
}

// Back up before touching anything. Timestamped rather than a single .bak so a
// second run cannot overwrite the only copy of the original.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(path.dirname(configPath), `keyboard.apex-backup-${stamp}.json`);
fs.copyFileSync(configPath, backup);

if (existingOwner) {
  console.log(`Note: ${keyName} was bound to "${existingOwner}" — taking it over.`);
  delete input[existingOwner];
}
input[fnName] = dik;
config.Input = input;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

// Read back rather than trusting the write: this file is the whole point.
const verify = read().Input || {};
if (verify[fnName] !== dik) {
  console.error('Write did not stick — restoring the backup.');
  fs.copyFileSync(backup, configPath);
  process.exit(1);
}

console.log(
  `Bound "${fnName}" to ${keyName} (dik ${dik}).\n` +
    `Backup: ${path.basename(backup)}\n\n` +
    'Start LMU — the overlay can now press it. Undo with --restore.',
);
