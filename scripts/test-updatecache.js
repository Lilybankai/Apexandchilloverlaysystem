/**
 * scripts/test-updatecache.js — the updater's log, and the 287 MB it parks.
 * -----------------------------------------------------------------------------
 * electron-updater keeps up to two full copies of the installer:
 *
 *   <cache>/installer.exe               the base every differential rebuild needs
 *   <cache>/pending/<Setup-x.y.z>.exe   the one waiting to be run
 *
 * At 287 MB each that is 575 MB parked on a driver's disk, and the second copy
 * is dead weight the moment its installer has actually run — electron-updater
 * only clears `pending/` at the start of the NEXT download, whenever that is.
 * `reclaimPending()` drops it early.
 *
 * The whole risk lives in one comparison, so that is what this pins:
 *
 *   - a pending update for a version that is NOT running is downloaded and
 *     waiting. `autoInstallOnAppQuit` needs it on the way out; deleting it
 *     turns a ready update into a silent no-op at the worst possible moment.
 *   - `installer.exe` must survive every path. Delete it and every future
 *     update is a full 287 MB download instead of a 10.7 MB differential —
 *     trading a one-off disk saving for a permanent bandwidth cost.
 *
 * Run: node scripts/test-updatecache.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const updateCache = require('../electron/updateCache');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? `   [${detail}]` : ''));
  ok ? pass++ : fail++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-updatecache-'));
const localAppData = path.join(root, 'Local');
const userData = path.join(root, 'userData');
const resources = path.join(root, 'resources');
fs.mkdirSync(localAppData, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(resources, { recursive: true });

// electron-builder writes this; the module reads the cache dir name out of it
// rather than guessing, because the app was RENAMED and the cache dir was not.
fs.writeFileSync(
  path.join(resources, 'app-update.yml'),
  ['provider: github', 'updaterCacheDirName: apex-overlay-system-updater', ''].join('\n'),
);

const CACHE = path.join(localAppData, 'apex-overlay-system-updater');

/** A stand-in for Electron's `app`, with the version under our control. */
function fakeApp(version, packaged = true) {
  return {
    isPackaged: packaged,
    getVersion: () => version,
    getName: () => 'apex-overlay-system',
    getPath: (k) => (k === 'userData' ? userData : root),
  };
}

/** Lay the cache down the way electron-updater leaves it. */
function seed(pendingVersion, { installerBase = true } = {}) {
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(path.join(CACHE, 'pending'), { recursive: true });
  if (installerBase) {
    fs.writeFileSync(path.join(CACHE, 'installer.exe'), Buffer.alloc(4096));
    fs.writeFileSync(path.join(CACHE, 'current.blockmap'), Buffer.alloc(64));
  }
  if (pendingVersion) {
    const fileName = `Apex-AIO-System-Setup-${pendingVersion}.exe`;
    fs.writeFileSync(path.join(CACHE, 'pending', fileName), Buffer.alloc(4096));
    fs.writeFileSync(
      path.join(CACHE, 'pending', 'update-info.json'),
      JSON.stringify({ fileName, sha512: 'x', isAdminRightsRequired: false }),
    );
  }
}

const pendingFiles = () => {
  try {
    return fs.readdirSync(path.join(CACHE, 'pending'));
  } catch {
    return [];
  }
};

// process.resourcesPath is what the module reads app-update.yml from.
const realResourcesPath = process.resourcesPath;
process.resourcesPath = resources;
const realLocalAppData = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = localAppData;

/* -------------------------------------------------------------------------- */
console.log('\n1) the cache dir comes from app-update.yml, not from a guess');
/* -------------------------------------------------------------------------- */

// The app is "Apex AIO System" and the cache dir is "apex-overlay-system-updater".
// Deriving it from either name has a 50% chance of pointing somewhere empty and
// silently doing nothing at all, which is indistinguishable from working.
check('reads updaterCacheDirName', updateCache.cacheDir(fakeApp('1.0.0')) === CACHE, updateCache.cacheDir(fakeApp('1.0.0')));
check('an unpackaged run has no cache', updateCache.cacheDir(fakeApp('1.0.0', false)) === null);

/* -------------------------------------------------------------------------- */
console.log('\n2) the version is read back out of the installer filename');
/* -------------------------------------------------------------------------- */

const ver = updateCache.versionFromInstallerName;
check('a stable build', ver('Apex-AIO-System-Setup-0.90.3.exe') === '0.90.3');
check('a prerelease build', ver('Apex-AIO-System-Setup-0.91.0-beta.10.exe') === '0.91.0-beta.10');
check('something else entirely', ver('setup.exe') === null);
check('no name at all', ver(undefined) === null);

/* -------------------------------------------------------------------------- */
console.log('\n3) an installed update: the pending copy goes, the base stays');
/* -------------------------------------------------------------------------- */

seed('0.91.0-beta.10');
let res = updateCache.reclaimPending(fakeApp('0.91.0-beta.10'), null);
check('the pending dir is emptied', pendingFiles().length === 0, pendingFiles().join(','));
check('the bytes are reported', res.freedBytes > 4000, res.freedBytes);
check(
  'installer.exe survives',
  fs.existsSync(path.join(CACHE, 'installer.exe')),
  'it is the base for the next differential download',
);
check('current.blockmap survives', fs.existsSync(path.join(CACHE, 'current.blockmap')));

/* -------------------------------------------------------------------------- */
console.log('\n4) an update still WAITING is never touched');
/* -------------------------------------------------------------------------- */

// The dangerous case. autoInstallOnAppQuit runs this on the way out; deleting it
// would leave the driver on the old build with no error and no explanation.
seed('0.92.0');
res = updateCache.reclaimPending(fakeApp('0.91.0-beta.10'), null);
check('the pending installer is kept', pendingFiles().length === 2, pendingFiles().join(','));
check('and nothing is claimed as freed', res.freedBytes === 0);
check('the reason says so', /not yet installed/.test(res.reason), res.reason);

/* -------------------------------------------------------------------------- */
console.log('\n5) the states that are not a pending update at all');
/* -------------------------------------------------------------------------- */

seed(null);
res = updateCache.reclaimPending(fakeApp('0.91.0-beta.10'), null);
check('an empty pending dir is a no-op', res.freedBytes === 0);
check('installer.exe is still not touched', fs.existsSync(path.join(CACHE, 'installer.exe')));

// A half-written cache, or one from a build whose naming this does not know.
fs.writeFileSync(path.join(CACHE, 'pending', 'update-info.json'), JSON.stringify({ fileName: 'mystery.exe' }));
res = updateCache.reclaimPending(fakeApp('0.91.0-beta.10'), null);
check('an unrecognised filename is left alone', /unrecognised/.test(res.reason), res.reason);

fs.writeFileSync(path.join(CACHE, 'pending', 'update-info.json'), 'not json at all');
res = updateCache.reclaimPending(fakeApp('0.91.0-beta.10'), null);
check('corrupt json is not an exception', res.freedBytes === 0, res.reason);

fs.rmSync(CACHE, { recursive: true, force: true });
res = updateCache.reclaimPending(fakeApp('0.91.0-beta.10'), null);
check('no cache at all is not an exception', res.freedBytes === 0, res.reason);

/* -------------------------------------------------------------------------- */
console.log('\n6) usage() is honest about both copies');
/* -------------------------------------------------------------------------- */

seed('0.92.0');
const use = updateCache.usage(fakeApp('0.91.0-beta.10'));
check('counts the base', use.base === 4096, use.base);
check('counts the pending copy', use.pending > 4000, use.pending);
check('and totals them', use.total === use.base + use.pending);

/* -------------------------------------------------------------------------- */
console.log('\n7) the log exists, rolls, and never throws');
/* -------------------------------------------------------------------------- */

// This log exists to answer ONE question: did that update move 10.7 MB or
// 287.5 MB? electron-updater says so in a line nobody could previously read.
const log = updateCache.createLogger(fakeApp('0.91.0-beta.10'));
check('it lands in userData', log.path === path.join(userData, 'updater.log'));
check('electron-updater\'s four levels are all present',
  ['debug', 'info', 'warn', 'error'].every((k) => typeof log[k] === 'function'));

log.info('Download block maps (old: a, new: b)');
log.warn('Cannot download differentially, fallback to full download');
const body = fs.readFileSync(log.path, 'utf8');
check('the differential line is recorded', body.includes('fallback to full download'));
check('each line is stamped', /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+INFO/.test(body), body.split('\n')[0]);

log.error(new Error('boom'));
check('an Error logs its stack, not [object Object]', fs.readFileSync(log.path, 'utf8').includes('boom'));
log.info(null);
check('a null message is skipped, not printed', !fs.readFileSync(log.path, 'utf8').includes('null'));

// A log that grows without bound is its own bug report. 256 KB, two files.
for (let i = 0; i < 4000; i++) log.info(`line ${i} ${'x'.repeat(100)}`);
check('the live log stays under the cap', fs.statSync(log.path).size <= 256 * 1024, fs.statSync(log.path).size);
check('the previous roll is kept', fs.existsSync(`${log.path}.1`));

// A logger that throws would take the updater down with it. It is a log.
const doomed = updateCache.createLogger({
  isPackaged: true,
  getVersion: () => '1.0.0',
  getName: () => 'x',
  getPath: () => path.join(root, 'nope', 'still-nope', 'definitely-not'),
});
let threw = false;
try {
  doomed.info('into the void');
} catch {
  threw = true;
}
check('an unwritable log swallows its own failure', !threw);

process.resourcesPath = realResourcesPath;
if (realLocalAppData === undefined) delete process.env.LOCALAPPDATA;
else process.env.LOCALAPPDATA = realLocalAppData;
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
