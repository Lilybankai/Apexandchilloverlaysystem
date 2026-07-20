/**
 * widgets/fuel.js — fuel calculator readout (mid-right).
 * -----------------------------------------------------------------------------
 * Renders `frame.fuel` (FuelState) computed server-side by the fuel calculator:
 * consumption per lap, laps remaining on current fuel, litres to the finish and
 * the margin at the flag (colour-coded surplus/short), plus refuel-to-finish
 * and the pit window. Values are display-ready; this widget only formats them.
 *
 * When the car runs a **virtual energy** budget (LMU), the widget rotates every
 * 20 s between the FUEL view and an ENERGY view (remaining %, % per lap, laps
 * left on energy, margin at the flag) — energy is the resource that actually
 * limits an LMU stint. Cars without VE just show the fuel view permanently.
 */
(function () {
  "use strict";

  /** How long each view is shown before rotating (ms). */
  var ROTATE_MS = 20000;

  var header, modeChip, overlapEl;
  var stats = {};
  var refuelEl, pitEl;
  var cache = {};
  var grids = {};

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

    // Mode chip: names the view currently shown (FUEL / ENERGY).
    modeChip = document.createElement("div");
    modeChip.className = "fuel__mode";
    modeChip.textContent = "FUEL";
    modeChip.style.display = "none"; // only shown once rotation is active
    mount.appendChild(modeChip);

    var fuelGrid = document.createElement("div");
    fuelGrid.className = "fuel__grid";
    makeStat(fuelGrid, "perLap", "Per Lap");
    makeStat(fuelGrid, "lapsLeft", "Laps Left");
    makeStat(fuelGrid, "toFinish", "To Finish");
    makeStat(fuelGrid, "margin", "Margin");
    mount.appendChild(fuelGrid);
    grids.fuel = fuelGrid;

    // Energy view: same grid shape, VE-denominated stats.
    var energyGrid = document.createElement("div");
    energyGrid.className = "fuel__grid";
    energyGrid.style.display = "none";
    makeStat(energyGrid, "veRemain", "Remaining");
    makeStat(energyGrid, "vePerLap", "Per Lap");
    makeStat(energyGrid, "veLapsLeft", "Laps Left");
    makeStat(energyGrid, "veMargin", "Margin");
    mount.appendChild(energyGrid);
    grids.energy = energyGrid;

    // Energy-overlap chip. Deliberately OUTSIDE the rotating grids: "how many
    // cars ahead have to pit before me" is a strategy call the driver may need
    // at any moment, and hiding it behind a 20-second rotation would mean the
    // answer is absent exactly when they look for it.
    overlapEl = document.createElement("div");
    overlapEl.className = "fuel__overlap";
    overlapEl.hidden = true;
    mount.appendChild(overlapEl);

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

  /** Signed margin readout with colour state; shared by fuel (L) and VE (%). */
  function setMargin(key, delta, perLap, fmt, unit) {
    var el = stats[key];
    if (!el) return;
    var str, state;
    if (typeof delta !== "number" || delta === fmt.UNKNOWN) {
      str = "—";
      state = "";
    } else {
      str = (delta >= 0 ? "+" : "−") + Math.abs(delta).toFixed(1);
      var oneLap = typeof perLap === "number" && perLap > 0 ? perLap : 1;
      state = delta < 0 ? "short" : delta < oneLap ? "marginal" : "ok";
    }
    var html = str + (str !== "—" ? "<small> " + unit + "</small>" : "");
    if (cache[key] !== html) {
      cache[key] = html;
      el.innerHTML = html;
    }
    if (cache[key + "State"] !== state) {
      cache[key + "State"] = state;
      if (state) el.setAttribute("data-state", state);
      else el.removeAttribute("data-state");
    }
  }

  /**
   * "N of M cars ahead pit before you" — each one is a position that comes back
   * on strategy alone. M is shown because the comparison only covers cars in
   * your own class that run an energy budget (see `buildEnergyOverlap`), and
   * implying it covered the whole field would overstate it.
   */
  function updateOverlap(f) {
    var n = f.veCarsAheadPittingFirst;
    var m = f.veCarsAheadCompared;
    if (typeof n !== "number" || typeof m !== "number" || m <= 0) {
      if (!overlapEl.hidden) overlapEl.hidden = true;
      return;
    }
    var txt = "⚡ " + n + " of " + m + " ahead pit first";
    if (typeof f.veLapsInHandVsNext === "number" && f.veLapsInHandVsNext > 0) {
      txt += " · +" + f.veLapsInHandVsNext.toFixed(1) + " laps in hand";
    }
    if (cache.overlap !== txt) {
      cache.overlap = txt;
      overlapEl.textContent = txt;
    }
    // Nothing to gain is a legitimate answer, but a flat "0 of 5" shouldn't read
    // as an opportunity — dim it.
    var state = n > 0 ? "gain" : "none";
    if (cache.overlapState !== state) {
      cache.overlapState = state;
      overlapEl.setAttribute("data-state", state);
    }
    if (overlapEl.hidden) overlapEl.hidden = false;
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var f = frame.fuel;
    if (!f) return;

    updateOverlap(f);

    var hasEnergy = typeof f.virtualEnergyPct === "number";
    // Rotate between views every ROTATE_MS while energy data exists.
    var mode = hasEnergy && Math.floor(Date.now() / ROTATE_MS) % 2 === 1 ? "energy" : "fuel";
    if (cache.mode !== mode || cache.hasEnergy !== hasEnergy) {
      cache.mode = mode;
      cache.hasEnergy = hasEnergy;
      grids.fuel.style.display = mode === "fuel" ? "" : "none";
      grids.energy.style.display = mode === "energy" ? "" : "none";
      modeChip.style.display = hasEnergy ? "" : "none";
      modeChip.textContent = mode === "energy" ? "VIRTUAL ENERGY" : "FUEL";
      modeChip.setAttribute("data-mode", mode);
    }

    // Header readout follows the view: tank litres vs energy %.
    if (header) {
      var hdr =
        mode === "energy"
          ? Math.round(f.virtualEnergyPct) + "%"
          : fmt.liters(f.levelLiters) + " L";
      if (cache.tank !== hdr) { cache.tank = hdr; header.textContent = hdr; }
    }

    if (mode === "energy") {
      setStat("veRemain", f.virtualEnergyPct.toFixed(1), "%");
      setStat(
        "vePerLap",
        typeof f.virtualEnergyPerLapPct === "number" ? f.virtualEnergyPerLapPct.toFixed(1) : "—",
        typeof f.virtualEnergyPerLapPct === "number" ? "%" : null
      );
      setStat(
        "veLapsLeft",
        typeof f.virtualEnergyLapsRemaining === "number"
          ? f.virtualEnergyLapsRemaining.toFixed(1)
          : "—",
        null
      );
      setMargin("veMargin", f.virtualEnergyDeltaPct, f.virtualEnergyPerLapPct, fmt, "%");

      var eLine = "Virtual energy · rotates 20s";
      if (cache.refuel !== eLine) { cache.refuel = eLine; refuelEl.textContent = eLine; }
      if (cache.pit !== "") { cache.pit = ""; pitEl.textContent = ""; }
      return;
    }

    setStat("perLap", fmt.liters(f.perLapAvgLiters), "L");
    setStat("lapsLeft", fmt.intVal(f.lapsRemaining), null);
    setStat("toFinish", fmt.liters(f.fuelToFinishLiters), "L");
    setMargin("margin", f.fuelDeltaLiters, f.perLapAvgLiters, fmt, "L");

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
