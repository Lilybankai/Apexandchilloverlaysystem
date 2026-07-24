/**
 * scripts/probe-lmu-mfd.js — find out how much of the in-game MFD / pit menu
 * LMU will let us drive over its REST API, WITHOUT synthesizing keystrokes.
 * -----------------------------------------------------------------------------
 * The overlay already READS one garage endpoint (`RepairAndRefuel`) in
 * `lmuRestProvider.ts`. This probe answers the question that decides the whole
 * MFD-control feature: does the same `/rest/garage/…` surface accept WRITES —
 * can we set fuel / tyres / repairs / pit strategy by POSTing to LMU instead of
 * blindly cycling the MFD with emulated keys?
 *
 * It works in three passes, each safe to run while sitting in the garage:
 *
 *   1. SWAGGER DISCOVERY (the decisive one). LMU ships a Swagger spec that lists
 *      EVERY endpoint and its HTTP method. We fetch it and print every path,
 *      flagging the POST/PUT/PATCH ones under /rest/garage and anything that
 *      mentions pit / menu / strategy / fuel / tyre. If a writable pit-menu
 *      endpoint exists, it shows up here by name — no guessing.
 *
 *   2. KNOWN-ENDPOINT DUMP. GETs a handful of garage/pit endpoints we already
 *      know or strongly suspect and prints their JSON shape, so we can see the
 *      exact field names a write would target (fuel amount, tyre compound,
 *      repair flags, the currently-selected pit-menu row, etc.).
 *
 *   3. OPTIONAL WRITE TEST (only with --post). POSTs a body you supply to a path
 *      you supply, then re-GETs a read-back path so you can SEE whether the
 *      in-game MFD actually moved. Nothing writes unless you ask for it.
 *
 * Usage — start LMU, load into a car/garage, then in another terminal:
 *
 *   node scripts/probe-lmu-mfd.js                       # passes 1 + 2 (read-only)
 *   node scripts/probe-lmu-mfd.js --port 6397
 *   node scripts/probe-lmu-mfd.js --full                # dump full payloads, not just shapes
 *
 *   # Pass 3 — attempt a write, then read a path back to confirm it moved:
 *   node scripts/probe-lmu-mfd.js \
 *     --post /rest/garage/PitMenu/loadPitMenu \
 *     --body '{"name":"FUEL:","value":30}' \
 *     --readback /rest/garage/PitMenu/receivePitMenu
 *
 * Passes 1 and 2 are read-only. Pass 3 changes your pit strategy — do it in a
 * throwaway practice session, not a race you care about.
 */

'use strict';

const http = require('node:http');

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', 6397));
const FULL = process.argv.includes('--full');
const POST_PATH = argOf('--post', null);
const POST_BODY = argOf('--body', null);
const READBACK = argOf('--readback', null);

/** Swagger spec locations to try, newest ASP.NET conventions first. */
const SWAGGER_PATHS = [
  '/swagger/v1/swagger.json',
  '/swagger/v2/swagger.json',
  '/swagger.json',
  '/rest/swagger.json',
];

/**
 * Endpoints worth GETting directly in pass 2. The first is the one the overlay
 * already consumes; the rest are the rF2/LMU garage + pit-menu names that carry
 * the current MFD selection. A 404 here just means "not on this build" and is
 * reported, not fatal — pass 1 (swagger) is the authoritative list.
 */
const KNOWN_GETS = [
  '/rest/garage/UIScreen/RepairAndRefuel',
  '/rest/garage/PitMenu/receivePitMenu',
  '/rest/garage/getPlayerGarageData',
  '/rest/garage/UIScreen/PitStopControls',
  '/rest/garage/UIScreen/DriverSelection',
  '/rest/garage/UIScreen/FuelAndStrategy',
  '/rest/strategy',
  '/rest/watch/pitMenu',
];

/** Words that make an endpoint interesting for MFD control. */
const HOT = /pit|menu|strateg|fuel|tyre|tire|repair|refuel|garage|driver|aid|brake|abs|traction/i;
/** HTTP methods that can change state — the ones that make control possible. */
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

/* --------------------------------- HTTP ---------------------------------- */

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? Buffer.from(body, 'utf8') : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        timeout: 4000,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function getJson(path) {
  const { status, raw } = await request('GET', path);
  if (status !== 200) return { status, data: null, raw };
  try {
    return { status, data: JSON.parse(raw), raw };
  } catch {
    return { status, data: null, raw };
  }
}

/* ------------------------- shape summarisation --------------------------- */

/** A compact "what fields does this payload have" summary, for scanning. */
function shape(value, depth = 0) {
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.length} × ${shape(value[0], depth + 1)}]`;
  }
  if (value && typeof value === 'object') {
    if (depth >= 2) return '{…}';
    const keys = Object.keys(value);
    const shown = keys.slice(0, 12);
    const body = shown.map((k) => `${k}: ${shape(value[k], depth + 1)}`).join(', ');
    return `{ ${body}${keys.length > shown.length ? ', …' : ''} }`;
  }
  if (typeof value === 'string') return value.length > 24 ? 'str' : JSON.stringify(value);
  return typeof value;
}

/* --------------------------------- passes -------------------------------- */

async function passSwagger() {
  console.log('\n=== PASS 1 — Swagger endpoint discovery ===');
  let spec = null;
  let from = null;
  for (const p of SWAGGER_PATHS) {
    const { status, data } = await getJson(p);
    if (status === 200 && data && data.paths) {
      spec = data;
      from = p;
      break;
    }
  }
  if (!spec) {
    console.log(
      '  No Swagger spec found at the usual paths. Open http://localhost:' +
        PORT +
        '/swagger in a browser and check the URL the UI loads its JSON from,\n' +
        '  then pass it via SWAGGER_PATHS. Falling back to the known-endpoint dump.',
    );
    return;
  }
  console.log(`  spec: ${from}  (${Object.keys(spec.paths).length} paths)\n`);

  const rows = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const method of Object.keys(ops)) {
      rows.push({ method: method.toUpperCase(), path, write: WRITE_METHODS.has(method) });
    }
  }
  // Writable + hot endpoints first — those are the MFD-control candidates.
  rows.sort((a, b) => {
    const sa = (a.write ? 2 : 0) + (HOT.test(a.path) ? 1 : 0);
    const sb = (b.write ? 2 : 0) + (HOT.test(b.path) ? 1 : 0);
    return sb - sa || a.path.localeCompare(b.path);
  });

  console.log('  ★ = writable (POST/PUT/PATCH)   ● = MFD-relevant path\n');
  for (const r of rows) {
    if (!r.write && !HOT.test(r.path)) continue; // hide the noise; full list below if --full
    const star = r.write ? '★' : ' ';
    const dot = HOT.test(r.path) ? '●' : ' ';
    console.log(`  ${star}${dot} ${r.method.padEnd(6)} ${r.path}`);
  }
  if (FULL) {
    console.log('\n  --- all paths ---');
    for (const r of rows) console.log(`     ${r.method.padEnd(6)} ${r.path}`);
  }
}

async function passKnownGets() {
  console.log('\n=== PASS 2 — known garage / pit-menu endpoints ===');
  for (const path of KNOWN_GETS) {
    const { status, data, raw } = await getJson(path);
    if (status !== 200) {
      console.log(`  ${String(status).padStart(3)}  ${path}`);
      continue;
    }
    console.log(`  200  ${path}`);
    if (FULL) {
      console.log(indent(JSON.stringify(data ?? raw, null, 2)));
    } else if (data != null) {
      console.log(indent(shape(data)));
    }
  }
}

async function passWrite() {
  if (!POST_PATH) return;
  console.log('\n=== PASS 3 — write test ===');
  if (READBACK) {
    const before = await getJson(READBACK);
    console.log(`  before  ${READBACK}: ${before.status === 200 ? shape(before.data) : before.status}`);
  }
  const method = 'POST';
  const { status, raw } = await request(method, POST_PATH, POST_BODY ?? '{}');
  console.log(`  ${method} ${POST_PATH}  →  HTTP ${status}`);
  if (raw) console.log(indent(raw.slice(0, 400)));
  if (READBACK) {
    // Give the game a beat to apply it before reading back.
    await new Promise((r) => setTimeout(r, 250));
    const after = await getJson(READBACK);
    console.log(`  after   ${READBACK}: ${after.status === 200 ? shape(after.data) : after.status}`);
    console.log(
      '\n  → Did the in-game MFD move? If yes, REST control works and we build the\n' +
        '    pit-strategy half on this endpoint. If the HTTP call succeeded but the\n' +
        '    MFD did not change, this build gates writes and that half falls back to keys.',
    );
  }
}

function indent(s) {
  return s
    .split('\n')
    .map((l) => '      ' + l)
    .join('\n');
}

/* --------------------------------- main ---------------------------------- */

(async () => {
  console.log(`Probing LMU REST API on http://127.0.0.1:${PORT}`);
  try {
    await passSwagger();
    await passKnownGets();
    await passWrite();
  } catch (err) {
    console.error('\nProbe failed:', err.message);
    console.error('Is LMU running with the REST API up? Check http://localhost:' + PORT + '/swagger');
    process.exit(1);
  }
  console.log('\nDone.');
})();
