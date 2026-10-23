/**
 * scripts/probe-lmu-field-penalties.js — penalties for the WHOLE field, live.
 * -----------------------------------------------------------------------------
 * The standings tower badges every car that owes a penalty. Two things about
 * that are not yet observed in a LIVE session, and this probe settles both:
 *
 *   1. REST `/rest/watch/standings` `penalties` on RIVAL rows. Verified live on
 *      our own row only (2026-08-04). LMU's own broadcast overlay reads it on
 *      every row, so it is expected to move for everyone — confirm it.
 *   2. LiveStandings (`ws://127.0.0.1:6398/websocket/ui`, topic LiveStandings)
 *      `penalties: { DT, SG, TIME }` per car — the only place LMU names a
 *      RIVAL's penalty kind (its in-game timing screen shows "DT"/"SG" from it).
 *      Captured so far only in a replay, where every value was 0. Does it move
 *      live, are DT/SG counts or flags, does TIME count seconds, and does DT+SG
 *      track REST's count? If yes, the live provider can subscribe to it (today
 *      only the replay path opens that socket) and the tower can name the kind
 *      for every car, not just ours.
 *
 * Read-only: one REST GET a second and one websocket subscription. Run it with
 * LMU in a session (an online race is best — AI rarely collects penalties) and
 * leave it running; it prints one line per change and appends the raw rows to
 * `~/.apex-overlay/field-penalties-probe-<time>.jsonl`.
 *
 *   node scripts/probe-lmu-field-penalties.js [restPort]   (default 6397)
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');

const PORT = Number(process.argv[2] || 6397);
const WS_URL = `ws://127.0.0.1:${PORT + 1}/websocket/ui`;
const dir = path.join(os.homedir(), '.apex-overlay');
fs.mkdirSync(dir, { recursive: true });
const LOG = path.join(dir, `field-penalties-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const write = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');

/** slot → last REST count / last LiveStandings object, to print changes only. */
const restSeen = new Map();
const wsSeen = new Map();

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, (res) => {
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
    req.on('timeout', () => req.destroy());
  });
}

async function pollRest() {
  const rows = await get('/rest/watch/standings');
  if (!Array.isArray(rows)) return;
  for (const r of rows) {
    const prev = restSeen.get(r.slotID);
    if (prev !== r.penalties) {
      restSeen.set(r.slotID, r.penalties);
      if (prev !== undefined || (typeof r.penalties === 'number' && r.penalties > 0)) {
        const live = wsSeen.get(r.slotID);
        console.log(
          `REST  slot ${r.slotID} #${r.carNumber} ${r.driverName}: penalties ${prev} → ${r.penalties}` +
            ` (pitState ${r.pitState}${r.player ? ', OURS' : ''}; LiveStandings ${live ?? '—'})`,
        );
        write({ src: 'rest', slot: r.slotID, car: r.carNumber, driver: r.driverName, from: prev, to: r.penalties, pitState: r.pitState, player: !!r.player, finishStatus: r.finishStatus });
      }
    }
  }
}

function openWs() {
  const ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    console.log(`subscribed to LiveStandings on ${WS_URL}`);
    ws.send(JSON.stringify({ messageType: 'SUB', topic: 'LiveStandings' }));
  });
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || msg.topic !== 'LiveStandings' || !Array.isArray(msg.body)) return;
    for (const r of msg.body) {
      const key = JSON.stringify(r.penalties ?? null);
      const prev = wsSeen.get(r.slotID);
      if (prev === key) continue;
      wsSeen.set(r.slotID, key);
      const nonZero = r.penalties && Object.values(r.penalties).some((v) => v);
      if (prev === undefined && !nonZero) continue;
      console.log(`WS    slot ${r.slotID} #${r.vehicleNumber} ${r.driverName}: penalties ${prev ?? '—'} → ${key} (pitState ${r.pitState}, inPits ${r.inPits})`);
      write({ src: 'liveStandings', slot: r.slotID, car: r.vehicleNumber, driver: r.driverName, from: prev, to: r.penalties, pitState: r.pitState, inPits: r.inPits, row: r });
    }
  });
  ws.on('close', () => {
    console.log('LiveStandings socket closed — retrying in 3 s');
    setTimeout(openWs, 3000);
  });
  ws.on('error', () => {});
}

console.log(`field-penalties probe → ${LOG}`);
write({ event: 'probe-start', port: PORT });
openWs();
setInterval(pollRest, 1000);
void pollRest();
