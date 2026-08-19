/**
 * scripts/record-session.js — capture a real session for the trigger tuner.
 * -----------------------------------------------------------------------------
 * Phase 0 of the race-engineer feature says: tune the triggers against real races
 * before spending a token. That needs real races on disk, and nothing in this
 * repo wrote any — the overlay has always been a live-only pipe.
 *
 * So: attach to a running overlay server exactly as a widget does, and write what
 * comes down the socket to a JSONL file that `scripts/test-triggers.js --replay`
 * can walk. No hooks in the server, no cost to the loop, nothing to remember to
 * turn off — the recorder is a client, and closing it is all it takes to stop.
 *
 *   node scripts/record-session.js                       # ./recordings/<stamp>.jsonl
 *   node scripts/record-session.js my-race.jsonl
 *   node scripts/record-session.js --url ws://127.0.0.1:17080/ws --hz 4 --full
 *
 * Ctrl-C to stop. The file is flushed as it goes, so a recording survives the
 * session crashing, the sim hanging, or the PC being turned off at the wall.
 *
 * ## What it keeps, and why not everything
 * A 30 Hz race hour is ~100k frames of several kilobytes each, most of it the
 * standings, the radar and the track map — none of which the trigger layer reads.
 * So by default frames are **decimated to 4 Hz and trimmed** to the blocks
 * `telemetry/triggers.ts` actually looks at, which turns a gigabyte into tens of
 * megabytes and makes the recording something you can keep a season of.
 *
 * 4 Hz is well inside the debounce: the coalesce window is 1.5 s and the shortest
 * cooldown is 20 s, so nothing this layer can decide is decided in less than a
 * quarter of a second. `--full` keeps whole frames at the broadcast rate for when
 * a recording is wanted for something other than triggers — be aware of the size.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

/* ---- arguments ----------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const url = flag('--url', 'ws://127.0.0.1:17080/ws');
const hz = Number(flag('--hz', 4));
const full = has('--full');
const stopAfterSec = Number(flag('--seconds', 0));

// The first bare argument is the output file; everything else is a flag or its
// value.
const positional = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return !(prev && prev.startsWith('--') && prev !== '--full');
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.resolve(positional[0] || path.join('recordings', `session-${stamp}.jsonl`));
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const intervalMs = hz > 0 ? Math.round(1000 / hz) : 0;

/* ---- trimming ------------------------------------------------------------ */

/**
 * Everything `telemetry/triggers.ts` AND `telemetry/engineerCommands.ts` read,
 * and nothing else.
 *
 * Deliberately explicit rather than a deny-list of the big blocks: when the
 * detector learns to read a new channel, this list is the one place that has to
 * be told, and a recording made before that day will simply not carry it — which
 * is honest. A deny-list would silently keep working and quietly drop the new
 * field the day someone renamed a widget's block.
 *
 * The standings keep every row but only the columns the two engineer layers
 * read (gap chains, lap times, class identity) — the driver-rating badges,
 * energy fractions and pit state that make the block heavy stay behind. Same
 * treatment for `relative`, which the commands layer uses as its on-track gap
 * fallback. Recordings made before 2026-08-18 carry only the player's own
 * standings row, so `test-commands.js --replay` on one of those answers the
 * gap questions with "no data" — honest, per the rule above.
 */
function trim(frame) {
  const player = frame.player || {};
  const out = {
    schemaVersion: frame.schemaVersion,
    source: frame.source,
    timestamp: frame.timestamp,
    connected: frame.connected,
    session: frame.session,
    player: {
      slotId: player.slotId,
      position: player.position,
    },
    fuel: frame.fuel,
  };
  if (player.damage) out.player.damage = player.damage;
  if (player.trackLimits) out.player.trackLimits = player.trackLimits;
  if (player.lap) out.player.lap = player.lap;
  // The Track-A ask-set reads these (tyres, pit, hybrid, pace) and the
  // readouts' busy-hold reads the brake — kept slim so an hour of race stays
  // tens of MB, but kept: a recording that can't replay every intent can't
  // tune the engineer (the 2026-08-19 recording refused half the new asks).
  if (player.pit) {
    out.player.pit = { phase: player.pit.phase, plannedSec: player.pit.plannedSec };
  }
  if (player.tyres) {
    const corner = (c) =>
      c && {
        tempC: c.tempC,
        coreC: c.coreC,
        optimalTempC: c.optimalTempC,
        wear: c.wear,
        pressureKpa: c.pressureKpa,
        compound: c.compound,
      };
    out.player.tyres = {
      frontLeft: corner(player.tyres.frontLeft),
      frontRight: corner(player.tyres.frontRight),
      rearLeft: corner(player.tyres.rearLeft),
      rearRight: corner(player.tyres.rearRight),
    };
  }
  if (player.hybrid) out.player.hybrid = player.hybrid;
  if (player.paceScore) out.player.paceScore = player.paceScore;
  if (player.paceDeltas) {
    out.player.paceDeltas = { predictedLapSec: player.paceDeltas.predictedLapSec };
  }
  if (player.pedals) out.player.pedals = { brake: player.pedals.brake };

  if (frame.weather) {
    out.weather = {
      trackTempC: frame.weather.trackTempC,
      ambientTempC: frame.weather.ambientTempC,
      rainIntensity: frame.weather.rainIntensity,
      trackWetness: frame.weather.trackWetness,
      trackTrend: frame.weather.trackTrend,
      forecast: (frame.weather.forecast || []).map((slot) => ({
        minutesAhead: slot.minutesAhead,
        rainChance: slot.rainChance,
        trackTempC: slot.trackTempC,
        sky: slot.sky,
      })),
    };
  }
  if (frame.mfd && Array.isArray(frame.mfd.aids)) {
    out.mfd = {
      pit: [],
      aids: frame.mfd.aids.map((a) => ({ key: a.key, label: a.label, value: a.value, text: a.text })),
    };
  }

  out.standings = (frame.standings || []).map((s) => ({
    slotId: s.slotId,
    position: s.position,
    driverName: s.driverName,
    carNumber: s.carNumber,
    carClass: s.carClass,
    classPosition: s.classPosition,
    gapToClassLeaderSec: s.gapToClassLeaderSec,
    classLapsBehind: s.classLapsBehind,
    gapToLeaderSec: s.gapToLeaderSec,
    bestLapSec: s.bestLapSec,
    lastLapSec: s.lastLapSec,
    lapsCompleted: s.lapsCompleted,
    gridPosition: s.gridPosition,
    inPit: s.inPit,
    pitStops: s.pitStops,
    isPlayer: s.isPlayer,
  }));
  out.relative = (frame.relative || []).map((r) => ({
    slotId: r.slotId,
    position: r.position,
    driverName: r.driverName,
    carClass: r.carClass,
    relativeGapSec: r.relativeGapSec,
    lapsDifference: r.lapsDifference,
    isFasterClass: r.isFasterClass,
    yieldTo: r.yieldTo,
    trafficAhead: r.trafficAhead,
    closingRateSec: r.closingRateSec,
    inPit: r.inPit,
    isPlayer: r.isPlayer,
  }));
  return out;
}

/* ---- recording ----------------------------------------------------------- */

const stream = fs.createWriteStream(outPath, { flags: 'a' });
stream.on('error', (err) => {
  // An unwritable path is the one failure worth stopping for: a recorder that
  // stays connected while dropping every frame looks exactly like a working one.
  console.error(`\n[record] cannot write ${outPath}: ${err.message}`);
  process.exit(1);
});
let written = 0;
let seen = 0;
let lastWriteMs = 0;
let firstStamp = 0;
let lastStamp = 0;
let reconnects = 0;

console.log(`[record] → ${outPath}`);
console.log(`[record] ${url} · ${full ? 'full frames at the broadcast rate' : `${hz} Hz, trimmed to the trigger channels`}`);
console.log('[record] Ctrl-C to stop.\n');

let socket = null;
let closing = false;

function connect() {
  socket = new WebSocket(url);

  socket.on('open', () => {
    console.log(`[record] connected${reconnects ? ` (reconnect #${reconnects})` : ''}`);
  });

  socket.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;                                   // 'pong' and anything else non-JSON
    }
    if (!frame || !frame.session || !frame.timestamp) return;

    seen++;
    // Decimate on the FRAME's clock, not ours: a recording should sample the
    // race evenly even if this process is descheduled behind the sim.
    if (!full && intervalMs && frame.timestamp - lastWriteMs < intervalMs) return;
    lastWriteMs = frame.timestamp;

    if (!firstStamp) firstStamp = frame.timestamp;
    lastStamp = frame.timestamp;

    stream.write(`${JSON.stringify(full ? frame : trim(frame))}\n`);
    written++;
    if (written % 200 === 0) {
      const mins = ((lastStamp - firstStamp) / 60000).toFixed(1);
      process.stdout.write(`\r[record] ${written} frames · ${mins} min of session   `);
    }
  });

  socket.on('close', () => {
    if (closing) return;
    // The overlay server restarting mid-session is normal (the desktop app
    // restarts it when settings change). Keep the file open and wait for it.
    reconnects++;
    console.log('\n[record] connection lost — retrying in 2 s');
    setTimeout(connect, 2000);
  });

  socket.on('error', (err) => {
    if (closing) return;
    console.log(`\n[record] ${err.message}`);
  });
}

function finish() {
  if (closing) return;
  closing = true;
  try {
    socket?.close();
  } catch {
    /* already gone */
  }
  stream.end(() => {
    const mins = firstStamp ? ((lastStamp - firstStamp) / 60000).toFixed(1) : '0';
    const mb = (fs.statSync(outPath).size / 1048576).toFixed(1);
    console.log(`\n[record] ${written} frames written (${seen} seen) · ${mins} min · ${mb} MB`);
    console.log(`[record] ${outPath}`);
    console.log(`\nNow read what the engineer would have said:\n  node scripts/test-triggers.js --replay ${path.relative(process.cwd(), outPath)}\n`);
    process.exit(0);
  });
}

process.on('SIGINT', finish);
process.on('SIGTERM', finish);
if (stopAfterSec > 0) setTimeout(finish, stopAfterSec * 1000);

connect();
