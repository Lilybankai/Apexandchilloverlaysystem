/**
 * scripts/probe-lmu-pressure.js — verify the tyre-pressure offset live.
 * -----------------------------------------------------------------------------
 * The wheel-struct notes in lmuLocalCar.ts name pressure as one of the four
 * anchors (wheel-start +120), but nothing in the app has ever READ it. Before
 * plumbing it to the Team page this probe confirms, on a live session, that
 * +120 holds a plausible kPa value for all four corners.
 *
 * It prints the three neighbouring VERIFIED channels alongside as anchors —
 * brake disc (+24, Kelvin), surface bands (+128/136/144, Kelvin) and wear
 * (+152, 1→0) — so a struct shift shows up as ALL columns going wrong, not as
 * one plausible-looking wrong number.
 *
 * Usage — in a session, on track or in the garage:
 *   node scripts/probe-lmu-pressure.js [--slot <id>]
 * Read-only; samples once a second. Ctrl+C to stop.
 */

'use strict';

const koffi = require('koffi');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16;
const STRIDE = 1888;

const OFF_RPM = 356;
const OFF_THROTTLE = 388;

const WHEEL_BASE = 848;
const WHEEL_STRIDE = 260;
const W_BRAKE = 24; // double, Kelvin — verified anchor
const W_PRESSURE = 120; // double, expected kPa — UNDER TEST
const W_TEMPS = 128; // double[3], Kelvin — verified anchor
const W_WEAR = 152; // double, 1 fresh → 0 gone — verified anchor

const KELVIN = 273.15;
const NAMES = ['FL', 'FR', 'RL', 'RR'];

const k32 = koffi.load('kernel32.dll');
const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
const MapViewOfFile = k32.func('void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)');

function main() {
  const handle = OpenFileMappingW(FILE_MAP_READ, false, MMF);
  if (!handle) {
    console.error('Shared memory not found — is LMU running (and you in a session)?');
    process.exit(1);
  }
  const view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
  if (!view) {
    console.error('MapViewOfFile failed.');
    process.exit(1);
  }

  const argSlot = process.argv.indexOf('--slot');
  const wantId = argSlot >= 0 ? Number(process.argv[argSlot + 1]) : null;

  const readI32 = (off) => koffi.decode(view, off, 'int32');
  const readF64 = (off) => koffi.decode(view, off, 'double');

  function findRecord() {
    for (let i = 0; i < 128; i++) {
      const o = BASE + i * STRIDE;
      if (wantId !== null) {
        if (readI32(o) === wantId) return o;
        continue;
      }
      const thr = readF64(o + OFF_THROTTLE);
      const rpm = readF64(o + OFF_RPM);
      if (thr >= -0.05 && thr <= 1.05 && rpm >= 200 && rpm <= 20000) return o;
    }
    return -1;
  }

  // The Scoring header's mInRealtime byte (offset 127) — the one channel that
  // says whether the driver is actually in the world vs the garage/monitor
  // pages. See the session-ontrack-signal notes in lmuLocalCar.ts.
  let scoringView = null;
  const scoringHandle = OpenFileMappingW(FILE_MAP_READ, false, '$rFactor2SMMP_Scoring$');
  if (scoringHandle) scoringView = MapViewOfFile(scoringHandle, FILE_MAP_READ, 0, 0, 0);
  const inRealtime = () =>
    scoringView ? koffi.decode(scoringView, 127, 'uint8') : -1;

  console.log(`
Probing wheel-start +120 as tyre pressure, all four corners, on EVERY record
that passes the driven-car heuristic (an AI car can pass it too — its slot id
tells them apart; AI cars publish zeros for tyre data).
Plausible = ~130–220 kPa on a warm slick (GT3/Hypercar), moving slowly with
temperature. Anchor columns (brake °C, band °C, wear) must ALL look sane too.
`);

  function sample() {
    const found = [];
    for (let i = 0; i < 128; i++) {
      const o = BASE + i * STRIDE;
      const thr = readF64(o + OFF_THROTTLE);
      const rpm = readF64(o + OFF_RPM);
      if (wantId !== null ? readI32(o) === wantId : thr >= -0.05 && thr <= 1.05 && rpm >= 200 && rpm <= 20000) {
        found.push(o);
      }
    }
    // Only the driven car publishes tyre data (AI/remote cars read 0 K), so a
    // record with a live band IS the driven car. Dump those; if none exist,
    // dump the first candidate so the log still shows the garage baseline.
    const liveBand = (rec) => {
      for (let w = 0; w < 4; w++) {
        const c = readF64(rec + WHEEL_BASE + w * WHEEL_STRIDE + W_TEMPS) - KELVIN;
        if (c > -100) return true;
      }
      return false;
    };
    const live = found.filter(liveBand);
    console.log(`inRealtime=${inRealtime()}  candidates=${found.length}  withLiveTyres=${live.length}`);
    for (const rec of (live.length ? live : found).slice(0, 4)) {
      const slot = readI32(rec);
      for (let w = 0; w < 4; w++) {
        const wb = rec + WHEEL_BASE + w * WHEEL_STRIDE;
        const press = readF64(wb + W_PRESSURE);
        const brakeC = readF64(wb + W_BRAKE) - KELVIN;
        const bands = [0, 8, 16].map((o) => readF64(wb + W_TEMPS + o) - KELVIN);
        const wear = readF64(wb + W_WEAR);
        console.log(
          `slot ${String(slot).padStart(3)} ${NAMES[w]}  press ${press.toFixed(1).padStart(7)} (kPa?)  | ` +
            `brake ${brakeC.toFixed(0).padStart(4)}C  ` +
            `bands ${bands.map((b) => b.toFixed(1)).join('/')}C  ` +
            `wear ${wear.toFixed(3)}`,
        );
      }
    }
    console.log('---');
  }

  sample();
  setInterval(sample, 2000);
}

main();
