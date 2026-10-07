/**
 * trainingcorner.js — Corner card: how the corner you just left went.
 * -----------------------------------------------------------------------------
 * The moment the car crosses a corner's exit, a card says what that corner
 * cost or gave against the reference lap — "C5  −0.21 s", braked 12 m early,
 * apex 6 km/h down — in the gain or loss colour, for four seconds. A thin bar
 * along its foot runs down over those seconds, so the driver knows how long
 * it will stay without having to wonder whether it is stuck. Between corners
 * the card steps back to one quiet line: the next corner, and how far to the
 * reference's braking point for it.
 *
 * Corners are numbered C1..Cn in the reference lap's own order. They are cut
 * from its driven line (`corners.ts`) and are not the circuit's official
 * turns; the card never claims a name it cannot know.
 *
 * Everything shown is worked out on the server (`cornerTracker.ts`, carried
 * as `frame.player.ghost.corner`); this file only words it, through
 * `training-laps.js`, so the card and the Lap strip describe a corner in the
 * same words and colours. A DOM widget at 10 Hz: the text changes a few times
 * a lap, and it is only ever written when it does.
 */
(function () {
  "use strict";

  var LAPS = window.ApexTrainingLaps;

  /** How long a verdict stays up, ms. Matches the CSS clock bar's duration. */
  var VERDICT_MS = 4000;

  var el = null;
  var nameEl = null;
  var deltaEl = null;
  var brakeEl = null;
  var apexEl = null;
  var clockEl = null;
  var nextEl = null;
  var headerMeta = null;

  var unit = "kph";
  /** The verdict on show, its `seq`, and when it went up. */
  var shown = null;
  var shownSeq = -1;
  var shownAt = 0;
  /** Whether the first frame has been seen: a verdict older than the widget is not news. */
  var primed = false;
  var clockRun = 0;

  /** Last values written, so the DOM is only touched on change. */
  var cur = { mode: "", tone: "", name: "", delta: "", brake: "", apex: "", next: "", label: "" };

  function set(key, node, value) {
    if (cur[key] === value) return;
    cur[key] = value;
    node.textContent = value;
  }

  function setAttr(key, name, value) {
    if (cur[key] === value) return;
    cur[key] = value;
    el.setAttribute(name, value);
  }

  /** Word a verdict into the card. */
  function showVerdict(v) {
    set("name", nameEl, LAPS.cornerName(v.index));
    set("delta", deltaEl, v.deltaSec === null ? "—" : LAPS.fmtSigned(v.deltaSec) + " s");
    set("brake", brakeEl, LAPS.brakePhrase(v.brakeDeltaM) || "");
    set("apex", apexEl, LAPS.apexPhrase(v.apexKphDelta, unit) || "");
    setAttr("tone", "data-tone", LAPS.toneOf(v.deltaSec));
    // Restart the run-down bar without a forced layout: alternate between two
    // identical keyframe sets, which the engine treats as a new animation.
    clockRun = clockRun === 1 ? 2 : 1;
    clockEl.setAttribute("data-run", String(clockRun));
  }

  function update(frame) {
    if (!el || !LAPS) return;
    var ghost = frame && frame.player ? frame.player.ghost : null;
    var corner = ghost ? ghost.corner : null;
    var now = Date.now();

    if (headerMeta) {
      var label = ghost && ghost.sourceLabel ? ghost.sourceLabel : "—";
      if (label !== cur.label) {
        cur.label = label;
        headerMeta.textContent = label;
      }
    }

    if (!ghost) {
      setAttr("mode", "data-mode", "none");
      set("next", nextEl, "No ghost lap");
      return;
    }
    if (!corner) {
      setAttr("mode", "data-mode", "none");
      set("next", nextEl, "No corners on this lap");
      return;
    }

    var v = corner.last || null;
    if (!primed) {
      // The widget has just appeared: whatever verdict the frame carries
      // happened before it, so it is taken as already seen.
      primed = true;
      shownSeq = v ? v.seq : -1;
    } else if (v && v.seq !== shownSeq) {
      shownSeq = v.seq;
      shownAt = now;
      shown = v;
      showVerdict(v);
    }

    if (shown && now - shownAt < VERDICT_MS) {
      setAttr("mode", "data-mode", "verdict");
      return;
    }
    setAttr("mode", "data-mode", "next");
    set("next", nextEl, LAPS.nextPhrase(corner));
  }

  function init(root) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML =
      '<div class="tcorner" data-mode="none" data-tone="none" aria-live="polite">' +
      '<div class="tcorner__card">' +
      '<span class="tcorner__name"></span>' +
      '<div class="tcorner__body">' +
      '<span class="tcorner__delta"></span>' +
      '<span class="tcorner__notes"><span class="tcorner__note" data-role="brake"></span>' +
      '<span class="tcorner__note" data-role="apex"></span></span>' +
      "</div>" +
      '<span class="tcorner__clock" data-run="0"></span>' +
      "</div>" +
      '<div class="tcorner__next"><span class="tcorner__label">NEXT</span>' +
      '<span class="tcorner__nexttext"></span></div>' +
      "</div>";
    el = mount.firstChild;
    nameEl = el.querySelector(".tcorner__name");
    deltaEl = el.querySelector(".tcorner__delta");
    brakeEl = el.querySelector('[data-role="brake"]');
    apexEl = el.querySelector('[data-role="apex"]');
    clockEl = el.querySelector(".tcorner__clock");
    nextEl = el.querySelector(".tcorner__nexttext");
    if (!LAPS) {
      console.error("[Apex] Corner card needs training-laps.js loaded first");
      return;
    }
    var look = window.ApexAppearance;
    if (look && typeof look.onSpeedUnit === "function") {
      look.onSpeedUnit(function (u) {
        unit = u;
        if (shown) set("apex", apexEl, LAPS.apexPhrase(shown.apexKphDelta, unit) || "");
      });
    }
  }

  window.ApexOverlay.registerWidget("trainingcorner", {
    // Ten a second is plenty for text that changes a few times a lap, and a
    // card that appears within 100 ms of the exit is on time.
    throttleMs: 100,
    init: init,
    update: update,
  });
})();
