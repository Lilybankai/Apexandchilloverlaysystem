/**
 * widgets/speedo.js — the driver's cluster: speed, revs, gear and the numbers
 * you change your driving for.
 * -----------------------------------------------------------------------------
 * One panel carrying everything a driver reads on a straight, arranged so the
 * eye lands on the biggest thing first and never has to hunt:
 *
 *   • a segmented REV BAR across the top, green through amber to red, with the
 *     shift band flashing at the limiter;
 *   • the BACKGROUND ILLUMINATION — the panel lights from the floor upward as
 *     the revs rise, in the same colour the bar is showing, so the shift point
 *     is readable in peripheral vision with the eyes still on the braking zone.
 *     This is the widget's whole reason for existing: a number you have to look
 *     at is no use at 300 km/h, and a panel that turns red underneath you is;
 *   • SPEED and GEAR in the middle, the two Tier-1 readouts;
 *   • FUEL and VIRTUAL ENERGY on the left, PROJECTED LAP and the HYBRID BATTERY
 *     on the right — the four budgets, two of distance and two of pace;
 *   • a chip strip: pit limiter, and the TC map with its two sub-settings
 *     (power cut and slip) plus ABS.
 *
 * ## Why it draws to a canvas
 * The illumination and the rev bar change every single frame, and doing that in
 * CSS means writing a custom property that a `background-image` resolves
 * through — a style recalc plus a repaint of a full-panel element, thirty times
 * a second, for the life of the stream. On a canvas it is two fills into a
 * bitmap the size of the panel, which is the same bargain `radar`, `motion` and
 * `trackmap` already take. The readouts stay in the DOM on top, where they get
 * the house change-glow and cost nothing on the frames they don't move.
 *
 * ## Why it runs at the full broadcast rate (throttleMs 0)
 * A rev counter is a rate instrument: at the 250 ms every other widget uses, the
 * bar advances in eight visible steps between upshifts and the shift light lands
 * a quarter of a second late, which on this widget is not a cosmetic problem —
 * it is the widget being wrong about the only moment it exists for.
 *
 * ## What it does NOT invent
 * Three readouts are optional on the wire and are **hidden entirely** rather
 * than shown empty when their block is absent: virtual energy (cars and series
 * that don't run an energy budget), the battery (see `HybridState` — a GT3 has
 * no hybrid, and an absent block is not a flat one), and the limiter chip (a
 * feed with no shared memory cannot see the limiter, and a chip that
 * permanently reads OFF is a claim we can't make). The TC chips likewise come
 * from `frame.mfd`, which is LMU-only.
 *
 * Speed units are NOT this widget's business: `fmt.speedValue` /
 * `fmt.speedUnitLabel` do the conversion, so the cluster, both pedal panels and
 * the motion widget can never disagree about what 168 means. `?units=mph` on
 * the Browser Source URL, or the app's own setting, retunes all of them at once.
 *
 * Browser Source URL options:
 *   ?bg=on|off       the background illumination (default on)
 *   ?rev=on|off      the segmented rev bar (default on)
 */
(function () {
  "use strict";

  /* ---------------------------------------------------------------------- */
  /*  The rev ramp — pure, and exposed for the headless test                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Where the colour stops sit on the rev range, as fractions of max RPM.
   *
   * These are the shift-light convention every real cluster uses, not free
   * choices: green while there is room, amber when the upshift is coming, red
   * when it is now, and a flashing band for "you are on the limiter and losing
   * time". The bands are fractions of the car's own `maxRpm`, so a Hypercar
   * revving to 9000 and a GT3 to 7200 light up at the same point in their own
   * range — which is what makes one widget work for both.
   */
  var BAND_AMBER = 0.8;
  var BAND_RED = 0.93;
  var BAND_SHIFT = 0.985;

  /* Ramp stops, matching the theme's own status tokens so this widget's green
   * and red mean what they mean everywhere else in the overlay. */
  var C_GREEN = [53, 208, 127]; /* --pos-gain  #35d07f */
  var C_AMBER = [255, 176, 32]; /* --warn      #ffb020 */
  var C_RED = [255, 84, 112]; /* --pos-loss  #ff5470 */

  /** Below this the ramp is flat green — a car off the throttle is not "cold". */
  var RAMP_GREEN_UNTIL = 0.55;

  /**
   * Revs as a fraction of the car's usable range, `0`..`1`.
   *
   * Returns 0 — not a guess — whenever either channel is missing or `maxRpm` is
   * implausible. An unknown rev limit divided into a real RPM would light the
   * panel red on a car that is idling.
   */
  function revFraction(rpm, maxRpm) {
    if (typeof rpm !== "number" || typeof maxRpm !== "number") return 0;
    if (!(rpm > 0) || !(maxRpm > 1000)) return 0;
    var f = rpm / maxRpm;
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  /** Which band a rev fraction is in: `low` | `amber` | `red` | `shift`. */
  function revStage(f) {
    if (f >= BAND_SHIFT) return "shift";
    if (f >= BAND_RED) return "red";
    if (f >= BAND_AMBER) return "amber";
    return "low";
  }

  function mix(a, b, t) {
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }

  /**
   * The illumination colour for a rev fraction: green → amber → red.
   *
   * Continuous rather than three flat buckets, because the brief is a panel that
   * *gradually* changes: a driver watching the colour drift toward amber has
   * more information than one waiting for it to snap.
   */
  function revRgb(f) {
    if (f <= RAMP_GREEN_UNTIL) return C_GREEN;
    if (f <= BAND_RED) {
      return mix(C_GREEN, C_AMBER, (f - RAMP_GREEN_UNTIL) / (BAND_RED - RAMP_GREEN_UNTIL));
    }
    return mix(C_AMBER, C_RED, (f - BAND_RED) / (1 - BAND_RED));
  }

  function rgba(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }

  /**
   * The pure half of the widget, exposed so the ramp can be exercised headlessly
   * (`scripts/test-speedo.js`) rather than by squinting at a running sim. Same
   * bargain `ApexAudio` takes for the cue scheduler: the part that has to be
   * right about a threshold is reachable without a canvas.
   */
  window.ApexSpeedo = {
    BAND_AMBER: BAND_AMBER,
    BAND_RED: BAND_RED,
    BAND_SHIFT: BAND_SHIFT,
    revFraction: revFraction,
    revStage: revStage,
    revRgb: revRgb,
  };

  /* ---------------------------------------------------------------------- */
  /*  Module state                                                           */
  /* ---------------------------------------------------------------------- */

  /** Segments in the rev bar. Enough to read as a bar, few enough to count. */
  var SEGMENTS = 32;
  /** Shift-light flash period, ms. Fast enough to be urgent, slow enough to see. */
  var FLASH_MS = 110;
  /** Height of the rev bar strip at the top of the panel, CSS px. */
  var BAR_H = 10;

  var showBg = true;
  var showRev = true;

  var canvas, gctx, dpr = 1;
  var cssW = 0, cssH = 0;
  var sizeTick = 0;

  var elSpeed, elUnit, elGear, elRpm;
  var elFuel, elFuelSub, elVeWrap, elVe, elVeSub;
  var elProj, elProjDelta, elBattWrap, elBattFill, elBattVal, elBattFlow;
  var elChips, chipLimiter, chipTc, chipCut, chipSlip, chipAbs;
  var headerMeta;
  var cache = {};

  /** Live rev fraction + stage, written by update() and read by the draw. */
  var revF = 0;
  var revStageNow = "low";

  /* ---------------------------------------------------------------------- */
  /*  Canvas                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Matches the canvas bitmap to the element's CSS size. Same contract as
   * `motion.js`: idempotent, so a ResizeObserver watching the element cannot
   * feed itself. The canvas is stretched over the panel by CSS (`inset: 0`), so
   * both dimensions come from the layout rather than being assigned here.
   */
  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth || 0;
    var h = canvas.clientHeight || 0;
    if (!w || !h) return;
    var d = window.devicePixelRatio || 1;
    var bw = Math.round(w * d);
    var bh = Math.round(h * d);
    if (bw === canvas.width && bh === canvas.height) return;
    cssW = w;
    cssH = h;
    dpr = d;
    canvas.width = bw;
    canvas.height = bh;
    if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function watchSize(el) {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(sizeCanvas).observe(el);
    }
    window.addEventListener("resize", sizeCanvas, { passive: true });
  }

  function draw() {
    if (!gctx || !cssW || !cssH) return;
    gctx.clearRect(0, 0, cssW, cssH);

    var rgb = revRgb(revF);
    var flashing = revStageNow === "shift" && Math.floor(Date.now() / FLASH_MS) % 2 === 0;

    if (showBg) drawGlow(rgb, flashing);
    if (showRev) drawBar(flashing);
  }

  /**
   * The illumination: a wash rising from the floor of the panel to a height set
   * by the revs, fading out at its top edge.
   *
   * Drawn as one gradient-filled rect rather than a full-panel fill with moving
   * colour stops, so at low revs the work is proportionally small — an idling
   * car costs a sliver at the bottom of the bitmap, not a full-panel composite.
   */
  function drawGlow(rgb, flashing) {
    if (revF <= 0.001) return;
    var top = cssH * (1 - revF);
    var g = gctx.createLinearGradient(0, cssH, 0, top);
    // Peak opacity climbs with the revs too, so the panel gets both taller and
    // brighter — the two cues reinforce rather than competing.
    var peak = 0.2 + 0.55 * revF;
    if (flashing) peak = 0.95;
    g.addColorStop(0, rgba(rgb, peak));
    g.addColorStop(0.45, rgba(rgb, peak * 0.42));
    g.addColorStop(1, rgba(rgb, 0));
    gctx.fillStyle = g;
    gctx.fillRect(0, top, cssW, cssH - top);
  }

  /**
   * The segmented rev bar. Each segment is coloured by ITS OWN position in the
   * range, not by the current revs, so the bar reads as a fixed scale that fills
   * up — which is what a shift light is. Colouring every lit segment with the
   * live colour would make the whole bar change hue at once and destroy the
   * "how much room is left" read that is the point of a bar.
   */
  function drawBar(flashing) {
    var gap = 2;
    var segW = (cssW - gap * (SEGMENTS - 1)) / SEGMENTS;
    if (segW <= 0) return;
    for (var i = 0; i < SEGMENTS; i++) {
      var at = (i + 1) / SEGMENTS;
      var lit = revF >= at - 1 / SEGMENTS / 2;
      var x = i * (segW + gap);
      if (lit) {
        gctx.fillStyle = flashing && at >= BAND_RED ? "#ffffff" : rgba(revRgb(at), 0.95);
      } else {
        // Unlit segments stay faintly visible so the scale is readable at idle
        // and the bar doesn't appear to grow out of nothing.
        gctx.fillStyle = "rgba(255,255,255,0.07)";
      }
      gctx.fillRect(x, 0, segW, BAR_H);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Markup                                                                 */
  /* ---------------------------------------------------------------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /** One label/value/sub stack, as used by the budget readouts. */
  function stat(parent, label) {
    var wrap = el("div", "speedo__stat");
    wrap.appendChild(el("span", "speedo__stat-k", label));
    var v = el("span", "speedo__stat-v is-crit", "—");
    wrap.appendChild(v);
    var sub = el("span", "speedo__stat-sub", "");
    wrap.appendChild(sub);
    parent.appendChild(wrap);
    return { wrap: wrap, value: v, sub: sub };
  }

  function chip(parent, label) {
    var c = el("span", "speedo__chip is-crit", label);
    c.setAttribute("data-on", "false");
    parent.appendChild(c);
    return c;
  }

  function init(root, ctx) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";
    cache = {};

    var params = new URLSearchParams(window.location.search);
    var off = function (name) {
      var v = (params.get(name) || "").toLowerCase();
      return v === "off" || v === "0" || v === "false";
    };
    showBg = !off("bg");
    showRev = !off("rev");

    var wrap = el("div", "speedo");

    canvas = el("canvas", "speedo__bg");
    wrap.appendChild(canvas);

    var grid = el("div", "speedo__grid");

    /* --- left: the two distance budgets --- */
    var left = el("div", "speedo__side");
    var fuel = stat(left, "FUEL");
    elFuel = fuel.value;
    elFuelSub = fuel.sub;
    var ve = stat(left, "ENERGY");
    elVeWrap = ve.wrap;
    elVe = ve.value;
    elVeSub = ve.sub;
    elVeWrap.hidden = true;
    grid.appendChild(left);

    /* --- centre: the two Tier-1 readouts --- */
    var core = el("div", "speedo__core");
    var speedLine = el("div", "speedo__speed");
    elSpeed = el("span", "speedo__speed-v", "—");
    elUnit = el("small", "speedo__speed-u", ctx.fmt.speedUnitLabel().toUpperCase());
    speedLine.appendChild(elSpeed);
    speedLine.appendChild(elUnit);
    core.appendChild(speedLine);
    elRpm = el("div", "speedo__rpm", "— RPM");
    core.appendChild(elRpm);
    grid.appendChild(core);

    // The gear sits outside the centre column so it can be its own bordered
    // glyph against the illumination, the way a real cluster frames it.
    elGear = el("div", "speedo__gear is-crit", "—");
    grid.appendChild(elGear);

    /* --- right: pace, and the lap-scale energy budget --- */
    var right = el("div", "speedo__side speedo__side--r");
    var proj = stat(right, "PROJECTED");
    elProj = proj.value;
    elProjDelta = proj.sub;
    elProjDelta.className = "speedo__stat-sub speedo__delta";

    var batt = el("div", "speedo__stat");
    batt.appendChild(el("span", "speedo__stat-k", "BATTERY"));
    var battRow = el("div", "speedo__batt");
    var track = el("div", "speedo__batt-track");
    elBattFill = el("div", "speedo__batt-fill");
    track.appendChild(elBattFill);
    battRow.appendChild(track);
    elBattVal = el("span", "speedo__batt-v", "—");
    battRow.appendChild(elBattVal);
    batt.appendChild(battRow);
    elBattFlow = el("span", "speedo__stat-sub", "");
    batt.appendChild(elBattFlow);
    right.appendChild(batt);
    elBattWrap = batt;
    elBattWrap.hidden = true;
    grid.appendChild(right);

    wrap.appendChild(grid);

    /* --- chips --- */
    elChips = el("div", "speedo__chips");
    chipLimiter = chip(elChips, "LIMITER");
    // Its own class, not a positional selector: the chip strip's membership
    // changes with what the feed can see, so "the first chip" is not stably the
    // limiter and styling it that way would eventually paint TC cyan.
    chipLimiter.classList.add("is-limiter");
    chipLimiter.hidden = true;
    chipTc = chip(elChips, "TC —");
    chipCut = chip(elChips, "PWR —");
    chipSlip = chip(elChips, "SLIP —");
    chipAbs = chip(elChips, "ABS —");
    wrap.appendChild(elChips);

    mount.appendChild(wrap);

    gctx = canvas.getContext("2d");
    sizeCanvas();
    watchSize(canvas);
  }

  /* ---------------------------------------------------------------------- */
  /*  Update                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Cached plain write — for continuously drifting values, which must not glow. */
  function set(node, key, text) {
    if (!node) return;
    if (cache[key] === text) return;
    cache[key] = text;
    node.textContent = text;
  }

  function setHidden(node, key, hidden) {
    if (!node) return;
    if (cache[key] === hidden) return;
    cache[key] = hidden;
    node.hidden = hidden;
  }

  /**
   * One aid chip from the MFD block.
   *
   * The setting is discrete — the driver turned a dial — so it takes the change
   * glow through `crit`, which is exactly what that signal is for: the number
   * moved because someone moved it. `active` is the live intervention from the
   * pedals block and only lights the chip; it changes several times a corner and
   * would strobe if it were allowed to bloom.
   */
  function aidChip(node, ctx, label, aid, active) {
    if (!node) return;
    if (!aid) {
      setHidden(node, "hide-" + label, true);
      return;
    }
    setHidden(node, "hide-" + label, false);
    ctx.crit(node, label + " " + aid.value + "/" + aid.maxValue);
    var on = active === true;
    if (cache["on-" + label] !== on) {
      cache["on-" + label] = on;
      node.setAttribute("data-on", String(on));
    }
  }

  function findAid(mfd, key) {
    if (!mfd || !mfd.aids) return null;
    for (var i = 0; i < mfd.aids.length; i++) {
      if (mfd.aids[i].key === key) return mfd.aids[i];
    }
    return null;
  }

  function update(frame, ctx) {
    var p = frame.player;
    var fmt = ctx.fmt;

    // Re-check the bitmap periodically: ResizeObserver does not deliver while a
    // page is not producing frames, and an in-game widget can be dragged in
    // exactly that state. Same backstop motion.js keeps.
    if (++sizeTick % 30 === 0) sizeCanvas();

    /* --- revs: the panel's headline signal --- */
    revF = revFraction(p.rpm, p.maxRpm);
    revStageNow = revStage(revF);
    draw();

    /* --- speed + gear --- */
    // Unit and value both from the shared runtime, so this panel can never
    // disagree with the pedal traces about what the number means.
    set(elSpeed, "speed", fmt.speedValue(p.speedKph));
    set(elUnit, "unit", fmt.speedUnitLabel().toUpperCase());
    // Gear is discrete: every change is a shift, and a shift is news.
    ctx.crit(elGear, fmt.gearLabel(p.gear));
    ctx.critAttr(elGear, "data-rev", revStageNow);
    set(elRpm, "rpm", fmt.has(p.rpm) ? Math.round(p.rpm) + " RPM" : "— RPM");

    /* --- fuel + virtual energy --- */
    var f = frame.fuel || {};
    set(elFuel, "fuel", fmt.has(f.levelLiters) ? f.levelLiters.toFixed(1) + " L" : "—");
    // Laps left is a whole number that steps — the discrete half of a fuel read,
    // and the one worth announcing.
    ctx.crit(
      elFuelSub,
      fmt.has(f.lapsRemaining) ? "≈" + f.lapsRemaining.toFixed(1) + " LAPS" : "—",
    );

    var hasVe = typeof f.virtualEnergyPct === "number" && f.virtualEnergyPct >= 0;
    setHidden(elVeWrap, "ve", !hasVe);
    if (hasVe) {
      set(elVe, "vev", Math.round(f.virtualEnergyPct) + "%");
      ctx.crit(
        elVeSub,
        typeof f.virtualEnergyLapsRemaining === "number" && f.virtualEnergyLapsRemaining >= 0
          ? "≈" + f.virtualEnergyLapsRemaining.toFixed(1) + " LAPS"
          : "—",
      );
    }

    /* --- projected lap --- */
    var pd = p.paceDeltas;
    var proj = pd && fmt.has(pd.predictedLapSec) ? pd.predictedLapSec : -1;
    // Drifts continuously with the delta, so it is written plainly. Its SIGN is
    // the discrete part, and that is what carries the glow, below.
    set(elProj, "proj", proj >= 0 ? fmt.lapTime(proj) : "—");
    var d = pd && fmt.has(pd.tSession) ? pd.tSession : null;
    set(elProjDelta, "projd", d === null ? "—" : fmt.delta(d));
    ctx.critAttr(elProjDelta, "data-state", d === null ? "none" : d < 0 ? "up" : "down");

    /* --- hybrid battery --- */
    var hy = p.hybrid;
    setHidden(elBattWrap, "batt", !hy);
    if (hy) {
      var pctN = Math.round(hy.chargeFraction * 100);
      set(elBattVal, "battv", pctN + "%");
      var w = pctN + "%";
      if (cache.battw !== w) {
        cache.battw = w;
        elBattFill.style.width = w;
      }
      // Bucketed state, so the bar's colour changes on a threshold rather than
      // fading imperceptibly — and so crossing one blooms.
      ctx.critAttr(elBattFill, "data-state", pctN <= 15 ? "low" : pctN <= 40 ? "mid" : "ok");
      // Which way the charge is going. Only this says whether an emptying
      // battery is being spent or is about to come back.
      var t = hy.motorTorqueNm;
      var flow =
        typeof t !== "number" || t === -1 || Math.abs(t) < 5
          ? ""
          : t > 0
            ? "▲ DEPLOY"
            : "▼ HARVEST";
      set(elBattFlow, "flow", flow);
    }

    /* --- chips --- */
    // The limiter chip exists only when the feed can actually see the limiter —
    // `pit.limiterOn` is omitted, not defaulted, when the byte is unreadable.
    var limiter = p.pit ? p.pit.limiterOn : undefined;
    var hasLimiter = typeof limiter === "boolean";
    setHidden(chipLimiter, "lim", !hasLimiter);
    if (hasLimiter) ctx.critAttr(chipLimiter, "data-on", String(limiter));

    var mfd = frame.mfd;
    var ped = p.pedals || {};
    // Only the TC map and ABS light on live intervention. The power-cut and slip
    // chips are the map's two sub-settings, not systems of their own — lighting
    // all three off one `pedals.tc` would give a TC event three times the visual
    // weight of an ABS event and blur the line this widget is careful about
    // elsewhere: a SETTING is what the driver chose, an intervention is what
    // just happened to them.
    aidChip(chipTc, ctx, "TC", findAid(mfd, "tc"), (ped.tc || 0) > 0.02);
    aidChip(chipCut, ctx, "PWR", findAid(mfd, "tcCut"), false);
    aidChip(chipSlip, ctx, "SLIP", findAid(mfd, "tcSlip"), false);
    aidChip(chipAbs, ctx, "ABS", findAid(mfd, "abs"), (ped.abs || 0) > 0.02);

    /* --- header --- */
    if (headerMeta) {
      set(headerMeta, "meta", fmt.gearLabel(p.gear) + " · " + fmt.speed(p.speedKph));
    }
  }

  window.ApexOverlay.registerWidget("speedo", {
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
