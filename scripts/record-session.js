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
 * Everything `telemetry/triggers.ts` reads, and nothing else.
 *
 * Deliberately explicit rather than a deny-list of the big blocks: when the
 * detector learns to read a new channel, this list is the one place that has to
 * be told, and a recording made before that day will simply not carry it — which
 * is honest. A deny-list would silently keep working and quietly drop the new
 * field the day someone renamed a widget's block.
 *
 * The standings are reduced to the player's own row, which is the only one the
 * cue context uses (for class position). That alone is most of the saving.
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

  const me = (frame.standings || []).find((s) => s.isPlayer);
  out.standings = me ? [me] : [];
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
