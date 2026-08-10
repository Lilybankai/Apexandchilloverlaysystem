/* Smoke-test dist/telemetry/raceosRanks.js against the live game: feed it the
 * connected-player names from /rest/multiplayer/teams, wait one flush cycle,
 * and print what it resolved. No tokens are printed. */
const http = require('node:http');
const { RaceosRanksClient } = require('../dist/telemetry/raceosRanks.js');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 6397, path, timeout: 4000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

(async () => {
  const teams = await getJson('/rest/multiplayer/teams');
  const names = Object.keys(teams.drivers || {});
  console.log('teams names:', names.length);
  const client = new RaceosRanksClient(6397, true);
  client.start();
  client.noteNames(names);
  // One flush interval is 30 s; wait it out plus slack.
  await new Promise((r) => setTimeout(r, 36_000));
  let resolved = 0;
  for (const n of names) {
    const r = client.get(n);
    if (r) {
      resolved += 1;
      const dr = r.driver ? r.driver.rank + r.driver.tier : '—';
      const sr = r.safety ? r.safety.rank + r.safety.tier : '—';
      console.log(`  ${n}: DR ${dr}  SR ${sr}`);
    }
  }
  console.log(`resolved ${resolved}/${names.length}`);
  client.stop();
})().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
