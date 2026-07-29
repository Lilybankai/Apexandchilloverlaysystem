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
 * Every change is also appended to `~/.apex-overlay/penalty-probe.jsonl`, because
 * the thing being waited for happens once, mid-stint, hours after the probe was
 * started — and a terminal that has been closed, scrolled past its buffer, or
 * killed with the sim takes the only copy of it with it. The file keeps the raw
 * rows rather than the printed line, so the wording survives verbatim.
 *
 * It watches five sources at once, because it is not yet established which one
 * is authoritative:
 *   • REST  /rest/watch/standings          → `penalties` (the count), and the
 *                                            lateral geometry, sampled at 4 Hz
 *   • REST  /rest/garage/PitMenu/…         → every row, watched for penalty names
 *   • REST  /rest/sessions                 → `SESSSET_cuts_allowed` (the session's
 *                                            own allowance) and `SESSSET_cut_rules`
 *   • MMF   $rFactor2SMMP_Extended$        → the LSI message strings, if LMU
 *                                            populates them (empty when idle)
 *   • MMF   $rFactor2SMMP_PitInfo$         → the sim's own pit-menu mirror
 *
 * ## The track-limits warning message is not in the feed
 * Checked, live, in a race session: `Extended`, `PitInfo` and `Rules` are all
 * mapped and all contain **zero printable strings**, so LMU maps rF2's message
 * fields (`mLSIRulesInstructionMessage` and the track-rules participant messages)
 * without ever writing to them. On the REST side there is no message, incident or
 * race-control endpoint at all — every candidate 404s — and the player's standings
 * row carries `penalties` and nothing else penalty-shaped: no running total, no
 * warning count, no per-infringement value.
 *
 * So the wording a driver sees on the HUD ("track limits, 0.25") is rendered by
 * the game and published nowhere. What IS published is the session's threshold,
 * and the consequence when it is crossed — which is why this probe now times both
 * against real excursions rather than waiting for a message that does not exist.
 *
 * Usage — with Le Mans Ultimate running, in a session:
 *   node scripts/probe-lmu-penalty.js
 *   node scripts/probe-lmu-penalty.js --all         (print every poll, not just changes)
 *   node scripts/probe-lmu-penalty.js --log <path>  (write the capture elsewhere)
 *   node scripts/probe-lmu-penalty.js --no-log      (console only)
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PORT = 6397;
const POLL_MS = 1000;
const ALL = process.argv.includes('--all');
/** Row names that might be naming a penalty rather than a service. */
const PENALTY_ISH = /stop|go|drive|thru|through|penal|serve|black/i;

/* --------------------------------- the log --------------------------------- */

/**
 * Where the capture lands — beside the lap files in `~/.apex-overlay`, which is
 * already the home for data the server writes with or without Electron.
 */
function logPath() {
  const i = process.argv.indexOf('--log');
  if (i !== -1 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  return path.join(os.homedir(), '.apex-overlay', 'penalty-probe.jsonl');
}

const LOG = process.argv.includes('--no-log') ? null : logPath();
let logBroken = false;

/**
 * Append one record.
 *
 * Best-effort, and it gives up loudly but permanently on the first failure: the
 * probe's job is to be running when the penalty lands, and a full disk or a
 * read-only path must not turn into a write attempt every second for the rest of
 * the stint, nor take the console output down with it.
 */
function record(obj) {
  if (!LOG || logBroken) return;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${JSON.stringify(obj)}\n`, 'utf8');
  } catch (err) {
    logBroken = true;
    console.warn(`\n! cannot write ${LOG} (${err.message}) — console only from here.\n`);
  }
}

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

/* ------------------------------ the cut rules ------------------------------ */

/**
 * How often to re-read the session settings. Rarely: they change when a session
 * does, not while driving.
 */
const RULES_MS = 30_000;

/**
 * The session's own track-limits configuration, from `/rest/sessions`.
 *
 * This is the number the widget currently guesses at. `SESSSET_cuts_allowed` is
 * the session's allowance before the sim acts, and `SESSSET_cut_rules` is whether
 * it acts at all — a session set to show cuts without penalising them must not be
 * shown a countdown to a drive-through that is never coming.
 *
 * Logged rather than assumed, because what the sim counts *toward* that allowance
 * is the open question: LMU scores an infringement fractionally (quarter, half, a
 * point and a quarter, by severity) and the running total is published nowhere,
 * so whether an allowance of 5 means five cuts or 5.0 points can only be settled
 * by watching the count move against real excursions.
 */
let prevRules = '';

async function pollRules() {
  const raw = await get('/rest/sessions');
  if (!raw) return;
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    return; // mid-write
  }
  const allowed = s.SESSSET_cuts_allowed;
  const rules = s.SESSSET_cut_rules;
  if (!allowed && !rules) return;
  const sig = JSON.stringify([allowed, rules]);
  if (sig === prevRules) return;
  prevRules = sig;
  console.log(
    `[rules] cuts_allowed=${allowed ? allowed.currentValue : '?'} ` +
      `cut_rules=${rules ? `${rules.currentValue} ${JSON.stringify(rules.stringValue)}` : '?'}`,
  );
  record({
    at: new Date().toISOString(),
    event: 'cut-rules',
    cutsAllowed: allowed ? allowed.currentValue : null,
    cutRules: rules ? rules.currentValue : null,
    cutRulesText: rules ? rules.stringValue : null,
    raw: { SESSSET_cuts_allowed: allowed, SESSSET_cut_rules: rules },
  });
}

/* ------------------------------ the excursions ----------------------------- */

/**
 * Geometry sampling rate, ms.
 *
 * Four times the rate of the outer loop because an excursion is over in a second
 * or two, and how far the car went past the edge is the only severity signal
 * available — sampled at 1 Hz a fast one is a single reading, or none.
 */
const SAMPLE_MS = 250;

/** Latest player state, shared with the outer loop so standings is fetched once. */
const live = { count: null, at: 0, countLapFlag: null };

/** The excursion in progress, if the car is beyond the edge right now. */
let excursion = null;

/**
 * Excursions since the penalty count last moved.
 *
 * This is the fit: the sim publishes the consequence but never the running total,
 * so the per-infringement value has to be read backwards off "these N excursions,
 * of these depths, took the count from 0 to 1".
 */
let sinceCount = [];

async function sample() {
  const raw = await get('/rest/watch/standings');
  if (!raw) return;
  let me;
  try {
    const cars = JSON.parse(raw);
    me = cars.find((c) => c.player) || cars[0];
  } catch {
    return; // mid-write
  }
  if (!me) return;

  const now = Date.now();
  live.at = now;

  /* --- the count, timestamped as tightly as the sampler allows --- */
  const count = me.penalties;
  if (typeof count === 'number' && count !== live.count) {
    const from = live.count;
    live.count = count;
    if (from !== null) {
      const dir = count > from ? 'penalty-issued' : 'penalty-served';
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] *** ${dir} ${from} → ${count} ` +
          `after ${sinceCount.length} excursion(s) ` +
          `${JSON.stringify(sinceCount.map((e) => +e.peakDepthM.toFixed(2)))}`,
      );
      record({
        at: new Date().toISOString(),
        event: dir,
        from,
        to: count,
        // Every excursion since the last move, whole: the depths and durations
        // are the only candidate inputs to whatever fraction the sim assigned.
        excursions: sinceCount,
      });
    }
    sinceCount = [];
  }

  /* --- does the sim say this lap still counts? ---
   *
   * Lap invalidation is the one consequence with no live source yet: the results XML
   * reports it ("Invalid Lap Cut Track") and the trace log does not. `countLapFlag`
   * is rF2's `mCountLapFlag` and is the likeliest candidate — it reads
   * `COUNT_NEITHER` in the garage, and if it flips when a cut deletes a lap then it
   * is the signal. Logged on every change so the next cut settles it either way. */
  const flag = me.countLapFlag;
  if (flag !== undefined && flag !== live.countLapFlag) {
    const from = live.countLapFlag;
    live.countLapFlag = flag;
    if (from !== null) {
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] countLapFlag ${from} → ${flag} ` +
          `(lap ${me.lapsCompleted}, ${Math.round(me.lapDistance)} m, penalties ${live.count})`,
      );
      record({
        at: new Date().toISOString(),
        event: 'count-lap-flag',
        from,
        to: flag,
        lap: me.lapsCompleted,
        lapDistanceM: Math.round(me.lapDistance),
      });
    }
  }

  /* --- the pit lane is not a cut ---
   * It is off the AIW path by definition, so an unfiltered sampler logs every
   * stop as a deep, very long excursion — and the first run did exactly that. */
  if (me.pitting || me.inGarageStall) {
    excursion = null;
    return;
  }

  /* --- off the road, by the sim's own edge and with no margin applied --- */
  const lat = me.pathLateral;
  const edge = me.trackEdge;
  if (typeof lat !== 'number' || typeof edge !== 'number' || !edge) return;
  const depth = Math.abs(lat) - Math.abs(edge);
  // Speed separates a cut from a recovery: a kerb-hop or a cut across a chicane
  // is taken at racing speed, while a spin, a gravel trap or a crawl back onto
  // the road drops to walking pace. The first run logged a 15.7 s, 13.3 m
  // "excursion" that was plainly a spin, and it counted the same as a cut.
  const kph = me.carVelocity && typeof me.carVelocity.velocity === 'number'
    ? Math.abs(me.carVelocity.velocity) * 3.6
    : null;

  if (depth > 0) {
    if (!excursion) {
      excursion = {
        startedAt: new Date().toISOString(),
        startMs: now,
        peakDepthM: depth,
        minKph: kph,
        lapDistanceM: me.lapDistance,
        lap: me.lapsCompleted,
        samples: 1,
      };
    } else {
      excursion.peakDepthM = Math.max(excursion.peakDepthM, depth);
      if (kph !== null) excursion.minKph = excursion.minKph === null ? kph : Math.min(excursion.minKph, kph);
      excursion.samples += 1;
    }
    return;
  }

  if (!excursion) return;
  const done = {
    startedAt: excursion.startedAt,
    durationMs: now - excursion.startMs,
    peakDepthM: +excursion.peakDepthM.toFixed(3),
    minKph: excursion.minKph === null ? null : Math.round(excursion.minKph),
    lapDistanceM: Math.round(excursion.lapDistanceM),
    lap: excursion.lap,
    samples: excursion.samples,
  };
  excursion = null;
  sinceCount.push(done);
  console.log(
    `[${new Date().toISOString().slice(11, 19)}] off-track: ${done.peakDepthM} m past edge, ` +
      `${done.durationMs} ms, min ${done.minKph === null ? '?' : done.minKph} kph, ` +
      `at ${done.lapDistanceM} m — ${sinceCount.length} since the count moved`,
  );
  record({ at: new Date().toISOString(), event: 'excursion', ...done, penalties: live.count });
}

/* --------------------------------- the loop -------------------------------- */

let last = '';
let ticks = 0;
let prevCount = undefined;

async function poll() {
  const stamp = new Date().toISOString().slice(11, 19);
  const lines = [];

  // The sampler owns standings — it reads it four times a second already, and a
  // second reader would only add a slower, disagreeing copy of the same number.
  const count = live.count;
  lines.push(`penalties=${count === null ? '?' : count}`);

  const menuRaw = await get('/rest/garage/PitMenu/receivePitMenu');
  let allRows = null;
  const hits = [];
  if (menuRaw) {
    try {
      const rows = JSON.parse(menuRaw);
      allRows = rows;
      for (const r of rows) {
        const name = String(r.name || '');
        if (!PENALTY_ISH.test(name)) continue;
        hits.push(r);
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

  const memory = {};
  if (mmf) {
    for (const name of ['Extended', 'PitInfo']) {
      const found = strings(mmf(name)).filter((s) => PENALTY_ISH.test(s));
      if (found.length) {
        memory[name] = found;
        lines.push(`${name}: ${JSON.stringify(found.slice(0, 8))}`);
      }
    }
  }

  const sig = lines.join(' | ');
  const changed = sig !== last;
  if (ALL || changed) {
    console.log(`[${stamp}] ${sig}`);
  } else if (++ticks % 60 === 0) {
    console.log(`[${stamp}] (no change — still watching)`);
  }

  // Changes only, even under `--all`: the file is read by diffing one state
  // against the next, and a record per second for a two-hour stint buries the
  // one moment it was left running to catch.
  if (changed) {
    record({
      at: new Date().toISOString(),
      penalties: count,
      // The matched rows whole, not the line printed above: `PENALTY_ROW` is
      // matched against `name`, and a value truncated for the console is no use
      // for pinning it.
      rows: hits,
      ...(Object.keys(memory).length ? { memory } : {}),
      // Every row name in the menu, whenever the count moves. The stop/go row
      // was found by diffing a menu carrying a penalty against one that was not,
      // and a drive-through row named something `PENALTY_ISH` does not recognise
      // can only be found the same way — the console filter would never show it.
      ...(count !== prevCount && allRows ? { menu: allRows.map((r) => String(r.name || '')) } : {}),
    });
    last = sig;
  }
  prevCount = count;
}

console.log('Watching for penalty state, cut rules and excursions. Ctrl-C to stop.');
console.log(LOG ? `Logging changes to ${LOG}\n` : 'Not logging to file (--no-log).\n');
record({ at: new Date().toISOString(), event: 'watch-start', argv: process.argv.slice(2) });
void pollRules();
void sample();
void poll();
setInterval(() => void pollRules(), RULES_MS);
setInterval(() => void sample(), SAMPLE_MS);
setInterval(() => void poll(), POLL_MS);
