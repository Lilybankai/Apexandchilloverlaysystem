/**
 * schedule-core.js — the Schedule tab's calendar rules that must hold in TWO
 * places: the desktop's main process and the web pit wall's browser bridge.
 * -----------------------------------------------------------------------------
 * The desktop reads both calendars live — the league from SimGrid, the game's
 * dailies from RaceOS through the running game. A browser can do neither
 * (SimGrid sends no CORS headers, and RaceOS wants a Steam ticket that only a
 * running LMU can mint), so the web page reads the calendar a desktop app last
 * PUBLISHED (electron/schedule-cloud.js → public.schedule_feed). That copy can
 * be hours old, and three things have to be true of it wherever it is drawn:
 *
 *   1. restoreDailies — the concrete "next" and "upcoming" instants in a saved
 *      daily calendar are regenerated from the durable rotation pattern
 *      (`minutesUtc`), so a stale copy never counts down to a race that has
 *      already started. Moved here verbatim from electron/lmu-dailies.js,
 *      which still uses it for its own on-disk copy.
 *   2. restoreLeague — the same idea for the league: a round whose start has
 *      passed is done, and the next open round becomes "next".
 *   3. forPublish — what leaves the driver's PC for the shared feed. The
 *      calendar is the same for everyone EXCEPT "you are entered", which is
 *      personal and would otherwise be shown to every member as their own.
 *
 * Loaded as a classic script by the web page (window.APEX_SCHEDULE_CORE) and
 * require()d by the main process and scripts/test-schedule-feed.js — keep it
 * dependency-free and pure: `now` is always passed in.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_SCHEDULE_CORE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** How many starts per tier the "Next up" view carries. */
  const UPCOMING_PER_TIER = 8;

  /**
   * A saved daily calendar, brought up to date.
   *
   * What is durable in a stored payload and what is not:
   *
   *   durable  — the events, their circuits, classes, lengths and tyre rules, and
   *              `minutesUtc`, which is a PATTERN rather than a set of instants
   *              and so is as true tomorrow as it was yesterday.
   *   stale    — `next` and `upcoming`, which are concrete instants generated for
   *              the day it was fetched, and any special slot that has since run.
   *
   * So the stale half is thrown away and regenerated from the durable half. Serve
   * a stored payload without this and the tab cheerfully counts down to a race
   * that started yesterday, which is worse than showing nothing.
   */
  function restoreDailies(payload, now) {
    const at = Number.isFinite(now) ? now : Date.now();
    const tiers = (payload.tiers || []).map((tier) => {
      const upcoming = [];
      for (const ev of tier.events || []) {
        for (const min of ev.minutesUtc || []) {
          /* Three UTC days, filtered — the same reasoning as the calendar: a
             local day straddles two UTC days at any offset but zero. */
          for (let k = 0; k <= 2; k += 1) {
            const d = new Date(at + (k - 1) * 86400000);
            const startOfDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
            const ms = startOfDay + min * 60000;
            if (ms < at) continue;
            upcoming.push({
              seriesId: ev.seriesId,
              title: ev.title,
              track: ev.track,
              scene: ev.scene,
              classes: ev.classes,
              startsAt: new Date(ms).toISOString(),
              registrationOpens:
                ev.registrationLeadMin === null || ev.registrationLeadMin === undefined
                  ? null
                  : new Date(ms - ev.registrationLeadMin * 60000).toISOString(),
              raceMin: ev.raceMin,
              eventMin: ev.eventMin,
              tyreSets: ev.tyreSets,
              tyreWarmers: ev.tyreWarmers,
              fixedSetup: ev.fixedSetup,
              maxPlayers: ev.maxPlayers,
              map: ev.map,
            });
          }
        }
      }
      upcoming.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
      const trimmed = upcoming.slice(0, UPCOMING_PER_TIER);
      return { ...tier, next: trimmed[0] || null, upcoming: trimmed };
    });

    const series = [];
    for (const s of payload.series || []) {
      const slots = (s.slots || []).filter((slot) => Date.parse(slot.startsAt) >= at);
      if (!slots.length) continue; // every slot has run; the series is over
      series.push({ ...s, slots, next: slots[0], registered: slots.some((x) => x.isRegistered) });
    }
    series.sort((a, b) => Date.parse(a.next.startsAt) - Date.parse(b.next.startsAt));

    return { ...payload, tiers, series };
  }

  /**
   * A saved league calendar, brought up to date: the same status rules
   * electron/simgrid.js applies when it reads SimGrid live — a round whose
   * start has passed is done; SimGrid's own "next" stands while it is still
   * ahead; failing that, the first round not yet run is next.
   */
  function restoreLeague(payload, now) {
    const at = Number.isFinite(now) ? now : Date.now();
    const leagues = (payload.leagues || []).map((league) => {
      const races = (league.races || []).map((race) => {
        const startMs = race.startsAt ? Date.parse(race.startsAt) : NaN;
        const done = !!race.ended || (!Number.isNaN(startMs) && startMs < at);
        let status = race.status === 'next' ? 'next' : 'upcoming';
        if (done) status = 'done';
        return { ...race, status };
      });
      if (!races.some((r) => r.status === 'next')) {
        const firstOpen = races.find((r) => r.status === 'upcoming');
        if (firstOpen) firstOpen.status = 'next';
      }
      return { ...league, races, next: races.find((r) => r.status === 'next') || null };
    });
    return { ...payload, leagues };
  }

  /**
   * The copy of a calendar that goes to the shared feed, or null when there is
   * nothing worth sharing.
   *
   * Only a LIVE read is published: a calendar the desktop restored from its own
   * disk says `cached`, and sharing it would let an old copy overwrite a fresh
   * one. The per-driver fields are cleared rather than dropped so the renderer
   * sees the same shape it always does.
   */
  function forPublish(source, payload) {
    if (!payload || payload.ok !== true || payload.cached) return null;
    const copy = JSON.parse(JSON.stringify(payload));
    delete copy.cached;
    delete copy.savedAt;
    delete copy.reason;
    delete copy.error;
    if (source === 'dailies') {
      if (!Array.isArray(copy.tiers) || !copy.tiers.length) return null;
      for (const s of copy.series || []) {
        s.registered = false;
        if (s.next) s.next.isRegistered = false;
        for (const slot of s.slots || []) slot.isRegistered = false;
      }
      return copy;
    }
    if (source === 'league') {
      if (!Array.isArray(copy.leagues) || !copy.leagues.length) return null;
      // A partial read (one championship failed) would replace a complete one.
      if (copy.partial) return null;
      delete copy.partial;
      return copy;
    }
    return null;
  }

  return { UPCOMING_PER_TIER, restoreDailies, restoreLeague, forPublish };
});
