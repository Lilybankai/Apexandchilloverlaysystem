/**
 * widgets/racecontrol.js — the race director's channel: start sequence, flags,
 * and the pit-limiter prompts around them.
 * -----------------------------------------------------------------------------
 * Renders `frame.session.{phase,flag,startLights,sectorFlags}` and
 * `frame.player.pit.{phase,entryDistM,limiterOn}`. Every signal here is the
 * sim's own — probed live and documented in docs/race-control-signals.md —
 * and the widget's whole job is to give back what the stock HUD says at the
 * moments a driver has turned the stock HUD off:
 *
 *   formation    "FORMATION LAP", with ENGAGE LIMITER while the limiter is off
 *                (LMU's own pre-start convention).
 *   countdown    the start gantry, lamp by lamp — `startLights.total` reds,
 *                `frame` of them lit.
 *   lights out   frame > total, or the phase flipping to green: GREEN FLAG,
 *                flashed for four seconds. If the limiter is still on at that
 *                moment, the flash is replaced by the thing that matters.
 *   green        quiet. A persistent LIMITER ON warning is the one exception —
 *                on track, at racing phase, with the limiter engaged, the
 *                widget must not be polite about it.
 *   FCY          "FULL COURSE YELLOW" while the session flag says so.
 *   pit request  a steady "PIT REQUESTED" while the sim says a stop is booked
 *                (`pit.phase === 'request'` — the sim's own flag, so a stop
 *                booked through the game's own bind shows too), becoming the
 *                live pit-entry countdown (`entryDistM` ticks every frame)
 *                inside 900 m, with LIMITER added once inside 150 m of the
 *                commit point with the limiter still off. Toggling the
 *                request OFF flashes "PIT REQUEST CANCELLED" for four
 *                seconds — a request consumed by actually entering the lane
 *                is not a cancellation and stays quiet.
 *   sectors      an S1/S2/S3 rail, lit from the sim's own per-sector flags.
 *
 * ## What it deliberately does NOT do
 * No limiter prompt is ever shown when `limiterOn` is absent — spectating,
 * plain rF2, or a build where the byte moved. A wrong "ENGAGE LIMITER" at a
 * race start is strictly worse than silence, same reasoning as the penalty
 * type in limits.js. The banner also never invents phases: an unknown phase
 * renders the rail alone.
 */
(function () {
  "use strict";

  /** How long the green-flag banner flashes, ms. */
  var GREEN_FLASH_MS = 4000;
  /** Inside this many metres of the pit commit point, no limiter = alarm. */
  var LIMITER_WARN_M = 150;
  /** Only a countdown this near reads as "approaching the pit entry". */
  var ENTRY_SHOW_M = 900;

  var root, msgEl, subEl, lightsEl, lampEls, sectorEls, headerMeta;
  var metaCache = "";
  var stateCache = "";
  var msgCache = "";
  var subCache = "";
  var lightsCache = "";
  var sectorCache = "";
  /** The previous frame's phase, for the pre-green -> green edge. */
  var prevPhase = null;
  /** Wall-clock until which the green banner stays up, 0 when not flashing. */
  var greenUntil = 0;
  /** How long the request-cancelled banner flashes, ms. */
  var CANCEL_FLASH_MS = 4000;
  /** The previous frame's pit phase, for the request -> none (cancel) edge. */
  var prevPitPhase = null;
  /** Wall-clock until which the cancelled banner stays up, 0 when quiet. */
  var cancelUntil = 0;

  function init(rootEl) {
    root = rootEl;
    headerMeta = rootEl.querySelector('[data-role="meta"]');
    var mount = rootEl.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var wrap = document.createElement("div");
    wrap.className = "racecontrol";

    // The gantry. Lamps are built once at the first frame that says how many
    // there are; five is the LMU norm but the count is the sim's to decide.
    lightsEl = document.createElement("div");
    lightsEl.className = "racecontrol__lights";
    lightsEl.hidden = true;
    lampEls = [];

    // The banner pair: the thing to do, and the reason under it.
    msgEl = document.createElement("div");
    msgEl.className = "racecontrol__msg";
    msgEl.hidden = true;
    subEl = document.createElement("div");
    subEl.className = "racecontrol__sub";
    subEl.hidden = true;

    // The sector rail. Always present: a quiet green rail is the "nothing is
    // wrong" reading, and a rail that only exists during a yellow cannot be
    // glanced at for reassurance.
    var rail = document.createElement("div");
    rail.className = "racecontrol__sectors";
    sectorEls = [];
    for (var i = 0; i < 3; i++) {
      var chip = document.createElement("span");
      chip.className = "racecontrol__sector";
      chip.textContent = "S" + (i + 1);
      chip.setAttribute("data-flag", "none");
      sectorEls.push(chip);
      rail.appendChild(chip);
    }

    wrap.appendChild(lightsEl);
    wrap.appendChild(msgEl);
    wrap.appendChild(subEl);
    wrap.appendChild(rail);
    mount.appendChild(wrap);

    setState("idle");
  }

  function setState(state) {
    if (stateCache === state) return;
    stateCache = state;
    root.setAttribute("data-race", state);
  }

  function setMeta(text) {
    if (!headerMeta || metaCache === text) return;
    metaCache = text;
    headerMeta.textContent = text;
  }

  function setMsg(text) {
    if (msgCache !== (text || "")) {
      msgCache = text || "";
      msgEl.hidden = !text;
      if (text) msgEl.textContent = text;
    }
  }

  function setSub(text) {
    if (subCache !== (text || "")) {
      subCache = text || "";
      subEl.hidden = !text;
      if (text) subEl.textContent = text;
    }
  }

  /** Draw the gantry: `lit` of `total` lamps, or hide it when total is 0. */
  function setLights(lit, total) {
    var sig = lit + "/" + total;
    if (lightsCache === sig) return;
    lightsCache = sig;
    if (!total) {
      lightsEl.hidden = true;
      return;
    }
    while (lampEls.length < total) {
      var lamp = document.createElement("span");
      lamp.className = "racecontrol__lamp";
      lampEls.push(lamp);
      lightsEl.appendChild(lamp);
    }
    for (var i = 0; i < lampEls.length; i++) {
      lampEls[i].hidden = i >= total;
      lampEls[i].setAttribute("data-lit", i < lit ? "1" : "0");
    }
    lightsEl.hidden = false;
  }

  /** A distance the way a driver reads one: "850 m" until it goes negative. */
  function metres(d) {
    return Math.max(0, d) + " m";
  }

  function update(frame) {
    var s = frame.session || {};
    var pit = frame.player && frame.player.pit ? frame.player.pit : {};
    var phase = s.phase;
    var lights = s.startLights;
    var now = Date.now();

    /* ------------------------------ the edge ------------------------------ */

    // Green is an EVENT here, not a state: the flash arms on the transition
    // from any pre-green phase, or on the sim's own lights-out frame. Both,
    // because a rolling start skips the countdown phase entirely and jumps the
    // gantry straight to lights-out — seen live at Daytona.
    var lightsOut = lights && lights.total > 0 && lights.frame > lights.total;
    if (
      (phase === "green" && prevPhase && prevPhase !== "green" && prevPhase !== "unknown") ||
      (lightsOut && greenUntil === 0)
    ) {
      greenUntil = now + GREEN_FLASH_MS;
    }
    if (phase !== "green" && !lightsOut) greenUntil = 0;
    prevPhase = phase;

    // The cancel edge: the request toggled OFF while still out on track — the
    // driver un-booked the stop (LMU's request key is a toggle, so a double
    // press does exactly this). Strictly request→none: a request that becomes
    // `entering` was consumed, not cancelled, and an absent pit block says
    // nothing at all. A fresh request silences any flash still running.
    if (prevPitPhase === "request" && pit.phase === "none") cancelUntil = now + CANCEL_FLASH_MS;
    if (pit.phase === "request") cancelUntil = 0;
    prevPitPhase = pit.phase || null;

    /* ---------------------------- the sectors ----------------------------- */

    var sectors = Array.isArray(s.sectorFlags) ? s.sectorFlags : null;
    var sig = sectors ? sectors.join("|") : "";
    if (sig !== sectorCache) {
      sectorCache = sig;
      for (var i = 0; i < 3; i++) {
        sectorEls[i].setAttribute("data-flag", sectors ? sectors[i] || "none" : "none");
      }
    }
    var anySectorYellow = !!sectors && (sectors[0] === "yellow" || sectors[1] === "yellow" || sectors[2] === "yellow");

    /* ------------------------- what to say, ranked ------------------------ */

    // `limiterOn` is tri-state by absence: undefined must behave as "say
    // nothing about the limiter", never as off.
    var limiterKnown = typeof pit.limiterOn === "boolean";
    var entryKnown = typeof pit.entryDistM === "number";
    var state = "idle";
    var msg = null;
    var sub = null;
    var showLights = false;

    if (s.flag === "yellow" && phase !== "formation") {
      // The FCY channel. Sector yellows have their own rail; this banner is
      // for the whole circuit being under caution.
      state = "fcy";
      msg = "FULL COURSE YELLOW";
      sub = anySectorYellow ? null : "SLOW — NO OVERTAKING";
    } else if (phase === "formation") {
      state = "formation";
      msg = "FORMATION LAP";
      if (limiterKnown && pit.limiterOn === false) {
        state = "limiter";
        sub = "ENGAGE PIT LIMITER";
      }
    } else if (phase === "countdown" || (lights && lights.frame > 0 && !lightsOut && phase !== "green")) {
      // The gantry, lamp by lamp. The second arm covers a sim that animates
      // the lights without ever publishing a countdown phase string.
      state = "countdown";
      showLights = true;
    } else if (greenUntil > now) {
      state = "green";
      msg = "GREEN FLAG";
      if (limiterKnown && pit.limiterOn === true && pit.phase === "none") {
        state = "limiter";
        sub = "LIMITER STILL ON";
      }
    } else if (pit.phase === "entering" || pit.phase === "stopped" || pit.phase === "exiting") {
      // In the lane. The limiter is the only thing worth saying, and only
      // when it is affirmatively off.
      if (limiterKnown && pit.limiterOn === false && pit.phase === "entering") {
        state = "limiter";
        msg = "LIMITER";
      }
    } else if (
      pit.phase === "request" &&
      entryKnown &&
      pit.entryDistM > 0 &&
      pit.entryDistM <= ENTRY_SHOW_M
    ) {
      // Pitting this lap: the live countdown to the commit point.
      state = "pitentry";
      msg = "PIT ENTRY " + metres(pit.entryDistM);
      if (limiterKnown && pit.limiterOn === false && pit.entryDistM <= LIMITER_WARN_M) {
        state = "limiter";
        sub = "LIMITER";
      }
    } else if (pit.phase === "request") {
      // A stop is booked but the entry is not yet the story (beyond the
      // countdown envelope, or no entry channel at all). Steady, not flashed:
      // this is the confirmation the driver glances for after pressing the
      // button, and it holds until the request is consumed or cancelled.
      state = "pitrequest";
      msg = "PIT REQUESTED";
    } else if (phase === "green" && limiterKnown && pit.limiterOn === true && pit.phase === "none") {
      // Left the pits with the limiter engaged — the mistake that loses
      // half the field before turn one of an out-lap.
      state = "limiter";
      msg = "LIMITER ON";
    } else if (cancelUntil > now) {
      // Ranked under the limiter warning on purpose: four seconds of
      // confirmation must never sit over "you are driving at 60".
      state = "pitcancel";
      msg = "PIT REQUEST CANCELLED";
    } else if (anySectorYellow) {
      // Nothing louder to say: name the hazard the rail is showing.
      state = "yellow";
    }

    setLights(showLights && lights ? Math.min(lights.frame, lights.total) : 0, showLights && lights ? lights.total : 0);
    setMsg(msg);
    setSub(sub);
    setState(state);

    /* ----------------------------- header meta ---------------------------- */

    setMeta(
      phase === "formation"
        ? "FORMATION"
        : phase === "countdown"
          ? "COUNTDOWN"
          : phase === "green"
            ? "GREEN"
            : phase === "fullCourseYellow"
              ? "FCY"
              : phase === "checkered"
                ? "FINISH"
                : "—",
    );
  }

  window.ApexOverlay.registerWidget("racecontrol", {
    // The gantry animates a lamp a second and the entry countdown ticks every
    // frame; 100 ms keeps both honest without repainting a quiet rail.
    throttleMs: 100,
    init: init,
    update: update,
  });
})();
