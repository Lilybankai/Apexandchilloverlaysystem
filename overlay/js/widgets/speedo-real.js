/**
 * widgets/speedo-real.js — the "Apex Real" cluster design: the house speedo's
 * exact silhouette, repainted as a physical instrument.
 * -----------------------------------------------------------------------------
 * Registers as design id `real` alongside `apex` and `lmp2` — the original
 * Apex cluster is untouched and stays the default. This is the design the
 * speedo-real-mock prototype proved out: graphite body lit from above, a
 * machined rim with a gasket seam and metal grain, blue rim-light on the
 * shoulders, backlit LCD wells, red shift lamps, a raised centre plate with
 * the gear ABOVE the speed, and the rev bar as light filling a machined
 * groove.
 *
 * Geometry is the live cluster's own (speedo.js's 1000×470 design box and
 * notch constants, restated here in one place and pinned by the test), so the
 * delta widget seats into the notch identically — notch-dock.js needs no
 * special case for this design because the recess is in the same place.
 *
 * Data follows the LMP2 contract: nothing is invented, every readout guards
 * its channel, and the LCDs show the GT3 staples the feed actually carries —
 * tyres, brake bias and aids on the left; laps, fuel and position on the
 * right. Built on the shared canvas kit in speedo-gt3.js (static shell baked
 * once per resize; per-frame work is digits, lamps and the lit groove).
 */
(function () {
  "use strict";

  /* The Apex silhouette, as speedo.js authors it. */
  var DW = 1000, DH = 470;
  var POD_BOT = 424, CHIN_BOT = 470, NOTCH_TOP = 52;
  var R_TOP = 74, R_BOT = 52, CH = 46;
  var NOTCH_L = 352, NOTCH_R = 648;
  var CHIN_L = 220, CHIN_R = 780;
  var WELL_L = { x: 96, y: 96, w: 286, h: 312 };
  var WELL_R = { x: 618, y: 96, w: 286, h: 312 };

  var FD = "Bahnschrift, 'Segoe UI Semibold', Arial, sans-serif";
  var FM = "Consolas, monospace";

  /* The groove the rev light fills: an inner offset of the silhouette, as a
     polyline with cumulative lengths so a fraction maps to a stroke length —
     the same trick speedo.js's buildBar plays, in miniature. */
  function buildGroove(mirror) {
    var raw = [
      [40, 404], [40, 132],
    ];
    /* corner arc, 90°, centre (132,132) r 92 */
    for (var i = 1; i <= 24; i++) {
      var a = Math.PI + (Math.PI / 2) * (i / 24);
      raw.push([132 + Math.cos(a) * 92, 132 + Math.sin(a) * 92]);
    }
    raw.push([NOTCH_L - CH - 6, 40], [NOTCH_L + 34, 92], [476, 92]);
    var pts = [], len = 0;
    for (var j = 0; j < raw.length; j++) {
      var x = mirror ? DW - raw[j][0] : raw[j][0];
      var y = raw[j][1];
      if (j > 0) {
        var dx = x - pts[j - 1].x, dy = y - pts[j - 1].y;
        len += Math.sqrt(dx * dx + dy * dy);
      }
      pts.push({ x: x, y: y, len: len });
    }
    return pts;
  }
  var GROOVES = [buildGroove(false), buildGroove(true)];

  function strokeGroove(g, pts, frac) {
    var target = pts[pts.length - 1].len * Math.max(0, Math.min(1, frac));
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) {
      if (pts[i].len >= target) {
        var prev = pts[i - 1];
        var t = (target - prev.len) / (pts[i].len - prev.len || 1);
        g.lineTo(prev.x + (pts[i].x - prev.x) * t, prev.y + (pts[i].y - prev.y) * t);
        break;
      }
      g.lineTo(pts[i].x, pts[i].y);
    }
    g.stroke();
  }

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

  function rr(g, b, r) {
    g.beginPath();
    g.moveTo(b.x + r, b.y);
    g.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + r, r);
    g.arcTo(b.x + b.w, b.y + b.h, b.x + b.w - r, b.y + b.h, r);
    g.arcTo(b.x, b.y + b.h, b.x, b.y + b.h - r, r);
    g.arcTo(b.x, b.y, b.x + r, b.y, r);
    g.closePath();
  }

  function vlin(g, y0, y1, stops) {
    var gr = g.createLinearGradient(0, y0, 0, y1);
    for (var i = 0; i < stops.length; i += 2) gr.addColorStop(stops[i], stops[i + 1]);
    return gr;
  }

  var noiseTile = null;
  function noise() {
    if (noiseTile) return noiseTile;
    var n = document.createElement("canvas");
    n.width = n.height = 128;
    var nx = n.getContext("2d");
    var img = nx.createImageData(128, 128);
    for (var i = 0; i < img.data.length; i += 4) {
      var v2 = 118 + Math.random() * 42;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v2;
      img.data[i + 3] = 255;
    }
    nx.putImageData(img, 0, 0);
    noiseTile = n;
    return n;
  }

  function bake(g, K) {
    var pa = K.pa;
    if (pa <= 0.001) return;
    g.save();
    g.globalAlpha = pa;

    /* hood shadow + body */
    g.save();
    g.shadowColor = "rgba(0,0,0,.85)";
    g.shadowBlur = 46;
    g.shadowOffsetY = 14;
    shellPath(g);
    g.fillStyle = "#0a0c0f";
    g.fill();
    g.restore();
    shellPath(g);
    g.fillStyle = vlin(g, 0, CHIN_BOT, [0, "#23272e", 0.12, "#1b1f25", 0.55, "#13161b", 1, "#0a0c0f"]);
    g.fill();

    /* machined rim + gasket, clipped inside */
    g.save();
    shellPath(g);
    g.clip();
    shellPath(g);
    g.lineWidth = 16;
    g.strokeStyle = vlin(g, 0, CHIN_BOT, [0, "#3a4048", 0.2, "#2a2f36", 0.6, "#1a1e24", 1, "#101317"]);
    g.stroke();
    shellPath(g);
    g.lineWidth = 7;
    g.strokeStyle = vlin(g, 0, CHIN_BOT, [0, "#12151a", 1, "#07090b"]);
    g.stroke();
    g.globalAlpha = pa * 0.05;
    g.globalCompositeOperation = "overlay";
    g.fillStyle = g.createPattern(noise(), "repeat");
    g.fillRect(0, 0, DW, DH);
    g.restore();

    /* edge + top light catch */
    shellPath(g);
    g.strokeStyle = "rgba(0,0,0,.9)";
    g.lineWidth = 2;
    g.stroke();
    g.save();
    shellPath(g);
    g.clip();
    shellPath(g);
    g.lineWidth = 2.5;
    g.strokeStyle = vlin(g, 0, CHIN_BOT, [0, "rgba(168,186,204,.55)", 0.18, "rgba(110,126,142,.28)", 0.5, "rgba(60,70,80,.10)", 1, "rgba(0,0,0,0)"]);
    g.stroke();
    g.restore();

    /* blue rim light on the shoulders + recess */
    g.save();
    g.globalCompositeOperation = "lighter";
    g.strokeStyle = "rgba(58,160,240,.34)";
    g.lineWidth = 3;
    g.shadowColor = "rgba(58,160,240,.85)";
    g.shadowBlur = 16;
    g.beginPath();
    g.moveTo(6, 168);
    g.lineTo(6, R_TOP);
    g.arcTo(6, 6, R_TOP, 6, R_TOP - 6);
    g.lineTo(NOTCH_L - CH, 6);
    g.stroke();
    g.beginPath();
    g.moveTo(DW - 6, 168);
    g.lineTo(DW - 6, R_TOP);
    g.arcTo(DW - 6, 6, DW - R_TOP, 6, R_TOP - 6);
    g.lineTo(NOTCH_R + CH, 6);
    g.stroke();
    g.strokeStyle = "rgba(58,160,240,.22)";
    g.shadowBlur = 10;
    g.beginPath();
    g.moveTo(NOTCH_L - CH, 2);
    g.lineTo(NOTCH_L, NOTCH_TOP - 1);
    g.lineTo(NOTCH_R, NOTCH_TOP - 1);
    g.lineTo(NOTCH_R + CH, 2);
    g.stroke();
    g.restore();

    /* the groove, dark and recessed (the live pass lights it) */
    g.save();
    shellPath(g);
    g.clip();
    g.lineCap = "round";
    GROOVES.forEach(function (pts) {
      g.strokeStyle = "rgba(0,0,0,.72)";
      g.lineWidth = 12;
      strokeGroove(g, pts, 1);
      g.strokeStyle = "#05070a";
      g.lineWidth = 8;
      strokeGroove(g, pts, 1);
    });
    g.restore();

    /* machined frames + backlit wells */
    [WELL_L, WELL_R].forEach(function (b) {
      var f = { x: b.x - 13, y: b.y - 13, w: b.w + 26, h: b.h + 26 };
      rr(g, f, 20);
      g.fillStyle = vlin(g, f.y, f.y + f.h, [0, "#272c34", 0.45, "#191d23", 1, "#0e1014"]);
      g.fill();
      rr(g, f, 20);
      g.strokeStyle = "rgba(0,0,0,.75)";
      g.lineWidth = 2;
      g.stroke();
      /* back glow bleeding out of the panel */
      g.save();
      g.globalCompositeOperation = "lighter";
      g.shadowColor = "rgba(70,165,255,.6)";
      g.shadowBlur = 30;
      rr(g, b, 14);
      g.fillStyle = "rgba(20,50,90,.55)";
      g.fill();
      g.restore();
      rr(g, b, 14);
      g.fillStyle = vlin(g, b.y, b.y + b.h, [0, "#060a12", 0.4, "#0a1220", 1, "#071019"]);
      g.fill();
      g.save();
      rr(g, b, 14);
      g.clip();
      var bl = g.createRadialGradient(b.x + b.w / 2, b.y + b.h / 2, 20, b.x + b.w / 2, b.y + b.h / 2, b.w * 0.72);
      bl.addColorStop(0, "rgba(70,130,210,.14)");
      bl.addColorStop(1, "rgba(70,130,210,0)");
      g.fillStyle = bl;
      g.fillRect(b.x, b.y, b.w, b.h);
      g.fillStyle = "rgba(0,0,0,.6)";
      g.fillRect(b.x, b.y, b.w, 12);
      g.restore();
      rr(g, b, 14);
      g.strokeStyle = "rgba(0,0,0,.9)";
      g.lineWidth = 2;
      g.stroke();
    });

    /* centre plate + gear well */
    var p = { x: 388, y: 96, w: 224, h: 316 };
    g.save();
    g.shadowColor = "rgba(0,0,0,.7)";
    g.shadowBlur = 16;
    g.shadowOffsetY = 5;
    rr(g, p, 18);
    g.fillStyle = vlin(g, p.y, p.y + p.h, [0, "#1d2127", 0.5, "#14171c", 1, "#0d0f13"]);
    g.fill();
    g.restore();
    rr(g, p, 18);
    g.strokeStyle = "rgba(0,0,0,.8)";
    g.lineWidth = 2;
    g.stroke();
    var gp = { x: DW / 2 - 46, y: 106, w: 92, h: 92 };
    rr(g, gp, 14);
    g.fillStyle = vlin(g, gp.y, gp.y + gp.h, [0, "#0c0e12", 1, "#07080b"]);
    g.fill();
    rr(g, gp, 14);
    g.strokeStyle = "rgba(0,0,0,.9)";
    g.lineWidth = 2;
    g.stroke();

    /* chin plate */
    g.beginPath();
    g.moveTo(CHIN_L - CH + 10, POD_BOT + 2);
    g.lineTo(CHIN_R + CH - 10, POD_BOT + 2);
    g.lineTo(CHIN_R - 4, CHIN_BOT - 2);
    g.lineTo(CHIN_L + 4, CHIN_BOT - 2);
    g.closePath();
    g.fillStyle = vlin(g, POD_BOT, CHIN_BOT, [0, "#191d22", 1, "#0b0d10"]);
    g.fill();

    /* static LCD labels */
    g.globalAlpha = 1;
    g.textAlign = "left";
    g.fillStyle = "#8fb4d8";
    g.font = "13px " + FM;
    g.fillText("T Y R E S", WELL_L.x + 26, WELL_L.y + 34);
    g.fillText("L A P S", WELL_R.x + 26, WELL_R.y + 34);
    g.fillStyle = "#5f7c99";
    g.textAlign = "right";
    g.fillText("kPa · °C", WELL_L.x + WELL_L.w - 26, WELL_L.y + 34);
    g.restore();
  }

  function live(g, v, K) {
    var cx = DW / 2;

    /* the groove lights with the revs, banded like the Apex bars */
    var stage = window.ApexSpeedo ? window.ApexSpeedo.revStage(v.revFrac) : "low";
    var col =
      stage === "shift" || stage === "red"
        ? "rgba(255,70,80,.9)"
        : stage === "amber"
          ? "rgba(255,180,60,.85)"
          : "rgba(70,190,255,.8)";
    if (v.revFrac > 0.01) {
      g.save();
      g.globalCompositeOperation = "lighter";
      g.lineCap = "round";
      g.strokeStyle = col;
      g.shadowColor = col;
      g.shadowBlur = 12;
      g.lineWidth = 5;
      GROOVES.forEach(function (pts) {
        strokeGroove(g, pts, v.revFrac);
      });
      g.restore();
    }

    /* shift lamps: dark until the red band */
    var lit = stage === "red" || stage === "shift";
    [cx - 62, cx + 62].forEach(function (lx) {
      g.save();
      if (lit) {
        g.globalCompositeOperation = "lighter";
        g.shadowColor = "rgba(255,40,60,.95)";
        g.shadowBlur = 26;
      }
      rr(g, { x: lx - 30, y: 74, w: 60, h: 13 }, 6.5);
      g.fillStyle = lit ? "#ff2433" : "rgba(90,20,26,.9)";
      g.fill();
      g.restore();
    });

    /* gear above speed */
    g.textAlign = "center";
    g.save();
    g.globalCompositeOperation = "lighter";
    var halo = g.createRadialGradient(cx, 152, 4, cx, 152, 52);
    halo.addColorStop(0, "rgba(255,150,40,.26)");
    halo.addColorStop(1, "rgba(255,150,40,0)");
    g.fillStyle = halo;
    g.fillRect(cx - 46, 106, 92, 92);
    g.fillStyle = "#ffb742";
    g.font = "700 60px " + FD;
    g.shadowColor = "rgba(255,150,40,.9)";
    g.shadowBlur = 22;
    g.textBaseline = "middle";
    g.fillText(v.gear == null ? "—" : v.gear, cx, 156);
    g.restore();
    g.textBaseline = "alphabetic";
    g.fillStyle = "#9aa7b4";
    g.font = "600 15px " + FM;
    g.fillText(v.unit.split("").join(" "), cx, 240);
    g.save();
    g.fillStyle = "#f5f8fb";
    g.font = "700 82px " + FD;
    g.shadowColor = "rgba(200,225,250,.4)";
    g.shadowBlur = 16;
    g.fillText(v.speed == null ? "—" : v.speed, cx, 324);
    g.restore();
    g.fillStyle = "#7b8895";
    g.font = "14px " + FM;
    g.fillText(v.rpm == null ? "—  R P M" : v.rpm + "  R P M", cx, 356);

    /* left LCD: tyres, bias, aids */
    var b = WELL_L, x = b.x + 26;
    [["fl", 0, 0], ["fr", 1, 0], ["rl", 0, 1], ["rr", 1, 1]].forEach(function (t) {
      var c = v[t[0]];
      var tx = b.x + 24 + t[1] * 120, ty = b.y + 48 + t[2] * 58;
      g.fillStyle = "rgba(70,130,210,.10)";
      g.fillRect(tx, ty, 112, 50);
      g.textAlign = "left";
      g.fillStyle = "#e6ecf2";
      g.font = "600 20px " + FD;
      g.fillText(c.p == null ? "—" : Math.round(c.p), tx + 10, ty + 33);
      g.textAlign = "right";
      g.fillStyle = "#9fd3a8";
      g.font = "600 17px " + FD;
      g.fillText(c.t == null ? "—" : Math.round(c.t) + "°", tx + 102, ty + 33);
    });
    g.textAlign = "left";
    g.fillStyle = "#93a1ae";
    g.font = "13px " + FM;
    g.fillText("BB", x, b.y + 218);
    g.fillStyle = "#f2c14e";
    g.font = "600 24px " + FD;
    g.fillText(v.bias == null ? "—" : v.bias, x + 38, b.y + 220);
    [["MAP", v.map], ["TC", v.tc], ["ABS", v.abs]].forEach(function (a, i) {
      var ax = x + i * 80;
      g.fillStyle = "#93a1ae";
      g.font = "13px " + FM;
      g.fillText(a[0], ax, b.y + 262);
      g.fillStyle = ["#e6ecf2", "#7fd4ff", "#f2a0aa"][i];
      g.font = "600 20px " + FD;
      g.fillText(a[1] ? String(a[1].value) : "—", ax + 44, b.y + 262);
    });
    g.fillStyle = "#93a1ae";
    g.font = "13px " + FM;
    g.fillText("TCC", x, b.y + 294);
    g.fillStyle = "#e6ecf2";
    g.font = "600 20px " + FD;
    g.fillText(v.tcCut ? String(v.tcCut.value) : "—", x + 44, b.y + 294);

    /* right LCD: laps, fuel, position */
    var rb = WELL_R, rx = rb.x + rb.w - 26, lx2 = rb.x + 26;
    [["LAST", v.last, "#e6ecf2"], ["BEST", v.best, "#b18cff"], ["PRED", v.pred, "#7fd4ff"]].forEach(
      function (r2, i) {
        var ry = rb.y + 66 + i * 36;
        g.textAlign = "left";
        g.fillStyle = "#93a1ae";
        g.font = "13px " + FM;
        g.fillText(r2[0], lx2, ry);
        g.textAlign = "right";
        g.fillStyle = r2[2];
        g.font = "600 23px " + FD;
        g.fillText(r2[1] == null ? "—" : r2[1], rx, ry + 2);
      },
    );
    g.textAlign = "left";
    g.fillStyle = "#93a1ae";
    g.font = "13px " + FM;
    g.fillText("FUEL", lx2, rb.y + 196);
    g.fillStyle = "#f2f6fa";
    g.font = "600 28px " + FD;
    g.fillText(v.fuelL == null ? "—" : v.fuelL.toFixed(1) + " L", lx2, rb.y + 226);
    g.fillStyle = "#9fd3a8";
    g.font = "15px " + FM;
    g.fillText(v.fuelLaps == null ? "" : "≈ " + v.fuelLaps.toFixed(1) + " LAPS", lx2, rb.y + 250);
    g.fillStyle = "#93a1ae";
    g.font = "13px " + FM;
    g.fillText("POS", lx2, rb.y + 292);
    g.fillStyle = "#e6ecf2";
    g.font = "600 22px " + FD;
    g.fillText(v.pos == null ? "—" : v.pos, lx2 + 46, rb.y + 292);
    g.textAlign = "right";
    g.fillStyle = "#93a1ae";
    g.font = "13px " + FM;
    g.fillText("LAP", rx - 44, rb.y + 292);
    g.fillStyle = "#e6ecf2";
    g.font = "600 22px " + FD;
    g.fillText(v.laps >= 0 ? v.laps : "—", rx, rb.y + 292);
  }

  /* Pure surface for the headless test. */
  window.ApexSpeedoReal = {
    DESIGN: { w: DW, h: DH },
    NOTCH: { rimHalf: DW / 2 - (NOTCH_L - CH), tipHalf: NOTCH_R - DW / 2, depth: NOTCH_TOP },
    buildGroove: buildGroove,
  };

  window.ApexSpeedoDesigns = window.ApexSpeedoDesigns || {};
  window.ApexSpeedoDesigns.real = window.ApexDashKit.canvasDesign({
    dw: DW,
    dh: DH,
    bake: bake,
    live: live,
  });
})();
