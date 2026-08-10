/**
 * setup-info.js — what every setup control actually does.
 * -----------------------------------------------------------------------------
 * The text behind each row's ⓘ button: `what` is the physical thing being
 * adjusted, `effect` is which way to move it for which handling result. Written
 * generically enough to hold across cars — where a car's ladder runs the other
 * way (it happens; brake migration's does), the sim's own stringValue is always
 * shown next to the slider, and these words defer to it.
 *
 * Looked up by exact key, then by family (WM_CAMBER-W_FL → WM_CAMBER,
 * VM_PITSTOP_2 → VM_PITSTOP), so one entry covers a numbered or per-corner run.
 *
 * Classic script (window.APEX_SETUP_INFO) + module.exports for the headless
 * tests, like setup-groups.js.
 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.APEX_SETUP_INFO = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const INFO = {
    /* ---- BASIC ---------------------------------------------------------- */
    VM_FUEL_LEVEL: {
      title: 'Fuel load',
      what: 'How much fuel is in the tank when you leave the garage. The label shows litres and roughly how many laps that buys.',
      effect: 'Less fuel is faster (a full tank costs several tenths a lap) but needs more stops. Also editable mid-race from the pit MFD.',
    },
    VM_VIRTUAL_ENERGY: {
      title: 'Virtual energy',
      what: "LMU's per-stint energy allocation for Hypercars — a rules budget, not a physical tank.",
      effect: 'Set alongside fuel: it caps how long the stint can run. Race-strategy value, also on the pit MFD.',
    },
    VM_FUEL_CAPACITY: {
      title: 'Tank capacity',
      what: 'The maximum the tank can hold. Fixed by the ruleset on most cars.',
      effect: 'Informational unless the car allows a smaller tank for sprint formats.',
    },
    VM_NUM_PITSTOPS: {
      title: 'Planned pit stops',
      what: 'How many stops the pit strategy pre-plans; each planned stop gets its own fuel target below.',
      effect: 'Strategy bookkeeping only — it changes the pit menu presets, not the car.',
    },
    VM_PITSTOP: {
      title: 'Planned stop fuel',
      what: 'The fuel target for this planned stop.',
      effect: 'Strategy bookkeeping — what the crew will put in at that stop unless you change it from the pit MFD.',
    },
    VM_TRACTION_CONTROL: {
      title: 'Traction control',
      what: 'Whether TC is fitted/enabled for this car.',
      effect: 'Usually fixed by class rules (GT cars have it, LMP2 does too; settings differ per class).',
    },
    VM_TRACTIONCONTROLMAP: {
      title: 'TC map',
      what: 'The master traction-control level — how hard the electronics fight wheelspin.',
      effect: 'Lower = more slip allowed: faster corner exits in clean conditions but easier to snap. Higher = safer in rain or on worn tyres, at some exit pace.',
    },
    VM_TRACTIONCONTROLSLIPANGLEMAP: {
      title: 'TC slip angle',
      what: 'The slip-angle sub-map: how much sideways slide TC tolerates before intervening. "Linked" follows the master map.',
      effect: 'Lower tolerance stabilises corner exit under angle; higher lets the car rotate on throttle.',
    },
    VM_TRACTIONCONTROLPOWERCUTMAP: {
      title: 'TC power cut',
      what: 'The power-cut sub-map: how much torque TC removes when it intervenes. "Linked" follows the master map.',
      effect: 'Smaller cuts feel smoother and lose less time per intervention; bigger cuts kill wheelspin outright.',
    },
    VM_ANTILOCK_BRAKES: {
      title: 'ABS',
      what: 'Whether anti-lock braking is fitted. Class-dependent — GT3 has it, prototypes do not.',
      effect: 'Fixed by the ruleset; see the ABS map for strength where it exists.',
    },
    VM_ANTILOCKBRAKESYSTEMMAP: {
      title: 'ABS map',
      what: 'How aggressively the anti-lock system releases brake pressure at lock-up.',
      effect: 'Higher = harder late braking with less risk of flat spots; lower = more pedal authority for drivers who trail-brake precisely.',
    },
    VM_STEER_LOCK: {
      title: 'Steering lock',
      what: 'The maximum steering angle at the wheels (and the wheel rotation shown in brackets).',
      effect: 'More lock = quicker steering response and easier hairpins, but twitchier at speed. Match it to your wheel’s rotation.',
    },

    /* ---- POWERTRAIN ------------------------------------------------------ */
    VM_ENGINE_MIXTURE: {
      title: 'Engine mixture',
      what: 'The fuel-air map the engine runs — typically Full/Race/Lean steps.',
      effect: 'Richer = more power and more fuel per lap; leaner stretches a stint at the cost of pace. Also on the in-car MFD during a stint.',
    },
    VM_REV_LIMITER: {
      title: 'Rev limiter',
      what: 'The RPM ceiling.',
      effect: 'Lower limits protect the engine in endurance running and can suit shorter gearing; the top step is simply maximum power.',
    },
    VM_ENGINE_BOOST: {
      title: 'Boost',
      what: 'Turbo/engine boost map where the car has one.',
      effect: 'More boost = more power, more fuel and more heat.',
    },
    VM_ENGINE_BRAKEMAP: {
      title: 'Engine braking',
      what: 'How much the engine resists on a closed throttle.',
      effect: 'More engine braking helps slow the car and rotate it into corners but destabilises the rear on entry; less makes entries calmer.',
    },
    VM_ELECTRIC_MOTOR_MAP: {
      title: 'Motor map',
      what: 'The hybrid deployment map — how the electric motor spends its energy across the lap.',
      effect: 'Aggressive maps give more instant power and drain the battery sooner. Also on the in-car MFD.',
    },
    VM_REGEN_LEVEL: {
      title: 'Regeneration',
      what: 'How hard the hybrid harvests under braking, in kW.',
      effect: 'More regen recovers more energy but adds an engine-braking-like drag at the rear on entry — treat a big step up like a brake-bias change.',
    },
    VM_TORQUE_SPLIT: {
      title: 'Torque split',
      what: 'Front:rear drive distribution on hybrid Hypercars with a front motor.',
      effect: 'More front torque improves traction out of slow corners but can push wide on entry; rules limit when the front axle may deploy.',
    },
    VM_WATER_RADIATOR: {
      title: 'Water radiator',
      what: 'The radiator opening (tape). "Open" cools most.',
      effect: 'Closing it reduces drag for straight-line speed but runs the engine hotter — risky in heat or traffic.',
    },
    VM_OIL_RADIATOR: {
      title: 'Oil radiator',
      what: 'The oil-cooler opening.',
      effect: 'Same trade as the water radiator: taped = faster and hotter.',
    },
    VM_RATIO_SET: {
      title: 'Gear ratio set',
      what: 'The gearbox’s homologated ratio stack (e.g. High Speed vs High Downforce).',
      effect: 'Pick to suit the track: taller sets for long straights, shorter for twisty circuits. Individual gears may then fine-tune within the set.',
    },
    VM_GEAR_FINAL: {
      title: 'Final drive',
      what: 'The differential’s overall gearing, multiplying every gear.',
      effect: 'Taller (numerically lower) = higher top speed, lazier acceleration; shorter = the reverse. The gear graph shows resulting speeds.',
    },
    VM_GEAR_REVERSE: { title: 'Reverse gear', what: 'The reverse ratio.', effect: 'No lap-time consequence.' },
    VM_GEAR: {
      title: 'Gear ratio',
      what: 'This gear’s ratio; the bracketed figure is the overall multiplication with the final drive.',
      effect: 'Set each gear so the engine sits in its power band where the track needs it — top gear just below the limiter at the end of the longest straight.',
    },
    VM_GEAR_AUTOUPSHIFT: {
      title: 'Auto upshift',
      what: 'Whether the car shifts up by itself at the limiter.',
      effect: 'An assist, not a setup change. Off for full control.',
    },
    VM_GEAR_AUTODOWNSHIFT: {
      title: 'Auto downshift',
      what: 'Whether the car downshifts by itself under braking.',
      effect: 'An assist; off for full control.',
    },
    VM_GEAR_UPSHIFT_RPM: {
      title: 'Upshift RPM',
      what: 'The shift-light/auto-shift point for this gear, where adjustable.',
      effect: 'Short-shifting saves fuel and tames wheelspin; shifting at the limiter maximises pace.',
    },
    VM_DIFF_POWER: {
      title: 'Diff — power lock',
      what: 'How firmly the differential locks the driven wheels together ON throttle (ramp angle or %; lower angle / higher % = more lock).',
      effect: 'More lock = better traction off corners but a tighter, pushier exit line; less lets the car rotate under power at the cost of inside wheelspin.',
    },
    VM_DIFF_COAST: {
      title: 'Diff — coast lock',
      what: 'Differential locking OFF throttle, on entry and mid-corner.',
      effect: 'More coast lock stabilises corner entry (the rear axle turns as one); less frees rotation into the apex but can make entries nervous.',
    },
    VM_DIFF_PRELOAD: {
      title: 'Diff — preload',
      what: 'The baseline locking torque always present, before ramps act, in Nm.',
      effect: 'More preload smooths the on/off-throttle transition and adds mid-corner stability; less sharpens response to small throttle changes.',
    },
    VM_DIFF_PUMP: {
      title: 'Diff — pump',
      what: 'Electronically controlled locking rate where fitted.',
      effect: 'Higher = more aggressive automatic locking.',
    },
    VM_FRONT_DIFF_POWER: { title: 'Front diff — power', what: 'Power-side locking of the front differential on AWD hybrids.', effect: 'More lock pulls the car straight under front deployment; less keeps steering cleaner.' },
    VM_FRONT_DIFF_COAST: { title: 'Front diff — coast', what: 'Coast-side locking of the front differential.', effect: 'As the rear coast setting, applied to the front axle.' },
    VM_FRONT_DIFF_PRELOAD: { title: 'Front diff — preload', what: 'Baseline locking of the front differential.', effect: 'As rear preload, for the front axle.' },
    VM_FRONT_DIFF_PUMP: { title: 'Front diff — pump', what: 'Electronic locking rate of the front differential.', effect: 'Higher = more aggressive locking.' },

    /* ---- WHEELS & BRAKES -------------------------------------------------- */
    WM_COMPOUND: {
      title: 'Tyre compound',
      what: 'Which tyre is fitted at this corner in the garage (the pit MFD sets the NEXT stop’s tyres).',
      effect: 'Softer = more grip, faster degradation. Wets only make sense on a wet track.',
    },
    WM_PRESSURE: {
      title: 'Tyre pressure',
      what: 'Cold inflation pressure at this corner. Pressures rise with temperature on track.',
      effect: 'Lower = bigger contact patch and more grip once warm, slower warm-up; higher = quicker warm-up, less peak grip, less rolling drag. Chase even tread temps.',
    },
    WM_SRUBBER: {
      title: 'Starting rubber',
      what: 'Whether the tyre starts scrubbed-in.',
      effect: 'Scrubbed tyres behave predictably from the first lap; stickered ones peak slightly higher once through their first heat cycle.',
    },
    WM_CAMBER: {
      title: 'Camber',
      what: 'The wheel’s lean, in degrees — negative means the top leans inboard.',
      effect: 'More negative camber = more mid-corner grip (the loaded tyre stands upright) but less straight-line braking footprint and a hotter inner shoulder. Read the tread temps: inner minus outer of ~5–10 °C is the classic window.',
    },
    WM_BRAKEDISC: {
      title: 'Brake disc',
      what: 'Disc thickness/spec at this corner.',
      effect: 'Thicker discs absorb more heat for endurance stints; thinner save unsprung weight for sprints.',
    },
    WM_BRAKEPAD: {
      title: 'Brake pad',
      what: 'Pad compound at this corner.',
      effect: 'Aggressive pads bite harder when hot and wear faster; conservative pads last a double stint.',
    },
    VM_BRAKE_PRESSURE: {
      title: 'Brake pressure',
      what: 'The master pressure the pedal commands at 100% — shown in kgf and as % of maximum.',
      effect: 'Higher = less pedal travel to reach lock-up (easier to overdo without ABS); lower gives more modulation range in the pedal.',
    },
    VM_BRAKE_BALANCE: {
      title: 'Brake bias',
      what: 'Front:rear split of braking force.',
      effect: 'Forward = stable but pushy on entry and harder on front tyres; rearward = rotates into corners but risks a loose rear under braking. Live-adjustable from the cockpit.',
    },
    VM_BRAKE_MIGRATION: {
      title: 'Brake migration',
      what: 'Dynamic bias shift as the pedal is released — bias migrates forward at peak pressure and back toward the set value as you trail off.',
      effect: 'More migration = stability at peak braking AND rotation as you trail into the apex. The step order varies per car — trust the % label.',
    },
    VM_BRAKE_DUCTS: {
      title: 'Front brake ducts',
      what: 'Cooling duct opening for the front brakes.',
      effect: 'Open = cooler brakes and tyres, more drag. Closed = free straight-line speed, but watch disc temps and the heat soaking into the front tyres.',
    },
    VM_BRAKE_DUCTS_REAR: {
      title: 'Rear brake ducts',
      what: 'Cooling duct opening for the rear brakes.',
      effect: 'Same trade as the fronts; rear ducts also feed heat into the rear tyres — a lever on rear tyre temperature.',
    },
    VM_HANDBRAKE_PRESSURE: { title: 'Handbrake pressure', what: 'Handbrake force where fitted.', effect: 'Not relevant to circuit pace.' },
    VM_HANDFRONTBRAKE_PRESSURE: { title: 'Hand front brake', what: 'Auxiliary front-brake control where fitted.', effect: 'Rarely used; leave at default.' },
    VM_FRONT_TOEIN: {
      title: 'Front toe',
      what: 'Whether the front wheels point in (positive) or out (negative) seen from above.',
      effect: 'Toe-out sharpens turn-in and initial response; toe-in calms the front. Both scrub speed and heat the tyres — keep it small.',
    },
    VM_REAR_TOEIN: {
      title: 'Rear toe',
      what: 'The rear wheels’ convergence. Rear toe-IN is the stable direction.',
      effect: 'More rear toe-in = a planted rear under power and over kerbs, at a little drag and tyre temperature; toe-out at the rear makes the car eager to rotate and hard to trust.',
    },
    VM_FRONT_TOEOFFSET: { title: 'Front toe offset', what: 'Side-to-side asymmetry of front toe, for ovals/banked tracks.', effect: 'Leave zero on road courses.' },
    VM_REAR_TOEOFFSET: { title: 'Rear toe offset', what: 'Side-to-side asymmetry of rear toe.', effect: 'Leave zero on road courses.' },
    VM_LEFT_CASTER: {
      title: 'Caster (left)',
      what: 'The steering axis’s backward lean. More caster = more self-centering and more dynamic negative camber when steered.',
      effect: 'More = heavier, more communicative steering and better mid-corner front grip; less lightens the wheel.',
    },
    VM_RIGHT_CASTER: { title: 'Caster (right)', what: 'As left caster, for the right upright.', effect: 'Keep symmetric on road courses.' },
    VM_FRONT_TIRE_COMPOUND: { title: 'Front compound (pair)', what: 'Both front tyres’ compound as one control.', effect: 'Same as the per-corner compound — this is the pair shortcut.' },
    VM_REAR_TIRE_COMPOUND: { title: 'Rear compound (pair)', what: 'Both rear tyres’ compound as one control.', effect: 'Same as the per-corner compound — this is the pair shortcut.' },

    /* ---- SUSPENSION -------------------------------------------------------- */
    WM_SPRING: {
      title: 'Spring rate',
      what: 'The main spring’s stiffness at this corner (N/mm or lbf/in).',
      effect: 'Stiffer = sharper response, flatter aero platform, less mechanical grip on bumps and kerbs. Softer = the reverse. Stiffening one axle shifts balance AWAY from it.',
    },
    WM_TENDERSPRING: {
      title: 'Tender spring',
      what: 'A softer helper spring in series with the main spring, active until it coil-binds.',
      effect: 'Gives a compliant first phase of travel (kerbs, warm-up) before the main rate takes over.',
    },
    WM_TENDERSPRINGTRAVEL: {
      title: 'Tender travel',
      what: 'How much travel the tender spring provides before binding.',
      effect: 'More travel = longer soft phase; less = the main spring engages sooner.',
    },
    WM_RIDEHEIGHT: {
      title: 'Ride height',
      what: 'Static ground clearance at this corner.',
      effect: 'Lower = lower centre of gravity and stronger underbody aero, until the floor bottoms out. Rake (rear higher than front) adds front downforce and rotation.',
    },
    WM_PACKERS: {
      title: 'Packers',
      what: 'Spacers that stop the damper before full compression — a travel limit.',
      effect: 'They protect the floor at speed while letting you run low: more packer = earlier, harder ride-height floor; fewer = more travel before the stop.',
    },
    VM_FRONT_ANTISWAY: {
      title: 'Front anti-roll bar',
      what: 'The bar resisting body roll across the front axle.',
      effect: 'Stiffer front bar = flatter, more responsive, MORE understeer at the limit; softer = more front grip mid-corner. The classic balance lever.',
    },
    VM_REAR_ANTISWAY: {
      title: 'Rear anti-roll bar',
      what: 'The bar resisting roll across the rear axle. "Detached" = no bar.',
      effect: 'Stiffer rear bar = more rotation (oversteer tendency) and sharper response; softer = more rear traction, especially out of slow corners.',
    },
    VM_LEFT_TRACK_BAR: { title: 'Track bar (left)', what: 'Rear axle lateral locator height — an oval-racing control.', effect: 'Not used on road courses.' },
    VM_RIGHT_TRACK_BAR: { title: 'Track bar (right)', what: 'As left.', effect: 'Not used on road courses.' },
    VM_FRONT_WHEEL_TRACK: { title: 'Front track width', what: 'The front axle’s width where adjustable.', effect: 'Wider = more roll resistance and grip, within rules.' },
    VM_REAR_WHEEL_TRACK: { title: 'Rear track width', what: 'The rear axle’s width where adjustable.', effect: 'As front.' },

    /* ---- DAMPERS ------------------------------------------------------------ */
    WM_SLOWBUMP: {
      title: 'Slow bump',
      what: 'Damping against slow compression — body roll, dive under brakes, squat under power.',
      effect: 'More = the platform moves less and responds faster but rides bumps harder; less = more compliance and mechanical grip. Front slow bump steadies turn-in; rear supports the exit.',
    },
    WM_FASTBUMP: {
      title: 'Fast bump',
      what: 'Damping against fast compression — kerbs, bumps, sudden aero load.',
      effect: 'Less fast bump lets the wheel swallow kerbs without kicking the chassis; more keeps the floor off the ground at speed.',
    },
    WM_SLOWREBOUND: {
      title: 'Slow rebound',
      what: 'Damping as the spring pushes back after slow compression — controls how the body releases roll and pitch.',
      effect: 'More rebound holds the platform down through transitions (but can "jack down" over repeated bumps); less lets the tyre follow the road.',
    },
    WM_FASTREBOUND: {
      title: 'Fast rebound',
      what: 'Damping on fast extension — the wheel dropping off a kerb or crest.',
      effect: 'Less keeps the tyre in contact after kerb strikes; more stops the car floating over crests.',
    },
    VM_3RD_SPRING: {
      title: 'Third spring',
      what: 'The heave element: a spring acting only when BOTH wheels of the axle compress together (aero load), not in roll.',
      effect: 'Stiffer third spring holds the aero platform without stiffening the car in corners — the downforce car’s trick for running soft corner springs.',
    },
    VM_3RD_PACKERS: { title: 'Third packers', what: 'Travel limit on the heave element.', effect: 'Sets the ride-height floor under peak downforce.' },
    VM_3RD_SLOWBUMP: { title: 'Third slow bump', what: 'Slow compression damping of the heave element.', effect: 'Controls how fast the platform settles as aero load builds.' },
    VM_3RD_FASTBUMP: { title: 'Third fast bump', what: 'Fast compression damping of the heave element.', effect: 'Absorbs sudden vertical hits at speed.' },
    VM_3RD_SLOWREBOUND: { title: 'Third slow rebound', what: 'Slow extension damping of the heave element.', effect: 'Controls how fast the platform rises as load bleeds off.' },
    VM_3RD_FASTREBOUND: { title: 'Third fast rebound', what: 'Fast extension damping of the heave element.', effect: 'Keeps the floor from springing up over crests.' },
    VM_3RD_TENDERSPRING: { title: 'Third tender', what: 'Helper spring on the heave element.', effect: 'A soft first phase before the main third spring engages.' },
    VM_3RD_TENDERSPRINGTRAVEL: { title: 'Third tender travel', what: 'Travel of the heave helper spring.', effect: 'How long the soft phase lasts.' },

    /* ---- CHASSIS & AERO ------------------------------------------------------- */
    VM_FRONT_WING: {
      title: 'Front aero',
      what: 'Front wing/splitter configuration where adjustable.',
      effect: 'More front aero = more front grip at speed = high-speed oversteer risk; balance it against the rear wing.',
    },
    VM_REAR_WING: {
      title: 'Rear wing',
      what: 'Rear wing angle/level.',
      effect: 'More wing = more high-speed grip and stability, less top speed. The main lever for the downforce-vs-straightline trade — and the rear half of aero balance.',
    },
    VM_LEFT_FENDER_FLARE: { title: 'Fender flare (left)', what: 'Bodywork flare over the wheel.', effect: 'Aero detail; usually fixed.' },
    VM_RIGHT_FENDER_FLARE: { title: 'Fender flare (right)', what: 'As left.', effect: 'Aero detail; usually fixed.' },
    VM_WEIGHT_DISTRIB: {
      title: 'Weight distribution',
      what: 'Fore-aft ballast position where movable.',
      effect: 'Forward = more front grip and braking stability; rearward = traction. Usually fixed by homologation.',
    },
    VM_WEIGHT_LATERAL: { title: 'Lateral ballast', what: 'Side-to-side ballast position.', effect: 'Oval tool; keep centred on road courses.' },
    VM_WEIGHT_VERTICAL: { title: 'Ballast height', what: 'How low the ballast sits.', effect: 'Lower is always better where allowed.' },
    VM_WEIGHT_WEDGE: { title: 'Wedge', what: 'Cross-weight adjustment — an oval-racing control.', effect: 'Not used on road courses.' },
    VM_CHASSIS_ADJ: {
      title: 'Chassis adjustment',
      what: 'A car-specific chassis option LMU exposes without naming.',
      effect: 'Meaning varies per car; the value label is the only guide.',
    },
  };

  /**
   * Family aliases: regex → INFO key. Tried in order after an exact-key miss
   * (the WM_ corner suffix is stripped before lookup by the caller).
   */
  const ALIASES = [
    [/^VM_PITSTOP_\d+$/, 'VM_PITSTOP'],
    [/^VM_GEAR_UPSHIFT_RPM_\d+$/, 'VM_GEAR_UPSHIFT_RPM'],
    [/^VM_GEAR_\d+$/, 'VM_GEAR'],
    [/^VM_(FRONT|REAR)_3RD_SPRING$/, 'VM_3RD_SPRING'],
    [/^VM_(FRONT|REAR)_3RD_PACKERS$/, 'VM_3RD_PACKERS'],
    [/^VM_(FRONT|REAR)_3RD_SLOWBUMP$/, 'VM_3RD_SLOWBUMP'],
    [/^VM_(FRONT|REAR)_3RD_FASTBUMP$/, 'VM_3RD_FASTBUMP'],
    [/^VM_(FRONT|REAR)_3RD_SLOWREBOUND$/, 'VM_3RD_SLOWREBOUND'],
    [/^VM_(FRONT|REAR)_3RD_FASTREBOUND$/, 'VM_3RD_FASTREBOUND'],
    [/^VM_(FRONT|REAR)_3RD_TENDERSPRINGTRAVEL$/, 'VM_3RD_TENDERSPRINGTRAVEL'],
    [/^VM_(FRONT|REAR)_3RD_TENDERSPRING$/, 'VM_3RD_TENDERSPRING'],
    [/^VM_CHASSIS_ADJ_\d+$/, 'VM_CHASSIS_ADJ'],
  ];

  /**
   * The info entry for a key (full key or WM_ family), or null. Never throws —
   * a key without an entry just renders its ⓘ with generic text.
   */
  function infoFor(keyOrFamily) {
    if (INFO[keyOrFamily]) return INFO[keyOrFamily];
    for (const [re, target] of ALIASES) {
      if (re.test(keyOrFamily)) return INFO[target] || null;
    }
    return null;
  }

  return { INFO, ALIASES, infoFor };
});
