/**
 * scripts/probe-sector-flags.js — decode the per-sector flag bytes live.
 * -----------------------------------------------------------------------------
 * REST's `sessionInfo.sectorFlag` publishes ONE value copied into all three
 * slots (measured 2026-08-22: shared memory held `2,3,11` at an instant REST
 * said `["RED","RED","RED"]`), so "which sector is the yellow in" can only be
 * answered from the Scoring header's `mSectorFlag[3]` — whose VALUE ENUM is
 * undecoded. This probe watches both sides and logs every change, which is the
 * experiment that pins the enum:
 *
 *   - the value the three bytes hold while the track is clear (baseline),
 *   - the value they take in exactly the sector(s) a yellow appears in, read
 *     against what REST/the game's own flag rail says at the same instant.
 *
 * Bytes watched (SI-relative, base 12 — layout pinned by mPlayerName@116):
 *   108 mGamePhase · 109 mYellowFlagState · 110..112 mSectorFlag[3]
 *   113 mStartLight · 114 mNumRedLights · 115 mInRealtime
 *
 * Usage — with LMU running, in a session:
 *   node scripts/probe-sector-flags.js
 * Logs to stdout and appends JSONL to ~/.apex-overlay/sector-flags-<ts>.jsonl
 * (one line per change, plus a heartbeat every 60 s so silence is provable).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const FILE_MAP_READ = 0x0004;
const MMF = '$rFactor2SMMP_Scoring$';
const SI_BASE = 12;
/** SI-relative range decoded each tick (covers 105..120 for context). */
const WATCH_FROM = 104; // mNumVehicles long starts here — sanity anchor
const WATCH_TO = 116; // exclusive; mPlayerName starts at 116

let koffi;
try {
  koffi = require('koffi');
} catch {
  console.error('koffi is not installed — run `npm install` first.');
  process.exit(1);
}
if (process.platform !== 'win32') {
  console.error('Shared memory is Windows-only; nothing to probe here.');
  process.exit(1);
}

const k32 = koffi.load('kernel32.dll');
const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
const MapViewOfFile = k32.func(
  'void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)',
);

const handle = OpenFileMappingW(FILE_MAP_READ, false, MMF);
if (!handle) {
  console.error(`${MMF} is not published — is LMU running with the plugin enabled?`);
  process.exit(1);
}
const view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
if (!view) {
  console.error('MapViewOfFile failed.');
  process.exit(1);
}

const outPath = path.join(
  os.homedir(),
  '.apex-overlay',
  `sector-flags-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const out = fs.createWriteStream(outPath, { flags: 'a' });
console.log(`[probe] logging changes to ${outPath}`);

/** Decode the watched header slice. */
function readHeader() {
  const raw = Buffer.from(
    koffi.decode(view, SI_BASE + WATCH_FROM, koffi.array('uint8', WATCH_TO - WATCH_FROM)),
  );
  const at = (siOff) => raw[siOff - WATCH_FROM];
  return {
    numVehicles: raw.readInt32LE(104 - WATCH_FROM),
    gamePhase: at(108),
    yellowFlagState: raw.readInt8(109 - WATCH_FROM),
    sectorFlag: [raw.readInt8(110 - WATCH_FROM), raw.readInt8(111 - WATCH_FROM), raw.readInt8(112 - WATCH_FROM)],
    startLight: at(113),
    numRedLights: at(114),
    inRealtime: at(115),
  };
}

/** GET localhost:6397 JSON, or null. */
function getJson(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port: 6397, path: p, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** The same instant's published story, plus WHO is under yellow and WHERE. */
async function readRest() {
  const [j, standings] = await Promise.all([
    getJson('/rest/watch/sessionInfo'),
    getJson('/rest/watch/standings'),
  ]);
  const out = j
    ? {
        sectorFlag: j.sectorFlag,
        yellowFlagState: j.yellowFlagState,
        gamePhase: j.gamePhase,
        session: j.session,
      }
    : null;
  if (out && Array.isArray(standings)) {
    // Two correlations that can pin mSectorFlag's index orientation:
    //   - cars the sim marks underYellow are IN the yellow zone (if that field
    //     fires at all — the 2026-08-04 capture's me-row never lit through a
    //     51 s yellow, so treat it as a bonus, not the plan);
    //   - a car stopped on track OUTSIDE the pits is the CAUSE of a local
    //     yellow, and its `sector` string names the flagged sector.
    out.underYellow = standings
      .filter((c) => c && c.underYellow === true)
      .map((c) => ({
        driver: c.driverName,
        sector: c.sector,
        lapDist: Math.round(c.lapDistance),
        pitting: c.pitting === true,
        inGarage: c.inGarageStall === true,
      }));
    out.stopped = standings
      .filter(
        (c) =>
          c &&
          c.inGarageStall !== true &&
          c.pitting !== true &&
          c.carVelocity &&
          typeof c.carVelocity.velocity === 'number' &&
          c.carVelocity.velocity < 3,
      )
      .map((c) => ({
        driver: c.driverName,
        sector: c.sector,
        lapDist: Math.round(c.lapDistance),
        speed: Math.round(c.carVelocity.velocity * 10) / 10,
      }));
  }
  return out;
}

let prevKey = '';
let lastBeat = 0;

async function tick() {
  let sm;
  try {
    sm = readHeader();
  } catch (err) {
    console.error('[probe] read failed:', err.message);
    return;
  }
  const key = JSON.stringify([sm.gamePhase, sm.yellowFlagState, sm.sectorFlag, sm.startLight]);
  const now = Date.now();
  const isBeat = now - lastBeat > 60_000;
  if (key === prevKey && !isBeat) return;
  const changed = key !== prevKey;
  prevKey = key;
  if (isBeat) lastBeat = now;

  const rest = await readRest();
  const line = { at: new Date().toISOString(), kind: changed ? 'change' : 'heartbeat', sm, rest };
  out.write(JSON.stringify(line) + '\n');
  const uy =
    rest && Array.isArray(rest.underYellow) && rest.underYellow.length
      ? ` | underYellow: ${rest.underYellow.map((c) => `${c.driver}@${c.sector}(${c.lapDist}m)`).join(', ')}`
      : '';
  const stopped =
    rest && Array.isArray(rest.stopped) && rest.stopped.length
      ? ` | stopped: ${rest.stopped.map((c) => `${c.driver}@${c.sector}(${c.lapDist}m)`).join(', ')}`
      : '';
  console.log(
    `[${line.at}] ${line.kind} SM sector=[${sm.sectorFlag}] yfs=${sm.yellowFlagState} phase=${sm.gamePhase}` +
      (rest ? ` | REST sector=[${rest.sectorFlag}] yfs=${rest.yellowFlagState}` : ' | REST n/a') +
      uy +
      stopped,
  );
}

setInterval(() => void tick(), 250);
void tick();
