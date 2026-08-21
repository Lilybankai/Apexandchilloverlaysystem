// delete-account — GDPR right-to-erasure: remove the caller's account and data.
// -----------------------------------------------------------------------------
// The caller proves who they are with their own JWT; everything they own is
// then removed in three moves:
//
//   1. Stripe: delete the customer. Stripe cancels any live subscription as a
//      side effect and scrubs the personal data it holds for us; Stripe keeps
//      its own transaction records because tax law obliges *them* to, not us.
//   2. feedback: deleted outright. The FK is only SET NULL, and a free-text
//      message can name its author, so anonymising the user_id isn't enough.
//   3. auth.users: deleted last. Every other user-linked table — profiles,
//      public_drivers, setups (+ ratings/downloads on them), lap_traces,
//      driver_best_laps, driver_activity_days, engineer_calls, app_sessions,
//      billing_subscriptions — hangs off it with ON DELETE CASCADE, so this
//      one delete empties the lot. league_codes keeps its rows but SET NULLs
//      the user references (a redeemed code stays burned).
//
// Order matters: Stripe first, because after the auth user is gone we can no
// longer look up which customer was theirs.

import Stripe from 'npm:stripe@22.4.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }

  // A deliberate second factor: the app must send { confirm: "DELETE" } so a
  // stray replayed request can't erase an account.
  let body: { confirm?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* fall through to the check below */
  }
  if (body.confirm !== 'DELETE') {
    return json({ error: 'Missing confirmation.' }, 400);
  }

  const auth = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: auth } } },
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: 'Not signed in.' }, 401);

  const db = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  // 1. Stripe teardown. A missing key or already-deleted customer must not
  //    strand the erasure, so failures here only abort when Stripe still
  //    holds a live customer we could not remove.
  const { data: billing } = await db
    .from('billing_subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (billing?.stripe_customer_id) {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2026-07-29.dahlia',
    });
    try {
      await stripe.customers.del(billing.stripe_customer_id);
    } catch (err) {
      const alreadyGone =
        err instanceof Stripe.errors.StripeError && err.statusCode === 404;
      if (!alreadyGone) {
        console.error('delete-account: stripe customer delete failed', err);
        return json(
          { error: 'Could not close the billing account — nothing was deleted. Try again shortly.' },
          502,
        );
      }
    }
  }

  // 2. Feedback rows (FK is SET NULL, not CASCADE).
  const { error: fbErr } = await db.from('feedback').delete().eq('user_id', user.id);
  if (fbErr) {
    console.error('delete-account: feedback delete failed', fbErr);
    return json({ error: 'Deletion failed part-way — try again shortly.' }, 500);
  }

  // 3. The auth user; every remaining user-linked row cascades away with it.
  const { error: delErr } = await db.auth.admin.deleteUser(user.id);
  if (delErr) {
    console.error('delete-account: auth delete failed', delErr);
    return json({ error: 'Deletion failed part-way — try again shortly.' }, 500);
  }

  return json({ ok: true });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
