/**
 * scripts/test-speedo-lmp2.js — the LMP2 design's banner rule.
 * -----------------------------------------------------------------------------
 * The LMP2 dash is mostly boxes, and boxes are checked by looking at them. The
 * part that is not is the banner: a full-width shout that covers the middle of
 * the dash, decided by a precedence rule over three feed signals. A banner that
 * fires in the garage, or shows the limiter reminder to a car that has stalled
 * in the pit lane, is the widget being loud AND wrong — so the rule is asserted
 * here, where the awkward cases (a menu screen, a stall with the limiter armed,
 * a feed with no RPM channel) cost nothing to set up.
 *
 * Run: node scripts/test-speedo-lmp2.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Load the design with just enough browser around it                         */
/* -------------------------------------------------------------------------- */

function loadLmp2() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'overlay', 'js', 'widgets', 'speedo-lmp2.js'),
    'utf8',
  );
  const sandbox = { window: {}, document: {} };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'speedo-lmp2.js' });
  return sandbox.window;
}

const win = loadLmp2();
const api = win.ApexSpeedoLmp2;
const banner = api.bannerState;

console.log('\nspeedo-lmp2 — module surface');
check(
  'registers itself as the "lmp2" design',
  !!(win.ApexSpeedoDesigns && win.ApexSpeedoDesigns.lmp2),
);
check(
  'a design is an init + an update',
  typeof win.ApexSpeedoDesigns.lmp2.init === 'function' &&
    typeof win.ApexSpeedoDesigns.lmp2.update === 'function',
);
check(
  'and a stop(), so the slot can be handed to another design cleanly',
  typeof win.ApexSpeedoDesigns.lmp2.stop === 'function',
);
check('exposes its pure half', typeof banner === 'function');

/* -------------------------------------------------------------------------- */
/*  The banner rule                                                            */
/* -------------------------------------------------------------------------- */

/** A frame with just the channels the rule reads. */
function frame(over) {
  return {
    session: {},
    player: { rpm: 6000, speedKph: 120, pit: {}, pedals: {} },
    ...over,
  };
}

console.log('\nno claim without a channel');
check('no frame → no banner', banner(null) === null);
check('no player → no banner', banner({ session: {} }) === null);
check(
  'an absent RPM channel is not a stall',
  banner(frame({ player: { speedKph: 0, pit: {} } })) === null,
  'a feed that cannot see the engine may not report one dead',
);
check(
  'an UNKNOWN (-1) RPM is not a stall either',
  banner(frame({ player: { rpm: -1, speedKph: 0, pit: {} } })) === null,
);

console.log('\nthe menus suppress everything');
check(
  'a stalled car in the sim menus shows nothing',
  banner({ session: { onTrack: false }, player: { rpm: 0, speedKph: 0, pit: {} } }) === null,
  'a parked car on the garage screen is not "stalled"',
);
check(
  'an ABSENT onTrack means "assume at the wheel"',
  (banner({ session: {}, player: { rpm: 0, speedKph: 0, pit: {} } }) || {}).kind === 'stall',
);

console.log('\nstall');
check(
  `RPM below ${api.STALL_RPM} is a stall`,
  (banner(frame({ player: { rpm: api.STALL_RPM - 1, speedKph: 0, pit: {} } })) || {}).kind ===
    'stall',
);
check(
  'RPM at the threshold is not',
  banner(frame({ player: { rpm: api.STALL_RPM, speedKph: 0, pit: {} } })) === null,
);
check('a healthy engine shows nothing', banner(frame()) === null);

console.log('\nlimiter');
const lim = (kph) =>
  banner(frame({ player: { rpm: 6000, speedKph: kph, pit: { limiterOn: true }, pedals: {} } }));
check('limiter on → the limiter banner', (lim(50) || {}).kind === 'limiter');
check(
  `at or under ${api.LIMITER_RED_KPH} km/h it is the calm one`,
  lim(api.LIMITER_RED_KPH).over === false,
);
check(`over ${api.LIMITER_RED_KPH} km/h it escalates`, lim(api.LIMITER_RED_KPH + 1).over === true);
check(
  'limiter OFF is not a banner',
  banner(frame({ player: { rpm: 6000, speedKph: 50, pit: { limiterOn: false } } })) === null,
);

console.log('\nprecedence');
check(
  'a stall outranks the limiter',
  (
    banner(frame({ player: { rpm: 500, speedKph: 10, pit: { limiterOn: true }, pedals: {} } })) ||
    {}
  ).kind === 'stall',
  'a car dying in the pit lane needs STALL, not a limiter reminder',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
