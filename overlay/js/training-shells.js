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
 * It also publishes `window.ApexTrainingWidgets`, the training widget ids, so
 * training.html's whitelist is read from here rather than copied.
 * scripts/test-training-layer.js checks that list against main.js's
 * TRAINING_CATALOG, ingame.js's training placements and the bench.
 *
 * Synchronous, after shells.js and before the page's inline injector.
 */
(function () {
  "use strict";

  var shells = window.ApexShells || (window.ApexShells = {});
  var ids = [];

  /**
   * The training look (training.css "The card"): no title bar. A widget's name
   * shows only in edit mode, as a tag above it, so it can be found and moved;
   * on track the card is all content. `data-role="meta"` stays (hidden) for
   * code that writes the reference's label into it.
   *
   * `card` — the dark card with the brand hairline on its top edge.
   * `bare` — no surface at all: Ghost HUD draws its own vignette, and the
   *          brake cue is a light that is either on or not there.
   */
  function shell(id, name, label, look) {
    return (
      '<section class="widget tw tw--' + look + '" id="widget-' + id + '" data-widget="' + id + '" aria-label="' + label + '">' +
      '<span class="tw__name" aria-hidden="true">' + name + '</span>' +
      '<span data-role="meta" hidden></span>' +
      '<div class="tw__body" data-role="mount">' +
      '<div class="tw__wait">Awaiting telemetry…</div></div></section>'
    );
  }

  function add(id, name, label, look) {
    shells[id] = shell(id, name, label, look || "card");
    ids.push(id);
  }

  add("ghosthud", "Ghost HUD", "Ghost HUD — the road ahead with the reference lap's line on it", "bare");
  add("traininginputs", "Telemetry", "Telemetry — throttle, brake, speed and the gap against the reference lap, by distance");
  add("trainingcorner", "Corner Analysis", "Corner analysis — how the last corner went against the reference lap");
  add("trainingsectors", "Lap Strip", "Lap strip — sectors and every corner of this lap against the reference");
  add("trainingcoach", "Coach", "Coach — your inputs, speed and gear against the reference right now");
  add("trainingbrake", "Brake Cue", "Brake cue — lights up at the reference lap's braking point", "bare");

  window.ApexTrainingWidgets = ids;
})();
