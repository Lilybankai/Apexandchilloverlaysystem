/**
 * widgets/limits.js — track limits: what is left, and what each cut has cost.
 * -----------------------------------------------------------------------------
 * Renders `frame.player.trackLimits`. Every number on it is the sim's own: the
 * stewards' running total and their per-cut charges come from LMU's trace log
 * (src/telemetry/lmuTraceLimits.ts), the penalty count from the scoring record.
 * Nothing here — and nothing behind it any more — decides what counts as a cut.
 *
 * ## What it is FOR, and why that shapes the design
 * A driver who runs wide already knows they ran wide. What they do not know is
 * **what it cost and how much allowance is left**, and that is what this widget
 * answers at a glance — because the answer changes how you drive the next twenty
 * minutes.
 *
 * ## It counts POINTS, because that is what LMU judges limits in
 * The sim does not run a strike count. Every infringement is charged points — it
 * weighs how much time the cut gained, so charges come in quarters: 0.25 for a
 * wheel over the line, 1.00 for a cut that actually gained something — and a
 * drive-through is issued once the running total reaches the session's allowance.
 *
 * ## The headline counts DOWN
 * Points spent is a number you have to do arithmetic on before it means anything.
 * Points left is the answer already: 1.75 says a couple more careless kerbs and
 * you are walking to the pit lane. Same figure, one subtraction earlier, at the
 * moment the driver has least attention to spare.
 *
 * ## Three readouts, and why each earns its place
 *   the count      how much allowance is left. The reason to look.
 *   the bar        the same thing spatially, so peripheral vision gets it without
 *                  reading a number. It drains.
 *   the charges    what each of the last few cuts cost. This is the one that
 *                  changes behaviour: three 0.25s in a row is one kerb being
 *                  clipped every lap and a driver who can fix it by moving their
 *                  line a foot; a single 1.00 is one mistake already made. The
 *                  running total alone cannot tell those two apart.
 *
 * ## The flash fires on the CHARGE, and only on the charge
 * The one thing that happens here which the driver has not already seen for
 * themselves is the verdict. So the loud state — yellow, with the amount —
 * belongs to the moment the total goes up, and to nothing else. A widget that
 * lights up for anything more than that is one a driver learns to stop reading.
 *
 * A previous build flashed as the car went off the road and told the driver to
 * LIFT, because our own geometry could see the excursion and LMU gives a brief
 * window to give the time back. That went with the geometry: the estimate behind
 * it disagreed with the stewards often enough that a "1 POINT" callout beside a
 * total the sim had charged 0.25 for was worse than no callout at all.
 *
 * ## The price of the real numbers, stated plainly
 * The sim flushes its log a block at a time, so a charge can reach us anywhere
 * from a tenth of a second to ~25 s after the cut. The total is right; sometimes
 * it is right late. See docs/TRACK-LIMITS-POINTS.md.
 *
 * ## The states, in the house's glance hierarchy
 *   clean      full allowance. Deliberately quiet — most of a stint looks like
 *              this, and a widget that shouts through all of it teaches the
 *              driver to stop looking.
 *   warned     points on the board. Amber, steady.
 *   alarm      a charge just landed. Amber, flashing, with the amount.
 *   penalty    the sim has issued one. Red, and the panel pulses.
 *   penalised  a penalty stands but is no longer news.
 *   none       no source for the points at all (plain rF2, spectating).
 *
 * Audio: the `limit` cue fires once per charge, with the flash; `penalty` when
 * the sim issues one. Through js/audio.js.
 */
(function () {
  "use strict";

  /**
   * How long the widget stays visibly ALARMED after a charge lands, ms.
   *
   * Long enough to catch out of the corner of an eye on the way out of a corner,
   * short enough to be clearly about the thing that just happened. It also has to
   * outlast the gap between two charges arriving in the same flush of the sim's
   * log — at two seconds a second charge re-arms the flash rather than being
   * swallowed by the first one's tail.
   */
  var ALARM_MS = 2000;

  /**
   * How long the sim gets to change its mind about the lap, ms.
   *
   * countLapFlag drops the moment the car leaves the road and comes BACK if
   * the driver lifts and gives the time back — both observed live inside a
   * single excursion. While that window is open the verdict is provisional,
   * so the chip reads EVALUATING and the panel lights up: it is the one
   * moment the driver can still do something about it. A flag still down
   * this long after the drop has not been seen to recover, so it hardens to
   * LAP INVALID and stays until the sim starts a lap that counts again.
   */
  var LAP_EVAL_MS = 4000;

  // How long a fresh penalty is announced for lives in the runtime as
  // `ctx.consequenceMs` (4 s), because the MFD announces the same event and the
  // two must agree — see the consequence-indicator block in js/client.js.

  /** How many charges the strip will show, however many the frame carries. */
  var STRIP_MAX = 5;

  var root, countEl, labelEl, lapEl, penaltyEl, bannerEl, barEl, barFillEl, chargesEl, headerMeta;
  var metaCache = "";
  /** Last state written, so the DOM is touched only on a real change. */
  var stateCache = "";
  /** Likewise for the bar's health band. */
  var allowCache = "";
  /** Last charge strip written, for the same reason. */
  var chargesCache = "";
  /**
   * Whether a charge was fresh on the previous frame, so the cue fires once as
   * it lands rather than on every frame of the two seconds it stays fresh.
   */
  var wasFresh = false;
  /** Wall-clock ms when the validity flag last dropped; 0 while the lap counts. */
  var lapDownSince = 0;
  /** Last chip stage written ("", "evaluating", "invalid"), to skip DOM writes. */
  var lapCache = null;

  function init(rootEl) {
    root = rootEl;
    headerMeta = rootEl.querySelector('[data-role="meta"]');
    var mount = rootEl.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var wrap = document.createElement("div");
    wrap.className = "limits";

    // Headline: the count, with its label beside it. `is-crit` opts the number
    // into the change glow — a charge is exactly the kind of discrete event the
    // bloom exists for.
    var head = document.createElement("div");
    head.className = "limits__head";
    countEl = document.createElement("div");
    countEl.className = "limits__count is-crit";
    countEl.textContent = "—";
    labelEl = document.createElement("div");
    labelEl.className = "limits__label";
    labelEl.textContent = "LIMITS";
    // The sim's LIVE lap-validity verdict (countLapFlag), staged by setLap():
    // EVALUATING while the stewards can still be talked round, LAP INVALID
    // once they no longer can. Hidden while the lap counts; a permanent
    // "VALID" chip would be a reminder of nothing.
    lapEl = document.createElement("div");
    lapEl.className = "limits__lap";
    lapEl.hidden = true;
    // The sim's penalty, in its own place. Hidden entirely at zero: a "0 PEN"
    // chip is a permanent reminder of something that has not happened.
    penaltyEl = document.createElement("div");
    penaltyEl.className = "limits__penalty is-crit";
    penaltyEl.hidden = true;
    head.appendChild(countEl);
    head.appendChild(labelEl);
    head.appendChild(lapEl);
    head.appendChild(penaltyEl);

    // The allowance, spatially: full at the start of a session, empty at the
    // drive-through.
    barEl = document.createElement("div");
    barEl.className = "limits__bar";
    barFillEl = document.createElement("div");
    barFillEl.className = "limits__bar-fill";
    barEl.appendChild(barFillEl);

    // What the last few cuts were charged, newest first.
    chargesEl = document.createElement("div");
    chargesEl.className = "limits__charges";
    chargesEl.hidden = true;

    // The consequence banner sits over the whole body when it fires.
    bannerEl = document.createElement("div");
    bannerEl.className = "limits__banner";
    bannerEl.hidden = true;

    wrap.appendChild(head);
    wrap.appendChild(barEl);
    wrap.appendChild(chargesEl);
    wrap.appendChild(bannerEl);
    mount.appendChild(wrap);

    setState("none");
  }

  function setState(state) {
    if (stateCache === state) return;
    stateCache = state;
    root.setAttribute("data-limits", state);
  }

  /**
   * The validity chip, staged: the drop is provisional for LAP_EVAL_MS (lift
   * NOW and the sim restores the lap), final after. The stage also rides the
   * section as `data-lap`, so the CSS can light the whole panel through the
   * window a lift can still save — a chip alone was missed at racing speed.
   *
   * The timer restarts on each true→false edge, so a second excursion later
   * in the same lap opens its own evaluation window rather than inheriting
   * the first one's expired clock.
   */
  function setLap(invalid) {
    var stage = "";
    if (!invalid) {
      lapDownSince = 0;
    } else {
      if (!lapDownSince) lapDownSince = Date.now();
      stage = Date.now() - lapDownSince >= LAP_EVAL_MS ? "invalid" : "evaluating";
    }
    if (lapCache === stage) return;
    lapCache = stage;
    lapEl.hidden = !stage;
    if (stage) lapEl.textContent = stage === "invalid" ? "LAP INVALID" : "EVALUATING";
    root.setAttribute("data-lap", stage || "ok");
  }

  /** How healthy the allowance is: `ok` / `low` / `crit`, for the bar's colour. */
  function setAllow(level) {
    if (allowCache === level) return;
    allowCache = level;
    root.setAttribute("data-allow", level);
  }

  function setMeta(text) {
    if (!headerMeta || metaCache === text) return;
    metaCache = text;
    headerMeta.textContent = text;
  }

  /**
   * A points figure the way the sim writes it: `0.25`, `1.5`, `4`.
   *
   * Trailing zeros stripped, because "1.00" and "1" are the same number and the
   * shorter one is read faster. Two decimals first, so float addition's
   * 0.7500000000000001 never reaches the screen.
   */
  function pts(v) {
    return String(Math.round(v * 100) / 100);
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
      setLap(false);
      blank("NO DATA");
      return;
    }

    // The validity chip rides every path below, including unknown-points: it
    // comes from the REST feed, which is alive even when the stewards' log is
    // not. Strictly `=== false` — an absent channel must not read as invalid.
    setLap(tl.lapValid === false);

    /* ------------------------------ the counts --------------------------- */

    // The stewards' running total. UNKNOWN when there is no source for it — on
    // plain rF2 nothing publishes track-limit points, and the honest answer to
    // "how many have I got left" there is that we cannot see. A comfortable zero
    // would be a lie in the one direction that costs a driver a race.
    var known = fmt.has(tl.points);
    var penalties = ctx.penaltyCount(tl);

    if (!known) {
      // The penalty is still worth showing on its own: it is the sim's verdict,
      // it arrived through a different channel, and it is the only thing on the
      // widget that is actionable without the total behind it.
      var standing = penalties > 0 || tl.disqualified;
      blank(standing ? "PENALTY" : "NO POINTS");
      showPenalty(ctx, tl, penalties);
      penaltyBanner(ctx, tl, penalties);
      setState(standing ? (ctx.consequenceFresh(tl) ? "penalty" : "penalised") : "none");
      return;
    }

    var points = tl.points;
    var limit = tl.pointsLimit || 10;
    // The countdown only means something where the sim will actually act on it.
    // Practice and qualifying invalidate the lap instead and let the total run
    // past the allowance — the game's own HUD shows the limit as infinity there —
    // so those sessions get the total spent rather than a countdown to a
    // drive-through that cannot come.
    var enforced = tl.pointsLimitEnforced !== false;
    var remaining = Math.max(0, Math.round((limit - points) * 100) / 100);
    var fresh = fmt.has(tl.msSinceCharge) && tl.msSinceCharge < ALARM_MS;
    var freshPenalty = ctx.consequenceFresh(tl);
    var freshServed = ctx.servedFresh(tl);

    ctx.crit(countEl, enforced ? pts(remaining) : pts(points));
    if (labelEl.textContent !== (enforced ? "LEFT" : "PTS")) {
      labelEl.textContent = enforced ? "LEFT" : "PTS";
    }
    showPenalty(ctx, tl, penalties);

    /* ------------------------------ the bar ------------------------------ */

    // Drains as the allowance is spent. Hidden where there is no allowance to
    // spend: an empty rail under a total that is allowed to keep climbing reads
    // as a countdown to something.
    if (barEl.hidden === enforced) barEl.hidden = !enforced;
    if (enforced) {
      var frac = limit > 0 ? remaining / limit : 0;
      barFillEl.style.width = (frac * 100).toFixed(1) + "%";
      // How much is left decides the colour, on the root so the CSS can reach
      // it. A bar that looks the same at 5.0 remaining and 0.25 is a bar that
      // has stopped answering the only question it was put there for.
      setAllow(frac < 0.2 ? "crit" : frac < 0.5 ? "low" : "ok");
    }

    /* ---------------------------- the charges ---------------------------- */

    var charges = Array.isArray(tl.charges) ? tl.charges.slice(0, STRIP_MAX) : [];
    var strip = charges.map(pts).join(" · ");
    if (strip !== chargesCache) {
      chargesCache = strip;
      // The label rides inside the strip rather than sitting in its own element:
      // it only exists when there is something to label, and a "CUTS" heading
      // over an empty row is a heading about nothing.
      chargesEl.textContent = strip ? "CUTS  " + strip : "";
      chargesEl.hidden = !strip;
    }

    /* ----------------------------- the banner ---------------------------- */

    // Three things to say, in descending order of consequence, and only one at a
    // time.
    //
    // The charge comes LAST despite being the newest event, because the charge
    // that takes the total past the allowance and the penalty it earns land in
    // the same frame — and "+0.5" is a strange thing to be told at the moment you
    // are given a drive-through. Ranking the penalty above it costs a flash on
    // the rare charge that arrives within four seconds of one.
    var banner = null;
    var kind = "scored";
    if (freshServed) {
      // Top of the list: if a penalty is both outstanding and just discharged,
      // the discharge is the newer event, and "PENALTY SERVED" is the answer to
      // the question the driver is asking on the way out of the lane.
      banner = "PENALTY SERVED";
      kind = "served";
    } else if (freshPenalty) {
      // The kind, then what it is for / when to serve it — both halves are the
      // sim's own words, and both are questions the driver is asking right now.
      banner = ctx.penaltyLabel(tl, penalties);
      if (tl.penaltyDetail) banner += " — " + tl.penaltyDetail;
      kind = "penalty";
    } else if (fresh && charges.length) {
      banner = "+" + pts(charges[0]);
    }
    setBanner(banner, kind);

    /* -------------------------------- state ------------------------------ */

    // The worst true thing wins the colour, except that the freshest one wins
    // over a standing one — news outranks history. Ordered to match the banner
    // above: a yellow-pulsing panel behind a red PENALTY banner reads as two
    // different events, when it is one.
    var state;
    if (freshPenalty) state = "penalty";
    else if (fresh) state = "alarm";
    else if (penalties > 0 || tl.disqualified) state = "penalised";
    else if (points > 0) state = "warned";
    else state = "clean";
    setState(state);

    /* -------------------------------- audio ------------------------------ */

    // Edge-triggered, NOT left to audio.js's rate limit: that limit is one second
    // and the flash lasts two, so a cue fired on every frame the charge stayed
    // fresh would sound the tone twice for one cut. Two beeps for one verdict
    // reads as an alarm rather than a report, and the fix cannot be "make the
    // rate limit longer" because that would also swallow the second of two
    // genuinely separate charges arriving in the same flush.
    if (freshPenalty) cue("penalty");
    if (fresh && !wasFresh) cue("limit");
    wasFresh = fresh;

    /* ----------------------------- header meta --------------------------- */

    // Points against the allowance that earns the drive-through. Deliberately
    // does NOT repeat the penalty: the chip already carries that, and the header
    // is a narrow strip that wraps onto two lines the moment it is given a word
    // as long as "PENALTIES" — which pushed the panel title onto two lines with
    // it. "1.75 / 5" where the limit bites; "9.5 PTS" where it does not, rather
    // than a ratio against a threshold the session will never enforce.
    setMeta(enforced ? pts(remaining) + " / " + pts(limit) : pts(points) + " PTS");
  }

  /**
   * Everything cleared, with a reason under the dash.
   *
   * Deliberately does NOT touch the lap-validity chip: it is set once per
   * frame above, and this runs on the unknown-points path too — where the
   * stewards' log is missing but the REST validity channel is still alive.
   */
  function blank(label) {
    if (countEl.textContent !== "—") countEl.textContent = "—";
    if (labelEl.textContent !== label) labelEl.textContent = label;
    penaltyEl.hidden = true;
    setBanner(null, "scored");
    barEl.hidden = true;
    setAllow("ok");
    if (chargesCache !== "") {
      chargesCache = "";
      chargesEl.textContent = "";
      chargesEl.hidden = true;
    }
    setState("none");
    setMeta("—");
  }

  /**
   * The sim's verdict, in its own chip — named when the sim named it.
   *
   * WHICH penalty is the actionable half: a drive-through and a stop/go are
   * served differently, and with the in-game HUD off this chip is the only place
   * that says which. Falls back to the bare count when the type is unknown rather
   * than guessing (see buildPenaltyType in the provider).
   */
  function showPenalty(ctx, tl, penalties) {
    // A disqualification keeps the chip up at a count of zero: the sim leaves
    // the count wherever it was when the stewards excluded the car, and the
    // verdict is the one thing left on this widget worth reading.
    if (penalties > 0 || tl.disqualified) {
      if (penaltyEl.hidden) penaltyEl.hidden = false;
      ctx.crit(
        penaltyEl,
        tl.penaltyType
          ? ctx.penaltyLabel(tl, penalties)
          : penalties + (penalties === 1 ? " PEN" : " PENS"),
      );
      if (penaltyEl.title !== (tl.penaltyDetail || "")) {
        penaltyEl.title = tl.penaltyDetail || "";
      }
    } else if (!penaltyEl.hidden) {
      penaltyEl.hidden = true;
    }
  }

  /** The penalty half of the banner, for the no-points path. */
  function penaltyBanner(ctx, tl, penalties) {
    if (ctx.servedFresh(tl)) setBanner("PENALTY SERVED", "served");
    else if (ctx.consequenceFresh(tl)) {
      var label = ctx.penaltyLabel(tl, penalties);
      if (tl.penaltyDetail) label += " — " + tl.penaltyDetail;
      setBanner(label, "penalty");
    } else setBanner(null, "scored");
  }

  function setBanner(text, kind) {
    if (text === null) {
      if (!bannerEl.hidden) bannerEl.hidden = true;
      return;
    }
    if (bannerEl.hidden) bannerEl.hidden = false;
    if (bannerEl.textContent !== text) bannerEl.textContent = text;
    bannerEl.setAttribute("data-kind", kind);
  }

  window.ApexOverlay.registerWidget("limits", {
    // The numbers move a few times a session, but the flash has a two-second
    // life and the frame it starts on should not be a quarter of a second old.
    throttleMs: 120,
    init: init,
    update: update,
  });
})();
