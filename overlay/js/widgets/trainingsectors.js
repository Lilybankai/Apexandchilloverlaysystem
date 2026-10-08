/**
 * trainingsectors.js — Lap strip: where this lap is being won and lost.
 * -----------------------------------------------------------------------------
 * One card across the top of the screen, read left to right:
 *
 *   - Who is being chased: "VS A. WINTERS", and the reference lap's time.
 *   - S1 / S2 / S3. A finished sector shows its delta in the gain or loss
 *     colour and the time you did it in (the reference's split plus that
 *     delta). The sector you are in is lit cyan: its delta and its clock
 *     running, and a bar for how far through it you are. A sector not reached
 *     yet this lap shows last lap's figures, stepped back, or a dash.
 *   - The lap gap, big, in its colour.
 *
 * Under them the whole lap as one line, start on the left: a dot for every
 * corner, coloured by the time this lap gained or lost there (last lap's,
 * faint, where this lap has not got to yet), ticks at the sector lines, and a
 * glowing cyan dot riding along with the car. Where the red dots cluster is
 * where the lap is going.
 *
 * Corner times come from the server (`frame.player.ghost.corner`, see
 * `cornerTracker.ts`); sector times are gap differences worked out here
 * (`training-laps.js`), at the reference lap's own sector lines when
 * `/ghost.json` carries them and learned from the car crossing them when not.
 *
 * Runs at 10 Hz. The numbers are DOM text written only when they change; the
 * lap line is a small canvas redrawn only when a dot, the car's pixel, or the
 * size changes.
 */
(function () {
  "use strict";

  var LAPS = window.ApexTrainingLaps;
  var GHOST = window.ApexTrainingGhost;

  /** Lap-line geometry, CSS px. */
  var LINE_H = 22;
  var TRACK_H = 4;
  var DOT_R = 4.5;
  var DOT_R_EMPTY = 3.5;
  var CAR_R = 6;
  var TICK_H = 14;
  var SIZE_CHECK_FRAMES = 20;

  var C = {
    gain: "#35d07f",
    loss: "#ff5470",
    text: "#f4f6fb",
    cyan: "#22d3ee",
  };
  var C_TRACK = "rgba(255,255,255,0.08)";
  var C_DONE = "rgba(34,211,238,0.35)";
  var C_TICK = "rgba(255,255,255,0.25)";
  var C_EMPTY = "rgba(255,255,255,0.22)";
  var C_RIM = "#0b0d16";
  var gainPrev = "";
  var lossPrev = "";
  var levelFill = "";

  /* -------------------------------- state --------------------------------- */

  var el = null;
  var headerMeta = null;
  var whoEl = null;
  var refEl = null;
  var secEls = [];
  var lapEl = null;
  var canvas = null;
  var gctx = null;
  var cssW = 0;
  var dpr = 1;
  var sizeTick = 0;

  var line = null;
  var cornerMid = null;
  var refSplit = [NaN, NaN, NaN];
  var sectors = LAPS ? LAPS.createSectors() : null;

  /** What the lap line last drew, so an unchanged one is not redrawn. */
  var drawn = { lap: null, prev: null, index: -2, inside: false, car: -1, ver: -1, lines: "" };
  var lineVer = 0;

  var cur = { label: "", who: "", ref: "", ready: "false", empty: "false" };

  /* -------------------------------- tokens -------------------------------- */

  function readTokens() {
    try {
      var cs = getComputedStyle(document.documentElement);
      var pick = function (name, fallback) {
        var v = cs.getPropertyValue(name).trim();
        return v || fallback;
      };
      C.gain = pick("--pos-gain", C.gain);
      C.loss = pick("--pos-loss", C.loss);
      C.text = pick("--text-primary", C.text);
      C.cyan = pick("--ac-cyan", C.cyan);
    } catch (e) {
      /* fallbacks stand */
    }
    gainPrev = withAlpha(C.gain, 0.32, "#35d07f");
    lossPrev = withAlpha(C.loss, 0.32, "#ff5470");
    levelFill = withAlpha(C.text, 0.5, "#f4f6fb");
  }

  function withAlpha(colour, a, fallbackHex) {
    var h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colour) ? colour.slice(1) : fallbackHex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  /* --------------------------------- line --------------------------------- */

  function setLine(data) {
    line = data;
    LAPS.resetSectors(sectors);
    cornerMid = null;
    if (data) {
      if (Array.isArray(data.sectorD)) LAPS.setLines(sectors, data.sectorD[0], data.sectorD[1]);
      if (Array.isArray(data.corners)) {
        var n = data.corners.length;
        cornerMid = new Float64Array(n);
        for (var i = 0; i < n; i++) cornerMid[i] = (data.corners[i].entryD + data.corners[i].exitD) / 2;
      }
    }
    splitsChanged();
    lineVer++;
  }

  function splitsChanged() {
    LAPS.refSplits(line, sectors.line[0], sectors.line[1], refSplit);
  }

  /** "28.412" under a minute, "1:02.304" over. */
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return "—";
    if (sec < 60) return sec.toFixed(3);
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ":" + (s < 10 ? "0" : "") + s.toFixed(3);
  }

  /**
   * "A. Winters · 1:19.299 · board" → name "A. WINTERS", time "1:19.299".
   * The label's own time is the official one (the trace's clock can differ
   * by a few hundredths); the trace's lap time stands in when it has none.
   */
  function parseLabel(label) {
    var parts = String(label || "").split(" · ");
    var name = (parts[0] || "").trim();
    var time = "";
    for (var i = 1; i < parts.length; i++) {
      if (/^\d+:\d{2}\.\d{2,3}$/.test(parts[i].trim())) {
        time = parts[i].trim();
        break;
      }
    }
    // A label that is only a time ("1:13.730") names nobody.
    if (/^\d+:\d{2}\.\d{2,3}$/.test(name)) {
      if (!time) time = name;
      name = "";
    }
    return { name: name.toUpperCase(), time: time };
  }

  /* ---------------------------------- DOM --------------------------------- */

  function setText(node, owner, key, value) {
    if (owner[key] === value) return;
    owner[key] = value;
    node.textContent = value;
  }

  function setData(node, owner, key, attr, value) {
    if (owner[key] === value) return;
    owner[key] = value;
    node.setAttribute(attr, value);
  }

  function setBar(s, frac) {
    var w = isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
    var v = Math.round(w * 200) / 2;
    if (s.bar === v) return;
    s.bar = v;
    s.barEl.style.width = v + "%";
  }

  /** Where sector `k` starts and ends, lap fractions. */
  function sectorSpan(k) {
    var a = k === 0 ? 0 : sectors.line[k - 1];
    var b = k === 2 ? 1 : sectors.line[k];
    return [a, b];
  }

  /**
   * One sector cell. Done this lap: its delta and time, solid. The live
   * one: delta and clock running, lit. Not reached yet: last lap's, stepped
   * back — still the best guess at what that sector will say.
   */
  function paintSector(k, d) {
    var s = secEls[k];
    var st = sectors;
    var state;
    var v;
    var time = NaN;
    if (st.live === k) {
      state = "live";
      v = st.liveDelta;
      var span = sectorSpan(k);
      var t0 = k === 0 ? 0 : LAPS.timeAt(line, span[0]);
      var tNow = LAPS.timeAt(line, d);
      // Your clock in this sector: the reference's, plus what you have lost.
      if (isFinite(t0) && isFinite(tNow) && isFinite(v)) time = tNow - t0 + v;
      setBar(s, span[1] > span[0] ? (d - span[0]) / (span[1] - span[0]) : NaN);
    } else if (isFinite(st.cur[k])) {
      state = "done";
      v = st.cur[k];
      time = refSplit[k] + v;
    } else if (st.live >= 0 && k < st.live) {
      state = "done"; // passed, but with no gap to score it on
      v = NaN;
    } else if (isFinite(st.prev[k])) {
      state = "prev";
      v = st.prev[k];
      time = refSplit[k] + v;
    } else {
      state = "pending";
      v = NaN;
    }
    setData(s.root, s, "state", "data-state", state);
    setData(s.deltaEl, s, "tone", "data-tone", LAPS.toneOf(v));
    setText(s.deltaEl, s, "text", LAPS.fmtSigned(v));
    setText(s.timeEl, s, "timeText", fmtTime(time));
  }

  /* ------------------------------- lap line ------------------------------- */

  function sizeLine() {
    if (!canvas) return false;
    var w = canvas.clientWidth;
    if (!w) return false;
    var d = window.ApexRaster.backingScale(canvas);
    if (w === cssW && d === dpr && canvas.width === Math.round(w * d)) return true;
    cssW = w;
    dpr = d;
    canvas.style.height = LINE_H + "px";
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(LINE_H * d);
    lineVer++;
    return true;
  }

  function dotFill(v, prev) {
    var tone = LAPS.toneOf(v);
    if (tone === "gain") return prev ? gainPrev : C.gain;
    if (tone === "loss") return prev ? lossPrev : C.loss;
    if (tone === "level") return prev ? C_EMPTY : levelFill;
    return C_EMPTY;
  }

  /**
   * The lap line. Redrawn only when something on it changed: a dot (the
   * arrays are replaced, never edited, when a corner is scored), the car
   * moving a half pixel, the sector lines or the size.
   */
  function drawLine(corner, atD) {
    if (!gctx || !sizeLine()) return;
    var lap = corner ? corner.lapCorners : null;
    var prev = corner ? corner.prevLapCorners : null;
    var index = corner ? corner.index : -1;
    var inside = corner ? !!corner.inside : false;
    var pad = CAR_R + 4;
    var span = cssW - pad * 2;
    var car = isFinite(atD) ? Math.round((pad + atD * span) * 2) / 2 : -1;
    var lines = sectors.line[0] + "|" + sectors.line[1];
    if (
      drawn.ver === lineVer &&
      drawn.lap === lap &&
      drawn.prev === prev &&
      drawn.index === index &&
      drawn.inside === inside &&
      drawn.car === car &&
      drawn.lines === lines
    ) {
      return;
    }
    drawn.ver = lineVer;
    drawn.lap = lap;
    drawn.prev = prev;
    drawn.index = index;
    drawn.inside = inside;
    drawn.car = car;
    drawn.lines = lines;

    var X = function (f) {
      return pad + f * span;
    };
    var y = LINE_H / 2;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, LINE_H);

    // The lap, and how much of it is behind the car.
    roundBar(X(0), y - TRACK_H / 2, span, TRACK_H, C_TRACK);
    if (car >= 0) roundBar(X(0), y - TRACK_H / 2, car - X(0), TRACK_H, C_DONE);

    // Sector lines.
    for (var k = 0; k < 2; k++) {
      var L = sectors.line[k];
      if (isFinite(L)) roundBar(Math.round(X(L)) - 1, y - TICK_H / 2, 2, TICK_H, C_TICK);
    }

    // A dot per corner: this lap's verdict, else last lap's faintly.
    if (cornerMid) {
      gctx.lineWidth = 2;
      gctx.strokeStyle = C_RIM;
      for (var i = 0; i < cornerMid.length; i++) {
        var v = lap && i < lap.length ? lap[i] : null;
        var have = v !== null && v !== undefined;
        var pv = !have && prev && i < prev.length ? prev[i] : null;
        var r = have ? DOT_R : DOT_R_EMPTY;
        gctx.fillStyle = have ? dotFill(v, false) : dotFill(pv, true);
        gctx.beginPath();
        gctx.arc(X(cornerMid[i]), y, r, 0, Math.PI * 2);
        gctx.fill();
        gctx.stroke();
        // The corner the car is in: a ring around its dot.
        if (inside && i === index) {
          gctx.strokeStyle = C.text;
          gctx.lineWidth = 1.5;
          gctx.beginPath();
          gctx.arc(X(cornerMid[i]), y, r + 3, 0, Math.PI * 2);
          gctx.stroke();
          gctx.lineWidth = 2;
          gctx.strokeStyle = C_RIM;
        }
      }
    }

    // The car: a cyan dot with a glow.
    if (car >= 0) {
      gctx.save();
      gctx.shadowColor = C.cyan;
      gctx.shadowBlur = 10;
      gctx.fillStyle = C.cyan;
      gctx.beginPath();
      gctx.arc(car, y, CAR_R, 0, Math.PI * 2);
      gctx.fill();
      gctx.restore();
      gctx.lineWidth = 2;
      gctx.strokeStyle = C_RIM;
      gctx.fillStyle = C.cyan;
      gctx.beginPath();
      gctx.arc(car, y, CAR_R, 0, Math.PI * 2);
      gctx.fill();
      gctx.stroke();
    }
  }

  function roundBar(x, y, w, h, fill) {
    if (!(w > 0)) return;
    var r = Math.min(h / 2, w / 2);
    gctx.fillStyle = fill;
    gctx.beginPath();
    gctx.moveTo(x + r, y);
    gctx.arcTo(x + w, y, x + w, y + h, r);
    gctx.arcTo(x + w, y + h, x, y + h, r);
    gctx.arcTo(x, y + h, x, y, r);
    gctx.arcTo(x, y, x + w, y, r);
    gctx.closePath();
    gctx.fill();
  }

  /* -------------------------------- update -------------------------------- */

  function playerRow(frame) {
    var rows = frame && frame.standings;
    if (!rows) return null;
    for (var i = 0; i < rows.length; i++) if (rows[i].isPlayer) return rows[i];
    return null;
  }

  function update(frame) {
    if (!el || !LAPS || !GHOST) return;
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) sizeLine();
    var ghost = frame && frame.player ? frame.player.ghost : null;
    GHOST.sync(ghost);

    var label = ghost && ghost.sourceLabel ? ghost.sourceLabel : "";
    if (label !== cur.label) {
      cur.label = label;
      if (headerMeta) headerMeta.textContent = label || "—";
      var who = parseLabel(label);
      setText(whoEl, cur, "who", who.name || "REFERENCE");
      var t = who.time || (line && line.lapSec > 0 ? fmtTime(line.lapSec) : "");
      setText(refEl, cur, "ref", t ? "REF " + t : "");
    } else if (!cur.ref && line && line.lapSec > 0) {
      setText(refEl, cur, "ref", "REF " + fmtTime(line.lapSec));
    }

    var d = ghost && typeof ghost.atD === "number" ? ghost.atD : NaN;
    var gap = ghost && ghost.active ? ghost.gapSec : NaN;
    if (line && isFinite(d)) {
      var row = playerRow(frame);
      if (row && LAPS.learnLine(sectors, row.sector, row.lapFraction, d, gap)) {
        splitsChanged();
      }
      LAPS.stepSectors(sectors, d, gap);
    }
    for (var k = 0; k < 3; k++) paintSector(k, d);
    setText(lapEl.deltaEl, lapEl, "text", LAPS.fmtSigned(gap));
    setData(lapEl.deltaEl, lapEl, "tone", "data-tone", LAPS.toneOf(gap));
    setData(el, cur, "ready", "data-ready", line ? "true" : "false");
    // No ghost (or its lap not here yet): say so, as the other training
    // cards do, rather than leave dashes that read as idle.
    setData(el, cur, "empty", "data-empty", ghost && line ? "false" : "true");
    drawLine(ghost ? ghost.corner : null, d);
  }

  /* --------------------------------- init --------------------------------- */

  function sectorCell(name) {
    return (
      '<div class="tlap__sec" data-state="pending">' +
      '<div class="tlap__top"><span class="tlap__name">' + name + "</span>" +
      '<span class="tlap__delta tw-tone" data-tone="none">—</span></div>' +
      '<div class="tlap__time">—</div>' +
      '<div class="tlap__bar"><div></div></div>' +
      "</div>"
    );
  }

  function init(root) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML =
      '<div class="tlap" data-ready="false" data-empty="false">' +
      '<div class="tlap__row">' +
      '<div class="tlap__who"><span class="tw-label">vs</span>' +
      '<b class="tlap__driver">REFERENCE</b><span class="tlap__ref"></span></div>' +
      sectorCell("S1") +
      sectorCell("S2") +
      sectorCell("S3") +
      '<div class="tlap__lap"><span class="tw-label">Lap</span>' +
      '<b class="tw-big" data-tone="none">—</b></div>' +
      "</div>" +
      '<canvas class="tlap__line" role="img" aria-label="The lap as a line, one dot per corner of the reference lap, ' +
      'green where this lap gained time there and red where it lost it; ticks at the sector lines; the car in cyan."></canvas>' +
      '<p class="tlap__note tw-empty">No ghost lap</p>' +
      "</div>";
    el = mount.firstChild;
    whoEl = el.querySelector(".tlap__driver");
    refEl = el.querySelector(".tlap__ref");
    var cells = el.querySelectorAll(".tlap__sec");
    for (var i = 0; i < 3; i++) {
      var c = cells[i];
      // The elements, and the last value written to each (see `setText`).
      secEls.push({
        root: c,
        deltaEl: c.querySelector(".tlap__delta"),
        timeEl: c.querySelector(".tlap__time"),
        barEl: c.querySelector(".tlap__bar > div"),
        state: "pending",
        tone: "none",
        text: "—",
        timeText: "—",
        bar: -1,
      });
    }
    lapEl = { deltaEl: el.querySelector(".tlap__lap .tw-big"), tone: "none", text: "—" };
    canvas = el.querySelector(".tlap__line");
    gctx = canvas.getContext("2d");
    if (!LAPS || !GHOST) {
      console.error("[Apex] Lap strip needs training-laps.js and training-ghost.js loaded first");
      return;
    }
    readTokens();
    sizeLine();
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () {
        if (sizeLine()) drawn.ver = -1;
      }).observe(canvas);
    }
    GHOST.subscribe(setLine);
  }

  window.ApexOverlay.registerWidget("trainingsectors", {
    throttleMs: 100,
    init: init,
    update: update,
  });
})();
