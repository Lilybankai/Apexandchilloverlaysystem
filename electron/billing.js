/**
 * electron/billing.js — is this account allowed to use the app?
 * -----------------------------------------------------------------------------
 * The app is paid (£4.99/month, 7-day trial) with two free paths: an admin
 * comp (league racers, beta testers) or a live Stripe subscription. The truth
 * lives server-side — entitlement_status() in Postgres, written by the Stripe
 * webhook and the admin RPCs — and this module is the app's only reader of it.
 *
 * Like auth.js it runs in the MAIN process only. It adds one thing on top of
 * the RPC: a small on-disk cache with a grace window, so a driver whose
 * internet is down on race morning is not locked out of overlays they have
 * paid for. The cache can only ever extend access that the server has already
 * confirmed — it never grants it — and it is cleared the moment the server
 * answers "no" or the account signs out.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * How long a confirmed "entitled" survives with no successful re-check. Long
 * enough for an offline race weekend, short enough that a cancelled card does
 * not ride for free all month.
 */
const GRACE_MS = 72 * 60 * 60 * 1000;

let auth = null; // electron/auth.js, injected
let userDataDir = null;
let onChange = null; // pushes the fresh snapshot to the renderer

/** Last server answer + when it landed: `{ ...entitlement, checkedAt }`. */
let cached = null;

/** In-flight refresh, so focus spam collapses into one network call. */
let inFlight = null;

function init(opts) {
  auth = opts.auth;
  userDataDir = opts.userDataDir;
  onChange = opts.onChange || null;
  cached = readCache();
}

function cachePath() {
  return path.join(userDataDir || '.', 'billing.json');
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (raw && typeof raw.checkedAt === 'number') return raw;
  } catch {
    /* first run, or hand-edited — treat as never checked */
  }
  return null;
}

function writeCache() {
  try {
    if (cached) fs.writeFileSync(cachePath(), JSON.stringify(cached, null, 2), 'utf8');
    else fs.rmSync(cachePath(), { force: true });
  } catch (err) {
    console.error('[billing] could not persist cache:', err.message);
  }
}

/** Entitled right now, counting the offline grace window. */
function entitledNow() {
  if (!cached || !cached.entitled) return false;
  return Date.now() - cached.checkedAt < GRACE_MS;
}

/** The shape the renderer sees. Never tokens, never raw rows. */
function snapshot() {
  const c = cached || {};
  return {
    entitled: entitledNow(),
    source: c.source || null, // 'stripe' | 'free' | null
    freeReason: c.freeReason || null,
    status: c.status || 'none',
    cancelAtPeriodEnd: !!c.cancelAtPeriodEnd,
    trialEnd: c.trialEnd || null,
    currentPeriodEnd: c.currentPeriodEnd || null,
    hasCustomer: !!c.hasCustomer,
    checkedAt: c.checkedAt || 0,
  };
}

/**
 * Ask the server. `maxAgeMs` short-circuits to the cache when the last good
 * answer is fresh enough — the window-focus hook calls this a lot, and one
 * check per half-minute is plenty. A NETWORK failure keeps the cache (that is
 * the entire point of the grace window); a real "no" or a signed-out answer
 * replaces it immediately.
 */
async function refresh({ maxAgeMs = 0 } = {}) {
  if (cached && maxAgeMs > 0 && Date.now() - cached.checkedAt < maxAgeMs) {
    return snapshot();
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await auth.rpc('entitlement_status', {});
      if (res.ok && res.body && typeof res.body === 'object') {
        const b = res.body;
        cached = {
          entitled: !!b.entitled,
          source: b.source || null,
          freeReason: b.freeReason || null,
          status: b.status || 'none',
          cancelAtPeriodEnd: !!b.cancelAtPeriodEnd,
          trialEnd: b.trialEnd || null,
          currentPeriodEnd: b.currentPeriodEnd || null,
          hasCustomer: !!b.hasCustomer,
          checkedAt: Date.now(),
        };
        writeCache();
        if (onChange) onChange(snapshot());
      } else if (res.signedOut) {
        clear();
      }
      // else: network blip — keep whatever we knew; the grace window decides.
      return snapshot();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Signed out (or switching accounts): the cache belongs to nobody now. */
function clear() {
  cached = null;
  writeCache();
  if (onChange) onChange(snapshot());
}

/**
 * Start Checkout: `{ ok, url? , alreadySubscribed? }`. The URL is opened in
 * the system browser by the caller (main.js) — payment never happens in-app.
 */
async function checkoutUrl() {
  const res = await auth.functionsInvoke('create-checkout-session', {});
  if (!res.ok) {
    return {
      ok: false,
      signedOut: !!res.signedOut,
      error: res.signedOut ? 'Sign in first.' : res.error || 'Could not start checkout.',
    };
  }
  const body = res.body || {};
  if (body.alreadySubscribed) return { ok: true, alreadySubscribed: true };
  if (!body.url) return { ok: false, error: 'Checkout did not answer with a payment page.' };
  return { ok: true, url: body.url };
}

/** Open the Stripe Customer Portal: `{ ok, url? }`. */
async function portalUrl() {
  const res = await auth.functionsInvoke('create-portal-session', {});
  if (!res.ok) {
    return {
      ok: false,
      signedOut: !!res.signedOut,
      error: res.signedOut ? 'Sign in first.' : res.error || 'Could not open the billing page.',
    };
  }
  const body = res.body || {};
  if (!body.url) return { ok: false, error: 'The billing page did not answer.' };
  return { ok: true, url: body.url };
}

/** Redeem a league voucher code, then re-check entitlement on success. */
async function redeemCode(code) {
  const text = typeof code === 'string' ? code.trim() : '';
  if (!text) return { ok: false, error: 'Type the code first.' };
  const res = await auth.rpc('redeem_league_code', { p_code: text.slice(0, 40) });
  if (!res.ok) {
    return {
      ok: false,
      signedOut: !!res.signedOut,
      error: res.signedOut ? 'Sign in first.' : res.error || 'Could not check that code.',
    };
  }
  const body = res.body || {};
  if (!body.ok) return { ok: false, error: body.error || 'That code was not accepted.' };
  await refresh({ maxAgeMs: 0 });
  return { ok: true };
}

module.exports = {
  init,
  refresh,
  snapshot,
  entitledNow,
  clear,
  checkoutUrl,
  portalUrl,
  redeemCode,
  GRACE_MS,
};
