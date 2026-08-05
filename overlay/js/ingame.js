/**
 * ingame.js — layout + edit-mode manager for the in-game overlay layer.
 * -----------------------------------------------------------------------------
 * Runs only on ingame.html. Owns the .ig-item wrappers around each widget:
 *   - applies saved placement ({x, y, scale, w, h} per widget) or sensible
 *     defaults mirroring the OBS combined page;
 *   - in edit mode (toggled by the app through window.apexIngame) lets the
 *     operator drag widgets to move them and resize them three ways:
 *       · a SIDE edge sets the widget's width — the widget reflows into it,
 *         so a wider standings tower gives its driver names more room rather
 *         than magnifying the whole thing;
 *       · a TOP/BOTTOM edge sets its height — the body is boxed and clipped to
 *         that height, which is how a 20-car field is cropped to the top few;
 *       · a CORNER scales the whole widget uniformly (transform: scale), the
 *         original behaviour — nothing inside reflows.
 *     Each gesture has a handle on both sides (left/right, top/bottom,
 *     top-left/bottom-right): a widget whose bottom edge has ended up below the
 *     screen would otherwise have no reachable way to be made smaller.
 *     Double-clicking a handle clears that dimension back to automatic.
 *   - persists placement through the preload bridge, falling back to
 *     localStorage when the page is opened in a plain browser.
 *
 * While locked, no listeners do any work (pointer events never reach the
 * click-through window), so the layer adds nothing to steady-state cost.
 */
(function () {
  "use strict";

  var bridge = window.apexIngame || null;
  var LS_KEY = "apex-ingame-layout";
  var MIN_SCALE = 0.4;
  var MAX_SCALE = 3;
  /** Floors for edge resizing — small enough to be useful, never unclickable. */
  var MIN_W = 120;
  var MIN_H = 56;

  function clampNum(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** Default placement per widget id (px, for a generic 16:9 screen). */
  function defaultsFor(id, vw, vh) {
    var D = {
      standings: { x: 24, y: 24, w: 474 },
      weather: { x: Math.round(vw / 2 - 220), y: 24, w: 440 },
      delta: { x: Math.round(vw / 2 - 150), y: 196, w: 300 },
      // Below the delta pill, on the same centre line. Without an entry here it
      // fell through to the {24, 24} fallback and spawned exactly on top of
      // standings, where it looked like the overlay had failed to load.
      pacedelta: { x: Math.round(vw / 2 - 170), y: 280, w: 340 },
      // Centre band between the weather strip and the delta pill — race-start
      // banners and flag calls belong on the driver's eyeline, and this is the
      // one centre slot nothing else claims. (No entry = the {24,24} trap.)
      racecontrol: { x: Math.round(vw / 2 - 170), y: 128, w: 340 },
      // Right column, under the fuel panel. This one is read between stints
      // rather than mid-corner, so it stays out of the centre band where the
      // delta and pace-delta live. Not the left column, which `fuelplan`
      // already claims at the same height. An id with no entry here falls
      // through to {24, 24} and spawns on top of standings, which reads as the
      // overlay having failed to load — the trap pacedelta and mfd both hit.
      refpace: { x: vw - 364, y: Math.round(vh * 0.5), w: 340 },
      relative: { x: vw - 424, y: 24, w: 400 },
      // 290, not 250: the fuel panel's Tier 1 stats are sized to be read at a
      // glance, which made it taller than the gap under the relative table.
      fuel: { x: vw - 424, y: 290, w: 400 },
      // Wider than the readout widgets — it carries the setup fields. Left edge,
      // clear of the standings tower, so its inputs are reachable in edit mode.
      fuelplan: { x: 24, y: 300, w: 340 },
      tyres: { x: vw - 324, y: vh - 260, w: 300 },
      pedals: { x: Math.round(vw / 2 - 180), y: vh - 220, w: 360 },
      // Clear of `pedals` on purpose: the two are alternates and get compared
      // side by side, so spawning them on the same centre line would stack one
      // on the other and read as a widget that failed to load.
      pedalsv: { x: 24, y: vh - 270, w: 300 },
      // vh - 470, not vh - 420: promoting the seven motion channels out of 11px
      // secondary text grew the panel past the 420px it had been given, so it
      // spawned with its last row hanging off the bottom of the screen.
      motion: { x: vw - 260, y: vh - 470, w: 236 },
      // Bottom-left, right of `pedalsv` rather than above it: the repair figure
      // plus five component rows runs ~230px tall, and stacking it in that
      // column would push it up into the standings list.
      damage: { x: 340, y: vh - 300, w: 268 },
      // Right of the pedal trace and left of the tyre/motion column — the one
      // gap on a full screen wide enough for a circuit. Wider than the readout
      // widgets because a map that is narrow is a map you cannot read.
      trackmap: { x: Math.round(vw / 2 + 190), y: vh - 300, w: 430 },
      // Had no entry, so it fell through to the {24, 24} fallback and spawned on
      // top of standings — the same trap pacedelta hit above. Centre band, below
      // the pace-delta grid, where the driving-aid rows are reachable in
      // interact mode without covering the mirrors.
      mfd: { x: Math.round(vw / 2 - 180), y: 420, w: 360 },
      // Far right, full height: chat is the widget triple-screen users park on a
      // side monitor's dead space, so it defaults to a tall narrow column hard
      // against the right edge rather than into the racing content. The height
      // handle boxes it; without one it grows with the messages.
      chat: { x: vw - 344, y: 24, w: 320, h: Math.max(240, vh - 48) },
    };
    return D[id] || { x: 24, y: 24, w: 400 };
  }

  var items = Array.prototype.slice.call(document.querySelectorAll(".ig-item"));
  var layout = {}; // { id: {x, y, scale} }
  var editing = false;

  function applyItem(el) {
    var id = el.getAttribute("data-id");
    var d = defaultsFor(id, window.innerWidth, window.innerHeight);
    var l = layout[id] || { x: d.x, y: d.y, scale: 1 };
    layout[id] = l;
    // Width: the operator's stretched width when they have set one, otherwise
    // the widget's design width (the same one the OBS pages use).
    el.style.width = (l.w || d.w) + "px";
    // Height stays automatic unless it has been set: a panel is normally as tall
    // as its content (the standings tower grows with the field). Once a height
    // exists the widget is boxed to it and its body clips — see ingame.css.
    if (l.h) {
      el.style.height = l.h + "px";
      el.setAttribute("data-sized-h", "true");
    } else {
      el.style.height = "";
      el.removeAttribute("data-sized-h");
    }
    el.style.left = l.x + "px";
    el.style.top = l.y + "px";
    el.style.transform = l.scale === 1 ? "" : "scale(" + l.scale + ")";
  }

  function applyAll() {
    for (var i = 0; i < items.length; i++) applyItem(items[i]);
  }

  /* ------------------------------ persistence ---------------------------- */

  function loadLayout() {
    if (bridge) return bridge.getLayout();
    try {
      return Promise.resolve(JSON.parse(localStorage.getItem(LS_KEY)) || {});
    } catch (e) {
      return Promise.resolve({});
    }
  }

  var saveTimer = null;
  function saveLayout() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      if (bridge) {
        bridge.saveLayout(layout);
      } else {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(layout));
        } catch (e) {
          /* private mode etc. — layout just won't persist */
        }
      }
    }, 250);
  }

  function resetLayout() {
    layout = {};
    if (!bridge) {
      try {
        localStorage.removeItem(LS_KEY);
      } catch (e) {
        /* ignore */
      }
    }
    applyAll();
  }

  /* -------------------------------- editing ------------------------------ */

  var toolbar = document.getElementById("ig-toolbar");

  /**
   * Pull anything hanging off the screen back onto it. Resize handles ride on
   * the widget's own edges, so a panel taller than the room below it — a fully
   * populated MFD, say — leaves its bottom handle somewhere no pointer can go,
   * and the widget can then only be shrunk by resetting the whole layout. The
   * top/left handles cover most of that, but a widget nudged off the bottom
   * still wants bringing back. Runs on the way INTO edit mode, and again after
   * each resize, so the operator watches it happen and can drag it wherever
   * they actually wanted it — never while merely moving one (see onPointerUp).
   */
  function ensureOnScreen() {
    var moved = false;
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var l = layout[el.getAttribute("data-id")];
      if (!l || !el.offsetHeight) continue;
      var s = l.scale || 1;
      // Widgets bigger than the window pin to the top-left corner: that is the
      // corner whose handles can then reach them.
      var x = Math.max(0, Math.min(l.x, window.innerWidth - el.offsetWidth * s));
      var y = Math.max(0, Math.min(l.y, window.innerHeight - el.offsetHeight * s));
      if (x !== l.x || y !== l.y) {
        l.x = Math.round(x);
        l.y = Math.round(y);
        applyItem(el);
        moved = true;
      }
    }
    if (moved) saveLayout();
  }

  function setEditing(on) {
    editing = !!on;
    document.body.classList.toggle("ig-editing", editing);
    toolbar.hidden = !editing;
    // Panel backgrounds come back for the duration, whatever the operator's
    // "Widget background" setting is — a widget faded to nothing can still be
    // moved and stretched, but not found. js/appearance.js restores the chosen
    // value (including one changed while editing) on the way out.
    if (window.ApexAppearance) {
      if (editing) window.ApexAppearance.suspend();
      else window.ApexAppearance.resume();
    }
    if (editing) ensureOnScreen();
  }

  document.getElementById("ig-done").addEventListener("click", function () {
    if (bridge) {
      bridge.editDone(); // main re-locks the window and echoes onEdit(false)
    } else {
      setEditing(false);
    }
  });

  /* ------------------------------ interacting ---------------------------- */
  // Interact mode makes the whole layer clickable (main sets the window mouse +
  // focus state). Unlike edit mode there is no drag: onPointerDown bails when
  // `editing` is false, so clicks fall through to each widget's own controls.

  var interactBanner = document.getElementById("ig-interact-hint");

  function setInteracting(on) {
    document.body.classList.toggle("ig-interact", !!on);
    if (interactBanner) interactBanner.hidden = !on;
  }

  var interactDone = document.getElementById("ig-interact-done");
  if (interactDone) {
    interactDone.addEventListener("click", function () {
      if (bridge) bridge.interactStop(); // main re-locks + echoes onInteract(false)
      else setInteracting(false);
    });
  }

  document.getElementById("ig-reset").addEventListener("click", function () {
    resetLayout();
    if (bridge) bridge.layoutReset();
  });

  /**
   * One drag session. `mode` is "move" (anywhere on the widget) or the handle's
   * own data-resize: "width"/"width-w" (right/left edge), "height"/"height-n"
   * (bottom/top edge) or "scale"/"scale-nw" (bottom-right/top-left corner).
   * offsetWidth/offsetHeight are the UNSCALED box, which is what the width and
   * height we store describe.
   *
   * The "-n"/"-w"/"-nw" variants are the same three gestures driven from the
   * other side, so they pin the opposite edge instead of the left/top one:
   * `right` and `bottom` below are that anchor, in screen pixels, frozen for
   * the session.
   */
  var drag = null;

  function onPointerDown(ev) {
    if (!editing || ev.button !== 0) return;
    var handle = ev.target.closest(".ig-item__handle");
    var item = ev.target.closest(".ig-item");
    if (!item) return;
    var id = item.getAttribute("data-id");
    var l = layout[id];
    drag = {
      el: item,
      id: id,
      mode: handle ? handle.getAttribute("data-resize") || "scale" : "move",
      startX: ev.clientX,
      startY: ev.clientY,
      origX: l.x,
      origY: l.y,
      origScale: l.scale,
      baseW: item.offsetWidth,
      baseH: item.offsetHeight,
    };
    drag.right = drag.origX + drag.baseW * drag.origScale;
    drag.bottom = drag.origY + drag.baseH * drag.origScale;
    ev.preventDefault();
  }

  function onPointerMove(ev) {
    if (!drag) return;
    var l = layout[drag.id];
    var dxScreen = ev.clientX - drag.startX;
    var dyScreen = ev.clientY - drag.startY;

    if (drag.mode === "scale") {
      // Dragging the corner: new scale = scaled width / natural width.
      var s = (drag.baseW * drag.origScale + dxScreen) / drag.baseW;
      l.scale = Math.round(clampNum(s, MIN_SCALE, MAX_SCALE) * 100) / 100;
    } else if (drag.mode === "scale-nw") {
      // Same, from the top-left: the bottom-right corner is what stays put, so
      // dragging away from the widget grows it and x/y follow the pointer.
      var sn = (drag.baseW * drag.origScale - dxScreen) / drag.baseW;
      l.scale = Math.round(clampNum(sn, MIN_SCALE, MAX_SCALE) * 100) / 100;
      l.x = Math.round(Math.max(0, drag.right - drag.baseW * l.scale));
      l.y = Math.round(Math.max(0, drag.bottom - drag.baseH * l.scale));
    } else if (drag.mode === "width" || drag.mode === "height") {
      // The box is drawn scaled, so the cursor travels `scale` screen pixels for
      // every pixel of box: divide, or the edge runs away from the pointer on a
      // widget that has also been scaled up.
      if (drag.mode === "width") {
        var w = drag.baseW + dxScreen / drag.origScale;
        l.w = Math.round(clampNum(w, MIN_W, window.innerWidth));
      } else {
        var h = drag.baseH + dyScreen / drag.origScale;
        l.h = Math.round(clampNum(h, MIN_H, window.innerHeight));
      }
    } else if (drag.mode === "width-w" || drag.mode === "height-n") {
      // The mirror of the above: the box grows as the pointer moves away from
      // the widget, and the anchored edge holds while x/y absorb the change.
      // Capped so the anchor cannot drag the moving edge off the top or left —
      // that is how a widget becomes unreachable in the first place.
      if (drag.mode === "width-w") {
        var wn = drag.baseW - dxScreen / drag.origScale;
        var capW = Math.max(MIN_W, Math.min(window.innerWidth, drag.right / drag.origScale));
        l.w = Math.round(clampNum(wn, MIN_W, capW));
        l.x = Math.round(Math.max(0, drag.right - l.w * drag.origScale));
      } else {
        var hn = drag.baseH - dyScreen / drag.origScale;
        var capH = Math.max(MIN_H, Math.min(window.innerHeight, drag.bottom / drag.origScale));
        l.h = Math.round(clampNum(hn, MIN_H, capH));
        l.y = Math.round(Math.max(0, drag.bottom - l.h * drag.origScale));
      }
    } else {
      var x = drag.origX + dxScreen;
      var y = drag.origY + dyScreen;
      // Keep at least a grabbable sliver on screen.
      var maxX = window.innerWidth - 40;
      var maxY = window.innerHeight - 40;
      l.x = Math.round(Math.min(maxX, Math.max(40 - drag.el.offsetWidth * l.scale, x)));
      l.y = Math.round(Math.min(maxY, Math.max(0, y)));
    }
    applyItem(drag.el);
  }

  function onPointerUp() {
    if (!drag) return;
    var wasResize = drag.mode !== "move";
    drag = null;
    // Settle a resize back into the window. Moving is left alone — the drag
    // clamp above deliberately lets a widget hang off the left edge, and
    // undoing that on every release would fight the operator. Resizing has no
    // such intent behind it, and a widget grown past the bottom is exactly the
    // state whose handles cannot be reached again. Doing it here also lets a
    // widget taller than the screen converge: each pull of the top edge
    // shortens it, and the release brings the new bottom back into view.
    if (wasResize) ensureOnScreen();
    saveLayout();
  }

  /**
   * Double-click a handle to give that dimension back to the widget: the design
   * width, content height, or 1:1 scale. Without this, a height dragged too
   * short could only be undone by guessing the original back or resetting the
   * whole layout.
   */
  function onDoubleClick(ev) {
    if (!editing) return;
    var handle = ev.target.closest(".ig-item__handle");
    var item = ev.target.closest(".ig-item");
    if (!handle || !item) return;
    var l = layout[item.getAttribute("data-id")];
    // Either side of a pair resets the same dimension: "height-n" → "height".
    var mode = (handle.getAttribute("data-resize") || "scale").split("-")[0];
    if (mode === "width") delete l.w;
    else if (mode === "height") delete l.h;
    else l.scale = 1;
    applyItem(item);
    saveLayout();
    ev.preventDefault();
  }

  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("dblclick", onDoubleClick);

  /* --------------------------------- boot -------------------------------- */

  if (bridge) {
    bridge.onEdit(function (on) {
      setEditing(on);
    });
    if (bridge.onInteract) {
      bridge.onInteract(function (on) {
        setInteracting(on);
      });
    }
    bridge.onLayoutReset(function () {
      resetLayout();
    });
  } else {
    // Plain-browser preview: allow editing directly for a quick play.
    setEditing(true);
  }

  loadLayout().then(function (saved) {
    if (saved && typeof saved === "object") {
      for (var id in saved) {
        var l = saved[id];
        if (l && isFinite(l.x) && isFinite(l.y)) {
          var entry = {
            x: Math.round(l.x),
            y: Math.round(l.y),
            scale: isFinite(l.scale) ? clampNum(l.scale, MIN_SCALE, MAX_SCALE) : 1,
          };
          // Width/height are optional: absent means "the widget's own size",
          // which is not the same as a stored value of 0.
          if (isFinite(l.w) && l.w > 0) entry.w = Math.round(clampNum(l.w, MIN_W, 4000));
          if (isFinite(l.h) && l.h > 0) entry.h = Math.round(clampNum(l.h, MIN_H, 4000));
          layout[id] = entry;
        }
      }
    }
    applyAll();
  });
})();
