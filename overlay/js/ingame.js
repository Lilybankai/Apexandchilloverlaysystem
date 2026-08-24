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
 * MULTI-MONITOR: the window spans the whole desktop, not one screen, so widgets
 * can be dragged onto a side monitor of a triple-screen rig that is not running
 * NVIDIA Surround. Placement is stored relative to the PRIMARY display, so a
 * one-screen rig is unaffected in every particular and a widget on a left-hand
 * screen simply carries a negative x — see the geometry section below. Screens
 * above and below work the same way, through padY instead of padX; the edit
 * chrome is put back on the primary display by hand (see placeChrome), because
 * centring it on the window would leave it on a different monitor from the
 * widgets being dragged.
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

  /** Ceiling on a stored width/height, matching normalizeLayoutEntry in main. */
  var MAX_ITEM = 4000;

  function clampNum(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /* ------------------------------- geometry ------------------------------- */
  /*
   * The window spans the WHOLE desktop, not one screen, so that a triple-screen
   * rig without NVIDIA Surround — where Windows reports three separate displays
   * rather than one wide one — has somewhere to drag a widget to. On a single
   * monitor (and under Surround, which presents as a single monitor) the desktop
   * IS that screen and every number below collapses to what it always was.
   *
   * Layout coordinates are measured from the top-left of the PRIMARY display,
   * which is why saved layouts did not have to move when the window grew: a
   * widget at {x: 24} is still 24px from the left of the main screen. Widgets on
   * a left-hand screen carry a negative x, so nothing here may assume 0 is the
   * left edge — `minX()`/`minY()` are that edge, and they are only 0 when
   * nothing is placed left of / above the primary display.
   */

  /** Geometry for a plain browser, where there is no app to ask: one screen. */
  function fallbackSpan() {
    return {
      padX: 0,
      padY: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      primary: { width: window.innerWidth, height: window.innerHeight },
      rects: [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }],
    };
  }

  /** Accept only a complete, sane geometry — anything else falls back. */
  function normalizeSpan(s) {
    if (!s || !isFinite(s.width) || !isFinite(s.height) || s.width <= 0 || s.height <= 0) {
      return fallbackSpan();
    }
    var rects = [];
    if (Object.prototype.toString.call(s.rects) === "[object Array]") {
      for (var i = 0; i < s.rects.length; i++) {
        var r = s.rects[i];
        if (r && isFinite(r.x) && isFinite(r.y) && r.width > 0 && r.height > 0) {
          rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
        }
      }
    }
    var pw = s.primary && s.primary.width > 0 ? s.primary.width : s.width;
    var ph = s.primary && s.primary.height > 0 ? s.primary.height : s.height;
    if (!rects.length) rects = [{ x: 0, y: 0, width: pw, height: ph }];
    return {
      padX: isFinite(s.padX) ? s.padX : 0,
      padY: isFinite(s.padY) ? s.padY : 0,
      width: s.width,
      height: s.height,
      primary: { width: pw, height: ph },
      rects: rects,
    };
  }

  /*
   * Seeded with the one-screen fallback rather than left empty until the real
   * geometry arrives: the app pushes edit mode as soon as the page loads (the
   * Off → Edit step of the hotkey cycle does exactly that), which can land
   * before the fetch resolves, and everything that positions a widget reads it.
   */
  var span = fallbackSpan();

  /* The desktop's edges, in layout coordinates. */
  function minX() {
    return -span.padX;
  }
  function minY() {
    return -span.padY;
  }
  function maxX() {
    return -span.padX + span.width;
  }
  function maxY() {
    return -span.padY + span.height;
  }

  function rectsOverlap(a, b) {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }

  /** The screen whose centre is closest to this box's — the rescue target. */
  function nearestScreen(box) {
    var cx = box.x + box.width / 2;
    var cy = box.y + box.height / 2;
    var best = span.rects[0];
    var bestD = Infinity;
    for (var i = 0; i < span.rects.length; i++) {
      var r = span.rects[i];
      var dx = r.x + r.width / 2 - cx;
      var dy = r.y + r.height / 2 - cy;
      var d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  /**
   * The rectangle a widget is allowed to settle inside: the screens it currently
   * touches, merged.
   *
   *   - one screen — the single-monitor case, and the normal triple-screen one —
   *     gives back that screen, so this behaves exactly as the old clamp to the
   *     window did;
   *   - two, because it has been deliberately straddled across a bezel, gives
   *     back both, so the straddle survives being tidied up but the widget still
   *     cannot run off the bottom;
   *   - none, because it has been dropped in the dead space that a staggered or
   *     L-shaped arrangement leaves inside the desktop rectangle, gives back the
   *     nearest screen. That is the rescue: without it a widget dragged into a
   *     gap between two differently-sized monitors is simply invisible, on no
   *     screen at all, with no handle to drag it back by.
   */
  function homeRect(box) {
    var hit = [];
    for (var i = 0; i < span.rects.length; i++) {
      if (rectsOverlap(box, span.rects[i])) hit.push(span.rects[i]);
    }
    if (!hit.length) hit = [nearestScreen(box)];
    var l = Infinity;
    var t = Infinity;
    var r = -Infinity;
    var b = -Infinity;
    for (var j = 0; j < hit.length; j++) {
      l = Math.min(l, hit[j].x);
      t = Math.min(t, hit[j].y);
      r = Math.max(r, hit[j].x + hit[j].width);
      b = Math.max(b, hit[j].y + hit[j].height);
    }
    return { x: l, y: t, width: r - l, height: b - t };
  }

  /** Default placement per widget id (px, for a generic 16:9 screen). */
  function defaultsFor(id, vw, vh) {
    var D = {
      // 560, not the 474 it shipped at: the driver cell carries the class tag,
      // the brand badge and the DR/SR rating pair as well as the name, and those
      // marks hold ~82px whatever the name is. At 474 that left ~71px for
      // "#23 " plus the name — enough for "Matt.H" and not for "M.Haskins" or
      // any full name, so the tower's own default clipped the column it exists
      // to show. The extra 86px all lands on the name: the driver <col> is the
      // one with no width of its own and absorbs whatever is left (see the
      // colgroup in widgets/standings.js). Anyone who wants the narrower tower
      // back can drag it there — a width the operator has set is stored and
      // wins over this (see applyItem), so this moves nobody who has already
      // sized it.
      standings: { x: 24, y: 24, w: 560 },
      weather: { x: Math.round(vw / 2 - 220), y: 24, w: 440 },
      // Docked into the speedo cluster's top-centre notch, on the same centre
      // line (both widgets are centred on vw/2, so x needs no coupling). The y
      // here is only a pre-measurement guess — the cluster's own default top
      // (vh - 210) plus a 25.5px notch, less the delta's ~112px natural height.
      // That height is not knowable before the widget is on screen and is wrong
      // at any text scale but 1.0, so seatDeltaDefault() measures the real
      // plateau after layout and corrects this. Keep the guess close anyway: it
      // is what shows for the frame or two before the correction lands.
      delta: { x: Math.round(vw / 2 - 150), y: vh - 296, w: 300 },
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
      // Dead centre along the bottom edge, and wider than the readout widgets:
      // it is a cluster, read the way a real one is — straight ahead, in
      // peripheral vision. An id with no entry here spawns at {24, 24} on top
      // of standings, which reads as the overlay having failed to load.
      speedo: { x: Math.round(vw / 2 - 245), y: vh - 210, w: 490 },
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

  /**
   * Extra panel width an OPTIONAL column is currently claiming, per widget.
   *
   * The standings tower's AVG column (last-5 average) is 70px of table that
   * would otherwise come out of the driver names — the one column with no
   * width of its own. So while the setting is on, the panel itself is drawn
   * that much wider, on top of whatever width is stored or default; stored
   * widths stay in "no column" units (the width drags below subtract the bump
   * before saving), so toggling the setting moves the panel edge and nothing
   * else, and turning it off gives exactly that width back.
   */
  var standingsAvgOn = false;
  function widthBumpFor(id) {
    return id === "standings" && standingsAvgOn ? 70 : 0;
  }
  if (window.ApexAppearance && window.ApexAppearance.onStandings) {
    window.ApexAppearance.onStandings(function (next) {
      var on = !!(next && next.avg === "on");
      if (on === standingsAvgOn) return;
      standingsAvgOn = on;
      applyAll();
    });
  }

  function applyItem(el) {
    var id = el.getAttribute("data-id");
    // Sized to the PRIMARY display, never to the whole desktop: a default layout
    // is a starting point on the screen the driver is looking through, and
    // spreading it over 5760px would scatter the widgets across three monitors
    // and read as a broken overlay. The side screens start empty and stay that
    // way until something is dragged onto them.
    var d = defaultsFor(id, span.primary.width, span.primary.height);
    var l = layout[id] || { x: d.x, y: d.y, scale: 1 };
    layout[id] = l;
    // Width: the operator's stretched width when they have set one, otherwise
    // the widget's design width (the same one the OBS pages use) — plus
    // whatever an optional column is currently claiming (see widthBumpFor).
    el.style.width = (l.w || d.w) + widthBumpFor(id) + "px";
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
    // Layout coordinates are measured from the primary display; the window
    // starts at the top-left of the whole desktop. padX/padY bridge the two, and
    // are 0 unless there is a screen left of / above the main one.
    el.style.left = l.x + span.padX + "px";
    el.style.top = l.y + span.padY + "px";
    el.style.transform = l.scale === 1 ? "" : "scale(" + l.scale + ")";
    // Re-cut the delta's notch. This is the single write path for position AND
    // size, which is exactly what the cut depends on — and a ResizeObserver
    // cannot see it, because MOVING a widget does not resize it. Cheap enough to
    // run unconditionally: it early-outs on any page without both widgets, and
    // the cluster is only measured when it is the design that has a notch.
    refitNotch(id);
  }

  /**
   * Ask notch-dock.js to re-measure after either of the two widgets involved has
   * moved or been resized. Guarded on the ids so dragging the standings tower
   * does not measure the cluster on every pointermove.
   */
  function refitNotch(id) {
    if (id !== "delta" && id !== "speedo") return;
    var dock = window.ApexNotchDock;
    if (dock) dock.measure();
  }

  /**
   * Tell the canvas widgets their on-screen size may have changed.
   *
   * `transform: scale()` is not a layout change, so neither ResizeObserver nor
   * the window's own resize event fires when a widget is scaled — but the scale
   * is exactly what decides how many pixels a canvas needs (see
   * overlay/js/raster.js). Without this a widget scaled up in edit mode would
   * keep its old bitmap until something else happened to disturb it: about half
   * a second for the widgets with a frame-count backstop, and indefinitely for
   * the track map, which has no such backstop and would simply stay soft for the
   * rest of the session.
   *
   * A plain resize event because every canvas widget already listens for one —
   * this needs no new contract, and the widgets that do not draw to a canvas
   * ignore it. Deliberately NOT called from applyItem(): that runs on every
   * pointermove of a drag, and the track map reallocates its bitmap on each
   * call. Fired where a scale SETTLES instead — the drag release, the
   * double-click reset, and a bulk re-apply.
   */
  function nudgeCanvasSizes() {
    // Guarded for the same reason everything else in this file is: it runs on
    // the layer drawn over a live race, and a missing constructor here would
    // throw out of applyAll() and leave the whole layout unapplied. A widget
    // that stays soft is a blemish; a widget that never gets placed is not.
    if (typeof Event !== "function") return;
    window.dispatchEvent(new Event("resize"));
  }

  function applyAll() {
    for (var i = 0; i < items.length; i++) applyItem(items[i]);
    nudgeCanvasSizes();
  }

  /**
   * Outline each monitor while editing, so the operator can see which screen
   * they are dropping a widget onto. Nothing is drawn on a single-monitor rig —
   * there is only one screen and its edges are the edges of everything — so this
   * is chrome that only ever appears where it is needed. The elements live in
   * the DOM only while editing, and CSS keeps them display:none regardless
   * outside .ig-editing, so the locked layer paints none of it.
   */
  var screensEl = document.getElementById("ig-screens");

  function renderScreenGuides() {
    if (!screensEl) return;
    screensEl.textContent = "";
    if (span.rects.length < 2) return;
    for (var i = 0; i < span.rects.length; i++) {
      var r = span.rects[i];
      var g = document.createElement("div");
      g.className = "ig-screen";
      g.style.left = r.x + span.padX + "px";
      g.style.top = r.y + span.padY + "px";
      g.style.width = r.width + "px";
      g.style.height = r.height + "px";
      var tag = document.createElement("span");
      tag.className = "ig-screen__tag";
      tag.textContent = "Screen " + (i + 1) + " · " + r.width + "×" + r.height;
      g.appendChild(tag);
      screensEl.appendChild(g);
    }
  }

  /**
   * Put the edit/interact chrome on the PRIMARY display rather than in the
   * middle of the desktop.
   *
   * The toolbar, the interact banner and the notice stack are all centred with
   * CSS on the window, and the window is the whole desktop — so on a triple rig
   * they land on the middle screen, which is where the driver is looking and
   * exactly right. Stack a screen ABOVE that one and the same rule puts the
   * toolbar a monitor away from the widgets being dragged: the operator reads
   * "Editing overlays" on the top screen while working on the bottom one, and
   * the Done button is somewhere they have to go looking for.
   *
   * The primary display is the right anchor for the same reason widget defaults
   * are sized to it (see applyItem): it is the screen being raced on. padX/padY
   * put its top-left in CSS coordinates, so this is the same bridge the widgets
   * use, and on one monitor both are 0 and every value below is what the
   * stylesheet already says.
   */
  var noticesEl = null;

  function placeChrome() {
    var midX = span.padX + span.primary.width / 2;
    if (toolbar) {
      toolbar.style.left = midX + "px";
      toolbar.style.top = span.padY + 14 + "px";
    }
    if (noticesEl) {
      noticesEl.style.left = midX + "px";
      noticesEl.style.top = span.padY + span.primary.height * 0.12 + "px";
    }
    if (interactBanner) {
      interactBanner.style.left = midX + "px";
      // The banner is anchored to the window's BOTTOM by the stylesheet, so the
      // offset it needs is the gap below the primary display — the height of
      // whatever is stacked underneath — plus the 14px the design asks for.
      interactBanner.style.bottom =
        span.height - span.padY - span.primary.height + 14 + "px";
    }
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
      var box = { x: l.x, y: l.y, width: el.offsetWidth * s, height: el.offsetHeight * s };
      // Settle into the screen(s) the widget is already on rather than into the
      // window: on a triple-screen rig the window is all three, so clamping to
      // it would leave a widget hanging over a bezel into a screen the driver
      // cannot see it on, and would never rescue one dropped between two.
      var home = homeRect(box);
      // Widgets bigger than their screen pin to its top-left corner: that is the
      // corner whose handles can then reach them.
      var x = clampNum(l.x, home.x, Math.max(home.x, home.x + home.width - box.width));
      var y = clampNum(l.y, home.y, Math.max(home.y, home.y + home.height - box.height));
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
    // A mark left behind by the gesture that was in flight when edit mode ended
    // would sit on the locked layer with nothing to explain it.
    else hideMark();
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
  /* ---------------------------- magnetic docking -------------------------- */

  /*
   * Snap a widget being laid out flush against its neighbours, and give it the
   * neighbour's measurement along the edge they share.
   *
   * Laying out a screen is the one job here that is pure alignment, and it was
   * being done by eye: drag, squint, nudge one pixel, squint again. Two panels
   * that are meant to read as a row have to agree on an edge AND on a length,
   * and hitting both by hand at an arbitrary scale is not realistic.
   *
   * The rules, deliberately few:
   *   - A seam takes when the moving edge comes within SNAP_PX of a neighbour's
   *     edge. Measured in SCREEN pixels, so the magnet feels the same distance
   *     regardless of what either widget is scaled to.
   *   - x and y are decided independently, which is what makes corner-to-corner
   *     snapping fall out without a special case for it.
   *   - Butting up against a neighbour (a seam) also matches the shared edge's
   *     LENGTH: side-by-side matches height, stacked matches width. Merely
   *     lining up with a far edge does not — that is an alignment, not a dock,
   *     and resizing on it would be a surprise.
   *   - Alt suppresses the whole thing for one gesture, for the placement that
   *     genuinely wants to sit 3px off a neighbour.
   *
   * Corner-scale drags are left alone on purpose: `l.scale` is quantised to two
   * decimals, so on a 490px widget one step is ~4.9px and the edge the operator
   * is aiming at is usually not reachable at all. A magnet that visibly refuses
   * to land is worse than no magnet.
   */

  /** How close an edge has to come before it takes, in screen pixels. */
  var SNAP_PX = 12;

  /** Whether the operator has the feature on at all (Settings → Display). */
  var magnetic = false;

  /**
   * The visual box of a widget in LAYOUT coordinates. Layout and CSS space
   * differ by a constant (span.padX/padY) that every widget shares, so distances
   * between two widgets are identical in both and the padding never enters here.
   * The size is the DRAWN size: `transform: scale()` with a top-left origin, so
   * the box grows right and down from an unmoved x/y.
   */
  function boxOf(el, l) {
    var s = l.scale || 1;
    return { x: l.x, y: l.y, w: el.offsetWidth * s, h: el.offsetHeight * s };
  }

  /**
   * Every other widget's box, as snap candidates. Hidden widgets are skipped —
   * an id that is not on this layer has no edges to offer.
   */
  function neighbourBoxes(exceptId) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var id = el.getAttribute("data-id");
      if (id === exceptId) continue;
      var l = layout[id];
      if (!l || !el.offsetWidth || !el.offsetHeight) continue;
      out.push(boxOf(el, l));
    }
    return out;
  }

  /**
   * The best correction along one axis, or null. `moving` is the pair of edges
   * the dragged widget presents on this axis (near, far); each neighbour offers
   * its own pair. A seam is a near-to-far or far-to-near meeting — the two
   * widgets end up touching — while near-to-near or far-to-far is an alignment.
   *
   * Returns the delta to ADD to the widget's position, plus whether the winner
   * was a seam (which is what earns a size match) and the neighbour behind it.
   */
  function bestSnap(nearEdge, farEdge, boxes, nearOf, farOf) {
    var best = null;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var bNear = nearOf(b);
      var bFar = farOf(b);
      var cands = [
        { d: bFar - nearEdge, seam: true }, // our near edge onto their far
        { d: bNear - farEdge, seam: true }, // our far edge onto their near
        { d: bNear - nearEdge, seam: false }, // near edges flush
        { d: bFar - farEdge, seam: false }, // far edges flush
      ];
      for (var c = 0; c < cands.length; c++) {
        var cand = cands[c];
        if (Math.abs(cand.d) > SNAP_PX) continue;
        // A seam wins ties against a mere alignment: when a widget is dropped
        // into a corner both are available at the same distance, and touching
        // the neighbour is what the operator was aiming at.
        if (
          !best ||
          Math.abs(cand.d) < Math.abs(best.d) - 0.01 ||
          (cand.seam && !best.seam && Math.abs(cand.d) <= Math.abs(best.d) + 0.01)
        ) {
          best = { d: cand.d, seam: cand.seam, box: b };
        }
      }
    }
    return best;
  }

  /**
   * Apply magnetic docking to a MOVE in progress. `l` has already been set to
   * the unsnapped position; size is restored to its pre-drag value by the caller
   * so every frame is decided from the same base rather than from the last
   * frame's answer.
   */
  function snapMove(el, l, id) {
    var boxes = neighbourBoxes(id);
    if (!boxes.length) return null;

    var s = l.scale || 1;
    var w = drag.baseW * s;
    var h = drag.baseH * s;

    var sx = bestSnap(
      l.x, l.x + w, boxes,
      function (b) { return b.x; },
      function (b) { return b.x + b.w; },
    );
    var sy = bestSnap(
      l.y, l.y + h, boxes,
      function (b) { return b.y; },
      function (b) { return b.y + b.h; },
    );

    if (sx) l.x = Math.round(l.x + sx.d);
    if (sy) l.y = Math.round(l.y + sy.d);

    // Match the shared edge. A vertical seam (widgets side by side) shares a
    // height; a horizontal one shares a width. Only one can apply — a widget
    // cannot be flush on both axes at once without overlapping its neighbour.
    if (sx && sx.seam) matchHeight(l, sx.box, s);
    else if (sy && sy.seam) matchWidth(l, id, sy.box, s);

    if (!sx && !sy) return null;
    return { x: sx, y: sy, w: w, h: h };
  }

  /** Give the widget the neighbour's drawn height, in its own pre-scale units. */
  function matchHeight(l, box, s) {
    l.h = Math.round(clampNum(box.h / s, MIN_H, MAX_ITEM));
  }

  /**
   * Give the widget the neighbour's drawn width. The stored width is in no-bump
   * units (see widthBumpFor) while the drawn one includes it, so the bump comes
   * back out or the standings tower gains its optional column's width on every
   * snap.
   */
  function matchWidth(l, id, box, s) {
    l.w = Math.round(clampNum(box.w / s - widthBumpFor(id), MIN_W, MAX_ITEM));
  }

  /**
   * Apply magnetic docking to an EDGE resize in progress: the edge under the
   * pointer looks for a neighbour's parallel edge and takes it. Because the
   * opposite edge is pinned by the gesture, landing the moving one on a
   * neighbour's edge IS the size match — there is nothing extra to do.
   */
  function snapResize(el, l, id, mode) {
    var boxes = neighbourBoxes(id);
    if (!boxes.length) return null;
    var s = l.scale || 1;
    var horizontal = mode === "width" || mode === "width-w";
    var bump = horizontal ? widthBumpFor(id) : 0;

    // Where the moving edge is now, and which neighbour edges it may take.
    var edge = horizontal
      ? mode === "width" ? l.x + (l.w + bump) * s : l.x
      : mode === "height" ? l.y + l.h * s : l.y;

    var best = null;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var offers = horizontal ? [b.x, b.x + b.w] : [b.y, b.y + b.h];
      for (var o = 0; o < offers.length; o++) {
        var d = offers[o] - edge;
        if (Math.abs(d) > SNAP_PX) continue;
        if (!best || Math.abs(d) < Math.abs(best.d)) best = { d: d, box: b, at: offers[o] };
      }
    }
    if (!best) return null;

    // Grow or shrink by the correction, keeping the anchored edge where it is.
    if (mode === "width") {
      l.w = Math.round(clampNum(l.w + best.d / s, MIN_W, MAX_ITEM));
    } else if (mode === "height") {
      l.h = Math.round(clampNum(l.h + best.d / s, MIN_H, MAX_ITEM));
    } else if (mode === "width-w") {
      var wn = Math.round(clampNum(l.w - best.d / s, MIN_W, MAX_ITEM));
      l.x = Math.round(l.x + (l.w - wn) * s);
      l.w = wn;
    } else {
      var hn = Math.round(clampNum(l.h - best.d / s, MIN_H, MAX_ITEM));
      l.y = Math.round(l.y + (l.h - hn) * s);
      l.h = hn;
    }
    return { edge: best, horizontal: horizontal };
  }

  /* --------------------------- the magnet mark ---------------------------- */

  /*
   * Feedback for a snap that has taken. Follows renderScreenGuides' pattern —
   * absolutely positioned, pointer-events:none, CSS-gated on .ig-editing — but
   * with an explicit z-index, because unlike the screen outlines this has to
   * read IN FRONT of the widget it is describing and of its resize handles.
   */
  var markEl = null;

  function magnetMark() {
    if (markEl) return markEl;
    markEl = document.createElement("div");
    markEl.className = "ig-snap";
    // Inline, not a sprite: the overlay pages have no icon system (the '#i-*'
    // sprite lives in the control panel), and a magnet is three paths.
    markEl.innerHTML =
      '<svg class="ig-snap__mark" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M7 3v9a5 5 0 0 0 10 0V3h-4v9a1 1 0 0 1-2 0V3z"/>' +
      '<rect x="7" y="3" width="4" height="3.4"/>' +
      '<rect x="13" y="3" width="4" height="3.4"/>' +
      "</svg>";
    document.body.appendChild(markEl);
    return markEl;
  }

  /** Draw the mark along a seam, in CSS coordinates. */
  function showMark(x, y, len, horizontal) {
    var el = magnetMark();
    el.setAttribute("data-axis", horizontal ? "v" : "h");
    el.style.left = x + span.padX + "px";
    el.style.top = y + span.padY + "px";
    if (horizontal) el.style.height = Math.max(24, len) + "px";
    else el.style.width = Math.max(24, len) + "px";
    el.setAttribute("data-on", "true");
  }

  function hideMark() {
    if (markEl) markEl.removeAttribute("data-on");
  }

  /**
   * Put the mark on whichever seam actually took. Alignments get no mark: the
   * edges being flush is its own feedback, and a magnet on every near-miss
   * would strobe across the screen through the whole drag.
   */
  function markFromMove(l, snap) {
    if (!snap) return hideMark();
    if (snap.x && snap.x.seam) {
      var b = snap.x.box;
      var top = Math.max(l.y, b.y);
      var bot = Math.min(l.y + (l.h ? l.h * (l.scale || 1) : snap.h), b.y + b.h);
      var edgeX = l.x <= b.x ? l.x + snap.w : l.x;
      return showMark(edgeX, top, Math.max(0, bot - top), true);
    }
    if (snap.y && snap.y.seam) {
      var b2 = snap.y.box;
      var lft = Math.max(l.x, b2.x);
      var rgt = Math.min(l.x + (l.w ? snap.w : snap.w), b2.x + b2.w);
      var edgeY = l.y <= b2.y ? l.y + snap.h : l.y;
      return showMark(lft, edgeY, Math.max(0, rgt - lft), false);
    }
    hideMark();
  }

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
      // The size before the magnet touched it. A move that snaps also RESIZES
      // the widget, so every frame has to start from this rather than from the
      // last frame's answer — otherwise a drag along a row of panels would
      // ratchet the widget through each neighbour's height in turn.
      origW: l.w,
      origH: l.h,
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
      l.x = Math.round(Math.max(minX(), drag.right - drag.baseW * l.scale));
      l.y = Math.round(Math.max(minY(), drag.bottom - drag.baseH * l.scale));
    } else if (drag.mode === "width" || drag.mode === "height") {
      // The box is drawn scaled, so the cursor travels `scale` screen pixels for
      // every pixel of box: divide, or the edge runs away from the pointer on a
      // widget that has also been scaled up.
      if (drag.mode === "width") {
        // baseW was measured with any optional-column bump in it; the stored
        // width stays in no-bump units, so applyItem's re-add tracks the
        // pointer exactly instead of compounding 70px per drag.
        var w = drag.baseW + dxScreen / drag.origScale - widthBumpFor(drag.id);
        l.w = Math.round(clampNum(w, MIN_W, Math.min(span.width, MAX_ITEM)));
      } else {
        var h = drag.baseH + dyScreen / drag.origScale;
        l.h = Math.round(clampNum(h, MIN_H, Math.min(span.height, MAX_ITEM)));
      }
    } else if (drag.mode === "width-w" || drag.mode === "height-n") {
      // The mirror of the above: the box grows as the pointer moves away from
      // the widget, and the anchored edge holds while x/y absorb the change.
      // Capped so the anchor cannot drag the moving edge off the top or left of
      // the desktop — that is how a widget becomes unreachable in the first
      // place. The cap is the run from the anchored edge back to that edge, so
      // it has to be measured from minX/minY rather than from 0: on a left-hand
      // screen the anchor's own coordinate is negative, and dividing that
      // straight through would collapse the cap to the minimum and refuse to
      // widen the widget at all.
      if (drag.mode === "width-w") {
        // Same no-bump storage as the right-edge drag above; the anchor math
        // below has to hold the VISUAL right edge, so the bump goes back in.
        var bump = widthBumpFor(drag.id);
        var wn = drag.baseW - dxScreen / drag.origScale - bump;
        var runW = (drag.right - minX()) / drag.origScale;
        var capW = Math.max(MIN_W, Math.min(MAX_ITEM, runW));
        l.w = Math.round(clampNum(wn, MIN_W, capW));
        l.x = Math.round(Math.max(minX(), drag.right - (l.w + bump) * drag.origScale));
      } else {
        var hn = drag.baseH - dyScreen / drag.origScale;
        var runH = (drag.bottom - minY()) / drag.origScale;
        var capH = Math.max(MIN_H, Math.min(MAX_ITEM, runH));
        l.h = Math.round(clampNum(hn, MIN_H, capH));
        l.y = Math.round(Math.max(minY(), drag.bottom - l.h * drag.origScale));
      }
    } else {
      var x = drag.origX + dxScreen;
      var y = drag.origY + dyScreen;
      // Keep at least a grabbable sliver on the desktop — which on a
      // triple-screen rig is all three screens, so a widget can be carried from
      // the middle one to either side in a single drag. Bezels are not stopped
      // at: the pointer crosses them freely and onPointerUp settles the widget
      // onto whichever screen it was let go over.
      l.x = Math.round(
        clampNum(x, minX() + 40 - drag.el.offsetWidth * l.scale, maxX() - 40),
      );
      l.y = Math.round(clampNum(y, minY(), maxY() - 40));
    }

    // The magnet runs LAST, on top of whatever the gesture produced. Doing it
    // here rather than inside each branch means it sees the clamped, on-screen
    // position every branch has already agreed on, and one rule covers all six.
    if (magnetic && !ev.altKey) {
      if (drag.mode === "move") {
        // Back out any size the previous frame's snap applied, so this frame is
        // decided from the widget as the operator picked it up.
        if (drag.origW === undefined) delete l.w;
        else l.w = drag.origW;
        if (drag.origH === undefined) delete l.h;
        else l.h = drag.origH;
        markFromMove(l, snapMove(drag.el, l, drag.id));
      } else if (drag.mode !== "scale" && drag.mode !== "scale-nw") {
        var hit = snapResize(drag.el, l, drag.id, drag.mode);
        if (hit) {
          var s2 = l.scale || 1;
          if (hit.horizontal) {
            showMark(hit.edge.at, Math.min(l.y, hit.edge.box.y),
              Math.abs(l.y - hit.edge.box.y) + Math.max(l.h ? l.h * s2 : drag.baseH * s2, hit.edge.box.h), true);
          } else {
            showMark(Math.min(l.x, hit.edge.box.x), hit.edge.at,
              Math.abs(l.x - hit.edge.box.x) + Math.max(l.w ? l.w * s2 : drag.baseW * s2, hit.edge.box.w), false);
          }
        } else {
          hideMark();
        }
      }
    }
    applyItem(drag.el);
  }

  /**
   * Pull back a widget that has been let go somewhere no screen actually is.
   *
   * Only fires when the widget overlaps NO display, which on a single monitor
   * cannot happen — the drag clamp always keeps 40px of it inside the one
   * screen — so this costs one-monitor rigs nothing and never fights the
   * deliberate hang-off-the-edge that onPointerUp protects below. What it
   * catches is the triple-screen case: three monitors of different heights, or
   * a side screen in portrait, leave gaps inside the desktop rectangle that a
   * widget can be dropped into and vanish, with no handle left to drag it back.
   */
  function rescueOffScreen(el, l) {
    if (!el.offsetHeight) return false;
    var s = l.scale || 1;
    var box = { x: l.x, y: l.y, width: el.offsetWidth * s, height: el.offsetHeight * s };
    for (var i = 0; i < span.rects.length; i++) {
      if (rectsOverlap(box, span.rects[i])) return false;
    }
    var home = nearestScreen(box);
    l.x = Math.round(clampNum(l.x, home.x, Math.max(home.x, home.x + home.width - box.width)));
    l.y = Math.round(clampNum(l.y, home.y, Math.max(home.y, home.y + home.height - box.height)));
    applyItem(el);
    return true;
  }

  function onPointerUp() {
    if (!drag) return;
    var wasResize = drag.mode !== "move";
    var movedEl = drag.el;
    var movedLayout = layout[drag.id];
    drag = null;
    hideMark();
    // Settle a resize back into the window. Moving is left alone — the drag
    // clamp above deliberately lets a widget hang off the left edge, and
    // undoing that on every release would fight the operator. Resizing has no
    // such intent behind it, and a widget grown past the bottom is exactly the
    // state whose handles cannot be reached again. Doing it here also lets a
    // widget taller than the screen converge: each pull of the top edge
    // shortens it, and the release brings the new bottom back into view.
    if (wasResize) ensureOnScreen();
    else if (movedLayout) rescueOffScreen(movedEl, movedLayout);
    // The scale has settled: let the canvases re-cut their bitmaps to the size
    // the widget actually ended up at.
    if (wasResize) nudgeCanvasSizes();
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
    nudgeCanvasSizes();
    saveLayout();
    ev.preventDefault();
  }

  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("dblclick", onDoubleClick);

  /* -------------------------------- notices ------------------------------ */

  /**
   * Transient feedback for a bound button (`ingame:notice` from main). A wheel
   * press whose action fails silently reads as a dead button — the driver is
   * looking at the track, not at a console — so the result is shown here, on
   * the layer that is already over the sim. Stacked newest-last; errors stay
   * long enough to read a sentence, confirmations are a glance.
   */
  var noticeBox = null;
  function showNotice(n) {
    if (!n || !n.text) return;
    if (!noticeBox) {
      noticeBox = document.createElement("div");
      noticeBox.className = "ig-notices";
      noticeBox.setAttribute("aria-live", "polite");
      document.body.appendChild(noticeBox);
      // Built on the first notice rather than at boot, so it misses the
      // placement pass the rest of the chrome gets. Anchor it now.
      noticesEl = noticeBox;
      placeChrome();
    }
    var el = document.createElement("div");
    el.className = "ig-notice" + (n.kind === "error" ? " ig-notice--error" : "");
    el.textContent = n.text;
    noticeBox.appendChild(el);
    // Keep a burst of presses readable rather than a tower of stale ones.
    while (noticeBox.children.length > 3) noticeBox.removeChild(noticeBox.firstChild);
    setTimeout(function () {
      el.setAttribute("data-hide", "true");
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 400);
    }, n.kind === "error" ? 6000 : 2500);
  }

  /* --------------------------------- boot -------------------------------- */

  if (bridge) {
    if (bridge.onNotice) bridge.onNotice(showNotice);
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
    // Magnetic docking: read once, then follow the switch. Guarded because an
    // older preload will not have it — the layer is served over HTTP and can be
    // opened by a build whose main process predates this bridge method.
    if (bridge.getDocking) {
      Promise.resolve(bridge.getDocking()).then(
        function (on) {
          magnetic = !!on;
        },
        function () {
          magnetic = false;
        },
      );
    }
    if (bridge.onDocking) {
      bridge.onDocking(function (on) {
        magnetic = !!on;
        if (!magnetic) hideMark();
      });
    }
    if (bridge.onScreens) {
      // The desktop changed shape under a running layer (monitor plugged in,
      // resolution changed). Re-place every widget, because the window's own
      // origin may have moved and padX/padY with it — but leave the saved
      // coordinates alone. A screen that disappears takes its widgets out of
      // view rather than collapsing them onto the survivors, so plugging it
      // back in restores the layout instead of having destroyed it; entering
      // edit mode is what tidies up anything genuinely stranded.
      bridge.onScreens(function (s) {
        span = normalizeSpan(s);
        renderScreenGuides();
        placeChrome();
        applyAll();
      });
    }
  } else {
    // Plain-browser preview: allow editing directly for a quick play.
    setEditing(true);
  }

  /** Desktop geometry from the app; one screen when opened in a browser. */
  function loadScreens() {
    if (bridge && bridge.getScreens) {
      return Promise.resolve(bridge.getScreens()).then(normalizeSpan, fallbackSpan);
    }
    return Promise.resolve(fallbackSpan());
  }

  Promise.all([loadLayout(), loadScreens()]).then(function (res) {
    var saved = res[0];
    span = res[1];
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
          if (isFinite(l.w) && l.w > 0) entry.w = Math.round(clampNum(l.w, MIN_W, MAX_ITEM));
          if (isFinite(l.h) && l.h > 0) entry.h = Math.round(clampNum(l.h, MIN_H, MAX_ITEM));
          layout[id] = entry;
        }
      }
    }
    // Whether the delta arrived from storage decides if its default may be
    // corrected below: an operator's placement is theirs and is never moved.
    var deltaStored = !!layout.delta;
    renderScreenGuides();
    placeChrome();
    applyAll();
    if (!deltaStored) seatDeltaDefault();
  });

  /**
   * Drop the delta's DEFAULT placement exactly onto the notch plateau.
   *
   * `defaultsFor` has to return a number before anything is on screen, so its y
   * carries a hardcoded guess at the delta's height (~112px) — and that guess is
   * wrong the moment the operator's Text size slider grows the track the widget
   * is built around, which seats the tip below the plateau and lifts the flanks
   * off the rim. Once both widgets have been laid out the real answer can simply
   * be measured, so it is.
   *
   * Deliberately not persisted: leaving it unsaved means the default re-seats
   * itself on every boot, at whatever text scale is set then. The first time the
   * operator drags the widget, onPointerUp stores their placement and this stops
   * running for good.
   */
  function seatDeltaDefault() {
    var el = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute("data-id") === "delta") el = items[i];
    }
    if (!el || typeof requestAnimationFrame !== "function") return;

    // The cluster builds its stage asynchronously, so there may be nothing to
    // measure for a few frames. Bounded: if the cluster is not on this layer at
    // all the answer never arrives, and the authored default stands.
    var tries = 0;
    function attempt() {
      var dock = window.ApexNotchDock;
      var top = dock && dock.seatTop();
      if (top == null || !layout.delta) {
        if (++tries < 30) requestAnimationFrame(attempt);
        return;
      }
      layout.delta.y = Math.round(top - span.padY);
      applyItem(el);
    }
    requestAnimationFrame(attempt);
  }
})();
