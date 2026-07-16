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
 */
(function () {
  "use strict";

  /** Delta (s) at which the bar reaches full deflection to one side. */
  var CAP_SEC = 1.5;

  var mount, fillEl, valueEl, root;

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
    var center = document.createElement("div");
    center.className = "delta__center";
    var value = document.createElement("div");
    value.className = "delta__value";
    value.textContent = "—";

    track.appendChild(fill);
    track.appendChild(center);
    track.appendChild(value);
    wrap.appendChild(track);
    mount.appendChild(wrap);

    fillEl = fill;
    valueEl = value;
    setState("none");
  }

  function setState(state) {
    if (root.getAttribute("data-delta") !== state) root.setAttribute("data-delta", state);
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var d = frame.player && frame.player.lap ? frame.player.lap.delta : fmt.UNKNOWN;

    // Unknown sentinel is exactly -1; guard on that (a real delta of -1.000s is
    // implausible for a lap delta, and the provider rounds, so this is safe).
    if (typeof d !== "number" || d === fmt.UNKNOWN) {
      if (valueEl.textContent !== "—") valueEl.textContent = "—";
      fillEl.style.width = "0%";
      setState("none");
      return;
    }

    var ahead = d < -0.005;
    var behind = d > 0.005;
    var mag = Math.min(1, Math.abs(d) / CAP_SEC);
    var half = mag * 50; // % of the half-track

    // Centre-anchored fill: grow left when ahead, right when behind.
    if (ahead) {
      fillEl.style.left = 50 - half + "%";
      fillEl.style.width = half + "%";
    } else if (behind) {
      fillEl.style.left = "50%";
      fillEl.style.width = half + "%";
    } else {
      fillEl.style.left = "50%";
      fillEl.style.width = "0%";
    }

    setState(ahead ? "ahead" : behind ? "behind" : "flat");

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
