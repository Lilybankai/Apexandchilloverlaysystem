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

/* -------------------------------------------------------------------------- */

console.log('\nthe optional blocks must actually disappear');

/*
 * Three readouts are hidden rather than emptied when their block is absent —
 * the battery (no hybrid), virtual energy (no energy budget) and the aid chips
 * (not LMU). The widget expresses that with the `hidden` attribute, which the
 * user agent honours with `[hidden] { display: none }` — a rule ANY `display`
 * declaration on the element outranks.
 *
 * This is asserted here because it broke exactly that way and nothing caught
 * it: `.speedo__stat { display: flex }` quietly beat the UA rule, so a live
 * Hypercar with no battery channel rendered "BATTERY —" instead of nothing.
 * The bug is invisible to the JS (the attribute was set correctly) and to a
 * screenshot of a car that happens to have every channel — so the CSS is what
 * gets checked.
 */
const css = fs.readFileSync(
  path.join(__dirname, '..', 'overlay', 'css', 'overlay.css'),
  'utf8',
);

// Every speedo selector that sets a display, and therefore needs the override.
const displayed = [...css.matchAll(/(\.speedo[^{]*)\{([^}]*)\}/g)]
  .filter(([, , body]) => /(^|[;\s])display\s*:/.test(body))
  .map(([, sel]) => sel.trim())
  .filter((sel) => !sel.includes('[hidden]'));

check(
  '.speedo__stat sets a display (the rule that caused the bug)',
  displayed.some((s) => s.includes('.speedo__stat')),
  displayed.find((s) => s.includes('.speedo__stat')),
);
check(
  '.speedo__stat[hidden] restores display:none',
  /\.speedo__stat\[hidden\]\s*\{[^}]*display\s*:\s*none/.test(css),
);

/* -------------------------------------------------------------------------- */

console.log('\nevery styled element is one the widget actually builds');

/*
 * The other way this widget's CSS goes quietly wrong: a class gets renamed in
 * the JS and the rules that targeted it keep parsing, keep validating, and
 * simply stop matching anything. Nothing errors and the panel still renders —
 * it just loses a colour, a glow, or a layout rule. The battery bar became a
 * battery icon exactly this way.
 *
 * So every `.speedo__*` class the stylesheet targets has to be one the widget
 * (or its shell) puts in the DOM.
 */
const widgetSrc = fs.readFileSync(
  path.join(__dirname, '..', 'overlay', 'js', 'widgets', 'speedo.js'),
  'utf8',
);
const shellSrc = fs.readFileSync(
  path.join(__dirname, '..', 'overlay', 'js', 'shells.js'),
  'utf8',
);
const markup = widgetSrc + shellSrc;

const styled = [...new Set([...css.matchAll(/\.(speedo__[a-z0-9-]+)/g)].map((m) => m[1]))];
const orphans = styled.filter((cls) => !markup.includes(cls));
check(
  'no styled .speedo__* class is missing from the markup',
  orphans.length === 0,
  orphans.length ? `orphaned: ${orphans.join(', ')}` : `${styled.length} classes checked`,
);

// And the regen glow specifically, since it is the readout most easily lost to
// a rename: it must target the battery icon, not whatever it used to be called.
check(
  'the regen state lights the battery icon',
  /\[data-flow="regen"\][^{]*\.speedo__batt-icon\s*\{/.test(css),
);

/* -------------------------------------------------------------------------- */

console.log('\nthe cluster geometry');

/*
 * The silhouette is drawn from constants and the DOM is positioned from the SAME
 * constants, so most of the layout cannot drift. Three things still can, and all
 * three are silent when they do:
 *
 *   • a box escaping the design behaviour box — a pod half outside the bezel
 *     still renders, it just looks like a rendering fault;
 *   • the two rev bars disagreeing about length, which would make one reach the
 *     shift point before the other and destroy the convergence the widget is
 *     built around;
 *   • the radar's aspect, which lives in radar.js and is duplicated into
 *     speedo.js because the pod has to size against it. If radar.js changes it,
 *     the radar overflows its well and the player's own car stops being centred.
 */
const { w: DW, h: DH } = api.DESIGN;

check('the design box is the reference cluster aspect', DW > DH * 2, `${DW}x${DH}`);

const boxes = Object.entries(api.BOXES);
const escaped = boxes.filter(
  ([, b]) => b.x < 0 || b.y < 0 || b.x + b.w > DW || b.y + b.h > DH,
);
check(
  'every positioned box is inside the design box',
  escaped.length === 0,
  escaped.length ? `outside: ${escaped.map(([k]) => k).join(', ')}` : `${boxes.length} boxes`,
);

// The budget wells must not overlap the centre column, or the four budgets land
// on top of the speed and the gear.
const { budgetL, budgetR, core } = api.BOXES;
check(
  'the left well clears the centre column',
  budgetL.x + budgetL.w <= core.x,
  `${budgetL.x + budgetL.w} <= ${core.x}`,
);
check(
  'the right well clears the centre column',
  core.x + core.w <= budgetR.x,
  `${core.x + core.w} <= ${budgetR.x}`,
);
check('the wells are mirror images', budgetL.x === DW - budgetR.x - budgetR.w);

// The two bars are one shape and its mirror, so they must measure the same.
// A difference here means one side reaches the shift point first.
const left = api.buildBar(false);
const right = api.buildBar(true);
check(
  'both rev bars are the same length',
  Math.abs(left[left.length - 1].len - right[right.length - 1].len) < 1e-9,
  `${left[left.length - 1].len.toFixed(3)} vs ${right[right.length - 1].len.toFixed(3)}`,
);
check(
  'the bars start at the bottom outer corners',
  left[0].x < DW / 2 && right[0].x > DW / 2 && left[0].y === right[0].y,
  `left x=${left[0].x} right x=${right[0].x} y=${left[0].y}`,
);
check(
  'the bars meet at the top middle, without crossing',
  left[left.length - 1].x < DW / 2 &&
    right[right.length - 1].x > DW / 2 &&
    left[left.length - 1].y === right[right.length - 1].y,
  `tips at ${left[left.length - 1].x} / ${right[right.length - 1].x}`,
);
// Cumulative length must be strictly non-decreasing, or stroking to a fraction
// walks backwards and the band renders in pieces.
check(
  'bar length is monotonic along the path',
  left.every((p, i) => i === 0 || p.len >= left[i - 1].len),
);

// The tick marks hang off the outward normal. Pointing inward puts them over the
// pods, where they read as debris rather than as a scale — the sign of `s` in
// barPointAt is the whole content of this check.
const midLeft = api.barPointAt(left, 0.1, false);
const midRight = api.barPointAt(right, 0.1, true);
check(
  'the left bar\'s ticks point outward (left)',
  midLeft.nx < -0.5,
  `nx=${midLeft.nx.toFixed(3)}`,
);
check(
  'the right bar\'s ticks point outward (right)',
  midRight.nx > 0.5,
  `nx=${midRight.nx.toFixed(3)}`,
);
// …and at the top of the run, outward is UP on both sides.
check(
  'ticks along the top point up on both bars',
  api.barPointAt(left, 0.75, false).ny < -0.5 && api.barPointAt(right, 0.75, true).ny < -0.5,
);

/* -------------------------------------------------------------------------- */

console.log('\nthe cluster stands alone');

/*
 * The cluster nested the real radar and trackmap sections in its wells for one
 * release. It worked, but both modules keep module-level state and client.js
 * binds one root per widget, so the nested copies had to be the ONLY ones on the
 * page — you could have the cluster or a standalone radar, never both.
 *
 * These assertions keep it reverted. Re-nesting without first making those two
 * widgets multi-instance would silently kill whichever copy lost the selector,
 * and an empty well looks exactly like a widget waiting for telemetry.
 */
// Just the speedo entry. Shell entries are separated by a blank line; matching
// against the whole file instead runs straight into the next widget's markup.
const speedoShell = (/\n {4}speedo:([\s\S]*?)\r?\n\r?\n/.exec(shellSrc) || [, ''])[1];

check('the speedo entry was found in the shells', speedoShell.length > 0);
check(
  'the cluster shell nests no other widget',
  !/data-widget=/.test(speedoShell.replace(/data-widget=\\?"speedo\\?"/, '')),
);
check(
  'radar and trackmap are still their own shells',
  /radar:\s*\n?\s*'<section/.test(shellSrc) && /trackmap:\s*\n?\s*'<section/.test(shellSrc),
);
check(
  'the cluster shell has no panel header',
  !speedoShell.includes('panel__header'),
);
check(
  'the cluster shell carries the stage and readout-layer roles',
  /data-role=\\?"stage\\?"/.test(speedoShell) && /data-role=\\?"cluster\\?"/.test(speedoShell),
);

const ingameSrc = fs.readFileSync(
  path.join(__dirname, '..', 'overlay', 'ingame.html'),
  'utf8',
);
check(
  'the in-game injector plays no favourites between widgets',
  !/indexOf\("speedo"\)/.test(ingameSrc),
  'the cluster no longer drops the loose radar/trackmap',
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
