/**
 * training-shells.js — panel shells for the training widgets.
 * -----------------------------------------------------------------------------
 * Added to `window.ApexShells` (shells.js) by the pages that host training
 * widgets — training.html and widget.html — and NOT by ingame.html. That page
 * falls back to every shell it knows when its `?widgets=` list is empty, and
 * a training shell there would have no script to drive it: an empty panel
 * saying "Awaiting telemetry…" in the race overlay. Keeping them in their own
 * file is what keeps them out.
 *
 * Synchronous, after shells.js and before the page's inline injector.
 */
(function () {
  "use strict";

  var shells = window.ApexShells || (window.ApexShells = {});

  function shell(id, title, label) {
    return (
      '<section class="widget panel" id="widget-' + id + '" data-widget="' + id + '" aria-label="' + label + '">' +
      '<header class="panel__header"><span class="panel__title">' + title + "</span>" +
      '<span class="panel__meta" data-role="meta">—</span></header>' +
      '<div class="panel__body" data-role="mount">' +
      '<div class="placeholder">Awaiting telemetry…</div></div></section>'
    );
  }

  shells.traininginputs = shell(
    "traininginputs",
    "Trace",
    "Trace — your throttle, brake and steering against the reference lap, by distance",
  );
  shells.trainingcorner = shell(
    "trainingcorner",
    "Corner",
    "Corner card — how the last corner went against the reference lap",
  );
  shells.trainingsectors = shell(
    "trainingsectors",
    "Lap Strip",
    "Lap strip — sectors and every corner of this lap against the reference",
  );
})();
