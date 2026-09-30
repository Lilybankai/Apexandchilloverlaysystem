/**
 * scripts/make-web-schedule-demo.js — the Schedule tab's fixture for the web.
 * -----------------------------------------------------------------------------
 * board.html?demo=1 has no account, so it cannot call schedule_feed_read. This
 * writes web/dev/schedule.json in exactly that RPC's shape, from the same two
 * reads a desktop would publish:
 *
 *   league  — SimGrid, live (electron/simgrid.js).
 *   dailies — this PC's saved daily calendar (the desktop keeps the last good
 *             one in userData/daily-schedule.json), or --dailies <file>, with
 *             circuit outlines from userData/trackoutlines.
 *
 * Both go through forPublish first, so the fixture carries only what the real
 * feed would — "you are entered" cleared.
 *
 *   node scripts/make-web-schedule-demo.js [--dailies <daily-schedule.json>]
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const simgrid = require(path.join(ROOT, 'electron', 'simgrid.js'));
const lmuTrackmaps = require(path.join(ROOT, 'electron', 'lmu-trackmaps.js'));
const core = require(path.join(ROOT, 'electron', 'control-panel', 'schedule-core.js'));

const USER_DATA = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'apex-overlay-system',
);

function dailiesFile() {
  const i = process.argv.indexOf('--dailies');
  if (i > 0) return process.argv[i + 1];
  return path.join(USER_DATA, 'daily-schedule.json');
}

function row(payload, fetchedAt) {
  if (!payload) return null;
  return {
    payload,
    fetched_at: fetchedAt,
    age_sec: Math.round((Date.now() - Date.parse(fetchedAt)) / 1000),
  };
}

async function main() {
  const league = core.forPublish('league', await simgrid.getSchedule({ force: true }));
  if (!league) console.warn('make-web-schedule-demo: SimGrid read failed — no league in the fixture');

  let dailies = null;
  const file = dailiesFile();
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    // The saved copy is stored BEFORE the circuit outlines are drawn on; the
    // desktop publishes after. Decorate from the outline cache (no game needed).
    lmuTrackmaps.init(path.join(USER_DATA, 'trackoutlines'));
    dailies = core.forPublish('dailies', await lmuTrackmaps.decorate(stored.payload));
  } catch (err) {
    console.warn(`make-web-schedule-demo: no daily calendar at ${file} (${err.message})`);
  }

  const out = {
    ok: true,
    league: league ? row(league, league.fetchedAt) : null,
    dailies: dailies ? row(dailies, dailies.fetchedAt) : null,
  };
  const dest = path.join(ROOT, 'web', 'dev', 'schedule.json');
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(
    `make-web-schedule-demo: wrote ${path.relative(ROOT, dest)} ` +
      `(${(fs.statSync(dest).size / 1024).toFixed(1)} KB; league ${league ? 'yes' : 'no'}, dailies ${dailies ? 'yes' : 'no'})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
