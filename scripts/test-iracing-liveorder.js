#!/usr/bin/env node
/**
 * Live race order for iRacing (liveOrder.ts).
 *
 * iRacing's own `CarIdxPosition` / `CarIdxF2Time` only rescore at the line —
 * on the owner's recorded races (2026-11-10) the official order disagreed with
 * the road for 56–73 % of race time. The standings now re-derive order and gap
 * from distance covered and EstTime between crossings. This pins the rules:
 * a mid-lap pass moves the order, side-by-side cars do not flicker, the
 * official order stands before the green and under a caution, finishers keep
 * their place after leaving the world, gaps are on each car's class lap, and
 * the work is throttled to 15 Hz.
 *
 * Run: `npm run test:iracing-liveorder` (after `npm run build`).
 */
'use strict';

const path = require('path');
const { LiveRaceOrder, LIVE_ORDER_HZ } = require(path.join(__dirname, '..', 'dist', 'telemetry', 'iracing', 'liveOrder.js'));

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   [${detail}]`}`);
};

const L = 90; // class reference lap, s
const car = (idx, laps, pct, o = {}) => ({
  idx,
  lapsRaw: laps,
  pct,
  est: o.est ?? pct * (o.L ?? L),
  classLapSec: o.L ?? L,
  officialPos: o.pos ?? 0,
  inWorld: o.inWorld ?? true,
});
const ctx = (nowMs, o = {}) => ({
  nowMs,
  active: o.active ?? true,
  lapsAtFlag: o.lapsAtFlag ?? null,
  trackLengthM: o.trackLengthM ?? 4000,
});

/* --- a pass mid-lap moves the order; the official one would not ------------ */
{
  const lo = new LiveRaceOrder();
  // Car 1 is officially P1 (scored at the line), car 2 officially P2.
  let r = lo.update([car(1, 5, 0.40, { pos: 1 }), car(2, 5, 0.39, { pos: 2 })], ctx(0));
  check('starts in road order', r && r.order.join() === '1,2', JSON.stringify(r && r.order));
  // Mid-lap, car 2 gets by: 0.45 vs 0.44 on a 4 km lap = 40 m clear.
  r = lo.update([car(1, 5, 0.44, { pos: 1 }), car(2, 5, 0.45, { pos: 2 })], ctx(100));
  check('mid-lap pass shows at once (official still says 1,2)', r && r.order.join() === '2,1', JSON.stringify(r && r.order));
  const g = r.gapToLeaderSec.get(1);
  check('gap is the EstTime difference (0.01 lap × 90 s = 0.9 s)', Math.abs(g - 0.9) < 1e-6, String(g));
}

/* --- side by side: no flicker inside the 2 m margin ------------------------ */
{
  const lo = new LiveRaceOrder();
  lo.update([car(1, 3, 0.500, { pos: 1 }), car(2, 3, 0.4999, { pos: 2 })], ctx(0));
  // Car 2 nudges 1.2 m ahead (0.0003 × 4000) — not a pass yet.
  let r = lo.update([car(1, 3, 0.6000, { pos: 1 }), car(2, 3, 0.6003, { pos: 2 })], ctx(100));
  check('1.2 m ahead does not swap', r.order.join() === '1,2', r.order.join());
  r = lo.update([car(1, 3, 0.7000, { pos: 1 }), car(2, 3, 0.7008, { pos: 2 })], ctx(200));
  check('3.2 m ahead does', r.order.join() === '2,1', r.order.join());
}

/* --- the line: lap −1 on the grid keeps the sum continuous ------------------ */
{
  const lo = new LiveRaceOrder();
  const r = lo.update([car(1, -1, 0.998), car(2, 0, 0.001), car(3, -1, 0.990)], ctx(0));
  check('first car across the line leads the grid still behind it', r.order.join() === '2,1,3', r.order.join());
}

/* --- official order stands: before the green, under a caution -------------- */
{
  const lo = new LiveRaceOrder();
  check('inactive (pre-green / caution / not a race) → null', lo.update([car(1, 2, 0.5)], ctx(0, { active: false })) === null);
}

/* --- a lapped car of another class: continuous class-lap gap --------------- */
{
  const lo = new LiveRaceOrder();
  // GTP leader (80 s lap) on lap 10 at 0.2; a GT3 (100 s lap) on lap 9 at 0.5.
  const r = lo.update([car(1, 10, 0.2, { L: 80 }), car(2, 9, 0.5, { L: 100 })], ctx(0));
  // On the GT3's lap: 1 lap × 100 + 0.2×80×(100/80) − 0.5×100 = 100 + 20 − 50 = 70 s.
  const g = r.gapToLeaderSec.get(2);
  check('cross-class gap rescales the leader onto the GT3 lap (70 s)', Math.abs(g - 70) < 1e-6, String(g));
}

/* --- finishers keep their place after leaving the world -------------------- */
{
  const lo = new LiveRaceOrder();
  const atFlag = new Map([
    [1, 7],
    [2, 7],
    [3, 6],
  ]);
  // Car 1 crosses (laps 8); car 2 still running lap 7; car 3 (lapped) running.
  let r = lo.update([car(1, 8, 0.01, { pos: 1 }), car(2, 7, 0.95, { pos: 2 }), car(3, 6, 0.99, { pos: 3 })], ctx(0, { lapsAtFlag: atFlag }));
  check('finisher leads the car still on its last lap', r.order.join() === '1,2,3', r.order.join());
  check('no live gaps once the leader has finished (official F2 instead)', r.gapToLeaderSec.size === 0, String(r.gapToLeaderSec.size));
  // Car 1 exits the world (LapCompleted −1); car 3 finishes on 7 laps; car 2 still out.
  r = lo.update(
    [car(1, -1, -1, { pos: 1, inWorld: false }), car(2, 7, 0.97, { pos: 2 }), car(3, 7, 0.01, { pos: 3 })],
    ctx(100, { lapsAtFlag: atFlag }),
  );
  check('exited finisher stays P1', r.order[0] === 1, r.order.join());
  check('lead-lap car still running stays ahead of a lapped finisher', r.order.join() === '1,2,3', r.order.join());
}

/* --- a car that leaves the world mid-race keeps its last progress ---------- */
{
  const lo = new LiveRaceOrder();
  lo.update([car(1, 4, 0.5), car(2, 4, 0.3), car(3, 4, 0.1)], ctx(0));
  const r = lo.update([car(1, 4, 0.6), car(2, -1, -1, { inWorld: false }), car(3, 4, 0.2)], ctx(100));
  check('disconnected car held at its last spot', r.order.join() === '1,2,3', r.order.join());
  check('…with no live gap', !r.gapToLeaderSec.has(2));
}

/* --- the phantom pit-stall lap (car 3, 2026-11-10 race) ------------------- */
{
  const lo = new LiveRaceOrder();
  const field = (t, c3) => [car(1, 0, 0.30 + t * 0.001), car(2, 0, 0.29 + t * 0.001), c3];
  // Car 3 joins parked in its stall short of the line: LapCompleted −1, pct 0.984.
  lo.update(field(0, car(3, -1, 0.984)), ctx(0));
  // The sim credits it a lap while it is still parked: −1 → 0, no line crossed.
  let r = lo.update(field(1, car(3, 0, 0.984)), ctx(100));
  check('a lap credited in the pit stall is not a lap (stays last)', r.order[2] === 3, r.order.join());
  // It drives over the pit-lane line: 0 → 1, pct wraps — a real crossing.
  r = lo.update(field(2, car(3, 1, 0.001)), ctx(200));
  check('…the real crossing puts it on lap 0, still behind the field', r.order[2] === 3, r.order.join());
  // Nine seconds later the sim takes the phantom lap back: 1 → 0, no wrap.
  r = lo.update(field(3, car(3, 0, 0.035)), ctx(300));
  check('…and the sim taking it back changes nothing', r.order[2] === 3, r.order.join());
  const g = r.gapToLeaderSec.get(3);
  check('its gap is the road gap, not a lap', g > 20 && g < 30, String(g));
}

/* --- a reset to the pit stall is a teleport, not a lap (car 9) ------------- */
{
  const lo = new LiveRaceOrder();
  lo.update([car(1, 1, 0.30), car(9, 1, 0.221), car(8, 1, 0.20)], ctx(0));
  // Car 9 resets: 0.221 → its stall at 0.980, same lap count.
  const r = lo.update([car(1, 1, 0.31), car(9, 1, 0.980), car(8, 1, 0.21)], ctx(100));
  check('after a tow the sim’s own lap count stands (1.98, P1 on the road)', r.order[0] === 9, r.order.join());
}

/* --- throttled to 15 Hz ------------------------------------------------------ */
{
  const lo = new LiveRaceOrder();
  lo.update([car(1, 5, 0.40), car(2, 5, 0.39)], ctx(0));
  const step = 1000 / LIVE_ORDER_HZ;
  const cached = lo.update([car(1, 5, 0.40), car(2, 5, 0.50)], ctx(step / 2));
  check(`within 1/${LIVE_ORDER_HZ} s the last order is reused`, cached.order.join() === '1,2', cached.order.join());
  const fresh = lo.update([car(1, 5, 0.40), car(2, 5, 0.50)], ctx(step + 1));
  check('after it, recomputed', fresh.order.join() === '2,1', fresh.order.join());
  const joined = lo.update([car(1, 5, 0.40), car(2, 5, 0.50), car(3, 5, 0.6)], ctx(step + 2));
  check('a car joining forces a recompute', joined.order.join() === '3,2,1', joined.order.join());
  check(`rate is 10–15 Hz (${LIVE_ORDER_HZ})`, LIVE_ORDER_HZ >= 10 && LIVE_ORDER_HZ <= 15);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
