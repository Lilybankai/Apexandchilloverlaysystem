/**
 * scripts/test-bundledassets.js — the bundled engineer binaries (v0.79.0).
 * -----------------------------------------------------------------------------
 * The installer ships Piper + the default voice + whisper inside the package
 * (signed at build time) so antivirus never watches the app download and run
 * an unknown exe — the Norton-quarantine failure. This suite pins the two
 * halves that make that true:
 *
 *   1. the electron-builder config actually maps the staged dirs in and runs
 *      the afterPack verify/sign hook — a missing entry here ships the old
 *      download-at-runtime behaviour without a single test failing, and
 *   2. EngineerService resolves bundled paths first, falls back to the
 *      userData downloads, and never points a DOWNLOAD at the resources dir.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EngineerService } = require('../electron/engineer');
const builderConfig = require('../electron-builder');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const VOICE = 'en_GB-alan-medium';
const OTHER = 'en_GB-jenny_dioco-medium';

/* -------------------------------------------------------------------------- */
console.log('\n0) the AV-heuristic surface stays clean (v0.80.0)');

// The 2026-08 Norton saga: what gets an app quarantined is LOOKING like
// malware — encoded PowerShell, shelling out to curl, running downloaded
// unsigned exes. These checks pin the source so none of it quietly returns.
// Match the quoted string a spawn/execFile call would need, not the words —
// the comments explaining WHY these are banned may name them.
const engineerSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'engineer.js'), 'utf8');
check('engineer.js never uses -EncodedCommand', !engineerSrc.includes("'-EncodedCommand'"));
check('engineer.js never shells out to curl', !engineerSrc.includes("'curl.exe'"));
const sidecarsDir = path.join(__dirname, '..', 'electron', 'sidecars');
for (const f of ['voice-player.ps1', 'voice-recognizer.ps1']) {
  check(`sidecar ${f} exists in the repo`, fs.existsSync(path.join(sidecarsDir, f)));
}
check(
  'the sidecars ship as resources',
  (builderConfig.extraResources || []).some((e) => e && e.from === 'electron/sidecars' && e.to === 'sidecars'),
);

/* -------------------------------------------------------------------------- */
console.log('\n1) electron-builder ships and signs the staged assets');

const extra = builderConfig.extraResources || [];
const mapped = (from, to) => extra.some((e) => e && e.from === from && e.to === to);
check('build/bundled/piper is mapped into resources/piper', mapped('build/bundled/piper', 'piper'));
check(
  'build/bundled/whisper is mapped into resources/whisper',
  mapped('build/bundled/whisper', 'whisper'),
);
check('afterPack hook is wired (verify + sign)', typeof builderConfig.afterPack === 'function');
check('the plugin DLL mapping survived', mapped('build/plugin', 'plugin'));

/* -------------------------------------------------------------------------- */
console.log('\n2) bundled paths win, downloads fall back, and never collide');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-bundled-test-'));
const bundledPiper = path.join(root, 'resources', 'piper');
const bundledWhisper = path.join(root, 'resources', 'whisper');
const userPiper = path.join(root, 'user', 'piper');
const userWhisper = path.join(root, 'user', 'whisper');
fs.mkdirSync(bundledPiper, { recursive: true });
fs.mkdirSync(bundledWhisper, { recursive: true });
fs.mkdirSync(userPiper, { recursive: true });

const svc = () =>
  new EngineerService({
    dir: userPiper,
    whisperDir: userWhisper,
    bundledDir: bundledPiper,
    bundledWhisperDir: bundledWhisper,
    loadSettings: () => ({ engineerEnabled: false, engineerVoice: VOICE }),
    onStatus: () => {},
  });

// Nothing bundled yet: everything resolves to the download dir, like today.
let s = svc();
check('no bundle → engine path is the download dir', s.enginePath() === path.join(userPiper, 'piper.exe'));
check('no bundle → engine not installed', !s.engineInstalled());
check('no bundle → voice path is the download dir', s.modelPath(VOICE) === path.join(userPiper, `${VOICE}.onnx`));
check('no bundle → whisper dir is the download dir', s.sttDir() === userWhisper);

// Stage the bundle the way the installer lays it down.
fs.writeFileSync(path.join(bundledPiper, 'piper.exe'), 'exe');
fs.writeFileSync(path.join(bundledPiper, `${VOICE}.onnx`), 'model');
fs.writeFileSync(path.join(bundledPiper, `${VOICE}.onnx.json`), '{}');
s = svc();
check('bundled engine wins', s.enginePath() === path.join(bundledPiper, 'piper.exe'));
check('bundled engine counts as installed', s.engineInstalled());
check('bundled voice wins', s.modelPath(VOICE) === path.join(bundledPiper, `${VOICE}.onnx`));
check('bundled voice counts as installed', s.voiceInstalled(VOICE));
check(
  'a non-bundled voice still resolves to the download dir',
  s.modelPath(OTHER) === path.join(userPiper, `${OTHER}.onnx`),
  'download destination must never be the resources dir',
);
check('a non-bundled voice is not installed', !s.voiceInstalled(OTHER));

// A downloaded copy of the SAME voice must not shadow the bundled one.
fs.writeFileSync(path.join(userPiper, `${VOICE}.onnx`), 'stale');
fs.writeFileSync(path.join(userPiper, `${VOICE}.onnx.json`), '{}');
check(
  'bundled beats a downloaded copy of the same voice',
  s.modelPath(VOICE) === path.join(bundledPiper, `${VOICE}.onnx`),
);

// Whisper: only a COMPLETE bundled install (cli + real-sized model) wins.
fs.writeFileSync(path.join(bundledWhisper, 'whisper-cli.exe'), 'exe');
check('bundled whisper without a model does not win', s.sttDir() === userWhisper);
fs.writeFileSync(path.join(bundledWhisper, 'ggml-base.en.bin'), Buffer.alloc(1_100_000));
check('complete bundled whisper wins', s.sttDir() === bundledWhisper);
check('status reports advanced questions ready', s.status().sttInstalled === true);

fs.rmSync(root, { recursive: true, force: true });

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
