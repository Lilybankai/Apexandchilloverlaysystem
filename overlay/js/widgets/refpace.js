/**
 * widgets/refpace.js — where your pace sits against the class reference.
 * -----------------------------------------------------------------------------
 * Renders `frame.player.paceScore`: your best lap this session as a percentage
 * of the pace an alien runs in the same class at the same track layout, and
 * which rung of the ladder that lands on — Alien, Competitive, Good, Midpack,
 * Tail-ender, Offline.
 *
 * **The reference times, and the band labels, are Ohne Speed's** (with times
 * contributed by beAlien, Go and Hymo). The credit line at the foot of this
 * widget is not decoration and is not optional: the whole readout is their data,
 * and it renders from `paceScore.credit` so it cannot be left behind if the
 * source ever changes.
 *
 * Everything numeric is computed server-side in `telemetry/referencePace.ts`;
 * this file only draws it. That split is deliberate — the same score has to
 * appear on the control panel's Dashboard, which cannot run overlay JS.
 *
 * ## The empty state carries the information
 * `paceScore` arrives with `ok: false` far more often than most widgets' data is
 * missing, because LMU names the VENUE and never the LAYOUT, and Monza's two
 * layouts are ~10 s apart. When that happens this shows the server's own
 * sentence rather than a placeholder: "Autodromo Nazionale Monza has 2 layouts
 * with reference times and the sim did not say which one this is" is the single
 * most useful thing the widget can say, and "Awaiting telemetry…" would send
 * someone hunting a bug that isn't there.
 *
 * Optional query params (OBS Browser Source URL):
 *   ?ladder=off   — hide the band ladder, leaving the number and label only.
 */
(function () {
  "use strict";

  /**
   * The ladder's visible span, in percent.
   *
   * Not 100–107: a driver genuinely on the pace sits a shade under 100 and would
   * otherwise be pinned to the left edge with nowhere to move, and anyone over
   * 107 would be pinned to the right with no sense of by how much. Two points
   * either side gives both ends somewhere to go.
   */
  var SCALE_MIN = 98;
  var SCALE_MAX = 109;

  /**
   * Band ceilings, mirrored from the spreadsheet so the ladder can be drawn
   * before any score exists. `referencePace.ts` is the authority for which band a
   * number falls in — these are only the segment widths.
   */
  var BANDS = [
    { id: "alien", label: "Alien", max: 100 },
    { id: "competitive", label: "Competitive", max: 101 },
    { id: "good", label: "Good", max: 103 },
    { id: "midpack", label: "Midpack", max: 105 },
    { id: "tail", label: "Tail-ender", max: 106 },
    { id: "offline", label: "Offline", max: SCALE_MAX },
  ];

  var root, metaEl;
  var els = {};
  var showLadder = true;

  function div(cls, text) {
    var d = document.createElement("div");
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  function init(rootEl) {
    root = rootEl;
    metaEl = rootEl.querySelector('[data-role="meta"]');
    var mount = rootEl.querySelector('[data-role="mount"]');
    mount.innerHTML = "";
    els = {};

    var params = new URLSearchParams(window.location.search);
    showLadder = (params.get("ladder") || "on").toLowerCase() !== "off";

    var wrap = div("refpace");

    els.percent = div("refpace__percent", "—");
    els.band = div("refpace__band", "");
    var head = div("refpace__head");
    head.appendChild(els.percent);
    head.appendChild(els.band);
    wrap.appendChild(head);

    // The explanation for an unscored lap. Hidden whenever there IS a score.
    els.note = div("refpace__note", "");
    els.note.hidden = true;
    wrap.appendChild(els.note);

    if (showLadder) {
      els.ladder = div("refpace__ladder");
      var prev = SCALE_MIN;
      for (var i = 0; i < BANDS.length; i++) {
        var b = BANDS[i];
        var seg = div("refpace__seg");
        seg.setAttribute("data-band", b.id);
        // Segments are sized by the percentage range they cover, so the ladder
        // is a scale rather than six equal blocks — the visual distance between
        // two scores then means what it says.
        seg.style.flexGrow = String(Math.max(0.1, b.max - prev));
        seg.title = b.label + " — up to " + b.max + "%";
        prev = b.max;
        els.ladder.appendChild(seg);
      }
      els.marker = div("refpace__marker");
      els.marker.hidden = true;
      els.ladder.appendChild(els.marker);
      wrap.appendChild(els.ladder);
    }

    // Your lap against the reference lap, plus the signed gap between them.
    els.stats = div("refpace__stats");
    els.you = statCell("YOU", "—");
    els.ref = statCell("ALIEN", "—");
    els.gap = statCell("GAP", "—");
    els.stats.appendChild(els.you.cell);
    els.stats.appendChild(els.ref.cell);
    els.stats.appendChild(els.gap.cell);
    wrap.appendChild(els.stats);

    els.credit = div("refpace__credit", "");
    wrap.appendChild(els.credit);

    mount.appendChild(wrap);
  }

  function statCell(label, value) {
    var cell = div("refpace__stat");
    var l = div("refpace__stat-label", label);
    var v = div("refpace__stat-value", value);
    cell.appendChild(l);
    cell.appendChild(v);
    return { cell: cell, value: v };
  }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setAttr(el, name, value) {
    if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  /** Where a percentage sits on the ladder, 0–100, clamped to the visible span. */
  function ladderPos(percent) {
    var p = Math.min(SCALE_MAX, Math.max(SCALE_MIN, percent));
    return ((p - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100;
  }

  function update(frame, ctx) {
    var fmt = ctx.fmt;
    var ps = frame.player && frame.player.paceScore ? frame.player.paceScore : null;

    // Attribution first, and unconditionally: it is shown whenever the widget
    // has anything at all from the reference table, including an explanation of
    // why there is no score.
    if (ps && ps.credit) {
      setText(els.credit, "Reference times by " + ps.credit.author);
      els.credit.hidden = false;
    } else {
      els.credit.hidden = true;
    }

    if (!ps) {
      // Spectating, or the provider has no driven car yet.
      root.setAttribute("data-active", "false");
      setAttr(root, "data-band", "none");
      setText(els.percent, "—");
      setText(els.band, "");
      setText(els.note, "");
      els.note.hidden = true;
      if (els.marker) els.marker.hidden = true;
      setText(els.you.value, "—");
      setText(els.ref.value, "—");
      setText(els.gap.value, "—");
      setText(metaEl, "no car");
      return;
    }

    root.setAttribute("data-active", "true");

    // Header: the class and layout being compared, which is the context that
    // makes the percentage mean anything. The circuit is omitted — you are
    // driving it — and so is the layout when the circuit only has one, where
    // naming it would be a longer way of saying nothing. Hedged with a "?" when
    // part of the match was assumed rather than established.
    var layout = ps.via === "only" ? "" : ps.layoutName;
    var context = ps.sheetClass
      ? ps.sheetClass + (layout ? " · " + layout : "")
      : "no reference";
    setText(metaEl, ps.assumed ? context + " ?" : context);
    if (metaEl) {
      // Always titled, not only when hedged: the meta truncates at narrow panel
      // widths, so the tooltip is where the full context lives either way.
      metaEl.title = ps.assumed
        ? context +
          " — the exact reference row was assumed; the sim did not publish enough to be sure."
        : context;
    }

    if (!ps.ok) {
      setAttr(root, "data-band", "none");
      setText(els.percent, "—");
      setText(els.band, "");
      setText(els.note, ps.detail || "No reference for this combination.");
      els.note.hidden = false;
      if (els.marker) els.marker.hidden = true;
      setText(els.you.value, fmt.has(ps.lapSec) ? fmt.lapTime(ps.lapSec) : "—");
      setText(els.ref.value, fmt.has(ps.refSec) ? fmt.lapTime(ps.refSec) : "—");
      setText(els.gap.value, "—");
      return;
    }

    setAttr(root, "data-band", ps.bandId || "none");
    setText(els.percent, ps.percent.toFixed(1) + "%");
    setText(els.band, (ps.bandLabel || "").toUpperCase());
    els.note.hidden = true;

    if (els.marker) {
      els.marker.hidden = false;
      els.marker.style.left = ladderPos(ps.percent) + "%";
    }

    setText(els.you.value, fmt.has(ps.lapSec) ? fmt.lapTime(ps.lapSec) : "—");
    setText(els.ref.value, fmt.has(ps.refSec) ? fmt.lapTime(ps.refSec) : "—");
    var gap = ps.deltaSec;
    setText(
      els.gap.value,
      typeof gap === "number" ? (gap > 0 ? "+" : gap < 0 ? "−" : "") + Math.abs(gap).toFixed(2) : "—",
    );
    setAttr(els.gap.value, "data-state", gap < 0 ? "ahead" : gap > 0 ? "behind" : "flat");
  }

  window.ApexOverlay.registerWidget("refpace", {
    // A session best moves a handful of times an hour. Anything faster than this
    // is redrawing an identical panel.
    throttleMs: 500,
    init: init,
    update: update,
  });
})();
