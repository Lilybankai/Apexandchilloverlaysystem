/**
 * scripts/bench-pipeline.js — server hot-path cost of one telemetry tick.
 * -----------------------------------------------------------------------------
 * Times the work the 30 Hz loop in src/server/index.ts does every broadcast:
 *
 *   provider.poll()  →  JSON.stringify(frame)  →  (send is I/O, not timed)
 *
 * Then scales the *wire* half of that (stringify / parse / payload) across
 * field sizes the simulator cannot produce on its own (it is hard-coded to
 * 12 cars; a 6-hour grid is typically 30–60).
 *
 * This does NOT time the live LMU path (shared-memory field sweep, REST
 * refresh). Those need Windows + a running sim. What it answers is: is the
 * default 30 Hz budget being eaten by frame production and serialization
 * alone, and does a bigger grid change that answer.
 *
 * Run: node scripts/bench-pipeline.js
 *      (or via `npm run bench`, which builds first)
 */

'use strict';

const {
  DEFAULT_HZ,
  budgetMs,
  nowNs,
  nsToMs,
  timeMany,
  statsOf,
  fmtMs,
  fmtBytes,
  fmtHz,
  pctOfBudget,
  printTable,
  heading,
  loadSimulator,
  cloneFrame,
  expandField,
  measurePayload,
} = require('./lib/bench-util');

const FIELD_SIZES = [12, 24, 36, 48, 62];
const POLL_SAMPLES = 400;
const CADENCE_MS = 2500;

function pollOnce(provider, clock) {
  clock.now += 1000 / DEFAULT_HZ;
  return provider.poll(clock.now, 1000 / DEFAULT_HZ);
}

function runPollBench() {
  const provider = loadSimulator();
  provider.start();
  const clock = { now: 1_000_000 };
  // Let the demo leave the grid-walk / countdown so the frame is a racing one.
  for (let i = 0; i < 80; i++) pollOnce(provider, clock);

  const poll = timeMany(() => pollOnce(provider, clock), POLL_SAMPLES);

  let last = null;
  const stringify = timeMany(() => {
    last = pollOnce(provider, clock);
    JSON.stringify(last);
  }, POLL_SAMPLES);

  const parse = timeMany(() => {
    JSON.parse(JSON.stringify(last));
  }, POLL_SAMPLES);

  const payload = measurePayload(last);
  provider.stop();
  return {
    cars: last.session && last.session.numCars,
    poll: poll.stats,
    stringify: stringify.stats,
    parse: parse.stats,
    combinedMean: poll.stats.mean + stringify.stats.mean,
    combinedP99: poll.stats.p99 + stringify.stats.p99,
    payload,
    frame: last,
  };
}

function runFieldScale(baseFrame) {
  const rows = [];
  for (const n of FIELD_SIZES) {
    const frame = expandField(baseFrame, n);
    const payload = measurePayload(frame);
    const stringify = timeMany(() => JSON.stringify(frame), 200, 20);
    const parse = timeMany(() => JSON.parse(payload.json), 200, 20);
    rows.push({
      cars: n,
      bytes: payload.bytes,
      stringify: stringify.stats,
      parse: parse.stats,
      blocks: payload.blocks,
    });
  }
  return rows;
}

/**
 * Replays the server's tick policy (src/server/index.ts): a fast 8 ms wake-up
 * and a broadcast only when a frame is due; if we fall behind, resume from now
 * rather than bursting. `workMs` is the synthetic cost of poll+stringify.
 *
 * This is how pedal stutter shows up on the wire: a late tick is a missed
 * sample in the ring buffer, which reads as a hitch in the trace.
 */
function runCadence(hz, durationMs, workMs) {
  const intervalMs = Math.round(1000 / hz);
  const tickMs = Math.max(1, Math.min(intervalMs, 8));
  const gaps = [];
  let lastPoll = Date.now();
  let nextDue = lastPoll;
  const start = lastPoll;
  let broadcasts = 0;
  let late = 0;
  const endAt = start + durationMs;

  while (Date.now() < endAt) {
    const now = Date.now();
    if (now < nextDue) {
      const sleep = Math.min(tickMs, nextDue - now);
      const t0 = nowNs();
      // Busy-wait the leftover so the measurement is not dominated by
      // setTimeout slack. The real server uses setInterval; this isolates
      // "does the work fit" from "does the host timer fire on time".
      while (nsToMs(nowNs() - t0) < sleep) {
        /* spin */
      }
      continue;
    }
    const lateness = now - nextDue;
    if (lateness > 2) late++;
    nextDue = Math.max(nextDue + intervalMs, now);
    const dt = now - lastPoll;
    lastPoll = now;
    gaps.push(dt);
    broadcasts++;
    if (workMs > 0) {
      const t0 = nowNs();
      while (nsToMs(nowNs() - t0) < workMs) {
        /* spin the measured per-tick cost */
      }
    }
  }

  const elapsed = Date.now() - start;
  return {
    hz,
    intervalMs,
    elapsedMs: elapsed,
    broadcasts,
    deliveredHz: (broadcasts / elapsed) * 1000,
    late,
    gaps: statsOf(gaps),
  };
}

function run(opts) {
  const quiet = opts && opts.quiet;
  const pollBench = runPollBench();
  const fields = runFieldScale(pollBench.frame);
  // Cadence with the measured combined mean as the per-tick cost, plus a
  // stressed case (5 ms of extra work) that mimics a hitch on the same machine.
  const cadence = {
    idle30: runCadence(30, CADENCE_MS, 0),
    loaded30: runCadence(30, CADENCE_MS, pollBench.combinedMean),
    stressed30: runCadence(30, CADENCE_MS, Math.max(8, pollBench.combinedMean * 4)),
    idle60: runCadence(60, CADENCE_MS, 0),
    loaded60: runCadence(60, CADENCE_MS, pollBench.combinedMean),
  };

  const result = { pollBench, fields, cadence };

  if (!quiet) print(result);
  return result;
}

function print(result) {
  const { pollBench, fields, cadence } = result;
  const budget30 = budgetMs(DEFAULT_HZ);

  heading('1. Simulator poll (12-car demo field)');
  console.log(
    `  The live provider is not on this machine. This is the synthetic feed` +
      `\n  the server falls back to — allocation-light by design, 12 cars.`,
  );
  printTable(
    [
      { key: 'step', label: 'step' },
      { key: 'mean', label: 'mean', align: 'right' },
      { key: 'p95', label: 'p95', align: 'right' },
      { key: 'p99', label: 'p99', align: 'right' },
      { key: 'max', label: 'max', align: 'right' },
      { key: 'budget', label: '% of 30 Hz', align: 'right' },
    ],
    [
      row('poll()', pollBench.poll, budget30),
      row('JSON.stringify', pollBench.stringify, budget30),
      row('JSON.parse (overlay)', pollBench.parse, budget30),
      {
        step: 'poll + stringify',
        mean: fmtMs(pollBench.combinedMean),
        p95: '',
        p99: fmtMs(pollBench.combinedP99),
        max: '',
        budget: `${pctOfBudget(pollBench.combinedMean, DEFAULT_HZ).toFixed(1)}%`,
      },
    ],
  );
  console.log(
    `\n  30 Hz budget is ${fmtMs(budget30)} per tick.` +
      `  Demo field is ${pollBench.cars} cars.` +
      `\n  Wire payload is ${fmtBytes(pollBench.payload.bytes)}` +
      `  (ARCHITECTURE.md still says ~1–2 KB/frame).`,
  );

  heading('2. Wire cost vs field size (standings + track-map cars scaled)');
  printTable(
    [
      { key: 'cars', label: 'cars', align: 'right' },
      { key: 'bytes', label: 'payload', align: 'right' },
      { key: 'sMean', label: 'stringify', align: 'right' },
      { key: 'pMean', label: 'parse', align: 'right' },
      { key: 'bw30', label: 'KB/s @30Hz', align: 'right' },
      { key: 'bw60', label: 'KB/s @60Hz', align: 'right' },
    ],
    fields.map((f) => ({
      cars: f.cars,
      bytes: fmtBytes(f.bytes),
      sMean: fmtMs(f.stringify.mean),
      pMean: fmtMs(f.parse.mean),
      bw30: (f.bytes * 30 / 1024).toFixed(1),
      bw60: (f.bytes * 60 / 1024).toFixed(1),
    })),
  );

  const biggest = fields[fields.length - 1];
  if (biggest) {
    const top = Object.entries(biggest.blocks)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    console.log('\n  Largest blocks on a 62-car frame:');
    for (const [k, v] of top) console.log(`    ${k.padEnd(12)} ${fmtBytes(v)}`);
  }

  heading('3. Delivered cadence (same catch-up policy as src/server/index.ts)');
  printTable(
    [
      { key: 'name', label: 'case' },
      { key: 'target', label: 'target', align: 'right' },
      { key: 'got', label: 'delivered', align: 'right' },
      { key: 'late', label: 'late ticks', align: 'right' },
      { key: 'gapP99', label: 'gap p99', align: 'right' },
      { key: 'gapMax', label: 'gap max', align: 'right' },
    ],
    Object.entries(cadence).map(([name, c]) => ({
      name,
      target: `${c.hz} Hz`,
      got: fmtHz(c.deliveredHz),
      late: String(c.late),
      gapP99: fmtMs(c.gaps.p99),
      gapMax: fmtMs(c.gaps.max),
    })),
  );
  console.log(
    `\n  "late" means the broadcast fired more than 2 ms after it was due.` +
      `\n  A late tick is a missing pedal sample — that is the stutter, on the wire.`,
  );
}

function row(step, s, budget) {
  return {
    step,
    mean: fmtMs(s.mean),
    p95: fmtMs(s.p95),
    p99: fmtMs(s.p99),
    max: fmtMs(s.max),
    budget: `${pctOfBudget(s.mean, DEFAULT_HZ).toFixed(1)}%`,
  };
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('[bench-pipeline] failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

module.exports = { run, FIELD_SIZES, POLL_SAMPLES };
