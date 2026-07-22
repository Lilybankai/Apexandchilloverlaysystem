/**
 * @file src/telemetry/damage.ts
 * @module telemetry/damage
 *
 * Turns LMU's **repair-screen payload** into the damage channels the damage
 * widget renders: what is broken, how badly, and what the sim says it costs to
 * fix.
 *
 * ## Why this one is different from every other telemetry module
 * Everything else in `telemetry/` decodes shared memory. This decodes JSON from
 * `/rest/garage/UIScreen/RepairAndRefuel`, and it does so because the shared
 * memory route was tested and found dead.
 *
 * `scripts/probe-lmu-damage.js` watched both sources through a real impact in a
 * live session. The inherited ISI damage block — `mDentSeverity`,
 * `mLastImpactET`, `mLastImpactMagnitude`, `mLastImpactPos` — is present in the
 * struct at offsets pinned exactly by the verified anchors either side of it,
 * and LMU **does not populate it**: `mLastImpactET` never fired through the
 * impact, `mEngineWaterTemp` and `mEngineOilTemp` read 0 °C on a running
 * engine, `mScheduledStops` reads 255. Only `mDentSeverity[0]` moved, to a
 * coarse 1, and then froze. The REST screen, meanwhile, reported the same
 * impact as continuous per-component severities. So: REST, and only REST.
 *
 * ## The number this module does NOT compute
 * `repairSeconds` is `pitStopTimes.times.FixAllDamage`, read straight through.
 * That field is not a static config value — it was measured moving from 30 to
 * 35.098 for the damage actually on the car. The sim already knows what its own
 * repair costs, so this module reports that number rather than modelling one.
 *
 * The same restraint applies to what is deliberately absent: there is no
 * "total pit stop time" here. Assembling one would mean trusting
 * `FixTimeConcurrent` / `TireTimeConcurrent` / `FuelTimeConcurrent` to mean what
 * they appear to mean, and a wrong guess there produces a confident total that
 * is twenty seconds out. Same principle as the slip-angle note in
 * {@link module:telemetry/motion} and the load calibration in
 * {@link module:telemetry/chassis}.
 *
 * ## Units and conventions
 *   - `aero`, `suspension[]`  severity `0..1`, raw from the sim. NOT remapped to
 *                             a "health" percentage — that curve would be ours.
 *   - `brakeThicknessMm`      disc thickness, **mm** (the sim reports metres).
 *   - `repairSeconds`         seconds, or {@link UNKNOWN_VALUE} when the sim has
 *                             not published a figure.
 */

import { UNKNOWN_VALUE } from './types';
import type { DamageState, RepairSelection } from './types';

/**
 * Severity below which a component is called undamaged. The sim reports exact
 * zero on a clean car, so this is not a noise gate on the sensor — it stops a
 * trivial 0.2% scrape from lighting the widget up as damage worth pitting for.
 */
const NOISE_FLOOR = 0.005;

/**
 * Severity at which a component is called **heavy** rather than light. Set from
 * the measured hit: a contact that produced 19.5% at one corner and 9.5% aero
 * was a genuine "you need to think about pitting" event, and the split puts the
 * suspension corner in red and the aero in amber.
 */
export const HEAVY_SEVERITY = 0.15;

/** Metres → millimetres, for the brake discs. */
const M_TO_MM = 1000;

/**
 * Upper bound on a plausible severity. The channel is a `0..1` fraction; a
 * value outside that is a payload shape we do not understand, and is rejected
 * rather than clamped so a future LMU change surfaces as "no data" instead of
 * as a permanently pegged bar.
 */
const MAX_SEVERITY = 1.5;

/**
 * The repair-screen payload, narrowed to the fields consumed here. Everything
 * is optional: the endpoint 404s outside a session, returns an empty body in
 * menus, and populates the `DAMAGE:` menu entry only once there is damage.
 */
export interface RawRepairPayload {
  wearables?: {
    body?: { aero?: unknown; detachableParts?: unknown };
    suspension?: unknown;
    brakes?: unknown;
    tires?: unknown;
  };
  pitStopTimes?: { times?: Record<string, unknown> };
  pitMenu?: { pitMenu?: unknown };
}

/** A single entry in the sim's pit menu (`pitMenu.pitMenu[]`). */
interface RawPitMenuItem {
  name?: unknown;
  currentSetting?: unknown;
  settings?: unknown;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A `0..1` severity, or `null` if the value is not one. */
function severity(v: unknown): number | null {
  if (!finite(v)) return null;
  if (v < 0 || v > MAX_SEVERITY) return null;
  return v;
}

/** Reads a four-element numeric array, or `null` if it is not one. */
function quad(v: unknown, max: number): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length < 4) return null;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = v[i];
    if (!finite(n) || n < 0 || n > max) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/**
 * Maps the `DAMAGE:` pit-menu entry to what the driver has chosen.
 *
 * The entry is genuinely dynamic: on a clean car its only option is the literal
 * string `"N/A"`, and on damage it becomes
 * `["Do Not Repair", "Repair Body", "Repair All"]` with the sim auto-selecting
 * `Repair All`. So `'unavailable'` here means "nothing to repair", which is a
 * different statement from `'none'` ("damage present, driver has chosen not to
 * fix it") — and the widget says different things for each.
 */
function readRepairSelection(items: unknown): {
  selection: RepairSelection;
  options: string[];
} {
  if (!Array.isArray(items)) return { selection: 'unavailable', options: [] };
  const entry = (items as RawPitMenuItem[]).find(
    (it) => typeof it?.name === 'string' && (it.name as string).toUpperCase().startsWith('DAMAGE'),
  );
  if (!entry || !Array.isArray(entry.settings)) return { selection: 'unavailable', options: [] };

  const options = (entry.settings as { text?: unknown }[])
    .map((s) => (typeof s?.text === 'string' ? s.text : ''))
    .filter((s) => s !== '');

  // A lone "N/A" is the sim's way of saying there is nothing to repair.
  if (options.length <= 1) return { selection: 'unavailable', options };

  const idx = finite(entry.currentSetting) ? entry.currentSetting : 0;
  const chosen = (options[idx] || '').toLowerCase();
  if (chosen.includes('all')) return { selection: 'all', options };
  if (chosen.includes('body')) return { selection: 'body', options };
  return { selection: 'none', options };
}

/**
 * Counts how many corners have a tyre change selected, and prices it from the
 * sim's own published change times.
 *
 * The per-corner menu entries (`FL TIRE:` … `RR TIRE:`) read `No Change` at
 * index 0 and a compound name otherwise, so "selected" is simply "not the
 * no-change option".
 *
 * The 1-or-2 / 3-or-4 split is what the sim publishes: there is a
 * `TwoTireChange` and a `FourTireChange` and nothing between or below. Checked
 * against the game's own pit message with a single tyre selected, which read
 * `Tyres: 5 sec` against a published `TwoTireChange` of 4.5 — the game rounds
 * its display up, so one tyre really is priced as two.
 */
function readTyreChange(
  items: unknown,
  times: Record<string, unknown> | undefined,
): { seconds: number; corners: number } {
  if (!Array.isArray(items)) return { seconds: UNKNOWN_VALUE, corners: UNKNOWN_VALUE };

  let corners = 0;
  for (const it of items as RawPitMenuItem[]) {
    const name = typeof it?.name === 'string' ? it.name.toUpperCase() : '';
    // The per-corner entries only. `TIRES:` is the all-four shortcut and would
    // double-count against the corners it drives.
    if (!/^(FL|FR|RL|RR) TIRE/.test(name)) continue;
    if (!Array.isArray(it.settings)) continue;
    const idx = finite(it.currentSetting) ? it.currentSetting : 0;
    const chosen = (it.settings as { text?: unknown }[])[idx];
    const text = typeof chosen?.text === 'string' ? chosen.text.toLowerCase() : '';
    if (text !== '' && !text.includes('no change')) corners++;
  }

  if (corners === 0) return { seconds: 0, corners: 0 };
  const key = corners <= 2 ? 'TwoTireChange' : 'FourTireChange';
  return { seconds: repairTime(times, key), corners };
}

/** Reads one named entry out of `pitStopTimes.times`, in seconds. */
function repairTime(times: Record<string, unknown> | undefined, key: string): number {
  if (!times) return UNKNOWN_VALUE;
  const v = times[key];
  // A negative or absurd repair time is a payload we do not understand. Zero is
  // rejected too: "free repairs" is never true, and rendering +0.0s would read
  // as a green light to keep driving.
  if (!finite(v) || v <= 0 || v > 3600) return UNKNOWN_VALUE;
  return Math.round(v * 10) / 10;
}

/**
 * Decodes the repair screen into {@link DamageState}, or `null` when the
 * payload carries no usable damage block.
 *
 * `null` rather than a zeroed state is the whole contract: outside a session
 * the endpoint 404s, and a zeroed block would render identically to a pristine
 * car. The caller omits the field entirely on `null`, exactly as the `motion`
 * and `chassis` blocks do.
 */
export function decodeDamage(payload: RawRepairPayload | null | undefined): DamageState | null {
  if (!payload || typeof payload !== 'object') return null;
  const w = payload.wearables;
  if (!w || typeof w !== 'object') return null;

  const aero = severity(w.body?.aero);
  const suspension = quad(w.suspension, MAX_SEVERITY);
  // Both are required: half a damage block is not a damage block, and guessing
  // the missing half as zero would under-report a broken car.
  if (aero === null || suspension === null) return null;

  const brakesM = quad(w.brakes, 1);
  const brakeThicknessMm: [number, number, number, number] = brakesM
    ? (brakesM.map((m) => Math.round(m * M_TO_MM * 10) / 10) as [number, number, number, number])
    : [UNKNOWN_VALUE, UNKNOWN_VALUE, UNKNOWN_VALUE, UNKNOWN_VALUE];

  // `detachableParts` is a per-part "still attached" flag. Its length varies by
  // car (18 entries on the car this was probed against), so the count is taken
  // over whatever is present rather than against a fixed part list.
  const parts = w.body?.detachableParts;
  const partsDetached = Array.isArray(parts)
    ? parts.filter((p) => p === false).length
    : UNKNOWN_VALUE;

  const times = payload.pitStopTimes?.times;
  const { selection, options } = readRepairSelection(payload.pitMenu?.pitMenu);
  const tyres = readTyreChange(payload.pitMenu?.pitMenu, times);

  const worst = Math.max(aero, ...suspension);

  return {
    aero,
    suspension,
    brakeThicknessMm,
    partsDetached,
    worst,
    hasDamage: worst > NOISE_FLOOR,
    repairSeconds: repairTime(times, 'FixAllDamage'),
    repairBodySeconds: repairTime(times, 'FixAeroDamage'),
    repairSelection: selection,
    repairOptions: options,
    tyreChangeSeconds: tyres.seconds,
    tyreCornersSelected: tyres.corners,
    // Both figures carried twice: the precise published value, and the value
    // rounded the way the game's own pit message rounds it. The widget shows
    // the game-matching one by default so the overlay and the cockpit agree,
    // and `?exact=on` switches to the precise pair.
    repairSecondsGame: gameRounded(repairTime(times, 'FixAllDamage')),
    tyreChangeSecondsGame: gameRounded(tyres.seconds),
  };
}

/**
 * The sim's pit message rounds its times **up to the nearest 5 seconds**, and
 * this reproduces that so the widget can agree with what the driver reads in
 * the cockpit.
 *
 * Measured, both from one in-game screenshot with the widget and the game's own
 * message in frame together:
 *
 *   published 93.7 -> game showed "Damage 95 sec"
 *   published  4.5 -> game showed "Tyres: 5 sec"
 *
 * `ceil(x / 5) * 5` satisfies both. That is two data points, not a proof — but
 * a rounding rule is the kind of thing that is either exactly right or obviously
 * wrong on the third sample, and the precise value is kept alongside
 * ({@link DamageState.repairSeconds}) so nothing is lost if this needs changing.
 *
 * Rounding UP matters: the game is being pessimistic about the stop, and a
 * driver deciding whether to pit should not be handed an estimate that is
 * cheerier than the one the game will quote them.
 */
export function gameRounded(seconds: number): number {
  if (seconds === UNKNOWN_VALUE || !Number.isFinite(seconds)) return UNKNOWN_VALUE;
  if (seconds <= 0) return seconds;
  return Math.ceil(seconds / 5) * 5;
}

/**
 * Whether a severity should read as heavy. Exported so the widget and the tests
 * share one threshold rather than each carrying their own copy of `0.15`.
 */
export function isHeavy(sev: number): boolean {
  return sev >= HEAVY_SEVERITY;
}

/** Whether a severity counts as damage at all (above the noise floor). */
export function isDamaged(sev: number): boolean {
  return sev > NOISE_FLOOR;
}
