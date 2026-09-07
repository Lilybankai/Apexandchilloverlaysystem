/**
 * web-shell.js — the frame around the board on the web.
 * -----------------------------------------------------------------------------
 * The desktop's control-panel.js is 6,000 lines of tabs the web pit wall does
 * not have. What the Team tab actually needs from it is small: the account
 * pill and its sign-out button, the temperature unit, the entitlement gate,
 * and the two calls the tab router makes when the Team view becomes active.
 * That is this file. Everything on the board itself is team-panel.js,
 * unchanged.
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
    window.apexTeam?.shown();
    window.APEX_TEAM_GUIDE?.maybeAutoOpen();

    // A remembered session may carry a stale user object (a display name
    // changed on another device); refresh it in the background.
    void api.auth.restore().then(renderAccount);

    const b = await api.billing.status();
    if (b && b.entitled === false && !b.unknown) {
      window.apexTeam?.hidden();
      location.replace(web.AUTH_PAGE);
    }
  }

  void boot();
})();
