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
//   invoice.payment_failed / invoice.paid            → what is owed, and the
//     hosted page to pay it on, so the overdue banner can name a figure

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
        await upsertFromSubscription(sub, undefined, event.created);
        break;
      }
      case 'invoice.payment_failed':
      case 'invoice.paid': {
        await recordInvoice(event.data.object as Stripe.Invoice, event.type === 'invoice.paid');
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
async function upsertFromSubscription(
  sub: Stripe.Subscription,
  knownUserId?: string,
  eventAtSec?: number,
) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  let userId = knownUserId ?? (sub.metadata?.supabase_user_id || null);
  let existingPastDueSince: string | null = null;
  if (!userId) {
    const { data } = await db
      .from('billing_subscriptions')
      .select('user_id, past_due_since')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    userId = data?.user_id ?? null;
    existingPastDueSince = data?.past_due_since ?? null;
  } else {
    const { data } = await db
      .from('billing_subscriptions')
      .select('past_due_since')
      .eq('user_id', userId)
      .maybeSingle();
    existingPastDueSince = data?.past_due_since ?? null;
  }
  if (!userId) {
    console.error(`[stripe-webhook] no account for customer ${customerId} — ignoring`);
    return;
  }

  /*
   * When this run of failed payments began — the clock the 14-day grace window
   * in entitlement_status() counts from.
   *
   * Sticky while past_due: an existing stamp is never overwritten, so the third
   * retry failing does not hand the driver another fortnight. Cleared the
   * moment the status is anything else, so a driver who pays, and months later
   * fails again, starts a fresh window rather than being locked out instantly.
   *
   * Stamped from the EVENT's timestamp, not now(): Stripe replays events, and a
   * replay must not move the deadline.
   */
  const pastDueSince =
    sub.status === 'past_due'
      ? (existingPastDueSince ??
        new Date((eventAtSec ?? Math.floor(Date.now() / 1000)) * 1000).toISOString())
      : null;

  // Current API versions keep the billing period on the subscription ITEM;
  // fall back to the legacy top-level fields for safety.
  const item = sub.items?.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_end?: number })
    | undefined;
  const periodEnd =
    item?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end;

  // The Admin tab's MRR and churn charts are computed from the LIFETIME of each
  // subscription, not from its current status, so every event records when this
  // one began, when it finally stopped, and what it is worth per month. Those
  // four facts are all admin_billing_overview() needs to reconstruct any past
  // month — no event log, no nightly snapshot job.
  const { error } = await db.from('billing_subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    status: sub.status,
    price_id: item?.price?.id ?? null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    started_at: sub.start_date ? new Date(sub.start_date * 1000).toISOString() : null,
    // `ended_at` is set only once Stripe considers the subscription finished.
    // A cancel_at_period_end that has not come round yet is still live revenue
    // and must NOT read as churn until the day it actually stops.
    ended_at: sub.ended_at ? new Date(sub.ended_at * 1000).toISOString() : null,
    monthly_pence: monthlyAmount(item?.price),
    currency: item?.price?.currency ?? null,
    past_due_since: pastDueSince,
    // Leaving past_due means whatever was owed is settled or gone. Clearing
    // these here as well as in recordInvoice covers the paths that never send
    // an invoice event — a cancellation, or an admin voiding the invoice.
    ...(sub.status === 'past_due' ? {} : { amount_due_pence: null, invoice_url: null }),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`db upsert: ${error.message}`);
}

/**
 * What is currently owed, and where to pay it.
 *
 * Only ever UPDATES an existing row — an invoice for a customer we have never
 * seen is not a reason to invent a subscription record. The subscription events
 * own the row's lifecycle; this only decorates it.
 *
 * `paid` clears the figures rather than writing them, so the banner disappears
 * the moment the money lands instead of waiting for the subscription event that
 * follows it.
 */
async function recordInvoice(invoice: Stripe.Invoice, paid: boolean) {
  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  const patch = paid
    ? { amount_due_pence: null, invoice_url: null }
    : {
        amount_due_pence: typeof invoice.amount_due === 'number' ? invoice.amount_due : null,
        invoice_url: invoice.hosted_invoice_url ?? null,
      };

  const { error } = await db
    .from('billing_subscriptions')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('stripe_customer_id', customerId);
  if (error) throw new Error(`db invoice update: ${error.message}`);
}

/**
 * What one subscription item is worth per MONTH, in the currency's minor unit.
 *
 * Today there is exactly one price and it is monthly, so this is a long way of
 * saying 499. It normalises anyway because the day someone adds an annual plan
 * is not the day you want to discover that the revenue chart has been quietly
 * adding £49.99 to a MONTHLY total. Returns null when there is no recurring
 * amount to speak of, which keeps such a row out of the sums entirely rather
 * than counting it as zero.
 */
function monthlyAmount(price?: Stripe.Price | null): number | null {
  const amount = price?.unit_amount;
  if (typeof amount !== 'number') return null;
  const interval = price?.recurring?.interval;
  const count = price?.recurring?.interval_count || 1;
  const perMonth: Record<string, number> = { day: 1 / 30, week: 1 / 4.345, month: 1, year: 12 };
  const months = (perMonth[interval ?? 'month'] ?? 1) * count;
  return months > 0 ? Math.round(amount / months) : null;
}
