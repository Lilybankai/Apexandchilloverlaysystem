/**
 * widgets/pacedelta.js — Pacelogic-style dual lap delta (Delta T + Delta V).
 * -----------------------------------------------------------------------------
 * Replicates SimHub "Pacelogic Intro Dash" Delta T / Delta V readouts for the
 * DRIVEN car, driven by `frame.player.paceDeltas`:
 *
 *   • Delta T — time delta at the same track POSITION (the classic delta bar).
 *   • Delta V — progress delta at the same elapsed TIME (pace-based).
 *
 * Each is shown against three references — SESSION best, ALL-TIME best, LAST
 * lap — as a compact 2×3 grid, so every value Pacelogic cycles through its two
 * widgets is visible at once (handy for side-by-side comparison while driving).
 * Values are signed to 2 decimals; green when ahead (faster), red when behind.
 * Cells read "—" until their reference lap exists.
 *
 * Optional query params (OBS Browser Source URL):
 *   ?rows=t | v | both   — show only Delta T, only Delta V, or both (default).
 */
(function () {
  "use strict";

  var COLS = [
    { key: "Session", label: "SESSION" },
    { key: "AllTime", label: "ALL-TIME" },
    { key: "Last", label: "LAST" },
  ];
  var ROWS = [
    { prefix: "t", label: "Δt", title: "time @ position" },
    { prefix: "v", label: "Δv", title: "progress @ time" },
  ];

  var root, refEl;
  var cells = {}; // "tSession" -> <div>
  var rowsMode = "both";

  function init(rootEl, ctx) {
    root = rootEl;
    refEl = rootEl.querySelector('[data-role="ref"]');
    var mount = rootEl.querySelector('[data-role="mount"]');
    mount.innerHTML = "";
    cells = {};

    var params = new URLSearchParams(window.location.search);
    var r = (params.get("rows") || "both").toLowerCase();
    rowsMode = r === "t" || r === "v" ? r : "both";

    var grid = document.createElement("div");
    grid.className = "pacedelta";

    // Column header row (blank corner + the three references).
    grid.appendChild(cellDiv("pacedelta__corner", ""));
    COLS.forEach(function (c) {
      grid.appendChild(cellDiv("pacedelta__colhead", c.label));
    });

    ROWS.forEach(function (rowDef) {
      if (rowsMode !== "both" && rowsMode !== rowDef.prefix) return;
      var rh = cellDiv("pacedelta__rowhead", rowDef.label);
      rh.title = rowDef.title;
      grid.appendChild(rh);
      COLS.forEach(function (c) {
        var key = rowDef.prefix + c.key; // e.g. "tSession"
        var cell = cellDiv("pacedelta__val", "—");
        cell.setAttribute("data-state", "none");
        cells[key] = cell;
        grid.appendChild(cell);
      });
    });

    mount.appendChild(grid);
  }

  function cellDiv(cls, text) {
    var d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
  }

  /** Signed 4-decimal value (matches LMU's `0.0000`); em dash when unknown. */
  function fmtVal(sec, fmt) {
    if (!fmt.has(sec)) return { text: "—", state: "none" };
    var sign = sec > 0.005 ? "+" : sec < -0.005 ? "−" : "";
    var state = sec < -0.005 ? "ahead" : sec > 0.005 ? "behind" : "flat";
    return { text: sign + Math.abs(sec).toFixed(4), state: state };
  }

  function paintCell(key, sec, fmt) {
    var cell = cells[key];
    if (!cell) return;
    var v = fmtVal(sec, fmt);
    if (cell.textContent !== v.text) cell.textContent = v.text;
    if (cell.getAttribute("data-state") !== v.state) cell.setAttribute("data-state", v.state);
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var pd = frame.player && frame.player.paceDeltas ? frame.player.paceDeltas : null;

    if (!pd) {
      // Spectating (no shared-memory physics) or not driving yet.
      Object.keys(cells).forEach(function (k) {
        if (cells[k].textContent !== "—") cells[k].textContent = "—";
        cells[k].setAttribute("data-state", "none");
      });
      if (refEl && refEl.textContent !== "no car") refEl.textContent = "no car";
      root.setAttribute("data-active", "false");
      return;
    }

    root.setAttribute("data-active", "true");
    paintCell("tSession", pd.tSession, fmt);
    paintCell("tAllTime", pd.tAllTime, fmt);
    paintCell("tLast", pd.tLast, fmt);
    paintCell("vSession", pd.vSession, fmt);
    paintCell("vAllTime", pd.vAllTime, fmt);
    paintCell("vLast", pd.vLast, fmt);

    // Header meta: the session-best reference lap time we're comparing against.
    if (refEl) {
      var txt = fmt.has(pd.refSessionSec) ? "best " + fmt.lapTime(pd.refSessionSec) : "vs BEST";
      if (refEl.textContent !== txt) refEl.textContent = txt;
    }
  }

  window.ApexOverlay.registerWidget("pacedelta", {
    throttleMs: 60, // snappy live-driving readout
    init: init,
    update: update,
  });
})();
