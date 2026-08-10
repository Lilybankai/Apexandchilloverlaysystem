/**
 * scripts/probe-garage-keys.js — the setup editor's key census.
 * -----------------------------------------------------------------------------
 * The setup editor renders whatever `GET /rest/garage/getPlayerGarageData`
 * returns, grouped by `electron/control-panel/setup-groups.js`. That map was
 * frozen from live dumps, and LMU is free to add keys in a patch or expose a
 * different set per car class — so this script answers two questions:
 *
 *   1. What does the CURRENT car actually publish? (every key, with bounds,
 *      the sim's own label, and the locked/absent flags)
 *   2. Does setup-groups.js still account for all of it? Anything the map
 *      misses lands in the editor's catch-all section — visible but homeless —
 *      and gets listed here so it can be given a proper home.
 *
 * Usage — LMU running, player in the garage:
 *   node scripts/probe-garage-keys.js                 census + grouping diff
 *   node scripts/probe-garage-keys.js --save gt3      also write
 *                                                     scripts/fixtures/garage-gt3.json
 *
 * The fixture files feed scripts/test-setup.js, which pins the projection and
 * the macro ladder directions headlessly — capture one per class you drive.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const LMU_PORT = Number(process.env.APEX_LMU_PORT || 6397);

const groups = require('../electron/control-panel/setup-groups.js');

function garage() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: LMU_PORT, path: '/rest/garage/getPlayerGarageData', timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function isSettingShaped(v) {
  return v && typeof v === 'object' && typeof v.value === 'number' && typeof v.maxValue === 'number';
}

async function main() {
  const data = await garage();
  if (!data) {
    console.error(`No response from 127.0.0.1:${LMU_PORT} — is LMU running?`);
    process.exit(1);
  }

  const keys = Object.keys(data).filter((k) => isSettingShaped(data[k]));
  const other = Object.keys(data).filter((k) => !isSettingShaped(data[k]));

  console.log(`${keys.length} setting keys, plus non-setting entries: ${other.join(', ') || '(none)'}\n`);

  const byTab = new Map();
  const homeless = [];
  for (const key of keys) {
    const g = groups.classifyKey(key);
    const v = data[key];
    const flags = [
      v.available === false ? 'ABSENT' : '',
      v.isFreeSetting === false ? 'LOCKED' : '',
      v.stringValue !== v.lastSavedStringValue ? 'DIRTY' : '',
    ]
      .filter(Boolean)
      .join(',');
    const line = `  ${key.padEnd(34)} ${String(v.value).padStart(3)} of ${String(v.minValue)}..${String(v.maxValue - 1)}  '${v.stringValue}'${flags ? `  [${flags}]` : ''}`;
    if (!byTab.has(g.tab)) byTab.set(g.tab, []);
    byTab.get(g.tab).push({ section: g.section, line, explicit: g.explicit });
    if (!g.explicit && !g.pattern) homeless.push(key);
  }

  for (const [tab, rows] of byTab) {
    console.log(`── ${tab} ${'─'.repeat(Math.max(1, 60 - tab.length))}`);
    let section = null;
    for (const r of rows) {
      if (r.section !== section) {
        section = r.section;
        console.log(`  · ${section}`);
      }
      console.log(r.line);
    }
  }

  if (homeless.length) {
    console.log(`\n!! ${homeless.length} key(s) not covered by setup-groups.js (explicit or pattern) —`);
    console.log('   they will render in the catch-all section. Give them homes:');
    for (const k of homeless) console.log(`   - ${k}`);
  } else {
    console.log('\nAll keys accounted for by setup-groups.js.');
  }

  const saveIdx = process.argv.indexOf('--save');
  if (saveIdx >= 0) {
    const name = process.argv[saveIdx + 1];
    if (!name || !/^[a-z0-9-]+$/i.test(name)) {
      console.error('Usage: --save <name>   (e.g. --save gt3, writes scripts/fixtures/garage-gt3.json)');
      process.exit(1);
    }
    const dir = path.join(__dirname, 'fixtures');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `garage-${name.toLowerCase()}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
    console.log(`\nFixture written: ${file}`);
  }
}

main();
