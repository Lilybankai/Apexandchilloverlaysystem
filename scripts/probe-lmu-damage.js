/**
 * scripts/probe-lmu-damage.js — find out what damage data LMU actually gives us.
 * -----------------------------------------------------------------------------
 * Two candidate sources, and this probe watches both at once so a single lap
 * with one contact in it settles which (if either) is real.
 *
 * ## Source A — the shared-memory damage block
 * The ISI `TelemInfoV01` damage fields sit between two offsets `lmuLocalCar.ts`
 * has already verified live: `mEngineMaxRPM` at 532 and `mFuelCapacity` at 608.
 * The standard field order fills that 68-byte gap EXACTLY, with no slack:
 *
 *   mScheduledStops(540,u8) mOverheating(541,bool) mDetached(542,bool)
 *   mHeadlights(543,bool) mDentSeverity[8](544..551,u8)
 *   mLastImpactET(552,f64) mLastImpactMagnitude(560,f64)
 *   mLastImpactPos(568,3xf64) mEngineTorque(592,f64) mCurrentSector(600,i32)
 *   mSpeedLimiter(604,u8) mMaxGears(605,u8) mFront/RearTireCompound(606,607)
 *   -> mFuelCapacity(608)
 *
 * 1+1+1+1+8+8+8+24+8+4+1+1+1+1 = 68. Bracketed on both sides by known-good
 * offsets, which is the same argument that pinned the motion block in 0.8.0 —
 * and much stronger than a scan.
 *
 * So the LOCATION is not really in doubt. What is in doubt is whether LMU
 * POPULATES these inherited fields at all: LMU replaced rF2's damage model with
 * its own, and an inherited-but-dead field would read a constant zero forever.
 * That is what this probe is for, and it is not a question reasoning can settle.
 *
 * ## Source B — the REST repair screen
 * `/rest/garage/UIScreen/RepairAndRefuel` is LMU's own pit menu, and the game
 * draws bodywork/aero/suspension damage and repair times on it — so the numbers
 * are in that payload somewhere. `lmuRestProvider.ts` already polls this
 * endpoint but reads exactly one field out of it (`wearables.tires`). This
 * probe dumps the WHOLE payload and then reports which keys move, which is the
 * fastest route to a damage widget that shows real repair seconds.
 *
 * Usage — start LMU, get on track, then in another terminal:
 *   node scripts/probe-lmu-damage.js [--slot <id>] [--port 6397] [--full]
 *
 * Take one solid hit (a wall, a kerb strike, light contact) and watch. Both
 * sources are read-only; safe to run while racing.
 */

'use strict';

const http = require('node:http');
const koffi = require('koffi');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16;
const STRIDE = 1888;

/** Verified scalars, used only to pick the driven car's record. */
const OFF_RPM = 356;
const OFF_THROTTLE = 388;

/** The block under test. See the header for how these are pinned. */
const OFF_SCHEDULED_STOPS = 540;
const OFF_OVERHEATING = 541;
const OFF_DETACHED = 542;
const OFF_HEADLIGHTS = 543;
const OFF_DENT = 544; // 8 x uint8
const OFF_IMPACT_ET = 552;
const OFF_IMPACT_MAG = 560;
const OFF_IMPACT_POS = 568; // 3 x double

/** Engine health, from the same struct — the precursors to mOverheating. */
const OFF_WATER_TEMP = 364;
const OFF_OIL_TEMP = 372;

/** The two anchors either side of the block. If these read wrong, stop. */
const OFF_ENGINE_MAX_RPM = 532;
const OFF_FUEL_CAPACITY = 608;

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', 6397));
const FULL = process.argv.includes('--full');
const argSlot = process.argv.indexOf('--slot');
const wantId = argSlot >= 0 ? Number(process.argv[argSlot + 1]) : null;

/* -------------------------------------------------------------------------- */
/*  Source B — REST                                                           */
/* -------------------------------------------------------------------------- */

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path, timeout: 2000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('bad JSON from ' + path + ': ' + err.message));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Flattens a payload to `a.b.c -> scalar` pairs. Damage is likely to be nested
 * under something like `damage.aero` or carried in a parallel array, and we do
 * not know the shape — so flatten everything and let the diff find it.
 */
function flatten(obj, prefix, out) {
  out = out || {};
  prefix = prefix || '';
  if (obj === null || typeof obj !== 'object') {
    out[prefix] = obj;
    return out;
  }
  for (const key of Object.keys(obj)) {
    const path = prefix ? prefix + '.' + key : key;
    const v = obj[key];
    if (v !== null && typeof v === 'object') flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

/** Keys whose name alone suggests damage or repair. Reported first. */
const INTERESTING = /damag|repair|broke|broken|bodywork|aero|susp|wing|dent|fix|time/i;

let restBaseline = null;
let restSeen = null;
const restMoved = new Set();

async function sampleRest() {
  let payload;
  try {
    payload = await getJson('/rest/garage/UIScreen/RepairAndRefuel');
  } catch (err) {
    if (!restSeen) console.log('  REST: ' + err.message + ' (only alive inside a session)');
    return;
  }
  const flat = flatten(payload);
  if (!restBaseline) {
    restBaseline = flat;
    restSeen = payload;
    const keys = Object.keys(flat);
    console.log('\n=== RepairAndRefuel payload: ' + keys.length + ' scalar keys ===');
    const hits = keys.filter((k) => INTERESTING.test(k));
    if (hits.length) {
      console.log('  Keys that look damage/repair related:');
      for (const k of hits) console.log('    ' + k + ' = ' + JSON.stringify(flat[k]));
    } else {
      console.log('  (no key name matched damage/repair — full dump below)');
    }
    if (FULL || !hits.length) {
      console.log('  Full payload:');
      console.log(JSON.stringify(payload, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
    } else {
      console.log('  (re-run with --full to dump the whole payload)');
    }
    console.log('=== watching for changes ===\n');
    return;
  }
  for (const k of Object.keys(flat)) {
    if (restBaseline[k] !== flat[k] && !restMoved.has(k)) {
      restMoved.add(k);
      console.log(
        '  REST CHANGED  ' + k + ': ' +
          JSON.stringify(restBaseline[k]) + ' -> ' + JSON.stringify(flat[k]),
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Source A — shared memory                                                  */
/* -------------------------------------------------------------------------- */

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
      const thr = readF64(o + OFF_THROTTLE);
      const rpm = readF64(o + OFF_RPM);
      if (thr >= -0.05 && thr <= 1.05 && rpm >= 200 && rpm <= 20000) return o;
    }
    return -1;
  }

  /** Anything non-zero here at any point is proof the field is alive. */
  const alive = {
    dent: [0, 0, 0, 0, 0, 0, 0, 0],
    overheating: false,
    detached: false,
    impactMag: 0,
    impactCount: 0,
  };
  let lastImpactET = -1;
  let anchorsChecked = false;

  console.log(`
Probing LMU damage. Two sources at once — shared memory and the REST pit screen.

WHAT TO DO
  1. Get on track and let it settle for a few seconds (baseline is taken then).
  2. Take ONE clear hit: brush a wall, or a firm kerb strike.
  3. Watch for DENT / DETACHED / IMPACT lines, and REST CHANGED lines.
  4. Ctrl-C for the verdict.

The question is NOT where these fields are — that is pinned by arithmetic on
both sides. It is whether LMU writes to them at all, or whether its own damage
model bypasses the inherited rF2 block and only surfaces on the repair screen.
`);

  function sample() {
    const rec = findRecord();
    if (rec < 0) {
      console.log('(no driven car found — get in the car / pass --slot <id>)');
      return;
    }

    // Sanity: the two verified anchors bracketing the block. If these are wrong
    // the record is misaligned and nothing below means anything.
    if (!anchorsChecked) {
      const maxRpm = readF64(rec + OFF_ENGINE_MAX_RPM);
      const cap = readF64(rec + OFF_FUEL_CAPACITY);
      const ok = maxRpm > 1000 && maxRpm < 25000 && cap > 10 && cap < 250;
      console.log(
        (ok ? '  anchors OK   ' : '  ANCHORS BAD  ') +
          'maxRPM=' + maxRpm.toFixed(0) + ' fuelCap=' + cap.toFixed(1) + 'L' +
          (ok ? '' : '  <-- record misaligned; damage reads below are meaningless'),
      );
      anchorsChecked = true;
    }

    const dent = [];
    for (let i = 0; i < 8; i++) dent.push(readU8(rec + OFF_DENT + i));
    const overheating = readU8(rec + OFF_OVERHEATING) !== 0;
    const detached = readU8(rec + OFF_DETACHED) !== 0;
    const headlights = readU8(rec + OFF_HEADLIGHTS) !== 0;
    const stops = readU8(rec + OFF_SCHEDULED_STOPS);
    const impactET = readF64(rec + OFF_IMPACT_ET);
    const impactMag = readF64(rec + OFF_IMPACT_MAG);
    const water = readF64(rec + OFF_WATER_TEMP);
    const oil = readF64(rec + OFF_OIL_TEMP);

    for (let i = 0; i < 8; i++) if (dent[i] > alive.dent[i]) alive.dent[i] = dent[i];
    if (overheating) alive.overheating = true;
    if (detached) alive.detached = true;
    if (impactMag > alive.impactMag) alive.impactMag = impactMag;

    // A new impact timestamp is the single most useful event here: it proves
    // the block is live AND gives the magnitude scale in one go.
    if (impactET > 0 && impactET !== lastImpactET) {
      lastImpactET = impactET;
      alive.impactCount++;
      const px = readF64(rec + OFF_IMPACT_POS);
      const py = readF64(rec + OFF_IMPACT_POS + 8);
      const pz = readF64(rec + OFF_IMPACT_POS + 16);
      console.log(
        '  IMPACT  et=' + impactET.toFixed(2) + 's  mag=' + impactMag.toFixed(1) +
          '  at (' + px.toFixed(2) + ', ' + py.toFixed(2) + ', ' + pz.toFixed(2) + ')',
      );
    }

    const dentStr = dent.join('');
    if (dentStr !== '00000000' || overheating || detached) {
      console.log(
        '  STATE   dent=' + dentStr + ' detached=' + detached +
          ' overheating=' + overheating + ' water=' + water.toFixed(0) + 'C' +
          ' oil=' + oil.toFixed(0) + 'C' +
          ' lights=' + headlights + ' stops=' + stops,
      );
    }
  }

  setInterval(sample, 500);
  setInterval(() => { sampleRest().catch(() => {}); }, 1000);

  process.on('SIGINT', () => {
    const dentLive = alive.dent.some((v) => v > 0);
    console.log(`
=== VERDICT ===

SHARED MEMORY (inherited rF2 damage block)
  mDentSeverity  : ${dentLive ? 'ALIVE — peaks ' + alive.dent.join('') : 'never left zero'}
  mDetached      : ${alive.detached ? 'ALIVE — went true' : 'never went true'}
  mOverheating   : ${alive.overheating ? 'ALIVE — went true' : 'never went true'}
  impacts seen   : ${alive.impactCount}${alive.impactCount ? ' (peak magnitude ' + alive.impactMag.toFixed(1) + ')' : ''}

  If you took a real hit and everything above says "never", LMU does not
  populate the inherited block and a damage widget must come from REST.

REST (/rest/garage/UIScreen/RepairAndRefuel)
  keys that moved: ${restMoved.size ? '\n    ' + [...restMoved].join('\n    ') : 'none'}

  Keys that move after contact are the damage channels. If any of them is
  denominated in seconds, that is the repair-time readout — the thing worth
  building the widget on.
`);
    process.exit(0);
  });
}

main();
