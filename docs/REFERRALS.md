# Partner referrals

A partner — a streamer, a league admin, anyone with an audience — is issued a
code. They promote `apexandchillracing.co.uk/r/THEIRCODE`. Anyone who uses it
gets **10% off Apex AIO for as long as they stay subscribed**.

The partner is paid **nothing**. This is a promotion tool they can put on a
stream, not an affiliate scheme. Everything needed to pay one later is recorded
from day one, because a payout decided in six months cannot be backdated onto
data nobody kept.

---

## The gap this is built around

Read this before changing anything, because every awkward part of the design is
downstream of it.

**A link cannot carry the discount.** The click happens in a browser. The
payment happens a week later inside a signed desktop app, after a 285 MB
download, an install and a sign-up. No cookie, session, UTM or query parameter
survives that journey.

So the link carries a **code**, the code is typed once on the subscribe screen,
and the discount is attached server-side when Checkout is created. The link is
marketing; the code is the mechanism.

That also means the code works when there was never a link at all — read aloud
on a stream, posted in Discord, printed on a sticker. Which is most of how these
are actually shared.

---

## One-time setup

### 1. The Stripe coupon — **done**

One coupon serves every partner; per-partner codes live in our own database, not
in Stripe.

| | |
|---|---|
| **Coupon ID** | `nFT2oPb9` |
| Name | `percent-off-10` |
| Discount | 10% off, duration **Forever** |
| Applies to | Apex And Chill · £4.99/month |
| Created | 16 Sept 2026 |

`duration=forever` applies the discount to every invoice indefinitely. With the
7-day trial the first discounted invoice is day 8; nothing is consumed by the
trial.

> **The ID is not the name.** A coupon created in the Dashboard gets a
> Stripe-generated id (`nFT2oPb9`) regardless of what you call it. The *name*
> `percent-off-10` is a label and will not resolve. If you ever recreate it, use
> the API so you choose the id yourself:
> `stripe coupons create --percent-off 10 --duration forever --id apex-referral-10`
> — and change the secret to match.

There is also a **promotion code** `percent-off-10` on that coupon. Nothing here
uses it: promotion codes are for customers typing them into Stripe's own box,
and we apply the coupon server-side instead so there is nothing to type. Harmless
to leave; do not confuse `promo_…` with the coupon id.

### 2. Point the edge function at it

Supabase Dashboard → **Project Settings → Edge Functions → Secrets**, add:

```
REFERRAL_COUPON_ID = nFT2oPb9
```

or with the CLI:

```bash
supabase secrets set REFERRAL_COUPON_ID=nFT2oPb9
supabase functions deploy create-checkout-session
```

### 3. Check the restricted key can read coupons

`STRIPE_SECRET_KEY` is a restricted key (`rk_...`). It needs **read** on Coupons
in addition to Checkout / Customers / Subscriptions / Billing Portal. Without
it, Stripe rejects the session's `discounts` array.

**How you find out if you skipped this:** you don't, from the driver's side.
Every failure here is deliberately soft — a missing secret, a wrong coupon id, a
deleted coupon, a key without permission, or a coupon whose *Applies to* excludes
the £4.99 price all fall through to **full price** rather than blocking the sale,
because the subscription is worth far more than the 10%. Checkout still opens and
still works; it just costs the full amount.

That softness is deliberate but it means **the logs are the only tell**. Two
lines to grep for:

```
[referral] <uuid> redeemed CRAIG but REFERRAL_COUPON_ID is unset — charged full price.
[referral] Stripe refused coupon nFT2oPb9 for <uuid> (code CRAIG): … — retrying at full price.
```

The second one is the important one: it means the secret IS set and Stripe
rejected it anyway — wrong id, revoked coupon, a restricted key without Coupons
access, or an `applies_to` that does not cover this price.

The database-side check, which needs no log access:

```sql
-- Anyone attached to a code who reached checkout should have applied_at set.
select code, count(*) as redeemed, count(applied_at) as discount_reached_stripe
  from public.referral_attributions group by code;
```

`redeemed` far ahead of `discount_reached_stripe` is only expected for people who
have not started a subscription yet. If someone is *paying* and their
`applied_at` is null, the discount never reached Stripe and they are being
overcharged relative to what the landing page promised.

---

## Issuing a code

**Admin → Referrals → Issue a partner code.**

- **Code** — 3–24 letters or digits, no spaces or punctuation. Short and
  sayable: `CRAIG`, not `CRAIGS-APEX-LINK-2026`. Someone will read it aloud.
- **Who it is for** — shown to whoever uses the link ("Craig sent you"), so
  write it the way they would want to be seen.
- **Note** — staff only, never leaves the pane.

The link is copied to your clipboard the moment it is issued, because sending it
to the partner is the only thing you want to do next.

### Linking a code to their account

A code can be issued to someone who has never opened the app — that is usually
the point. If they *do* have an account and you set `owner_user_id`, their link
and its numbers appear in their own **Settings → Account**, so they can copy it
without asking you. There is no UI for setting that yet; do it in SQL:

```sql
update public.referral_codes
   set owner_user_id = (select id from auth.users where email = 'them@example.com')
 where code = 'CRAIG';
```

---

## The funnel

Four numbers, and the gaps between them mean different things:

| | What it counts | A gap below it means |
|---|---|---|
| **Opens** | the link was loaded | — |
| **Redeemed** | an account entered the code | the landing page is not converting |
| **Paying** | that account is subscribed now | the app is not converting |

Clicks without redemptions is a marketing problem. Redemptions without paying is
a product problem. They are not fixed the same way, which is why they are
separate columns.

Nobody — not an admin, not the partner — ever sees **who** used a code. The
numbers are aggregates, the same rule the rest of the admin panel follows.

---

## Turning a code off

**Turn off** on the partner's row stops **new** redemptions. It deliberately
does **not** touch anyone already on it: their subscription is discounted in
Stripe, and ending a partnership is not a reason to put an existing customer's
bill up without warning.

To actually stop discounting someone already attached you would have to remove
the discount on their Stripe subscription by hand. Think hard first.

---

## Rules worth knowing

- **One code per driver.** Changeable until they are paying, fixed afterwards —
  a mistyped code should be fixable, but once money has moved the attribution is
  a financial record.
- **A partner cannot use their own code.** Refused at redemption, so it never
  becomes a rule change after the first payout.
- **League codes win.** `redeem_code` checks league access codes first; a
  referral code that collides with one would be unreachable, so
  `admin_issue_referral_code` refuses to mint it.
- **Codes are case- and punctuation-insensitive.** `craig`, `Craig` and `CR-AIG`
  all resolve to `CRAIG`, on the website and in the app, via
  `referral_normalise`.

---

## Where the parts live

| Piece | Where |
|---|---|
| Schema, RPCs, the whole rationale | `supabase/migrations/0023_referrals.sql` |
| Applying the coupon at Checkout | `supabase/functions/create-checkout-session/index.ts` |
| Redeeming a code (app) | `electron/billing.js` → `redeem_code` |
| Subscribe screen | `electron/control-panel/auth.{html,js}` |
| Admin pane + partner card | `electron/control-panel/control-panel.js` |
| `/r/<code>` and the click count | `apexandchillwebsite/app/r/[code]/route.ts` |
| The landing-page banner | `apexandchillwebsite/components/overlay/ReferralBanner.tsx` |
| Shared lookup/normalise | `apexandchillwebsite/lib/referral.ts` |

The download link itself needed no work: `/api/aio/download` already redirects
to the newest GitHub release, so a partner's link keeps handing out the current
installer on its own after every `npm run release`.
