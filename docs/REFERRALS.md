# Partner referrals

A partner — a streamer, a league admin, anyone with an audience — is issued a
code, either because we approached them or because they **applied from inside
the app** (Settings → Account → Become a partner). They promote
`apexandchillracing.co.uk/r/THEIRCODE`. Anyone who uses it gets **10% off Apex
AIO for as long as they stay subscribed**.

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

## The website is a different Supabase project

Worth knowing before touching anything on the site, because getting it wrong
fails **silently**:

| | Supabase project |
|---|---|
| apexandchillracing.co.uk | `yfgvsiqrrxuucrkkqmqy` — join submissions, merch orders |
| Apex AIO (app, accounts, billing, **referrals**) | `svtyxuhbsbbodsecbnsc` |

`lib/supabase.ts` on the website returns clients for the **first** one. The
referral tables live in the second, so `lib/referral.ts` builds its own client
against the AIO project (hardcoded, with a `NEXT_PUBLIC_APEX_AIO_SUPABASE_*`
override; the anon key is public by construction — it ships inside every
installer).

This is what "unknown code" and "wrong database" look like from the landing
page: identical. The banner just never appears.

The click counter has the same constraint and no way round it — the website's
service-role key belongs to the other project, and handing a marketing site the
AIO project's service key (which bypasses RLS on accounts, billing and lap data)
to increment a counter would be a bad trade. So `referral_record_click` is
granted to `anon` and capped at 5000/code/day (migration 0025). What that
concedes is a wrong number in a column nobody is paid on; `redeemed` and
`paying` both need a real account and a real Stripe subscription and cannot be
faked from outside.

---

## How someone asks for one

**Settings → Account → Become a partner**, in the app (migration 0029). It is
the only way in that does not involve knowing to ask in Discord, and it exists
because the card above it — the partner's own link — is hidden for anyone
without a code, which made the whole scheme invisible to exactly the people it
is for.

The card is one card with four states, because they are four answers to one
question:

| They | See |
|---|---|
| own an active code | nothing — the referral card above is theirs |
| may apply | the form: name to show, code they want, where they would use it, anything else |
| have one pending | “Your application is with us. We will email you…” |
| were declined | the reason you typed, word for word, and the date they may re-apply |

**The “no commission” line is on the form, not in the approval email.** Someone
who applies to what sounds like an affiliate scheme and finds out a month later
that it pays nothing is a relationship you have spent. It is also repeated in
the approval mail, because it is the one thing about this that surprises people.

Every rule is enforced in `referral_request_submit`, not in the app: one pending
application at a time (a partial unique index, so a double click cannot make
two), nobody who already owns an active code, and a **30-day cooldown** after a
decline. Hiding the form is a courtesy; the function is the control.

### Approving

**Admin → Referrals → Applications.** Pending first and oldest first, then
everything decided as history. Each row carries the applicant's name, email,
what they wrote, and whether they are **subscribed themselves** — someone
promoting a product they pay for is a different proposition from someone who
never started a trial, and it is the first thing you want to know.

**Approve** prompts for the code (prefilled with the one they asked for, which
is the field you have a reason to overrule — a clash, a rude word, something
nobody could say aloud) and then does the whole job in one server-side call:
issues the code through the same `admin_issue_referral_code` the form below
uses, links it to their account, closes the application and queues the email.
The link lands on your clipboard.

If the code is refused — taken, malformed, clashing with a league access code —
**the application stays pending** and says why. An approved application with no
code would tell somebody they are a partner with nothing to promote.

**Decline** takes a reason and **sends no email**. A rejection email is worse
than finding out quietly in the app the next time they look, and it is the kind
of mail that gets replied to angrily rather than read. What you type is shown to
them verbatim in Settings, so write it to be read.

### The approval email, and how you know it went

The approval writes a row into `email_outbox` and the existing
`email-dispatch` function sends it — the same function, the same Resend key, the
same send log. Postgres cannot send mail, and the alternative (the desktop app
sending it) would mean a Resend key inside an installer anyone can unpack.

It is **transactional**, so unlike the lifecycle sequences it ignores
`email_settings.enabled`, ignores the lifecycle opt-out, has no unsubscribe link
and no `List-Unsubscribe` header, and is not held for quiet hours. It still
respects a hard bounce or a spam complaint.

That kill-switch exemption matters more than it looks: the day somebody sets
`enabled = false` to stop a sequence, every approved partner would otherwise
stop being told they are a partner, and nobody would connect the two.

Its state is on the application's row: `emailed`, `email queued`, `EMAIL FAILED`
(hover for the error) or `no email sent`. This is deliberate — an approved
partner who was never told is the failure this feature would otherwise hide,
and it is the same trap as `REFERRAL_COUPON_ID` above, answered differently.

**What it needs.** Verified on `svtyxuhbsbbodsecbnsc` on 17 Sept 2026: the
`email-dispatch` function is deployed, the hourly `apex-email-dispatch` cron job
is active, and the `email_dispatch_key` Vault secret is set. So the sending
half already works — note that `docs/EMAIL-LIFECYCLE.md` still describes these
as outstanding and is out of date.

What is left is two things:

1. **Redeploy `email-dispatch`.** The version running predates the outbox and
   will not drain it. It bundles `_shared/emails.ts`, so it must go via the CLI:
   `supabase functions deploy email-dispatch`.
2. Optional, and worth doing: the **immediate poke**. Without it an approval
   email lands on the next hourly run — up to an hour later, which reads as
   broken to the person waiting for it.

```sql
-- Only these two; the secret it needs is the same Vault one the cron job uses.
update public.email_settings
   set dispatch_url  = 'https://svtyxuhbsbbodsecbnsc.supabase.co/functions/v1/email-dispatch',
       dispatch_auth = 'sb_publishable_Q-0gsoTW_r-AzgKQ6NqNSQ_vGegMK8w'
 where id = true;
```

Neither value is secret: the URL is a public endpoint and the key is the
publishable one already inside every installer. `EMAIL_DISPATCH_KEY` stays in
Vault and is what actually guards the function. Leave `dispatch_url` empty and
nothing is poked — the hourly job still delivers.

`email_outbox_poke()` gives up quietly on every failure (no pg_net, no Vault, no
secret, an error) and returns false, because an approval must never fail over a
courtesy. If mail is arriving on the hour rather than instantly, that is what to
look at first.

To read the queue directly:

```sql
select id, email, template, status, attempts, error, created_at, sent_at
  from public.email_outbox order by created_at desc limit 20;
```

Read the mail itself before anyone else does — it renders in
`npm run email:preview` with the rest, and sends to you with:

```bash
curl -X POST -H "x-dispatch-key: $EMAIL_DISPATCH_KEY" \
  "https://svtyxuhbsbbodsecbnsc.supabase.co/functions/v1/email-dispatch?to=you@example.com&campaign=partner&step=approved&code=CRAIG"
```

## Issuing a code

Still here, and still the right route for a partner you approached rather than
one who applied.

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
the point, and it works perfectly for whoever uses it either way.

Linking is what the **partner** gets: their link, their stream overlay and their
three numbers appear in their own **Settings → Account**, so they can fetch them
without asking you.

Two ways, both by email — an email is what you have in front of you:

- **Their account email** on the issue form, when you already know it.
- **Link** on the partner's row afterwards, once they have signed up. The row
  says `not linked to an account` until then, so it is visible rather than
  something you have to remember to check. **Unlink** moves it or detaches it;
  the code and all its numbers stay exactly where they are.

One account can own one active code. A second would be invisible to them —
Settings shows the oldest — so it is refused rather than silently ignored.

### The stream overlay

Every code has one, at `…/r/<CODE>/overlay`. A partner adds it in OBS as a
**Browser Source** and their code sits on screen with the Apex AIO lockup, the
10%, and the short link, on a transparent background.

The lockup is inlined into the document (`app/r/[code]/overlay/lockup.ts` in
the website repo) rather than fetched, because a logo that arrives late or not
at all is a half-drawn mark on somebody's live stream. `?theme=light` flips
only its lettering — the symbol keeps its gradient either way.

It is hosted on the website, not served by the desktop app like every other
Apex overlay — those need live telemetry, this needs a string. A browser source
pointing at `localhost` would break on any day the partner streams something
else with Apex closed.

Options, on the URL:

| | |
|---|---|
| `?layout=badge` | stacked block for a corner (default is a horizontal bar) |
| `?theme=light` | for a bright scene |
| `?scale=1.5` | multiplies everything, for a 4K canvas |

The **Style** dropdown in Settings → Account builds these, and **Preview** opens
the result in a browser so they can see it before it goes live.

An unknown or revoked code renders an **empty transparent page** — never an
error. This is in front of an audience; the failure mode has to be an invisible
source, not a red box over somebody's race. Which also means a partner whose
code you turn off sees their overlay quietly disappear within five minutes
(the page's cache window) rather than break.

Loading the overlay does **not** count a click. An OBS source reloads on every
scene change, and counting those would fill a partner's funnel with their own
stream.

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
| Applications, the outbox, the poke | `supabase/migrations/0029_partner_requests.sql` |
| The approval email's words | `supabase/functions/_shared/emails.ts` → `TRANSACTIONAL` |
| Sending it | `supabase/functions/email-dispatch/index.ts` → `drainOutbox` |
| “Become a partner” card | `electron/control-panel/control-panel.js` → `refreshMyReferralRequest` |
| The Applications pane | `electron/control-panel/control-panel.js` → `renderReferralRequests` |
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
