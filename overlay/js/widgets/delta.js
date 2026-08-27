/**
 * widgets/delta.js — live predictive lap-delta bar ("delta pill").
 * -----------------------------------------------------------------------------
 * Shows how far up or down the focused car is on its own fastest lap, right now,
 * as it drives — the same read as a sim's on-screen delta bar. Driven by
 * `frame.player.lap.delta` (seconds; negative = ahead/faster, positive =
 * behind/slower), which the LMU provider computes predictively from the car's
 * distance→time trace against its reference lap.
 *
 * The bar is centre-anchored: a green fill grows LEFT when ahead, a red fill
 * grows RIGHT when behind, its length proportional to |delta| up to a cap. The
 * pill in the middle shows the signed value (−0.32 / +0.10). Until a reference
 * lap exists (opening lap, or a best set before the overlay was running) it
 * reads "—" in a neutral state.
 *
 * Two things ride along with the number:
 *
 *   • **Chevrons** inside the fill, marching the way the delta is going —
 *     rightward for a gain, leftward for a loss — and marching FASTER the
 *     bigger it is. Peripheral vision reads motion long before it reads digits,
 *     which is the whole point of a bar you glance at mid-corner.
 *   • **The projected lap time** (`sessionBest + delta`), the number LMU's own
 *     dashboards show. The delta says how you are doing; this says what it adds
 *     up to, which is the one a driver chasing a target actually wants.
 */
(function () {
  "use strict";

  /** Delta (s) at which the bar reaches full deflection to one side. */
  var CAP_SEC = 1.5;
  /** Chevron march period (s) at a hair off zero, and at full deflection. */
  var CHEV_SLOW_S = 1.4;
  var CHEV_FAST_S = 0.28;

  var mount, fillEl, valueEl, predEl, root;
  var chevDur = "";

  function init(rootEl) {
    root = rootEl;
    mount = rootEl.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    var wrap = document.createElement("div");
    wrap.className = "delta";

    var track = document.createElement("div");
    track.className = "delta__track";
    var fill = document.createElement("div");
    fill.className = "delta__fill";
    // The chevrons take the whole half-track on the delta's side, above the
    // fill — NOT inside it. Inside, they spend most of their life behind the
    // value: the fill grows outward from the centre, and the centre is exactly
    // where the number sits. Taking the half means the march is visible at any
    // magnitude, and it is the CSS that fades them away from the number.
    var chev = document.createElement("div");
    chev.className = "delta__chev";
    var center = document.createElement("div");
    center.className = "delta__center";
    var value = document.createElement("div");
    value.className = "delta__value";
    value.textContent = "—";

    track.appendChild(fill);
    track.appendChild(chev);
    track.appendChild(center);
    track.appendChild(value);
    wrap.appendChild(track);

    var pred = document.createElement("div");
    pred.className = "delta__pred";
    var label = document.createElement("span");
    label.className = "delta__predlabel";
    label.textContent = "PROJ";
    var predVal = document.createElement("span");
    predVal.className = "delta__predval";
    predVal.textContent = "—";
    pred.appendChild(label);
    pred.appendChild(predVal);
    wrap.appendChild(pred);

    mount.appendChild(wrap);

    fillEl = fill;
    valueEl = value;
    predEl = predVal;
    setState("none");
  }

  /**
   * `M:SS.mm` — two decimals, not the three the standings use. A projected lap
   * is recomputed every frame off a live delta, so the thousandths never sit
   * still; showing them makes a steady projection look like it is churning.
   */
  function projTime(sec) {
    if (typeof sec !== "number" || sec <= 0) return "—";
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return m + ":" + s.toFixed(2).padStart(5, "0");
  }

  function setState(state) {
    if (root.getAttribute("data-delta") !== state) root.setAttribute("data-delta", state);
  }

  /** Write the fill's left/width only when they actually changed. */
  var fillLeft = null;
  var fillWidth = null;
  function setFill(left, width) {
    if (left !== fillLeft) {
      fillLeft = left;
      fillEl.style.left = left;
    }
    if (width !== fillWidth) {
      fillWidth = width;
      fillEl.style.width = width;
    }
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var d = frame.player && frame.player.lap ? frame.player.lap.delta : fmt.UNKNOWN;
    var pace = frame.player ? frame.player.paceDeltas : null;
    var proj = projTime(pace ? pace.predictedLapSec : -1);
    if (predEl.textContent !== proj) predEl.textContent = proj;

    // Unknown sentinel is exactly -1; guard on that (a real delta of -1.000s is
    // implausible for a lap delta, and the provider rounds, so this is safe).
    if (typeof d !== "number" || d === fmt.UNKNOWN) {
      if (valueEl.textContent !== "—") valueEl.textContent = "—";
      setFill("50%", "0%");
      setState("none");
      return;
    }

    var ahead = d < -0.005;
    var behind = d > 0.005;
    var mag = Math.min(1, Math.abs(d) / CAP_SEC);
    var half = mag * 50; // % of the half-track

    // Chevron speed tracks |delta|. Quantised to 0.1 s and written only on a
    // change: re-declaring animation-duration every frame re-bases the running
    // iteration, which shows up as the march stuttering rather than flowing.
    var dur = (CHEV_SLOW_S - (CHEV_SLOW_S - CHEV_FAST_S) * mag).toFixed(1) + "s";
    if (dur !== chevDur) {
      chevDur = dur;
      root.style.setProperty("--delta-chev-dur", dur);
    }

    // Centre-anchored fill, matching LMU's on-screen delta: when AHEAD (faster,
    // negative) the green fill grows RIGHT; when BEHIND (slower) the red fill
    // grows LEFT. Quantised to a tenth of a percent — sub-pixel at any panel
    // width — and written only on change, same argument as the chevron above:
    // an unquantised float is a fresh 17-digit string and a forced layout on
    // every update even when the bar has not visibly moved.
    var w = half.toFixed(1) + "%";
    if (ahead) setFill("50%", w);
    else if (behind) setFill((50 - half).toFixed(1) + "%", w);
    else setFill("50%", "0%");

    setState(ahead ? "ahead" : behind ? "behind" : "flat");

    // Two decimals, as every sim's delta reads: the finer digits churn even on a
    // perfectly stable delta and read as flicker rather than detail.
    var sign = d > 0 ? "+" : d < 0 ? "−" : "";
    var txt = sign + Math.abs(d).toFixed(2);
    if (valueEl.textContent !== txt) valueEl.textContent = txt;
  }

  window.ApexOverlay.registerWidget("delta", {
    throttleMs: 60, // snappy — this is a live-driving readout
    init: init,
    update: update,
  });
})();
