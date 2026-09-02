/**
 * @file src/telemetry/setupLibrary.ts
 * @module telemetry/setupLibrary
 *
 * The app-owned setup library: named, colour-tagged, filterable copies of real
 * `.svm` files, living OUTSIDE the sim's Settings tree so LMU can never
 * rename, prune or overwrite them. The sim is only touched at the two
 * endpoints of a transaction:
 *
 *   SAVE — the sim itself writes the .svm (POST /rest/garage/setup into the
 *   current track's folder, under a temporary APEX name), we copy the file
 *   into the library with its metadata, then delete the temp from the sim.
 *   The sim is the ONLY thing that can author a correct .svm — its header
 *   carries the vehicle-class line and upgrade tuple we could not invent — so
 *   "save" is really "ask the sim, then archive".
 *
 * LOADING is not here any more, on purpose. The whole-file API load (PUT
 * /rest/garage/setup) changes the garage state but LMU's own setup SCREEN
 * does not repaint for it — only the game UI's own load button refreshes its
 * queries — so an app-driven load looked like nothing happened (reported
 * live, 2026-08-11). Instead every entry carries its VALUES in REST key space
 * (parsed via svmMap), the panel stages them like a macro, and Apply writes
 * them key-by-key — the path that provably repaints the game's screen.
 *
 * INSTALLING is the third endpoint, added after drivers reported the app
 * "eating" their setup: installToSim() drops the archived .svm into the sim's
 * own `Settings/<trackFolder>/` so it appears under the pit garage's custom
 * setups for that car and track, leaving the live garage alone. Staging is
 * still there for anyone who wants the editor preview, but it is no longer
 * what a shared setup does by default.
 *
 * Sharing is file-based by design: export hands out the raw .svm (playable by
 * ANY LMU install, app or no app); import takes a .svm from anywhere.
 *
 * Everything here is synchronous fs + the injected SetupController — no
 * timers, no watchers. The library costs nothing until a call arrives.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SetupController } from './setupControl';
import { parseSvmValues } from './svmMap';

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
  /**
   * The tune in REST key space (VM_/WM_ key → step index) — what the panel
   * stages when the driver hits Load. Parsed from the .svm; entries from
   * before this field existed are backfilled on the next list().
   */
  values?: Record<string, number>;
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
    let entries: SetupLibraryEntry[];
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      entries = Array.isArray(raw) ? (raw as SetupLibraryEntry[]) : [];
    } catch {
      return [];
    }
    // Backfill: entries saved before `values` existed (or imported before the
    // parser) get their tune parsed out of the archived .svm, once, persisted.
    let changed = false;
    for (const e of entries) {
      if (e.values) continue;
      try {
        const parsed = parseSvmValues(fs.readFileSync(this.fileOf(e), 'utf8'));
        e.values = parsed.values;
        if (!e.vehicleClass) e.vehicleClass = parsed.vehicleClass;
        changed = true;
      } catch {
        /* file missing or unreadable — the row renders, Load stays inert */
      }
    }
    if (changed) this.write(entries);
    return entries;
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
    const parsed = parseSvmValues(svmText);
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
      vehicleClass: parsed.vehicleClass,
      sessionType: SESSIONS.has(meta.sessionType ?? '') ? (meta.sessionType as SetupLibraryEntry['sessionType']) : '',
      color: COLORS.has(meta.color ?? '') ? (meta.color as string) : '',
      notes: String(meta.notes ?? '').slice(0, 500),
      savedAt: new Date().toISOString(),
      fileName: `${id}.svm`,
      values: parsed.values,
    };
    fs.copyFileSync(simFile, this.fileOf(entry));

    // Tidy the sim: the temp name would otherwise pile up in its setup screen.
    // Deleting via the API (not fs) keeps the sim's cache honest; failure is
    // cosmetic, so it is not allowed to fail the save.
    await this.controller.deleteSetupFile(`${folder}\\${tempBase}`);

    this.write([entry, ...this.list()]);
    return { ok: true, entry };
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

  /* ---------------------------- install to sim --------------------------- */

  /**
   * Writes the entry's .svm into LMU's own `Settings/<trackFolder>/` so it
   * turns up under the pit garage's custom setups for that car and track —
   * WITHOUT touching the setup currently on the car.
   *
   * This is the counterpart to staging: staging edits the live garage (and so
   * lands on top of whatever the driver was running, which read as the app
   * eating their setup); this hands the file to the sim and lets the driver
   * choose it in the game's own screen, which is where they expect a "custom
   * setup" to live.
   *
   * The name is kept readable and collision-safe — an existing file with the
   * same name is never overwritten, because it may well be the driver's own
   * work. `refreshsetups` makes a RUNNING sim rescan; a closed one rescans on
   * launch anyway, so that poke is allowed to fail.
   */
  public async installToSim(
    id: string,
  ): Promise<SetupLibraryResult & { inGameName?: string; trackFolder?: string }> {
    const entry = this.list().find((e) => e.id === id);
    if (!entry) return { ok: false, error: 'setup not in library' };
    let svmText: string;
    try {
      svmText = fs.readFileSync(this.fileOf(entry), 'utf8');
    } catch (err) {
      return { ok: false, error: `cannot read the saved file: ${(err as Error).message}` };
    }
    const res = this.writeIntoSim(
      svmText,
      entry.name,
      entry.trackFolder || (await this.controller.currentTrackFolder()) || '',
    );
    if (!res.ok) return res;
    await this.pokeSim();
    return { ok: true, entry, inGameName: res.inGameName, trackFolder: res.trackFolder };
  }

  /**
   * The raw half of installToSim, for callers holding .svm text that is not in
   * the library yet (the community download stages its file and imports it in
   * the same breath). Synchronous: no sim call, just the file drop.
   */
  public writeIntoSim(
    svmText: string,
    name: string,
    trackFolder: string,
  ): SetupLibraryResult & { inGameName?: string; trackFolder?: string } {
    if (!this.settingsDir) return { ok: false, error: 'LMU install not found' };
    if (!trackFolder) return { ok: false, error: 'no track folder — enter the garage first' };
    const dir = path.join(this.settingsDir, trackFolder);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const base = sanitizeName(name);
      let inGameName = base;
      // Never clobber a file already sitting in the sim's folder: it could be
      // the driver's own tune under the same name. Suffix instead.
      for (let n = 2; fs.existsSync(path.join(dir, `${inGameName}.svm`)) && n < 100; n++) {
        inGameName = `${base} (${n})`;
      }
      fs.writeFileSync(path.join(dir, `${inGameName}.svm`), svmText);
      return { ok: true, inGameName, trackFolder };
    } catch (err) {
      return { ok: false, error: `could not write into the sim: ${(err as Error).message}` };
    }
  }

  /** Ask a running sim to rescan its setup folder. Never fatal. */
  public async pokeSim(): Promise<void> {
    try {
      await this.controller.refreshSetupFiles();
    } catch {
      /* sim not running — it rescans on launch */
    }
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
    const parsed = parseSvmValues(svmText);
    const id = randomBytes(6).toString('hex');
    // The class is readable from the header's vehicle line ("GT3 Porsche_911…"
    // starts with the class token), so a shared file arrives pre-categorised.
    const classToken = (parsed.vehicleClass.split(/\s+/)[0] ?? '').toUpperCase();
    const entry: SetupLibraryEntry = {
      id,
      name: sanitizeName(meta.name || path.basename(srcPath, path.extname(srcPath))),
      trackFolder: String(meta.trackFolder ?? ''),
      trackName: String(meta.trackName ?? ''),
      car: '',
      carClass: classToken,
      vehicleClass: parsed.vehicleClass,
      sessionType: SESSIONS.has(meta.sessionType ?? '') ? (meta.sessionType as SetupLibraryEntry['sessionType']) : '',
      color: COLORS.has(meta.color ?? '') ? (meta.color as string) : '',
      notes: '',
      savedAt: new Date().toISOString(),
      fileName: `${id}.svm`,
      values: parsed.values,
    };
    fs.writeFileSync(this.fileOf(entry), svmText);
    this.write([entry, ...this.list()]);
    return { ok: true, entry };
  }
}
