/**
 * scripts/test-racecontrol.js — the race-control channel through the simulator.
 * -----------------------------------------------------------------------------
 * The live sources for these fields were pinned by probing real races (see
 * docs/race-control-signals.md); what can regress silently is the CONTRACT the
 * widget reads — that the fields exist, carry the shapes the probe recorded,
 * and walk the demo through every state the widget has to render. The
 * simulator is that contract's reference implementation, so it is what gets
 * held to it.
 *
 * Covers: the start gantry animating through the demo countdown and showing
 * lights-out at green, the sector rail cycling its yellow, the pit block's
 * limiter/entry-distance envelope around the demo stop, and the live
 * lap-validity flag voiding on a charge and restoring after.
 *
 * Run: node scripts/test-racecontrol.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SimulatorProvider } = require('../dist/telemetry/simulatorProvider');

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

/** Step the provider in dt-second ticks up to `untilSec`, collecting frames. */
function run(sim, state, untilSec, dt = 0.2) {
  const frames = [];
  while (state.t < untilSec) {
    state.t += dt;
    frames.push(sim.poll(state.t * 1000, dt * 1000));
  }
  return frames;
}

console.log('\nrace-control frame contract, via the simulator\n');

{
  const sim = new SimulatorProvider();
  const state = { t: 0 };

  /* ------------------------- the start sequence -------------------------- */

  const preGreen = run(sim, state, 19.5);
  const countdownFrames = preGreen.filter((f) => f.session.phase === 'countdown');
  check('demo reaches a countdown phase', countdownFrames.length > 0, countdownFrames.length);

  const gantry = countdownFrames.map((f) => f.session.startLights).filter(Boolean);
  check(
    'gantry is published through the countdown',
    gantry.length === countdownFrames.length,
  );
  check(
    'gantry has a plausible lamp count',
    gantry.every((g) => g.total === 5),
  );
  const frames = [...new Set(gantry.map((g) => g.frame))];
  check(
    'lamps walk upward through the countdown',
    frames.length >= 3 && Math.min(...frames) >= 1 && Math.max(...frames) <= 5,
    frames.join(','),
  );

  const early = run(sim, state, 21.5);
  const green = early.filter((f) => f.session.phase === 'green');
  check('demo goes green after the countdown', green.length > 0);
  check(
    'lights-out frame (frame > total) shows at the green',
    green.some((f) => f.session.startLights && f.session.startLights.frame > f.session.startLights.total),
  );

  run(sim, state, 23); // let the two-second lights-out flash finish
  const settled = run(sim, state, 30);
  check(
    'gantry returns to dark once the start is done',
    settled.every((f) => !f.session.startLights || f.session.startLights.frame === 0),
  );

  /* --------------------------- the sector rail --------------------------- */

  const cycle = run(sim, state, 100);
  const sectorStates = new Set(
    cycle.map((f) => (f.session.sectorFlags ? f.session.sectorFlags.join('|') : 'absent')),
  );
  check(
    'sector rail is always published',
    !sectorStates.has('absent'),
    [...sectorStates].join('  '),
  );
  check('sector rail shows a yellow at some point', [...sectorStates].some((s) => s.includes('yellow')));
  check('sector rail shows all-clear at some point', sectorStates.has('none|none|none'));

  /* ------------------------ the pit-lane envelope ------------------------ */

  // The demo pit cycle is minutes long; walk far enough to see all of it.
  const pitRun = run(sim, state, 400);
  const pit = (f) => f.player.pit || {};
  check(
    'limiter state is always a boolean in demo',
    pitRun.every((f) => typeof pit(f).limiterOn === 'boolean'),
  );
  const entering = pitRun.filter((f) => pit(f).phase === 'entering');
  check('demo reaches the pit lane', entering.length > 0);
  check(
    'limiter is on through the lane',
    entering.every((f) => pit(f).limiterOn === true),
  );
  const approach = pitRun.filter(
    (f) => pit(f).phase === 'none' && typeof pit(f).entryDistM === 'number' && pit(f).entryDistM > 0,
  );
  check('entry distance counts down on the approach', approach.length > 1);
  check(
    'approach distances are within the marker envelope',
    approach.every((f) => pit(f).entryDistM <= 900),
    approach.length && `${approach[0].player.pit.entryDistM} m first`,
  );
  const onTrack = pitRun.filter((f) => pit(f).phase === 'none' && pit(f).entryDistM === undefined);
  check('entry distance is ABSENT away from the pits, not zero', onTrack.length > 0);

  /* -------------------------- live lap validity -------------------------- */

  const tl = (f) => f.player.trackLimits;
  const validity = new Set(
    pitRun.concat(cycle).map((f) => (tl(f) ? String(tl(f).lapValid) : 'noblock')),
  );
  check('lapValid voids on a charge (false seen)', validity.has('false'), [...validity].join(','));
  check('lapValid restores after (true seen)', validity.has('true'));
}

/* ---------------------------------------------------------------------------
 * The widget itself, against a DOM stub — same approach as
 * test-carclass-ui.js: widgets are browser IIFEs, so racecontrol.js is
 * evaluated in a vm against the smallest document it will load on, and its
 * update() driven through each state the CSS keys off `data-race`.
 * ------------------------------------------------------------------------- */

console.log('\nracecontrol widget states, against a DOM stub\n');

function makeElement(tag) {
  return {
    tagName: tag, className: '', textContent: '', innerHTML: '', hidden: false,
    children: [], attrs: {}, style: {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    querySelector() { return null; },
  };
}

{
  let widgetDef = null;
  // The widget times its green flash off Date.now(); the test owns the clock
  // so it can step past the four-second window instead of sleeping through it.
  let nowMs = 1_000_000;
  const sandbox = {
    window: { ApexOverlay: { registerWidget: (name, def) => { widgetDef = { name, def }; } } },
    document: { createElement: makeElement },
    Date: { now: () => nowMs },
    Math,
    Array,
    console,
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'js', 'widgets', 'racecontrol.js'), 'utf8');
  vm.runInContext(src, sandbox);

  check('widget registers as "racecontrol"', widgetDef && widgetDef.name === 'racecontrol');

  // The root the widget binds: a meta slot and a mount, like the real shell.
  const meta = makeElement('span');
  const mount = makeElement('div');
  const root = makeElement('section');
  root.querySelector = (sel) => (sel.indexOf('meta') !== -1 ? meta : mount);
  widgetDef.def.init(root, {});

  const wrap = mount.children[0];
  const lightsEl = wrap.children[0];
  const msgEl = wrap.children[1];
  const subEl = wrap.children[2];
  const rail = wrap.children[3];

  const frame = (session, pit) => ({ session, player: { pit } });
  const st = () => root.getAttribute('data-race');

  // Formation with the limiter off: the pre-start prompt.
  widgetDef.def.update(frame({ phase: 'formation', flag: 'none' }, { phase: 'none', limiterOn: false }));
  check('formation + limiter off → limiter state', st() === 'limiter', st());
  check('…says FORMATION LAP', msgEl.textContent === 'FORMATION LAP');
  check('…sub says ENGAGE PIT LIMITER', subEl.textContent === 'ENGAGE PIT LIMITER');

  // Formation with the limiter channel ABSENT: no prompt, no guessing.
  widgetDef.def.update(frame({ phase: 'formation', flag: 'none' }, { phase: 'none' }));
  check('formation + limiter unknown → plain formation', st() === 'formation', st());
  check('…and no sub prompt', subEl.hidden === true);

  // The gantry, mid-countdown.
  widgetDef.def.update(
    frame({ phase: 'countdown', flag: 'none', startLights: { frame: 3, total: 5 } }, { phase: 'none', limiterOn: true }),
  );
  check('countdown → countdown state with lights up', st() === 'countdown' && lightsEl.hidden === false);
  check(
    '…3 of 5 lamps lit',
    lightsEl.children.filter((l) => l.getAttribute('data-lit') === '1').length === 3 &&
      lightsEl.children.length === 5,
  );

  // Lights out: the green edge, armed by frame > total (the rolling start path).
  widgetDef.def.update(
    frame({ phase: 'green', flag: 'green', startLights: { frame: 6, total: 5 } }, { phase: 'none', limiterOn: false }),
  );
  check('lights-out → green flash', st() === 'green', st());
  check('…says GREEN FLAG', msgEl.textContent === 'GREEN FLAG');

  // Same instant with the limiter still on: the flash yields to the mistake.
  widgetDef.def.update(
    frame({ phase: 'green', flag: 'green', startLights: { frame: 6, total: 5 } }, { phase: 'none', limiterOn: true }),
  );
  check('…limiter still on at green → limiter state', st() === 'limiter', st());

  // FCY outranks everything else.
  widgetDef.def.update(frame({ phase: 'green', flag: 'yellow' }, { phase: 'none', limiterOn: false }));
  check('session flag yellow → FCY banner', st() === 'fcy' && msgEl.textContent === 'FULL COURSE YELLOW');

  // Step past the green flash: the states below are mid-race, not start-line.
  nowMs += 10_000;

  // Pit requested, inside the marker envelope, limiter off and close: alarm.
  widgetDef.def.update(
    frame({ phase: 'green', flag: 'green' }, { phase: 'request', entryDistM: 128, limiterOn: false }),
  );
  check('pit request at 128 m + limiter off → limiter alarm', st() === 'limiter', st());
  check('…names the distance', msgEl.textContent === 'PIT ENTRY 128 m', msgEl.textContent);

  // Same request, further out: informational, no alarm.
  widgetDef.def.update(
    frame({ phase: 'green', flag: 'green' }, { phase: 'request', entryDistM: 640, limiterOn: false }),
  );
  check('pit request at 640 m → pitentry state', st() === 'pitentry', st());

  // A booked stop beyond the countdown envelope: the steady confirmation the
  // driver glances for after pressing the button — from the sim's own flag,
  // so a stop booked through the game's OWN bind shows exactly the same.
  widgetDef.def.update(
    frame({ phase: 'green', flag: 'green' }, { phase: 'request', entryDistM: 1400, limiterOn: true }),
  );
  check('pit request beyond 900 m → PIT REQUESTED', st() === 'pitrequest', st());
  check('…says PIT REQUESTED', msgEl.textContent === 'PIT REQUESTED', msgEl.textContent);

  // No entry channel at all (spectating-grade feed): the confirmation stands.
  widgetDef.def.update(frame({ phase: 'green', flag: 'green' }, { phase: 'request' }));
  check('…with no entry channel too', st() === 'pitrequest', st());

  // Toggled off on track: the cancel flash, then quiet.
  widgetDef.def.update(frame({ phase: 'green', flag: 'green' }, { phase: 'none', limiterOn: false }));
  check('request toggled off → cancelled flash', st() === 'pitcancel', st());
  check('…says PIT REQUEST CANCELLED', msgEl.textContent === 'PIT REQUEST CANCELLED', msgEl.textContent);
  nowMs += 5_000;
  widgetDef.def.update(frame({ phase: 'green', flag: 'green' }, { phase: 'none', limiterOn: false }));
  check('…and expires back to quiet', st() === 'idle', st());

  // A request consumed by actually entering the lane is NOT a cancellation.
  widgetDef.def.update(
    frame({ phase: 'green', flag: 'green' }, { phase: 'request', entryDistM: 40, limiterOn: true }),
  );
  widgetDef.def.update(frame({ phase: 'green', flag: 'green' }, { phase: 'entering', limiterOn: true }));
  check('request → entering stays quiet, no cancel', st() === 'idle', st());
  widgetDef.def.update(frame({ phase: 'green', flag: 'green' }, { phase: 'none', limiterOn: false }));
  check('…and leaving the lane does not flash either', st() === 'idle', st());

  // Sector rail from the sim's own flags.
  widgetDef.def.update(
    frame({ phase: 'green', flag: 'green', sectorFlags: ['none', 'yellow', 'none'] }, { phase: 'none' }),
  );
  check(
    'sector rail lights S2 from sectorFlags',
    rail.children[1].getAttribute('data-flag') === 'yellow' &&
      rail.children[0].getAttribute('data-flag') === 'none',
  );
  check('…and the panel takes the quiet yellow state', st() === 'yellow', st());
}

/* ---------------------------------------------------------------------------
 * The limits widget's lap-validity chip — the STAGED half of the same live
 * channel: countLapFlag dropping opens a provisional EVALUATING (the window a
 * lift still saves the lap), hardening to LAP INVALID only if the sim never
 * restores it. The staging is a clock-driven state machine inside limits.js,
 * so it gets the same fake-clock treatment as the green flash above.
 * ------------------------------------------------------------------------- */

console.log('\nlimits lap-validity chip staging, against a DOM stub\n');

{
  let widgetDef = null;
  let nowMs = 5_000_000;
  const sandbox = {
    window: { ApexOverlay: { registerWidget: (name, def) => { if (name === 'limits') widgetDef = def; } } },
    document: { createElement: makeElement },
    Date: { now: () => nowMs },
    Math,
    Array,
    String,
    console,
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'overlay', 'js', 'widgets', 'limits.js'), 'utf8');
  vm.runInContext(src, sandbox);

  check('limits widget registers', !!widgetDef);

  const meta = makeElement('span');
  const mount = makeElement('div');
  const root = makeElement('section');
  root.querySelector = (sel) => (sel.indexOf('meta') !== -1 ? meta : mount);
  widgetDef.init(root);

  // The chip lives in the head row: wrap > head > [count, label, lap, penalty].
  const lapEl = mount.children[0].children[0].children[2];

  // The slice of ctx the widget actually reaches for, quiet on every channel
  // that is not the one under test.
  const ctx = {
    fmt: { has: (v) => typeof v === 'number' && v >= 0 },
    crit: (el, text) => { el.textContent = text; },
    penaltyCount: () => 0,
    consequenceFresh: () => false,
    servedFresh: () => false,
    penaltyLabel: () => 'PENALTY',
  };
  const frame = (lapValid) => ({
    player: { trackLimits: { points: 0, pointsLimit: 5, msSinceCharge: -1, charges: [], lapValid } },
  });
  const stage = () => root.getAttribute('data-lap');

  widgetDef.update(frame(true), ctx);
  check('a counting lap keeps the chip hidden', lapEl.hidden === true && stage() === 'ok', stage());

  widgetDef.update(frame(false), ctx);
  check(
    'the flag dropping opens as EVALUATING',
    stage() === 'evaluating' && lapEl.textContent === 'EVALUATING' && lapEl.hidden === false,
    stage(),
  );

  nowMs += 2_000;
  widgetDef.update(frame(false), ctx);
  check('still provisional inside the lift window', stage() === 'evaluating', stage());

  widgetDef.update(frame(true), ctx);
  check('a lift that gives the time back clears it', lapEl.hidden === true && stage() === 'ok', stage());

  widgetDef.update(frame(false), ctx);
  check('a second excursion opens its own window', stage() === 'evaluating', stage());

  nowMs += 4_000;
  widgetDef.update(frame(false), ctx);
  check(
    'held past the window it hardens to LAP INVALID',
    stage() === 'invalid' && lapEl.textContent === 'LAP INVALID',
    stage(),
  );

  nowMs += 30_000;
  widgetDef.update(frame(false), ctx);
  check('…and the verdict stands for the rest of the lap', stage() === 'invalid', stage());

  widgetDef.update(frame(true), ctx);
  check('a lap that counts again clears the verdict', lapEl.hidden === true && stage() === 'ok', stage());

  widgetDef.update({ player: { trackLimits: null } }, ctx);
  check('losing the block entirely hides the chip too', lapEl.hidden === true && stage() === 'ok');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
