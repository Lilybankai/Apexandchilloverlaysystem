/**
 * widgets/fuelplan.js — pre-race Fuel Planner + live Virtual-Energy stint timer.
 * -----------------------------------------------------------------------------
 * A start-of-race planning widget built on the ported Fuel Calculator engine
 * (data/racedata.js → window.ApexRaceData). Three parts:
 *
 *   1. PLAN      — window.ApexRaceData.calculateFuel() over the chosen (or
 *                  auto-detected) track/car/race-length: total fuel, laps, pit
 *                  stops, laps-per-stint, and a per-stint breakdown.
 *   2. LIVE      — what is in the car right now, as two permanent bars: LMU's
 *                  virtual energy (frame.fuel.virtualEnergy*) as % of budget,
 *                  and the fuel level as litres + fraction of tank. They are
 *                  separate budgets consumed at different rates and refilled
 *                  from different pit rows, so both are always shown; the one
 *                  that binds the stint takes the larger size. Below them: the
 *                  predicted pit lap, refuel to finish, save-per-lap target and
 *                  the margin at the flag. Cars with no VE hide the energy bar.
 *   3. FUEL RATIO — reads the "FUEL RATIO:" pit-menu row from frame.mfd and lets
 *                  the driver step it with −/+ (POST /api/mfd/pit → LMU REST),
 *                  the same control path the MFD server routes expose.
 *
 * A collapsible SETUP panel holds the inputs. With AUTO on, race time / measured
 * burn / tank capacity are pulled live from telemetry each frame; touching any
 * field switches to manual so the driver can plan an arbitrary race offline.
 * Selections persist to localStorage.
 *
 * URL params:  ?setup=open  start with the inputs expanded.
 */
(function () {
  "use strict";

  // Bumped on storage-shape/semantics changes so stale saved state can't carry
  // over. v3: AUTO defaults on again, and race length / car no longer flip it
  // off — a persisted auto:false from the old behaviour must be cleared.
  var LS_KEY = "apex-fuelplan-v3";
  var RD = window.ApexRaceData;

  // LMU's normalized class label (telemetry/carClass) → racedata class id.
  // LMU collapses today's LMGT3 grid onto "GT3"; there is no GT4 in the data.
  var CLASS_MAP = {
    HYPERCAR: "hypercar",
    LMP2: "lmp2",
    LMP3: "lmp3",
    GTE: "gte",
    GT3: "lmgt3",
  };

  // Distinctive substrings that identify a circuit from LMU's free-text track
  // name (lower-cased). First circuit with any hit wins.
  var CIRCUIT_KEYS = {
    portimao: ["portimao", "algarve"],
    imola: ["imola", "enzo", "dino"],
    monza: ["monza"],
    interlagos: ["interlagos", "carlos pace", "jose carlos"],
    bahrain: ["bahrain", "sakhir"],
    barcelona: ["barcelona", "catalunya"],
    lemans: ["le mans", "lemans", "sarthe"],
    spa: ["spa", "francorchamps"],
    cota: ["americas", "cota", "austin"],
    fuji: ["fuji"],
    qatar: ["qatar", "lusail"],
    paul_ricard: ["paul ricard", "ricard", "castellet"],
    sebring: ["sebring"],
    silverstone: ["silverstone"],
  };

  // Persisted planning state (track/car identity + manual overrides + UI).
  var S = {
    circuitId: "lemans",
    layoutId: "lemans_full",
    classId: "hypercar",
    carId: "toyota_gr010",
    raceMinutes: 60,
    safetyLaps: 2,
    customFuelPerLap: null,
    customLapTime: null,
    customTankCapacity: null,
    auto: true,
    setupOpen: false,
  };

  // Live values captured from telemetry (used when AUTO is on).
  var live = { raceMin: null, burn: null, tank: null, lapTime: null };
  // The fuel-ratio pit row currently on the wire (for the ±  write target).
  var ratioRow = null;

  var els = {}; // cached DOM references
  var cache = {}; // last-rendered text, to avoid churn
  var mounted = false;
  var setAlarm = null; // shared pit-call banner (ApexOverlay.alarmBar)
  var lastPlan = null; // most recent calculateFuel() result
  var lastStints = []; // most recent stint plan (for live highlighting)

  /* ------------------------------ persistence ---------------------------- */

  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      for (var k in S) {
        if (Object.prototype.hasOwnProperty.call(saved, k) && saved[k] != null) S[k] = saved[k];
      }
    } catch (e) {
      /* first run / private mode — defaults are fine */
    }
  }

  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(S));
    } catch (e) {
      /* ignore */
    }
  }

  /* --------------------------------- helpers ------------------------------ */

  /** Shared widget context, kept so the setters below can reach ctx.crit*. */
  var octx = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setText(node, text) {
    if (node && cache[node.__ck] !== text) {
      cache[node.__ck] = text;
      node.textContent = text;
    }
  }

  /**
   * As setText, for a Tier 1 value that should bloom when it changes. Used for
   * the values that step rather than drift — the predicted pit lap above all,
   * because it moving means the plan just moved.
   */
  function setCritText(node, text) {
    if (!node || cache[node.__ck] === text) return;
    cache[node.__ck] = text;
    if (octx && octx.crit) octx.crit(node, text);
    else node.textContent = text;
  }

  /**
   * Bloom a continuously-drifting value only when its whole number moves — see
   * the same reasoning in widgets/fuel.js. Another whole percent of energy gone
   * is news; the first decimal ticking over is not.
   */
  function pulseOnStep(node, value) {
    if (!node || !octx || !octx.critPulse) return;
    if (typeof value !== "number" || !isFinite(value)) return;
    var k = node.__ck + "_step";
    var step = Math.floor(value);
    if (cache[k] === step) return;
    var first = cache[k] === undefined;
    cache[k] = step;
    if (!first) octx.critPulse(node);
  }

  /** Register a node under a cache key so setTextKeyed avoids redundant writes. */
  function keyed(node, key) {
    node.__ck = key;
    return node;
  }

  /** Minutes:seconds from a duration in seconds (em dash if non-positive). */
  function mmss(sec) {
    if (!(sec > 0) || !isFinite(sec)) return "—";
    var m = Math.floor(sec / 60);
    var s = Math.round(sec - m * 60);
    if (s === 60) {
      m += 1;
      s = 0;
    }
    return m + ":" + (s < 10 ? "0" + s : String(s));
  }

  function num(v) {
    return typeof v === "number" && isFinite(v);
  }

  /* --------------------------- setup / inputs ----------------------------- */

  function option(value, label) {
    var o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  function fillSelect(sel, entries, value) {
    sel.textContent = "";
    for (var i = 0; i < entries.length; i++) sel.appendChild(option(entries[i][0], entries[i][1]));
    if (value != null) sel.value = value;
  }

  function circuitEntries() {
    return RD.CIRCUITS.map(function (c) {
      return [c.id, c.name];
    });
  }
  function layoutEntries(circuitId) {
    var c = RD.getCircuit(circuitId);
    if (!c) return [];
    return c.layouts.map(function (l) {
      return [l.id, l.name];
    });
  }
  function classEntries() {
    return RD.CAR_CLASSES.map(function (c) {
      return [c.id, c.name];
    });
  }
  function carEntries(classId) {
    var list = RD.CARS[classId] || [];
    return list.map(function (c) {
      return [c.id, c.name];
    });
  }

  /** Turn AUTO off (a manual edit) and reflect it in the toggle. */
  function goManual() {
    if (S.auto) {
      S.auto = false;
      if (els.auto) els.auto.checked = false;
    }
  }

  function labelledRow(labelText, control) {
    var row = el("label", "fuelplan__field");
    row.appendChild(el("span", "fuelplan__field-label", labelText));
    row.appendChild(control);
    // Don't let clicks on inputs start an in-game drag of the widget.
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      row.addEventListener(evt, function (e) {
        e.stopPropagation();
      });
    });
    return row;
  }

  function numberInput(value, min, max, step, placeholder) {
    var i = document.createElement("input");
    i.type = "number";
    i.className = "fuelplan__num";
    if (min != null) i.min = String(min);
    if (max != null) i.max = String(max);
    if (step != null) i.step = String(step);
    if (placeholder) i.placeholder = placeholder;
    if (value != null) i.value = String(value);
    return i;
  }

  function buildSetup(mount) {
    var box = el("div", "fuelplan__setup");
    box.setAttribute("data-open", S.setupOpen ? "true" : "false");

    // --- header: collapse toggle + AUTO switch ---
    var head = el("div", "fuelplan__setup-head");
    var toggle = el("button", "fuelplan__setup-toggle", "SETUP");
    toggle.type = "button";
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      S.setupOpen = !S.setupOpen;
      box.setAttribute("data-open", S.setupOpen ? "true" : "false");
      toggle.setAttribute("data-open", S.setupOpen ? "true" : "false");
      saveState();
    });
    toggle.setAttribute("data-open", S.setupOpen ? "true" : "false");

    var autoWrap = el("label", "fuelplan__auto");
    var auto = document.createElement("input");
    auto.type = "checkbox";
    auto.checked = S.auto;
    auto.addEventListener("change", function (e) {
      e.stopPropagation();
      S.auto = auto.checked;
      saveState();
      recompute();
    });
    els.auto = auto;
    autoWrap.appendChild(auto);
    autoWrap.appendChild(el("span", null, "AUTO"));
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      autoWrap.addEventListener(evt, function (e) {
        e.stopPropagation();
      });
    });

    head.appendChild(toggle);
    head.appendChild(autoWrap);
    box.appendChild(head);

    // --- body: selectors + numeric overrides ---
    var body = el("div", "fuelplan__setup-body");

    var circuit = document.createElement("select");
    circuit.className = "fuelplan__select";
    fillSelect(circuit, circuitEntries(), S.circuitId);
    circuit.addEventListener("change", function () {
      goManual();
      S.circuitId = circuit.value;
      var layouts = layoutEntries(S.circuitId);
      S.layoutId = layouts.length ? layouts[0][0] : null;
      fillSelect(layout, layouts, S.layoutId);
      saveState();
      recompute();
    });
    els.circuit = circuit;

    var layout = document.createElement("select");
    layout.className = "fuelplan__select";
    fillSelect(layout, layoutEntries(S.circuitId), S.layoutId);
    layout.addEventListener("change", function () {
      goManual();
      S.layoutId = layout.value;
      saveState();
      recompute();
    });
    els.layout = layout;

    var klass = document.createElement("select");
    klass.className = "fuelplan__select";
    fillSelect(klass, classEntries(), S.classId);
    klass.addEventListener("change", function () {
      goManual();
      S.classId = klass.value;
      var cars = carEntries(S.classId);
      S.carId = cars.length ? cars[0][0] : null;
      fillSelect(car, cars, S.carId);
      saveState();
      recompute();
    });
    els.klass = klass;

    var car = document.createElement("select");
    car.className = "fuelplan__select";
    fillSelect(car, carEntries(S.classId), S.carId);
    // Car can't be auto-detected (not in telemetry), so picking it must NOT
    // turn AUTO off — otherwise choosing your car would also stop the live
    // burn/tank/track auto-fill. Auto-detect only ever changes the car on a
    // class change, so a manual pick sticks while AUTO stays on.
    car.addEventListener("change", function () {
      S.carId = car.value;
      saveState();
      recompute();
    });
    els.car = car;

    // Race length is a planning input, not a measured value — editable at any
    // time WITHOUT dropping AUTO, so you can dial in the correct race length on
    // the grid while track/class/burn/tank keep auto-filling. During an actual
    // race the live race length still takes over (see captureLive/effective).
    var raceMin = numberInput(S.raceMinutes, 1, 1440, 5);
    raceMin.addEventListener("input", function () {
      S.raceMinutes = clampNum(raceMin.value, 1, 1440, S.raceMinutes);
      saveState();
      recompute();
    });
    els.raceMin = raceMin;

    var safety = numberInput(S.safetyLaps, 0, 10, 1);
    safety.addEventListener("input", function () {
      S.safetyLaps = clampNum(safety.value, 0, 20, S.safetyLaps);
      saveState();
      recompute();
    });
    els.safety = safety;

    var burn = numberInput(S.customFuelPerLap, 0, 20, 0.01, "auto");
    burn.addEventListener("input", function () {
      goManual();
      S.customFuelPerLap = burn.value === "" ? null : clampNum(burn.value, 0, 20, null);
      saveState();
      recompute();
    });
    els.burn = burn;

    var tank = numberInput(S.customTankCapacity, 20, 150, 1, "auto");
    tank.addEventListener("input", function () {
      goManual();
      S.customTankCapacity = tank.value === "" ? null : clampNum(tank.value, 1, 300, null);
      saveState();
      recompute();
    });
    els.tank = tank;

    body.appendChild(labelledRow("Circuit", circuit));
    body.appendChild(labelledRow("Layout", layout));
    body.appendChild(labelledRow("Class", klass));
    body.appendChild(labelledRow("Car", car));
    body.appendChild(labelledRow("Race (min)", raceMin));
    body.appendChild(labelledRow("Safety laps", safety));
    body.appendChild(labelledRow("Fuel / lap", burn));
    body.appendChild(labelledRow("Tank (L)", tank));

    box.appendChild(body);
    mount.appendChild(box);
  }

  function clampNum(raw, min, max, fallback) {
    var v = parseFloat(raw);
    if (!isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  }

  /* ------------------------------- structure ------------------------------ */

  /** @param {boolean} [crit]  Tier 1 — glows when it steps (see setCritText). */
  function statCell(grid, key, label, crit) {
    var cell = el("div", "fuelplan__stat");
    cell.appendChild(el("div", "fuelplan__stat-label", label));
    var cls = crit ? "fuelplan__stat-value is-crit" : "fuelplan__stat-value";
    var v = keyed(el("div", cls, "—"), "stat_" + key);
    cell.appendChild(v);
    grid.appendChild(cell);
    els[key] = v;
  }

  /**
   * One always-on resource readout: label, big live quantity, and a fill bar.
   * Stores `<key>Big` / `<key>Fill` on `els` for the update pass.
   */
  function resourceRow(parent, res, label, key) {
    var row = el("div", "fuelplan__res");
    row.setAttribute("data-res", res);
    var head = el("div", "fuelplan__stint-head");
    var mode = el("span", "fuelplan__stint-mode", label);
    mode.setAttribute("data-mode", res);
    var big = keyed(el("span", "fuelplan__stint-big is-crit", "—"), key + "Big");
    head.appendChild(mode);
    head.appendChild(big);
    row.appendChild(head);
    var bar = el("div", "bar fuelplan__bar");
    var fill = el("div", "bar__fill");
    bar.appendChild(fill);
    row.appendChild(bar);
    parent.appendChild(row);
    els[key + "Big"] = big;
    els[key + "Fill"] = fill;
    return row;
  }

  function buildBody(mount) {
    mount.textContent = "";

    // --- STRATEGY hero: the one number to act on (fuel to load) + stop count ---
    var hero = el("div", "fuelplan__hero");
    var loadWrap = el("div", "fuelplan__load");
    loadWrap.appendChild(el("span", "fuelplan__load-label", "LOAD"));
    els.load = keyed(el("span", "fuelplan__load-val", "—"), "load");
    loadWrap.appendChild(els.load);
    els.stopsChip = keyed(el("span", "fuelplan__stops", "—"), "stopsChip");
    hero.appendChild(loadWrap);
    hero.appendChild(els.stopsChip);
    mount.appendChild(hero);
    els.heroSub = keyed(el("div", "fuelplan__sub", "—"), "heroSub");
    mount.appendChild(els.heroSub);

    // --- STINT PLAN table (rebuilt only when the plan changes) ---
    els.stintTable = el("div", "fuelplan__stints");
    mount.appendChild(els.stintTable);

    // --- LIVE: what is in the car right now + predicted pit + save target ---
    //
    // Two permanent rows, one per budget. Virtual energy and fuel are consumed
    // at different rates over a stint and are added from different pit-menu
    // rows, so the litres in the tank can never be read off the energy figure
    // (or the reverse) — both are always on screen, neither cycles.
    var liveBox = el("div", "fuelplan__live");
    els.liveBox = liveBox;
    els.veRow = resourceRow(liveBox, "energy", "VIRTUAL ENERGY", "ve");
    els.fuelRow = resourceRow(liveBox, "fuel", "FUEL", "fuelLvl");

    var liveGrid = el("div", "fuelplan__grid");
    statCell(liveGrid, "nextPit", "Next Pit", true);
    statCell(liveGrid, "toFinish", "To Finish");
    statCell(liveGrid, "save", "Save/Lap", true);
    statCell(liveGrid, "margin", "Margin", true);
    liveBox.appendChild(liveGrid);
    mount.appendChild(liveBox);

    // --- FUEL RATIO ---
    var ratio = el("div", "fuelplan__ratio");
    ratio.appendChild(el("span", "fuelplan__ratio-label", "FUEL RATIO"));
    els.ratioVal = keyed(el("span", "fuelplan__ratio-val", "—"), "ratioVal");
    ratio.appendChild(els.ratioVal);
    var ctrls = el("div", "fuelplan__ratio-ctrls");
    els.ratioDec = ratioButton("−", -1);
    els.ratioInc = ratioButton("+", +1);
    ctrls.appendChild(els.ratioDec);
    ctrls.appendChild(els.ratioInc);
    ratio.appendChild(ctrls);
    mount.appendChild(ratio);

    // --- SETUP (collapsible inputs) ---
    buildSetup(mount);

    // Built last so it inserts itself above the strategy hero: on the lap it
    // fires, which lap to come in on outranks how much to put in when you do.
    setAlarm = window.ApexOverlay.alarmBar(mount, "fuel");

    mounted = true;
  }

  function ratioButton(glyph, delta) {
    var b = el("button", "fuelplan__step", glyph);
    b.type = "button";
    b.disabled = true;
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      b.addEventListener(evt, function (e) {
        e.stopPropagation();
      });
    });
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      adjustRatio(delta);
    });
    return b;
  }

  /* --------------------------- fuel-ratio write --------------------------- */

  function adjustRatio(delta) {
    if (!ratioRow) return;
    var body = { delta: delta };
    if (ratioRow.pmcValue != null) body.pmcValue = ratioRow.pmcValue;
    if (ratioRow.name) body.name = ratioRow.name;
    els.ratioVal.setAttribute("data-busy", "true");
    fetch("/api/mfd/pit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return { ok: r.ok };
        });
      })
      .then(function (res) {
        els.ratioVal.removeAttribute("data-busy");
        if (!res || res.ok === false) flashRatioError();
        // The next telemetry frame carries the updated row; no manual refresh.
      })
      .catch(function () {
        els.ratioVal.removeAttribute("data-busy");
        flashRatioError();
      });
  }

  function flashRatioError() {
    els.ratioVal.setAttribute("data-error", "true");
    setTimeout(function () {
      els.ratioVal.removeAttribute("data-error");
    }, 1200);
  }

  /* ---------------------- auto identity detection ------------------------- */

  function setSelectValue(sel, val) {
    if (sel && val != null && sel.value !== val) sel.value = val;
  }

  /** Circuit id from LMU's track name, or null when nothing matches. */
  function detectCircuit(trackStr) {
    var hay = String(trackStr || "").toLowerCase();
    if (!hay) return null;
    for (var id in CIRCUIT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(CIRCUIT_KEYS, id)) continue;
      var keys = CIRCUIT_KEYS[id];
      for (var i = 0; i < keys.length; i++) {
        if (hay.indexOf(keys[i]) >= 0) return id;
      }
    }
    return null;
  }

  /** Layout id within a circuit, from the track name + config string. */
  function detectLayout(circuitId, trackStr, cfgStr) {
    var c = RD.getCircuit(circuitId);
    if (!c) return null;
    var hay = ((cfgStr || "") + " " + (trackStr || "")).toLowerCase();
    // Distinctive non-GP layout words take priority.
    var SPECIAL = [
      "mulsanne", "endurance", "national", "international", "outer",
      "paddock", "short", "classic", "school", "curva grande",
    ];
    for (var i = 0; i < c.layouts.length; i++) {
      var name = c.layouts[i].name.toLowerCase();
      var idl = c.layouts[i].id.toLowerCase();
      for (var s = 0; s < SPECIAL.length; s++) {
        if (name.indexOf(SPECIAL[s]) >= 0 && hay.indexOf(SPECIAL[s]) >= 0) return c.layouts[i].id;
        if (idl.indexOf(SPECIAL[s].replace(/ /g, "_")) >= 0 && hay.indexOf(SPECIAL[s]) >= 0)
          return c.layouts[i].id;
      }
    }
    // Grand-Prix / full / WEC phrasing → the GP-ish layout.
    if (/grand|gp|full|wec|elms/.test(hay)) {
      for (var j = 0; j < c.layouts.length; j++) {
        if (/grand|full|wec|elms/.test(c.layouts[j].name.toLowerCase())) return c.layouts[j].id;
      }
    }
    // Keep the current layout if it belongs to this circuit; else first.
    for (var k = 0; k < c.layouts.length; k++) {
      if (c.layouts[k].id === S.layoutId) return S.layoutId;
    }
    return c.layouts[0].id;
  }

  /** Player class id from the player's standings entry (matched by slotId). */
  function detectClass(frame) {
    var raw = null;
    var pid = frame.player ? frame.player.slotId : null;
    if (frame.standings && frame.standings.length && pid != null) {
      for (var i = 0; i < frame.standings.length; i++) {
        if (frame.standings[i].slotId === pid) {
          raw = frame.standings[i].carClass;
          break;
        }
      }
    }
    // Some providers may also stamp it on the player directly.
    if (!raw && frame.player && frame.player.carClass) raw = frame.player.carClass;
    if (!raw) return null;
    return CLASS_MAP[String(raw).toUpperCase()] || null;
  }

  /**
   * When AUTO is on, pull the track / layout / class from the live feed and set
   * the dropdowns to match. The specific car model is NOT in the telemetry, so
   * on a class change the first car in that class is selected as the fallback —
   * live measured burn/tank override it once a lap is on the board anyway.
   * Returns true if anything changed.
   */
  function autoDetectIdentity(frame) {
    if (!S.auto || !frame) return false;
    var changed = false;
    var session = frame.session || {};

    var cid = detectCircuit(session.track);
    if (cid && cid !== S.circuitId) {
      S.circuitId = cid;
      setSelectValue(els.circuit, cid);
      S.layoutId = layoutEntries(cid)[0][0];
      fillSelect(els.layout, layoutEntries(cid), S.layoutId);
      changed = true;
    }
    if (cid || RD.getCircuit(S.circuitId)) {
      var lid = detectLayout(S.circuitId, session.track, session.trackConfig);
      if (lid && lid !== S.layoutId) {
        S.layoutId = lid;
        setSelectValue(els.layout, lid);
        changed = true;
      }
    }

    var cls = detectClass(frame);
    if (cls && cls !== S.classId) {
      S.classId = cls;
      setSelectValue(els.klass, cls);
      var cars = carEntries(cls);
      S.carId = cars.length ? cars[0][0] : null;
      fillSelect(els.car, cars, S.carId);
      changed = true;
    }

    if (changed) saveState();
    return changed;
  }

  /* --------------------------------- plan --------------------------------- */

  /** Effective inputs = manual overrides, or live telemetry when AUTO is on. */
  function effective() {
    var raceMinutes = S.raceMinutes;
    var burn = S.customFuelPerLap;
    var tank = S.customTankCapacity;
    var lapTime = S.customLapTime;
    if (S.auto) {
      if (num(live.raceMin)) raceMinutes = live.raceMin;
      if (num(live.burn)) burn = live.burn;
      if (num(live.tank)) tank = live.tank;
      if (num(live.lapTime)) lapTime = live.lapTime;
    }
    return { raceMinutes: raceMinutes, burn: burn, tank: tank, lapTime: lapTime };
  }

  /**
   * Splits the race into stints of at most a full-tank's worth of laps, and
   * works out the fuel to add for each. `add` is the litres you put in for that
   * stint (its own burn, plus the safety margin on the final one), capped at the
   * tank. `startLoad` is what to load on the grid: the whole race for a no-stop
   * plan, else just the opening stint.
   */
  function strategyOf(plan) {
    var stints = [];
    var lps = plan.lapsPerStint > 0 ? plan.lapsPerStint : 1;
    var done = 0;
    var guard = 0;
    while (done < plan.totalLaps && guard < 60) {
      var laps = Math.min(lps, plan.totalLaps - done);
      stints.push({
        n: stints.length + 1,
        from: done + 1,
        to: done + laps,
        laps: laps,
        fuel: Math.ceil(laps * plan.fuelPerLap * 10) / 10,
      });
      done += laps;
      guard += 1;
    }
    if (stints.length === 0) {
      stints.push({ n: 1, from: 1, to: plan.totalLaps, laps: plan.totalLaps, fuel: plan.totalFuel });
    }
    var safety = plan.safetyFuel || 0;
    for (var i = 0; i < stints.length; i++) {
      var isLast = i === stints.length - 1;
      stints[i].add = Math.min(
        plan.fuelCapacity,
        Math.ceil((stints[i].fuel + (isLast ? safety : 0)) * 10) / 10,
      );
    }
    var startLoad = stints.length <= 1 ? plan.totalFuel : stints[0].add;
    return { stints: stints, startLoad: startLoad, stops: stints.length - 1 };
  }

  function recompute() {
    if (!mounted) return;
    var e = effective();
    var plan = RD.calculateFuel({
      circuitId: S.circuitId,
      layoutId: S.layoutId,
      classId: S.classId,
      carId: S.carId,
      raceMinutes: e.raceMinutes,
      customFuelPerLap: e.burn,
      customLapTime: e.lapTime,
      safetyLaps: S.safetyLaps,
      customTankCapacity: e.tank,
    });
    lastPlan = plan;

    if (!plan) {
      setText(els.load, "—");
      setText(els.stopsChip, "—");
      setText(els.heroSub, "Select track & car in SETUP");
      els.stintTable.textContent = "";
      cache.stintSig = "";
      lastStints = [];
      return;
    }

    var strat = strategyOf(plan);
    lastStints = strat.stints;

    setText(els.load, (Math.ceil(strat.startLoad * 10) / 10).toFixed(1) + " L");
    var stopsTxt = strat.stops === 0 ? "NO STOP" : strat.stops + (strat.stops > 1 ? " STOPS" : " STOP");
    setText(els.stopsChip, stopsTxt);
    els.stopsChip.setAttribute("data-stops", strat.stops === 0 ? "0" : "n");

    var sub =
      plan.totalLaps +
      " laps · " +
      plan.fuelPerLap.toFixed(2) +
      " L/lap · " +
      RD.formatLapTime(plan.lapTimeSec) +
      (S.auto ? " · AUTO" : " · MANUAL");
    setText(els.heroSub, sub);

    renderStintTable(strat);
  }

  /** Builds the per-stint rows, only when the plan's shape changes. */
  function renderStintTable(strat) {
    var sig = strat.stints
      .map(function (s) {
        return s.from + "-" + s.to + ":" + s.fuel;
      })
      .join("|");
    if (sig === cache.stintSig) return;
    cache.stintSig = sig;
    els.stintTable.textContent = "";
    els.stintRows = [];
    for (var i = 0; i < strat.stints.length; i++) {
      var s = strat.stints[i];
      var isLast = i === strat.stints.length - 1;
      var row = el("div", "fuelplan__stint-row");
      row.appendChild(el("span", "fuelplan__st-n", "S" + s.n));
      row.appendChild(el("span", "fuelplan__st-laps", "L" + s.from + "–" + s.to));
      row.appendChild(el("span", "fuelplan__st-cell", s.laps + "lp"));
      row.appendChild(el("span", "fuelplan__st-cell", s.fuel.toFixed(1) + "L"));
      var actText = isLast ? "FINISH" : "PIT +" + Math.round(strat.stints[i + 1].add) + "L";
      var act = el("span", "fuelplan__st-act", actText);
      if (isLast) act.setAttribute("data-fin", "true");
      row.appendChild(act);
      els.stintTable.appendChild(row);
      els.stintRows.push(row);
    }
  }

  /* ------------------------------ live update ----------------------------- */

  function captureLive(frame) {
    var f = frame.fuel || {};
    var session = frame.session || {};
    var player = frame.player || {};

    // Reference lap time: last completed → personal best → planner default.
    var lapRef = null;
    if (player.lap) {
      if (num(player.lap.last) && player.lap.last > 0) lapRef = player.lap.last;
      else if (num(player.lap.best) && player.lap.best > 0) lapRef = player.lap.best;
    }
    live.lapTime = lapRef;

    // Measured burn (rolling avg) once the calculator has enough laps.
    live.burn = num(f.perLapAvgLiters) && f.perLapAvgLiters > 0 ? f.perLapAvgLiters : null;
    // Tank capacity from shared memory.
    live.tank = num(f.capacityLiters) && f.capacityLiters > 0 ? f.capacityLiters : null;

    // Race length in minutes — ONLY from an actual race session. In a practice
    // or qualifying session the clock is that session's length, not the race
    // you're planning, so auto-filling it there gives nonsense (a 10-min
    // practice → a 10-min "race"). There the driver sets the race length by
    // hand; burn/tank/lap time still come live from the running. Lap-based race
    // → laps × pace (stable); timed race → remaining clock (≈ full at the grid).
    var isRace = String(session.type || "") === "race";
    var effLap = lapRef || S.customLapTime || RD.getDefaultLapTime(S.layoutId, S.classId) || 0;
    if (!isRace) {
      live.raceMin = null;
    } else if (num(session.totalLaps) && session.totalLaps > 0 && effLap > 0) {
      live.raceMin = Math.round((session.totalLaps * effLap) / 60);
    } else if (num(session.timeRemainingSec) && session.timeRemainingSec > 0) {
      live.raceMin = Math.round(session.timeRemainingSec / 60);
    } else {
      live.raceMin = null;
    }
    return lapRef;
  }

  /** In AUTO mode, mirror the live-derived values into the input fields. */
  function reflectAuto() {
    if (!S.auto) return;
    // Race length is display-only here — never written back into S.raceMinutes
    // (the manual value), so the driver's chosen race length survives when the
    // live clock isn't a race (see captureLive). Shows the live race length
    // during a race, otherwise the manual value.
    if (els.raceMin && document.activeElement !== els.raceMin) {
      els.raceMin.value = String(num(live.raceMin) ? live.raceMin : S.raceMinutes);
    }
    if (els.burn && document.activeElement !== els.burn) {
      els.burn.value = num(live.burn) ? live.burn.toFixed(2) : "";
      els.burn.placeholder = num(live.burn) ? "" : "auto";
    }
    if (els.tank && document.activeElement !== els.tank) {
      els.tank.value = num(live.tank) ? String(Math.round(live.tank)) : "";
      els.tank.placeholder = num(live.tank) ? "" : "auto";
    }
  }

  /** Set a stat cell's text + colour state (ok / marginal / short). */
  function setStatColored(node, text, state) {
    setText(node, text);
    var k = node.__ck + "_st";
    if (cache[k] === state) return;
    var first = cache[k] === undefined;
    cache[k] = state;
    if (!state) {
      node.removeAttribute("data-state");
      return;
    }
    node.setAttribute("data-state", state);
    // Falling from ok into marginal, or marginal into short, is the moment the
    // strategy stops working — a discrete step inside a number that drifts.
    if (!first && octx && octx.critPulse) octx.critPulse(node);
  }

  /**
   * The live strategy readout. Virtual energy is the binding constraint in LMU,
   * so it drives the numbers when present (fuel otherwise): remaining % + bar,
   * the predicted next pit lap (whichever of fuel/energy runs out first), the
   * refuel needed to reach the finish, the fuel-save target per lap to make the
   * flag, and the margin at the flag.
   */
  function renderLive(frame) {
    var f = frame.fuel;
    if (!f) return;

    // The same call, in the same words, as the fuel widget carries — see
    // ApexOverlay.alarmBar for why it is one implementation and not two.
    if (setAlarm) {
      setAlarm(
        f.pitThisLap === true,
        f.pitThisLapReason === "energy"
          ? "⛽ PIT THIS LAP FOR ENERGY"
          : "⛽ PIT THIS LAP FOR FUEL",
      );
    }

    var hasVE = num(f.virtualEnergyPct);

    // --- Energy row. Hidden (not drawn empty) on a car with no VE budget: an
    // empty bar reads as "energy exhausted", not "this car has none".
    if (els.veRow.hidden === hasVE) els.veRow.hidden = !hasVE;
    if (hasVE) {
      setText(els.veBig, f.virtualEnergyPct.toFixed(1) + "%");
      pulseOnStep(els.veBig, f.virtualEnergyPct);
      els.veFill.style.width = Math.max(0, Math.min(100, f.virtualEnergyPct)).toFixed(1) + "%";
    }

    // --- Fuel row: litres actually in the tank, bar as a fraction of the tank.
    // >= 0 rather than num() alone: the provider's UNKNOWN sentinel is -1, and a
    // genuinely dry tank is a real 0 that must still be shown.
    var lvl = num(f.levelLiters) && f.levelLiters >= 0 ? f.levelLiters : null;
    var cap = num(f.capacityLiters) && f.capacityLiters > 0 ? f.capacityLiters : null;
    setText(els.fuelLvlBig, lvl != null ? lvl.toFixed(1) + " L" : "—");
    pulseOnStep(els.fuelLvlBig, lvl);
    els.fuelLvlFill.style.width =
      (lvl != null && cap != null ? Math.max(0, Math.min(100, (lvl / cap) * 100)) : 0).toFixed(1) +
      "%";

    // Whichever budget binds the stint keeps the Tier 1 size; the other steps
    // down a tier. Both stay legible, but only one is the number being driven to.
    var primary = hasVE ? "energy" : "fuel";
    if (cache.livePrimary !== primary) {
      cache.livePrimary = primary;
      els.liveBox.setAttribute("data-primary", primary);
    }

    // Laps completed, backed out of the server's fuel pit-window figure
    // (pitWindowOpenLap = lapsCompleted + floor(fuel laps left)).
    var lapsDone =
      num(f.pitWindowOpenLap) && num(f.lapsRemaining)
        ? f.pitWindowOpenLap - Math.floor(f.lapsRemaining)
        : null;

    // Next pit = earliest lap either fuel or energy forces a stop.
    var pits = [];
    if (num(f.pitWindowOpenLap)) pits.push(f.pitWindowOpenLap);
    if (lapsDone != null && num(f.virtualEnergyLapsRemaining) && f.virtualEnergyLapsRemaining >= 0) {
      pits.push(lapsDone + Math.floor(f.virtualEnergyLapsRemaining));
    }
    var nextPit = pits.length ? Math.min.apply(null, pits) : null;
    setCritText(els.nextPit, nextPit != null ? "L" + Math.round(nextPit) : "—");

    // Refuel to reach the finish.
    setText(
      els.toFinish,
      num(f.refuelToFinishLiters)
        ? f.refuelToFinishLiters > 0
          ? "+" + f.refuelToFinishLiters.toFixed(1) + "L"
          : "0"
        : "—",
    );

    // Save target + margin, in the binding resource's units.
    var deltaFlag = hasVE ? f.virtualEnergyDeltaPct : f.fuelDeltaLiters;
    var perLap = hasVE ? f.virtualEnergyPerLapPct : f.perLapAvgLiters;
    var unit = hasVE ? "%" : "L";
    var lapsToFin = num(f.lapsToFinish) && f.lapsToFinish > 0 ? f.lapsToFinish : null;

    if (!num(deltaFlag)) {
      setStatColored(els.save, "—", "");
      setStatColored(els.margin, "—", "");
    } else {
      // Fuel-save target: shortfall spread over the laps still to run.
      if (deltaFlag >= 0) {
        setStatColored(els.save, "0 · OK", "ok");
      } else if (lapsToFin) {
        var perLapSave = Math.abs(deltaFlag) / lapsToFin;
        setStatColored(els.save, perLapSave.toFixed(2) + unit, "short");
      } else {
        setStatColored(els.save, "SAVE", "short");
      }
      var sign = deltaFlag >= 0 ? "+" : "−";
      var one = num(perLap) && perLap > 0 ? perLap : 1;
      var mState = deltaFlag < 0 ? "short" : deltaFlag < one ? "marginal" : "ok";
      setStatColored(els.margin, sign + Math.abs(deltaFlag).toFixed(1) + unit, mState);
    }

    highlightStint(lapsDone);
  }

  /** Marks the stint row the player is currently in, for at-a-glance tracking. */
  function highlightStint(lapsDone) {
    if (!els.stintRows || lapsDone == null) return;
    var cur = lapsDone + 1;
    for (var i = 0; i < els.stintRows.length; i++) {
      var s = lastStints[i];
      var on = !!(s && cur >= s.from && cur <= s.to);
      var row = els.stintRows[i];
      if ((row.getAttribute("data-current") === "true") !== on) {
        if (on) row.setAttribute("data-current", "true");
        else row.removeAttribute("data-current");
      }
    }
  }

  function renderRatio(frame) {
    var mfd = frame.mfd;
    var found = null;
    if (mfd && mfd.pit && mfd.pit.length) {
      for (var i = 0; i < mfd.pit.length; i++) {
        var n = String(mfd.pit[i].name || "").toUpperCase();
        if (/FUEL RATIO/.test(n)) {
          found = mfd.pit[i];
          break;
        }
      }
      if (!found) {
        for (var j = 0; j < mfd.pit.length; j++) {
          var m = String(mfd.pit[j].name || "").toUpperCase();
          if (/VIRTUAL ENERGY|ENERGY:/.test(m)) {
            found = mfd.pit[j];
            break;
          }
        }
      }
    }
    ratioRow = found;
    var enabled = !!found;
    if (els.ratioDec.disabled === enabled) els.ratioDec.disabled = !enabled;
    if (els.ratioInc.disabled === enabled) els.ratioInc.disabled = !enabled;
    var text = found ? found.currentText || "—" : "— (no MFD)";
    if (cache.ratioVal !== text && els.ratioVal.getAttribute("data-busy") !== "true") {
      cache.ratioVal = text;
      els.ratioVal.textContent = text;
    }
    // Header meta mirrors the ratio, short.
    if (els.meta) {
      var hdr = found && found.currentText ? found.currentText : "—";
      if (cache.meta !== hdr) {
        cache.meta = hdr;
        els.meta.textContent = hdr;
      }
    }
  }

  /* --------------------------------- init --------------------------------- */

  function init(root) {
    if (!RD) {
      var m = root.querySelector('[data-role="mount"]');
      if (m) m.innerHTML = '<div class="placeholder">racedata.js not loaded</div>';
      return;
    }
    loadState();
    var params = new URLSearchParams(window.location.search);
    if ((params.get("setup") || "").toLowerCase() === "open") S.setupOpen = true;

    els.meta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    buildBody(mount);
    recompute();
  }

  function update(frame, ctx) {
    if (!mounted || !frame) return;
    octx = ctx;
    captureLive(frame);
    autoDetectIdentity(frame);
    reflectAuto();
    if (S.auto) recompute();
    renderLive(frame);
    renderRatio(frame);
  }

  window.ApexOverlay.registerWidget("fuelplan", {
    throttleMs: 250,
    init: init,
    update: update,
  });
})();
