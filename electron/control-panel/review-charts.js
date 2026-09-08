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

      // The comparison lap goes down FIRST, thin and DASHED: it is the thing
      // being measured against, not the thing being read, and a second trace
      // at equal weight turns every band into a puzzle about which line is
      // yours. Dashed is its one identifying mark; the COLOUR stays the
      // channel's own, paler. One violet for everything the other lap did
      // meant its throttle and its brake were the same line on the same band,
      // which is exactly the pair a driver compares.
      if (band.compare && o.vs) {
        for (const s of band.series) {
          stroke(o.vs, o.vs.d || [], s, { color: s.cmp || CSS.compare, width: 1.2, dash: [4, 3] });
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

    // The stretch being dragged out, under the cursor and over everything
    // else: it is a gesture in progress, so it has to be visible on top of the
    // traces it is being drawn across, and gone the moment the mouse comes up.
    if (Array.isArray(o.select) && o.select.length === 2) {
      const a = Math.max(wFrom, Math.min(o.select[0], o.select[1]));
      const b = Math.min(wTo, Math.max(o.select[0], o.select[1]));
      if (b > a) {
        ctx.fillStyle = 'rgba(38,187,244,0.13)';
        ctx.fillRect(px(a), top, px(b) - px(a), bottom - top);
        ctx.strokeStyle = 'rgba(38,187,244,0.55)';
        ctx.lineWidth = 1;
        for (const edge of [a, b]) {
          const ex = Math.round(px(edge)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(ex, top);
          ctx.lineTo(ex, bottom);
          ctx.stroke();
        }
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
  /*  The circuit, in plan                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Straight down, and flat.
   *
   * This map used to be the in-car overlay's ribbon: rotated, tilted to 0.55,
   * lifted by its own elevation and hung on a curtain down to a ground plane.
   * That is a good map to glance at and a bad one to measure with, and this
   * screen measures. Two things broke:
   *
   *   - **A tilt is a lie about distance.** Squashing the depth axis to 55%
   *     makes a metre across the screen and a metre up it different lengths,
   *     so two lines a metre apart are drawn a metre apart where the road runs
   *     left-to-right and half that where it runs away from you. Telling those
   *     two lines apart is the entire job of this view.
   *   - **Zoomed in, the solid WAS the view.** A corner at 9x filled the box
   *     with road, and both driven lines rode along its top edge.
   *
   * So: drawn from directly above, to scale, both axes equal. The elevation
   * the lift used to carry is still on the screen — it shades the surface,
   * pale for the high ground and dark for the low, the way a relief map has
   * always said it — and it costs the lines nothing, because it is under them.
   *
   * The other half of the change is the framing. Zoom is no longer a number
   * the road is multiplied by; the window's own stretch of road is measured
   * and the box is fitted to IT. Click a hairpin and you get that hairpin,
   * filling the panel, at whatever scale that takes.
   */

  /** Air kept inside the box, in px. */
  const MAP_PAD = 14;
  /** Roughly how many segments the whole circuit is drawn with. */
  const TARGET_SEGMENTS = 320;
  /**
   * The narrowest the road is ever drawn, in px.
   *
   * Wide enough that the surface still has a shade to it either side of a
   * driven line — at whole-lap scale a real 12 m road is under a pixel, and a
   * road the same width as the line on it is not a road, it is the line.
   */
  const MIN_ROAD_PX = 10;
  /**
   * How much of the framed stretch's own size is left around it as air —
   * ZOOMED only. Whole, the circuit is its own subject and the padding round
   * the box is enough; a margin on top of that leaves a third of the panel
   * empty round a map already too small to read.
   */
  const FRAME_MARGIN = 0.14;
  const FRAME_MARGIN_WHOLE = 0.015;
  /** The road surface: low ground, high ground, and ground not worth shading. */
  const ROAD_LOW = [32, 38, 51];
  const ROAD_HIGH = [104, 118, 145];
  const ROAD_FLAT = [60, 69, 89];
  /** Its edges — the thing a driven line is actually read against. */
  const ROAD_EDGE = 'rgba(196,210,236,0.42)';
  /** Nice round distances for the scale bar. */
  const NICE_M = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /**
   * The angle that lays the circuit's longest axis across the box — the
   * principal axis of the point cloud, which is the closed-form answer to
   * "which way round wastes least of the panel".
   *
   * Taken from the WHOLE circuit even when the view is framed on one corner,
   * so zooming in never rotates the map under the reader: the shape they
   * learned at a glance is the shape they are looking closely at.
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
   * Build the circuit in plan: both road edges in screen space, framed on the
   * stretch of lap the window asks for.
   *
   * Whole-lap and zoomed differ in two places and nowhere else — how much of
   * the path is kept, and which bounding box the fit is taken from. Everything
   * downstream of here is the same code looking at the same solid.
   */
  function buildPlan(map, w, h, wFrom, wTo) {
    const all = map && Array.isArray(map.points) ? map.points : [];
    if (all.length < 8) return null;
    const from01 = clamp(isNum(wFrom) ? wFrom : 0, 0, 1);
    const to01 = clamp(isNum(wTo) ? wTo : 1, 0, 1);
    const whole = to01 - from01 >= 0.999;

    // Whole, a few hundred segments is plenty and more is wasted fills.
    // Zoomed, every dropped station is a flat spot on a curve that the reader
    // is looking at from six metres away, so the path is kept entire.
    const step = whole ? Math.max(1, Math.floor(all.length / TARGET_SEGMENTS)) : 1;
    const pts = [];
    for (let i = 0; i < all.length; i += step) pts.push(all[i]);
    const n = pts.length;
    if (n < 8) return null;

    const ang = -principalAngle(all);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);

    let minEl = Infinity;
    let maxEl = -Infinity;
    for (const p of all) {
      const e = isNum(p[2]) ? p[2] : 0;
      if (e < minEl) minEl = e;
      if (e > maxEl) maxEl = e;
    }
    const rise = maxEl - minEl;

    // The road's two edges, `half` metres either side of the path.
    const half = Math.max(map.halfWidthM > 0 ? map.halfWidthM : 6, 4);
    const rails = new Array(n);
    let fullMinX = Infinity;
    let fullMaxX = -Infinity;
    let fullMinY = Infinity;
    let fullMaxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[(i - 1 + n) % n];
      const b = pts[(i + 1) % n];
      const tx = b[0] - a[0];
      const tz = b[1] - a[1];
      const len = Math.hypot(tx, tz) || 1;
      const nx = (tz / len) * half;
      const nz = (-tx / len) * half;
      const r = {
        lu: viewU(p[0] + nx, p[1] + nz, ca, sa),
        lv: viewV(p[0] + nx, p[1] + nz, ca, sa),
        ru: viewU(p[0] - nx, p[1] - nz, ca, sa),
        rv: viewV(p[0] - nx, p[1] - nz, ca, sa),
        e: isNum(p[2]) ? p[2] : minEl,
      };
      rails[i] = r;
      fullMinX = Math.min(fullMinX, r.lu, r.ru);
      fullMaxX = Math.max(fullMaxX, r.lu, r.ru);
      fullMinY = Math.min(fullMinY, r.lv, r.rv);
      fullMaxY = Math.max(fullMaxY, r.lv, r.rv);
    }

    /** Fit a view-space box into the canvas, and say how many px a metre is. */
    const fit = (x0, x1, y0, y1, margin) => {
      const mx = (x1 - x0) * margin;
      const my = (y1 - y0) * margin;
      const boxW = Math.max(1, x1 - x0 + mx * 2);
      const boxH = Math.max(1, y1 - y0 + my * 2);
      return Math.min((w - MAP_PAD * 2) / boxW, (h - MAP_PAD * 2) / boxH);
    };
    const wholeScale = fit(fullMinX, fullMaxX, fullMinY, fullMaxY, FRAME_MARGIN_WHOLE);

    // Zoomed, the fit comes from the stations INSIDE the window — which is
    // what makes clicking a corner arrive at that corner, rather than at a
    // larger picture of the whole circuit with the corner somewhere in it.
    let minX = fullMinX;
    let maxX = fullMaxX;
    let minY = fullMinY;
    let maxY = fullMaxY;
    if (!whole) {
      minX = Infinity; maxX = -Infinity; minY = Infinity; maxY = -Infinity;
      const lo = Math.floor(from01 * n);
      const hi = Math.ceil(to01 * n);
      for (let i = lo; i <= hi; i++) {
        const r = rails[((i % n) + n) % n];
        minX = Math.min(minX, r.lu, r.ru);
        maxX = Math.max(maxX, r.lu, r.ru);
        minY = Math.min(minY, r.lv, r.rv);
        maxY = Math.max(maxY, r.lv, r.rv);
      }
    }
    const scale = whole ? wholeScale : fit(minX, maxX, minY, maxY, FRAME_MARGIN);
    const offX = w / 2 - ((minX + maxX) / 2) * scale;
    const offY = h / 2 - ((minY + maxY) / 2) * scale;

    const screen = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = rails[i];
      screen[i] = {
        lx: r.lu * scale + offX, ly: r.lv * scale + offY,
        rx: r.ru * scale + offX, ry: r.rv * scale + offY,
        e: r.e,
        // Higher ground sorts as nearer. Looking straight down, that is simply
        // true, and it is what puts a bridge over the road it crosses.
        depth: r.e,
      };
    }

    // How wide the road actually lands. A whole circuit in a 380 px box runs
    // at a fraction of a pixel per metre, where a real 12 m road is a hairline
    // — every printed circuit map exaggerates the road for the same reason.
    // Zoomed in, where the width is being read against a driven line, the
    // scale is already large and this does nothing at all.
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
      roadPx *= widen;
    }

    return {
      screen, n, scale, wholeScale, offX, offY, ca, sa,
      zoom: wholeScale > 0 ? scale / wholeScale : 1,
      minEl, maxEl, rise, points: all,
      /** Half the road, in px — how near a click has to land to count. */
      hitPx: Math.max(30, roadPx * 0.75),
      /** World position -> canvas position, through the same transform. */
      project(x, zz) {
        return {
          x: viewU(x, zz, ca, sa) * scale + offX,
          y: viewV(x, zz, ca, sa) * scale + offY,
        };
      },
    };
  }

  /** The road's colour at a station: pale for high ground, dark for low. */
  function roadShade(g, e) {
    if (!(g.rise > 0.5)) {
      return `rgb(${ROAD_FLAT[0]},${ROAD_FLAT[1]},${ROAD_FLAT[2]})`;
    }
    const k = clamp((e - g.minEl) / g.rise, 0, 1);
    const c = (i) => Math.round(ROAD_LOW[i] + (ROAD_HIGH[i] - ROAD_LOW[i]) * k);
    return `rgb(${c(0)},${c(1)},${c(2)})`;
  }

  /** One quad, filled — and stroked in its own colour to close the seam. */
  function quad(ctx, ax, ay, bx, by, cx, cy, dx, dy, style) {
    ctx.fillStyle = style;
    ctx.strokeStyle = style;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(cx, cy);
    ctx.lineTo(dx, dy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  /**
   * Paint the road: one quad per segment, shaded by the ground it runs over,
   * then both edges drawn round the outside.
   *
   * Low ground first, so where a circuit crosses itself the bridge is laid
   * over the road beneath it. The edges go on afterwards in one pass, because
   * they are what a driven line is measured against and a line broken into
   * three hundred segments reads as texture rather than as a kerb.
   */
  function paintPlan(ctx, g) {
    const s = g.screen;
    const n = g.n;
    const order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    if (g.rise > 0.5) order.sort((a, b) => s[a].e - s[b].e);

    for (let k = 0; k < n; k++) {
      const i = order[k];
      const j = (i + 1) % n;
      const a = s[i];
      const b = s[j];
      quad(ctx, a.lx, a.ly, b.lx, b.ly, b.rx, b.ry, a.rx, a.ry,
        roadShade(g, (a.e + b.e) / 2));
    }

    ctx.strokeStyle = ROAD_EDGE;
    ctx.lineWidth = 1;
    for (const side of ['l', 'r']) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const sc = s[i % n];
        const x = side === 'l' ? sc.lx : sc.rx;
        const y = side === 'l' ? sc.ly : sc.ry;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  /**
   * The last road painted, kept as a bitmap.
   *
   * The surface is a few hundred fills and the scrub cursor repaints this
   * canvas on every mouse move. Rendering it once and blitting it after is the
   * same trick the in-car map plays for the same reason, and it is what makes
   * moving across the charts feel like moving a cursor rather than re-drawing
   * a circuit. One entry, because only one map is ever on screen.
   *
   * The key includes the window, so zooming rebuilds and scrubbing does not.
   */
  let planCache = null;

  function planFor(map, w, h, wFrom, wTo) {
    const key = `${w}x${h}|${wFrom.toFixed(4)}|${wTo.toFixed(4)}`;
    // Identity as well as the key: two circuits can agree on every field in a
    // key and still be different shapes, and the renderer holds one map object
    // for as long as it is looking at one circuit — so this is both cheaper
    // and stricter than hashing the points would be.
    if (planCache && planCache.map === map && planCache.key === key) return planCache;

    const g = buildPlan(map, w, h, wFrom, wTo);
    if (!g) return null;
    // The whole-lap fit is kept alongside the framed one: it is what the
    // locator inset is drawn from, and rebuilding it per repaint would be the
    // whole projection run twice for a thumbnail.
    const probe = g.zoom > 1.02 ? buildPlan(map, w, h, 0, 1) : g;

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
        paintPlan(ox, g);
        bitmap = off;
      }
    }
    planCache = { key, map, g, bitmap, probe, zoom: g.zoom };
    return planCache;
  }

  /**
   * How far is that, then.
   *
   * A plan view has a scale, so it can say so — and once it does, "the two
   * lines are a car's width apart here" stops being a guess. It is the one
   * thing the raised map could never carry, because nothing on it was to a
   * single scale.
   */
  function drawScaleBar(ctx, g, w, h) {
    const metres = (w * 0.22) / g.scale;
    let pick = null;
    for (const m of NICE_M) { if (m >= metres) { pick = m; break; } }
    if (pick === null) return;
    const px = pick * g.scale;
    if (!(px > 16) || px > w * 0.55) return;
    const x = MAP_PAD;
    const y = h - MAP_PAD;
    ctx.save();
    ctx.strokeStyle = 'rgba(154,164,184,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = CSS.text3;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${pick} m`, x, y - 6);
    ctx.restore();
  }

  /** The sample of a trace nearest a lap distance, or -1. */
  function sampleAtDistance(tr, dd) {
    if (!tr || !Array.isArray(tr.d) || tr.d.length < 2) return -1;
    let lo = 0;
    let hi = tr.d.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tr.d[mid] < dd) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(tr.d[lo - 1] - dd) < Math.abs(tr.d[lo] - dd)) return lo - 1;
    return lo;
  }

  /** A car on the map: a filled disc with a ring, so it reads on any surface. */
  function marker(ctx, x, y, colour, r, ring) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, ring, 0, Math.PI * 2);
    ctx.stroke();
  }

  /**
   * The circuit, with the lap on it.
   *
   * The road is drawn in plan and to scale — see {@link buildPlan} — and the
   * two driven lines go on top of it in the colours the charts already use:
   * cyan for the lap being studied, violet for the one it is being compared
   * with. Both solid. The charts dash the reference because a dashed line
   * reads as "underneath"; on a map a dash breaks the SHAPE of a line, which
   * here is the whole information.
   *
   * A v1 trace has no line. The cursor is then placed on the CENTRELINE at the
   * right distance, which is true and useful ("this is the corner you are
   * looking at") — the same fallback the pit wall's map has always used for a
   * car it has no position for. What is never done is inventing a line from
   * the centreline and showing it as the driver's.
   *
   * `opts.window` frames: the box is fitted to the stretch of road the window
   * names, so clicking a corner takes the map to that corner.
   */
  function drawLapMap(canvas, map, trace, opts) {
    const { ctx, w, h } = surface(canvas);
    const pts = map && Array.isArray(map.points) ? map.points : [];
    if (pts.length < 8) return null;
    const o = opts || {};
    const [wFrom, wTo] = windowOf(o);

    const cached = planFor(map, w, h, wFrom, wTo);
    if (!cached) return null;
    const g = cached.g;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (cached.bitmap) ctx.drawImage(cached.bitmap, 0, 0, w, h);
    else paintPlan(ctx, g);
    if (g.zoom > 1.05) drawLocator(ctx, cached.probe, w, h, wFrom, wTo, o.cursorD);
    drawScaleBar(ctx, g, w, h);

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

    // Wider lines the closer the look. Whole, they are threads laid on a
    // circuit and the road has to stay visible under them; zoomed, they are
    // the two things on the screen and everything else is context.
    const lineW = clamp(1.1 + g.zoom * 0.3, 1.4, 3.2);

    /** One driven line. */
    const line = (tr, style, width) => {
      if (!tr || !Array.isArray(tr.x) || !Array.isArray(tr.z)) return false;
      if (tr.x.length < 2 || tr.x.length !== tr.z.length) return false;
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i < tr.x.length; i++) {
        const p = g.project(tr.x[i], tr.z[i]);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      return true;
    };

    // The comparison lap first, so the studied lap is the one on top wherever
    // they touch — it is the subject, not the reference.
    const vsPlaced = line(o.vs, CSS.compare, lineW * 0.85);
    const placed = line(trace, CSS.cyan, lineW);

    // The cars: where each lap was at this point of the road. The real
    // position when the lap was placed, otherwise the point on the centreline
    // at that distance.
    if (typeof o.cursorD === 'number' && o.cursorD >= 0) {
      if (vsPlaced) {
        const j = sampleAtDistance(o.vs, o.cursorD);
        if (j >= 0 && j < o.vs.x.length) {
          const q = g.project(o.vs.x[j], o.vs.z[j]);
          marker(ctx, q.x, q.y, CSS.compare, 3.2, 6);
        }
      }
      let p;
      const i = o.cursorIndex;
      if (placed && typeof i === 'number' && i >= 0 && i < trace.x.length) {
        p = g.project(trace.x[i], trace.z[i]);
      } else {
        const k = Math.min(pts.length - 1, Math.max(0, Math.floor(o.cursorD * pts.length)));
        p = g.project(pts[k][0], pts[k][1]);
      }
      marker(ctx, p.x, p.y, CSS.cyan, 4, 7.5);
    }

    return {
      minY: g.minEl,
      maxY: g.maxEl,
      shaded: g.rise > 0.5,
      placed,
      zoom: g.zoom,
      metresPerPx: g.scale > 0 ? 1 / g.scale : null,
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
   * Drawn from the whole-lap projection rather than from the plan, so the
   * outline is the same shape as the map above it and not a second,
   * differently-rotated view of the same circuit.
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
   * higher of two crossing roads wins, which is the one the eye was on.
   *
   * How near counts scales with the road: zoomed into a corner, the edge of a
   * twelve-metre road can be a hundred pixels from its own centreline, and a
   * fixed threshold would ignore a click on the outside of the kerb.
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
    if (!best || best.dist > (geom.hitPx || 42)) return null;
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
          key: 'speedKph', color: CSS.cyan, cmp: '#bfe9fb',
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
          { key: 'throttle', color: CSS.ok, cmp: '#b6f0cf', scale: 100, fill: 'rgba(53,208,127,0.12)' },
          { key: 'brake', color: CSS.bad, cmp: '#ffbcc8', scale: 100, fill: 'rgba(255,84,112,0.12)' },
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
