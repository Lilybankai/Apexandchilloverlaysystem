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

  /* ------------------------------ speed units ------------------------------ */

  /**
   * The sim reports speed in km/h; some drivers read mph. The conversion lives
   * here, once, because THREE widgets show speed (both inputs panels and
   * motion) and a driver seeing 168 on one and 104 on the other would be right
   * to think something was broken.
   *
   * The unit arrives on the appearance channel, so changing it retunes every
   * readout live — no reload, no restart, and an OBS source can pin its own
   * with `?units=mph`.
   */
  var speedUnit = "kph";
  if (window.ApexAppearance && window.ApexAppearance.onSpeedUnit) {
    window.ApexAppearance.onSpeedUnit(function (unit) {
      // appearance.js already rejects anything that is not one of the two, but
      // this is the last step before the number reaches a panel: a unit that
      // got through would be printed verbatim next to a real speed.
      if (unit === "kph" || unit === "mph") speedUnit = unit;
    });
  }

  /** 1 mile = 1.609344 km, exactly. */
  var KPH_PER_MPH = 1.609344;

  /**
   * A speed in km/h as the driver's chosen unit, with the unit on it:
   * `168` -> `"168 kph"` or `"104 mph"`. Rounded, because a tenth of a mph is
   * noise at a glance and this sits in a panel header.
   */
  function speed(kph) {
    // The em dash keeps the unit beside it: a header that reads "— kph" says
    // what it will be showing, which "—" alone does not.
    if (!has(kph)) return "— " + speedUnit;
    var v = speedUnit === "mph" ? kph / KPH_PER_MPH : kph;
    return Math.round(v) + " " + speedUnit;
  }

  /** The same conversion for a value already in m/s (the motion widget's). */
  function speedFromMs(ms) {
    return has(ms) ? speed(ms * 3.6) : "— " + speedUnit;
  }

  /**
   * The converted NUMBER on its own, and the unit label on its own.
   *
   * `speed()` returns them joined ("248 kph"), which is right for a panel header
   * but not for the Speedo cluster, where the number is the biggest thing on the
   * screen and the unit is a small label beside it — they need different type.
   * Splitting `speed()`'s output on the space would work until a locale or a
   * unit with a space in it made it not, so the pair is exposed properly instead.
   *
   * The conversion still happens in exactly one place, which is the whole point
   * of this section: these two are views on the same arithmetic, not a second
   * copy of it.
   */
  function speedValue(kph) {
    if (!has(kph)) return "—";
    return String(Math.round(speedUnit === "mph" ? kph / KPH_PER_MPH : kph));
  }

  /** The driver's current unit as a bare label — `"kph"` or `"mph"`. */
  function speedUnitLabel() {
    return speedUnit;
  }

  /* --------------------------- temperature units --------------------------- */

  /**
   * The sim reports every temperature in Celsius; plenty of drivers read tyres
   * in Fahrenheit. Same argument as the speed unit above, and the same shape:
   * the conversion lives here once, because tyre temps appear on the tyres
   * widget, on three of the Speedo designs and on the weather panel, and a
   * driver reading 96 on one and 205 on the next would be right to think
   * something was broken.
   *
   * Everything BEHIND the number stays metric — the operating-window lamp, the
   * blue-to-red thermal ramp, the wear buckets. Those are physics, judged
   * against the sim's own optimum in the sim's own unit; only the printing
   * changes.
   */
  var tempUnit = "c";
  if (window.ApexAppearance && window.ApexAppearance.onTempUnit) {
    window.ApexAppearance.onTempUnit(function (unit) {
      // appearance.js already rejects anything else, but this is the last step
      // before the number reaches a panel: a unit that got through here would
      // take the Celsius branch and print a Fahrenheit label beside it.
      if (unit === "c" || unit === "f") tempUnit = unit;
    });
  }

  /**
   * A Celsius reading as the driver's chosen unit, as a NUMBER — or null when
   * there is no reading.
   *
   * Null rather than a dash so callers can round it themselves: the canvas
   * Speedo designs draw the number and its unit in different type, and the
   * tread strip prints three of them into cells barely wide enough for one.
   *
   * The `has()` guard is what keeps -1 out: the UNKNOWN sentinel converted to
   * Fahrenheit is 30.2, which prints as a perfectly plausible cold tyre.
   */
  function tempValue(c) {
    if (!has(c)) return null;
    return tempUnit === "f" ? c * 1.8 + 32 : c;
  }

  /**
   * A temperature DIFFERENCE in Celsius as the driver's unit — a window width,
   * a spread, a "6 degrees over". Scaled without the +32 offset, because 8 C
   * of margin is 14.4 F of margin and not 46.4 of anything.
   */
  function tempSpan(dC) {
    if (typeof dC !== "number") return null;
    return tempUnit === "f" ? dC * 1.8 : dC;
  }

  /** A temperature as an integer with a degree suffix: `"96°"` / `"205°"`. */
  function temp(c) {
    var v = tempValue(c);
    return v === null ? "—" : Math.round(v) + "°";
  }

  /**
   * The same, one decimal finer — but only in Celsius.
   *
   * A tenth of a degree Fahrenheit is below anything a driver acts on, and the
   * extra glyph is not free: these land in the tyre widget's corner cells,
   * which were sized for `96.4°` and would have to fit `205.5°`. Rounding the
   * Fahrenheit reading keeps the cell the same width and loses nothing.
   */
  function temp1(c) {
    var v = tempValue(c);
    if (v === null) return "—";
    return (tempUnit === "f" ? String(Math.round(v)) : v.toFixed(1)) + "°";
  }

  /** The driver's current unit as a bare label — `"°C"` or `"°F"`. */
  function tempUnitLabel() {
    return tempUnit === "f" ? "°F" : "°C";
  }

  var fmt = {
    UNKNOWN: UNKNOWN,
    speed: speed,
    speedFromMs: speedFromMs,
    speedValue: speedValue,
    speedUnitLabel: speedUnitLabel,
    has: has,
    lapTime: lapTime,
    gap: gap,
    delta: delta,
    relGap: relGap,
    temp: temp,
    temp1: temp1,
    tempValue: tempValue,
    tempSpan: tempSpan,
    tempUnitLabel: tempUnitLabel,
    liters: liters,
    intVal: intVal,
    pct: pct,
    gearLabel: gearLabel,
  };

  /* ------------------------------------------------------------------ */
  /*  Car-class identity — colour, short tag, full name                  */
  /* ------------------------------------------------------------------ */

  /**
   * What a class LOOKS like, in one place.
   *
   * This block existed as a verbatim copy in standings.js and in radar.js, which
   * is one edit away from the tower, the radar and the relative panel disagreeing
   * about which green is GT3 — and a colour that means one thing in one widget
   * and something else in the next is worse than no colour at all.
   *
   * Spellings are collapsed the way `src/telemetry/carClass.ts` collapses them
   * (upper-case, strip everything but letters and digits, then alias). The
   * provider already normalises what it sends, so this is belt and braces — but
   * fixtures, older builds and hand-made frames do not, and a class that hashes
   * to a random colour in one of those is a bug that only appears on stream.
   * That file's ALIASES table and this one are a deliberate mirror (a browser
   * IIFE cannot import a TS module): CHANGE ONE, CHANGE BOTH.
   */
  var CLASS_ALIASES = {
    HYPERCAR: "HYPERCAR", HYPER: "HYPERCAR", LMH: "HYPERCAR", LMDH: "HYPERCAR",
    GTP: "HYPERCAR", P1: "HYPERCAR", LMP1: "HYPERCAR",
    LMP2: "LMP2", P2: "LMP2",
    LMP2ELMS: "LMP2_ELMS", P2ELMS: "LMP2_ELMS",
    LMP3: "LMP3", P3: "LMP3",
    GTE: "GTE", LMGTE: "GTE", GTEPRO: "GTE", GTEAM: "GTE",
    GT3: "GT3", LMGT3: "GT3", GT3PRO: "GT3",
    GT4: "GT4", LMGT4: "GT4",
  };
  var KNOWN_CLASS_COLORS = {
    HYPERCAR: "#ff5470",
    LMP2: "#4f8bff",
    // The ELMS LMP2 is its own category in LMU, so it gets its own colour — a
    // lighter shade of the same blue rather than a new hue, because the two are
    // the same car in different trim and the tower should read that way.
    LMP2_ELMS: "#9dc0ff",
    LMP3: "#22d3ee",
    GTE: "#ffb020",
    GT3: "#35d07f",
    GT4: "#ffb020",
  };
  /**
   * The tag a driver already says out loud. THREE characters at most, and that
   * cap is a contract rather than a tidiness preference: the box it is drawn in
   * is sized for three glyphs and does not grow, so a fourth would either clip
   * or take width off the driver's name.
   */
  var KNOWN_CLASS_ABBREV = {
    HYPERCAR: "HY", LMP2: "P2", LMP2_ELMS: "P2E",
    LMP3: "P3", GTE: "GTE", GT3: "GT3", GT4: "GT4",
  };
  /**
   * Where the canonical key is not a name anyone would write down. Only the ELMS
   * LMP2 needs this: the key has to match what the provider and the lap database
   * send (`LMP2_ELMS`), and an underscore does not belong on a group header.
   */
  var KNOWN_CLASS_LABELS = { LMP2_ELMS: "LMP2 ELMS" };
  var CLASS_COLORS = ["#8b5cf6", "#22d3ee", "#ec4899", "#4f8bff", "#35d07f", "#ffb020"];

  // Null-prototype: a class label is arbitrary text from a mod, and "constructor"
  // is a string a mod is entirely free to use.
  var colorCache = Object.create(null);
  var abbrevCache = Object.create(null);

  function classKey(cls) {
    return String(cls).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function canonClass(cls) {
    var k = classKey(cls);
    return typeof CLASS_ALIASES[k] === "string" ? CLASS_ALIASES[k] : k;
  }

  /**
   * Stable display colour for a class. Known categories get an intuitive one;
   * anything else hashes to a fallback, so a mod class still gets a distinct
   * colour — the same one in every widget, and the same one next session.
   *
   * Memoised on the raw string the caller holds: this runs once per row per
   * frame in the tower and once per blip per frame in the radar.
   */
  function classColor(cls) {
    if (!cls) return "#6b7387";
    if (colorCache[cls]) return colorCache[cls];
    var canon = canonClass(cls);
    if (typeof KNOWN_CLASS_COLORS[canon] === "string") {
      return (colorCache[cls] = KNOWN_CLASS_COLORS[canon]);
    }
    var hash = 0;
    for (var i = 0; i < canon.length; i++) hash = (hash * 31 + canon.charCodeAt(i)) | 0;
    return (colorCache[cls] = CLASS_COLORS[Math.abs(hash) % CLASS_COLORS.length]);
  }

  /**
   * Short tag for a class — "GT3", "P2", "HY".
   *
   * An unknown category is DERIVED rather than left blank: a colour with no
   * letters beside it is exactly the puzzle the tag exists to remove. Initials
   * for a multi-word name ("Porsche Carrera Cup" → PCC), otherwise the first
   * three characters ("Clubsport" → CLU).
   */
  function classAbbrev(cls) {
    if (!cls) return "";
    if (abbrevCache[cls]) return abbrevCache[cls];
    var known = KNOWN_CLASS_ABBREV[canonClass(cls)];
    if (typeof known === "string") return (abbrevCache[cls] = known);
    var words = String(cls).toUpperCase().split(/[^A-Z0-9]+/);
    var kept = [];
    for (var i = 0; i < words.length; i++) if (words[i]) kept.push(words[i]);
    var tag;
    if (!kept.length) tag = "?";
    else if (kept[0].length <= 3) tag = kept[0];
    else if (kept.length > 1) {
      tag = "";
      for (var j = 0; j < kept.length && tag.length < 3; j++) tag += kept[j].charAt(0);
    } else tag = kept[0].slice(0, 3);
    return (abbrevCache[cls] = tag);
  }

  /**
   * Full name, for a group header or a tooltip. An unknown class keeps its own
   * spacing and spelling ("TCR Cup" → "TCR CUP") — the stripped key above is a
   * lookup key, not something to show anybody.
   */
  function classLabel(cls) {
    if (!cls) return "OTHER";
    var alias = CLASS_ALIASES[classKey(cls)];
    if (typeof alias !== "string") return String(cls).toUpperCase();
    return typeof KNOWN_CLASS_LABELS[alias] === "string" ? KNOWN_CLASS_LABELS[alias] : alias;
  }

  /**
   * Tooltip names for the driver profile badges (`StandingEntry.driverBadge`),
   * matching what LMU's own UI calls each one. Shared here so the tower and the
   * relative panel cannot drift apart on what a badge means. An id outside the
   * table (a badge added in a game patch) falls back to the raw id — the
   * artwork request will 404 and hide the element anyway, so the label is only
   * ever read alongside art we actually have.
   */
  var DRIVER_BADGE_LABELS = {
    "sr-noob": "Rookie",
    "sr-rookie": "Rookie",
    "sr-probation": "Probation",
    "sr-warning": "Warning — high recent contact",
    "sr-danger": "Warning — under review for contact",
    "sr-clean": "Good Driver",
    "sr-saint": "Trusted Racer",
    s397: "Studio 397 staff",
    "content-creator": "Content creator",
    "irl-driver": "Real-world racing driver",
    "early-access": "Early access player",
    "test-driver": "LMU test driver",
  };

  /** Human name for a driver badge id, for tooltips. */
  function driverBadgeLabel(badge) {
    if (!badge) return "";
    return DRIVER_BADGE_LABELS[badge] || String(badge);
  }

  /**
   * Writes a DR/SR rank shield (`{rank, tier}` from the frame) into its <img>:
   * artwork, tooltip and visibility in one guarded write, so the tower and the
   * relative panel cannot drift on how a rank is drawn. Cached on the
   * "<Rank><tier>" identity — a frame that changes nothing costs one string
   * compare per badge. `kind` is "dr" or "sr": it picks the artwork set and
   * the tooltip prefix. A malformed rank (unknown id → 404) is hidden by the
   * img's own onerror, same as every other badge.
   */
  function applyRankBadge(img, cache, key, kind, rank) {
    var id = rank && rank.rank && typeof rank.tier === "number" ? rank.rank + rank.tier : "";
    if (cache[key] === id) return;
    cache[key] = id;
    if (id) {
      img.src = "/rankbadges/" + kind + "/" + encodeURIComponent(id) + ".svg";
      img.title =
        (kind === "dr" ? "Driver Rating: " : "Safety Rating: ") + rank.rank + " " + rank.tier;
      img.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
  }

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
   *
   * 240 ms, not the 120 it started at: the hold is the part of the bloom that
   * can actually be caught by an eye that is on the track and only sweeps the
   * overlay between corners. At 120 ms a change could arrive and be most of the
   * way faded before the glance landed, which made the signal a matter of luck.
   */
  var GLOW_HOLD_MS = 240;

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
    // Class identity, shared so the tower, the relative panel and the radar
    // cannot drift apart on what a class looks like or what it is called.
    classColor: classColor,
    classAbbrev: classAbbrev,
    classLabel: classLabel,
    driverBadgeLabel: driverBadgeLabel,
    applyRankBadge: applyRankBadge,
    // …and likewise for the consequence indicator, which the Track Limits
    // widget and the MFD both announce.
    consequenceMs: CONSEQUENCE_MS,
    consequenceFresh: consequenceFresh,
    servedFresh: servedFresh,
    penaltyCount: penaltyCount,
    penaltyText: penaltyText,
    penaltyLabel: penaltyLabel,
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
   * `msSinceCharge` — the two are adjacent on the frame, identically typed, and
   * mean very different things.
   */
  function consequenceFresh(trackLimits) {
    if (!trackLimits) return false;
    var since = trackLimits.msSincePenalty;
    return typeof since === "number" && since >= 0 && since < CONSEQUENCE_MS;
  }

  /**
   * How long "SERVED" is announced for after the sim discharges a penalty.
   *
   * Longer than the arrival window above, because it answers a question the
   * driver is actively asking rather than telling them something they already
   * felt. Leaving the pit lane unsure whether a drive-through counted is how a
   * driver goes round again to be safe and pays for it twice, and the exit is
   * busy enough that a four-second confirmation can be missed entirely.
   */
  var SERVED_MS = 8000;

  /** Whether a penalty was discharged within the announce window. */
  function servedFresh(trackLimits) {
    if (!trackLimits) return false;
    var since = trackLimits.msSinceServed;
    return typeof since === "number" && since >= 0 && since < SERVED_MS;
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
   * The penalty in as many words as the sim has given us: its kind when the pit
   * menu named one ("STOP/GO"), the bare count when it did not.
   *
   * The count is never dropped even when the kind is known — with two
   * outstanding, "STOP/GO" alone would read as one thing to serve.
   */
  function penaltyLabel(trackLimits, n) {
    var kind = trackLimits && trackLimits.penaltyType;
    if (!kind) return penaltyText(n);
    return n > 1 ? n + "× " + kind : kind;
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

  /** Seconds -> "H:MM:SS" (drops the hour when zero). */
  function clockText(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    var ss = String(s).padStart(2, "0");
    return (h > 0 ? h + ":" : "") + mm + ":" + ss;
  }

  /**
   * Where in the run-up we are. The grid and the formation lap are worth calling
   * out; the garage is the default and says nothing extra.
   */
  var PHASE_NOTE = {
    countdown: "ON THE GRID",
    gridwalk: "ON THE GRID",
    formation: "FORMATION LAP",
  };

  /** "28 LAPS LEFT" / "1 LAP LEFT", tilde-prefixed when it is an estimate. */
  function lapsLeftText(n, estimated) {
    return (estimated ? "~" : "") + n + (n === 1 ? " LAP LEFT" : " LAPS LEFT");
  }

  /**
   * How many laps the DRIVER has completed this session, read from their own
   * standings row — the one place every provider fills it in.
   *
   * Not `session.currentLap`, which is the OVERALL leader's lap. Those two are
   * the same number only for a car on the lead lap of a single-class race: in a
   * multiclass field the leader is a Hypercar and in practice a dozen cars are
   * circulating on their own schedules. Every counter a driver reads as "my
   * lap" is fed from here — see `sessionHeadline`.
   *
   * @param {object} frame  A telemetry frame.
   * @returns {number} Laps completed, or `-1` when there is no player row at all
   *   (a spectator feed, a replay, or the frames before the field lands).
   */
  function playerLapsCompleted(frame) {
    var list = frame && frame.standings;
    if (!list) return UNKNOWN;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].isPlayer) {
        var n = list[i].lapsCompleted;
        // A player row with no lap count yet is still a player: they have
        // completed nothing, which is 0 laps rather than "unknown".
        return has(n) ? Math.max(0, Math.floor(n)) : 0;
      }
    }
    return UNKNOWN;
  }

  /**
   * The one-line answer to *where are we in this session* — the headline every
   * panel carrying a session strip shows.
   *
   * Three shapes, because three different questions are being asked:
   *
   * - **Not started yet.** There is no lap 1 and no clock running down, so a
   *   counter reads as broken. Name the session and its FULL booked length (never
   *   the remaining clock, which pre-green is the countdown to the start).
   * - **A lap limit exists.** Count laps: which one is running, out of how many,
   *   and how many are still to come. Those last two are not the same fact —
   *   "LAP 12/40" is where the race is, "29 LAPS LEFT" is what has to be fuelled
   *   and tyred for — and asking a driver to subtract mid-corner is asking for
   *   the wrong answer.
   * - **Timed, no lap limit.** A race still counts laps, with the laps-to-go
   *   estimated from the clock and the leader's pace (all LMU gives us).
   *   Practice and qualifying have no total to count towards, so the counter
   *   there is the driver's OWN tally — laps completed, counting up, "LAP 1"
   *   once the first one is in the books. It is a different question from the
   *   race counter ("how much running have I done" rather than "where is the
   *   race up to") but it belongs in the same place, because it is the thing a
   *   driver looks at that corner of the panel to find out. The session's name
   *   moves to the note beside it rather than being dropped.
   *
   * @param {object} session  `frame.session` (SessionState).
   * @param {number} [lapsDone]  Laps the driver has completed, from
   *   {@link playerLapsCompleted}. Drives the lap counter in EVERY session type:
   *   the counter is always the driver's own lap, never the leader's. `-1` or
   *   omitted falls back to `session.currentLap` in a race (a spectator feed or
   *   replay, where there is no player to count for) and to naming the session
   *   in practice/qualifying.
   * @returns {{primary: string, clock: string, note: string, urgent: boolean}}
   *   `clock`/`note` are `""` when they have nothing to say and should be hidden.
   */
  function sessionHeadline(session, lapsDone) {
    if (!session) return { primary: "", clock: "", note: "", urgent: false };

    if (session.notStarted) {
      return {
        primary: sessionLabel(session.type),
        clock: sessionLength(session),
        note: PHASE_NOTE[session.phase] || "",
        urgent: false,
      };
    }

    var cur = session.currentLap;
    var tot = session.totalLaps;
    // The counter and the note answer two different questions and are counted
    // off two different cars.
    //
    //   - "LAP n" is the driver's OWN lap, the one they are on right now:
    //     their laps completed plus the one in progress. It used to be
    //     `session.currentLap`, which is the OVERALL leader's — in a multiclass
    //     LMU race always a Hypercar's, so a GT3 running its ninth lap was told
    //     it was on lap twelve. That is the one number on the panel a driver
    //     has no way to sanity-check, and it was simply somebody else's.
    //   - "N LAPS LEFT" is counted off the leader of the driver's OWN class
    //     (`session.classLeaderLap`), because the flag falls on the leader, not
    //     on them: a car two laps down does not get two extra laps to run.
    //
    // Which means the two do not have to add up to `tot`, and for a lapped car
    // they will not — that is the arithmetic of being lapped, not a bug.
    var myLap = has(lapsDone) ? Math.max(0, Math.round(lapsDone)) + 1 : cur;
    // The class leader, falling back to the overall leader on a feed that has
    // no player row or no class for them (spectating, a replay, an unknown mod
    // class). Never falls back to the driver's own lap: counting THEIR laps
    // left off THEIR position is what over-fuels a lapped car.
    var leadLap = has(session.classLeaderLap) ? session.classLeaderLap : cur;

    if (has(tot) && tot > 0) {
      // A lap-limited session has no clock worth showing — it ends on a lap, and a
      // countdown next to a lap counter invites planning against the wrong one.
      //
      // Laps left INCLUDES the lap being run: on lap 40 of 40 there is 1 to go,
      // and on lap 12 of 40 there are 29 still to drive.
      //
      // Two ways to get there, and which one answered decides whether the number
      // wears a `~`:
      //
      //   - The provider's PREDICTION, when it has one. A 40-lap race is 40 laps
      //     for the car winning it; everyone else runs for the same length of
      //     TIME and covers what their own pace covers. At Sebring a Hypercar
      //     laps 12 s quicker than a GT3, so over a leader's last 29 laps a GT3
      //     completes about 26 — and it is published only when it genuinely is
      //     a guess (telemetry/lapsToFlag), which is what earns the tilde.
      //   - Otherwise the exact subtraction off the driver's CLASS leader, which
      //     is what a car in the leading class has always been shown, and is not
      //     hedged because it is not a guess.
      var pred = session.lapsRemaining;
      var left = has(leadLap) && leadLap > 0 ? Math.max(0, tot - (leadLap - 1)) : 0;
      var note =
        has(pred) && pred > 0
          ? lapsLeftText(Math.round(pred), true)
          : left > 0
            ? lapsLeftText(left, false)
            : "";
      // Clamped so taking the chequered flag reads "LAP 40/40" rather than
      // rolling over to 41/40 for the lap home.
      var shown = has(myLap) ? Math.min(myLap, tot) : myLap;
      return {
        primary: "LAP " + intVal(shown) + "/" + tot,
        clock: "",
        note: note,
        urgent: false,
      };
    }

    var rem = session.timeRemainingSec;
    var clock = has(rem) && rem > 0 ? clockText(rem) : "";
    // Inside the final minute the clock is the whole story; it flashes for itself.
    var urgent = clock !== "" && rem <= 60;

    if (session.type !== "race") {
      // The driver's own tally, in the slot the race counter uses. "LAP 0" until
      // the first one is completed — an honest zero, and it keeps the counter in
      // place from the moment the session goes green rather than having the
      // strip re-shuffle itself as you cross the line for the first time.
      if (has(lapsDone)) {
        return {
          primary: "LAP " + Math.max(0, Math.round(lapsDone)),
          clock: clock,
          note: sessionLabel(session.type),
          urgent: urgent,
        };
      }
      // Nobody to count for — spectating, or a replay. Name the session instead.
      return { primary: sessionLabel(session.type), clock: clock, note: "", urgent: urgent };
    }

    // Timed race. The counter is the driver's own lap, as above; the estimate is
    // the provider's, and is the same prediction the lap-limited branch prefers
    // — the clock divided by the driver's CLASS pace rather than the overall
    // leader's (telemetry/lapsToFlag, SessionState.lapsRemaining).
    var est = session.lapsRemaining;
    return {
      primary: "LAP " + intVal(myLap),
      clock: clock,
      note: has(est) && est > 0 ? lapsLeftText(Math.round(est), true) : "",
      urgent: urgent,
    };
  }

  /* --------------------- the standings header's position ------------------- */

  /**
   * Which position the standings header reports: the driver's place in the whole
   * field (the default, and what the panel has always shown) or in their own
   * class.
   *
   * In a multiclass race the overall number is the one nobody is racing for — a
   * GT3 running 35th of 38 can be leading its class — and the header saying 35
   * is then the only line on the panel that disagrees with the tower under it,
   * where the rows already count in class. Overall stays the default because a
   * single-class field is the common case and both readings are identical there.
   *
   * Delivered on the appearance channel with the rest of the standings view, so
   * changing it retunes the header live; an OBS source pins its own with
   * `?standings=pos=class`, on the same terms standings.js pins the composition.
   */
  var posMode = "overall";
  var posPinned = false;
  (function () {
    try {
      var raw = (new URLSearchParams(window.location.search).get("standings") || "")
        .trim()
        .toLowerCase();
      // Any `?standings=` at all pins this too, exactly as it pins the tower's
      // composition — a source set up for a broadcast must not change because
      // the operator changed the app's setting for their own screen.
      if (!raw) return;
      posPinned = true;
      var parts = raw.split(",");
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].split("=");
        if ((kv[0] || "").trim() !== "pos") continue;
        posMode = (kv[1] || "").trim() === "class" ? "class" : "overall";
      }
    } catch (e) {
      /* no URLSearchParams / no location — keep the default */
    }
  })();
  if (window.ApexAppearance && window.ApexAppearance.onStandings) {
    window.ApexAppearance.onStandings(function (next) {
      if (posPinned || !next) return;
      // Tested for 'class' rather than against 'overall' so a view arriving
      // without the field — an older config, a server not yet updated — lands
      // on the default rather than silently on the other mode.
      posMode = next.pos === "class" ? "class" : "overall";
    });
  }

  /** The driver's own standings row, or null when the field has no player in it. */
  function playerRow(frame) {
    var list = frame && frame.standings;
    if (!list || !list.length) return null;
    // The flag first, across the WHOLE list, and only then the slot id: the two
    // are filled by different providers, and a list where both are available
    // must not depend on which of the two rows happens to come first.
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].isPlayer) return list[i];
    }
    var slot = frame.player ? frame.player.slotId : UNKNOWN;
    if (!has(slot)) return null;
    for (var j = 0; j < list.length; j++) {
      if (list[j] && list[j].slotId === slot) return list[j];
    }
    return null;
  }

  /**
   * What the standings header reports — `"35 / 38"`, or `"GT3 10 / 13"` when the
   * operator asked for the class reading.
   *
   * The class figure carries its class tag because without it the header is two
   * numbers that changed meaning silently; with it, it says the same thing the
   * subheader below it does. Cars are counted by the RAW `carClass` string, the
   * same key the tower groups on, so the header and the "13 CARS" beside the
   * class name can never disagree.
   *
   * Falls back to the overall reading whenever the class one cannot be told
   * honestly (no player row yet, a sim that publishes no class, a class position
   * the provider left out) — a header reading "— / —" mid-race is worse than one
   * answering a slightly different question.
   *
   * @param {object} frame  A telemetry frame.
   * @param {string} [mode]  `'class'` or `'overall'`; the live setting by default.
   * @returns {string} The header text.
   */
  function positionMeta(frame, mode) {
    var overall = intVal(frame.player.position) + " / " + intVal(frame.session.numCars);
    if ((mode || posMode) !== "class") return overall;
    var me = playerRow(frame);
    if (!me || !me.carClass || !has(me.classPosition) || me.classPosition <= 0) return overall;
    var total = 0;
    for (var i = 0; i < frame.standings.length; i++) {
      if (frame.standings[i] && frame.standings[i].carClass === me.carClass) total++;
    }
    // A class of one is the whole field under another name; the tag alone would
    // be noise, and "1 / 1" is not news either — say what the field says.
    if (total <= 1) return overall;
    return classAbbrev(me.carClass) + " " + me.classPosition + " / " + total;
  }

  function updateSessionMeta(frame) {
    // Standings header: position / field size, or the driver's class position
    // when they asked for it. Tier 1 and glow-eligible — your own position
    // changing is the single most consequential discrete event in a race, and it
    // is the one the driver most often misses while driving.
    var s = document.querySelector('#widget-standings [data-role="session"]');
    if (s && frame.player && frame.session) {
      if (!s.classList.contains("is-crit")) s.classList.add("is-crit");
      crit(s, positionMeta(frame));
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
    // Default port/path match src/server/config.ts (httpPort 17080, wsPath /ws).
    var port = params.get("port") || window.location.port || "17080";
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
   * The audio cue is fired from HERE rather than from the widgets, for the same
   * reason the bar itself is shared: an alarm the driver can hear but not see —
   * or see but not hear — is an alarm they have to stop and reconcile. Asking
   * for the cue on every active frame is deliberate and safe; ApexAudio's
   * per-cue rate limit owns how often it is actually heard.
   *
   * @param {Element} parent - Widget body; the bar inserts itself at the top.
   * @param {string} [cueName] - ApexAudio cue to sound while the bar is up.
   * @returns {function(boolean, string): void} `set(active, text)`, cheap to
   *   call every frame — it only touches the DOM when something actually moved.
   */
  function alarmBar(parent, cueName) {
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
        if (cueName && window.ApexAudio) window.ApexAudio.cue(cueName);
      } else if (on) {
        on = false;
        el.hidden = true;
      }
    };
  }

  /**
   * The session strip: how much of this session is left, across the top of a
   * panel.
   *
   * Shared rather than built per widget for the same reason the alarm bar is.
   * Two panels carry it — the standings tower and the fuel calculator — and they
   * are read together: the tower says the race is on lap 12 of 40, the fuel
   * panel says the tank is good for 14 laps, and the whole decision is the
   * subtraction between them. Two hand-rolled copies of "how many laps are
   * left" that could disagree by one would make that subtraction worthless.
   *
   * Everything shown comes from {@link sessionHeadline}, so what the strip says
   * is decided in one place; this only draws it.
   *
   * Glow: the lap counter and the laps-left note step a few dozen times in a
   * race and are exactly what a bloom is for. The clock deliberately does NOT
   * glow — it changes every second, and a bloom on it would strobe from lights
   * to flag. Its own urgency signal is the red flash inside the final minute.
   *
   * @param {Element} parent  Widget body; the strip appends itself.
   * @param {{flush?: boolean, small?: boolean}} [opts]
   *   `flush` for a padding-less panel body, where the strip supplies its own
   *   header padding and rule (the standings tower). `small` drops the readouts
   *   a tier, for a panel too narrow to carry Tier 1 across three fields
   *   (the 400px fuel panel, which already has its own Tier 1 stats below).
   * @returns {function(object, number=): void} `set(session, lapsDone)`, cheap to
   *   call every frame. `lapsDone` is {@link playerLapsCompleted} of the frame —
   *   the driver's own lap tally, and what the counter shows in every session
   *   type. The laps-left note beside it is counted off the driver's CLASS
   *   leader instead; {@link sessionHeadline} owns why they differ.
   */
  function sessionStrip(parent, opts) {
    opts = opts || {};
    var el = document.createElement("div");
    el.className =
      "sessionstrip" +
      (opts.flush ? " sessionstrip--flush" : " sessionstrip--inset") +
      (opts.small ? " sessionstrip--sm" : "");

    var primaryEl = document.createElement("span");
    primaryEl.className = "sessionstrip__primary is-crit";
    primaryEl.textContent = "LAP —";
    var clockEl = document.createElement("span");
    clockEl.className = "sessionstrip__clock";
    clockEl.hidden = true;
    var noteEl = document.createElement("span");
    noteEl.className = "sessionstrip__note is-crit";
    noteEl.hidden = true;

    el.appendChild(primaryEl);
    el.appendChild(clockEl);
    el.appendChild(noteEl);
    parent.appendChild(el);

    return function set(session, lapsDone) {
      if (!session) return;
      var h = sessionHeadline(session, lapsDone);
      crit(primaryEl, h.primary);

      if (h.clock) {
        if (clockEl.textContent !== h.clock) clockEl.textContent = h.clock;
        if (clockEl.hidden) clockEl.hidden = false;
        if (clockEl.classList.contains("is-urgent") !== h.urgent)
          clockEl.classList.toggle("is-urgent", h.urgent);
      } else if (!clockEl.hidden) {
        clockEl.hidden = true;
      }

      if (h.note) {
        crit(noteEl, h.note);
        if (noteEl.hidden) noteEl.hidden = false;
      } else if (!noteEl.hidden) {
        noteEl.hidden = true;
      }
    };
  }

  // Expose the runtime for widget modules.
  window.ApexOverlay = {
    registerWidget: registerWidget,
    fmt: fmt,
    alarmBar: alarmBar,
    sessionStrip: sessionStrip,
    // The strip's text as data, for anything that wants the wording without the
    // markup — and so the rule about which sessions count laps can be tested
    // headlessly rather than by squinting at a panel.
    sessionHeadline: sessionHeadline,
    // The driver's own lap tally, for the panels that feed the strip.
    playerLapsCompleted: playerLapsCompleted,
    // The standings header's position reading, as data — so the rule about when
    // the class figure can be told honestly is testable headlessly rather than
    // by putting a multiclass field on screen and squinting at one corner of it.
    positionMeta: positionMeta,
    // Also on the module surface, not just on the update ctx: standings and
    // radar reach for the colour at module-eval time (they are deferred scripts
    // that run after this one), and a widget drawing to a canvas has no ctx in
    // scope where it needs it.
    classColor: classColor,
    classAbbrev: classAbbrev,
    classLabel: classLabel,
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
