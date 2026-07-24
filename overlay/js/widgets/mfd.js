/**
 * widgets/mfd.js — control the in-game MFD (pit menu + live driving aids).
 * -----------------------------------------------------------------------------
 * Renders `frame.mfd` (see src/telemetry/types.ts MfdState) and, unlike every
 * other widget here, WRITES back: each ◀ ▶ / − + button POSTs an intent to the
 * server's control plane, which sets the value on LMU over its REST API. No
 * keystrokes, no game focus needed — see src/telemetry/mfdControl.ts.
 *
 *   POST /api/mfd/pit  { pmcValue|name, delta }   — cycle a pit-menu row
 *   POST /api/mfd/aid  { key, delta }             — step a driving aid
 *   GET  /api/mfd/state                           — fresh read-back after a write
 *
 * Because a change only re-appears in the telemetry frame on the next garage
 * poll (~3 s), each command is followed by an immediate GET so the readout
 * confirms in a round-trip instead of lagging.
 *
 * Sections, switchable from the Browser Source URL:
 *   ?pit=on|off    PIT STRATEGY — fuel, tyres, wing, repairs… Default ON.
 *   ?aids=on|off   DRIVING AIDS — brake bias, ABS/TC map, engine maps. Default ON.
 *   ?readonly=on   Hide the buttons — a pure display (e.g. a locked OBS source).
 *   ?opacity=0.4   Panel opacity (same contract as the damage/motion widgets).
 *
 * NOTE an OBS Browser Source is not clickable, so to DRIVE the MFD open this page
 * in a normal browser tab on the sim PC (or a LAN device pointed at the server).
 * As an OBS source it still works as a live readout.
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
  var readonly = false;
  var disabled = false;

  // After a local write the widget's own read-back (GET /api/mfd/state) has the
  // fresh value, but the telemetry frame keeps carrying the previous one until
  // the provider's next garage poll (~3 s). Applying that older frame would flip
  // the readout back for a beat, so frame updates are ignored during this window
  // and the read-backs drive the display instead; it re-extends on every click.
  var FRAME_SUPPRESS_MS = 4000;
  var suppressFramesUntil = 0;

  // Per-group row registries, keyed by stable id (pmcValue/name for pit, VM_ key
  // for aids), plus a signature of the current id list so we only rebuild the
  // DOM when the SET of rows changes — not on every value tick.
  var pit = { container: null, rowsEl: null, rows: {}, sig: "" };
  var aids = { container: null, rowsEl: null, rows: {}, sig: "" };

  // Commands are serialized: each POST does a read-modify-write on the server, so
  // firing two concurrently would let both read the same value and collapse a
  // double-tap into a single step. Chaining keeps them ordered.
  var commandChain = Promise.resolve();

  /* ------------------------------ command I/O ----------------------------- */

  function postCommand(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: r.ok, status: r.status };
      });
    });
  }

  function refreshState() {
    return fetch("/api/mfd/state")
      .then(function (r) {
        return r.json();
      })
      .then(function (res) {
        if (res && res.ok && res.mfd) renderState(res.mfd);
      })
      .catch(function () {
        /* transient — the next telemetry frame will resync */
      });
  }

  /** Queue a command, then immediately read the state back to confirm it. */
  function sendCommand(path, body, rowEl) {
    if (readonly) return;
    suppressFramesUntil = Date.now() + FRAME_SUPPRESS_MS;
    if (rowEl) rowEl.setAttribute("data-pending", "true");
    commandChain = commandChain
      .then(function () {
        return postCommand(path, body);
      })
      .then(function (res) {
        if (rowEl) {
          rowEl.removeAttribute("data-pending");
          if (!res || !res.ok) flashError(rowEl);
        }
        return refreshState();
      })
      .catch(function () {
        if (rowEl) {
          rowEl.removeAttribute("data-pending");
          flashError(rowEl);
        }
      });
  }

  function flashError(rowEl) {
    rowEl.setAttribute("data-error", "true");
    window.setTimeout(function () {
      rowEl.removeAttribute("data-error");
    }, 900);
  }

  /* ------------------------------- rendering ------------------------------ */

  /** Builds one control row: LABEL  [◀] value [▶]. Returns element refs. */
  function makeRow(decLabel, incLabel) {
    var row = document.createElement("div");
    row.className = "mfd__row";

    var label = document.createElement("span");
    label.className = "mfd__label";

    var ctl = document.createElement("div");
    ctl.className = "mfd__ctl";
    // A drag on a control must not be read as a widget drag by the in-game layer.
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      ctl.addEventListener(evt, function (e) {
        e.stopPropagation();
      });
    });

    var dec = document.createElement("button");
    dec.type = "button";
    dec.className = "mfd__btn";
    dec.textContent = decLabel;

    var value = document.createElement("span");
    value.className = "mfd__value";

    var inc = document.createElement("button");
    inc.type = "button";
    inc.className = "mfd__btn";
    inc.textContent = incLabel;

    ctl.appendChild(dec);
    ctl.appendChild(value);
    ctl.appendChild(inc);
    row.appendChild(label);
    row.appendChild(ctl);

    if (readonly) {
      dec.style.display = "none";
      inc.style.display = "none";
    }
    return { root: row, label: label, value: value, dec: dec, inc: inc };
  }

  /** (Re)builds a group's rows when the id set changes; else updates in place. */
  function reconcile(group, items, idOf, wireRow, updateRow) {
    var sig = items
      .map(function (it) {
        return idOf(it);
      })
      .join("|");
    if (sig !== group.sig) {
      group.sig = sig;
      group.rows = {};
      group.rowsEl.textContent = "";
      items.forEach(function (it) {
        var id = idOf(it);
        var refs = wireRow(it);
        group.rows[id] = refs;
        group.rowsEl.appendChild(refs.root);
      });
    }
    items.forEach(function (it) {
      var refs = group.rows[idOf(it)];
      if (refs) updateRow(refs, it);
    });
  }

  function renderPit(rows) {
    if (!pit.container) return;
    if (!rows || rows.length === 0) {
      pit.container.setAttribute("data-empty", "true");
      pit.sig = "";
      pit.rowsEl.textContent = "";
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
        var refs = makeRow("◀", "▶");
        // Address the row by the sim's stable id when it has one, else by name.
        var target =
          typeof r.pmcValue === "number" && r.pmcValue >= 0
            ? { pmcValue: r.pmcValue }
            : { name: r.name };
        refs.dec.addEventListener("click", function () {
          sendCommand("/api/mfd/pit", merge(target, { delta: -1 }), refs.root);
        });
        refs.inc.addEventListener("click", function () {
          sendCommand("/api/mfd/pit", merge(target, { delta: 1 }), refs.root);
        });
        return refs;
      },
      function (refs, r) {
        setText(refs.label, prettyPit(r.name));
        setText(refs.value, r.currentText || "—");
        setDisabled(refs.dec, r.currentSetting <= 0);
        setDisabled(refs.inc, r.settingCount > 0 && r.currentSetting >= r.settingCount - 1);
      },
    );
  }

  function renderAids(list) {
    if (!aids.container) return;
    if (!list || list.length === 0) {
      aids.container.setAttribute("data-empty", "true");
      aids.sig = "";
      aids.rowsEl.textContent = "";
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
        var refs = makeRow("−", "+");
        refs.dec.addEventListener("click", function () {
          sendCommand("/api/mfd/aid", { key: a.key, delta: -1 }, refs.root);
        });
        refs.inc.addEventListener("click", function () {
          sendCommand("/api/mfd/aid", { key: a.key, delta: 1 }, refs.root);
        });
        return refs;
      },
      function (refs, a) {
        setText(refs.label, a.label);
        setText(refs.value, a.text || String(a.value));
        setDisabled(refs.dec, a.value <= a.minValue);
        setDisabled(refs.inc, a.value >= a.maxValue);
      },
    );
  }

  /** Applies a full MfdState to the DOM (from a frame or a post-command GET). */
  function renderState(state) {
    if (!mountEl) return;
    if (!state) {
      showNoData();
      return;
    }
    // Build the body on the first populated state (or after a no-data spell,
    // when showNoData() tore it down and cleared wrapEl).
    if (!wrapEl || mountEl.getAttribute("data-nodata") === "true") buildBody();
    if (showPit) renderPit(state.pit || []);
    if (showAids) renderAids(state.aids || []);
    if (headerMeta) headerMeta.textContent = "LIVE";
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

  function merge(a, b) {
    var out = {};
    for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (var j in b) if (Object.prototype.hasOwnProperty.call(b, j)) out[j] = b[j];
    return out;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function setDisabled(btn, disabled) {
    if (btn.disabled !== disabled) btn.disabled = disabled;
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
    var isOn = function (name) {
      var v = (params.get(name) || "").toLowerCase();
      return v === "on" || v === "1" || v === "true";
    };
    showPit = !isOff("pit");
    showAids = !isOff("aids");
    readonly = isOn("readonly");

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
    // Start on the no-data state; the first frame carrying frame.mfd builds it.
    showNoData();
  }

  function update(frame, ctx) {
    if (disabled) return;
    // Hold off frame-driven updates right after a local write (see the note on
    // suppressFramesUntil) so the read-back's fresh value isn't reverted.
    if (Date.now() < suppressFramesUntil) return;
    renderState(frame && frame.mfd ? frame.mfd : null);
  }

  window.ApexOverlay.registerWidget("mfd", {
    // The MFD moves on driver input, not per frame; a gentle cadence is plenty.
    throttleMs: 250,
    init: init,
    update: update,
  });
})();
