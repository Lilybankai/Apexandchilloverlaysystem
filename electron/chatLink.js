/**
 * electron/chatLink.js — streaming-chat account linking (main process).
 * -----------------------------------------------------------------------------
 * Owns the operator's link to their live chat so the overlay's chat widget can
 * show it. Like electron/auth.js, all of it runs in the MAIN process on purpose:
 *
 *   - The control panel's CSP is `default-src 'none'` with `script-src 'self'`
 *     and no `connect-src`, so the renderer cannot run an OAuth flow or reach
 *     Google at all. Doing it here keeps that CSP intact.
 *   - The Google refresh token never touches the renderer or the browser. The
 *     panel only ever sees the sanitised state from {@link stateForUi} (linked
 *     or not, the account name, the channel) — never a credential.
 *
 * The two platforms are deliberately asymmetric, mirroring the server hub:
 *
 *   - **Twitch** is read anonymously by the server (IRC as a `justinfan` guest),
 *     so linking Twitch is nothing more than remembering a channel name. No
 *     OAuth, no token, no Google-style consent — just a string this module
 *     persists and forwards to the server.
 *   - **YouTube** has no anonymous read, so it needs Google OAuth. This module
 *     runs the installed-app loopback + PKCE flow, stores the refresh token,
 *     keeps a fresh access token, discovers the active broadcast's liveChatId,
 *     and hands {liveChatId, accessToken} to the server. The server polls; this
 *     module keeps the credential alive.
 *
 * Nothing here imports the server — main.js passes an `applyChatConfig` callback
 * that forwards to the running server's `setChatConfig()`, the same way
 * lapUpload is handed the pieces it needs. That keeps this module testable and
 * indifferent to whether the server is up yet.
 *
 * ## Configuring Google OAuth
 * A Google Cloud "Desktop app" OAuth client is required for the YouTube half.
 * Its client id (and the non-secret desktop client secret Google issues) are
 * read from `APEX_GOOGLE_CLIENT_ID` / `APEX_GOOGLE_CLIENT_SECRET`, or the two
 * constants below if you prefer to bake them into a build. Until one is set,
 * {@link stateForUi} reports `youTubeConfigured: false` and the panel shows the
 * Twitch field only — Twitch never depends on this.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const { shell } = require('electron');

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Google OAuth "Desktop app" client, resolved in three steps: the environment
 * first, then the client baked into the build, then nothing.
 *
 * The baked file is written by `scripts/write-oauth-client.js` at package time
 * from the same two env vars, and is NOT in git — this repo is public, and a
 * committed credential gets found and auto-revoked by scanners even though it
 * is harmless. Shipping it inside the build is what makes YouTube linking work
 * on a machine that has never heard of this Cloud project; without it every
 * installed copy but the build machine's shows "YouTube linking isn't available
 * on this build".
 *
 * Neither value is confidential for an installed app — the flow is PKCE on a
 * loopback redirect, so possession of them cannot yield anyone's token. That is
 * why they may ship at all. See README, "Setting up YouTube linking".
 */
function bakedClient() {
  try {
    // eslint-disable-next-line global-require
    return require('./oauth-client.generated.json');
  } catch {
    return {};
  }
}

const baked = bakedClient();
const GOOGLE_CLIENT_ID = process.env.APEX_GOOGLE_CLIENT_ID || baked.clientId || '';
const GOOGLE_CLIENT_SECRET =
  process.env.APEX_GOOGLE_CLIENT_SECRET || baked.clientSecret || '';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
/**
 * The chat widget only reads, but the stream bot types replies into the live
 * chat, and `liveChatMessages.insert` needs the full scope. Links made before
 * this scope change keep working for reading; `youTubeNeedsRelink` in
 * {@link stateForUi} is what tells the panel to ask for a re-consent before
 * the bot may speak.
 */
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

/* ----- Twitch (Device Code Grant — a public client, so no secret at all) ---- */

const TWITCH_CLIENT_ID = process.env.APEX_TWITCH_CLIENT_ID || baked.twitchClientId || '';
const TWITCH_DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
/**
 * chat:read + chat:edit are what let the bot sit on the IRC socket as the
 * streamer and type. channel:read:subscriptions is requested now (unused until
 * the EventSub follower/sub work lands) so nobody has to relink for it later.
 */
const TWITCH_SCOPES = 'chat:read chat:edit channel:read:subscriptions';
/** Twitch requires apps to validate their token at least hourly. */
const TWITCH_VALIDATE_MS = 3600_000;

/** Refresh the access token this long before it actually expires (seconds). */
const REFRESH_SKEW_SEC = 120;

/**
 * How often the maintenance tick runs (ms). The tick itself is free — it only
 * refreshes the Google access token when it is close to expiring, and the OAuth
 * token endpoint costs no YouTube quota at all.
 */
const MAINTAIN_MS = 60_000;

/**
 * How often to go looking for a broadcast **when none is live** (ms).
 *
 * This used to be the same 60s as the maintenance tick, and it called
 * `liveBroadcasts.list` every single time — including while a chat was already
 * live and the answer could not change, and including all night with the app
 * merely open. At 1 quota unit a call that is 1,440 units a day PER INSTALL,
 * ~14% of the whole project's 10,000/day burnt by an app doing nothing.
 *
 * Now discovery happens only when there is something to discover: every five
 * minutes while nothing is on air (288 units/day), never while a chat is
 * already streaming, and immediately when the server reports that chat ended.
 * Five minutes is the worst case for chat appearing after you go live, which is
 * a fair trade for an 80% cut in the idle burn.
 */
const DISCOVER_IDLE_MS = 300_000;

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

/** Injected by init(): app.getPath('userData'). */
let userDataDir = null;
/** Push sanitised state to the renderer. */
let onChange = () => {};
/** Forward {twitchChannel, youTubeLiveChatId, youTubeAccessToken} to the server. */
let applyChatConfig = () => {};

/**
 * Persisted, on disk at <userData>/chatlink.json (0600, like session.json):
 *   { twitchChannel,
 *     twitch:  { refresh_token, login, display_name, scopes[] },
 *     youtube: { refresh_token, display_name, scopes[] } }
 * Access tokens and the live chat id are runtime-only and never written. The
 * `scopes` arrays are what tell an old link from a current one: a youtube slot
 * without force-ssl (or with no scopes at all — pre-bot builds wrote none) can
 * read chat but not send, and the panel shows a relink prompt.
 */
let store = { twitchChannel: '', twitch: null, youtube: null };

/** Runtime YouTube session (not persisted). */
let yt = { accessToken: '', expiresAt: 0, liveChatId: '', displayName: '' };

/** Runtime Twitch session (not persisted). */
let tw = { accessToken: '', expiresAt: 0, lastValidateAt: 0 };

/**
 * A device-code link in progress — the panel shows `userCode` and where to type
 * it while we poll Twitch for the operator's approval.
 */
let twLink = { pending: false, userCode: '', verificationUri: '' };

/** The maintenance timer, and guards so two OAuth flows can't overlap. */
let maintainTimer = null;
let linking = false;
let twitchLinking = false;
/** When discovery last actually called liveBroadcasts.list (ms epoch). */
let lastDiscoverAt = 0;

/* -------------------------------------------------------------------------- */
/*  Persistence                                                               */
/* -------------------------------------------------------------------------- */

function storePath() {
  return path.join(userDataDir || '.', 'chatlink.json');
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return {
      twitchChannel: typeof raw.twitchChannel === 'string' ? raw.twitchChannel : '',
      twitch:
        raw.twitch && typeof raw.twitch.refresh_token === 'string' && raw.twitch.refresh_token
          ? {
              refresh_token: raw.twitch.refresh_token,
              login: raw.twitch.login || '',
              display_name: raw.twitch.display_name || '',
              scopes: Array.isArray(raw.twitch.scopes) ? raw.twitch.scopes : [],
            }
          : null,
      youtube:
        raw.youtube && typeof raw.youtube.refresh_token === 'string' && raw.youtube.refresh_token
          ? {
              refresh_token: raw.youtube.refresh_token,
              display_name: raw.youtube.display_name || '',
              // Pre-bot builds wrote no scopes field — that IS the signal the
              // link predates force-ssl and cannot send.
              scopes: Array.isArray(raw.youtube.scopes) ? raw.youtube.scopes : [],
            }
          : null,
    };
  } catch {
    return { twitchChannel: '', twitch: null, youtube: null };
  }
}

function writeStore() {
  if (!userDataDir) return;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
    // The refresh token is a bearer credential; keep it owner-only (matches
    // auth.js). Windows ignores the mode; it costs nothing and matters elsewhere.
    try {
      fs.chmodSync(storePath(), 0o600);
    } catch {
      /* filesystem doesn't support it */
    }
  } catch (err) {
    console.error('[chatLink] could not persist:', err.message);
  }
}

/* -------------------------------------------------------------------------- */
/*  Public: init + sanitised state                                            */
/* -------------------------------------------------------------------------- */

/**
 * Wire the module up. Called once from main.js after app is ready.
 * @param {{userDataDir:string, onChange:function, applyChatConfig:function}} deps
 */
function init(deps) {
  userDataDir = deps.userDataDir;
  onChange = typeof deps.onChange === 'function' ? deps.onChange : () => {};
  applyChatConfig = typeof deps.applyChatConfig === 'function' ? deps.applyChatConfig : () => {};
  store = readStore();
  // Push whatever we already have (a remembered Twitch channel works with no
  // network at all; the OAuth links are brought back to life below).
  pushServerConfig();
  if (store.youtube) {
    // Best-effort: refresh the token and find the live chat in the background.
    void maintainYouTube();
  }
  if (store.twitch) {
    void maintainTwitch();
  }
  startMaintainTimer();
  emitChange();
}

/** Whether the YouTube OAuth client is configured at all. */
function youTubeConfigured() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

/** Whether the Twitch OAuth client is configured at all. */
function twitchConfigured() {
  return !!TWITCH_CLIENT_ID;
}

/** Whether the stored YouTube grant carries the scope the bot needs to send. */
function youTubeCanSend() {
  return !!(store.youtube && Array.isArray(store.youtube.scopes) && store.youtube.scopes.includes(YOUTUBE_SCOPE));
}

/**
 * The ONLY shape the renderer receives — never a token. Mirrors auth.js's
 * publicUser discipline.
 */
function stateForUi() {
  return {
    twitchChannel: store.twitchChannel || '',
    twitchLinked: !!store.twitchChannel,
    // The bot's Twitch login (distinct from the channel being read).
    twitchConfigured: twitchConfigured(),
    twitchAuthed: !!(store.twitch && store.twitch.refresh_token),
    twitchAccount: (store.twitch && (store.twitch.display_name || store.twitch.login)) || '',
    // A device-code link in progress: the panel shows this code.
    twitchLinkPending: twLink.pending
      ? { userCode: twLink.userCode, verificationUri: twLink.verificationUri }
      : null,
    youTubeConfigured: youTubeConfigured(),
    youTubeLinked: !!(store.youtube && store.youtube.refresh_token),
    youTubeAccount: (store.youtube && store.youtube.display_name) || yt.displayName || '',
    // True once we've actually found an active broadcast to read.
    youTubeLive: !!yt.liveChatId,
    // Send capability — what gates the bot's YouTube half in the panel.
    youTubeCanSend: youTubeCanSend(),
    youTubeNeedsRelink: !!(store.youtube && store.youtube.refresh_token) && !youTubeCanSend(),
  };
}

function emitChange() {
  try {
    onChange(stateForUi());
  } catch (err) {
    console.error('[chatLink] onChange failed:', err.message);
  }
}

/** Forward the current sources (and the bot's Twitch identity) to the server. */
function pushServerConfig() {
  try {
    applyChatConfig({
      twitchChannel: store.twitchChannel || '',
      twitchToken: tw.accessToken || '',
      twitchLogin: (store.twitch && store.twitch.login) || '',
      youTubeLiveChatId: yt.liveChatId || '',
      youTubeAccessToken: yt.accessToken || '',
    });
  } catch (err) {
    console.error('[chatLink] applyChatConfig failed:', err.message);
  }
}

/* -------------------------------------------------------------------------- */
/*  Twitch — just a remembered channel                                        */
/* -------------------------------------------------------------------------- */

/**
 * Set (or clear) the Twitch channel. No OAuth: the server reads Twitch chat
 * anonymously, so this is only a persisted string forwarded to the server.
 */
function setTwitchChannel(name) {
  const channel = String(name || '').trim();
  store.twitchChannel = channel;
  writeStore();
  pushServerConfig();
  emitChange();
  return { ok: true, state: stateForUi() };
}

/* -------------------------------------------------------------------------- */
/*  Twitch — Device Code Grant (the bot's login; reading stays anonymous)      */
/* -------------------------------------------------------------------------- */

/**
 * Link the streamer's Twitch account so the bot can type. Device Code Grant is
 * the desktop-app flow Twitch built for exactly this: no client secret, no
 * loopback server — Twitch shows the operator a short code, we open
 * twitch.tv/activate, and poll the token endpoint until they approve.
 *
 * The user code is surfaced through {@link stateForUi} the moment Twitch
 * issues it (the panel renders it while this promise is still pending), and
 * cleared again on any outcome.
 */
async function linkTwitch() {
  if (!twitchConfigured()) {
    return {
      ok: false,
      error: 'Twitch linking isn’t configured on this build (no Twitch client id).',
    };
  }
  if (twitchLinking) return { ok: false, error: 'A Twitch link is already in progress.' };
  twitchLinking = true;
  try {
    const device = await twitchPost(TWITCH_DEVICE_URL, {
      client_id: TWITCH_CLIENT_ID,
      scopes: TWITCH_SCOPES,
    });
    if (!device.device_code || !device.user_code) {
      return { ok: false, error: device.message || 'Twitch did not issue a device code.' };
    }
    twLink = {
      pending: true,
      userCode: device.user_code,
      verificationUri: device.verification_uri || 'https://www.twitch.tv/activate',
    };
    emitChange();
    void shell.openExternal(twLink.verificationUri);

    // Poll at the cadence Twitch asks for, up to the code's lifetime (capped at
    // the same 300 s the Google flow allows an abandoned consent).
    const intervalMs = Math.max(1, Number(device.interval) || 5) * 1000;
    const deadline = Date.now() + Math.min((Number(device.expires_in) || 300) * 1000, 300_000);
    let tokens = null;
    while (Date.now() < deadline) {
      await new Promise((r) => {
        const t = setTimeout(r, intervalMs);
        t.unref?.();
      });
      const res = await twitchPost(TWITCH_TOKEN_URL, {
        client_id: TWITCH_CLIENT_ID,
        scopes: TWITCH_SCOPES,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (res.access_token) {
        tokens = res;
        break;
      }
      const message = String(res.message || '').toLowerCase();
      if (message.includes('pending')) continue;
      if (message.includes('slow down')) continue; // next loop is already a full interval away
      return { ok: false, error: res.message || 'Twitch sign-in was refused.' };
    }
    if (!tokens) return { ok: false, error: 'Timed out waiting for Twitch sign-in.' };

    tw.accessToken = tokens.access_token;
    tw.expiresAt = Math.floor(Date.now() / 1000) + (Number(tokens.expires_in) || 3600);
    tw.lastValidateAt = Date.now();

    // The login is the IRC NICK — validate is the canonical place to get it.
    const who = await twitchValidate(tw.accessToken);
    if (!who || !who.login) {
      tw = { accessToken: '', expiresAt: 0, lastValidateAt: 0 };
      return { ok: false, error: 'Twitch accepted the code but the token failed validation.' };
    }
    store.twitch = {
      refresh_token: tokens.refresh_token || '',
      login: who.login,
      display_name: who.login,
      scopes: Array.isArray(tokens.scope) ? tokens.scope : TWITCH_SCOPES.split(' '),
    };
    // Sensible default: a streamer linking their account almost always wants
    // their own chat read; never overwrite a channel they typed themselves.
    if (!store.twitchChannel) store.twitchChannel = who.login;
    writeStore();
    void fetchTwitchDisplayName();
    pushServerConfig();
    return { ok: true, state: stateForUi() };
  } catch (err) {
    return { ok: false, error: err.message || 'Twitch linking failed.' };
  } finally {
    twitchLinking = false;
    twLink = { pending: false, userCode: '', verificationUri: '' };
    emitChange();
  }
}

/** POST a form body to a Twitch OAuth endpoint; always resolves to JSON. */
async function twitchPost(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  return res.json().catch(() => ({}));
}

/** GET /validate — `{login, user_id, …}` on a live token, null on a dead one. */
async function twitchValidate(token) {
  try {
    const res = await fetch(TWITCH_VALIDATE_URL, {
      headers: { Authorization: `OAuth ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null; // network blip — treated as "couldn't check", not "invalid"
  }
}

/** Best-effort: the capitalised display name for the panel (cosmetic only). */
async function fetchTwitchDisplayName() {
  try {
    if (!tw.accessToken || !store.twitch) return;
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: { Authorization: `Bearer ${tw.accessToken}`, 'Client-Id': TWITCH_CLIENT_ID },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;
    const json = await res.json().catch(() => ({}));
    const name = json.data && json.data[0] && json.data[0].display_name;
    if (name && store.twitch) {
      store.twitch.display_name = name;
      writeStore();
      emitChange();
    }
  } catch {
    /* cosmetic */
  }
}

/** Forget the Twitch login. The channel (read anonymously) is left alone. */
function unlinkTwitch() {
  store.twitch = null;
  tw = { accessToken: '', expiresAt: 0, lastValidateAt: 0 };
  writeStore();
  pushServerConfig();
  emitChange();
  return { ok: true, state: stateForUi() };
}

/**
 * A valid Twitch access token, refreshing when near expiry. Twitch ROTATES the
 * refresh token on every use — persisting the new one immediately is what
 * keeps the link alive across restarts; miss it once and the stored token is
 * already burnt. 4xx clears the link (grant revoked), same as the Google path.
 */
async function twitchAccessToken() {
  if (!store.twitch || !store.twitch.refresh_token) return '';
  const now = Math.floor(Date.now() / 1000);
  if (tw.accessToken && tw.expiresAt - REFRESH_SKEW_SEC > now) return tw.accessToken;

  let res;
  try {
    res = await fetch(TWITCH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: store.twitch.refresh_token,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return ''; // a network blip must not unlink mid-stream
  }
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) {
      store.twitch = null;
      tw = { accessToken: '', expiresAt: 0, lastValidateAt: 0 };
      writeStore();
      emitChange();
    }
    return '';
  }
  const json = await res.json().catch(() => ({}));
  tw.accessToken = json.access_token || '';
  tw.expiresAt = Math.floor(Date.now() / 1000) + (Number(json.expires_in) || 3600);
  if (json.refresh_token && store.twitch) {
    store.twitch.refresh_token = json.refresh_token;
    writeStore();
  }
  return tw.accessToken;
}

/**
 * Keep the Twitch link healthy: make sure a fresh token exists, validate it on
 * the hourly cadence Twitch requires, and push it to the server's IRC client.
 */
async function maintainTwitch() {
  if (!store.twitch) return;
  const token = await twitchAccessToken();
  if (!token) {
    pushServerConfig();
    emitChange();
    return;
  }
  if (Date.now() - tw.lastValidateAt >= TWITCH_VALIDATE_MS) {
    const who = await twitchValidate(token);
    tw.lastValidateAt = Date.now();
    if (who === null) {
      // Couldn't check (network) — keep going; next tick tries again.
    } else if (!who.login) {
      // Token is dead ahead of its expiry (revoked). Force one refresh.
      tw.accessToken = '';
      tw.expiresAt = 0;
      await twitchAccessToken();
    }
  }
  // Always re-push: the token may have been minted or rotated above, and the
  // server's setAuth is a no-op when nothing actually changed.
  pushServerConfig();
  emitChange();
}

/** Called by main.js when the server reports Twitch rejected the login. */
function handleTwitchAuthError() {
  tw.accessToken = '';
  tw.expiresAt = 0;
  void maintainTwitch();
}

/* -------------------------------------------------------------------------- */
/*  YouTube — installed-app OAuth (loopback + PKCE)                           */
/* -------------------------------------------------------------------------- */

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Run the Google consent flow: spin up a loopback server for the redirect,
 * open the browser to the consent screen, exchange the returned code (with the
 * PKCE verifier) for tokens, store the refresh token, and bring the live chat
 * up. Resolves `{ ok, error?, state }`.
 */
async function linkYouTube() {
  if (!youTubeConfigured()) {
    return {
      ok: false,
      error:
        'YouTube linking isn’t configured on this build (no Google client id). Twitch still works.',
    };
  }
  if (linking) return { ok: false, error: 'A link is already in progress.' };
  linking = true;
  let server = null;
  try {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url, `http://127.0.0.1`);
          if (!url.pathname.startsWith('/callback')) {
            res.writeHead(404).end();
            return;
          }
          const returnedState = url.searchParams.get('state');
          const err = url.searchParams.get('error');
          const gotCode = url.searchParams.get('code');
          // A friendly page so the operator knows to switch back to the app.
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<!doctype html><meta charset="utf-8"><title>Apex &amp; Chill</title>' +
              '<body style="font:16px system-ui;background:#0c0e18;color:#f4f6fb;' +
              'display:grid;place-items:center;height:100vh;margin:0">' +
              '<div style="text-align:center"><h2>YouTube ' +
              (err || !gotCode ? 'link cancelled' : 'linked') +
              '</h2><p>You can close this tab and return to Apex Overlay System.</p></div>',
          );
          if (err) return reject(new Error(err));
          if (returnedState !== state) return reject(new Error('State mismatch — link aborted.'));
          if (!gotCode) return reject(new Error('No authorization code returned.'));
          resolve({ code: gotCode, redirectUri: server.__redirectUri });
        } catch (e) {
          reject(e);
        }
      });
      server.on('error', reject);
      // Ephemeral loopback port; Google allows any 127.0.0.1 port for a desktop
      // client, so nothing has to be pre-registered.
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        server.__redirectUri = redirectUri;
        const authUrl =
          `${GOOGLE_AUTH_URL}?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code&scope=${encodeURIComponent(YOUTUBE_SCOPE)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256` +
          `&access_type=offline&prompt=consent&state=${state}`;
        void shell.openExternal(authUrl);
      });
      // Don't wait forever for a consent the operator may have abandoned.
      setTimeout(() => reject(new Error('Timed out waiting for YouTube sign-in.')), 300_000).unref?.();
    });

    const tokens = await exchangeCode(code, verifier, redirectUri);
    if (!tokens.refresh_token) {
      return { ok: false, error: 'Google did not return a refresh token — try again and grant access.' };
    }
    store.youtube = { refresh_token: tokens.refresh_token, display_name: '', scopes: [YOUTUBE_SCOPE] };
    yt.accessToken = tokens.access_token || '';
    yt.expiresAt = Math.floor(Date.now() / 1000) + (Number(tokens.expires_in) || 3600);
    writeStore();
    await maintainYouTube();
    return { ok: true, state: stateForUi() };
  } catch (err) {
    return { ok: false, error: err.message || 'YouTube linking failed.' };
  } finally {
    linking = false;
    if (server) {
      try {
        server.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/** Exchange an auth code (+ PKCE verifier) for tokens. */
async function exchangeCode(code, verifier, redirectUri) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `Token exchange failed (HTTP ${res.status}).`);
  return json;
}

/** Forget the YouTube link (revokes locally; the server stops polling). */
function unlinkYouTube() {
  store.youtube = null;
  yt = { accessToken: '', expiresAt: 0, liveChatId: '', displayName: '' };
  writeStore();
  pushServerConfig();
  emitChange();
  return { ok: true, state: stateForUi() };
}

/**
 * Return a valid access token, refreshing first if it is within REFRESH_SKEW of
 * expiry. Returns '' when unlinked or the refresh token has been revoked (in
 * which case the link is cleared, exactly like auth.js).
 */
async function accessToken() {
  if (!store.youtube || !store.youtube.refresh_token) return '';
  const now = Math.floor(Date.now() / 1000);
  if (yt.accessToken && yt.expiresAt - REFRESH_SKEW_SEC > now) return yt.accessToken;

  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: store.youtube.refresh_token,
    grant_type: 'refresh_token',
  });
  let res;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return ''; // a network blip must not unlink mid-stream
  }
  if (!res.ok) {
    // 4xx means the grant is gone for good; drop it so we stop retrying.
    if (res.status >= 400 && res.status < 500) {
      store.youtube = null;
      writeStore();
      emitChange();
    }
    return '';
  }
  const json = await res.json().catch(() => ({}));
  yt.accessToken = json.access_token || '';
  yt.expiresAt = Math.floor(Date.now() / 1000) + (Number(json.expires_in) || 3600);
  return yt.accessToken;
}

/**
 * Refresh the token, discover the active broadcast's live chat id and the
 * channel name, and push both to the server. Called on link, on the periodic
 * timer, and when the server reports the token expired.
 */
/**
 * The linked channel's name, for the control panel's "Linked as …" line. Kept
 * separate from broadcast discovery because a `liveBroadcasts` snippet has no
 * channelTitle — reading one there always yielded undefined, so the panel showed
 * a blank account even when the link was healthy.
 */
async function fetchChannelTitle(token) {
  try {
    const res = await fetch(`${YOUTUBE_API}/channels?part=snippet&mine=true`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;
    const json = await res.json().catch(() => ({}));
    const item = Array.isArray(json.items) && json.items[0];
    const title = item && item.snippet && item.snippet.title ? item.snippet.title.trim() : '';
    if (!title) return;
    yt.displayName = title;
    if (store.youtube) {
      store.youtube.display_name = title;
      writeStore();
    }
  } catch {
    /* the name is cosmetic; discovery does not depend on it */
  }
}

/**
 * Keep the YouTube link healthy.
 *
 * `discover` decides whether this tick may spend quota looking for a broadcast.
 * Refreshing the token is always free (Google's OAuth endpoint is not part of
 * the YouTube Data API quota), so that half runs every tick; the
 * `liveBroadcasts.list` half is rationed by {@link DISCOVER_IDLE_MS} and skipped
 * outright while a chat is already live.
 *
 * @param {{discover?: boolean, force?: boolean}} [opts]
 */
async function maintainYouTube(opts) {
  if (!store.youtube) return;
  const { discover = true, force = false } = opts || {};
  const token = await accessToken();
  if (!token) {
    yt.liveChatId = '';
    pushServerConfig();
    emitChange();
    return;
  }

  // Already streaming a chat? Then there is nothing to discover — the id cannot
  // change under us, and the server tells us the moment it ends. Just make sure
  // the (possibly rotated) token reaches the server and stop.
  if (yt.liveChatId && !force) {
    pushServerConfig();
    emitChange();
    return;
  }
  if (!discover) {
    pushServerConfig();
    return;
  }
  lastDiscoverAt = Date.now();
  try {
    // `broadcastStatus` already scopes the list to the authorized channel, and the
    // API rejects it alongside `mine` with 400 incompatibleParameters — the two are
    // alternative filters, not a filter plus a qualifier. Sending both made every
    // discovery call fail, which the widget could only report as "awaiting live
    // stream" no matter what was actually on air.
    const params = new URLSearchParams({
      part: 'snippet',
      broadcastStatus: 'active',
      broadcastType: 'all',
      maxResults: '1',
    });
    const res = await fetch(`${YOUTUBE_API}/liveBroadcasts?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      const item = Array.isArray(json.items) && json.items[0];
      const liveChatId = item && item.snippet && item.snippet.liveChatId ? item.snippet.liveChatId : '';
      const changed = liveChatId !== yt.liveChatId;
      yt.liveChatId = liveChatId;
      if (changed) pushServerConfig();
      // A broadcast snippet carries no channelTitle, so the name is asked for
      // separately — once, since it does not change mid-stream.
      if (!yt.displayName) await fetchChannelTitle(token);
    } else {
      // Not fatal, but never silent: a 400/403 here is a bug or a scope problem,
      // and swallowing it is what made this take a live stream to notice.
      const json = await res.json().catch(() => ({}));
      const err = (json && json.error) || {};
      const reason = (err.errors && err.errors[0] && err.errors[0].reason) || 'unknown';
      console.warn(`[chatLink] liveBroadcasts failed: HTTP ${res.status} (${reason}) ${err.message || ''}`);
      yt.liveChatId = '';
    }
  } catch (e) {
    // Transient — the periodic timer tries again — but say so rather than vanish.
    if (e && e.name !== 'AbortError') console.warn(`[chatLink] liveBroadcasts error: ${e.message}`);
  }
  // Always re-push (the access token may have rotated even if the chat id held).
  pushServerConfig();
  emitChange();
}

/** Called by main.js when the server reports YouTube's token expired (401). */
function handleYouTubeAuthError() {
  yt.accessToken = '';
  yt.expiresAt = 0;
  // `force` because the chat id we hold is still good — this is a token problem,
  // not a broadcast problem — but the refreshed token has to reach the server.
  void maintainYouTube({ discover: false, force: true });
}

/**
 * Called by main.js when the server reports the live chat has ended (or its
 * broadcast went offline). This is what replaced polling for a broadcast all
 * day: the one moment the answer can actually have changed, we go and look.
 */
function handleYouTubeChatEnded() {
  yt.liveChatId = '';
  pushServerConfig();
  emitChange();
  void maintainYouTube({ discover: true, force: true });
}

function startMaintainTimer() {
  if (maintainTimer) clearInterval(maintainTimer);
  maintainTimer = setInterval(() => {
    if (store.youtube) {
      // Ration the one call that costs quota: never while a chat is live, and
      // at most once per DISCOVER_IDLE_MS otherwise.
      const due = Date.now() - lastDiscoverAt >= DISCOVER_IDLE_MS;
      void maintainYouTube({ discover: due });
    }
    // Twitch's half is quota-free: token refresh near expiry plus the hourly
    // validate Twitch requires, both inside maintainTwitch's own gates.
    if (store.twitch) void maintainTwitch();
  }, MAINTAIN_MS);
  maintainTimer.unref?.();
}

module.exports = {
  init,
  stateForUi,
  setTwitchChannel,
  linkTwitch,
  unlinkTwitch,
  handleTwitchAuthError,
  linkYouTube,
  unlinkYouTube,
  handleYouTubeAuthError,
  handleYouTubeChatEnded,
  // Exported for tests.
  youTubeConfigured,
  twitchConfigured,
};
