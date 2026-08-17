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
// The Twitch app is a PUBLIC client (Device Code Grant): an id only, no secret.
// Optional the same way YouTube linking is — a build without it ships with the
// stream bot's Twitch login unavailable, and everything else intact.
const twitchClientId = (process.env.APEX_TWITCH_CLIENT_ID || '').trim();

if (!twitchClientId) {
  console.warn('[oauth] APEX_TWITCH_CLIENT_ID not set — Twitch (bot) linking will be unavailable in this build.');
}

if (!clientId || !clientSecret) {
  // Always clear the file first, so a failed build can never leave a stale client
  // behind for the next one to pick up and ship by accident.
  fs.writeFileSync(
    OUT,
    JSON.stringify({ clientId: '', clientSecret: '', twitchClientId: '' }, null, 2) + '\n',
  );

  if (process.env.APEX_ALLOW_NO_OAUTH === '1') {
    console.warn(
      '[oauth] no credentials, and APEX_ALLOW_NO_OAUTH=1 — building a Twitch-only\n' +
        '[oauth] package on purpose. YouTube linking will be unavailable in it.',
    );
    process.exit(0);
  }

  // This used to be a warning. A warning scrolls past in build output, and 0.48.0
  // shipped an installer nobody could link YouTube with — the build looked entirely
  // successful. Refusing is the only version of this that works.
  console.error(
    '\n[oauth] REFUSING TO BUILD: no Google OAuth client in the environment.\n' +
      '\n' +
      '  APEX_GOOGLE_CLIENT_ID     ' +
      (clientId ? 'set' : 'MISSING') +
      '\n' +
      '  APEX_GOOGLE_CLIENT_SECRET ' +
      (clientSecret ? 'set' : 'MISSING') +
      '\n' +
      '\n' +
      '  A package built now would install fine and then tell every user that\n' +
      '  "YouTube linking isn\'t available on this build". Twitch would still work.\n' +
      '\n' +
      '  These are read from the environment at build time and are deliberately not\n' +
      '  in git (the repo is public). Two things to check, in order:\n' +
      '\n' +
      '   1. Is this shell older than the variables? They are set at Windows User\n' +
      '      scope, and a shell inherits the environment it was STARTED with — so a\n' +
      '      terminal opened before they were set will never see them. Open a new one,\n' +
      '      or set them inline for this build:\n' +
      '        $env:APEX_GOOGLE_CLIENT_ID="…"; $env:APEX_GOOGLE_CLIENT_SECRET="…"; npm run app:dist\n' +
      '\n' +
      '   2. If this machine has never had them, get them from whoever registered the\n' +
      '      Google Cloud project — see README, "Setting up YouTube linking".\n' +
      '\n' +
      '  To build a Twitch-only package on purpose: APEX_ALLOW_NO_OAUTH=1\n',
  );
  process.exit(1);
}

fs.writeFileSync(OUT, JSON.stringify({ clientId, clientSecret, twitchClientId }, null, 2) + '\n');

// Never print the secret; the id's tail is enough to tell two projects apart.
const tail = clientId.slice(0, 12);
console.log(`[oauth] baked Google client ${tail}… into ${path.relative(process.cwd(), OUT)}`);
if (twitchClientId) {
  console.log(`[oauth] baked Twitch client ${twitchClientId.slice(0, 8)}…`);
}
