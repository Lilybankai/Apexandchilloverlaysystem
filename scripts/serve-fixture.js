/**
 * Dev harness: serve the real `overlay/` assets and broadcast a **fixed
 * telemetry frame** instead of a live provider.
 *
 * Some widget states are rare in the simulator and impossible to arrange on
 * demand in the sim — a blue flag needs a faster-class car within three seconds
 * and closing, heavy damage needs a crash. Waiting for those to occur is not a
 * test. This serves a frame you control, so a state can be pinned and looked at.
 *
 * Usage:
 *   node scripts/serve-fixture.js <fixture.json> [port]
 *   then open http://127.0.0.1:<port>/ingame.html?widgets=relative
 *
 * The fixture is re-read from disk on every broadcast, so editing the JSON
 * updates the page live without restarting. It is deep-merged over a baseline
 * frame, so a fixture only needs the fields it cares about.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..', 'overlay');
const fixturePath = process.argv[2];
const port = Number(process.argv[3] || 8199);

if (!fixturePath) {
  console.error('usage: node scripts/serve-fixture.js <fixture.json> [port]');
  process.exit(1);
}

/** Minimum viable frame, so a fixture only declares what it exercises. */
function baseline() {
  return {
    schemaVersion: 1,
    source: 'simulator',
    timestamp: Date.now(),
    connected: true,
    session: {
      type: 'race', phase: 'green', flag: 'green', track: 'Fixture',
      timeRemainingSec: -1, totalLaps: 16, lapsRemaining: -1, currentLap: 8, numCars: 0,
    },
    player: {
      slotId: 1, position: 1, gear: 4, speedKph: 180, rpm: 7000, maxRpm: 9000,
      pedals: { throttle: 0.8, brake: 0, clutch: 0, steer: 0 },
      lap: { current: 42.1, last: 118.4, best: 117.9, delta: -1, sector: -1 },
      tyres: {
        frontLeft: { tempC: 90, wear: 1 }, frontRight: { tempC: 90, wear: 1 },
        rearLeft: { tempC: 92, wear: 1 }, rearRight: { tempC: 92, wear: 1 },
      },
    },
    standings: [], relative: [],
    weather: { trackTempC: 30, ambientTempC: 22, rainIntensity: 0, trackWetness: 0, forecast: [] },
    fuel: {
      levelLiters: 62, capacityLiters: 80, perLapAvgLiters: 2.6, lapsRemaining: 24,
      lapsToFinish: 8, fuelToFinishLiters: 21, fuelDeltaLiters: 41, refuelToFinishLiters: 0,
    },
  };
}

/** Recursive merge; arrays and primitives from `patch` replace wholesale. */
function merge(base, patch) {
  if (Array.isArray(patch) || patch === null || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v)
      : v;
  }
  return out;
}

/**
 * Keys a fixture may carry that are NOT part of the frame.
 *
 * Some widgets read a second source over HTTP rather than off the wire — the
 * circuit at `/trackmap.json`, the ghost's line at `/ghost.json` — because
 * those are hundreds of points that change rarely and would otherwise repeat
 * thirty times a second. A fixture that cannot supply them can only pin half
 * of such a widget's state, so it can carry them under these keys and they are
 * served alongside instead of being broadcast.
 */
const SIDECARS = { _trackmap: '/trackmap.json', _ghost: '/ghost.json' };

function readFixture() {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function frame() {
  const patch = readFixture();
  for (const k of Object.keys(SIDECARS)) delete patch[k];
  const f = merge(baseline(), patch);
  f.timestamp = Date.now();
  return f;
}

/** The sidecar for this path, or `undefined` when the fixture has none. */
function sidecar(rel) {
  const key = Object.keys(SIDECARS).find((k) => SIDECARS[k] === rel);
  if (!key) return undefined;
  try {
    const v = readFixture()[key];
    return v === undefined ? null : v;   // null => answer 204, like the real route
  } catch {
    return null;
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);

  // Re-read per request, like the frame, so editing the JSON retunes the page
  // without a restart.
  const side = sidecar(rel);
  if (side !== undefined) {
    if (side === null) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const body = JSON.stringify(side);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  // Same path-traversal guard as the real static server.
  if (!path.resolve(file).startsWith(path.resolve(ROOT) + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
setInterval(() => {
  let payload;
  try {
    payload = JSON.stringify(frame());
  } catch (err) {
    console.error('[fixture] bad JSON:', err.message);
    return;
  }
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}, 100).unref?.();

server.listen(port, '127.0.0.1', () => {
  console.log(`[fixture] ${fixturePath} -> http://127.0.0.1:${port}/`);
  console.log(`[fixture] try http://127.0.0.1:${port}/ingame.html?widgets=relative,standings`);
});
