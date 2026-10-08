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
  /** The corner grid colours by time lost (`time`) or by accuracy (`acc`). */
  let gridMode = 'time';
  /**
   * Accuracy over time at this track in this class (`practice:trend`): `key`
   * is `trackKey|class`, `state` idle / loading / ok / none / unavailable.
   */
  let trend = { key: '', state: 'idle', sessions: [] };

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

  /* ---------------------------------------------------------------------- */
  /*  Accuracy (phase 3)                                                    */
  /* ---------------------------------------------------------------------- */

  /*
   * The score is the plan's AccuracyScore: integers 0..100, a total and four
   * parts, any part `null` when it could not be measured (Line without a
   * driven line on both laps, Braking in a flat corner). A null part is shown
   * as "—" and explained, never drawn as 0. Colours come from the band, in
   * practice-panel.css — no colour literals here (test-panel-parity).
   */
  const scoreOf = (s) => (s && known(s.total) ? s.total : null);
  function bandOf(v) {
    if (!known(v)) return 'none';
    if (v >= 85) return 'great';
    if (v >= 70) return 'good';
    if (v >= 55) return 'fair';
    return 'poor';
  }
  const BAND_WORD = { great: 'Great', good: 'Good', fair: 'Fair', poor: 'Work on it', none: 'Not scored' };
  const PARTS = [
    { key: 'braking', label: 'Braking', short: 'B', help: 'Brake point and release, against the lap you chased' },
    { key: 'throttle', label: 'Throttle', short: 'T', help: 'Throttle pick-up and time flat out' },
    { key: 'line', label: 'Line', short: 'L', help: 'Distance off the target’s line through the corner' },
    { key: 'speed', label: 'Speed', short: 'S', help: 'Minimum speed through the corner' },
  ];
  const LINE_NULL = 'Needs a lap recorded with the driven line';
  function partTitle(p, v) {
    if (known(v)) return `${p.label} ${Math.round(v)} — ${p.help}`;
    return p.key === 'line' ? `${p.label}: ${LINE_NULL}` : `${p.label}: not measurable here`;
  }
  const scoreText = (v) => (known(v) ? String(Math.round(v)) : dash);

  /** A score ring: the band's colour round the edge, the number inside. */
  function ringHtml(value, size, extra) {
    const stroke = size >= 72 ? 7 : size >= 44 ? 5 : 4;
    const r = (size - stroke) / 2;
    const len = 2 * Math.PI * r;
    const frac = known(value) ? Math.max(0, Math.min(1, value / 100)) : 0;
    const c = size / 2;
    return `
      <span class="pr-ring${extra ? ` ${extra}` : ''}" data-band="${bandOf(value)}" style="--size:${size}px">
        <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
          <circle class="pr-ring__track" cx="${c}" cy="${c}" r="${r.toFixed(2)}" stroke-width="${stroke}" />
          <circle class="pr-ring__arc" cx="${c}" cy="${c}" r="${r.toFixed(2)}" stroke-width="${stroke}"
                  stroke-dasharray="${(len * frac).toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 ${c} ${c})" />
        </svg>
        <b>${esc(scoreText(value))}</b>
      </span>`;
  }

  /** The four parts as labelled horizontal bars (the lap header's breakdown). */
  function partBarsHtml(score) {
    return `<div class="pr-parts">${PARTS.map((p) => {
      const v = score ? score[p.key] : null;
      return `
        <div class="pr-parts__row" data-band="${bandOf(v)}" title="${esc(partTitle(p, v))}">
          <span class="pr-parts__label">${esc(p.label)}</span>
          <span class="pr-parts__bar"><i style="width:${known(v) ? Math.max(2, Math.min(100, v)) : 0}%"></i></span>
          <b class="pr-parts__val">${esc(scoreText(v))}</b>
        </div>`;
    }).join('')}</div>`;
  }

  /** The four parts as four tiny vertical bars (corner table, compact). */
  function partMiniHtml(score) {
    return `<span class="pr-mini" aria-hidden="true">${PARTS.map((p) => {
      const v = score ? score[p.key] : null;
      return `<i data-band="${bandOf(v)}" title="${esc(partTitle(p, v))}"><s style="height:${known(v) ? Math.max(8, Math.min(100, v)) : 0}%"></s><em>${p.short}</em></i>`;
    }).join('')}</span>`;
  }

  /** "B 81 · T 77 · L — · S 88": the parts in one line of text. */
  const partsLine = (score) => PARTS.map((p) => `${p.short} ${scoreText(score ? score[p.key] : null)}`).join(' · ');

  /** A score as a number with a thin bar under it (the lap list). */
  function scoreCellHtml(v) {
    return `<span class="pr-scorecell" data-band="${bandOf(v)}">
      <b>${esc(scoreText(v))}</b><span class="pr-scorecell__bar"><i style="width:${known(v) ? Math.max(2, Math.min(100, v)) : 0}%"></i></span></span>`;
  }

  /** Each part averaged over the session's scored valid laps. */
  function avgParts(r) {
    const out = { total: null };
    const laps = (r.laps || []).filter((l) => l.valid && l.score);
    for (const p of PARTS.concat([{ key: 'total' }])) {
      const vals = laps.map((l) => l.score[p.key]).filter(known);
      out[p.key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return out;
  }

  /** "How is this scored?" — a popover in plain words, nothing external. */
  function howHtml() {
    return `
      <details class="pr-how">
        <summary><svg class="icon"><use href="#i-info" /></svg>How is this scored?</summary>
        <div class="pr-how__pop">
          <b>Accuracy, 0–100, corner by corner</b>
          <p>Every corner is compared with the same corner on the lap you chased, in four parts:</p>
          <ul>
            <li><span>Braking</span>where you start braking, and where you come off the brake</li>
            <li><span>Throttle</span>where you pick the throttle up, and how long you stay flat out</li>
            <li><span>Line</span>how far you are from the target's line through the corner</li>
            <li><span>Speed</span>your minimum speed against theirs</li>
          </ul>
          <p>A lap's score weighs each corner by the time spent in it, so a hairpin counts for more than a kink.
            The scoring is calibrated on real laps, so a higher score means a faster lap.
            A part that cannot be measured — Line on a lap recorded without the driven line — is left out, never counted as zero.</p>
        </div>
      </details>`;
  }

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
          ${known(c.avgScore) ? `<span class="pr-scorechip" data-band="${bandOf(c.avgScore)}"
            title="Average accuracy here: ${esc(scoreText(c.avgScore))} — ${esc(BAND_WORD[bandOf(c.avgScore)])}">${esc(scoreText(c.avgScore))}</span>` : ''}
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

  /** The lap number with the session's highest score, as main reports it (or worked out). */
  function topScoreLapNo(r) {
    if (r.score && known(r.score.bestLapNo)) return r.score.bestLapNo;
    let best = null;
    for (const lap of r.laps || []) {
      const v = scoreOf(lap.score);
      if (lap.valid && known(v) && (!best || v > scoreOf(best.score))) best = lap;
    }
    return best ? best.lapNo : null;
  }

  function practiceLapsHtml(r) {
    const n = (r.corners || []).length;
    const best = r.bestLapSec;
    const top = topScoreLapNo(r);
    const anyScore = (r.laps || []).some((l) => l.score);
    const rows = (r.laps || []).map((lap) => {
      const isBest = known(best) && lap.valid && Math.abs(lap.lapSec - best) < 0.0005;
      const isTop = known(top) && lap.lapNo === top;
      const studiable = lap.hasTrace;
      const v = scoreOf(lap.score);
      return `
        <tr data-prlap="${esc(lap.at)}" data-valid="${String(!!lap.valid)}" data-best="${String(isBest)}"
            data-trace="${String(!!studiable)}" ${studiable ? 'tabindex="0" role="button" title="Study this lap"' : 'title="No telemetry was kept for this lap"'}>
          <td class="rv-pr-laps__no">${esc(String(lap.lapNo))}</td>
          <td class="rv-pr-laps__time">${esc(lapFromSec(lap.lapSec))}</td>
          <td class="rv-pr-laps__delta" data-tone="${toneOfSec(lap.deltaSec)}">${esc(fmtSec(lap.deltaSec, 3))}</td>
          ${anyScore ? `<td class="rv-pr-laps__score" title="${esc(lap.score ? `Accuracy ${scoreText(v)} — ${partsLine(lap.score)}` : 'Not scored')}">
            ${scoreCellHtml(v)}${isTop ? '<span class="pr-top" title="The most accurate lap of the session">Top</span>' : ''}</td>` : ''}
          <td class="rv-pr-laps__strip">${studiable && n ? cornerStripHtml(lap, n) : '<span class="rv-pr-muted">no trace</span>'}</td>
          <td class="rv-pr-laps__flag">${lap.valid ? (isBest ? '<span class="rv-pr-tag rv-pr-tag--best">Best</span>' : '')
            : '<span class="rv-pr-tag">Invalid</span>'}</td>
        </tr>`;
    }).join('');
    return `
      <table class="rv-pr-laps">
        <thead><tr><th>Lap</th><th>Time</th><th>vs target</th>${anyScore ? '<th>Score</th>' : ''}<th>Corners${n ? ` · C1–C${n}` : ''}</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function practiceGridHtml(r) {
    const laps = r.laps || [];
    const corners = r.corners || [];
    if (!laps.length || !corners.length) return '';
    const head = laps.map((lap) =>
      `<span class="rv-pr-grid__lap" data-valid="${String(!!lap.valid)}">${esc(String(lap.lapNo))}</span>`).join('');
    const acc = gridMode === 'acc';
    const rows = corners.map((c) => {
      const cells = laps.map((lap) => {
        const hit = (lap.corners || []).find((x) => x.index === c.index);
        const d = hit ? hit.deltaSec : null;
        const s = hit ? scoreOf(hit.score) : null;
        const tip = [
          `${cornerLabel(c.index)} · lap ${lap.lapNo}`,
          acc ? (known(s) ? `Accuracy ${scoreText(s)} — ${BAND_WORD[bandOf(s)]}` : 'not scored') : (known(d) ? `${secSigned(d)} s` : 'not scored'),
          acc && hit && hit.score ? partsLine(hit.score) : '',
          !acc && hit ? brakeWords(hit.brakeDeltaM) : '',
          !acc && hit ? apexWords(hit.apexKphDelta) : '',
          acc && known(d) ? `${secSigned(d)} s against the target` : '',
        ].filter(Boolean).join('\n');
        // By accuracy the cell carries a band, not a tone: the time tones'
        // own background rules (level, none) must not repaint it.
        const look = acc
          ? `data-band="${bandOf(s)}" data-tiptone="${s === null ? 'none' : s >= 70 ? 'gain' : s >= 55 ? 'level' : 'loss'}"
             style="--a:${known(s) ? (0.45 + 0.55 * Math.min(1, Math.abs(s - 70) / 30)).toFixed(2) : '0'}"`
          : `data-tone="${toneOfSec(d)}" style="--a:${strengthOf(d).toFixed(2)}"`;
        return `<button type="button" class="rv-pr-cell" ${look} data-valid="${String(!!lap.valid)}"
                  data-prlap="${esc(lap.at)}" data-prcorner="${c.index}"
                  data-tip="${esc(tip)}" aria-label="${esc(tip.replace(/\n/g, ', '))}"></button>`;
      }).join('');
      const avg = acc
        ? `<span class="rv-pr-grid__avg pr-grid__avgscore" data-band="${bandOf(c.avgScore)}">${esc(scoreText(c.avgScore))}</span>`
        : `<span class="rv-pr-grid__avg" data-tone="${toneOfSec(c.avgLossSec)}">${esc(secSigned(c.avgLossSec))}</span>`;
      return `
        <span class="rv-pr-grid__name">${esc(cornerLabel(c.index))}</span>
        ${cells}
        ${avg}`;
    }).join('');
    return `
      <div class="rv-pr-grid" data-mode="${acc ? 'acc' : 'time'}" style="--cols:${laps.length}">
        <span class="rv-pr-grid__corner">Lap</span>${head}<span class="rv-pr-grid__avghead">Avg</span>
        ${rows}
      </div>`;
  }

  /** The debrief's Accuracy stat: the session average in a ring, the best lap's beside it. */
  function accuracyStatHtml(r, parts) {
    const avg = r.score && known(r.score.avg) ? r.score.avg : parts.total;
    const best = r.score && known(r.score.best) ? r.score.best : null;
    const bestNo = topScoreLapNo(r);
    const breakdown = PARTS.map((p) => `${p.label} ${scoreText(parts[p.key])}`).join(' · ');
    return `
      <div class="rv-pr-stat pr-accstat" title="${esc(`Session average, by part: ${breakdown}`)}">
        <div class="rv-pr-stat__label">Accuracy</div>
        <div class="pr-accstat__row">
          ${ringHtml(avg, 58)}
          <div class="pr-accstat__text">
            <span class="pr-accstat__word" data-band="${bandOf(avg)}">${esc(BAND_WORD[bandOf(avg)])}</span>
            <span class="pr-accstat__best">${known(best) ? `Best <b>${esc(scoreText(best))}</b>${known(bestNo) ? ` · lap ${esc(String(bestNo))}` : ''}` : 'session average'}</span>
          </div>
        </div>
        <div class="pr-accstat__parts">${PARTS.map((p) =>
          `<span data-band="${bandOf(parts[p.key])}" title="${esc(partTitle(p, parts[p.key]))}"><em>${p.short}</em>${esc(scoreText(parts[p.key]))}</span>`).join('')}</div>
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
    const hasScore = (r.laps || []).some((l) => l.score);
    const parts = hasScore ? avgParts(r) : null;

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
          ${hasScore ? howHtml() : ''}
        </div>

        <div class="rv-pr__stats${hasScore ? ' rv-pr__stats--acc' : ''}">
          ${hasScore ? accuracyStatHtml(r, parts) : ''}
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
        <section class="rv-pr__gridbox">${gridBoxInnerHtml(r)}</section>` : ''}

        ${trendHtml(r)}
      </div>`;
  }

  /** The corner grid's head, legend, toggle and cells — re-rendered alone on a toggle. */
  function gridBoxInnerHtml(r) {
    const anyScore = (r.laps || []).some((l) => l.score);
    if (gridMode === 'acc' && !anyScore) gridMode = 'time';
    const acc = gridMode === 'acc';
    const legend = acc
      ? `<span><i data-band="great"></i>85+</span><span><i data-band="good"></i>70–84</span>
         <span><i data-band="fair"></i>55–69</span><span><i data-band="poor"></i>Under 55</span>`
      : `<span><i data-tone="gain"></i>Faster than the target</span><span><i data-tone="loss"></i>Slower</span>`;
    return `
      <div class="rv-pr__gridhead">
        <span class="rv-pr__title">Corner by corner</span>
        ${anyScore ? `
        <span class="pr-seg" role="group" aria-label="Colour the grid by">
          <button type="button" data-prgridmode="time" aria-pressed="${String(!acc)}">Time</button>
          <button type="button" data-prgridmode="acc" aria-pressed="${String(acc)}">Accuracy</button>
        </span>` : ''}
        <span class="rv-pr__legend">
          ${legend}
          <span class="rv-pr-muted">Click a cell to study that corner on that lap</span>
        </span>
      </div>
      ${practiceGridHtml(r)}
      <div class="rv-pr-tipbox" hidden></div>`;
  }

  /* ---- accuracy over time ---------------------------------------------- */

  /** The open session's track key, for the trend: the session, else its list row. */
  function trackKeyOfOpen() {
    if (session && session.trackKey) return session.trackKey;
    const row = summaries.find((s) => s.id === currentId);
    return (row && row.trackKey) || '';
  }

  async function loadTrend(r) {
    const trackKey = trackKeyOfOpen();
    const carClass = (r && r.carClass) || (session && session.carClass) || '';
    const key = `${trackKey}|${carClass}`;
    if (!trackKey) { trend = { key, state: 'none', sessions: [] }; return; }
    if (trend.key === key && (trend.state === 'ok' || trend.state === 'loading')) return;
    if (!window.apex || typeof window.apex.practiceTrend !== 'function') {
      trend = { key, state: 'unavailable', sessions: [] };
      return;
    }
    trend = { key, state: 'loading', sessions: [] };
    let res = null;
    try { res = await window.apex.practiceTrend({ trackKey, carClass }); } catch { res = null; }
    if (trend.key !== key) return;
    const sessions = res && Array.isArray(res.sessions) ? res.sessions.slice() : [];
    sessions.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    trend = { key, state: sessions.length ? 'ok' : 'none', sessions };
    if (!lapView && practice.state === 'ok') {
      const slot = els.detail && els.detail.querySelector('.pr-trendslot');
      if (slot) slot.outerHTML = trendHtml(practice.review);
      else render();
    }
  }

  /** "6 Sep" for the trend's axis. */
  function shortDay(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  /** The "Accuracy over time" card: average and best per session, here, in this class. */
  function trendHtml(r) {
    const anyScore = r && (r.laps || []).some((l) => l.score);
    if (!anyScore) return '<div class="pr-trendslot"></div>';
    const head = (note) => `
      <div class="rv-pr__gridhead">
        <span class="rv-pr__title">Accuracy over time <span class="rv-pr-muted">· ${esc(r.track || 'this track')}${r.carClass ? ` · ${esc(r.carClass)}` : ''}</span></span>
        <span class="rv-pr__legend">${note || ''}</span>
      </div>`;
    if (trend.state === 'loading' || trend.state === 'idle') {
      return `<section class="pr-trendslot pr-trend">${head()}<p class="rv-pr__note">Reading your sessions here…</p></section>`;
    }
    if (trend.state === 'unavailable') {
      return `<section class="pr-trendslot pr-trend">${head()}<p class="rv-pr__note">This version of the app cannot chart accuracy over time yet.</p></section>`;
    }
    const pts = trend.sessions.filter((s) => known(s.avgScore) || known(s.bestScore));
    if (pts.length < 2) {
      return `<section class="pr-trendslot pr-trend">${head()}
        <p class="rv-pr__note">Your first scored session here — the trend starts with your next one.</p></section>`;
    }

    const W = 760;
    const H = 196;
    const L = 34;
    const R = 14;
    const T = 14;
    const B = 46;
    const vals = pts.flatMap((s) => [s.avgScore, s.bestScore]).filter(known);
    const lo = Math.max(0, Math.floor((Math.min(...vals) - 8) / 10) * 10);
    const hi = 100;
    const x = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1));
    const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
    const grid = [];
    for (let g = lo; g <= hi; g += 10) {
      grid.push(`<line class="pr-trend__grid" x1="${L}" x2="${W - R}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}" />
        <text class="pr-trend__axis" x="${L - 8}" y="${(y(g) + 4).toFixed(1)}" text-anchor="end">${g}</text>`);
    }
    const path = (key) => pts.map((s, i) => (known(s[key]) ? `${x(i).toFixed(1)},${y(s[key]).toFixed(1)}` : null)).filter(Boolean);
    const avgLine = path('avgScore');
    const bestLine = path('bestScore');
    const area = avgLine.length > 1
      ? `<polygon class="pr-trend__area" points="${x(0).toFixed(1)},${(H - B).toFixed(1)} ${avgLine.join(' ')} ${x(pts.length - 1).toFixed(1)},${(H - B).toFixed(1)}" />`
      : '';
    const openable = new Set(summaries.map((s) => s.id));
    const marks = pts.map((s, i) => {
      const cur = s.sessionId === currentId;
      const cx = x(i).toFixed(1);
      const title = [
        `${shortDay(s.at)} · ${known(s.laps) ? `${s.laps} laps` : ''}`,
        `Average ${scoreText(s.avgScore)} · best ${scoreText(s.bestScore)}`,
        known(s.bestLapSec) ? `Best lap ${lapFromSec(s.bestLapSec)}` : '',
        cur ? 'This session' : openable.has(s.sessionId) ? 'Click to open' : '',
      ].filter(Boolean).join('\n');
      const hit = openable.has(s.sessionId) && !cur;
      const colW = pts.length > 1 ? (W - L - R) / (pts.length - 1) : W;
      return `
        <g class="pr-trend__pt${cur ? ' pr-trend__pt--cur' : ''}"${hit ? ` data-prtrend="${esc(s.sessionId)}" role="button" tabindex="0"` : ''}>
          <title>${esc(title)}</title>
          <rect class="pr-trend__hit" x="${(x(i) - colW / 2).toFixed(1)}" y="${T - 6}" width="${colW.toFixed(1)}" height="${H - T}" rx="6" />
          ${cur ? `<line class="pr-trend__curline" x1="${cx}" x2="${cx}" y1="${T - 4}" y2="${H - B}" />` : ''}
          ${known(s.bestScore) ? `<circle class="pr-trend__best" cx="${cx}" cy="${y(s.bestScore).toFixed(1)}" r="${cur ? 5 : 3.5}" />` : ''}
          ${known(s.avgScore) ? `<circle class="pr-trend__avg" cx="${cx}" cy="${y(s.avgScore).toFixed(1)}" r="${cur ? 6.5 : 4.5}" />` : ''}
          ${known(s.avgScore) && cur ? `<text class="pr-trend__curval" x="${cx}" y="${(y(s.avgScore) - 12).toFixed(1)}" text-anchor="middle">${esc(scoreText(s.avgScore))}</text>` : ''}
          <text class="pr-trend__day" x="${cx}" y="${H - B + 17}" text-anchor="middle">${esc(shortDay(s.at))}</text>
          <text class="pr-trend__lap" x="${cx}" y="${H - B + 32}" text-anchor="middle">${esc(known(s.bestLapSec) ? lapFromSec(s.bestLapSec) : '')}</text>
        </g>`;
    }).join('');
    const first = pts.find((s) => known(s.avgScore));
    const here = pts.find((s) => s.sessionId === currentId) || pts[pts.length - 1];
    const moved = first && here && known(here.avgScore) && first !== here ? here.avgScore - first.avgScore : null;
    const note = `
      <span><i class="pr-trend__key pr-trend__key--avg"></i>Session average</span>
      <span><i class="pr-trend__key pr-trend__key--best"></i>Best lap's score</span>
      ${known(moved) ? `<span class="pr-trend__moved" data-band="${moved >= 0 ? 'great' : 'poor'}">${moved >= 0 ? '+' : '−'}${Math.round(Math.abs(moved))} since your first session here</span>` : ''}`;
    return `
      <section class="pr-trendslot pr-trend">
        ${head(note)}
        <svg class="pr-trend__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"
             aria-label="Accuracy over your sessions here">
          ${grid.join('')}
          ${area}
          ${bestLine.length > 1 ? `<polyline class="pr-trend__bestline" points="${bestLine.join(' ')}" />` : ''}
          ${avgLine.length > 1 ? `<polyline class="pr-trend__avgline" points="${avgLine.join(' ')}" />` : ''}
          ${marks}
        </svg>
      </section>`;
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
    const scoredRows = rows.some((c) => c.score);
    const scoreTds = (c) => {
      if (!scoredRows) return '';
      const v = scoreOf(c.score);
      const pts = known(c.pointsToGain) ? c.pointsToGain : null;
      return `
          <td class="pr-ct__score" title="${esc(c.score ? `Accuracy ${scoreText(v)} — ${partsLine(c.score)}` : 'Not scored')}">
            <span class="pr-ct__scorewrap"><b data-band="${bandOf(v)}">${esc(scoreText(v))}</b>${partMiniHtml(c.score)}</span></td>
          <td class="pr-ct__gain" data-big="${String(known(pts) && pts >= 1)}">${known(pts) && pts >= 0.5 ? `+${esc(fix(pts, 1))}` : dash}</td>`;
    };
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
          ${scoreTds(c)}
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
          ${scoredRows ? `<th title="Accuracy here: Braking, Throttle, Line, Speed">Score</th>
          <th title="How far the lap's score would rise if this corner scored 100">Gain</th>` : ''}
          <th>What to try</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  /** The lap's accuracy: a ring with the total, the four parts as bars. */
  function lapScoreHtml(res) {
    if (!res || !res.score) return '';
    const s = res.score;
    const weakest = PARTS.filter((p) => known(s[p.key])).sort((a, b) => s[a.key] - s[b.key])[0];
    return `
      <div class="rv-card pr-score">
        <div class="pr-score__ring">
          ${ringHtml(s.total, 92, 'pr-ring--big')}
          <div class="pr-score__words">
            <span class="rv-pr-stat__label">Accuracy</span>
            <span class="pr-score__band" data-band="${bandOf(s.total)}">${esc(BAND_WORD[bandOf(s.total)])}</span>
            ${weakest ? `<span class="pr-score__hint">Most to find in <b>${esc(weakest.label.toLowerCase())}</b></span>` : ''}
          </div>
        </div>
        ${partBarsHtml(s)}
        <div class="pr-score__how">${howHtml()}</div>
      </div>`;
  }

  /** The three corners whose perfect score would lift the lap most. */
  function gainsHtml(res) {
    const rows = ((res && res.corners) || [])
      .filter((c) => known(c.pointsToGain) && c.pointsToGain >= 0.5)
      .sort((a, b) => b.pointsToGain - a.pointsToGain)
      .slice(0, 3);
    if (!rows.length) return '';
    const worstPart = (sc) => {
      if (!sc) return null;
      const p = PARTS.filter((x) => known(sc[x.key])).sort((a, b) => sc[a.key] - sc[b.key])[0];
      return p ? p.label.toLowerCase() : null;
    };
    return `
      <div class="pr-gains">
        <span class="pr-gains__title"><svg class="icon"><use href="#i-trending-up" /></svg>Biggest gains</span>
        ${rows.map((c, i) => `
          <button type="button" class="pr-gain" data-prgain="${c.index}" title="Frame ${esc(cornerLabel(c.index))} on the map and the charts">
            <span class="pr-gain__rank">${i + 1}</span>
            <span class="pr-gain__name">${esc(cornerLabel(c.index))}</span>
            <span class="pr-gain__pts">+${esc(fix(c.pointsToGain, 1))}<small> pts</small></span>
            <span class="pr-gain__why">${worstPart(c.score) ? `mostly ${esc(worstPart(c.score))}` : ''}</span>
          </button>`).join('')}
      </div>`;
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

        ${lapScoreHtml(res)}

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
          ${gainsHtml(res)}
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
    if (review && (review.laps || []).some((l) => l.score)) void loadTrend(review);
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
      tip.setAttribute('data-tone', cell.dataset.tiptone || cell.dataset.tone || 'none');
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
    // The grid's Time | Accuracy toggle: only the grid redraws.
    const modeBtn = t.closest('[data-prgridmode]');
    if (modeBtn) {
      const next = modeBtn.dataset.prgridmode === 'acc' ? 'acc' : 'time';
      if (next !== gridMode && practice.review) {
        gridMode = next;
        const box = els.detail.querySelector('.rv-pr__gridbox');
        if (box) box.innerHTML = gridBoxInnerHtml(practice.review);
      }
      return;
    }
    // A "Biggest gains" chip frames its corner, as its table row does.
    const gain = lapView && t.closest('[data-prgain]');
    if (gain) { focusCorner(Number(gain.dataset.prgain)); return; }
    // A point on the accuracy trend opens that session.
    const tp = !lapView && t.closest('[data-prtrend]');
    if (tp) { void openSession(tp.dataset.prtrend); return; }
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
      return;
    }
    const tp = !lapView && t.closest('[data-prtrend]');
    if (tp) {
      evt.preventDefault();
      void openSession(tp.dataset.prtrend);
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
    if (els.refresh) {
      els.refresh.addEventListener('click', () => {
        trend = { key: '', state: 'idle', sessions: [] };
        void loadList(true);
      });
    }
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
