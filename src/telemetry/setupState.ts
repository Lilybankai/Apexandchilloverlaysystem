/**
 * @file src/telemetry/setupState.ts
 * @module telemetry/setupState
 *
 * The pure half of the setup editor's data path: projecting LMU's raw
 * `getPlayerGarageData` payload into the shape the editor renders, and the one
 * regex that decides which keys are legal write targets.
 *
 * Everything here is I/O-free by design — `scripts/test-setup.js` runs it
 * against checked-in fixtures, which is the only place the projection rules
 * (the `maxValue`-is-a-count convention, the dirty flag, the shape check that
 * skips `gearGraph`) are pinned down without a running sim.
 */

/**
 * Legal garage write targets: the flat `VM_*` chassis keys, or a per-corner
 * `WM_*` key with its corner suffix (`WM_CAMBER-W_FL`). These are the only
 * strings ever interpolated into a `POST /rest/garage/<key>` path, so the
 * guard is deliberately exact — note the corner list is closed, not `\w+`.
 */
export const GARAGE_WRITE_KEY = /^(VM_[A-Z0-9_]+|WM_[A-Z0-9_]+-W_(FL|FR|RL|RR))$/;

/**
 * A raw setting as `getPlayerGarageData` reports it. A superset of the
 * `RawGarageVal` the MFD reads — the editor also wants the saved-state and
 * ruleset-lock fields the MFD never needed.
 */
export interface RawSetupVal {
  key?: string;
  value?: number;
  minValue?: number;
  maxValue?: number;
  stringValue?: string;
  lastSavedStringValue?: string;
  numChangesValue?: number;
  isFreeSetting?: boolean;
  available?: boolean;
  diffComparisonValue?: number;
}

/** One setting, projected for the editor. */
export interface SetupSetting {
  key: string;
  /** Current step index. */
  value: number;
  /** Lowest legal index. */
  min: number;
  /**
   * Highest legal index — INCLUSIVE. LMU's raw `maxValue` is an option COUNT
   * (top legal value is `maxValue - 1`, same convention as the MFD's aids);
   * the projection resolves that here so no consumer does the arithmetic again.
   * `min === max` means the setting cannot move (single-option row).
   */
  max: number;
  /** The sim's own wording for the current step ("-1.5 deg", "P3"). */
  stringValue: string;
  /** What the loaded setup file says — differs from stringValue ⇒ unsaved. */
  lastSavedStringValue: string;
  /** True when the current value differs from the loaded setup file. */
  dirty: boolean;
  /** False ⇒ the ruleset fixes this setting; render it locked. */
  isFree: boolean;
  /** False ⇒ this car does not have the setting at all; do not render it. */
  available: boolean;
}

/** The editor's whole world, one poll's worth. */
export interface SetupState {
  /** False when LMU is not answering (closed, or loading a session). */
  connected: boolean;
  /** Vehicle name, when known ("Ferrari 296 GT3"). */
  car: string;
  /** Normalised class ("GT3", "HYPERCAR", …), when known. */
  carClass: string;
  /** LMU's symmetric-setup toggle — L/R corners mirror server-side when true. */
  symmetric: boolean;
  /** The sim's gear/speed graph payload, passed through untouched. */
  gearGraph?: unknown;
  settings: SetupSetting[];
}

/**
 * Is this top-level entry a setting? `getPlayerGarageData` mixes settings with
 * `symmetric` (a bare boolean) and `gearGraph` (an object of arrays); shape is
 * the only reliable discriminator because the key set is open-ended.
 */
function isSettingShaped(v: unknown): v is RawSetupVal & { value: number; maxValue: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as RawSetupVal).value === 'number' &&
    typeof (v as RawSetupVal).maxValue === 'number'
  );
}

/** Projects one raw entry. Returns null for entries that are not settings. */
export function projectSetting(key: string, raw: unknown): SetupSetting | null {
  if (!isSettingShaped(raw)) return null;
  const min = typeof raw.minValue === 'number' ? raw.minValue : 0;
  const max = Math.max(min, raw.maxValue - 1);
  const stringValue = typeof raw.stringValue === 'string' ? raw.stringValue : '';
  const lastSaved =
    typeof raw.lastSavedStringValue === 'string' ? raw.lastSavedStringValue : stringValue;
  return {
    key,
    value: raw.value,
    min,
    max,
    stringValue,
    lastSavedStringValue: lastSaved,
    dirty: stringValue !== lastSaved,
    isFree: raw.isFreeSetting !== false,
    available: raw.available !== false,
  };
}

/**
 * Projects the whole garage payload, preserving the sim's own key order — the
 * grouping map sorts within sections, but "the order LMU sent" is the fallback
 * that keeps unknown keys stable between polls.
 */
export function projectSetupState(
  garageRaw: Record<string, unknown> | null | undefined,
  car = '',
  carClass = '',
): SetupState {
  if (!garageRaw) {
    return { connected: false, car, carClass, symmetric: false, settings: [] };
  }
  const settings: SetupSetting[] = [];
  for (const [key, raw] of Object.entries(garageRaw)) {
    const s = projectSetting(key, raw);
    if (s) settings.push(s);
  }
  const symmetric = garageRaw['symmetric'] === true;
  const gearGraph = garageRaw['gearGraph'];
  return {
    connected: true,
    car,
    carClass,
    symmetric,
    ...(gearGraph !== undefined ? { gearGraph } : {}),
    settings,
  };
}
