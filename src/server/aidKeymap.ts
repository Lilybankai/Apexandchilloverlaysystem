/**
 * @file src/server/aidKeymap.ts
 * @module server/aidKeymap
 *
 * The mapping from each live driving aid to the keyboard keys that adjust it in
 * LMU. The MFD widget's aid buttons fire these through {@link KeySender}.
 *
 * Defaults use **F13–F24**: keys no physical keyboard has, so nothing in LMU or
 * Windows binds them by default — the safest "won't clash" pool, and exactly 12
 * of them for six aids × down/up. Every entry is overridable from a JSON file
 * (`APEX_AID_KEYMAP`, or `mfd-keymap.json` in the working directory), e.g.
 *
 *   { "VM_BRAKE_BALANCE": { "dec": "F13", "inc": "F14" },
 *     "VM_TRACTIONCONTROLMAP": { "dec": "NUM1", "inc": "NUM2" } }
 *
 * Only the keys are configurable; the label/aid set comes from the defaults so
 * the widget and LMU-binding docs stay in step. Key names are those in
 * {@link module:server/keySender} (F1–F24, NUM0–NUM9, A–Z, digits).
 */

import { readFileSync } from 'node:fs';
import { KeySender } from './keySender';

/** One aid's down/up key assignment. */
export interface AidKeyBinding {
  /** VM_ key this drives (matches the frame's MfdAid.key). */
  aid: string;
  /** Human label, mirrored from the aid projection. */
  label: string;
  /** Key that steps the aid DOWN / rearward / lower. */
  dec: string;
  /** Key that steps the aid UP / forward / higher. */
  inc: string;
}

/** The default aid→key map. See the file header for the rationale. */
const DEFAULTS: ReadonlyArray<AidKeyBinding> = [
  { aid: 'VM_BRAKE_BALANCE', label: 'Brake Bias', dec: 'F13', inc: 'F14' },
  { aid: 'VM_TRACTIONCONTROLMAP', label: 'TC Map', dec: 'F15', inc: 'F16' },
  { aid: 'VM_TRACTIONCONTROLPOWERCUTMAP', label: 'TC Power Cut', dec: 'F17', inc: 'F18' },
  { aid: 'VM_ANTILOCKBRAKESYSTEMMAP', label: 'ABS Map', dec: 'F19', inc: 'F20' },
  { aid: 'VM_ENGINE_MIXTURE', label: 'Engine Mixture', dec: 'F21', inc: 'F22' },
  { aid: 'VM_REGEN_LEVEL', label: 'Regen Level', dec: 'F23', inc: 'F24' },
];

/**
 * Loads the aid keymap: the built-in defaults, with per-aid key overrides from
 * a JSON file if one is present and readable. An unknown key name in the file is
 * dropped with a warning rather than silently mis-binding.
 *
 * @param path - Override file path (from config); falls back to `mfd-keymap.json`.
 * @param verbose - Log override/validation detail.
 */
export function loadAidKeymap(path?: string, verbose = false): AidKeyBinding[] {
  const map = DEFAULTS.map((d) => ({ ...d }));
  const file = path || 'mfd-keymap.json';
  let overrides: Record<string, { dec?: string; inc?: string }> | null = null;
  try {
    overrides = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No override file — defaults are the whole answer. Not an error.
    return map;
  }
  if (!overrides || typeof overrides !== 'object') return map;

  for (const entry of map) {
    const o = overrides[entry.aid];
    if (!o) continue;
    for (const dir of ['dec', 'inc'] as const) {
      const key = o[dir];
      if (typeof key !== 'string') continue;
      if (!KeySender.knows(key)) {
        console.warn(`[keys] mfd-keymap: unknown key "${key}" for ${entry.aid}.${dir} — keeping default`);
        continue;
      }
      entry[dir] = key.toUpperCase();
      if (verbose) console.log(`[keys] mfd-keymap: ${entry.aid}.${dir} -> ${entry[dir]}`);
    }
  }
  return map;
}

/** Indexes a keymap by aid for O(1) lookup in the request path. */
export function indexKeymap(bindings: AidKeyBinding[]): Map<string, AidKeyBinding> {
  const m = new Map<string, AidKeyBinding>();
  for (const b of bindings) m.set(b.aid, b);
  return m;
}
