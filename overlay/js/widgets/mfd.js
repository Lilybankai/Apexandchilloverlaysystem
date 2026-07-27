/**
 * widgets/mfd.js — the in-game MFD (pit menu + driving aids) for the player's
 * car, readable and adjustable.
 * -----------------------------------------------------------------------------
 * Renders `frame.mfd` (see src/telemetry/types.ts MfdState): two clearly headed
 * sections, PIT STRATEGY and DRIVING AIDS, with each row colour-coded by
 * category (tyres, pressures, ducts, aero, fuel…) so related lines read as a
 * group at a glance.
 *
 * ## The selected row
 * One pit row is highlighted: the row the four BINDABLE controls (▲ ▼ + −, bound
 * to wheel buttons or a Stream Deck in the control panel) are aimed at. The
 * cursor lives on the server (server/pitCursor), because a wheel button and a
 * click on this widget have to move the same one — so the highlight here is a
 * view of that state, polled, not a local selection. Clicking a row's ± aims the
 * cursor at it too, which keeps "the thing I last touched" and "the thing my
 * buttons will change" the same row.
 *
 * URL params:
 *   ?pit=off      hide the pit-strategy section.  Default on.
 *   ?aids=off     hide the driving-aids section.  Default on.
 *   ?opacity=0.4  panel opacity (same contract as the damage/motion widgets).
 */
(function () {
  "use strict";

  var OPACITY_KEY = "apex-mfd-opacity";
  var MIN_OPACITY = 0.15;

  var headerMeta = null;
  var mountEl = null;
  var wrapEl = null;
  /** The shared widget context, kept so the render helpers can reach ctx.crit. */
  var octx = null;
  var showPit = true;
  var showAids = true;
  var disabled = false;

  // Per-group row registries, keyed by stable id, plus a signature of the id +
  // category list so the DOM is only rebuilt when the set of rows changes.
  var pit = { container: null, rowsEl: null, rows: {}, sig: "" };
  var aids = { container: null, rowsEl: null, rows: {}, sig: "" };

  /* ----------------------------- categorisation --------------------------- */

  /** Category (→ colour) for a pit-menu row, from its label. Order matters:
   *  "F BRAKE DUCT" must match DUCT before BRAKE. */
  function pitCategory(name) {
    var n = String(name || "").toUpperCase();
    if (/PRESS/.test(n)) return "pressure";
    if (/DUCT/.test(n)) return "duct";
    if (/TIRE|TYRE/.test(n)) return "tyre";
    if (/WING|GRILLE|SPLITTER|RIDE|AERO/.test(n)) return "aero";
    if (/FUEL|ENERGY/.test(n)) return "fuel";
    if (/BRAKE/.test(n)) return "brake";
    if (/DAMAGE|DRIVER/.test(n)) return "service";
    return "other";
  }

  /** Category (→ colour) for a driving aid, from its VM_ key. */
  function aidCategory(key) {
    var k = String(key || "").toUpperCase();
    if (/BRAKE/.test(k)) return "brake";
    if (/ANTILOCK|TRACTION/.test(k)) return "traction";
    if (/REGEN|ELECTRIC|MOTOR/.test(k)) return "hybrid";
    if (/ENGINE/.test(k)) return "engine";
    return "other";
  }

  /* ------------------------------- rendering ------------------------------ */

  /* ------------------------------ control plane --------------------------- */

  /**
   * Which aids LMU has bound, keyed by the `VM_*` name the frame uses:
   * `{ canInc, canDec }`. Fetched from /api/mfd/keymap, which reads LMU's own
   * keyboard.json — so an aid the driver has not bound shows no ± at all rather
   * than offering a button that could never work.
   *
   * Re-fetched periodically because the driver can rebind mid-session (LMU
   * rewrites that file on exit), and because the game may not be running when
   * the overlay first loads.
   */
  var aidBinds = {};
  /** Server-tracked estimates for the aids LMU will not report live. */
  var shadowAids = [];

  function loadAidBinds() {
    fetch("/api/mfd/keymap", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cfg) {
        if (!cfg || !Array.isArray(cfg.aids)) return;
        var next = {};
        cfg.aids.forEach(function (a) {
          var entry = { canInc: !!a.canInc, canDec: !!a.canDec };
          // Index under every alias — the frame's key for an aid is not always
          // the VM_ one (brake bias comes through as BRAKE_BIAS).
          (a.keys || [a.vmKey]).forEach(function (k) {
            if (k) next[k] = entry;
          });
        });
        // TC / ABS / motor map have no live source, so the server counts them
        // instead (see server/aidShadow). Shown as ESTIMATES, never as readings.
        shadowAids = Array.isArray(cfg.shadowAids) ? cfg.shadowAids : [];
        // Only rebuild rows if the offerable set actually changed.
        if (JSON.stringify(next) !== JSON.stringify(aidBinds)) {
          aidBinds = next;
          aids.sig = ""; // force reconcile to rebuild with/without steppers
        }
      })
      .catch(function () {
        /* server not up / route absent — rows stay read-only */
      });
  }

  /**
   * POSTs a command and resolves to the parsed reply. The server performs the
   * actual change — a browser can neither call LMU's API cross-origin nor send
   * it keystrokes — so the widget only ever posts an intent.
   */
  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().catch(function () {
          return { ok: r.ok };
        });
      })
      .catch(function () {
        return { ok: false, error: "request failed" };
      });
  }

  /** Flash a row to show a command failed, with the reason in the title. */
  function flashError(refs, message) {
    refs.root.setAttribute("data-error", "true");
    refs.root.title = message || "";
    setTimeout(function () {
      refs.root.removeAttribute("data-error");
    }, 1600);
  }

  /**
   * A ± stepper. Clicks are stopped from propagating because the in-game layer
   * starts a widget drag on pointerdown anywhere inside a widget — without this,
   * pressing + would drag the whole MFD across the screen instead.
   */
  function stepButton(glyph, onStep) {
    var b = document.createElement("button");
    b.className = "mfd__step";
    b.type = "button";
    b.textContent = glyph;
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      b.addEventListener(evt, function (e) {
        e.stopPropagation();
      });
    });
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      onStep();
    });
    return b;
  }

  /**
   * One row: LABEL … VALUE, plus ± steppers when the row is adjustable.
   * `onStep(dir)` is supplied per row by the pit/aid renderers; a row without
   * one stays exactly as read-only as it was before.
   */
  function makeRow(onStep) {
    var row = document.createElement("div");
    row.className = "mfd__row";
    var label = document.createElement("span");
    label.className = "mfd__label";
    var value = document.createElement("span");
    // Every MFD value glows on change — including the pit rows. This is the one
    // place in the overlay where a value moving is the confirmation that a
    // command LANDED: the driver clicks +, looks away, and the bloom on the next
    // frame is how they know the sim took it. Without it, success is silent and
    // only failure has a signal (data-error), which is exactly backwards.
    value.className = "mfd__value is-crit";
    row.appendChild(label);
    row.appendChild(value);
    var refs = { root: row, label: label, value: value };
    if (onStep) {
      var ctrls = document.createElement("span");
      ctrls.className = "mfd__ctrls";
      ctrls.appendChild(
        stepButton("−", function () {
          onStep(-1, refs);
        }),
      );
      ctrls.appendChild(
        stepButton("+", function () {
          onStep(1, refs);
        }),
      );
      row.appendChild(ctrls);
      row.setAttribute("data-adjustable", "true");
      refs.ctrls = ctrls;
    }
    return refs;
  }

  /**
   * (Re)builds a group's rows when the id/category set changes; else just
   * refreshes the label/value text in place. `catOf` also drives the colour
   * (data-cat) and a small gap at each category change (group-start).
   */
  function reconcile(group, items, idOf, catOf, labelOf, textOf, stepFor) {
    var sig = items
      .map(function (it) {
        return idOf(it) + ":" + catOf(it);
      })
      .join("|");
    if (sig !== group.sig) {
      group.sig = sig;
      group.rows = {};
      group.rowsEl.textContent = "";
      var prevCat = null;
      items.forEach(function (it) {
        var refs = makeRow(stepFor ? stepFor(it) : null);
        var cat = catOf(it);
        refs.root.setAttribute("data-cat", cat);
        if (cat !== prevCat) {
          refs.root.classList.add("mfd__row--group-start");
          prevCat = cat;
        }
        group.rows[idOf(it)] = refs;
        group.rowsEl.appendChild(refs.root);
      });
    }
    items.forEach(function (it) {
      var refs = group.rows[idOf(it)];
      if (!refs) return;
      setText(refs.label, labelOf(it));
      critText(refs.value, textOf(it));
    });
  }

  /* ------------------------- the selected pit row ------------------------- */

  /**
   * Where the bindable ▲ ▼ + − controls are pointing, mirrored from the server
   * (GET /api/mfd/cursor). Anchored by NAME as well as index for the same reason
   * the server is: the pit menu's shape changes with the car and the session, so
   * an index on its own quietly slides onto a different row.
   */
  var pitCursor = { index: -1, name: null, updatedAt: 0 };
  /** The rows as last rendered, so a poll can re-highlight without a frame. */
  var lastPitRows = [];
  /** Poll cadence, ms. The route answers from memory, so this is nearly free. */
  var CURSOR_POLL_MS = 120;

  /**
   * Re-read the pit menu straight from the sim and render it, instead of waiting
   * for the next telemetry frame to carry the change.
   *
   * This is what makes a change feel immediate: frames are broadcast on a poll
   * cadence, so a value the driver just altered could sit stale for a beat — long
   * enough to wonder whether the command landed. `?section=pit` because the aids
   * cannot move mid-session and the payload behind them is large; asking for the
   * whole state here doubled the time to confirm a pit change.
   *
   * Coalesced: several changes in quick succession collapse into one read rather
   * than queueing a request per keypress.
   */
  var refreshPending = false;

  function refreshNow() {
    if (refreshPending) return;
    refreshPending = true;
    fetch("/api/mfd/state?section=pit", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (res) {
        refreshPending = false;
        if (res && res.ok !== false && Array.isArray(res.pit) && res.pit.length) {
          renderPit(res.pit);
        }
      })
      .catch(function () {
        refreshPending = false;
      });
  }

  /**
   * Show a value a command has ALREADY told us, without waiting to be told again.
   *
   * The cursor endpoints return the selected row's new text, so the change can be
   * on screen in the same beat as the button press — the read-through above then
   * confirms it against the sim a moment later. Believing our own command for a
   * few hundred milliseconds is safe because a failed one reports `ok:false` and
   * never gets here.
   */
  function showRowText(name, text) {
    if (!name || typeof text !== "string" || !pit.rows) return;
    for (var i = 0; i < lastPitRows.length; i++) {
      if (lastPitRows[i].name !== name) continue;
      var refs = pit.rows[pitRowId(lastPitRows[i])];
      if (refs) critText(refs.value, text);
      return;
    }
  }

  function pitRowId(r) {
    return "p" + r.pmcValue + ":" + r.name;
  }

  function loadCursor() {
    fetch("/api/mfd/cursor", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (c) {
        if (!c || c.ok === false) return;
        var moved = c.name !== pitCursor.name || c.updatedAt !== pitCursor.updatedAt;
        var first = pitCursor.updatedAt === 0;
        pitCursor = { index: c.index, name: c.name, updatedAt: c.updatedAt };
        // The overlay-owned rows ride along on this poll, so their values are
        // drawn from the server rather than from a copy kept here — the wheel
        // buttons change them too, and a local copy would drift the moment a
        // driver used the buttons instead of the mouse.
        if (Array.isArray(c.virtual)) renderVirtualRows(c.virtual);
        if (!moved) return;
        highlightCursor(lastPitRows, true);
        // The cursor moving means a bound button was pressed — and a `+` or `−`
        // moves it too (it re-anchors on the row it changed), so this is also how
        // the widget learns a wheel button just altered a value. Skip the very
        // first poll: that is only us catching up with existing state.
        if (first) return;
        showRowText(c.name, c.text);
        refreshNow();
      })
      .catch(function () {
        /* server not up / older build — the widget just shows no selection */
      });
  }

  /** Points the server's cursor at a row — used when a row's own ± is clicked. */
  function aimCursorAt(row) {
    postJson("/api/mfd/cursor", { name: row.name }).then(function (c) {
      if (c && c.ok !== false) {
        pitCursor = { index: c.index, name: c.name, updatedAt: c.updatedAt };
        highlightCursor(lastPitRows, false);
      }
    });
  }

  /**
   * Marks the cursor's row. `scroll` brings it into view, but only when the list
   * is genuinely scrollable — scrollIntoView on a widget that fits would be free
   * rein to move the page under the driver.
   */
  /**
   * Mark the overlay's OWN rows when the cursor is on one of them.
   *
   * They live in the RACE CONTROL group rather than the pit list, but the server
   * walks them as part of one list (see server/pitCursor withVirtualRows), so
   * the highlight has to follow the cursor across both. Matched by name, which
   * is the cursor's own anchor.
   */
  /** Draw the overlay-owned rows' values from the server's copy. */
  function renderVirtualRows(virtual) {
    var byName = { 'SERVE:': rcRows.serve, 'PIT REQUEST:': rcRows.request };
    for (var i = 0; i < virtual.length; i++) {
      var refs = byName[virtual[i].name];
      if (refs) critText(refs.value, virtual[i].text || '—');
    }
  }

  function highlightRaceControl() {
    var byName = { 'SERVE:': rcRows.serve, 'PIT REQUEST:': rcRows.request };
    for (var key in byName) {
      if (!Object.prototype.hasOwnProperty.call(byName, key)) continue;
      var refs = byName[key];
      if (!refs) continue;
      if (pitCursor.name === key) refs.root.setAttribute("data-selected", "true");
      else refs.root.removeAttribute("data-selected");
    }
  }

  function highlightCursor(rows, scroll) {
    // Always run, even with no pit list: the cursor may be sitting on one of the
    // overlay's own rows, which exist whether or not the sim's menu is up.
    highlightRaceControl();
    if (!pit.rowsEl || !rows || rows.length === 0) return;
    var idx = -1;
    if (pitCursor.name) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].name === pitCursor.name) { idx = i; break; }
      }
    }
    if (idx < 0 && pitCursor.index >= 0 && pitCursor.index < rows.length) idx = pitCursor.index;
    var selected = null;
    for (var j = 0; j < rows.length; j++) {
      var refs = pit.rows[pitRowId(rows[j])];
      if (!refs) continue;
      if (j === idx) {
        refs.root.setAttribute("data-selected", "true");
        selected = refs.root;
      } else {
        refs.root.removeAttribute("data-selected");
      }
    }
    if (scroll && selected && pit.rowsEl.scrollHeight > pit.rowsEl.clientHeight + 1) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }

  function renderPit(rows) {
    if (!pit.container) return;
    if (!rows || rows.length === 0) {
      markEmpty(pit);
      lastPitRows = [];
      return;
    }
    pit.container.removeAttribute("data-empty");
    reconcile(
      pit,
      rows,
      pitRowId,
      function (r) {
        return pitCategory(r.name);
      },
      function (r) {
        return prettyPit(r.name);
      },
      function (r) {
        return r.currentText || "—";
      },
      // Every pit row is adjustable: the change goes over LMU's REST API, which
      // needs neither window focus nor a visible in-game MFD.
      function (r) {
        return function (dir, refs) {
          var body = { delta: dir };
          if (r.pmcValue != null) body.pmcValue = r.pmcValue;
          if (r.name) body.name = r.name;
          refs.value.setAttribute("data-busy", "true");
          // Aim the bindable controls at the row being clicked, so the buttons
          // carry on from wherever the mouse left off rather than from some
          // other row the driver can no longer remember choosing.
          aimCursorAt(r);
          postJson("/api/mfd/pit", body).then(function (res) {
            refs.value.removeAttribute("data-busy");
            if (!res || res.ok === false) {
              flashError(refs, (res && res.error) || "pit change failed");
              return;
            }
            // Read the sim back at once rather than waiting for the next frame —
            // the value moving is how the driver knows the command landed.
            refreshNow();
          });
        };
      },
    );
    lastPitRows = rows;
    highlightCursor(rows, false);
  }

  function renderAids(list) {
    if (!aids.container) return;
    // Merge the live aids (currently just brake bias) with the server's
    // estimates. They are deliberately the same rows with the same controls —
    // the only difference the driver sees is the "est" tag, because the value's
    // provenance matters but the way you change it does not.
    var merged = (list || []).slice();
    for (var s = 0; s < shadowAids.length; s++) {
      var sh = shadowAids[s];
      var already = merged.some(function (a) {
        return a.key === sh.id || a.label === sh.label;
      });
      if (!already) {
        merged.push({
          key: sh.id,
          label: sh.label,
          value: sh.value,
          text: String(sh.value),
          estimated: true,
        });
      }
    }
    list = merged;
    if (!list || list.length === 0) {
      markEmpty(aids);
      return;
    }
    aids.container.removeAttribute("data-empty");
    reconcile(
      aids,
      list,
      function (a) {
        return a.key;
      },
      function (a) {
        return aidCategory(a.key);
      },
      function (a) {
        return a.label;
      },
      function (a) {
        var text = a.text || String(a.value);
        // Tagged, not hidden: an estimate the driver knows is an estimate is
        // useful; one presented as a reading is a hazard.
        return a.estimated ? text + " est" : text;
      },
      // Aids are stepped with a KEYSTROKE, not REST — LMU's REST aid values are
      // frozen setup values. Only offered for aids LMU actually has bound (from
      // /api/mfd/keymap), since an unbound function cannot be triggered at all.
      function (a) {
        var bind = aidBinds[a.key];
        if (!bind || (!bind.canInc && !bind.canDec)) return null;
        return function (dir, refs) {
          if ((dir > 0 && !bind.canInc) || (dir < 0 && !bind.canDec)) {
            flashError(refs, "that direction is not bound to a key in LMU");
            return;
          }
          refs.value.setAttribute("data-busy", "true");
          postJson("/api/mfd/aidkey", { aid: a.key, dir: dir > 0 ? "inc" : "dec" }).then(
            function (res) {
              refs.value.removeAttribute("data-busy");
              // The commonest failure is the sim not being frontmost, which the
              // server reports verbatim — worth showing, not swallowing.
              if (!res || res.ok === false) flashError(refs, (res && res.error) || "key not sent");
              else refreshNow();
            },
          );
        };
      },
    );
  }

  /** Applies a full MfdState to the DOM (from a telemetry frame). */
  function renderState(state) {
    if (!mountEl) return;
    if (!state) {
      showNoData();
      return;
    }
    if (!wrapEl || mountEl.getAttribute("data-nodata") === "true") buildBody();
    if (showPit) renderTyres(state.tyres);
    if (showPit) renderPit(state.pit || []);
    if (showAids) renderAids(state.aids || []);
    if (headerMeta) headerMeta.textContent = "LIVE";
  }

  function markEmpty(group) {
    group.container.setAttribute("data-empty", "true");
    group.sig = "";
    group.rowsEl.textContent = "";
  }

  function showNoData() {
    if (headerMeta) headerMeta.textContent = "—";
    if (!mountEl || mountEl.getAttribute("data-nodata") === "true") return;
    mountEl.setAttribute("data-nodata", "true");
    mountEl.textContent = "";
    wrapEl = null;
    // The body is gone; drop the section refs with it, or the next render
    // writes into detached nodes and silently shows nothing.
    tyreRow = null;
    rcRows.box = null;
    var ph = document.createElement("div");
    ph.className = "placeholder";
    ph.textContent = "No MFD data — join a session in LMU";
    mountEl.appendChild(ph);
  }

  /* --------------------------------- helpers ------------------------------ */

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  /**
   * Write a value that should bloom when it changes. Falls back to a plain write
   * if the runtime predates the helper, so the widget can never be broken by the
   * glow being unavailable — it just stops glowing.
   */
  function critText(el, text) {
    if (octx && octx.crit) octx.crit(el, text);
    else setText(el, text);
  }

  /** Tidy the sim's raw labels a touch: drop the trailing colon. */
  function prettyPit(name) {
    return String(name || "").replace(/:\s*$/, "");
  }

  /* ------------------------------- structure ------------------------------ */

  function makeGroup(title, group, id) {
    var box = document.createElement("div");
    box.className = "mfd__group";
    // Lets the CSS size the driving aids larger than the pit list: brake bias,
    // TC, ABS and motor map are changed and read mid-corner, while the pit rows
    // are set up on a straight or in the box.
    box.setAttribute("data-group", id);

    var head = document.createElement("div");
    head.className = "mfd__group-title";
    head.textContent = title;

    var rows = document.createElement("div");
    rows.className = "mfd__rows";

    var empty = document.createElement("div");
    empty.className = "mfd__empty";
    empty.textContent = "—";

    box.appendChild(head);
    box.appendChild(rows);
    box.appendChild(empty);

    group.container = box;
    group.rowsEl = rows;
    group.rows = {};
    group.sig = "";
    return box;
  }

  /* ------------------------ tyres + race control rows ---------------------
   * Everything here is a ROW, not a panel of its own — same LABEL … VALUE … ±
   * shape as the sim's own pit entries. That is deliberate: these sit among
   * twenty rows the driver already reads that way, and a control that looks
   * different reads as a different KIND of thing. The tyre row in particular
   * belongs beside FL/FR/RL/RR TIRE, not in a box above them.
   * ------------------------------------------------------------------------ */

  /** The collapsed all-four-corners compound row. */
  var tyreRow = null;
  /** Race-control rows: pit request, serve penalty, the penalty count. */
  var rcRows = { request: null, serve: null, penalty: null, note: null, box: null };
  /**
   * Which penalty the SERVE row is armed for. Both start the same way — strip
   * the stop back to no service — and differ in what happens next, which is why
   * this is a choice and not one button:
   *
   *   STOP/GO        you stop in your box for the held time, so the pit stop IS
   *                  requested; without the request the crew is not expecting
   *                  you and the box may not be yours.
   *   DRIVE-THROUGH  you drive the length of the lane without stopping, so the
   *                  stop must NOT be requested — requesting one is how drivers
   *                  turn a drive-through into a drive-through plus a pit stop.
   *
   * LMU issues a drive-through for track limits, so that is the default.
   */
  /**
   * Step one of the overlay-owned rows: aim the cursor at it, then change it.
   *
   * Two calls rather than one because that is the existing contract — clicking a
   * row's ± moves the cursor onto it, so whatever the driver last touched with
   * the mouse is what their bound + and − will act on next.
   */
  function stepVirtual(name, dir) {
    postJson('/api/mfd/cursor', { name: name })
      .then(function () { return postJson('/api/mfd/cursor', { value: dir }); })
      .then(function (res) {
        if (res && res.ok === false) showNote(res.error || 'failed', true);
        loadCursor();
        refreshNow();
      });
  }

  /** POST a control intent and report the outcome on the note line. */
  function rcPost(path, body, okText) {
    return postJson(path, body || {}).then(function (res) {
      if (res && res.ok === false) showNote(res.error || 'failed', true);
      else showNote(okText, false);
      refreshNow();
      return res;
    });
  }

  /** A row whose control is a single labelled button rather than ±. */
  function makeActionRow(label, buttonText, onPress) {
    var refs = makeRow(null);
    setText(refs.label, label);
    var ctrls = document.createElement('span');
    ctrls.className = 'mfd__ctrls';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mfd__act';
    b.textContent = buttonText;
    // The in-game layer starts a widget drag on pointerdown anywhere inside a
    // widget; without this, pressing the button drags the whole MFD instead.
    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (evt) {
      b.addEventListener(evt, function (e) { e.stopPropagation(); });
    });
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      b.disabled = true;
      Promise.resolve(onPress()).then(function () { b.disabled = false; },
        function () { b.disabled = false; });
    });
    ctrls.appendChild(b);
    refs.root.appendChild(ctrls);
    refs.root.setAttribute('data-adjustable', 'true');
    refs.button = b;
    return refs;
  }

  /** The tyre row: compound as the value, ± to cycle through what the car has. */
  function buildTyreRow() {
    var refs = makeRow(function (dir) {
      rcPost('/api/mfd/tyres', { delta: dir }, dir > 0 ? 'tyres up' : 'tyres down');
    });
    refs.root.setAttribute('data-cat', 'tyre');
    setText(refs.label, 'TIRES');
    tyreRow = refs;
    return refs.root;
  }

  function renderTyres(tyres) {
    if (!tyreRow) return;
    if (!tyres || !tyres.options || !tyres.options.length) {
      critText(tyreRow.value, '—');
      return;
    }
    // The sim's own wording, minus nothing: "No Change", "New Medium", "Used
    // Medium", "New Wet" all say something the driver needs, and shortening them
    // is how a used set gets mistaken for a new one.
    critText(tyreRow.value, tyres.mixed ? 'Mixed' : tyres.currentText || '—');
  }

  /** The race-control group: what the sim is doing TO you, and the two replies. */
  function buildRaceControl() {
    var box = document.createElement('div');
    box.className = 'mfd__group mfd__penalty';
    box.setAttribute('data-group', 'penalty');
    box.setAttribute('data-state', 'clean');

    var head = document.createElement('div');
    head.className = 'mfd__group-title';
    head.textContent = 'RACE CONTROL';

    var rows = document.createElement('div');
    rows.className = 'mfd__rows';

    // Penalties outstanding — a plain row, because it is a reading like any
    // other. Its urgency is carried by the group's data-state, not by size.
    rcRows.penalty = makeRow(null);
    setText(rcRows.penalty.label, 'PENALTIES');
    rcRows.penalty.root.setAttribute('data-cat', 'service');
    rows.appendChild(rcRows.penalty.root);

    // PIT REQUEST and SERVE are ordinary ± rows now, driven through the SAME
    // server-side cursor as the sim's own rows. That is what makes them reachable
    // from the four bindable controls: scroll to them with ▲ ▼, change them with
    // + −, exactly like FL TIRE. Clicking a row's ± aims the cursor at it first,
    // so the mouse and the buttons never disagree about which row is selected —
    // the same contract the sim's rows have always had here.
    rcRows.request = makeRow(function (dir) { stepVirtual('PIT REQUEST:', dir); });
    setText(rcRows.request.label, 'PIT REQUEST');
    rcRows.request.root.setAttribute('data-cat', 'service');
    rows.appendChild(rcRows.request.root);

    rcRows.serve = makeRow(function (dir) { stepVirtual('SERVE:', dir); });
    setText(rcRows.serve.label, 'SERVE');
    rcRows.serve.root.setAttribute('data-cat', 'service');
    rows.appendChild(rcRows.serve.root);

    // The outcome line. Errors are the point of it: the likeliest failure is
    // "Pit Request" being bound to a wheel button, which the driver can only fix
    // if they are told so in those words.
    rcRows.note = document.createElement('div');
    rcRows.note.className = 'mfd__penalty-note';
    rcRows.note.hidden = true;

    box.appendChild(head);
    box.appendChild(rows);
    box.appendChild(rcRows.note);
    rcRows.box = box;
    return box;
  }

  var noteTimer = null;

  function showNote(text, isError) {
    if (!rcRows.note) return;
    rcRows.note.textContent = text;
    rcRows.note.setAttribute('data-error', String(!!isError));
    rcRows.note.hidden = false;
    if (noteTimer) clearTimeout(noteTimer);
    // Errors linger — the driver has to read and act on them. A success is a
    // confirmation and can go.
    noteTimer = setTimeout(function () { rcRows.note.hidden = true; }, isError ? 12000 : 3000);
  }

  /**
   * Render the penalty count and the consequence state. `ctx` supplies both the
   * count and the four-second announce window, so this and the Track Limits
   * widget cannot disagree about either.
   */
  function renderPenalties(frame, ctx) {
    if (!rcRows.box || !ctx || !ctx.penaltyCount) return;
    var tl = frame.player ? frame.player.trackLimits : null;
    var n = ctx.penaltyCount(tl);
    critText(rcRows.penalty.value, tl ? String(n) : '—');
    var state = !tl ? 'nodata' : ctx.consequenceFresh(tl) ? 'fresh' : n > 0 ? 'standing' : 'clean';
    if (rcRows.box.getAttribute('data-state') !== state) {
      rcRows.box.setAttribute('data-state', state);
    }
  }

  function buildBody() {
    mountEl.removeAttribute('data-nodata');
    mountEl.textContent = '';
    wrapEl = document.createElement('div');
    wrapEl.className = 'mfd__wrap';
    // Race control first: it is the only section reporting something happening
    // TO the driver rather than something they are choosing, and when it has
    // anything to say it outranks the strategy below it.
    wrapEl.appendChild(buildRaceControl());
    if (showPit) {
      var pitBox = makeGroup('PIT STRATEGY', pit, 'pit');
      // The tyre row goes at the TOP of the pit group, where the sim's own
      // all-four TIRES entry would be — beside the per-corner rows it drives,
      // not in a box of its own above them.
      pitBox.insertBefore(buildTyreRow(), pit.rowsEl);
      wrapEl.appendChild(pitBox);
    }
    if (showAids) wrapEl.appendChild(makeGroup('DRIVING AIDS', aids, 'aids'));
    mountEl.appendChild(wrapEl);
  }

  /* --- opacity control — identical contract to widgets/damage.js ----------- */
  function buildOpacityControl(root, params) {
    var apply = function (v) {
      root.style.setProperty("--mfd-op", String(v));
      root.setAttribute("data-transparent", v < 1 ? "true" : "false");
    };
    var stored = null;
    try {
      var raw = localStorage.getItem(OPACITY_KEY);
      if (raw !== null && isFinite(parseFloat(raw))) stored = parseFloat(raw);
    } catch (e) {
      /* private mode — slider still works, just won't persist */
    }
    var fromUrl = parseFloat(params.get("opacity"));
    var initial = isFinite(fromUrl) ? fromUrl : stored !== null ? stored : 1;
    initial = Math.min(1, Math.max(MIN_OPACITY, initial));

    var bar = document.createElement("div");
    bar.className = "mfd__opacity";
    var label = document.createElement("span");
    label.className = "mfd__opacity-label";
    label.textContent = "OPACITY";
    var slider = document.createElement("input");
    slider.className = "mfd__opacity-range";
    slider.type = "range";
    slider.min = String(Math.round(MIN_OPACITY * 100));
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(initial * 100));
    var readout = document.createElement("span");
    readout.className = "mfd__opacity-val";
    readout.textContent = slider.value + "%";

    slider.addEventListener("input", function () {
      var v = Math.min(1, Math.max(MIN_OPACITY, Number(slider.value) / 100));
      apply(v);
      readout.textContent = Math.round(v * 100) + "%";
      try {
        localStorage.setItem(OPACITY_KEY, String(v));
      } catch (e) {
        /* ignore */
      }
    });
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      bar.addEventListener(evt, function (e) {
        e.stopPropagation();
      });
    });

    bar.appendChild(label);
    bar.appendChild(slider);
    bar.appendChild(readout);
    var anchor = document.createElement("div");
    anchor.className = "mfd__opacity-anchor";
    anchor.appendChild(bar);
    root.appendChild(anchor);
    apply(initial);
  }

  /* --------------------------------- init --------------------------------- */

  function init(root, ctx) {
    octx = ctx;
    headerMeta = root.querySelector('[data-role="meta"]');
    mountEl = root.querySelector('[data-role="mount"]');

    var params = new URLSearchParams(window.location.search);
    var isOff = function (name) {
      var v = (params.get(name) || "").toLowerCase();
      return v === "off" || v === "0" || v === "false";
    };
    showPit = !isOff("pit");
    showAids = !isOff("aids");

    buildOpacityControl(root, params);

    // Which aids are bound in LMU. Polled slowly (not per frame): it changes
    // only when the driver rebinds or the game starts, and a 30 Hz check for a
    // value that moves twice a session would be pure waste.
    loadAidBinds();
    setInterval(loadAidBinds, 10000);

    // The selected pit row, on the other hand, moves the instant a bound button
    // is pressed — and the driver pressed it precisely because they are not
    // looking at the screen for long. Polled quickly, and answered from the
    // server's memory rather than from the sim, so this costs almost nothing.
    if (showPit) {
      loadCursor();
      setInterval(loadCursor, CURSOR_POLL_MS);
    }

    if (!showPit && !showAids) {
      disabled = true;
      mountEl.textContent = "";
      var ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = "Both MFD sections are off (?pit / ?aids)";
      mountEl.appendChild(ph);
      return;
    }
    showNoData();
  }

  function update(frame, ctx) {
    if (disabled) return;
    octx = ctx;
    renderState(frame && frame.mfd ? frame.mfd : null);
    // After renderState, which is what builds the body the penalty box lives in.
    // Driven off `frame.player.trackLimits`, not off the MFD block: the sim's
    // penalty count comes from the scoring buffer and exists even when the
    // garage endpoints that feed the rest of this widget do not.
    renderPenalties(frame, ctx);
  }

  window.ApexOverlay.registerWidget("mfd", {
    // The MFD changes on driver input rather than per frame, but when it does the
    // driver is waiting on it — so the render throttle stays well under the
    // provider's pit-menu poll instead of adding a quarter-second on top of it.
    throttleMs: 100,
    init: init,
    update: update,
  });
})();
