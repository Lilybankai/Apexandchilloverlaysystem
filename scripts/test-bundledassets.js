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
 *   3. the v0.93.0 bundle is exactly right: the default voice and base.en ship
 *      in the installer (the v0.91.0 download-only split turned "can't reach
 *      HuggingFace" into a mute engineer), the other five voices and ~110
 *      espeak dictionaries never do, and a 0.91.x-era install — bundled engine
 *      plus a model downloaded into userData — still reads as the working
 *      install it is.
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
// The v0.91.x installers shipped the binaries and downloaded the 141 MB model
// into userData; those installs are still in the field, so the state that has
// to keep working is the one that used to look like two half-installs.
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
console.log('\n4) the staging rules ship the models and only the models we mean to');

// v0.93.0 re-bundles the default voice and base.en — the v0.91.0 download-only
// split turned "can't reach HuggingFace" into a mute engineer on first run.
// What must still never creep in: the OTHER voices (60+ MB each, silently) and
// model data for languages the engineer never speaks.
const stageSrc = fs.readFileSync(path.join(__dirname, 'stage-bundled.js'), 'utf8');
check('staging ships the default voice', stageSrc.includes("BUNDLED_VOICE = 'en_GB-alan-medium'"));
check('staging refuses every other voice', stageSrc.includes('is not the bundled voice and must not ship'));
check('staging copies the ggml model again', /cpSync\([^)]*ggml-base\.en\.bin/.test(stageSrc));
check('staging keeps only en_dict', stageSrc.includes("KEPT_DICT = 'en_dict'"));
check('staging drops the Arabic diacritisation model', stageSrc.includes('libtashkeel_model.ort'));

// afterPack must refuse a package missing either model — a build that succeeds
// while shipping a mute engineer is this repo's most expensive failure mode.
const builderSrc = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.js'), 'utf8');
check('afterPack probes the ggml model', builderSrc.includes("'whisper/ggml-base.en.bin'"));
check('afterPack probes the bundled voice', builderSrc.includes("'piper/en_GB-alan-medium.onnx'"));
check('afterPack probes the whisper binary', builderSrc.includes('whisper/bin/Release/whisper-cli.exe'));
check('afterPack probes the English dictionary', builderSrc.includes('piper/espeak-ng-data/en_dict'));

fs.rmSync(root, { recursive: true, force: true });

/* -------------------------------------------------------------------------- */
console.log('\n5) downloads survive proxies and say why they failed (v0.93.0)');

// The field report behind this: v0.91.0 stopped shipping the models, so every
// driver must download a voice — and one behind a proxy / TLS-scanning AV got
// a bare "fetch failed" from Node's undici, which uses neither the system
// proxy nor the Windows certificate store. Chromium's net.fetch uses both.
const { fetchStacks, describeFetchError } = require('../electron/engineer');

// Outside Electron (this test) only Node's stack exists; inside Electron the
// Chromium stack must be tried FIRST. Pin the source for the electron half —
// require('electron') resolves to a path string out here, so the list itself
// can only prove the fallback.
const stacks = fetchStacks();
check('plain Node gets exactly the node stack', stacks.length === 1 && stacks[0].name === 'node');
check('the node stack is global fetch', stacks[0].fetch === globalThis.fetch);
check("engineer.js puts Chromium's net.fetch before Node's", /net\.fetch/.test(engineerSrc));
check('downloads still follow redirects (HF resolve → CDN)', engineerSrc.includes("redirect: 'follow'"));

// undici buries the actual reason in err.cause; a screenshot of the status
// line is often ALL the diagnostics a Discord report carries.
const dns = new Error('fetch failed');
dns.cause = new Error('getaddrinfo ENOTFOUND huggingface.co');
check(
  'a DNS failure names the host, not just "fetch failed"',
  describeFetchError(dns) === 'fetch failed — getaddrinfo ENOTFOUND huggingface.co',
);
const dual = new Error('fetch failed');
dual.cause = new AggregateError([new Error('connect ECONNREFUSED 2600::1:443')], 'aggregate');
check(
  'a dual-stack connect failure surfaces a per-address error',
  describeFetchError(dual).includes('ECONNREFUSED'),
);
check('a plain error passes through untouched', describeFetchError(new Error('HTTP 404')) === 'HTTP 404');
const loop = new Error('a');
loop.cause = loop;
check('a self-referential cause chain terminates', describeFetchError(loop) === 'a');

/* -------------------------------------------------------------------------- */
console.log('\n6) "better ears" fetches itself, quietly, and never in the way (v0.96.0)');

// v0.95.0 put small.en behind a Download button and drivers never found it.
// It now downloads in the background the first time the engineer is enabled;
// what is pinned here is everything that makes that safe: it returns before
// the network is touched, the standard model keeps answering, it never runs
// on track, a failure never becomes the warning banner, and a dropped
// connection resumes rather than restarts.
const bigEnough = (file, bytes) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.truncateSync(file, bytes);
};

(async () => {
  const r6 = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ears-test-'));
  const bWhisper = path.join(r6, 'resources', 'whisper');
  const uWhisper = path.join(r6, 'user', 'whisper');
  const piperDir = path.join(r6, 'user', 'piper');
  fs.mkdirSync(piperDir, { recursive: true });
  const ears = (extra = {}) =>
    new EngineerService({
      dir: piperDir,
      whisperDir: uWhisper,
      bundledDir: path.join(r6, 'resources', 'piper'),
      bundledWhisperDir: bWhisper,
      loadSettings: () => ({ engineerEnabled: true, engineerVoice: VOICE }),
      onStatus: () => {},
      ...extra,
    });

  // No base install at all: nothing to upgrade, nothing fetched.
  let e = ears();
  let fetched = [];
  e.fetch = async (url, dest) => {
    fetched.push(url);
    bigEnough(dest, 100_000_001);
  };
  check('no base install → no-base, nothing fetched', e.ensureBetterEars() === 'no-base' && fetched.length === 0);

  // The bundled layout the installer lays down: engine + base.en.
  bigEnough(path.join(bWhisper, 'bin', 'Release', 'whisper-cli.exe'), 10);
  bigEnough(path.join(bWhisper, 'ggml-base.en.bin'), 1_100_000);
  check('the fixture is a working base install', stt.installed(e.sttRoots()) && !stt.smallInstalled(e.sttRoots()));

  check('on track → deferred, nothing fetched', e.ensureBetterEars({ onTrack: true }) === 'on-track' && fetched.length === 0);

  // Off track: it starts, and the CALL returns before the download has done
  // anything — startup must never wait on HuggingFace.
  let release;
  const gate = new Promise((res) => (release = res));
  e.fetch = async (url, dest) => {
    fetched.push(url);
    await gate;
    bigEnough(dest, 100_000_001);
  };
  const verdict = e.ensureBetterEars();
  check('off track → started', verdict === 'started');
  check('the call returned while the fetch is still pending', fetched.length === 1 && !stt.smallInstalled(e.sttRoots()));
  check('it fetches small.en, into userData', fetched[0].endsWith('ggml-small.en.bin'));
  check('the base model still answers meanwhile', stt.findModel(e.sttRoots()) === path.join(bWhisper, 'ggml-base.en.bin'));
  check('a second call while running → busy, not a second download', e.ensureBetterEars() === 'busy' && fetched.length === 1);
  check('the panel sees the same progress key the voice bar uses', e.busy === 'download:stt-small');
  release();
  await new Promise((res) => setTimeout(res, 20));
  check('once landed → installed', e.ensureBetterEars() === 'installed');
  check('and small.en is now preferred', stt.findModel(e.sttRoots()) === path.join(uWhisper, 'ggml-small.en.bin'));
  check('no error, no banner', e.betterEars.error === null && e.lastError === null);

  // Failure is quiet and backed off: the status line, never the warning
  // banner, and no retry storm against a proxy that just said no.
  fs.rmSync(path.join(uWhisper, 'ggml-small.en.bin'), { force: true });
  e = ears();
  e.fetch = async () => {
    throw new Error('download: fetch failed — getaddrinfo ENOTFOUND huggingface.co');
  };
  check('failure attempt starts', e.ensureBetterEars() === 'started');
  await new Promise((res) => setTimeout(res, 20));
  check('the failure is kept on the status line', /ENOTFOUND/.test(e.betterEars.error || ''));
  check('and never becomes lastError (the banner)', e.lastError === null);
  check('busy is released', e.busy === null);
  check('the next call backs off', e.ensureBetterEars() === 'backoff');
  check('status carries a retry time for the panel', typeof e.status().betterEars.retryAt === 'number' && e.status().betterEars.retryAt > Date.now());
  e.betterEars.nextTryAt = 0;
  check('after the backoff it tries again', e.ensureBetterEars() === 'started');
  await new Promise((res) => setTimeout(res, 20));

  // Resume: a real HTTP round trip against a local server that honours Range.
  // 466 MB on a home line WILL drop; the .part must be a head start, not waste.
  const http = require('node:http');
  const body = Buffer.alloc(3000);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const seen = [];
  let honourRange = true;
  const server = http.createServer((req, res) => {
    seen.push(req.headers.range || null);
    const m = honourRange && /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (m) {
      const from = Number(m[1]);
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` });
      res.end(body.subarray(from));
    } else {
      res.writeHead(200);
      res.end(body);
    }
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${server.address().port}/ggml-small.en.bin`;
  const dl = ears();
  const dest = path.join(r6, 'dl', 'model.bin');
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  fs.writeFileSync(`${dest}.part`, body.subarray(0, 1000));
  await dl.fetch(url, dest, 1, 'stt-small', { resume: true });
  check('resume asks for the bytes it lacks', seen[seen.length - 1] === 'bytes=1000-');
  check('and the finished file is whole and correct', fs.readFileSync(dest).equals(body));
  check('the .part is promoted away', !fs.existsSync(`${dest}.part`));

  fs.rmSync(dest, { force: true });
  fs.writeFileSync(`${dest}.part`, Buffer.from('stale garbage'));
  honourRange = false;
  await dl.fetch(url, dest, 1, 'stt-small', { resume: true });
  check('a 200 to a ranged request starts the file over', fs.readFileSync(dest).equals(body));
  honourRange = true;

  fs.rmSync(dest, { force: true });
  fs.writeFileSync(`${dest}.part`, body.subarray(0, 1000));
  await dl.fetch(url, dest, 1, 'voice');
  check('a normal (non-resume) download never sends Range', seen[seen.length - 1] === null);
  check('and still produces the whole file', fs.readFileSync(dest).equals(body));

  // Drain the client pool's keep-alive sockets BEFORE the process ends: a
  // process.exit() with undici sockets still open trips a libuv assertion on
  // Windows (async.c: UV_HANDLE_CLOSING) after the summary has printed.
  server.closeAllConnections();
  await new Promise((res) => server.close(res));
  fs.rmSync(r6, { recursive: true, force: true });

  // The wiring in main.js and the panel: no button left to miss.
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'index.html'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'engineer-panel.js'), 'utf8');
  check('main.js kicks the fetch from syncEngineer', /maybeFetchBetterEars\(s\)/.test(mainSrc));
  check('main.js kicks it again when the driver leaves the track', /if \(!onTrack\) maybeFetchBetterEars\(\)/.test(mainSrc));
  check('main.js passes the on-track state through', /ensureBetterEars\(\{ onTrack: feedOnTrack \}\)/.test(mainSrc));
  check('the Download button is gone from the panel', !htmlSrc.includes('eng-stt-small-download'));
  check('and from the panel script', !panelSrc.includes('engineerDownloadSttSmall'));

  /* ------------------------------------------------------------------------ */
  console.log(`\n${pass} passed, ${fail} failed`);
  // Let the loop drain rather than process.exit() — see the note above.
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
