/**
 * scripts/lib/bench-util.js — shared helpers for the performance bench suite.
 * -----------------------------------------------------------------------------
 * Measurement only. Nothing here is imported by the overlay, the server, or
 * the desktop app. The suite exists so a 30 Hz / large-grid / pedal-stutter
 * question can be answered with numbers instead of a guess.
 */

'use strict';

const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/** Documented default broadcast rate (src/server/config.ts). */
const DEFAULT_HZ = 30;

/** Milliseconds available for one poll + stringify + send at a given rate. */
function budgetMs(hz) {
  return 1000 / hz;
}

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(ns) {
  return Number(ns) / 1e6;
}

/**
 * Runs `fn` `n` times after `warmup` discarded iterations. Returns the sample
 * list in milliseconds plus summary stats.
 */
function timeMany(fn, n, warmup) {
  const warm = warmup == null ? Math.min(40, Math.max(8, Math.floor(n / 10))) : warmup;
  for (let i = 0; i < warm; i++) fn();
  const samples = new Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = nowNs();
    fn();
    samples[i] = nsToMs(nowNs() - t0);
  }
  return { samples, stats: statsOf(samples) };
}

function statsOf(samples) {
  if (!samples.length) {
    return { n: 0, min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const s = samples.slice().sort((a, b) => a - b);
  const n = s.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  const at = (p) => s[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  return {
    n,
    min: s[0],
    mean: sum / n,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[n - 1],
  };
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  if (ms < 0.01) return `${(ms * 1000).toFixed(1)}µs`;
  if (ms < 1) return `${ms.toFixed(3)}ms`;
  return `${ms.toFixed(2)}ms`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtHz(n) {
  return `${n.toFixed(2)} Hz`;
}

function pctOfBudget(ms, hz) {
  return (ms / budgetMs(hz)) * 100;
}

/**
 * Prints a left-aligned table. `rows` is an array of objects; `cols` is
 * [{key, label, width?, align?}].
 */
function printTable(cols, rows) {
  const widths = cols.map((c) => {
    let w = c.label.length;
    for (const row of rows) {
      const cell = String(row[c.key] == null ? '' : row[c.key]);
      if (cell.length > w) w = cell.length;
    }
    return Math.max(w, c.width || 0);
  });
  const line = (cells) =>
    '  ' +
    cells
      .map((cell, i) => {
        const s = String(cell);
        return cols[i].align === 'right' ? s.padStart(widths[i]) : s.padEnd(widths[i]);
      })
      .join('  ');
  console.log(line(cols.map((c) => c.label)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) {
    console.log(line(cols.map((c) => (row[c.key] == null ? '' : row[c.key]))));
  }
}

function heading(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

function loadSimulator() {
  const { SimulatorProvider } = require(path.join(ROOT, 'dist', 'telemetry', 'simulatorProvider.js'));
  return new SimulatorProvider();
}

/**
 * Deep-enough clone of a telemetry frame so field expansion cannot mutate the
 * provider's live object. JSON round-trip is the honest cost of the wire.
 */
function cloneFrame(frame) {
  return JSON.parse(JSON.stringify(frame));
}

/**
 * Grows (or trims) the field-sized blocks on a frame to `n` cars.
 *
 * The simulator is hard-coded to 12 cars. A 6-hour endurance grid is typically
 * 30–60, so the bench has to synthesise the larger arrays the live provider
 * already publishes — standings (every car) and trackMap.cars (every car).
 * Radar stays range-capped in the live path, so it is left alone unless the
 * caller asks to pad it.
 */
function expandField(frame, n, opts) {
  const out = cloneFrame(frame);
  const src = out.standings || [];
  const padRadar = opts && opts.padRadar;

  if (src.length === 0) return out;

  if (n <= src.length) {
    out.standings = src.slice(0, n);
    if (out.standings[0]) out.standings[0].isPlayer = true;
    if (out.trackMap && Array.isArray(out.trackMap.cars)) {
      out.trackMap.cars = out.trackMap.cars.slice(0, n);
    }
    out.session = out.session || {};
    out.session.numCars = n;
    return out;
  }

  const extra = [];
  for (let i = src.length; i < n; i++) {
    const base = src[i % src.length];
    extra.push({
      ...base,
      slotId: 2000 + i,
      position: i + 1,
      driverName: `Grid ${String(i + 1).padStart(2, '0')}`,
      carNumber: String(100 + i),
      isPlayer: false,
      gapToLeaderSec: i * 0.73,
      gapToAheadSec: 0.73,
      lapsBehind: 0,
    });
  }
  out.standings = src.concat(extra);
  if (out.standings[0]) out.standings[0].isPlayer = true;

  if (out.trackMap && Array.isArray(out.trackMap.cars)) {
    const cars = out.trackMap.cars.slice();
    for (let i = cars.length; i < n; i++) {
      cars.push({
        slotId: 2000 + i,
        x: ((i * 37) % 800) - 400,
        y: 0,
        z: ((i * 53) % 800) - 400,
        lapFraction: (i * 0.017) % 1,
        inPit: false,
        isPlayer: false,
      });
    }
    out.trackMap.cars = cars;
  }

  if (padRadar) {
    const radar = Array.isArray(out.radar) ? out.radar.slice() : [];
    for (let i = radar.length; i < Math.min(n, 12); i++) {
      radar.push({
        slotId: 2000 + i,
        lateralM: ((i % 5) - 2) * 2.4,
        longitudinalM: ((i % 7) - 3) * 4.1,
        distanceM: 8 + i * 1.7,
        alongside: i % 4 === 0,
        carClass: i % 2 === 0 ? 'HYPERCAR' : 'GT3',
        carNumber: String(100 + i),
      });
    }
    out.radar = radar;
  }

  out.session = out.session || {};
  out.session.numCars = n;
  return out;
}

/** Payload size of one JSON-encoded frame, plus a per-block breakdown. */
function measurePayload(frame) {
  const json = JSON.stringify(frame);
  const bytes = Buffer.byteLength(json, 'utf8');
  const blocks = {};
  for (const key of Object.keys(frame)) {
    blocks[key] = Buffer.byteLength(JSON.stringify(frame[key]), 'utf8');
  }
  return { json, bytes, blocks };
}

module.exports = {
  ROOT,
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
};
