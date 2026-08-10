/**
 * @file src/telemetry/setupControl.ts
 * @module telemetry/setupControl
 *
 * The setup editor's controller: fresh read-throughs of the whole garage state
 * and validated writes back to it, over LMU's REST API via {@link MfdController}.
 *
 * Deliberately stateless between calls, like the MFD controller it composes —
 * every write starts from a fresh read of the sim's own bounds, so a stale
 * panel can never push an out-of-range value. And deliberately NOT a poller:
 * the editor's zero-cost-when-closed guarantee holds because the only timer in
 * the whole feature lives in the panel renderer, which stops it the moment the
 * tab hides. This module does work only when asked.
 */

import { MfdController, type MfdWriteResult } from './mfdControl';
import { normalizeClass } from './carClass';
import {
  GARAGE_WRITE_KEY,
  projectSetting,
  projectSetupState,
  type SetupSetting,
  type SetupState,
} from './setupState';
import http from 'node:http';

/** One write in a batch. */
export interface SetupWrite {
  key: string;
  value: number;
}

/** Per-key outcome of a batch apply. */
export interface SetupWriteOutcome {
  key: string;
  ok: boolean;
  /** The clamped value actually posted, when a POST happened. */
  applied?: number;
  /** Why the key was skipped without a POST (locked, absent, unknown…). */
  skipped?: string;
  error?: string;
}

/** A macro apply is ~30 keys; 200 bounds even a pathological caller. */
const MAX_BATCH = 200;

export interface SetupControllerConfig {
  lmuApiPort?: number;
  verbose?: boolean;
}

/**
 * Reads and writes the car setup. Owns its (stateless) {@link MfdController} —
 * constructed from config rather than sharing the server's instance so the
 * Electron IPC path, where no overlay server may be running, builds one the
 * same way, and so the identity reads are guaranteed to hit the same port the
 * writes do.
 */
export class SetupController {
  private readonly mfd: MfdController;
  private readonly port: number;

  public constructor(config: SetupControllerConfig = {}) {
    this.mfd = new MfdController({ lmuApiPort: config.lmuApiPort, verbose: config.verbose });
    this.port = config.lmuApiPort ?? 6397;
  }

  /**
   * The full setup, fresh from the sim (~15 ms), plus the current car identity.
   * `connected: false` (never a throw) when LMU is closed or between sessions.
   */
  public async getState(): Promise<SetupState> {
    const [garage, identity] = await Promise.all([this.mfd.getGarageData(), this.identity()]);
    return projectSetupState(garage, identity.car, identity.carClass);
  }

  /**
   * Writes one setting: fresh read → reject locked/absent → clamp to the sim's
   * own bounds → POST → re-read that key so the caller gets the sim's wording
   * for what it now is, not our prediction of it.
   */
  public async setValue(
    key: string,
    value: number,
  ): Promise<MfdWriteResult & { setting?: SetupSetting; locked?: boolean }> {
    if (!GARAGE_WRITE_KEY.test(key)) {
      return { ok: false, status: 0, error: `illegal garage key: ${key}` };
    }
    const garage = await this.mfd.getGarageData();
    if (!garage) return { ok: false, status: 0, error: 'garage unavailable (not in a session?)' };
    const cur = projectSetting(key, garage[key]);
    if (!cur) return { ok: false, status: 0, error: `unknown setting: ${key}` };
    if (!cur.available) return { ok: false, status: 0, error: `${key} is not on this car` };
    if (!cur.isFree) {
      return { ok: false, status: 0, locked: true, error: `${key} is fixed by the ruleset` };
    }
    const clamped = Math.min(cur.max, Math.max(cur.min, Math.round(value)));
    const res = await this.mfd.postGarageValue(key, clamped);
    if (!res.ok) return res;

    // Read back the sim's own wording. Not optional polish: stringValue is the
    // only human-readable form these values have, and the panel shows it.
    const after = await this.mfd.getGarageData();
    const setting = after ? projectSetting(key, after[key]) : null;
    return {
      ...res,
      applied: setting ? setting.value : clamped,
      appliedText: setting ? setting.stringValue : undefined,
      ...(setting ? { setting } : {}),
    };
  }

  /**
   * Applies a macro's worth of writes, sequentially — LMU has no batch
   * endpoint, and firing 30 concurrent POSTs at a sim mid-frame is asking for
   * dropped writes. Skips (rather than fails on) locked and absent keys: a
   * macro is resolved against whatever car is in the garage, and "this car
   * doesn't have that" is an expected outcome, reported per key.
   */
  public async setBatch(
    writes: SetupWrite[],
  ): Promise<{ ok: boolean; results: SetupWriteOutcome[]; state: SetupState }> {
    const outcomes: SetupWriteOutcome[] = [];
    const list = Array.isArray(writes) ? writes.slice(0, MAX_BATCH) : [];

    const garage = await this.mfd.getGarageData();
    if (!garage) {
      return {
        ok: false,
        results: list.map((w) => ({ key: String(w?.key), ok: false, error: 'garage unavailable' })),
        state: projectSetupState(null),
      };
    }

    for (const w of list) {
      const key = String(w?.key ?? '');
      if (!GARAGE_WRITE_KEY.test(key) || typeof w.value !== 'number') {
        outcomes.push({ key, ok: false, skipped: 'illegal key or value' });
        continue;
      }
      const cur = projectSetting(key, garage[key]);
      if (!cur || !cur.available) {
        outcomes.push({ key, ok: false, skipped: 'not on this car' });
        continue;
      }
      if (!cur.isFree) {
        outcomes.push({ key, ok: false, skipped: 'fixed by ruleset' });
        continue;
      }
      const clamped = Math.min(cur.max, Math.max(cur.min, Math.round(w.value)));
      const res = await this.mfd.postGarageValue(key, clamped);
      outcomes.push(
        res.ok ? { key, ok: true, applied: clamped } : { key, ok: false, error: res.error },
      );
    }

    // One fresh read at the end — the caller repaints everything from this.
    const state = await this.getState();
    return { ok: outcomes.every((o) => o.ok || o.skipped !== undefined), results: outcomes, state };
  }

  /**
   * Who are we setting up? Class comes from the player's standings row (the
   * same source the provider trusts); the label falls back through team name
   * to driver name. Standings answer in a session only — in a menu both come
   * back blank, which the panel renders as such rather than guessing.
   */
  private async identity(): Promise<{ car: string; carClass: string }> {
    const rows = await this.getJson<
      Array<{ player?: boolean; carClass?: string; fullTeamName?: string; driverName?: string }>
    >('/rest/watch/standings');
    const me = Array.isArray(rows) ? rows.find((r) => r && r.player === true) : null;
    if (!me) return { car: '', carClass: '' };
    return {
      car: me.fullTeamName || me.driverName || '',
      carClass: normalizeClass(me.carClass) ?? '',
    };
  }

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
}
