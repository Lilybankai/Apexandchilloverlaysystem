// Offline replay test of LocalLapDeltaTracker: simulated laps at 20Hz.
import { LocalLapDeltaTracker } from 'file:///C:/Users/carla/Desktop/apexoverlaysysystem/dist/telemetry/lmuRestProvider.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail ?? ''}`); }
};

// Drive one lap segment: from frac d0 to d1 at `lapTime` pace, 20Hz.
// Returns the deltas produced while inside [d0,d1].
function drive(tr, { lapNumber, lapStartET, lapTime, d0 = 0, d1 = 1, best = 100 }) {
  const out = [];
  const steps = Math.round(((d1 - d0) * lapTime) * 20); // 20Hz
  for (let i = 0; i <= steps; i++) {
    const t = (d0 * lapTime) + i / 20;
    const d = t / lapTime;
    if (d > d1 + 1e-9) break;
    out.push({ d, delta: tr.update(lapNumber, lapStartET, t, Math.min(1, d), best) });
  }
  return out;
}

console.log('scenario 1: join mid-lap (d=0.6), partial ref arms next lap');
{
  const tr = new LocalLapDeltaTracker();
  // Lap 5 observed from d=0.6, pace 100s. lapStartET=1000.
  let r = drive(tr, { lapNumber: 5, lapStartET: 1000, lapTime: 100, d0: 0.6 });
  check('no delta during first (referenceless) lap', r.every(x => x.delta === -1));
  // Lap 6 at 98s pace: lapStartET=1100 (exact 100s lap completed).
  r = drive(tr, { lapNumber: 6, lapStartET: 1100, lapTime: 98 });
  const early = r.filter(x => x.d < 0.58);
  const inSpan = r.filter(x => x.d > 0.65 && x.d < 0.98);
  check('unknown outside partial span', early.every(x => x.delta === -1));
  check('armed inside partial span', inSpan.length > 0 && inSpan.every(x => x.delta !== -1));
  // expected delta at d: d*98 - d*100 = -2d -> at 0.8 = -1.6
  const at08 = inSpan.find(x => Math.abs(x.d - 0.8) < 0.01);
  check('delta ≈ -1.6 at d=0.8', at08 && Math.abs(at08.delta - (-1.6)) < 0.15, `got ${at08?.delta}`);

  console.log('scenario 2: full lap upgrades coverage; next lap compares to it');
  // Lap 7 at 99s pace; lap 6 completed in exactly 98 (lapStartET 1100 -> 1198).
  r = drive(tr, { lapNumber: 7, lapStartET: 1198, lapTime: 99 });
  const early2 = r.filter(x => x.d > 0.05 && x.d < 0.5);
  check('full coverage now (delta known early in lap)', early2.length > 0 && early2.every(x => x.delta !== -1));
  const at04 = r.find(x => Math.abs(x.d - 0.4) < 0.01);
  // vs 98s ref: d*99 - d*98 = +d -> +0.4 at d=0.4
  check('delta ≈ +0.4 at d=0.4 vs new best', at04 && Math.abs(at04.delta - 0.4) < 0.15, `got ${at04?.delta}`);
}

console.log('scenario 3: out-lap / crawl never becomes the reference');
{
  const tr = new LocalLapDeltaTracker();
  drive(tr, { lapNumber: 3, lapStartET: 500, lapTime: 240, best: 100 }); // 240s crawl
  // crawl completed: lapStartET 500 -> 740. Next lap at proper pace.
  const r = drive(tr, { lapNumber: 4, lapStartET: 740, lapTime: 100, best: 100 });
  check('no reference adopted from crawl (240 > 100*1.4)', r.every(x => x.delta === -1));
}

console.log('scenario 4: ESC / session rewind resets cleanly');
{
  const tr = new LocalLapDeltaTracker();
  drive(tr, { lapNumber: 5, lapStartET: 1000, lapTime: 100 });
  drive(tr, { lapNumber: 6, lapStartET: 1100, lapTime: 100, d1: 0.4 });
  // ESC: lapStartET rewinds (new session / reset to garage).
  const r = drive(tr, { lapNumber: 1, lapStartET: 50, lapTime: 100 });
  check('after rewind, no stale reference used', r.every(x => x.delta === -1));
  // and it re-arms on the following lap:
  const r2 = drive(tr, { lapNumber: 2, lapStartET: 150, lapTime: 99 });
  const known = r2.filter(x => x.delta !== -1);
  check('re-arms after a fresh full lap', known.length > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
