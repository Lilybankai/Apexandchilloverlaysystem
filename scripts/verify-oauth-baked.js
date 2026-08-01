#!/usr/bin/env node
/**
 * Verify the packaged app actually contains the Google OAuth client.
 *
 * The bake step (scripts/write-oauth-client.js) checks the *inputs*. This checks the
 * *output*, by reading electron/oauth-client.generated.json back out of the built
 * app.asar. They are not the same check: 0.48.0 shipped an installer that could not
 * link YouTube, and every stage of that build reported success. The only way to know
 * what a package contains is to open it.
 *
 * Runs after electron-builder in `app:dist` and `release`. Exits non-zero if the
 * shipped client is missing or empty, so a broken installer cannot reach a release.
 *
 * Honours APEX_ALLOW_NO_OAUTH=1 for a deliberate Twitch-only package.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Defaults to the package this build just produced; an explicit path lets the guard be
// pointed at any app.asar, which is how it is tested against a known-bad one.
const ASAR =
  process.argv[2] || path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar');
const ENTRY = ['electron', 'oauth-client.generated.json'];

/**
 * Minimal asar reader — enough to pull one small file out. The format is a 4-byte
 * pickle size, a header pickle holding a length-prefixed JSON directory, then the
 * file bodies at offsets relative to the end of that header.
 */
function readFromAsar(asarPath, segments) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    fs.readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);

    // The header is a pickle: a 4-byte payload size, then a length-prefixed string.
    // The JSON therefore starts 8 bytes in, not 4.
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 8);
    const jsonLen = headerBuf.readUInt32LE(4);
    const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLen).toString('utf8'));

    let node = header;
    for (const seg of segments) {
      if (!node.files || !node.files[seg]) return null;
      node = node.files[seg];
    }
    if (node.offset === undefined || node.size === undefined) return null;

    const body = Buffer.alloc(node.size);
    fs.readSync(fd, body, 0, node.size, 8 + headerSize + Number(node.offset));
    return body.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function fail(lines) {
  console.error(`\n[verify] REFUSING TO SHIP:\n\n${lines.join('\n')}\n`);
  process.exit(1);
}

if (!fs.existsSync(ASAR)) {
  // Not a failure worth blocking on: --dir builds and non-Windows targets do not
  // produce this path, and there is nothing to verify if nothing was packaged.
  console.log(`[verify] no packaged app at ${path.relative(process.cwd(), ASAR)} — nothing to check`);
  process.exit(0);
}

let raw;
try {
  raw = readFromAsar(ASAR, ENTRY);
} catch (e) {
  fail([`  Could not read ${ENTRY.join('/')} from the package: ${e.message}`]);
}

if (raw === null) {
  fail([
    `  ${ENTRY.join('/')} is not in the package at all.`,
    '',
    '  electron-builder\'s "files" globs decide what ships. If that list changed,',
    '  the baked client may now be excluded — YouTube linking would be dead in this',
    '  installer while the build reported success.',
  ]);
}

let client;
try {
  client = JSON.parse(raw);
} catch (e) {
  fail([`  The baked client in the package is not valid JSON: ${e.message}`]);
}

const hasId = !!(client.clientId || '').trim();
const hasSecret = !!(client.clientSecret || '').trim();

if (!hasId || !hasSecret) {
  if (process.env.APEX_ALLOW_NO_OAUTH === '1') {
    console.warn('[verify] packaged client is empty, allowed by APEX_ALLOW_NO_OAUTH=1 (Twitch-only build)');
    process.exit(0);
  }
  fail([
    `  The packaged Google OAuth client is empty.  id=${hasId ? 'present' : 'EMPTY'}  secret=${hasSecret ? 'present' : 'EMPTY'}`,
    '',
    '  This installer would tell every user that "YouTube linking isn\'t available',
    '  on this build". This is exactly what shipped as 0.48.0.',
    '',
    '  Set APEX_GOOGLE_CLIENT_ID / APEX_GOOGLE_CLIENT_SECRET and build again — note a',
    '  shell opened before those were set will not have them.',
  ]);
}

// The id is not secret and its head identifies the Cloud project; the secret is only
// ever reported as a length, so build logs stay safe to paste.
console.log(
  `[verify] packaged Google client ${client.clientId.slice(0, 12)}… present ` +
    `(secret ${client.clientSecret.length} chars) — YouTube linking will work in this build`,
);
