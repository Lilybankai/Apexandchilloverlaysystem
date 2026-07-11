/**
 * widgets/tyres.js — four-corner tyre temperatures (bottom-right).
 * -----------------------------------------------------------------------------
 * Renders `frame.player.tyres` (TyreSet). Each corner shows its representative
 * temperature (°C) with a colour band signalling thermal state (cold → optimal
 * → warm → hot). Corner cells are created once and updated in place.
 */
(function () {
  "use strict";

  // Corner order matches a car seen from above: FL FR / RL RR.
  var CORNERS = [
    { key: "frontLeft", label: "FL" },
    { key: "frontRight", label: "FR" },
    { key: "rearLeft", label: "RL" },
    { key: "rearRight", label: "RR" },
  ];

  // Thermal buckets (°C) — reasonable slick window; colour only, not advice.
  function heatBucket(t) {
    if (typeof t !== "number" || t < 0) return "optimal";
    if (t < 70) return "cold";
    if (t <= 95) return "optimal";
    if (t <= 110) return "warm";
    return "hot";
  }

  var header, cells = {};
  var cache = {};

  function init(root) {
    header = root.querySelector('[data-role="compound"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var grid = document.createElement("div");
    grid.className = "tyres__grid";

    CORNERS.forEach(function (c) {
      var cell = document.createElement("div");
      cell.className = "tyre";
      cell.setAttribute("data-heat", "optimal");

      var pos = document.createElement("div");
      pos.className = "tyre__pos";
      pos.textContent = c.label;

      var temp = document.createElement("div");
      temp.className = "tyre__temp";
      temp.textContent = "—";

      var band = document.createElement("div");
      band.className = "tyre__band";

      cell.appendChild(pos);
      cell.appendChild(temp);
      cell.appendChild(band);
      grid.appendChild(cell);

      cells[c.key] = { cell: cell, temp: temp };
    });

    mount.appendChild(grid);
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var tyres = frame.player ? frame.player.tyres : null;
    if (!tyres) return;

    var compound = null;
    for (var i = 0; i < CORNERS.length; i++) {
      var c = CORNERS[i];
      var t = tyres[c.key];
      var ref = cells[c.key];
      if (!t || !ref) continue;

      var tempStr = fmt.tempC(t.tempC);
      if (ref.cache !== tempStr) {
        ref.cache = tempStr;
        ref.temp.textContent = tempStr;
      }
      var heat = heatBucket(t.tempC);
      if (ref.heat !== heat) {
        ref.heat = heat;
        ref.cell.setAttribute("data-heat", heat);
      }
      if (!compound && t.compound) compound = t.compound;
    }

    if (header) {
      var comp = compound || "—";
      if (cache.compound !== comp) {
        cache.compound = comp;
        header.textContent = comp.toUpperCase();
      }
    }
  }

  window.ApexOverlay.registerWidget("tyres", {
    throttleMs: 200,
    init: init,
    update: update,
  });
})();
