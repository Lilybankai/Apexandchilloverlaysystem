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
const stt = require('./engineerStt');

/* -------------------------------------------------------------------------- */
/*  The grammar — one table for recognizer, panel help, and the spike          */
/* -------------------------------------------------------------------------- */

/**
 * The one phrase table: the recognizer loads it, the panel renders it, the
 * spike imports it. `group` exists purely for the panel's reference card —
 * the recognizer reads intent + phrases and nothing else. Entries are ordered
 * group-contiguous, most-reached-for family first, because that order IS the
 * panel's layout. Phrase lists are audited against each other for shared
 * word-sequences — where two intents share a stem, one gets a different
 * phrase, not a longer one ("my pace" vs avgAhead's "pace ahead"; gridStart
 * avoids the word "position" entirely because `position` owns it).
 */
const GRAMMAR = [
  // -- Gaps & rivals ---------------------------------------------------------
  { intent: 'gapAhead', group: 'Gaps & rivals', phrases: ['gap ahead', 'gap in front', 'gap front'] },
  { intent: 'gapBehind', group: 'Gaps & rivals', phrases: ['gap behind', 'gap to the car behind'] },
  {
    intent: 'carAhead',
    group: 'Gaps & rivals',
    phrases: ["who's ahead", "who's in front", 'car ahead', 'car in front', "who am i chasing"],
  },
  { intent: 'carBehind', group: 'Gaps & rivals', phrases: ["who's behind", 'car behind', "who's chasing me"] },
  {
    intent: 'avgAhead',
    group: 'Gaps & rivals',
    phrases: ['five lap average', 'five laps average front', 'average front', 'pace ahead', 'compare pace'],
  },
  { intent: 'leader', group: 'Gaps & rivals', phrases: ["who's leading", 'the leader', 'gap to the leader'] },
  {
    intent: 'traffic',
    group: 'Gaps & rivals',
    phrases: ['backmarker', 'backmarkers', 'any traffic', 'traffic ahead', 'any backmarkers'],
  },
  // -- Pace & laps -------------------------------------------------------------
  { intent: 'lastLap', group: 'Pace & laps', phrases: ['last lap', 'last lap time', 'lap time'] },
  { intent: 'bestLap', group: 'Pace & laps', phrases: ['best lap', 'my best lap', 'personal best'] },
  { intent: 'fieldFastest', group: 'Pace & laps', phrases: ['fastest lap', 'quickest lap', "who's got the fastest lap"] },
  { intent: 'pace', group: 'Pace & laps', phrases: ["how's my pace", 'my pace', 'pace check', 'what am i on for'] },
  { intent: 'position', group: 'Pace & laps', phrases: ['position', 'what position am i in', 'where am i'] },
  { intent: 'gridStart', group: 'Pace & laps', phrases: ['where did i start', 'places gained', 'how many places'] },
  // -- Fuel & energy -----------------------------------------------------------
  { intent: 'fuel', group: 'Fuel & energy', phrases: ['fuel', 'fuel state', 'fuel level'] },
  { intent: 'energy', group: 'Fuel & energy', phrases: ['energy', 'virtual energy', "how's my energy"] },
  { intent: 'hybrid', group: 'Fuel & energy', phrases: ['battery', 'hybrid', 'state of charge'] },
  // -- Pit ---------------------------------------------------------------------
  { intent: 'pitStop', group: 'Pit', phrases: ['pit stop', 'stop time', 'how long is the stop'] },
  { intent: 'pitWindow', group: 'Pit', phrases: ['pit window', "when's the window", 'when do we pit'] },
  // -- The car -----------------------------------------------------------------
  { intent: 'tyres', group: 'The car', phrases: ['tyres', 'how are my tyres', 'tyre temps'] },
  { intent: 'pressures', group: 'The car', phrases: ['tyre pressures', 'pressures'] },
  { intent: 'brakes', group: 'The car', phrases: ['brakes', 'brake wear', 'how are the brakes'] },
  { intent: 'damage', group: 'The car', phrases: ['damage', 'any damage', 'damage report', 'how bad is it'] },
  { intent: 'brakeBias', group: 'The car', phrases: ['brake bias', 'bias'] },
  { intent: 'tractionControl', group: 'The car', phrases: ['traction control', 'traction'] },
  // -- Race control ------------------------------------------------------------
  { intent: 'lapsLeft', group: 'Race control', phrases: ['laps left', 'laps remaining', 'how many laps', 'how long left'] },
  { intent: 'trackLimits', group: 'Race control', phrases: ['track limits', 'limits', 'penalty points'] },
  { intent: 'flags', group: 'Race control', phrases: ['any yellows', 'yellows', 'flags', 'any flags'] },
  // -- Conditions ----------------------------------------------------------------
  { intent: 'weather', group: 'Conditions', phrases: ['weather', 'any rain', 'is it going to rain', 'rain coming'] },
];

/* -------------------------------------------------------------------------- */
/*  Proactive readouts (Track B) — which preset speaks which trigger kind      */
/* -------------------------------------------------------------------------- */

/**
 * The dial. `essential` is the default and calls only rule changes and things
 * that end races; `standard` adds the race-story layer. Detection always runs
 * (it is sub-microsecond and its stats feed tuning) — the preset only decides
 * what reaches the voice. A kind missing from this table never speaks: safer
 * for any future trigger than speaking by accident.
 */
const TRIGGER_TIERS = {
  raceStart: 'essential',
  restart: 'essential',
  fullCourseYellow: 'essential',
  redFlag: 'essential',
  finalLap: 'essential',
  checkered: 'essential',
  incident: 'essential',
  penalty: 'essential',
  penaltyServed: 'essential',
  fuelWindow: 'essential',
  fuelCritical: 'essential',
  fastestLapSelf: 'standard',
  fastestLapField: 'standard',
  positionChange: 'standard',
  rivalPitted: 'standard',
  pitWindowOpen: 'standard',
  yieldTo: 'standard',
};

/**
 * How long a readout may wait for the channel (an answer playing, the driver
 * mid-move) before it is dropped rather than spoken late — the same "expire,
 * never queue" stance as the trigger layer's own hold.
 */
const READOUT_HOLD_MS = 4000;

/** Brake input above this reads as "driver is busy" — no readout right now. */
const BUSY_BRAKE = 0.6;

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
 * One-shot recognition on command. Blocks on stdin; each LISTEN runs a single
 * bounded Recognize() — the microphone is captured only inside that call.
 * Grammar JSON path arrives via APEX_ENGINEER_GRAMMAR, the scratch dir for
 * free-form clips via APEX_ENGINEER_WAVDIR (EncodedCommand takes no
 * arguments). Runs synchronously throughout: event-handler output does not
 * reliably reach redirected stdout from another runspace.
 *
 * Tier 2 rides the SAME listen, not a second recorder: a DictationGrammar
 * (named `free`) is loaded beside the closed grammar, and when it wins the
 * result's own retained audio is written out for whisper. One utterance, one
 * device owner, and the closed grammar keeps returning THE INSTANT it matches
 * — the beta.6 record-to-file design cost every press a fixed six seconds and
 * fought SAPI for the microphone (v0.77.0-beta.6 field report).
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
  $dict = $null
  try {
    $dict = New-Object System.Speech.Recognition.DictationGrammar
    $dict.Name = 'free'
    $rec.LoadGrammar($dict)
  } catch { $dict = $null }
  $rec.SetInputToDefaultAudioDevice()
} catch {
  [Console]::Out.WriteLine("ERROR\t" + $_.Exception.Message); [Console]::Out.Flush()
  exit 1
}
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
if ($null -ne $dict) { [Console]::Out.WriteLine('DICTOK'); [Console]::Out.Flush() }
while ($true) {
  $cmd = [Console]::In.ReadLine()
  if ($null -eq $cmd) { break }
  if ($cmd -notmatch '^LISTEN') { continue }
  $secs = 6
  if ($cmd -match 'LISTEN (\\d+)') { $secs = [int]$Matches[1] }
  $r = $rec.Recognize([TimeSpan]::FromSeconds($secs))
  if ($null -eq $r) {
    [Console]::Out.WriteLine('NONE'); [Console]::Out.Flush()
    continue
  }
  $conf = [math]::Round($r.Confidence, 2)
  if ($r.Grammar.Name -ne 'free') {
    [Console]::Out.WriteLine("HEARD\t$($r.Grammar.Name)\t$conf\t$($r.Text)")
  } else {
    $saved = ''
    try {
      if ($null -ne $r.Audio) {
        $wav = Join-Path $env:APEX_ENGINEER_WAVDIR ("free-" + [DateTime]::UtcNow.Ticks + ".wav")
        $fsOut = [System.IO.File]::Create($wav)
        try { $r.Audio.WriteToWaveStream($fsOut) } finally { $fsOut.Close() }
        $saved = $wav
      }
    } catch { $saved = '' }
    [Console]::Out.WriteLine("FREE\t$saved\t$conf\t$($r.Text)")
  }
  [Console]::Out.Flush()
}`;

/**
 * The grammar, run over TEXT: when the dictation grammar out-competes the
 * closed one for an utterance like "mate what's the gap ahead right now",
 * the phrase is still in the words — and a phrase match must never reach the
 * cloud. Longest matching phrase wins (specificity: "pit window" must beat a
 * future "pit"). Whole-word sequences only, apostrophes and punctuation
 * ignored, so SAPI's "whos ahead" still hits "who's ahead".
 */
function matchGrammarText(text) {
  const norm = (s) =>
    ` ${String(s || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()} `;
  const haystack = norm(text);
  if (haystack.trim().length === 0) return null;
  let best = null;
  for (const g of GRAMMAR) {
    for (const p of g.phrases) {
      const needle = norm(p);
      if (needle.trim() && haystack.includes(needle)) {
        if (!best || needle.length > best.length) best = { intent: g.intent, length: needle.length };
      }
    }
  }
  return best ? best.intent : null;
}

function spawnPs(script, env) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...(env || {}) },
    windowsHide: true,
  });
  // A sidecar that can't start (or dies mid-write) must never take the app
  // down with it — antivirus blocking is a live possibility for everything
  // this module spawns, and an unhandled 'error' event kills the main
  // process. Callers layer their own messaging on top of these.
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  return child;
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
   * @param {string} [opts.whisperDir]  STT assets, e.g. <userData>/whisper
   * @param {() => object} opts.loadSettings
   * @param {(payload: object) => void} [opts.onStatus]
   * @param {(body: object) => Promise<object>} [opts.cloudAsk]
   * @param {() => Promise<object>} [opts.cloudBudget]
   * @param {(id: string, rating: string) => Promise<object>} [opts.cloudRate]
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.whisperDir = opts.whisperDir || path.join(this.dir, '..', 'whisper');
    this.loadSettings = opts.loadSettings;
    this.onStatus = opts.onStatus || (() => {});
    this.cloudAsk = opts.cloudAsk || null;
    this.cloudBudget = opts.cloudBudget || null;
    this.cloudRate = opts.cloudRate || null;
    this.radioFx = require('./radio-fx');
    this.commandsMod = tryRequire('telemetry/engineerCommands.js');
    this.triggersMod = tryRequire('telemetry/triggers.js');
    this.phrasesMod = tryRequire('telemetry/engineerPhrases.js');
    this.summaryMod = tryRequire('telemetry/engineerSummary.js');

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
    this.triggers = this.triggersMod ? new this.triggersMod.EngineerTriggers() : null;
    this.asking = false;
    this.wavDir = null;
    this.grammarPath = null;
    this.chirpPath = null;
    this.pendingListen = null; // resolver for the in-flight LISTEN

    // The speech queue (seam 2 of the v3 plan). The player sidecar plays WAVs
    // synchronously, so it is already the serializer — what this state adds is
    // priority and staleness: an answer always speaks immediately, a readout
    // waits for a quiet channel and EXPIRES if it can't get one in time.
    this.audioInFlight = 0; // WAVs handed to the player, not yet PLAYED
    this.heldReadout = null; // { text, expiresAt } — at most one, newest wins
    this.lastFrame = null; // latest frame, for the busy-driver check
    this.saidBudgetLine = false; // degrade-to-Tier-1, once per session
    this.lastCall = null; // last Tier-2 reply, for the useful/wrong buttons
    this.budget = null; // { used, cap, remaining } from engineer_budget
    this.freeFormLive = false; // dictation grammar loaded in the recognizer
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

  /**
   * Every finished download is recorded here, so a later disappearance can be
   * told apart from "never downloaded" — antivirus quarantine removes files
   * without telling anyone, and the panel should say so rather than fall back
   * to "download a voice" as if nothing happened.
   */
  manifestPath() {
    return path.join(this.dir, 'installed.json');
  }

  readManifest() {
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath(), 'utf8'));
    } catch {
      return { engine: false, voices: {} };
    }
  }

  recordInstalled(voiceId) {
    const m = this.readManifest();
    m.engine = m.engine || this.engineInstalled();
    m.voices = m.voices || {};
    if (voiceId && this.voiceInstalled(voiceId)) m.voices[voiceId] = true;
    try {
      fs.writeFileSync(this.manifestPath(), JSON.stringify(m));
    } catch {}
  }

  /** True when something that finished downloading is no longer on disk. */
  vanished(voiceId) {
    const m = this.readManifest();
    if (m.engine && !this.engineInstalled()) return true;
    return !!(voiceId && m.voices && m.voices[voiceId] && !this.voiceInstalled(voiceId));
  }

  /** The readouts preset, safe against settings written by older versions. */
  readoutsPreset() {
    const settings = this.loadSettings();
    const preset = settings.engineer && settings.engineer.readouts;
    return preset === 'off' || preset === 'standard' ? preset : 'essential';
  }

  /** Everything the panel needs to render the tab, as plain data. */
  status() {
    const settings = this.loadSettings();
    const selected = settings.engineerVoice;
    return {
      enabled: !!settings.engineerEnabled,
      readouts: this.readoutsPreset(),
      running: this.running,
      engineInstalled: this.engineInstalled(),
      selectedVoice: selected,
      selectedInstalled: this.voiceInstalled(selected),
      busy: this.busy,
      lastError: this.lastError,
      micAvailable: this.recognizer ? this.recognizerReady : null, // null = not started yet
      sttInstalled: stt.installed(this.whisperDir),
      freeFormLive: this.freeFormLive,
      sttSizeMb: stt.MODEL_MB,
      lastCall: this.lastCall,
      budget: this.budget,
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
      this.recordInstalled(voiceId);
    } catch (err) {
      this.lastError = `Download failed: ${err.message}`;
      throw err;
    } finally {
      this.busy = null;
      this.pushStatus();
    }
  }

  /** One-time whisper.cpp + base.en download (~148 MB). Same progress bar as a voice. */
  async downloadStt() {
    if (this.busy) throw new Error('another download is already running');
    this.busy = 'download:stt';
    this.lastError = null;
    this.pushStatus();
    try {
      await stt.download(this.whisperDir, this.fetch.bind(this), 'stt');
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

    // Player first, then Piper feeding it through the radio channel. The
    // player's PLAYED lines are the speech queue's clock: each one frees the
    // channel, which is when a held readout gets its (only) second chance.
    this.player = spawnPs(PLAYER_PS);
    this.player.on('error', (err) => this.onChildError('audio player', err));
    require('node:readline')
      .createInterface({ input: this.player.stdout })
      .on('line', (line) => {
        if (!line.includes('PLAYED')) return;
        this.audioInFlight = Math.max(0, this.audioInFlight - 1);
        this.pumpHeldReadout();
      });
    this.piper = spawn(this.enginePath(), ['-m', this.modelPath(voice), '--output_dir', this.wavDir], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.piper.on('error', (err) => this.onChildError('voice engine', err));
    this.piper.stdin.on('error', () => {});
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
        if (this.player && this.player.stdin.writable) {
          this.audioInFlight++;
          this.player.stdin.write(out + '\n');
        }
      });
    this.piper.on('exit', () => {
      if (this.running) {
        this.lastError = 'The voice engine stopped unexpectedly.';
        this.stop();
        this.pushStatus();
      }
    });

    // Ears: resident but deaf until a LISTEN command (push-to-talk).
    this.recognizer = spawnPs(RECOGNIZER_PS, {
      APEX_ENGINEER_GRAMMAR: this.grammarPath,
      APEX_ENGINEER_WAVDIR: this.wavDir,
    });
    this.recognizer.on('error', (err) => this.onChildError('listener', err));
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

    this.saidBudgetLine = false;
    this.connectWs(port);
    this.running = true;
    this.pushStatus();
    void this.refreshBudget();
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
    if (this.triggers) this.triggers.reset();
    this.audioInFlight = 0;
    this.heldReadout = null;
    this.lastFrame = null;
    this.saidBudgetLine = false;
    if (this.wavDir) fs.rmSync(this.wavDir, { recursive: true, force: true });
    this.wavDir = null;
  }

  /**
   * A resident child that never came up (ENOENT/EACCES — the binary blocked
   * or quarantined, most likely by antivirus) emits 'error' with no 'exit' to
   * follow. Fold it into the same degrade-to-silence path as everything else:
   * stop the pipeline, tell the panel what happened, keep the app alive.
   */
  onChildError(what, err) {
    if (!this.running) return;
    const detail = err && (err.code || err.message) ? ` (${err.code || err.message})` : '';
    this.lastError =
      `The ${what} couldn't start${detail}. Antivirus software may have ` +
      'blocked or removed it — restore it from quarantine, or re-download the voice.';
    this.stop();
    this.pushStatus();
  }

  connectWs(port) {
    if (!this.running && this.ws === null && this.piper === null) return; // stopped
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws = ws;
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data);
        if (!frame || !frame.session) return;
        if (this.commands) this.commands.update(frame);
        this.lastFrame = frame;
        // Track B: the proactive readouts. `triggers.update` is the 0.24 µs
        // edge detector — it returns null on essentially every frame, so this
        // adds nothing measurable to a message handler that already parsed the
        // JSON. Everything expensive (Piper) happens only on a cue.
        if (this.triggers) {
          const cue = this.triggers.update(frame);
          if (cue) this.onCue(cue, frame);
        }
        this.pumpHeldReadout();
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
    if (kind === 'DICTOK') {
      // Windows' dictation engine loaded — free-form questions can be caught
      // in the same listen as the phrase list. Absent on stripped-down
      // Windows installs; Tier 1 is unaffected either way.
      this.freeFormLive = true;
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
      if (kind === 'HEARD') resolve({ kind, intent: a, confidence: Number(b), text: c });
      else if (kind === 'FREE') resolve({ kind, wav: a || null, confidence: Number(b), text: c || '' });
      else resolve({ kind: 'NONE' });
    }
  }

  /* ---- speaking ------------------------------------------------------------ */

  speak(text) {
    if (this.piper && this.piper.stdin.writable) this.piper.stdin.write(text + '\n');
  }

  /* ---- proactive readouts (Track B) ---------------------------------------- */

  /**
   * `true` while a proactive line would land at a bad moment: a car alongside,
   * or the driver deep in the brakes. Both reads come from the same frame the
   * widgets render, and both err quiet — no radar block means no alongside
   * evidence, not a green light to talk over a battle we can't see.
   */
  busyDriving() {
    const frame = this.lastFrame;
    if (!frame) return false;
    const pedals = frame.player && frame.player.pedals;
    if (pedals && typeof pedals.brake === 'number' && pedals.brake > BUSY_BRAKE) return true;
    const radar = frame.radar;
    if (Array.isArray(radar) && radar.some((b) => b && b.alongside)) return true;
    return false;
  }

  /**
   * One cue from the trigger layer → maybe one sentence on the radio. The
   * preset gate lives here (not in the detector) so detection stats keep
   * feeding tuning whatever the driver has the dial set to.
   */
  onCue(cue, frame) {
    if (!this.running || !this.phrasesMod) return;
    const preset = this.readoutsPreset();
    if (preset === 'off') return;
    const tier = TRIGGER_TIERS[cue.kind];
    if (!tier) return; // unknown kind never speaks by accident
    if (tier === 'standard' && preset !== 'standard') return;
    const text = this.phrasesMod.phraseForCue(cue, frame);
    if (text) this.sayReadout(text);
  }

  /**
   * Speak a readout if the channel is free and the driver isn't mid-move;
   * otherwise hold it — briefly. The driver's question always wins (ask()
   * clears the hold), and a line that waits past {@link READOUT_HOLD_MS} is
   * dropped: an engineer telling you about a rival's stop half a minute late
   * is worse than one who said nothing.
   */
  sayReadout(text) {
    if (!this.asking && this.audioInFlight === 0 && !this.busyDriving()) {
      this.speak(text);
      return;
    }
    this.heldReadout = { text, expiresAt: Date.now() + READOUT_HOLD_MS };
  }

  /** Re-check the one held readout — rides the frame stream and PLAYED lines. */
  pumpHeldReadout() {
    const held = this.heldReadout;
    if (!held) return;
    if (Date.now() > held.expiresAt) {
      this.heldReadout = null; // stale — dropped, never spoken late
      return;
    }
    if (this.asking || this.audioInFlight > 0 || this.busyDriving()) return;
    this.heldReadout = null;
    this.speak(held.text);
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
    } catch {
      return;
    }
    try {
      this.player.stdin.write(copy + '\n');
      this.audioInFlight++;
    } catch {}
  }

  /* ---- the button ----------------------------------------------------------- */

  /**
   * Push-to-talk: chirp, record one bounded window, answer. Grammar still
   * wins — it returns the instant a phrase matches, exactly as it did before
   * Tier 2 existed. Free-form speech is caught by the dictation grammar in the
   * SAME listen (its retained audio goes to whisper), so there is no second
   * recorder, no fixed-length wait and no fight over the microphone. A second
   * press while listening is ignored rather than queued.
   */
  async ask() {
    if (!this.running) return { ok: false, error: 'Engineer is not running' };
    if (!this.recognizerReady) return { ok: false, error: 'Microphone not ready' };
    if (this.asking) return { ok: true };
    this.asking = true;
    this.heldReadout = null; // the driver's question always wins
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

      // Tier 1, exactly as before Tier 2 existed: the closed grammar returns
      // THE INSTANT it matches, and the answer is on the radio inside a second.
      if (heard.kind === 'HEARD' && heard.confidence >= MIN_CONFIDENCE && this.commands) {
        const answer = this.commands.answer(heard.intent);
        this.speak(answer.text);
        return { ok: true };
      }

      // Dictation caught it instead: a free-form question — unless a phrase is
      // buried in the dictation text, in which case the grammar still wins.
      if (heard.kind === 'FREE') {
        const intent = matchGrammarText(heard.text);
        if (intent && this.commands) {
          this.speak(this.commands.answer(intent).text);
          return { ok: true };
        }
        await this.askTier2(heard.wav, heard.text);
        return { ok: true };
      }

      this.speak('Say again?');
      return { ok: true };
    } finally {
      this.asking = false;
    }
  }

  /**
   * Tier 2: transcribe the retained clip locally (async — the beta.6 spawnSync
   * froze the whole main process for the length of the transcription), fall
   * back to SAPI's own dictation text when whisper is missing or stumbles,
   * then put question + bucketed summary to the proxy. An asked question that
   * fails gets a short spoken failure — the readouts fail to silence, but
   * silence after a button press reads as a dead engineer (beta.6 field
   * report).
   */
  async askTier2(wav, dictationText) {
    let question = '';
    let sttMs = null;
    if (wav && stt.installed(this.whisperDir)) {
      try {
        const trimmed = path.join(this.wavDir, `ask-16k-${Date.now()}.wav`);
        const clip = stt.trimForWhisper(this.radioFx, wav, trimmed);
        if (clip) {
          const result = await stt.transcribeAsync(this.whisperDir, clip.path);
          question = (result.text || '').trim();
          sttMs = result.ms;
        }
      } catch {
        question = '';
      }
    }
    if (!question) question = String(dictationText || '').trim();
    if (question.length < 3) {
      this.speak('Say again?');
      return;
    }
    if (!this.cloudAsk) return; // no cloud hook wired (dev harness) — silence
    if (!this.summaryMod || !this.lastFrame) {
      this.speak('No telemetry.');
      return;
    }
    const summary = this.summaryMod.engineerSummary(this.lastFrame);
    if (!summary || !summary.connected) {
      this.speak('No telemetry.');
      return;
    }
    let res;
    try {
      res = await this.cloudAsk({ question, summary, sttMs });
    } catch {
      this.speak('No answer from the pit wall.');
      return;
    }
    if (!res) {
      this.speak('No answer from the pit wall.');
      return;
    }
    if (res.signedOut) {
      this.speak('Sign in to ask free-form.');
      return;
    }
    const body = res.body || {};
    if (body.code === 'budget') {
      this.budget = { remaining: 0, cap: body.cap || 300, used: body.cap || 300 };
      if (!this.saidBudgetLine) {
        this.saidBudgetLine = true;
        this.speak("That's the free-form allotment for this month. Stick to the phrase list.");
      }
      this.pushStatus();
      return;
    }
    if (!res.ok || body.ok === false || !body.answer) {
      this.speak('No answer from the pit wall.');
      return;
    }
    this.speak(body.answer);
    this.lastCall = { id: body.callId, question, answer: body.answer, rating: null };
    if (typeof body.remaining === 'number') {
      this.budget = { remaining: body.remaining, cap: body.cap || 300 };
    }
    this.pushStatus();
  }

  async refreshBudget() {
    if (!this.cloudBudget) return;
    try {
      const res = await this.cloudBudget();
      const body = res && res.body;
      if (!res || !res.ok || !body || body.ok === false) return;
      this.budget = { used: body.used, cap: body.cap, remaining: body.remaining };
      if (body.lastCall) this.lastCall = body.lastCall;
      this.pushStatus();
    } catch {
      /* offline — tab still works for Tier 1 */
    }
  }

  async rate(id, rating) {
    if (!this.cloudRate) return { ok: false, error: 'Not signed in' };
    const res = await this.cloudRate(id, rating);
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'Could not save rating' };
    const body = res.body;
    if (body && body.ok === false) return { ok: false, error: body.error || 'Could not save rating' };
    if (this.lastCall && this.lastCall.id === id) {
      this.lastCall = { ...this.lastCall, rating };
    }
    this.pushStatus();
    return { ok: true };
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

module.exports = { EngineerService, VOICES, GRAMMAR, sampleUrl, matchGrammarText };
