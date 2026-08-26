/**
 * team-charts.js — the Team tab's canvas painters.
 * -----------------------------------------------------------------------------
 * Three charts, no library (the panel's CSP forbids one, and none is needed):
 *
 *   drawPositions(canvas, history, opts) — race position changes per lap
 *   drawLapTimes(canvas, history, opts)  — lap-time progression per driver
 *   drawTrackMap(canvas, shape, cars, classOf, opts) — the learned circuit
 *     with every car placed on it
 *
 * All painters are DPR-aware and size themselves from the canvas's CSS box on
 * every call — the Team page repaints at 1 Hz, so there is no resize
 * observer, just an honest re-measure each second.
 *
 * Colours: drivers get a fixed 20-colour cycle by grid slot (stable within a
 * session, distinct enough side by side); classes keep the four LMU liveries
 * used for map dots and the timing sheet.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_TEAM_CHARTS = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const DRIVER_COLORS = [
    '#26bbf4', '#ff8a3d', '#35d07f', '#ff5470', '#a78bfa',
    '#f4d03f', '#4d7cfe', '#2dd4bf', '#fb7185', '#c084fc',
    '#93c5fd', '#fdba74', '#86efac', '#f9a8d4', '#7dd3fc',
    '#fca5a5', '#6ee7b7', '#fde047', '#a5b4fc', '#e2e8f0',
  ];

  const CLASS_COLORS = {
    hypercar: '#ff5470',
    lmh: '#ff5470',
    lmdh: '#ff5470',
    lmp2: '#4d7cfe',
    lmp3: '#a78bfa',
    lmgt3: '#35d07f',
    gt3: '#35d07f',
    gte: '#ffb020',
  };

  function driverColor(i) {
    return DRIVER_COLORS[((i % DRIVER_COLORS.length) + DRIVER_COLORS.length) % DRIVER_COLORS.length];
  }

  function classColor(cls) {
    if (!cls) return '#8aa0b8';
    const key = String(cls).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const k of Object.keys(CLASS_COLORS)) {
      if (key.includes(k)) return CLASS_COLORS[k];
    }
    return '#8aa0b8';
  }

  /** Prepare a canvas for drawing at device resolution; returns {ctx, w, h}. */
  function surface(canvas) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 320;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  const AXIS = '#5b6b7d';
  const GRID = 'rgba(91,107,125,0.18)';
  const FONT = '10px "Segoe UI", system-ui, sans-serif';

  function drawEmpty(ctx, w, h, text) {
    ctx.fillStyle = AXIS;
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2);
  }

  /* ---------------------------------------------------------------------- */
  /*  Positions                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * @param history  TeamHistory.state(): {cars:[{slotId,name,cls,isPlayer,laps:[{lap,pos,clsPos}]}]}
   * @param opts     {mode:'overall'|'class', hidden:Set<slotId>, colorOf:(car,i)=>color}
   */
  function drawPositions(canvas, history, opts = {}) {
    const { ctx, w, h } = surface(canvas);
    const cars = (history && history.cars ? history.cars : []).filter(
      (c) => c.laps && c.laps.length,
    );
    if (!cars.length) return drawEmpty(ctx, w, h, 'Positions appear as laps complete.');

    const mode = opts.mode === 'class' ? 'clsPos' : 'pos';
    const hidden = opts.hidden || new Set();
    let maxLap = 1;
    let maxPos = 1;
    for (const c of cars) {
      for (const l of c.laps) {
        if (l.lap > maxLap) maxLap = l.lap;
        const p = l[mode];
        if (p && p > maxPos) maxPos = p;
      }
    }
    const padL = 34, padR = 10, padT = 8, padB = 24;
    const x = (lap) => padL + ((w - padL - padR) * (maxLap <= 1 ? 1 : (lap - 1) / (maxLap - 1)));
    const y = (pos) => padT + ((h - padT - padB) * (maxPos <= 1 ? 0 : (pos - 1) / (maxPos - 1)));

    // Grid: a line each five positions, a lap tick each ~10 labels.
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = AXIS;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (let p = 1; p <= maxPos; p += p === 1 ? 4 : 5) {
      ctx.beginPath();
      ctx.moveTo(padL, y(p));
      ctx.lineTo(w - padR, y(p));
      ctx.stroke();
      ctx.fillText(`P${p}`, padL - 4, y(p) + 3);
    }
    ctx.textAlign = 'center';
    const lapStep = Math.max(1, Math.ceil(maxLap / 14));
    for (let lap = 1; lap <= maxLap; lap += lapStep) {
      ctx.fillText(String(lap), x(lap), h - 8);
    }

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (hidden.has(c.slotId)) continue;
      const color = opts.colorOf ? opts.colorOf(c, i) : driverColor(i);
      ctx.strokeStyle = color;
      ctx.lineWidth = c.isPlayer ? 2.5 : 1.25;
      ctx.globalAlpha = c.isPlayer ? 1 : 0.85;
      ctx.beginPath();
      let started = false;
      for (const l of c.laps) {
        const p = l[mode];
        if (!p) continue;
        const px = x(l.lap), py = y(p);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Lap times                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * @param opts {selected:Set<slotId>, colorOf:(car,i)=>color}
   * The y-range clamps to the 5th–95th percentile of the plotted laps so one
   * pit stop does not flatten every racing lap into a line.
   */
  function drawLapTimes(canvas, history, opts = {}) {
    const { ctx, w, h } = surface(canvas);
    const selected = opts.selected || new Set();
    const cars = (history && history.cars ? history.cars : []).filter(
      (c) => selected.has(c.slotId) && c.laps && c.laps.some((l) => l.lastSec),
    );
    if (!cars.length) return drawEmpty(ctx, w, h, 'Pick drivers below to compare lap times.');

    const secs = [];
    let maxLap = 1;
    for (const c of cars) {
      for (const l of c.laps) {
        if (l.lastSec) secs.push(l.lastSec);
        if (l.lap > maxLap) maxLap = l.lap;
      }
    }
    secs.sort((a, b) => a - b);
    const q = (f) => secs[Math.min(secs.length - 1, Math.floor(f * secs.length))];
    const lo = q(0.02) - 0.5;
    const hi = Math.min(q(0.95) + 1.5, q(0.02) * 1.12); // pit laps clamp, honestly
    const padL = 46, padR = 10, padT = 8, padB = 24;
    const x = (lap) => padL + ((w - padL - padR) * (maxLap <= 1 ? 1 : (lap - 1) / (maxLap - 1)));
    const y = (s) => {
      const t = (s - lo) / Math.max(0.001, hi - lo);
      return padT + (h - padT - padB) * Math.min(1, Math.max(0, t));
    };

    const fmt = (s) => {
      const m = Math.floor(s / 60);
      return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
    };
    ctx.font = FONT;
    ctx.fillStyle = AXIS;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const s = lo + ((hi - lo) * i) / 4;
      const py = y(s);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(w - padR, py);
      ctx.stroke();
      ctx.fillText(fmt(s), padL - 4, py + 3);
    }
    ctx.textAlign = 'center';
    const lapStep = Math.max(1, Math.ceil(maxLap / 14));
    for (let lap = 1; lap <= maxLap; lap += lapStep) ctx.fillText(String(lap), x(lap), h - 8);

    const all = history.cars;
    for (const c of cars) {
      const idx = all.indexOf(c);
      ctx.strokeStyle = opts.colorOf ? opts.colorOf(c, idx) : driverColor(idx);
      ctx.lineWidth = c.isPlayer ? 2.5 : 1.5;
      ctx.beginPath();
      let started = false;
      for (const l of c.laps) {
        if (!l.lastSec) { started = false; continue; } // gap through unknown laps
        const px = x(l.lap), py = y(l.lastSec);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Track map                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * @param shape   {points:[[x,z],...], lengthM} from main's /trackmap.json fetch
   * @param cars    snapshot.trackMap.cars — {slotId,x,z,lapFraction,inPit,isPlayer}
   * @param classOf (slotId) => class string, for dot colours
   */
  function drawTrackMap(canvas, shape, cars, classOf, opts = {}) {
    const { ctx, w, h } = surface(canvas);
    const pts = shape && Array.isArray(shape.points) ? shape.points : [];
    if (pts.length < 8) {
      return drawEmpty(ctx, w, h, opts.progressText || 'Track map appears once a lap has been learned.');
    }

    // Fit the shape into the canvas, preserving aspect, 24px margin.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
    }
    const margin = 24;
    const sx = (w - margin * 2) / Math.max(1, maxX - minX);
    const sz = (h - margin * 2) / Math.max(1, maxZ - minZ);
    const scale = Math.min(sx, sz);
    const ox = (w - (maxX - minX) * scale) / 2;
    const oz = (h - (maxZ - minZ) * scale) / 2;
    const px = (x) => ox + (x - minX) * scale;
    // The sim's Z axis vs the canvas' downward Y: plotted straight, every
    // circuit draws as its own MIRROR IMAGE — left-handers become
    // right-handers. The overlay's track map corrects the same handedness with
    // one sign (overlay/js/widgets/trackmap.js viewV); flipping Z here fixes
    // the ribbon and every car dot together, since both go through this pair.
    const pz = (z) => oz + (maxZ - z) * scale;

    // Road ribbon + centreline.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(px(pts[0][0]), pz(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(px(pts[i][0]), pz(pts[i][1]));
    ctx.closePath();
    ctx.strokeStyle = 'rgba(120,140,160,0.28)';
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(180,200,220,0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Start/finish tick at the first point.
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 3;
    const sfx = px(pts[0][0]), sfz = pz(pts[0][1]);
    ctx.beginPath();
    ctx.moveTo(sfx - 6, sfz - 6);
    ctx.lineTo(sfx + 6, sfz + 6);
    ctx.stroke();

    // Cars: true x/z when published, else the lapFraction point on the path.
    const place = (c) => {
      if (typeof c.x === 'number' && typeof c.z === 'number') return [px(c.x), pz(c.z)];
      if (typeof c.lapFraction === 'number') {
        const i = Math.min(pts.length - 1, Math.max(0, Math.floor(c.lapFraction * pts.length)));
        return [px(pts[i][0]), pz(pts[i][1])];
      }
      return null;
    };
    const list = Array.isArray(cars) ? cars : [];
    for (const c of list) {
      if (c.isPlayer) continue; // drawn last, on top
      const at = place(c);
      if (!at) continue;
      ctx.globalAlpha = c.inPit ? 0.35 : 1;
      ctx.fillStyle = classColor(classOf ? classOf(c.slotId) : '');
      ctx.beginPath();
      ctx.arc(at[0], at[1], 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    const me = list.find((c) => c.isPlayer);
    if (me) {
      const at = place(me);
      if (at) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(at[0], at[1], 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#26bbf4';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(at[0], at[1], 8.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  return { drawPositions, drawLapTimes, drawTrackMap, driverColor, classColor };
});
