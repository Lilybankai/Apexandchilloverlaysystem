/**
 * appearance.js — applies the operator's global widget-background setting.
 * -----------------------------------------------------------------------------
 * One knob, `--panel-alpha` (0..1), drives the background of EVERY widget: the
 * panel base, header strip, inner rows and the hairline borders all resolve
 * through it (see the surface tokens in css/theme.css). At 1 the overlay is the
 * original solid design; at 0 every box disappears and only the live data
 * floats over the game.
 *
 * Loaded as a plain <script> in <head> — before any widget paints — so the
 * chosen value is in place for the first frame instead of flashing a solid
 * panel and then fading it.
 *
 * Where the value comes from, in precedence order:
 *
 *   1. `?bg=` on the URL (0..1, or 0..100 as a percentage). Pins the page to a
 *      fixed value and disables the two live routes below — the escape hatch
 *      for an OBS source that wants its own look regardless of the app.
 *   2. The desktop app, pushed over the in-game bridge (window.apexIngame).
 *      Push, not poll: the in-game layer is the one page that renders over the
 *      sim every frame, so it does no periodic work at all.
 *   3. `/appearance.json` from our own server, polled once a second. This is
 *      the route for OBS Browser Sources and plain browser tabs, which have no
 *      bridge to the app — it means moving the control panel's slider retunes
 *      sources that are already live, with no need to re-add or reload them.
 *
 * Like the sponsor manifest, this is operator configuration served over HTTP
 * rather than telemetry: putting a value that changes twice a session into a
 * 30 Hz frame would repeat it 30 times a second for nothing.
 */
(function () {
  "use strict";

  /** How often browser/OBS pages re-read the setting (ms). */
  var POLL_MS = 1000;

  /** Last value written to the document, and the live value behind it. */
  var written = null;
  var wanted = 1;
  var suspended = false;

  /**
   * Write an alpha (0..1) into the document.
   *
   * It has to land on <html>, the element the surface tokens are declared on:
   * a custom property is substituted where it is DECLARED, not where it is
   * used, so `--bg-panel: rgba(…, var(--panel-alpha))` has already resolved by
   * the time it inherits downwards. Setting --panel-alpha on any deeper element
   * would compute a new value that nothing reads.
   */
  function write(alpha) {
    if (alpha === written) return;
    written = alpha;
    var root = document.documentElement;
    root.style.setProperty("--panel-alpha", String(alpha));
    // Anything below solid gets the text-shadow that replaces the dark panel
    // backdrop; the default, fully-opaque overlay is left completely alone.
    root.setAttribute("data-panel-bg", alpha >= 1 ? "solid" : "translucent");
  }

  /**
   * Record the operator's chosen alpha and show it, unless something has
   * suspended the setting (see ApexAppearance below) — in which case it is kept
   * and applied when that ends. Cheap and idempotent: the poll calls this every
   * second and it does nothing unless the value moved.
   */
  function apply(alpha) {
    if (typeof alpha !== "number" || !isFinite(alpha)) return;
    wanted = Math.min(1, Math.max(0, alpha));
    if (!suspended) write(wanted);
  }

  /* --------------------------- per-widget modes --------------------------- */

  /** Current mode per widget id, and everyone who wants telling when it moves. */
  var modes = {};
  var modeListeners = [];

  /**
   * Apply a `{ widgetId: mode }` map. Widgets subscribe rather than poll: a mode
   * changes a handful of times a session, so re-reading it every frame would be
   * pure waste in a loop that runs at the broadcast rate.
   */
  function applyModes(next) {
    if (!next || typeof next !== "object") return;
    var changed = false;
    for (var id in next) {
      if (!Object.prototype.hasOwnProperty.call(next, id)) continue;
      var mode = String(next[id]);
      if (modes[id] !== mode) {
        modes[id] = mode;
        changed = true;
      }
    }
    if (!changed) return;
    for (var i = 0; i < modeListeners.length; i++) {
      try {
        modeListeners[i](modes);
      } catch (e) {
        // A widget's own handler must never break the appearance channel.
        if (window.console) console.error("[Apex] mode listener failed:", e);
      }
    }
  }

  /**
   * The control surface other overlay code has over appearance.
   *
   * `suspend`/`resume` exist for the in-game layout editor, which forces panels
   * back to solid while it is open — you cannot drag, stretch or even find a
   * widget you cannot see. Routed through here rather than written directly so
   * this file stays the only writer: a slider change that lands mid-edit is
   * remembered and shows the moment editing ends.
   */
  window.ApexAppearance = {
    suspend: function () {
      suspended = true;
      write(1);
    },
    resume: function () {
      suspended = false;
      write(wanted);
    },
    /** Current mode for a widget, or `dflt` when none has been set. */
    mode: function (widgetId, dflt) {
      return modes[widgetId] || dflt;
    },
    /** Subscribe to mode changes; called immediately with the current map. */
    onModes: function (cb) {
      modeListeners.push(cb);
      cb(modes);
    },
  };

  /** Accepts 0..1 (a fraction) or 1..100 (a percentage), as the panel sends. */
  function toAlpha(value) {
    var n = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(n)) return null;
    if (n > 1) n = n / 100;
    return Math.min(1, Math.max(0, n));
  }

  /* ---------------------------- 1. URL override --------------------------- */

  // `?bg=` pins the OPACITY only. Widget modes keep flowing, so a source with a
  // fixed look still follows a readout switch — pinning one is not a request to
  // freeze the other.
  var alphaPinned = false;
  try {
    var raw = new URLSearchParams(window.location.search).get("bg");
    var fromUrl = raw === null ? null : toAlpha(raw);
    if (fromUrl !== null) {
      apply(fromUrl);
      alphaPinned = true;
    }
  } catch (e) {
    /* no URLSearchParams / malformed query — fall through to the live routes */
  }

  /* ------------------------- 2. In-game app bridge ------------------------ */

  var bridge = window.apexIngame || null;
  if (bridge && typeof bridge.onAppearance === "function") {
    bridge.onAppearance(function (appearance) {
      if (!appearance) return;
      var a = toAlpha(appearance.panelOpacity);
      if (a !== null && !alphaPinned) apply(a);
      applyModes(appearance.widgetModes);
    });
    return; // the app pushes changes — nothing to poll
  }

  /* --------------------------- 3. Server polling -------------------------- */

  function read() {
    fetch("/appearance.json", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cfg) {
        if (!cfg) return;
        var a = toAlpha(cfg.panelOpacity);
        if (a !== null && !alphaPinned) apply(a);
        applyModes(cfg.widgetModes);
      })
      .catch(function () {
        // Served from somewhere without the route (or the server is down):
        // keep whatever is applied. The overlay must never depend on this.
      });
  }

  read();
  var timer = window.setInterval(read, POLL_MS);
  // A source removed from OBS tears the page down anyway; this is for tidiness
  // in a browser tab.
  window.addEventListener("pagehide", function () {
    window.clearInterval(timer);
  });
})();
