/**
 * scripts/setup-piper.js — fetch the Piper TTS engine + the engineer's voice.
 * -----------------------------------------------------------------------------
 * Piper is the race engineer's local voice: free, neural, offline, ~0.03× real
 * time on CPU once resident. This drops it in `tools/piper/piper/` (gitignored
 * — ~90 MB of binaries and model don't belong in git), where
 * `spike-voice-engineer.js` looks for it. Safe to re-run; it skips what exists.
 *
 *   node scripts/setup-piper.js            # engine + en_GB-alan-medium
 *   node scripts/setup-piper.js <voice>    # also fetch another voice, e.g.
 *                                          #   en_GB-northern_english_male-medium
 *
 * Voices live at huggingface.co/rhasspy/piper-voices — the name encodes the
 * path: en_GB-alan-medium → en/en_GB/alan/medium/.
 *
 * Downloads shell out to curl.exe, which ships with Windows 10+ — no new
 * dependency for a one-time setup step.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PIPER_RELEASE =
  'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0';
const DEFAULT_VOICE = 'en_GB-alan-medium';

const root = path.join(__dirname, '..');
const dir = path.join(root, 'tools', 'piper');
const engineDir = path.join(dir, 'piper');

function curl(url, out) {
  console.log(`  ${url}\n  -> ${path.relative(root, out)}`);
  execFileSync('curl.exe', ['-sSL', '-o', out, url], { stdio: 'inherit' });
}

/** en_GB-alan-medium -> en/en_GB/alan/medium/en_GB-alan-medium */
function voiceUrlBase(voice) {
  const m = /^([a-z]{2,3})_([A-Z]{2})-(.+)-([a-z_]+)$/.exec(voice);
  if (!m) {
    console.error(`Voice name not understood: ${voice} (expected e.g. en_GB-alan-medium)`);
    process.exit(2);
  }
  const [, lang, region, name, quality] = m;
  return `${VOICES_BASE}/${lang}/${lang}_${region}/${name}/${quality}/${voice}`;
}

fs.mkdirSync(dir, { recursive: true });

if (fs.existsSync(path.join(engineDir, 'piper.exe'))) {
  console.log('[piper] engine already present');
} else {
  console.log('[piper] downloading engine…');
  const zip = path.join(dir, 'piper.zip');
  curl(PIPER_RELEASE, zip);
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`,
  ]);
  fs.rmSync(zip, { force: true });
}

const voices = [DEFAULT_VOICE, ...process.argv.slice(2)];
for (const voice of voices) {
  const onnx = path.join(engineDir, `${voice}.onnx`);
  if (fs.existsSync(onnx)) {
    console.log(`[piper] voice ${voice} already present`);
    continue;
  }
  console.log(`[piper] downloading voice ${voice}…`);
  const base = voiceUrlBase(voice);
  curl(`${base}.onnx`, onnx);
  curl(`${base}.onnx.json`, `${onnx}.json`);
}

console.log('[piper] done — the spike will pick it up automatically.');
