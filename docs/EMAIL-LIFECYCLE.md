# Lifecycle email — the automated sequences

Status: **live.** Checked against `svtyxuhbsbbodsecbnsc` on 17 Sept 2026 —
`email_settings.enabled` is true (activated 2026-09-10), all three functions are
deployed, the `email_dispatch_key` Vault secret is set, and both cron jobs
(`apex-email-dispatch` hourly, `apex-email-prune` weekly) are active.

The setup steps below are kept as the record of how it was put together, and as
the runbook for doing it again on a new project. They are not outstanding work.
The one thing that is worth re-checking by hand is the **Resend webhook**
(step 2), which cannot be seen from the database.

To stop everything: `update public.email_settings set enabled = false where id = true;`
— see "Running it". That switch does **not** cover transactional mail, which
goes through `email_outbox` (migration 0029) and is deliberately outside it.

Two sequences, both automatic, both driven off data the app already stores:

| Campaign | Who gets it | When | Length |
|---|---|---|---|
| `trial` | anyone whose Stripe trial has started | anchored to the subscription's own start date | 8 emails across the 7 days |
| `nudge` | an account that was created and never started a trial | anchored to signup | 3 emails across 7 days |

Nobody is in both: the `nudge` cohort is defined as *no subscription that ever
began*, so starting a trial removes them from it and puts them in `trial`.

## The pieces

| File | Job |
|---|---|
| `supabase/migrations/0018_email_lifecycle.sql` | The schedule, the send log, the opt-outs, and `email_lifecycle_due()` — the scheduler, written as one query. |
| `supabase/functions/_shared/emails.ts` | All eleven templates and the brand shell. Imported by the dispatcher; no other copy exists. |
| `supabase/functions/email-dispatch/index.ts` | Woken hourly by pg_cron. Asks what is due, renders it, sends it through Resend, records the outcome. |
| `supabase/functions/email-unsubscribe/index.ts` | The "stop these emails" link. Public, no JWT. |
| `supabase/functions/email-hooks/index.ts` | Resend's webhook: bounces and complaints go to the suppression list. |
| `scripts/email-assets.js` | Generates the pictures into `web/src/email/`, published by the Pages workflow. |
| `scripts/test-emails.js` | `npm run test:emails` — the consistency and safety checks. Part of `npm test`. |
| `supabase/migrations/0029_partner_requests.sql` | `email_outbox`: the second queue, for **transactional** mail (today: an approved partner application). Outside the kill switch, outside the opt-out, no unsubscribe link. See `docs/REFERRALS.md`. |

## The cohort we cannot reach

The brief was "people who downloaded but never signed up". **We do not have
their email addresses, and no code here can conjure them.** The installer is a
file on a public GitHub release; GitHub reports a download count and nothing
else. An address only exists once somebody creates an account *inside* the app.

So `nudge` targets the closest cohort that is actually reachable: **an account
was created, and a trial never started.** That is the drop-off between opening
the app and putting a card in, and it is almost certainly where most of the
loss is anyway, because the trial is card-upfront.

To reach the earlier drop-off you would have to capture an address at download
time — a download page that emails the link rather than linking straight to
GitHub. That is a website change, not a change here, and it is the single most
valuable follow-up if this matters: it is also the only way the question "why
did you not sign up?" ever reaches the people who genuinely never signed up.
The sequence machinery would need one new campaign row and one template.

## Setup

Do these in order. Nothing sends until step 6, on purpose.

### 1. Apply the migration

SQL editor, or `supabase db push`. It is re-runnable.

```sql
-- sanity check afterwards
select * from public.email_settings;              -- enabled should be false
select campaign, step, offset_hours from public.email_lifecycle_steps order by campaign, position;
```

### 2. Resend

The domain `apexandchillracing.co.uk` is already verified in Resend for auth
SMTP (see `auth-email-setup.md`). The lifecycle mail uses the **HTTP API**, not
SMTP, so it needs an API key rather than SMTP credentials.

1. Resend → API Keys → create one with **Sending access** only.
2. Resend → Webhooks → add `https://svtyxuhbsbbodsecbnsc.supabase.co/functions/v1/email-hooks`,
   subscribed to `email.bounced` and `email.complained`. Copy its signing secret.

Sending lifecycle mail from the same domain as password resets is deliberate —
one warmed domain, one reputation. If volume ever grows enough to worry about,
the move is a subdomain (`mail.apexandchillracing.co.uk`), not a second
provider.

### 3. Function secrets

```bash
supabase secrets set \
  RESEND_API_KEY=re_xxxxxxxx \
  RESEND_WEBHOOK_SECRET=whsec_xxxxxxxx \
  EMAIL_DISPATCH_KEY="$(openssl rand -hex 32)" \
  EMAIL_POSTAL_ADDRESS="Apex & Chill Racing, <your address>"
```

`EMAIL_FROM` and `EMAIL_REPLY_TO` both default to
`support@apexandchillracing.co.uk` in code, so they only need setting to change
them. Same for `EMAIL_FROM_NAME`, which defaults to `Carl at Apex & Chill` —
the copy is written in the first person and two of the mails ask for a reply,
so the display name being a person rather than "Apex AIO" is doing real work.
The other overrides — `EMAIL_ASSET_BASE`, `EMAIL_UNSUB_BASE`,
`EMAIL_LINK_DOWNLOAD`, `EMAIL_LINK_WEB` — all have sensible defaults too.

**Keys live in `supabase secrets`, never in the repo.** There is no `.env` for
these on purpose: the source repo is going private but has public history, and
a sending key in a commit is a key someone else can send mail from your domain
with. If a key has ever been pasted into a chat, a ticket, or a screenshot,
treat it as public — Resend → API Keys → revoke, issue a new one, re-run
`supabase secrets set`. Nothing else has to change, because nothing else knows
the value.

**`EMAIL_POSTAL_ADDRESS` is not optional in practice.** A physical address in
the footer is required by CAN-SPAM for commercial mail and expected under PECR;
the default string is a placeholder, not an address.

### 4. Deploy the functions

```bash
supabase functions deploy email-dispatch
supabase functions deploy email-unsubscribe --no-verify-jwt
supabase functions deploy email-hooks       --no-verify-jwt
```

`--no-verify-jwt` on the last two is required: the person clicking unsubscribe
is reading their inbox, and Resend is not a Supabase client. `email-dispatch`
keeps JWT verification *and* checks `EMAIL_DISPATCH_KEY` — the secret is what
actually guards it.

### 5. Preview every email before anyone else sees one

```bash
curl -X POST -H "x-dispatch-key: $EMAIL_DISPATCH_KEY" \
  "https://svtyxuhbsbbodsecbnsc.supabase.co/functions/v1/email-dispatch?to=you@example.com&campaign=trial&step=day0"
```

`campaign`/`step` take any of the eleven; `variant=thanks`, `opened=0` and
`daysLeft=0` exercise the conditional versions. Nothing is recorded and no
account is touched. Send all eleven to yourself and read them on a phone.

Then check what *would* go out, against live data, sending nothing:

```bash
curl -X POST -H "x-dispatch-key: $EMAIL_DISPATCH_KEY" \
  "https://svtyxuhbsbbodsecbnsc.supabase.co/functions/v1/email-dispatch?dry=1"
```

### 6. Turn it on

```sql
update public.email_settings
   set enabled = true,
       activated_at = now(),     -- the anti-backfill line: nothing older is eligible
       updated_at = now()
 where id = true;
```

`activated_at = now()` is what stops every existing account being mailed "day
5" the moment you flip the switch. Only people whose trial starts (or whose
account is created) *after* this instant enter a sequence. Leave it alone
unless you deliberately want to re-mail history.

### 7. Schedule the dispatcher

In the SQL editor, once:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Keep the secret in Vault, not in the job body: cron.job is readable by any
-- role that can look at the schedule.
select vault.create_secret('<the EMAIL_DISPATCH_KEY value>', 'email_dispatch_key');

select cron.schedule('apex-email-dispatch', '7 * * * *', $job$
  select net.http_post(
    url     := 'https://svtyxuhbsbbodsecbnsc.supabase.co/functions/v1/email-dispatch',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 -- email-dispatch keeps verify_jwt on, so the gateway needs a key
                 -- BEFORE our own check runs. The publishable key is public by
                 -- design; x-dispatch-key is the secret that actually guards it.
                 'Authorization', 'Bearer sb_publishable_Q-0gsoTW_r-AzgKQ6NqNSQ_vGegMK8w',
                 'x-dispatch-key', (select decrypted_secret from vault.decrypted_secrets
                                     where name = 'email_dispatch_key')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$job$);

-- Housekeeping, Sundays at 04:00.
select cron.schedule('apex-email-prune', '0 4 * * 0', $job$ select public.email_prune(); $job$);
```

Hourly is deliberate. The schedule's finest grain is a whole day, quiet hours
are a nine-hour window, and a step stays eligible for 48 hours — so an hour of
slack changes nothing a reader would notice, and a missed run costs nothing.

Check it is firing:

```sql
select * from cron.job_run_details order by start_time desc limit 10;
```

## Running it

**The Admin numbers.** `admin_email_stats()` returns per-step sent/failed
counts, opt-outs, suppressions and how many are due right now. There is no
Admin tab card for it yet — call the RPC, or add one.

```sql
select public.admin_email_stats();
```

**Stop everything, now.** One statement, takes effect on the next hourly run:

```sql
update public.email_settings set enabled = false where id = true;
```

**Re-time a step.** The schedule is data:

```sql
update public.email_lifecycle_steps set offset_hours = 30 where campaign = 'trial' and step = 'day1';
update public.email_lifecycle_steps set active = false where campaign = 'nudge' and step = 'last';
```

**Change the words.** Edit `_shared/emails.ts`, run `npm run test:emails`,
redeploy `email-dispatch`. People already mid-sequence get the new copy for the
steps they have not reached yet.

**Add a step.** Insert a row into `email_lifecycle_steps` *and* add the matching
template. `npm run test:emails` fails if you do one without the other, which is
the whole reason that check exists — a step with no template would otherwise be
offered every hour and silently skipped forever.

## The pictures

`npm run email:assets` writes everything into `web/src/email/`, and
`scripts/build-web.js` publishes it to `<site>/email/<name>.png`.

Two are captured automatically from the stubbed-bridge harness (the Dashboard
and the Review lap view). The rest need a running sim — the overlay layer over
LMU, the engineer mid-conversation, the pit wall on a tablet — so the script
prints exactly which files it wants and what should be in them. Drop a PNG in
at that name and re-run; it gets resized and re-encoded like the rest.

**The emails send perfectly well without them.** Every image has real alt text,
sits in a box that looks deliberate when empty, and carries nothing that is not
also in the prose — because most clients block remote images anyway. Missing
pictures are a `SKIP` in the test suite, not a failure.

The one hard rule: **a file published here is permanent.** A mail sent today
still asks for that URL in a year. Replace files, never rename them.

## Things that will bite

**The unsubscribe link must never act on GET.** Gmail and Microsoft Defender
prefetch links in incoming mail — that is what broke password reset (see
`auth-email-setup.md`), and here it would silently opt people out of a
sequence they never opened. GET renders a page with a button; the button POSTs.
`test:emails` asserts it and will fail if the RPC call ever moves.

**Two dispatchers cannot double-send.** The send log has a unique partial index
on the rows that succeeded, so a second run inserting the same
(user, campaign, step) is rejected and counted as `raced`. The safe reaction to
a failed run is therefore always "run it again".

**A cancelled trial stops the sequence.** `cancel_at_period_end` removes them
from `trial_base`. Somebody who has already decided to stop does not want four
more feature tours. There is no win-back campaign yet — that would be a third
campaign, and it needs to be written before it is scheduled.

**Comped accounts are never nudged.** `profiles.free_access_reason` excludes
league and beta grants from `nudge`, because they were never going to check out
and "you never started a trial" would read as an insult.

**Quiet hours are Europe/London**, not UTC, so the window does not slide an
hour twice a year. The welcome mail is the one exception and ignores them: it
should arrive while they are still at the keyboard.

**Reply-to reaches a person.** Two of the eleven emails ask a direct question
and the value of the whole `nudge` sequence is in the answers. If
`EMAIL_REPLY_TO` points at a mailbox nobody reads, delete those two emails
rather than leave them asking.
