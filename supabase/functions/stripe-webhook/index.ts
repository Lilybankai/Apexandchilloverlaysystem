// stripe-webhook — Stripe tells us about subscription changes; we mirror them
// into billing_subscriptions, which entitlement_status() reads.
// -----------------------------------------------------------------------------
// Deployed with JWT verification OFF (Stripe can't sign our JWTs); the request
// is authenticated by verifying Stripe's signature against
// STRIPE_WEBHOOK_SECRET instead. Always answer 2xx once the event is safely
// handled — anything else makes Stripe retry for days.
//
// Events handled:
//   checkout.session.completed                       → first link of user ⇄ sub
//   customer.subscription.created/updated/deleted    → every later change
//     (trial→active, payment failed→past_due, cancel→canceled, ...)

import Stripe from 'npm:stripe@22.4.0';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2026-07-29.dahlia',
});
// Deno has no Node crypto; Stripe's SubtleCrypto provider does the HMAC.
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return new Response('missing signature', { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '',
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    console.error('[stripe-webhook] bad signature:', (err as Error).message);
    return new Response('bad signature', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id;
        const subId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
        if (userId && subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          await upsertFromSubscription(sub, userId);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await upsertFromSubscription(sub);
        break;
      }
      default:
        // Not ours — acknowledge so Stripe stops sending it.
        break;
    }
  } catch (err) {
    console.error('[stripe-webhook] handler failed:', (err as Error).message);
    return new Response('handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

/**
 * Mirror one Stripe subscription into billing_subscriptions. `knownUserId`
 * comes from checkout.session.completed; later events find the row by
 * customer id (set when checkout created the customer) or sub metadata.
 */
async function upsertFromSubscription(sub: Stripe.Subscription, knownUserId?: string) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  let userId = knownUserId ?? (sub.metadata?.supabase_user_id || null);
  if (!userId) {
    const { data } = await db
      .from('billing_subscriptions')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    userId = data?.user_id ?? null;
  }
  if (!userId) {
    console.error(`[stripe-webhook] no account for customer ${customerId} — ignoring`);
    return;
  }

  // Current API versions keep the billing period on the subscription ITEM;
  // fall back to the legacy top-level fields for safety.
  const item = sub.items?.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_end?: number })
    | undefined;
  const periodEnd =
    item?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end;

  const { error } = await db.from('billing_subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    status: sub.status,
    price_id: item?.price?.id ?? null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`db upsert: ${error.message}`);
}
