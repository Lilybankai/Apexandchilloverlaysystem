/**
 * setup-macros.js — the race engineer's sliders.
 * -----------------------------------------------------------------------------
 * Each macro turns one intent ("more rotation in slow corners, on the brakes")
 * into weighted nudges on several real setup keys. A macro slider runs -5..+5
 * clicks; each affected key moves `round(clicks × dir × weight)` steps from its
 * CURRENT value, clamped to the sim's own bounds. Everything is resolved
 * against the live key set — keys this car does not have, or the ruleset
 * locks, are skipped and reported, which is the whole per-class story: an
 * LMP2 simply has no ABS row to nudge.
 *
 * Two groups (GROUPS below):
 *   - balance    — "Corner balance", split by corner speed and, for slow
 *                  corners, by phase. Every one is a BALANCE slider:
 *                  -5 = more stable / more understeer, +5 = more rotation.
 *   - conditions — "Track & conditions": top speed, kerbs, tyre heat, bumps.
 *
 * Effects say what they want in PHYSICAL terms — `want: +1` means "more of
 * this key's quantity for +clicks" (more rear brake share, more toe-in, a
 * stiffer bar…) — and setup-directions.js turns that into an index direction.
 * No sign in this file is a guess about a ladder: a key whose family has no
 * entry in the direction table cannot move at all.
 *
 * Weights: 1.0 primary, 0.8/0.6 strong, 0.4 secondary, 0.2 minor. They are
 * chosen so that clicks × weight never lands on .5 — so + and − are exact
 * mirror images whatever rounding rule is in force — and so that ±1 click
 * moves the primary and strong levers only, ±2 brings in the secondaries,
 * ±3 the minors.
 *
 * `classOverrides` keys are normalizeClass() outputs (HYPERCAR, LMP2, GT3…;
 * LMP2_ELMS falls back to LMP2): { extra: [effects added],
 * reweight: [{match, weight}] } — weight 0 removes. Removing what a class
 * genuinely lacks keeps the "N skipped" count meaningful: it should only ever
 * name something THIS car has locked or detached, never a part the whole
 * class was built without. The class facts come from the svm census (see
 * setup-directions.js): diff power/coast are non-adjustable on every LMGT3,
 * GT3s have no third springs, ABS is "N/A" on every prototype and the GTE,
 * the Oreca's slip-angle TC reads "Linked", and only Hypercars have a rear
 * third spring.
 *
 * Classic script (window.APEX_SETUP_MACROS) + module.exports for tests.
 * Needs setup-directions.js loaded first (index.html orders them).
 */

(function (root, factory) {
  'use strict';
  const dirs =
    typeof module === 'object' && module.exports
      ? require('./setup-directions.js')
      : root && root.APEX_SETUP_DIRECTIONS;
  const api = factory(dirs, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_SETUP_MACROS = api;
})(typeof window !== 'undefined' ? window : null, function (dirsAtLoad, root) {
  'use strict';

  /** Slider range in clicks, symmetric about zero. */
  const RANGE = 5;

  /** Headings, in panel order. Every macro names one of these ids. */
  const GROUPS = [
    {
      id: 'balance',
      label: 'Corner balance',
      hint: 'Each slider is a balance: left (−5) makes the car calmer and more stable, with more understeer; right (+5) makes it rotate more.',
      ends: ['Stable', 'Rotation'],
    },
    {
      id: 'conditions',
      label: 'Track & conditions',
      hint: 'Trade-offs for the track and the day rather than for the balance.',
    },
  ];

  /** Coast ramps read "Non-adjustable" on every LMGT3 (and the GTE) in the census. */
  const GT3_NO_DIFF_RAMPS = { match: 'VM_DIFF_COAST', weight: 0 };

  const MACROS = [
    /* ---- Corner balance ------------------------------------------------- */
    {
      id: 'slow-entry',
      group: 'balance',
      label: 'Slow entry',
      hint: 'Hairpins and chicanes, on the brakes and turning in. Right = the car rotates into the corner more; left = it is calmer and more stable on the brakes.',
      effects: [
        { match: 'VM_BRAKE_BALANCE', want: +1, weight: 1.0 }, // bias rearward
        { match: 'VM_DIFF_COAST', want: -1, weight: 1.0 }, // less coast lock
        { match: 'VM_DIFF_PRELOAD', want: -1, weight: 0.6 },
        { match: 'VM_ANTILOCKBRAKESYSTEMMAP', want: -1, weight: 0.4 }, // away from "Understeer"
        { match: 'WM_SLOWBUMP-W_F*', want: -1, weight: 0.4 },
        { match: 'WM_SLOWREBOUND-W_R*', want: +1, weight: 0.4 },
        { match: 'VM_REAR_TOEIN', want: -1, weight: 0.2 },
      ],
      classOverrides: {
        GT3: { reweight: [GT3_NO_DIFF_RAMPS] },
        GTE: { reweight: [GT3_NO_DIFF_RAMPS, { match: 'VM_ANTILOCKBRAKESYSTEMMAP', weight: 0 }] },
        HYPERCAR: { reweight: [{ match: 'VM_ANTILOCKBRAKESYSTEMMAP', weight: 0 }] },
        LMP2: { reweight: [{ match: 'VM_ANTILOCKBRAKESYSTEMMAP', weight: 0 }] },
        LMP3: { reweight: [{ match: 'VM_ANTILOCKBRAKESYSTEMMAP', weight: 0 }] },
      },
    },
    {
      id: 'slow-mid',
      group: 'balance',
      label: 'Slow mid',
      hint: 'The middle of slow corners — off the brakes, not yet on the power. Right = the nose follows the wheel and the car turns; left = it settles into understeer.',
      effects: [
        { match: 'VM_FRONT_ANTISWAY', want: -1, weight: 1.0 },
        { match: 'VM_REAR_ANTISWAY', want: +1, weight: 1.0 },
        { match: 'WM_SPRING-W_F*', want: -1, weight: 0.4 },
        { match: 'WM_SPRING-W_R*', want: +1, weight: 0.4 },
        { match: 'WM_RIDEHEIGHT-W_R*', want: +1, weight: 0.2 }, // a touch more rake
        { match: 'WM_RIDEHEIGHT-W_F*', want: -1, weight: 0.2 },
        { match: 'VM_DIFF_PRELOAD', want: -1, weight: 0.2 },
      ],
    },
    {
      id: 'slow-exit',
      group: 'balance',
      label: 'Slow exit',
      hint: 'Getting back on the power out of slow corners. Right = the rear helps steer the car out; left = more traction and a calmer rear.',
      effects: [
        { match: 'VM_TRACTIONCONTROLMAP', want: -1, weight: 1.0 },
        { match: 'VM_DIFF_POWER', want: -1, weight: 1.0 }, // less power lock
        { match: 'VM_REAR_ANTISWAY', want: +1, weight: 0.6 },
        { match: 'VM_TRACTIONCONTROLPOWERCUTMAP', want: -1, weight: 0.4 },
        { match: 'VM_TRACTIONCONTROLSLIPANGLEMAP', want: -1, weight: 0.4 },
        { match: 'WM_SPRING-W_R*', want: +1, weight: 0.4 },
      ],
      classOverrides: {
        GT3: { reweight: [{ match: 'VM_DIFF_POWER', weight: 0 }] },
        GTE: { reweight: [{ match: 'VM_DIFF_POWER', weight: 0 }] },
        // The Oreca's slip-angle map reads "Linked" — it follows the TC map.
        LMP2: { reweight: [{ match: 'VM_TRACTIONCONTROLSLIPANGLEMAP', weight: 0 }] },
      },
    },
    {
      id: 'medium',
      group: 'balance',
      label: 'Medium corners',
      hint: 'Third- and fourth-gear corners, where the aero starts to help. Right = more rotation; left = more stable.',
      effects: [
        { match: 'VM_FRONT_ANTISWAY', want: -1, weight: 0.8 },
        { match: 'VM_REAR_ANTISWAY', want: +1, weight: 0.8 },
        { match: 'WM_RIDEHEIGHT-W_R*', want: +1, weight: 0.6 }, // rake
        { match: 'WM_RIDEHEIGHT-W_F*', want: -1, weight: 0.6 },
        { match: 'VM_REAR_WING', want: -1, weight: 0.4 },
        { match: 'WM_SLOWBUMP-W_F*', want: -1, weight: 0.2 },
        { match: 'VM_DIFF_PRELOAD', want: -1, weight: 0.2 },
      ],
    },
    {
      id: 'fast',
      group: 'balance',
      label: 'Fast corners',
      hint: 'High-speed sweepers, where the wing does the work. Right = a freer car that turns in on the aero; left = a planted, more stable one.',
      effects: [
        { match: 'VM_REAR_WING', want: -1, weight: 1.0 },
        { match: 'WM_RIDEHEIGHT-W_R*', want: +1, weight: 0.8 }, // rake
        { match: 'WM_RIDEHEIGHT-W_F*', want: -1, weight: 0.8 },
        { match: 'VM_REAR_3RD_SPRING', want: +1, weight: 0.4 },
        { match: 'VM_FRONT_3RD_SPRING', want: -1, weight: 0.4 },
        { match: 'VM_FRONT_ANTISWAY', want: -1, weight: 0.2 },
        { match: 'VM_REAR_ANTISWAY', want: +1, weight: 0.2 },
        { match: 'WM_PACKERS-W_F*', want: -1, weight: 0.2 },
      ],
      classOverrides: {
        // Less wing to work with and no third springs: lean on the bars, the
        // rake and the diff instead.
        GT3: {
          reweight: [
            { match: 'VM_REAR_WING', weight: 0.8 },
            { match: 'VM_REAR_3RD_SPRING', weight: 0 },
            { match: 'VM_FRONT_3RD_SPRING', weight: 0 },
            { match: 'VM_FRONT_ANTISWAY', weight: 0.6 },
            { match: 'VM_REAR_ANTISWAY', weight: 0.6 },
          ],
          extra: [{ match: 'VM_DIFF_PRELOAD', want: -1, weight: 0.4 }],
        },
        GTE: {
          reweight: [
            { match: 'VM_REAR_3RD_SPRING', weight: 0 },
            { match: 'VM_FRONT_3RD_SPRING', weight: 0 },
          ],
        },
        LMP2: { reweight: [{ match: 'VM_REAR_3RD_SPRING', weight: 0 }] },
      },
    },

    /* ---- Track & conditions ---------------------------------------------- */
    {
      id: 'top-speed',
      group: 'conditions',
      label: 'Top speed',
      hint: 'Trim the wing, tape the ducts and radiators. Watch temperatures.',
      effects: [
        { match: 'VM_REAR_WING', want: -1, weight: 1.0 },
        { match: 'VM_BRAKE_DUCTS', want: +1, weight: 0.4 }, // more blanking
        { match: 'VM_BRAKE_DUCTS_REAR', want: +1, weight: 0.4 },
        { match: 'VM_WATER_RADIATOR', want: +1, weight: 0.2 },
        { match: 'VM_OIL_RADIATOR', want: +1, weight: 0.2 },
      ],
    },
    {
      id: 'kerb-compliance',
      group: 'conditions',
      label: 'Softer over kerbs',
      hint: 'Softer fast damping, fewer packers, a little more clearance.',
      effects: [
        { match: 'WM_FASTBUMP-W_*', want: -1, weight: 1.0 },
        { match: 'WM_SLOWBUMP-W_*', want: -1, weight: 0.6 },
        { match: 'WM_FASTREBOUND-W_*', want: -1, weight: 0.4 },
        { match: 'WM_PACKERS-W_*', want: -1, weight: 0.4 },
        { match: 'WM_RIDEHEIGHT-W_*', want: +1, weight: 0.4 },
      ],
    },
    {
      id: 'tyre-temps',
      group: 'conditions',
      label: 'Cooler tyres',
      hint: 'Lower pressures, stand the tyres up, open the ducts.',
      effects: [
        { match: 'WM_PRESSURE-W_*', want: -1, weight: 0.6 },
        { match: 'WM_CAMBER-W_*', want: +1, weight: 0.4 }, // less negative
        { match: 'VM_BRAKE_DUCTS', want: -1, weight: 0.4 }, // more open
        { match: 'VM_BRAKE_DUCTS_REAR', want: -1, weight: 0.4 },
      ],
    },
    {
      id: 'bumpy-track',
      group: 'conditions',
      label: 'Bumpy-track compliance',
      hint: 'Softer springs and rebound, more clearance to breathe.',
      effects: [
        { match: 'WM_SPRING-W_*', want: -1, weight: 0.8 },
        { match: 'WM_SLOWREBOUND-W_*', want: -1, weight: 0.6 },
        { match: 'WM_RIDEHEIGHT-W_*', want: +1, weight: 0.4 },
        { match: 'WM_FASTREBOUND-W_*', want: -1, weight: 0.4 },
      ],
    },
  ];

  /** Classes that share another's override block. */
  const CLASS_FALLBACK = { LMP2_ELMS: 'LMP2' };

  function dirsApi() {
    return dirsAtLoad || (root && root.APEX_SETUP_DIRECTIONS) || null;
  }

  /**
   * Expands one `match` against the keys that actually exist. Globs only in
   * the corner suffix: `-W_F*` → FL/FR, `-W_R*` → RL/RR, `-W_*` → all four.
   * Everything else is an exact key.
   */
  function expandMatch(match, keys) {
    const star = match.indexOf('*');
    if (star === -1) return keys.includes(match) ? [match] : [];
    const prefix = match.slice(0, star);
    return keys.filter((k) => k.startsWith(prefix));
  }

  /**
   * The effects a macro applies on this class, each with `dir` (the INDEX
   * direction for +clicks, from the direction table: want × sign, 0 when the
   * family has no entry) and `floor` (the lowest real index). `flips` is the
   * self-check's per-car correction map, if any.
   */
  function effectsFor(macro, carClass, flips) {
    let effects = macro.effects.slice();
    const overrides = macro.classOverrides || {};
    const ov = overrides[carClass] || overrides[CLASS_FALLBACK[carClass]] || null;
    if (ov) {
      if (Array.isArray(ov.reweight)) {
        for (const rw of ov.reweight) {
          effects = effects
            .map((e) => (e.match === rw.match ? { ...e, weight: rw.weight } : e))
            .filter((e) => e.weight !== 0);
        }
      }
      if (Array.isArray(ov.extra)) effects = effects.concat(ov.extra);
    }
    const dirs = dirsApi();
    return effects.map((e) => {
      const family = dirs ? dirs.familyOfMatch(e.match) : '';
      const entry = dirs ? dirs.TABLE[family] : null;
      const sign = dirs ? dirs.signFor(family, carClass, flips) : 0;
      return { ...e, dir: (e.want || 0) * sign, floor: entry && entry.floor ? entry.floor : 0 };
    });
  }

  /**
   * Resolves a macro at `clicks` against the current settings.
   *
   * `settings` is a Map key → { value, min, max, isFree, available } where
   * `value` should already include anything previously staged, so macros
   * compound instead of fighting each other. `opts.flips` carries this car's
   * self-check corrections (setup-directions.js flipsFor).
   *
   * Returns { changes: [{key, from, to}], skipped: [{key|match, reason}] }.
   * Pure — no DOM, no I/O — so scripts/test-setup.js can pin it to fixtures.
   */
  function resolveMacro(macro, clicks, settings, carClass, opts) {
    const effects = effectsFor(macro, carClass, opts && opts.flips);

    const keys = Array.from(settings.keys());
    const changes = [];
    const skipped = [];
    for (const e of effects) {
      if (e.dir === 0) {
        if (clicks !== 0) skipped.push({ match: e.match, reason: 'direction unknown' });
        continue;
      }
      const delta = Math.round(clicks * e.dir * e.weight);
      if (delta === 0) continue;
      const targets = expandMatch(e.match, keys);
      if (targets.length === 0) {
        skipped.push({ match: e.match, reason: 'not on this car' });
        continue;
      }
      for (const key of targets) {
        const s = settings.get(key);
        if (!s || s.available === false) {
          skipped.push({ key, reason: 'not on this car' });
          continue;
        }
        if (s.isFree === false) {
          skipped.push({ key, reason: 'fixed by ruleset' });
          continue;
        }
        if (s.min >= s.max) {
          skipped.push({ key, reason: 'not adjustable' });
          continue;
        }
        // "Detached" / "N/A" below the floor is a choice, not a soft setting:
        // never step onto it, and leave a car that is already there alone.
        const floor = Math.max(s.min, e.floor || 0);
        if (s.value < floor) {
          skipped.push({ key, reason: 'detached' });
          continue;
        }
        const to = Math.min(s.max, Math.max(floor, s.value + delta));
        if (to !== s.value) changes.push({ key, from: s.value, to });
      }
    }
    return { changes, skipped };
  }

  return { RANGE, GROUPS, MACROS, resolveMacro, expandMatch, effectsFor };
});
