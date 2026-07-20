/**
 * widgets/motion.js — G-force, rotation and attitude, as three toggleable modes.
 * -----------------------------------------------------------------------------
 * Renders `frame.player.motion` (see src/telemetry/motion.ts, which owns every
 * sign convention — nothing here reasons about the sim's axes). Three modes,
 * each independently switchable from the Browser Source URL:
 *
 *   ?g=on|off     G-METER   — a dot in a traction circle, with a fading trail
 *                             and a peak ring. Lateral across, longitudinal up.
 *   ?rot=on|off   ROTATION  — yaw rate against slip angle, the pair that says
 *                             whether the car is turning as much as it is
 *                             pointed, i.e. understeer vs oversteer.
 *   ?att=on|off   ATTITUDE  — pitch and roll, as a horizon that tilts and
 *                             slides under a fixed car reference.
 *
 * All three default ON. Any mode can be dropped to keep the widget small, and
 * turning all three off renders nothing rather than an empty frame.
 *
 * Why three modes in one widget rather than three widgets: they share a single
 * telemetry object and a single canvas, and a streamer positioning overlays in
 * OBS is placing boxes, not channels. One box that can be trimmed to the wanted
 * channels is less work to lay out than three that must be aligned.
 *
 * Runs at full broadcast rate (throttleMs 0).
 */
(function () {
  "use strict";

  /** Trail length for the G dot, in samples (~1.5s at 30 Hz). */
  var TRAIL = 45;
  var trailLat = new Float32Array(TRAIL);
  var trailLon = new Float32Array(TRAIL);
  var head = 0;
  var count = 0;

  /**
   * Full-scale of the traction circle, in g. Fixed rather than auto-scaling:
   * an axis that rescales itself makes two corners incomparable, and the whole
   * value of a G-meter on stream is that a big circle always means a big
   * corner. 3 g covers a Hypercar with headroom; anything beyond is clamped to
   * the rim and flagged by the peak ring instead.
   */
  var G_SCALE = 3;

  /** Peak |G| seen recently, for the reference ring. Decays so an old lock-up
   * doesn't pin the ring for the rest of the stint. */
  var peakG = 0;
  var PEAK_DECAY = 0.995;

  /** Slip angle beyond which the balance chip calls it, in degrees. */
  var SLIP_CALL_DEG = 4;

  /** localStorage key for the operator's chosen opacity. */
  var OPACITY_KEY = "apex-motion-opacity";
  /**
   * Floor for the slider. Below ~15% the widget is invisible rather than
   * translucent, and since the slider only appears on hover you would have to
   * find a widget you cannot see to get it back.
   */
  var MIN_OPACITY = 0.15;

  var modeG = true, modeRot = true, modeAtt = true;
  var canvas, gctx, dpr = 1;
  var cssW = 0, cssH = 0;
  var headerMeta;
  var elBalance, elSlip, elYaw, elPitch, elRoll, elLat, elLon, elVert;
  var cache = {};

  /** Per-mode pane heights (CSS px). The canvas is sized to the sum of the
   * enabled ones, so a disabled mode costs no space at all. */
  var H_G = 132;
  var H_ROT = 46;
  var H_ATT = 74;

  function paneHeights() {
    return {
      g: modeG ? H_G : 0,
      rot: modeRot ? H_ROT : 0,
      att: modeAtt ? H_ATT : 0,
    };
  }

  function totalHeight() {
    var h = paneHeights();
    return h.g + h.rot + h.att;
  }

  function push(lat, lon) {
    trailLat[head] = lat;
    trailLon[head] = lon;
    head = (head + 1) % TRAIL;
    if (count < TRAIL) count++;
  }

  function sizeCanvas() {
    if (!canvas) return;
    cssW = canvas.clientWidth || 240;
    cssH = totalHeight();
    canvas.style.height = cssH + "px";
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    if (gctx) gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** A labelled numeric cell in the readout strip under the canvas. */
  function makeStat(parent, label) {
    var cell = document.createElement("div");
    cell.className = "motion__stat";
    var lab = document.createElement("span");
    lab.className = "motion__stat-label";
    lab.textContent = label;
    var val = document.createElement("span");
    val.className = "motion__stat-val";
    val.textContent = "—";
    cell.appendChild(lab);
    cell.appendChild(val);
    parent.appendChild(cell);
    return val;
  }

  /**
   * Hover-revealed opacity slider, so the widget can sit over the track as a
   * see-through practice HUD.
   *
   * Two details that are easy to get wrong:
   *
   * 1. The fade is applied to the panel's CONTENTS, not to the section, and the
   *    slider is a sibling of those contents. CSS opacity on a parent cannot be
   *    undone by a child, so a slider inside a faded box would fade with it —
   *    at 20% you would be hunting for a control you cannot see.
   * 2. Below full opacity the panel chrome (background, border) is dropped
   *    entirely rather than faded. A translucent dark box over a track still
   *    reads as a box; removing it is what actually makes this a HUD.
   *
   * The value persists to localStorage, and `?opacity=0..1` overrides it — the
   * URL is the only route that works in OBS and in the locked in-game layer,
   * where the pointer never reaches the widget and hover can never fire.
   */
  function buildOpacityControl(root, params) {
    var applyOpacity = function (v) {
      root.style.setProperty("--motion-op", String(v));
      // Chrome off below 1, so the widget stops looking like a panel.
      root.setAttribute("data-transparent", v < 1 ? "true" : "false");
    };

    var stored = null;
    try {
      var raw = localStorage.getItem(OPACITY_KEY);
      if (raw !== null && isFinite(parseFloat(raw))) stored = parseFloat(raw);
    } catch (e) {
      /* private mode — the slider still works, it just won't persist */
    }
    var fromUrl = parseFloat(params.get("opacity"));
    var initial = isFinite(fromUrl) ? fromUrl : stored !== null ? stored : 1;
    initial = Math.min(1, Math.max(MIN_OPACITY, initial));

    var bar = document.createElement("div");
    bar.className = "motion__opacity";

    var label = document.createElement("span");
    label.className = "motion__opacity-label";
    label.textContent = "OPACITY";

    var slider = document.createElement("input");
    slider.className = "motion__opacity-range";
    slider.type = "range";
    slider.min = String(Math.round(MIN_OPACITY * 100));
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(initial * 100));

    var readout = document.createElement("span");
    readout.className = "motion__opacity-val";
    readout.textContent = slider.value + "%";

    slider.addEventListener("input", function () {
      var v = Math.min(1, Math.max(MIN_OPACITY, Number(slider.value) / 100));
      applyOpacity(v);
      readout.textContent = Math.round(v * 100) + "%";
      try {
        localStorage.setItem(OPACITY_KEY, String(v));
      } catch (e) {
        /* ignore */
      }
    });

    // The in-game layer starts a drag on pointerdown anywhere inside a widget.
    // Without this, grabbing the slider drags the whole widget across the
    // screen and never moves the handle.
    ["pointerdown", "mousedown", "touchstart"].forEach(function (evt) {
      bar.addEventListener(evt, function (e) { e.stopPropagation(); });
    });

    bar.appendChild(label);
    bar.appendChild(slider);
    bar.appendChild(readout);

    // Zero-height positioning context, appended AFTER the panel body. The
    // widget section itself can't be used as the anchor: single.css and
    // ingame.css both force `position: static !important` on .widget, so an
    // absolutely-positioned bar would escape to some outer ancestor and land
    // in the wrong place on two of the three pages. A 0px relative div costs
    // no layout and is a positioning context everywhere.
    var anchor = document.createElement("div");
    anchor.className = "motion__opacity-anchor";
    anchor.appendChild(bar);
    root.appendChild(anchor);
    applyOpacity(initial);
  }

  function init(root, ctx) {
    headerMeta = root.querySelector('[data-role="meta"]');
    var mount = root.querySelector('[data-role="mount"]');
    mount.innerHTML = "";

    // Mode switches. Absent param = on, so the default URL shows everything and
    // a mode is removed by explicitly asking for it to go.
    var params = new URLSearchParams(window.location.search);
    var off = function (name) {
      var v = (params.get(name) || "").toLowerCase();
      return v === "off" || v === "0" || v === "false";
    };
    modeG = !off("g");
    modeRot = !off("rot");
    modeAtt = !off("att");

    // Built before the all-modes-off bail-out, so the slider is still reachable
    // on a widget that is deliberately showing nothing.
    buildOpacityControl(root, params);

    if (!modeG && !modeRot && !modeAtt) {
      // Every mode switched off. Say so, rather than rendering an empty panel
      // that reads as a widget that failed to load.
      mount.innerHTML =
        '<div class="placeholder">All motion modes are off ' +
        "(?g / ?rot / ?att)</div>";
      canvas = null;
      return;
    }

    var wrap = document.createElement("div");
    wrap.className = "motion__wrap";
    canvas = document.createElement("canvas");
    canvas.className = "motion__canvas";
    wrap.appendChild(canvas);

    var stats = document.createElement("div");
    stats.className = "motion__stats";
    if (modeG) {
      elLat = makeStat(stats, "LAT");
      elLon = makeStat(stats, "LON");
      elVert = makeStat(stats, "VERT");
    }
    if (modeRot) {
      elYaw = makeStat(stats, "YAW");
      elSlip = makeStat(stats, "SLIP");
    }
    if (modeAtt) {
      elPitch = makeStat(stats, "PITCH");
      elRoll = makeStat(stats, "ROLL");
    }
    wrap.appendChild(stats);

    if (modeRot) {
      elBalance = document.createElement("div");
      elBalance.className = "motion__balance";
      elBalance.setAttribute("data-state", "neutral");
      elBalance.textContent = "NEUTRAL";
      wrap.appendChild(elBalance);
    }

    mount.appendChild(wrap);
    gctx = canvas.getContext("2d");
    sizeCanvas();
    window.addEventListener("resize", sizeCanvas, { passive: true });
  }

  /* ------------------------------ G-METER -------------------------------- */

  /**
   * The traction circle. Lateral runs across, longitudinal up — so braking puts
   * the dot UP (the way you are thrown into the belts) and acceleration DOWN,
   * with the dot moving toward the side of the corner you are turning into.
   *
   * That is NOT the engineering g-g convention, which would put braking below
   * the origin; the sign is set in telemetry/motion.ts and was chosen from real
   * laps because the textbook version read backwards at speed. Nothing here
   * flips anything — if this ever needs changing again, change it there, or the
   * dot and the LON readout will disagree.
   *
   * The trail is what makes it readable: a bare dot shows the
   * instant, while the trail shows the path around the circle, which is where
   * you see whether brake release and turn-in were blended or stepped.
   */
  function drawGMeter(ctx2d, top, h) {
    var cx = cssW / 2;
    var cy = top + h / 2;
    var r = Math.min(h / 2 - 8, cssW / 2 - 8);

    ctx2d.save();
    // Rings at 1g intervals, plus the outer full-scale rim.
    ctx2d.strokeStyle = "#aeb6c8";
    ctx2d.lineWidth = 1;
    for (var g = 1; g <= G_SCALE; g++) {
      ctx2d.globalAlpha = g === G_SCALE ? 0.42 : 0.18;
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, (r * g) / G_SCALE, 0, Math.PI * 2);
      ctx2d.stroke();
    }
    // Cross-hairs.
    ctx2d.globalAlpha = 0.22;
    ctx2d.beginPath();
    ctx2d.moveTo(cx - r, cy);
    ctx2d.lineTo(cx + r, cy);
    ctx2d.moveTo(cx, cy - r);
    ctx2d.lineTo(cx, cy + r);
    ctx2d.stroke();
    ctx2d.restore();

    // Peak ring — how big the biggest recent corner was, held and decayed.
    if (peakG > 0.1) {
      ctx2d.save();
      ctx2d.globalAlpha = 0.5;
      ctx2d.setLineDash([3, 3]);
      ctx2d.strokeStyle = "#ffd23e";
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, Math.min(r, (r * peakG) / G_SCALE), 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.restore();
    }

    var toXY = function (lat, lon) {
      var x = cx + (lat / G_SCALE) * r;
      var y = cy - (lon / G_SCALE) * r;
      // Clamp to the rim rather than letting a big hit draw outside the circle.
      var dx = x - cx, dy = y - cy;
      var d = Math.hypot(dx, dy);
      if (d > r) {
        x = cx + (dx / d) * r;
        y = cy + (dy / d) * r;
      }
      return [x, y];
    };

    // Trail, oldest first so the newest sits on top.
    if (count > 1) {
      var start = (head - count + TRAIL) % TRAIL;
      ctx2d.beginPath();
      for (var i = 0; i < count; i++) {
        var idx = (start + i) % TRAIL;
        var p = toXY(trailLat[idx], trailLon[idx]);
        if (i === 0) ctx2d.moveTo(p[0], p[1]);
        else ctx2d.lineTo(p[0], p[1]);
      }
      ctx2d.globalAlpha = 0.45;
      ctx2d.strokeStyle = "#4f8bff";
      ctx2d.lineWidth = 1.5;
      ctx2d.stroke();
      ctx2d.globalAlpha = 1;
    }

    // Live dot.
    var now = toXY(trailLat[(head - 1 + TRAIL) % TRAIL], trailLon[(head - 1 + TRAIL) % TRAIL]);
    ctx2d.beginPath();
    ctx2d.arc(now[0], now[1], 4, 0, Math.PI * 2);
    ctx2d.fillStyle = "#dbe4ff";
    ctx2d.fill();
  }

  /* ------------------------------ ROTATION ------------------------------- */

  /**
   * Yaw rate and slip angle on one centred axis.
   *
   * These two together are the balance reading. Yaw rate is how fast the car is
   * rotating; slip angle is how far its direction of travel has fallen behind
   * where the nose points. A car that is rotating but not slipping is doing
   * what you asked. Slip that outruns the yaw is the rear leaving; yaw that
   * produces no slip while the wheel is wound on is the front giving up.
   *
   * Deliberately NOT presented as a calibrated understeer/oversteer number:
   * that needs wheelbase and steering ratio per car, which LMU does not
   * publish. Two honest channels beat one fabricated one.
   */
  function drawRotation(ctx2d, top, h, m) {
    var cx = cssW / 2;
    var padX = 8;
    var half = cssW / 2 - padX;
    var rowY = top + h / 2;

    ctx2d.save();
    // Centre reference.
    ctx2d.globalAlpha = 0.3;
    ctx2d.strokeStyle = "#aeb6c8";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(cx, top + 4);
    ctx2d.lineTo(cx, top + h - 4);
    ctx2d.stroke();
    ctx2d.restore();

    // Yaw rate bar (upper half of the pane), full scale 1 rad/s.
    var yawFrac = Math.max(-1, Math.min(1, m.yawRate / 1));
    var yawY = rowY - 7;
    ctx2d.fillStyle = "#4f8bff";
    ctx2d.fillRect(cx, yawY - 4, yawFrac * half, 8);

    // Slip angle bar (lower half), full scale 12 degrees.
    var slipVal = m.slipAngle === -1 ? 0 : m.slipAngle;
    var slipFrac = Math.max(-1, Math.min(1, slipVal / 12));
    var slipY = rowY + 8;
    ctx2d.fillStyle = Math.abs(slipVal) > SLIP_CALL_DEG ? "#ff9f1a" : "#35d07f";
    ctx2d.fillRect(cx, slipY - 4, slipFrac * half, 8);

    ctx2d.save();
    ctx2d.globalAlpha = 0.6;
    ctx2d.fillStyle = "#aeb6c8";
    ctx2d.font = "8px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx2d.textBaseline = "middle";
    ctx2d.fillText("YAW", padX, yawY);
    ctx2d.fillText("SLIP", padX, slipY);
    ctx2d.restore();
  }

  /* ------------------------------ ATTITUDE ------------------------------- */

  /**
   * Pitch and roll as a horizon that tilts (roll) and slides (pitch) behind a
   * fixed car reference — the aircraft convention, where the instrument moves
   * and the aeroplane does not. It is the right way round here for the same
   * reason: the driver's frame IS the car, so the world is what tilts.
   */
  function drawAttitude(ctx2d, top, h, m) {
    var cx = cssW / 2;
    var cy = top + h / 2;
    var r = Math.min(h / 2 - 4, cssW / 2 - 8);

    ctx2d.save();
    // Clip to a rounded box so the horizon can be drawn oversized and swept.
    ctx2d.beginPath();
    ctx2d.rect(cx - r * 1.6, top + 3, r * 3.2, h - 6);
    ctx2d.clip();

    // Roll tilts the horizon; pitch slides it. ~2.2 px per degree of pitch puts
    // a heavy dive/squat clearly off-centre without leaving the box.
    ctx2d.translate(cx, cy);
    ctx2d.rotate((-m.roll * Math.PI) / 180);
    var pitchPx = m.pitch * 2.2;

    // Ground below the horizon line.
    ctx2d.globalAlpha = 0.22;
    ctx2d.fillStyle = "#8a5a2b";
    ctx2d.fillRect(-r * 3, pitchPx, r * 6, r * 4);
    ctx2d.globalAlpha = 0.16;
    ctx2d.fillStyle = "#3b6ea5";
    ctx2d.fillRect(-r * 3, pitchPx - r * 4, r * 6, r * 4);

    // Horizon line + pitch ladder at 5-degree steps.
    ctx2d.globalAlpha = 0.85;
    ctx2d.strokeStyle = "#dbe4ff";
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(-r * 1.6, pitchPx);
    ctx2d.lineTo(r * 1.6, pitchPx);
    ctx2d.stroke();
    ctx2d.globalAlpha = 0.35;
    ctx2d.lineWidth = 1;
    for (var d = -10; d <= 10; d += 5) {
      if (d === 0) continue;
      var y = pitchPx + d * 2.2;
      ctx2d.beginPath();
      ctx2d.moveTo(-10, y);
      ctx2d.lineTo(10, y);
      ctx2d.stroke();
    }
    ctx2d.restore();

    // Fixed car reference on top — never moves, so the horizon reads against it.
    ctx2d.save();
    ctx2d.strokeStyle = "#ffd23e";
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(cx - 16, cy);
    ctx2d.lineTo(cx - 5, cy);
    ctx2d.moveTo(cx + 5, cy);
    ctx2d.lineTo(cx + 16, cy);
    ctx2d.moveTo(cx, cy - 3);
    ctx2d.lineTo(cx, cy + 3);
    ctx2d.stroke();
    ctx2d.restore();
  }

  function draw(m) {
    if (!gctx || cssW === 0) { sizeCanvas(); if (cssW === 0) return; }
    gctx.clearRect(0, 0, cssW, cssH);
    gctx.globalAlpha = 1;
    var h = paneHeights();
    var y = 0;
    if (modeG) { drawGMeter(gctx, y, h.g); y += h.g; }
    if (modeRot) { drawRotation(gctx, y, h.rot, m); y += h.rot; }
    if (modeAtt) { drawAttitude(gctx, y, h.att, m); }
  }

  function setText(el, key, text) {
    if (!el || cache[key] === text) return;
    cache[key] = text;
    el.textContent = text;
  }

  function signed(v, digits) {
    var s = v.toFixed(digits);
    return v > 0 ? "+" + s : s;
  }

  function update(frame, ctx) {
    if (!canvas) return; // all modes off
    var p = frame.player;
    var m = p && p.motion;
    if (!m) {
      // Spectating, or no shared memory. Say why rather than drawing zeros,
      // which would look like a car sitting perfectly still at speed.
      setText(headerMeta, "meta", "NO MOTION DATA");
      return;
    }

    push(m.latG, m.lonG);
    var mag = Math.hypot(m.latG, m.lonG);
    if (mag > peakG) peakG = mag;
    else peakG *= PEAK_DECAY;

    draw(m);

    if (modeG) {
      setText(elLat, "lat", signed(m.latG, 2) + "g");
      setText(elLon, "lon", signed(m.lonG, 2) + "g");
      setText(elVert, "vert", m.vertG.toFixed(2) + "g");
    }
    if (modeRot) {
      setText(elYaw, "yaw", signed(m.yawRate, 2));
      setText(
        elSlip,
        "slip",
        m.slipAngle === -1 ? "—" : signed(m.slipAngle, 1) + "°",
      );

      // Balance call, only when there is enough slip to mean anything. Below
      // the threshold every car looks neutral, and a chip flickering between
      // verdicts at 30 Hz on a straight is worse than no chip.
      var state = "neutral";
      var label = "NEUTRAL";
      if (m.slipAngle !== -1 && Math.abs(m.slipAngle) > SLIP_CALL_DEG) {
        // Slip and yaw in the SAME direction is the car rotating into its own
        // slide — the rear coming round. Opposed is the nose washing wide of a
        // yaw that the steering asked for.
        var sameWay = m.slipAngle * m.yawRate > 0;
        state = sameWay ? "oversteer" : "understeer";
        label = sameWay ? "OVERSTEER" : "UNDERSTEER";
      }
      if (cache.balState !== state) {
        cache.balState = state;
        elBalance.setAttribute("data-state", state);
        elBalance.textContent = label;
      }
    }
    if (modeAtt) {
      setText(elPitch, "pitch", signed(m.pitch, 1) + "°");
      setText(elRoll, "roll", signed(m.roll, 1) + "°");
    }

    setText(headerMeta, "meta", Math.round(m.speedMs * 3.6) + " kph");
  }

  window.ApexOverlay.registerWidget("motion", {
    throttleMs: 0,
    init: init,
    update: update,
  });
})();
