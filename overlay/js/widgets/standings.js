/**
 * widgets/standings.js — full-field race standings (top-left panel).
 * -----------------------------------------------------------------------------
 * Renders `frame.standings` (StandingEntry[]) as a compact timing tower. Uses a
 * keyed reconciler (one <tr> per slotId, reused across frames) so we only touch
 * the DOM text that actually changed and reorder by moving existing nodes —
 * cheaper and jitter-free versus rebuilding innerHTML every update.
 */
(function () {
  "use strict";

  // Deterministic class -> colour so each car class gets a stable dot colour.
  var CLASS_COLORS = ["#8b5cf6", "#22d3ee", "#ec4899", "#4f8bff", "#35d07f", "#ffb020"];
  var classColorCache = {};
  function classColor(cls) {
    if (!cls) return "#6b7387";
    if (classColorCache[cls]) return classColorCache[cls];
    var hash = 0;
    for (var i = 0; i < cls.length; i++) hash = (hash * 31 + cls.charCodeAt(i)) | 0;
    var color = CLASS_COLORS[Math.abs(hash) % CLASS_COLORS.length];
    classColorCache[cls] = color;
    return color;
  }

  var mount, tbody;
  /** @type {Map<number, object>} slotId -> cached row element + last values. */
  var rows = new Map();

  function createRow() {
    var tr = document.createElement("tr");
    tr.className = "standings__row";

    var posTd = document.createElement("td");
    posTd.className = "standings__cell standings__pos";

    var driverTd = document.createElement("td");
    driverTd.className = "standings__cell standings__driver";
    var classDot = document.createElement("span");
    classDot.className = "standings__class";
    var nameSpan = document.createElement("span");
    driverTd.appendChild(classDot);
    driverTd.appendChild(nameSpan);

    var gapTd = document.createElement("td");
    gapTd.className = "standings__cell standings__gap";

    var lastTd = document.createElement("td");
    lastTd.className = "standings__cell standings__last";

    tr.appendChild(posTd);
    tr.appendChild(driverTd);
    tr.appendChild(gapTd);
    tr.appendChild(lastTd);

    return {
      tr: tr,
      posTd: posTd,
      classDot: classDot,
      nameSpan: nameSpan,
      gapTd: gapTd,
      lastTd: lastTd,
      cache: {},
    };
  }

  // Only write to the DOM when a value actually changed.
  function set(row, key, el, prop, value) {
    if (row.cache[key] === value) return;
    row.cache[key] = value;
    el[prop] = value;
  }

  function init(root) {
    mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";
    var table = document.createElement("table");
    table.className = "standings__table";
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
    mount.appendChild(table);
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var list = frame.standings || [];
    var seen = new Set();

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var row = rows.get(e.slotId);
      if (!row) {
        row = createRow();
        rows.set(e.slotId, row);
      }
      seen.add(e.slotId);

      // Player highlight.
      var playerClass = "standings__row" + (e.isPlayer ? " standings__row--player" : "");
      set(row, "cls", row.tr, "className", playerClass);

      set(row, "pos", row.posTd, "textContent", fmt.intVal(e.position));

      var dotColor = classColor(e.carClass);
      if (row.cache.dot !== dotColor) {
        row.cache.dot = dotColor;
        row.classDot.style.background = dotColor;
      }

      var name = e.driverName || "—";
      if (e.carNumber) name = "#" + e.carNumber + " " + name;
      if (e.inPit) name = name + " ·PIT";
      set(row, "name", row.nameSpan, "textContent", name);

      // Gap: laps-behind takes precedence, then seconds; leader shows a dash.
      var gapText;
      if (e.position === 1) gapText = "—";
      else if (e.lapsBehind && e.lapsBehind > 0) gapText = "+" + e.lapsBehind + "L";
      else gapText = fmt.gap(e.gapToLeaderSec);
      set(row, "gap", row.gapTd, "textContent", gapText);

      set(row, "last", row.lastTd, "textContent", fmt.lapTime(e.lastLapSec));

      // Reorder: append in standings order (moves existing node, no rebuild).
      tbody.appendChild(row.tr);
    }

    // Drop rows for cars no longer in the field.
    rows.forEach(function (row, slot) {
      if (!seen.has(slot)) {
        if (row.tr.parentNode) row.tr.parentNode.removeChild(row.tr);
        rows.delete(slot);
      }
    });
  }

  window.ApexOverlay.registerWidget("standings", {
    throttleMs: 120,
    init: init,
    update: update,
  });
})();
