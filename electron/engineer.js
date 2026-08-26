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
 * From v0.79.0 the installer BUNDLES the Piper engine, the default voice
 * (Alan) and whisper.cpp + base.en into the app's resources dir, signed at
 * build time — antivirus quarantined the runtime-downloaded unsigned engine
 * (Norton, field report 2026-08-19) and took the app down with it. The other
 * five voices (~63–121 MB each) are still downloaded on demand into
 * `<userData>/piper/`: they are pure model data, which AV heuristics leave
 * alone — the executable was the bait. Bundled always wins over a downloaded
 * copy of the same file. `VOICES` is the curated catalog; every entry was
 * verified against the HuggingFace repo on 2026-08-18.
 *
 * ## The PowerShell sidecars are plain signed .ps1 files run with -File
 * They live in `electron/sidecars/` and ship via extraResources, signed at
 * build time. They were once JS strings run through `-EncodedCommand` (scripts
 * can't run from inside the asar), but encoded PowerShell is a textbook
 * antivirus-heuristic tell, and extraResources removed the asar problem.
 *
 * Everything degrades to silence + a reported status: no engine, no voice, no
 * mic, no server — the app runs on, the Engineer tab says what is missing.
 */

'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const stt = require('./engineerStt');
const { normalizePracticePaceReminderLaps } = require('./engineer-settings');

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
  {
    intent: 'gapAhead',
    group: 'Gaps & rivals',
    // "gap to car ahead" and "whats the gap" are first-week field wordings
    // (2026-08-21 engineer_calls log) that fell through to the cloud.
    phrases: ['gap ahead', 'gap in front', 'gap front', 'gap to the car ahead', 'gap to car ahead', 'whats the gap'],
  },
  { intent: 'gapBehind', group: 'Gaps & rivals', phrases: ['gap behind', 'gap to the car behind', 'gap to car behind'] },
  {
    intent: 'carAhead',
    group: 'Gaps & rivals',
    phrases: ["who's ahead", "who's in front", 'car ahead', 'car in front', "who am i chasing"],
  },
  { intent: 'carBehind', group: 'Gaps & rivals', phrases: ["who's behind", 'car behind', "who's chasing me"] },
  {
    intent: 'avgAhead',
    group: 'Gaps & rivals',
    // "last five average" and "top five average" are day-one field wordings
    // (2026-08-19 engineer_calls log) that fell through to the cloud and were
    // refused — the answer was sitting here the whole time.
    phrases: [
      'five lap average',
      'five laps average front',
      'last five average',
      'top five average',
      'five average',
      'average front',
      'pace ahead',
      'compare pace',
    ],
  },
  { intent: 'leader', group: 'Gaps & rivals', phrases: ["who's leading", 'the leader', 'gap to the leader'] },
  // The trend pair (2026-08-23): per-lap gap history, so "am I catching him"
  // gets a rate and a when, not today's snapshot.
  {
    intent: 'catching',
    group: 'Gaps & rivals',
    phrases: ['am i catching', 'am i gaining', 'am i closing', 'closing the gap', 'gap trend'],
  },
  {
    intent: 'defending',
    group: 'Gaps & rivals',
    phrases: ['is he catching me', 'is he gaining on me', 'is he closing', 'am i holding him', 'gap behind trend'],
  },
  {
    intent: 'traffic',
    group: 'Gaps & rivals',
    phrases: ['backmarker', 'backmarkers', 'any traffic', 'traffic ahead', 'any backmarkers'],
  },
  // -- Pace & laps -------------------------------------------------------------
  { intent: 'lastLap', group: 'Pace & laps', phrases: ['last lap', 'last lap time', 'lap time'] },
  {
    intent: 'sectors',
    group: 'Pace & laps',
    phrases: ['sectors', 'sector times', 'sector splits', 'last sectors', 'last lap sectors'],
  },
  { intent: 'bestLap', group: 'Pace & laps', phrases: ['best lap', 'my best lap', 'personal best'] },
  { intent: 'fieldFastest', group: 'Pace & laps', phrases: ['fastest lap', 'quickest lap', "who's got the fastest lap"] },
  { intent: 'pace', group: 'Pace & laps', phrases: ["how's my pace", 'my pace', 'pace check', 'what am i on for'] },
  {
    intent: 'paceAlien',
    group: 'Pace & laps',
    phrases: [
      'alien pace',
      'alien race pace',
      'alien time',
      'what is alien pace',
      'how far off alien pace',
      'how far am i off alien pace',
    ],
  },
  {
    intent: 'paceCompetitive',
    group: 'Pace & laps',
    phrases: [
      'competitive pace',
      'competitive time',
      'what pace to be competitive',
      'what pace do i need to be competitive',
      'how far off competitive pace',
    ],
  },
  {
    intent: 'paceMidpack',
    group: 'Pace & laps',
    phrases: [
      'midpack pace',
      'mid pack pace',
      'midpack time',
      'mid pack time',
      'what is midpack pace',
      'what is mid pack pace',
    ],
  },
  { intent: 'position', group: 'Pace & laps', phrases: ['position', 'what position am i in', 'where am i'] },
  { intent: 'gridStart', group: 'Pace & laps', phrases: ['where did i start', 'places gained', 'how many places'] },
  // -- Fuel & energy -----------------------------------------------------------
  {
    intent: 'fuel',
    group: 'Fuel & energy',
    // NOT "how much fuel": "how much fuel do I need to put in" is a refuel
    // question the cloud answers better (refuelToFinishL) — matching it here
    // would downgrade it to the tank read.
    phrases: ['fuel', 'fuel state', 'fuel level', 'fuel to finish', 'fuel to the finish', 'fuel to the end', 'enough fuel'],
  },
  { intent: 'energy', group: 'Fuel & energy', phrases: ['energy', 'virtual energy', "how's my energy"] },
  // Asked twice on day one (2026-08-19 log) and refused by the cloud — the
  // burn ratio is a local read now.
  { intent: 'fuelRatio', group: 'Fuel & energy', phrases: ['fuel ratio', 'fuel to energy ratio'] },
  { intent: 'hybrid', group: 'Fuel & energy', phrases: ['battery', 'hybrid', 'state of charge'] },
  // -- Pit ---------------------------------------------------------------------
  { intent: 'pitStop', group: 'Pit', phrases: ['pit stop', 'stop time', 'how long is the stop'] },
  // "Where do I come out" — the projection off measured pit losses (pitExit.ts).
  {
    intent: 'pitExit',
    group: 'Pit',
    phrases: ['where do i come out', 'where would i come out', 'where will i come out', 'if i box now', 'if i pit now', 'pit exit'],
  },
  {
    intent: 'pitWindow',
    group: 'Pit',
    // The "…till i need to pit" family must out-length lapsLeft's "how many
    // laps" (matching is longest-needle-wins): "how many laps till I need to
    // pit" was answered by the cloud on 2026-08-19 because the only shared
    // stem here was too short to win.
    phrases: [
      'pit window',
      "when's the window",
      'when do we pit',
      'when should i pit',
      'when do i need to pit',
      'till i need to pit',
      'until i need to pit',
      'before i need to pit',
      'need to pit',
      'when to pit',
    ],
  },
  // -- The car -----------------------------------------------------------------
  {
    intent: 'tyres',
    group: 'The car',
    // "tyre temperatures" spoken in full got "Say again?" from the cloud on
    // 2026-08-20; whisper also writes the US spelling ("tire temp"), which the
    // matcher normalizes to these.
    phrases: ['tyres', 'how are my tyres', 'tyre temps', 'tyre temp', 'tyre temperature', 'tyre temperatures'],
  },
  // Wear RATE and laps left, not temps — a different question from 'tyres'.
  {
    intent: 'tyreLife',
    group: 'The car',
    phrases: ['tyre life', 'how long will the tyres last', 'will the tyres last', 'tyres last', 'tyre wear rate', 'how many laps in the tyres'],
  },
  { intent: 'pressures', group: 'The car', phrases: ['tyre pressures', 'pressures'] },
  { intent: 'brakes', group: 'The car', phrases: ['brakes', 'brake wear', 'how are the brakes'] },
  { intent: 'damage', group: 'The car', phrases: ['damage', 'any damage', 'damage report', 'how bad is it'] },
  { intent: 'brakeBias', group: 'The car', phrases: ['brake bias', 'bias'] },
  { intent: 'tractionControl', group: 'The car', phrases: ['traction control', 'traction'] },
  // -- Race control ------------------------------------------------------------
  {
    intent: 'lapsLeft',
    group: 'Race control',
    // The card advertises this one as "Laps / time left", and the 2026-08-20
    // report was that the natural wordings missed: matching is whole-word
    // substring (see matchGrammarText), so "how long IS left", "time left"
    // and "laps to go" all fell through to the cloud path. The list now
    // carries the timed-race wordings ("time…") as first-class phrases —
    // most LMU races are timed, so "time left" is the way the question is
    // actually asked. "how long" alone stays out: it would swallow the pit
    // stop's "how long is the stop".
    phrases: [
      'laps left',
      'laps remaining',
      'remaining laps',
      'laps to go',
      'how many laps',
      'how long left',
      'how long is left',
      'how long remaining',
      'how long to go',
      'time left',
      'time remaining',
      'time to go',
      'how much time',
      'how much longer',
      'minutes left',
    ],
  },
  { intent: 'trackLimits', group: 'Race control', phrases: ['track limits', 'limits', 'penalty points'] },
  {
    intent: 'flags',
    group: 'Race control',
    phrases: ['any yellows', 'yellows', 'flags', 'any flags', 'yellow flag', 'yellow flags', 'where is the yellow', "where's the yellow"],
  },
  // -- Conditions ----------------------------------------------------------------
  {
    intent: 'weather',
    group: 'Conditions',
    phrases: ['weather', 'any rain', 'is it going to rain', 'rain coming', 'track temp', 'track temperature', 'air temperature'],
  },
];

/**
 * The on-demand radio buttons. A wheel / Stream Deck / key press speaks the
 * answer with no microphone. Curated to the asks a driver actually reaches
 * for mid-stint (lap, sectors, gaps, fuel, points); the rest of the grammar
 * stays behind push-to-talk so the bindings page does not grow a row per phrase.
 *
 * `intent` matches engineerCommands' CommandIntent; `label` is what the
 * bindings list shows.
 */
const ENGINEER_CALLOUTS = [
  { intent: 'lastLap', label: 'Call last lap time' },
  { intent: 'sectors', label: 'Call sector times' },
  { intent: 'bestLap', label: 'Call best lap' },
  { intent: 'gapAhead', label: 'Call gap ahead' },
  { intent: 'gapBehind', label: 'Call gap behind' },
  { intent: 'carAhead', label: "Call who's ahead" },
  { intent: 'position', label: 'Call position' },
  { intent: 'lapsLeft', label: 'Call laps / time left' },
  { intent: 'fuel', label: 'Call fuel' },
  { intent: 'trackLimits', label: 'Call track-limit points' },
  { intent: 'damage', label: 'Call damage' },
  { intent: 'tyres', label: 'Call tyres' },
  { intent: 'flags', label: 'Call yellow flags' },
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
  // Local yellows are a rule change (no passing in the zone) and a hazard the
  // driver may be arriving at — same tier as the FCY for the same reason.
  sectorYellow: 'essential',
  sectorClear: 'essential',
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
  practicePace: 'standard',
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
/*  PowerShell sidecars (plain signed .ps1 files, run with -File)              */
/* -------------------------------------------------------------------------- */

/**
 * The player and recognizer live in `electron/sidecars/*.ps1` — real files,
 * shipped via extraResources and SIGNED at build time, spawned with `-File`.
 * They used to be JS strings run through `-EncodedCommand` (because scripts
 * can't run from inside the asar), but encoded PowerShell is a textbook
 * antivirus-heuristic tell, and since v0.79.0 the app ships an extraResources
 * dir anyway — the reason for encoding is gone (v0.79.x Norton field reports).
 * The recognizer's protocol and design rationale are documented in the
 * scripts themselves.
 */
const PLAYER_SIDECAR = 'voice-player.ps1';
const RECOGNIZER_SIDECAR = 'voice-recognizer.ps1';

/**
 * The grammar, run over TEXT: when the dictation grammar out-competes the
 * closed one for an utterance like "mate what's the gap ahead right now",
 * the phrase is still in the words — and a phrase match must never reach the
 * cloud. Longest matching phrase wins (specificity: "pit window" must beat a
 * future "pit"). Whole-word sequences only, apostrophes and punctuation
 * ignored, so SAPI's "whos ahead" still hits "who's ahead".
 */
function matchGrammarText(text) {
  // Whisper writes small numbers as digits ("last 5 average") while the phrase
  // list spells them out — normalize digits to words so the two meet. Only the
  // words that appear in phrases need mapping. Whisper also prefers US
  // spellings ("tire temp", 2026-08-21 log) — fold them to the list's British.
  const DIGIT_WORDS = {
    0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four',
    5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten',
  };
  const norm = (s) =>
    ` ${String(s || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(10|\d)\b/g, (d) => DIGIT_WORDS[d] || d)
      .replace(/\btire\b/g, 'tyre')
      .replace(/\btires\b/g, 'tyres')
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
  if (best) return best.intent;
  return fuzzyGrammarMatch(haystack);
}

/** Levenshtein distance capped at 2 — enough to test "within 1", cheaply. */
function editDistanceLe1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  // One substitution.
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff <= 1;
  }
  // One insertion/deletion: align the shorter into the longer.
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else if (!skipped) {
      skipped = true;
      j++;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Second pass for STT near-misses: the first week's log is full of one-letter
 * mishears that fell through to the cloud and were refused ("LUST five
 * average", 2026-08-19). A multi-word phrase still matches when each word is
 * exact or — for words of 4+ letters — within one edit. Single-word phrases
 * are excluded on purpose: "full" is one edit from "fuel", and a wrong Tier-1
 * answer to a phrase we only nearly heard is the confident-wrong-answer the
 * whole engineer refuses to give. Two aligned words mishearing together is a
 * far taller order.
 */
function fuzzyGrammarMatch(haystack) {
  const words = haystack.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const wordOk = (heard, wanted) =>
    heard === wanted || (wanted.length >= 4 && heard.length >= 4 && editDistanceLe1(heard, wanted));
  let best = null;
  for (const g of GRAMMAR) {
    for (const p of g.phrases) {
      const need = p
        .toLowerCase()
        .replace(/['’]/g, '')
        .split(/\s+/)
        .filter(Boolean);
      if (need.length < 2 || need.length > words.length) continue;
      for (let at = 0; at + need.length <= words.length; at++) {
        let ok = true;
        for (let k = 0; k < need.length; k++) {
          if (!wordOk(words[at + k], need[k])) {
            ok = false;
            break;
          }
        }
        if (ok) {
          const len = need.join(' ').length;
          if (!best || len > best.length) best = { intent: g.intent, length: len };
          break;
        }
      }
    }
  }
  return best ? best.intent : null;
}

function spawnPs(scriptPath, env) {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
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
   * @param {string} opts.dir       download dir, e.g. <userData>/piper
   * @param {string} [opts.whisperDir]  STT download dir, e.g. <userData>/whisper
   * @param {string} [opts.bundledDir]  installer-shipped piper, e.g. <resources>/piper
   * @param {string} [opts.bundledWhisperDir]  installer-shipped whisper
   * @param {string} [opts.sidecarsDir]  the signed .ps1 sidecars — <resources>/sidecars packaged, electron/sidecars in dev
   * @param {() => object} opts.loadSettings
   * @param {(payload: object) => void} [opts.onStatus]
   * @param {(body: object) => Promise<object>} [opts.cloudAsk]
   * @param {() => Promise<object>} [opts.cloudBudget]
   * @param {(id: string, rating: string) => Promise<object>} [opts.cloudRate]
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.whisperDir = opts.whisperDir || path.join(this.dir, '..', 'whisper');
    this.bundledDir = opts.bundledDir || null;
    this.bundledWhisperDir = opts.bundledWhisperDir || null;
    this.sidecarsDir = opts.sidecarsDir || path.join(__dirname, 'sidecars');
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
    // The last question-and-answer, whichever tier answered it — sent with the
    // next Tier-2 ask (when recent) so "and on energy?" resolves as a follow-up.
    this.lastExchange = null; // { question, answer, atMs }
    this.ws = null;
    this.wsTimer = null;
    this.commands = this.commandsMod ? new this.commandsMod.EngineerCommands() : null;
    this.triggers = this.triggersMod
      ? new this.triggersMod.EngineerTriggers({
          practicePaceLapInterval: this.practicePaceReminderLaps(),
        })
      : null;
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

  /**
   * Bundled first, downloads second. The installer ships the engine, the
   * default voice and whisper inside the package (signed — see
   * electron-builder.js) precisely so antivirus never watches this app pull
   * an unknown exe into AppData; the userData dir remains for the other
   * voices, which a driver still downloads in-app (pure model data — the
   * quarantine-bait was always the executable).
   */
  enginePath() {
    if (this.bundledDir) {
      const bundled = path.join(this.bundledDir, 'piper.exe');
      if (fs.existsSync(bundled)) return bundled;
    }
    return path.join(this.dir, 'piper.exe');
  }

  /**
   * Doubles as the download destination: when a voice is not bundled, the
   * path returned is where fetch() writes it. Only the bundled voice ever
   * resolves into the resources dir, and it can never be a download target
   * because voiceInstalled() is true for it.
   */
  modelPath(id) {
    if (this.bundledDir) {
      const bundled = path.join(this.bundledDir, `${id}.onnx`);
      if (fs.existsSync(bundled)) return bundled;
    }
    return path.join(this.dir, `${id}.onnx`);
  }

  /**
   * Where whisper lives, in priority order — bundled first, downloaded second.
   *
   * A LIST rather than one directory, because from v0.91 the two halves come
   * from different places: the installer ships the binaries (small, signed, and
   * the executable was always the thing antivirus objected to) while the 141 MB
   * `ggml-base.en.bin` is downloaded once into userData instead of riding every
   * release. engineerStt.js resolves the engine and the model independently
   * across these roots, so "bundled engine + downloaded model" is a normal,
   * working install rather than two half-installs that each look absent.
   *
   * Bundled stays first for the model too: an install that has not yet taken
   * this update still has one in resources, and re-downloading it would be a
   * pointless 141 MB.
   */
  sttRoots() {
    return [this.bundledWhisperDir, this.whisperDir].filter(Boolean);
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

  /* ---- reclaiming space -------------------------------------------------- */

  /**
   * The voices this app may delete: downloaded, into ITS OWN directory, and not
   * the one currently on the radio.
   *
   * Six voices are on offer at 63-121 MB each, and trying them is the whole
   * point of the Sample and Hear buttons — so a driver who auditions the list
   * ends up with 400 MB of models they will never hear again, and nothing ever
   * tells them or clears them. This is what the panel's "Free up space" offers.
   *
   * Two things are deliberately never listed. A voice that resolves into the
   * BUNDLED directory is part of the install, not our data — deleting it would
   * damage the package and it would come back on the next update anyway. And
   * the selected voice is never offered, even when another is downloading, so
   * the button can never leave the engineer mute.
   */
  removableVoices() {
    const settings = this.loadSettings();
    const selected = settings.engineerVoice;
    // No selected voice means there is no way to tell which one is in use, so
    // nothing is removable. Failing closed here costs a driver some disk;
    // failing open costs them their engineer mid-race.
    if (!selected) return [];
    const out = [];
    for (const v of VOICES) {
      if (v.id === selected || !this.voiceInstalled(v.id)) continue;
      const model = path.join(this.dir, `${v.id}.onnx`);
      // modelPath() resolves bundled-first, so compare against the writable
      // path directly: a voice that is only bundled has no file here.
      if (!fs.existsSync(model)) continue;
      let bytes = 0;
      for (const f of [model, `${model}.json`]) {
        try {
          bytes += fs.statSync(f).size;
        } catch {
          /* the .json is ~1 KB and may be absent — the model is the number */
        }
      }
      out.push({ id: v.id, label: v.label, bytes });
    }
    return out;
  }

  /**
   * Delete one downloaded voice. Returns the bytes freed.
   *
   * Refuses the selected voice and refuses anything outside `this.dir`, rather
   * than trusting the caller: this is a delete driven by an id that arrives
   * over IPC, and the two things it must never do are silence the engineer and
   * reach into the installed package.
   */
  removeVoice(id) {
    const target = this.removableVoices().find((v) => v.id === id);
    if (!target) throw new Error('that voice is not one this app can remove');
    const model = path.join(this.dir, `${id}.onnx`);
    fs.rmSync(model, { force: true });
    fs.rmSync(`${model}.json`, { force: true });
    const m = this.readManifest();
    if (m.voices) delete m.voices[id];
    try {
      fs.writeFileSync(this.manifestPath(), JSON.stringify(m));
    } catch {
      /* the manifest is a nicety; the delete already happened */
    }
    this.pushStatus();
    return target.bytes;
  }

  /** Every removable voice at once. Returns `{ removed, bytes }`. */
  removeUnusedVoices() {
    let bytes = 0;
    let removed = 0;
    for (const v of this.removableVoices()) {
      try {
        bytes += this.removeVoice(v.id);
        removed++;
      } catch {
        // One locked file must not abandon the rest — piper holds the SELECTED
        // voice open while it runs, and that one is not in this list anyway.
      }
    }
    return { removed, bytes };
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

  /** Completed laps between unchanged practice-pace reminders. */
  practicePaceReminderLaps() {
    const settings = this.loadSettings();
    return normalizePracticePaceReminderLaps(
      settings.engineer && settings.engineer.practicePaceReminderLaps,
    );
  }

  /**
   * Apply settings that can change without rebuilding the voice pipeline.
   * The trigger's state stays intact, so changing frequency mid-practice does
   * not manufacture a new "first benchmark" call.
   */
  applyLiveSettings() {
    if (this.triggers?.setPracticePaceLapInterval) {
      this.triggers.setPracticePaceLapInterval(this.practicePaceReminderLaps());
    }
  }

  /** Radio volume 0–100, safe against settings written by older versions. */
  volumePct() {
    const settings = this.loadSettings();
    const v = Number(settings.engineer && settings.engineer.volume);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 100;
  }

  /**
   * The slider position as an amplitude gain. Squared, because ears are
   * logarithmic: linear amplitude leaves the top half of a slider doing almost
   * nothing and the bottom eighth doing everything. Read per clip — a volume
   * change applies to the next line spoken, no pipeline restart.
   */
  volumeGain() {
    const v = this.volumePct() / 100;
    return v * v;
  }

  /** Everything the panel needs to render the tab, as plain data. */
  status() {
    const settings = this.loadSettings();
    const selected = settings.engineerVoice;
    const removable = this.removableVoices();
    return {
      enabled: !!settings.engineerEnabled,
      readouts: this.readoutsPreset(),
      practicePaceReminderLaps: this.practicePaceReminderLaps(),
      volume: this.volumePct(),
      running: this.running,
      engineInstalled: this.engineInstalled(),
      selectedVoice: selected,
      selectedInstalled: this.voiceInstalled(selected),
      busy: this.busy,
      lastError: this.lastError,
      micAvailable: this.recognizer ? this.recognizerReady : null, // null = not started yet
      sttInstalled: stt.installed(this.sttRoots()),
      freeFormLive: this.freeFormLive,
      sttSizeMb: stt.MODEL_MB,
      lastCall: this.lastCall,
      budget: this.budget,
      // Computed once and read twice below: removableVoices() stats the disk
      // per voice, and status() is pushed on every download tick.
      removable,
      voices: VOICES.map((v) => ({
        ...v,
        sampleUrl: sampleUrl(v.id),
        installed: this.voiceInstalled(v.id),
        selected: v.id === selected,
        removable: removable.some((r) => r.id === v.id),
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
      // The bundled binaries count: only what is genuinely missing is fetched.
      await stt.download(this.whisperDir, this.fetch.bind(this), 'stt', this.bundledWhisperDir);
    } catch (err) {
      this.lastError = `Download failed: ${err.message}`;
      throw err;
    } finally {
      this.busy = null;
      this.pushStatus();
    }
  }

  /**
   * Stream a URL to a .part file, promoted on success; progress via file size.
   * Node's own fetch (redirects followed) rather than shelling out to
   * curl.exe — an app spawning curl to pull files is another behaviour
   * antivirus heuristics score against, and this needs nothing curl has.
   */
  async fetch(url, dest, sizeMb, voiceId) {
    const part = `${dest}.part`;
    fs.rmSync(part, { force: true });
    const poll = setInterval(() => {
      try {
        const mb = fs.statSync(part).size / 1e6;
        this.onStatus({ ...this.status(), progress: { voiceId, mb: Math.round(mb), totalMb: sizeMb } });
      } catch {
        /* not created yet */
      }
    }, 1000);
    try {
      const res = await globalThis.fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const { Readable } = require('node:stream');
      const { pipeline } = require('node:stream/promises');
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
      fs.renameSync(part, dest);
    } catch (err) {
      fs.rmSync(part, { force: true });
      throw new Error(`download: ${err && err.message ? err.message : err}`);
    } finally {
      clearInterval(poll);
    }
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
    this.player = spawnPs(path.join(this.sidecarsDir, PLAYER_SIDECAR));
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
          this.radioFx.radioify(wav, out, this.volumeGain());
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
    this.recognizer = spawnPs(path.join(this.sidecarsDir, RECOGNIZER_SIDECAR), {
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
    // The player deletes what it plays; hand it a throwaway copy — scaled to
    // the radio volume on the way, since the master chirp is kept full-level.
    const copy = path.join(this.wavDir, `chirp-${Date.now()}.wav`);
    try {
      const gain = this.volumeGain();
      if (gain >= 1) {
        fs.copyFileSync(this.chirpPath, copy);
      } else {
        const { sampleRate, samples } = this.radioFx.readWav(this.chirpPath);
        for (let i = 0; i < samples.length; i++) samples[i] *= gain;
        this.radioFx.writeWav(copy, sampleRate, samples);
      }
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
   * Bound callout: speak one phrase-list answer now, no microphone. This is
   * the Stream Deck / wheel-button path — driver-initiated, so it cuts in
   * front of a held readout the same way {@link ask} does. The listen window
   * is untouched: a callout never opens the mic.
   */
  speakIntent(intent) {
    if (!this.running) return { ok: false, error: 'Engineer is not running — enable it first' };
    if (!this.commands || !this.commandsMod) {
      return { ok: false, error: 'Engineer commands unavailable' };
    }
    const known = this.commandsMod.COMMAND_INTENTS;
    if (!Array.isArray(known) || !known.includes(intent)) {
      return { ok: false, error: `unknown engineer callout: ${intent}` };
    }
    this.heldReadout = null; // the driver's call always wins
    const answer = this.commands.answer(intent);
    const text = answer && answer.text;
    if (!text) return { ok: false, error: 'No answer' };
    this.speak(text);
    return { ok: true, text };
  }

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
        const g = GRAMMAR.find((x) => x.intent === heard.intent);
        this.lastExchange = {
          question: (g && g.phrases[0]) || heard.intent,
          answer: answer.text,
          atMs: Date.now(),
        };
        return { ok: true };
      }

      // Dictation caught it instead: a free-form question — unless a phrase is
      // buried in the dictation text, in which case the grammar still wins.
      if (heard.kind === 'FREE') {
        const intent = matchGrammarText(heard.text);
        if (intent && this.commands) {
          const answer = this.commands.answer(intent);
          this.speak(answer.text);
          this.lastExchange = { question: heard.text, answer: answer.text, atMs: Date.now() };
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
    const whisperAt = this.sttRoots();
    if (wav && stt.installed(whisperAt)) {
      try {
        const trimmed = path.join(this.wavDir, `ask-16k-${Date.now()}.wav`);
        const clip = stt.trimForWhisper(this.radioFx, wav, trimmed);
        if (clip) {
          const result = await stt.transcribeAsync(whisperAt, clip.path);
          question = (result.text || '').trim();
          sttMs = result.ms;
        }
      } catch {
        question = '';
      }
    }
    if (!question) question = String(dictationText || '').trim();
    // Whisper renders silence and coughs as "..." or a stray syllable, and each
    // one was burning a budgeted cloud call to be told "Say again?" (2026-08-22
    // log). Fewer than four letters cannot be a question — say it locally.
    if (question.length < 3 || (question.match(/[a-z]/gi) || []).length < 4) {
      this.speak('Say again?');
      return;
    }
    if (!this.cloudAsk) return; // no cloud hook wired (dev harness) — silence
    if (!this.summaryMod || !this.lastFrame) {
      this.speak('No telemetry.');
      return;
    }
    // Hand the summary Tier 1's lap-history read, so a pace question the
    // grammar missed still gets real averages instead of "no read" — and the
    // trend/pit-exit extras, so "is he catching me" asked in any wording has
    // the same per-lap history the phrase list answers from.
    const avgOf = this.commands ? (slotId) => this.commands.averageOf(slotId) : undefined;
    const extras = this.commands ? this.commands.summaryExtras() : undefined;
    const summary = this.summaryMod.engineerSummary(this.lastFrame, avgOf, extras);
    if (!summary || !summary.connected) {
      this.speak('No telemetry.');
      return;
    }
    // A question hard on the heels of an answer is often a follow-up ("and on
    // energy?", "how many laps is that") — give the model the exchange it is
    // following up on. 90 s: within-a-corner-or-two recency, not the whole race.
    const prevAge = this.lastExchange ? Date.now() - this.lastExchange.atMs : Infinity;
    const previous =
      this.lastExchange && prevAge < 90_000
        ? {
            question: this.lastExchange.question,
            answer: this.lastExchange.answer,
            secondsAgo: Math.round(prevAge / 1000),
          }
        : undefined;
    let res;
    try {
      res = await this.cloudAsk(previous ? { question, summary, sttMs, previous } : { question, summary, sttMs });
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
    this.lastExchange = { question, answer: body.answer, atMs: Date.now() };
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
    this.radioFx.radioify(wav, out, this.volumeGain());
    // One-shot player: the resident one may not exist while the feature is off.
    const player = spawnPs(path.join(this.sidecarsDir, PLAYER_SIDECAR));
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

module.exports = { EngineerService, VOICES, GRAMMAR, ENGINEER_CALLOUTS, sampleUrl, matchGrammarText };
