/**
 * trainingbrake.js — Brake Cue: a red light at the reference lap's braking
 * point.
 * -----------------------------------------------------------------------------
 * Nothing is drawn most of the lap. As the car closes on the metre where the
 * reference started braking for the next corner, a glowing red "BRAKE" pill
 * fades in with the metres left in its corner and a bar draining to the point.
 * It stays a moment after the point passes — long enough to be seen by a
 * driver who was looking at the road — and then goes.
 *
 * The lead is a time, not a distance: ~0.7 s of the car's own speed (never
 * under 20 m), so the cue gives the same warning at 280 km/h as at 120.
 *
 * Everything it reads is the server's: `ghost.corner.toBrakeM`, the metres to
 * the reference's braking onset for the corner ahead, absent once that point
 * is behind the car (cornerTracker.ts). In edit mode the pill shows dimmed, so
 * it can be placed. DOM only, written only on change.
 */
(function () {
  "use strict";

  /** Seconds of warning, at the car's own speed. */
  var LEAD_SEC = 0.7;
  /** The shortest lead, metres — a hairpin approach at walking pace still gets one. */
  var LEAD_MIN_M = 20;
  /** How long the cue stays after the point passes, ms. */
  var HOLD_MS = 600;

  var el = null;
  var mEl = null;
  var barEl = null;
  var on = false;
  var lastLitAt = 0;
  var holdTimer = 0;
  var cur = { m: "", bar: "" };

  function light(yes) {
    if (yes === on) return;
    on = yes;
    el.setAttribute("data-on", yes ? "true" : "false");
  }

  function setM(text) {
    if (cur.m === text) return;
    cur.m = text;
    mEl.textContent = text;
  }

  function setBar(frac) {
    var q = Math.max(0, Math.min(1, frac)).toFixed(3);
    if (cur.bar === q) return;
    cur.bar = q;
    barEl.style.transform = "scaleX(" + q + ")";
  }

  function scheduleOff() {
    if (holdTimer) return;
    var wait = Math.max(0, HOLD_MS - (Date.now() - lastLitAt));
    holdTimer = window.setTimeout(function () {
      holdTimer = 0;
      if (Date.now() - lastLitAt >= HOLD_MS) light(false);
      else scheduleOff();
    }, wait);
  }

  function update(frame) {
    if (!el) return;
    var player = frame && frame.player;
    var ghost = player ? player.ghost : null;
    var corner = ghost ? ghost.corner : null;
    var toBrake = corner && typeof corner.toBrakeM === "number" ? corner.toBrakeM : NaN;
    var mps = player && player.speedKph > 0 ? player.speedKph / 3.6 : 0;
    var lead = Math.max(LEAD_MIN_M, LEAD_SEC * mps);

    if (ghost && ghost.active && isFinite(toBrake) && toBrake >= 0 && toBrake <= lead) {
      lastLitAt = Date.now();
      setM(Math.round(toBrake) + " m");
      setBar(toBrake / lead);
      light(true);
      return;
    }
    // Past the point (or the ghost went away): hold, then let it go.
    if (on) {
      setBar(0);
      setM("");
      scheduleOff();
    }
  }

  function init(root) {
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML =
      '<div class="tbrake" data-on="false" role="status" aria-live="assertive">' +
      '<span class="tbrake__word">BRAKE</span>' +
      '<span class="tbrake__m" data-role="m"></span>' +
      '<span class="tbrake__bar"><span data-role="bar"></span></span>' +
      "</div>";
    el = mount.firstChild;
    mEl = el.querySelector('[data-role="m"]');
    barEl = el.querySelector('[data-role="bar"]');
  }

  window.ApexOverlay.registerWidget("trainingbrake", {
    // Every frame: at 250 km/h a 100 ms throttle is 7 m late.
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
