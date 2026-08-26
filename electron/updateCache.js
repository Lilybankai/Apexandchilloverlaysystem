/**
 * electron/updateCache.js — the updater's log, and its disk footprint.
 * -----------------------------------------------------------------------------
 * Two jobs, both of them about the ~288 MB installer this app ships.
 *
 * ## 1. A log
 * electron-updater decides, silently, whether to download a whole installer or
 * to rebuild it from the copy already on disk plus the few megabytes that
 * changed. Measured on two consecutive betas, the differential path moves
 * **10.7 MB instead of 287.5 MB** — but when it cannot (no base file, a missing
 * blockmap, a range request the CDN refuses) it logs
 * `Cannot download differentially, fallback to full download` and quietly
 * transfers the lot. With no logger attached that line has nowhere to land, so
 * nobody can tell a 96% saving from a 0% one; both look like "an update
 * arrived". This wires a small file logger so the answer is on disk.
 *
 * Deliberately not electron-log: this app has two runtime dependencies and the
 * whole requirement is "append lines to a file that cannot grow without bound".
 *
 * ## 2. The pending installer
 * The cache holds up to two full copies of the installer:
 *
 *   <cache>/installer.exe                 the base for the NEXT differential
 *   <cache>/pending/<Setup-x.y.z>.exe     the one waiting to be run
 *
 * The first has to stay — delete it and every future update is a full download.
 * The second is dead weight the moment its installer has actually run, but
 * electron-updater only clears `pending/` at the START of the next download, so
 * it sits there for however long that is. On a tester's machine that is 287 MB
 * of nothing, and it is why the app appears to "leave a new exe behind" after
 * every update.
 *
 * `reclaimPending()` deletes it once — and only once — the version it would
 * install is the version already running. That check is the whole safety
 * argument: an update that is downloaded and still waiting is never touched,
 * because `autoInstallOnAppQuit` will need it on the way out.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Roll the log at 256 KB. Two files, so a rotation never loses the present. */
const MAX_LOG_BYTES = 256 * 1024;

/**
 * Where electron-updater keeps its cache, derived the way electron-updater
 * derives it: `%LOCALAPPDATA%` + the `updaterCacheDirName` that electron-builder
 * wrote into `resources/app-update.yml`. Read from that file rather than
 * assumed, because the name is the package name (`apex-overlay-system`) and NOT
 * the product name — the app was renamed and the cache dir was not, so a guess
 * from either name has a 50% chance of pointing at an empty directory and
 * silently doing nothing. See the app-rename note in electron/main.js.
 *
 * Returns null when it cannot be determined (a dev run, an unpackaged tree),
 * which every caller treats as "nothing to do".
 */
function cacheDir(app) {
  try {
    if (!app.isPackaged) return null;
    const ymlPath = path.join(process.resourcesPath, 'app-update.yml');
    const yml = fs.readFileSync(ymlPath, 'utf8');
    // One flat scalar out of a tiny generated file — a YAML parser would be a
    // third dependency for a line that electron-builder writes unquoted.
    const m = /^updaterCacheDirName:\s*(\S+)\s*$/m.exec(yml);
    const dirName = m ? m[1] : app.getName();
    const base =
      process.platform === 'win32'
        ? process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
        : app.getPath('cache');
    return path.join(base, dirName);
  } catch {
    return null;
  }
}

/**
 * A logger shaped the way electron-updater expects (`info`/`warn`/`error`, and
 * `debug` which it feature-detects). Everything goes to one file in userData,
 * so a tester can be asked for it without hunting through AppData.
 */
function createLogger(app) {
  const file = path.join(app.getPath('userData'), 'updater.log');

  const write = (level, message) => {
    try {
      const line = `${new Date().toISOString()}  ${level}  ${message}\n`;
      // Rotate BEFORE appending, so the file never exceeds the cap even by one
      // long line. The previous roll is overwritten: two files is the point.
      try {
        if (fs.statSync(file).size + line.length > MAX_LOG_BYTES) {
          fs.renameSync(file, `${file}.1`);
        }
      } catch {
        /* no file yet — nothing to roll */
      }
      fs.appendFileSync(file, line);
    } catch {
      // A log that throws would take the updater down with it. It is a log.
    }
  };

  const say = (level) => (msg) => {
    if (msg == null) return;
    write(level, msg instanceof Error ? msg.stack || msg.message : String(msg));
  };

  return {
    path: file,
    debug: say('DEBUG'),
    info: say('INFO '),
    warn: say('WARN '),
    error: say('ERROR'),
  };
}

/** `Apex-AIO-System-Setup-0.91.0-beta.10.exe` → `0.91.0-beta.10`, or null. */
function versionFromInstallerName(fileName) {
  const m = /-Setup-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.exe$/.exec(String(fileName || ''));
  return m ? m[1] : null;
}

/**
 * Delete `pending/` when the update it holds is the version already running.
 *
 * Called once on startup, which is exactly when the fact is knowable: the
 * installer ran, the app relaunched, and `app.getVersion()` is now the version
 * that was pending. Any other state — a download waiting for the next quit, a
 * pending file for some other version, a half-written cache — is left alone.
 *
 * `installer.exe` at the cache root is NEVER touched. It is the base every
 * future differential download is rebuilt from; removing it would trade 287 MB
 * of disk for 287 MB of download on every single release, which is the opposite
 * of the point.
 *
 * Returns `{ freedBytes, reason }` for the log. Never throws.
 */
function reclaimPending(app, logger) {
  const result = { freedBytes: 0, reason: 'nothing to do' };
  const dir = cacheDir(app);
  if (!dir) return { ...result, reason: 'no cache dir (dev run?)' };

  const pending = path.join(dir, 'pending');
  const infoPath = path.join(pending, 'update-info.json');
  let info;
  try {
    info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  } catch {
    return { ...result, reason: 'no pending update' };
  }

  const staged = versionFromInstallerName(info && info.fileName);
  if (!staged) return { ...result, reason: `unrecognised pending file: ${info && info.fileName}` };
  if (staged !== app.getVersion()) {
    // Downloaded and waiting to install on quit. Deleting this would turn a
    // ready update into a silent no-op at the worst possible moment.
    return { ...result, reason: `pending ${staged} is not yet installed — kept` };
  }

  let freed = 0;
  try {
    for (const name of fs.readdirSync(pending)) {
      const p = path.join(pending, name);
      try {
        freed += fs.statSync(p).size;
      } catch {
        /* size is for the log line only */
      }
      fs.rmSync(p, { recursive: true, force: true });
    }
  } catch (err) {
    if (logger) logger.warn(`could not clear pending update: ${err.message}`);
    return { freedBytes: freed, reason: 'partially cleared' };
  }

  const out = { freedBytes: freed, reason: `installed ${staged} — pending copy removed` };
  if (logger) {
    logger.info(`reclaimed ${(freed / 1048576).toFixed(1)} MB from the update cache (${out.reason})`);
  }
  return out;
}

/** Sizes for the panel's storage readout: `{ base, pending, total }` in bytes. */
function usage(app) {
  const out = { base: 0, pending: 0, total: 0 };
  const dir = cacheDir(app);
  if (!dir) return out;
  try {
    out.base = fs.statSync(path.join(dir, 'installer.exe')).size;
  } catch {
    /* no base yet — this install has never taken an update */
  }
  try {
    for (const name of fs.readdirSync(path.join(dir, 'pending'))) {
      try {
        out.pending += fs.statSync(path.join(dir, 'pending', name)).size;
      } catch {
        /* raced with a download — close enough for a readout */
      }
    }
  } catch {
    /* nothing pending */
  }
  out.total = out.base + out.pending;
  return out;
}

module.exports = { cacheDir, createLogger, reclaimPending, usage, versionFromInstallerName };
