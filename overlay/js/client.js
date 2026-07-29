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

  /** Format a temperature in °C to one decimal with a degree suffix. */
  function tempC1(c) {
    return has(c) ? c.toFixed(1) + "°" : "—";
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
    tempC1: tempC1,
    liters: liters,
    intVal: intVal,
    pct: pct,
    gearLabel: gearLabel,
  };

  /* ------------------------------------------------------------------ */
  /*  Critical-value writes + change glow                                */
  /* ------------------------------------------------------------------ */

  /**
   * Every widget needs the same two things for a critical readout: write the DOM
   * only when the value actually moved, and — when it did — make it announce
   * itself. Both live here rather than in the widgets because the guard was
   * being hand-rolled in ~30 places and the flash existed in exactly one
   * (standings' private PB_FLASH_MS/flashUntil map), so nothing else could get
   * it without copying it.
   *
   * How long the bloom is HELD at full strength. The decay itself is a CSS
   * transition (--glow-fade), so the visual fade is smooth and independent of
   * the widget's throttleMs — which is 250 ms for fuel, weather, damage and MFD
   * and would make a JS-driven decay visibly steppy.
   */
  var GLOW_HOLD_MS = 120;

  /** @type {WeakMap<Element, {v:*, until:number}>} last value + bloom deadline. */
  var critState = new WeakMap();

  /** Elements currently glowing, swept for expiry at the end of each frame. */
  var glowing = [];

  /** The operator can turn the glow off; js/appearance.js owns the attribute. */
  function glowEnabled() {
    return document.documentElement.getAttribute("data-glow-enabled") !== "false";
  }

  /** Arm (or re-arm) the bloom on an element that just changed. */
  function arm(el, now) {
    if (!glowEnabled()) return;
    var s = critState.get(el);
    if (!s.until) {
      el.setAttribute("data-glow", "on");
      glowing.push(el);
    }
    s.until = now + GLOW_HOLD_MS;
  }

  /**
   * Write text to a critical element, blooming on change.
   *
   * The first write is deliberately silent: a widget coming to life would
   * otherwise flash every value it owns at once, which reads as a fault rather
   * than as news.
   *
   * @param {Element} el    Element carrying the `is-crit` marker class.
   * @param {string}  text  The formatted value.
   */
  function crit(el, text) {
    writeCrit(el, text, false);
  }

  /**
   * As `crit`, for a value whose markup carries a nested unit (`26.4<small>L
   * </small>`). Only ever called with strings this codebase builds itself, and
   * only when the value moved, so it costs an innerHTML parse a few times a lap.
   */
  function critHtml(el, html) {
    writeCrit(el, html, true);
  }

  function writeCrit(el, value, asHtml) {
    if (!el) return;
    var s = critState.get(el);
    if (!s) {
      critState.set(el, { v: value, until: 0 });
      if (asHtml) el.innerHTML = value;
      else el.textContent = value;
      return;
    }
    if (s.v === value) return;
    s.v = value;
    if (asHtml) el.innerHTML = value;
    else el.textContent = value;
    arm(el, nowMs());
  }

  /**
   * Same contract for a `data-*` attribute rather than text — the house way of
   * expressing a state bucket (data-state="ok|marginal|short", data-wear=…).
   * Crossing a bucket boundary is exactly the kind of discrete change worth a
   * bloom, even when the number itself is drifting continuously.
   *
   * The bloom lands on `el`, so pass the element that shows the value.
   */
  function critAttr(el, attr, value) {
    if (!el) return;
    var key = attr + " " + value;
    var s = critState.get(el);
    if (!s) {
      critState.set(el, { v: key, until: 0 });
      el.setAttribute(attr, value);
      return;
    }
    if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
    if (s.v === key) return;
    s.v = key;
    arm(el, nowMs());
  }

  /**
   * Explicitly bloom an element for a discrete event with no value of its own
   * (a personal best set, a blue flag raised). Idempotent while already lit, so
   * a widget may call it every frame the condition holds.
   */
  function critPulse(el) {
    if (!el) return;
    if (!critState.get(el)) critState.set(el, { v: null, until: 0 });
    arm(el, nowMs());
  }

  /** Drop the bloom from anything whose hold has elapsed; CSS fades the rest. */
  function sweepGlow(now) {
    for (var i = glowing.length - 1; i >= 0; i--) {
      var el = glowing[i];
      var s = critState.get(el);
      if (s && now < s.until) continue;
      if (s) s.until = 0;
      el.removeAttribute("data-glow");
      glowing.splice(i, 1);
    }
  }

  function nowMs() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

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
  var ctx = {
    fmt: fmt,
    crit: crit,
    critHtml: critHtml,
    critAttr: critAttr,
    critPulse: critPulse,
    // Shared so the two widgets that show a pre-session header cannot drift
    // apart on what to call the session or how long it is.
    sessionLabel: sessionLabel,
    sessionLength: sessionLength,
    // …and likewise for the consequence indicator, which the Track Limits
    // widget and the MFD both announce.
    consequenceMs: CONSEQUENCE_MS,
    consequenceFresh: consequenceFresh,
    penaltyCount: penaltyCount,
    penaltyText: penaltyText,
  };

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

  /* ------------------------------------------------------------------ */
  /*  The consequence indicator                                          */
  /* ------------------------------------------------------------------ */

  /**
   * How long a penalty stays announced after the sim applies it, ms.
   *
   * Four seconds: long enough to be seen by a driver whose eyes are on a corner
   * exit when it lands, short enough that it is unambiguously about the thing
   * that just happened rather than a status light that has been on for a while.
   * Past this the penalty is still *reported* — it goes on standing, and the
   * widgets keep showing the count — it just stops shouting about it.
   *
   * Lives here rather than in a widget because more than one surface announces
   * it (the Track Limits widget and the MFD), and two of them disagreeing about
   * how long "just now" lasts would make the overlay look broken at exactly the
   * moment the driver is paying most attention to it.
   */
  var CONSEQUENCE_MS = 4000;

  /**
   * Whether a penalty has landed within the announce window.
   *
   * Takes the whole `trackLimits` block so a caller cannot accidentally pass
   * `msSinceWarning` — the two are adjacent on the frame, identically typed, and
   * mean very different things.
   */
  function consequenceFresh(trackLimits) {
    if (!trackLimits) return false;
    var since = trackLimits.msSincePenalty;
    return typeof since === "number" && since >= 0 && since < CONSEQUENCE_MS;
  }

  /** The sim's outstanding penalty count, or 0 when unknown/none. */
  function penaltyCount(trackLimits) {
    if (!trackLimits) return 0;
    var n = trackLimits.penalties;
    return typeof n === "number" && n > 0 ? n : 0;
  }

  /** "1 PENALTY" / "2 PENALTIES" — the wording both surfaces use. */
  function penaltyText(n) {
    return n + (n === 1 ? " PENALTY" : " PENALTIES");
  }

  /**
   * Short session names for the pre-session headers. Kept here rather than in a
   * widget because two widgets show them and they must agree — the relative
   * panel and the standings strip disagreeing about which session you are in
   * would be worse than either being slightly terse.
   */
  var SESSION_SHORT = {
    practice: "PRACTICE",
    qualifying: "QUALIFYING",
    warmup: "WARM-UP",
    race: "RACE",
    testday: "TEST DAY",
    unknown: "SESSION",
  };

  function sessionLabel(type) {
    return SESSION_SHORT[type] || SESSION_SHORT.unknown;
  }

  /**
   * A session's booked length as a short string ("24 LAPS", "30 MIN", "2 HR"),
   * or "" when the sim has published none — in which case the caller shows just
   * the session's name rather than inventing a duration.
   */
  function sessionLength(session) {
    if (has(session.totalLaps) && session.totalLaps > 0) return session.totalLaps + " LAPS";
    if (!has(session.scheduledLengthSec) || session.scheduledLengthSec <= 0) return "";
    var mins = Math.round(session.scheduledLengthSec / 60);
    return mins >= 60 && mins % 60 === 0 ? mins / 60 + " HR" : mins + " MIN";
  }

  function updateSessionMeta(frame) {
    // Standings header: position / field size. Tier 1 and glow-eligible — your
    // own position changing is the single most consequential discrete event in a
    // race, and it is the one the driver most often misses while driving.
    var s = document.querySelector('#widget-standings [data-role="session"]');
    if (s && frame.player && frame.session) {
      if (!s.classList.contains("is-crit")) s.classList.add("is-crit");
      crit(s, fmt.intVal(frame.player.position) + " / " + fmt.intVal(frame.session.numCars));
    }
    // Relative header: current lap / total (or time remaining for timed races),
    // and before the flag drops, which session is about to run.
    var laps = document.querySelector('#widget-relative [data-role="laps"]');
    if (laps && frame.session) {
      var cur = frame.session.currentLap;
      var tot = frame.session.totalLaps;
      var text;
      if (frame.session.notStarted) {
        // Same reasoning as the standings strip: there is no lap 1 yet, so a
        // counter reads as broken. Name the session and its booked length —
        // the full length, never the remaining clock, which pre-green is the
        // countdown to the start rather than the session's own duration.
        text = sessionLabel(frame.session.type);
        var len = sessionLength(frame.session);
        if (len) text += " " + len;
      } else if (has(tot) && tot > 0) {
        text = "LAP " + fmt.intVal(cur) + "/" + tot;
      } else if (has(frame.session.timeRemainingSec)) {
        var mins = Math.max(0, Math.floor(frame.session.timeRemainingSec / 60));
        text = mins + " MIN";
      } else {
        text = "LAP " + fmt.intVal(cur);
      }
      // Steps once a lap (or once a minute on the timed variant), so it blooms.
      if (!laps.classList.contains("is-crit")) laps.classList.add("is-crit");
      crit(laps, text);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Frame dispatch                                                     */
  /* ------------------------------------------------------------------ */

  function dispatch(frame) {
    var now = nowMs();

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

    // After the widgets have written, retire any bloom whose hold has elapsed.
    // Done once per frame here rather than with a timer per element: the loop is
    // already ticking, and a value that changes twice in quick succession must
    // re-arm the same deadline instead of racing two pending timeouts.
    if (glowing.length) sweepGlow(now);
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
      // The sweep only runs on a frame, so without this a bloom that was lit as
      // the link dropped would sit there glowing over the track indefinitely.
      if (glowing.length) sweepGlow(Infinity);
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

  /**
   * A flashing alarm bar, pinned to the top of a widget's body.
   *
   * Shared rather than written per widget because the same alarm has to appear
   * in more than one place at once — the fuel calculator and the fuel planner
   * both carry the pit call — and two copies of an alarm are two things that can
   * drift apart. An alarm that says one thing in one widget and something else
   * in another is worse than no alarm, because the driver then has to work out
   * which one to believe, at exactly the moment they have no attention to spare.
   *
   * @param {Element} parent - Widget body; the bar inserts itself at the top.
   * @returns {function(boolean, string): void} `set(active, text)`, cheap to
   *   call every frame — it only touches the DOM when something actually moved.
   */
  function alarmBar(parent) {
    var el = document.createElement("div");
    el.className = "alarmbar";
    el.hidden = true;
    parent.insertBefore(el, parent.firstChild);
    var lastText = null;
    var on = false;
    return function set(active, text) {
      if (active) {
        if (text !== lastText) {
          lastText = text;
          el.textContent = text;
        }
        if (!on) {
          on = true;
          el.hidden = false;
        }
      } else if (on) {
        on = false;
        el.hidden = true;
      }
    };
  }

  // Expose the runtime for widget modules.
  window.ApexOverlay = {
    registerWidget: registerWidget,
    fmt: fmt,
    alarmBar: alarmBar,
  };

  // Boot scheduling.
  // The widget modules are sibling `defer` scripts that execute AFTER this file
  // but BEFORE DOMContentLoaded, registering themselves as they run. During that
  // deferred-execution window document.readyState is already "interactive", so
  // booting synchronously here would run before any widget has registered —
  // leaving every widget unbound (root = null) and its body stuck on
  // "Awaiting telemetry…" even though the socket connects. So we always wait for
  // DOMContentLoaded (which fires once every deferred widget script has run) and
  // only boot synchronously when the document is already fully loaded (e.g. this
  // script was injected late). A guard makes boot idempotent.
  var booted = false;
  function bootOnce() {
    if (booted) return;
    booted = true;
    boot();
  }
  if (document.readyState === "complete") {
    bootOnce();
  } else {
    document.addEventListener("DOMContentLoaded", bootOnce);
    // Safety net in case DOMContentLoaded already fired while "interactive".
    window.addEventListener("load", bootOnce);
  }
})();
