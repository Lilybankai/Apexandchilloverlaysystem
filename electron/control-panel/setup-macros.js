/**
 * setup-macros.js — the race engineer's sliders.
 * -----------------------------------------------------------------------------
 * Each macro turns one intent ("more front turn-in") into weighted nudges on
 * several real setup keys. A macro slider runs -5..+5 clicks; each affected key
 * moves `round(clicks × dir × weight)` steps from its CURRENT value, clamped to
 * the sim's own bounds. Everything is resolved against the live key set — keys
 * this car does not have, or the ruleset locks, are skipped and reported, which
 * is the whole per-class story: an LMP2 simply has no ABS row to nudge.
 *
 * `dir` is in INDEX space (the direction the step index moves), and the signs
 * below encode ladder directions read off the live GT3 census
 * (scripts/fixtures/garage-gt3.json):
 *   - WM_CAMBER: higher index = LESS negative camber
 *   - VM_BRAKE_BALANCE: LOWER index = more FRONT bias
 *   - VM_*_TOEIN: lower index = more toe-out
 *   - ducts/radiators: index 0 = fully OPEN (more cooling, more drag)
 *   - springs/dampers/pressures/ride heights/wing: higher index = stiffer/
 *     higher/more
 * Ladders can differ per car (brake migration's famously descends); these are
 * starting weights to be tuned, and the sim's stringValue is always the truth
 * the UI displays.
 *
 * `classOverrides` keys are normalizeClass() outputs (HYPERCAR, LMP2, GT3…):
 *   { extra: [effects added], reweight: [{match, weight}] } — weight 0 removes.
 *
 * Classic script (window.APEX_SETUP_MACROS) + module.exports for tests.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_SETUP_MACROS = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Slider range in clicks, symmetric about zero. */
  const RANGE = 5;

  const MACROS = [
    {
      id: 'front-turn-in',
      label: 'Front turn-in',
      hint: 'Softer front bar, more front camber, a breath of toe-out.',
      effects: [
        { match: 'VM_FRONT_ANTISWAY', dir: -1, weight: 1.0 },
        { match: 'WM_CAMBER-W_F*', dir: -1, weight: 0.6 },
        { match: 'WM_PRESSURE-W_F*', dir: -1, weight: 0.4 },
        { match: 'VM_FRONT_TOEIN', dir: -1, weight: 0.3 },
      ],
      classOverrides: {
        HYPERCAR: { extra: [{ match: 'VM_TORQUE_SPLIT', dir: -1, weight: 0.4 }] },
      },
    },
    {
      id: 'rear-traction',
      label: 'Rear traction',
      hint: 'Softer rear end, calmer power delivery, a touch of rear toe-in.',
      effects: [
        { match: 'VM_REAR_ANTISWAY', dir: -1, weight: 1.0 },
        { match: 'WM_SPRING-W_R*', dir: -1, weight: 0.7 },
        { match: 'WM_SLOWBUMP-W_R*', dir: -1, weight: 0.4 },
        { match: 'WM_PRESSURE-W_R*', dir: -1, weight: 0.3 },
        { match: 'VM_REAR_TOEIN', dir: +1, weight: 0.3 },
      ],
    },
    {
      id: 'mid-corner-stability',
      label: 'Mid-corner stability',
      hint: 'More rear wing, less rake, a steadier diff.',
      effects: [
        { match: 'VM_REAR_WING', dir: +1, weight: 1.0 },
        { match: 'WM_RIDEHEIGHT-W_R*', dir: -1, weight: 0.4 },
        { match: 'VM_FRONT_ANTISWAY', dir: +1, weight: 0.3 },
        { match: 'VM_DIFF_PRELOAD', dir: +1, weight: 0.3 },
      ],
    },
    {
      id: 'top-speed',
      label: 'Top speed',
      hint: 'Trim wing, tape ducts and radiators. Watch temperatures.',
      effects: [
        { match: 'VM_REAR_WING', dir: -1, weight: 1.0 },
        { match: 'VM_FRONT_WING', dir: -1, weight: 0.5 },
        { match: 'VM_BRAKE_DUCTS', dir: +1, weight: 0.4 },
        { match: 'VM_BRAKE_DUCTS_REAR', dir: +1, weight: 0.4 },
        { match: 'VM_WATER_RADIATOR', dir: +1, weight: 0.3 },
        { match: 'VM_OIL_RADIATOR', dir: +1, weight: 0.3 },
      ],
    },
    {
      id: 'kerb-compliance',
      label: 'Softer over kerbs',
      hint: 'Softer fast damping, fewer packers, a little more clearance.',
      effects: [
        { match: 'WM_FASTBUMP-W_*', dir: -1, weight: 1.0 },
        { match: 'WM_SLOWBUMP-W_*', dir: -1, weight: 0.6 },
        { match: 'WM_FASTREBOUND-W_*', dir: -1, weight: 0.5 },
        { match: 'WM_PACKERS-W_*', dir: -1, weight: 0.4 },
        { match: 'WM_RIDEHEIGHT-W_*', dir: +1, weight: 0.4 },
      ],
    },
    {
      id: 'tyre-temps',
      label: 'Cooler tyres',
      hint: 'Lower pressures, stand the tyres up, open the ducts.',
      effects: [
        { match: 'WM_PRESSURE-W_*', dir: -1, weight: 0.7 },
        { match: 'WM_CAMBER-W_*', dir: +1, weight: 0.5 },
        { match: 'VM_BRAKE_DUCTS', dir: -1, weight: 0.4 },
        { match: 'VM_BRAKE_DUCTS_REAR', dir: -1, weight: 0.4 },
      ],
    },
    {
      id: 'power-rotation',
      label: 'Rotation on power',
      hint: 'Freer diff on throttle, a livelier rear.',
      effects: [
        { match: 'VM_DIFF_POWER', dir: -1, weight: 1.0 },
        { match: 'VM_DIFF_PRELOAD', dir: -1, weight: 0.5 },
        { match: 'VM_REAR_TOEIN', dir: -1, weight: 0.3 },
      ],
    },
    {
      id: 'braking-stability',
      label: 'Braking stability',
      hint: 'Bias forward, hold the front platform, settle the rear.',
      effects: [
        { match: 'VM_BRAKE_BALANCE', dir: -1, weight: 1.0 },
        { match: 'WM_SLOWREBOUND-W_F*', dir: +1, weight: 0.3 },
        { match: 'VM_ENGINE_BRAKEMAP', dir: -1, weight: 0.3 },
        { match: 'VM_REAR_TOEIN', dir: +1, weight: 0.3 },
      ],
    },
    {
      id: 'response',
      label: 'Sharper response',
      hint: 'Stiffer everywhere, lower everywhere. Costs compliance.',
      effects: [
        { match: 'VM_FRONT_ANTISWAY', dir: +1, weight: 0.8 },
        { match: 'VM_REAR_ANTISWAY', dir: +1, weight: 0.8 },
        { match: 'WM_SPRING-W_*', dir: +1, weight: 0.5 },
        { match: 'WM_RIDEHEIGHT-W_*', dir: -1, weight: 0.4 },
        { match: 'WM_SLOWBUMP-W_*', dir: +1, weight: 0.3 },
      ],
    },
    {
      id: 'bumpy-track',
      label: 'Bumpy-track compliance',
      hint: 'Softer springs and rebound, more clearance to breathe.',
      effects: [
        { match: 'WM_SPRING-W_*', dir: -1, weight: 0.8 },
        { match: 'WM_SLOWREBOUND-W_*', dir: -1, weight: 0.6 },
        { match: 'WM_RIDEHEIGHT-W_*', dir: +1, weight: 0.5 },
        { match: 'WM_FASTREBOUND-W_*', dir: -1, weight: 0.4 },
      ],
    },
  ];

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
   * Resolves a macro at `clicks` against the current settings.
   *
   * `settings` is a Map key → { value, min, max, isFree, available } where
   * `value` should already include anything previously staged, so macros
   * compound instead of fighting each other.
   *
   * Returns { changes: [{key, from, to}], skipped: [{key|match, reason}] }.
   * Pure — no DOM, no I/O — so scripts/test-setup.js can pin it to fixtures.
   */
  function resolveMacro(macro, clicks, settings, carClass) {
    let effects = macro.effects.slice();
    const ov = macro.classOverrides ? macro.classOverrides[carClass] : null;
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

    const keys = Array.from(settings.keys());
    const changes = [];
    const skipped = [];
    for (const e of effects) {
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
        const to = Math.min(s.max, Math.max(s.min, s.value + delta));
        if (to !== s.value) changes.push({ key, from: s.value, to });
      }
    }
    return { changes, skipped };
  }

  return { RANGE, MACROS, resolveMacro, expandMatch };
});
