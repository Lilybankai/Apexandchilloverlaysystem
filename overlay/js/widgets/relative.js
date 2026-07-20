/**
 * widgets/relative.js — relative timing panel (top-right).
 * -----------------------------------------------------------------------------
 * Two parts:
 *   1. A timing strip driven by `frame.player.lap` (LAST / BEST / CURRENT / Δ).
 *   2. A relative table driven by `frame.relative` (RelativeEntry[]) — the cars
 *      physically nearest the player on track with a signed time gap.
 * Uses the same keyed-row reconciler approach as standings for cheap updates.
 */
(function () {
  "use strict";

  var mount, tbody, alertEl;
  var cellLast, cellBest, cellCur, cellDelta;
  var stripCache = {};
  var alertCache = {};
  var rows = new Map();

  /**
   * Once the alert has fired for a car it stays up for this long even if the
   * yield condition flickers off — a car dipping in and out of the threshold
   * while it lines up a pass would otherwise strobe the banner. Cleared as soon
   * as a different car takes over the alert.
   */
  var ALERT_HOLD_MS = 2000;

  function makeTimingCell(label) {
    var cell = document.createElement("div");
    cell.className = "timing__cell";
    var l = document.createElement("div");
    l.className = "timing__label";
    l.textContent = label;
    var v = document.createElement("div");
    v.className = "timing__value";
    v.textContent = "—";
    cell.appendChild(l);
    cell.appendChild(v);
    return v;
  }

  /**
   * The backmarker ghost, as inline SVG rather than the 👻 emoji.
   *
   * Three reasons the glyph was the wrong call: it renders in whatever colour
   * Segoe UI Emoji decides (so it can't be tinted to match the row state or the
   * brand), its size and baseline vary between the OBS Browser Source and the
   * in-game layer, and the in-game layer scales widgets with a CSS transform —
   * where a bitmap-backed colour emoji goes soft but a vector stays crisp. The
   * overlay also deliberately ships no web fonts, so leaning on an emoji font
   * being present is exactly the dependency the rest of the design avoids.
   */
  function ghostSvg() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "relative__ghost");
    svg.setAttribute("aria-hidden", "true");
    // Dome + the classic scalloped hem, then two eyes knocked out of it.
    var body = document.createElementNS("http://www.w3.org/2000/svg", "path");
    body.setAttribute(
      "d",
      "M8 1a5.5 5.5 0 0 0-5.5 5.5V14a.6.6 0 0 0 1.05.4L5 13.1l1.45 1.3a.6.6 0 0 0 .8 0L8 13.6l.75.8a.6.6 0 0 0 .8 0L11 13.1l1.45 1.3A.6.6 0 0 0 13.5 14V6.5A5.5 5.5 0 0 0 8 1z"
    );
    body.setAttribute("fill", "currentColor");
    var eyes = document.createElementNS("http://www.w3.org/2000/svg", "path");
    eyes.setAttribute(
      "d",
      "M6.1 5.6a1.15 1.35 0 1 1 0 2.7 1.15 1.35 0 0 1 0-2.7zm3.8 0a1.15 1.35 0 1 1 0 2.7 1.15 1.35 0 0 1 0-2.7z"
    );
    eyes.setAttribute("fill", "var(--bg-panel)");
    svg.appendChild(body);
    svg.appendChild(eyes);
    return svg;
  }

  function createRow() {
    var tr = document.createElement("tr");
    tr.className = "relative__row";
    var posTd = document.createElement("td");
    posTd.className = "relative__cell relative__pos";
    var driverTd = document.createElement("td");
    driverTd.className = "relative__cell relative__driver";
    // The ghost lives in its own span before the name, so toggling it never
    // rewrites the name text node (which the reconciler diffs).
    var ghostWrap = document.createElement("span");
    ghostWrap.className = "relative__ghost-wrap";
    ghostWrap.hidden = true;
    ghostWrap.title = "Backmarker ahead — you are catching this car";
    ghostWrap.appendChild(ghostSvg());
    var nameSpan = document.createElement("span");
    driverTd.appendChild(ghostWrap);
    driverTd.appendChild(nameSpan);
    var deltaTd = document.createElement("td");
    deltaTd.className = "relative__cell relative__delta";
    tr.appendChild(posTd);
    tr.appendChild(driverTd);
    tr.appendChild(deltaTd);
    return {
      tr: tr,
      posTd: posTd,
      driverTd: driverTd,
      ghostWrap: ghostWrap,
      nameSpan: nameSpan,
      deltaTd: deltaTd,
      cache: {},
    };
  }

  function set(row, key, el, prop, value) {
    if (row.cache[key] === value) return;
    row.cache[key] = value;
    el[prop] = value;
  }

  function init(root) {
    mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    // Timing strip.
    var strip = document.createElement("div");
    strip.className = "timing__strip";
    cellLast = makeTimingCell("Last");
    cellBest = makeTimingCell("Best");
    cellCur = makeTimingCell("Current");
    cellDelta = makeTimingCell("Delta");
    strip.appendChild(cellLast.parentNode);
    strip.appendChild(cellBest.parentNode);
    strip.appendChild(cellCur.parentNode);
    strip.appendChild(cellDelta.parentNode);
    mount.appendChild(strip);

    // Blue-flag / backmarker alert, between the timing strip and the table so it
    // pushes nothing off-screen when it appears.
    alertEl = document.createElement("div");
    alertEl.className = "relative__alert";
    alertEl.hidden = true;
    mount.appendChild(alertEl);

    // Relative table.
    var table = document.createElement("table");
    table.className = "relative__table";
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
    mount.appendChild(table);
  }

  /**
   * Show/hide the yield banner for the nearest car we owe a move to. Picks the
   * closest such car (there can be more than one in a multiclass train) so the
   * driver is told about the one arriving first.
   */
  function updateAlert(list, fmt, now) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e.yieldTo) continue;
      if (!best || Math.abs(e.relativeGapSec) < Math.abs(best.relativeGapSec)) best = e;
    }

    if (!best) {
      // Hold the last alert briefly rather than dropping it the instant the
      // condition blinks off.
      if (alertCache.slot != null && now < alertCache.until) return;
      if (!alertEl.hidden) {
        alertEl.hidden = true;
        alertCache = {};
      }
      return;
    }

    var who = best.driverName || "—";
    if (best.carNumber) who = "#" + best.carNumber + " " + who;
    var why = best.lapsDifference > 0 ? "LAPPING YOU" : (best.carClass || "FASTER CLASS");
    var txt = "⚑ BLUE · " + who + " · " + why + " · " + Math.abs(best.relativeGapSec).toFixed(1) + "s";

    if (alertCache.text !== txt) {
      alertCache.text = txt;
      alertEl.textContent = txt;
    }
    alertCache.slot = best.slotId;
    alertCache.until = now + ALERT_HOLD_MS;
    if (alertEl.hidden) alertEl.hidden = false;
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var lap = frame.player ? frame.player.lap : null;

    if (lap) {
      var last = fmt.lapTime(lap.last);
      var best = fmt.lapTime(lap.best);
      var cur = fmt.lapTime(lap.current);
      var d = fmt.delta(lap.delta);
      if (stripCache.last !== last) { stripCache.last = last; cellLast.textContent = last; }
      if (stripCache.best !== best) { stripCache.best = best; cellBest.textContent = best; }
      if (stripCache.cur !== cur) { stripCache.cur = cur; cellCur.textContent = cur; }
      if (stripCache.delta !== d) {
        stripCache.delta = d;
        cellDelta.textContent = d;
        // Colour the delta: ahead of reference (negative) is green, behind red.
        cellDelta.className =
          "timing__value" +
          (typeof lap.delta === "number" && lap.delta !== fmt.UNKNOWN
            ? lap.delta < 0
              ? " pos"
              : lap.delta > 0
                ? " neg"
                : ""
            : "");
      }
    }

    // Relative table.
    var list = frame.relative || [];
    var seen = new Set();
    updateAlert(list, fmt, Date.now());
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var row = rows.get(e.slotId);
      if (!row) {
        row = createRow();
        rows.set(e.slotId, row);
      }
      seen.add(e.slotId);

      set(row, "cls", row.tr, "className",
        "relative__row" +
          (e.isPlayer ? " relative__row--player" : "") +
          (e.yieldTo ? " relative__row--yield" : "") +
          (e.trafficAhead ? " relative__row--traffic" : ""));
      set(row, "pos", row.posTd, "textContent", fmt.intVal(e.position));

      // Ghost on the backmarker you're arriving on.
      var ghost = !!e.trafficAhead;
      if (row.cache.ghost !== ghost) {
        row.cache.ghost = ghost;
        row.ghostWrap.hidden = !ghost;
      }

      var name = e.driverName || "—";
      if (e.carNumber) name = "#" + e.carNumber + " " + name;
      if (e.inPit) name = name + " ·PIT";
      set(row, "name", row.nameSpan, "textContent", name);

      var gapText = e.isPlayer ? "—" : fmt.relGap(e.relativeGapSec);
      set(row, "delta", row.deltaTd, "textContent", gapText);

      tbody.appendChild(row.tr);
    }

    rows.forEach(function (row, slot) {
      if (!seen.has(slot)) {
        if (row.tr.parentNode) row.tr.parentNode.removeChild(row.tr);
        rows.delete(slot);
      }
    });
  }

  window.ApexOverlay.registerWidget("relative", {
    throttleMs: 60, // snappy — gaps are dead-reckoned server-side at 30 Hz
    init: init,
    update: update,
  });
})();
