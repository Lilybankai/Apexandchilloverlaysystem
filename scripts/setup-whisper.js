/**
 * scripts/setup-whisper.js — fetch whisper.cpp + an English ggml model.
 * -----------------------------------------------------------------------------
 * The Tier-2 spike needs a free-form transcriber the closed grammar cannot be.
 * This drops the official Windows CPU binary and `base.en` into gitignored
 * `tools/whisper/`, matching setup-piper.js: safe to re-run, skips what exists,
 * shells out to curl.exe (ships with Windows 10+).
 *
 *   node scripts/setup-whisper.js              # engine + base.en (~142 MB)
 *   node scripts/setup-whisper.js small.en     # also fetch small.en (~466 MB)
 *   node scripts/setup-whisper.js tiny.en      # faster, sloppier local option
 *
 * Models: https://huggingface.co/ggerganov/whisper.cpp
 * Engine: ggml-org/whisper.cpp v1.9.1 `whisper-bin-x64.zip` (CPU, no CUDA —
 * a racing PC's GPU is already the sim + NVENC; the spike has to be honest).
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WHISPER_RELEASE = 'v1.9.1';
const WHISPER_ZIP =
  `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/whisper-bin-x64.zip`;
const MODELS_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const DEFAULT_MODEL = 'base.en';
const KNOWN = new Set(['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en']);

const root = path.join(__dirname, '..');
const dir = path.join(root, 'tools', 'whisper');
const engineDir = path.join(dir, 'bin');

function curl(url, out, progress) {
  console.log(`  ${url}\n  -> ${path.relative(root, out)}`);
  const flags = progress ? ['-L', '--progress-bar', '-o', out, url] : ['-sSL', '-o', out, url];
  execFileSync('curl.exe', flags, { stdio: 'inherit' });
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

/** Prefer whisper-cli.exe — the zip still ships a tiny main.exe stub beside it. */
function findCli(from) {
  return findNamed(from, 'whisper-cli.exe') || findNamed(from, 'main.exe');
}

fs.mkdirSync(dir, { recursive: true });

if (findCli(engineDir) || findCli(dir)) {
  console.log('[whisper] engine already present');
} else {
  console.log(`[whisper] downloading engine ${WHISPER_RELEASE}…`);
  fs.mkdirSync(engineDir, { recursive: true });
  const zip = path.join(dir, 'whisper.zip');
  curl(WHISPER_ZIP, zip, true);
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${engineDir}' -Force`,
  ]);
  fs.rmSync(zip, { force: true });
  const cli = findCli(engineDir);
  if (!cli) {
    console.error('[whisper] zip extracted but whisper-cli.exe was not inside it');
    process.exit(1);
  }
  console.log(`[whisper] engine: ${path.relative(root, cli)}`);
}

const models = [DEFAULT_MODEL, ...process.argv.slice(2)];
for (const name of models) {
  if (!KNOWN.has(name)) {
    console.error(`[whisper] unknown model '${name}' — expected one of ${[...KNOWN].join(', ')}`);
    process.exit(2);
  }
  const file = path.join(dir, `ggml-${name}.bin`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) {
    console.log(`[whisper] model ${name} already present`);
    continue;
  }
  console.log(`[whisper] downloading model ${name}…`);
  curl(`${MODELS_BASE}/ggml-${name}.bin`, file, true);
}

console.log('[whisper] done — the spike will pick it up automatically.');
