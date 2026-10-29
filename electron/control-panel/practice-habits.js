/**
 * practice-habits.js — "Your driving": habits across sessions, in the Practice tab.
 * -----------------------------------------------------------------------------
 * The AI driving coach's habits view (2026-10-29). Where the debrief says how
 * ONE session went, this says what keeps happening at this track in this
 * class: session-by-session pace and accuracy, which corners the braking
 * point wanders in, and three to five plain-sentence habits (coasting, pedal
 * overlap, trail braking, TC/ABS, how long it takes to get up to speed, dirty
 * laps, and per-corner patterns like "Brakes early into C7 on 22 of 30 laps").
 *
 * The numbers are built in main (`practice:habits` → src/telemetry/
 * drivingHabits.ts, cached per lap so a visit costs milliseconds); this file
 * only lays them out. Every number on screen has a CoachFact behind it, and
 * when the AI bridge is there (`apex.coachAi`) the facts go to it for a short
 * narrative — the template sentences are always shown first and stay if the
 * AI is missing, slow or fails.
 *
 * Contract (docs: coach-brief-common.md):
 *
 *   window.PracticeHabits.render(el, { trackKey, carClass }) → Promise<void>
 *
 * The Practice tab owns the mount (`#pr-habits`) and calls this whenever the
 * open session's track or class changes. A call that is overtaken by a newer
 * one for the same element paints nothing. Everything is feature-detected:
 * with no `apex.practiceHabits`, or `ok: false` (off the beta channel, no
 * sessions here), the element is emptied and hidden, never an error box.
 *
 * Inline SVG and plain DOM only — no chart library, and the panel's CSP
 * (`script-src 'self'`) would refuse one from a CDN anyway.
 */
(function () {
  'use strict';

  const dash = '—';
  const TAB_KEY = 'apex.practice.habitsTab';
  /** Per element: the token of the newest render, so a slow older one paints nothing. */
  const tokens = new WeakMap();
  let tokenSeq = 0;

  /* ---------------------------------------------------------------------- */
  /*  Small helpers                                                         */
  /* ---------------------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const known = (v) => typeof v === 'number' && Number.isFinite(v);

  /** 81.438 → "1:21.438"; `dp` decimals on the seconds. */
  function lapText(sec, dp = 3) {
    if (!known(sec) || sec <= 0) return dash;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    const ss = s.toFixed(dp).padStart(dp ? dp + 3 : 2, '0');
    return m > 0 ? `${m}:${ss}` : s.toFixed(dp);
  }

  function shortDay(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  const TYPE_LETTER = { practice: 'P', testday: 'T', qualifying: 'Q', race: 'R', warmup: 'W' };
  const TYPE_NAME = { practice: 'Practice', testday: 'Test day', qualifying: 'Qualifying', race: 'Race', warmup: 'Warm-up' };

  function readTab() {
    try { return localStorage.getItem(TAB_KEY) || 'lap'; } catch { return 'lap'; }
  }
  function saveTab(v) {
    try { localStorage.setItem(TAB_KEY, v); } catch { /* a remembered tab is a convenience */ }
  }

  /** A fact's value as the card shows it. */
  function factText(f) {
    if (!f || !known(f.value)) return dash;
    const v = f.value;
    switch (f.unit) {
      case 's':
        return /^(bestLap|avgLap|personalBest)$/.test(f.kind) ? lapText(v) : `${v.toFixed(2)} s`;
      case 'm': return `${Math.round(v)} m`;
      case 'kph': return `${Math.round(v)} km/h`;
      case '%': return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
      case 'pts': return `${Math.round(v)} pts`;
      case 'laps': return `${Math.round(v)} lap${Math.round(v) === 1 ? '' : 's'}`;
      default: return String(v);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Trend                                                                 */
  /* ---------------------------------------------------------------------- */

  const TABS = [
    { id: 'lap', label: 'Lap time' },
    { id: 'acc', label: 'Accuracy' },
    { id: 'ref', label: 'Pace %' },
  ];

  function trendTabs(report, cur) {
    const has = {
      lap: report.trend.some((t) => known(t.bestSec)),
      acc: report.trend.filter((t) => known(t.accuracy)).length >= 1,
      ref: report.trend.filter((t) => known(t.refPct)).length >= 1,
    };
    const tabs = TABS.filter((t) => has[t.id]);
    const sel = tabs.some((t) => t.id === cur) ? cur : (tabs[0] && tabs[0].id) || 'lap';
    return { tabs, sel };
  }

  /**
   * One line chart over the sessions: `series` are { key, cls, label } read
   * off each trend point. `invert` puts small values at the TOP (lap times:
   * faster is up). The band, when given, is avg ± spread.
   */
  function lineChart(points, opts) {
    const W = 640;
    const H = 210;
    const L = 58;
    const R = 14;
    const T = 16;
    const B = 40;
    // The lines set the scale; the spread band is clipped to it. One session
    // with a ±11 s spread (a lap behind the safety car that was still clean)
    // would otherwise squash every line flat.
    const vals = [];
    for (const p of points) {
      for (const s of opts.series) if (known(p[s.key])) vals.push(p[s.key]);
    }
    if (!vals.length) return '';
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (opts.clamp) { lo = Math.max(opts.clamp[0], lo); hi = Math.min(opts.clamp[1], hi); }
    const pad = Math.max((hi - lo) * 0.12, opts.minPad || 0.5);
    lo -= pad;
    hi += pad;
    const n = points.length;
    const x = (i) => (n === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (n - 1));
    const y = (v) => {
      const f = (v - lo) / (hi - lo);
      return opts.invert ? T + f * (H - T - B) : T + (1 - f) * (H - T - B);
    };
    const clampY = (v) => Math.max(T, Math.min(H - B, y(v)));

    // Four gridlines with labels.
    const grid = [];
    for (let g = 0; g <= 3; g += 1) {
      const v = lo + ((hi - lo) * g) / 3;
      const gy = y(v);
      grid.push(`<line class="ph-chart__grid" x1="${L}" x2="${W - R}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" />
        <text class="ph-chart__axis" x="${L - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end">${esc(opts.fmtAxis(v))}</text>`);
    }

    let band = '';
    if (opts.band) {
      const top = [];
      const bot = [];
      points.forEach((p, i) => {
        if (!known(p.avgSec) || !known(p.spreadSec)) return;
        top.push(`${x(i).toFixed(1)},${clampY(p.avgSec - p.spreadSec).toFixed(1)}`);
        bot.unshift(`${x(i).toFixed(1)},${clampY(p.avgSec + p.spreadSec).toFixed(1)}`);
      });
      if (top.length > 1) band = `<polygon class="ph-chart__band" points="${top.concat(bot).join(' ')}" />`;
    }

    const lines = opts.series.map((s) => {
      const pts = points.map((p, i) => (known(p[s.key]) ? `${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}` : null)).filter(Boolean);
      return pts.length > 1 ? `<polyline class="ph-chart__line ph-chart__line--${s.cls}" points="${pts.join(' ')}" />` : '';
    }).join('');

    const colW = n > 1 ? (W - L - R) / (n - 1) : W - L - R;
    const every = Math.max(1, Math.ceil(n / 9));
    const marks = points.map((p, i) => {
      const cx = x(i).toFixed(1);
      const title = [
        `${shortDay(p.at)} · ${TYPE_NAME[p.type] || p.type || 'Session'} · ${p.laps} laps`,
        ...opts.series.map((s) => `${s.label}: ${known(p[s.key]) ? opts.fmtVal(p[s.key]) : dash}`),
        opts.band && known(p.spreadSec) ? `Spread ±${p.spreadSec.toFixed(2)} s` : '',
      ].filter(Boolean).join('\n');
      const dots = opts.series.map((s) => (known(p[s.key])
        ? `<circle class="ph-chart__dot ph-chart__dot--${s.cls}" cx="${cx}" cy="${y(p[s.key]).toFixed(1)}" r="${s.cls === 'a' ? 4 : 3.2}" />`
        : '')).join('');
      const label = i % every === 0 || i === n - 1
        ? `<text class="ph-chart__day" x="${cx}" y="${H - B + 16}" text-anchor="middle">${esc(shortDay(p.at))}</text>
           <text class="ph-chart__type" x="${cx}" y="${H - B + 30}" text-anchor="middle">${esc(TYPE_LETTER[p.type] || '')}</text>`
        : '';
      return `<g class="ph-chart__pt"><title>${esc(title)}</title>
        <rect class="ph-chart__hit" x="${(x(i) - colW / 2).toFixed(1)}" y="${T}" width="${colW.toFixed(1)}" height="${H - T - B}" />
        ${dots}${label}</g>`;
    }).join('');

    return `<svg class="ph-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(opts.aria)}">
      ${grid.join('')}${band}${lines}${marks}</svg>`;
  }

  function trendHtml(report, sel) {
    const pts = report.trend.filter((t) => t.laps > 0);
    if (!pts.length) return '<p class="ph-note">No timed laps here yet.</p>';
    if (sel === 'acc') {
      const accPts = pts.filter((t) => known(t.accuracy));
      if (accPts.length < 2) return `<p class="ph-note">Accuracy is scored on practice sessions — ${accPts.length ? 'one so far; the trend starts with the next.' : 'none here yet.'}</p>`;
      return lineChart(accPts, {
        series: [{ key: 'accuracy', cls: 'a', label: 'Accuracy' }],
        fmtAxis: (v) => String(Math.round(v)),
        fmtVal: (v) => `${Math.round(v)} / 100`,
        clamp: [0, 100],
        minPad: 3,
        aria: 'Accuracy score per practice session',
      }) + legend([{ cls: 'a', label: 'Session accuracy (0–100)' }]);
    }
    if (sel === 'ref') {
      const refPts = pts.filter((t) => known(t.refPct));
      return lineChart(refPts, {
        series: [{ key: 'refPct', cls: 'a', label: 'Best lap vs reference' }],
        invert: true,
        fmtAxis: (v) => `${v.toFixed(1)}%`,
        fmtVal: (v) => `${v.toFixed(1)}%`,
        minPad: 0.3,
        aria: 'Best lap as a percentage of the reference pace, per session',
      }) + legend([{ cls: 'a', label: 'Best lap, % of reference pace (lower is quicker) · times: Ohne Speed' }]);
    }
    const lapPts = pts.filter((t) => known(t.bestSec) || known(t.avgSec));
    return lineChart(lapPts, {
      series: [
        { key: 'bestSec', cls: 'a', label: 'Best' },
        { key: 'avgSec', cls: 'b', label: 'Average' },
      ],
      band: true,
      invert: true,
      fmtAxis: (v) => lapText(v, 1),
      fmtVal: (v) => lapText(v),
      minPad: 0.2,
      aria: 'Best and average clean lap per session',
    }) + legend([
      { cls: 'a', label: 'Best clean lap' },
      { cls: 'b', label: 'Average clean lap' },
      { cls: 'band', label: '± spread' },
    ]);
  }

  function legend(items) {
    return `<div class="ph-legend">${items.map((it) => `<span><i class="ph-key ph-key--${it.cls}"></i>${esc(it.label)}</span>`).join('')}</div>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  Corner strip                                                          */
  /* ---------------------------------------------------------------------- */

  /** "40 laps" (the corners' own scope, which the fallback limits to one session). */
  function cornerLapsText(report) {
    const n = Math.max(0, ...(report.corners || []).map((c) => c.laps || 0));
    if (!n) return '';
    return report.cornerSource === 'catalog' ? `${n} clean laps` : `${n} clean laps · latest session`;
  }

  function cornersHtml(report) {
    const cs = report.corners || [];
    if (!cs.length) {
      return `<p class="ph-note">${esc(report.cornerNote || 'No corners to measure here yet.')}</p>`;
    }
    const spreads = cs.map((c) => c.brakeSpreadM).filter(known);
    const top = Math.max(20, ...spreads);
    const losses = cs.map((c) => c.avgLossSec).filter(known);
    const lossTop = Math.max(0.05, ...losses);
    const tone = (m) => (m >= 12 ? 'bad' : m >= 7 ? 'warn' : 'ok');
    // Le Mans has 20–25 corners: drop the leading zero so a column stays narrow.
    const dense = cs.length > 14;
    const lossText = (v) => (dense && Math.abs(v) < 1 ? v.toFixed(2).replace(/^(-?)0\./, '$1.') : v.toFixed(2));
    const cols = cs.map((c) => {
      const has = known(c.brakeSpreadM);
      const h = has ? Math.max(6, Math.round((c.brakeSpreadM / top) * 100)) : 0;
      const a = known(c.avgLossSec) ? Math.min(1, c.avgLossSec / lossTop) : 0;
      const title = [
        c.id,
        has ? `Braking point varies ±${Math.round(c.brakeSpreadM)} m` : 'No braking point (a lift or flat)',
        known(c.minKphSpread) ? `Minimum speed varies ±${c.minKphSpread.toFixed(1)} km/h` : '',
        known(c.avgLossSec) ? `${c.avgLossSec.toFixed(2)} s a lap vs your best pass` : '',
        `${c.laps} laps`,
        c.habit || '',
      ].filter(Boolean).join('\n');
      return `<div class="ph-cs__col${c.habit ? ' ph-cs__col--habit' : ''}" title="${esc(title)}">
        <span class="ph-cs__val">${has ? `±${Math.round(c.brakeSpreadM)}` : dash}</span>
        <span class="ph-cs__bar">${has ? `<i class="ph-cs__fill" data-tone="${tone(c.brakeSpreadM)}" style="height:${h}%"></i>` : '<i class="ph-cs__none"></i>'}</span>
        <span class="ph-cs__id">${esc(c.id)}${c.habit ? '<b class="ph-cs__dot" aria-label="habit"></b>' : ''}</span>
        <span class="ph-cs__loss" style="--a:${a.toFixed(2)}">${known(c.avgLossSec) ? lossText(c.avgLossSec) : dash}</span>
      </div>`;
    }).join('');
    return `
      <div class="ph-cs${dense ? ' ph-cs--dense' : ''}" role="list" aria-label="Braking-point spread per corner">${cols}</div>
      <div class="ph-cs__axis"><span>Braking-point spread, metres (lower is steadier)</span><span>Bottom row: seconds a lap vs your best pass</span></div>
      ${report.cornerNote ? `<p class="ph-note ph-note--small">${esc(report.cornerNote)}</p>` : ''}`;
  }

  /* ---------------------------------------------------------------------- */
  /*  Habit cards                                                           */
  /* ---------------------------------------------------------------------- */

  function spark(series) {
    const v = (series || []).filter(known);
    if (v.length < 2) return '';
    const W = 120;
    const H = 30;
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    const span = hi - lo || 1;
    const pts = v.map((x, i) => `${((i / (v.length - 1)) * (W - 4) + 2).toFixed(1)},${(H - 3 - ((x - lo) / span) * (H - 6)).toFixed(1)}`);
    const lastPt = pts[pts.length - 1].split(',');
    return `<svg class="ph-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <polyline points="${pts.join(' ')}" /><circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="2.6" /></svg>`;
  }

  const CORNER_TITLE = {
    brakeEarly: 'Braking early',
    lateNoSpeed: 'Late braking not paying',
    slowMin: 'Corner speed',
    brakeWanders: 'Braking point wanders',
  };

  /** Three to five cards: what to work on first, then a corner or two, then strengths. */
  function pickCards(report) {
    const facts = new Map((report.facts || []).map((f) => [f.id, f]));
    const lap = report.lap || [];
    const corner = (report.corners || [])
      .filter((c) => c.habit)
      .sort((a, b) => (b.avgLossSec || 0) - (a.avgLossSec || 0))
      .slice(0, 2)
      .map((c) => {
        const f = facts.get(`corner.${c.id}.habit`);
        return {
          title: `${c.id} · ${CORNER_TITLE[c.habitKind] || 'Habit'}`,
          big: f ? factText(f) : dash,
          text: c.habit,
          level: 'watch',
          chip: known(c.avgLossSec) ? `≈${c.avgLossSec.toFixed(2)} s a lap` : '',
          spark: null,
        };
      });
    const toCard = (l) => ({
      title: l.title || l.kind,
      big: factText({ value: l.value, unit: l.unit, kind: l.kind }),
      text: l.text,
      level: l.level || 'info',
      chip: '',
      spark: l.perSession,
    });
    const watch = lap.filter((l) => l.level === 'watch').map(toCard);
    const rest = lap.filter((l) => l.level !== 'watch').map(toCard);
    return [...watch.slice(0, 2), ...corner, ...watch.slice(2), ...rest].slice(0, 5);
  }

  function cardsHtml(report) {
    const cards = pickCards(report);
    if (!cards.length) {
      return `<p class="ph-note">Drive a few clean laps here and your habits will show up.</p>`;
    }
    const LEVEL = { watch: 'Work on', info: 'Habit', good: 'Strength' };
    return `<div class="ph-cards">${cards.map((c) => `
      <article class="ph-hcard" data-level="${esc(c.level)}">
        <div class="ph-hcard__top">
          <span class="ph-hcard__title">${esc(c.title)}</span>
          <span class="ph-hcard__level">${esc(LEVEL[c.level] || '')}</span>
        </div>
        <div class="ph-hcard__mid">
          <span class="ph-hcard__big">${esc(c.big)}</span>
          ${c.spark ? spark(c.spark) : ''}
        </div>
        <p class="ph-hcard__text">${esc(c.text)}</p>
        ${c.chip ? `<span class="ph-hcard__chip">${esc(c.chip)}</span>` : ''}
      </article>`).join('')}</div>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  AI summary (optional)                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * The AI cites facts by id and never types a number; fill any placeholder
   * it left (`{id}`, `{{id}}`, `[[id]]`) from the facts, and show the cited
   * facts' values as chips.
   */
  function fillFacts(text, facts) {
    return String(text || '').replace(/\{\{([\w.-]+)\}\}|\[\[([\w.-]+)\]\]|\{([\w.-]+)\}/g, (m, a, b, c) => {
      const f = facts.get(a || b || c);
      return f ? factText(f) : m;
    });
  }

  function aiHtml(ai, report) {
    const facts = new Map((report.facts || []).map((f) => [f.id, f]));
    const tks = Array.isArray(ai.takeaways) ? ai.takeaways.slice(0, 3) : [];
    return `
      <div class="ph-ai__head"><span class="ph-ai__badge">AI coach</span>
        <span class="ph-ai__headline">${esc(fillFacts(ai.headline, facts))}</span></div>
      ${tks.length ? `<ol class="ph-ai__list">${tks.map((t) => {
        const chips = (t.factIds || []).map((id) => facts.get(id)).filter(Boolean).slice(0, 3);
        return `<li><b>${esc(fillFacts(t.title, facts))}</b> ${esc(fillFacts(t.body, facts))}
          ${chips.map((f) => `<span class="ph-ai__chip" title="${esc(f.text)}">${esc(factText(f))}</span>`).join('')}</li>`;
      }).join('')}</ol>` : ''}`;
  }

  async function loadAi(root, report, isCurrent) {
    const slot = root.querySelector('.ph-ai');
    if (!slot) return;
    const apex = window.apex;
    if (!apex || typeof apex.coachAi !== 'function' || !(report.facts || []).length) return;
    slot.hidden = false;
    slot.innerHTML = '<p class="ph-note ph-note--small">Your coach is reading these numbers…</p>';
    let res = null;
    try {
      res = await apex.coachAi({ kind: 'habits', inputHash: report.inputHash, context: report.context, facts: report.facts });
    } catch {
      res = null;
    }
    if (!isCurrent()) return;
    if (!res || !res.ok || !res.ai || !res.ai.headline) {
      slot.hidden = true;
      slot.innerHTML = '';
      return;
    }
    slot.innerHTML = aiHtml(res.ai, report);
  }

  /* ---------------------------------------------------------------------- */
  /*  The view                                                              */
  /* ---------------------------------------------------------------------- */

  function viewHtml(report, sel) {
    const t = trendTabs(report, sel);
    const scope = [
      report.track || report.trackKey,
      report.carClass,
      `${report.sessions} session${report.sessions === 1 ? '' : 's'}`,
      `${report.laps} laps`,
    ].filter(Boolean).map(esc).join(' · ');
    return `
      <section class="ph">
        <header class="ph__head">
          <h3 class="ph__title">Your driving</h3>
          <span class="ph__scope">${scope}</span>
        </header>
        <div class="ph-ai" hidden></div>
        <div class="ph__grid">
          <section class="ph-card ph-trend">
            <div class="ph-card__head">
              <span class="ph-card__title">Session by session</span>
              <div class="ph-tabs" role="tablist">${t.tabs.map((x) => `
                <button type="button" class="ph-tab" role="tab" data-phtab="${x.id}" aria-selected="${x.id === t.sel}">${esc(x.label)}</button>`).join('')}
              </div>
            </div>
            <div class="ph-trend__body">${trendHtml(report, t.sel)}</div>
          </section>
          <section class="ph-card ph-corners">
            <div class="ph-card__head">
              <span class="ph-card__title">Corner consistency</span>
              <span class="ph-card__sub">${esc(cornerLapsText(report))}</span>
            </div>
            ${cornersHtml(report)}
          </section>
        </div>
        <section class="ph-card ph-habits">
          <div class="ph-card__head"><span class="ph-card__title">Your habits</span>
            <span class="ph-card__sub">Valid, dry laps within 7% of each session's best</span></div>
          ${cardsHtml(report)}
        </section>
      </section>`;
  }

  function wire(root, report) {
    root.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-phtab]') : null;
      if (!btn || !root.contains(btn)) return;
      const id = btn.getAttribute('data-phtab');
      saveTab(id);
      root.querySelectorAll('[data-phtab]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      const body = root.querySelector('.ph-trend__body');
      if (body) body.innerHTML = trendHtml(report, id);
    });
  }

  /**
   * Draw "Your driving" for a track and class into `el`. Resolves when it is
   * painted (or quietly hidden); the AI summary, if any, fills in afterwards.
   */
  async function render(el, args) {
    if (!el) return;
    const token = ++tokenSeq;
    tokens.set(el, token);
    const isCurrent = () => tokens.get(el) === token;
    const trackKey = args && typeof args.trackKey === 'string' ? args.trackKey : '';
    const carClass = args && typeof args.carClass === 'string' ? args.carClass : '';
    const apex = window.apex;
    if (!trackKey || !apex || typeof apex.practiceHabits !== 'function') {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = `<section class="ph ph--loading"><header class="ph__head"><h3 class="ph__title">Your driving</h3>
      <span class="ph__scope">Reading your laps here…</span></header></section>`;
    let res = null;
    try {
      res = await apex.practiceHabits({ trackKey, carClass });
    } catch {
      res = null;
    }
    if (!isCurrent()) return;
    const report = res && res.ok ? res.report : null;
    if (!report || !Array.isArray(report.trend)) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    // A fresh element per paint, so a listener from an older report never
    // answers a click on this one.
    const root = document.createElement('div');
    root.className = 'ph-root';
    root.innerHTML = viewHtml(report, readTab());
    wire(root, report);
    el.innerHTML = '';
    el.appendChild(root);
    loadAi(root, report, isCurrent);
  }

  window.PracticeHabits = { render };
})();
