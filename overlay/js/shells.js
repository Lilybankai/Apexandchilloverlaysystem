/**
 * shells.js — per-widget panel shell markup, shared by widget.html (single
 * OBS Browser Source page) and ingame.html (on-screen overlay layer).
 * -----------------------------------------------------------------------------
 * Each shell mirrors the corresponding section in index.html. The widget JS
 * modules build their own body content into [data-role="mount"]; client.js
 * binds a widget only when its [data-widget] section exists on the page.
 *
 * Loaded as a plain synchronous script (NOT deferred) so the markup is
 * available to inline injection scripts that run during parsing.
 */
(function () {
  "use strict";

  window.ApexShells = {
    standings:
      '<section class="widget panel" id="widget-standings" data-widget="standings" aria-label="Race standings">' +
      '<header class="panel__header"><span class="panel__title">Standings</span>' +
      '<span class="panel__meta" data-role="session">— / —</span></header>' +
      '<div class="panel__body panel__body--flush standings" data-role="mount">' +
      '<div class="placeholder">Awaiting telemetry…</div></div></section>',

    delta:
      '<section class="widget panel" id="widget-delta" data-widget="delta" aria-label="Live lap delta">' +
      '<header class="panel__header"><span class="panel__title">Delta</span>' +
      '<span class="panel__meta" data-role="ref">vs BEST</span></header>' +
      '<div class="panel__body" data-role="mount">' +
      '<div class="placeholder">Awaiting telemetry…</div></div></section>',

    weather:
      '<section class="widget panel" id="widget-weather" data-widget="weather" aria-label="Weather forecast">' +
      '<header class="panel__header"><span class="panel__title">Weather</span>' +
      '<span class="panel__meta" data-role="track-state">TRACK —</span></header>' +
      '<div class="panel__body" data-role="mount">' +
      '<div class="placeholder">Awaiting telemetry…</div></div></section>',

    relative:
      '<section class="widget panel" id="widget-relative" data-widget="relative" aria-label="Relative timing">' +
      '<header class="panel__header"><span class="panel__title">Relative</span>' +
      '<span class="panel__meta" data-role="laps">LAP —/—</span></header>' +
      '<div class="panel__body panel__body--flush" data-role="mount">' +
      '<div class="placeholder">Awaiting telemetry…</div></div></section>',

    fuel:
      '<section class="widget panel" id="widget-fuel" data-widget="fuel" aria-label="Fuel calculator">' +
      '<header class="panel__header"><span class="panel__title">Fuel</span>' +
      '<span class="panel__meta" data-role="tank">— L</span></header>' +
      '<div class="panel__body" data-role="mount">' +
      '<div class="placeholder">Awaiting telemetry…</div></div></section>',

    tyres:
      '<section class="widget panel" id="widget-tyres" data-widget="tyres" aria-label="Tyre temperatures">' +
      '<header class="panel__header"><span class="panel__title">Tyre Temps</span>' +
      '<span class="panel__meta" data-role="compound">—</span></header>' +
      '<div class="panel__body" data-role="mount">' +
      '<div class="placeholder">Awaiting telemetry…</div></div></section>',

    pedals:
      '<section class="widget panel" id="widget-pedals" data-widget="pedals" aria-label="Pedal inputs">' +
      '<header class="panel__header"><span class="panel__title">Inputs</span>' +
      '<span class="panel__meta" data-role="gear">N · — kph</span></header>' +
      '<div class="panel__body" data-role="mount">' +
      '<div class="placeholder">Awaiting telemetry…</div></div></section>',
  };
})();
