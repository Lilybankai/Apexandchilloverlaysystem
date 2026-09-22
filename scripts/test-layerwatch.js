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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
