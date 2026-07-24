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
import { UNKNOWN_VALUE, type MfdAid, type MfdPitRow, type MfdState } from './types';

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

/**
 * The driving aids the widget surfaces, in display order, with the label shown
 * on the overlay. Only the on-the-fly race adjustments a driver actually reaches
 * for — deliberately NOT the full setup (springs, gears, toe…), which is a
 * garage-only concern and would bury the useful controls. Any key absent or
 * `available: false` on the current car is simply skipped.
 */
const AID_KEYS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'VM_BRAKE_BALANCE', label: 'Brake Bias' },
  { key: 'VM_BRAKE_MIGRATION', label: 'Brake Migration' },
  { key: 'VM_ANTILOCKBRAKESYSTEMMAP', label: 'ABS Map' },
  { key: 'VM_TRACTIONCONTROLMAP', label: 'TC Map' },
  { key: 'VM_TRACTIONCONTROLPOWERCUTMAP', label: 'TC Power Cut' },
  { key: 'VM_TRACTIONCONTROLSLIPANGLEMAP', label: 'TC Slip' },
  { key: 'VM_ENGINE_MIXTURE', label: 'Engine Mixture' },
  { key: 'VM_ENGINE_BRAKEMAP', label: 'Engine Braking' },
  { key: 'VM_ENGINE_BOOST', label: 'Engine Boost' },
  { key: 'VM_REGEN_LEVEL', label: 'Regen Level' },
  { key: 'VM_ELECTRIC_MOTOR_MAP', label: 'Motor Map' },
];

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

/** Projects the curated `VM_*` aids out of the raw garage-data map. */
export function projectAids(raw: Record<string, RawGarageVal> | null | undefined): MfdAid[] {
  if (!raw || typeof raw !== 'object') return [];
  const aids: MfdAid[] = [];
  for (const { key, label } of AID_KEYS) {
    const v = raw[key];
    if (!v || v.available === false) continue;
    if (typeof v.value !== 'number') continue;
    const min = typeof v.minValue === 'number' ? v.minValue : 0;
    const maxCount = typeof v.maxValue === 'number' ? v.maxValue : v.value + 1;
    aids.push({
      key,
      label,
      value: v.value,
      minValue: min,
      // Normalized to the highest LEGAL value (inclusive); see inclusiveMax().
      maxValue: inclusiveMax(min, maxCount),
      text: typeof v.stringValue === 'string' ? v.stringValue.trim() : String(v.value),
    });
  }
  return aids;
}

/** Builds the frame's {@link MfdState} from both raw payloads. */
export function buildMfdState(
  pitRaw: RawPitRow[] | null | undefined,
  garageRaw: Record<string, RawGarageVal> | null | undefined,
): MfdState {
  return { pit: projectPitMenu(pitRaw), aids: projectAids(garageRaw) };
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
