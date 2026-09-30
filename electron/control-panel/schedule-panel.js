/**
 * schedule-panel.js — the Schedule tab: the league's own championships
 * (SimGrid) and Le Mans Ultimate's daily, weekly and special races (RaceOS).
 * -----------------------------------------------------------------------------
 * Lifted out of control-panel.js so the web pit wall can run the SAME file:
 * scripts/build-web.js copies it verbatim, the way it copies the Team board.
 * Everything it needs from outside is `window.apex`:
 *
 *   schedule.get / schedule.dailies — on the desktop, IPC into the main
 *     process (SimGrid and RaceOS, live). On the web, web/src/web-bridge.js
 *     reads the copy a desktop app last published (public.schedule_feed).
 *   reminders.* — the desktop's bells. Main-side on purpose (the scheduler
 *     outlives the window), so a bridge without it — the web — simply gets no
 *     bells and no reminder options, rather than bells that do nothing.
 *   openInBrowser — SimGrid's signup pages.
 *
 * Loaded BEFORE control-panel.js, so the tab router can hand it the Schedule
 * view even on a launch that opens straight onto that tab.
 */

'use strict';

window.apexSchedule = (function () {
  const $ = (sel) => document.querySelector(sel);
  const CATALOG = window.APEX_FEATURE_CATALOG || null;
  /* The bells are the desktop's alone — see the header. Without a scheduler
     behind them the reminder options are hidden too, not left as switches
     that switch nothing. */
  const HAS_REMINDERS = !!(window.apex && window.apex.reminders);
  if (!HAS_REMINDERS) {
    const remind = $('.sk-remind');
    if (remind) remind.hidden = true;
  }

  // --- Schedule (SimGrid championships) ------------------------------------
  /*
   * Thursday and Saturday Apex & Chill championships, read through
   * schedule:get in the main process. The renderer never sees the GridOS
   * token — only names, times, tracks and https signup URLs come back, and
   * those URLs go out through openInBrowser (the allowlist in main.js) rather
   * than as <a href>, because an anchor inside this window would navigate the
   * panel itself.
   *
   * Nothing here fetches until the tab is shown. The main process already
   * caches for five minutes, so switching away and back is free.
   */
  const SK_FILTER_KEY = 'apex.panel.scheduleFilter';
  const SK_SOURCE_KEY = 'apex.panel.scheduleSource';
  /* Which calendar the tab is showing: the game's dailies, or the league's own
     championships. Daily is the default — it is the one with a race starting
     in the next ten minutes. */
  let skSource = 'daily';
  let skFilter = 'upcoming';
  let skLoaded = false;
  let skPayload = null;
  let skRequest = 0;

  try {
    const saved = localStorage.getItem(SK_FILTER_KEY);
    if (saved === 'all' || saved === 'upcoming') skFilter = saved;
    const source = localStorage.getItem(SK_SOURCE_KEY);
    if (source === 'league' || source === 'daily') skSource = source;
  } catch {
    /* storage disabled */
  }

  function skWhen(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return { abs: 'Date TBC', rel: '' };
    const abs = d.toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    const ms = d.getTime() - Date.now();
    const past = ms < 0;
    const min = Math.round(Math.abs(ms) / 60000);
    let rel = past ? 'just now' : 'now';
    if (min >= 1 && min < 60) rel = past ? `${min}m ago` : `in ${min}m`;
    else if (min >= 60) {
      const hr = Math.round(min / 60);
      if (hr < 36) rel = past ? `${hr}h ago` : `in ${hr}h`;
      else {
        const day = Math.round(hr / 24);
        if (day === 1) rel = past ? 'yesterday' : 'tomorrow';
        else rel = past ? `${day}d ago` : `in ${day}d`;
      }
    }
    return { abs, rel };
  }

  function skChip(text, tone) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    if (tone) chip.setAttribute('data-tone', tone);
    chip.textContent = text;
    return chip;
  }

  function skButton(label, url, accent) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = accent ? 'btn btn--accent btn--sm' : 'btn btn--ghost btn--sm';
    btn.textContent = label;
    if (url) btn.dataset.skUrl = url;
    else btn.disabled = true;
    return btn;
  }

  function skStatusLabel(status) {
    if (status === 'next') return 'Next';
    if (status === 'done') return 'Done';
    return 'Upcoming';
  }

  function skStatusTone(status) {
    if (status === 'next') return 'cyan';
    if (status === 'done') return 'muted';
    return 'purple';
  }

  function renderScheduleLeague(league) {
    const card = document.createElement('section');
    card.className = 'card sk-league';

    const head = document.createElement('div');
    head.className = 'sk-league__head';

    const meta = document.createElement('div');
    meta.className = 'sk-league__meta';
    meta.append(skChip(league.label || league.day || 'League', 'cyan'));
    if (league.hint) meta.append(skChip(league.hint, 'muted'));
    meta.append(
      skChip(
        league.accepting ? 'Registration open' : 'Registration closed',
        league.accepting ? 'purple' : 'muted',
      ),
    );

    const title = document.createElement('h2');
    title.className = 'sk-league__name';
    title.textContent = league.name || league.label || 'Championship';

    const spots = document.createElement('p');
    spots.className = 'sk-league__spots';
    if (league.capacity) {
      const taken = Number(league.spotsTaken) || 0;
      const left = Math.max(0, league.capacity - taken);
      spots.textContent = `${taken} / ${league.capacity} on the grid · ${left} spot${left === 1 ? '' : 's'} left`;
    } else {
      spots.textContent = league.game || '';
    }

    const actions = document.createElement('div');
    actions.className = 'sk-league__actions';
    actions.append(
      skButton(league.accepting ? 'Sign up on SimGrid' : 'Open on SimGrid', league.url, true),
    );
    if (league.resultsUrl) actions.append(skButton('Results', league.resultsUrl));
    if (league.discordUrl) actions.append(skButton('Discord', league.discordUrl));

    head.append(meta, title, spots, actions);
    card.append(head);

    const rounds = Array.isArray(league.races) ? league.races : [];
    const visible =
      skFilter === 'all' ? rounds : rounds.filter((r) => r.status !== 'done');
    const next = league.next && visible.some((r) => r.id === league.next.id) ? league.next : null;

    if (next) {
      const hero = document.createElement('div');
      hero.className = 'sk-next';
      const photo = next.track && next.track.photo;
      if (photo && /^https:\/\/cdn\.thesimgrid\.com\/[A-Za-z0-9._/-]+$/.test(photo)) {
        hero.style.setProperty('--sk-photo', `url("${photo}")`);
      }
      const kicker = document.createElement('div');
      kicker.className = 'sk-next__kicker';
      kicker.textContent = 'Next race';
      const ntitle = document.createElement('h3');
      ntitle.className = 'sk-next__title';
      ntitle.textContent = next.name;
      const track = document.createElement('p');
      track.className = 'sk-next__track';
      track.textContent = (next.track && next.track.name) || 'Track TBC';
      const when = skWhen(next.startsAt);
      const whenRow = document.createElement('div');
      whenRow.className = 'sk-next__when';
      const abs = document.createElement('span');
      abs.className = 'sk-next__abs';
      abs.textContent = when.abs;
      whenRow.append(abs);
      if (when.rel) {
        const rel = document.createElement('span');
        rel.className = 'sk-next__rel';
        rel.textContent = when.rel;
        whenRow.append(rel);
      }
      const cta = document.createElement('div');
      cta.className = 'sk-next__cta';
      cta.append(skButton('Sign up on SimGrid', next.signupUrl || league.url, true));
      hero.append(kicker, ntitle, track, whenRow, cta);
      card.append(hero);
    }

    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'sk-empty-league';
      empty.textContent =
        skFilter === 'all'
          ? 'No rounds published on SimGrid yet.'
          : 'No upcoming rounds — switch to All rounds to see the season.';
      card.append(empty);
      return card;
    }

    const list = document.createElement('ul');
    list.className = 'sk-rounds';
    for (const race of visible) {
      // The hero already names the next race; repeating it as the first row
      // is noise, so skip it in Upcoming. All-rounds keeps every line.
      if (skFilter === 'upcoming' && next && race.id === next.id) continue;
      const li = document.createElement('li');
      li.className = 'sk-round';
      li.setAttribute('data-status', race.status || 'upcoming');
      const body = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'sk-round__name';
      name.textContent = race.name;
      const track = document.createElement('span');
      track.className = 'sk-round__track';
      track.textContent = (race.track && race.track.name) || 'Track TBC';
      const when = skWhen(race.startsAt);
      const whenEl = document.createElement('span');
      whenEl.className = 'sk-round__when';
      whenEl.textContent = when.rel ? `${when.abs} · ${when.rel}` : when.abs;
      body.append(name, track, whenEl);
      const side = document.createElement('div');
      side.className = 'sk-round__side';
      side.append(skChip(skStatusLabel(race.status), skStatusTone(race.status)));
      if (race.status === 'done') {
        if (race.resultsAvailable && league.resultsUrl) {
          side.append(skButton('Results', league.resultsUrl));
        }
      } else {
        side.append(skButton('Sign up', race.signupUrl || league.url, race.status === 'next'));
      }
      li.append(body, side);
      list.append(li);
    }
    if (list.childElementCount) card.append(list);
    return card;
  }

  function renderSchedule(result) {
    const grid = $('#sk-grid');
    const empty = $('#sk-empty');
    const msg = $('#sk-msg');
    if (!grid || !empty) return;

    const leagues = (result && result.ok && Array.isArray(result.leagues)) ? result.leagues : [];
    grid.textContent = '';
    for (const league of leagues) grid.append(renderScheduleLeague(league));

    if (msg) {
      if (result && result.error) {
        msg.hidden = false;
        msg.textContent = result.error;
      } else {
        msg.hidden = true;
        msg.textContent = '';
      }
    }

    if (!leagues.length) {
      empty.hidden = false;
      empty.textContent =
        (result && result.error) || 'Could not load the league calendar from SimGrid.';
    } else {
      empty.hidden = true;
    }
  }

  async function refreshSchedule(force) {
    const n = ++skRequest;
    if (!skLoaded) {
      const empty = $('#sk-empty');
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'Loading the league calendar…';
      }
    }
    try {
      const res = await window.apex.schedule.get({ force: !!force });
      if (n !== skRequest) return;
      skPayload = res;
      skLoaded = true;
      renderSchedule(res);
    } catch {
      if (n !== skRequest) return;
      skLoaded = true;
      renderSchedule({ ok: false, leagues: [], error: 'Could not load the league calendar from SimGrid.' });
    }
  }

  const skFilterNav = $('#sk-filter');
  if (skFilterNav) {
    for (const btn of skFilterNav.querySelectorAll('[data-skfilter]')) {
      btn.setAttribute('data-active', String(btn.dataset.skfilter === skFilter));
      btn.addEventListener('click', () => {
        skFilter = btn.dataset.skfilter === 'all' ? 'all' : 'upcoming';
        for (const b of skFilterNav.querySelectorAll('[data-skfilter]')) {
          b.setAttribute('data-active', String(b.dataset.skfilter === skFilter));
        }
        try {
          localStorage.setItem(SK_FILTER_KEY, skFilter);
        } catch {
          /* storage disabled */
        }
        if (skPayload) renderSchedule(skPayload);
      });
    }
  }

  const skRefresh = $('#sk-refresh');
  if (skRefresh) {
    skRefresh.addEventListener('click', () => {
      void refreshScheduleActive(true);
    });
  }

  const skGrid = $('#sk-grid');
  if (skGrid) {
    skGrid.addEventListener('click', (ev) => {
      const btn = ev.target.closest && ev.target.closest('[data-sk-url]');
      if (!btn) return;
      const url = btn.getAttribute('data-sk-url');
      if (!url) return;
      // Leaving for SimGrid is the last thing this app sees of a signup, so it
      // is the honest place to count one — the same bargain copyUrl() takes
      // with an OBS Browser Source.
      CATALOG?.note('action:schedule.signup');
      window.apex.openInBrowser(url);
    });
  }

  // --- Daily races (the game's own calendar, via RaceOS) -------------------
  /*
   * The second half of the Schedule tab: LMU's official daily tiers, the solo
   * weekly and the team specials, read through schedule:dailies. The access
   * token never reaches here — main hands over names, tracks and UTC instants.
   *
   * Two rules shape everything below.
   *
   * 1. **Times arrive UTC and are formatted last.** Every `startsAt` in the
   *    payload is a UTC ISO string; the only place a zone is applied is
   *    dlTime()/dlDay(). That is what makes the tab DST-proof — a date built
   *    in local time would drift twice a year, and drift SILENTLY.
   * 2. **The countdown ticks only while this pane is on screen.** A one-second
   *    timer left running behind a hidden tab is exactly the kind of idle cost
   *    the panel's zero-when-closed rule exists to prevent.
   *
   * The zone switch is not decoration: the source message, the league's Discord
   * and the game's own schedule screen all speak UTC, so a driver comparing
   * what they see here against what someone posted needs to be able to agree
   * on a number without doing the arithmetic themselves.
   */
  const DL_ZONE_KEY = 'apex.panel.scheduleZone';
  const DL_MODE_KEY = 'apex.panel.scheduleMode';
  /** How many days forward the calendar offers. */
  const DL_CAL_DAYS = 7;
  let dlZone = 'local'; // 'local' | 'utc'
  let dlMode = 'next'; // 'next' | 'calendar'
  let dlDayPick = null; // the chosen day, as a display-zone YYYY-MM-DD
  /** The month on screen, as {y, m} with m zero-based. Set on first render. */
  let dlMonth = null;
  let dlPayload = null;
  let dlLoaded = false;
  let dlRequest = 0;
  let dlTimer = null;

  try {
    const saved = localStorage.getItem(DL_ZONE_KEY);
    if (saved === 'utc' || saved === 'local') dlZone = saved;
    const mode = localStorage.getItem(DL_MODE_KEY);
    if (mode === 'calendar' || mode === 'next') dlMode = mode;
  } catch {
    /* storage disabled */
  }

  /** The zone every time on this pane is drawn in. */
  function dlTimeZone() {
    return dlZone === 'utc' ? 'UTC' : undefined;
  }

  /** "10:15" — the clock time of an instant, in the chosen zone. */
  function dlTime(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '--:--';
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: dlTimeZone(),
    });
  }

  /**
   * The calendar day an instant falls on, as YYYY-MM-DD, IN THE DISPLAY ZONE.
   *
   * 'en-CA' is not a language choice — it is the one widely-supported locale
   * that formats a date as YYYY-MM-DD, which sorts and compares as a string.
   * And the zone matters: 23:30 UTC on Thursday is Friday for half of Europe,
   * so a day computed in UTC would file races under the wrong heading for
   * anyone east of us.
   */
  function dlDayKey(when) {
    const d = when instanceof Date ? when : new Date(when);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-CA', { timeZone: dlTimeZone() });
  }

  /** "Today" / "Tomorrow" / "Fri 19 Sep" for an instant. */
  function dlDay(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return dlDayName(dlDayKey(d), d);
  }

  /** The same, from a day key. `sample` saves re-parsing when we have one. */
  function dlDayName(key, sample) {
    if (!key) return '';
    if (key === dlDayKey(new Date())) return 'Today';
    if (key === dlDayKey(new Date(Date.now() + 86400000))) return 'Tomorrow';
    const d = sample || new Date(`${key}T12:00:00Z`);
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: sample ? dlTimeZone() : 'UTC',
    });
  }

  /**
   * The countdown, in the game's own idiom: MM:SS inside the hour so the last
   * minutes are readable at a glance, then H MM, then days.
   *
   * The days step is not cosmetic. Special events are booked three and four
   * days out, and an hours-only countdown renders those as "76h 12m" — a number
   * nobody converts in their head, and one that grows without limit if a date
   * is ever wrong. Past instants read "started" rather than counting up: a race
   * already gone is not news.
   */
  function dlCountdown(iso) {
    const ms = iso ? Date.parse(iso) - Date.now() : NaN;
    if (Number.isNaN(ms)) return '';
    if (ms <= 0) return 'started';
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /** id → true for every start currently belled. Filled by refreshReminders. */
  let dlBells = new Set();

  /**
   * The bell on a race. Its id is derived from the start rather than stored, so
   * the button knows its own state without the renderer keeping a parallel
   * copy that can drift from the main process's.
   */
  function dlBellId(kind, key, startsAt) {
    return `${kind}:${key}:${startsAt}`;
  }

  function dlBell(entry) {
    if (!HAS_REMINDERS || !entry || !entry.startsAt) return null;
    const id = dlBellId(entry.kind, entry.key, entry.startsAt);
    const on = dlBells.has(id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sk-bell';
    btn.setAttribute('data-on', String(on));
    btn.title = on ? 'Reminder on — click to cancel' : 'Remind me 5 and 2 minutes before';
    btn.setAttribute('aria-label', btn.title);
    btn.dataset.bell = JSON.stringify(entry);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', on ? '#i-bell-ring' : '#i-bell');
    icon.append(use);
    btn.append(icon);
    return btn;
  }

  function dlEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null && text !== '') el.textContent = String(text);
    return el;
  }

  /** A countdown element that the tick loop knows how to keep current. */
  function dlClock(iso, cls) {
    const el = dlEl('span', cls || 'sk-clock', dlCountdown(iso));
    if (iso) el.dataset.dlAt = iso;
    return el;
  }

  /**
   * The circuit outline, as inline SVG.
   *
   * Inline rather than an <img>: the path comes from the running game's own
   * geometry (electron/lmu-trackmaps.js), and drawing it here needs no network
   * request and no change to the panel's CSP — which allows images from itself,
   * data: and SimGrid's CDN only, and would otherwise have had to be widened to
   * reach RaceOS's artwork on S3.
   *
   * Returns null when there is no outline, so the layout collapses to the
   * text-only card rather than leaving a hole.
   */
  function dlMap(map, cls) {
    if (!map || typeof map.d !== 'string' || !map.d) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', cls || 'sk-map');
    // A little bleed around the box so a round stroke is never clipped.
    const view = Number(map.view) || 100;
    svg.setAttribute('viewBox', `-4 -4 ${view + 8} ${view + 8}`);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', map.d);
    svg.append(path);
    return svg;
  }

  function dlChips(classes) {
    const wrap = dlEl('span', 'sk-chips');
    for (const c of classes || []) {
      const chip = dlEl('span', 'sk-cls', c);
      chip.dataset.cls = c;
      wrap.append(chip);
    }
    return wrap;
  }

  /**
   * The line of hard facts under an event: race length, tyres, setup, grid
   * size. Anything the service did not tell us is left out rather than shown
   * as a zero — see the null-not-0 rule in electron/lmu-dailies.js.
   */
  function dlFacts(ev) {
    const facts = [];
    if (ev.raceMin) facts.push(`${Math.round(ev.raceMin)}m race`);
    if (ev.fixedSetup === true) facts.push('Fixed setup');
    else if (ev.fixedSetup === false) facts.push('Open setup');
    if (ev.tyreSets) facts.push(`${ev.tyreSets} tyre sets`);
    if (ev.tyreWarmers === true) facts.push('Tyre warmers');
    if (ev.maxPlayers) facts.push(`${ev.maxPlayers} car splits`);
    const row = dlEl('p', 'sk-facts');
    row.textContent = facts.join(' · ');
    return row;
  }

  /** One tier: what is on next, then the rest of the rotation. */
  function dlTierCard(tier) {
    const card = dlEl('div', 'card sk-tier');

    const head = dlEl('div', 'sk-tier__head');
    head.append(dlEl('h2', 'sk-tier__name', tier.label));
    const badge = dlEl('span', 'sk-sr', tier.badge);
    badge.dataset.sr = tier.badge;
    head.append(badge);
    if (tier.cadenceMin) head.append(dlEl('span', 'sk-tier__freq', `every ${tier.cadenceMin}m`));
    card.append(head);

    if (!tier.next) {
      card.append(dlEl('p', 'sk-none', 'Nothing more scheduled today.'));
      return card;
    }

    const next = tier.next;
    const hero = dlEl('div', 'sk-now');

    /* The circuit sits beside the name, not behind it: at card width an outline
       under text is a smudge, and the shape is half of how a driver recognises
       an event they have run before. */
    const outline = dlMap(next.map);
    if (outline) {
      hero.dataset.hasMap = 'true';
      hero.append(outline);
    }

    const text = dlEl('div', 'sk-now__text');
    const when = dlEl('div', 'sk-now__when');
    when.append(dlClock(next.startsAt, 'sk-now__clock'));
    when.append(dlEl('span', 'sk-now__at', `${dlDay(next.startsAt)} ${dlTime(next.startsAt)}`));
    const bell = dlBell({
      kind: 'daily',
      key: next.title,
      title: next.title,
      track: next.track,
      startsAt: next.startsAt,
      registrationOpens: next.registrationOpens,
    });
    if (bell) when.append(bell);
    text.append(when);
    text.append(dlEl('h3', 'sk-now__title', next.title));
    text.append(dlEl('p', 'sk-now__track', next.track));
    text.append(dlChips(next.classes));
    text.append(dlFacts(next));
    hero.append(text);

    /* Registration is the thing a driver can miss without noticing: the lobby
       opens half an hour out and you cannot enter before it does. */
    if (next.registrationOpens) {
      const opensMs = Date.parse(next.registrationOpens);
      const open = opensMs <= Date.now();
      const reg = dlEl('p', 'sk-reg');
      reg.dataset.state = open ? 'open' : 'soon';
      reg.textContent = open
        ? 'Entries open now'
        : `Entries open ${dlTime(next.registrationOpens)}`;
      text.append(reg);
    }
    card.append(hero);

    const rest = tier.upcoming.slice(1);
    if (rest.length) {
      const list = dlEl('ul', 'sk-then');
      for (const occ of rest) {
        const li = dlEl('li', 'sk-then__row');
        li.append(dlEl('span', 'sk-then__time', dlTime(occ.startsAt)));
        li.append(dlEl('span', 'sk-then__title', occ.title));
        li.append(dlEl('span', 'sk-then__track', occ.track));
        list.append(li);
      }
      card.append(list);
    }
    return card;
  }

  /**
   * One special-event series. These are the ones worth planning around, so the
   * slots carry the two things the dailies cannot: how many drivers have
   * already entered, and whether we are one of them.
   */
  function dlSeriesCard(series) {
    const card = dlEl('div', 'card sk-series');

    const top = dlEl('div', 'sk-series__top');
    const outline = dlMap(series.map, 'sk-map sk-map--series');
    if (outline) {
      top.dataset.hasMap = 'true';
      top.append(outline);
    }
    const body = dlEl('div', 'sk-series__body');

    const head = dlEl('div', 'sk-series__head');
    head.append(dlEl('h2', 'sk-series__name', series.title));
    const type = dlEl('span', 'chip', series.teamEvent ? 'Team event' : series.typeLabel);
    type.setAttribute('data-tone', series.teamEvent ? 'purple' : 'cyan');
    head.append(type);
    /* Bronze 0 is the bottom of the ladder — every account clears it — so it is
       not a requirement, it is the absence of one, and a chip saying so is
       noise on a card that already has several. */
    if (series.rank && !(series.rank === 'Bronze' && !series.rankTier)) {
      const sr = dlEl('span', 'sk-sr', `${series.rank} ${series.rankTier ?? ''}`.trim());
      sr.dataset.sr = series.rank;
      sr.title = 'Minimum safety rating';
      head.append(sr);
    }
    if (series.registered) {
      /* Its own class rather than a `data-tone`: hub.css ships purple, cyan and
         muted, and it is shared verbatim with the web build, so a fourth tone
         added for one chip here would have to be justified over there too. */
      head.append(dlEl('span', 'chip sk-mine', 'You are entered'));
    }
    body.append(head);
    body.append(dlEl('p', 'sk-series__track', series.track));
    body.append(dlChips(series.classes));
    body.append(dlFacts(series));
    top.append(body);
    card.append(top);

    const list = dlEl('ul', 'sk-slots');
    for (const slot of series.slots) {
      const li = dlEl('li', 'sk-slot');
      if (slot.isRegistered) li.dataset.mine = 'true';
      li.append(dlEl('span', 'sk-slot__day', dlDay(slot.startsAt)));
      li.append(dlEl('span', 'sk-slot__time', dlTime(slot.startsAt)));
      li.append(dlClock(slot.startsAt, 'sk-slot__in'));
      /* A count of 0 is a real and useful answer — an empty slot is one a
         driver may want to avoid — so it is shown, unlike a missing one. */
      if (slot.registrations !== null) {
        li.append(dlEl('span', 'sk-slot__regs', `${slot.registrations} entered`));
      }
      const bell = dlBell({
        kind: 'special',
        key: slot.id || series.title,
        title: series.title,
        track: series.track,
        startsAt: slot.startsAt,
        registrationOpens: slot.registrationOpens,
      });
      if (bell) li.append(bell);
      list.append(li);
    }
    card.append(list);
    return card;
  }

  function renderDailies(result) {
    const tiersEl = $('#dl-tiers');
    const seriesEl = $('#dl-series');
    const empty = $('#dl-empty');
    const msg = $('#dl-msg');
    if (!tiersEl || !seriesEl || !empty) return;

    const ok = !!(result && result.ok);
    const tiers = ok && Array.isArray(result.tiers) ? result.tiers : [];
    const series = ok && Array.isArray(result.series) ? result.series : [];

    tiersEl.textContent = '';
    seriesEl.textContent = '';
    for (const tier of tiers) tiersEl.append(dlTierCard(tier));
    for (const s of series) seriesEl.append(dlSeriesCard(s));

    /* Seeded here rather than at load, so a panel left open past midnight opens
       on the right month and the right day when it is next drawn. */
    const todayKey = dlDayKey(new Date());
    if (!dlDayPick) dlDayPick = todayKey;
    if (!dlMonth) {
      const [yy, mm] = dlDayPick.split('-').map(Number);
      dlMonth = { y: yy, m: mm - 1 };
    }
    renderMonthGrid(ok ? result : null);
    renderDay(ok ? result : null);

    if (msg) {
      /* A saved calendar is honest about being one. The times in it are still
         right — the rotation repeats — but the circuits are whatever LMU was
         running when it was fetched, so the driver gets to decide whether to
         trust it rather than being shown it as live. */
      let note = result && result.error;
      if (ok && result && result.cached) {
        const saved = result.savedAt ? new Date(result.savedAt) : null;
        const when =
          saved && !Number.isNaN(saved.getTime())
            ? `${dlDayName(dlDayKey(saved)).toLowerCase()} at ${dlTime(saved.toISOString())}`
            : 'earlier';
        /* The second sentence is the bridge's to override: the web pit wall
           cannot start the game, so "start LMU" would be an instruction nobody
           there can follow. */
        const hint = result.cachedHint || 'Start Le Mans Ultimate for the live one.';
        note = `Saved calendar, from ${when}. ${hint}`;
      }
      msg.hidden = !note || !ok;
      msg.textContent = note && ok ? note : '';
    }

    if (!tiers.length && !series.length) {
      empty.hidden = false;
      /* The offline case is not a failure to apologise for — it is a state
         with an action, so it reads as an instruction. */
      empty.textContent =
        (result && result.error) ||
        'Start Le Mans Ultimate and sign in to see the race calendar.';
    } else {
      empty.hidden = true;
    }

    const zone = $('#dl-zone');
    if (zone) {
      zone.textContent =
        dlZone === 'utc'
          ? 'Times shown in UTC'
          : `Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local time'}`;
    }
    const toggle = $('#dl-zone-toggle');
    if (toggle) toggle.textContent = dlZone === 'utc' ? 'Show local time' : 'Show UTC';

    dlTick();
  }

  /** Re-stamp every countdown on screen. Cheap: a handful of text nodes. */
  function dlTick() {
    for (const el of document.querySelectorAll('[data-dl-at]')) {
      el.textContent = dlCountdown(el.dataset.dlAt);
    }
  }

  /**
   * The tick runs only while this pane is actually visible — the tab is open,
   * the daily source is chosen, and the window is not hidden.
   */
  function dlSyncTimer() {
    const view = document.querySelector('[data-view="schedule"]');
    const visible =
      !!view &&
      view.getAttribute('data-active') === 'true' &&
      skSource === 'daily' &&
      document.visibilityState === 'visible';
    if (visible && !dlTimer) {
      dlTimer = setInterval(dlTick, 1000);
      dlTick();
    } else if (!visible && dlTimer) {
      clearInterval(dlTimer);
      dlTimer = null;
    }
  }

  async function refreshDailies(force) {
    const n = ++dlRequest;
    if (!dlLoaded) {
      const empty = $('#dl-empty');
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'Loading the race calendar…';
      }
    }
    try {
      const [res] = await Promise.all([
        window.apex.schedule.dailies({ force: !!force }),
        refreshReminders(false),
      ]);
      if (n !== dlRequest) return;
      dlPayload = res;
      dlLoaded = true;
      renderDailies(res);
      /* Counted on a load that actually produced a calendar, not on arriving at
         the tab: a driver with the game shut sees the "start LMU" line, and
         counting that as a read would make the feature look used by people it
         has never worked for. */
      if (res && res.ok) CATALOG?.note('action:schedule.dailies');
    } catch {
      if (n !== dlRequest) return;
      dlLoaded = true;
      renderDailies({
        ok: false,
        reason: 'network',
        tiers: [],
        series: [],
        error: 'Could not read the race calendar.',
      });
    }
  }

  const dlZoneToggle = $('#dl-zone-toggle');
  if (dlZoneToggle) {
    dlZoneToggle.addEventListener('click', () => {
      dlZone = dlZone === 'utc' ? 'local' : 'utc';
      try {
        localStorage.setItem(DL_ZONE_KEY, dlZone);
      } catch {
        /* storage disabled */
      }
      /* Re-render rather than patch: every time on the pane changes at once. */
      if (dlPayload) renderDailies(dlPayload);
    });
  }

  document.addEventListener('visibilitychange', dlSyncTimer);

  /* ---- Bells ------------------------------------------------------------
   *
   * The set of belled starts lives in the main process, because that is where
   * the scheduler lives and where it keeps running with this window shut. The
   * renderer holds a copy only to draw the buttons, and re-reads it whenever
   * main says the set moved — a reminder firing clears itself.
   */
  async function refreshReminders(redraw) {
    if (!HAS_REMINDERS) return;
    try {
      const res = await window.apex.reminders.list();
      dlBells = new Set((res && res.reminders ? res.reminders : []).map((r) => r.id));
      const s = (res && res.settings) || {};
      const voice = $('#dl-voice');
      if (voice) voice.checked = !!s.voice;
      const overlay = $('#dl-overlay');
      // Default ON, so an absent field must not read as off.
      if (overlay) overlay.checked = s.overlay !== false;
      const entries = $('#dl-entries');
      if (entries) entries.checked = !!s.entriesOpen;
      if (redraw && dlPayload) renderDailies(dlPayload);
    } catch {
      /* no bridge (the screenshot harness) — the bells simply read as off */
    }
  }

  const dlPane = $('#sk-daily-pane');
  if (dlPane) {
    dlPane.addEventListener('click', async (ev) => {
      const btn = ev.target.closest && ev.target.closest('[data-bell]');
      if (!btn) return;
      let entry;
      try {
        entry = JSON.parse(btn.dataset.bell);
      } catch {
        return;
      }
      // Drawn immediately, corrected by the reload below if main disagrees:
      // a bell that waits for a round trip feels broken.
      const wasOn = btn.getAttribute('data-on') === 'true';
      btn.setAttribute('data-on', String(!wasOn));
      try {
        const res = await window.apex.reminders.toggle(entry);
        if (res && res.ok === false && res.error) {
          const msg = $('#dl-msg');
          if (msg) {
            msg.hidden = false;
            msg.textContent = res.error;
          }
        }
        CATALOG?.note('action:schedule.remind');
      } catch {
        /* fall through to the reload, which settles the true state */
      }
      void refreshReminders(true);
    });
  }

  const dlVoice = $('#dl-voice');
  if (dlVoice) {
    dlVoice.addEventListener('change', () => {
      void window.apex.reminders.settings({ voice: dlVoice.checked });
    });
  }
  const dlOverlay = $('#dl-overlay');
  if (dlOverlay) {
    dlOverlay.addEventListener('change', () => {
      void window.apex.reminders.settings({ overlay: dlOverlay.checked });
    });
  }
  const dlEntries = $('#dl-entries');
  if (dlEntries) {
    dlEntries.addEventListener('change', async () => {
      await window.apex.reminders.settings({ entriesOpen: dlEntries.checked });
    });
  }

  try {
    window.apex.reminders.onChange(() => void refreshReminders(true));
  } catch {
    /* no bridge */
  }

  // --- The calendar: a day at a time ---------------------------------------
  /*
   * "What is on Saturday?" cannot be answered by asking the service — RaceOS
   * publishes ONE day of daily races (today, 00:00–23:55 UTC) and nothing
   * beyond it. It can be answered anyway, because of something the payload
   * proves about itself: every event's starts are evenly spaced, and every one
   * of those spacings divides a day exactly.
   *
   *   Beginner     15-minute cadence over 3 events → each runs every 45 min
   *   Intermediate 20 over 3 → every 60 min
   *   Advanced     30 over 3 → every 90 min
   *
   * 45, 60 and 90 all divide 1440, so the last start of a UTC day is followed
   * by the first start of the next at exactly one interval — the pattern closes
   * on midnight and repeats verbatim. Checked against all nine events live, and
   * held by scripts/test-dailies.js so a future cadence that does NOT divide a
   * day fails loudly instead of quietly drifting an hour a week.
   *
   * So each event ships `minutesUtc` — its starts as minutes past UTC midnight
   * — and any date is generated from that. What this does NOT do is pretend to
   * know next week: LMU rotates the circuits weekly, so the strip stops at
   * seven days and the note under it says the week's tracks are this week's.
   *
   * Special events are not projected at all. Those come dated from the service,
   * with their real entry counts, and are simply filed under the right day.
   */

  /** A calendar date as YYYY-MM-DD from its parts. Not an instant — a date. */
  function dlKeyOf(y, m, d) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  /**
   * How far ahead the daily rotation is known.
   *
   * The pattern repeats exactly every UTC day, so it COULD be drawn to the end
   * of time — but LMU rotates the circuits weekly, so a fortnight out the times
   * would be right and the tracks would be fiction. Seven days is the honest
   * limit, and a day past it says nothing rather than something wrong.
   */
  function dlDailyKnown(dayKey) {
    const today = dlDayKey(new Date());
    if (dayKey < today) return false; // yesterday ran last week's rotation
    const last = dlDayKey(new Date(Date.now() + (DL_CAL_DAYS - 1) * 86400000));
    return dayKey <= last;
  }

  /**
   * Every daily occurrence that falls on `dayKey`, per tier.
   *
   * The three UTC days scanned are not belt-and-braces: a day in the display
   * zone overlaps two UTC days at any offset other than zero, and at +13 the
   * local day's last race is already on the UTC day after next. Generating the
   * neighbours and filtering by day key is cheaper to get right than reasoning
   * about the offset, and it stays right across a DST boundary.
   */
  function dlDailyOn(dayKey, tier) {
    if (!dayKey || !tier || !dlDailyKnown(dayKey)) return [];
    const noon = Date.parse(`${dayKey}T12:00:00Z`);
    const out = [];
    for (const ev of tier.events || []) {
      for (const min of ev.minutesUtc || []) {
        for (let k = -1; k <= 1; k += 1) {
          const d = new Date(noon + k * 86400000);
          const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
          const at = utcMidnight + min * 60000;
          if (dlDayKey(new Date(at)) !== dayKey) continue;
          out.push({ startsAt: new Date(at).toISOString(), event: ev });
        }
      }
    }
    out.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    return out;
  }

  /** The special-event slots on a day, each carrying its series for context. */
  function dlSpecialsOn(dayKey, payload) {
    const out = [];
    for (const series of (payload && payload.series) || []) {
      for (const slot of series.slots || []) {
        if (dlDayKey(new Date(slot.startsAt)) === dayKey) out.push({ series, slot });
      }
    }
    out.sort((a, b) => Date.parse(a.slot.startsAt) - Date.parse(b.slot.startsAt));
    return out;
  }

  /* ---- The month grid ---------------------------------------------------- */

  /**
   * A month of cells, Monday first.
   *
   * What a cell says is the whole design question here. Listing the races would
   * repeat the same three names in all thirty cells, because the daily rotation
   * is identical every day — which is a wall of text that tells a driver
   * nothing about WHICH DAY to pick. So a cell carries only what actually
   * varies: the specials by name, and the dailies as a count.
   */
  function renderMonthGrid(payload) {
    const grid = $('#dl-days');
    const dows = $('#dl-cal-dows');
    const label = $('#dl-cal-month');
    if (!grid) return;

    const y = dlMonth.y;
    const m = dlMonth.m;
    const first = new Date(Date.UTC(y, m, 1));
    if (label) {
      label.textContent = first.toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
    }

    if (dows && !dows.childElementCount) {
      // Monday-first, in the driver's own locale, taken from real dates rather
      // than a hardcoded list so a non-English panel is not stuck with English.
      for (let i = 0; i < 7; i += 1) {
        const d = new Date(Date.UTC(2026, 8, 14 + i)); // 2026-09-14 is a Monday
        dows.append(dlEl('span', 'sk-cal__dow', d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })));
      }
    }

    const today = dlDayKey(new Date());
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
    const cells = Math.ceil((lead + daysInMonth) / 7) * 7;

    grid.textContent = '';
    for (let i = 0; i < cells; i += 1) {
      const dayNo = i - lead + 1;
      const inMonth = dayNo >= 1 && dayNo <= daysInMonth;
      const date = new Date(Date.UTC(y, m, dayNo));
      const key = inMonth
        ? dlKeyOf(y, m, dayNo)
        : dlKeyOf(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'sk-cell';
      cell.dataset.dlday = key;
      if (!inMonth) cell.dataset.out = 'true';
      if (key === today) cell.dataset.today = 'true';
      if (key === dlDayPick) cell.setAttribute('data-active', 'true');

      cell.append(dlEl('span', 'sk-cell__num', String(date.getUTCDate())));

      const specials = dlSpecialsOn(key, payload);
      const known = dlDailyKnown(key);

      if (specials.length) {
        const seen = new Set();
        for (const { series } of specials) {
          if (seen.has(series.title)) continue;
          seen.add(series.title);
          const pill = dlEl('span', 'sk-cell__ev', series.title);
          pill.dataset.team = String(!!series.teamEvent);
          cell.append(pill);
        }
      }

      if (known) {
        const count = (payload && payload.tiers ? payload.tiers : []).reduce(
          (n, t) => n + dlDailyOn(key, t).length,
          0,
        );
        if (count) cell.append(dlEl('span', 'sk-cell__daily', `${count} races`));
      }
      /* Nothing is drawn for a day outside the published week. A marker on
         every one of them is a month of shrugs, and on a day already gone it
         would be wrong as well — those races ran, we simply cannot say what
         they were any more. */

      grid.append(cell);
    }
  }

  /* ---- The chosen day ---------------------------------------------------- */

  /**
   * One tier on the chosen day: its three events, each with its start times as
   * chips.
   *
   * This replaces a 96-row list. The rotation means an event's starts are the
   * only thing that varies between them, so the event is stated once and its
   * times run underneath it — the same information as the list in a twelfth of
   * the height, and it reads as a timetable instead of a feed.
   */
  function dlDayTier(tier, dayKey) {
    const rows = dlDailyOn(dayKey, tier);
    if (!rows.length) return null;

    const card = dlEl('div', 'card sk-tier');
    const head = dlEl('div', 'sk-tier__head');
    head.append(dlEl('h2', 'sk-tier__name', tier.label));
    const badge = dlEl('span', 'sk-sr', tier.badge);
    badge.dataset.sr = tier.badge;
    head.append(badge);
    if (tier.cadenceMin) head.append(dlEl('span', 'sk-tier__freq', `every ${tier.cadenceMin}m`));
    card.append(head);

    /* Group the day's starts by the event they belong to, keeping the order the
       events appear in the payload so two days never disagree on arrangement. */
    const byTitle = new Map();
    for (const row of rows) {
      const list = byTitle.get(row.event.title) || [];
      list.push(row.startsAt);
      byTitle.set(row.event.title, list);
    }

    const now = Date.now();
    for (const ev of tier.events || []) {
      const times = byTitle.get(ev.title);
      if (!times || !times.length) continue;

      const block = dlEl('div', 'sk-slotgroup');
      const title = dlEl('div', 'sk-slotgroup__head');
      title.append(dlEl('span', 'sk-slotgroup__name', ev.title));
      title.append(dlEl('span', 'sk-slotgroup__track', ev.track));
      block.append(title);
      block.append(dlChips(ev.classes));
      block.append(dlFacts(ev));

      const chips = dlEl('div', 'sk-times');
      for (const t of times) {
        const chip = dlEl('span', 'sk-time', dlTime(t));
        if (Date.parse(t) < now) chip.dataset.past = 'true';
        chips.append(chip);
      }
      block.append(chips);
      card.append(block);
    }
    return card;
  }

  /** The chosen day: the tiers as timetables, then anything special on it. */
  function renderDay(payload) {
    const host = $('#dl-day');
    if (!host) return;
    host.textContent = '';

    const dayKey = dlDayPick || dlDayKey(new Date());
    const tiers = (payload && payload.tiers) || [];

    const head = dlEl('div', 'sk-day__head');
    head.append(dlEl('h2', 'sk-day__title', dlDayName(dayKey)));
    head.append(
      dlEl(
        'span',
        'sk-day__date',
        new Date(`${dayKey}T12:00:00Z`).toLocaleDateString(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          timeZone: 'UTC',
        }),
      ),
    );
    host.append(head);

    const specials = dlSpecialsOn(dayKey, payload);
    if (specials.length) {
      const card = dlEl('div', 'card sk-series sk-dayspecials');
      card.append(dlEl('h2', 'sk-series__name', 'Weekly and special events'));
      const list = dlEl('ul', 'sk-slots');
      for (const { series, slot } of specials) {
        const li = dlEl('li', 'sk-slot sk-slot--wide');
        if (slot.isRegistered) li.dataset.mine = 'true';
        li.append(dlEl('span', 'sk-slot__time', dlTime(slot.startsAt)));
        li.append(dlEl('span', 'sk-slot__name', series.title));
        li.append(dlEl('span', 'sk-slot__day', series.track));
        if (slot.registrations !== null) {
          li.append(dlEl('span', 'sk-slot__regs', `${slot.registrations} entered`));
        }
        const bell = dlBell({
          kind: 'special',
          key: slot.id || series.title,
          title: series.title,
          track: series.track,
          startsAt: slot.startsAt,
          registrationOpens: slot.registrationOpens,
        });
        if (bell) li.append(bell);
        list.append(li);
      }
      card.append(list);
      host.append(card);
    }

    const grid = dlEl('div', 'sk-tiers');
    let any = false;
    for (const tier of tiers) {
      const card = dlDayTier(tier, dayKey);
      if (card) {
        grid.append(card);
        any = true;
      }
    }
    if (any) host.append(grid);

    if (!any && !specials.length) {
      /* Beyond the known week the times would be right and the circuits would
         be fiction, so the day says so rather than inventing a rotation. */
      host.append(
        dlEl(
          'p',
          'sk-calnote',
          dlDailyKnown(dayKey)
            ? 'Nothing scheduled on this day.'
            : 'Le Mans Ultimate publishes one day of daily races at a time, and rotates the circuits weekly — so this far ahead only the dated events are known.',
        ),
      );
    } else if (dayKey !== dlDayKey(new Date())) {
      host.append(
        dlEl(
          'p',
          'sk-calnote',
          'Daily races repeat the same rotation every day. The circuits change with Le Mans Ultimate’s weekly rotation.',
        ),
      );
    }
  }

  function dlShiftMonth(by) {
    const d = new Date(Date.UTC(dlMonth.y, dlMonth.m + by, 1));
    dlMonth = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    if (dlPayload) renderDailies(dlPayload);
  }

  function applyDailyMode() {
    const nextPane = $('#dl-next-pane');
    const calPane = $('#dl-cal-pane');
    const calendar = dlMode === 'calendar';
    if (nextPane) nextPane.hidden = calendar;
    if (calPane) calPane.hidden = !calendar;
    const nav = $('#dl-mode');
    if (nav) {
      for (const b of nav.querySelectorAll('[data-dlmode]')) {
        b.setAttribute('data-active', String(b.dataset.dlmode === dlMode));
      }
    }
  }

  const dlModeNav = $('#dl-mode');
  if (dlModeNav) {
    for (const btn of dlModeNav.querySelectorAll('[data-dlmode]')) {
      btn.addEventListener('click', () => {
        dlMode = btn.dataset.dlmode === 'calendar' ? 'calendar' : 'next';
        try {
          localStorage.setItem(DL_MODE_KEY, dlMode);
        } catch {
          /* storage disabled */
        }
        applyDailyMode();
        if (dlPayload) renderDailies(dlPayload);
      });
    }
  }

  const dlDaysNav = $('#dl-days');
  if (dlDaysNav) {
    dlDaysNav.addEventListener('click', (ev) => {
      const btn = ev.target.closest && ev.target.closest('[data-dlday]');
      if (!btn) return;
      dlDayPick = btn.dataset.dlday;
      /* Clicking a day in a neighbouring month moves the grid to it, so the
         selection is never on a cell the driver can no longer see. */
      const [yy, mm] = dlDayPick.split('-').map(Number);
      if (yy !== dlMonth.y || mm - 1 !== dlMonth.m) dlMonth = { y: yy, m: mm - 1 };
      if (dlPayload) renderDailies(dlPayload);
    });
  }

  for (const [id, by] of [['#dl-cal-prev', -1], ['#dl-cal-next', 1]]) {
    const btn = $(id);
    if (btn) btn.addEventListener('click', () => dlShiftMonth(by));
  }
  const dlToday = $('#dl-cal-today');
  if (dlToday) {
    dlToday.addEventListener('click', () => {
      dlDayPick = dlDayKey(new Date());
      const [yy, mm] = dlDayPick.split('-').map(Number);
      dlMonth = { y: yy, m: mm - 1 };
      if (dlPayload) renderDailies(dlPayload);
    });
  }

  applyDailyMode();

  // --- Which calendar the Schedule tab is showing --------------------------
  /*
   * Two sources behind one segmented control. The daily races lead, because
   * they are the ones that start in the next ten minutes; the league's own
   * championships are a fortnight apart and keep.
   */
  function applyScheduleSource() {
    const leaguePane = $('#sk-league-pane');
    const dailyPane = $('#sk-daily-pane');
    const filter = $('#sk-filter');
    const sub = $('#sk-sub');
    const league = skSource === 'league';

    if (leaguePane) leaguePane.hidden = !league;
    if (dailyPane) dailyPane.hidden = league;
    // The Upcoming/All rounds filter belongs to the league calendar alone.
    if (filter) filter.hidden = !league;
    if (sub) {
      sub.textContent = league
        ? 'Upcoming Apex & Chill races, live from SimGrid. Sign up there — the button opens the championship page in your browser.'
        : 'Le Mans Ultimate’s own daily, weekly and special races. Times are in your own time zone; entries open 30 minutes before the start.';
    }

    const nav = $('#sk-source');
    if (nav) {
      for (const b of nav.querySelectorAll('[data-sksource]')) {
        b.setAttribute('data-active', String(b.dataset.sksource === skSource));
      }
    }
    dlSyncTimer();
  }

  /** Load whichever calendar is on screen. Each caches in main for itself. */
  function refreshScheduleActive(force) {
    if (skSource === 'league') return refreshSchedule(force);
    return refreshDailies(force);
  }

  const skSourceNav = $('#sk-source');
  if (skSourceNav) {
    for (const btn of skSourceNav.querySelectorAll('[data-sksource]')) {
      btn.addEventListener('click', () => {
        skSource = btn.dataset.sksource === 'league' ? 'league' : 'daily';
        try {
          localStorage.setItem(SK_SOURCE_KEY, skSource);
        } catch {
          /* storage disabled */
        }
        applyScheduleSource();
        void refreshScheduleActive(false);
      });
    }
  }

  applyScheduleSource();

  return {
    /** The tab became active: load whichever calendar is on screen. */
    shown: () => void refreshScheduleActive(false),
    /** Any tab change or visibility change: start or stop the countdown tick. */
    sync: dlSyncTimer,
  };
})();
