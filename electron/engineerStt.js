/**
 * electron/engineerStt.js — local whisper.cpp for Tier-2 free-form questions.
 * -----------------------------------------------------------------------------
 * Audio never leaves the PC. This module downloads the official CPU binary and
 * `base.en` into `<userData>/whisper/` (same on-demand pattern as Piper voices),
 * trims silence from a push-to-talk clip, and transcribes it.
 *
 * One-shot whisper-cli per question for beta: ~100 ms of model load on top of
 * inference. A resident whisper-server is the follow-up if a race load blows
 * the 700 ms window after we trim to speech.
 */

'use strict';

const { execFile, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WHISPER_RELEASE = 'v1.9.1';
const WHISPER_ZIP =
  `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/whisper-bin-x64.zip`;
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const MODEL_MB = 148;
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
  'tyres, tyre temperatures, tyre pressures, brakes, brake bias, traction control, damage, ' +
  'track limits, penalty points, yellow flags, safety car, weather, rain, track temperature, ' +
  'last five average, box this lap, backmarkers, traffic';

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

/** The first root that actually holds the model, or null. */
function findModel(dirs) {
  for (const dir of roots(dirs)) {
    const model = modelPath(dir);
    try {
      if (fs.statSync(model).size > 1_000_000) return model;
    } catch {
      /* not here — try the next root */
    }
  }
  return null;
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
  if (durationMs < 280) return null;
  radioFx.writeWav(outPath, WHISPER_RATE, resample(cut, sampleRate, WHISPER_RATE));
  return { path: outPath, durationMs };
}

/**
 * Async transcription for the app: the beta.6 `spawnSync` froze the Electron
 * main process — IPC, status pushes, the lot — for the length of the
 * transcription (up to its 20 s timeout on a hang). Same CLI, same flags,
 * `execFile` instead. The sync `transcribe` below stays for the spike script,
 * which is a plain CLI and can block all it likes.
 */
function transcribeAsync(dirs, wav) {
  const cli = findCli(dirs);
  const model = findModel(dirs);
  if (!cli || !model) return Promise.reject(new Error('whisper not installed'));
  const prefix = wav.replace(/\.wav$/i, '');
  const jsonPath = `${prefix}.json`;
  try {
    fs.rmSync(jsonPath, { force: true });
  } catch {
    /* ignore */
  }
  const cliDir = path.dirname(cli);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      [
        '-m', model,
        '-f', wav,
        '-t', '4',
        '-l', 'en',
        '-nt',
        '-oj',
        '-of', prefix,
        '-ng',
        '-sns',
        '--prompt', RACING_PROMPT,
      ],
      {
        cwd: cliDir,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 12 * 1024 * 1024,
        env: { ...process.env, PATH: `${cliDir}${path.delimiter}${process.env.PATH || ''}` },
      },
      (err) => {
        const ms = Date.now() - started;
        if (err) {
          reject(new Error(`whisper-cli: ${err.message}`));
          return;
        }
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
        resolve({ text: heard, ms });
      },
    );
  });
}

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
  const r = spawnSync(
    cli,
    [
      '-m', model,
      '-f', wav,
      '-t', '4',
      '-l', 'en',
      '-nt',
      '-oj',
      '-of', prefix,
      '-ng',
      '-sns',
      '--prompt', RACING_PROMPT,
    ],
    {
      encoding: 'utf8',
      cwd: cliDir,
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 12 * 1024 * 1024,
      env: { ...process.env, PATH: `${cliDir}${path.delimiter}${process.env.PATH || ''}` },
    },
  );
  const ms = Date.now() - started;
  if (r.status !== 0) {
    throw new Error(`whisper-cli exited ${r.status}`);
  }
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
  return { text: heard, ms };
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

module.exports = {
  MODEL_MB,
  installed,
  findCli,
  findModel,
  download,
  trimForWhisper,
  transcribe,
  transcribeAsync,
};
