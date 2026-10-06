/**
 * scripts/test-aidintervention.js — live TC / ABS intervention channels.
 * -----------------------------------------------------------------------------
 * The input overlay once showed every gear shift as TC and never showed ABS at
 * all, and both looked plausible on a screenshot. Each case here is a situation
 * the 2026-10-06 LMU probe actually recorded, with one correct answer:
 * shift cuts and the pit limiter are NOT TC, a flagged TC pulse IS, and ABS is
 * read from the per-wheel pressure the pedal channel never shows.
 *
 * Run: node scripts/test-aidintervention.js   (after `npm run build`)
 */

'use strict';

const { AidInterventionTracker, ABS_WINDOW_S } = require('../dist/telemetry/aidIntervention');

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

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const DT = 0.02; // 50 Hz, LMU's physics rate as measured

/** One frame; everything off unless overridden. */
function raw(t, over) {
  return Object.assign(
    {
      t,
      throttle: 0,
      filteredThrottle: 0,
      brake: 0,
      wheelBrake: [0, 0, 0, 0],
      tcActive: false,
      absActive: false,
    },
    over || {},
  );
}

/** Feeds `n` identical frames from `t`, returns [lastOutput, nextT]. */
function feed(tr, t, n, over) {
  let out;
  for (let i = 0; i < n; i++) out = tr.update(raw(t + i * DT, over));
  return [out, t + n * DT];
}

console.log('\nTC');
{
  const tr = new AidInterventionTracker();
  let t = 10;
  let out;
  [out, t] = feed(tr, t, 3, { throttle: 1, filteredThrottle: 0 });
  check('upshift cut (flag down, filtered 0) is not TC', out.tc === 0, out.tc);
  [out, t] = feed(tr, t, 50, { throttle: 1, filteredThrottle: 0.06 });
  check('pit limiter (flag down) is not TC', out.tc === 0, out.tc);
  [out, t] = feed(tr, t, 2, { throttle: 1, filteredThrottle: 0, tcActive: true });
  check('shift cut with the TC flag up is still not TC', out.tc === 0, out.tc);
  [out, t] = feed(tr, t, 1, { throttle: 1, filteredThrottle: 0.68, tcActive: true });
  check('flagged TC pulse reads the throttle removed', near(out.tc, 0.32, 1e-9), out.tc);
  [out, t] = feed(tr, t, 1, { throttle: 1, filteredThrottle: 1 });
  check('one-frame gap between pulses keeps most of the line', out.tc > 0.32 * 0.75, out.tc.toFixed(3));
  [out, t] = feed(tr, t, 15, { throttle: 1, filteredThrottle: 1 });
  check('the line falls away within 0.3 s of the last pulse', out.tc < 0.05, out.tc.toFixed(3));
  [out, t] = feed(tr, t, 40, { throttle: 1, filteredThrottle: 1 });
  check('…and settles at exactly 0', out.tc === 0, out.tc);
}

console.log('\nABS');
{
  const tr = new AidInterventionTracker();
  let t = 20;
  let out;
  // Clean braking: every wheel at half the pedal, as the probe saw.
  [out, t] = feed(tr, t, 30, { brake: 0.6, wheelBrake: [0.3, 0.3, 0.3, 0.3] });
  check('clean braking reports no ABS', out.abs === 0, out.abs);
  // FL released to 0.04 at 0.72 pedal; expected 0.36.
  [out, t] = feed(tr, t, 1, {
    brake: 0.72, wheelBrake: [0.04, 0.36, 0.36, 0.36], absActive: true,
  });
  const want = 0.72 * (1 - 0.04 / 0.36);
  check('released wheel reads as brake removed at the worst wheel', near(out.abs, want, 0.01),
    `${out.abs.toFixed(3)} vs ${want.toFixed(3)}`);
  // The flag flickers off mid-stop while the dip continues.
  [out, t] = feed(tr, t, 1, { brake: 0.72, wheelBrake: [0.1, 0.36, 0.36, 0.36] });
  check('a dip on a flag-off frame inside the window still counts', out.abs > 0.4, out.abs.toFixed(3));
  // Long after the last flag, a dip is pressure lag, not ABS.
  [out, t] = feed(tr, t, Math.ceil((ABS_WINDOW_S + 0.4) / DT), {
    brake: 0.72, wheelBrake: [0.36, 0.36, 0.36, 0.36],
  });
  [out, t] = feed(tr, t, 1, { brake: 0.72, wheelBrake: [0.2, 0.36, 0.36, 0.36] });
  check('a dip with no recent ABS flag is not ABS', out.abs === 0, out.abs);
  [out, t] = feed(tr, t, 1, { brake: 0, wheelBrake: [0, 0, 0, 0], absActive: true });
  check('off the brake there is nothing for ABS to release', out.abs < 0.3, out.abs.toFixed(3));
}

console.log('\nABS before a ratio is learned');
{
  const tr = new AidInterventionTracker();
  // First touch of the brakes goes straight into ABS: the axle partner stands in.
  const out = tr.update(raw(5, { brake: 0.8, wheelBrake: [0.4, 0.1, 0.4, 0.4], absActive: true }));
  check('partner wheel is the reference', near(out.abs, 0.8 * 0.75, 0.01), out.abs.toFixed(3));
}

console.log('\nClock');
{
  const tr = new AidInterventionTracker();
  tr.update(raw(30, { throttle: 1, filteredThrottle: 0.7, tcActive: true }));
  const back = tr.update(raw(2, { throttle: 1, filteredThrottle: 1 }));
  check('clock going backwards (new session) drops the envelope', back.tc === 0, back.tc);
  const unknown = tr.update(raw(-1, { throttle: 1, filteredThrottle: 0.7, tcActive: true }));
  check('unknown clock reports nothing', unknown.tc === 0 && unknown.abs === 0);
  const bad = tr.update(raw(3, { brake: 0.7, wheelBrake: null, absActive: true }));
  check('unreadable wheel block reports no ABS', bad.abs === 0, bad.abs);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
