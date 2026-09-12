/**
 * review-panel.js — the Review tab: every session you have driven.
 * -----------------------------------------------------------------------------
 * Phase 1 of docs/STINT-REVIEW-PLAN.md. A list of sessions on the left, and on
 * the right the one you picked: its report, its lap-time chart, and a
 * collapsible card per stint holding the lap sheet and the tyres it ended on.
 *
 * All of it is LOCAL. The lap files have been accumulating since August and
 * nothing here has to be uploaded, signed into or fetched — which is why this
 * phase is worth shipping before the cloud half exists. A driver who has never
 * made an account still opens this tab and finds their season in it.
 *
 * ## What is ours rather than the reference screens'
 * The recon in the plan is Coach Dave Delta. Three things are deliberately not
 * copied:
 *
 *   - **The session report is not a modal.** It is the top of the page. It is
 *     the thing the tab is for; putting it behind a button is a click charged
 *     for nothing.
 *   - **Consistency leads with seconds.** `±0.31 s` is the headline and the
 *     percentage only fills a bar behind it. A percentage with no unit is a
 *     score; a spread in seconds is a thing a driver can go and fix.
 *   - **A dirty lap says WHY.** The log records the reason — limits, pit,
 *     penalty — so the sheet prints it instead of quietly discounting the lap.
 *
 * ## Zero cost when hidden
 * Same contract as Setups and Team, enforced by the router in control-panel.js:
 * `shown()` re-reads the lap files and `hidden()` drops the chart's listeners.
 * There is no poll and there is no subscription — sessions land while the
 * driver is in the sim, not while they are looking at this window, so arriving
 * on the tab IS the refresh event.
 *
 * The two canvas painters live in review-charts.js, split off the same way
 * team-charts.js is split off team-panel.js — and NOT folded into
 * team-charts.js, which is copied verbatim into the web build where nothing
 * calls them yet.
 */

(function () {
  'use strict';

  const CHARTS = window.APEX_REVIEW_CHARTS;
  if (!CHARTS) return;

  const $ = (sel) => document.querySelector(sel);
  const dash = '—';

  /** What the painters print with, so the chart and the sheet cannot disagree. */
  const FMT = { fmtLap: null, dayLabel: null };

  const els = {
    career: null,
    view: null, search: null, filter: null, list: null, detail: null,
  };

  /** Session summaries, newest first, as `review:sessions` returned them. */
  let summaries = [];
  /** The session currently open, in full. */
  let current = null;
  let currentId = null;
  let loading = false;
  let loadedOnce = false;
  let visible = false;
  let tempUnit = 'c';
  /** Stint numbers the driver has collapsed on the open session. */
  const collapsed = new Set();
  /** Teardown for the lap chart's listeners, so a re-render never stacks them. */
  let chartOff = null;
  /** The same, for the lap-detail view's scrub. */
  let lapOff = null;
  /** The lap being studied, or null when the session is on screen. */
  let lapView = null;
  /** The circuit last shipped over the bridge, kept so clicking through the
   *  laps of one session does not re-send two thousand points every time. */
  let heldMap = null;
  let heldMapKey = '';
  let speedUnit = 'kph';
  /** The page has been found and wired. See init() for why this is checked. */
  let ready = false;
  /** The driver's whole history, from the same read as the sessions list. */
  let career = null;
  /**
   * The lap every other lap in this session is measured against.
   *
   * Chosen on the SESSION screen, from the sheet, because that is where a
   * driver is looking when they decide two laps are worth comparing — they
   * have just read the column of times. Picking it inside the lap view meant
   * opening a lap before you could say what to compare it with, which is the
   * wrong way round.
   *
   * Either one of the session's own laps (a ReviewLap from the sheet) or,
   * since 2026-09-12, a lap on the league leaderboard — a `boardRef`, see
   * `isBoardRef()`. Everything that prints the reference asks which.
   */
  let refLap = null;
  /** Whether the circuit is drawn full width under the charts. Per machine. */
  let bigMap = false;
  /**
   * The league board for the open session's circuit and class, fetched once
   * per session and kept: `{ key, state, rows, error }`. `state` is `idle`,
   * `loading`, `ok`, `signed-out` or `error`. Rows carry `track_id`,
   * `has_trace` and `has_line`, which is what decides whether a row can be
   * offered as a comparison at all.
   */
  let board = { key: '', state: 'idle', rows: [], error: '' };

  /* ---------------------------------------------------------------------- */
  /*  Formatting                                                            */
  /* ---------------------------------------------------------------------- */

  const known = (v) => typeof v === 'number' && Number.isFinite(v);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** `1:46.695`. The one format every timing screen in the sport agrees on. */
  function fmtLap(ms) {
    if (!known(ms) || ms <= 0) return dash;
    const m = Math.floor(ms / 60000);
    const s = (ms - m * 60000) / 1000;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  }

  /** A sector: seconds unless it is genuinely over a minute (Le Mans S1 is). */
  function fmtSector(ms) {
    if (!known(ms) || ms <= 0) return dash;
    if (ms < 60000) return (ms / 1000).toFixed(3);
    return fmtLap(ms);
  }

  /** A signed gap in seconds, always with its sign — `+0.712`, `-0.104`. */
  function fmtDelta(ms) {
    if (!known(ms)) return dash;
    const s = ms / 1000;
    return `${s >= 0 ? '+' : '-'}${Math.abs(s).toFixed(3)}`;
  }

  /** A duration a human reads as elapsed time: `1h 16m`, `23:32`, `48s`. */
  function fmtSpan(ms) {
    if (!known(ms) || ms <= 0) return dash;
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
    return `${s}s`;
  }

  const degrees = (c) =>
    known(c) ? `${Math.round(tempUnit === 'f' ? c * 1.8 + 32 : c)}°` : dash;

  const pct = (frac, dp = 0) => (known(frac) ? `${(frac * 100).toFixed(dp)}%` : dash);
  const fix = (v, dp) => (known(v) ? v.toFixed(dp) : dash);

  const SESSION_TYPES = {
    practice: 'Practice', qualifying: 'Qualifying', qualify: 'Qualifying',
    race: 'Race', warmup: 'Warm-up', test: 'Test', testday: 'Test day',
  };
  const typeName = (t) => SESSION_TYPES[String(t || '').toLowerCase()] || (t || 'Session');
  const typeKey = (t) => {
    const k = String(t || '').toLowerCase();
    if (k.startsWith('qual')) return 'qualifying';
    if (k.startsWith('race')) return 'race';
    if (k.startsWith('prac')) return 'practice';
    return 'other';
  };

  const DAY_FMT = { weekday: 'short', day: 'numeric', month: 'short' };
  const TIME_FMT = { hour: '2-digit', minute: '2-digit' };

  /** `Today`, `Yesterday`, or `Sat 6 Sep` — a list is scanned, not read. */
  function dayLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Unknown date';
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    const opts = d.getFullYear() === new Date().getFullYear()
      ? DAY_FMT
      : { ...DAY_FMT, year: 'numeric' };
    return d.toLocaleDateString(undefined, opts);
  }

  const clockLabel = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, TIME_FMT);
  };

  /* ---------------------------------------------------------------------- */
  /*  The session list                                                      */
  /* ---------------------------------------------------------------------- */

  /* ---------------------------------------------------------------------- */
  /*  Everything, ever                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * The driver's own totals, across the top of the page.
   *
   * It sits above the session list rather than inside a session because it is
   * the one thing here that is not about a session: it is the answer to "how
   * much have I actually done", which is the question a driver asks first and
   * which no single card below can answer. Derived from the same read of the
   * lap log the list comes from, so it cannot drift out of step with what is
   * underneath it.
   */
  function careerHtml() {
    if (!career || !career.laps) return '';
    const miles = speedUnit === 'mph';
    const distance = career.distanceM / (miles ? 1609.344 : 1000);
    const hours = career.driveMs / 3_600_000;

    const stat = (icon, value, unit, label) => `
      <div class="rv-stat">
        <svg class="icon"><use href="#i-${icon}" /></svg>
        <span class="rv-stat__value">${value}<u>${esc(unit)}</u></span>
        <span class="rv-stat__label">${esc(label)}</span>
      </div>`;

    // Thousands of laps and tens of thousands of kilometres are the normal
    // case after a season, so the big numbers are grouped rather than left as
    // an unreadable run of digits.
    const group = (n) => Math.round(n).toLocaleString();
    const top = [
      career.topTracks[0] ? `${career.topTracks[0].name} (${career.topTracks[0].laps} laps)` : '',
      career.topCars[0] ? `${career.topCars[0].name} (${career.topCars[0].laps} laps)` : '',
    ].filter(Boolean).join(' · ');

    return `
      <div class="rv-career">
        <div class="rv-career__head">
          <span class="rv-career__title">Everything you have driven</span>
          <span class="rv-career__sub">${
            career.firstAt ? `since ${esc(dayLabel(career.firstAt))}` : ''
          }${career.days ? ` · ${career.days} day${career.days === 1 ? '' : 's'} with laps` : ''}</span>
        </div>
        <div class="rv-career__stats">
          ${stat('flag', group(career.laps), '', `laps${
            career.cleanLaps ? `, ${group(career.cleanLaps)} clean` : ''
          }`)}
          ${stat('orbit', group(distance), miles ? 'mi' : 'km', 'distance')}
          ${stat('clock', hours >= 10 ? group(hours) : hours.toFixed(1), 'h', 'at the wheel')}
          ${stat('circuit', String(career.tracks), '', `circuit${career.tracks === 1 ? '' : 's'}`)}
          ${stat('gauge', String(career.cars), '', `car${career.cars === 1 ? '' : 's'}`)}
          ${stat('list-ordered', group(career.sessions), '', 'sessions')}
        </div>
        ${top ? `<div class="rv-career__top">Most laps: ${esc(top)}</div>` : ''}
      </div>`;
  }

  function renderCareer() {
    if (els.career) els.career.innerHTML = careerHtml();
  }

  function matchesFilter(row) {
    const type = els.filter ? els.filter.value : 'all';
    if (type !== 'all' && typeKey(row.sessionType) !== type) return false;
    const q = (els.search ? els.search.value : '').trim().toLowerCase();
    if (!q) return true;
    return `${row.track} ${row.car} ${row.carClass}`.toLowerCase().includes(q);
  }

  function renderList() {
    if (!els.list) return;
    const rows = summaries.filter(matchesFilter);

    if (!rows.length) {
      els.list.innerHTML = `<p class="rv-empty" style="padding:20px 14px">${
        summaries.length ? 'No session matches that.' : 'No sessions yet.'
      }</p>`;
      return;
    }

    let html = '';
    let day = '';
    for (const row of rows) {
      const d = dayLabel(row.startedAt);
      if (d !== day) {
        day = d;
        html += `<div class="rv__day">${esc(d)}</div>`;
      }
      const laps = `${row.laps} lap${row.laps === 1 ? '' : 's'}`;
      const stints = row.stints > 1 ? ` · ${row.stints} stints` : '';
      html += `
        <button class="rv__card" type="button" data-session="${esc(row.id)}"
                data-type="${typeKey(row.sessionType)}"
                data-active="${String(row.id === currentId)}">
          <b>${esc(row.track || 'Unknown circuit')}</b>
          <i>${esc([row.car, row.carClass].filter(Boolean).join(' · ') || typeName(row.sessionType))}</i>
          <span class="rv__cardfoot">
            <span class="rv__cardtime" data-none="${String(!known(row.bestMs))}">${
              known(row.bestMs) ? fmtLap(row.bestMs) : 'no clean lap'
            }</span>
            <span class="rv__cardmeta">${esc(laps + stints)}</span>
          </span>
        </button>`;
    }
    els.list.innerHTML = html;
  }

  /* ---------------------------------------------------------------------- */
  /*  The session report                                                    */
  /* ---------------------------------------------------------------------- */

  /** The consistency bar's band. Below 40 is a stint that got away from you. */
  const consistencyBand = (v) => (v >= 70 ? 'high' : v >= 40 ? 'mid' : 'low');

  function tile(label, value, opts = {}) {
    const none = value === dash || value == null;
    return `
      <div class="rv-tile${opts.tone ? ` rv-tile--${opts.tone}` : ''}">
        <div class="rv-tile__label">${esc(label)}</div>
        <div class="rv-tile__value" data-none="${String(none)}">${value == null ? dash : value}</div>
        ${opts.note ? `<div class="rv-tile__note">${opts.note}</div>` : ''}
        ${opts.bar !== undefined && known(opts.bar)
          ? `<div class="rv-bar" data-band="${consistencyBand(opts.bar)}">
               <span style="width:${Math.max(2, Math.min(100, opts.bar))}%"></span>
             </div>`
          : ''}
      </div>`;
  }

  /**
   * The one line under the best lap. It answers the question a driver actually
   * has when they see their time: was that any good *for me*? Comparing to
   * their own record is the only comparison we can make honestly offline —
   * against the field is what phase 4 buys.
   */
  function heroNote(s) {
    if (!known(s.stats.bestMs)) {
      return `<span class="rv-hero__note">No clean lap in this session</span>`;
    }
    if (s.pbHere || !known(s.pbMs)) {
      return `<span class="rv-hero__note" data-tone="pb">
        <svg class="icon"><use href="#i-trophy" /></svg>Your best here${
          s.carClass ? ` in ${esc(s.carClass)}` : ''
        }
      </span>`;
    }
    const off = s.stats.bestMs - s.pbMs;
    return `<span class="rv-hero__note" data-tone="off">
      <svg class="icon"><use href="#i-target" /></svg>${fmtDelta(off)} off your ${fmtLap(s.pbMs)}
    </span>`;
  }

  /** "3 laps lost to track limits" — the plan's more-specific-than-Delta note. */
  const DIRTY_WORDS = {
    limits: 'to track limits',
    penalty: 'to penalties',
    pit: 'to the pit lane',
    partial: 'joined part-way',
    implausible: 'to a broken time',
  };

  function cleanNote(stats) {
    const reasons = Object.entries(stats.dirtyBy)
      .filter(([why]) => why !== 'pit' && why !== 'implausible')
      .sort((a, b) => b[1] - a[1]);
    if (!reasons.length) return '';
    const [why, n] = reasons[0];
    return esc(`${n} lap${n === 1 ? '' : 's'} lost ${DIRTY_WORDS[why] || `to ${why}`}`);
  }

  function reportHtml(s) {
    const st = s.stats;
    return `
      <div class="rv-report">
        <div class="rv-hero">
          <div>
            <div class="rv-hero__label">Best lap</div>
            <div class="rv-hero__time" data-none="${String(!known(st.bestMs))}">${
              known(st.bestMs) ? fmtLap(st.bestMs) : dash
            }</div>
          </div>
          <div>
            ${heroNote(s)}
            ${st.bestSectors.some((v) => known(v)) ? `
            <div class="rv-hero__sectors">
              ${st.bestSectors.map((v, i) => `
                <span><b>S${i + 1}</b>${known(v) ? fmtSector(v) : dash}</span>`).join('')}
            </div>` : ''}
          </div>
        </div>
        <div class="rv-tiles">
          ${tile('Optimal lap', known(st.optimalMs) ? fmtLap(st.optimalMs) : dash, {
            tone: 'accent',
            note: 'Your own best sectors',
          })}
          ${tile('Untapped', known(st.untappedMs) ? fmtDelta(st.untappedMs) : dash, {
            note: 'Best minus optimal',
          })}
          ${tile('Average lap', known(st.averageMs) ? fmtLap(st.averageMs) : dash, {
            note: `${st.cleanLaps} clean lap${st.cleanLaps === 1 ? '' : 's'}`,
          })}
          ${tile('Consistency', known(st.spreadMs) ? `±${fix(st.spreadMs / 1000, 2)}s` : dash, {
            bar: st.consistency,
            note: known(st.consistency) ? `${fix(st.consistency, 0)}% of the scale` : '',
          })}
          ${tile('Clean driving', known(st.cleanPct) ? pct(st.cleanPct) : dash, {
            tone: known(st.cleanPct) && st.cleanPct >= 0.85 ? 'good' : undefined,
            note: cleanNote(st),
          })}
          ${tile('Laps', String(st.laps), {
            note: `${s.stints.length} stint${s.stints.length === 1 ? '' : 's'}`,
          })}
          ${tile('On track', fmtSpan(st.driveMs), {
            note: `${fmtSpan(st.elapsedMs)} in the car`,
          })}
          ${tile('Fuel', known(st.fuelPerLapL) ? `${fix(st.fuelPerLapL, 2)} L` : dash, {
            note: known(st.fuelUsedL) ? `${fix(st.fuelUsedL, 1)} L per stint` : 'not recorded',
          })}
          ${known(st.vePerLapPct)
            ? tile('Energy', `${fix(st.vePerLapPct, 2)}%`, { note: 'per lap' })
            : ''}
        </div>
      </div>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  The lap sheet                                                         */
  /* ---------------------------------------------------------------------- */

  const sheetCols = () => [
    'Lap', 'S1', 'S2', 'S3', 'Time', 'Δ best', 'Fuel L', 'VE %',
    `Tyres °${tempUnit === 'f' ? 'F' : 'C'}`, 'Wear', 'vs',
  ];

  /**
   * Rank a figure against the session's and the stint's best. Purple for the
   * session, green for the stint, nothing otherwise — the convention every
   * timing screen in the sport already uses, so it needs no legend.
   */
  function rank(value, stintBest, sessionBest) {
    if (!known(value) || value <= 0) return '';
    if (known(sessionBest) && value === sessionBest) return ' data-rank="session"';
    if (known(stintBest) && value === stintBest) return ' data-rank="stint"';
    return '';
  }

  function flagsFor(lap) {
    if (lap.clean) return '';
    return lap.dirty
      .map((why) => `<span class="rv-flag" data-why="${esc(why)}">${esc(why)}</span>`)
      .join('');
  }

  function sheetHtml(stint, session) {
    const sBest = session.stats.bestMs;
    const sSec = session.stats.bestSectors;
    const tBest = stint.stats.bestMs;
    const tSec = stint.stats.bestSectors;

    const rows = stint.laps.map((lap) => {
      // The delta is against the SESSION best, not the stint's: a driver
      // reading stint three wants to know where it sits against their whole
      // evening, and a per-stint delta silently re-bases every card.
      // A pit lap's gap to the best is arithmetic, not information: it says
      // how long the pit lane is. Every other timed lap gets one.
      const comparable = lap.timed && !lap.isOutLap && !lap.isInLap;
      const delta = known(sBest) && comparable && lap.lapMs !== sBest ? lap.lapMs - sBest : null;
      const deltaCls = delta === null ? 'dim' : delta < 0 ? 'gain' : 'loss';
      const worst = lap.wear ? Math.min(...lap.wear) : null;
      // Bare numbers: the column heading carries the unit, and four degree
      // marks per row across forty rows is noise in a column of figures.
      const temps = lap.temp
        ? lap.temp.map((t) => Math.round(tempUnit === 'f' ? t * 1.8 + 32 : t)).join(' ')
        : dash;
      const mark = lap.hasTrace
        ? `<span class="rv-trace" title="Telemetry captured for this lap"><svg class="icon"><use href="#i-activity" /></svg></span>`
        : '';
      // A row is a link to the lap only when there is a trace behind it.
      // Making every row look clickable and then telling a third of them
      // "nothing recorded" is the affordance lying about itself.
      return `
        <tr data-timed="${String(lap.timed)}" data-lap="${lap.lapNo}"
            ${lap.hasTrace ? `data-open="${esc(lap.id || '')}"` : ''}
            ${lap.hasTrace ? 'tabindex="0" role="button" title="Study this lap"' : ''}>
          <td class="num">${lap.lapNo}${mark}</td>
          <td class="sec"${rank(lap.s1Ms, tSec[0], sSec[0])}>${fmtSector(lap.s1Ms)}</td>
          <td class="sec"${rank(lap.s2Ms, tSec[1], sSec[1])}>${fmtSector(lap.s2Ms)}</td>
          <td class="sec"${rank(lap.s3Ms, tSec[2], sSec[2])}>${fmtSector(lap.s3Ms)}</td>
          <td class="lap"${lap.clean ? rank(lap.lapMs, tBest, sBest) : ''}>${
            lap.timed ? fmtLap(lap.lapMs) : dash
          }${flagsFor(lap)}</td>
          <td class="${deltaCls}">${delta === null ? dash : fmtDelta(delta)}</td>
          <td>${known(lap.fuelUsedL) ? `${fix(lap.fuelUsedL, 2)}` : `<span class="dim">${dash}</span>`}</td>
          <td>${known(lap.veUsedPct) ? `${fix(lap.veUsedPct, 2)}` : `<span class="dim">${dash}</span>`}</td>
          <td class="dim">${temps}</td>
          <td>${known(worst) ? pct(worst) : `<span class="dim">${dash}</span>`}</td>
          <td class="ref">${lap.hasTrace ? `
            <button type="button" class="rv-refbtn" data-ref="${esc(lap.id || '')}"
                    data-on="${String(!!refLap && refLap.id === lap.id)}"
                    title="${refLap && refLap.id === lap.id
                      ? 'Stop comparing against this lap'
                      : 'Compare every other lap against this one'}">vs</button>` : ''}</td>
        </tr>`;
    }).join('');

    return `
      <div class="rv-sheet__scroll">
        <table class="rv-sheet">
          <thead><tr>${sheetCols().map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  A stint's own rail                                                    */
  /* ---------------------------------------------------------------------- */

  const CORNERS = ['FL', 'FR', 'RL', 'RR'];

  /**
   * Heat is read against the CAR's own mean, not an absolute window.
   *
   * The right operating range depends on compound, class and weather, and none
   * of those are ours to assume — quoting a GT3 slick's window at an LMP2 on a
   * wet track would be worse than saying nothing. What IS true in every one of
   * those cases is that an axle running hot relative to the other one is an
   * imbalance the driver can do something about, so that is what the colour
   * says. The number itself is always the real temperature.
   */
  function heatOf(temp, mean) {
    if (!known(temp) || !known(mean)) return '';
    const d = temp - mean;
    if (d >= 8) return ' data-heat="hot"';
    if (d >= 4) return ' data-heat="warm"';
    if (d <= -6) return ' data-heat="cool"';
    return '';
  }

  const wearBand = (w) => (w >= 0.6 ? 'high' : w >= 0.35 ? 'mid' : 'low');

  function sideHtml(stint) {
    const st = stint.stats;
    const temps = st.tempAvg;
    const mean = temps ? (temps[0] + temps[1] + temps[2] + temps[3]) / 4 : null;
    const corners = CORNERS.map((name, i) => {
      const t = temps ? temps[i] : null;
      const w = st.wearEnd ? st.wearEnd[i] : null;
      return `
        <div class="rv-corner">
          <div class="rv-corner__label">${name}</div>
          <div class="rv-corner__temp" data-none="${String(!known(t))}"${heatOf(t, mean)}>${
            known(t) ? degrees(t) : dash
          }</div>
          ${known(w)
            ? `<div class="rv-corner__wear" data-band="${wearBand(w)}">
                 <span style="width:${Math.max(2, Math.min(100, w * 100))}%"></span>
               </div>
               <div class="rv-corner__pct">${pct(w)} left</div>`
            : ''}
        </div>`;
    }).join('');

    const row = (label, value) => `
      <div class="rv-row"><b>${esc(label)}</b>
        <span data-none="${String(value === dash)}">${value}</span></div>`;

    // Air and track temperature as the RANGE the stint ran through, rather
    // than as a column repeating the same two numbers down forty rows. The
    // movement is the information: a track that gained four degrees is why the
    // last laps were slower.
    const span = (pick) => {
      const vals = stint.laps.map(pick).filter(known);
      if (!vals.length) return dash;
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      return Math.round(lo) === Math.round(hi) ? degrees(lo) : `${degrees(lo)} → ${degrees(hi)}`;
    };

    return `
      <div class="rv-stint__side">
        <div>
          <div class="rv-side__title">Tyres, averaged over the stint</div>
          <div class="rv-corners" style="margin-top:7px">${corners}</div>
        </div>
        <div class="rv-rows">
          ${row('Optimal', known(st.optimalMs) ? fmtLap(st.optimalMs) : dash)}
          ${row('Untapped', known(st.untappedMs) ? fmtDelta(st.untappedMs) : dash)}
          ${row('Clean', known(st.cleanPct) ? `${pct(st.cleanPct)} of ${st.timedLaps}` : dash)}
          ${row('Fuel used', known(st.fuelUsedL) ? `${fix(st.fuelUsedL, 1)} L` : dash)}
          ${known(st.veUsedPct) ? row('Energy used', `${fix(st.veUsedPct, 1)}%`) : ''}
          ${row('Duration', fmtSpan(st.elapsedMs))}
          ${row('Track', span((l) => l.trackTempC))}
          ${row('Air', span((l) => l.ambientTempC))}
          ${st.compounds.length ? row('Compound', esc(st.compounds.join(', '))) : ''}
        </div>
      </div>`;
  }

  function stintHtml(stint, session) {
    const st = stint.stats;
    const open = !collapsed.has(stint.no);
    const fact = (label, value, cls = '') => `
      <span class="rv-fact${cls}"><b>${esc(label)}</b>
        <span data-none="${String(value === dash)}">${value}</span></span>`;

    return `
      <section class="rv-stint" data-stint="${stint.no}" data-open="${String(open)}">
        <button class="rv-stint__head" type="button" data-toggle="${stint.no}"
                aria-expanded="${String(open)}">
          <svg class="icon rv-stint__caret"><use href="#i-chevron-down" /></svg>
          <span class="rv-stint__name">Stint ${stint.no}</span>
          <span class="rv-stint__facts">
            ${fact('Laps', String(st.laps))}
            ${fact('Best', known(st.bestMs) ? fmtLap(st.bestMs) : dash, ' rv-fact--best')}
            ${fact('Average', known(st.averageMs) ? fmtLap(st.averageMs) : dash)}
            ${fact('Spread', known(st.spreadMs) ? `±${fix(st.spreadMs / 1000, 2)}s` : dash)}
            ${fact('Fuel', known(st.fuelPerLapL) ? `${fix(st.fuelPerLapL, 2)} L/lap` : dash)}
            ${fact('Time', fmtSpan(st.elapsedMs))}
          </span>
        </button>
        <div class="rv-stint__body">
          ${sheetHtml(stint, session)}
          ${sideHtml(stint)}
        </div>
      </section>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  One lap (phase 2)                                                     */
  /* ---------------------------------------------------------------------- */

  const speedOf = (kph) =>
    known(kph) ? `${Math.round(speedUnit === 'mph' ? kph * 0.621371 : kph)}` : dash;
  const speedUnitLabel = () => (speedUnit === 'mph' ? 'mph' : 'km/h');

  /** A signed number of seconds, as a driver reads a delta: `+0.18`, `-1.04`. */
  function fmtSec(sec, dp = 2) {
    if (!known(sec)) return dash;
    // Anything inside half of the last digit shown is printed as zero rather
    // than as a signed nothing: "-0.00" reads as a loss and is not one.
    if (Math.abs(sec) < 0.5 / 10 ** dp) return (0).toFixed(dp);
    const s = sec.toFixed(dp);
    return sec > 0 ? `+${s}` : s;
  }

  /**
   * A gap in milliseconds, in words: `2.123 s slower`.
   *
   * The sign alone is not enough on a screen someone meets once. `+` for
   * behind is the sport's own convention and it stays — but on the one figure
   * that says which of these two laps was the quicker, the word is spelled
   * out, because reading it backwards inverts everything else on the page.
   */
  function gapWords(ms) {
    if (!known(ms) || Math.abs(ms) < 5) return 'the same time';
    return `${fix(Math.abs(ms) / 1000, 3)} s ${ms > 0 ? 'slower' : 'faster'}`;
  }

  /**
   * Which of the two laps was actually quicker — `mine`, `theirs`, or null.
   *
   * The map colours by this rather than by which lap you happen to be
   * studying. Null covers both "there is no comparison" and "they set the same
   * time": in neither case is there a faster lap, and a green line that only
   * means "this one is yours" would be the map saying something it cannot back
   * up. Five milliseconds is the same threshold {@link gapWords} calls a draw.
   */
  function fasterOf(view) {
    const mine = view.lap && view.lap.lapMs > 0 ? view.lap.lapMs : null;
    const theirs = view.vs && view.vs.lapMs > 0 ? view.vs.lapMs : null;
    if (mine === null || theirs === null) return null;
    if (Math.abs(mine - theirs) < 5) return null;
    return mine < theirs ? 'mine' : 'theirs';
  }

  /**
   * The gap, said from the side of the person reading it.
   *
   * `gapWords` alone was being printed straight after the OTHER lap's number
   * and time, so the pill read "Lap 7 · 1:59.737 · 2.041 s slower" about a lap
   * that was two seconds FASTER. The gap has always belonged to the lap being
   * studied; it just never said whose it was.
   */
  function yourGapWords(ms) {
    if (!known(ms)) return '';
    if (Math.abs(ms) < 5) return 'the same time';
    return `you were ${gapWords(ms)}`;
  }

  /** Which way a delta went, for colour. A hundredth is inside the noise. */
  const deltaBand = (sec) => {
    if (!known(sec)) return 'none';
    if (sec < -0.01) return 'gain';
    if (sec > 0.01) return 'loss';
    return 'level';
  };

  /* ---------------------------------------------------------------------- */
  /*  The window                                                            */
  /*                                                                        */
  /*  One window, shared by the charts and the map. Zoom is not a property  */
  /*  of a chart here — it is a property of the STRETCH OF ROAD being       */
  /*  studied, and the whole point of the lap view is that everything on it */
  /*  is talking about the same piece of track at the same moment.          */
  /* ---------------------------------------------------------------------- */

  /** The tightest window allowed, as a lap fraction — about 20 m at Spa. */
  const MIN_SPAN = 0.004;
  /**
   * What a click on the map opens up to, when nothing was zoomed yet — in
   * METRES, not in lap fractions.
   *
   * A corner is a corner whatever circuit it is on. A tenth of the lap is
   * 550 m at COTA and 1 360 m at Le Mans, and at either of those the two
   * driven lines are still a couple of pixels apart, which is the state the
   * map was rebuilt to get out of. 260 m is a braking zone, a turn-in and the
   * exit of it, at Brands Hatch and at the Mulsanne alike.
   */
  const CLICK_METRES = 260;

  /** That, as a fraction of THIS lap — bounded, for circuits at both extremes. */
  function clickSpan() {
    const m = lapView && lapView.lengthM > 0 ? lapView.lengthM : 5000;
    return Math.max(0.012, Math.min(0.12, CLICK_METRES / m));
  }

  function setWindow(from, to) {
    if (!lapView) return;
    let a = Math.max(0, Math.min(1, from));
    let b = Math.max(0, Math.min(1, to));
    if (b - a < MIN_SPAN) {
      const mid = (a + b) / 2;
      a = Math.max(0, mid - MIN_SPAN / 2);
      b = Math.min(1, a + MIN_SPAN);
      a = Math.max(0, b - MIN_SPAN);
    }
    lapView.window = [a, b];
    if (lapView.repaint) lapView.repaint();
  }

  /** Zoom about a point of the lap, keeping that point where it is on screen. */
  function zoomAbout(factor, anchorD) {
    if (!lapView) return;
    const [a, b] = lapView.window;
    const span = b - a;
    const next = Math.max(MIN_SPAN, Math.min(1, span * factor));
    if (Math.abs(next - span) < 1e-6) return;
    const anchor = known(anchorD) ? Math.min(b, Math.max(a, anchorD)) : (a + b) / 2;
    // The fraction of the plot the anchor sits at is preserved, which is what
    // makes a wheel zoom land where the pointer is rather than in the middle.
    const f = span > 0 ? (anchor - a) / span : 0.5;
    let from = anchor - f * next;
    if (from < 0) from = 0;
    if (from + next > 1) from = 1 - next;
    setWindow(from, from + next);
  }

  /** Centre the window on a point of the lap, opening it up if it was whole. */
  function focusOn(dd, span) {
    if (!lapView || !known(dd)) return;
    const [a, b] = lapView.window;
    const width = span || (b - a >= 0.999 ? clickSpan() : b - a);
    setWindow(dd - width / 2, dd + width / 2);
  }

  /* ---------------------------------------------------------------------- */
  /*  One lap                                                               */
  /* ---------------------------------------------------------------------- */

  /** The values at the cursor, or the lap's own headline when there is none. */
  function readoutHtml(view) {
    const d = view.detail;
    const ch = d.channels;
    const i = view.cursor;
    const cell = (label, value, band) =>
      `<span class="rv-read__cell"${band ? ` data-band="${band}"` : ''}><b>${esc(label)}</b><i>${value}</i></span>`;

    if (i === null || i === undefined || !ch.d || i >= ch.d.length) {
      return `
        <div class="rv-read" data-idle="true">
          ${cell('V-max', `${speedOf(d.vMaxKph)} <u>${speedUnitLabel()}</u>`)}
          ${cell('Samples', String(d.count))}
          ${cell('Measured', `${fix(d.lapSec, 3)}<u>s</u>`)}
          <span class="rv-read__hint">Move to read · click to hold a point on the map ·
            drag across a section to zoom it · scroll to zoom</span>
        </div>`;
    }

    const at = (key, dp) => (Array.isArray(ch[key]) && known(ch[key][i]) ? fix(ch[key][i], dp) : dash);
    const steer = Array.isArray(ch.steer) && known(ch.steer[i]) ? ch.steer[i] : null;
    const metres = d.channels.d[i] * (view.lengthM || 0);
    // The gap at the cursor comes off the delta trace by index, because the
    // delta was built on this lap's own grid — see lapDetail.deltaTrace.
    const gapSec = view.delta && known(view.delta.dt[i]) ? view.delta.dt[i] : null;
    return `
      <div class="rv-read"${view.pin !== null && view.pin !== undefined ? ' data-pinned="true"' : ''}>
        ${gapSec === null ? '' : cell('Delta', `${fmtSec(gapSec)}<u>s</u>`, deltaBand(gapSec))}
        ${cell('Distance', `${Math.round(metres)}<u>m</u>`)}
        ${cell('Time', `${fix(ch.t[i] - ch.t[0], 2)}<u>s</u>`)}
        ${cell('Speed', `${speedOf(ch.speedKph[i])}<u>${speedUnitLabel()}</u>`)}
        ${cell('Throttle', `${Math.round(ch.throttle[i] * 100)}<u>%</u>`)}
        ${cell('Brake', `${Math.round(ch.brake[i] * 100)}<u>%</u>`)}
        ${cell('Gear', String(ch.gear[i]))}
        ${cell('Steering', steer === null ? dash
          : `${Math.abs(Math.round(steer * 100))}<u>${steer > 0.005 ? 'R' : steer < -0.005 ? 'L' : ''}</u>`)}
        ${cell('G lat / lon', `${at('latG', 2)} / ${at('lonG', 2)}`)}
        ${view.pin === null || view.pin === undefined ? '' : `
        <button type="button" class="rv-read__pin" data-unpin
                title="Stop holding this point">held · release</button>`}
      </div>`;
  }

  /** Which sector the cursor is in, for the header pill. */
  function sectorAt(dd, sectors) {
    if (!sectors) return '';
    if (known(sectors.s1) && dd < sectors.s1) return 'S1';
    if (known(sectors.s2) && dd < sectors.s2) return 'S2';
    return known(sectors.s1) ? 'S3' : '';
  }

  /**
   * Every other lap of the session that could be laid under this one.
   *
   * Only laps with telemetry, and only from the same session — which is the
   * plan's "your own laps" comparison (decision 2) at its narrowest and
   * fairest: same car, same circuit, same afternoon, same tyres give or take a
   * stint. The session's best is offered first because it is the comparison a
   * driver reaches for nine times out of ten.
   */
  function compareOptions(view) {
    const s = view.session;
    if (!s) return [];
    const laps = [];
    for (const stint of s.stints) {
      for (const lap of stint.laps) {
        if (!lap.hasTrace || lap.id === view.lap.id) continue;
        laps.push(lap);
      }
    }
    const best = known(s.stats.bestMs)
      ? laps.find((l) => l.timed && l.clean && l.lapMs === s.stats.bestMs)
      : null;
    return laps
      .slice()
      .sort((a, b) => {
        if (best && a.id === best.id) return -1;
        if (best && b.id === best.id) return 1;
        return a.lapNo - b.lapNo;
      })
      .map((lap) => ({
        lap,
        label: `Lap ${lap.lapNo}${best && lap.id === best.id ? ' · session best' : ''} · ${
          lap.timed ? fmtLap(lap.lapMs) : 'no time'
        }`,
      }));
  }

  /* ---- The leaderboard as a comparison ---------------------------------- */
  /*
   * Reworked 2026-09-12 after Carl tried the first cut. A rival off the
   * league board belongs to the CIRCUIT, not to a session: pin Mark at Monza
   * and every session and every lap you open at Monza is laid over his, until
   * you unpin him or pin someone else. The first cut held the rival in the
   * same slot as a session lap (cleared on every session change) and offered
   * the board as a dropdown — so the pin was lost by clicking the session
   * list, and finding a driver meant scrolling a <select>. Both gone.
   *
   * Two kinds of reference now, resolved by `activeRef()`:
   *   - `refLap`   one of THIS session's laps, chosen on the sheet. Lasts the
   *                session; going to another session drops it (it belongs to
   *                this one). While set, it shadows the pin.
   *   - `pins`     one board lap per circuit+class, kept per machine. Chosen
   *                from the leaderboard card, which sits on the session screen
   *                where the times are, and folds out under the lap view's bar.
   */

  /** A reference that is a lap on the league board rather than one of ours. */
  const isBoardRef = (ref) => !!ref && ref.board === true;

  /** `trackKey|CLASS` — what a pin is filed under. */
  const circuitKey = (s) => (s && s.trackKey && s.carClass
    ? `${s.trackKey}|${String(s.carClass).toUpperCase()}` : '');

  /** Board pins by circuit, restored on init. */
  let pins = {};
  /** Whether the session screen's leaderboard card is folded. Per machine. */
  let boardFolded = false;
  /** Whether the lap view's fold-out board is open. Lasts the lap. */
  let lapBoardOpen = false;

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem('apex.review.pins');
      const parsed = raw ? JSON.parse(raw) : null;
      pins = parsed && typeof parsed === 'object' ? parsed : {};
      boardFolded = window.localStorage.getItem('apex.review.boardFolded') === '1';
    } catch {
      pins = {};
    }
  }

  function savePins() {
    try { window.localStorage.setItem('apex.review.pins', JSON.stringify(pins)); } catch {
      /* storage off: the pin lasts the run */
    }
  }

  /** The pinned rival for a session's circuit, or null. */
  const pinFor = (s) => pins[circuitKey(s)] || null;

  /**
   * What a lap opened now is laid over: the sheet's own-lap choice if there
   * is one, else the circuit's pin. `lap` is the lap about to be opened, so a
   * reference that IS that lap yields nothing rather than a lap over itself.
   */
  function activeRef(lap) {
    if (refLap && !(lap && refLap.id === lap.id)) return refLap;
    return pinFor(current);
  }

  /** Pin (or, if already pinned, unpin) a board row for the open circuit. */
  function togglePin(ref) {
    const key = circuitKey(current);
    if (!key || !ref) return null;
    const had = pins[key];
    if (had && had.driverId === ref.driverId) delete pins[key];
    else pins[key] = ref;
    savePins();
    // A pin is the circuit's reference; choosing one is choosing to compare
    // against it, so a session lap chosen earlier stops shadowing it.
    refLap = null;
    return pins[key] || null;
  }

  /**
   * A leaderboard row as a reference the rest of this file can hold: what
   * `review:lap` needs to fetch it, and what the captions need to name it.
   * `track_id` comes from the board lookup, which is what makes the row
   * addressable at all — the lap files know the circuit by key.
   */
  function boardRefOf(row) {
    return {
      board: true,
      driverId: row.driver_id,
      trackId: row.track_id,
      carClass: row.car_class || (current ? current.carClass : ''),
      rank: row.rank,
      name: row.is_you ? 'You' : row.display_name || 'Driver',
      isYou: !!row.is_you,
      car: row.car || '',
      lapMs: row.lap_ms,
      hasLine: !!row.has_line,
    };
  }

  /** `P3 Name` — how a board reference is named everywhere it is printed. */
  function refName(ref) {
    if (!ref) return '';
    if (isBoardRef(ref)) return `P${ref.rank} ${ref.name}`;
    return `Lap ${ref.lapNo}`;
  }

  /** Where a reference came from, for the strip. */
  function refWhere(ref) {
    if (!ref) return '';
    if (isBoardRef(ref)) return `leaderboard${ref.car ? ` · ${ref.car}` : ''}`;
    return `this session · stint ${ref.stintNo}`;
  }

  /** One line for the board card when it has no rows to show, or null. */
  function boardNote() {
    switch (board.state) {
      case 'idle':
      case 'loading': return 'Reading the leaderboard…';
      case 'signed-out': return 'Sign in to see the leaderboard and compare against it.';
      case 'error': return 'The leaderboard could not be reached.';
      case 'ok': return board.rows.length ? null : 'Nobody on the leaderboard here yet — yours could be the first.';
      default: return null;
    }
  }

  /**
   * Fetch the board for the open session's circuit and class, once. The card
   * is re-rendered in place when it lands rather than through renderDetail():
   * a driver may already be scrubbing a lap, and repainting the whole view to
   * fill a table would drop their cursor.
   */
  async function ensureBoard(session) {
    if (!session || !session.trackKey || !session.carClass) return;
    const key = `${session.trackKey}|${session.carClass}`;
    if (board.key === key && board.state !== 'idle' && board.state !== 'error') return;
    board = { key, state: 'loading', rows: [], error: '' };
    let res = null;
    try {
      res = await window.apex.reviewBoard({ trackKey: session.trackKey, carClass: session.carClass });
    } catch {
      res = null;
    }
    if (board.key !== key) return;
    if (res && res.ok) {
      board = { key, state: 'ok', rows: Array.isArray(res.rows) ? res.rows : [], error: '' };
    } else if (res && res.signedOut) {
      board = { key, state: 'signed-out', rows: [], error: res.error || '' };
    } else {
      board = { key, state: 'error', rows: [], error: (res && res.error) || '' };
    }
    refreshBoardCards();
  }

  /** Swap every board card on screen for the current one, touching nothing else. */
  function refreshBoardCards() {
    if (!els.detail) return;
    for (const host of els.detail.querySelectorAll('[data-boardcard]')) {
      host.outerHTML = boardCardHtml(host.getAttribute('data-boardcard') === 'lap');
    }
  }

  /**
   * The strip that says what every lap opens against. On the session screen
   * it is sticky, so it is readable however far down the sheet you are; on
   * the lap view it is the bar's first item. Its Clear button clears whichever
   * reference is active — a session lap, or the circuit's pin.
   */
  function refBarHtml() {
    const ref = activeRef(null);
    if (!ref) return '';
    const pinned = isBoardRef(ref);
    return `
      <div class="rv-refbar" data-kind="${pinned ? 'board' : 'own'}">
        <span class="rv-refbar__tag">Comparing against</span>
        <b>${esc(refName(ref))}</b>
        <span class="rv-refbar__where">${esc(refWhere(ref))}</span>
        <span class="rv-refbar__time">${pinned
          ? fmtLap(ref.lapMs)
          : (ref.timed ? fmtLap(ref.lapMs) : dash)}</span>
        <span class="rv-refbar__note">${pinned
          ? 'Pinned to this circuit — every lap you open here is laid over it.'
          : 'Open any lap and it opens against this one.'}</span>
        <button type="button" class="btn btn--ghost btn--sm" data-refclear>
          <svg class="icon"><use href="#i-x" /></svg><span>${pinned ? 'Unpin' : 'Clear'}</span>
        </button>
      </div>`;
  }

  /**
   * The leaderboard for this circuit and class, as a card: every driver's
   * best, with a vs button on each row whose trace is there to compare with.
   * The same button the sheet puts on your own laps, doing the same thing.
   *
   * `inLap` renders the fold-out under the lap view's bar, which also carries
   * this session's other laps as chips — the sheet is not on screen there,
   * and switching to one of your own laps should not cost a trip back to it.
   */
  function boardCardHtml(inLap) {
    const s = current;
    const pin = pinFor(s);
    const note = boardNote();
    const title = `Leaderboard · ${esc([s && s.carClass, s && s.track].filter(Boolean).join(' at '))}`;
    const folded = !inLap && boardFolded;

    let body = '';
    if (note) {
      body = `<p class="rv-board__note">${esc(note)}</p>`;
    } else {
      const rows = board.rows.map((row) => {
        const ref = boardRefOf(row);
        const on = !!pin && pin.driverId === row.driver_id;
        const gap = typeof row.gap_ms === 'number' ? `+${(row.gap_ms / 1000).toFixed(3)}` : dash;
        let action = '';
        if (row.is_you) {
          action = '<span class="rv-board__you">you</span>';
        } else if (row.has_trace) {
          action = `<button type="button" class="rv-refbtn" data-pin="${esc(row.driver_id)}"
              data-on="${String(on)}" data-line="${String(!!row.has_line)}"
              title="${on
                ? 'Unpin — stop comparing against this lap'
                : (row.has_line
                  ? 'Compare every lap you open here against this one'
                  : 'Compare against this lap — set before Apex recorded the driven line, so the map shows only yours')}">${
                on ? 'pinned' : 'vs'}</button>`;
        } else {
          action = '<span class="rv-board__none" title="No telemetry on the board for this lap">—</span>';
        }
        return `
          <tr data-you="${String(!!row.is_you)}" data-on="${String(on)}">
            <td class="num">P${row.rank}</td>
            <td class="who">${esc(row.is_you ? 'You' : row.display_name || 'Driver')}</td>
            <td class="car">${esc(row.car || '')}</td>
            <td class="lap">${fmtLap(row.lap_ms)}</td>
            <td class="gapc">${gap}</td>
            <td class="ref">${action}</td>
          </tr>`;
      }).join('');
      body = `
        <div class="rv-sheet__scroll rv-board__scroll">
          <table class="rv-sheet rv-board__table">
            <thead><tr><th>Pos</th><th>Driver</th><th>Car</th><th>Lap</th><th>Gap</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    // The lap view's fold-out also carries this session's laps, as chips.
    let own = '';
    if (inLap && lapView && lapView.lap) {
      const opts = compareOptions(lapView);
      own = `
        <div class="rv-board__own">
          <span class="rv-board__owntag">This session</span>
          ${opts.length ? opts.map((o) => `<button type="button" class="rv-refbtn rv-refbtn--chip"
              data-ref="${esc(o.lap.id || '')}" data-on="${String(!!refLap && refLap.id === o.lap.id)}"
              title="${esc(o.label)}">L${o.lap.lapNo} <i>${o.lap.timed ? fmtLap(o.lap.lapMs) : dash}</i></button>`).join('')
            : '<span class="rv-board__note">No other lap in this session has telemetry.</span>'}
        </div>`;
    }

    return `
      <div class="rv-card rv-board" data-boardcard="${inLap ? 'lap' : 'session'}" data-folded="${String(folded)}">
        <div class="rv-card__head">
          <span class="rv-card__title">${title}</span>
          <span class="rv-legend"><span>${inLap ? 'vs pins a rival to this circuit' : 'vs pins a rival to this circuit — every lap you open here is laid over theirs'}</span></span>
          ${inLap ? '' : `<button type="button" class="btn btn--ghost btn--sm" data-boardtoggle aria-expanded="${String(!folded)}">
            <span>${folded ? 'Show' : 'Hide'}</span>
          </button>`}
        </div>
        ${folded ? '' : own + body}
      </div>`;
  }

  /** The zoom controls, and the stretch of road they have arrived at. */
  function zoomHtml(view) {
    const [a, b] = view.window;
    const whole = b - a >= 0.999;
    const m = view.lengthM || 0;
    const label = whole
      ? 'Whole lap'
      : `${Math.round(a * m)}–${Math.round(b * m)} m`;
    return `
      <div class="rv-zoom">
        <button type="button" class="btn btn--ghost btn--sm" data-mapsize
                title="${bigMap ? 'Put the circuit back beside the charts'
                  : 'Draw the circuit full width, under the charts'}">
          <svg class="icon"><use href="#i-${bigMap ? 'orbit' : 'circuit'}" /></svg>
          <span>${bigMap ? 'Small map' : 'Big map'}</span>
        </button>
        <span class="rv-zoom__label" data-zoomlabel>${esc(label)}</span>
        <button type="button" class="btn btn--ghost btn--sm rv-zoom__step" data-zoom="out"
                title="Zoom out" aria-label="Zoom out"><span>&minus;</span></button>
        <button type="button" class="btn btn--ghost btn--sm rv-zoom__step" data-zoom="in"
                title="Zoom in" aria-label="Zoom in"><span>+</span></button>
        <button type="button" class="btn btn--ghost btn--sm" data-zoom="reset"
                title="Back to the whole lap"${whole ? ' disabled' : ''}>
          <span>Whole lap</span>
        </button>
      </div>`;
  }

  /**
   * The micro-sector chips.
   *
   * The load-bearing idea of the whole comparison: they are how a driver gets
   * from "I was 0.7 s slower" to "I was 0.18 s slower in SQ3", and they are the
   * click target that focuses the charts and the map on one piece of road.
   * Without a comparison lap they still divide the lap up and still zoom, they
   * just have no number on them yet.
   */
  function microHtml(view) {
    if (!view.micro || !view.micro.length) return '';
    const [a, b] = view.window;
    return `
      <div class="rv-micro" role="group" aria-label="Micro-sectors">
        ${view.micro.map((seg) => {
          const inside = seg.from >= a - 1e-6 && seg.to <= b + 1e-6 && b - a < 0.999;
          return `
          <button type="button" class="rv-micro__chip" data-micro="${seg.no}"
                  data-band="${deltaBand(seg.deltaSec)}" data-on="${String(inside)}"
                  title="${esc(`SQ${seg.no} · ${Math.round(seg.from * (view.lengthM || 0))}–${
                    Math.round(seg.to * (view.lengthM || 0))
                  } m${seg.deltaSec === null ? '' : ` · ${gapWords(seg.deltaSec * 1000)}`}`)}">
            <b>SQ${seg.no}</b>
            <i>${seg.deltaSec === null ? (known(seg.aSec) ? `${seg.aSec.toFixed(1)}s` : dash)
              : fmtSec(seg.deltaSec)}</i>
          </button>`;
        }).join('')}
      </div>`;
  }

  /**
   * What the map is showing, in a sentence — including which line is whose.
   *
   * Once the colours mean PACE rather than identity, "which one is mine" stops
   * being answerable from the picture alone, so it is answered here instead.
   * It is one line of prose against a legend nobody reads, and it is only ever
   * one of three cases.
   */
  function mapNote(view) {
    const shaded = 'The road is shaded by its elevation, pale for the high ground.';
    const moving = 'Click any part of it to zoom in, drag it to move along the lap, and Big map for a closer look.';
    if (!view.detail.hasLine) {
      return `This lap was recorded before Apex captured the driven line, so the marker follows the centreline. ${shaded} ${moving}`;
    }
    const faster = fasterOf(view);
    if (!faster) {
      return `Seen from directly above, to scale. Cyan is the line you drove${
        view.vs ? ', violet the lap you are comparing with — the two set the same time, so neither is the quicker' : ''
      }. ${shaded} ${moving}`;
    }
    const theirs = isBoardRef(view.vsLap)
      ? `${esc(refName(view.vsLap))}'s`
      : `lap ${esc(String(view.vsLap ? view.vsLap.lapNo : ''))}`;
    const green = faster === 'mine' ? 'yours' : theirs;
    const red = faster === 'mine' ? theirs : 'yours';
    return `Seen from directly above, to scale. <b>Green is the quicker lap</b> — here that is ${green} — `
      + `and red the slower, which is ${red}. Each carries its own car at the point of road you are reading. `
      + `${shaded} ${moving}`;
  }

  function lapViewHtml(view) {
    const d = view.detail;
    const lap = view.lap;
    const s = view.session;
    const best = s && known(s.stats.bestMs) ? s.stats.bestMs : null;
    const gap = best !== null && lap.timed && lap.lapMs !== best ? lap.lapMs - best : null;
    const vsGap = view.vs && view.vs.lapMs > 0 && lap.lapMs > 0 ? lap.lapMs - view.vs.lapMs : null;

    const sectorChip = (n, ms) => `
      <span class="rv-chip"><b>S${n}</b>${known(ms) ? fmtSector(ms) : dash}</span>`;

    return `
      <div class="rv-card rv-lap">
        <div class="rv-lap__head">
          <button type="button" class="btn btn--ghost btn--sm" data-lapback>
            <svg class="icon"><use href="#i-arrow-left" /></svg><span>Session</span>
          </button>
          <span class="rv-lap__name">Lap ${lap.lapNo}<i> · stint ${lap.stintNo}</i></span>
          <span class="rv-lap__time"${lap.clean && best !== null && lap.lapMs === best ? ' data-best="true"' : ''}>${
            lap.timed ? fmtLap(lap.lapMs) : dash
          }</span>
          ${gap === null ? '' : `<span class="rv-lap__gap">${fmtDelta(gap)}</span>`}
          ${lap.clean ? '' : lap.dirty.map((why) =>
            `<span class="rv-flag" data-why="${esc(why)}">${esc(why)}</span>`).join('')}
          <span class="rv-lap__where">${esc(d.track || '')}${
            d.car ? ` · ${esc(d.car)}` : ''
          }</span>
          <span class="rv-lap__chips">
            ${sectorChip(1, lap.s1Ms)}${sectorChip(2, lap.s2Ms)}${sectorChip(3, lap.s3Ms)}
          </span>
        </div>

        <div class="rv-lap__bar2">
          ${view.vs ? `<span class="rv-cmp__read" data-band="${deltaBand(vsGap === null ? null : vsGap / 1000)}"
                title="Dashed on the charts, in each channel's own colour. On the map the quicker of the two laps is green and the slower red.">
            <i class="rv-cmp__swatch" aria-hidden="true"></i>
            <span class="rv-cmp__tag">vs</span>
            <b>${esc(refName(view.vsLap))}</b>
            ${isBoardRef(view.vsLap) && view.vs.car ? `<em>${esc(view.vs.car)}</em>` : ''}
            <span>${view.vs.lapMs > 0 ? fmtLap(view.vs.lapMs) : dash}</span>
            ${vsGap === null ? '' : `<i>${esc(yourGapWords(vsGap))}</i>`}
          </span>` : `<span class="rv-cmp rv-cmp--none">${view.vsLap && !view.vsError ? 'Reading the other lap…' : 'Nothing to compare against'}</span>`}
          ${view.vsError ? `<span class="rv-cmp--none">${esc(view.vsError)}</span>` : ''}
          <button type="button" class="btn btn--ghost btn--sm" data-lapboard aria-expanded="${String(lapBoardOpen)}"
                  title="Choose who to compare against — the leaderboard for this circuit, or another lap of this session">
            <svg class="icon"><use href="#i-list-ordered" /></svg><span>${view.vs ? 'Change' : 'Compare with…'}</span>
          </button>
          ${zoomHtml(view)}
        </div>
        ${lapBoardOpen ? boardCardHtml(true) : ''}

        <div class="rv-lap__body" data-map="${bigMap ? 'big' : 'side'}">
          <div class="rv-lap__charts">
            <div class="rv-readwrap">${readoutHtml(view)}</div>
            <div class="rv-chan"><canvas></canvas></div>
            ${microHtml(view)}
          </div>
          <aside class="rv-lap__side">
            <div class="rv-map">${view.map ? '<canvas></canvas>' : `
              <div class="rv-map__none">
                <svg class="icon"><use href="#i-circuit" /></svg>
                <span>No circuit shape for ${esc(d.track || 'this track')} yet.</span>
              </div>`}</div>
            <p class="rv-lap__note">${mapNote(view)}</p>
            <div class="rv-rows">
              <div class="rv-row"><b>V-max</b><span>${speedOf(d.vMaxKph)} ${speedUnitLabel()}</span></div>
              <div class="rv-row"><b>Samples</b><span>${d.count}${d.truncated ? ' (capped)' : ''}</span></div>
              <div class="rv-row"><b>Circuit</b><span data-none="${String(!view.map)}">${
                view.map ? `${view.map.points.length} pts${view.map.builtin ? ', bundled' : ', learned'}` : dash
              }</span></div>
              ${view.elevation ? `<div class="rv-row"><b>Elevation</b><span>${
                Math.round(view.elevation)} m rise</span></div>` : ''}
            </div>
          </aside>
        </div>
      </div>`;
  }

  /**
   * Paint the lap view and wire the scrub, the zoom and the map.
   *
   * The cursor is an INDEX into the columns, not a pixel and not a distance:
   * every readout, the map marker and the vertical rule all have to name the
   * same sample, and carrying anything else means three places rounding a
   * distance back to an index and disagreeing about it.
   *
   * The window, by contrast, IS a pair of distances — it has to be, because the
   * map and the charts index their samples differently and the one thing they
   * agree on is where they are on the road.
   */
  function paintLapView() {
    const view = lapView;
    if (!view || !view.detail || !els.detail) return;
    const chanWrap = els.detail.querySelector('.rv-chan');
    const mapWrap = els.detail.querySelector('.rv-map');
    const readout = els.detail.querySelector('.rv-readwrap');
    if (!chanWrap) return;
    const canvas = chanWrap.querySelector('canvas');
    const mapCanvas = mapWrap ? mapWrap.querySelector('canvas') : null;
    const ch = view.detail.channels;
    let geom = null;

    const repaint = () => {
      const cursorD = view.cursor === null ? -1 : ch.d[view.cursor];
      geom = CHARTS.drawChannels(
        canvas, ch,
        CHARTS.channelBands({ mph: speedUnit === 'mph', delta: !!view.delta }),
        {
          sectors: view.detail.sectors,
          lengthM: view.lengthM,
          cursorD,
          window: view.window,
          select: view.select,
          vs: view.vs ? view.vs.channels : null,
          delta: view.delta,
          micro: view.micro,
        },
      );
      if (mapCanvas && view.map) {
        const out = CHARTS.drawLapMap(mapCanvas, view.map, ch, {
          sectors: view.detail.sectors,
          cursorD,
          cursorIndex: view.cursor === null ? -1 : view.cursor,
          window: view.window,
          vs: view.vs ? view.vs.channels : null,
          faster: fasterOf(view),
        });
        view.mapGeom = out ? out.geom : null;
        // The cursor is the only thing that says a zoomed map can be dragged,
        // so it is set from the same fact the drag handler gates on.
        mapCanvas.dataset.pan = String(!!(out && out.zoom > 1.05));
      }
      if (readout) readout.innerHTML = readoutHtml(view);

      // The window moved, so the two things that describe it have to move with
      // it. Rewritten in place rather than by re-rendering the card: a zoom
      // must not cost the canvases their event listeners.
      const label = els.detail.querySelector('[data-zoomlabel]');
      const [a, b] = view.window;
      const whole = b - a >= 0.999;
      if (label) {
        label.textContent = whole
          ? 'Whole lap'
          : `${Math.round(a * view.lengthM)}–${Math.round(b * view.lengthM)} m`;
      }
      const reset = els.detail.querySelector('[data-zoom="reset"]');
      if (reset) reset.disabled = whole;
      for (const chip of els.detail.querySelectorAll('.rv-micro__chip')) {
        const seg = view.micro[Number(chip.dataset.micro) - 1];
        if (!seg) continue;
        chip.setAttribute('data-on',
          String(!whole && seg.from >= a - 1e-6 && seg.to <= b + 1e-6));
      }
    };
    view.repaint = repaint;
    repaint();

    // Distance -> index by binary search: `d` is sorted and a lap is a couple
    // of thousand points, but this runs on every mouse move.
    const indexAt = (dd) => {
      let lo = 0;
      let hi = ch.d.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ch.d[mid] < dd) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && Math.abs(ch.d[lo - 1] - dd) < Math.abs(ch.d[lo] - dd)) return lo - 1;
      return lo;
    };

    /** Where on the LAP a pixel across the charts is, honouring the window. */
    const distanceAtX = (clientX) => {
      const box = canvas.getBoundingClientRect();
      const x = clientX - box.left;
      const f = (x - geom.x0) / Math.max(1, geom.x1 - geom.x0);
      const [a, b] = view.window;
      return Math.min(b, Math.max(a, a + Math.min(1, Math.max(0, f)) * (b - a)));
    };

    /** Far enough from where the button went down to be a drag, not a click. */
    const DRAG_PX = 4;

    const onMove = (evt) => {
      if (!geom) return;
      if (drag) {
        const moved = Math.abs(evt.clientX - drag.x) > DRAG_PX;
        if (moved) drag.moved = true;
        if (drag.pan) {
          // Panning: the road under the pointer stays under the pointer.
          const span = drag.to - drag.from;
          const per = span / Math.max(1, geom.x1 - geom.x0);
          const from = Math.max(0, Math.min(1 - span, drag.from + (drag.x - evt.clientX) * per));
          setWindow(from, from + span);
          return;
        }
        if (drag.moved) {
          // Dragging out a stretch of road to zoom to. Shown as it is drawn,
          // because a selection you cannot see until you let go is a guess.
          view.select = [drag.d, distanceAtX(evt.clientX)];
          view.cursor = indexAt(view.select[1]);
          repaint();
          return;
        }
      }
      const next = indexAt(distanceAtX(evt.clientX));
      if (next === view.cursor) return;
      view.cursor = next;
      repaint();
    };
    const onLeave = () => {
      // Back to the held point, not to nothing: that is what holding one is
      // for — the map keeps showing the corner while you read the sheet.
      if (view.cursor === view.pin) return;
      view.cursor = view.pin;
      repaint();
    };

    // The wheel zooms about the pointer. `passive: false` because the whole
    // point is to stop the panel scrolling underneath the gesture.
    const onWheel = (evt) => {
      if (!geom) return;
      evt.preventDefault();
      zoomAbout(evt.deltaY > 0 ? 1.25 : 0.8, distanceAtX(evt.clientX));
    };

    let drag = null;
    const onDown = (evt) => {
      if (!geom) return;
      const zoomed = view.window[1] - view.window[0] < 0.999;
      drag = {
        x: evt.clientX,
        d: distanceAtX(evt.clientX),
        from: view.window[0],
        to: view.window[1],
        moved: false,
        // Shift pans, and only once there is somewhere to pan to. Plain drag
        // is the one a driver reaches for first, so it gets the gesture that
        // does the useful thing: pick out a corner and fill the charts with it.
        pan: evt.shiftKey && zoomed,
      };
      canvas.setAttribute('data-drag', drag.pan ? 'pan' : 'select');
      evt.preventDefault();
    };

    const onUp = (evt) => {
      if (!drag) return;
      const was = drag;
      drag = null;
      canvas.removeAttribute('data-drag');
      view.select = null;
      if (was.pan) { repaint(); return; }

      if (!was.moved) {
        // A click holds this point: the map marker stays on it after the
        // pointer has gone, which is what makes it possible to look at the
        // corner rather than at the chart.
        view.pin = indexAt(was.d);
        view.cursor = view.pin;
        // From the whole lap it also takes the map TO that corner, which is
        // the useful thing to do with a click on 5 km of road. Already zoomed,
        // it holds and nothing moves — recentring under every click would make
        // the view feel like it was being dragged out from under the pointer.
        if (was.to - was.from >= 0.999) focusOn(was.d);
        else repaint();
        return;
      }

      const to = distanceAtX(evt && evt.clientX !== undefined ? evt.clientX : was.x);
      setWindow(Math.min(was.d, to), Math.max(was.d, to));
    };

    const onResize = () => repaint();

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('resize', onResize);

    // The map is the other half of the same control: click a corner and every
    // chart beside it follows you there.
    let mapDrag = null;
    let mapDragged = false;

    const onMapClick = (evt) => {
      // A drag that ended on this canvas still fires a click. Swallow it once:
      // letting go after moving the map half a lap must not also re-pin the
      // cursor wherever the pointer happened to stop.
      if (mapDragged) { mapDragged = false; return; }
      if (!view.mapGeom) return;
      const box = mapCanvas.getBoundingClientRect();
      const dd = CHARTS.distanceAtPoint(
        view.mapGeom, evt.clientX - box.left, evt.clientY - box.top,
      );
      if (dd === null) return;
      view.pin = indexAt(dd);
      view.cursor = view.pin;
      focusOn(dd);
    };
    const onMapWheel = (evt) => {
      evt.preventDefault();
      const [a, b] = view.window;
      zoomAbout(evt.deltaY > 0 ? 1.25 : 0.8, (a + b) / 2);
    };

    /**
     * Drag the map to move along the lap.
     *
     * The view is framed on the WINDOW — a stretch of road, not a rectangle —
     * so there is no free two-axis pan to give: dragging sideways off the road
     * would take the charts somewhere the map is not, and the one window
     * shared by both is what makes every part of this screen talk about the
     * same corner. What a drag can honestly do is slide that window up and
     * down the circuit, which is what someone reaching for it wants anyway:
     * grab the road, pull it, arrive at the next corner with the charts.
     *
     * Everything the drag needs is frozen at mousedown — the scale, the
     * direction the road runs in under the pointer, and the window it started
     * from. A pan that re-read the geometry it was moving would be measuring
     * against a picture its own last frame had already shifted.
     */
    const onMapDown = (evt) => {
      const g = view.mapGeom;
      if (!g || !(g.zoom > 1.05)) return;
      const box = mapCanvas.getBoundingClientRect();
      const tangent = CHARTS.tangentAtPoint(g, evt.clientX - box.left, evt.clientY - box.top);
      if (!tangent) return;
      mapDrag = {
        x: evt.clientX,
        y: evt.clientY,
        from: view.window[0],
        to: view.window[1],
        scale: g.scale,
        tangent,
        moved: false,
      };
      mapCanvas.setAttribute('data-drag', 'pan');
      evt.preventDefault();
    };

    const onMapMove = (evt) => {
      if (!mapDrag) return;
      const dx = evt.clientX - mapDrag.x;
      const dy = evt.clientY - mapDrag.y;
      if (!mapDrag.moved && Math.hypot(dx, dy) <= DRAG_PX) return;
      mapDrag.moved = true;
      // How far along the road the pointer has come, in pixels, then in metres,
      // then as a fraction of the lap. Negative because the road follows the
      // hand: drag right and the window walks backwards, the way dragging a
      // map has always worked.
      const along = dx * mapDrag.tangent[0] + dy * mapDrag.tangent[1];
      const metres = along / Math.max(1e-6, mapDrag.scale);
      const span = mapDrag.to - mapDrag.from;
      const delta = -metres / Math.max(1, view.lengthM || 1);
      const from = Math.max(0, Math.min(1 - span, mapDrag.from + delta));
      setWindow(from, from + span);
    };

    const onMapUp = () => {
      if (!mapDrag) return;
      mapDragged = mapDrag.moved;
      mapDrag = null;
      mapCanvas.removeAttribute('data-drag');
    };

    if (mapCanvas) {
      mapCanvas.addEventListener('click', onMapClick);
      mapCanvas.addEventListener('wheel', onMapWheel, { passive: false });
      mapCanvas.addEventListener('mousedown', onMapDown);
      // On the window, not the canvas: a pan that stops the moment the pointer
      // leaves a 390px box is a pan you have to keep rescuing.
      window.addEventListener('mousemove', onMapMove);
      window.addEventListener('mouseup', onMapUp);
    }

    lapOff = () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onMapMove);
      window.removeEventListener('mouseup', onMapUp);
      window.removeEventListener('resize', onResize);
      if (mapCanvas) {
        mapCanvas.removeEventListener('click', onMapClick);
        mapCanvas.removeEventListener('wheel', onMapWheel);
        mapCanvas.removeEventListener('mousedown', onMapDown);
      }
      if (lapView) lapView.repaint = null;
    };
  }

  /**
   * Open one lap for study, optionally with another laid under it.
   *
   * `lap` is the ReviewLap from the sheet; `vsLap` is the one to compare
   * against, and passing it re-reads BOTH traces rather than patching the
   * comparison onto what is already on screen — the delta and the micro-sector
   * splits are computed in main from the two traces together, and half of that
   * answer computed here would be a second implementation to keep in step.
   */
  async function openLap(lap, vsLap) {
    if (!lap || !lap.id) return;
    // The reference chosen on the sheet follows you into every lap you open,
    // which is the whole point of choosing it there.
    if (vsLap === undefined) vsLap = activeRef(lap);
    if (chartOff) { chartOff(); chartOff = null; }
    if (lapOff) { lapOff(); lapOff = null; }
    // A window survives a change of comparison lap: the driver is still looking
    // at the same corner, and having it jump back to the whole lap every time
    // they pick a reference makes the picker feel like it lost their place.
    const held = lapView && lapView.lap === lap ? lapView.window : [0, 1];
    lapView = {
      lap,
      vsLap: vsLap || null,
      session: current,
      detail: null,
      vs: null,
      delta: null,
      micro: [],
      map: null,
      mapGeom: null,
      cursor: null,
      // The sample the map is held on. The scrub cursor follows the pointer and
      // is gone the moment it leaves the charts, which is right for reading a
      // lap and useless for studying one point of it — so a click PINS a
      // sample, and leaving the charts falls back to that rather than to
      // nothing.
      pin: null,
      select: null,
      lengthM: 0,
      window: held,
      elevation: 0,
      repaint: null,
    };
    const mine = lapView;
    renderDetail();
    // The league board for this circuit, so the picker can offer it. Fetched
    // beside the lap rather than before it: the lap is on disk and the board
    // is a round trip, and nobody should wait for a dropdown to read a lap.
    void ensureBoard(current);
    let res = null;
    try {
      res = await window.apex.reviewLap({
        id: lap.id,
        at: lap.at,
        haveMapKey: heldMapKey,
        // One of ours by id, or a board lap by the league's own key for it.
        vs: !vsLap ? null
          : isBoardRef(vsLap)
            ? { board: { driverId: vsLap.driverId, trackId: vsLap.trackId, carClass: vsLap.carClass } }
            : { id: vsLap.id, at: vsLap.at },
      });
    } catch {
      res = null;
    }
    // A click that lands after the driver has already gone back, or moved on to
    // another lap, must not paint over what they are looking at now.
    if (lapView !== mine) return;
    if (!res || !res.detail) {
      lapView.error = (res && res.reason === 'no-trace')
        ? 'No telemetry was recorded for this lap.'
        : 'That lap could not be found on disk.';
      renderDetail();
      return;
    }
    lapView.detail = res.detail;
    lapView.vs = res.vs || null;
    lapView.delta = res.delta || null;
    lapView.micro = Array.isArray(res.micro) ? res.micro : [];
    if (vsLap && !res.vs) {
      lapView.vsLap = null;
      const who = refName(vsLap);
      if (isBoardRef(vsLap)) {
        // A board lap can fail in ways one of ours cannot: it lives in the
        // league, and the league needs an account and a connection.
        lapView.vsError = res.vsReason === 'signed-out'
          ? 'Sign in to compare with the leaderboard.'
          : res.vsReason === 'no-trace'
            ? `${who}'s lap has no telemetry to compare against.`
            : `${who}'s lap could not be fetched from the league.`;
      } else {
        lapView.vsError = res.vsReason === 'no-trace'
          ? `${who} has no telemetry to compare against.`
          : `${who} could not be read.`;
      }
    }
    if (res.map) {
      heldMap = res.map;
      heldMapKey = res.detail.mapKey;
    }
    lapView.map = res.detail.mapKey === heldMapKey ? heldMap : null;
    lapView.lengthM = (lapView.map && lapView.map.lengthM)
      || (current && current.trackLengthM) || 0;
    lapView.elevation = elevationRise(lapView.map);
    renderDetail();
  }

  /** Where the cursor is on the lap, for a zoom that has no pointer of its own. */
  function cursorDistance() {
    if (!lapView || !lapView.detail || lapView.cursor === null) return null;
    return lapView.detail.channels.d[lapView.cursor];
  }

  /** How much the circuit climbs, end to end — the one number the map cannot say. */
  function elevationRise(map) {
    if (!map || !Array.isArray(map.points) || !map.points.length) return 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of map.points) {
      const e = p[2];
      if (!known(e)) continue;
      if (e < lo) lo = e;
      if (e > hi) hi = e;
    }
    return hi > lo ? hi - lo : 0;
  }

  /** The one control both half-states of the lap view need. */
  function backBar(lap) {
    return `
      <div class="rv-card rv-lap__bar">
        <button type="button" class="btn btn--ghost btn--sm" data-lapback>
          <svg class="icon"><use href="#i-arrow-left" /></svg><span>Session</span>
        </button>
        <span class="rv-lap__name">Lap ${lap ? lap.lapNo : ''}</span>
      </div>`;
  }

  function closeLap() {
    if (lapOff) { lapOff(); lapOff = null; }
    lapView = null;
    renderDetail();
  }

  /* ---------------------------------------------------------------------- */
  /*  Detail                                                                */
  /* ---------------------------------------------------------------------- */

  /** How many laps of a session reported tyre wear. Fewer than two is no chart. */
  function wearLaps(session) {
    let n = 0;
    for (const stint of session.stints) {
      for (const lap of stint.laps) if (Array.isArray(lap.wear) && lap.wear.length === 4) n += 1;
    }
    return n;
  }

  function emptyState(icon, title, body) {
    return `
      <div class="rv-empty">
        <svg class="icon"><use href="#i-${icon}" /></svg>
        <b>${esc(title)}</b>
        <p>${body}</p>
      </div>`;
  }

  function renderDetail() {
    if (!els.detail) return;
    if (chartOff) { chartOff(); chartOff = null; }

    // Only when there is nothing already on screen: re-reading the list on
    // every visit must not blank a session the driver is still looking at.
    if (loading && !current) {
      els.detail.innerHTML = emptyState('clock', 'Reading your laps…', 'One moment.');
      return;
    }
    if (!summaries.length) {
      els.detail.innerHTML = emptyState(
        'flag',
        'No sessions yet',
        'Drive a lap with Apex running and it lands here — every session, every stint, kept for good. '
        + 'Nothing needs an account: this reads the lap files on this machine.',
      );
      return;
    }
    if (!current) {
      els.detail.innerHTML = emptyState(
        'list-ordered',
        'Pick a session',
        'Choose one on the left to see its report, its lap times and every stint you drove.',
      );
      return;
    }

    // One lap, studied. It replaces the session rather than sitting under it:
    // the charts want the width, and a driver looking at a braking zone is not
    // also reading a forty-row sheet.
    if (lapView) {
      if (lapView.error) {
        els.detail.innerHTML = `
          ${backBar(lapView.lap)}
          ${emptyState('activity', 'Nothing to show for this lap', esc(lapView.error))}`;
      } else if (!lapView.detail) {
        els.detail.innerHTML = `
          ${backBar(lapView.lap)}
          ${emptyState('clock', 'Reading the lap\u2026', 'One moment.')}`;
      } else {
        els.detail.innerHTML = lapViewHtml(lapView);
        paintLapView();
      }
      return;
    }

    const s = current;
    const wet = s.stints.some((st) => st.laps.some((l) => l.wet));
    const tKey = typeKey(s.sessionType);

    els.detail.innerHTML = `
      <div class="rv-card">
        <div class="rv-head">
          <h2>${esc(s.track || 'Unknown circuit')}</h2>
          <span class="rv-pill${tKey !== 'other' ? ` rv-pill--${tKey}` : ''}">${esc(typeName(s.sessionType))}</span>
          ${wet ? '<span class="rv-pill rv-pill--wet">Wet</span>' : ''}
          <span class="rv-head__sub">${esc([s.car, s.carClass].filter(Boolean).join(' · '))}</span>
          <span class="rv-head__when">${esc(dayLabel(s.startedAt))} · ${esc(clockLabel(s.startedAt))}</span>
        </div>
        ${reportHtml(s)}
      </div>

      ${refBarHtml()}
      ${boardCardHtml(false)}

      <div class="rv-card">
        <div class="rv-card__head">
          <span class="rv-card__title">Lap times</span>
          <span class="rv-legend">
            <span style="color:var(--rv-session-best)"><i></i>Session best</span>
            <span style="color:var(--cyan)"><i></i>Clean</span>
            <span style="color:var(--warn)"><i></i>Not clean</span>
            <span style="color:var(--text-3)"><i></i>No time</span>
          </span>
        </div>
        <div class="rv-chart rv-chart--laps"><canvas></canvas></div>
      </div>

      ${s.trend.length > 1 ? `
      <div class="rv-card">
        <div class="rv-card__head">
          <span class="rv-card__title">Your best here, last 30 days</span>
          <span class="rv-legend"><span>${esc(s.carClass || 'This class')} only</span></span>
        </div>
        <div class="rv-chart rv-chart--trend"><canvas></canvas></div>
      </div>` : ''}

      ${wearLaps(s) > 1 ? `
      <div class="rv-card">
        <div class="rv-card__head">
          <span class="rv-card__title">Tyre wear, lap by lap</span>
          <span class="rv-legend">
            <span style="color:var(--cyan)"><i></i>FL</span>
            <span style="color:var(--rv-session-best)"><i></i>FR</span>
            <span style="color:var(--ok)"><i></i>RL</span>
            <span style="color:var(--warn)"><i></i>RR</span>
          </span>
        </div>
        <div class="rv-chart rv-chart--wear"><canvas></canvas></div>
        <p class="rv-card__note">Percentage of the tyre used, so it climbs as the stint
          goes on. The dashed rules are stint changes — the drop across one is a new set.</p>
      </div>` : ''}

      <div>${s.stints.map((st) => stintHtml(st, s)).join('')}</div>
    `;

    paintCharts();
  }

  /**
   * Paint both canvases and wire the lap chart's hover.
   *
   * Repainting on resize rather than on a timer: nothing on this page changes
   * while it is open — the session is over — so the only reason a chart ever
   * needs redrawing is that its box changed size.
   */
  function paintCharts() {
    if (!current || !els.detail) return;
    const lapWrap = els.detail.querySelector('.rv-chart--laps');
    const trendWrap = els.detail.querySelector('.rv-chart--trend');
    const wearWrap = els.detail.querySelector('.rv-chart--wear');
    let hits = [];

    const repaint = () => {
      if (lapWrap) {
        hits = CHARTS.drawLapChart(lapWrap.querySelector('canvas'), current, FMT) || [];
      }
      if (trendWrap) {
        CHARTS.drawTrend(trendWrap.querySelector('canvas'), current.trend,
          String(current.endedAt).slice(0, 10), FMT);
      }
      if (wearWrap) CHARTS.drawWear(wearWrap.querySelector('canvas'), current);
    };
    repaint();

    if (!lapWrap) return;
    const canvas = lapWrap.querySelector('canvas');
    let tip = null;

    const onMove = (evt) => {
      const box = canvas.getBoundingClientRect();
      const mx = evt.clientX - box.left;
      const my = evt.clientY - box.top;
      let best = null;
      for (const hit of hits) {
        const d = Math.hypot(hit.px - mx, hit.py - my);
        if (d < 14 && (!best || d < best.d)) best = { ...hit, d };
      }
      if (!best) { hideTip(); return; }
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'rv-tip';
        lapWrap.appendChild(tip);
      }
      const lap = best.lap;
      const gap = known(current.stats.bestMs) && lap.timed && lap.lapMs !== current.stats.bestMs
        ? ` <span style="color:var(--text-3)">${fmtDelta(lap.lapMs - current.stats.bestMs)}</span>`
        : '';
      tip.innerHTML = `Lap ${lap.lapNo} · stint ${lap.stintNo}<br><b>${
        lap.timed ? fmtLap(lap.lapMs) : 'no time'
      }</b>${gap}${lap.clean ? '' : `<br><span style="color:var(--warn)">${esc(lap.dirty.join(', '))}</span>`}`;
      tip.style.left = `${best.px}px`;
      tip.style.top = `${best.py}px`;
    };

    const hideTip = () => { if (tip) { tip.remove(); tip = null; } };

    // Clicking a point opens the stint it belongs to and walks you to the row.
    const onClick = (evt) => {
      const box = canvas.getBoundingClientRect();
      const mx = evt.clientX - box.left;
      const my = evt.clientY - box.top;
      let best = null;
      for (const hit of hits) {
        const d = Math.hypot(hit.px - mx, hit.py - my);
        if (d < 14 && (!best || d < best.d)) best = { ...hit, d };
      }
      if (!best) return;
      revealLap(best.lap);
    };

    const onResize = () => { repaint(); hideTip(); };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', hideTip);
    canvas.addEventListener('click', onClick);
    window.addEventListener('resize', onResize);
    chartOff = () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', hideTip);
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('resize', onResize);
      hideTip();
    };
  }

  /** Open the stint holding a lap and scroll its row into view. */
  function revealLap(lap) {
    if (collapsed.has(lap.stintNo)) {
      collapsed.delete(lap.stintNo);
      const card = document.querySelector(`.rv-stint[data-stint="${lap.stintNo}"]`);
      if (card) {
        card.setAttribute('data-open', 'true');
        const head = card.querySelector('.rv-stint__head');
        if (head) head.setAttribute('aria-expanded', 'true');
      }
    }
    const row = document.querySelector(
      `.rv-stint[data-stint="${lap.stintNo}"] tr[data-lap="${lap.lapNo}"]`,
    );
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // A one-shot flash rather than a persistent selection: the click was "show
    // me that lap", not "I am now working on that lap".
    row.style.transition = 'background 900ms ease';
    row.style.background = 'rgba(38, 187, 244, 0.16)';
    window.setTimeout(() => { row.style.background = ''; }, 900);
  }

  /* ---------------------------------------------------------------------- */
  /*  Loading                                                               */
  /* ---------------------------------------------------------------------- */

  /** The read in flight, so an arrival from another tab can wait for it. */
  let listRead = null;

  async function loadList(force) {
    // Already reading. Two arrivals can overlap — the router's shown() and
    // init()'s own catch-up on a panel that reopened on this tab — and the
    // second must join the first rather than start a second read.
    if (loading) return listRead;
    if (loadedOnce && !force) return;
    listRead = readList();
    try { await listRead; } finally { listRead = null; }
  }

  async function readList() {
    loading = true;
    renderDetail();
    const keep = currentId;
    try {
      const res = await window.apex.reviewSessions();
      summaries = (res && Array.isArray(res.sessions)) ? res.sessions : [];
      career = (res && res.career) || null;
    } catch {
      summaries = [];
      career = null;
    }
    renderCareer();
    loadedOnce = true;
    loading = false;
    // A session that has gone (the file was deleted, or a lap landed that
    // merged it into another) must not leave the page pointing at nothing.
    if (keep && !summaries.some((row) => row.id === keep)) {
      currentId = null;
      current = null;
    }
    renderList();
    // Land on the most recent session: it is what the driver just finished and
    // came here to look at. Anything else makes them click before they can read.
    if (!currentId && summaries.length) await openSession(summaries[0].id);
    else renderDetail();
  }

  async function openSession(id) {
    if (!id) return;
    if (lapOff) { lapOff(); lapOff = null; }
    lapView = null;
    currentId = id;
    current = null;
    // The session's own reference goes with the session; the circuit's pin
    // does not — that is the whole point of pinning.
    refLap = null;
    lapBoardOpen = false;
    collapsed.clear();
    loading = true;
    renderList();
    renderDetail();
    try {
      const res = await window.apex.reviewSession(id);
      current = (res && res.session) || null;
    } catch {
      current = null;
    }
    loading = false;
    // Everything but the newest stint starts collapsed: a 40-lap session is
    // several screens of sheet, and the stint a driver wants is the last one.
    if (current && current.stints.length > 1) {
      for (const st of current.stints) collapsed.add(st.no);
      collapsed.delete(current.stints[current.stints.length - 1].no);
    }
    renderDetail();
    // The leaderboard card fills in when the board arrives; it is a round
    // trip and the session is on disk, so the session is never made to wait.
    void ensureBoard(current);
  }

  /* ---------------------------------------------------------------------- */
  /*  Wiring                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Find the page and wire it. Idempotent, and called from two places.
   *
   * The router in control-panel.js runs before this file's own
   * DOMContentLoaded handler, so a panel that REOPENS on the Review tab — the
   * common case, since the last tab is remembered — has already had `shown()`
   * called against an unwired page. That used to leave the tab blank on every
   * launch but the first. `shown()` therefore initialises on demand, and this
   * guard is what stops the later DOMContentLoaded doing it all again.
   */
  function init() {
    if (ready) return;
    els.view = $('[data-view="review"]');
    if (!els.view) return;
    FMT.fmtLap = fmtLap;
    FMT.dayLabel = dayLabel;
    els.search = $('#rv-search');
    els.filter = $('#rv-type');
    els.list = $('#rv-sessions');
    els.detail = $('#rv-detail');
    els.career = $('#rv-career');
    try { bigMap = window.localStorage.getItem('apex.review.bigMap') === '1'; } catch {
      /* storage off: the circuit starts beside the charts */
    }
    loadPrefs();

    if (els.search) els.search.addEventListener('input', renderList);
    if (els.filter) els.filter.addEventListener('change', renderList);

    if (els.list) {
      els.list.addEventListener('click', (evt) => {
        const card = evt.target.closest('[data-session]');
        if (card) void openSession(card.dataset.session);
      });
    }

    if (els.detail) {
      els.detail.addEventListener('click', (evt) => {
        if (evt.target.closest('[data-lapback]')) {
          closeLap();
          return;
        }
        if (evt.target.closest('[data-unpin]') && lapView) {
          lapView.pin = null;
          lapView.cursor = null;
          if (lapView.repaint) lapView.repaint();
          return;
        }

        // Choosing what to measure against, from the sheet. Checked before
        // the row itself, because the button sits inside a clickable row and
        // "compare against this" must not also mean "open this".
        const ref = evt.target.closest('[data-ref]');
        if (ref && current) {
          const id = ref.dataset.ref;
          if (refLap && refLap.id === id) refLap = null;
          else {
            for (const stint of current.stints) {
              const found = stint.laps.find((l) => l.id === id);
              if (found) { refLap = found; break; }
            }
          }
          // From the lap view's fold-out the comparison has to be re-read,
          // not just re-labelled: the delta is computed in main from both
          // traces together (see openLap).
          if (lapView && lapView.lap) void openLap(lapView.lap, activeRef(lapView.lap));
          else renderDetail();
          return;
        }
        if (evt.target.closest('[data-refclear]')) {
          // Whichever reference is active: the session lap, or failing that
          // the circuit's pin.
          if (refLap) refLap = null;
          else {
            delete pins[circuitKey(current)];
            savePins();
          }
          if (lapView && lapView.lap) void openLap(lapView.lap, null);
          else renderDetail();
          return;
        }

        // Pin a leaderboard row to this circuit (or unpin it), from either
        // board card. Checked before the fold-out toggle so the click inside
        // the card is not also read as closing it.
        const pinBtn = evt.target.closest('[data-pin]');
        if (pinBtn && current && board.state === 'ok') {
          const row = board.rows.find((r) => r.driver_id === pinBtn.dataset.pin);
          if (!row) return;
          const now = togglePin(boardRefOf(row));
          if (lapView && lapView.lap) void openLap(lapView.lap, now);
          else renderDetail();
          return;
        }
        if (evt.target.closest('[data-lapboard]') && lapView) {
          lapBoardOpen = !lapBoardOpen;
          renderDetail();
          return;
        }
        if (evt.target.closest('[data-boardtoggle]')) {
          boardFolded = !boardFolded;
          try { window.localStorage.setItem('apex.review.boardFolded', boardFolded ? '1' : '0'); } catch {
            /* storage off: the fold lasts the run */
          }
          refreshBoardCards();
          return;
        }

        // The circuit, beside the charts or full width under them.
        if (evt.target.closest('[data-mapsize]')) {
          bigMap = !bigMap;
          try { window.localStorage.setItem('apex.review.bigMap', bigMap ? '1' : '0'); } catch {
            /* storage off: the choice lasts the session */
          }
          renderDetail();
          return;
        }

        // The zoom controls and the micro-sector chips, both of which move
        // the shared window rather than re-rendering anything.
        const zoomBtn = evt.target.closest('[data-zoom]');
        if (zoomBtn && lapView && lapView.detail) {
          const kind = zoomBtn.dataset.zoom;
          if (kind === 'reset') setWindow(0, 1);
          else zoomAbout(kind === 'in' ? 0.6 : 1.7, cursorDistance());
          return;
        }
        const chip = evt.target.closest('[data-micro]');
        if (chip && lapView && lapView.detail) {
          const seg = lapView.micro[Number(chip.dataset.micro) - 1];
          if (seg) {
            const [a, b] = lapView.window;
            const on = b - a < 0.999 && seg.from >= a - 1e-6 && seg.to <= b + 1e-6;
            // Clicking the chip you are already on steps back out, so the same
            // control both focuses and releases and there is no dead click.
            if (on) setWindow(0, 1);
            else {
              const pad = (seg.to - seg.from) * 0.15;
              setWindow(seg.from - pad, seg.to + pad);
            }
          }
          return;
        }

        const row = evt.target.closest('tr[data-open]');
        if (row && current) {
          const id = row.dataset.open;
          for (const stint of current.stints) {
            const lap = stint.laps.find((l) => l.id === id);
            if (lap) { void openLap(lap); return; }
          }
          return;
        }
        const head = evt.target.closest('[data-toggle]');
        if (!head) return;
        const no = Number(head.dataset.toggle);
        const card = head.closest('.rv-stint');
        const open = collapsed.has(no);
        if (open) collapsed.delete(no);
        else collapsed.add(no);
        if (card) card.setAttribute('data-open', String(open));
        head.setAttribute('aria-expanded', String(open));
      });
    }

    // A sheet row is a button, so it answers to Enter and Space like one.
    if (els.detail) {
      els.detail.addEventListener('keydown', (evt) => {
        if (evt.key !== 'Enter' && evt.key !== ' ') return;
        const row = evt.target.closest && evt.target.closest('tr[data-open]');
        if (!row || !current) return;
        evt.preventDefault();
        for (const stint of current.stints) {
          const lap = stint.laps.find((l) => l.id === row.dataset.open);
          if (lap) { void openLap(lap); return; }
        }
      });
    }

    const refresh = $('#rv-refresh');
    if (refresh) {
      refresh.addEventListener('click', () => {
        currentId = null;
        void loadList(true);
      });
    }

    // Temperature unit, from Settings ▸ Appearance — the same setting the
    // overlay and the pit wall print tyres in. A driver reading 88 on the visor
    // and 190 here would rightly assume one of them is broken.
    const applyTempUnit = (settings) => {
      const nextTemp = settings && settings.tempUnit === 'f' ? 'f' : 'c';
      const nextSpeed = settings && settings.speedUnit === 'mph' ? 'mph' : 'kph';
      if (nextTemp === tempUnit && nextSpeed === speedUnit) return;
      tempUnit = nextTemp;
      speedUnit = nextSpeed;
      if (visible) { renderCareer(); renderDetail(); }
    };
    window.apex.getState().then((state) => applyTempUnit(state && state.settings))
      .catch(() => { /* Celsius stands */ });
    window.apex.onSettings(applyTempUnit);
    ready = true;

    // The other half of the ordering problem in this function's note: the
    // router may have called shown() before this file was parsed at all, in
    // which case nothing has asked for the page yet. If the tab is the one on
    // screen, ask now.
    if (els.view.getAttribute('data-active') === 'true') window.apexReview.shown();
  }

  window.apexReview = {
    /** The router calls this on arrival. First visit loads; later ones repaint. */
    shown() {
      init();
      if (!ready) return;
      visible = true;
      // Always re-read. Sessions land while the driver is in the sim, not while
      // they are looking at this window, so arriving IS the refresh event — and
      // the whole lap log is a few hundred kilobytes, read in one pass.
      void loadList(true);
    },
    /**
     * Open one of the driver's laps against a leaderboard row — the
     * Leaderboard tab's "Compare" button lands here. `lap` is what
     * `reviewBestLap` answered (`sessionId`, `id`, `at`); `row` is the board
     * row with its `track_id`. Switches to this tab through the router so the
     * usual arrival work happens, waits for the list that arrival starts,
     * then opens the session and the lap in it.
     */
    async compareWithBoard(lap, row) {
      if (!lap || !lap.sessionId || !lap.id || !row) return false;
      window.apexNav?.showView('review');
      init();
      if (!ready) return false;
      // Arrival started a read; join it rather than race it.
      await (loadList(true) || Promise.resolve());
      if (currentId !== lap.sessionId || !current) await openSession(lap.sessionId);
      if (!current) return false;
      let found = null;
      for (const stint of current.stints) {
        found = stint.laps.find((l) => l.id === lap.id) || null;
        if (found) break;
      }
      if (!found) return false;
      // Pin them to this circuit — the same thing the card's vs button does —
      // so the comparison outlives this lap, this session and this run.
      const ref = boardRefOf({ ...row, car_class: row.car_class || current.carClass });
      pins[circuitKey(current)] = ref;
      savePins();
      refLap = null;
      await openLap(found, ref);
      return true;
    },
    /** …and this on the way out. Nothing here runs while the tab is hidden. */
    hidden() {
      visible = false;
      if (chartOff) { chartOff(); chartOff = null; }
      if (lapOff) { lapOff(); lapOff = null; }
    },
  };

  // Last, so init()'s catch-up above has window.apexReview to call. The router
  // in control-panel.js runs its first showView() before this file is parsed,
  // so `?.shown()` there is a no-op on the launch that opens ON this tab —
  // which is why init() has to do it instead.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
