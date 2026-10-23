/**
 * scripts/test-mic-picker.js — which microphone the engineer listens on.
 * -----------------------------------------------------------------------------
 * Field report, 2026-10-23: a tester's engineer said there was no microphone
 * while his headset was plugged in. Three things were wrong, and each has a
 * section here:
 *
 *   * the listener sidecar took Windows' default device or nothing, died
 *     silently when the device would not open (privacy switch, exclusive
 *     mode, a headset connected after launch), and the panel's only words for
 *     any of it were "no microphone was found" — until the app restarted;
 *   * it read "no microphone" for the first second of every start, before
 *     the listener had said anything at all;
 *   * there was no way to pick a device.
 *
 * Covered: the picker's rules (control-panel/mic-picker.js — ids, scan
 * parsing, the dropdown, the fallback wording, the "nothing found" advice),
 * the saved setting, and EngineerService's side of the sidecar protocol
 * (MIC / NOMIC / MICERR, restart on a new choice or a dead listener, scan and
 * test with PowerShell stubbed). The real sidecar is exercised only where
 * PowerShell exists (Windows), with a stand-in script — no microphone needed.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIC = require('../electron/control-panel/mic-picker');
const { sanitizeEngineer, DEFAULT_ENGINEER_SETTINGS } = require('../electron/engineer-settings');
const { EngineerService, foldMicTest, MIC_DOWN_LINE, OUTCOME_SLUG_PREFIX } = require('../electron/engineer');
const catalog = require('../electron/control-panel/feature-catalog');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const TOKENS = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\AudioInput\\TokenEnums\\MMAudioIn\\';
const HEADSET = TOKENS + '{0.0.1.00000000}.{34afecad-d224-4381-868a-c051f058dd1d}';
const WEBCAM = TOKENS + '{0.0.1.00000000}.{8ea8908a-435d-47bf-a530-73c72ff103c9}';
const GONE = TOKENS + '{0.0.1.00000000}.{00000000-dead-beef-0000-000000000000}';

/** A scan line exactly as voice-mics.ps1 prints it (list mode). */
function scanLine({ devices = [], defaultName = '', privacy = {}, speechDefault = TOKENS } = {}) {
  return JSON.stringify({
    devices,
    defaultName,
    speechDefault,
    privacy: { device: 'Allow', user: 'Allow', desktop: 'Allow', ...privacy },
  });
}
const TWO = [
  { id: HEADSET, name: 'Headset Microphone (Arctis 7)' },
  { id: WEBCAM, name: 'Microphone (EMEET SmartCam C960)' },
];

async function main() {
  /* ======================================================================== */
  console.log('\n1) Only a SAPI audio-input token is ever a microphone id');
  /* ======================================================================== */
  check('a real token id is accepted', MIC.isMicId(HEADSET));
  check("'' (System default) is not an id — it is the absence of one", !MIC.isMicId(''));
  check('a path elsewhere in the registry is refused', !MIC.isMicId('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\Run\\x'));
  check('a tab or newline (protocol separators) is refused', !MIC.isMicId(HEADSET + '\tREADY') && !MIC.isMicId(HEADSET + '\nLISTEN'));
  check('a browser deviceId is refused', !MIC.isMicId('a1b2c3d4e5f6'));
  check('an absurdly long id is refused', !MIC.isMicId(TOKENS + 'x'.repeat(500)));
  check('non-strings are refused', !MIC.isMicId(null) && !MIC.isMicId(42) && !MIC.isMicId({}));

  /* ======================================================================== */
  console.log('\n2) The scan parses — and a broken scan never reads as "no microphones"');
  /* ======================================================================== */
  {
    const scan = MIC.parseScan(scanLine({ devices: TWO, defaultName: 'Headset Microphone (Arctis 7)' }));
    check('devices, default and privacy come through', scan.ok && scan.devices.length === 2 && scan.defaultName === 'Headset Microphone (Arctis 7)' && scan.privacy.desktop === 'Allow');
    const single = MIC.parseScan(JSON.stringify({ devices: TWO[0], privacy: {} }));
    check('a one-device scan written as a bare object still lists it', single.ok && single.devices.length === 1);
    const bom = MIC.parseScan('\uFEFF' + scanLine({ devices: TWO }) + '\r\n');
    check('a BOM and CRLF are tolerated', bom.ok && bom.devices.length === 2);
    const noisy = MIC.parseScan('WARNING: something\r\n' + scanLine({ devices: TWO }));
    check('PowerShell noise before the JSON line is ignored', noisy.ok && noisy.devices.length === 2);
    const dup = MIC.parseScan(scanLine({ devices: [TWO[0], TWO[0], { id: 'junk', name: 'x' }] }));
    check('duplicates and non-token ids are dropped', dup.ok && dup.devices.length === 1);
    const unnamed = MIC.parseScan(scanLine({ devices: [{ id: HEADSET, name: '' }] }));
    check('a device with no name still gets a label', unnamed.devices[0].name === 'Unnamed microphone');
    const empty = MIC.parseScan('');
    check('no output is a FAILED scan, not zero devices', empty.ok === false && /nothing/.test(empty.error));
    const garbage = MIC.parseScan('{not json');
    check('unreadable output is a failed scan', garbage.ok === false);
    const err = MIC.parseScan(JSON.stringify({ error: 'Class not registered' }));
    check("the sidecar's own error is carried through", err.ok === false && err.error === 'Class not registered');
    const zero = MIC.parseScan(scanLine({ devices: [] }));
    check('a clean scan with nothing in it is ok with 0 devices', zero.ok && zero.devices.length === 0);
  }

  /* ======================================================================== */
  console.log('\n3) The dropdown: System default first, saved choice survives an unplug');
  /* ======================================================================== */
  {
    const scan = MIC.parseScan(scanLine({ devices: TWO, defaultName: 'Microphone (EMEET SmartCam C960)' }));
    const opts = MIC.pickerOptions(scan, { id: HEADSET, name: 'Headset Microphone (Arctis 7)' });
    check('"System default" is first and says what it is right now', opts[0].value === '' && opts[0].label === 'System default — Microphone (EMEET SmartCam C960)');
    check('then every input the scan found', opts.length === 3 && opts[1].value === HEADSET && opts[2].value === WEBCAM);
    check('a connected saved choice is not duplicated', opts.filter((o) => o.value === HEADSET).length === 1);

    const before = MIC.pickerOptions(null, { id: HEADSET, name: 'Headset Microphone (Arctis 7)' });
    check('before any scan: default plus the saved choice, NOT called missing', before.length === 2 && before[1].value === HEADSET && !before[1].missing && !/not connected/.test(before[1].label));

    const gone = MIC.pickerOptions(scan, { id: GONE, name: 'HyperX Cloud II' });
    const last = gone[gone.length - 1];
    check('an unplugged saved choice stays in the list, marked', last.value === GONE && last.missing && last.label === 'HyperX Cloud II — not connected');
    check('savedMissing() agrees', MIC.savedMissing(scan, { id: GONE }) && !MIC.savedMissing(scan, { id: HEADSET }) && !MIC.savedMissing(null, { id: GONE }));
    const noName = MIC.pickerOptions(scan, { id: GONE, name: '' });
    check('a saved choice with no stored name is still named', noName[noName.length - 1].label === 'Your saved microphone — not connected');
    check('a plain System default label without a scan', MIC.pickerOptions(null, {})[0].label === 'System default');
  }

  /* ======================================================================== */
  console.log('\n4) Nothing found / blocked: say what and how many, never a bare "no microphone"');
  /* ======================================================================== */
  {
    const none = MIC.scanSummary(MIC.parseScan(scanLine({ devices: [] })), {});
    check('0 devices: says Windows reported 0 input devices', /0 input devices/.test(none.text), none.text);
    check('…points at the Windows microphone privacy switches', /Let desktop apps access your microphone/.test(none.text) && /Privacy & security › Microphone/.test(none.text));
    check('…offers the privacy page, warns', none.privacyHelp && none.tone === 'warn');
    check('…and never says just "no microphone"', !/^no microphone/i.test(none.text));

    const blocked = MIC.scanSummary(MIC.parseScan(scanLine({ devices: TWO, privacy: { desktop: 'Deny' } })), {});
    check('desktop apps blocked: names that exact switch', /"Let desktop apps access your microphone" is Off/.test(blocked.text), blocked.text);
    check('…and still says how many devices Windows reported', /2 input devices/.test(blocked.text));
    check('…offers the privacy page', blocked.privacyHelp && blocked.tone === 'warn');
    const master = MIC.scanSummary(MIC.parseScan(scanLine({ devices: TWO, privacy: { user: 'Deny', desktop: 'Deny' } })), {});
    check('the master switch is named before the desktop one', /"Microphone access" is Off/.test(master.text));
    check('privacyBlocks lists every Deny in order', MIC.privacyBlocks({ device: 'Deny', user: 'Allow', desktop: 'deny' }).map((b) => b.key).join() === 'device,desktop');
    check('missing consent values are not treated as blocked', MIC.privacyBlocks({ device: null, user: null, desktop: null }).length === 0);

    const missing = MIC.scanSummary(MIC.parseScan(scanLine({ devices: TWO })), { id: GONE, name: 'HyperX Cloud II' });
    check('saved device gone: plain fallback sentence', missing.text.startsWith('"HyperX Cloud II" isn\'t connected, so the engineer is using the system default'), missing.text);
    const ok = MIC.scanSummary(MIC.parseScan(scanLine({ devices: TWO })), { id: HEADSET });
    check('all well: a count, no warning', ok.text === 'Found 2 input devices.' && ok.tone === '');
    const one = MIC.scanSummary(MIC.parseScan(scanLine({ devices: [TWO[0]] })), {});
    check('singular wording for one device', one.text === 'Found 1 input device.');
    const failed = MIC.scanSummary({ ok: false, error: 'the device scan timed out', devices: [] }, {});
    check('a failed scan says it failed and how to retry', /Couldn't list microphones \(the device scan timed out\)/.test(failed.text) && !failed.privacyHelp);
  }

  /* ======================================================================== */
  console.log('\n5) The listener\'s own word on its mic, and SAPI errors in plain English');
  /* ======================================================================== */
  {
    check('off: nothing to say', MIC.micLine({ state: 'off' }) === null && MIC.micLine(null) === null);
    check('starting: "checking", NOT "no microphone"', MIC.micLine({ state: 'starting' })[0] === 'Checking the microphone…');
    const picked = MIC.micLine({ state: 'ok', source: 'picked', name: 'Headset Microphone (Arctis 7)' });
    check('picked: names the device, live', picked[0] === 'Listening on Headset Microphone (Arctis 7).' && picked[1] === 'live');
    const def = MIC.micLine({ state: 'ok', source: 'default', name: 'Microphone (EMEET SmartCam C960)' });
    check('default: says which device the default is', def[0] === 'Listening on the system default (Microphone (EMEET SmartCam C960)).');
    const fb = MIC.micLine({ state: 'ok', source: 'fallback', name: 'Microphone (EMEET SmartCam C960)', savedName: 'HyperX Cloud II' });
    check('fallback: names the missing device and the stand-in, warns', fb[1] === 'warn' && /^"HyperX Cloud II" isn't connected — listening on the system default \(Microphone \(EMEET/.test(fb[0]), fb[0]);
    const none = MIC.micLine({ state: 'none', problem: 'No audio device is installed.' });
    check('none: translated, and says it retries on every press', none[1] === 'warn' && /no recording device to hand over/.test(none[0]) && /every press/.test(none[0]), none[0]);
    check('"Audio device error" reads as exclusive mode / privacy', /exclusive mode/.test(MIC.plainMicError('Audio device error encountered.')));
    check('SPERR_NOT_FOUND reads as nothing to hand over', /no recording device/.test(MIC.plainMicError('Exception from HRESULT: 0x8004503A')));
    check('an unknown error is passed through verbatim', MIC.plainMicError('Something odd') === 'Something odd');
    check('meter: silence is empty, speech is visible, never over 100', MIC.meterPct(0) === 0 && MIC.meterPct(1) >= 2 && MIC.meterPct(40) > 50 && MIC.meterPct(100) === 100 && MIC.meterPct('x') === 0);
    check('test heard speech → good to go', MIC.testSummary({ ok: true, peak: 30, speech: true, name: 'Arctis' }).tone === 'live');
    check('test faint → speak up / raise level', /faint/.test(MIC.testSummary({ ok: true, peak: 3, speech: false }).text));
    check('test silent → mute switch and privacy', /mute switch/.test(MIC.testSummary({ ok: true, peak: 0, speech: false }).text));
    check('test failed → plain reason', /^Mic test failed: the device would not open/.test(MIC.testSummary({ ok: false, error: 'Audio device error encountered.' }).text));
  }

  /* ======================================================================== */
  console.log('\n6) The setting: System default is a real choice, junk never reaches SAPI');
  /* ======================================================================== */
  {
    check('defaults: System default, no name', DEFAULT_ENGINEER_SETTINGS.micId === '' && DEFAULT_ENGINEER_SETTINGS.micName === '');
    const older = sanitizeEngineer({ readouts: 'standard' });
    check('settings from before the picker read as System default', older.micId === '' && older.micName === '');
    const picked = sanitizeEngineer({ micId: HEADSET, micName: 'Headset\nMicrophone' });
    check('a token id is kept, its name cleaned to one line', picked.micId === HEADSET && picked.micName === 'Headset Microphone');
    const back = sanitizeEngineer({ ...picked, micId: '', micName: 'whatever' }, picked);
    check("picking System default ('') wins over the saved device and clears the name", back.micId === '' && back.micName === '');
    const junk = sanitizeEngineer({ ...picked, micId: 'C:\\evil.ps1' }, picked);
    check('a junk id keeps what was saved', junk.micId === HEADSET && junk.micName === 'Headset Microphone');
    const volumeOnly = sanitizeEngineer({ ...picked, volume: 40 }, picked);
    check('changing another engineer field keeps the mic (merge-then-sanitize)', volumeOnly.micId === HEADSET && volumeOnly.volume === 40);
    const renamed = sanitizeEngineer({ micId: HEADSET }, picked);
    check('same id, no name sent: the stored name survives', renamed.micName === 'Headset Microphone');
    const long = sanitizeEngineer({ micId: HEADSET, micName: 'x'.repeat(500) });
    check('names are capped', long.micName.length === MIC.MAX_NAME);
  }

  /* ======================================================================== */
  console.log('\n7) The service: MIC / NOMIC / MICERR from the listener');
  /* ======================================================================== */
  function svcWith(engineer = {}) {
    const settings = { engineerEnabled: true, engineerVoice: 'en_GB-alan-medium', engineer: { readouts: 'standard', ...engineer } };
    const logged = [];
    const counted = [];
    const svc = new EngineerService({
      dir: path.join(os.tmpdir(), 'apex-mic-test'),
      loadSettings: () => settings,
      onStatus: () => {},
      log: (line) => logged.push(line),
      noteUsage: (slug) => counted.push(slug.slice(OUTCOME_SLUG_PREFIX.length)),
    });
    svc.pushStatus = () => {};
    return { svc, settings, logged, counted };
  }
  {
    const { svc, logged } = svcWith({ micId: GONE, micName: 'HyperX Cloud II' });
    check('saved choice is read back validated', svc.micChoice().id === GONE && svc.micChoice().name === 'HyperX Cloud II');
    svc.recognizer = {}; // spawned, nothing said yet
    svc.mic = { state: 'starting', source: null, name: '', why: '', problem: null };
    check('while the listener starts: micAvailable is null, not false', svc.status().micAvailable === null);
    svc.onRecognizerLine('MIC\tfallback\tMicrophone (EMEET SmartCam C960)\tmissing');
    const st = svc.status();
    check('MIC fallback: available, source and name recorded', st.micAvailable === true && st.mic.source === 'fallback' && st.mic.name === 'Microphone (EMEET SmartCam C960)');
    check('…the saved choice rides along for the panel', st.mic.savedId === GONE && st.mic.savedName === 'HyperX Cloud II');
    check('…and the fallback is logged in words', logged.some((l) => /mic fallback "Microphone \(EMEET SmartCam C960\)" — saved "HyperX Cloud II" not connected/.test(l)), logged.join(' | '));
    svc.onRecognizerLine('NOMIC\tNo audio device is installed.');
    check('NOMIC: micAvailable false, the reason kept', svc.status().micAvailable === false && svc.status().mic.problem === 'No audio device is installed.');
    check('a NOMIC is not a fatal lastError (the panel line stays mic-specific)', svc.lastError === null);

    let got = null;
    svc.pendingListen = (r) => (got = r);
    svc.onRecognizerLine('MIC\tpicked\tHeadset');
    check('a MIC line during a listen does not end the listen', got === null && svc.pendingListen !== null);
    svc.onRecognizerLine('MICERR\tAudio device error encountered.');
    check('MICERR answers the pending press with the reason', got && got.kind === 'MICERR' && got.error === 'Audio device error encountered.');
    check('…and marks the mic down', svc.status().micAvailable === false);
    svc.onRecognizerLine('ERROR\tgrammar file missing');
    check('ERROR (grammar) is a listener failure, not "Microphone:"', /^The listener couldn't start: grammar file missing/.test(svc.lastError));
  }

  /* ======================================================================== */
  console.log('\n8) A press with no microphone says so — over the radio and in the counters');
  /* ======================================================================== */
  {
    const { svc, counted } = svcWith();
    const spoken = [];
    svc.running = true;
    svc.recognizerReady = true;
    svc.freeFormLive = true;
    svc.speak = (t) => spoken.push(t);
    svc.playChirp = () => {};
    svc.recognizer = { stdin: { write: () => setImmediate(() => svc.onRecognizerLine('MICERR\tAudio device error encountered.')) } };
    const res = await svc.ask();
    check('the press fails with a plain reason', res.ok === false && /^Microphone: the device would not open/.test(res.error), res.error);
    check('the driver hears why, in the car', spoken.length === 1 && spoken[0] === MIC_DOWN_LINE);
    check("it lands in the 'no-mic' outcome", counted.includes('no-mic') && res.outcome === 'no-mic', counted.join());
    check("'no-mic' is in the feature catalog (catalog-first)", catalog.allSlugs().includes(OUTCOME_SLUG_PREFIX + 'no-mic'));
    check('the picker actions are catalogued too', catalog.allSlugs().includes('action:engineer.mic') && catalog.allSlugs().includes('action:engineer.mic-test'));
    check('the radio line is short (≤14 words)', MIC_DOWN_LINE.split(/\s+/).length <= 14);
  }
  {
    const { svc, counted } = svcWith();
    let restarted = 0;
    svc.running = true;
    svc.recognizerReady = false;
    svc.recognizerExited = true;
    svc.restartListener = () => restarted++;
    const res = await svc.ask();
    check('a dead listener is restarted by the press, not left for an app restart', restarted === 1 && res.ok === false && /restarted/.test(res.error));
    check('…counted as not-ready', counted.includes('not-ready'));
    svc.recognizerExited = false;
    const res2 = await svc.ask();
    check('a listener still starting is not restarted', restarted === 1 && res2.error === 'Microphone not ready');
  }

  /* ======================================================================== */
  console.log('\n9) A new choice restarts only the listener');
  /* ======================================================================== */
  {
    const { svc, settings } = svcWith({ micId: '' });
    let restarted = 0;
    svc.restartListener = () => {
      restarted++;
      svc.listenerMicId = svc.micChoice().id;
    };
    svc.running = true;
    svc.listenerMicId = '';
    svc.applyLiveSettings();
    check('same choice: no restart', restarted === 0);
    settings.engineer.micId = HEADSET;
    svc.applyLiveSettings();
    check('new choice while running: listener restarted once', restarted === 1 && svc.listenerMicId === HEADSET);
    svc.applyLiveSettings();
    check('…and not again for the next unrelated change', restarted === 1);
    svc.running = false;
    settings.engineer.micId = WEBCAM;
    svc.applyLiveSettings();
    check('not running: nothing restarted (start() reads the choice)', restarted === 1);
  }

  /* ======================================================================== */
  console.log('\n10) Scan and test, with PowerShell stood in for');
  /* ======================================================================== */
  {
    const { svc, logged } = svcWith();
    let runs = 0;
    svc.runMicsSidecar = async (env) => {
      runs++;
      check('scan runs the sidecar in list mode', env.APEX_MIC_MODE === 'list');
      return { lines: [scanLine({ devices: TWO, defaultName: 'Headset Microphone (Arctis 7)', privacy: { desktop: 'Deny' } })], error: null };
    };
    const [a, b] = await Promise.all([svc.scanMics(), svc.scanMics()]);
    check('two clicks, one scan (single-flight)', runs === 1 && a === b);
    check('the scan is parsed and kept for status()', a.ok && a.devices.length === 2 && svc.status().micScan === a);
    check('…and logged with the privacy switches', logged.some((l) => /mic scan: 2 inputs, default "Headset Microphone \(Arctis 7\)", privacy device=Allow user=Allow desktop=Deny/.test(l)), logged.join(' | '));
    svc.runMicsSidecar = async () => ({ lines: [], error: 'the device scan timed out' });
    const t = await svc.scanMics();
    check('a timed-out scan is a failed scan with the reason', t.ok === false && t.error === 'the device scan timed out');
  }
  {
    const { svc, logged } = svcWith({ micId: HEADSET, micName: 'Arctis' });
    const levels = [];
    svc.onMicLevel = (p) => levels.push(p);
    let env = null;
    svc.runMicsSidecar = async (e, _t, onLine) => {
      env = e;
      for (const l of ['MIC\tpicked\tHeadset Microphone (Arctis 7)\t', 'LEVEL\t0', 'LEVEL\t12', 'SPEECH', 'LEVEL\t37', 'DONE\t37\t1']) onLine(l);
      return { lines: [], error: null };
    };
    const res = await svc.testMic(WEBCAM);
    check('the test listens on the device chosen in the dropdown', env.APEX_MIC_MODE === 'test' && env.APEX_MIC_ID === WEBCAM && Number(env.APEX_MIC_SECONDS) > 0);
    check('levels stream to the meter, then a done marker', levels.map((p) => p.level).join() === '0,12,37,0' && levels[levels.length - 1].done === true);
    check('the verdict: heard speech, peak, which device', res.ok && res.speech && res.peak === 37 && res.name === 'Headset Microphone (Arctis 7)' && res.source === 'picked');
    check('…logged', logged.some((l) => /mic test picked "Headset Microphone \(Arctis 7\)": peak=37 speech=true/.test(l)));
    await svc.testMic('not-a-token');
    check('a junk id from the renderer tests the SAVED choice instead', env.APEX_MIC_ID === HEADSET);
    await svc.testMic('');
    check("'' tests System default", env.APEX_MIC_ID === '');
    svc.runMicsSidecar = async (_e, _t, onLine) => {
      onLine('MIC\tdefault\tMic\t');
      onLine('MICERR\tAudio device error encountered.');
      return { lines: [], error: null };
    };
    const bad = await svc.testMic('');
    check('a device that will not open fails the test with the reason', bad.ok === false && bad.error === 'Audio device error encountered.');
  }
  {
    const f = foldMicTest();
    f.add('NOMIC\tNo audio device is installed.');
    check('NOMIC fails the test', f.result(null).ok === false && f.result(null).error === 'No audio device is installed.');
    const g = foldMicTest();
    check('no MIC line at all: the run error, or "did not start"', g.result('the device scan timed out').error === 'the device scan timed out' && g.result(null).error === 'the test did not start');
    const h = foldMicTest();
    check('LEVEL is clamped 0–100', h.add('LEVEL\t250') === 100 && h.add('LEVEL\t-4') === 0 && h.add('LEVEL\tnope') === 0);
  }

  /* ======================================================================== */
  console.log('\n11) The sidecars: the listener never dies over a microphone');
  /* ======================================================================== */
  {
    const dir = path.join(__dirname, '..', 'electron', 'sidecars');
    const rec = fs.readFileSync(path.join(dir, 'voice-recognizer.ps1'), 'utf8');
    const mics = path.join(dir, 'voice-mics.ps1');
    const input = path.join(dir, 'mic-input.ps1');
    check('voice-mics.ps1 and mic-input.ps1 ship beside the listener', fs.existsSync(mics) && fs.existsSync(input));
    check('the listener dot-sources the shared device choice', /\. \(Join-Path \$PSScriptRoot 'mic-input\.ps1'\)/.test(rec));
    check('…and the scan/test sidecar does too', /\. \(Join-Path \$PSScriptRoot 'mic-input\.ps1'\)/.test(fs.readFileSync(mics, 'utf8')));
    check('the listener takes APEX_ENGINEER_MIC', /\$env:APEX_ENGINEER_MIC/.test(rec));
    check('Recognize() is inside a try (an unopenable device was an uncaught exit)', /try \{\s*\r?\n(\s*Clear-Queued\r?\n)?\s*\$r = \$rec\.Recognize\(/.test(rec));
    check('…which answers MICERR for that press', /MICERR`t/.test(rec));
    check('the input is no longer set once at start with no retry', !/^\s*\$rec\.SetInputToDefaultAudioDevice\(\)/m.test(rec));
    check('every sidecar is plain ASCII (PowerShell 5.1 reads BOM-less files as ANSI)',
      [mics, input].every((p) => /^[\x00-\x7f]*$/.test(fs.readFileSync(p, 'utf8'))));
    const engineerSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'engineer.js'), 'utf8');
    check('the mics sidecar is run with -File like the others (spawnPs)', /MICS_SIDECAR = 'voice-mics\.ps1'/.test(engineerSrc) && !engineerSrc.includes("'-EncodedCommand'"));
  }

  /* ======================================================================== */
  console.log('\n12) Windows only: the real listener hands the choice to its mic line');
  /* ======================================================================== */
  if (process.platform !== 'win32') {
    console.log('  SKIP  not Windows');
  } else {
    // A stand-in listener: prints what it was given, the way the real one
    // does after choosing — so the spawn wiring (env, stdout, MIC parsing,
    // status) is real without a microphone or a grammar.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-mic-sidecar-'));
    fs.writeFileSync(
      path.join(tmp, 'voice-recognizer.ps1'),
      "[Console]::Out.WriteLine(\"MIC`tpicked`t\" + $env:APEX_ENGINEER_MIC + \"`t\"); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); $null = [Console]::In.ReadLine()\r\n",
    );
    const { svc } = svcWith({ micId: HEADSET, micName: 'Arctis' });
    svc.sidecarsDir = tmp;
    svc.running = true;
    let resolveReady;
    const ready = new Promise((r) => (resolveReady = r));
    svc.pushStatus = () => {
      if (svc.recognizerReady && svc.mic.state === 'ok') resolveReady();
    };
    svc.spawnListener();
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 15000));
    const outcome = await Promise.race([ready.then(() => 'ready'), timeout]);
    check('the spawned listener came up and said which mic', outcome === 'ready', outcome);
    check('it was handed the saved token id through APEX_ENGINEER_MIC', svc.mic.name === HEADSET, svc.mic.name);
    check('the running listener remembers which choice it has', svc.listenerMicId === HEADSET);
    const child = svc.recognizer;
    svc.running = false;
    svc.recognizer = null;
    try {
      child.kill();
    } catch {}
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
