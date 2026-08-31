/**
 * onboarding.js — the Get started checklist on the Dashboard.
 * -----------------------------------------------------------------------------
 * A first-run walkthrough that ticks itself.
 *
 * The app has three walkthroughs already (setup-guide, streamer-guide,
 * bindings-guide) and every one of them is a modal that EXPLAINS a tab. What
 * none of them does is tell a driver who has just installed the thing what
 * order to do anything in, or say when a step is actually finished. The
 * questions the Discord launch keeps producing are not "what does this tab
 * do" — they are "have I set it up right?" and "why is everything blank?",
 * and both have the same answer: the telemetry plugin, the two kinds of
 * bindings, and getting one overlay onto a screen.
 *
 * So this is a checklist, not a tour. Seven rows, each one:
 *
 *   - says what it is for in a sentence,
 *   - TICKS ITSELF from state the panel already has, and
 *   - launches a guided tour of that section when you click it (tour.js),
 *     which walks its controls one at a time with the page still live.
 *
 * The self-ticking is the whole point, and it is why this is worth building
 * rather than recording a video. Every one of these facts is already known to
 * the app — plugin:status has a verdict, lmuBind:plan counts what is still
 * unbound, settings carries the bindings, the in-game switch and the saved
 * layout — so the checklist can be honest instead of asking "did you do it?".
 * A video can only ever tell someone what to do; this tells them what is left.
 *
 * Two of the seven cannot be observed and are recorded as intent instead:
 * copying an overlay URL (OBS is another program — there is nothing to see
 * from in here) and whether anything has been laid out. The first is noted in
 * localStorage by the thing that does it, which is why `copiedOverlayUrl()` is
 * exported for control-panel.js to call.
 *
 * Manners, same as the other guides: it is dismissible, dismissing sticks, and
 * it is never a modal — it sits at the top of the Dashboard, above the stats,
 * and says so when it is finished. A driver who ignores it loses nothing.
 *
 * Classic script (window.APEX_ONBOARDING) + module.exports, so STEPS and the
 * pure `evaluate()` can be required and asserted with no browser at all —
 * scripts/test-onboarding.js does exactly that.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_ONBOARDING = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /**
   * Bumping this brings the checklist back for everyone who dismissed it,
   * once. Worth doing when a step is ADDED — someone who finished the old list
   * has not done the new thing and has no way to find that out. Not worth
   * doing for wording.
   */
  const LIST_VERSION = '1';

  const DISMISS_KEY = 'apex.onboarding.dismissed';
  /** Set by the panel's copy buttons — see copiedOverlayUrl(). */
  const COPIED_KEY = 'apex.onboarding.copiedUrl';

  /**
   * How long to wait before asking main for the three states that need IPC
   * (plugin, LMU bindings, engineer). Nothing here is urgent and the Dashboard
   * has a lap chart and a rank card to paint first. Doubles as a debounce: the
   * settings feed pushes a whole object on every toggle.
   */
  const REFRESH_DELAY_MS = 250;

  /**
   * The list. Order is the order someone should actually do them in, which is
   * roughly "nothing works without this" first:
   *
   *   plugin      — with this wrong, EVERY overlay is blank and nothing says why
   *   lmu-keys    — without it the app cannot press the sim's own buttons
   *   bindings    — the driver's own buttons: what they press mid-stint
   *   on-screen   — one overlay visible, in game or in OBS
   *   layout      — where the widgets sit
   *   engineer    — the voice, last because it is genuinely optional
   *
   * `check` is pure and takes the bundle built by readState(); `note` returns
   * a sentence when a row cannot be finished on this PC right now (no LMU
   * installed, game running, no voice downloaded) so a permanently-unticked
   * row is never a mystery. `focus` is the card the row scrolls to and pulses,
   * written with its `#` so the parity guard sees it as an id being looked up
   * and refuses to let anyone rename it out from under us.
   */
  const STEPS = [
    {
      id: 'plugin',
      icon: 'activity',
      title: 'Let the sim talk to Apex',
      lead:
        'Le Mans Ultimate publishes no telemetry until a small plugin is installed and switched on. ' +
        'Apex does both for you — this is where you see that it worked.',
      cta: 'Check it',
      view: 'settings',
      pane: 'general',
      focus: '#plugin-card',
      tour: 'settings',
      check: (s) => s.plugin === 'ok',
      note: (s) =>
        s.plugin === 'no-lmu'
          ? 'Le Mans Ultimate was not found on this PC, so there is nothing to install into.'
          : s.plugin === 'missing-runtime'
            ? 'The plugin is installed but Windows cannot load it — one runtime is missing, and the card has the download.'
            : null,
    },
    {
      id: 'lmu-keys',
      icon: 'circuit',
      title: "Give the sim's own controls a key",
      lead:
        'Pit limiter, MFD pages, fuel and tyre changes — Apex can only press what LMU has bound to a KEY, ' +
        'and a wheel button cannot be pressed from outside the game. One click binds the missing ones.',
      cta: 'Bind them',
      view: 'settings',
      pane: 'controls',
      focus: '#lmu-controls-card',
      tour: 'settings',
      check: (s) => s.lmuKeysKnown && s.lmuKeysToBind === 0,
      note: (s) =>
        !s.lmuKeysKnown
          ? "LMU's controls file was not found — launch the game once, then come back."
          : s.lmuRunning && s.lmuKeysToBind > 0
            ? 'Close Le Mans Ultimate first: it rewrites its controls file on exit and would throw the change away.'
            : null,
    },
    {
      id: 'bindings',
      icon: 'keyboard',
      title: 'Bind your own buttons',
      lead:
        'The keys YOU press mid-stint — ask the engineer, call your last lap, show the gap ahead. ' +
        'They fire while the sim has focus, and a Stream Deck button set to the same key works too.',
      cta: 'Bind a key',
      view: 'settings',
      pane: 'controls',
      focus: '#bindings-card',
      tour: 'settings',
      guide: 'APEX_BINDINGS_GUIDE',
      check: (s) => s.boundActions > 0,
      note: null,
    },
    {
      id: 'on-screen',
      icon: 'monitor',
      title: 'Get an overlay on screen',
      lead:
        'Every overlay is already switched on. Now it needs somewhere to go: over the sim itself with ' +
        'Show in game, or into OBS as a Browser Source with the Copy button. Both is fine.',
      cta: 'Show me',
      view: 'overlays',
      focus: '#overlay-list',
      tour: 'overlays',
      check: (s) => s.ingameEnabled || s.copiedUrl,
      note: null,
    },
    {
      id: 'layout',
      icon: 'move-vertical',
      title: 'Put the widgets where you want them',
      lead:
        'The overlay hotkey cycles shown → off → edit layout, so you can move a widget without leaving ' +
        'the car. On triples, drag one onto a side monitor and it stays there.',
      cta: 'Lay it out',
      view: 'dashboard',
      focus: '#ig-edit-btn',
      tour: 'ingame',
      check: (s) => s.laidOut,
      note: (s) =>
        !s.ingameEnabled
          ? 'Switch Show in game on first — this lays out the in-game layer, not your OBS sources.'
          : null,
    },
    {
      id: 'engineer',
      icon: 'mic',
      title: 'Meet your race engineer',
      lead:
        'A voice on the radio that answers questions from your own telemetry — fuel, gaps, tyres, ' +
        'what the last lap cost you. Pick a voice, download it, switch it on.',
      cta: 'Set it up',
      view: 'engineer',
      focus: '#eng-voices',
      tour: 'engineer',
      check: (s) => s.engineerReady,
      note: (s) =>
        s.engineerKnown && !s.engineerVoiceInstalled
          ? 'No voice downloaded yet — the Engineer tab has them, and it is a one-off download.'
          : null,
    },
    {
      id: 'setups',
      icon: 'sliders-horizontal',
      title: 'Learn the setup screen',
      lead:
        'A live two-way editor for the car the sim is holding right now — every page the game has, ' +
        'plus your own library and setups other drivers have published.',
      cta: 'Show me round',
      view: 'setups',
      focus: '#setup-status',
      tour: 'setups',
      // The one row that cannot be measured from state, so it asks the honest
      // question instead: has this driver been walked round the tab? The tab is
      // useful with nothing saved and nothing downloaded, so "have you got a
      // setup in your library" would nag people who are using it correctly.
      check: (s) => s.setupsToured,
      note: (s) =>
        !s.setupsToured
          ? 'Two minutes, and it covers the one thing that surprises everybody: nothing reaches the car until Apply.'
          : null,
    },
    {
      id: 'team',
      icon: 'users',
      title: 'Set up your pit wall',
      lead:
        'One board of live widgets for a team endurance race — and the three things every '
        + 'team-mate has to have before the pit wall can see their car.',
      cta: 'Show me round',
      view: 'team',
      focus: '#team-dash',
      tour: 'team',
      // Beta-gated, like the tab itself. A row nagging about a page that is
      // not in this build is the exact failure `note` exists to avoid, and no
      // note can fix it — there is nothing the driver could do. So the row is
      // not on the list at all until the tab is.
      gate: (s) => s.teamTabAvailable,
      // Same honest question as the Setups row: this cannot be measured from
      // state, because a crew of one with the board arranged is a correct
      // outcome and so is a crew of six.
      check: (s) => s.teamToured,
      note: (s) =>
        !s.teamToured
          ? 'Worth two minutes before an endurance race: every team-mate needs their own subscription and has to be running Apex while they drive.'
          : null,
    },
  ];

  /* ---- pure: state -> ticks ---------------------------------------------- */

  /**
   * Turn the raw state bundle into what the card paints. Pure, and exported:
   * every predicate above is a claim about how this app works, and a claim
   * like that is worth a test rather than a manual re-check on a rig.
   */
  function evaluate(state) {
    const s = state || {};
    const rows = STEPS.filter((step) => !step.gate || step.gate(s)).map((step) => ({
      id: step.id,
      icon: step.icon,
      title: step.title,
      lead: step.lead,
      cta: step.cta,
      done: !!step.check(s),
      note: (step.note && step.note(s)) || null,
    }));
    const done = rows.filter((r) => r.done).length;
    return { rows, done, total: rows.length, complete: done === rows.length };
  }

  /* ---- flags in storage --------------------------------------------------- */

  /**
   * With storage unavailable this reports "dismissed": a card that cannot
   * remember being put away would come back on every single launch, which is
   * worse than never appearing at all.
   */
  function dismissed() {
    try {
      return localStorage.getItem(DISMISS_KEY) === LIST_VERSION;
    } catch {
      return true;
    }
  }

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, LIST_VERSION);
    } catch {
      /* storage disabled — it just comes back next launch */
    }
  }

  /**
   * The other half of dismiss(). Storage refusing to forget is survivable:
   * restore() un-hides the card directly, so the way back works either way —
   * it just does not outlive the session.
   */
  function undismiss() {
    try {
      localStorage.removeItem(DISMISS_KEY);
    } catch {
      /* storage disabled — the card still comes back for this session */
    }
  }

  /**
   * Called by control-panel.js whenever an overlay URL is copied. OBS is a
   * different program: there is no way to observe a Browser Source being
   * added, and the copy is the last moment this app is involved. Recording the
   * intent is the honest version of that step — it claims "you took the URL",
   * not "OBS is configured", and the row's wording matches.
   */
  function copiedOverlayUrl() {
    try {
      localStorage.setItem(COPIED_KEY, '1');
    } catch {
      /* storage disabled — the row just stays unticked */
    }
    schedule();
  }

  function hasCopied() {
    try {
      return localStorage.getItem(COPIED_KEY) === '1';
    } catch {
      return false;
    }
  }

  /* ---- reading the app ---------------------------------------------------- */

  /**
   * Everything the checklist needs: the settings the panel already holds, plus
   * four IPC calls. Each is guarded on its own — a build with no dist/ present
   * answers `{ ok: false }` to the plugin and binder calls, and a checklist
   * that threw on that would take the whole Dashboard render down with it.
   * Every failure path leaves its row UNTICKED, which is the safe read: an
   * unticked row invites a look, a wrongly ticked one hides a dead feature.
   */
  async function readState(settings) {
    let st = settings;
    // No settings handed over yet. This is the ordinary case on the first
    // paint, not an error: the panel's own boot is a promise, and a promise
    // that resolves as a microtask can land BEFORE the later <script> tags on
    // the page have even run. Asking for them here rather than waiting to be
    // told is what makes this file independent of that race.
    if (!st) {
      try {
        const s = await window.apex.getState();
        st = (s && s.settings) || {};
        settingsCache = st;
      } catch {
        st = {};
      }
    }
    const state = {
      plugin: 'unknown',
      lmuKeysKnown: false,
      lmuKeysToBind: 0,
      lmuRunning: false,
      boundActions: 0,
      ingameEnabled: !!st.ingameEnabled,
      copiedUrl: hasCopied(),
      laidOut: Object.keys(st.ingameLayout || {}).length > 0,
      engineerKnown: false,
      engineerVoiceInstalled: false,
      engineerReady: false,
      // The Setups row. Read straight off the tour's seen flag rather than
      // kept twice — one fact, one owner.
      setupsToured: !!(typeof window !== 'undefined' && window.APEX_TOUR?.hasSeen('setups')),
      teamToured: !!(typeof window !== 'undefined' && window.APEX_TOUR?.hasSeen('team')),
      // Whether this build HAS a Team tab. The nav button's `hidden` is the
      // one owner of that fact (control-panel.js applyTeamTabVisibility), so
      // it is read rather than duplicated as a second channel check.
      teamTabAvailable:
        typeof document !== 'undefined'
        && !!document.querySelector('[data-tab="team"]')
        && !document.querySelector('[data-tab="team"]').hidden,
    };

    const apex = typeof window !== 'undefined' ? window.apex : null;
    if (!apex) return state;

    try {
      const p = await apex.pluginStatus();
      if (p && p.ok !== false && p.verdict) state.plugin = p.verdict;
    } catch {
      /* leaves 'unknown' */
    }

    try {
      const plan = await apex.lmuBindPlan();
      if (plan && plan.ok !== false && plan.path) {
        state.lmuKeysKnown = true;
        state.lmuKeysToBind = Number(plan.toBind) || 0;
        state.lmuRunning = !!plan.lmuRunning;
      }
    } catch {
      /* row keeps the "launch the game once" note */
    }

    try {
      const actions = await apex.actionsList();
      if (Array.isArray(actions)) {
        state.boundActions = actions.filter((a) => a && (a.binding || a.wheel)).length;
      }
    } catch {
      /* unticked */
    }

    try {
      const e = await apex.engineerStatus();
      if (e) {
        state.engineerKnown = true;
        state.engineerVoiceInstalled = !!e.selectedInstalled;
        state.engineerReady = !!(e.enabled && e.engineInstalled && e.selectedInstalled);
      }
    } catch {
      /* unticked */
    }

    return state;
  }

  /* ---- DOM ---------------------------------------------------------------- */

  const SVG_NS = 'http://www.w3.org/2000/svg';

  let els = null;
  let settingsCache = null;
  let refreshTimer = null;
  let pending = false;
  let started = false;
  let wiredReopen = false;

  function lookup() {
    if (els) return els;
    const root = document.getElementById('onboard-card');
    if (!root) return null;
    els = {
      root,
      count: document.getElementById('onboard-count'),
      bar: document.getElementById('onboard-bar'),
      list: document.getElementById('onboard-list'),
      tour: document.getElementById('onboard-tour'),
      hide: document.getElementById('onboard-hide'),
      done: document.getElementById('onboard-done'),
      reopen: document.getElementById('onboard-reopen'),
    };
    return els;
  }

  /**
   * A sprite icon built as an element tree rather than parsed markup, for the
   * same reason setup-guide.js does it longhand: a quoted sprite selector in
   * this file would read to the parity guard as a page id being looked up.
   */
  function iconEl(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  /** Text nodes only — none of this comes from a file or from the network. */
  function paint(result) {
    const e = lookup();
    if (!e) return;

    e.count.textContent = `${result.done} of ${result.total} done`;
    e.bar.style.width = `${Math.round((result.done / result.total) * 100)}%`;
    e.done.hidden = !result.complete;

    e.list.textContent = '';
    for (const row of result.rows) {
      const step = STEPS.find((s) => s.id === row.id);
      const li = document.createElement('li');
      li.className = 'obrow';
      li.dataset.done = String(row.done);
      li.dataset.step = row.id;

      const mark = document.createElement('span');
      mark.className = 'obrow__mark';
      mark.appendChild(iconEl(row.done ? 'check' : row.icon));
      li.appendChild(mark);

      const body = document.createElement('span');
      body.className = 'obrow__body';
      const title = document.createElement('span');
      title.className = 'obrow__title';
      title.textContent = row.title;
      body.appendChild(title);
      const lead = document.createElement('span');
      lead.className = 'obrow__lead';
      lead.textContent = row.lead;
      body.appendChild(lead);
      if (row.note) {
        const note = document.createElement('span');
        note.className = 'obrow__note';
        note.textContent = row.note;
        body.appendChild(note);
      }
      li.appendChild(body);

      // A done row keeps its button. "Done" here is the state right now, not a
      // trophy: someone who wants to change a binding should not have to go
      // and find the card by hand just because the row stopped nagging.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = row.done ? 'btn btn--ghost btn--sm' : 'btn btn--accent btn--sm';
      btn.textContent = row.done ? 'Open' : step.cta;
      btn.addEventListener('click', () => goTo(step));
      li.appendChild(btn);

      e.list.appendChild(li);
    }
  }

  /**
   * Take the driver to the thing the row is about: the right tab, the right
   * settings pane, the card scrolled into view and pulsed once so the eye
   * lands on it, and the tab's own walkthrough opened where one exists.
   *
   * Navigation goes through the panel's own router (window.apexNav) rather
   * than clicking the tab button, so the router's per-tab work — shown(), the
   * refreshes, the remembered tab — all happens exactly as it would have.
   */
  function goTo(step) {
    // The tour IS the answer to "how do I do this?" — it walks the section's
    // controls one at a time with the page still live underneath, which is
    // what someone clicking a row they have not done actually wants. It
    // navigates for itself, so nothing here has to.
    const tour = typeof window !== 'undefined' ? window.APEX_TOUR : null;
    if (step.tour && tour && typeof tour.start === 'function') {
      tour.start(step.tour);
      return;
    }

    // Fallback for a row with no tour: go there and light the card up.
    const nav = typeof window !== 'undefined' ? window.apexNav : null;
    if (nav && typeof nav.showView === 'function') nav.showView(step.view);
    if (step.pane && nav && typeof nav.showSettingsPane === 'function') {
      nav.showSettingsPane(step.pane);
    }

    // After the view swap, so the target is laid out and can be scrolled to.
    setTimeout(() => {
      const target = step.focus ? document.querySelector(step.focus) : null;
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.setAttribute('data-pulse', 'true');
        setTimeout(() => target.removeAttribute('data-pulse'), 2000);
      }
    }, 60);
  }

  /** The header button: every tour, end to end, in checklist order. */
  function runFullTour() {
    const tour = typeof window !== 'undefined' ? window.APEX_TOUR : null;
    if (tour && typeof tour.start === 'function') tour.start('all');
  }

  /* ---- refresh ------------------------------------------------------------ */

  /**
   * Re-read and repaint. Cheap to call: concurrent calls collapse, and the
   * card is hidden outright for anyone who has dismissed it, so none of the
   * IPC below runs for the people it no longer applies to.
   */
  async function refresh() {
    const e = lookup();
    if (!e || e.root.hidden || pending) return;
    pending = true;
    try {
      paint(evaluate(await readState(settingsCache)));
    } finally {
      pending = false;
    }
  }

  function schedule() {
    const e = lookup();
    if (!e || e.root.hidden) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, REFRESH_DELAY_MS);
  }

  /** Settings changed (from any window) — the ticks may have moved with them. */
  function onSettings(settings) {
    settingsCache = settings;
    schedule();
  }

  /** Called by the tab router on every arrival at the Dashboard. */
  function shown() {
    schedule();
  }

  function hide() {
    const e = lookup();
    if (!e) return;
    e.root.hidden = true;
    dismiss();
    syncReopen();
  }

  /**
   * The header button is the exact inverse of the card: it exists to bring
   * the checklist back, so it has nothing to say while the checklist is up.
   */
  function syncReopen() {
    const e = lookup();
    if (!e || !e.reopen) return;
    e.reopen.hidden = !e.root.hidden;
  }

  /**
   * Bring the card back — the Dashboard's Get started button. Hiding it is
   * the only way to lose the five tours, which have no other entry point, so
   * this undoes that completely: the flag goes, the card returns, and it
   * pulses once so the eye lands on what just appeared further down the page.
   */
  function restore() {
    const e = lookup();
    if (!e) return;
    undismiss();
    // start() wires the card's own buttons the first time through and returns
    // early ever after, so the un-hide below is not left to it.
    start();
    e.root.hidden = false;
    syncReopen();
    e.root.scrollIntoView({ block: 'center', behavior: 'smooth' });
    e.root.setAttribute('data-pulse', 'true');
    setTimeout(() => e.root.removeAttribute('data-pulse'), 2000);
    schedule();
  }

  /* ---- wiring ------------------------------------------------------------- */

  /**
   * The card is in the markup but starts hidden, and only ever un-hides for
   * someone who has not dismissed it. Deciding that here rather than in the
   * page means a returning driver never sees it flash up on the first frame.
   *
   * Idempotent, and it has to be: this runs itself on load AND is called again
   * by the panel's boot with fresher settings. A second pass must not leave
   * two listeners on Hide this.
   */
  function start(settings) {
    const e = lookup();
    if (!e) return;
    if (settings) settingsCache = settings;
    // Wired ahead of the guard below, and only once: this button exists for
    // exactly the people that guard turns away.
    if (!wiredReopen && e.reopen) {
      wiredReopen = true;
      e.reopen.addEventListener('click', restore);
    }
    if (dismissed()) {
      syncReopen();
      return;
    }
    if (!started) {
      started = true;
      e.root.hidden = false;
      e.hide.addEventListener('click', hide);
      e.tour.addEventListener('click', runFullTour);
    }
    syncReopen();
    schedule();
  }

  if (typeof document !== 'undefined') {
    // This script is the last one on the page, so everything it wires already
    // exists — no DOMContentLoaded dance, same as setup-guide.js.
    //
    // Starting ITSELF rather than waiting to be started is deliberate. The
    // panel's boot hands settings over through the same function, but that
    // call rides a promise, and a promise resolved as a microtask can run
    // before this file has been parsed at all. Owning the start means the card
    // appears whether or not that race goes our way; the hand-off is then only
    // an optimisation, saving one round-trip for the settings.
    start();
  }

  return {
    STEPS,
    LIST_VERSION,
    DISMISS_KEY,
    COPIED_KEY,
    evaluate,
    init: start,
    shown,
    refresh,
    onSettings,
    copiedOverlayUrl,
    runFullTour,
    hasCopied,
    dismissed,
    hide,
    undismiss,
    restore,
  };
});
