/**
 * widgets/tyres.js — four-corner tyre temps + wear (bottom-right).
 * -----------------------------------------------------------------------------
 * Renders `frame.player.tyres` (TyreSet). For the locally-driven car the sim
 * supplies two live per-corner temperatures from shared memory: the **inner-
 * liner** temp — the number the in-game HUD shows — and the **surface**
 * (contact-patch) temp. The inner-liner is the primary readout; the surface
 * shows on the sub-line as `surf NN°`. When no temperature is available
 * (spectating, or the car isn't running on track) the corner falls back to
 * remaining tread % as the primary readout. The colour band always reflects
 * remaining tread. Corner cells are created once, updated in place.
 *
 * ## The temperature LED
 * Each corner carries a small lamp saying whether the tyre is in its operating
 * window. It judges the **core** temperature (`tempC`, the inner-liner mean —
 * the same number the in-game HUD shows) against `optimalTempC`, which is the
 * sim's OWN published optimum for the compound fitted to that corner.
 *
 * The lamp is dark whenever `optimalTempC` is absent. That is the important
 * case, not an edge case: the optimum is only published on the LMU path, so
 * spectating or running another sim leaves it unknown, and a lamp that lit up
 * green against an invented window would be confidently wrong for every car
 * whose real window is somewhere else. Temperatures still show; only the
 * verdict withholds.
 *
 * ## The map view
 * `map` mode draws the four tyres as tread strips coloured blue→red across the
 * inner/centre/outer bands, with the core temperature written on each tyre. The
 * bands are already oriented to the car by the provider (inner = toward the
 * car's centreline on all four corners), so the left and right tyres mirror each
 * other on screen exactly as they do on the car.
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

  /**
   * How far from the sim's optimum still counts as being in the window, °C.
   *
   * The sim publishes a single optimal temperature, not a range, so the width
   * has to come from somewhere and this is the one number here that is a
   * judgement rather than a reading. ±8 °C is deliberately generous: a tyre a
   * few degrees off its peak is a tyre that is working, and a band tight enough
   * to flicker between green and amber down a straight would train the driver
   * to ignore the lamp. Outside 2× that, the tyre is genuinely cold or genuinely
   * overheating.
   */
  var IN_WINDOW_C = 8;
  var NEAR_WINDOW_C = 16;

  /**
   * The lamp state for one corner: `ok` (in the window), `cold`/`hot` (near it,
   * on the way in or out), `freezing`/`burning` (well outside), or `unknown`
   * when either the temperature or the sim's optimum is missing.
   *
   * Cold and hot are distinguished rather than collapsed into one "off
   * temperature" state because the response differs — a cold tyre wants pushing
   * and a hot one wants managing, and the colour is what says which.
   */
  function tempLamp(tempC, optimalC, has) {
    if (!has(tempC) || !has(optimalC)) return "unknown";
    var d = tempC - optimalC;
    if (Math.abs(d) <= IN_WINDOW_C) return "ok";
    if (Math.abs(d) <= NEAR_WINDOW_C) return d < 0 ? "cold" : "hot";
    return d < 0 ? "freezing" : "burning";
  }

  /**
   * A temperature's colour on the blue→red thermal ramp, as an HSL string.
   *
   * The ramp is a hue sweep from 210° to 0°, so it runs blue → cyan → green →
   * yellow → red. A straight blue-to-red mix would pass through purple, where
   * two very different temperatures look alike; going round the hue circle
   * keeps every step distinguishable at a glance, which is the only thing this
   * colour is for.
   *
   * The scale is anchored on the sim's optimum when there is one, so the green
   * middle of the ramp lands on the temperature that actually is optimal for
   * the compound fitted. Without an optimum it falls back to a fixed 35–105 °C
   * window: still a truthful picture of hot-vs-cold across the tread, but the
   * colours no longer claim to know where the window sits.
   */
  function rampColor(c, optimalC, has) {
    if (!has(c)) return "";
    var lo = has(optimalC) ? optimalC - 45 : 35;
    var hi = has(optimalC) ? optimalC + 25 : 105;
    var t = (c - lo) / (hi - lo);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return "hsl(" + Math.round(210 * (1 - t)) + ", 85%, 52%)";
  }

  /** The three across-the-tread bands for a view, or null when incomplete. */
  function bandsOf(t, which, has) {
    var a =
      which === "surface"
        ? [t.surfaceInnerC, t.surfaceMiddleC, t.surfaceOuterC]
        : [t.innerC, t.middleC, t.outerC];
    if (!has(a[0]) || !has(a[1]) || !has(a[2])) return null;
    return a;
  }

  var header, modeChip, cells = {};
  /** Last label written to the mode chip, so it only touches the DOM on a change. */
  var modeChipCache = "";

  /**
   * What the big line is showing, in words. Keyed on the reading actually
   * chosen rather than on the requested mode: `auto` resolves to one of the
   * three, and an explicit mode falls back when its channel is missing, so
   * naming the request would sometimes name something that is not on screen.
   */
  var VIEW_LABELS = {
    core: "CORE TEMP",
    surface: "SURFACE TEMP",
    tread: "TREAD LEFT",
    map: "TYRE MAP",
  };
  var cache = {};

  function init(root) {
    header = root.querySelector('[data-role="compound"]');
    // Marked here rather than in the shell markup so the three pages that embed
    // this widget (index.html, widget.html, ingame.html) cannot drift apart.
    if (header) header.classList.add("is-crit");
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    initMode(new URLSearchParams(window.location.search));

    // Names the reading currently on the big line. The view is cycled from a
    // wheel button or a Stream Deck, where the driver cannot see what they
    // pressed — and three of the four views are numbers in the 20-120 range, so
    // a core temp, a surface temp and a tread percentage are not tellable apart
    // by looking at them. Without this the cycle is a guess.
    modeChip = document.createElement("div");
    modeChip.className = "tyres__mode";
    modeChip.textContent = "";
    mount.appendChild(modeChip);

    var grid = document.createElement("div");
    grid.className = "tyres__grid";

    CORNERS.forEach(function (c) {
      var cell = document.createElement("div");
      cell.className = "tyre";
      cell.setAttribute("data-wear", "unknown");

      // Corner label, with the operating-window lamp beside it. The lamp sits
      // on the label row rather than next to the number so it holds the same
      // position in every view — including the map, where there is no big
      // number for it to attach to.
      var posRow = document.createElement("div");
      posRow.className = "tyre__posrow";
      var pos = document.createElement("div");
      pos.className = "tyre__pos";
      pos.textContent = c.label;
      var led = document.createElement("div");
      led.className = "tyre__led";
      led.setAttribute("data-lamp", "unknown");
      posRow.appendChild(pos);
      posRow.appendChild(led);

      // Primary readout: live temperature (falls back to tread % — see update).
      // Tier 1: `is-crit` carries the bloom for a corner crossing a wear bucket.
      // The number itself does NOT bloom — a temperature moves every frame.
      var primary = document.createElement("div");
      primary.className = "tyre__wear is-crit";
      primary.textContent = "—";

      // Sub-line: remaining tread %, or a label when temp isn't the primary.
      var sub = document.createElement("div");
      sub.className = "tyre__temp";
      sub.textContent = "TREAD";

      // Map view: the tyre itself, as a tread strip of three coloured bands
      // (inner → centre → outer, left-to-right as seen from above) with each
      // band's temperature written into it. Built once and left hidden until
      // the map view asks for it.
      var strip = document.createElement("div");
      strip.className = "tyre__strip";
      strip.hidden = true;
      var segs = [];
      for (var s = 0; s < 3; s++) {
        var seg = document.createElement("div");
        seg.className = "tyre__seg";
        seg.textContent = "—";
        strip.appendChild(seg);
        segs.push(seg);
      }

      var band = document.createElement("div");
      band.className = "tyre__band";

      cell.appendChild(posRow);
      cell.appendChild(primary);
      cell.appendChild(strip);
      cell.appendChild(sub);
      cell.appendChild(band);
      grid.appendChild(cell);

      cells[c.key] = {
        cell: cell,
        primary: primary,
        sub: sub,
        led: led,
        strip: strip,
        segs: segs,
      };
    });

    mount.appendChild(grid);
  }

  /**
   * Which reading fills the big line: 'auto' (core temp → surface → tread),
   * 'temp', 'surface' or 'tread'.
   *
   * Set by the operator through the appearance channel (a bound key/wheel button
   * cycles it live), or pinned per OBS source with `?tyres=`. The URL wins, the
   * same contract the Motion widget's mode params use — a source configured for
   * a specific readout should not change under someone else's key press.
   */
  var mode = "auto";
  var modePinned = false;

  function initMode(params) {
    var fromUrl = (params.get("tyres") || "").trim().toLowerCase();
    if (
      fromUrl === "temp" ||
      fromUrl === "surface" ||
      fromUrl === "tread" ||
      fromUrl === "map" ||
      fromUrl === "auto"
    ) {
      mode = fromUrl;
      modePinned = true;
      return;
    }
    if (window.ApexAppearance && window.ApexAppearance.onModes) {
      window.ApexAppearance.onModes(function (modes) {
        if (modePinned) return;
        mode = modes.tyres || "auto";
      });
    }
  }

  /**
   * Sets one corner's operating-window lamp, and names the window it was judged
   * against in the element's tooltip — so the colour can be interrogated once
   * and then trusted, rather than being a verdict of unknown provenance.
   */
  function updateLamp(ref, t, fmt) {
    var lamp = tempLamp(t.tempC, t.optimalTempC, fmt.has);
    if (ref.lampCache === lamp) return;
    ref.lampCache = lamp;
    ref.led.setAttribute("data-lamp", lamp);
    // The window is judged in Celsius (see IN_WINDOW_C) but named in whatever
    // the driver reads, so the tooltip cannot quote the constant directly: ±8 C
    // is ±14 F, and printing "±8°" beside a Fahrenheit optimum would describe a
    // window four times tighter than the lamp is actually using.
    ref.led.title = fmt.has(t.optimalTempC)
      ? "Core vs optimal " +
        fmt.temp1(t.optimalTempC) +
        " (±" + Math.round(fmt.tempSpan(IN_WINDOW_C)) + "°)"
      : "No optimal temperature published for this car";
  }

  /**
   * Paints one corner's tread strip.
   *
   * Surface bands are preferred over liner bands: they are what actually
   * touches the road, and they spread several times further across the tread
   * than the liner does — a liner-only strip would be three near-identical
   * colours, which is a gradient in name only. The liner stands in when the
   * surface triplet is incomplete, and a corner with neither shows dashes on a
   * flat strip rather than a colour it cannot justify.
   */
  function updateStrip(ref, t, fmt) {
    var bands = bandsOf(t, "surface", fmt.has) || bandsOf(t, "liner", fmt.has);
    for (var b = 0; b < 3; b++) {
      var seg = ref.segs[b];
      var txt = bands ? fmt.temp(bands[b]) : "—";
      var col = bands ? rampColor(bands[b], t.optimalTempC, fmt.has) : "";
      if (seg.textContent !== txt) seg.textContent = txt;
      if (seg.style.background !== col) seg.style.background = col;
    }
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var tyres = frame.player ? frame.player.tyres : null;
    if (!tyres) return;

    var compound = null;
    // Which reading actually reached the big line. All four corners resolve the
    // same way, so the last one round is the answer for the widget.
    var view = null;
    for (var i = 0; i < CORNERS.length; i++) {
      var c = CORNERS[i];
      var t = tyres[c.key];
      var ref = cells[c.key];
      if (!t || !ref) continue;

      var hasCore = fmt.has(t.tempC); // core temp — matches the in-game HUD
      var hasSurf = fmt.has(t.surfaceTempC); // surface (contact-patch) temp
      var hasWear = fmt.has(t.wear);
      var wearStr = hasWear ? Math.round(t.wear * 100) + "%" : "—";
      var primaryStr, subStr;

      // Operating-window lamp — judged on the CORE temperature against the
      // sim's own optimum for the fitted compound, in EVERY view. The verdict
      // does not change with which number is on the big line: the tyre is
      // either in its window or it is not.
      updateLamp(ref, t, fmt);

      // The map view replaces the big number with a tread strip. Showing and
      // hiding is cached like everything else here — the strip's own contents
      // are only touched while it is visible.
      var isMap = mode === "map";
      if (ref.stripShown !== isMap) {
        ref.stripShown = isMap;
        ref.strip.hidden = !isMap;
      }

      // What goes on the big line is the operator's choice (bindable to a key,
      // a wheel button or a Stream Deck; see electron/actions.js). Each explicit
      // mode still falls back when its channel is missing, so picking "tread" on
      // a car that reports no wear shows a temperature rather than a dash.
      if (isMap) {
        updateStrip(ref, t, fmt);
        // Core on the big line, surface mean on the sub-line — the two figures
        // the strip cannot show, because it is showing their spread instead.
        // `coreC` is the carcass; `tempC` (the liner mean) stands in when the
        // sim publishes no separate carcass reading.
        var core = fmt.has(t.coreC) ? t.coreC : t.tempC;
        primaryStr = fmt.has(core) ? fmt.temp1(core) : wearStr;
        subStr = hasSurf ? "surf " + fmt.temp1(t.surfaceTempC) : "CORE";
        view = "map";
      } else if (mode === "tread" && hasWear) {
        primaryStr = wearStr;
        subStr = hasCore ? fmt.temp1(t.tempC) : hasSurf ? "surf " + fmt.temp1(t.surfaceTempC) : "TREAD";
        view = "tread";
      } else if (mode === "surface" && hasSurf) {
        primaryStr = fmt.temp1(t.surfaceTempC);
        subStr = wearStr;
        view = "surface";
      } else if (mode === "temp" && hasCore) {
        primaryStr = fmt.temp1(t.tempC);
        subStr = wearStr;
        view = "core";
      } else if (hasCore) {
        // 'auto' (the default): core temp → surface temp → tread %, with the
        // surface temp on the sub-line when core is primary.
        primaryStr = fmt.temp1(t.tempC);
        subStr = hasSurf ? "surf " + fmt.temp1(t.surfaceTempC) : wearStr;
        view = "core";
      } else if (hasSurf) {
        primaryStr = fmt.temp1(t.surfaceTempC);
        subStr = wearStr;
        view = "surface";
      } else {
        primaryStr = wearStr;
        subStr = "TREAD";
        view = "tread";
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
        var firstBucket = ref.bucket === undefined;
        ref.bucket = bucket;
        ref.cell.setAttribute("data-wear", bucket);
        // A corner dropping into `low` or `crit` is the event worth catching
        // peripherally, and it happens perhaps twice a stint. Not on the first
        // reading, which is a widget waking up rather than a tyre going away.
        if (!firstBucket && ctx.critPulse) ctx.critPulse(ref.primary);
      }

      if (!compound && t.compound) compound = t.compound;
    }

    // Name the view. `auto` says so as well as naming what it landed on, so a
    // driver cycling past it can tell a deliberate pick from the default.
    var label = view ? VIEW_LABELS[view] : "";
    if (label && mode === "auto") label += " · AUTO";
    if (modeChipCache !== label) {
      modeChipCache = label;
      modeChip.textContent = label;
      if (view) modeChip.setAttribute("data-view", view);
    }

    if (header) {
      // A compound change means a stop just happened — discrete, rare, and worth
      // confirming, so this one goes through the glow helper.
      var comp = compound || "—";
      if (cache.compound !== comp) {
        cache.compound = comp;
        if (ctx.crit) ctx.crit(header, comp.toUpperCase());
        else header.textContent = comp.toUpperCase();
      }
    }
  }

  window.ApexOverlay.registerWidget("tyres", {
    throttleMs: 200,
    init: init,
    update: update,
  });
})();
