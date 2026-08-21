/**
 * electron/simgrid.js — Apex & Chill championship schedule from SimGrid.
 * -----------------------------------------------------------------------------
 * The control panel's Schedule tab reads two league championships (Thursday
 * and Saturday) from SimGrid's public GridOS API and hands the renderer a
 * sanitised payload: names, times, tracks, and the championship URLs drivers
 * sign up through. The Bearer token never crosses the preload bridge — the
 * renderer only ever sees https://www.thesimgrid.com/… links.
 *
 * Championship ids are the league's own: Thursday 25619, Saturday 24215.
 * Override the key with APEX_SIMGRID_KEY if a build needs a different one.
 *
 * No Electron imports — getSchedule is unit-tested headless.
 */

'use strict';

const API_BASE = 'https://www.thesimgrid.com/api/v1';
const CDN_PREFIX = 'https://cdn.thesimgrid.com/';
const SITE = 'https://www.thesimgrid.com';

/** League championships the Schedule tab shows, in display order. */
const LEAGUES = [
  { id: 25619, day: 'thursday', label: 'Thursday league', hint: 'LMP2 & GT3' },
  { id: 24215, day: 'saturday', label: 'Saturday league', hint: 'GT3' },
];

const CACHE_MS = 5 * 60 * 1000;

let cache = { at: 0, payload: null };

function apiKey() {
  const fromEnv = typeof process.env.APEX_SIMGRID_KEY === 'string'
    ? process.env.APEX_SIMGRID_KEY.trim()
    : '';
  // League GridOS key for the two championships above. Not a user credential.
  return fromEnv || 'PhEDyzEVPztV4yMJYsmQjKWy';
}

function championshipUrl(id) {
  return `${SITE}/championships/${Number(id)}`;
}

function resultsUrl(id) {
  return `${SITE}/championships/${Number(id)}/results`;
}

/** True for an https SimGrid page (or CDN asset) we are willing to open/show. */
function isSimGridUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'www.thesimgrid.com' ||
        u.hostname === 'thesimgrid.com' ||
        u.hostname === 'cdn.thesimgrid.com')
    );
  } catch {
    return false;
  }
}

function safeHttps(url, extraOk) {
  if (typeof url !== 'string' || !url) return null;
  if (isSimGridUrl(url)) return url;
  if (typeof extraOk === 'function' && extraOk(url)) return url;
  return null;
}

function isDiscordUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'discord.gg';
  } catch {
    return false;
  }
}

function cdnPhoto(url) {
  // Only SimGrid's own CDN, and only a URL safe to put in a CSS url("…").
  if (typeof url !== 'string' || !url.startsWith(CDN_PREFIX)) return null;
  if (!/^https:\/\/cdn\.thesimgrid\.com\/[A-Za-z0-9._/-]+$/.test(url)) return null;
  return url;
}

function trackOf(race) {
  const t = race && race.track;
  if (!t || typeof t !== 'object') return { name: 'TBC', photo: null };
  const name = String(t.composite_name || t.name || '').trim() || 'TBC';
  return { name, photo: cdnPhoto(t.photo) };
}

/**
 * One round, with a status the tab can render without re-deriving:
 *   done     — already run (SimGrid says ended, or the start is in the past)
 *   next     — the championship's upcoming_race
 *   upcoming — later than next, not yet run
 */
function raceOf(raw, championshipId, upcomingId, now) {
  const startsAt = raw && raw.starts_at ? String(raw.starts_at) : null;
  const startMs = startsAt ? Date.parse(startsAt) : NaN;
  const ended = !!(raw && raw.ended) || (!Number.isNaN(startMs) && startMs < now);
  const isNext = !ended && raw && raw.id === upcomingId;
  let status = 'upcoming';
  if (ended) status = 'done';
  else if (isNext) status = 'next';
  return {
    id: Number(raw && raw.id) || 0,
    name: String((raw && (raw.display_name || raw.race_name)) || 'Round').trim(),
    startsAt,
    ended,
    status,
    resultsAvailable: !!(raw && raw.results_available),
    track: trackOf(raw),
    signupUrl: championshipUrl(championshipId),
  };
}

function leagueOf(raw, spec, now) {
  const id = Number(raw && raw.id) || spec.id;
  const racesRaw = Array.isArray(raw && raw.races) ? raw.races.slice() : [];
  racesRaw.sort((a, b) => {
    const da = Date.parse(a && a.starts_at) || 0;
    const db = Date.parse(b && b.starts_at) || 0;
    return da - db;
  });
  const upcomingId = raw && raw.upcoming_race && raw.upcoming_race.id;
  const races = racesRaw.map((r) => raceOf(r, id, upcomingId, now));
  // If SimGrid has not labelled an upcoming_race, the first not-done round is next.
  if (!races.some((r) => r.status === 'next')) {
    const firstOpen = races.find((r) => r.status === 'upcoming');
    if (firstOpen) firstOpen.status = 'next';
  }
  const next = races.find((r) => r.status === 'next') || null;
  const spotsTaken = Number(raw && raw.spots_taken);
  const capacity = Number(raw && raw.capacity);
  return {
    id,
    day: spec.day,
    label: spec.label,
    hint: spec.hint,
    name: String((raw && raw.name) || spec.label).trim(),
    game: String((raw && raw.game_name) || 'Le Mans Ultimate'),
    url: safeHttps(raw && raw.url) || championshipUrl(id),
    resultsUrl: safeHttps(raw && raw.results_url) || resultsUrl(id),
    discordUrl: isDiscordUrl(raw && raw.discord_url) ? raw.discord_url : null,
    accepting: !!(raw && raw.accepting_registrations),
    spotsTaken: Number.isFinite(spotsTaken) ? spotsTaken : 0,
    capacity: Number.isFinite(capacity) ? capacity : 0,
    image: cdnPhoto(raw && raw.image),
    next,
    races,
  };
}

async function fetchChampionship(id, key, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/championships/${id}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const err = new Error(`SimGrid championship ${id} returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Load both leagues. Cached for five minutes so switching to the tab is free
 * after the first read; pass `{ force: true }` for the Refresh button.
 *
 * Returns `{ ok, leagues[], fetchedAt, partial?, error? }` — never the key.
 */
async function getSchedule(opts = {}) {
  const force = !!opts.force;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const leagues = Array.isArray(opts.leagues) ? opts.leagues : LEAGUES;

  if (!force && cache.payload && now - cache.at < CACHE_MS) {
    return cache.payload;
  }

  const key = apiKey();
  if (!key) {
    return { ok: false, leagues: [], fetchedAt: null, error: 'SimGrid is not configured on this build.' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, leagues: [], fetchedAt: null, error: 'Could not load the league schedule from SimGrid.' };
  }

  const settled = await Promise.allSettled(
    leagues.map((spec) =>
      fetchChampionship(spec.id, key, fetchImpl).then((raw) => leagueOf(raw, spec, now)),
    ),
  );

  const out = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out.push(r.value);
    else failed.push(leagues[i].label);
  });

  if (!out.length) {
    return {
      ok: false,
      leagues: [],
      fetchedAt: null,
      error: 'Could not load the league schedule from SimGrid.',
    };
  }

  const payload = {
    ok: true,
    fetchedAt: new Date(now).toISOString(),
    leagues: out,
    partial: failed.length > 0,
    error: failed.length ? `Could not load: ${failed.join(', ')}.` : null,
  };
  cache = { at: now, payload };
  return payload;
}

function resetCache() {
  cache = { at: 0, payload: null };
}

module.exports = {
  LEAGUES,
  CACHE_MS,
  championshipUrl,
  resultsUrl,
  isSimGridUrl,
  leagueOf,
  raceOf,
  getSchedule,
  resetCache,
};
