/**
 * review-charts.js — the Review tab's two canvas painters.
 * -----------------------------------------------------------------------------
 * Split out of review-panel.js for the same reason team-charts.js is split out
 * of team-panel.js: this file touches no element ids, holds no state and knows
 * nothing about the page — it is handed a canvas and a session and paints.
 *
 *   drawLapChart(canvas, session, fmt) — every lap of a session in order, with
 *     the stints marked and the best-lap rule drawn across it. Returns the hit
 *     map (`[{lap, px, py}]`) the panel's tooltip and click handler use, so the
 *     geometry is stated once, by the code that laid it out.
 *   drawTrend(canvas, trend, markDay, fmt) — the 30 days behind the session.
 *
 * Both are DPR-aware and re-measure their CSS box on every call. Neither
 * formats anything itself: `fmt` carries the panel's own `fmtLap` and
 * `dayLabel` in, so a lap time is printed identically here and in the sheet
 * beside it rather than by two functions that can drift apart.
 *
 * No library, as everywhere else in the panel — the CSP forbids one and two
 * line charts do not need one.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_REVIEW_CHARTS = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);


  /** Prepare a canvas at device resolution; returns `{ctx, w, h}` in CSS px. */
  function surface(canvas) {
    // Guarded rather than read straight off `window`: this module is pure and
    // is require()d by its test in plain Node, where there is no window.
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const box = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width));
    const h = Math.max(1, Math.round(box.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  const CSS = {
    line: '#1d2536', line2: '#2a3448', text3: '#66708a', text2: '#9aa4b8',
    cyan: '#26bbf4', best: '#b388ff', warn: '#ffb020', ok: '#35d07f',
  };

  /**
   * The session's lap times, in order, with the stints marked.
   *
   * The y-scale is set by the CLEAN laps alone and everything else is clamped
   * to the edge of it. That is the whole reason this chart is readable: one
   * 3-minute out-lap on a 1:46 circuit would otherwise squash every real lap
   * into the top eighth of the box, which is exactly the shape that makes a
   * lap-time chart useless. A clamped lap is drawn hollow, at the boundary,
   * so it is visibly off the scale rather than quietly misplaced.
   */
  function drawLapChart(canvas, session, fmt) {
    const { ctx, w, h } = surface(canvas);
    const laps = [];
    for (const stint of session.stints) for (const lap of stint.laps) laps.push(lap);
    if (!laps.length) return [];

    const padL = 54;
    const padR = 10;
    const padT = 16;
    const padB = 18;
    const plotW = Math.max(1, w - padL - padR);
    const plotH = Math.max(1, h - padT - padB);

    const clean = laps.filter((l) => l.clean && l.timed).map((l) => l.lapMs);
    const pool = clean.length >= 2 ? clean : laps.filter((l) => l.timed).map((l) => l.lapMs);
    if (!pool.length) return [];
    let lo = Math.min(...pool);
    let hi = Math.max(...pool);
    // A flat session (one lap, or a metronome) still needs a box to draw in.
    if (hi - lo < 400) { lo -= 400; hi += 400; }
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;

    const x = (i) => padL + (laps.length === 1 ? plotW / 2 : (i / (laps.length - 1)) * plotW);
    const y = (ms) => padT + (1 - (Math.min(hi, Math.max(lo, ms)) - lo) / (hi - lo)) * plotH;

    // Gridlines, labelled in lap time — the only axis anyone reads here.
    ctx.font = '10px "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const ms = lo + ((hi - lo) * i) / 3;
      const py = Math.round(y(ms)) + 0.5;
      ctx.strokeStyle = CSS.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(w - padR, py);
      ctx.stroke();
      ctx.fillStyle = CSS.text3;
      ctx.fillText(fmt.fmtLap(ms), padL - 8, py);
    }

    // Stint boundaries: a dashed rule and the stint's number at the top.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let idx = 0;
    for (const stint of session.stints) {
      if (idx > 0) {
        const px = Math.round(x(idx - 0.5)) + 0.5;
        ctx.strokeStyle = CSS.line2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(px, padT - 8);
        ctx.lineTo(px, h - padB);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = CSS.text3;
      ctx.font = '9px Bahnschrift, "Segoe UI", sans-serif';
      ctx.fillText(`S${stint.no}`, x(idx) + 3, 2);
      idx += stint.laps.length;
    }

    // The best-lap rule, so every point can be read as a gap to it by eye.
    if (isNum(session.stats.bestMs)) {
      const py = Math.round(y(session.stats.bestMs)) + 0.5;
      ctx.strokeStyle = 'rgba(179, 136, 255, 0.45)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(w - padR, py);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The line: broken at every stint boundary, because a pit stop is not a
    // lap-to-lap change and joining across it draws a slope nobody drove.
    ctx.strokeStyle = 'rgba(38, 187, 244, 0.75)';
    ctx.lineWidth = 1.5;
    let i = 0;
    for (const stint of session.stints) {
      let started = false;
      ctx.beginPath();
      for (const lap of stint.laps) {
        if (lap.timed && lap.clean) {
          const px = x(i);
          const py = y(lap.lapMs);
          if (started) ctx.lineTo(px, py);
          else { ctx.moveTo(px, py); started = true; }
        }
        i++;
      }
      if (started) ctx.stroke();
    }

    // The points, and the hit map the tooltip and the click handler use.
    const hits = [];
    laps.forEach((lap, n) => {
      const px = x(n);
      const py = y(lap.timed ? lap.lapMs : hi);
      const off = lap.timed && (lap.lapMs > hi || lap.lapMs < lo);
      const isBest = isNum(session.stats.bestMs) && lap.clean && lap.lapMs === session.stats.bestMs;
      hits.push({ lap, px, py });
      ctx.beginPath();
      ctx.arc(px, py, isBest ? 4 : 3, 0, Math.PI * 2);
      if (!lap.timed) {
        ctx.fillStyle = CSS.line2;
        ctx.fill();
      } else if (off || !lap.clean) {
        ctx.strokeStyle = lap.clean ? CSS.text3 : CSS.warn;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      } else {
        ctx.fillStyle = isBest ? CSS.best : CSS.cyan;
        ctx.fill();
      }
    });
    return hits;
  }

  /**
   * The 30 days behind this session — one point per day driven at this track in
   * this class, the day's best. Days with no lap are simply absent rather than
   * drawn as a zero, so the line reads as form rather than as attendance.
   */
  function drawTrend(canvas, trend, markDay, fmt) {
    const { ctx, w, h } = surface(canvas);
    if (!trend.length) return;
    const padL = 54;
    const padR = 10;
    const padT = 10;
    const padB = 14;
    const plotW = Math.max(1, w - padL - padR);
    const plotH = Math.max(1, h - padT - padB);

    const times = trend.map((p) => p.bestMs);
    let lo = Math.min(...times);
    let hi = Math.max(...times);
    if (hi - lo < 400) { lo -= 400; hi += 400; }
    const pad = (hi - lo) * 0.18;
    lo -= pad;
    hi += pad;

    const days = trend.map((p) => Date.parse(`${p.day}T00:00:00Z`));
    const first = days[0];
    const last = days[days.length - 1];
    const span = Math.max(1, last - first);
    const x = (ms) => padL + (trend.length === 1 ? plotW / 2 : ((ms - first) / span) * plotW);
    const y = (ms) => padT + (1 - (ms - lo) / (hi - lo)) * plotH;

    ctx.font = '10px "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const ms of [hi - pad, lo + pad]) {
      const py = Math.round(y(ms)) + 0.5;
      ctx.strokeStyle = CSS.line;
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(w - padR, py);
      ctx.stroke();
      ctx.fillStyle = CSS.text3;
      ctx.fillText(fmt.fmtLap(ms), padL - 8, py);
    }

    ctx.strokeStyle = 'rgba(38, 187, 244, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    trend.forEach((p, i) => {
      const px = x(days[i]);
      const py = y(p.bestMs);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.stroke();

    trend.forEach((p, i) => {
      const here = p.day === markDay;
      ctx.beginPath();
      ctx.arc(x(days[i]), y(p.bestMs), here ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = here ? CSS.best : CSS.cyan;
      ctx.fill();
    });

    ctx.fillStyle = CSS.text3;
    ctx.font = '9px Bahnschrift, "Segoe UI", sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(fmt.dayLabel(trend[0].day).toUpperCase(), padL, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText(fmt.dayLabel(trend[trend.length - 1].day).toUpperCase(), w - padR, h - 2);
  }

  return { drawLapChart, drawTrend };
});
