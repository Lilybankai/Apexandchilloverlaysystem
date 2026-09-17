-- ===========================================================================
-- 0029_partner_requests — let someone ASK to become a partner, approve it in
-- one click, and email them when it happens.
--
-- 0023–0025 built the referral feature from the middle outwards: an admin mints
-- a code, the website hands out the discount, the partner sees their numbers.
-- What none of it had was a way IN. A driver who streams, runs a league or has
-- an audience had no surface anywhere in the app that said the scheme existed,
-- let alone a way to put their hand up — the card in Settings → Account is
-- hidden for anyone without a code, so the feature was invisible to exactly
-- the people it is for. The only route was knowing to ask in Discord.
--
-- Three things, in the order they happen:
--
--   referral_requests          a driver applies, once, from Settings → Account
--   admin_approve_…            an admin turns that request into a real code,
--                              already linked to their account
--   email_outbox               the "you're in" email, queued by the approval
--                              and sent by the existing email-dispatch function
--
-- ## Why an OUTBOX and not a send
--
-- The approval happens inside a Postgres function. Postgres cannot send email,
-- and making the desktop app send it instead would mean shipping a Resend key
-- inside a signed installer that anybody can unpack. So the approval writes a
-- row saying what should be sent to whom, and the thing that already holds the
-- sending key — `email-dispatch`, woken hourly by pg_cron — drains it.
--
-- That also gets the failure mode right. If Resend is down, the key is wrong or
-- the function was never deployed, the row stays queued and is retried; the
-- partnership is still approved, the code still works, and the admin can SEE
-- that the mail has not gone out, because `admin_referral_requests()` returns
-- its status. Compare REFERRALS.md's warning about the coupon secret, whose
-- absence is silent and costs money every month until somebody greps a log.
--
-- Hourly would mean an approval email arriving up to an hour late, which reads
-- as broken to the person waiting for it. So the approval also POKES the
-- dispatcher through pg_net (`email_outbox_poke`), and the hourly run becomes
-- the safety net rather than the delivery mechanism. Every part of the poke is
-- optional: no pg_net, no Vault secret, no configured URL, or an outright
-- error, and it returns false and the cron picks the row up regardless.
--
-- ## Transactional is not marketing
--
-- This mail is a direct answer to something the recipient asked for, so it
-- ignores `email_settings.enabled` (the lifecycle kill switch), ignores the
-- lifecycle opt-out, and carries no unsubscribe link. It still respects a HARD
-- bounce or a spam complaint, because those are about the address and the
-- sending domain's reputation, not about consent.
--
-- The kill switch matters more than it looks. The day someone flips `enabled`
-- to false to stop a sequence going out, every approved partner would silently
-- stop being told they are a partner — and nobody would connect the two.
--
-- Depends on 0018 (email_sends, email_suppressions, email_settings) and on
-- 0023/0024 (referral_codes, admin_issue_referral_code).
--
-- Re-runnable: `if not exists`, `create or replace`, `add column if not exists`.
--
-- APPLIED 17 Sept 2026 through the management API rather than `supabase db
-- push`, which recorded it in schema_migrations as `20260917134415` instead of
-- `0029`. So a later `db push` will see this file as unapplied and run it
-- again. That is harmless — re-runnable is not a claim, it is the reason the
-- statements above are written the way they are — but it will look alarming in
-- the plan, and it is why the numbering here and in the remote history differ.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. referral_requests — one row per application.
--
--    Kept as history rather than deleted on decision: "we turned this person
--    down in March" is the context you want in front of you when they apply
--    again in September, and a declined row is also what stops the app telling
--    the applicant nothing at all happened.
-- ---------------------------------------------------------------------------
create table if not exists public.referral_requests (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'declined')),
  -- How they want to be credited to the people who use their link. Shown as
  -- "Craig sent you", so it is a display name and never an email.
  display_name  text not null default '',
  -- The code they would like. A suggestion, not a reservation: it is not
  -- checked for collisions until an admin approves, because holding codes for
  -- applications that may never be approved would burn the short sayable ones.
  wanted_code   text not null default '',
  -- Where they would promote it — a channel, a league, a Discord. Free text on
  -- purpose: the useful version of this answer never fits a dropdown.
  audience      text not null default '',
  message       text not null default '',
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references auth.users(id) on delete set null,
  -- Shown to the applicant verbatim when declined, so write it as if they will
  -- read it, because they will.
  decline_reason text not null default '',
  -- The code this request became. Null until approved; set null rather than
  -- cascading the row away if the code is ever deleted, so the history stays.
  code          text references public.referral_codes(code) on delete set null
);

-- One pending application per driver. A partial index rather than a plain
-- unique: a driver may apply again after a decline, and an approved row must
-- not block anything either.
create unique index if not exists referral_requests_one_pending_idx
  on public.referral_requests (user_id) where status = 'pending';
create index if not exists referral_requests_status_idx
  on public.referral_requests (status, created_at desc);

comment on table public.referral_requests is
  'Applications to become a referral partner. Written by referral_request_submit(), decided by the admin_* functions below.';

alter table public.referral_requests enable row level security;

drop policy if exists "own request readable" on public.referral_requests;
create policy "own request readable" on public.referral_requests
  for select using (user_id = auth.uid());
-- No client write policy: submitting goes through the function below, which is
-- where the eligibility rules live.

-- ---------------------------------------------------------------------------
-- 2. email_outbox — mail that something decided to send, waiting for the thing
--    that can actually send it.
--
--    Deliberately NOT part of the lifecycle schedule. A lifecycle step is "this
--    person reached day 3"; an outbox row is "this already happened, tell
--    them". They have different triggers, different consent rules and different
--    kill switches, and folding one into the other would mean the marketing
--    switch could silence a transactional mail.
-- ---------------------------------------------------------------------------
create table if not exists public.email_outbox (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  -- Resolved at ENQUEUE time, not at send time. The address the decision was
  -- made against is the address it should go to; looking it up an hour later
  -- would quietly follow an email change made in between.
  email       text not null,
  -- 'campaign/step', matching a template in supabase/functions/_shared/emails.ts.
  template    text not null,
  -- Everything the template needs that is not the recipient: the code, the
  -- link, the overlay URL. Rendered by the dispatcher, never here.
  params      jsonb not null default '{}'::jsonb,
  status      text not null default 'queued'
                check (status in ('queued', 'sent', 'failed')),
  attempts    smallint not null default 0,
  subject     text not null default '',
  provider_id text not null default '',
  error       text not null default '',
  -- The idempotency key. 'partner/approved:41' can only ever be queued once,
  -- so an admin who double-clicks Approve, or a retried RPC, cannot produce two
  -- congratulations emails.
  dedupe_key  text not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create unique index if not exists email_outbox_dedupe_idx on public.email_outbox (dedupe_key);
create index if not exists email_outbox_queued_idx
  on public.email_outbox (created_at) where status = 'queued';

comment on table public.email_outbox is
  'Transactional email waiting to be sent by email-dispatch. Ignores the lifecycle kill switch and the lifecycle opt-out; honours hard bounces and complaints.';

alter table public.email_outbox enable row level security;
-- No policies at all. Written by SECURITY DEFINER functions, read by the
-- service role inside the edge function.

-- ---------------------------------------------------------------------------
-- 3. Where to poke.
--
--    Two columns rather than two more Vault secrets, because neither value is
--    secret: the URL is a public endpoint and the key is the publishable one
--    that every installer already contains. The thing that actually guards
--    email-dispatch is EMAIL_DISPATCH_KEY, which stays in Vault.
--
--    Both empty by default, which means "do not poke" — the migration on its
--    own changes nothing about how mail is sent.
-- ---------------------------------------------------------------------------
alter table public.email_settings
  add column if not exists dispatch_url  text not null default '';
alter table public.email_settings
  add column if not exists dispatch_auth text not null default '';

comment on column public.email_settings.dispatch_url is
  'The email-dispatch function URL, for the immediate poke after a transactional enqueue. Empty = never poke, hourly cron only.';
comment on column public.email_settings.dispatch_auth is
  'Bearer token for the API gateway in front of email-dispatch — the PUBLISHABLE key, not a secret.';

-- ---------------------------------------------------------------------------
-- 4. email_outbox_enqueue — put one mail in the queue.
--
--    Returns the row id, or null when this exact mail is already queued or
--    sent. The caller treats null as success: the mail exists, which is all
--    anybody wanted.
-- ---------------------------------------------------------------------------
create or replace function public.email_outbox_enqueue(
  p_user_id    uuid,
  p_template   text,
  p_params     jsonb,
  p_dedupe_key text
) returns bigint
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_email text;
  v_id    bigint;
begin
  select u.email into v_email from auth.users u where u.id = p_user_id;
  if coalesce(v_email, '') = '' then
    -- An account with no address is not an error worth aborting an approval
    -- for. The partnership is real either way; there is simply nobody to write
    -- to, and the admin sees "no email address" on the row.
    return null;
  end if;

  insert into public.email_outbox (user_id, email, template, params, dedupe_key)
  values (p_user_id, lower(v_email), p_template, coalesce(p_params, '{}'::jsonb), p_dedupe_key)
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.email_outbox_enqueue(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.email_outbox_enqueue(uuid, text, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. email_outbox_poke — ask the dispatcher to run now.
--
--    Every branch in here is a reason to give up quietly. pg_net missing, Vault
--    missing, the secret unset, the URL unconfigured, the call itself throwing
--    — all of them return false, because the hourly cron sends the mail anyway
--    and an approval must never fail over a courtesy.
--
--    pg_net's http_post is asynchronous: it queues the request and returns an
--    id immediately, so this does not hold the admin's click open while an edge
--    function warms up and talks to Resend.
-- ---------------------------------------------------------------------------
create or replace function public.email_outbox_poke()
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_url  text;
  v_auth text;
  v_key  text;
begin
  select dispatch_url, dispatch_auth into v_url, v_auth
    from public.email_settings where id;
  if coalesce(v_url, '') = '' then
    return false;
  end if;

  -- Catalogue checks rather than a bare call: an undefined function or a
  -- missing schema would otherwise raise, and while the handler below would
  -- catch it, doing so aborts a subtransaction on every single approval.
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    return false;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'vault') then
    return false;
  end if;

  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into v_key using 'email_dispatch_key';
  if coalesce(v_key, '') = '' then
    return false;
  end if;

  execute
    'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := $4)'
    using
      v_url,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || coalesce(v_auth, ''),
        'x-dispatch-key', v_key
      ),
      '{}'::jsonb,
      5000;

  return true;
exception when others then
  -- Deliberately swallowed. The queue is the contract; this is only a nudge.
  return false;
end;
$fn$;

-- Not granted to `authenticated`. It takes no arguments and returns a boolean,
-- so it leaks nothing, but a function that makes the server fire an HTTP
-- request is not something any signed-in account should be able to call in a
-- loop. admin_approve_referral_request reaches it anyway: inside a SECURITY
-- DEFINER function the caller is the owner, and the owner has execute.
revoke all on function public.email_outbox_poke() from public, anon, authenticated;
grant execute on function public.email_outbox_poke() to service_role;

-- ---------------------------------------------------------------------------
-- 6. email_outbox_due — what the dispatcher should send right now.
--
--    No quiet hours and no `email_settings.enabled` check, both on purpose:
--    someone who has just been told "you'll get an email" should get it at
--    23:40 as readily as at 10:00, and the lifecycle kill switch is about
--    marketing.
--
--    Three attempts. A mail that has failed three times is failing for a reason
--    retrying will not fix, and the admin panel shows it as failed rather than
--    the queue hiding a permanent error behind an infinite retry.
-- ---------------------------------------------------------------------------
create or replace function public.email_outbox_due(p_limit int default 25)
returns table (
  id       bigint,
  user_id  uuid,
  email    text,
  template text,
  params   jsonb,
  attempts smallint
)
language sql
stable
security definer
set search_path = public
as $fn$
  select o.id, o.user_id, o.email, o.template, o.params, o.attempts
    from public.email_outbox o
   where o.status = 'queued'
     and o.attempts < 3
     -- A hard bounce or a spam complaint is about the ADDRESS. An unsubscribe
     -- is about consent to marketing and does not apply to a mail the person
     -- asked for, so it is not in this list.
     and not exists (
       select 1 from public.email_suppressions s
        where s.email = o.email and s.reason in ('bounce', 'complaint')
     )
   order by o.created_at
   limit greatest(1, least(coalesce(p_limit, 25), 100));
$fn$;

revoke all on function public.email_outbox_due(int) from public, anon, authenticated;
grant execute on function public.email_outbox_due(int) to service_role;

-- ---------------------------------------------------------------------------
-- 7. email_outbox_record — what happened to it.
--
--    A failure keeps the row QUEUED until the third attempt, so a Resend blip
--    is retried on the next hourly run without anyone touching anything. The
--    third failure is final and visible.
--
--    Also mirrored into email_sends, so admin_email_stats() and the send log
--    cover transactional mail too rather than there being two places to look.
-- ---------------------------------------------------------------------------
create or replace function public.email_outbox_record(
  p_id          bigint,
  p_ok          boolean,
  p_subject     text default '',
  p_provider_id text default '',
  p_error       text default ''
) returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_row public.email_outbox%rowtype;
begin
  update public.email_outbox
     set attempts    = attempts + 1,
         subject     = coalesce(nullif(p_subject, ''), subject),
         provider_id = coalesce(nullif(p_provider_id, ''), provider_id),
         error       = case when p_ok then '' else left(coalesce(p_error, ''), 500) end,
         status      = case
                         when p_ok then 'sent'
                         when attempts + 1 >= 3 then 'failed'
                         else 'queued'
                       end,
         sent_at     = case when p_ok then now() else sent_at end
   where id = p_id
  returning * into v_row;

  if not found then
    return false;
  end if;

  -- The shared send log. The step carries the outbox id — 'approved:41' — so
  -- the 0018 double-send index still means something here: one row per mail,
  -- not one row per template for all time.
  if v_row.user_id is not null then
    perform public.email_lifecycle_record(
      v_row.user_id,
      v_row.email,
      split_part(v_row.template, '/', 1),
      split_part(v_row.template, '/', 2) || ':' || v_row.id::text,
      coalesce(p_subject, ''),
      case when p_ok then 'sent' else 'failed' end,
      coalesce(p_provider_id, ''),
      coalesce(p_error, '')
    );
  end if;

  return true;
end;
$fn$;

revoke all on function public.email_outbox_record(bigint, boolean, text, text, text)
  from public, anon, authenticated;
grant execute on function public.email_outbox_record(bigint, boolean, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. referral_request_submit — a driver applies.
--
--    The eligibility rules are all here rather than in the app, because the app
--    is a client: hiding the card is a courtesy to the driver, not a control.
--
--    Refused for someone who already OWNS an active code — they have what they
--    would be applying for — and for someone with an application already
--    pending, which is what the partial unique index enforces underneath.
--
--    A COOLDOWN after a decline, rather than either a permanent ban or an open
--    door. An open door turns a no into a weekly notification; a permanent ban
--    is wrong, because the honest reason for most declines is "not yet" and
--    audiences grow.
-- ---------------------------------------------------------------------------
create or replace function public.referral_request_submit(
  p_display_name text,
  p_wanted_code  text default '',
  p_audience     text default '',
  p_message      text default ''
) returns json
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_uid       uuid := auth.uid();
  v_name      text := left(btrim(coalesce(p_display_name, '')), 80);
  -- referral_normalise strips punctuation but does not clamp the length, and
  -- the column has no check constraint. Clamped here rather than trusting the
  -- app, which is the whole reason these rules live in the database.
  v_code      text := left(public.referral_normalise(p_wanted_code), 24);
  v_cooldown  constant interval := interval '30 days';
  v_declined  timestamptz;
  v_id        bigint;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'Sign in first.');
  end if;
  if v_name = '' then
    return json_build_object('ok', false,
      'error', 'Put the name you want people to see when they use your link.');
  end if;

  if exists (
    select 1 from public.referral_codes
     where owner_user_id = v_uid and active and revoked_at is null
  ) then
    return json_build_object('ok', false,
      'error', 'You already have a partner code — it is on this page.');
  end if;

  if exists (
    select 1 from public.referral_requests where user_id = v_uid and status = 'pending'
  ) then
    return json_build_object('ok', false, 'error', 'Your application is already with us.');
  end if;

  select max(decided_at) into v_declined
    from public.referral_requests
   where user_id = v_uid and status = 'declined';

  if v_declined is not null and v_declined > now() - v_cooldown then
    return json_build_object(
      'ok', false,
      -- FMDD, not D: `D` is the day of the WEEK in to_char, so it would read
      -- "3 Oct 2026" for a Tuesday and be wrong by up to a month.
      'error', 'You can apply again from ' || to_char(v_declined + v_cooldown, 'FMDD Mon YYYY') || '.',
      'retryAfter', v_declined + v_cooldown
    );
  end if;

  insert into public.referral_requests (user_id, display_name, wanted_code, audience, message)
  values (v_uid, v_name, v_code,
          left(btrim(coalesce(p_audience, '')), 200),
          left(btrim(coalesce(p_message, '')), 1000))
  returning id into v_id;

  return json_build_object('ok', true, 'id', v_id, 'status', 'pending');
end;
$fn$;

revoke all on function public.referral_request_submit(text, text, text, text) from public, anon;
grant execute on function public.referral_request_submit(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. my_referral_request — what the card in Settings should say.
--
--    Returns the LATEST request whatever its state, plus whether applying is
--    possible at all, so the card is drawn from one round trip and never has to
--    infer "you may apply" from the absence of something.
-- ---------------------------------------------------------------------------
create or replace function public.my_referral_request()
returns json
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_row      public.referral_requests%rowtype;
  v_has_code boolean;
  v_declined timestamptz;
  v_retry    timestamptz;
begin
  if v_uid is null then
    return json_build_object('ok', false);
  end if;

  select exists (
    select 1 from public.referral_codes
     where owner_user_id = v_uid and active and revoked_at is null
  ) into v_has_code;

  select * into v_row
    from public.referral_requests
   where user_id = v_uid
   order by created_at desc
   limit 1;

  select max(decided_at) into v_declined
    from public.referral_requests
   where user_id = v_uid and status = 'declined';
  if v_declined is not null and v_declined > now() - interval '30 days' then
    v_retry := v_declined + interval '30 days';
  end if;

  return json_build_object(
    'ok', true,
    'hasCode', v_has_code,
    -- The single question the card asks. False for a partner, for a pending
    -- application, and during a cooldown — each of which the card explains
    -- differently, which is why the reason comes back too.
    'canApply', not v_has_code
                and coalesce(v_row.status, '') <> 'pending'
                and v_retry is null,
    'retryAfter', v_retry,
    'status', coalesce(v_row.status, ''),
    'displayName', coalesce(v_row.display_name, ''),
    'wantedCode', coalesce(v_row.wanted_code, ''),
    'audience', coalesce(v_row.audience, ''),
    'message', coalesce(v_row.message, ''),
    'declineReason', coalesce(v_row.decline_reason, ''),
    'code', coalesce(v_row.code, ''),
    'createdAt', v_row.created_at,
    'decidedAt', v_row.decided_at
  );
end;
$fn$;

revoke all on function public.my_referral_request() from public, anon;
grant execute on function public.my_referral_request() to authenticated;

-- ---------------------------------------------------------------------------
-- 10. admin_referral_requests — the inbox.
--
--     Pending first and oldest first within that, because the queue is worked
--     from the top and somebody who applied a week ago has been waiting a week.
--     Decided rows follow, newest first, as history.
--
--     This one DOES name people — an application is from a person and you
--     cannot judge it otherwise — which is the same exception admin_referral_list
--     already makes for a code's owner. It still says nothing about who used
--     anybody's code.
--
--     `emailStatus` is the outbox row for the approval mail, surfaced here on
--     purpose: an approval whose email never went out is the exact failure this
--     feature would otherwise hide.
-- ---------------------------------------------------------------------------
create or replace function public.admin_referral_requests()
returns json
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  result json;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;

  select json_build_object(
    'pending', (select count(*)::int from public.referral_requests where status = 'pending'),
    'rows', (
      -- Built key by key rather than with row_to_json, so the sort keys below
      -- stay out of the payload: an ordering trick is not part of the contract
      -- the panel reads.
      select coalesce(json_agg(
               json_build_object(
                 'id', r.id,
                 'status', r.status,
                 'createdAt', r."createdAt",
                 'displayName', r."displayName",
                 'wantedCode', r."wantedCode",
                 'audience', r.audience,
                 'message', r.message,
                 'declineReason', r."declineReason",
                 'code', r.code,
                 'decidedAt', r."decidedAt",
                 'email', r.email,
                 'driver', r.driver,
                 'isSubscriber', r."isSubscriber",
                 'emailStatus', r."emailStatus",
                 'emailError', r."emailError"
               ) order by r.grp, r.rank
             ), '[]'::json)
      from (
        select q.id,
               q.status,
               -- Pending first, and within it OLDEST first: the queue is worked
               -- from the top and someone who applied a week ago has been
               -- waiting a week. Everything decided sits below, newest first,
               -- as history — which is the opposite direction, so it is folded
               -- into one signed key rather than two order-by clauses.
               case when q.status = 'pending' then 0 else 1 end as grp,
               case when q.status = 'pending'
                    then  extract(epoch from q.created_at)
                    else -extract(epoch from q.created_at)
               end as rank,
               q.created_at                          as "createdAt",
               q.display_name                        as "displayName",
               q.wanted_code                         as "wantedCode",
               q.audience,
               q.message,
               q.decline_reason                      as "declineReason",
               q.code,
               to_char(q.decided_at, 'YYYY-MM-DD')   as "decidedAt",
               (select u.email from auth.users u where u.id = q.user_id)      as email,
               (select p.display_name from public.profiles p where p.id = q.user_id) as driver,
               -- Have they paid us anything? Someone promoting a product they
               -- subscribe to themselves is a different proposition from
               -- someone who has never started a trial, and it is the first
               -- thing you want to know when deciding.
               exists (
                 select 1 from public.billing_subscriptions b
                  where b.user_id = q.user_id
                    and public.billing_is_live(b.status, b.past_due_since)
               ) as "isSubscriber",
               (select o.status from public.email_outbox o
                 where o.dedupe_key = 'partner/approved:' || q.id::text) as "emailStatus",
               (select o.error from public.email_outbox o
                 where o.dedupe_key = 'partner/approved:' || q.id::text) as "emailError"
        from public.referral_requests q
      ) r
    )
  ) into result;

  return result;
end;
$fn$;

revoke all on function public.admin_referral_requests() from public, anon;
grant execute on function public.admin_referral_requests() to authenticated;

-- ---------------------------------------------------------------------------
-- 11. admin_approve_referral_request — the click that does everything.
--
--     Issues the code, links it to the applicant's account, marks the request
--     approved and queues the mail. One function because these four are one
--     decision, and any subset of them is a broken state somebody has to
--     notice: a code with no owner is invisible to the partner, an approved
--     request with no code is a lie, and a code with no email is a partnership
--     the partner does not know they have.
--
--     The code itself is minted by admin_issue_referral_code rather than
--     inserted here, so the format rules, the "already exists" check and the
--     league-code collision check have exactly one implementation.
-- ---------------------------------------------------------------------------
create or replace function public.admin_approve_referral_request(
  p_id   bigint,
  p_code text default '',
  p_note text default ''
) returns json
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_row    public.referral_requests%rowtype;
  v_code   text;
  v_issued json;
  v_url    text;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;

  select * into v_row from public.referral_requests where id = p_id;
  if not found then
    return json_build_object('ok', false, 'error', 'No such request.');
  end if;
  if v_row.status <> 'pending' then
    return json_build_object('ok', false,
      'error', 'That application was already ' || v_row.status || '.');
  end if;

  -- The admin's code wins; the applicant's suggestion is the fallback. Neither
  -- is trusted — admin_issue_referral_code validates whatever arrives.
  v_code := left(public.referral_normalise(nullif(btrim(coalesce(p_code, '')), '')), 24);
  if coalesce(v_code, '') = '' then
    v_code := v_row.wanted_code;
  end if;
  if coalesce(v_code, '') = '' then
    return json_build_object('ok', false,
      'error', 'They did not suggest a code — type one to approve this.');
  end if;

  -- One account, one active code. admin_issue_referral_code only enforces this
  -- on the resolve-by-email path, and this path passes the id directly, so the
  -- check belongs here too rather than being assumed.
  if exists (
    select 1 from public.referral_codes
     where owner_user_id = v_row.user_id and active and revoked_at is null
  ) then
    return json_build_object('ok', false,
      'error', 'That driver already owns an active code. Turn it off or unlink it first.');
  end if;

  v_issued := public.admin_issue_referral_code(
    p_code          => v_code,
    p_owner_name    => v_row.display_name,
    p_owner_user_id => v_row.user_id,
    p_note          => left(coalesce(nullif(btrim(coalesce(p_note, '')), ''),
                                     'Approved from an in-app application'), 200),
    p_owner_email   => ''
  );

  -- A refused code (taken, malformed, clashes with a league code) leaves the
  -- request PENDING and says why. Approving and then failing to produce a code
  -- would be the worst of both.
  if not coalesce((v_issued ->> 'ok')::boolean, false) then
    return json_build_object('ok', false, 'error', coalesce(v_issued ->> 'error', 'Could not issue that code.'));
  end if;

  update public.referral_requests
     set status      = 'approved',
         code        = v_code,
         decided_at  = now(),
         decided_by  = auth.uid()
   where id = p_id;

  v_url := public.referral_url(v_code);

  perform public.email_outbox_enqueue(
    v_row.user_id,
    'partner/approved',
    jsonb_build_object(
      'first_name', split_part(coalesce(v_row.display_name, ''), ' ', 1),
      'code', v_code,
      'url', v_url,
      'overlay_url', public.referral_overlay_url(v_code),
      'percent_off', 10
    ),
    'partner/approved:' || p_id::text
  );

  -- Best effort, always. See email_outbox_poke.
  perform public.email_outbox_poke();

  return json_build_object(
    'ok', true,
    'code', v_code,
    'url', v_url,
    'overlayUrl', public.referral_overlay_url(v_code),
    'email', (select u.email from auth.users u where u.id = v_row.user_id)
  );
end;
$fn$;

revoke all on function public.admin_approve_referral_request(bigint, text, text) from public, anon;
grant execute on function public.admin_approve_referral_request(bigint, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. admin_decline_referral_request — the other answer.
--
--     No email. A rejection email is a worse experience than finding out
--     quietly in the app the next time you look, and it is the kind of mail
--     that gets replied to angrily rather than read. The reason IS shown to
--     them in Settings, verbatim, so this is not silence — it is just not a
--     notification.
--
--     Starts the 30-day cooldown from `decided_at`.
-- ---------------------------------------------------------------------------
create or replace function public.admin_decline_referral_request(
  p_id     bigint,
  p_reason text default ''
) returns json
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_row public.referral_requests%rowtype;
begin
  if not public.is_admin() then
    raise exception 'not_admin';
  end if;

  select * into v_row from public.referral_requests where id = p_id;
  if not found then
    return json_build_object('ok', false, 'error', 'No such request.');
  end if;
  if v_row.status <> 'pending' then
    return json_build_object('ok', false,
      'error', 'That application was already ' || v_row.status || '.');
  end if;

  update public.referral_requests
     set status         = 'declined',
         decline_reason = left(btrim(coalesce(p_reason, '')), 500),
         decided_at     = now(),
         decided_by     = auth.uid()
   where id = p_id;

  return json_build_object('ok', true);
end;
$fn$;

revoke all on function public.admin_decline_referral_request(bigint, text) from public, anon;
grant execute on function public.admin_decline_referral_request(bigint, text) to authenticated;
