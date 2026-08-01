#!/usr/bin/env node
/**
 * Bake the Google OAuth desktop client into the build.
 *
 * `electron/chatLink.js` resolves the client from the environment first, then
 * from the file this script writes. On the build machine the env vars exist; on
 * a streamer's PC they do not, which is why the values have to travel inside the
 * package or YouTube linking is unavailable to everyone but the builder.
 *
 * The generated file is gitignored on purpose. The repo is public, and while a
 * desktop client's id and secret are not confidential (the flow is PKCE on a
 * loopback redirect, so neither can be exchanged for anyone's token), a
 * committed `GOCSPX-` string is found by scanners and auto-revoked — which would
 * break linking for every install until someone noticed.
 *
 * Run automatically by `npm run app:dist`. Missing credentials are a warning
 * rather than an error: a build without them is still a valid build, it just
 * ships with Twitch-only chat.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'electron', 'oauth-client.generated.json');

const clientId = (process.env.APEX_GOOGLE_CLIENT_ID || '').trim();
const clientSecret = (process.env.APEX_GOOGLE_CLIENT_SECRET || '').trim();

if (!clientId || !clientSecret) {
  console.warn(
    '[oauth] APEX_GOOGLE_CLIENT_ID / APEX_GOOGLE_CLIENT_SECRET not set — building\n' +
      '[oauth] without a baked Google client. Twitch chat is unaffected; YouTube\n' +
      '[oauth] linking will report "not available on this build" for every install.',
  );
  // Write an empty client rather than leaving a stale one from a previous build.
  fs.writeFileSync(OUT, JSON.stringify({ clientId: '', clientSecret: '' }, null, 2) + '\n');
  process.exit(0);
}

fs.writeFileSync(OUT, JSON.stringify({ clientId, clientSecret }, null, 2) + '\n');

// Never print the secret; the id's tail is enough to tell two projects apart.
const tail = clientId.slice(0, 12);
console.log(`[oauth] baked Google client ${tail}… into ${path.relative(process.cwd(), OUT)}`);
