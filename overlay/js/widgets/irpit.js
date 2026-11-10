/**
 * widgets/irpit.js — iRacing's pit menu, read back and (optionally) set.
 * -----------------------------------------------------------------------------
 * Renders `frame.player.pitService` (src/telemetry/iracing/irPit.ts) in the
 * MFD widget's look: what is booked for the next stop (fuel, four tyres with
 * their cold pressures, tear-off, fast repair) and, during a stop, the crew's
 * live progress item by item plus the stop clock.
 *
 * ## Commands
 * The buttons post an INTENT to `/api/irpit/command` (server/irPitControl.ts),
 * which plans it against the menu as last read and sends iRacing's own pit
 * broadcast. They are live only while the "iRacing pit commands (beta)"
 * setting is on — `pitService.commandsEnabled`, stamped by the server; off,
 * the widget is a read-only mirror and says so. There is no acknowledgement
 * from iRacing: success is the value changing on the next frames, which is why
 * every value here glows on change (the MFD widget's convention).
 *
 * URL params: ?opacity=0.4 (the damage/mfd contract).
 */
(function () {
  "use strict";

  var PSI_PER_KPA = 0.1450377;
  /** One click of pressure: 1 psi, sent in whole kPa (the sim snaps to its own step). */
  var PRESSURE_STEP_KPA = 7;
  var CORNERS = [
    { id: "lf", label: "LF TYRE" },
    { id: "rf", label: "RF TYRE" },
    { id: "lr", label: "LR TYRE" },
    { id: "rr", label: "RR TYRE" },
  ];

  var octx = null;
  var headerMeta = null;
  var rows = {};
  var chipsEl = null;
  var statusEl = null;
  var noteEl = null;
  var wrapEl = null;
  var live = false;
  var cache = {};

  function setText(el, key, text) {
    if (!el || cache[key] === text) return;
    cache[key] = text;
    el.textContent = text;
  }

  function critText(el, key, text) {
    if (!el || cache[key] === text) return;
    var first = cache[key] === undefined;
    cache[key] = text;
    if (!first && octx && octx.crit) octx.crit(el, text);
    else el.textContent = text;
  }

  function post(intent, refs) {
    if (!live) return;
    if (refs && refs.value) refs.value.setAttribute("data-busy", "true");
    fetch("/api/irpit/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: intent }),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return { ok: false, error: "bad reply" };
        });
      })
      .then(function (res) {
        if (refs && refs.value) refs.value.removeAttribute("data-busy");
        if (!res || res.ok === false) flashError(refs, (res && res.error) || "not sent");
      })
      .catch(function () {
        if (refs && refs.value) refs.value.removeAttribute("data-busy");
        flashError(refs, "server not answering");
      });
  }

  function flashError(refs, message) {
    if (noteEl) {
      noteEl.textContent = message;
      noteEl.setAttribute("data-error", "true");
      cache.note = null;
    }
    if (!refs || !refs.root) return;
    refs.root.setAttribute("data-error", "true");
    setTimeout(function () {
      refs.root.removeAttribute("data-error");
    }, 1600);
  }

  /** A button that never starts an in-game-layer drag (see mfd.js stepButton). */
  function button(glyph, cls, onClick) {
    var b = document.createElement("button");
    b.className = "mfd__step" + (cls ? " " + cls : "");
    b.type = "button";
    b.textContent = glyph;
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      b.addEventListener(evt, function (e) {
        e.stopPropagation();
      });
    });
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  /** LABEL … VALUE [controls]. `controls(refs)` returns the buttons. */
  function makeRow(parent, id, label, cat, controls) {
    var row = document.createElement("div");
    row.className = "mfd__row";
    row.setAttribute("data-cat", cat);
    var l = document.createElement("span");
    l.className = "mfd__label";
    l.textContent = label;
    var v = document.createElement("span");
    v.className = "mfd__value is-crit";
    v.textContent = "—";
    row.appendChild(l);
    row.appendChild(v);
    var refs = { root: row, label: l, value: v, buttons: [] };
    if (controls) {
      var c = document.createElement("span");
      c.className = "mfd__ctrls";
      controls(refs).forEach(function (b) {
        c.appendChild(b);
        refs.buttons.push(b);
      });
      row.appendChild(c);
    }
    parent.appendChild(row);
    rows[id] = refs;
    return refs;
  }

  function group(parent, title) {
    var g = document.createElement("div");
    g.className = "mfd__group";
    var t = document.createElement("div");
    t.className = "mfd__group-title";
    t.textContent = title;
    var r = document.createElement("div");
    r.className = "mfd__rows";
    g.appendChild(t);
    g.appendChild(r);
    parent.appendChild(g);
    return r;
  }

  function buildOpacity(root, params) {
    var v = parseFloat(params.get("opacity"));
    if (isFinite(v)) root.style.opacity = String(Math.min(1, Math.max(0.15, v)));
  }

  function init(root, ctx) {
    octx = ctx;
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";
    rows = {};
    cache = {};
    buildOpacity(root, new URLSearchParams(window.location.search));

    wrapEl = document.createElement("div");
    wrapEl.className = "mfd__wrap irpit";

    var svc = group(wrapEl, "Pit service");
    makeRow(svc, "fuel", "FUEL", "fuel", function (refs) {
      return [
        button("−", "", function () {
          post({ kind: "fuelDelta", litres: -1 }, refs);
        }),
        button("+", "", function () {
          post({ kind: "fuelDelta", litres: 1 }, refs);
        }),
        button("✓", "irpit__toggle", function () {
          post({ kind: "fuelToggle" }, refs);
        }),
      ];
    });
    makeRow(svc, "finish", "FUEL TO FINISH", "fuel", function (refs) {
      return [
        button("SET", "irpit__wide", function () {
          post({ kind: "fuelToFinish" }, refs);
        }),
      ];
    });
    makeRow(svc, "tyres", "TYRES", "tyre", function (refs) {
      return [
        button("ALL", "irpit__wide", function () {
          post({ kind: "tyres", set: "all" }, refs);
        }),
        button("NONE", "irpit__wide", function () {
          post({ kind: "tyres", set: "none" }, refs);
        }),
      ];
    });
    CORNERS.forEach(function (c) {
      makeRow(svc, c.id, c.label, "pressure", function (refs) {
        return [
          button("−", "", function () {
            post({ kind: "pressure", corner: c.id, deltaKpa: -PRESSURE_STEP_KPA }, refs);
          }),
          button("+", "", function () {
            post({ kind: "pressure", corner: c.id, deltaKpa: PRESSURE_STEP_KPA }, refs);
          }),
          button("✓", "irpit__toggle", function () {
            post({ kind: "tyre", corner: c.id }, refs);
          }),
        ];
      });
    });
    makeRow(svc, "tearoff", "TEAR-OFF", "other", function (refs) {
      return [
        button("✓", "irpit__toggle", function () {
          post({ kind: "tearoff" }, refs);
        }),
      ];
    });
    makeRow(svc, "fastRepair", "FAST REPAIR", "brake", function (refs) {
      return [
        button("✓", "irpit__toggle", function () {
          post({ kind: "fastRepair" }, refs);
        }),
      ];
    });
    makeRow(svc, "clear", "CLEAR ALL", "service", function (refs) {
      return [
        button("CLEAR", "irpit__wide", function () {
          post({ kind: "clear" }, refs);
        }),
      ];
    });

    var stop = group(wrapEl, "This stop");
    statusEl = document.createElement("div");
    statusEl.className = "irpit__status";
    stop.appendChild(statusEl);
    chipsEl = document.createElement("div");
    chipsEl.className = "damage__svc";
    stop.appendChild(chipsEl);

    noteEl = document.createElement("div");
    noteEl.className = "mfd__penalty-note irpit__note";
    wrapEl.appendChild(noteEl);

    mount.appendChild(wrapEl);
  }

  function item(s, id) {
    for (var i = 0; i < s.items.length; i++) if (s.items[i].id === id) return s.items[i];
    return null;
  }

  function kpa(v) {
    return typeof v === "number" && v > 0 ? v : -1;
  }

  function setLive(on) {
    if (cache.live === on) return;
    cache.live = on;
    live = on;
    Object.keys(rows).forEach(function (k) {
      rows[k].buttons.forEach(function (b) {
        b.disabled = !on;
      });
    });
    if (wrapEl) wrapEl.setAttribute("data-live", on ? "true" : "false");
  }

  function update(frame) {
    var p = frame.player || {};
    var s = p.pitService;
    var r = p.repair;
    if (!s) {
      setLive(false);
      setText(headerMeta, "meta", "NOT IN CAR");
      setText(statusEl, "status", "Waiting for iRacing — get in the car.");
      return;
    }
    setLive(s.commandsEnabled === true);

    // A stop in progress shows the crew's progress (requested = still to do);
    // otherwise these rows are the booked menu.
    var inStop = s.active || s.status === "complete";
    var fuel = item(s, "fuel");
    var fuelOn = fuel && fuel.state !== "off";
    critText(
      rows.fuel.value,
      "fuel",
      s.autoFuel ? "AUTO" : fuelOn ? (s.fuelAddL >= 0 ? "+" + Math.round(s.fuelAddL) + " L" : "FILL") : "NO FUEL",
    );
    rows.fuel.root.setAttribute("data-on", fuelOn || s.autoFuel ? "true" : "false");
    var need = frame.fuel && frame.fuel.refuelToFinishLiters;
    critText(rows.finish.value, "finish", typeof need === "number" && need >= 0 ? Math.ceil(need) + " L" : "—");

    var on = 0;
    CORNERS.forEach(function (c, i) {
      var it = item(s, c.id);
      var state = it ? it.state : "off";
      if (state !== "off") on++;
      var pk = kpa(s.pressuresKpa && s.pressuresKpa[i]);
      var press = pk > 0 ? Math.round(pk) + " kPa · " + (pk * PSI_PER_KPA).toFixed(1) : "—";
      var word = state === "done" ? "✓ DONE" : state === "requested" ? (inStop ? "ON IT" : "CHANGE") : "KEEP";
      critText(rows[c.id].value, c.id, word + "  " + press);
      rows[c.id].root.setAttribute("data-on", state === "off" ? "false" : "true");
      rows[c.id].root.setAttribute("data-svc", state);
    });
    critText(rows.tyres.value, "tyres", on === 4 ? "ALL FOUR" : on === 0 ? "NONE" : on + " CORNERS");

    var to = item(s, "tearoff");
    critText(rows.tearoff.value, "tearoff", !to || to.state === "off" ? "NO" : to.state === "done" ? "✓ DONE" : "YES");
    rows.tearoff.root.setAttribute("data-on", to && to.state !== "off" ? "true" : "false");
    var fr = item(s, "fastRepair");
    var left =
      r && r.fastRepairsUnlimited
        ? " (∞)"
        : r && typeof r.fastRepairsLeft === "number" && r.fastRepairsLeft >= 0
          ? " (" + r.fastRepairsLeft + " left)"
          : "";
    critText(
      rows.fastRepair.value,
      "fr",
      (!fr || fr.state === "off" ? "NO" : fr.state === "done" ? "✓ DONE" : "YES") + left,
    );
    rows.fastRepair.root.setAttribute("data-on", fr && fr.state !== "off" ? "true" : "false");
    critText(rows.clear.value, "clear", "");

    /* ---- this stop ---- */
    var sig = s.items
      .map(function (it) {
        return it.id + ":" + it.state;
      })
      .join("|");
    if (cache.chips !== sig) {
      cache.chips = sig;
      chipsEl.textContent = "";
      s.items.forEach(function (it) {
        var chip = document.createElement("span");
        chip.className = "damage__svc-chip";
        chip.setAttribute("data-state", it.state);
        chip.textContent = it.id === "fastRepair" ? "FR" : it.label;
        chipsEl.appendChild(chip);
      });
    }
    var STATUS = {
      tooFarLeft: "TOO FAR LEFT",
      tooFarRight: "TOO FAR RIGHT",
      tooFarForward: "TOO FAR FORWARD",
      tooFarBack: "TOO FAR BACK",
      badAngle: "BAD ANGLE",
      cantFixThat: "CAN'T FIX THAT",
    };
    var status;
    var meta;
    if (r && r.towSec > 0) {
      status = "Towing to the pits — " + Math.ceil(r.towSec) + " s";
      meta = "TOW " + Math.ceil(r.towSec) + "s";
    } else if (STATUS[s.status]) {
      status = "Crew can't start: " + STATUS[s.status];
      meta = STATUS[s.status];
    } else if (s.active) {
      status = "Crew working — " + (s.elapsedSec >= 0 ? s.elapsedSec.toFixed(1) : "0") + " s";
      meta = "BOX " + (s.elapsedSec >= 0 ? Math.floor(s.elapsedSec) : 0) + "s";
    } else if (s.status === "complete") {
      status = "Stop complete" + (s.lastStopSec >= 0 ? " — " + s.lastStopSec.toFixed(1) + " s" : "") + ". Go!";
      meta = "RELEASED";
    } else {
      status = s.lastStopSec >= 0 ? "Last stop " + s.lastStopSec.toFixed(1) + " s" : "No stop yet this session";
      meta = s.items.some(function (it) {
        return it.state === "requested";
      })
        ? "BOOKED"
        : "NOTHING BOOKED";
    }
    setText(statusEl, "status", status);
    setText(headerMeta, "meta", meta);
    wrapEl.setAttribute("data-stop", s.active ? "active" : s.status === "complete" ? "done" : "idle");

    var note = live
      ? "Commands go straight to iRacing's pit menu. Check the black box."
      : "Read-only. Settings → iRacing pit commands (beta) to set the stop from here.";
    if (cache.note !== note && noteEl.getAttribute("data-error") !== "true") {
      cache.note = note;
      noteEl.textContent = note;
    }
    if (noteEl.getAttribute("data-error") === "true" && !cache.errTimer) {
      cache.errTimer = setTimeout(function () {
        noteEl.removeAttribute("data-error");
        cache.errTimer = null;
        cache.note = null;
      }, 3000);
    }
  }

  window.ApexOverlay.registerWidget("irpit", {
    throttleMs: 150,
    init: init,
    update: update,
  });
})();
