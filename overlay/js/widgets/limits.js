/**
 * widgets/limits.js — track limits: how close to the edge, and what it has cost.
 * -----------------------------------------------------------------------------
 * Renders `frame.player.trackLimits` (see src/telemetry/trackLimits.ts, which
 * owns the detection — nothing here decides what counts as an excursion).
 *
 * ## What it is FOR, and why that shapes the design
 * A driver who runs wide already knows they ran wide. What they do not know is
 * **how many that makes**, and that is the thing this widget exists to answer at
 * a glance — because the answer changes how you drive the next twenty minutes.
 * So the count is the headline and the live off-track state is the alarm around
 * it, not the other way round.
 *
 * ## Three states, in the house's glance hierarchy
 *   clean     nothing has happened. Deliberately quiet — a dimmed row of empty
 *             pips, no colour. Most of a stint looks like this and a widget that
 *             shouts through all of it teaches the driver to stop looking.
 *   warned    one or more excursions. Pips fill amber; the count is the crit
 *             value, so the change glow fires on the increment (a discrete
 *             event — exactly what the glow is for) rather than on the state.
 *   penalty   the sim has actually issued one. Red, and the panel pulses.
 *
 * ## The two numbers do not pretend to be one
 * `warnings` is derived by us from the car's lateral position; `penalties` is
 * the sim's own count. They can disagree — LMU judges limits against the white
 * line internally and publishes no warning tally — so they get separate places
 * on the widget and are never added together: the warning count is the headline
 * under "LIMITS", and a penalty appears as its own red chip beside it.
 *
 * An earlier build had the penalty take over the headline number for a few
 * seconds. It read as a lie: a red "5" under the word LIMITS is five penalties
 * to anyone glancing at it, when it was five warnings and one penalty. Two
 * differently-sourced numbers need two places, and the chip costs almost none.
 * See the module note in trackLimits.ts for why the derived number is worth
 * having at all.
 *
 * ## The edge bar
 * Below the pips, a bar showing how much road is left: it fills from the centre
 * as `beyondEdgeM` closes on zero and goes solid past it. This is the part that
 * is useful BEFORE the mistake — it is the only thing on the overlay that says
 * "you are using all of it" while there is still time to do something about it.
 *
 * URL params:
 *   ?limits=<n>  Override the pip count (default: the provider's warningLimit).
 *                For a league running its own number rather than the FIA three.
 *
 * Audio: fires the `limit` cue on a fresh warning and `penalty` on a fresh
 * penalty, through js/audio.js — which is rate-limited, so the naive "call it
 * whenever the condition holds" below is safe.
 */
(function () {
  "use strict";

  /**
   * How long the widget stays visibly ALARMED after an excursion, ms.
   *
   * The off-track state itself lasts as long as the car is out there, which can
   * be a fraction of a second — too short to catch out of the corner of an eye.
   * Holding the alarm for a beat afterwards is what makes it register, and it is
   * short enough to be clearly about the thing that just happened.
   */
  var ALARM_MS = 2000;

  // How long a fresh penalty is announced for lives in the runtime as
  // `ctx.consequenceMs` (4 s), because the MFD announces the same event and the
  // two must agree — see the consequence-indicator block in js/client.js.

  /**
   * Metres of road remaining at which the edge bar starts to show anything.
   *
   * Two metres, so it is quiet through normal cornering and wakes up only when
   * the car is genuinely using the last of the track. Any wider and the bar is
   * lit for most of a lap, which is the same as not having it.
   */
  var EDGE_WARN_M = 2;

  var root, pipsEl, countEl, labelEl, penaltyEl, bannerEl, barFillEl, edgeEl, headerMeta;
  var metaCache = "";
  /** Pip elements, rebuilt only when the limit itself changes. */
  var pips = [];
  var pipCount = 0;
  /** Operator override for the pip count, or null to follow the provider. */
  var pipOverride = null;
  /** Last state written, so the DOM is touched only on a real change. */
  var stateCache = "";

  function init(rootEl) {
    root = rootEl;
    headerMeta = rootEl.querySelector('[data-role="meta"]');
    var mount = rootEl.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var params = new URLSearchParams(window.location.search);
    var n = parseInt(params.get("limits"), 10);
    if (isFinite(n) && n > 0 && n <= 10) pipOverride = n;

    var wrap = document.createElement("div");
    wrap.className = "limits";

    // Headline: the count, with its label beneath. `is-crit` opts the number
    // into the change glow — an excursion is exactly the kind of discrete event
    // the bloom exists for.
    var head = document.createElement("div");
    head.className = "limits__head";
    countEl = document.createElement("div");
    countEl.className = "limits__count is-crit";
    countEl.textContent = "—";
    labelEl = document.createElement("div");
    labelEl.className = "limits__label";
    labelEl.textContent = "LIMITS";
    // The sim's own count, in its own place — never blended into the headline.
    // Hidden entirely at zero: a "0 PEN" chip is a permanent reminder of
    // something that has not happened.
    penaltyEl = document.createElement("div");
    penaltyEl.className = "limits__penalty is-crit";
    penaltyEl.hidden = true;
    head.appendChild(countEl);
    head.appendChild(labelEl);
    head.appendChild(penaltyEl);

    // Pips: one per warning the scale runs to, filled left to right.
    pipsEl = document.createElement("div");
    pipsEl.className = "limits__pips";

    // Edge bar: how much road is left, right now.
    var bar = document.createElement("div");
    bar.className = "limits__bar";
    barFillEl = document.createElement("div");
    barFillEl.className = "limits__bar-fill";
    bar.appendChild(barFillEl);

    edgeEl = document.createElement("div");
    edgeEl.className = "limits__edge";
    edgeEl.textContent = "";

    // The consequence banner sits over the whole body when it fires.
    bannerEl = document.createElement("div");
    bannerEl.className = "limits__banner";
    bannerEl.hidden = true;

    wrap.appendChild(head);
    wrap.appendChild(pipsEl);
    wrap.appendChild(bar);
    wrap.appendChild(edgeEl);
    wrap.appendChild(bannerEl);
    mount.appendChild(wrap);

    setState("none");
  }

  /** Rebuild the pip row when the scale changes (once a session, if ever). */
  function buildPips(n) {
    if (n === pipCount) return;
    pipCount = n;
    pips = [];
    pipsEl.innerHTML = "";
    for (var i = 0; i < n; i++) {
      var pip = document.createElement("span");
      pip.className = "limits__pip";
      pipsEl.appendChild(pip);
      pips.push(pip);
    }
  }

  function setState(state) {
    if (stateCache === state) return;
    stateCache = state;
    root.setAttribute("data-limits", state);
  }

  function setMeta(text) {
    if (!headerMeta || metaCache === text) return;
    metaCache = text;
    headerMeta.textContent = text;
  }

  /** Fire a cue, if this page has the audio module at all. */
  function cue(name) {
    var audio = window.ApexAudio;
    if (audio && typeof audio.cue === "function") audio.cue(name);
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var tl = frame.player ? frame.player.trackLimits : null;

    // No block at all — spectating, no shared memory, or out of a session. Say
    // so rather than showing a clean sheet nobody has earned.
    if (!tl) {
      setState("none");
      if (countEl.textContent !== "—") countEl.textContent = "—";
      labelEl.textContent = "NO DATA";
      penaltyEl.hidden = true;
      bannerEl.hidden = true;
      buildPips(pipOverride || 3);
      for (var i = 0; i < pips.length; i++) pips[i].removeAttribute("data-on");
      barFillEl.style.width = "0%";
      edgeEl.textContent = "";
      setMeta("—");
      return;
    }

    if (labelEl.textContent !== "LIMITS") labelEl.textContent = "LIMITS";
    buildPips(pipOverride || tl.warningLimit || 3);

    /* ------------------------------ the counts --------------------------- */

    var warnings = tl.warnings || 0;
    var penalties = ctx.penaltyCount(tl);
    var freshWarning = fmt.has(tl.msSinceWarning) && tl.msSinceWarning < ALARM_MS;
    var freshPenalty = ctx.consequenceFresh(tl);

    // The headline is ALWAYS the warning count — it is the number that answers
    // "how many have I had", which is the question this widget exists for, and
    // it must not change meaning under the driver mid-glance. `crit` blooms it
    // on the increment, which is the discrete event worth a bloom.
    ctx.crit(countEl, String(warnings));

    // The sim's verdict, in its own chip. Also `crit`, so a penalty landing
    // blooms even though the panel is already pulsing.
    if (penalties > 0) {
      if (penaltyEl.hidden) penaltyEl.hidden = false;
      ctx.crit(penaltyEl, penalties + (penalties === 1 ? " PEN" : " PENS"));
    } else if (!penaltyEl.hidden) {
      penaltyEl.hidden = true;
    }

    // The consequence indicator: a banner across the widget for the four
    // seconds after a penalty is applied. The chip above is the standing
    // record — quiet, permanent, easy to miss. This is the announcement, and it
    // is deliberately the only thing on the widget that covers anything else,
    // because at the moment it fires it is the most important thing on screen.
    if (freshPenalty) {
      if (bannerEl.hidden) bannerEl.hidden = false;
      var text = ctx.penaltyText(penalties);
      if (bannerEl.textContent !== text) bannerEl.textContent = text;
    } else if (!bannerEl.hidden) {
      bannerEl.hidden = true;
    }

    // Pips fill left to right, wrapping past the scale so a fourth warning on a
    // three-pip scale lights the first pip again in the "over" tone rather than
    // silently doing nothing.
    var over = pipCount > 0 ? Math.floor(warnings / pipCount) : 0;
    var lit = pipCount > 0 ? warnings - over * pipCount : 0;
    if (warnings > 0 && lit === 0) {
      // Exactly on a multiple: show a full row of the previous tier, not empty.
      lit = pipCount;
      over -= 1;
    }
    for (var p = 0; p < pips.length; p++) {
      var on = p < lit;
      if (on) pips[p].setAttribute("data-on", over > 0 ? "over" : "yes");
      else pips[p].removeAttribute("data-on");
    }

    /* ------------------------------ the edge bar ------------------------- */

    // beyondEdgeM is negative while there is road left, positive once past it.
    // The bar shows the last EDGE_WARN_M of that, so it is empty through normal
    // cornering and full the moment the car is actually out.
    //
    // Tested for presence, NOT with fmt.has(): this is the one signed field on
    // the frame, so it is omitted rather than sentinelled when unknown (a car
    // with a metre of road left legitimately reads -1). See TrackLimitsState.
    var beyond = tl.beyondEdgeM;
    if (typeof beyond === "number" && isFinite(beyond)) {
      var margin = -beyond; // metres of road still to the outside of the car
      var frac;
      if (margin <= 0) frac = 1;
      else if (margin >= EDGE_WARN_M) frac = 0;
      else frac = 1 - margin / EDGE_WARN_M;
      barFillEl.style.width = (frac * 100).toFixed(1) + "%";
      edgeEl.textContent =
        margin <= 0 ? "OFF TRACK" : margin < EDGE_WARN_M ? margin.toFixed(1) + " m" : "";
    } else {
      barFillEl.style.width = "0%";
      edgeEl.textContent = "";
    }

    /* -------------------------------- state ------------------------------ */

    // Order matters: the worst true thing wins the colour.
    var state;
    if (freshPenalty) state = "penalty";
    else if (tl.offTrack || freshWarning) state = "alarm";
    else if (penalties > 0) state = "penalised";
    else if (warnings > 0) state = "warned";
    else state = "clean";
    setState(state);

    /* -------------------------------- audio ------------------------------ */

    // Both are rate-limited inside audio.js, so calling them on every frame the
    // condition holds plays each once — no edge-detection needed here.
    if (freshPenalty) cue("penalty");
    else if (freshWarning) cue("limit");

    /* ----------------------------- header meta --------------------------- */

    // The count against its scale, and nothing else. It deliberately does NOT
    // repeat the penalty: the chip already carries that, and the header is a
    // narrow strip that wraps onto two lines the moment it is given a word as
    // long as "PENALTIES" — which pushed the panel title onto two lines with it.
    setMeta(warnings + " / " + pipCount);
  }

  window.ApexOverlay.registerWidget("limits", {
    // Fast enough that the edge bar tracks a car running out of road in real
    // time — that readout is only useful while it is still live information.
    throttleMs: 60,
    init: init,
    update: update,
  });
})();
