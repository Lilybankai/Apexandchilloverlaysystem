/**
 * web-shell.js — the frame around the board on the web.
 * -----------------------------------------------------------------------------
 * The desktop's control-panel.js is 6,000 lines of tabs the web pit wall does
 * not have. What the Team tab actually needs from it is small: the account
 * pill and its sign-out button, the temperature unit, the entitlement gate,
 * and the calls the tab router makes when a view becomes active — the web has
 * two, the Team board and the Schedule tab. That is this file. Everything on
 * the screens themselves is team-panel.js and schedule-panel.js, unchanged.
 */

(function () {
  'use strict';

  const api = window.apex;
  const web = window.APEX_WEB;
  if (!api || !web) return;

  const $ = (sel) => document.querySelector(sel);

  /* ---- account pill -------------------------------------------------------- */

  function renderAccount(state) {
    const user = state && state.user;
    const signedIn = !!(state && state.signedIn && user);
    const account = $('#account');
    if (account) account.hidden = !signedIn;
    if (!signedIn) return;
    $('#account-initials').textContent = user.initials;
    $('#account-name').textContent = user.displayName;
    $('#account-email').textContent = user.email;
  }

  const signOutBtn = $('#signout-btn');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      signOutBtn.disabled = true;
      try {
        await api.auth.signOut();
      } finally {
        location.replace(web.AUTH_PAGE);
      }
    });
  }

  /* ---- temperature unit ---------------------------------------------------- */

  const unitSeg = $('#web-temp-unit');
  function paintUnit(settings) {
    if (!unitSeg) return;
    const unit = settings && settings.tempUnit === 'f' ? 'f' : 'c';
    for (const btn of unitSeg.querySelectorAll('[data-unit]')) {
      btn.setAttribute('data-active', String(btn.dataset.unit === unit));
    }
  }
  if (unitSeg) {
    unitSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-unit]');
      if (btn) void api.updateSettings({ tempUnit: btn.dataset.unit });
    });
    api.onSettings(paintUnit);
  }

  /* ---- demo badge ---------------------------------------------------------- */

  const demoPill = $('#web-demo');
  if (demoPill) demoPill.hidden = !web.DEMO;

  /* ---- which screen -------------------------------------------------------- */
  /*
   * Two screens, the desktop's Team and Schedule tabs, switched the way the
   * desktop's tab router switches them: flip data-active on the sections and
   * tell each panel it was shown or hidden. That call is not a courtesy — the
   * pit wall polls its relays once a second while shown, and a driver reading
   * the calendar should not be paying for a board they cannot see.
   *
   * The choice lives in the URL (#schedule) so a link to the calendar opens on
   * the calendar, and in localStorage so a returning visitor lands where they
   * left off.
   */
  const VIEW_KEY = 'apex.web.view';
  const viewNav = $('#web-view');
  let view = null;

  function initialView() {
    if (location.hash === '#schedule') return 'schedule';
    if (location.hash === '#pitwall') return 'team';
    try {
      return localStorage.getItem(VIEW_KEY) === 'schedule' ? 'schedule' : 'team';
    } catch {
      return 'team';
    }
  }

  function showView(next) {
    const target = next === 'schedule' ? 'schedule' : 'team';
    if (target === view) return;
    view = target;
    for (const section of document.querySelectorAll('.content > .view[data-view]')) {
      section.setAttribute('data-active', String(section.dataset.view === view));
    }
    if (viewNav) {
      for (const btn of viewNav.querySelectorAll('[data-webview]')) {
        btn.setAttribute('data-active', String(btn.dataset.webview === view));
      }
    }
    // The strip's °C/°F belongs to the pit wall; web.css hides it on Schedule.
    document.body.dataset.webview = view;

    if (view === 'team') {
      window.apexTeam?.shown();
      window.APEX_TEAM_GUIDE?.maybeAutoOpen();
    } else {
      window.apexTeam?.hidden();
      window.APEX_TEAM_GUIDE?.cancelAutoOpen?.();
      window.apexSchedule?.shown();
    }
    // Starts or stops the countdown tick — in both directions.
    window.apexSchedule?.sync();

    const hash = view === 'schedule' ? '#schedule' : '';
    if (location.hash !== hash) {
      history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
    }
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* storage disabled */
    }
    window.scrollTo(0, 0);
  }

  if (viewNav) {
    viewNav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-webview]');
      if (btn) showView(btn.dataset.webview);
    });
  }

  /* ---- boot ---------------------------------------------------------------- */

  async function boot() {
    const state = await api.auth.getState();
    if (!state.signedIn) {
      location.replace(web.AUTH_PAGE);
      return;
    }
    renderAccount(state);
    api.auth.onChange(renderAccount);
    api.getState().then((s) => paintUnit(s.settings)).catch(() => {});

    // The board first, then the gate: an entitled driver should see the pit
    // wall the moment the page loads rather than after a round trip, and an
    // unentitled one is walked back to the subscribe screen when the answer
    // arrives. A check that fails outright (offline) keeps the board — the
    // desktop grants the same grace.
    showView(initialView());

    // A remembered session may carry a stale user object (a display name
    // changed on another device); refresh it in the background.
    void api.auth.restore().then(renderAccount);

    const b = await api.billing.status();
    if (b && b.entitled === false && !b.unknown) {
      window.apexTeam?.hidden();
      location.replace(web.AUTH_PAGE);
    }
  }

  // A #schedule / #pitwall link followed while the page is already open.
  window.addEventListener('hashchange', () => showView(initialView()));

  void boot();
})();
