/**
 * scripts/probe-lmu-dailies.js — the LMU daily/weekly/special race calendar, live.
 * -----------------------------------------------------------------------------
 * The Schedule tab wants what the game's own "ONLINE ▸ DAILY RACES" screen
 * shows: which event each tier runs next, when it starts, and the week's whole
 * rotation. None of that is in the local REST API — the full swagger was
 * enumerated again on 2026-09-17 and there is no daily/matchmaking route at all.
 * It lives behind the same online service the rank badges come from
 * (raceos.gg, see src/telemetry/raceosRanks.ts). The game's UI is a React app
 * served from the game's OWN port — GET /start/index.html names the bundle,
 * /start/assets/app-*.js is 6 MB of readable source, and that is where these
 * routes were read out of. Confirmed live 2026-09-17:
 *
 *   GET api/v1/daily/schedule           — 200. Today's grid: three tiers, three
 *                                         events each, and every event's own
 *                                         array of UTC start times. The tier
 *                                         rotation is SOLVED BY THE SERVER; we
 *                                         never have to infer an anchor.
 *   GET api/v1/daily/list/{tier}?take=N — 200 for tier in beginner |
 *                                         intermediate | advanced (any other
 *                                         value answers 200 with []). The next
 *                                         N instances in full: `starts`,
 *                                         `registrationOpens` (start − 30 min),
 *                                         the Practice/Qualifying/Race session
 *                                         list, weather, assists, tyre sets,
 *                                         fixed setup, maxPlayers, images.
 *   GET api/v1/special-events/{type}    — 200 for `weekly` and `special`
 *                                         (others 500). Each series carries an
 *                                         `events[]` with per-slot REGISTRATION
 *                                         COUNTS and `isRegistered` for us.
 *   GET api/v1/player/timezone          — 404. The account time zone is not
 *                                         readable this way; use the OS zone.
 *
 * So the whole "paste the weekly Discord message" pipeline is unnecessary: the
 * calendar is live, exact, and already in the player's own account context.
 *
 * This probe performs the same Steam-ticket exchange the game does, calls those
 * endpoints, and prints what comes back — shapes first, then the raw JSON, so
 * the payload can be modelled without guessing. It writes nothing anywhere and
 * sends nothing but the ticket to the service.
 *
 * This is an UNDOCUMENTED private service. Treat everything here as a finding,
 * not a contract: every failure path must degrade to "no schedule", the way the
 * rank badges degrade to "no badges".
 *
 * Usage — with Le Mans Ultimate running and signed in (the main menu is enough):
 *   node scripts/probe-lmu-dailies.js
 *   node scripts/probe-lmu-dailies.js --raw     # full JSON, not just shapes
 *   node scripts/probe-lmu-dailies.js --out DIR # also save each payload
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.APEX_LMU_PORT || 6397);
const HOST = 'raceos.gg';
const TIMEOUT_MS = 10_000;

const RAW = process.argv.includes('--raw');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 ? process.argv[i + 1] : null;
})();

/* -------------------------------------------------------------------------- */
/*  The two halves of the game's own auth                                      */
/* -------------------------------------------------------------------------- */

function gameTicket() {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/rest/profile/getAuthSessionTicket', timeout: 5000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`ticket HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j && typeof j.authSessionTicket === 'string' && j.authSessionTicket) {
              resolve(j.authSessionTicket);
            } else reject(new Error('no ticket in response'));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ticket timeout')));
  });
}

/** One HTTPS call to the service. The bearer is never printed. */
function call(method, apiPath, body, bearer) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(
      {
        host: HOST,
        path: apiPath.startsWith('/') ? apiPath : `/${apiPath}`,
        method,
        timeout: TIMEOUT_MS,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(bearer ? { 'Game-Authorization': `Bearer ${bearer}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, err: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, err: 'timeout' });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/* -------------------------------------------------------------------------- */
/*  Printing                                                                   */
/* -------------------------------------------------------------------------- */

/** A compact type sketch of a value — enough to model a payload from. */
function shape(v, depth = 0, seen = 0) {
  const pad = '  '.repeat(depth + 1);
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[${v.length}] of ${shape(v[0], depth, seen)}`;
  }
  if (typeof v === 'object') {
    if (depth >= 4) return '{…}';
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    const lines = keys
      .slice(0, 60)
      .map((k) => `${pad}${k}: ${shape(v[k], depth + 1, seen)}`);
    if (keys.length > 60) lines.push(`${pad}… ${keys.length - 60} more`);
    return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`;
  }
  if (typeof v === 'string') {
    const t = v.length > 60 ? `${v.slice(0, 57)}…` : v;
    return `string  "${t}"`;
  }
  return `${typeof v}  ${v}`;
}

function report(label, res) {
  console.log(`\n=== ${label} ===`);
  if (res.err) {
    console.log(`  ERROR ${res.err}`);
    return;
  }
  console.log(`  HTTP ${res.status}  ${res.raw ? `${res.raw.length} bytes` : 'empty'}`);
  if (res.status !== 200) {
    if (res.raw) console.log(`  ${res.raw.slice(0, 300)}`);
    return;
  }
  console.log(shape(res.json));
  if (RAW) console.log('\n  --- raw ---\n' + JSON.stringify(res.json, null, 2));
  if (OUT) {
    const file = path.join(OUT, `${label.replace(/[^a-z0-9]+/gi, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(res.json, null, 2));
    console.log(`  saved → ${file}`);
  }
}

/* -------------------------------------------------------------------------- */

async function main() {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });

  console.log(`probe-lmu-dailies — ${new Date().toISOString()}`);
  console.log(`  game port ${PORT}, service ${HOST}`);

  let ticket;
  try {
    ticket = await gameTicket();
  } catch (e) {
    console.log(`\nFAILED to get a Steam session ticket: ${e.message}`);
    console.log('Is Le Mans Ultimate running and signed in?');
    process.exit(1);
  }
  console.log(`  ticket: ${ticket.length} chars`);

  const auth = await call('POST', '/authenticate', { token: ticket, game: 'lmu', platform: 'steam' });
  if (auth.status !== 200 || !auth.json || !auth.json.accessToken) {
    console.log(`\nFAILED to authenticate: HTTP ${auth.status} ${auth.err || ''}`);
    console.log((auth.raw || '').slice(0, 400));
    process.exit(1);
  }
  const token = auth.json.accessToken;
  console.log(`  authenticated (token ${token.length} chars, not printed)`);

  /* The week's rotation — the payload the whole feature turns on. */
  report('daily-schedule', await call('GET', 'api/v1/daily/schedule', null, token));

  /* Kept as a negative result: the UI reads the zone from the account, but this
     route 404s for us, so the panel must use the OS zone. */
  report('player-timezone', await call('GET', 'api/v1/player/timezone', null, token));

  /* The next instances, per tier. Anything outside these three answers 200 with
     an empty array — a silent empty, not an error, so never treat [] as "no
     races today" without checking the tier name first. */
  for (const tier of ['beginner', 'intermediate', 'advanced']) {
    report(`daily-list-${tier}`, await call('GET', `api/v1/daily/list/${tier}?take=12`, null, token));
  }

  /* The solo weekly and the team specials. Other type names answer 500. */
  for (const t of ['weekly', 'special']) {
    report(`special-events-${t}`, await call('GET', `api/v1/special-events/${t}`, null, token));
  }

  console.log('\nDone. Nothing was written to the game or to disk beyond --out.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
