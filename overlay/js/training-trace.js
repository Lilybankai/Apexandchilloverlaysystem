/**
 * training-trace.js — the maths the Trace widget draws with.
 * -----------------------------------------------------------------------------
 * The Trace is a strip of road, metres along the bottom, with the car fixed
 * in it: behind the car, what your feet and hands did against what the
 * reference's did over the same metres; ahead, only the reference, so its
 * next braking zone can be seen coming. Everything here is about putting both
 * laps on ONE metre axis, cheaply enough to draw at display rate:
 *
 *   - Your inputs arrive per frame at whatever spacing the speed gives — 2 m
 *     a frame at 200 km/h, centimetres in a hairpin. They go into a ring of
 *     one-metre bins (`createTrail` / `writeTrail`), filled across any gap
 *     between frames, so the painter reads bin by bin with no search.
 *   - The reference is resampled onto the same one-metre grid once per lap
 *     (`resampleRef`), so reading it is an index too.
 *   - Lap fraction is unwrapped into a continuous distance (`unwrap`), so the
 *     window and the trail run straight through the start/finish line.
 *
 * Nothing here allocates once set up; the trail and grid are typed arrays.
 * Loaded as a classic script (`window.ApexTrainingTrace`) and `require`d by
 * `scripts/test-training-widgets.js`, the `ghost-geom.js` arrangement.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ApexTrainingTrace = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  /**
   * `brakePoints.ts`'s thresholds, mirrored: a zone painted here must start
   * exactly where the server's corner card says the reference braked. Change
   * them in both places or neither.
   */
  var BRAKE_ON = 0.12;
  var BRAKE_OFF = 0.05;
  var ZONE_GAP_M = 60;

  /**
   * The longest gap between two frames that is filled in. Past this the car
   * did not drive from one to the other (a tow, a reset), and a straight line
   * between two unrelated pedal readings would be drawn as if it had.
   */
  var MAX_FILL_M = 40;

  /* ------------------------------ your trail ------------------------------ */

  /**
   * @param {number} capM - Metres kept; a power of two is not required.
   */
  function createTrail(capM) {
    var cap = capM > 0 ? Math.floor(capM) : 512;
    var at = new Float64Array(cap);
    at.fill(NaN);
    return {
      cap: cap,
      thr: new Float32Array(cap),
      brk: new Float32Array(cap),
      str: new Float32Array(cap),
      /** Road speed, km/h; NaN where the frame carried none. */
      spd: new Float32Array(cap),
      /** The gap to the reference, seconds (positive = behind); NaN = not live. */
      gap: new Float32Array(cap),
      /** The metre each slot currently holds; NaN = empty. */
      at: at,
      lastBin: NaN,
      lastThr: 0,
      lastBrk: 0,
      lastStr: 0,
      lastSpd: NaN,
      lastGap: NaN,
    };
  }

  function resetTrail(tr) {
    tr.at.fill(NaN);
    tr.lastBin = NaN;
  }

  function put(tr, bin, thr, brk, str, spd, gp) {
    var s = ((bin % tr.cap) + tr.cap) % tr.cap;
    tr.at[s] = bin;
    tr.thr[s] = thr;
    tr.brk[s] = brk;
    tr.str[s] = str;
    tr.spd[s] = spd;
    tr.gap[s] = gp;
  }

  /** `a` to `b` by `f`; NaN when either end is (an unknown is not interpolated). */
  function mix(a, b, f) {
    return a + (b - a) * f;
  }

  /**
   * File one frame's inputs at lap-continuous metre `m`. The bins between the
   * previous frame's and this one's are filled on a straight line between the
   * two readings — what a 30 Hz sample of a smooth pedal looks like.
   *
   * `spd` (km/h) and `gp` (gap to the reference, s) are optional: left out,
   * they are NaN, and a reader skips those metres.
   *
   * A frame at or behind the last bin (the car crawling, or the filtered
   * position settling back) just overwrites its own bin.
   */
  function writeTrail(tr, m, thr, brk, str, spd, gp) {
    if (!isFinite(m)) return;
    var v = typeof spd === "number" && isFinite(spd) ? spd : NaN;
    var g = typeof gp === "number" && isFinite(gp) ? gp : NaN;
    var bin = Math.floor(m);
    var last = tr.lastBin;
    var gap = bin - last;
    if (isFinite(last) && gap > 1 && gap <= MAX_FILL_M) {
      for (var k = 1; k < gap; k++) {
        var f = k / gap;
        put(
          tr,
          last + k,
          mix(tr.lastThr, thr, f),
          mix(tr.lastBrk, brk, f),
          mix(tr.lastStr, str, f),
          mix(tr.lastSpd, v, f),
          mix(tr.lastGap, g, f),
        );
      }
    }
    put(tr, bin, thr, brk, str, v, g);
    tr.lastBin = bin;
    tr.lastThr = thr;
    tr.lastBrk = brk;
    tr.lastStr = str;
    tr.lastSpd = v;
    tr.lastGap = g;
  }

  /** The slot holding metre `bin`, or −1 when it is empty or overwritten. */
  function trailSlot(tr, bin) {
    var s = ((bin % tr.cap) + tr.cap) % tr.cap;
    return tr.at[s] === bin ? s : -1;
  }

  /* ---------------------------- the reference ----------------------------- */

  /**
   * The reference lap on a one-metre grid over `[0, lapM)`.
   *
   * One forward walk over the trace, never a search per metre. A full lap's
   * first and last few metres — between its last sample and the line, and
   * the line and its first — hold the nearest sample: the car is on the same
   * pedals a metre either side of the line. Metres a FRAGMENT of a lap does
   * not cover are left out of `ok`, and the painter leaves them blank rather
   * than inventing inputs there.
   *
   * @param {object} line - `/ghost.json`: `d`, optional `throttle`, `brake`, `steer`, `speedKph`.
   * @returns {object|null} `{ n, thr, brk, str, spd, ok }`, or null with no pedals.
   *          `spd` is km/h, NaN throughout when the lap has no speed column.
   */
  function resampleRef(line, lapM) {
    if (!line || !line.d || !(lapM > 0)) return null;
    var thr = line.throttle;
    var brk = line.brake;
    if (!thr || !brk) return null;
    var st = line.steer && line.steer.length === line.d.length ? line.steer : null;
    var sp = line.speedKph && line.speedKph.length === line.d.length ? line.speedKph : null;
    var d = line.d;
    var N = d.length;
    var n = Math.max(1, Math.floor(lapM));
    var out = {
      n: n,
      thr: new Float32Array(n),
      brk: new Float32Array(n),
      str: new Float32Array(n),
      spd: new Float32Array(n),
      ok: new Uint8Array(n),
    };
    var full = line.full !== false;
    var i = 1;
    for (var m = 0; m < n; m++) {
      var f = m / lapM;
      if (f < d[0] || f > d[N - 1]) {
        if (!full) continue;
        var e = f < d[0] ? 0 : N - 1;
        out.thr[m] = thr[e];
        out.brk[m] = brk[e];
        out.str[m] = st ? st[e] : 0;
        out.spd[m] = sp ? sp[e] : NaN;
        out.ok[m] = 1;
        continue;
      }
      while (i < N - 1 && d[i] < f) i++;
      var a = d[i - 1];
      var b = d[i];
      var w = b > a ? (f - a) / (b - a) : 0;
      if (w < 0) w = 0;
      else if (w > 1) w = 1;
      out.thr[m] = thr[i - 1] + (thr[i] - thr[i - 1]) * w;
      out.brk[m] = brk[i - 1] + (brk[i] - brk[i - 1]) * w;
      out.str[m] = st ? st[i - 1] + (st[i] - st[i - 1]) * w : 0;
      out.spd[m] = sp ? sp[i - 1] + (sp[i] - sp[i - 1]) * w : NaN;
      out.ok[m] = 1;
    }
    return out;
  }

  /**
   * The reference's braking zones in lap metres: where each began, and where
   * the brake came off again.
   *
   * Onsets come from the server's `brakes` when `/ghost.json` sends them —
   * they ARE the points the corner card measures against. Without them (an
   * older server, a fixture) the same detector runs on the grid. Either way
   * the release is read off the grid: the first metre the pedal is back
   * under BRAKE_OFF.
   *
   * @returns {{on: Float64Array, off: Float64Array}} Ascending, same length.
   */
  function brakeZones(grid, line, lapM) {
    var on = [];
    if (line && Array.isArray(line.brakes)) {
      for (var b = 0; b < line.brakes.length; b++) {
        var bd = line.brakes[b] && line.brakes[b].d;
        if (isFinite(bd)) on.push(bd * lapM);
      }
    } else if (grid) {
      var pressed = false;
      var offSince = -Infinity;
      for (var m = 0; m < grid.n; m++) {
        if (!grid.ok[m]) continue;
        var v = grid.brk[m];
        if (!pressed && v >= BRAKE_ON) {
          pressed = true;
          if (m - offSince >= ZONE_GAP_M) on.push(m);
        } else if (pressed && v < BRAKE_OFF) {
          pressed = false;
          offSince = m;
        }
      }
    }
    on.sort(function (x, y) {
      return x - y;
    });
    var off = new Float64Array(on.length);
    for (var k = 0; k < on.length; k++) {
      var end = on[k];
      if (grid) {
        var start = Math.max(0, Math.ceil(on[k]));
        end = start;
        // Past the onset first — the pedal is still rising through BRAKE_ON
        // at the onset metre — then to the first metre it is off again.
        while (end < grid.n && grid.ok[end] && grid.brk[end] < BRAKE_ON && end - start < 10) end++;
        while (end < grid.n && grid.ok[end] && grid.brk[end] >= BRAKE_OFF) end++;
      }
      off[k] = end;
    }
    return { on: Float64Array.from(on), off: off };
  }

  /* ------------------------------ the axis -------------------------------- */

  /** A lap-fraction unwrapper: crossing the line adds a lap instead of jumping back. */
  function createUnwrap() {
    return { laps: 0, last: NaN };
  }

  /**
   * Lap-continuous laps (`laps + d`). A drop of more than half a lap is the
   * line; a rise of more than half a lap is the filtered position settling
   * back over it the other way.
   */
  function unwrap(u, d) {
    if (isFinite(u.last)) {
      if (d < u.last - 0.5) u.laps++;
      else if (d > u.last + 0.5) u.laps--;
    }
    u.last = d;
    return u.laps + d;
  }

  /** Metres `m` mapped into `[0, lapM)` — how the grid is read for any window. */
  function lapIndex(m, n) {
    var i = Math.floor(m) % n;
    return i < 0 ? i + n : i;
  }

  return {
    BRAKE_ON: BRAKE_ON,
    BRAKE_OFF: BRAKE_OFF,
    ZONE_GAP_M: ZONE_GAP_M,
    MAX_FILL_M: MAX_FILL_M,
    createTrail: createTrail,
    resetTrail: resetTrail,
    writeTrail: writeTrail,
    trailSlot: trailSlot,
    resampleRef: resampleRef,
    brakeZones: brakeZones,
    createUnwrap: createUnwrap,
    unwrap: unwrap,
    lapIndex: lapIndex,
  };
});
