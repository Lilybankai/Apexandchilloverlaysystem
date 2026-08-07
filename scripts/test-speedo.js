/**
 * scripts/test-speedo.js — the speedo's rev ramp.
 * -----------------------------------------------------------------------------
 * The cluster is mostly a layout, and a layout is checked by looking at it. One
 * part is not: the ramp that turns RPM into a colour and a band. It decides when
 * the panel goes red and when the shift light flashes, and both of those are
 * claims a driver acts on at 300 km/h — so they are asserted here rather than
 * eyeballed against a running sim, where the interesting cases (a missing rev
 * limit, a car on the limiter) are the hardest ones to reproduce on purpose.
 *
 * The cases that matter:
 *
 *   • an UNKNOWN or absent `maxRpm`, which is what every non-shared-memory feed
 *     publishes. Dividing a real RPM by a sentinel would light the panel red on
 *     an idling car — the single worst failure this widget has, because it is
 *     the one that fires when nothing is wrong.
 *   • the band edges, exactly. A shift light that comes on at 0.93 and one that
 *     comes on at 0.94 are different instruments.
 *   • the ramp's monotonicity: red must never get greener as the revs rise, on
 *     any channel. A non-monotonic ramp reads as the car calming down while it
 *     runs out of gear.
 *   • two cars with different rev limits reaching the same band at the same
 *     fraction of their own range — the property that lets one widget serve a
 *     Hypercar and a GT3.
 *
 * Run: node scripts/test-speedo.js
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
/*  Load the widget with just enough browser around it                         */
/* -------------------------------------------------------------------------- */

/**
 * The widget registers itself against `window.ApexOverlay` and exposes its pure
 * half as `window.ApexSpeedo`. Only the second is under test, so the runtime is
 * stubbed to the one method the module calls at load time.
 */
function loadSpeedo() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'overlay', 'js', 'widgets', 'speedo.js'),
    'utf8',
  );
  const registered = [];
  const sandbox = {
    window: { ApexOverlay: { registerWidget: (n, d) => registered.push({ n, d }) } },
    document: {},
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'speedo.js' });
  return { api: sandbox.window.ApexSpeedo, registered };
}

const { api, registered } = loadSpeedo();

console.log('\nspeedo — module surface');
check('registers as "speedo"', registered.length === 1 && registered[0].n === 'speedo');
check(
  'runs at the full broadcast rate',
  registered[0] && registered[0].d.throttleMs === 0,
  `throttleMs=${registered[0] && registered[0].d.throttleMs}`,
);
check('exposes the pure ramp', !!api && typeof api.revFraction === 'function');

/* -------------------------------------------------------------------------- */

console.log('\nrevFraction — the sentinel cases');

// UNKNOWN_VALUE is -1 on the wire. Both channels can carry it.
check('unknown maxRpm reads 0', api.revFraction(7200, -1) === 0, String(api.revFraction(7200, -1)));
check('unknown rpm reads 0', api.revFraction(-1, 8600) === 0);
check('both unknown reads 0', api.revFraction(-1, -1) === 0);
check('absent channels read 0', api.revFraction(undefined, undefined) === 0);
check('zero maxRpm reads 0 (no divide)', api.revFraction(5000, 0) === 0);
check(
  'implausibly low maxRpm is rejected',
  api.revFraction(5000, 900) === 0,
  'a 900 rpm "limit" is not a rev limit',
);
check('idling car with a real limit is near 0', api.revFraction(900, 9000) === 0.1);
check('over the limiter clamps to 1', api.revFraction(9500, 9000) === 1);
check('negative rpm reads 0', api.revFraction(-50, 9000) === 0);

/* -------------------------------------------------------------------------- */

console.log('\nrevStage — the band edges, exactly');

const at = (f) => api.revStage(f);
check('below amber is low', at(api.BAND_AMBER - 0.0001) === 'low');
check('amber edge is inclusive', at(api.BAND_AMBER) === 'amber', at(api.BAND_AMBER));
check('below red is still amber', at(api.BAND_RED - 0.0001) === 'amber');
check('red edge is inclusive', at(api.BAND_RED) === 'red', at(api.BAND_RED));
check('below shift is still red', at(api.BAND_SHIFT - 0.0001) === 'red');
check('shift edge is inclusive', at(api.BAND_SHIFT) === 'shift', at(api.BAND_SHIFT));
check('on the limiter is shift', at(1) === 'shift');
check('a stationary car is low, never shift', at(0) === 'low');
check(
  'the bands are ordered',
  api.BAND_AMBER < api.BAND_RED && api.BAND_RED < api.BAND_SHIFT,
  `${api.BAND_AMBER} < ${api.BAND_RED} < ${api.BAND_SHIFT}`,
);

/* -------------------------------------------------------------------------- */

console.log('\nrevRgb — the ramp');

const green = api.revRgb(0);
const red = api.revRgb(1);
check('starts green', green[1] > green[0] && green[1] > green[2], green.join(','));
check('ends red', red[0] > red[1] && red[0] > red[2], red.join(','));

// Monotonic on both ends of the ramp: red never falls, green never rises, as
// the revs climb. Checked at a fine step so a bad interpolation cannot hide
// between samples.
let redFalls = 0;
let greenRises = 0;
let prev = api.revRgb(0);
for (let i = 1; i <= 1000; i++) {
  const c = api.revRgb(i / 1000);
  if (c[0] < prev[0]) redFalls++;
  if (c[1] > prev[1]) greenRises++;
  prev = c;
}
check('red channel never falls as revs rise', redFalls === 0, `${redFalls} regressions`);
check('green channel never rises as revs rise', greenRises === 0, `${greenRises} regressions`);

check(
  'every colour is a valid 8-bit triple',
  [0, 0.25, 0.5, 0.75, 0.9, 1].every((f) =>
    api.revRgb(f).every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
  ),
);

/* -------------------------------------------------------------------------- */

console.log('\none widget, two cars');

// The property that makes this widget car-agnostic: a Hypercar at 9000 and a
// GT3 at 7200 must reach each band at the same fraction of their OWN range.
const HYPER_MAX = 9000;
const GT3_MAX = 7200;
for (const f of [0.5, api.BAND_AMBER, api.BAND_RED, api.BAND_SHIFT]) {
  const hyper = api.revStage(api.revFraction(HYPER_MAX * f, HYPER_MAX));
  const gt3 = api.revStage(api.revFraction(GT3_MAX * f, GT3_MAX));
  check(`same band at ${f} of range (hyper ${hyper} / gt3 ${gt3})`, hyper === gt3);
}

// And the corollary that must NOT hold: the same absolute RPM in two cars is
// not the same band. A GT3 at 7100 is on its limiter; a Hypercar is not.
check(
  'the same RPM is not the same band across cars',
  api.revStage(api.revFraction(7100, GT3_MAX)) !== api.revStage(api.revFraction(7100, HYPER_MAX)),
  `gt3=${api.revStage(api.revFraction(7100, GT3_MAX))} hyper=${api.revStage(
    api.revFraction(7100, HYPER_MAX),
  )}`,
);

/* -------------------------------------------------------------------------- */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
