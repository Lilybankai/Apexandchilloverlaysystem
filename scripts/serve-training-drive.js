/**
 * Dev harness: DRIVE a recorded lap against a reference lap, live, for the
 * training widgets.
 *
 * `serve-fixture.js` pins one frame, which is right for a state but useless
 * for the training widgets: the Trace, the Telemetry, the Corner card and the
 * Lap strip are all built from what the car did over the last few hundred
 * metres, and a frozen frame has done nothing. This replays a whole lap as
 * "you" — position, pedals, speed, gear — at 60 Hz, and runs the real server
 * code over it to make `player.ghost`: `ghostFromTrace` for the reference,
 * `ghostGap` for the gap, `CornerTracker` for the corner state. What the
 * widgets get is what the sim would give them, minus the sim.
 *
 * Usage (build first — it reads dist/):
 *   node scripts/serve-training-drive.js [--you=<trace.json>] [--ref=<trace.json>]
 *        [--port=8199] [--start=<lap seconds>] [--label="A. Winters · 1:19.299 · board"]
 *   then open http://127.0.0.1:8199/training.html
 *
 * Defaults: you = scripts/fixtures/trace-road-atlanta-gt3.json, ref = the same
 * lap 2.5% quicker (so there is a gap, and it moves), track map =
 * ghost-road-brake.json's Road Atlanta. A trace file is either a lap-trace
 * file (`{ trace: {d, t, …}, lapMs, trackLengthM }`) or a cached Chase
 * reference from `training-refs/` (`{ payload: { data: {d, t, …} } }`).
 * `--start` begins the drive that far into the lap, so a screenshot taken a
 * few seconds after boot lands on the corner you want.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..', 'overlay');
const DIST = path.join(__dirname, '..', 'dist', 'telemetry');
const { ghostFromTrace, ghostGap, ghostJson } = require(path.join(DIST, 'ghostLap.js'));
const { CornerTracker } = require(path.join(DIST, 'cornerTracker.js'));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a, ''];
  }),
);
const port = Number(args.port || 8199);
const FIX = path.join(__dirname, 'fixtures');

/** A lap-trace file or a cached Chase reference, as `ghostFromTrace` takes it. */
function loadTrace(file, trackLengthM) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.trace) return raw;
  const data = raw.payload && raw.payload.data;
  if (!data || !data.d) throw new Error(`${file}: not a lap trace`);
  return {
    trace: data,
    lapId: raw.key || path.basename(file),
    lapMs: raw.payload.lapMs,
    trackLengthM,
  };
}

const youFile = loadTrace(args.you || path.join(FIX, 'trace-road-atlanta-gt3.json'));
const L = youFile.trackLengthM;
let refFile;
if (args.ref) {
  refFile = loadTrace(args.ref, L);
} else {
  // The same lap, 2.5% quicker everywhere: a reference with a real gap.
  const k = 0.975;
  refFile = { ...youFile, lapId: 'drive-ref', lapMs: youFile.lapMs * k,
    trace: { ...youFile.trace, t: youFile.trace.t.map((v) => v * k), lapSec: youFile.trace.lapSec * k } };
}
const lapSecOf = (f) => f.trace.lapSec || f.lapMs / 1000;
const label = args.label || `Reference · ${fmtLap(lapSecOf(refFile))} · board`;
const ghost = ghostFromTrace(refFile, label);
if (!ghost) throw new Error('reference lap would not load');
const ghostBody = JSON.stringify(ghostJson(ghost));
const trackmap = JSON.parse(fs.readFileSync(path.join(FIX, 'ghost-road-brake.json'), 'utf8'))._trackmap;

function fmtLap(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(3).padStart(6, '0')}`;
}

/* ------------------------------ the drive -------------------------------- */

const Y = youFile.trace;
const YOU_LAP = lapSecOf(youFile);

/** Index of the last sample at or before lap time `t` (binary search). */
function idxAt(t) {
  let lo = 0, hi = Y.t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Y.t[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function at(col, i, f) {
  const c = Y[col];
  if (!c) return 0;
  const b = Math.min(i + 1, c.length - 1);
  return c[i] + (c[b] - c[i]) * f;
}

const corners = new CornerTracker();
const startAt = Number(args.start || 0);
const t0 = Date.now() - startAt * 1000;
let lapsDone = 0;
let lastLapT = 0;

function frame() {
  const now = Date.now();
  const total = (now - t0) / 1000;
  const t = total % YOU_LAP;
  if (t < lastLapT) lapsDone++;
  lastLapT = t;
  const i = idxAt(t);
  const span = Y.t[Math.min(i + 1, Y.t.length - 1)] - Y.t[i];
  const f = span > 0 ? Math.min(1, (t - Y.t[i]) / span) : 0;
  const d = at('d', i, f);
  const x = at('x', i, f), z = at('z', i, f);
  const j = Math.min(i + 2, Y.d.length - 1);
  const heading = (Math.atan2(Y.x[j] - Y.x[Math.max(0, i - 1)], Y.z[j] - Y.z[Math.max(0, i - 1)]) * 180) / Math.PI;
  const thr = at('throttle', i, f), brk = at('brake', i, f), steer = at('steer', i, f);
  const kph = at('speedKph', i, f);
  const gear = Y.gear ? Y.gear[i] : 4;

  const g = ghostGap(ghost, t, d);
  if (g) {
    const c = corners.update(ghost, d, g.active ? g.gapSec : NaN, brk, kph);
    if (c) g.corner = c;
    g.atD = d;
  }
  return {
    schemaVersion: 1,
    source: 'lmu',
    timestamp: now,
    connected: true,
    session: { type: 'practice', phase: 'green', flag: 'green', track: trackmap.name, numCars: 1 },
    player: {
      slotId: 1, position: 1, finished: false,
      pedals: { throttle: thr, brake: brk, clutch: 0, steer, tc: 0, abs: 0, steerRangeDeg: 540 },
      gear, speedKph: Math.round(kph), rpm: 7000, maxRpm: 8500,
      lap: { current: t, last: lapsDone ? YOU_LAP : -1, best: lapsDone ? YOU_LAP : -1, delta: -1, sector: -1 },
      motion: { heading, pitch: 0, roll: 0, yawRate: 0, slipAngle: 0, speedMs: kph / 3.6, latG: 0, lonG: 0, vertG: 1 },
      ...(g ? { ghost: g } : {}),
    },
    standings: [{ slotId: 1, position: 1, isPlayer: true, lapFraction: d, sector: d < 0.33 ? 1 : d < 0.66 ? 2 : 0 }],
    relative: [],
    trackMap: { key: trackmap.key, revision: trackmap.revision, ready: true, progress: 1, cars: [{ slotId: 1, isPlayer: true, inPit: false, x, y: 0, z, lapFraction: d }] },
  };
}

/* ------------------------------ the server ------------------------------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
    res.end(body);
  };
  if (rel === '/ghost.json') return json(ghostBody);
  if (rel === '/trackmap.json') return json(JSON.stringify(trackmap));
  const file = path.join(ROOT, rel === '/' ? 'training.html' : rel);
  if (!path.resolve(file).startsWith(path.resolve(ROOT) + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
setInterval(() => {
  if (wss.clients.size === 0) return;
  const payload = JSON.stringify(frame());
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}, 1000 / 60).unref?.();

server.listen(port, '127.0.0.1', () => {
  console.log(`[drive] you ${fmtLap(YOU_LAP)} vs ${label} -> http://127.0.0.1:${port}/training.html`);
});
