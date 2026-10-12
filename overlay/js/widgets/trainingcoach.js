/**
 * trainingcoach.js — Coach: what your feet, hands and speed are doing right
 * now against the reference lap at the same metre.
 * -----------------------------------------------------------------------------
 * One card, four readings side by side, all at the car's road position:
 *
 *   - the last ~220 m of your throttle and brake by distance, with the next
 *     ~90 m of the reference's still to come (dotted white, as the reference
 *     is drawn everywhere in the training widgets);
 *   - two pedal tubes, each with a white tick where the reference had that
 *     pedal at this metre;
 *   - your speed and gear over the reference's, and one line saying what the
 *     difference is ("−5 km/h · braking 12 m early");
 *   - a steering ring: your lock as a cyan arc, the reference's as a dot.
 *
 * and the live gap to the reference in a chip at the top. Positive is time
 * lost, as on every delta.
 *
 * The reference comes from the shared `/ghost.json` fetch (training-ghost.js),
 * resampled once per lap onto a one-metre grid by training-trace.js — the
 * Telemetry widget's maths, used read-only here. Speed and gear are not on that
 * grid, so they are read off `/ghost.json`'s own columns at the car's distance.
 *
 * Data intake (`update`) runs every frame and only files values; one rAF paint
 * draws, and only while the training layer is on screen.
 */
(function () {
  "use strict";

  var TR = window.ApexTrainingTrace;
  var LAPS = window.ApexTrainingLaps;
  var GHOST = window.ApexTrainingGhost;

  /** The trace's window: metres behind the car, and of the reference ahead. */
  var BEHIND_M = 220;
  var AHEAD_M = 90;
  /** A distance that jumps back further than this is a new run, not a wobble. */
  var TRAIL_BACK_M = 50;
  /** `brakePoints.ts`'s onset threshold, as training-trace.js mirrors it. */
  var BRAKE_ON = TR ? TR.BRAKE_ON : 0.12;
  /** A reference braking onset further than this from yours is another corner. */
  var MATCH_ZONE_M = 80;
  /** Speeds this close read as level, km/h. */
  var LEVEL_KPH = 1;
  var KPH_PER_MPH = 1.609344;

  /* -------------------------------- state --------------------------------- */

  var root = null;
  var canvas = null;
  var gctx = null;
  var cssW = 0;
  var cssH = 0;
  var boxW = -1;
  var rafId = 0;
  var noteWork = null;
  var unit = "kph";

  var els = {};
  var cur = {};

  /** The reference lap, once per selection. */
  var line = null;
  var lapM = 0;
  var grid = null;
  var zones = null;

  var unwrapper = TR ? TR.createUnwrap() : null;
  var trail = TR ? TR.createTrail(512) : null;
  var lastUm = NaN;
  /** Where your current brake application began, lap-continuous metres. */
  var brakeFrom = NaN;

  /** The newest values, filed by `update`, read by `paint`. */
  var live = { um: NaN, thr: 0, brk: 0, steer: 0, rangeDeg: 0, kph: NaN, gear: 0, gap: NaN, active: false };
  var painted = { um: NaN, ver: -1 };
  var ver = 0;

  var C = {
    throttle: "#35d07f",
    brake: "#ff5470",
    ref: "rgba(244,246,251,0.72)",
    cyan: "#22d3ee",
    grid: "rgba(255,255,255,0.05)",
    well: "rgba(255,255,255,0.025)",
    muted: "#6b7387",
    font: "Bahnschrift, 'Arial Narrow', sans-serif",
  };

  function readTokens() {
    var cs = getComputedStyle(document.documentElement);
    var pick = function (name, fallback) {
      var v = cs.getPropertyValue(name).trim();
      return v || fallback;
    };
    C.throttle = pick("--pedal-throttle", C.throttle);
    C.brake = pick("--pedal-brake", C.brake);
    C.ref = pick("--tw-ref", C.ref);
    C.cyan = pick("--ac-cyan", C.cyan);
    C.muted = pick("--text-muted", C.muted);
  }

  /* ------------------------------ text writes ----------------------------- */

  function setText(key, value) {
    if (cur[key] === value) return;
    cur[key] = value;
    els[key].textContent = value;
  }

  function setAttr(key, node, name, value) {
    if (cur[key] === value) return;
    cur[key] = value;
    node.setAttribute(name, value);
  }

  function speedOf(kph) {
    if (!isFinite(kph)) return "—";
    return String(Math.round(unit === "mph" ? kph / KPH_PER_MPH : kph));
  }

  /* --------------------------------- line --------------------------------- */

  function setLine(data) {
    line = data;
    lapM = data && data.trackLengthM > 0 ? data.trackLengthM : 0;
    grid = data && lapM ? TR.resampleRef(data, lapM) : null;
    zones = grid ? TR.brakeZones(grid, data, lapM) : null;
    ver++;
    wake();
  }

  /** `/ghost.json` column `col` at lap fraction `f` (linear), or NaN. */
  function refAt(col, f) {
    var d = line && line.d;
    var c = line && line[col];
    if (!d || !c || c.length !== d.length || !isFinite(f)) return NaN;
    var n = d.length;
    if (f <= d[0]) return line.full === false ? NaN : c[0];
    if (f >= d[n - 1]) return line.full === false ? NaN : c[n - 1];
    var lo = 0;
    var hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (d[mid] <= f) lo = mid;
      else hi = mid;
    }
    var w = d[hi] > d[lo] ? (f - d[lo]) / (d[hi] - d[lo]) : 0;
    return c[lo] + (c[hi] - c[lo]) * w;
  }

  /** The reference's value of a grid channel at lap-continuous metre `um`, or NaN. */
  function gridAt(ch, um) {
    if (!grid || !isFinite(um)) return NaN;
    var i = TR.lapIndex(um, grid.n);
    return grid.ok[i] ? grid[ch][i] : NaN;
  }

  /**
   * Metres between your current braking onset and the reference's nearest
   * one: positive = you started EARLIER. NaN when you are not braking or no
   * reference zone is near.
   */
  function brakeOffset(um) {
    if (!zones || !isFinite(brakeFrom) || !(lapM > 0)) return NaN;
    var at = ((brakeFrom % lapM) + lapM) % lapM;
    var best = NaN;
    for (var k = 0; k < zones.on.length; k++) {
      var dm = zones.on[k] - at;
      if (dm > lapM / 2) dm -= lapM;
      else if (dm < -lapM / 2) dm += lapM;
      if (Math.abs(dm) <= MATCH_ZONE_M && !(Math.abs(dm) >= Math.abs(best))) best = dm;
    }
    return best;
  }

  /* -------------------------------- sizing -------------------------------- */

  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (!w || !h) return;
    var d = window.ApexRaster ? window.ApexRaster.backingScale(canvas) : window.devicePixelRatio || 1;
    var bw = Math.round(w * d);
    var bh = Math.round(h * d);
    if (bw === canvas.width && bh === canvas.height && w === cssW && h === cssH) return;
    cssW = w;
    cssH = h;
    canvas.width = bw;
    canvas.height = bh;
    gctx.setTransform(d, 0, 0, d, 0, 0);
    ver++;
    wake();
  }

  var layerShown = true;

  function shown() {
    if (!layerShown || document.hidden || boxW === 0) return false;
    return document.documentElement.getAttribute("data-autohidden") !== "true";
  }

  function wake() {
    if (rafId || !gctx || !shown()) return;
    var raf = window.requestAnimationFrame
      ? window.requestAnimationFrame.bind(window)
      : function (fn) {
          return window.setTimeout(fn, 16);
        };
    rafId = raf(tick);
  }

  function tick() {
    rafId = 0;
    if (!shown()) return;
    var t0 = performance.now();
    try {
      paint();
    } catch (err) {
      console.error("[Apex] widget 'trainingcoach' paint failed:", err);
    }
    if (noteWork) noteWork("trainingcoach", performance.now() - t0);
  }

  /* --------------------------------- paint -------------------------------- */

  function paint() {
    var um = live.um;
    var refThr = gridAt("thr", um);
    var refBrk = gridAt("brk", um);
    var refStr = gridAt("str", um);
    var f = lapM > 0 && isFinite(um) ? (((um % lapM) + lapM) % lapM) / lapM : NaN;
    var refKph = refAt("speedKph", f);
    var refGear = refAt("gear", f);

    // Chip: the live gap.
    var gapTxt = live.active && isFinite(live.gap) ? LAPS.fmtSigned(live.gap) : "—";
    setText("chip", gapTxt);
    setAttr("chipTone", els.chip, "data-tone", live.active ? LAPS.toneOf(live.gap) : "none");

    // Pedal tubes: fills by transform (no layout), ticks at the reference.
    var thrPct = Math.max(0, Math.min(1, live.thr));
    var brkPct = Math.max(0, Math.min(1, live.brk));
    setText("brkVal", String(Math.round(brkPct * 100)));
    setText("thrVal", String(Math.round(thrPct * 100)));
    var bq = brkPct.toFixed(3);
    var tq = thrPct.toFixed(3);
    if (cur.bq !== bq) {
      cur.bq = bq;
      els.brkFill.style.transform = "scaleY(" + bq + ")";
    }
    if (cur.tq !== tq) {
      cur.tq = tq;
      els.thrFill.style.transform = "scaleY(" + tq + ")";
    }
    tick01("brkTick", els.brkTick, refBrk);
    tick01("thrTick", els.thrTick, refThr);

    // Speeds and gears.
    setText("you", speedOf(live.kph));
    setText("ref", speedOf(refKph));
    setText("youGear", live.gear > 0 ? String(live.gear) : live.gear < 0 ? "R" : "N");
    setText("refGear", isFinite(refGear) ? (Math.round(refGear) > 0 ? String(Math.round(refGear)) : "N") : "—");
    var unitTxt = unit === "mph" ? "mph" : "km/h";
    setText("unitYou", unitTxt);
    setText("unitRef", unitTxt);
    var parts = [];
    var tone = "none";
    if (isFinite(live.kph) && isFinite(refKph)) {
      var dk = live.kph - refKph;
      var shownDk = Math.round(unit === "mph" ? dk / KPH_PER_MPH : dk);
      if (Math.abs(dk) < LEVEL_KPH || shownDk === 0) {
        parts.push("speed level");
        tone = "level";
      } else {
        parts.push((shownDk > 0 ? "+" : "−") + Math.abs(shownDk) + " " + unitTxt);
        tone = dk > 0 ? "gain" : "loss";
      }
    }
    var off = brakeOffset(um);
    if (isFinite(off) && Math.round(Math.abs(off)) >= 3) {
      parts.push("braking " + Math.round(Math.abs(off)) + " m " + (off > 0 ? "early" : "late"));
      if (off > 0) tone = "loss";
    } else if (live.brk < BRAKE_ON && refBrk >= BRAKE_ON) {
      parts.push("reference is braking");
      tone = "loss";
    }
    setText("note", parts.join(" · "));
    setAttr("noteTone", els.note, "data-tone", tone);

    // Steering ring.
    var range = live.rangeDeg > 0 ? live.rangeDeg : 540;
    var youDeg = live.steer * (range / 2);
    setText("steerDeg", isFinite(youDeg) ? Math.round(Math.abs(youDeg)) + "°" : "—");
    ring(youDeg, isFinite(refStr) ? refStr * (range / 2) : NaN);

    // The trace, only when the car has moved or the line changed.
    if (painted.um !== um || painted.ver !== ver) {
      painted.um = um;
      painted.ver = ver;
      drawTrace(um);
    }
  }

  function tick01(key, node, v) {
    var on = isFinite(v);
    var q = on ? Math.max(0, Math.min(1, v)).toFixed(3) : "off";
    if (cur[key] === q) return;
    cur[key] = q;
    node.style.opacity = on ? "1" : "0";
    if (on) node.style.bottom = "calc(" + (Number(q) * 100).toFixed(1) + "% - 1px)";
  }

  /** The ring's arc: 0° at the top, ±135° drawn at full scale. */
  var RING_R = 36;
  var RING_C = 46;
  var RING_FULL = 135;
  function ring(youDeg, refDeg) {
    var a = isFinite(youDeg) ? Math.max(-RING_FULL, Math.min(RING_FULL, youDeg)) : 0;
    var q = a.toFixed(1);
    if (cur.arc !== q) {
      cur.arc = q;
      var circ = 2 * Math.PI * RING_R;
      var len = (Math.abs(a) / 360) * circ;
      els.arc.setAttribute("stroke-dasharray", len.toFixed(2) + " " + circ.toFixed(2));
      // The arc starts at the top and runs clockwise for a right turn,
      // anticlockwise for a left one.
      els.arc.setAttribute(
        "transform",
        a >= 0 ? "rotate(-90 " + RING_C + " " + RING_C + ")" : "rotate(" + (-90 + a) + " " + RING_C + " " + RING_C + ")",
      );
    }
    var r = isFinite(refDeg) ? Math.max(-RING_FULL, Math.min(RING_FULL, refDeg)).toFixed(1) : "off";
    if (cur.refDot !== r) {
      cur.refDot = r;
      if (r === "off") {
        els.refDot.setAttribute("opacity", "0");
      } else {
        var rad = ((Number(r) - 90) * Math.PI) / 180;
        els.refDot.setAttribute("cx", (RING_C + RING_R * Math.cos(rad)).toFixed(2));
        els.refDot.setAttribute("cy", (RING_C + RING_R * Math.sin(rad)).toFixed(2));
        els.refDot.setAttribute("opacity", "1");
      }
    }
  }

  function drawTrace(um) {
    var g = gctx;
    var W = cssW;
    var H = cssH;
    if (!W || !H) return;
    g.clearRect(0, 0, W, H);
    // The well and its gridlines.
    g.fillStyle = C.well;
    roundRect(g, 0, 0, W, H, 10);
    g.fill();
    var top = 8;
    var bot = H - 14;
    var Y = function (v) {
      return bot - v * (bot - top);
    };
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    for (var gi = 0; gi <= 2; gi++) {
      var gy = Math.round(Y(gi / 2)) + 0.5;
      g.beginPath();
      g.moveTo(4, gy);
      g.lineTo(W - 4, gy);
      g.stroke();
    }
    if (!isFinite(um)) return;
    var span = BEHIND_M + AHEAD_M;
    var pxPerM = (W - 8) / span;
    var x0 = 4;
    var m0 = um - BEHIND_M;
    var X = function (m) {
      return x0 + (m - m0) * pxPerM;
    };
    var xNow = X(um);

    // The reference, dotted, across the whole window.
    if (grid) {
      g.save();
      g.setLineDash([0.5, 4.5]);
      g.lineCap = "round";
      g.lineWidth = 2;
      g.strokeStyle = C.ref;
      refPath(g, "thr", m0, m0 + span, X, Y);
      refPath(g, "brk", m0, m0 + span, X, Y);
      g.restore();
    }

    // Yours, solid, up to the car: brake with a soft fill under it.
    var first = Math.ceil(m0);
    var last = Math.floor(um);
    g.beginPath();
    var open = false;
    var startX = 0;
    var lastX = 0;
    for (var m = first; m <= last; m++) {
      var s = TR.trailSlot(trail, m);
      if (s < 0) {
        if (open) closeFill(g, lastX, startX, Y(0));
        open = false;
        continue;
      }
      var x = X(m);
      var y = Y(trail.brk[s]);
      if (!open) {
        g.moveTo(x, Y(0));
        g.lineTo(x, y);
        startX = x;
        open = true;
      } else {
        g.lineTo(x, y);
      }
      lastX = x;
    }
    if (open) closeFill(g, lastX, startX, Y(0));
    g.fillStyle = "rgba(255,84,112,0.2)";
    g.fill();
    yourPath(g, "brk", first, last, X, Y, C.brake);
    yourPath(g, "thr", first, last, X, Y, C.throttle);

    // The car.
    g.strokeStyle = C.cyan;
    g.globalAlpha = 0.85;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(Math.round(xNow) + 0.5, 4);
    g.lineTo(Math.round(xNow) + 0.5, H - 4);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = C.muted;
    g.font = "500 12px " + C.font;
    g.textBaseline = "alphabetic";
    g.fillText("NEXT", xNow + 6, H - 3);
  }

  function closeFill(g, lastX, startX, y0) {
    g.lineTo(lastX, y0);
    g.lineTo(startX, y0);
    g.closePath();
  }

  function refPath(g, ch, a, b, X, Y) {
    g.beginPath();
    var pen = false;
    for (var m = Math.ceil(a); m <= b; m += 2) {
      var i = TR.lapIndex(m, grid.n);
      if (!grid.ok[i]) {
        pen = false;
        continue;
      }
      var x = X(m);
      var y = Y(grid[ch][i]);
      if (pen) g.lineTo(x, y);
      else g.moveTo(x, y);
      pen = true;
    }
    g.stroke();
  }

  function yourPath(g, ch, a, b, X, Y, colour) {
    g.beginPath();
    var pen = false;
    for (var m = a; m <= b; m++) {
      var s = TR.trailSlot(trail, m);
      if (s < 0) {
        pen = false;
        continue;
      }
      var x = X(m);
      var y = Y(trail[ch][s]);
      if (pen) g.lineTo(x, y);
      else g.moveTo(x, y);
      pen = true;
    }
    g.strokeStyle = colour;
    g.lineWidth = 3;
    g.lineJoin = "round";
    g.stroke();
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* -------------------------------- update -------------------------------- */

  function update(frame) {
    if (!gctx || !TR || !LAPS || !GHOST) return;
    var player = frame && frame.player;
    if (!player) return;
    var ghost = player.ghost || null;
    GHOST.sync(ghost);
    var p = player.pedals || {};
    live.thr = +p.throttle || 0;
    live.brk = +p.brake || 0;
    live.steer = +p.steer || 0;
    live.rangeDeg = +p.steerRangeDeg || 0;
    live.kph = typeof player.speedKph === "number" && player.speedKph >= 0 ? player.speedKph : NaN;
    live.gear = typeof player.gear === "number" ? player.gear : 0;
    live.active = !!(ghost && ghost.active);
    live.gap = ghost ? ghost.gapSec : NaN;

    var d = ghost && typeof ghost.atD === "number" ? ghost.atD : NaN;
    if (lapM > 0 && isFinite(d)) {
      var um = TR.unwrap(unwrapper, d) * lapM;
      if (isFinite(lastUm) && um < lastUm - TRAIL_BACK_M) {
        TR.resetTrail(trail);
        brakeFrom = NaN;
      }
      lastUm = um;
      TR.writeTrail(trail, um, live.thr, live.brk, live.steer);
      if (live.brk >= BRAKE_ON) {
        if (!isFinite(brakeFrom)) brakeFrom = um;
      } else if (live.brk < TR.BRAKE_OFF) {
        brakeFrom = NaN;
      }
      live.um = um;
    } else {
      live.um = NaN;
    }
    wake();
  }

  /* --------------------------------- init --------------------------------- */

  function init(el) {
    root = el;
    var mount = el.querySelector('[data-role="mount"]');
    mount.innerHTML =
      '<div class="tcoach">' +
      '<header class="tcoach__head">' +
      '<span class="tcoach__brand"><img src="img/apex-aio-icon.svg" alt="" /><span class="tw-label">Coach</span></span>' +
      '<span class="tw-chip" data-role="chip" data-tone="none">—</span>' +
      "</header>" +
      '<div class="tcoach__grid">' +
      '<canvas class="tcoach__trace" role="img" aria-label="Your throttle and brake over the last 220 metres, solid; the reference lap dotted, and its next 90 metres ahead of the car line"></canvas>' +
      '<div class="tcoach__pedals">' +
      '<div class="tcoach__pedal tcoach__pedal--brk"><span data-role="brkVal">0</span><div class="tcoach__tube"><div class="tcoach__fill" data-role="brkFill"></div><em data-role="brkTick"></em></div></div>' +
      '<div class="tcoach__pedal tcoach__pedal--thr"><span data-role="thrVal">0</span><div class="tcoach__tube"><div class="tcoach__fill" data-role="thrFill"></div><em data-role="thrTick"></em></div></div>' +
      "</div>" +
      '<div class="tcoach__speeds">' +
      '<div class="tcoach__sp"><i>You</i><b><span data-role="you">—</span><small data-role="unitYou">km/h</small></b><span class="tcoach__gear" data-role="youGear">—</span></div>' +
      '<div class="tcoach__sp tcoach__sp--ref"><i>Ref</i><b><span data-role="ref">—</span><small data-role="unitRef">km/h</small></b><span class="tcoach__gear" data-role="refGear">—</span></div>' +
      '<div class="tcoach__note tw-tone" data-role="note" data-tone="none"></div>' +
      "</div>" +
      '<svg class="tcoach__ring" viewBox="0 0 92 92" aria-hidden="true">' +
      '<circle cx="46" cy="46" r="36" class="tcoach__ringbg"/>' +
      '<circle cx="46" cy="46" r="36" class="tcoach__arc" data-role="arc" stroke-dasharray="0 999"/>' +
      '<circle cx="46" cy="10" r="3.5" class="tcoach__refdot" data-role="refDot" opacity="0"/>' +
      '<text x="46" y="52" class="tcoach__deg" data-role="steerDeg">—</text>' +
      '<text x="46" y="68" class="tcoach__steer">STEER</text>' +
      "</svg>" +
      "</div>" +
      "</div>";
    var q = function (r) {
      return mount.querySelector('[data-role="' + r + '"]');
    };
    [
      "chip",
      "brkVal",
      "thrVal",
      "brkFill",
      "thrFill",
      "brkTick",
      "thrTick",
      "you",
      "ref",
      "unitYou",
      "unitRef",
      "youGear",
      "refGear",
      "note",
      "arc",
      "refDot",
      "steerDeg",
    ].forEach(function (k) {
      els[k] = q(k);
    });
    canvas = mount.querySelector(".tcoach__trace");
    gctx = canvas.getContext("2d");
    if (!TR || !LAPS || !GHOST) {
      console.error("[Apex] Coach needs training-trace.js, training-laps.js and training-ghost.js loaded first");
      return;
    }
    var api = window.ApexOverlay;
    noteWork = api && typeof api.noteWidgetWork === "function" ? api.noteWidgetWork : null;
    readTokens();
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function (entries) {
        var r = entries[entries.length - 1].contentRect;
        boxW = r ? r.width : -1;
        sizeCanvas();
      }).observe(canvas);
    }
    window.addEventListener("resize", sizeCanvas, { passive: true });
    document.addEventListener("visibilitychange", wake);
    var bridge = window.apexIngame;
    if (bridge && typeof bridge.onTrainingShown === "function") {
      bridge.onTrainingShown(function (on) {
        layerShown = on;
        if (on) wake();
      });
    }
    var look = window.ApexAppearance;
    if (look && typeof look.onSpeedUnit === "function") {
      look.onSpeedUnit(function (u) {
        unit = u === "mph" ? "mph" : "kph";
        wake();
      });
    }
    sizeCanvas();
    GHOST.subscribe(setLine);
  }

  window.ApexOverlay.registerWidget("trainingcoach", {
    // Every frame: the pedals and the trace move with the car.
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
