/**
 * scripts/probe-lmu-aids.js — the driving aids, REST against shared memory.
 * -----------------------------------------------------------------------------
 * Every aid the MFD shows has two possible sources, and they are not equally
 * good:
 *
 *   - the driven car's telemetry record in SHARED MEMORY, which is live and
 *     updates at physics rate, but gives only a raw step index; and
 *   - `GET /rest/garage/getPlayerGarageData`, which renders the step in the
 *     sim's own words ("P6", "1.5% F", "200kW") but can report a SETUP value
 *     rather than what is on the wheel right now.
 *
 * The overlay reads the live block and borrows the garage's wording only when
 * the two agree on which step they are describing. This script is how that
 * assumption gets checked, and how a shifted offset gets caught after an LMU
 * update.
 *
 * Usage — in LMU, in your own car:
 *   node scripts/probe-lmu-aids.js [--slot <id>]
 *
 * Then, watching the live table:
 *   1. Change TC, TC slip, TC power cut, motor map, brake migration and both
 *      anti-roll bars from the cockpit, one at a time. Each `raw` value must
 *      move the moment you change it. One that never moves is a wrong offset.
 *   2. Watch the REST column while you do it. If it tracks, the garage endpoint
 *      is live for that control; if it sticks, it is a setup value and only the
 *      raw column can be trusted.
 *   3. REGEN is the one aid with no shared-memory source found — it is REST
 *      only. Change it and watch whether the REST column follows. If it does
 *      not, the overlay's regen row is a setup value and will lag in a race;
 *      that is the single most useful thing this script can tell you.
 *
 * A `!=` in the last column means the two sources disagree about the step. That
 * is expected briefly while you are turning a dial, and suspicious if it sticks.
 */

'use strict';

const koffi = require('koffi');
const http = require('node:http');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16;
const STRIDE = 1888;
const LMU_PORT = Number(process.env.APEX_LMU_PORT || 6397);

/* Offsets, mirroring src/telemetry/lmuLocalCar.ts VT. Each is a value/max byte
 * pair; `rest` is the garage key describing the same control. */
const AIDS = [
  { name: 'TC map', off: 750, rest: 'VM_TRACTIONCONTROLMAP' },
  { name: 'TC slip', off: 752, rest: 'VM_TRACTIONCONTROLSLIPANGLEMAP' },
  { name: 'TC power cut', off: 754, rest: 'VM_TRACTIONCONTROLPOWERCUTMAP' },
  { name: 'ABS map', off: 756, rest: 'VM_ANTILOCKBRAKESYSTEMMAP' },
  { name: 'Motor map', off: 758, rest: 'VM_ELECTRIC_MOTOR_MAP' },
  { name: 'Brake migration', off: 760, rest: 'VM_BRAKE_MIGRATION' },
  { name: 'Front ARB', off: 762, rest: 'VM_FRONT_ANTISWAY' },
  { name: 'Rear ARB', off: 764, rest: 'VM_REAR_ANTISWAY' },
  // No shared-memory offset found for this one — REST only. See the module note.
  { name: 'Regen', off: null, rest: 'VM_REGEN_LEVEL' },
];

const argSlot = process.argv.indexOf('--slot');
const wantId = argSlot >= 0 ? Number(process.argv[argSlot + 1]) : null;

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

const readI32 = (off) => koffi.decode(view, off, 'int32');
const readU8 = (off) => koffi.decode(view, off, 'uint8');
const readF64 = (off) => koffi.decode(view, off, 'double');

function findRecord() {
  for (let i = 0; i < 128; i++) {
    const o = BASE + i * STRIDE;
    if (wantId !== null) {
      if (readI32(o) === wantId) return o;
      continue;
    }
    // No slot given: the player's own record is the one carrying a populated
    // aid block. AI cars publish zeros there — probing them is the classic trap.
    const thr = readF64(o + 388);
    const rpm = readF64(o + 356);
    const hasAids = readU8(o + 751) > 0 || readU8(o + 755) > 0;
    if (thr >= -0.05 && thr <= 1.05 && rpm >= 200 && rpm <= 20000 && hasAids) return o;
  }
  return -1;
}

const rec = findRecord();
if (rec < 0) {
  console.error(
    'No driven car with a populated aid block found. Get in your own car, or pass\n' +
      '--slot <id> with your REST slotID. (AI records read all zeros here.)',
  );
  process.exit(1);
}
console.log(`Record at byte ${rec} (mID ${readI32(rec)}).\n`);

function garage() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: LMU_PORT, path: '/rest/garage/getPlayerGarageData', timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
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

async function tick() {
  const g = await garage();
  const lines = [];
  for (const aid of AIDS) {
    const raw = aid.off === null ? null : { v: readU8(rec + aid.off), m: readU8(rec + aid.off + 1) };
    const r = g ? g[aid.rest] : undefined;
    const restVal = r && typeof r.value === 'number' ? r.value : null;
    const restTxt = r && typeof r.stringValue === 'string' ? r.stringValue.trim() : '—';
    const restMax = r && typeof r.maxValue === 'number' ? r.maxValue : null;

    // Skip controls this car does not offer at all.
    if (raw && raw.m === 0 && restMax !== null && restMax <= 1) continue;
    if (!raw && restVal === null) continue;

    const rawCol = raw ? `${raw.v}/${raw.m}` : ' (none) ';
    const restCol = restVal === null ? '—' : `${restVal}/${restMax === null ? '?' : restMax - 1}`;
    let flag = '';
    if (raw && restVal !== null) flag = raw.v === restVal ? 'ok' : '!=';
    else if (!raw) flag = 'REST only';

    lines.push(
      '  ' +
        aid.name.padEnd(16) +
        ' raw ' + rawCol.padStart(8) +
        '   REST ' + restCol.padStart(7) +
        '   ' + restTxt.padEnd(12) +
        '  ' + flag,
    );
  }
  console.log(
    'aid                  shared mem      garage    sim words     agree\n' +
      lines.join('\n') + '\n',
  );
}

console.log('Change each aid from the cockpit and watch its row move. Ctrl-C to stop.\n');
tick();
setInterval(tick, 1000);
