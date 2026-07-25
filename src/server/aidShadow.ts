/**
 * @file src/server/aidShadow.ts
 * @module server/aidShadow
 *
 * Tracks the driving aids that LMU lets you **change but not read**.
 *
 * ## Why this exists
 * Brake bias has a live source (shared memory `mRearBrakeBias`) and the pit menu
 * is fully readable over REST, but **traction control, ABS and the motor map have
 * no live value anywhere** — verified twice, most recently with a noise-filtered,
 * per-aid scan of the whole telemetry record and the entire Extended block while
 * the driver worked each control. REST's `VM_*` values are the frozen *setup*
 * numbers and never move in-race.
 *
 * So for those three the overlay cannot mirror the game; it can only keep count.
 * This module is that count.
 *
 * ## Why counting is trustworthy here
 * A naive tracker that watched only our own writes would drift the instant the
 * driver reached for the wheel — and these aids *are* bound to the wheel, because
 * that is how people drive. The fix is that we watch **both** routes:
 *
 *   - the overlay's own key presses (`/api/mfd/aidkey`), and
 *   - the driver's wheel presses, by reading the very buttons LMU has bound
 *     (from `direct input.json`; see {@link module:server/lmuKeybinds}).
 *
 * Whichever way the aid moves, the shadow moves with it.
 *
 * ## Where it is still only an estimate
 * Honest limits, surfaced to the widget via `estimated` so it can be labelled
 * rather than passed off as truth:
 *   - a change made on a *third* route (a keyboard press by hand, a second
 *     controller LMU is bound to that we are not watching) is invisible;
 *   - the seed is LMU's setup value, so if the driver changed the aid before the
 *     overlay was running, the baseline is off by that much;
 *   - a press LMU ignored (already at its limit, or the sim not focused) is not
 *     distinguishable from one it applied, beyond our own min/max clamp.
 *
 * {@link resync} exists for exactly those cases: it re-seeds from the setup value
 * so the driver can put it straight at any time.
 */

/** One tracked aid. `value` is null until seeded. */
export interface ShadowAid {
  id: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  /** How the current value was last learned. */
  source: 'seed' | 'overlay' | 'wheel';
  /** Always true for these aids — the value is counted, never read back. */
  estimated: true;
  /** Epoch ms of the last change, for staleness display. */
  at: number;
}

/**
 * The aids this module tracks. Brake bias is deliberately absent: it has a live
 * source, so shadowing it would replace a true value with a guess.
 */
const TRACKED: ReadonlyArray<{ id: string; label: string; vmKey: string }> = [
  { id: 'tc', label: 'Traction Control', vmKey: 'VM_TRACTIONCONTROLMAP' },
  { id: 'abs', label: 'ABS', vmKey: 'VM_ANTILOCKBRAKESYSTEMMAP' },
  { id: 'motorMap', label: 'Motor Map', vmKey: 'VM_ENGINE_MIXTURE' },
];

const state = new Map<string, ShadowAid>();
for (const t of TRACKED) {
  state.set(t.id, {
    id: t.id,
    label: t.label,
    value: null,
    min: 0,
    max: 0,
    source: 'seed',
    estimated: true,
    at: 0,
  });
}

/** Garage data shape we care about: `{ VM_X: { value, minValue, maxValue } }`. */
type GarageData = Record<string, { value?: unknown; minValue?: unknown; maxValue?: unknown }>;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Take the baseline from LMU's setup values.
 *
 * Only fills a value that is still unknown: the setup number is frozen at what
 * the car left the garage with, so re-seeding an aid we are already tracking
 * would throw away every in-race change and silently rewind the display.
 * {@link resync} is the deliberate way to overwrite.
 */
export function seedFromGarage(garage: GarageData | null | undefined): void {
  if (!garage) return;
  for (const t of TRACKED) {
    const entry = garage[t.vmKey];
    if (!entry) continue;
    const shadow = state.get(t.id);
    if (!shadow) continue;
    const min = num(entry.minValue);
    const max = num(entry.maxValue);
    if (min !== null) shadow.min = min;
    if (max !== null) shadow.max = max;
    if (shadow.value === null) {
      const v = num(entry.value);
      if (v !== null) {
        shadow.value = v;
        shadow.source = 'seed';
        shadow.at = Date.now();
      }
    }
  }
}

/** Force the baseline back to LMU's setup values, discarding tracked changes. */
export function resync(garage: GarageData | null | undefined): void {
  for (const shadow of state.values()) shadow.value = null;
  seedFromGarage(garage);
}

/**
 * Record that an aid moved one step. `dir` is ±1.
 *
 * Clamped to the range LMU reported, so repeatedly stepping past a limit does
 * not run the shadow away from a value the game has stopped changing.
 * Returns the new value, or null when the aid is not tracked/seeded.
 */
export function bump(aidId: string, dir: number, source: 'overlay' | 'wheel'): number | null {
  const shadow = state.get(aidId);
  if (!shadow || shadow.value === null) return null;
  const step = dir < 0 ? -1 : 1;
  const next = shadow.value + step;
  if (shadow.max > shadow.min) {
    shadow.value = Math.min(shadow.max, Math.max(shadow.min, next));
  } else {
    shadow.value = Math.max(0, next);
  }
  shadow.source = source;
  shadow.at = Date.now();
  return shadow.value;
}

/** Whether an aid id is one this module tracks. */
export function isTracked(aidId: string): boolean {
  return state.has(aidId);
}

/** Snapshot of every tracked aid that has a value, for the MFD widget. */
export function getShadowAids(): ShadowAid[] {
  return [...state.values()].filter((s) => s.value !== null).map((s) => ({ ...s }));
}
