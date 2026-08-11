/**
 * @file src/telemetry/setupLibrary.ts
 * @module telemetry/setupLibrary
 *
 * The app-owned setup library: named, colour-tagged, filterable copies of real
 * `.svm` files, living OUTSIDE the sim's Settings tree so LMU can never
 * rename, prune or overwrite them. The sim is only touched at the two
 * endpoints of a transaction:
 *
 *   SAVE  — the sim itself writes the .svm (POST /rest/garage/setup into the
 *           current track's folder, under a temporary APEX name), we copy the
 *           file into the library with its metadata, then delete the temp from
 *           the sim. The sim is the ONLY thing that can author a correct .svm
 *           — its header carries the vehicle-class line and upgrade tuple we
 *           could not invent — so "save" is really "ask the sim, then archive".
 *   LOAD  — the library file is copied INTO the current track's folder (under
 *           its library name, "APEX <name>"), the sim re-scans
 *           (refreshsetups), then loads it (PUT /rest/garage/setup). The file
 *           is left in place afterwards: it is now also loadable from the
 *           game's own setup screen, which is a feature, not a leak.
 *
 * Sharing is file-based by design: export hands out the raw .svm (playable by
 * ANY LMU install, app or no app) plus its metadata in a sidecar comment;
 * import takes a .svm from anywhere and files it under the library.
 *
 * Everything here is synchronous fs + the injected SetupController — no
 * timers, no watchers. The library costs nothing until a call arrives.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SetupController } from './setupControl';

/** One saved setup. */
export interface SetupLibraryEntry {
  id: string;
  /** Display name, user-given ("Spa race — low drag"). */
  name: string;
  /** Sim Settings subfolder it belongs to ("Spa"). */
  trackFolder: string;
  /** Pretty session track name at save time ("Circuit de Spa-Francorchamps"). */
  trackName: string;
  /** Team/entry label at save time. */
  car: string;
  /** Normalised class (GT3, HYPERCAR, …). */
  carClass: string;
  /** The .svm header's VehicleClassSetting line — the compat check for loads. */
  vehicleClass: string;
  sessionType: '' | 'race' | 'quali';
  /** Palette slug ('', 'red', 'amber', 'green', 'cyan', 'purple', 'pink'). */
  color: string;
  notes: string;
  savedAt: string;
  /** File name inside the library's files/ dir. */
  fileName: string;
}

export interface SetupLibraryResult {
  ok: boolean;
  error?: string;
  entry?: SetupLibraryEntry;
}

const COLORS = new Set(['', 'red', 'amber', 'green', 'cyan', 'purple', 'pink']);
const SESSIONS = new Set(['', 'race', 'quali']);

/** Strip anything a filename or the sim could choke on; keep it readable. */
function sanitizeName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'Unnamed setup'
  );
}

/** The .svm header's vehicle line, e.g. `GT3 Porsche_911_GT3_R_LMGT3 WEC2024`. */
function readVehicleClassLine(svmText: string): string {
  const m = /^VehicleClassSetting="([^"]*)"/m.exec(svmText);
  return m ? m[1]! : '';
}

export class SetupLibrary {
  private readonly filesDir: string;
  private readonly indexFile: string;
  private readonly controller: SetupController;
  private readonly settingsDir: string | null;

  /**
   * @param dir app-owned storage root (e.g. `<userData>/setups`)
   * @param controller the REST client for the sim half of save/load
   * @param settingsDir LMU's `UserData/player/Settings`, or null when no
   *   install was found — the library still lists/exports/imports without it.
   */
  public constructor(dir: string, controller: SetupController, settingsDir: string | null) {
    this.filesDir = path.join(dir, 'files');
    this.indexFile = path.join(dir, 'library.json');
    this.controller = controller;
    this.settingsDir = settingsDir;
    fs.mkdirSync(this.filesDir, { recursive: true });
  }

  /* ------------------------------ index I/O ------------------------------ */

  public list(): SetupLibraryEntry[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      return Array.isArray(raw) ? (raw as SetupLibraryEntry[]) : [];
    } catch {
      return [];
    }
  }

  private write(entries: SetupLibraryEntry[]): void {
    fs.writeFileSync(this.indexFile, JSON.stringify(entries, null, 1));
  }

  private fileOf(entry: SetupLibraryEntry): string {
    return path.join(this.filesDir, entry.fileName);
  }

  /* ------------------------------- save ---------------------------------- */

  /**
   * Archives the sim's CURRENT garage setup into the library. The sim writes
   * the file (it alone knows the full .svm truth), we copy and clean up.
   */
  public async saveCurrent(meta: {
    name: string;
    sessionType?: string;
    color?: string;
    notes?: string;
  }): Promise<SetupLibraryResult> {
    if (!this.settingsDir) return { ok: false, error: 'LMU install not found' };
    const folder = await this.controller.currentTrackFolder();
    if (!folder) return { ok: false, error: 'not in a garage (no active track folder)' };

    const id = randomBytes(6).toString('hex');
    const tempBase = `APEXTMP_${id}`;
    const saved = await this.controller.saveSetupFile(`${folder}\\${tempBase}`);
    if (!saved.ok) return { ok: false, error: saved.error ?? 'sim refused the save' };

    // The sim writes synchronously with the 200 in every observation, but give
    // a short grace before declaring failure.
    const simFile = path.join(this.settingsDir, folder, `${tempBase}.svm`);
    for (let i = 0; i < 10 && !fs.existsSync(simFile); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!fs.existsSync(simFile)) {
      return { ok: false, error: 'sim reported OK but wrote no file' };
    }

    const svmText = fs.readFileSync(simFile, 'utf8');
    const [identity, session, summary] = await Promise.all([
      this.controller.getIdentity(),
      this.controller.sessionInfo(),
      this.controller.garageSummary(),
    ]);

    const entry: SetupLibraryEntry = {
      id,
      name: sanitizeName(meta.name),
      trackFolder: folder,
      trackName: session.trackName,
      // The garage summary's car MODEL ("Lexus RCF LMGT3") over the standings
      // row's team name — a library is about cars, not entries.
      car: summary.carModel || identity.car,
      carClass: identity.carClass,
      vehicleClass: readVehicleClassLine(svmText),
      sessionType: SESSIONS.has(meta.sessionType ?? '') ? (meta.sessionType as SetupLibraryEntry['sessionType']) : '',
      color: COLORS.has(meta.color ?? '') ? (meta.color as string) : '',
      notes: String(meta.notes ?? '').slice(0, 500),
      savedAt: new Date().toISOString(),
      fileName: `${id}.svm`,
    };
    fs.copyFileSync(simFile, this.fileOf(entry));

    // Tidy the sim: the temp name would otherwise pile up in its setup screen.
    // Deleting via the API (not fs) keeps the sim's cache honest; failure is
    // cosmetic, so it is not allowed to fail the save.
    await this.controller.deleteSetupFile(`${folder}\\${tempBase}`);

    this.write([entry, ...this.list()]);
    return { ok: true, entry };
  }

  /* -------------------------------- load --------------------------------- */

  /**
   * Loads a library entry into the live garage. Copies the file into the
   * CURRENT track's folder — the sim only lists setups for the loaded track —
   * under its readable library name, re-scans, then loads.
   */
  public async load(id: string): Promise<SetupLibraryResult & { folderAndName?: string }> {
    if (!this.settingsDir) return { ok: false, error: 'LMU install not found' };
    const entry = this.list().find((e) => e.id === id);
    if (!entry) return { ok: false, error: 'setup not in library' };
    if (!fs.existsSync(this.fileOf(entry))) return { ok: false, error: 'library file missing' };

    const folder = await this.controller.currentTrackFolder();
    if (!folder) return { ok: false, error: 'not in a garage (no active track folder)' };

    const base = sanitizeName(`APEX ${entry.name}`);
    const dest = path.join(this.settingsDir, folder, `${base}.svm`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(this.fileOf(entry), dest);

    const refreshed = await this.controller.refreshSetupFiles();
    if (!refreshed.ok) return { ok: false, error: 'sim did not re-scan its setups' };
    const loaded = await this.controller.loadSetupFile(`${folder}\\${base}`);
    if (!loaded.ok) return { ok: false, error: loaded.error ?? 'sim refused the load' };
    return { ok: true, entry, folderAndName: `${folder}\\${base}` };
  }

  /* ------------------------- edit / delete / share ------------------------ */

  public update(
    id: string,
    patch: Partial<Pick<SetupLibraryEntry, 'name' | 'sessionType' | 'color' | 'notes'>>,
  ): SetupLibraryResult {
    const entries = this.list();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return { ok: false, error: 'setup not in library' };
    if (patch.name !== undefined) entry.name = sanitizeName(patch.name);
    if (patch.sessionType !== undefined && SESSIONS.has(patch.sessionType)) {
      entry.sessionType = patch.sessionType;
    }
    if (patch.color !== undefined && COLORS.has(patch.color)) entry.color = patch.color;
    if (patch.notes !== undefined) entry.notes = String(patch.notes).slice(0, 500);
    this.write(entries);
    return { ok: true, entry };
  }

  public remove(id: string): SetupLibraryResult {
    const entries = this.list();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return { ok: false, error: 'setup not in library' };
    try {
      fs.rmSync(this.fileOf(entry), { force: true });
    } catch {
      /* the index is the authority; a stubborn file is an orphan, not a block */
    }
    this.write(entries.filter((e) => e.id !== id));
    return { ok: true, entry };
  }

  /** Copies the raw .svm out — the share artifact any LMU player can use. */
  public exportTo(id: string, destPath: string): SetupLibraryResult {
    const entry = this.list().find((e) => e.id === id);
    if (!entry) return { ok: false, error: 'setup not in library' };
    fs.copyFileSync(this.fileOf(entry), destPath);
    return { ok: true, entry };
  }

  /**
   * Files a .svm from anywhere (a fellow racer, the sim's own folders) under
   * the library. Track/car metadata comes from the caller where the file
   * cannot say — the .svm header only knows its vehicle-class line.
   */
  public importFrom(
    srcPath: string,
    meta: { name?: string; trackFolder?: string; trackName?: string; sessionType?: string; color?: string },
  ): SetupLibraryResult {
    let svmText: string;
    try {
      svmText = fs.readFileSync(srcPath, 'utf8');
    } catch (err) {
      return { ok: false, error: `cannot read file: ${(err as Error).message}` };
    }
    if (!/^\[GENERAL\]$/m.test(svmText) && !/Setting=/.test(svmText)) {
      return { ok: false, error: 'not a setup (.svm) file' };
    }
    const id = randomBytes(6).toString('hex');
    const entry: SetupLibraryEntry = {
      id,
      name: sanitizeName(meta.name || path.basename(srcPath, path.extname(srcPath))),
      trackFolder: String(meta.trackFolder ?? ''),
      trackName: String(meta.trackName ?? ''),
      car: '',
      carClass: '',
      vehicleClass: readVehicleClassLine(svmText),
      sessionType: SESSIONS.has(meta.sessionType ?? '') ? (meta.sessionType as SetupLibraryEntry['sessionType']) : '',
      color: COLORS.has(meta.color ?? '') ? (meta.color as string) : '',
      notes: '',
      savedAt: new Date().toISOString(),
      fileName: `${id}.svm`,
    };
    fs.writeFileSync(this.fileOf(entry), svmText);
    this.write([entry, ...this.list()]);
    return { ok: true, entry };
  }
}
