/**
 * setup-tags.js — character tags for shared setups: what a tune FEELS like,
 * read from its numbers.
 * -----------------------------------------------------------------------------
 * The suggester never sees physical units — setup values are step indices —
 * so every judgement is made on the value's normalised position inside the
 * car's own [min, max] range, which needs the live garage bounds. That is why
 * suggest() takes the editor's settingsMap: with the right car in the garage
 * the suggestions are honest; with no car (or the wrong one) it returns
 * nothing and the uploader picks chips by hand.
 *
 * These are heuristics about tendencies, not lap-time truths, which is exactly
 * why the uploader can toggle any of them off (or on) before publishing.
 */

(function () {
  'use strict';

  /** Every tag a setup can carry — the suggester only ever picks from these. */
  const PRESETS = [
    'Sharp turn-in',
    'Stable & safe',
    'Strong front end',
    'High downforce',
    'Low drag',
    'Planted on throttle',
    'Rotates on throttle',
    'Wet',
    'Hotlap',
    'Endurance',
    'Kerb-friendly',
    'Fuel save',
  ];

  /** Normalised 0..1 position of a value inside the car's own range. */
  function norm(values, settingsMap, key) {
    const s = settingsMap.get(key);
    const v = values[key];
    if (!s || typeof v !== 'number' || !(s.max > s.min)) return null;
    return (Math.min(s.max, Math.max(s.min, v)) - s.min) / (s.max - s.min);
  }

  /** Mean normalised position across a WM family's fitted corners. */
  function cornerNorm(values, settingsMap, family, corners) {
    const ns = corners
      .map((c) => norm(values, settingsMap, `${family}-W_${c}`))
      .filter((n) => n !== null);
    if (!ns.length) return null;
    return ns.reduce((a, b) => a + b, 0) / ns.length;
  }

  /**
   * Suggests tags for a tune. `values` is the entry's REST key space map,
   * `settingsMap` the live editor's key -> {min, max, ...} — bounds for THIS
   * car. Returns [] when the bounds cannot vouch for the numbers.
   */
  function suggest(values, settingsMap) {
    if (!values || !settingsMap || settingsMap.size === 0) return [];
    const tags = [];

    const rearWing = norm(values, settingsMap, 'VM_REAR_WING');
    const frontWing = norm(values, settingsMap, 'VM_FRONT_WING');
    const frontArb = norm(values, settingsMap, 'VM_FRONT_ANTISWAY');
    const rearArb = norm(values, settingsMap, 'VM_REAR_ANTISWAY');
    const diffPower = norm(values, settingsMap, 'VM_DIFF_POWER');
    const frontSpring = cornerNorm(values, settingsMap, 'WM_SPRING', ['FL', 'FR']);
    const rearSpring = cornerNorm(values, settingsMap, 'WM_SPRING', ['RL', 'RR']);

    // Aero load: where the rear wing sits in its own range tells the story.
    if (rearWing !== null) {
      if (rearWing >= 0.65) tags.push('High downforce');
      else if (rearWing <= 0.35) tags.push('Low drag');
    }

    // Balance: signals that shift grip toward the front (sharper) or the rear
    // (safer). Each is a signed difference in normalised space; their mean is
    // the verdict. Front wing up, rear ARB up, rear springs up = sharper.
    const sharpness = [];
    if (frontWing !== null && rearWing !== null) sharpness.push(frontWing - rearWing);
    if (frontArb !== null && rearArb !== null) sharpness.push(rearArb - frontArb);
    if (frontSpring !== null && rearSpring !== null) sharpness.push(rearSpring - frontSpring);
    if (sharpness.length) {
      const s = sharpness.reduce((a, b) => a + b, 0) / sharpness.length;
      if (s >= 0.12) tags.push('Sharp turn-in');
      else if (s <= -0.12) tags.push('Stable & safe');
    }

    // A big front wing with a soft front end is its own statement.
    if (frontWing !== null && frontArb !== null && frontWing >= 0.6 && frontArb <= 0.4) {
      tags.push('Strong front end');
    }

    // Power diff lock: high = the rear axle drives out as one (planted),
    // low = the inside wheel lets the car keep rotating under throttle.
    if (diffPower !== null) {
      if (diffPower >= 0.65) tags.push('Planted on throttle');
      else if (diffPower <= 0.35) tags.push('Rotates on throttle');
    }

    return tags;
  }

  window.APEX_SETUP_TAGS = { PRESETS, suggest };
})();
