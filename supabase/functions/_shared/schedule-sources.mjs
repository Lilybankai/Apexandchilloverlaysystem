/**
 * schedule-sources.mjs — the Schedule tab's two calendars, read by a SERVER.
 * -----------------------------------------------------------------------------
 * Used by supabase/functions/schedule-refresh (Deno) and by
 * scripts/test-schedule-sources.js (Node), which is why it is plain JavaScript
 * with no imports: both runtimes load it as it is.
 *
 * ## Daily races — racecontrol.gg
 *
 * The game's own service (raceos.gg) answers 401 to anything without a Steam
 * ticket from a running copy of LMU, so no server can read it. RaceControl
 * (racecontrol.gg — S397's site, built by SimGrid) renders the same daily
 * rotation into its public home page: per card the tier, the event name, the
 * whole-event duration, the track and every remaining start TODAY, in UTC
 * ("30 Sep at 11:45am"). That is enough to rebuild the day's pattern, because
 * each event's starts are evenly spaced and the spacing divides a day
 * (45/60/90 minutes — see electron/lmu-dailies.js).
 *
 * It carries less than RaceOS: no car classes, no race-vs-event length, no
 * setup/tyre rules, no weekly or special events, and track names in the
 * content's own words ("Portimao Wec 2023"). control-panel/schedule-core.js
 * fills those in from the last copy a member's app read from RaceOS, when the
 * event matches. Classes are NEVER guessed from a title — a wrong chip sends a
 * driver to a race they cannot enter (the rule in lmu-dailies.js).
 *
 * It is a web page, not an API: any redesign can break this parser. It
 * returns null rather than a half-read calendar, and the job then keeps the
 * last good copy.
 *
 * ## League — SimGrid
 *
 * leagueOf/raceOf mirror electron/simgrid.js line for line (the desktop's
 * reader); scripts/test-schedule-sources.js runs both over the same SimGrid
 * payload and fails if they ever disagree.
 */

export const TIERS = [
  { key: 'beginner', label: 'Beginner', badge: 'Bronze', interval: 45 },
  { key: 'intermediate', label: 'Intermediate', badge: 'Silver', interval: 60 },
  { key: 'advanced', label: 'Advanced', badge: 'Gold', interval: 90 },
];

/** Entries open this long before a daily start (RaceOS's registrationOpens). */
export const REGISTRATION_LEAD_MIN = 30;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function decode(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "30 Sep at 11:45am" → epoch ms, UTC. The page prints no year, so it is the
 * year that puts the date nearest `now` (a page read on 31 Dec lists 1 Jan).
 */
export function parseStart(text, now) {
  const m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* at (\d{1,2}):(\d{2}) ?(am|pm)$/i.exec(decode(text));
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'pm') hour += 12;
  const year = new Date(now).getUTCFullYear();
  let best = null;
  for (const y of [year - 1, year, year + 1]) {
    const ms = Date.UTC(y, month, Number(m[1]), hour, Number(m[4]));
    if (best === null || Math.abs(ms - now) < Math.abs(best - now)) best = ms;
  }
  return best;
}

/** "30 minutes", "1h 14 minutes", "2 hours" → minutes, or null. */
export function parseDuration(text) {
  const t = decode(text).toLowerCase();
  const h = /(\d+)\s*h(?:ours?|rs?)?\b/.exec(t);
  const m = /(\d+)\s*m(?:in(?:ute)?s?)?\b/.exec(t);
  if (!h && !m) return null;
  return Number(h ? h[1] : 0) * 60 + Number(m ? m[1] : 0);
}

/** "Portimao Wec 2023" → "Portimao WEC"; "Long Beach 2026" → "Long Beach". */
export function tidyTrack(text) {
  return decode(text)
    .replace(/\s+(19|20)\d\d$/, '')
    .replace(/\bWec\b/g, 'WEC')
    .replace(/\bElms\b/g, 'ELMS')
    .trim();
}

/**
 * An event's starts as minutes past UTC midnight, for the whole day, from the
 * starts the page still lists. The page shows only what is LEFT of today, so
 * the pattern is extended backwards by the event's own spacing; with a single
 * start left, the tier's usual spacing stands in.
 */
export function minutesPattern(startsMs, fallbackInterval) {
  const mins = [...new Set(startsMs.map((ms) => Math.round((ms % 86400000) / 60000)))].sort((a, b) => a - b);
  if (!mins.length) return [];
  let interval = null;
  for (let i = 1; i < mins.length; i += 1) {
    const d = mins[i] - mins[i - 1];
    if (d > 0 && (interval === null || d < interval)) interval = d;
  }
  if (!interval) interval = fallbackInterval;
  if (!interval || 1440 % interval !== 0) return mins; // not a daily rotation — keep what we saw
  const out = [];
  for (let m = mins[0] % interval; m < 1440; m += interval) out.push(m);
  return out;
}

/**
 * The daily calendar out of racecontrol.gg's home page, in the renderer's
 * payload shape (see electron/lmu-dailies.js buildPayload). null when the
 * section is missing or reads as nothing — a redesign, not an empty day.
 */
export function parseRaceControl(html, now = Date.now()) {
  const text = String(html || '');
  const start = text.indexOf('Upcoming Daily Races');
  if (start < 0) return null;
  const end = text.indexOf('</section>', start);
  const section = text.slice(start, end > start ? end : undefined);
  const cards = section.split(/<li class="glide__slide"/).slice(1);

  const byTier = new Map(TIERS.map((t) => [t.key, []]));
  for (const card of cards) {
    const tierM = /tier-badge[^>]*>[\s\S]*?<\/i>\s*([a-z]+)\s*<\/span>/i.exec(card);
    const titleM = /<h4[^>]*>([\s\S]*?)<\/h4>/i.exec(card);
    if (!tierM || !titleM) continue;
    const tier = TIERS.find((t) => t.key === tierM[1].toLowerCase());
    if (!tier) continue;

    const facts = {};
    const factRe = /race-header[\s\S]*?<\/i>\s*([^<]+?)\s*<\/span>[\s\S]*?<hr[^>]*>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/g;
    let f;
    while ((f = factRe.exec(card))) facts[decode(f[1]).toLowerCase()] = decode(f[2]);

    const starts = [];
    const timeRe = /class="badge text-yellow[^"]*"[^>]*>\s*([^<]+?)\s*</g;
    let t;
    while ((t = timeRe.exec(card))) {
      const ms = parseStart(t[1], now);
      if (ms !== null) starts.push(ms);
    }
    const minutesUtc = minutesPattern(starts, tier.interval);
    if (!minutesUtc.length) continue;

    byTier.get(tier.key).push({
      seriesId: null,
      title: decode(titleM[1]),
      track: facts.track ? tidyTrack(facts.track) : 'Track TBC',
      scene: null,
      classes: [],
      eventMin: facts.duration ? parseDuration(facts.duration) : null,
      raceMin: null,
      fixedSetup: null,
      maxPlayers: null,
      tyreSets: null,
      tyreWarmers: null,
      registrationLeadMin: REGISTRATION_LEAD_MIN,
      minutesUtc,
      map: null,
    });
  }

  const tiers = [];
  for (const tier of TIERS) {
    const events = byTier.get(tier.key);
    if (!events.length) continue;
    // RaceOS's "frequency": one event's spacing over the events sharing it.
    const spacings = events.map((e) => (e.minutesUtc.length > 1 ? e.minutesUtc[1] - e.minutesUtc[0] : null));
    const same = spacings.every((s) => s !== null && s === spacings[0]);
    tiers.push({
      key: tier.key,
      label: tier.label,
      badge: tier.badge,
      cadenceMin: same ? Math.round(spacings[0] / events.length) : null,
      events,
      next: null,
      upcoming: [],
    });
  }
  if (!tiers.length) return null;

  return {
    ok: true,
    source: 'racecontrol',
    fetchedAt: new Date(now).toISOString(),
    weekStart: null,
    tiers,
    series: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  League — a mirror of electron/simgrid.js                                  */
/* -------------------------------------------------------------------------- */

export const SIMGRID_API = 'https://www.thesimgrid.com/api/v1';
const SITE = 'https://www.thesimgrid.com';
const CDN_PREFIX = 'https://cdn.thesimgrid.com/';

export const LEAGUES = [
  { id: 28052, day: 'thursday', label: 'Thursday league', hint: 'LMP2 & GT3' },
  { id: 24215, day: 'saturday', label: 'Saturday league', hint: 'GT3' },
];

function championshipUrl(id) {
  return `${SITE}/championships/${Number(id)}`;
}

function resultsUrl(id) {
  return `${SITE}/championships/${Number(id)}/results`;
}

function isSimGridUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'www.thesimgrid.com' || u.hostname === 'thesimgrid.com' || u.hostname === 'cdn.thesimgrid.com')
    );
  } catch {
    return false;
  }
}

function safeHttps(url) {
  return isSimGridUrl(url) ? url : null;
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

export function raceOf(raw, championshipId, upcomingId, now) {
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

export function leagueOf(raw, spec, now) {
  const id = Number(raw && raw.id) || spec.id;
  const racesRaw = Array.isArray(raw && raw.races) ? raw.races.slice() : [];
  racesRaw.sort((a, b) => {
    const da = Date.parse(a && a.starts_at) || 0;
    const db = Date.parse(b && b.starts_at) || 0;
    return da - db;
  });
  const upcomingId = raw && raw.upcoming_race && raw.upcoming_race.id;
  const races = racesRaw.map((r) => raceOf(r, id, upcomingId, now));
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

/**
 * Both championships, or null unless BOTH read — a partial league would
 * replace a complete one in the shared feed (forPublish's rule).
 */
export async function readLeague(key, fetchImpl, now = Date.now()) {
  const out = [];
  for (const spec of LEAGUES) {
    const res = await fetchImpl(`${SIMGRID_API}/championships/${spec.id}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    out.push(leagueOf(await res.json(), spec, now));
  }
  return { ok: true, fetchedAt: new Date(now).toISOString(), leagues: out };
}
