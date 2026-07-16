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

  var mount, tbody;
  var cellLast, cellBest, cellCur, cellDelta;
  var stripCache = {};
  var rows = new Map();

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

  function createRow() {
    var tr = document.createElement("tr");
    tr.className = "relative__row";
    var posTd = document.createElement("td");
    posTd.className = "relative__cell relative__pos";
    var driverTd = document.createElement("td");
    driverTd.className = "relative__cell relative__driver";
    var deltaTd = document.createElement("td");
    deltaTd.className = "relative__cell relative__delta";
    tr.appendChild(posTd);
    tr.appendChild(driverTd);
    tr.appendChild(deltaTd);
    return { tr: tr, posTd: posTd, driverTd: driverTd, deltaTd: deltaTd, cache: {} };
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

    // Relative table.
    var table = document.createElement("table");
    table.className = "relative__table";
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
    mount.appendChild(table);
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
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var row = rows.get(e.slotId);
      if (!row) {
        row = createRow();
        rows.set(e.slotId, row);
      }
      seen.add(e.slotId);

      set(row, "cls", row.tr, "className",
        "relative__row" + (e.isPlayer ? " relative__row--player" : ""));
      set(row, "pos", row.posTd, "textContent", fmt.intVal(e.position));

      var name = e.driverName || "—";
      if (e.carNumber) name = "#" + e.carNumber + " " + name;
      if (e.inPit) name = name + " ·PIT";
      set(row, "name", row.driverTd, "textContent", name);

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
