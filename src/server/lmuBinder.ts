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
 * ## The pool: scancodes no keyboard produces
 * Every key here is a scancode Windows maps to **no virtual key at all**, or to
 * an unassigned OEM slot. That is the whole idea:
 *
 *   - the driver cannot already have bound it in LMU, because no key on their
 *     desk emits it;
 *   - it cannot fire an OBS or Discord global hotkey for the same reason;
 *   - Windows itself has no meaning for it, so nothing is stolen from the
 *     desktop either.
 *
 * **Every one was verified against the running game**, not inferred from a
 * header: bound to a real LMU function, pressed with `SendInput`, and the car's
 * own aid value watched in shared memory.
 *
 * Two whole families were ruled out along the way, both of which *worked*:
 *
 *   - `0x67`–`0x6F` are **F16–F24**. DirectInput's names stop at F15, but the
 *     scancodes do not, and F13–F24 is precisely what a Stream Deck emits for
 *     "a key no game uses" — see {@link FKEY_SCANCODES}.
 *   - `0x90`+ resolve to `E0`-prefixed scancodes, the **media keys**, so one of
 *     those would mute the driver's music every time the overlay nudged a brake
 *     bias.
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
 * Scancodes for **F16–F24**, which must never enter the pool.
 *
 * They are the obvious-looking candidates and they work perfectly — every one
 * was tested against the running game and drove its function. They are still
 * disqualified, because DirectInput's *names* stop at F15 but the scancodes do
 * not: Windows maps `0x67`–`0x6F` straight onto the F16+ virtual keys, and
 * F13–F24 is exactly what a **Stream Deck** emits when asked for "a key no game
 * uses". Binding them would put the overlay on a collision course with the one
 * peripheral most of this audience owns.
 *
 * Kept as a named constant rather than a comment so the test can assert the
 * pool never drifts back into this range.
 */
export const FKEY_SCANCODES: readonly number[] = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];

/**
 * Claimable keys. Every one of these was **bound to a real LMU function and
 * pressed into the running game**, and the car's own values moved in shared
 * memory — none of it is inferred from a header file.
 *
 * They are ordered by how invisible they are to Windows. The first block maps
 * to **no virtual key at all** on a standard layout; the last three map to
 * unassigned OEM slots. Nothing in either block appears on a keyboard sold in
 * the West, and nothing in either block can be produced by a Stream Deck, which
 * is the failure mode that ruled out the F-keys (see {@link FKEY_SCANCODES}).
 *
 * Fifteen keys against thirteen functions, so a rig with nothing bound at all
 * gets full coverage with two to spare. If more are ever needed, `85, 90, 91,
 * 92, 94, 95, 115, 126` are the same class of code and only need the same test.
 */
export const KEY_POOL: readonly PoolKey[] = [
  // No virtual key whatsoever — the safest thing a scancode can be.
  { dik: 121, label: 'CONVERT (Japanese 変換)', proven: true },
  { dik: 125, label: 'YEN (Japanese ¥)', proven: true },
  { dik: 112, label: 'KANA (Japanese)', proven: true },
  { dik: 114, label: 'unmapped 0x72', proven: true },
  { dik: 116, label: 'unmapped 0x74', proven: true },
  { dik: 117, label: 'unmapped 0x75', proven: true },
  { dik: 119, label: 'unmapped 0x77', proven: true },
  { dik: 120, label: 'unmapped 0x78', proven: true },
  { dik: 122, label: 'unmapped 0x7A', proven: true },
  { dik: 127, label: 'unmapped 0x7F', proven: true },
  { dik: 96, label: 'unmapped 0x60', proven: true },
  { dik: 97, label: 'unmapped 0x61', proven: true },
  // Unassigned OEM virtual keys — no physical key produces them either.
  { dik: 123, label: 'NOCONVERT (Japanese 無変換)', proven: true },
  { dik: 111, label: 'unmapped 0x6F (OEM)', proven: true },
  { dik: 113, label: 'unmapped 0x71 (OEM)', proven: true },

  /*
   * ── The reserve, added with the prototype aids ──
   *
   * {@link WANTED} grew from 13 functions to 21 when brake migration, both ARBs
   * and regeneration were wired up, so the fifteen keys above no longer cover a
   * rig with nothing bound. These six are the codes the original note named as
   * "the same class of code, needing only the same test".
   *
   * They are NOT `proven` and that word is load-bearing: every key above was
   * bound to a real LMU function, pressed with `SendInput`, and the car's own
   * value watched in shared memory. These have had the half of that check which
   * does not need the game — `MapVirtualKeyW(scancode, MAPVK_VSC_TO_VK_EX)` plus
   * `GetKeyNameTextW`, confirming Windows resolves each to either no virtual key
   * at all (85) or an unassigned OEM slot (90–95), and gives none of them a key
   * name. That is the SAFETY property, and it is the one that matters most: an
   * unproven key that LMU refuses to bind leaves a control that does nothing,
   * which is visible and harmless. A key that some keyboard can actually produce
   * would fire an aid change under the driver's hands, which is neither.
   *
   * They sort AFTER every proven key, so a rig only reaches them once the
   * fifteen are spent — most rigs never will.
   *
   * Deliberately excluded from this block: 115 and 126. They look identical in
   * the DIK table and they are not — Windows resolves them to `VK_ABNT_C1` and
   * `VK_ABNT_C2`, the two extra keys on a **Brazilian ABNT2 keyboard**. Those
   * are real keys with real keycaps for that layout, which is exactly the
   * collision this pool exists to avoid.
   */
  { dik: 85, label: 'unmapped 0x55', proven: false },
  { dik: 90, label: 'unmapped 0x5A (OEM)', proven: false },
  { dik: 91, label: 'unmapped 0x5B (OEM)', proven: false },
  { dik: 92, label: 'unmapped 0x5C (OEM)', proven: false },
  { dik: 94, label: 'unmapped 0x5E (OEM)', proven: false },
  { dik: 95, label: 'unmapped 0x5F (OEM)', proven: false },
];

/**
 * Scancodes that resolve to a real key on a **Brazilian ABNT2** layout.
 *
 * `VK_ABNT_C1` (0xC1) and `VK_ABNT_C2` (0xC2) — the extra `/?°` key by the
 * right shift and the numpad `.` on that layout. They sit in the same
 * "unmapped-looking" DIK range as the reserve above and would have been swept
 * in with it. Named so the test can assert they stay out.
 */
export const ABNT_SCANCODES: readonly number[] = [115, 126];

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
  /*
   * The prototype aids, last on purpose. Every car in the game has traction
   * control, ABS, a brake bias and a motor map; only the Hypercars, LMP2s and
   * LMP3s have these, so on the rig where the pool runs short it is right that
   * a GT3 driver loses nothing. Within the four, regen leads: it is the one a
   * Hypercar driver changes lap to lap rather than at a setup screen.
   */
  { fn: 'Increment Regeneration', label: 'Regen +' },
  { fn: 'Decrement Regeneration', label: 'Regen −' },
  { fn: 'Brake Migration Forward', label: 'Brake migration forward' },
  { fn: 'Brake Migration Rearward', label: 'Brake migration rearward' },
  { fn: 'Inc Front ARB', label: 'Front ARB +' },
  { fn: 'Dec Front ARB', label: 'Front ARB −' },
  { fn: 'Inc Rear ARB', label: 'Rear ARB +' },
  { fn: 'Dec Rear ARB', label: 'Rear ARB −' },
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
