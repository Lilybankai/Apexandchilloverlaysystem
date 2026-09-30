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

  /* ---- Reading the shared feed ---------------------------------------------
   *
   * schedule_feed_read returns up to three rows:
   *
   *   league          — SimGrid, written by the server job and by members' apps.
   *   dailies         — RaceOS, written by a member's app with the game running.
   *                     The rich copy: classes, race length, setup and tyre
   *                     rules, circuit outlines, and the weekly/special events.
   *   dailies_public  — racecontrol.gg, written by the server job every two
   *                     hours with nobody's game running. The current rotation
   *                     and start times, and little else.
   *
   * The web page and the desktop (with LMU shut) both draw from this, so the
   * choice between the two daily copies lives here, once.
   */

  const WEEK_MS = 7 * 86400000;

  /** Letters only, lower case — for matching names written two ways. */
  function squash(text) {
    return String(text || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  /**
   * Is a RaceOS copy still this week's rotation? LMU changes the circuits at
   * `weekStart` + 7 days. A copy with no weekStart is trusted for a day.
   */
  function appCopyCurrent(payload, fetchedAt, now) {
    const week = Date.parse(payload && payload.weekStart);
    if (Number.isFinite(week)) return now < week + WEEK_MS;
    const at = Date.parse(fetchedAt);
    return Number.isFinite(at) && now - at < 86400000;
  }

  /**
   * The public calendar, with the detail racecontrol.gg does not carry filled
   * in from a RaceOS copy — event by event, never by guesswork:
   *
   *   - rules (classes, race length, setup, tyres, grid size) when the TITLE
   *     matches within the tier: those belong to the series, whatever track it
   *     is at this week;
   *   - the track's proper name and its outline only when the TRACK matches as
   *     well, because a series moves circuit every week.
   */
  function enrichPublic(pub, app) {
    const known = new Map();
    for (const tier of (app && app.tiers) || []) {
      for (const ev of tier.events || []) known.set(`${tier.key}|${squash(ev.title)}`, ev);
    }
    const tiers = (pub.tiers || []).map((tier) => ({
      ...tier,
      events: (tier.events || []).map((ev) => {
        const src = known.get(`${tier.key}|${squash(ev.title)}`);
        if (!src) return ev;
        const out = {
          ...ev,
          seriesId: src.seriesId ?? null,
          classes: Array.isArray(src.classes) ? src.classes : [],
          raceMin: src.raceMin ?? null,
          qualiMin: src.qualiMin ?? null,
          fixedSetup: src.fixedSetup ?? null,
          maxPlayers: src.maxPlayers ?? null,
          tyreSets: src.tyreSets ?? null,
          tyreWarmers: src.tyreWarmers ?? null,
        };
        // The WHOLE public name, less its WEC/ELMS layout tag, must appear in
        // the RaceOS name: "Bahrain WEC" → "bahrain" in "8 Hours of Bahrain",
        // "Road Atlanta" in "Michelin Raceway Road Atlanta". A single word is
        // not enough — "Road" is also in "Daytona … Road Course".
        const key = squash(String(ev.track || '').replace(/\b(WEC|ELMS)\b/gi, ''));
        const sameTrack =
          key.length >= 4 && (squash(src.track).includes(key) || squash(src.scene).includes(key));
        if (sameTrack) {
          out.track = src.track || ev.track;
          out.scene = src.scene ?? null;
          out.map = src.map ?? null;
        }
        return out;
      }),
    }));
    // The dated events only ever come from RaceOS; restoreDailies drops any
    // slot that has already run.
    return { ...pub, tiers, series: (app && app.series) || [] };
  }

  /**
   * The daily calendar to draw from a schedule_feed_read answer, brought up to
   * date — or null when the feed has none. `origin` says which copy won:
   * 'app' (this week's RaceOS copy), 'public' (racecontrol.gg, enriched), or
   * 'stale' (a RaceOS copy from a past week, and nothing fresher).
   */
  function dailiesFromFeed(feed, now) {
    const at = Number.isFinite(now) ? now : Date.now();
    const appRow = feed && feed.dailies && feed.dailies.payload ? feed.dailies : null;
    const pubRow = feed && feed.dailies_public && feed.dailies_public.payload ? feed.dailies_public : null;
    const appCurrent = !!appRow && appCopyCurrent(appRow.payload, appRow.fetched_at, at);

    let row;
    let payload;
    let origin;
    if (appRow && appCurrent) {
      row = appRow;
      payload = appRow.payload;
      origin = 'app';
    } else if (pubRow) {
      row = pubRow;
      payload = enrichPublic(pubRow.payload, appRow && appRow.payload);
      origin = 'public';
    } else if (appRow) {
      row = appRow;
      payload = appRow.payload;
      origin = 'stale';
    } else {
      return null;
    }
    return {
      payload: restoreDailies(payload, at),
      origin,
      fetchedAt: row.fetched_at,
      ageSec: Number(row.age_sec),
    };
  }

  /** The league calendar from a schedule_feed_read answer, or null. */
  function leagueFromFeed(feed, now) {
    const row = feed && feed.league && feed.league.payload ? feed.league : null;
    if (!row) return null;
    return {
      payload: restoreLeague(row.payload, Number.isFinite(now) ? now : Date.now()),
      fetchedAt: row.fetched_at,
      ageSec: Number(row.age_sec),
    };
  }

  return {
    UPCOMING_PER_TIER,
    restoreDailies,
    restoreLeague,
    forPublish,
    enrichPublic,
    dailiesFromFeed,
    leagueFromFeed,
  };
});
