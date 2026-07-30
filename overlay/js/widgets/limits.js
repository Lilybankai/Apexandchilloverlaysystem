/**
 * widgets/limits.js — track limits: how close to the edge, and what it has cost.
 * -----------------------------------------------------------------------------
 * Renders `frame.player.trackLimits` (see src/telemetry/trackLimits.ts, which
 * owns the detection — nothing here decides what counts as an excursion).
 *
 * ## What it is FOR, and why that shapes the design
 * A driver who runs wide already knows they ran wide. What they do not know is
 * **what it cost and how close that puts them to a drive-through**, and that is
 * what this widget answers at a glance — because the answer changes how you
 * drive the next twenty minutes.
 *
 * ## It counts POINTS, because that is what LMU judges limits in
 * The sim does not run a strike count. Every infringement scores points — it
 * weighs how far off you went, whether you were on the throttle and whether you
 * were at the speed expected there — and a drive-through is issued once the
 * running total passes a threshold the session configures. A single infringement
 * worth 3 points is an instant drive-through on its own.
 *
 * ## The at-risk window is the whole reason this is useful
 * LMU raises a Race Control notice the moment you are at risk and gives you a
 * brief opportunity to slow down while the violation is calculated. Lift inside
 * it and the infringement costs nothing. So the widget's loudest state — and
 * the audio cue — fire at the START of that window, while the driver can still
 * act, not when the points land. A warning about something already decided is
 * just noise at 200 km/h.
 *
 * ## The states, in the house's glance hierarchy
 *   clean     nothing has happened. Deliberately quiet — a dimmed row of empty
 *             pips, no colour. Most of a stint looks like this and a widget that
 *             shouts through all of it teaches the driver to stop looking.
 *   atrisk    off the road, verdict open. The loudest thing here, because it is
 *             the only state with an action attached: LIFT.
 *   saved     they lifted. Green, briefly — the confirmation that makes the
 *             habit stick. Without it a driver lifts, sees nothing change, and
 *             stops bothering.
 *   warned    points on the board. Pips fill amber.
 *   penalty   the sim has actually issued one. Red, and the panel pulses.
 *
 * ## The two numbers do not pretend to be one
 * `points` is derived by us from the car's lateral position and throttle;
 * `penalties` is the sim's own count. They can disagree — LMU judges limits
 * internally and publishes neither its points nor its thresholds — so they get
 * separate places and are never added together: points are the headline under
 * "POINTS", and a penalty appears as its own red chip beside it.
 *
 * An earlier build had the penalty take over the headline number for a few
 * seconds. It read as a lie: a red "5" under that label is five penalties to
 * anyone glancing at it, when it was five points and one penalty. Two
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
 *   ?limits=<n>  Override the points limit (default: the provider's pointsLimit).
 *                LMU sets this per session; leagues publish theirs on the event.
 *
 * Audio: fires the `limit` cue once as the AT-RISK window opens — not once the
 * points land, and not repeatedly while it stays open — and `penalty` when the
 * sim issues one. Through js/audio.js.
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
  /**
   * Whether the driver was at risk on the previous frame, so the cue fires
   * once as the window OPENS rather than on every frame it stays open.
   */
  var wasAtRisk = false;

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

    if (labelEl.textContent !== "POINTS") labelEl.textContent = "POINTS";

    // The pips are a countdown to the drive-through, so they only mean anything in a
    // session that issues one. Practice and qualifying invalidate the lap instead and
    // let the total run past the allowance — the game's own HUD shows the limit as
    // infinity there — so the row is hidden rather than filling up and stopping at a
    // threshold nothing will happen at. An explicit ?limits= override still wins:
    // that is someone deliberately watching a scale.
    var enforced = tl.pointsLimitEnforced !== false || !!pipOverride;
    if (pipsEl.hidden === enforced) pipsEl.hidden = !enforced;
    if (enforced) buildPips(pipOverride || tl.pointsLimit || 10);

    /* ------------------------------ the counts --------------------------- */

    // The sim's OWN running total when it can be read, ours only as a fallback.
    //
    // `simPoints` comes from LMU's trace log (see telemetry/lmuTraceLimits.ts) and
    // is the stewards' figure — the same number the in-game HUD shows, validated
    // against the session-end results XML. `tl.points` is our reconstruction from
    // geometry, which cannot see what the sim charges: it counts excursions, and
    // the sim charges for time GAINED, so the two disagree by design.
    //
    // Checked with `has()` rather than truthiness: a real 0 from the sim is the
    // most reassuring number on the widget and must not fall through to ours.
    var fromSim = tl.pointsSource === "sim" && fmt.has(tl.simPoints);
    var points = fromSim ? tl.simPoints : tl.points || 0;
    var limit = pipOverride || tl.pointsLimit || 10;
    var penalties = ctx.penaltyCount(tl);
    var freshWarning = fmt.has(tl.msSinceWarning) && tl.msSinceWarning < ALARM_MS;
    var freshNegated = fmt.has(tl.msSinceNegated) && tl.msSinceNegated < ALARM_MS;
    var freshPenalty = ctx.consequenceFresh(tl);

    // The headline is ALWAYS the running points total — the number that answers
    // "how close am I to the drive-through", which is what this widget exists
    // for. It must not change meaning under the driver mid-glance.
    ctx.crit(countEl, String(points));

    // The sim's verdict, in its own chip — named when the sim named it. WHICH
    // penalty is the actionable half: a drive-through and a stop/go are served
    // differently, and with the in-game HUD off this chip is the only place that
    // says which. Falls back to the bare count when the type is unknown rather
    // than guessing (see buildPenaltyType in the provider).
    if (penalties > 0) {
      if (penaltyEl.hidden) penaltyEl.hidden = false;
      ctx.crit(
        penaltyEl,
        tl.penaltyType
          ? ctx.penaltyLabel(tl, penalties)
          : penalties + (penalties === 1 ? " PEN" : " PENS"),
      );
    } else if (!penaltyEl.hidden) {
      penaltyEl.hidden = true;
    }

    // The banner has three things to say, in descending order of consequence.
    // Only one can be up at a time, and at-risk outranks the rest while it is
    // live: it is the only one the driver can still act on.
    var freshServed = ctx.servedFresh(tl);
    var banner = null;
    if (tl.atRisk) {
      // LIFT while the verdict is open; SAVED once they have. Saying "saved"
      // the instant they lift is the confirmation that makes the habit stick —
      // without it the driver lifts, sees no change, and stops bothering.
      banner = tl.liftedInTime ? "SAVED" : "LIFT";
    } else if (freshServed) {
      // Ranked above a fresh penalty: if both fired, the newer event is the
      // discharge, and "PENALTY SERVED" is the answer to the question the driver
      // is asking on the way out of the lane.
      banner = "PENALTY SERVED";
    } else if (freshPenalty) {
      banner = ctx.penaltyLabel(tl, penalties);
    } else if (freshWarning && fmt.has(tl.lastInfringementPoints)) {
      banner = "+" + tl.lastInfringementPoints +
        (tl.lastInfringementPoints === 1 ? " POINT" : " POINTS");
    } else if (freshNegated) {
      banner = "SAVED";
    }
    if (banner !== null) {
      if (bannerEl.hidden) bannerEl.hidden = false;
      if (bannerEl.textContent !== banner) bannerEl.textContent = banner;
      bannerEl.setAttribute(
        "data-kind",
        tl.atRisk
          ? tl.liftedInTime
            ? "saved"
            : "lift"
          : freshServed
            ? "served"
            : freshPenalty
              ? "penalty"
              : freshWarning
                ? "scored"
                : "saved",
      );
    } else if (!bannerEl.hidden) {
      bannerEl.hidden = true;
    }

    // Pips fill left to right with the points scored, wrapping past the limit
    // so a driver already over it sees the row start again in the "over" tone
    // rather than a full row that stopped meaning anything.
    var over = limit > 0 ? Math.floor(points / limit) : 0;
    var lit = limit > 0 ? points - over * limit : 0;
    if (points > 0 && lit === 0) {
      lit = limit;
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

    // Order matters: the worst true thing wins the colour, except that "you can
    // still fix this" outranks everything — it is the only state with an action
    // attached to it.
    var state;
    if (tl.atRisk) state = tl.liftedInTime ? "saved" : "atrisk";
    else if (freshPenalty) state = "penalty";
    else if (freshWarning) state = "alarm";
    else if (freshNegated) state = "saved";
    else if (penalties > 0) state = "penalised";
    else if (points > 0) state = "warned";
    else state = "clean";
    setState(state);

    /* -------------------------------- audio ------------------------------ */

    // The limits cue fires while the point is still AT RISK — not when it
    // lands.
    //
    // This is the whole point of the cue. LMU scores an infringement over a
    // brief window and lets you give the time back inside it by lifting, so a
    // tone that plays once the points are on the board is telling the driver
    // about something they can no longer do anything about. Fired at the top of
    // the window instead, it is an instruction: lift, now, and this costs you
    // nothing.
    //
    // It is deliberately silent once `liftedInTime` goes true — the driver has
    // already done the thing being asked, and a cue that keeps sounding after
    // compliance is what teaches people to ignore cues.
    //
    // Edge-triggered, NOT left to audio.js's rate limit. That limit is one
    // second and the at-risk window is 1.2, so calling it every frame the
    // condition held sounded the tone TWICE per excursion — measured. Two beeps
    // for one instruction reads as an alarm rather than a prompt, and the fix
    // cannot be "make the rate limit longer" because that would also swallow the
    // second of two genuinely separate excursions.
    if (freshPenalty) cue("penalty");
    if (tl.atRisk && !tl.liftedInTime && !wasAtRisk) cue("limit");
    wasAtRisk = tl.atRisk && !tl.liftedInTime;

    /* ----------------------------- header meta --------------------------- */

    // Points against the limit that earns the drive-through. Deliberately does
    // NOT repeat the penalty: the chip already carries that, and the header is a
    // narrow strip that wraps onto two lines the moment it is given a word as
    // long as "PENALTIES" — which pushed the panel title onto two lines with it.
    // The `~` marks OUR estimate, and its absence marks the sim's own figure.
    //
    // A driver told they are on 4.75 of 5 drives the rest of the stint to that
    // number, so it has to be clear whether the stewards said it or we inferred it.
    // One character, in the header rather than the headline, because the whole
    // point of the headline is that it does not change shape mid-glance.
    // "4.75 / 5" where the limit bites; "9.5 PTS" where it does not, rather than a
    // ratio against a threshold the session will never enforce.
    //
    // "+?" marks a cut the sim has not ruled on yet: its log reaches us a 4 KB block
    // at a time, so a charge can be anywhere from a tenth of a second to ~25s behind.
    // Reading "4.75+? / 5" says at least 4.75 with more to come, which is the true
    // state — where a bare 4.75 would quietly claim the stewards had finished.
    // Only meaningful alongside the sim's own figure; our estimate is already
    // qualified by the "~".
    var pendingMark = fromSim && tl.chargePending ? "+?" : "";
    setMeta((fromSim ? "" : "~") + points + pendingMark + (enforced ? " / " + limit : " PTS"));
  }

  window.ApexOverlay.registerWidget("limits", {
    // Fast enough that the edge bar tracks a car running out of road in real
    // time — that readout is only useful while it is still live information.
    throttleMs: 60,
    init: init,
    update: update,
  });
})();
