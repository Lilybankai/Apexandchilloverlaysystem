/**
 * scripts/probe-setup-files.js — LMU's setup save/load/delete, proven live.
 * -----------------------------------------------------------------------------
 * The semantics come from the game's OWN UI bundle (Bin/UI.zip →
 * start/assets/app-*.js), which is the authority on this API:
 *
 *   function saveSetup(folderAndName)  { return postText(`…garage/setup`, folderAndName) }
 *   function loadSetup(folderAndName)  { return putText (`…garage/setup`, folderAndName) }
 *   function deleteSetup(folderAndName){ return del(`…garage/setup/${folderAndName}`) }
 *   function refreshSetups()           { return postJson(`…garage/refreshsetups`, null) }
 *   function toggleSymmetric(b)        { return putJson(`…garage/`, { symmetric: b }) }
 *
 * So: SAVE is POST, LOAD is PUT (the reverse of the obvious guess), and the
 * body is the RAW folder-and-name text — "Spa\MYSETUP" — not a JSON string.
 * A load of a name that does not exist returns 200 and does nothing, which is
 * why guessed spellings look like successes while proving nothing.
 *
 * Self-cleaning protocol, run with LMU in the garage:
 *   1. POST (save) the CURRENT setup as <Track>\APEX_PROBE_BACKUP → file appears
 *   2. nudge the rear wing one step and confirm it moved
 *   3. PUT (load) the backup → the wing reverts, garage restored by construction
 *   4. DELETE the probe file
 *
 * Run: node scripts/probe-setup-files.js
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const LMU_PORT = Number(process.env.APEX_LMU_PORT || 6397);
const PROBE_NAME = 'APEX_PROBE_BACKUP';

function req(method, urlPath, body, contentType) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    const r = http.request(
      {
        host: '127.0.0.1',
        port: LMU_PORT,
        path: urlPath,
        method,
        timeout: 5000,
        headers: payload
          ? { 'Content-Type': contentType || 'text/plain', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    r.on('timeout', () => {
      r.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
    if (payload) r.write(payload);
    r.end();
  });
}

const getJson = async (p) => {
  const r = await req('GET', p);
  try {
    return JSON.parse(r.body);
  } catch {
    return null;
  }
};

function settingsDir() {
  const roots = ['C:\\Program Files (x86)\\Steam\\steamapps\\common\\Le Mans Ultimate'];
  if (process.env.APEX_LMU_DIR) roots.unshift(process.env.APEX_LMU_DIR);
  for (const root of roots) {
    const dir = path.join(root, 'UserData', 'player', 'Settings');
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

async function wing() {
  const g = await getJson('/rest/garage/getPlayerGarageData');
  if (!g || !g.VM_REAR_WING) return null;
  return { value: g.VM_REAR_WING.value, text: g.VM_REAR_WING.stringValue, max: g.VM_REAR_WING.maxValue - 1 };
}

async function main() {
  const dir = settingsDir();
  if (!dir) {
    console.error('Settings dir not found — set APEX_LMU_DIR.');
    process.exit(1);
  }

  const w0 = await wing();
  if (!w0) {
    console.error('Garage not answering — is LMU in the garage?');
    process.exit(1);
  }
  console.log(`Rear wing now: ${w0.value} '${w0.text}'`);

  // The save target folder is the track's Settings subfolder. The sim's list
  // uses "Track\Name" — find the track folder by asking the setups list what
  // folder the sim itself files things under (first entry's prefix), falling
  // back to a directory scan match against the session's track name.
  const list = await getJson('/rest/garage/setup');
  const prefixes = new Set(
    (Array.isArray(list) ? list : [])
      .map((e) => (e && typeof e.name === 'string' ? e.name.split('\\')[0] : ''))
      .filter(Boolean),
  );
  console.log(`Sim setup folders in list: ${[...prefixes].join(', ') || '(none)'}`);
  // With one track loaded the relevant folder is the one whose dir the sim
  // would save into — LMU lists ALL folders, so probe with each candidate that
  // has a matching directory until the file lands (normally the first try).
  const candidates = [...prefixes].filter((p) => fs.existsSync(path.join(dir, p)));

  let savedAs = null;
  for (const folder of candidates.length ? candidates : ['']) {
    const name = folder ? `${folder}\\${PROBE_NAME}` : PROBE_NAME;
    const file = path.join(dir, folder, `${PROBE_NAME}.svm`);
    const r = await req('POST', '/rest/garage/setup', name);
    await new Promise((res) => setTimeout(res, 600));
    const exists = fs.existsSync(file);
    console.log(`POST setup (save) '${name}': HTTP ${r.status}  file: ${exists ? 'CREATED' : 'no'}`);
    if (exists) {
      savedAs = { name, file };
      break;
    }
  }
  if (!savedAs) {
    console.error('Save produced no file under any candidate folder — stopping, nothing changed.');
    process.exit(1);
  }
  console.log(`\n>> SAVE works: ${savedAs.file}`);

  const nudged = w0.value + (w0.value < w0.max ? 1 : -1);
  await req('POST', '/rest/garage/VM_REAR_WING', JSON.stringify({ value: nudged }), 'application/json');
  const w1 = await wing();
  console.log(`\nNudged wing to ${w1.value} '${w1.text}' (was ${w0.value})`);

  const r2 = await req('PUT', '/rest/garage/setup', savedAs.name);
  await new Promise((res) => setTimeout(res, 800));
  const w2 = await wing();
  console.log(`PUT setup (load) '${savedAs.name}': HTTP ${r2.status}  wing now ${w2.value} '${w2.text}'`);
  if (w2.value !== w0.value) {
    await req('POST', '/rest/garage/VM_REAR_WING', JSON.stringify({ value: w0.value }), 'application/json');
    console.error('\nLOAD did not restore — wing restored manually. Investigate before building on this.');
    process.exit(1);
  }
  console.log('\n>> LOAD works, and restored the pre-probe garage by construction.');

  const r3 = await req('DELETE', `/rest/garage/setup/${encodeURI(savedAs.name)}`);
  await new Promise((res) => setTimeout(res, 400));
  const gone = !fs.existsSync(savedAs.file);
  console.log(`\nDELETE '${savedAs.name}': HTTP ${r3.status}  file gone: ${gone}`);
  console.log(gone ? '\n>> DELETE works. Probe complete, everything cleaned up.' : '\nDELETE left the file — remove by hand (harmless).');
}

main();
