/**
 * setup-groups.js — where every garage key lives in the setup editor.
 * -----------------------------------------------------------------------------
 * The editor mirrors LMU's six garage pages. LMU itself never says which page a
 * key belongs to — `getPlayerGarageData` is one flat object — so this map is
 * the editor's opinion, frozen from live dumps (scripts/probe-garage-keys.js).
 *
 * Three layers, so a key can never be invisible:
 *   1. EXPLICIT — every key seen in a live dump, placed by hand.
 *   2. PATTERNS — ordered regexes that catch anything a game patch adds where
 *      the name makes the home obvious (a new VM_GEAR_10 is still a gear).
 *   3. CATCH-ALL — whatever is left renders in BASIC · Other, visibly homeless,
 *      and the probe script lists it so it can be placed properly.
 *
 * Per-corner keys (WM_CAMBER-W_FL …) are classified by FAMILY (WM_CAMBER): one
 * editor row shows all four corners, so the family is the unit that has a home.
 *
 * Loaded as a classic script by the panel (window.APEX_SETUP_GROUPS) and
 * require()d by scripts/probe-garage-keys.js and scripts/test-setup.js — keep
 * it dependency-free and side-effect-free.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_SETUP_GROUPS = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Tab display order — mirrors LMU's garage page order. */
  const TABS = ['BASIC', 'POWERTRAIN', 'WHEELS & BRAKES', 'SUSPENSION', 'DAMPERS', 'CHASSIS & AERO'];

  /**
   * Explicit homes, in display order. `keys` entries are either full VM_ keys
   * or WM_ FAMILY names (no -W_XX suffix — the editor renders families as
   * four-corner rows).
   */
  const GROUPS = [
    // ── BASIC ────────────────────────────────────────────────────────────
    { tab: 'BASIC', section: 'Fuel & strategy', keys: [
      'VM_FUEL_LEVEL', 'VM_VIRTUAL_ENERGY', 'VM_FUEL_CAPACITY',
      'VM_NUM_PITSTOPS', 'VM_PITSTOP_1', 'VM_PITSTOP_2', 'VM_PITSTOP_3',
    ] },
    { tab: 'BASIC', section: 'Driver aids', keys: [
      'VM_TRACTION_CONTROL', 'VM_TRACTIONCONTROLMAP', 'VM_TRACTIONCONTROLSLIPANGLEMAP',
      'VM_TRACTIONCONTROLPOWERCUTMAP', 'VM_ANTILOCK_BRAKES', 'VM_ANTILOCKBRAKESYSTEMMAP',
    ] },
    { tab: 'BASIC', section: 'Steering', keys: ['VM_STEER_LOCK'] },

    // ── POWERTRAIN ───────────────────────────────────────────────────────
    { tab: 'POWERTRAIN', section: 'Engine', keys: [
      'VM_ENGINE_MIXTURE', 'VM_REV_LIMITER', 'VM_ENGINE_BOOST', 'VM_ENGINE_BRAKEMAP',
    ] },
    { tab: 'POWERTRAIN', section: 'Hybrid', keys: [
      'VM_ELECTRIC_MOTOR_MAP', 'VM_REGEN_LEVEL', 'VM_TORQUE_SPLIT',
    ] },
    { tab: 'POWERTRAIN', section: 'Cooling', keys: ['VM_WATER_RADIATOR', 'VM_OIL_RADIATOR'] },
    { tab: 'POWERTRAIN', section: 'Gearbox', keys: [
      'VM_RATIO_SET', 'VM_GEAR_FINAL',
      'VM_GEAR_1', 'VM_GEAR_2', 'VM_GEAR_3', 'VM_GEAR_4', 'VM_GEAR_5',
      'VM_GEAR_6', 'VM_GEAR_7', 'VM_GEAR_8', 'VM_GEAR_9', 'VM_GEAR_REVERSE',
      'VM_GEAR_AUTOUPSHIFT', 'VM_GEAR_AUTODOWNSHIFT',
      'VM_GEAR_UPSHIFT_RPM_1', 'VM_GEAR_UPSHIFT_RPM_2', 'VM_GEAR_UPSHIFT_RPM_3',
      'VM_GEAR_UPSHIFT_RPM_4', 'VM_GEAR_UPSHIFT_RPM_5', 'VM_GEAR_UPSHIFT_RPM_6',
      'VM_GEAR_UPSHIFT_RPM_7', 'VM_GEAR_UPSHIFT_RPM_8',
    ] },
    { tab: 'POWERTRAIN', section: 'Differential', keys: [
      'VM_DIFF_POWER', 'VM_DIFF_COAST', 'VM_DIFF_PRELOAD', 'VM_DIFF_PUMP',
      'VM_FRONT_DIFF_POWER', 'VM_FRONT_DIFF_COAST', 'VM_FRONT_DIFF_PRELOAD', 'VM_FRONT_DIFF_PUMP',
    ] },

    // ── WHEELS & BRAKES ──────────────────────────────────────────────────
    { tab: 'WHEELS & BRAKES', section: 'Tyres', keys: [
      'WM_COMPOUND', 'WM_PRESSURE', 'WM_SRUBBER',
      'VM_FRONT_TIRE_COMPOUND', 'VM_REAR_TIRE_COMPOUND',
    ] },
    { tab: 'WHEELS & BRAKES', section: 'Alignment', keys: [
      'WM_CAMBER', 'VM_FRONT_TOEIN', 'VM_REAR_TOEIN',
      'VM_FRONT_TOEOFFSET', 'VM_REAR_TOEOFFSET', 'VM_LEFT_CASTER', 'VM_RIGHT_CASTER',
    ] },
    { tab: 'WHEELS & BRAKES', section: 'Brakes', keys: [
      'VM_BRAKE_PRESSURE', 'VM_BRAKE_BALANCE', 'VM_BRAKE_MIGRATION',
      'WM_BRAKEDISC', 'WM_BRAKEPAD',
      'VM_BRAKE_DUCTS', 'VM_BRAKE_DUCTS_REAR',
      'VM_HANDBRAKE_PRESSURE', 'VM_HANDFRONTBRAKE_PRESSURE',
    ] },

    // ── SUSPENSION ───────────────────────────────────────────────────────
    { tab: 'SUSPENSION', section: 'Springs', keys: [
      'WM_SPRING', 'WM_TENDERSPRING', 'WM_TENDERSPRINGTRAVEL',
    ] },
    { tab: 'SUSPENSION', section: 'Ride height & travel', keys: ['WM_RIDEHEIGHT', 'WM_PACKERS'] },
    { tab: 'SUSPENSION', section: 'Anti-roll bars', keys: ['VM_FRONT_ANTISWAY', 'VM_REAR_ANTISWAY'] },
    { tab: 'SUSPENSION', section: 'Geometry', keys: [
      'VM_LEFT_TRACK_BAR', 'VM_RIGHT_TRACK_BAR', 'VM_FRONT_WHEEL_TRACK', 'VM_REAR_WHEEL_TRACK',
    ] },

    // ── DAMPERS ──────────────────────────────────────────────────────────
    { tab: 'DAMPERS', section: 'Corner dampers', keys: [
      'WM_SLOWBUMP', 'WM_FASTBUMP', 'WM_SLOWREBOUND', 'WM_FASTREBOUND',
    ] },
    { tab: 'DAMPERS', section: 'Third element — front', keys: [
      'VM_FRONT_3RD_SPRING', 'VM_FRONT_3RD_PACKERS',
      'VM_FRONT_3RD_SLOWBUMP', 'VM_FRONT_3RD_FASTBUMP',
      'VM_FRONT_3RD_SLOWREBOUND', 'VM_FRONT_3RD_FASTREBOUND',
      'VM_FRONT_3RD_TENDERSPRING', 'VM_FRONT_3RD_TENDERSPRINGTRAVEL',
    ] },
    { tab: 'DAMPERS', section: 'Third element — rear', keys: [
      'VM_REAR_3RD_SPRING', 'VM_REAR_3RD_PACKERS',
      'VM_REAR_3RD_SLOWBUMP', 'VM_REAR_3RD_FASTBUMP',
      'VM_REAR_3RD_SLOWREBOUND', 'VM_REAR_3RD_FASTREBOUND',
      'VM_REAR_3RD_TENDERSPRING', 'VM_REAR_3RD_TENDERSPRINGTRAVEL',
    ] },

    // ── CHASSIS & AERO ───────────────────────────────────────────────────
    { tab: 'CHASSIS & AERO', section: 'Aero', keys: [
      'VM_FRONT_WING', 'VM_REAR_WING', 'VM_LEFT_FENDER_FLARE', 'VM_RIGHT_FENDER_FLARE',
    ] },
    { tab: 'CHASSIS & AERO', section: 'Weight', keys: [
      'VM_WEIGHT_DISTRIB', 'VM_WEIGHT_LATERAL', 'VM_WEIGHT_VERTICAL', 'VM_WEIGHT_WEDGE',
    ] },
    { tab: 'CHASSIS & AERO', section: 'Chassis adjustments', keys: [
      'VM_CHASSIS_ADJ_00', 'VM_CHASSIS_ADJ_01', 'VM_CHASSIS_ADJ_02', 'VM_CHASSIS_ADJ_03',
      'VM_CHASSIS_ADJ_04', 'VM_CHASSIS_ADJ_05', 'VM_CHASSIS_ADJ_06', 'VM_CHASSIS_ADJ_07',
      'VM_CHASSIS_ADJ_08', 'VM_CHASSIS_ADJ_09', 'VM_CHASSIS_ADJ_10', 'VM_CHASSIS_ADJ_11',
    ] },
  ];

  /**
   * Pattern fallback for keys no dump has shown yet, most-specific first.
   * The first match wins, so e.g. BRAKE_DUCT must beat the generic /DUCT/.
   */
  const PATTERNS = [
    { re: /^VM_GEAR_/, tab: 'POWERTRAIN', section: 'Gearbox' },
    { re: /DIFF/, tab: 'POWERTRAIN', section: 'Differential' },
    { re: /RADIATOR|GRILLE|COOL/, tab: 'POWERTRAIN', section: 'Cooling' },
    { re: /BATTERY|DEPLOY|REGEN|MOTOR|TORQUE_SPLIT|MGU/, tab: 'POWERTRAIN', section: 'Hybrid' },
    { re: /MIXTURE|BOOST|REV_LIMITER|ENGINE/, tab: 'POWERTRAIN', section: 'Engine' },
    { re: /^WM_(PRESSURE|COMPOUND|SRUBBER)/, tab: 'WHEELS & BRAKES', section: 'Tyres' },
    { re: /TIRE|TYRE/, tab: 'WHEELS & BRAKES', section: 'Tyres' },
    { re: /BRAKE|DUCT/, tab: 'WHEELS & BRAKES', section: 'Brakes' },
    { re: /CAMBER|TOE|CASTER/, tab: 'WHEELS & BRAKES', section: 'Alignment' },
    { re: /^WM_(SPRING|TENDER)/, tab: 'SUSPENSION', section: 'Springs' },
    { re: /RIDEHEIGHT|RIDE_HEIGHT|PACKER/, tab: 'SUSPENSION', section: 'Ride height & travel' },
    { re: /ANTISWAY|ARB/, tab: 'SUSPENSION', section: 'Anti-roll bars' },
    { re: /TRACK_BAR|WHEEL_TRACK/, tab: 'SUSPENSION', section: 'Geometry' },
    { re: /3RD/, tab: 'DAMPERS', section: 'Third element — front' },
    { re: /BUMP|REBOUND|DAMPER/, tab: 'DAMPERS', section: 'Corner dampers' },
    { re: /WING|SPLITTER|FLAP|DIVE|FLARE|AERO/, tab: 'CHASSIS & AERO', section: 'Aero' },
    { re: /WEIGHT|BALLAST|WEDGE/, tab: 'CHASSIS & AERO', section: 'Weight' },
    { re: /CHASSIS/, tab: 'CHASSIS & AERO', section: 'Chassis adjustments' },
    { re: /FUEL|ENERGY|PITSTOP|PIT/, tab: 'BASIC', section: 'Fuel & strategy' },
    { re: /TRACTION|ANTILOCK|ABS/, tab: 'BASIC', section: 'Driver aids' },
    { re: /STEER/, tab: 'BASIC', section: 'Steering' },
  ];

  const CATCH_ALL = { tab: 'BASIC', section: 'Other' };

  /** WM_CAMBER-W_FL → { family: 'WM_CAMBER', corner: 'FL' }; VM keys → null. */
  function cornerOf(key) {
    const m = /^(WM_[A-Z0-9_]+)-W_(FL|FR|RL|RR)$/.exec(key);
    return m ? { family: m[1], corner: m[2] } : null;
  }

  // Explicit lookup (family or full key) → { tab, section, order }.
  const explicit = new Map();
  {
    let order = 0;
    for (const g of GROUPS) {
      for (const k of g.keys) explicit.set(k, { tab: g.tab, section: g.section, order: order++ });
    }
  }

  /**
   * Where does this key render? Returns
   * { tab, section, order, family, corner, explicit, pattern } — exactly one of
   * explicit/pattern true, or neither for a catch-all landing.
   */
  function classifyKey(key) {
    const c = cornerOf(key);
    const lookup = c ? c.family : key;
    const hit = explicit.get(lookup);
    if (hit) {
      return { ...hit, family: lookup, corner: c ? c.corner : null, explicit: true, pattern: false };
    }
    for (const p of PATTERNS) {
      if (p.re.test(lookup)) {
        return {
          tab: p.tab, section: p.section, order: 10_000,
          family: lookup, corner: c ? c.corner : null, explicit: false, pattern: true,
        };
      }
    }
    return {
      ...CATCH_ALL, order: 20_000,
      family: lookup, corner: c ? c.corner : null, explicit: false, pattern: false,
    };
  }

  return { TABS, GROUPS, PATTERNS, classifyKey, cornerOf };
});
