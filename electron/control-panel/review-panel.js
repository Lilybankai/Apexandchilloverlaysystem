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
  /** The page has been found and wired. See init() for why this is checked. */
  let ready = false;

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
    `Tyres °${tempUnit === 'f' ? 'F' : 'C'}`, 'Wear',
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
      return `
        <tr data-timed="${String(lap.timed)}" data-lap="${lap.lapNo}">
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
  /*  Detail                                                                */
  /* ---------------------------------------------------------------------- */

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
    let hits = [];

    const repaint = () => {
      if (lapWrap) {
        hits = CHARTS.drawLapChart(lapWrap.querySelector('canvas'), current, FMT) || [];
      }
      if (trendWrap) {
        CHARTS.drawTrend(trendWrap.querySelector('canvas'), current.trend,
          String(current.endedAt).slice(0, 10), FMT);
      }
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

  async function loadList(force) {
    // Already reading. Two arrivals can overlap — the router's shown() and
    // init()'s own catch-up on a panel that reopened on this tab — and the
    // second must join the first rather than start a second read.
    if (loading) return;
    if (loadedOnce && !force) return;
    loading = true;
    renderDetail();
    const keep = currentId;
    try {
      const res = await window.apex.reviewSessions();
      summaries = (res && Array.isArray(res.sessions)) ? res.sessions : [];
    } catch {
      summaries = [];
    }
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
    currentId = id;
    current = null;
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
      const next = settings && settings.tempUnit === 'f' ? 'f' : 'c';
      if (next === tempUnit) return;
      tempUnit = next;
      if (visible) renderDetail();
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
    /** …and this on the way out. Nothing here runs while the tab is hidden. */
    hidden() {
      visible = false;
      if (chartOff) { chartOff(); chartOff = null; }
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
