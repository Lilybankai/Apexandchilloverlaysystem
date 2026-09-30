/**
 * racelog-panel.js — the Race log tab.
 * -----------------------------------------------------------------------------
 * docs/RACE-LOG-PLAN.md. Every race Le Mans Ultimate saved a results file for,
 * in a rail on the left, and the one picked as a timeline on the right.
 * review-racelog.js paints both; this file is the tab around them: it finds
 * the page, hands the columns over, and starts and stops things with the tab.
 *
 * ## Why its own tab
 * Until 2026-09-30 the races sat behind a Sessions | Races switch in the
 * Review tab's rail, and drivers did not find them. Carl moved them into the
 * rail's Driving group, under Review. The look is Review's on purpose — the
 * same two columns, the same `rv-*` classes — but the host is this file and
 * the ids are its own, so neither tab borrows the other's columns or state.
 *
 * ## Zero cost when hidden
 * The router in control-panel.js calls `shown()` on arrival and `hidden()` on
 * the way out, the Review tab's contract. Nothing is listed and nothing asks
 * the game anything until the tab is looked at: arriving lists the results
 * files (main caches them by mtime, so after the first visit it is a
 * directory listing) and resumes the replay push for an open race; leaving
 * drops the push.
 *
 * `openRace(id)` is the way in from elsewhere — Review's "Race log" button on
 * a race session. It switches tabs through the router, so arrival happens the
 * usual way, and lands on that race instead of the newest.
 */

(function () {
  'use strict';

  const RL = window.APEX_REVIEW_RACELOG;
  if (!RL) return;

  const $ = (sel) => document.querySelector(sel);

  const els = { view: null, search: null, list: null, detail: null };
  let ready = false;
  let visible = false;
  /** A race asked for by `openRace()` before the tab was on screen. */
  let pendingId = null;

  function renderList() {
    if (els.list) els.list.innerHTML = RL.listHtml(els.search ? els.search.value : '');
  }

  /** Land on the newest race, as Review lands on the newest session. */
  async function openNewest() {
    if (!RL.races().length) await RL.load();
    if (!visible || RL.openId()) return;
    const first = RL.races()[0];
    if (first) await RL.open(first.id);
    else RL.render();
  }

  /** Nothing is being typed and nothing is open over the tab. */
  function keysAreOurs(evt) {
    const t = evt.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return false;
    return !document.querySelector(
      '.su-guide:not([hidden]), .sheet:not([hidden]), .su-pop:not([hidden]), .tour:not([hidden])',
    );
  }

  /**
   * Find the page and wire it. Idempotent, and called from two places — see
   * the note on the same function in review-panel.js: the router's first
   * showView() runs before this file is parsed, so shown() initialises on
   * demand and DOMContentLoaded finds it done.
   */
  function init() {
    if (ready) return;
    els.view = $('[data-view="racelog"]');
    if (!els.view) return;
    els.search = $('#rl-search');
    els.list = $('#rl-races');
    els.detail = $('#rl-detail');
    RL.mount({ detail: els.detail, rerenderList: renderList });

    if (els.search) els.search.addEventListener('input', renderList);
    if (els.list) {
      els.list.addEventListener('click', (evt) => {
        const race = evt.target.closest('[data-race]');
        if (race) void RL.open(race.dataset.race);
      });
    }
    if (els.detail) {
      els.detail.addEventListener('click', (evt) => RL.onClick(evt));
      // The picker's rows are buttons, so they answer Enter and Space.
      els.detail.addEventListener('keydown', (evt) => RL.onKey(evt));
    }
    // The timeline's keys: ↑ ↓ / J K, Enter, [ and ]. On the document, so they
    // work wherever focus is on the tab, and only while the tab is on screen.
    document.addEventListener('keydown', (evt) => {
      if (!visible || evt.defaultPrevented || !keysAreOurs(evt)) return;
      RL.onDocKey(evt);
    });
    window.addEventListener('resize', () => { if (visible) RL.repaint(); });

    const refresh = $('#rl-refresh');
    if (refresh) {
      refresh.addEventListener('click', () => {
        void RL.load().then(() => {
          const id = RL.openId();
          if (id && RL.races().some((r) => r.id === id)) void RL.open(id);
          else void openNewest();
        });
      });
    }
    ready = true;

    // The launch that opens ON this tab: the router's shown() call came
    // before this file existed, so make it now.
    if (els.view.getAttribute('data-active') === 'true') window.apexRaceLog.shown();
  }

  window.apexRaceLog = {
    /** The router calls this on arrival. */
    shown() {
      init();
      if (!ready) return;
      visible = true;
      RL.shown();
      // The read first, so the page says "Reading…" rather than "No races
      // yet" while it runs.
      const races = RL.load();
      const want = pendingId;
      pendingId = null;
      if (want) {
        renderList();
        void RL.open(want);
        return;
      }
      // A race already open is left as it is, scrolled where the driver left
      // it; otherwise the "Reading…" page until the list lands on the newest.
      if (!RL.openId()) {
        renderList();
        RL.render();
      }
      void races.then(() => {
        if (visible && !RL.openId()) void openNewest();
      });
    },
    /** …and this on the way out. Nothing on this tab runs while it is hidden. */
    hidden() {
      visible = false;
      RL.hidden();
    },
    /**
     * Open one race on this tab — Review's "Race log" button. Through the
     * router, so the tab's arrival work happens exactly as a click on the
     * rail would do it.
     */
    openRace(id) {
      if (!id) return;
      if (visible) {
        void RL.open(id);
        return;
      }
      pendingId = id;
      if (window.apexNav) window.apexNav.showView('racelog');
      else window.apexRaceLog.shown();
    },
  };

  // Last, so init()'s catch-up above has window.apexRaceLog to call.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
