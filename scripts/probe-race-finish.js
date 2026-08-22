/**
 * scripts/probe-race-finish.js — what the sim publishes on the LAST LAP and at
 * the CHEQUERED FLAG.
 * -----------------------------------------------------------------------------
 * The overlay has nothing for the end of a race: no white-flag / final-lap
 * signal in the race-control widget, and no engineer callout for "this is your
 * last lap" or "that's the flag, you finished P4". Both need a channel that says
 * so, and guessing offsets is how the damage widget got stuck (see the
 * damage-widget-blocked note) — so this records every candidate at 5 Hz through
 * the end of a session and leaves a file to read afterwards.
 *
 * Watched, per tick:
 *
 *   MMF `$rFactor2SMMP_Scoring$` header (rF2ScoringInfo, pack(4)):
 *     mCurrentET 68, mEndET 76, mMaxLaps 84, mNumVehicles 104, mGamePhase 108,
 *     mYellowFlagState 109, mSectorFlag[3] 110, mStartLight 113,
 *     mNumRedLights 114, mInRealtime 115
 *     — the same layout mPlayerName@116 / mInRealtime@127-absolute already
 *       verified live (see the team-event-identity and race-control notes), so
 *       these are bracketed rather than assumed.
 *
 *   MMF vehicle record, for OUR car and the leader:
 *     mTotalLaps 100, mSector 102, mFinishStatus 103, mPlace 199, mFlag 504,
 *     mUnderYellow 505, mInGarageStall 507
 *     — mSector/mFinishStatus sit in the two bytes between mTotalLaps (100,
 *       verified) and mLapDist (104, verified), which is exactly where the stock
 *       record puts them and the only thing that fits.
 *
 *   REST: /rest/watch/sessionInfo, /rest/watch/standings (our row + leader),
 *         /rest/sessions/GetGameState — diffed, so a field that only changes at
 *         the flag announces itself.
 *
 * Nothing is written to the game; every endpoint here is read-only.
 *
 * Usage, with the race running:
 *   node scripts/probe-race-finish.js            # stops 90 s after the flag
 *   node scripts/probe-race-finish.js --hz 10
 * Output: ~/.apex-overlay/finish-probe-<stamp>.jsonl, plus a live console log of
 * every CHANGE (the steady state is not printed — the interesting part is the
 * transitions).
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PORT = 6397;
const MMF = '$rFactor2SMMP_Scoring$';
const FILE_MAP_READ = 0x0004;

const argv = process.argv.slice(2);
const hz = Number(argv[argv.indexOf('--hz') + 1]) || 5;
/**
 * Our car's race number. In a driver-swap event NO row is flagged as the player
 * while a teammate drives (see the team-event-identity note), so the probe has
 * to be told which car to follow — or it learns it from the teams map below.
 */
let ourNumber = argv.indexOf('--car') >= 0 ? String(argv[argv.indexOf('--car') + 1]) : null;
const periodMs = Math.max(50, Math.round(1000 / hz));

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUTDIR = path.join(os.homedir(), '.apex-overlay');
fs.mkdirSync(OUTDIR, { recursive: true });
const LOG = path.join(OUTDIR, `finish-probe-${stamp}.jsonl`);

const t0 = Date.now();
function record(obj) {
  fs.appendFileSync(
    LOG,
    JSON.stringify({ t: +((Date.now() - t0) / 1000).toFixed(2), ...obj }) + '\n',
    'utf8',
  );
}
function say(tag, obj) {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${tag} ${JSON.stringify(obj)}`;
  console.log(line);
  record({ tag, ...obj });
}

/* ------------------------------- shared memory ---------------------------- */

let koffi;
try {
  koffi = require('koffi');
} catch {
  console.error('koffi is not installed — run `npm install` first.');
  process.exit(1);
}
if (process.platform !== 'win32') {
  console.error('Shared memory is Windows-only.');
  process.exit(1);
}

const k32 = koffi.load('kernel32.dll');
const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
const MapViewOfFile = k32.func(
  'void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)',
);
const UnmapViewOfFile = k32.func('bool __stdcall UnmapViewOfFile(void*)');
const CloseHandle = k32.func('bool __stdcall CloseHandle(void*)');
const VirtualQuery = k32.func('size_t __stdcall VirtualQuery(void*, void*, size_t)');

/** One snapshot of the whole scoring buffer, or `null` if it is not published. */
function readScoring() {
  const handle = OpenFileMappingW(FILE_MAP_READ, false, MMF);
  if (!handle) return null;
  const view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
  if (!view) {
    CloseHandle(handle);
    return null;
  }
  const mbi = Buffer.alloc(48);
  VirtualQuery(view, mbi, 48);
  const size = Number(mbi.readBigUInt64LE(24));
  const buf = Buffer.from(koffi.decode(view, 0, koffi.array('uint8', size)));
  UnmapViewOfFile(view);
  CloseHandle(handle);
  return buf;
}

const SI_BASE = 12;
const SI = {
  mTrackName: 0,
  mSession: 64,
  mCurrentET: 68,
  mEndET: 76,
  mMaxLaps: 84,
  mLapDist: 88,
  mNumVehicles: 104,
  mGamePhase: 108,
  mYellowFlagState: 109,
  mSectorFlag: 110, // [3]
  mStartLight: 113,
  mNumRedLights: 114,
  mInRealtime: 115,
  mPlayerName: 116,
  sizeof: 548,
};
const VS = {
  stride: 584,
  mID: 0,
  mDriverName: 4,
  mTotalLaps: 100,
  mSector: 102,
  mFinishStatus: 103,
  mLapDist: 104,
  mNumPenalties: 194,
  mIsPlayer: 196,
  mInPits: 198,
  mPlace: 199,
  mFlag: 504,
  mUnderYellow: 505,
  mInGarageStall: 507,
};

const cstr = (buf, off, len) => buf.slice(off, off + len).toString('latin1').split('\0')[0].trim();

function scoringSnapshot() {
  const buf = readScoring();
  if (!buf) return null;
  const b = SI_BASE;
  const n = Math.min(128, Math.max(0, buf.readInt32LE(b + SI.mNumVehicles)));
  const head = {
    session: buf.readInt32LE(b + SI.mSession),
    currentET: +buf.readDoubleLE(b + SI.mCurrentET).toFixed(2),
    endET: +buf.readDoubleLE(b + SI.mEndET).toFixed(2),
    maxLaps: buf.readInt32LE(b + SI.mMaxLaps),
    numVehicles: n,
    gamePhase: buf.readUInt8(b + SI.mGamePhase),
    yellowFlagState: buf.readInt8(b + SI.mYellowFlagState),
    sectorFlag: [
      buf.readInt8(b + SI.mSectorFlag),
      buf.readInt8(b + SI.mSectorFlag + 1),
      buf.readInt8(b + SI.mSectorFlag + 2),
    ].join(','),
    startLight: buf.readUInt8(b + SI.mStartLight),
    numRedLights: buf.readUInt8(b + SI.mNumRedLights),
    inRealtime: buf.readUInt8(b + SI.mInRealtime),
    playerName: cstr(buf, b + SI.mPlayerName, 32),
  };
  const base = b + SI.sizeof;
  const cars = [];
  for (let i = 0; i < n; i++) {
    const o = base + i * VS.stride;
    cars.push({
      id: buf.readInt32LE(o + VS.mID),
      name: cstr(buf, o + VS.mDriverName, 32),
      laps: buf.readInt16LE(o + VS.mTotalLaps),
      sector: buf.readInt8(o + VS.mSector),
      finishStatus: buf.readInt8(o + VS.mFinishStatus),
      pen: buf.readInt16LE(o + VS.mNumPenalties),
      isPlayer: buf.readUInt8(o + VS.mIsPlayer),
      inPits: buf.readUInt8(o + VS.mInPits),
      place: buf.readUInt8(o + VS.mPlace),
      flag: buf.readUInt8(o + VS.mFlag),
      underYellow: buf.readUInt8(o + VS.mUnderYellow),
      inGarage: buf.readUInt8(o + VS.mInGarageStall),
    });
  }
  return { head, cars };
}

/* ---------------------------------- REST ---------------------------------- */

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port: PORT, path: p, timeout: 3000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(d));
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

/* --------------------------------- the loop -------------------------------- */

/**
 * Fields that move every single frame and say nothing about the flag. Dropped
 * before diffing or the log is 95 % car coordinates and the one byte that
 * matters is invisible in it.
 */
const NOISE =
  /^(carPosition|carVelocity|carAcceleration|pathLateral|trackEdge|timeIntoLap|lapDistance|currentSectorTime\d|estimatedLapTime|fuelFraction|veFraction|timeOfDay|currentEventTime|currentET|timeRemainingInGamePhase|raceCompletion|ambientTemp|trackTemp|windSpeed|closeestWeatherNode|attackMode|drsActive|headlights|steamID|upgradePack|carId|vehicleFilename)$/;
const denoise = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!NOISE.test(k)) out[k] = v;
  return out;
};

/** Print only what CHANGED — a six-minute steady state is not the interesting part. */
const last = new Map();
function diff(tag, raw) {
  const obj = denoise(raw);
  const prev = last.get(tag);
  const now = JSON.stringify(obj);
  if (prev === now) return false;
  last.set(tag, now);
  const out = {};
  const prevObj = prev ? JSON.parse(prev) : {};
  for (const [k, v] of Object.entries(obj)) {
    if (JSON.stringify(prevObj[k]) !== JSON.stringify(v)) out[k] = v;
  }
  say(tag, prev ? out : obj);
  return true;
}

let finishedAt = 0;
let ticks = 0;

async function tick() {
  ticks++;
  const snap = scoringSnapshot();
  if (snap) {
    diff('MMF.head', snap.head);
    const me = snap.cars.find((c) => c.isPlayer) || null;
    const leader = snap.cars.find((c) => c.place === 1) || null;
    // Our car by name, so a driver-swap event (no isPlayer row) still tracks it.
    const mine = me || snap.cars.find((c) => c.name === snap.head.playerName) || null;
    if (mine) diff('MMF.me', mine);
    if (leader) diff('MMF.leader', leader);
    // How many cars the sim considers finished — the field-wide view of the flag.
    const fin = snap.cars.filter((c) => c.finishStatus > 0).length;
    diff('MMF.finishedCount', { finished: fin, of: snap.cars.length });
    if (mine && mine.finishStatus > 0 && !finishedAt) {
      finishedAt = Date.now();
      say('*** OUR CAR IS FLAGGED FINISHED ***', {
        place: mine.place,
        laps: mine.laps,
        finishStatus: mine.finishStatus,
      });
    }
  } else if (ticks === 1) {
    say('MMF', { error: 'scoring buffer not published' });
  }

  // REST, every other tick — the endpoints are cheap but not free.
  if (ticks % 2 === 0) {
    const [si, standings, gs] = await Promise.all([
      get('/rest/watch/sessionInfo'),
      get('/rest/watch/standings'),
      get('/rest/sessions/GetGameState'),
    ]);
    if (si) {
      // Whole payload on the first look, then only what moves.
      diff('REST.sessionInfo', si);
    }
    if (Array.isArray(standings)) {
      const mine =
        standings.find((c) => c.player) ||
        (ourNumber ? standings.find((c) => String(c.carNumber) === ourNumber) : null) ||
        null;
      const leader = standings.find((c) => c.position === 1) || null;
      if (mine) diff('REST.me', mine);
      if (leader) diff('REST.leader', leader);
      // Any per-car field that looks like a finish verdict, across the field.
      const flagsy = {};
      for (const c of standings) {
        for (const [k, v] of Object.entries(c)) {
          if (/finish|flag|status|complete|classif|result/i.test(k) && v !== 0 && v !== '' && v != null) {
            flagsy[`${c.position}:${k}`] = v;
          }
        }
      }
      diff('REST.finishish', flagsy);
    }
    if (gs) diff('REST.gameState', gs);
  }

  if (finishedAt && Date.now() - finishedAt > 90_000) {
    say('done', { log: LOG });
    process.exit(0);
  }
}

console.log(`[finish-probe] ${hz} Hz -> ${LOG}`);
console.log('[finish-probe] printing CHANGES only. Ctrl-C to stop.\n');
const timer = setInterval(() => {
  tick().catch((e) => say('error', { message: e.message }));
}, periodMs);
process.on('SIGINT', () => {
  clearInterval(timer);
  say('stopped', { log: LOG });
  process.exit(0);
});
