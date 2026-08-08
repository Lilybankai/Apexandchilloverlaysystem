/**
 * @file src/server/lmuKeybinds.ts
 * @module server/lmuKeybinds
 *
 * Reads the driving-aid key bindings **out of Le Mans Ultimate's own config**
 * rather than guessing them, so the overlay presses whatever the driver actually
 * has bound and follows any rebind without a settings change.
 *
 * ## Why this replaces a hand-written keymap
 * The previous approach shipped a fixed F13–F24 map. Two things were wrong with
 * it. First, a key we pick is useless unless LMU also has that key bound to the
 * function — the game only acts on keys in its own bind list. Second, and fatally,
 * **DirectInput's keyboard map stops at F15**: `DIK_F16`..`DIK_F24` do not exist,
 * so the upper half of that map could never be seen by LMU no matter what we sent.
 *
 * ## The file
 * `<LMU>/UserData/player/keyboard.json` holds `"Input": { "<function>": <DIK> }`,
 * where the integers are **DirectInput scancodes** — exactly what `SendInput`
 * sends with `KEYEVENTF_SCANCODE`. Sibling `current controls.json` must have
 * `"Use Custom Keyboard": true` for the scheme to be live alongside the wheel.
 *
 * ## Page-independence (the reason these specific functions)
 * `Pit Menu Inc`/`Dec` are **MFD-page contextual** — they act on whichever MFD
 * page is displayed, so driving them requires the in-game MFD to be visible. The
 * functions below are the *dedicated* per-aid ones, which act regardless of what
 * is on screen; that is what lets the overlay replace the in-game MFD entirely.
 *
 * Everything degrades to an empty map when the file is missing or unreadable, so
 * a non-Steam install or a fresh profile simply disables aid control rather than
 * breaking the server.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** A resolved key press: a set-1 scancode plus whether it is an extended key. */
export interface ScanKey {
  /** Set-1 make code, already stripped of the extended bit. */
  scancode: number;
  /** True when the key needs `KEYEVENTF_EXTENDEDKEY` (arrows, numpad enter…). */
  extended: boolean;
  /** The raw DIK value from LMU's config, kept for logging/diagnostics. */
  dik: number;
}

/** One aid, with the keys that step it down and up. */
export interface AidBind {
  /** Stable id used by the overlay and the action registry. */
  id: string;
  /**
   * The `VM_*` key LMU's REST garage data uses for this aid. Empty when the aid
   * has no REST counterpart.
   */
  vmKey: string;
  /**
   * Every other name this aid answers to — notably the key the telemetry frame
   * labels it with, which is NOT always the `VM_*` one (brake bias arrives as
   * `BRAKE_BIAS` because it is read from shared memory, not REST). The MFD
   * widget matches on whatever it happens to be holding.
   */
  aliases: string[];
  /** Human label for the widget. */
  label: string;
  /** LMU function name that steps it DOWN, and the key bound to it. */
  decFunction: string;
  dec: ScanKey | null;
  /** LMU function name that steps it UP, and the key bound to it. */
  incFunction: string;
  inc: ScanKey | null;
}

/**
 * The aids we can drive, mapped to LMU's own function names.
 *
 * These names are authoritative — they are the keys LMU itself writes into
 * `direct input.json` / `keyboard.json`, so they must match verbatim.
 */
const AID_FUNCTIONS: ReadonlyArray<Omit<AidBind, 'inc' | 'dec'>> = [
  {
    id: 'brakeBias',
    vmKey: 'VM_BRAKE_BALANCE',
    aliases: ['BRAKE_BIAS'],
    label: 'Brake Bias',
    decFunction: 'Bias Rearward',
    incFunction: 'Bias Forward',
  },
  {
    id: 'tc',
    vmKey: 'VM_TRACTIONCONTROLMAP',
    aliases: ['TC_MAP'],
    label: 'Traction Control',
    decFunction: 'Traction Control Down',
    incFunction: 'Traction Control Up',
  },
  // LMU's two traction-control sub-settings. Their function names were not
  // guessable and are in no config file on disk — LMU only writes a function
  // into keyboard.json once it is bound, so an unbound one leaves no trace.
  // They were found by binding candidates and seeing which moved the car:
  // `Traction Control Slip Angle Up` moved the slip byte, `Traction Control 3
  // Up` did nothing. The name pattern is LMU's own UI label with
  // Increase/Decrease written as Up/Down.
  //
  // `Traction Control 2` is the POWER CUT, not a second TC map — confirmed
  // twice over: LMU's UI shows "Traction Control Power Increase" bound to V,
  // its config has `Traction Control 2 Up` = 47 (DIK for V), and pressing it
  // moved the cut byte.
  {
    id: 'tcSlip',
    vmKey: '',
    aliases: ['TC_SLIP'],
    label: 'TC Slip',
    decFunction: 'Traction Control Slip Angle Down',
    incFunction: 'Traction Control Slip Angle Up',
  },
  {
    id: 'tcCut',
    vmKey: '',
    aliases: ['TC_CUT', 'TC_POWER'],
    label: 'TC Power Cut',
    decFunction: 'Traction Control 2 Down',
    incFunction: 'Traction Control 2 Up',
  },
  {
    id: 'abs',
    vmKey: 'VM_ANTILOCKBRAKESYSTEMMAP',
    aliases: ['ABS_MAP'],
    label: 'ABS',
    decFunction: 'Antilock Brake System Down',
    incFunction: 'Antilock Brake System Up',
  },
  {
    id: 'motorMap',
    vmKey: 'VM_ENGINE_MIXTURE',
    aliases: ['ENGINE_MIXTURE', 'MOTOR_MAP'],
    label: 'Motor Map',
    decFunction: 'Decrement Motor Map',
    incFunction: 'Increment Motor Map',
  },
  /*
   * The prototype-class controls — brake migration, both anti-roll bars and
   * regeneration. A GT3 offers none of them and its rows never appear (the
   * `max <= 0` guard in `projectAids`), so in practice these are the Hypercar,
   * LMP2 and LMP3 rows.
   *
   * They were READ live for several releases and could not be changed: the MFD
   * showed four numbers with no ± beside them, because an aid with no entry in
   * this table has nothing to press. The names below close that.
   *
   * ## Where these names come from
   * Not guesswork, and not a config file — LMU only writes a function into
   * `keyboard.json` once it is BOUND, so an unbound function leaves no trace on
   * disk and cannot be discovered by reading the profile (which is what made
   * the TC sub-settings above such a hunt). They were read out of the game's own
   * control-function table inside `Le Mans Ultimate.exe`, the list LMU matches
   * these strings against, so they are verbatim by construction.
   *
   * That table also explains why no naming convention would have found them:
   * the eight functions use four different schemes — `Forward`/`Rearward`,
   * `Inc`/`Dec`, `Increment`/`Decrement`, and (for the aids above) `Up`/`Down`.
   * `Inc Front ARB` in particular is the ONLY aid in the game whose verb is
   * abbreviated, and `Increment Regeneration` sits three entries away from it
   * spelled out in full.
   */
  {
    id: 'brakeMigration',
    vmKey: 'VM_BRAKE_MIGRATION',
    aliases: ['BRAKE_MIGRATION'],
    label: 'Brake Migration',
    // Forward is `inc`, matching brake bias directly above: on both controls
    // "forward" is the end of the range that moves braking toward the front,
    // and a driver who has learned one should not find the other reversed.
    decFunction: 'Brake Migration Rearward',
    incFunction: 'Brake Migration Forward',
  },
  {
    id: 'frontARB',
    vmKey: 'VM_FRONT_ANTISWAY',
    aliases: ['FRONT_ARB', 'FRONT_ANTISWAY'],
    label: 'Front ARB',
    decFunction: 'Dec Front ARB',
    incFunction: 'Inc Front ARB',
  },
  {
    id: 'rearARB',
    vmKey: 'VM_REAR_ANTISWAY',
    aliases: ['REAR_ARB', 'REAR_ANTISWAY'],
    label: 'Rear ARB',
    decFunction: 'Dec Rear ARB',
    incFunction: 'Inc Rear ARB',
  },
  /*
   * Regen is the one aid here whose READING cannot confirm its own press.
   * Every other row is read live from the car's telemetry record, so the next
   * frame shows what the game did with the key. Regen has no shared-memory
   * source at all (see `projectAids`) and comes from the garage endpoint, which
   * is polled every 3 s and can report a setup value rather than a live one. So
   * the press lands immediately and the number catches up, or doesn't. That is
   * a reason to caveat the row, not to withhold the control: a Hypercar driver
   * changing deployment on the Mulsanne wants the change, and has the sim's own
   * label ("200kW") on the wheel to confirm it by.
   */
  {
    id: 'regen',
    vmKey: 'VM_REGEN_LEVEL',
    aliases: ['REGEN', 'REGEN_LEVEL'],
    label: 'Regen',
    decFunction: 'Decrement Regeneration',
    incFunction: 'Increment Regeneration',
  },
];

/**
 * Pit-menu functions. Kept separate from the aids above because they are
 * **page-contextual** and the overlay prefers the REST pit-menu API, which needs
 * neither focus nor a visible MFD. They are exposed for completeness (and for a
 * `Pit Request`, which has no REST equivalent).
 */
const PIT_FUNCTIONS: ReadonlyArray<{ id: string; label: string; fn: string }> = [
  { id: 'pitMenuUp', label: 'Pit Menu Up', fn: 'Pit Menu Up' },
  { id: 'pitMenuDown', label: 'Pit Menu Down', fn: 'Pit Menu Down' },
  { id: 'pitMenuInc', label: 'Pit Menu Inc', fn: 'Pit Menu Inc' },
  { id: 'pitMenuDec', label: 'Pit Menu Dec', fn: 'Pit Menu Dec' },
  { id: 'pitRequest', label: 'Pit Request', fn: 'Pit Request' },
];

/**
 * Converts a DirectInput key code into a sendable scancode.
 *
 * DIK encodes the "extended" (E0-prefixed) keys by setting the high bit: the
 * arrow keys are 0xC8/0xD0/0xCB/0xCD, whose real set-1 make codes are
 * 0x48/0x50/0x4B/0x4D sent with the extended flag. Verified against a live LMU
 * profile (`Pit Menu Up` = 200 = ↑).
 */
export function dikToScanKey(dik: number): ScanKey | null {
  if (!Number.isFinite(dik) || dik <= 0 || dik > 0xff) return null;
  return { scancode: dik & 0x7f, extended: dik >= 0x80, dik };
}

/** Candidate install locations for LMU's player config. */
function candidatePaths(): string[] {
  const out: string[] = [];
  const explicit = process.env.APEX_LMU_USERDATA;
  if (explicit) out.push(join(explicit, 'keyboard.json'));

  // Steam libraries: the default root plus anything in libraryfolders.vdf.
  const roots = new Set<string>([
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
  ]);
  for (const root of [...roots]) {
    const vdf = join(root, 'steamapps', 'libraryfolders.vdf');
    try {
      const text = readFileSync(vdf, 'utf8');
      // Entries look like:  "path"    "D:\\SteamLibrary"
      const re = /"path"\s+"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const p = m[1];
        if (p) roots.add(p.replace(/\\\\/g, '\\'));
      }
    } catch {
      /* no library file here — fine */
    }
  }
  for (const root of roots) {
    out.push(
      join(root, 'steamapps', 'common', 'Le Mans Ultimate', 'UserData', 'player', 'keyboard.json'),
    );
  }
  return out;
}

/** Locates LMU's `keyboard.json`, or null when no install is found. */
export function findKeyboardConfig(): string | null {
  for (const p of candidatePaths()) {
    if (existsSync(p)) return p;
  }
  return null;
}

/*
 * LMU's *controller* bind set (`direct input.json`) is deliberately NOT read.
 * It was, once: the aid values used to be counted rather than read, and a count
 * that only saw the overlay's own presses would drift the moment the driver
 * reached for the wheel — so we watched the very buttons LMU had those aids
 * bound to. The aids are read live from the car now, which makes knowing what
 * the wheel is bound to worth nothing here.
 */

/** The full resolved bind set, plus where it came from. */
export interface LmuKeybinds {
  /** Absolute path the binds were read from, or null when unavailable. */
  path: string | null;
  /** True when LMU's keyboard scheme is enabled (`Use Custom Keyboard`). */
  keyboardSchemeActive: boolean;
  /** Aid binds, in display order. Entries may have null keys when unbound. */
  aids: AidBind[];
  /** Pit-menu / pit-request keys, by id. */
  pit: Record<string, ScanKey | null>;
  /** Every function LMU has bound, for diagnostics and the bindings UI. */
  all: Record<string, ScanKey>;
}

/** An empty result, used whenever the config cannot be read. */
function emptyBinds(path: string | null): LmuKeybinds {
  return {
    path,
    keyboardSchemeActive: false,
    aids: AID_FUNCTIONS.map((a) => ({ ...a, dec: null, inc: null })),
    pit: {},
    all: {},
  };
}

/**
 * Reads and resolves LMU's keyboard binds. Cheap enough to call on demand (the
 * file is ~2 KB), so callers can re-read after the driver rebinds rather than
 * caching stale keys — LMU rewrites this file when it exits.
 */
export function readLmuKeybinds(explicitPath?: string): LmuKeybinds {
  const path = explicitPath ?? findKeyboardConfig();
  if (!path) return emptyBinds(null);

  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { Input?: Record<string, unknown> };
    input = parsed.Input ?? {};
  } catch {
    return emptyBinds(path);
  }

  const all: Record<string, ScanKey> = {};
  for (const [fn, value] of Object.entries(input)) {
    if (typeof value !== 'number') continue; // axis/option entries are not keys
    const key = dikToScanKey(value);
    if (key) all[fn] = key;
  }

  const aids = AID_FUNCTIONS.map((a) => ({
    ...a,
    dec: all[a.decFunction] ?? null,
    inc: all[a.incFunction] ?? null,
  }));

  const pit: Record<string, ScanKey | null> = {};
  for (const p of PIT_FUNCTIONS) pit[p.id] = all[p.fn] ?? null;

  return { path, keyboardSchemeActive: isKeyboardSchemeActive(path), aids, pit, all };
}

/**
 * Whether LMU has its keyboard scheme enabled. A bind that exists in
 * `keyboard.json` does nothing if the game is ignoring the keyboard device, so
 * this is worth surfacing to the operator rather than silently sending keys
 * nobody receives.
 */
function isKeyboardSchemeActive(keyboardPath: string): boolean {
  try {
    const controls = join(keyboardPath, '..', 'current controls.json');
    const parsed = JSON.parse(readFileSync(controls, 'utf8')) as Record<string, unknown>;
    return parsed['Use Custom Keyboard'] !== false;
  } catch {
    return true; // unknown — assume active rather than disabling the feature
  }
}

/** Aids that are actually usable (at least one direction bound). */
export function boundAids(binds: LmuKeybinds): AidBind[] {
  return binds.aids.filter((a) => a.inc !== null || a.dec !== null);
}

/**
 * Finds an aid by either its stable id (`tc`) or the `VM_*` key the telemetry
 * frame labels it with (`VM_TRACTIONCONTROLMAP`). The MFD widget renders rows
 * keyed by `VM_*`, so it can ask for a bind using exactly what it already has.
 */
export function findAid(binds: LmuKeybinds, name: string): AidBind | undefined {
  const needle = name.trim();
  return binds.aids.find(
    (a) => a.id === needle || a.vmKey === needle || a.aliases.indexOf(needle) >= 0,
  );
}
