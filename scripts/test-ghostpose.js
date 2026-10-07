/**
 * scripts/test-ghostpose.js — Ghost HUD's pose between frames: timing rules.
 * -----------------------------------------------------------------------------
 * Ghost HUD paints on its own animation loop and asks `ghost-pose.js` where the
 * car was at the instant being drawn. Every rule in that module is about time —
 * how far behind to draw, how far past the data to guess, when a pose is too
 * old to stand for "now", which clock a timestamp belongs to — and a timing
 * bug is invisible in a still screenshot. It shows only as a picture that
 * stutters, swims, spins the world through 358°, or blanks on a dropped frame.
 *
 * So each case drives the buffer with explicit clocks and asserts the one
 * right answer, the same way `scripts/test-ghostgeom.js` pins the geometry.
 *
 * Also checks that both overlay hosts load the module, after `ghost-geom.js`
 * and before the widget that needs it: a host that misses it leaves Ghost HUD
 * blank with nothing but a console line to say why.
 *
 * Run: node scripts/test-ghostpose.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const P = require('../overlay/js/ghost-pose');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  } else {
    failed++;
    console.log('  FAIL  ' + name + (detail !== undefined ? '   [' + detail + ']' : ''));
  }
}

const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);
const out = () => ({ x: NaN, z: NaN, h: NaN, gapM: NaN, ageMs: NaN });

/** A buffer fed a car doing 60 m/s along +Z, one sample every `dt` ms from t=1000. */
function driving(dt, count, opts) {
  const b = P.create(opts);
  for (let i = 0; i < count; i++) {
    const t = 1000 + i * dt;
    P.push(b, t, 0, (t / 1000) * 60, 0, 10 + i);
  }
  return b;
}

console.log('');
console.log('1) interpolation — drawn a fixed delay behind the newest sample');
{
  const b = driving(16, 5); // samples at 1000..1064
  const o = out();
  // Drawn at 1072: 40 ms back is 1032, exactly the third sample.
  let st = P.sample(b, 1072, o);
  check('on a sample, exactly that sample', st === P.LIVE && near(o.z, 1.032 * 60, 1e-9), o.z);
  // At 1080 the instant drawn is 1040, halfway between 1032 and 1048.
  st = P.sample(b, 1080, o);
  check('between samples, linearly', st === P.LIVE && near(o.z, 1.04 * 60, 1e-9), o.z);
  check('…the gap rides along the same way', near(o.gapM, 12.5, 1e-9), o.gapM);
  check('ageMs is the newest sample\'s age', near(o.ageMs, 16), o.ageMs);
  // Every paint between two frames moves the car forward — no plateaus.
  let prev = -Infinity;
  let monotone = true;
  for (let t = 1050; t <= 1104; t += 2) {
    P.sample(b, t, o);
    if (!(o.z > prev)) monotone = false;
    prev = o.z;
  }
  check('the car moves on every paint, not only when a frame lands', monotone);

  const fresh = P.create();
  check('an empty buffer has nothing to draw', P.sample(fresh, 1000, o) === P.NONE);
  P.push(fresh, 1000, 5, 6, 7, 8);
  check('one sample is drawn as it is', P.sample(fresh, 1010, o) === P.LIVE && o.x === 5 && o.z === 6 && o.h === 7);
  const early = driving(16, 3);
  P.sample(early, 1005, o); // instant drawn (965) is before anything kept
  check('before the oldest sample it holds the oldest, never guesses backwards', near(o.z, 60, 1e-9), o.z);
}

console.log('');
console.log('2) heading — always the short way round');
{
  const b = P.create();
  const o = out();
  P.push(b, 1000, 0, 0, 179, 0);
  P.push(b, 1020, 0, 1, -179, 0);
  P.sample(b, 1050, o); // halfway
  check('179° → −179° passes through 180°, not 0°', near(Math.abs(o.h), 180, 1e-9), o.h);
  check('…and is reported in (−180, 180]', o.h > -180 && o.h <= 180, o.h);
  const c = P.create();
  P.push(c, 1000, 0, 0, -170, 0);
  P.push(c, 1020, 0, 1, 170, 0);
  P.sample(c, 1050, o);
  check('−170° → 170° turns 20° left through 180°', near(Math.abs(o.h), 180, 1e-9), o.h);
  const d = P.create();
  P.push(d, 1000, 0, 0, 10, 0);
  P.push(d, 1020, 0, 1, 30, 0);
  P.sample(d, 1050, o);
  check('an ordinary turn interpolates plainly', near(o.h, 20, 1e-9), o.h);
  P.push(d, 1040, 0, 2, 50, 0);
  P.sample(d, 1100, o); // 20 ms past the newest: extrapolated along the turn
  check('extrapolation carries the turn on', near(o.h, 70, 1e-9), o.h);
}

console.log('');
console.log('3) extrapolation — bridges a dropped frame, then stops');
{
  const b = driving(16, 4); // newest at 1048, 0.96 m per sample
  const o = out();
  let st = P.sample(b, 1048 + 40 + 30, o); // 30 ms past the newest
  check('a little past the data it carries on at the last speed', st === P.LIVE && near(o.z, (1.048 + 0.03) * 60, 1e-9), o.z);
  st = P.sample(b, 1048 + 40 + 100, o);
  const atCap = o.z;
  check('…up to the 100 ms cap', st === P.LIVE && near(atCap, (1.048 + 0.1) * 60, 1e-9), atCap);
  st = P.sample(b, 1048 + 40 + 150, o);
  check('past the cap the pose is HELD, not guessed further', st === P.HELD && near(o.z, atCap, 1e-9), st + ' ' + o.z);
  const custom = driving(16, 4, { maxExtrapMs: 20 });
  P.sample(custom, 1048 + 40 + 50, o);
  check('the cap is an option', near(o.z, (1.048 + 0.02) * 60, 1e-9), o.z);
  // A last step longer than the hold window is no velocity to trust.
  const gap = P.create();
  P.push(gap, 1000, 0, 0, 0, 0);
  P.push(gap, 1400, 0, 24, 0, 0);
  P.sample(gap, 1400 + 40 + 50, o);
  check('a velocity from a 400 ms gap is not extrapolated', near(o.z, 24, 1e-9), o.z);
}

console.log('');
console.log('4) staleness — hold through a missing frame, give up on a dead feed');
{
  const b = driving(16, 4); // newest at 1048
  const o = out();
  check('one missing frame later it is still drawn', P.sample(b, 1048 + 33, o) === P.LIVE);
  check('at 240 ms it is held, not blanked', P.sample(b, 1048 + 240, o) === P.HELD);
  check('past 250 ms it is STALE', P.sample(b, 1048 + 251, o) === P.STALE, o.ageMs);
  check('…and still filled in, for a caller that wants the last pose', Number.isFinite(o.z));
  const longer = driving(16, 4, { holdMs: 500 });
  check('the hold is an option', P.sample(longer, 1048 + 400, o) === P.HELD && P.sample(longer, 1048 + 501, o) === P.STALE);
  check('newestTime reports the newest stamp', P.newestTime(b) === 1048 && Number.isNaN(P.newestTime(P.create())));
}

console.log('');
console.log('5) the stream — restarts, teleports, duplicates and a full ring');
{
  const o = out();
  const b = driving(16, 6);
  P.push(b, 900, 50, 50, 0, 0); // time went backwards: a reconnect or a replay
  check('a sample older than the newest restarts the buffer', b.n === 1, b.n);
  P.sample(b, 940, o);
  check('…and the old samples no longer drag the pose', o.x === 50 && o.z === 50);

  const tow = driving(16, 6);
  P.push(tow, 1100, 500, 500, 0, 0); // 450 m in 16 ms: a reset to the pits
  P.sample(tow, 1130, o);
  check('a jump over 60 m is a reset — no flight over the infield', tow.n === 1 && o.x === 500, tow.n);

  const dup = P.create();
  P.push(dup, 1000, 0, 0, 0, 0);
  P.push(dup, 1016, 0, 1, 0, 0);
  P.push(dup, 1016, 0, 2, 0, 0); // same stamp: the newer reading wins
  P.sample(dup, 1056, o);
  check('a sample at the same time replaces the newest', dup.n === 2 && o.z === 2, dup.n + ' ' + o.z);

  const ring = driving(16, 40, { capacity: 8 }); // wraps the ring five times
  P.sample(ring, 1000 + 39 * 16 + 40 - 8, o); // halfway between the last two
  check('the ring keeps working after wrapping', ring.n === 8 && near(o.z, (1 + 38.5 * 0.016) * 60, 1e-9), o.z);
}

console.log('');
console.log('6) clocks — the server\'s stamp, never trusted across machines');
{
  const o = out();
  // The server's wall clock is 5 s BEHIND this machine's local clock: every
  // frame's stamp looks 5 s old. Compared directly, the car would be stale
  // forever. Through `stamp` the offset cancels.
  const behind = P.create();
  for (let i = 0; i < 10; i++) {
    const local = 1000 + i * 16.7 + (i % 3) * 2; // a little arrival jitter
    const server = 1_700_000_000_000 + i * 16.7 - 5000;
    P.push(behind, P.stamp(behind, server, local), 0, i, 0, 0);
  }
  let st = P.sample(behind, 1000 + 9 * 16.7 + 20, o);
  check('a server clock 5 s behind still draws a live car', st === P.LIVE, o.ageMs.toFixed(1) + ' ms old');

  const ahead = P.create();
  let future = false;
  for (let i = 0; i < 10; i++) {
    const local = 1000 + i * 16.7;
    const t = P.stamp(ahead, 1_700_000_000_000 + i * 16.7 + 5000, local);
    if (t > local) future = true;
    P.push(ahead, t, 0, i, 0, 0);
  }
  check('a server clock 5 s ahead never puts a sample in the future', !future);
  st = P.sample(ahead, 1000 + 9 * 16.7 + 20, o);
  check('…and still draws a live car', st === P.LIVE);

  // Spacing comes from the server, not from when the page got round to it.
  const jit = P.create({ leakMs: 0 });
  const t1 = P.stamp(jit, 5000, 100); // arrived promptly
  const t2 = P.stamp(jit, 5016, 130); // parsed 14 ms late: the page was busy
  check('a late-handled frame keeps its true spacing', near(t2 - t1, 16, 1e-9), (t2 - t1).toFixed(1) + ' ms');

  const step = P.create({ leakMs: 0 });
  P.stamp(step, 5000, 100);
  const after = P.stamp(step, 5016 - 3000, 116); // the server clock stepped back 3 s
  check('a clock stepped back seconds falls back to arrival time', near(after, 116, 1e-9), after);
  P.push(step, after, 0, 0, 0, 0);
  check('…so the car is not called stale for it', P.sample(step, 130, o) === P.LIVE);

  const none = P.create();
  check('no stamp is arrival time', P.stamp(none, undefined, 123.5) === 123.5 && P.stamp(none, NaN, 7) === 7);

  // The estimate leaks upward so it can follow drift, but never past a frame.
  const leak = P.create({ leakMs: 1 });
  P.stamp(leak, 0, 100); // offset 100
  const later = P.stamp(leak, 1000, 1110); // lag 110: offset leaks to 101
  check('the offset leaks upward slowly, bounded by the real lag', near(later, 1101, 1e-9), later);
}

console.log('');
console.log('7) hosts — both pages load it, in order');
{
  for (const page of ['ingame.html', 'widget.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'overlay', page), 'utf8');
    const geom = html.indexOf('src="js/ghost-geom.js"');
    const pose = html.indexOf('src="js/ghost-pose.js"');
    const hud = html.indexOf('src="js/widgets/ghosthud.js"');
    check(page + ' loads ghost-pose.js between ghost-geom.js and the widget', geom > 0 && pose > geom && hud > pose, [geom, pose, hud].join(' < '));
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
console.log('');
process.exit(failed === 0 ? 0 : 1);
