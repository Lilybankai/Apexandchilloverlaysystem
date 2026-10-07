/**
 * trainingsectors.js — Lap strip: where this lap is being won and lost.
 * -----------------------------------------------------------------------------
 * Two readings of the same lap against the reference:
 *
 *   - S1 / S2 / S3 and the running lap gap, as numbers. A finished sector
 *     shows its delta in the gain or loss colour; the sector you are in shows
 *     its delta running; a sector not reached yet this lap shows last lap's,
 *     dimmed. Under each, the reference's own time for that sector.
 *   - The lap barcode: the whole lap drawn as one bar, start line on the
 *     left, with a cell for every corner where that corner is on the lap,
 *     coloured by the time it gained or lost — and last lap's barcode faint
 *     beneath it. Where the red cells cluster is where the lap is going, and
 *     whether they cluster in the same place two laps running says whether it
 *     is a habit or a moment. The sector lines cut through both rows, and a
 *     caret rides along the top with the car.
 *
 * Corner times come from the server (`frame.player.ghost.corner`, see
 * `cornerTracker.ts`); sector times are gap differences worked out here
 * (`training-laps.js`), at the reference lap's own sector lines when
 * `/ghost.json` carries them and learned from the car crossing them when not.
 *
 * Runs at 10 Hz. The numbers are DOM text written only when they change; the
 * barcode is a small canvas redrawn only when a cell, the caret's pixel, or
 * the size changes.
 */
(function () {
  "use strict";

  var LAPS = window.ApexTrainingLaps;
  var GHOST = window.ApexTrainingGhost;

  /** Strip geometry, CSS px. */
  var STRIP_H = 30;
  var CARET_H = 5;
  var ROW_H = 13;
  var PREV_H = 6;
  var ROW_GAP = 3;
  /** A corner cell is never narrower than this, or a hairpin vanishes. */
  var MIN_CELL_PX = 5;
  /** Corner numbers are printed inside cells at least this wide. */
  var LABEL_CELL_PX = 18;
  var SIZE_CHECK_FRAMES = 20;

  var C = {
    gain: "#35d07f",
    loss: "#ff5470",
    text: "#f4f6fb",
    muted: "#6b7387",
    cyan: "#22d3ee",
    fontDisplay: '"Bahnschrift", "Arial Narrow", "Segoe UI Semibold", sans-serif',
  };
  var C_TRACK = "rgba(174,182,200,0.18)";
  var C_EMPTY = "rgba(174,182,200,0.30)";
  var C_SECTOR = "rgba(244,246,251,0.55)";
  var C_INK = "rgba(4,6,12,0.85)";
  /** Fill per tone and strength step (0..STEPS), built once from the tokens. */
  var STEPS = 8;
  var gainFill = [];
  var lossFill = [];
  var gainPrev = "";
  var lossPrev = "";
  var levelFill = "";

  /* -------------------------------- state --------------------------------- */

  var el = null;
  var headerMeta = null;
  var secEls = [];
  var lapEl = null;
  var canvas = null;
  var gctx = null;
  var cssW = 0;
  var dpr = 1;
  var sizeTick = 0;

  var line = null;
  var lapM = 0;
  var cornerD0 = null;
  var cornerD1 = null;
  var cornerLabel = null;
  var refSplit = [NaN, NaN, NaN];
  var sectors = LAPS ? LAPS.createSectors() : null;

  /** What the strip last drew, so an unchanged strip is not redrawn. */
  var drawn = { lap: null, prev: null, index: -2, inside: false, caret: -1, ver: -1, lines: "" };
  var stripVer = 0;

  var cur = { label: "", ready: "false", empty: "false" };
  var fontCell = "";

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
      C.muted = pick("--text-muted", C.muted);
      C.cyan = pick("--ac-cyan", C.cyan);
      C.fontDisplay = pick("--font-display", C.fontDisplay);
    } catch (e) {
      /* fallbacks stand */
    }
    gainFill = [];
    lossFill = [];
    for (var s = 0; s <= STEPS; s++) {
      var a = 0.35 + (0.65 * s) / STEPS;
      gainFill.push(withAlpha(C.gain, a, "#35d07f"));
      lossFill.push(withAlpha(C.loss, a, "#ff5470"));
    }
    gainPrev = withAlpha(C.gain, 0.42, "#35d07f");
    lossPrev = withAlpha(C.loss, 0.42, "#ff5470");
    levelFill = withAlpha(C.text, 0.4, "#f4f6fb");
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
    lapM = data && data.trackLengthM > 0 ? data.trackLengthM : 0;
    LAPS.resetSectors(sectors);
    cornerD0 = cornerD1 = null;
    cornerLabel = null;
    if (data) {
      if (Array.isArray(data.sectorD)) LAPS.setLines(sectors, data.sectorD[0], data.sectorD[1]);
      if (Array.isArray(data.corners)) {
        var n = data.corners.length;
        cornerD0 = new Float64Array(n);
        cornerD1 = new Float64Array(n);
        cornerLabel = [];
        for (var i = 0; i < n; i++) {
          cornerD0[i] = data.corners[i].entryD;
          cornerD1[i] = data.corners[i].exitD;
          cornerLabel.push(String(i + 1));
        }
      }
    }
    splitsChanged();
    stripVer++;
  }

  /** The reference's own sector times, under each sector's delta. */
  function splitsChanged() {
    LAPS.refSplits(line, sectors.line[0], sectors.line[1], refSplit);
    for (var k = 0; k < 3; k++) {
      setText(secEls[k].refEl, secEls[k], "refText", isFinite(refSplit[k]) ? fmtTime(refSplit[k]) : "");
    }
    setText(lapEl.refEl, lapEl, "refText", line && line.lapSec > 0 ? fmtTime(line.lapSec) : "");
  }

  /** "28.41" under a minute, "1:02.30" over. */
  function fmtTime(sec) {
    if (sec < 60) return sec.toFixed(2);
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
  }

  /* ---------------------------------- DOM --------------------------------- */

  /** Write text into `node` only when it differs from what `owner[key]` holds. */
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

  /**
   * One sector cell. Done this lap: its delta, solid. The live one: its
   * delta running. Not reached yet: last lap's, dimmed — still the best
   * guess at what that sector will say.
   */
  function paintSector(k) {
    var s = secEls[k];
    var st = sectors;
    var state;
    var v;
    if (st.live === k) {
      state = "live";
      v = st.liveDelta;
    } else if (isFinite(st.cur[k])) {
      state = "done";
      v = st.cur[k];
    } else if (st.live >= 0 && k < st.live) {
      state = "done"; // passed, but with no gap to score it on
      v = NaN;
    } else {
      state = "prev";
      v = st.prev[k];
    }
    setData(s.root, s, "state", "data-state", state);
    setData(s.root, s, "tone", "data-tone", LAPS.toneOf(v));
    setText(s.deltaEl, s, "text", LAPS.fmtSigned(v));
  }

  /* --------------------------------- strip -------------------------------- */

  function sizeStrip() {
    if (!canvas) return false;
    var w = canvas.clientWidth;
    if (!w) return false;
    var d = window.ApexRaster.backingScale(canvas);
    if (w === cssW && d === dpr && canvas.width === Math.round(w * d)) return true;
    cssW = w;
    dpr = d;
    canvas.style.height = STRIP_H + "px";
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(STRIP_H * d);
    fontCell = "600 " + (ROW_H - 3) + "px " + C.fontDisplay;
    stripVer++;
    return true;
  }

  function cellFill(v) {
    var tone = LAPS.toneOf(v);
    if (tone === "level") return levelFill;
    var step = Math.round(LAPS.strength(v) * STEPS);
    return tone === "gain" ? gainFill[step] : lossFill[step];
  }

  function drawRow(vals, y, h, prev, index, inside) {
    var n = cornerD0.length;
    for (var i = 0; i < n; i++) {
      var x0 = cornerD0[i] * cssW;
      var w = Math.max(MIN_CELL_PX, (cornerD1[i] - cornerD0[i]) * cssW);
      var v = vals && i < vals.length ? vals[i] : null;
      if (v === null || v === undefined) {
        gctx.fillStyle = C_EMPTY;
        if (prev) gctx.fillRect(x0, y + h / 2 - 0.5, w, 1);
        else gctx.strokeRect(x0 + 0.5, y + 0.5, w - 1, h - 1);
      } else {
        var tone = LAPS.toneOf(v);
        gctx.fillStyle = prev ? (tone === "gain" ? gainPrev : tone === "loss" ? lossPrev : C_EMPTY) : cellFill(v);
        gctx.fillRect(x0, y, w, h);
      }
      if (!prev && i === index && inside) {
        gctx.strokeStyle = C.text;
        gctx.lineWidth = 1.5;
        gctx.strokeRect(x0 + 0.75, y + 0.75, w - 1.5, h - 1.5);
        gctx.strokeStyle = C_EMPTY;
        gctx.lineWidth = 1;
      }
      if (!prev && w >= LABEL_CELL_PX) {
        gctx.fillStyle = v === null || v === undefined ? C.muted : C_INK;
        gctx.fillText(cornerLabel[i], x0 + w / 2, y + h / 2 + 0.5);
      }
    }
  }

  /**
   * The barcode. Redrawn only when something on it changed: a cell (the
   * arrays are replaced, never edited, when a corner is scored), the car's
   * caret moving a pixel, the sector lines or the size.
   */
  function drawStrip(corner, atD) {
    if (!gctx || !sizeStrip()) return;
    var lap = corner ? corner.lapCorners : null;
    var prev = corner ? corner.prevLapCorners : null;
    var index = corner ? corner.index : -1;
    var inside = corner ? !!corner.inside : false;
    var caret = isFinite(atD) ? Math.round(atD * cssW * 2) / 2 : -1;
    var lines = sectors.line[0] + "|" + sectors.line[1];
    if (
      drawn.ver === stripVer &&
      drawn.lap === lap &&
      drawn.prev === prev &&
      drawn.index === index &&
      drawn.inside === inside &&
      drawn.caret === caret &&
      drawn.lines === lines
    ) {
      return;
    }
    drawn.ver = stripVer;
    drawn.lap = lap;
    drawn.prev = prev;
    drawn.index = index;
    drawn.inside = inside;
    drawn.caret = caret;
    drawn.lines = lines;

    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, STRIP_H);
    var yRow = CARET_H + 1;
    var yPrev = yRow + ROW_H + ROW_GAP;

    // The lap itself, under the cells: a strip with nothing on it reads as
    // straights, not as missing data.
    gctx.fillStyle = C_TRACK;
    gctx.fillRect(0, yRow + ROW_H / 2 - 1, cssW, 2);
    gctx.fillRect(0, yPrev + PREV_H / 2 - 0.5, cssW, 1);

    if (cornerD0) {
      gctx.font = fontCell;
      gctx.textAlign = "center";
      gctx.textBaseline = "middle";
      gctx.strokeStyle = C_EMPTY;
      gctx.lineWidth = 1;
      drawRow(lap, yRow, ROW_H, false, index, inside);
      drawRow(prev, yPrev, PREV_H, true, -1, false);
    }

    // Sector lines through both rows.
    gctx.fillStyle = C_SECTOR;
    for (var k = 0; k < 2; k++) {
      var L = sectors.line[k];
      if (isFinite(L)) gctx.fillRect(Math.round(L * cssW) - 0.5, yRow - 2, 1, yPrev + PREV_H - yRow + 4);
    }

    // The car.
    if (caret >= 0) {
      gctx.fillStyle = C.cyan;
      gctx.beginPath();
      gctx.moveTo(caret - 4, 0);
      gctx.lineTo(caret + 4, 0);
      gctx.lineTo(caret, CARET_H);
      gctx.closePath();
      gctx.fill();
      gctx.fillRect(caret - 0.5, CARET_H, 1, yPrev + PREV_H - CARET_H);
    }
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
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) sizeStrip();
    var ghost = frame && frame.player ? frame.player.ghost : null;
    GHOST.sync(ghost);

    if (headerMeta) {
      var label = ghost && ghost.sourceLabel ? ghost.sourceLabel : "—";
      if (label !== cur.label) {
        cur.label = label;
        headerMeta.textContent = label;
      }
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
    for (var k = 0; k < 3; k++) paintSector(k);
    setText(lapEl.deltaEl, lapEl, "text", LAPS.fmtSigned(gap));
    setData(lapEl.root, lapEl, "tone", "data-tone", LAPS.toneOf(gap));
    setData(el, cur, "ready", "data-ready", line ? "true" : "false");
    // No ghost (or its lap not here yet): say so, as Trace and the Corner
    // card do, rather than leave dashes and a bare strip that read as idle.
    setData(el, cur, "empty", "data-empty", ghost && line ? "false" : "true");
    drawStrip(ghost ? ghost.corner : null, d);
  }

  /* --------------------------------- init --------------------------------- */

  function sectorCell(name, extra) {
    return (
      '<div class="tlap__sec' + (extra || "") + '" data-state="prev" data-tone="none">' +
      '<span class="tlap__name">' + name + "</span>" +
      '<span class="tlap__delta">—</span>' +
      '<span class="tlap__ref"></span>' +
      "</div>"
    );
  }

  function init(root) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML =
      '<div class="tlap" data-ready="false" data-empty="false">' +
      '<div class="tlap__row">' +
      sectorCell("S1") +
      sectorCell("S2") +
      sectorCell("S3") +
      sectorCell("LAP", " tlap__sec--lap") +
      "</div>" +
      '<canvas class="tlap__strip" role="img" aria-label="The lap as a bar, one cell per corner of the reference lap, ' +
      'green where this lap gained time there and red where it lost it; last lap faint beneath; sector lines across both."></canvas>' +
      '<p class="tlap__note">No ghost lap</p>' +
      "</div>";
    el = mount.firstChild;
    var cells = el.querySelectorAll(".tlap__sec");
    for (var i = 0; i < 4; i++) {
      var c = cells[i];
      // The elements, and the last value written to each (see `setText`).
      var o = {
        root: c,
        deltaEl: c.querySelector(".tlap__delta"),
        refEl: c.querySelector(".tlap__ref"),
        state: "prev",
        tone: "none",
        text: "—",
        refText: "",
      };
      if (i < 3) secEls.push(o);
      else lapEl = o;
    }
    canvas = el.querySelector(".tlap__strip");
    gctx = canvas.getContext("2d");
    if (!LAPS || !GHOST) {
      console.error("[Apex] Lap strip needs training-laps.js and training-ghost.js loaded first");
      return;
    }
    readTokens();
    sizeStrip();
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () {
        if (sizeStrip()) drawn.ver = -1;
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
