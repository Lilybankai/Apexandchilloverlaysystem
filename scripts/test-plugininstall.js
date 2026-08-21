/**
 * scripts/test-plugininstall.js — shipping the shared-memory plugin into LMU.
 * -----------------------------------------------------------------------------
 * Without rFactor2SharedMemoryMapPlugin64.dll the game publishes NO telemetry
 * and every overlay quietly runs on demo data — the tester failure mode with
 * the empty `car` column. The installer copies the bundled DLL into the game's
 * root `Plugins\` folder and switches it on in CustomPluginVariables.JSON.
 *
 * The safety properties pinned here:
 *
 *   a DLL that is already present is NEVER overwritten, whatever its version —
 *   the user may deliberately run a newer plugin, and any version publishes
 *   the buffers we read;
 *
 *   nothing is written while LMU runs — the game reads its plugin list at
 *   launch and rewrites config on exit, so a write now is wasted or worse;
 *
 *   the enable key is `" Enabled"` WITH the leading space (LMU's own quirk,
 *   verified against a live install), other plugins' entries survive, and our
 *   entry's extra keys (a tuned UnsubscribedBuffersMask) survive re-enabling.
 *
 * Run: node scripts/test-plugininstall.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PLUGIN_DLL,
  PLUGIN_RUNTIME_URL,
  ensureSharedMemoryPlugin,
  pluginRuntimeInstalled,
} = require('../dist/server/pluginInstaller');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

/** A scratch LMU install; `exe: false` makes a folder that is not the game. */
function fakeLmu(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-lmu-'));
  if (opts.exe !== false) fs.writeFileSync(path.join(root, 'Le Mans Ultimate.exe'), 'x');
  return root;
}

/** The bundled DLL stand-in. */
function fakeSource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-src-'));
  const p = path.join(dir, PLUGIN_DLL);
  fs.writeFileSync(p, 'BUNDLED-DLL-BYTES');
  return p;
}

const cpv = (root, where) =>
  where === 'plugins'
    ? path.join(root, 'Plugins', 'CustomPluginVariables.JSON')
    : path.join(root, 'UserData', 'player', 'CustomPluginVariables.JSON');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

console.log('\n1) A fresh install gets the DLL and an enabled entry');

{
  const root = fakeLmu();
  const source = fakeSource();
  const r = ensureSharedMemoryPlugin({ root, source, running: false });
  check('status is installed', r.status === 'installed', r.status);
  check('the DLL lands in the root Plugins folder',
    fs.existsSync(path.join(root, 'Plugins', PLUGIN_DLL)));
  check('…with the bundled bytes',
    fs.readFileSync(path.join(root, 'Plugins', PLUGIN_DLL), 'utf8') === 'BUNDLED-DLL-BYTES');
  const config = readJson(cpv(root, 'player'));
  check('the player config is created with the entry', !!config[PLUGIN_DLL]);
  // The leading space is LMU's own spelling — without it the game ignores the key.
  check('…enabled via the leading-space " Enabled" key',
    config[PLUGIN_DLL][' Enabled'] === 1, JSON.stringify(Object.keys(config[PLUGIN_DLL])));
  check('no Plugins-folder config is invented',
    !fs.existsSync(cpv(root, 'plugins')));

  const again = ensureSharedMemoryPlugin({ root, source, running: false });
  check('a second run is a complete no-op', again.status === 'up-to-date', again.status);
}

console.log('\n2) A present DLL is never overwritten — only switched on');

{
  const root = fakeLmu();
  fs.mkdirSync(path.join(root, 'Plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Plugins', PLUGIN_DLL), 'USERS-NEWER-BUILD');
  // Entry exists but disabled, with a tuned mask that must survive.
  fs.mkdirSync(path.join(root, 'UserData', 'player'), { recursive: true });
  fs.writeFileSync(
    cpv(root, 'player'),
    JSON.stringify({
      'SomeOtherPlugin.dll': { ' Enabled': 1 },
      [PLUGIN_DLL]: { ' Enabled': 0, UnsubscribedBuffersMask: 160 },
    }),
  );

  const r = ensureSharedMemoryPlugin({ root, source: fakeSource(), running: false });
  check('status is enabled, not installed', r.status === 'enabled', r.status);
  check('the user\'s DLL keeps its bytes',
    fs.readFileSync(path.join(root, 'Plugins', PLUGIN_DLL), 'utf8') === 'USERS-NEWER-BUILD');
  const config = readJson(cpv(root, 'player'));
  check('the entry is switched on', config[PLUGIN_DLL][' Enabled'] === 1);
  check('…keeping its other keys', config[PLUGIN_DLL].UnsubscribedBuffersMask === 160);
  check('other plugins\' entries survive', config['SomeOtherPlugin.dll'][' Enabled'] === 1);
  check('a backup of the config was left',
    fs.existsSync(cpv(root, 'player') + '.apex-backup'));
}

console.log('\n3) Both config copies are kept in step when both exist');

{
  // A live install carries the file twice: UserData\player (the engine's own)
  // and Plugins\ (written by other tools). Whichever the game reads must agree.
  const root = fakeLmu();
  fs.mkdirSync(path.join(root, 'Plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Plugins', PLUGIN_DLL), 'DLL');
  fs.mkdirSync(path.join(root, 'UserData', 'player'), { recursive: true });
  fs.writeFileSync(cpv(root, 'player'), JSON.stringify({ [PLUGIN_DLL]: { ' Enabled': 0 } }));
  fs.writeFileSync(cpv(root, 'plugins'), JSON.stringify({ [PLUGIN_DLL]: { ' Enabled': 0 } }));

  const r = ensureSharedMemoryPlugin({ root, source: fakeSource(), running: false });
  check('both files were written', r.enabledIn.length === 2, r.enabledIn.join(' | '));
  check('player copy enabled', readJson(cpv(root, 'player'))[PLUGIN_DLL][' Enabled'] === 1);
  check('Plugins copy enabled', readJson(cpv(root, 'plugins'))[PLUGIN_DLL][' Enabled'] === 1);
}

console.log('\n4) Nothing is written while LMU runs');

{
  const root = fakeLmu();
  const r = ensureSharedMemoryPlugin({ root, source: fakeSource(), running: true });
  check('status is blocked-running', r.status === 'blocked-running', r.status);
  check('no DLL was copied', !fs.existsSync(path.join(root, 'Plugins', PLUGIN_DLL)));
  check('no config was created', !fs.existsSync(cpv(root, 'player')));

  // …but an install that is already right reports so even mid-game, because
  // answering "up to date" needs no write.
  const done = fakeLmu();
  fs.mkdirSync(path.join(done, 'Plugins'), { recursive: true });
  fs.writeFileSync(path.join(done, 'Plugins', PLUGIN_DLL), 'DLL');
  fs.mkdirSync(path.join(done, 'UserData', 'player'), { recursive: true });
  fs.writeFileSync(cpv(done, 'player'), JSON.stringify({ [PLUGIN_DLL]: { ' Enabled': 1 } }));
  const ok = ensureSharedMemoryPlugin({ root: done, source: null, running: true });
  check('an already-correct install reads up-to-date mid-game', ok.status === 'up-to-date', ok.status);
}

console.log('\n5) The degraded cases fail loudly, not halfway');

{
  const none = ensureSharedMemoryPlugin({ root: null, source: fakeSource(), running: false });
  check('no LMU install → no-lmu', none.status === 'no-lmu', none.status);

  const root = fakeLmu();
  const noSrc = ensureSharedMemoryPlugin({ root, source: null, running: false });
  check('missing bundled DLL → no-source', noSrc.status === 'no-source', noSrc.status);
  check('…and nothing was half-written', !fs.existsSync(cpv(root, 'player')));

  // A corrupt config is rebuilt rather than crashed on, and the original kept.
  const corrupt = fakeLmu();
  fs.mkdirSync(path.join(corrupt, 'UserData', 'player'), { recursive: true });
  fs.writeFileSync(cpv(corrupt, 'player'), '{not json');
  const r = ensureSharedMemoryPlugin({ root: corrupt, source: fakeSource(), running: false });
  check('a corrupt config does not stop the install', r.status === 'installed', r.status);
  check('…the rebuilt file parses', readJson(cpv(corrupt, 'player'))[PLUGIN_DLL][' Enabled'] === 1);
  check('…and the corrupt original is in the backup',
    fs.readFileSync(cpv(corrupt, 'player') + '.apex-backup', 'utf8') === '{not json');
}

console.log('\n6) The shipped bundle really carries the plugin');

{
  // The whole feature is a no-op if the DLL is not in the build assets — the
  // exact silent failure this suite exists to prevent.
  const bundled = path.join(__dirname, '..', 'build', 'plugin', PLUGIN_DLL);
  check('build/plugin holds the DLL', fs.existsSync(bundled), bundled);
  const size = fs.existsSync(bundled) ? fs.statSync(bundled).size : 0;
  check('…and it is a real PE, not a placeholder', size > 20000, size + ' bytes');
  check('…with its GPL licence beside it',
    fs.existsSync(path.join(__dirname, '..', 'build', 'plugin', 'LICENSE.gpl-3.0.txt')));
  check('…and the attribution README',
    fs.existsSync(path.join(__dirname, '..', 'build', 'plugin', 'README.txt')));
  // The packaging config moved from package.json's "build" block into
  // electron-builder.js when the Trusted Signing pipeline landed (v0.77.0-beta.3)
  // — read it from where electron-builder actually reads it.
  const builderConfig = require(path.join(__dirname, '..', 'electron-builder.js'));
  const extra = builderConfig.extraResources || [];
  check('electron-builder ships build/plugin as resources/plugin',
    extra.some((e) => e && e.from === 'build/plugin' && e.to === 'plugin'),
    JSON.stringify(extra));
}

console.log('\n7) A missing C runtime is reported, not papered over');
{
  // The plugin links against MSVCR120 (VC++ 2013). Without it LMU cannot load
  // the plugin, so no buffer is ever published — while every file on disk is
  // correct. Reporting 'installed' or 'up-to-date' here is a lie that costs a
  // support round-trip, which is exactly what happened to a tester on
  // 2026-08-21. The install must still HAPPEN; only the verdict changes.
  const root = fakeLmu();
  const src = fakeSource();
  const r = ensureSharedMemoryPlugin({ root, source: src, running: false, runtimeOk: false });
  check('a fresh install without the runtime reads missing-runtime',
    r.status === 'missing-runtime', r.status);
  check('…but the DLL was still copied', r.copied === true);
  check('…and the config was still enabled', r.enabledIn.length === 1);
  check('…and runtimeOk is reported to callers', r.runtimeOk === false);

  // Second pass: nothing left to write, so this is the case that used to
  // report a confident, wrong 'up-to-date'.
  const again = ensureSharedMemoryPlugin({ root, source: src, running: false, runtimeOk: false });
  check('an otherwise-perfect install still reads missing-runtime',
    again.status === 'missing-runtime', again.status);
  check('…and never claims up-to-date', again.status !== 'up-to-date');

  // With the runtime present the same install is genuinely fine.
  const fixed = ensureSharedMemoryPlugin({ root, source: src, running: false, runtimeOk: true });
  check('installing the runtime flips it to up-to-date', fixed.status === 'up-to-date', fixed.status);
  check('…with runtimeOk true', fixed.runtimeOk === true);

  check('pluginRuntimeInstalled() answers without throwing',
    typeof pluginRuntimeInstalled() === 'boolean', String(pluginRuntimeInstalled()));
  check('the runtime download link is Microsoft evergreen',
    PLUGIN_RUNTIME_URL === 'https://aka.ms/highdpimfc2013x64', PLUGIN_RUNTIME_URL);
}

console.log('\n8) The bundled DLL still needs the runtime we check for');
{
  // If a future plugin bump links against a different CRT, the runtime check
  // silently stops matching reality and the diagnosis regresses to "no idea".
  // Pin it to the DLL's real import table.
  const dll = path.join(__dirname, '..', 'build', 'plugin', PLUGIN_DLL);
  const b = fs.readFileSync(dll);
  const pe = b.readUInt32LE(0x3c);
  const nsec = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = b.readUInt16LE(opt);
  // Data directory 1 is the import table; its offset differs between PE32/PE32+.
  const ddOff = opt + (magic === 0x20b ? 112 : 96);
  const impRva = b.readUInt32LE(ddOff + 8);
  const secs = [];
  let so = opt + optSize;
  for (let i = 0; i < nsec; i++, so += 40) {
    secs.push({
      va: b.readUInt32LE(so + 12),
      vs: b.readUInt32LE(so + 8),
      raw: b.readUInt32LE(so + 20),
    });
  }
  const r2o = (rva) => {
    for (const x of secs) {
      if (rva >= x.va && rva < x.va + Math.max(x.vs, 1)) return rva - x.va + x.raw;
    }
    return null;
  };
  const imports = [];
  let o = r2o(impRva);
  while (o) {
    const nameRva = b.readUInt32LE(o + 12);
    if (!nameRva) break;
    const no = r2o(nameRva);
    if (no === null) break;
    let e = no;
    while (b[e]) e++;
    imports.push(b.toString('ascii', no, e));
    o += 20;
  }
  check('the DLL is 64-bit', magic === 0x20b, magic.toString(16));
  check('it imports MSVCR120.dll — the runtime the check looks for',
    imports.some((n) => /^MSVCR120\.dll$/i.test(n)), imports.join(' '));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
