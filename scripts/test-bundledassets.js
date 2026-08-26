/**
 * scripts/test-bundledassets.js — the bundled engineer binaries (v0.79.0).
 * -----------------------------------------------------------------------------
 * The installer ships the Piper and whisper BINARIES inside the package
 * (signed at build time) so antivirus never watches the app download and run
 * an unknown exe — the Norton-quarantine failure. This suite pins the halves
 * that make that true:
 *
 *   1. the electron-builder config actually maps the staged dirs in and runs
 *      the afterPack verify/sign hook — a missing entry here ships the old
 *      download-at-runtime behaviour without a single test failing,
 *   2. EngineerService resolves bundled paths first, falls back to the
 *      userData downloads, and never points a DOWNLOAD at the resources dir,
 *   3. the v0.91.0 split holds: MODEL data (a 60 MB voice, a 141 MB ggml file,
 *      ~110 espeak dictionaries) is downloaded once and never shipped, while a
 *      bundled engine plus a downloaded model still reads as a working
 *      install. Getting this wrong puts 200 MB back into every release, or
 *      leaves the engineer reporting itself uninstalled while it works.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EngineerService } = require('../electron/engineer');
const stt = require('../electron/engineerStt');
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
check('no bundle → whisper roots end at the download dir', s.sttRoots().slice(-1)[0] === userWhisper);

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

// Whisper: the engine and the model are found INDEPENDENTLY across the roots.
// This is the v0.91.0 split — the installer ships the binaries, the 141 MB
// model is downloaded into userData — and the state that has to work is the one
// that used to look like two half-installs.
check('nothing anywhere → not installed', !stt.installed(s.sttRoots()));

fs.mkdirSync(path.join(bundledWhisper, 'bin', 'Release'), { recursive: true });
fs.writeFileSync(path.join(bundledWhisper, 'bin', 'Release', 'whisper-cli.exe'), 'exe');
check('the bundled engine is found', !!stt.findCli(s.sttRoots()));
check(
  'engine alone is not an install',
  !stt.installed(s.sttRoots()),
  'a missing model must not report ready — the ask would fail mid-race',
);

fs.mkdirSync(userWhisper, { recursive: true });
fs.writeFileSync(path.join(userWhisper, 'ggml-base.en.bin'), Buffer.alloc(1_100_000));
check('bundled engine + downloaded model IS an install', stt.installed(s.sttRoots()));
check(
  'the model resolves to userData',
  stt.findModel(s.sttRoots()) === path.join(userWhisper, 'ggml-base.en.bin'),
);
check('status reports advanced questions ready', s.status().sttInstalled === true);

// An install that predates this change still has the model in resources. It has
// to be used where it is, not downloaded again for 141 MB of nothing.
fs.writeFileSync(path.join(bundledWhisper, 'ggml-base.en.bin'), Buffer.alloc(1_100_000));
check(
  "an older install's bundled model beats re-downloading",
  stt.findModel(s.sttRoots()) === path.join(bundledWhisper, 'ggml-base.en.bin'),
);
// A truncated model is not a model — the old size guard has to survive the move.
fs.writeFileSync(path.join(bundledWhisper, 'ggml-base.en.bin'), Buffer.alloc(1000));
fs.rmSync(path.join(userWhisper, 'ggml-base.en.bin'), { force: true });
check('a truncated model does not count', !stt.installed(s.sttRoots()));

/* -------------------------------------------------------------------------- */
console.log('\n3) reclaiming voice downloads (v0.91.0)');

// Six voices at 63-121 MB each are there to be auditioned, so a curious driver
// ends up carrying several hundred megabytes they will never hear again. What
// is asserted here is what the button must NEVER do: silence the engineer, or
// reach into the installed package.
const rs = svc();
check('the selected voice is never removable', !rs.removableVoices().some((v) => v.id === VOICE));
check('an undownloaded voice is not offered', !rs.removableVoices().some((v) => v.id === OTHER));

fs.writeFileSync(path.join(userPiper, OTHER + '.onnx'), Buffer.alloc(2048));
fs.writeFileSync(path.join(userPiper, OTHER + '.onnx.json'), '{}');
check('once downloaded, it is offered', rs.removableVoices().some((v) => v.id === OTHER));
check('and its size is reported', rs.removableVoices().find((v) => v.id === OTHER).bytes > 2000);

check(
  'removing the selected voice is refused',
  (() => {
    try {
      rs.removeVoice(VOICE);
      return false;
    } catch {
      return true;
    }
  })(),
);
check('the bundled voice file is untouched', fs.existsSync(path.join(bundledPiper, VOICE + '.onnx')));

rs.removeVoice(OTHER);
check('removing deletes the model', !fs.existsSync(path.join(userPiper, OTHER + '.onnx')));
check('and its sidecar json', !fs.existsSync(path.join(userPiper, OTHER + '.onnx.json')));
check('nothing is left to reclaim', rs.removableVoices().length === 0);
check('the voice can be downloaded again', !rs.voiceInstalled(OTHER));

// No selected voice at all: fail CLOSED. Offering everything here would let one
// click leave the engineer with nothing to speak through.
const blind = new EngineerService({
  dir: userPiper,
  whisperDir: userWhisper,
  bundledDir: bundledPiper,
  bundledWhisperDir: bundledWhisper,
  loadSettings: () => ({ engineerEnabled: false }),
  onStatus: () => {},
});
fs.writeFileSync(path.join(userPiper, OTHER + '.onnx'), Buffer.alloc(2048));
fs.writeFileSync(path.join(userPiper, OTHER + '.onnx.json'), '{}');
check('no selected voice → nothing is removable', blind.removableVoices().length === 0);

/* -------------------------------------------------------------------------- */
console.log('\n4) the staging rules keep model data out of the installer');

// Each of these silently adds 60-141 MB to every future release: the build
// succeeds, the app works, and only the download size says anything is wrong.
const stageSrc = fs.readFileSync(path.join(__dirname, 'stage-bundled.js'), 'utf8');
check('staging refuses .onnx model data', stageSrc.includes('is model data and is downloaded, not shipped'));
check('staging no longer copies the ggml model', !/cpSync\([^)]*ggml-base\.en\.bin/.test(stageSrc));
check('staging keeps only en_dict', stageSrc.includes("KEPT_DICT = 'en_dict'"));
check('staging drops the Arabic diacritisation model', stageSrc.includes('libtashkeel_model.ort'));

// afterPack must probe BINARIES. A probe for a model would fail every build.
const builderSrc = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.js'), 'utf8');
check("afterPack no longer probes for the ggml model", !builderSrc.includes("'whisper/ggml-base.en.bin'"));
check('afterPack probes the whisper binary instead', builderSrc.includes('whisper/bin/Release/whisper-cli.exe'));
check('afterPack probes the English dictionary', builderSrc.includes('piper/espeak-ng-data/en_dict'));

fs.rmSync(root, { recursive: true, force: true });

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
