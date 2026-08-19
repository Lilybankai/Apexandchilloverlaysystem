/**
 * scripts/spike-whisper.js — Tier 2 speech-to-text fork, measured on this PC.
 * -----------------------------------------------------------------------------
 * The closed grammar cannot transcribe a sentence it was not given. Before any
 * proxy is built we have to know whether local whisper.cpp `base.en` can, in
 * under ~700 ms, on a racing PC's CPU. That answer decides the pipeline:
 *
 *   fast + clean  → audio never leaves the PC; the Edge Function sees text
 *   slow          → small.en will be slower; weigh tiny.en vs cloud STT
 *   sloppy        → fetch small.en and re-run; cloud STT if that is still mess
 *
 * Offline (no microphone — this is the default):
 *
 *   1. Verify every installed catalog Piper voice actually synthesises a WAV,
 *      then run it through the radio channel. Missing catalog voices are
 *      HEAD-checked so a dead HuggingFace path fails here, not on a tester.
 *   2. Synthesise a handful of free-form pit-wall questions with Alan (or
 *      whichever voice we have), resample to 16 kHz, and time whisper.cpp.
 *
 * Live (the 10-minute mic test — run this when you are at the desk):
 *
 *   node scripts/spike-whisper.js --mic
 *
 * Same 6-second listen window as the app. Press Enter, speak a question, read
 * what it heard and how long it took. Ctrl+C when you have enough.
 *
 * Other:
 *   node scripts/setup-whisper.js            # once (~150 MB)
 *   node scripts/spike-whisper.js            # offline, this session
 *   node scripts/spike-whisper.js --wav x.wav
 *   node scripts/spike-whisper.js --model small.en --threads 2
 *   node scripts/spike-whisper.js --voices-only
 *   node scripts/spike-whisper.js --keep     # leave fixture WAVs in tools/whisper/fixtures
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { VOICES } = require('../electron/engineer');
const { readWav, writeWav, radioify } = require('../electron/radio-fx');

const TARGET_INFER_MS = 700;
const WER_PASS = 0.15;
const LISTEN_WINDOW_SEC = 6;
const WHISPER_RATE = 16000;

const ROOT = path.join(__dirname, '..');
const WHISPER_DIR = path.join(ROOT, 'tools', 'whisper');
const PIPER_SPIKE = path.join(ROOT, 'tools', 'piper', 'piper');
const PIPER_APP = path.join(process.env.APPDATA || '', 'apex-overlay-system', 'piper');
const HF_VOICE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0';

/** Free-form questions Tier 2 has to hear — not the closed grammar. */
const FIXTURES = [
  'Gap ahead, two point four seconds.',
  'Safety car is out and I have half a tank, what do we do?',
  'Should I box this lap or stretch another two?',
  'How is virtual energy looking to the flag?',
  'The car ahead is on old tyres, can I catch them?',
  'Fuel for twenty eight laps, energy for twenty four.',
  'Yellow flags in sector two, short shift through there.',
  'Box this lap, box box, tyres and fuel.',
];

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const modelName = opt('--model', 'base.en');
const threadsSpec = opt('--threads', '2,4');
const wavArg = opt('--wav', null);
const mic = has('--mic');
const voicesOnly = has('--voices-only');
const keep = has('--keep');
const seconds = Number(opt('--seconds', String(LISTEN_WINDOW_SEC)));

/* ---- tiny utilities ------------------------------------------------------- */

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

function tokens(s) {
  return String(s)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9. ]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .map((t) => (t === 'tires' ? 'tyres' : t === 'tire' ? 'tyre' : t))
    .filter(Boolean);
}

/** Whisper writes "2.4" / "28"; Piper said "two point four" / "twenty eight". Same words. */
function foldSpokenNumbers(toks) {
  const ones = {
    zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9,
  };
  const teens = {
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  };
  const tens = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (tens[t] != null && i + 1 < toks.length && ones[toks[i + 1]] != null) {
      out.push(String(tens[t] + ones[toks[i + 1]]));
      i += 1;
      continue;
    }
    if (ones[t] != null && toks[i + 1] === 'point' && i + 2 < toks.length && ones[toks[i + 2]] != null) {
      out.push(`${ones[t]}.${ones[toks[i + 2]]}`);
      i += 2;
      continue;
    }
    if (tens[t] != null) { out.push(String(tens[t])); continue; }
    if (teens[t] != null) { out.push(String(teens[t])); continue; }
    if (ones[t] != null) { out.push(String(ones[t])); continue; }
    out.push(t);
  }
  return out;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function wer(ref, hyp) {
  const r = foldSpokenNumbers(tokens(ref));
  const h = foldSpokenNumbers(tokens(hyp));
  if (!r.length) return h.length ? 1 : 0;
  return levenshtein(r, h) / r.length;
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function fmtMs(n) {
  return n == null || !Number.isFinite(n) ? '    n/a' : String(Math.round(n)).padStart(7);
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

function toWhisperWav(inPath, outPath) {
  const { sampleRate, samples } = readWav(inPath);
  writeWav(outPath, WHISPER_RATE, resample(samples, sampleRate, WHISPER_RATE));
  return { sampleRate, durationMs: Math.round((samples.length / sampleRate) * 1000) };
}

function parseMs(text, label) {
  const re = new RegExp(`${label.replace(/\s+/g, '\\s+')}\\s*=\\s*([\\d.]+)\\s*ms`, 'i');
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
}

function voiceOnnxUrl(id) {
  const m = /^([a-z]{2,3})_([A-Z]{2})-(.+)-([a-z_]+)$/.exec(id);
  if (!m) return null;
  const [, lang, region, name, quality] = m;
  return `${HF_VOICE}/${lang}/${lang}_${region}/${name}/${quality}/${id}.onnx`;
}

function headOk(url) {
  try {
    const out = spawnSync(
      'curl.exe',
      ['-sSIL', '-o', 'NUL', '-w', '%{http_code}', url],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
    const code = Number(String(out.stdout || '').trim());
    return code >= 200 && code < 400;
  } catch {
    return false;
  }
}

/* ---- locate assets -------------------------------------------------------- */

function piperExe() {
  for (const d of [PIPER_SPIKE, PIPER_APP]) {
    const p = path.join(d, 'piper.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function installedVoices() {
  const seen = new Map();
  for (const d of [PIPER_SPIKE, PIPER_APP]) {
    if (!d || !fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.onnx') || f.endsWith('.onnx.json')) continue;
      const id = f.replace(/\.onnx$/i, '');
      if (!seen.has(id)) seen.set(id, path.join(d, f));
    }
  }
  return seen;
}

function ensureWhisper() {
  let cli = findCli(path.join(WHISPER_DIR, 'bin')) || findCli(WHISPER_DIR);
  let model = path.join(WHISPER_DIR, `ggml-${modelName}.bin`);
  if (!cli || !fs.existsSync(model)) {
    console.log('[whisper] assets missing — running setup-whisper.js…\n');
    const extra = modelName === 'base.en' ? [] : [modelName];
    const r = spawnSync(process.execPath, [path.join(__dirname, 'setup-whisper.js'), ...extra], {
      stdio: 'inherit',
    });
    if (r.status !== 0) process.exit(r.status || 1);
    cli = findCli(path.join(WHISPER_DIR, 'bin')) || findCli(WHISPER_DIR);
    model = path.join(WHISPER_DIR, `ggml-${modelName}.bin`);
  }
  if (!cli) {
    console.error('[whisper] whisper-cli.exe not found after setup');
    process.exit(1);
  }
  if (!fs.existsSync(model)) {
    console.error(`[whisper] model ggml-${modelName}.bin not found — try: node scripts/setup-whisper.js ${modelName}`);
    process.exit(1);
  }
  return { cli, model, cliDir: path.dirname(cli) };
}

function synthesize(exe, model, text, outWav) {
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  if (fs.existsSync(outWav)) fs.rmSync(outWav, { force: true });
  const r = spawnSync(exe, ['-m', model, '-f', outWav], {
    input: text.endsWith('\n') ? text : `${text}\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 45000,
  });
  if (r.status !== 0 || !fs.existsSync(outWav)) {
    const err = (r.stderr || r.stdout || r.error && r.error.message || '').slice(0, 400);
    throw new Error(`piper exited ${r.status}: ${err || 'no wav written'}`);
  }
}

function transcribe(cli, cliDir, model, wav, threads) {
  const prefix = wav.replace(/\.wav$/i, '');
  const jsonPath = `${prefix}.json`;
  if (fs.existsSync(jsonPath)) fs.rmSync(jsonPath, { force: true });
  const args = [
    '-m', model,
    '-f', wav,
    '-t', String(threads),
    '-l', 'en',
    '-nt',
    '-oj',
    '-of', prefix,
    '-ng',
    '-sns',
  ];
  const started = Date.now();
  const r = spawnSync(cli, args, {
    encoding: 'utf8',
    cwd: cliDir,
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, PATH: `${cliDir}${path.delimiter}${process.env.PATH || ''}` },
  });
  const wallMs = Date.now() - started;
  const log = `${r.stderr || ''}\n${r.stdout || ''}`;
  if (r.status !== 0) {
    throw new Error(`whisper-cli exited ${r.status}: ${log.slice(-500)}`);
  }
  const loadMs = parseMs(log, 'load time');
  const totalMs = parseMs(log, 'total time');
  const inferMs = loadMs != null && totalMs != null ? Math.max(0, totalMs - loadMs) : totalMs;
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
  if (!heard) {
    heard = String(r.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.replace(/^\[[^\]]+]\s*/, '').trim())
      .filter((l) => l && !/^whisper_/i.test(l) && !/^system_/i.test(l))
      .join(' ')
      .trim();
  }
  return { heard, wallMs, loadMs, inferMs, totalMs };
}

/* ---- phases --------------------------------------------------------------- */

function verifyPiperVoices(workDir) {
  console.log('\n== Piper voices (offline) ==');
  const exe = piperExe();
  if (!exe) {
    console.log('  FAIL  piper.exe not found — run: node scripts/setup-piper.js');
    return { ok: false, installed: 0 };
  }
  console.log(`  engine  ${path.relative(ROOT, exe)}`);

  const installed = installedVoices();
  const line = 'Gap ahead, 2.4 seconds, to Smith. Box this lap, box box.';
  let fails = 0;
  let okCount = 0;

  for (const v of VOICES) {
    const model = installed.get(v.id);
    if (!model) {
      const url = voiceOnnxUrl(v.id);
      const live = url ? headOk(url) : false;
      console.log(`  SKIP  ${v.label} (${v.id}) — not downloaded${live ? ', catalog still live' : ', CATALOG HEAD FAILED'}`);
      if (url && !live) fails++;
      continue;
    }
    const dry = path.join(workDir, `voice-${v.id}.wav`);
    const radio = path.join(workDir, `voice-${v.id}.radio.wav`);
    try {
      const t0 = Date.now();
      synthesize(exe, model, line, dry);
      const synthMs = Date.now() - t0;
      const info = readWav(dry);
      const dur = info.samples.length / info.sampleRate;
      if (dur < 0.6) throw new Error(`clip too short (${dur.toFixed(2)}s)`);
      radioify(dry, radio);
      const radioInfo = readWav(radio);
      okCount++;
      console.log(
        `  PASS  ${v.label.padEnd(22)} ${dur.toFixed(2)}s @ ${info.sampleRate} Hz, ` +
          `synth ${synthMs} ms, radio ${radioInfo.samples.length} samples`,
      );
    } catch (err) {
      fails++;
      console.log(`  FAIL  ${v.label} — ${err.message}`);
    }
  }

  console.log(`  ${okCount} voice(s) synthesised, ${VOICES.length - installed.size} catalog entries not on disk`);
  return { ok: fails === 0 && okCount > 0, installed: okCount };
}

function runSuite(cli, cliDir, model, wavs, threads) {
  const rows = [];
  for (const item of wavs) {
    const r = transcribe(cli, cliDir, model, item.wav, threads);
    const w = item.text ? wer(item.text, r.heard) : null;
    rows.push({ ...item, ...r, wer: w });
    const werBit = w == null ? '' : `  wer ${w.toFixed(2)}`;
    console.log(
      `  ${fmtMs(r.inferMs)} ms infer  ${fmtMs(r.loadMs)} ms load  ${fmtMs(r.wallMs)} ms wall` +
        `${werBit}  « ${r.heard || '(empty)'} »`,
    );
    if (item.text) console.log(`  ${''.padStart(52)}ref: ${item.text}`);
  }
  return rows;
}

function printVerdict(rows, threads) {
  const infers = rows.map((r) => r.inferMs);
  const wers = rows.map((r) => r.wer).filter((n) => n != null);
  const loads = rows.map((r) => r.loadMs);
  const medInfer = median(infers);
  const medWer = median(wers);
  const medLoad = median(loads);
  const slow = medInfer != null && medInfer > TARGET_INFER_MS;
  const sloppy = medWer != null && medWer > WER_PASS;

  console.log(`\n== Verdict  (${modelName}, ${threads} thread${threads === 1 ? '' : 's'}) ==`);
  console.log(`  median infer   ${fmtMs(medInfer)} ms   ${slow ? 'SLOW' : 'PASS'}  (target < ${TARGET_INFER_MS} ms)`);
  console.log(`  median WER     ${medWer == null ? '    n/a' : medWer.toFixed(2).padStart(7)}     ${sloppy ? 'SLOPPY' : 'PASS'}  (target < ${WER_PASS})`);
  console.log(`  median load    ${fmtMs(medLoad)} ms   (paid once if whisper stays resident, like Piper)`);

  let decision = 'settle';
  if (slow && sloppy) decision = 'both';
  else if (slow) decision = 'slow';
  else if (sloppy) decision = 'sloppy';
  return { decision, medInfer, medWer, medLoad, threads };
}

function printRollup(results) {
  if (!results.length) return;
  console.log(`\n== Rollup  (${modelName}, idle PC) ==`);
  for (const r of results) {
    const inferBit = r.medInfer == null ? 'n/a' : `${Math.round(r.medInfer)} ms`;
    const werBit = r.medWer == null ? 'n/a' : r.medWer.toFixed(2);
    console.log(`  ${r.threads} thread${r.threads === 1 ? ' ' : 's'}  infer ${inferBit.padStart(7)}   WER ${werBit}   ${r.decision.toUpperCase()}`);
  }
  const four = results.find((r) => r.threads >= 4 && r.decision === 'settle');
  const two = results.find((r) => r.threads === 2);
  const anySloppy = results.some((r) => r.decision === 'sloppy' || r.decision === 'both');
  const allSettle = results.every((r) => r.decision === 'settle');

  if (allSettle) {
    console.log('\n  SETTLE. Audio never leaves the PC; the proxy only ever receives text.');
    console.log('  Next: the Supabase Edge Function. Confirm on a mic:  node scripts/spike-whisper.js --mic');
    return;
  }
  if (four && two && two.decision === 'slow') {
    console.log('\n  IDLE SETTLE at 4 threads (whisper.cpp default) — clean transcript, under 700 ms.');
    console.log('  Stay-light (2 threads) missed the window. A racing PC with the sim + encoder');
    console.log('  on the other cores is the remaining risk, not accuracy.');
    console.log('  Next: 10-minute mic test, ideally with LMU running so the 4-thread burst');
    console.log('  is measured under load.  node scripts/spike-whisper.js --mic --threads 4');
    console.log('  If that blows the window: tiny.en at 2 threads, or cloud STT.');
    return;
  }
  if (anySloppy) {
    console.log('\n  SLOPPY. Next: node scripts/setup-whisper.js small.en && node scripts/spike-whisper.js --model small.en');
    console.log('  If small.en is still sloppy, cloud STT (the proxy then receives audio).');
    return;
  }
  console.log('\n  SLOW. small.en will be slower. Weigh tiny.en vs cloud STT before the proxy.');
  console.log('  Try: node scripts/setup-whisper.js tiny.en && node scripts/spike-whisper.js --model tiny.en --threads 2');
}

async function runMic(cli, cliDir, model, threads) {
  const recorder = path.join(__dirname, 'voice-recorder.ps1');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-whisper-mic-'));
  console.log('\n== Mic test ==');
  console.log(`  ${seconds}s listen window (same as the app). Press Enter to record, Ctrl+C to stop.`);
  console.log(`  Speak free-form: "safety car is out and I have half a tank, what do we do?"`);
  console.log(`  work dir ${workDir}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  let n = 0;
  const rows = [];
  try {
    while (true) {
      await ask('  [Enter] to record  ');
      n += 1;
      const wav = path.join(workDir, `ask-${String(n).padStart(2, '0')}.wav`);
      console.log(`  recording ${seconds}s…`);
      const rec = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', recorder, '-OutPath', wav, '-Seconds', String(seconds)],
        { encoding: 'utf8', windowsHide: true, timeout: (seconds + 15) * 1000 },
      );
      if (rec.status !== 0 || !fs.existsSync(wav)) {
        console.log(`  recorder failed: ${(rec.stderr || rec.stdout || rec.error && rec.error.message || '').trim()}`);
        continue;
      }
      const info = readWav(wav);
      console.log(`  captured ${(info.samples.length / info.sampleRate).toFixed(2)}s — transcribing…`);
      const r = transcribe(cli, cliDir, model, wav, threads);
      rows.push(r);
      console.log(
        `  ${fmtMs(r.inferMs)} ms infer  ${fmtMs(r.loadMs)} ms load  ${fmtMs(r.wallMs)} ms wall`,
      );
      console.log(`  heard: ${r.heard || '(empty)'}\n`);
    }
  } catch (err) {
    if (err && err.message !== 'canceled') throw err;
  } finally {
    rl.close();
  }
  if (rows.length) {
    console.log(`  ${rows.length} take(s). median infer ${fmtMs(median(rows.map((r) => r.inferMs)))} ms`);
  }
}

/* ---- main ----------------------------------------------------------------- */

async function main() {
  const workDir = keep
    ? path.join(WHISPER_DIR, 'fixtures')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'apex-whisper-'));
  fs.mkdirSync(workDir, { recursive: true });
  if (!keep) {
    process.on('exit', () => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  }

  const piperOk = voicesOnly || (!wavArg && !mic)
    ? verifyPiperVoices(workDir)
    : { ok: true, installed: 0 };
  if (voicesOnly) {
    process.exit(piperOk.ok ? 0 : 1);
  }

  const { cli, model, cliDir } = ensureWhisper();
  const threadList = threadsSpec
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0);
  if (!threadList.length) {
    console.error('--threads needs a positive number (or a comma list like 2,4)');
    process.exit(2);
  }

  console.log(`\n== whisper.cpp ${modelName} ==`);
  console.log(`  cli    ${path.relative(ROOT, cli)}`);
  console.log(`  model  ${path.relative(ROOT, model)}  (${(fs.statSync(model).size / 1e6).toFixed(0)} MB)`);
  console.log(`  threads ${threadList.join(', ')}   target infer < ${TARGET_INFER_MS} ms`);

  if (mic) {
    await runMic(cli, cliDir, model, threadList[0]);
    return;
  }

  let wavs;
  if (wavArg) {
    if (!fs.existsSync(wavArg)) {
      console.error(`wav not found: ${wavArg}`);
      process.exit(1);
    }
    const out = path.join(workDir, 'input-16k.wav');
    const info = toWhisperWav(wavArg, out);
    console.log(`  input  ${wavArg}  (${info.durationMs} ms @ ${info.sampleRate} Hz → 16 kHz)`);
    wavs = [{ wav: out, text: opt('--ref', null) }];
  } else {
    const exe = piperExe();
    const voices = installedVoices();
    const alan = voices.get('en_GB-alan-medium') || [...voices.values()][0];
    if (!exe || !alan) {
      console.error('Need Piper + at least one voice for the offline fixtures (or pass --wav / --mic).');
      process.exit(1);
    }
    console.log(`  speaker ${path.basename(alan, '.onnx')}`);
    wavs = [];
    for (let i = 0; i < FIXTURES.length; i++) {
      const text = FIXTURES[i];
      const raw = path.join(workDir, `fx-${String(i + 1).padStart(2, '0')}.wav`);
      const out = path.join(workDir, `fx-${String(i + 1).padStart(2, '0')}-16k.wav`);
      synthesize(exe, alan, text, raw);
      const info = toWhisperWav(raw, out);
      wavs.push({ wav: out, text, durationMs: info.durationMs });
      console.log(`  fixture ${String(i + 1).padStart(2, '0')}  ${info.durationMs} ms  ${text}`);
    }
  }

  const results = [];
  for (const threads of threadList) {
    console.log(`\n-- ${threads} thread${threads === 1 ? '' : 's'} --`);
    const rows = runSuite(cli, cliDir, model, wavs, threads);
    results.push(printVerdict(rows, threads));
  }
  printRollup(results);

  if (keep) console.log(`\n  fixtures kept in ${path.relative(ROOT, workDir)}`);
  return results;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
