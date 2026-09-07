/**
 * scripts/make-web-demo.js — a canned race for the web pit wall.
 * -----------------------------------------------------------------------------
 * The web board has no sim behind it and no relay until a driver is actually
 * on track, which makes "what does it look like" a question that needs a race.
 * This runs the desktop's own demo provider for a chunk of simulated race,
 * feeds every second of it through the same race memory the desktop keeps
 * (electron/team-history.js), prunes the final frame with the same snapshot
 * builder (electron/team-snapshot.js), and writes the three blocks the relay
 * would carry to web/dev/demo.json:
 *
 *   { snapshot, history, mapShape }
 *
 * board.html?demo=1 loads that file instead of the network. Build first
 * (`npm run build`) — the provider is read from dist/.
 *
 *   node scripts/make-web-demo.js [minutes]      # default 26
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { SimulatorProvider } = require(path.join(ROOT, 'dist', 'telemetry', 'simulatorProvider.js'));
const { getPublishedTrackMap } = require(path.join(ROOT, 'dist', 'telemetry', 'trackMap.js'));
const { buildTeamSnapshot } = require(path.join(ROOT, 'electron', 'team-snapshot.js'));
const { TeamHistory, tyreProjection } = require(path.join(ROOT, 'electron', 'team-history.js'));

const minutes = Number(process.argv[2] || 26);
const STEP_MS = 100; // 10 Hz is plenty: the history samples at 1 Hz anyway

const provider = new SimulatorProvider();
provider.start();
const history = new TeamHistory();

let t = 1_000_000;
let frame = null;
const steps = Math.round((minutes * 60 * 1000) / STEP_MS);
for (let i = 0; i < steps; i++) {
  t += STEP_MS;
  frame = provider.poll(t, STEP_MS);
  if (i % 10 === 0) {
    // The demo provider marks its frames connected:false so a demo can never
    // pollute a real race's memory. This IS the fixture, so let it through.
    history.update({ ...frame, connected: true });
  }
}

const snapshot = buildTeamSnapshot({ ...frame, connected: true }, Date.now());
if (!snapshot) throw new Error('make-web-demo: the provider produced no usable frame');
snapshot.tyrePlan = tyreProjection(history.wear);
snapshot.historyRevision = history.revision;
snapshot.v = 1;

const map = getPublishedTrackMap();
let mapShape = null;
if (map && Array.isArray(map.points)) {
  const step = Math.max(1, Math.ceil(map.points.length / 400));
  mapShape = {
    key: map.key,
    revision: map.revision,
    lengthM: map.lengthM,
    points: map.points.filter((_, i) => i % step === 0).map((p) => [p[0], p[1]]),
  };
}

const out = path.join(ROOT, 'web', 'dev', 'demo.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ snapshot, history: history.state(), mapShape }));

const cars = history.state().cars;
const laps = cars.reduce((m, c) => Math.max(m, c.laps.length), 0);
console.log(
  `make-web-demo: ${minutes} min of race → ${path.relative(ROOT, out)} ` +
    `(${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${cars.length} cars, ${laps} laps recorded, ` +
    `map ${mapShape ? mapShape.points.length + ' pts' : 'none'})`,
);
