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

/** Projects the raw pit-menu array into the frame's {@link MfdPitRow} list. */
export function projectPitMenu(raw: RawPitRow[] | null | undefined): MfdPitRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: MfdPitRow[] = [];
  for (const r of raw) {
    if (!r || typeof r.name !== 'string') continue;
    const settings = Array.isArray(r.settings) ? r.settings : [];
    const cur = typeof r.currentSetting === 'number' ? r.currentSetting : 0;
    const curText = settings[cur] && typeof settings[cur]!.text === 'string' ? settings[cur]!.text! : '';
    rows.push({
      pmcValue: typeof r['PMC Value'] === 'number' ? r['PMC Value']! : UNKNOWN_VALUE,
      name: r.name,
      currentSetting: cur,
      settingCount: settings.length,
      defaultSetting: typeof r.default === 'number' ? r.default : UNKNOWN_VALUE,
      currentText: curText,
    });
  }
  return rows;
}

/**
 * The driving aids the widget shows — just **brake bias**, the one aid LMU
 * exposes a LIVE value for (via shared memory). The other aids (TC/ABS/engine
 * maps) are deliberately omitted: LMU only reports their frozen SETUP value over
 * REST, which never moves when the driver adjusts them in-race and so reads as
 * broken. See {@link module:telemetry/lmuLocalCar} `mRearBrakeBias`.
 *
 * @param garageRaw - Raw garage data, for the setup-value fallback.
 * @param liveRearBias - Live rear brake-bias fraction (0..1) from shared memory,
 *                       when available; the driver's on-the-fly value.
 */
export function projectAids(
  garageRaw: Record<string, RawGarageVal> | null | undefined,
  liveRearBias?: number,
): MfdAid[] {
  // Live value from shared memory wins — the whole point of the section.
  if (typeof liveRearBias === 'number' && liveRearBias > 0 && liveRearBias < 1) {
    const rear = Math.round(liveRearBias * 1000) / 10; // %, one decimal
    const front = Math.round((1 - liveRearBias) * 1000) / 10;
    return [
      {
        key: 'BRAKE_BIAS',
        label: 'Brake Bias',
        value: Math.round(liveRearBias * 100),
        minValue: 0,
        maxValue: 100,
        text: `${front.toFixed(1)}:${rear.toFixed(1)}`,
      },
    ];
  }
  // Fallback: the frozen setup value from the garage (better than nothing, but
  // it won't move — shown only when there is no live value, e.g. spectating).
  const v = garageRaw ? garageRaw['VM_BRAKE_BALANCE'] : undefined;
  if (v && typeof v.value === 'number' && typeof v.stringValue === 'string') {
    return [
      {
        key: 'BRAKE_BIAS',
        label: 'Brake Bias',
        value: v.value,
        minValue: 0,
        maxValue: typeof v.maxValue === 'number' ? inclusiveMax(0, v.maxValue) : v.value,
        text: v.stringValue.trim(),
      },
    ];
  }
  return [];
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

function cornerTyreRows(raw: RawPitRow[] | null | undefined): RawPitRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r) => typeof r?.name === 'string' && CORNER_TYRE_ROW.test(r.name));
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
  if (upper.startsWith('VIRTUAL ENERGY')) return true;
  if (upper.startsWith('FUEL') && !upper.includes('RATIO')) return true;
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

  let best: RawPitRow | null = null;
  for (const r of rows) {
    const n = Array.isArray(r.settings) ? r.settings.length : 0;
    const bestN = best && Array.isArray(best.settings) ? best.settings.length : -1;
    if (n > bestN) best = r;
  }
  const options = (Array.isArray(best?.settings) ? best!.settings! : [])
    .map((s) => (typeof s?.text === 'string' ? s.text : ''))
    .filter((s) => s !== '');
  if (options.length === 0) return null;

  const settings = rows.map((r) => (typeof r.currentSetting === 'number' ? r.currentSetting : 0));
  const first = settings[0]!;
  const mixed = settings.some((s) => s !== first);
  const current = mixed ? UNKNOWN_VALUE : first;

  return {
    options,
    current,
    mixed,
    currentText: mixed ? 'Mixed' : (options[first] ?? ''),
  };
}

/** Builds the frame's {@link MfdState} from the raw payloads + live brake bias. */
export function buildMfdState(
  pitRaw: RawPitRow[] | null | undefined,
  garageRaw: Record<string, RawGarageVal> | null | undefined,
  liveRearBias?: number,
): MfdState {
  const tyres = projectTyreControl(pitRaw);
  return {
    pit: projectPitMenu(pitRaw),
    aids: projectAids(garageRaw, liveRearBias),
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
    const count = Array.isArray(row.settings) ? row.settings.length : 0;
    if (count <= 0) return { ok: false, status: 0, error: 'row has no settings to select' };
    const current = typeof row.currentSetting === 'number' ? row.currentSetting : 0;
    const wanted = opts.setting != null ? opts.setting : current + (opts.delta ?? 0);
    const clamped = clamp(wanted, 0, count - 1);
    row.currentSetting = clamped;

    const res = await this.post('/rest/garage/PitMenu/loadPitMenu', menu);
    return res.ok ? { ...res, applied: clamped } : res;
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
   * Sets the tyre compound on **all four corners at once**, absolutely or by
   * `delta` — the write half of {@link projectTyreControl}.
   *
   * One read-modify-write for the whole decision, not four. That is not just
   * fewer requests: `loadPitMenu` takes the entire array, so four sequential
   * calls would each re-read a menu the previous one had just changed, and a
   * driver holding the button down could interleave them into a genuinely mixed
   * set — the exact state this control exists to avoid.
   *
   * `delta` steps from the current selection when the corners agree, and from
   * the first corner when they do not, so nudging a mixed set resolves it to a
   * single compound rather than refusing.
   */
  public async setTyreCompound(opts: {
    setting?: number;
    delta?: number;
  }): Promise<MfdWriteResult> {
    const menu = await this.getJson<RawPitRow[]>('/rest/garage/PitMenu/receivePitMenu');
    if (!Array.isArray(menu)) {
      return { ok: false, status: 0, error: 'pit menu unavailable (not in a session?)' };
    }
    const corners = menu.filter(
      (r) => typeof r?.name === 'string' && CORNER_TYRE_ROW.test(r.name),
    );
    if (corners.length === 0) {
      return { ok: false, status: 0, error: 'no per-corner tyre rows in this pit menu' };
    }
    // Bound by the SHORTEST option list, so a compound offered on three corners
    // and not the fourth can never be half-applied.
    let count = Infinity;
    for (const r of corners) {
      count = Math.min(count, Array.isArray(r.settings) ? r.settings.length : 0);
    }
    if (!Number.isFinite(count) || count <= 0) {
      return { ok: false, status: 0, error: 'tyre rows have no settings to select' };
    }

    const current = typeof corners[0]!.currentSetting === 'number' ? corners[0]!.currentSetting : 0;
    const wanted = opts.setting != null ? opts.setting : current + (opts.delta ?? 0);
    const clamped = clamp(wanted, 0, count - 1);
    for (const r of corners) r.currentSetting = clamped;

    const res = await this.post('/rest/garage/PitMenu/loadPitMenu', menu);
    return res.ok ? { ...res, applied: clamped } : res;
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
   * Exposed for {@link module:server/aidShadow}, which uses them as the baseline
   * for the aids LMU will not report live. Deliberately raw: the shadow needs
   * `minValue`/`maxValue` to clamp, which the projected {@link MfdState} drops.
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
