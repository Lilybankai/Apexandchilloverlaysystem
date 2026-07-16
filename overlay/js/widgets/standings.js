/**
 * widgets/standings.js — full-field race standings (top-left panel).
 * -----------------------------------------------------------------------------
 * Renders `frame.standings` (StandingEntry[]) as a class-grouped timing tower:
 *
 *   ┌ session strip ─ big LAP x/y counter + countdown clock (timed races) ┐
 *   ├ HYPERCAR · 6 CARS ─────────────────────────────────────────────────┤
 *   │  P  ±   Driver            VE     GAP        LAST                     │
 *   ├ GT3 · 9 CARS ───────────────────────────────────────────────────────┤
 *   │  ...                                                                 │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Extra columns vs. the plain tower:
 *   - ±  positions gained (green ▲) / lost (red ▼) vs. the grid, from
 *     `gridPosition`.
 *   - VE virtual-energy % remaining (`virtualEnergy`, LMU's per-car budget) with
 *     a thin fill bar behind it.
 * Highlighting:
 *   - the overall fastest lap of the race is shown in purple, persistently;
 *   - a car setting a new personal-best lap flashes its LAST time green for a
 *     few seconds, then fades.
 *
 * Rows are grouped by class (classes ordered by their leader's position), and
 * each group carries a subheader so a viewer instantly reads which category is
 * which. A keyed reconciler (one <tr> per slotId, reused across frames) keeps
 * the DOM churn-free: we only touch text that changed and reorder by moving
 * existing nodes rather than rebuilding innerHTML.
 */
(function () {
  "use strict";

  // Known LMU/endurance classes get a stable, intuitive colour; anything else
  // falls back to a hash so new classes still get a distinct, stable dot.
  var KNOWN_CLASS_COLORS = {
    HYPERCAR: "#ff5470",
    HYPER: "#ff5470",
    LMH: "#ff5470",
    LMDH: "#ff5470",
    GTP: "#ff5470",
    LMP2: "#4f8bff",
    LMP3: "#22d3ee",
    GT3: "#35d07f",
    LMGT3: "#35d07f",
    GTE: "#ffb020",
    GT4: "#ffb020",
  };
  var CLASS_COLORS = ["#8b5cf6", "#22d3ee", "#ec4899", "#4f8bff", "#35d07f", "#ffb020"];
  var classColorCache = {};
  function classColor(cls) {
    if (!cls) return "#6b7387";
    if (classColorCache[cls]) return classColorCache[cls];
    var known = KNOWN_CLASS_COLORS[String(cls).toUpperCase()];
    if (known) return (classColorCache[cls] = known);
    var hash = 0;
    for (var i = 0; i < cls.length; i++) hash = (hash * 31 + cls.charCodeAt(i)) | 0;
    var color = CLASS_COLORS[Math.abs(hash) % CLASS_COLORS.length];
    classColorCache[cls] = color;
    return color;
  }

  // Prettify a class label for the group subheader (e.g. "Hyper" -> "HYPERCAR").
  function classLabel(cls) {
    if (!cls) return "OTHER";
    var u = String(cls).toUpperCase();
    if (u === "HYPER") return "HYPERCAR";
    if (u === "LMGT3") return "GT3";
    return u;
  }

  // Broadcast-style name: "theo Pereira" -> "T. Pereira". Keeps already-short or
  // single-token names as-is, and preserves hyphenated / multi-part surnames.
  function shortName(name) {
    if (!name) return "—";
    var parts = name.trim().split(/\s+/);
    if (parts.length < 2) return name;
    var first = parts[0];
    var last = parts.slice(1).join(" ");
    return first.charAt(0).toUpperCase() + ". " + last;
  }

  /** How long a new personal-best lap flashes green (ms). */
  var PB_FLASH_MS = 5000;

  var mount, sessionStrip, sessLap, sessClock, tbody;
  /** @type {Map<number, object>} slotId -> cached row element + last values. */
  var rows = new Map();
  /** @type {Map<number, object>} slotId -> { laps, best, flashUntil }. */
  var track = new Map();
  /** @type {Map<string, object>} classKey -> cached subheader element. */
  var groups = new Map();

  function createRow() {
    var tr = document.createElement("tr");
    tr.className = "standings__row";

    var posTd = document.createElement("td");
    posTd.className = "standings__cell standings__pos";

    // Positions gained/lost vs. the grid.
    var deltaTd = document.createElement("td");
    deltaTd.className = "standings__cell standings__delta";

    var driverTd = document.createElement("td");
    driverTd.className = "standings__cell standings__driver";
    var classDot = document.createElement("span");
    classDot.className = "standings__class";
    var nameSpan = document.createElement("span");
    driverTd.appendChild(classDot);
    driverTd.appendChild(nameSpan);

    // Virtual energy: a bar-backed % cell.
    var veTd = document.createElement("td");
    veTd.className = "standings__cell standings__ve";
    var veBar = document.createElement("span");
    veBar.className = "standings__ve-bar";
    var veText = document.createElement("span");
    veText.className = "standings__ve-text";
    veTd.appendChild(veBar);
    veTd.appendChild(veText);

    var gapTd = document.createElement("td");
    gapTd.className = "standings__cell standings__gap";

    var lastTd = document.createElement("td");
    lastTd.className = "standings__cell standings__last";

    tr.appendChild(posTd);
    tr.appendChild(deltaTd);
    tr.appendChild(driverTd);
    tr.appendChild(veTd);
    tr.appendChild(gapTd);
    tr.appendChild(lastTd);

    return {
      tr: tr,
      posTd: posTd,
      deltaTd: deltaTd,
      classDot: classDot,
      nameSpan: nameSpan,
      veTd: veTd,
      veBar: veBar,
      veText: veText,
      gapTd: gapTd,
      lastTd: lastTd,
      cache: {},
    };
  }

  /** A full-width subheader row that introduces a class group. */
  function createGroup() {
    var tr = document.createElement("tr");
    tr.className = "standings__grouprow";
    var td = document.createElement("td");
    td.className = "standings__group";
    td.colSpan = 6;
    var dot = document.createElement("span");
    dot.className = "standings__group-dot";
    var label = document.createElement("span");
    label.className = "standings__group-label";
    var count = document.createElement("span");
    count.className = "standings__group-count";
    td.appendChild(dot);
    td.appendChild(label);
    td.appendChild(count);
    tr.appendChild(td);
    return { tr: tr, dot: dot, label: label, count: count, cache: {} };
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

    // Session strip: a prominent lap counter + a countdown clock for timed races.
    sessionStrip = document.createElement("div");
    sessionStrip.className = "standings__session";
    sessLap = document.createElement("span");
    sessLap.className = "standings__session-lap";
    sessLap.textContent = "LAP —";
    sessClock = document.createElement("span");
    sessClock.className = "standings__session-clock";
    sessClock.hidden = true;
    sessionStrip.appendChild(sessLap);
    sessionStrip.appendChild(sessClock);
    mount.appendChild(sessionStrip);

    var table = document.createElement("table");
    table.className = "standings__table";
    // Explicit column widths via <colgroup> so table-layout:fixed sizes columns
    // deterministically — without this the class-header (a colspan row) makes
    // the browser split the table into equal columns and starve the driver name.
    // The driver column has no width, so it absorbs the remaining space.
    var colgroup = document.createElement("colgroup");
    var widths = [30, 34, 0, 50, 66, 72]; // pos, ±, driver(rest), VE, gap, last
    for (var c = 0; c < widths.length; c++) {
      var col = document.createElement("col");
      if (widths[c] > 0) col.style.width = widths[c] + "px";
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
    mount.appendChild(table);
  }

  /** Render the LAP x/y counter and the timed-race countdown clock. */
  function updateSession(frame, fmt) {
    var s = frame.session;
    if (!s) return;
    var cur = s.currentLap;
    var tot = s.totalLaps;
    var lapText;
    if (fmt.has(tot) && tot > 0) lapText = "LAP " + fmt.intVal(cur) + "/" + tot;
    else lapText = "LAP " + fmt.intVal(cur);
    if (sessLap.textContent !== lapText) sessLap.textContent = lapText;

    // Countdown only for timed sessions (no fixed lap count) with a known clock.
    var timed = !(fmt.has(tot) && tot > 0);
    var rem = s.timeRemainingSec;
    if (timed && fmt.has(rem) && rem > 0) {
      var clock = formatClock(rem);
      if (sessClock.textContent !== clock) sessClock.textContent = clock;
      if (sessClock.hidden) sessClock.hidden = false;
      // Flash the clock red inside the final minute.
      var urgent = rem <= 60;
      if (sessClock.classList.contains("is-urgent") !== urgent)
        sessClock.classList.toggle("is-urgent", urgent);
    } else if (!sessClock.hidden) {
      sessClock.hidden = true;
    }
  }

  /** Seconds -> "H:MM:SS" (drops the hour when zero). */
  function formatClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var mm = (h > 0 ? String(m).padStart(2, "0") : String(m));
    var ss = String(s).padStart(2, "0");
    return (h > 0 ? h + ":" : "") + mm + ":" + ss;
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var now = Date.now();
    var list = frame.standings || [];
    var seen = new Set();

    updateSession(frame, fmt);

    // Overall fastest lap of the race (min valid best) -> purple holder.
    var fastestSlot = -1;
    var fastestSec = Infinity;
    for (var f = 0; f < list.length; f++) {
      var b = list[f].bestLapSec;
      if (fmt.has(b) && b < fastestSec) {
        fastestSec = b;
        fastestSlot = list[f].slotId;
      }
    }

    // Group entries by class, preserving position order within a class and
    // ordering the classes by their best (lowest) position.
    var order = [];
    var byClass = {};
    for (var i = 0; i < list.length; i++) {
      var key = list[i].carClass || "—";
      if (!byClass[key]) {
        byClass[key] = [];
        order.push(key);
      }
      byClass[key].push(list[i]);
    }

    var seenGroups = new Set();
    for (var g = 0; g < order.length; g++) {
      var cls = order[g];
      var members = byClass[cls];

      // Class subheader.
      var grp = groups.get(cls);
      if (!grp) {
        grp = createGroup();
        groups.set(cls, grp);
      }
      seenGroups.add(cls);
      var col = classColor(cls);
      if (grp.cache.dot !== col) {
        grp.cache.dot = col;
        grp.dot.style.background = col;
        grp.tr.style.setProperty("--class-color", col);
      }
      set(grp, "label", grp.label, "textContent", classLabel(cls));
      set(grp, "count", grp.count, "textContent", members.length + (members.length === 1 ? " CAR" : " CARS"));
      tbody.appendChild(grp.tr);

      // Member rows.
      for (var m = 0; m < members.length; m++) {
        renderRow(members[m], fmt, now, fastestSlot);
        seen.add(members[m].slotId);
      }
    }

    // Drop rows for cars no longer in the field.
    rows.forEach(function (row, slot) {
      if (!seen.has(slot)) {
        if (row.tr.parentNode) row.tr.parentNode.removeChild(row.tr);
        rows.delete(slot);
        track.delete(slot);
      }
    });
    // Drop subheaders for classes no longer present.
    groups.forEach(function (grp, cls) {
      if (!seenGroups.has(cls)) {
        if (grp.tr.parentNode) grp.tr.parentNode.removeChild(grp.tr);
        groups.delete(cls);
      }
    });
  }

  function renderRow(e, fmt, now, fastestSlot) {
    var row = rows.get(e.slotId);
    if (!row) {
      row = createRow();
      rows.set(e.slotId, row);
    }

    // --- personal-best flash bookkeeping -------------------------------------
    var t = track.get(e.slotId);
    if (!t) {
      t = { laps: e.lapsCompleted, best: e.bestLapSec, flashUntil: 0 };
      track.set(e.slotId, t);
    } else if (e.lapsCompleted > t.laps) {
      // Completed a new lap: flash green if it set/matched a personal best.
      if (fmt.has(e.lastLapSec) && (!fmt.has(t.best) || e.lastLapSec <= t.best + 1e-6)) {
        t.flashUntil = now + PB_FLASH_MS;
      }
      t.laps = e.lapsCompleted;
    }
    if (fmt.has(e.bestLapSec)) t.best = e.bestLapSec;

    var isFastest = e.slotId === fastestSlot && fmt.has(e.bestLapSec);
    var flashing = now < t.flashUntil;

    // Player highlight (+ carries the fastest-lap purple accent on the row).
    var cls = "standings__row";
    if (e.isPlayer) cls += " standings__row--player";
    if (isFastest) cls += " standings__row--fastest";
    set(row, "cls", row.tr, "className", cls);

    set(row, "pos", row.posTd, "textContent", fmt.intVal(e.position));

    // Positions gained/lost vs. the grid.
    var dTxt = "";
    var dState = "flat";
    if (fmt.has(e.gridPosition) && e.gridPosition > 0 && fmt.has(e.position)) {
      var d = e.gridPosition - e.position;
      if (d > 0) {
        dTxt = "▲" + d;
        dState = "gain";
      } else if (d < 0) {
        dTxt = "▼" + -d;
        dState = "loss";
      } else {
        dTxt = "•";
        dState = "flat";
      }
    }
    set(row, "delta", row.deltaTd, "textContent", dTxt);
    if (row.cache.dState !== dState) {
      row.cache.dState = dState;
      row.deltaTd.setAttribute("data-state", dState);
    }

    var dotColor = classColor(e.carClass);
    if (row.cache.dot !== dotColor) {
      row.cache.dot = dotColor;
      row.classDot.style.background = dotColor;
    }

    var name = shortName(e.driverName);
    if (e.carNumber) name = "#" + e.carNumber + " " + name;
    if (e.inPit) name = name + " ·PIT";
    set(row, "name", row.nameSpan, "textContent", name);

    // Virtual energy: % + a fill bar behind the number.
    var hasVe = fmt.has(e.virtualEnergy) && e.virtualEnergy >= 0;
    var vePct = hasVe ? Math.round(e.virtualEnergy * 100) : -1;
    set(row, "veText", row.veText, "textContent", hasVe ? vePct + "%" : "—");
    if (row.cache.vePct !== vePct) {
      row.cache.vePct = vePct;
      row.veBar.style.width = hasVe ? Math.max(0, Math.min(100, vePct)) + "%" : "0%";
      // Colour the bar by remaining energy: healthy -> low -> critical.
      var veState = !hasVe ? "none" : vePct <= 15 ? "crit" : vePct <= 35 ? "low" : "ok";
      row.veTd.setAttribute("data-ve", veState);
    }

    // Gap: laps-behind takes precedence, then seconds; leader shows a dash.
    var gapText;
    if (e.position === 1) gapText = "—";
    else if (e.lapsBehind && e.lapsBehind > 0) gapText = "+" + e.lapsBehind + "L";
    else gapText = fmt.gap(e.gapToLeaderSec);
    set(row, "gap", row.gapTd, "textContent", gapText);

    set(row, "last", row.lastTd, "textContent", fmt.lapTime(e.lastLapSec));
    // Last-lap colour: purple for the race's fastest lap, green flash for a
    // fresh personal best, otherwise the default text colour.
    var lastState = isFastest ? "fastest" : flashing ? "pb" : "";
    if (row.cache.lastState !== lastState) {
      row.cache.lastState = lastState;
      row.lastTd.classList.toggle("lap-purple", lastState === "fastest");
      row.lastTd.classList.toggle("lap-green", lastState === "pb");
    }

    // Reorder: append in standings order (moves existing node, no rebuild).
    tbody.appendChild(row.tr);
  }

  window.ApexOverlay.registerWidget("standings", {
    throttleMs: 120,
    init: init,
    update: update,
  });
})();
