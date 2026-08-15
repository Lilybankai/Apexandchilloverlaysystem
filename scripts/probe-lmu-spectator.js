/**
 * scripts/probe-lmu-spectator.js — what does LMU publish for a REMOTE (spectated) car?
 * ------------------------------------------------------------------------------------
 * Context: in spectator/monitor mode there is no local player car, so the overlays
 * lose everything sourced from the "player" telemetry record — gear, revs, pedals,
 * tyres, damage. But the shared-memory Telemetry buffer publishes a 1888-byte record
 * for EVERY car in the field (settled live 2026-07-14). The open question is whether
 * LMU fills the driver-input / damage / temp channels for remote cars, or whether it
 * only dead-reckons position and zeroes the rest.
 *
 * This probe answers it empirically:
 *   1. Ask REST /rest/watch/standings which car hasFocus -> slotID.
 *   2. Find the telemetry record with mID === slotID (verified equal, right stride).
 *   3. Sample the interesting channels at 10 Hz for N seconds.
 *   4. Verdict per channel: LIVE (changes plausibly), FROZEN (constant non-zero),
 *      or DEAD (constant zero).
 * Cross-check: shared-mem |localVel| vs the SAME car's REST carVelocity.velocity —
 * if they track each other we are definitely reading the focused car.
 *
 * Entirely read-only (FILE_MAP_READ + HTTP GETs). Safe to run mid-race; cannot
 * affect anyone's in-car telemetry.
 *
 * Usage:  node scripts/probe-lmu-spectator.js [--seconds 25] [--port 6397]
 */

'use strict';

const http = require('node:http');
const koffi = require('koffi');

const MMF = '$rFactor2SMMP_Telemetry$';
const FILE_MAP_READ = 0x0004;
const BASE = 16;
const STRIDE = 1888;

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', 6397));
const SECONDS = Number(argOf('--seconds', 25));

/* Verified offsets (record base 16, stride 1888) — see live-telemetry-lmu notes. */
const CH = [
  // name, offset, type, zero-is-plausible?
  ['deltaTime', 4, 'f64'],
  ['elapsedTime', 12, 'f64'],
  ['lapNumber', 20, 'i32'],
  ['lapStartET', 24, 'f64'],
  ['velX', 184, 'f64'],
  ['velY', 192, 'f64'],
  ['velZ', 200, 'f64'],
  ['gear', 352, 'i32'],
  ['rpm', 356, 'f64'],
  ['waterTemp', 364, 'f64'],
  ['oilTemp', 372, 'f64'],
  ['unfThrottle', 388, 'f64'],
  ['unfBrake', 396, 'f64'],
  ['unfSteering', 404, 'f64'],
  ['unfClutch', 412, 'f64'],
  ['filtThrottle', 420, 'f64'],
  ['filtBrake', 428, 'f64'],
  ['fuel', 524, 'f64'],
  ['maxRpm', 532, 'f64'],
  ['scheduledStops', 540, 'u8'],
  ['overheating', 541, 'u8'],
  ['detached', 542, 'u8'],
  ['headlights', 543, 'u8'],
  ['dent0', 544, 'u8'], ['dent1', 545, 'u8'], ['dent2', 546, 'u8'], ['dent3', 547, 'u8'],
  ['dent4', 548, 'u8'], ['dent5', 549, 'u8'], ['dent6', 550, 'u8'], ['dent7', 551, 'u8'],
  ['lastImpactET', 552, 'f64'],
  ['lastImpactMag', 560, 'f64'],
  ['speedLimiter', 604, 'u8'],
  ['maxGears', 605, 'u8'],
  ['fuelCapacity', 608, 'f64'],
];

/* Wheel block: 4 wheels at 976 + w*260. Sample a few floats per wheel to see if
 * ANYTHING per-wheel is live for a remote car (rotation/susp/brake temp/pressure —
 * exact fields unknown, we just test liveliness of the block). */
const WHEEL_BASE = 976;
const WHEEL_STRIDE = 260;

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout: 2500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(path + ': ' + e.message)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function main() {
  // 1. Who has focus?
  const standings = await getJson('/rest/watch/standings');
  const focused = standings.find((c) => c.hasFocus || c.focus);
  if (!focused) {
    console.error('No focused car in standings — is a session running?');
    process.exit(1);
  }
  console.log(
    'Focused car: #' + focused.carNumber + ' ' + focused.fullTeamName +
    ' (' + focused.driverName + ', ' + focused.carClass + ') slotID=' + focused.slotID +
    ' inControl=' + focused.inControl + ' player=' + focused.player,
  );

  // 2. Map telemetry read-only, find the record by mID.
  const k32 = koffi.load('kernel32.dll');
  const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
  const MapViewOfFile = k32.func('void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)');
  const handle = OpenFileMappingW(FILE_MAP_READ, false, MMF);
  if (!handle) { console.error('Telemetry MMF not found — shared-memory plugin running?'); process.exit(1); }
  const view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
  if (!view) { console.error('MapViewOfFile failed.'); process.exit(1); }

  const readI32 = (off) => koffi.decode(view, off, 'int32');
  const readU8 = (off) => koffi.decode(view, off, 'uint8');
  const readF64 = (off) => koffi.decode(view, off, 'double');
  const readF32 = (off) => koffi.decode(view, off, 'float');
  const readName = (off) => {
    const bytes = [];
    for (let i = 0; i < 64; i++) {
      const b = readU8(off + i);
      if (!b) break;
      bytes.push(b);
    }
    return Buffer.from(bytes).toString('latin1');
  };

  function findRecord(id) {
    for (let i = 0; i < 128; i++) {
      const o = BASE + i * STRIDE;
      if (readI32(o) === id) return o;
    }
    return -1;
  }

  let rec = findRecord(focused.slotID);
  if (rec < 0) {
    console.error('No telemetry record with mID=' + focused.slotID + ' — dumping first 8 mIDs:');
    for (let i = 0; i < 8; i++) console.error('  record', i, 'mID=', readI32(BASE + i * STRIDE));
    process.exit(1);
  }
  console.log('Record found at offset ' + rec + ' — mVehicleName="' + readName(rec + 32) + '"');

  // 3. Sample.
  const stats = new Map(); // name -> {min,max,distinct:Set (capped), zeros, n}
  for (const [name] of CH) stats.set(name, { min: Infinity, max: -Infinity, vals: new Set(), n: 0 });
  const wheelStats = [];
  for (let w = 0; w < 4; w++) {
    wheelStats.push({ changedBytes: 0, snapshots: [] });
  }
  const speedPairs = []; // [smSpeed, restSpeed]
  let restFocusLost = false;

  const read = (off, ty) => (ty === 'f64' ? readF64(off) : ty === 'i32' ? readI32(off) : ty === 'f32' ? readF32(off) : readU8(off));

  const t0 = Date.now();
  let lastRestPoll = 0;

  async function tick() {
    // Re-find the record each tick in case slots shuffle; cheap.
    rec = findRecord(focused.slotID);
    if (rec < 0) return;
    for (const [name, off, ty] of CH) {
      const v = read(rec + off, ty);
      const s = stats.get(name);
      s.n++;
      if (typeof v === 'number' && isFinite(v)) {
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
        if (s.vals.size < 50) s.vals.add(Math.round(v * 1000) / 1000);
      }
    }
    // Wheel block: snapshot 260 bytes per wheel as 65 f32s, count changing slots.
    for (let w = 0; w < 4; w++) {
      const snap = [];
      for (let i = 0; i < 65; i++) snap.push(readF32(rec + WHEEL_BASE + w * WHEEL_STRIDE + i * 4));
      const ws = wheelStats[w];
      if (ws.snapshots.length) {
        const prev = ws.snapshots[ws.snapshots.length - 1];
        let changed = 0;
        for (let i = 0; i < 65; i++) if (prev[i] !== snap[i]) changed++;
        if (changed > ws.changedBytes) ws.changedBytes = changed;
      }
      if (ws.snapshots.length < 2) ws.snapshots.push(snap);
      else ws.snapshots[1] = snap;
    }
    // Every ~2s pair shared-mem speed with REST speed for the same car.
    if (Date.now() - lastRestPoll > 2000) {
      lastRestPoll = Date.now();
      try {
        const st = await getJson('/rest/watch/standings');
        const me = st.find((c) => c.slotID === focused.slotID);
        const stillFocused = st.find((c) => c.hasFocus || c.focus);
        if (!stillFocused || stillFocused.slotID !== focused.slotID) restFocusLost = true;
        if (me) {
          const vx = readF64(rec + 184), vy = readF64(rec + 192), vz = readF64(rec + 200);
          const smSpeed = Math.sqrt(vx * vx + vy * vy + vz * vz);
          speedPairs.push([smSpeed, me.carVelocity.velocity]);
        }
      } catch (_) { /* transient */ }
    }
  }

  console.log('Sampling ' + SECONDS + 's at ~10 Hz...\n');
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      tick().catch(() => {});
      if (Date.now() - t0 > SECONDS * 1000) { clearInterval(iv); resolve(); }
    }, 100);
  });

  // 4. Verdict.
  console.log('=== CHANNEL VERDICTS (focused remote car, slot ' + focused.slotID + ') ===');
  for (const [name] of CH) {
    const s = stats.get(name);
    const distinct = s.vals.size;
    let verdict;
    if (distinct <= 1) {
      const only = distinct ? [...s.vals][0] : NaN;
      verdict = only === 0 ? 'DEAD (constant 0)' : 'FROZEN (constant ' + only + ')';
    } else {
      verdict = 'LIVE  ' + distinct + (distinct >= 50 ? '+' : '') + ' values, range ' +
        s.min.toFixed(3) + ' .. ' + s.max.toFixed(3);
    }
    console.log('  ' + name.padEnd(15) + verdict);
  }
  console.log('\n=== WHEEL BLOCK (976 + w*260, sampled as 65 f32 slots each) ===');
  for (let w = 0; w < 4; w++) {
    console.log('  wheel ' + w + ': ' + wheelStats[w].changedBytes + '/65 float slots changed between samples');
  }
  console.log('\n=== IDENTITY CHECK (shared-mem |vel| vs REST carVelocity, same slot) ===');
  for (const [sm, rest] of speedPairs.slice(0, 10)) {
    console.log('  sm=' + (sm * 3.6).toFixed(1) + ' km/h   rest=' + (rest * 3.6).toFixed(1) + ' km/h');
  }
  if (restFocusLost) console.log('\nNOTE: TV focus moved to a different car mid-probe; verdicts may mix cars.');

  // 5. What does the pit/repair REST screen say with no local car?
  try {
    const rr = await getJson('/rest/garage/UIScreen/RepairAndRefuel');
    console.log('\n=== /rest/garage/UIScreen/RepairAndRefuel (spectator mode) ===');
    const s = JSON.stringify(rr, null, 1);
    console.log(s.length > 4000 ? s.slice(0, 4000) + '\n  ...(truncated ' + s.length + ' chars total)' : s);
  } catch (e) {
    console.log('\nRepairAndRefuel: ' + e.message);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
