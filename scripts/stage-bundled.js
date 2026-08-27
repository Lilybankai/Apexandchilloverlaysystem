/**
 * scripts/stage-bundled.js — stage the engineer's binaries for bundling.
 * -----------------------------------------------------------------------------
 * From v0.79.0 the installer ships the engineer's BINARIES inside the package
 * instead of the app downloading them at runtime. The reason is antivirus
 * provenance: a running app that pulls an unknown unsigned exe into AppData and
 * spawns it is the exact behavioural fingerprint AV heuristics quarantine
 * (Norton did, and the field report was "the engineer crashed the app"). Files
 * laid down by our signed installer — and themselves signed at build time, see
 * electron-builder.js — carry none of that.
 *
 * ## v0.93.0: the models ride along again
 * v0.91.0 split them out — `ggml-base.en.bin` (141 MB) and the default voice
 * `en_GB-alan-medium.onnx` (60 MB) became a one-time download into userData,
 * saving 201 MB off every release. The first field report paid for it: the
 * update wiped the bundled copies, every driver suddenly NEEDED that download,
 * and a tester behind a proxy/TLS-scanning AV got "fetch failed" and a mute
 * engineer. The 201 MB argument was also weaker than it looked — blockmap
 * differential updates already skip unchanged model bytes on the update path.
 * So the default voice and the whisper model ship in the installer again;
 * only the five OTHER voices remain in-app downloads.
 *
 * What did NOT come back: the non-English espeak-ng dictionaries. The engineer
 * speaks English, and `ru_dict`, `cmn_dict`, `libtashkeel_model.ort` and ~100
 * others were 26 MB of an installer nothing would ever read. Verified by
 * synthesising with the pruned tree and transcribing the result back.
 * electron/engineerStt.js still resolves the engine and the model
 * independently, because installs from the 0.91.x era hold models in userData.
 *
 * This script fills `build/bundled/` (gitignored) from the `tools/` caches,
 * downloading via the existing setup scripts only if the caches are empty:
 *
 *   build/bundled/piper/     engine + English phoneme data + Alan (~77 MB)
 *   build/bundled/whisper/   whisper-cli tree + base.en          (~168 MB)
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

const checkOnly = process.argv.includes('--check');

/**
 * The voice the installer ships — the default engineer. The other five stay
 * in-app downloads; a stray one in staging grows every release by 60+ MB.
 */
const BUNDLED_VOICE = 'en_GB-alan-medium';

/**
 * The only espeak-ng dictionary the engineer can ever use.
 *
 * espeak-ng ships ~110 `<lang>_dict` files. The shared tables beside them
 * (`phondata`, `phonindex`, `phontab`, `intonations`, `voices/`, `lang/`) are
 * the phonemiser itself and must all stay; the per-language dictionaries are
 * independent, and every one but this is dead weight in an English-only app.
 */
const KEPT_DICT = 'en_dict';

/**
 * Arabic diacritisation, loaded only for `ar`. 9.8 MB, and the largest single
 * file in the piper tree after the voice itself.
 */
const DROPPED_MODELS = ['libtashkeel_model.ort'];

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
  // The English phoneme data. piper loads these before it looks at a voice, so
  // a tree missing one of them fails at synthesis time rather than at startup.
  for (const f of [KEPT_DICT, 'phondata', 'phonindex', 'phontab', 'intonations']) {
    if (!fs.existsSync(path.join(pDir, 'espeak-ng-data', f))) {
      problems.push(`piper/espeak-ng-data/${f} missing — the prune took too much`);
    }
  }
  if (!findNamed(wDir, 'whisper-cli.exe') && !findNamed(wDir, 'main.exe')) {
    problems.push('whisper/whisper-cli.exe missing');
  }

  // The models ship again from v0.93.0 — see the header. A package without
  // them boots a first install into "download or stay mute", which is exactly
  // the proxy/AV failure the re-bundle exists to close.
  if (!fs.existsSync(path.join(pDir, `${BUNDLED_VOICE}.onnx`))) {
    problems.push(`piper/${BUNDLED_VOICE}.onnx missing`);
  }
  if (!fs.existsSync(path.join(pDir, `${BUNDLED_VOICE}.onnx.json`))) {
    problems.push(`piper/${BUNDLED_VOICE}.onnx.json missing`);
  }
  const ggml = path.join(wDir, 'ggml-base.en.bin');
  if (!fs.existsSync(ggml) || fs.statSync(ggml).size < 100_000_000) {
    problems.push('whisper/ggml-base.en.bin missing or truncated');
  }

  /*
   * What still must NOT ship: any voice beyond the default (60+ MB each,
   * silently — the build succeeds and only the installer size says anything is
   * wrong), and the model data for languages the engineer never speaks.
   */
  if (fs.existsSync(pDir)) {
    for (const f of fs.readdirSync(pDir)) {
      if (f.endsWith('.onnx') && !f.startsWith(BUNDLED_VOICE)) {
        problems.push(`piper/${f} is not the bundled voice and must not ship`);
      }
      if (DROPPED_MODELS.includes(f)) {
        problems.push(`piper/${f} is for a language the engineer never speaks`);
      }
    }
    const dicts = fs.existsSync(path.join(pDir, 'espeak-ng-data'))
      ? fs.readdirSync(path.join(pDir, 'espeak-ng-data')).filter((f) => f.endsWith('_dict'))
      : [];
    const strays = dicts.filter((f) => f !== KEPT_DICT);
    if (strays.length) {
      problems.push(`piper/espeak-ng-data holds ${strays.length} dictionaries the app cannot use`);
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
  console.log('[bundled] build/bundled verified — engine, default voice and whisper all present.');
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

// Piper: the engine plus the ONE bundled voice. The tools cache holds every
// voice ever spiked plus the full espeak dictionary set; the other voices stay
// in-app downloads, the extra dictionaries are unusable in an English-only app.
for (const e of fs.readdirSync(TOOLS_PIPER, { withFileTypes: true })) {
  const isVoiceFile = e.name.endsWith('.onnx') || e.name.endsWith('.onnx.json');
  if (isVoiceFile && !e.name.startsWith(BUNDLED_VOICE)) continue;
  if (DROPPED_MODELS.includes(e.name)) continue;
  fs.cpSync(path.join(TOOLS_PIPER, e.name), path.join(OUT_PIPER, e.name), { recursive: true });
}

// …then take the other ~110 dictionaries back out. Copied first and pruned
// after, rather than filtered during the copy, because espeak-ng-data is one
// directory among files and cpSync recurses it as a unit.
const dictDir = path.join(OUT_PIPER, 'espeak-ng-data');
for (const f of fs.readdirSync(dictDir)) {
  if (f.endsWith('_dict') && f !== KEPT_DICT) fs.rmSync(path.join(dictDir, f), { force: true });
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
  `[bundled] staged — piper ${size(OUT_PIPER)} MB, whisper ${size(OUT_WHISPER)} MB ` +
    '(engine + default voice + base.en; the other voices stay in-app downloads). ' +
    'electron-builder picks these up as extraResources.',
);
