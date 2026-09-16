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
    // The overdue-payment fields. Null unless status is past_due; `lockoutAt`
    // is the server's deadline, not one this process works out, so the banner
    // and the entitlement can never disagree about the date.
    pastDueSince: c.pastDueSince || null,
    lockoutAt: c.lockoutAt || null,
    graceDays: typeof c.graceDays === 'number' ? c.graceDays : null,
    amountDuePence: typeof c.amountDuePence === 'number' ? c.amountDuePence : null,
    invoiceUrl: c.invoiceUrl || null,
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
          pastDueSince: b.pastDueSince || null,
          lockoutAt: b.lockoutAt || null,
          graceDays: typeof b.graceDays === 'number' ? b.graceDays : null,
          amountDuePence: typeof b.amountDuePence === 'number' ? b.amountDuePence : null,
          invoiceUrl: b.invoiceUrl || null,
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

/**
 * Redeem whatever kind of code the driver was handed.
 *
 * The subscribe screen has one box, because a driver does not know — and should
 * not have to know — whether the thing someone gave them is a league access
 * code (free access) or a partner referral code (10% off). `redeem_code` in the
 * database routes it and says which it turned out to be, so this stays one
 * round trip and there is one place that decides precedence.
 *
 * Returns `{ ok, kind }` where `kind` is `'league'` or `'referral'`; the
 * referral case also carries `code`, `ownerName` and `percentOff` so the screen
 * can say "Craig's code applied — 10% off" rather than something generic.
 *
 * Entitlement is only re-checked for a league code: that is the one that
 * changes whether the app may be used at all. A referral changes the PRICE of a
 * subscription that has not been bought yet, so there is nothing to re-read.
 */
async function redeemCode(code) {
  const text = typeof code === 'string' ? code.trim() : '';
  if (!text) return { ok: false, error: 'Type the code first.' };
  const res = await auth.rpc('redeem_code', { p_code: text.slice(0, 40) });
  if (!res.ok) {
    return {
      ok: false,
      signedOut: !!res.signedOut,
      error: res.signedOut ? 'Sign in first.' : res.error || 'Could not check that code.',
    };
  }
  const body = res.body || {};
  if (!body.ok) return { ok: false, error: body.error || 'That code was not accepted.' };

  if (body.kind === 'referral') {
    return {
      ok: true,
      kind: 'referral',
      code: body.code || '',
      ownerName: body.ownerName || '',
      percentOff: Number(body.percentOff) || 10,
      alreadyApplied: !!body.alreadyApplied,
    };
  }

  // League access: this one does change entitlement, so re-read it before the
  // screen decides what to show next.
  await refresh({ maxAgeMs: 0 });
  return { ok: true, kind: 'league' };
}

/**
 * The referral discount attached to this account, if any.
 *
 * Read by the subscribe screen so it can show the discount BEFORE the driver
 * commits — a promise made on a landing page should be visible at the moment
 * of paying, not just on the Stripe page after it. Never throws; a driver with
 * none (the common case) gets `{ ok: false }`.
 */
async function referral() {
  try {
    const res = await auth.rpc('my_referral', {});
    if (!res.ok) return { ok: false, signedOut: !!res.signedOut };
    const body = res.body || {};
    return body && body.ok ? body : { ok: false };
  } catch {
    return { ok: false };
  }
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
  referral,
  GRACE_MS,
};
