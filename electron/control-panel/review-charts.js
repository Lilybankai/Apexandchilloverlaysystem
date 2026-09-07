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
    bad: '#ff5470',
    // The comparison lap. Violet rather than a second bright colour: it has to
    // be legible under the studied lap without ever competing with it.
    compare: '#8b7dff',
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

  /* ======================================================================== */
  /*  Phase 2 — one lap, and phase 3 — two                                    */
  /* ======================================================================== */

  /** The window a view is showing, defaulted and sanitised. `[from, to]`, 0..1. */
  function windowOf(o) {
    const win = o && Array.isArray(o.window) ? o.window : null;
    let a = win && isNum(win[0]) ? win[0] : 0;
    let b = win && isNum(win[1]) ? win[1] : 1;
    a = Math.min(1, Math.max(0, a));
    b = Math.min(1, Math.max(0, b));
    // A window narrower than a thousandth of a lap is a couple of samples of
    // road: past that the charts are drawing straight lines between two points
    // and the zoom has stopped adding information.
    if (b - a < 0.001) b = Math.min(1, a + 0.001);
    return [a, b];
  }

  /**
   * The lap's channels, stacked, on ONE canvas.
   *
   * One canvas rather than four, and that is the whole design: the scrub cursor
   * has to cross every band at the same distance, and four canvases means four
   * repaints, four hit tests and four chances for the bands to disagree about
   * where 62% of the lap is. Stacked here, the cursor is one line.
   *
   * `bands` says what to draw; each carries its own scale, so a percentage and
   * a speed are never plotted against the same axis. Returns the geometry the
   * panel needs to place its cursor and read a mouse position back into a lap
   * distance — stated once, by the code that laid it out.
   *
   * Three things arrive through `opts` and change what is drawn:
   *
   *   `window` — the stretch of lap on screen, `[from, to]` as fractions. Every
   *     band shares it, and an AUTO-ranged band re-measures its y axis over the
   *     window alone. That second part is what makes zooming worth doing: a
   *     40 km/h swing through one corner is a flat line on an axis scaled to a
   *     300 km/h straight, and reading a corner is the whole reason to zoom in.
   *   `vs` — a second lap's columns, drawn UNDER the first in a muted violet on
   *     any band that asked for company.
   *   `delta` — the running gap between the two, which is not a channel of
   *     either lap and so arrives as its own `{d, dt}` pair.
   */
  function drawChannels(canvas, trace, bands, opts) {
    const { ctx, w, h } = surface(canvas);
    const d = trace.d || [];
    if (d.length < 2 || !bands.length) return null;

    const o = opts || {};
    const [wFrom, wTo] = windowOf(o);
    const wSpan = wTo - wFrom;
    const padL = 46;
    const padR = 8;
    const padT = 4;
    const padB = 16;
    const gap = 8;
    const x0 = padL;
    const x1 = w - padR;
    const plotW = Math.max(1, x1 - x0);
    const drawable = bands.filter((b) => b.from !== 'delta' || (o.delta && o.delta.d.length > 1));
    if (!drawable.length) return null;
    const total = drawable.reduce((a, b) => a + (b.weight || 1), 0);
    const usable = Math.max(1, h - padT - padB - gap * (drawable.length - 1));

    const px = (dd) => x0 + ((dd - wFrom) / wSpan) * plotW;
    const inWindow = (dd) => dd >= wFrom && dd <= wTo;

    const out = { x0, x1, bands: [], window: [wFrom, wTo] };
    let y = padT;

    for (const band of drawable) {
      const src = band.from === 'delta' ? o.delta : trace;
      const dcol = band.from === 'delta' ? o.delta.d : d;
      const bh = (usable * (band.weight || 1)) / total;
      const y0 = y;
      const y1 = y + bh;
      out.bands.push({ y0, y1, label: band.label });

      // Each band sits on its own faint plate, so a glance separates them
      // without a border per band shouting for attention.
      ctx.fillStyle = 'rgba(255,255,255,0.014)';
      ctx.fillRect(x0, y0, plotW, bh);

      // Range: given, or measured from the columns this band draws — and when
      // it is measured, measured over the WINDOW, so a zoomed corner fills the
      // band instead of hugging one line of it.
      let lo = band.min;
      let hi = band.max;
      if (lo === undefined || hi === undefined) {
        let mn = Infinity;
        let mx = -Infinity;
        const reach = (cols, dd) => {
          for (const s of band.series) {
            const col = cols[s.key];
            if (!Array.isArray(col) || col.length !== dd.length) continue;
            for (let i = 0; i < col.length; i++) {
              if (!inWindow(dd[i])) continue;
              const q = col[i] * (s.scale || 1);
              if (q < mn) mn = q;
              if (q > mx) mx = q;
            }
          }
        };
        reach(src, dcol);
        if (band.compare && o.vs) reach(o.vs, o.vs.d || []);
        if (mn === Infinity) { mn = 0; mx = 1; }
        if (mx - mn < 1e-6) { mn -= 1; mx += 1; }
        if (lo === undefined) lo = band.fromZero ? Math.min(0, mn) : mn - (mx - mn) * 0.08;
        if (hi === undefined) hi = mx + (mx - mn) * 0.08;
        // A channel that swings both ways has to keep zero in the middle, or
        // the rule drawn at zero is not the middle and every glance misreads
        // which way the wheel was turned. `floor` stops a lap round Indy
        // scaling a millimetre of steering correction up into a full lock.
        if (band.symmetric) {
          const span = Math.max(Math.abs(lo), Math.abs(hi), band.floor || 0);
          lo = -span;
          hi = span;
        }
      }
      const py = (v) => y1 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * bh;

      // A zero rule where zero means something — steering, and the delta.
      if (band.zero && lo < 0 && hi > 0) {
        const zy = Math.round(py(0)) + 0.5;
        ctx.strokeStyle = CSS.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, zy);
        ctx.lineTo(x1, zy);
        ctx.stroke();
      }

      // Clipped to its own band, because a zoomed window puts most of the lap
      // off both ends of the plot and a stroke that overruns the axis labels
      // reads as a chart that has broken rather than one that is zoomed.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, plotW, bh);
      ctx.clip();

      /** One series of one lap's columns, as a path. */
      const stroke = (cols, dd, s, style) => {
        const col = cols[s.key];
        if (!Array.isArray(col) || col.length !== dd.length || !dd.length) return;
        const scale = s.scale || 1;
        const path = () => {
          let started = false;
          for (let i = 0; i < col.length; i++) {
            // One sample either side of the window, so the trace enters and
            // leaves the plot instead of starting in mid-air just inside it.
            if (!inWindow(dd[i]) && !(i > 0 && inWindow(dd[i - 1]))
              && !(i + 1 < dd.length && inWindow(dd[i + 1]))) continue;
            const cx = px(dd[i]);
            const cy = py(col[i] * scale);
            if (!started) { ctx.moveTo(cx, cy); started = true; continue; }
            if (s.step) {
              // Gear is a step, not a slope: the gearbox does not sweep between
              // third and fourth, and a ramp claims a moment that never was.
              ctx.lineTo(cx, py(col[i - 1] * scale));
            }
            ctx.lineTo(cx, cy);
          }
          return started;
        };
        if (s.fill && !style) {
          ctx.beginPath();
          if (path()) {
            const base = py(Math.max(lo, 0));
            ctx.lineTo(px(Math.min(wTo, dd[dd.length - 1])), base);
            ctx.lineTo(px(Math.max(wFrom, dd[0])), base);
            ctx.closePath();
            ctx.fillStyle = s.fill;
            ctx.fill();
          }
        }
        ctx.beginPath();
        path();
        ctx.strokeStyle = (style && style.color) || s.color;
        ctx.lineWidth = (style && style.width) || s.width || 1.4;
        ctx.setLineDash((style && style.dash) || []);
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.setLineDash([]);
      };

      // The comparison lap goes down FIRST and stays thin and violet: it is the
      // thing being measured against, not the thing being read, and a second
      // trace at equal weight turns every band into a puzzle about which line
      // is yours.
      if (band.compare && o.vs) {
        for (const s of band.series) {
          stroke(o.vs, o.vs.d || [], s, { color: CSS.compare, width: 1.1, dash: [4, 3] });
        }
      }

      // The delta is filled to its own zero rather than stroked alone: the area
      // between the trace and zero IS the time, and a driver reads "how much"
      // off a mass far faster than off the height of a line.
      if (band.from === 'delta') {
        deltaFill(ctx, o.delta, px, py, wFrom, wTo, x0, plotW);
      }

      for (const s of band.series) stroke(src, dcol, s);

      // Intervention ticks along the floor of the band: where the electronics
      // were doing the driving. Nothing else on the page says this, it costs no
      // vertical space, and "the car saved me there" is exactly the sort of
      // thing a driver cannot feel afterwards.
      for (const mark of band.marks || []) {
        const col = src[mark.key];
        if (!Array.isArray(col) || col.length !== dcol.length) continue;
        ctx.strokeStyle = mark.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < col.length; i++) {
          if (!(col[i] > 0.02) || !inWindow(dcol[i])) continue;
          const mx = px(dcol[i]);
          ctx.moveTo(mx, y1 - 3);
          ctx.lineTo(mx, y1);
        }
        ctx.stroke();
      }
      ctx.restore();

      // Scale: the two ends of the axis, and the band's name.
      ctx.font = '9px "Cascadia Mono", Consolas, monospace';
      ctx.fillStyle = CSS.text3;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(band.fmt ? band.fmt(hi) : String(Math.round(hi)), x0 - 6, y0);
      ctx.textBaseline = 'bottom';
      ctx.fillText(band.fmt ? band.fmt(lo) : String(Math.round(lo)), x0 - 6, y1);
      ctx.font = '9px Bahnschrift, "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = CSS.text2;
      ctx.fillText(String(band.label).toUpperCase(), x0 + 6, y0 + 3);

      y = y1 + gap;
    }

    const top = padT;
    const bottom = y - gap;
    out.top = top;
    out.bottom = bottom;

    // Sector lines, drawn across every band at once — the reason these share a
    // canvas. S1 starts at the line, so the first mark is the lap's start.
    const marks = [
      { d: 0, name: 'S1' },
      { d: o.sectors ? o.sectors.s1 : null, name: 'S2' },
      { d: o.sectors ? o.sectors.s2 : null, name: 'S3' },
    ];
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = CSS.line2;
    ctx.lineWidth = 1;
    for (const m of marks) {
      if (typeof m.d !== 'number' || m.d <= 0 || !inWindow(m.d)) continue;
      const mx = Math.round(px(m.d)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(mx, top);
      ctx.lineTo(mx, bottom);
      ctx.stroke();
    }

    // Micro-sector edges, faintly, so the chips under the charts and the road
    // above them are visibly the same divisions.
    if (Array.isArray(o.micro) && o.micro.length) {
      ctx.strokeStyle = 'rgba(102,112,138,0.22)';
      for (const seg of o.micro) {
        if (!inWindow(seg.from) || seg.from <= 0) continue;
        const mx = Math.round(px(seg.from)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(mx, top);
        ctx.lineTo(mx, bottom);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    ctx.font = '9px Bahnschrift, "Segoe UI", sans-serif';
    ctx.fillStyle = CSS.text3;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (const m of marks) {
      if (typeof m.d !== 'number' || m.d < 0 || !inWindow(m.d)) continue;
      ctx.fillText(m.name, px(m.d) + 4, h - 3);
    }

    // The x axis is lap distance, and a driver thinks in metres round a lap.
    // Zoomed in, both ends are named: "0 m … 5497 m" is a lap, "1840 m …
    // 2310 m" is the stretch of road actually on screen.
    if (o.lengthM > 0) {
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(wTo * o.lengthM)} m`, x1, h - 3);
      if (wFrom > 0) {
        ctx.textAlign = 'left';
        ctx.fillText(`${Math.round(wFrom * o.lengthM)} m`, x0 + 22, h - 3);
      }
    }

    // The cursor, last, over everything.
    if (typeof o.cursorD === 'number' && o.cursorD >= 0 && inWindow(o.cursorD)) {
      const cx = Math.round(px(o.cursorD)) + 0.5;
      ctx.strokeStyle = 'rgba(244,246,251,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, top);
      ctx.lineTo(cx, bottom);
      ctx.stroke();
    }

    return out;
  }

  /**
   * The delta band's mass: green where the lap was up, red where it was down.
   *
   * Filled per run rather than as one path, because the sign changes several
   * times a lap and one path can only have one fill. A run ends where the trace
   * crosses zero, and the crossing point is interpolated so the two colours
   * meet exactly on the rule rather than a sample either side of it.
   */
  function deltaFill(ctx, delta, px, py, wFrom, wTo, x0, plotW) {
    const { d, dt } = delta;
    const zero = py(0);
    let i = 0;
    while (i < d.length - 1) {
      const sign = dt[i] >= 0 ? 1 : -1;
      let j = i + 1;
      while (j < d.length && (dt[j] >= 0 ? 1 : -1) === sign) j++;
      // Losing time is red and gaining is green, which is the one colour
      // convention every driver already reads without being told.
      ctx.fillStyle = sign > 0 ? 'rgba(255,84,112,0.24)' : 'rgba(53,208,127,0.24)';
      ctx.beginPath();
      ctx.moveTo(px(d[i]), zero);
      for (let k = i; k < Math.min(j + 1, d.length); k++) ctx.lineTo(px(d[k]), py(dt[k]));
      ctx.lineTo(px(d[Math.min(j, d.length - 1)]), zero);
      ctx.closePath();
      ctx.fill();
      i = j;
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  The circuit, as a solid                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * How the map is projected. These are the overlay track map's own constants
   * (`overlay/js/widgets/trackmap.js`), and deliberately the same numbers: a
   * driver who has been staring at the in-car map all session should recognise
   * the shape here instantly, not have to re-learn a second projection of the
   * same circuit.
   */
  const TILT = 0.55;
  /**
   * The lift given to the full elevation range, as a share of planar width.
   *
   * Higher than the in-car map's 0.16, and capped higher too. That map is
   * glanced at mid-corner and must not turn a circuit into a sculpture; this
   * one is studied after the session, where the whole reason a driver is
   * looking at a corner in profile is to see whether the road fell away
   * underneath them.
   */
  const ELEV_SHARE = 0.22;
  /** Ceiling on that exaggeration, so a hilly circuit is not drawn as a wall. */
  const ELEV_MAX_GAIN = 8;
  /** The light, in view space: above, to the left, tipped toward the viewer. */
  const LIGHT = [-0.45, 0.3, 0.84];
  /** Floor on shading, so an unlit face is dark paint rather than a hole. */
  const AMBIENT = 0.36;
  /** Base colour of the road, before the light gets to it. */
  const ROAD = [122, 138, 168];
  /** How far down the curtain darkens, top and foot. */
  const CURTAIN_TOP_MUL = 0.6;
  const CURTAIN_FOOT_MUL = 0.26;
  /** Roughly how many segments to draw, whatever the source path's resolution. */
  const TARGET_SEGMENTS = 280;
  /** The narrowest the road is ever drawn, in px, and its wall height. */
  const MIN_ROAD_PX = 6;
  const WALL_PX = 4;
  /** The ground the circuit stands on: a pool of light, never a plate. */
  const PLANE_TINT = '150,170,210';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function norm3(x, y, z) {
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / l, y / l, z / l];
  }

  /** How much of the light a face with normal `n` receives, floored at ambient. */
  function lambert(n) {
    const dp = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
    return AMBIENT + (1 - AMBIENT) * Math.max(0, dp);
  }

  function shade(k, alpha) {
    const c = (i) => Math.round(clamp(ROAD[i] * k, 0, 255));
    return `rgba(${c(0)},${c(1)},${c(2)},${alpha === undefined ? 1 : alpha})`;
  }

  /**
   * The angle that lays the circuit's longest axis across the box — the
   * principal axis of the point cloud, which is the closed-form answer to
   * "which way round wastes least of the panel".
   */
  function principalAngle(points) {
    const n = points.length;
    let mx = 0;
    let mz = 0;
    for (const p of points) { mx += p[0]; mz += p[1]; }
    mx /= n;
    mz /= n;
    let sxx = 0;
    let szz = 0;
    let sxz = 0;
    for (const p of points) {
      const dx = p[0] - mx;
      const dz = p[1] - mz;
      sxx += dx * dx;
      szz += dz * dz;
      sxz += dx * dz;
    }
    return 0.5 * Math.atan2(2 * sxz, sxx - szz);
  }

  // World plan -> view space. The minus on `v` is the map's handedness: the
  // sim's Z runs one way and canvas Y runs down the screen, so feeding z
  // straight into screen Y draws every circuit as its own mirror image and
  // left-handers become right-handers.
  const viewU = (x, z, ca, sa) => x * ca - z * sa;
  const viewV = (x, z, ca, sa) => -(x * sa + z * ca);

  /**
   * Build the projected ribbon: the road's two edges in screen space, the lift
   * elevation gives each station, and the depth each segment sorts by.
   *
   * `zoom` and `focus` are applied to the FIT, not to the geometry: the same
   * solid is built once and then framed, so zooming into a corner cannot change
   * which way the circuit is rotated or how tall its hill is drawn — both of
   * which would make the zoomed view a different map rather than a closer look
   * at this one.
   */
  function buildRibbon(map, w, h, zoom, focus) {
    const all = map && Array.isArray(map.points) ? map.points : [];
    if (all.length < 8) return null;
    const step = Math.max(1, Math.floor(all.length / TARGET_SEGMENTS));
    const pts = [];
    for (let i = 0; i < all.length; i += step) pts.push(all[i]);
    const n = pts.length;
    if (n < 8) return null;

    const ang = -principalAngle(all);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);

    let minU = Infinity;
    let maxU = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of all) {
      const u = viewU(p[0], p[1], ca, sa);
      const e = typeof p[2] === 'number' && Number.isFinite(p[2]) ? p[2] : 0;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (e < minY) minY = e;
      if (e > maxY) maxY = e;
    }
    const rise = maxY - minY;
    // Real circuits move ±30 m over a 1.5 km footprint, which is under 2% of
    // the map's width and invisible at true scale. So the lift is a fixed share
    // of the width, capped — Spa's hill is unmistakable and a flat circuit
    // stays flat rather than being given terrain it does not have.
    const gain = rise > 0.5 ? Math.min(ELEV_MAX_GAIN, (ELEV_SHARE * (maxU - minU)) / rise) : 0;

    // The road's two edges, `half` metres either side of the path.
    const half = Math.max(map.halfWidthM > 0 ? map.halfWidthM : 6, 4);
    const rails = new Array(n);
    let bMinX = Infinity;
    let bMaxX = -Infinity;
    let bMinY = Infinity;
    let bMaxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[(i - 1 + n) % n];
      const b = pts[(i + 1) % n];
      const tx = b[0] - a[0];
      const tz = b[1] - a[1];
      const len = Math.hypot(tx, tz) || 1;
      const nx = (tz / len) * half;
      const nz = (-tx / len) * half;
      const e = typeof p[2] === 'number' && Number.isFinite(p[2]) ? p[2] : minY;
      const lift = (e - minY) * gain;
      const lu = viewU(p[0] + nx, p[1] + nz, ca, sa);
      const lv = viewV(p[0] + nx, p[1] + nz, ca, sa);
      const ru = viewU(p[0] - nx, p[1] - nz, ca, sa);
      const rv = viewV(p[0] - nx, p[1] - nz, ca, sa);
      const flY = lv * TILT;
      const frY = rv * TILT;
      rails[i] = {
        lu, lv, ru, rv, lift,
        lx: lu, ly: flY - lift, rx: ru, ry: frY - lift, fly: flY, fry: frY,
        // Higher ground sorts as nearer: where a circuit crosses itself the two
        // roads share a footprint, so `v` alone is a coin flip between the
        // bridge and the road under it.
        depth: (lv + rv) / 2 + lift * TILT,
      };
      bMinX = Math.min(bMinX, lu, ru);
      bMaxX = Math.max(bMaxX, lu, ru);
      bMinY = Math.min(bMinY, flY - lift, frY - lift);
      bMaxY = Math.max(bMaxY, flY, frY);
    }

    const pad = 12;
    const boxW = Math.max(1, bMaxX - bMinX);
    const boxH = Math.max(1, bMaxY - bMinY);
    const base = Math.min((w - pad * 2) / boxW, (h - pad * 2 - WALL_PX) / boxH);
    const z = zoom > 1 ? zoom : 1;
    const scale = base * z;
    // Centred on the whole circuit at 1×, and on the focus point once zoomed —
    // so zooming in walks toward the corner rather than toward the middle of
    // the map with the corner sliding off an edge.
    let cu = (bMinX + bMaxX) / 2;
    let cy = (bMinY + bMaxY) / 2;
    if (z > 1 && focus) {
      cu = focus.u;
      cy = focus.y;
    }
    const offX = w / 2 - cu * scale;
    const offY = (h - WALL_PX) / 2 - cy * scale;

    const screen = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = rails[i];
      screen[i] = {
        lx: r.lx * scale + offX, ly: r.ly * scale + offY,
        rx: r.rx * scale + offX, ry: r.ry * scale + offY,
        fly: r.fly * scale + offY, fry: r.fry * scale + offY,
        depth: r.depth, lu: r.lu, lv: r.lv, ru: r.ru, rv: r.rv, lift: r.lift,
      };
    }

    // How wide the road actually lands. A whole circuit in a 380 px box runs at
    // a fraction of a pixel per metre, where a real 12 m road is a hairline —
    // every printed circuit map exaggerates the road for the same reason. The
    // exaggeration only ever ADDS width and never moves the centreline.
    let roadPx = 0;
    for (const sc of screen) roadPx += Math.hypot(sc.lx - sc.rx, sc.ly - sc.ry);
    roadPx /= n;
    const widen = roadPx < MIN_ROAD_PX ? MIN_ROAD_PX / Math.max(0.2, roadPx) : 1;
    if (widen > 1) {
      for (const sc of screen) {
        const mx = (sc.lx + sc.rx) / 2;
        const my = (sc.ly + sc.ry) / 2;
        sc.lx = mx + (sc.lx - mx) * widen;
        sc.ly = my + (sc.ly - my) * widen;
        sc.rx = mx + (sc.rx - mx) * widen;
        sc.ry = my + (sc.ry - my) * widen;
      }
    }

    return {
      screen, n, scale, offX, offY, ca, sa, minY, gain, zoom: z,
      minEl: minY, maxEl: maxY, rise, points: all,
      /** World position -> canvas position, through the same transform. */
      project(x, zz, e) {
        const lift = ((typeof e === 'number' && Number.isFinite(e) ? e : minY) - minY) * gain;
        const u = viewU(x, zz, ca, sa);
        const v = viewV(x, zz, ca, sa);
        return { x: u * scale + offX, y: (v * TILT - lift) * scale + offY, depth: v };
      },
      /** …and the view-space point a focus is expressed in. */
      viewOf(x, zz, e) {
        const lift = ((typeof e === 'number' && Number.isFinite(e) ? e : minY) - minY) * gain;
        return { u: viewU(x, zz, ca, sa), y: viewV(x, zz, ca, sa) * TILT - lift };
      },
    };
  }

  /**
   * The plane the circuit stands on: a pool of light under the map, fading to
   * nothing well before it reaches an edge.
   *
   * A pool rather than a slab. This projection has no perspective, so any
   * rectangle on the ground lands screen-axis-aligned and a plate with a rim
   * would read as a card behind the map rather than a surface under it. Light
   * rather than dark, because the panel is already near-black and the feature
   * is not the plane — it is the CONTRAST between the curtain's dark foot and
   * the plane it lands on.
   */
  function drawPlane(ctx, g) {
    if (!(g.gain > 0)) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const sc of g.screen) {
      minX = Math.min(minX, sc.lx, sc.rx);
      maxX = Math.max(maxX, sc.lx, sc.rx);
      minY = Math.min(minY, sc.fly, sc.fry);
      maxY = Math.max(maxY, sc.fly, sc.fry);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2 + WALL_PX;
    const r = Math.max(maxX - minX, maxY - minY) * 0.62;
    if (!(r > 0)) return;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(${PLANE_TINT},0.075)`);
    grad.addColorStop(0.55, `rgba(${PLANE_TINT},0.054)`);
    grad.addColorStop(1, `rgba(${PLANE_TINT},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /** One quad, filled. */
  function quad(ctx, ax, ay, bx, by, cx, cy, dx, dy, style) {
    ctx.fillStyle = style;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(cx, cy);
    ctx.lineTo(dx, dy);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Draw the circuit as a solid standing on its own ground.
   *
   * Back to front, because canvas 2-D has no depth buffer and every circuit
   * crosses over itself somewhere. Each segment is a far wall, the road, the
   * near wall, and — where there is elevation — a curtain hanging from the
   * road's underside down to the flat plane it would sit on. That curtain is
   * the whole elevation cue: the gap between the road and its own base IS the
   * height of the place, so a climb reads as the road pulling away from its
   * foot rather than as a shading trick you have to be told about.
   */
  function paintRibbon(ctx, g, dim) {
    const s = g.screen;
    const n = g.n;
    drawPlane(ctx, g);
    const order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => (s[a].depth + s[(a + 1) % n].depth) - (s[b].depth + s[(b + 1) % n].depth));

    const extrude = g.gain > 0;
    const alpha = dim === undefined ? 1 : dim;

    for (let k = 0; k < n; k++) {
      const i = order[k];
      const j = (i + 1) % n;
      const a = s[i];
      const b = s[j];

      // The segment's frame, in view space: du/dv is where the road is going,
      // dh how much it climbs doing it, and `out` the horizontal normal of the
      // left rail — the right rail's is its negation.
      const du = (b.lu + b.ru) / 2 - (a.lu + a.ru) / 2;
      const dv = (b.lv + b.rv) / 2 - (a.lv + a.rv) / 2;
      const dh = b.lift - a.lift;
      const run = Math.hypot(du, dv) || 1;
      const outL = norm3(a.lu - (a.lu + a.ru) / 2, a.lv - (a.lv + a.rv) / 2, 0);
      const outR = [-outL[0], -outL[1], 0];
      const nTop = norm3(-(dh * du) / (run * run), -(dh * dv) / (run * run), 1);
      const leftNearer = (a.ly + b.ly) > (a.ry + b.ry);

      const wallSide = (side, normal) => {
        const ax = side === 'l' ? a.lx : a.rx;
        const ay = side === 'l' ? a.ly : a.ry;
        const bx = side === 'l' ? b.lx : b.rx;
        const by = side === 'l' ? b.ly : b.ry;
        quad(ctx, ax, ay, bx, by, bx, by + WALL_PX, ax, ay + WALL_PX,
          shade(lambert(normal) * 0.78, alpha));
      };
      const curtain = (side, normal) => {
        const ax = side === 'l' ? a.lx : a.rx;
        const ay = (side === 'l' ? a.ly : a.ry) + WALL_PX;
        const bx = side === 'l' ? b.lx : b.rx;
        const by = (side === 'l' ? b.ly : b.ry) + WALL_PX;
        const aFoot = side === 'l' ? a.fly : a.fry;
        const bFoot = side === 'l' ? b.fly : b.fry;
        if (aFoot - ay < 1 && bFoot - by < 1) return;
        const k2 = lambert(normal);
        const grad = ctx.createLinearGradient(0, Math.min(ay, by), 0, Math.max(aFoot, bFoot));
        grad.addColorStop(0, shade(k2 * CURTAIN_TOP_MUL, alpha));
        grad.addColorStop(1, shade(k2 * CURTAIN_FOOT_MUL, alpha));
        quad(ctx, ax, ay, bx, by, bx, Math.max(by, bFoot), ax, Math.max(ay, aFoot), grad);
      };

      if (extrude) curtain(leftNearer ? 'r' : 'l', leftNearer ? outL : outR);
      wallSide(leftNearer ? 'r' : 'l', leftNearer ? outR : outL);
      quad(ctx, a.lx, a.ly, b.lx, b.ly, b.rx, b.ry, a.rx, a.ry, shade(lambert(nTop), alpha));
      wallSide(leftNearer ? 'l' : 'r', leftNearer ? outL : outR);
      if (extrude) curtain(leftNearer ? 'l' : 'r', leftNearer ? outR : outL);
    }
  }

  /**
   * The last ribbon painted, kept as a bitmap.
   *
   * The solid is two thousand fills — five per segment — and the scrub cursor
   * repaints this canvas on every mouse move. Rendering it once and blitting it
   * after is the same trick the in-car map plays for the same reason, and it is
   * what makes moving across the charts feel like moving a cursor rather than
   * re-rendering a circuit. One entry, because only one map is ever on screen.
   *
   * The key includes the window, so zooming rebuilds and scrubbing does not.
   */
  let ribbonCache = null;

  function ribbonFor(map, w, h, wFrom, wTo, span) {
    const key = `${w}x${h}|${wFrom.toFixed(4)}|${wTo.toFixed(4)}`;
    // Identity as well as the key: two circuits can agree on every field in a
    // key and still be different shapes, and the renderer holds one map object
    // for as long as it is looking at one circuit — so this is both cheaper
    // and stricter than hashing the points would be.
    if (ribbonCache && ribbonCache.map === map && ribbonCache.key === key) return ribbonCache;

    // Zoom follows the window: a tenth of the lap on screen is ten times the
    // scale, capped so a two-sample window does not project the road into a
    // pair of walls filling the box. Past about three times a corner fills the
    // box and there is nothing left in it to say WHERE the corner is — which
    // is what the locator inset is for, rather than a reason not to zoom.
    const zoom = span >= 0.999 ? 1 : Math.min(9, 1 / Math.max(0.06, span));
    const probe = buildRibbon(map, w, h, 1, null);
    if (!probe) return null;
    let g = probe;
    if (zoom > 1) {
      const pts = map.points;
      const mid = pts[Math.min(pts.length - 1, Math.floor(((wFrom + wTo) / 2) * pts.length))];
      g = buildRibbon(map, w, h, zoom, probe.viewOf(mid[0], mid[1], mid[2]));
      if (!g) return null;
    }

    let bitmap = null;
    // Guarded because this module is require()d by its test in plain Node,
    // where there is no document to make a canvas with — there it paints
    // straight onto the canvas it was handed, which is what the test watches.
    if (typeof document !== 'undefined' && document.createElement) {
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(w * dpr));
      off.height = Math.max(1, Math.round(h * dpr));
      const ox = off.getContext('2d');
      if (ox) {
        ox.setTransform(dpr, 0, 0, dpr, 0, 0);
        ox.lineJoin = 'round';
        ox.lineCap = 'round';
        paintRibbon(ox, g);
        bitmap = off;
      }
    }
    // The 1x fit is kept alongside the zoomed one: it is what the locator
    // inset is drawn from, and rebuilding it per repaint would be the whole
    // projection run twice for a thumbnail.
    ribbonCache = { key, map, g, bitmap, probe, zoom };
    return ribbonCache;
  }

  /**
   * The circuit, with the lap on it.
   *
   * The road is a solid, not a stroke — see {@link paintRibbon} — which is what
   * puts the elevation of the place on the screen the way the in-car overlay
   * does. Over it go the driven lines and the cursor.
   *
   * A v1 trace has no line. The cursor is then placed on the CENTRELINE at the
   * right distance, which is true and useful ("this is the corner you are
   * looking at") — the same fallback the pit wall's map has always used for a
   * car it has no position for. What is never done is inventing a line from the
   * centreline and showing it as the driver's.
   *
   * `opts.window` zooms: the view scales up and centres on the middle of the
   * window, so clicking a corner walks the map toward that corner instead of
   * just making the whole circuit bigger.
   */
  function drawLapMap(canvas, map, trace, opts) {
    const { ctx, w, h } = surface(canvas);
    const pts = map && Array.isArray(map.points) ? map.points : [];
    if (pts.length < 8) return null;
    const o = opts || {};
    const [wFrom, wTo] = windowOf(o);
    const span = wTo - wFrom;

    const cached = ribbonFor(map, w, h, wFrom, wTo, span);
    if (!cached) return null;
    const g = cached.g;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (cached.bitmap) ctx.drawImage(cached.bitmap, 0, 0, w, h);
    else paintRibbon(ctx, g);
    if (cached.zoom > 1.05) drawLocator(ctx, cached.probe, w, h, wFrom, wTo, o.cursorD);

    // Sector lines, as bars across the road at the right distance.
    for (const dd of [0, o.sectors ? o.sectors.s1 : null, o.sectors ? o.sectors.s2 : null]) {
      if (typeof dd !== 'number' || dd < 0) continue;
      const i = Math.min(g.n - 1, Math.max(0, Math.round(dd * g.n)));
      const sc = g.screen[i];
      ctx.strokeStyle = dd === 0 ? '#e2e8f0' : 'rgba(226,232,240,0.5)';
      ctx.lineWidth = dd === 0 ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(sc.lx, sc.ly);
      ctx.lineTo(sc.rx, sc.ry);
      ctx.stroke();
    }

    /** Elevation for a trace sample, borrowed from the nearest centreline point. */
    const elevAt = (dd) => {
      const k = Math.min(pts.length - 1, Math.max(0, Math.round(dd * pts.length)));
      const e = pts[k][2];
      return typeof e === 'number' && Number.isFinite(e) ? e : g.minEl;
    };

    /** One driven line, lifted onto the road it was driven on. */
    const line = (tr, style, width, dash) => {
      if (!tr || !Array.isArray(tr.x) || !Array.isArray(tr.z)) return false;
      if (tr.x.length < 2 || tr.x.length !== tr.z.length) return false;
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      for (let i = 0; i < tr.x.length; i++) {
        const p = g.project(tr.x[i], tr.z[i], elevAt(tr.d ? tr.d[i] : i / tr.x.length) + 0.35);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      return true;
    };

    // The comparison lap first and dashed, for the same reason it goes under on
    // the charts: it is the reference, not the subject.
    line(o.vs, CSS.compare, 1.6, [5, 4]);
    const placed = line(trace, CSS.cyan, 2);

    // The cursor: the real position when the lap was placed, otherwise the
    // point on the centreline at that distance.
    if (typeof o.cursorD === 'number' && o.cursorD >= 0) {
      let p;
      const i = o.cursorIndex;
      if (placed && typeof i === 'number' && i >= 0 && i < trace.x.length) {
        p = g.project(trace.x[i], trace.z[i], elevAt(trace.d[i]) + 0.35);
      } else {
        const k = Math.min(pts.length - 1, Math.max(0, Math.floor(o.cursorD * pts.length)));
        p = g.project(pts[k][0], pts[k][1], pts[k][2]);
      }
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = CSS.cyan;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    return {
      minY: g.minEl,
      maxY: g.maxEl,
      shaded: g.gain > 0,
      placed,
      zoom: g.zoom,
      geom: g,
    };
  }

  /**
   * The locator: the whole circuit, small, in the corner, with the stretch on
   * screen picked out on it.
   *
   * Zoomed in far enough to read a braking zone, a map has stopped being able
   * to say WHERE that braking zone is — every corner of every circuit looks
   * like some road. This is the answer every zoomable map has settled on, and
   * it costs one thin outline: the shape a driver already recognises, with
   * their own position on it.
   *
   * Drawn from the 1x projection rather than from the plan, so the outline is
   * the same shape as the map above it and not a second, differently-rotated
   * view of the same circuit.
   */
  function drawLocator(ctx, probe, w, h, wFrom, wTo, cursorD) {
    if (!probe || !probe.screen) return;
    const n = probe.n;
    const mid = probe.screen.map((sc) => [(sc.lx + sc.rx) / 2, (sc.ly + sc.ry) / 2]);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const m of mid) {
      minX = Math.min(minX, m[0]);
      maxX = Math.max(maxX, m[0]);
      minY = Math.min(minY, m[1]);
      maxY = Math.max(maxY, m[1]);
    }
    const boxW = Math.min(112, w * 0.32);
    const boxH = Math.min(72, h * 0.3);
    const pad = 8;
    const scale = Math.min(boxW / Math.max(1, maxX - minX), boxH / Math.max(1, maxY - minY));
    const ox = w - pad - boxW + (boxW - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = h - pad - boxH + (boxH - (maxY - minY) * scale) / 2 - minY * scale;
    const px = (i) => mid[i][0] * scale + ox;
    const py = (i) => mid[i][1] * scale + oy;

    ctx.save();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(154,164,184,0.38)';
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(i));
    ctx.closePath();
    ctx.stroke();

    // The stretch on screen, in the same cyan the studied lap is drawn in.
    const from = Math.max(0, Math.floor(wFrom * n));
    const to = Math.min(n - 1, Math.ceil(wTo * n));
    ctx.strokeStyle = CSS.cyan;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(px(from), py(from));
    for (let i = from + 1; i <= to; i++) ctx.lineTo(px(i), py(i));
    ctx.stroke();

    if (typeof cursorD === 'number' && cursorD >= 0) {
      const k = Math.min(n - 1, Math.max(0, Math.round(cursorD * n)));
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(px(k), py(k), 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Which point of the centreline a click landed nearest, as a lap distance.
   *
   * The projection is not invertible — two points of road can share a pixel
   * where a circuit crosses itself — so this asks the honest question instead:
   * of the stations actually drawn, which one is closest to the pointer. The
   * nearer of two crossing roads wins, which is the one the eye was on.
   */
  function distanceAtPoint(geom, x, y) {
    if (!geom || !geom.screen) return null;
    let best = null;
    for (let i = 0; i < geom.n; i++) {
      const sc = geom.screen[i];
      const mx = (sc.lx + sc.rx) / 2;
      const my = (sc.ly + sc.ry) / 2;
      const dist = Math.hypot(mx - x, my - y);
      if (!best || dist < best.dist || (Math.abs(dist - best.dist) < 6 && sc.depth > best.depth)) {
        best = { dist, i, depth: sc.depth };
      }
    }
    if (!best || best.dist > 42) return null;
    return best.i / geom.n;
  }

  /* ------------------------------------------------------------------------ */
  /*  Tyre wear                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * Tyre wear, lap by lap, one line per corner.
   *
   * Wear is recorded as "life remaining", `1` = new, so it is drawn as the
   * percentage USED — which climbs, and a driver reads a climbing line as
   * something being spent. Stint boundaries are ruled in because a stop puts
   * new tyres on and the drop across that rule is the only place on the page
   * where a set change is visible.
   *
   * Laps that reported no wear are skipped rather than plotted at zero: LMU
   * publishes the block only for some cars and sessions, and a flat line along
   * the floor reads as "the tyres never wore" instead of "nothing was said".
   */
  function drawWear(canvas, session) {
    const { ctx, w, h } = surface(canvas);
    const rows = [];
    for (const stint of session.stints || []) {
      for (const lap of stint.laps || []) {
        if (Array.isArray(lap.wear) && lap.wear.length === 4) {
          rows.push({ lapNo: lap.lapNo, stintNo: stint.no, wear: lap.wear });
        }
      }
    }
    if (rows.length < 2) return null;

    const padL = 34;
    const padR = 10;
    const padT = 10;
    const padB = 18;
    const x0 = padL;
    const x1 = w - padR;
    const y0 = padT;
    const y1 = h - padB;

    let peak = 0;
    for (const r of rows) for (const v of r.wear) peak = Math.max(peak, 1 - v);
    // Always at least a tenth of the axis, so a fresh set on a short run is a
    // flat line near the floor rather than noise magnified into a mountain.
    const top = Math.max(0.1, Math.min(1, peak * 1.15));

    const px = (i) => x0 + (rows.length < 2 ? 0 : (i / (rows.length - 1)) * (x1 - x0));
    const py = (used) => y1 - (Math.min(top, Math.max(0, used)) / top) * (y1 - y0);

    ctx.strokeStyle = CSS.line;
    ctx.lineWidth = 1;
    ctx.font = '9px "Cascadia Mono", Consolas, monospace';
    ctx.fillStyle = CSS.text3;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= 2; k++) {
      const used = (top * k) / 2;
      const gy = Math.round(py(used)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, gy);
      ctx.lineTo(x1, gy);
      ctx.stroke();
      ctx.fillText(`${Math.round(used * 100)}%`, x0 - 6, gy);
    }

    // Where the stint changed, which is where the tyres did.
    ctx.strokeStyle = CSS.line2;
    ctx.setLineDash([3, 3]);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].stintNo === rows[i - 1].stintNo) continue;
      const gx = Math.round((px(i) + px(i - 1)) / 2) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, y0);
      ctx.lineTo(gx, y1);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const CORNERS = [
      { i: 0, label: 'FL', color: CSS.cyan },
      { i: 1, label: 'FR', color: CSS.best },
      { i: 2, label: 'RL', color: CSS.ok },
      { i: 3, label: 'RR', color: CSS.warn },
    ];
    for (const corner of CORNERS) {
      ctx.strokeStyle = corner.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < rows.length; i++) {
        const used = 1 - rows[i].wear[corner.i];
        const cx = px(i);
        const cy = py(used);
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    }

    ctx.font = '9px Bahnschrift, "Segoe UI", sans-serif';
    ctx.fillStyle = CSS.text3;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`LAP ${rows[0].lapNo}`, x0, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText(`LAP ${rows[rows.length - 1].lapNo}`, x1, h - 4);

    return { laps: rows.length, peak };
  }

  /**
   * The channel bands, in the order a driver reads a lap.
   *
   * Speed first, because it is the shape of the lap and everything else
   * explains it. Throttle and brake share ONE band rather than getting one
   * each: they are the same axis, and the thing worth seeing — the gap between
   * lifting and braking, or the overlap — is only visible when they are drawn
   * together. Gear and steering follow because they qualify what the pedals
   * did.
   *
   * TC and ABS are ticks along the floor of the pedal band rather than bands of
   * their own. They are almost always zero, so a band each would be two empty
   * stripes; as ticks they cost nothing and say the one thing that matters —
   * where the car was driving instead of the driver.
   *
   * With a comparison lap loaded the DELTA goes on top, above speed. It is the
   * answer to the question the driver opened the comparison to ask, and the
   * three bands below it are the explanation — so it reads top to bottom as
   * "you lost 0.3 s here" then "because you were 8 km/h slower" then "because
   * you braked earlier".
   *
   * The spec lives here rather than in the panel because it is half colour: the
   * palette belongs with the painter that uses it.
   */
  function channelBands(opts) {
    const mph = opts && opts.mph;
    const bands = [];
    if (opts && opts.delta) {
      bands.push({
        // The band NAMES its direction. `+` for behind is the convention every
        // timing screen in the sport uses, but a driver reading a red +2.1 on
        // a lap they know was two seconds slower still has to stop and work
        // out which way round it is — and a delta trace read backwards inverts
        // every judgement made on the screen. Six words in the caption end
        // that, permanently, for everyone who ever opens this.
        label: 'Delta — slower above, faster below',
        from: 'delta',
        // The tallest of the lot after speed: it is the answer to the question
        // the comparison was opened to ask, and a tenth of a second has to be
        // a visible height rather than a wobble on a 60 px strip.
        weight: 1.2,
        zero: true,
        symmetric: true,
        // A tenth of a second of axis, minimum: without a floor, two laps that
        // matched to a hundredth would draw their own noise as a mountain range.
        floor: 0.1,
        series: [{ key: 'dt', color: CSS.text2, width: 1.2 }],
        fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`,
      });
    }
    bands.push(
      {
        label: 'Speed',
        weight: 1.35,
        fromZero: true,
        min: 0,
        compare: true,
        series: [{
          key: 'speedKph', color: CSS.cyan,
          scale: mph ? 0.621371 : 1, fill: 'rgba(38,187,244,0.10)',
        }],
        fmt: (v) => String(Math.round(v)),
      },
      {
        label: 'Throttle / brake',
        weight: 1.15,
        min: 0,
        max: 100,
        compare: true,
        series: [
          { key: 'throttle', color: CSS.ok, scale: 100, fill: 'rgba(53,208,127,0.12)' },
          { key: 'brake', color: CSS.bad, scale: 100, fill: 'rgba(255,84,112,0.12)' },
        ],
        marks: [
          { key: 'tc', color: 'rgba(255,176,32,0.9)' },
          { key: 'abs', color: 'rgba(167,139,250,0.9)' },
        ],
        fmt: (v) => `${Math.round(v)}%`,
      },
      {
        label: 'Gear',
        weight: 0.8,
        min: 0,
        series: [{ key: 'gear', color: CSS.best, step: true }],
        fmt: (v) => String(Math.round(v)),
      },
      {
        // Scaled to the lap rather than to full lock. A GT car uses a few
        // degrees of the wheel almost everywhere, so a fixed -100..100 axis
        // draws every lap as a flat line with a wobble at the hairpin.
        label: 'Steering',
        weight: 0.85,
        zero: true,
        symmetric: true,
        floor: 12,
        series: [{ key: 'steer', color: CSS.text2, scale: 100 }],
        fmt: (v) => `${Math.abs(Math.round(v))}${v > 0.5 ? 'R' : v < -0.5 ? 'L' : ''}`,
      },
    );
    return bands;
  }

  return {
    drawLapChart, drawTrend, drawChannels, drawLapMap, drawWear,
    channelBands, distanceAtPoint,
  };
});
