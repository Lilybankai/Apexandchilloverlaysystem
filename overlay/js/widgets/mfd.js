/**
 * widgets/mfd.js — a read-only readout of the in-game MFD (pit menu + driving
 * aids) for the player's car.
 * -----------------------------------------------------------------------------
 * Renders `frame.mfd` (see src/telemetry/types.ts MfdState): two clearly headed
 * sections, PIT STRATEGY and DRIVING AIDS, with each row colour-coded by
 * category (tyres, pressures, ducts, aero, fuel…) so related lines read as a
 * group at a glance. Display only — no controls: it mirrors what the driver has
 * set in-game.
 *
 * URL params:
 *   ?pit=off      hide the pit-strategy section.  Default on.
 *   ?aids=off     hide the driving-aids section.  Default on.
 *   ?opacity=0.4  panel opacity (same contract as the damage/motion widgets).
 */
(function () {
  "use strict";

  var OPACITY_KEY = "apex-mfd-opacity";
  var MIN_OPACITY = 0.15;

  var headerMeta = null;
  var mountEl = null;
  var wrapEl = null;
  var showPit = true;
  var showAids = true;
  var disabled = false;

  // Per-group row registries, keyed by stable id, plus a signature of the id +
  // category list so the DOM is only rebuilt when the set of rows changes.
  var pit = { container: null, rowsEl: null, rows: {}, sig: "" };
  var aids = { container: null, rowsEl: null, rows: {}, sig: "" };

  /* ----------------------------- categorisation --------------------------- */

  /** Category (→ colour) for a pit-menu row, from its label. Order matters:
   *  "F BRAKE DUCT" must match DUCT before BRAKE. */
  function pitCategory(name) {
    var n = String(name || "").toUpperCase();
    if (/PRESS/.test(n)) return "pressure";
    if (/DUCT/.test(n)) return "duct";
    if (/TIRE|TYRE/.test(n)) return "tyre";
    if (/WING|GRILLE|SPLITTER|RIDE|AERO/.test(n)) return "aero";
    if (/FUEL|ENERGY/.test(n)) return "fuel";
    if (/BRAKE/.test(n)) return "brake";
    if (/DAMAGE|DRIVER/.test(n)) return "service";
    return "other";
  }

  /** Category (→ colour) for a driving aid, from its VM_ key. */
  function aidCategory(key) {
    var k = String(key || "").toUpperCase();
    if (/BRAKE/.test(k)) return "brake";
    if (/ANTILOCK|TRACTION/.test(k)) return "traction";
    if (/REGEN|ELECTRIC|MOTOR/.test(k)) return "hybrid";
    if (/ENGINE/.test(k)) return "engine";
    return "other";
  }

  /* ------------------------------- rendering ------------------------------ */

  /** One read-only row: LABEL … VALUE. */
  function makeRow() {
    var row = document.createElement("div");
    row.className = "mfd__row";
    var label = document.createElement("span");
    label.className = "mfd__label";
    var value = document.createElement("span");
    value.className = "mfd__value";
    row.appendChild(label);
    row.appendChild(value);
    return { root: row, label: label, value: value };
  }

  /**
   * (Re)builds a group's rows when the id/category set changes; else just
   * refreshes the label/value text in place. `catOf` also drives the colour
   * (data-cat) and a small gap at each category change (group-start).
   */
  function reconcile(group, items, idOf, catOf, labelOf, textOf) {
    var sig = items
      .map(function (it) {
        return idOf(it) + ":" + catOf(it);
      })
      .join("|");
    if (sig !== group.sig) {
      group.sig = sig;
      group.rows = {};
      group.rowsEl.textContent = "";
      var prevCat = null;
      items.forEach(function (it) {
        var refs = makeRow();
        var cat = catOf(it);
        refs.root.setAttribute("data-cat", cat);
        if (cat !== prevCat) {
          refs.root.classList.add("mfd__row--group-start");
          prevCat = cat;
        }
        group.rows[idOf(it)] = refs;
        group.rowsEl.appendChild(refs.root);
      });
    }
    items.forEach(function (it) {
      var refs = group.rows[idOf(it)];
      if (!refs) return;
      setText(refs.label, labelOf(it));
      setText(refs.value, textOf(it));
    });
  }

  function renderPit(rows) {
    if (!pit.container) return;
    if (!rows || rows.length === 0) {
      markEmpty(pit);
      return;
    }
    pit.container.removeAttribute("data-empty");
    reconcile(
      pit,
      rows,
      function (r) {
        return "p" + r.pmcValue + ":" + r.name;
      },
      function (r) {
        return pitCategory(r.name);
      },
      function (r) {
        return prettyPit(r.name);
      },
      function (r) {
        return r.currentText || "—";
      },
    );
  }

  function renderAids(list) {
    if (!aids.container) return;
    if (!list || list.length === 0) {
      markEmpty(aids);
      return;
    }
    aids.container.removeAttribute("data-empty");
    reconcile(
      aids,
      list,
      function (a) {
        return a.key;
      },
      function (a) {
        return aidCategory(a.key);
      },
      function (a) {
        return a.label;
      },
      function (a) {
        return a.text || String(a.value);
      },
    );
  }

  /** Applies a full MfdState to the DOM (from a telemetry frame). */
  function renderState(state) {
    if (!mountEl) return;
    if (!state) {
      showNoData();
      return;
    }
    if (!wrapEl || mountEl.getAttribute("data-nodata") === "true") buildBody();
    if (showPit) renderPit(state.pit || []);
    if (showAids) renderAids(state.aids || []);
    if (headerMeta) headerMeta.textContent = "LIVE";
  }

  function markEmpty(group) {
    group.container.setAttribute("data-empty", "true");
    group.sig = "";
    group.rowsEl.textContent = "";
  }

  function showNoData() {
    if (headerMeta) headerMeta.textContent = "—";
    if (!mountEl || mountEl.getAttribute("data-nodata") === "true") return;
    mountEl.setAttribute("data-nodata", "true");
    mountEl.textContent = "";
    wrapEl = null;
    var ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = "No MFD data — join a session in LMU";
    mountEl.appendChild(ph);
  }

  /* --------------------------------- helpers ------------------------------ */

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  /** Tidy the sim's raw labels a touch: drop the trailing colon. */
  function prettyPit(name) {
    return String(name || "").replace(/:\s*$/, "");
  }

  /* ------------------------------- structure ------------------------------ */

  function makeGroup(title, group) {
    var box = document.createElement("div");
    box.className = "mfd__group";

    var head = document.createElement("div");
    head.className = "mfd__group-title";
    head.textContent = title;

    var rows = document.createElement("div");
    rows.className = "mfd__rows";

    var empty = document.createElement("div");
    empty.className = "mfd__empty";
    empty.textContent = "—";

    box.appendChild(head);
    box.appendChild(rows);
    box.appendChild(empty);

    group.container = box;
    group.rowsEl = rows;
    group.rows = {};
    group.sig = "";
    return box;
  }

  function buildBody() {
    mountEl.removeAttribute("data-nodata");
    mountEl.textContent = "";
    wrapEl = document.createElement("div");
    wrapEl.className = "mfd__wrap";
    if (showPit) wrapEl.appendChild(makeGroup("PIT STRATEGY", pit));
    if (showAids) wrapEl.appendChild(makeGroup("DRIVING AIDS", aids));
    mountEl.appendChild(wrapEl);
  }

  /* --- opacity control — identical contract to widgets/damage.js ----------- */
  function buildOpacityControl(root, params) {
    var apply = function (v) {
      root.style.setProperty("--mfd-op", String(v));
      root.setAttribute("data-transparent", v < 1 ? "true" : "false");
    };
    var stored = null;
    try {
      var raw = localStorage.getItem(OPACITY_KEY);
      if (raw !== null && isFinite(parseFloat(raw))) stored = parseFloat(raw);
    } catch (e) {
      /* private mode — slider still works, just won't persist */
    }
    var fromUrl = parseFloat(params.get("opacity"));
    var initial = isFinite(fromUrl) ? fromUrl : stored !== null ? stored : 1;
    initial = Math.min(1, Math.max(MIN_OPACITY, initial));

    var bar = document.createElement("div");
    bar.className = "mfd__opacity";
    var label = document.createElement("span");
    label.className = "mfd__opacity-label";
    label.textContent = "OPACITY";
    var slider = document.createElement("input");
    slider.className = "mfd__opacity-range";
    slider.type = "range";
    slider.min = String(Math.round(MIN_OPACITY * 100));
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(initial * 100));
    var readout = document.createElement("span");
    readout.className = "mfd__opacity-val";
    readout.textContent = slider.value + "%";

    slider.addEventListener("input", function () {
      var v = Math.min(1, Math.max(MIN_OPACITY, Number(slider.value) / 100));
      apply(v);
      readout.textContent = Math.round(v * 100) + "%";
      try {
        localStorage.setItem(OPACITY_KEY, String(v));
      } catch (e) {
        /* ignore */
      }
    });
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      bar.addEventListener(evt, function (e) {
        e.stopPropagation();
      });
    });

    bar.appendChild(label);
    bar.appendChild(slider);
    bar.appendChild(readout);
    var anchor = document.createElement("div");
    anchor.className = "mfd__opacity-anchor";
    anchor.appendChild(bar);
    root.appendChild(anchor);
    apply(initial);
  }

  /* --------------------------------- init --------------------------------- */

  function init(root, ctx) {
    headerMeta = root.querySelector('[data-role="meta"]');
    mountEl = root.querySelector('[data-role="mount"]');

    var params = new URLSearchParams(window.location.search);
    var isOff = function (name) {
      var v = (params.get(name) || "").toLowerCase();
      return v === "off" || v === "0" || v === "false";
    };
    showPit = !isOff("pit");
    showAids = !isOff("aids");

    buildOpacityControl(root, params);

    if (!showPit && !showAids) {
      disabled = true;
      mountEl.textContent = "";
      var ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = "Both MFD sections are off (?pit / ?aids)";
      mountEl.appendChild(ph);
      return;
    }
    showNoData();
  }

  function update(frame, ctx) {
    if (disabled) return;
    renderState(frame && frame.mfd ? frame.mfd : null);
  }

  window.ApexOverlay.registerWidget("mfd", {
    // The MFD changes on driver input, not per frame; a gentle cadence is plenty.
    throttleMs: 250,
    init: init,
    update: update,
  });
})();
