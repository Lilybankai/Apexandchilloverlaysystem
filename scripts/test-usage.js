/**
 * scripts/test-usage.js — the feature counters, and what reaches the league.
 * -----------------------------------------------------------------------------
 * Three pieces, all of them quiet when they are wrong:
 *
 *   1. electron/featureUsage.js — the local daily counters. Every bug here is
 *      silent by construction: a counter that double-counts, one that resets on
 *      restart, a day that is offered forever because it was never marked sent,
 *      a day that is never offered again after more use landed on it. None of
 *      them raise; they just produce a chart that is confidently wrong, and a
 *      chart that is confidently wrong is worse than no chart, because someone
 *      is about to cut a feature on the strength of it.
 *
 *   2. dist/server/index.classifyOverlayLoad — which overlay page a request was
 *      for. The parsing is where the edge cases live (no query, an unknown
 *      widget, our own in-game window) and a table of URLs proves it far more
 *      cheaply than a live server does.
 *
 *   3. control-panel/feature-catalog.js — the slug list. A duplicate slug or a
 *      renamed one splits a feature's history in two without any error, so the
 *      shape is asserted here rather than trusted.
 *
 * Run: node scripts/test-usage.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const usage = require('../electron/featureUsage');
const catalog = require('../electron/control-panel/feature-catalog');

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

/** A throwaway userData dir per case, so nothing leaks between them. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-usage-'));
}

/**
 * A fake auth module. Records every RPC and answers however the case needs.
 * Mirrors the real `auth.rpc` contract: `{ ok }`, `{ ok:false, signedOut:true }`
 * or `{ ok:false, error }`.
 */
function fakeAuth(reply = () => ({ ok: true })) {
  const calls = [];
  return {
    calls,
    async rpc(fn, args) {
      calls.push({ fn, args });
      return reply(fn, args);
    },
  };
}

const today = usage._internals.today();

/*
 * Everything runs inside one async main.
 *
 * Most tests in scripts/ are synchronous and end with a bare process.exit; this
 * one cannot be, because three of the cases are about what flush() sends, and
 * flush() is a promise. Draining one from top-level sync code is not possible —
 * blocking the thread blocks the microtask queue that would resolve it — so the
 * whole file awaits instead, and the exit code is set once main() settles.
 */
async function main() {

/* ========================================================================== */
console.log('\nLocal counters — accumulation');
/* ========================================================================== */
{
  const dir = tmpDir();
  usage.init({ userDataDir: dir, auth: fakeAuth(), appVersion: '9.9.9' });
  usage.stop(); // no timer in a test; flush() is driven by hand

  usage.feature('tab:review');
  usage.feature('tab:review');
  usage.feature('tab:review', { uses: 0, seconds: 120 });
  usage.feature('action:setup.download');

  const rows = usage._internals.featureRows(today);
  const review = rows.find((r) => r.feature === 'tab:review');
  // Two plain calls, plus a third that reported dwell only — so two uses.
  check('repeat uses add up', review && review.uses === 2, review && review.uses);
  check('a dwell-only report adds seconds, not a use', review && review.seconds === 120, review && review.seconds);
  check('a second feature gets its own row', rows.length === 2, rows.length);

  // Slugs are normalised, so `Tab:Review` from a careless call site cannot
  // become a second feature with the same name.
  usage.feature('  TAB:REVIEW  ');
  const after = usage._internals.featureRows(today).find((r) => r.feature === 'tab:review');
  check('slugs are trimmed and lower-cased', after.uses === 3, after.uses);

  check('an empty slug is ignored', (usage.feature(''), usage._internals.featureRows(today).length === 2));
  check(
    'a zero-use zero-second report is ignored',
    (usage.feature('tab:ghost', { uses: 0, seconds: 0 }),
    !usage._internals.featureRows(today).some((r) => r.feature === 'tab:ghost')),
  );

  // A dwell computed across a suspend/resume can arrive as a fortnight.
  usage.feature('tab:huge', { uses: 1, seconds: 99 * 86400 });
  const huge = usage._internals.featureRows(today).find((r) => r.feature === 'tab:huge');
  check('an absurd dwell is clamped to a day', huge.seconds === 86400, huge.seconds);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ========================================================================== */
console.log('\nLocal counters — overlays');
/* ========================================================================== */
{
  const dir = tmpDir();
  usage.init({ userDataDir: dir, auth: fakeAuth(), appVersion: '9.9.9' });
  usage.stop();

  usage.overlaysEnabled(['delta', 'fuel']);
  usage.overlaysLoaded(['delta']);
  usage.overlaysLoaded(['delta']);
  usage.overlaysOnScreen(['fuel'], 60);

  const rows = usage._internals.overlayRows(today);
  const delta = rows.find((r) => r.overlay === 'delta');
  const fuel = rows.find((r) => r.overlay === 'fuel');
  check('enabled overlays are recorded', delta.enabled && fuel.enabled);
  check('OBS loads count up', delta.obsLoads === 2, delta.obsLoads);
  check('in-game seconds accumulate', fuel.ingameSeconds === 60, fuel.ingameSeconds);

  // "Was on today", not "is on now": a card switched off must not erase the
  // evening it was used, which is what the server-side OR is there for.
  usage.overlaysEnabled(['delta']);
  check(
    'a day keeps every overlay that was on at any point',
    usage._internals.overlayRows(today).length === 2,
  );

  // An overlay only ever LOADED still has to reach the server, or a widget on
  // a stream that the driver never ticked in the panel is invisible.
  usage.overlaysLoaded(['radar']);
  const radar = usage._internals.overlayRows(today).find((r) => r.overlay === 'radar');
  check('a loaded-but-not-enabled overlay is still offered', !!radar && radar.obsLoads === 1);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ========================================================================== */
console.log('\nPersistence — a restart must not lose the day');
/* ========================================================================== */
{
  const dir = tmpDir();
  usage.init({ userDataDir: dir, auth: fakeAuth(), appVersion: '9.9.9' });
  usage.stop();
  usage.feature('tab:team', { uses: 5, seconds: 300 });
  usage.overlaysEnabled(['tyres']);
  usage.shutdown();

  check('the store is written to userData', fs.existsSync(path.join(dir, 'usage-counters.json')));

  // A fresh process, same folder.
  usage.init({ userDataDir: dir, auth: fakeAuth(), appVersion: '9.9.9' });
  usage.stop();
  const team = usage._internals.featureRows(today).find((r) => r.feature === 'tab:team');
  check('counters survive a restart', team && team.uses === 5 && team.seconds === 300, team && team.uses);
  check(
    'overlay state survives a restart',
    usage._internals.overlayRows(today).some((r) => r.overlay === 'tyres' && r.enabled),
  );

  // And the day carries on from where it was, rather than starting again.
  usage.feature('tab:team');
  const after = usage._internals.featureRows(today).find((r) => r.feature === 'tab:team');
  check('a restart continues the day, it does not restart it', after.uses === 6, after.uses);

  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // A crash mid-write, or anything else that leaves the file unreadable, must
  // cost the week's counters and nothing else.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'usage-counters.json'), '{"days":{"2026', 'utf8');
  let threw = false;
  try {
    usage.init({ userDataDir: dir, auth: fakeAuth(), appVersion: '9.9.9' });
    usage.stop();
    usage.feature('tab:dashboard');
  } catch {
    threw = true;
  }
  check('a corrupt store starts clean instead of throwing', !threw);
  check(
    'and counting carries on',
    usage._internals.featureRows(today).some((r) => r.feature === 'tab:dashboard'),
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ========================================================================== */
console.log('\nUpload — idempotence and backlog');
/* ========================================================================== */
{
  const dir = tmpDir();
  const auth = fakeAuth();
  usage.init({ userDataDir: dir, auth, appVersion: '1.2.3' });
  usage.stop();

  usage.feature('tab:overlays', { uses: 2 });
  usage.overlaysEnabled(['delta']);

  const first = await usage.flush({ reason: 'test' });
  check('a day with counters is sent', first.sent === 1, first.sent);
  check('both halves go up', auth.calls.length === 2, auth.calls.map((c) => c.fn).join('+'));
  check(
    'the version is stamped on the feature batch',
    auth.calls[0].args.p_app_version === '1.2.3',
  );
  check(
    'the wire shape is one array for the whole day',
    Array.isArray(auth.calls[0].args.p_rows) && auth.calls[0].args.p_rows.length === 1,
  );

  // THE point of the signature: an idle app offers nothing.
  const before = auth.calls.length;
  const second = await usage.flush({ reason: 'test' });
  check('an unchanged day is not re-sent', second.sent === 0 && auth.calls.length === before);

  // More use on the same day makes it offerable again, carrying the whole
  // day's totals rather than the delta — that is what the server's greatest()
  // needs, and sending a delta here would silently under-count.
  usage.feature('tab:overlays');
  const third = await usage.flush({ reason: 'test' });
  const sentRow = auth.calls[auth.calls.length - 2].args.p_rows.find(
    (r) => r.feature === 'tab:overlays',
  );
  check('more use on the same day re-offers it', third.sent === 1, third.sent);
  check('and sends the running TOTAL, not the delta', sentRow.uses === 3, sentRow.uses);

  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // Signed out is a state, not an error: nothing is marked sent, so the whole
  // day is still there for the flush after the driver signs in.
  const dir = tmpDir();
  const auth = fakeAuth(() => ({ ok: false, signedOut: true }));
  usage.init({ userDataDir: dir, auth, appVersion: '1.2.3' });
  usage.stop();
  usage.feature('tab:leaderboard');

  const out = await usage.flush({ reason: 'test' });
  check('a signed-out flush sends nothing', out.sent === 0 && out.signedOut === true);
  check('and says so rather than throwing', !out.error);

  // Now signed in.
  const live = fakeAuth();
  usage.init({ userDataDir: dir, auth: live, appVersion: '1.2.3' });
  usage.stop();
  const after = await usage.flush({ reason: 'test' });
  check('the day is still offered once the driver signs in', after.sent === 1, after.sent);
  check(
    'and it still carries the counters recorded while signed out',
    live.calls[0].args.p_rows.some((r) => r.feature === 'tab:leaderboard'),
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // A half-success must not mark the day sent: the overlay half would be
  // stranded until the counters happened to change again.
  const dir = tmpDir();
  const auth = fakeAuth((fn) =>
    fn === 'submit_overlay_usage' ? { ok: false, error: 'boom' } : { ok: true },
  );
  usage.init({ userDataDir: dir, auth, appVersion: '1.2.3' });
  usage.stop();
  usage.feature('tab:fuel');
  usage.overlaysEnabled(['fuel']);

  const out = await usage.flush({ reason: 'test' });
  check('a failed half fails the day', out.sent === 0, out.sent);
  check('and the error is reported, not swallowed as success', out.error === 'boom', out.error);

  const retry = fakeAuth();
  usage.init({ userDataDir: dir, auth: retry, appVersion: '1.2.3' });
  usage.stop();
  const ok = await usage.flush({ reason: 'test' });
  check('the whole day is retried after the failure', ok.sent === 1, ok.sent);
  check('including the half that had succeeded', retry.calls.length === 2, retry.calls.length);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ========================================================================== */
console.log('\nPruning — the file is a week of counters, not a diary');
/* ========================================================================== */
{
  const dir = tmpDir();
  const stale = '2020-01-01';
  fs.writeFileSync(
    path.join(dir, 'usage-counters.json'),
    JSON.stringify({
      version: 1,
      days: {
        [stale]: { features: { 'tab:review': { uses: 9, seconds: 0 } }, overlays: {} },
        [today]: { features: { 'tab:review': { uses: 1, seconds: 0 } }, overlays: {} },
      },
      sent: { [stale]: 'x' },
    }),
    'utf8',
  );
  usage.init({ userDataDir: dir, auth: fakeAuth(), appVersion: '1.2.3' });
  usage.stop();

  check('a day older than the window is dropped on load', !usage._internals.ledger()[stale]);
  check('today survives', !!usage._internals.ledger()[today]);
  check('and its send-marker goes with it', !usage._internals.sent()[stale]);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ========================================================================== */
console.log('\nOverlay page loads — which widget was fetched');
/* ========================================================================== */
{
  let classify = null;
  try {
    ({ classifyOverlayLoad: classify } = require('../dist/server/index'));
  } catch {
    /* not built */
  }
  if (typeof classify !== 'function') {
    check('dist/server is built (run "npm run build" first)', false);
  } else {
    const cases = [
      ['/', 'combined', []],
      ['/index.html', 'combined', []],
      ['/index.html?bg=0.5', 'combined', []],
      ['/widget.html?w=delta', 'widget', ['delta']],
      ['/widget.html?w=DELTA&port=17080', 'widget', ['delta']],
      ['/ingame.html?widgets=delta,fuel,tyres', 'ingame', ['delta', 'fuel', 'tyres']],
      ['/ingame.html?widgets=delta,,fuel', 'ingame', ['delta', 'fuel']],
    ];
    for (const [url, page, widgets] of cases) {
      const got = classify(url);
      check(
        `${url} → ${page}${widgets.length ? ` (${widgets.join(',')})` : ''}`,
        got && got.page === page && got.widgets.join(',') === widgets.join(','),
        got ? `${got.page}:${got.widgets.join(',')}` : 'null',
      );
    }

    // Assets and API calls are not page loads. Counting them would multiply
    // every load by however many files that page happens to pull.
    for (const url of ['/js/client.js', '/css/theme.css', '/api/mfd', '/appearance.json']) {
      check(`${url} is not an overlay load`, classify(url) === null);
    }
    // ?w= with nothing after it renders the page's own help, not a widget.
    check('/widget.html with no w= is not a load', classify('/widget.html') === null);
    check('/widget.html?w= is not a load', classify('/widget.html?w=') === null);
    check('a malformed URL is not a load', classify('http://[::bad') === null);
  }
}

/* ========================================================================== */
console.log('\nFeature catalog — the slugs are a contract');
/* ========================================================================== */
{
  const slugs = catalog.allSlugs();
  const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  check('no duplicate slugs', dupes.length === 0, dupes.join(',') || 'none');
  check(
    'every slug is namespaced tab: or action:',
    slugs.every((s) => /^(tab|action):[a-z0-9.\-]+$/.test(s)),
    slugs.length,
  );
  check(
    'every tab id is a slug, and every slug resolves to a label',
    catalog.TABS.every((t) => catalog.labelFor(catalog.tabSlug(t.id)) === t.label),
  );
  check(
    "every action's tab is a real tab (or app-wide)",
    catalog.ACTIONS.every((a) => a.tab === null || catalog.TABS.some((t) => t.id === a.tab)),
  );
  check(
    'an unknown slug degrades to its own name rather than vanishing',
    catalog.labelFor('action:from.the.future') === 'from.the.future',
  );
  check('note() is safe with no renderer bridge', (catalog.note('action:review.lap'), true));

  // The catalog's tab list has to match the panel's actual tabs, or the Usage
  // pane silently stops listing a section the moment one is added.
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'control-panel', 'index.html'),
    'utf8',
  );
  const inMarkup = [...html.matchAll(/<button class="tab"[^>]*data-tab="([a-z]+)"/g)].map(
    (m) => m[1],
  );
  const missing = inMarkup.filter((id) => !catalog.TABS.some((t) => t.id === id));
  const extra = catalog.TABS.filter((t) => !inMarkup.includes(t.id)).map((t) => t.id);
  check('every tab in the panel is in the catalog', missing.length === 0, missing.join(',') || 'none');
  check('and the catalog invents none', extra.length === 0, extra.join(',') || 'none');
}
} /* main */

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    // A throw here is the harness breaking, not a feature failing, and the two
    // must not look the same from CI.
    console.error('\n  the test harness itself threw:', err);
    process.exit(1);
  });
