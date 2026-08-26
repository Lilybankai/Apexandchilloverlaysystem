/**
 * widgets/speedo-lmp2.js — the LMP2 design for the speedo cluster: a Cosworth
 * CDU-style dash, all boxes and digits, modelled on the display an actual LMP2
 * runs (layout traced from the SimHub "LMP2 LMU" community dash).
 * -----------------------------------------------------------------------------
 * This file registers itself into `window.ApexSpeedoDesigns`; `speedo.js` owns
 * the widget and dispatches init/update here while the operator's Design
 * dropdown (or `?design=lmp2` on the URL) says so. It is a DESIGN of the same
 * widget, not a second widget: same shell, same feed, same slot in the panel —
 * only the face changes.
 *
 * ## What it is visually
 * A 1200×720 black plate. Big gear glyph centre-top in a navy box, flanked by
 * the lap-time box (left) and the live delta (right). A row of labelled
 * readouts under that, the four-corner tyre grid dead centre, budget/settings
 * boxes down the sides, throttle and brake strips along the floor, and
 * full-width banner states (PIT SPEED LIMITER / ENGINE STALL) over the middle.
 * Real CDUs are terse, boxy and mono-spaced; so is this. No rev bars and no
 * illumination wash — those belong to the Apex design.
 *
 * ## Where the SimHub dash's channels were NOT ours to copy
 * The donor dash reads SimHub-computed channels we do not carry, and the house
 * rule is that a widget never invents a reading:
 *   • per-lap fuel burn ("TLap/LLap Fuel") — our feed carries the rolling
 *     average (`fuel.perLapAvgLiters`), so ONE box says LAP FUEL and means
 *     that; the second slot carries virtual energy instead, which LMU's LMP2s
 *     actually race to;
 *   • brake temperatures — not in the frame at all, so the tyre grid shows
 *     pressure + tyre temperature (the donor's own alternate screen does the
 *     same);
 *   • engine mixture — LMU publishes no such aid; the MAP box shows the motor
 *     map when the car has one and hides otherwise;
 *   • "ENGINE OFF" — the feed has no ignition channel, so the stall banner
 *     (RPM below idle) is the only engine-state claim made.
 * Boxes whose channel is absent are HIDDEN, not shown empty — same contract as
 * the Apex design's energy/battery/limiter readouts.
 *
 * ## Geometry
 * Authored in the donor's own 1200×720 design box. A single frame element is
 * letterboxed inside the stage by JS (uniform scale, centred — the same
 * bargain speedo.js strikes for its canvas), and every box is positioned in
 * percentages OF THAT FRAME, which is safe precisely because the frame is
 * guaranteed the design's aspect whatever shape the wrapper is. Font sizes
 * ride on `--s` (the frame scale) so the type is locked to the plate.
 *
 * ## The BG slider
 * The plate and the coloured boxes are BACKGROUND and fade with
 * `--panel-alpha` (via color-mix in the stylesheet); the digits, the bars and
 * the banners are DATA and stay. At 0 the numbers float over the game, which
 * is what that slider means everywhere else in the overlay.
 */
(function () {
  "use strict";

  /** The donor dash's design box; every coordinate below is in these units. */
  var DW = 1200;
  var DH = 720;

  /** RPM below this reads as a stalling/stalled engine (donor's threshold). */
  var STALL_RPM = 2500;
  /** Pit-limiter banner turns red above this speed, km/h (donor's threshold). */
  var LIMITER_RED_KPH = 60;
  /** How long the last lap holds the lap-time box after the line, ms. */
  var LAP_HOLD_MS = 5000;
  /** How long a changed setting's box flashes green, ms (donor uses 1 s). */
  var FLASH_MS = 1000;

  /**
   * Which banner the dash shows, if any — pure, so the precedence rule is
   * testable headlessly.
   *
   * Stall outranks the limiter (the donor draws it above): a car stalling in
   * the pit lane needs "ENGINE STALL", not a reminder about the limiter it can
   * no longer speed under. Everything is suppressed while the sim says the
   * driver is in its menus (`session.onTrack === false`) — a parked car in the
   * garage screen is not "stalled"; an ABSENT onTrack means "assume at the
   * wheel", per the field's contract.
   */
  function bannerState(frame) {
    if (!frame || !frame.player) return null;
    var s = frame.session;
    if (s && s.onTrack === false) return null;
    var p = frame.player;
    var rpm = typeof p.rpm === "number" && p.rpm >= 0 ? p.rpm : null;
    if (rpm !== null && rpm < STALL_RPM) return { kind: "stall" };
    if (p.pit && p.pit.limiterOn === true) {
      return { kind: "limiter", over: typeof p.speedKph === "number" && p.speedKph > LIMITER_RED_KPH };
    }
    return null;
  }

  /* The pure parts, exposed for the headless test (scripts/test-speedo-lmp2). */
  window.ApexSpeedoLmp2 = {
    DESIGN: { w: DW, h: DH },
    STALL_RPM: STALL_RPM,
    LIMITER_RED_KPH: LIMITER_RED_KPH,
    bannerState: bannerState,
  };

  /* ---------------------------------------------------------------------- */
  /*  Module state                                                           */
  /* ---------------------------------------------------------------------- */

  var stageEl = null, frameEl = null;
  var lastW = 0, lastH = 0, tick = 0;
  var observer = null;
  var cache = {};

  var elGear, elLap, elLapV, elDelta, elDeltaV;
  var elLapFuel, elTank, elEnergyBox, elEnergyV, elSpeed;
  var elLapsRem, elTrkTemp, elLaps, elClutchL, elClutchR;
  var elBrakeFill, elThrotFill, elBanner, elBannerText;
  var tyreCells = null;
  /** Aid boxes by key: { box, valueEl } — hidden until the aid exists. */
  var aidBoxes = {};
  /** Last rendered wording per aid — the green-flash change detector. */
  var aidPrev = {};
  var flashTimers = {};

  /** Last-lap hold state for the lap-time box. */
  var lastSeenLap = null;
  var holdUntil = 0;
  var holdBest = false;

  /* ---------------------------------------------------------------------- */
  /*  Markup                                                                 */
  /* ---------------------------------------------------------------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /**
   * Positions a box on the frame, in percentages of the design box — safe
   * because the frame is JS-held to the design aspect (see header).
   */
  function place(node, x, y, w, h) {
    node.style.left = (x / DW) * 100 + "%";
    node.style.top = (y / DH) * 100 + "%";
    node.style.width = (w / DW) * 100 + "%";
    node.style.height = (h / DH) * 100 + "%";
    return node;
  }

  /** One labelled stat box: small caption on top, big value under it. */
  function statBox(parent, cls, label, x, y, w, h) {
    var box = el("div", "splmp2__box" + (cls ? " " + cls : ""));
    place(box, x, y, w, h);
    var k = el("span", "splmp2__k", label);
    var v = el("span", "splmp2__v", "—");
    box.appendChild(k);
    box.appendChild(v);
    parent.appendChild(box);
    return { box: box, k: k, v: v };
  }

  /** Cached plain write — continuous values must not glow (glance hierarchy). */
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
   * Long readings step the value down a size instead of clipping: the sim's
   * own wording for bias ("54.0:46.0") is twice the digits of a TC step, and
   * a box is the wrong place to lose the back half of a ratio. Two tiers,
   * sized so a 190-unit box holds them: at the full 82px only ~4 mono chars
   * fit ("5/11"), five ("140kW") already needs 46, and a full bias ratio
   * (9+) needs 34.
   */
  function setValue(node, key, text) {
    if (cache[key] === text) return;
    set(node, key, text);
    var small = text.length > 8 ? "tiny" : text.length > 4 ? "true" : "false";
    if (cache[key + "-sm"] !== small) {
      cache[key + "-sm"] = small;
      node.setAttribute("data-small", small);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Sizing                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Letterboxes the frame inside the stage at the design aspect and publishes
   * the scale as `--s` for the type. Idempotent, so the ResizeObserver cannot
   * feed itself — the same contract sizeCanvas() keeps in speedo.js.
   */
  function size() {
    if (!stageEl || !frameEl) return;
    var w = stageEl.clientWidth || 0;
    var h = stageEl.clientHeight || 0;
    if (!w || !h) return;
    var s = Math.min(w / DW, h / DH);
    var fw = Math.round(DW * s);
    var fh = Math.round(DH * s);
    if (fw === lastW && fh === lastH) return;
    lastW = fw;
    lastH = fh;
    frameEl.style.width = fw + "px";
    frameEl.style.height = fh + "px";
    frameEl.style.left = Math.round((w - fw) / 2) + "px";
    frameEl.style.top = Math.round((h - fh) / 2) + "px";
    frameEl.style.setProperty("--s", String(s));
  }

  /* ---------------------------------------------------------------------- */
  /*  Init                                                                   */
  /* ---------------------------------------------------------------------- */

  function init(root, ctx) {
    stageEl = root.querySelector('[data-role="stage"]');
    var mount = root.querySelector('[data-role="cluster"]');
    if (!stageEl || !mount) return;
    mount.innerHTML = "";
    cache = {};
    aidPrev = {};
    aidBoxes = {};
    flashTimers = {};
    lastSeenLap = null;
    holdUntil = 0;
    lastW = 0;
    lastH = 0;

    frameEl = el("div", "splmp2");

    /* the plate — the CDU's screen, and the thing the BG slider fades */
    frameEl.appendChild(el("div", "splmp2__plate"));

    /* --- top band: lap time | gear | delta --- */
    elLap = place(el("div", "splmp2__box splmp2__box--navy splmp2__lap"), 0, 0, 500, 120);
    elLapV = el("span", "splmp2__bigv", "—:--.---");
    elLap.appendChild(elLapV);
    frameEl.appendChild(elLap);

    // The glyph lives in a span, not as the box's own text node: the box's
    // navy fill is an absolutely-positioned ::before, and a bare text node
    // would paint UNDER it — a positioned child paints above.
    var gearBox = place(el("div", "splmp2__gear"), 500, 0, 200, 250);
    elGear = el("span", "splmp2__gearv", "—");
    gearBox.appendChild(elGear);
    frameEl.appendChild(gearBox);

    elDelta = place(el("div", "splmp2__box splmp2__box--navy splmp2__delta"), 700, 0, 500, 120);
    elDeltaV = el("span", "splmp2__bigv", "+0.00");
    elDelta.appendChild(elDeltaV);
    frameEl.appendChild(elDelta);

    /* --- upper readout row --- */
    elLapFuel = statBox(frameEl, "", "LAP FUEL", 44, 132, 200, 150).v;
    elTank = statBox(frameEl, "", "FUEL TANK", 258, 132, 200, 150).v;
    var energy = statBox(frameEl, "", "ENERGY", 728, 132, 200, 150);
    elEnergyBox = energy.box;
    elEnergyV = energy.v;
    elEnergyBox.hidden = true;
    elSpeed = statBox(frameEl, "", "SPEED", 946, 132, 200, 150).v;

    /* --- the aid boxes: TC / bias / TC cut / motor map --- */
    var tc = statBox(frameEl, "", "TC LEVEL", 0, 300, 200, 150);
    var bias = statBox(frameEl, "", "BRAKE BIAS", 199, 283, 200, 150);
    var tcc = statBox(frameEl, "", "TC CUT", 1000, 300, 200, 150);
    var map = statBox(frameEl, "splmp2__box--purple", "ENG MAP", 805, 524, 190, 150);
    aidBoxes = {
      tc: tc,
      BRAKE_BIAS: bias,
      tcCut: tcc,
      motorMap: map,
    };
    for (var k in aidBoxes) {
      if (Object.prototype.hasOwnProperty.call(aidBoxes, k)) aidBoxes[k].box.hidden = true;
    }

    /* --- centre: the four-corner tyre grid, pressure big + temp small --- */
    var grid = place(el("div", "splmp2__tyres"), 400, 300, 400, 300);
    tyreCells = {};
    var corners = [
      ["frontLeft", "FL"],
      ["frontRight", "FR"],
      ["rearLeft", "RL"],
      ["rearRight", "RR"],
    ];
    for (var i = 0; i < corners.length; i++) {
      var cell = el("div", "splmp2__cell");
      var temp = el("span", "splmp2__cell-t", "—");
      var press = el("span", "splmp2__cell-p", "—");
      cell.appendChild(temp);
      cell.appendChild(press);
      grid.appendChild(cell);
      tyreCells[corners[i][0]] = { t: temp, p: press };
    }
    frameEl.appendChild(grid);

    /* --- lower row: laps of fuel (gold) / laps run / track temp (blue) --- */
    elLapsRem = statBox(frameEl, "splmp2__box--gold", "LAPS REM", 0, 455, 200, 150).v;
    elTrkTemp = statBox(frameEl, "splmp2__box--blue", "TRK TEMP", 1000, 455, 200, 150).v;
    elLaps = statBox(frameEl, "", "LAPS", 205, 524, 190, 150).v;

    /* --- the wordmark strip the donor gives to the ECU vendor's logo --- */
    frameEl.appendChild(place(el("div", "splmp2__mark", "APEX"), 403, 655, 394, 50));

    /* --- pedal strips along the floor: brake left, throttle right, both
       growing OUT from the centre so the pair reads as one mirrored gauge --- */
    var brakeBar = place(el("div", "splmp2__bar splmp2__bar--brake"), 0, 705, 600, 15);
    elBrakeFill = el("div", "splmp2__bar-fill");
    brakeBar.appendChild(elBrakeFill);
    frameEl.appendChild(brakeBar);
    var throtBar = place(el("div", "splmp2__bar splmp2__bar--throttle"), 600, 705, 600, 15);
    elThrotFill = el("div", "splmp2__bar-fill");
    throtBar.appendChild(elThrotFill);
    frameEl.appendChild(throtBar);

    /* --- the banner, over everything --- */
    elBanner = place(el("div", "splmp2__banner"), 0, 350, 1200, 150);
    elBanner.setAttribute("data-kind", "none");
    elClutchL = el("span", "splmp2__banner-clutch", "");
    elBannerText = el("span", "splmp2__banner-text", "");
    elClutchR = el("span", "splmp2__banner-clutch", "");
    elBanner.appendChild(elClutchL);
    elBanner.appendChild(elBannerText);
    elBanner.appendChild(elClutchR);
    frameEl.appendChild(elBanner);

    mount.appendChild(frameEl);
    size();

    // One observer for the module, re-aimed on re-init — init can run again on
    // a design switch, and observers survive their targets being re-parented.
    if (observer) observer.disconnect();
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(size);
      observer.observe(stageEl);
    }
    window.addEventListener("resize", size, { passive: true });
  }

  /* ---------------------------------------------------------------------- */
  /*  Update                                                                 */
  /* ---------------------------------------------------------------------- */

  function findAid(mfd, key) {
    if (!mfd || !mfd.aids) return null;
    for (var i = 0; i < mfd.aids.length; i++) {
      if (mfd.aids[i].key === key) return mfd.aids[i];
    }
    return null;
  }

  /**
   * Flashes a box green for a moment — the donor's acknowledgement that a
   * setting just moved, done in place rather than as a pop. Restarted from
   * zero when a second step lands inside the window, so every press gets its
   * ack (the same argument speedo.js makes for its aid pop).
   */
  function flash(key) {
    var entry = aidBoxes[key];
    if (!entry) return;
    entry.box.setAttribute("data-flash", "true");
    if (flashTimers[key]) clearTimeout(flashTimers[key]);
    flashTimers[key] = setTimeout(function () {
      entry.box.setAttribute("data-flash", "false");
      flashTimers[key] = null;
    }, FLASH_MS);
  }

  /**
   * One aid box: the sim's own wording when it fits, hidden when the car does
   * not carry the control, green flash on change. The change detector compares
   * the rendered WORDING (like speedo.js's watchAids) and treats the first
   * sighting as a state, not an event.
   */
  function aidBox(ctx, key, aid) {
    var entry = aidBoxes[key];
    if (!entry) return;
    if (!aid) {
      setHidden(entry.box, "aid-" + key, true);
      delete aidPrev[key];
      return;
    }
    setHidden(entry.box, "aid-" + key, false);
    var text = aid.text || aid.value + "/" + aid.maxValue;
    if (aidPrev[key] !== undefined && aidPrev[key] !== text) flash(key);
    aidPrev[key] = text;
    setValue(entry.v, "aidv-" + key, text);
  }

  function tyreCell(fmt, cell, tyre) {
    if (!tyre) return;
    set(cell.t, "tt-" + cell.key, fmt.temp(tyre.tempC));
    set(
      cell.p,
      "tp-" + cell.key,
      typeof tyre.pressureKpa === "number" && tyre.pressureKpa > 0
        ? String(Math.round(tyre.pressureKpa))
        : "—",
    );
  }

  function update(frame, ctx) {
    if (!frameEl) return;
    var fmt = ctx.fmt;
    var p = frame.player || {};

    // ResizeObserver does not deliver while the page produces no frames, and
    // an in-game widget can be dragged in exactly that state — same backstop
    // the Apex design keeps.
    if (++tick % 30 === 0) size();

    /* --- gear: discrete, every change is a shift, and a shift is news --- */
    ctx.crit(elGear, fmt.gearLabel(p.gear));

    /* --- lap-time box: running clock, held on the last lap over the line --- */
    var lp = p.lap || {};
    if (fmt.has(lp.last) && lp.last > 0 && lp.last !== lastSeenLap) {
      // First sighting is a state, not an event: joining mid-session must not
      // replay a lap that finished before the overlay was watching.
      if (lastSeenLap !== null) {
        holdUntil = Date.now() + LAP_HOLD_MS;
        // The sim promotes a new best before we see it, so "last IS best now"
        // is the new-personal-best signal.
        holdBest = fmt.has(lp.best) && Math.abs(lp.last - lp.best) < 0.0005;
      }
      lastSeenLap = lp.last;
    }
    var holding = holdUntil > Date.now();
    var lapState, lapText;
    if (holding) {
      lapState = holdBest ? "best" : "done";
      lapText = fmt.lapTime(lp.last);
    } else {
      lapState = "run";
      // The delta engine's own clock first — REST timeIntoLap is a
      // position-derived estimate that reads short on a slow lap (see
      // PaceDeltas.lapTimeSec) — then the provider's current-lap field.
      var pd = p.paceDeltas;
      var cur = pd && fmt.has(pd.lapTimeSec) ? pd.lapTimeSec : fmt.has(lp.current) ? lp.current : -1;
      lapText = cur >= 0 ? fmt.lapTime(cur) : "—:--.---";
    }
    set(elLapV, "lap", lapText);
    if (cache.lapstate !== lapState) {
      cache.lapstate = lapState;
      elLap.setAttribute("data-state", lapState);
    }

    /* --- live delta --- */
    var pdd = p.paceDeltas;
    var d = pdd && fmt.has(pdd.tSession) ? pdd.tSession : fmt.has(lp.delta) ? lp.delta : null;
    set(elDeltaV, "delta", d === null ? "—" : fmt.delta(d));
    var dState = d === null ? "none" : d < 0 ? "up" : "down";
    if (cache.dstate !== dState) {
      cache.dstate = dState;
      elDelta.setAttribute("data-state", dState);
    }

    /* --- fuel + energy + speed --- */
    var f = frame.fuel || {};
    set(elLapFuel, "lapfuel", fmt.has(f.perLapAvgLiters) ? f.perLapAvgLiters.toFixed(2) : "—");
    set(elTank, "tank", fmt.has(f.levelLiters) ? f.levelLiters.toFixed(1) : "—");
    var hasVe = typeof f.virtualEnergyPct === "number" && f.virtualEnergyPct >= 0;
    setHidden(elEnergyBox, "ve", !hasVe);
    if (hasVe) set(elEnergyV, "vev", Math.round(f.virtualEnergyPct) + "%");
    set(elSpeed, "speed", fmt.speedValue(p.speedKph));
    // Laps of fuel is a whole-number-ish read that steps — announce the steps.
    ctx.crit(elLapsRem, fmt.has(f.lapsRemaining) ? f.lapsRemaining.toFixed(1) : "—");

    /* --- aids --- */
    var mfd = frame.mfd;
    aidBox(ctx, "tc", findAid(mfd, "tc"));
    aidBox(ctx, "tcCut", findAid(mfd, "tcCut"));
    aidBox(ctx, "BRAKE_BIAS", findAid(mfd, "BRAKE_BIAS"));
    aidBox(ctx, "motorMap", findAid(mfd, "motorMap"));

    /* --- tyres --- */
    var t = p.tyres;
    if (t && tyreCells) {
      tyreCells.frontLeft.key = "fl";
      tyreCells.frontRight.key = "fr";
      tyreCells.rearLeft.key = "rl";
      tyreCells.rearRight.key = "rr";
      tyreCell(fmt, tyreCells.frontLeft, t.frontLeft);
      tyreCell(fmt, tyreCells.frontRight, t.frontRight);
      tyreCell(fmt, tyreCells.rearLeft, t.rearLeft);
      tyreCell(fmt, tyreCells.rearRight, t.rearRight);
    }

    /* --- laps run + track temp --- */
    var laps = window.ApexOverlay.playerLapsCompleted(frame);
    ctx.crit(elLaps, laps >= 0 ? String(laps) : "—");
    var w = frame.weather;
    set(elTrkTemp, "trk", w ? fmt.temp(w.trackTempC) : "—");

    /* --- pedal strips --- */
    var ped = p.pedals || {};
    var bw = Math.round((typeof ped.brake === "number" ? ped.brake : 0) * 100) + "%";
    var tw = Math.round((typeof ped.throttle === "number" ? ped.throttle : 0) * 100) + "%";
    if (cache.bw !== bw) {
      cache.bw = bw;
      elBrakeFill.style.width = bw;
    }
    if (cache.tw !== tw) {
      cache.tw = tw;
      elThrotFill.style.width = tw;
    }

    /* --- banner --- */
    var banner = bannerState(frame);
    var kind = banner ? banner.kind + (banner.over ? "-over" : "") : "none";
    if (cache.banner !== kind) {
      cache.banner = kind;
      elBanner.setAttribute("data-kind", banner ? banner.kind : "none");
      elBanner.setAttribute("data-over", String(!!(banner && banner.over)));
      elBannerText.textContent =
        banner === null ? "" : banner.kind === "stall" ? "ENGINE STALL" : "PIT SPEED LIMITER ACTIVE";
    }
    // The clutch flanks the stall warning (the donor does the same): the fix
    // for a stall IS the clutch, so the banner shows the driver their own foot.
    var clutchTxt =
      banner && banner.kind === "stall" && typeof (p.pedals || {}).clutch === "number"
        ? Math.round(p.pedals.clutch * 100) + "%"
        : "";
    set(elClutchL, "cl", clutchTxt);
    set(elClutchR, "cr", clutchTxt);
  }

  /* ---------------------------------------------------------------------- */
  /*  Registration                                                           */
  /* ---------------------------------------------------------------------- */

  window.ApexSpeedoDesigns = window.ApexSpeedoDesigns || {};
  window.ApexSpeedoDesigns.lmp2 = {
    init: init,
    update: update,
  };
})();
