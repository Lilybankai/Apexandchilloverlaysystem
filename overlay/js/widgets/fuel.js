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
  var refuelEl, pitEl, setAlarm;
  var cache = {};
  var grids = {};
  /** Shared widget context, kept so the setters can reach the glow helpers. */
  var octx = null;

  /**
   * Bloom a Tier 1 stat when its WHOLE number moves.
   *
   * Laps left and energy remaining drift continuously — a bloom on every tick of
   * the first decimal would strobe for the entire race and stop meaning
   * anything. Losing a whole lap of range, or another whole percent of energy, is
   * the event actually worth looking up for.
   */
  function pulseOnStep(key, value) {
    if (!octx || !octx.critPulse) return;
    var el = stats[key];
    if (!el || typeof value !== "number" || !isFinite(value)) return;
    var step = Math.floor(value);
    var ck = key + "Step";
    if (cache[ck] === step) return;
    var first = cache[ck] === undefined;
    cache[ck] = step;
    if (!first) octx.critPulse(el);
  }

  /**
   * @param {boolean} hero  Tier 1 — sized to be read at a glance, and glowing on
   *   a discrete change. "Laps left" and "margin at the flag" answer the only
   *   question this widget exists to answer; consumption per lap and litres to
   *   the finish are how that answer was reached, and stay Tier 2.
   */
  function makeStat(grid, key, label, hero) {
    var wrap = document.createElement("div");
    wrap.className = "fuel__stat";
    var l = document.createElement("div");
    l.className = "fuel__stat-label";
    l.textContent = label;
    var v = document.createElement("div");
    v.className = hero ? "fuel__stat-value fuel__stat-value--hero is-crit" : "fuel__stat-value";
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
    makeStat(fuelGrid, "perLap", "Per Lap", false);
    makeStat(fuelGrid, "lapsLeft", "Laps Left", true);
    makeStat(fuelGrid, "toFinish", "To Finish", false);
    makeStat(fuelGrid, "margin", "Margin", true);
    mount.appendChild(fuelGrid);
    grids.fuel = fuelGrid;

    // Energy view: same grid shape, VE-denominated stats.
    var energyGrid = document.createElement("div");
    energyGrid.className = "fuel__grid";
    energyGrid.style.display = "none";
    makeStat(energyGrid, "veRemain", "Remaining", true);
    makeStat(energyGrid, "vePerLap", "Per Lap", false);
    makeStat(energyGrid, "veLapsLeft", "Laps Left", true);
    makeStat(energyGrid, "veMargin", "Margin", true);
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

    // Added last so it inserts itself ABOVE everything built above it, and
    // outside the rotating FUEL/ENERGY grids — a call the driver has one lap to
    // act on cannot be hidden behind a 20-second rotation.
    setAlarm = window.ApexOverlay.alarmBar(mount);
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
    // Crossing ok → marginal → short is the discrete event inside a continuously
    // drifting number, so the bucket is what blooms. critAttr writes the
    // attribute as well, so this stays a single source of truth for the state.
    if (state) {
      if (octx && octx.critAttr) octx.critAttr(el, "data-state", state);
      else el.setAttribute("data-state", state);
    } else if (el.hasAttribute("data-state")) {
      el.removeAttribute("data-state");
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

  /**
   * Which budget sent the driver in. Fuel and energy are refilled from different
   * rows of the pit menu, so an alarm that only said "PIT" would leave the one
   * decision it triggered still to be worked out.
   */
  function pitCallText(f) {
    return f.pitThisLapReason === "energy"
      ? "⛽ PIT THIS LAP FOR ENERGY"
      : "⛽ PIT THIS LAP FOR FUEL";
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    octx = ctx;
    var f = frame.fuel;
    if (!f) return;

    setAlarm(f.pitThisLap === true, pitCallText(f));
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
      pulseOnStep("veRemain", f.virtualEnergyPct);
      pulseOnStep("veLapsLeft", f.virtualEnergyLapsRemaining);

      var eLine = "Virtual energy · rotates 20s";
      if (cache.refuel !== eLine) { cache.refuel = eLine; refuelEl.textContent = eLine; }
      if (cache.pit !== "") { cache.pit = ""; pitEl.textContent = ""; }
      return;
    }

    setStat("perLap", fmt.liters(f.perLapAvgLiters), "L");
    setStat("lapsLeft", fmt.intVal(f.lapsRemaining), null);
    setStat("toFinish", fmt.liters(f.fuelToFinishLiters), "L");
    setMargin("margin", f.fuelDeltaLiters, f.perLapAvgLiters, fmt, "L");
    pulseOnStep("lapsLeft", f.lapsRemaining);

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
