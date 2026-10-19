/**
 * review-racelog.js — the race logs, painted.
 * -----------------------------------------------------------------------------
 * Phase 3 of docs/RACE-LOG-PLAN.md: every race LMU wrote a results file for,
 * as a list in a rail, and one race read back. Contacts, limits, damage and
 * penalties can be replayed: the game's own replay of that race, loaded five
 * seconds before the moment (phase 4, `dist/server/lmuReplay.js`).
 *
 * ## The page (redesigned 2026-10-19 from Carl's two concepts)
 * Top to bottom, the questions a driver asks after a race:
 *
 *   1. How did it go? — the circuit, the car, and four tiles: overall and
 *      class place (grid to flag), laps and best lap, and the incident counts.
 *   2. How did it unfold? — the race progression: overall and class place
 *      lap by lap on one axis, with every incident sat on the line.
 *   3. What happened? — the event timeline, opening on Key moments rather
 *      than every lap, with a search; beside it, the event picked: what it
 *      was, the lap before and after it, and the replay, which is where the
 *      replay's progress is shown too.
 *
 * One event is always the selected one. The timeline row, the marker on the
 * chart and the details card all follow it, and every way of moving it (a
 * click on a row or a marker, ↑ ↓ / J K, Previous / Next) goes through
 * `select()`.
 *
 * ## Why a list of its own, and not a view on a session
 * A race log is built from the game's results XML, not from our lap files.
 * Most of the 200-odd races on a driver's PC predate Apex, or were driven with
 * it closed, and so have no session in Review to hang off. So the races are a
 * tab of their own — the Race log tab, hosted by racelog-panel.js. A race
 * session in Review that DOES have a log gets a "Race log" button in its
 * header, which hands over to that tab.
 *
 * ## Going through a race's incidents
 * The job after an official race is a steward's: every contact, limit and
 * penalty, one after another. ↑ ↓ (or J K) move the selection, Enter replays
 * it, [ and ] replay the incident before or after. Once this race's replay is
 * in the game, Previous / Next in the details card jump the replay too.
 *
 * racelog-panel.js owns the rail and the detail column and hands both to this
 * file. Nothing here polls: the replay status is a push, subscribed while a
 * log is open and dropped the moment it is not. And nothing here reaches the
 * game (replay status, availability, the push) unless the tab is on screen —
 * racelog-panel.js says when, through `shown()` / `hidden()` — so a panel
 * that reopens on the Race log tab costs nothing until it is looked at.
 *
 * The progression chart is painted by review-charts.js (`drawRaceProgress`),
 * for the hex reason below.
 *
 * No hex colour literals in this file — test-panel-parity.js reads a quoted
 * hash-and-hex as an element id. Colours live in review-panel.css as tokens.
 */

(function () {
  'use strict';

  const dash = '—';
  const known = (v) => typeof v === 'number' && Number.isFinite(v);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------------------------------------------------------------- */
  /*  State                                                                 */
  /* ---------------------------------------------------------------------- */

  /** `RaceLogSummary[]`, newest first, as `review:racelogs` returned them. */
  let races = [];
  /** Circuit outlines by bundled key, `{ d, view }`: what `races[].mapKey` names. */
  let outlines = {};
  let listState = 'idle'; // idle | loading | ok | error
  let listRead = null;

  /** The race on screen. */
  let openId = null;
  let log = null;
  /** What the page works out once per log: see {@link indexLog}. */
  let facts = null;
  let reading = false;
  let readError = '';
  /** Showing "Which car was yours?" over a log that already has a car. */
  let repick = false;
  let picking = false;

  /**
   * The timeline's filter, remembered per viewer. Its own key since the
   * 2026-10-19 redesign, so everyone lands on Key moments once rather than on
   * whatever they last left the old page on.
   */
  const FILTER_KEY = 'apex.racelog.filter';
  let filter = 'key';
  try {
    const saved = window.localStorage.getItem(FILTER_KEY);
    if (saved) filter = saved;
  } catch {
    /* storage off: Key moments */
  }
  /** The timeline's search, for this visit only. */
  let query = '';
  /** Which place the progression chart leads with: `overall` or `class`. */
  let focusRow = 'overall';

  /**
   * The selected event: an index into `log.events`, or -1 for none. The
   * timeline marks it, the chart rings its marker, the details card is it.
   */
  let cursor = -1;

  /**
   * Whether the game still has this race's replay: `{ state, reason, message }`,
   * state `checking` | `yes` | `no`. Asked once per open, before any button is
   * drawn — a button that can only ever answer "gone" is worse than none.
   */
  let avail = { state: 'checking', reason: '', message: '' };
  /** The last pushed `ReplayStatus`. */
  let status = null;
  /** What was last clicked: `{ raceId, et, lap, kind }`. */
  let asked = null;
  /**
   * A click turned away because another race's replay is loading:
   * `{ raceId }`, the race whose click it was. Kept apart from `status`,
   * which stays the OTHER race's and so would never be drawn here. Cleared
   * when that load ends or the next click goes out.
   */
  let busy = null;
  /**
   * The tab is on screen. Nothing asks the game anything while it is not:
   * no availability check, no status, no push.
   */
  let active = false;
  let unsub = null;
  let copiedTimer = null;

  /** Set by racelog-panel.js: `{ detail, rerenderList }`. */
  let host = null;
  /** The chart's painters, when review-charts.js is on the page. */
  const CHARTS = window.APEX_REVIEW_CHARTS || null;
  /** The markers as last drawn, for a click on the chart: `[{ x, y, index }]`. */
  let chartHits = [];

  /* ---------------------------------------------------------------------- */
  /*  Formatting                                                            */
  /* ---------------------------------------------------------------------- */

  const pad2 = (n) => String(n).padStart(2, '0');

  /**
   * Race time: `m:ss`, or `h:mm:ss` for the whole log once any of it passes an
   * hour — one width down the column, the way a timing screen keeps it.
   * `minus` is the sign for a moment before the green flag (a swap on the
   * grid): the typographic one on screen, a hyphen in copied text.
   */
  function fmtRace(sec, long, minus = '−') {
    if (!known(sec)) return dash;
    const t = Math.floor(Math.abs(sec));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    const body = long ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
    return (sec < 0 && t > 0 ? minus : '') + body;
  }

  /** A lap time, `1:46.313`. */
  function fmtLap(ms) {
    if (!known(ms) || ms <= 0) return dash;
    const m = Math.floor(ms / 60000);
    const s = (ms - m * 60000) / 1000;
    return m ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
  }

  /** A gap in seconds with its sign, `+2.391`. */
  function fmtGap(ms) {
    if (!known(ms)) return '';
    return `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(3)}`;
  }

  const DAY_FMT = { weekday: 'short', day: 'numeric', month: 'short' };
  const TIME_FMT = { hour: '2-digit', minute: '2-digit' };

  function dayLabel(unixS) {
    const d = new Date(unixS * 1000);
    if (Number.isNaN(d.getTime())) return 'Unknown date';
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    const opts = d.getFullYear() === new Date().getFullYear() ? DAY_FMT : { ...DAY_FMT, year: 'numeric' };
    return d.toLocaleDateString(undefined, opts);
  }

  const clockLabel = (unixS) => {
    const d = new Date(unixS * 1000);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, TIME_FMT);
  };

  /** `LMP2_ELMS` → `LMP2 ELMS`: the file's class ids, as the log's text prints them. */
  const className = (c) => String(c || '').replace(/_/g, ' ').trim();

  const pos = (p) => (known(p) ? `P${p}` : dash);

  /** LMU's `FinishStatus`: `{ word, tone }`, or null for none. */
  function statusOf(s) {
    const v = String(s || '').trim();
    if (!v || /^none$/i.test(v)) return null;
    if (/^finished/i.test(v)) return { word: 'Finished', tone: 'ok' };
    if (/^dnf$/i.test(v)) return { word: 'DNF', tone: 'bad' };
    if (/^dq$/i.test(v)) return { word: 'Disqualified', tone: 'bad' };
    return { word: v, tone: '' };
  }

  function andList(names) {
    const n = names.filter(Boolean);
    if (n.length <= 1) return n.join('');
    return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** A circuit's outline as inline SVG, or '' — the Schedule tab's drawing. */
  function mapSvg(outline, cls) {
    if (!outline || typeof outline.d !== 'string' || !outline.d) return '';
    const view = Number(outline.view) || 100;
    return `<svg class="rl-map ${cls || ''}" viewBox="-4 -4 ${view + 8} ${view + 8}" aria-hidden="true"><path d="${esc(outline.d)}"/></svg>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  Kinds and filters                                                     */
  /* ---------------------------------------------------------------------- */

  const KIND_WORD = {
    start: 'Start', flag: 'Flag', lap: 'Lap', position: 'Position', contact: 'Contact',
    damage: 'Damage', limits: 'Limits', penalty: 'Penalty', pit: 'Pit', driver: 'Driver',
    finish: 'Finish',
  };

  /** The kinds a Replay button goes on: things that happened to the car at a moment. */
  const REPLAYABLE = new Set(['contact', 'damage', 'limits', 'penalty']);

  /** A line with a moment the replay can be put at: what the steps walk. */
  const isIncident = (e) => !!e && REPLAYABLE.has(e.kind) && known(e.et);

  /** A penalty line that closes one off rather than hands one out. */
  const isServed = (e) => e.kind === 'penalty' && /^served\b/i.test(String(e.text || ''));

  /**
   * The race in a dozen lines rather than two hundred: the start and the
   * flag, everything that happened to the car, the stops and swaps, a swing
   * of two places or more, and the best lap. Not the flags, which a live
   * recorder logs by the hundred, and not the laps one by one.
   */
  function isKey(e, i) {
    switch (e.kind) {
      case 'start':
      case 'finish':
      case 'contact':
      case 'damage':
      case 'limits':
      case 'penalty':
      case 'pit':
      case 'driver':
        return true;
      case 'position': {
        const d = e.detail || {};
        return Math.abs(d.gained || 0) >= 2 || Math.abs(d.classGained || 0) >= 2;
      }
      case 'lap':
        return !!facts && i === facts.bestIndex;
      default:
        return false;
    }
  }

  const kinds = (...k) => { const s = new Set(k); return (e) => s.has(e.kind); };

  /**
   * One question at a time, so tabs rather than tick boxes. A tab with
   * nothing behind it in this race is not drawn; Key moments and All always are.
   * No "Incidents" tab since the redesign: Key moments is the steward's read
   * now, and on a live-recorded race Incidents was mostly flags.
   */
  const FILTERS = [
    { id: 'key', label: 'Key moments', test: isKey, always: true },
    { id: 'all', label: 'All events', test: () => true, always: true },
    { id: 'contacts', label: 'Contacts', test: kinds('contact'), dot: 'bad' },
    { id: 'penalties', label: 'Limits &amp; penalties', test: kinds('limits', 'penalty'), dot: 'warn' },
    { id: 'positions', label: 'Positions', test: kinds('start', 'position', 'finish'), dot: 'ok' },
    { id: 'laps', label: 'Laps', test: kinds('lap') },
    { id: 'pit', label: 'Pit &amp; drivers', test: kinds('pit', 'driver'), dot: 'pit' },
    { id: 'flags', label: 'Flags', test: kinds('flag') },
  ];

  const filterOf = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

  function matchesQuery(e) {
    if (!query) return true;
    return `${KIND_WORD[e.kind] || e.kind} ${e.text} L${e.lap}`.toLowerCase().includes(query);
  }

  /** The rows on screen, as indexes into `log.events`, in race order. */
  function visibleIndexes() {
    if (!log || !Array.isArray(log.events)) return [];
    const f = filterOf(filter);
    const out = [];
    log.events.forEach((e, i) => { if (f.test(e, i) && matchesQuery(e)) out.push(i); });
    return out;
  }

  const visibleEvents = () => visibleIndexes().map((i) => log.events[i]);

  /**
   * How loud a row is: `bad`, `warn` or nothing. The game's own two contact
   * grades split red and amber, so a heavy hit stands out of a race full of
   * rubbing. Damage follows the damage widget: minor amber, major and
   * critical red; the XML's own damage lines carry no grade ("new suspension
   * damage") and read amber until the live recorder grades them. A penalty
   * served, or a limits "no further action", is the end of a story, not a
   * new one, and is left quiet.
   */
  function toneOf(e) {
    const d = e.detail || {};
    switch (e.kind) {
      case 'contact':
        return d.severity === 'heavy' ? 'bad' : 'warn';
      case 'penalty':
        return isServed(e) ? '' : 'bad';
      case 'damage':
        return d.grade === 'major' || d.grade === 'critical' ? 'bad' : 'warn';
      case 'limits':
        return /no further action/i.test(String(d.verdict || '')) ? '' : 'warn';
      case 'flag':
        return 'warn';
      case 'position':
        return known(d.gained) && d.gained ? (d.gained > 0 ? 'ok' : 'bad') : '';
      default:
        return '';
    }
  }

  /**
   * What the page needs from a log beyond its events, worked out once:
   * lap times by lap number, the best valid lap, and the counts.
   */
  function indexLog(l) {
    const laps = new Map();
    let bestIndex = -1;
    let bestMs = Infinity;
    const count = { contact: 0, limits: 0, penalty: 0 };
    (l.events || []).forEach((e, i) => {
      const d = e.detail || {};
      if (e.kind === 'lap' && e.lap > 0) {
        laps.set(e.lap, { ms: d.lapMs, invalid: !!d.invalid, pb: !!d.personalBest, cb: !!d.classBest });
        if (!d.invalid && known(d.lapMs) && d.lapMs < bestMs) { bestMs = d.lapMs; bestIndex = i; }
      }
      if (e.kind in count && !isServed(e)) count[e.kind] += 1;
    });
    return { laps, bestIndex, bestMs: Number.isFinite(bestMs) ? bestMs : null, count };
  }

  /* ---------------------------------------------------------------------- */
  /*  The rail                                                              */
  /* ---------------------------------------------------------------------- */

  function matches(row, q) {
    if (!q) return true;
    return `${row.track} ${className(row.carClass)}`.toLowerCase().includes(q);
  }

  /** `P16 / P4`: the overall place, and the class place in a multiclass race. */
  function placePair(overall, cls, multiclass) {
    if (!known(overall)) return '';
    return multiclass && known(cls) ? `P${overall} <em>/ P${cls}</em>` : `P${overall}`;
  }

  /** One race card: circuit, when, where it finished, and what it cost. */
  function cardHtml(row) {
    const mine = row.slot !== null && row.slot !== undefined;
    const cls = className(row.carClass);
    const multi = !!row.multiclass && cls;
    const st = statusOf(row.finishStatus);
    const clean = mine && !row.contacts && !row.limits && !row.penalties;
    let badge = '';
    if (row.provisional) badge = '<span class="rl-badge">Provisional</span>';
    else if (mine && st && st.tone === 'bad') badge = `<span class="rl-badge" data-tone="bad">${esc(st.word)}</span>`;
    else if (clean) badge = '<span class="rl-badge" data-tone="ok">Clean</span>';
    const started = mine && known(row.gridPosition)
      ? `Started P${row.gridPosition}${multi && known(row.gridClassPosition) ? ` / P${row.gridClassPosition}` : ''}` : '';
    // Laps on a line of their own, then what the race cost, wrapping as it must.
    const cost = mine
      ? [
        row.contacts ? plural(row.contacts, 'contact', 'contacts') : '',
        row.limits ? plural(row.limits, 'limit', 'limits') : '',
        row.penalties ? plural(row.penalties, 'penalty', 'penalties') : '',
      ].filter(Boolean).join(' · ')
      : '';
    const place = placePair(row.finishPosition, row.finishClassPosition, multi);
    return `
        <button class="rv__card rl-rcard" type="button" data-race="${esc(row.id)}"
                data-slot="${mine ? String(row.slot) : 'none'}"
                data-active="${String(row.id === openId)}">
          <span class="rl-rcard__top">
            ${mapSvg(outlines[row.mapKey], 'rl-map--card')}
            <span class="rl-rcard__name">
              <b>${esc(row.track || 'Unknown circuit')}</b>
              <i>${esc([cls, clockLabel(row.startedAt)].filter(Boolean).join(' · '))}</i>
            </span>
            ${badge}
          </span>
          ${mine ? `
          <span class="rl-rcard__foot">
            <span class="rl-rcard__pos">
              <span class="rl-rcard__place"${place ? '' : ' data-none="true"'}>${place || 'No result'}</span>
              ${started ? `<span class="rl-rcard__from">${esc(started)}</span>` : ''}
            </span>
            <span class="rl-rcard__meta">${row.laps ? `<b>${esc(plural(row.laps, 'lap', 'laps'))}</b>` : ''}${esc(cost)}</span>
          </span>` : `
          <span class="rl-rcard__foot"><span class="rl-rcard__which">Which car was yours?</span></span>`}
        </button>`;
  }

  /** The race cards for the rail, day-headed. */
  function listHtml(query) {
    if (listState === 'loading' && !races.length) {
      return '<p class="rv-empty" style="padding:20px 14px">Reading the game’s results…</p>';
    }
    const q = String(query || '').trim().toLowerCase();
    const rows = races.filter((r) => matches(r, q));
    if (!rows.length) {
      return `<p class="rv-empty" style="padding:20px 14px">${
        races.length ? 'No race matches that.' : 'No races yet.'
      }</p>`;
    }
    let html = '';
    let day = '';
    for (const row of rows) {
      const d = dayLabel(row.startedAt);
      if (d !== day) {
        day = d;
        html += `<div class="rv__day">${esc(d)}</div>`;
      }
      html += cardHtml(row);
    }
    return html;
  }

  /* ---------------------------------------------------------------------- */
  /*  The race: header and tiles                                            */
  /* ---------------------------------------------------------------------- */

  function emptyState(icon, title, body) {
    return `
      <div class="rv-empty">
        <svg class="icon"><use href="#i-${icon}" /></svg>
        <b>${esc(title)}</b>
        <p>${body}</p>
      </div>`;
  }

  function headHtml(l, summary) {
    const track = (l && l.track) || (summary && summary.track) || 'Unknown circuit';
    const at = (l && l.startedAt) || (summary && summary.startedAt) || 0;
    const outline = (l && l.outline) || (summary && outlines[summary.mapKey]) || null;
    const mine = l && l.slot !== null;
    const st = mine ? statusOf(l.finishStatus) : null;
    const sub = mine
      ? [className(l.carClass), l.vehicle].filter(Boolean).map((s) => `<span>${esc(s)}</span>`).join('')
      : '';
    return `
      <div class="rl-head">
        ${mapSvg(outline, 'rl-map--head')}
        <div class="rl-head__title">
          <h2>${esc(track)}</h2>
          <div class="rl-head__sub">
            ${sub}
            ${st ? `<span class="rl-status"${st.tone ? ` data-tone="${st.tone}"` : ''}>${esc(st.word)}</span>` : ''}
            ${l && l.provisional ? '<span class="rl-status">Provisional</span>' : ''}
          </div>
        </div>
        <span class="rl-head__when">${esc(dayLabel(at))} · ${esc(clockLabel(at))}</span>
      </div>`;
  }

  /** A place tile: where it finished, the places made, where it started. */
  function placeTile(label, grid, finish) {
    const moved = known(grid) && known(finish) ? grid - finish : null;
    const tag = moved
      ? `<span class="rl-tile__delta" data-dir="${moved > 0 ? 'gain' : 'loss'}">${moved > 0 ? '▲' : '▼'} ${Math.abs(moved)}</span>`
      : '';
    return `
      <div class="rl-tile">
        <span class="rl-tile__label">${esc(label)}</span>
        <span class="rl-tile__big">${pos(finish)}${tag}</span>
        <span class="rl-tile__sub">${known(grid) ? `Started ${pos(grid)}` : '&nbsp;'}</span>
      </div>`;
  }

  /** The counts are buttons: each opens the timeline on that kind. */
  function countHtml(n, word, tone, f) {
    return `<button type="button" class="rl-count" data-rlfilter="${f}"${n ? ` data-tone="${tone}"` : ''}
                    title="Show these in the timeline"><b>${n}</b><span>${esc(word)}</span></button>`;
  }

  function tilesHtml(l) {
    const cls = className(l.carClass);
    const c = facts.count;
    const best = facts.bestMs;
    return `
      <div class="rl-tiles">
        ${placeTile(l.multiclass ? 'Overall' : 'Position', l.gridPosition, l.finishPosition)}
        ${l.multiclass && cls ? placeTile(`Class (${cls})`, l.gridClassPosition, l.finishClassPosition) : ''}
        <div class="rl-tile">
          <span class="rl-tile__label">Laps</span>
          <span class="rl-tile__big">${known(l.laps) ? l.laps : dash}</span>
          <span class="rl-tile__sub">${best ? `Best <b class="rl-tile__best">${fmtLap(best)}</b>` : '&nbsp;'}</span>
        </div>
        <div class="rl-tile rl-tile--counts">
          <span class="rl-tile__label">Incidents</span>
          <span class="rl-counts">
            ${countHtml(c.contact, c.contact === 1 ? 'contact' : 'contacts', 'bad', 'contacts')}
            ${countHtml(c.limits, 'track limits', 'warn', 'penalties')}
            ${countHtml(c.penalty, c.penalty === 1 ? 'penalty' : 'penalties', 'text', 'penalties')}
          </span>
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  The race progression                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Where the car ran, lap by lap: `{ laps, rows: [{ id, label, pos[] }] }`,
   * one row overall and — in a multiclass race — one in class. `pos[n]` is
   * the place at the end of lap n (0 is the grid). The log only says so when
   * it CHANGED, so a place is held forward until the next line moves it, and
   * the finish is the classification, which a penalty can move after the
   * flag. Null when there is nothing to draw: no grid, or under two laps.
   */
  function positionSeries(l) {
    if (!l || !Array.isArray(l.events)) return null;
    let last = 0;
    for (const e of l.events) if (e.kind === 'lap' && e.lap > last) last = e.lap;
    if (last < 2) return null;
    const build = (key, finish) => {
      const at = new Map();
      for (const e of l.events) {
        const d = e.detail || {};
        if ((e.kind === 'start' || e.kind === 'position') && known(d[key])) {
          at.set(e.kind === 'start' ? 0 : e.lap, d[key]);
        }
      }
      if (!at.has(0)) return null;
      const out = [];
      let held = at.get(0);
      for (let n = 0; n <= last; n += 1) {
        if (at.has(n)) held = at.get(n);
        out.push(held);
      }
      if (known(finish)) out[last] = finish;
      return out;
    };
    const overall = build('position', l.finishPosition);
    if (!overall) return null;
    const rows = [{ id: 'overall', label: l.multiclass ? 'Overall' : 'Position', pos: overall }];
    if (l.multiclass) {
      const cls = build('classPosition', l.finishClassPosition);
      if (cls) rows.push({ id: 'class', label: className(l.carClass) || 'Class', pos: cls });
    }
    return { laps: last, rows };
  }

  /** The incidents and stops, as the chart's markers. */
  function chartMarks(l) {
    const out = [];
    l.events.forEach((e, i) => {
      if (isIncident(e) && e.kind !== 'limits') out.push({ lap: e.lap, tone: toneOf(e) || 'warn', index: i });
      else if (e.kind === 'limits' && toneOf(e)) out.push({ lap: e.lap, tone: 'warn', index: i });
      else if (e.kind === 'pit') out.push({ lap: e.lap, tone: 'pit', index: i });
    });
    return out;
  }

  function progressHtml(l) {
    const s = CHARTS && typeof CHARTS.drawRaceProgress === 'function' ? positionSeries(l) : null;
    if (!s) return '';
    const two = s.rows.length > 1;
    return `
      <section class="rv-card rl-progress">
        <div class="rl-card__head">
          <h3>Race progression</h3>
          <span class="rl-legend">
            <span data-key="incident">Incident</span><span data-key="pit">Pit stop</span>
          </span>
          ${two ? `
          <nav class="seg seg--sm" aria-label="Which place to follow">
            ${s.rows.map((r) => `<button type="button" data-rlfocus="${r.id}" data-active="${String(r.id === focusRow)}">${esc(r.id === 'class' ? `Class (${r.label})` : r.label)}</button>`).join('')}
          </nav>` : ''}
        </div>
        <div class="rl-chart" role="img" aria-label="Place lap by lap, with the race's incidents"><canvas></canvas></div>
      </section>`;
  }

  /** Paint the progression, if the log on screen has one. Cheap: a few hundred points. */
  function paintChart() {
    chartHits = [];
    if (!host || !host.detail || !CHARTS || !log) return;
    const canvas = host.detail.querySelector('.rl-chart canvas');
    const s = canvas ? positionSeries(log) : null;
    if (!s) return;
    chartHits = CHARTS.drawRaceProgress(canvas, {
      ...s,
      focus: focusRow,
      marks: chartMarks(log),
      selected: cursor,
    }) || [];
  }

  /** The marker under a point on the chart, or -1. */
  function hitAt(evt) {
    const canvas = evt.target;
    const box = canvas.getBoundingClientRect();
    const x = evt.clientX - box.left;
    const y = evt.clientY - box.top;
    let best = -1;
    let bestD = 10 * 10;
    for (const h of chartHits) {
      const d = (h.x - x) ** 2 + (h.y - y) ** 2;
      if (d <= bestD) { bestD = d; best = h.index; }
    }
    return best;
  }

  /* ---------------------------------------------------------------------- */
  /*  The timeline                                                          */
  /* ---------------------------------------------------------------------- */

  /** One width for the whole column: `h:mm:ss` once the race passes an hour. */
  function longClock() {
    if (!log || !log.events.length) return false;
    let max = 0;
    for (const e of log.events) if (known(e.raceS) && Math.abs(e.raceS) > max) max = Math.abs(e.raceS);
    return max >= 3600;
  }

  /**
   * A lap's line, from the log's own sentence. The time is pulled out so it
   * can wear the lap sheet's colours; everything after it (`personal best`,
   * `1 off-track, no action`) is kept word for word — the builder is the
   * authority on what a lap was, this only decides how loud to say it.
   */
  function lapText(e) {
    const d = e.detail || {};
    const m = /^Lap\s+\d+\s+(\d+:\d{2}\.\d{3}|\d+\.\d{3}|no time)\s*(.*)$/.exec(e.text || '');
    if (!m) return esc(e.text);
    const rank = d.classBest ? 'class' : d.personalBest ? 'pb' : '';
    // The builder separates its notes with two spaces and brackets the last:
    // `personal best  (1 off-track, no action)` reads as two notes here.
    const rest = m[2].split(/\s{2,}/)
      .map((part) => part.trim().replace(/^\((.*)\)$/, '$1'))
      .filter(Boolean)
      .join(' · ');
    return `<span class="rv-log__lap"${rank ? ` data-rank="${rank}"` : ''}${d.invalid ? ' data-invalid="true"' : ''}>${esc(m[1])}</span>${
      rest ? ` <span class="rv-log__rest">${esc(rest)}</span>` : ''}`;
  }

  /** The kind, as a pill (or, for a lap, as quiet text: laps are most of the log). */
  function kindHtml(e) {
    const tone = toneOf(e);
    return `<span class="rl-kind" data-kind="${esc(e.kind)}"${tone ? ` data-tone="${tone}"` : ''}>${esc(KIND_WORD[e.kind] || e.kind)}</span>`;
  }

  /**
   * One line. `replay` is `null` for a log that can never replay (no car,
   * or a provisional log with no results file behind it), else
   * `{ ok, title }`: a race whose replay is gone or whose game is shut keeps
   * its buttons, greyed with the reason, so the feature stays findable.
   */
  function rowHtml(e, i, long, replay) {
    const btn = replay && isIncident(e);
    const on = !!asked && asked.raceId === log.id && asked.index === i;
    return `
      <tr data-ev="${i}" data-kind="${esc(e.kind)}"${on ? ' data-asked="true"' : ''}${i === cursor ? ' data-cursor="true"' : ''}>
        <td class="l">${e.lap > 0 ? `L${e.lap}` : dash}</td>
        <td class="t">${fmtRace(e.raceS, long)}</td>
        <td class="k">${kindHtml(e)}</td>
        <td class="x">${e.kind === 'lap' ? lapText(e) : esc(e.text)}</td>
        <td class="ref">${btn
          ? `<button type="button" class="rl-replaybtn" data-replay="${i}"${replay.ok ? '' : ' disabled'}
                     title="${esc(replay.title)}" aria-label="Replay"><svg class="icon"><use href="#i-play" /></svg><span>Replay</span></button>`
          : ''}</td>
      </tr>`;
  }

  /** The tabs, the table and the count: everything a filter or a search redraws. */
  function timelineBodyHtml() {
    const all = log.events;
    const idx = visibleIndexes();
    const long = longClock();
    const replay = log.slot !== null && !log.provisional ? { ok: replayOk(), title: replayTitle() } : null;
    const tabs = FILTERS.map((f) => {
      let n = 0;
      all.forEach((e, i) => { if (f.test(e, i)) n += 1; });
      return { f, n };
    }).filter(({ f, n }) => f.always || n > 0);
    const rows = idx.map((i) => rowHtml(all[i], i, long, replay)).join('');
    return `
        <nav class="rl-tabs" aria-label="Which events to show">
          ${tabs.map(({ f, n }) => `<button type="button" data-rlfilter="${f.id}" data-active="${String(f.id === filter)}">${
            f.dot ? `<i data-dot="${f.dot}"></i>` : ''}${f.label}<span>${n}</span></button>`).join('')}
        </nav>
        ${idx.length ? `
        <div class="rv-sheet__scroll rl-tl__scroll">
          <table class="rv-sheet rv-log__table">
            <thead><tr><th>Lap</th><th>Time</th><th>Type</th><th>Event</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>` : `<p class="rv-card__note rl-tl__none">${query ? 'Nothing in this race matches that.' : 'Nothing of that kind in this race.'}</p>`}`;
  }

  function timelineHtml() {
    return `
      <section class="rv-card rl-timeline">
        <div class="rl-card__head">
          <h3>Event timeline</h3>
          <input class="rl-search" type="search" placeholder="Search events" aria-label="Search the timeline"
                 value="${esc(query)}" data-rlquery />
          <button type="button" class="btn btn--ghost btn--sm" data-rlcopy
                  title="Copy the lines below as plain text, for a protest or a Discord post">
            <svg class="icon"><use href="#i-copy" /></svg><span data-rlcopylabel>Copy as text</span>
          </button>
        </div>
        <div class="rl-tl__body">${timelineBodyHtml()}</div>
      </section>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  The event picked                                                      */
  /* ---------------------------------------------------------------------- */

  /** Whether this log's Replay buttons can be pressed at all. */
  function replayOk() {
    return !!log && avail.state === 'yes' && log.slot !== null && !log.provisional;
  }

  /**
   * Why a Replay button is greyed, or what it does. The same sentences the
   * replay controller answers with, so the tooltip and the card agree. A
   * `blocked` race keeps its buttons live: nothing tells the panel when the
   * driver leaves the session, and a greyed button would stay grey after.
   */
  function replayTitle() {
    if (avail.state === 'checking') return 'Asking the game whether it still has this race’s replay…';
    if (avail.state === 'no') {
      if (avail.message) return avail.message;
      return avail.reason === 'game-offline'
        ? 'Le Mans Ultimate isn’t running, so its replays can’t be opened.'
        : 'This race’s replay has been replaced by the game.';
    }
    if (log && status && status.phase === 'blocked' && status.raceId === log.id) {
      return status.message || 'Leave your session to watch the replay.';
    }
    return 'Open the game’s replay 5 s before this';
  }

  /** `[label, value]` pairs that say more than the sentence does, per kind. */
  function detailRows(e) {
    const d = e.detail || {};
    const rows = [];
    switch (e.kind) {
      case 'contact':
        if (d.severity) rows.push(['Severity', d.severity === 'heavy' ? 'Heavy contact' : 'Light contact']);
        if (d.otherName) rows.push(['Other car', `${d.otherName}${d.otherNumber ? ` (#${d.otherNumber})` : ''}`]);
        else if (d.scenery) rows.push(['Hit', d.scenery]);
        break;
      case 'limits':
        if (d.verdict) rows.push(['Verdict', d.verdict]);
        if (known(d.warningPoints) && d.warningPoints > 0) {
          rows.push(['Points', known(d.pointsLimit) ? `${d.warningPoints} of ${d.pointsLimit}` : String(d.warningPoints)]);
        }
        break;
      case 'penalty':
        if (d.penaltyKind) rows.push(['Penalty', d.penaltyKind]);
        if (d.reason) rows.push(['Reason', d.reason]);
        break;
      case 'damage':
        if (d.grade && d.grade !== 'none') rows.push(['Grade', d.grade[0].toUpperCase() + d.grade.slice(1)]);
        if (Array.isArray(d.zones) && d.zones.length) rows.push(['Where', d.zones.join(', ')]);
        break;
      case 'position':
      case 'start':
      case 'finish':
        if (known(d.position)) rows.push([log.multiclass ? 'Overall' : 'Place', pos(d.position)]);
        if (log.multiclass && known(d.classPosition)) rows.push([className(log.carClass) || 'Class', pos(d.classPosition)]);
        break;
      case 'lap':
        if (d.invalid) rows.push(['Status', 'Invalid lap']);
        else if (d.classBest) rows.push(['Status', 'Fastest in class so far']);
        else if (d.personalBest) rows.push(['Status', 'Personal best']);
        if (known(d.excursions) && d.excursions) rows.push(['Off track', `${d.excursions}, no action`]);
        break;
      default:
        break;
    }
    return rows;
  }

  /**
   * The lap before, the lap it happened on, and the lap after: what a moment
   * cost, which is usually the first thing anyone asks of a contact.
   */
  function lapContextHtml(e) {
    if (!facts || !(e.lap > 0) || e.kind === 'start') return '';
    const at = (n) => facts.laps.get(n);
    const here = at(e.lap);
    const cells = [
      ['Lap before', at(e.lap - 1), null],
      [e.kind === 'lap' ? 'This lap' : `Lap ${e.lap}`, here, at(e.lap - 1)],
      ['Lap after', at(e.lap + 1), null],
    ];
    if (!cells.some(([, l]) => l && known(l.ms))) return '';
    return `
      <div class="rl-lapctx">
        ${cells.map(([label, l, before]) => {
          const ms = l && known(l.ms) ? l.ms : null;
          const gap = ms !== null && before && known(before.ms) && !l.invalid && !before.invalid ? ms - before.ms : null;
          return `
          <div>
            <span>${esc(label)}</span>
            <b${l && l.invalid ? ' data-invalid="true"' : ''}>${ms !== null ? fmtLap(ms) : dash}</b>
            ${gap !== null && Math.abs(gap) >= 1 ? `<i data-dir="${gap > 0 ? 'loss' : 'gain'}">${fmtGap(gap)}</i>` : ''}
          </div>`;
        }).join('')}
      </div>`;
  }

  /** The replay, for the event picked: the button, or how far the game has got. */
  function replayBlockHtml(e, i) {
    if (!log || log.slot === null || log.provisional) {
      return log && log.provisional
        ? '<p class="rl-replay__why">No replay: the game did not save this race.</p>' : '';
    }
    if (!isIncident(e)) return '';
    const mineNow = !!asked && asked.raceId === log.id && asked.index === i;
    const st = status && (status.raceId === log.id || (!status.raceId && mineNow)) ? status : null;
    let line = '';
    if (busy && busy.raceId === log.id) {
      const p = status && status.phase === 'loading' && known(status.progress) ? Math.round(status.progress * 100) : null;
      line = `<p class="rl-replay__state" data-phase="busy">Another replay is loading${p !== null ? ` · ${p}%` : '.'} Press Replay again once it is in the game.</p>`;
    } else if (st && mineNow) {
      switch (st.phase) {
        case 'loading': {
          if (st.jump) { line = '<p class="rl-replay__state" data-phase="loading">Jumping…</p>'; break; }
          const p = known(st.progress) ? Math.round(st.progress * 100) : null;
          const closing = st.message && /^Closing/.test(st.message);
          line = `<p class="rl-replay__state" data-phase="loading">${esc(closing ? st.message : `Loading the replay in the game${p !== null ? ` · ${p}%` : '…'}`)}</p>
            ${closing ? '' : `<div class="rv-bar"><span style="width:${Math.max(2, p || 0)}%"></span></div>
            <p class="rl-replay__why">Big replays take up to a minute.</p>`}`;
          break;
        }
        case 'ready':
          line = '<p class="rl-replay__state" data-phase="ready">In the game now, 5 s before this. Jumps within this race are instant.</p>';
          break;
        case 'blocked':
        case 'unavailable':
        case 'error':
          line = `<p class="rl-replay__state" data-phase="${esc(st.phase)}">${esc(st.message || replayTitle())}</p>`;
          break;
        default:
          line = st.message ? `<p class="rl-replay__state">${esc(st.message)}</p>` : '';
      }
    }
    let why = '';
    if (avail.state === 'no') {
      why = `<p class="rl-replay__why">${esc(avail.reason === 'game-offline'
        ? 'Start Le Mans Ultimate to watch this moment in its replay.'
        : 'The game no longer keeps this race’s replay.')}${avail.reason === 'game-offline'
        ? ' <button type="button" class="rv-refbtn" data-rlrecheck>Check again</button>' : ''}</p>`;
    } else if (avail.state === 'checking') {
      why = '<p class="rl-replay__why">Asking the game for this race’s replay…</p>';
    }
    return `
      <div class="rl-replay">
        <button type="button" class="btn btn--sm rl-replay__go" data-replay="${i}"${replayOk() ? '' : ' disabled'}
                title="${esc(replayTitle())}">
          <svg class="icon"><use href="#i-play" /></svg><span>${mineNow && st && st.phase === 'ready' ? 'Replay again' : 'Open game replay'}</span>
        </button>
        ${line}${why}
      </div>`;
  }

  function eventHtml() {
    if (!log) return '';
    const vis = visibleIndexes();
    const e = cursor >= 0 ? log.events[cursor] : null;
    if (!e) {
      const clean = !facts.count.contact && !facts.count.limits && !facts.count.penalty;
      return `
      <section class="rv-card rl-event" data-empty="true">
        <h3>Event details</h3>
        <p class="rv-card__note">${clean
          ? 'A clean race: no contacts, no limits calls, no penalties. Pick any line in the timeline to see it here.'
          : 'Pick a line in the timeline, or a marker on the chart, to see it here.'}</p>
      </section>`;
    }
    const k = vis.indexOf(cursor);
    const at = [e.lap > 0 ? `Lap ${e.lap}` : '', fmtRace(e.raceS, longClock()) !== dash ? `${fmtRace(e.raceS, longClock())} into the race` : '']
      .filter(Boolean).join(' · ');
    const rows = detailRows(e);
    const prev = k > 0 ? vis[k - 1] : -1;
    const next = k >= 0 && k < vis.length - 1 ? vis[k + 1] : -1;
    const head = e.kind === 'lap' && e.detail && known(e.detail.lapMs)
      ? `Lap ${e.lap} · ${fmtLap(e.detail.lapMs)}` : e.text;
    return `
      <section class="rv-card rl-event">
        <div class="rl-event__top">
          <h3>Event details</h3>
          ${k >= 0 ? `<span class="rl-event__of">${k + 1} of ${vis.length}</span>` : ''}
        </div>
        ${kindHtml(e)}
        <p class="rl-event__text">${esc(head)}</p>
        ${at ? `<p class="rl-event__at">${esc(at)}</p>` : ''}
        ${rows.length ? `<dl class="rl-event__rows">${rows.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>` : ''}
        ${lapContextHtml(e)}
        ${replayBlockHtml(e, cursor)}
        <div class="rl-event__nav">
          <button type="button" class="btn btn--ghost btn--sm" data-rlnav="-1"${prev < 0 ? ' disabled' : ''} title="The line above ( ↑ )">
            <svg class="icon"><use href="#i-chevron-left" /></svg><span>Previous</span>
          </button>
          <button type="button" class="btn btn--ghost btn--sm" data-rlnav="1"${next < 0 ? ' disabled' : ''} title="The line below ( ↓ )">
            <span>Next</span><svg class="icon"><use href="#i-chevron-right" /></svg>
          </button>
        </div>
      </section>`;
  }

  const MATCHED = {
    laplog: 'Matched to your lap log.',
    name: 'Matched by your driver name.',
    picked: 'You picked this car.',
  };

  function sessionHtml(l) {
    const rows = [];
    if (l.drivers && l.drivers.length) rows.push([l.drivers.length > 1 ? 'Drivers' : 'Driver', andList(l.drivers)]);
    if (l.vehicle) rows.push(['Car', l.vehicle]);
    if (l.carClass) rows.push(['Class', className(l.carClass)]);
    rows.push(['Track', l.track || dash]);
    const how = l.provisional
      ? 'Provisional: the game did not save results for this race, so this is what Apex recorded live.'
      : (l.matchedBy && MATCHED[l.matchedBy]) || '';
    return `
      <section class="rv-card rl-session">
        <h3>Session details</h3>
        <dl class="rl-event__rows">${rows.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>
        ${how || (!l.provisional && Array.isArray(l.cars) && l.cars.length) ? `
        <p class="rv-card__note rl-session__how">${esc(how)}
          ${!l.provisional && Array.isArray(l.cars) && l.cars.length
            ? '<button type="button" class="rv-refbtn" data-rlrepick>Not your car?</button>' : ''}</p>` : ''}
      </section>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  Which car was yours                                                   */
  /* ---------------------------------------------------------------------- */

  function pickerHtml(l) {
    const cars = (l.cars || []).slice().sort((a, b) =>
      (known(a.finishPosition) ? a.finishPosition : 999) - (known(b.finishPosition) ? b.finishPosition : 999));
    const rows = cars.map((c) => `
      <tr data-pick="${c.slot}" tabindex="0" role="button" data-current="${String(c.slot === l.slot)}">
        <td class="num">${pos(c.finishPosition)}</td>
        <td class="num">${l.multiclass ? pos(c.finishClassPosition) : ''}</td>
        <td class="who">${esc(c.carNumber ? `#${c.carNumber}` : '')}</td>
        <td class="car">${esc(className(c.carClass))}</td>
        <td class="drv">${esc((c.drivers || []).join(', '))}</td>
        <td class="ref"><button type="button" class="rv-refbtn" data-pick-btn="${c.slot}">${c.slot === l.slot ? 'Current' : 'Mine'}</button></td>
      </tr>`).join('');
    return `
      <div class="rv-card rv-log">
        <div class="rv-card__head">
          <span class="rv-card__title">Which car was yours?</span>
          ${repick ? '<button type="button" class="btn btn--ghost btn--sm" data-rlrepickcancel><svg class="icon"><use href="#i-x" /></svg><span>Cancel</span></button>' : ''}
        </div>
        <p class="rv-card__note rv-log__pickwhy">${repick
          ? 'Pick the car you drove. Apex remembers it for this race.'
          : 'Apex could not match this race to your lap log or your driver name. Pick the car you drove and it is remembered for this race.'}</p>
        <div class="rv-sheet__scroll rv-log__scroll">
          <table class="rv-sheet rv-log__pick">
            <thead><tr><th>Pos</th><th>${l.multiclass ? 'In class' : ''}</th><th>Car</th><th>Class</th><th>Drivers</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${picking ? '<p class="rv-card__note">Saving…</p>' : ''}
      </div>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  Drawing                                                               */
  /* ---------------------------------------------------------------------- */

  function render() {
    if (!host || !host.detail) return;
    const el = host.detail;
    const summary = races.find((r) => r.id === openId) || null;

    if (!openId) {
      el.innerHTML = listState === 'loading'
        ? emptyState('clock', 'Reading the game’s results…', 'The first time takes a moment: every race on this PC is read once, then remembered.')
        : races.length
          ? emptyState('flag', 'Pick a race', 'Choose one on the left to read it back, lap by lap and incident by incident.')
          : emptyState('flag', 'No races yet',
            'Le Mans Ultimate saves a results file after every race it finishes. Race online or offline and it lands here, '
            + 'with every contact, limits verdict and penalty on your car.');
      return;
    }
    if (reading && !log) {
      el.innerHTML = `<div class="rv-card rl-hero">${headHtml(null, summary)}</div>${emptyState('clock', 'Reading the race…', 'One moment.')}`;
      return;
    }
    if (!log) {
      el.innerHTML = `<div class="rv-card rl-hero">${headHtml(null, summary)}</div>${emptyState('alert', 'This race could not be read',
        esc(readError || 'The results file is missing or unreadable. The game may have removed it.'))}`;
      return;
    }
    if (log.slot === null || repick) {
      el.innerHTML = `<div class="rv-card rl-hero">${headHtml(log, summary)}</div>${pickerHtml(log)}`;
      return;
    }
    el.innerHTML = `
      <section class="rv-card rl-hero">
        ${headHtml(log, summary)}
        ${tilesHtml(log)}
      </section>
      ${progressHtml(log)}
      <div class="rl-split">
        ${timelineHtml()}
        <aside class="rl-side">
          ${eventHtml()}
          ${sessionHtml(log)}
        </aside>
      </div>`;
    paintChart();
  }

  /** Redraw what a filter or a search changes: the tabs, the table, the card. */
  function renderTimeline() {
    if (!host || !host.detail || !log) return;
    const body = host.detail.querySelector('.rl-tl__body');
    if (!body) { render(); return; }
    body.innerHTML = timelineBodyHtml();
    renderSide();
  }

  /** Redraw the details card alone: a selection or a replay push. */
  function renderSide() {
    if (!host || !host.detail || !log || log.slot === null || repick) return;
    const old = host.detail.querySelector('.rl-event');
    if (old) old.outerHTML = eventHtml();
  }

  /** A replay push: the card, the buttons' tooltips and the marked rows, in place. */
  function renderStatus() {
    if (!host || !host.detail || !log || log.slot === null || repick) return;
    renderSide();
    // A blocked answer changes what the buttons' tooltips should say.
    const title = replayTitle();
    for (const b of host.detail.querySelectorAll('.rv-log__table [data-replay]')) b.title = title;
    markRows();
  }

  /**
   * Mark the row being replayed and the selected row, in place — a status
   * push or a key press must not rebuild two hundred rows.
   */
  function markRows() {
    if (!host || !host.detail || !log) return;
    const body = host.detail.querySelector('.rv-log__table tbody');
    if (!body) return;
    const on = asked && asked.raceId === log.id ? asked.index : -1;
    for (const tr of body.children) {
      const i = Number(tr.dataset.ev);
      if (i === on) tr.setAttribute('data-asked', 'true');
      else tr.removeAttribute('data-asked');
      if (i === cursor) tr.setAttribute('data-cursor', 'true');
      else tr.removeAttribute('data-cursor');
    }
  }

  /**
   * Bring a row into view. `centre` for a jump that can land two hundred
   * rows away; the least scroll that shows it for a move of one row, so the
   * page does not lurch on every key.
   */
  function reveal(i, centre) {
    if (!host || !host.detail) return;
    const tr = host.detail.querySelector(`.rv-log__table tr[data-ev="${i}"]`);
    if (!tr) return;
    const sc = tr.closest('.content');
    if (!sc) {
      tr.scrollIntoView({ block: centre ? 'center' : 'nearest' });
      return;
    }
    const box = sc.getBoundingClientRect();
    const head = tr.closest('table') && tr.closest('table').querySelector('thead');
    const top = Math.max(box.top, head ? head.getBoundingClientRect().bottom : box.top) + 8;
    const bottom = box.bottom - 8;
    const r = tr.getBoundingClientRect();
    if (r.top >= top && r.bottom <= bottom) return;
    if (centre) sc.scrollTop += r.top + r.height / 2 - (top + bottom) / 2;
    else if (r.top < top) sc.scrollTop -= top - r.top;
    else sc.scrollTop += r.bottom - bottom;
  }

  /**
   * Make one event the selected one, everywhere it shows. If the timeline's
   * filter hides it (a marker clicked on the chart), the filter widens to
   * Key moments, or to All events when even that would hide it.
   */
  function select(i, how = {}) {
    if (!log || !log.events[i]) return;
    cursor = i;
    if (!visibleIndexes().includes(i)) {
      query = '';
      const input = host && host.detail && host.detail.querySelector('[data-rlquery]');
      if (input) input.value = '';
      filter = isKey(log.events[i], i) ? 'key' : 'all';
      renderTimeline();
    } else {
      markRows();
      renderSide();
    }
    paintChart();
    if (how.reveal) reveal(i, !!how.centre);
  }

  /* ---------------------------------------------------------------------- */
  /*  Stepping                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * The incidents under the filter on screen, as indexes into `log.events`,
   * in race order. Under the filter because that is the steward's own
   * question: on Contacts, Next means the next contact.
   */
  function incidentIndexes() {
    if (!log) return [];
    return visibleIndexes().filter((i) => isIncident(log.events[i]));
  }

  /**
   * The incident one step before or after (`dir` -1 or 1) the selected row
   * — else the one last replayed — or -1 at either end. From nothing, Next
   * is the first and Previous the last.
   */
  function stepTarget(dir) {
    const list = incidentIndexes();
    if (!list.length) return -1;
    const from = cursor >= 0 ? cursor : asked && log && asked.raceId === log.id ? asked.index : -1;
    if (from < 0) return dir > 0 ? list[0] : list[list.length - 1];
    if (dir > 0) {
      const n = list.find((i) => i > from);
      return n === undefined ? -1 : n;
    }
    for (let k = list.length - 1; k >= 0; k -= 1) if (list[k] < from) return list[k];
    return -1;
  }

  /** Replay the incident a step away, and select it. */
  function stepIncident(dir) {
    if (!replayOk()) return false;
    const i = stepTarget(dir);
    if (i < 0) return false;
    void replayAt(i);
    return true;
  }

  /** Whether this race's replay is in the game, so a step can jump it too. */
  const replayReady = () => !!log && !!status && status.phase === 'ready' && status.raceId === log.id && replayOk();

  /**
   * Move the selection through the rows on screen. With this race's replay
   * in the game a step onto an incident jumps the replay there too: the
   * Previous / Next of the old replay strip, kept.
   */
  function moveCursor(dir, centre = false) {
    if (!log) return false;
    const rows = visibleIndexes();
    if (!rows.length) return false;
    let k = rows.indexOf(cursor);
    if (k < 0) {
      // First press: start from the row being replayed, if it is showing.
      const from = asked && asked.raceId === log.id ? rows.indexOf(asked.index) : -1;
      k = from >= 0 ? from : dir > 0 ? -1 : rows.length;
    }
    k = Math.min(rows.length - 1, Math.max(0, k + dir));
    const i = rows[k];
    if (i === cursor) return true;
    if (centre && replayReady() && isIncident(log.events[i])) {
      void replayAt(i);
      return true;
    }
    select(i, { reveal: true, centre });
    return true;
  }

  /**
   * The tab's keys, from racelog-panel.js's document listener (which has
   * already made sure the tab is on screen and nothing is being typed in).
   * Returns whether the key was taken.
   */
  function onDocKey(evt) {
    if (!log || log.slot === null || repick || reading) return false;
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return false;
    const k = evt.key;
    let took = false;
    if (k === 'ArrowDown' || k === 'j' || k === 'J') took = moveCursor(1);
    else if (k === 'ArrowUp' || k === 'k' || k === 'K') took = moveCursor(-1);
    else if (k === ']') took = stepIncident(1);
    else if (k === '[') took = stepIncident(-1);
    else if (k === 'Enter') {
      const t = evt.target;
      // A focused button answers Enter itself.
      if (t && t.closest && t.closest('button, a, [role="button"]')) return false;
      if (cursor >= 0 && replayOk() && isIncident(log.events[cursor])) {
        void replayAt(cursor);
        took = true;
      }
    }
    if (took) evt.preventDefault();
    return took;
  }

  /* ---------------------------------------------------------------------- */
  /*  Copy as text                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * The lines on screen, as the plain text the plan's request was written in:
   * `m:ss  L3  CONTACT  Light contact with …`. One heading line first, because
   * a paste in a league channel needs to say which race it is.
   */
  function copyText() {
    if (!log) return '';
    const long = longClock();
    const shown = visibleEvents();
    const times = shown.map((e) => fmtRace(e.raceS, long, '-'));
    const tw = Math.max(0, ...times.map((t) => t.length));
    const laps = shown.map((e) => (e.lap > 0 ? `L${e.lap}` : '-'));
    const lw = Math.max(0, ...laps.map((t) => t.length));
    const kw = Math.max(0, ...shown.map((e) => (KIND_WORD[e.kind] || e.kind).length));
    const head = [
      log.track,
      // A date, never "Yesterday": the paste is read later, somewhere else.
      `${new Date(log.startedAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} ${clockLabel(log.startedAt)}`.trim(),
      [log.carNumber ? `#${log.carNumber}` : '', className(log.carClass)].filter(Boolean).join(' '),
    ].filter(Boolean).join(' · ');
    const lines = shown.map((e, i) =>
      `${times[i].padStart(tw)}  ${laps[i].padEnd(lw)}  ${(KIND_WORD[e.kind] || e.kind).toUpperCase().padEnd(kw)}  ${String(e.text || '').replace(/\s{2,}/g, ' ')}`);
    return [head, ...lines].join('\n');
  }

  async function copyNow(btn) {
    const text = copyText();
    let ok = false;
    try {
      if (window.apex && typeof window.apex.copy === 'function') {
        await window.apex.copy(text);
        ok = true;
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    const label = btn && btn.querySelector('[data-rlcopylabel]');
    if (!label) return;
    label.textContent = ok ? 'Copied' : 'Could not copy';
    if (copiedTimer) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      const again = host && host.detail && host.detail.querySelector('[data-rlcopylabel]');
      if (again) again.textContent = 'Copy as text';
    }, 1600);
  }

  /* ---------------------------------------------------------------------- */
  /*  Loading                                                               */
  /* ---------------------------------------------------------------------- */

  async function load() {
    if (listRead) return listRead;
    listState = 'loading';
    if (host && host.rerenderList) host.rerenderList();
    listRead = (async () => {
      try {
        const res = await window.apex.reviewRacelogs();
        races = res && Array.isArray(res.races) ? res.races : [];
        outlines = res && res.outlines && typeof res.outlines === 'object' ? res.outlines : {};
        listState = res && res.ok === false ? 'error' : 'ok';
      } catch {
        races = [];
        listState = 'error';
      }
    })();
    try { await listRead; } finally { listRead = null; }
    if (host && host.rerenderList) host.rerenderList();
    return races;
  }

  function subscribe() {
    if (!active || unsub || !window.apex || typeof window.apex.onReviewReplay !== 'function') return;
    unsub = window.apex.onReviewReplay((st) => {
      status = st || null;
      // The load that turned a click away has ended: say nothing more of it.
      if (busy && !(status && status.phase === 'loading' && status.raceId && status.raceId !== busy.raceId)) busy = null;
      renderStatus();
    });
  }

  function unsubscribe() {
    if (unsub) { try { unsub(); } catch { /* already gone */ } }
    unsub = null;
  }

  /**
   * Ask whether the game still has this race's replay. Repaints only what
   * the answer changes — the buttons and the card — so the driver's scroll
   * and search survive a return to the tab.
   */
  async function checkReplay(id) {
    const before = avail;
    let next;
    try {
      const res = await window.apex.reviewReplayAvailable({ raceId: id });
      next = res && res.available
        ? { state: 'yes', reason: '', message: '' }
        : { state: 'no', reason: (res && res.reason) || 'error', message: (res && res.message) || '' };
    } catch {
      next = { state: 'no', reason: 'error', message: '' };
    }
    if (id !== openId) return;
    avail = next;
    if (before.state !== next.state || before.reason !== next.reason) {
      if (host && host.detail && host.detail.querySelector('.rl-tl__body')) renderTimeline();
      else render();
    }
  }

  /** The row a race opens on: its first incident, else nothing. */
  function firstSelection() {
    const inc = incidentIndexes();
    return inc.length ? inc[0] : -1;
  }

  async function open(id) {
    if (!id) return;
    window.APEX_FEATURE_CATALOG?.note('action:review.racelog');
    openId = id;
    log = null;
    facts = null;
    readError = '';
    repick = false;
    cursor = -1;
    query = '';
    // A pick still in flight belongs to the race being left (pick() drops
    // its reply), so the new race's picker is not "Saving…".
    picking = false;
    reading = true;
    avail = { state: 'checking', reason: '', message: '' };
    subscribe();
    if (host && host.rerenderList) host.rerenderList();
    render();
    try {
      const res = await window.apex.reviewRacelog(id);
      if (id !== openId) return;
      log = (res && res.log) || null;
      if (!log && res && res.error) readError = res.error;
    } catch (err) {
      if (id !== openId) return;
      log = null;
      readError = String((err && err.message) || '');
    }
    reading = false;
    if (log) {
      facts = indexLog(log);
      if (!log.multiclass) focusRow = 'overall';
      cursor = firstSelection();
    }
    render();
    // Hidden while it read (the driver left the tab): shown() asks the game
    // on the way back instead.
    if (log && active) await askGame(id);
  }

  /**
   * The game's half of an open race: where the replay jump already is (a
   * load started from this race before the driver clicked away and back is
   * still that race's load) and whether the game still has this race's
   * replay. Only while the tab is on screen: these are the calls that reach
   * the game, and a panel that merely remembers the tab must not make them
   * at every launch.
   */
  async function askGame(id) {
    try {
      const res = await window.apex.reviewReplayStatus();
      if (id === openId && res && res.status) status = res.status;
    } catch {
      /* no status: the card says nothing of it until a push */
    }
    if (id !== openId || !log || !active) return;
    renderStatus();
    if (log.slot !== null && !log.provisional) await checkReplay(id);
  }

  async function pick(slot) {
    if (!log || picking) return;
    // The reply can be slow; the race it answers for may no longer be the
    // one on screen by then, and must not replace it. Same guard as open().
    const id = log.id;
    picking = true;
    render();
    let picked = null;
    try {
      const res = await window.apex.reviewRacelogPick({ id, slot });
      picked = (res && res.log) || null;
    } catch {
      /* the picker stays up; a second click tries again */
    }
    // The rail's card now has a finish position and counts to show, whichever
    // race is open now.
    void load();
    if (id !== openId) return;
    picking = false;
    repick = false;
    if (picked) {
      log = picked;
      facts = indexLog(log);
      cursor = firstSelection();
    }
    render();
    if (log && log.slot !== null && active) await checkReplay(id);
  }

  async function replayAt(index) {
    if (!log) return;
    const e = log.events[index];
    if (!e || !known(e.et) || log.slot === null) return;
    window.APEX_FEATURE_CATALOG?.note('action:review.replay');
    const id = log.id;
    const wasAsked = asked;
    asked = { raceId: id, et: e.et, raceS: e.raceS, lap: e.lap, kind: e.kind, index };
    busy = null;
    // Something on screen straight away: the answer can take a second, and a
    // click that does nothing visible gets clicked again. With this race's
    // replay already in the game it is a jump, not a load.
    const jump = !!status && status.phase === 'ready' && status.raceId === id;
    status = { phase: 'loading', raceId: id, progress: null, message: null, ...(jump ? { jump: true } : {}) };
    select(index, { reveal: true, centre: true });
    renderStatus();
    try {
      const res = await window.apex.reviewReplayOpen({ raceId: id, slot: log.slot, et: e.et });
      if (res && res.status && res.status.busy) {
        // Turned away: another race's load is running. Its status is the
        // true one, and this click neither asked nor moved anything.
        status = res.status;
        asked = wasAsked;
        busy = { raceId: id };
      } else if (res && res.status) {
        status = res.status;
      } else {
        status = { phase: 'error', raceId: id, progress: null, message: (res && res.error) || null };
      }
    } catch (err) {
      status = { phase: 'error', raceId: id, progress: null, message: String((err && err.message) || '') || null };
    }
    renderStatus();
  }

  /* ---------------------------------------------------------------------- */
  /*  Events                                                                */
  /* ---------------------------------------------------------------------- */

  /** Clicks in the Race log tab's detail column. */
  function onClick(evt) {
    const t = evt.target;
    const seg = t.closest('[data-rlfilter]');
    if (seg) {
      filter = seg.dataset.rlfilter;
      try { window.localStorage.setItem(FILTER_KEY, filter); } catch { /* the choice lasts the run */ }
      // The selection stays if the new filter shows it; otherwise the first
      // incident on screen, else nothing.
      if (!visibleIndexes().includes(cursor)) cursor = incidentIndexes()[0] ?? -1;
      renderTimeline();
      paintChart();
      const tl = host.detail.querySelector('.rl-timeline');
      if (seg.closest('.rl-tiles') && tl) tl.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const focus = t.closest('[data-rlfocus]');
    if (focus) {
      focusRow = focus.dataset.rlfocus;
      for (const b of host.detail.querySelectorAll('[data-rlfocus]')) b.dataset.active = String(b === focus);
      paintChart();
      return;
    }
    const rep = t.closest('[data-replay]');
    if (rep) {
      if (!rep.disabled) void replayAt(Number(rep.dataset.replay));
      return;
    }
    const nav = t.closest('[data-rlnav]');
    if (nav) {
      if (!nav.disabled) moveCursor(Number(nav.dataset.rlnav), true);
      return;
    }
    const copy = t.closest('[data-rlcopy]');
    if (copy) {
      void copyNow(copy);
      return;
    }
    if (t.closest('[data-rlrecheck]') && log) {
      avail = { state: 'checking', reason: '', message: '' };
      renderSide();
      void checkReplay(log.id);
      return;
    }
    if (t.closest('[data-rlrepick]')) {
      repick = true;
      render();
      return;
    }
    if (t.closest('[data-rlrepickcancel]')) {
      repick = false;
      render();
      return;
    }
    const pickRow = t.closest('[data-pick]');
    if (pickRow) {
      const slot = Number(pickRow.dataset.pick);
      if (log && repick && slot === log.slot) { repick = false; render(); return; }
      void pick(slot);
      return;
    }
    if (t.closest('.rl-chart canvas')) {
      const i = hitAt(evt);
      if (i >= 0) select(i, { reveal: true, centre: true });
      return;
    }
    const row = t.closest('.rv-log__table tr[data-ev]');
    if (row) select(Number(row.dataset.ev));
  }

  /** A picker row is a button, so it answers to Enter and Space like one. */
  function onKey(evt) {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const row = evt.target.closest && evt.target.closest('tr[data-pick]');
    if (!row) return;
    evt.preventDefault();
    void pick(Number(row.dataset.pick));
  }

  /** The timeline's search, as it is typed. */
  function onInput(evt) {
    const t = evt.target;
    if (!t || !t.matches || !t.matches('[data-rlquery]')) return;
    query = String(t.value || '').trim().toLowerCase();
    if (!visibleIndexes().includes(cursor)) cursor = visibleIndexes()[0] ?? -1;
    renderTimeline();
    paintChart();
  }

  /** A pointer over a chart marker says it can be clicked. */
  function onMove(evt) {
    const t = evt.target;
    if (!t || !t.matches || !t.matches('.rl-chart canvas')) return;
    t.style.cursor = hitAt(evt) >= 0 ? 'pointer' : '';
  }

  /**
   * The race log for a lap-log session, if the game saved one: a race that
   * started inside the session's span. Our laps and the results file are
   * written on the same PC, so the clocks agree to the second; twenty minutes
   * of slack covers a formation lap and a late first timed lap.
   */
  function forSession(s) {
    if (!s || !races.length) return null;
    const type = String(s.sessionType || '').toLowerCase();
    if (!type.startsWith('race')) return null;
    const from = Date.parse(s.startedAt) / 1000;
    const to = Date.parse(s.endedAt || s.startedAt) / 1000;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    let best = null;
    for (const r of races) {
      if (r.startedAt < from - 1200 || r.startedAt > to) continue;
      if (!best || Math.abs(r.startedAt - from) < Math.abs(best.startedAt - from)) best = r;
    }
    return best;
  }

  window.APEX_REVIEW_RACELOG = {
    /** racelog-panel.js hands over its detail column and a way to redraw the rail. */
    mount(h) {
      host = h;
      if (h && h.detail) {
        h.detail.addEventListener('input', onInput);
        h.detail.addEventListener('mousemove', onMove);
      }
    },
    load,
    open,
    render,
    listHtml,
    onClick,
    onKey,
    onDocKey,
    /** The chart re-fitted to its box, for a window resize. */
    repaint: paintChart,
    /** Review asks this to put a "Race log" button on a race session. */
    forSession,
    races: () => races,
    openId: () => openId,
    loading: () => listState === 'loading',
    /**
     * The Race log tab is on screen. The push feed resumes while a log is
     * open, and the game is asked afresh: pushes stopped while hidden, and
     * the game may have started or quit since.
     */
    shown() {
      active = true;
      if (!openId) return;
      subscribe();
      if (log && !reading) void askGame(openId);
    },
    /** Off the tab: nothing listens while nothing is shown. */
    hidden() {
      active = false;
      unsubscribe();
    },
    // The pure halves, for poking at from a console or a harness.
    _fmtRace: fmtRace,
    _copyText: copyText,
  };
})();
