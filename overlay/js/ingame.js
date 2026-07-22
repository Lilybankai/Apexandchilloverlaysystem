/**
 * ingame.js — layout + edit-mode manager for the in-game overlay layer.
 * -----------------------------------------------------------------------------
 * Runs only on ingame.html. Owns the .ig-item wrappers around each widget:
 *   - applies saved placement ({x, y, scale} per widget) or sensible defaults
 *     mirroring the OBS combined page;
 *   - in edit mode (toggled by the app through window.apexIngame) lets the
 *     operator drag widgets and resize them via the corner handle (scale
 *     transform — widget internals never reflow);
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
      relative: { x: vw - 424, y: 24, w: 400 },
      fuel: { x: vw - 424, y: 250, w: 400 },
      tyres: { x: vw - 324, y: vh - 260, w: 300 },
      pedals: { x: Math.round(vw / 2 - 180), y: vh - 220, w: 360 },
      // Clear of `pedals` on purpose: the two are alternates and get compared
      // side by side, so spawning them on the same centre line would stack one
      // on the other and read as a widget that failed to load.
      pedalsv: { x: 24, y: vh - 270, w: 300 },
      motion: { x: vw - 260, y: vh - 420, w: 236 },
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
    el.style.width = d.w + "px";
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

  function setEditing(on) {
    editing = !!on;
    document.body.classList.toggle("ig-editing", editing);
    toolbar.hidden = !editing;
  }

  document.getElementById("ig-done").addEventListener("click", function () {
    if (bridge) {
      bridge.editDone(); // main re-locks the window and echoes onEdit(false)
    } else {
      setEditing(false);
    }
  });

  document.getElementById("ig-reset").addEventListener("click", function () {
    resetLayout();
    if (bridge) bridge.layoutReset();
  });

  /** One drag session: moving the item, or scaling it via the corner handle. */
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
      resize: !!handle,
      startX: ev.clientX,
      startY: ev.clientY,
      origX: l.x,
      origY: l.y,
      origScale: l.scale,
      baseW: item.offsetWidth,
    };
    ev.preventDefault();
  }

  function onPointerMove(ev) {
    if (!drag) return;
    var l = layout[drag.id];
    if (drag.resize) {
      // Dragging the corner: new scale = scaled width / natural width.
      var newW = drag.baseW * drag.origScale + (ev.clientX - drag.startX);
      var s = newW / drag.baseW;
      if (s < MIN_SCALE) s = MIN_SCALE;
      else if (s > MAX_SCALE) s = MAX_SCALE;
      l.scale = Math.round(s * 100) / 100;
    } else {
      var x = drag.origX + (ev.clientX - drag.startX);
      var y = drag.origY + (ev.clientY - drag.startY);
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
    drag = null;
    saveLayout();
  }

  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);

  /* --------------------------------- boot -------------------------------- */

  if (bridge) {
    bridge.onEdit(function (on) {
      setEditing(on);
    });
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
          layout[id] = {
            x: Math.round(l.x),
            y: Math.round(l.y),
            scale: isFinite(l.scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, l.scale)) : 1,
          };
        }
      }
    }
    applyAll();
  });
})();
