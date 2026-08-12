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
import { RaceosLiveryClient } from './raceosLiveries';
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
  private readonly customLiveries: RaceosLiveryClient;

  public constructor(config: SetupControllerConfig = {}) {
    this.mfd = new MfdController({ lmuApiPort: config.lmuApiPort, verbose: config.verbose });
    this.port = config.lmuApiPort ?? 6397;
    this.customLiveries = new RaceosLiveryClient(this.port);
  }

  /**
   * The full setup, fresh from the sim (~15 ms), plus the current car identity
   * and session context (track + session type, for the library's labelling).
   * `connected: false` (never a throw) when LMU is closed or between sessions.
   */
  public async getState(): Promise<
    SetupState & {
      trackName?: string;
      trackFolder?: string;
      session?: string;
      carModel?: string;
      vehId?: string;
    }
  > {
    const [garage, identity, session, summary] = await Promise.all([
      this.mfd.getGarageData(),
      this.identity(),
      this.sessionInfo(),
      this.garageSummary(),
    ]);
    // The garage summary's car MODEL beats the standings row's team name for
    // the header; the team name is the fallback for sessions with no summary.
    const state = projectSetupState(garage, summary.carModel || identity.car, identity.carClass);
    return {
      ...state,
      trackName: session.trackName,
      // The sim's own Settings subfolder — the identity a published setup is
      // filed under, so "setups for where I am" can match on it rather than on
      // a display name that varies between layouts.
      trackFolder: summary.trackFolder ?? '',
      session: session.session,
      carModel: summary.carModel,
      vehId: summary.vehId,
    };
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

  /* ---- setup FILES (.svm) ------------------------------------------------
   *
   * Semantics read out of LMU's own UI bundle (Bin/UI.zip, app-*.js), which is
   * the authority on this API — and they are the reverse of the obvious guess:
   *
   *   saveSetup(folderAndName)   POST /rest/garage/setup     (raw text body)
   *   loadSetup(folderAndName)   PUT  /rest/garage/setup     (raw text body)
   *   deleteSetup(folderAndName) DELETE /rest/garage/setup/<encodeURI(name)>
   *   refreshSetups()            POST /rest/garage/refreshsetups  (json null)
   *
   * `folderAndName` is the track-folder-relative name without extension, e.g.
   * "Spa\\MY RACE TUNE". A LOAD of a name that does not exist returns 200 and
   * does nothing — success alone proves nothing, always verify the effect.
   */

  /** Saves the sim's CURRENT garage setup to `<Settings>/<folderAndName>.svm`. */
  public saveSetupFile(folderAndName: string): Promise<MfdWriteResult> {
    return this.text('POST', '/rest/garage/setup', folderAndName);
  }

  /** Loads a saved setup into the live garage — replaces the current setup. */
  public loadSetupFile(folderAndName: string): Promise<MfdWriteResult> {
    return this.text('PUT', '/rest/garage/setup', folderAndName);
  }

  /** Deletes a saved setup file from the sim's Settings tree. */
  public deleteSetupFile(folderAndName: string): Promise<MfdWriteResult> {
    return this.text('DELETE', `/rest/garage/setup/${encodeURI(folderAndName)}`);
  }

  /** Tells the sim to re-scan its Settings tree (after we add a file to it). */
  public refreshSetupFiles(): Promise<MfdWriteResult> {
    return this.text('POST', '/rest/garage/refreshsetups', 'null', 'application/json');
  }

  /** The sim's own setup-file list: `{ name: "Track\\File", created, … }[]`. */
  public listSetupFiles(): Promise<Array<{ name?: string }> | null> {
    return this.getJson<Array<{ name?: string }>>('/rest/garage/setup');
  }

  /**
   * The garage summary — the sim's OWN statement of which Settings subfolder
   * the current track saves under, plus the real car identity. This is the
   * same source the game's save dialog uses (`setupSummary.currentTrackFolder`
   * in its UI bundle). An earlier heuristic — the bare "Folder\\" entry in the
   * setups list — was proven wrong live: it returned Bahrain during a Spa
   * session, and the sim will happily save into whatever wrong folder it is
   * told, where the game's setup screen for the actual track never looks.
   */
  public async garageSummary(): Promise<{
    trackFolder: string | null;
    carModel: string;
    /** The .VEH file's base name — the game keys its car artwork by this. */
    vehId: string;
    unsavedChanges: boolean;
  }> {
    const s = await this.getJson<{
      currentTrackFolder?: string;
      unsavedChanges?: boolean;
      car?: { fullPathTree?: string; vehFile?: string };
    }>('/rest/garage/summary');
    const folder = s?.currentTrackFolder;
    const tree = s?.car?.fullPathTree ?? '';
    // "WEC 2025, GT3, Lexus RCF LMGT3" — the last segment is the car model.
    const carModel = tree.includes(',') ? tree.split(',').pop()!.trim() : tree.trim();
    const vehFile = s?.car?.vehFile ?? '';
    const vehBase = vehFile.split('\\').pop() ?? '';
    const vehId = vehBase.includes('.') ? vehBase.slice(0, vehBase.lastIndexOf('.')) : vehBase;
    return {
      trackFolder: typeof folder === 'string' && folder.length > 0 ? folder : null,
      carModel,
      vehId,
      unsavedChanges: s?.unsavedChanges === true,
    };
  }

  /**
   * The current car's 3/4 render, in ITS OWN LIVERY. A CUSTOM paint wins when
   * the player has one for this .VEH id — the game keeps no rendered image of
   * those anywhere local, so it comes from raceos.gg (see raceosLiveries.ts).
   * Everything else — every stock livery — is the game's static image set,
   * `/start/images/cars/FrontLarge/<vehId>_frontAngle.webp`, the exact artwork
   * the livery-selector shows (recipe read from the game UI's own
   * `getCarImageLarge`); falls back to the smaller variant, then null.
   * The `/rest/race/car/<id>/image` REST route is NOT used: it 400s/404s for
   * the current car even with the UI's `?type=` parameter.
   *
   * `key` is what the render is cached by: the S3 URI for a custom paint (it
   * embeds the upload timestamp, so a re-painted livery is a new key), the
   * vehId for stock art (static per livery, so the id alone is enough).
   */
  public async carImage(): Promise<{ vehId: string; key: string; webp: Buffer } | null> {
    const { vehId } = await this.garageSummary();
    if (!vehId) return null;
    const custom = await this.customLiveries.frontAngle(vehId);
    if (custom) return { vehId, key: custom.uri, webp: custom.webp };
    for (const p of [
      `/start/images/cars/FrontLarge/${encodeURIComponent(vehId)}_frontAngle.webp`,
      `/start/images/cars/${encodeURIComponent(vehId)}_frontAngle.webp`,
    ]) {
      const webp = await this.getBytes(p);
      if (webp && webp.length > 0) return { vehId, key: vehId, webp };
    }
    return null;
  }

  /** The Settings subfolder the CURRENT track's setups live under. */
  public async currentTrackFolder(): Promise<string | null> {
    return (await this.garageSummary()).trackFolder;
  }

  /** Track and session type of the live session, for categorising a save. */
  public async sessionInfo(): Promise<{ trackName: string; session: string }> {
    const si = await this.getJson<{ trackName?: string; session?: string }>(
      '/rest/watch/sessionInfo',
    );
    return { trackName: si?.trackName ?? '', session: si?.session ?? '' };
  }

  /** Public face of identity(), for callers labelling a saved setup. */
  public getIdentity(): Promise<{ car: string; carClass: string }> {
    return this.identity();
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

  /**
   * A raw-body request, matching the game UI's postText/putText/del helpers.
   * The setup-file routes take the name as PLAIN TEXT — JSON-quoting it makes
   * the sim look for a file with quotes in its name, which "succeeds" (200)
   * and does nothing.
   */
  private text(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: string,
    contentType = 'text/plain',
  ): Promise<MfdWriteResult> {
    return new Promise<MfdWriteResult>((resolve) => {
      const payload = body === undefined ? null : Buffer.from(body, 'utf8');
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path,
          method,
          timeout: 4000,
          headers: payload
            ? { 'Content-Type': contentType, 'Content-Length': payload.length }
            : {},
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume();
          res.on('end', () => {
            const ok = status >= 200 && status < 300;
            resolve(ok ? { ok, status } : { ok, status, error: `HTTP ${status}` });
          });
        },
      );
      req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** A binary GET (the car artwork). Null on any non-200 or error. */
  private getBytes(path: string): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path, timeout: 4000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => req.destroy());
    });
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
