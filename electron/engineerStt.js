/**
 * electron/engineerStt.js — local whisper.cpp for Tier-2 free-form questions.
 * -----------------------------------------------------------------------------
 * Audio never leaves the PC. This module downloads the official CPU binary and
 * `base.en` into `<userData>/whisper/` (same on-demand pattern as Piper voices),
 * trims silence from a push-to-talk clip, and transcribes it.
 *
 * Latency (the 2026-10-02 rework). From v0.96 "better ears" fetched small.en
 * by itself and findModel preferred it — and every question then paid a
 * 466 MB model load per spawn, a full 30-second encoder pass and a five-wide
 * beam search, all for a two-second clip. The call log shows it: drivers on
 * small.en sat at 3–6 s of STT where base.en had been ~1.1 s. Measured on the
 * dev box (9800X3D, 30 synthesised questions, three voices), small.en went
 * 2.45 s → 0.49 s median with the same transcripts, by:
 *
 *   - audio_ctx sized for the push-to-talk window (512 encoder frames = 10 s)
 *     so the encoder stops chewing 28 s of padding. NOT sized tight to the
 *     clip: at clip+64 frames whisper falls into "fuel, fuel, fuel…"
 *     repetition loops (17 of 30 clips did);
 *   - greedy decoding instead of beam 5 (identical transcripts on every clip);
 *   - threads from the machine (physical cores − 1, 4..8) instead of a fixed 4;
 *   - a RESIDENT whisper-server (whisperServer.js) holding the model, with the
 *     one-shot CLI kept as the fallback whenever the server is not up;
 *   - a speed guard: small.en is used only while it is actually fast on THIS
 *     machine — a slow warm-up probe, or two slow questions out of three,
 *     drop to base.en for the rest of the session.
 */

'use strict';

const { execFile, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WhisperServer } = require('./whisperServer');

const WHISPER_RELEASE = 'v1.9.1';
const WHISPER_ZIP =
  `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/whisper-bin-x64.zip`;
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const MODEL_MB = 148;
/**
 * The optional accuracy upgrade: `small.en`. `base.en` is what mishears "tyre
 * temps" as "tie attempts" (live call log, 2026-08-26) — small is the tier
 * where short domain phrases become reliable, at ~3× the inference cost — which
 * was NOT "well under a second" with the old flags (2.4 s here, 3–6 s in the
 * field; see the header and SMALL_BUDGET_MS). A download, like a
 * voice — 466 MB does not belong in the installer — but since v0.96 one the
 * app makes for itself in the background (EngineerService.ensureBetterEars),
 * because the v0.95 Download button was exactly what drivers never pressed.
 */
const SMALL_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin';
const SMALL_MODEL_MB = 466;
const ENGINE_MB = 8;
const WHISPER_RATE = 16000;

// Whisper conditions its decode on this prompt, so the vocabulary here is what
// mishears fall TOWARD. The first-week engineer_calls log is the source: "gap
// in front" arrived as "strap-in-front", "when should I pit" as "when should I
// pick Jeff", "fuel" as "Newall" — every phrase below is a wording drivers
// actually used (or the grammar advertises) that the old ten-word prompt did
// not cover.
const RACING_PROMPT =
  'Pit radio in a sim race. Driver asks the engineer: gap ahead, gap behind, gap in front, ' +
  'car ahead, car behind, last lap, sector times, best lap, fastest lap, position, ' +
  'laps left, time left, how much time is left, when should I pit, pit window, pit stop, ' +
  'how many laps till I need to pit, fuel, fuel level, fuel ratio, virtual energy, battery, ' +
  'tyres, tyre temps, temps, tyre status, tyre temperatures, tyre pressures, brakes, brake bias, traction control, damage, ' +
  'track limits, penalty points, yellow flags, safety car, weather, rain, track temperature, ' +
  'last five average, box this lap, backmarkers, traffic';

/* ---- Decode tuning (see the header for the measurements) ------------------ */

/**
 * small.en is worth its accuracy only while it answers inside this. Above it
 * base.en (≈3× cheaper) is the better engineer: a right answer two seconds
 * late, mid-corner, is a wrong answer.
 */
const SMALL_BUDGET_MS = 1300;

/**
 * Worker threads for one transcription: physical cores − 1 (the sim's main
 * thread keeps a core), at least 4 — the old fixed value — and at most 8,
 * past which ggml stops scaling on a clip this short. `logical` is the OS
 * logical-processor count; SMT is assumed (logical / 2 = physical), which
 * errs low on the rare non-SMT part rather than oversubscribing.
 */
function sttThreads(logical = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) {
  const n = Math.max(1, Math.floor(Number(logical) || 1));
  const physical = Math.max(1, Math.floor(n / 2));
  return Math.max(Math.min(4, n), Math.min(8, physical - 1));
}

/**
 * Encoder context for a clip of `audioMs` (the padded 16 kHz WAV). Whisper's
 * encoder always runs its full window — 1500 frames, 30 s — unless told
 * otherwise, and that pass was most of every question's cost. A push-to-talk
 * listen is at most 6 s, so 512 frames (10.24 s) covers it with room to
 * spare; 768 (15.36 s) for anything longer; full context past that.
 *
 * Deliberately coarse. Sizing the window TIGHT to the clip is what makes
 * whisper loop ("box this lap, box this lap, …" to the token limit): at
 * clip+64 frames 17 of 30 test clips did, at 512 and 768 none did and every
 * transcript matched the full-context one — 6.9 s clips included.
 */
function audioCtxFor(audioMs) {
  const ms = Number(audioMs);
  if (!(ms > 0)) return 0;
  if (ms <= 8000) return 512;
  if (ms <= 13000) return 768;
  return 0;
}

/**
 * Duration of a PCM WAV from its header and size — the clip trimForWhisper
 * wrote, so 16 kHz mono 16-bit in practice, but read rather than assumed.
 * 0 when it cannot tell (audioCtxFor then keeps the full window).
 */
function wavDurationMs(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(64);
      const got = fs.readSync(fd, head, 0, 64, 0);
      if (got < 44 || head.toString('ascii', 0, 4) !== 'RIFF') return 0;
      const channels = head.readUInt16LE(22) || 1;
      const rate = head.readUInt32LE(24) || WHISPER_RATE;
      const bits = head.readUInt16LE(34) || 16;
      const bytes = fs.fstatSync(fd).size - 44;
      return Math.max(0, (bytes / ((bits / 8) * channels) / rate) * 1000);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

/**
 * The decode flags both paths share (CLI and resident server). Greedy (`-bs 1
 * -bo 1`): beam 5 bought nothing on these clips and cost up to a second on a
 * hard one. Temperature fallback stays ON — it is what re-decodes a looping
 * or garbled first pass, and costs nothing when the first pass is clean.
 */
function decodeArgs({ threads = sttThreads(), audioCtx = 0 } = {}) {
  const args = ['-t', String(threads), '-bs', '1', '-bo', '1', '-l', 'en', '-nt', '-ng', '-sns'];
  if (audioCtx > 0) args.push('-ac', String(audioCtx));
  return args;
}

/** The full one-shot whisper-cli argument list for one clip. */
function cliArgs({ model, wav, prefix, threads, audioCtx }) {
  return ['-m', model, '-f', wav, ...decodeArgs({ threads, audioCtx }), '-oj', '-of', prefix, '--prompt', RACING_PROMPT];
}

/**
 * Whether small.en is still earning its place on this machine. Fed every
 * small.en timing; base.en timings are ignored (there is nothing cheaper to
 * fall back to). Demotes on:
 *
 *   - a slow warm-up probe (`record(model, ms, { probe: true })`) — the idle
 *     machine is already over budget, so a loaded one will be worse;
 *   - two of the last three real questions over budget — one slow ask alone
 *     may be a cold disk cache or a Windows Update spike.
 *
 * Demotion lasts the app session: flapping between models mid-race would make
 * the engineer's hearing change under the driver. A restart re-earns it.
 */
class SpeedGuard {
  constructor({ budgetMs = SMALL_BUDGET_MS, window = 3, strikes = 2 } = {}) {
    this.budgetMs = budgetMs;
    this.window = window;
    this.strikes = strikes;
    this.samples = [];
    this.demoted = false;
    this.reason = null;
  }

  record(model, ms, { probe = false } = {}) {
    if (!isSmallModel(model) || this.demoted || !(ms >= 0)) return;
    if (probe) {
      if (ms > this.budgetMs) this.demote(`warm-up took ${Math.round(ms)} ms`);
      return;
    }
    this.samples.push(ms);
    if (this.samples.length > this.window) this.samples.shift();
    const slow = this.samples.filter((s) => s > this.budgetMs).length;
    if (slow >= this.strikes) this.demote(`${slow} of the last ${this.samples.length} questions over ${this.budgetMs} ms`);
  }

  demote(reason) {
    this.demoted = true;
    this.reason = reason;
  }

  allowsSmall() {
    return !this.demoted;
  }
}

function isSmallModel(model) {
  return /ggml-small\.en\.bin$/i.test(String(model || ''));
}

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
 * The engine and the model are looked up SEPARATELY, across one or more roots.
 *
 * v0.91 shipped the binaries without `ggml-base.en.bin` (a one-time download
 * into userData); v0.93 bundles the model again, but installs from the 0.91.x
 * era are still out there holding "engine from the resources dir, model from
 * userData" — a working install that anything resolving both halves from one
 * directory would conclude was absent.
 *
 * `dirs` takes a single path or a list in priority order.
 */
function roots(dirs) {
  return (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
}

function findCli(dirs) {
  for (const dir of roots(dirs)) {
    if (!fs.existsSync(dir)) continue;
    const cli = findNamed(dir, 'whisper-cli.exe') || findNamed(dir, 'main.exe');
    if (cli) return cli;
  }
  return null;
}

/** Where the model lives, or would be written, inside one specific root. */
function modelPath(dir) {
  return path.join(dir, 'ggml-base.en.bin');
}

/** Where the optional accuracy-upgrade model lives inside one root. */
function smallModelPath(dir) {
  return path.join(dir, 'ggml-small.en.bin');
}

/** A model file that plausibly downloaded whole, or null. */
function presentModel(file, minBytes) {
  try {
    if (fs.statSync(file).size > minBytes) return file;
  } catch {
    /* not here */
  }
  return null;
}

/**
 * The first root that actually holds a model — preferring `small.en` in ANY
 * root over `base.en` in any root, so downloading the upgrade takes effect
 * without touching the bundled model it upgrades.
 */
function findModel(dirs) {
  for (const dir of roots(dirs)) {
    const small = presentModel(smallModelPath(dir), 100_000_000);
    if (small) return small;
  }
  for (const dir of roots(dirs)) {
    const base = presentModel(modelPath(dir), 1_000_000);
    if (base) return base;
  }
  return null;
}

/**
 * The model a question should actually run on: findModel's choice (small.en
 * when installed), unless the speed guard has ruled small.en too slow on this
 * machine — then base.en, if there is one. A machine holding only small.en
 * keeps it; slow beats deaf.
 */
function pickModel(dirs, guard) {
  const best = findModel(dirs);
  if (!best || !isSmallModel(best) || !guard || guard.allowsSmall()) return best;
  for (const dir of roots(dirs)) {
    const base = presentModel(modelPath(dir), 1_000_000);
    if (base) return base;
  }
  return best;
}

/** Whether the accuracy-upgrade model is installed in any root. */
function smallInstalled(dirs) {
  return roots(dirs).some((dir) => presentModel(smallModelPath(dir), 100_000_000) !== null);
}

function installed(dirs) {
  return !!(findCli(dirs) && findModel(dirs));
}

function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const n = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float64Array(n);
  const scale = n === 1 ? 0 : (samples.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const x = i * scale;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const t = x - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

/**
 * Drop leading/trailing silence, resample to 16 kHz. Returns the output path
 * and duration, or null if there is no speech.
 */
function trimForWhisper(radioFx, inPath, outPath) {
  const { sampleRate, samples } = radioFx.readWav(inPath);
  const thresh = 0.02;
  let start = 0;
  let end = samples.length - 1;
  while (start < end && Math.abs(samples[start]) < thresh) start++;
  while (end > start && Math.abs(samples[end]) < thresh) end--;
  const pad = Math.round(sampleRate * 0.12);
  start = Math.max(0, start - pad);
  end = Math.min(samples.length - 1, end + pad);
  const cut = samples.subarray(start, end + 1);
  const durationMs = (cut.length / sampleRate) * 1000;
  // 180 ms, down from 280: a crisp one-word command ("box", "fuel") is real
  // speech at ~200 ms, and dropping it here was one of the ways a short
  // command died without ever reaching a recognizer.
  if (durationMs < 180) return null;
  let out = resample(cut, sampleRate, WHISPER_RATE);
  // Whisper is trained on longer windows and is unreliable — silent output,
  // hallucinated syllables — on sub-second clips. Padding a short utterance
  // out to ~1.2 s with trailing silence costs nothing and measurably steadies
  // one-word commands; longer clips pass through untouched.
  const MIN_SAMPLES = Math.round(WHISPER_RATE * 1.2);
  if (out.length < MIN_SAMPLES) {
    const padded = new Float64Array(MIN_SAMPLES);
    padded.set(out);
    out = padded;
  }
  radioFx.writeWav(outPath, WHISPER_RATE, out);
  return { path: outPath, durationMs };
}

/** whisper-cli's `-oj` output, flattened to one line of text. */
function readCliJson(jsonPath) {
  let heard = '';
  if (fs.existsSync(jsonPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      heard = (j.transcription || [])
        .map((s) => (s.text || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    } catch {
      heard = '';
    }
  }
  try {
    fs.rmSync(jsonPath, { force: true });
  } catch {
    /* ignore */
  }
  return heard;
}

/* ---- The resident engine ---------------------------------------------------
 * One per process. `warm()` (EngineerService.start) brings a whisper-server up
 * holding the model the next question will want; `release()` (stop) lets it go
 * after a grace period, because syncEngineer is stop-then-start on every
 * settings change and reloading 466 MB for each would be silly. Every question
 * re-checks that the server holds the model pickModel wants — small.en landing
 * mid-session, or the guard demoting it, swaps the server in the background
 * while that one question takes the CLI.
 */

/** A resident small.en holds ~0.6 GB; below this much RAM the CLI is kinder. */
const RESIDENT_MIN_RAM = 12 * 1024 ** 3;
/** How long a released server lingers for a stop-then-start to reclaim it. */
const RELEASE_GRACE_MS = 60 * 1000;
/** After a server failure, the CLI answers alone for this long. */
const SERVER_RETRY_MS = 5 * 60 * 1000;
/** A question the server has not answered in this long goes to the CLI. */
const SERVER_TIMEOUT_MS = 6000;

const engine = {
  guard: new SpeedGuard(),
  server: null,
  wanted: false,
  dirs: null,
  failedAt: 0,
  releaseTimer: null,
  /** Seams for scripts/test-stt.js — production never touches these. */
  execFile,
  makeServer: (opts) => new WhisperServer(opts),
  totalmem: () => os.totalmem(),
  now: () => Date.now(),
};

function residentAllowed() {
  if (process.env.APEX_WHISPER_RESIDENT === '0') return false;
  return engine.totalmem() >= RESIDENT_MIN_RAM;
}

/** whisper-server.exe beside the CLI, or null (older installs never had one). */
function findServer(dirs) {
  const cli = findCli(dirs);
  if (!cli) return null;
  const exe = path.join(path.dirname(cli), 'whisper-server.exe');
  return fs.existsSync(exe) ? exe : null;
}

/** A 1.2 s near-silent clip for the warm-up probe (encoder cost is length-, not content-bound). */
function probeWav() {
  const file = path.join(os.tmpdir(), 'apex-whisper-probe.wav');
  if (!fs.existsSync(file)) {
    const n = Math.round(WHISPER_RATE * 1.2);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(WHISPER_RATE, 24);
    buf.writeUInt32LE(WHISPER_RATE * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(n * 2, 40);
    fs.writeFileSync(file, buf);
  }
  return file;
}

function stopServer() {
  const s = engine.server;
  engine.server = null;
  if (s) s.stop();
}

/**
 * Bring the resident server in line with the model questions will use. Never
 * rejects and never blocks a caller that does not await it.
 */
async function ensureServer(dirs) {
  if (!engine.wanted || !residentAllowed()) return null;
  if (engine.failedAt && engine.now() - engine.failedAt < SERVER_RETRY_MS) return null;
  const model = pickModel(dirs, engine.guard);
  const exe = findServer(dirs);
  if (!model || !exe) return null;
  if (engine.server && engine.server.model === model && !engine.server.dead) return engine.server;
  stopServer();
  const server = engine.makeServer({ exe, model, threads: sttThreads() });
  engine.server = server;
  try {
    await server.start();
    // The warm-up doubles as the speed probe: the first inference allocates
    // and pages in everything, and its time on an idle machine is a floor on
    // what a question will cost mid-race.
    const t0 = engine.now();
    await server.transcribe(probeWav(), { prompt: RACING_PROMPT, audioCtx: audioCtxFor(1200), timeoutMs: 15000 });
    engine.guard.record(model, engine.now() - t0, { probe: true });
    if (engine.server !== server) return null; // replaced while warming
    if (isSmallModel(model) && !engine.guard.allowsSmall()) {
      // Too slow here: swap to base.en now, before anyone asks.
      return ensureServer(dirs);
    }
    return server;
  } catch (err) {
    if (engine.server === server) {
      stopServer();
      engine.failedAt = engine.now();
    }
    console.warn('[engineer] whisper-server unavailable, using the one-shot CLI:', err && err.message ? err.message : err);
    return null;
  }
}

/**
 * Pre-load the model for the next question (EngineerService.start). Returns a
 * promise for tests; production fires and forgets.
 */
function warm(dirs) {
  if (engine.releaseTimer) clearTimeout(engine.releaseTimer);
  engine.releaseTimer = null;
  engine.wanted = true;
  engine.dirs = dirs;
  return ensureServer(dirs).catch(() => null);
}

/** The engineer stopped: let the server go, after a grace period (see above). */
function release(graceMs = RELEASE_GRACE_MS) {
  engine.wanted = false;
  if (engine.releaseTimer) clearTimeout(engine.releaseTimer);
  engine.releaseTimer = null;
  if (!engine.server) return;
  if (graceMs <= 0) {
    stopServer();
    return;
  }
  engine.releaseTimer = setTimeout(() => {
    engine.releaseTimer = null;
    if (!engine.wanted) stopServer();
  }, graceMs);
  if (engine.releaseTimer.unref) engine.releaseTimer.unref();
}

/** Stop everything now (app quit, tests). */
function shutdown() {
  release(0);
}

/** For the status line and the tests: what the ears are doing right now. */
function sttState() {
  return {
    smallDemoted: engine.guard.demoted,
    demotedReason: engine.guard.reason,
    resident: !!(engine.server && engine.server.ready),
    residentModel: engine.server ? path.basename(engine.server.model) : null,
    threads: sttThreads(),
  };
}

/** One clip through the one-shot CLI. */
function runCli(cli, model, wav, audioCtx) {
  const prefix = wav.replace(/\.wav$/i, '');
  const jsonPath = `${prefix}.json`;
  try {
    fs.rmSync(jsonPath, { force: true });
  } catch {
    /* ignore */
  }
  const cliDir = path.dirname(cli);
  return new Promise((resolve, reject) => {
    engine.execFile(
      cli,
      cliArgs({ model, wav, prefix, threads: sttThreads(), audioCtx }),
      {
        cwd: cliDir,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 12 * 1024 * 1024,
        env: { ...process.env, PATH: `${cliDir}${path.delimiter}${process.env.PATH || ''}` },
      },
      (err) => {
        if (err) {
          try {
            fs.rmSync(jsonPath, { force: true });
          } catch {
            /* ignore */
          }
          reject(new Error(`whisper-cli: ${err.message}`));
          return;
        }
        resolve(readCliJson(jsonPath));
      },
    );
  });
}

/**
 * Async transcription for the app: the beta.6 `spawnSync` froze the Electron
 * main process — IPC, status pushes, the lot — for the length of the
 * transcription (up to its 20 s timeout on a hang). The resident server when
 * it holds the right model, the one-shot CLI otherwise (and whenever the
 * server stumbles). Resolves `{ text, ms, model, via }`; `ms` is what
 * engineer_calls.stt_ms records, and feeds the speed guard.
 */
async function transcribeAsync(dirs, wav) {
  const cli = findCli(dirs);
  const model = pickModel(dirs, engine.guard);
  if (!cli || !model) throw new Error('whisper not installed');
  const audioCtx = audioCtxFor(wavDurationMs(wav));
  const started = engine.now();

  const server = engine.server;
  if (server && server.ready && !server.dead && server.model === model) {
    try {
      const { text } = await server.transcribe(wav, { prompt: RACING_PROMPT, audioCtx, timeoutMs: SERVER_TIMEOUT_MS });
      const ms = engine.now() - started;
      engine.guard.record(model, ms);
      if (engine.wanted && pickModel(dirs, engine.guard) !== model) void ensureServer(dirs);
      return { text, ms, model, via: 'server' };
    } catch (err) {
      if (engine.server === server) {
        stopServer();
        engine.failedAt = engine.now();
      }
      console.warn('[engineer] whisper-server failed a question, retrying on the CLI:', err && err.message ? err.message : err);
    }
  }

  const cliStarted = engine.now();
  const text = await runCli(cli, model, wav, audioCtx);
  const ms = engine.now() - started;
  engine.guard.record(model, engine.now() - cliStarted);
  // The server was missing or held the wrong model: fix that for the NEXT
  // question, now that this one no longer competes for the CPU.
  if (engine.wanted) void ensureServer(dirs);
  return { text, ms, model, via: 'cli' };
}

/**
 * The sync one-shot, for the spike script (a plain CLI that can block all it
 * likes). Same flags as the app.
 */
function transcribe(dirs, wav) {
  const cli = findCli(dirs);
  const model = findModel(dirs);
  if (!cli || !model) throw new Error('whisper not installed');
  const prefix = wav.replace(/\.wav$/i, '');
  const jsonPath = `${prefix}.json`;
  try {
    fs.rmSync(jsonPath, { force: true });
  } catch {
    /* ignore */
  }
  const cliDir = path.dirname(cli);
  const started = Date.now();
  const r = spawnSync(cli, cliArgs({ model, wav, prefix, threads: sttThreads(), audioCtx: audioCtxFor(wavDurationMs(wav)) }), {
    encoding: 'utf8',
    cwd: cliDir,
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, PATH: `${cliDir}${path.delimiter}${process.env.PATH || ''}` },
  });
  const ms = Date.now() - started;
  if (r.status !== 0) {
    throw new Error(`whisper-cli exited ${r.status}`);
  }
  return { text: readCliJson(jsonPath), ms };
}

/**
 * Fetch whatever is missing into `dir`. `fetchFn` is EngineerService.fetch
 * bound, so the panel gets the same progress bar as a voice download, and
 * `progressId` is the status.progress.voiceId the panel keys off.
 *
 * `extraRoots` are read-only places the engine may ALREADY live — the packaged
 * resources dir, in practice. Without them a bundled-engine install would pull
 * the 8 MB zip again on every fresh machine, which is both a wasted download
 * and the unsigned-exe-into-AppData behaviour the bundling exists to avoid.
 */
async function download(dir, fetchFn, progressId, extraRoots) {
  fs.mkdirSync(dir, { recursive: true });
  const engineRoots = [...roots(extraRoots), dir];
  if (!findCli(engineRoots)) {
    const zip = path.join(dir, 'whisper.zip');
    await fetchFn(WHISPER_ZIP, zip, ENGINE_MB, progressId);
    const staging = path.join(dir, '_extract');
    fs.rmSync(staging, { recursive: true, force: true });
    await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${staging}' -Force`],
        (err) => (err ? reject(err) : resolve()),
      );
    });
    // Keep the Release/ tree as-is — ggml DLLs have to sit next to whisper-cli.
    for (const f of fs.readdirSync(staging)) {
      const from = path.join(staging, f);
      const to = path.join(dir, f);
      if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(from, to);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    if (!findCli(dir)) throw new Error('whisper-cli.exe missing from the zip');
  }
  if (!findModel([...roots(extraRoots), dir])) {
    await fetchFn(MODEL_URL, modelPath(dir), MODEL_MB, progressId);
  }
}

/**
 * Fetch the optional `small.en` accuracy upgrade into `dir`. The engine must
 * already be installed (it ships bundled); this only adds the bigger model,
 * which {@link findModel} then prefers automatically.
 */
async function downloadSmall(dir, fetchFn, progressId) {
  fs.mkdirSync(dir, { recursive: true });
  if (!smallInstalled(dir)) {
    await fetchFn(SMALL_MODEL_URL, smallModelPath(dir), SMALL_MODEL_MB, progressId);
  }
}

module.exports = {
  MODEL_MB,
  SMALL_MODEL_MB,
  installed,
  smallInstalled,
  findCli,
  findModel,
  download,
  downloadSmall,
  trimForWhisper,
  transcribe,
  transcribeAsync,
  // Latency: the resident engine, the speed guard and the decode tuning.
  warm,
  release,
  shutdown,
  sttState,
  pickModel,
  findServer,
  sttThreads,
  audioCtxFor,
  wavDurationMs,
  decodeArgs,
  cliArgs,
  SpeedGuard,
  RACING_PROMPT,
  SMALL_BUDGET_MS,
  _engine: engine,
};
