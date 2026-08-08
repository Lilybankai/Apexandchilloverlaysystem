/**
 * widgets/speedo.js — the driver's cluster: speed, revs, gear and the numbers
 * you change your driving for.
 * -----------------------------------------------------------------------------
 * One panel carrying everything a driver reads on a straight, arranged so the
 * eye lands on the biggest thing first and never has to hunt:
 *
 *   • TWIN REV BARS that start at the bottom outer corners, climb the outer
 *     edges, cross the tops of the wells and dive down onto the centre plateau,
 *     meeting head-on above the speed readout. They flash white together at the
 *     limiter. The convergence IS the shift cue: two things arriving at one
 *     point is legible in peripheral vision in a way a bar filling up is not;
 *   • the BACKGROUND ILLUMINATION — the cluster lights from the floor upward as
 *     the revs rise, in the same colour the bars are showing, so the shift point
 *     is readable with the eyes still on the braking zone. This is the widget's
 *     whole reason for existing: a number you have to look at is no use at
 *     300 km/h, and a panel that turns red underneath you is;
 *   • SPEED and GEAR in the middle, the two Tier-1 readouts;
 *   • two WELLS carrying the four budgets — FUEL and VIRTUAL ENERGY on the left,
 *     PROJECTED LAP and the HYBRID BATTERY on the right, two of distance and two
 *     of pace, each with the "≈ n LAPS" line that turns a status into a decision;
 *   • a chip strip in the chin: pit limiter, regen, and the TC map with its two
 *     sub-settings (power cut and slip) plus ABS.
 *
 * ## The radar and the track map are NOT in here
 * They were, for one release, nested as real widget sections inside the wells.
 * It worked, but it cost more than it bought: both modules keep module-level
 * state and `client.js` binds one root per widget, so the nested copies had to be
 * the ONLY ones on the page — you could have the cluster or a standalone radar,
 * never both. Making both possible meant a multi-instance refactor of two large,
 * carefully-tuned widgets whose failure mode is silent. The cluster is a driving
 * instrument; the radar and the map are situational-awareness panels an operator
 * places where they want them. They are standalone widgets, and this widget does
 * not reason about them at all.
 *
 * ## Why it draws to a canvas
 * The illumination and both rev bars change every single frame, and doing that in
 * CSS means writing a custom property that a `background-image` resolves
 * through — a style recalc plus a repaint of a full-panel element, thirty times
 * a second, for the life of the stream. On a canvas it is a handful of fills into
 * a bitmap the size of the panel, which is the same bargain `radar`, `motion` and
 * `trackmap` already take. The readouts stay in the DOM on top, where they get
 * the house change-glow and cost nothing on the frames they don't move.
 *
 * ## What a frame actually costs
 * Two blits, one gradient, and the lit part of two bars. Everything that does not
 * change with the revs — the hood shadow, the bezel, the wells, the unlit tracks
 * and 54 tick marks — is baked into two offscreen layers keyed on the canvas
 * size ({@link buildStatic}), the way `trackmap.js` bakes its ribbon. The bars
 * carry NO `shadowBlur`: the first version set a shadow per band run, so the
 * per-frame cost rose with the revs and the widget stuttered hardest at the exact
 * moment it exists to be read — and starved every other widget on the page while
 * doing it. See {@link drawBand}.
 *
 * ## Why it runs at the full broadcast rate (throttleMs 0)
 * A rev counter is a rate instrument: at the 250 ms every other widget uses, the
 * bars advance in eight visible steps between upshifts and the shift light lands
 * a quarter of a second late, which on this widget is not a cosmetic problem —
 * it is the widget being wrong about the only moment it exists for.
 *
 * ## The design box, and why the geometry is fixed-aspect
 * The silhouette is authored once in a {@link DW}×{@link DH} box and scaled to
 * fit. It has a real aspect ratio: stretching the axes independently would turn
 * the corner arcs into ellipses and break the 45° chamfers the bars follow. So
 * the stage carries `aspect-ratio` in CSS, the canvas fills it exactly, and the
 * DOM readouts are positioned FROM THE SAME CONSTANTS as the drawing (see
 * {@link placeBoxes}) rather than from percentages copied into the stylesheet —
 * which is the version of this that drifts.
 *
 * For the same reason the readouts scale with the WIDGET (`--sp-scale`, written
 * on resize) and not with the operator's Text size slider. On a panel whose
 * boxes are fixed by a drawn silhouette, a text slider can only overflow them;
 * the way to make this cluster bigger is to make the cluster bigger.
 *
 * ## What it does NOT invent
 * Three readouts are optional on the wire and are **hidden entirely** rather
 * than shown empty when their block is absent: virtual energy (cars and series
 * that don't run an energy budget), the battery (see `HybridState` — a GT3 has
 * no hybrid, and an absent block is not a flat one), and the limiter chip (a
 * feed with no shared memory cannot see the limiter, and a chip that
 * permanently reads OFF is a claim we can't make). The TC chips likewise come
 * from `frame.mfd`, which is LMU-only.
 *
 * Speed units are NOT this widget's business: `fmt.speedValue` /
 * `fmt.speedUnitLabel` do the conversion, so the cluster, both pedal panels and
 * the motion widget can never disagree about what 168 means. `?units=mph` on
 * the Browser Source URL, or the app's own setting, retunes all of them at once.
 *
 * Browser Source URL options:
 *   ?bg=on|off       the background illumination (default on)
 *   ?rev=on|off      the twin rev bars (default on)
 */
(function () {
  "use strict";

  /* ---------------------------------------------------------------------- */
  /*  The rev ramp — pure, and exposed for the headless test                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Where the colour stops sit on the rev range, as fractions of max RPM.
   *
   * These are the shift-light convention every real cluster uses, not free
   * choices: green while there is room, amber when the upshift is coming, red
   * when it is now, and a flashing band for "you are on the limiter and losing
   * time". The bands are fractions of the car's own `maxRpm`, so a Hypercar
   * revving to 9000 and a GT3 to 7200 light up at the same point in their own
   * range — which is what makes one widget work for both.
   */
  var BAND_AMBER = 0.8;
  var BAND_RED = 0.93;
  var BAND_SHIFT = 0.985;

  /* Ramp stops, matching the theme's own status tokens so this widget's green
   * and red mean what they mean everywhere else in the overlay. */
  var C_GREEN = [53, 208, 127]; /* --pos-gain  #35d07f */
  var C_AMBER = [255, 176, 32]; /* --warn      #ffb020 */
  var C_RED = [255, 84, 112]; /* --pos-loss  #ff5470 */

  /** Below this the ramp is flat green — a car off the throttle is not "cold". */
  var RAMP_GREEN_UNTIL = 0.55;

  /**
   * Revs as a fraction of the car's usable range, `0`..`1`.
   *
   * Returns 0 — not a guess — whenever either channel is missing or `maxRpm` is
   * implausible. An unknown rev limit divided into a real RPM would light the
   * panel red on a car that is idling.
   */
  function revFraction(rpm, maxRpm) {
    if (typeof rpm !== "number" || typeof maxRpm !== "number") return 0;
    if (!(rpm > 0) || !(maxRpm > 1000)) return 0;
    var f = rpm / maxRpm;
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  /** Which band a rev fraction is in: `low` | `amber` | `red` | `shift`. */
  function revStage(f) {
    if (f >= BAND_SHIFT) return "shift";
    if (f >= BAND_RED) return "red";
    if (f >= BAND_AMBER) return "amber";
    return "low";
  }

  function mix(a, b, t) {
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }

  /**
   * The illumination colour for a rev fraction: green → amber → red.
   *
   * Continuous rather than three flat buckets, because the brief is a panel that
   * *gradually* changes: a driver watching the colour drift toward amber has
   * more information than one waiting for it to snap.
   */
  function revRgb(f) {
    if (f <= RAMP_GREEN_UNTIL) return C_GREEN;
    if (f <= BAND_RED) {
      return mix(C_GREEN, C_AMBER, (f - RAMP_GREEN_UNTIL) / (BAND_RED - RAMP_GREEN_UNTIL));
    }
    return mix(C_AMBER, C_RED, (f - BAND_RED) / (1 - BAND_RED));
  }

  function rgba(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }

  /* ---------------------------------------------------------------------- */
  /*  The design box — the silhouette and the bars, in fixed coordinates     */
  /* ---------------------------------------------------------------------- */

  /** The authoring box. Everything below is in these units. */
  var DW = 1000;
  var DH = 470;

  /* --- the shell silhouette ---
   * A binocular outline: two pods with heavily rounded outer corners, a centre
   * that steps DOWN from the pod tops on a chamfer, and a chin that hangs BELOW
   * the pod floor to carry the chip strip. The transitions are chamfers rather
   * than curves; that is what stops the shape reading as a generic squircle. */
  var POD_BOT = 424; /* the pod floor                       */
  var CHIN_BOT = 470; /* the chin's floor                    */
  var NOTCH_TOP = 52; /* the top centre plateau              */
  var R_TOP = 74; /* outer top corner radius             */
  var R_BOT = 52; /* outer bottom corner radius          */
  var CH = 46; /* chamfer run                         */
  var NOTCH_L = 352, NOTCH_R = 648; /* top plateau span      */
  var CHIN_L = 278, CHIN_R = 722; /* chin span               */

  /* --- the rev bar centreline, left side (the right is its mirror) ---
   * Five runs: up the outer edge, round the corner, across the pod top, down
   * the chamfer onto the plateau, and inward to the meeting point. It is an
   * OFFSET OF THE SILHOUETTE, not a circular arc — that is what makes it read
   * as a light strip inside the bezel rather than a gauge floating on top. */
  var A_X = 40; /* inset of the vertical run from the edge  */
  var A_Y = 40; /* inset of the horizontal run from the top */
  var A_R = 92; /* corner radius of the bar centreline      */
  var A_Y0 = 404; /* where the bar starts, at the bottom      */
  var A_KNEE1 = 306; /* where the top run meets the chamfer      */
  var A_KNEE2 = 358; /* where the chamfer lands on the plateau   */
  var A_Y2 = 92; /* the plateau run's y                      */
  var A_X1 = 476; /* where the bar ends, at top centre        */

  var BAND_W = 13; /* thickness of the lit band                */
  var TRACK_W = 15; /* thickness of the unlit track             */
  var TICKS = 26; /* tick marks along each bar                */
  /**
   * Short runs the band is drawn in, so each carries its own colour.
   *
   * 24, not the 44 this started at. Every step is a separate `stroke()` because
   * every step is a different colour, so the count is a straight per-frame cost
   * paid twice over (both bars) — and past about 20 the difference between one
   * step and the next is under a shade on a 13 px band. See {@link drawBand}.
   */
  var BAND_STEPS = 24;

  /* --- the boxes the DOM sits in ---
   * Exported and applied by placeBox(), so the stylesheet never carries a
   * second copy of these numbers to drift from. */
  var POD_W = 286, POD_H = 312, POD_Y = 96, POD_INSET = 96;

  /** The wells the canvas draws. The budget panels sit inside them, by POD_PAD. */
  var WELLS = [
    { x: POD_INSET, y: POD_Y, w: POD_W, h: POD_H },
    { x: DW - POD_INSET - POD_W, y: POD_Y, w: POD_W, h: POD_H },
  ];
  var POD_PAD = 12;

  function inset(b, p) {
    return { x: b.x + p, y: b.y + p, w: b.w - 2 * p, h: b.h - 2 * p };
  }

  /**
   * The four budgets live in the two wells, at a size worth reading.
   *
   * They spent one release in a 66 px strip underneath, which fit a label and a
   * value and then clipped every "≈ n LAPS" — the half of a fuel or energy read
   * that actually changes a driver's plan, and the only part of it that is a
   * decision rather than a status. A well each gives all four a label, a value
   * and a sub-line with room to spare.
   */
  var BOXES = {
    core: { x: NOTCH_L + 30, y: 108, w: DW - 2 * (NOTCH_L + 30), h: 292 },
    budgetL: inset(WELLS[0], POD_PAD),
    budgetR: inset(WELLS[1], POD_PAD),
    chips: { x: CHIN_L + 8, y: 428, w: CHIN_R - CHIN_L - 16, h: 38 },
  };

  /**
   * Walks one rev bar into a dense polyline carrying cumulative length.
   *
   * Canvas 2D has no `getTotalLength()`, so progressive fill along a path that
   * is part line and part arc means precomputing the points and stroking up to
   * a length. Built once at load — it depends on nothing but the constants
   * above — and shared by every frame and both bars.
   *
   * @param {boolean} mirror  Mirror in x, for the right-hand bar.
   * @returns {Array<{x:number,y:number,len:number}>}
   */
  function buildBar(mirror) {
    var pts = [];
    var i, t, n;

    function push(x, y) {
      if (mirror) x = DW - x;
      var prev = pts[pts.length - 1];
      var d = prev ? Math.sqrt((x - prev.x) * (x - prev.x) + (y - prev.y) * (y - prev.y)) : 0;
      pts.push({ x: x, y: y, len: (prev ? prev.len : 0) + d });
    }

    /* 1. up the outer edge */
    n = 40;
    for (i = 0; i <= n; i++) {
      t = i / n;
      push(A_X, A_Y0 + (A_Y + A_R - A_Y0) * t);
    }
    /* 2. round the corner, 180° → 270° */
    n = 48;
    var cx = A_X + A_R, cy = A_Y + A_R;
    for (i = 1; i <= n; i++) {
      var a = Math.PI + (Math.PI / 2) * (i / n);
      push(cx + Math.cos(a) * A_R, cy + Math.sin(a) * A_R);
    }
    /* 3. across the top of the pod */
    n = 40;
    for (i = 1; i <= n; i++) {
      t = i / n;
      push(A_X + A_R + (A_KNEE1 - A_X - A_R) * t, A_Y);
    }
    /* 4. down the chamfer onto the centre plateau */
    n = 14;
    for (i = 1; i <= n; i++) {
      t = i / n;
      push(A_KNEE1 + (A_KNEE2 - A_KNEE1) * t, A_Y + (A_Y2 - A_Y) * t);
    }
    /* 5. inward along the plateau, to the meeting point */
    n = 34;
    for (i = 1; i <= n; i++) {
      t = i / n;
      push(A_KNEE2 + (A_X1 - A_KNEE2) * t, A_Y2);
    }
    return pts;
  }

  var BAR_L = buildBar(false);
  var BAR_R = buildBar(true);
  var BAR_LEN = BAR_L[BAR_L.length - 1].len;

  /**
   * The band's per-step colours, and where each step starts in the polyline.
   *
   * Both are pure functions of the constants above, so both are built once. The
   * colours because `revRgb` plus a string concatenation ran `BAND_STEPS × 2`
   * times a frame to produce the same 24 strings forever; the indices because
   * {@link strokeStep} would otherwise re-walk the whole 176-point array from
   * zero for every step, which is the same scan 24 times over per bar.
   */
  var BAND_RGBA = [];
  var BAND_WHITE = [];
  var BAND_IDX = [];
  (function () {
    var i, j;
    for (i = 0; i <= BAND_STEPS; i++) {
      var at = i / BAND_STEPS;
      BAND_RGBA.push(rgba(revRgb(at), 0.96));
      // Pre-resolved rather than branched in the loop: at the limiter every step
      // past the red band swaps to white on alternate frames, and that is the
      // one moment the draw must not get more expensive.
      BAND_WHITE.push(at >= BAND_RED ? "rgba(255,255,255,0.96)" : BAND_RGBA[i]);
      var target = BAR_LEN * at;
      for (j = 1; j < BAR_L.length; j++) {
        if (BAR_L[j].len >= target) break;
      }
      BAND_IDX.push(j - 1 < 0 ? 0 : j - 1);
    }
  })();

  /**
   * The point at a fraction along a bar, with the OUTWARD normal there.
   *
   * The normal is what the tick marks hang off. Outward is to the left of
   * travel on the left-hand bar; mirroring reverses the direction of travel, so
   * the handedness flips with it — which is the whole content of `s`. Getting
   * that sign wrong puts every tick on the inside of the bar, where they read as
   * debris over the pods instead of as a scale.
   */
  function barPointAt(pts, frac, mirror) {
    var target = BAR_LEN * frac;
    for (var i = 1; i < pts.length; i++) {
      if (pts[i].len >= target) {
        var p0 = pts[i - 1], p1 = pts[i];
        var t = (target - p0.len) / (p1.len - p0.len || 1);
        var dx = p1.x - p0.x, dy = p1.y - p0.y;
        var m = Math.sqrt(dx * dx + dy * dy) || 1;
        var s = mirror ? -1 : 1;
        return {
          x: p0.x + dx * t,
          y: p0.y + dy * t,
          nx: (dy / m) * s,
          ny: (-dx / m) * s,
        };
      }
    }
    var last = pts[pts.length - 1];
    return { x: last.x, y: last.y, nx: 0, ny: -1 };
  }

  /**
   * The pure half of the widget, exposed so the ramp and the geometry can be
   * exercised headlessly (`scripts/test-speedo.js`) rather than by squinting at
   * a running sim. Same bargain `ApexAudio` takes for the cue scheduler: the
   * part that has to be right about a threshold is reachable without a canvas.
   */
  window.ApexSpeedo = {
    BAND_AMBER: BAND_AMBER,
    BAND_RED: BAND_RED,
    BAND_SHIFT: BAND_SHIFT,
    revFraction: revFraction,
    revStage: revStage,
    revRgb: revRgb,
    /* the design box and its furniture, for the geometry tests */
    DESIGN: { w: DW, h: DH },
    BOXES: BOXES,
    buildBar: buildBar,
    barPointAt: barPointAt,
    barLength: function () {
      return BAR_LEN;
    },
  };

  /* ---------------------------------------------------------------------- */
  /*  Module state                                                           */
  /* ---------------------------------------------------------------------- */

  /** Shift-light flash period, ms. Fast enough to be urgent, slow enough to see. */
  var FLASH_MS = 110;

  var showBg = true;
  var showRev = true;

  var canvas, gctx, dpr = 1;
  var cssW = 0, cssH = 0;
  var stageEl = null;
  var sizeTick = 0;

  /**
   * The static artwork, baked once per size — the bezel below the illumination,
   * and the wells, unlit tracks and tick scales above it.
   *
   * TWO layers rather than one because the illumination goes BETWEEN them: it
   * lights the inside of the bezel, and the wells sit on top of it so the
   * budgets stay legible against a panel that has gone red. Everything in both
   * layers is a pure function of the canvas size, so a frame costs two blits
   * instead of a hood shadow, two silhouette fills, four track strokes and 54
   * tick marks.
   *
   * `staticKey` is the whole cache contract, following `trackmap.js`: a string
   * of every input that affects the bitmaps, not a boolean dirty flag.
   */
  var layerBelow = null, layerAbove = null, staticKey = "";
  /** Signature of the last frame actually drawn — see {@link draw}. */
  var lastFrameKey = "";

  var elSpeed, elUnit, elGear, elRpm;
  var elFuel, elFuelSub, elVeWrap, elVe, elVeSub;
  var elProj, elProjDelta, elBattWrap, elBattFill, elBattVal, elBattFlow;
  var elChips, chipLimiter, chipRegen, chipTc, chipCut, chipSlip, chipAbs;
  var cache = {};

  /** Live rev fraction + stage, written by update() and read by the draw. */
  var revF = 0;
  var revStageNow = "low";

  /* ---------------------------------------------------------------------- */
  /*  Canvas                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Matches the canvas bitmap to the element's CSS size, and republishes the
   * design-box scale as `--sp-scale` for the DOM readouts to size themselves by.
   *
   * Same contract as `motion.js`: idempotent, so a ResizeObserver watching the
   * element cannot feed itself. Writing a custom property here is not the thing
   * the header warns about — that is a per-FRAME write resolving through a
   * `background-image`. This is once per resize, and it is what keeps the text
   * locked to the silhouette it has to fit inside.
   */
  function sizeCanvas() {
    if (!canvas) return;
    var w = canvas.clientWidth || 0;
    var h = canvas.clientHeight || 0;
    if (!w || !h) return;
    var d = window.devicePixelRatio || 1;
    var bw = Math.round(w * d);
    var bh = Math.round(h * d);
    if (bw === canvas.width && bh === canvas.height) return;
    cssW = w;
    cssH = h;
    dpr = d;
    canvas.width = bw;
    canvas.height = bh;
    // Both caches are keyed on the size, so buildStatic() rebakes on the next
    // frame by itself. The frame signature is cleared explicitly because a
    // resize changes the bitmap without changing the revs, and the early return
    // in draw() would otherwise leave the old artwork on a resized canvas.
    lastFrameKey = "";
    if (stageEl) stageEl.style.setProperty("--sp-scale", String(w / DW));
  }

  function watchSize(el) {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(sizeCanvas).observe(el);
    }
    window.addEventListener("resize", sizeCanvas, { passive: true });
  }

  /* ---------------------------------------------------------------------- */
  /*  Drawing                                                                */
  /* ---------------------------------------------------------------------- */

  /** The shell silhouette, as a path on the context. */
  function shellPath(g) {
    g.beginPath();
    g.moveTo(R_TOP, 0);
    g.lineTo(NOTCH_L - CH, 0);
    g.lineTo(NOTCH_L, NOTCH_TOP);
    g.lineTo(NOTCH_R, NOTCH_TOP);
    g.lineTo(NOTCH_R + CH, 0);
    g.lineTo(DW - R_TOP, 0);
    g.arcTo(DW, 0, DW, R_TOP, R_TOP);
    g.lineTo(DW, POD_BOT - R_BOT);
    g.arcTo(DW, POD_BOT, DW - R_BOT, POD_BOT, R_BOT);
    g.lineTo(CHIN_R + CH, POD_BOT);
    g.lineTo(CHIN_R, CHIN_BOT);
    g.lineTo(CHIN_L, CHIN_BOT);
    g.lineTo(CHIN_L - CH, POD_BOT);
    g.lineTo(R_BOT, POD_BOT);
    g.arcTo(0, POD_BOT, 0, POD_BOT - R_BOT, R_BOT);
    g.lineTo(0, R_TOP);
    g.arcTo(0, 0, R_TOP, 0, R_TOP);
    g.closePath();
  }

  /** A rounded rectangle, as the pod wells are. */
  function wellPath(g, b, r) {
    g.beginPath();
    g.moveTo(b.x + r, b.y);
    g.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + r, r);
    g.arcTo(b.x + b.w, b.y + b.h, b.x + b.w - r, b.y + b.h, r);
    g.arcTo(b.x, b.y + b.h, b.x, b.y + b.h - r, r);
    g.arcTo(b.x, b.y, b.x + r, b.y, r);
    g.closePath();
  }

  function drawShell(g) {
    /* the hood: a soft dark halo that lifts the cluster off the game feed */
    g.save();
    g.shadowBlur = 46;
    g.shadowColor = "rgba(0,0,0,0.95)";
    g.fillStyle = "#0b1111";
    shellPath(g);
    g.fill();
    g.restore();

    /* the bezel edge — brightest along the top, where a real one catches light */
    g.save();
    var edge = g.createLinearGradient(0, 0, 0, DH);
    edge.addColorStop(0, "rgba(205,245,245,0.80)");
    edge.addColorStop(0.4, "rgba(130,185,185,0.30)");
    edge.addColorStop(1, "rgba(100,155,155,0.16)");
    g.strokeStyle = edge;
    g.lineWidth = 2;
    shellPath(g);
    g.stroke();
    g.restore();
  }

  /**
   * The illumination: a wash rising from the floor of the cluster to a height
   * set by the revs, fading out at its top edge, clipped to the silhouette.
   *
   * `screen`, not normal compositing. Alpha-blending a colour over the near-black
   * shell pulls it toward the surface: the red wash at the top of the rev range
   * came out BROWN, which is the one colour a shift cue must not be. Screen adds
   * light instead, so the hue keeps its saturation and the cluster reads as
   * illuminated rather than tinted — which is the whole point of the effect.
   * It used to be a CSS `mix-blend-mode` on the canvas element, which worked only
   * while the canvas held nothing but the wash; now that the shell is drawn into
   * the same bitmap, screening the element would erase the shell's own dark fill
   * (screen against black is a no-op), so the blend moved inside the canvas where
   * it composites against the shell instead of against the page.
   *
   * Drawn as one gradient-filled rect rather than a full-panel fill with moving
   * colour stops, so at low revs the work is proportionally small — an idling
   * car costs a sliver at the bottom of the bitmap, not a full-panel composite.
   */
  function drawGlow(g, rgb, flashing) {
    if (revF <= 0.001) return;
    g.save();
    shellPath(g);
    g.clip();
    g.globalCompositeOperation = "screen";
    var top = DH * (1 - revF);
    var grad = g.createLinearGradient(0, DH, 0, top);
    // Peak opacity climbs with the revs too, so the cluster gets both taller and
    // brighter — the two cues reinforce rather than competing.
    var peak = 0.2 + 0.55 * revF;
    if (flashing) peak = 0.95;
    grad.addColorStop(0, rgba(rgb, peak));
    grad.addColorStop(0.45, rgba(rgb, peak * 0.42));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, top, DW, DH - top);
    g.restore();
  }

  /**
   * The wells the budget panels sit in, drawn ABOVE the illumination.
   *
   * Deliberate: the wash is mood lighting for the bezel, but the wells hold four
   * numbers a driver reads under load, and a rising green-to-red gradient behind
   * "≈ 2.1 LAPS" is exactly the wrong place to spend contrast. The cluster lights
   * up around them.
   */
  function drawWells(g) {
    g.save();
    for (var i = 0; i < WELLS.length; i++) {
      wellPath(g, WELLS[i], 16);
      // Nearly opaque, not a tint: at 0.34 the illumination flooded straight
      // through and the readouts went green with the panel.
      g.fillStyle = "rgba(0,0,0,0.86)";
      g.fill();
      g.strokeStyle = "rgba(140,200,200,0.13)";
      g.lineWidth = 1;
      g.stroke();
    }
    g.restore();
  }

  /**
   * Strokes a bar's polyline between two fractions, starting the walk at a known
   * index rather than from zero.
   *
   * The index is the whole point: the band is drawn as `BAND_STEPS` consecutive
   * runs, and scanning the full 176-point array to find the start of each one
   * meant re-walking the same array 24 times per bar per frame. {@link BAND_IDX}
   * has those starts precomputed, so each run touches only its own points.
   */
  function strokeBetween(g, pts, f0, f1, fromIdx) {
    var t0 = BAR_LEN * f0, t1 = BAR_LEN * f1;
    if (t1 <= t0) return;
    g.beginPath();
    var started = false;
    for (var i = fromIdx > 0 ? fromIdx : 1; i < pts.length; i++) {
      var p0 = pts[i - 1], p1 = pts[i];
      if (p1.len < t0) continue;
      if (!started) {
        var ta = (t0 - p0.len) / (p1.len - p0.len || 1);
        g.moveTo(p0.x + (p1.x - p0.x) * ta, p0.y + (p1.y - p0.y) * ta);
        started = true;
      }
      if (p1.len >= t1) {
        // Interpolate the final partial segment so the leading edge lands
        // exactly on the value rather than snapping to the nearest sample.
        var tb = (t1 - p0.len) / (p1.len - p0.len || 1);
        g.lineTo(p0.x + (p1.x - p0.x) * tb, p0.y + (p1.y - p0.y) * tb);
        break;
      }
      g.lineTo(p1.x, p1.y);
    }
    g.stroke();
  }

  /**
   * The STATIC half of one rev bar: the unlit track with its red limit zone, and
   * the tick scale. Both depend only on the geometry, so both are baked.
   */
  function drawBarTrack(g, pts, mirror) {
    var i, p;

    /* The limit zone is a red SECTION of the scale rather than a separate mark,
       so the driver can see where the shift point is BEFORE reaching it — a mark
       that only appears once you are on it arrives too late to use. */
    g.save();
    g.lineWidth = TRACK_W;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "rgba(255,255,255,0.055)";
    strokeBetween(g, pts, 0, BAND_RED, 0);
    g.strokeStyle = "rgba(255,84,112,0.17)";
    strokeBetween(g, pts, BAND_RED, 1, 0);
    g.restore();

    g.save();
    g.lineWidth = 2;
    for (i = 0; i <= TICKS; i++) {
      p = barPointAt(pts, i / TICKS, mirror);
      var major = i % 5 === 0;
      var lenTick = major ? 9 : 5;
      var off = TRACK_W / 2 + 4;
      g.strokeStyle = "rgba(255,255,255," + (major ? 0.4 : 0.17) + ")";
      g.beginPath();
      g.moveTo(p.x + p.nx * off, p.y + p.ny * off);
      g.lineTo(p.x + p.nx * (off + lenTick), p.y + p.ny * (off + lenTick));
      g.stroke();
    }
    g.restore();
  }

  /**
   * The LIVE half of one rev bar: the lit band and its leading cap.
   *
   * ## No `shadowBlur`
   * This used to set a shadow per band run — one blurred stroke for every lit
   * step, both bars, every frame. The cost therefore rose WITH THE REVS, so the
   * widget stuttered hardest at exactly the moment it exists to be read, and it
   * starved every other widget on the page while doing it. The bloom is now the
   * house technique (`radar.js` uses it for the blip halo): one wide translucent
   * stroke under the crisp one. That is 1 + N plain strokes per bar instead of N
   * blurred ones, and a blurred stroke is not a little more expensive than a
   * plain one — it is a separate rasterise-and-convolve pass.
   *
   * The band is still drawn in short runs so each carries ITS OWN colour;
   * colouring every lit run with the live colour would make the whole bar change
   * hue at once and destroy the "how much room is left" read that is the point.
   */
  function drawBand(g, pts, mirror, flashing) {
    if (revF <= 0.002) return;

    /* Past the shift point the bar is functionally full, so it is drawn full:
       the last half-percent would otherwise leave a few pixels of unlit track
       between each bar's tip and the keystone, and the entire point of the
       convergence is that the top reads as ONE bar. */
    var fill = revF >= BAND_SHIFT ? 1 : revF;
    var colours = flashing ? BAND_WHITE : BAND_RGBA;
    var i;

    g.save();
    g.lineCap = "butt";
    g.lineJoin = "round";

    /* the bloom: one wide, faint pass under the whole lit length */
    g.lineWidth = BAND_W + 12;
    g.strokeStyle = rgba(flashing ? [255, 255, 255] : revRgb(revF), 0.16);
    strokeBetween(g, pts, 0, fill, 0);

    /* the band itself */
    g.lineWidth = BAND_W;
    for (i = 0; i < BAND_STEPS; i++) {
      var a0 = i / BAND_STEPS;
      if (a0 >= fill) break;
      g.strokeStyle = colours[i];
      strokeBetween(g, pts, a0, Math.min((i + 1) / BAND_STEPS, fill), BAND_IDX[i]);
    }
    g.restore();

    /* --- the leading cap: a bright edge at the current value. Dropped at the
       shift point, where the bar is full and the flash IS the cue. --- */
    if (revF >= BAND_SHIFT) return;
    var p = barPointAt(pts, revF, mirror);
    var capCol = revRgb(revF);
    var reach = BAND_W / 2 + 3;
    g.save();
    g.lineCap = "round";
    // Same two-pass bloom, at cap scale.
    g.strokeStyle = rgba(capCol, 0.3);
    g.lineWidth = 9;
    g.beginPath();
    g.moveTo(p.x + p.nx * reach, p.y + p.ny * reach);
    g.lineTo(p.x - p.nx * reach, p.y - p.ny * reach);
    g.stroke();
    g.strokeStyle = rgba(capCol, 1);
    g.lineWidth = 3.5;
    g.beginPath();
    g.moveTo(p.x + p.nx * reach, p.y + p.ny * reach);
    g.lineTo(p.x - p.nx * reach, p.y - p.ny * reach);
    g.stroke();
    g.restore();
  }

  /**
   * The keystone bridging the two bar tips — the shift signal itself.
   *
   * A plain block rather than a shaped badge, so that at the limit the two bars
   * and the bridge read as ONE unbroken bar across the plateau. The convergence
   * is the message; anything that visibly seams it weakens the message.
   */
  function drawKeystone(g, flashing) {
    var l = BAR_L[BAR_L.length - 1];
    var r = BAR_R[BAR_R.length - 1];
    var lit = revF >= BAND_SHIFT;
    var x = l.x, y = l.y - BAND_W / 2, w = r.x - l.x;
    g.save();
    if (lit) {
      // The halo, as a plain translucent rect rather than a shadow — this fires
      // on alternate frames at the limiter, which is the worst possible moment
      // to add a blur pass.
      g.fillStyle = flashing ? "rgba(255,255,255,0.28)" : rgba(C_RED, 0.26);
      g.fillRect(x - 4, y - 6, w + 8, BAND_W + 12);
      g.fillStyle = flashing ? "#ffffff" : rgba(C_RED, 0.95);
    } else {
      g.fillStyle = "rgba(255,255,255,0.06)";
    }
    g.fillRect(x, y, w, BAND_W);
    g.restore();
  }

  /**
   * Bakes the two static layers at the current size.
   *
   * Plain `document.createElement("canvas")` rather than `OffscreenCanvas`, and a
   * string cache key rather than a dirty flag — both to match `trackmap.js`,
   * which is the house reference for this pattern.
   */
  function buildStatic() {
    var key = cssW + "x" + cssH + "|" + dpr;
    if (staticKey === key && layerBelow && layerAbove) return;
    staticKey = key;

    var s = Math.min(cssW / DW, cssH / DH);
    var ox = (cssW - DW * s) / 2;
    var oy = (cssH - DH * s) / 2;

    function layer(paint) {
      var c = document.createElement("canvas");
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      var g = c.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.translate(ox, oy);
      g.scale(s, s);
      paint(g);
      return c;
    }

    layerBelow = layer(drawShell);
    layerAbove = layer(function (g) {
      drawWells(g);
      if (showRev) {
        drawBarTrack(g, BAR_L, false);
        drawBarTrack(g, BAR_R, true);
      }
    });
  }

  /**
   * One frame: two blits, the illumination, and the live half of the two bars.
   *
   * ## It returns early when nothing moved
   * The signature is quantised revs plus the flash phase, which is everything
   * that can change the bitmap. A canvas keeps its contents, so an unchanged
   * frame needs no work at all — and this widget runs at the full broadcast rate
   * on a feed that keeps sending frames while the car sits in the pits or on the
   * grid. The quantum is 1/400 of the range, well under one pixel of bar travel,
   * so nothing visible is ever skipped. Same "signature, not dirty flag"
   * technique `weather.js` and `mfd.js` use for their DOM writes.
   */
  function draw() {
    if (!gctx || !cssW || !cssH) return;
    buildStatic();

    var flashing = revStageNow === "shift" && Math.floor(Date.now() / FLASH_MS) % 2 === 0;
    var key = staticKey + "|" + Math.round(revF * 400) + "|" + (flashing ? 1 : 0);
    if (key === lastFrameKey) return;
    lastFrameKey = key;

    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, cssW, cssH);

    // The two static layers are baked at this exact size, so they blit 1:1 in
    // device pixels — no scaling, no smoothing.
    gctx.drawImage(layerBelow, 0, 0, cssW, cssH);

    // The stage carries the design box's aspect ratio in CSS, so this is a
    // uniform scale — see the header on why the axes are never scaled apart.
    var s = Math.min(cssW / DW, cssH / DH);
    gctx.save();
    gctx.translate((cssW - DW * s) / 2, (cssH - DH * s) / 2);
    gctx.scale(s, s);
    if (showBg) drawGlow(gctx, revRgb(revF), flashing);
    gctx.restore();

    gctx.drawImage(layerAbove, 0, 0, cssW, cssH);

    gctx.save();
    gctx.translate((cssW - DW * s) / 2, (cssH - DH * s) / 2);
    gctx.scale(s, s);
    if (showRev) {
      drawBand(gctx, BAR_L, false, flashing);
      drawBand(gctx, BAR_R, true, flashing);
      drawKeystone(gctx, flashing);
    }
    gctx.restore();
  }

  /* ---------------------------------------------------------------------- */
  /*  Markup                                                                 */
  /* ---------------------------------------------------------------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /** One label/value/sub stack, as used by the budget readouts. */
  function stat(parent, label) {
    var wrap = el("div", "speedo__stat");
    wrap.appendChild(el("span", "speedo__stat-k", label));
    var v = el("span", "speedo__stat-v is-crit", "—");
    wrap.appendChild(v);
    var sub = el("span", "speedo__stat-sub", "");
    wrap.appendChild(sub);
    parent.appendChild(wrap);
    return { wrap: wrap, value: v, sub: sub };
  }

  function chip(parent, label) {
    var c = el("span", "speedo__chip is-crit", label);
    c.setAttribute("data-on", "false");
    parent.appendChild(c);
    return c;
  }

  /**
   * Positions a DOM box over its rectangle in the design box, as percentages.
   *
   * Percentages rather than pixels because the stage is fixed-aspect: one set of
   * numbers then holds at every size the operator drags the widget to, with no
   * per-resize write. And they come from {@link BOXES} — the same constants the
   * canvas draws from — because the alternative is the stylesheet carrying a
   * second copy of the geometry that silently stops agreeing with the drawing.
   */
  function placeBox(node, b) {
    if (!node) return;
    node.style.left = (b.x / DW) * 100 + "%";
    node.style.top = (b.y / DH) * 100 + "%";
    node.style.width = (b.w / DW) * 100 + "%";
    node.style.height = (b.h / DH) * 100 + "%";
  }

  function init(root, ctx) {
    // The stage and the canvas come from the SHELL; this widget builds only its
    // readout layer. Keeping the canvas in the markup fixes the stacking order
    // in one place rather than depending on the order things are appended here.
    var stage = root.querySelector('[data-role="stage"]');
    var mount = root.querySelector('[data-role="cluster"]');
    if (!stage || !mount) return;
    stageEl = stage;
    canvas = stage.querySelector(".speedo__bg");
    mount.innerHTML = "";
    cache = {};

    var params = new URLSearchParams(window.location.search);
    var off = function (name) {
      var v = (params.get(name) || "").toLowerCase();
      return v === "off" || v === "0" || v === "false";
    };
    showBg = !off("bg");
    showRev = !off("rev");

    /* --- centre: the two Tier-1 readouts --- */
    var core = el("div", "speedo__core");
    var speedLine = el("div", "speedo__speed");
    elSpeed = el("span", "speedo__speed-v", "—");
    elUnit = el("small", "speedo__speed-u", ctx.fmt.speedUnitLabel().toUpperCase());
    speedLine.appendChild(elSpeed);
    speedLine.appendChild(elUnit);
    core.appendChild(speedLine);
    elRpm = el("div", "speedo__rpm", "— RPM");
    core.appendChild(elRpm);
    // The gear is framed as its own glyph, the way a real cluster frames it, and
    // sits directly under the speed: the two are read as a unit.
    elGear = el("div", "speedo__gear is-crit", "—");
    core.appendChild(elGear);
    mount.appendChild(core);

    /* --- left well: the two distance budgets --- */
    var budgetL = el("div", "speedo__budgets");
    var fuel = stat(budgetL, "FUEL");
    elFuel = fuel.value;
    elFuelSub = fuel.sub;
    var ve = stat(budgetL, "ENERGY");
    elVeWrap = ve.wrap;
    elVe = ve.value;
    elVeSub = ve.sub;
    elVeWrap.hidden = true;
    mount.appendChild(budgetL);

    /* --- right well: pace, and the lap-scale energy budget --- */
    var budgetR = el("div", "speedo__budgets speedo__budgets--r");
    var proj = stat(budgetR, "PROJECTED");
    elProj = proj.value;
    elProjDelta = proj.sub;
    elProjDelta.className = "speedo__stat-sub speedo__delta";

    var batt = el("div", "speedo__stat");
    batt.appendChild(el("span", "speedo__stat-k", "BATTERY"));
    var battRow = el("div", "speedo__batt");
    // A battery GLYPH, not a plain bar: a cell outline with a terminal nub,
    // filling with charge. It reads as a battery at a glance and at any size,
    // which a bare bar does not — and it is the thing that lights up when charge
    // is flowing back in, so it has to be recognisable in peripheral vision.
    var icon = el("span", "speedo__batt-icon");
    elBattFill = el("div", "speedo__batt-fill");
    icon.appendChild(elBattFill);
    battRow.appendChild(icon);
    elBattVal = el("span", "speedo__batt-v", "—");
    battRow.appendChild(elBattVal);
    batt.appendChild(battRow);
    elBattFlow = el("span", "speedo__stat-sub", "");
    batt.appendChild(elBattFlow);
    budgetR.appendChild(batt);
    elBattWrap = batt;
    elBattWrap.hidden = true;
    mount.appendChild(budgetR);

    /* --- chips, in the chin --- */
    elChips = el("div", "speedo__chips");
    chipLimiter = chip(elChips, "LIMITER");
    // Its own class, not a positional selector: the chip strip's membership
    // changes with what the feed can see, so "the first chip" is not stably the
    // limiter and styling it that way would eventually paint TC cyan.
    chipLimiter.classList.add("is-limiter");
    chipLimiter.hidden = true;
    // Regen sits with the limiter rather than with TC/ABS: like the limiter it
    // is a state the driver has chosen and can be caught out by, not a system
    // trimming an input. It gets its own colour for the same reason.
    chipRegen = chip(elChips, "REGEN —");
    chipRegen.classList.add("is-regen");
    chipTc = chip(elChips, "TC —");
    chipCut = chip(elChips, "PWR —");
    chipSlip = chip(elChips, "SLIP —");
    chipAbs = chip(elChips, "ABS —");
    mount.appendChild(elChips);

    /* --- everything onto its rectangle in the design box --- */
    placeBox(core, BOXES.core);
    placeBox(budgetL, BOXES.budgetL);
    placeBox(budgetR, BOXES.budgetR);
    placeBox(elChips, BOXES.chips);

    gctx = canvas.getContext("2d");
    sizeCanvas();
    watchSize(canvas);
  }

  /* ---------------------------------------------------------------------- */
  /*  Update                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Cached plain write — for continuously drifting values, which must not glow. */
  function set(node, key, text) {
    if (!node) return;
    if (cache[key] === text) return;
    cache[key] = text;
    node.textContent = text;
  }

  function setHidden(node, key, hidden) {
    if (!node) return;
    if (cache[key] === hidden) return;
    cache[key] = hidden;
    node.hidden = hidden;
  }

  /**
   * One aid chip from the MFD block.
   *
   * The setting is discrete — the driver turned a dial — so it takes the change
   * glow through `crit`, which is exactly what that signal is for: the number
   * moved because someone moved it. `active` is the live intervention from the
   * pedals block and only lights the chip; it changes several times a corner and
   * would strobe if it were allowed to bloom.
   */
  function aidChip(node, ctx, label, aid, active) {
    if (!node) return;
    if (!aid) {
      setHidden(node, "hide-" + label, true);
      return;
    }
    setHidden(node, "hide-" + label, false);
    // The sim's OWN rendering of the step — "200kW", "P6", "1.5% F" — which is
    // what the driver sees on the wheel. It falls back to the raw index in
    // mfdControl, so a TC map still reads "7/11"; using `value/maxValue` here
    // instead would throw the good labels away for the aids that have them.
    ctx.crit(node, label + " " + (aid.text || aid.value + "/" + aid.maxValue));
    var on = active === true;
    if (cache["on-" + label] !== on) {
      cache["on-" + label] = on;
      node.setAttribute("data-on", String(on));
    }
  }

  function findAid(mfd, key) {
    if (!mfd || !mfd.aids) return null;
    for (var i = 0; i < mfd.aids.length; i++) {
      if (mfd.aids[i].key === key) return mfd.aids[i];
    }
    return null;
  }

  function update(frame, ctx) {
    var p = frame.player;
    var fmt = ctx.fmt;

    // Re-check the bitmap periodically: ResizeObserver does not deliver while a
    // page is not producing frames, and an in-game widget can be dragged in
    // exactly that state. Same backstop motion.js keeps.
    if (++sizeTick % 30 === 0) sizeCanvas();

    /* --- revs: the cluster's headline signal --- */
    revF = revFraction(p.rpm, p.maxRpm);
    revStageNow = revStage(revF);
    draw();

    /* --- speed + gear --- */
    // Unit and value both from the shared runtime, so this panel can never
    // disagree with the pedal traces about what the number means.
    set(elSpeed, "speed", fmt.speedValue(p.speedKph));
    set(elUnit, "unit", fmt.speedUnitLabel().toUpperCase());
    // Gear is discrete: every change is a shift, and a shift is news.
    ctx.crit(elGear, fmt.gearLabel(p.gear));
    ctx.critAttr(elGear, "data-rev", revStageNow);
    set(elRpm, "rpm", fmt.has(p.rpm) ? Math.round(p.rpm) + " RPM" : "— RPM");

    /* --- fuel + virtual energy --- */
    var f = frame.fuel || {};
    set(elFuel, "fuel", fmt.has(f.levelLiters) ? f.levelLiters.toFixed(1) + " L" : "—");
    // Laps left is a whole number that steps — the discrete half of a fuel read,
    // and the one worth announcing.
    ctx.crit(
      elFuelSub,
      fmt.has(f.lapsRemaining) ? "≈" + f.lapsRemaining.toFixed(1) + " LAPS" : "—",
    );

    var hasVe = typeof f.virtualEnergyPct === "number" && f.virtualEnergyPct >= 0;
    setHidden(elVeWrap, "ve", !hasVe);
    if (hasVe) {
      set(elVe, "vev", Math.round(f.virtualEnergyPct) + "%");
      ctx.crit(
        elVeSub,
        typeof f.virtualEnergyLapsRemaining === "number" && f.virtualEnergyLapsRemaining >= 0
          ? "≈" + f.virtualEnergyLapsRemaining.toFixed(1) + " LAPS"
          : "—",
      );
    }

    /* --- projected lap --- */
    var pd = p.paceDeltas;
    var proj = pd && fmt.has(pd.predictedLapSec) ? pd.predictedLapSec : -1;
    // Drifts continuously with the delta, so it is written plainly. Its SIGN is
    // the discrete part, and that is what carries the glow, below.
    set(elProj, "proj", proj >= 0 ? fmt.lapTime(proj) : "—");
    var d = pd && fmt.has(pd.tSession) ? pd.tSession : null;
    set(elProjDelta, "projd", d === null ? "—" : fmt.delta(d));
    ctx.critAttr(elProjDelta, "data-state", d === null ? "none" : d < 0 ? "up" : "down");

    /* --- hybrid battery + regen --- */
    var hy = p.hybrid;
    // Which way the motor is working, as one value the battery block and the
    // regen chip both read, so they can never contradict each other. The 5 Nm
    // deadband keeps a coasting car from flickering between the two states.
    var torque = hy && typeof hy.motorTorqueNm === "number" ? hy.motorTorqueNm : 0;
    var regenerating = hy ? torque < -5 : false;
    var deploying = hy ? torque > 5 : false;

    setHidden(elBattWrap, "batt", !hy);
    if (hy) {
      var pctN = Math.round(hy.chargeFraction * 100);
      set(elBattVal, "battv", pctN + "%");
      var w = pctN + "%";
      if (cache.battw !== w) {
        cache.battw = w;
        elBattFill.style.width = w;
      }
      // Bucketed state, so the bar's colour changes on a threshold rather than
      // fading imperceptibly — and so crossing one blooms.
      ctx.critAttr(elBattFill, "data-state", pctN <= 15 ? "low" : pctN <= 40 ? "mid" : "ok");
      // Which way the charge is going — the only thing that says whether an
      // emptying battery is being spent or is about to come back. Called REGEN
      // rather than HARVEST because that is the word on the driver's own wheel.
      set(elBattFlow, "flow", deploying ? "▲ DEPLOY" : regenerating ? "▼ REGEN" : "");
      // Recolours the bar while charge is flowing in, so the battery reads as
      // recovering at a glance rather than only through the label.
      ctx.critAttr(
        elBattWrap,
        "data-flow",
        deploying ? "deploy" : regenerating ? "regen" : "idle",
      );
    }

    /* --- chips --- */
    // The limiter chip exists only when the feed can actually see the limiter —
    // `pit.limiterOn` is omitted, not defaulted, when the byte is unreadable.
    var limiter = p.pit ? p.pit.limiterOn : undefined;
    var hasLimiter = typeof limiter === "boolean";
    setHidden(chipLimiter, "lim", !hasLimiter);
    if (hasLimiter) ctx.critAttr(chipLimiter, "data-on", String(limiter));

    var mfd = frame.mfd;
    var ped = p.pedals || {};
    // Only the TC map and ABS light on live intervention. The power-cut and slip
    // chips are the map's two sub-settings, not systems of their own — lighting
    // all three off one `pedals.tc` would give a TC event three times the visual
    // weight of an ABS event and blur the line this widget is careful about
    // elsewhere: a SETTING is what the driver chose, an intervention is what
    // just happened to them.
    // Regen carries BOTH halves of the answer: the level the driver selected,
    // and whether it is actually recovering right now. The level alone would not
    // say the car is charging; the live state alone would not say how hard.
    aidChip(chipRegen, ctx, "REGEN", findAid(mfd, "regen"), regenerating);
    aidChip(chipTc, ctx, "TC", findAid(mfd, "tc"), (ped.tc || 0) > 0.02);
    aidChip(chipCut, ctx, "PWR", findAid(mfd, "tcCut"), false);
    aidChip(chipSlip, ctx, "SLIP", findAid(mfd, "tcSlip"), false);
    aidChip(chipAbs, ctx, "ABS", findAid(mfd, "abs"), (ped.abs || 0) > 0.02);
  }

  window.ApexOverlay.registerWidget("speedo", {
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
