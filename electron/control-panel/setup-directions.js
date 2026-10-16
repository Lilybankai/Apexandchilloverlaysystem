/**
 * setup-directions.js — which way a higher step index moves each setting.
 * -----------------------------------------------------------------------------
 * The garage API speaks in step INDICES (0..max), not in physical units, and
 * nothing in the API says whether index 12 is more or less of something than
 * index 11. The macros need exactly that, so it lives here, per key family,
 * with the evidence and a `verified` flag beside every entry:
 *
 *   sign  +1 = a higher index means MORE of `quantity`; -1 = less.
 *   floor the lowest index that is a real setting. ARBs and third springs sit
 *         on "Detached" / "N/A" at index 0 — a different car, not a softer
 *         one — so a macro never steps onto it, and leaves a car that is
 *         already there alone.
 *   parse reads the sim's own label into a comparable number, or null. Only
 *         labels that carry a physical quantity (or LMU's own soft/hard
 *         words) parse; bare click numbers do not, because they run BOTH ways
 *         between cars (Aston's dampers count "B31" down to "B20" as they
 *         stiffen, BMW's count 0 up to 18).
 *
 * Evidence, strongest first:
 *   - scripts/fixtures/svm-ladders.json — the census of 811 saved setups across
 *     26 cars (18 GT3, 4 Hypercar, 3 LMP2, 1 GTE), read off `Name=index//label`
 *     lines by scripts/census-svm-ladders.js. Every family below whose labels
 *     parse runs the same way on every car in it; test-setup.js re-checks that.
 *   - Wet-vs-dry pairs in the same census (246 pairs from one setup shop): the
 *     wet copy raises the TC map 140 times to 7, power cut 136:11, slip 132:12,
 *     rear wing 138:3 and softens both bars — the behaviour of "higher = more".
 *   - src/telemetry/mfdControl.ts — brake migration's ladder, read off the car.
 *   - scripts/fixtures/ladders-<class>.json, once a human runs
 *     scripts/probe-setup-ladders.js in the garage: a full walk of every rung.
 *     applyLadders() lets those override this table per class.
 *
 * A runtime self-check closes the loop on cars nobody has captured: after an
 * Apply, observe() compares each key's label before and after against the
 * table, and a contradiction is remembered for THAT car (flipsFor/saveFlip).
 *
 * Classic script (window.APEX_SETUP_DIRECTIONS) + module.exports for tests.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_SETUP_DIRECTIONS = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* ---- label parsers ------------------------------------------------------
   * Each returns { unit, v } or null. Points are only ever compared within one
   * unit, so a ladder that switches display units part-way ("4.9 cm",
   * "1.929 in") still compares cleanly. */

  const NUM = '(-?\\d+(?:\\.\\d+)?)';
  const re = (src) => new RegExp(src, 'i');

  const RE_BIAS = re(`^${NUM}\\s*:\\s*${NUM}$`);
  const RE_DEG = re(`^${NUM}\\s*deg\\b`);
  const RE_CM = re(`^${NUM}\\s*cm$`);
  const RE_IN = re(`^${NUM}\\s*in$`);
  const RE_KPA = re(`^${NUM}\\s*kPa$`);
  const RE_PSI = re(`^${NUM}\\s*psi$`);
  const RE_NMM = re(`^${NUM}\\s*N/mm$`);
  const RE_LBF = re(`^${NUM}\\s*lbf/in$`);
  const RE_MM = re(`^${NUM}\\s*mm$`);
  const RE_NM = re(`^${NUM}\\s*Nm$`);
  const RE_PCT = re(`^${NUM}\\s*%$`);
  const RE_RAMP = re(`^FF\\d+-${NUM}\\s*deg$`);
  const RE_P = /^P(\d+)$/;
  const RE_INT = /^(\d+)(?:\s*\(([A-Za-z]+)\))?$/;

  const clean = (s) => (typeof s === 'string' ? s.trim() : '');

  /** LMU's own soft/hard words at the ends of a ladder ("Detached" = no bar at all). */
  function marker(s) {
    if (/^detached$/i.test(s)) return { unit: 'marker', v: -1 };
    if (/\(soft\)|\(lowest\)/i.test(s)) return { unit: 'marker', v: 0 };
    if (/\(hard\)|\(highest\)/i.test(s)) return { unit: 'marker', v: 1 };
    return null;
  }

  const parsers = {
    /** "52.3:47.7" → the REAR share. */
    bias(s) {
      const m = RE_BIAS.exec(clean(s));
      return m ? { unit: 'rear%', v: Number(m[2]) } : null;
    },
    deg(s) {
      const m = RE_DEG.exec(clean(s));
      return m ? { unit: 'deg', v: Number(m[1]) } : null;
    },
    /** Ride heights and packers, in cm whichever unit the sim chose. */
    length(s) {
      const t = clean(s);
      let m = RE_CM.exec(t);
      if (m) return { unit: 'cm', v: Number(m[1]) };
      m = RE_IN.exec(t);
      return m ? { unit: 'cm', v: Number(m[1]) * 2.54 } : null;
    },
    pressure(s) {
      const t = clean(s);
      let m = RE_KPA.exec(t);
      if (m) return { unit: 'kPa', v: Number(m[1]) };
      m = RE_PSI.exec(t);
      return m ? { unit: 'kPa', v: Number(m[1]) * 6.89476 } : null;
    },
    /** Spring rates (N/mm, lbf/in → N/mm), torsion-bar sizes, soft/hard. */
    spring(s) {
      const t = clean(s);
      let m = RE_NMM.exec(t);
      if (m) return { unit: 'N/mm', v: Number(m[1]) };
      m = RE_LBF.exec(t);
      if (m) return { unit: 'N/mm', v: Number(m[1]) * 0.175127 };
      m = RE_MM.exec(t);
      if (m) return { unit: 'mm', v: Number(m[1]) };
      return marker(t);
    },
    /** Bars and dampers: only the sim's soft/hard words are trusted. */
    marker(s) {
      return marker(clean(s));
    },
    /** Rear wing: an angle, or a position "P5". */
    wing(s) {
      const t = clean(s);
      const d = RE_DEG.exec(t);
      if (d) return { unit: 'deg', v: Number(d[1]) };
      const p = RE_P.exec(t);
      return p ? { unit: 'P', v: Number(p[1]) } : null;
    },
    /**
     * Diff lock. A ramp diff's lock RISES as the ramp angle FALLS (locking
     * torque goes with the cotangent of the angle), so "FF6-25 deg" is more
     * locked than "FF6-60 deg"; a percentage is lock directly.
     */
    lock(s) {
      const t = clean(s);
      const r = RE_RAMP.exec(t);
      if (r) return { unit: 'ramp', v: -Number(r[1]) };
      const p = RE_PCT.exec(t);
      return p ? { unit: '%', v: Number(p[1]) } : null;
    },
    preload(s) {
      const t = clean(s);
      const m = RE_NM.exec(t);
      if (m) return { unit: 'Nm', v: Number(m[1]) };
      return marker(t);
    },
    /** ABS: LMU names the high maps "(Understeer)" and the middle "(Balanced)". */
    abs(s) {
      const m = RE_INT.exec(clean(s));
      if (!m || !m[2]) return null;
      const word = m[2].toLowerCase();
      if (word === 'oversteer') return { unit: 'abs', v: -1 };
      if (word === 'balanced') return { unit: 'abs', v: 0 };
      if (word === 'understeer') return { unit: 'abs', v: 1 };
      return null;
    },
    /** "Open" / "No tape" = 0% blanked, "Closed" = 100%, else the % or mm. */
    blanking(s) {
      const t = clean(s);
      if (/^(open|no tape)$/i.test(t)) return { unit: '%', v: 0 };
      if (/^closed$/i.test(t)) return { unit: '%', v: 100 };
      const p = RE_PCT.exec(t);
      if (p) return { unit: '%', v: Number(p[1]) };
      const m = RE_MM.exec(t);
      return m ? { unit: 'mm', v: Number(m[1]) } : null;
    },
    /** Brake migration: "2.5% F" … "Disabled" (= 0). */
    migration(s) {
      const t = clean(s);
      if (/^disabled$/i.test(t)) return { unit: '%', v: 0 };
      const m = re(`^${NUM}\\s*%\\s*F$`).exec(t);
      return m ? { unit: '%', v: Number(m[1]) } : null;
    },
  };

  /* ---- the table ------------------------------------------------------------ */

  const CENSUS = 'svm census (811 setups, 26 cars)';
  const WET = 'wet-vs-dry pairs raise it';

  /**
   * One entry per key FAMILY — the key with any -W_FL/-W_FR/-W_RL/-W_RR
   * suffix removed. A family absent from this table cannot be used by a macro
   * (test-setup.js enforces it), which is the rule that keeps a guessed
   * direction from ever shipping. Deliberately absent, for that reason:
   * VM_ENGINE_BRAKEMAP ("N/A" on every car in the census), VM_TORQUE_SPLIT
   * (fixed everywhere), VM_FRONT_WING (never off index 0 on any car).
   */
  const TABLE = {
    VM_BRAKE_BALANCE: {
      quantity: 'rear brake share',
      sign: +1,
      parse: parsers.bias,
      verified: true,
      evidence: `${CENSUS}: every car's "F:R" label moves rearward as the index rises (e.g. BMW M4 19 = 52.2:47.8 … 52 = 44.0:56.0). The .svm calls the key RearBrakeSetting.`,
    },
    VM_BRAKE_MIGRATION: {
      quantity: 'brake migration',
      sign: -1,
      parse: parsers.migration,
      verified: true,
      evidence: 'mfdControl.ts, read off the car: 0 = 2.5% F … 5 = disabled. Not used by any macro.',
    },
    VM_DIFF_POWER: {
      quantity: 'power-side diff lock',
      sign: +1,
      parse: parsers.lock,
      verified: true,
      evidence: `${CENSUS}: LMP2 ramps fall 60 → 55 deg, Hypercar lock rises 25 → 35% as the index rises. Non-adjustable on every LMGT3.`,
    },
    VM_DIFF_COAST: {
      quantity: 'coast-side diff lock',
      sign: +1,
      parse: parsers.lock,
      verified: true,
      evidence: `${CENSUS}: LMP2 ramps fall 45 → 25 deg, Hypercar lock rises 45 → 90% as the index rises. Non-adjustable on every LMGT3.`,
    },
    VM_DIFF_PRELOAD: {
      quantity: 'diff preload',
      sign: +1,
      parse: parsers.preload,
      verified: true,
      evidence: `${CENSUS}: Nm rises with the index on every car; McLaren labels its ends (lowest)/(highest).`,
    },
    VM_ANTILOCKBRAKESYSTEMMAP: {
      quantity: 'ABS stability (LMU: towards "Understeer")',
      sign: +1,
      parse: parsers.abs,
      verified: true,
      evidence: `${CENSUS}: GT3 labels read 6 (Balanced), 7–9 (Understeer). "N/A" on every Hypercar, LMP2 and the GTE.`,
    },
    VM_TRACTIONCONTROLMAP: {
      quantity: 'traction-control intervention',
      sign: +1,
      parse: null,
      verified: true,
      evidence: `Labels are the bare index, so the census cannot say; ${WET} 140 times to 7 across 246 pairs.`,
    },
    VM_TRACTIONCONTROLPOWERCUTMAP: {
      quantity: 'TC power cut',
      sign: +1,
      parse: null,
      verified: true,
      evidence: `Bare-index labels; ${WET} 136 times to 11.`,
    },
    VM_TRACTIONCONTROLSLIPANGLEMAP: {
      quantity: 'TC slip-angle intervention',
      sign: +1,
      parse: null,
      verified: true,
      evidence: `${CENSUS}: index 0 is labelled "0 (Off)"; ${WET} 132 times to 12. Reads "Linked" (follows the TC map) on the Oreca.`,
    },
    VM_FRONT_ANTISWAY: {
      quantity: 'front bar stiffness',
      sign: +1,
      floor: 1,
      parse: parsers.marker,
      verified: true,
      evidence: `${CENSUS}: 0 = "Detached", 1 = "P1 (soft)" … top = "(hard)" on every car that labels its ends.`,
    },
    VM_REAR_ANTISWAY: {
      quantity: 'rear bar stiffness',
      sign: +1,
      floor: 1,
      parse: parsers.marker,
      verified: true,
      evidence: `${CENSUS}: 0 = "Detached", 1 = "P1 (soft)" … top = "(hard)".`,
    },
    VM_FRONT_3RD_SPRING: {
      quantity: 'front third-spring rate',
      sign: +1,
      floor: 1,
      parse: parsers.spring,
      verified: true,
      evidence: `${CENSUS}: Oreca 0 = "N/A", 1 = 1000, 2 = 1400 lbf/in; Hypercars count up from 1. "N/A" on every LMGT3.`,
    },
    VM_REAR_3RD_SPRING: {
      quantity: 'rear third-spring rate',
      sign: +1,
      floor: 1,
      parse: parsers.spring,
      verified: true,
      evidence: `${CENSUS}: Hypercars only (index counts up from 1); "N/A" on the Oreca and every LMGT3.`,
    },
    WM_SPRING: {
      quantity: 'corner spring rate',
      sign: +1,
      parse: parsers.spring,
      verified: true,
      evidence: `${CENSUS}: N/mm and lbf/in rise with the index; GT3 ladders run "1 (soft)" … "(hard)".`,
    },
    WM_SLOWBUMP: { quantity: 'slow bump damping', sign: +1, parse: parsers.marker, verified: true, evidence: `${CENSUS}: "(soft)" at index 0, "(hard)" at the top — even where the click numbers count down.` },
    WM_SLOWREBOUND: { quantity: 'slow rebound damping', sign: +1, parse: parsers.marker, verified: true, evidence: `${CENSUS}: soft at 0, hard at the top.` },
    WM_FASTBUMP: { quantity: 'fast bump damping', sign: +1, parse: parsers.marker, verified: true, evidence: `${CENSUS}: soft at 0, hard at the top.` },
    WM_FASTREBOUND: { quantity: 'fast rebound damping', sign: +1, parse: parsers.marker, verified: true, evidence: `${CENSUS}: soft at 0, hard at the top.` },
    WM_RIDEHEIGHT: { quantity: 'ride height', sign: +1, parse: parsers.length, verified: true, evidence: `${CENSUS}: cm rise with the index on every car.` },
    WM_PACKERS: { quantity: 'packer thickness', sign: +1, parse: parsers.length, verified: true, evidence: `${CENSUS}: 0.0 cm at index 0, rising.` },
    VM_FRONT_3RD_PACKERS: { quantity: 'front third packers', sign: +1, parse: parsers.length, verified: true, evidence: `${CENSUS}: 0.0 cm at index 0, rising.` },
    VM_REAR_3RD_PACKERS: { quantity: 'rear third packers', sign: +1, parse: parsers.length, verified: true, evidence: `${CENSUS}: 0.0 cm at index 0, rising.` },
    WM_CAMBER: {
      quantity: 'camber (towards positive)',
      sign: +1,
      parse: parsers.deg,
      verified: true,
      evidence: `${CENSUS}: a higher index is LESS negative camber on every car (BMW 25 = -2.50 … 40 = -1.00 deg).`,
    },
    WM_PRESSURE: { quantity: 'tyre pressure', sign: +1, parse: parsers.pressure, verified: true, evidence: `${CENSUS}: Oreca 0 = 136, 1 = 137, 3 = 139 kPa. Most cars sit on index 0 (the floor).` },
    VM_FRONT_TOEIN: {
      quantity: 'front toe-in',
      sign: +1,
      parse: parsers.deg,
      verified: true,
      evidence: `${CENSUS}: degrees rise with the index (BMW 0 = -0.937 … 10 = 0.234); positive is toe-in, negative toe-out.`,
    },
    VM_REAR_TOEIN: {
      quantity: 'rear toe-in',
      sign: +1,
      parse: parsers.deg,
      verified: true,
      evidence: `${CENSUS}: degrees rise with the index (Mercedes 15 = -0.059 … 24 = 0.469).`,
    },
    VM_REAR_WING: {
      quantity: 'rear wing',
      sign: +1,
      parse: parsers.wing,
      verified: true,
      evidence: `${CENSUS}: angle or "P" number rises with the index on every car; ${WET} 138 times to 3.`,
    },
    VM_BRAKE_DUCTS: { quantity: 'front duct blanking', sign: +1, parse: parsers.blanking, verified: true, evidence: `${CENSUS}: 0 = "Open", rising to "Closed".` },
    VM_BRAKE_DUCTS_REAR: { quantity: 'rear duct blanking', sign: +1, parse: parsers.blanking, verified: true, evidence: `${CENSUS}: 0 = "Open", rising to "Closed".` },
    VM_WATER_RADIATOR: { quantity: 'radiator blanking', sign: +1, parse: parsers.blanking, verified: true, evidence: `${CENSUS}: 0 = "Open"/"No tape", rising to "Closed"/100%.` },
    VM_OIL_RADIATOR: { quantity: 'oil cooler blanking', sign: +1, parse: parsers.blanking, verified: true, evidence: `${CENSUS}: 0 = "Open"/"No tape", rising to "Closed"/100%.` },
  };

  /** "WM_CAMBER-W_FL" → "WM_CAMBER"; flat keys are their own family. */
  function familyOf(key) {
    return String(key).replace(/-W_(FL|FR|RL|RR)$/, '');
  }

  /** The glob in a macro `match` names its family too: "WM_SPRING-W_R*" → "WM_SPRING". */
  function familyOfMatch(match) {
    return familyOf(String(match).replace(/-W_[A-Z]*\*$/, '-W_FL'));
  }

  function entryFor(key) {
    return TABLE[familyOf(key)] || null;
  }

  /* ---- reading a ladder ------------------------------------------------------ */

  /**
   * Which way a set of (index, label) rungs runs, in the table's terms.
   * Returns { verdict: 'agree'|'disagree'|'mixed'|'unknown', observed, points }
   * — `observed` is +1/-1 when every comparable step agrees on one direction.
   */
  function checkRungs(key, rungs) {
    const entry = entryFor(key);
    if (!entry || !entry.parse) return { verdict: 'unknown', observed: 0, points: 0 };
    const byUnit = new Map();
    for (const [idx, label] of rungs) {
      const p = entry.parse(label);
      if (!p || !Number.isFinite(p.v)) continue;
      if (!byUnit.has(p.unit)) byUnit.set(p.unit, []);
      byUnit.get(p.unit).push([Number(idx), p.v]);
    }
    let up = 0;
    let down = 0;
    let points = 0;
    for (const pts of byUnit.values()) {
      pts.sort((a, b) => a[0] - b[0]);
      points += pts.length;
      for (let i = 1; i < pts.length; i += 1) {
        if (pts[i][0] === pts[i - 1][0]) continue;
        const d = pts[i][1] - pts[i - 1][1];
        if (d > 1e-9) up += 1;
        else if (d < -1e-9) down += 1;
      }
    }
    if (up === 0 && down === 0) return { verdict: 'unknown', observed: 0, points };
    if (up > 0 && down > 0) return { verdict: 'mixed', observed: 0, points };
    const observed = up > 0 ? +1 : -1;
    return { verdict: observed === entry.sign ? 'agree' : 'disagree', observed, points };
  }

  /**
   * The runtime self-check: one key moved from (fromIdx, fromLabel) to
   * (toIdx, toLabel) — did the quantity move the way the table promised?
   */
  function observe(key, fromIdx, fromLabel, toIdx, toLabel) {
    if (fromIdx === toIdx) return { family: familyOf(key), verdict: 'unknown', observed: 0 };
    const r = checkRungs(key, [
      [fromIdx, fromLabel],
      [toIdx, toLabel],
    ]);
    return { family: familyOf(key), verdict: r.verdict, observed: r.observed };
  }

  /* ---- overrides: probe ladders (per class) and self-check flips (per car) -- */

  const ladderSigns = {}; // CLASS -> family -> sign

  /**
   * Feeds probe output (scripts/fixtures/ladders-<class>.json) in. Where a
   * ladder's labels prove a family runs against the table, that class uses
   * the observed sign from then on. Returns what it found, for the test to
   * report — a disagreement means the table above wants correcting.
   */
  function applyLadders(docs) {
    const report = [];
    for (const doc of docs || []) {
      if (!doc || !doc.keys) continue;
      // The probe's file tag ("hypercar-lmh") → the class resolveMacro sees ("HYPERCAR").
      const cls = String(doc.carClass || doc.class || '').split('-')[0].toUpperCase();
      for (const [key, k] of Object.entries(doc.keys)) {
        const labels = Array.isArray(k.labels) ? k.labels : [];
        const base = Number.isFinite(k.min) ? k.min : 0;
        const rungs = labels.map((label, i) => [base + i, label]);
        const r = checkRungs(key, rungs);
        if (r.verdict === 'unknown') continue;
        report.push({ cls, key, family: familyOf(key), verdict: r.verdict, observed: r.observed });
        if (r.verdict === 'disagree' && cls) {
          (ladderSigns[cls] ??= {})[familyOf(key)] = r.observed;
        }
      }
    }
    return report;
  }

  function clearLadders() {
    for (const k of Object.keys(ladderSigns)) delete ladderSigns[k];
  }

  /**
   * The sign to use for `key` on this car: a self-check flip for this very
   * car first, then a probe ladder for its class, then the table. 0 = no
   * entry at all (the macro must skip the key).
   */
  function signFor(key, carClass, flips) {
    const family = familyOf(key);
    if (flips && (flips[family] === 1 || flips[family] === -1)) return flips[family];
    const cls = String(carClass || '').toUpperCase();
    const fromLadder = ladderSigns[cls] && ladderSigns[cls][family];
    if (fromLadder === 1 || fromLadder === -1) return fromLadder;
    const entry = TABLE[family];
    return entry ? entry.sign : 0;
  }

  const FLIPS_KEY = 'apex.setup.directionFlips';

  /** This car's remembered contradictions: { family: sign }. Never throws. */
  function flipsFor(carId) {
    if (!carId) return null;
    try {
      const all = JSON.parse(localStorage.getItem(FLIPS_KEY) || '{}');
      return all && typeof all[carId] === 'object' ? all[carId] : null;
    } catch {
      return null;
    }
  }

  function saveFlip(carId, family, sign) {
    if (!carId || !TABLE[family] || (sign !== 1 && sign !== -1)) return false;
    try {
      const all = JSON.parse(localStorage.getItem(FLIPS_KEY) || '{}') || {};
      all[carId] = { ...(all[carId] || {}), [family]: sign };
      localStorage.setItem(FLIPS_KEY, JSON.stringify(all));
      return true;
    } catch {
      return false;
    }
  }

  return {
    TABLE,
    parsers,
    familyOf,
    familyOfMatch,
    entryFor,
    checkRungs,
    observe,
    applyLadders,
    clearLadders,
    signFor,
    flipsFor,
    saveFlip,
    FLIPS_KEY,
  };
});
