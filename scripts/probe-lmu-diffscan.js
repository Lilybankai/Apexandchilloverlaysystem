/**
 * scripts/probe-lmu-diffscan.js — find a channel by MOVING it, not by matching it.
 * -----------------------------------------------------------------------------
 * The other probes in here check an offset you already suspect. This one finds
 * one you do not: it watches every byte of the player's telemetry record while
 * you change a single control in the car, and reports the offsets that moved
 * like a setting rather than like physics.
 *
 * ## Why the value-matching approach was not enough
 * Regeneration was declared absent from shared memory by scanning all 1888 bytes
 * for the value the REST garage endpoint was reporting at the same moment. That
 * search is only as good as its needle, and the needle came from
 * `getPlayerGarageData`, which holds a SETUP value — so if the driver had ever
 * changed regen in the car, the live byte would hold something the scan was not
 * looking for, and a perfectly good offset would be rejected. Worse, the scan
 * assumed the encoding: a value/max byte pair. A single byte with its max
 * somewhere else, or a kW figure rather than a step index, would both be missed.
 *
 * Diffing removes every one of those assumptions. A control the driver is
 * stepping produces a distinctive signature — a byte that holds still, jumps,
 * holds still again — which nothing in the physics block does.
 *
 * ## Usage
 *   node scripts/probe-lmu-diffscan.js [--seconds 90] [--max-changes 40]
 *
 * Then, in the car, change ONE control repeatedly and nothing else. Steering,
 * throttle and the wheels will light up the physics offsets; the filter below
 * discards them by demanding a channel be quiet most of the time.
 *
 * Every candidate is printed with the sequence of values it took, which is what
 * identifies it: stepping regen from 200 kW to 0 in eleven clicks should show a
 * byte walking 10, 9, 8 … 0, and nothing else in the record does that.
 */

'use strict';

const koffi = require('koffi');
const http = require('node:http');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16;
const STRIDE = 1888;
const PORT = Number(process.env.APEX_LMU_PORT || 6397);
const SAMPLE_MS = 100;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) || dflt : dflt;
};
const RUN_MS = arg('--seconds', 90) * 1000;
/** Above this many distinct changes a channel is physics, not a setting. */
const MAX_CHANGES = arg('--max-changes', 40);

const k32 = koffi.load('kernel32.dll');
const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
const MapViewOfFile = k32.func(
  'void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)',
);

const handle = OpenFileMappingW(FILE_MAP_READ, false, MMF);
if (!handle) {
  console.error('Shared memory not found — is LMU running and are you in the car?');
  process.exit(1);
}
const view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
if (!view) {
  console.error('MapViewOfFile failed.');
  process.exit(1);
}
const i32 = (o) => koffi.decode(view, o, 'int32');
const bytes = (o, n) => Buffer.from(koffi.decode(view, o, koffi.array('uint8', n, 'Array')));

let rec = null;
for (let i = 0; i < 128; i++) {
  const o = BASE + i * STRIDE;
  if (i32(o) === 0) {
    rec = o;
    break;
  }
}
if (rec === null) {
  console.error('No player record found (mID 0).');
  process.exit(1);
}

function garageRegen() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/rest/garage/getPlayerGarageData', timeout: 2000 },
      (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => {
          try {
            const j = JSON.parse(b);
            resolve(j.VM_REGEN_LEVEL || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Per-offset history: how many times it changed, and the values it took. */
const changes = new Uint16Array(STRIDE);
const seq = new Map();
let prev = bytes(rec, STRIDE);
let samples = 0;

console.log(`Diff-scanning the player's record at ${rec}, ${RUN_MS / 1000}s.`);
console.log('Change ONE control in the car, repeatedly. Ctrl-C or wait for the summary.\n');

const timer = setInterval(() => {
  const now = bytes(rec, STRIDE);
  samples++;
  for (let o = 0; o < STRIDE; o++) {
    if (now[o] === prev[o]) continue;
    changes[o]++;
    if (changes[o] <= MAX_CHANGES) {
      if (!seq.has(o)) seq.set(o, [prev[o]]);
      seq.get(o).push(now[o]);
    }
  }
  prev = now;
}, SAMPLE_MS);

setTimeout(async () => {
  clearInterval(timer);
  const regen = await garageRegen();

  console.log(`\n${samples} samples taken.`);
  console.log(`REST regen now: ${regen ? `${regen.value} "${regen.stringValue}"` : '(unavailable)'}\n`);

  const candidates = [];
  for (let o = 0; o < STRIDE; o++) {
    if (changes[o] === 0 || changes[o] > MAX_CHANGES) continue;
    candidates.push(o);
  }

  if (!candidates.length) {
    console.log('Nothing changed in a setting-like way. Either the control has no');
    console.log('byte in this record, or nothing was actually adjusted during the run.');
    process.exit(0);
  }

  console.log(`${candidates.length} setting-like offsets (≤ ${MAX_CHANGES} changes):\n`);
  console.log('offset  changes  values');
  for (const o of candidates) {
    const v = seq.get(o) || [];
    const shown = v.length > 24 ? v.slice(0, 24).join(',') + ',…' : v.join(',');
    // The known aid run is labelled, so a new find stands out from the ones
    // already mapped in src/telemetry/lmuLocalCar.ts.
    const known =
      o >= 750 && o <= 765
        ? ['TC', 'TCmax', 'slip', 'slipMax', 'cut', 'cutMax', 'abs', 'absMax', 'motor',
           'motorMax', 'mig', 'migMax', 'fARB', 'fARBmax', 'rARB', 'rARBmax'][o - 750]
        : '';
    console.log(
      String(o).padStart(6) + String(changes[o]).padStart(9) + '  ' + shown + (known ? `   <- ${known}` : ''),
    );
  }
  process.exit(0);
}, RUN_MS);
