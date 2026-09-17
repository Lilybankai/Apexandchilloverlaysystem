/**
 * electron/lmu-dailies.js — LMU's own daily, weekly and special race calendar.
 * -----------------------------------------------------------------------------
 * The Schedule tab's second source. Where `electron/simgrid.js` reads the
 * league's championships, this reads the game's OFFICIAL matchmaking calendar —
 * the three daily tiers, the solo weekly, and the team specials — so a driver
 * can see what is on and when without alt-tabbing into the game.
 *
 * ## Where it comes from
 * Not the local REST API: the full swagger has no matchmaking route at all. It
 * lives on RaceOS (raceos.gg), the online service behind the game's lobby, and
 * is reached with exactly the exchange the rank badges already use — a Steam
 * session ticket from the running game, swapped for an access token. See
 * `scripts/probe-lmu-dailies.js`, which discovered and documents every route.
 *
 * Three consequences fall out of that and shape everything here:
 *
 * 1. **The game must be running and signed in.** No ticket, no calendar. That
 *    is not an error to apologise for — it is a state the tab explains.
 * 2. **It is an undocumented private service.** Any patch may change or remove
 *    a route, so every failure degrades to an empty tab with a reason, never to
 *    a thrown error or a half-drawn card.
 * 3. **The payloads are big.** `daily/list` is ~150–400 KB per tier because it
 *    embeds the whole car and track manifest. So the cheap `daily/schedule`
 *    (11 KB, every start time for the day) is the backbone, and only `take=3`
 *    of the expensive one is fetched per tier — which is exactly enough,
 *    because a tier's three events rotate, so three instances name all three
 *    series and their settings are per-series, not per-instance.
 *
 * ## Times
 * Everything the service returns is UTC ISO, and everything here stays UTC ISO.
 * The renderer formats in the driver's own zone at the very last moment, which
 * is what makes the whole thing DST-proof: generate in UTC, format locally.
 * (`api/v1/player/timezone` 404s, and the account's own `timezone` field reads
 * empty, so the OS zone is the only honest answer.)
 *
 * No Electron imports — `buildPayload` and its helpers are unit-tested headless
 * by `scripts/test-dailies.js`.
 */

'use strict';

const http = require('node:http');
const https = require('node:https');

const RACEOS_HOST = 'raceos.gg';
const HTTP_TIMEOUT_MS = 10_000;

/** How long a built payload is served before the service is asked again. */
const CACHE_MS = 10 * 60 * 1000;

/**
 * How long an access token is trusted. The game's own client refreshes on a
 * 25-minute clock; staying inside that keeps a 401 an exception path.
 */
const TOKEN_TTL_MS = 20 * 60_000;

/** Minimum gap between authentication attempts after one fails. */
const AUTH_RETRY_MS = 60_000;

/** How many occurrences of each tier the tab is given. */
const UPCOMING_PER_TIER = 8;

/**
 * The three daily tiers, in the order the game lists them. `badge` is the
 * safety rating the tier admits — the service repeats it per event, but a tier
 * with no events today would otherwise lose its identity.
 */
const TIERS = [
  { key: 'beginner', label: 'Beginner', badge: 'Bronze' },
  { key: 'intermediate', label: 'Intermediate', badge: 'Silver' },
  { key: 'advanced', label: 'Advanced', badge: 'Gold' },
];

/** The two special-event feeds. Any other type name answers 500. */
const SERIES_TYPES = [
  { key: 'weekly', label: 'Weekly' },
  { key: 'special', label: 'Special event' },
];

/* -------------------------------------------------------------------------- */
/*  Car classes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Car class from LMU's own content names (`Oreca_07_ELMS_2023`,
 * `BMW_M4_LMGT3_2023`, `Ligier_JSP325_2025`, `Ferrari_499P_2023`).
 *
 * The service does not label the classes of an event that has not run — only a
 * finished result carries `carClass` — and the game derives them from the local
 * content manifest, which we could read from `/rest/race/car` but which only
 * lists content this PC owns. So: markers, in order, most specific first.
 *
 * The rule when a car matches nothing is to say nothing. A missing chip costs a
 * driver one glance at the event; a WRONG chip sends them to a race in a class
 * they cannot enter, so guessing is the one thing this must not do. New
 * Hypercars are the likeliest gap — `HYPERCARS` is where they go.
 */
const HYPERCARS = [
  'ferrari_499p',
  'toyota_gr010',
  'porsche_963',
  'cadillac_v',
  'peugeot_9x8',
  'bmw_m_hybrid',
  'bmwmh',
  'alpine_a424',
  'lamborghini_sc63',
  'isotta',
  'aston_valkyrie',
  'valkyrie',
  'glickenhaus',
  'vanwall',
];

const CLASS_MARKERS = [
  { cls: 'LMGT3', test: (n) => n.includes('lmgt3') || n.includes('_gt3') || n.endsWith('gt3') },
  { cls: 'LMGTE', test: (n) => n.includes('lmgte') || n.includes('gte_') || n.includes('_gte') },
  { cls: 'LMP2', test: (n) => n.includes('lmp2') || n.includes('oreca_07') || n.includes('_p217') },
  { cls: 'LMP3', test: (n) => n.includes('lmp3') || n.includes('jsp3') || n.includes('duqueine') },
  { cls: 'Hypercar', test: (n) => HYPERCARS.some((h) => n.includes(h)) },
];

/** Display order for the chips, so two events never disagree on arrangement. */
const CLASS_ORDER = ['Hypercar', 'LMP2', 'LMP3', 'LMGTE', 'LMGT3'];

/**
 * The distinct classes an event runs, from its car list. Unrecognised cars are
 * dropped silently; an event whose cars are ALL unrecognised returns `[]` and
 * the card simply shows no chips.
 */
function classesOf(carNames) {
  if (!Array.isArray(carNames)) return [];
  const found = new Set();
  for (const raw of carNames) {
    const name = String(raw || '').toLowerCase();
    if (!name) continue;
    for (const { cls, test } of CLASS_MARKERS) {
      if (test(name)) {
        found.add(cls);
        break;
      }
    }
  }
  return CLASS_ORDER.filter((c) => found.has(c));
}

/* -------------------------------------------------------------------------- */
/*  Small parsers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Minutes from one of the service's Go-style durations — "20m", "1h12m30s",
 * "3m", "45s". Returns null for anything unparseable rather than 0, so a card
 * can leave the field out instead of claiming a zero-minute race.
 */
function durationMin(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const mins = Number(m[1] || 0) * 60 + Number(m[2] || 0) + Number(m[3] || 0) / 60;
  return Math.round(mins * 10) / 10;
}

/** Minutes from a "15 mins" / "30 mins" cadence string; null if unreadable. */
function cadenceMin(text) {
  if (typeof text !== 'string') return null;
  const m = /(\d+)\s*min/i.exec(text);
  return m ? Number(m[1]) : null;
}

/** A UTC ISO instant, or null. Never a Date — the payload crosses IPC. */
function isoOf(v) {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  // The service uses "0001-01-01T00:00:00Z" as its null date.
  if (ms < Date.parse('1980-01-01T00:00:00Z')) return null;
  return new Date(ms).toISOString();
}

/** A trimmed string, or '' — never undefined, so the renderer needs no guards. */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The key an event's settings are filed under. The title is the only thing that
 * distinguishes the three events in a tier (they share a seriesId), so it is
 * the join — case- and space-folded, because the two feeds are two different
 * services spelling the same name.
 */
function titleKey(title) {
  return str(title).toLowerCase().replace(/\s+/g, ' ');
}

/* -------------------------------------------------------------------------- */
/*  Mapping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Each start as whole minutes past UTC midnight, de-duplicated and sorted.
 *
 * The service hands back one day of ISO instants; this is the repeating shape
 * underneath them. Anything that does not land on a whole minute is dropped
 * rather than rounded — a rounded start time would be a lie about when a race
 * begins, and every start the service has ever published is on the minute.
 */
function minutesOfDay(isoTimes) {
  const mins = new Set();
  for (const iso of Array.isArray(isoTimes) ? isoTimes : []) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    const d = new Date(ms);
    if (d.getUTCSeconds() || d.getUTCMilliseconds()) continue;
    mins.add(d.getUTCHours() * 60 + d.getUTCMinutes());
  }
  return [...mins].sort((a, b) => a - b);
}

/**
 * The settings a driver actually decides on, lifted out of one `daily/list`
 * instance. These belong to the SERIES, not the instance, which is why three
 * instances per tier are enough to describe every event in it.
 */
function detailOf(raw) {
  const cfg = (raw && raw.configuration) || {};
  const settings = cfg.settings || {};
  const content = cfg.content || {};
  const track = content.track || {};
  const layout = Array.isArray(track.subItems) && track.subItems[0] ? track.subItems[0] : {};
  const sessions = Array.isArray(cfg.sessions) ? cfg.sessions : [];
  const race = sessions.find((s) => str(s && s.type).toLowerCase() === 'race');
  const quali = sessions.find((s) => str(s && s.type).toLowerCase() === 'qualifying');

  const starts = isoOf(cfg.starts);
  const opens = isoOf(cfg.registrationOpens);

  return {
    /* NOT an event id. Every event in a tier shares the tier's seriesId — all
       three Beginner events are 9e88176e-…, and `daily/schedule` repeats it on
       each of them. Joining detail to event on it silently gives all three
       events whichever one's settings landed in the map first, which reads as
       "every Beginner race is at Bahrain". The join key is the TITLE, within
       the tier. `scripts/test-dailies.js` holds this. */
    seriesId: str(cfg.seriesId) || str(raw && raw.seriesId),
    title: str(cfg.title),
    /* How far ahead of the start registration opens. Read, not assumed: it is
       30 minutes for every daily today, but that is the service's choice. */
    registrationLeadMin:
      starts && opens ? Math.round((Date.parse(starts) - Date.parse(opens)) / 60000) : null,
    track: str(layout.name) || str(track.friendly) || str(track.name),
    scene: str(track.name),
    classes: classesOf((Array.isArray(content.cars) ? content.cars : []).map((c) => c && c.friendly)),
    raceMin: race ? durationMin(race.duration) : null,
    qualiMin: quali ? durationMin(quali.duration) : null,
    sessions: sessions
      .map((s) => ({ type: str(s && s.type), min: durationMin(s && s.duration) }))
      .filter((s) => s.type),
    fixedSetup: typeof settings.fixedSetup === 'boolean' ? settings.fixedSetup : null,
    maxPlayers: Number.isFinite(settings.maxPlayers) ? settings.maxPlayers : null,
    tyreSets:
      settings.tires && Number.isFinite(settings.tires.availableTires)
        ? settings.tires.availableTires
        : null,
    tyreWarmers: typeof settings.tyreWarmers === 'boolean' ? settings.tyreWarmers : null,
    rank: str(cfg.tier && cfg.tier.entryRequirement && cfg.tier.entryRequirement.rank),
    rankTier: Number.isFinite(cfg.tier && cfg.tier.entryRequirement && cfg.tier.entryRequirement.tier)
      ? cfg.tier.entryRequirement.tier
      : null,
  };
}

/**
 * One tier of the daily calendar: its events, and every start time still to
 * come today, flattened and sorted.
 *
 * `daily/schedule` supplies the times (all of them, cheaply); the `details` map
 * supplies what each event IS. An event the detail call did not reach still
 * appears — with its name, track and times — rather than vanishing, because a
 * driver missing a race is worse than a card missing its tyre count.
 */
function tierOf(spec, scheduleTier, frequency, details, now) {
  const events = (Array.isArray(scheduleTier) ? scheduleTier : []).map((raw) => {
    const seriesId = str(raw && raw.seriesid);
    const title = str(raw && raw.eventname);
    const detail = details.get(titleKey(title)) || null;
    const cars = Array.isArray(raw && raw.cars) ? raw.cars : [];
    return {
      seriesId,
      title: title || (detail && detail.title) || 'Daily race',
      track: (detail && detail.track) || str(raw && raw.track),
      /* The game's own name for the circuit, e.g. "BahrainWEC". It is how
         electron/lmu-trackmaps.js finds the geometry to draw, so it travels
         with every occurrence and not just the event it came from. */
      scene: str(raw && raw.scene),
      classes: (detail && detail.classes.length ? detail.classes : classesOf(cars)),
      eventMin: durationMin(raw && raw.duration),
      raceMin: detail ? detail.raceMin : null,
      qualiMin: detail ? detail.qualiMin : null,
      sessions: detail ? detail.sessions : [],
      fixedSetup: detail ? detail.fixedSetup : null,
      maxPlayers: detail ? detail.maxPlayers : null,
      tyreSets: detail ? detail.tyreSets : null,
      tyreWarmers: detail ? detail.tyreWarmers : null,
      rank: detail ? detail.rank : '',
      registrationLeadMin: detail ? detail.registrationLeadMin : null,
      times: (Array.isArray(raw && raw.times) ? raw.times : []).map(isoOf).filter(Boolean),
    };
  });

  /* Every future start across the tier's events, in time order. This is the
     rotation — already resolved by the service, never inferred here. */
  const upcoming = [];
  for (const ev of events) {
    for (const t of ev.times) {
      if (Date.parse(t) < now) continue;
      upcoming.push({
        seriesId: ev.seriesId,
        title: ev.title,
        track: ev.track,
        scene: ev.scene,
        classes: ev.classes,
        startsAt: t,
        registrationOpens:
          ev.registrationLeadMin === null
            ? null
            : new Date(Date.parse(t) - ev.registrationLeadMin * 60000).toISOString(),
        raceMin: ev.raceMin,
        eventMin: ev.eventMin,
        tyreSets: ev.tyreSets,
        tyreWarmers: ev.tyreWarmers,
        fixedSetup: ev.fixedSetup,
        maxPlayers: ev.maxPlayers,
      });
    }
  }
  upcoming.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  /* `badge` is deliberately OURS, not the service's. `entryRequirement` reads
     {rank:"Bronze", tier:0} for all three daily tiers — it is a floor the
     matchmaker enforces, not the SR band the game's own card shows (BRONZE /
     SILVER / GOLD). Reading it would badge every tier "Bronze" and tell a
     driver the Gold races are open to them. The special events are different:
     theirs is meaningful (the solo weekly really is Silver 2), so `seriesOf`
     does use it. */
  return {
    key: spec.key,
    label: spec.label,
    badge: spec.badge,
    cadenceMin: cadenceMin(frequency && frequency[spec.key]),
    /* The ISO times are already spread across `upcoming`, so the raw arrays are
       replaced by `minutesUtc` — each start as minutes past UTC midnight.
       That is a third of the size AND it is what the calendar needs: the
       service publishes one day, but every event's cycle closes exactly on
       midnight UTC (45, 60 and 90 minutes divide 1440 evenly, verified against
       all nine events on 2026-09-17), so the same pattern is every day's
       pattern and any date can be generated from it without another fetch. */
    events: events.map(({ times, ...rest }) => ({
      ...rest,
      minutesUtc: minutesOfDay(times),
    })),
    next: upcoming[0] || null,
    upcoming: upcoming.slice(0, UPCOMING_PER_TIER),
  };
}

/**
 * One special-event series (the solo weekly, or a team special) with its slots.
 *
 * Unlike a daily, these carry live registration counts and whether WE are in
 * one — the two things that decide which slot a driver picks, so they are the
 * reason this feed is worth a separate call.
 */
function seriesOf(raw, typeSpec, now) {
  const cfg = (raw && raw.configuration) || {};
  const settings = cfg.settings || {};
  const content = cfg.content || {};
  const track = content.track || {};
  const layout = Array.isArray(track.subItems) && track.subItems[0] ? track.subItems[0] : {};
  const sessions = Array.isArray(cfg.sessions) ? cfg.sessions : [];
  const race = sessions.find((s) => str(s && s.type).toLowerCase() === 'race');
  const tier = (raw && raw.tier) || cfg.tier || {};
  const entry = tier.entryRequirement || {};

  const slots = (Array.isArray(raw && raw.events) ? raw.events : [])
    .map((e) => ({
      id: str(e && e.id),
      startsAt: isoOf(e && e.starts),
      registrationOpens: isoOf(e && e.registrationOpens),
      /* A number here, and an ARRAY on a daily instance. Same word, two shapes
         — so it is normalised once, here, rather than in the renderer. */
      registrations: Number.isFinite(e && e.registrations) ? e.registrations : null,
      isRegistered: !!(e && e.isRegistered),
    }))
    .filter((s) => s.startsAt && Date.parse(s.startsAt) >= now)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  return {
    type: typeSpec.key,
    typeLabel: typeSpec.label,
    seriesId: str(raw && raw.seriesId),
    title: str(raw && raw.title) || str(cfg.title) || 'Special event',
    teamEvent: !!(raw && raw.teamEvent),
    rank: str(entry.rank),
    rankTier: Number.isFinite(entry.tier) ? entry.tier : null,
    track: str(layout.name) || str(track.friendly) || str(track.name),
    scene: str(track.name),
    classes: classesOf((Array.isArray(content.cars) ? content.cars : []).map((c) => c && c.friendly)),
    raceMin: race ? durationMin(race.duration) : null,
    tyreSets:
      settings.tires && Number.isFinite(settings.tires.availableTires)
        ? settings.tires.availableTires
        : null,
    tyreWarmers: typeof settings.tyreWarmers === 'boolean' ? settings.tyreWarmers : null,
    fixedSetup: typeof settings.fixedSetup === 'boolean' ? settings.fixedSetup : null,
    maxPlayers: Number.isFinite(settings.maxPlayers) ? settings.maxPlayers : null,
    registered: slots.some((s) => s.isRegistered),
    next: slots[0] || null,
    slots,
  };
}

/**
 * The whole renderer payload, from raw service responses. Pure: no clock of its
 * own, no network, no Electron — `now` is passed in so a test can stand at a
 * known minute and assert which race is next.
 *
 * Any missing input degrades that part and leaves the rest intact: no schedule
 * means no tiers, a failed special-events call means no series, and neither
 * stops the other being shown.
 */
function buildPayload(raw, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const schedule = (raw && raw.schedule) || null;
  const lists = (raw && raw.lists) || {};
  const specials = (raw && raw.specials) || {};

  /* Event settings, per tier, keyed by title — see `titleKey`. Kept separate
     per tier rather than in one map because two tiers are free to run events of
     the same name at different lengths. */
  const detailsByTier = new Map();
  for (const spec of TIERS) {
    const list = Array.isArray(lists[spec.key]) ? lists[spec.key] : [];
    const map = new Map();
    for (const item of list) {
      const d = detailOf(item);
      const key = titleKey(d.title);
      if (key && !map.has(key)) map.set(key, d);
    }
    detailsByTier.set(spec.key, map);
  }

  const tiersRaw = (schedule && schedule.tiers) || {};
  const frequency = (schedule && schedule.frequency) || {};
  const tiers = TIERS.map((spec) =>
    tierOf(spec, tiersRaw[spec.key], frequency, detailsByTier.get(spec.key) || new Map(), at),
  );

  const series = [];
  for (const typeSpec of SERIES_TYPES) {
    const list = Array.isArray(specials[typeSpec.key]) ? specials[typeSpec.key] : [];
    for (const s of list) {
      const mapped = seriesOf(s, typeSpec, at);
      if (mapped.slots.length) series.push(mapped);
    }
  }
  series.sort((a, b) => Date.parse(a.next.startsAt) - Date.parse(b.next.startsAt));

  return {
    ok: true,
    fetchedAt: new Date(at).toISOString(),
    reason: null,
    error: null,
    tiers,
    series,
  };
}

/** The shape every failure returns, so the renderer has one code path. */
function emptyPayload(reason, error, now) {
  return {
    ok: false,
    fetchedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    reason,
    error,
    tiers: [],
    series: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  Transport                                                                 */
/* -------------------------------------------------------------------------- */

/** The Steam session ticket, from the running game's own local endpoint. */
function gameTicket(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/rest/profile/getAuthSessionTicket', timeout: 4000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`ticket HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof body.authSessionTicket === 'string' && body.authSessionTicket) {
              resolve(body.authSessionTicket);
            } else reject(new Error('no ticket in response'));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ticket timeout')));
  });
}

/** One call to the service. The bearer is never logged and never returned. */
function serviceCall(method, apiPath, body, bearer) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(
      {
        host: RACEOS_HOST,
        path: apiPath.startsWith('/') ? apiPath : `/${apiPath}`,
        method,
        timeout: HTTP_TIMEOUT_MS,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(bearer ? { 'Game-Authorization': `Bearer ${bearer}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 401) {
            reject(new Error('401'));
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`${apiPath} HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${apiPath} timeout`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/* -------------------------------------------------------------------------- */
/*  The client                                                                */
/* -------------------------------------------------------------------------- */

let cache = { at: 0, payload: null };
let token = null;
let tokenAt = 0;
let lastAuthFailAt = 0;

/**
 * Loads the calendar, cached for ten minutes.
 *
 * `opts` exists for the tests and for the probe: `now`, `port`, `ticketImpl`
 * and `callImpl` all default to the real thing. Returns the renderer payload
 * and never throws — a failure is `{ ok: false, reason }`:
 *
 *   offline — the game is not running, or not signed in (no ticket)
 *   auth    — the service refused the ticket
 *   network — the service could not be reached, or answered nothing usable
 */
async function getDailies(opts = {}) {
  const force = !!opts.force;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const port = Number(opts.port) || Number(process.env.APEX_LMU_PORT) || 6397;
  const ticketImpl = opts.ticketImpl || (() => gameTicket(port));
  const callImpl = opts.callImpl || serviceCall;

  if (!force && cache.payload && now - cache.at < CACHE_MS) return cache.payload;

  /* ---- auth ---- */
  if (!token || now - tokenAt >= TOKEN_TTL_MS) {
    if (!force && now - lastAuthFailAt < AUTH_RETRY_MS) {
      return emptyPayload('offline', 'Start Le Mans Ultimate and sign in to see the race calendar.', now);
    }
    let ticket;
    try {
      ticket = await ticketImpl();
    } catch {
      lastAuthFailAt = now;
      token = null;
      return emptyPayload('offline', 'Start Le Mans Ultimate and sign in to see the race calendar.', now);
    }
    try {
      const auth = await callImpl('POST', '/authenticate', {
        token: ticket,
        game: 'lmu',
        platform: 'steam',
      });
      if (!auth || typeof auth.accessToken !== 'string' || !auth.accessToken) {
        throw new Error('no access token in response');
      }
      token = auth.accessToken;
      tokenAt = now;
    } catch {
      lastAuthFailAt = now;
      token = null;
      return emptyPayload('auth', 'Le Mans Ultimate’s online service would not sign us in.', now);
    }
  }

  /* ---- fetch ----
     Settled, not all: the tab is useful with the dailies alone, and useful with
     the specials alone. Only losing the schedule itself is fatal. */
  const wanted = [
    ['schedule', () => callImpl('GET', 'api/v1/daily/schedule', null, token)],
    ...TIERS.map((t) => [
      `list:${t.key}`,
      /* take=3 names all three series in the tier exactly once — they rotate. */
      () => callImpl('GET', `api/v1/daily/list/${t.key}?take=3`, null, token),
    ]),
    ...SERIES_TYPES.map((s) => [
      `special:${s.key}`,
      () => callImpl('GET', `api/v1/special-events/${s.key}`, null, token),
    ]),
  ];

  const settled = await Promise.allSettled(wanted.map(([, fn]) => fn()));

  let unauthorised = false;
  const got = {};
  settled.forEach((res, i) => {
    const [name] = wanted[i];
    if (res.status === 'fulfilled') got[name] = res.value;
    else if (res.reason && res.reason.message === '401') unauthorised = true;
  });

  if (unauthorised) {
    // The token went stale mid-flight; drop it so the next ask re-authenticates.
    token = null;
  }

  if (!got.schedule) {
    return emptyPayload(
      unauthorised ? 'auth' : 'network',
      'Could not read the race calendar from Le Mans Ultimate’s online service.',
      now,
    );
  }

  const payload = buildPayload(
    {
      schedule: got.schedule,
      lists: Object.fromEntries(TIERS.map((t) => [t.key, got[`list:${t.key}`]])),
      specials: Object.fromEntries(SERIES_TYPES.map((s) => [s.key, got[`special:${s.key}`]])),
    },
    now,
  );

  /* An honest note when part of it is missing, rather than a silent gap. */
  const missing = TIERS.filter((t) => !got[`list:${t.key}`]).map((t) => t.label);
  if (missing.length) {
    payload.error = `Some event details are unavailable (${missing.join(', ')}).`;
  }

  cache = { at: now, payload };
  return payload;
}

/** Drops the cache AND the token — used by the tests and by Refresh-on-error. */
function resetCache() {
  cache = { at: 0, payload: null };
  token = null;
  tokenAt = 0;
  lastAuthFailAt = 0;
}

module.exports = {
  TIERS,
  SERIES_TYPES,
  CACHE_MS,
  UPCOMING_PER_TIER,
  minutesOfDay,
  classesOf,
  durationMin,
  cadenceMin,
  detailOf,
  tierOf,
  seriesOf,
  buildPayload,
  emptyPayload,
  getDailies,
  resetCache,
};
