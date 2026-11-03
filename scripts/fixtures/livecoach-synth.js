/**
 * scripts/fixtures/livecoach-synth.js — a synthetic lap trace for the live
 * practice coach's tests (scripts/test-livecoach-service.js): a 4 km lap at
 * 250 km/h with two braked corners, no driven line (so corners come from the
 * speed trace). `corners` sets each apex's place and minimum speed, so a lap
 * can be made slower in one corner than another.
 */
'use strict';
function synthTrace(o = {}) {
  const N = 900;
  const L = o.L || 4000;
  const corners = o.corners || [
    { d: 0.3, minKph: 110 },
    { d: 0.7, minKph: 90 },
  ];
  const d = [], t = [], speedKph = [], brake = [], throttle = [], steer = [], gear = [], latG = [], lonG = [], tc = [], abs = [];
  let time = 0;
  for (let i = 0; i < N; i++) {
    const di = i / (N - 1) * 0.999;
    let v = 250;
    let b = 0;
    let st = 0;
    for (const c of corners) {
      const dist = (di - c.d) * L; // metres past the apex
      if (dist > -250 && dist < 0) {
        const f = -dist / 250; // 1 at 250 m before, 0 at apex
        v = Math.min(v, c.minKph + (250 - c.minKph) * f * f);
        if (f < 0.8) b = 0.8;
        st = 0.3;
      } else if (dist >= 0 && dist < 300) {
        v = Math.min(v, c.minKph + (250 - c.minKph) * (dist / 300));
        st = 0.2;
      }
    }
    if (i > 0) time += ((di - d[i - 1]) * L) / ((v + speedKph[i - 1]) / 2 / 3.6);
    d.push(di);
    t.push(time);
    speedKph.push(v);
    brake.push(b);
    throttle.push(b > 0 ? 0 : 1);
    steer.push(st);
    gear.push(v > 200 ? 6 : v > 150 ? 4 : 3);
    latG.push(st * 3);
    lonG.push(b ? -1 : 0.3);
    tc.push(0);
    abs.push(0);
  }
  return { lapSec: time, count: N, truncated: false, d, t, throttle, brake, steer, gear, speedKph, latG, lonG, tc, abs, aids: 2 };
}
module.exports = { synthTrace };
