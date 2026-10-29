/**
 * scripts/test-practice-panel.js — the Practice tab actually RENDERS.
 * -----------------------------------------------------------------------------
 * The Practice tab was redesigned on 2026-10-29 to Carl's mockup: KPI cards,
 * the AI Coach panel, "Where time is lost", the lap table, the corner heatmap
 * and the pace chart. Most of what feeds it comes from pieces built in
 * parallel (practiceCoach / practiceCoachAi, practiceTargets, ShowMe,
 * PracticeHabits) that may be missing from a build, so the panel feature-
 * detects every one of them.
 *
 * The id-contract test (test-panel-parity) only reads the source as text. This
 * runs the real practice-panel.js in a vm against a stub DOM, feeds it a
 * practice review in the shape main sends, and checks the page that comes out:
 *
 *   - today's data alone (no coach, no targets) renders the whole overview,
 *     with "Where time is lost" made from the review's own corners;
 *   - the coach's template words render at once and the AI's replace them,
 *     with cited facts filled in and the "Powered by Apex AI" badge;
 *   - the gap-to-leaderboard card appears only when practiceTargets says so;
 *   - a failed review shows its error state;
 *   - the heatmap and pace tabs, and the lap filter, redraw their cards.
 *
 * Run: node scripts/test-practice-panel.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  if (ok) pass += 1;
  else fail += 1;
};

const SRC = fs.readFileSync(path.join(__dirname, '..', 'electron', 'control-panel', 'practice-panel.js'), 'utf8');

/* -------------------------------------------------------------------------- */
/*  A stub DOM: enough of an element for the panel's own use                  */
/* -------------------------------------------------------------------------- */

class El {
  constructor(name) {
    this.name = name;
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.attrs = {};
    this.listeners = {};
    this.clientWidth = 600;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; }
  contains() { return false; }
  focus() {}
  scrollIntoView() {}
  get classList() { return { add() {}, remove() {}, toggle() {} }; }
  fire(type, evt) { for (const fn of this.listeners[type] || []) fn(evt); }
}

/** A click target whose closest(sel) answers for one attribute selector. */
function target(attr, value, extra) {
  const ds = {};
  const key = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
  ds[key] = value;
  const node = { dataset: ds, value, disabled: false, ...extra };
  return {
    closest(sel) {
      return sel.includes(`[${attr}]`) || sel.includes(`[${attr}=`) ? node : null;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i += 1) await flush(); }

/* -------------------------------------------------------------------------- */
/*  A review in the shape `review:practice` sends                             */
/* -------------------------------------------------------------------------- */

const SID = '2026-10-19T19:26:45.637Z~circuit-de-la-sarthe_13624';
function lapRow(no, sec, valid, deltas, total) {
  return {
    at: `2026-10-19T19:${String(20 + no).padStart(2, '0')}:00.000Z`,
    lapNo: no,
    lapSec: sec,
    valid,
    hasTrace: !!deltas,
    deltaSec: sec > 0 ? sec - 220.195 : null,
    corners: (deltas || []).map((d, index) => ({
      index,
      deltaSec: d,
      brakeDeltaM: index === 1 ? -6 : 2,
      apexKphDelta: index === 2 ? -4 : 1,
      score: { total: 80, braking: index === 0 ? null : 70, throttle: 82, line: null, speed: 75 },
    })),
    score: deltas ? { total, braking: 70, throttle: 82, line: null, speed: 75 } : null,
  };
}
const REVIEW = {
  id: SID,
  track: 'Circuit de la Sarthe',
  car: 'DKR Engineering 2026 #3:LM',
  carClass: 'LMP2',
  trackLengthM: 13626,
  startedAt: '2026-10-19T19:26:45.637Z',
  endedAt: '2026-10-19T20:36:59.843Z',
  target: { kind: 'sessionBest', label: 'Session best · 3:40.195', lapId: 'lap-3', lapSec: 220.195 },
  laps: [
    lapRow(1, 0, false, null, null),
    lapRow(2, 221.936, true, [0.05, 0.22, 0.31], 81),
    lapRow(3, 220.195, true, [0, 0, 0], 100),
    lapRow(4, 220.475, true, [-0.03, 0.12, 0.2], 88),
  ],
  bestLapSec: 220.195,
  theoreticalBestSec: 217.871,
  consistencySec: 2.959,
  corners: [
    { index: 0, entryD: 0.04, apexD: 0.046, exitD: 0.047, laps: 3, avgLossSec: 0.007, bestSec: -0.03, worstSec: 0.05, avgBrakeDeltaM: null, avgApexKphDelta: 1, avgScore: 89 },
    { index: 1, entryD: 0.2, apexD: 0.21, exitD: 0.22, laps: 3, avgLossSec: 0.113, bestSec: 0, worstSec: 0.22, avgBrakeDeltaM: -6, avgApexKphDelta: 1, avgScore: 79 },
    { index: 2, entryD: 0.5, apexD: 0.51, exitD: 0.52, laps: 3, avgLossSec: 0.17, bestSec: 0, worstSec: 0.31, avgBrakeDeltaM: 2, avgApexKphDelta: -4, avgScore: 70 },
  ],
  score: { avg: 84, best: 100, bestLapNo: 3 },
};
const SUMMARY = {
  id: SID, sim: 'LMU', track: 'Circuit de la Sarthe', trackKey: 'circuit-de-la-sarthe_13624', car: 'DKR', carClass: 'LMP2',
  sessionType: 'practice', startedAt: REVIEW.startedAt, endedAt: REVIEW.endedAt, laps: 4, cleanLaps: 3, stints: 1, bestMs: 220195, driveMs: 0, wet: false,
};
const SESSION = {
  id: SID, trackKey: SUMMARY.trackKey, carClass: 'LMP2',
  stints: [{ laps: REVIEW.laps.map((l, i) => ({ id: `lap-${i + 1}`, at: l.at, lapNo: l.lapNo, ambientTempC: 18.2, trackTempC: 25, wet: false })) }],
};

function coachReport(source) {
  return {
    version: 1, scope: 'session', sessionId: SID, lapId: null, source,
    headline: source === 'ai' ? 'Session analysis complete — 3 key takeaways for your next run.' : 'Three things to work on.',
    takeaways: [
      { title: source === 'ai' ? 'Braking too early in key corners' : 'Your biggest losses', body: 'You lose {f0} in C3 alone.', chip: '≈0.45 s total', tone: 'loss', cornerIds: ['C3'], factIds: ['f0'] },
      { title: 'Biggest gains in the final sector', body: 'Sector 3 is the main opportunity.', chip: '0.32 s potential', tone: 'potential', cornerIds: [], factIds: [] },
      { title: 'Aim higher', body: 'A cleaner lap.', chip: 'Aim for 3:37.8', tone: 'target', cornerIds: [], factIds: [] },
    ],
    worst: [
      { id: 'C3', lossSec: 0.22, priority: 'high', phase: 'braking', tip: 'Brake {{f1}} later.', confidence: 0.87, perLapSec: [null, 0.31, 0, 0.2], factIds: ['f0'] },
    ],
    sequences: [], aimForSec: 217.8,
    fairness: [{ kind: 'fuel', severity: 'warn', text: 'Fuel differs' }],
    facts: [
      { id: 'f0', cornerId: 'C3', kind: 'phaseLoss', value: 0.2217, unit: 's', text: '' },
      { id: 'f1', cornerId: 'C3', kind: 'brakeDeltaM', value: 12.4, unit: 'm', text: '' },
    ],
    generatedAt: '2026-10-29T00:00:00Z',
  };
}

/* -------------------------------------------------------------------------- */
/*  Run the panel                                                             */
/* -------------------------------------------------------------------------- */

async function boot(api, extraWindow) {
  const ids = ['pr-detail', 'pr-refresh', 'pr-session', 'pr-track', 'pr-class', 'pr-target', 'pr-meta', 'pr-habits-box', 'pr-habits-toggle', 'pr-habits'];
  const byId = Object.fromEntries(ids.map((id) => [`#${id}`, new El(id)]));
  const view = new El('view');
  view.setAttribute('data-active', 'true');
  const tab = new El('tab');
  const errors = [];
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    querySelector(sel) {
      if (sel === '[data-view="practice"]') return view;
      if (sel === '.tab[data-tab="practice"]') return tab;
      return byId[sel] || null;
    },
    addEventListener() {},
  };
  const window = {
    apex: {
      reviewSessions: () => Promise.resolve({ ok: true, sessions: [SUMMARY] }),
      reviewSession: () => Promise.resolve({ ok: true, session: SESSION }),
      reviewPractice: () => Promise.resolve({ ok: true, review: REVIEW }),
      reviewPending: () => Promise.resolve(null),
      practiceTrend: () => Promise.resolve({ ok: true, sessions: [
        { sessionId: 'older', at: '2026-10-01T00:00:00Z', laps: 9, avgScore: 78, bestScore: 85, bestLapSec: 221 },
        { sessionId: SID, at: REVIEW.startedAt, laps: 4, avgScore: 84, bestScore: 100, bestLapSec: 220.195 },
      ] }),
      getState: () => Promise.resolve({ settings: { speedUnit: 'kph', tempUnit: 'c' } }),
      ...api,
    },
    addEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    ...extraWindow,
  };
  const ctx = vm.createContext({
    window, document, console, setTimeout, clearTimeout, Promise, Date, Math, Number, String, Map, Set, Array, Object, JSON, Intl,
    requestAnimationFrame: window.requestAnimationFrame,
  });
  try {
    vm.runInContext(SRC, ctx, { filename: 'practice-panel.js' });
  } catch (err) {
    errors.push(err);
  }
  await settle();
  return { window, view, byId, detail: byId['#pr-detail'], errors };
}

(async () => {
  console.log('\nToday\'s data alone — no coach, no targets');
  {
    const { detail, byId, errors, window } = await boot({});
    const html = detail.innerHTML;
    check('the panel loads and renders without throwing', errors.length === 0, errors.map((e) => e.message).join('; '));
    check('window.apexPractice is exposed', !!window.apexPractice && typeof window.apexPractice.shown === 'function');
    check('KPI: best lap', html.includes('data-kpi="best"') && html.includes('3:40.195'));
    check('KPI: theoretical best with its potential', html.includes('3:37.871') && html.includes('−2.324s') === false && html.includes('-2.324s'));
    check('KPI: accuracy with the move since last session', html.includes('data-kpi="acc"') && html.includes('+6 vs last session'));
    check('KPI: consistency', html.includes('±2.96s'));
    check('no gap-to-leaderboard card without practiceTargets', !html.includes('data-kpi="gap"'));
    check('no AI Coach panel without practiceCoach', !html.includes('AI Coach'));
    check('"Where time is lost" falls back to the review\'s corners', html.includes('Where time is lost') && html.includes('<b>C3</b>') && html.includes('High priority'));
    check('a corner whose brake point is off is called a braking loss', html.includes('Braking'));
    check('every lap is a row, newest first, the best marked', html.indexOf('data-prlap="2026-10-19T19:24') < html.indexOf('data-prlap="2026-10-19T19:21') && html.includes('prx-bestpill'));
    check('the heatmap has a column per corner', (html.match(/class="prx-heat__col"/g) || []).length === 3);
    check('the heatmap leaves out "Your best lap" when the best lap IS the target', !html.includes('Your best lap'));
    check('the pace chart is drawn', html.includes('prx-pace__svg') && html.includes('prx-theo'));
    check('"How it works" survives as a popover', html.includes('pr-how') && html.includes('Accuracy, 0–100'));
    check('the session picker lists the session', byId['#pr-session'].innerHTML.includes(SID));
    check('the track picker names the track', byId['#pr-track'].innerHTML.includes('Circuit de la Sarthe'));
    check('the header carries the air temperature and condition', byId['#pr-meta'].innerHTML.includes('18°C') && byId['#pr-meta'].innerHTML.includes('Dry'));
    check('the target picker offers the session best', byId['#pr-target'].innerHTML.includes('vs your session best'));
    check('"Your driving" stays hidden without practice-habits.js', byId['#pr-habits-box'].hidden === true);

    // The heatmap's tabs and the lap filter redraw their cards.
    detail.fire('click', { target: target('data-prheattab', 'speed') });
    check('the heatmap switches to Speed', detail.innerHTML.includes('data-prheattab="speed" aria-selected="true"'));
    detail.fire('click', { target: target('data-prpacetab', 'acc') });
    check('the pace chart switches to Accuracy', detail.innerHTML.includes('data-prpacetab="acc" aria-selected="true"'));
    detail.fire('change', { target: target('data-prlapfilter', 'valid') });
    check('"Valid only" drops the invalid lap', !detail.innerHTML.includes('data-prlap="2026-10-19T19:21'));
  }

  console.log('\nWith the coach and the targets');
  {
    let aiDone;
    const aiGate = new Promise((r) => { aiDone = r; });
    const calls = [];
    const { detail, byId, errors } = await boot({
      practiceCoach: (a) => { calls.push(['coach', a]); return Promise.resolve({ ok: true, report: coachReport('template') }); },
      practiceCoachAi: (a) => { calls.push(['ai', a]); return aiGate.then(() => ({ ok: true, report: coachReport('ai') })); },
      practiceTargets: () => Promise.resolve({
        ok: true, mine: null, pick: 'board:x',
        candidates: [{ lap: { lapId: 'board:x', driver: 'timmyp', car: '', carClass: 'LMP2', lapSec: 219.545 }, assessment: { flags: [{ kind: 'fuel', severity: 'warn', text: 'Low fuel run' }], fuelSec: null, score: 1 }, label: 'timmyp · 3:39.545 · board' }],
        leaderGap: { sec: 0.65, label: 'vs top LMP2', flags: [{ kind: 'tow', severity: 'info', text: 'Tow on the straight' }] },
      }),
    });
    check('renders without throwing', errors.length === 0, errors.map((e) => e.message).join('; '));
    let html = detail.innerHTML;
    check('the template coach renders at once', html.includes('AI Coach') && html.includes('Your biggest losses'));
    check('…marked as refining while the AI works', html.includes('Refining'));
    check('…without the AI badge', !html.includes('Powered by Apex AI'));
    check('a cited fact is filled in ({f0} → 0.22 s)', html.includes('You lose 0.22 s in C3 alone.'));
    check('a {{fact}} in a tip is filled too', html.includes('Brake 12 m later.'));
    check('the coach\'s worst corner carries its confidence and a Show me', html.includes('Conf. 87%') && html.includes('data-prshow="C3"'));
    check('fairness flags show as chips', html.includes('prx-flag') && html.includes('Fuel differs'));
    check('the coach is asked once each way', calls.filter((c) => c[0] === 'coach').length === 1 && calls.filter((c) => c[0] === 'ai').length === 1);
    check('the gap-to-leaderboard card appears, with its flag', html.includes('data-kpi="gap"') && html.includes('+0.65s') && html.includes('Tow on the straight'));
    aiDone();
    await settle();
    html = detail.innerHTML;
    check('the AI\'s words replace the template', html.includes('Braking too early in key corners') && !html.includes('Your biggest losses'));
    check('…with the "Powered by Apex AI" badge', html.includes('Powered by Apex AI') && !html.includes('Refining'));
    // The target picker: open it, and the leaderboard lap is there with its chip.
    byId['#pr-target'].fire('click', { target: target('data-prtargetbtn', '') });
    const menu = byId['#pr-target'].innerHTML;
    check('the target menu lists the leaderboard lap with its fairness chip', menu.includes('role="listbox"') && menu.includes('vs timmyp') && menu.includes('Low fuel run'));
  }

  console.log('\nChoosing a leaderboard target');
  {
    const asked = [];
    const { byId, detail } = await boot({
      reviewPractice: (id, opts) => {
        asked.push(opts || null);
        if (opts && opts.targetLapId) return Promise.resolve({ ok: true, review: { ...REVIEW, target: { kind: 'board', label: 'timmyp · 3:39.545 · board', lapId: 'board:x', lapSec: 219.545 } } });
        return Promise.resolve({ ok: true, review: REVIEW });
      },
      practiceCoach: (a) => { asked.push(['coach', a.targetLapId]); return Promise.resolve({ ok: true, report: coachReport('template') }); },
      practiceTargets: () => Promise.resolve({ ok: true, mine: null, pick: null, leaderGap: null,
        candidates: [{ lap: { lapId: 'board:x', car: '', carClass: 'LMP2', lapSec: 219.545 }, assessment: { flags: [], fuelSec: null, score: 0 }, label: 'timmyp · 3:39.545 · board' }] }),
    });
    byId['#pr-target'].fire('click', { target: target('data-prtarget', 'board:x') });
    await settle();
    check('the review is asked again with the target lap', asked.some((a) => a && a.targetLapId === 'board:x'));
    check('the coach is asked again with the target lap', asked.some((a) => Array.isArray(a) && a[1] === 'board:x'));
    check('the page now measures against that lap', detail.innerHTML.includes('vs timmyp') && byId['#pr-target'].innerHTML.includes('vs timmyp'));
  }

  console.log('\nA main that cannot measure against another lap');
  {
    const { byId } = await boot({
      practiceTargets: () => Promise.resolve({ ok: true, mine: null, pick: null, leaderGap: null,
        candidates: [{ lap: { lapId: 'board:x', car: '', carClass: 'LMP2', lapSec: 219.545 }, assessment: { flags: [], fuelSec: null, score: 0 }, label: 'timmyp · 3:39.545 · board' }] }),
    });
    byId['#pr-target'].fire('click', { target: target('data-prtarget', 'board:x') });
    await settle();
    check('the choice is undone and the driver told', byId['#pr-target'].innerHTML.includes('cannot measure against that lap') && byId['#pr-target'].innerHTML.includes('vs your session best'));
  }

  console.log('\nStates');
  {
    const { detail, errors } = await boot({ reviewPractice: () => Promise.resolve({ ok: false, review: null, error: 'boom' }) });
    check('a failed review shows its error state', errors.length === 0 && detail.innerHTML.includes('could not be read'));
  }
  {
    const { detail } = await boot({ reviewSessions: () => Promise.resolve({ ok: true, sessions: [] }) });
    check('no sessions shows the empty state', detail.innerHTML.includes('Leave a practice session'));
  }
  {
    const rendered = [];
    const { byId } = await boot({}, { PracticeHabits: { render: (el, a) => { rendered.push(a); return Promise.resolve(); } } });
    check('"Your driving" shows when practice-habits.js is present', byId['#pr-habits-box'].hidden === false);
    byId['#pr-habits-toggle'].fire('click', {});
    check('…and opening it renders the habits for this track and class', rendered.length === 1 && rendered[0].trackKey === SUMMARY.trackKey && rendered[0].carClass === 'LMP2');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
