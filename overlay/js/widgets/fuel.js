/**
 * widgets/fuel.js — fuel calculator readout (mid-right).
 * -----------------------------------------------------------------------------
 * Renders `frame.fuel` (FuelState) computed server-side by the fuel calculator:
 * consumption per lap, laps remaining on current fuel, litres to the finish and
 * the margin at the flag (colour-coded surplus/short), plus refuel-to-finish
 * and the pit window. Values are display-ready; this widget only formats them.
 */
(function () {
  "use strict";

  var header;
  var stats = {};
  var refuelEl, pitEl;
  var cache = {};

  function makeStat(grid, key, label) {
    var wrap = document.createElement("div");
    wrap.className = "fuel__stat";
    var l = document.createElement("div");
    l.className = "fuel__stat-label";
    l.textContent = label;
    var v = document.createElement("div");
    v.className = "fuel__stat-value";
    v.textContent = "—";
    wrap.appendChild(l);
    wrap.appendChild(v);
    grid.appendChild(wrap);
    stats[key] = v;
  }

  function init(root) {
    header = root.querySelector('[data-role="tank"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var grid = document.createElement("div");
    grid.className = "fuel__grid";
    makeStat(grid, "perLap", "Per Lap");
    makeStat(grid, "lapsLeft", "Laps Left");
    makeStat(grid, "toFinish", "To Finish");
    makeStat(grid, "margin", "Margin");
    mount.appendChild(grid);

    var margin = document.createElement("div");
    margin.className = "fuel__margin";
    refuelEl = document.createElement("span");
    refuelEl.textContent = "Refuel —";
    pitEl = document.createElement("span");
    pitEl.textContent = "";
    margin.appendChild(refuelEl);
    margin.appendChild(pitEl);
    mount.appendChild(margin);
  }

  function setStat(key, value, unitSmall) {
    var el = stats[key];
    if (!el) return;
    var html = unitSmall ? value + "<small> " + unitSmall + "</small>" : value;
    if (cache[key] === html) return;
    cache[key] = html;
    el.innerHTML = html;
    return el;
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var f = frame.fuel;
    if (!f) return;

    if (header) {
      var tank = fmt.liters(f.levelLiters) + " L";
      if (cache.tank !== tank) { cache.tank = tank; header.textContent = tank; }
    }

    setStat("perLap", fmt.liters(f.perLapAvgLiters), "L");
    setStat("lapsLeft", fmt.intVal(f.lapsRemaining), null);
    setStat("toFinish", fmt.liters(f.fuelToFinishLiters), "L");

    // Margin: signed litres at the flag, colour-coded.
    var marginEl = stats.margin;
    var d = f.fuelDeltaLiters;
    var marginStr;
    var state;
    if (typeof d !== "number" || d === fmt.UNKNOWN) {
      marginStr = "—";
      state = "";
    } else {
      marginStr = (d >= 0 ? "+" : "−") + Math.abs(d).toFixed(1);
      var oneLap = fmt.has(f.perLapAvgLiters) ? f.perLapAvgLiters : 1;
      state = d < 0 ? "short" : d < oneLap ? "marginal" : "ok";
    }
    var marginHtml = marginStr + (marginStr !== "—" ? '<small> L</small>' : "");
    if (cache.margin !== marginHtml) {
      cache.margin = marginHtml;
      marginEl.innerHTML = marginHtml;
    }
    if (cache.marginState !== state) {
      cache.marginState = state;
      if (state) marginEl.setAttribute("data-state", state);
      else marginEl.removeAttribute("data-state");
    }

    // Bottom line: refuel-to-finish + pit window.
    var refuel = fmt.has(f.refuelToFinishLiters)
      ? "Refuel +" + f.refuelToFinishLiters.toFixed(1) + " L"
      : "Refuel —";
    if (cache.refuel !== refuel) { cache.refuel = refuel; refuelEl.textContent = refuel; }

    var pit = fmt.has(f.pitWindowOpenLap) ? "Pit window: L" + Math.round(f.pitWindowOpenLap) : "";
    if (cache.pit !== pit) { cache.pit = pit; pitEl.textContent = pit; }
  }

  window.ApexOverlay.registerWidget("fuel", {
    throttleMs: 250,
    init: init,
    update: update,
  });
})();
