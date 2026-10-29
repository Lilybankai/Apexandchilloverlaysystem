/**
 * practice-panel.js — the Practice tab: the review a practice session gets.
 * -----------------------------------------------------------------------------
 * docs/PRACTICE-REVIEW-PLAN.md. Its own tab since 2026-10-08 (Carl: "make
 * sure the practice review is in a different place to the review screen") —
 * the Review tab stays the general stint reviewer it was.
 *
 * Re-envisaged 2026-10-29 to Carl's mockup ("Apex AIO Le Mans Telemetry
 * Dashboard.png"): the old tab "looks a little bit cluttered and a little bit
 * complicated". One page, top to bottom:
 *
 *   1. a header row — the session pickers (sim, session, track, class), what
 *      the session is measured against, and the session's facts;
 *   2. five KPI cards with sparklines — best lap, theoretical best, accuracy,
 *      consistency, gap to the leaderboard;
 *   3. the AI COACH panel — three takeaways, the template words at once and
 *      the AI's words swapped in when they arrive (`apex.practiceCoach`, then
 *      `apex.practiceCoachAi`);
 *   4. WHERE TIME IS LOST and LAP TIMES side by side;
 *   5. CORNER BY CORNER (a heatmap) and LAP PACE & ACCURACY side by side;
 *   6. "Your driving" — the habits view, mounted from practice-habits.js.
 *
 * And the deep dive: one lap against the same target, drawn with the Review
 * tab's own painters (review-charts.js: the channel chart and the circuit
 * plan, one shared [from, to] window), with the coach's words for that lap
 * and a "Show me" walk through its costliest corners.
 *
 * Everything the coach pieces add (practiceCoach*, practiceTargets,
 * window.ShowMe, window.PracticeHabits) is feature-detected: a build without
 * them shows today's review and quietly leaves their parts out.
 *
 * Corners are C1..Cn — the catalogue's ids when a review carries them, else
 * the reference lap's own order — and are never given circuit names.
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
 *
 * No colour literals in this file: test-panel-parity reads them as ids.
 * Colours live in practice-panel.css, picked by data-tone / data-band.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const CHARTS = window.APEX_REVIEW_CHARTS;
  const dash = '—';

  /* ---------------------------------------------------------------------- */
  /*  State                                                                 */
  /* ---------------------------------------------------------------------- */

  const els = {
    view: null, detail: null, refresh: null, tab: null,
    session: null, track: null, cls: null, target: null, meta: null,
    habitsBox: null, habitsToggle: null, habits: null,
  };
  let ready = false;
  let visible = false;
  let speedUnit = 'kph';
  let tempUnit = 'c';

  /** Practice and test-day sessions, newest first, as `review:sessions` lists them. */
  let summaries = [];
  let loadedOnce = false;
  let listRead = null;
  let currentId = null;
  /** The open session as `review:session` returns it — its laps' ids, weather. */
  let session = null;
  /**
   * The debrief: `state` is `idle`, `loading`, `ok`, `none` (no review was made
   * for this session), `error` or `unavailable` (an older main with no IPC).
   */
  let practice = { id: null, state: 'idle', review: null };
  /** The target the session was measured against by default (chased or session best). */
  let baseTarget = null;
  /** The target picker: '' = the default, 'sessionBest', or a leaderboard lap id. */
  let targetSel = '';
  /** A re-measure against another target is in flight. */
  let targetBusy = false;
  /** A word under the picker when a target could not be used. */
  let targetNote = '';
  let targetOpen = false;
  /** `apex.practiceTargets`: leaderboard laps worth chasing, and the gap to the top. */
  let targets = { id: null, state: 'idle', data: null };
  /**
   * The session coach (`apex.practiceCoach` → `practiceCoachAi`): `key` is
   * `sessionId|target`, `state` idle / loading / ok / none / unavailable,
   * `refining` while the AI's words are on their way.
   */
  let coach = { key: '', state: 'idle', report: null, refining: false };
  /**
   * Accuracy over time at this track in this class (`practice:trend`): `key`
   * is `trackKey|class`, `state` idle / loading / ok / none / unavailable.
   */
  let trend = { key: '', state: 'idle', sessions: [] };
  /** A review main says is waiting, offered as a banner while the tab is open. */
  let pendingBanner = null;
  /** Scroll the debrief into view once it paints (it was opened for the driver). */
  let practiceFocus = false;
  /** The lap being studied, or null on the overview. */
  let lapView = null;
  /** Listener teardown for the lap view's canvases. */
  let lapOff = null;
  /** The circuit last sent by main, kept so the next lap need not resend it. */
  let heldMap = null;
  let heldMapKey = '';
  /** The lap table: every lap, or the valid ones only. */
  let lapFilter = 'all';
  /** The heatmap's measure: time / speed / brake / entry. */
  let heatTab = 'time';
  /** The pace chart's measure: time / acc / cons. */
  let paceTab = 'time';
  /** "Your driving": open, and which track|class it last rendered. */
  let habitsOpen = false;
  let habitsKey = '';
  /** The pace chart is drawn at its card's real width, so its type stays legible. */
  let paceW = 600;

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

  const clockLabel = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  function dayLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Unknown date';
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** "Thu, 15 Oct 2026" — the header's date. */
  function longDay(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  const toMph = (kph) => kph * 0.621371;
  const speedOf = (kph) => (known(kph) ? `${Math.round(speedUnit === 'mph' ? toMph(kph) : kph)}` : dash);
  const speedUnitLabel = () => (speedUnit === 'mph' ? 'mph' : 'km/h');
  // Main and the coach word speeds in km/h; restate them in the panel's unit.
  const tipText = (tip) =>
    speedUnit === 'mph'
      ? String(tip || '').replace(/(\d+(?:\.\d+)?) ?km\/h/g, (_m, n) => `${Math.round(toMph(Number(n)))} mph`)
      : String(tip || '');
  const tempOf = (c) => (known(c) ? (tempUnit === 'f' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`) : '');

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
  /** A corner's id: the catalogue's when the review carries one, else C(index+1). */
  const cornerIdOf = (c) => (c && typeof c.id === 'string' && c.id ? c.id : cornerLabel(c.index));

  const PHASE_WORDS = {
    braking: 'Braking', turnIn: 'Turn-in', midCorner: 'Mid-corner', exit: 'Exit', exitRun: 'Exit run',
  };

  /* ---------------------------------------------------------------------- */
  /*  Accuracy                                                              */
  /* ---------------------------------------------------------------------- */

  /*
   * The score is the plan's AccuracyScore: integers 0..100, a total and four
   * parts, any part `null` when it could not be measured (Line without a
   * driven line on both laps, Braking in a flat corner). A null part is shown
   * as "—" and explained, never drawn as 0.
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
    { key: 'braking', label: 'Braking', short: 'B', help: 'Brake point and release, against the target' },
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

  /** The four parts as four tiny vertical bars (corner table, compact). */
  function partMiniHtml(score) {
    return `<span class="pr-mini" aria-hidden="true">${PARTS.map((p) => {
      const v = score ? score[p.key] : null;
      return `<i data-band="${bandOf(v)}" title="${esc(partTitle(p, v))}"><s style="height:${known(v) ? Math.max(8, Math.min(100, v)) : 0}%"></s><em>${p.short}</em></i>`;
    }).join('')}</span>`;
  }

  /** "B 81 · T 77 · L — · S 88": the parts in one line of text. */
  const partsLine = (score) => PARTS.map((p) => `${p.short} ${scoreText(score ? score[p.key] : null)}`).join(' · ');

  /** "How is the score worked out?" — a small popover in plain words, nothing external. */
  function howHtml(extra) {
    return `
      <details class="pr-how${extra ? ` ${extra}` : ''}">
        <summary aria-label="How the accuracy score works" title="How the accuracy score works"><svg class="icon"><use href="#i-info" /></svg><span>How it works</span></summary>
        <div class="pr-how__pop">
          <b>Accuracy, 0–100, corner by corner</b>
          <p>Every corner is compared with the same corner on the lap you are measured against, in four parts:</p>
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
  /** "vs your best" / "vs target" under a loss figure. */
  const vsWords = (t) => (t && t.kind === 'sessionBest' ? 'vs your best' : `vs ${targetName(t) || 'target'}`);

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

  /** What to try next time, from a corner's averages (the no-coach fallback). */
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

  /* ---- the coach's numbers --------------------------------------------- */

  /** One fact's number in words, in the panel's units. */
  function factValue(f) {
    if (!f || !known(f.value)) return dash;
    const v = f.value;
    switch (f.unit) {
      case 's': return `${Math.abs(v).toFixed(2)} s`;
      case 'm': return `${Math.round(Math.abs(v))} m`;
      case 'kph': return `${Math.round(Math.abs(speedUnit === 'mph' ? toMph(v) : v))} ${speedUnitLabel()}`;
      case '%': return `${Math.round(v)}%`;
      case 'C': return tempOf(v);
      case 'L': return `${v.toFixed(1)} L`;
      case 'pts': return `${Math.round(v)} pts`;
      case 'laps': return `${Math.round(v)} lap${Math.round(v) === 1 ? '' : 's'}`;
      default: return String(v);
    }
  }

  /**
   * The AI cites facts by id and never types a number itself; a `{factId}` or
   * `{{factId}}` in its words is filled from the cited fact here. An unknown
   * id is left as written, so a template sentence with real braces survives.
   */
  function fillFacts(text, facts) {
    const s = tipText(text);
    if (!Array.isArray(facts) || !facts.length || s.indexOf('{') < 0) return s;
    const byId = new Map(facts.map((f) => [String(f.id), f]));
    return s.replace(/\{\{?\s*([\w.:-]+)\s*\}?\}/g, (m, id) => (byId.has(id) ? factValue(byId.get(id)) : m));
  }

  /** Fairness flags as small chips: info grey, warn amber, drop red. */
  function flagChipsHtml(flags, max) {
    const list = (Array.isArray(flags) ? flags : []).filter((f) => f && f.text);
    if (!list.length) return '';
    return list.slice(0, max || 6).map((f) => `
      <span class="prx-flag" data-sev="${esc(f.severity || 'info')}"
            title="${esc(f.text)}${known(f.estSec) ? ` (≈${esc(f.estSec.toFixed(2))} s)` : ''}">${esc(f.text)}</span>`).join('');
  }

  /* ---------------------------------------------------------------------- */
  /*  Little charts                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * A KPI card's sparkline: a polyline over the known values in order, the
   * last point a dot. `invert` puts lower values higher (lap times).
   */
  function sparkHtml(vals, invert) {
    const pts = [];
    vals.forEach((v, i) => { if (known(v)) pts.push([i, v]); });
    if (pts.length < 2) return '';
    const W = 92;
    const H = 34;
    const P = 4;
    const lo = Math.min(...pts.map((p) => p[1]));
    const hi = Math.max(...pts.map((p) => p[1]));
    const span = hi - lo || 1;
    const n = vals.length - 1 || 1;
    const xy = pts.map(([i, v]) => {
      const f = (v - lo) / span;
      return [P + (i / n) * (W - 2 * P), invert ? P + f * (H - 2 * P) : H - P - f * (H - 2 * P)];
    });
    const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const dots = xy.map(([x, y], k) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${k === xy.length - 1 ? 2.6 : 1.5}" />`).join('');
    return `<svg class="prx-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${line}" />${dots}</svg>`;
  }

  /** Lap times in lap order (null for untimed laps), for the sparklines. */
  const lapTimes = (r, validOnly) => (r.laps || []).map((l) => (known(l.lapSec) && l.lapSec > 0 && (!validOnly || l.valid) ? l.lapSec : null));

  function median(xs) {
    const s = xs.filter(known).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* ---------------------------------------------------------------------- */
  /*  The overview's pieces                                                 */
  /* ---------------------------------------------------------------------- */

  /** The session's best valid lap row. */
  function bestLapOf(r) {
    if (!known(r.bestLapSec)) return null;
    return (r.laps || []).find((l) => l.valid && Math.abs(l.lapSec - r.bestLapSec) < 0.0005) || null;
  }

  /** The three corners that cost the most on average, worst first (no coach). */
  function worstCorners(r) {
    return (r.corners || [])
      .filter((c) => known(c.avgLossSec) && c.avgLossSec > 0.005)
      .sort((a, b) => b.avgLossSec - a.avgLossSec)
      .slice(0, 3);
  }

  /** A corner's delta on every lap, lap order. */
  function cornerSeries(r, index) {
    return (r.laps || []).map((lap) => {
      const c = (lap.corners || []).find((x) => x.index === index);
      return c && known(c.deltaSec) ? c.deltaSec : null;
    });
  }

  const cornerByIdIn = (r, id) => (r.corners || []).find((c) => cornerIdOf(c) === id) || null;

  /**
   * "Where time is lost": the coach's three corners when it has spoken, else
   * the review's own worst three with words made here. One shape for both.
   */
  function lossItems(r) {
    const rep = coach.state === 'ok' ? coach.report : null;
    if (rep && Array.isArray(rep.worst) && rep.worst.length) {
      return rep.worst.slice(0, 3).map((w) => {
        const c = cornerByIdIn(r, w.id);
        return {
          id: w.id,
          index: c ? c.index : null,
          lossSec: w.lossSec,
          priority: w.priority || 'medium',
          phase: w.phase,
          tip: fillFacts(w.tip, rep.facts),
          confidence: w.confidence,
          perLap: Array.isArray(w.perLapSec) ? w.perLapSec : (c ? cornerSeries(r, c.index) : []),
        };
      });
    }
    return worstCorners(r).map((c, i) => {
      const series = cornerSeries(r, c.index);
      const scored = series.filter(known);
      const losing = scored.filter((d) => d > 0.02).length;
      const phase = known(c.avgBrakeDeltaM) && Math.abs(c.avgBrakeDeltaM) >= 3 ? 'braking'
        : known(c.avgApexKphDelta) && c.avgApexKphDelta <= -1 ? 'midCorner' : 'exit';
      return {
        id: cornerIdOf(c),
        index: c.index,
        lossSec: c.avgLossSec,
        priority: c.avgLossSec >= 0.15 || (i === 0 && c.avgLossSec >= 0.08) ? 'high' : c.avgLossSec >= 0.05 ? 'medium' : 'low',
        phase,
        tip: tipWords(c),
        confidence: scored.length ? losing / scored.length : null,
        perLap: series,
      };
    });
  }

  /**
   * The lap a "Show me" opens on for a corner: a valid studied lap whose loss
   * there is closest to the corner's usual loss — the typical mistake, not the
   * one-off — and never the reference lap itself.
   */
  function representativeLap(r, index, lossSec) {
    const t = r.target;
    const isRef = (l) => t && t.kind === 'sessionBest' && known(t.lapSec) && Math.abs(l.lapSec - t.lapSec) < 0.0005;
    let best = null;
    let bestErr = Infinity;
    for (const lap of r.laps || []) {
      if (!lap.hasTrace || isRef(lap)) continue;
      const c = (lap.corners || []).find((x) => x.index === index);
      if (!c || !known(c.deltaSec) || c.deltaSec <= 0) continue;
      const err = Math.abs(c.deltaSec - (known(lossSec) ? lossSec : 0.1)) + (lap.valid ? 0 : 0.05);
      if (err < bestErr) { bestErr = err; best = lap; }
    }
    return best || bestLapOf(r);
  }

  /* ---- KPI cards ------------------------------------------------------ */

  function kpiHtml(o) {
    return `
      <div class="prx-kpi" data-kpi="${o.key}"${o.title ? ` title="${esc(o.title)}"` : ''}>
        <span class="prx-kpi__icon">${o.icon}</span>
        <div class="prx-kpi__body">
          <span class="prx-kpi__label">${esc(o.label)}${o.after || ''}</span>
          <span class="prx-kpi__value"${o.tone ? ` data-tone="${o.tone}"` : ''}>${o.value}</span>
          ${o.sub ? `<span class="prx-kpi__sub">${o.sub}</span>` : ''}
          ${o.chips ? `<span class="prx-kpi__chips">${o.chips}</span>` : ''}
        </div>
        ${o.spark || ''}
      </div>`;
  }

  /** The session's accuracy against the last scored session here, from the trend. */
  function accuracyMove(r) {
    if (trend.state !== 'ok' || !r.score || !known(r.score.avg)) return null;
    const list = trend.sessions.filter((s) => known(s.avgScore));
    const at = list.findIndex((s) => s.sessionId === currentId);
    const prev = at > 0 ? list[at - 1] : at < 0 && list.length ? list[list.length - 1] : null;
    return prev ? r.score.avg - prev.avgScore : null;
  }

  function kpisHtml(r) {
    const best = bestLapOf(r);
    const theoGap = known(r.bestLapSec) && known(r.theoreticalBestSec) ? r.theoreticalBestSec - r.bestLapSec : null;
    const hasScore = (r.laps || []).some((l) => l.score);
    const out = [];

    // Best lap: every valid lap's time, the best the lowest point lifted highest.
    out.push(kpiHtml({
      key: 'best',
      icon: '<svg class="icon"><use href="#i-trophy" /></svg>',
      label: 'Best lap',
      value: esc(lapFromSec(r.bestLapSec)),
      sub: best ? `<span class="prx-nowrap">Lap ${esc(String(best.lapNo))} <i>•</i> Clean lap</span>` : 'No clean lap',
      spark: sparkHtml(lapTimes(r, true), true),
      title: 'Your best valid lap of the session; the line is every valid lap, faster higher',
    }));

    // Theoretical best: the running best lap, to show it closing on the theory.
    let run = null;
    const running = lapTimes(r, true).map((v) => { if (known(v)) run = run === null ? v : Math.min(run, v); return run; });
    out.push(kpiHtml({
      key: 'theo',
      icon: '<svg class="icon"><use href="#i-timer" /></svg>',
      label: 'Theoretical best',
      value: esc(lapFromSec(r.theoreticalBestSec)),
      sub: known(theoGap) ? `<b data-tone="gain">${esc(fmtSec(theoGap, 3))}s</b> potential` : 'your best corners, joined',
      spark: sparkHtml(running, true),
      title: 'Your best corners from across the session, joined into one lap',
    }));

    // Accuracy: the session average, its band, the move since last time.
    if (hasScore) {
      const avg = r.score && known(r.score.avg) ? r.score.avg : null;
      const move = accuracyMove(r);
      const series = trend.state === 'ok' ? trend.sessions.map((s) => s.avgScore) : (r.laps || []).map((l) => scoreOf(l.score));
      out.push(kpiHtml({
        key: 'acc',
        icon: '<svg class="icon"><use href="#i-target" /></svg>',
        label: 'Accuracy',
        after: howHtml('prx-how--kpi'),
        value: `${esc(scoreText(avg))}<small> / 100</small>`,
        sub: `<b class="prx-kpi__band" data-band="${bandOf(avg)}">${esc(BAND_WORD[bandOf(avg)])}</b>${
          known(move) && Math.round(move) !== 0
            ? `<span class="prx-kpi__move" data-tone="${move > 0 ? 'gain' : 'loss'}">${move > 0 ? '+' : '−'}${Math.round(Math.abs(move))} vs last session</span>`
            : ''}`,
        spark: sparkHtml(series, false),
        title: trend.state === 'ok' ? 'Session average accuracy; the line is your sessions here, oldest first' : 'Session average accuracy; the line is every scored lap',
      }));
    }

    // Consistency: each valid lap's distance from the session's median lap.
    const valid = lapTimes(r, true);
    const med = median(valid);
    out.push(kpiHtml({
      key: 'cons',
      icon: '<svg class="icon"><use href="#i-activity" /></svg>',
      label: 'Consistency',
      value: known(r.consistencySec) ? `±${esc(fix(r.consistencySec, 2))}s` : dash,
      sub: 'Lap time variation',
      spark: known(med) ? sparkHtml(valid.map((v) => (known(v) ? Math.abs(v - med) : null)), true) : '',
      title: 'Spread of your valid laps; the line is each lap’s distance from your median lap, steadier higher',
    }));

    // Gap to the leaderboard: only when the fair-target piece can say.
    const lg = targets.id === currentId && targets.data && targets.data.leaderGap;
    if (lg && known(lg.sec)) {
      const leaderSec = known(r.bestLapSec) ? r.bestLapSec - lg.sec : null;
      out.push(kpiHtml({
        key: 'gap',
        icon: '<svg class="icon"><use href="#i-shield-alert" /></svg>',
        label: 'Gap to leaderboard',
        value: `${esc(fmtSec(lg.sec, 2))}s`,
        tone: lg.sec > 0.02 ? 'loss' : lg.sec < -0.02 ? 'gain' : 'level',
        sub: esc(lg.label || 'vs the top of the board'),
        chips: flagChipsHtml(lg.flags, 3),
        spark: known(leaderSec) ? sparkHtml(lapTimes(r, true).map((v) => (known(v) ? v - leaderSec : null)), true) : '',
        title: 'Your best lap against the fastest fair lap on the leaderboard in your class',
      }));
    }
    return `<div class="prx-kpis" data-n="${out.length}">${out.join('')}</div>`;
  }

  /* ---- the AI coach --------------------------------------------------- */

  const TONE_ICON = {
    loss: '<svg class="icon"><use href="#i-target" /></svg>',
    potential: '<svg class="icon"><use href="#i-gauge" /></svg>',
    target: '<svg class="icon"><use href="#i-flag" /></svg>',
  };

  function coachHtml() {
    if (coach.state === 'unavailable' || coach.state === 'none' || coach.state === 'idle') return '';
    const head = (headline, right) => `
      <div class="prx-coach__head">
        <span class="prx-coach__title"><svg class="icon"><use href="#i-sparkles" /></svg>AI Coach</span>
        <span class="prx-coach__headline">${headline}</span>
        <span class="prx-coach__right">${right || ''}</span>
      </div>`;
    if (coach.state === 'loading') {
      return `
        <section class="prx-coach" data-state="loading" aria-busy="true">
          ${head('Reading your session…')}
          <div class="prx-coach__cards">${[1, 2, 3].map((n) => `
            <div class="prx-take prx-take--ghost"><span class="prx-take__n">${n}</span>
              <div class="prx-take__text"><i class="prx-shimmer"></i><i class="prx-shimmer"></i><i class="prx-shimmer prx-shimmer--short"></i></div>
            </div>`).join('')}
          </div>
        </section>`;
    }
    const rep = coach.report;
    const n = (rep.takeaways || []).length;
    const right = coach.refining
      ? '<span class="prx-refining" role="status"><i></i>Refining…</span>'
      : rep.source === 'ai' ? '<span class="prx-aibadge"><svg class="icon"><use href="#i-sparkles" /></svg>Powered by Apex AI</span>' : '';
    const headline = rep.headline
      ? esc(fillFacts(rep.headline, rep.facts))
      : `Session analysis complete — ${n} key takeaway${n === 1 ? '' : 's'} for your next run.`;
    const cards = (rep.takeaways || []).slice(0, 3).map((t, i) => {
      const tone = t.tone === 'potential' || t.tone === 'target' ? t.tone : 'loss';
      return `
        <article class="prx-take" data-tone="${tone}">
          <span class="prx-take__n">${i + 1}</span>
          <div class="prx-take__text">
            <h3>${esc(fillFacts(t.title, rep.facts))}</h3>
            <p>${esc(fillFacts(t.body, rep.facts))}</p>
            ${t.chip ? `<span class="prx-take__chip" data-tone="${tone}">${esc(fillFacts(t.chip, rep.facts))}</span>` : ''}
          </div>
          <span class="prx-take__icon" data-tone="${tone}" aria-hidden="true">${TONE_ICON[tone]}</span>
        </article>`;
    }).join('');
    const flags = flagChipsHtml(rep.fairness);
    return `
      <section class="prx-coach" data-state="${coach.refining ? 'refining' : 'ok'}" data-source="${esc(rep.source || 'template')}">
        ${head(headline, right)}
        ${flags ? `<div class="prx-coach__flags"><span>About the comparison:</span>${flags}</div>` : ''}
        ${cards ? `<div class="prx-coach__cards">${cards}</div>` : ''}
      </section>`;
  }

  /* ---- where time is lost --------------------------------------------- */

  function lossBarsHtml(series) {
    const worst = Math.max(0.05, ...series.map((d) => (known(d) ? Math.abs(d) : 0)));
    const laps = (practice.review && practice.review.laps) || [];
    return series.map((d, i) => {
      const h = known(d) ? Math.max(5, Math.round((Math.abs(d) / worst) * 100)) : 0;
      const no = laps[i] ? laps[i].lapNo : i + 1;
      return `<i data-tone="${toneOfSec(d)}" style="height:${h}%" title="Lap ${esc(String(no))}: ${known(d) ? `${esc(secSigned(d))} s` : 'not scored'}"></i>`;
    }).join('');
  }

  const PRIORITY_WORD = { high: 'High priority', medium: 'Medium', low: 'Low' };

  function whereHtml(r) {
    const items = lossItems(r);
    const scored = (r.laps || []).some((l) => l.hasTrace);
    const body = items.length ? items.map((it, i) => `
      <div class="prx-loss" data-pri="${esc(it.priority)}">
        <span class="prx-loss__rank">${i + 1}</span>
        <div class="prx-loss__id">
          <b>${esc(it.id)}</b>
          <span>${esc(PHASE_WORDS[it.phase] || 'Through the corner')}</span>
        </div>
        <div class="prx-loss__sec" data-tone="${toneOfSec(it.lossSec)}">
          <b>${esc(fmtSec(it.lossSec, 2))}s</b>
          <span>${esc(vsWords(r.target))}</span>
        </div>
        <div class="prx-loss__bars" aria-hidden="true">${lossBarsHtml(it.perLap || [])}</div>
        <span class="prx-pill" data-pri="${esc(it.priority)}">${esc(PRIORITY_WORD[it.priority] || 'Medium')}</span>
        <div class="prx-loss__tip">
          <svg class="icon"><use href="#i-sparkles" /></svg>
          <span class="prx-loss__tiptext">${esc(it.tip)}</span>
          ${known(it.confidence) ? `<span class="prx-loss__conf" title="How consistently this corner costs you time, lap to lap">Conf. ${Math.round(it.confidence * 100)}%</span>` : ''}
          ${known(it.index) ? `<button type="button" class="prx-showbtn" data-prshow="${esc(it.id)}" data-prindex="${it.index}"
              title="Open a typical lap at ${esc(it.id)} and walk through it">
              <svg class="icon"><use href="#i-play" /></svg>Show me</button>` : ''}
        </div>
      </div>`).join('')
      : `<p class="prx-note">${scored
        ? 'No corner costs you time on average — the gap is spread thin across the lap.'
        : 'None of these laps kept a trace, so their corners could not be scored.'}</p>`;
    return `
      <header class="prx-card__head">
        <h2 class="prx-h"><svg class="icon"><use href="#i-target" /></svg>Where time is lost</h2>
        <span class="prx-card__sub">Top ${items.length || 3} corners with the biggest potential gains</span>
      </header>
      <div class="prx-losses">${body}</div>`;
  }

  /* ---- lap times ------------------------------------------------------ */

  /** One lap's corners as a strip of squares: faster, slower or level than the target. */
  function cornerStripHtml(lap, corners) {
    const byIndex = new Map((lap.corners || []).map((c) => [c.index, c]));
    return `<span class="prx-strip" aria-hidden="true">${corners.map((cs) => {
      const c = byIndex.get(cs.index);
      const d = c ? c.deltaSec : null;
      return `<i data-tone="${toneOfSec(d)}" style="--a:${strengthOf(d).toFixed(2)}"></i>`;
    }).join('')}</span>`;
  }

  function lapsHtml(r) {
    const corners = r.corners || [];
    const best = bestLapOf(r);
    const anyScore = (r.laps || []).some((l) => l.score);
    const rows = (r.laps || []).slice().reverse()
      .filter((lap) => lapFilter === 'all' || lap.valid)
      .map((lap) => {
        const isBest = !!best && lap.at === best.at;
        const studiable = !!lap.hasTrace;
        const v = scoreOf(lap.score);
        const delta = known(r.bestLapSec) && known(lap.lapSec) && lap.lapSec > 0 ? lap.lapSec - r.bestLapSec : null;
        return `
          <tr data-prlap="${esc(lap.at)}" data-valid="${String(!!lap.valid)}" data-best="${String(isBest)}"
              data-trace="${String(studiable)}" ${studiable ? 'tabindex="0" role="button" title="Study this lap"' : 'title="No telemetry was kept for this lap"'}>
            <td class="prx-lt__no">${esc(String(lap.lapNo))}${isBest ? '<svg class="icon prx-lt__trophy"><use href="#i-trophy" /></svg>' : ''}</td>
            <td class="prx-lt__time">${esc(lapFromSec(lap.lapSec))}</td>
            <td class="prx-lt__delta" data-tone="${isBest ? 'none' : toneOfSec(delta)}">${isBest ? '– –' : esc(fmtSec(delta, 3))}</td>
            <td class="prx-lt__valid">${lap.valid
              ? '<svg class="icon" data-ok="true" aria-label="Valid"><use href="#i-check" /></svg>'
              : '<svg class="icon" data-ok="false" aria-label="Invalid"><use href="#i-x" /></svg>'}</td>
            ${anyScore ? `<td class="prx-lt__score" data-band="${bandOf(v)}" title="${esc(lap.score ? `Accuracy ${scoreText(v)} — ${partsLine(lap.score)}` : 'Not scored')}">${esc(scoreText(v))}</td>` : ''}
            <td class="prx-lt__strip">${studiable && corners.length ? cornerStripHtml(lap, corners) : '<span class="prx-muted">no trace</span>'}</td>
            <td class="prx-lt__flag">${isBest ? '<span class="prx-bestpill">Best</span>' : ''}</td>
          </tr>`;
      }).join('');
    const n = (r.laps || []).length;
    return `
      <header class="prx-card__head">
        <h2 class="prx-h"><svg class="icon"><use href="#i-timer" /></svg>Lap times</h2>
        <span class="prx-card__sub">${n} lap${n === 1 ? '' : 's'} <i>•</i> Best ${esc(lapFromSec(r.bestLapSec))} <i>•</i> Theory ${esc(lapFromSec(r.theoreticalBestSec))}</span>
        <label class="prx-selectwrap prx-selectwrap--sm">
          <select class="prx-select" data-prlapfilter aria-label="Which laps to list">
            <option value="all"${lapFilter === 'all' ? ' selected' : ''}>All laps</option>
            <option value="valid"${lapFilter === 'valid' ? ' selected' : ''}>Valid only</option>
          </select>
          <svg class="icon" aria-hidden="true"><use href="#i-chevron-down" /></svg>
        </label>
      </header>
      <div class="prx-lt__box"><div class="prx-lt__scroll">
        <table class="prx-lt">
          <thead><tr><th>#</th><th>Lap time</th><th title="Against your best lap of the session">Delta</th><th>Valid</th>${anyScore ? '<th>Score</th>' : ''}
            <th title="Each corner against ${esc(targetName(r.target) || 'the target')}: green faster, red slower">Corner performance</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" class="prx-muted">No ${lapFilter === 'valid' ? 'valid ' : ''}laps.</td></tr>`}</tbody>
        </table>
      </div></div>`;
  }

  /* ---- corner by corner ----------------------------------------------- */

  /*
   * One row of cells per comparison, one column per corner. Each measure
   * says what "better" means and how strong a colour a difference earns:
   * time (seconds, lower is better), speed at the apex (km/h, higher), the
   * brake point (metres, later is better), and entry / exit accuracy (the
   * score's braking and throttle parts).
   */
  const HEAT = {
    time: {
      label: 'Time delta',
      of: (c) => (c ? c.deltaSec : null),
      better: 'low',
      level: 0.02,
      full: 0.2,
      fmt: (v) => `${secSigned(v)} s`,
    },
    speed: {
      label: 'Speed',
      of: (c) => (c ? c.apexKphDelta : null),
      better: 'high',
      level: 1,
      full: 8,
      fmt: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.round(Math.abs(speedUnit === 'mph' ? toMph(v) : v))} ${speedUnitLabel()} at the apex`,
    },
    brake: {
      label: 'Braking',
      of: (c) => (c ? c.brakeDeltaM : null),
      better: 'high',
      level: 3,
      full: 20,
      fmt: (v) => (Math.abs(v) < 1 ? 'braked on the mark' : `braked ${Math.round(Math.abs(v))} m ${v > 0 ? 'later' : 'earlier'}`),
    },
  };

  /** The tone and strength of one heat value, by its measure. */
  function heatLook(m, v) {
    if (!known(v)) return { tone: 'none', a: 0 };
    const good = m.better === 'low' ? -v : v;
    const tone = Math.abs(v) <= m.level ? 'level' : good > 0 ? 'gain' : 'loss';
    return { tone, a: Math.max(0.3, Math.min(1, Math.abs(v) / m.full)) };
  }

  /** Each corner's best value across the valid laps (the theoretical lap's). */
  function bestPerCorner(r, m) {
    const out = new Map();
    for (const lap of r.laps || []) {
      if (!lap.valid || !lap.hasTrace) continue;
      for (const c of lap.corners || []) {
        const v = m.of(c);
        if (!known(v)) continue;
        const was = out.get(c.index);
        if (!known(was) || (m.better === 'low' ? v < was : v > was)) out.set(c.index, v);
      }
    }
    return out;
  }

  /** Each corner's mean value across the valid laps. */
  function meanPerCorner(r, of) {
    const sums = new Map();
    for (const lap of r.laps || []) {
      if (!lap.valid || !lap.hasTrace) continue;
      for (const c of lap.corners || []) {
        const v = of(c);
        if (!known(v)) continue;
        const s = sums.get(c.index) || [0, 0];
        s[0] += v;
        s[1] += 1;
        sums.set(c.index, s);
      }
    }
    return new Map([...sums].map(([k, [a, n]]) => [k, a / n]));
  }

  function heatRows(r) {
    const best = bestLapOf(r);
    const t = r.target;
    const bestIsRef = !!best && t && t.kind === 'sessionBest' && Math.abs(best.lapSec - t.lapSec) < 0.0005;
    const at = (lap) => new Map(((lap && lap.corners) || []).map((c) => [c.index, c]));
    const bestBy = at(best);
    const tName = t && t.kind === 'sessionBest' ? 'session best' : targetName(t) || 'target';
    if (heatTab === 'entry') {
      const entry = (c) => (c && c.score ? c.score.braking : null);
      const exit = (c) => (c && c.score ? c.score.throttle : null);
      const meanEntry = meanPerCorner(r, entry);
      const meanExit = meanPerCorner(r, exit);
      return [
        best && { label: 'Best lap · entry', sub: lapFromSec(best.lapSec), lap: best, value: (i) => entry(bestBy.get(i)), score: true },
        best && { label: 'Best lap · exit', sub: '', lap: best, value: (i) => exit(bestBy.get(i)), score: true },
        { label: 'Average · entry', sub: '', lap: best, value: (i) => meanEntry.get(i), score: true },
        { label: 'Average · exit', sub: '', lap: best, value: (i) => meanExit.get(i), score: true },
      ].filter(Boolean);
    }
    const m = HEAT[heatTab] || HEAT.time;
    const mean = meanPerCorner(r, m.of);
    const theo = bestPerCorner(r, m);
    // The last valid studied lap: where the session ended up, lap by lap.
    const last = (r.laps || []).slice().reverse().find((l) => l.valid && l.hasTrace && (!best || l.at !== best.at)) || null;
    const lastBy = at(last);
    return [
      best && !bestIsRef && { label: 'Your best lap', sub: lapFromSec(best.lapSec), lap: best, value: (i) => m.of(bestBy.get(i)), m, ref: tName },
      last && { label: `Last lap (${last.lapNo}) vs ${tName}`, sub: '', lap: last, value: (i) => m.of(lastBy.get(i)), m, ref: tName },
      { label: `Average vs ${tName}`, sub: '', lap: best, value: (i) => mean.get(i), m, ref: tName },
      best && {
        label: 'Best vs theoretical',
        sub: '',
        lap: best,
        value: (i) => { const v = m.of(bestBy.get(i)); const b = theo.get(i); return known(v) && known(b) ? v - b : null; },
        m,
        ref: 'your best corner',
      },
    ].filter(Boolean);
  }

  function heatHtml(r) {
    const corners = r.corners || [];
    const anyEntry = (r.laps || []).some((l) => (l.corners || []).some((c) => c.score && (known(c.score.braking) || known(c.score.throttle))));
    const anyBrake = (r.laps || []).some((l) => (l.corners || []).some((c) => known(c.brakeDeltaM)));
    const anySpeed = (r.laps || []).some((l) => (l.corners || []).some((c) => known(c.apexKphDelta)));
    const tabs = [['time', 'Time delta'], anySpeed && ['speed', 'Speed'], anyBrake && ['brake', 'Braking'], anyEntry && ['entry', 'Entry/Exit']].filter(Boolean);
    if (!tabs.some(([k]) => k === heatTab)) heatTab = 'time';
    const head = `
      <header class="prx-card__head">
        <h2 class="prx-h">Corner by corner</h2>
        <span class="prx-tabs" role="tablist" aria-label="Measure">${tabs.map(([k, label]) =>
          `<button type="button" role="tab" data-prheattab="${k}" aria-selected="${String(heatTab === k)}">${esc(label)}</button>`).join('')}</span>
        <span class="prx-legend">${heatTab === 'entry'
          ? '<span><i data-tone="gain"></i>Accurate</span><span><i data-tone="loss"></i>Work on it</span><span><i data-tone="level"></i>Close</span>'
          : '<span><i data-tone="gain"></i>Faster</span><span><i data-tone="loss"></i>Slower</span><span><i data-tone="level"></i>Similar</span>'}</span>
      </header>`;
    if (!corners.length || !(r.laps || []).some((l) => l.hasTrace)) {
      return `${head}<p class="prx-note">None of these laps kept a trace, so their corners could not be compared.</p>`;
    }
    const rows = heatRows(r);
    const cols = corners.map((c) => `<span class="prx-heat__col">${esc(cornerIdOf(c))}</span>`).join('');
    const body = rows.map((row) => {
      const cells = corners.map((c) => {
        const v = row.value(c.index);
        let look;
        let words;
        if (row.score) {
          look = !known(v) ? { tone: 'none', a: 0 } : { tone: v >= 80 ? 'gain' : v < 60 ? 'loss' : 'level', a: Math.max(0.3, Math.min(1, Math.abs(v - 70) / 30)) };
          words = known(v) ? `${Math.round(v)} / 100` : 'not scored';
        } else {
          look = heatLook(row.m, v);
          words = known(v) ? `${row.m.fmt(v)} vs ${row.ref}` : 'not measured';
        }
        const tip = `${cornerIdOf(c)} · ${row.label}\n${words}`;
        const open = row.lap && row.lap.hasTrace;
        return `<button type="button" class="prx-cell" data-tone="${look.tone}" style="--a:${look.a.toFixed(2)}"
                  ${open ? `data-prlap="${esc(row.lap.at)}" data-prcorner="${c.index}"` : 'disabled'}
                  data-tip="${esc(tip)}" aria-label="${esc(tip.replace(/\n/g, ', '))}"></button>`;
      }).join('');
      return `<span class="prx-heat__row">${esc(row.label)}${row.sub ? ` <i>(${esc(row.sub)})</i>` : ''}</span>${cells}`;
    }).join('');
    return `${head}
      <div class="prx-heat__scroll">
        <div class="prx-heat__grid" style="--n:${corners.length}">
          <span></span>${cols}
          ${body}
        </div>
      </div>
      <p class="prx-heat__foot">Click a square to open that lap at that corner.</p>
      <div class="prx-tipbox" hidden></div>`;
  }

  /* ---- lap pace & accuracy -------------------------------------------- */

  function paceHtml(r) {
    const laps = (r.laps || []).filter((l) => known(l.lapSec) && l.lapSec > 0);
    const scored = (r.laps || []).filter((l) => known(scoreOf(l.score)));
    const tabs = [['time', 'Lap time'], scored.length > 1 && ['acc', 'Accuracy'], laps.filter((l) => l.valid).length > 2 && ['cons', 'Consistency']].filter(Boolean);
    if (!tabs.some(([k]) => k === paceTab)) paceTab = 'time';
    const legend = paceTab === 'time'
      ? '<span><i class="prx-key prx-key--line"></i>Lap time</span><span><i class="prx-key prx-key--dash"></i>Theoretical best</span>'
      : paceTab === 'acc'
        ? '<span><i class="prx-key prx-key--line"></i>Lap score</span><span><i class="prx-key prx-key--dash"></i>Session average</span>'
        : '<span><i class="prx-key prx-key--gain"></i>Quicker than usual</span><span><i class="prx-key prx-key--loss"></i>Slower</span>';
    return `
      <header class="prx-card__head">
        <h2 class="prx-h">Lap pace &amp; accuracy</h2>
        <span class="prx-tabs" role="tablist" aria-label="Chart">${tabs.map(([k, label]) =>
          `<button type="button" role="tab" data-prpacetab="${k}" aria-selected="${String(paceTab === k)}">${esc(label)}</button>`).join('')}</span>
        <span class="prx-legend">${legend}</span>
      </header>
      ${paceSvg(r, laps, scored)}`;
  }

  function paceSvg(r, laps, scored) {
    const W = Math.max(300, Math.round(paceW));
    const H = 210;
    const L = 46;
    const R = 12;
    const T = 10;
    const B = 30;
    const all = (r.laps || []).map((l) => l.lapNo);
    const n0 = Math.min(...all);
    const n1 = Math.max(...all);
    if (!all.length || !Number.isFinite(n0)) return '<p class="prx-note">No laps to chart.</p>';
    const x = (no) => (n1 === n0 ? (L + W - R) / 2 : L + ((no - n0) / (n1 - n0)) * (W - L - R));
    const step = Math.max(1, Math.ceil((n1 - n0 + 1) / 8));
    const xTicks = [];
    for (let no = n0; no <= n1; no += step) xTicks.push(no);
    if (xTicks[xTicks.length - 1] !== n1) xTicks.push(n1);
    const xAxis = xTicks.map((no) => `<text class="prx-axis" x="${x(no).toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${no}</text>`).join('')
      + `<text class="prx-axis prx-axis--title" x="${((L + W - R) / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle">Lap number</text>`;
    const svg = (inner) => `
      <svg class="prx-pace__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Lap pace chart">
        ${inner}${xAxis}
      </svg>`;

    if (paceTab === 'acc') {
      const vals = scored.map((l) => scoreOf(l.score));
      const lo = Math.max(0, Math.floor((Math.min(...vals) - 5) / 10) * 10);
      const y = (v) => T + ((100 - v) / (100 - lo || 1)) * (H - T - B);
      const grid = [];
      for (let g = lo; g <= 100; g += 10) grid.push(`<line class="prx-grid" x1="${L}" x2="${W - R}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}" /><text class="prx-axis" x="${L - 8}" y="${(y(g) + 3.5).toFixed(1)}" text-anchor="end">${g}</text>`);
      const avg = r.score && known(r.score.avg) ? r.score.avg : vals.reduce((a, b) => a + b, 0) / vals.length;
      const line = scored.map((l) => `${x(l.lapNo).toFixed(1)},${y(scoreOf(l.score)).toFixed(1)}`).join(' ');
      const dots = scored.map((l) => `<circle class="prx-dot" data-band="${bandOf(scoreOf(l.score))}" cx="${x(l.lapNo).toFixed(1)}" cy="${y(scoreOf(l.score)).toFixed(1)}" r="3.6"><title>Lap ${l.lapNo}: ${scoreText(scoreOf(l.score))} — ${partsLine(l.score)}</title></circle>`).join('');
      return svg(`${grid.join('')}
        <line class="prx-theo" x1="${L}" x2="${W - R}" y1="${y(avg).toFixed(1)}" y2="${y(avg).toFixed(1)}" />
        <polyline class="prx-line" points="${line}" />${dots}`);
    }

    if (paceTab === 'cons') {
      const valid = laps.filter((l) => l.valid);
      const med = median(valid.map((l) => l.lapSec));
      const devs = valid.map((l) => l.lapSec - med);
      const top = Math.max(0.5, ...devs.map((d) => Math.abs(d)));
      const cap = Math.min(top, Math.max(1, (r.consistencySec || 1) * 3));
      const mid = T + (H - T - B) / 2;
      const y = (d) => mid - (Math.max(-cap, Math.min(cap, d)) / cap) * ((H - T - B) / 2);
      const bw = Math.max(4, Math.min(18, ((W - L - R) / Math.max(1, n1 - n0 + 1)) * 0.6));
      const bars = valid.map((l, k) => {
        const d = devs[k];
        const y0 = y(0);
        const y1 = y(-d);
        return `<rect class="prx-bar" data-tone="${toneOfSec(d)}" x="${(x(l.lapNo) - bw / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" rx="2"><title>Lap ${l.lapNo}: ${fmtSec(d, 3)} s against your median lap</title></rect>`;
      }).join('');
      const ticks = [cap, cap / 2, 0, -cap / 2, -cap].map((d) => `<line class="prx-grid" x1="${L}" x2="${W - R}" y1="${y(d).toFixed(1)}" y2="${y(d).toFixed(1)}" /><text class="prx-axis" x="${L - 8}" y="${(y(d) + 3.5).toFixed(1)}" text-anchor="end">${d === 0 ? 'median' : `${d > 0 ? '−' : '+'}${Math.abs(d).toFixed(1)}`}</text>`).join('');
      return svg(`${ticks}${bars}`);
    }

    // Lap time: the line through the valid laps, invalid laps as hollow dots,
    // the theoretical best dashed across. A lap far off the pace is pinned to
    // the top edge, so one in-lap cannot flatten the rest.
    if (!laps.length) return '<p class="prx-note">No timed laps to chart.</p>';
    const times = laps.map((l) => l.lapSec);
    const theo = r.theoreticalBestSec;
    const lo0 = Math.min(...times, known(theo) ? theo : Infinity);
    const med = median(laps.filter((l) => l.valid).map((l) => l.lapSec)) || median(times);
    const hi0 = Math.min(Math.max(...times), med + Math.max(2, (med - lo0) * 2.5));
    const pad = Math.max(0.2, (hi0 - lo0) * 0.08);
    const lo = lo0 - pad;
    const hi = hi0 + pad;
    const y = (v) => T + ((hi - Math.min(hi, v)) / (hi - lo)) * (H - T - B);
    const span = hi - lo;
    const stepS = span > 20 ? 10 : span > 8 ? 4 : span > 4 ? 2 : span > 2 ? 1 : 0.5;
    const grid = [];
    for (let g = Math.ceil(lo / stepS) * stepS; g <= hi; g += stepS) {
      const m = Math.floor(g / 60);
      const s = g - m * 60;
      grid.push(`<line class="prx-grid" x1="${L}" x2="${W - R}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}" /><text class="prx-axis" x="${L - 8}" y="${(y(g) + 3.5).toFixed(1)}" text-anchor="end">${m}:${(stepS < 1 ? s.toFixed(1) : String(Math.round(s))).padStart(stepS < 1 ? 4 : 2, '0')}</text>`);
    }
    const valid = laps.filter((l) => l.valid);
    const line = valid.map((l) => `${x(l.lapNo).toFixed(1)},${y(l.lapSec).toFixed(1)}`).join(' ');
    const best = bestLapOf(r);
    const dots = laps.map((l) => {
      const off = l.lapSec > hi;
      return `<circle class="prx-dot${l.valid ? '' : ' prx-dot--invalid'}${best && l.at === best.at ? ' prx-dot--best' : ''}" cx="${x(l.lapNo).toFixed(1)}" cy="${y(l.lapSec).toFixed(1)}" r="${best && l.at === best.at ? 4.6 : 3.4}"><title>Lap ${l.lapNo}: ${lapFromSec(l.lapSec)}${l.valid ? '' : ' (invalid)'}${off ? ' — off the chart' : ''}</title></circle>`;
    }).join('');
    return svg(`${grid.join('')}
      ${known(theo) ? `<line class="prx-theo" x1="${L}" x2="${W - R}" y1="${y(theo).toFixed(1)}" y2="${y(theo).toFixed(1)}"><title>Theoretical best ${lapFromSec(theo)}</title></line>` : ''}
      ${valid.length > 1 ? `<polyline class="prx-line" points="${line}" />` : ''}${dots}`);
  }

  /* ---- states, banner, the whole overview ----------------------------- */

  function quietCard(text, busy) {
    return `
      <div class="prx-quiet"${busy ? ' aria-busy="true"' : ''}>
        <svg class="icon"><use href="#i-target" /></svg>
        <p>${esc(text)}</p>
      </div>`;
  }

  /** The banner for a review that arrived while the tab is open. */
  function pendingBannerHtml() {
    if (!pendingBanner || lapView) return '';
    const p = pendingBanner;
    const bits = [p.track, known(p.laps) ? `${p.laps} laps` : '', known(p.bestLapSec) ? `best ${lapFromSec(p.bestLapSec)}` : '']
      .filter(Boolean).map(esc).join(' · ');
    return `
      <div class="prx-banner" role="status">
        <svg class="icon"><use href="#i-target" /></svg>
        <span><b>Practice review ready</b>${bits ? ` — ${bits}` : ''}</span>
        <button type="button" class="btn btn--sm" data-propen>Open</button>
        <button type="button" class="iconbtn prx-banner__x" data-prdismiss aria-label="Dismiss">
          <svg class="icon"><use href="#i-x" /></svg>
        </button>
      </div>`;
  }

  /** The overview, for the open session's current state. */
  function overviewHtml() {
    if (practice.id !== currentId || practice.state === 'idle' || practice.state === 'loading') {
      return quietCard('Lining every lap up against your target…', true);
    }
    if (practice.state === 'unavailable') return quietCard('This version of the app cannot build practice reviews.');
    if (practice.state !== 'ok' || !practice.review) {
      return quietCard(practice.state === 'error'
        ? 'The review for this session could not be read.'
        : 'No review could be built for this session: none of its laps kept a trace.');
    }
    const r = practice.review;
    return `
      <div class="prx-page${targetBusy ? ' prx-page--busy' : ''}">
        <div class="prx-kpislot">${kpisHtml(r)}</div>
        <div class="prx-coachslot">${coachHtml()}</div>
        <div class="prx-row prx-row--a">
          <section class="prx-card prx-where">${whereHtml(r)}</section>
          <section class="prx-card prx-laps">${lapsHtml(r)}</section>
        </div>
        <div class="prx-row prx-row--b">
          <section class="prx-card prx-heat prx-tipzone">${heatHtml(r)}</section>
          <section class="prx-card prx-pace">${paceHtml(r)}</section>
        </div>
      </div>`;
  }

  /** Re-render one part of the overview in place (the rest keeps its state). */
  function renderPart(name) {
    if (!els.detail || lapView || practice.state !== 'ok' || !practice.review) return;
    const r = practice.review;
    const put = (sel, html) => {
      const el = els.detail.querySelector(sel);
      if (el) el.innerHTML = html;
      return !!el;
    };
    let ok = true;
    if (name === 'kpis') ok = put('.prx-kpislot', kpisHtml(r));
    else if (name === 'coach') ok = put('.prx-coachslot', coachHtml()) && put('.prx-where', whereHtml(r));
    else if (name === 'laps') ok = put('.prx-laps', lapsHtml(r));
    else if (name === 'heat') ok = put('.prx-heat', heatHtml(r));
    else if (name === 'pace') ok = put('.prx-pace', paceHtml(r));
    if (!ok) render();
  }

  /** Redraw the pace chart if its card is not the width it was drawn for. */
  function fitPace() {
    const box = els.detail && !lapView ? els.detail.querySelector('.prx-pace') : null;
    if (!box) return;
    const w = box.clientWidth - 34;
    if (w > 0 && Math.abs(w - paceW) > 6) {
      paceW = w;
      renderPart('pace');
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  The header: pickers, target, the session's facts                      */
  /* ---------------------------------------------------------------------- */

  const optionHtml = (value, label, on) => `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(label)}</option>`;

  /** Fill the track / class / session pickers from the list, on the open session. */
  function renderPickers() {
    const cur = summaries.find((s) => s.id === currentId) || null;
    const trackKey = cur ? cur.trackKey : '';
    const cls = cur ? cur.carClass : '';
    if (els.track) {
      const seen = new Map();
      for (const s of summaries) if (!seen.has(s.trackKey)) seen.set(s.trackKey, s.track || s.trackKey);
      const tracks = [...seen].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
      els.track.innerHTML = tracks.length
        ? tracks.map(([k, label]) => optionHtml(k, label, k === trackKey)).join('')
        : optionHtml('', loadedOnce ? 'No tracks yet' : 'Reading…', true);
      els.track.disabled = tracks.length < 2;
    }
    if (els.cls) {
      const classes = [...new Set(summaries.filter((s) => s.trackKey === trackKey).map((s) => s.carClass || ''))].sort();
      els.cls.innerHTML = classes.length
        ? classes.map((c) => optionHtml(c, c || 'Any class', c === cls)).join('')
        : optionHtml('', dash, true);
      els.cls.disabled = classes.length < 2;
    }
    if (els.session) {
      // Every session at this track in this class, newest first, grouped by
      // day — the old session list, folded into one picker.
      const rows = summaries.filter((s) => s.trackKey === trackKey && (s.carClass || '') === cls);
      let html = '';
      let day = '';
      let open = false;
      for (const s of rows) {
        const d = dayLabel(s.startedAt);
        if (d !== day) {
          if (open) html += '</optgroup>';
          html += `<optgroup label="${esc(d)}">`;
          open = true;
          day = d;
        }
        const test = String(s.sessionType || '').toLowerCase().startsWith('test');
        const label = [`${test ? 'Test day · ' : ''}${clockLabel(s.startedAt)}`, known(s.bestMs) ? fmtLap(s.bestMs) : 'no clean lap', `${s.laps} lap${s.laps === 1 ? '' : 's'}`].join(' · ');
        html += optionHtml(s.id, label, s.id === currentId);
      }
      if (open) html += '</optgroup>';
      els.session.innerHTML = html || optionHtml('', loadedOnce ? 'No practice sessions yet' : 'Reading your sessions…', true);
      els.session.disabled = !rows.length;
    }
  }

  /** The right side of the header: date, type, laps, length, air and track. */
  function renderMeta() {
    if (!els.meta) return;
    const cur = summaries.find((s) => s.id === currentId) || null;
    if (!cur) { els.meta.innerHTML = ''; return; }
    const r = practice.id === currentId ? practice.review : null;
    const laps = session && Array.isArray(session.stints) ? session.stints.flatMap((s) => s.laps || []) : [];
    const airs = laps.map((l) => l.ambientTempC).filter(known);
    const tracks = laps.map((l) => l.trackTempC).filter(known);
    const air = airs.length ? airs.reduce((a, b) => a + b, 0) / airs.length : null;
    const trk = tracks.length ? tracks.reduce((a, b) => a + b, 0) / tracks.length : null;
    const wet = laps.length ? laps.some((l) => l.wet) : !!cur.wet;
    const start = new Date((r && r.startedAt) || cur.startedAt).getTime();
    const end = new Date((r && r.endedAt) || cur.endedAt).getTime();
    const mins = Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round((end - start) / 60000) : null;
    const type = String(cur.sessionType || '').toLowerCase().startsWith('test') ? 'Test day' : 'Practice';
    const n = r ? (r.laps || []).length : cur.laps;
    els.meta.innerHTML = `
      <span class="prx-meta__when">
        <b>${esc(longDay(cur.startedAt))}</b>
        <span>${esc(type)} <i>•</i> ${esc(String(n))} lap${n === 1 ? '' : 's'}${known(mins) ? ` <i>•</i> ${mins} min` : ''}</span>
      </span>
      ${known(air) || laps.length ? `
      <span class="prx-meta__wx" title="${esc([known(air) ? `Air ${tempOf(air)}` : '', known(trk) ? `Track ${tempOf(trk)}` : ''].filter(Boolean).join(' · ') || 'Conditions')}">
        <svg class="icon" aria-hidden="true">${wet ? '<use href="#i-cloud-rain" />' : '<use href="#i-thermometer" />'}</svg>
        <span><b>${esc(known(air) ? tempOf(air) : dash)}</b><span>${wet ? 'Wet' : 'Dry'}</span></span>
      </span>` : ''}`;
  }

  /* ---- the target picker ---------------------------------------------- */

  /** What the target button and its menu offer. */
  function targetOptions() {
    const out = [];
    const bt = baseTarget;
    if (bt && bt.kind !== 'sessionBest') {
      out.push({ value: '', label: `vs ${targetName(bt)}`, time: bt.lapSec, note: 'The lap you chased', flags: [] });
      out.push({ value: 'sessionBest', label: 'vs your session best', time: practice.review && practice.review.bestLapSec, note: 'Your own best lap', flags: [] });
    } else {
      out.push({ value: '', label: 'vs your session best', time: bt ? bt.lapSec : null, note: 'Your own best lap', flags: [] });
    }
    const d = targets.id === currentId ? targets.data : null;
    for (const c of (d && Array.isArray(d.candidates) ? d.candidates : [])) {
      // The chased lap is often a board lap too: offer it once, as the chased one.
      if (!c || !c.lap || !c.lap.lapId || (bt && c.lap.lapId === bt.lapId)) continue;
      out.push({
        value: c.lap.lapId,
        label: `vs ${String(c.label || c.lap.driver || 'Leaderboard lap').split(' · ')[0]}`,
        time: c.lap.lapSec,
        note: d.pick === c.lap.lapId ? 'Leaderboard · suggested' : 'Leaderboard',
        flags: (c.assessment && c.assessment.flags) || [],
        board: true,
      });
    }
    return out;
  }

  function renderTarget() {
    if (!els.target) return;
    const opts = practice.state === 'ok' ? targetOptions() : [];
    if (!opts.length) { els.target.innerHTML = ''; els.target.hidden = true; return; }
    els.target.hidden = false;
    const cur = opts.find((o) => o.value === targetSel) || opts[0];
    const multi = opts.length > 1;
    const optRow = (o, i) => `
      <li role="option" class="prx-tgt__opt" data-prtarget="${esc(o.value)}" tabindex="-1"
          aria-selected="${String(o.value === cur.value)}"${o.board && i > 0 && !opts[i - 1].board ? ' data-first-board="true"' : ''}>
        <span class="prx-tgt__name">${esc(o.label)}</span>
        <span class="prx-tgt__time">${esc(lapFromSec(o.time))}</span>
        <span class="prx-tgt__note">${esc(o.note)}</span>
        ${o.flags.length ? `<span class="prx-tgt__flags">${flagChipsHtml(o.flags, 4)}</span>` : ''}
      </li>`;
    els.target.innerHTML = `
      <button type="button" class="prx-pick prx-tgt__btn" data-prtargetbtn aria-haspopup="listbox"
              aria-expanded="${String(targetOpen)}" ${multi ? '' : 'disabled'}
              title="${multi ? 'What the session is measured against' : 'The session is measured against your own best lap'}">
        <span>${esc(cur.label)}</span>
        ${targetBusy ? '<i class="prx-spin" aria-hidden="true"></i>' : ''}
        <svg class="icon" aria-hidden="true"><use href="#i-chevron-down" /></svg>
      </button>
      ${targetOpen && multi ? `<ul class="prx-tgt__menu" role="listbox" aria-label="Measure the session against">${opts.map(optRow).join('')}</ul>` : ''}
      ${targetNote ? `<span class="prx-tgt__note-err" role="status">${esc(targetNote)}</span>` : ''}`;
    if (targetOpen) {
      const sel = els.target.querySelector('[aria-selected="true"]') || els.target.querySelector('[role="option"]');
      if (sel) sel.focus();
    }
  }

  function closeTarget(focusBtn) {
    if (!targetOpen) return;
    targetOpen = false;
    renderTarget();
    if (focusBtn) els.target.querySelector('[data-prtargetbtn]')?.focus();
  }

  /** Measure the session against another lap: the review, then the coach, again. */
  async function chooseTarget(value) {
    targetOpen = false;
    if (value === targetSel || !currentId) { renderTarget(); return; }
    const id = currentId;
    const was = targetSel;
    targetSel = value;
    targetBusy = true;
    targetNote = '';
    renderTarget();
    const page = els.detail && els.detail.querySelector('.prx-page');
    if (page) page.classList.add('prx-page--busy');
    let review = null;
    try {
      const res = value
        ? await window.apex.reviewPractice(id, { targetLapId: value })
        : await window.apex.reviewPractice(id);
      review = res && res.review && Array.isArray(res.review.laps) ? res.review : (res && Array.isArray(res.laps) ? res : null);
    } catch {
      review = null;
    }
    if (currentId !== id) return;
    targetBusy = false;
    // A main that does not know the option answers with the default target:
    // say so rather than pretend the session was re-measured.
    const took = review && (!value
      || (value === 'sessionBest' ? review.target && review.target.kind === 'sessionBest'
        : review.target && review.target.lapId === value));
    if (!took) {
      targetSel = was;
      targetNote = review ? 'This build cannot measure against that lap yet.' : 'That lap could not be read.';
      render();
      return;
    }
    practice = { id, state: 'ok', review };
    render();
    void loadCoach();
  }

  /* ---------------------------------------------------------------------- */
  /*  "Your driving"                                                        */
  /* ---------------------------------------------------------------------- */

  function renderHabits() {
    if (!els.habitsBox) return;
    const can = !!(window.PracticeHabits && typeof window.PracticeHabits.render === 'function');
    const cur = summaries.find((s) => s.id === currentId) || null;
    const show = can && !!cur && !lapView && practice.state === 'ok';
    els.habitsBox.hidden = !show;
    if (!show) return;
    if (els.habitsToggle) els.habitsToggle.setAttribute('aria-expanded', String(habitsOpen));
    if (els.habits) els.habits.hidden = !habitsOpen;
    const key = `${cur.trackKey}|${cur.carClass}`;
    if (!habitsOpen || habitsKey === key || !els.habits) return;
    habitsKey = key;
    let p = null;
    try { p = window.PracticeHabits.render(els.habits, { trackKey: cur.trackKey, carClass: cur.carClass }); } catch { p = null; }
    if (p && typeof p.catch === 'function') p.catch(() => { if (habitsKey === key) habitsKey = ''; });
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

  /** Light the corner table's row for a corner, by index. */
  function markCornerRow(index) {
    if (!els.detail) return;
    for (const tr of els.detail.querySelectorAll('tr[data-prcorner]')) {
      tr.setAttribute('data-on', String(Number(tr.dataset.prcorner) === index));
    }
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
    markCornerRow(index);
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
      return '<div class="pr-read pr-read--idle">Move over the charts to read the lap — click a corner below to frame it.</div>';
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
      return '<p class="prx-note">The target lap has no corners to compare against.</p>';
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
            title="Frame ${esc(cornerIdOf(c))} on the map and the charts">
          <td class="pr-ct__name">${esc(cornerIdOf(c))}</td>
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
      <div class="pr-ct__scroll">
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
      </table>
      </div>`;
  }

  /** The coach's words for this lap, above the charts. */
  function lapCoachHtml(view) {
    const rep = view.coach && view.coach.report;
    if (!rep) return '';
    const takes = (rep.takeaways || []).slice(0, 3);
    return `
      <div class="prx-lapcoach">
        <span class="prx-lapcoach__title"><svg class="icon"><use href="#i-sparkles" /></svg>Coach</span>
        <div class="prx-lapcoach__body">
          ${rep.headline ? `<b>${esc(fillFacts(rep.headline, rep.facts))}</b>` : ''}
          ${takes.length ? `<ul>${takes.map((t) => `
            <li data-tone="${t.tone === 'potential' || t.tone === 'target' ? t.tone : 'loss'}">
              <span>${esc(fillFacts(t.title, rep.facts))}</span>${t.body ? ` — ${esc(fillFacts(t.body, rep.facts))}` : ''}
            </li>`).join('')}</ul>` : ''}
          ${flagChipsHtml(rep.fairness) ? `<span class="prx-lapcoach__flags">${flagChipsHtml(rep.fairness)}</span>` : ''}
        </div>
      </div>`;
  }

  function lapViewHtml(view) {
    const lap = view.plap;
    const back = `
      <button type="button" class="btn btn--ghost btn--sm" data-prback title="Back to the session overview">
        <svg class="icon"><use href="#i-arrow-left" /></svg><span>Overview</span>
      </button>`;
    if (!view.result) {
      return `
        <div class="rv-card rv-lap__bar">${back}<span class="rv-lap__name">Lap ${esc(String(lap.lapNo))}</span></div>
        <div class="rv-card">${quietCard(view.error || 'Reading the lap and the target…', !view.error)}</div>`;
    }
    const res = view.result;
    const t = res.target;
    const gap = t && known(t.lapSec) && known(lap.lapSec) && lap.lapSec > 0 ? lap.lapSec - t.lapSec : null;
    const [a, b] = view.window;
    const whole = b - a >= 0.999;
    const steps = view.coach && Array.isArray(view.coach.show) ? view.coach.show : [];
    const s = res.score;
    return `
      <div class="rv-lap pr-lap">
        <div class="rv-lap__bar">
          ${back}
          <span class="rv-lap__name">Lap ${esc(String(lap.lapNo))}</span>
          <span class="rv-lap__time">${esc(lapFromSec(lap.lapSec))}</span>
          ${lap.valid ? '' : '<span class="prx-tag">Invalid</span>'}
          <span class="pr-lap__vs">
            <span class="prx-vs">vs <b>${esc(targetName(t))}</b><span>${esc(lapFromSec(t && t.lapSec))}</span></span>
            ${known(gap) ? `<span class="pr-lap__gap" data-tone="${toneOfSec(gap)}">${esc(fmtSec(gap, 3))} s</span>` : ''}
          </span>
          ${s ? `<span class="pr-lap__score" title="${esc(`Accuracy ${scoreText(s.total)} — ${BAND_WORD[bandOf(s.total)]} · ${partsLine(s)}`)}">
            ${ringHtml(s.total, 36)}<span class="pr-lap__scoreparts">${esc(partsLine(s))}</span>${howHtml()}</span>` : ''}
          ${steps.length ? `<button type="button" class="prx-showbtn" data-prshowlap aria-pressed="${String(!!view.showOn)}"
              title="Walk through this lap's costliest corners on the map and charts">
              <svg class="icon"><use href="#i-play" /></svg>${view.showOn ? 'Stop' : 'Show me'}</button>` : ''}
          <span class="pr-lap__zoom">
            <span class="pr-lap__zoomlabel" data-przoomlabel>${whole ? 'Whole lap'
              : `${Math.round(a * view.lengthM)}–${Math.round(b * view.lengthM)} m`}</span>
            <button type="button" class="btn btn--ghost btn--sm" data-przoom="reset" ${whole ? 'disabled' : ''}>Whole lap</button>
          </span>
        </div>

        ${lapCoachHtml(view)}
        <div class="prx-show"${view.showOn ? '' : ' hidden'}><div class="prx-show__mount"></div></div>

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
          <div class="prx-card__head">
            <h2 class="prx-h">Corner by corner · lap ${esc(String(lap.lapNo))}</h2>
            <span class="prx-card__sub">Click a corner to frame it on the map and every chart</span>
          </div>
          ${cornerTableHtml(view)}
        </div>
      </div>`;
  }

  /* ---- Show me ---------------------------------------------------------- */

  /** Draw one step: its stretch of road, its marks and arrows, its corner lit. */
  function applyStep(step, i) {
    const view = lapView;
    if (!view || !step) return;
    view.showIdx = i;
    view.marks = Array.isArray(step.marks) ? step.marks : null;
    view.arrows = Array.isArray(step.arrows) ? step.arrows : null;
    const row = ((view.result && view.result.corners) || []).find((c) => cornerIdOf(c) === step.cornerId);
    if (row) {
      view.corner = row.index;
      markCornerRow(row.index);
      const ch = view.result.detail.channels;
      view.pin = indexAt(ch, row.apexD);
      view.cursor = view.pin;
    }
    if (Array.isArray(step.window) && known(step.window[0]) && known(step.window[1])) setWindow(step.window[0], step.window[1]);
    else if (view.repaint) view.repaint();
    if (!view.showHandle) drawFallbackStep(view);
  }

  /** The stepper used when show-me.js is not in this build: words, back, next. */
  function drawFallbackStep(view) {
    const mount = els.detail && els.detail.querySelector('.prx-show__mount');
    const steps = (view.coach && view.coach.show) || [];
    const i = view.showIdx || 0;
    const step = steps[i];
    if (!mount || !step) return;
    mount.innerHTML = `
      <div class="prx-step">
        <span class="prx-step__n">${i + 1} / ${steps.length}</span>
        <b class="prx-step__corner">${esc(step.cornerId)}</b>
        <span class="prx-step__text">${esc(tipText(step.text))}</span>
        <span class="prx-step__nav">
          <button type="button" class="btn btn--ghost btn--sm" data-prstep="-1" ${i === 0 ? 'disabled' : ''} aria-label="Previous step">
            <svg class="icon"><use href="#i-chevron-left" /></svg></button>
          <button type="button" class="btn btn--ghost btn--sm" data-prstep="1" ${i >= steps.length - 1 ? 'disabled' : ''} aria-label="Next step">
            <svg class="icon"><use href="#i-chevron-right" /></svg></button>
        </span>
      </div>`;
  }

  /** Mount the walk-through on the lap view's strip and go to step `start`. */
  function mountShow(start) {
    const view = lapView;
    const steps = view && view.coach && Array.isArray(view.coach.show) ? view.coach.show : [];
    const mount = els.detail && els.detail.querySelector('.prx-show__mount');
    if (!view || !steps.length || !mount) return;
    const at = Math.max(0, Math.min(steps.length - 1, known(start) ? start : 0));
    view.showHandle = null;
    if (window.ShowMe && typeof window.ShowMe.mount === 'function') {
      try {
        view.showHandle = window.ShowMe.mount(mount, { steps, onStep: (step, i) => applyStep(step, i) }) || null;
      } catch {
        view.showHandle = null;
      }
    }
    if (view.showHandle && typeof view.showHandle.go === 'function') view.showHandle.go(at);
    else applyStep(steps[at], at);
  }

  function unmountShow(view) {
    if (view && view.showHandle) {
      try { view.showHandle.destroy(); } catch { /* the strip goes with the render anyway */ }
      view.showHandle = null;
    }
  }

  function startShow(cornerId) {
    const view = lapView;
    const steps = view && view.coach && Array.isArray(view.coach.show) ? view.coach.show : [];
    if (!steps.length) return;
    const at = cornerId ? steps.findIndex((s) => s.cornerId === cornerId) : -1;
    view.showOn = true;
    view.showIdx = at >= 0 ? at : 0;
    render();
  }

  function stopShow() {
    const view = lapView;
    if (!view) return;
    unmountShow(view);
    view.showOn = false;
    view.marks = null;
    view.arrows = null;
    render();
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
      // Show me's marks and arrows ride on both painters; a review-charts.js
      // without them simply ignores the two extra options.
      const show = view.showOn ? { marks: view.marks || [], arrows: view.arrows || [] } : {};
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
          ...show,
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
          ...show,
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
      unmountShow(view);
      view.repaint = null;
    };
    if (view.showOn) mountShow(view.showIdx);
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

  /**
   * Open one lap against the session's target; `corner` frames a corner,
   * `showCorner` (an id) starts "Show me" on it once the coach has answered.
   */
  async function openLap(at, corner, showCorner) {
    const r = practice.review;
    if (!r || !currentId) return;
    const plap = (r.laps || []).find((l) => l.at === at);
    if (!plap || !plap.hasTrace) return;
    window.APEX_FEATURE_CATALOG?.note('action:practice.lap');
    if (lapOff) { lapOff(); lapOff = null; }
    closeTarget(false);
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
      coach: null,
      showOn: false,
      showIdx: 0,
      showHandle: null,
      marks: null,
      arrows: null,
    };
    const mine = lapView;
    render();
    if (!window.apex || typeof window.apex.practiceLap !== 'function') {
      mine.error = 'This version of the app cannot open a practice lap yet.';
      if (lapView === mine) render();
      return;
    }
    const lapId = lapIdAt(at, plap.lapNo);
    const targetLapId = targetSel || undefined;
    const coachCall = typeof window.apex.practiceCoachLap === 'function'
      ? Promise.resolve()
        .then(() => window.apex.practiceCoachLap({ sessionId: currentId, lapId, at, targetLapId, cornerId: showCorner || undefined }))
        .catch(() => null)
      : Promise.resolve(null);
    let res = null;
    try {
      res = await window.apex.practiceLap({ sessionId: currentId, lapId, at, haveMapKey: heldMapKey, targetLapId });
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

    const c = await coachCall;
    if (lapView !== mine) return;
    if (c && c.ok !== false && (c.report || (Array.isArray(c.show) && c.show.length))) {
      mine.coach = { report: c.report || null, show: Array.isArray(c.show) ? c.show : [] };
      // "Show me" from the overview starts the walk on its corner — only when
      // the coach has a step there; otherwise the corner is framed and the
      // walk is one click away, rather than opening on another corner.
      const k = showCorner ? mine.coach.show.findIndex((s) => s.cornerId === showCorner) : -1;
      if (k >= 0) {
        mine.showOn = true;
        mine.showIdx = k;
      }
      render();
      if (!mine.showOn && known(corner)) focusCorner(corner);
    }
  }

  function closeLap() {
    if (lapOff) { lapOff(); lapOff = null; }
    unmountShow(lapView);
    lapView = null;
    render();
  }

  /* ---------------------------------------------------------------------- */
  /*  Rendering                                                             */
  /* ---------------------------------------------------------------------- */

  function render() {
    if (!els.detail) return;
    if (lapOff) { lapOff(); lapOff = null; }
    renderPickers();
    renderMeta();
    renderTarget();
    if (els.view) els.view.setAttribute('data-prmode', lapView ? 'lap' : 'overview');
    if (lapView) {
      els.detail.innerHTML = lapViewHtml(lapView);
      paintLapView();
      renderHabits();
      return;
    }
    if (!currentId) {
      els.detail.innerHTML = quietCard(loadedOnce
        ? 'Leave a practice session in which you set a timed lap, and its review lands here: every lap against your target, and exactly where the time went.'
        : 'Reading your practice sessions…', !loadedOnce);
      renderHabits();
      return;
    }
    els.detail.innerHTML = `
      <div class="prx-bannerslot">${pendingBannerHtml()}</div>
      ${overviewHtml()}`;
    renderHabits();
    fitPace();
    if (practiceFocus && practice.state === 'ok') {
      practiceFocus = false;
      const top = els.view && els.view.querySelector('.prx-head');
      if (top) top.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function renderBanner() {
    if (!els.detail || lapView) return;
    const slot = els.detail.querySelector('.prx-bannerslot');
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
    unmountShow(lapView);
    lapView = null;
    currentId = id;
    session = null;
    targetSel = '';
    targetNote = '';
    targetBusy = false;
    targetOpen = false;
    baseTarget = null;
    coach = { key: '', state: 'idle', report: null, refining: false };
    practice = { id, state: 'loading', review: null };
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
    baseTarget = review ? review.target : null;
    render();
    if (!review) return;
    void loadCoach();
    void loadTargets(id);
    if ((review.laps || []).some((l) => l.score)) void loadTrend(review);
  }

  /**
   * The coach for the open session and target: the template words at once,
   * then the AI's, swapped in when they arrive. A later call (another target,
   * another session) makes an earlier answer stale, and it is dropped.
   */
  async function loadCoach() {
    const id = currentId;
    const key = `${id}|${targetSel}`;
    const api = window.apex || {};
    if (typeof api.practiceCoach !== 'function') {
      coach = { key, state: 'unavailable', report: null, refining: false };
      renderPart('coach');
      return;
    }
    coach = { key, state: 'loading', report: null, refining: false };
    renderPart('coach');
    const args = { sessionId: id, targetLapId: targetSel || undefined };
    let res = null;
    try { res = await api.practiceCoach(args); } catch { res = null; }
    if (coach.key !== key) return;
    const ok = (x) => x && x.ok !== false && x.report && Array.isArray(x.report.takeaways);
    coach = ok(res) ? { key, state: 'ok', report: res.report, refining: false } : { key, state: 'none', report: null, refining: false };
    if (typeof api.practiceCoachAi !== 'function') { renderPart('coach'); return; }
    coach.refining = true;
    renderPart('coach');
    let ai = null;
    try { ai = await api.practiceCoachAi(args); } catch { ai = null; }
    if (coach.key !== key) return;
    coach.refining = false;
    if (ok(ai)) { coach.report = ai.report; coach.state = 'ok'; }
    renderPart('coach');
  }

  /** Leaderboard laps worth measuring against, and the gap to the top. */
  async function loadTargets(id) {
    const api = window.apex || {};
    if (typeof api.practiceTargets !== 'function') { targets = { id, state: 'unavailable', data: null }; return; }
    targets = { id, state: 'loading', data: null };
    let res = null;
    try { res = await api.practiceTargets({ sessionId: id }); } catch { res = null; }
    if (currentId !== id) return;
    targets = res && res.ok !== false ? { id, state: 'ok', data: res } : { id, state: 'none', data: null };
    renderTarget();
    renderPart('kpis');
  }

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
    if (trend.key === key && (trend.state === 'ok' || trend.state === 'loading')) { renderPart('kpis'); return; }
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
    renderPart('kpis');
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

  /** The heatmap's hover card: the native title is too slow and too plain. */
  function wireTips(root) {
    root.addEventListener('mouseover', (evt) => {
      const cell = evt.target.closest && evt.target.closest('.prx-tipzone [data-tip]');
      const box = cell && cell.closest('.prx-tipzone');
      const tip = box && box.querySelector('.prx-tipbox');
      if (!tip) return;
      const lines = String(cell.dataset.tip || '').split('\n');
      tip.innerHTML = `<b>${esc(lines[0] || '')}</b>${lines.slice(1).map((l) => `<span>${esc(l)}</span>`).join('')}`;
      const b = box.getBoundingClientRect();
      const c = cell.getBoundingClientRect();
      tip.hidden = false;
      const half = Math.min(140, b.width / 2);
      const left = Math.max(half, Math.min(b.width - half, c.left - b.left + c.width / 2));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(c.top - b.top)}px`;
      tip.setAttribute('data-tone', cell.dataset.tone || 'none');
    });
    root.addEventListener('mouseout', (evt) => {
      const cell = evt.target.closest && evt.target.closest('.prx-tipzone [data-tip]');
      if (!cell) return;
      const tip = cell.closest('.prx-tipzone')?.querySelector('.prx-tipbox');
      if (tip && !(evt.relatedTarget && evt.relatedTarget.closest && evt.relatedTarget.closest('.prx-tipzone [data-tip]'))) {
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
      markCornerRow(-1);
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
    // The heatmap's and the pace chart's measures: only that card redraws.
    const ht = t.closest('[data-prheattab]');
    if (ht) { heatTab = ht.dataset.prheattab; renderPart('heat'); return; }
    const pt = t.closest('[data-prpacetab]');
    if (pt) { paceTab = pt.dataset.prpacetab; renderPart('pace'); return; }
    // "Show me" on a corner of the overview: a typical lap, walked through there.
    const sm = !lapView && t.closest('[data-prshow]');
    if (sm && practice.review) {
      const index = Number(sm.dataset.prindex);
      const item = lossItems(practice.review).find((x) => x.id === sm.dataset.prshow);
      const lap = representativeLap(practice.review, index, item ? item.lossSec : null);
      if (lap) void openLap(lap.at, index, sm.dataset.prshow);
      return;
    }
    // The lap view's Show me toggle, and the fallback stepper's arrows.
    if (lapView && t.closest('[data-prshowlap]')) {
      if (lapView.showOn) stopShow();
      else startShow(lapView.corner !== null ? cornerIdOf({ index: lapView.corner }) : null);
      return;
    }
    const stepBtn = lapView && t.closest('[data-prstep]');
    if (stepBtn) {
      const steps = (lapView.coach && lapView.coach.show) || [];
      const k = Math.max(0, Math.min(steps.length - 1, (lapView.showIdx || 0) + Number(stepBtn.dataset.prstep)));
      applyStep(steps[k], k);
      return;
    }
    // A corner row in the lap view frames that corner.
    const cornerRow = lapView && t.closest('tr[data-prcorner]');
    if (cornerRow) { focusCorner(Number(cornerRow.dataset.prcorner)); return; }
    // A lap row, or a heatmap cell (which also says which corner to frame).
    const lapEl = t.closest('[data-prlap]');
    if (lapEl && !lapView && !lapEl.disabled) {
      const corner = lapEl.dataset.prcorner !== undefined ? Number(lapEl.dataset.prcorner) : null;
      void openLap(lapEl.dataset.prlap, corner);
    }
  }

  function onDetailKey(evt) {
    if (evt.key === 'Escape' && lapView) {
      if (lapView.showOn) stopShow();
      else closeLap();
      return;
    }
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

  function onDetailChange(evt) {
    const f = evt.target.closest && evt.target.closest('[data-prlapfilter]');
    if (f) { lapFilter = f.value === 'valid' ? 'valid' : 'all'; renderPart('laps'); }
  }

  /** The target menu: click to open, arrows to move, Enter to pick, Escape to close. */
  function wireTarget() {
    if (!els.target) return;
    els.target.addEventListener('click', (evt) => {
      const t = evt.target;
      if (t.closest('[data-prtargetbtn]')) {
        targetOpen = !targetOpen;
        renderTarget();
        return;
      }
      const opt = t.closest('[data-prtarget]');
      if (opt) void chooseTarget(opt.dataset.prtarget);
    });
    els.target.addEventListener('keydown', (evt) => {
      const btn = evt.target.closest && evt.target.closest('[data-prtargetbtn]');
      if (btn && (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') && !targetOpen) {
        evt.preventDefault();
        targetOpen = true;
        renderTarget();
        return;
      }
      if (!targetOpen) return;
      const opts = [...els.target.querySelectorAll('[role="option"]')];
      const at = opts.indexOf(document.activeElement);
      if (evt.key === 'Escape') { evt.preventDefault(); closeTarget(true); return; }
      if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
        evt.preventDefault();
        const next = opts[Math.max(0, Math.min(opts.length - 1, at + (evt.key === 'ArrowDown' ? 1 : -1)))];
        if (next) next.focus();
        return;
      }
      if ((evt.key === 'Enter' || evt.key === ' ') && at >= 0) {
        evt.preventDefault();
        void chooseTarget(opts[at].dataset.prtarget);
      }
      if (evt.key === 'Tab') closeTarget(false);
    });
    document.addEventListener('click', (evt) => {
      // A click inside the picker re-renders it, so the clicked node may be
      // gone by now: only a click on something still in the page, outside
      // the picker, closes the menu.
      if (targetOpen && els.target && evt.target.isConnected && !els.target.contains(evt.target)) closeTarget(false);
    });
  }

  /** The header's pickers: a track opens its newest session; a class, its newest there. */
  function wirePickers() {
    const newestAt = (trackKey, cls) => summaries.find((s) => s.trackKey === trackKey && (cls === null || (s.carClass || '') === cls));
    if (els.track) {
      els.track.addEventListener('change', () => {
        const row = newestAt(els.track.value, null);
        if (row) void openSession(row.id);
      });
    }
    if (els.cls) {
      els.cls.addEventListener('change', () => {
        const cur = summaries.find((s) => s.id === currentId);
        const row = cur ? newestAt(cur.trackKey, els.cls.value) : null;
        if (row) void openSession(row.id);
      });
    }
    if (els.session) {
      els.session.addEventListener('change', () => {
        if (els.session.value && els.session.value !== currentId) void openSession(els.session.value);
      });
    }
  }

  function init() {
    if (ready) return;
    els.view = $('[data-view="practice"]');
    if (!els.view || !window.apex) return;
    els.detail = $('#pr-detail');
    els.refresh = $('#pr-refresh');
    els.session = $('#pr-session');
    els.track = $('#pr-track');
    els.cls = $('#pr-class');
    els.target = $('#pr-target');
    els.meta = $('#pr-meta');
    els.habitsBox = $('#pr-habits-box');
    els.habitsToggle = $('#pr-habits-toggle');
    els.habits = $('#pr-habits');
    els.tab = document.querySelector('.tab[data-tab="practice"]');

    if (els.refresh) {
      els.refresh.addEventListener('click', () => {
        trend = { key: '', state: 'idle', sessions: [] };
        habitsKey = '';
        void loadList(true).then(() => (currentId ? openSession(currentId) : null));
      });
    }
    wirePickers();
    wireTarget();
    if (els.habitsToggle) {
      els.habitsToggle.addEventListener('click', () => {
        habitsOpen = !habitsOpen;
        renderHabits();
      });
    }
    if (els.detail) {
      els.detail.addEventListener('click', onDetailClick);
      els.detail.addEventListener('keydown', onDetailKey);
      els.detail.addEventListener('change', onDetailChange);
      wireTips(els.detail);
    }

    const applyUnits = (settings) => {
      const next = settings && settings.speedUnit === 'mph' ? 'mph' : 'kph';
      const nextT = settings && settings.tempUnit === 'f' ? 'f' : 'c';
      if (next === speedUnit && nextT === tempUnit) return;
      speedUnit = next;
      tempUnit = nextT;
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
    let fitting = 0;
    window.addEventListener('resize', () => {
      if (!visible || lapView || fitting) return;
      fitting = requestAnimationFrame(() => { fitting = 0; fitPace(); });
    });
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
      closeTarget(false);
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
