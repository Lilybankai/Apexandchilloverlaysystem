/**
 * scripts/probe-race-start.js — capture EVERYTHING around a race start, flags
 * and track-limit events, from every live source at once.
 * -----------------------------------------------------------------------------
 * The overlay currently has no "turn your limiter on", no green-flag countdown,
 * no live yellow, and penalties that only refresh at lap end. The game clearly
 * knows all of these — this probe records every candidate channel with tight
 * timestamps so one AI race with deliberate track cuts pins where each signal
 * lives:
 *
 *   • REST curated read-only endpoints, diff-logged (sessionInfo/gamePhase,
 *     standings flags, GetGameState, getAllowedToStartRacing, incidents, hud)
 *   • MMF  $rFactor2SMMP_Scoring$ header — byte-level diff scan with a noise
 *     filter, so the start-light / gamePhase / yellow-flag bytes reveal their
 *     own offsets when the lights come on
 *   • MMF  Scoring player record (584 B), Rules + Extended buffers — same scan
 *   • MMF  Telemetry player record (1888 B) — raw snapshots at 5 Hz for the
 *     first 20 min so the pit-limiter byte can be found offline by diffing
 *     around the moments the limiter was toggled
 *
 * Nothing here writes to the game: action-shaped endpoints (startRace, drive,
 * forcePlayerVehAiPit, …) are deliberately never touched.
 *
 * Usage, with LMU running (start it BEFORE leaving the garage):
 *   node scripts/probe-race-start.js
 * Output: ~/.apex-overlay/race-probe-<stamp>.jsonl  (+ telemetry-<stamp>.bin)
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PORT = 6397;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUTDIR = path.join(os.homedir(), '.apex-overlay');
const LOG = path.join(OUTDIR, `race-probe-${stamp}.jsonl`);
const TELBIN = path.join(OUTDIR, `race-probe-telemetry-${stamp}.bin`);
fs.mkdirSync(OUTDIR, { recursive: true });

const t0 = Date.now();
function record(obj) {
  const line = JSON.stringify({ t: +((Date.now() - t0) / 1000).toFixed(3), at: new Date().toISOString(), ...obj });
  fs.appendFileSync(LOG, line + '\n', 'utf8');
  return line;
}
function say(obj) {
  console.log(record(obj));
}

/* -------------------------------- REST ------------------------------------ */

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port: PORT, path: p, timeout: 4000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(res.statusCode === 200 ? d : null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Endpoints polled on a timer; each logs only when its (reduced) value changes. */
const restWatch = [
  // The start sequence lives here if anywhere: gamePhase, numRedLights, startLight?
  { p: '/rest/watch/sessionInfo', ms: 200, key: 'sessionInfo' },
  // Whole payload minus the constantly-moving numbers, so phase/flag changes stand out.
  { p: '/rest/sessions/GetGameState', ms: 300, key: 'gameState' },
  { p: '/rest/race/getAllowedToStartRacing', ms: 300, key: 'allowedToStart' },
  { p: '/rest/watch/getIncidentsList/0', ms: 1000, key: 'incidents' },
  { p: '/rest/hud', ms: 1000, key: 'hud' },
  { p: '/rest/sessions/?', ms: 15000, key: 'sessions' },
  { p: '/rest/sessions/settings', ms: 30000, key: 'sessionSettings' },
  { p: '/rest/garage/getVehicleCondition', ms: 2000, key: 'vehicleCondition' },
  { p: '/rest/strategy/overall', ms: 5000, key: 'strategyOverall' },
  { p: '/rest/sessions/restartStintAvailable', ms: 5000, key: 'restartStint' },
  { p: '/rest/multiplayer/join/state', ms: 5000, key: 'mpJoinState' },
];

/** Fields that change every poll and would bury real events. */
const NOISY_KEYS = new Set([
  'currentEventTime', 'ambientTemp', 'trackTemp', 'trackWetness', 'averagePathWetness',
  'minPathWetness', 'maxPathWetness', 'darkCloud', 'raining', 'timeIntoLap',
  'estimatedLapTime', 'lapDistance', 'carVelocity', 'steamTicket', 'time',
  'timeOfDay', 'closeestWeatherNode', 'windSpeed', 'raceCompletion',
]);
function reduce(v, depth) {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => reduce(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (NOISY_KEYS.has(k)) continue;
    out[k] = reduce(val, depth + 1);
  }
  return out;
}

const restLast = new Map();
async function pollRest(w) {
  const raw = await get(w.p);
  if (raw === null) {
    if (restLast.get(w.key) !== '404') {
      restLast.set(w.key, '404');
      say({ src: 'rest', key: w.key, gone: true });
    }
    return;
  }
  let v;
  try { v = JSON.parse(raw); } catch { v = raw.slice(0, 2000); }
  const red = reduce(v, 0);
  const sig = JSON.stringify(red);
  if (sig !== restLast.get(w.key)) {
    restLast.set(w.key, sig);
    say({ src: 'rest', key: w.key, value: red });
  }
}

/* Standings gets bespoke handling: per-car flag summary + full player row. */
let lastStand = '';
async function pollStandings() {
  const raw = await get('/rest/watch/standings');
  if (!raw) return;
  let cars;
  try { cars = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(cars) || !cars.length) return;
  const me = cars.find((c) => c.player) || null;
  const flags = {};
  for (const c of cars) {
    const f = `${c.flag ?? '?'}|${c.gamePhase ?? '?'}`;
    flags[f] = (flags[f] || 0) + 1;
  }
  const view = {
    flags,
    me: me && {
      flag: me.flag, gamePhase: me.gamePhase, penalties: me.penalties,
      countLapFlag: me.countLapFlag, finishStatus: me.finishStatus,
      pitState: me.pitState, pitting: me.pitting, inGarageStall: me.inGarageStall,
      lapsCompleted: me.lapsCompleted, underYellow: me.underYellow,
      pathLateral: typeof me.pathLateral === 'number' ? +me.pathLateral.toFixed(2) : me.pathLateral,
      trackEdge: typeof me.trackEdge === 'number' ? +me.trackEdge.toFixed(2) : me.trackEdge,
      lapDistance: typeof me.lapDistance === 'number' ? Math.round(me.lapDistance) : me.lapDistance,
    },
  };
  const sig = JSON.stringify(view);
  if (sig !== lastStand) {
    lastStand = sig;
    say({ src: 'rest', key: 'standings', value: view });
  }
}

/* ----------------------------- shared memory ------------------------------- */

let mapView = null;
try {
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
  const MapViewOfFile = k32.func('void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)');
  const UnmapViewOfFile = k32.func('bool __stdcall UnmapViewOfFile(void*)');
  const CloseHandle = k32.func('bool __stdcall CloseHandle(void*)');
  const VirtualQuery = k32.func('size_t __stdcall VirtualQuery(void*, void*, size_t)');
  mapView = (name, cap) => {
    const h = OpenFileMappingW(0x0004, false, `$rFactor2SMMP_${name}$`);
    if (!h) return null;
    const view = MapViewOfFile(h, 0x0004, 0, 0, 0);
    if (!view) { CloseHandle(h); return null; }
    const mbi = Buffer.alloc(48);
    VirtualQuery(view, mbi, 48);
    const size = Math.min(Number(mbi.readBigUInt64LE(24)), cap || 1 << 20);
    const buf = Buffer.from(koffi.decode(view, 0, koffi.array('uint8', size)));
    UnmapViewOfFile(view);
    CloseHandle(h);
    return buf;
  };
} catch {
  say({ src: 'probe', note: 'koffi unavailable — REST only' });
}

/* Which buffers exist at all, once. */
const MMF_NAMES = ['Telemetry', 'Scoring', 'Rules', 'MultiRules', 'Extended', 'PitInfo',
  'Weather', 'ForceFeedback', 'Graphics', 'PluginControl', 'LSI', 'Hardware'];
if (mapView) {
  const found = {};
  for (const n of MMF_NAMES) {
    const b = mapView(n, 1 << 20);
    if (b) found[n] = b.length;
  }
  say({ src: 'mmf', key: 'census', value: found });
}

/**
 * Byte-diff scanner with a learned noise filter. Bytes that change more than
 * NOISE_MAX times inside the warm-up are physics/clock bytes; they get muted
 * (listed once) and every remaining change is logged with offset + context, so
 * an event like the start lights identifies its own offset.
 */
function makeScanner(label, region) {
  return {
    label, region,
    prev: null,
    changes: null, // per-byte change count during warm-up
    warmupUntil: Date.now() + 12_000,
    muted: null,
    scan(buf) {
      const [off, len] = this.region;
      const slice = buf.slice(off, Math.min(off + len, buf.length));
      if (!this.prev) {
        this.prev = Buffer.from(slice);
        this.changes = new Uint16Array(slice.length);
        say({ src: 'mmf', key: this.label, note: 'first snapshot', bytes: slice.length });
        return;
      }
      const now = Date.now();
      const diffs = [];
      const n = Math.min(slice.length, this.prev.length);
      for (let i = 0; i < n; i++) {
        if (slice[i] !== this.prev[i]) {
          if (this.muted) {
            if (!this.muted.has(i)) diffs.push(i);
          } else {
            this.changes[i]++;
          }
        }
      }
      if (!this.muted && now >= this.warmupUntil) {
        this.muted = new Set();
        for (let i = 0; i < this.changes.length; i++) if (this.changes[i] > 6) this.muted.add(i);
        say({
          src: 'mmf', key: this.label, note: 'noise filter armed',
          mutedBytes: this.muted.size,
          mutedRanges: rangesOf([...this.muted]),
        });
      }
      if (this.muted && diffs.length && diffs.length < 400) {
        // Group adjacent offsets and decode each group a few plausible ways.
        const groups = [];
        let g = null;
        for (const i of diffs) {
          if (g && i <= g.end + 4) g.end = i;
          else { g = { start: i, end: i }; groups.push(g); }
        }
        for (const grp of groups) {
          const a = Math.max(0, grp.start - 4);
          const b = Math.min(n, grp.end + 8);
          say({
            src: 'mmf', key: this.label, off: this.region[0] + grp.start,
            oldHex: this.prev.slice(a, b).toString('hex'),
            newHex: slice.slice(a, b).toString('hex'),
            asU8: slice[grp.start],
            asI32: grp.start + 4 <= n ? slice.readInt32LE(grp.start) : null,
            asF64: grp.start + 8 <= n ? +slice.readDoubleLE(grp.start).toPrecision(6) : null,
          });
        }
      }
      slice.copy(this.prev, 0, 0, n);
    },
  };
}
function rangesOf(sorted) {
  const out = [];
  let s = null, e = null;
  for (const i of sorted.sort((a, b) => a - b)) {
    if (s === null) { s = e = i; continue; }
    if (i === e + 1) { e = i; continue; }
    out.push(s === e ? `${s}` : `${s}-${e}`);
    s = e = i;
  }
  if (s !== null) out.push(s === e ? `${s}` : `${s}-${e}`);
  return out.slice(0, 80);
}

const scanners = [];
if (mapView) {
  // Scoring header: version dwords 0..8, then ScoringInfo. Watch generously past
  // the known sizeof in case LMU appended fields.
  scanners.push({ name: 'Scoring', cap: 1 << 16, s: makeScanner('scoring-header', [0, 720]) });
  // Extended + Rules whole (they are quiet buffers — penalties probe saw no strings,
  // but numeric flags may still tick).
  scanners.push({ name: 'Extended', cap: 1 << 16, s: makeScanner('extended', [0, 1 << 15]) });
  scanners.push({ name: 'Rules', cap: 1 << 16, s: makeScanner('rules', [0, 1 << 15]) });
  scanners.push({ name: 'PitInfo', cap: 1 << 16, s: makeScanner('pitinfo', [0, 1 << 14]) });
}

/* Player scoring record: locate by mIsPlayer, then diff it too. */
const VS = { stride: 584, base: 12 + 548, mIsPlayer: 196 };
let playerScan = null;
function scanScoringPlayer(buf) {
  if (!playerScan) {
    for (let i = 0; i < 64; i++) {
      const o = VS.base + i * VS.stride;
      if (o + VS.stride > buf.length) break;
      if (buf[o + VS.mIsPlayer] === 1) {
        playerScan = makeScanner(`scoring-player@${o}`, [o, VS.stride]);
        say({ src: 'mmf', key: 'player-record', off: o, idx: i });
        break;
      }
    }
  }
  if (playerScan) playerScan.scan(buf);
}

function mmfTick() {
  if (!mapView) return;
  for (const { name, cap, s } of scanners) {
    const buf = mapView(name, cap);
    if (buf) {
      s.scan(buf);
      if (name === 'Scoring') scanScoringPlayer(buf);
    }
  }
}

/* Telemetry raw snapshots — the pit-limiter byte hunt. Find the player record
 * once via REST slotID, then append <f64 wallclock><1888 B record> at 5 Hz. */
const TEL = { base: 16, stride: 1888, mID: 0 };
let telSlot = null;
let telIdx = null;
let telStream = null;
let telUntil = Date.now() + 20 * 60_000;
async function telTick() {
  if (!mapView || Date.now() > telUntil) return;
  const buf = mapView('Telemetry', 1 << 20);
  if (!buf) return;
  if (telSlot === null) {
    const raw = await get('/rest/watch/standings');
    if (!raw) return;
    try {
      const me = JSON.parse(raw).find((c) => c.player);
      if (me) telSlot = me.slotID;
    } catch { return; }
    if (telSlot === null) return;
    say({ src: 'telemetry', note: 'player slot', slotID: telSlot });
  }
  if (telIdx === null || buf.readInt32LE(TEL.base + telIdx * TEL.stride + TEL.mID) !== telSlot) {
    telIdx = null;
    const max = Math.floor((buf.length - TEL.base) / TEL.stride);
    for (let i = 0; i < max; i++) {
      if (buf.readInt32LE(TEL.base + i * TEL.stride + TEL.mID) === telSlot) { telIdx = i; break; }
    }
    if (telIdx === null) return;
    say({ src: 'telemetry', note: 'player record index', idx: telIdx });
  }
  if (!telStream) telStream = fs.createWriteStream(TELBIN);
  const head = Buffer.alloc(8);
  head.writeDoubleLE(Date.now(), 0);
  telStream.write(head);
  telStream.write(buf.slice(TEL.base + telIdx * TEL.stride, TEL.base + (telIdx + 1) * TEL.stride));
}

/* --------------------------------- run ------------------------------------- */

say({ src: 'probe', note: 'race-start probe up', log: LOG, telemetryBin: TELBIN });
for (const w of restWatch) {
  void pollRest(w);
  setInterval(() => void pollRest(w), w.ms);
}
void pollStandings();
setInterval(() => void pollStandings(), 250);
setInterval(mmfTick, 100);
setInterval(() => void telTick(), 200);
