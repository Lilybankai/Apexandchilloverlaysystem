/**
 * trainingfocus.js — Focus: the one corner the live coach is working on.
 * -----------------------------------------------------------------------------
 * The in-game half of the live practice coach. After every timed lap of a
 * practice session the coach (electron/live-coach.js, liveCoach.ts) picks the
 * corner that has cost the most CONSISTENTLY over the last few laps and says
 * one line about it on the radio. This card shows the same thing, quietly, for
 * as long as it stays the focus:
 *
 *     FOCUS                                  [NEW]
 *     C4                                ╭──────╮
 *     Brake 10 m later                  │ map  │
 *     ≈0.15 s a lap                     ╰──────╯
 *     Last 3:29.41 · +0.62 vs best
 *
 * and lights up as the car comes to that corner — the card's edge glows and a
 * "NEXT" pill sits beside the corner id, then "NOW" through it — so the driver
 * who glances at it at 250 km/h reads two things: which corner, what to do.
 *
 * Corner ids are the Practice tab's ('C1'..'Cn', from the corner catalogue),
 * never the official turn names; they arrive ready-made as `focus.cornerId`.
 *
 * ## What it reads
 * Only `frame.player.coach` (LiveCoachOverlay in liveCoachContract.ts) for the
 * words, and the car's road position for the light and the map's dot:
 *   - `player.ghost.atD` when a ghost is running (the delta engine's filtered
 *     distance — the smoothest there is), else
 *   - the player's `trackMap.cars[].lapFraction` (REST, ~7 Hz), so the card
 *     works in a session with nothing chased at all.
 * The light is a TIME lead like the Brake Cue's: ~3 s of the car's own speed
 * before `focus.entryD` (never under {@link LEAD_MIN_M}), held through
 * `focus.exitD`. It needs the lap length, from the track map's shape, the
 * ghost lap or `session.trackLengthM`, whichever is known first.
 *
 * ## The map
 * The circuit's outline, faint, with the focus corner's `entryD..exitD` span
 * bright and the car as a dot. The shape is `/trackmap.json` (the learned
 * circuit, one point per bin of lap distance from the line, so a lap fraction
 * IS an index) fetched once per track revision — or, before a map has been
 * learned, the ghost lap's own driven line from the shared `/ghost.json`
 * (training-ghost.js), whose points carry their lap fraction. No shape, no
 * map: the card is whole without it.
 *
 * ## States
 *   - no `player.coach`      → hidden (edit mode: a dimmed sample, to place it)
 *   - validLaps < minLaps    → "Learning your laps… 1 / 2", small and calm
 *   - no focus               → "Clean laps — nothing big to fix"
 *   - a focus                → the card, its status chip, the light
 * A new `rev` (a new focus) flashes the card once.
 *
 * DOM only, written only on change. Nothing is fetched, timed or listened to
 * before init: widget.html loads every training script whichever widget its
 * `?w=` names (scripts/test-training-widgets.js holds that).
 */
(function () {
  "use strict";

  var GHOST = window.ApexTrainingGhost;
  var LAPS = window.ApexTrainingLaps;
  var NS = "http://www.w3.org/2000/svg";

  /** Seconds of warning before the focus corner's entry, at the car's own speed. */
  var LEAD_SEC = 3;
  /** The shortest lead, metres — a hairpin at walking pace still gets one. */
  var LEAD_MIN_M = 60;
  /** The light stays this long after the exit, so position jitter cannot blink it. */
  var HOLD_MS = 400;
  /** How long the once-only flash on a new focus lasts, ms (the CSS animation's). */
  var FLASH_MS = 1400;
  /** The map's box, CSS px (the SVG scales with the card). */
  var MW = 128;
  var MH = 84;
  var MPAD = 6;
  /** Points the faint outline is drawn with; the bright span keeps them all. */
  var OUTLINE_PTS = 240;

  /** The sample shown in edit mode while there is no coach to show. */
  var SAMPLE = {
    focus: { cornerId: "C4", cornerNo: 4, entryD: 0.28, apexD: 0.3, exitD: 0.32, lossSec: 0.15, short: "Brake 10 m later", status: "new" },
    validLaps: 4,
    minLaps: 2,
    lastLapSec: 102.18,
    lastDeltaSec: 0.62,
    refKind: "sessionBest",
    rev: 1,
  };

  var CHIP = {
    new: { text: "NEW", tone: "new" },
    holding: { text: "WORKING ON IT", tone: "hold" },
    improving: { text: "BETTER", tone: "gain" },
    fixed: { text: "SORTED ✓", tone: "gain" },
  };

  var REF_WORDS = { sessionBest: "vs best", board: "vs board", chased: "vs target" };

  var root = null;
  var el = null;
  var ui = {};
  var cur = {};

  /** The shape the map is drawn from: { pts: [[u, v, d]], lengthM, src }. */
  var shape = null;
  var mapKey = "";
  var mapRev = -1;
  var mapFetching = false;
  var mapMissUntil = 0;
  /** The ghost lap's line, as a fallback shape. */
  var ghostLine = null;
  /** The span drawn bright, so it is only rebuilt when the focus moves. */
  var spanKey = "";
  /** What the map is drawn from right now: `shape`, or the sample's made-up circuit in edit mode. */
  var drawn = null;
  var sampleShape = null;

  var seenRev = null;
  var flashTimer = 0;
  var flashFlip = false;
  var litUntil = 0;

  /* -------------------------------- writes ------------------------------- */

  function set(key, node, value) {
    if (cur[key] === value) return;
    cur[key] = value;
    node.textContent = value;
  }

  function setAttr(key, node, name, value) {
    if (cur[key] === value) return;
    cur[key] = value;
    node.setAttribute(name, value);
  }

  /* -------------------------------- words -------------------------------- */

  /** "3:29.41" — hundredths, as a lap reads on the card. */
  function lapWords(sec) {
    if (typeof sec !== "number" || !isFinite(sec) || sec <= 0) return "";
    var cs = Math.round(sec * 100);
    var m = Math.floor(cs / 6000);
    var s = (cs - m * 6000) / 100;
    return m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
  }

  function signed(sec) {
    if (LAPS && typeof LAPS.fmtSigned === "function") return LAPS.fmtSigned(sec);
    var r = Number(Math.abs(sec).toFixed(2));
    return (r === 0 ? "" : sec > 0 ? "+" : "−") + r.toFixed(2);
  }

  /** "Last 3:29.41 · +0.62 vs best" / "Last 3:29.41 · your best" / "". */
  function footWords(c) {
    var lap = lapWords(c.lastLapSec);
    if (!lap) return "";
    var d = c.lastDeltaSec;
    if (typeof d !== "number" || !isFinite(d)) return "Last " + lap;
    if (c.refKind === "sessionBest" && Math.abs(d) < 0.005) return "Last " + lap + " · your best";
    return "Last " + lap + " · " + signed(d) + " " + (REF_WORDS[c.refKind] || "vs ref");
  }

  /** "≈0.15 s a lap". */
  function costWords(sec) {
    if (typeof sec !== "number" || !isFinite(sec) || sec <= 0) return "";
    return "≈" + sec.toFixed(2) + " s a lap";
  }

  /* -------------------------------- shape -------------------------------- */

  /**
   * World plan → map plan, the track-map widget's way round: rotated so the
   * circuit's longest axis lies across the box, and `v` negated so the map is
   * not the circuit's mirror image (see trackmap.js `viewV`).
   */
  function planOf(xs, zs, ds, lengthM, src) {
    var n = xs.length;
    if (n < 8) return null;
    var mx = 0, mz = 0, i;
    for (i = 0; i < n; i++) { mx += xs[i]; mz += zs[i]; }
    mx /= n; mz /= n;
    var sxx = 0, szz = 0, sxz = 0;
    for (i = 0; i < n; i++) {
      var dx = xs[i] - mx, dz = zs[i] - mz;
      sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
    }
    var a = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    var ca = Math.cos(a), sa = Math.sin(a);
    var pts = [];
    var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (i = 0; i < n; i++) {
      var u = xs[i] * ca - zs[i] * sa;
      var v = -(xs[i] * sa + zs[i] * ca);
      if (!isFinite(u) || !isFinite(v) || !isFinite(ds[i])) continue;
      pts.push([u, v, ds[i]]);
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    if (pts.length < 8 || !(u1 > u0) || !(v1 > v0)) return null;
    var k = Math.min((MW - 2 * MPAD) / (u1 - u0), (MH - 2 * MPAD) / (v1 - v0));
    var ox = (MW - (u1 - u0) * k) / 2;
    var oy = (MH - (v1 - v0) * k) / 2;
    for (i = 0; i < pts.length; i++) {
      pts[i][0] = ox + (pts[i][0] - u0) * k;
      pts[i][1] = oy + (pts[i][1] - v0) * k;
    }
    return { pts: pts, lengthM: lengthM > 0 ? lengthM : 0, src: src };
  }

  /** `/trackmap.json` → a shape: bin i is lap fraction i / n. */
  function shapeFromTrackMap(data) {
    if (!data || !Array.isArray(data.points) || data.points.length < 8) return null;
    var n = data.points.length;
    var xs = [], zs = [], ds = [];
    for (var i = 0; i < n; i++) {
      var p = data.points[i];
      xs.push(p[0]);
      zs.push(p[1]);
      ds.push(i / n);
    }
    return planOf(xs, zs, ds, data.lengthM, "trackmap");
  }

  /** `/ghost.json` with a driven line → a shape. */
  function shapeFromGhost(line) {
    if (!line || !line.x || !line.z || !line.d) return null;
    var n = Math.min(line.x.length, line.z.length, line.d.length);
    return planOf(line.x.slice(0, n), line.z.slice(0, n), line.d.slice(0, n), line.trackLengthM, "ghost");
  }

  /** Fetch the learned circuit when the frame names a new one. Never before init. */
  function syncTrackMap(tm) {
    if (!tm || !tm.ready || !tm.key) return;
    if (mapKey === tm.key && mapRev === tm.revision) return;
    if (mapFetching || Date.now() < mapMissUntil || typeof fetch !== "function") return;
    mapFetching = true;
    var wantKey = tm.key, wantRev = tm.revision;
    fetch("/trackmap.json", { cache: "no-store" })
      .then(function (r) {
        if (r.status === 204) return null;
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        mapFetching = false;
        var s = shapeFromTrackMap(data);
        if (!s) {
          mapMissUntil = Date.now() + 5000;
          return;
        }
        mapKey = wantKey;
        mapRev = wantRev;
        shape = s;
      })
      .catch(function () {
        mapFetching = false;
        mapMissUntil = Date.now() + 5000;
      });
  }

  /* --------------------------------- map --------------------------------- */

  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function pathOf(pts, close) {
    var s = "";
    for (var i = 0; i < pts.length; i++) {
      s += (i ? "L" : "M") + pts[i][0].toFixed(1) + " " + pts[i][1].toFixed(1);
    }
    return close && s ? s + "Z" : s;
  }

  /** Whether lap fraction `d` lies in [a, b], round the line when b < a. */
  function within(d, a, b) {
    return b >= a ? d >= a && d <= b : d >= a || d <= b;
  }

  /**
   * A made-up circuit for the edit-mode sample, so the card can be placed
   * with its map showing before any track has been learned.
   */
  function sampleCircuit() {
    if (sampleShape) return sampleShape;
    var xs = [], zs = [], ds = [];
    for (var i = 0; i < 120; i++) {
      var t = (i / 120) * Math.PI * 2;
      xs.push(Math.cos(t) * 1.7 + 0.35 * Math.cos(3 * t));
      zs.push(Math.sin(t) + 0.3 * Math.sin(2 * t));
      ds.push(i / 120);
    }
    sampleShape = planOf(xs, zs, ds, 0, "sample");
    return sampleShape;
  }

  /** Point the map at `next` (or nothing), redrawing only when that changes. */
  function useShape(next) {
    if (next === drawn) return;
    drawn = next;
    drawOutline();
  }

  function drawOutline() {
    if (!ui.outline) return;
    spanKey = "";
    ui.span.setAttribute("d", "");
    if (!drawn) {
      setAttr("map", el, "data-map", "none");
      ui.outline.setAttribute("d", "");
      return;
    }
    var step = Math.max(1, Math.floor(drawn.pts.length / OUTLINE_PTS));
    var thin = [];
    for (var i = 0; i < drawn.pts.length; i += step) thin.push(drawn.pts[i]);
    ui.outline.setAttribute("d", pathOf(thin, true));
    setAttr("map", el, "data-map", "on");
  }

  function drawSpan(f) {
    if (!drawn || !f) return;
    var key = f.entryD + ":" + f.exitD;
    if (key === spanKey) return;
    spanKey = key;
    var run = [];
    var pts = drawn.pts;
    // Start at the first point after the entry and walk forward round the lap,
    // so a corner that straddles the line comes out as one stroke.
    var start = 0;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i][2] >= f.entryD) { start = i; break; }
    }
    for (var k = 0; k < pts.length; k++) {
      var p = pts[(start + k) % pts.length];
      if (!within(p[2], f.entryD, f.exitD)) {
        if (run.length) break;
        continue;
      }
      run.push(p);
    }
    // A span shorter than the bin spacing still gets a mark.
    if (run.length === 1) run.push([run[0][0] + 0.5, run[0][1] + 0.5]);
    ui.span.setAttribute("d", pathOf(run, false));
  }

  /** The point on the outline at lap fraction `d`, or null. */
  function pointAt(d) {
    if (!drawn || !isFinite(d)) return null;
    var pts = drawn.pts;
    var lo = 0, hi = pts.length - 1;
    if (d <= pts[0][2] || d >= pts[hi][2]) return pts[d <= pts[0][2] ? 0 : hi];
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pts[mid][2] <= d) lo = mid;
      else hi = mid;
    }
    var a = pts[lo], b = pts[hi];
    var t = b[2] > a[2] ? (d - a[2]) / (b[2] - a[2]) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  function placeDot(d) {
    var p = pointAt(d);
    if (!p) {
      setAttr("dot", ui.dot, "data-on", "false");
      return;
    }
    setAttr("dot", ui.dot, "data-on", "true");
    setAttr("dotX", ui.dot, "cx", p[0].toFixed(1));
    setAttr("dotY", ui.dot, "cy", p[1].toFixed(1));
  }

  /* ------------------------------ the light ------------------------------ */

  /** The car's road position, lap fraction 0..1, or NaN. */
  function carD(frame) {
    var p = frame.player;
    var g = p && p.ghost;
    if (g && g.active && typeof g.atD === "number" && isFinite(g.atD)) return g.atD;
    var cars = frame.trackMap && frame.trackMap.cars;
    if (Array.isArray(cars)) {
      for (var i = 0; i < cars.length; i++) {
        var c = cars[i];
        if (c && c.isPlayer) {
          if (c.inPit) return NaN;
          return typeof c.lapFraction === "number" ? c.lapFraction : NaN;
        }
      }
    }
    return NaN;
  }

  function lapLengthM(frame) {
    if (shape && shape.lengthM > 0) return shape.lengthM;
    if (ghostLine && ghostLine.trackLengthM > 0) return ghostLine.trackLengthM;
    var s = frame.session;
    return s && s.trackLengthM > 0 ? s.trackLengthM : 0;
  }

  /**
   * 'next' while the car is within the lead of the focus corner's entry,
   * 'now' from the entry through the exit, else 'off'.
   */
  function approachOf(f, d, L, kph) {
    if (!f || !isFinite(d) || !(L > 0)) return "off";
    if (within(d, f.entryD, f.exitD)) return "now";
    var toEntry = f.entryD - d;
    if (toEntry < 0) toEntry += 1;
    var mps = kph > 0 ? kph / 3.6 : 0;
    var lead = Math.max(LEAD_MIN_M, LEAD_SEC * mps);
    return toEntry * L <= lead ? "next" : "off";
  }

  /* ------------------------------ the card ------------------------------- */

  function flash() {
    flashFlip = !flashFlip;
    // Two names for one animation, so a second new focus inside the first
    // flash restarts it rather than being swallowed.
    root.setAttribute("data-flash", flashFlip ? "a" : "b");
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(function () {
      flashTimer = 0;
      root.removeAttribute("data-flash");
    }, FLASH_MS);
  }

  function render(c, sample) {
    var f = c.focus || null;
    var mode;
    if (f) mode = "focus";
    else if ((c.validLaps || 0) < (c.minLaps || 0)) mode = "learning";
    else mode = "clean";
    setAttr("mode", el, "data-mode", mode);
    setAttr("sample", el, "data-sample", sample ? "true" : "false");

    if (mode === "learning") {
      set("note", ui.note, "Learning your laps… " + (c.validLaps || 0) + " / " + c.minLaps);
    } else if (mode === "clean") {
      set("note", ui.note, "Clean laps — nothing big to fix");
    } else {
      set("note", ui.note, "");
    }

    if (f) {
      set("corner", ui.corner, f.cornerId || "C" + f.cornerNo);
      set("short", ui.short, f.short || "");
      set("cost", ui.cost, costWords(f.lossSec));
      var chip = CHIP[f.status] || CHIP.holding;
      set("chip", ui.chip, chip.text);
      setAttr("chipTone", ui.chip, "data-tone", chip.tone);
      setAttr("status", el, "data-status", f.status || "holding");
      drawSpan(f);
    } else {
      setAttr("status", el, "data-status", "none");
    }
    set("foot", ui.foot, footWords(c));
  }

  function setApproach(state) {
    setAttr("approach", root, "data-approach", state);
    set("call", ui.call, state === "now" ? "NOW" : state === "next" ? "NEXT" : "");
  }

  function update(frame) {
    if (!el) return;
    var player = frame && frame.player;
    var coach = player ? player.coach : null;
    if (GHOST && player) GHOST.sync(player.ghost);
    if (frame && frame.trackMap) syncTrackMap(frame.trackMap);
    if (!shape && ghostLine) shape = shapeFromGhost(ghostLine);

    if (!coach || typeof coach !== "object") {
      // Hidden on track; edit mode shows the sample (training-focus.css).
      setAttr("coach", root, "data-coach", "none");
      useShape(shape || sampleCircuit());
      render(SAMPLE, true);
      setApproach("off");
      placeDot(SAMPLE.focus.entryD - 0.05);
      seenRev = null;
      return;
    }
    setAttr("coach", root, "data-coach", "on");
    useShape(shape);
    render(coach, false);

    if (seenRev !== null && coach.rev !== seenRev) flash();
    seenRev = coach.rev;

    var f = coach.focus;
    var d = carD(frame);
    placeDot(d);
    var now = Date.now();
    var a = approachOf(f, d, lapLengthM(frame), player.speedKph);
    if (a !== "off") {
      litUntil = now + HOLD_MS;
      setApproach(a);
    } else if (now >= litUntil) {
      setApproach("off");
    }
  }

  function init(section) {
    root = section;
    var mount = section.querySelector('[data-role="mount"]');
    mount.innerHTML =
      '<div class="tfoc" data-mode="learning" data-status="none" data-map="none" aria-live="polite">' +
      '<div class="tfoc__top"><span class="tw-label tfoc__label">Focus</span>' +
      '<span class="tfoc__chip" data-tone="new"></span></div>' +
      '<div class="tfoc__main">' +
      '<div class="tfoc__words">' +
      '<div class="tfoc__head"><span class="tfoc__corner tw-num"></span><span class="tfoc__call"></span></div>' +
      '<div class="tfoc__short"></div>' +
      '<div class="tfoc__cost tw-num"></div>' +
      "</div>" +
      '<svg class="tfoc__map" viewBox="0 0 ' + MW + " " + MH + '" aria-hidden="true">' +
      '<path class="tfoc__outline" d=""/><path class="tfoc__span" d=""/>' +
      '<circle class="tfoc__dot" r="3.4" cx="0" cy="0" data-on="false"/></svg>' +
      "</div>" +
      '<p class="tfoc__note"></p>' +
      '<div class="tfoc__foot tw-num"></div>' +
      "</div>";
    el = mount.firstChild;
    ui = {
      chip: el.querySelector(".tfoc__chip"),
      corner: el.querySelector(".tfoc__corner"),
      call: el.querySelector(".tfoc__call"),
      short: el.querySelector(".tfoc__short"),
      cost: el.querySelector(".tfoc__cost"),
      outline: el.querySelector(".tfoc__outline"),
      span: el.querySelector(".tfoc__span"),
      dot: el.querySelector(".tfoc__dot"),
      note: el.querySelector(".tfoc__note"),
      foot: el.querySelector(".tfoc__foot"),
    };
    section.setAttribute("data-coach", "none");
    section.setAttribute("data-approach", "off");
    cur.coach = "none";
    cur.approach = "off";
    useShape(sampleCircuit());
    if (GHOST) {
      GHOST.subscribe(function (data) {
        ghostLine = data || null;
        // A ghost line is only the fallback: a new (or no) ghost lap drops it,
        // and the next frame takes the new one if there is still no track map.
        if (shape && shape.src === "ghost") shape = null;
      });
    }
    render(SAMPLE, true);
  }

  window.ApexOverlay.registerWidget("trainingfocus", {
    // 20 a second: the light has a 3 s lead, so 50 ms (3.5 m at 250 km/h) is
    // far inside it, and the words change a few times a lap at most.
    throttleMs: 50,
    init: init,
    update: update,
  });
})();
