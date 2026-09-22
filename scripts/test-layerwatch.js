/**
 * scripts/test-layerwatch.js — a frozen in-game layer comes back on its own.
 * -----------------------------------------------------------------------------
 * electron/layer-watch.js is the only thing standing between a wedged layer
 * renderer and a driver reaching for Stop/Start mid-race. The two ways it can
 * fail are both quiet on a tester's machine, so both are asserted here:
 *
 * 1. It must NOT act on silence that is expected — a layer hidden by auto
 *    show/hide in the menus, a page mid-load, a feed that is down, a page that
 *    has never painted — and must give a freshly shown layer the full grace
 *    period rather than charging it for the time it spent hidden. Getting this
 *    wrong reloads a healthy overlay in front of the driver.
 *
 * 2. It MUST escalate and then stop: reload first, rebuild the window if the
 *    reload did not hold, and give up after a fixed budget so a fault it
 *    cannot fix costs one log line instead of a flickering window all race.
 *
 * Pure: invented clocks, no Electron.
 *
 * Run: node scripts/test-layerwatch.js
 */

'use strict';

const {
  createLayerWatch,
  createLayerDiagnosis,
  QUIET_MS,
  ESCALATE_MS,
  MAX_RECOVERIES,
} = require('../electron/layer-watch');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

const LIVE = { visible: true, loading: false, feedLive: true };

/** Check every 2 s like main.js does, from `from` to `to`; return the non-ok verdicts. */
function run(w, from, to, facts = LIVE, paintEveryMs = 0) {
  const acted = [];
  for (let t = from; t <= to; t += 2000) {
    if (paintEveryMs && t % paintEveryMs === 0) w.painted(t);
    const v = w.check({ now: t, ...facts });
    if (v.action !== 'ok') acted.push({ at: t, ...v });
  }
  return acted;
}

console.log('\nlayer-watch: expected silence is left alone');
{
  const w = createLayerWatch();
  check('a page that never painted is never reloaded', run(w, 0, 120000).length === 0);

  const h = createLayerWatch();
  h.painted(0);
  check('a painting layer is left alone', run(h, 0, 120000, LIVE, 1000).length === 0);
  check(
    'a hidden layer (auto show/hide in the menus) is left alone',
    run(h, 122000, 300000, { ...LIVE, visible: false }).length === 0,
  );
  h.excuse(302000); // main.js does this as it shows the window
  check(
    'shown again, it gets the full grace period, not charged for the hidden time',
    run(h, 302000, 302000 + QUIET_MS - 2000).length === 0,
  );
  const f = createLayerWatch();
  f.painted(0);
  check('no feed, no reload', run(f, 0, 120000, { ...LIVE, feedLive: false }).length === 0);
  check('mid-load, no reload', run(f, 122000, 240000, { ...LIVE, loading: true }).length === 0);

  const e = createLayerWatch();
  e.painted(0);
  e.excuse(QUIET_MS - 1000);
  check(
    'excuse() restarts the clock (window just shown / loaded)',
    run(e, 2000, QUIET_MS + 6000).length === 0,
  );
}

console.log('\nlayer-watch: a frozen layer is recovered, then escalated, then left');
{
  const w = createLayerWatch();
  w.painted(0);
  const first = run(w, 2000, QUIET_MS + 2000);
  check(
    'quiet past the limit with the feed live → reload',
    first.length === 1 && first[0].action === 'reload',
    first.map((a) => a.action).join(','),
  );

  const second = run(w, QUIET_MS + 4000, QUIET_MS * 2 + 4000);
  check(
    'frozen again within the escalation window → recreate the window',
    second.length === 1 && second[0].action === 'recreate' && second[0].at - first[0].at < ESCALATE_MS,
    second.map((a) => a.action).join(','),
  );

  const rest = run(w, QUIET_MS * 2 + 6000, QUIET_MS * 20);
  const actions = rest.map((a) => a.action);
  check(
    `gives up after ${MAX_RECOVERIES} recoveries, and says so once`,
    actions.filter((a) => a !== 'give-up').length === MAX_RECOVERIES - 2 &&
      actions.filter((a) => a === 'give-up').length === 1,
    actions.join(','),
  );

  w.forget();
  w.painted(1e7);
  const fresh = run(w, 1e7 + 2000, 1e7 + QUIET_MS + 2000);
  check(
    'a deliberate stop clears the record: the next layer is recovered again',
    fresh.length === 1 && fresh[0].action === 'reload',
    fresh.map((a) => a.action).join(','),
  );
}

{
  const w = createLayerWatch();
  w.painted(0);
  const a = run(w, 2000, QUIET_MS + 2000);
  w.painted(QUIET_MS + 4000);
  // Paints for a good while, then freezes again long after the reload.
  const later = run(w, QUIET_MS + 4000, ESCALATE_MS * 3, LIVE, 1000);
  const b = run(w, ESCALATE_MS * 3 + 2000, ESCALATE_MS * 3 + QUIET_MS + 4000);
  check(
    'a freeze long after a successful reload starts again at reload',
    a.length === 1 && later.length === 0 && b.length === 1 && b[0].action === 'reload',
    b.map((x) => x.action).join(','),
  );
}

console.log('\nlayer diagnosis: the log says which kind of freeze it was');
{
  const ON = { visible: true, feedLive: true };
  const good = { received: 30, painted: 30, worstMs: 2, worstWidget: 'relative', longMs: 0, visibility: 'visible' };
  const d = createLayerDiagnosis();
  let quiet = [];
  for (let t = 1000; t <= 60000; t += 1000) quiet = quiet.concat(d.report(t, good, ON));
  check('a healthy layer writes nothing', quiet.length === 0, quiet.join(' | '));
  check(
    'a 120 Hz feed coalesced onto a 60 Hz screen is not "drawing slowly"',
    d.report(61000, { ...good, received: 120, painted: 60 }, ON).length === 0,
  );

  const blocked = d.report(63400, { ...good, worstMs: 1380, worstWidget: 'trackmap', longMs: 1400 }, ON);
  check(
    'a late report is a blocked renderer, and names the widget',
    blocked.length === 1 && /STALL 1400ms blocked worst=trackmap\/1380ms long=1400ms/.test(blocked[0]),
    blocked.join(' | '),
  );

  const starts = d.report(64400, { ...good, painted: 0 }, ON);
  check(
    'frames arriving but none drawn → "not drawing", logged once',
    starts.length === 1 && /LAYER not drawing \(received=30 painted=0/.test(starts[0]) &&
      d.report(65400, { ...good, painted: 0 }, ON).length === 0,
    starts.join(' | '),
  );
  const ends = d.report(66400, good, ON);
  check(
    'and its end is logged with how long it lasted',
    ends.length === 1 && /not drawing ended after 3000ms/.test(ends[0]),
    ends.join(' | '),
  );

  const slow = d.report(67400, { ...good, received: 60, painted: 5 }, ON);
  check('most frames dropped → "drawing slowly"', slow.length === 1 && /drawing slowly/.test(slow[0]), slow.join(' | '));
  d.report(68400, good, ON);

  const starve = d.report(69400, { ...good, received: 0, painted: 0 }, ON);
  check('no frames while main is fed → "no frames"', starve.length === 1 && /no frames/.test(starve[0]), starve.join(' | '));
  d.report(70400, good, ON);

  const hidden = d.report(71400, { ...good, received: 30, painted: 0, visibility: 'hidden' }, { ...ON, visible: false });
  check('a hidden layer that is not drawing is not a fault', hidden.length === 0, hidden.join(' | '));
  const idle = d.report(72400, { ...good, received: 0, painted: 0 }, { ...ON, feedLive: false });
  check('no frames because there is no feed is not a fault', idle.length === 0, idle.join(' | '));

  const m = createLayerDiagnosis();
  m.report(100000, { ...good, at: 100000 }, ON);
  check(
    'a report delivered late because MAIN was busy is not blamed on the layer',
    m.report(102500, { ...good, at: 101000 }, ON).length === 0,
  );

  d.reset();
  check(
    'after a reset the first report is not read as late',
    d.report(999999, good, ON).length === 0,
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
