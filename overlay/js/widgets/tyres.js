/**
 * widgets/tyres.js — four-corner tyre temps + wear (bottom-right).
 * -----------------------------------------------------------------------------
 * Renders `frame.player.tyres` (TyreSet). For the locally-driven car the sim
 * supplies two live per-corner temperatures from shared memory: the **inner-
 * liner** temp — the number the in-game HUD shows — and the **surface**
 * (contact-patch) temp. The inner-liner is the primary readout (°C); the surface
 * shows on the sub-line as `surf NN°`. When no temperature is available
 * (spectating, or the car isn't running on track) the corner falls back to
 * remaining tread % as the primary readout. The colour band always reflects
 * remaining tread. Corner cells are created once, updated in place.
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

      // Primary readout: live temperature (falls back to tread % — see update).
      var primary = document.createElement("div");
      primary.className = "tyre__wear";
      primary.textContent = "—";

      // Sub-line: remaining tread %, or a label when temp isn't the primary.
      var sub = document.createElement("div");
      sub.className = "tyre__temp";
      sub.textContent = "TREAD";

      var band = document.createElement("div");
      band.className = "tyre__band";

      cell.appendChild(pos);
      cell.appendChild(primary);
      cell.appendChild(sub);
      cell.appendChild(band);
      grid.appendChild(cell);

      cells[c.key] = { cell: cell, primary: primary, sub: sub };
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

      var hasCore = fmt.has(t.tempC); // core temp — matches the in-game HUD
      var hasSurf = fmt.has(t.surfaceTempC); // surface (contact-patch) temp
      var hasWear = fmt.has(t.wear);
      var wearStr = hasWear ? Math.round(t.wear * 100) + "%" : "—";

      // Primary: core temp (matches the game) → surface temp → tread %.
      // Sub-line: the surface temp when core is primary, else tread %.
      var primaryStr, subStr;
      if (hasCore) {
        primaryStr = fmt.tempC1(t.tempC);
        subStr = hasSurf ? "surf " + fmt.tempC1(t.surfaceTempC) : wearStr;
      } else if (hasSurf) {
        primaryStr = fmt.tempC1(t.surfaceTempC);
        subStr = wearStr;
      } else {
        primaryStr = wearStr;
        subStr = "TREAD";
      }

      if (ref.primaryCache !== primaryStr) {
        ref.primaryCache = primaryStr;
        ref.primary.textContent = primaryStr;
      }
      if (ref.subCache !== subStr) {
        ref.subCache = subStr;
        ref.sub.textContent = subStr;
      }

      // Colour band always reflects remaining tread — meaningful either way.
      var bucket = wearBucket(hasWear ? t.wear : -1);
      if (ref.bucket !== bucket) {
        ref.bucket = bucket;
        ref.cell.setAttribute("data-wear", bucket);
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
