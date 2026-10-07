/**
 * traininginputs.js — Trace: your inputs over the reference's, by the metre.
 * -----------------------------------------------------------------------------
 * A strip of road, 250 m behind the car to 150 m ahead, with the car fixed on
 * a bright line across it. Throttle rises above a centre line and brake hangs
 * below it, so one lane reads both pedals and a trail-brake overlap shows as
 * the two touching. Steering runs in its own thin lane underneath.
 *
 * - BEHIND the car: your pedals as solid fills, the reference's as a violet
 *   outline over them. Where you had less throttle than it did — a lift it
 *   did not make, a slower pick-up — the shortfall is shaded amber. Where it
 *   was on the brake harder than you — you braked later, or let off sooner —
 *   the difference is shaded cyan. Your own brake reaching outside the
 *   outline is braking it did not do: earlier, or longer.
 * - AHEAD of the car: only the reference, as a faint preview, because you
 *   have not driven those metres yet. Its braking zones are red bands with a
 *   hard edge where it went for the pedal, and the nearest one carries the
 *   metres still to go on a tab, so the edge visibly closes on the car line.
 *
 * Why distance and not time: a time axis stretches every corner by how slowly
 * it is taken, so the same corner never sits in the same place twice and two
 * laps cannot be laid over each other. Metres can: the reference's brake
 * point is a place on the road, and on this axis it is a fixed mark.
 *
 * ## Painting
 * Ghost HUD's arrangement (`ghosthud.js`): `update` files the car's road
 * position as a timestamped sample in `ghost-pose.js`, a `requestAnimationFrame`
 * loop paints it interpolated 40 ms behind the newest, so the strip scrolls at
 * display rate rather than stepping at the feed rate. The loop stops when the
 * widget is hidden or the feed goes stale; the next frame wakes it.
 *
 * Distance is the server's filtered road position (`ghost.atD`) — the axis
 * the gap and the reference's own curve are on — unwrapped across the line
 * so the strip runs straight through it. Your inputs go into one-metre bins
 * and the reference is resampled onto the same grid once per lap
 * (`training-trace.js`), so painting is index arithmetic with nothing to
 * search and nothing to allocate.
 */
(function () {
  "use strict";

  var TR = window.ApexTrainingTrace;
  var POSE = window.ApexGhostPose;
  var LAPS = window.ApexTrainingLaps;
  var GHOST = window.ApexTrainingGhost;

  /* ------------------------------- framing -------------------------------- */

  /** Metres either side of the car. The car line sits at BEHIND/(BEHIND+AHEAD). */
  var BEHIND_M = 250;
  var AHEAD_M = 150;
  var SPAN_M = BEHIND_M + AHEAD_M;
  /** Canvas height as a fraction of its width. */
  var ASPECT = 0.32;

  /** A pedal difference smaller than this is noise, not a habit. */
  var DIFF_MIN = 0.08;
  /** Steering lock that fills the steering lane: most corners use a third. */
  var STEER_FULL = 0.35;
  /** Within this, the next braking edge lights the car line. */
  var BRAKE_NEAR_M = 40;

  /** See `ghost-pose.js`; the same values Ghost HUD paints with. */
  var POSE_DELAY_MS = 40;
  var POSE_MAX_EXTRAP_MS = 100;
  var POSE_HOLD_MS = 250;
  /** A backward step longer than this is a reset or a tow: the trail starts again. */
  var TRAIL_BACK_M = 50;
  var SIZE_CHECK_FRAMES = 30;

  /* -------------------------------- colour -------------------------------- */

  /** Theme tokens, read ONCE at init (a canvas cannot use `var(--…)`). */
  var C = {
    throttle: "#35d07f",
    brake: "#ff5470",
    warn: "#ffb020",
    cyan: "#22d3ee",
    purple: "#8b5cf6",
    text: "#f4f6fb",
    text2: "#aeb6c8",
    muted: "#6b7387",
    fontDisplay: '"Bahnschrift", "Arial Narrow", "Segoe UI Semibold", sans-serif',
  };
  /** The reference is violet everywhere in training: the ghost's colour. */
  var C_REF = "#b9a6ff";
  var C_INK = "rgba(4,6,12,0.72)";
  var C_RULE = "rgba(174,182,200,0.22)";
  var C_AHEAD = "rgba(255,255,255,0.035)";

  /** Derived from the tokens once, in `readTokens`. */
  var fillThr = "";
  var fillBrk = "";
  var fillThrAhead = "";
  var fillBrkAhead = "";
  var fillLift = "";
  var fillLate = "";
  var zoneAhead = "";
  var zoneBehind = "";
  var boardBehind = "";
  var tagAhead = "";
  var tagBehind = "";

  /* -------------------------------- state --------------------------------- */

  var canvas = null;
  var gctx = null;
  var headerMeta = null;
  var cssW = 0;
  var cssH = 0;
  var dpr = 1;
  var boxW = -1;
  var sizeTick = 0;
  var noteWork = null;
  var paintVer = 0;

  /** The reference, prepared once per lap: grid, braking zones, corner tags. */
  var line = null;
  var lapM = 0;
  var grid = null;
  var zones = null;
  var apexM = null;
  var apexName = null;
  var lastLabel = "";

  var ghostState = null;
  var unwrapper = TR ? TR.createUnwrap() : null;
  var trail = TR ? TR.createTrail(512) : null;
  var lastUm = NaN;

  var poseBuf = POSE ? POSE.create({ delayMs: POSE_DELAY_MS, maxExtrapMs: POSE_MAX_EXTRAP_MS, holdMs: POSE_HOLD_MS }) : null;
  var pose = { x: 0, z: 0, h: 0, gapM: 0, ageMs: 0 };

  var rafId = 0;
  var shownNote = null;
  var shownNoteVer = -1;
  /**
   * What the last full paint drew from: the car's metre, the newest inputs
   * written to the trail, and `paintVer`. The same again (a parked car) is
   * not repainted. `ver: -1` = a note is showing.
   */
  var drawn = { ver: -1, m: NaN, thr: NaN, brk: NaN, str: NaN };

  /* ---------------------- per-paint scratch (no garbage) ------------------- */

  var N = SPAN_M + 2;
  var px = new Float32Array(N);
  var rThr = new Float32Array(N);
  var rBrk = new Float32Array(N);
  var rStr = new Float32Array(N);
  var rOk = new Uint8Array(N);
  var mThr = new Float32Array(N);
  var mBrk = new Float32Array(N);
  var mStr = new Float32Array(N);
  var mOk = new Uint8Array(N);

  /** Lane geometry, set by `sizeCanvas`. */
  var tagH = 0;
  var yTop = 0;
  var yBase = 0;
  var yBot = 0;
  var sMid = 0;
  var sAmp = 0;
  var xNow = 0;
  var pxPerM = 1;
  var fontTag = "";
  var fontCue = "";
  var fontNote = "";

  /** The countdown tab's text, rebuilt only when the whole metres change. */
  var cueM = -1;
  var cueText = "";
  var cueW = 0;
  var cueVer = -1;

  var gFade = null;

  /* -------------------------------- tokens -------------------------------- */

  function readTokens() {
    try {
      var cs = getComputedStyle(document.documentElement);
      var pick = function (name, fallback) {
        var v = cs.getPropertyValue(name).trim();
        return v || fallback;
      };
      C.throttle = pick("--pedal-throttle", C.throttle);
      C.brake = pick("--pedal-brake", C.brake);
      C.warn = pick("--warn", C.warn);
      C.cyan = pick("--ac-cyan", C.cyan);
      C.purple = pick("--ac-purple", C.purple);
      C.text = pick("--text-primary", C.text);
      C.text2 = pick("--text-secondary", C.text2);
      C.muted = pick("--text-muted", C.muted);
      C.fontDisplay = pick("--font-display", C.fontDisplay);
    } catch (e) {
      /* no computed style here; the fallbacks stand */
    }
    fillThr = withAlpha(C.throttle, 0.82, "#35d07f");
    fillBrk = withAlpha(C.brake, 0.86, "#ff5470");
    fillThrAhead = withAlpha(C.throttle, 0.16, "#35d07f");
    fillBrkAhead = withAlpha(C.brake, 0.22, "#ff5470");
    fillLift = withAlpha(C.warn, 0.62, "#ffb020");
    fillLate = withAlpha(C.cyan, 0.55, "#22d3ee");
    zoneAhead = withAlpha(C.brake, 0.2, "#ff5470");
    zoneBehind = withAlpha(C.brake, 0.08, "#ff5470");
    boardBehind = withAlpha(C.brake, 0.35, "#ff5470");
    tagAhead = C.text2;
    tagBehind = withAlpha(C.muted, 0.8, "#6b7387");
  }

  /** A `#rgb`/`#rrggbb` token at an alpha; any other form uses `fallbackHex`. */
  function withAlpha(colour, a, fallbackHex) {
    var h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(colour) ? colour.slice(1) : fallbackHex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  /* --------------------------------- line --------------------------------- */

  /** The expensive half, once per lap selection: ~4 k metres resampled. */
  function setLine(data) {
    line = data;
    lapM = data && data.trackLengthM > 0 ? data.trackLengthM : 0;
    grid = data && lapM ? TR.resampleRef(data, lapM) : null;
    zones = grid ? TR.brakeZones(grid, data, lapM) : null;
    apexM = null;
    apexName = null;
    if (grid && Array.isArray(data.corners)) {
      var am = [];
      var an = [];
      for (var i = 0; i < data.corners.length; i++) {
        var c = data.corners[i];
        if (!c || !isFinite(c.apexD)) continue;
        am.push(c.apexD * lapM);
        an.push(LAPS.cornerName(i));
      }
      apexM = Float64Array.from(am);
      apexName = an;
    }
    paintVer++;
    wake();
  }

  /* -------------------------------- sizing -------------------------------- */

  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth;
    if (!w) return;
    var h = Math.round(w * ASPECT);
    var d = window.ApexRaster.backingScale(canvas);
    var bw = Math.round(w * d);
    var bh = Math.round(h * d);
    if (bw === canvas.width && bh === canvas.height && w === cssW) return;
    cssW = w;
    cssH = h;
    dpr = d;
    canvas.style.height = cssH + "px";
    var extra = canvas.offsetHeight - canvas.clientHeight;
    if (extra > 0) canvas.style.height = cssH + extra + "px";
    canvas.width = bw;
    canvas.height = bh;

    tagH = Math.max(14, Math.round(cssH * 0.12));
    yTop = tagH + 3;
    yBot = Math.round(cssH * 0.76);
    yBase = Math.round(yTop + (yBot - yTop) * 0.56);
    var sTop = yBot + 7;
    var sBot = cssH - 4;
    sMid = (sTop + sBot) / 2;
    sAmp = (sBot - sTop) / 2;
    pxPerM = cssW / SPAN_M;
    xNow = BEHIND_M * pxPerM;
    var tagPx = Math.max(9, Math.round(tagH * 0.68));
    fontTag = "600 " + tagPx + "px " + C.fontDisplay;
    fontCue = "700 " + Math.max(10, Math.round(tagH * 0.74)) + "px " + C.fontDisplay;
    fontNote = "600 " + Math.max(11, Math.round(cssW * 0.022)) + "px " + C.fontDisplay;

    // The fade at the far end of the preview: one gradient per size, never per paint.
    gFade = gctx.createLinearGradient(cssW * 0.86, 0, cssW, 0);
    gFade.addColorStop(0, "rgba(0,0,0,0)");
    gFade.addColorStop(1, "rgba(0,0,0,1)");
    paintVer++;
    wake();
  }

  function watchSize(el) {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function (entries) {
        var r = entries[entries.length - 1].contentRect;
        boxW = r ? r.width : -1;
        sizeCanvas();
        wake();
      }).observe(el);
    }
    window.addEventListener("resize", sizeCanvas, { passive: true });
    document.addEventListener("visibilitychange", wake);
  }

  /**
   * Whether the training window is on screen, as main last said over the
   * bridge — Ghost HUD's rule and for its reason: a hidden window's document
   * still reads as visible with background throttling off. True with no
   * bridge (OBS).
   */
  var layerShown = true;

  function watchLayer() {
    var bridge = window.apexIngame;
    if (!bridge || typeof bridge.onTrainingShown !== "function") return;
    bridge.onTrainingShown(function (on) {
      layerShown = on;
      if (on) wake();
    });
  }

  /** Hidden widget, hidden window, minimised layer, or an OBS source auto-hidden off-track. */
  function shown() {
    if (!layerShown || document.hidden || boxW === 0) return false;
    return document.documentElement.getAttribute("data-autohidden") !== "true";
  }

  /* ------------------------------- sampling ------------------------------- */

  /**
   * Fill the per-paint columns for the window starting at metre `m0`: the
   * reference across the whole window, yours up to the car.
   *
   * @returns {number} How many metre columns there are.
   */
  function sample(m0, nowM) {
    var first = Math.ceil(m0);
    var cnt = 0;
    for (var m = first; m <= m0 + SPAN_M && cnt < N; m++, cnt++) {
      px[cnt] = (m - m0) * pxPerM;
      var gi = TR.lapIndex(m, grid.n);
      rOk[cnt] = grid.ok[gi];
      rThr[cnt] = grid.thr[gi];
      rBrk[cnt] = grid.brk[gi];
      rStr[cnt] = grid.str[gi];
      var s = m <= nowM ? TR.trailSlot(trail, m) : -1;
      mOk[cnt] = s >= 0 ? 1 : 0;
      if (s >= 0) {
        mThr[cnt] = trail.thr[s];
        mBrk[cnt] = trail.brk[s];
        mStr[cnt] = trail.str[s];
      }
    }
    return cnt;
  }

  /* ------------------------------- painting ------------------------------- */

  function yThr(v) {
    return yBase - (v < 0 ? 0 : v > 1 ? 1 : v) * (yBase - yTop);
  }
  function yBrk(v) {
    return yBase + (v < 0 ? 0 : v > 1 ? 1 : v) * (yBot - yBase);
  }
  function ySteer(v) {
    var f = v / STEER_FULL;
    if (f > 1) f = 1;
    else if (f < -1) f = -1;
    // Right lock up, as the pedals trace draws it.
    return sMid - f * sAmp;
  }

  /**
   * One filled area per run of valid columns, from the baseline out to the
   * channel. `up` = throttle (above the line), else brake (below).
   */
  function area(vals, ok, from, to, up) {
    gctx.beginPath();
    var open = -1;
    for (var k = from; k <= to + 1; k++) {
      var good = k <= to && ok[k] === 1;
      if (good && open < 0) {
        open = k;
        gctx.moveTo(px[k], yBase);
      }
      if (good) gctx.lineTo(px[k], up ? yThr(vals[k]) : yBrk(vals[k]));
      if (!good && open >= 0) {
        gctx.lineTo(px[k - 1], yBase);
        gctx.closePath();
        open = -1;
      }
    }
    gctx.fill();
  }

  /** A polyline through valid columns, broken where they are not. */
  function curve(vals, ok, from, to, kind) {
    gctx.beginPath();
    var on = false;
    for (var k = from; k <= to; k++) {
      if (ok[k] !== 1) {
        on = false;
        continue;
      }
      var y = kind === 0 ? yThr(vals[k]) : kind === 1 ? yBrk(vals[k]) : ySteer(vals[k]);
      if (!on) gctx.moveTo(px[k], y);
      else gctx.lineTo(px[k], y);
      on = true;
    }
    gctx.stroke();
  }

  /**
   * The gap shading behind the car, one rect subpath per column and one fill
   * per kind: amber where your throttle was short of the reference's, cyan
   * where its brake was harder than yours (later onto it, or off it sooner).
   */
  function deficits(to) {
    var w = pxPerM + 0.6; // overlap a hair so columns do not show seams
    gctx.beginPath();
    for (var k = 0; k <= to; k++) {
      if (!rOk[k] || !mOk[k]) continue;
      var d = rThr[k] - mThr[k];
      if (d > DIFF_MIN) {
        var y0 = yThr(rThr[k]);
        gctx.rect(px[k] - w / 2, y0, w, yThr(mThr[k]) - y0);
      }
    }
    gctx.fillStyle = fillLift;
    gctx.fill();
    gctx.beginPath();
    for (var j = 0; j <= to; j++) {
      if (!rOk[j] || !mOk[j]) continue;
      var e = rBrk[j] - mBrk[j];
      if (e > DIFF_MIN) {
        var y1 = yBrk(mBrk[j]);
        gctx.rect(px[j] - w / 2, y1, w, yBrk(rBrk[j]) - y1);
      }
    }
    gctx.fillStyle = fillLate;
    gctx.fill();
  }

  /**
   * The reference's braking zones in the window: a band on the brake side
   * from where it pressed to where it let go, and a hard edge where it
   * pressed. Behind the car they are kept faint — context, not instruction.
   *
   * @returns {number} Metres to the next braking edge ahead, or Infinity.
   */
  function drawZones(m0, nowM) {
    var next = Infinity;
    if (!zones || !zones.on.length) return next;
    var base = Math.floor(m0 / lapM) * lapM;
    for (var lap = 0; lap < 2; lap++) {
      var off0 = base + lap * lapM;
      for (var i = 0; i < zones.on.length; i++) {
        var on = off0 + zones.on[i];
        var off = off0 + zones.off[i];
        if (off < m0 || on > m0 + SPAN_M) continue;
        var ahead = on > nowM;
        if (ahead && on - nowM < next) next = on - nowM;
        var x0 = Math.max(0, (on - m0) * pxPerM);
        var x1 = Math.min(cssW, (off - m0) * pxPerM);
        gctx.fillStyle = ahead ? zoneAhead : zoneBehind;
        gctx.fillRect(x0, yBase, x1 - x0, yBot - yBase);
        if (on >= m0) {
          var xe = (on - m0) * pxPerM;
          gctx.fillStyle = ahead ? C.brake : boardBehind;
          gctx.fillRect(xe - 1, yTop, 2, yBot - yTop);
        }
      }
    }
    return next;
  }

  /** Corner names at each apex in the window, along the top. */
  function drawTags(m0, nowM) {
    if (!apexM || !apexM.length) return;
    gctx.font = fontTag;
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    var base = Math.floor(m0 / lapM) * lapM;
    for (var lap = 0; lap < 2; lap++) {
      for (var i = 0; i < apexM.length; i++) {
        var m = base + lap * lapM + apexM[i];
        if (m < m0 + 8 || m > m0 + SPAN_M - 8) continue;
        var x = (m - m0) * pxPerM;
        gctx.fillStyle = m > nowM ? tagAhead : tagBehind;
        gctx.fillText(apexName[i], x, tagH / 2 + 1);
        gctx.fillRect(x - 0.5, tagH - 2, 1, 3);
      }
    }
  }

  /**
   * The car line, and the countdown to the reference's next braking edge on
   * a tab above it. The line burns red once that edge is close.
   */
  function drawNow(nextBrake) {
    var near = nextBrake <= BRAKE_NEAR_M;
    gctx.fillStyle = C_INK;
    gctx.fillRect(xNow - 2.5, yTop - 2, 5, cssH - yTop + 2);
    gctx.fillStyle = near ? C.brake : C.cyan;
    gctx.fillRect(xNow - 1, yTop - 2, 2, cssH - yTop + 2);
    // A notch at the top, so the line reads as "you" and not a grid line.
    gctx.beginPath();
    gctx.moveTo(xNow - 5, yTop - 6);
    gctx.lineTo(xNow + 5, yTop - 6);
    gctx.lineTo(xNow, yTop);
    gctx.closePath();
    gctx.fill();

    if (!(nextBrake <= AHEAD_M)) return;
    var m = Math.round(nextBrake);
    if (m !== cueM || cueVer !== paintVer) {
      cueM = m;
      cueVer = paintVer;
      cueText = m + " m";
      gctx.font = fontCue;
      cueW = gctx.measureText(cueText).width + 10;
    }
    var xe = xNow + nextBrake * pxPerM;
    var x = Math.min(cssW - cueW - 2, Math.max(xNow + 8, xe - cueW / 2));
    var h = tagH - 1;
    gctx.fillStyle = C_INK;
    gctx.fillRect(x - 1, 0, cueW + 2, h + 1);
    gctx.fillStyle = C.brake;
    gctx.fillRect(x, 0, cueW, h);
    gctx.font = fontCue;
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    gctx.fillStyle = "#fff";
    gctx.fillText(cueText, x + cueW / 2, h / 2 + 1);
  }

  /** The far end of the preview fades out rather than stopping at a hard cut. */
  function fadeEdge() {
    gctx.globalCompositeOperation = "destination-out";
    gctx.fillStyle = gFade;
    gctx.fillRect(cssW * 0.86, 0, cssW * 0.14 + 1, cssH);
    gctx.globalCompositeOperation = "source-over";
  }

  var NOTE_NO_GHOST = "NO GHOST LAP";
  var NOTE_NO_INPUTS = "THIS LAP HAS NO RECORDED INPUTS";
  var NOTE_WAITING = "WAITING FOR CAR POSITION";

  function paintNote(note) {
    drawn.ver = -1;
    if (note === shownNote && shownNoteVer === paintVer) return false;
    shownNote = note;
    shownNoteVer = paintVer;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);
    gctx.font = fontNote;
    gctx.textAlign = "center";
    gctx.textBaseline = "middle";
    gctx.fillStyle = C.muted;
    gctx.fillText(note, cssW / 2, cssH / 2);
    return false;
  }

  /** One display frame. True while there is motion to keep painting. */
  function paint(nowMs) {
    if (!ghostState) return paintNote(NOTE_NO_GHOST);
    if (!line) return paintNote(NOTE_NO_GHOST);
    if (!grid) return paintNote(NOTE_NO_INPUTS);
    var st = POSE.sample(poseBuf, nowMs, pose);
    if (st === POSE.NONE || st === POSE.STALE) return paintNote(NOTE_WAITING);
    // Parked: the same metre and the same pedals under the car line draw the
    // same strip. Stop the loop instead of repainting it; a frame wakes it.
    if (
      drawn.ver === paintVer &&
      pose.x === drawn.m &&
      trail.lastThr === drawn.thr &&
      trail.lastBrk === drawn.brk &&
      trail.lastStr === drawn.str
    ) {
      return false;
    }
    shownNote = null;

    var nowM = pose.x;
    var m0 = nowM - BEHIND_M;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);

    var cnt = sample(m0, nowM);
    var last = cnt - 1;
    // The last column at or behind the car.
    var kNow = Math.min(last, Math.max(0, Math.floor(nowM) - Math.ceil(m0)));

    // The preview half sits on a faintly lighter ground: the eye splits
    // "done" from "coming" before it reads anything.
    gctx.fillStyle = C_AHEAD;
    gctx.fillRect(xNow, yTop, cssW - xNow, cssH - yTop);

    var nextBrake = drawZones(m0, nowM);

    // The reference ahead, faint: what is coming.
    gctx.fillStyle = fillThrAhead;
    area(rThr, rOk, kNow, last, true);
    gctx.fillStyle = fillBrkAhead;
    area(rBrk, rOk, kNow, last, false);

    // Yours behind, solid: what you did.
    gctx.fillStyle = fillThr;
    area(mThr, mOk, 0, kNow, true);
    gctx.fillStyle = fillBrk;
    area(mBrk, mOk, 0, kNow, false);
    deficits(kNow);

    // The reference's outline over the lot, on a dark keyline so it holds
    // over a bright sky and a dark tunnel alike.
    gctx.lineJoin = "round";
    gctx.lineWidth = 3;
    gctx.strokeStyle = C_INK;
    curve(rThr, rOk, 0, last, 0);
    curve(rBrk, rOk, 0, last, 1);
    gctx.lineWidth = 1.5;
    gctx.strokeStyle = C_REF;
    curve(rThr, rOk, 0, last, 0);
    curve(rBrk, rOk, 0, last, 1);

    // Rules: the pedal baseline and the steering centre.
    gctx.fillStyle = C_RULE;
    gctx.fillRect(0, yBase - 0.5, cssW, 1);
    gctx.fillRect(0, sMid - 0.5, cssW, 1);

    // Steering: the reference's across the window, yours behind the car.
    gctx.lineWidth = 1.5;
    gctx.strokeStyle = C_REF;
    curve(rStr, rOk, 0, last, 2);
    gctx.lineWidth = 2;
    gctx.strokeStyle = C.text;
    curve(mStr, mOk, 0, kNow, 2);

    drawTags(m0, nowM);
    fadeEdge();
    drawNow(nextBrake);

    drawn.ver = paintVer;
    drawn.m = nowM;
    drawn.thr = trail.lastThr;
    drawn.brk = trail.lastBrk;
    drawn.str = trail.lastStr;
    return true;
  }

  /* --------------------------------- loop --------------------------------- */

  var raf =
    typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : function (fn) {
          return window.setTimeout(fn, 16);
        };

  function wake() {
    if (!rafId && gctx) rafId = raf(tick);
  }

  function tick() {
    rafId = 0;
    if (!cssW || !cssH || !shown()) return;
    // performance.now(), the clock the samples are stamped on in `update`.
    var t0 = performance.now();
    var moving = false;
    try {
      moving = paint(t0);
    } catch (err) {
      console.error("[Apex] widget 'traininginputs' paint failed:", err);
    }
    if (noteWork) noteWork("traininginputs", performance.now() - t0);
    if (moving) wake();
  }

  /* -------------------------------- update -------------------------------- */

  /** Data intake only: file the road position and inputs, keep the line current. */
  function update(frame) {
    if (!gctx || !TR || !POSE || !LAPS || !GHOST) return;
    if (++sizeTick % SIZE_CHECK_FRAMES === 0) sizeCanvas();
    var player = frame && frame.player;
    var ghost = player ? player.ghost : null;
    GHOST.sync(ghost);
    ghostState = ghost || null;

    if (headerMeta) {
      var label = ghost && ghost.sourceLabel ? ghost.sourceLabel : "—";
      if (label !== lastLabel) {
        headerMeta.textContent = label;
        lastLabel = label;
      }
    }

    var d = ghost && typeof ghost.atD === "number" ? ghost.atD : NaN;
    if (lapM > 0 && isFinite(d)) {
      var um = TR.unwrap(unwrapper, d) * lapM;
      if (isFinite(lastUm) && um < lastUm - TRAIL_BACK_M) TR.resetTrail(trail);
      lastUm = um;
      var p = player.pedals;
      if (p) TR.writeTrail(trail, um, +p.throttle || 0, +p.brake || 0, +p.steer || 0);
      var t = POSE.stamp(poseBuf, frame.timestamp, performance.now());
      POSE.push(poseBuf, t, um, 0, 0, 0);
    }
    wake();
  }

  /* --------------------------------- init --------------------------------- */

  function init(root) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "ttrace";
    canvas = document.createElement("canvas");
    canvas.className = "ttrace__canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "Your throttle (up) and brake (down) over the last 250 metres, the reference lap's in violet outline; " +
        "amber where you had less throttle, cyan where it braked harder than you. Ahead of the car line, " +
        "the reference only, its braking zones in red with the metres to the next one. Steering underneath.",
    );
    wrap.appendChild(canvas);
    mount.appendChild(wrap);
    gctx = canvas.getContext("2d");
    if (!TR || !POSE || !LAPS || !GHOST) {
      console.error("[Apex] Trace needs training-trace.js, training-laps.js, training-ghost.js and ghost-pose.js loaded first");
      return;
    }
    var api = window.ApexOverlay;
    noteWork = api && typeof api.noteWidgetWork === "function" ? api.noteWidgetWork : null;
    readTokens();
    sizeCanvas();
    watchSize(canvas);
    watchLayer();
    GHOST.subscribe(setLine);
  }

  window.ApexOverlay.registerWidget("traininginputs", {
    // Every frame: `update` only files a sample, and the interpolation needs
    // every one of them — see Ghost HUD, which is in the same position.
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
