/**
 * review-coach.js — the Review tab's Coach sub-tab, as markup.
 * -----------------------------------------------------------------------------
 * 2026-10-29, the driving coach (BETA). Review's session page gains a Coach
 * tab for a race or qualifying session: one lap against the reference the
 * driver chose on Compare, read by the coach —
 *
 *   - the CoachReport (scope 'lap'): a headline, up to three takeaways, the
 *     corners worth working on with the phase the time sits in and a tip;
 *   - the breakdown: every corner's loss split by phase (braking, turn-in,
 *     mid-corner, exit, exit run) as a small stacked bar, with the part of the
 *     exit run the coach put down to a tow or the car greyed out as "tow/car,
 *     not you";
 *   - "Show me" (show-me.js), stepping the map and the charts through the
 *     worst corners.
 *
 * Split out of review-panel.js the way review-charts.js is: this file holds
 * no state and touches no element — it is handed numbers and returns HTML —
 * so it can be require()d by its test in plain Node. The panel owns the
 * loading, the canvases and the clicks.
 *
 * The gate lives here too, so the test can pin it: the tab is BETA. It shows
 * only to a driver following the beta channel (control-panel.js pushes that
 * signal, the one the Practice tab is gated on), only once the build has the
 * coach's IPC (`apex.reviewCoach` — the renderer must cope with it missing),
 * and only for a race or qualifying session (practice has its own coach on
 * the Practice tab).
 *
 * Units are the contract's (src/telemetry/coachContract.ts): seconds, and
 * positive means LOSING.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_REVIEW_COACH = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const PHASES = ['braking', 'turnIn', 'midCorner', 'exit', 'exitRun'];
  const PHASE_LABEL = {
    braking: 'Braking', turnIn: 'Turn-in', midCorner: 'Mid-corner', exit: 'Exit', exitRun: 'Exit run',
  };

  /* ---------------------------------------------------------------------- */
  /*  The gate                                                              */
  /* ---------------------------------------------------------------------- */

  /** Race or qualifying, by the same reading of `sessionType` the list uses. */
  function coachableType(sessionType) {
    const k = String(sessionType || '').toLowerCase();
    return k.startsWith('race') || k.startsWith('qual');
  }

  /**
   * Whether the Coach tab exists for this driver and this session.
   * `{ followingBeta, hasApi, sessionType }` — all three, or no tab.
   */
  function allowed(ctx) {
    const c = ctx || {};
    return !!c.followingBeta && !!c.hasApi && coachableType(c.sessionType);
  }

  /** A tab list with the coach's tabs (`coach: true`) taken out unless allowed. */
  function filterTabs(tabs, ctx) {
    const ok = allowed(ctx);
    return (Array.isArray(tabs) ? tabs : []).filter((t) => !t.coach || ok);
  }

  /* ---------------------------------------------------------------------- */
  /*  Numbers                                                               */
  /* ---------------------------------------------------------------------- */

  /** `+0.42 s` lost, `−0.10 s` gained, `0.00 s` level. */
  function fmtLoss(sec, dp = 2) {
    if (!isNum(sec)) return '—';
    const v = Math.abs(sec) < 0.5 * 10 ** -dp ? 0 : sec;
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    return `${sign}${Math.abs(v).toFixed(dp)} s`;
  }

  const toneOf = (sec) => (!isNum(sec) || Math.abs(sec) < 0.01 ? 'level' : sec > 0 ? 'loss' : 'gain');

  /* ---------------------------------------------------------------------- */
  /*  The report                                                            */
  /* ---------------------------------------------------------------------- */

  function takeawaysHtml(report) {
    const list = Array.isArray(report.takeaways) ? report.takeaways.slice(0, 3) : [];
    if (!list.length) return '';
    return `<div class="rvc-takeaways">${list.map((t) => `
      <article class="rvc-take" data-tone="${esc(t.tone || 'loss')}">
        <header>
          <b>${esc(t.title)}</b>
          ${t.chip ? `<span class="rvc-chip" data-tone="${esc(t.tone || 'loss')}">${esc(t.chip)}</span>` : ''}
        </header>
        <p>${esc(t.body)}</p>
        ${Array.isArray(t.cornerIds) && t.cornerIds.length
          ? `<footer>${t.cornerIds.map((id) => `<button type="button" class="rvc-corner" data-coachcorner="${esc(id)}">${esc(id)}</button>`).join('')}</footer>`
          : ''}
      </article>`).join('')}</div>`;
  }

  function worstHtml(report) {
    const list = Array.isArray(report.worst) ? report.worst : [];
    if (!list.length) return '<p class="rv-card__note">No corner stands out — this lap is level with the reference all the way round.</p>';
    return `<ol class="rvc-worst">${list.map((c) => `
      <li data-priority="${esc(c.priority || 'low')}">
        <button type="button" class="rvc-worst__row" data-coachcorner="${esc(c.id)}" title="Show ${esc(c.id)} on the map">
          <span class="rvc-worst__id">${esc(c.id)}</span>
          <span class="rvc-worst__loss" data-tone="${toneOf(c.lossSec)}">${esc(fmtLoss(c.lossSec))}</span>
          <span class="rvc-worst__phase">${esc(PHASE_LABEL[c.phase] || c.phase || '')}</span>
          <span class="rvc-pri">${esc(c.priority || '')}</span>
        </button>
        ${c.tip ? `<p class="rvc-worst__tip">${esc(c.tip)}</p>` : ''}
      </li>`).join('')}</ol>`;
  }

  /**
   * The report's half of the tab: headline, takeaways, the worst corners.
   * `ctx` names the two laps for the line under the headline.
   */
  function reportHtml(report, ctx) {
    const c = ctx || {};
    if (!report) return '';
    const fair = Array.isArray(report.fairness) ? report.fairness.filter((f) => f && f.severity !== 'info') : [];
    return `
      <section class="rv-card rvx-card rvc-report">
        <div class="rvx-card__head">
          <h3>Coach</h3>
          <span class="rvc-beta" title="A beta feature: only drivers following the beta channel see it">Beta</span>
          ${report.source === 'ai' ? '<span class="rvc-src">AI</span>' : ''}
          ${c.vsLine ? `<span class="rvc-vs">${c.vsLine}</span>` : ''}
        </div>
        <p class="rvc-headline">${esc(report.headline)}</p>
        ${fair.length ? `<div class="rvc-fair">${fair.map((f) => `<span class="rvc-chip" data-tone="warn" title="${esc(f.text)}">${esc(f.text)}</span>`).join('')}</div>` : ''}
        ${takeawaysHtml(report)}
      </section>
      <section class="rv-card rvx-card rvc-where">
        <div class="rvx-card__head"><h3>Where the time goes</h3></div>
        ${worstHtml(report)}
      </section>`;
  }

  /* ---------------------------------------------------------------------- */
  /*  The breakdown                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * One corner's phases as signed segments, in road order, with the exit
   * run's tow/car share split off. `{ key, sec, notYou }`: `notYou` is the
   * part of a LOSS on the exit run that the coach put down to a tow or the
   * car ({@link CornerPhaseLoss.straightFlag}), drawn grey and left out of
   * what the driver is told to fix.
   */
  function segmentsOf(corner) {
    const out = [];
    const ph = corner && corner.phases ? corner.phases : {};
    for (const key of PHASES) {
      const v = isNum(ph[key]) ? ph[key] : 0;
      if (key === 'exitRun' && corner.straightFlag && isNum(corner.straightSec) && corner.straightSec > 0 && v > 0) {
        const grey = Math.min(v, corner.straightSec);
        if (v - grey > 0) out.push({ key, sec: v - grey, notYou: false });
        out.push({ key, sec: grey, notYou: true });
        continue;
      }
      if (v !== 0) out.push({ key, sec: v, notYou: false });
    }
    return out;
  }

  /** The largest stack either side of zero, across every corner: one scale for the table. */
  function scaleOf(corners) {
    let m = 0;
    for (const c of corners) {
      let pos = 0;
      let neg = 0;
      for (const s of segmentsOf(c)) { if (s.sec > 0) pos += s.sec; else neg -= s.sec; }
      m = Math.max(m, pos, neg);
    }
    return m > 0 ? m : 0.1;
  }

  /**
   * A diverging stacked bar: losses right of the axis, gains left, one
   * segment per phase in the phase's colour, the tow/car share hatched grey.
   */
  function barHtml(corner, scale) {
    const segs = segmentsOf(corner);
    const seg = (s) => {
      const w = Math.max(0, Math.min(100, (Math.abs(s.sec) / scale) * 100));
      const name = s.notYou ? `${PHASE_LABEL[s.key]}: ${fmtLoss(s.sec)} tow/car, not you` : `${PHASE_LABEL[s.key]}: ${fmtLoss(s.sec)}`;
      return `<i class="rvc-seg" data-phase="${s.key}"${s.notYou ? ' data-notyou="true"' : ''} style="width:${w.toFixed(2)}%" title="${esc(name)}"></i>`;
    };
    const neg = segs.filter((s) => s.sec < 0).reverse();
    const pos = segs.filter((s) => s.sec > 0);
    return `<span class="rvc-bar" aria-hidden="true"><span class="rvc-bar__neg">${neg.map(seg).join('')}</span><span class="rvc-bar__pos">${pos.map(seg).join('')}</span></span>`;
  }

  /** The phase most of a corner's (driver's) loss sits in, or null. */
  function mainPhase(corner) {
    let best = null;
    for (const s of segmentsOf(corner)) {
      if (s.notYou || s.sec <= 0) continue;
      if (!best || s.sec > best.sec) best = s;
    }
    return best ? best.key : null;
  }

  function legendHtml() {
    return `<div class="rvc-legend">${PHASES.map((k) => `<span><i class="rvc-seg" data-phase="${k}"></i>${PHASE_LABEL[k]}</span>`).join('')}
      <span><i class="rvc-seg" data-notyou="true"></i>Tow/car, not you</span>
      <span class="rvc-legend__axis">gained ◂ │ ▸ lost</span></div>`;
  }

  /**
   * The per-corner table. `stepCorners` is the set of corners "Show me" has a
   * step for: those rows are buttons that jump the step-through there.
   */
  function breakdownHtml(breakdown, stepCorners) {
    if (!breakdown || !Array.isArray(breakdown.corners) || !breakdown.corners.length) {
      return `
        <section class="rv-card rvx-card rvc-break">
          <div class="rvx-card__head"><h3>Corner by corner</h3></div>
          <p class="rv-card__note">No corner breakdown for this pair of laps.</p>
        </section>`;
    }
    const steps = stepCorners instanceof Set ? stepCorners : new Set(stepCorners || []);
    const corners = breakdown.corners;
    const scale = scaleOf(corners);
    const rows = corners.map((c) => {
      const notYou = c.straightFlag && isNum(c.straightSec) && c.straightSec > 0;
      const yours = notYou ? c.lossSec - c.straightSec : c.lossSec;
      // "Mostly" names where a LOSS sits; a corner gained overall has none.
      const main = isNum(yours) && yours > 0.01 ? mainPhase(c) : null;
      return `
        <tr data-coachcorner="${esc(c.id)}"${steps.has(c.id) ? ' data-step="true" tabindex="0"' : ''}>
          <th scope="row">${esc(c.id)}</th>
          <td class="rvc-num" data-tone="${toneOf(yours)}">${esc(fmtLoss(yours))}</td>
          <td class="rvc-barcell">${barHtml(c, scale)}</td>
          <td class="rvc-main">${main ? esc(PHASE_LABEL[main]) : ''}${notYou
            ? `<span class="rvc-notyou" title="Time that grew along the straight at equal throttle and no worse exit: ${c.straightFlag === 'tow' ? 'a tow' : 'the car'}, not your driving">+${esc(c.straightSec.toFixed(2))} s ${c.straightFlag}, not you</span>`
            : ''}</td>
        </tr>`;
    }).join('');
    const seqs = Array.isArray(breakdown.sequences) ? breakdown.sequences.filter((s) => s && s.cornerIds && s.cornerIds.length > 1) : [];
    const SEQ = { trade: 'traded time between them', carry: 'one loss carried through', linked: 'one piece of road' };
    return `
      <section class="rv-card rvx-card rvc-break">
        <div class="rvx-card__head"><h3>Corner by corner</h3>${legendHtml()}</div>
        <table class="rvc-table">
          <thead><tr><th>Corner</th><th class="rvc-num">You</th><th>Where, by phase</th><th>Mostly</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="rvc-foot">
          ${isNum(breakdown.leadInSec) ? `<span>Start of lap ${esc(fmtLoss(breakdown.leadInSec))}</span>` : ''}
          ${isNum(breakdown.totalSec) ? `<span>Total ${esc(fmtLoss(breakdown.totalSec))}</span>` : ''}
          ${isNum(breakdown.residualSec) && Math.abs(breakdown.residualSec) >= 0.005
            ? `<span title="The official lap time against the trace's own clock">Timing vs trace ${esc(fmtLoss(breakdown.residualSec))}</span>` : ''}
          ${seqs.map((s) => `<span class="rvc-seq">${esc(s.cornerIds.join('–'))}: ${esc(fmtLoss(s.lossSec))}, ${esc(SEQ[s.kind] || s.kind)}</span>`).join('')}
        </p>
      </section>`;
  }

  return {
    PHASES, PHASE_LABEL,
    coachableType, allowed, filterTabs,
    fmtLoss, segmentsOf, mainPhase,
    reportHtml, breakdownHtml,
  };
});
