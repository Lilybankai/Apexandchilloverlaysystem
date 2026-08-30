/**
 * electron/auth.js — Supabase account handling for the desktop app.
 * -----------------------------------------------------------------------------
 * All of it runs in the MAIN process, on purpose:
 *
 *   - The control panel's CSP is `default-src 'none'` with `script-src 'self'`,
 *     so the renderer can neither load the supabase-js bundle from a CDN nor
 *     talk to supabase.co directly. Keeping auth here leaves that CSP intact.
 *   - Refresh tokens never touch the renderer. The panel only ever sees the
 *     sanitised `user` object returned by the IPC handlers.
 *
 * We speak to GoTrue (Supabase Auth) over plain REST with `fetch`, which Node 18
 * has built in — no new dependency for one login screen.
 *
 * Password reset is deliberately a THREE-step in-app flow (request code → enter
 * code + new password → done) rather than a link out to a website: this is a
 * desktop app with no companion web page to redirect the recovery link to. See
 * `verifyRecovery` for the two token shapes we accept.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

/* -------------------------------------------------------------------------- */
/*  Project configuration                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Apex & Chill Supabase project. The publishable key is designed to ship inside
 * clients — it can only do what Row Level Security allows (see the `profiles`
 * policies). Both values can be overridden by env vars for a staging project.
 */
const SUPABASE_URL = process.env.APEX_SUPABASE_URL || 'https://svtyxuhbsbbodsecbnsc.supabase.co';
const SUPABASE_KEY =
  process.env.APEX_SUPABASE_KEY || 'sb_publishable_Q-0gsoTW_r-AzgKQ6NqNSQ_vGegMK8w';

/**
 * Whitelist of sims we persist against a profile. LMU is the only sim the app
 * reads telemetry from today, so the register screen no longer asks — anything
 * not on this list falls back to the first entry.
 */
const PRIMARY_SIMS = ['rFactor 2 / LMU'];

/** Refresh the access token this long before it actually expires. */
const REFRESH_SKEW_SEC = 60;

/* -------------------------------------------------------------------------- */
/*  Session storage                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The live session, or null when signed out. Held in memory always; mirrored to
 * disk only when the operator ticked "Remember me" (`persist`).
 */
let session = null;
/** In-flight token refresh, shared so concurrent callers cannot race — see
 *  {@link accessToken} for why that race signs the operator out. */
let refreshInFlight = null;

/** Set by main.js — app.getPath('userData'). Kept injectable for tests. */
let userDataDir = null;

/** Called once from main.js after `app.whenReady()`. */
function init(dir) {
  userDataDir = dir;
  session = readStoredSession();
}

function sessionPath() {
  return path.join(userDataDir || '.', 'session.json');
}

/** Load a remembered session from disk, ignoring anything malformed. */
function readStoredSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
    if (raw && typeof raw.refresh_token === 'string' && raw.refresh_token) {
      return { ...raw, persist: true };
    }
  } catch {
    /* first run, or the file was hand-edited — treat as signed out */
  }
  return null;
}

/** Mirror the session to disk (only when remembered) or clear the file. */
function writeStoredSession() {
  if (!userDataDir) return;
  try {
    if (session && session.persist) {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(sessionPath(), JSON.stringify(session, null, 2), 'utf8');
      // The refresh token is a bearer credential; keep it owner-only. Windows
      // ignores the mode, but this costs nothing and matters on macOS/Linux.
      try {
        fs.chmodSync(sessionPath(), 0o600);
      } catch {
        /* not supported on this filesystem */
      }
    } else {
      fs.rmSync(sessionPath(), { force: true });
    }
  } catch (err) {
    console.error('[auth] could not persist session:', err.message);
  }
}

/** Replace the current session from a GoTrue token response. */
function adoptSession(tokens, persist) {
  const expiresAt =
    Number(tokens.expires_at) ||
    Math.floor(Date.now() / 1000) + (Number(tokens.expires_in) || 3600);
  session = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    user: tokens.user || null,
    persist: persist === undefined ? !!(session && session.persist) : !!persist,
  };
  writeStoredSession();
  return session;
}

function clearSession() {
  session = null;
  writeStoredSession();
}

/* -------------------------------------------------------------------------- */
/*  GoTrue REST plumbing                                                      */
/* -------------------------------------------------------------------------- */

/** Human-readable message out of GoTrue's several error shapes. */
function errorMessage(body, res) {
  const raw =
    (body && (body.error_description || body.msg || body.message || body.error)) || '';
  const text = String(raw).trim();
  if (!text) return `Sign-in service error (HTTP ${res.status}).`;

  // GoTrue's wording is developer-facing in a few common cases; soften those.
  if (/invalid login credentials/i.test(text)) return 'That email and password don’t match.';
  if (/email not confirmed/i.test(text)) {
    return 'Your email isn’t confirmed yet — check your inbox for the confirmation link.';
  }
  if (/user already registered|already been registered/i.test(text)) {
    return 'There’s already an account with that email. Try signing in instead.';
  }
  // GoTrue says "Email link is invalid or has expired" for a bad OTP too.
  if (/token has expired|expired.*token|invalid.*token|email link is invalid/i.test(text)) {
    return 'That reset code has expired or isn’t valid. Request a new one.';
  }
  if (/for security purposes|rate limit|too many/i.test(text)) {
    return 'Too many attempts — wait a minute and try again.';
  }
  return text;
}

/**
 * One REST call against the project. Resolves `{ ok, status, body }` and never
 * throws for an HTTP error; network failures become ok:false with a friendly
 * offline message, because "no internet" is the single most likely failure for
 * an app that lives next to a game.
 */
async function api(pathname, { method = 'POST', body, token, headers, timeoutMs } = {}) {
  const url = `${SUPABASE_URL}${pathname}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || 20000),
    });
  } catch (err) {
    const offline = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      status: 0,
      error: offline
        ? 'The account service didn’t respond. Check your connection and try again.'
        : 'Can’t reach the account service — you appear to be offline. You can still use the overlays offline.',
    };
  }

  let parsed = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) return { ok: false, status: res.status, error: errorMessage(parsed, res) };
  return { ok: true, status: res.status, body: parsed || {} };
}

/* -------------------------------------------------------------------------- */
/*  Shapes handed to the renderer                                             */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY user shape the renderer ever sees — no tokens. `initials` is derived
 * here so the panel doesn't have to guess at name splitting.
 */
function publicUser(user) {
  if (!user) return null;
  const meta = user.user_metadata || {};
  const name = (meta.display_name || '').trim() || (user.email || '').split('@')[0] || 'Driver';
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || 'A';
  return {
    id: user.id,
    email: user.email || '',
    displayName: name,
    initials,
    primarySim: meta.primary_sim || '',
    marketingOptIn: !!meta.marketing_opt_in,
    emailConfirmed: !!(user.email_confirmed_at || user.confirmed_at),
  };
}

/** Snapshot of the auth state, safe to send over IPC. */
function stateForUi() {
  return {
    signedIn: !!(session && session.access_token),
    user: publicUser(session && session.user),
    configured: !!(SUPABASE_URL && SUPABASE_KEY),
    primarySims: PRIMARY_SIMS,
  };
}

/* -------------------------------------------------------------------------- */
/*  Input validation (mirrored in the renderer for instant feedback)          */
/* -------------------------------------------------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Minimum we accept — the register screen promises "8+ characters". */
const MIN_PASSWORD = 8;

function badEmail(email) {
  return typeof email !== 'string' || !EMAIL_RE.test(email.trim())
    ? 'Enter a valid email address.'
    : null;
}

function badPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) {
    return `Use at least ${MIN_PASSWORD} characters.`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Public operations                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Sign in with email + password.
 * @returns {Promise<{ok:boolean, error?:string, state?:object}>}
 */
async function signIn({ email, password, remember } = {}) {
  const emailErr = badEmail(email);
  if (emailErr) return { ok: false, error: emailErr, field: 'email' };
  if (!password) return { ok: false, error: 'Enter your password.', field: 'password' };

  const res = await api('/auth/v1/token?grant_type=password', {
    body: { email: String(email).trim(), password },
  });
  if (!res.ok) return { ok: false, error: res.error };

  adoptSession(res.body, remember !== false);
  return { ok: true, state: stateForUi() };
}

/**
 * Create an account. Supabase may or may not return a session depending on the
 * project's "Confirm email" setting, so the caller gets `needsConfirmation` and
 * shows the "check your inbox" state instead of assuming it's signed in.
 */
async function register({ email, password, displayName, primarySim, marketingOptIn } = {}) {
  const emailErr = badEmail(email);
  if (emailErr) return { ok: false, error: emailErr, field: 'email' };
  const pwErr = badPassword(password);
  if (pwErr) return { ok: false, error: pwErr, field: 'password' };
  if (!displayName || !String(displayName).trim()) {
    return { ok: false, error: 'Choose a display name.', field: 'displayName' };
  }

  const sim = PRIMARY_SIMS.includes(primarySim) ? primarySim : PRIMARY_SIMS[0];
  const res = await api('/auth/v1/signup', {
    body: {
      email: String(email).trim(),
      password,
      // Read by the handle_new_user() trigger to seed public.profiles.
      data: {
        display_name: String(displayName).trim().slice(0, 60),
        primary_sim: sim,
        marketing_opt_in: !!marketingOptIn,
      },
    },
  });
  if (!res.ok) return { ok: false, error: res.error };

  // A session in the response means email confirmation is off — go straight in.
  if (res.body && res.body.access_token) {
    adoptSession(res.body, true);
    return { ok: true, needsConfirmation: false, state: stateForUi() };
  }
  return {
    ok: true,
    needsConfirmation: true,
    email: String(email).trim(),
    state: stateForUi(),
  };
}

/** Re-send the signup confirmation email. */
async function resendConfirmation({ email } = {}) {
  const emailErr = badEmail(email);
  if (emailErr) return { ok: false, error: emailErr, field: 'email' };
  const res = await api('/auth/v1/resend', {
    body: { type: 'signup', email: String(email).trim() },
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Step 1 of reset: ask Supabase to email a recovery code/link. */
async function requestReset({ email } = {}) {
  const emailErr = badEmail(email);
  if (emailErr) return { ok: false, error: emailErr, field: 'email' };
  const res = await api('/auth/v1/recover', { body: { email: String(email).trim() } });
  // GoTrue answers 200 whether or not the address exists — that's deliberate
  // (it stops the screen being an account-enumeration oracle), so the UI says
  // "if that address has an account" rather than "sent".
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * Pull a usable recovery token out of whatever the operator pasted.
 *
 * Two shapes arrive in the wild, depending on the project's email template:
 *   - a short one-time code, from a `{{ .Token }}` template  → verify as `token`
 *     (GoTrue hashes email+token to find the user);
 *   - the reset LINK, from the default `{{ .ConfirmationURL }}` template, whose
 *     `token=` query param is already the hashed token → verify as `token_hash`.
 *
 * `kind` records which of the two we think it is; verifyRecovery falls back to
 * the other shape rather than betting the whole flow on this guess.
 */
function parseRecoveryToken(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // A pasted link (or just its query string / fragment).
  if (/[?&#]/.test(raw) || raw.includes('://')) {
    const hash = /[?&#]token_hash=([^&#\s]+)/.exec(raw);
    if (hash) return { kind: 'hash', value: decodeURIComponent(hash[1]) };
    const tok = /[?&#]token=([^&#\s]+)/.exec(raw);
    if (tok) return { kind: 'hash', value: decodeURIComponent(tok[1]) };
    // A `code=` link is the PKCE redirect, which can only be exchanged with the
    // code_verifier the *browser* generated — unusable from here.
    if (/[?&#]code=/.test(raw)) return { kind: 'pkce', value: '' };
    return null;
  }

  // A bare code (letters/digits/dashes, no spaces).
  if (/^[A-Za-z0-9-]{6,}$/.test(raw)) return { kind: 'otp', value: raw };
  return null;
}

/**
 * Step 2 of reset: exchange the recovery token for a session, then set the new
 * password on it. Both halves have to succeed for the operator to be able to
 * sign in, so a failure in the second half is reported as its own error rather
 * than leaving them "reset" but still on the old password.
 */
async function resetPassword({ email, token, password } = {}) {
  const emailErr = badEmail(email);
  if (emailErr) return { ok: false, error: emailErr, field: 'email' };
  const parsed = parseRecoveryToken(token);
  if (!parsed) {
    return {
      ok: false,
      error: 'Paste the code (or the whole reset link) from the email.',
      field: 'token',
    };
  }
  const pwErr = badPassword(password);
  if (pwErr) return { ok: false, error: pwErr, field: 'password' };

  const verified = await verifyRecovery(String(email).trim(), parsed);
  if (!verified.ok) return { ok: false, error: verified.error, field: 'token' };

  // Don't remember a session created purely to change a password — the operator
  // signs in again afterwards and chooses "Remember me" there.
  const tokens = verified.body;
  const updated = await api('/auth/v1/user', {
    method: 'PUT',
    token: tokens.access_token,
    body: { password },
  });
  if (!updated.ok) return { ok: false, error: updated.error, field: 'password' };

  // Drop the recovery session; the flow ends on the sign-in screen.
  await api('/auth/v1/logout', { token: tokens.access_token }).catch(() => {});
  return { ok: true, email: String(email).trim() };
}

/**
 * Verify a recovery token and return the resulting session.
 *
 * Tries the shape parseRecoveryToken guessed, then the other one: telling a
 * hashed link-token from a plain OTP by inspecting the string is guesswork, and
 * a rejected verify doesn't consume the token, so one retry is cheap insurance
 * against sending a perfectly good code to the wrong field.
 */
async function verifyRecovery(email, parsed) {
  if (parsed.kind === 'pkce') {
    return {
      ok: false,
      error:
        'That link can only be opened in a browser. Ask for a new code and paste the code itself.',
    };
  }

  const asHash = { type: 'recovery', token_hash: parsed.value };
  const asOtp = { type: 'recovery', email, token: parsed.value };
  const order = parsed.kind === 'hash' ? [asHash, asOtp] : [asOtp, asHash];

  let last = null;
  for (const body of order) {
    last = await api('/auth/v1/verify', { body });
    if (last.ok) return last;
    // A transport failure (status 0) or a server fault won't be fixed by
    // re-shaping the token — report it straight away.
    if (last.status === 0 || last.status >= 500) return last;
  }
  return last;
}

/** Sign out locally and revoke the refresh token server-side. */
async function signOut() {
  const token = session && session.access_token;
  clearSession();
  if (token) await api('/auth/v1/logout', { token });
  return { ok: true, state: stateForUi() };
}

/**
 * Return a valid access token, refreshing it first if it is within
 * REFRESH_SKEW_SEC of expiry. Returns null when signed out or when the refresh
 * token has been revoked (in which case the session is cleared).
 */
async function accessToken() {
  if (!session || !session.refresh_token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (session.access_token && session.expires_at - REFRESH_SKEW_SEC > now) {
    return session.access_token;
  }
  // One refresh at a time, shared by every caller. Supabase ROTATES the refresh
  // token on use and invalidates the old one, so two callers refreshing at once
  // is not merely wasteful — the loser is handed a 4xx and, by the rule below,
  // signs the operator out. The pit-wall relay publishes and reads on separate
  // 1 Hz timers and the lap uploader runs alongside them, so the moment a token
  // expires mid-race there are several callers on the same tick. That is very
  // likely what dropped team data mid-race at Daytona (2026-08-30) and why
  // restarting the app brought it back.
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const res = await api('/auth/v1/token?grant_type=refresh_token', {
        body: { refresh_token: session.refresh_token },
      });
      if (!res.ok) {
        // A 4xx means the token is gone for good; a network blip must NOT sign
        // the operator out mid-race weekend, so only the former clears it.
        if (res.status >= 400 && res.status < 500) clearSession();
        return null;
      }
      adoptSession(res.body);
      return session ? session.access_token : null;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Call a Postgres function through PostgREST as the signed-in driver.
 *
 * Lives here rather than in the caller because this module already owns the
 * project URL, the publishable key and — the part that actually matters — the
 * token refresh. An uploader that built its own requests would need all three,
 * and would be a second place that could get the credential handling wrong.
 *
 * `signedOut: true` is reported separately from an error: for a background
 * uploader those are completely different situations. One means "wait for the
 * driver to sign in", the other means "try again shortly".
 *
 * @returns `{ ok: true, body }`, or `{ ok: false, error, signedOut?, status }`.
 */
async function rpc(fn, body) {
  const token = await accessToken();
  if (!token) return { ok: false, signedOut: true, error: 'Not signed in.' };
  const res = await api(`/rest/v1/rpc/${fn}`, { body, token });
  // A 401 here means the token was revoked between the refresh above and this
  // call. Report it as signed-out so the caller waits rather than hammering.
  if (!res.ok && res.status === 401) return { ...res, signedOut: true };
  return res;
}

/**
 * Call a Supabase Edge Function as the signed-in driver. Same contract and
 * same reasoning as rpc() above — this module owns the URL, the key and the
 * token refresh, so the billing module doesn't grow its own copy of any of it.
 *
 * @returns `{ ok: true, body }`, or `{ ok: false, error, signedOut?, status }`.
 */
async function functionsInvoke(fn, body, opts) {
  const token = await accessToken();
  if (!token) return { ok: false, signedOut: true, error: 'Not signed in.' };
  const res = await api(`/functions/v1/${fn}`, {
    body: body || {},
    token,
    timeoutMs: opts && opts.timeoutMs,
  });
  if (!res.ok && res.status === 401) return { ...res, signedOut: true };
  return res;
}

/**
 * Called at startup: turn a remembered refresh token into a live session and
 * refresh the cached user. Safe (and cheap) to call when signed out.
 */
async function restore() {
  if (!session) return stateForUi();
  const token = await accessToken();
  if (!token) return stateForUi();
  const res = await api('/auth/v1/user', { method: 'GET', token });
  if (res.ok && res.body && res.body.id) {
    session.user = res.body;
    writeStoredSession();
  }
  return stateForUi();
}

module.exports = {
  init,
  restore,
  stateForUi,
  signIn,
  register,
  resendConfirmation,
  requestReset,
  resetPassword,
  signOut,
  accessToken,
  rpc,
  functionsInvoke,
  // Exported for the offline test script.
  parseRecoveryToken,
  publicUser,
  PRIMARY_SIMS,
  MIN_PASSWORD,
};
