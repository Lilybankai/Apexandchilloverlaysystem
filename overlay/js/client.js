/**
 * client.js — Apex Overlay System WebSocket client & widget runtime.
 * -----------------------------------------------------------------------------
 * This is the single entry point loaded by index.html. It:
 *   1. Exposes a tiny global runtime (`window.ApexOverlay`) that each widget
 *      module registers itself against (no bundler / ES-module step — the
 *      overlay is plain <script defer> tags so it runs inside OBS's CEF with
 *      zero build tooling and minimal footprint).
 *   2. Connects to the telemetry WebSocket, parses each {@link TelemetryFrame}
 *      (see src/telemetry/types.ts) and dispatches it to every registered
 *      widget, with per-widget throttling so only the pedal trace runs at the
 *      full broadcast rate.
 *   3. Auto-reconnects with capped backoff and reflects link state in the
 *      connection pill + a DEMO badge when the feed is simulated.
 *
 * Performance notes:
 *   - Widgets that don't need 30 Hz (standings, relative, weather, tyres, fuel)
 *     declare a `throttleMs`; the dispatcher skips them between intervals so we
 *     avoid needless DOM churn. Only pedals (throttleMs 0) updates every frame.
 *   - Formatting helpers are centralised here so widgets stay allocation-light.
 */
(function () {
  "use strict";

  /** Sentinel for unknown/unavailable numerics — mirrors UNKNOWN_VALUE in types.ts. */
  var UNKNOWN = -1;

  /* ------------------------------------------------------------------ */
  /*  Formatting helpers (shared by all widgets)                         */
  /* ------------------------------------------------------------------ */

  /** True when a numeric telemetry value is present (not the -1 sentinel). */
  function has(v) {
    return typeof v === "number" && v > UNKNOWN;
  }

  /** Format a lap/sector time in seconds as `M:SS.mmm` (or em dash if unknown). */
  function lapTime(sec) {
    if (!has(sec)) return "—";
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    // padStart keeps the seconds two digits so columns stay aligned.
    return m + ":" + s.toFixed(3).padStart(6, "0");
  }

  /** Format a gap-to-leader/ahead in seconds as `+S.mmm` (or laps if provided). */
  function gap(sec) {
    if (!has(sec)) return "—";
    return "+" + sec.toFixed(3);
  }

  /**
   * Format a signed delta in seconds as `+/-S.mmm`. `delta` uses -1 as its
   * unknown sentinel per the contract, so an exact -1 renders as an em dash.
   */
  function delta(sec) {
    if (typeof sec !== "number" || sec === UNKNOWN) return "—";
    var sign = sec > 0 ? "+" : sec < 0 ? "−" : "";
    return sign + Math.abs(sec).toFixed(3);
  }

  /** Signed on-track relative gap (relative widget): `+/-S.m` to one decimal. */
  function relGap(sec) {
    if (typeof sec !== "number") return "—";
    if (sec === 0) return "0.0";
    var sign = sec > 0 ? "+" : "−";
    return sign + Math.abs(sec).toFixed(1);
  }

  /** Format a temperature in °C as an integer with a degree suffix. */
  function tempC(c) {
    return has(c) ? Math.round(c) + "°" : "—";
  }

  /** Format litres to one decimal (or em dash). */
  function liters(l) {
    return has(l) ? l.toFixed(1) : "—";
  }

  /** Format an integer-ish value, em dash when unknown. */
  function intVal(n) {
    return has(n) ? String(Math.round(n)) : "—";
  }

  /** Clamp a 0..1 normalized value and return a 0..100 percentage number. */
  function pct(v) {
    if (typeof v !== "number" || v < 0) return 0;
    return Math.max(0, Math.min(1, v)) * 100;
  }

  /** Human gear label: -1 reverse, 0 neutral, n forward. */
  function gearLabel(g) {
    if (g === 0) return "N";
    if (g < 0) return "R";
    return String(g);
  }

  var fmt = {
    UNKNOWN: UNKNOWN,
    has: has,
    lapTime: lapTime,
    gap: gap,
    delta: delta,
    relGap: relGap,
    tempC: tempC,
    liters: liters,
    intVal: intVal,
    pct: pct,
    gearLabel: gearLabel,
  };

  /* ------------------------------------------------------------------ */
  /*  Widget registry                                                    */
  /* ------------------------------------------------------------------ */

  /** @type {Array<{name:string, def:object, root:Element|null, last:number}>} */
  var registry = [];

  /**
   * Register a widget module. Called synchronously by each widget script as it
   * loads (they run after this file thanks to <script defer> ordering).
   *
   * @param {string} name  Matches the section's `data-widget` attribute.
   * @param {object} def   { throttleMs?, init(root, ctx), update(frame, ctx) }
   */
  function registerWidget(name, def) {
    registry.push({ name: name, def: def, root: null, last: 0 });
  }

  /** Shared context handed to every widget init/update call. */
  var ctx = { fmt: fmt };

  /* ------------------------------------------------------------------ */
  /*  Connection-status UI                                               */
  /* ------------------------------------------------------------------ */

  var statusEl, statusText, demoBadge;

  function setStatus(state, text) {
    if (!statusEl) return;
    statusEl.setAttribute("data-state", state);
    if (statusText) statusText.textContent = text;
  }

  /** Show/hide the DEMO badge based on whether the feed is real. */
  function setDemo(isDemo) {
    if (!demoBadge) return;
    demoBadge.style.display = isDemo ? "" : "none";
  }

  /* ------------------------------------------------------------------ */
  /*  Session header helpers (top-of-panel meta shared across widgets)   */
  /* ------------------------------------------------------------------ */

  function updateSessionMeta(frame) {
    // Standings header: position / field size.
    var s = document.querySelector('#widget-standings [data-role="session"]');
    if (s && frame.player && frame.session) {
      s.textContent =
        fmt.intVal(frame.player.position) + " / " + fmt.intVal(frame.session.numCars);
    }
    // Relative header: current lap / total (or time remaining for timed races).
    var laps = document.querySelector('#widget-relative [data-role="laps"]');
    if (laps && frame.session) {
      var cur = frame.session.currentLap;
      var tot = frame.session.totalLaps;
      if (has(tot) && tot > 0) {
        laps.textContent = "LAP " + fmt.intVal(cur) + "/" + tot;
      } else if (has(frame.session.timeRemainingSec)) {
        var mins = Math.max(0, Math.floor(frame.session.timeRemainingSec / 60));
        laps.textContent = mins + " MIN";
      } else {
        laps.textContent = "LAP " + fmt.intVal(cur);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Frame dispatch                                                     */
  /* ------------------------------------------------------------------ */

  function dispatch(frame) {
    var now =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();

    setDemo(frame.connected === false);
    updateSessionMeta(frame);

    for (var i = 0; i < registry.length; i++) {
      var w = registry[i];
      if (!w.root) continue; // widget section not present in this page
      var t = w.def.throttleMs || 0;
      if (t > 0 && now - w.last < t) continue;
      w.last = now;
      try {
        w.def.update(frame, ctx);
      } catch (err) {
        // No silent failures — one bad widget must not kill the feed.
        console.error("[Apex] widget '" + w.name + "' update failed:", err);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  WebSocket lifecycle (auto-reconnect with capped backoff)           */
  /* ------------------------------------------------------------------ */

  var ws = null;
  var reconnectDelay = 500; // ms, doubles up to the cap
  var RECONNECT_MAX = 5000;
  var reconnectTimer = null;

  /** Resolve the WS URL from the page location, allowing ?ws= / ?port= overrides. */
  function resolveWsUrl() {
    var params = new URLSearchParams(window.location.search);
    var explicit = params.get("ws");
    if (explicit) return explicit;

    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    var host = window.location.hostname || "127.0.0.1";
    // Default port/path match src/server/config.ts (httpPort 8080, wsPath /ws).
    var port = params.get("port") || window.location.port || "8080";
    var path = params.get("path") || "/ws";
    return proto + "//" + host + ":" + port + path;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    setStatus("closed", "RECONNECTING");
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(RECONNECT_MAX, reconnectDelay * 2);
  }

  function connect() {
    var url = resolveWsUrl();
    setStatus("connecting", "CONNECTING");
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error("[Apex] WebSocket construction failed:", err);
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      reconnectDelay = 500; // reset backoff on a good connection
      setStatus("open", "LIVE");
    };

    ws.onmessage = function (event) {
      var frame;
      try {
        frame = JSON.parse(event.data);
      } catch (err) {
        console.error("[Apex] failed to parse frame:", err);
        return;
      }
      if (!frame || typeof frame !== "object") return;
      dispatch(frame);
    };

    ws.onclose = function () {
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose will follow and handle reconnect; just surface it.
      setStatus("closed", "LINK ERROR");
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        try {
          ws.close();
        } catch (e) {
          /* ignore */
        }
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Boot                                                               */
  /* ------------------------------------------------------------------ */

  function boot() {
    statusEl = document.getElementById("conn-status");
    statusText = statusEl ? statusEl.querySelector(".conn-status__text") : null;

    // Create the DEMO badge once, next to the connection pill.
    var stage = document.getElementById("stage");
    if (stage) {
      demoBadge = document.createElement("div");
      demoBadge.className = "chip chip--live demo-badge";
      demoBadge.textContent = "DEMO DATA";
      demoBadge.style.cssText =
        "position:absolute;top:4px;left:calc(50% + 70px);z-index:11;display:none;";
      stage.appendChild(demoBadge);
    }

    // Bind each registered widget to its section and initialise it.
    for (var i = 0; i < registry.length; i++) {
      var w = registry[i];
      w.root = document.querySelector('[data-widget="' + w.name + '"]');
      if (w.root && typeof w.def.init === "function") {
        try {
          w.def.init(w.root, ctx);
        } catch (err) {
          console.error("[Apex] widget '" + w.name + "' init failed:", err);
        }
      }
    }

    connect();

    // Re-fit the stage after boot in case fonts/layout shifted.
    if (typeof window.__apexFitStage === "function") window.__apexFitStage();
  }

  // Expose the runtime for widget modules.
  window.ApexOverlay = {
    registerWidget: registerWidget,
    fmt: fmt,
  };

  // Widgets register between this file and DOMContentLoaded (defer order),
  // so initialise on DOMContentLoaded when all sections + widgets are ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
