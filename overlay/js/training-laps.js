/**
 * training-laps.js — sectors and corner verdicts against the ghost lap.
 * -----------------------------------------------------------------------------
 * The Corner card and the Lap strip both say "this much was won or lost
 * here". The corners are scored on the server (`cornerTracker.ts`); this is
 * the rest — the three timing sectors, and the words and colours both widgets
 * use, so the two can never describe the same corner differently.
 *
 * ## Sectors are gap differences, like corners
 * The ghost's gap is `t_live − t_ref(d)` and starts every lap at zero on the
 * line, so the gap AT the S1 line is the S1 delta, the gap at S2 minus the gap
 * at S1 is the S2 delta, and the gap at the finish minus the gap at S2 is S3.
 * No sector clock of our own and no second interpolation into the reference.
 *
 * ## Where the sector lines are
 * Best: `/ghost.json`'s `sectorD`, the reference lap's own S1/S2 lines from
 * the sim's sector times (`ghostLap.sectorLines`). When the lap carried none,
 * they are learned from the live car: each standings row gives the sim's
 * `sector` and `lapFraction` from the SAME REST snapshot, so the line lies
 * between the last fraction seen in the old sector and the first in the new.
 * Each lap narrows that bracket (`learnLine`), and the middle of it is used.
 *
 * Pure: loaded as a classic script (`window.ApexTrainingLaps`) and `require`d
 * by `scripts/test-training-widgets.js`.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ApexTrainingLaps = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  /** |delta| at or under this reads "level", seconds. */
  var LEVEL_SEC = 0.02;
  /** A corner delta at or past this is drawn at full colour, seconds. */
  var FULL_SEC = 0.15;
  /** Braking points closer than this are "the same", metres. */
  var SAME_BRAKE_M = 3;
  /** Apex speeds closer than this are "level", km/h. */
  var SAME_APEX_KPH = 1;
  var KPH_PER_MPH = 1.609344;

  /* -------------------------------- sectors ------------------------------- */

  function createSectors() {
    return {
      /** The S1 and S2 lines, lap fractions; NaN until known. */
      line: [NaN, NaN],
      /** Whether `line` came from the reference lap itself (never relearned). */
      fromRef: false,
      /** The learned bracket around each line. */
      lo: [-Infinity, -Infinity],
      hi: [Infinity, Infinity],
      restSector: 0,
      restFrac: NaN,
      prevD: NaN,
      prevGap: NaN,
      /** The gap as the car crossed S1 and S2 this lap; NaN = not seen. */
      gapAt: [NaN, NaN],
      /** This lap's sector deltas, seconds; NaN = not yet / unknown. */
      cur: [NaN, NaN, NaN],
      /** The previous lap's. */
      prev: [NaN, NaN, NaN],
      /** The sector the car is in (0..2), or −1 while the lines are unknown. */
      live: -1,
      /** The running delta in the live sector. */
      liveDelta: NaN,
      /** Bumped whenever `cur` or `prev` change, so a view redraws only then. */
      ver: 0,
    };
  }

  /** Use the reference's own lines. Ignored unless both are sane. */
  function setLines(st, s1, s2) {
    if (!(s1 > 0) || !(s2 > s1) || !(s2 < 1)) return false;
    st.line[0] = s1;
    st.line[1] = s2;
    st.fromRef = true;
    return true;
  }

  /** Forget the lines and the laps (another ghost lap, another circuit). */
  function resetSectors(st) {
    st.line[0] = st.line[1] = NaN;
    st.fromRef = false;
    st.lo[0] = st.lo[1] = -Infinity;
    st.hi[0] = st.hi[1] = Infinity;
    st.restSector = 0;
    st.restFrac = NaN;
    st.prevD = NaN;
    st.prevGap = NaN;
    st.gapAt[0] = st.gapAt[1] = NaN;
    for (var k = 0; k < 3; k++) st.cur[k] = st.prev[k] = NaN;
    st.live = -1;
    st.liveDelta = NaN;
    st.ver++;
  }

  /**
   * Learn the sector lines from a REST snapshot: the sim's `sector` (1..3)
   * and `lapFraction` for the player's row.
   *
   * @param {number} d - The filtered road position NOW. REST runs behind it,
   *   so a line learned for the first time has usually just been passed; its
   *   gap is then taken from `gap` rather than missed for a whole lap.
   * @returns {boolean} Whether a line moved.
   */
  function learnLine(st, sector, frac, d, gap) {
    if (st.fromRef || !(sector >= 1 && sector <= 3) || !isFinite(frac)) return false;
    var moved = false;
    var was = st.restSector;
    if (was && sector === was + 1 && isFinite(st.restFrac) && st.restFrac < frac) {
      var k = was - 1;
      st.lo[k] = Math.max(st.lo[k], st.restFrac);
      st.hi[k] = Math.min(st.hi[k], frac);
      // A bracket that has turned inside out is from another layout or a
      // reset; start it again from this crossing.
      if (!(st.lo[k] < st.hi[k])) {
        st.lo[k] = st.restFrac;
        st.hi[k] = frac;
      }
      var first = !isFinite(st.line[k]);
      st.line[k] = (st.lo[k] + st.hi[k]) / 2;
      moved = true;
      if (first && isFinite(d) && d >= st.line[k] && !isFinite(st.gapAt[k])) {
        crossed(st, k, gap);
      }
    }
    st.restSector = sector;
    st.restFrac = frac;
    return moved;
  }

  function crossed(st, k, g) {
    st.gapAt[k] = g;
    var base = k === 0 ? 0 : st.gapAt[k - 1];
    st.cur[k] = isFinite(g) && isFinite(base) ? g - base : NaN;
    st.ver++;
  }

  /**
   * One frame: the filtered road position and the ghost gap (NaN when the
   * ghost is inactive). Crossings are interpolated between frames.
   */
  function stepSectors(st, d, gap) {
    if (!isFinite(d)) return;
    var a = st.prevD;
    var ga = st.prevGap;
    if (isFinite(a)) {
      if (d < a - 0.5) {
        // The line: S3 ends on the last gap of the lap, then a fresh lap.
        var base = st.gapAt[1];
        st.cur[2] = isFinite(ga) && isFinite(base) ? ga - base : NaN;
        for (var k = 0; k < 3; k++) {
          st.prev[k] = st.cur[k];
          st.cur[k] = NaN;
        }
        st.gapAt[0] = st.gapAt[1] = NaN;
        st.ver++;
      } else if (d > a) {
        for (var j = 0; j < 2; j++) {
          var L = st.line[j];
          if (isFinite(L) && a < L && L <= d) {
            var g = isFinite(ga) && isFinite(gap) ? ga + (gap - ga) * ((L - a) / (d - a)) : NaN;
            crossed(st, j, g);
          }
        }
      }
    }
    st.prevD = d;
    st.prevGap = gap;
    if (isFinite(st.line[0]) && isFinite(st.line[1])) {
      st.live = d < st.line[0] ? 0 : d < st.line[1] ? 1 : 2;
      var from = st.live === 0 ? 0 : st.gapAt[st.live - 1];
      st.liveDelta = isFinite(gap) && isFinite(from) ? gap - from : NaN;
    } else {
      st.live = -1;
      st.liveDelta = NaN;
    }
  }

  /**
   * The reference's own sector times, seconds — its clock at each line, read
   * off its `t` column. NaN where a line is unknown.
   */
  function refSplits(line, s1, s2, out) {
    var o = out || [NaN, NaN, NaN];
    var t1 = timeAt(line, s1);
    var t2 = timeAt(line, s2);
    o[0] = t1;
    o[1] = t2 - t1;
    o[2] = line && line.lapSec > 0 ? line.lapSec - t2 : NaN;
    return o;
  }

  /** The reference's clock at lap fraction `d`, linear between samples; NaN outside it. */
  function timeAt(line, d) {
    if (!line || !line.d || !line.t || !isFinite(d)) return NaN;
    var dd = line.d;
    var n = Math.min(dd.length, line.t.length);
    if (n < 2 || d < dd[0] || d > dd[n - 1]) return NaN;
    var lo = 1;
    var hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (dd[mid] >= d) hi = mid;
      else lo = mid + 1;
    }
    var a = dd[lo - 1];
    var b = dd[lo];
    var t0 = line.t[lo - 1];
    return b > a ? t0 + (line.t[lo] - t0) * ((d - a) / (b - a)) : t0;
  }

  /* ------------------------------ the words ------------------------------- */

  /** "C5" — the reference lap's own order, never an official corner name. */
  function cornerName(index) {
    return "C" + (index + 1);
  }

  /** Signed seconds with a real minus sign: "+0.21", "−0.21", "0.00". */
  function fmtSigned(sec, dp) {
    if (!isFinite(sec)) return "—";
    var p = dp == null ? 2 : dp;
    var r = Number(Math.abs(sec).toFixed(p));
    var sign = r === 0 ? "" : sec > 0 ? "+" : "−";
    return sign + r.toFixed(p);
  }

  /**
   * How a delta reads: 'gain' (faster), 'loss', 'level', or 'none' when
   * there is no number. Positive seconds are time LOST, as on every delta.
   */
  function toneOf(sec) {
    if (sec === null || !isFinite(sec)) return "none";
    if (Math.abs(sec) <= LEVEL_SEC) return "level";
    return sec > 0 ? "loss" : "gain";
  }

  /**
   * Colour strength for a delta, 0..1: nothing inside the level band, full
   * at FULL_SEC. Square-rooted so a tenth reads clearly rather than faintly.
   */
  function strength(sec) {
    if (sec === null || !isFinite(sec)) return 0;
    var a = Math.abs(sec);
    if (a <= LEVEL_SEC) return 0;
    var f = (a - LEVEL_SEC) / (FULL_SEC - LEVEL_SEC);
    return f >= 1 ? 1 : Math.sqrt(f);
  }

  /** "braked 12 m early" / "braked 8 m later" / "same brake point" / null. */
  function brakePhrase(m) {
    if (m === null || m === undefined || !isFinite(m)) return null;
    var r = Math.round(Math.abs(m));
    if (r < SAME_BRAKE_M) return "same brake point";
    return "braked " + r + " m " + (m < 0 ? "early" : "later");
  }

  /** "apex −6 km/h" / "apex +4 mph" / "apex speed level" / null. */
  function apexPhrase(kph, unit) {
    if (kph === null || kph === undefined || !isFinite(kph)) return null;
    if (Math.abs(kph) < SAME_APEX_KPH) return "apex speed level";
    var mph = unit === "mph";
    var v = Math.round(mph ? kph / KPH_PER_MPH : kph);
    if (v === 0) return "apex speed level";
    return "apex " + (v > 0 ? "+" : "−") + Math.abs(v) + (mph ? " mph" : " km/h");
  }

  /**
   * The quiet line between verdicts: "C6 · brake in 140 m", "C6 · 320 m",
   * "in C6". Metres past a sensible lookahead are not worth reading.
   */
  function nextPhrase(corner) {
    if (!corner) return "";
    var name = cornerName(corner.index);
    if (corner.inside) return "in " + name;
    if (isFinite(corner.toBrakeM) && corner.toBrakeM <= 400) {
      return name + " · brake in " + corner.toBrakeM + " m";
    }
    return name + " · " + corner.toEntryM + " m";
  }

  return {
    LEVEL_SEC: LEVEL_SEC,
    FULL_SEC: FULL_SEC,
    createSectors: createSectors,
    setLines: setLines,
    resetSectors: resetSectors,
    learnLine: learnLine,
    stepSectors: stepSectors,
    refSplits: refSplits,
    timeAt: timeAt,
    cornerName: cornerName,
    fmtSigned: fmtSigned,
    toneOf: toneOf,
    strength: strength,
    brakePhrase: brakePhrase,
    apexPhrase: apexPhrase,
    nextPhrase: nextPhrase,
  };
});
