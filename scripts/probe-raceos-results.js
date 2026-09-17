/**
 * scripts/probe-raceos-results.js — race RESULTS and player STATISTICS, live.
 * -----------------------------------------------------------------------------
 * The companion-app plan was written around one blocker: "no race results record
 * exists anywhere — nothing writes grid or finish position", so a Statistics tab
 * meant building capture first and waiting months for history to accumulate.
 * `scripts/probe-lmu-dailies.js` found the daily calendar on RaceOS; the same
 * bundle lists results, statistics and leaderboard routes beside it. If those
 * answer, the history already exists — server-side, retroactive, for every
 * driver — and nothing needs capturing at all.
 *
 * It does. Answered live 2026-09-17 against a real account — the blocker is
 * gone, and none of it needed capturing. Routes and their exact call shapes
 * were read out of the game's own UI bundle (see probe-lmu-dailies.js for how
 * to get at it):
 *
 *   GET  api/v1/player                  — 200. Identity, DR/SR rank + tier +
 *                                         progress, badges, jokers, enforcement
 *                                         (strikes/suspensions), RaceControl
 *                                         subscription. Also the account email
 *                                         and a live verification code, so this
 *                                         probe redacts before printing.
 *   GET  /api/v1/statistics             — 200. Career totals AND a per-category
 *                                         split (gt / endurance / touringCars /
 *                                         singleSeaters): races, wins, podiums,
 *                                         top5, poles, fastestLaps, lapsLead,
 *                                         lapsCompleted, dnfs. Retroactive.
 *   POST api/v1/statistics/overall      — 200. {playerIds:[…]} → races + wins
 *                                         per id. Redacted for others the way
 *                                         the rank elo figures are.
 *   GET  api/v1/results?eventType=&page=&take=
 *                                       — 200 for eventType "" (all) | daily |
 *                                         specialevent | championship. FULL
 *                                         classification per event: every
 *                                         driver's gridPos/position/classPos,
 *                                         bestLapTime, finishTime, Laps,
 *                                         finishStatus, driver swaps by lap,
 *                                         aids used, points, plus per-driver
 *                                         SR/DR adjustments WITH REASONS
 *                                         ("Qualifying you finished 10th of
 *                                         23"), separately for practice /
 *                                         qualifying / warmup / race.
 *                                         ⚠ 2.3 MB for ten rows — never fetch
 *                                         this to paint a list.
 *   POST api/v1/leaderboards/results-for-users
 *                                       — 200, but {count:0,entries:[]} for the
 *                                         hand-built id below. The UI derives
 *                                         it from a leaderboard it already
 *                                         holds ("{eventType}-{tier}-{track}-
 *                                         {layout}-{title}"); getting a real
 *                                         one is still owed.
 *   GET  api/v1/player/friends-list     — 404. Not available to us.
 *   GET  api/v1/team/mine               — 200. Teams, lineups, members, roles.
 *   GET  api/v1/team/stats/{id}         — 200. Team career figures, and the
 *                                         same again per lineup.
 *   GET  api/v1/team/results/{id}?lineupId=&eventType=&page=&take=  — 200.
 *   GET  api/v1/championships/active    — 200 (upcoming was empty, completed
 *                                         200) — the official series, distinct
 *                                         from the league's SimGrid calendar.
 *   GET  api/v1/notifications/global    — 200. S397's own announcements, HTML
 *                                         body + image, per language.
 *
 * Read-only: every call here is a GET, or a POST that only ever looks something
 * up. Nothing registers, joins, updates a profile or writes to the account.
 *
 * Undocumented private service — findings, not a contract.
 *
 * Usage — with Le Mans Ultimate running and signed in:
 *   node scripts/probe-raceos-results.js
 *   node scripts/probe-raceos-results.js --raw
 *   node scripts/probe-raceos-results.js --out DIR
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.APEX_LMU_PORT || 6397);
const HOST = 'raceos.gg';
const TIMEOUT_MS = 12_000;

const RAW = process.argv.includes('--raw');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 ? process.argv[i + 1] : null;
})();

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
            if (j && typeof j.authSessionTicket === 'string' && j.authSessionTicket) resolve(j.authSessionTicket);
            else reject(new Error('no ticket in response'));
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

/**
 * Keys whose values never belong in a terminal or a saved probe dump.
 * `api/v1/player` hands back the account's email address and a live email
 * verification code alongside the racing data; results payloads are otherwise
 * fine (Steam ids and driver names are what the game shows everyone).
 */
const SECRET_KEY = /^(email|code|token|accessToken|authSessionTicket)$/i;

function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SECRET_KEY.test(k) && typeof val === 'string' && val ? '«redacted»' : redact(val);
    }
    return out;
  }
  return v;
}

function shape(v, depth = 0) {
  const pad = '  '.repeat(depth + 1);
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${v.length}] of ${shape(v[0], depth)}` : '[]';
  if (typeof v === 'object') {
    if (depth >= 4) return '{…}';
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    const lines = keys.slice(0, 80).map((k) => `${pad}${k}: ${shape(v[k], depth + 1)}`);
    if (keys.length > 80) lines.push(`${pad}… ${keys.length - 80} more`);
    return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`;
  }
  if (typeof v === 'string') return `string  "${v.length > 60 ? `${v.slice(0, 57)}…` : v}"`;
  return `${typeof v}  ${v}`;
}

function report(label, res) {
  console.log(`\n=== ${label} ===`);
  if (res.err) {
    console.log(`  ERROR ${res.err}`);
    return res;
  }
  console.log(`  HTTP ${res.status}  ${res.raw ? `${res.raw.length} bytes` : 'empty'}`);
  if (res.status !== 200) {
    if (res.raw) console.log(`  ${res.raw.slice(0, 300)}`);
    return res;
  }
  const safe = redact(res.json);
  console.log(shape(safe));
  if (RAW) console.log('\n  --- raw ---\n' + JSON.stringify(safe, null, 2));
  if (OUT) {
    const file = path.join(OUT, `${label.replace(/[^a-z0-9]+/gi, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(safe, null, 2));
    console.log(`  saved → ${file}`);
  }
  return res;
}

/** First defined value at any of these dotted paths — payload keys vary. */
function pick(obj, ...paths) {
  for (const p of paths) {
    let v = obj;
    for (const k of p.split('.')) v = v == null ? undefined : v[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */

async function main() {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });

  console.log(`probe-raceos-results — ${new Date().toISOString()}`);

  let ticket;
  try {
    ticket = await gameTicket();
  } catch (e) {
    console.log(`\nFAILED to get a Steam session ticket: ${e.message}`);
    console.log('Is Le Mans Ultimate running and signed in?');
    process.exit(1);
  }

  const auth = await call('POST', '/authenticate', { token: ticket, game: 'lmu', platform: 'steam' });
  if (auth.status !== 200 || !auth.json || !auth.json.accessToken) {
    console.log(`\nFAILED to authenticate: HTTP ${auth.status} ${auth.err || ''}`);
    console.log((auth.raw || '').slice(0, 400));
    process.exit(1);
  }
  const token = auth.json.accessToken;
  console.log(`  authenticated (token not printed)`);

  /* ---- who we are ------------------------------------------------------- */
  const me = report('player', await call('GET', 'api/v1/player', null, token));
  const myId = me.json
    ? pick(me.json, 'id', 'playerId', 'player.id', 'user.id', 'userId', 'steamId', 'player.steamId')
    : undefined;
  console.log(`  → player id: ${myId === undefined ? 'NOT FOUND (see shape above)' : myId}`);

  /* ---- career figures --------------------------------------------------- */
  report('statistics-own', await call('GET', '/api/v1/statistics', null, token));
  if (myId !== undefined) {
    report(
      'statistics-overall',
      await call('POST', 'api/v1/statistics/overall', { playerIds: [String(myId)] }, token),
    );
  }

  /* ---- THE question: is our race history already on the server? --------- */
  for (const type of ['', 'daily', 'specialevent', 'championship']) {
    const q = new URLSearchParams({ eventType: type, page: '1', take: '10' });
    report(`results-${type || 'all'}`, await call('GET', `api/v1/results?${q}`, null, token));
  }

  /* ---- one event's full classification ---------------------------------- */
  /* The UI builds this from a leaderboard id it already holds
     ("{eventType}-{tier}-{trackName}-{trackLayout}-{eventTitle}"). Asked here
     with today's beginner Bahrain round, purely to see the row shape. */
  report(
    'leaderboard-results-for-users',
    await call(
      'POST',
      'api/v1/leaderboards/results-for-users',
      {
        lookup: 'Steam',
        ids: [],
        eventType: 'daily',
        tier: 'beginner',
        trackName: 'BahrainWEC',
        trackLayout: 'BahrainWEC_2023',
        eventTitle: 'LMGT3 Fixed',
        page: 1,
      },
      token,
    ),
  );

  /* ---- social + team ---------------------------------------------------- */
  report('friends-list', await call('GET', 'api/v1/player/friends-list', null, token));

  const teams = report('team-mine', await call('GET', 'api/v1/team/mine', null, token));
  const teamList = Array.isArray(teams.json) ? teams.json : pick(teams.json || {}, 'teams') || [];
  const teamId = Array.isArray(teamList) && teamList[0] ? pick(teamList[0], 'id', 'teamId') : undefined;
  if (teamId) {
    console.log(`  → team id: ${teamId}`);
    report('team-stats', await call('GET', `api/v1/team/stats/${teamId}`, null, token));
    const q = new URLSearchParams({ lineupId: '', eventType: '', page: '1', take: '10' });
    report('team-results', await call('GET', `api/v1/team/results/${teamId}?${q}`, null, token));
  } else {
    console.log('  → no RaceOS team on this account; team stats/results not asked');
  }

  /* ---- championships (the league calendar's official cousin) ------------ */
  report('championships-active', await call('GET', 'api/v1/championships/active', null, token));
  report('championships-upcoming', await call('GET', 'api/v1/championships/upcoming?esports=false', null, token));
  report('championships-completed', await call('GET', 'api/v1/championships/completed?page=1&take=5', null, token));

  /* ---- service announcements (a notification source we did not have) ---- */
  report('notifications-global', await call('GET', 'api/v1/notifications/global', null, token));

  console.log('\nDone. Read-only throughout; nothing was written to the account.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
