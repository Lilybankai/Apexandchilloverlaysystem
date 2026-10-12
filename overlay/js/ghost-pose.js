/**
 * ghost-pose.js — the player's pose for Ghost HUD, between telemetry frames.
 * -----------------------------------------------------------------------------
 * Ghost HUD draws a 3-D road from a chase camera, and a camera that moves only
 * when a frame arrives moves in steps: frames reach the page at the broadcast
 * rate with Windows timer jitter on top (15.6 / 31 ms), and the overlay's
 * dispatcher paints them latest-wins, so some are never drawn at all. On a
 * screen that is mostly perspective, a 2 m step reads as a stutter.
 *
 * So the widget paints on its own animation loop and asks this module where
 * the car was at the instant being drawn. Samples go in timestamped; the pose
 * comes out INTERPOLATED a fixed delay behind the newest, so there is nearly
 * always a sample either side of the instant drawn. It is the standard
 * networked-game arrangement — a little latency bought for continuous motion —
 * and 40 ms of it is below what a driver can see in a reference line.
 *
 * Pure and DOM-free: the caller owns both clocks and passes them in, which is
 * what lets `scripts/test-ghostpose.js` check the timing rules exactly. The
 * buffer is a fixed ring of typed arrays and `sample` writes into a caller's
 * object, so nothing here allocates per frame.
 *
 * Loaded as a classic script by the overlay (`window.ApexGhostPose`) and
 * `require`d by its test, the same arrangement as `ghost-geom.js`.
 */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ApexGhostPose = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** `sample` results. */
  var NONE = 0; // nothing to draw from
  var LIVE = 1; // interpolated, or extrapolated within the cap
  var HELD = 2; // past the extrapolation cap: frozen where the cap left it
  var STALE = 3; // the newest sample is too old to stand for "now"

  /**
   * @param {object} [opts]
   * @param {number} [opts.capacity=8] Samples kept. Only the newest two-or-three
   *   are ever used; the rest absorb a burst of frames arriving together.
   * @param {number} [opts.delayMs=40] How far behind the newest sample to draw.
   *   Covers one 30 Hz interval plus the timer grid, so a 30 Hz feed still has
   *   a bracketing pair nearly every paint.
   * @param {number} [opts.maxExtrapMs=100] How far past the newest sample to
   *   guess. A dropped frame or two is bridged on the car's last velocity;
   *   beyond that a guess is a lie about where the car went, so it stops.
   * @param {number} [opts.holdMs=250] How long the last pose stands in for the
   *   car after the feed goes quiet. One missing frame must not blank the road.
   * @param {number} [opts.jumpM=60] A step longer than this between samples is
   *   a reset or a tow, never driving; interpolating across it would draw the
   *   car flying over the infield.
   * @param {number} [opts.maxLateMs=1000] See `stamp`.
   * @param {number} [opts.leakMs=0.02] See `stamp`.
   */
  function create(opts) {
    var o = opts || {};
    var cap = o.capacity > 1 ? Math.floor(o.capacity) : 8;
    return {
      cap: cap,
      n: 0,
      /** Ring slot the NEXT sample goes into. */
      head: 0,
      t: new Float64Array(cap),
      x: new Float64Array(cap),
      z: new Float64Array(cap),
      h: new Float64Array(cap),
      g: new Float64Array(cap),
      delayMs: o.delayMs >= 0 ? o.delayMs : 40,
      maxExtrapMs: o.maxExtrapMs >= 0 ? o.maxExtrapMs : 100,
      holdMs: o.holdMs > 0 ? o.holdMs : 250,
      jumpM: o.jumpM > 0 ? o.jumpM : 60,
      maxLateMs: o.maxLateMs > 0 ? o.maxLateMs : 1000,
      leakMs: o.leakMs >= 0 ? o.leakMs : 0.02,
      /** Local-minus-server clock offset estimate; NaN until the first stamp. */
      offset: NaN,
    };
  }

  /** Forget every sample (a new circuit, a reset). The clock estimate stays. */
  function reset(buf) {
    buf.n = 0;
    buf.head = 0;
  }

  /**
   * A sample's time on the LOCAL clock, from the server's stamp.
   *
   * Arrival time alone carries the renderer's own jitter — a frame parsed late
   * because the page was busy looks like the car paused and then lunged. The
   * server's `frame.timestamp` says when the pose was actually read, so the
   * spacing between samples is the true spacing.
   *
   * But that stamp is the SERVER's wall clock, and the overlay can run on
   * another PC (OBS on a streaming machine) whose clock is seconds out. So the
   * stamp is never compared with local time directly. Instead the offset
   * between the clocks is estimated as the smallest `arrival − stamp` seen —
   * the least-delayed frame is the best measure of the clocks' difference — and
   * every sample is placed at `stamp + offset`. Skew of any size cancels, and
   * by construction no sample can land in the local future.
   *
   * The estimate leaks upward by `leakMs` a sample (1.2 ms/s at 60 Hz) so it
   * follows slow drift between the two clocks rather than holding one lucky
   * minimum forever. A frame more than `maxLateMs` behind the estimate means a
   * clock was stepped (or the page stalled for a second): the estimate is
   * re-based on that frame — i.e. it falls back to arrival time — rather than
   * placing every later sample a second in the past and calling the car stale.
   *
   * @param {number} serverMs - `frame.timestamp`; anything non-finite means
   *   "no stamp" and the arrival time is used as-is.
   * @param {number} arrivalMs - Local clock now (`performance.now()`).
   */
  function stamp(buf, serverMs, arrivalMs) {
    if (typeof serverMs !== 'number' || !isFinite(serverMs)) return arrivalMs;
    var lag = arrivalMs - serverMs;
    var est = buf.offset + buf.leakMs;
    // Re-base on this frame when it is the first, when it arrived quicker than
    // any so far (a new minimum), or when it is implausibly late (a clock step).
    if (!(est <= lag) || lag - est > buf.maxLateMs) est = lag;
    buf.offset = est;
    // `est ≤ lag` already says "not after arrival"; the min only absorbs the
    // rounding of adding a 1.7e12 ms epoch stamp back on.
    return Math.min(serverMs + est, arrivalMs);
  }

  /**
   * Add a sample. `t` must be on the same clock `sample` will be asked about.
   *
   * A sample OLDER than the newest means the stream restarted (a reconnect, a
   * replay) and the buffer starts again; one at the SAME time replaces the
   * newest, which is what happens when frames carry no stamp and several are
   * handled within one millisecond.
   */
  function push(buf, t, x, z, h, g) {
    if (buf.n > 0) {
      var last = (buf.head - 1 + buf.cap) % buf.cap;
      if (t < buf.t[last] || Math.hypot(x - buf.x[last], z - buf.z[last]) > buf.jumpM) {
        reset(buf);
      } else if (t === buf.t[last]) {
        buf.head = last;
        buf.n--;
      }
    }
    var i = buf.head;
    buf.t[i] = t;
    buf.x[i] = x;
    buf.z[i] = z;
    buf.h[i] = h;
    buf.g[i] = g;
    buf.head = (i + 1) % buf.cap;
    if (buf.n < buf.cap) buf.n++;
  }

  /** Time of the newest sample, or NaN when empty. */
  function newestTime(buf) {
    return buf.n ? buf.t[(buf.head - 1 + buf.cap) % buf.cap] : NaN;
  }

  /**
   * Where the car was at `nowMs − delayMs`, written into `out`.
   *
   * @param {{x:number, z:number, h:number, gapM:number, ageMs:number}} out
   *   `h` is degrees, normalised to (−180, 180]; `ageMs` is how old the newest
   *   sample is at `nowMs`.
   * @returns {number} NONE, LIVE, HELD or STALE. `out` is filled for all but
   *   NONE, so a caller may still draw a STALE pose if it chooses to.
   */
  function sample(buf, nowMs, out) {
    var n = buf.n;
    if (!n) return NONE;
    var cap = buf.cap;
    var iN = (buf.head - 1 + cap) % cap;
    var tN = buf.t[iN];
    out.ageMs = nowMs - tN;
    var at = nowMs - buf.delayMs;
    var status = out.ageMs > buf.holdMs ? STALE : LIVE;

    if (n === 1) {
      write(buf, out, iN, iN, 0);
      return status;
    }
    var iO = (buf.head - n + cap) % cap; // oldest
    if (at <= buf.t[iO]) {
      // Earlier than anything kept (the buffer has just started): never guess
      // backwards.
      write(buf, out, iO, iO, 0);
      return status;
    }
    if (at <= tN) {
      // Walk back from the newest to the pair that brackets `at`. Two or three
      // steps in practice: `at` is only `delayMs` behind the newest.
      var b = iN;
      for (var k = 1; k < n; k++) {
        var a = (b - 1 + cap) % cap;
        if (buf.t[a] <= at) {
          var span = buf.t[b] - buf.t[a];
          write(buf, out, a, b, span > 0 ? (at - buf.t[a]) / span : 1);
          return status;
        }
        b = a;
      }
      write(buf, out, iO, iO, 0);
      return status;
    }
    // Past the newest: carry on along the last step's velocity, up to the cap.
    var iP = (iN - 1 + cap) % cap;
    var step = tN - buf.t[iP];
    var over = at - tN;
    var held = over > buf.maxExtrapMs;
    if (held) over = buf.maxExtrapMs;
    // A last step longer than the hold window is not a velocity worth trusting.
    if (!(step > 0) || step > buf.holdMs) write(buf, out, iN, iN, 0);
    else write(buf, out, iP, iN, 1 + over / step);
    return status === STALE ? STALE : held ? HELD : LIVE;
  }

  /** Lerp slots `a`→`b` by `f` (f > 1 extrapolates), heading the short way. */
  function write(buf, out, a, b, f) {
    out.x = buf.x[a] + (buf.x[b] - buf.x[a]) * f;
    out.z = buf.z[a] + (buf.z[b] - buf.z[a]) * f;
    out.gapM = buf.g[a] + (buf.g[b] - buf.g[a]) * f;
    // The short way round: 179° to −179° is a 2° turn, not a 358° spin.
    var dh = ((((buf.h[b] - buf.h[a] + 180) % 360) + 360) % 360) - 180;
    var h = buf.h[a] + dh * f;
    out.h = h - 360 * Math.ceil((h - 180) / 360);
  }

  return {
    NONE: NONE,
    LIVE: LIVE,
    HELD: HELD,
    STALE: STALE,
    create: create,
    reset: reset,
    stamp: stamp,
    push: push,
    newestTime: newestTime,
    sample: sample,
  };
});
