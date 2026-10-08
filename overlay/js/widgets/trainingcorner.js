/**
 * trainingcorner.js — Corner Analysis: how the corner you just left went.
 * -----------------------------------------------------------------------------
 * One card, always about the LAST corner driven: its name and what it cost or
 * gave against the reference lap in big type ("C5  +0.31s"), the apex-speed
 * difference under it, then the corner itself drawn as speed against
 * distance — the reference dotted white, you solid in the verdict's colour,
 * the metres where you were slower shaded red — and a one-line tip worded
 * from the braking point and apex speed. A footer line says what is next:
 * "NEXT  C6 · brake in 163 m".
 *
 * Corners are numbered C1..Cn in the reference lap's own order. They are cut
 * from its driven line (`corners.ts`) and are not the circuit's official
 * turns; the card never claims a name it cannot know.
 *
 * Where the numbers come from:
 *   - the verdict (time, braking point, apex speed) is worked out on the
 *     server (`cornerTracker.ts`) and arrives as `frame.player.ghost.corner`;
 *   - the reference's speed and the corner's span are `/ghost.json`'s
 *     `speedKph` and `corners`, from the one shared fetch (training-ghost.js);
 *   - YOUR speed through the corner is recorded here, per metre, from every
 *     frame's `player.speedKph` at `ghost.atD` — the same filtered road
 *     position the gap is measured on, so the two curves share an axis.
 *
 * The chart is built once per verdict (a few times a lap); the text is only
 * written when it changes. Wording goes through `training-laps.js`, so this
 * card and the Lap strip can never describe the same corner differently.
 */
(function () {
  "use strict";

  var LAPS = window.ApexTrainingLaps;
  var GHOST = window.ApexTrainingGhost;

  var NS = "http://www.w3.org/2000/svg";
  /** Chart box, CSS px (the SVG scales with the card). */
  var CW = 386;
  var CH = 132;
  /** Metres shown before the corner's braking point / entry, and after its exit. */
  var LEAD_M = 40;
  var TAIL_M = 70;
  /** How far back from the entry the reference's braking point may be, metres. */
  var BRAKE_LOOK_M = 320;
  /** Gaps between frames longer than this are not filled in (a tow, a reset). */
  var MAX_FILL_M = 60;
  var KPH_PER_MPH = 1.609344;

  var el = null;
  var ui = {};
  var unit = "kph";

  /** `/ghost.json`, once loaded. */
  var line = null;

  /** Your speed, km/h, per lap metre — this lap and the last. NaN = not driven. */
  var lapSpd = null;
  var prevSpd = null;
  var lastM = NaN;
  var lastKph = NaN;
  var lastD = NaN;

  /** The verdict on show and the one most recently charted. */
  var shown = null;
  var shownSeq = -1;
  var primed = false;
  /**
   * The verdict lands at the corner's exit, before the run-out after it has
   * been driven: the chart is drawn again a few times over the next seconds
   * so your trace reaches the end of it.
   */
  var FOLLOW_MS = 3500;
  var FOLLOW_EVERY_MS = 250;
  var followUntil = 0;
  var drawnAt = 0;

  /** Last values written, so the DOM is only touched on change. */
  var cur = {};

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

  /* ------------------------------ recording ------------------------------ */

  function lapM() {
    return line && line.trackLengthM > 0 ? line.trackLengthM : 0;
  }

  function ensureBuffers() {
    var n = Math.floor(lapM());
    if (!(n > 0)) return false;
    if (!lapSpd || lapSpd.length !== n) {
      lapSpd = new Float32Array(n).fill(NaN);
      prevSpd = new Float32Array(n).fill(NaN);
      lastM = NaN;
    }
    return true;
  }

  /** File this frame's speed at lap fraction `d`, filling the metres since the last frame. */
  function record(d, kph) {
    if (!isFinite(d) || !isFinite(kph) || !ensureBuffers()) return;
    var n = lapSpd.length;
    if (isFinite(lastD) && d < lastD - 0.5) {
      // Over the line: this lap becomes the last one.
      var t = prevSpd;
      prevSpd = lapSpd;
      lapSpd = t;
      lapSpd.fill(NaN);
      lastM = NaN;
    }
    lastD = d;
    var m = Math.min(n - 1, Math.max(0, Math.floor(d * n)));
    var gap = m - lastM;
    if (isFinite(lastM) && gap > 1 && gap <= MAX_FILL_M) {
      for (var k = 1; k < gap; k++) lapSpd[lastM + k] = lastKph + ((kph - lastKph) * k) / gap;
    }
    lapSpd[m] = kph;
    lastM = m;
    lastKph = kph;
  }

  /* ------------------------------- the line ------------------------------ */

  /** The reference's speed at lap fraction `f`, linear between samples. */
  function refKphAt(f) {
    var dd = line.d;
    var sp = line.speedKph;
    var n = Math.min(dd.length, sp.length);
    if (f < dd[0] || f > dd[n - 1]) return NaN;
    var lo = 1;
    var hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (dd[mid] >= f) hi = mid;
      else lo = mid + 1;
    }
    var a = dd[lo - 1];
    var b = dd[lo];
    return b > a ? sp[lo - 1] + (sp[lo] - sp[lo - 1]) * ((f - a) / (b - a)) : sp[lo - 1];
  }

  /** The metres a corner's chart covers: from just before its braking point to just after its exit. */
  function spanOf(c) {
    var L = lapM();
    var start = c.entryD * L;
    if (Array.isArray(line.brakes)) {
      for (var i = 0; i < line.brakes.length; i++) {
        var bm = line.brakes[i] && line.brakes[i].d * L;
        if (isFinite(bm) && bm <= start && start - bm <= BRAKE_LOOK_M) {
          // The latest braking point before the entry is this corner's.
          if (!isFinite(c._bm) || bm > c._bm) c._bm = bm;
        }
      }
    }
    if (isFinite(c._bm)) start = c._bm;
    var a = Math.max(0, start - LEAD_M);
    var b = Math.min(L - 1, c.exitD * L + TAIL_M);
    return { a: a, b: b, apex: c.apexD * L };
  }

  /* ------------------------------- the chart ----------------------------- */

  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function pathOf(pts) {
    var s = "";
    for (var i = 0; i < pts.length; i++) {
      s += (i ? "L" : "M") + pts[i][0].toFixed(1) + " " + pts[i][1].toFixed(1);
    }
    return s;
  }

  /**
   * Draw the corner. `spd` is the lap buffer that holds the corner just
   * driven (this lap's, or last lap's for a corner that ended on the line).
   */
  function drawChart(verdict) {
    var svg = ui.chart;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!line || !line.corners || !line.speedKph || !line.corners[verdict.index]) {
      ui.chartNote.textContent = "No speed trace for this corner";
      setAttr("chartState", el, "data-chart", "none");
      return;
    }
    var c = line.corners[verdict.index];
    var L = lapM();
    var sp = spanOf({ entryD: c.entryD, apexD: c.apexD, exitD: c.exitD });
    var spd = lapSpd;
    // A corner that finished before the car crossed the line is on this lap;
    // one whose span runs past where the car is now belongs to the last lap.
    if (lapSpd && isFinite(lastM) && sp.a > lastM) spd = prevSpd;

    var step = Math.max(1, (sp.b - sp.a) / 160);
    var ref = [];
    var you = [];
    var lo = Infinity;
    var hi = -Infinity;
    for (var m = sp.a; m <= sp.b + 0.001; m += step) {
      var r = refKphAt(m / L);
      var y = spd ? spd[Math.floor(m)] : NaN;
      ref.push([m, r]);
      you.push([m, y]);
      if (isFinite(r)) { lo = Math.min(lo, r); hi = Math.max(hi, r); }
      if (isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
    }
    if (!isFinite(lo)) {
      ui.chartNote.textContent = "No speed trace for this corner";
      setAttr("chartState", el, "data-chart", "none");
      return;
    }
    setAttr("chartState", el, "data-chart", "on");
    var pad = Math.max(6, (hi - lo) * 0.12);
    lo -= pad;
    hi += pad;
    var top = 8;
    var bot = CH - 24;
    var X = function (mm) { return 6 + ((mm - sp.a) / (sp.b - sp.a)) * (CW - 12); };
    var Y = function (v) { return top + (1 - (v - lo) / (hi - lo)) * (bot - top); };

    // Three quiet guide lines.
    for (var g = 0; g < 3; g++) {
      var gy = top + ((bot - top) * (g + 0.5)) / 3;
      svgEl("line", { x1: 6, x2: CW - 6, y1: gy, y2: gy, class: "tcan__grid" }, svg);
    }

    var refPts = [];
    var youRuns = [];
    var run = null;
    var slowUp = [];
    var slowLo = [];
    for (var i = 0; i < ref.length; i++) {
      var x = X(ref[i][0]);
      var rv = ref[i][1];
      var yv = you[i][1];
      if (isFinite(rv)) refPts.push([x, Y(rv)]);
      if (isFinite(yv)) {
        if (!run) youRuns.push((run = []));
        run.push([x, Y(yv)]);
      } else run = null;
      // Shade only where you were slower than the reference.
      if (isFinite(rv) && isFinite(yv)) {
        slowUp.push([x, Y(rv)]);
        slowLo.push([x, Y(Math.min(yv, rv))]);
      }
    }
    if (slowUp.length > 1) {
      svgEl("path", { d: pathOf(slowUp) + pathOf(slowLo.reverse()).replace(/^M/, "L") + "Z", class: "tcan__slow" }, svg);
    }
    // Apex: the reference's minimum, where this corner was cut from.
    var ax = X(sp.apex);
    svgEl("line", { x1: ax, x2: ax, y1: 4, y2: bot + 2, class: "tcan__apex" }, svg);
    svgEl("path", { d: pathOf(refPts), class: "tcan__ref" }, svg);
    for (var k = 0; k < youRuns.length; k++) {
      if (youRuns[k].length > 1) svgEl("path", { d: pathOf(youRuns[k]), class: "tcan__you" }, svg);
    }
    var t1 = svgEl("text", { x: 6, y: CH - 6, class: "tcan__axis" }, svg);
    t1.textContent = "ENTRY";
    var t2 = svgEl("text", { x: ax, y: CH - 6, class: "tcan__axis tcan__axis--apex", "text-anchor": "middle" }, svg);
    t2.textContent = "APEX";
    var t3 = svgEl("text", { x: CW - 6, y: CH - 6, class: "tcan__axis", "text-anchor": "end" }, svg);
    t3.textContent = "EXIT";
    if (youRuns.length === 0) {
      ui.chartNote.textContent = "Your trace starts at the next corner";
      setAttr("chartState", el, "data-chart", "ref");
    }
  }

  /* -------------------------------- words -------------------------------- */

  function speedWord(kph) {
    var mph = unit === "mph";
    var v = Math.round(Math.abs(mph ? kph / KPH_PER_MPH : kph));
    return v + (mph ? " mph" : " km/h");
  }

  /** "−9 km/h at apex" / "+4 mph at apex" / "apex speed level". */
  function apexLine(kph) {
    if (kph === null || kph === undefined || !isFinite(kph)) return "";
    var p = LAPS.apexPhrase(kph, unit);
    if (!p || p === "apex speed level") return p || "";
    // apexPhrase says "apex −6 km/h"; the card reads the other way round.
    return p.replace(/^apex /, "") + " at apex";
  }

  /** One line of advice from the braking point and the apex speed. */
  function tipOf(v) {
    var tone = LAPS.toneOf(v.deltaSec);
    var bm = v.brakeDeltaM;
    var ak = v.apexKphDelta;
    var hasB = bm !== null && bm !== undefined && isFinite(bm) && Math.abs(bm) >= 3;
    var hasA = ak !== null && ak !== undefined && isFinite(ak) && Math.abs(ak) >= 1;
    if (tone === "none") return "No timing for this corner";
    if (tone === "level") return "Matched the reference here";
    if (tone === "gain") {
      if (hasA && ak > 0) return "Carried " + speedWord(ak) + " more — keep it";
      if (hasB && bm > 0) return "Braked " + Math.round(bm) + " m later — keep it";
      return "Quicker through here — keep it";
    }
    // Lost time.
    var brake = "";
    if (hasB) brake = bm < 0 ? "Brake " + Math.round(-bm) + " m later" : "Brake " + Math.round(bm) + " m earlier";
    var apex = hasA && ak < 0 ? "+" + speedWord(ak) + " at the apex" : "";
    if (brake && apex) return brake + ": " + apex;
    if (brake) return brake;
    if (apex) return "Carry " + speedWord(ak) + " more to the apex";
    return "Lost it on the exit — throttle sooner";
  }

  /* ------------------------------- the card ------------------------------ */

  function showVerdict(v) {
    var tone = LAPS.toneOf(v.deltaSec);
    setAttr("tone", el, "data-tone", tone);
    setAttr("bigTone", ui.delta, "data-tone", tone);
    set("name", ui.name, LAPS.cornerName(v.index));
    set("delta", ui.deltaNum, v.deltaSec === null ? "—" : LAPS.fmtSigned(v.deltaSec));
    set("unit", ui.deltaUnit, v.deltaSec === null ? "" : "s");
    set("apex", ui.apex, apexLine(v.apexKphDelta));
    set("sub", ui.sub, LAPS.brakePhrase(v.brakeDeltaM) || "");
    set("tip", ui.tip, tipOf(v));
    drawChart(v);
    drawnAt = Date.now();
    followUntil = drawnAt + FOLLOW_MS;
  }

  function setMode(mode, note) {
    setAttr("mode", el, "data-mode", mode);
    if (note !== undefined) set("note", ui.note, note);
  }

  function update(frame) {
    if (!el || !LAPS) return;
    var ghost = frame && frame.player ? frame.player.ghost : null;
    if (GHOST) GHOST.sync(ghost);
    var corner = ghost ? ghost.corner : null;

    if (!ghost) {
      setMode("none", "No ghost lap — pick one in the Training tab");
      set("next", ui.next, "");
      return;
    }
    if (ghost.active && isFinite(ghost.atD)) record(ghost.atD, frame.player.speedKph);
    if (!corner) {
      setMode("none", "No corners on this reference lap");
      set("next", ui.next, "");
      return;
    }
    // Inside a corner the footer names it as NOW, not "NEXT  in C3".
    set("nextLabel", ui.nextLabel, corner.inside ? "Now" : "Next");
    set("next", ui.next, corner.inside ? LAPS.cornerName(corner.index) : LAPS.nextPhrase(corner));

    var v = corner.last || null;
    if (!primed) {
      // The card has just appeared: a verdict older than it is shown, but
      // there is no trace of yours for it.
      primed = true;
      if (v) {
        shown = v;
        shownSeq = v.seq;
        showVerdict(v);
      }
    } else if (v && v.seq !== shownSeq) {
      shownSeq = v.seq;
      shown = v;
      showVerdict(v);
    } else if (shown && Date.now() < followUntil && Date.now() - drawnAt >= FOLLOW_EVERY_MS) {
      drawnAt = Date.now();
      drawChart(shown);
    } else if (shown && cur.chartState === "none" && line) {
      // The line arrived after the verdict: draw it now.
      drawChart(shown);
    }

    if (shown) setMode("verdict");
    else setMode("wait", "Analysis after your first corner");
  }

  function init(root) {
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML =
      '<div class="tcan" data-mode="none" data-tone="none" data-chart="none" aria-live="polite">' +
      '<div class="tcan__top"><span class="tw-label">Corner analysis</span>' +
      '<span class="tw-label tcan__last">Last corner</span></div>' +
      '<div class="tcan__head">' +
      '<div class="tcan__who"><span class="tcan__name tw-num"></span><span class="tcan__sub tw-num"></span></div>' +
      '<div class="tcan__verdict"><span class="tw-big tcan__delta" data-tone="none">' +
      '<span class="tcan__dnum"></span><small class="tcan__dunit"></small></span>' +
      '<span class="tcan__apex tw-num"></span></div>' +
      "</div>" +
      '<div class="tcan__plot"><svg class="tcan__chart" viewBox="0 0 ' + CW + " " + CH + '" preserveAspectRatio="none"></svg>' +
      '<span class="tcan__chartnote"></span></div>' +
      '<div class="tcan__tip"><svg class="tcan__bulb" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>' +
      '<span class="tcan__tiptext"></span></div>' +
      '<div class="tcan__foot"><span class="tw-label tcan__nextlabel">Next</span><span class="tcan__next tw-num"></span></div>' +
      '<p class="tcan__note tw-empty"></p>' +
      "</div>";
    el = mount.firstChild;
    ui = {
      name: el.querySelector(".tcan__name"),
      sub: el.querySelector(".tcan__sub"),
      delta: el.querySelector(".tcan__delta"),
      deltaNum: el.querySelector(".tcan__dnum"),
      deltaUnit: el.querySelector(".tcan__dunit"),
      apex: el.querySelector(".tcan__apex"),
      chart: el.querySelector(".tcan__chart"),
      chartNote: el.querySelector(".tcan__chartnote"),
      tip: el.querySelector(".tcan__tiptext"),
      next: el.querySelector(".tcan__next"),
      nextLabel: el.querySelector(".tcan__nextlabel"),
      note: el.querySelector(".tcan__note"),
    };
    if (!LAPS) {
      console.error("[Apex] Corner analysis needs training-laps.js loaded first");
      return;
    }
    if (GHOST) {
      GHOST.subscribe(function (data) {
        line = data || null;
        lapSpd = null;
        prevSpd = null;
        lastM = NaN;
        lastD = NaN;
        if (shown && el) drawChart(shown);
      });
    }
    var look = window.ApexAppearance;
    if (look && typeof look.onSpeedUnit === "function") {
      look.onSpeedUnit(function (u) {
        unit = u;
        if (shown) {
          set("apex", ui.apex, apexLine(shown.apexKphDelta));
          set("tip", ui.tip, tipOf(shown));
        }
      });
    }
  }

  window.ApexOverlay.registerWidget("trainingcorner", {
    // ~30 a second: the speed trace is recorded from these frames, and at
    // 250 km/h a tenth-second sample would be 7 m apart. The DOM is only
    // written when a value changes, and the chart once per corner.
    throttleMs: 33,
    init: init,
    update: update,
  });
})();
