/**
 * cornerCatalog.ts — stable corners per layout: the catalogue files, and the
 * corners a lap is measured by.
 * -----------------------------------------------------------------------------
 * Practice used to number C1..Cn off whichever lap was the reference, and
 * `findCorners()` on one lap is not stable (Road Atlanta 9–12 corners lap to
 * lap, Le Mans 20–27), so "C5" meant a different corner from one session to
 * the next. The fix is a catalogue per layout, `data/corners/<mapKey>.json`
 * (a `CornerCatalog`, see `coachContract.ts`), voted for offline by every
 * clean dry lap of the layout — `scripts/build-corner-catalog.js`, which says
 * how the vote works and which layouts have one.
 *
 * The catalogue SHIPS with the app, exactly like the bundled track maps
 * (`trackMap.ts builtinTrackMapDir`): `data/**` is in the installer's `files`,
 * inside `app.asar`, which Electron's `fs` reads through. There is no
 * per-machine copy — the numbering has to be the same for every driver.
 *
 * {@link cornersForLap} is what every surface that numbers corners uses (the
 * live Corner Analysis via the ghost, the Practice debrief and lap deep dive,
 * the coach): with a catalogue, the reference lap's own corners snapped onto
 * it (`cornerCatalogSnap.ts`); without one, the reference's own corners,
 * C1..Cn, as before.
 *
 * The snapping is pure and lives in `cornerCatalogSnap.ts`; this module adds
 * only the file reads. A loaded catalogue is remembered per key (they are a
 * few KB, read at most once per layout per run). The ghost's load path runs
 * on the frame loop's process and must never read synchronously
 * (`scripts/test-ghoststore.js` holds it to that), so it uses
 * {@link loadCornerCatalogAsync}; the review loaders, which already read
 * synchronously off an IPC call, use {@link loadCornerCatalog}.
 */

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { CornerTrace } from './corners';
import type { CornerCatalog } from './coachContract';
import { catalogCorners } from './cornerCatalogSnap';
import { trackKey } from './trackMap';

export { catalogCorners, snapToCatalog, SNAP_M, type IdCorner } from './cornerCatalogSnap';

/** The build note `scripts/build-corner-catalog.js` writes beside the contract fields. */
export interface CornerCatalogBuild {
  /** Build date, YYYY-MM-DD. */
  at: string;
  tool: string;
  laps: number;
  local: number;
  cloud: number;
  /** How the laps were cut: by their driven line, or by a line dead-reckoned from lateral G. */
  cutBy: { line: number; latG: number };
  classes: Record<string, number>;
  /** Share of laps each corner was seen in, catalogue order. */
  support: number[];
}

/** A catalogue as the file holds it. */
export interface CornerCatalogFile extends CornerCatalog {
  built?: CornerCatalogBuild;
}

/**
 * Directory holding the shipped catalogues. The candidates `builtinTrackMapDir`
 * uses, for the same three ways this module is loaded (`npm start`, `electron .`
 * from a clone, the installed app); `APEX_CORNER_CATALOG_DIR` overrides.
 * Resolved once.
 */
export function builtinCornerCatalogDir(): string | null {
  if (builtinDir !== undefined) return builtinDir;
  builtinDir = null;
  for (const c of candidateDirs()) {
    try {
      if (fs.statSync(c).isDirectory()) {
        builtinDir = c;
        break;
      }
    } catch {
      /* next candidate */
    }
  }
  return builtinDir;
}
let builtinDir: string | null | undefined;

const cache = new Map<string, CornerCatalogFile | null>();

/** Forget the resolved directory and every loaded catalogue — for tests. */
export function resetCornerCatalogCache(): void {
  builtinDir = undefined;
  cache.clear();
}

/** The file a map key's catalogue lives in, under `base`. */
const fileOf = (base: string, mapKey: string): string =>
  path.join(base, `${mapKey.replace(/[^a-z0-9._-]+/gi, '_')}.json`);

/** The shipped-directory candidates, best first (see {@link builtinCornerCatalogDir}). */
function candidateDirs(): string[] {
  const override = (process.env.APEX_CORNER_CATALOG_DIR ?? '').trim();
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return [
    ...(override ? [override] : []),
    path.join(__dirname, '..', '..', 'data', 'corners'),
    ...(resources ? [path.join(resources, 'data', 'corners')] : []),
    path.join(process.cwd(), 'data', 'corners'),
  ];
}

/**
 * {@link loadCornerCatalog} without a single synchronous call: the shipped
 * directory is found with `fs.promises.stat` rather than `statSync`, and
 * remembered for both loaders.
 */
export async function loadCornerCatalogAsync(mapKey: string, dir?: string): Promise<CornerCatalog | null> {
  if (!mapKey) return null;
  const memo = `async|${dir ?? ''}|${mapKey}`;
  if (dir === undefined && cache.has(memo)) return cache.get(memo)!;
  let base: string | null = dir ?? null;
  if (dir === undefined) {
    if (builtinDir === undefined) {
      let found: string | null = null;
      for (const c of candidateDirs()) {
        try {
          if ((await fsp.stat(c)).isDirectory()) {
            found = c;
            break;
          }
        } catch {
          /* next candidate */
        }
      }
      if (builtinDir === undefined) builtinDir = found;
    }
    base = builtinDir;
  }
  let out: CornerCatalogFile | null = null;
  if (base) {
    try {
      out = validCatalog(JSON.parse(await fsp.readFile(fileOf(base, mapKey), 'utf8')), mapKey);
    } catch {
      out = null;
    }
  }
  if (dir === undefined) cache.set(memo, out);
  return out;
}

/** The catalogue for a map key, or null when the layout has none. */
export function loadCornerCatalog(mapKey: string, dir?: string): CornerCatalog | null {
  if (!mapKey) return null;
  const base = dir ?? builtinCornerCatalogDir();
  if (!base) return null;
  const file = fileOf(base, mapKey);
  // Only the shipped directory is remembered: it cannot change under a run,
  // while a directory a caller names (the tests) may.
  if (dir === undefined && cache.has(file)) return cache.get(file)!;
  let out: CornerCatalogFile | null = null;
  try {
    out = validCatalog(JSON.parse(fs.readFileSync(file, 'utf8')), mapKey);
  } catch {
    out = null;
  }
  if (dir === undefined) cache.set(file, out);
  return out;
}

/** The catalogue for the layout a session or lap was driven on (`lapDetail.mapKeyForLap`'s key). */
export function catalogForTrack(
  t: { track?: string; trackConfig?: string; trackLengthM?: number },
  dir?: string,
): CornerCatalog | null {
  const L = Number(t.trackLengthM) || 0;
  if (!(L > 0)) return null;
  return loadCornerCatalog(trackKey(t.track || '', t.trackConfig, L), dir);
}

/**
 * A file fit to number corners by, or null. A catalogue that would number
 * wrongly is worse than none (the reference's own corners are honest), so
 * anything off — ids out of order, a corner inside out, neighbours that
 * overlap, another layout's key — refuses the whole file.
 */
function validCatalog(v: unknown, mapKey: string): CornerCatalogFile | null {
  const c = v as CornerCatalogFile;
  if (!c || typeof c !== 'object' || c.mapKey !== mapKey) return null;
  if (!(Number(c.trackLengthM) > 0) || !Array.isArray(c.corners) || c.corners.length === 0) return null;
  const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  for (let k = 0; k < c.corners.length; k += 1) {
    const cc = c.corners[k]!;
    if (!cc || cc.id !== `C${k + 1}`) return null;
    if (!fin(cc.entryD) || !fin(cc.apexD) || !fin(cc.exitD)) return null;
    if (!(cc.entryD >= 0 && cc.entryD < cc.apexD && cc.apexD < cc.exitD && cc.exitD <= 1)) return null;
    if (k > 0 && cc.entryD < c.corners[k - 1]!.exitD) return null;
    if (cc.dir !== 'L' && cc.dir !== 'R' && cc.dir !== null) return null;
  }
  if (!Array.isArray(c.sequences)) c.sequences = [];
  return c;
}

export interface CornerSpan {
  id: string;
  entryD: number;
  apexD: number;
  exitD: number;
}

/**
 * The corners to measure a lap by: the catalogue's when there is one, else the reference's own.
 *
 * `catalog` may be passed (an already-loaded catalogue, or `null` for "none")
 * to skip the file read; otherwise it is loaded by `mapKey` from `dir` or the
 * shipped directory.
 */
export function cornersForLap(opts: {
  mapKey: string | null;
  trackLengthM: number;
  ref: CornerTrace;
  dir?: string;
  catalog?: CornerCatalog | null;
}): { corners: CornerSpan[]; source: 'catalog' | 'reference'; catalog: CornerCatalog | null } {
  const catalog =
    opts.catalog !== undefined ? opts.catalog : opts.mapKey ? loadCornerCatalog(opts.mapKey, opts.dir) : null;
  const cs = catalogCorners(opts.ref, opts.trackLengthM, catalog);
  return {
    corners: cs.map((c) => ({ id: c.id, entryD: c.entryD, apexD: c.apexD, exitD: c.exitD })),
    source: catalog ? 'catalog' : 'reference',
    catalog,
  };
}
