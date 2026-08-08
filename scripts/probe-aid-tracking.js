/**
 * scripts/probe-aid-tracking.js — does the garage endpoint FOLLOW a live change?
 * -----------------------------------------------------------------------------
 * `probe-lmu-aids.js` shows both sources side by side and is the right tool for
 * checking an offset. This one answers a different and sharper question: when an
 * aid is changed **in the car**, which sources move?
 *
 * It matters because the two sources are not interchangeable. Shared memory is
 * live but gives a bare step index; `getPlayerGarageData` renders that step in
 * the sim's own words ("200kW", "1.5% F") but has long been believed to hold the
 * SETUP value — frozen, so it would never follow a change made on the wheel. The
 * MFD borrows the garage's wording only when the two agree which step they are
 * describing, so if the garage is frozen that agreement breaks the moment a
 * driver touches anything, and the row silently drops from words to an index.
 *
 * Regeneration is the case that forces the question: it has NO shared-memory
 * source at all (re-confirmed by scanning all 1888 bytes of the player's record
 * for its value as a byte pair, int32, float32 and float64 — only TC slip's
 * matching pair turned up), so the garage endpoint is the only thing the overlay
 * can show. If that is frozen, the regen row cannot move, and no amount of
 * polling it faster will help.
 *
 * Usage — in the car, then change aids one at a time:
 *   node scripts/probe-aid-tracking.js [--seconds 120]
 *
 * It prints ONLY changes, tagged with which source moved:
 *   MEM  = the live telemetry byte moved, garage did not (garage is frozen)
 *   REST = the garage value moved, live byte did not (or there is no live byte)
 *   BOTH = they moved together (the garage tracks live changes for this aid)
 */

'use strict';

const koffi = require('koffi');
const http = require('node:http');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16;
const STRIDE = 1888;
const PORT = Number(process.env.APEX_LMU_PORT || 6397);

/** Offsets mirror `src/telemetry/lmuLocalCar.ts` VT; null = REST-only. */
const AIDS = [
  { name: 'TC map', off: 750, rest: 'VM_TRACTIONCONTROLMAP' },
  { name: 'TC slip', off: 752, rest: 'VM_TRACTIONCONTROLSLIPANGLEMAP' },
  { name: 'TC power cut', off: 754, rest: 'VM_TRACTIONCONTROLPOWERCUTMAP' },
  { name: 'ABS map', off: 756, rest: 'VM_ANTILOCKBRAKESYSTEMMAP' },
  { name: 'Motor map', off: 758, rest: 'VM_ELECTRIC_MOTOR_MAP' },
  { name: 'Brake migration', off: 760, rest: 'VM_BRAKE_MIGRATION' },
  { name: 'Front ARB', off: 762, rest: 'VM_FRONT_ANTISWAY' },
  { name: 'Rear ARB', off: 764, rest: 'VM_REAR_ANTISWAY' },
  { name: 'Regen', off: null, rest: 'VM_REGEN_LEVEL' },
];

const argSec = process.argv.indexOf('--seconds');
const RUN_MS = (argSec >= 0 ? Number(process.argv[argSec + 1]) || 120 : 120) * 1000;

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
const u8 = (o) => koffi.decode(view, o, 'uint8');
const i32 = (o) => koffi.decode(view, o, 'int32');

/** The player's own record. Every other car publishes zeros in this block. */
function findRecord() {
  for (let i = 0; i < 128; i++) {
    const o = BASE + i * STRIDE;
    if (i32(o) === 0) return o;
  }
  return null;
}

function garage() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/rest/garage/getPlayerGarageData', timeout: 2000 },
      (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => {
          try {
            resolve(JSON.parse(b));
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

const rec = findRecord();
if (rec === null) {
  console.error('No player record found (mID 0).');
  process.exit(1);
}

const prev = new Map();
let first = true;

async function sample() {
  const g = (await garage()) || {};
  for (const aid of AIDS) {
    const mem = aid.off === null ? null : u8(rec + aid.off);
    const r = g[aid.rest];
    const rest = r && typeof r.value === 'number' ? r.value : null;
    const words = r && typeof r.stringValue === 'string' ? r.stringValue.trim() : '';
    const was = prev.get(aid.name);
    prev.set(aid.name, { mem, rest, words });
    if (first || !was) continue;
    const memMoved = was.mem !== mem;
    const restMoved = was.rest !== rest;
    if (!memMoved && !restMoved) continue;
    const tag = memMoved && restMoved ? 'BOTH' : memMoved ? 'MEM ' : 'REST';
    console.log(
      `${new Date().toISOString().slice(11, 19)}  ${tag}  ${aid.name.padEnd(16)}` +
        ` mem ${String(was.mem).padStart(3)}→${String(mem).padStart(3)}` +
        `   rest ${String(was.rest).padStart(3)}→${String(rest).padStart(3)}` +
        `   "${was.words}" → "${words}"`,
    );
  }
  if (first) {
    first = false;
    console.log('Baseline:');
    for (const aid of AIDS) {
      const p = prev.get(aid.name);
      console.log(
        `  ${aid.name.padEnd(16)} mem ${String(p.mem).padStart(4)}   rest ${String(p.rest).padStart(4)}   "${p.words}"`,
      );
    }
    console.log('\nChange each aid in the car now. Only changes print.\n');
  }
}

console.log(`Watching aids for ${RUN_MS / 1000}s (record at ${rec}).\n`);
const timer = setInterval(sample, 500);
void sample();
setTimeout(() => {
  clearInterval(timer);
  console.log('\nDone.');
  process.exit(0);
}, RUN_MS);
