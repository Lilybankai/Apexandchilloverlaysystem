/**
 * training-ghost.js — one copy of `/ghost.json` for every training widget.
 * -----------------------------------------------------------------------------
 * The Trace and the Lap strip both need the reference lap's columns, and the
 * body is ~40 KB that only changes when the chosen lap does. Fetched once
 * here and handed to each subscriber, rather than once per widget.
 *
 * The rules are Ghost HUD's (`ghosthud.js` `ensureLine`), for the same
 * reasons: `frame.player.ghost.sourceLapId` is the cache key and moves exactly
 * when the provider picks another lap; one request in flight and no queue;
 * `204` means "no ghost selected" rather than an error; and a miss is not
 * asked again for MISS_RETRY_MS, or a frame that names a lap the server has
 * not published yet would ask on every frame.
 *
 * A lap with no driven line arrives WITHOUT `x`/`z` and is published like any
 * other: it is a whole answer, so it is never asked for again. Whoever needs
 * the line (Ghost HUD) checks for it.
 *
 * Loaded as a classic script before the widgets (`window.ApexTrainingGhost`).
 */
(function () {
  "use strict";

  var MISS_RETRY_MS = 5000;

  var line = null;
  var haveId = "";
  var fetching = false;
  var missId = "";
  var missUntil = 0;
  var subscribers = [];

  function publish(data) {
    line = data;
    for (var i = 0; i < subscribers.length; i++) {
      try {
        subscribers[i](line);
      } catch (err) {
        console.error("[Apex] training ghost subscriber failed:", err);
      }
    }
  }

  /**
   * Keep the line in step with the selection. Cheap enough to call on every
   * frame: almost always a string compare.
   *
   * @param {object|undefined} ghost - `frame.player.ghost`.
   */
  function sync(ghost) {
    var id = ghost && ghost.sourceLapId ? ghost.sourceLapId : "";
    if (!id) {
      haveId = "";
      if (line) publish(null);
      return;
    }
    if (line && haveId === id) return;
    if (fetching) return;
    if (id === missId && Date.now() < missUntil) return;
    fetching = true;
    function miss() {
      fetching = false;
      missId = id;
      missUntil = Date.now() + MISS_RETRY_MS;
    }
    fetch("/ghost.json", { cache: "no-store" })
      .then(function (r) {
        if (r.status === 204) return null;
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.d || !data.t || data.d.length < 8) return miss();
        fetching = false;
        haveId = data.lapId || id;
        publish(data);
      })
      .catch(miss);
  }

  /** Be told whenever the line changes (to `null` when it goes away). */
  function subscribe(cb) {
    subscribers.push(cb);
    if (line) cb(line);
  }

  window.ApexTrainingGhost = { sync: sync, subscribe: subscribe };
})();
