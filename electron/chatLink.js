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
/** Read-only is all the chat widget needs — it never posts or manages anything. */
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

/** Refresh the access token this long before it actually expires (seconds). */
const REFRESH_SKEW_SEC = 120;
/** How often to (re)discover the active broadcast's live chat id (ms). */
const REDISCOVER_MS = 60_000;

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
 *   { twitchChannel, youtube: { refresh_token, display_name } }
 * The access token and live chat id are runtime-only and never written.
 */
let store = { twitchChannel: '', youtube: null };

/** Runtime YouTube session (not persisted). */
let yt = { accessToken: '', expiresAt: 0, liveChatId: '', displayName: '' };

/** The re-discovery timer, and a guard so two OAuth flows can't overlap. */
let rediscoverTimer = null;
let linking = false;

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
      youtube:
        raw.youtube && typeof raw.youtube.refresh_token === 'string' && raw.youtube.refresh_token
          ? { refresh_token: raw.youtube.refresh_token, display_name: raw.youtube.display_name || '' }
          : null,
    };
  } catch {
    return { twitchChannel: '', youtube: null };
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
  // network at all; YouTube is brought back to life below if it was linked).
  pushServerConfig();
  if (store.youtube) {
    // Best-effort: refresh the token and find the live chat in the background.
    void maintainYouTube();
  }
  startRediscoverTimer();
  emitChange();
}

/** Whether the YouTube OAuth client is configured at all. */
function youTubeConfigured() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

/**
 * The ONLY shape the renderer receives — never a token. Mirrors auth.js's
 * publicUser discipline.
 */
function stateForUi() {
  return {
    twitchChannel: store.twitchChannel || '',
    twitchLinked: !!store.twitchChannel,
    youTubeConfigured: youTubeConfigured(),
    youTubeLinked: !!(store.youtube && store.youtube.refresh_token),
    youTubeAccount: (store.youtube && store.youtube.display_name) || yt.displayName || '',
    // True once we've actually found an active broadcast to read.
    youTubeLive: !!yt.liveChatId,
  };
}

function emitChange() {
  try {
    onChange(stateForUi());
  } catch (err) {
    console.error('[chatLink] onChange failed:', err.message);
  }
}

/** Forward the current sources to the running server. */
function pushServerConfig() {
  try {
    applyChatConfig({
      twitchChannel: store.twitchChannel || '',
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
    store.youtube = { refresh_token: tokens.refresh_token, display_name: '' };
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
async function maintainYouTube() {
  if (!store.youtube) return;
  const token = await accessToken();
  if (!token) {
    yt.liveChatId = '';
    pushServerConfig();
    emitChange();
    return;
  }
  try {
    const params = new URLSearchParams({
      part: 'snippet',
      broadcastStatus: 'active',
      broadcastType: 'all',
      mine: 'true',
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
      const channel = item && item.snippet && item.snippet.channelTitle ? item.snippet.channelTitle : '';
      const changed = liveChatId !== yt.liveChatId;
      yt.liveChatId = liveChatId;
      if (channel) {
        yt.displayName = channel;
        if (store.youtube) store.youtube.display_name = channel;
        writeStore();
      }
      if (changed) pushServerConfig();
    }
  } catch {
    /* transient — the periodic timer tries again */
  }
  // Always re-push (the access token may have rotated even if the chat id held).
  pushServerConfig();
  emitChange();
}

/** Called by main.js when the server reports YouTube's token expired (401). */
function handleYouTubeAuthError() {
  yt.accessToken = '';
  yt.expiresAt = 0;
  void maintainYouTube();
}

function startRediscoverTimer() {
  if (rediscoverTimer) clearInterval(rediscoverTimer);
  rediscoverTimer = setInterval(() => {
    if (store.youtube) void maintainYouTube();
  }, REDISCOVER_MS);
  rediscoverTimer.unref?.();
}

module.exports = {
  init,
  stateForUi,
  setTwitchChannel,
  linkYouTube,
  unlinkYouTube,
  handleYouTubeAuthError,
  // Exported for tests.
  youTubeConfigured,
};
