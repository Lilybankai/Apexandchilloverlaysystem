/**
 * @file src/server/lmuBinder.ts
 * @module server/lmuBinder
 *
 * Gives LMU a **keyboard** binding for the functions this overlay drives, on
 * keys that cannot collide with anything the driver already uses.
 *
 * ## Why any of this is needed
 * The overlay can only press what LMU has bound to a KEY (see
 * {@link module:server/lmuKeybinds}). Most drivers have their aids on wheel
 * buttons and nothing else, and a wheel button cannot be synthesised — so on a
 * fresh rig half these controls simply cannot be driven from the overlay until
 * something writes the missing binds. Asking every user to hand-bind a dozen
 * functions in LMU's menus is not a product.
 *
 * ## The pool: keys that do not physically exist
 * Every key here is a real DirectInput key on a keyboard layout the driver
 * almost certainly does not own — Japanese and Brazilian keys. That is the
 * whole idea:
 *
 *   - the driver cannot already have bound it in LMU, because they cannot
 *     press it;
 *   - it cannot fire an OBS or Discord global hotkey for the same reason;
 *   - Windows itself has no meaning for these scancodes.
 *
 * **Verified against the game, not assumed.** `CONVERT`, `NOCONVERT` and `YEN`
 * were each bound to a real LMU function and pressed with `SendInput`; the
 * car's own aid values moved in shared memory. `KANA`, `ABNT_C1` and `ABNT_C2`
 * are the same class of key and are used only after the proven three.
 *
 * The DIK codes here are all below `0x80` **deliberately**. The other exotic
 * codes (`0x90`+) resolve to `E0`-prefixed scancodes — the media keys — so
 * binding one of those would mean the overlay muted the driver's music or
 * skipped a track every time it changed a brake bias.
 *
 * ## The one hard rule about writing
 * **LMU rewrites `keyboard.json` from memory when it exits.** A write made
 * while the game is running survives a test and is gone at the next launch, so
 * every path here refuses to write while LMU is up. That is not caution, it is
 * the difference between a binding that works and one that unwrites itself.
 */

import { readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { findKeyboardConfig, readLmuKeybinds, type LmuKeybinds } from './lmuKeybinds';

/** A key the overlay may claim, and what it is called on the layout that has it. */
export interface PoolKey {
  dik: number;
  label: string;
  /** True when this exact key has been pressed into LMU and observed to work. */
  proven: boolean;
}

/**
 * Claimable keys, **proven ones first** so a rig that needs only a few gets
 * only the verified ones.
 */
export const KEY_POOL: readonly PoolKey[] = [
  { dik: 121, label: 'CONVERT (Japanese 変換)', proven: true },
  { dik: 123, label: 'NOCONVERT (Japanese 無変換)', proven: true },
  { dik: 125, label: 'YEN (Japanese ¥)', proven: true },
  { dik: 112, label: 'KANA (Japanese)', proven: false },
  { dik: 115, label: 'ABNT_C1 (Brazilian /?)', proven: false },
  { dik: 126, label: 'ABNT_C2 (Brazilian numpad .)', proven: false },
];

/**
 * What each function is worth, most valuable first — the pool is smaller than
 * the wish list, so the order decides what a fresh rig gets.
 *
 * `Pit Request` leads because it is the only one with no alternative at all:
 * every pit-menu row can be driven over LMU's REST API, but requesting the stop
 * cannot, so without a key that button is dead. The aids follow in the order a
 * driver reaches for them mid-stint.
 */
export interface Bindable {
  /** The LMU function name, verbatim as it appears in `keyboard.json`. */
  fn: string;
  /** What to call it in the UI. */
  label: string;
}

export const WANTED: readonly Bindable[] = [
  { fn: 'Pit Request', label: 'Pit request' },
  { fn: 'Traction Control Up', label: 'Traction control +' },
  { fn: 'Traction Control Down', label: 'Traction control −' },
  { fn: 'Antilock Brake System Up', label: 'ABS +' },
  { fn: 'Antilock Brake System Down', label: 'ABS −' },
  { fn: 'Bias Forward', label: 'Brake bias forward' },
  { fn: 'Bias Rearward', label: 'Brake bias rearward' },
  { fn: 'Increment Motor Map', label: 'Motor map +' },
  { fn: 'Decrement Motor Map', label: 'Motor map −' },
  { fn: 'Traction Control 2 Up', label: 'TC power cut +' },
  { fn: 'Traction Control 2 Down', label: 'TC power cut −' },
  { fn: 'Traction Control Slip Angle Up', label: 'TC slip angle +' },
  { fn: 'Traction Control Slip Angle Down', label: 'TC slip angle −' },
];

/** One row of the plan the UI shows before anything is written. */
export interface BindPlanRow {
  fn: string;
  label: string;
  /** What LMU has bound to it today, or null. */
  currentDik: number | null;
  /** The key we would claim for it, or null when nothing needs doing. */
  proposedDik: number | null;
  proposedLabel: string | null;
  status: 'already-bound' | 'will-bind' | 'no-keys-left';
}

/** The whole picture: where the config is, what would change, what blocks it. */
export interface BindPlan {
  /** Absolute path to LMU's `keyboard.json`, or null when no install is found. */
  path: string | null;
  /** True when LMU is running, in which case nothing may be written. */
  lmuRunning: boolean;
  rows: BindPlanRow[];
  /** How many functions would be newly bound. */
  toBind: number;
  /** How many the pool could not cover. */
  unbindable: number;
}

/** Whether Le Mans Ultimate is running right now. */
export function isLmuRunning(): boolean {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Le Mans Ultimate.exe" /NH', {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /Le Mans Ultimate\.exe/i.test(out);
  } catch {
    // No tasklist (not Windows, or locked down) — report "not running" rather
    // than blocking the feature outright; the write is still backed up.
    return false;
  }
}

/**
 * Works out what would be written, without writing anything.
 *
 * Two rules keep this from ever fighting the driver: a function that already
 * has a key is left exactly as it is (re-running must be a no-op, which an
 * earlier version of this got wrong and walked a binding down the keyboard),
 * and a pool key already present anywhere in the file is skipped — even though
 * these keys should never be there, because "should never" is not a guarantee.
 */
export function planLmuBindings(binds?: LmuKeybinds): BindPlan {
  const resolved = binds ?? readLmuKeybinds();
  const path = resolved.path;
  const used = new Set<number>(Object.values(resolved.all).map((k) => k.dik));

  const free = KEY_POOL.filter((k) => !used.has(k.dik));
  const rows: BindPlanRow[] = [];
  let cursor = 0;

  for (const want of WANTED) {
    const existing = resolved.all[want.fn];
    if (existing) {
      rows.push({
        fn: want.fn,
        label: want.label,
        currentDik: existing.dik,
        proposedDik: null,
        proposedLabel: null,
        status: 'already-bound',
      });
      continue;
    }
    const key = free[cursor];
    if (!key) {
      rows.push({
        fn: want.fn,
        label: want.label,
        currentDik: null,
        proposedDik: null,
        proposedLabel: null,
        status: 'no-keys-left',
      });
      continue;
    }
    cursor++;
    rows.push({
      fn: want.fn,
      label: want.label,
      currentDik: null,
      proposedDik: key.dik,
      proposedLabel: key.label,
      status: 'will-bind',
    });
  }

  return {
    path,
    lmuRunning: isLmuRunning(),
    rows,
    toBind: rows.filter((r) => r.status === 'will-bind').length,
    unbindable: rows.filter((r) => r.status === 'no-keys-left').length,
  };
}

/** What an apply attempt did. */
export interface BindResult {
  ok: boolean;
  error?: string;
  /** Functions actually written, with the key each got. */
  written: Array<{ fn: string; dik: number; label: string }>;
  /** Path of the backup taken before the write. */
  backup?: string;
}

const BACKUP_PREFIX = 'keyboard.apex-backup-';

/** Writes the plan. Refuses while LMU is running — see the module note. */
export function applyLmuBindings(): BindResult {
  const plan = planLmuBindings();
  if (!plan.path) {
    return { ok: false, error: 'Le Mans Ultimate config not found', written: [] };
  }
  if (plan.lmuRunning) {
    return {
      ok: false,
      error:
        'Close Le Mans Ultimate first — it rewrites its controls file when it exits, ' +
        'and would throw these bindings away.',
      written: [],
    };
  }
  const todo = plan.rows.filter((r) => r.status === 'will-bind');
  if (todo.length === 0) return { ok: true, written: [] };

  let config: { Input?: Record<string, unknown> };
  try {
    config = JSON.parse(readFileSync(plan.path, 'utf8')) as { Input?: Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: `could not read ${plan.path}: ${(err as Error).message}`, written: [] };
  }
  config.Input = config.Input ?? {};

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(dirname(plan.path), `${BACKUP_PREFIX}${stamp}.json`);
  try {
    copyFileSync(plan.path, backup);
  } catch (err) {
    return { ok: false, error: `could not back up the config: ${(err as Error).message}`, written: [] };
  }

  const written: BindResult['written'] = [];
  for (const row of todo) {
    if (row.proposedDik == null) continue;
    config.Input[row.fn] = row.proposedDik;
    written.push({ fn: row.fn, dik: row.proposedDik, label: row.proposedLabel ?? '' });
  }

  try {
    writeFileSync(plan.path, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: `could not write the config: ${(err as Error).message}`, written: [], backup };
  }
  return { ok: true, written, backup };
}

/** Puts the newest backup back, so this is always undoable. */
export function restoreLmuBindings(): { ok: boolean; error?: string; from?: string } {
  const path = findKeyboardConfig();
  if (!path) return { ok: false, error: 'Le Mans Ultimate config not found' };
  if (isLmuRunning()) {
    return { ok: false, error: 'Close Le Mans Ultimate first — it would overwrite the restore.' };
  }
  const dir = dirname(path);
  let backups: string[];
  try {
    backups = readdirSync(dir)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.json'))
      .sort();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const newest = backups[backups.length - 1];
  if (!newest) return { ok: false, error: 'no backup to restore from' };
  try {
    copyFileSync(join(dir, newest), path);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, from: newest };
}
