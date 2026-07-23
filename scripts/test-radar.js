/**
 * scripts/test-radar.js — the radar projection's sign conventions + guards.
 * -----------------------------------------------------------------------------
 * The radar turns every car's WORLD position and the player's orientation matrix
 * into car-relative left/right + ahead/behind offsets. A flipped sign puts a car
 * passing on your left as a blip on your right — plausible-looking and exactly
 * the failure a proximity aid must never make. None of that is caught by a
 * typecheck or visible on a screenshot.
 *
 * So each case builds a physical situation with ONE correct answer — a car dead
 * ahead, a car alongside on the right, the player pointed east — and asserts the
 * projected sign. Run: node scripts/test-radar.js
 */

'use strict';

const {
  buildRadar,
  headingOri,
  RADAR_MAX_RANGE_M,
  ALONGSIDE_LON_M,
} = require('../dist/telemetry/radar');

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

const v = (x, y, z) => ({ x, y, z });
/** Identity orientation (LEVEL): nose along world −Z, right along world +X. */
const LEVEL = [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)];
const ORIGIN = v(0, 0, 0);

/** buildRadar with the player at the origin, level, unless overridden. */
function radar(cars, over) {
  return buildRadar(
    Object.assign({ playerPos: ORIGIN, ori: LEVEL, cars }, over),
  );
}
/** The single blip for slot id 1 in a one-car field. */
function one(pos, over) {
  const out = radar([{ slotId: 1, pos }], over);
  return out && out.length ? out[0] : null;
}

console.log('\n1) The four cardinal directions — the sign flip that matters');

{
  // Forward is −Z (ISI convention). A car 10 m up the road is at world −Z.
  const b = one(v(0, 0, -10));
  check('a car ahead reads POSITIVE longitudinal', b.longitudinalM > 0, b.longitudinalM);
  check('a car ahead has ~zero lateral', Math.abs(b.lateralM) < 0.01, b.lateralM);
}
{
  const b = one(v(0, 0, 10));
  check('a car behind reads NEGATIVE longitudinal', b.longitudinalM < 0, b.longitudinalM);
}
{
  // ISI/gMotor world is LEFT-handed (right = up × forward), verified against a
  // live LMU session — a car physically on the right must read +lateral. With a
  // level car facing world −Z that puts a physically-right car at world −X.
  const b = one(v(-5, 0, 0));
  check('a car to the RIGHT reads POSITIVE lateral', b.lateralM > 0, b.lateralM);
}
{
  const b = one(v(5, 0, 0));
  check('a car to the LEFT reads NEGATIVE lateral', b.lateralM < 0, b.lateralM);
}
{
  // 3-4-5: lateral 3, longitudinal 4 → distance 5.
  const b = one(v(3, 0, -4));
  check('distance is the planar hypotenuse', Math.abs(b.distanceM - 5) < 0.01, b.distanceM);
}

console.log('\n2) Orientation — the projection must rotate with the car');

{
  // headingOri for forward −Z must reproduce the LEVEL matrix exactly.
  const ori = headingOri({ x: 0, z: -1 });
  const ok =
    ori &&
    Math.abs(ori[0].x - 1) < 1e-9 && Math.abs(ori[2].z - 1) < 1e-9 &&
    Math.abs(ori[0].z) < 1e-9 && Math.abs(ori[2].x) < 1e-9;
  check('headingOri(forward −Z) reproduces LEVEL', ok);
}
{
  // Player pointed EAST (+X). A car further east is now AHEAD, not to the side.
  const east = headingOri({ x: 1, z: 0 });
  const ahead = buildRadar({ playerPos: ORIGIN, ori: east, cars: [{ slotId: 1, pos: v(10, 0, 0) }] })[0];
  check('facing east, a car further east reads AHEAD', ahead.longitudinalM > 0, ahead.longitudinalM);
  // Facing east (+X), right = up × forward = −Z, so a car to the NORTH (−Z) is
  // on the player's right.
  const right = buildRadar({ playerPos: ORIGIN, ori: east, cars: [{ slotId: 2, pos: v(0, 0, -10) }] })[0];
  check('facing east, a car to the north reads RIGHT', right.lateralM > 0, right.lateralM);
}
{
  // A non-origin player: only the RELATIVE position matters.
  const p = v(100, 0, 200);
  const b = buildRadar({ playerPos: p, ori: LEVEL, cars: [{ slotId: 1, pos: v(100, 0, 190) }] })[0];
  check('offset player: a car 10 m ahead still reads +10 long', Math.abs(b.longitudinalM - 10) < 0.01, b.longitudinalM);
}

console.log('\n3) Alongside — the door-to-door warning flag');

{
  const b = one(v(3, 0, 0));
  check('a car level alongside is flagged alongside', b.alongside === true);
}
{
  const b = one(v(3, 0, -(ALONGSIDE_LON_M + 4)));
  check('a car well up the road is NOT alongside', b.alongside === false, b.longitudinalM);
}

console.log('\n4) Range filter + ordering');

{
  const out = radar([{ slotId: 1, pos: v(0, 0, -100) }], { maxRangeM: 50 });
  check('a car beyond the range cap is dropped', out.length === 0, out.length);
}
{
  const out = radar([{ slotId: 1, pos: v(0, 0, -200) }]);
  check('the default cap drops a very distant car', out.length === 0 && RADAR_MAX_RANGE_M < 200);
}
{
  // Furthest supplied first; output must be nearest-first.
  const out = radar([
    { slotId: 1, pos: v(0, 0, -40) },
    { slotId: 2, pos: v(0, 0, -8) },
    { slotId: 3, pos: v(0, 0, 20) },
  ]);
  check('blips are sorted nearest-first', out[0].slotId === 2 && out[2].slotId === 1,
    out.map((b) => b.slotId).join(','));
}

console.log('\n5) Metadata passthrough');

{
  const out = radar([{ slotId: 7, pos: v(2, 0, -5), carClass: 'HYPERCAR', carNumber: '7', isFasterClass: true }]);
  const b = out[0];
  check('class / number / faster-class survive', b.carClass === 'HYPERCAR' && b.carNumber === '7' && b.isFasterClass === true);
}

console.log('\n6) Plausibility guards — a torn read must not render');

{
  check('a NaN player position rejects the block', radar([{ slotId: 1, pos: v(0, 0, -5) }], { playerPos: v(NaN, 0, 0) }) === null);
}
{
  // An orientation collapsed toward zero (torn read) must be rejected, not used
  // to pin every car to the centre.
  const dead = [v(0, 0, 0), v(0, 0, 0), v(0, 0, 0)];
  check('a degenerate orientation rejects the block', radar([{ slotId: 1, pos: v(0, 0, -5) }], { ori: dead }) === null);
}
{
  const b = one(v(NaN, 0, -5));
  check('a single NaN car is skipped, not fatal', b === null);
  const good = radar([{ slotId: 1, pos: v(NaN, 0, 0) }, { slotId: 2, pos: v(0, 0, -5) }]);
  check('a good car alongside a bad one still shows', good.length === 1 && good[0].slotId === 2, good.length);
}
{
  check('an empty field is an empty array, not null', Array.isArray(radar([])) && radar([]).length === 0);
}
{
  check('headingOri of a zero vector is null', headingOri({ x: 0, z: 0 }) === null);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
