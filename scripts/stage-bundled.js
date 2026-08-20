/**
 * scripts/stage-bundled.js — stage the engineer's binaries for bundling.
 * -----------------------------------------------------------------------------
 * From v0.79.0 the installer ships the Piper engine, the default voice (Alan)
 * and whisper.cpp + base.en inside the package, instead of the app downloading
 * them at runtime. The reason is antivirus provenance: a running app that
 * curls an unknown unsigned exe into AppData and spawns it is the exact
 * behavioural fingerprint AV heuristics quarantine (Norton did, and the field
 * report was "the engineer crashed the app"). Files laid down by our signed
 * installer — and themselves signed at build time, see electron-builder.js —
 * carry none of that.
 *
 * This script fills `build/bundled/` (gitignored) from the `tools/` caches,
 * downloading via the existing setup scripts only if the caches are empty:
 *
 *   build/bundled/piper/     engine + en_GB-alan-medium (~85 MB)
 *   build/bundled/whisper/   whisper-cli tree + ggml-base.en.bin (~160 MB)
 *
 * electron-builder maps both into the installer as extraResources, and its
 * afterPack hook REFUSES to build if they are missing — a package without its
 * engine would silently ship the old download-at-runtime behaviour, and
 * "the build succeeded but shipped something broken" is this repo's most
 * expensive failure mode.
 *
 *   node scripts/stage-bundled.js            # stage (download only if needed)
 *   node scripts/stage-bundled.js --check    # verify only, touch nothing
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'bundled');
const OUT_PIPER = path.join(OUT, 'piper');
const OUT_WHISPER = path.join(OUT, 'whisper');

const TOOLS_PIPER = path.join(ROOT, 'tools', 'piper', 'piper');
const TOOLS_WHISPER = path.join(ROOT, 'tools', 'whisper');

const BUNDLED_VOICE = 'en_GB-alan-medium';
const checkOnly = process.argv.includes('--check');

function findNamed(from, name) {
  const want = name.toLowerCase();
  const stack = [from];
  while (stack.length) {
    const here = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(here, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(here, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === want) return p;
    }
  }
  return null;
}

/**
 * The one verification both modes share. Returns a list of problems rather
 * than throwing, so the caller can print all of them at once.
 */
function verify(root) {
  const problems = [];
  const pDir = path.join(root, 'piper');
  const wDir = path.join(root, 'whisper');
  if (!fs.existsSync(path.join(pDir, 'piper.exe'))) problems.push('piper/piper.exe missing');
  if (!fs.existsSync(path.join(pDir, 'espeak-ng-data'))) problems.push('piper/espeak-ng-data missing');
  if (!fs.existsSync(path.join(pDir, `${BUNDLED_VOICE}.onnx`))) {
    problems.push(`piper/${BUNDLED_VOICE}.onnx missing`);
  }
  if (!fs.existsSync(path.join(pDir, `${BUNDLED_VOICE}.onnx.json`))) {
    problems.push(`piper/${BUNDLED_VOICE}.onnx.json missing`);
  }
  if (!findNamed(wDir, 'whisper-cli.exe') && !findNamed(wDir, 'main.exe')) {
    problems.push('whisper/whisper-cli.exe missing');
  }
  const model = path.join(wDir, 'ggml-base.en.bin');
  if (!fs.existsSync(model) || fs.statSync(model).size < 100_000_000) {
    problems.push('whisper/ggml-base.en.bin missing or truncated');
  }
  // A stray extra voice in the staging dir means the installer quietly grows
  // by 60+ MB — flag it rather than ship it.
  if (fs.existsSync(pDir)) {
    for (const f of fs.readdirSync(pDir)) {
      if (f.endsWith('.onnx') && !f.startsWith(BUNDLED_VOICE)) {
        problems.push(`piper/${f} is not the bundled voice and must not ship`);
      }
    }
  }
  return problems;
}

function fail(problems) {
  console.error('\n  BUNDLED ASSETS NOT READY\n');
  for (const p of problems) console.error(`    - ${p}`);
  console.error('\n  Run:  node scripts/stage-bundled.js\n');
  process.exit(1);
}

if (checkOnly) {
  const problems = verify(OUT);
  if (problems.length) fail(problems);
  console.log('[bundled] build/bundled verified — engine, voice and whisper all present.');
  process.exit(0);
}

/* ---- fill the tools/ caches (setup scripts skip whatever already exists) --- */

console.log('[bundled] ensuring tools/ caches…');
execFileSync(process.execPath, [path.join(__dirname, 'setup-piper.js')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(__dirname, 'setup-whisper.js')], { stdio: 'inherit' });

/* ---- copy the shipping subset into build/bundled --------------------------- */

console.log('[bundled] staging build/bundled…');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT_PIPER, { recursive: true });
fs.mkdirSync(OUT_WHISPER, { recursive: true });

// Piper: the whole engine, but only the bundled voice — the tools cache may
// hold every voice ever spiked, and the other five stay in-app downloads.
for (const e of fs.readdirSync(TOOLS_PIPER, { withFileTypes: true })) {
  const isVoiceFile = e.name.endsWith('.onnx') || e.name.endsWith('.onnx.json');
  if (isVoiceFile && !e.name.startsWith(BUNDLED_VOICE)) continue;
  fs.cpSync(path.join(TOOLS_PIPER, e.name), path.join(OUT_PIPER, e.name), { recursive: true });
}

// Whisper: the cli tree as-is (the ggml DLLs must stay next to whisper-cli)
// plus base.en at the root, which is where electron/engineerStt.js looks.
fs.cpSync(path.join(TOOLS_WHISPER, 'bin'), path.join(OUT_WHISPER, 'bin'), { recursive: true });
fs.cpSync(path.join(TOOLS_WHISPER, 'ggml-base.en.bin'), path.join(OUT_WHISPER, 'ggml-base.en.bin'));

const problems = verify(OUT);
if (problems.length) fail(problems);

const size = (dir) => {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    for (const e of fs.readdirSync(here, { withFileTypes: true })) {
      const p = path.join(here, e.name);
      if (e.isDirectory()) stack.push(p);
      else total += fs.statSync(p).size;
    }
  }
  return Math.round(total / 1e6);
};
console.log(
  `[bundled] staged — piper ${size(OUT_PIPER)} MB, whisper ${size(OUT_WHISPER)} MB. ` +
    'electron-builder picks these up as extraResources.',
);
