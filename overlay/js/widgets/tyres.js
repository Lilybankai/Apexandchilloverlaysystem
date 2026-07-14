/**
 * widgets/tyres.js — four-corner tyre wear (bottom-right).
 * -----------------------------------------------------------------------------
 * Renders `frame.player.tyres` (TyreSet). LMU exposes per-corner remaining
 * tread (wear) but publishes no tyre temperatures anywhere, so wear is the
 * primary readout: each corner shows its remaining tread % with a colour band
 * (fresh → worn → low). Temperature is shown as a small sub-line only when a
 * provider actually supplies it. Corner cells are created once, updated in
 * place.
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

  // Wear buckets (remaining tread fraction 1..0) — colour only, not advice.
  function wearBucket(w) {
    if (typeof w !== "number" || w < 0) return "unknown";
    if (w > 0.4) return "good";
    if (w > 0.15) return "low";
    return "crit";
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
      cell.setAttribute("data-wear", "unknown");

      var pos = document.createElement("div");
      pos.className = "tyre__pos";
      pos.textContent = c.label;

      // Primary readout: remaining tread %.
      var wear = document.createElement("div");
      wear.className = "tyre__wear";
      wear.textContent = "—";

      // Sub-line: temperature when a provider supplies it, else a label.
      var temp = document.createElement("div");
      temp.className = "tyre__temp";
      temp.textContent = "TREAD";

      var band = document.createElement("div");
      band.className = "tyre__band";

      cell.appendChild(pos);
      cell.appendChild(wear);
      cell.appendChild(temp);
      cell.appendChild(band);
      grid.appendChild(cell);

      cells[c.key] = { cell: cell, temp: temp, wear: wear };
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

      // Primary: remaining tread %.
      var wearStr = fmt.has(t.wear) ? Math.round(t.wear * 100) + "%" : "—";
      if (ref.wearCache !== wearStr) {
        ref.wearCache = wearStr;
        ref.wear.textContent = wearStr;
      }
      var bucket = wearBucket(fmt.has(t.wear) ? t.wear : -1);
      if (ref.bucket !== bucket) {
        ref.bucket = bucket;
        ref.cell.setAttribute("data-wear", bucket);
      }

      // Sub-line: real temperature if a provider carries it, else a static
      // label so the corner never reads as an empty/broken cell.
      var tempStr = fmt.has(t.tempC) ? fmt.tempC(t.tempC) : "TREAD";
      if (ref.cache !== tempStr) {
        ref.cache = tempStr;
        ref.temp.textContent = tempStr;
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
