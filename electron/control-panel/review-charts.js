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
  /*  Phase 2 — one lap                                                       */
  /* ======================================================================== */

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
   */
  function drawChannels(canvas, trace, bands, opts) {
    const { ctx, w, h } = surface(canvas);
    const d = trace.d || [];
    if (d.length < 2 || !bands.length) return null;

    const o = opts || {};
    const padL = 46;
    const padR = 8;
    const padT = 4;
    const padB = 16;
    const gap = 8;
    const x0 = padL;
    const x1 = w - padR;
    const plotW = Math.max(1, x1 - x0);
    const total = bands.reduce((a, b) => a + (b.weight || 1), 0);
    const usable = Math.max(1, h - padT - padB - gap * (bands.length - 1));

    const px = (dd) => x0 + Math.min(1, Math.max(0, dd)) * plotW;

    const out = { x0, x1, bands: [] };
    let y = padT;

    for (const band of bands) {
      const bh = (usable * (band.weight || 1)) / total;
      const y0 = y;
      const y1 = y + bh;
      out.bands.push({ y0, y1, label: band.label });

      // Each band sits on its own faint plate, so a glance separates them
      // without a border per band shouting for attention.
      ctx.fillStyle = 'rgba(255,255,255,0.014)';
      ctx.fillRect(x0, y0, plotW, bh);

      // Range: given, or measured from the columns this band draws.
      let lo = band.min;
      let hi = band.max;
      if (lo === undefined || hi === undefined) {
        let mn = Infinity;
        let mx = -Infinity;
        for (const s of band.series) {
          const col = trace[s.key];
          if (!Array.isArray(col)) continue;
          for (const v of col) {
            const q = v * (s.scale || 1);
            if (q < mn) mn = q;
            if (q > mx) mx = q;
          }
        }
        if (mn === Infinity) { mn = 0; mx = 1; }
        if (mx - mn < 1e-6) { mn -= 1; mx += 1; }
        if (lo === undefined) lo = band.fromZero ? Math.min(0, mn) : mn - (mx - mn) * 0.08;
        if (hi === undefined) hi = mx + (mx - mn) * 0.08;
        // A channel that swings both ways has to keep zero in the middle, or
        // the rule drawn at zero is not the middle and every glance misreads
        // which way the wheel was turned. `floor` stops a lap round Indy
        // scaling a millimetre of steering correction up into a full lock.
        if (band.symmetric) {
          const reach = Math.max(Math.abs(lo), Math.abs(hi), band.floor || 0);
          lo = -reach;
          hi = reach;
        }
      }
      const py = (v) => y1 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * bh;

      // A zero rule where zero means something — steering, and longitudinal G.
      if (band.zero && lo < 0 && hi > 0) {
        const zy = Math.round(py(0)) + 0.5;
        ctx.strokeStyle = CSS.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, zy);
        ctx.lineTo(x1, zy);
        ctx.stroke();
      }

      for (const s of band.series) {
        const col = trace[s.key];
        if (!Array.isArray(col) || col.length !== d.length) continue;
        const scale = s.scale || 1;
        const trace1 = () => {
          if (s.step) {
            // Gear is a step, not a slope: the gearbox does not sweep between
            // third and fourth, and a ramp claims a moment that never happened.
            ctx.moveTo(px(d[0]), py(col[0] * scale));
            for (let i = 1; i < col.length; i++) {
              ctx.lineTo(px(d[i]), py(col[i - 1] * scale));
              ctx.lineTo(px(d[i]), py(col[i] * scale));
            }
          } else {
            ctx.moveTo(px(d[0]), py(col[0] * scale));
            for (let i = 1; i < col.length; i++) ctx.lineTo(px(d[i]), py(col[i] * scale));
          }
        };
        if (s.fill) {
          ctx.beginPath();
          trace1();
          const base = py(Math.max(lo, 0));
          ctx.lineTo(px(d[d.length - 1]), base);
          ctx.lineTo(px(d[0]), base);
          ctx.closePath();
          ctx.fillStyle = s.fill;
          ctx.fill();
        }
        ctx.beginPath();
        trace1();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width || 1.4;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      // Intervention ticks along the floor of the band: where the electronics
      // were doing the driving. Nothing else on the page says this, it costs no
      // vertical space, and "the car saved me there" is exactly the sort of
      // thing a driver cannot feel afterwards.
      for (const mark of band.marks || []) {
        const col = trace[mark.key];
        if (!Array.isArray(col) || col.length !== d.length) continue;
        ctx.strokeStyle = mark.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < col.length; i++) {
          if (!(col[i] > 0.02)) continue;
          const mx = px(d[i]);
          ctx.moveTo(mx, y1 - 3);
          ctx.lineTo(mx, y1);
        }
        ctx.stroke();
      }

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
      if (typeof m.d !== 'number' || m.d <= 0) continue;
      const mx = Math.round(px(m.d)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(mx, top);
      ctx.lineTo(mx, bottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = '9px Bahnschrift, "Segoe UI", sans-serif';
    ctx.fillStyle = CSS.text3;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (const m of marks) {
      if (typeof m.d !== 'number' || m.d < 0) continue;
      ctx.fillText(m.name, px(m.d) + 4, h - 3);
    }

    // The x axis is lap distance, and a driver thinks in metres round a lap.
    if (o.lengthM > 0) {
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(o.lengthM)} m`, x1, h - 3);
    }

    // The cursor, last, over everything.
    if (typeof o.cursorD === 'number' && o.cursorD >= 0) {
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
   * The circuit, with the lap on it.
   *
   * Three layers: the road, shaded by elevation; the driven line when the trace
   * carries one; and the cursor. The Z axis is flipped exactly as
   * `team-charts.drawTrackMap` flips it — plotted straight, every circuit draws
   * as its own mirror image and left-handers become right-handers.
   *
   * A v1 trace has no line. The cursor is then placed on the CENTRELINE at the
   * right distance, which is true and useful ("this is the corner you are
   * looking at") — the same fallback the pit wall's map has always used for a
   * car it has no position for. What is never done is inventing a line from the
   * centreline and showing it as the driver's.
   */
  function drawLapMap(canvas, map, trace, opts) {
    const { ctx, w, h } = surface(canvas);
    const pts = map && Array.isArray(map.points) ? map.points : [];
    if (pts.length < 8) return null;
    const o = opts || {};

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
      const e = p[2];
      if (typeof e === 'number' && Number.isFinite(e)) {
        if (e < minY) minY = e;
        if (e > maxY) maxY = e;
      }
    }
    const margin = 18;
    const scale = Math.min(
      (w - margin * 2) / Math.max(1, maxX - minX),
      (h - margin * 2) / Math.max(1, maxZ - minZ),
    );
    const ox = (w - (maxX - minX) * scale) / 2 - minX * scale;
    const oz = (h - (maxZ - minZ) * scale) / 2;
    const px = (x) => ox + x * scale;
    const pz = (z) => oz + (maxZ - z) * scale;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // The road, one segment at a time so elevation can shade it. Cold blue at
    // the lowest point on the circuit, warm at the highest — which at Spa puts
    // Eau Rouge on the screen with no words at all.
    const rise = maxY - minY;
    const shaded = Number.isFinite(rise) && rise > 3;
    ctx.lineWidth = 9;
    if (shaded) {
      for (let i = 1; i <= pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i % pts.length];
        const f = ((a[2] + b[2]) / 2 - minY) / rise;
        ctx.strokeStyle = `rgba(${Math.round(64 + f * 136)},${Math.round(92 + f * 64)},${Math.round(168 - f * 48)},0.44)`;
        ctx.beginPath();
        ctx.moveTo(px(a[0]), pz(a[1]));
        ctx.lineTo(px(b[0]), pz(b[1]));
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = 'rgba(120,140,160,0.30)';
      ctx.beginPath();
      ctx.moveTo(px(pts[0][0]), pz(pts[0][1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(px(pts[i][0]), pz(pts[i][1]));
      ctx.closePath();
      ctx.stroke();
    }

    // The centreline over it, thin. Without it the shaded ribbon alone reads as
    // a smear at small sizes; muted when a driven line has to sit on top.
    const placed =
      trace && Array.isArray(trace.x) && Array.isArray(trace.z)
      && trace.x.length === trace.z.length && trace.x.length > 1;
    ctx.strokeStyle = placed ? 'rgba(160,180,200,0.28)' : 'rgba(180,200,220,0.72)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(px(pts[0][0]), pz(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(px(pts[i][0]), pz(pts[i][1]));
    ctx.closePath();
    ctx.stroke();

    // Sector lines, as ticks across the road at the right distance.
    for (const dd of [0, o.sectors ? o.sectors.s1 : null, o.sectors ? o.sectors.s2 : null]) {
      if (typeof dd !== 'number' || dd < 0) continue;
      const i = Math.min(pts.length - 1, Math.max(0, Math.round(dd * pts.length)));
      const j = (i + 1) % pts.length;
      const dx = pts[j][0] - pts[i][0];
      const dz = pts[j][1] - pts[i][1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = (-dz / len) * 9;
      const nz = (dx / len) * 9;
      ctx.strokeStyle = dd === 0 ? '#e2e8f0' : 'rgba(226,232,240,0.5)';
      ctx.lineWidth = dd === 0 ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(px(pts[i][0]) + nx, pz(pts[i][1]) + nz);
      ctx.lineTo(px(pts[i][0]) - nx, pz(pts[i][1]) - nz);
      ctx.stroke();
    }

    if (placed) {
      ctx.strokeStyle = CSS.cyan;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(px(trace.x[0]), pz(trace.z[0]));
      for (let i = 1; i < trace.x.length; i++) ctx.lineTo(px(trace.x[i]), pz(trace.z[i]));
      ctx.stroke();
    }

    // The cursor: the real position when the lap was placed, otherwise the
    // point on the centreline at that distance.
    if (typeof o.cursorD === 'number' && o.cursorD >= 0) {
      let cx;
      let cz;
      const i = o.cursorIndex;
      if (placed && typeof i === 'number' && i >= 0 && i < trace.x.length) {
        cx = px(trace.x[i]);
        cz = pz(trace.z[i]);
      } else {
        const k = Math.min(pts.length - 1, Math.max(0, Math.floor(o.cursorD * pts.length)));
        cx = px(pts[k][0]);
        cz = pz(pts[k][1]);
      }
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cz, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = CSS.cyan;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cz, 7.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    return { minY, maxY, shaded, placed };
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
   * The spec lives here rather than in the panel because it is half colour: the
   * palette belongs with the painter that uses it.
   */
  function channelBands(opts) {
    const mph = opts && opts.mph;
    return [
      {
        label: 'Speed',
        weight: 1.35,
        fromZero: true,
        min: 0,
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
    ];
  }

  return { drawLapChart, drawTrend, drawChannels, drawLapMap, channelBands };
});

