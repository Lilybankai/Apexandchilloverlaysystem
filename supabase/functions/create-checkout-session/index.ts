// create-checkout-session — start the £4.99/month subscription for the caller.
// -----------------------------------------------------------------------------
// Called by the desktop app (main process) with the driver's JWT. Creates (or
// reuses) the Stripe customer for this account, then answers with a hosted
// Checkout URL the app opens in the system browser. The 7-day card-upfront
// trial is granted ONLY on a first-ever subscription: an account that has held
// one before re-subscribes at full price, so cancel/resubscribe can't farm
// trials. The card is taken at Checkout, so day 8 bills itself.
//
// Secrets (supabase secrets set):
//   STRIPE_SECRET_KEY  — a RESTRICTED key (rk_...) with Checkout, Customers,
//                        Subscriptions and Billing Portal write access, plus
//                        Coupons READ once referrals are on.
//   STRIPE_PRICE_ID    — the £4.99/month price.
//   REFERRAL_COUPON_ID — optional. The one Stripe coupon behind every partner
//                        referral code (10% off, duration: forever). Unset means
//                        referrals simply do not discount; see below.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected by
// the platform.
//
// ## Referrals (migration 0023)
// A driver who redeemed a partner's code has a row in `referral_attributions`.
// If they do, the Checkout Session carries that one shared coupon, so the
// discount is already applied when they arrive at Stripe and there is nothing
// to type. Stripe allows at most ONE coupon or promotion code per session,
// which is why `allow_promotion_codes` is not also set.
//
// Everything about it is best-effort ON PURPOSE. A missing secret, a wrong or
// deleted coupon, a restricted key without Coupons access, a coupon whose
// `applies_to` excludes this price, a database hiccup — none of them may stop
// someone subscribing. The sale is worth far more than the 10%, so every
// failure path falls through to full price and logs loudly. The discounted
// session is ATTEMPTED and retried without the discount if Stripe refuses it;
// see the comment on that retry for why that is not optional.
// `referral_mark_applied` records that the discount really did reach Stripe,
// so "did it work" is answerable from our own tables without calling Stripe.

import Stripe from 'npm:stripe@22.4.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2026-07-29.dahlia',
});

const RETURN_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/billing-return`;

/**
 * Read a secret, and strip what a dashboard paste tends to bring with it.
 *
 * `REFERRAL_COUPON_ID` was once set to `nFT2oPb9 ` — one trailing space, from
 * copying the id out of the Stripe dashboard. Stripe rejected the id, the retry
 * below caught it, and the customer was charged full price after a landing page
 * had promised them 10%. Nothing was broken enough to notice; it just quietly
 * did not work.
 *
 * An id is never legitimately surrounded by whitespace or quotes, so there is
 * nothing to lose by removing them and a silent, self-inflicted failure to
 * avoid. Applied to the price id too — same class of paste, and that one would
 * break checkout for everybody rather than just costing a discount.
 */
function secret(name: string): string {
  return (Deno.env.get(name) ?? '').trim().replace(/^['"]+|['"]+$/g, '');
}

// Alive subscription states; mirrors entitlement_status() in Postgres.
const LIVE = new Set(['trialing', 'active', 'past_due']);

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }

  // Identify the caller from the JWT the app sent.
  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: auth } } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: 'Not signed in.' }, 401);

  // Service-role client for the billing row (clients have no write policy).
  const db = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const { data: row } = await db
    .from('billing_subscriptions')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (row && LIVE.has(row.status)) {
    // Already paying (or trialing) — nothing to buy. The app just refreshes.
    return json({ alreadySubscribed: true });
  }

  // Reuse the Stripe customer across attempts so Stripe sees one person.
  let customerId = row?.stripe_customer_id ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;
    await db.from('billing_subscriptions').upsert({
      user_id: user.id,
      stripe_customer_id: customerId,
      status: row?.status ?? 'none',
      updated_at: new Date().toISOString(),
    });
  }

  // First subscription ever → 7-day trial. Anything on record → no trial.
  const firstTime = !row?.stripe_subscription_id;

  // Did this driver redeem a partner's referral code? Never fatal — see the
  // header note. `referral_for_checkout` is service-role only and answers with
  // the code, or `{ ok: false }` if there is none or the partner was revoked.
  const referral = await lookupReferral(db, user.id);
  const couponId = secret('REFERRAL_COUPON_ID');
  const applyCoupon = Boolean(referral && couponId);

  /** The session, minus the discount. Built once and reused by the retry. */
  const baseParams = {
    mode: 'subscription' as const,
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: secret('STRIPE_PRICE_ID'), quantity: 1 }],
    subscription_data: {
      ...(firstTime ? { trial_period_days: 7 } : {}),
      metadata: {
        supabase_user_id: user.id,
        // Stamped on the subscription so a Stripe-side report can answer
        // "which partner brought this one in" without joining our database.
        ...(referral ? { referral_code: referral } : {}),
      },
    },
    success_url: `${RETURN_URL}?outcome=success`,
    cancel_url: `${RETURN_URL}?outcome=cancel`,
    integration_identifier: 'apex-desktop-checkout-rvqkhzwd',
  };

  /*
   * Try WITH the coupon, and fall back to full price if Stripe refuses it.
   *
   * This retry is the difference between the referral being best-effort and
   * only claiming to be. Everything earlier in this function degrades quietly,
   * but `sessions.create` does NOT: a coupon id that no longer exists, a typo
   * in the secret, a restricted key without Coupons access, or a coupon whose
   * `applies_to` excludes this price all make Stripe throw — and that throw
   * would break checkout for exactly the people a partner just sent us. The
   * one group who must not hit a wall.
   *
   * At most one coupon or promotion code per session (Stripe), which is why
   * `allow_promotion_codes` is not set alongside it.
   */
  let session = null;
  let discounted = false;

  if (applyCoupon) {
    try {
      session = await stripe.checkout.sessions.create({
        ...baseParams,
        discounts: [{ coupon: couponId }],
      });
      discounted = true;
    } catch (err) {
      // Loud, because someone was promised 10% on a landing page and is about
      // to be charged £4.99. This is the line to grep for after changing the
      // coupon or rotating the key.
      console.error(
        `[referral] Stripe refused coupon ${couponId} for ${user.id} (code ${referral}): ` +
          `${err instanceof Error ? err.message : String(err)} — retrying at full price.`,
      );
      session = null;
    }
  }

  if (!session) {
    session = await stripe.checkout.sessions.create(baseParams);
  }

  // Record that the discount actually reached Stripe. After the session is
  // created, so this can never be the thing that fails the checkout.
  if (discounted) {
    try {
      await db.rpc('referral_mark_applied', { p_user_id: user.id });
    } catch (err) {
      console.error('[referral] could not stamp applied_at:', err);
    }
  } else if (referral && !couponId) {
    // A partner sent someone and there is no coupon configured at all.
    console.error(
      `[referral] ${user.id} redeemed ${referral} but REFERRAL_COUPON_ID is unset — charged full price.`,
    );
  }

  return json({ url: session.url, referral: discounted ? referral : null });
});

/**
 * The partner code this driver redeemed, or null.
 *
 * Swallows everything. A referral is a discount, not an entitlement: if this
 * cannot be answered the driver subscribes at full price, which is a worse
 * deal for them and a better one for us — the unacceptable outcome is not
 * being able to subscribe at all.
 */
async function lookupReferral(
  db: ReturnType<typeof createClient>,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc('referral_for_checkout', { p_user_id: userId });
    if (error) {
      console.error('[referral] lookup failed:', error.message);
      return null;
    }
    return data && (data as { ok?: boolean; code?: string }).ok
      ? ((data as { code?: string }).code ?? null)
      : null;
  } catch (err) {
    console.error('[referral] lookup threw:', err);
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
