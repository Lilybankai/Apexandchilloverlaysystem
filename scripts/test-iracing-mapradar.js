/**
 * scripts/test-iracing-mapradar.js — iRacing's track-map dead reckoning and the
 * lap-fraction + spotter radar.
 * -----------------------------------------------------------------------------
 * iRacing publishes no world position for any car, so two pure modules stand in:
 *
 *   - `telemetry/iracing/positionIntegrator` dead-reckons the player from body
 *     velocity + yaw, closes one lap, and serves positions on that closed loop
 *     to the shared TrackMapBuilder.
 *   - `telemetry/iracing/radar` builds RadarBlips from lap-fraction gaps plus
 *     the player-only CarLeftRight spotter enum.
 *
 * The failure that matters for the map is HANDEDNESS: a mirrored outline looks
 * plausible and is wrong. So the circle cases assert the winding the widget
 * actually draws (its `viewU/viewV`: u = x, v = −z, canvas y down). For the
 * radar it is the sides and the start/finish wrap.
 *
 * Optional real-data pass: set IR_CAPTURE_DIR to an irsdk capture folder
 * (frames.ndjson + session-0.yaml). IR_OUTLINE_PNG=<file.png> also renders the
 * integrated outline with sharp, the way the widget orients it.
 *
 * Run: npm run build && node scripts/test-iracing-mapradar.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  IracingPositionIntegrator,
} = require('../dist/telemetry/iracing/positionIntegrator');
const {
  buildIracingRadar,
  IR_CAR_LEFT_RIGHT: CLR,
  IR_SIDE_LANE_M,
} = require('../dist/telemetry/iracing/radar');
const { ALONGSIDE_LON_M } = require('../dist/telemetry/radar');
const { TrackMapBuilder } = require('../dist/telemetry/trackMap');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `   [${detail}]` : ''}`);
}

const tmpDirs = [];
function tmpDir() {
  const d = path.join(os.tmpdir(), `apex-irmap-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  tmpDirs.push(d);
  return d;
}

/**
 * Signed area of the outline AS THE WIDGET DRAWS IT (u = x, v = −z, canvas y
 * down). Positive = clockwise on screen.
 */
function screenArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const pu = p.x, pv = -p.z, qu = q.x, qv = -q.z;
    a += pu * qv - qu * pv;
  }
  return a / 2;
}

function steps(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    out.push(Math.hypot(q.x - p.x, q.z - p.z));
  }
  return out;
}

/**
 * Drives a circle of circumference `L` for `laps` laps at `speed` m/s, 60 Hz,
 * starting mid-lap. `dir` +1 = left turns (CCW yaw), −1 = right turns.
 * `bias` scales the reported forward speed and adds a lateral bias, to make the
 * integral drift so loop closure has real work to do.
 */
function driveCircle(it, { L = 1000, laps = 3, speed = 40, dir = 1, startPct = 0.4, biasX = 1, biasY = 0, hook } = {}) {
  const R = L / (2 * Math.PI);
  const dt = 1 / 60;
  const yawRate = (dir * speed) / R;
  let s = startPct * L;
  let yaw = 0.7;
  const total = laps * L;
  let travelled = 0;
  let last = null;
  let firstReadyAt = null;
  while (travelled < total) {
    s += speed * dt;
    travelled += speed * dt;
    yaw += yawRate * dt;
    const pct = (s / L) % 1;
    const input = { velX: speed * biasX, velY: biasY, yaw, dtS: dt, lapDistPct: pct, onTrack: true, trackLengthM: L };
    if (hook) hook(input, travelled);
    last = it.step(input);
    if (it.ready && firstReadyAt === null) firstReadyAt = travelled;
  }
  return { last, firstReadyAt };
}

/* -------------------------------------------------------------------------- */
console.log('\n1) Integrator: a driven circle closes, with the right handedness');

{
  const it = new IracingPositionIntegrator();
  const { firstReadyAt } = driveCircle(it, { dir: -1, biasX: 1.01, biasY: 0.3 });
  check('right-turning circle: reference ready after one full line-to-line lap', it.ready && firstReadyAt > 1000 && firstReadyAt < 1700, firstReadyAt && firstReadyAt.toFixed(0));
  const pts = it.outline();
  check('outline exists, index 0 at pct 0', pts && pts.length >= 256 && pts[0].lapDistPct === 0, pts && pts.length);
  const st = steps(pts);
  const mean = st.reduce((a, b) => a + b, 0) / st.length;
  const max = Math.max(...st);
  const closeStep = st[st.length - 1];
  check('closed: last→first step is an ordinary step (drift distributed)', closeStep < mean * 1.5, `${closeStep.toFixed(2)} vs mean ${mean.toFixed(2)}`);
  check('no step anywhere over 1.5× the mean', max < mean * 1.5, max.toFixed(2));
  const area = screenArea(pts);
  check('RIGHT-turning circuit draws CLOCKWISE in the widget (not mirrored)', area > 0, area.toFixed(0));
  const r = pts.map((p) => Math.hypot(p.x, p.z));
  const rMean = r.reduce((a, b) => a + b, 0) / r.length;
  check('circle stays a circle (radius spread < 3%)', (Math.max(...r) - Math.min(...r)) / rMean < 0.03, `${Math.min(...r).toFixed(1)}..${Math.max(...r).toFixed(1)}`);
  check('y is flat and no point is the exact origin', pts.every((p) => p.y === 0 && !(p.x === 0 && p.z === 0)));
}
{
  const it = new IracingPositionIntegrator();
  driveCircle(it, { dir: 1 });
  const area = screenArea(it.outline());
  check('LEFT-turning circuit draws ANTI-clockwise in the widget', area < 0, area.toFixed(0));
}
{
  // Same circuit as LMU would publish it: LMU's left-handed world (radar.ts:
  // right = up × forward) — a car heading −Z turning right heads −X next. Our
  // outline for a right-turning lap must wind the same way in x/z.
  const it = new IracingPositionIntegrator();
  driveCircle(it, { dir: -1 });
  const pts = it.outline();
  // Tangent at index k and k+quarter: a right turn rotates heading clockwise in (x, z-up).
  const k = 0;
  const q = Math.floor(pts.length / 4);
  const t0 = { x: pts[k + 1].x - pts[k].x, z: pts[k + 1].z - pts[k].z };
  const t1 = { x: pts[q + 1].x - pts[q].x, z: pts[q + 1].z - pts[q].z };
  const crossY = t0.x * t1.z - t0.z * t1.x; // (x,z) 2-D cross: < 0 = clockwise
  check('heading rotates clockwise in (x, z-up) through a right turn (LMU convention)', crossY < 0, crossY.toFixed(3));
}

/* -------------------------------------------------------------------------- */
console.log('\n2) Integrator: positions served on the reference, nulls and resets');

{
  const it = new IracingPositionIntegrator();
  const { last } = driveCircle(it, { dir: -1, laps: 2.2 });
  const pts = it.outline();
  check('step() returns a position once ready', last && Number.isFinite(last.x) && last.y === 0);
  // The served position is ON the outline.
  let best = Infinity;
  for (const p of pts) best = Math.min(best, Math.hypot(p.x - last.x, p.z - last.z));
  check('served position lies on the closed outline', best < 2.5, best.toFixed(2));
  const off = it.step({ velX: 0, velY: 0, yaw: 0, dtS: 1 / 60, lapDistPct: 0.98, onTrack: false });
  check('not on track (pit / garage / tow / replay) → null', off === null);
  check('…but the learned outline survives a pit stop', it.ready);
  it.reset();
  check('reset() forgets the outline', !it.ready && it.outline() === null && it.revision === 0);
}
{
  const it = new IracingPositionIntegrator();
  const r = it.step({ velX: 40, velY: 0, yaw: 0, dtS: 1 / 60, lapDistPct: 0.5, onTrack: true });
  check('null before any lap has closed', r === null);
}
{
  // Pit lane mid-lap: the lap in progress is abandoned, the next one learns.
  const it = new IracingPositionIntegrator();
  let pitted = false;
  driveCircle(it, {
    laps: 3.2,
    dir: -1,
    hook: (inp, d) => {
      if (d > 900 && d < 960) { inp.onTrack = false; pitted = true; }
    },
  });
  check('a lap interrupted by the pits is not used; a later one is', pitted && it.ready);
}
{
  const it = new IracingPositionIntegrator();
  driveCircle(it, { laps: 2.4, dir: -1, hook: (inp, d) => { if (d > 900 && d < 920) inp.clean = false; } });
  check('an off-track (unclean) lap is refused as the reference', !it.ready && /clean/.test(it.refusal), it.refusal);
}
{
  const it = new IracingPositionIntegrator();
  driveCircle(it, { laps: 2.4, dir: -1, hook: (inp) => { inp.trackLengthM = 1500; } });
  check('a lap whose driven length disagrees with TrackLength is refused', !it.ready && /length/.test(it.refusal), it.refusal);
}
{
  const it = new IracingPositionIntegrator();
  // A constant body-frame bias rotates with the car and cancels round a loop;
  // a glitch over part of the lap does not.
  driveCircle(it, { laps: 2.4, dir: -1, hook: (inp, d) => { if (d > 700 && d < 1000) inp.velY = 12; } });
  check('a lap with gross closure error (bad inputs) is refused', !it.ready && /closure/.test(it.refusal), it.refusal);
}
{
  const it = new IracingPositionIntegrator();
  driveCircle(it, { laps: 2.4, dir: -1, hook: (inp, d) => { if (d > 900 && d < 905) inp.lapDistPct = Math.max(0, inp.lapDistPct - 0.05); } });
  check('lap fraction ticking backwards (spin / reset) abandons the lap', !it.ready);
}

/* -------------------------------------------------------------------------- */
console.log('\n3) Integrator → the real TrackMapBuilder publishes a closed circuit');

function feedBuilder(it, L, name) {
  const b = new TrackMapBuilder(tmpDir());
  let st = null;
  for (const p of it.outline()) {
    st = b.update({ trackName: name, lengthM: L, lapDistM: p.lapDistPct * L, pos: p, inPit: false });
  }
  return { b, st };
}
{
  const it = new IracingPositionIntegrator();
  driveCircle(it, { dir: -1, biasX: 1.02, biasY: 0.4, L: 2000 });
  const { b, st } = feedBuilder(it, 2000, 'iracing-test-circle');
  check('one-shot outline feed: builder ready', st && st.ready, st && st.progress);
  const path = b.path;
  check('builder path has points, index 0 at the line', path && path.points.length >= 200, path && path.points.length);
  if (path) {
    const pts = path.points.map((p) => ({ x: p[0], z: p[1] }));
    check('builder path keeps the clockwise winding of a right-turning lap', screenArea(pts) > 0);
  }
}
{
  // Per-tick feed (no one-shot): positions on the reference fill the builder in a lap.
  const it = new IracingPositionIntegrator();
  const L = 1500;
  const b = new TrackMapBuilder(tmpDir());
  let st = null;
  driveCircle(it, { L, laps: 2.3, dir: -1 });
  // Then drive on, feeding every tick's step() output to the builder.
  const R = L / (2 * Math.PI);
  let s = 0.1 * L;
  for (let k = 0; k < (L / 40) * 60 * 1.1; k++) {
    s += 40 / 60;
    const pct = (s / L) % 1;
    const pos = it.step({ velX: 40, velY: 0, yaw: -s / R, dtS: 1 / 60, lapDistPct: pct, onTrack: true });
    st = b.update({ trackName: 'iracing-test-tick', lengthM: L, lapDistM: pct * L, pos, inPit: false });
  }
  check('per-tick feed of step() output also completes the builder', st && st.ready, st && st.progress.toFixed(3));
}

/* -------------------------------------------------------------------------- */
console.log('\n4) Radar: longitudinal from lap fraction, wrap-aware');

const L = 2000;
function radar(over) {
  return buildIracingRadar(Object.assign({ carLeftRight: CLR.Clear, playerSlotId: 0, playerPct: 0.5, trackLengthM: L, playerSpeedMs: 0, cars: [] }, over));
}
const car = (slotId, pct, extra) => Object.assign({ slotId, pct, onPitRoad: false }, extra);

check('CarLeftRight Off (not in car) → null (radar omitted)', radar({ carLeftRight: CLR.Off }) === null);
check('unknown CarLeftRight value → null', radar({ carLeftRight: 9 }) === null);
check('player pct < 0 → null', radar({ playerPct: -1 }) === null);
check('Clear, nobody near → [] (not null)', Array.isArray(radar({})) && radar({}).length === 0);
{
  const b = radar({ cars: [car(1, 0.505)] })[0];
  check('car 10 m up the road → +10 longitudinal, 0 lateral', b && Math.abs(b.longitudinalM - 10) < 0.01 && b.lateralM === 0 && !b.alongside, b && b.longitudinalM);
}
{
  const b = radar({ cars: [car(1, 0.49)] })[0];
  check('car 20 m back → −20 longitudinal', b && Math.abs(b.longitudinalM + 20) < 0.01, b && b.longitudinalM);
}
{
  const b = radar({ playerPct: 0.995, cars: [car(1, 0.002)] })[0];
  check('wrap: player 0.995, car 0.002 → car 14 m AHEAD', b && Math.abs(b.longitudinalM - 14) < 0.01, b && b.longitudinalM);
}
{
  const b = radar({ playerPct: 0.002, cars: [car(1, 0.995)] })[0];
  check('wrap: player 0.002, car 0.995 → car 14 m BEHIND', b && Math.abs(b.longitudinalM + 14) < 0.01, b && b.longitudinalM);
}
{
  const out = radar({ cars: [car(0, 0.5), car(1, 0.501, { onPitRoad: true }), car(2, -1), car(3, 0.9)] });
  check('player, pit-road, not-in-world and out-of-range cars excluded', out.length === 0, out.length);
}
{
  const out = radar({ cars: [car(1, 0.52), car(2, 0.51), car(3, 0.48)] });
  check('sorted nearest-first', out.map((b) => b.slotId).join() === '2,1,3', out.map((b) => b.slotId).join());
}
{
  const out = radar({ cars: [car(7, 0.501, { carClass: 'GT3', carNumber: '12', isFasterClass: true, lapsDown: 1 })] });
  const b = out[0];
  check('identity fields pass through', b.carClass === 'GT3' && b.carNumber === '12' && b.isFasterClass === true && b.lapsDown === 1 && !('slowerClass' in b));
}

console.log('\n5) Radar: CarLeftRight → sides');

{
  const b = radar({ carLeftRight: CLR.CarLeft, cars: [car(1, 0.501), car(2, 0.53)] });
  const s1 = b.find((x) => x.slotId === 1);
  const s2 = b.find((x) => x.slotId === 2);
  check('CarLeft: nearest overlapping car on the LEFT (negative lateral), alongside', s1.lateralM === -IR_SIDE_LANE_M && s1.alongside, s1.lateralM);
  check('CarLeft: a distant car stays on the line, not alongside', s2.lateralM === 0 && !s2.alongside);
}
{
  const s = radar({ carLeftRight: CLR.CarRight, cars: [car(1, 0.4995)] })[0];
  check('CarRight: car on the RIGHT (positive lateral)', s.lateralM === IR_SIDE_LANE_M && s.alongside, s.lateralM);
}
{
  const out = radar({ carLeftRight: CLR.CarLeftRight, cars: [car(1, 0.501), car(2, 0.4995)] });
  const sides = out.map((b) => Math.sign(b.lateralM)).sort().join();
  check('CarLeftRight: one car each side', sides === '-1,1', sides);
  // Sticky: swap which was left last frame and it must stay that way.
  const prev = [
    { slotId: 1, lateralM: 3, longitudinalM: 2, distanceM: 3.6, alongside: true },
    { slotId: 2, lateralM: -3, longitudinalM: -1, distanceM: 3.2, alongside: true },
  ];
  const out2 = radar({ carLeftRight: CLR.CarLeftRight, cars: [car(1, 0.501), car(2, 0.4995)], previous: prev });
  const s1 = out2.find((b) => b.slotId === 1);
  const s2 = out2.find((b) => b.slotId === 2);
  check('sides are sticky across frames (previous blips honoured)', s1.lateralM > 0 && s2.lateralM < 0, `${s1.lateralM}/${s2.lateralM}`);
}
{
  const out = radar({ carLeftRight: CLR.TwoCarsLeft, cars: [car(1, 0.501), car(2, 0.5015)] });
  const lats = out.map((b) => b.lateralM).sort((a, b) => a - b).join();
  check('2CarsLeft: two cars on the left, one lane apart', lats === `${-2 * IR_SIDE_LANE_M},${-IR_SIDE_LANE_M}`, lats);
}
{
  const out = radar({ carLeftRight: CLR.TwoCarsRight, cars: [car(1, 0.501), car(2, 0.4985)] });
  check('2CarsRight: both on the right', out.every((b) => b.lateralM > 0 && b.alongside));
}
{
  // Clear but lap-fraction jitter puts a car 3 m behind: the widget would fire a
  // phantom RIGHT warning (lat 0 counts as right) — hold it outside the window.
  const b = radar({ carLeftRight: CLR.Clear, cars: [car(1, 0.4985)] })[0];
  check('Clear: a car inside the alongside window is held outside it, behind', b.longitudinalM < -ALONGSIDE_LON_M && !b.alongside && b.lateralM === 0, b.longitudinalM);
  const a = radar({ carLeftRight: CLR.Clear, cars: [car(1, 0.5015)] })[0];
  check('Clear: …and ahead stays ahead', a.longitudinalM > ALONGSIDE_LON_M, a.longitudinalM);
}
{
  const b = radar({ carLeftRight: CLR.CarLeft, cars: [car(1, 0.51)] })[0];
  check('CarLeft but the only car is 20 m away → not assigned', b.lateralM === 0 && !b.alongside);
}
{
  const slow = radar({ carLeftRight: CLR.CarLeft, playerSpeedMs: 0, cars: [car(1, 0.5045)] })[0];
  const fast = radar({ carLeftRight: CLR.CarLeft, playerSpeedMs: 60, cars: [car(1, 0.5045)] })[0];
  check('side search widens with speed (network-lagged pct): 9 m ahead', slow.lateralM === 0 && fast.lateralM < 0, `${slow.lateralM}/${fast.lateralM}`);
  check('an assigned car is pulled inside the alongside window', Math.abs(fast.longitudinalM) <= ALONGSIDE_LON_M, fast.longitudinalM);
}
{
  const out = radar({ carLeftRight: CLR.CarLeft, playerPct: 0.999, cars: [car(1, 0.0005)] });
  check('side assignment works across the start/finish wrap', out[0].lateralM < 0 && Math.abs(out[0].longitudinalM - 3) < 0.01, out[0].longitudinalM);
}

/* -------------------------------------------------------------------------- */
async function realData() {
  const dir = process.env.IR_CAPTURE_DIR;
  if (!dir || !fs.existsSync(path.join(dir, 'frames.ndjson'))) {
    console.log('\n6) Real capture: skipped (set IR_CAPTURE_DIR to an irsdk capture folder)');
    return;
  }
  console.log(`\n6) Real capture: ${dir}`);
  const yaml = fs.readFileSync(path.join(dir, 'session-0.yaml'), 'utf8');
  const m = /TrackLength:\s*([\d.]+)\s*km/.exec(yaml);
  const trackL = m ? parseFloat(m[1]) * 1000 : 0;
  check('track length parsed from WeekendInfo', trackL > 500, trackL);
  const frames = fs.readFileSync(path.join(dir, 'frames.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // --- map: integrate every on-track stretch; reset on session change.
  const it = new IracingPositionIntegrator();
  let prevT = null;
  let prevSession = null;
  let firstOutline = null;
  let nullWhileOff = true;
  for (const f of frames) {
    if (f.SessionNum !== prevSession) { it.reset(); prevSession = f.SessionNum; prevT = null; }
    const dt = prevT === null ? 0 : f.SessionTime - prevT;
    prevT = f.SessionTime;
    const onTrack = !!f.IsOnTrack && !f.OnPitRoad && !f.IsReplayPlaying && f.PlayerCarTowTime === 0;
    const pos = it.step({ velX: f.VelocityX, velY: f.VelocityY, yaw: f.Yaw, dtS: dt, lapDistPct: f.LapDistPct, onTrack, clean: f.PlayerTrackSurface !== 0, trackLengthM: trackL });
    if (!onTrack && pos !== null) nullWhileOff = false;
    if (it.ready && !firstOutline) firstOutline = it.outline();
  }
  check('null whenever not on track (garage / pit stall / pit lane)', nullWhileOff);
  check('a driven lap in the capture closed into a reference outline', !!firstOutline);
  if (!firstOutline) return;
  const st = steps(firstOutline);
  const len = st.reduce((a, b) => a + b, 0);
  check('outline length within 2% of TrackLength', Math.abs(len / trackL - 1) < 0.02, `${len.toFixed(1)} vs ${trackL}`);
  const mean = len / st.length;
  check('outline closed: no step over 3× the mean', Math.max(...st) < 3 * mean, `${Math.max(...st).toFixed(2)} vs ${mean.toFixed(2)}`);
  const it2 = { outline: () => firstOutline };
  const { b, st: bst } = feedBuilder(it2, trackL, 'iracing-capture');
  check('real outline → TrackMapBuilder publishes', bst && bst.ready, bst && bst.progress);

  const png = process.env.IR_OUTLINE_PNG;
  if (png && b.path) {
    const sharp = require('sharp');
    const pts = b.path.points.map((p) => ({ u: p[0], v: -p[1] })); // the widget's viewU/viewV at angle 0
    const minU = Math.min(...pts.map((p) => p.u)), maxU = Math.max(...pts.map((p) => p.u));
    const minV = Math.min(...pts.map((p) => p.v)), maxV = Math.max(...pts.map((p) => p.v));
    const W = 800, pad = 40;
    const sc = (W - 2 * pad) / Math.max(maxU - minU, maxV - minV);
    const H = Math.round((maxV - minV) * sc + 2 * pad);
    const X = (u) => (pad + (u - minU) * sc).toFixed(1);
    const Y = (v) => (pad + (v - minV) * sc).toFixed(1);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.u)},${Y(p.v)}`).join('') + 'Z';
    // Direction arrows every 1/8 lap and the S/F marker.
    let marks = `<circle cx="${X(pts[0].u)}" cy="${Y(pts[0].v)}" r="9" fill="#e33"/>`;
    for (let k = 1; k < 8; k++) {
      const i = Math.floor((k * pts.length) / 8);
      marks += `<circle cx="${X(pts[i].u)}" cy="${Y(pts[i].v)}" r="5" fill="#39f"/><text x="${X(pts[i].u)}" y="${Y(pts[i].v)}" dx="8" dy="4" font-size="16" fill="#fff">${k}/8</text>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#111"/><path d="${d}" fill="none" stroke="#ddd" stroke-width="5" stroke-linejoin="round"/>${marks}<text x="10" y="24" font-size="16" fill="#aaa">iRacing ${path.basename(dir)} dead-reckoned (widget orientation, red = S/F)</text></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(png);
    console.log(`  wrote ${png}`);
  }

  // --- radar on the real field.
  let rightFrames = 0, rightHits = 0, leftFrames = 0, leftHits = 0, clearFrames = 0, clearPhantoms = 0, nullOff = true;
  let prev = null;
  for (const f of frames) {
    const pctArr = f.CarIdxLapDistPct;
    if (!Array.isArray(pctArr)) continue;
    const cars = pctArr.map((p, i) => ({ slotId: i, pct: p, onPitRoad: !!(f.CarIdxOnPitRoad && f.CarIdxOnPitRoad[i]) }));
    const out = buildIracingRadar({ carLeftRight: f.CarLeftRight, playerSlotId: f.PlayerCarIdx, playerPct: f.LapDistPct, trackLengthM: trackL, playerSpeedMs: f.Speed, cars, previous: prev });
    prev = out;
    if (f.CarLeftRight === 0 && out !== null) nullOff = false;
    if (!out) continue;
    if (f.CarLeftRight === CLR.CarRight) {
      rightFrames++;
      if (out.some((bl) => bl.lateralM > 0 && bl.alongside)) rightHits++;
    }
    if (f.CarLeftRight === CLR.CarLeft) {
      leftFrames++;
      if (out.some((bl) => bl.lateralM < 0 && bl.alongside)) leftHits++;
    }
    if (f.CarLeftRight === CLR.Clear) {
      clearFrames++;
      if (out.some((bl) => Math.abs(bl.longitudinalM) <= ALONGSIDE_LON_M)) clearPhantoms++;
    }
  }
  check('real radar: null while CarLeftRight is Off', nullOff);
  check('real radar: CarRight frames put a car alongside on the right', rightFrames > 0 && rightHits / rightFrames >= 0.8, `${rightHits}/${rightFrames}`);
  if (leftFrames > 0) {
    check('real radar: CarLeft frames put a car alongside on the left', leftHits / leftFrames >= 0.8, `${leftHits}/${leftFrames}`);
  }
  check('real radar: no phantom alongside blip while the spotter says Clear', clearPhantoms === 0, `${clearPhantoms}/${clearFrames}`);
}

realData()
  .catch((e) => {
    failed++;
    console.log(`  FAIL  real-data pass threw: ${e && e.stack}`);
  })
  .finally(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
