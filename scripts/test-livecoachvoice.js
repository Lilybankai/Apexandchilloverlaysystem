/**
 * scripts/test-livecoachvoice.js — the live practice coach, spoken
 * (src/telemetry/liveCoachVoice.ts) and its hand-off in electron/engineer.js.
 * -----------------------------------------------------------------------------
 *   1. numbers off the words: "seven", "7", "twelve", "twenty one", "C7";
 *      numbers into words for Piper ("corner twenty one");
 *   2. which words are a coach question — and every phrase in the engineer's
 *      table that is NOT a coach phrase stays out (no steals);
 *   3. each question answered from a synthetic snapshot, signs the right way
 *      round (+ brake shift = brake LATER), tow time never blamed;
 *   4. no snapshot: the plain line, and "how was that lap" left to lastLap;
 *   5. the summary request against the REAL validator (validate.ts,
 *      transpiled as test-coachvalidate.js does) and coach-ipc's cleaner;
 *   6. speakableSummary from a canned valid reply and from junk;
 *   7. engineer.js ask(): coach first for coach words, the fallback, the
 *      SAPI fast path, the precedence against "last lap".
 *   9. v2: the work-list answers, the run debrief asked for, the corner
 *      detail with cue2 — with a work list, without one (v1), off a coached
 *      session (null → the engineer as before), and through ask();
 *  10. v2: the run debrief's AI request against the deployed function's
 *      schema and REAL validator, speakableDebrief, and debriefGuard's
 *      accept/reject cases (invented corner, wrong number, four sentences,
 *      "C5" in the text).
 *
 * No network: the cloud, whisper and the recognizer are stubbed.
 * Run: npm run build && node scripts/test-livecoachvoice.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const V = require('../dist/telemetry/liveCoachVoice');
const { EngineerCommands } = require('../dist/telemetry/engineerCommands');
const { GRAMMAR, COACH_INTENTS, COACH_FALLBACK, EngineerService, matchGrammarText, matchPositionQuery } = require('../electron/engineer');
const IPC = require('../electron/coach-ipc');
const { COACH_REPORT_VERSION } = require('../dist/telemetry/coachReport');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

function loadValidate() {
  const file = path.join(__dirname, '..', 'supabase', 'functions', 'coach', 'validate.ts');
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    fileName: file,
  });
  const m = new Module(file);
  m._compile(out.outputText, file);
  return m.exports;
}
const VAL = loadValidate();

/* -------------------------------------------------------------------------- */
/*  A synthetic session: 4 km lap, C4 the focus (braking 10 m early)          */
/* -------------------------------------------------------------------------- */

const L = 4000;
const pts = (o) => ({
  brakeOnD: null, brakeOffD: null, turnInD: null, apexD: null, pickupD: null, fullThrottleD: null,
  entryKph: null, minKph: null, exitKph: null, topKph: null, ...o,
});
const phases = (o) => ({ braking: 0, turnIn: 0, midCorner: 0, exit: 0, exitRun: 0, ...o });
const corner = (id, index, lossSec, ph, mine, ref, extra = {}) => ({
  id, index, entryD: index / 20, apexD: index / 20 + 0.01, exitD: index / 20 + 0.02, runEndD: index / 20 + 0.04,
  lossSec, phases: phases(ph), mine: pts(mine), ref: pts(ref), straightFlag: null, straightSec: 0, ...extra,
});

function breakdown() {
  return {
    lapId: 'lap-6',
    refLapId: 'lap-3',
    corners: [
      corner('C2', 1, -0.03, { midCorner: -0.03 }, { minKph: 120 }, { minKph: 119 }),
      // Braking 10 m early: mine.brakeOnD 0.2000 vs ref 0.2025 on a 4 km lap.
      corner('C4', 3, 0.25, { braking: 0.18, turnIn: 0.02, midCorner: 0.03, exit: 0.01, exitRun: 0.01 },
        { brakeOnD: 0.2, minKph: 90 }, { brakeOnD: 0.2025, minKph: 90 }),
      // Brakes 6 m early AND 4 km/h slower at the apex.
      corner('C9', 8, 0.14, { braking: 0.03, midCorner: 0.09, exit: 0.02 },
        { brakeOnD: 0.5985, minKph: 98 }, { brakeOnD: 0.6, minKph: 102 }),
      // 0.30 s, but 0.25 of it a tow on the straight: the driver's part is 0.05.
      corner('C11', 10, 0.3, { exitRun: 0.27, exit: 0.03 }, {}, {}, { straightFlag: 'tow', straightSec: 0.25 }),
    ],
    sequences: [],
    leadInSec: 0,
    totalSec: 0.66,
    residualSec: -0.02,
  };
}

function lap(o = {}) {
  return {
    lapId: 'lap-6', lapNo: 6, lapSec: 103.66, valid: true, breakdown: breakdown(), trackLengthM: L,
    refKind: 'sessionBest', refLapId: 'lap-3', at: '2026-11-03T10:00:00Z', ...o,
  };
}

function snapshot(o = {}) {
  const state = {
    sessionKey: 'practice-1',
    validLaps: 5,
    recent: [
      { lapNo: 4, lapSec: 103.8, byCorner: { C2: -0.03, C4: 0.22, C9: 0.1, C11: 0.05 } },
      { lapNo: 5, lapSec: 103.55, byCorner: { C2: -0.02, C4: 0.18, C9: 0.12, C11: 0.04 } },
      { lapNo: 6, lapSec: 103.66, byCorner: { C2: -0.04, C4: 0.25, C9: 0.14, C11: 0.05 } },
    ],
    focus: {
      cornerId: 'C4', cornerNo: 4, entryD: 0.15, apexD: 0.16, exitD: 0.17, lossSec: 0.22,
      cue: { phase: 'braking', brakeShiftM: 10 },
      short: 'Brake 10 m later', spoken: "Corner four, you're braking about ten metres early.",
      status: 'holding', sinceLapNo: 4,
    },
    fixed: [],
    lastConsistencyAt: 0,
    lastSummaryAt: 0,
    refLapId: 'lap-3',
    ...(o.state || {}),
  };
  const last = o.last !== undefined ? o.last : lap();
  return { state, lastValid: o.lastValid !== undefined ? o.lastValid : last, last, trackLengthM: L };
}

const noDigitsBut = (s, allowed) => !/\d/.test(s.replace(allowed || /$^/, ''));

/*
 * Coach v2 (2026-11-04): a work list of two corners and three put right this
 * run. C5: braking 10 m early (cue) and 4 km/h slow at the apex (cue2), 0.21 s
 * a lap; C11: 3 km/h down on the exit, 0.14 s, fine on the last lap. C3, C7,
 * C9 improved by 0.20 + 0.12 + 0.10 = 0.42 s.
 */
const workFocus = (id, no, loss, cue, o = {}) => ({
  cornerId: id, cornerNo: no, entryD: no / 20, apexD: no / 20 + 0.01, exitD: no / 20 + 0.02, lossSec: loss, cue,
  short: 'x', spoken: `Corner ${no}.`, status: 'holding', sinceLapNo: 3, ...o,
});
function workSnapshot(o = {}) {
  const work = [
    workFocus('C5', 5, 0.21, { phase: 'braking', brakeShiftM: 10 }, {
      rank: 1, cue2: { phase: 'midCorner', minKphGain: 4 }, lastLossSec: 0.25, baselineSec: 0.22, gainSec: 0.01,
    }),
    workFocus('C11', 11, 0.14, { phase: 'exit', exitKphGain: 3 }, { rank: 2, lastLossSec: 0.01, baselineSec: 0.15, gainSec: 0.01 }),
  ];
  const s = snapshot({ state: {
    recent: [
      { lapNo: 5, lapSec: 103.5, byCorner: { C3: 0.02, C5: 0.2, C7: 0.0, C9: 0.01, C11: 0.15 } },
      { lapNo: 6, lapSec: 103.6, byCorner: { C3: 0.01, C5: 0.22, C7: 0.01, C9: 0.0, C11: 0.13 } },
    ],
    focus: work[0],
    work,
    runImproved: [{ cornerId: 'C3', gainSec: 0.2 }, { cornerId: 'C7', gainSec: 0.12 }, { cornerId: 'C9', gainSec: 0.1 }],
    runStartLap: 0,
    validLaps: 6,
    ...(o.state || {}),
  } });
  if ('debrief' in o) s.debrief = o.debrief;
  return s;
}
const DEBRIEF = {
  improved: [{ cornerId: 'C3', gainSec: 0.2 }, { cornerId: 'C7', gainSec: 0.12 }, { cornerId: 'C9', gainSec: 0.1 }],
  still: [
    { cornerId: 'C5', lossSec: 0.21, what: 'braking ten metres too early' },
    { cornerId: 'C11', lossSec: 0.14, what: 'exit speed, three k down' },
  ],
  text: "You've improved corners three, seven and nine, about four tenths in all. Still to work on: five, braking ten metres too early, and eleven, exit speed, three k down.",
  laps: 6,
};

async function main() {
  /* ======================================================================== */
  console.log('\n1) Numbers off the words, numbers into words');
  /* ======================================================================== */
  {
    const n = (t) => V.cornerNumberIn(t);
    check('"corner seven" → 7', n('what about corner seven') === 7);
    check('"corner 7" → 7', n('What about corner 7?') === 7);
    check('"corner twelve" → 12', n("how's corner twelve") === 12);
    check('"corner twenty one" → 21', n('corner twenty one') === 21);
    check('"corner twenty-one" (hyphen) → 21', n('Corner twenty-one?') === 21);
    check('"corner 21." → 21', n('Corner 21.') === 21);
    check('"corner twenty" → 20', n('corner twenty please') === 20);
    check('"corner number 12" → 12', n('corner number 12') === 12);
    check('"C7" → 7', n('how about C7') === 7);
    check('"corner for" as the last word → 4 (whisper sound-alike)', n('what about corner for') === 4);
    check('"corner for me" is no number', n('do the corner for me') === null);
    check('no corner word → null', n('seven') === null);
    check('numberWords 21 → "twenty one"', V.numberWords(21) === 'twenty one');
    check('numberWords 10 → "ten"', V.numberWords(10) === 'ten');
    check('spokenCorner C4 → "corner four"', V.spokenCorner('C4') === 'corner four');
    check('spokenCorner 13 → "corner thirteen"', V.spokenCorner(13) === 'corner thirteen');
  }

  /* ======================================================================== */
  console.log('\n2) Which words are a coach question');
  /* ======================================================================== */
  {
    const intent = (t) => (V.coachQuestionOf(t) || {}).intent || null;
    const want = {
      coachLap: ['how was that lap', 'How was my last lap?', "how's that lap", 'How did that lap go?', 'how was the lap', 'how did I do'],
      coachLoss: ['where am I losing time', "Where's the time?", 'where do I lose time', "what's costing me time",
        'where am I losing the most', 'where can I find time', 'where am I slowest'],
      coachWorkOn: ['what should I work on', "what's the focus", 'what should I focus on', "what's my focus",
        'what do I need to work on', 'what should I improve'],
      coachCorner: ['what about corner seven', "how's corner 12", 'corner twenty one', 'how am I doing in corner 3'],
      coachSpread: ['am I consistent', 'how consistent am I', 'consistency', "how's my consistency"],
    };
    for (const [k, qs] of Object.entries(want)) {
      const bad = qs.filter((q) => intent(q) !== k);
      check(`${k}: ${qs.length} wordings`, bad.length === 0, bad.map((q) => `${q}=${intent(q)}`).join(' | ') || 'all');
    }
    const q = V.coachQuestionOf('what about corner seven');
    check('the corner question carries its number', q && q.cornerNo === 7);

    // Every coach phrase in the engineer's table parses as its own intent.
    const coachRows = GRAMMAR.filter((g) => COACH_INTENTS.has(g.intent));
    const off = coachRows.flatMap((g) => g.phrases.filter((p) => intent(p) !== g.intent).map((p) => `${p}=${intent(p)}`));
    check('every coach phrase in GRAMMAR parses as its intent', coachRows.length === COACH_INTENTS.size && off.length === 0,
      off.join(' | ') || `${coachRows.length} rows`);
    check('the coach phrases sit in one "Practice coach" group',
      coachRows.every((g) => g.group === 'Practice coach'));
    // …and the phrase list itself routes them to the coach.
    const routed = coachRows.flatMap((g) => g.phrases.filter((p) => matchGrammarText(p) !== g.intent).map((p) => `${p}=${matchGrammarText(p)}`));
    check('matchGrammarText routes every coach phrase to its intent', routed.length === 0, routed.join(' | ') || 'all');

    // No steals: every other phrase in the table, and the field transcripts.
    const others = GRAMMAR.filter((g) => !COACH_INTENTS.has(g.intent)).flatMap((g) => g.phrases);
    const stolen = others.filter((p) => V.coachQuestionOf(p));
    check(`none of the ${others.length} other GRAMMAR phrases is a coach question`, stolen.length === 0, stolen.join(' | ') || 'none');
    const field = [
      'last lap', 'lap time', 'last lap time', 'what was my last lap', 'what is the pace of P5?', 'gap to P10.',
      "what's my sector one?", 'where am i', 'where do i come out', 'where is the yellow', 'what gear for turn five',
      'what gear for corner five', 'is there a yellow at corner seven', "how's my pace", 'how much time is left',
      "where's the time left", 'is the car ahead consistent', 'is he consistent', 'where am i losing fuel',
      'what should i change on the setup', 'give me one second', 'how was the stop', 'how long is the stop',
      'turn seven', 'how is turn seven',
    ];
    const fstolen = field.filter((p) => V.coachQuestionOf(p));
    check('field questions for other answers are not coach questions', fstolen.length === 0, fstolen.join(' | ') || 'none');
  }

  /* ======================================================================== */
  console.log('\n3) Each question, from a synthetic snapshot');
  /* ======================================================================== */
  {
    const snap = snapshot();
    const a = (t, s = snap) => V.answerCoachQuestion(t, s);

    let s = a('how was that lap');
    check('lap: time, gap to your best, the corner that cost most',
      s === '1 43.7, six tenths off your best. Biggest loss: corner four, three tenths under braking.', s);
    check('…a tow is never the biggest loss (C11 lost 0.30 s, 0.25 of it a tow)', !/eleven/.test(s));
    s = a('how was that lap', snapshot({ last: lap({ valid: false, lapSec: 110.2, breakdown: null }) }));
    check('lap: an invalid lap is not coached', /doesn't count/.test(s) && /^1 50\.2/.test(s), s);
    s = a('how was that lap', snapshot({ last: lap({ lapId: 'lap-3' }) }));
    check('lap: the reference lap itself is the new best', /new reference/.test(s), s);
    s = a('how was that lap', snapshot({ last: lap({ refKind: 'board' }) }));
    check('lap: a board reference is named', /off the leaderboard lap/.test(s), s);
    s = a('how was that lap', snapshot({ last: lap({ breakdown: { ...breakdown(), totalSec: -0.3, residualSec: 0 } }) }));
    check('lap: quicker than the reference reads quicker', /three tenths quicker than your best/.test(s), s);

    s = a('where am I losing time');
    check('loss: the focus, then the next biggest',
      s === 'Corner four, about two tenths a lap, mostly under braking. Then corner nine, a tenth.', s);
    s = a('where am I losing time', snapshot({ state: { focus: null } }));
    check('loss: no focus yet → the window\'s worst, with its phase', /^Corner four, about two tenths a lap, mostly under braking/.test(s), s);
    s = a('where am I losing time', snapshot({ state: { focus: null, recent: [] }, last: null, lastValid: null }));
    check('loss: nothing yet → still learning', /Still learning your laps/.test(s), s);

    s = a('what should I work on');
    check('work on: focus + cue, + brake shift said as LATER',
      s === 'Corner four: brake ten metres later. Worth about two tenths a lap.', s);
    const early = snapshot();
    early.state.focus = { ...early.state.focus, cue: { phase: 'braking', brakeShiftM: -8, minKphGain: 3 } };
    s = a('what should I work on', early);
    check('work on: − brake shift said as EARLIER, apex gain as more speed',
      /brake eight metres earlier and carry three kilometres an hour more to the apex/.test(s), s);
    const thr = snapshot();
    thr.state.focus = { ...thr.state.focus, cue: { phase: 'exit', throttleShiftM: -12 } };
    s = a("what's the focus", thr);
    check('work on: − throttle shift = back on the throttle sooner', /back on the throttle twelve metres sooner/.test(s), s);
    const better = snapshot();
    better.state.focus = { ...better.state.focus, status: 'improving' };
    check('work on: improving says so', /It's coming/.test(a('what should I work on', better)));
    const fixed = snapshot();
    fixed.state.focus = { ...fixed.state.focus, status: 'fixed' };
    check('work on: fixed says sorted', /^Corner four's sorted/.test(a('what should I work on', fixed)));
    s = a('what should I work on', snapshot({ state: { focus: null } }));
    check('work on: no focus over a window → nothing stands out', /Nothing stands out/.test(s), s);

    s = a('what about corner nine');
    check('corner: window loss, phase off the last lap, the cue from its deltas',
      s === 'Corner nine: a tenth a lap over your last three laps, mostly in the middle of the corner. ' +
        'Brake six metres later and carry four kilometres an hour more to the apex.', s);
    s = a("how's corner 4");
    check('corner: the focus corner uses the focus cue', /^Corner four: two tenths a lap .*Brake ten metres later\.$/.test(s), s);
    s = a('corner two');
    check('corner: a corner that gains says so', /^Corner two's good, less than a tenth quicker than your best/.test(s), s);
    s = a('corner thirty');
    check('corner: past the last corner', s === "There's no corner thirty. The last one's corner eleven.", s);
    s = a('corner five');
    check('corner: one with no data', s === 'Nothing on corner five yet.', s);

    s = a('am I consistent');
    check('spread: the window\'s lap-time spread', s === 'Your last three clean laps are within three tenths. Nicely consistent.', s);
    const wild = snapshot();
    wild.state.recent = [
      { lapNo: 4, lapSec: 103.8, byCorner: { C4: 0.2, C9: 0.1 } },
      { lapNo: 5, lapSec: 104.9, byCorner: { C4: 0.9, C9: 0.1 } },
    ];
    s = a('how consistent am I', wild);
    check('spread: a wide spread, and the corner that swings', /^1\.1 seconds between your best and worst of the last two\. .*Most of the difference is in corner four\.$/.test(s), s);
    wild.state.recent = wild.state.recent.slice(0, 1);
    check('spread: one lap is not enough', /couple more clean laps/.test(a('am I consistent', wild)));

    // Speakable: no "C4", no symbols, British.
    const all = ['how was that lap', 'where am I losing time', 'what should I work on', 'what about corner nine', 'am I consistent']
      .map((q) => a(q));
    check('no answer says a raw corner id', all.every((x) => !/\bC\d/.test(x)), all.join(' | '));
    check('no answer carries km/h, Δ or a unit symbol', all.every((x) => !/km\/h|Δ| m\b| s\b/.test(x)));
    check('only lap times are digits', all.every((x) => noDigitsBut(x, /\d \d\d\.\d/g)), all.join(' | '));
  }

  /* ======================================================================== */
  console.log('\n4) No snapshot, and words that are not coach questions');
  /* ======================================================================== */
  {
    for (const q of ['where am I losing time', 'what should I work on', 'what about corner seven', 'am I consistent']) {
      check(`null snapshot: "${q}" → null (the engineer takes it as before)`, V.answerCoachQuestion(q, null) === null);
    }
    check('no "only in practice" line is exported any more', V.NOT_LIVE_LINE === undefined);
    check('null snapshot: "how was that lap" → null (lastLap answers it)', V.answerCoachQuestion('how was that lap', null) === null);
    for (const q of ['gap ahead', 'fuel', 'last lap', 'lap time', 'box this lap', '', '   ']) {
      check(`"${q}" → null with a snapshot`, V.answerCoachQuestion(q, snapshot()) === null);
      check(`"${q}" → null without`, V.answerCoachQuestion(q, null) === null);
    }
  }

  /* ======================================================================== */
  console.log('\n5) Precedence against engineerCommands\' "last lap"');
  /* ======================================================================== */
  {
    const cmds = new EngineerCommands();
    const before = cmds.answer('lastLap');
    check('engineerCommands still owns lastLap', before.intent === 'lastLap');
    check('"last lap" / "lap time" / "last lap time" route to lastLap',
      ['last lap', 'lap time', 'last lap time', 'what was my last lap'].every((q) => matchGrammarText(q) === 'lastLap' && !V.coachQuestionOf(q)));
    check('"how was my last lap" routes to coachLap (longest phrase wins)', matchGrammarText('how was my last lap') === 'coachLap');
    check('…whose fallback is lastLap', COACH_FALLBACK.coachLap === 'lastLap');
    check('"where am I losing time" is not the position read', matchGrammarText('where am I losing time') === 'coachLoss' && !matchPositionQuery('where am I losing time'));
  }

  /* ======================================================================== */
  console.log('\n6) The summary request, against the deployed function\'s checks');
  /* ======================================================================== */
  let req;
  {
    const snap = snapshot();
    snap.state.fixed = ['C2'];
    req = V.summaryRequest(snap, { track: 'Road Atlanta', car: 'Porsche 911 GT3 R', carClass: 'GT3', targetLabel: 'Session best · 1:43.020' });
    check('a request', !!req && req.kind === 'session', req && req.kind);
    check('kind is one the function knows', ['session', 'lap', 'habits'].includes(req.kind));
    check('inputHash passes the function\'s shape', /^[0-9a-f]{16,128}$/i.test(req.inputHash), req.inputHash);
    check('the same snapshot hashes the same', V.summaryRequest(snapshot(), {}).inputHash === V.summaryRequest(snapshot(), {}).inputHash);
    const ids = req.facts.map((f) => f.id);
    check('fact ids unique', new Set(ids).size === ids.length, ids.join(','));
    // cleanFacts (index.ts): id ≤ 64, text ≤ 240, finite value, ≤ 60 facts.
    check('every fact survives cleanFacts',
      req.facts.length <= 60 && req.facts.every((f) => f.id && f.id.length <= 64 && f.text && f.text.length <= 240 && Number.isFinite(f.value)));
    check('body well under the 24000-char cap', JSON.stringify(req).length < 24000, String(JSON.stringify(req).length));
    for (const id of ['C4.loss', 'C4.brakeDeltaM', 'C4.braking.loss', 'C4.consistency', 'C4.trend', 'C9.loss', 'C9.minKphDelta',
      'C9.brakeDeltaM', 'C11.straight', 'C2.fixed', 'session.laps', 'lap.time', 'lap.gap', 'session.consistency']) {
      check(`holds ${id}`, ids.includes(id));
    }
    const f = (id) => req.facts.find((x) => x.id === id);
    check('cue brake +10 m (later) → brakeDeltaM −10 (the driver brakes earlier)',
      f('C4.brakeDeltaM').value === -10 && /brake 10 m earlier/.test(f('C4.brakeDeltaM').text), f('C4.brakeDeltaM').text);
    check('C9 apex −4 km/h off the last lap', f('C9.minKphDelta').value === -4 && /4 km\/h slower/.test(f('C9.minKphDelta').text));
    check('tow time named as not the driver\'s', /tow, not your driving/.test(f('C11.straight').text));
    check('the tow corner is not ranked (driver part 0.05 s is under C9)', !ids.includes('C11.loss') || f('C11.loss').value < f('C9.loss').value);
    check('context carries the lap and the reference', req.context.lapSec === 103.66 && req.context.refSec === 103.02, JSON.stringify(req.context));
    check('the user turn holds every fact', req.facts.every((x) => VAL.userContent(req).includes(`${x.id} | ${x.text}`)));

    const wired = IPC._test.requestFromRaw(req, COACH_REPORT_VERSION);
    check('coach-ipc requestFromRaw keeps every fact', wired && wired.facts.length === req.facts.length && wired.kind === 'session');

    const good = {
      headline: 'Braking is the key to C4.',
      takeaways: [
        { title: 'Brake later into C4', body: 'You brake earlier than the target into C4, so brake later and carry the speed in. Keep it tidy and the rest follows.', factIds: ['C4.loss', 'C4.brakeDeltaM'], cornerIds: ['C4'] },
        { title: 'More apex speed in C9', body: 'Carry more speed to the apex of C9.', factIds: ['C9.loss', 'C9.minKphDelta'], cornerIds: ['C9'] },
      ],
      sequences: [],
    };
    const v = VAL.validateCoachReply(good, req.facts);
    check('a reply citing the facts passes the real validator', v.ok, v.ok ? '' : v.reasons.join(' | '));
    const wrong = VAL.validateCoachReply({ ...good, takeaways: [{ title: 'Brake earlier into C4', body: 'Brake earlier into C4.', factIds: ['C4.brakeDeltaM'], cornerIds: ['C4'] }] }, req.facts);
    check('…and "brake earlier into C4" is rejected (the sign reached the validator right)', !wrong.ok);
    const num = VAL.validateCoachReply({ ...good, takeaways: [{ title: 'C4', body: 'Brake later into C4, worth 0.3 s.', factIds: ['C4.loss'], cornerIds: ['C4'] }] }, req.facts);
    check('…and a typed number is rejected', !num.ok);

    /* ======================================================================== */
    console.log('\n7) speakableSummary');
    /* ======================================================================== */
    let s = V.speakableSummary(v.result, snap, req);
    check('two sentences from the AI\'s words, numbers from the facts',
      s === 'Brake later into corner four, worth about two tenths a lap. Carry more speed to the apex of corner nine, worth about a tenth a lap.', s);
    check('the { ok, ai } answer works too', V.speakableSummary({ ok: true, ai: v.result }, snap, req) === s);
    check('without the request, rebuilt from the snapshot', V.speakableSummary(v.result, snap) === s);
    check('no raw corner id and no digits', !/\bC\d/.test(s) && !/\d/.test(s));
    const sentences = s.split(/(?<=\.)\s+/);
    check('at most two sentences', sentences.length <= 2, String(sentences.length));

    check('null → null', V.speakableSummary(null, snap, req) === null);
    check('a string → null', V.speakableSummary('Brake later', snap, req) === null);
    check('{} → null', V.speakableSummary({}, snap, req) === null);
    check('{ ok:false } → null', V.speakableSummary({ ok: false, ai: null, code: 'rejected' }, snap, req) === null);
    check('no snapshot and no request → null', V.speakableSummary(v.result, null) === null);
    const unknown = { headline: 'x', takeaways: [{ title: 'Go faster', body: 'Go faster in C4.', factIds: ['C99.loss'], cornerIds: ['C4'] }], sequences: [] };
    check('citing an unknown fact → dropped, headline too short to stand → null-or-headline', V.speakableSummary(unknown, snap, req) === 'X.');
    const typed = { headline: 'Brake 12 m later', takeaways: [{ title: 'Brake later', body: 'Brake 12 m later into C4.', factIds: ['C4.loss'], cornerIds: ['C4'] }], sequences: [] };
    check('the AI\'s own number is never spoken', V.speakableSummary(typed, snap, req) === null);
    const badCorner = { headline: 'Fine', takeaways: [{ title: 'C17', body: 'Look at C17.', factIds: ['C4.loss'], cornerIds: [] }], sequences: [] };
    check('a corner no fact is about → dropped', V.speakableSummary(badCorner, snap, req) === 'Fine.');

    const thin = V.summaryFacts(snap);
    check('summaryFacts: the same facts, and the fact block', thin.facts.length === req.facts.length && thin.prompt.includes('C4.loss | '));
    check('summaryFacts of an empty session → no facts', V.summaryFacts(snapshot({ state: { focus: null, recent: [] }, last: null, lastValid: null })).facts.length === 0);
    check('summaryRequest(null) → null', V.summaryRequest(null) === null);
    check('the contract object', typeof V.liveCoachVoice.answerCoachQuestion === 'function' &&
      V.liveCoachVoice.speakableSummary(v.result, snap) === s);
  }

  /* ======================================================================== */
  console.log('\n8) engineer.js: the hand-off in ask()');
  /* ======================================================================== */
  {
    function rig({ line, whisper = '', snap, cloud } = {}) {
      const counted = [];
      const sent = [];
      const svc = new EngineerService({
        dir: path.join(os.tmpdir(), 'apex-livecoach-test'),
        loadSettings: () => ({ engineerEnabled: true, engineer: { readouts: 'standard' } }),
        onStatus: () => {},
        noteUsage: (slug) => counted.push(slug),
        cloudAsk: async (body) => {
          sent.push(body);
          return cloud || { ok: true, body: { ok: true, answer: 'cloud says' } };
        },
      });
      const spoken = [];
      svc.running = true;
      svc.recognizerReady = true;
      svc.freeFormLive = true;
      svc.speak = (text) => spoken.push(text);
      svc.pushStatus = () => {};
      svc.playChirp = () => {};
      svc.recognizer = { stdin: { write: () => setImmediate(() => svc.onRecognizerLine(line)) } };
      const clips = [];
      svc.transcribeClip = async (wav) => {
        clips.push(wav);
        return { question: whisper, sttMs: whisper ? 900 : null };
      };
      svc.commands = {
        answer: (intent) => ({ text: `answer:${intent}` }),
        answerPosition: (q) => ({ text: `position:${q.intent}` }),
        averageOf: () => null,
        summaryExtras: () => undefined,
      };
      svc.summaryMod = { engineerSummary: () => ({ connected: true }) };
      svc.lastFrame = {};
      if (snap !== undefined) svc.setLiveCoachSnapshot(typeof snap === 'function' ? snap : () => snap);
      return { svc, spoken, sent, counted, clips };
    }
    const FREE = 'FREE\tC:\\w\\free.wav\t0.4\twhatever';

    check('the coach module is loaded from dist', !!new EngineerService({ dir: os.tmpdir(), loadSettings: () => ({}) }).coachVoiceMod);

    let r = rig({ line: FREE, whisper: 'What about corner nine?', snap: snapshot() });
    let res = await r.svc.ask();
    check('whisper "corner nine" → the coach answers, locally', /^Corner nine: a tenth a lap/.test(r.spoken[0] || ''), r.spoken.join('|'));
    check('…counted tier1, no cloud call', res.outcome === 'tier1' && r.sent.length === 0);
    check('…and remembered for a follow-up', r.svc.lastExchange && /Corner nine/.test(r.svc.lastExchange.answer));

    r = rig({ line: FREE, whisper: 'how was my last lap', snap: snapshot() });
    await r.svc.ask();
    check('practice: "how was my last lap" → the coach', /six tenths off your best/.test(r.spoken[0] || ''), r.spoken.join('|'));

    r = rig({ line: FREE, whisper: 'how was my last lap', snap: null });
    await r.svc.ask();
    check('not live: "how was my last lap" → engineerCommands lastLap', r.spoken[0] === 'answer:lastLap', r.spoken.join('|'));

    r = rig({ line: FREE, whisper: 'how was my last lap' }); // no hook at all
    await r.svc.ask();
    check('no snapshot hook: the same lastLap answer', r.spoken[0] === 'answer:lastLap', r.spoken.join('|'));

    r = rig({ line: FREE, whisper: 'last lap', snap: snapshot() });
    await r.svc.ask();
    check('practice: "last lap" stays engineerCommands\'', r.spoken[0] === 'answer:lastLap', r.spoken.join('|'));

    r = rig({ line: FREE, whisper: 'where am I losing time?', snap: null });
    res = await r.svc.ask();
    check('not live: a coach-only question goes on to the cloud, as before the coach', r.sent.length === 1 && r.spoken[0] === 'cloud says', r.spoken.join('|'));

    r = rig({ line: FREE, whisper: 'where am I losing time?', snap: () => { throw new Error('boom'); } });
    await r.svc.ask();
    check('a snapshot source that throws is "not live", not a dead press', r.sent.length === 1, r.spoken.join('|'));

    r = rig({ line: FREE, whisper: "what's the gap ahead", snap: snapshot() });
    await r.svc.ask();
    check('practice: a non-coach question goes on as before', r.spoken[0] === 'answer:gapAhead', r.spoken.join('|'));

    r = rig({ line: FREE, whisper: 'what is the pace of P5?', snap: snapshot() });
    await r.svc.ask();
    check('practice: a position query goes on as before', r.spoken[0] === 'position:paceOf', r.spoken.join('|'));

    r = rig({ line: 'HEARD\tcoachLoss\t0.95\tC:\\w\\h.wav\twhere am i losing time', snap: snapshot() });
    res = await r.svc.ask();
    check('SAPI exact "where am i losing time" → the coach, no whisper',
      /^Corner four, about two tenths/.test(r.spoken[0] || '') && res.outcome === 'tier1' && r.clips.length === 0, r.spoken.join('|'));

    // SAPI's grammar holds one example number: its "corner seven" may be the
    // driver's "corner eight". The number is whisper's to read.
    r = rig({ line: 'HEARD\tcoachCorner\t0.95\tC:\\w\\h.wav\tcorner seven', whisper: 'corner nine', snap: snapshot() });
    res = await r.svc.ask();
    check('SAPI "corner seven" → whisper reads the number ("corner nine")',
      /^Corner nine/.test(r.spoken[0] || '') && r.clips.length === 1 && res.outcome === 'tier1', r.spoken.join('|'));
    r = rig({ line: 'HEARD\tcoachCorner\t0.95\tC:\\w\\h.wav\tcorner nine', whisper: '', snap: snapshot() });
    await r.svc.ask();
    check('…and with no whisper, SAPI\'s words still get the coach', /^Corner nine/.test(r.spoken[0] || ''), r.spoken.join('|'));

    r = rig({ line: 'HEARD\tcoachLap\t0.95\tC:\\w\\h.wav\thow was my last lap', snap: null });
    await r.svc.ask();
    check('SAPI exact coachLap, not live → the lastLap fallback', r.spoken[0] === 'answer:lastLap', r.spoken.join('|'));

    r = rig({ line: 'HEARD\tcoachSpread\t0.95\tC:\\w\\h.wav\tam i consistent', snap: null });
    await r.svc.ask();
    check('SAPI exact coachSpread, not live → on to whisper/the cloud, never commands.answer(coachSpread)',
      !r.spoken.some((s) => /^answer:coachSpread/.test(s)), r.spoken.join('|'));

    r = rig({ line: FREE, whisper: 'what gear for turn five', snap: snapshot() });
    await r.svc.ask();
    check('"what gear for turn five" still reaches the cloud', r.sent.length === 1, r.spoken.join('|'));

    const svc = new EngineerService({ dir: os.tmpdir(), loadSettings: () => ({}) });
    svc.setLiveCoachSnapshot(() => snapshot());
    check('setLiveCoachSnapshot keeps a function', typeof svc.liveCoachSnapshot === 'function');
    svc.setLiveCoachSnapshot('nope');
    check('…and clears on anything else', svc.liveCoachSnapshot === null);
  }

  /* ======================================================================== */
  console.log('\n9) v2: the work list, the run debrief and the corner detail, asked for');
  /* ======================================================================== */
  {
    const intent = (t) => (V.coachQuestionOf(t) || {}).intent || null;
    const debriefQs = ['how am I doing', 'How are we doing?', 'debrief me', 'give me a debrief', "how's my run", 'how is the run going',
      "how's this stint", 'how am I getting on', 'run debrief please'];
    const badD = debriefQs.filter((q) => intent(q) !== 'coachDebrief');
    check(`coachDebrief: ${debriefQs.length} wordings`, badD.length === 0, badD.map((q) => `${q}=${intent(q)}`).join(' | ') || 'all');
    const listQs = ['what are my corners', 'which corners', 'what corners should I work on', "what's on my list", 'read me the work list'];
    const badL = listQs.filter((q) => intent(q) !== 'coachWorkOn');
    check(`coachWorkOn (the list): ${listQs.length} wordings`, badL.length === 0, badL.map((q) => `${q}=${intent(q)}`).join(' | ') || 'all');
    const notD = ['how am I doing on fuel', 'how are we doing for time', 'how am I doing against P5', 'how are we doing on tyres',
      "how's the car ahead doing", 'how am I doing in the race', 'which corners have yellows', 'which corners should I change the setup for'];
    const stolenD = notD.filter((q) => V.coachQuestionOf(q));
    check('race-engineer questions near the new wordings stay out', stolenD.length === 0, stolenD.map((q) => `${q}=${intent(q)}`).join(' | ') || 'none');
    check('"how am I doing in corner three" is still the corner', intent('how am I doing in corner three') === 'coachCorner');

    // -- answers WITH a work list -------------------------------------------------
    const ws = workSnapshot();
    const a = (t, s = ws) => V.answerCoachQuestion(t, s);
    let s = a('what should I work on');
    check('work list: every corner, what to change and its worth',
      s === 'Two to work on. Corner five: brake ten metres later, worth two tenths. ' +
        'Corner eleven: three kilometres an hour more out of the exit, worth a tenth.', s);
    check('…"what are my corners" / "which corners" say the same', a('what are my corners') === s && a('which corners') === s);
    const imp = workSnapshot();
    imp.state.work = imp.state.work.map((f, i) => (i === 1 ? { ...f, status: 'improving' } : f));
    check('work list: an improving corner says it is coming', /worth a tenth, and it's coming\.$/.test(a('what should I work on', imp)), a('what should I work on', imp));
    const fixedOne = workSnapshot();
    fixedOne.state.work = fixedOne.state.work.map((f, i) => (i === 1 ? { ...f, status: 'fixed' } : f));
    s = a('what should I work on', fixedOne);
    check('work list: a fixed corner is not on it (one left → the v1 answer)',
      s === 'Corner five: brake ten metres later. Worth about two tenths a lap.', s);

    s = a('what about corner five');
    check('corner on the list: loss, phase, cue AND cue2, rank, last lap',
      s === 'Corner five: two tenths a lap over your last two laps, mostly under braking. ' +
        'Brake ten metres later and carry four kilometres an hour more to the apex. Top of the list; last lap it cost three tenths.', s);
    s = a('what about corner eleven');
    check('corner on the list, fine last lap: says so',
      s === 'Corner eleven: a tenth a lap over your last two laps, mostly on the exit. ' +
        'Three kilometres an hour more out of the exit. Number two on the list, but it was fine last lap. Do that again.', s);
    const won = workSnapshot();
    won.state.work = won.state.work.map((f, i) => (i === 0 ? { ...f, gainSec: 0.1 } : f));
    check('corner on the list with a gain: what it has won back', /Top of the list, and you've won back a tenth on it already\.$/.test(a('what about corner five', won)),
      a('what about corner five', won));
    s = a('what about corner three');
    check('corner put right this run: what it won back', s === "Corner three's better: two tenths back this run. Keep doing what you did there.", s);
    s = a('what about corner four');
    check('a corner off the list: the v1 detail', /^Corner four: /.test(s) && !/list/.test(s), s);
    check('cueDetailWords: never the same measure twice',
      V.cueDetailWords({ phase: 'braking', brakeShiftM: 10 }, { phase: 'braking', brakeShiftM: 6, throttleShiftM: -12 }) ===
        'brake ten metres later and back on the throttle twelve metres sooner');

    // -- the debrief, asked for --------------------------------------------------
    s = a('how am I doing', workSnapshot({ debrief: DEBRIEF }));
    check("debrief: the snapshot's debrief (the engine's template) is said as it is", s === DEBRIEF.text, s);
    s = a('debrief me', workSnapshot({ debrief: null }));
    check('debrief: null in the snapshot → not enough laps on this run', s === 'Not enough clean laps on this run yet. Give me a couple more.', s);
    s = a("how's my run");
    const engineHasDebrief = typeof require('../dist/telemetry/liveCoach').runDebrief === 'function';
    if (!engineHasDebrief) {
      check('debrief: no engine runDebrief → worded from the state',
        s === "You've improved corners three, seven and nine, about four tenths in all. Still to work on: corner five, " +
          'brake ten metres later, worth two tenths, and corner eleven, three kilometres an hour more out of the exit, worth a tenth.', s);
    } else {
      check('debrief: the engine\'s runDebrief answers when the snapshot has none', typeof s === 'string' && s.length > 0 && !/\bC\d/.test(s), s);
    }
    if (!engineHasDebrief) {
      s = a('how am I doing', snapshot()); // the v1 snapshot: no work list, no run
      check('debrief, v1 state: the focus as "still to work on"', s === 'Still to work on: corner four, brake ten metres later, worth two tenths.', s);
    }
    for (const q of ['how am I doing', 'debrief me', 'what are my corners']) {
      check(`null snapshot: "${q}" → null (the engineer takes it as before)`, V.answerCoachQuestion(q, null) === null);
    }
    const all = ['what should I work on', 'what about corner five', 'what about corner eleven', 'what about corner three', 'how am I doing'].map((q) => a(q));
    check('no v2 answer says a raw corner id, a unit symbol or a digit',
      all.every((x) => !/\bC\d/.test(x) && !/km\/h|Δ| m\b| s\b/.test(x) && !/\d/.test(x)), all.join(' | '));

    // -- engineer.js: the new phrases, on and off a coached session --------------
    check('matchGrammarText: "how am i doing" → coachDebrief, "what are my corners" → coachWorkOn',
      matchGrammarText('how am i doing') === 'coachDebrief' && matchGrammarText('what are my corners') === 'coachWorkOn');
    check('COACH_INTENTS holds coachDebrief, with no command fallback', COACH_INTENTS.has('coachDebrief') && !COACH_FALLBACK.coachDebrief);
    const rig2 = ({ line, whisper, snap }) => {
      const sent = [];
      const svc = new EngineerService({
        dir: path.join(os.tmpdir(), 'apex-livecoach-test'),
        loadSettings: () => ({ engineerEnabled: true, engineer: { readouts: 'standard' } }),
        onStatus: () => {}, noteUsage: () => {},
        cloudAsk: async (body) => { sent.push(body); return { ok: true, body: { ok: true, answer: 'cloud says' } }; },
      });
      const spoken = [];
      Object.assign(svc, { running: true, recognizerReady: true, freeFormLive: true, speak: (t) => spoken.push(t), pushStatus: () => {}, playChirp: () => {} });
      svc.recognizer = { stdin: { write: () => setImmediate(() => svc.onRecognizerLine(line)) } };
      svc.transcribeClip = async () => ({ question: whisper || '', sttMs: whisper ? 900 : null });
      svc.commands = { answer: (i) => ({ text: `answer:${i}` }), answerPosition: (q) => ({ text: `position:${q.intent}` }), averageOf: () => null, summaryExtras: () => undefined };
      svc.summaryMod = { engineerSummary: () => ({ connected: true }) };
      svc.lastFrame = {};
      if (snap !== undefined) svc.setLiveCoachSnapshot(() => snap);
      return { svc, spoken, sent };
    };
    const FREE = 'FREE\tC:\\w\\free.wav\t0.4\twhatever';
    let r = rig2({ line: FREE, whisper: 'How am I doing?', snap: workSnapshot({ debrief: DEBRIEF }) });
    let res = await r.svc.ask();
    check('whisper "how am I doing", coached → the run debrief, locally', r.spoken[0] === DEBRIEF.text && res.outcome === 'tier1' && r.sent.length === 0, r.spoken.join('|'));
    r = rig2({ line: FREE, whisper: 'How am I doing?', snap: null });
    await r.svc.ask();
    check('not live: "how am I doing" → the cloud, as before the coach', r.sent.length === 1 && r.spoken[0] === 'cloud says', r.spoken.join('|'));
    r = rig2({ line: FREE, whisper: 'what are my corners', snap: workSnapshot() });
    await r.svc.ask();
    check('whisper "what are my corners", coached → the work list', /^Two to work on\./.test(r.spoken[0] || ''), r.spoken.join('|'));
    r = rig2({ line: 'HEARD\tcoachDebrief\t0.95\tC:\\w\\h.wav\thow am i doing', snap: workSnapshot({ debrief: DEBRIEF }) });
    res = await r.svc.ask();
    check('SAPI exact "how am i doing", coached → the debrief, no whisper', r.spoken[0] === DEBRIEF.text && res.outcome === 'tier1', r.spoken.join('|'));
    r = rig2({ line: 'HEARD\tcoachDebrief\t0.95\tC:\\w\\h.wav\thow am i doing', whisper: 'how am i doing', snap: null });
    await r.svc.ask();
    check('SAPI exact "how am i doing", not live → on to the cloud, never commands.answer(coachDebrief)',
      r.sent.length === 1 && !r.spoken.some((x) => /^answer:coachDebrief/.test(x)), r.spoken.join('|'));
    r = rig2({ line: FREE, whisper: 'how am I doing on fuel', snap: workSnapshot() });
    await r.svc.ask();
    check('practice: "how am I doing on fuel" is not the coach\'s', !/to work on|improved/.test(r.spoken[0] || ''), r.spoken.join('|'));
  }

  /* ======================================================================== */
  console.log('\n10) v2: the run debrief\'s AI request, against the deployed function');
  /* ======================================================================== */
  {
    const ws = workSnapshot();
    const ctx = { track: 'Road Atlanta', car: 'Porsche 911 GT3 R', carClass: 'GT3', targetLabel: 'Session best · 1:43.020' };
    const req = V.debriefRequest(DEBRIEF, ws, ctx);
    const sreq = V.summaryRequest(ws, ctx);
    check('a request', !!req);
    check('the summary\'s shape: kind session, inputHash, context, facts', req.kind === 'session' &&
      JSON.stringify(Object.keys(req).sort()) === JSON.stringify(Object.keys(sreq).sort()) &&
      JSON.stringify(Object.keys(req.context).sort()) === JSON.stringify(Object.keys(sreq.context).sort()), Object.keys(req).join(','));
    check('inputHash passes the function\'s shape', /^[0-9a-f]{16,128}$/i.test(req.inputHash), req.inputHash);
    check('…same input → same hash; not the summary\'s hash', V.debriefRequest(DEBRIEF, workSnapshot(), ctx).inputHash === req.inputHash && req.inputHash !== sreq.inputHash);
    const ids = req.facts.map((f) => f.id);
    check('fact ids unique', new Set(ids).size === ids.length, ids.join(','));
    check('every fact survives cleanFacts (id ≤ 64, text ≤ 240, finite value, ≤ 60)',
      req.facts.length <= 60 && req.facts.every((f) => f.id && f.id.length <= 64 && f.text && f.text.length <= 240 && Number.isFinite(f.value)),
      req.facts.map((f) => f.text.length).join(','));
    check('every unit is a CoachFact unit', req.facts.every((f) => ['s', 'm', 'kph', '%', 'C', 'L', 'pts', 'laps'].includes(f.unit)));
    check('body under the 24000-char cap', JSON.stringify(req).length < 24000);
    check('the shape asked for rides first (run.brief), with no number', ids[0] === 'run.brief' && !/\d/.test(req.facts[0].text) && req.facts[0].value === 0);
    for (const id of ['C3.gain', 'C7.gain', 'C9.gain', 'run.gain', 'C5.loss', 'C5.brakeDeltaM', 'C5.minKphDelta', 'C5.what',
      'C11.loss', 'C11.exitKphDelta', 'C11.what', 'run.laps', 'lap.time']) {
      check(`holds ${id}`, ids.includes(id));
    }
    const f = (id) => req.facts.find((x) => x.id === id);
    check('improved with numbers: C3 0.20 s won back, run.gain 0.42 s',
      f('C3.gain').value === 0.2 && /0\.20 s/.test(f('C3.gain').text) && f('run.gain').value === 0.42 && /C3, C7 and C9/.test(f('run.gain').text), f('run.gain').text);
    check('still with numbers: C5 0.21 s a lap', f('C5.loss').value === 0.21 && /0\.21 s a lap/.test(f('C5.loss').text));
    check('the cue: +10 m brake shift → brakeDeltaM −10 ("brake 10 m earlier")', f('C5.brakeDeltaM').value === -10 && /10 m earlier/.test(f('C5.brakeDeltaM').text));
    check('cue2: +4 km/h at the apex → minKphDelta −4', f('C5.minKphDelta').value === -4 && /4 km\/h slower/.test(f('C5.minKphDelta').text));
    check('the engine\'s what-to-change words ride along', /braking ten metres too early/.test(f('C5.what').text));
    check('no corner in the facts that the debrief does not name',
      req.facts.every((x) => !x.cornerId || ['C3', 'C7', 'C9', 'C5', 'C11'].includes(x.cornerId)));
    check('the user turn holds every fact', req.facts.every((x) => VAL.userContent(req).includes(`${x.id} | ${x.text}`)));
    const wired = IPC._test.requestFromRaw(req, COACH_REPORT_VERSION);
    check('coach-ipc requestFromRaw (askAi) keeps every fact', wired && wired.kind === 'session' && wired.facts.length === req.facts.length);
    check('an empty debrief → null', V.debriefRequest({ improved: [], still: [], text: '', laps: 3 }, ws) === null && V.debriefRequest(null, ws) === null);
    check('no snapshot still builds (the debrief carries the corners)', !!V.debriefRequest(DEBRIEF, null, ctx));

    /* ---- the reply ---------------------------------------------------------- */
    const good = {
      headline: 'A good run: C3, C7 and C9 are sorted.',
      takeaways: [
        { title: 'Brake later into C5', body: 'Brake later into C5 and carry more speed to the apex.', factIds: ['C5.loss', 'C5.brakeDeltaM', 'C5.minKphDelta'], cornerIds: ['C5'] },
        { title: 'Better in C3, C7 and C9', body: 'You have tidied up C3, C7 and C9 this run.', factIds: ['C3.gain', 'C7.gain', 'C9.gain', 'run.gain'], cornerIds: ['C3', 'C7', 'C9'] },
        { title: 'More exit speed from C11', body: 'Get more speed out of C11 onto the straight.', factIds: ['C11.loss', 'C11.exitKphDelta'], cornerIds: ['C11'] },
      ],
      sequences: [],
    };
    const v = VAL.validateCoachReply(good, req.facts);
    check('a reply citing the debrief facts passes the REAL validator', v.ok, v.ok ? '' : v.reasons.join(' | '));
    const wrongWay = VAL.validateCoachReply({ ...good, takeaways: [{ title: 'Brake earlier into C5', body: 'Brake earlier into C5.', factIds: ['C5.brakeDeltaM'], cornerIds: ['C5'] }] }, req.facts);
    check('…and "brake earlier into C5" is rejected there (signs reach it right)', !wrongWay.ok);

    let s = V.speakableDebrief(v.result, DEBRIEF, ws, req);
    const WANT = 'You have tidied up corners three, seven and nine this run, about four tenths in all. ' +
      'Brake later into corner five and carry more speed to the apex, worth about two tenths a lap. ' +
      'Get more speed out of corner eleven onto the straight, worth about a tenth a lap.';
    check('speakable: improved first, then still to work on, figures from the facts', s === WANT, s);
    check('…three sentences, no "C5", no digits', s && s.split(/(?<=\.)\s+/).length === 3 && !/\bC\d/.test(s) && !/\d/.test(s));
    check('…the { ok, ai } answer works too', V.speakableDebrief({ ok: true, ai: v.result }, DEBRIEF, ws, req) === s);
    check('…without the request, rebuilt from the debrief', V.speakableDebrief(v.result, DEBRIEF, ws) === s);
    check('…and through the contract object', V.liveCoachVoice.speakableDebrief(v.result, DEBRIEF, ws) === s &&
      V.liveCoachVoice.debriefRequest(DEBRIEF, ws, ctx).inputHash === req.inputHash);
    check('the template passes its own guard', V.debriefGuard(WANT, DEBRIEF, req.facts).length === 0, V.debriefGuard(WANT, DEBRIEF, req.facts).join(' | '));

    // Rejects: the template is said instead.
    const tk = (o) => ({ ...good, takeaways: [good.takeaways[1], { ...good.takeaways[0], ...o }] });
    check('null / junk / { ok:false } → null', V.speakableDebrief(null, DEBRIEF, ws, req) === null &&
      V.speakableDebrief('Brake later', DEBRIEF, ws, req) === null && V.speakableDebrief({}, DEBRIEF, ws, req) === null &&
      V.speakableDebrief({ ok: false, ai: null, code: 'rejected' }, DEBRIEF, ws, req) === null);
    check('no debrief → null', V.speakableDebrief(v.result, null, ws, req) === null);
    check('an invented corner (C6) in the words → null, not trimmed',
      V.speakableDebrief(tk({ body: 'Brake later into C6 as well.' }), DEBRIEF, ws, req) === null);
    check('an invented corner in cornerIds → null', V.speakableDebrief(tk({ cornerIds: ['C5', 'C4'] }), DEBRIEF, ws, req) === null);
    check('a fact the request did not hold → null', V.speakableDebrief(tk({ factIds: ['C5.loss', 'C99.loss'] }), DEBRIEF, ws, req) === null);
    check('the wrong number ("12 m" where the fact says 10) → null',
      V.speakableDebrief(tk({ body: 'Brake 12 m later into C5.' }), DEBRIEF, ws, req) === null);
    s = V.speakableDebrief(tk({ body: 'Brake 10 m later into C5.' }), DEBRIEF, ws, req);
    check('the right number ("10 m") → said in words, no figure tail added',
      s === 'You have tidied up corners three, seven and nine this run, about four tenths in all. Brake ten metres later into corner five.', s);
    s = V.speakableDebrief({ ...good, takeaways: [{ title: 'Better in C3 and C7', body: 'C3 and C7 are tidier now.', factIds: ['C3.gain', 'C7.gain'], cornerIds: ['C3', 'C7'] }] },
      DEBRIEF, ws, req);
    check('two of the three improved: their own gains (0.32 s), not the run total of 0.42', s === 'Corners three and seven are tidier now, about three tenths in all.', s);
    check('a number with no unit → null', V.speakableDebrief(tk({ body: 'Brake later into C5, 2 times.' }), DEBRIEF, ws, req) === null);
    const four = { ...good, takeaways: [...good.takeaways, { title: 'Again C5', body: 'Keep at C5.', factIds: ['C5.loss'], cornerIds: ['C5'] }] };
    check('four takeaways (four sentences) → null', V.speakableDebrief(four, DEBRIEF, ws, req) === null);

    // The guard alone.
    const g = (t) => V.debriefGuard(t, DEBRIEF, req.facts);
    check('guard: "C5" in the text is refused', g('Brake later into C5.').some((x) => /raw corner id/.test(x)), g('Brake later into C5.').join(' | '));
    check('guard: "turn five" is refused', g('Brake later into turn five.').length > 0);
    check('guard: four sentences are refused', g('Corner five. Corner eleven. Corner three. Corner nine.').some((x) => /4 sentences/.test(x)));
    check('guard: an invented corner, also in a list', g('You improved corners three, six and nine.').some((x) => /corner 6/.test(x)) &&
      g('Corner six, brake later.').some((x) => /corner 6/.test(x)));
    check('guard: "corner five, ten metres" reads ten as metres, not a corner', g('Corner five, ten metres later on the brakes.').length === 0,
      g('Corner five, ten metres later on the brakes.').join(' | '));
    check('guard: numbers within rounding pass (0.42 s → four tenths, 0.21 s → two tenths, 4 km/h, 6 laps)',
      g('About four tenths in all. Corner five, worth two tenths, carry four kilometres an hour more. Six clean laps.').length === 0);
    check('guard: a wrong figure fails (three tenths for C5\'s 0.21, twelve metres)',
      g('Corner five, worth five tenths.').some((x) => /0\.5 s/.test(x)) && g('Brake twelve metres later.').some((x) => /12 m/.test(x)));
    check('guard: "a tenth and a half" is 0.15 s (C11 0.14 passes)', g('Corner eleven, a tenth and a half.').length === 0);
    check('guard: a bare number fails, "the one" does not', g('Corner five, two times.').some((x) => /bare number/.test(x)) &&
      g('Corner five is the one to fix.').length === 0);
    check('guard: km/h symbol refused', g('Corner five, 4 km/h more.').some((x) => /symbol/.test(x)));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
