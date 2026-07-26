/**
 * widgets/damage.js — what is broken, and what the sim says it costs to fix.
 * -----------------------------------------------------------------------------
 * Renders `frame.player.damage` (see src/telemetry/damage.ts, which owns every
 * threshold — nothing here decides what counts as heavy). Answers the question
 * a driver asks mid-stint and cannot answer from the cockpit: *how hurt am I,
 * and what does pitting to fix it cost me?*
 *
 * Modes, each independently switchable from the Browser Source URL:
 *
 *   ?dmg=on|off      COMPONENTS — aero and the four suspension corners, as
 *                                 severity bars. Default ON.
 *   ?repair=on|off   REPAIR     — the sim's own repair seconds, big, plus what
 *                                 the pit menu currently has selected.
 *                                 Default ON.
 *   ?brakes=on|off   DISCS      — brake disc thickness per corner, mm.
 *                                 Default OFF: it is wear, not damage, and it
 *                                 is the only channel here that is not about
 *                                 the pit decision.
 *
 * ## The stop itself
 * Once the car is stationary in its box, the repair figure has done its job —
 * the decision is made and the driver is sitting there watching a crew. So the
 * whole hero slot switches to a countdown from the moment work begins to the
 * moment the car is released (`frame.player.pit`, see src/telemetry/types.ts).
 *
 * It counts down the length the stop was BOOKED for and then keeps going,
 * because the booked figure is a floor and not a prediction: LMU draws up to 6 s
 * of delay when the stop happens and publishes only the cap. Past zero the
 * widget says so — the alternative, freezing on 0 and hoping, is exactly the
 * kind of confident wrong number the repair figures are careful not to be.
 *
 * ## Every number here is read, not derived
 * The headline is `pitStopLength.timeInSeconds` — the sim's OWN total stop
 * length for whatever the pit menu currently has selected. It was verified equal
 * to `FixAllDamage + TwoTireChange` to eleven decimal places on a live stop,
 * which is also what settled that the sim ADDS repair and tyre time rather than
 * overlapping them. Because the total is published, this widget does no
 * arithmetic on it at all, and the repair and tyre lines beneath are the
 * components rather than a sum being shown its working.
 *
 * The real stop runs a few seconds longer than the headline: `FixRandomDelay`
 * (up to 5 s) and `RandomTireDelay` (up to 1 s) are drawn when the stop
 * happens and are in nothing the sim publishes beforehand. A stop measured at
 * 112 s against a published 107.3 is those delays, not an error.
 *
 * ## Why severity is shown raw
 * The sim reports `0..1` per component and the bars show exactly that. Remapping
 * to a "car health" percentage would mean inventing a curve, and a driver
 * deciding whether to pit is better served by the sim's own number than by our
 * interpretation of it.
 *
 * Damage moves slowly — it changes on contact, not per frame — so this runs
 * throttled rather than at broadcast rate.
 */
(function () {
  "use strict";

  /** Severity at or above which a component reads as heavy (red, not amber). */
  var HEAVY = 0.15;
  /** Severity above which a component is damaged at all. Matches damage.ts. */
  var NOISE_FLOOR = 0.005;

  /**
   * Nominal thickness of a new disc, mm, used ONLY to scale the brake bars.
   * The sim does not publish a new-disc reference, so this is a display scale
   * and nothing more — the millimetres beside the bar are the instrument, and
   * they are printed unmodified.
   */
  var NOMINAL_DISC_MM = 40;

  /** localStorage key for the operator's chosen opacity. */
  var OPACITY_KEY = "apex-damage-opacity";
  /** Floor, so the widget can never be dragged to fully invisible by accident. */
  var MIN_OPACITY = 0.15;

  /** Corner labels, in the sim's wheel order. */
  var CORNERS = ["FL", "FR", "RL", "RR"];

  var headerMeta = null;
  var modeDmg = true;
  var modeRepair = true;
  var modeBrakes = false;

  var elHeroNum = null;
  var elHeroTag = null;
  var elClean = null;
  var elSel = null;
  var elTyre = null;
  var elRange = null;
  var elRepair = null;
  var elRepairVal = null;
  var elTyreVal = null;
  var elTyreNote = null;
  /** The stop countdown: the block, and the pieces of it that carry numbers. */
  var elStop = null;
  var elStopNum = null;
  var elStopUnit = null;
  var elStopTag = null;
  var elStopFill = null;
  var elStopSub = null;
  /**
   * Everything the countdown replaces while the crew is working: the repair
   * estimate and its breakdown. Kept as a list so the swap is one loop and no
   * element can be left behind showing an estimate for a stop already happening.
   */
  var planningEls = [];
  var rowsDmg = []; // { fill, val } for aero + 4 corners
  var rowsBrake = [];
  var cache = {};
  /** Shared widget context, kept so the setters can reach the glow helpers. */
  var octx = null;

  function setText(el, key, text) {
    if (!el || cache[key] === text) return;
    cache[key] = text;
    el.textContent = text;
  }

  /**
   * As setText, for a value worth a bloom when it changes — used for what the
   * pit menu has selected, which only moves when the driver moves it.
   */
  function setCritText(el, key, text) {
    if (!el || cache[key] === text) return;
    cache[key] = text;
    if (octx && octx.crit) octx.crit(el, text);
    else el.textContent = text;
  }

  /**
   * Write the stop-length estimate, blooming only when the WHOLE second moves.
   *
   * The figure is shown to a tenth and the sim's own estimate drifts constantly
   * while a stop is booked in — blooming on the text meant ~20 blooms a minute,
   * a permanent strobe on the widget that reads as a fault rather than as news.
   * A whole second of pit time appearing or disappearing is the real event.
   */
  function setHeroSeconds(el, key, text, sec) {
    setText(el, key, text);
    if (!el || !octx || !octx.critPulse) return;
    if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return;
    var step = Math.round(sec);
    if (cache[key + "_step"] === step) return;
    var first = cache[key + "_step"] === undefined;
    cache[key + "_step"] = step;
    if (!first) octx.critPulse(el);
  }

  function setAttr(el, key, name, value) {
    if (!el || cache[key] === value) return;
    cache[key] = value;
    el.setAttribute(name, value);
  }

  function setWidth(el, key, pct) {
    if (!el || cache[key] === pct) return;
    cache[key] = pct;
    el.style.width = pct + "%";
  }

  /**
   * One labelled severity/measure row: LABEL [====----] VALUE.
   * Shared by the damage and brake modes — same geometry, different scale.
   */
  function makeRow(parent, label) {
    var row = document.createElement("div");
    row.className = "damage__row";

    var lab = document.createElement("span");
    lab.className = "damage__label";
    lab.textContent = label;

    var track = document.createElement("span");
    track.className = "damage__track";
    var fill = document.createElement("span");
    fill.className = "damage__fill";
    fill.setAttribute("data-state", "none");
    track.appendChild(fill);

    var val = document.createElement("span");
    val.className = "damage__val";
    val.textContent = "—";

    row.appendChild(lab);
    row.appendChild(track);
    row.appendChild(val);
    parent.appendChild(row);
    return { fill: fill, val: val };
  }

  function makeSep(parent) {
    var sep = document.createElement("div");
    sep.className = "damage__sep";
    parent.appendChild(sep);
    return sep;
  }

  /**
   * Hover-revealed opacity slider — the same contract as the motion widget's
   * (widgets/motion.js), including the pointerdown guard that stops the in-game
   * layer treating a slider drag as a widget drag.
   */
  function buildOpacityControl(root, params) {
    var applyOpacity = function (v) {
      root.style.setProperty("--damage-op", String(v));
      root.setAttribute("data-transparent", v < 1 ? "true" : "false");
    };

    var stored = null;
    try {
      var raw = localStorage.getItem(OPACITY_KEY);
      if (raw !== null && isFinite(parseFloat(raw))) stored = parseFloat(raw);
    } catch (e) {
      /* private mode — the slider still works, it just won't persist */
    }
    var fromUrl = parseFloat(params.get("opacity"));
    var initial = isFinite(fromUrl) ? fromUrl : stored !== null ? stored : 1;
    initial = Math.min(1, Math.max(MIN_OPACITY, initial));

    var bar = document.createElement("div");
    bar.className = "damage__opacity";

    var label = document.createElement("span");
    label.className = "damage__opacity-label";
    label.textContent = "OPACITY";

    var slider = document.createElement("input");
    slider.className = "damage__opacity-range";
    slider.type = "range";
    slider.min = String(Math.round(MIN_OPACITY * 100));
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(initial * 100));

    var readout = document.createElement("span");
    readout.className = "damage__opacity-val";
    readout.textContent = slider.value + "%";

    slider.addEventListener("input", function () {
      var v = Math.min(1, Math.max(MIN_OPACITY, Number(slider.value) / 100));
      applyOpacity(v);
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

    // Zero-height positioning context appended after the body — see the same
    // note in widgets/motion.js for why .widget itself cannot be the anchor.
    var anchor = document.createElement("div");
    anchor.className = "damage__opacity-anchor";
    anchor.appendChild(bar);
    root.appendChild(anchor);
    applyOpacity(initial);
  }

  function init(root, ctx) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";
    rowsDmg = [];
    rowsBrake = [];
    planningEls = [];
    planningVisible = true;
    wasWorking = false;
    workEndedAt = 0;
    lastElapsedSec = -1;
    cache = {};

    var params = new URLSearchParams(window.location.search);
    var isOff = function (name) {
      var v = (params.get(name) || "").toLowerCase();
      return v === "off" || v === "0" || v === "false";
    };
    var isOn = function (name) {
      var v = (params.get(name) || "").toLowerCase();
      return v === "on" || v === "1" || v === "true";
    };
    // Damage and repair default ON (absent param = on); brakes default OFF and
    // must be asked for, since it is wear rather than damage.
    modeDmg = !isOff("dmg");
    modeRepair = !isOff("repair");
    modeBrakes = isOn("brakes");

    buildOpacityControl(root, params);

    if (!modeDmg && !modeRepair && !modeBrakes) {
      mount.innerHTML =
        '<div class="placeholder">All damage modes are off ' +
        "(?dmg / ?repair / ?brakes)</div>";
      return;
    }

    var wrap = document.createElement("div");
    wrap.className = "damage__wrap";

    if (modeRepair) {
      // The headline answer, and the reason the widget exists. Two states share
      // this slot: a repair cost when damaged, a clean marker when not.
      var hero = document.createElement("div");
      hero.className = "damage__hero";

      elHeroNum = document.createElement("span");
      elHeroNum.className = "damage__hero-num is-crit";
      elHeroNum.textContent = "—";

      var unit = document.createElement("span");
      unit.className = "damage__hero-unit";
      unit.textContent = "sec";

      elHeroTag = document.createElement("span");
      elHeroTag.className = "damage__hero-tag";
      elHeroTag.textContent = "TO REPAIR";

      hero.appendChild(elHeroNum);
      hero.appendChild(unit);
      hero.appendChild(elHeroTag);
      wrap.appendChild(hero);

      // The honest range. The headline is a floor: the sim draws a random delay
      // when the stop happens and publishes only its cap, so this says how much
      // slack it has left itself rather than pretending the floor is a
      // prediction.
      elRange = document.createElement("div");
      elRange.className = "damage__range";
      elRange.hidden = true;
      wrap.appendChild(elRange);

      elClean = document.createElement("div");
      elClean.className = "damage__clean";
      elClean.hidden = true;
      var dot = document.createElement("span");
      dot.className = "damage__clean-dot";
      var txt = document.createElement("span");
      txt.className = "damage__clean-text";
      txt.textContent = "NO DAMAGE";
      elClean.appendChild(dot);
      elClean.appendChild(txt);
      wrap.appendChild(elClean);

      // Tyre time sits BESIDE the repair figure, never added to it. Whether the
      // two overlap is decided by the sim's TireTimeConcurrent flag, which has
      // not been verified against a real stop — so the widget shows both and
      // lets the driver add them rather than publishing a total that could be
      // wrong by the whole tyre time.
      elTyre = document.createElement("div");
      elTyre.className = "damage__tyre";
      elTyre.hidden = true;
      var tk = document.createElement("span");
      tk.className = "damage__tyre-key";
      tk.textContent = "TYRES";
      elTyreVal = document.createElement("span");
      elTyreVal.className = "damage__tyre-val";
      elTyreVal.textContent = "—";
      elTyreNote = document.createElement("span");
      elTyreNote.className = "damage__tyre-note";
      elTyreNote.textContent = "";
      elTyre.appendChild(tk);
      elTyre.appendChild(elTyreNote);
      elTyre.appendChild(elTyreVal);

      // Repairs line, above tyres — the two components of the total, in the
      // order the driver thinks about them.
      elRepair = document.createElement("div");
      elRepair.className = "damage__tyre";
      elRepair.hidden = true;
      var rk = document.createElement("span");
      rk.className = "damage__tyre-key";
      rk.textContent = "REPAIRS";
      elRepairVal = document.createElement("span");
      elRepairVal.className = "damage__tyre-val";
      elRepairVal.textContent = "—";
      elRepair.appendChild(rk);
      elRepair.appendChild(elRepairVal);

      wrap.appendChild(elRepair);
      wrap.appendChild(elTyre);

      // The stop itself. Same slot, same size as the repair estimate it
      // replaces — the driver's eye does not have to move when the car stops,
      // the number under it just changes meaning from "what will this cost me"
      // to "how much longer".
      elStop = document.createElement("div");
      elStop.className = "damage__stop";
      elStop.hidden = true;

      var stopHero = document.createElement("div");
      stopHero.className = "damage__hero";
      elStopNum = document.createElement("span");
      elStopNum.className = "damage__hero-num is-crit";
      elStopNum.textContent = "—";
      elStopUnit = document.createElement("span");
      elStopUnit.className = "damage__hero-unit";
      elStopUnit.textContent = "sec";
      elStopTag = document.createElement("span");
      elStopTag.className = "damage__hero-tag";
      elStopTag.textContent = "TO RELEASE";
      stopHero.appendChild(elStopNum);
      stopHero.appendChild(elStopUnit);
      stopHero.appendChild(elStopTag);
      elStop.appendChild(stopHero);

      // A bar as well as the number: the number is the answer, the bar is how
      // far through the stop is, which is the thing you read without looking.
      var stopTrack = document.createElement("div");
      stopTrack.className = "damage__stop-track";
      elStopFill = document.createElement("span");
      elStopFill.className = "damage__stop-fill";
      stopTrack.appendChild(elStopFill);
      elStop.appendChild(stopTrack);

      elStopSub = document.createElement("div");
      elStopSub.className = "damage__stop-sub";
      elStopSub.textContent = "";
      elStop.appendChild(elStopSub);

      wrap.appendChild(elStop);

      // The planning half of the widget, in one list — hidden the moment the
      // car comes to rest and the countdown takes the slot over.
      planningEls = [hero, elRange, elClean, elRepair, elTyre];
    }

    if (modeDmg) {
      if (modeRepair) makeSep(wrap);
      rowsDmg.push(makeRow(wrap, "AERO"));
      for (var i = 0; i < 4; i++) {
        rowsDmg.push(makeRow(wrap, "SUSP " + CORNERS[i]));
      }
    }

    if (modeBrakes) {
      if (modeDmg || modeRepair) makeSep(wrap);
      var bh = document.createElement("div");
      bh.className = "damage__subhead";
      bh.textContent = "BRAKE DISCS · MM";
      wrap.appendChild(bh);
      for (var j = 0; j < 4; j++) {
        rowsBrake.push(makeRow(wrap, CORNERS[j]));
      }
    }

    if (modeRepair) {
      makeSep(wrap);
      var sel = document.createElement("div");
      sel.className = "damage__sel";
      var selK = document.createElement("span");
      selK.className = "damage__sel-key";
      selK.textContent = "PIT MENU";
      elSel = document.createElement("span");
      elSel.className = "damage__sel-val is-crit";
      elSel.textContent = "—";
      sel.appendChild(selK);
      sel.appendChild(elSel);
      wrap.appendChild(sel);
    }

    mount.appendChild(wrap);
  }

  /** Bar colour for a damage severity. */
  function stateFor(sev) {
    if (sev >= HEAVY) return "heavy";
    if (sev > NOISE_FLOOR) return "light";
    return "none";
  }

  /** Renders one damage row: colour, width and the percentage beside it. */
  function paintDamageRow(row, key, sev) {
    if (!row) return;
    var state = stateFor(sev);
    setAttr(row.fill, key + ".s", "data-state", state);
    // Undamaged rows keep a 2% stub so the track reads as a gauge at zero
    // rather than as an empty box that might be a rendering failure.
    setWidth(row.fill, key + ".w", state === "none" ? 2 : Math.min(100, Math.round(sev * 100)));
    setText(row.val, key + ".v", state === "none" ? "—" : (sev * 100).toFixed(1) + "%");
    setAttr(row.val, key + ".vs", "data-state", state);
  }

  /* ------------------------------ the stop --------------------------------- */

  /**
   * How long the widget keeps saying RELEASED after the crew let the car go, ms.
   *
   * The release is the moment the countdown exists to reach, and it goes past in
   * an instant — the phase flips to `exiting` and the car is gone. Holding the
   * result for a few seconds means the driver, who was watching the mirrors and
   * not the overlay, can still see what the stop actually took.
   */
  var RELEASED_HOLD_MS = 5000;

  var wasWorking = false;
  var workEndedAt = 0;
  /** Elapsed seconds at the last frame of work — what RELEASED reports. */
  var lastElapsedSec = -1;

  /**
   * Show/hide the planning half of the widget in one go.
   *
   * Only called on the transitions into and out of a stop, never every frame:
   * the rest of the time each of those elements has its own visibility rule
   * (clean vs damaged, tyres selected or not), and blanket-showing them first
   * would override those — a clean car would flash its hidden repair row back on
   * before the normal path hid it again.
   */
  var planningVisible = true;

  function showPlanning(on) {
    if (planningVisible === on) return;
    planningVisible = on;
    for (var i = 0; i < planningEls.length; i++) {
      if (planningEls[i]) planningEls[i].hidden = !on;
    }
  }

  /**
   * Move the countdown between its stages, blooming on the way in.
   *
   * The bloom fires on the STAGE, never on the seconds: the number moves once a
   * second by design, and glowing with it would be a metronome the eye cannot
   * ignore — the same reason the repair figure only blooms on a whole second of
   * pit time appearing (see setHeroSeconds). Crossing into the overrun, and the
   * release itself, are the two things worth catching from the corner of an eye.
   */
  function setStopState(state) {
    if (!elStop || cache.stopstate === state) return;
    var first = cache.stopstate === undefined;
    cache.stopstate = state;
    elStop.setAttribute("data-state", state);
    if (!first && octx && octx.critPulse && elStopNum) octx.critPulse(elStopNum);
  }

  /**
   * Renders the stop countdown when there is a stop, and says whether it has
   * taken the hero slot over.
   *
   * @param pit `frame.player.pit`, or nothing on a provider that has no pit
   *            stage. Absent is treated exactly like "not pitting".
   * @returns The header text while the countdown owns the widget, or `null` when
   *          the normal repair-estimate presentation should run.
   */
  function renderStop(pit) {
    if (!elStop) return null;

    var working = !!(pit && pit.working);
    if (working && typeof pit.elapsedSec === "number" && pit.elapsedSec >= 0) {
      lastElapsedSec = pit.elapsedSec;
    }
    if (wasWorking && !working) workEndedAt = Date.now();
    wasWorking = working;

    var released = !working && !!pit && workEndedAt > 0 && Date.now() - workEndedAt < RELEASED_HOLD_MS;

    if (!working && !released) {
      elStop.hidden = true;
      showPlanning(true);
      return null;
    }
    elStop.hidden = false;
    showPlanning(false);

    if (released) {
      // The stop is over. Report what it took, not what it was booked for.
      setStopState("done");
      setText(elStopNum, "stopnum", lastElapsedSec >= 0 ? String(Math.round(lastElapsedSec)) : "—");
      setText(elStopTag, "stoptag", "RELEASED");
      setWidth(elStopFill, "stopw", 100);
      elStopFill.parentElement.hidden = false;
      setText(elStopSub, "stopsub", "stop complete");
      return "RELEASED";
    }

    var elapsed = typeof pit.elapsedSec === "number" && pit.elapsedSec >= 0 ? pit.elapsedSec : 0;
    var planned = typeof pit.plannedSec === "number" ? pit.plannedSec : -1;
    var slack = typeof pit.slackSec === "number" ? pit.slackSec : -1;

    // No booked length — the repair screen was not answering when the car
    // stopped. There is still an honest clock to show, so show that and say
    // plainly that there is nothing to count down to rather than inventing one.
    if (planned <= 0) {
      setStopState("working");
      setText(elStopNum, "stopnum", String(Math.floor(elapsed)));
      setText(elStopTag, "stoptag", "IN THE BOX");
      elStopFill.parentElement.hidden = true;
      setText(elStopSub, "stopsub", "no booked length published");
      return "BOX " + Math.floor(elapsed) + "s";
    }

    elStopFill.parentElement.hidden = false;
    setWidth(elStopFill, "stopw", Math.max(0, Math.min(100, Math.round((elapsed / planned) * 100))));

    var remaining = planned - elapsed;
    if (remaining > 0) {
      setStopState("working");
      // Ceil, so the last whole second reads "1" and zero arrives when the
      // booked time genuinely does.
      setText(elStopNum, "stopnum", String(Math.ceil(remaining)));
      setText(elStopTag, "stoptag", "TO RELEASE");
      setText(elStopSub, "stopsub", "of " + planned.toFixed(1) + "s booked");
      return "BOX " + Math.ceil(remaining) + "s";
    }

    // Past the booked length, which is normal and not an error: LMU draws its
    // delay when the stop happens and publishes only the cap. Name the overrun
    // and, where the sim published a cap, how much of it is left to run.
    var over = -remaining;
    setStopState("over");
    setText(elStopNum, "stopnum", "0");
    setText(elStopTag, "stoptag", "ANY MOMENT");
    setText(
      elStopSub,
      "stopsub",
      "+" + over.toFixed(1) + "s over booked" + (slack > 0 ? " · up to +" + slack.toFixed(0) + "s" : ""),
    );
    return "BOX +" + over.toFixed(1) + "s";
  }

  /** What the pit menu selection should read as, in the driver's words. */
  function selectionLabel(sel) {
    if (sel === "all") return "Repair All";
    if (sel === "body") return "Repair Body";
    if (sel === "none") return "Do Not Repair";
    return "N/A";
  }

  function update(frame, ctx) {
    octx = ctx;
    var p = frame.player;
    var d = p && p.damage;

    // The stop is resolved BEFORE the damage block is checked, deliberately: the
    // repair screen can stop answering mid-stop, and a countdown that vanished
    // into "NO DATA" halfway through the one moment it matters would be worse
    // than not having one. Its clock and its target both come from the server
    // and need nothing from `d`.
    var stopMeta = modeRepair ? renderStop(p && p.pit) : null;

    if (!d) {
      // No repair screen: spectating, between sessions, or a provider without
      // the endpoint (rF2). Say so rather than rendering zeros, which would
      // read as a pristine car and could talk a driver out of pitting.
      setText(headerMeta, "meta", stopMeta || "NO DATA");
      if (stopMeta) setAttr(headerMeta, "metastate", "data-state", "alarm");
      if (elHeroNum) setText(elHeroNum, "hero", "—");
      if (!stopMeta) {
        if (elClean) elClean.hidden = true;
        if (elTyre) elTyre.hidden = true;
        if (elRepair) elRepair.hidden = true;
        if (elRange) elRange.hidden = true;
      }
      if (elHeroTag) setText(elHeroTag, "herotag", "TO REPAIR");
      for (var n = 0; n < rowsDmg.length; n++) {
        paintDamageRow(rowsDmg[n], "d" + n, 0);
      }
      if (elSel) setText(elSel, "sel", "—");
      return;
    }

    // The headline is the sim's OWN total stop length, which already includes
    // the repair and tyre work the driver has selected — verified equal to
    // FixAllDamage + TwoTireChange to eleven decimal places. Falling back to
    // the repair figure alone keeps the widget useful on a build that stops
    // publishing the total.
    var hasStop = d.stopLengthSeconds !== -1;
    var heroSec = hasStop ? d.stopLengthSeconds : d.repairSeconds;
    var hasTime = heroSec !== -1;
    var tyreSec = d.tyreChangeSeconds;

    if (modeRepair && !stopMeta) {
      // Clean and damaged are mutually exclusive presentations of the same slot.
      // A clean car with tyres selected still has a stop worth pricing, so the
      // figure shows whenever there is any work booked in, not only on damage.
      var anyWork = d.hasDamage || d.tyreCornersSelected > 0;
      if (elClean) elClean.hidden = anyWork;
      if (elHeroNum) elHeroNum.parentElement.hidden = !anyWork;
      if (anyWork) {
        setHeroSeconds(
          elHeroNum,
          "hero",
          hasTime ? heroSec.toFixed(1) : "—",
          hasTime ? heroSec : -1,
        );
        // Name what the number actually is. "PIT STOP" when it is the sim's
        // total, "TO REPAIR" when we have fallen back to the repair figure —
        // the two mean different things and must not be labelled alike.
        setText(
          elHeroTag,
          "herotag",
          !hasTime ? "NO ESTIMATE" : hasStop ? "PIT STOP" : "TO REPAIR",
        );
      }

      // "expect 184.5-190.5s" — the published floor through to the floor plus
      // the sim's own cap on the delay it has not told us about.
      var slack = d.randomDelayMaxSeconds;
      var rangeOn = anyWork && hasTime && slack !== -1 && slack > 0;
      if (elRange) elRange.hidden = !rangeOn;
      if (rangeOn) {
        setText(
          elRange,
          "range",
          "expect " + heroSec.toFixed(1) + "–" + (heroSec + slack).toFixed(1) + "s",
        );
      }
      // The breakdown beneath: what the total is made of. Repairs first.
      var repairOn = d.hasDamage && d.repairSeconds !== -1 && hasStop;
      if (elRepair) elRepair.hidden = !repairOn;
      if (repairOn) setText(elRepairVal, "repval", d.repairSeconds.toFixed(1) + "s");

      var tyreOn = d.tyreCornersSelected > 0 && tyreSec !== -1;
      if (elTyre) elTyre.hidden = !tyreOn;
      if (tyreOn) {
        setText(elTyreVal, "tyreval", tyreSec.toFixed(1) + "s");
        setText(
          elTyreNote,
          "tyrenote",
          d.tyreCornersSelected === 4 ? "all four" : d.tyreCornersSelected + " corner" +
            (d.tyreCornersSelected === 1 ? "" : "s"),
        );
      }
    }

    // The pit-menu row keeps updating through the stop, unlike the estimate
    // above it: mid-stop it stops being a plan and becomes a description of what
    // the crew is doing, which is worth more then than it was beforehand. It is
    // also the one line that would sit there visibly stale if the countdown
    // froze it.
    if (modeRepair) {
      setCritText(elSel, "sel", selectionLabel(d.repairSelection));
      setAttr(
        elSel,
        "selstate",
        "data-state",
        d.repairSelection === "none" ? "off" : d.repairSelection === "unavailable" ? "na" : "on",
      );
    }

    if (modeDmg) {
      paintDamageRow(rowsDmg[0], "d0", d.aero);
      for (var i = 0; i < 4; i++) {
        paintDamageRow(rowsDmg[i + 1], "d" + (i + 1), d.suspension[i]);
      }
    }

    if (modeBrakes) {
      for (var b = 0; b < 4; b++) {
        var mm = d.brakeThicknessMm[b];
        var row = rowsBrake[b];
        if (!row) continue;
        if (mm === -1) {
          setAttr(row.fill, "b" + b + ".s", "data-state", "none");
          setWidth(row.fill, "b" + b + ".w", 2);
          setText(row.val, "b" + b + ".v", "—");
        } else {
          setAttr(row.fill, "b" + b + ".s", "data-state", "wear");
          setWidth(
            row.fill,
            "b" + b + ".w",
            Math.max(2, Math.min(100, Math.round((mm / NOMINAL_DISC_MM) * 100))),
          );
          setText(row.val, "b" + b + ".v", mm.toFixed(1));
        }
      }
    }

    // Header carries the answer even when the widget is trimmed to one mode, so
    // it quotes the same figure the hero does — the countdown once the car is in
    // its box, the sim's total stop where it has one, the repair time otherwise.
    if (stopMeta) {
      setText(headerMeta, "meta", stopMeta);
      setAttr(headerMeta, "metastate", "data-state", stopMeta === "RELEASED" ? "ok" : "alarm");
    } else if (!d.hasDamage && d.tyreCornersSelected <= 0) {
      setText(headerMeta, "meta", "CLEAN");
      setAttr(headerMeta, "metastate", "data-state", "ok");
    } else if (!hasTime) {
      setText(headerMeta, "meta", d.hasDamage ? "DAMAGED" : "STOP —");
      setAttr(headerMeta, "metastate", "data-state", d.hasDamage ? "alarm" : "ok");
    } else {
      setText(
        headerMeta,
        "meta",
        (hasStop ? "STOP " : "REPAIR ") + heroSec.toFixed(1) + "s",
      );
      setAttr(headerMeta, "metastate", "data-state", d.hasDamage ? "alarm" : "ok");
    }
  }

  window.ApexOverlay.registerWidget("damage", {
    // Damage changes on contact, not per frame. 4 Hz is far more than enough
    // and keeps the widget off the critical path at broadcast rate.
    throttleMs: 250,
    init: init,
    update: update,
  });
})();
