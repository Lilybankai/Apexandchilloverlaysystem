/**
 * trainingfocus.js — Focus: the corners the live coach is working on.
 * -----------------------------------------------------------------------------
 * The in-game half of the live practice coach. After every timed lap of a
 * practice session the coach (electron/live-coach.js, liveCoach.ts) keeps a
 * WORK LIST of up to three corners that have cost the most CONSISTENTLY over
 * the last few laps, and cues each one on the radio as the car comes to it.
 * This card shows the same thing, quietly:
 *
 *     FOCUS                                  [NEW]
 *     C4  NEXT                          ╭──────╮
 *     Brake 10 m later                  │ map  │
 *     ≈0.15 s a lap                     ╰──────╯
 *     • C7 · 0.11   • C11 · 0.08
 *     ✓ C2 −0.2 · C9 −0.1
 *     Last 3:29.41 · +0.62 vs best
 *
 * The big line is the work corner the car is HEADING FOR — the first one whose
 * exit is still ahead of the car on this lap, round the line — so it changes
 * as the lap goes: through C4's exit it moves on to C7, and so on. The other
 * work corners sit under it as small chips in the order they come up, each
 * with a dot for its status (new / working on it / getting better). The ✓ row
 * is what got better this run (`coach.improved`, at most three, biggest gain
 * first), and is not there until something has.
 *
 * The card lights up as the car comes to the big corner — the card's edge
 * glows and a "NEXT" pill sits beside the corner id, then "NOW" through it —
 * so the driver who glances at it at 250 km/h reads two things: which corner,
 * what to do.
 *
 * ## v1 overlays
 * Coach v1 published one `focus` and no `work`. Without `work` (or with an
 * empty one) the card reads `[focus]` as a one-corner list, which renders
 * exactly as v1 did: no chips, the focus as the big line wherever the car is.
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
 * before the big corner's `entryD` (never under {@link LEAD_MIN_M}), held
 * through its `exitD` and {@link HOLD_MS} past it — the big line stays on that
 * corner for the hold too, so "C4 NOW" never sits over the next corner's
 * words. It needs the lap length, from the track map's shape, the ghost lap or
 * `session.trackLengthM`, whichever is known first. With no position at all
 * (pit lane, a frame without the player's car) the big line is the costliest
 * corner, `work[0]`, and nothing lights.
 *
 * A step BACKWARDS in the position just after an exit (REST lap distance
 * jitters, ~7 Hz) does not take the card back to the corner just left: a
 * corner passed by less than {@link BACK_TOL_M} is skipped while the car is a
 * hair before its exit again.
 *
 * ## The map
 * The circuit's outline, faint, with every work corner's `entryD..exitD` span
 * marked — the big corner brightest — and the car as a dot. The shape is
 * `/trackmap.json` (the learned circuit, one point per bin of lap distance
 * from the line, so a lap fraction IS an index) fetched once per track
 * revision — or, before a map has been
 * learned, the ghost lap's own driven line from the shared `/ghost.json`
 * (training-ghost.js), whose points carry their lap fraction. No shape, no
 * map: the card is whole without it.
 *
 * ## States
 *   - no `player.coach`      → hidden (edit mode: a dimmed sample, to place it)
 *   - validLaps < minLaps    → "Learning your laps… 1 / 2", small and calm
 *   - nothing on the list    → "Clean laps — nothing big to fix"
 *   - a work list / a focus  → the card, its status chip, the light
 * A new `rev` (the list changed) flashes the card once.
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
  var MW = 150;
  var MH = 96;
  var MPAD = 6;
  /** Points the faint outline is drawn with; the bright span keeps them all. */
  var OUTLINE_PTS = 240;
  /**
   * Metres: a corner the car left by less than this is not taken back when the
   * position steps backwards to just before its exit (jitter, not reversing).
   */
  var BACK_TOL_M = 30;
  /** The ✓ row names at most this many corners. */
  var MAX_IMPROVED = 3;
  /** A cue longer than this many characters is set a size down (training-focus.css `data-long`). */
  var LONG_SHORT = 18;

  /** The sample shown in edit mode while there is no coach to show: the full v2 card, to size it. */
  var SAMPLE = {
    focus: { cornerId: "C4", cornerNo: 4, entryD: 0.28, apexD: 0.3, exitD: 0.32, lossSec: 0.15, short: "Brake 10 m later", status: "new" },
    work: [
      { cornerId: "C4", cornerNo: 4, entryD: 0.28, apexD: 0.3, exitD: 0.32, lossSec: 0.15, short: "Brake 10 m later", status: "new", rank: 1 },
      { cornerId: "C7", cornerNo: 7, entryD: 0.55, apexD: 0.57, exitD: 0.59, lossSec: 0.11, short: "Carry 4 km/h more", status: "holding", rank: 2 },
      { cornerId: "C11", cornerNo: 11, entryD: 0.84, apexD: 0.86, exitD: 0.88, lossSec: 0.08, short: "Throttle 15 m sooner", status: "improving", rank: 3 },
    ],
    improved: [{ cornerId: "C2", cornerNo: 2, gainSec: 0.21 }],
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
  /** The other work corners' spans (one path), likewise. */
  var othersKey = "";
  /** What the map is drawn from right now: `shape`, or the sample's made-up circuit in edit mode. */
  var drawn = null;
  var sampleShape = null;

  var seenRev = null;
  var flashTimer = 0;
  var flashFlip = false;
  var litUntil = 0;
  /** The corner the light is on (held for HOLD_MS past its exit), by id. */
  var litId = null;
  /** The corner the car last left, and that corner's exit, for the jitter rule. */
  var passed = null;
  /** The big corner of the last frame, by id. */
  var bigId = null;

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

  function idOf(f) {
    return f.cornerId || "C" + f.cornerNo;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** A gain on the ✓ row: tenths once it is a tenth, hundredths below ("0.2", "0.05"). */
  function gainShort(sec) {
    return sec >= 0.095 ? sec.toFixed(1) : sec.toFixed(2);
  }

  /**
   * "✓ C4 −0.2 · C9 −0.1": `coach.improved`, biggest gain first, at most
   * {@link MAX_IMPROVED}; "" when there is nothing (the row is then not there).
   */
  function betterWords(list) {
    if (!Array.isArray(list)) return "";
    var xs = [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (!x || typeof x.gainSec !== "number" || !isFinite(x.gainSec) || x.gainSec < 0.005) continue;
      if (!x.cornerId && !(x.cornerNo > 0)) continue;
      xs.push({ x: x, i: i });
    }
    if (!xs.length) return "";
    // Stable: equal gains keep the coach's order.
    xs.sort(function (a, b) { return b.x.gainSec - a.x.gainSec || a.i - b.i; });
    var out = [];
    for (var k = 0; k < xs.length && k < MAX_IMPROVED; k++) out.push(idOf(xs[k].x) + " −" + gainShort(xs[k].x.gainSec));
    return "✓ " + out.join(" · ");
  }

  /* ----------------------------- the work list --------------------------- */

  /**
   * The corners to show: v2's `work` when it has any, else v1's one `focus`
   * as a list of one (an empty `work` with a focus is read the same way: the
   * engine keeps focus === work[0], so that only happens to a v1 producer).
   */
  function workOf(c) {
    var out = [];
    if (Array.isArray(c.work)) {
      for (var i = 0; i < c.work.length; i++) {
        var f = c.work[i];
        if (f && typeof f === "object") out.push(f);
      }
    }
    if (!out.length && c.focus && typeof c.focus === "object") out.push(c.focus);
    return out;
  }

  function hasSpan(f) {
    return !!f && typeof f.entryD === "number" && isFinite(f.entryD) && typeof f.exitD === "number" && isFinite(f.exitD);
  }

  /** Lap fraction from `a` forward to `b`, round the line: 0 ≤ x < 1. */
  function fwd(a, b) {
    var x = b - a;
    return x - Math.floor(x);
  }

  function byId(work, id) {
    for (var i = 0; i < work.length; i++) if (idOf(work[i]) === id) return work[i];
    return null;
  }

  /**
   * The work corner the car is heading for: the one whose EXIT comes first
   * going forward from `d`, round the line — so the corner the car is in stays
   * the big one until it leaves it, and three corners all behind the car give
   * the first after the line. No position: the costliest, work[0].
   */
  function nextOf(work, d, L) {
    if (!work.length) return null;
    if (!isFinite(d)) return work[0];
    var tol = L > 0 ? BACK_TOL_M / L : 0.005;
    if (passed) {
      var since = fwd(passed.exitD, d);
      // Clearly beyond the corner left (and not a whole lap round): forget it.
      if (since > tol && since < 0.5) passed = null;
    }
    var best = null, bestDist = Infinity, any = null, anyDist = Infinity;
    for (var i = 0; i < work.length; i++) {
      var f = work[i];
      if (!hasSpan(f)) continue;
      var dist = fwd(d, f.exitD);
      if (dist < anyDist) { any = f; anyDist = dist; }
      // A hair before the exit of the corner just left: jitter, not the car.
      if (passed && idOf(f) === passed.id && dist < tol) continue;
      if (dist < bestDist) { best = f; bestDist = dist; }
    }
    return best || any || work[0];
  }

  /** The work corners other than `big`, in the order they come up after it. */
  function othersOf(work, big) {
    var out = [];
    for (var i = 0; i < work.length; i++) if (work[i] !== big) out.push(work[i]);
    if (!hasSpan(big)) return out;
    var from = big.exitD;
    out.sort(function (a, b) {
      var da = hasSpan(a) ? fwd(from, a.exitD) : 2;
      var db = hasSpan(b) ? fwd(from, b.exitD) : 2;
      return da - db;
    });
    return out;
  }

  /** The chips' markup: "C7 · 0.11" with a status dot; a sorted one is "C7 ✓". */
  function chipsHtml(list) {
    var s = "";
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var st = CHIP[f.status] ? f.status : "holding";
      var val = st === "fixed" ? " ✓" : typeof f.lossSec === "number" && isFinite(f.lossSec) && f.lossSec > 0 ? " · " + f.lossSec.toFixed(2) : "";
      s += '<span class="tfoc__wc" data-st="' + st + '"><span class="tfoc__wcId">' + esc(idOf(f)) + "</span>" +
        (val ? '<span class="tfoc__wcVal">' + val + "</span>" : "") + "</span>";
    }
    return s;
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
    othersKey = "";
    ui.span.setAttribute("d", "");
    ui.others.setAttribute("d", "");
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

  /** One corner's `entryD..exitD` as a path on the drawn shape ("" off the map). */
  function spanPath(f) {
    if (!drawn || !hasSpan(f)) return "";
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
    return pathOf(run, false);
  }

  /** The big corner bright, the other work corners dimmer (one path of several strokes). */
  function drawSpans(big, others) {
    if (!drawn) return;
    var key = hasSpan(big) ? big.entryD + ":" + big.exitD : "";
    if (key !== spanKey) {
      spanKey = key;
      ui.span.setAttribute("d", big ? spanPath(big) : "");
    }
    var ok = "";
    for (var i = 0; i < others.length; i++) if (hasSpan(others[i])) ok += others[i].entryD + ":" + others[i].exitD + ";";
    if (ok !== othersKey) {
      othersKey = ok;
      var d = "";
      for (var j = 0; j < others.length; j++) d += spanPath(others[j]);
      ui.others.setAttribute("d", d);
    }
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

  /** The card for work list `work`, with `f` (one of them, or null) as the big line. */
  function render(c, work, f, sample) {
    var mode;
    if (f) mode = "focus";
    else if ((c.validLaps || 0) < (c.minLaps || 0)) mode = "learning";
    else mode = "clean";
    setAttr("mode", el, "data-mode", mode);
    setAttr("sample", el, "data-sample", sample ? "true" : "false");
    setAttr("count", el, "data-work", String(f ? work.length : 0));

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
      setAttr("shortLong", ui.short, "data-long", (f.short || "").length > LONG_SHORT ? "true" : "false");
      // A sorted corner's cost is history: say what happens next instead.
      set("cost", ui.cost, f.status === "fixed" ? "On to the next corner" : costWords(f.lossSec));
      var chip = CHIP[f.status] || CHIP.holding;
      set("chip", ui.chip, chip.text);
      setAttr("chipTone", ui.chip, "data-tone", chip.tone);
      setAttr("status", el, "data-status", f.status || "holding");
      var others = othersOf(work, f);
      drawSpans(f, others);
      chips(chipsHtml(others));
    } else {
      setAttr("status", el, "data-status", "none");
      drawSpans(null, []);
      chips("");
    }
    set("better", ui.better, betterWords(c.improved));
    set("foot", ui.foot, footWords(c));
  }

  function chips(html) {
    if (cur.chips === html) return;
    cur.chips = html;
    ui.chips.innerHTML = html;
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
      render(SAMPLE, SAMPLE.work, SAMPLE.work[0], true);
      setApproach("off");
      placeDot(SAMPLE.focus.entryD - 0.05);
      seenRev = null;
      litUntil = 0;
      litId = null;
      passed = null;
      bigId = null;
      return;
    }
    setAttr("coach", root, "data-coach", "on");
    useShape(shape);

    var work = workOf(coach);
    var d = carD(frame);
    var L = lapLengthM(frame);
    var now = Date.now();
    var target = nextOf(work, d, L);
    var a = approachOf(target, d, L, player.speedKph);
    var big = target;
    if (a !== "off") {
      litUntil = now + HOLD_MS;
      litId = idOf(target);
    } else {
      // Just out of the lit corner: it stays the big line, lit, for the hold
      // (position jitter). A corner that left the list goes dark now.
      var held = litId !== null && now < litUntil ? byId(work, litId) : null;
      if (held) {
        big = held;
        a = null;
      } else {
        litUntil = 0;
        litId = null;
      }
    }
    // The corner the car has just moved on from, for the jitter rule.
    if (bigId !== null && big && idOf(big) !== bigId) {
      var left = byId(work, bigId);
      passed = left && hasSpan(left) && isFinite(d) && fwd(left.exitD, d) < 0.5 ? { id: bigId, exitD: left.exitD } : null;
    }
    bigId = big ? idOf(big) : null;

    render(coach, work, big, false);

    if (seenRev !== null && coach.rev !== seenRev) flash();
    seenRev = coach.rev;

    placeDot(d);
    if (a !== null) setApproach(a);
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
      '<path class="tfoc__outline" d=""/><path class="tfoc__others" d=""/><path class="tfoc__span" d=""/>' +
      '<circle class="tfoc__dot" r="3.4" cx="0" cy="0" data-on="false"/></svg>' +
      "</div>" +
      '<div class="tfoc__chips"></div>' +
      '<p class="tfoc__note"></p>' +
      '<div class="tfoc__better tw-num"></div>' +
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
      others: el.querySelector(".tfoc__others"),
      dot: el.querySelector(".tfoc__dot"),
      chips: el.querySelector(".tfoc__chips"),
      note: el.querySelector(".tfoc__note"),
      better: el.querySelector(".tfoc__better"),
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
    render(SAMPLE, SAMPLE.work, SAMPLE.work[0], true);
  }

  window.ApexOverlay.registerWidget("trainingfocus", {
    // 20 a second: the light has a 3 s lead, so 50 ms (3.5 m at 250 km/h) is
    // far inside it, and the words change a few times a lap at most.
    throttleMs: 50,
    init: init,
    update: update,
  });
})();
