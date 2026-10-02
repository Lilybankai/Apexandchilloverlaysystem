/**
 * scripts/test-engineer-ask.js — the push-to-talk press, end to end, headless.
 * -----------------------------------------------------------------------------
 * The recognizer sidecar, whisper and the cloud are all stubbed; what is real
 * is EngineerService's decision path: which sidecar line means what, which
 * branch of ask()/askTier2() a press takes, what the driver hears, and which
 * `action:engineer.outcome.*` counter it lands in.
 *
 * Two field reports drove this suite (2026-10-01/02):
 *   1. "what's my average" always got "Say again?" — on a PC without Windows
 *      dictation SAPI rejected every free-form sentence and the audio was
 *      thrown away. The sidecar now prints REJECTED with the clip.
 *   2. Of 106 presses only 22 reached the cloud log; the rest were invisible.
 *      Every press now ends in exactly one counted outcome.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EngineerService,
  ENGINEER_OUTCOMES,
  OUTCOME_SLUG_PREFIX,
} = require('../electron/engineer');
const catalog = require('../electron/control-panel/feature-catalog');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/**
 * A service with every external stubbed. `line` is what the sidecar prints
 * for the LISTEN; `whisper` what transcribeClip returns; `cloud` the
 * cloudAsk reply (a value, a function, or an Error to throw).
 */
function rig({ line = 'NONE', whisper = '', cloud, dictation = true, frame = {}, connected = true } = {}) {
  const counted = [];
  const svc = new EngineerService({
    dir: path.join(os.tmpdir(), 'apex-ask-test'),
    loadSettings: () => ({ engineerEnabled: true, engineer: { readouts: 'standard' } }),
    onStatus: () => {},
    noteUsage: (slug) => counted.push(slug),
    cloudAsk:
      cloud === undefined
        ? undefined
        : async (body) => {
            sent.push(body);
            if (cloud instanceof Error) throw cloud;
            return typeof cloud === 'function' ? cloud(body) : cloud;
          },
  });
  const sent = [];
  const spoken = [];
  const listens = [];
  svc.running = true;
  svc.recognizerReady = true;
  svc.freeFormLive = dictation;
  svc.speak = (text) => spoken.push(text);
  svc.pushStatus = () => {};
  svc.playChirp = () => {};
  svc.recognizer = {
    stdin: {
      write: (cmd) => {
        listens.push(cmd);
        setImmediate(() => svc.onRecognizerLine(line));
      },
    },
  };
  const clips = [];
  svc.transcribeClip = async (wav) => {
    clips.push(wav);
    return { question: whisper, sttMs: whisper ? 900 : null };
  };
  svc.commands = {
    answer: (intent) => ({ text: `answer:${intent}` }),
    answerPosition: (q) => ({ text: `position:${q.intent}:${q.positions.join('-')}` }),
    averageOf: () => null,
    summaryExtras: () => undefined,
  };
  svc.summaryMod = { engineerSummary: () => ({ connected }) };
  svc.lastFrame = frame;
  const outcomes = () => counted.map((s) => s.slice(OUTCOME_SLUG_PREFIX.length));
  return { svc, spoken, counted, outcomes, sent, clips, listens };
}

async function main() {
  /* ======================================================================== */
  console.log('\n1) Sidecar lines parse into listen results');
  /* ======================================================================== */
  {
    const parse = (line) => {
      const svc = new EngineerService({ dir: os.tmpdir(), loadSettings: () => ({}) });
      svc.pushStatus = () => {};
      let got = null;
      svc.pendingListen = (r) => (got = r);
      svc.onRecognizerLine(line);
      return got;
    };
    const heard = parse('HEARD\tgapAhead\t0.95\tC:\\w\\free-1.wav\tgap ahead');
    check('HEARD carries intent, confidence, wav and text',
      heard.kind === 'HEARD' && heard.intent === 'gapAhead' && heard.confidence === 0.95 &&
        heard.wav === 'C:\\w\\free-1.wav' && heard.text === 'gap ahead');
    check('an exact phrase is not wrapped', heard.wrapped === false);
    const wrappedHit = parse('HEARD\tgapAhead~w\t0.91\tC:\\w\\free-1b.wav\twhats the gap');
    check('a wildcard-twin hit strips the marker and says it was wrapped',
      wrappedHit.intent === 'gapAhead' && wrappedHit.wrapped === true);
    const free = parse('FREE\tC:\\w\\free-2.wav\t0.43\tshall we change strategy');
    check('FREE carries wav, confidence and text',
      free.kind === 'FREE' && free.wav === 'C:\\w\\free-2.wav' && free.confidence === 0.43 &&
        free.text === 'shall we change strategy');
    const rej = parse('REJECTED\tC:\\w\\free-3.wav\t0.08\t... traction ...');
    check('REJECTED parses like FREE — the clip survives',
      rej.kind === 'REJECTED' && rej.wav === 'C:\\w\\free-3.wav' && rej.confidence === 0.08 &&
        rej.text === '... traction ...');
    const rejBare = parse('REJECTED\tC:\\w\\free-4.wav\t0');
    check('a REJECTED with no text still parses', rejBare.kind === 'REJECTED' && rejBare.text === '');
    check('NONE is NONE', parse('NONE').kind === 'NONE');
    check('an unknown line resolves as NONE, never hangs the press', parse('WHAT\tever').kind === 'NONE');

    const svc = new EngineerService({ dir: os.tmpdir(), loadSettings: () => ({}) });
    svc.pushStatus = () => {};
    svc.onRecognizerLine('READY');
    check('READY marks the microphone ready', svc.recognizerReady === true);
    check('no DICTOK → free-form not live', svc.freeFormLive === false);
    svc.onRecognizerLine('DICTOK');
    check('DICTOK marks dictation live', svc.freeFormLive === true);
  }

  /* ======================================================================== */
  console.log('\n2) The sidecar script emits REJECTED from queued, not handled, events');
  /* ======================================================================== */
  {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'electron', 'sidecars', 'voice-recognizer.ps1'), 'utf8');
    check('subscribes to SpeechRecognitionRejected',
      /Register-ObjectEvent[^\n]*SpeechRecognitionRejected/.test(ps));
    check('…with NO -Action (no script runs on the engine thread)',
      !ps.split(/\r?\n/).some((l) => !/^\s*#/.test(l) && /Register-ObjectEvent.*-Action/.test(l)));
    check('prints a REJECTED line', /"REJECTED`t/.test(ps));
    check('still prints NONE for silence', /'NONE'/.test(ps));
    check('clears queued events before each listen', /Clear-Queued\r?\n\s*\$r = \$rec\.Recognize/.test(ps));
    check('no add_SpeechRecognitionRejected scriptblock handler', !/add_SpeechRecognitionRejected/.test(ps));
    check('end-of-sentence pause raised past the 0.5 s default',
      /EndSilenceTimeoutAmbiguous = \[TimeSpan\]::FromMilliseconds\(750\)/.test(ps));
  }

  /* ======================================================================== */
  console.log('\n3) Every outcome is a registered, well-formed usage slug');
  /* ======================================================================== */
  {
    const slugs = catalog.allSlugs();
    const missing = ENGINEER_OUTCOMES.filter((k) => !slugs.includes(OUTCOME_SLUG_PREFIX + k));
    check('every outcome is in the feature catalog (catalog-first: zeros show)', missing.length === 0,
      missing.join(',') || 'all present');
    const extra = catalog.ACTIONS.filter(
      (a) => a.slug.startsWith(OUTCOME_SLUG_PREFIX) &&
        !ENGINEER_OUTCOMES.includes(a.slug.slice(OUTCOME_SLUG_PREFIX.length)),
    );
    check('and the catalog lists no outcome the engineer never counts', extra.length === 0,
      extra.map((a) => a.slug).join(',') || 'none');
    check('every outcome slug passes the usage slug shape',
      ENGINEER_OUTCOMES.every((k) => /^(tab|action):[a-z0-9.\-]+$/.test(OUTCOME_SLUG_PREFIX + k)));
    check('every outcome slug fits the 64-char column',
      ENGINEER_OUTCOMES.every((k) => (OUTCOME_SLUG_PREFIX + k).length <= 64));
    check('outcome rows are flagged diagnostic for the admin pane',
      catalog.ACTIONS.filter((a) => a.slug.startsWith(OUTCOME_SLUG_PREFIX)).every((a) => a.outcome === true));
  }

  /* ======================================================================== */
  console.log('\n4) Tier 1 and the local branches of ask()');
  /* ======================================================================== */
  {
    let r = rig({ line: 'HEARD\tgapAhead\t0.95\tC:\\w\\a.wav\tgap ahead' });
    let res = await r.svc.ask();
    check('confident grammar → answered locally', r.spoken[0] === 'answer:gapAhead', r.spoken.join('|'));
    check('…counted tier1', res.outcome === 'tier1' && r.outcomes().join() === 'tier1', r.outcomes().join());
    check('…and whisper was never run', r.clips.length === 0);
    check('the listen asked for the window', /^LISTEN \d+\n$/.test(r.listens[0] || ''));

    r = rig({ line: 'HEARD\tgapAhead~w\t0.93\tC:\\w\\a2.wav\twhats the gap', whisper: "what's the gap to P10?" });
    res = await r.svc.ask();
    check('a CONFIDENT wrapped hit still goes through whisper', r.clips.length === 1, String(r.clips.length));
    check('…so "gap to P10" is never answered as the gap ahead', r.spoken[0] !== 'answer:gapAhead', r.spoken.join('|'));

    r = rig({ line: 'HEARD\ttyres\t0.40\tC:\\w\\b.wav\ttemps', whisper: 'what are my tyre temperatures' });
    res = await r.svc.ask();
    check('low-confidence grammar → whisper → phrase list', r.spoken[0] === 'answer:tyres', r.spoken.join('|'));
    check('…counted tier1', r.outcomes().join() === 'tier1', r.outcomes().join());

    r = rig({ line: 'NONE' });
    res = await r.svc.ask();
    check('NONE → "Say again?"', r.spoken.join() === 'Say again?');
    check('…counted none', res.outcome === 'none' && r.outcomes().join() === 'none', r.outcomes().join());

    r = rig({ line: 'FREE\tC:\\w\\c.wav\t0.3\trear tyre', whisper: 'rear tyre rear tyre rear tyre rear tyre box box' });
    res = await r.svc.ask();
    check('a whisper loop → "Say again?", never a tyre readout', r.spoken.join() === 'Say again?', r.spoken.join('|'));
    check('…counted noise', r.outcomes().join() === 'noise', r.outcomes().join());

    r = rig({ line: 'FREE\tC:\\w\\d.wav\t0.3\tum', whisper: 'um', cloud: { ok: true, body: { ok: true, answer: 'x' } } });
    await r.svc.ask();
    check('a stray word never reaches the cloud', r.sent.length === 0);
    check('…counted noise', r.outcomes().join() === 'noise', r.outcomes().join());

    r = rig({ line: 'NONE' });
    r.svc.running = false;
    res = await r.svc.ask();
    check('pressed while the engineer is off → not-ready', res.ok === false && r.outcomes().join() === 'not-ready');
    r = rig({ line: 'NONE' });
    r.svc.recognizerReady = false;
    res = await r.svc.ask();
    check('pressed before the mic is ready → not-ready', res.ok === false && r.outcomes().join() === 'not-ready');
  }

  /* ======================================================================== */
  console.log('\n5) REJECTED: the free-form question that used to die');
  /* ======================================================================== */
  {
    const okReply = { ok: true, status: 200, body: { ok: true, answer: 'Morel is on a one-stop, so stay out.', callId: 'c1', remaining: 10 } };
    let r = rig({
      line: 'REJECTED\tC:\\w\\e.wav\t0.08\t... traction ...',
      whisper: 'should we change strategy now',
      cloud: okReply,
      dictation: false,
    });
    let res = await r.svc.ask();
    check('the rejected clip goes to whisper', r.clips[0] === 'C:\\w\\e.wav');
    check('whisper\'s words reach the cloud', r.sent.length === 1 && r.sent[0].question === 'should we change strategy now',
      r.sent[0] && r.sent[0].question);
    check('the answer is spoken', r.spoken.join() === 'Morel is on a one-stop, so stay out.');
    check('counted no-dictation, rejected, rejected-transcribed, cloud-ok',
      r.outcomes().join() === 'no-dictation,rejected,rejected-transcribed,cloud-ok', r.outcomes().join());
    check('ask() reports the terminal outcome', res.outcome === 'cloud-ok');
    await r.svc.ask();
    check('no-dictation is counted once per session, not per press',
      r.outcomes().filter((o) => o === 'no-dictation').length === 1, r.outcomes().join());

    // The 2026-10-01 field report end to end: no dictation, SAPI rejects
    // "what's my average", whisper hears it, and the phrase list answers it —
    // no cloud, no "Say again?".
    r = rig({ line: 'REJECTED\tC:\\w\\avg.wav\t0.05\t... pace ...', whisper: "What's my average?", cloud: okReply, dictation: false });
    res = await r.svc.ask();
    check('the reported question is answered locally as myAverage', r.spoken.join() === 'answer:myAverage', r.spoken.join('|'));
    check('…without a cloud call', r.sent.length === 0);
    check('…counted tier1', res.outcome === 'tier1', res.outcome);

    r = rig({ line: 'FREE\tC:\\w\\p5.wav\t0.4\tpace', whisper: 'What is the pace of P5?', cloud: okReply });
    res = await r.svc.ask();
    check('"pace of P5" is a positional answer, not a cloud guess', r.spoken.join() === 'position:paceOf:5', r.spoken.join('|'));
    check('…counted position', res.outcome === 'position' && r.sent.length === 0, res.outcome);

    r = rig({ line: 'REJECTED\tC:\\w\\f.wav\t0.01\tthe leader', whisper: '', cloud: okReply });
    res = await r.svc.ask();
    check('whisper heard nothing → "Say again?"', r.spoken.join() === 'Say again?', r.spoken.join('|'));
    check('…SAPI\'s rejected guess is NOT answered from the phrase list', !r.spoken.some((s) => s.startsWith('answer:')));
    check('…nor sent to the cloud', r.sent.length === 0);
    check('…counted rejected then none', r.outcomes().join() === 'rejected,none', r.outcomes().join());

    r = rig({ line: 'REJECTED\tC:\\w\\g.wav\t0.05\tblah', whisper: 'gap to the car ahead', cloud: okReply });
    await r.svc.ask();
    check('a rejected clip whisper reads as a phrase → Tier 1', r.spoken[0] === 'answer:gapAhead', r.spoken.join('|'));
    check('…counted rejected, rejected-transcribed, tier1',
      r.outcomes().join() === 'rejected,rejected-transcribed,tier1', r.outcomes().join());
    check('…and the cloud is never called', r.sent.length === 0);

    r = rig({ line: 'HEARD\tgapAhead\t0.95\tC:\\w\\h.wav\tgap ahead', dictation: true });
    await r.svc.ask();
    check('with dictation live, no-dictation is never counted', !r.outcomes().includes('no-dictation'));
  }

  /* ======================================================================== */
  console.log('\n6) Tier 2: every way the pit wall can answer, or not');
  /* ======================================================================== */
  {
    const q = 'safety car is out and I have half a tank what do we do';
    const press = async (cloud, extra = {}) => {
      const r = rig({ line: `FREE\tC:\\w\\q.wav\t0.5\t${q}`, whisper: q, cloud, ...extra });
      const res = await r.svc.ask();
      return { ...r, res };
    };

    let r = await press({ ok: true, status: 200, body: { ok: true, answer: 'Box now, the stop is cheap.', callId: 'c2' } });
    check('an answer → spoken, cloud-ok', r.spoken.join() === 'Box now, the stop is cheap.' && r.res.outcome === 'cloud-ok',
      r.outcomes().join());
    check('…lastCall kept for the rating buttons', r.svc.lastCall && r.svc.lastCall.id === 'c2');

    r = await press({ ok: true, status: 200, body: { ok: true, answer: 'Say again?', callId: 'c3' } });
    check('the model\'s own "Say again?" → cloud-sayagain', r.res.outcome === 'cloud-sayagain', r.outcomes().join());

    r = await press({ ok: false, status: 403, error: 'Not entitled.' });
    check('HTTP 403 (no subscription) → a line the driver can act on',
      /subscription/i.test(r.spoken.join()) && !/pit wall/i.test(r.spoken.join()), r.spoken.join('|'));
    check('…counted not-entitled', r.res.outcome === 'not-entitled', r.outcomes().join());
    r = await press({ ok: false, status: 403, body: { code: 'entitled' } });
    check('a 403 whose body survived reads the same', r.res.outcome === 'not-entitled');

    r = await press({ ok: false, signedOut: true, error: 'Not signed in.' });
    check('signed out → "Sign in…", counted signed-out',
      /sign in/i.test(r.spoken.join()) && r.res.outcome === 'signed-out', r.outcomes().join());

    r = await press({ ok: true, status: 200, body: { ok: false, code: 'budget', remaining: 0, cap: 300 } });
    check('budget spent → the allotment line, counted budget',
      /allotment/.test(r.spoken.join()) && r.res.outcome === 'budget', r.outcomes().join());

    r = await press({ ok: false, status: 502, error: 'Model unreachable.' });
    check('a 502 → "No answer from the pit wall.", cloud-fail',
      r.spoken.join() === 'No answer from the pit wall.' && r.res.outcome === 'cloud-fail', r.outcomes().join());
    r = await press({ ok: false, status: 0, error: 'offline' });
    check('offline → cloud-fail', r.res.outcome === 'cloud-fail');
    r = await press(new Error('boom'));
    check('a throwing transport → cloud-fail, still spoken',
      r.res.outcome === 'cloud-fail' && r.spoken.join() === 'No answer from the pit wall.');
    r = await press(() => null);
    check('an empty reply → cloud-fail', r.res.outcome === 'cloud-fail');
    r = await press({ ok: true, status: 200, body: { ok: true, answer: '' } });
    check('an empty answer → cloud-fail', r.res.outcome === 'cloud-fail');

    r = await press({ ok: true, body: { ok: true, answer: 'x' } }, { frame: null });
    check('no live frame → "No telemetry.", no-telemetry, no call',
      r.spoken.join() === 'No telemetry.' && r.res.outcome === 'no-telemetry' && r.sent.length === 0, r.outcomes().join());
    r = await press({ ok: true, body: { ok: true, answer: 'x' } }, { connected: false });
    check('a disconnected summary → no-telemetry', r.res.outcome === 'no-telemetry');

    // Exactly one TERMINAL outcome per press, every branch above.
    const markers = new Set(['rejected', 'rejected-transcribed', 'no-dictation']);
    const terminalOnce = [];
    for (const cloud of [
      { ok: true, body: { ok: true, answer: 'fine' } },
      { ok: false, status: 403 },
      { ok: false, signedOut: true },
      { ok: true, body: { ok: false, code: 'budget' } },
      { ok: false, status: 500 },
    ]) {
      const p = await press(cloud);
      terminalOnce.push(p.outcomes().filter((o) => !markers.has(o)).length);
    }
    check('every press ends in exactly one terminal outcome', terminalOnce.every((n) => n === 1), terminalOnce.join(','));
  }

  /* ======================================================================== */
  console.log('\n7) A broken counter never breaks the radio');
  /* ======================================================================== */
  {
    const r = rig({ line: 'HEARD\tgapAhead\t0.95\tC:\\w\\a.wav\tgap ahead' });
    r.svc.noteUsage = () => {
      throw new Error('disk full');
    };
    const res = await r.svc.ask();
    check('the answer is still spoken', r.spoken[0] === 'answer:gapAhead' && res.ok === true);
    const bare = new EngineerService({ dir: os.tmpdir(), loadSettings: () => ({}) });
    check('no injected counter is fine too', bare.noteOutcome('tier1') === 'tier1' && bare.lastOutcome === 'tier1');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
