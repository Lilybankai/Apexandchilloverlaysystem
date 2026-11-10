/**
 * sim-boot.js — stamp the active sim on <html> before the panel paints.
 * -----------------------------------------------------------------------------
 * main.js loads index.html with `?sim=lmu` or `?sim=iracing` (loadPage). This
 * runs in <head>, ahead of every stylesheet and script, so:
 *
 *   - `document.documentElement.dataset.sim` is the ONE place renderer code
 *     reads the active sim from ('lmu' | 'iracing'), from its first line on;
 *   - anything tagged `data-sims="lmu"` (a space-separated list) is hidden in
 *     the other sim by a single CSS rule in hub.css — before first paint, so an
 *     iRacing driver never sees an LMU tab flash up and vanish.
 *
 * Anything missing or unrecognised is LMU: that is every install from before
 * iRacing support, and every harness that loads the page without a query.
 */
(function () {
  'use strict';
  var sim = 'lmu';
  try {
    var q = new URLSearchParams(window.location.search).get('sim');
    if (q === 'iracing' || q === 'lmu') sim = q;
  } catch (e) {
    /* no URLSearchParams — LMU */
  }
  document.documentElement.dataset.sim = sim;
})();
