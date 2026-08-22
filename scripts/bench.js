/**
 * scripts/bench.js — Apex overlay performance bench, one entry point.
 * -----------------------------------------------------------------------------
 * Assessment only. No production code is imported except the already-built
 * telemetry modules, and nothing in those modules is modified.
 *
 * What this answers, in numbers:
 *
 *   1. Is the 30 Hz tick itself too much? (poll + stringify vs a 33 ms budget)
 *   2. Does a 6-hour grid (36–62 cars) change that answer? (payload + parse)
 *   3. Did the "only pedals at 30 Hz" rule hold? (widget inventory)
 *   4. Would raising the connection help pedal smoothness, or just cost more?
 *
 * What it cannot answer from this Linux / no-sim environment:
 *
 *   - GPU compositing of the transparent in-game Electron window over LMU
 *   - The live shared-memory field sweep (Windows + plugin)
 *   - Host timer coalescing on Windows (~15.6 ms)
 *
 * Run: npm run bench
 *      node scripts/bench.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pipeline = require('./bench-pipeline');
const widgets = require('./bench-widgets');
const subsystems = require('./bench-subsystems');
const { DEFAULT_HZ, budgetMs, fmtMs, heading } = require('./lib/bench-util');

function assess(p, w) {
  const notes = [];
  const combined = p.pollBench.combinedMean;
  const budget = budgetMs(DEFAULT_HZ);
  const share = (combined / budget) * 100;
  const biggest = p.fields[p.fields.length - 1];
  const demoBytes = p.pollBench.payload.bytes;
  const gridBytes = biggest ? biggest.bytes : demoBytes;
  const added = w.fullRate.filter((id) => !w.originally.includes(id));

  if (share < 10) {
    notes.push({
      id: 'hz-budget',
      verdict: '30 Hz is not the bottleneck on the server',
      detail:
        `poll + stringify averages ${fmtMs(combined)} (${share.toFixed(1)}% of the ` +
        `${fmtMs(budget)} budget). Raising the connection to 60 Hz would still ` +
        `leave the demo path well inside its 16.7 ms budget, and would not by ` +
        `itself fix a hitch that is already dropping frames.`,
    });
  } else if (share < 40) {
    notes.push({
      id: 'hz-budget',
      verdict: '30 Hz still has headroom, but it is no longer "almost free"',
      detail:
        `poll + stringify averages ${fmtMs(combined)} (${share.toFixed(1)}% of budget). ` +
        `Doubling the rate doubles this work and every full-rate widget.`,
    });
  } else {
    notes.push({
      id: 'hz-budget',
      verdict: 'the 30 Hz budget is being spent in earnest',
      detail:
        `poll + stringify averages ${fmtMs(combined)} (${share.toFixed(1)}% of budget). ` +
        `Raising Hz would make pedal stutter worse if this is already late.`,
    });
  }

  notes.push({
    id: 'payload',
    verdict:
      demoBytes > 8 * 1024
        ? 'the wire is no longer the 1–2 KB/frame the docs describe'
        : 'the wire is still in the original 1–2 KB ballpark',
    detail:
      `demo (12 cars) ${fmtBytesSafe(demoBytes)}; synthesised 62-car grid ` +
      `${fmtBytesSafe(gridBytes)} — ${((gridBytes * 30) / 1024).toFixed(0)} KB/s at 30 Hz, ` +
      `${((gridBytes * 60) / 1024).toFixed(0)} KB/s at 60 Hz. Localhost can carry it; ` +
      `JSON.parse + standings reconcile on the overlay is the cost that grows.`,
  });

  notes.push({
    id: 'full-rate',
    verdict:
      added.length === 0
        ? 'the original full-rate rule still holds'
        : `full-rate surface grew from 1 widget to ${w.fullRate.length}`,
    detail:
      `ARCHITECTURE.md: only pedals at 30 Hz. Now: ${w.fullRate.join(', ')}. ` +
      `Default in-game layer: ~${w.load30.canvasUps.toFixed(0)} canvas redraws/s ` +
      `at 30 Hz, ~${w.load60.canvasUps.toFixed(0)}/s at 60 Hz. That is the GPU ` +
      `question, and it is independent of whether the socket can keep up.`,
  });

  const cadence = p.cadence.loaded30;
  const deliveredOk = Math.abs(cadence.deliveredHz - 30) < 2;
  notes.push({
    id: 'cadence',
    verdict: deliveredOk
      ? 'the tick policy holds 30 Hz when poll+stringify is the only work'
      : 'the tick policy could not hold 30 Hz under the measured load',
    detail:
      `loaded-30 delivered ${cadence.deliveredHz.toFixed(2)} Hz with ${cadence.late} late ticks. ` +
      `A late tick is a missing pedal sample. If the live field sweep + overlay ` +
      `compositor add more than the leftover ${fmtMs(budget - combined)}, the trace hitch ` +
      `is dropped frames, not a 30 Hz ceiling that needs raising.`,
  });

  notes.push({
    id: 'ingame-gpu',
    verdict: 'the in-game layer is the likely GPU tax, and it is not in these numbers',
    detail:
      'v0.5.0 added a transparent always-on-top Electron window that spans the ' +
      'desktop and hosts every default HUD widget. The original lightweight ' +
      'claim was "no second Chromium — OBS already has one." The in-game path ' +
      'is a second Chromium compositing over the sim. Pedal stutter that tracks ' +
      'GPU busy (bug, grids, other overlays) is this window, not the 30 Hz socket.',
  });

  notes.push({
    id: 'recommendation',
    verdict: 'do not raise Hz to chase this stutter; measure the live tick first',
    detail:
      'If the next step is a change (this run is assessment only): add a live ' +
      'tick-time readout (poll ms, stringify bytes, delivered Hz, late count) ' +
      'on the desktop app so a 6-hour race can tell dropped frames from GPU ' +
      'compositor hitch. Raising APEX_UPDATE_HZ multiplies every full-rate ' +
      'canvas and the field sweep; it helps only when samples are arriving on ' +
      'time and the trace looks stepped rather than hitchy.',
  });

  return notes;
}

function fmtBytesSafe(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function printAssessment(notes) {
  heading('7. Assessment (no production changes)');
  for (const n of notes) {
    console.log(`\n  [${n.id}] ${n.verdict}`);
    console.log(`      ${n.detail}`);
  }
}

function main() {
  const started = Date.now();
  console.log('Apex overlay bench — measurement only, production code untouched');
  console.log(`Node ${process.version}  ${process.platform}/${process.arch}  ${new Date().toISOString()}`);

  const p = pipeline.run({ quiet: false });
  const w = widgets.run({ quiet: false });
  const s = subsystems.run();
  const notes = assess(p, w);
  printAssessment(notes);

  const report = {
    at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    elapsedMs: Date.now() - started,
    pipeline: {
      cars: p.pollBench.cars,
      poll: p.pollBench.poll,
      stringify: p.pollBench.stringify,
      parse: p.pollBench.parse,
      combinedMean: p.pollBench.combinedMean,
      payloadBytes: p.pollBench.payload.bytes,
      fields: p.fields.map((f) => ({
        cars: f.cars,
        bytes: f.bytes,
        stringifyMean: f.stringify.mean,
        parseMean: f.parse.mean,
      })),
      cadence: Object.fromEntries(
        Object.entries(p.cadence).map(([k, c]) => [
          k,
          { deliveredHz: c.deliveredHz, late: c.late, gapP99: c.gaps.p99 },
        ]),
      ),
    },
    widgets: {
      fullRate: w.fullRate,
      originally: w.originally,
      load30: w.load30,
      load60: w.load60,
    },
    subsystems: {
      radar62: s.radar[s.radar.length - 1],
      class62: s.klass[s.klass.length - 1],
      pace62: s.pace[s.pace.length - 1],
      chassis: s.chassis,
    },
    notes,
  };

  const outDir =
    process.env.APEX_BENCH_OUT ||
    (fs.existsSync('/opt/cursor/artifacts') ? '/opt/cursor/artifacts' : null);
  if (outDir) {
    const jsonPath = path.join(outDir, 'bench-report.json');
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
      console.log(`\nWrote ${jsonPath}`);
    } catch (err) {
      console.warn(`[bench] could not write report: ${err.message}`);
    }
  }

  heading('done');
  console.log(`  elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[bench] failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

module.exports = { main, assess };
