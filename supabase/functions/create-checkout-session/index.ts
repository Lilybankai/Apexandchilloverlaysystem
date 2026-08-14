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
//                        Subscriptions and Billing Portal write access.
//   STRIPE_PRICE_ID    — the £4.99/month price.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected by
// the platform.

import Stripe from 'npm:stripe@22.4.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2026-07-29.dahlia',
});

const RETURN_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/billing-return`;

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

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: Deno.env.get('STRIPE_PRICE_ID') ?? '', quantity: 1 }],
    subscription_data: {
      ...(firstTime ? { trial_period_days: 7 } : {}),
      metadata: { supabase_user_id: user.id },
    },
    success_url: `${RETURN_URL}?outcome=success`,
    cancel_url: `${RETURN_URL}?outcome=cancel`,
    integration_identifier: 'apex-desktop-checkout-rvqkhzwd',
  });

  return json({ url: session.url });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
