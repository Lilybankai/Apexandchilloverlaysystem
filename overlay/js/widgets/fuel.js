/**
 * widgets/fuel.js — fuel calculator readout (mid-right).
 * -----------------------------------------------------------------------------
 * Renders `frame.fuel` (FuelState) computed server-side by the fuel calculator:
 * consumption per lap, laps remaining on current fuel, litres to the finish and
 * the margin at the flag (colour-coded surplus/short), plus refuel-to-finish
 * and the pit window. Values are display-ready; this widget only formats them.
 *
 * A session strip across the top says how much of the session is left — the lap
 * counter and laps to go in a race, the session name and the clock in practice
 * and qualifying, where there is no lap total to count towards. Every figure
 * below it is measured against that one.
 *
 * Across the top, above everything else, are the four cubes that carry the whole
 * answer on their own — how much is in it, and how far that goes — laid out one
 * budget per row beside that budget's own bar:
 *
 *     ▓▓▓▓▓▓▓▓░░░░░░   [ FUEL  50.9 L ] [ LAPS 12.3 ]
 *     ▓▓▓▓▓░░░░░░░░░   [ ENERGY  62 % ] [ LAPS 10.1 ]
 *
 * The cubes sit at the TOP because they are the readout to find from the corner
 * of an eye at 180 mph; everything below them is the working that produced them,
 * and working belongs under its answer. The bar beside each pair is the same
 * quantity as a shape, which is what makes "nearly empty" readable without
 * reading a number at all.
 *
 * The row is a grid of `1fr auto auto`: the BAR absorbs every pixel of width the
 * widget gains or loses, and the cubes never move off their own size. Squeezing
 * a Tier 1 number to fit a narrower panel would defeat the reason it is Tier 1 —
 * a bar squeezed to half its length still reads as a fraction of a tank.
 *
 * Fuel and energy are separate budgets that drain at different rates and are
 * refilled from different rows of the pit menu, so both are permanent and
 * neither is ever inferred from the other.
 *
 * **Nothing on this widget cycles.** Below the cubes both budgets are shown in
 * full, at once: the FUEL block (per lap, laps left, to finish, margin at the
 * flag) and, on cars that run one, the VIRTUAL ENERGY block with the same four
 * figures in its own units. This used to rotate the two every 20 seconds, which
 * meant that half the time the number a driver looked down for was the one not
 * on screen — and a fuel call is made in the two seconds before the pit entry,
 * not whenever the rotation next comes round. A car with no energy budget loses
 * its energy row and its energy block entirely, rather than being drawn empty.
 */
(function () {
  "use strict";

  var header, overlapEl, energyHead, topBox;
  var stats = {};
  var bars = {};
  var cubes = {};
  var refuelEl, pitEl, setAlarm, setSession;
  var cache = {};
  var grids = {};
  /** Shared widget context, kept so the setters can reach the glow helpers. */
  var octx = null;

  /**
   * Bloom a Tier 1 stat when its WHOLE number moves.
   *
   * Laps left and energy remaining drift continuously — a bloom on every tick of
   * the first decimal would strobe for the entire race and stop meaning
   * anything. Losing a whole lap of range is the event actually worth looking up
   * for.
   */
  function pulseOnStep(el, ck, value) {
    if (!octx || !octx.critPulse) return;
    if (!el || typeof value !== "number" || !isFinite(value)) return;
    var step = Math.floor(value);
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

  /**
   * One budget's row of the top block: its fill bar, then its two cubes.
   *
   * The three go straight into the shared grid rather than into a wrapper of
   * their own, so the fuel row's cubes and the energy row's cubes sit in the
   * same two columns — the pair you want is a POSITION (top-right, bottom-right)
   * rather than a label to read. `data-res` on all three is what lets the whole
   * energy row be hidden with one attribute on the grid, and what colours the
   * bar and the cube stripes per budget.
   *
   * Each budget carries its own laps figure because litres and percent are not
   * what a driver plans in — laps are. 50.9 L means nothing without the burn rate
   * beside it, and the two budgets do not run out on the same lap, so a single
   * shared figure would be wrong for one of them. This is the same pairing the
   * car's own dash makes ("83.0L (37.6 laps)"), kept per budget.
   */
  function makeTopRow(parent, res, label) {
    var bar = document.createElement("div");
    bar.className = "bar fuel__topbar";
    bar.setAttribute("data-res", res);
    var fill = document.createElement("div");
    fill.className = "bar__fill";
    bar.appendChild(fill);
    parent.appendChild(bar);
    bars[res] = fill;
    // "LAPS", not "FUEL LAPS": at a narrow panel width the label is the first
    // thing to run out of room, and the row it sits in already says which budget
    // it belongs to — in its colour, its stripe and its position.
    makeCube(parent, res + "Qty", label, res, false);
    makeCube(parent, res + "Laps", "LAPS", res, true);
  }

  /**
   * Write a budget's bar. `pct` is the tank fraction for fuel and the percentage
   * itself for energy — the shape of the quantity, beside the number for it.
   */
  function setBar(res, pct) {
    var fill = bars[res];
    if (!fill) return;
    var w =
      (typeof pct === "number" && isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0).toFixed(1) +
      "%";
    var ck = "bar_" + res;
    if (cache[ck] === w) return;
    cache[ck] = w;
    fill.style.width = w;
  }

  /**
   * A block heading. These name the two budgets now that both are on screen at
   * once — with one view showing at a time the chip could say which it was, and
   * with both showing, each grid has to say which it is or the eight figures
   * below read as one confusing set of eight.
   */
  function makeSectionHead(parent, text, mode) {
    var h = document.createElement("div");
    h.className = "fuel__mode";
    h.textContent = text;
    h.setAttribute("data-mode", mode);
    parent.appendChild(h);
    return h;
  }

  /**
   * One cube of the four-cube readout across the top of the widget.
   *
   * The cubes are a deliberate duplicate of figures that appear below them, and
   * that is the point: everything under them is the working — burn rate, litres
   * to the finish, the margin at the flag — and this is the answer, in the two
   * units a driver acts on. How much is in it, and how far that goes.
   *
   * `res` tags the budget so the energy pair can take the same cyan its bar
   * does, and so the whole energy row can be dropped on a car that has no energy
   * budget rather than printing a confident 0.0 for a thing it does not have.
   */
  function makeCube(parent, key, label, res, glow) {
    var c = document.createElement("div");
    c.className = "fuel__cube";
    c.setAttribute("data-res", res);
    var l = document.createElement("div");
    l.className = "fuel__cube-label";
    l.textContent = label;
    var v = document.createElement("div");
    // Only the laps cubes bloom. Litres and percent drift continuously, and a
    // glow on every tick of a decimal strobes for the whole race and stops
    // meaning anything — losing a whole LAP of range is the event worth a look.
    v.className = glow ? "fuel__cube-value is-crit" : "fuel__cube-value";
    v.textContent = "—";
    c.appendChild(l);
    c.appendChild(v);
    parent.appendChild(c);
    cubes[key] = { root: c, val: v };
  }

  /** Write a cube's value. */
  function setCube(key, html) {
    var c = cubes[key];
    if (!c) return;
    var ck = "c_" + key;
    if (cache[ck] === html) return;
    cache[ck] = html;
    c.val.innerHTML = html;
  }

  function init(root) {
    header = root.querySelector('[data-role="tank"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    // How much session is left, above everything else. Every number under it is
    // measured against that one: laps left in the tank only means anything
    // beside laps left in the race, and "+4.2 L margin" is a margin to the
    // finish. The same strip the standings tower carries, from the same source,
    // so the two panels cannot state a different number of laps to go.
    setSession = window.ApexOverlay.sessionStrip(mount, { small: true });

    // The answer, first: a bar and its two cubes per budget, fuel above energy.
    // One grid rather than two rows so the cube columns line up between the
    // budgets, and so the bar column is the single flexible track that gives up
    // its width when the widget is narrowed.
    topBox = document.createElement("div");
    topBox.className = "fuel__top";
    makeTopRow(topBox, "fuel", "FUEL");
    makeTopRow(topBox, "energy", "ENERGY");
    mount.appendChild(topBox);

    // The fuel block, headed so it cannot be confused with the energy block
    // below it — both are on screen together now.
    makeSectionHead(mount, "FUEL", "fuel");
    var fuelGrid = document.createElement("div");
    fuelGrid.className = "fuel__grid";
    makeStat(fuelGrid, "perLap", "Per Lap", false);
    makeStat(fuelGrid, "lapsLeft", "Laps Left", true);
    makeStat(fuelGrid, "toFinish", "To Finish", false);
    makeStat(fuelGrid, "margin", "Margin", true);
    mount.appendChild(fuelGrid);
    grids.fuel = fuelGrid;

    // The energy block: same grid shape, VE-denominated stats. Hidden as a whole
    // (heading included) on a car with no energy budget — there is nothing to say
    // about it, and an empty block reads as an exhausted one.
    energyHead = makeSectionHead(mount, "VIRTUAL ENERGY", "energy");
    var energyGrid = document.createElement("div");
    energyGrid.className = "fuel__grid";
    makeStat(energyGrid, "veRemain", "Remaining", true);
    makeStat(energyGrid, "vePerLap", "Per Lap", false);
    makeStat(energyGrid, "veLapsLeft", "Laps Left", true);
    makeStat(energyGrid, "veMargin", "Margin", true);
    mount.appendChild(energyGrid);
    grids.energy = energyGrid;

    // Energy-overlap chip: "how many cars ahead have to pit before me" is a
    // strategy call the driver may need at any moment.
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

    // Added last so it inserts itself ABOVE everything built above it — a call
    // the driver has one lap to act on belongs at the top of the panel.
    setAlarm = window.ApexOverlay.alarmBar(mount, "fuel");
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
    // Written before the fuel block bails out: how much session is left is a
    // fact about the session, and it is still true (and still worth showing) on
    // a car the calculator has nothing to say about — a spectated entry, or the
    // first laps before a burn rate exists.
    setSession(frame.session);
    if (!f) return;

    setAlarm(f.pitThisLap === true, pitCallText(f));
    updateOverlap(f);

    // The energy row and block exist only on cars that run an energy budget.
    // Everything else on the widget is permanent — no view is ever hidden behind
    // another. One attribute on the top grid takes its bar and both of its cubes
    // out together (see .fuel__top[data-energy="off"]), which is also what keeps
    // the fuel row's cubes in the columns they were already in.
    var hasEnergy = typeof f.virtualEnergyPct === "number";
    if (cache.hasEnergy !== hasEnergy) {
      cache.hasEnergy = hasEnergy;
      topBox.setAttribute("data-energy", hasEnergy ? "on" : "off");
      grids.energy.style.display = hasEnergy ? "" : "none";
      energyHead.style.display = hasEnergy ? "" : "none";
    }

    // fmt.has screens out the UNKNOWN sentinel; an empty tank is a real 0.
    var lvl = fmt.has(f.levelLiters) ? f.levelLiters : null;
    var cap =
      typeof f.capacityLiters === "number" && f.capacityLiters > 0 ? f.capacityLiters : null;
    // Laps of range on each budget, from the server's own rolling burn average.
    // Both are published whether or not the litres are (a spectated car has no
    // readable tank size but its laps-remaining is still known), so the figure
    // survives cases where the quantity beside it cannot be shown.
    var fuelLaps = fmt.has(f.lapsRemaining) ? f.lapsRemaining : null;
    var veLaps =
      typeof f.virtualEnergyLapsRemaining === "number" && f.virtualEnergyLapsRemaining >= 0
        ? f.virtualEnergyLapsRemaining
        : null;
    setBar("fuel", cap != null && lvl != null ? (lvl / cap) * 100 : 0);
    // A car with no energy budget has no second bar to draw — showing an empty
    // one would read as "energy exhausted" rather than "not applicable". The row
    // is already gone (data-energy above); this just skips writing into it.
    if (hasEnergy) setBar("energy", f.virtualEnergyPct);

    // The four cubes: how much is in it, and how far that goes, per budget.
    setCube("fuelQty", lvl != null ? lvl.toFixed(1) + "<small> L</small>" : "—");
    setCube("fuelLaps", fuelLaps != null ? fuelLaps.toFixed(1) : "—");
    setCube(
      "energyQty",
      hasEnergy ? f.virtualEnergyPct.toFixed(1) + "<small> %</small>" : "—"
    );
    setCube("energyLaps", hasEnergy && veLaps != null ? veLaps.toFixed(1) : "—");
    pulseOnStep(cubes.fuelLaps.val, "cubeFuelLapsStep", fuelLaps);
    if (hasEnergy) pulseOnStep(cubes.energyLaps.val, "cubeEnergyLapsStep", veLaps);

    // Header carries both budgets at once, so the panel answers "what is in the
    // car" from its title bar alone even when it is collapsed to the header.
    if (header) {
      var hdr = fmt.liters(f.levelLiters) + " L";
      if (hasEnergy) hdr += " · " + Math.round(f.virtualEnergyPct) + "%";
      if (cache.tank !== hdr) { cache.tank = hdr; header.textContent = hdr; }
    }

    setStat("perLap", fmt.liters(f.perLapAvgLiters), "L");
    setStat("lapsLeft", fmt.intVal(f.lapsRemaining), null);
    setStat("toFinish", fmt.liters(f.fuelToFinishLiters), "L");
    setMargin("margin", f.fuelDeltaLiters, f.perLapAvgLiters, fmt, "L");
    pulseOnStep(stats.lapsLeft, "lapsLeftStep", f.lapsRemaining);

    // The energy block, in its own units, beside the fuel one rather than
    // instead of it — on an LMU hypercar energy is usually what ends the stint,
    // but which of the two bites first is exactly the question being asked.
    if (hasEnergy) {
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
      pulseOnStep(stats.veRemain, "veRemainStep", f.virtualEnergyPct);
      pulseOnStep(stats.veLapsLeft, "veLapsLeftStep", f.virtualEnergyLapsRemaining);
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
