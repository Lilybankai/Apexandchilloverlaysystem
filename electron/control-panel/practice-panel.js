/**
 * practice-panel.js — the Practice tab: the review a practice session gets.
 * -----------------------------------------------------------------------------
 * docs/PRACTICE-REVIEW-PLAN.md. Its own tab since 2026-10-08 (Carl: "make
 * sure the practice review is in a different place to the review screen") —
 * the Review tab stays the general stint reviewer it was.
 *
 * Two views in one pane:
 *
 *   - **The debrief** (phase 1): every lap of a practice session against the
 *     lap the driver CHASED in Training — a snapshot taken during the session,
 *     so a board time beaten next week cannot rewrite it — where the time went
 *     corner by corner, and a corner x lap grid. Built in main
 *     (`review:practice`) from the pure practiceReview module; this file only
 *     lays it out.
 *   - **The deep dive** (phase 2): one lap against that same target, drawn
 *     with the Review tab's own painters (review-charts.js: the channel chart
 *     and the circuit plan, one shared [from, to] window), and a corner table.
 *     Clicking a corner moves the window, so the map and every chart frame it.
 *
 * Corners are C1..Cn in the reference lap's own order and are never given
 * circuit names — the rule the overlay's Corner Analysis card keeps.
 *
 * Arrival: a review main says is waiting opens this tab by itself — on the
 * panel's launch, and when the window comes back into focus — once. A review
 * that lands while the driver is looking at the panel is only offered (a
 * banner here, a dot on the tab), never forced on them.
 *
 * Same lifecycle contract as review-panel.js: `shown()` loads, `hidden()`
 * drops every listener, nothing runs while the tab is hidden, and init()
 * catches up on the launch that opens ON this tab (the router's first
 * showView runs before this file is parsed).
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const CHARTS = window.APEX_REVIEW_CHARTS;
  const dash = '—';

  /* ---------------------------------------------------------------------- */
  /*  State                                                                 */
  /* ---------------------------------------------------------------------- */

  const els = { view: null, list: null, detail: null, search: null, refresh: null, tab: null };
  let ready = false;
  let visible = false;
  let speedUnit = 'kph';

  /** Practice and test-day sessions, newest first, as `review:sessions` lists them. */
  let summaries = [];
  let loadedOnce = false;
  let listRead = null;
  let currentId = null;
  /** The open session as `review:session` returns it — for its laps' ids. */
  let session = null;
  /**
   * The debrief: `state` is `idle`, `loading`, `ok`, `none` (no review was made
   * for this session), `error` or `unavailable` (an older main with no IPC).
   */
  let practice = { id: null, state: 'idle', review: null };
  /** A review main says is waiting, offered as a banner while the tab is open. */
  let pendingBanner = null;
  /** Scroll the debrief into view once it paints (it was opened for the driver). */
  let practiceFocus = false;
  /** The lap being studied, or null on the debrief. */
  let lapView = null;
  /** Listener teardown for the lap view's canvases. */
  let lapOff = null;
  /** The circuit last sent by main, kept so the next lap need not resend it. */
  let heldMap = null;
  let heldMapKey = '';

  /* ---------------------------------------------------------------------- */
  /*  Formatting                                                            */
  /* ---------------------------------------------------------------------- */

  const known = (v) => typeof v === 'number' && Number.isFinite(v);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtLap(ms) {
    if (!known(ms) || ms <= 0) return dash;
    const m = Math.floor(ms / 60000);
    const s = (ms - m * 60000) / 1000;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  }

  const fix = (v, dp) => (known(v) ? v.toFixed(dp) : dash);

  /** A signed number of seconds: `+0.18`, `-1.04`; level inside half the last digit. */
  function fmtSec(sec, dp = 2) {
    if (!known(sec)) return dash;
    if (Math.abs(sec) < 0.5 / 10 ** dp) return (0).toFixed(dp);
    const s = sec.toFixed(dp);
    return sec > 0 ? `+${s}` : s;
  }

  const DAY_FMT = { weekday: 'short', day: 'numeric', month: 'short' };
  const TIME_FMT = { hour: '2-digit', minute: '2-digit' };

  function dayLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Unknown date';
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    const opts = d.getFullYear() === new Date().getFullYear() ? DAY_FMT : { ...DAY_FMT, year: 'numeric' };
    return d.toLocaleDateString(undefined, opts);
  }

  const clockLabel = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, TIME_FMT);
  };

  const toMph = (kph) => kph * 0.621371;
  const speedOf = (kph) => (known(kph) ? `${Math.round(speedUnit === 'mph' ? toMph(kph) : kph)}` : dash);
  const speedUnitLabel = () => (speedUnit === 'mph' ? 'mph' : 'km/h');
  // The main process words corner tips in km/h; restate them in the panel's unit.
  const tipText = (tip) =>
    speedUnit === 'mph'
      ? String(tip || '').replace(/(\d+(?:\.\d+)?) km\/h/g, (_m, n) => `${Math.round(toMph(Number(n)))} mph`)
      : String(tip || '');

  const secSigned = (sec, dp = 2) => fmtSec(sec, dp);
  const lapFromSec = (sec) => (known(sec) && sec > 0 ? fmtLap(sec * 1000) : dash);

  /** Gain, loss or level for a delta in seconds — the overlay's thresholds. */
  function toneOfSec(sec) {
    if (!known(sec)) return 'none';
    if (sec > 0.02) return 'loss';
    if (sec < -0.02) return 'gain';
    return 'level';
  }

  /** 0..1 strength of a corner delta's colour: full at two tenths. */
  const strengthOf = (sec) => (known(sec) ? Math.max(0.3, Math.min(1, Math.abs(sec) / 0.2)) : 0);

  const cornerLabel = (index) => `C${Number(index) + 1}`;

  /** Practice and test days get a debrief; races and qualifying do not. */
  function isPracticeType(t) {
    const k = String(t || '').toLowerCase();
    return k.startsWith('prac') || k.startsWith('test');
  }

  /** The driver's name out of a reference label: `A. Winters · 1:19.299 · board`. */
  function targetName(t) {
    if (!t) return '';
    if (t.kind === 'sessionBest') return 'your session best';
    const first = String(t.label || '').split(' · ')[0].trim();
    return first || 'the reference';
  }

  /** "Braking 14 m early" — positive braked LATER. */
  function brakeWords(m) {
    if (!known(m) || Math.abs(m) < 3) return '';
    return `Braking ${Math.round(Math.abs(m))} m ${m < 0 ? 'early' : 'late'}`;
  }

  /** "6 km/h down at the apex" — positive is faster. */
  function apexWords(kph) {
    if (!known(kph) || Math.abs(kph) < 1) return '';
    const v = Math.round(Math.abs(speedUnit === 'mph' ? toMph(kph) : kph));
    return `${v} ${speedUnitLabel()} ${kph < 0 ? 'down' : 'up'} at the apex`;
  }

  /** What to try next time, from a corner's averages. */
  function tipWords(c) {
    const parts = [];
    if (known(c.avgBrakeDeltaM) && c.avgBrakeDeltaM <= -3) parts.push(`brake ${Math.round(-c.avgBrakeDeltaM)} m later`);
    if (known(c.avgBrakeDeltaM) && c.avgBrakeDeltaM >= 3) parts.push(`brake ${Math.round(c.avgBrakeDeltaM)} m earlier`);
    if (known(c.avgApexKphDelta) && c.avgApexKphDelta <= -1) {
      const v = Math.round(Math.abs(speedUnit === 'mph' ? toMph(c.avgApexKphDelta) : c.avgApexKphDelta));
      parts.push(`carry ${v} ${speedUnitLabel()} more to the apex`);
    }
    if (!parts.length) return 'Entry and apex match the reference — the time goes on the way out. Look at your throttle pick-up.';
    const s = parts.join(', ');
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
  }

  /* ---------------------------------------------------------------------- */
  /*  The session list                                                      */
  /* ---------------------------------------------------------------------- */

  function matchesFilter(row) {
    const q = els.search ? els.search.value.trim().toLowerCase() : '';
    if (!q) return true;
    return [row.track, row.car, row.carClass].some((v) => String(v || '').toLowerCase().includes(q));
  }

  function renderList() {
    if (!els.list) return;
    const rows = summaries.filter(matchesFilter);
    if (!rows.length) {
      els.list.innerHTML = `<p class="rv-empty pr-listempty">${
        summaries.length ? 'No session matches that.'
          : loadedOnce ? 'No practice sessions yet. Drive one — the review is built when you leave it.'
            : 'Reading your sessions…'
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
      html += `
        <button class="rv__card" type="button" data-prsession="${esc(row.id)}" data-type="practice"
                data-active="${String(row.id === currentId)}">
          <b>${esc(row.track || 'Unknown circuit')}</b>
          <i>${esc([row.car, row.carClass].filter(Boolean).join(' · ') || 'Practice')}</i>
          <span class="rv__cardfoot">
            <span class="rv__cardtime" data-none="${String(!known(row.bestMs))}">${
              known(row.bestMs) ? fmtLap(row.bestMs) : 'no clean lap'
            }</span>
            <span class="rv__cardmeta">${esc(laps)}${row.startedAt ? ` · ${esc(clockLabel(row.startedAt))}` : ''}</span>
          </span>
        </button>`;
    }
    els.list.innerHTML = html;
  }

  /* ---------------------------------------------------------------------- */
  /*  The debrief                                                           */
  /* ---------------------------------------------------------------------- */

  /** One lap's corner losses as a strip of tiny cells. */
  function cornerStripHtml(lap, count) {
    const byIndex = new Map((lap.corners || []).map((c) => [c.index, c]));
    let cells = '';
    for (let i = 0; i < count; i += 1) {
      const c = byIndex.get(i);
      const d = c ? c.deltaSec : null;
      cells += `<i data-tone="${toneOfSec(d)}" style="--a:${strengthOf(d).toFixed(2)}"></i>`;
    }
    return `<span class="rv-pr-strip" aria-hidden="true">${cells}</span>`;
  }

  /** The three corners that cost the most on average, worst first. */
  function worstCorners(r) {
    return (r.corners || [])
      .filter((c) => known(c.avgLossSec) && c.avgLossSec > 0.005)
      .sort((a, b) => b.avgLossSec - a.avgLossSec)
      .slice(0, 3);
  }

  /** A corner's delta on every lap, for the little bars on its loss card. */
  function cornerSeries(r, index) {
    return (r.laps || []).map((lap) => {
      const c = (lap.corners || []).find((x) => x.index === index);
      return { lapNo: lap.lapNo, at: lap.at, valid: lap.valid, d: c ? c.deltaSec : null };
    });
  }

  function lossCardHtml(r, c, rank) {
    const series = cornerSeries(r, c.index);
    const worst = Math.max(0.05, ...series.map((p) => (known(p.d) ? Math.abs(p.d) : 0)));
    const bars = series.map((p) => {
      const h = known(p.d) ? Math.max(6, Math.round((Math.abs(p.d) / worst) * 100)) : 0;
      return `<i data-tone="${toneOfSec(p.d)}" style="height:${h}%" title="Lap ${esc(p.lapNo)}: ${esc(secSigned(p.d))} s"></i>`;
    }).join('');
    const faults = [brakeWords(c.avgBrakeDeltaM), apexWords(c.avgApexKphDelta)].filter(Boolean);
    return `
      <div class="rv-pr-loss" data-tone="${toneOfSec(c.avgLossSec)}">
        <div class="rv-pr-loss__top">
          <span class="rv-pr-loss__rank">${rank}</span>
          <span class="rv-pr-loss__name">${esc(cornerLabel(c.index))}</span>
          <span class="rv-pr-loss__avg">${esc(secSigned(c.avgLossSec))}<small> s a lap</small></span>
        </div>
        <div class="rv-pr-loss__fault">${faults.length ? esc(faults.join(' · ')) : 'Lost between entry and exit'}</div>
        <div class="rv-pr-loss__bars" aria-hidden="true">${bars}</div>
        <div class="rv-pr-loss__range">
          <span>Best <b>${esc(secSigned(c.bestSec))}</b></span>
          <span>Worst <b>${esc(secSigned(c.worstSec))}</b></span>
          <span>${esc(String(c.laps))} lap${c.laps === 1 ? '' : 's'} scored</span>
        </div>
        <div class="rv-pr-loss__tip">
          <svg class="icon"><use href="#i-sparkles" /></svg><span>${esc(tipWords(c))}</span>
        </div>
      </div>`;
  }

  function practiceLapsHtml(r) {
    const n = (r.corners || []).length;
    const best = r.bestLapSec;
    const rows = (r.laps || []).map((lap) => {
      const isBest = known(best) && lap.valid && Math.abs(lap.lapSec - best) < 0.0005;
      const studiable = lap.hasTrace;
      return `
        <tr data-prlap="${esc(lap.at)}" data-valid="${String(!!lap.valid)}" data-best="${String(isBest)}"
            data-trace="${String(!!studiable)}" ${studiable ? 'tabindex="0" role="button" title="Study this lap"' : 'title="No telemetry was kept for this lap"'}>
          <td class="rv-pr-laps__no">${esc(String(lap.lapNo))}</td>
          <td class="rv-pr-laps__time">${esc(lapFromSec(lap.lapSec))}</td>
          <td class="rv-pr-laps__delta" data-tone="${toneOfSec(lap.deltaSec)}">${esc(fmtSec(lap.deltaSec, 3))}</td>
          <td class="rv-pr-laps__strip">${studiable && n ? cornerStripHtml(lap, n) : '<span class="rv-pr-muted">no trace</span>'}</td>
          <td class="rv-pr-laps__flag">${lap.valid ? (isBest ? '<span class="rv-pr-tag rv-pr-tag--best">Best</span>' : '')
            : '<span class="rv-pr-tag">Invalid</span>'}</td>
        </tr>`;
    }).join('');
    return `
      <table class="rv-pr-laps">
        <thead><tr><th>Lap</th><th>Time</th><th>vs target</th><th>Corners${n ? ` · C1–C${n}` : ''}</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function practiceGridHtml(r) {
    const laps = r.laps || [];
    const corners = r.corners || [];
    if (!laps.length || !corners.length) return '';
    const head = laps.map((lap) =>
      `<span class="rv-pr-grid__lap" data-valid="${String(!!lap.valid)}">${esc(String(lap.lapNo))}</span>`).join('');
    const rows = corners.map((c) => {
      const cells = laps.map((lap) => {
        const hit = (lap.corners || []).find((x) => x.index === c.index);
        const d = hit ? hit.deltaSec : null;
        const tip = [
          `${cornerLabel(c.index)} · lap ${lap.lapNo}`,
          known(d) ? `${secSigned(d)} s` : 'not scored',
          hit ? brakeWords(hit.brakeDeltaM) : '',
          hit ? apexWords(hit.apexKphDelta) : '',
        ].filter(Boolean).join('\n');
        return `<button type="button" class="rv-pr-cell" data-tone="${toneOfSec(d)}" data-valid="${String(!!lap.valid)}"
                  style="--a:${strengthOf(d).toFixed(2)}" data-prlap="${esc(lap.at)}" data-prcorner="${c.index}"
                  data-tip="${esc(tip)}" aria-label="${esc(tip.replace(/\n/g, ', '))}"></button>`;
      }).join('');
      return `
        <span class="rv-pr-grid__name">${esc(cornerLabel(c.index))}</span>
        ${cells}
        <span class="rv-pr-grid__avg" data-tone="${toneOfSec(c.avgLossSec)}">${esc(secSigned(c.avgLossSec))}</span>`;
    }).join('');
    return `
      <div class="rv-pr-grid" style="--cols:${laps.length}">
        <span class="rv-pr-grid__corner">Lap</span>${head}<span class="rv-pr-grid__avghead">Avg</span>
        ${rows}
      </div>`;
  }

  function quietCard(text) {
    return `
      <div class="rv-card rv-pr rv-pr--quiet">
        <div class="rv-pr__head"><span class="rv-pr__badge"><svg class="icon"><use href="#i-target" /></svg>Practice review</span></div>
        <p class="rv-pr__note">${esc(text)}</p>
      </div>`;
  }

  /** The whole debrief card, for the open session's current state. */
  function debriefHtml() {
    if (!currentId) return '';
    if (practice.id !== currentId || practice.state === 'idle' || practice.state === 'loading') {
      return quietCard('Lining every lap up against the lap you chased…');
    }
    if (practice.state === 'unavailable') return quietCard('This version of the app cannot build practice reviews.');
    if (practice.state !== 'ok' || !practice.review) {
      return quietCard(practice.state === 'error'
        ? 'The review for this session could not be read.'
        : 'No review could be built for this session: none of its laps kept a trace.');
    }

    const r = practice.review;
    const t = r.target;
    const gapBest = known(r.bestLapSec) && t && known(t.lapSec) ? r.bestLapSec - t.lapSec : null;
    const gapTheo = known(r.theoreticalBestSec) && t && known(t.lapSec) ? r.theoreticalBestSec - t.lapSec : null;
    const worst = worstCorners(r);
    const lostTotal = worst.reduce((sum, c) => sum + c.avgLossSec, 0);
    const scored = (r.laps || []).filter((l) => l.hasTrace).length;

    const stat = (label, value, note, tone, big) => `
      <div class="rv-pr-stat${big ? ' rv-pr-stat--hero' : ''}">
        <div class="rv-pr-stat__label">${esc(label)}</div>
        <div class="rv-pr-stat__value"${tone ? ` data-tone="${tone}"` : ''}>${value}</div>
        ${note ? `<div class="rv-pr-stat__note">${note}</div>` : ''}
      </div>`;

    return `
      <div class="rv-card rv-pr">
        <div class="rv-pr__head">
          <span class="rv-pr__badge"><svg class="icon"><use href="#i-target" /></svg>Practice review</span>
          ${t ? `<span class="rv-pr__vs">vs <b>${esc(targetName(t))}</b><span class="rv-pr__vstime">${esc(lapFromSec(t.lapSec))}</span></span>` : ''}
          <span class="rv-pr__meta">${esc(r.track || '')}${r.car ? ` · ${esc(r.car)}` : ''} · ${esc(String((r.laps || []).length))} laps · ${esc(String((r.corners || []).length))} corners</span>
        </div>

        <div class="rv-pr__stats">
          ${stat('Best lap', esc(lapFromSec(r.bestLapSec)),
            known(gapBest) ? `<span data-tone="${toneOfSec(gapBest)}">${esc(fmtSec(gapBest, 3))}</span> to the target` : '', '', true)}
          ${stat('Theoretical best', esc(lapFromSec(r.theoreticalBestSec)),
            known(gapTheo) ? `<span data-tone="${toneOfSec(gapTheo)}">${esc(fmtSec(gapTheo, 3))}</span> · your best corners, joined` : 'your best corners, joined')}
          ${stat('Consistency', known(r.consistencySec) ? `±${esc(fix(r.consistencySec, 2))}s` : dash,
            'spread of your valid laps')}
          ${stat('Top three cost', worst.length ? `${esc(secSigned(lostTotal))}s` : dash,
            worst.length ? `a lap, in ${worst.map((c) => esc(cornerLabel(c.index))).join(', ')}` : 'nothing stands out', worst.length ? 'loss' : '')}
        </div>

        <div class="rv-pr__cols">
          <section class="rv-pr__losses">
            <div class="rv-pr__title">Where the time went</div>
            ${worst.length
              ? worst.map((c, i) => lossCardHtml(r, c, i + 1)).join('')
              : `<p class="rv-pr__note">${scored
                ? 'No corner costs you time on average — the gap is spread thin across the lap.'
                : 'None of these laps kept a trace, so their corners could not be scored.'}</p>`}
          </section>
          <section class="rv-pr__lapsbox">
            <div class="rv-pr__title">Every lap against the target <span class="rv-pr-muted">· click one to study it</span></div>
            ${practiceLapsHtml(r)}
          </section>
        </div>

        ${(r.corners || []).length && scored ? `
        <section class="rv-pr__gridbox">
          <div class="rv-pr__gridhead">
            <span class="rv-pr__title">Corner by corner</span>
            <span class="rv-pr__legend">
              <span><i data-tone="gain"></i>Faster than the target</span>
              <span><i data-tone="loss"></i>Slower</span>
              <span class="rv-pr-muted">Click a cell to study that corner on that lap</span>
            </span>
          </div>
          ${practiceGridHtml(r)}
          <div class="rv-pr-tipbox" hidden></div>
        </section>` : ''}
      </div>`;
  }

  /** The banner for a review that arrived while the tab is open. */
  function pendingBannerHtml() {
    if (!pendingBanner || lapView) return '';
    const p = pendingBanner;
    const bits = [p.track, known(p.laps) ? `${p.laps} laps` : '', known(p.bestLapSec) ? `best ${lapFromSec(p.bestLapSec)}` : '']
      .filter(Boolean).map(esc).join(' · ');
    return `
      <div class="rv-pr-banner" role="status">
        <svg class="icon"><use href="#i-target" /></svg>
        <span><b>Practice review ready</b>${bits ? ` — ${bits}` : ''}</span>
        <button type="button" class="btn btn--sm" data-propen>Open</button>
        <button type="button" class="iconbtn rv-pr-banner__x" data-prdismiss aria-label="Dismiss">
          <svg class="icon"><use href="#i-x" /></svg>
        </button>
      </div>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  The deep dive                                                         */
  /* ---------------------------------------------------------------------- */

  /** The tightest window allowed, as a lap fraction. */
  const MIN_SPAN = 0.004;
  /** How much road a corner is framed with: before its entry, after its exit. */
  const LEAD_M = 60;
  const TAIL_M = 40;

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

  function zoomAbout(factor, anchorD) {
    if (!lapView) return;
    const [a, b] = lapView.window;
    const span = b - a;
    const next = Math.max(MIN_SPAN, Math.min(1, span * factor));
    if (Math.abs(next - span) < 1e-6) return;
    const anchor = known(anchorD) ? Math.min(b, Math.max(a, anchorD)) : (a + b) / 2;
    const f = span > 0 ? (anchor - a) / span : 0.5;
    let from = anchor - f * next;
    if (from < 0) from = 0;
    if (from + next > 1) from = 1 - next;
    setWindow(from, from + next);
  }

  /** Frame one corner: the window, the selected row, the held map point. */
  function focusCorner(index) {
    if (!lapView || !lapView.result) return;
    const row = (lapView.result.corners || []).find((c) => c.index === index);
    if (!row) return;
    const L = lapView.lengthM > 0 ? lapView.lengthM : 4000;
    lapView.corner = index;
    // The map holds the apex: that is where the corner is decided.
    const ch = lapView.result.detail.channels;
    lapView.pin = indexAt(ch, row.apexD);
    lapView.cursor = lapView.pin;
    for (const tr of els.detail.querySelectorAll('tr[data-prcorner]')) {
      tr.setAttribute('data-on', String(Number(tr.dataset.prcorner) === index));
    }
    setWindow(row.entryD - LEAD_M / L, row.exitD + TAIL_M / L);
  }

  /** Distance -> sample index by binary search; `d` is sorted. */
  function indexAt(ch, dd) {
    const d = ch.d;
    let lo = 0;
    let hi = d.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d[mid] < dd) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(d[lo - 1] - dd) < Math.abs(d[lo] - dd)) return lo - 1;
    return lo;
  }

  /** The target's sample at the same point of the ROAD as the cursor. */
  function vsIndexAt(view, dd) {
    const vd = view.result && view.result.vs && view.result.vs.channels && view.result.vs.channels.d;
    if (!Array.isArray(vd) || !vd.length || !known(dd)) return null;
    return indexAt({ d: vd }, dd);
  }

  /** The delta trace at a distance, by nearest point. */
  function deltaAt(view, dd) {
    const dl = view.result && view.result.delta;
    if (!dl || !Array.isArray(dl.d) || !dl.d.length) return null;
    const i = indexAt(dl, dd);
    const v = dl.dt[i];
    return known(v) ? v : null;
  }

  /** The cursor readout under the map: where, you, the target, the gap. */
  function readoutHtml(view) {
    const res = view.result;
    if (!res || !res.detail) return '';
    const ch = res.detail.channels;
    const i = view.cursor === null ? null : view.cursor;
    if (i === null) {
      return `<div class="pr-read pr-read--idle">Move over the charts to read the lap — click a corner below to frame it.</div>`;
    }
    const dd = ch.d[i];
    const j = vsIndexAt(view, dd);
    const vs = res.vs && res.vs.channels;
    const m = known(dd) && view.lengthM > 0 ? Math.round(dd * view.lengthM) : null;
    const dt = deltaAt(view, dd);
    const pctOf = (v) => (known(v) ? `${Math.round(v * 100)}%` : dash);
    const cell = (label, mine, theirs) => `
      <div class="pr-read__cell"><span>${label}</span><b>${mine}</b><i>${theirs}</i></div>`;
    return `
      <div class="pr-read">
        <div class="pr-read__where">
          <span>${m === null ? dash : `${m} m`}</span>
          <b data-tone="${toneOfSec(dt)}">${known(dt) ? `${esc(fmtSec(dt, 2))} s` : dash}</b>
        </div>
        <div class="pr-read__grid">
          ${cell(speedUnitLabel(), speedOf(ch.speedKph[i]), vs && j !== null ? speedOf(vs.speedKph[j]) : dash)}
          ${cell('Throttle', pctOf(ch.throttle[i]), vs && j !== null ? pctOf(vs.throttle[j]) : dash)}
          ${cell('Brake', pctOf(ch.brake[i]), vs && j !== null ? pctOf(vs.brake[j]) : dash)}
          ${cell('Gear', known(ch.gear && ch.gear[i]) ? String(ch.gear[i]) : dash,
            vs && j !== null && vs.gear && known(vs.gear[j]) ? String(vs.gear[j]) : dash)}
        </div>
        <div class="pr-read__key"><span>You</span><span>${esc(targetName(res.target))}</span></div>
      </div>`;
  }

  function cornerTableHtml(view) {
    const res = view.result;
    const rows = (res && res.corners) || [];
    if (!rows.length) {
      return `<p class="rv-pr__note">The target lap has no corners to compare against.</p>`;
    }
    let worstIdx = -1;
    let worstVal = 0.02;
    for (const c of rows) if (known(c.deltaSec) && c.deltaSec > worstVal) { worstVal = c.deltaSec; worstIdx = c.index; }
    const speedDelta = (v) => {
      if (!known(v)) return dash;
      const u = speedUnit === 'mph' ? toMph(v) : v;
      if (Math.abs(u) < 0.5) return '0';
      return `${u > 0 ? '+' : '−'}${Math.round(Math.abs(u))}`;
    };
    const speedTone = (v) => (!known(v) ? 'none' : v <= -1 ? 'loss' : v >= 1 ? 'gain' : 'level');
    const body = rows.map((c) => {
      const brake = known(c.brakeDeltaM) && Math.abs(c.brakeDeltaM) >= 1
        ? `${Math.round(Math.abs(c.brakeDeltaM))} m ${c.brakeDeltaM < 0 ? 'early' : 'late'}`
        : known(c.brakeDeltaM) ? 'on the mark' : dash;
      const line = known(c.lineOffsetM) ? `${fix(c.lineOffsetM, 1)} m` : dash;
      const lineTone = !known(c.lineOffsetM) ? 'none' : c.lineOffsetM >= 3 ? 'warn' : 'level';
      return `
        <tr data-prcorner="${c.index}" data-worst="${String(c.index === worstIdx)}"
            data-on="${String(view.corner === c.index)}" tabindex="0" role="button"
            title="Frame ${esc(cornerLabel(c.index))} on the map and the charts">
          <td class="pr-ct__name">${esc(cornerLabel(c.index))}</td>
          <td class="pr-ct__time" data-tone="${toneOfSec(c.deltaSec)}">${known(c.deltaSec) ? `${esc(fmtSec(c.deltaSec, 2))} s` : dash}</td>
          <td class="pr-ct__brake" data-tone="${known(c.brakeDeltaM) && Math.abs(c.brakeDeltaM) >= 3 ? 'warn' : 'level'}">${esc(brake)}</td>
          <td class="pr-ct__speed" data-tone="${speedTone(c.apexKphDelta)}">
            ${esc(speedDelta(c.apexKphDelta))}<small>${known(c.minKph) ? ` · ${esc(speedOf(c.minKph))}` : ''}</small></td>
          <td class="pr-ct__speed" data-tone="${speedTone(c.exitKphDelta)}">${esc(speedDelta(c.exitKphDelta))}</td>
          <td class="pr-ct__line" data-tone="${lineTone}">${esc(line)}</td>
          <td class="pr-ct__tip">${esc(tipText(c.tip))}</td>
        </tr>`;
    }).join('');
    return `
      <table class="pr-ct">
        <thead><tr>
          <th>Corner</th><th>Time</th><th>Braking</th>
          <th title="Minimum speed: you against the target, then yours">Apex ${esc(speedUnitLabel())}</th>
          <th title="Speed where the corner ends, against the target">Exit</th>
          <th title="How far from the target's line, on average, between entry and exit">Line</th>
          <th>What to try</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  function lapViewHtml(view) {
    const lap = view.plap;
    const back = `
      <button type="button" class="btn btn--ghost btn--sm" data-prback title="Back to the debrief">
        <svg class="icon"><use href="#i-arrow-left" /></svg><span>Debrief</span>
      </button>`;
    if (!view.result) {
      return `
        <div class="rv-card rv-lap__bar">${back}<span class="rv-lap__name">Lap ${esc(String(lap.lapNo))}</span></div>
        <div class="rv-card"><p class="rv-pr__note">${esc(view.error || 'Reading the lap and the target…')}</p></div>`;
    }
    const res = view.result;
    const t = res.target;
    const gap = t && known(t.lapSec) && known(lap.lapSec) && lap.lapSec > 0 ? lap.lapSec - t.lapSec : null;
    const [a, b] = view.window;
    const whole = b - a >= 0.999;
    return `
      <div class="rv-lap pr-lap">
        <div class="rv-lap__bar">
          ${back}
          <span class="rv-lap__name">Lap ${esc(String(lap.lapNo))}</span>
          <span class="rv-lap__time">${esc(lapFromSec(lap.lapSec))}</span>
          ${lap.valid ? '' : '<span class="rv-pr-tag">Invalid</span>'}
          <span class="pr-lap__vs">
            <span class="rv-pr__vs">vs <b>${esc(targetName(t))}</b><span class="rv-pr__vstime">${esc(lapFromSec(t && t.lapSec))}</span></span>
            ${known(gap) ? `<span class="pr-lap__gap" data-tone="${toneOfSec(gap)}">${esc(fmtSec(gap, 3))} s</span>` : ''}
          </span>
          <span class="pr-lap__zoom">
            <span class="pr-lap__zoomlabel" data-przoomlabel>${whole ? 'Whole lap'
              : `${Math.round(a * view.lengthM)}–${Math.round(b * view.lengthM)} m`}</span>
            <button type="button" class="btn btn--ghost btn--sm" data-przoom="reset" ${whole ? 'disabled' : ''}>Whole lap</button>
          </span>
        </div>

        <div class="rv-lap__body">
          <div class="rv-lap__charts">
            <div class="rv-chan" title="Move to read · click to hold a point · drag across a stretch to zoom · scroll to zoom"><canvas></canvas></div>
          </div>
          <aside class="rv-lap__side">
            <div class="rv-map">${view.map ? '<canvas></canvas>' : `
              <div class="rv-map__none">
                <svg class="icon"><use href="#i-circuit" /></svg>
                <span>No circuit shape for ${esc(res.detail.track || 'this track')} yet.</span>
              </div>`}</div>
            <div class="pr-readwrap">${readoutHtml(view)}</div>
          </aside>
        </div>

        <div class="rv-card pr-ctcard">
          <div class="rv-pr__gridhead">
            <span class="rv-pr__title">Corner by corner · lap ${esc(String(lap.lapNo))}</span>
            <span class="rv-pr__legend"><span class="rv-pr-muted">Click a corner to frame it on the map and every chart</span></span>
          </div>
          ${cornerTableHtml(view)}
        </div>
      </div>`;
  }

  /** Paint the lap view's canvases and wire the scrub, the zoom and the map. */
  function paintLapView() {
    const view = lapView;
    if (!view || !view.result || !view.result.detail || !els.detail || !CHARTS) return;
    const res = view.result;
    const chanWrap = els.detail.querySelector('.pr-lap .rv-chan');
    const mapWrap = els.detail.querySelector('.pr-lap .rv-map');
    const readout = els.detail.querySelector('.pr-lap .pr-readwrap');
    if (!chanWrap) return;
    const canvas = chanWrap.querySelector('canvas');
    const mapCanvas = mapWrap ? mapWrap.querySelector('canvas') : null;
    const ch = res.detail.channels;
    const vs = res.vs ? res.vs.channels : null;
    const aids = CHARTS.aidsKnown(ch) || !!(vs && CHARTS.aidsKnown(vs));
    const steerDeg = CHARTS.steerRangeOf(ch) > 0 && (!vs || CHARTS.steerRangeOf(vs) > 0);
    const faster = known(view.plap.lapSec) && res.target && known(res.target.lapSec)
      ? (Math.abs(view.plap.lapSec - res.target.lapSec) < 0.005 ? null
        : view.plap.lapSec < res.target.lapSec ? 'mine' : 'theirs')
      : null;
    let geom = null;

    const repaint = () => {
      const cursorD = view.cursor === null ? -1 : ch.d[view.cursor];
      geom = CHARTS.drawChannels(
        canvas, ch,
        CHARTS.channelBands({ mph: speedUnit === 'mph', delta: !!res.delta, aids, steerDeg }),
        {
          sectors: res.detail.sectors,
          lengthM: view.lengthM,
          cursorD,
          window: view.window,
          select: view.select,
          vs,
          delta: res.delta,
          micro: res.micro || [],
        },
      );
      if (mapCanvas && view.map) {
        const out = CHARTS.drawLapMap(mapCanvas, view.map, ch, {
          sectors: res.detail.sectors,
          cursorD,
          cursorIndex: view.cursor === null ? -1 : view.cursor,
          window: view.window,
          pan: null,
          show: { mine: true, vs: true },
          lines: 'd',
          vs,
          faster,
          mode: 'inputs',
          lengthM: view.lengthM,
          vsLabel: 'T',
        });
        view.mapGeom = out ? out.geom : null;
      }
      if (readout) readout.innerHTML = readoutHtml(view);
      const [a, b] = view.window;
      const whole = b - a >= 0.999;
      const label = els.detail.querySelector('[data-przoomlabel]');
      if (label) label.textContent = whole ? 'Whole lap' : `${Math.round(a * view.lengthM)}–${Math.round(b * view.lengthM)} m`;
      const reset = els.detail.querySelector('[data-przoom="reset"]');
      if (reset) reset.disabled = whole;
    };
    view.repaint = repaint;
    repaint();

    const distanceAtX = (clientX) => {
      const box = canvas.getBoundingClientRect();
      const f = (clientX - box.left - geom.x0) / Math.max(1, geom.x1 - geom.x0);
      const [a, b] = view.window;
      return Math.min(b, Math.max(a, a + Math.min(1, Math.max(0, f)) * (b - a)));
    };

    let drag = null;
    const DRAG_PX = 4;
    const onMove = (evt) => {
      if (!geom) return;
      if (drag) {
        if (Math.abs(evt.clientX - drag.x) > DRAG_PX) drag.moved = true;
        if (drag.moved) {
          view.select = [drag.d, distanceAtX(evt.clientX)];
          view.cursor = indexAt(ch, view.select[1]);
          repaint();
          return;
        }
      }
      const next = indexAt(ch, distanceAtX(evt.clientX));
      if (next === view.cursor) return;
      view.cursor = next;
      repaint();
    };
    const onLeave = () => {
      if (view.cursor === view.pin) return;
      view.cursor = view.pin;
      repaint();
    };
    const onWheel = (evt) => {
      if (!geom) return;
      evt.preventDefault();
      zoomAbout(evt.deltaY > 0 ? 1.25 : 0.8, distanceAtX(evt.clientX));
    };
    const onDown = (evt) => {
      if (!geom) return;
      drag = { x: evt.clientX, d: distanceAtX(evt.clientX), moved: false };
      canvas.setAttribute('data-drag', 'true');
      evt.preventDefault();
    };
    const onUp = (evt) => {
      if (!drag) return;
      const was = drag;
      drag = null;
      canvas.removeAttribute('data-drag');
      view.select = null;
      if (!was.moved) {
        view.pin = indexAt(ch, was.d);
        view.cursor = view.pin;
        repaint();
        return;
      }
      const to = distanceAtX(evt && evt.clientX !== undefined ? evt.clientX : was.x);
      setWindow(Math.min(was.d, to), Math.max(was.d, to));
    };
    const onMapClick = (evt) => {
      if (!view.mapGeom) return;
      const box = mapCanvas.getBoundingClientRect();
      const dd = CHARTS.distanceAtPoint(view.mapGeom, evt.clientX - box.left, evt.clientY - box.top);
      if (dd === null) return;
      view.pin = indexAt(ch, dd);
      view.cursor = view.pin;
      // The corner the click landed in, if any, is the one the table selects.
      const hit = (res.corners || []).find((c) => dd >= c.entryD - LEAD_M / view.lengthM && dd <= c.exitD + TAIL_M / view.lengthM);
      if (hit) focusCorner(hit.index);
      else repaint();
    };
    const onMapWheel = (evt) => {
      evt.preventDefault();
      const [a, b] = view.window;
      const box = mapCanvas.getBoundingClientRect();
      const at = view.mapGeom
        ? CHARTS.stationNear(view.mapGeom, evt.clientX - box.left, evt.clientY - box.top, null)
        : null;
      const k = Math.min(1.5, Math.max(0.67, Math.exp(evt.deltaY * 0.0016)));
      zoomAbout(k, at === null ? (a + b) / 2 : at);
    };
    const onResize = () => repaint();

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('resize', onResize);
    if (mapCanvas) {
      mapCanvas.addEventListener('click', onMapClick);
      mapCanvas.addEventListener('wheel', onMapWheel, { passive: false });
    }
    lapOff = () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onResize);
      if (mapCanvas) {
        mapCanvas.removeEventListener('click', onMapClick);
        mapCanvas.removeEventListener('wheel', onMapWheel);
      }
      view.repaint = null;
    };
  }

  /** The lap id `review:session` knows a debrief row by. */
  function lapIdAt(at, lapNo) {
    if (!session || !Array.isArray(session.stints)) return null;
    for (const stint of session.stints) {
      const hit = stint.laps.find((l) => l.at === at);
      if (hit) return hit.id || null;
    }
    for (const stint of session.stints) {
      const hit = stint.laps.find((l) => l.lapNo === lapNo);
      if (hit) return hit.id || null;
    }
    return null;
  }

  /** Open one lap of the debrief against the session's target. */
  async function openLap(at, corner) {
    const r = practice.review;
    if (!r || !currentId) return;
    const plap = (r.laps || []).find((l) => l.at === at);
    if (!plap || !plap.hasTrace) return;
    window.APEX_FEATURE_CATALOG?.note('action:practice.lap');
    if (lapOff) { lapOff(); lapOff = null; }
    lapView = {
      plap,
      result: null,
      error: '',
      map: null,
      mapGeom: null,
      lengthM: r.trackLengthM || 0,
      window: [0, 1],
      cursor: null,
      pin: null,
      select: null,
      corner: null,
      repaint: null,
    };
    const mine = lapView;
    render();
    if (!window.apex || typeof window.apex.practiceLap !== 'function') {
      mine.error = 'This version of the app cannot open a practice lap yet.';
      if (lapView === mine) render();
      return;
    }
    let res = null;
    try {
      res = await window.apex.practiceLap({
        sessionId: currentId,
        lapId: lapIdAt(at, plap.lapNo),
        at,
        haveMapKey: heldMapKey,
      });
    } catch {
      res = null;
    }
    if (lapView !== mine) return;
    const result = res && res.result ? res.result : (res && res.detail ? res : null);
    if (!result || !result.detail) {
      mine.error = (res && res.error) || 'That lap could not be read — its telemetry may have been removed.';
      render();
      return;
    }
    mine.result = result;
    if (result.map) {
      heldMap = result.map;
      heldMapKey = result.detail.mapKey;
    }
    mine.map = result.detail.mapKey === heldMapKey ? heldMap : null;
    mine.lengthM = (mine.map && mine.map.lengthM) || result.lengthM || r.trackLengthM || 0;
    render();
    if (known(corner)) focusCorner(corner);
  }

  function closeLap() {
    if (lapOff) { lapOff(); lapOff = null; }
    lapView = null;
    render();
  }

  /* ---------------------------------------------------------------------- */
  /*  Rendering                                                             */
  /* ---------------------------------------------------------------------- */

  function render() {
    if (!els.detail) return;
    if (lapOff) { lapOff(); lapOff = null; }
    if (lapView) {
      els.detail.innerHTML = lapViewHtml(lapView);
      paintLapView();
      return;
    }
    if (!currentId) {
      els.detail.innerHTML = `
        <div class="rv-card rv-pr rv-pr--quiet pr-empty">
          <div class="rv-pr__head"><span class="rv-pr__badge"><svg class="icon"><use href="#i-target" /></svg>Practice review</span></div>
          <p class="rv-pr__note">${loadedOnce
            ? 'Leave a practice session in which you set a timed lap, and its review lands here: every lap against the lap you chased, and exactly where the time went.'
            : 'Reading your practice sessions…'}</p>
        </div>`;
      return;
    }
    els.detail.innerHTML = `
      <div class="rv-pr-bannerslot">${pendingBannerHtml()}</div>
      <div class="rv-pr-slot">${debriefHtml()}</div>`;
    if (practiceFocus && practice.state === 'ok') {
      practiceFocus = false;
      const card = els.detail.querySelector('.rv-pr');
      if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function renderBanner() {
    if (!els.detail || lapView) return;
    const slot = els.detail.querySelector('.rv-pr-bannerslot');
    if (slot) slot.innerHTML = pendingBannerHtml();
    else render();
  }

  /** Light (or clear) the dot on the Practice tab button. */
  function markTab(on) {
    if (els.tab) els.tab.toggleAttribute('data-pending', !!on);
  }

  /* ---------------------------------------------------------------------- */
  /*  Loading                                                               */
  /* ---------------------------------------------------------------------- */

  async function loadList(force) {
    if (listRead) return listRead;
    if (loadedOnce && !force) return null;
    listRead = (async () => {
      try {
        const res = await window.apex.reviewSessions();
        const all = (res && Array.isArray(res.sessions)) ? res.sessions : [];
        summaries = all.filter((row) => isPracticeType(row.sessionType));
      } catch {
        summaries = [];
      }
      loadedOnce = true;
      if (currentId && !summaries.some((row) => row.id === currentId)) {
        currentId = null;
        session = null;
      }
      renderList();
      if (!currentId && summaries.length) await openSession(summaries[0].id);
      else render();
    })();
    try { await listRead; } finally { listRead = null; }
    return null;
  }

  async function openSession(id) {
    if (!id) return;
    window.APEX_FEATURE_CATALOG?.note('action:practice.debrief');
    if (lapOff) { lapOff(); lapOff = null; }
    lapView = null;
    currentId = id;
    session = null;
    practice = { id, state: 'loading', review: null };
    renderList();
    render();
    if (!window.apex || typeof window.apex.reviewPractice !== 'function') {
      practice = { id, state: 'unavailable', review: null };
      render();
      return;
    }
    let review = null;
    let failed = false;
    try {
      const [res, sres] = await Promise.all([
        window.apex.reviewPractice(id),
        window.apex.reviewSession ? window.apex.reviewSession(id).catch(() => null) : Promise.resolve(null),
      ]);
      if (res && Array.isArray(res.laps)) review = res;
      else if (res && res.review && Array.isArray(res.review.laps)) review = res.review;
      else if (res && res.ok === false) failed = true;
      if (currentId === id) session = (sres && sres.session) || null;
    } catch {
      failed = true;
    }
    if (currentId !== id) return;
    practice = { id, state: review ? 'ok' : (failed ? 'error' : 'none'), review };
    render();
  }

  /** What main has waiting, in either IPC shape: `{ sessionId, … }`. */
  async function readPending() {
    if (!window.apex || typeof window.apex.reviewPending !== 'function') return null;
    let p = null;
    try { p = await window.apex.reviewPending(); } catch { return null; }
    if (p && typeof p === 'object' && 'pending' in p) p = p.pending;
    if (!p || typeof p !== 'object') return null;
    const sessionId = p.sessionId || p.id || null;
    return sessionId ? { ...p, sessionId } : null;
  }

  async function ackPending(sessionId) {
    markTab(false);
    try { await window.apex.reviewPendingAck?.(sessionId); } catch { /* best effort */ }
  }

  /** Open a pending review's session with its debrief in view, then ack it. */
  async function openPending(p) {
    if (!p) return;
    pendingBanner = null;
    practiceFocus = true;
    await loadList(true);
    if (!summaries.some((row) => row.id === p.sessionId)) {
      // The lap list has not caught up with the session yet; once more.
      loadedOnce = false;
      await loadList(true);
    }
    await openSession(p.sessionId);
    void ackPending(p.sessionId);
  }

  /**
   * Arrival on the tab: a waiting review opens by itself, once. While the tab
   * is already open, a new one is only offered (a banner), never forced — the
   * driver may be in the middle of studying another lap.
   */
  async function checkPending(auto) {
    const p = await readPending();
    if (!p) {
      markTab(false);
      if (pendingBanner) { pendingBanner = null; renderBanner(); }
      return;
    }
    if (auto) {
      await openPending(p);
      return;
    }
    if (currentId === p.sessionId && !lapView) {
      practiceFocus = true;
      await openSession(p.sessionId);
      void ackPending(p.sessionId);
      return;
    }
    pendingBanner = p;
    renderBanner();
  }

  /**
   * The panel came back into view (launched, restored, alt-tabbed to). A
   * review waiting for the driver takes them to this tab — the "opens on it
   * the next time the app is looked at" of the plan. Only on a COMING back:
   * a review that lands while they are already looking is offered instead.
   */
  async function onPanelArrival() {
    if (visible) return;
    const p = await readPending();
    if (!p) return;
    window.apexNav?.showView('practice');
  }

  /** The grid's hover card: the native title is too slow and too plain. */
  function wireTips(root) {
    root.addEventListener('mouseover', (evt) => {
      const cell = evt.target.closest && evt.target.closest('.rv-pr-cell');
      const box = cell && cell.closest('.rv-pr__gridbox');
      const tip = box && box.querySelector('.rv-pr-tipbox');
      if (!tip) return;
      const lines = String(cell.dataset.tip || '').split('\n');
      tip.innerHTML = `<b>${esc(lines[0] || '')}</b>${lines.slice(1).map((l) => `<span>${esc(l)}</span>`).join('')}`;
      const b = box.getBoundingClientRect();
      const c = cell.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = `${Math.round(c.left - b.left + c.width / 2)}px`;
      tip.style.top = `${Math.round(c.top - b.top)}px`;
      tip.setAttribute('data-tone', cell.dataset.tone || 'none');
    });
    root.addEventListener('mouseout', (evt) => {
      const cell = evt.target.closest && evt.target.closest('.rv-pr-cell');
      if (!cell) return;
      const tip = cell.closest('.rv-pr__gridbox')?.querySelector('.rv-pr-tipbox');
      if (tip && !(evt.relatedTarget && evt.relatedTarget.closest && evt.relatedTarget.closest('.rv-pr-cell'))) {
        tip.hidden = true;
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Wiring                                                                */
  /* ---------------------------------------------------------------------- */

  function onDetailClick(evt) {
    const t = evt.target;
    if (!t.closest) return;
    if (t.closest('[data-prback]')) { closeLap(); return; }
    if (t.closest('[data-przoom="reset"]') && lapView) {
      lapView.corner = null;
      for (const tr of els.detail.querySelectorAll('tr[data-prcorner]')) tr.setAttribute('data-on', 'false');
      setWindow(0, 1);
      return;
    }
    if (t.closest('[data-propen]') && pendingBanner) { void openPending(pendingBanner); return; }
    if (t.closest('[data-prdismiss]') && pendingBanner) {
      const sid = pendingBanner.sessionId;
      pendingBanner = null;
      renderBanner();
      void ackPending(sid);
      return;
    }
    // A corner row in the lap view frames that corner.
    const cornerRow = lapView && t.closest('tr[data-prcorner]');
    if (cornerRow) { focusCorner(Number(cornerRow.dataset.prcorner)); return; }
    // A lap row, or a grid cell (which also says which corner to frame).
    const lapEl = t.closest('[data-prlap]');
    if (lapEl && !lapView) {
      const corner = lapEl.dataset.prcorner !== undefined ? Number(lapEl.dataset.prcorner) : null;
      void openLap(lapEl.dataset.prlap, corner);
    }
  }

  function onDetailKey(evt) {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const t = evt.target;
    if (!t.closest) return;
    const cornerRow = lapView && t.closest('tr[data-prcorner]');
    if (cornerRow) {
      evt.preventDefault();
      focusCorner(Number(cornerRow.dataset.prcorner));
      return;
    }
    const row = !lapView && t.closest('tr[data-prlap]');
    if (row) {
      evt.preventDefault();
      void openLap(row.dataset.prlap, null);
    }
  }

  function init() {
    if (ready) return;
    els.view = $('[data-view="practice"]');
    if (!els.view || !window.apex) return;
    els.list = $('#pr-sessions');
    els.detail = $('#pr-detail');
    els.search = $('#pr-search');
    els.refresh = $('#pr-refresh');
    els.tab = document.querySelector('.tab[data-tab="practice"]');

    if (els.search) els.search.addEventListener('input', renderList);
    if (els.refresh) els.refresh.addEventListener('click', () => { void loadList(true); });
    if (els.list) {
      els.list.addEventListener('click', (evt) => {
        const card = evt.target.closest && evt.target.closest('[data-prsession]');
        if (card && card.dataset.prsession !== currentId) void openSession(card.dataset.prsession);
        else if (card && lapView) closeLap();
      });
    }
    if (els.detail) {
      els.detail.addEventListener('click', onDetailClick);
      els.detail.addEventListener('keydown', onDetailKey);
      wireTips(els.detail);
    }

    const applyUnits = (settings) => {
      const next = settings && settings.speedUnit === 'mph' ? 'mph' : 'kph';
      if (next === speedUnit) return;
      speedUnit = next;
      if (visible) render();
    };
    window.apex.getState?.().then((state) => applyUnits(state && state.settings)).catch(() => { /* km/h stands */ });
    window.apex.onSettings?.(applyUnits);

    // A review finished: offered (banner + tab dot) if the driver is looking
    // at the panel, picked up on the way back in if they are not.
    if (typeof window.apex.onReviewPending === 'function') {
      window.apex.onReviewPending(() => {
        markTab(true);
        if (visible) void checkPending(false);
      });
    }
    // Coming back to the panel with a review waiting takes the driver to it.
    window.addEventListener('focus', () => { void onPanelArrival(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void onPanelArrival();
    });
    ready = true;

    if (els.view.getAttribute('data-active') === 'true') window.apexPractice.shown();
    else {
      // Launched on another tab with a review waiting: go to it. That is the
      // first time the app is looked at since the session ended.
      void readPending().then((p) => {
        if (!p) return;
        markTab(true);
        window.apexNav?.showView('practice');
      });
    }
  }

  window.apexPractice = {
    /** The router calls this on arrival. Every arrival re-reads the list. */
    shown() {
      init();
      if (!ready) return;
      visible = true;
      void Promise.resolve(loadList(true)).then(() => (visible ? checkPending(true) : null));
    },
    /** …and this on the way out. Nothing here runs while the tab is hidden. */
    hidden() {
      visible = false;
      if (lapOff) { lapOff(); lapOff = null; }
    },
  };

  // Last, so init()'s catch-up has window.apexPractice to call. The router's
  // first showView() runs before this file is parsed — see review-panel.js.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
