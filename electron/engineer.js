/**
 * electron/engineer.js — the Tier-1 race engineer, as an app service.
 * -----------------------------------------------------------------------------
 * The productized form of `scripts/spike-voice-engineer.js`: press the bound
 * wheel button, ask a question out loud, hear the answer over the radio. No AI,
 * no cloud, no per-use cost — answers come from `dist/telemetry/engineerCommands`
 * over the app's own WebSocket (a client, exactly like a widget; the 30 Hz loop
 * is untouched), and the voice is Piper through the `radio-fx` comms channel.
 *
 * ## Push-to-talk, not open mic
 * The recognizer holds the microphone **only inside the listen window**: the
 * bound button (action `engineer.ask`) sends one `LISTEN` command, the sidecar
 * runs a single `Recognize()` bounded to {@link LISTEN_WINDOW_SEC}, reports what
 * it heard, and goes back to blocking on stdin — where it captures nothing.
 * That is a privacy stance as much as a UX one: an overlay for streamers must
 * never be an always-hot microphone.
 *
 * ## Where the assets live
 * The Piper engine (~22 MB) and each voice (~63–121 MB) are downloaded on
 * demand into `<userData>/piper/` — never bundled: most operators will only
 * ever install one voice, and the installer stays small. `VOICES` is the
 * curated catalog; every entry was verified against the HuggingFace repo
 * (sample MP3 present, model present, size read from headers) on 2026-08-18.
 *
 * ## Why the PowerShell sidecars are -EncodedCommand, not .ps1 files
 * In a packaged app `electron/` lives inside app.asar, and PowerShell cannot
 * read a script from a virtual path — `-File` would need the scripts unpacked
 * or copied out at runtime. Encoding the (small) scripts from JS strings
 * removes the whole class of path problems, dev and packaged alike.
 *
 * Everything degrades to silence + a reported status: no engine, no voice, no
 * mic, no server — the app runs on, the Engineer tab says what is missing.
 */

'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/* -------------------------------------------------------------------------- */
/*  The grammar — one table for recognizer, panel help, and the spike          */
/* -------------------------------------------------------------------------- */

/**
 * Phrase → intent. Short, distinct phrases recognize far better than
 * sentences; the recognizer also loads each list wildcard-wrapped, so the
 * phrase works buried in a sentence ("mate, what's the gap ahead right now").
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

/* -------------------------------------------------------------------------- */
/*  Voice catalog                                                              */
/* -------------------------------------------------------------------------- */

const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0';
const PIPER_ZIP =
  'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';

/** en_GB-alan-medium → en/en_GB/alan/medium */
function voicePath(id) {
  const m = /^([a-z]{2,3})_([A-Z]{2})-(.+)-([a-z_]+)$/.exec(id);
  if (!m) return null;
  const [, lang, region, name, quality] = m;
  return `${lang}/${lang}_${region}/${name}/${quality}`;
}

/**
 * Curated, all single-speaker (multi-speaker models need a --speaker flag and
 * sound like a lottery without one). `sizeMb` is the real model size, read
 * from the repo's headers, so the download UI can show honest progress.
 */
const VOICES = [
  {
    id: 'en_GB-alan-medium',
    label: 'Alan',
    blurb: 'British male — calm, measured. The default engineer.',
    sizeMb: 63,
  },
  {
    id: 'en_GB-northern_english_male-medium',
    label: 'Northern English male',
    blurb: 'Gruffer, flatter delivery — an old-school pit wall.',
    sizeMb: 63,
  },
  {
    id: 'en_GB-alba-medium',
    label: 'Alba',
    blurb: 'Scottish female — bright and crisp on the radio.',
    sizeMb: 63,
  },
  {
    id: 'en_GB-jenny_dioco-medium',
    label: 'Jenny',
    blurb: 'Irish female — softer tone, very clear numbers.',
    sizeMb: 63,
  },
  {
    id: 'en_US-ryan-high',
    label: 'Ryan',
    blurb: 'American male — the highest-quality model in the list.',
    sizeMb: 121,
  },
  {
    id: 'en_US-joe-medium',
    label: 'Joe',
    blurb: 'American male — relaxed NASCAR-spotter energy.',
    sizeMb: 63,
  },
];

/** HuggingFace sample MP3 for a catalog voice — playable before downloading. */
function sampleUrl(id) {
  const p = voicePath(id);
  return p ? `${HF_BASE}/${p}/samples/speaker_0.mp3` : null;
}

/* -------------------------------------------------------------------------- */
/*  PowerShell sidecars (spawned via -EncodedCommand)                          */
/* -------------------------------------------------------------------------- */

/** Plays WAV paths from stdin synchronously, deleting each after playback. */
const PLAYER_PS = `
$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -and (Test-Path -LiteralPath $line)) {
    try { (New-Object System.Media.SoundPlayer $line).PlaySync() } catch { }
    try { Remove-Item -LiteralPath $line -Force } catch { }
    [Console]::Out.WriteLine('PLAYED'); [Console]::Out.Flush()
  }
}`;

/**
 * One-shot grammar recognition on command. Blocks on stdin; each LISTEN runs a
 * single bounded Recognize() — the microphone is captured only inside that
 * call. Grammar JSON path arrives via APEX_ENGINEER_GRAMMAR (EncodedCommand
 * takes no arguments). Runs synchronously throughout: event-handler output
 * does not reliably reach redirected stdout from another runspace.
 */
const RECOGNIZER_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
try {
  $defs = Get-Content -Raw -LiteralPath $env:APEX_ENGINEER_GRAMMAR | ConvertFrom-Json
  $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  foreach ($d in $defs) {
    $choices = New-Object System.Speech.Recognition.Choices
    foreach ($p in $d.phrases) { $choices.Add([string]$p) }
    $exact = New-Object System.Speech.Recognition.GrammarBuilder($choices)
    $g1 = New-Object System.Speech.Recognition.Grammar($exact)
    $g1.Name = [string]$d.intent
    $rec.LoadGrammar($g1)
    $wrapped = New-Object System.Speech.Recognition.GrammarBuilder
    $wrapped.AppendWildcard()
    $wrapped.Append($choices)
    $wrapped.AppendWildcard()
    $g2 = New-Object System.Speech.Recognition.Grammar($wrapped)
    $g2.Name = [string]$d.intent
    $rec.LoadGrammar($g2)
  }
  $rec.SetInputToDefaultAudioDevice()
} catch {
  [Console]::Out.WriteLine("ERROR\t" + $_.Exception.Message); [Console]::Out.Flush()
  exit 1
}
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $cmd = [Console]::In.ReadLine()
  if ($null -eq $cmd) { break }
  if ($cmd -notmatch '^LISTEN') { continue }
  $secs = 6
  if ($cmd -match 'LISTEN (\\d+)') { $secs = [int]$Matches[1] }
  $r = $rec.Recognize([TimeSpan]::FromSeconds($secs))
  if ($null -ne $r) {
    $conf = [math]::Round($r.Confidence, 2)
    [Console]::Out.WriteLine("HEARD\t$($r.Grammar.Name)\t$conf\t$($r.Text)")
  } else {
    [Console]::Out.WriteLine('NONE')
  }
  [Console]::Out.Flush()
}`;

function spawnPs(script, env) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...(env || {}) },
    windowsHide: true,
  });
}

/* -------------------------------------------------------------------------- */
/*  The service                                                                */
/* -------------------------------------------------------------------------- */

const LISTEN_WINDOW_SEC = 6;
const MIN_CONFIDENCE = 0.82;

/** Requires a compiled module from dist/, or null when unavailable. */
function tryRequire(rel) {
  try {
    return require(path.join(__dirname, '..', 'dist', rel));
  } catch {
    return null;
  }
}

class EngineerService {
  /**
   * @param {object} opts
   * @param {string} opts.dir       asset dir, e.g. <userData>/piper
   * @param {() => object} opts.loadSettings
   * @param {(payload: object) => void} [opts.onStatus]  status push to the panel
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.loadSettings = opts.loadSettings;
    this.onStatus = opts.onStatus || (() => {});
    this.radioFx = require('./radio-fx');
    this.commandsMod = tryRequire('telemetry/engineerCommands.js');

    this.running = false;
    this.busy = null; // 'download:<id>' while a download runs
    this.lastError = null;
    this.piper = null;
    this.player = null;
    this.recognizer = null;
    this.recognizerReady = false;
    this.ws = null;
    this.wsTimer = null;
    this.commands = this.commandsMod ? new this.commandsMod.EngineerCommands() : null;
    this.asking = false;
    this.wavDir = null;
    this.grammarPath = null;
    this.chirpPath = null;
    this.pendingListen = null; // resolver for the in-flight LISTEN
  }

  /* ---- assets ------------------------------------------------------------ */

  enginePath() {
    return path.join(this.dir, 'piper.exe');
  }

  modelPath(id) {
    return path.join(this.dir, `${id}.onnx`);
  }

  engineInstalled() {
    return fs.existsSync(this.enginePath());
  }

  voiceInstalled(id) {
    return fs.existsSync(this.modelPath(id)) && fs.existsSync(`${this.modelPath(id)}.json`);
  }

  /** Everything the panel needs to render the tab, as plain data. */
  status() {
    const settings = this.loadSettings();
    const selected = settings.engineerVoice;
    return {
      enabled: !!settings.engineerEnabled,
      running: this.running,
      engineInstalled: this.engineInstalled(),
      selectedVoice: selected,
      selectedInstalled: this.voiceInstalled(selected),
      busy: this.busy,
      lastError: this.lastError,
      micAvailable: this.recognizer ? this.recognizerReady : null, // null = not started yet
      voices: VOICES.map((v) => ({
        ...v,
        sampleUrl: sampleUrl(v.id),
        installed: this.voiceInstalled(v.id),
        selected: v.id === selected,
      })),
      grammar: GRAMMAR,
    };
  }

  pushStatus() {
    this.onStatus(this.status());
  }

  /**
   * Download the engine (if missing) and one voice, with progress from the
   * growing file against the known size — curl -sS is silent, so progress is
   * read off the filesystem once a second rather than parsed from a bar.
   */
  async download(voiceId) {
    const voice = VOICES.find((v) => v.id === voiceId);
    if (!voice) throw new Error(`unknown voice: ${voiceId}`);
    if (this.busy) throw new Error('another download is already running');
    this.busy = `download:${voiceId}`;
    this.lastError = null;
    this.pushStatus();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!this.engineInstalled()) {
        const zip = path.join(this.dir, 'piper.zip');
        await this.fetch(PIPER_ZIP, zip, 23, voiceId);
        // The zip contains a piper/ folder; extract to a staging dir and lift
        // the contents up so the engine lands flat in this.dir.
        const staging = path.join(this.dir, '_extract');
        fs.rmSync(staging, { recursive: true, force: true });
        await new Promise((resolve, reject) => {
          execFile(
            'powershell.exe',
            ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${staging}' -Force`],
            (err) => (err ? reject(err) : resolve()),
          );
        });
        for (const f of fs.readdirSync(path.join(staging, 'piper'))) {
          fs.renameSync(path.join(staging, 'piper', f), path.join(this.dir, f));
        }
        fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(zip, { force: true });
      }
      if (!this.voiceInstalled(voiceId)) {
        const base = `${HF_BASE}/${voicePath(voiceId)}/${voiceId}`;
        await this.fetch(`${base}.onnx`, this.modelPath(voiceId), voice.sizeMb, voiceId);
        await this.fetch(`${base}.onnx.json`, `${this.modelPath(voiceId)}.json`, 1, voiceId);
      }
    } catch (err) {
      this.lastError = `Download failed: ${err.message}`;
      throw err;
    } finally {
      this.busy = null;
      this.pushStatus();
    }
  }

  /** curl -sSL to a .part file, promoted on success; progress via file size. */
  fetch(url, dest, sizeMb, voiceId) {
    return new Promise((resolve, reject) => {
      const part = `${dest}.part`;
      fs.rmSync(part, { force: true });
      const child = execFile('curl.exe', ['-sSL', '-o', part, url], (err) => {
        clearInterval(poll);
        if (err) {
          fs.rmSync(part, { force: true });
          reject(new Error(`curl: ${err.message}`));
          return;
        }
        try {
          fs.renameSync(part, dest);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      const poll = setInterval(() => {
        try {
          const mb = fs.statSync(part).size / 1e6;
          this.onStatus({ ...this.status(), progress: { voiceId, mb: Math.round(mb), totalMb: sizeMb } });
        } catch {
          /* not created yet */
        }
      }, 1000);
      child.on('error', (err) => {
        clearInterval(poll);
        reject(err);
      });
    });
  }

  /* ---- lifecycle ----------------------------------------------------------- */

  /**
   * Bring the whole pipeline up against the app's own server port. Idempotent;
   * a change of voice or port goes through stop() + start().
   */
  async start(port) {
    if (this.running) return;
    const settings = this.loadSettings();
    const voice = settings.engineerVoice;
    if (!this.commands) throw new Error('telemetry build missing (dist/)');
    if (!this.engineInstalled() || !this.voiceInstalled(voice)) {
      throw new Error('voice not downloaded yet');
    }
    this.lastError = null;
    this.wavDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'apex-engineer-'));
    this.grammarPath = path.join(this.wavDir, 'grammar.json');
    fs.writeFileSync(this.grammarPath, JSON.stringify(GRAMMAR));

    // Player first, then Piper feeding it through the radio channel.
    this.player = spawnPs(PLAYER_PS);
    this.player.stdout.on('data', () => {});
    this.piper = spawn(this.enginePath(), ['-m', this.modelPath(voice), '--output_dir', this.wavDir], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    require('node:readline')
      .createInterface({ input: this.piper.stdout })
      .on('line', (line) => {
        const wav = line.trim();
        if (!wav) return;
        let out = wav;
        try {
          out = wav.replace(/\.wav$/i, '.radio.wav');
          this.radioFx.radioify(wav, out);
          fs.rmSync(wav, { force: true });
        } catch {
          out = wav; // dry beats silent
        }
        if (this.player && this.player.stdin.writable) this.player.stdin.write(out + '\n');
      });
    this.piper.on('exit', () => {
      if (this.running) {
        this.lastError = 'The voice engine stopped unexpectedly.';
        this.stop();
        this.pushStatus();
      }
    });

    // Ears: resident but deaf until a LISTEN command (push-to-talk).
    this.recognizer = spawnPs(RECOGNIZER_PS, { APEX_ENGINEER_GRAMMAR: this.grammarPath });
    require('node:readline')
      .createInterface({ input: this.recognizer.stdout })
      .on('line', (line) => this.onRecognizerLine(line));
    this.recognizer.on('exit', () => {
      this.recognizerReady = false;
    });

    // A short "channel open" chirp for the press, generated once: two quick
    // square-ish beeps, run through the same radio channel as everything else.
    this.chirpPath = path.join(this.wavDir, 'chirp.wav');
    this.makeChirp(this.chirpPath);

    this.connectWs(port);
    this.running = true;
    this.pushStatus();
  }

  stop() {
    this.running = false;
    for (const p of [this.piper, this.player, this.recognizer]) {
      try {
        if (p) p.kill();
      } catch {}
    }
    this.piper = this.player = this.recognizer = null;
    this.recognizerReady = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    if (this.wsTimer) clearTimeout(this.wsTimer);
    this.wsTimer = null;
    if (this.pendingListen) {
      this.pendingListen({ kind: 'NONE' });
      this.pendingListen = null;
    }
    this.asking = false;
    if (this.commands) this.commands.reset();
    if (this.wavDir) fs.rmSync(this.wavDir, { recursive: true, force: true });
    this.wavDir = null;
  }

  connectWs(port) {
    if (!this.running && this.ws === null && this.piper === null) return; // stopped
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws = ws;
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data);
        if (frame && frame.session && this.commands) this.commands.update(frame);
      } catch {}
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (!this.running) return;
      this.wsTimer = setTimeout(() => this.connectWs(port), 3000);
    });
  }

  onRecognizerLine(line) {
    const [kind, a, b, c] = line.split('\t');
    if (kind === 'READY') {
      this.recognizerReady = true;
      this.pushStatus();
      return;
    }
    if (kind === 'ERROR') {
      this.recognizerReady = false;
      this.lastError = `Microphone: ${a}`;
      this.pushStatus();
      return;
    }
    if (this.pendingListen) {
      const resolve = this.pendingListen;
      this.pendingListen = null;
      resolve(kind === 'HEARD' ? { kind, intent: a, confidence: Number(b), text: c } : { kind: 'NONE' });
    }
  }

  /* ---- speaking ------------------------------------------------------------ */

  speak(text) {
    if (this.piper && this.piper.stdin.writable) this.piper.stdin.write(text + '\n');
  }

  /** Two rising beeps through the radio band — "channel open, go ahead". */
  makeChirp(dest) {
    const rate = 22050;
    const seg = Math.round(rate * 0.055);
    const gap = Math.round(rate * 0.03);
    const samples = new Float64Array(seg + gap + seg);
    for (let i = 0; i < seg; i++) {
      const env = Math.sin((Math.PI * i) / seg);
      samples[i] = 0.4 * env * Math.sign(Math.sin((2 * Math.PI * 880 * i) / rate));
      samples[seg + gap + i] = 0.4 * env * Math.sign(Math.sin((2 * Math.PI * 1245 * i) / rate));
    }
    this.radioFx.writeWav(dest, rate, this.radioFx.processSamples(samples, rate));
  }

  playChirp() {
    if (!this.chirpPath || !this.player || !this.player.stdin.writable) return;
    // The player deletes what it plays; hand it a throwaway copy.
    const copy = path.join(this.wavDir, `chirp-${Date.now()}.wav`);
    try {
      fs.copyFileSync(this.chirpPath, copy);
      this.player.stdin.write(copy + '\n');
    } catch {}
  }

  /* ---- the button ----------------------------------------------------------- */

  /**
   * Push-to-talk: chirp, listen for one bounded window, answer. A second press
   * while listening is ignored rather than queued — the driver mashing the
   * button mid-corner should not bank three listens.
   */
  async ask() {
    if (!this.running) return { ok: false, error: 'Engineer is not running' };
    if (!this.recognizerReady) return { ok: false, error: 'Microphone not ready' };
    if (this.asking) return { ok: true };
    this.asking = true;
    try {
      this.playChirp();
      const heard = await new Promise((resolve) => {
        this.pendingListen = resolve;
        this.recognizer.stdin.write(`LISTEN ${LISTEN_WINDOW_SEC}\n`);
        // Belt and braces: never leave the button dead if the sidecar wedges.
        setTimeout(() => {
          if (this.pendingListen === resolve) {
            this.pendingListen = null;
            resolve({ kind: 'NONE' });
          }
        }, (LISTEN_WINDOW_SEC + 3) * 1000);
      });
      if (heard.kind !== 'HEARD' || heard.confidence < MIN_CONFIDENCE) {
        this.speak('Say again?');
        return { ok: true };
      }
      const answer = this.commands.answer(heard.intent);
      this.speak(answer.text);
      return { ok: true };
    } finally {
      this.asking = false;
    }
  }

  /** The panel's "Radio check" — proves voice + radio channel end to end. */
  async test() {
    if (!this.running) return { ok: false, error: 'Engineer is not running — enable it first' };
    this.playChirp();
    this.speak('Radio check. The engineer can hear the telemetry and the channel is live.');
    return { ok: true };
  }

  /**
   * Speak a sample line with a specific INSTALLED voice without disturbing the
   * resident one — a one-shot Piper is fine here (cold start ≈1.5 s, and this
   * is a settings-page click, not a race).
   */
  async preview(voiceId) {
    if (!this.engineInstalled() || !this.voiceInstalled(voiceId)) {
      return { ok: false, error: 'Voice not downloaded yet' };
    }
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-voice-preview-'));
    const wav = path.join(dir, 'preview.wav');
    await new Promise((resolve, reject) => {
      const child = spawn(this.enginePath(), ['-m', this.modelPath(voiceId), '-f', wav], {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      child.stdin.end('Gap ahead, 2.4 seconds, to Smith. Box this lap, box box.\n');
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`piper exited ${code}`))));
      child.on('error', reject);
    });
    const out = path.join(dir, 'preview.radio.wav');
    this.radioFx.radioify(wav, out);
    // One-shot player: the resident one may not exist while the feature is off.
    const player = spawnPs(PLAYER_PS);
    player.stdout.on('data', (d) => {
      if (String(d).includes('PLAYED')) {
        player.stdin.end();
        setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1000);
      }
    });
    player.stdin.write(out + '\n');
    fs.rmSync(wav, { force: true });
    return { ok: true };
  }
}

module.exports = { EngineerService, VOICES, GRAMMAR, sampleUrl };
