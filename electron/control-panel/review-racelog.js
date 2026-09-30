/**
 * review-racelog.js — the race logs, painted.
 * -----------------------------------------------------------------------------
 * Phase 3 of docs/RACE-LOG-PLAN.md: every race LMU wrote a results file for,
 * as a list in a rail, and one race as a timeline — one line per event, race
 * time · lap · kind · what happened. Contacts, limits and penalties carry a
 * Replay button that loads the game's own replay of that race five seconds
 * before the moment (phase 4, `dist/server/lmuReplay.js`).
 *
 * ## Why a list of its own, and not a view on a session
 * A race log is built from the game's results XML, not from our lap files.
 * Most of the 200-odd races on a driver's PC predate Apex, or were driven with
 * it closed, and so have no session in Review to hang off. So the races are a
 * tab of their own — the Race log tab, hosted by racelog-panel.js. (Until
 * 2026-09-30 they sat behind a Sessions | Races switch in Review's rail, where
 * drivers never found them.) A race session in Review that DOES have a log
 * gets a "Race log" button in its header, which hands over to that tab.
 *
 * ## Going through a race's incidents
 * The job after an official race is a steward's: every contact, limit and
 * penalty, one after another. Once a replay is in the game the strip offers
 * Previous and Next incident, and the keys do the same without the mouse —
 * ↑ ↓ (or J K) move a row cursor, Enter replays that row, [ and ] step
 * through the incidents. The row being replayed is kept on screen.
 *
 * ## Why rows and not cards
 * A four-hour race is two hundred lines. It is read the way the lap sheet is
 * read — down a column of times — so it IS the lap sheet: the same table, the
 * same mono figures, the same purple and green. Colour is spent only where the
 * steward's eye needs to land: contacts and penalties in red, limits and
 * minor damage in amber, a lap's time in purple or green when it was a best.
 *
 * racelog-panel.js owns the rail and the detail column and hands both to this
 * file. Nothing here polls: the replay status is a push, subscribed while a
 * log is open and dropped the moment it is not. And nothing here reaches the
 * game (replay status, availability, the push) unless the tab is on screen —
 * racelog-panel.js says when, through `shown()` / `hidden()` — so a panel
 * that reopens on the Race log tab costs nothing until it is looked at.
 *
 * The position-by-lap line is painted by review-charts.js
 * (`drawPositions`), for the hex reason below.
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
  let listState = 'idle'; // idle | loading | ok | error
  let listRead = null;

  /** The race on screen. */
  let openId = null;
  let log = null;
  let reading = false;
  let readError = '';
  /** Showing "Which car was yours?" over a log that already has a car. */
  let repick = false;
  let picking = false;

  /**
   * The timeline's filter, remembered per viewer: a steward who always reads
   * Incidents lands on Incidents. The key keeps its `review.` name from when
   * the log lived in Review, so nobody's choice is lost to the move.
   */
  const FILTER_KEY = 'apex.review.racelogFilter';
  let filter = 'all';
  try {
    const saved = window.localStorage.getItem(FILTER_KEY);
    if (saved) filter = saved;
  } catch {
    /* storage off: All */
  }

  /**
   * The keyboard's row: an index into `log.events`, or -1 for none yet.
   * Moved by ↑ ↓ / J K, and by the incident steps, so Enter after a step
   * replays the row the driver can see is marked.
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
   * The tab is on screen with the rail on Races. Nothing asks the game
   * anything while it is not: no availability check, no status, no push.
   */
  let active = false;
  let unsub = null;
  let copiedTimer = null;

  /** Set by racelog-panel.js: `{ detail, rerenderList }`. */
  let host = null;
  /** The position line's painters, when review-charts.js is on the page. */
  const CHARTS = window.APEX_REVIEW_CHARTS || null;

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

  /** LMU's `FinishStatus`, in the words a driver would use. */
  function statusWords(s) {
    const v = String(s || '').trim();
    if (!v || /^none$/i.test(v)) return dash;
    if (/^finished/i.test(v)) return 'Finished';
    return v;
  }

  function andList(names) {
    const n = names.filter(Boolean);
    if (n.length <= 1) return n.join('');
    return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  }

  /* ---------------------------------------------------------------------- */
  /*  Kinds and filters                                                     */
  /* ---------------------------------------------------------------------- */

  const KIND_WORD = {
    start: 'Start', flag: 'Flag', lap: 'Lap', position: 'Position', contact: 'Contact',
    damage: 'Damage', limits: 'Limits', penalty: 'Penalty', pit: 'Pit', driver: 'Driver',
    finish: 'Finish',
  };

  /** The kinds a steward reads. Also what "Incidents" filters to. */
  const INCIDENT = new Set(['contact', 'damage', 'limits', 'penalty', 'flag']);

  /** The kinds a Replay button goes on: things that happened to the car at a moment. */
  const REPLAYABLE = new Set(['contact', 'damage', 'limits', 'penalty']);

  /** A line with a moment the replay can be put at: what the steps walk. */
  const isIncident = (e) => !!e && REPLAYABLE.has(e.kind) && known(e.et);

  /**
   * One question at a time, so a segmented control rather than tick boxes —
   * the same `.seg` every other tab filters with. A segment with nothing
   * behind it in this race is not drawn.
   */
  const FILTERS = [
    { id: 'all', label: 'All', kinds: null },
    { id: 'incidents', label: 'Incidents', kinds: INCIDENT },
    { id: 'contacts', label: 'Contacts', kinds: new Set(['contact']) },
    { id: 'penalties', label: 'Limits &amp; penalties', kinds: new Set(['limits', 'penalty']) },
    { id: 'positions', label: 'Positions', kinds: new Set(['start', 'position', 'finish']) },
    { id: 'laps', label: 'Laps', kinds: new Set(['lap']) },
    { id: 'pit', label: 'Pit &amp; drivers', kinds: new Set(['pit', 'driver']) },
    { id: 'flags', label: 'Flags', kinds: new Set(['flag']) },
  ];

  const filterOf = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

  function visibleEvents() {
    if (!log || !Array.isArray(log.events)) return [];
    const f = filterOf(filter);
    return f.kinds ? log.events.filter((e) => f.kinds.has(e.kind)) : log.events;
  }

  /** A penalty line that closes one off rather than hands one out. */
  const isServed = (e) => e.kind === 'penalty' && /^served\b/i.test(String(e.text || ''));

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
      default:
        return '';
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  The rail                                                              */
  /* ---------------------------------------------------------------------- */

  function matches(row, q) {
    if (!q) return true;
    return `${row.track} ${className(row.carClass)}`.toLowerCase().includes(q);
  }

  /** The race rows for the rail, day-headed like the sessions above them. */
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
      const mine = row.slot !== null && row.slot !== undefined;
      const cls = className(row.carClass);
      const where = mine
        ? `P${known(row.finishPosition) ? row.finishPosition : '?'}${
          known(row.finishClassPosition) && row.finishClassPosition !== row.finishPosition && cls
            ? ` · P${row.finishClassPosition} ${cls}` : ''}`
        : 'Which car?';
      const meta = mine
        ? [
          row.contacts ? `${row.contacts} contact${row.contacts === 1 ? '' : 's'}` : '',
          row.penalties ? `${row.penalties} penalt${row.penalties === 1 ? 'y' : 'ies'}` : '',
        ].filter(Boolean).join(' · ') || 'clean'
        : '';
      html += `
        <button class="rv__card" type="button" data-race="${esc(row.id)}" data-type="race"
                data-slot="${mine ? String(row.slot) : 'none'}"
                data-active="${String(row.id === openId)}">
          <b>${esc(row.track || 'Unknown circuit')}</b>
          <i>${esc([cls, clockLabel(row.startedAt)].filter(Boolean).join(' · '))}${
            row.provisional ? '<span class="rv-flag" data-why="provisional">provisional</span>' : ''}</i>
          <span class="rv__cardfoot">
            <span class="rv__cardtime" data-none="${String(!mine)}">${esc(where)}</span>
            <span class="rv__cardmeta">${esc(meta)}</span>
          </span>
        </button>`;
    }
    return html;
  }

  /* ---------------------------------------------------------------------- */
  /*  The log                                                               */
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
    const sub = l && l.slot !== null ? [l.vehicle, className(l.carClass)].filter(Boolean).join(' · ') : '';
    return `
      <div class="rv-head">
        <h2>${esc(track)}</h2>
        <span class="rv-pill rv-pill--race">Race</span>
        ${l && l.provisional ? '<span class="rv-pill">Provisional</span>' : ''}
        ${sub ? `<span class="rv-head__sub">${esc(sub)}</span>` : ''}
        <span class="rv-head__when">${esc(dayLabel(at))} · ${esc(clockLabel(at))}</span>
      </div>`;
  }

  function fact(label, value, extra = '') {
    return `<span class="rv-fact"><b>${esc(label)}</b><span data-none="${String(value === dash)}">${value}</span>${extra}</span>`;
  }

  /** `P12 → P8` and the places it came to, green or red. */
  function gridToFinish(grid, finish) {
    if (!known(finish)) return dash;
    if (!known(grid)) return pos(finish);
    const moved = grid - finish;
    const tag = moved
      ? ` <i class="rv-log__moved" data-dir="${moved > 0 ? 'gain' : 'loss'}">${moved > 0 ? '+' : '−'}${Math.abs(moved)}</i>`
      : '';
    return `${pos(grid)} → ${pos(finish)}${tag}`;
  }

  const MATCHED = {
    laplog: 'Matched to your lap log.',
    name: 'Matched by your driver name.',
    picked: 'You picked this car.',
  };

  function factsHtml(l) {
    const count = (k) => l.events.filter((e) => e.kind === k && !isServed(e)).length;
    const overall = gridToFinish(l.gridPosition, l.finishPosition);
    const cls = className(l.carClass);
    return `
      <div class="rv-log__facts">
        ${fact(l.multiclass ? 'Overall' : 'Grid to finish', overall)}
        ${l.multiclass && cls ? fact(cls, gridToFinish(l.gridClassPosition, l.finishClassPosition)) : ''}
        ${fact('Laps', known(l.laps) ? String(l.laps) : dash)}
        ${fact('Status', esc(statusWords(l.finishStatus)))}
        ${fact('Contacts', String(count('contact')))}
        ${fact('Limits', String(count('limits')))}
        ${fact('Penalties', String(count('penalty')))}
      </div>`;
  }

  /**
   * Where the car ran, lap by lap: `{ laps, rows: [{ label, pos[] }] }`, one
   * row overall and — in a multiclass race — one in class. `pos[n]` is the
   * place at the end of lap n (0 is the grid). The log only says so when it
   * CHANGED, so a place is held forward until the next line moves it, and
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
      const pos = [];
      let held = at.get(0);
      for (let n = 0; n <= last; n += 1) {
        if (at.has(n)) held = at.get(n);
        pos.push(held);
      }
      if (known(finish)) pos[last] = finish;
      return pos;
    };
    const overall = build('position', l.finishPosition);
    if (!overall) return null;
    const rows = [{ label: l.multiclass ? 'Overall' : 'Position', pos: overall }];
    if (l.multiclass) {
      const cls = build('classPosition', l.finishClassPosition);
      if (cls) rows.push({ label: className(l.carClass) || 'Class', pos: cls });
    }
    return { laps: last, rows };
  }

  function positionHtml(l) {
    const s = CHARTS && typeof CHARTS.drawPositions === 'function' ? positionSeries(l) : null;
    if (!s) return '';
    return `<div class="rv-chart rv-chart--pos" data-bands="${s.rows.length}"
                 role="img" aria-label="Position lap by lap"><canvas></canvas></div>`;
  }

  /** Paint the position line, if the log on screen has one. Cheap: a few dozen points. */
  function paintPositions() {
    if (!host || !host.detail || !CHARTS || !log) return;
    const canvas = host.detail.querySelector('.rv-chart--pos canvas');
    const s = canvas ? positionSeries(log) : null;
    if (s) CHARTS.drawPositions(canvas, s);
  }

  /** The quiet line under the facts: who drove, how we knew, and the replay. */
  function noteHtml(l) {
    const parts = [];
    if (l.drivers && l.drivers.length) parts.push(`Driven by ${esc(andList(l.drivers))}.`);
    if (l.provisional) {
      parts.push('Provisional: the game did not save results for this race, so this is what Apex recorded live.');
    } else if (l.matchedBy && MATCHED[l.matchedBy]) {
      parts.push(MATCHED[l.matchedBy]);
    }
    let replay = '';
    if (avail.state === 'yes') {
      replay = 'Replay opens the game’s own replay of this race, 5 s before the moment.';
    } else if (avail.state === 'no') {
      replay = avail.reason === 'game-offline'
        ? 'Start Le Mans Ultimate to watch these in its replay.'
        : 'Replay no longer kept by the game.';
    }
    return `
      <p class="rv-card__note rv-log__note">
        ${parts.join(' ')}
        ${replay ? `<span class="rv-log__replaynote" data-state="${avail.state}">${esc(replay)}</span>` : ''}
        ${avail.state === 'no' && avail.reason === 'game-offline'
          ? '<button type="button" class="rv-refbtn" data-rlrecheck>Check again</button>' : ''}
        ${!l.provisional && Array.isArray(l.cars) && l.cars.length
          ? '<button type="button" class="rv-refbtn" data-rlrepick>Not your car?</button>' : ''}
      </p>`;
  }

  /**
   * The replay's progress, pinned to the top of the page while it matters —
   * the button that started it may be two hundred rows down. Only for THIS
   * race: a replay loading for another race is that race's business.
   */
  function replayHtml() {
    const st = status;
    if (!log) return '';
    if (busy && busy.raceId === log.id) {
      const p = st && st.phase === 'loading' && known(st.progress) ? Math.round(st.progress * 100) : null;
      return `
      <div class="rv-replay" data-phase="busy" role="status">
        <span class="rv-replay__tag">Replay</span>
        <span class="rv-replay__text">Another replay is loading${p !== null ? ` · ${p}%` : '.'}</span>
        <span class="rv-replay__sub">Press Replay again once it is in the game.</span>
      </div>`;
    }
    if (!st) return '';
    const mine = st.raceId === log.id || (!st.raceId && asked && asked.raceId === log.id);
    if (!mine) return '';
    const at = asked && asked.raceId === log.id
      ? `${KIND_WORD[asked.kind] ? `${KIND_WORD[asked.kind].toLowerCase()} ` : ''}at ${fmtRace(asked.raceS, longClock())}${asked.lap ? `, lap ${asked.lap}` : ''}`
      : '';
    let text = '';
    let sub = '';
    let bar = '';
    let step = '';
    switch (st.phase) {
      case 'loading': {
        // A step or a click while this race's replay is already in the game:
        // a jump, a second or so, not a load — so no bar, and the steps stay
        // where the hand is.
        if (st.jump) {
          text = at ? `Jumping to the ${at}…` : 'Jumping…';
          step = stepHtml();
          break;
        }
        const p = known(st.progress) ? Math.round(st.progress * 100) : null;
        const closing = st.message && /^Closing/.test(st.message);
        text = closing ? st.message : `Loading the replay in the game${p !== null ? ` · ${p}%` : '…'}`;
        sub = 'Big replays take up to a minute.';
        bar = `<div class="rv-bar rv-replay__bar"><span style="width:${Math.max(2, p || 0)}%"></span></div>`;
        break;
      }
      case 'ready': {
        text = at ? `In the game now: 5 s before the ${at}.` : 'In the game now.';
        const list = incidentIndexes();
        const k = asked && asked.raceId === log.id ? list.indexOf(asked.index) : -1;
        sub = k >= 0
          ? `Incident ${k + 1} of ${list.length}. Jumps within this race are instant.`
          : 'Every other Replay in this race is a jump, not a reload.';
        step = stepHtml();
        break;
      }
      case 'blocked':
        text = st.message || 'Leave your session to watch the replay.';
        break;
      case 'unavailable':
        text = st.message || 'Replay no longer kept by the game.';
        break;
      case 'error':
        text = st.message || 'The game did not open the replay.';
        break;
      case 'idle':
        if (!st.message) return '';
        text = st.message;
        break;
      default:
        return '';
    }
    return `
      <div class="rv-replay" data-phase="${esc(st.phase)}"${st.jump ? ' data-jump="true"' : ''} role="status">
        <span class="rv-replay__tag">Replay</span>
        <span class="rv-replay__text">${esc(text)}</span>
        ${sub ? `<span class="rv-replay__sub">${esc(sub)}</span>` : ''}
        ${step}
        ${bar}
      </div>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  Stepping through the incidents                                        */
  /* ---------------------------------------------------------------------- */

  /** Whether this log's Replay buttons can be pressed at all. */
  function replayOk() {
    return !!log && avail.state === 'yes' && log.slot !== null && !log.provisional;
  }

  /**
   * The incidents under the filter on screen, as indexes into `log.events`,
   * in race order. Under the filter because that is the steward's own
   * question: on Contacts, Next means the next contact.
   */
  function incidentIndexes() {
    if (!log) return [];
    const all = log.events;
    return visibleEvents().filter(isIncident).map((e) => all.indexOf(e));
  }

  /**
   * The incident one step before or after (`dir` -1 or 1) the row the
   * driver is on — the keyboard's row, else the one last replayed — or -1 at
   * either end. From nothing, Next is the first and Previous the last.
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

  function stepHtml() {
    const prev = stepTarget(-1);
    const next = stepTarget(1);
    return `
        <span class="rv-replay__step">
          <button type="button" class="btn btn--ghost btn--sm" data-rlstep="-1"${prev < 0 ? ' disabled' : ''}
                  title="Replay the incident before this one ( [ )">
            <svg class="icon"><use href="#i-chevron-left" /></svg><span>Previous</span>
          </button>
          <button type="button" class="btn btn--ghost btn--sm" data-rlstep="1"${next < 0 ? ' disabled' : ''}
                  title="Replay the next incident ( ] )">
            <span>Next</span><svg class="icon"><use href="#i-chevron-right" /></svg>
          </button>
        </span>`;
  }

  /** Replay the incident a step away, and put the cursor on it. */
  function stepIncident(dir) {
    if (!replayOk()) return false;
    const i = stepTarget(dir);
    if (i < 0) return false;
    cursor = i;
    void replayAt(i);
    return true;
  }

  /**
   * Why a Replay button is greyed, or what it does. The same sentences the
   * replay controller answers with, so the tooltip and the strip agree. A
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

  /**
   * Mark the row being replayed and the keyboard's row, in place — a status
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
   * Bring a row into view below the sticky replay strip. `centre` for a step,
   * which can land two hundred rows away; the least scroll that shows it for
   * a cursor moving one row, so the page does not lurch on every key.
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
    const strip = host.detail.querySelector('.rv-replay');
    const top = Math.max(box.top, strip ? strip.getBoundingClientRect().bottom : box.top) + 8;
    const bottom = box.bottom - 8;
    const r = tr.getBoundingClientRect();
    if (r.top >= top && r.bottom <= bottom) return;
    if (centre) sc.scrollTop += r.top + r.height / 2 - (top + bottom) / 2;
    else if (r.top < top) sc.scrollTop -= top - r.top;
    else sc.scrollTop += r.bottom - bottom;
  }

  /** Move the keyboard's row through the rows on screen. */
  function moveCursor(dir) {
    if (!log) return false;
    const all = log.events;
    const rows = visibleEvents().map((e) => all.indexOf(e));
    if (!rows.length) return false;
    let k = rows.indexOf(cursor);
    if (k < 0) {
      // First press: start from the row being replayed, if it is showing.
      const from = asked && asked.raceId === log.id ? rows.indexOf(asked.index) : -1;
      k = from >= 0 ? from : dir > 0 ? -1 : rows.length;
    }
    k = Math.min(rows.length - 1, Math.max(0, k + dir));
    cursor = rows[k];
    markRows();
    reveal(cursor, false);
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

  /**
   * One line. `replay` is `null` for a log that can never replay (no car,
   * or a provisional log with no results file behind it), else
   * `{ ok, title }`: a race whose replay is gone or whose game is shut keeps
   * its buttons, greyed with the reason, so the feature stays findable.
   */
  function rowHtml(e, i, long, replay) {
    const tone = toneOf(e);
    const d = e.detail || {};
    const dir = e.kind === 'position' && known(d.gained) && d.gained
      ? ` data-dir="${d.gained > 0 ? 'gain' : 'loss'}"` : '';
    const btn = replay && isIncident(e);
    const on = !!asked && asked.raceId === log.id && asked.index === i;
    return `
      <tr data-ev="${i}" data-kind="${esc(e.kind)}"${tone ? ` data-tone="${tone}"` : ''}${dir}${
        on ? ' data-asked="true"' : ''}${i === cursor ? ' data-cursor="true"' : ''}>
        <td class="t">${fmtRace(e.raceS, long)}</td>
        <td class="l">${e.lap > 0 ? `L${e.lap}` : dash}</td>
        <td class="k">${esc(KIND_WORD[e.kind] || e.kind)}</td>
        <td class="x">${e.kind === 'lap' ? lapText(e) : esc(e.text)}</td>
        <td class="ref">${btn
          ? `<button type="button" class="rv-refbtn" data-replay="${i}"${replay.ok ? '' : ' disabled'}
                     title="${esc(replay.title)}">Replay</button>`
          : ''}</td>
      </tr>`;
  }

  function timelineHtml() {
    const all = log.events;
    const shown = visibleEvents();
    const long = longClock();
    const replay = log.slot !== null && !log.provisional ? { ok: replayOk(), title: replayTitle() } : null;
    const keys = replayOk() && shown.some(isIncident);
    const hasKind = (f) => !f.kinds || all.some((e) => f.kinds.has(e.kind));
    const segs = FILTERS.filter((f) => f.id === 'all' || f.id === 'incidents' || hasKind(f));
    const rows = shown.map((e) => rowHtml(e, all.indexOf(e), long, replay)).join('');
    return `
      <div class="rv-card rv-log">
        <div class="rv-card__head">
          <span class="rv-card__title">Timeline</span>
          <span class="rv-legend">${keys
            // The keys, said once and quietly, in the legend's own voice.
            ? '<span class="rv-log__keys">↑ ↓ to move · Enter to replay · [ ] previous and next incident</span>'
            : ''}<span>${shown.length === all.length
            ? `${all.length} event${all.length === 1 ? '' : 's'}`
            : `${shown.length} of ${all.length} events`}</span></span>
        </div>
        <div class="rv-log__bar">
          <nav class="seg seg--sm" aria-label="Which events to show">
            ${segs.map((f) => `<button type="button" data-rlfilter="${f.id}" data-active="${String(f.id === filter)}">${f.label}</button>`).join('')}
          </nav>
          <button type="button" class="btn btn--ghost btn--sm" data-rlcopy
                  title="Copy the lines below as plain text, for a protest or a Discord post">
            <svg class="icon"><use href="#i-copy" /></svg><span data-rlcopylabel>Copy as text</span>
          </button>
        </div>
        ${shown.length ? `
        <div class="rv-sheet__scroll rv-log__scroll">
          <table class="rv-sheet rv-log__table">
            <thead><tr><th>Time</th><th>Lap</th><th>Kind</th><th>Event</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>` : '<p class="rv-card__note">Nothing of that kind in this race.</p>'}
      </div>`;
  }

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
      el.innerHTML = `<div class="rv-card">${headHtml(null, summary)}</div>${emptyState('clock', 'Reading the race…', 'One moment.')}`;
      return;
    }
    if (!log) {
      el.innerHTML = `<div class="rv-card">${headHtml(null, summary)}</div>${emptyState('alert', 'This race could not be read',
        esc(readError || 'The results file is missing or unreadable. The game may have removed it.'))}`;
      return;
    }
    if (log.slot === null || repick) {
      el.innerHTML = `<div class="rv-card">${headHtml(log, summary)}</div>${pickerHtml(log)}`;
      return;
    }
    el.innerHTML = `
      <div class="rv-card">
        ${headHtml(log, summary)}
        ${factsHtml(log)}
        ${positionHtml(log)}
        ${noteHtml(log)}
      </div>
      ${replayHtml()}
      ${timelineHtml()}`;
    paintPositions();
  }

  /** Repaint only the status strip, so a progress push does not rebuild 200 rows. */
  function renderStatus() {
    if (!host || !host.detail || !log || log.slot === null || repick) return;
    const old = host.detail.querySelector('.rv-replay');
    const html = replayHtml();
    if (old && html) {
      old.outerHTML = html;
    } else if (old) {
      old.remove();
    } else if (html) {
      const tl = host.detail.querySelector('.rv-log');
      if (tl) tl.insertAdjacentHTML('beforebegin', html);
    }
    // A blocked answer changes what the buttons' tooltips should say.
    const title = replayTitle();
    for (const b of host.detail.querySelectorAll('[data-replay]')) b.title = title;
    markRows();
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
   * Ask whether the game still has this race's replay. Repaints only when the
   * answer changed: shown() asks again on every return to the tab, and a
   * repaint of an unchanged log would throw away the driver's scroll.
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
    if (before.state !== next.state || before.reason !== next.reason) render();
  }

  async function open(id) {
    if (!id) return;
    window.APEX_FEATURE_CATALOG?.note('action:review.racelog');
    openId = id;
    log = null;
    readError = '';
    repick = false;
    cursor = -1;
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
   * the game, and a panel that merely remembers the Races rail must not make
   * them at every launch.
   */
  async function askGame(id) {
    try {
      const res = await window.apex.reviewReplayStatus();
      if (id === openId && res && res.status) status = res.status;
    } catch {
      /* no status: the strip stays away until a push */
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
    // The rail's row now has a finish position and counts to show, whichever
    // race is open now.
    void load();
    if (id !== openId) return;
    picking = false;
    repick = false;
    if (picked) log = picked;
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
    cursor = index;
    busy = null;
    // Something on screen straight away: the answer can take a second, and a
    // click that does nothing visible gets clicked again. With this race's
    // replay already in the game it is a jump, not a load.
    const jump = !!status && status.phase === 'ready' && status.raceId === id;
    status = { phase: 'loading', raceId: id, progress: null, message: null, ...(jump ? { jump: true } : {}) };
    renderStatus();
    reveal(index, true);
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
      render();
      return;
    }
    const rep = t.closest('[data-replay]');
    if (rep) {
      if (!rep.disabled) void replayAt(Number(rep.dataset.replay));
      return;
    }
    const stepBtn = t.closest('[data-rlstep]');
    if (stepBtn) {
      if (!stepBtn.disabled) stepIncident(Number(stepBtn.dataset.rlstep));
      return;
    }
    const copy = t.closest('[data-rlcopy]');
    if (copy) {
      void copyNow(copy);
      return;
    }
    if (t.closest('[data-rlrecheck]') && log) {
      avail = { state: 'checking', reason: '', message: '' };
      render();
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
    }
  }

  /** A picker row is a button, so it answers to Enter and Space like one. */
  function onKey(evt) {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const row = evt.target.closest && evt.target.closest('tr[data-pick]');
    if (!row) return;
    evt.preventDefault();
    void pick(Number(row.dataset.pick));
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
    mount(h) { host = h; },
    load,
    open,
    render,
    listHtml,
    onClick,
    onKey,
    onDocKey,
    /** The position line re-fitted to its box, for a window resize. */
    repaint: paintPositions,
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
