/**
 * widgets/speedo-gt3.js — ten GT3 per-car designs for the speedo cluster, plus
 * the shared canvas kit they (and speedo-real.js) are built on.
 * -----------------------------------------------------------------------------
 * Each design registers into `window.ApexSpeedoDesigns` and is selected from
 * the control panel's Design dropdown or pinned with `?design=<id>` — the same
 * contract as the LMP2 CDU. They are DESIGNS of the one speedo widget, not new
 * widgets: same shell, same feed, same slot.
 *
 * ## What these are
 * Original recreations of the character of each LMGT3 car's real dashboard,
 * drawn from photographs of the actual displays: the layout conventions, the
 * data each shows and the palette each is known by. All drawing code, type and
 * proportions here are our own; no manufacturer logos or wordmarks are drawn
 * (each plate carries the car's name in plain type instead), and nothing was
 * extracted from anyone else's dashboard files.
 *
 * ## The house rule about data
 * A design never invents a reading (the LMP2 file states the contract). Every
 * value is guarded: a channel the feed does not carry renders as "—", and a
 * BOX whose channel can never exist on this feed is simply not drawn. That is
 * why none of these show engine water/oil temperature — the frame does not
 * carry it yet — even where the donor car's screen has such a gauge.
 *
 * ## Rendering model
 * One canvas per design, letterboxed into the stage (the lmp2 bargain, in
 * canvas form). The static plate — background, boxes, labels — is baked to an
 * offscreen layer once per resize; each update draws the bake then the live
 * values over it. Fonts ride the frame scale, so the type is locked to the
 * plate. The plate and box fills are BACKGROUND and fade with the operator's
 * BG slider (--panel-alpha); the digits are DATA and stay — the same split
 * every design makes.
 */
(function () {
  "use strict";

  /** All ten plates are authored in this box (close to every donor photo). */
  var DW = 800;
  var DH = 450;

  var FD = "Bahnschrift, 'Segoe UI Semibold', Arial, sans-serif";
  var FM = "Consolas, monospace";

  /* ---------------------------------------------------------------------- */
  /*  Live values — pulled once per frame, shared by every design           */
  /* ---------------------------------------------------------------------- */

  /** Find a curated MFD aid by key (the lmp2 helper, verbatim contract). */
  function findAid(mfd, key) {
    if (!mfd || !mfd.aids) return null;
    for (var i = 0; i < mfd.aids.length; i++) {
      if (mfd.aids[i].key === key) return mfd.aids[i];
    }
    return null;
  }

  /**
   * Brake bias as the front percentage ("49.0:51.0" → "49.0"), because that is
   * the number every real dash prints. The raw text stands in when the wording
   * is not a ratio — showing the sim's own rendering beats showing nothing.
   */
  function biasText(aid) {
    if (!aid) return null;
    var m = /^(\d+(?:\.\d+)?):/.exec(aid.text || "");
    return m ? m[1] : aid.text || String(aid.value);
  }

  /**
   * Everything the ten plates read, null where the feed has no answer. One
   * object so each design's live() is a straight layout pass with no plumbing.
   */
  function pull(frame, ctx) {
    var fmt = ctx.fmt;
    var p = frame && frame.player ? frame.player : {};
    var lap = p.lap || {};
    var f = (frame && frame.fuel) || {};
    var mfd = frame ? frame.mfd : null;
    var w = (frame && frame.weather) || {};
    var pd = p.paceDeltas || null;
    var ped = p.pedals || null;
    var mo = p.motion || null;

    function num(v) {
      return fmt.has(v) ? v : null;
    }
    function lapStr(v) {
      return fmt.has(v) && v > 0 ? fmt.lapTime(v) : null;
    }

    var speed = num(p.speedKph);
    var deltaS = fmt.has(lap.delta) ? lap.delta : null;
    var tyres = p.tyres || null;

    // `t` is a DISPLAY number: already in the driver's unit and already
    // rounded, because every plate below prints it and none of them judges it.
    // Nothing Celsius reaches live() from here: the plates print temperatures,
    // they never judge one, and a threshold compared against a Fahrenheit
    // number would be wrong by a factor of nearly two.
    function corner(t) {
      if (!t) return { p: null, t: null, b: null };
      return { p: num(t.pressureKpa), t: tempNum(t.tempC), b: tempNum(t.brakeTempC) };
    }

    /** A 0..1 input channel as whole percent, null when the sim omits it. */
    function pct01(x) {
      return fmt.has(x) ? Math.round(x * 100) : null;
    }

    /** A Celsius reading in the driver's unit, rounded. Display only. */
    function tempNum(c) {
      var v = fmt.tempValue(c);
      return v === null ? null : Math.round(v);
    }

    return {
      demo: frame ? frame.connected === false : true,
      session: (frame && frame.session && frame.session.name) || null,
      gear: fmt.gearLabel(p.gear),
      speed: speed === null ? null : Math.round(fmt.speedValue(speed)),
      unit: fmt.speedUnitLabel().toUpperCase(),
      rpm: num(p.rpm) === null ? null : Math.round(p.rpm),
      /** The rev ceiling, so a plate that PRINTS a rev ladder can scale it. */
      maxRpm: num(p.maxRpm),
      revFrac:
        window.ApexSpeedo && num(p.rpm) !== null && num(p.maxRpm) !== null
          ? window.ApexSpeedo.revFraction(p.rpm, p.maxRpm)
          : 0,
      last: lapStr(lap.last),
      best: lapStr(lap.best),
      current: lapStr(lap.current),
      /** Projected finishing time for THE LAP IN PROGRESS — the delta widget's
       *  own "PROJ" reading, which is what a dash's "predicted" slot means. */
      pred: pd && fmt.has(pd.lapTimeSec) ? fmt.lapTime(pd.lapTimeSec) : null,
      delta: deltaS,
      deltaStr: deltaS === null ? null : (deltaS >= 0 ? "+" : "") + deltaS.toFixed(2),
      pos: num(p.position),
      laps: window.ApexOverlay ? window.ApexOverlay.playerLapsCompleted(frame) : -1,
      fuelL: num(f.levelLiters),
      fuelPerLap: num(f.perLapAvgLiters),
      fuelLaps: num(f.lapsRemaining),
      vePct: num(f.virtualEnergyPct),
      vePerLap: num(f.virtualEnergyPerLapPct),
      fl: corner(tyres && tyres.frontLeft),
      fr: corner(tyres && tyres.frontRight),
      rl: corner(tyres && tyres.rearLeft),
      rr: corner(tyres && tyres.rearRight),
      /* The TC family is THREE settings, not one: `tc` is the map, `tcSlip` the
         slip threshold, `tcCut` the power cut. A wheel labels them apart, so a
         plate that prints a SLIP box has to read the slip channel — pointing it
         at the map made two boxes on the same plate show one number for ever. */
      tc: findAid(mfd, "tc"),
      tcSlip: findAid(mfd, "tcSlip"),
      tcCut: findAid(mfd, "tcCut"),
      abs: findAid(mfd, "abs"),
      map: findAid(mfd, "motorMap"),
      /* Hypercar-only: mfdControl skips these rows on a car with no such
         adjustment, so the knobs carrying them read "—" on a GT3 and come alive
         in an LMH. That is the contract working, not a dead box. */
      arbF: findAid(mfd, "frontARB"),
      arbR: findAid(mfd, "rearARB"),
      bias: biasText(findAid(mfd, "BRAKE_BIAS")),
      /* Live driver inputs — what the pedals are DOING, as against what the
         wheel is set to. The THR/BRK tiles several plates carry are these. */
      throttle: ped ? pct01(ped.throttle) : null,
      brakePct: ped ? pct01(ped.brake) : null,
      latG: mo && fmt.has(mo.latG) ? mo.latG : null,
      /* Every temperature leaves here ALREADY in the driver's unit and already
         rounded — no plate below judges one, they only print them, and nothing
         Celsius should reach live() where the unit is no longer known. */
      trackT: tempNum(w.trackTempC),
      /* `ambientTempC` is the channel's name on WeatherState; `airTempC` exists
         only on a FORECAST slot, so reading it here made every AIR box on every
         plate a permanent dash. */
      airT: tempNum(w.ambientTempC),
      tempUnit: fmt.tempUnitLabel(),
      trackState: (w.trackCondition && String(w.trackCondition)) || null,
      limiter: !!(p.pit && p.pit.limiterOn),
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  The canvas kit                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Wrap a plate spec into a design `{init, update}`.
   *
   * spec.bake(g, A)      draws the static plate (g is pre-scaled to DW×DH).
   * spec.live(g, v, A)   draws the live values each frame.
   * A is the paint kit bound to that context (box/txt/etc + panel alpha).
   */
  function canvasDesign(spec) {
    /* Plates default to the shared 800×450 box; a design may bring its own
       (speedo-real.js authors in the Apex cluster's 1000×470). */
    var dw = spec.dw || DW;
    var dh = spec.dh || DH;
    var stageEl = null,
      canvas = null,
      g = null,
      baked = null,
      scale = 0,
      /** The BG-slider alpha the plate was baked at; see draw(). */
      bakedAlpha = -1,
      lastFrame = null,
      lastCtx = null,
      /** Signature of the values last painted — see draw(). */
      lastSig = null,
      /** Cached BG-slider alpha + the tick that refreshes it — see panelAlpha(). */
      cachedAlpha = 1,
      alphaTick = 0,
      /** This design's ONE stage observer, re-aimed on re-init — see init(). */
      observer = null;

    /**
     * The operator's BG slider, as the stylesheet publishes it.
     *
     * Sampled every ALPHA_EVERY draws, not every draw: getComputedStyle is a
     * forced style recalculation, and this factory runs at the full broadcast
     * rate for eleven of the twelve designs — it was the single most expensive
     * call in the overlay's hot path, run mid-dispatch right after other
     * widgets had written DOM. The Apex cluster in speedo.js already samples
     * its alpha a few times a second for exactly this reason; this is the same
     * cadence. A slider move lands within a third of a second, far inside how
     * long the drag itself takes.
     */
    var ALPHA_EVERY = 10;
    function panelAlpha() {
      if (!stageEl) return 1;
      if (alphaTick++ % ALPHA_EVERY === 0) {
        var v = parseFloat(getComputedStyle(stageEl).getPropertyValue("--panel-alpha"));
        cachedAlpha = isNaN(v) ? 1 : Math.max(0, Math.min(1, v));
      }
      return cachedAlpha;
    }

    /**
     * What the live layer is about to paint, flattened to one string. The
     * continuous channels are quantised to below what a pixel can show, so a
     * car sitting in the garage — or an OBS source of a parked car — stops
     * paying for a full clear + plate + live repaint per frame. Any real
     * movement changes the string and paints normally.
     */
    function liveSignature(v) {
      // Quantise the continuous channels IN PLACE, so both the signature and
      // the paint read the same (sub-pixel-rounded) numbers: delta and latG to
      // hundredths, the rev fraction to 1/400 of the ladder (the same quantum
      // speedo.js chose), pressures to a tenth of a kPa.
      if (v.delta !== null) v.delta = Math.round(v.delta * 100) / 100;
      if (v.latG !== null) v.latG = Math.round(v.latG * 100) / 100;
      v.revFrac = Math.round((v.revFrac || 0) * 400) / 400;
      quantCorner(v.fl);
      quantCorner(v.fr);
      quantCorner(v.rl);
      quantCorner(v.rr);
      return JSON.stringify(v);
    }

    function quantCorner(c) {
      if (c && c.p !== null && c.p !== undefined) c.p = Math.round(c.p * 10) / 10;
    }

    function kit(ctx2d, pa) {
      var K = {
        pa: pa,
        /** A box: fill is background (fades), border is chrome (stays). */
        box: function (x, y, w, h, o) {
          o = o || {};
          var r = o.r || 0;
          ctx2d.beginPath();
          if (r) {
            ctx2d.moveTo(x + r, y);
            ctx2d.arcTo(x + w, y, x + w, y + r, r);
            ctx2d.arcTo(x + w, y + h, x + w - r, y + h, r);
            ctx2d.arcTo(x, y + h, x, y + h - r, r);
            ctx2d.arcTo(x, y, x + r, y, r);
          } else ctx2d.rect(x, y, w, h);
          ctx2d.closePath();
          if (o.fill) {
            ctx2d.save();
            ctx2d.globalAlpha = o.data ? 1 : pa;
            ctx2d.fillStyle = o.fill;
            ctx2d.fill();
            ctx2d.restore();
          }
          if (o.border) {
            ctx2d.strokeStyle = o.border;
            ctx2d.lineWidth = o.lw || 2;
            ctx2d.stroke();
          }
        },
        txt: function (t, x, y, size, color, align, weight, font) {
          ctx2d.fillStyle = color;
          ctx2d.font = (weight || 600) + " " + size + "px " + (font || FD);
          ctx2d.textAlign = align || "left";
          ctx2d.fillText(t == null ? "—" : String(t), x, y);
        },
        /** Label-on-top value tile, the shape half these dashes are made of. */
        tile: function (label, x, y, w, h, o) {
          o = o || {};
          K.box(x, y, w, h, { fill: o.fill || "#000", border: o.border || "#fff", lw: o.lw || 2, r: o.r || 3 });
          K.txt(label, x + w / 2, y + (o.lh || 15), o.ls || 11, o.lc || "#aab", "center", 600);
        },
        val: function (t, x, y, size, color, align) {
          K.txt(t == null ? "—" : t, x, y, size, color, align || "center", 700);
        },
      };
      return K;
    }

    /**
     * Letterbox the canvas into the stage, and cut a bitmap to match.
     *
     * The CSS size comes from the stage's LAYOUT box (`clientWidth`), never
     * from `getBoundingClientRect()`. The in-game layer scales each widget with
     * `transform: scale(n)` and the rect reports the POST-transform box, so
     * sizing the canvas in CSS px from the rect fed that same `n` back in a
     * second time: the element was laid out n times too big and the transform
     * then magnified it again. At n = 2 the plate drew itself four times design
     * size and the stage's `overflow: hidden` cut the rest off — and because a
     * transform is not a layout change, it arrived as a JUMP on drag release
     * (nudgeCanvasSizes() in ingame.js), not as a smooth grow. `clientWidth` is
     * pre-transform, so the CSS box takes the widget's scale exactly once.
     *
     * The BITMAP does follow the transform — that is what raster.js is for. A
     * canvas is magnified like a photo, so a widget at 2x needs twice the pixels
     * to stay as sharp as the text beside it. Same contract as the Apex design
     * in speedo.js, and it replaces the local dpr cap of 2 with the shared
     * ceiling.
     *
     * Idempotent, so the ResizeObserver watching the stage cannot feed itself.
     */
    function rebake() {
      if (!canvas || !stageEl) return;
      var w = stageEl.clientWidth || 0;
      var h = stageEl.clientHeight || 0;
      if (!(w > 0) || !(h > 0)) return;
      var s = Math.min(w / dw, h / dh);
      canvas.style.width = Math.round(dw * s) + "px";
      canvas.style.height = Math.round(dh * s) + "px";
      // Measured after the style write, so backingScale() sees the box the
      // canvas actually ended up occupying on screen.
      var d = window.ApexRaster
        ? window.ApexRaster.backingScale(canvas)
        : Math.min(window.devicePixelRatio || 1, 2);
      var bw = Math.round(dw * s * d);
      var bh = Math.round(dh * s * d);
      var pa = panelAlpha();
      if (baked && bw === canvas.width && bh === canvas.height && pa === bakedAlpha) return;
      canvas.width = bw;
      canvas.height = bh;
      scale = s * d;

      baked = document.createElement("canvas");
      baked.width = canvas.width;
      baked.height = canvas.height;
      bakedAlpha = pa;
      lastSig = null; // a fresh plate always repaints its live layer
      var bg = baked.getContext("2d");
      bg.scale(scale, scale);
      bg.textBaseline = "alphabetic";
      spec.bake(bg, kit(bg, pa));
      draw();
    }

    function draw() {
      if (!g || !baked) return;
      // The static plate carries the BG slider's alpha baked into it, so a move
      // of the slider has to re-bake — nothing else disturbs it, and without
      // this the plate would keep the alpha it was born with for the session
      // while the live values faded around it. rebake() ends by calling back
      // here with bakedAlpha updated, so this is one hop, not a loop.
      var pa = panelAlpha();
      if (pa !== bakedAlpha) {
        rebake();
        return;
      }
      // Nothing the live layer paints has moved by a visible amount? Keep the
      // bitmap that is already on screen — the same early-out the Apex cluster
      // has always had (speedo.js lastFrameKey), ported here so the other
      // eleven designs stop repainting a parked car at the broadcast rate.
      var v = null;
      if (lastFrame && lastCtx) {
        v = pull(lastFrame, lastCtx);
        var sig = liveSignature(v);
        if (sig === lastSig) return;
        lastSig = sig;
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.drawImage(baked, 0, 0);
      g.setTransform(scale, 0, 0, scale, 0, 0);
      g.textBaseline = "alphabetic";
      if (v) spec.live(g, v, kit(g, pa));
    }

    return {
      init: function (root) {
        stageEl = root.querySelector('[data-role="stage"]');
        var mount = root.querySelector('[data-role="cluster"]');
        if (!stageEl || !mount) return;
        mount.innerHTML = "";
        canvas = document.createElement("canvas");
        canvas.className = "spgt3";
        mount.appendChild(canvas);
        g = canvas.getContext("2d");
        baked = null;
        scale = 0;
        // Re-aimed rather than added to, the same contract speedo.js and the
        // LMP2 design keep: init() runs again every time the operator picks a
        // different cluster, and an observer outlives the canvas it was set up
        // for — so without this a design switched away from and back to again
        // left a live observer per visit, all rebaking the same plate.
        if (observer) observer.disconnect();
        if (typeof ResizeObserver === "function") {
          observer = new ResizeObserver(rebake);
          observer.observe(stageEl);
        }
        window.addEventListener("resize", rebake, { passive: true });
        rebake();
      },
      update: function (frame, ctx) {
        lastFrame = frame;
        lastCtx = ctx;
        if (!baked) rebake();
        else draw();
      },
      /**
       * Put this design down when another one takes the slot (speedo.js calls
       * it on the outgoing design). Without it the observer kept watching a
       * stage this design no longer draws into: every later switch changes the
       * stage's aspect ratio, which is a resize, which had every plate the
       * operator had ever selected re-bake itself onto a detached canvas
       * nobody would ever see.
       */
      stop: function () {
        if (observer) observer.disconnect();
        observer = null;
        window.removeEventListener("resize", rebake);
        // Dropped so a design put down mid-session cannot pin the last frame
        // it saw (and the whole ctx behind it) for the rest of the stream.
        lastFrame = null;
        lastCtx = null;
      },
    };
  }

  /* Shared paint for the segmented rev strips several plates carry. */
  function revStrip(g, K, x, y, w, h, segs, frac, colors) {
    var sw = w / segs;
    for (var i = 0; i < segs; i++) {
      var lit = frac > i / segs;
      var c = colors(i / segs, lit);
      K.box(x + i * sw, y, sw - 2, h, { fill: c, data: lit });
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  1 · Porsche 911 GT3 R — black, thin colour-bordered boxes             */
  /* ---------------------------------------------------------------------- */

  var p911 = canvasDesign({
    bake: function (g, K) {
      K.box(0, 0, DW, DH, { fill: "#000" });
      K.txt("9 1 1  G T 3  R", DW / 2, 26, 15, "#8a94a0", "center", 700);
      K.box(300, 38, 200, 46, { fill: "#0c0e10", border: "#3a3f46", r: 4 }); /* speed */
      K.box(514, 38, 120, 46, { fill: "#0c0e10", border: "#3a3f46", r: 4 }); /* lap */
      K.txt("LAP", 540, 68, 15, "#cfd6dd");
      K.box(700, 38, 88, 46, { fill: "#e9eaec", r: 4 }); /* condition */
      /* left column MAP / TC-C / TC-R / ABS */
      [["MAP", "#3d9c50"], ["TC-C", "#c9313c"], ["TC-R", "#3d9c50"], ["ABS", "#2b3fe2"]].forEach(
        function (r, i) {
          var y = 100 + i * 52;
          K.box(14, y, 118, 44, { fill: "#0a0c0e", border: r[1], r: 5 });
          K.txt(r[0], 26, y + 29, 16, "#dde3e9");
        },
      );
      /* laptime + time-diff panels */
      K.box(146, 100, 208, 130, { fill: "#43464a", r: 6 });
      K.txt("Laptime", 250, 124, 16, "#e6e9ec", "center");
      K.box(448, 100, 206, 130, { fill: "#43464a", r: 6 });
      K.txt("Time Diff", 551, 124, 16, "#e6e9ec", "center");
      K.txt("Position", 496, 208, 14, "#c9ced4", "center");
      K.txt("Best", 606, 208, 14, "#c9ced4", "center");
      /* tyre panel + bias */
      K.box(340, 300, 160, 128, { fill: "#0a0c0e", border: "#e2a33b", lw: 3, r: 4 });
      K.txt("TYRE", 420, 322, 15, "#e2a33b", "center", 700);
      K.box(560, 344, 108, 36, { fill: "#43464a", r: 3 });
      K.txt("Brake Bias", 566, 368, 13, "#dde3e9");
      K.box(668, 344, 84, 36, { fill: "#1a3be2", r: 3 });
      /* right fuel-level bar frame */
      K.box(742, 100, 46, 328, { fill: "#0a0c0e", border: "#3a3f46", r: 4 });
    },
    live: function (g, v, K) {
      K.val(v.speed, 400, 72, 30, "#fff");
      K.val(v.laps >= 0 ? v.laps : null, 606, 70, 24, "#fff");
      /* The condition box says what the SURFACE is, in the sim's own words.
         Track temperature is a different question and cannot answer this one —
         a wet track at 31° was reading "HOT", which on this box means dry. */
      K.val(v.trackState, 744, 70, 18, "#000");
      /* TC-C is the power cut, TC-R the slip (regulation) threshold. */
      var aids = [v.map, v.tcCut, v.tcSlip, v.abs];
      aids.forEach(function (a, i) {
        K.val(a ? a.value : null, 120, 129 + i * 52, 20, "#fff", "right");
      });
      K.val(v.last || v.current, 250, 196, 34, "#fff");
      K.val(v.deltaStr, 551, 176, 30, v.delta !== null && v.delta < 0 ? "#4fc35f" : "#fff");
      K.val(v.pos, 496, 224, 18, "#fff");
      K.val(v.best, 606, 224, 16, "#fff");
      K.val(v.gear, 250, 356, 92, "#e8edf2");
      /* tyres: temps inside, pressures at the corners */
      K.val(v.fl.t, 386, 356, 22, "#fff");
      K.val(v.fr.t, 454, 356, 22, "#fff");
      K.val(v.rl.t, 386, 394, 22, "#fff");
      K.val(v.rr.t, 454, 394, 22, "#fff");
      K.txt(v.fl.p != null ? Math.round(v.fl.p) : "—", 350, 336, 12, "#e05a6a");
      K.txt(v.fr.p != null ? Math.round(v.fr.p) : "—", 490, 336, 12, "#e05a6a", "right");
      K.txt(v.rl.p != null ? Math.round(v.rl.p) : "—", 350, 420, 12, "#e05a6a");
      K.txt(v.rr.p != null ? Math.round(v.rr.p) : "—", 490, 420, 12, "#e05a6a", "right");
      K.val(v.bias, 710, 369, 18, "#fff");
      /* fuel level bar */
      if (v.fuelL !== null && v.fuelLaps !== null) {
        var frac = Math.max(0, Math.min(1, v.fuelLaps / 30));
        var hgt = 320 * frac;
        K.box(746, 104 + (320 - hgt), 38, hgt, { fill: "#2fd24a", data: true });
      }
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  2 · Aston Martin Vantage GT3 — the white-faced gear ring + knob row   */
  /* ---------------------------------------------------------------------- */

  var aston = canvasDesign({
    bake: function (g, K) {
      K.box(0, 0, DW, DH, { fill: "#0a0b0c" });
      K.txt("V A N T A G E  G T 3", DW / 2, 300, 13, "#5a6470", "center", 700);
      /* left + right stat labels with lime underlines */
      var L = [["ENERGY", 20], ["SPEED", 20], ["FUEL LAP", 150], ["LAP COUNT", 150]];
      L.forEach(function (s, i) {
        var y = i % 2 ? 160 : 66;
        K.txt(s[0], s[1], y + 56, 13, "#cfd6dd", "left", 700);
        K.box(s[1], y + 64, 110, 3, { fill: "#9dc22e" });
      });
      var R = [["LAST LAP", 780, 66], ["B BIAS", 636, 160], ["DELTA", 780, 160]];
      R.forEach(function (s) {
        K.txt(s[0], s[1], s[2] + 56, 13, "#cfd6dd", "right", 700);
        K.box(s[1] - 110, s[2] + 64, 110, 3, { fill: "#9dc22e" });
      });
      /* the tyre grid, which carried no caption at all */
      K.txt("T Y R E    kPa · °C", 700, 310, 12, "#5a6470", "center", 700);
      /* the ring */
      g.beginPath();
      g.arc(400, 160, 104, 0, 7);
      g.save();
      g.globalAlpha = K.pa;
      g.fillStyle = "#e9eaec";
      g.fill();
      g.restore();
      g.strokeStyle = "#9dc22e";
      g.lineWidth = 8;
      g.stroke();
      /* knob row */
      var knobs = [["TC SLIP", "#8fae3c"], ["MODE", "#8f3c3c"], ["ARB F", "#2b6fd4"], ["TC", "#c9d6e2"], ["ARB R", "#2aa6a0"], ["ABS", "#2b3f8f"], ["TC PRO", "#a05a2c"]];
      knobs.forEach(function (k, i) {
        var x = 68 + i * 111;
        g.beginPath();
        g.arc(x, 372, 30, 0, 7);
        g.save();
        g.globalAlpha = K.pa;
        g.fillStyle = "#16181c";
        g.fill();
        g.restore();
        g.strokeStyle = k[1];
        g.lineWidth = 6;
        g.stroke();
        K.txt(k[0], x, 428, 12, "#c9ced4", "center", 700);
      });
    },
    live: function (g, v, K) {
      K.val(v.vePct !== null ? Math.round(v.vePct) : null, 20, 108, 34, "#fff", "left");
      K.val(v.fuelPerLap !== null ? v.fuelPerLap.toFixed(2) : null, 150, 108, 34, "#fff", "left");
      K.val(v.speed, 20, 202, 34, "#fff", "left");
      K.val(v.laps >= 0 ? v.laps : null, 150, 202, 34, "#fff", "left");
      K.val(v.last, 780, 108, 30, "#fff", "right");
      K.val(v.bias, 636, 202, 30, "#fff", "right");
      K.val(v.deltaStr, 780, 202, 30, v.delta !== null && v.delta < 0 ? "#8fd44a" : "#fff", "right");
      /* tyre grid under the right stack: pressures big, temps at corners */
      K.val(v.fl.p != null ? Math.round(v.fl.p) : null, 668, 250, 22, "#fff");
      K.val(v.fr.p != null ? Math.round(v.fr.p) : null, 728, 250, 22, "#fff");
      K.val(v.rl.p != null ? Math.round(v.rl.p) : null, 668, 280, 22, "#fff");
      K.val(v.rr.p != null ? Math.round(v.rr.p) : null, 728, 280, 22, "#fff");
      K.txt(v.fl.t != null ? v.fl.t : "—", 612, 250, 13, "#9aa5b0");
      K.txt(v.fr.t != null ? v.fr.t : "—", 752, 250, 13, "#9aa5b0");
      K.txt(v.rl.t != null ? v.rl.t : "—", 612, 280, 13, "#9aa5b0");
      K.txt(v.rr.t != null ? v.rr.t : "—", 752, 280, 13, "#9aa5b0");
      K.val(v.gear, 400, 196, 108, "#111", "center");
      /* knob values */
      /* One value per knob, in the order the knobs are drawn. Three of these
         were `null` placeholders: TC SLIP — the knob this wheel is best known
         for — and both ARBs never read anything at all. */
      var kv = [v.tcSlip, v.map, v.arbF, v.tc, v.arbR, v.abs, v.tcCut];
      kv.forEach(function (a, i) {
        K.val(a ? a.value : null, 68 + i * 111, 384, 26, "#fff");
      });
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  3 · BMW M4 GT3 — chunky white tiles, green gear, kg fuel              */
  /* ---------------------------------------------------------------------- */

  var m4 = canvasDesign({
    bake: function (g, K) {
      K.box(0, 0, DW, DH, { fill: "#000" });
      K.tile("LAP FUEL [L]", 14, 70, 168, 66, { ls: 13, lh: 18 });
      K.tile("FUEL REMAIN [L]", 14, 146, 168, 66, { ls: 13, lh: 18 });
      /* top right aids */
      K.box(506, 10, 70, 54, { fill: "#e9eaec", r: 2 });
      K.txt("AIR", 541, 28, 13, "#000", "center", 700);
      [["MAP", "#c9313c"], ["TC", "#2b3f8f"], ["ABS", "#c9313c"]].forEach(function (t, i) {
        K.tile(t[0], 584 + i * 72, 10, 64, 54, { fill: t[1], border: "#fff", lc: "#fff", lh: 16, ls: 12 });
      });
      K.tile("GAIN/LOSS", 584, 92, 202, 58, { ls: 13, lh: 17 });
      K.tile("LAST LAP", 584, 160, 202, 58, { ls: 13, lh: 17 });
      K.tile("BEST LAP", 584, 228, 202, 58, { ls: 13, lh: 17 });
      /* bottom row */
      K.tile("TCCUT", 14, 372, 76, 62, { ls: 12 });
      K.tile("SLIP", 98, 372, 76, 62, { ls: 12 });
      K.tile("TRACK", 240, 372, 120, 62, { ls: 12 });
      K.tile("BRAKE", 368, 372, 120, 62, { ls: 12 });
      /* Was labelled STINT over a value that has always been POSITION; the feed
         carries no stint-lap counter, so the label follows the data. */
      K.tile("POS", 530, 372, 76, 62, { ls: 12 });
      K.tile("LAP", 614, 372, 76, 62, { ls: 12 });
      K.tile("VE [%]", 698, 372, 88, 62, { ls: 12 });
    },
    live: function (g, v, K) {
      revStrip(g, K, 10, 8, 480, 18, 30, v.revFrac, function (f, lit) {
        if (!lit) return "#26292e";
        return f < 0.25 ? "#c9313c" : f < 0.5 ? "#e2c53b" : "#3dc94f";
      });
      K.val(v.fuelPerLap !== null ? v.fuelPerLap.toFixed(2) : null, 98, 126, 30, "#fff");
      K.val(v.fuelL !== null ? v.fuelL.toFixed(1) : null, 98, 202, 30, "#fff");
      K.val(v.airT, 541, 56, 22, "#000");
      [v.map, v.tc, v.abs].forEach(function (a, i) {
        K.val(a ? a.value : null, 616 + i * 72, 56, 26, "#fff");
      });
      K.val(v.gear, 300, 210, 150, "#41d95d");
      K.val(v.speed, 300, 300, 58, "#e8edf2");
      K.txt(v.unit, 300, 328, 14, "#7b8895", "center");
      K.val(v.deltaStr, 685, 140, 26, v.delta !== null && v.delta < 0 ? "#41d95d" : "#fff");
      K.val(v.last, 685, 208, 26, "#fff");
      K.val(v.best, 685, 276, 26, "#fff");
      K.val(v.tcCut ? v.tcCut.value : null, 52, 424, 26, "#fff");
      K.val(v.tcSlip ? v.tcSlip.value : null, 136, 424, 26, "#fff");
      K.val(v.trackT !== null ? v.trackT + "°" : null, 300, 424, 24, "#fff");
      K.val(v.bias, 428, 424, 24, "#fff");
      K.val(v.pos, 568, 424, 26, "#fff");
      K.val(v.laps >= 0 ? v.laps : null, 652, 424, 26, "#fff");
      K.val(v.vePct !== null ? Math.round(v.vePct) : null, 742, 424, 26, "#fff");
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  4 · Corvette Z06 GT3.R — navy carbon, olive digits                    */
  /* ---------------------------------------------------------------------- */

  var OL = "#c9cc6a";
  var z06 = canvasDesign({
    bake: function (g, K) {
      K.box(0, 0, DW, DH, { fill: "#0d1220" });
      g.strokeStyle = "#1c2740";
      g.lineWidth = 1;
      for (var i = 1; i < 5; i++) {
        g.beginPath();
        g.moveTo(0, i * 90);
        g.lineTo(DW, i * 90);
        g.stroke();
      }
      K.txt("Z 0 6  G T 3 . R", DW / 2, 20, 12, "#5a6a9a", "center", 700);
      /* The unit follows the operator's kph/mph choice, so it is drawn live
         rather than baked into the label as a standing "kph". */
      ["Speed", "Litre/Lap", "Energy/Lap"].forEach(function (s, i) {
        K.txt(s, 780, 44 + i * 74, 12, "#5a6a9a", "right");
      });
      /* the two readouts that were floating with no name on them */
      K.txt("RPM", 458, 34, 12, "#5a6a9a", "right");
      K.txt("GEAR", 190, 210, 12, "#5a6a9a", "center");
      ["LAST", "BEST", "PRED"].forEach(function (s, i) {
        K.txt(s, 330, 60 + i * 44, 12, "#5a6a9a");
      });
      /* DELTA joins this row rather than sitting under the gear: at 34px in the
         gear column it ran straight through the POS digit below it. */
      K.txt("BIAS", 40, 300, 12, "#5a6a9a");
      K.txt("POS", 180, 300, 12, "#5a6a9a");
      K.txt("CUR", 300, 300, 12, "#5a6a9a");
      K.txt("DELTA", 500, 300, 12, "#5a6a9a");
      /* bottom tile grid */
      var labels = ["TC", "CUT", "ABS", "ENERGY", "VE/LAP", "MAP", "FUEL L", "L/LAP", "LAPS", "SPD"];
      labels.forEach(function (t, i) {
        var x = 12 + (i % 5) * 156,
          y = i < 5 ? 328 : 390;
        K.box(x, y, 148, 54, { fill: "#101a33", border: "#24335e", r: 3, lw: 1 });
        K.txt(t, x + 10, y + 18, 11, "#5a6a9a");
      });
    },
    live: function (g, v, K) {
      K.val(v.speed, 780, 78, 30, OL, "right");
      K.txt(v.unit.toLowerCase(), 716, 78, 12, "#5a6a9a", "right");
      K.val(v.fuelPerLap !== null ? v.fuelPerLap.toFixed(2) : null, 780, 152, 30, OL, "right");
      K.val(v.vePerLap !== null ? v.vePerLap.toFixed(1) : null, 780, 226, 30, OL, "right");
      K.val(v.gear, 190, 180, 130, "#cfd4e2");
      K.val(v.rpm, 470, 34, 42, OL, "left");
      K.val(v.last, 410, 64, 26, "#e6ebf5", "left");
      K.val(v.best, 410, 108, 26, "#8a7ddb", "left");
      K.val(v.pred, 410, 152, 26, "#d99a3b", "left");
      K.val(v.bias, 40, 288, 32, "#e05a6a", "left");
      K.val(v.pos, 180, 288, 32, "#cfd4e2", "left");
      K.val(v.current, 300, 288, 32, "#e6ebf5", "left");
      K.val(v.deltaStr, 500, 288, 32, v.delta !== null && v.delta < 0 ? "#8fd44a" : "#e6ebf5", "left");
      var cells = [
        v.tc && v.tc.value, v.tcCut && v.tcCut.value, v.abs && v.abs.value,
        v.vePct !== null ? Math.round(v.vePct) : null,
        v.vePerLap !== null ? v.vePerLap.toFixed(1) : null,
        v.map && v.map.value,
        v.fuelL !== null ? v.fuelL.toFixed(0) : null,
        v.fuelPerLap !== null ? v.fuelPerLap.toFixed(2) : null,
        v.fuelLaps !== null ? v.fuelLaps.toFixed(0) : null,
        v.speed,
      ];
      cells.forEach(function (c, i) {
        var x = 12 + (i % 5) * 156,
          y = i < 5 ? 328 : 390;
        K.val(c, x + 138, y + 42, 22, OL, "right");
      });
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  5 · Ferrari 296 GT3 — red flank panels, numbered rev strip            */
  /* ---------------------------------------------------------------------- */

  var RED = "#c9202c";
  var f296 = canvasDesign({
    bake: function (g, K) {
      K.box(0, 0, DW, DH, { fill: "#000" });
      K.txt("2 9 6  G T 3", 14, 26, 14, "#8a94a0", "left", 700);
      K.txt("RPM", 236, 26, 12, "#9aa5b0", "right");
      K.box(636, 8, 74, 48, { fill: "#14161a", border: "#3a3f46", r: 4 });
      K.txt("BBAL", 673, 26, 12, "#9aa5b0", "center");
      K.box(718, 8, 72, 48, { fill: "#cfd4da", r: 4 });
      /* The limiter lamp. Unlabelled, its "—" (limiter off) read as a readout
         that had failed rather than one saying no. */
      K.txt("LIM", 754, 26, 12, "#3a3f46", "center");
      /* flank panels */
      K.box(10, 78, 210, 150, { fill: RED, border: "#7d141c", lw: 4, r: 8 });
      K.txt("GEAR", 115, 100, 14, "#ffd0d4", "center", 700);
      K.box(580, 78, 210, 150, { fill: "#1d69b4", border: "#123c66", lw: 4, r: 8 });
      K.txt("SPEED", 685, 100, 14, "#d8ecff", "center", 700);
      /* centre mix/laps box */
      K.box(250, 86, 300, 134, { fill: "#0e2a4a", border: "#2b6fd4", lw: 3, r: 8 });
      K.txt("LAP", 400, 110, 14, "#cfe3ff", "center", 700);
      /* bottom tiles */
      K.tile("THR %", 10, 250, 92, 76, { ls: 13, lh: 18 });
      K.tile("ENG", 112, 250, 92, 76, { ls: 13, lh: 18 });
      K.tile("ABS", 214, 250, 92, 76, { ls: 13, lh: 18 });
      [["LAP", 330], ["PRED", 434]].forEach(function (t) {
        K.box(t[1], 250, 96, 76, { fill: "#e2c53b", r: 4 });
        K.txt(t[0], t[1] + 48, 270, 13, "#000", "center", 700);
      });
      [["TC3", 560], ["TC2", 640], ["TC1", 720]].forEach(function (t) {
        K.tile(t[0], t[1], 250, 70, 76, { ls: 13, lh: 18 });
      });
      K.box(10, 344, 250, 90, { fill: "#101114", border: "#3a3f46", r: 4 });
      K.txt("PREV LAP", 135, 366, 13, "#9aa5b0", "center", 700);
      K.box(275, 344, 250, 90, { fill: "#0f3d1e", border: "#2b9c50", lw: 3, r: 4 });
      K.txt("DIFF", 400, 366, 13, "#a8e2bb", "center", 700);
      K.box(540, 344, 250, 90, { fill: "#101114", border: "#3a3f46", r: 4 });
      K.txt("PREDICTED LAP", 665, 366, 13, "#9aa5b0", "center", 700);
    },
    live: function (g, v, K) {
      revStrip(g, K, 250, 12, 330, 20, 22, v.revFrac, function (f, lit) {
        return lit ? (f > 0.78 ? RED : "#e0e4e8") : "#26292e";
      });
      K.val(v.bias, 673, 50, 18, "#fff");
      K.val(v.limiter ? "PIT" : "—", 754, 44, 24, "#000");
      K.val(v.gear, 115, 200, 92, "#fff");
      K.val(v.speed, 685, 200, 74, "#fff");
      K.val(v.current, 400, 190, 44, "#fff");
      /* Was a hard-coded 1 — the one invented reading on any plate. The pedal
         map is not on the feed; live throttle is, and it is the number a driver
         actually reads off that corner of the 296's screen. */
      K.val(v.throttle, 56, 316, 34, "#fff");
      K.val(v.map ? v.map.value : null, 158, 316, 34, "#fff");
      K.val(v.abs ? v.abs.value : null, 260, 316, 34, "#fff");
      K.val(v.laps >= 0 ? v.laps : null, 378, 314, 30, "#000");
      K.val(v.pred, 482, 310, 17, "#000");
      K.val(v.tcCut ? v.tcCut.value : null, 595, 316, 34, "#fff");
      K.val(v.tc ? v.tc.value : null, 675, 316, 34, "#fff");
      K.val(v.tcSlip ? v.tcSlip.value : null, 755, 316, 34, "#fff");
      K.val(v.last, 135, 420, 34, "#fff");
      K.val(v.deltaStr, 400, 420, 34, v.delta !== null && v.delta < 0 ? "#8fd44a" : "#fff");
      K.val(v.pred, 665, 420, 34, "#fff");
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  6 · Ford Mustang GT3 — white plate, navy ellipse gear                 */
  /* ---------------------------------------------------------------------- */

  var mstg = canvasDesign({
    bake: function (g, K) {
      K.box(0, 0, DW, DH, { fill: "#e9eaec" });
      /* The name moves out of the top centre — the speed readout sits there and
         the two were drawn over each other. */
      K.txt("M U S T A N G  G T 3", 16, 26, 11, "#8a8e96", "left", 700);
      K.txt("Speed", 356, 26, 13, "#26282c", "right", 700);
      /* "Energy +/-" named a per-lap delta the feed does not carry; the value
         under it has always been the remaining stint allowance. */
      var Ls = ["Energy /Lap", "Energy Remain", "Fuel /Lap", "Fuel Remain"];
      Ls.forEach(function (s, i) {
        K.txt(s, 16, 46 + i * 62, 16, "#26282c", "left", 700);
        K.box(16, 78 + i * 62, 200, 2, { fill: "#2b6fd4" });
      });
      var Rs = ["Last Lap", "Delta", "Predicted", "Best"];
      Rs.forEach(function (s, i) {
        K.txt(s, 784, 46 + i * 62, 16, "#26282c", "right", 700);
        K.box(584, 78 + i * 62, 200, 2, { fill: "#2b6fd4" });
      });
      /* the ellipse */
      g.save();
      g.translate(400, 120);
      g.scale(1.45, 1);
      g.beginPath();
      g.arc(0, 0, 78, 0, 7);
      g.restore();
      g.save();
      g.globalAlpha = K.pa;
      g.fillStyle = "#1d2a4d";
      g.fill();
      g.restore();
      K.txt("Bias", 336, 262, 17, "#26282c", "left", 700);
      /* Tyre temps, tyre pressures, then the DISCS behind them — the right-hand
         trio repeated the left one channel for channel before this. */
      [["p_Tyre", 260], ["t_Brake", 545]].forEach(function (t) {
        K.txt(t[0], t[1] + 90, 292, 15, "#26282c", "center", 700);
        K.box(t[1] + 88, 300, 2, 62, { fill: "#26282c" });
      });
      K.txt("t_Tyre", 16, 292, 15, "#26282c", "left", 700);
      /* bottom cells */
      /* "PAS" (the steering assist map) is not on this feed and never could be,
         so the cell reads the other pedal instead of standing empty. */
      var cells = [["Map", "#5a5e66"], ["Throttle", "#d97a2b"], ["TC", "#7a7e86"], ["TC LON", "#2b3fe2"], ["TC LAT", "#123c8f"], ["ABS", "#e2d52b"], ["Brake", "#b0b4bc"], ["Lap", "#26282c"]];
      cells.forEach(function (c, i) {
        var x = 16 + i * 97;
        K.box(x, 384, 88, 54, { fill: "#fff", border: c[1], lw: 3, r: 6 });
        K.txt(c[0], x + 44, 402, 12, c[1], "center", 700);
      });
    },
    live: function (g, v, K) {
      K.val(v.speed, 400, 26, 26, "#26282c");
      K.txt(v.unit.toLowerCase(), 432, 26, 12, "#8a8e96", "left");
      K.val(v.vePerLap !== null ? v.vePerLap.toFixed(2) : null, 16, 72, 24, "#26282c", "left");
      K.val(v.vePct !== null ? Math.round(v.vePct) : null, 16, 134, 24, "#26282c", "left");
      K.val(v.fuelPerLap !== null ? v.fuelPerLap.toFixed(1) : null, 16, 196, 24, "#26282c", "left");
      K.val(v.fuelL !== null ? v.fuelL.toFixed(1) : null, 16, 258, 24, "#26282c", "left");
      K.val(v.last, 784, 72, 24, "#26282c", "right");
      K.val(v.deltaStr, 784, 134, 24, v.delta !== null && v.delta < 0 ? "#2b9c50" : "#26282c", "right");
      K.val(v.pred, 784, 196, 24, "#26282c", "right");
      K.val(v.best, 784, 258, 24, "#26282c", "right");
      K.val(v.gear, 400, 152, 96, "#fff");
      K.val(v.bias, 420, 262, 24, "#26282c", "left");
      /* tyre temp | pressure | temp trios */
      function pair(x, a, b) {
        K.val(a, x, 328, 22, "#26282c");
        K.val(b, x, 358, 22, "#26282c");
      }
      pair(60, v.fl.t, v.rl.t);
      pair(140, v.fr.t, v.rr.t);
      pair(305, v.fl.p != null ? Math.round(v.fl.p) : null, v.rl.p != null ? Math.round(v.rl.p) : null);
      pair(395, v.fr.p != null ? Math.round(v.fr.p) : null, v.rr.p != null ? Math.round(v.rr.p) : null);
      pair(590, v.fl.b, v.rl.b);
      pair(680, v.fr.b, v.rr.b);
      /* Aids where the wheel has a setting, live pedal channels where it does
         not. Four of these eight used to be forced to null in the loop below —
         a cell that could not have shown a number whatever the car was doing. */
      var cv = [
        v.map ? v.map.value : null,
        v.throttle,
        v.tc ? v.tc.value : null,
        v.tcCut ? v.tcCut.value : null,
        v.tcSlip ? v.tcSlip.value : null,
        v.abs ? v.abs.value : null,
        v.brakePct,
        v.laps >= 0 ? v.laps : null,
      ];
      cv.forEach(function (t, i) {
        K.val(t, 16 + i * 97 + 44, 430, 22, "#26282c");
      });
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  7 · Lamborghini Huracán GT3 EVO2 — tile row, green tyre boxes         */
  /* ---------------------------------------------------------------------- */

  var GRN = "#2fbf3f";
  var lambo = canvasDesign({
    bake: function (g, K) {
      K.box(0, 0, DW, DH, { fill: "#000" });
      /* The donor's tile row is wheel SETTINGS, three of which (engine brake,
         grip level, the lateral TC map) this feed has no channel for at all.
         Same row of eight, reading the live channels it does carry — a tile
         with nothing behind it can only ever say "—", which is the house rule
         at the top of this file arguing against drawing it. */
      var tiles = [["LAT", "#fff"], ["MAP", "#2b3fe2"], ["TC", "#8a5adb"], ["ABS", "#d97a2b"], ["CUT", "#3dc94f"], ["THR", "#fff"], ["SLIP", "#c9313c"], ["BRK", "#d97a2b"]];
      tiles.forEach(function (t, i) {
        K.tile(t[0], 10 + i * 99, 8, 90, 62, { border: t[1], ls: 13, lh: 18 });
      });
      K.box(10, 84, 230, 56, { fill: "#0c0e10", border: "#3a3f46", r: 3 });
      K.txt("last laptime", 125, 102, 13, "#9aa5b0", "center");
      K.box(300, 84, 200, 44, { fill: "#e9eaec", r: 3 });
      K.txt("speed", 294, 112, 12, "#9aa5b0", "right");
      K.box(560, 84, 230, 56, { fill: "#0c0e10", border: "#3a3f46", r: 3 });
      K.txt("Gain/Loss", 675, 102, 13, "#9aa5b0", "center");
      /* gear box + green tyre tiles */
      K.box(300, 150, 200, 200, { fill: "#050607", border: "#e9eaec", lw: 2, r: 3 });
      K.txt("Gear", 400, 170, 13, "#c9ced4", "center");
      [[14, 156], [14, 226], [636, 156], [636, 226]].forEach(function (p2) {
        K.box(p2[0], p2[1], 150, 62, { fill: GRN, r: 3 });
      });
      [[180, 176], [180, 236], [560, 176], [560, 236]].forEach(function (p2) {
        K.box(p2[0], p2[1], 66, 44, { fill: GRN, r: 3 });
      });
      /* bottom row */
      [["BBal", 10, 150], ["fuel total", 170, 150], ["rpm", 330, 180], ["track", 520, 120], ["v_nrg", 650, 140]].forEach(
        function (b) {
          K.box(b[1], 366, b[2], 70, { fill: "#0c0e10", border: "#3a3f46", r: 3 });
          K.txt(b[0], b[1] + b[2] / 2, 384, 13, b[0] === "fuel total" ? GRN : "#9aa5b0", "center");
        },
      );
      K.txt("H U R A C A N  G T 3  E V O 2", DW / 2, 448, 10, "#5a6470", "center", 700);
    },
    live: function (g, v, K) {
      var tv = [
        v.latG !== null ? v.latG.toFixed(1) : null,
        v.map ? v.map.value : null,
        v.tc ? v.tc.value : null,
        v.abs ? v.abs.value : null,
        v.tcCut ? v.tcCut.value : null,
        v.throttle,
        v.tcSlip ? v.tcSlip.value : null,
        v.brakePct,
      ];
      tv.forEach(function (t, i) {
        K.val(t, 55 + i * 99, 60, 28, "#fff");
      });
      K.val(v.last, 125, 130, 26, "#fff");
      K.val(v.speed, 400, 118, 30, "#111");
      K.val(v.deltaStr, 675, 130, 26, "#fff");
      K.val(v.gear, 400, 310, 130, "#fff");
      /* tyre temps big, pressures small */
      K.val(v.fl.t, 89, 202, 34, "#0a2410");
      K.val(v.rl.t, 89, 272, 34, "#0a2410");
      K.val(v.fr.t, 711, 202, 34, "#0a2410");
      K.val(v.rr.t, 711, 272, 34, "#0a2410");
      K.val(v.fl.p != null ? Math.round(v.fl.p) : null, 213, 206, 22, "#0a2410");
      K.val(v.rl.p != null ? Math.round(v.rl.p) : null, 213, 266, 22, "#0a2410");
      K.val(v.fr.p != null ? Math.round(v.fr.p) : null, 593, 206, 22, "#0a2410");
      K.val(v.rr.p != null ? Math.round(v.rr.p) : null, 593, 266, 22, "#0a2410");
      K.val(v.bias, 85, 424, 28, "#fff");
      K.val(v.fuelL !== null ? v.fuelL.toFixed(1) : null, 245, 424, 28, GRN);
      K.val(v.rpm, 420, 424, 32, "#fff");
      K.val(v.trackT, 580, 424, 28, "#fff");
      K.val(v.vePct !== null ? Math.round(v.vePct) : null, 720, 424, 28, "#fff");
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  8 · Lexus RC F GT3 — the rainbow rev band                             */
  /* ---------------------------------------------------------------------- */

  var rcf = canvasDesign({
    bake: function (g, K) {
      K.box(0, 0, DW, DH, { fill: "#000" });
      var NV = "#16224a",
        BD = "#3a4a7e";
      K.box(10, 96, 200, 88, { fill: "#1d2a6e", r: 4 }); /* speed */
      K.txt("Speed", 20, 114, 13, "#c9d2ea");
      K.box(226, 96, 300, 42, { fill: "#050810", border: "#c9d2ea", r: 4, lw: 1 });
      K.txt("Current", 234, 114, 11, "#8a97b8");
      K.box(226, 142, 300, 42, { fill: "#050810", border: "#c9d2ea", r: 4, lw: 1 });
      K.txt("Predicted", 234, 160, 11, "#8a97b8");
      K.box(542, 96, 248, 42, { fill: NV, r: 4 });
      K.txt("Fuel Level", 552, 114, 12, "#c9d2ea");
      K.box(542, 142, 248, 42, { fill: NV, r: 4 });
      K.txt("Brk", 552, 160, 12, "#c9d2ea");
      /* tyres both sides */
      [[10, 196], [10, 244], [542, 196], [542, 244]].forEach(function (p2, i) {
        K.box(p2[0], p2[1], 118, 42, { fill: NV, r: 4 });
        K.box(p2[0] + 126, p2[1], 118, 42, { fill: NV, r: 4 });
      });
      /* gear box */
      K.box(310, 196, 180, 172, { fill: "#050810", border: "#c9d2ea", r: 6, lw: 2 });
      K.txt("gear", 400, 360, 11, "#8a97b8", "center");
      /* aids */
      ["ABS", "TC", "TCC", "TCS", "MAP"].forEach(function (a, i) {
        var colors = ["#2b9c50", "#c9313c", "#57c8d8", "#e2d52b", "#fff"];
        K.txt(a, 566 + i * 46, 306, 12, "#c9d2ea", "center", 700);
        K.box(544 + i * 46, 314, 42, 38, { fill: "#000", border: colors[i], lw: 2, r: 3 });
      });
      K.box(10, 396, 300, 42, { fill: NV, r: 4 });
      K.txt("Virtual Energy", 66, 422, 14, "#c9d2ea");
      K.box(330, 396, 140, 42, { fill: "#050810", border: BD, r: 4, lw: 1 });
      K.txt("R C  F  G T 3", 660, 424, 12, "#5a6a9a", "center", 700);
    },
    live: function (g, v, K) {
      /* the rainbow band */
      var grd = g.createLinearGradient(20, 0, 700, 0);
      grd.addColorStop(0, "#3a3adb");
      grd.addColorStop(0.25, "#2fbf3f");
      grd.addColorStop(0.6, "#3dc94f");
      grd.addColorStop(0.85, "#e2c53b");
      grd.addColorStop(1, "#c9313c");
      g.save();
      g.beginPath();
      g.moveTo(6, 78);
      g.quadraticCurveTo(400, -30, 794, 78);
      g.lineTo(794 - (1 - Math.max(0.02, v.revFrac)) * 788, 78);
      g.closePath();
      g.clip();
      g.fillStyle = grd;
      g.fillRect(6, 0, 788 * Math.max(0.02, v.revFrac), 78);
      g.restore();
      /* The band spans 0..maxRpm, so its ladder has to as well. A fixed
         1000–7000 printed under it mislabelled every car whose limiter is not
         at 8000, which is most of them. */
      for (var i = 1; i <= 7; i++) {
        var tick = v.maxRpm === null ? null : Math.round((v.maxRpm * i) / 8 / 100) * 100;
        K.txt(tick, 6 + i * 98, 90, 10, "#8a97b8", "center");
      }
      K.val(v.speed, 110, 168, 52, "#fff");
      K.val(v.current, 460, 128, 24, "#fff", "right");
      K.val(v.pred, 460, 174, 24, "#fff", "right");
      K.val(v.fuelL !== null ? v.fuelL.toFixed(1) : null, 740, 128, 24, "#fff", "right");
      K.val(v.bias, 740, 174, 24, "#fff", "right");
      function tp(x, y, c) {
        K.val(c.p != null ? Math.round(c.p) : null, x + 48, y + 30, 20, "#fff");
        K.txt("kPa", x + 96, y + 28, 10, "#8a97b8");
        K.val(c.t, x + 174, y + 30, 20, "#fff");
        K.txt(v.tempUnit, x + 222, y + 28, 10, "#8a97b8");
      }
      tp(10, 196, v.fl);
      tp(10, 244, v.rl);
      tp(542, 196, v.fr);
      tp(542, 244, v.rr);
      K.val(v.gear, 400, 330, 110, "#fff");
      /* TCC and TCS are the cut and the slip — both boxes were drawn, labelled
         and left reading nothing. */
      [v.abs, v.tc, v.tcCut, v.tcSlip, v.map].forEach(function (a, i) {
        K.val(a ? a.value : null, 565 + i * 46, 342, 22, "#fff");
      });
      K.val(v.vePct !== null ? Math.round(v.vePct) + " %" : null, 240, 426, 24, "#fff");
      K.val(v.rpm, 400, 426, 24, "#fff");
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  9 · McLaren 720S GT3 — minimal black + amber                          */
  /* ---------------------------------------------------------------------- */

  var PAP = "#e8a13c";
  var m720 = canvasDesign({
    bake: function (g, K) {
      K.box(0, 0, DW, DH, { fill: "#000" });
      K.txt("7 2 0 S  G T 3", 786, 32, 20, "#e9eaec", "right", 700);
      K.txt("M c L A R E N", 14, 32, 20, "#e9eaec", "left", 700);
      K.txt("FUEL", 700, 100, 18, "#fff", "center", 700);
      /* The value under this has always been the lap in progress; there is no
         pitlane timer on the feed, so the label says what is actually there. */
      K.txt("CURRENT LAP", 700, 300, 16, "#fff", "center", 700);
      K.txt("BRAKE BALANCE F", 110, 300, 16, "#fff", "center", 700);
      K.txt("OVERALL BEST", 400, 356, 16, PAP, "center", 700);
    },
    live: function (g, v, K) {
      K.val(v.deltaStr, 400, 66, 40, "#2b6fd4");
      K.val(v.gear, 400, 300, 190, "#fff");
      /* start-procedure list is a real-car page; this feed shows state lines */
      var lines = [
        [v.limiter ? "LIMITER ON" : "LIMITER OFF", v.limiter ? "#3dc94f" : "#8a8e96"],
        ["TC   " + (v.tc ? v.tc.value : "—"), PAP],
        ["SLIP " + (v.tcSlip ? v.tcSlip.value : "—"), PAP],
        ["CUT  " + (v.tcCut ? v.tcCut.value : "—"), PAP],
        ["ABS  " + (v.abs ? v.abs.value : "—"), PAP],
        ["MAP  " + (v.map ? v.map.value : "—"), "#fff"],
      ];
      /* Six lines in the room four used to take, so the stack still clears the
         speed readout at y 244. */
      lines.forEach(function (l, i) {
        K.txt(l[0], 110, 88 + i * 26, 16, l[1], "center", 700);
      });
      K.val(v.speed !== null ? v.speed + " " + v.unit : null, 110, 244, 22, PAP);
      K.val(v.bias, 110, 330, 26, "#fff");
      K.val(v.fuelL !== null ? v.fuelL.toFixed(1) : null, 700, 132, 26, "#fff");
      K.val(v.fuelLaps !== null ? "≈" + v.fuelLaps.toFixed(1) + " LAPS" : null, 700, 244, 20, PAP);
      K.val(v.current, 700, 330, 26, "#fff");
      K.val(v.best, 400, 400, 34, "#fff");
      K.val(v.last !== null ? "LAST  " + v.last : null, 400, 430, 16, "#8a94a0");
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  10 · Mercedes-AMG GT3 — gear scale + thin boxes                       */
  /* ---------------------------------------------------------------------- */

  var amg = canvasDesign({
    bake: function (g, K) {
      K.box(0, 0, DW, DH, { fill: "#050608" });
      for (var i = 0; i <= 8; i++) {
        K.txt(String(i), 120 + i * 70, 26, 16, "#e9eaec", "center", 700);
        K.box(119 + i * 70, 32, 2, 12, { fill: "#8a8e96" });
      }
      function mt(label, x, y, w, h) {
        K.box(x, y, w, h, { fill: "#0a0c12", border: "#8a94b0", lw: 2, r: 2 });
        K.txt(label, x + w / 2, y + 18, 13, "#c9d2ea", "center");
      }
      mt("TRACK", 100, 72, 86, 74);
      mt("AIR", 196, 72, 86, 74);
      K.box(306, 72, 160, 74, { fill: "#0a0c12", border: "#c9313c", lw: 3, r: 2 });
      K.txt("LaptimeDiff", 386, 90, 13, "#e05a6a", "center");
      mt("Speed", 500, 72, 190, 74);
      mt("Energy", 100, 166, 180, 74);
      mt("Lap Time", 100, 260, 180, 74);
      K.box(306, 166, 160, 190, { fill: "#0a0c12", border: "#8a94b0", lw: 2, r: 2 });
      K.txt("Gear", 386, 184, 13, "#c9d2ea", "center");
      ["ABS", "TC", "MAP"].forEach(function (a, i) {
        var col = ["#e2d52b", "#57a8d8", "#c9313c"][i];
        K.txt(a, 526 + i * 58, 184, 12, "#c9d2ea", "center", 700);
        K.box(500 + i * 58, 192, 52, 60, { fill: "#0a0c12", border: col, lw: 2, r: 2 });
      });
      ["TCC", "TCS"].forEach(function (a, i) {
        var col = ["#2b9c50", "#8a94b0"][i];
        K.txt(a, 526 + i * 90, 274, 12, "#c9d2ea", "center", 700);
        K.box(490 + i * 90, 282, 84, 60, { fill: "#0a0c12", border: col, lw: 2, r: 2 });
      });
      K.box(100, 380, 590, 30, { fill: "#0a0c12", border: "#8a94b0", lw: 1 });
      K.txt("A M G  G T 3", 395, 436, 11, "#5a6470", "center", 700);
    },
    live: function (g, v, K) {
      /* the gear bar: filled to the current gear */
      var gearN = typeof v.gear === "string" && /^\d$/.test(v.gear) ? parseInt(v.gear, 10) : 0;
      K.box(120, 34, Math.max(0.02, gearN / 8) * 560, 10, { fill: "#2b8fe2", data: true });
      K.val(v.trackT, 143, 132, 28, "#fff");
      K.val(v.airT, 239, 132, 28, "#fff");
      K.val(v.deltaStr, 386, 134, 30, "#e05a6a");
      K.val(v.speed, 595, 134, 34, "#fff");
      K.val(v.vePct !== null ? v.vePct.toFixed(1) : null, 190, 226, 30, "#fff");
      K.val(v.current, 190, 320, 26, "#fff");
      K.val(v.gear, 386, 330, 120, "#fff");
      [v.abs, v.tc, v.map].forEach(function (a, i) {
        K.val(a ? a.value : null, 526 + i * 58, 236, 28, "#fff");
      });
      K.val(v.tcCut ? v.tcCut.value : null, 532, 326, 24, "#fff");
      K.val(v.tcSlip ? v.tcSlip.value : null, 622, 326, 24, "#fff");
      K.txt(v.deltaStr == null ? "—" : v.deltaStr, 160, 401, 14, "#3dc94f", "center", 700);
      K.txt(v.pos !== null ? "POS  " + v.pos : "—", 395, 401, 14, "#fff", "center", 700);
      K.txt(v.last == null ? "—" : v.last, 620, 401, 14, "#c9d2ea", "center", 700);
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  Registration                                                          */
  /* ---------------------------------------------------------------------- */

  /* The kit, for speedo-real.js and the headless test. */
  window.ApexDashKit = {
    DESIGN: { w: DW, h: DH },
    canvasDesign: canvasDesign,
    pull: pull,
    findAid: findAid,
    biasText: biasText,
  };

  window.ApexSpeedoDesigns = window.ApexSpeedoDesigns || {};
  window.ApexSpeedoDesigns.p911 = p911;
  window.ApexSpeedoDesigns.aston = aston;
  window.ApexSpeedoDesigns.m4 = m4;
  window.ApexSpeedoDesigns.z06 = z06;
  window.ApexSpeedoDesigns.f296 = f296;
  window.ApexSpeedoDesigns.mstg = mstg;
  window.ApexSpeedoDesigns.lambo = lambo;
  window.ApexSpeedoDesigns.rcf = rcf;
  window.ApexSpeedoDesigns.m720 = m720;
  window.ApexSpeedoDesigns.amg = amg;
})();
