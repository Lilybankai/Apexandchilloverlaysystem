/**
 * @file src/telemetry/mfdControl.ts
 * @module telemetry/mfdControl
 *
 * Reads and **writes** the in-game Multi-Function Display for the player's car,
 * over Le Mans Ultimate's own REST API — no synthesized keystrokes.
 *
 * ## Why REST, not emulated keys
 * The overlay runs inside OBS's Chromium, which cannot send keys to the game;
 * the naive alternative (a native `SendInput` helper on the server) is
 * focus-dependent, keybind-coupled and open-loop. LMU instead exposes the whole
 * MFD as structured JSON that can be read AND set:
 *
 * - **Pit menu** — `GET /rest/garage/PitMenu/receivePitMenu` returns the rows;
 *   `POST /rest/garage/PitMenu/loadPitMenu` sets them. The load body is the
 *   **bare row array** (verified live: posting the array back unchanged is a
 *   no-op; editing a row's `currentSetting` and posting the whole array applies
 *   it). It is NOT wrapped in `{pitMenu: …}`.
 * - **Driving aids / setup** — `GET /rest/garage/getPlayerGarageData` returns
 *   `VM_*` values; `POST /rest/garage/<VM_KEY>` with `{ "value": <int> }` sets
 *   one (verified live: brake bias moved instantly and reversibly, HTTP 200).
 *
 * So this module is the closed loop the widget drives: it projects the raw API
 * shapes into the frame's {@link MfdState} (the read side, consumed by
 * `lmuRestProvider.ts`) and issues validated writes (the control side, called by
 * the server's `/api/mfd/*` routes). Every write is clamped to the sim's own
 * declared bounds so the widget can never post an out-of-range setting.
 */

import http from 'node:http';
import type { AidSettings, AidStep } from './lmuLocalCar';
import {
  UNKNOWN_VALUE,
  type MfdAid,
  type MfdPitRow,
  type MfdState,
  type MfdTyreControl,
} from './types';

/** Raw pit row from `receivePitMenu`. */
export interface RawPitRow {
  'PMC Value'?: number;
  name?: string;
  currentSetting?: number;
  default?: number;
  settings?: Array<{ text?: string }>;
}

/** Raw `VM_*` value from `getPlayerGarageData`. */
export interface RawGarageVal {
  key?: string;
  value?: number;
  minValue?: number;
  maxValue?: number;
  stringValue?: string;
  available?: boolean;
}

/** Only `VM_`-prefixed setup keys are legal write targets — never anything else. */
const VM_KEY = /^VM_[A-Z0-9_]+$/;

/**
 * LMU reports a `VM_*` aid's `maxValue` as the **option count**, not the highest
 * index — so the top legal value is `maxValue - 1`. Verified live: brake bias
 * (maxValue 57) tops out at 56, ABS map (10) at 9, TC map (12) at 11. A
 * single-option aid (`maxValue` 1, e.g. an "N/A" channel) collapses to just its
 * floor, which is correct — it cannot move.
 */
function inclusiveMax(min: number, maxCount: number): number {
  return Math.max(min, maxCount - 1);
}

/* --------------------------- projection (read side) ----------------------- */

/**
 * Projects the raw pit-menu array into the frame's {@link MfdPitRow} list.
 *
 * The one row that is not passed straight through is the sim's all-four
 * `TIRES:` entry, which is projected from the four corners instead (see
 * {@link projectTyreControl}). Its own `currentSetting` is not a reading of
 * what the car will be shod with: set the corners individually — or through
 * this overlay — and the row sits on `Mixed Tyres` while all four corners
 * agree perfectly. Showing that would be a lie a driver cannot check at a
 * glance, and the corners are the thing the crew actually fits.
 */
export function projectPitMenu(raw: RawPitRow[] | null | undefined): MfdPitRow[] {
  if (!Array.isArray(raw)) return [];
  const tyres = projectTyreControl(raw);
  const rows: MfdPitRow[] = [];
  for (const r of raw) {
    if (!r || typeof r.name !== 'string') continue;
    const settings = Array.isArray(r.settings) ? r.settings : [];
    const cur = typeof r.currentSetting === 'number' ? r.currentSetting : 0;
    let curText = settings[cur] && typeof settings[cur]!.text === 'string' ? settings[cur]!.text! : '';
    let count = settings.length;
    if (tyres && isAllFourTyreRow(r.name)) {
      curText = tyres.currentText;
      count = tyres.options.length;
    } else if (isTyreRow(r.name)) {
      // A corner: same filtering, so the row cannot advertise more compounds
      // than its ± will ever stop on.
      count = tyreOptionSet(r).options.length;
      curText = curText.trim();
    }
    rows.push({
      pmcValue: typeof r['PMC Value'] === 'number' ? r['PMC Value']! : UNKNOWN_VALUE,
      name: r.name,
      currentSetting: cur,
      settingCount: count,
      defaultSetting: typeof r.default === 'number' ? r.default : UNKNOWN_VALUE,
      currentText: curText,
    });
  }
  return rows;
}

/**
 * The driving aids the widget shows, **read live from the car** — brake bias,
 * the TC map with its two sub-settings, ABS and the motor map.
 *
 * All of it comes from shared memory (see {@link module:telemetry/lmuLocalCar}
 * `mTC`), which is a correction: everything except brake bias used to be
 * *counted* here rather than read, on the finding that LMU published no live
 * value for them anywhere. That finding was wrong. The values are single bytes
 * in what stock rF2 leaves as reserved space, and they are only populated on
 * the player's own record — two ways to look straight past them — but they are
 * there, and they are exactly what the game's own MFD shows.
 *
 * The garage fallback is kept for brake bias alone, because it is the one aid
 * with a REST counterpart. It is a frozen SETUP value that never moves in-race,
 * so it is only ever reached when there is no live car to read — in the garage,
 * or spectating.
 *
 * @param garageRaw - Raw garage data, for the brake-bias setup fallback.
 * @param liveRearBias - Live rear brake-bias fraction (0..1) from shared memory.
 * @param liveAids - The aid maps from the player's telemetry record.
 */
export function projectAids(
  garageRaw: Record<string, RawGarageVal> | null | undefined,
  liveRearBias?: number,
  liveAids?: AidSettings | null,
): MfdAid[] {
  const aids: MfdAid[] = [];

  // Live value from shared memory wins — the whole point of the section.
  if (typeof liveRearBias === 'number' && liveRearBias > 0 && liveRearBias < 1) {
    const rear = Math.round(liveRearBias * 1000) / 10; // %, one decimal
    const front = Math.round((1 - liveRearBias) * 1000) / 10;
    aids.push({
      key: 'BRAKE_BIAS',
      label: 'Brake Bias',
      value: Math.round(liveRearBias * 100),
      minValue: 0,
      maxValue: 100,
      text: `${front.toFixed(1)}:${rear.toFixed(1)}`,
    });
  } else {
    // Fallback: the frozen setup value from the garage (better than nothing, but
    // it won't move — shown only when there is no live value, e.g. spectating).
    const v = garageRaw ? garageRaw['VM_BRAKE_BALANCE'] : undefined;
    if (v && typeof v.value === 'number' && typeof v.stringValue === 'string') {
      aids.push({
        key: 'BRAKE_BIAS',
        label: 'Brake Bias',
        value: v.value,
        minValue: 0,
        maxValue: typeof v.maxValue === 'number' ? inclusiveMax(0, v.maxValue) : v.value,
        text: v.stringValue.trim(),
      });
    }
  }

  if (liveAids) {
    // `max` of 0 means this car does not offer the control at all (a GT3 with no
    // motor map, say). Skipped rather than shown as a permanent 0, which would
    // read as "turned off" — a different and alarming thing to tell a driver.
    /**
     * The sim's own wording for a step, when the garage endpoint is describing
     * the SAME step the live block is reporting.
     *
     * Shared memory gives the number and nothing else, so a "7/11" is all a raw
     * row can say. The garage publishes a rendered label for the same control —
     * `"P6"` for an anti-roll bar, `"1.5% F"` for brake migration, `"140kW"` for
     * a motor map — which is what the driver sees on the wheel and is far more
     * use than an index.
     *
     * Guarded on the two agreeing. The garage value can lag the live one (it is
     * a different endpoint answering a different question), and a label that
     * belongs to a step the driver has already moved off is worse than no label:
     * it would confidently name the wrong setting. On a mismatch this returns
     * null and the row falls back to the honest index.
     */
    const simLabel = (garageKey: string, liveValue: number): string | null => {
      const g = garageRaw ? garageRaw[garageKey] : undefined;
      if (!g || typeof g.value !== 'number' || g.value !== liveValue) return null;
      const s = typeof g.stringValue === 'string' ? g.stringValue.trim() : '';
      return s && s !== 'N/A' ? s : null;
    };

    const row = (key: string, label: string, step: AidStep | undefined, garageKey?: string): void => {
      // No step at all is the same statement as max 0 — this source does not
      // carry the control (an aids block from before the Hypercar trio, say).
      if (!step || step.max <= 0) return;
      const named = garageKey ? simLabel(garageKey, step.value) : null;
      aids.push({
        key,
        label,
        value: step.value,
        minValue: 0,
        maxValue: step.max,
        // The sim counts these from 1 in its own MFD, but publishes the raw
        // step; shown as "7/11" so the driver can see the headroom either way —
        // or in the sim's own words when the garage agrees which step it is.
        text: named ?? `${step.value}/${step.max}`,
      });
    };
    row('tc', 'Traction Control', liveAids.tc);
    row('tcSlip', 'TC Slip', liveAids.tcSlip);
    row('tcCut', 'TC Power Cut', liveAids.tcCut);
    row('abs', 'ABS', liveAids.abs);
    row('motorMap', 'Motor Map', liveAids.motorMap, 'VM_ELECTRIC_MOTOR_MAP');
    // The Hypercar trio. Each is skipped by the `max <= 0` guard on a car that
    // does not offer it, so a GT3 simply gets no such rows.
    row('brakeMigration', 'Brake Migration', liveAids.brakeMigration, 'VM_BRAKE_MIGRATION');
    row('frontARB', 'Front ARB', liveAids.frontARB, 'VM_FRONT_ANTISWAY');
    row('rearARB', 'Rear ARB', liveAids.rearARB, 'VM_REAR_ANTISWAY');
  }

  /**
   * Regen level — the only aid here with **no shared-memory source at all**.
   *
   * The others are read live from the driven car's own record. This one is not
   * in that buffer: a scan of the whole 1888-byte record found no pair matching
   * the value the sim was simultaneously reporting over REST, and the bytes past
   * the aid run are zeros (see `lmuLocalCar.ts` `mBrakeMigration`). So it comes
   * from the garage endpoint, which is the same fallback brake bias uses when
   * there is no live car.
   *
   * That carries the garage endpoint's known weakness — it can report a SETUP
   * value rather than a live one — so this row can lag what the driver has on
   * the wheel. It is published anyway because a regen level that is usually
   * right is far more use to a Hypercar driver than no regen row at all, and
   * because the label is the sim's own ("200kW"), not a number we derived.
   */
  const regen = garageRaw ? garageRaw['VM_REGEN_LEVEL'] : undefined;
  if (
    regen &&
    typeof regen.value === 'number' &&
    typeof regen.maxValue === 'number' &&
    regen.maxValue > 1 &&
    typeof regen.stringValue === 'string' &&
    regen.stringValue.trim() !== 'N/A'
  ) {
    aids.push({
      key: 'regen',
      label: 'Regen',
      value: regen.value,
      minValue: 0,
      maxValue: inclusiveMax(0, regen.maxValue),
      text: regen.stringValue.trim(),
    });
  }

  return aids;
}

/**
 * The four per-corner tyre rows, in the sim's own order.
 *
 * Matched on the `FL|FR|RL|RR TIRE` prefix rather than by index, because the pit
 * menu's shape changes with the car and the session — the same reason
 * `pitCursor.ts` anchors on names. `TIRES:` (the sim's own all-four shortcut) is
 * deliberately excluded: it is a different row with its own option list, and
 * including it would double-count against the corners it drives.
 */
const CORNER_TYRE_ROW = /^(FL|FR|RL|RR)\s*TIRE/i;

/** The sim's own all-four shortcut row, which sits above the four corners. */
const ALL_FOUR_TYRE_ROW = /^\s*TIRES?\s*:/i;

/** Whether a row is the sim's all-four `TIRES:` entry (not a corner). */
export function isAllFourTyreRow(name: string | undefined): boolean {
  return typeof name === 'string' && ALL_FOUR_TYRE_ROW.test(name);
}

/** Whether a row is any tyre row — the all-four shortcut or one corner. */
export function isTyreRow(name: string | undefined): boolean {
  return typeof name === 'string' && (ALL_FOUR_TYRE_ROW.test(name) || CORNER_TYRE_ROW.test(name));
}

function cornerTyreRows(raw: RawPitRow[] | null | undefined): RawPitRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r) => typeof r?.name === 'string' && CORNER_TYRE_ROW.test(r.name));
}

/**
 * Options a tyre row publishes that are **not compounds a driver can pick**.
 *
 * Verified live: LMU's tyre rows carry a fixed slot list per car and fill the
 * slots this car/event does not run with `INVALID`, and the all-four `TIRES:`
 * row carries an extra `Mixed Tyres` slot which is a *state* — what the row
 * reports when the corners disagree — rather than something to select.
 *
 * Both must be skipped when stepping, because both are dead ends the driver
 * cannot use and cannot see coming: pressing `+` twice from `New Wet` used to
 * book `INVALID`, which is not a tyre, and one more landed on `Mixed Tyres`,
 * which is not a decision. The compounds that remain are exactly the ones this
 * car has at this event, which is why nothing here knows what a compound is.
 */
const UNSELECTABLE_TYRE_OPTION = /^(invalid|mixed(\s|$))/i;

/** A tyre row's real choices, and the raw setting index each one writes. */
export interface TyreOptionSet {
  /** Selectable compounds, in the sim's own order and words. */
  options: string[];
  /** `raw[i]` is the `currentSetting` value that selects `options[i]`. */
  raw: number[];
}

/**
 * The compounds a tyre row actually offers.
 *
 * Exported because the read side (what the widget shows), the write side (what
 * a ± books) and the cursor all have to agree about which options exist — an
 * index that means `New Wet` in one and `INVALID` in another is the bug this
 * prevents.
 */
export function tyreOptionSet(row: RawPitRow | null | undefined): TyreOptionSet {
  const settings = Array.isArray(row?.settings) ? row.settings : [];
  const options: string[] = [];
  const raw: number[] = [];
  settings.forEach((s, i) => {
    const text = typeof s?.text === 'string' ? s.text.trim() : '';
    if (!text || UNSELECTABLE_TYRE_OPTION.test(text)) return;
    options.push(text);
    raw.push(i);
  });
  return { options, raw };
}

/**
 * Where a ± lands on a tyre row. `current` is the selected option, or
 * {@link UNKNOWN_VALUE} when there isn't one (the corners disagree, or the row
 * is parked on a slot that is not a compound).
 *
 * **Clamped, never wrapped.** Every other pit row clamps, and here it also
 * matters in its own right: wrapping from the last compound round to
 * `No Change` would cancel the tyre change the driver just booked, on a control
 * they are pressing without looking.
 *
 * From "no current option", one press resolves it in the direction pressed —
 * `−` to `No Change`, `+` to the first real compound — so a mixed set is one
 * press from being a single compound either way.
 */
export function nextTyreOption(current: number, delta: number, count: number): number {
  if (count <= 0) return UNKNOWN_VALUE;
  if (delta === 0) return current;
  if (current < 0) return delta < 0 ? 0 : Math.min(1, count - 1);
  return clamp(current + (delta < 0 ? -1 : 1), 0, count - 1);
}

/** The option index a row's raw `currentSetting` corresponds to, or -1. */
function selectedOption(row: RawPitRow, set: TyreOptionSet): number {
  const cur = typeof row.currentSetting === 'number' ? row.currentSetting : 0;
  return set.raw.indexOf(cur);
}

/**
 * Whether a pit row is an **amount going into the car** — fuel, or the virtual
 * energy that stands in for it on the cars that run to an energy allowance.
 *
 * Both, always, and never one without the other: a hypercar's `FUEL:` row is
 * driven by its energy allowance, so restoring one and leaving the other at zero
 * would put the car on the grid with nothing in it and a row that says otherwise.
 *
 * `FUEL RATIO:` is excluded for the reason given on {@link isServiceRow} — it is
 * a plan for later stops, not an amount being added now.
 */
export function isFuelRow(name: string): boolean {
  const upper = String(name || '').toUpperCase();
  if (!upper) return false;
  if (upper.startsWith('VIRTUAL ENERGY')) return true;
  if (upper.startsWith('FUEL') && !upper.includes('RATIO')) return true;
  return false;
}

/**
 * Whether a pit row is **service** — work the crew does on the car, and
 * therefore something a stop-and-go must not have booked.
 *
 * Exported because this predicate is the whole judgement in
 * {@link MfdController.clearPitService}, and getting it wrong is silent and
 * expensive in both directions: too greedy and serving a penalty wipes the
 * driver's aero and pressure setup, too timid and the "stop-go" takes a full
 * service and does not discharge the penalty.
 *
 * The `FUEL RATIO:` exclusion is the subtle one. It reads as fuel and is not:
 * it is how much the sim puts in at *future* stops, a strategy setting rather
 * than an amount being added now, so zeroing it would quietly rewrite the
 * driver's fuelling plan for the rest of the race.
 */
export function isServiceRow(name: string): boolean {
  const upper = String(name || '').toUpperCase();
  if (!upper) return false;
  if (CORNER_TYRE_ROW.test(name)) return true;
  if (upper.startsWith('DAMAGE')) return true;
  if (upper.startsWith('DRIVER')) return true;
  if (isFuelRow(name)) return true;
  return false;
}

/**
 * Collapses the four per-corner tyre rows into one compound control.
 *
 * Returns `null` when the menu has no corner rows at all (out of a session, or a
 * car without them), so the caller omits the field rather than publishing an
 * empty control the widget would draw as a broken dropdown.
 *
 * The option list is taken from the corner with the MOST options rather than
 * from a fixed corner: they are the same list in every case observed, but if the
 * sim ever published a shorter list for one corner, silently offering the driver
 * fewer compounds than the car has would be the worse failure.
 */
export function projectTyreControl(raw: RawPitRow[] | null | undefined): MfdTyreControl | null {
  const rows = cornerTyreRows(raw);
  if (rows.length === 0) return null;

  let best: TyreOptionSet = { options: [], raw: [] };
  for (const r of rows) {
    const set = tyreOptionSet(r);
    if (set.options.length > best.options.length) best = set;
  }
  if (best.options.length === 0) return null;

  // Compared as OPTIONS, not as raw indices: the corners agree when they are on
  // the same compound, and two corners could in principle reach the same
  // compound through different slots.
  const selected = rows.map((r) => selectedOption(r, tyreOptionSet(r)));
  const first = selected[0]!;
  const mixed = selected.some((s) => s !== first);
  const current = mixed || first < 0 ? UNKNOWN_VALUE : first;

  return {
    options: best.options,
    current,
    mixed,
    currentText: mixed ? 'Mixed' : (best.options[first] ?? ''),
  };
}

/** Builds the frame's {@link MfdState} from the raw payloads + the live car. */
export function buildMfdState(
  pitRaw: RawPitRow[] | null | undefined,
  garageRaw: Record<string, RawGarageVal> | null | undefined,
  liveRearBias?: number,
  liveAids?: AidSettings | null,
): MfdState {
  const tyres = projectTyreControl(pitRaw);
  return {
    pit: projectPitMenu(pitRaw),
    aids: projectAids(garageRaw, liveRearBias, liveAids),
    ...(tyres ? { tyres } : {}),
  };
}

/* ----------------------------- writes (control) --------------------------- */

/** Result of a control write. `ok` is true only on a 2xx from the sim. */
export interface MfdWriteResult {
  ok: boolean;
  /** HTTP status from LMU (0 if the request never completed). */
  status: number;
  /** Human-readable detail, present on failure. */
  error?: string;
  /** The value/setting actually applied after clamping, when known. */
  applied?: number;
  /**
   * What that setting now reads as. Carried so a caller can show the new value
   * without another read — and because on a tyre row `applied` indexes the
   * *selectable* compounds, which is not the raw settings list the caller has.
   */
  appliedText?: string;
}

/** How a caller addresses a pit row: by the sim's stable id, or by exact name. */
export interface PitTarget {
  pmcValue?: number;
  name?: string;
}

export interface MfdControllerConfig {
  /** LMU REST API port (default 6397). */
  lmuApiPort?: number;
  verbose?: boolean;
}

/**
 * Issues validated writes to the LMU MFD. Stateless beyond its config: each call
 * does a fresh read-modify-write so it never acts on a cached menu.
 */
export class MfdController {
  private readonly port: number;
  private readonly verbose: boolean;

  public constructor(config: MfdControllerConfig = {}) {
    this.port = config.lmuApiPort ?? 6397;
    this.verbose = config.verbose ?? false;
  }

  /**
   * Sets a pit-menu row to an absolute option index, or nudges it by `delta`.
   * Reads the current menu, resolves the target row by `pmcValue` (preferred) or
   * `name`, clamps the new index to `[0, settingCount-1]`, then POSTs the whole
   * (minimally edited) array to `loadPitMenu`.
   *
   * **Tyre rows are handled as compounds, not as raw indices**, and that
   * decision lives here rather than in each caller so no route, button or
   * cursor can miss it: the sim's tyre rows carry slots that are not compounds
   * (`INVALID`, `Mixed Tyres`), and the all-four `TIRES:` row means "all four
   * corners", which is a write to the corners rather than to itself. On those
   * rows `setting` therefore indexes the *selectable* compounds — see
   * {@link tyreOptionSet}.
   */
  public async setPitRow(
    target: PitTarget,
    opts: { setting?: number; delta?: number },
  ): Promise<MfdWriteResult> {
    const menu = await this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu');
    if (!Array.isArray(menu)) {
      return { ok: false, status: 0, error: 'pit menu unavailable (not in a session?)' };
    }
    const idx = menu.findIndex((r) =>
      target.pmcValue != null ? r['PMC Value'] === target.pmcValue : r.name === target.name,
    );
    if (idx < 0) {
      return { ok: false, status: 0, error: `pit row not found (${target.pmcValue ?? target.name})` };
    }
    const row = menu[idx]!;

    // The all-four row IS the compound control — one press, four corners.
    if (isAllFourTyreRow(row.name)) return this.writeTyreCompound(menu, opts);

    let applied: number;
    let appliedText: string;
    if (isTyreRow(row.name)) {
      const set = tyreOptionSet(row);
      if (set.options.length === 0) {
        return { ok: false, status: 0, error: 'this corner offers no compounds' };
      }
      applied =
        opts.setting != null
          ? clamp(opts.setting, 0, set.options.length - 1)
          : nextTyreOption(selectedOption(row, set), opts.delta ?? 0, set.options.length);
      row.currentSetting = set.raw[applied]!;
      appliedText = set.options[applied]!;
      // A corner is subject to the same "the sim did not take it" behaviour as
      // the all-four row — see readTyreCompound.
      const res = await this.post('/rest/garage/PitMenu/loadPitMenu', menu);
      if (!res.ok) return res;
      const after = await this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu');
      const now = Array.isArray(after)
        ? after.find((r) => r['PMC Value'] === row['PMC Value'] || r.name === row.name)
        : null;
      if (now) {
        const nowSet = tyreOptionSet(now);
        const at = selectedOption(now, nowSet);
        if (at >= 0) {
          applied = at;
          appliedText = nowSet.options[at]!;
        }
      }
      return { ...res, applied, appliedText };
    } else {
      const count = Array.isArray(row.settings) ? row.settings.length : 0;
      if (count <= 0) return { ok: false, status: 0, error: 'row has no settings to select' };
      const current = typeof row.currentSetting === 'number' ? row.currentSetting : 0;
      const wanted = opts.setting != null ? opts.setting : current + (opts.delta ?? 0);
      applied = clamp(wanted, 0, count - 1);
      row.currentSetting = applied;
      appliedText = row.settings?.[applied]?.text?.trim() ?? '';
    }

    const res = await this.post('/rest/garage/PitMenu/loadPitMenu', menu);
    return res.ok ? { ...res, applied, appliedText } : res;
  }

  /**
   * Strips every service off the next pit stop — the pit-menu half of serving a
   * **stop-and-go**.
   *
   * A stop-go is not a thing the sim can be told to do: there is no "serve
   * penalty" command in LMU's API or its key bindings, because serving one is
   * just driving into your box, stopping, and leaving without taking anything.
   * The part that goes wrong is the *without taking anything* — a driver who
   * pits with their normal strategy still loaded gets a full service, which does
   * not discharge the penalty and costs them the stop as well. So this is the
   * genuinely useful, genuinely automatable half: clear the menu, then pit.
   *
   * Which rows are cleared, and why only these:
   *
   * - **the four corner tyres** → `No Change` (index 0)
   * - **`DAMAGE:`** → its first option, which is `Do Not Repair` whenever the
   *   row has real options; a lone `N/A` (nothing to repair) is left alone
   * - **fuel and virtual energy** → 0, the "add nothing" end of both rows
   * - **`DRIVER:`** → index 0, i.e. no driver change
   *
   * Everything else in the menu — wing, brake ducts, pressures, fuel *ratio* —
   * is deliberately untouched. None of it adds time on its own (the sim applies
   * setup changes as part of a service it is already doing), and wiping the
   * driver's aero and pressure setup as a side effect of serving a penalty would
   * be a far worse outcome than the penalty was.
   *
   * One read-modify-write for all of it, for the reason given on
   * {@link setTyreCompound}: `loadPitMenu` takes the whole array.
   */
  public async clearPitService(): Promise<MfdWriteResult & { cleared?: string[] }> {
    const menu = await this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu');
    if (!Array.isArray(menu)) {
      return { ok: false, status: 0, error: 'pit menu unavailable (not in a session?)' };
    }
    const cleared: string[] = [];
    for (const row of menu) {
      const name = typeof row?.name === 'string' ? row.name : '';
      if (!name) continue;
      const count = Array.isArray(row.settings) ? row.settings.length : 0;
      if (count <= 1) continue; // nothing to choose (a lone "N/A")
      if (!isServiceRow(name)) continue;
      if (row.currentSetting !== 0) cleared.push(name);
      row.currentSetting = 0;
    }
    if (cleared.length === 0) {
      // Already clear. Report success — the caller asked for a state, not for a
      // change, and a "nothing to do" failure would read as a broken button.
      return { ok: true, status: 200, cleared };
    }
    const res = await this.post('/rest/garage/PitMenu/loadPitMenu', menu);
    return res.ok ? { ...res, cleared } : res;
  }

  /**
   * Puts fuel and virtual energy back to a **full load** — the half of
   * {@link clearPitService} that can be undone, for the driver who selects a
   * penalty on the SERVE row and then thinks better of it.
   *
   * Only these rows, and only to the top of their own list. Nothing here tries
   * to restore the *strategy* the clear wiped: the tyres, the damage choice and
   * the driver change are gone and were never copied anywhere, so a guess at
   * them would be an invented pit stop rather than the driver's. Fuel is the one
   * that has an unambiguous safe answer — a car that leaves the box with a full
   * tank finishes the stint, and a car that leaves with nothing does not get to
   * the end of the lap.
   *
   * The DRIVER row is deliberately untouched, which matters most on the way back
   * out: `clearPitService` set it to "no change", and re-booking a driver swap
   * the driver did not ask for costs a great deal more than a wrong fuel load.
   *
   * "Full" is the LAST option in the row's own list, whatever the sim put there —
   * `100%` on a virtual-energy row, the tank's capacity on a fuel one. A row with
   * a single option (`N/A` — this car takes no fuel here) is left alone.
   */
  public async restorePitFuel(): Promise<MfdWriteResult & { restored?: string[] }> {
    const menu = await this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu');
    if (!Array.isArray(menu)) {
      return { ok: false, status: 0, error: 'pit menu unavailable (not in a session?)' };
    }
    const restored: string[] = [];
    for (const row of menu) {
      const name = typeof row?.name === 'string' ? row.name : '';
      if (!name || !isFuelRow(name)) continue;
      const count = Array.isArray(row.settings) ? row.settings.length : 0;
      if (count <= 1) continue; // nothing to choose (a lone "N/A")
      const full = count - 1;
      if (row.currentSetting !== full) restored.push(name);
      row.currentSetting = full;
    }
    if (restored.length === 0) {
      // Already full, or no fuel rows in this menu. Same contract as
      // clearPitService: a state was asked for, and it holds.
      return { ok: true, status: 200, restored };
    }
    const res = await this.post('/rest/garage/PitMenu/loadPitMenu', menu);
    return res.ok ? { ...res, restored } : res;
  }

  /**
   * Sets the tyre compound on **all four corners at once**, absolutely or by
   * `delta` — the write half of {@link projectTyreControl}.
   *
   * One read-modify-write for the whole decision, not four. That is not just
   * fewer requests: `loadPitMenu` takes the entire array, so four sequential
   * calls would each re-read a menu the previous one had just changed, and a
   * driver holding the button down could interleave them into a genuinely mixed
   * set — the exact state this control exists to avoid.
   *
   * `delta` steps from the compound the corners agree on, and resolves a mixed
   * set to a single compound in the direction pressed rather than refusing —
   * see {@link nextTyreOption}. `setting` indexes the *selectable* compounds,
   * so it can never book an `INVALID` slot.
   */
  public async setTyreCompound(opts: {
    setting?: number;
    delta?: number;
  }): Promise<MfdWriteResult> {
    const menu = await this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu');
    if (!Array.isArray(menu)) {
      return { ok: false, status: 0, error: 'pit menu unavailable (not in a session?)' };
    }
    return this.writeTyreCompound(menu, opts);
  }

  /**
   * Sets every corner to one compound in an already-read menu, then posts it.
   *
   * Takes the menu rather than reading its own so that a write arriving through
   * {@link setPitRow} (the `TIRES:` row, a widget ±, the cursor) is still ONE
   * read and ONE write — re-reading here would race a menu we are part-way
   * through editing.
   *
   * Matched by option TEXT rather than by index, because each corner carries its
   * own slot list: the same compound can sit at a different `currentSetting` on
   * different corners, and writing one index to all four is how a car ends up
   * on three wets and a medium.
   */
  private async writeTyreCompound(
    menu: RawPitRow[],
    opts: { setting?: number; delta?: number },
  ): Promise<MfdWriteResult> {
    const corners = cornerTyreRows(menu);
    if (corners.length === 0) {
      return { ok: false, status: 0, error: 'no per-corner tyre rows in this pit menu' };
    }
    const sets = corners.map((r) => tyreOptionSet(r));
    // Bound by the SHORTEST list, so a compound offered on three corners and not
    // the fourth can never be half-applied.
    const count = Math.min(...sets.map((s) => s.options.length));
    if (!Number.isFinite(count) || count <= 0) {
      return { ok: false, status: 0, error: 'tyre rows offer no compounds to select' };
    }

    const selected = corners.map((r, i) => selectedOption(r, sets[i]!));
    const agreed = selected.every((s) => s === selected[0]) ? selected[0]! : UNKNOWN_VALUE;
    const wanted =
      opts.setting != null
        ? clamp(opts.setting, 0, count - 1)
        : nextTyreOption(agreed, opts.delta ?? 0, count);
    corners.forEach((r, i) => {
      r.currentSetting = sets[i]!.raw[wanted]!;
    });
    // The all-four row is carried along with the corners. On its own it is
    // ignored — verified live: posting `TIRES:` alone changes nothing — but a
    // load that leaves it on `Mixed Tyres` while the corners agree makes the
    // sim's own MFD disagree with this one.
    const all = menu.find((r) => isAllFourTyreRow(r.name));
    if (all) {
      const allSet = tyreOptionSet(all);
      if (allSet.raw[wanted] != null) all.currentSetting = allSet.raw[wanted]!;
    }

    const res = await this.post('/rest/garage/PitMenu/loadPitMenu', menu);
    if (!res.ok) return res;
    return { ...res, ...(await this.readTyreCompound(wanted, sets[0]!)) };
  }

  /**
   * What the tyres ACTUALLY read after a write, rather than what was asked for.
   *
   * The sim does not always take a tyre write, and it is not merely refusing —
   * verified live, in a session where it would not go back to `No Change`:
   * asking for `No Change` from `New Medium` left the corners on `New Wet`.
   * Reporting the request as though it had landed made a held `−` oscillate
   * between two compounds, because the next press computed from the sim's real
   * state while the display showed ours.
   *
   * So one extra read, on tyre writes only. Every other pit row takes its value
   * (a wing angle is a wing angle), and the read is a localhost round trip on a
   * control the driver is watching — cheap next to telling them they booked a
   * compound the car is not on.
   */
  private async readTyreCompound(
    fallback: number,
    fallbackSet: TyreOptionSet,
  ): Promise<{ applied: number; appliedText: string }> {
    const menu = await this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu');
    const tyres = projectTyreControl(menu);
    if (!tyres) return { applied: fallback, appliedText: fallbackSet.options[fallback] ?? '' };
    return { applied: tyres.current, appliedText: tyres.currentText };
  }

  /**
   * Sets a `VM_*` driving-aid value absolutely, or nudges it by `delta`. Reads
   * the garage data to clamp to the sim's `[minValue, maxValue]`, then POSTs
   * `{ value }` to `/rest/garage/<key>`.
   */
  public async setAid(
    key: string,
    opts: { value?: number; delta?: number },
  ): Promise<MfdWriteResult> {
    if (!VM_KEY.test(key)) return { ok: false, status: 0, error: `illegal aid key: ${key}` };
    const garage = await this.getJson<Record<string, RawGarageVal>>(
      '/rest/garage/getPlayerGarageData',
    );
    const cur = garage ? garage[key] : undefined;
    if (!cur || typeof cur.value !== 'number') {
      return { ok: false, status: 0, error: `aid ${key} unavailable` };
    }
    const min = typeof cur.minValue === 'number' ? cur.minValue : 0;
    const maxCount = typeof cur.maxValue === 'number' ? cur.maxValue : cur.value + 1;
    const max = inclusiveMax(min, maxCount);
    const wanted = opts.value != null ? opts.value : cur.value + (opts.delta ?? 0);
    const clamped = clamp(Math.round(wanted), min, max);

    const res = await this.post(`/rest/garage/${key}`, { value: clamped });
    return res.ok ? { ...res, applied: clamped } : res;
  }

  /**
   * Reads the live MFD state directly from LMU (a fresh read-through, not the
   * provider's cached poll). The widget calls this straight after a write so the
   * change is reflected immediately, without waiting for the next 3 s frame.
   * Returns `null` when the endpoints don't answer (out of a session).
   */
  public async getState(): Promise<MfdState | null> {
    const [pit, garage] = await Promise.all([
      this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu'),
      this.getJson<Record<string, RawGarageVal>>('/rest/garage/getPlayerGarageData'),
    ]);
    if (!Array.isArray(pit) && !garage) return null;
    return buildMfdState(pit, garage);
  }

  /**
   * The raw pit-menu rows, straight from the sim.
   *
   * Exposed for {@link module:server/pitCursor}, which needs the rows as the sim
   * numbers them — the projected {@link MfdPitRow} drops the `settings` array the
   * cursor reads a row's new text out of, and turns a missing `PMC Value` into a
   * sentinel it would then have to undo. Returns null out of a session.
   */
  public getPitRows(): Promise<RawPitRow[] | null> {
    return this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu');
  }

  /**
   * Raw `VM_*` garage values — the frozen SETUP numbers.
   *
   * Deliberately raw, keeping the `minValue`/`maxValue` bounds the projected
   * {@link MfdState} drops. Only brake bias is still read from here, and only as
   * the fallback for when there is no live car to read (in the garage, or
   * spectating): every aid otherwise comes off the telemetry record.
   */
  public getGarageData(): Promise<Record<string, RawGarageVal> | null> {
    return this.getJson<Record<string, RawGarageVal>>('/rest/garage/getPlayerGarageData');
  }

  /* ------------------------------- HTTP glue ------------------------------ */

  private getJson<T>(path: string): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path, timeout: 2000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => req.destroy());
    });
  }

  private post(path: string, body: unknown): Promise<MfdWriteResult> {
    return new Promise<MfdWriteResult>((resolve) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path,
          method: 'POST',
          timeout: 2500,
          headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume();
          res.on('end', () => {
            const ok = status >= 200 && status < 300;
            if (this.verbose && !ok) console.error(`[mfd] POST ${path} -> ${status}`);
            resolve(ok ? { ok, status } : { ok, status, error: `HTTP ${status}` });
          });
        },
      );
      req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(payload);
      req.end();
    });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
