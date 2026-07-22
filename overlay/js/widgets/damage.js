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
  var elRepair = null;
  var elRepairVal = null;
  var elTyreVal = null;
  var elTyreNote = null;
  var rowsDmg = []; // { fill, val } for aero + 4 corners
  var rowsBrake = [];
  var cache = {};

  function setText(el, key, text) {
    if (!el || cache[key] === text) return;
    cache[key] = text;
    el.textContent = text;
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
      elHeroNum.className = "damage__hero-num";
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
      elSel.className = "damage__sel-val";
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

  /** What the pit menu selection should read as, in the driver's words. */
  function selectionLabel(sel) {
    if (sel === "all") return "Repair All";
    if (sel === "body") return "Repair Body";
    if (sel === "none") return "Do Not Repair";
    return "N/A";
  }

  function update(frame, ctx) {
    var p = frame.player;
    var d = p && p.damage;

    if (!d) {
      // No repair screen: spectating, between sessions, or a provider without
      // the endpoint (rF2). Say so rather than rendering zeros, which would
      // read as a pristine car and could talk a driver out of pitting.
      setText(headerMeta, "meta", "NO DATA");
      if (elHeroNum) setText(elHeroNum, "hero", "—");
      if (elClean) elClean.hidden = true;
      if (elTyre) elTyre.hidden = true;
      if (elRepair) elRepair.hidden = true;
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

    if (modeRepair) {
      // Clean and damaged are mutually exclusive presentations of the same slot.
      // A clean car with tyres selected still has a stop worth pricing, so the
      // figure shows whenever there is any work booked in, not only on damage.
      var anyWork = d.hasDamage || d.tyreCornersSelected > 0;
      if (elClean) elClean.hidden = anyWork;
      if (elHeroNum) elHeroNum.parentElement.hidden = !anyWork;
      if (anyWork) {
        setText(elHeroNum, "hero", hasTime ? heroSec.toFixed(1) : "—");
        // Name what the number actually is. "PIT STOP" when it is the sim's
        // total, "TO REPAIR" when we have fallen back to the repair figure —
        // the two mean different things and must not be labelled alike.
        setText(
          elHeroTag,
          "herotag",
          !hasTime ? "NO ESTIMATE" : hasStop ? "PIT STOP" : "TO REPAIR",
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

      setText(elSel, "sel", selectionLabel(d.repairSelection));
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
    // it quotes the same figure the hero does — the sim's total stop where it
    // has one, the repair time where it does not.
    if (!d.hasDamage && d.tyreCornersSelected <= 0) {
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
