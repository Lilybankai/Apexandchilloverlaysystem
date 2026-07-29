/**
 * scripts/probe-lmu-penalty.js — find out what LMU says about a penalty.
 * -----------------------------------------------------------------------------
 * The overlay can show the *count* of outstanding penalties from three separate
 * channels and the *kind* from none of them, which is how a driver with the
 * in-game HUD off ends up looking at "1 PENALTY" unable to tell a drive-through
 * from a stop/go. The one place the kind does appear is the **pit menu**: the
 * sim adds a row for the penalty it wants served, named after it. That was
 * observed live on a stop/go, where the menu read:
 *
 *   PMC 1   "STOP/GO:"   currentSetting=1/2   =>  "Yes(0Laps)"
 *
 * What has NOT been observed is what that row looks like for a drive-through —
 * whether the name changes, or a second row appears, or the same row just
 * carries different text. `buildPenaltyType` in the provider is deliberately
 * conservative because of that gap: it reports the row's own words and only when
 * the row is affirmatively showing something, so an unrecognised drive-through
 * row yields nothing rather than the wrong instruction.
 *
 * This closes the gap. Run it and drive; it prints a line every time anything
 * penalty-shaped changes, so the next penalty of either kind is captured exactly
 * as the sim words it. Paste the output into an issue (or straight into
 * `PENALTY_ROW`) and the guess becomes a fact.
 *
 * It watches four sources at once, because it is not yet established which one
 * is authoritative:
 *   • REST  /rest/watch/standings          → `penalties` (the count)
 *   • REST  /rest/garage/PitMenu/…         → every row, watched for penalty names
 *   • MMF   $rFactor2SMMP_Extended$        → the LSI message strings, if LMU
 *                                            populates them (empty when idle)
 *   • MMF   $rFactor2SMMP_PitInfo$         → the sim's own pit-menu mirror
 *
 * Usage — with Le Mans Ultimate running, in a session:
 *   node scripts/probe-lmu-penalty.js
 *   node scripts/probe-lmu-penalty.js --all    (print every poll, not just changes)
 */

'use strict';

const http = require('node:http');

const PORT = 6397;
const POLL_MS = 1000;
const ALL = process.argv.includes('--all');
/** Row names that might be naming a penalty rather than a service. */
const PENALTY_ISH = /stop|go|drive|thru|through|penal|serve|black/i;

function get(path) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port: PORT, path, timeout: 4000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(res.statusCode === 200 ? d : null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/* ----------------------------- shared memory ------------------------------ */

let mmf = null;
try {
  const koffi = require('koffi');
  const k32 = koffi.load('kernel32.dll');
  const OpenFileMappingW = k32.func('void* __stdcall OpenFileMappingW(uint32, bool, str16)');
  const MapViewOfFile = k32.func(
    'void* __stdcall MapViewOfFile(void*, uint32, uint32, uint32, size_t)',
  );
  const UnmapViewOfFile = k32.func('bool __stdcall UnmapViewOfFile(void*)');
  const CloseHandle = k32.func('bool __stdcall CloseHandle(void*)');
  const VirtualQuery = k32.func('size_t __stdcall VirtualQuery(void*, void*, size_t)');
  mmf = (name) => {
    const h = OpenFileMappingW(0x0004, false, `$rFactor2SMMP_${name}$`);
    if (!h) return null;
    const view = MapViewOfFile(h, 0x0004, 0, 0, 0);
    if (!view) {
      CloseHandle(h);
      return null;
    }
    const mbi = Buffer.alloc(48);
    VirtualQuery(view, mbi, 48);
    const size = Math.min(Number(mbi.readBigUInt64LE(24)), 1 << 16);
    const buf = Buffer.from(require('koffi').decode(view, 0, require('koffi').array('uint8', size)));
    UnmapViewOfFile(view);
    CloseHandle(h);
    return buf;
  };
} catch {
  console.warn('koffi unavailable — REST sources only.\n');
}

/** Printable ASCII runs of 4+ characters, deduped. */
function strings(buf) {
  if (!buf) return [];
  return [...new Set(buf.toString('latin1').match(/[ -~]{4,}/g) || [])].filter((s) =>
    /[A-Za-z]{3}/.test(s),
  );
}

/* --------------------------------- the loop -------------------------------- */

let last = '';
let ticks = 0;

async function poll() {
  const stamp = new Date().toISOString().slice(11, 19);
  const lines = [];

  const standings = await get('/rest/watch/standings');
  let count = null;
  if (standings) {
    try {
      const cars = JSON.parse(standings);
      const me = cars.find((c) => c.player) || cars[0];
      if (me) count = me.penalties;
    } catch {
      /* mid-write */
    }
  }
  lines.push(`penalties=${count === null ? '?' : count}`);

  const menuRaw = await get('/rest/garage/PitMenu/receivePitMenu');
  if (menuRaw) {
    try {
      const rows = JSON.parse(menuRaw);
      for (const r of rows) {
        const name = String(r.name || '');
        if (!PENALTY_ISH.test(name)) continue;
        const opts = Array.isArray(r.settings) ? r.settings : [];
        const cur = opts[r.currentSetting] ? opts[r.currentSetting].text : '?';
        lines.push(
          `menu[${r['PMC Value']}] ${JSON.stringify(name)} = ${JSON.stringify(cur)} ` +
            `(${r.currentSetting}/${opts.length}) all=${JSON.stringify(opts.map((o) => o.text))}`,
        );
      }
    } catch {
      /* mid-write */
    }
  }

  if (mmf) {
    for (const name of ['Extended', 'PitInfo']) {
      const found = strings(mmf(name)).filter((s) => PENALTY_ISH.test(s));
      if (found.length) lines.push(`${name}: ${JSON.stringify(found.slice(0, 8))}`);
    }
  }

  const sig = lines.join(' | ');
  if (ALL || sig !== last) {
    console.log(`[${stamp}] ${sig}`);
    last = sig;
  } else if (++ticks % 60 === 0) {
    console.log(`[${stamp}] (no change — still watching)`);
  }
}

console.log('Watching for penalty state. Ctrl-C to stop.\n');
void poll();
setInterval(() => void poll(), POLL_MS);
