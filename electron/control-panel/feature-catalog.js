/**
 * feature-catalog.js — every part of the app that reports whether it is used.
 * -----------------------------------------------------------------------------
 * One list, two readers:
 *
 *   * the PANEL calls `slug()` helpers as it runs, so a tab arrival or a button
 *     press lands in the local usage store (electron/featureUsage.js) under a
 *     stable name;
 *   * the ADMIN pane reads the whole list, so a feature that NOBODY has touched
 *     still gets a row — reading zero. That is the entire point of the exercise:
 *     an analytics screen built only from what arrived can never show you the
 *     thing nobody found, which is exactly the thing worth fixing.
 *
 * ## Slug shape
 * `<kind>:<name>`, lower case, stable forever.
 *
 *   tab:review               — the Review tab was opened.
 *   action:review.lap        — a lap was opened inside it.
 *
 * The prefix is what the cloud groups on (`feature like 'tab:%'`) and what the
 * admin pane splits its two tables by, so it is a contract, not decoration.
 *
 * ## Renaming
 * Don't. A slug is the join key between a build shipped today and a chart read
 * in a year; rename one and the history silently splits into two half-features
 * that both look like they are dying. Change the LABEL freely — that is only
 * ever display — and retire a slug by setting `retired: true` so the admin pane
 * can stop nagging about a zero that is expected.
 *
 * Loaded as a classic script by the panel (window.APEX_FEATURE_CATALOG) and
 * require()d by scripts/test-usage.js — keep it dependency-free and
 * side-effect-free, the same contract setup-groups.js keeps.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_FEATURE_CATALOG = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /**
   * The panel's tabs, in rail order. `id` matches `data-tab` in index.html and
   * the argument showView() is called with — that is what makes the tab router
   * a single instrumentation point instead of thirteen.
   *
   * `gated` marks a tab that is not visible to everyone (Fuel is behind the
   * beta channel, Admin behind is_admin). Their adoption is measured against
   * a different population, so the admin pane says so rather than quietly
   * reporting 4% for something 96% of drivers cannot see.
   */
  const TABS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'engineer', label: 'Race Engineer' },
    { id: 'setups', label: 'Setups' },
    { id: 'fuel', label: 'Fuel & Strategy', gated: 'beta' },
    { id: 'team', label: 'Team' },
    { id: 'review', label: 'Review (Analyse)' },
    { id: 'overlays', label: 'Overlays' },
    { id: 'streamers', label: 'Streamers' },
    { id: 'leaderboard', label: 'Leaderboard' },
    { id: 'schedule', label: 'Schedule' },
    { id: 'suggestions', label: 'Suggestions' },
    { id: 'settings', label: 'Settings' },
    { id: 'admin', label: 'Admin', gated: 'admin' },
  ];

  /**
   * The things a driver DOES, as opposed to the tabs they visit. A tab count
   * alone flatters everything — arriving on Setups says nothing about whether
   * anyone ever published one — so each tab that has a real job carries one or
   * two actions that mean the job was actually done.
   *
   * Deliberately short. Every slug here is a line of wiring somewhere in the
   * panel that has to stay correct, and forty half-maintained counters are
   * worth less than a dozen that are trusted.
   */
  const ACTIONS = [
    // Review — "the analyze feature".
    { slug: 'action:review.session', tab: 'review', label: 'Opened a session' },
    { slug: 'action:review.lap', tab: 'review', label: 'Opened a lap' },
    { slug: 'action:review.compare', tab: 'review', label: 'Compared against another lap' },

    // Setups.
    { slug: 'action:setup.edit', tab: 'setups', label: 'Edited a setup in the garage' },
    { slug: 'action:setup.browse', tab: 'setups', label: 'Browsed shared setups' },
    { slug: 'action:setup.download', tab: 'setups', label: 'Installed a shared setup' },
    { slug: 'action:setup.publish', tab: 'setups', label: 'Published a setup' },

    // Overlays.
    { slug: 'action:overlay.toggle', tab: 'overlays', label: 'Switched an overlay on or off' },
    { slug: 'action:overlay.copy', tab: 'overlays', label: 'Copied an OBS link' },
    { slug: 'action:overlay.ingame', tab: 'overlays', label: 'Turned the in-game layer on' },
    { slug: 'action:overlay.layout', tab: 'overlays', label: 'Laid out the in-game layer' },
    { slug: 'action:overlay.refresh', tab: 'overlays', label: 'Refreshed a frozen in-game layer' },

    // Race engineer.
    { slug: 'action:engineer.ask', tab: 'engineer', label: 'Asked the engineer a question' },
    { slug: 'action:engineer.voice', tab: 'engineer', label: 'Changed the engineer voice' },

    // Fuel & strategy.
    { slug: 'action:fuel.plan', tab: 'fuel', label: 'Built a stint plan' },

    // Team.
    { slug: 'action:team.board', tab: 'team', label: 'Rearranged the widget board' },
    { slug: 'action:team.relay', tab: 'team', label: 'Published to the web pit wall' },

    // Leaderboard.
    { slug: 'action:board.filter', tab: 'leaderboard', label: 'Filtered the board' },
    { slug: 'action:board.compare', tab: 'leaderboard', label: "Opened someone else's lap" },

    // Streamers.
    { slug: 'action:stream.bot', tab: 'streamers', label: 'Turned the chat bot on' },
    { slug: 'action:stream.link', tab: 'streamers', label: 'Linked a Twitch/YouTube account' },

    // Schedule.
    { slug: 'action:schedule.signup', tab: 'schedule', label: 'Opened a race signup' },
    { slug: 'action:schedule.dailies', tab: 'schedule', label: "Read the game's race calendar" },
    { slug: 'action:schedule.remind', tab: 'schedule', label: 'Set a race reminder' },

    // App-wide — not owned by any one tab.
    { slug: 'action:app.guide', tab: null, label: 'Opened a guide or tour' },
    { slug: 'action:app.update', tab: null, label: 'Installed an update' },
    { slug: 'action:app.feedback', tab: null, label: 'Filed a suggestion' },
  ];

  /** `tab:<id>` for every tab, in one place so nothing spells it by hand. */
  function tabSlug(id) {
    return `tab:${String(id || '').toLowerCase()}`;
  }

  /**
   * Display name for a slug, whether or not it is in the catalog. An unknown
   * slug — one from a newer build than the panel reading it — renders as its
   * own name rather than disappearing.
   */
  function labelFor(slug) {
    const s = String(slug || '');
    const tab = TABS.find((t) => tabSlug(t.id) === s);
    if (tab) return tab.label;
    const action = ACTIONS.find((a) => a.slug === s);
    if (action) return action.label;
    return s.replace(/^(tab|action):/, '');
  }

  /** Which tab a slug belongs to, or null for the app-wide ones. */
  function tabFor(slug) {
    const s = String(slug || '');
    const tab = TABS.find((t) => tabSlug(t.id) === s);
    if (tab) return tab.id;
    const action = ACTIONS.find((a) => a.slug === s);
    return action ? action.tab : null;
  }

  /** Every slug the app knows how to report, tabs first. */
  function allSlugs() {
    return [...TABS.map((t) => tabSlug(t.id)), ...ACTIONS.map((a) => a.slug)];
  }

  /**
   * Report one use. THE call site for every panel file — one line, no imports,
   * and it cannot throw.
   *
   *     APEX_FEATURE_CATALOG.note('action:review.lap');
   *
   * Silent when there is no bridge: this file is also loaded by the screenshot
   * harness and by node (the test), and in neither is there a main process to
   * count anything. A counter that is load-bearing is a bug, so the guard is
   * the whole implementation.
   *
   * @param {string} slug
   * @param {object} [opts] `{ uses = 1, seconds = 0 }`
   */
  function note(slug, opts) {
    try {
      const bridge = typeof window !== 'undefined' ? window.apex : null;
      if (bridge && bridge.usage && typeof bridge.usage.feature === 'function') {
        bridge.usage.feature(slug, opts);
      }
    } catch {
      /* never load-bearing */
    }
  }

  return { TABS, ACTIONS, tabSlug, labelFor, tabFor, allSlugs, note };
});
