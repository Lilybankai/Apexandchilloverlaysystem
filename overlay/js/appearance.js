/**
 * appearance.js — applies the operator's global appearance settings.
 * -----------------------------------------------------------------------------
 * Three global knobs, all landing on <html> so every widget inherits them:
 *
 *   --panel-alpha (0..1)  drives the background of EVERY widget: the panel
 *      base, header strip, inner rows and the hairline borders all resolve
 *      through it (see the surface tokens in css/theme.css). At 1 the overlay
 *      is the original solid design; at 0 every box disappears and only the
 *      live data floats over the game.
 *   --fs-scale (0.8..1.2)  multiplies the whole type scale at once, so the
 *      glance hierarchy keeps its proportions while the operator tunes overall
 *      legibility for their screen size and seating distance.
 *   data-glow-enabled  turns the change glow on critical values on or off
 *      (read by the crit() helpers in js/client.js).
 *
 * …plus a per-widget override of the first one: `widgetOpacity` names widgets
 * that opt out of the global alpha, so the whole set can be faded to 50% for a
 * clean stream with the one panel that must be read at a glance kept solid.
 * That lands on the widget's own section rather than on <html> (see
 * paintWidgetAlpha, and the matching token block in css/theme.css).
 *
 * …plus one that cannot be CSS: the radar's car-icon size (30..150%), which is a
 * metres-per-pixel scale for a canvas, not a style. It is handed to the widget as
 * a value with a subscription (`ApexAppearance.onRadarIcons`).
 *
 * Loaded as a plain <script> in <head> — before any widget paints — so the
 * chosen values are in place for the first frame instead of flashing a solid
 * panel at the wrong size and then correcting it.
 *
 * Where the values come from, in precedence order:
 *
 *   1. `?bg=`, `?text=`, `?glow=` on the URL. Each pins its own knob to a fixed
 *      value and opts that one knob out of the two live routes below — the
 *      escape hatch for an OBS source that wants its own look regardless of the
 *      app. Pinning one does not freeze the others.
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

  /* ------------------------------- text scale ------------------------------ */

  /**
   * Bounds match the control panel's slider; see theme.css --fs-scale.
   *
   * The ceiling is 1.2, not something larger, because the widgets have FIXED
   * pixel widths: past ~1.25 the relative panel's four-across timing strip stops
   * fitting inside its 400px, then the motion stat cells and the tyre corners go
   * the same way. This knob is for tuning legibility within a panel — to make a
   * whole widget bigger, scale the OBS source (the stage already fits itself to
   * it) or use the in-game layer's own per-widget scale, both of which grow the
   * panel and its text together.
   */
  var SCALE_MIN = 0.8;
  var SCALE_MAX = 1.2;

  var scaleWritten = null;

  /**
   * Write the type scale. Lands on <html> for the same reason --panel-alpha
   * does: the size tokens are DECLARED there as calc(Npx * var(--fs-scale)), and
   * a custom property is substituted where it is declared, so setting the scale
   * on any deeper element would compute a value nothing reads.
   */
  function applyScale(scale) {
    if (typeof scale !== "number" || !isFinite(scale)) return;
    var s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
    if (s === scaleWritten) return;
    scaleWritten = s;
    document.documentElement.style.setProperty("--fs-scale", String(s));
  }

  /** Accepts 0.8..1.6 (a factor) or 80..160 (a percentage), as the panel sends. */
  function toScale(value) {
    var n = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(n)) return null;
    if (n > SCALE_MAX) n = n / 100;
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
  }

  /* ------------------------------ change glow ------------------------------ */

  var glowWritten = null;

  function applyGlow(on) {
    var v = on === false || on === "false" || on === 0 || on === "0" ? "false" : "true";
    if (v === glowWritten) return;
    glowWritten = v;
    document.documentElement.setAttribute("data-glow-enabled", v);
  }

  /* --------------------------- radar icon size ---------------------------- */

  /**
   * The radar's car-icon size, 30..150 (percent).
   *
   * Unlike the three knobs above this cannot be a CSS custom property: the radar
   * draws to a canvas, and the number is a *scale in metres per pixel*, not a
   * style. So it is handed over as a value with a subscription — the radar reads
   * it once at init and is told when it moves, rather than sampling it in a draw
   * loop that runs every frame.
   *
   * It lives on the appearance channel (not a URL param and not a slider on the
   * widget) because it is operator look-and-feel like the other three: set once
   * from the control panel, followed by every live source, in game and in OBS.
   */
  var ICON_MIN = 30;
  var ICON_MAX = 150;

  var iconScale = null;
  var iconListeners = [];

  function applyIcons(value) {
    var n = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(n)) return;
    var v = Math.min(ICON_MAX, Math.max(ICON_MIN, Math.round(n)));
    if (v === iconScale) return;
    iconScale = v;
    for (var i = 0; i < iconListeners.length; i++) {
      try {
        iconListeners[i](v);
      } catch (e) {
        if (window.console) console.error("[Apex] radar icon listener failed:", e);
      }
    }
  }

  /* ------------------------------ audio cues ------------------------------ */

  /**
   * On/off and master volume for the audio cues (see js/audio.js).
   *
   * Handed straight to `ApexAudio.configure` rather than written to the DOM: a
   * volume is not a style, and unlike the radar's icon size it has no
   * subscription either — the audio module holds the live value itself and reads
   * it when a cue fires, which happens a handful of times a session.
   *
   * `audio.js` is loaded by every overlay page beside this one, but the guard
   * below means a page that omits it simply has no cues rather than throwing.
   */
  function applyAudio(cfg) {
    var audio = window.ApexAudio;
    if (!audio || typeof audio.configure !== "function") return;
    if (cfg.audioCues === undefined && cfg.audioVolume === undefined) return;
    audio.configure({ audioCues: cfg.audioCues, audioVolume: cfg.audioVolume });
  }

  /* ------------------------ per-widget background ------------------------- */

  /**
   * A per-widget override of the global background alpha, `{ widgetId: 0..1 }`.
   *
   * The global slider answers "how much of the game do I want to see through
   * the overlay"; this answers "…except that one". The case it exists for is
   * the whole set faded to 50% for a clean stream, with the one panel that has
   * to be read at a glance — fuel, the relative table — kept solid, and it has
   * to be a per-widget edit rather than a second global mode, because which
   * widget that is differs per driver and per session.
   *
   * A widget with no entry here follows the global value and is left completely
   * alone: no inline style, no attribute, nothing for the default overlay to
   * pay for.
   */
  var widgetAlpha = {};
  /** Serialized `widgetAlpha` from the last repaint, so a poll that says the
   *  same thing again costs one string compare rather than a DOM sweep. */
  var alphaSig = null;

  /**
   * Push the per-widget alphas onto the widget sections.
   *
   * Both writes are needed. The custom property is what the re-declared surface
   * tokens read (see the [data-alpha="own"] block in css/theme.css — a token
   * resolves where it is DECLARED, so the widget has to re-declare them); the
   * data-panel-bg attribute is the same "is this thing see-through" flag the
   * global path sets on <html>, and it carries the text-shadow that replaces
   * the panel behind the text.
   */
  function paintWidgetAlpha() {
    var nodes = document.querySelectorAll("[data-widget]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var id = el.getAttribute("data-widget");
      // While the layout editor has the setting suspended EVERY panel is solid,
      // including the ones with an override — you cannot drag what you cannot
      // see, and that is exactly what suspend() means.
      var a = suspended ? undefined : widgetAlpha[id];
      if (a === undefined) {
        if (!el.hasAttribute("data-alpha")) continue;
        el.style.removeProperty("--panel-alpha");
        el.removeAttribute("data-alpha");
        el.removeAttribute("data-panel-bg");
      } else {
        el.style.setProperty("--panel-alpha", String(a));
        el.setAttribute("data-alpha", "own");
        el.setAttribute("data-panel-bg", a >= 1 ? "solid" : "translucent");
      }
    }
  }

  /** Accept a `{ widgetId: 0..100 }` map from the app or /appearance.json. */
  function applyWidgetAlpha(next) {
    if (!next || typeof next !== "object") next = {};
    var map = {};
    for (var id in next) {
      if (!Object.prototype.hasOwnProperty.call(next, id)) continue;
      var a = toAlpha(next[id]);
      if (a !== null) map[id] = a;
    }
    var sig = JSON.stringify(map);
    if (sig === alphaSig) return;
    alphaSig = sig;
    widgetAlpha = map;
    paintWidgetAlpha();
  }

  // The widget sections do not exist yet — this file runs in <head>, before the
  // first paint, which is the whole point of it. Anything that arrives before
  // the body is parsed is held in widgetAlpha and painted here.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      if (alphaSig !== null) paintWidgetAlpha();
    });
  }

  /* --------------------------- per-widget modes --------------------------- */

  /** Current mode per widget id, and everyone who wants telling when it moves. */
  var modes = {};
  var modeListeners = [];

  /* ------------------------------ speed units ----------------------------- */

  /**
   * 'kph' or 'mph'. Not a per-widget setting: speed is shown by the inputs
   * panels and by the motion widget, and a driver reading 168 on one and 104 on
   * the other would be right to think something was broken. One preference,
   * every readout, so they can only ever agree.
   */
  var speedUnit = "kph";
  var speedUnitListeners = [];

  /**
   * 'c' or 'f'. Same argument as the speed unit, one line up: the tyres widget,
   * the Speedo designs and the weather panel all print temperatures, and one
   * preference is the only way they can be made to agree.
   */
  var tempUnit = "c";
  var tempUnitListeners = [];

  /*
   * Whether the MFD fades itself out when idle (widgets/mfd.js). A subscription
   * rather than an attribute on <html> because the widget has timers to start
   * and stop on the change, not just a style to swap.
   */
  var mfdFade = false;
  var mfdFadeListeners = [];

  function applyMfdFade(next) {
    if (typeof next !== "boolean" || next === mfdFade) return;
    mfdFade = next;
    for (var i = 0; i < mfdFadeListeners.length; i++) {
      try {
        mfdFadeListeners[i](mfdFade);
      } catch (e) {
        /* one bad subscriber must not stop the rest */
      }
    }
  }

  function applyTempUnit(next) {
    var unit = next === "f" ? "f" : next === "c" ? "c" : null;
    if (!unit || unit === tempUnit) return;
    tempUnit = unit;
    for (var i = 0; i < tempUnitListeners.length; i++) {
      try {
        tempUnitListeners[i](tempUnit);
      } catch (e) {
        /* one bad subscriber must not stop the rest */
      }
    }
  }

  function applySpeedUnit(next) {
    var unit = next === "mph" ? "mph" : next === "kph" ? "kph" : null;
    if (!unit || unit === speedUnit) return;
    speedUnit = unit;
    for (var i = 0; i < speedUnitListeners.length; i++) {
      try {
        speedUnitListeners[i](speedUnit);
      } catch (e) {
        /* one bad subscriber must not stop the rest */
      }
    }
  }

  // `?units=mph` and `?temp=f` pin one OBS source, like every other override
  // here: a source built for an American broadcast should not flip because the
  // driver prefers kph and Celsius on their own screen. The two pin separately
  // — a British driver streaming to an American audience is a real combination.
  var unitPinned = false;
  var tempPinned = false;
  (function () {
    try {
      var q = new URLSearchParams(window.location.search);
      var raw = (q.get("units") || "").trim().toLowerCase();
      if (raw === "mph" || raw === "kph") {
        speedUnit = raw;
        unitPinned = true;
      }
      // `?temp=f`, `?temp=fahrenheit` and `?temp=°f` all mean the same thing to
      // whoever typed the URL, so they mean the same thing here.
      var t = (q.get("temp") || "").trim().toLowerCase().replace(/[^a-z]/g, "");
      if (t === "f" || t === "fahrenheit") {
        tempUnit = "f";
        tempPinned = true;
      } else if (t === "c" || t === "celsius" || t === "centigrade") {
        tempUnit = "c";
        tempPinned = true;
      }
    } catch (e) {
      /* no URLSearchParams / no location — keep the default */
    }
  })();

  /* ----------------------- standings composition -------------------------- */

  /**
   * How much of the field the standings tower draws. Delivered on this channel
   * for the same reason the modes are: it changes a handful of times a session,
   * so the tower subscribes instead of re-reading it every frame.
   *
   * Null until something has actually said — the tower keeps its own default
   * (the whole field) rather than being handed a placeholder it would draw once
   * and immediately redraw away from.
   */
  var standings = null;
  var standingsListeners = [];

  function applyStandings(next) {
    if (!next || typeof next !== "object") return;
    if (standings && JSON.stringify(standings) === JSON.stringify(next)) return;
    standings = next;
    for (var i = 0; i < standingsListeners.length; i++) {
      try {
        standingsListeners[i](standings);
      } catch (e) {
        /* one bad subscriber must not stop the rest */
      }
    }
  }

  /**
   * Apply a `{ widgetId: mode }` map. Widgets subscribe rather than poll: a mode
   * changes a handful of times a session, so re-reading it every frame would be
   * pure waste in a loop that runs at the broadcast rate.
   */
  function applyModes(next) {
    if (!next || typeof next !== "object") return;
    var changed = false;
    var id;
    // The app REMOVES an entry to mean "back to the default" (the card
    // dropdown sends null for the first option), so a key that has vanished
    // from the map is a change too. Without this sweep a widget switched to an
    // alternate design could never be switched back short of restarting.
    for (id in modes) {
      if (
        Object.prototype.hasOwnProperty.call(modes, id) &&
        !Object.prototype.hasOwnProperty.call(next, id)
      ) {
        delete modes[id];
        changed = true;
      }
    }
    for (id in next) {
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
      paintWidgetAlpha(); // a widget faded by its OWN setting has to come back too
    },
    resume: function () {
      suspended = false;
      write(wanted);
      paintWidgetAlpha();
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
    /**
     * Subscribe to the standings composition. Called immediately only if a value
     * has arrived, like onRadarIcons — see `standings` above.
     */
    onStandings: function (cb) {
      standingsListeners.push(cb);
      if (standings) cb(standings);
    },
    /** Current speed unit, and a subscription to it changing. */
    speedUnit: function () {
      return speedUnit;
    },
    onSpeedUnit: function (cb) {
      speedUnitListeners.push(cb);
      cb(speedUnit);
    },
    /** Current temperature unit, and a subscription to it changing. */
    tempUnit: function () {
      return tempUnit;
    },
    onTempUnit: function (cb) {
      tempUnitListeners.push(cb);
      cb(tempUnit);
    },
    /** Whether the MFD auto-fades when idle, and a subscription to it changing. */
    onMfdFade: function (cb) {
      mfdFadeListeners.push(cb);
      cb(mfdFade);
    },
    /**
     * Subscribe to the radar's icon size (percent). Called immediately IF a value
     * has already arrived — and deliberately not otherwise, so the radar keeps
     * its own default rather than being handed a placeholder it would have to
     * redraw away from a moment later.
     */
    onRadarIcons: function (cb) {
      iconListeners.push(cb);
      if (iconScale !== null) cb(iconScale);
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

  // Each param pins its OWN knob only. Widget modes keep flowing, and an
  // unpinned knob keeps following the app, so a source with a fixed background
  // still tracks a text-size change — pinning one is not a request to freeze
  // everything else.
  var alphaPinned = false;
  var scalePinned = false;
  var glowPinned = false;
  var iconsPinned = false;
  var audioPinned = false;
  try {
    var params = new URLSearchParams(window.location.search);

    var raw = params.get("bg");
    var fromUrl = raw === null ? null : toAlpha(raw);
    if (fromUrl !== null) {
      apply(fromUrl);
      alphaPinned = true;
    }

    var rawText = params.get("text");
    var scaleFromUrl = rawText === null ? null : toScale(rawText);
    if (scaleFromUrl !== null) {
      applyScale(scaleFromUrl);
      scalePinned = true;
    }

    var rawGlow = params.get("glow");
    if (rawGlow !== null) {
      applyGlow(rawGlow !== "0" && rawGlow !== "false" && rawGlow !== "off");
      glowPinned = true;
    }

    // ?icons= still pins the radar's icon size for a source that wants its own
    // zoom regardless of the panel — the same escape hatch the other three have.
    var rawIcons = params.get("icons");
    if (rawIcons !== null && isFinite(parseFloat(rawIcons))) {
      applyIcons(parseFloat(rawIcons));
      iconsPinned = true;
    }

    // ?audio=off silences ONE source while the rest keep the operator's setting
    // — the case that needs it is an OBS scene with several overlay sources in
    // it, where every one of them would otherwise cue the same event at once.
    // ?audio=<0..100> pins that source's volume instead.
    var rawAudio = params.get("audio");
    if (rawAudio !== null) {
      var off = rawAudio === "0" || rawAudio === "off" || rawAudio === "false";
      applyAudio({
        audioCues: !off,
        audioVolume: off ? 0 : isFinite(parseFloat(rawAudio)) ? parseFloat(rawAudio) : undefined,
      });
      audioPinned = true;
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
      // ?bg= pins the background for this source, per-widget overrides included:
      // the param exists so an OBS source can look exactly one way regardless of
      // the app, and honouring half of the setting would not be that.
      if (!alphaPinned) applyWidgetAlpha(appearance.widgetOpacity);
      var s = toScale(appearance.textScale);
      if (s !== null && !scalePinned) applyScale(s);
      if (!glowPinned && appearance.changeGlow !== undefined) {
        applyGlow(appearance.changeGlow);
      }
      if (!iconsPinned && appearance.radarIconScale !== undefined) {
        applyIcons(appearance.radarIconScale);
      }
      if (!audioPinned) applyAudio(appearance);
      applyModes(appearance.widgetModes);
      applyStandings(appearance.standings);
      if (!unitPinned) applySpeedUnit(appearance.speedUnit);
      if (!tempPinned) applyTempUnit(appearance.tempUnit);
      applyMfdFade(appearance.mfdAutoFade);
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
        if (!alphaPinned) applyWidgetAlpha(cfg.widgetOpacity);
        var s = toScale(cfg.textScale);
        if (s !== null && !scalePinned) applyScale(s);
        if (!glowPinned && cfg.changeGlow !== undefined) applyGlow(cfg.changeGlow);
        if (!iconsPinned && cfg.radarIconScale !== undefined) applyIcons(cfg.radarIconScale);
        if (!audioPinned) applyAudio(cfg);
        applyModes(cfg.widgetModes);
        applyStandings(cfg.standings);
        if (!unitPinned) applySpeedUnit(cfg.speedUnit);
        if (!tempPinned) applyTempUnit(cfg.tempUnit);
        applyMfdFade(cfg.mfdAutoFade);
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
