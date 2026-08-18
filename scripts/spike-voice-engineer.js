/**
 * scripts/spike-voice-engineer.js — Tier 1 voice engineer, end to end.
 * -----------------------------------------------------------------------------
 * The v2 race-engineer plan's first proof: ask the pit wall a question out loud,
 * get an answer spoken back, with **no AI, no cloud and no cost** — the same
 * shape CrewChief has shipped for a decade (fixed grammar in, canned phrasing
 * out), but answered from the overlay's own normalized telemetry.
 *
 *   npm start                      # in one terminal (demo mode is fine)
 *   node scripts/spike-voice-engineer.js        # in another
 *
 * Say "gap ahead", "laps left", "five lap average"… or type a phrase (or an
 * intent name) and press Enter — the keyboard path exercises exactly the same
 * pipeline, so the spike is testable on a machine with no microphone.
 *
 * Options:
 *   --url ws://127.0.0.1:17080/ws   overlay server socket (record-session's default)
 *   --confidence 0.85               minimum recognizer confidence to act on
 *   --mute                          print answers, don't speak them
 *   --no-mic                        keyboard only (skip the recognizer sidecar)
 *   --sapi                          force the old robotic SAPI voice (skip Piper)
 *   --model <path|name>             Piper voice model (default en_GB-alan-medium)
 *   --dry                           skip the radio effect (clean studio voice)
 *
 * ## The voice
 * Piper (tools/piper — `node scripts/setup-piper.js` fetches it) is the real
 * voice: free, local, neural, and ~0.03× real-time once the model is resident,
 * so answers start speaking near-instantly. It runs as one persistent process
 * (text lines in, WAV paths out) feeding a player sidecar; SAPI remains only as
 * the fallback when Piper isn't installed.
 *
 * ## Where the pieces live, and why
 * Answering is `dist/telemetry/engineerCommands.js` — pure, unit-tested,
 * replayable. This script only wires transport: the overlay WebSocket in (a
 * client, exactly like record-session.js — nothing added to the server loop),
 * and two PowerShell sidecars for ears and voice (System.Speech: offline, free,
 * preinstalled — CrewChief's own approach, so we know it lives happily on a
 * racing PC). The production version moves this wiring into the Electron main
 * process with a wheel-button push-to-talk (the panel already speaks gamepad);
 * the open-mic grammar here is the spike's stand-in.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const WebSocket = require('ws');

const { EngineerCommands } = require('../dist/telemetry/engineerCommands');

/* ---- the grammar: one table, shared with the recognizer ------------------- */

/**
 * Phrase → intent. Colon-separated alternates in the CrewChief mould; short,
 * distinct phrases recognize far better than sentences. This table is the
 * single source: the PowerShell sidecar loads it as JSON, and the keyboard
 * fallback matches against it, so the two paths can never drift.
 */
const GRAMMAR = [
  { intent: 'gapAhead', phrases: ['gap ahead', 'gap in front', 'gap front'] },
  { intent: 'gapBehind', phrases: ['gap behind', 'gap to the car behind'] },
  {
    intent: 'avgAhead',
    phrases: ['five lap average', 'five laps average front', 'average front', 'pace ahead', 'compare pace'],
  },
  {
    intent: 'carAhead',
    phrases: ["who's ahead", "who's in front", 'car ahead', 'car in front', "who am i chasing"],
  },
  { intent: 'carBehind', phrases: ["who's behind", 'car behind', "who's chasing me"] },
  {
    intent: 'traffic',
    phrases: ['backmarker', 'backmarkers', 'any traffic', 'traffic ahead', 'any backmarkers'],
  },
  { intent: 'lapsLeft', phrases: ['laps left', 'laps remaining', 'how many laps', 'how long left'] },
  { intent: 'fuel', phrases: ['fuel', 'fuel state', 'fuel level'] },
  { intent: 'lastLap', phrases: ['last lap', 'last lap time', 'lap time'] },
  { intent: 'position', phrases: ['position', 'what position am i in', 'where am i'] },
];

/* ---- arguments ------------------------------------------------------------ */

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const url = opt('--url', 'ws://127.0.0.1:17080/ws');
const minConfidence = Number(opt('--confidence', '0.85'));
const mute = argv.includes('--mute');
const noMic = argv.includes('--no-mic');
const forceSapi = argv.includes('--sapi');
const modelOpt = opt('--model', 'en_GB-alan-medium');

/* ---- the engineer --------------------------------------------------------- */

const engineer = new EngineerCommands();
let frames = 0;
let connected = false;

function ask(intent, via) {
  const a = engineer.answer(intent);
  const tag = connected ? '' : frames ? ' (demo data)' : ' (no telemetry)';
  console.log(`[${via}] ${intent} -> ${a.text}${tag}`);
  say(a.text);
}

/* ---- telemetry in (a client, like record-session.js) ---------------------- */

function connect() {
  const ws = new WebSocket(url);
  ws.on('open', () => console.log(`[ws] listening to ${url}`));
  ws.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame || !frame.session) return;
    frames++;
    connected = !!frame.connected;
    engineer.update(frame);
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    console.log(`[ws] not connected — is the overlay running? (npm start; demo mode is fine). Retrying in 3s…`);
    setTimeout(connect, 3000);
  });
}
connect();

/* ---- voice out ------------------------------------------------------------ */

/**
 * Preferred: Piper resident (text in, WAV path out) piped to a player sidecar.
 * Fallback: the SAPI speaker sidecar — robotic, but always present on Windows.
 */
const PIPER_DIR = path.join(__dirname, '..', 'tools', 'piper', 'piper');
const piperExe = path.join(PIPER_DIR, 'piper.exe');
const piperModel = fs.existsSync(modelOpt)
  ? modelOpt
  : path.join(PIPER_DIR, modelOpt.endsWith('.onnx') ? modelOpt : `${modelOpt}.onnx`);

let speaker = null; // whichever process accepts text lines
if (!mute) {
  if (!forceSapi && fs.existsSync(piperExe) && fs.existsSync(piperModel)) {
    const wavDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-engineer-voice-'));
    const player = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'voice-player.ps1')],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    player.stdout.on('data', () => {}); // READY / PLAYED acks
    const piper = spawn(piperExe, ['-m', piperModel, '--output_dir', wavDir], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // Piper prints one WAV path per synthesized line. Run it through the radio
    // channel (band-pass + drive + hiss + squelch — see radio-fx.js) and hand
    // the processed clip to the player. A few ms of DSP per clip; --dry skips
    // it for A/B listening.
    const { radioify } = require('../electron/radio-fx');
    const dry = argv.includes('--dry');
    readline.createInterface({ input: piper.stdout }).on('line', (line) => {
      let wav = line.trim();
      if (!wav) return;
      if (!dry) {
        try {
          const out = wav.replace(/\.wav$/i, '.radio.wav');
          radioify(wav, out);
          fs.rmSync(wav, { force: true });
          wav = out;
        } catch (err) {
          console.log(`[fx] radio effect failed (${err.message}) — playing dry`);
        }
      }
      if (player.stdin.writable) player.stdin.write(wav + '\n');
    });
    piper.on('exit', (code) => {
      console.log(`[tts] piper exited (${code}) — continuing text-only`);
      speaker = null;
    });
    process.on('exit', () => {
      try { piper.kill(); } catch {}
      try { player.kill(); } catch {}
      fs.rmSync(wavDir, { recursive: true, force: true });
    });
    speaker = piper;
    console.log(`[tts] Piper voice: ${path.basename(piperModel, '.onnx')}`);
  } else {
    if (!forceSapi) {
      console.log('[tts] Piper not found (run: node scripts/setup-piper.js) — falling back to SAPI');
    }
    speaker = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'voice-speaker.ps1')],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    speaker.stdout.on('data', () => {}); // READY / SPOKE acks
    speaker.on('exit', (code) => {
      console.log(`[tts] speaker exited (${code}) — continuing text-only`);
      speaker = null;
    });
  }
}

function say(text) {
  if (speaker && speaker.stdin.writable) speaker.stdin.write(text + '\n');
}

/* ---- voice in ------------------------------------------------------------- */

if (!noMic) {
  const grammarPath = path.join(os.tmpdir(), `apex-engineer-grammar-${process.pid}.json`);
  fs.writeFileSync(grammarPath, JSON.stringify(GRAMMAR)); // Node writes BOM-free
  const rec = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'voice-recognizer.ps1'),
      '-GrammarPath',
      grammarPath,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  readline.createInterface({ input: rec.stdout }).on('line', (line) => {
    const [kind, intent, conf, text] = line.split('\t');
    if (kind === 'READY') {
      console.log('[mic] listening — say "gap ahead", "laps left", "five lap average"…');
    } else if (kind === 'HEARD') {
      const c = Number(conf);
      if (c >= minConfidence) {
        ask(intent, `mic ${text} @${conf}`);
      } else {
        console.log(`[mic] heard "${text}" but only ${conf} confident — ignored`);
      }
    } else if (kind === 'ERROR') {
      console.log(`[mic] ${intent} — keyboard input still works`);
    }
  });
  rec.on('exit', (code) => {
    if (code) console.log(`[mic] recognizer exited (${code}) — keyboard input still works`);
    fs.rmSync(grammarPath, { force: true });
  });
  process.on('exit', () => {
    try {
      rec.kill();
    } catch {}
    fs.rmSync(grammarPath, { force: true });
  });
}

/* ---- keyboard fallback ----------------------------------------------------- */

const kb = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log('[kb] type a phrase (e.g. "gap ahead") or an intent name and press Enter. Ctrl-C quits.');
kb.on('line', (line) => {
  const said = line.trim().toLowerCase();
  if (!said) return;
  const def =
    GRAMMAR.find((d) => d.intent.toLowerCase() === said) ||
    GRAMMAR.find((d) => d.phrases.some((p) => p === said)) ||
    GRAMMAR.find((d) => d.phrases.some((p) => said.includes(p)));
  if (def) ask(def.intent, 'kb');
  else console.log(`[kb] no matching command. Known: ${GRAMMAR.map((d) => d.intent).join(', ')}`);
});
kb.on('close', () => process.exit(0));
